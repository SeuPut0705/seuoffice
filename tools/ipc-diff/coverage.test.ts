import { describe, expect, it } from 'vitest'
import { channelAnswers } from './coverage.ts'
import type { Call } from './types.ts'

const call = (channel: string, extra: Partial<Call> = {}): Call => ({
  channel,
  args: [1],
  ...extra,
})
const awaitOf = (index: number): Call => ({ channel: '', args: [], await: index })
const value = (v: unknown) => ({ value: v, buffers: [] })
const DEFERRED = { deferred: true }

/** distinct answers per channel, as the coverage counts them */
function distinct(calls: Call[], answers: unknown[]): Record<string, number> {
  const seen: Record<string, Set<string>> = {}
  for (const a of channelAnswers(calls, answers)) {
    seen[a.channel] ??= new Set()
    if (a.answer !== undefined) seen[a.channel].add(a.answer)
  }
  return Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.size]))
}

describe('coverage of deferred invokes', () => {
  it('counts two different settled answers of one channel as two', () => {
    const calls = [call('x', { defer: true }), call('x', { defer: true }), awaitOf(0), awaitOf(1)]
    const answers = [DEFERRED, DEFERRED, value('a'), value('b')]
    expect(distinct(calls, answers)).toEqual({ x: 2 })
  })

  it('counts the same answer, once immediate and once settled later, as one', () => {
    const calls = [call('x'), call('x', { defer: true }), awaitOf(1)]
    const answers = [value('a'), DEFERRED, value('a')]
    expect(distinct(calls, answers)).toEqual({ x: 1 })
  })

  it('gives a settled answer to the call that made it, not to the channel of the step before', () => {
    const calls = [call('x', { defer: true }), call('y'), awaitOf(0)]
    const answers = [DEFERRED, value('y-answer'), value('x-answer')]
    expect(channelAnswers(calls, answers)).toEqual([
      { channel: 'x', withArgs: true, answer: JSON.stringify(value('x-answer')) },
      { channel: 'y', withArgs: true, answer: JSON.stringify(value('y-answer')) },
    ])
  })

  it('leaves out triggers and a deferred call nobody awaited has no answer', () => {
    const calls = [call('x', { defer: true }), { channel: 't', args: [], kind: 'trigger' as const }]
    expect(channelAnswers(calls, [DEFERRED, value(1)])).toEqual([
      { channel: 'x', withArgs: true, answer: undefined },
    ])
  })
})
