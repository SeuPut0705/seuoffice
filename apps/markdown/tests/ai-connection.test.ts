import { describe, expect, it, vi } from 'vitest'
import {
  normalizeAiSettings,
  type AiSettings,
  type AiSubscriptionStatus,
  type AiSubscriptionStatuses,
} from '@genoffice/ai-provider/browser'
import { aiSendGate, withAiContinueProvider, withAiSubscriptionNoticeSeen } from '@genoffice/ui'
import { blockedRunOf, readImageGenerationAvailable } from '../src/renderer/ai/ai-connection'
import {
  checkingSubscriptionStatuses,
  subscriptionLaunchResultOf,
  subscriptionStatusMapOf,
} from '../src/shared/subscription-api'

const status = (
  provider: AiSubscriptionStatus['provider'],
  state: AiSubscriptionStatus['state'],
  meteredAccepted = false,
): AiSubscriptionStatus => ({ provider, state, meteredAccepted })

const statuses = (
  claude: AiSubscriptionStatus['state'],
  codex: AiSubscriptionStatus['state'],
): AiSubscriptionStatuses => ({
  'claude-code': status('claude-code', claude),
  codex: status('codex', codex),
})

const settings = (patch: Partial<AiSettings> = {}): AiSettings => ({
  ...normalizeAiSettings(undefined),
  ...patch,
})

// The gate itself is the one every editor shares (@genoffice/ui); these pin it on the
// settings and statuses the markdown panel hands it.
describe('aiSendGate', () => {
  it('holds the send while settings or statuses are still unknown', () => {
    expect(aiSendGate(null, statuses('ready', 'ready')).kind).toBe('checking')
    expect(aiSendGate(settings(), null).kind).toBe('checking')
  })

  it('asks to connect when automatic finds no ready subscription', () => {
    const gate = aiSendGate(settings(), statuses('signed-out', 'not-installed'))
    expect(gate.kind).toBe('connect')
    if (gate.kind !== 'connect') return
    expect(gate.choice).toMatchObject({ connected: false, reason: 'no-subscription' })
  })

  it('never falls back from automatic to a configured key provider', () => {
    const withKey = settings()
    withKey.providers.openai = { apiKey: 'sk-test', model: 'gpt-5' }
    expect(aiSendGate(withKey, statuses('signed-out', 'signed-out')).kind).toBe('connect')
  })

  it('reads a missing handler (every status checking) as still being checked', () => {
    expect(aiSendGate(settings(), checkingSubscriptionStatuses()).kind).toBe('checking')
  })

  it('shows the first-connection notice before a subscription is used for the first time', () => {
    expect(aiSendGate(settings(), statuses('ready', 'not-installed'))).toMatchObject({
      kind: 'notice',
      provider: 'claude-code',
    })
    expect(aiSendGate(settings(), statuses('signed-out', 'ready'))).toMatchObject({
      kind: 'notice',
      provider: 'codex',
    })
  })

  it('runs on a subscription once the notice was acknowledged', () => {
    const seen = withAiSubscriptionNoticeSeen(settings())
    expect(seen.subscriptionNoticeSeen).toBe(true)
    expect(aiSendGate(seen, statuses('ready', 'ready')).kind).toBe('run')
  })

  it('runs a selected, configured key provider without the subscription notice', () => {
    const withKey = settings({ provider: 'openai' })
    withKey.providers.openai = { apiKey: 'sk-test', model: 'gpt-5' }
    expect(aiSendGate(withKey, checkingSubscriptionStatuses()).kind).toBe('run')
  })

  it('reports a selected subscription that cannot run instead of using the other one', () => {
    const gate = aiSendGate(settings({ provider: 'codex' }), statuses('ready', 'signed-out'))
    expect(gate.kind).toBe('connect')
    if (gate.kind !== 'connect') return
    expect(gate.choice).toMatchObject({ provider: 'codex', reason: 'signed-out' })
  })
})

