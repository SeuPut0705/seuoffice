/**
 * An AI run's edits as a proposal the person accepts or rejects. The run edits the live
 * document, so its later tool calls see its own work. When it ends, the run is taken back
 * out through the editor's history (the redo stack keeps it), and the document is what it
 * was before the run until the person says yes. Accepting redoes exactly those steps, and
 * only while nothing else has changed the document since the revert.
 *
 * Nothing here knows about React or the chat: the panel keeps one `TurnProposal` per run
 * and calls the three functions below with the plugin's own undo, redo and foreign count.
 * `RunHold` is the other half: the run on the live document keeps the person out of it and
 * the app's saves off it until the run has been taken back out.
 */
import type { AgentRedoResult, AgentUndoResult } from '../../../studio-plugin/agent-plugin.mjs'

/** The part of the plugin the proposal needs: the same calls the bridge makes. */
export interface ProposalBackend {
  foreignChanges(): Promise<number>
  undo(steps: number, expectedForeign: number): Promise<AgentUndoResult>
  redo(steps: number, expectedForeign: number): Promise<AgentRedoResult>
  /** the run waits on the editor's redo stack (`steps` of it, 0 when none): a person's redo is refused */
  setHeldRun(steps: number): Promise<unknown>
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
  /**
   * the run could not be taken out of the document: it is in there, the document is locked and
   * must not be saved, and nothing here undoes that short of closing the document
   */
  | { kind: 'stranded' }

export const NO_PROPOSAL: TurnProposal = { kind: 'none' }

const STRANDED: TurnProposal = { kind: 'stranded' }

export type AcceptOutcome =
  /** the run is in the document again; `foreign` is the count a later undo of it must give */
  { kind: 'applied'; foreign: number } | { kind: 'stale'; proposal: TurnProposal }

/**
 * Take the run that just ended out of the document. `pending` when it went. `stranded` when it
 * could not be taken out whole (the editor refused part of the undo, or the document's change
 * count moved): nothing is put back, because a run in the document is what must not be saved,
 * and the caller keeps the document locked and unsaved.
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
    return STRANDED
  }
  if (!undone.ok) return STRANDED
  // the run now waits on the editor's redo stack: the person's own redo must not bring it back
  await backend.setHeldRun(steps).catch(() => undefined)
  // the undo is the plugin's own, so the count is unchanged; read again rather than assume
  const foreign = await backend.foreignChanges().catch(() => foreignAtStart)
  return { kind: 'pending', steps, foreign }
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
    // the run is in the document, not on the redo stack any more
    await backend.setHeldRun(0).catch(() => undefined)
    const foreign = await backend.foreignChanges().catch(() => -1)
    return { kind: 'applied', foreign }
  }
  return { kind: 'stale', proposal: { kind: 'stale', steps: proposal.steps } }
}

/** Drop the proposal: the document stays as the revert left it. */
export function reject(): TurnProposal {
  return NO_PROPOSAL
}

/** What a run holding the document needs of the plugin: the proposal's calls and the lock. */
export interface RunBackend extends ProposalBackend {
  setRunLock(locked: boolean): Promise<{ ok: boolean }>
  strandRun(): Promise<unknown>
}

/** What the app is told of the document: a run is on it, nobody is, or a run is stuck in it. */
export type HoldState = 'held' | 'free' | 'stranded'

/** A run cannot start: an earlier one is stuck in this document (see `RunHold.strand`). */
export class StrandedError extends Error {
  constructor() {
    super('an AI edit could not be taken out of this document, which therefore cannot be saved')
    this.name = 'StrandedError'
  }
}

/** The send that asked for the lock was reset before the run started. */
export class RunEndedError extends Error {
  constructor() {
    super('the request was cancelled before it started')
    this.name = 'RunEndedError'
  }
}

/**
 * The document while an AI run is on it, from the send until the run is out of the document
 * again. The run edits the live document, so for that time:
 *   - the app writes nothing (`onHold('held')`: save, autosave, recovery copy, export read it),
 *   - the person cannot edit (the plugin's run lock), so the editor's history holds only the
 *     run on top of what was there, and what the person did before is not swept into a revert.
 * A run ends in `release()` (nothing changed, a failed start, the run taken back out by
 * `hold`, or dropped by `abandon`) or, when the editor cannot take it out, in `strand()`: the
 * run is in the document, so the app writes nothing and the person stays locked out for good.
 * Nothing leaves that phase; the plugin keeps it too, so a panel that is mounted again cannot
 * lift it. It ends with the document: a tab's editor holds one document for its whole life.
 */
export class RunHold {
  private phase: 'idle' | 'running' | 'holding' | 'abandoning' | 'stranded' = 'idle'
  /** the send that owns the hold now: a late release or lock of an older send is ignored */
  private generation = 0

