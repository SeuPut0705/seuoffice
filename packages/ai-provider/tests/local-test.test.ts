import { afterEach, describe, expect, it, vi } from 'vitest'
import { setRescueFetch } from '../src/fetch'
import { testLocalModel } from '../src/local-test'

/**
 * The four-step connection test of the local AI card. The fake server plays the
 * two wire shapes a real local server answers (`/api/tags` plus the
 * OpenAI-compatible `/chat/completions`). What matters here: every step gets a
 * structured answer and the function never throws, no document or user content
 * is sent, and a tool call is only observed — never executed.
 */

const BASE = 'http://127.0.0.1:11434/v1'
const MODEL = 'qwen3:8b'
const TAGS_URL = 'http://127.0.0.1:11434/api/tags'
const MODELS_URL = 'http://127.0.0.1:11434/v1/models'
const CHAT_URL = 'http://127.0.0.1:11434/v1/chat/completions'

function jsonBody(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function sseBody(lines: string[]): Response {
  return new Response(`${lines.join('\n')}\n`, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

function toolCallStream(name = 'ieumoffice_probe'): Response {
  const call = {
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'probe-1',
              function: { name, arguments: JSON.stringify({ ok: true }) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }
  const finish = { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  return sseBody([
    `data: ${JSON.stringify(call)}`,
    `data: ${JSON.stringify(finish)}`,
    'data: [DONE]',
  ])
}

function textChat(content = 'pong'): Response {
  return jsonBody({ choices: [{ message: { content }, finish_reason: 'stop' }] })
}

function stubFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(handler)
  vi.stubGlobal('fetch', mock)
  return mock
}

function requestedUrl(mock: ReturnType<typeof vi.fn>, index: number): string {
  return mock.mock.calls[index]![0] as string
}

function sentBody(mock: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  return JSON.parse(String((mock.mock.calls[index]![1] as RequestInit).body)) as Record<
    string,
    unknown
  >
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

function toolBodyOf(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  setRescueFetch(null)
})

describe('testLocalModel', () => {
  it('passes all four checks against a server that lists, chats and calls the probe tool', async () => {
    const mock = stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: MODEL }] })
      if (url === MODELS_URL) return new Response('not found', { status: 404 })
      if (url === CHAT_URL) {
        const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
        return toolBodyOf(body) ? toolCallStream() : textChat()
      }
      return new Response('not found', { status: 404 })
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL })

    expect(result.server).toEqual({ status: 'pass' })
    expect(result.model).toEqual({ status: 'pass' })
    expect(result.chat).toEqual({ status: 'pass' })
    expect(result.tools).toEqual({ status: 'pass' })
    expect(result.serverKind).toBe('ollama')
    expect(result.models).toEqual([{ id: MODEL }])
    expect(result.inputError).toBeUndefined()
    expect(typeof result.checkedAt).toBe('number')
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)

    // the Ollama list answered first, so `/models` was never probed
    expect(mock.mock.calls.map((call) => call[0])).toEqual([TAGS_URL, CHAT_URL, CHAT_URL])
  })

  it('sends only the fixed system prompt and `ping`, and gives the probe tool a fixed schema', async () => {
    const mock = stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: MODEL }] })
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return toolBodyOf(body) ? toolCallStream() : textChat()
    })

    await testLocalModel({ baseUrl: BASE, model: MODEL })

    const chat = sentBody(mock, 1)
    expect(chat.messages).toHaveLength(2)
    expect((chat.messages as Array<Record<string, unknown>>)[0]).toMatchObject({ role: 'system' })
    expect((chat.messages as Array<Record<string, unknown>>)[1]).toEqual({
      role: 'user',
      content: 'ping',
    })
    expect(chat.max_tokens).toBeGreaterThan(0)
    expect(chat.max_tokens).toBeLessThanOrEqual(1024)
    expect(chat.temperature).toBe(0)
    expect(chat.tools).toBeUndefined()

    const tools = sentBody(mock, 2)
    // the same fixed system prompt; no conversation, attachments or document text
    expect((tools.messages as Array<Record<string, unknown>>)[0]).toEqual(
      (chat.messages as Array<Record<string, unknown>>)[0],
    )
    expect(tools.messages).toHaveLength(2)
    expect(tools.stream).toBe(true)
    expect(tools.temperature).toBe(0)
    const probes = tools.tools as Array<{
      type: string
      function: { name: string; parameters: { required?: string[]; properties?: object } }
    }>
    expect(probes).toHaveLength(1)
    expect(probes[0]!.type).toBe('function')
    expect(probes[0]!.function.name).toBe('ieumoffice_probe')
    expect(probes[0]!.function.parameters.required).toEqual(['ok'])
    expect(probes[0]!.function.parameters.properties).toHaveProperty('ok')
  })

  it('passes the API key through to discovery, chat and the tool probe', async () => {
    const mock = stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: MODEL }] })
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return toolBodyOf(body) ? toolCallStream() : textChat()
    })

    await testLocalModel({ baseUrl: BASE, apiKey: 'secret-key', model: MODEL })

    for (const index of [0, 1, 2]) {
      const headers = new Headers((mock.mock.calls[index]![1] as RequestInit).headers)
      expect(headers.get('authorization')).toBe('Bearer secret-key')
    }
  })

  it('fails the model check with model-missing and keeps checking chat and tools', async () => {
    const mock = stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: 'other-model' }] })
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return toolBodyOf(body) ? toolCallStream() : textChat()
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL })

    expect(result.server).toEqual({ status: 'pass' })
    expect(result.model).toEqual({ status: 'fail', code: 'model-missing' })
    expect(result.chat).toEqual({ status: 'pass' })
    expect(result.tools).toEqual({ status: 'pass' })
    expect(mock).toHaveBeenCalledTimes(3)
  })

  it('skips the model check when the server returns an empty list', async () => {
    const mock = stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [] })
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return toolBodyOf(body) ? toolCallStream() : textChat()
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL })

    expect(result.server).toEqual({ status: 'pass' })
    expect(result.models).toEqual([])
    expect(result.model).toEqual({ status: 'skip' })
    expect(result.chat).toEqual({ status: 'pass' })
    expect(result.tools).toEqual({ status: 'pass' })
    expect(mock).toHaveBeenCalledTimes(3)
  })

  it('skips a typed model that the list does not name', async () => {
    stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: 'other-model' }] })
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return toolBodyOf(body) ? toolCallStream() : textChat()
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL, typed: true })

    expect(result.server).toEqual({ status: 'pass' })
    expect(result.model).toEqual({ status: 'skip' })
    expect(result.chat).toEqual({ status: 'pass' })
    expect(result.tools).toEqual({ status: 'pass' })
  })

  it('skips the model check when the model list cannot be read, and keeps checking chat and tools', async () => {
    stubFetch((url, init) => {
      if (url === TAGS_URL || url === MODELS_URL) return new Response('no', { status: 404 })
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return toolBodyOf(body) ? toolCallStream() : textChat()
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL })

    expect(result.server).toEqual({ status: 'fail', code: 'http' })
    expect(result.model).toEqual({ status: 'skip' })
    expect(result.chat).toEqual({ status: 'pass' })
    expect(result.tools).toEqual({ status: 'pass' })
    expect(result.models).toBeUndefined()
    expect(result.serverKind).toBeUndefined()
  })

  it('reports an unreachable server without throwing', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')))

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL })

    expect(result.server).toEqual({ status: 'fail', code: 'unreachable' })
    expect(result.model).toEqual({ status: 'skip' })
    expect(result.chat).toEqual({ status: 'fail', code: 'unreachable' })
    expect(result.tools).toEqual({ status: 'fail', code: 'unreachable' })
  })

  it('fails chat with no-chat on an empty answer, and still probes the tools', async () => {
    stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: MODEL }] })
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return toolBodyOf(body) ? toolCallStream() : textChat('')
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL })

    expect(result.chat).toEqual({ status: 'fail', code: 'no-chat' })
    expect(result.tools).toEqual({ status: 'pass' })
  })

  it('fails chat with http on a refused request', async () => {
    stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: MODEL }] })
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return toolBodyOf(body) ? toolCallStream() : new Response('server error', { status: 500 })
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL })

    expect(result.chat).toEqual({ status: 'fail', code: 'http' })
    expect(result.tools).toEqual({ status: 'pass' })
  })

  it('fails a malformed answer as shape instead of throwing', async () => {
    stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: MODEL }] })
      void init
      return new Response('{not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL })

    expect(result.chat).toEqual({ status: 'fail', code: 'shape' })
    expect(result.tools).toEqual({ status: 'fail', code: 'shape' })
  })

  it('fails the tool check with no-tool-call when the model answers with text', async () => {
    stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: MODEL }] })
      void init
      return textChat('I cannot call tools.')
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL })

    expect(result.chat).toEqual({ status: 'pass' })
    expect(result.tools).toEqual({ status: 'fail', code: 'no-tool-call' })
  })

  it('fails the tool check with no-tool-call when the call names a different tool', async () => {
    stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: MODEL }] })
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return toolBodyOf(body) ? toolCallStream('ieumoffice_other') : textChat()
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL })

    expect(result.tools).toEqual({ status: 'fail', code: 'no-tool-call' })
  })

  it('fails the tool check with http when the probe is refused', async () => {
    stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: MODEL }] })
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      return toolBodyOf(body) ? new Response('nope', { status: 400 }) : textChat()
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL })

    expect(result.chat).toEqual({ status: 'pass' })
    expect(result.tools).toEqual({ status: 'fail', code: 'http' })
  })

  it('ends the whole test as timeout when a request consumes the total budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    let chatStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      chatStarted = resolve
    })
    const mock = stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: MODEL }] })
      chatStarted()
      return hangingResponse((init as RequestInit).signal)
    })

    const pending = testLocalModel({ baseUrl: BASE, model: MODEL, timeoutMs: 60_000 })
    await started
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await pending

    expect(result.server).toEqual({ status: 'pass' })
    expect(result.model).toEqual({ status: 'pass' })
    expect(result.chat).toEqual({ status: 'fail', code: 'timeout' })
    expect(result.tools).toEqual({ status: 'fail', code: 'timeout' })
    // only the model list and the stalled chat went out; the tool probe never did
    expect(mock).toHaveBeenCalledTimes(2)
    expect(requestedUrl(mock, 1)).toBe(CHAT_URL)
  })

  it('gives the tool probe only the time left in the total budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    let toolsStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      toolsStarted = resolve
    })
    const mock = stubFetch((url, init) => {
      if (url === TAGS_URL) {
        // ten seconds of the sixty-second budget are gone before chat starts
        vi.setSystemTime(2_010_000)
        return jsonBody({ models: [{ name: MODEL }] })
      }
      const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>
      if (toolBodyOf(body)) {
        toolsStarted()
        return hangingResponse((init as RequestInit).signal)
      }
      return textChat()
    })

    const pending = testLocalModel({ baseUrl: BASE, model: MODEL, timeoutMs: 60_000 })
    await started
    let settled = false
    void pending.then(() => {
      settled = true
    })
    // the tool probe got 50s, not the default 60s connect window
    await vi.advanceTimersByTimeAsync(49_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending

    expect(result.chat).toEqual({ status: 'pass' })
    expect(result.tools).toEqual({ status: 'fail', code: 'timeout' })
    expect(mock).toHaveBeenCalledTimes(3)
  })

  it('does not send anything once the deadline has already passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000_000)
    const mock = stubFetch((url) => {
      if (url !== TAGS_URL) throw new Error('no request may follow the deadline')
      // the list itself uses up the whole budget
      vi.setSystemTime(3_060_001)
      return jsonBody({ models: [{ name: MODEL }] })
    })

    const result = await testLocalModel({ baseUrl: BASE, model: MODEL, timeoutMs: 60_000 })

    expect(result.server).toEqual({ status: 'pass' })
    expect(result.model).toEqual({ status: 'pass' })
    expect(result.chat).toEqual({ status: 'fail', code: 'timeout' })
    expect(result.tools).toEqual({ status: 'fail', code: 'timeout' })
    expect(mock).toHaveBeenCalledTimes(1)
  })

  it('returns inputError shape with every check skipped and sends no request', async () => {
    const mock = stubFetch(() => jsonBody({ models: [{ name: MODEL }] }))
    const invalid = [
      undefined,
      null,
      {},
      { model: MODEL },
      { baseUrl: BASE },
      { baseUrl: 'ftp://127.0.0.1/v1', model: MODEL },
      { baseUrl: 'not a url', model: MODEL },
      { baseUrl: BASE, model: '   ' },
      { baseUrl: BASE, model: MODEL, apiKey: 7 },
      { baseUrl: BASE, model: MODEL, apiKey: 'x'.repeat(8193) },
      { baseUrl: `http://127.0.0.1/${'x'.repeat(2048)}`, model: MODEL },
      { baseUrl: BASE, model: 'x'.repeat(257) },
    ]

    for (const input of invalid) {
      const result = await testLocalModel(input as never)
      expect(result.inputError).toBe('shape')
      expect(result.server).toEqual({ status: 'skip' })
      expect(result.model).toEqual({ status: 'skip' })
      expect(result.chat).toEqual({ status: 'skip' })
      expect(result.tools).toEqual({ status: 'skip' })
      expect(result.elapsedMs).toBe(0)
      expect(typeof result.checkedAt).toBe('number')
    }
    expect(mock).not.toHaveBeenCalled()
  })

  it('clamps a timeout below the allowed window to the minimum', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(4_000_000)
    let chatStarted: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      chatStarted = resolve
    })
    stubFetch((url, init) => {
      if (url === TAGS_URL) return jsonBody({ models: [{ name: MODEL }] })
      chatStarted()
      return hangingResponse((init as RequestInit).signal)
    })

    const pending = testLocalModel({ baseUrl: BASE, model: MODEL, timeoutMs: 1_000 })
    await started
    await vi.advanceTimersByTimeAsync(59_999)
    let settled = false
    void pending.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
  })
})

