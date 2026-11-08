/**
 * The automatic-call switch is only on when the user agreed to the warning of
 * the current version. Users who turned it on under the hourly-capped version
 * agreed to less, so their switch reads as off until they agree again.
 */
import { describe, expect, it } from 'vitest'
import { sanitizeAiSettings } from '../src/ai-settings-guard'
import { normalizeAiSettings } from '../src/legacy-settings'
import {
  HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
  defaultAiSettings,
  resolveAiSettings,
} from '../src/providers'

const file = (patch: Record<string, unknown> = {}) => ({
  provider: 'auto',
  providers: {},
  ...patch,
})

describe('the consent version of the automatic-call switch', () => {
  it('is a version above the hourly-capped switch, which stored none', () => {
    expect(HEADLESS_SUBSCRIPTION_CONSENT_VERSION).toBeGreaterThanOrEqual(2)
    expect(defaultAiSettings().headlessSubscriptionEnabled).toBe(false)
    expect(defaultAiSettings().headlessSubscriptionConsentVersion).toBe(0)
  })

  it('reads an old settings file (switch on, no consent version) as off', () => {
    const stored = file({ headlessSubscriptionEnabled: true })
    expect(resolveAiSettings(stored, defaultAiSettings()).headlessSubscriptionEnabled).toBe(false)
    const normalized = normalizeAiSettings(stored)
    expect(normalized.headlessSubscriptionEnabled).toBe(false)
    expect(normalized.headlessSubscriptionConsentVersion).toBe(0)
  })

  it('reads the switch as off when the consent is of an older version', () => {
    for (const version of [0, 1, HEADLESS_SUBSCRIPTION_CONSENT_VERSION - 1]) {
      const stored = file({
        headlessSubscriptionEnabled: true,
        headlessSubscriptionConsentVersion: version,
      })
      expect(normalizeAiSettings(stored).headlessSubscriptionEnabled).toBe(false)
    }
  })

  it('ignores a consent version that is not a whole number', () => {
    for (const version of ['2', 2.5, -1, null, {}, Number.NaN, Number.POSITIVE_INFINITY]) {
      const normalized = normalizeAiSettings(
        file({ headlessSubscriptionEnabled: true, headlessSubscriptionConsentVersion: version }),
      )
      expect(normalized.headlessSubscriptionEnabled).toBe(false)
      expect(normalized.headlessSubscriptionConsentVersion).toBe(0)
    }
  })

  it('keeps the switch on with the current consent, and across a second read', () => {
    const stored = file({
      headlessSubscriptionEnabled: true,
      headlessSubscriptionConsentVersion: HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
    })
    const once = normalizeAiSettings(stored)
    expect(once.headlessSubscriptionEnabled).toBe(true)
    expect(once.headlessSubscriptionConsentVersion).toBe(HEADLESS_SUBSCRIPTION_CONSENT_VERSION)
    const twice = normalizeAiSettings(JSON.parse(JSON.stringify(once)))
    expect(twice.headlessSubscriptionEnabled).toBe(true)
    expect(twice.headlessSubscriptionConsentVersion).toBe(HEADLESS_SUBSCRIPTION_CONSENT_VERSION)
  })

  it('keeps the consent when the switch is turned off, so the record of it stays', () => {
    const normalized = normalizeAiSettings(
      file({
        headlessSubscriptionEnabled: false,
        headlessSubscriptionConsentVersion: HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
      }),
    )
    expect(normalized.headlessSubscriptionEnabled).toBe(false)
    expect(normalized.headlessSubscriptionConsentVersion).toBe(
      HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
    )
  })

  it('is written through the save guard, and only as a whole number', () => {
    const saved = sanitizeAiSettings(
      file({
        headlessSubscriptionEnabled: true,
        headlessSubscriptionConsentVersion: HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
      }),
    )
    expect(saved?.headlessSubscriptionConsentVersion).toBe(HEADLESS_SUBSCRIPTION_CONSENT_VERSION)
    expect(normalizeAiSettings(saved).headlessSubscriptionEnabled).toBe(true)
    for (const version of ['2', 1.5, -3, null]) {
      const dropped = sanitizeAiSettings(file({ headlessSubscriptionConsentVersion: version }))
      expect(dropped && 'headlessSubscriptionConsentVersion' in dropped).toBe(false)
    }
  })
})
