import { describe, expect, it } from 'vitest'
import {
  AI_SUBSCRIPTION_NOTICE_VERSION,
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

/** The first-connection notice, acknowledged in its current wording */
const NOTICE_SEEN = {
  subscriptionNoticeSeen: true,
  subscriptionNoticeVersion: AI_SUBSCRIPTION_NOTICE_VERSION,
}

describe('resolveNamingProvider', () => {
  // the file as every other AI path reads it: what it does not say is the default
  it('reads a settings file without a selection as the default one', () => {
    const stored = { providers: {}, ...NOTICE_SEEN }
    expect(resolveNamingProvider(stored, CLAUDE_READY)?.provider).toBe('claude-code')
  })

  it('reads a selection this build no longer has as the default one', () => {
    const stored = { provider: 'a-provider-of-an-older-build', providers: {}, ...NOTICE_SEEN }
    expect(resolveNamingProvider(stored, CLAUDE_READY)?.provider).toBe('claude-code')
  })

  it('declines a settings file that could not be read when no subscription is ready', () => {
    expect(resolveNamingProvider(null, {})).toBeNull()
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
