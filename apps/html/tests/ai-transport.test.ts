import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IpcStreamError, IpcSubscriptionUsage } from '@genoffice/agent-core'
import { defaultAiSettings, type AiStreamChunk, type AiStreamRequest } from '@genoffice/ai-provider'
import { LANGS } from '@genoffice/i18n'
import { aiRunErrorText } from '@genoffice/ui'
import { streamBrief } from '../src/renderer/ai/brief-writer'
import { blockedRunOf, writerMayRetry } from '../src/renderer/ai/connection'
import { streamPage } from '../src/renderer/ai/page-writer'
import { createElectronTransport } from '../src/renderer/ai/transport'
import { aiStrings } from '../src/renderer/i18n/strings-ai'

/** The main process as the renderer sees it: one stream listener, requests answered by a script */
function fakeBridge(reply: (request: AiStreamRequest) => Array<Partial<AiStreamChunk>>) {
  let listener: ((chunk: AiStreamChunk) => void) | null = null
  const requests: AiStreamRequest[] = []
  const api = {
    onAiStream: (next: (chunk: AiStreamChunk) => void) => {
      listener = next
      return () => {
        listener = null
      }
    },
    aiStream: async (request: AiStreamRequest) => {
      requests.push(request)
      for (const chunk of reply(request)) {
        listener?.({ requestId: request.requestId, ...chunk } as AiStreamChunk)
      }
    },
    aiStreamCancel: vi.fn(async () => undefined),
  }
  return { api, requests }
}

function wired(reply: (request: AiStreamRequest) => Array<Partial<AiStreamChunk>>) {
  const bridge = fakeBridge(reply)
  Object.assign(window, { htmlApi: bridge.api })
  const errors: IpcStreamError[] = []
  const usage: IpcSubscriptionUsage[][] = []
  const onInputTruncated = vi.fn()
  const transport = createElectronTransport(() => defaultAiSettings(), {
    getLang: () => 'en',
    onStreamError: (error) => errors.push(error),
    onSubscriptionUsage: (windows) => usage.push(windows),
    onInputTruncated,
  })
  return { ...bridge, transport, errors, usage, onInputTruncated }
}

/** One turn through the transport; resolves with what the agent loop would have been told */
function runTurn(transport: ReturnType<typeof wired>['transport']) {
  return new Promise<{ text: string; error?: string }>((resolve) => {
    let text = ''
    transport.stream(
      { system: 's', messages: [{ role: 'user', text: 'hi' }], tools: [] },
      {
        onDelta: (delta) => {
          text += delta
        },
        onToolCall: () => undefined,
        onDone: () => resolve({ text }),
        onError: (error) => resolve({ text, error }),
      },
    )
  })
}

afterEach(() => {
  delete (window as { htmlApi?: unknown }).htmlApi
})

describe('createElectronTransport', () => {
  it('words a subscription error once for every editor and hands the panel its cause', async () => {
    const resetsAt = Date.now() + 60 * 60 * 1000
    const { transport, errors } = wired(() => [
      {
        type: 'error',
        error: 'raw CLI text',
        errorCode: 'rate-limit',
        errorProvider: 'claude-code',
        errorResetsAt: resetsAt,
      },
    ])
    const turn = await runTurn(transport)
    const expected = aiRunErrorText('en', { kind: 'rate-limit', provider: 'claude-code', resetsAt })
    expect(expected).toBeTruthy()
    expect(turn.error).toBe(expected)
    expect(turn.error).not.toContain('raw CLI text')
    expect(errors).toEqual([
      { kind: 'rate-limit', provider: 'claude-code', resetsAt, message: expected },
    ])
    expect(blockedRunOf(errors[0])).toMatchObject({ kind: 'rate-limit', provider: 'claude-code' })
  })

  it('reports "nothing connected" as a blocked cause, not as a raw error', async () => {
    const { transport, errors } = wired(() => [{ type: 'error', errorCode: 'not-connected' }])
    const turn = await runTurn(transport)
    expect(turn.error).toBe(aiRunErrorText('en', { kind: 'not-connected' }))
    expect(blockedRunOf(errors[0])).toEqual({ kind: 'not-connected', message: turn.error })
  })

  it("keeps this app's own wording for the transient kinds", async () => {
    // outside a LocaleProvider the app's module-level language is its default, zh
    const texts = aiStrings.zh
    for (const [errorCode, text] of [
      ['timeout', texts.aiTimeoutError],
      ['network', texts.aiNetworkError],
      ['overloaded', texts.aiOverloadedError],
      ['credits', texts.aiCreditsExhausted],
    ] as const) {
      const { transport, errors } = wired(() => [{ type: 'error', errorCode }])
      const turn = await runTurn(transport)
      expect(turn.error).toBe(text)
      expect(blockedRunOf(errors[0])).toBeNull()
    }
  })

  it('forwards subscription usage and the input-truncated signal during a turn', async () => {
    const windows: IpcSubscriptionUsage[] = [
      { provider: 'claude-code', window: 'five_hour', utilization: 0.83, resetsAt: 5000 },
    ]
    const { transport, usage, onInputTruncated } = wired(() => [
      { type: 'input-truncated' },
      { type: 'subscription-usage', subscriptionUsage: windows },
      { type: 'delta', text: 'ok' },
      { type: 'done' },
    ])
    const turn = await runTurn(transport)
    expect(turn).toEqual({ text: 'ok' })
    expect(usage).toEqual([windows])
    expect(onInputTruncated).toHaveBeenCalledTimes(1)
  })

  it('sends the request to the shared stream channel with the settings it was given', async () => {
    const { transport, requests } = wired(() => [{ type: 'done' }])
    await runTurn(transport)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.settings.provider).toBe('auto')
    expect(requests[0]!.system).toBe('s')
  })
})

