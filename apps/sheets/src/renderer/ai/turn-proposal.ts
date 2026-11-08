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
import type { ApplyOutcome, ChangePlan } from '@genoffice/xlsx-gateway/domain/workbook.types'

/** An apply result that also says how many undo steps the apply left behind. */
export interface AppliedOutcome extends ApplyOutcome {
  readonly undoSteps: number
}

/** What the app lends the state machine: its undo, its staleness guard and its apply path. */
export interface ProposalBackend {
  /** How many undo steps the backend keeps; a run with more cannot be taken back out in full. */
  readonly undoCapacity: number
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
  /** the run's edits stayed in the workbook: no undo can take them all back out */
  | { readonly kind: 'unheld' }

export const NO_PROPOSAL: TurnProposal = { kind: 'none' }
const UNHELD: TurnProposal = { kind: 'unheld' }

/** What one run left in the workbook, as seen when it ended. */
export interface RunSummary {
  /** plans that applied in full, in order */
  readonly plans: readonly ChangePlan[]
  /** undo steps of everything the run committed, including the part of a batch that failed midway */
  readonly undoSteps: number
  /** some edit landed that no undo step takes back (too large for the undo history) */
  readonly irreversible: boolean
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

  async settle(): Promise<RunSummary> {
    await Promise.all(this.pending)
    const plans: ChangePlan[] = []
    let undoSteps = 0
    let irreversible = false
    for (const { plan, outcome } of this.entries) {
      if (!outcome) continue
      undoSteps += outcome.undoSteps
      if (outcome.undoDropped) irreversible = true
      if (outcome.ok) plans.push(plan)
    }
    return { plans, undoSteps, irreversible }
  }
}

/**
 * Takes the run's edits back out and holds the plans as a proposal. A run that
 * changed nothing yields none. A run with an edit that never reached the undo
 * history, or with more undo steps than the backend keeps, is left applied and
 * reported as unheld: a partial revert would pass for a held proposal.
 */
export async function holdRun(backend: ProposalBackend, run: RunSummary): Promise<TurnProposal> {
  if (run.irreversible || run.undoSteps > backend.undoCapacity) return UNHELD
  if (run.undoSteps === 0) return NO_PROPOSAL
  await backend.undo(run.undoSteps)
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
      if (applied > 0) await backend.undo(applied)
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
