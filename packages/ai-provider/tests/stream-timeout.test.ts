import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { streamForProvider } from '../src/stream'
import { AI_CONNECT_TIMEOUT_MS, AiTimeoutError } from '../src/watchdog'

/**
 * A local server loads the model on the first request, so the settings screen
 * gives such an endpoint a longer first-response limit. `streamForProvider`'s
 * optional eighth argument carries that limit into the OpenAI-compatible
 * watchdog; callers that pass nothing keep the default connect timeout.
 *
 * A fetch that never answers models the case the watchdog exists for: the
 * server accepted the connection but the model is not producing anything yet.
 */

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function hangingFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      const signal = init.signal
      return new Promise((_, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'))
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }),
  )
}

function run(toolsTimeoutMs?: number): Promise<void> {
  return streamForProvider(
    'custom',
    { apiKey: '', model: 'qwen3:8b', baseUrl: 'http://127.0.0.1:11434/v1' },
    'system',
    [{ role: 'user', text: 'hi' }],
    [],
    100,
    { signal: new AbortController().signal, onDelta: () => undefined, onToolCall: () => undefined },
    toolsTimeoutMs === undefined ? undefined : { timeoutMs: toolsTimeoutMs },
  )
}

describe('streamForProvider timeout', () => {
  it('aborts a delayed response at the timeout it was given', async () => {
    hangingFetch()
    let settled: unknown
    const outcome = run(5_000).catch((error: unknown) => {
      settled = error
    })

    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    await outcome
    expect(settled).toBeInstanceOf(AiTimeoutError)
  })

  it('keeps the default connect timeout when no timeout is given', async () => {
    hangingFetch()
    let settled: unknown
    const outcome = run().catch((error: unknown) => {
      settled = error
    })

    await vi.advanceTimersByTimeAsync(AI_CONNECT_TIMEOUT_MS - 1)
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    await outcome
    expect(settled).toBeInstanceOf(AiTimeoutError)
  })
})
