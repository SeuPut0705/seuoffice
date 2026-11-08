/**
 * An AI run becomes a proposal the person accepts or rejects.
 *
 * The run edits the live workbook as before, so its later tool calls see its
 * own edits. When the run ends, its edits are taken back out through the
 * app's own undo and the plans that produced them are held. Accept re-applies
 * those plans through the app's guarded apply path; Reject drops them.
 *
 * The workbook engine has no revision model, so the held proposal is the
 * recorded ChangePlans (cell diff, formats, renames, structural ops), not a
 * second copy of the document.
 */
import { parseRange, rangeCellCount } from '@genoffice/xlsx-gateway/domain/cell-address'
import {
  copyTargetBounds,
  type CopyRangeOperation,
} from '@genoffice/xlsx-gateway/domain/workbook-dsl'
import type { ApplyOutcome, ChangePlan } from '@genoffice/xlsx-gateway/domain/workbook.types'

/** An apply result that also says how many undo steps the apply left behind. */
export interface AppliedOutcome extends ApplyOutcome {
  readonly undoSteps: number
}

/** What the app lends the state machine: its undo, its staleness guard and its apply path. */
export interface ProposalBackend {
  /** How many undo steps the backend keeps; the run's plans must fit in it. */
  readonly undoCapacity: number
  /** The most cells one plan may touch and still be recorded in the backend's undo. */
  readonly undoCellBudget: number
  /** Operations whose apply no undo step takes back (they only write the edit journal). */
  readonly unundoableOps: ReadonlySet<string>
  /** Undoes the newest `steps` undo steps of the open workbook. */
  undo(steps: number): Promise<void>
  /**
   * Marks the workbook as it stands now. The returned check reports whether
   * the workbook has changed since (a person edited it, another file was
   * opened, the plans no longer match their "before" cells).
   */
  watch(plans: readonly ChangePlan[]): () => boolean
  /** Applies one plan through the app's guarded apply path. */
  apply(plan: ChangePlan): Promise<AppliedOutcome>
  /**
   * Empties the redo stack. Called only right after this module undid AI steps
   * onto it, so a person's Redo cannot bring them back unaccepted; the person's
   * own redo history is left alone otherwise.
   */
  dropRedo?(): void
}

export type TurnProposal =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'pending'
      /** in run order: a later plan was built on top of the earlier ones */
      readonly plans: readonly ChangePlan[]
      readonly changed: () => boolean
    }
  | { readonly kind: 'stale'; readonly plans: readonly ChangePlan[] }

export const NO_PROPOSAL: TurnProposal = { kind: 'none' }

/** What one run left in the workbook, as seen when it ended. */
export interface RunSummary {
  /** plans that applied in full, in order */
  readonly plans: readonly ChangePlan[]
  /** undo steps of everything the run committed, including the part of a batch that failed midway */
  readonly undoSteps: number
}

interface RecordedPlan {
  readonly plan: ChangePlan
  outcome: AppliedOutcome | undefined
}

/** Collects every plan a run applies; `settle` waits for applies still in flight. */
export class RunRecord {
  private readonly entries: RecordedPlan[] = []
  private readonly pending: Promise<void>[] = []

  track(plan: ChangePlan, applying: Promise<AppliedOutcome>): void {
    const entry: RecordedPlan = { plan, outcome: undefined }
    this.entries.push(entry)
    this.pending.push(
      applying.then(
        (outcome) => {
          entry.outcome = outcome
        },
        () => {
          entry.outcome = { ok: false, undoSteps: 0 }
        },
      ),
    )
  }

  /**
   * Why the run cannot take this plan and still be taken back out, or null.
   * Asked before the plan applies: a plan the undo would not record, or one
   * past the steps the undo keeps, would leave edits no revert can reach.
   */
  refusal(plan: ChangePlan, backend: ProposalBackend): string | null {
    const noUndo = plan.structuralChanges.find(({ op }) => backend.unundoableOps.has(op.op))
    if (noUndo) {
      return (
        `The ${noUndo.op.op} operation is not recorded in the undo history, and every change of this run must stay undoable until the user accepts it. ` +
        'Nothing was applied: leave that change out and tell the user to make it themselves.'
      )
    }
    const cells = planUndoCells(plan)
    if (cells > backend.undoCellBudget) {
      return (
        `This change touches about ${cells} cells, more than the ${backend.undoCellBudget} the undo history can hold, ` +
        'and every change of this run must stay undoable until the user accepts it. Nothing was applied: ' +
        'make smaller changes (split the range across several batches).'
      )
    }
    // an apply still in flight may add a step; a settled one left exactly the steps it reports
    const used = this.entries.reduce((steps, entry) => steps + (entry.outcome?.undoSteps ?? 1), 0)
    if (used + 1 > backend.undoCapacity) {
      return (
        `This run already used ${used} of the ${backend.undoCapacity} undo steps it may use, and every change of this run must stay undoable until the user accepts it. ` +
        'Nothing was applied: finish with what has been done, or combine the remaining changes into fewer batches next time.'
      )
    }
    return null
  }

  async settle(): Promise<RunSummary> {
    await Promise.all(this.pending)
    const plans: ChangePlan[] = []
    let undoSteps = 0
    for (const { plan, outcome } of this.entries) {
      if (!outcome) continue
      undoSteps += outcome.undoSteps
      if (outcome.ok) plans.push(plan)
    }
    return { plans, undoSteps }
  }
}

