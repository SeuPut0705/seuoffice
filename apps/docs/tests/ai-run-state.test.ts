// What the AI panel decides from the subscription contract: how a failed run
// is shown and which usage reports are kept; plus the shared send gate pinned on
// the settings and statuses the docs panel hands it (when the first connection
// notice is due, what "continue with ..." stores).
import { describe, expect, it } from 'vitest'
import {
  selectAiProvider,
  type AiSubscriptionState,
  type AiSubscriptionStatus,
  type AiSubscriptionStatuses,
} from '@genoffice/ai-provider/browser'
import { AI_PROVIDERS, type AiSettings } from '../src/shared/ipc'
import { aiSendGate, withAiContinueProvider } from '@genoffice/ui'
import {
  isBlockedRunCause,
  mergeSubscriptionUsage,
  runErrorCauseOf,
  shouldRecheckAfter,
} from '../src/renderer/ai/run-state'
import { subscriptionLaunchResultOf, subscriptionStatusMapOf } from '../src/shared/subscription-api'

function settings(patch: Partial<AiSettings> = {}): AiSettings {
  return {
    provider: 'auto',
    providers: Object.fromEntries(
      AI_PROVIDERS.map((p) => [p.id, { apiKey: '', model: p.defaultModel }]),
    ) as AiSettings['providers'],
    ...patch,
  }
}

function status(
  provider: 'claude-code' | 'codex',
  state: AiSubscriptionState,
  meteredAccepted = false,
): AiSubscriptionStatus {
  return { provider, state, meteredAccepted }
}

const CLAUDE_READY: AiSubscriptionStatuses = { 'claude-code': status('claude-code', 'ready') }
const CODEX_READY: AiSubscriptionStatuses = { codex: status('codex', 'ready') }

describe('runErrorCauseOf', () => {
  it('takes the cause of the failure the transport just reported', () => {
    expect(
      runErrorCauseOf(
        { kind: 'rate-limit', provider: 'codex', resetsAt: 99, message: 'limit' },
        'limit',
      ),
    ).toEqual({ kind: 'rate-limit', provider: 'codex', resetsAt: 99 })
  })

  it('has no cause for a failure without a kind or with another text', () => {
    expect(runErrorCauseOf({ message: 'HTTP 500' }, 'HTTP 500')).toBeUndefined()
    expect(runErrorCauseOf({ kind: 'signed-out', message: 'old' }, 'new')).toBeUndefined()
    expect(runErrorCauseOf(null, 'anything')).toBeUndefined()
  })
})

describe('isBlockedRunCause', () => {
  it('keeps the plain error line for a failure without a blocking cause', () => {
    expect(isBlockedRunCause(undefined)).toBe(false)
    expect(isBlockedRunCause({ kind: 'network' })).toBe(false)
    expect(isBlockedRunCause({ kind: 'timeout' })).toBe(false)
    expect(isBlockedRunCause({ kind: 'overloaded' })).toBe(false)
    expect(isBlockedRunCause({ kind: 'credits' })).toBe(false)
  })

  it('gives the blocked notice to every cause that means the connection cannot go on', () => {
    for (const kind of [
      'rate-limit',
      'signed-out',
      'not-installed',
      'needs-update',
      'metered-not-accepted',
      'unsafe-tools',
      'not-connected',
    ] as const) {
      expect(isBlockedRunCause({ kind, provider: 'claude-code' }), kind).toBe(true)
    }
  })
})

describe('shouldRecheckAfter', () => {
  it('looks again after a connection refusal, not after a limit or a transient failure', () => {
    expect(shouldRecheckAfter({ kind: 'signed-out', provider: 'codex' })).toBe(true)
    expect(shouldRecheckAfter({ kind: 'not-connected' })).toBe(true)
    expect(shouldRecheckAfter({ kind: 'rate-limit', provider: 'codex' })).toBe(false)
    expect(shouldRecheckAfter({ kind: 'network' })).toBe(false)
    expect(shouldRecheckAfter(undefined)).toBe(false)
  })
})

