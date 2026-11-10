// The editing half of the desktop's `slides:*` handlers (main/slides-main.ts) for a page in edit
// mode: the same transactions, history snapshots and autofit write-back, run against the deck the
// page opened. A save packs the deck with the engine's writer and hands the bytes to the host.
// Only the members listed here edit on the web; the rest of the editing family stays unsupported.
// AI runs are held for review as on the desktop (decision 0012): main/ai-proposal.ts begins,
// holds, accepts and rejects them against this deck; this file keeps the page's revisions in step.
import { commitSaved, savePptx } from '@genoffice/pptx-engine'
import { runTxn, type TxnRequest, type TxnResult } from '@genoffice/pptx-ops'
import { documentByPath, onHostSaveRequest, reportDirty, saveToHost } from '@seuoffice/web-platform'
import {
  AI_REVIEW_SAVE_REASON,
  acceptAiProposal,
  beginAiRun,
  holdAiRun,
  rejectAiProposal,
  settleWrites,
  trackWrite,
} from '../main/ai-proposal'
import { applyAutofitResize, syncAutofitScale } from '../main/autofit-writeback'
import {
  beginHistoryBatch,
  buildSlideUpdate,
  endHistoryBatch,
  markMetaDirty,
  pruneMediaSources,
  rebuildSlide,
  registerAiSnapshot,
  restoreAiSnapshot,
  restoreSnapshot,
  settleStaleHistoryBatch,
  takeSnapshot,
  type HistorySnapshot,
  type Session,
} from '../main/session-state'
import { applyTxnToSession } from '../main/session-txn'
import type { HistoryChange, SlidesApi } from '../shared/ipc'
import { currentSession, forPage, renderDeck } from './session'

/** session-state.ts MAX_HISTORY */
const MAX_HISTORY = 50

const historyListeners = new Set<(state: HistoryChange) => void>()

/**
 * Which history state the deck shows and which one the host last stored. A snapshot restore
 * brings back the dirty flags of the moment it was taken, which a save in between made stale:
 * undoing past a save restores flags that read clean, and only the revision tells the deck
 * no longer matches the host's copy.
 */
interface Revisions {
  shown: number
  saved: number
}
const revisions = new WeakMap<Session, Revisions>()
const snapshotRevisions = new WeakMap<HistorySnapshot, number>()
let lastRevision = 0

function revisionsOf(session: Session): Revisions {
  let found = revisions.get(session)
  if (!found) revisions.set(session, (found = { shown: 0, saved: 0 }))
  return found
}

/** takeSnapshot, remembering the revision the snapshot holds */
function snapshot(session: Session): HistorySnapshot {
  const snap = takeSnapshot(session)
  snapshotRevisions.set(snap, revisionsOf(session).shown)
  return snap
}

/** restoreSnapshot, and the deck shows the snapshot's revision again */
function restore(session: Session, snap: HistorySnapshot): void {
  restoreSnapshot(session, snap)
  revisionsOf(session).shown = snapshotRevisions.get(snap)!
}

/** A snapshot the desktop helpers took: it holds the deck at `revision` */
function remember(snap: HistorySnapshot | undefined, revision: number): void {
  if (snap && !snapshotRevisions.has(snap)) snapshotRevisions.set(snap, revision)
}

/** slides:is-dirty, and whether the deck is still the state the host stored */
function isDirty(session: Session): boolean {
  const { shown, saved } = revisionsOf(session)
  return (
    shown !== saved ||
    !!session.metaDirty ||
    session.opened.deck.slides.some(
      (s) => s.structureDirty || s.elements.some((el) => el.dirty || el.dirtyTransform),
    )
  )
}

/**
 * What the desktop's deferred history notify and the renderer's dirty probes tell the shell,
 * sent after every change: the undo/redo button states, and the host's unsaved-changes flag.
 */
function settle(session: Session): void {
  pruneMediaSources(session)
  const state: HistoryChange = {
    canUndo: session.undoStack.length > 0,
    canRedo: session.redoStack.length > 0,
    // an AI run's unaccepted edits are in the deck: the renderer keeps it read-only meanwhile
    aiRunActive: session.aiRun !== undefined,
  }
  for (const listener of historyListeners) listener(state)
  // a co-edited page's unsaved flag follows the session (web-platform collab-page.ts)
  if (!coEditSave) reportDirty(isDirty(session))
}

