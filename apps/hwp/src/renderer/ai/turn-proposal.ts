/**
 * An AI run's edits as a proposal the person accepts or rejects. The run edits the live
 * document, so its later tool calls see its own work. When it ends, the run is taken back
 * out through the editor's history (the redo stack keeps it), and the document is what it
 * was before the run until the person says yes. Accepting redoes exactly those steps, and
 * only while nothing else has changed the document since the revert.
 *
 * Nothing here knows about React or the chat: the panel keeps one `TurnProposal` per run
 * and calls the three functions below with the plugin's own undo, redo and foreign count.
 */
import type { AgentRedoResult, AgentUndoResult } from '../../../studio-plugin/agent-plugin.mjs'

/** The part of the plugin the proposal needs: the same calls the bridge makes. */
export interface ProposalBackend {
  foreignChanges(): Promise<number>
  undo(steps: number, expectedForeign: number): Promise<AgentUndoResult>
  redo(steps: number, expectedForeign: number): Promise<AgentRedoResult>
}

export type TurnProposal =
  /** nothing is held: no run, a run that changed nothing, or one the person has answered */
  | { kind: 'none' }
  /** the run is out of the document, waiting for a yes or a no */
  | {
      kind: 'pending'
      /** the undo steps of the run, which a yes redoes */
      steps: number
      /** the editor's foreign-change count right after the revert; a yes needs it unchanged */
      foreign: number
    }
  /** the document changed after the revert, so the run can no longer be put back as it was */
  | { kind: 'stale'; steps: number }

export const NO_PROPOSAL: TurnProposal = { kind: 'none' }

export type AcceptOutcome =
  /** the run is in the document again; `foreign` is the count a later undo of it must give */
  { kind: 'applied'; foreign: number } | { kind: 'stale'; proposal: TurnProposal }

/**
 * Take the run that just ended out of the document. `pending` when it went; `none` when it
 * could not (someone changed the document during the run, or the editor refused part of the
 * undo), in which case the run stays in the document as an applied run.
 */
export async function holdRun(
  backend: ProposalBackend,
  steps: number,
  foreignAtStart: number,
): Promise<TurnProposal> {
  let undone: AgentUndoResult
  try {
    undone = await backend.undo(steps, foreignAtStart)
  } catch {
    return NO_PROPOSAL
  }
  if (undone.ok) {
    // the undo is the plugin's own, so the count is unchanged; read again rather than assume
    const foreign = await backend.foreignChanges().catch(() => foreignAtStart)
    return { kind: 'pending', steps, foreign }
  }
  // part of the run is out: put that part back so the document is not left between the two
  if (undone.undone > 0) await backend.redo(undone.undone, foreignAtStart).catch(() => undefined)
  return NO_PROPOSAL
}

/**
 * Put the held run back into the document. Refused (the proposal goes stale and the
 * document is left as it is) when the document changed since the revert.
 */
export async function accept(
  backend: ProposalBackend,
  proposal: Extract<TurnProposal, { kind: 'pending' }>,
): Promise<AcceptOutcome> {
  let redone: AgentRedoResult
  try {
    redone = await backend.redo(proposal.steps, proposal.foreign)
  } catch {
    return { kind: 'stale', proposal: { kind: 'stale', steps: proposal.steps } }
  }
  if (redone.ok) {
    const foreign = await backend.foreignChanges().catch(() => -1)
    return { kind: 'applied', foreign }
  }
  // the editor had fewer steps to put back than the run made: take back what came in
  if (redone.redone > 0) await backend.undo(redone.redone, proposal.foreign).catch(() => undefined)
  return { kind: 'stale', proposal: { kind: 'stale', steps: proposal.steps } }
}

/** Drop the proposal: the document stays as the revert left it. */
export function reject(): TurnProposal {
  return NO_PROPOSAL
}
