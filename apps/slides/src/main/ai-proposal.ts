/**
 * AI edit review (seuoffice): an AI request edits the live deck as before, but when it
 * ends the edits are taken back out with the snapshot history and held as a proposal
 * the person accepts or rejects. Nothing here keeps a second document model: the
 * proposal is two ordinary history snapshots (the pre-run deck and the run's result).
 *
 * While a run is open (`session.aiRun`, from `beginAiRun` until `holdAiRun`) the deck
 * holds edits nobody accepted, so the open run fails closed: every save path refuses
 * (`assertNoAiRun`), the person's windows are read-only (the history notice carries
 * `aiRunActive`), and undo/redo are refused. A run that cannot be begun is refused
 * before it edits anything, so every applied run can be reverted.
 */
import { ipcMain } from 'electron'
import type { RenderSlide } from '@genoffice/pptx-render'
import {
  buildAllRenderSlides,
  pushHistory,
  registerAiSnapshot,
  restoreSnapshot,
  scheduleDeckBroadcast,
  scheduleHistoryNotify,
  sessions,
  takeSnapshot,
  type HistorySnapshot,
  type Session,
} from './session-state'

/** The deck as an AI request found it, recorded before its first edit. */
export interface AiRun {
  /** The window that began the run: only it may hold the run, another window's run is refused */
  owner: number
  before: HistorySnapshot
  /** Copies of both stacks: the run's edits may trim or replace the live arrays. */
  undo: HistorySnapshot[]
  redo: HistorySnapshot[]
  /** Journal and notes counters at the start: edits that left no undo step still count as a change. */
  opSeq: number
  metaRev: number
  /** AI rollback points that existed before the run; later ones describe held futures. */
  knownSnapshots: Set<number>
}

/**
 * What the session looked like right after the revert. Any edit the person makes
 * afterwards changes at least one of these, which is how Accept notices it.
 */
export interface HistoryMarker {
  undoTop: HistorySnapshot | undefined
  undoLen: number
  redoLen: number
  opSeq: number
  metaRev: number
}

export interface AiProposal {
  before: HistorySnapshot
  after: HistorySnapshot
  marker: HistoryMarker
}

export function markerOf(session: Session): HistoryMarker {
  return {
    undoTop: session.undoStack.at(-1),
    undoLen: session.undoStack.length,
    redoLen: session.redoStack.length,
    opSeq: session.opSeq ?? 0,
    metaRev: session.metaRev ?? 0,
  }
}

function sameMarker(a: HistoryMarker, b: HistoryMarker): boolean {
  return (
    a.undoTop === b.undoTop &&
    a.undoLen === b.undoLen &&
    a.redoLen === b.redoLen &&
    a.opSeq === b.opSeq &&
    a.metaRev === b.metaRev
  )
}

function sameStack(a: HistorySnapshot[], b: HistorySnapshot[]): boolean {
  return a.length === b.length && a.every((snap, i) => snap === b[i])
}

/** `reason` a save returns while an AI run's edits wait for review (nothing was written) */
export const AI_REVIEW_SAVE_REASON = 'ai-review'

/**
 * Backstop for every serializer of the deck: throws while a run is open, so no save,
 * recovery copy or export of the live deck can carry unaccepted AI edits.
 */
export function assertNoAiRun(session: Session): void {
  if (session.aiRun)
    throw new Error('An AI request is editing this deck; saving waits for your review')
}

/**
 * Run one serializing write of the live deck (a save, a recovery copy, template bytes) and
 * count it as in flight until it settles, commit steps included. Refuses while a run is
 * open (the check and the write's first step share one task), so a write never starts after
 * the run recorded its starting point.
 */
export async function trackWrite<T>(session: Session, write: () => Promise<T>): Promise<T> {
  assertNoAiRun(session)
  const running = write()
  const writes = (session.writesInFlight ??= new Set())
  const entry = running.then(
    () => undefined,
    () => undefined,
  )
  writes.add(entry)
  void entry.then(() => writes.delete(entry))
  return await running
}

/** How long a run's start waits for writes that began before it */
const WRITE_SETTLE_MS = 30_000

/**
 * Wait until no write is in flight. True when the session is quiet; false on timeout. The
 * check and the caller's next synchronous step share one task, so no write can start between.
 */
async function settleWrites(session: Session): Promise<boolean> {
  const deadline = Date.now() + WRITE_SETTLE_MS
  while (session.writesInFlight?.size) {
    const left = deadline - Date.now()
    if (left <= 0) return false
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, left)
    })
    await Promise.race([Promise.all([...session.writesInFlight]), timeout])
    clearTimeout(timer)
  }
  return true
}