  constructor(
    private readonly backend: () => RunBackend,
    private readonly onHold: (state: HoldState) => void,
  ) {}

  /** A dropped run's undo is still on its way: no new run may start before it is done. */
  get settling(): boolean {
    return this.phase === 'abandoning'
  }

  /** `generation` is still the send that owns the hold, and it has not ended. */
  isCurrent(generation: number): boolean {
    return generation === this.generation && this.phase === 'running'
  }

  /**
   * A run is on the document, from the first moment: nothing is awaited before this. Returns the
   * send's generation: `lock` and `release` of that send only act while it is the current one.
   */
  begin(): number {
    this.generation += 1
    if (this.phase !== 'stranded') this.phase = 'running'
    this.onHold('held')
    return this.generation
  }

  /**
   * Shut the person out and read the editor's foreign-change count, which the run's undo
   * checks. Throws when either cannot be done: a run that could not be taken back out is not
   * started, and the caller releases. Throws `StrandedError` while an earlier run is stuck,
   * and `RunEndedError` when this send was reset before the lock was in (the lock is lifted
   * again and the hold is left to whoever ended the send).
   */
  async lock(generation: number): Promise<number> {
    if (this.phase === 'stranded') throw new StrandedError()
    if (!this.isCurrent(generation)) throw new RunEndedError()
    const backend = this.backend()
    const locked = await backend.setRunLock(true)
    if (!locked.ok) {
      if (this.generation === generation) {
        this.phase = 'stranded'
        this.onHold('stranded')
      }
      throw new StrandedError()
    }
    if (!this.isCurrent(generation)) {
      // the send was reset while the lock was being taken: the lock is no longer wanted,
      // unless a newer send holds the document
      if (this.phase === 'idle') void backend.setRunLock(false).catch(() => undefined)
      throw new RunEndedError()
    }
    // the app writes nothing from here: said again, in case anything freed it meanwhile
    this.onHold('held')
    const foreign = await backend.foreignChanges()
    // a reset in the meantime has already given the document back
    if (!this.isCurrent(generation)) throw new RunEndedError()
    return foreign
  }

  /**
   * The run is out of the document, or never made a change: the person and the app have it back.
   * With a `generation`, only the send that owns the hold can free it.
   */
  release(generation?: number): void {
    if (generation !== undefined && generation !== this.generation) return
    if (this.phase === 'idle' || this.phase === 'stranded') return
    this.phase = 'idle'
    this.onHold('free')
    void this.backend()
      .setRunLock(false)
      .catch(() => undefined)
  }

  /** The run is stuck in the document: it stays locked and unsaved, and nothing lets go. */
  private strand(): void {
    this.phase = 'stranded'
    this.onHold('stranded')
    void this.backend()
      .strandRun()
      .catch(() => undefined)
  }

  /**
   * The run ended with `steps` changes: take them out as a proposal, then let the document go.
   * When they cannot be taken out whole the run is stranded and the proposal says so.
   */
  async hold(steps: number, foreign: number): Promise<TurnProposal> {
    this.phase = 'holding'
    const proposal = await holdRun(this.backend(), steps, foreign)
    if (proposal.kind === 'stranded') this.strand()
    else this.release()
    return proposal
  }

  /**
   * The conversation was reset while the run was in flight, which ends the loop without a word:
   * nobody will answer for its edits, so they are taken back out and dropped. Does nothing once
   * the run has ended and is being held. An undo the editor refuses strands the run. The send
   * ends here: a prepared send that has not reached the loop stops before it runs, and a new
   * run waits (`settling`) until this one's edits are out.
   */
  abandon(steps: number, foreign: number | null): void {
    if (this.phase !== 'running') return
    this.generation += 1
    if (steps === 0 || foreign === null) {
      this.release()
      return
    }
    this.phase = 'abandoning'
    void this.backend()
      .undo(steps, foreign)
      .then(
        async (undone) => {
          if (!undone.ok) return this.strand()
          // the dropped run waits on the redo stack as a rejected one does
          await this.backend()
            .setHeldRun(steps)
            .catch(() => undefined)
          this.release()
        },
        () => this.strand(),
      )
  }
}
