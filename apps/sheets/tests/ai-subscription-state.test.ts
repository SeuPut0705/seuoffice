import { describe, expect, it } from 'vitest'

import {
  normalizeAiSettings,
  selectAiProvider,
  type AiSettings,
  type AiSubscriptionStatus,
  type AiSubscriptionStatuses,
} from '@genoffice/ai-provider/browser'
import {
  aiHoldReason,
  aiSendGate,
  withAiContinueProvider,
  withAiSubscriptionNoticeSeen,
} from '@genoffice/ui'
import {
  aiBlockedRunOf,
  blockedRunSourceIndex,
  imageGenerationOffered,
} from '../src/renderer/ai/subscription-state'

function status(
  provider: AiSubscriptionStatus['provider'],
  state: AiSubscriptionStatus['state'],
  meteredAccepted = false,
): AiSubscriptionStatus {
  return { provider, state, meteredAccepted }
}

function settings(fields: Record<string, unknown> = {}): AiSettings {
  return normalizeAiSettings({ providers: {}, ...fields })
}

const CLAUDE_READY: AiSubscriptionStatuses = {
  'claude-code': status('claude-code', 'ready'),
  codex: status('codex', 'signed-out'),
}

// The gate itself is the one every editor shares (@genoffice/ui); these pin it on the
// settings and statuses the sheets panel hands it.
describe('the send gate', () => {
  const NOT_CONNECTED: AiSubscriptionStatuses = {
    'claude-code': status('claude-code', 'signed-out'),
    codex: status('codex', 'not-installed'),
  }

  it('holds a send until the settings are read', () => {
    const gate = aiSendGate(null, CLAUDE_READY)
    expect(gate).toEqual({ kind: 'checking' })
    expect(aiHoldReason(gate)).toBe('checking')
  })

  it('asks to connect while no subscription is ready, and nothing is sent', () => {
    const gate = aiSendGate(settings(), NOT_CONNECTED)
    expect(gate.kind).toBe('connect')
    if (gate.kind !== 'connect') return
    expect(gate.choice).toEqual(selectAiProvider(settings(), NOT_CONNECTED))
    expect(aiHoldReason(gate)).toBeNull()
  })

  it('holds a send while a status check that could still connect is running', () => {
    const statuses = {
      'claude-code': status('claude-code', 'checking'),
      codex: status('codex', 'not-installed'),
    }
    expect(aiSendGate(settings(), statuses).kind).toBe('checking')
    // a missing handler reads as checking
    expect(aiSendGate(settings(), {}).kind).toBe('checking')
  })

  it('asks to connect for a selected subscription that cannot run, naming that provider', () => {
    const gate = aiSendGate(settings({ provider: 'codex' }), CLAUDE_READY)
    expect(gate.kind).toBe('connect')
    if (gate.kind !== 'connect') return
    expect(gate.choice.provider).toBe('codex')
    expect(gate.choice.reason).toBe('signed-out')
  })

  it('asks to connect for automatic even when a key provider is filled in', () => {
    const gate = aiSendGate(
      settings({ providers: { anthropic: { apiKey: 'sk-test', model: 'claude-sonnet-4-5' } } }),
      NOT_CONNECTED,
    )
    expect(gate.kind).toBe('connect')
  })

  it('shows the first-connection notice before a subscription is used for the first time', () => {
    const gate = aiSendGate(settings(), CLAUDE_READY)
    expect(gate).toMatchObject({ kind: 'notice', provider: 'claude-code' })
    expect(aiHoldReason(gate)).toBe('notice')
  })

  it('runs once the notice was acknowledged', () => {
    const acknowledged = withAiSubscriptionNoticeSeen(settings())
    expect(acknowledged.subscriptionNoticeSeen).toBe(true)
    const gate = aiSendGate(acknowledged, CLAUDE_READY)
    expect(gate).toEqual({
      kind: 'run',
      choice: { connected: true, provider: 'claude-code', metered: false },
    })
  })

  it('shows no subscription notice for a key provider', () => {
    const gate = aiSendGate(
      settings({
        provider: 'anthropic',
        providers: { anthropic: { apiKey: 'sk-test', model: 'claude-sonnet-4-5' } },
      }),
      {},
    )
    expect(gate).toEqual({
      kind: 'run',
      choice: { connected: true, provider: 'anthropic', metered: false },
    })
  })

  it('marks an accepted metered login as costing money', () => {
    const gate = aiSendGate(
      settings({
        provider: 'codex',
        meteredAccepted: { codex: true },
        subscriptionNoticeSeen: true,
      }),
      { codex: status('codex', 'metered', true) },
    )
    expect(gate).toEqual({
      kind: 'run',
      choice: { connected: true, provider: 'codex', metered: true },
    })
  })
})

