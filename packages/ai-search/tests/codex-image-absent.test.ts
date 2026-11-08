/**
 * The package's main entry on its own registers no Codex image generator and
 * declares nothing available. The app's docs main registers the CLI generator
 * (`codex-image-cli.ts`) when it starts; a process that only loaded this package
 * — a test, a tool that imports the search helpers — keeps Codex off the image
 * route, so a stray registration is noticed here.
 */
import { describe, expect, it } from 'vitest'
import { codexImageGenerationAvailable, normalizeAiSettings } from '@genoffice/ai-provider'
import { aiToolCapabilities, codexImageGenerator, generateImageTool } from '../src/index'
import { keyMedia, status, writeSettings } from './routing-helpers'

const READY = { codex: status('codex', 'ready') }

describe('a process that loaded the main entry', () => {
  it('has no Codex image generator and no declared availability', () => {
    expect(codexImageGenerator()).toBeNull()
    expect(codexImageGenerationAvailable()).toBe(false)
  })

  it('reports image generation unavailable on a ready Codex subscription without a key', async () => {
    const patch = { media: { imageProvider: 'codex' } }
    const settings = normalizeAiSettings({ provider: 'auto', providers: {}, ...patch })
    const context = { path: 'screen' as const, statuses: READY }
    expect(aiToolCapabilities(settings, context).imageGeneration).toMatchObject({
      available: false,
      route: null,
      provider: null,
    })
    const r = await generateImageTool(writeSettings(patch), { prompt: 'a red apple' }, { context })
    expect(r.errorCode).toBe('unavailable')
    expect(r.url).toBeUndefined()
  })

  it('routes a selected Codex to the configured key provider', () => {
    const settings = normalizeAiSettings({
      provider: 'auto',
      providers: {},
      media: keyMedia({ imageProvider: 'codex' }, 'gemini'),
    })
    expect(
      aiToolCapabilities(settings, { path: 'screen', statuses: READY }).imageGeneration,
    ).toEqual({ available: true, route: 'key', provider: 'gemini' })
  })
})
