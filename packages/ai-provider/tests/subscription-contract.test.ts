/**
 * The subscription contract: Claude Code joins the providers and the settings
 * carry the subscription values.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { sanitizeAiSettings } from '../src/ai-settings-guard'
import { chatForProvider } from '../src/chat'
import {
  AI_PROVIDERS,
  HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
  defaultAiSettings,
  resolveAiSettings,
} from '../src/providers'
import { AI_PROVIDER_ADAPTERS, getProviderAdapter } from '../src/registry'
import { AiRunError, aiStreamErrorFields } from '../src/run-error'
import { AiCreditsError } from '../src/stream'
import { AiTimeoutError } from '../src/watchdog'

describe('claude-code provider', () => {
  it('is a subscription provider on its own CLI bridge protocol', () => {
    const adapter = getProviderAdapter('claude-code')
    expect(adapter.meta.id).toBe('claude-code')
    expect(adapter.meta.label).toBe('Claude Code')
    expect(adapter.capabilities).toEqual({ auth: 'claude-subscription', vision: true })
    expect(adapter.resolveEndpoint({ apiKey: '', model: '' })).toEqual({
      protocol: 'claude-code-cli',
      baseUrl: '',
    })
  })

  it('sits next to Codex, ahead of the key providers', () => {
    const ids = AI_PROVIDERS.map((meta) => meta.id)
    expect(ids.slice(0, 4)).toEqual(['claude-code', 'chatgpt', 'codex', 'anthropic'])
    expect(Object.keys(AI_PROVIDER_ADAPTERS).sort()).toEqual([...ids].sort())
    expect(AI_PROVIDER_ADAPTERS.codex.capabilities.auth).toBe('codex-chatgpt')
    expect(AI_PROVIDER_ADAPTERS.anthropic.capabilities.auth).toBe('api-key')
  })

  it('gets a config slot that leaves the model to the CLI', () => {
    const config = defaultAiSettings().providers['claude-code']
    expect(config).toMatchObject({ apiKey: '', model: '' })
  })

  it('"auto" is a selection, not a provider to route to', async () => {
    expect(() => getProviderAdapter('auto')).toThrow('Unknown provider: auto')
    const reply = await chatForProvider('auto', { apiKey: '', model: '' }, 'sys', 'hi')
    expect(reply).toEqual({ ok: false, error: 'Unknown provider: auto' })
  })
})

describe('defaults', () => {
  it('new settings default to auto with the subscription settings off', () => {
    const settings = defaultAiSettings()
    expect(settings.provider).toBe('auto')
    expect(settings.meteredAccepted).toEqual({ 'claude-code': false, codex: false })
    expect(settings.headlessSubscriptionEnabled).toBe(false)
    expect(settings.subscriptionNoticeSeen).toBe(false)
  })

  it('resolveAiSettings carries the subscription settings from disk', () => {
    const stored = {
      provider: 'auto',
      providers: {},
      meteredAccepted: { codex: true, bogus: true, 'claude-code': 'yes' },
      headlessSubscriptionEnabled: true,
      headlessSubscriptionConsentVersion: HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
      subscriptionNoticeSeen: true,
    }
    const settings = resolveAiSettings(stored, defaultAiSettings())
    expect(settings.provider).toBe('auto')
    expect(settings.meteredAccepted).toEqual({ 'claude-code': false, codex: true })
    expect(settings.headlessSubscriptionEnabled).toBe(true)
    expect(settings.subscriptionNoticeSeen).toBe(true)
  })

  it('resolveAiSettings falls back to the defaults for files without them', () => {
    const settings = resolveAiSettings({ provider: 'codex', providers: {} }, defaultAiSettings())
    expect(settings.meteredAccepted).toEqual({ 'claude-code': false, codex: false })
    expect(settings.headlessSubscriptionEnabled).toBe(false)
    expect(settings.subscriptionNoticeSeen).toBe(false)
  })
})

describe('sanitizeAiSettings with the subscription settings', () => {
  const base = () => ({
    provider: 'auto',
    providers: { 'claude-code': { apiKey: '', model: 'sonnet' } },
  })

  it('accepts auto and claude-code as the selection', () => {
    expect(sanitizeAiSettings(base())?.provider).toBe('auto')
    const claude = sanitizeAiSettings({ ...base(), provider: 'claude-code' })
    expect(claude?.provider).toBe('claude-code')
    expect(claude?.providers['claude-code']).toEqual({ apiKey: '', model: 'sonnet' })
  })

  it('still rejects an unknown selection', () => {
    expect(sanitizeAiSettings({ ...base(), provider: 'vendor-from-the-future' })).toBeNull()
    expect(sanitizeAiSettings({ ...base(), provider: '' })).toBeNull()
  })

  it('persists the subscription settings instead of stripping them on save', () => {
    const sanitized = sanitizeAiSettings({
      ...base(),
      meteredAccepted: { 'claude-code': true, codex: false },
      headlessSubscriptionEnabled: true,
      subscriptionNoticeSeen: true,
    })
    expect(sanitized?.meteredAccepted).toEqual({ 'claude-code': true, codex: false })
    expect(sanitized?.headlessSubscriptionEnabled).toBe(true)
    expect(sanitized?.subscriptionNoticeSeen).toBe(true)
  })

  it('a renderer cannot plant acceptance under other keys or with non-boolean values', () => {
    const sanitized = sanitizeAiSettings({
      ...base(),
      meteredAccepted: { 'claude-code': 'true', codex: 1, anthropic: true },
      headlessSubscriptionEnabled: 'yes',
      subscriptionNoticeSeen: {},
    })
    expect(sanitized?.meteredAccepted).toEqual({})
    expect(sanitized && 'headlessSubscriptionEnabled' in sanitized).toBe(false)
    expect(sanitized && 'subscriptionNoticeSeen' in sanitized).toBe(false)
    expect(sanitizeAiSettings({ ...base(), meteredAccepted: 'all' })?.meteredAccepted).toBe(
      undefined,
    )
  })
})

describe('entry points for the modules later work fills in', () => {
  const packageDir = fileURLToPath(new URL('..', import.meta.url))
  const pkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    exports: Record<string, string>
  }

  it('are declared and point at existing files', () => {
    expect(pkg.exports['./subscription']).toBe('./src/subscription.ts')
    expect(pkg.exports['./claude-code-cli']).toBe('./src/claude-code-cli.ts')
    expect(pkg.exports['./codex-image']).toBe('./src/codex-image.ts')
    for (const target of Object.values(pkg.exports)) {
      expect(existsSync(join(packageDir, target))).toBe(true)
    }
  })

  it('resolve by package name', async () => {
    await expect(import('@genoffice/ai-provider/subscription')).resolves.toBeDefined()
    await expect(import('@genoffice/ai-provider/claude-code-cli')).resolves.toBeDefined()
    await expect(import('@genoffice/ai-provider/codex-image')).resolves.toBeDefined()
  })

  it('the root and browser entries expose the selection contract', async () => {
    const root = await import('@genoffice/ai-provider')
    const browser = await import('@genoffice/ai-provider/browser')
    for (const name of [
      'selectAiProvider',
      'normalizeAiSettings',
      'resolveImageBackend',
      'codexImageGenerationAvailable',
      'setCodexImageGenerationAvailable',
    ] as const) {
      expect(typeof root[name]).toBe('function')
      expect(browser[name]).toBe(root[name])
    }
    expect(typeof root.aiStreamErrorFields).toBe('function')
  })
})

describe('run errors', () => {
  it('an AiRunError carries its kind and accompanying values to the stream chunk', () => {
    const limit = new AiRunError('rate-limit', 'usage limit reached', {
      provider: 'claude-code',
      resetsAt: 1_791_879_000_000,
    })
    expect(limit).toBeInstanceOf(Error)
    expect(limit.name).toBe('AiRunError')
    expect(limit.message).toBe('usage limit reached')
    expect(aiStreamErrorFields(limit)).toEqual({
      errorCode: 'rate-limit',
      errorProvider: 'claude-code',
      errorResetsAt: 1_791_879_000_000,
    })
    expect(aiStreamErrorFields(new AiRunError('unsafe-tools', 'tools present'))).toEqual({
      errorCode: 'unsafe-tools',
    })
    expect(
      aiStreamErrorFields(new AiRunError('signed-out', 'login expired', { provider: 'codex' })),
    ).toEqual({ errorCode: 'signed-out', errorProvider: 'codex' })
  })

  it('maps the existing error classes to the codes the apps already send', () => {
    expect(aiStreamErrorFields(new AiTimeoutError(60_000))).toEqual({ errorCode: 'timeout' })
    expect(aiStreamErrorFields(new AiCreditsError('credits exhausted'))).toEqual({
      errorCode: 'credits',
    })
    expect(aiStreamErrorFields(new TypeError('fetch failed'))).toEqual({ errorCode: 'network' })
    expect(
      aiStreamErrorFields(new Error('HTTP 529: {"error":{"type":"overloaded_error"}}')),
    ).toEqual({ errorCode: 'overloaded' })
  })

  it('leaves an unclassified error without a code', () => {
    expect(aiStreamErrorFields(new Error('something else'))).toEqual({})
    expect(aiStreamErrorFields('a string')).toEqual({})
    expect(aiStreamErrorFields(undefined)).toEqual({})
  })
})
