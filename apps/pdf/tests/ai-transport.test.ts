import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcStreamChunk, IpcStreamError, IpcSubscriptionUsage } from '@genoffice/agent-core'
import { normalizeAiSettings } from '@genoffice/ai-provider/browser'
import { aiRunErrorText } from '@genoffice/ui'
import { createElectronTransport } from '../src/renderer/ai/transport'
import { strings } from '../src/renderer/i18n/strings'

type StreamListener = (chunk: IpcStreamChunk) => void

let listener: StreamListener | null = null
let started: { requestId: string } | null = null

beforeEach(() => {
  listener = null
  started = null
  vi.stubGlobal('pdfApi', {
    onAiStream: (fn: StreamListener) => {
      listener = fn
      return () => {
        listener = null
      }
    },
    aiStream: async (request: { requestId: string }) => {
      started = request
    },
    aiStreamCancel: vi.fn(async () => {}),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** one turn through the transport, with what the panel would learn from it */
function startTurn() {
  const errors: string[] = []
  const streamErrors: IpcStreamError[] = []
  const usage: IpcSubscriptionUsage[][] = []
  const truncated = vi.fn()
  const done = vi.fn()
  const transport = createElectronTransport(() => normalizeAiSettings({}), {
    lang: () => 'en',
    onStreamError: (error) => streamErrors.push(error),
    onSubscriptionUsage: (windows) => usage.push(windows),
    onInputTruncated: truncated,
  })
  const handle = transport.stream(
    { system: 's', messages: [], tools: [] },
    {
      onDelta: vi.fn(),
      onToolCall: vi.fn(),
      onDone: done,
      onError: (error) => errors.push(error),
    },
  )
  const push = (chunk: Omit<IpcStreamChunk, 'requestId'>) =>
    listener?.({ requestId: started!.requestId, ...chunk })
  return { errors, streamErrors, usage, truncated, done, push, handle }
}

describe('pdf AI transport', () => {
  it('hands a subscription failure over with its cause and the shared wording', () => {
    const turn = startTurn()
    const resetsAt = Date.now() + 3 * 60 * 60 * 1000
    turn.push({
      type: 'error',
      error: 'limit reached',
      errorCode: 'rate-limit',
      errorProvider: 'claude-code',
      errorResetsAt: resetsAt,
    })
    const expected = aiRunErrorText('en', {
      kind: 'rate-limit',
      provider: 'claude-code',
      resetsAt,
    })
    expect(expected).toBeTruthy()
    expect(turn.errors).toEqual([expected])
    expect(turn.streamErrors).toEqual([
      { kind: 'rate-limit', provider: 'claude-code', resetsAt, message: expected },
    ])
    handleDone(turn)
  })

  it('words a not-connected answer of the main process with the shared text', () => {
    const turn = startTurn()
    turn.push({ type: 'error', errorCode: 'not-connected' })
    expect(turn.errors).toEqual([aiRunErrorText('en', { kind: 'not-connected' })])
    expect(turn.streamErrors[0]?.kind).toBe('not-connected')
  })

  it("keeps pdf's own texts for the kinds the shared wording leaves alone", () => {
    for (const [code, key] of [
      ['network', 'aiNetworkError'],
      ['overloaded', 'aiOverloadedError'],
      ['credits', 'aiCreditsExhausted'],
      ['timeout', 'aiTimeoutError'],
    ] as const) {
      const turn = startTurn()
      turn.push({ type: 'error', error: 'raw', errorCode: code })
      // the module-level language of the pdf renderer is zh until a provider mounts
      expect(turn.errors).toEqual([strings.zh[key]])
      expect(turn.streamErrors[0]?.kind).toBe(code)
    }
  })

  it('passes a failure without a cause through as its message', () => {
    const turn = startTurn()
    turn.push({ type: 'error', error: 'HTTP 500 from the provider' })
    expect(turn.errors).toEqual(['HTTP 500 from the provider'])
    expect(turn.streamErrors).toEqual([{ message: 'HTTP 500 from the provider' }])
  })

  it('forwards subscription usage and the truncation signal without ending the turn', () => {
    const turn = startTurn()
    const windows: IpcSubscriptionUsage[] = [
      { provider: 'claude-code', window: 'five_hour', utilization: 0.83, resetsAt: 1 },
    ]
    turn.push({ type: 'subscription-usage', subscriptionUsage: windows })
    turn.push({ type: 'input-truncated' })
    expect(turn.usage).toEqual([windows])
    expect(turn.truncated).toHaveBeenCalledTimes(1)
    expect(turn.errors).toEqual([])
    expect(turn.done).not.toHaveBeenCalled()
    turn.push({ type: 'done' })
    expect(turn.done).toHaveBeenCalledTimes(1)
  })

  it('still works without hooks', () => {
    const errors: string[] = []
    const transport = createElectronTransport(() => normalizeAiSettings({}))
    transport.stream(
      { system: 's', messages: [], tools: [] },
      { onDelta: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: (e) => errors.push(e) },
    )
    listener?.({ requestId: started!.requestId, type: 'error', error: 'boom' })
    expect(errors).toEqual(['boom'])
  })

  it("the AI window's Stop names the request alone; a request-scoped cancel says so", () => {
    const cancel = (window as unknown as { pdfApi: { aiStreamCancel: ReturnType<typeof vi.fn> } })
      .pdfApi.aiStreamCancel
    const chat = startTurn()
    chat.handle.cancel()
    expect(cancel).toHaveBeenLastCalledWith(started!.requestId)
    expect(cancel.mock.calls.at(-1)).toHaveLength(1)
    const job = createElectronTransport(() => normalizeAiSettings({}), {
      lang: () => 'en',
      cancelScope: 'request',
    }).stream(
      { system: 's', messages: [], tools: [] },
      { onDelta: vi.fn(), onToolCall: vi.fn(), onDone: vi.fn(), onError: vi.fn() },
    )
    job.cancel()
    expect(cancel).toHaveBeenLastCalledWith(started!.requestId, 'request')
  })
})

/** a settled turn ignores what arrives afterwards */
function handleDone(turn: ReturnType<typeof startTurn>): void {
  turn.push({ type: 'done' })
  expect(turn.done).not.toHaveBeenCalled()
}
