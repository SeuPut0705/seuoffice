/**
 * Who owns the workbook while AI runs come and go.
 *
 * A run takes the workbook (run-lock.ts), edits it, and at its end is taken back out and held as
 * a proposal. "New chat" abandons a run midway; its revert is still in flight when the person
 * sends again. Each run therefore carries its own claim on the lock, and a new run starts only
 * after every earlier revert has finished: the new run's writes must not land on the stack the
 * revert is still undoing.
 */
import { aiRunLock } from '../univer-state'
import { lockForAiRun, unlockAfterAiRun, type AiRunLockHold } from './run-lock'
import { RunRecord, type TurnProposal } from './turn-proposal'

/** One AI run: the plans it applied and the claim it holds on the workbook. */
export class AiRun {
  readonly record = new RunRecord()
  hold: AiRunLockHold | null = null
}

export class AiRunSession {
  private current: AiRun | null = null
  private reverting: Promise<void> = Promise.resolve()

  /** `revert` takes a run's edits back out of the workbook and holds them as a proposal. */
  constructor(private readonly revert: (record: RunRecord) => Promise<TurnProposal>) {}

  /** The run in flight (or still starting), or null. */
  get run(): AiRun | null {
    return this.current
  }

  /** A send: this run is the current one until it finishes or a new chat abandons it. */
  begin(): AiRun {
    this.current = new AiRun()
    return this.current
  }

  /**
   * Takes the workbook for `run` once every earlier revert is done. False when a new chat
   * abandoned the run meanwhile: whoever abandoned it reverts it, and it must not run.
   * The check and the lock happen in the same turn.
   */
  async acquire(run: AiRun): Promise<boolean> {
    let waited: Promise<void>
    do {
      waited = this.reverting
      await waited
    } while (waited !== this.reverting)
    if (this.current !== run) return false
    run.hold = lockForAiRun()
    return true
  }

  /**
   * Takes the current run's edits back out and hands the workbook back: at the run's end, or
   * from "new chat" when the run never reaches it. Null when a new chat already took the run.
   */
  end(): Promise<TurnProposal> | null {
    const run = this.current
    this.current = null
    return run ? this.revertRun(run) : null
  }

  private revertRun(run: AiRun): Promise<TurnProposal> {
    const reverted = this.reverting.then(async () => {
      try {
        return await this.revert(run.record)
      } catch (error: unknown) {
        // the edits no one accepted may still be in the workbook: saves stay refused
        aiRunLock.stranded = true
        throw error
      } finally {
        if (run.hold) unlockAfterAiRun(run.hold)
      }
    })
    this.reverting = reverted.then(
      () => undefined,
      () => undefined,
    )
    return reverted
  }
}
