/**
 * Which answer of a case counts for which channel in the coverage of a batch
 * (main.ts `--require`). A deferred invoke answers `{deferred: true}` at its
 * own step and settles at the `await` step that takes it: the settled answer
 * is the channel's, attributed to the call that made it. Triggers and await
 * steps call no channel of their own.
 */
import type { Call } from './types.ts'

export interface ChannelAnswer {
  channel: string
  withArgs: boolean
  /** the settled answer as compared, or undefined for a deferred call nobody awaited */
  answer: string | undefined
}

/** One entry per channel call of the case, in call order; `answers[k]` is step k's answer */
export function channelAnswers(
  calls: readonly Call[],
  answers: readonly unknown[],
): ChannelAnswer[] {
  const awaitedAt = new Map<number, number>()
  calls.forEach((call, k) => {
    if (call.await !== undefined) awaitedAt.set(call.await, k)
  })
  const out: ChannelAnswer[] = []
  calls.forEach((call, k) => {
    if (call.kind === 'trigger' || call.await !== undefined) return
    const settledAt = call.defer ? awaitedAt.get(k) : k
    out.push({
      channel: call.channel,
      withArgs: call.args.length > 0,
      answer: settledAt === undefined ? undefined : JSON.stringify(answers[settledAt]),
    })
  })
  return out
}
