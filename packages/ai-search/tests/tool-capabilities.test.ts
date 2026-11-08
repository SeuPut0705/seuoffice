import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
  defaultAiSettings,
  normalizeAiSettings,
  setCodexImageGenerationAvailable,
  type AiSettings,
  type AiSubscriptionStatuses,
} from '@genoffice/ai-provider'
import { registerCodexImageGenerator } from '../src/codex-image-generator'
import { aiToolCapabilities } from '../src/tool-capabilities'
import type { AiToolCallContext } from '../src/tool-routing'
import { keyMedia, status } from './routing-helpers'

const READY: AiSubscriptionStatuses = {
  'claude-code': status('claude-code', 'ready'),
  codex: status('codex', 'ready'),
}

/** settings as loaded from a file holding `patch` */
function settings(patch: Record<string, unknown> = {}): AiSettings {
  return normalizeAiSettings({ provider: 'auto', providers: {}, ...patch })
}

const off = { available: false, route: null, provider: null }

beforeEach(() => {
  setCodexImageGenerationAvailable(true)
  registerCodexImageGenerator(async () => ({ url: 'https://images.example.com/a.png' }))
})

afterEach(() => {
  setCodexImageGenerationAvailable(false)
  registerCodexImageGenerator(null)
})

describe('aiToolCapabilities', () => {
  it('has only the free search routes on a fresh install, for a caller without statuses', () => {
    for (const input of [settings(), defaultAiSettings(), null, undefined]) {
      const c = aiToolCapabilities(input)
      expect(c.webSearch).toEqual({ available: true, route: 'free', provider: 'parallel' })
      expect(c.imageSearch).toEqual({ available: true, route: 'free', provider: 'duckduckgo' })
      expect(c.imageGeneration).toMatchObject(off)
      expect(c.imageAnalysis).toMatchObject(off)
      expect(c.videoAnalysis).toMatchObject(off)
      for (const capability of [c.imageGeneration, c.imageAnalysis, c.videoAnalysis]) {
        expect(capability.message).toMatch(/Settings/)
      }
    }
  })

  it('reports the subscription routes on the screen path once both logins are ready', () => {
    const c = aiToolCapabilities(settings(), { path: 'screen', statuses: READY })
    expect(c.imageGeneration).toEqual({ available: true, route: 'subscription', provider: 'codex' })
    expect(c.imageAnalysis).toEqual({
      available: true,
      route: 'subscription',
      provider: 'claude-code',
    })
    expect(c.videoAnalysis).toMatchObject(off)
  })

  it('reports key routes where the user filled in and selected a key', () => {
    const c = aiToolCapabilities(
      settings({
        search: { provider: 'serper', providers: { serper: { apiKey: 'k' } } },
        media: keyMedia(
          { imageProvider: 'openai', analysisProvider: 'openai', videoAnalysisProvider: 'gemini' },
          'openai',
          'gemini',
        ),
      }),
      { path: 'screen', statuses: READY },
    )
    expect(c.webSearch).toEqual({ available: true, route: 'key', provider: 'serper' })
    expect(c.imageSearch).toEqual({ available: true, route: 'key', provider: 'serper' })
    expect(c.imageGeneration).toEqual({ available: true, route: 'key', provider: 'openai' })
    expect(c.imageAnalysis).toEqual({ available: true, route: 'key', provider: 'openai' })
    expect(c.videoAnalysis).toEqual({ available: true, route: 'key', provider: 'gemini' })
  })

  it('tells a search key without an image endpoint from one with', () => {
    const tavily = aiToolCapabilities(
      settings({ search: { provider: 'tavily', providers: { tavily: { apiKey: 't' } } } }),
    )
    expect(tavily.webSearch).toEqual({ available: true, route: 'key', provider: 'tavily' })
    expect(tavily.imageSearch).toEqual({ available: true, route: 'free', provider: 'duckduckgo' })
    const paidParallel = aiToolCapabilities(
      settings({ search: { provider: 'parallel', providers: { parallel: { apiKey: 'p' } } } }),
    )
    expect(paidParallel.webSearch).toEqual({ available: true, route: 'key', provider: 'parallel' })
    // a selected key provider with no key is the free route again
    const empty = aiToolCapabilities(
      settings({ search: { provider: 'serper', providers: { serper: { apiKey: '' } } } }),
    )
    expect(empty.webSearch).toEqual({ available: true, route: 'free', provider: 'parallel' })
  })

  it('reports the key the image request would fall to when Codex cannot run', () => {
    const c = aiToolCapabilities(
      settings({ media: keyMedia({ imageProvider: 'codex' }, 'gemini') }),
      { path: 'screen', statuses: { codex: status('codex', 'signed-out') } },
    )
    expect(c.imageGeneration).toEqual({ available: true, route: 'key', provider: 'gemini' })
  })

  it('hides the Codex image route in a process with no generator registered', () => {
    registerCodexImageGenerator(null)
    const c = aiToolCapabilities(settings(), { path: 'screen', statuses: READY })
    expect(c.imageGeneration).toMatchObject(off)
  })

  describe('on the automatic-call path', () => {
    const dataDir = 'unused-by-a-pure-function'
    const headless = (statuses: AiSubscriptionStatuses = READY): AiToolCallContext => ({
      path: 'headless',
      statuses,
      dataDir,
    })

    it('hides the subscription routes while the setting is off and says where it is', () => {
      const c = aiToolCapabilities(settings(), headless())
      expect(c.imageGeneration).toMatchObject(off)
      expect(c.imageAnalysis).toMatchObject(off)
      expect(c.imageGeneration.message).toMatch(/Settings > AI > Advanced/)
      expect(c.imageAnalysis.message).toMatch(/Settings > AI > Advanced/)
      expect(c.webSearch.available).toBe(true)
    })

    it('keeps the key routes while the setting is off', () => {
      const c = aiToolCapabilities(
        settings({
          media: keyMedia({ imageProvider: 'codex', analysisProvider: 'gemini' }, 'gemini'),
        }),
        headless(),
      )
      expect(c.imageGeneration).toEqual({ available: true, route: 'key', provider: 'gemini' })
      expect(c.imageAnalysis).toEqual({ available: true, route: 'key', provider: 'gemini' })
    })

    it('reports the subscription routes once the setting is on', () => {
      const c = aiToolCapabilities(
        settings({
          headlessSubscriptionEnabled: true,
          headlessSubscriptionConsentVersion: HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
        }),
        headless(),
      )
      expect(c.imageGeneration).toEqual({
        available: true,
        route: 'subscription',
        provider: 'codex',
      })
      expect(c.imageAnalysis).toEqual({
        available: true,
        route: 'subscription',
        provider: 'claude-code',
      })
    })

    it('reports an accepted metered login the user selected as a key route, setting on or off', () => {
      const metered = status('codex', 'metered', { loginMethod: 'metered', meteredAccepted: true })
      for (const headlessSubscriptionEnabled of [false, true]) {
        const c = aiToolCapabilities(
          settings({
            provider: 'codex',
            meteredAccepted: { codex: true },
            headlessSubscriptionEnabled,
            headlessSubscriptionConsentVersion: HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
          }),
          headless({ codex: metered }),
        )
        expect(c.imageAnalysis).toEqual({
          available: true,
          route: 'key',
          provider: 'codex',
          metered: true,
        })
        expect(c.imageGeneration).toMatchObject(off)
      }
    })
  })

  it('reports a key chat provider the user selected as the image analysis route', () => {
    const c = aiToolCapabilities(
      settings({
        provider: 'anthropic',
        providers: { anthropic: { apiKey: 'sk-ant', model: 'claude-sonnet-4-5' } },
      }),
    )
    expect(c.imageAnalysis).toEqual({ available: true, route: 'key', provider: 'anthropic' })
  })
})
