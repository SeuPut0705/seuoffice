/**
 * The app's undo, staleness guard and guarded apply path, lent to the AI proposal
 * (turn-proposal.ts). Lives here, not in App.tsx, so the wiring the run's revert relies on
 * (the redo drop, the blank workbook's grid restore) is the code the tests run.
 */
import type { IWorkbookData } from '@univerjs/core'

import type { InMemoryWorkbookAdapter } from '@genoffice/xlsx-gateway/domain/in-memory-workbook'
import type { ChangePlan, CommitReceipt } from '@genoffice/xlsx-gateway/domain/workbook.types'

import { t } from '../i18n/locale'
import { planStillMatches } from '../lazy-plan'
import { AI_UNDO_CELL_BUDGET, type LazyWorkbookState, type UniverRuntime } from '../univer-state'
import { dropRedoStack, undoMark, undoStepsSince, UNIVER_UNDO_CAPACITY } from '../undo-carry'
import {
  lazyWorkbookCellReader,
  loadSnapshotIntoUniver,
  loadWorkbookDataIntoUniver,
} from '../univer-sync'
import { beginAgentWrite } from './run-lock'
import { rebasePlan, type AppliedOutcome, type ProposalBackend } from './turn-proposal'

/**
 * Operations whose apply only writes the edit journal: no Univer command runs, so
 * no undo step takes them back. An AI run cannot hold them for review.
 */
export const JOURNAL_ONLY_OPS: ReadonlySet<string> = new Set([
  'protect_sheet',
  'set_page_setup',
  'add_sparkline',
  'delete_table',
])

/** The plan the lazy workbook's preview card holds; the apply path reads it. */
export interface LazyPreview {
  sessionId: string
  sheetId: string
  plan: ChangePlan
}

/**
 * The grid of a blank (in-memory) workbook as the person left it when a run started. The
 * adapter never sees what the person typed into the grid, so its own snapshot cannot rebuild it.
 */
export interface BlankBaseline {
  readonly data: IWorkbookData
}

export function captureBlankBaseline(runtime: UniverRuntime | null): BlankBaseline | null {
  const workbook = runtime?.univerAPI.getActiveWorkbook()
  return workbook ? { data: structuredClone(workbook.save()) } : null
}

/**
 * Rolls the blank workbook back by `count` adapter revisions and rebuilds the grid. With the
 * baseline of the run being reverted, the grid comes back exactly as the person left it;
 * without one (the person's own undo) it is rebuilt from the adapter's snapshot.
 */
export function undoBlankWorkbook(
  runtime: UniverRuntime | null,
  adapter: InMemoryWorkbookAdapter,
  count: number,
  baseline: BlankBaseline | null,
): CommitReceipt {
  let receipt = adapter.undo()
  for (let step = 1; step < count; step += 1) receipt = adapter.undo()
  // Rebuild instead of patching: undo can remove cells and reverse
  // structural changes, neither of which syncUniver can express.
  if (baseline) loadWorkbookDataIntoUniver(runtime, structuredClone(baseline.data))
  else loadSnapshotIntoUniver(runtime, adapter.getSnapshot(), 'new-workbook', 'Untitled')
  return receipt
}

export interface ProposalBackendDeps {
  lazyWorkbookRef: { current: LazyWorkbookState | null }
  univerRef: { current: UniverRuntime | null }
  adapterRef: { current: InMemoryWorkbookAdapter }
  lazyPreviewRef: { current: LazyPreview | null }
  /** set by the run that is being reverted, null outside a blank workbook */
  blankBaselineRef: { current: BlankBaseline | null }
  /** the app's guarded apply path (records the plan on the run in flight) */
  autoApplySafePlan(plan: ChangePlan): Promise<AppliedOutcome>
  /** chrome that follows a blank workbook's rollback: revision, preview, visuals, notice */
  afterBlankUndo(receipt: CommitReceipt): void
}

export function createProposalBackend(deps: ProposalBackendDeps): ProposalBackend {
  const { lazyWorkbookRef, univerRef, adapterRef } = deps
  return {
    // the demo adapter keeps every revision; Univer keeps only its newest few undo items
    undoCapacity: lazyWorkbookRef.current ? UNIVER_UNDO_CAPACITY : Number.POSITIVE_INFINITY,
    undoCellBudget: lazyWorkbookRef.current ? AI_UNDO_CELL_BUDGET : Number.POSITIVE_INFINITY,
    unundoableOps: lazyWorkbookRef.current ? JOURNAL_ONLY_OPS : new Set<string>(),
    dropRedo: () => dropRedoStack(univerRef.current),
    checkpoint: () => (lazyWorkbookRef.current ? null : captureBlankBaseline(univerRef.current)),
    undo: async (steps, checkpoint) => {
      // the revert is a write of the run itself: the person's veto lets it through
      const endAgentWrite = beginAgentWrite()
      try {
        if (!lazyWorkbookRef.current) {
          deps.afterBlankUndo(
            undoBlankWorkbook(
              univerRef.current,
              adapterRef.current,
              steps,
              (checkpoint as BlankBaseline | null | undefined) ?? deps.blankBaselineRef.current,
            ),
          )
          return
        }
        const api = univerRef.current?.univerAPI
        if (!api) throw new Error(t('appUndoFailed'))
        for (let step = 0; step < steps; step += 1) await api.undo()
      } finally {
        endAgentWrite()
      }
    },
    watch: (plans) => {
      const state = lazyWorkbookRef.current
      const runtime = univerRef.current
      if (!state) {
        // the adapter's compare-and-swap revision is the demo workbook's guard
        const revision = adapterRef.current.getSnapshot().revision
        return () =>
          lazyWorkbookRef.current !== null || adapterRef.current.getSnapshot().revision !== revision
      }
      const mark = undoMark(runtime)
      return () => {
        if (lazyWorkbookRef.current !== state || univerRef.current !== runtime) return true
        // a person's edit lands on the undo stack; the first plan must still find its "before" cells
        if (undoStepsSince(runtime, mark) > 0) return true
        try {
          const workbook = runtime?.univerAPI.getActiveWorkbook()
          return !workbook || !planStillMatches(plans[0]!, lazyWorkbookCellReader(workbook))
        } catch {
          return true
        }
      }
    },
    apply: (plan) => {
      const state = lazyWorkbookRef.current
      if (!state) {
        return deps.autoApplySafePlan(rebasePlan(plan, adapterRef.current.getSnapshot().revision))
      }
      const sheetId = univerRef.current?.univerAPI
        .getActiveWorkbook()
        ?.getActiveSheet()
        ?.getSheetId()
      if (!sheetId) {
        return Promise.resolve({ ok: false, reason: t('appApplyTxFailed'), undoSteps: 0 })
      }
      deps.lazyPreviewRef.current = { sessionId: state.file.sessionId, sheetId, plan }
      return deps.autoApplySafePlan(plan)
    },
  }
}
