/**
 * The AI panel's state rules of the subscription contract, as pure functions:
 * what stands between the user and a run, what a failed run says about its
 * connection, and which tools have a route.
 */
import { describe, it, expect } from 'vitest'
import {
  normalizeAiSettings,
  type AiSettings,
  type AiSubscriptionState,
  type AiSubscriptionStatuses,
} from '@genoffice/ai-provider/browser'
import {
  aiConnectPromptChoice,
  aiSendGate,
  withAiContinueProvider,
  withAiSubscriptionNoticeSeen,
} from '@genoffice/ui'
import { blockedRunOf, toolGatesOf } from '../src/renderer/ai/subscription'
import { settingsSupportVision } from '../src/renderer/ai/slide-qc'
import {
  checkingSubscriptionStatuses,
  subscriptionLaunchResultOf,
  subscriptionStatusMapOf,
} from '../src/shared/subscription-api'
import type { AiToolCapabilities } from '../src/shared/ipc'

const statuses = (
  claude: AiSubscriptionState,
  codex: AiSubscriptionState,
): AiSubscriptionStatuses => ({
  'claude-code': { provider: 'claude-code', state: claude, meteredAccepted: false },
  codex: { provider: 'codex', state: codex, meteredAccepted: false },
})

const settingsWith = (patch: Partial<AiSettings> = {}): AiSettings => ({
  ...normalizeAiSettings({}),
  ...patch,
})

const withAnthropicKey = (settings: AiSettings): AiSettings => ({
  ...settings,
  providers: { ...settings.providers, anthropic: { apiKey: 'sk-test', model: 'claude-test' } },
})

// The gate itself is the one every editor shares (@genoffice/ui); these pin it on the
// settings and statuses the slides panel hands it.
describe('the gate in front of a run', () => {
  it('nothing connected → the connect prompt, with the choice it is built from', () => {
    const gate = aiSendGate(settingsWith(), statuses('not-installed', 'signed-out'))
    expect(gate.kind).toBe('connect')
    expect(gate).toMatchObject({ choice: { connected: false, reason: 'no-subscription' } })
  })

  it('a key provider alone never satisfies auto (it must be selected by the user)', () => {
    const settings = withAnthropicKey(settingsWith())
    expect(aiSendGate(settings, statuses('signed-out', 'signed-out')).kind).toBe('connect')
    expect(aiSendGate({ ...settings, provider: 'anthropic' }, {})).toMatchObject({
      kind: 'run',
      choice: { provider: 'anthropic' },
    })
  })

  it('a subscription about to be used for the first time shows the notice once', () => {
    const fresh = settingsWith()
    expect(aiSendGate(fresh, statuses('ready', 'ready'))).toMatchObject({
      kind: 'notice',
      provider: 'claude-code',
    })
    expect(aiSendGate(fresh, statuses('signed-out', 'ready'))).toMatchObject({
      kind: 'notice',
      provider: 'codex',
    })
    const seen = withAiSubscriptionNoticeSeen(fresh)
    expect(seen.subscriptionNoticeSeen).toBe(true)
    expect(fresh.subscriptionNoticeSeen).toBe(false)
    expect(aiSendGate(seen, statuses('ready', 'ready'))).toMatchObject({
      kind: 'run',
      choice: { provider: 'claude-code' },
    })
  })

  it('a selected provider that cannot run is never replaced by one that could', () => {
    const gate = aiSendGate(settingsWith({ provider: 'codex' }), statuses('ready', 'signed-out'))
    expect(gate).toMatchObject({
      kind: 'connect',
      choice: { connected: false, provider: 'codex', reason: 'signed-out' },
    })
  })

  it('a status check still running is neither "run" nor "connect": a request waits for it', () => {
    expect(aiSendGate(settingsWith(), checkingSubscriptionStatuses()).kind).toBe('checking')
  })
})

describe('when the connect prompt is on screen', () => {
  const settings = settingsWith()

  it('stays hidden while the first status check is still running', () => {
    const gate = aiSendGate(settings, checkingSubscriptionStatuses())
    expect(aiConnectPromptChoice(gate, false)).toBeNull()
    // unless a request is waiting for the answer
    expect(aiConnectPromptChoice(gate, true)).not.toBeNull()
  })

  it('shows once the check answered that nothing is connected', () => {
    const gate = aiSendGate(settings, statuses('not-installed', 'signed-out'))
    expect(aiConnectPromptChoice(gate, false)).not.toBeNull()
  })

  it('shows for an unfinished key provider whatever the status check is doing', () => {
    const gate = aiSendGate(settingsWith({ provider: 'anthropic' }), checkingSubscriptionStatuses())
    expect(aiConnectPromptChoice(gate, false)).toMatchObject({ reason: 'not-configured' })
  })

  it('is never shown while a provider can run', () => {
    const gate = aiSendGate(settings, statuses('ready', 'ready'))
    expect(aiConnectPromptChoice(gate, true)).toBeNull()
  })
})