// The gate itself is the one every editor shares (@genoffice/ui).
describe('the first-connection notice', () => {
  const noticeDue = (stored: AiSettings, statuses: AiSubscriptionStatuses) =>
    aiSendGate(stored, statuses).kind === 'notice'
  const BOTH_ANSWERED_CLAUDE: AiSubscriptionStatuses = {
    ...CLAUDE_READY,
    codex: status('codex', 'signed-out'),
  }

  it('is due before the first run on a subscription', () => {
    expect(noticeDue(settings(), CLAUDE_READY)).toBe(true)
    expect(noticeDue(settings({ provider: 'codex' }), CODEX_READY)).toBe(true)
  })

  it('is not due once acknowledged', () => {
    expect(noticeDue(settings({ subscriptionNoticeSeen: true }), CLAUDE_READY)).toBe(false)
  })

  it('is not due while nothing is connected or a key provider is selected', () => {
    // still being checked: a request waits, no notice yet
    expect(aiSendGate(settings(), {}).kind).toBe('checking')
    expect(
      aiSendGate(settings(), {
        'claude-code': status('claude-code', 'signed-out'),
        codex: status('codex', 'not-installed'),
      }).kind,
    ).toBe('connect')
    const base = settings({ provider: 'openai' })
    const keyed = {
      ...base,
      providers: { ...base.providers, openai: { apiKey: 'sk-test', model: 'some-model' } },
    }
    expect(aiSendGate(keyed, BOTH_ANSWERED_CLAUDE).kind).toBe('run')
  })
})

describe('"continue with" settings', () => {
  it('stores the provider as the selection and keeps its stored model', () => {
    const base = settings({ provider: 'claude-code' })
    const next = withAiContinueProvider(
      { ...base, providers: { ...base.providers, codex: { apiKey: '', model: 'gpt-5.1-codex' } } },
      'codex',
    )
    expect(next.provider).toBe('codex')
    expect(next.providers.codex.model).toBe('gpt-5.1-codex')
    // the choice now resolves to that provider: the model picker shows it
    expect(selectAiProvider(next, CODEX_READY)).toMatchObject({
      connected: true,
      provider: 'codex',
    })
  })
})

describe('mergeSubscriptionUsage', () => {
  it('keeps the newest report per provider and window', () => {
    const merged = mergeSubscriptionUsage(
      [
        { provider: 'claude-code', window: 'five_hour', utilization: 0.5, resetsAt: 1 },
        { provider: 'claude-code', window: 'seven_day', utilization: 0.2, resetsAt: 2 },
      ],
      [{ provider: 'claude-code', window: 'five_hour', utilization: 0.9, resetsAt: 3 }],
    )
    expect(merged).toHaveLength(2)
    expect(merged.find((u) => u.window === 'five_hour')).toMatchObject({
      utilization: 0.9,
      resetsAt: 3,
    })
    expect(merged.find((u) => u.window === 'seven_day')?.utilization).toBe(0.2)
  })
})

describe('subscription IPC answers', () => {
  it('reads a missing or malformed answer as still checking', () => {
    const checking = { provider: 'claude-code', state: 'checking', meteredAccepted: false }
    expect(subscriptionStatusMapOf(undefined)['claude-code']).toEqual(checking)
    expect(subscriptionStatusMapOf({ 'claude-code': { state: 'bogus' } })['claude-code']).toEqual(
      checking,
    )
    expect(subscriptionStatusMapOf({}).codex.state).toBe('checking')
  })

  it('keeps a well-formed status and never trusts a non-boolean acceptance', () => {
    const map = subscriptionStatusMapOf({
      codex: { provider: 'codex', state: 'metered', meteredAccepted: 'yes', planName: 'plus' },
    })
    expect(map.codex).toMatchObject({ state: 'metered', meteredAccepted: false, planName: 'plus' })
  })

  it('drops the spawn error text of a failed launch', () => {
    expect(subscriptionLaunchResultOf({ ok: true })).toEqual({ ok: true })
    expect(
      subscriptionLaunchResultOf({ ok: false, reason: 'not-installed', error: 'C:\\x\\codex.exe' }),
    ).toEqual({ ok: false, reason: 'not-installed' })
    expect(subscriptionLaunchResultOf(null)).toEqual({ ok: false, reason: 'failed' })
  })
})