/** session-state.ts pushHistory, without the main-process notify it schedules */
function pushHistory(session: Session): void {
  session.undoStack.push(snapshot(session))
  while (session.undoStack.length > MAX_HISTORY) session.undoStack.shift()
  session.redoStack = []
  revisionsOf(session).shown = ++lastRevision
}

/**
 * slides-main.ts sessionTxn: one undo step around a transaction, planned first so an invalid
 * request leaves history alone. The page has no op journal or second window to tell.
 */
function sessionTxn(session: Session, req: TxnRequest): TxnResult | null {
  const plan = runTxn(session.opened, { ...req, dryRun: true })
  const invalid = plan.failures?.length ?? 0
  if ((req.isolation ?? 'atomic') === 'atomic' ? invalid > 0 : invalid >= req.ops.length)
    return null
  pushHistory(session)
  const r = runTxn(session.opened, req)
  if (!r.applied) {
    // the executor already rolled the deck back to the snapshot's state
    const snap = session.undoStack.pop()!
    revisionsOf(session).shown = snapshotRevisions.get(snap)!
    return null
  }
  return r
}

/** The page's one renderer, standing for the desktop window that owns a run */
const PAGE_WINDOW = 1

/**
 * ai-proposal.ts holdAiRun, keeping the revisions: the deck shows its pre-run revision again,
 * and the held result keeps the run's, so accepting it shows the run's state as unsaved.
 */
function holdRun(session: Session): boolean {
  const run = session.aiRun
  const runRevision = revisionsOf(session).shown
  if (!run || !holdAiRun(session, PAGE_WINDOW)) return false
  revisionsOf(session).shown = snapshotRevisions.get(run.before)!
  remember(session.aiProposal?.after, runRevision)
  return true
}

const slidePaths = (session: Session): string[] => session.opened.deck.slides.map((s) => s.path)

/** Run an edit against the open deck and report the settled state; null without a deck */
async function edit<T>(run: (session: Session) => T): Promise<T | null> {
  const session = currentSession()
  if (!session) return null
  try {
    return run(session)
  } finally {
    settle(session)
  }
}

let lastSaveError = ''

/** Set while the page co-edits: the session writes the file of one version from its log */
let coEditSave: (() => Promise<void>) | null = null

/**
 * Hand saves to a co-editing session. Every later save, the renderer's and the host's (which
 * still runs the renderer's flow, so an open text edit is committed first), stores the file
 * the session produces; the page stops reporting its own unsaved flag.
 */
export function coEditDeck(save: () => Promise<void>): void {
  coEditSave = save
  installHostSave()
}

/**
 * slides:save for a page whose host stores the document. AutoSave passes are sat out the way the
 * desktop sits out one for an untitled deck: the host decides when its copy changes.
 */
const saveDeck: SlidesApi['save'] = async (auto) => {
  if (auto === true) return { ok: false, reason: 'external-modified' }
  if (coEditSave) {
    lastSaveError = ''
    try {
      await coEditSave()
      // nothing was reopened: the renderer keeps its slides and their ids
      return { ok: true }
    } catch (error) {
      lastSaveError = error instanceof Error ? error.message : String(error)
      return { ok: false, error: lastSaveError }
    }
  }
  const session = currentSession()
  const doc = session && documentByPath(session.path)
  if (!session || !doc) return { ok: false, error: 'no file open' }
  lastSaveError = ''
  // slides-main.ts slides:save: an AI run's edits wait for review, so nothing is written
  if (session.aiRun) {
    lastSaveError = 'an AI request is editing this presentation; accept or reject it first'
    return { ok: false, reason: AI_REVIEW_SAVE_REASON }
  }
  try {
    const metaRevAtSave = session.metaRev ?? 0
    const shownAtSave = revisionsOf(session).shown
    // counted as in flight until stored, so a run begins only after it (ai-proposal.ts)
    await trackWrite(session, async () => {
      await saveToHost(doc.fileName, await savePptx(session.opened))
      commitSaved(session.opened)
    })
    if ((session.metaRev ?? 0) === metaRevAtSave) session.metaDirty = false
    revisionsOf(session).saved = shownAtSave
    return { ok: true, slides: renderDeck() ?? [] }
  } catch (error) {
    lastSaveError = error instanceof Error ? error.message : String(error)
    return { ok: false, error: lastSaveError }
  } finally {
    settle(session)
  }
}

