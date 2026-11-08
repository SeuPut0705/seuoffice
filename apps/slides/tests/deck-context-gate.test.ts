import { describe, expect, it, vi } from 'vitest'
import type { ContextWarning } from '@genoffice/agent-core'
import { createDeckContextGate } from '../src/renderer/ai/deck-context-gate'

/**
 * The deck generation calls skip the panel's transport, so this gate gives
 * them the same 80% context check: asked once per run (the loop's signal),
 * never again for a retry in that run, and a decline means no model call.
 */

type Settings = { limit?: number; known?: boolean }

/** ~1,000 ASCII tokens: over 80% of a 1,024 window, well under 8,192 */
const LARGE = 'x'.repeat(4_000)
const SMALL = 'hello'

function gate(confirm: (warning: ContextWarning) => boolean) {
  const ask = vi.fn(confirm)
  const g = createDeckContextGate<Settings>({
    contextLimit: (settings) =>
      settings.limit === undefined
        ? undefined
        : { limit: settings.limit, known: settings.known ?? true },
    confirm: ask,
  })
  return { g, ask }
}

const local: Settings = { limit: 1_024 }

describe('createDeckContextGate', () => {
  it('asks once per run and lets every later call of that run through', () => {
    const { g, ask } = gate(() => true)
    const run = new AbortController().signal
    // style, outline, a page and its repair round: one question
    expect(g.allows(local, 'sys', LARGE, run)).toBe(true)
    expect(g.allows(local, 'sys', LARGE, run)).toBe(true)
    expect(g.allows(local, 'other system', `${LARGE} page 2`, run)).toBe(true)
    expect(ask).toHaveBeenCalledTimes(1)
    const warning = ask.mock.calls[0]![0]
    expect(warning.contextTokens).toBe(1_024)
    expect(warning.known).toBe(true)
    expect(warning.ratio).toBeGreaterThanOrEqual(0.8)
  })

  it('refuses after a decline and does not ask again in that run', () => {
    const { g, ask } = gate(() => false)
    const run = new AbortController().signal
    expect(g.allows(local, 'sys', LARGE, run)).toBe(false)
    // the retry of the same call and the next page are refused silently
    expect(g.allows(local, 'sys', LARGE, run)).toBe(false)
    expect(g.allows(local, 'sys', SMALL, run)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('asks again in a new run', () => {
    const answers = [false, true]
    const { g, ask } = gate(() => answers.shift() ?? false)
    expect(g.allows(local, 'sys', LARGE, new AbortController().signal)).toBe(false)
    expect(g.allows(local, 'sys', LARGE, new AbortController().signal)).toBe(true)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('sends a small request without asking', () => {
    const { g, ask } = gate(() => false)
    expect(g.allows(local, 'sys', SMALL, new AbortController().signal)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('skips the check when the selection has no local window', () => {
    const { g, ask } = gate(() => false)
    expect(g.allows({}, 'sys', 'x'.repeat(400_000), new AbortController().signal)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
  })

  it('reports an assumed window as unknown', () => {
    const { g, ask } = gate(() => true)
    g.allows({ limit: 4_096, known: false }, 'sys', 'x'.repeat(16_000), undefined)
    expect(ask.mock.calls[0]![0].known).toBe(false)
  })

  it('treats a broken dialog as a decline', () => {
    const { g, ask } = gate(() => {
      throw new Error('no dialog')
    })
    const run = new AbortController().signal
    expect(g.allows(local, 'sys', LARGE, run)).toBe(false)
    expect(g.allows(local, 'sys', LARGE, run)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('asks for each call that has no run', () => {
    const { g, ask } = gate(() => true)
    expect(g.allows(local, 'sys', LARGE, undefined)).toBe(true)
    expect(g.allows(local, 'sys', LARGE, undefined)).toBe(true)
    expect(ask).toHaveBeenCalledTimes(2)
  })
})
