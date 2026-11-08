import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IpcStreamChunk, IpcStreamError, IpcSubscriptionUsage } from '@genoffice/agent-core'
import { normalizeAiSettings } from '@genoffice/ai-provider/browser'
import { aiRunErrorText } from '@genoffice/ui'
import { createElectronTransport } from '../src/renderer/ai/transport'
import { aiBlockedRunOf } from '../src/renderer/ai/subscription-state'
import { getLang, setModuleLang } from '../src/renderer/i18n/locale'

/** A preload stand-in: records the start request and lets the test push chunks back. */
function stubBridge() {
  let listener: ((chunk: IpcStreamChunk) => void) | undefined
  let requestId = ''
  const aiStream = vi.fn(async (request: { requestId: string }) => {
    requestId = request.requestId
  })
  vi.stubGlobal('window', {
    desktopApi: {
      onAiStream: (next: (chunk: IpcStreamChunk) => void) => {
        listener = next
        return () => {
          listener = undefined
        }
      },
      aiStream,
      aiStreamCancel: vi.fn(async () => {}),
    },
  })
  return {
    aiStream,
    push: (chunk: Omit<IpcStreamChunk, 'requestId'>) => listener?.({ requestId, ...chunk }),
  }
}

function startTurn(events: Parameters<typeof createElectronTransport>[1] = {}) {
  const bridge = stubBridge()
  const settings = normalizeAiSettings({ providers: {}, provider: 'claude-code' })
  const callbacks = {
    onDelta: vi.fn(),
    onToolCall: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  }
  createElectronTransport(() => settings, events).stream(
    { system: 'sys', messages: [], tools: [] },
    callbacks,
  )
  return { bridge, callbacks, settings }
}

const initialLang = getLang()

afterEach(() => {
  vi.unstubAllGlobals()
  setModuleLang(initialLang)
})

describe('sheets AI transport', () => {
  it('sends the settings as they are: the main process resolves the provider', () => {
    const { bridge, settings } = startTurn()
    expect(bridge.aiStream).toHaveBeenCalledTimes(1)
    expect(bridge.aiStream.mock.calls[0]?.[0]).toMatchObject({ settings, system: 'sys' })
    // settle the turn so its silence watchdog does not outlive the test
    bridge.push({ type: 'done' })
  })

  it('words a subscription cause the shared way and hands the cause to the panel', () => {
    setModuleLang('en')
    const errors: IpcStreamError[] = []
    const { bridge, callbacks } = startTurn({ onStreamError: (error) => errors.push(error) })
    bridge.push({
      type: 'error',
      error: 'raw text from the program',
      errorCode: 'rate-limit',
      errorProvider: 'claude-code',
      errorResetsAt: 1_800_000_000_000,
    })
    const cause = {
      kind: 'rate-limit' as const,
      provider: 'claude-code' as const,
      resetsAt: 1_800_000_000_000,
    }
    const text = aiRunErrorText('en', cause)
    expect(text).toBeTruthy()
    expect(callbacks.onError).toHaveBeenCalledWith(text)
    expect(errors).toEqual([{ ...cause, message: text }])
    // which is what turns the reply into a blocked notice
    expect(aiBlockedRunOf(errors[0], text ?? '')).toEqual(cause)
  })

  it('follows the UI language for those texts', () => {
    setModuleLang('ko')
    const { bridge, callbacks } = startTurn()
    bridge.push({ type: 'error', errorCode: 'not-connected' })
    expect(callbacks.onError).toHaveBeenCalledWith(aiRunErrorText('ko', { kind: 'not-connected' }))
    expect(aiRunErrorText('ko', { kind: 'not-connected' })).not.toBe(
      aiRunErrorText('en', { kind: 'not-connected' }),
    )
  })

  it("shows a key provider's own credits message instead of a fixed text", () => {
    const { bridge, callbacks } = startTurn()
    bridge.push({ type: 'error', error: 'Insufficient credits on this key', errorCode: 'credits' })
    expect(callbacks.onError).toHaveBeenCalledWith('Insufficient credits on this key')
  })

  it('passes a failure without a cause through unchanged', () => {
    const errors: IpcStreamError[] = []
    const { bridge, callbacks } = startTurn({ onStreamError: (error) => errors.push(error) })
    bridge.push({ type: 'error', error: 'boom' })
    expect(callbacks.onError).toHaveBeenCalledWith('boom')
    expect(aiBlockedRunOf(errors[0], 'boom')).toBeUndefined()
  })

  it('reports subscription usage and a cut input without ending the turn', () => {
    const usage: IpcSubscriptionUsage[] = [
      { provider: 'codex', window: 'seven_day', utilization: 0.91, resetsAt: 1_800_000_000_000 },
    ]
    const onSubscriptionUsage = vi.fn()
    const onInputTruncated = vi.fn()
    const { bridge, callbacks } = startTurn({ onSubscriptionUsage, onInputTruncated })
    bridge.push({ type: 'subscription-usage', subscriptionUsage: usage })
    bridge.push({ type: 'input-truncated' })
    expect(onSubscriptionUsage).toHaveBeenCalledWith(usage)
    expect(onInputTruncated).toHaveBeenCalledTimes(1)
    expect(callbacks.onDone).not.toHaveBeenCalled()
    bridge.push({ type: 'done' })
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })
})