describe('blockedRunOf', () => {
  it('returns the cause of a blocked run with its provider and reset time', () => {
    const message = 'limit used up'
    expect(
      blockedRunOf(
        { kind: 'rate-limit', provider: 'claude-code', resetsAt: 1234, message },
        message,
      ),
    ).toEqual({ kind: 'rate-limit', provider: 'claude-code', resetsAt: 1234 })
    expect(blockedRunOf({ kind: 'not-connected', message }, message)).toEqual({
      kind: 'not-connected',
    })
  })

  it('ignores transient failures and failures without a cause', () => {
    expect(blockedRunOf({ kind: 'timeout', message: 'slow' }, 'slow')).toBeUndefined()
    expect(blockedRunOf({ kind: 'network', message: 'offline' }, 'offline')).toBeUndefined()
    expect(blockedRunOf({ message: 'boom' }, 'boom')).toBeUndefined()
    expect(blockedRunOf(null, 'boom')).toBeUndefined()
  })

  it('ignores a cause that belongs to another failure', () => {
    // e.g. the document writer's stream failed earlier in the same run
    expect(
      blockedRunOf({ kind: 'signed-out', provider: 'codex', message: 'signed out' }, 'other error'),
    ).toBeUndefined()
  })
})

describe('"continue with" settings', () => {
  it('stores the provider as the selection and keeps its model', () => {
    const base = settings({ provider: 'claude-code' })
    base.providers.codex = { apiKey: '', model: 'gpt-5.5' }
    const next = withAiContinueProvider(base, 'codex')
    expect(next.provider).toBe('codex')
    expect(next.providers.codex?.model).toBe('gpt-5.5')
    // the input is not mutated
    expect(base.provider).toBe('claude-code')
  })

  it('leaves the model empty (the program default) when none was chosen', () => {
    const next = withAiContinueProvider(settings(), 'claude-code')
    expect(next.provider).toBe('claude-code')
    expect(next.providers['claude-code']?.model).toBe('')
  })
})

describe('readImageGenerationAvailable', () => {
  const capability = (available: boolean) =>
    ({ imageGeneration: { available, route: null, provider: null } }) as never

  it('is true only on a positive answer', async () => {
    await expect(readImageGenerationAvailable(async () => capability(true))).resolves.toBe(true)
    await expect(readImageGenerationAvailable(async () => capability(false))).resolves.toBe(false)
  })

  it('treats a missing handler, a failed call and a malformed answer as unavailable', async () => {
    const noHandler = vi.fn(async () => {
      throw new Error("No handler registered for 'ai:tool-capabilities'")
    })
    await expect(readImageGenerationAvailable(noHandler)).resolves.toBe(false)
    await expect(
      readImageGenerationAvailable(() => {
        throw new TypeError('aiToolCapabilities is not a function')
      }),
    ).resolves.toBe(false)
    await expect(readImageGenerationAvailable(async () => null)).resolves.toBe(false)
    await expect(readImageGenerationAvailable(async () => ({}) as never)).resolves.toBe(false)
  })
})

describe('subscription IPC answers', () => {
  it('fills in a provider whose entry is missing or malformed as checking', () => {
    expect(subscriptionStatusMapOf(undefined)).toEqual(checkingSubscriptionStatuses())
    const map = subscriptionStatusMapOf({
      'claude-code': { provider: 'claude-code', state: 'ready', planName: 'max' },
      codex: { state: 'nonsense' },
    })
    expect(map['claude-code']).toMatchObject({
      state: 'ready',
      planName: 'max',
      meteredAccepted: false,
    })
    expect(map.codex).toEqual({ provider: 'codex', state: 'checking', meteredAccepted: false })
  })

  it('drops the spawn error text from a launch result', () => {
    expect(subscriptionLaunchResultOf({ ok: true, error: 'x' })).toEqual({ ok: true })
    expect(
      subscriptionLaunchResultOf({
        ok: false,
        reason: 'unsupported',
        error: 'spawn C:\\Users\\me\\codex.exe ENOENT',
        installUrl: 'https://developers.openai.com/codex/cli',
      }),
    ).toEqual({
      ok: false,
      reason: 'unsupported',
      installUrl: 'https://developers.openai.com/codex/cli',
    })
    expect(subscriptionLaunchResultOf('garbage')).toEqual({ ok: false, reason: 'failed' })
  })
})
