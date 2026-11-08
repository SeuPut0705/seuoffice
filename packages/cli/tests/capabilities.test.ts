import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
  setCodexImageGenerationAvailable,
} from '@genoffice/ai-provider'
import {
  createMeteredAcceptanceFileStore,
  detectSubscriptionLogin,
  meteredLoginFingerprint,
  type SubscriptionDetection,
} from '@genoffice/ai-provider/subscription'
import * as aiSearch from '@genoffice/ai-search'
import { run, tempDir } from './helpers'

// capabilities asks the subscription CLIs for their status when a subscription could answer;
// the check is replaced so no test starts a real one
const fakes = vi.hoisted(() => ({ detect: vi.fn() }))

vi.mock('@genoffice/ai-provider/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider/subscription')>()),
  detectSubscriptionLogin: fakes.detect,
}))

const READY: Record<string, SubscriptionDetection> = {
  'claude-code': { provider: 'claude-code', state: 'ready', loginMethod: 'subscription' },
  codex: { provider: 'codex', state: 'ready', loginMethod: 'subscription' },
  // the terminal command has no ChatGPT connection of its own
  chatgpt: { provider: 'chatgpt', state: 'signed-out' },
}

const IMAGE_GENERATION_HINT =
  'Image generation is unavailable: add an image provider key under Settings > AI > Advanced. Use image search for imagery instead.'
const IMAGE_ANALYSIS_HINT =
  'Image analysis is unavailable: select an image analysis provider key under Settings > AI > Advanced. Command-line and integration requests use a subscription login only after that is turned on under Settings > AI > Advanced.'
const PDF_AI_READ_BLOCKED =
  'PDF AI page reading is unavailable: no AI provider can be used from the command line. Select a provider key under Settings > AI > Advanced, or turn on subscription use for command-line and integration requests there.'
const PDF_TRANSLATION_BLOCKED =
  'PDF translation is unavailable: no AI provider can be used from the command line. Select a provider key under Settings > AI > Advanced, or turn on subscription use for command-line and integration requests there.'
const VIDEO_ANALYSIS_HINT =
  'Video and audio analysis is unavailable: it needs a key provider that reads video (for example Gemini), selected as the video analysis provider under Settings > AI > Advanced.'

beforeEach(() => {
  expect(vi.isMockFunction(detectSubscriptionLogin)).toBe(true)
  fakes.detect.mockReset()
  fakes.detect.mockImplementation(async (provider: string) => READY[provider])
})
afterEach(() => {
  vi.restoreAllMocks()
  aiSearch.registerCodexImageGenerator(null)
  setCodexImageGenerationAvailable(false)
})

// a real settings file always carries the chat provider block; without it every section resets to defaults
function settingsFile(dir: string, settings: Record<string, unknown>): string {
  const path = join(dir, 'ai-settings.json')
  writeFileSync(path, JSON.stringify({ provider: 'auto', providers: {}, ...settings }))
  return path
}

/** the switch as the settings screen turns it on: with the consent of the current warning */
const ON = {
  headlessSubscriptionEnabled: true,
  headlessSubscriptionConsentVersion: HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
}

function envFor(settings: string, app = ''): NodeJS.ProcessEnv {
  return { ...process.env, GENOFFICE_AI_SETTINGS: settings, GENOFFICE_APP_BIN: app }
}

