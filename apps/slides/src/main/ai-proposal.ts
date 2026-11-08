/**
 * AI edit review (seuoffice): an AI request edits the live deck as before, but when it
 * ends the edits are taken back out with the snapshot history and held as a proposal
 * the person accepts or rejects. Nothing here keeps a second document model: the
 * proposal is two ordinary history snapshots (the pre-run deck and the run's result).
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
  before: HistorySnapshot
  /** Copies of both stacks: the run's edits may trim or replace the live arrays. */
  undo: HistorySnapshot[]
  redo: HistorySnapshot[]
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

/**
 * Record the deck before an AI request's first edit (replaces any earlier record). A proposal
 * still held from an earlier request is dropped: the panel only starts a request after the
 * person settled it, so one left here belongs to a panel that is gone.
 */
export function beginAiRun(session: Session): void {
  session.aiProposal = undefined
  session.aiRun = {
    before: takeSnapshot(session),
    undo: session.undoStack.slice(),
    redo: session.redoStack.slice(),
    knownSnapshots: new Set(session.aiSnapshots?.keys()),
  }
}

/**
 * End of an AI request: when it changed the deck, put the deck back to its pre-run
 * state (undo and redo stacks too) and keep the run's result as the session's pending
 * proposal. Returns false when there was nothing to hold; the deck is untouched then.
 * Call after the run's history batches are closed.
 */
export function holdAiRun(session: Session): boolean {
  const run = session.aiRun
  session.aiRun = undefined
  if (!run || session.historyBatch || session.masterEdit) return false
  if (sameStack(session.undoStack, run.undo)) return false
  const after = takeSnapshot(session)
  session.undoStack.splice(0, session.undoStack.length, ...run.undo)
  session.redoStack = run.redo
  restoreSnapshot(session, run.before)
  for (const id of [...(session.aiSnapshots?.keys() ?? [])]) {
    if (!run.knownSnapshots.has(id)) session.aiSnapshots?.delete(id)
  }
  session.aiProposal = { before: run.before, after, marker: markerOf(session) }
  scheduleHistoryNotify(session)
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
  if (!proposal || session.historyBatch || session.masterEdit) return null
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

  ipcMain.handle('slides:ai-run-begin', (e) => {
    const session = sessionOf(e)
    if (!session) return false
    beginAiRun(session)
    return true
  })

  ipcMain.handle('slides:ai-run-hold', (e): RenderSlide[] | null => {
    const session = sessionOf(e)
    return session && holdAiRun(session) ? deckOf(session) : null
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
