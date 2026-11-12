import { describe, expect, it } from 'vitest'
import {
  AI_SUBSCRIPTION_NOTICE_VERSION,
  defaultAiSettings,
  type AiSettings,
  type AiSubscriptionState,
  type AiSubscriptionStatus,
  type AiSubscriptionStatuses,
} from '@seuoffice/ai-provider'
import { resolveNamingProvider } from '../src/main/ai-naming-provider'

/**
 * A naming request runs on the provider every other AI request would run on:
 * `auto` only on a ready subscription, a selected provider only when it can
 * run, and never a fallback to another one. A subscription is used only after
 * the first-connection notice was acknowledged in its current wording.
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

/** no provider to name: nothing is connected at all */
const NOT_CONNECTED = { ok: false, reason: 'not-connected', errorKind: 'not-connected' }
const NOTICE_FIRST = { ok: false, reason: 'notice' }

describe('resolveNamingProvider', () => {
  // the file as every other AI path reads it: what it does not say is the default
  it('reads a settings file without a selection as the default one', () => {
    const stored = { providers: {}, ...NOTICE_SEEN }
    expect(resolveNamingProvider(stored, CLAUDE_READY)).toMatchObject({
      ok: true,
      provider: 'claude-code',
    })
  })

  it('reads a selection this build no longer has as the default one', () => {
    const stored = { provider: 'a-provider-of-an-older-build', providers: {}, ...NOTICE_SEEN }
    expect(resolveNamingProvider(stored, CLAUDE_READY)).toMatchObject({
      ok: true,
      provider: 'claude-code',
    })
  })

  it('declines a settings file that could not be read when no subscription is ready', () => {
    expect(resolveNamingProvider(null, {})).toEqual(NOT_CONNECTED)
  })

  it('runs auto on the ready subscription once its notice was acknowledged', () => {
    expect(resolveNamingProvider(settings(NOTICE_SEEN), CLAUDE_READY)).toMatchObject({
      ok: true,
      provider: 'claude-code',
    })
  })

  it('holds a ready subscription back until the first-connection notice was acknowledged', () => {
    // default settings, a settings file that could not be read, no file at all
    for (const stored of [settings(), null, {}]) {
      expect(resolveNamingProvider(stored, CLAUDE_READY)).toEqual(NOTICE_FIRST)
    }
  })

  it('holds a selected subscription back the same way', () => {
    expect(resolveNamingProvider(settings({ provider: 'claude-code' }), CLAUDE_READY)).toEqual(
      NOTICE_FIRST,
    )
  })

  it('holds a subscription back when only an earlier wording of the notice was acknowledged', () => {
    const earlier = { subscriptionNoticeSeen: true, subscriptionNoticeVersion: 1 }
    expect(resolveNamingProvider(settings(earlier), CLAUDE_READY)).toEqual(NOTICE_FIRST)
    // a file from before the notice had versions: the flag alone is the first wording
    const unversioned = { provider: 'auto', providers: {}, subscriptionNoticeSeen: true }
    expect(resolveNamingProvider(unversioned, CLAUDE_READY)).toEqual(NOTICE_FIRST)
  })

  it('declines auto when no subscription is ready, instead of picking a paid provider', () => {
    const stored = settings({
      providers: { ...defaultAiSettings().providers, anthropic: { apiKey: 'sk-ant', model: 'm' } },
    })
    expect(resolveNamingProvider(stored, {})).toEqual(NOT_CONNECTED)
  })

  // a key provider is not a subscription: the notice is not about it
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
    expect(resolved).toMatchObject({
      ok: true,
      provider: 'anthropic',
      config: { apiKey: 'sk-ant', model: 'claude-sonnet-4-6' },
    })
  })

  it('declines a half-filled selected provider rather than falling back', () => {
    const resolved = resolveNamingProvider(
      settings({
        provider: 'anthropic',
        providers: { ...defaultAiSettings().providers, anthropic: { apiKey: 'sk-ant', model: '' } },
      }),
      CLAUDE_READY,
    )
    expect(resolved).toEqual({ ...NOT_CONNECTED, provider: 'anthropic' })
  })

  it('declines a selected subscription that is signed out, and says which one', () => {
    expect(
      resolveNamingProvider(settings({ provider: 'codex', ...NOTICE_SEEN }), CLAUDE_READY),
    ).toEqual({ ok: false, reason: 'not-connected', errorKind: 'signed-out', provider: 'codex' })
  })
})