describe('genoffice capabilities', () => {
  it('pins the shape for a machine with nothing set: free search, the rest unavailable with its hint', async () => {
    const dir = tempDir()
    const settings = join(dir, 'missing.json')
    const r = await run(['capabilities', '--json'], { env: envFor(settings) })
    expect(r.code).toBe(0)
    expect(r.json()).toEqual({
      status: 'ok',
      command: 'capabilities',
      // a checkout finds its own development build; an installed command line may find no app
      summary: expect.stringMatching(
        /^available: search, image_search(, wasm)?(, app)?; unavailable: image_generation, image_analysis, video_analysis, pdf_ai_read, pdf_translation(, wasm)?(, app)?$/,
      ),
      detail: {
        search: { available: true, via: 'parallel', route: 'free' },
        image_search: { available: true, via: 'duckduckgo', route: 'free' },
        image_generation: {
          available: false,
          via: null,
          route: null,
          message: IMAGE_GENERATION_HINT,
        },
        media_analysis: { available: false, via: null, route: null, message: IMAGE_ANALYSIS_HINT },
        image_analysis: { available: false, via: null, route: null, message: IMAGE_ANALYSIS_HINT },
        video_analysis: { available: false, via: null, route: null, message: VIDEO_ANALYSIS_HINT },
        pdf_ai_read: { available: false, via: null, route: null, message: PDF_AI_READ_BLOCKED },
        pdf_translation: {
          available: false,
          via: null,
          route: null,
          message: PDF_TRANSLATION_BLOCKED,
        },
        automatic_calls: { subscription_enabled: false },
        app: { available: expect.any(Boolean) },
        // the machine's virtual-memory cap decides this, so the shape is pinned, not the value
        wasm: expect.objectContaining({ available: expect.any(Boolean) }),
        settings_path: settings,
      },
    })
    // the switch is off and no CLI is selected: nothing is asked of them
    expect(fakes.detect).not.toHaveBeenCalled()
  })

  it('answers with the text the tools themselves answer with', async () => {
    const dir = tempDir()
    const env = { ...envFor(join(dir, 'missing.json')), GENOFFICE_AUDIT_LOG: 'off' }
    const photo = join(dir, 'photo.png')
    writeFileSync(photo, 'not really a png')
    const caps = (await run(['capabilities', '--json'], { env })).json().detail
    const image = await run(['image', 'a cat', '--out', join(dir, 'cat.png'), '--json'], { env })
    expect(image.json().message).toBe(caps.image_generation.message)
    const media = await run(['media', photo, '--json'], { env })
    expect(media.json().message).toBe(caps.image_analysis.message)
  })

  it('reports key routes by provider', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'bin'))
    const settings = settingsFile(dir, {
      search: {
        provider: 'serper',
        providers: { serper: { apiKey: 'k' }, tavily: { apiKey: '' } },
      },
      media: {
        imageProvider: 'openai',
        analysisProvider: 'openai',
        videoAnalysisProvider: 'gemini',
        providers: {
          openai: { apiKey: 'sk', imageModel: 'gpt-image-1' },
          gemini: { apiKey: 'g' },
        },
      },
    })
    const r = await run(['capabilities', '--json'], {
      env: envFor(settings, join(dir, 'bin', 'app')),
    })
    expect(r.code).toBe(0)
    const d = r.json().detail
    expect(d.search).toEqual({ available: true, via: 'serper', route: 'key' })
    expect(d.image_search).toEqual({ available: true, via: 'serper', route: 'key' })
    expect(d.image_generation).toEqual({ available: true, via: 'openai', route: 'key' })
    expect(d.image_analysis).toEqual({ available: true, via: 'openai', route: 'key' })
    expect(d.media_analysis).toEqual(d.image_analysis)
    expect(d.video_analysis).toEqual({ available: true, via: 'gemini', route: 'key' })
    expect(d.app.available).toBe(true)
    expect(r.json().summary).toMatch(
      /^available: search, image_search, image_generation, image_analysis, video_analysis, (wasm, )?app; unavailable: pdf_ai_read, pdf_translation(, wasm)?$/,
    )
    expect(fakes.detect).not.toHaveBeenCalled()
  })

  it('counts a Serply key as search + image search', async () => {
    const settings = settingsFile(tempDir(), {
      search: { provider: 'serply', providers: { serply: { apiKey: 'k' } } },
    })
    const d = (await run(['capabilities', '--json'], { env: envFor(settings) })).json().detail
    expect(d.search).toEqual({ available: true, via: 'serply', route: 'key' })
    expect(d.image_search).toEqual({ available: true, via: 'serply', route: 'key' })
  })

  it.each(['tavily', 'parallel'])(
    '%s with a key answers web search, images stay on the free route',
    async (provider) => {
      const settings = settingsFile(tempDir(), {
        search: { provider, providers: { [provider]: { apiKey: 'test-key' } } },
      })
      const d = (await run(['capabilities', '--json'], { env: envFor(settings) })).json().detail
      expect(d.search).toEqual({ available: true, via: provider, route: 'key' })
      expect(d.image_search).toEqual({ available: true, via: 'duckduckgo', route: 'free' })
    },
  )

  it('falls back to media_analysis from video when only video analysis is set up', async () => {
    const settings = settingsFile(tempDir(), {
      media: { videoAnalysisProvider: 'gemini', providers: { gemini: { apiKey: 'g' } } },
    })
    const d = (await run(['capabilities', '--json'], { env: envFor(settings) })).json().detail
    expect(d.image_analysis.available).toBe(false)
    expect(d.video_analysis).toEqual({ available: true, via: 'gemini', route: 'key' })
    expect(d.media_analysis).toEqual(d.video_analysis)
  })

  it('reports the subscription routes and the count of automatic calls when the switch is on', async () => {
    setCodexImageGenerationAvailable(true)
    aiSearch.registerCodexImageGenerator(async () => ({ url: 'https://example.invalid/x.png' }))
    const dir = tempDir()
    const settings = settingsFile(dir, ON)
    const first = (await run(['capabilities', '--json'], { env: envFor(settings) })).json().detail
    expect(first.image_generation).toEqual({ available: true, via: 'codex', route: 'subscription' })
    expect(first.image_analysis).toEqual({
      available: true,
      via: 'claude-code',
      route: 'subscription',
    })
    expect(first.media_analysis).toEqual(first.image_analysis)
    expect(first.video_analysis.available).toBe(false)
    expect(first.pdf_ai_read).toEqual({
      available: true,
      via: 'claude-code',
      route: 'subscription',
    })
    expect(first.pdf_translation).toEqual(first.pdf_ai_read)
    // there is no hourly cap: the count is information, the limit and what remains are null
    expect(first.automatic_calls).toEqual({
      subscription_enabled: true,
      used: 0,
      limit: null,
      remaining: null,
    })
    // the ChatGPT check reads no program: it answers signed out at once here
    expect(fakes.detect.mock.calls.map((call) => call[0]).sort()).toEqual([
      'chatgpt',
      'claude-code',
      'codex',
    ])

    // past what used to be the hourly cap of 20
    for (let i = 0; i < 21; i++) {
      await aiSearch.runHeadlessSubscriptionCall(dir, async () => undefined)
    }
    const counted = (await run(['capabilities', '--json'], { env: envFor(settings) })).json().detail
    expect(counted.automatic_calls).toEqual({
      subscription_enabled: true,
      used: 21,
      limit: null,
      remaining: null,
    })
    expect('resetsAt' in counted.automatic_calls).toBe(false)
    expect(counted.image_analysis.available).toBe(true)
  })

  it('reads a switch turned on under the older warning as off, with no count', async () => {
    const dir = tempDir()
    const settings = settingsFile(dir, { headlessSubscriptionEnabled: true })
    await aiSearch.runHeadlessSubscriptionCall(dir, async () => undefined)
    const d = (await run(['capabilities', '--json'], { env: envFor(settings) })).json().detail
    expect(d.automatic_calls).toEqual({ subscription_enabled: false })
    expect(d.image_analysis).toMatchObject({ available: false, via: null, route: null })
    expect(d.image_analysis.message).toBe(IMAGE_ANALYSIS_HINT)
    expect(fakes.detect).not.toHaveBeenCalled()
  })

  it('reports a signed-out subscription as unavailable even with the switch on', async () => {
    fakes.detect.mockImplementation(async (provider: string) => ({ provider, state: 'signed-out' }))
    const settings = settingsFile(tempDir(), ON)
    const d = (await run(['capabilities', '--json'], { env: envFor(settings) })).json().detail
    expect(d.image_analysis).toMatchObject({ available: false, via: null, route: null })
    expect(d.image_analysis.message).toContain('no AI provider is connected')
    expect(d.automatic_calls.subscription_enabled).toBe(true)
  })

  it('says nothing of the account a CLI is signed in with, nor of its models', async () => {
    fakes.detect.mockImplementation(async (provider: string) => ({
      ...READY[provider]!,
      planName: 'max',
      account: 'jun.il@school.kr',
    }))
    const dir = tempDir()
    const settings = settingsFile(dir, ON)
    const audit = join(dir, 'audit.jsonl')
    for (const format of [['--json'], []]) {
      const r = await run(['capabilities', ...format], {
        env: { ...envFor(settings), GENOFFICE_AUDIT_LOG: audit },
      })
      expect(r.code).toBe(0)
      expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/school\.kr|jun\.il/)
    }
    const detail = (await run(['capabilities', '--json'], { env: envFor(settings) })).json().detail
    expect(detail.image_analysis).toEqual({
      available: true,
      via: 'claude-code',
      route: 'subscription',
    })
    expect(JSON.stringify(detail)).not.toMatch(/account|models/)
    expect(readFileSync(audit, 'utf8')).not.toMatch(/school\.kr|jun\.il/)
    expect(fakes.detect).toHaveBeenCalled()
  })

  it('makes no network call and starts no model: only the status check may run', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const analyze = vi.spyOn(aiSearch, 'analyzeMediaTool')
    const generate = vi.spyOn(aiSearch, 'generateImageTool')
    const web = vi.spyOn(aiSearch, 'webSearchTool')
    const settings = settingsFile(tempDir(), ON)
    expect((await run(['capabilities', '--json'], { env: envFor(settings) })).code).toBe(0)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(analyze).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
    expect(web).not.toHaveBeenCalled()
  })
})