let closeSaveHandler: (() => void) | undefined
/** Host save requests waiting for the renderer's save flow, in the order they were asked */
const hostSaves: Array<(ok: boolean) => void> = []

/**
 * A host save request runs the renderer's full save flow (commit the open text edit and notes,
 * then save), the one the desktop's close guard starts with `slides:close-save-request`.
 */
function requestRendererSave(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!closeSaveHandler) {
      reject(new Error('the presentation is not open yet'))
      return
    }
    hostSaves.push((ok) =>
      ok ? resolve() : reject(new Error(lastSaveError || 'the presentation was not saved')),
    )
    closeSaveHandler()
  })
}

export function installHostSave(): void {
  onHostSaveRequest(requestRendererSave)
}

export const deckEdits: Partial<SlidesApi> = {
  editText: (op) =>
    edit((session) => {
      const r = sessionTxn(session, {
        ops: [
          {
            op: 'setText',
            target: { slide: op.slideIndex, el: op.sourceId },
            paragraphs: op.paragraphs,
            ...(op.groupId ? { group: op.groupId } : {}),
          },
        ],
      })
      if (!r) return null
      const levelDirty = (r.records?.[0]?.after as { levelDirty?: boolean } | undefined)?.levelDirty
      if (op.groupId || levelDirty) return forPage(rebuildSlide(session, op.slideIndex))
      const rendered = applyAutofitResize(
        session,
        op.slideIndex,
        op.sourceId,
        rebuildSlide(session, op.slideIndex),
      )
      return forPage(syncAutofitScale(session, op.slideIndex, op.sourceId, rendered))
    }),
  addSlide: (op) =>
    edit((session) => {
      const before = slidePaths(session)
      const r = sessionTxn(session, {
        ops: [
          {
            op: 'duplicateSlide',
            target: { slide: op.sourceIndex },
            ...(op.clearText ? { clearText: true } : {}),
          },
        ],
      })
      if (!r) return null
      session.fitWidthPx = op.fitWidthPx
      markMetaDirty(session)
      return forPage({ ...buildSlideUpdate(session, before), index: op.sourceIndex + 1 })
    }),
  addBlankSlide: (op) =>
    edit((session) => {
      const before = slidePaths(session)
      const r = sessionTxn(session, {
        ops: [
          { op: 'addBlankSlide', target: { slide: op.sourceIndex } },
          ...(op.before
            ? [
                {
                  op: 'moveSlide' as const,
                  target: { slide: op.sourceIndex },
                  to: op.sourceIndex + 1,
                },
              ]
            : []),
        ],
      })
      if (!r) return null
      session.fitWidthPx = op.fitWidthPx
      markMetaDirty(session)
      return forPage({
        ...buildSlideUpdate(session, before),
        index: op.before ? op.sourceIndex : op.sourceIndex + 1,
      })
    }),
  deleteSlide: (slideIndex) =>
    edit((session) => {
      const before = slidePaths(session)
      const r = sessionTxn(session, { ops: [{ op: 'deleteSlide', target: { slide: slideIndex } }] })
      if (!r) return null
      markMetaDirty(session)
      return forPage(buildSlideUpdate(session, before))
    }),
  deleteSlides: (op) =>
    edit((session) => {
      const before = slidePaths(session)
      // highest index first: every op is validated against the pre-transaction deck
      const indexes = [...new Set(op.slideIndexes)].sort((a, b) => b - a)
      if (!indexes.length || indexes.length >= session.opened.deck.slides.length) return null
      const r = sessionTxn(session, {
        ops: indexes.map((i) => ({ op: 'deleteSlide' as const, target: { slide: i } })),
      })
      if (!r) return null
      markMetaDirty(session)
      return forPage(buildSlideUpdate(session, before))
    }),
  setNotes: async (op) =>
    (await edit((session) => {
      const r = sessionTxn(session, {
        ops: [{ op: 'setNotes', target: { slide: op.slideIndex }, text: op.text }],
      })
      if (r) markMetaDirty(session)
      return r !== null
    })) ?? false,
  undo: () =>
    edit((session) => {
      // slides-main.ts slides:undo: an open run reverts from its own recorded history, and a
      // batch a request left open closes first so it never collapses the person's later steps
      if (session.aiRun) return null
      settleStaleHistoryBatch(session)
      const snap = session.undoStack.pop()
      if (!snap) return null
      session.redoStack.push(snapshot(session))
      restore(session, snap)
      return renderDeck()
    }),
  redo: () =>
    edit((session) => {
      if (session.aiRun) return null
      settleStaleHistoryBatch(session)
      const snap = session.redoStack.pop()
      if (!snap) return null
      session.undoStack.push(snapshot(session))
      restore(session, snap)
      return renderDeck()
    }),
  // slides:apply-txn, the AI's batch edit tool: the desktop's core with the page's history
  applyTxn: (req) =>
    edit((session) => {
      const r = applyTxnToSession(session, req, {
        push: pushHistory,
        drop: (s) => {
          const snap = s.undoStack.pop()!
          revisionsOf(s).shown = snapshotRevisions.get(snap)!
        },
        run: (s, txn) => runTxn(s.opened, txn),
      })
      return r?.slides ? { ...r, slides: forPage(r.slides) } : r
    }),
  // slides:history-batch-begin/-end: one AI request's edits collapse into one rollback point
  beginHistoryBatch: async () =>
    (await edit((session) => {
      beginHistoryBatch(session)
      remember(session.historyBatch?.before, revisionsOf(session).shown)
      return true
    })) ?? false,
  endHistoryBatch: () =>
    edit((session) => {
      const before = endHistoryBatch(session)
      return before ? registerAiSnapshot(session, before) : null
    }),
  // ai-proposal.ts registerAiProposalIpc, for the page's one window
  aiRunBegin: async () => {
    const session = currentSession()
    // ai-proposal.ts slides:ai-run-begin: saves that began first finish first, but a host
    // that never answers holds the run back only until the desktop's deadline
    if (!session || !(await settleWrites(session)) || currentSession() !== session) return false
    return (
      (await edit((s) => {
        // a run this page left open is reverted first, so it never becomes the next start
        if (s.aiRun) holdRun(s)
        if (!beginAiRun(s, PAGE_WINDOW)) return false
        remember(s.aiRun?.before, revisionsOf(s).shown)
        return true
      })) ?? false
    )
  },
  aiRunHold: () => edit((session) => (holdRun(session) ? renderDeck() : null)),
  aiProposalAccept: () =>
    edit((session) => {
      const shown = revisionsOf(session).shown
      const after = session.aiProposal?.after
      const snapshotId = acceptAiProposal(session)
      if (snapshotId === null || !after) return null
      // the pre-accept deck became an undo step; the deck now shows the run's result
      remember(session.undoStack.at(-1), shown)
      revisionsOf(session).shown = snapshotRevisions.get(after) ?? ++lastRevision
      return { slides: renderDeck() ?? [], snapshotId }
    }),
  aiProposalReject: async () => (await edit((session) => rejectAiProposal(session))) ?? false,
  aiSnapshotRestore: (id) =>
    edit((session) => {
      if (session.historyBatch || session.aiRun) return null
      const shown = revisionsOf(session).shown
      if (!restoreAiSnapshot(session, id)) return null
      remember(session.undoStack.at(-1), shown)
      revisionsOf(session).shown = ++lastRevision
      return renderDeck()
    }),
  isDirty: async () => {
    const session = currentSession()
    return session ? isDirty(session) : false
  },
  save: saveDeck,
  onHistoryChanged: (handler) => {
    historyListeners.add(handler)
    return () => historyListeners.delete(handler)
  },
  onCloseSaveRequest: (handler) => {
    closeSaveHandler = handler
    return () => {
      if (closeSaveHandler === handler) closeSaveHandler = undefined
    }
  },
  // The desktop's File > Save accelerator: the page has no application menu to own Ctrl/Cmd+S
  onMenuCommand: (handler) => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      handler('save')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  },
  reportCloseSaveResult: (ok) => hostSaves.shift()?.(ok),
}
