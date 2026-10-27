import { describe, expect, it } from 'vitest'
import {
  defaultAiSettings,
  type AiSettings,
  type AiSubscriptionState,
  type AiSubscriptionStatus,
  type AiSubscriptionStatuses,
} from '@genoffice/ai-provider'
import { resolveNamingProvider } from '../src/main/ai-naming-provider'

/**
 * A naming request runs on the provider every other AI request would run on:
 * `auto` only on a ready subscription, a selected provider only when it can
 * run, and never a fallback to another one.
 */

function status(
  provider: 'claude-code' | 'codex',
  state: AiSubscriptionState,
): AiSubscriptionStatus {
  return { provider, state, meteredAccepted: false }
}

function settings(patch: Partial<AiSettings> = {}): AiSettings {
  return { ...defaultAiSettings(), ...patch }
}

const CLAUDE_READY: AiSubscriptionStatuses = {
  'claude-code': status('claude-code', 'ready'),
  codex: status('codex', 'signed-out'),
}

describe('resolveNamingProvider', () => {
  it('declines when the settings file could not be read at all', () => {
    expect(resolveNamingProvider(null, CLAUDE_READY)).toBeNull()
  })

  it('runs auto on the ready subscription', () => {
    expect(resolveNamingProvider(settings(), CLAUDE_READY)?.provider).toBe('claude-code')
  })

  it('declines auto when no subscription is ready, instead of picking a paid provider', () => {
    const stored = settings({
      providers: { ...defaultAiSettings().providers, anthropic: { apiKey: 'sk-ant', model: 'm' } },
    })
    expect(resolveNamingProvider(stored, {})).toBeNull()
  })

  it('honors a configured key provider the reader selected', () => {
    const resolved = resolveNamingProvider(
      settings({
        provider: 'anthropic',
        providers: {
          ...defaultAiSettings().providers,
          anthropic: { apiKey: 'sk-ant', model: 'claude-sonnet-4-6' },
        },
      }),
      CLAUDE_READY,
    )
    expect(resolved?.provider).toBe('anthropic')
    expect(resolved?.config.apiKey).toBe('sk-ant')
    expect(resolved?.config.model).toBe('claude-sonnet-4-6')
  })

  it('declines a half-filled selected provider rather than falling back', () => {
    const resolved = resolveNamingProvider(
      settings({
        provider: 'anthropic',
        providers: { ...defaultAiSettings().providers, anthropic: { apiKey: 'sk-ant', model: '' } },
      }),
      CLAUDE_READY,
    )
    expect(resolved).toBeNull()
  })

  it('declines a selected subscription that is signed out', () => {
    expect(resolveNamingProvider(settings({ provider: 'codex' }), CLAUDE_READY)).toBeNull()
  })
})
