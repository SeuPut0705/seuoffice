import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDocument, type AiRelay } from '../src/index'

const BASE = 'https://office.example/'
const ORIGIN = 'https://office.example'

function post(source: Window | null, origin: string, data: Record<string, unknown>): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      source,
      origin,
      data: { source: 'seuoffice', version: 1, ...data },
    }),
  )
}

/** A document opened with an AI relay; `messages` are what this side posted to the page */
function openWithAi(ai: AiRelay | undefined) {
  const doc = openDocument(document.body, {
    baseUrl: BASE,
    fileName: 'memo.docx',
    bytes: new Uint8Array([1]),
    ...(ai ? { ai } : {}),
  })
  const sent = vi.spyOn(doc.iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
  post(doc.iframe.contentWindow, ORIGIN, { type: 'ready' })
  post(doc.iframe.contentWindow, ORIGIN, { type: 'opened' })
  const messages = () => sent.mock.calls.map((call) => call[0] as Record<string, unknown>)
  const ask = (requestId: string, body: unknown = { model: '' }, origin = ORIGIN) =>
    post(doc.iframe.contentWindow, origin, { type: 'ai_request', requestId, body })
  return { doc, messages, ask }
}

const encoder = new TextEncoder()

/** A complete SSE response made of `parts` */
function sseResponse(parts: string[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part))
        controller.close()
      },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  )
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('relaying AI requests to the host', () => {
  it('tells the page whether the host offers AI', () => {
    const withAi = openWithAi({ request: async () => sseResponse([]) })
    const withoutAi = openWithAi(undefined)
    expect(withAi.messages().find((m) => m.type === 'open')?.ai).toBe(true)
    expect(withoutAi.messages().find((m) => m.type === 'open')?.ai).toBe(false)
  })

  it('hands the body to the host and relays its bytes in order, then ai_end', async () => {
    const bodies: unknown[] = []
    const { doc, messages, ask } = openWithAi({
      request: async (body) => {
        bodies.push(body)
        return sseResponse(['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'])
      },
    })
    ask('r1', { model: 'hint', messages: [{ role: 'user', content: 'hi' }], stream: true })
    await vi.waitFor(() => expect(messages().some((m) => m.type === 'ai_end')).toBe(true))
    expect(bodies).toEqual([
      { model: 'hint', messages: [{ role: 'user', content: 'hi' }], stream: true },
    ])
    const relayed = messages().filter((m) => m.requestId === 'r1')
    expect(relayed.map((m) => m.type)).toEqual(['ai_chunk', 'ai_chunk', 'ai_chunk', 'ai_end'])
    const text = relayed
      .filter((m) => m.type === 'ai_chunk')
      .map((m) => new TextDecoder().decode(m.data as Uint8Array))
      .join('')
    expect(text).toBe('data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n')
    doc.destroy()
  })

  it('answers a non-2xx gateway reply with ai_error carrying the status and body', async () => {
    const { doc, messages, ask } = openWithAi({
      request: async () => new Response('{"error":{"message":"boom"}}', { status: 500 }),
    })
    ask('r1')
    await vi.waitFor(() => expect(messages().some((m) => m.type === 'ai_error')).toBe(true))
    expect(messages().filter((m) => m.requestId === 'r1')).toEqual([
      {
        source: 'seuoffice',
        version: 1,
        type: 'ai_error',
        requestId: 'r1',
        status: 500,
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
        message: '{"error":{"message":"boom"}}',
      },
    ])
    doc.destroy()
  })

  it('answers a failed host call with ai_error without a status', async () => {
    const { doc, messages, ask } = openWithAi({
      request: async () => {
        throw new Error('signed out')
      },
    })
    ask('r1')
    await vi.waitFor(() => expect(messages().some((m) => m.type === 'ai_error')).toBe(true))
    const error = messages().find((m) => m.type === 'ai_error')!
    expect(error.message).toBe('signed out')
    expect(error.status).toBeUndefined()
    doc.destroy()
  })

  it('aborts the host fetch on ai_cancel and posts nothing more for it', async () => {
    const signals: AbortSignal[] = []
    const { doc, messages, ask } = openWithAi({
      request: (_body, signal) => {
        signals.push(signal)
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        )
      },
    })
    ask('r1')
    ask('r2')
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    post(doc.iframe.contentWindow, ORIGIN, { type: 'ai_cancel', requestId: 'r1' })
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
    await Promise.resolve()
    expect(messages().filter((m) => m.requestId === 'r1')).toEqual([])
    doc.destroy()
  })

  it('aborts every request in flight on destroy()', async () => {
    const signals: AbortSignal[] = []
    const { doc, ask } = openWithAi({
      request: (_body, signal) => {
        signals.push(signal)
        return new Promise<Response>(() => {})
      },
    })
    ask('r1')
    ask('r2')
    await vi.waitFor(() => expect(signals).toHaveLength(2))
    doc.destroy()
    expect(signals.every((signal) => signal.aborted)).toBe(true)
  })

  it('stops reading a streaming answer on ai_cancel', async () => {
    let cancelled = false
    const { doc, messages, ask } = openWithAi({
      request: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('data: {"a":1}\n\n'))
            },
            cancel() {
              cancelled = true
            },
          }),
        ),
    })
    ask('r1')
    await vi.waitFor(() => expect(messages().some((m) => m.type === 'ai_chunk')).toBe(true))
    post(doc.iframe.contentWindow, ORIGIN, { type: 'ai_cancel', requestId: 'r1' })
    await vi.waitFor(() => expect(cancelled).toBe(true))
    expect(messages().some((m) => m.type === 'ai_end' || m.type === 'ai_error')).toBe(false)
    doc.destroy()
  })

  it('ignores AI requests from another origin or window', async () => {
    const request = vi.fn(async () => sseResponse([]))
    const { doc, ask } = openWithAi({ request })
    ask('r1', {}, 'https://evil.example')
    post(window, ORIGIN, { type: 'ai_request', requestId: 'r2', body: {} })
    // the relay starts synchronously on an accepted message, so nothing ran
    expect(request).not.toHaveBeenCalled()
    doc.destroy()
  })

  it('refuses AI requests when the host offers none', async () => {
    const { doc, messages, ask } = openWithAi(undefined)
    ask('r1')
    await vi.waitFor(() => expect(messages().some((m) => m.type === 'ai_error')).toBe(true))
    doc.destroy()
  })

  it('passes on only the content type and Retry-After, with the first answer', async () => {
    const { doc, messages, ask } = openWithAi({
      request: async () =>
        new Response('{"choices":[]}', {
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '3',
            'Set-Cookie': 'session=secret',
            'X-Upstream-Token': 'secret',
          },
        }),
    })
    ask('r1')
    await vi.waitFor(() => expect(messages().some((m) => m.type === 'ai_end')).toBe(true))
    const relayed = messages().filter((m) => m.requestId === 'r1')
    expect(relayed[0]!.headers).toEqual({ 'content-type': 'application/json', 'retry-after': '3' })
    expect(relayed.slice(1).every((m) => m.headers === undefined)).toBe(true)
    doc.destroy()
  })

  it('passes on Retry-After with a refusal', async () => {
    const { doc, messages, ask } = openWithAi({
      request: async () =>
        new Response('busy', { status: 429, headers: { 'Retry-After': '3600' } }),
    })
    ask('r1')
    await vi.waitFor(() => expect(messages().some((m) => m.type === 'ai_error')).toBe(true))
    const error = messages().find((m) => m.type === 'ai_error')!
    expect(error.status).toBe(429)
    expect(error.headers).toEqual({
      'content-type': 'text/plain;charset=UTF-8',
      'retry-after': '3600',
    })
    doc.destroy()
  })

  it('ignores an AI request that arrives before the page asked for its document', () => {
    const request = vi.fn(async () => sseResponse([]))
    const doc = openDocument(document.body, {
      baseUrl: BASE,
      fileName: 'memo.docx',
      bytes: new Uint8Array([1]),
      ai: { request },
    })
    vi.spyOn(doc.iframe.contentWindow!, 'postMessage').mockImplementation(() => {})
    post(doc.iframe.contentWindow, ORIGIN, { type: 'ai_request', requestId: 'r1', body: {} })
    expect(request).not.toHaveBeenCalled()
    doc.destroy()
  })

  it('drops an answer that comes after the cancel when the host ignored the signal', async () => {
    let finish!: (response: Response) => void
    let cancelled = false
    const { doc, messages, ask } = openWithAi({
      request: () => new Promise<Response>((resolve) => (finish = resolve)),
    })
    ask('r1')
    await vi.waitFor(() => expect(finish).toBeDefined())
    post(doc.iframe.contentWindow, ORIGIN, { type: 'ai_cancel', requestId: 'r1' })
    finish(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"a":1}\n\n'))
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
    )
    await vi.waitFor(() => expect(cancelled).toBe(true))
    expect(messages().filter((m) => m.requestId === 'r1')).toEqual([])
    doc.destroy()
  })
})