describe('a run that stopped because its connection cannot go on', () => {
  it('keeps the kind, provider and reset time of a blocked run', () => {
    expect(
      blockedRunOf({ kind: 'rate-limit', provider: 'claude-code', resetsAt: 99, message: 'm' }),
    ).toEqual({ kind: 'rate-limit', provider: 'claude-code', resetsAt: 99 })
    expect(blockedRunOf({ kind: 'signed-out', provider: 'codex', message: 'm' })).toEqual({
      kind: 'signed-out',
      provider: 'codex',
    })
    expect(blockedRunOf({ kind: 'not-connected', message: 'm' })).toEqual({ kind: 'not-connected' })
  })

  it('leaves transient and uncoded failures to the plain error line', () => {
    for (const kind of ['timeout', 'network', 'overloaded', 'credits'] as const) {
      expect(blockedRunOf({ kind, message: 'm' })).toBeNull()
    }
    expect(blockedRunOf({ message: 'model not found' })).toBeNull()
    expect(blockedRunOf(null)).toBeNull()
  })

  it('"continue with" stores that provider as the selection and keeps its model', () => {
    const before = settingsWith({ provider: 'claude-code' })
    before.providers.codex = { ...before.providers.codex, model: 'codex-test-model' }
    const after = withAiContinueProvider(before, 'codex')
    expect(after.provider).toBe('codex')
    expect(after.providers.codex.model).toBe('codex-test-model')
    expect(before.provider).toBe('claude-code')
    // the gate follows the new selection at once
    expect(
      aiSendGate(withAiSubscriptionNoticeSeen(after), statuses('signed-out', 'ready')),
    ).toMatchObject({ kind: 'run', choice: { provider: 'codex' } })
  })
})

describe('tool gates from the main process report', () => {
  const capability = (available: boolean) => ({
    available,
    route: available ? ('key' as const) : null,
    provider: available ? 'x' : null,
  })
  const report = (image: boolean, analysis: boolean, video: boolean): AiToolCapabilities => ({
    webSearch: capability(true),
    imageSearch: capability(true),
    imageGeneration: capability(image),
    imageAnalysis: capability(analysis),
    videoAnalysis: capability(video),
  })

  it('offers nothing before the report arrived', () => {
    expect(toolGatesOf(null)).toEqual({ imageGeneration: false, mediaAnalysis: false })
  })

  it('follows the report: image generation, and media analysis by either kind', () => {
    expect(toolGatesOf(report(true, false, false))).toEqual({
      imageGeneration: true,
      mediaAnalysis: false,
    })
    expect(toolGatesOf(report(false, true, false)).mediaAnalysis).toBe(true)
    expect(toolGatesOf(report(false, false, true)).mediaAnalysis).toBe(true)
  })
})

describe('screenshots under the automatic selection', () => {
  it('auto is judged by the subscription it resolves to', () => {
    const settings = settingsWith()
    expect(settingsSupportVision(settings, statuses('ready', 'signed-out'))).toBe(true)
    expect(settingsSupportVision(settings, statuses('signed-out', 'ready'))).toBe(true)
  })

  it('auto with nothing connected sends no picture (there is no provider to send it to)', () => {
    expect(settingsSupportVision(settingsWith(), statuses('signed-out', 'not-installed'))).toBe(
      false,
    )
    expect(settingsSupportVision(settingsWith())).toBe(false)
  })
})

describe('bridge answers', () => {
  it('a missing or malformed status reads as checking', () => {
    expect(subscriptionStatusMapOf(undefined)).toEqual(checkingSubscriptionStatuses())
    const partial = subscriptionStatusMapOf({
      codex: { provider: 'codex', state: 'ready', meteredAccepted: 'yes', planName: 'plus' },
      'claude-code': { state: 'no-such-state' },
    })
    expect(partial.codex).toMatchObject({
      state: 'ready',
      meteredAccepted: false,
      planName: 'plus',
    })
    expect(partial['claude-code'].state).toBe('checking')
  })

  it('a launch failure never carries the spawn error text', () => {
    expect(subscriptionLaunchResultOf({ ok: true, error: 'x' })).toEqual({ ok: true })
    expect(
      subscriptionLaunchResultOf({
        ok: false,
        reason: 'unsupported',
        error: 'C:/secret/path/tool.exe failed',
        installUrl: 'https://example.com/install',
      }),
    ).toEqual({ ok: false, reason: 'unsupported', installUrl: 'https://example.com/install' })
    expect(subscriptionLaunchResultOf('garbage')).toEqual({ ok: false, reason: 'failed' })
  })
})