/** Range-level operations whose undo item stores the cells they write (the rest keep a small mutation). */
const CELL_PAYLOAD_RANGE_OPS: ReadonlySet<string> = new Set([
  'clear_range',
  'convert_to_values',
  'find_replace',
  'sort_range',
])

/**
 * Cells the undo history would store for a plan: the target area of every cell,
 * format and cell-writing range change. Row and column inserts and deletes and
 * the ops that write no cell (merge, filter, validation) are not counted; the
 * undo gate never drops an entry during a run (univer-state.ts).
 */
export function planUndoCells(plan: ChangePlan): number {
  const area = (range: string): number => rangeCellCount(parseRange(range))
  let cells = 0
  for (const change of plan.cellChanges) cells += area(change.address)
  for (const change of plan.formatChanges) cells += area(change.range)
  for (const { op } of plan.structuralChanges) {
    const bulk = op as { op: string; range?: unknown; source?: unknown; target?: unknown }
    if (CELL_PAYLOAD_RANGE_OPS.has(bulk.op) && typeof bulk.range === 'string') {
      cells += area(bulk.range)
    } else if (bulk.op === 'fill_range' && typeof bulk.target === 'string') {
      cells += area(bulk.target)
    } else if (bulk.op === 'copy_range' || bulk.op === 'move_range') {
      cells += rangeCellCount(copyTargetBounds(op as CopyRangeOperation))
      if (bulk.op === 'move_range' && typeof bulk.source === 'string') cells += area(bulk.source)
    }
  }
  return cells
}

/**
 * Takes the run's edits back out and holds the plans as a proposal. A run that
 * changed nothing yields none. `RunRecord.refusal` keeps every plan inside the
 * backend's undo, so a run that still outgrows it broke that guard: it throws
 * rather than revert a part of the run and pass for a held proposal.
 */
export async function holdRun(backend: ProposalBackend, run: RunSummary): Promise<TurnProposal> {
  if (run.undoSteps > backend.undoCapacity) {
    throw new Error(
      `The run left ${run.undoSteps} undo steps; the undo keeps ${backend.undoCapacity}.`,
    )
  }
  if (run.undoSteps === 0) return NO_PROPOSAL
  await backend.undo(run.undoSteps)
  backend.dropRedo?.()
  if (run.plans.length === 0) return NO_PROPOSAL
  return { kind: 'pending', plans: run.plans, changed: backend.watch(run.plans) }
}

/**
 * Re-applies the held plans in order. A workbook that changed since the
 * revert, or a plan the apply guard refuses, leaves the workbook untouched
 * (plans applied before the refusal are rolled back) and marks the proposal stale.
 */
export async function accept(
  backend: ProposalBackend,
  proposal: Extract<TurnProposal, { kind: 'pending' }>,
): Promise<TurnProposal> {
  const stale: TurnProposal = { kind: 'stale', plans: proposal.plans }
  if (proposal.changed()) return stale
  let applied = 0
  for (const plan of proposal.plans) {
    const outcome = await backend.apply(plan)
    applied += outcome.undoSteps
    if (!outcome.ok) {
      if (applied > 0) {
        await backend.undo(applied)
        backend.dropRedo?.()
      }
      return stale
    }
  }
  return NO_PROPOSAL
}

/** Drops the proposal (also clears a stale one); the workbook stays as it is. */
export function reject(): TurnProposal {
  return NO_PROPOSAL
}

/**
 * The same plan, based on the demo workbook's current revision under a new
 * transaction id. The adapter's compare-and-swap refuses an old base revision,
 * and undo moves the revision forward instead of back.
 */
export function rebasePlan(plan: ChangePlan, revision: number): ChangePlan {
  return { ...plan, baseRevision: revision, transactionId: `${plan.transactionId}-accepted` }
}

/**
 * The plans as one diff for the change card: a cell (or sheet name) several
 * plans touched shows the first plan's "before" and the last plan's "after".
 */
export function proposalPreview(plans: readonly ChangePlan[]): ChangePlan {
  const cells = new Map<string, ChangePlan['cellChanges'][number]>()
  for (const plan of plans) {
    for (const change of plan.cellChanges) {
      const key = `${change.sheetId}!${change.address}`
      const first = cells.get(key)
      cells.set(key, first ? { ...change, before: first.before } : change)
    }
  }
  const renames = new Map<string, ChangePlan['sheetRenames'][number]>()
  for (const rename of plans.flatMap((plan) => plan.sheetRenames)) {
    const first = renames.get(rename.sheetId)
    renames.set(rename.sheetId, first ? { ...rename, before: first.before } : rename)
  }
  const last = plans.at(-1)
  return {
    transactionId: last?.transactionId ?? '',
    baseRevision: plans[0]?.baseRevision ?? 0,
    cellChanges: [...cells.values()],
    sheetRenames: [...renames.values()],
    structuralChanges: plans.flatMap((plan) => plan.structuralChanges),
    formatChanges: plans.flatMap((plan) => plan.formatChanges),
    warnings: [...new Set(plans.flatMap((plan) => plan.warnings))],
  }
}