describe('the page and brief writers on a blocked connection', () => {
  it('the brief writer returns the localized reason and its cause forbids a retry', async () => {
    const { transport, errors, requests } = wired(() => [
      { type: 'error', error: 'raw', errorCode: 'signed-out', errorProvider: 'codex' },
    ])
    const result = await streamBrief({ transport, system: 's', user: 'u' })
    const expected = aiRunErrorText('en', { kind: 'signed-out', provider: 'codex' })
    expect(result).toEqual({ ok: false, error: expected })
    expect(requests).toHaveLength(1)
    expect(writerMayRetry(errors.at(-1))).toBe(false)
    expect(blockedRunOf(errors.at(-1))).toMatchObject({ kind: 'signed-out', provider: 'codex' })
  })

  it('the page writer returns the localized reason and its cause forbids a retry', async () => {
    const { transport, errors } = wired(() => [{ type: 'error', errorCode: 'not-connected' }])
    const outcome = await streamPage({ transport, system: 's', user: 'u' })
    expect(outcome).toEqual({
      status: 'empty',
      error: aiRunErrorText('en', { kind: 'not-connected' }),
    })
    expect(writerMayRetry(errors.at(-1))).toBe(false)
  })

  it('a page cut off by a used-up limit keeps what arrived and still names the cause', async () => {
    const { transport, errors } = wired(() => [
      { type: 'delta', text: '<!doctype html><html><body><h1>Half' },
      { type: 'error', errorCode: 'rate-limit', errorProvider: 'claude-code' },
    ])
    const outcome = await streamPage({ transport, system: 's', user: 'u' })
    expect(outcome).toMatchObject({ status: 'partial', reason: 'error' })
    expect(blockedRunOf(errors.at(-1))).toMatchObject({ kind: 'rate-limit' })
  })

  it('an ordinary empty reply may still be retried', async () => {
    const { transport, errors } = wired(() => [{ type: 'done' }])
    const outcome = await streamPage({ transport, system: 's', user: 'u' })
    expect(outcome.status).toBe('empty')
    expect(writerMayRetry(errors.at(-1))).toBe(true)
  })
})

describe('the out-of-credits text', () => {
  it('points at no particular vendor or web address in any language', () => {
    for (const lang of LANGS) {
      const text = aiStrings[lang].aiCreditsExhausted
      expect(text.trim(), lang).not.toBe('')
      // a key provider of the user's own choice ran out: there is no one site to send them to
      expect(text, lang).not.toMatch(/[a-z0-9-]+\.(ai|com|io)\b/i)
    }
  })

  it('is translated, not an English copy', () => {
    const english = aiStrings.en.aiCreditsExhausted
    for (const lang of LANGS) {
      if (lang !== 'en') expect(aiStrings[lang].aiCreditsExhausted, lang).not.toBe(english)
    }
  })
})