describe('capabilities of the PDF document jobs', () => {
  it('reports the chat provider the jobs would use: a key, billed per request', async () => {
    const settings = settingsFile(tempDir(), {
      provider: 'anthropic',
      providers: { anthropic: { apiKey: 'sk', model: 'claude-sonnet-4-5' } },
    })
    const d = (await run(['capabilities', '--json'], { env: envFor(settings) })).json().detail
    expect(d.pdf_ai_read).toEqual({ available: true, via: 'anthropic', route: 'key' })
    expect(d.pdf_translation).toEqual({ available: true, via: 'anthropic', route: 'key' })
    expect(fakes.detect).not.toHaveBeenCalled()
  })

  it('marks an accepted metered login as metered, whatever the switch says', async () => {
    const metered: SubscriptionDetection = {
      provider: 'claude-code',
      state: 'metered',
      loginMethod: 'metered',
      loginKind: 'api_key/firstParty',
    }
    fakes.detect.mockResolvedValue(metered)
    const dir = tempDir()
    const settings = settingsFile(dir, {
      provider: 'claude-code',
      meteredAccepted: { 'claude-code': true },
    })
    // the acceptance as the app records it, beside the settings
    await createMeteredAcceptanceFileStore(dir).write({
      'claude-code': meteredLoginFingerprint(metered)!,
    })
    const d = (await run(['capabilities', '--json'], { env: envFor(settings) })).json().detail
    expect(d.pdf_ai_read).toEqual({
      available: true,
      via: 'claude-code',
      route: 'key',
      metered: true,
    })
    expect(d.pdf_translation).toEqual(d.pdf_ai_read)
  })

  it('leaves page reading out when the selected model cannot read images', async () => {
    const settings = settingsFile(tempDir(), {
      provider: 'deepseek',
      providers: { deepseek: { apiKey: 'sk', model: 'deepseek-v4-pro' } },
    })
    const d = (await run(['capabilities', '--json'], { env: envFor(settings) })).json().detail
    expect(d.pdf_ai_read).toMatchObject({ available: false, via: null, route: null })
    expect(d.pdf_ai_read.message).toContain('cannot read images')
    expect(d.pdf_translation).toEqual({ available: true, via: 'deepseek', route: 'key' })
  })
})
