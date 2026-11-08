/**
 * Which backend a generate_image request starts on. The selected backend runs
 * when it can; otherwise the other kind takes over (Codex subscription <-> a
 * key provider). Codex only ever generates on a subscription login: a metered
 * Codex would bill per image, and paying for images is what the key providers
 * are for.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  codexImageGenerationAvailable,
  configuredImageKeyProviders,
  imageProviderSelection,
  resolveImageBackend,
  setCodexImageGenerationAvailable,
} from '../src/image-backend'
import { defaultAiMediaSettings } from '../src/media'
import type {
  AiImageProviderSelection,
  AiMediaKeyProviderId,
  AiSettings,
  AiSubscriptionState,
  AiSubscriptionStatus,
} from '../src/types'

afterEach(() => setCodexImageGenerationAvailable(false))

function codex(state: AiSubscriptionState, meteredAccepted = false): AiSubscriptionStatus {
  return { provider: 'codex', state, meteredAccepted }
}

function settingsWith(
  imageProvider: AiImageProviderSelection,
  keys: Partial<Record<AiMediaKeyProviderId, string>> = {},
): Pick<AiSettings, 'media'> {
  const media = defaultAiMediaSettings()
  media.imageProvider = imageProvider
  for (const [id, apiKey] of Object.entries(keys)) {
    media.providers[id as AiMediaKeyProviderId] = {
      ...media.providers[id as AiMediaKeyProviderId],
      apiKey,
    }
  }
  return { media }
}

const available = { codexImageAvailable: true }

describe('codex image generation availability', () => {
  it('is off until a backend registers itself', () => {
    expect(codexImageGenerationAvailable()).toBe(false)
    setCodexImageGenerationAvailable(true)
    expect(codexImageGenerationAvailable()).toBe(true)
    setCodexImageGenerationAvailable(false)
    expect(codexImageGenerationAvailable()).toBe(false)
  })

  it('feeds resolveImageBackend when the caller does not say', () => {
    const settings = settingsWith('codex')
    expect(resolveImageBackend(settings, { codex: codex('ready') })).toEqual({ kind: 'none' })
    setCodexImageGenerationAvailable(true)
    expect(resolveImageBackend(settings, { codex: codex('ready') })).toEqual({ kind: 'codex' })
  })
})

describe('resolveImageBackend', () => {
  it('uses the selected Codex subscription when Codex is ready', () => {
    expect(
      resolveImageBackend(settingsWith('codex', { openai: 'sk-live' }), {
        ...available,
        codex: codex('ready'),
      }),
    ).toEqual({ kind: 'codex' })
  })

  it('falls back from an unusable Codex to a configured key provider', () => {
    for (const state of ['checking', 'not-installed', 'signed-out', 'error'] as const) {
      const backend = resolveImageBackend(settingsWith('codex', { gemini: 'AIza-live' }), {
        ...available,
        codex: codex(state),
      })
      expect(backend).toMatchObject({ kind: 'key', provider: 'gemini' })
    }
    expect(
      resolveImageBackend(settingsWith('codex', { gemini: 'AIza-live' }), available),
    ).toMatchObject({ kind: 'key', provider: 'gemini' })
  })

  it('never generates on a metered Codex, accepted or not', () => {
    for (const acceptedFlag of [false, true]) {
      const context = { ...available, codex: codex('metered', acceptedFlag) }
      expect(resolveImageBackend(settingsWith('codex'), context)).toEqual({ kind: 'none' })
      expect(
        resolveImageBackend(settingsWith('codex', { openai: 'sk-live' }), context),
      ).toMatchObject({ kind: 'key', provider: 'openai' })
      expect(resolveImageBackend(settingsWith('openai'), context)).toEqual({ kind: 'none' })
    }
  })

  it('uses the selected key provider and returns its config', () => {
    const settings = settingsWith('gemini', { openai: 'sk-live', gemini: 'AIza-live' })
    expect(resolveImageBackend(settings, { ...available, codex: codex('ready') })).toEqual({
      kind: 'key',
      provider: 'gemini',
      config: settings.media!.providers.gemini,
    })
  })

  it('falls back from an unusable key provider to a ready Codex', () => {
    expect(
      resolveImageBackend(settingsWith('openai'), { ...available, codex: codex('ready') }),
    ).toEqual({ kind: 'codex' })
    expect(
      resolveImageBackend(settingsWith('openai', { openai: '   ' }), {
        ...available,
        codex: codex('ready'),
      }),
    ).toEqual({ kind: 'codex' })
  })

  it('an unusable key provider with no Codex still reaches another configured key provider', () => {
    expect(
      resolveImageBackend(settingsWith('openai', { xai: 'xai-live' }), {
        ...available,
        codex: codex('signed-out'),
      }),
    ).toMatchObject({ kind: 'key', provider: 'xai' })
  })

  it('picks the first configured key provider in catalog order', () => {
    const settings = settingsWith('codex', { xai: 'xai-live', gemini: 'AIza-live', glm: 'k.v' })
    expect(configuredImageKeyProviders(settings)).toEqual(['gemini', 'glm', 'xai'])
    expect(resolveImageBackend(settings, {})).toMatchObject({ kind: 'key', provider: 'gemini' })
  })

  it('skips key providers that cannot generate images or have no model', () => {
    const settings = settingsWith('codex', { deepseek: 'sk-live' })
    settings.media!.providers.custom = {
      apiKey: '',
      baseUrl: 'http://localhost:8000/v1',
      imageModel: '',
      analysisModel: '',
    }
    expect(configuredImageKeyProviders(settings)).toEqual([])
    expect(resolveImageBackend(settings, {})).toEqual({ kind: 'none' })
    settings.media!.providers.custom.imageModel = 'sdxl'
    expect(resolveImageBackend(settings, {})).toMatchObject({ kind: 'key', provider: 'custom' })
  })

  it('"none" means no preference: Codex when it can, else the first key provider', () => {
    const settings = settingsWith('none', { openai: 'sk-live' })
    expect(resolveImageBackend(settings, {})).toMatchObject({ kind: 'key', provider: 'openai' })
    expect(resolveImageBackend(settings, { ...available, codex: codex('ready') })).toEqual({
      kind: 'codex',
    })
    expect(resolveImageBackend(settingsWith('none'), {})).toEqual({ kind: 'none' })
  })

  it('treats Codex as absent in a build without Codex image generation', () => {
    expect(resolveImageBackend(settingsWith('codex'), { codex: codex('ready') })).toEqual({
      kind: 'none',
    })
    expect(
      resolveImageBackend(settingsWith('codex', { openai: 'sk-live' }), { codex: codex('ready') }),
    ).toMatchObject({ kind: 'key', provider: 'openai' })
  })

  it('reports nothing usable when neither kind is available', () => {
    expect(resolveImageBackend(settingsWith('codex'), available)).toEqual({ kind: 'none' })
    expect(resolveImageBackend({ media: undefined }, available)).toEqual({ kind: 'none' })
    expect(resolveImageBackend(null, available)).toEqual({ kind: 'none' })
  })

  it('reads a removed or unknown stored selection as the default', () => {
    for (const stored of ['retired-backend', 'no-such-backend', 7, null]) {
      const settings = settingsWith('codex', { openai: 'sk-live' })
      ;(settings.media as { imageProvider: unknown }).imageProvider = stored
      expect(resolveImageBackend(settings, { ...available, codex: codex('ready') })).toEqual({
        kind: 'codex',
      })
      expect(resolveImageBackend(settings, {})).toMatchObject({ kind: 'key', provider: 'openai' })
    }
  })
})

describe('imageProviderSelection', () => {
  it('shows "none" instead of Codex in a build without Codex image generation', () => {
    expect(imageProviderSelection(settingsWith('codex'))).toBe('none')
    expect(imageProviderSelection(settingsWith('codex'), true)).toBe('codex')
    setCodexImageGenerationAvailable(true)
    expect(imageProviderSelection(settingsWith('codex'))).toBe('codex')
  })

  it('keeps a key provider or an explicit "none"', () => {
    expect(imageProviderSelection(settingsWith('gemini'), true)).toBe('gemini')
    expect(imageProviderSelection(settingsWith('none'), true)).toBe('none')
  })

  it('reads a removed, unknown or image-less stored id as the default', () => {
    for (const stored of ['retired-backend', 'deepseek', 'nope', undefined]) {
      const settings = settingsWith('codex')
      ;(settings.media as { imageProvider: unknown }).imageProvider = stored
      expect(imageProviderSelection(settings, true)).toBe('codex')
      expect(imageProviderSelection(settings, false)).toBe('none')
    }
    expect(imageProviderSelection({ media: undefined }, true)).toBe('codex')
  })
})