describe('testLocalModel cancel', () => {
  const tags = () => jsonBody({ models: [{ name: MODEL }] })

  it('sends nothing when the signal is already aborted', async () => {
    const fetchMock = stubFetch(() => tags())
    const controller = new AbortController()
    controller.abort()
    const result = await testLocalModel(
      { baseUrl: BASE, model: MODEL },
      { signal: controller.signal },
    )
    expect(result.cancelled).toBe(true)
    expect([result.server, result.model, result.chat, result.tools]).toEqual([
      { status: 'skip' },
      { status: 'skip' },
      { status: 'skip' },
      { status: 'skip' },
    ])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts the chat request in flight and never sends the tool check', async () => {
    const controller = new AbortController()
    const chatSignals: AbortSignal[] = []
    const fetchMock = stubFetch((url, init) => {
      if (url === TAGS_URL) return tags()
      if (url === CHAT_URL) {
        chatSignals.push(init.signal as AbortSignal)
        // the card is closed while the model is still thinking
        queueMicrotask(() => controller.abort())
        return hangingResponse(init.signal)
      }
      return jsonBody({}, 404)
    })
    const started = Date.now()
    const result = await testLocalModel(
      { baseUrl: BASE, model: MODEL, timeoutMs: 600_000 },
      { signal: controller.signal },
    )
    // ended by the cancel, long before the 10-minute budget
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(result.cancelled).toBe(true)
    expect(result.server).toEqual({ status: 'pass' })
    expect(result.model).toEqual({ status: 'pass' })
    expect(result.chat).toEqual({ status: 'skip' })
    expect(result.tools).toEqual({ status: 'skip' })
    expect(chatSignals).toHaveLength(1)
    expect(chatSignals[0]!.aborted).toBe(true)
    // one chat request only: the tool check was never sent
    expect(fetchMock.mock.calls.filter(([url]) => url === CHAT_URL)).toHaveLength(1)
  })

  it('aborts the list probe in flight and sends no chat', async () => {
    const controller = new AbortController()
    const listSignals: AbortSignal[] = []
    const fetchMock = stubFetch((url, init) => {
      if (url === TAGS_URL || url === MODELS_URL) {
        listSignals.push(init.signal as AbortSignal)
        queueMicrotask(() => controller.abort())
        return hangingResponse(init.signal)
      }
      return textChat()
    })
    const result = await testLocalModel(
      { baseUrl: BASE, model: MODEL },
      { signal: controller.signal },
    )
    expect(result.cancelled).toBe(true)
    expect(result.server).toEqual({ status: 'skip' })
    expect(listSignals[0]!.aborted).toBe(true)
    // the second list route is not tried after a cancel, and chat is never sent
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([TAGS_URL])
  })

  it('reports a finished test as not cancelled', async () => {
    stubFetch((url) =>
      url === TAGS_URL ? tags() : url === CHAT_URL ? textChat() : jsonBody({}, 404),
    )
    const controller = new AbortController()
    const result = await testLocalModel(
      { baseUrl: BASE, model: MODEL },
      { signal: controller.signal },
    )
    expect(result.cancelled).toBeUndefined()
    expect(result.chat).toEqual({ status: 'pass' })
  })
})
