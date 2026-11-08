import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChunkCoalescer, type CoalescedChunk } from '../src/main/stream-coalesce'

/**
 * The AI stream's deltas are gathered for a short window before they cross to
 * the renderer. Nothing may be lost, merged across kinds, or reordered.
 */

type Chunk = CoalescedChunk & { stopReason?: string }

describe('stream chunk coalescer', () => {
  let sent: Chunk[]
  beforeEach(() => {
    vi.useFakeTimers()
    sent = []
  })
  afterEach(() => vi.useRealTimers())

  const coalescer = () => createChunkCoalescer<Chunk>((c) => sent.push(c), 32)

  it('sends a burst of deltas as one chunk after the window', () => {
    const out = coalescer()
    out.push({ requestId: 'r', type: 'delta', text: 'Hel' })
    out.push({ requestId: 'r', type: 'delta', text: 'lo, ' })
    out.push({ requestId: 'r', type: 'delta', text: 'world' })
    expect(sent).toEqual([])
    vi.advanceTimersByTime(32)
    expect(sent).toEqual([{ requestId: 'r', type: 'delta', text: 'Hello, world' }])
  })

  it('sends what is gathered before any other chunk, keeping the order', () => {
    const out = coalescer()
    out.push({ requestId: 'r', type: 'delta', text: 'a' })
    out.push({ requestId: 'r', type: 'delta', text: 'b' })
    out.push({ requestId: 'r', type: 'tool-call' })
    out.push({ requestId: 'r', type: 'delta', text: 'c' })
    out.push({ requestId: 'r', type: 'done', stopReason: 'end_turn' })
    expect(sent).toEqual([
      { requestId: 'r', type: 'delta', text: 'ab' },
      { requestId: 'r', type: 'tool-call' },
      { requestId: 'r', type: 'delta', text: 'c' },
      { requestId: 'r', type: 'done', stopReason: 'end_turn' },
    ])
    // nothing is left to fire later
    vi.advanceTimersByTime(100)
    expect(sent).toHaveLength(4)
  })

  it('never merges reasoning into text', () => {
    const out = coalescer()
    out.push({ requestId: 'r', type: 'reasoning', text: 'think ' })
    out.push({ requestId: 'r', type: 'reasoning', text: 'more' })
    out.push({ requestId: 'r', type: 'delta', text: 'answer' })
    out.flush()
    expect(sent).toEqual([
      { requestId: 'r', type: 'reasoning', text: 'think more' },
      { requestId: 'r', type: 'delta', text: 'answer' },
    ])
  })

  it('starts a new window after each send', () => {
    const out = coalescer()
    out.push({ requestId: 'r', type: 'delta', text: 'one' })
    vi.advanceTimersByTime(32)
    out.push({ requestId: 'r', type: 'delta', text: 'two' })
    vi.advanceTimersByTime(31)
    expect(sent).toEqual([{ requestId: 'r', type: 'delta', text: 'one' }])
    vi.advanceTimersByTime(1)
    expect(sent.map((c) => c.text)).toEqual(['one', 'two'])
  })

  it('flush sends what is gathered once and nothing twice', () => {
    const out = coalescer()
    out.push({ requestId: 'r', type: 'delta', text: 'tail' })
    out.flush()
    out.flush()
    vi.advanceTimersByTime(100)
    expect(sent).toEqual([{ requestId: 'r', type: 'delta', text: 'tail' }])
  })
})
