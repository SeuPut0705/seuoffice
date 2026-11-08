/**
 * The provider side of `ai:stream` (main process): which provider a request
 * runs on, and how callbacks and failures become stream chunks. Every run goes
 * through a mocked provider router — nothing here starts a real CLI.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  AiRunError,
  AiTimeoutError,
  HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
  defaultAiSettings,
  sanitizeAiSettings,
  type AiSettings,
  type AiStreamChunk,
  type AiStreamRequest,
  type AiSubscriptionState,
  type AiSubscriptionStatuses,
  type StreamCallbacks,
  type streamForProvider,
} from '@genoffice/ai-provider'
import {
  resolveStreamTarget,
  runAiStream,
  storedAiSettings,
  withMeteredAccepted,
} from '../src/main/ai-stream'

const status = (
  provider: 'claude-code' | 'codex',
  state: AiSubscriptionState,
  meteredAccepted = false,
) => ({ provider, state, meteredAccepted })

const statuses = (
  claude: AiSubscriptionState,
  codex: AiSubscriptionState,
): AiSubscriptionStatuses => ({
  'claude-code': status('claude-code', claude),
  codex: status('codex', codex),
})

function settingsWith(patch: Partial<AiSettings> = {}): AiSettings {
  return { ...storedAiSettings({}), ...patch }
}

function withAnthropicKey(settings: AiSettings): AiSettings {
  return {
    ...settings,
    providers: {
      ...settings.providers,
      anthropic: { apiKey: 'sk-test', model: 'claude-test-model' },
    },
  }
}

const request = (settings: AiSettings): AiStreamRequest => ({
  requestId: 'r1',
  settings,
  system: 'sys',
  messages: [{ role: 'user', text: 'hello' }],
})

type StreamFn = typeof streamForProvider

async function run(
  settings: AiSettings,
  current: AiSubscriptionStatuses,
  stream: StreamFn,
  signal = new AbortController().signal,
): Promise<AiStreamChunk[]> {
  const chunks: AiStreamChunk[] = []
  await runAiStream({
    request: request(settings),
    settings,
    statuses: current,
    signal,
    send: (chunk) => chunks.push(chunk),
    stream,
  })
  return chunks
}

describe('provider resolution for a stream request', () => {
  it('auto runs on Claude when it is ready, else on Codex when that is ready', () => {
    const settings = settingsWith()
    expect(settings.provider).toBe('auto')
    expect(resolveStreamTarget(settings, statuses('ready', 'ready'))).toMatchObject({
      connected: true,
      provider: 'claude-code',
    })
    expect(resolveStreamTarget(settings, statuses('signed-out', 'ready'))).toMatchObject({
      connected: true,
      provider: 'codex',
    })
  })

  it('auto with no ready subscription is "not connected", even when a key provider is filled in', () => {
    const settings = withAnthropicKey(settingsWith())
    const target = resolveStreamTarget(settings, statuses('not-installed', 'signed-out'))
    expect(target).toEqual({
      connected: false,
      error: { error: expect.any(String), errorCode: 'not-connected' },
    })
  })

  it('a selected subscription that cannot run reports its own cause and provider', () => {
    const codex = settingsWith({ provider: 'codex' })
    expect(resolveStreamTarget(codex, statuses('ready', 'signed-out'))).toEqual({
      connected: false,
      error: { error: expect.any(String), errorCode: 'signed-out', errorProvider: 'codex' },
    })
    const claude = settingsWith({ provider: 'claude-code' })
    expect(resolveStreamTarget(claude, statuses('not-installed', 'ready'))).toMatchObject({
      connected: false,
      error: { errorCode: 'not-installed', errorProvider: 'claude-code' },
    })
    expect(resolveStreamTarget(claude, statuses('metered', 'ready'))).toMatchObject({
      connected: false,
      error: { errorCode: 'metered-not-accepted', errorProvider: 'claude-code' },
    })
  })

  it('a metered login runs only once it was accepted, in the settings and in the status', () => {
    const accepted = settingsWith({ provider: 'codex', meteredAccepted: { codex: true } })
    const live: AiSubscriptionStatuses = { codex: status('codex', 'metered', true) }
    expect(resolveStreamTarget(accepted, live)).toMatchObject({
      connected: true,
      provider: 'codex',
    })
    // the stored flag alone (a login that changed since) does not start a paid run
    const stale: AiSubscriptionStatuses = { codex: status('codex', 'metered', false) }
    expect(resolveStreamTarget(accepted, stale)).toMatchObject({ connected: false })
  })

  it('a selected key provider runs with its own config, and is "not connected" while unfinished', () => {
    const ready = withAnthropicKey(settingsWith({ provider: 'anthropic' }))
    expect(resolveStreamTarget(ready, {})).toEqual({
      connected: true,
      provider: 'anthropic',
      config: { apiKey: 'sk-test', model: 'claude-test-model' },
    })
    const unfinished = settingsWith({ provider: 'anthropic' })
    // a key provider is not a subscription: the chunk names no subscription provider
    expect(resolveStreamTarget(unfinished, statuses('ready', 'ready'))).toEqual({
      connected: false,
      error: { error: expect.any(String), errorCode: 'not-connected' },
    })
  })
})

describe('runAiStream', () => {
  it('answers a not-connected request with one error chunk and calls no provider', async () => {
    const stream = vi.fn<StreamFn>(async () => {})
    const chunks = await run(settingsWith(), statuses('signed-out', 'not-installed'), stream)
    expect(stream).not.toHaveBeenCalled()
    expect(chunks).toEqual([
      { requestId: 'r1', type: 'error', error: expect.any(String), errorCode: 'not-connected' },
    ])
  })

  it('never falls back from a selection that cannot run to a provider that could', async () => {
    const stream = vi.fn<StreamFn>(async () => {})
    // Codex is selected and signed out; Claude is ready and a key provider is filled in
    const settings = withAnthropicKey(settingsWith({ provider: 'codex' }))
    const chunks = await run(settings, statuses('ready', 'signed-out'), stream)
    expect(stream).not.toHaveBeenCalled()
    expect(chunks).toEqual([
      {
        requestId: 'r1',
        type: 'error',
        error: expect.any(String),
        errorCode: 'signed-out',
        errorProvider: 'codex',
      },
    ])
  })

  it('streams on the resolved provider and forwards usage and truncation as their own chunks', async () => {
    const usage = [
      {
        provider: 'claude-code' as const,
        window: 'five_hour' as const,
        utilization: 0.83,
        resetsAt: 1,
      },
    ]
    const stream = vi.fn<StreamFn>(
      async (_provider, _config, _system, _messages, _tools, _max, cb) => {
        const callbacks: StreamCallbacks = cb
        callbacks.onInputTruncated?.()
        callbacks.onDelta('Hi')
        callbacks.onSubscriptionUsage?.(usage)
        callbacks.onStopReason?.('max_tokens')
      },
    )
    const chunks = await run(settingsWith(), statuses('ready', 'ready'), stream)
    expect(stream).toHaveBeenCalledOnce()
    expect(stream.mock.calls[0]![0]).toBe('claude-code')
    expect(stream.mock.calls[0]![2]).toBe('sys')
    expect(chunks).toEqual([
      { requestId: 'r1', type: 'input-truncated' },
      { requestId: 'r1', type: 'delta', text: 'Hi' },
      { requestId: 'r1', type: 'subscription-usage', subscriptionUsage: usage },
      { requestId: 'r1', type: 'done', stopReason: 'max_tokens' },
    ])
  })

  it('uses the model of the request for the resolved provider (per-request overrides survive)', async () => {
    const stream = vi.fn<StreamFn>(async () => {})
    const settings = withAnthropicKey(settingsWith({ provider: 'anthropic' }))
    await run(settings, {}, stream)
    expect(stream.mock.calls[0]![0]).toBe('anthropic')
    expect(stream.mock.calls[0]![1]).toEqual({ apiKey: 'sk-test', model: 'claude-test-model' })
  })

  it('forwards the cause, provider and reset time of a blocked run', async () => {
    const stream = vi.fn<StreamFn>(async () => {
      throw new AiRunError('rate-limit', 'limit reached', { provider: 'codex', resetsAt: 1234 })
    })
    const chunks = await run(
      settingsWith({ provider: 'codex' }),
      statuses('ready', 'ready'),
      stream,
    )
    expect(chunks).toEqual([
      {
        requestId: 'r1',
        type: 'error',
        error: 'limit reached',
        errorCode: 'rate-limit',
        errorProvider: 'codex',
        errorResetsAt: 1234,
      },
    ])
  })

  it('keeps the existing codes for timeouts and leaves an unknown failure uncoded', async () => {
    const timeout = vi.fn<StreamFn>(async () => {
      throw new AiTimeoutError(180_000)
    })
    const timedOut = await run(settingsWith(), statuses('ready', 'ready'), timeout)
    expect(timedOut).toHaveLength(1)
    expect(timedOut[0]).toMatchObject({ type: 'error', errorCode: 'timeout' })

    const plain = vi.fn<StreamFn>(async () => {
      throw new Error('model not found')
    })
    const failed = await run(settingsWith(), statuses('ready', 'ready'), plain)
    expect(failed).toEqual([{ requestId: 'r1', type: 'error', error: 'model not found' }])
  })

  it('a cancelled run ends as done, not as an error', async () => {
    const controller = new AbortController()
    const stream = vi.fn<StreamFn>(async () => {
      controller.abort()
      throw new Error('aborted')
    })
    const chunks = await run(settingsWith(), statuses('ready', 'ready'), stream, controller.signal)
    expect(chunks).toEqual([{ requestId: 'r1', type: 'done' }])
  })
})

describe('settings as the main process reads and writes them', () => {
  it('a file written before the subscription providers existed falls to the new defaults', () => {
    for (const removed of ['retired-provider']) {
      const settings = storedAiSettings({
        provider: removed,
        providers: { anthropic: { apiKey: 'k', model: 'm' } },
      })
      expect(settings.provider).toBe('auto')
      expect(settings.providers.anthropic).toMatchObject({ apiKey: 'k', model: 'm' })
    }
  })

  it('keeps an explicit subscription selection (no override on read)', () => {
    expect(storedAiSettings({ provider: 'claude-code', providers: {} }).provider).toBe(
      'claude-code',
    )
    expect(storedAiSettings({ provider: 'codex', providers: {} }).provider).toBe('codex')
  })

  it('never throws on a damaged file', () => {
    const unknownId = { provider: 'no-such-provider', providers: {} }
    for (const damaged of [null, undefined, 'x', 42, [], unknownId]) {
      expect(storedAiSettings(damaged).provider).toBe('auto')
    }
    expect(storedAiSettings({}).provider).toBe(defaultAiSettings().provider)
  })

  it('"use anyway" is stored per provider without touching the rest', () => {
    const before = withAnthropicKey(settingsWith({ meteredAccepted: { codex: true } }))
    const after = withMeteredAccepted(before, 'claude-code', true)
    expect(after.meteredAccepted).toEqual({ codex: true, 'claude-code': true })
    expect(after.providers).toBe(before.providers)
    expect(before.meteredAccepted).toEqual({ codex: true })
    expect(withMeteredAccepted(after, 'codex', false).meteredAccepted).toEqual({
      codex: false,
      'claude-code': true,
    })
  })

  it('"use anyway" survives on a PC that has no settings file yet', () => {
    // no file: what gets written must be complete settings, because a file without a
    // providers table reads back as a pre-provider legacy file (defaults, acceptance lost)
    for (const missing of [undefined, {}]) {
      const written = withMeteredAccepted(storedAiSettings(missing), 'codex', true)
      expect(written.providers.codex).toBeDefined()
      const reread = storedAiSettings(JSON.parse(JSON.stringify(written)))
      expect(reread.meteredAccepted).toMatchObject({ codex: true })
      expect(reread.provider).toBe('auto')
    }
    // the one-field patch this guards against really would lose it
    expect(storedAiSettings({ meteredAccepted: { codex: true } }).meteredAccepted?.codex).not.toBe(
      true,
    )
  })

  it('the save path keeps the subscription fields the panel and the settings screen write', () => {
    const saved = sanitizeAiSettings({
      ...storedAiSettings({}),
      meteredAccepted: { 'claude-code': true },
      headlessSubscriptionEnabled: true,
      headlessSubscriptionConsentVersion: HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
      subscriptionNoticeSeen: true,
    })
    expect(saved).not.toBeNull()
    const reread = storedAiSettings(JSON.parse(JSON.stringify(saved)))
    expect(reread.meteredAccepted).toMatchObject({ 'claude-code': true })
    expect(reread.headlessSubscriptionEnabled).toBe(true)
    expect(reread.headlessSubscriptionConsentVersion).toBe(HEADLESS_SUBSCRIPTION_CONSENT_VERSION)
    expect(reread.subscriptionNoticeSeen).toBe(true)
  })
})