describe('aiBlockedRunOf', () => {
  it('keeps the kind, provider and reset time of a run its connection cannot carry on', () => {
    expect(
      aiBlockedRunOf(
        { kind: 'rate-limit', provider: 'claude-code', resetsAt: 1_800_000_000_000, message: 'x' },
        'x',
      ),
    ).toEqual({ kind: 'rate-limit', provider: 'claude-code', resetsAt: 1_800_000_000_000 })
  })

  it.each([
    'signed-out',
    'not-installed',
    'needs-update',
    'metered-not-accepted',
    'unsafe-tools',
    'not-connected',
  ] as const)('treats %s as blocked', (kind) => {
    expect(aiBlockedRunOf({ kind, message: 'm' }, 'm')).toEqual({ kind })
  })

  it.each(['timeout', 'network', 'overloaded', 'credits'] as const)(
    'keeps the plain error line for %s',
    (kind) => {
      expect(aiBlockedRunOf({ kind, message: 'm' }, 'm')).toBeUndefined()
    },
  )

  it('keeps the plain error line for a failure without a cause', () => {
    expect(aiBlockedRunOf({ message: 'boom' }, 'boom')).toBeUndefined()
    expect(aiBlockedRunOf(null, 'boom')).toBeUndefined()
  })

  it('ignores the record of an earlier turn when the run ended with another message', () => {
    expect(
      aiBlockedRunOf({ kind: 'rate-limit', provider: 'codex', message: 'limit' }, 'other failure'),
    ).toBeUndefined()
  })
})

describe('"continue with" settings', () => {
  it('stores the provider as the selection, on the model it last used', () => {
    const before = settings({
      provider: 'claude-code',
      providers: { codex: { apiKey: '', model: 'gpt-5-codex' } },
    })
    const after = withAiContinueProvider(before, 'codex')
    expect(after.provider).toBe('codex')
    expect(after.providers.codex.model).toBe('gpt-5-codex')
    expect(before.provider).toBe('claude-code')
    // the request that follows runs on it
    const choice = selectAiProvider(after, { codex: status('codex', 'ready') })
    expect(choice.connected && choice.provider).toBe('codex')
  })

  it('replaces automatic too, so the picker shows what the user chose', () => {
    expect(withAiContinueProvider(settings(), 'claude-code').provider).toBe('claude-code')
  })
})

describe('blockedRunSourceIndex', () => {
  const user = (undelivered?: boolean) => ({ role: 'user' as const, undelivered })
  const reply = { role: 'assistant' as const }

  it('finds the undelivered user message a blocked reply answers', () => {
    expect(blockedRunSourceIndex([user(), reply, user(true), reply], 3)).toBe(2)
  })

  it('reports nothing to rerun once that message was delivered or is gone', () => {
    expect(blockedRunSourceIndex([user(), reply], 1)).toBe(-1)
    expect(blockedRunSourceIndex([reply], 0)).toBe(-1)
    expect(blockedRunSourceIndex([], 4)).toBe(-1)
  })

  it('never reaches past the nearest user message', () => {
    expect(blockedRunSourceIndex([user(true), reply, user(), reply], 3)).toBe(-1)
  })
})

describe('imageGenerationOffered', () => {
  it('follows the image generation capability of the main process', () => {
    expect(imageGenerationOffered({ imageGeneration: { available: true } })).toBe(true)
    expect(imageGenerationOffered({ imageGeneration: { available: false } })).toBe(false)
  })

  it('offers nothing when the answer is missing or malformed', () => {
    expect(imageGenerationOffered(undefined)).toBe(false)
    expect(imageGenerationOffered(null)).toBe(false)
    expect(imageGenerationOffered({})).toBe(false)
    expect(imageGenerationOffered({ imageGeneration: { available: 'yes' } })).toBe(false)
  })
})