/**
 * Record the deck before an AI request's first edit. Returns false, and the run must not
 * start, when it could not be reverted: another window's run is still open, or the deck
 * is in master view (its edits live in a separate model a snapshot cannot revert). A run
 * of this window that was never held (its panel is gone) is reverted first, so its edits
 * never become the next run's starting point. A proposal still held from an earlier
 * request is dropped: the panel only starts a request after the person settled it.
 */
export function beginAiRun(session: Session, owner: number): boolean {
  if (session.masterEdit) return false
  if (session.aiRun) {
    if (session.aiRun.owner !== owner) return false
    holdAiRun(session, owner)
  }
  session.aiProposal = undefined
  session.aiRun = {
    owner,
    before: takeSnapshot(session),
    undo: session.undoStack.slice(),
    redo: session.redoStack.slice(),
    opSeq: session.opSeq ?? 0,
    metaRev: session.metaRev ?? 0,
    knownSnapshots: new Set(session.aiSnapshots?.keys()),
  }
  scheduleHistoryNotify(session)
  return true
}

/**
 * End of an AI request: when it changed the deck, put the deck back to its pre-run
 * state (undo and redo stacks too) and keep the run's result as the session's pending
 * proposal. Returns false when there was nothing to hold; the deck is untouched then.
 * A history batch the run left open is dropped: the revert replaces both stacks, so the
 * batch has nothing left to collapse. Only the window that began the run can hold it.
 */
export function holdAiRun(session: Session, owner: number): boolean {
  const run = session.aiRun
  if (!run || run.owner !== owner) return false
  session.aiRun = undefined
  session.historyBatch = undefined
  scheduleHistoryNotify(session)
  const changed =
    !sameStack(session.undoStack, run.undo) ||
    (session.opSeq ?? 0) !== run.opSeq ||
    (session.metaRev ?? 0) !== run.metaRev
  if (!changed) return false
  const after = takeSnapshot(session)
  session.undoStack.splice(0, session.undoStack.length, ...run.undo)
  session.redoStack = run.redo
  restoreSnapshot(session, run.before)
  for (const id of [...(session.aiSnapshots?.keys() ?? [])]) {
    if (!run.knownSnapshots.has(id)) session.aiSnapshots?.delete(id)
  }
  session.aiProposal = { before: run.before, after, marker: markerOf(session) }
  scheduleDeckBroadcast(session)
  return true
}

/**
 * Apply the held proposal when nothing changed since the revert: the deck becomes the
 * run's result as one undo step, and the pre-run state becomes an AI rollback point
 * (the reply's existing "undo" control). Returns null, and leaves the deck and the
 * proposal alone, when the deck changed meanwhile or no proposal is held.
 */
export function acceptAiProposal(session: Session): number | null {
  const proposal = session.aiProposal
  if (!proposal || session.historyBatch || session.masterEdit || session.aiRun) return null
  if (!sameMarker(proposal.marker, markerOf(session))) return null
  session.aiProposal = undefined
  pushHistory(session)
  restoreSnapshot(session, proposal.after)
  scheduleDeckBroadcast(session)
  return registerAiSnapshot(session, proposal.before)
}

export function rejectAiProposal(session: Session): boolean {
  if (!session.aiProposal) return false
  session.aiProposal = undefined
  return true
}

export function registerAiProposalIpc(): void {
  const sessionOf = (e: { sender: { id: number } }) => sessions.get(e.sender.id)
  const deckOf = (session: Session): RenderSlide[] =>
    buildAllRenderSlides(session.opened, session.fitWidthPx)

  // A write that started before the run may still be serializing the live deck: the run
  // records its starting point only once those finished, so they never carry its edits.
  ipcMain.handle('slides:ai-run-begin', async (e) => {
    const session = sessionOf(e)
    if (!session || !(await settleWrites(session))) return false
    return beginAiRun(session, e.sender.id)
  })

  ipcMain.handle('slides:ai-run-hold', (e): RenderSlide[] | null => {
    const session = sessionOf(e)
    return session && holdAiRun(session, e.sender.id) ? deckOf(session) : null
  })

  ipcMain.handle(
    'slides:ai-proposal-accept',
    (e): { slides: RenderSlide[]; snapshotId: number } | null => {
      const session = sessionOf(e)
      const snapshotId = session ? acceptAiProposal(session) : null
      return session && snapshotId !== null ? { slides: deckOf(session), snapshotId } : null
    },
  )

  ipcMain.handle('slides:ai-proposal-reject', (e) => {
    const session = sessionOf(e)
    return session ? rejectAiProposal(session) : false
  })
}
