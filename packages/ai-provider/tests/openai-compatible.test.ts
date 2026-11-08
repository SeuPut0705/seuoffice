import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '@genoffice/agent-core'
import { chatOpenAiCompatible, streamOpenAiCompatible } from '../src/protocols/openai-compatible'
import type { AiProviderConfig } from '../src/types'
import { AiTimeoutError, createStreamWatchdog } from '../src/watchdog'

/**
 * The request-shaping options the local connection test adds. Existing callers
 * must keep the pre-existing body (temperature 0.3, the positional output cap),
 * so the defaults are asserted next to the new options.
 */

const BASE = 'http://127.0.0.1:1234/v1'
const CONFIG: AiProviderConfig = { apiKey: 'test-key', model: 'local-model' }

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(handler)
  vi.stubGlobal('fetch', mock)
  return mock
}

function sentBody(mock: ReturnType<typeof vi.fn>, index = 0): Record<string, unknown> {
  return JSON.parse(String((mock.mock.calls[index]![1] as RequestInit).body)) as Record<
    string,
    unknown
  >
}

function chatAnswer(content = 'pong'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function sseAnswer(content = 'pong'): Response {
  return new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\ndata: [DONE]\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

/** A response that only settles when the request watchdog aborts it. */
function hangingResponse(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('This operation was aborted', 'AbortError'))
      return
    }
    signal?.addEventListener(
      'abort',
      () => reject(new DOMException('This operation was aborted', 'AbortError')),
      { once: true },
    )
  })
}

function collector() {
  const deltas: string[] = []
  const toolCalls: AgentToolCall[] = []
  return {
    deltas,
    toolCalls,
    cb: {
      signal: new AbortController().signal,
      onDelta: (text: string) => deltas.push(text),
      onToolCall: (call: AgentToolCall) => toolCalls.push(call),
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('chatOpenAiCompatible options', () => {
  it('sends max_tokens and temperature when given', async () => {
    const mock = stubFetch(() => chatAnswer())

    const result = await chatOpenAiCompatible(
      createStreamWatchdog(),
      BASE,
      CONFIG,
      'system',
      'ping',
      { maxTokens: 16, temperature: 0 },
    )

    expect(result).toEqual({ ok: true, content: 'pong' })
    const body = sentBody(mock)
    expect(body.max_tokens).toBe(16)
    expect(body.temperature).toBe(0)
    expect(body.messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'ping' },
    ])
  })

  it('keeps the existing default body: no output cap and temperature 0.3', async () => {
    const mock = stubFetch(() => chatAnswer())

    await chatOpenAiCompatible(createStreamWatchdog(), BASE, CONFIG, 'system', 'ping')

    const body = sentBody(mock)
    expect(body).not.toHaveProperty('max_tokens')
    expect(body.temperature).toBe(0.3)
  })

  it('still omits temperature for fixed-sampling models', async () => {
    const mock = stubFetch(() => chatAnswer())

    await chatOpenAiCompatible(createStreamWatchdog(), BASE, CONFIG, 'system', 'ping', {
      omitTemperature: true,
      temperature: 0.9,
    })

    expect(sentBody(mock)).not.toHaveProperty('temperature')
  })

  it('aborts a stalled one-shot chat with AiTimeoutError at the given timeout', async () => {
    vi.useFakeTimers()
    stubFetch((_url, init) => hangingResponse((init as RequestInit).signal))

    // the caller's own watchdog is longer, so only the request's timeout can fire
    const request = expect(
      chatOpenAiCompatible(
        createStreamWatchdog(undefined, 600_000, 600_000),
        BASE,
        CONFIG,
        'system',
        'ping',
        { timeoutMs: 60_000 },
      ),
    ).rejects.toBeInstanceOf(AiTimeoutError)
    await vi.advanceTimersByTimeAsync(60_000)

    await request
  })
})

describe('streamOpenAiCompatible options', () => {
  it('sends the given max_tokens and temperature without changing the stream framing', async () => {
    const mock = stubFetch(() => sseAnswer())
    const { cb, deltas } = collector()

    await streamOpenAiCompatible(
      BASE,
      CONFIG,
      'system',
      [{ role: 'user', text: 'ping' }],
      [],
      64,
      cb,
      { maxTokens: 8, temperature: 0 },
    )

    expect(deltas.join('')).toBe('pong')
    const body = sentBody(mock)
    expect(body.max_tokens).toBe(8)
    expect(body.temperature).toBe(0)
    expect(body.stream).toBe(true)
  })

  it('keeps the existing default body: positional cap and temperature 0.3', async () => {
    const mock = stubFetch(() => sseAnswer())

    await streamOpenAiCompatible(
      BASE,
      CONFIG,
      'system',
      [{ role: 'user', text: 'ping' }],
      [],
      64,
      collector().cb,
    )

    const body = sentBody(mock)
    expect(body.max_tokens).toBe(64)
    expect(body.temperature).toBe(0.3)
  })

  it('aborts a stalled stream with AiTimeoutError at the given timeout', async () => {
    vi.useFakeTimers()
    stubFetch((_url, init) => hangingResponse((init as RequestInit).signal))

    const request = expect(
      streamOpenAiCompatible(
        BASE,
        CONFIG,
        'system',
        [{ role: 'user', text: 'ping' }],
        [],
        64,
        collector().cb,
        { timeoutMs: 60_000 },
      ),
    ).rejects.toBeInstanceOf(AiTimeoutError)
    await vi.advanceTimersByTimeAsync(60_000)

    await request
  })
})
