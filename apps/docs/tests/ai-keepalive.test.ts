import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_KEEPALIVE_INTERVAL_MS,
  startAiKeepalive,
  startFirstChunkKeepalive,
} from '../src/main/ai-keepalive'

/**
 * A local model can spend minutes loading before its first token. The renderer
 * treats silence as a dead stream, so the main process pings while it waits.
 * The timer must never outlive the request, whatever ended it.
 */

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startAiKeepalive', () => {
  it('pings every five seconds', () => {
    expect(AI_KEEPALIVE_INTERVAL_MS).toBe(5_000)
    const send = vi.fn()
    startAiKeepalive(send)

    vi.advanceTimersByTime(4_999)
    expect(send).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('stop clears the timer: no ping arrives afterwards', () => {
    const send = vi.fn()
    const stop = startAiKeepalive(send)

    vi.advanceTimersByTime(5_000)
    expect(send).toHaveBeenCalledTimes(1)

    stop()
    vi.advanceTimersByTime(60_000)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('stop is safe to call twice', () => {
    const send = vi.fn()
    const stop = startAiKeepalive(send)
    stop()
    expect(() => stop()).not.toThrow()
    vi.advanceTimersByTime(10_000)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('startFirstChunkKeepalive', () => {
  it('keeps pinging until the first chunk, not just until headers', () => {
    const send = vi.fn()
    const keepalive = startFirstChunkKeepalive(send)

    vi.advanceTimersByTime(5_000)
    expect(send).toHaveBeenCalledTimes(1)

    // headers arrived, but no answer chunk yet: keep pinging
    vi.advanceTimersByTime(5_000)
    expect(send).toHaveBeenCalledTimes(2)

    keepalive.firstChunk()
    vi.advanceTimersByTime(60_000)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('stop before the first chunk clears the timer', () => {
    const send = vi.fn()
    const keepalive = startFirstChunkKeepalive(send)

    keepalive.stop()
    vi.advanceTimersByTime(60_000)
    expect(send).not.toHaveBeenCalled()
  })

  it('firstChunk is safe to call twice', () => {
    const send = vi.fn()
    const keepalive = startFirstChunkKeepalive(send)
    keepalive.firstChunk()
    expect(() => keepalive.firstChunk()).not.toThrow()
    vi.advanceTimersByTime(10_000)
    expect(send).not.toHaveBeenCalled()
  })
})
