/**
 * Coverage of a batch (main.ts `--require`). A deferred invoke answers
 * `{deferred: true}` at its own step and settles at the `await` step that
 * takes it: the settled answer is the channel's, attributed to the call that
 * made it. Triggers and await steps call no channel of their own.
 */
import type { Spec } from './channels.ts'
import type { Call } from './types.ts'

/** per channel: how many calls, how many distinct answers, whether any call had arguments */
export interface ChannelReport {
  calls: number
  answers: string[]
  withArgs: boolean
}
export interface GroupReport {
  batch: string
  channels: Record<string, ChannelReport>
  /** the event channels some call emitted, on the TypeScript side */
  events: string[]
  single: Record<string, string>
}

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

/**
 * Coverage of a required batch. Its channels count over its own groups; its
 * events over every group, as another batch's handler may send one (M's
 * `slides:open-font-settings` sends W's `home:open-settings`).
 */
export function coverage(batch: string, reports: GroupReport[], specs: Spec[]): string[] {
  const merged = new Map<string, ChannelReport>()
  const emitted = new Set<string>()
  const single = new Map<string, string>()
  for (const r of reports) {
    for (const e of r.events) emitted.add(e)
    if (r.batch !== batch) continue
    for (const [ch, c] of Object.entries(r.channels)) {
      const m = merged.get(ch) ?? { calls: 0, answers: [], withArgs: false }
      m.calls += c.calls
      m.withArgs ||= c.withArgs
      for (const a of c.answers) if (!m.answers.includes(a)) m.answers.push(a)
      merged.set(ch, m)
    }
    for (const [ch, why] of Object.entries(r.single)) single.set(ch, why)
  }
  const problems: string[] = []
  for (const spec of specs.filter((s) => s.batch === batch)) {
    const handled = spec.kinds.some((k) => k === 'invoke' || k === 'send' || k === 'sendSync')
    const c = merged.get(spec.name)
    if (handled && !c) problems.push(`${spec.name}: no case calls it`)
    else if (handled && c && c.withArgs && c.answers.length < 2 && !single.has(spec.name))
      problems.push(`${spec.name}: fewer than two distinct answers`)
    if (spec.kinds.includes('event') && !emitted.has(spec.name))
      problems.push(`${spec.name}: no case emits this event`)
  }
  return problems
}
