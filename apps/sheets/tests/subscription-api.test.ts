import { describe, expect, it } from 'vitest'

import {
  checkingSubscriptionStatuses,
  isSubscriptionProviderId,
  subscriptionLaunchResultOf,
  subscriptionStatusMapOf,
} from '../src/shared/subscription-api'
import { IPC_CHANNELS } from '../src/shared/ipc-channels'

describe('subscriptionStatusMapOf', () => {
  it('reads a missing handler answer as both providers still checking', () => {
    expect(subscriptionStatusMapOf(undefined)).toEqual(checkingSubscriptionStatuses())
    expect(subscriptionStatusMapOf('nope')).toEqual(checkingSubscriptionStatuses())
  })

  it('keeps a well-formed status and fills the missing provider', () => {
    const map = subscriptionStatusMapOf({
      'claude-code': { provider: 'claude-code', state: 'ready', planName: 'max' },
    })
    expect(map['claude-code']).toMatchObject({ state: 'ready', planName: 'max' })
    expect(map['claude-code'].meteredAccepted).toBe(false)
    expect(map.codex.state).toBe('checking')
  })

  it('reads an unknown state as checking and a truthy acceptance as not accepted', () => {
    const map = subscriptionStatusMapOf({
      'claude-code': { state: 'connected' },
      codex: { state: 'metered', meteredAccepted: 'yes' },
    })
    expect(map['claude-code'].state).toBe('checking')
    expect(map.codex).toMatchObject({ provider: 'codex', state: 'metered', meteredAccepted: false })
  })
})

describe('subscriptionLaunchResultOf', () => {
  it('passes a started launch on', () => {
    expect(subscriptionLaunchResultOf({ ok: true })).toEqual({ ok: true })
  })

  it('leaves the spawn error text behind and keeps the reason and the install page', () => {
    expect(
      subscriptionLaunchResultOf({
        ok: false,
        reason: 'unsupported',
        error: 'spawn C:\\Users\\someone\\claude.exe ENOENT',
        installUrl: 'https://example.com/install',
      }),
    ).toEqual({ ok: false, reason: 'unsupported', installUrl: 'https://example.com/install' })
  })

  it('reads anything else as a plain failure', () => {
    expect(subscriptionLaunchResultOf(undefined)).toEqual({ ok: false, reason: 'failed' })
    expect(subscriptionLaunchResultOf({ ok: false, reason: 'whatever' })).toEqual({
      ok: false,
      reason: 'failed',
    })
  })
})

describe('isSubscriptionProviderId', () => {
  it('accepts the two subscription providers only', () => {
    expect(isSubscriptionProviderId('claude-code')).toBe(true)
    expect(isSubscriptionProviderId('codex')).toBe(true)
    expect(isSubscriptionProviderId('anthropic')).toBe(false)
    expect(isSubscriptionProviderId(undefined)).toBe(false)
  })
})

describe('sheets AI channels', () => {
  it('asks its own main process for the tool capabilities (answered in the shell too)', () => {
    expect(IPC_CHANNELS.aiToolCapabilities).toBe('sheets:ai-tool-capabilities')
  })
})
