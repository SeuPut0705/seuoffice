import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@genoffice/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider')>()),
  analyzeMediaWithProvider: vi.fn(),
  generateImageWithProvider: vi.fn(),
  streamForProvider: vi.fn(),
}))

import {
  HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
  analyzeMediaWithProvider,
  generateImageWithProvider,
  setCodexImageGenerationAvailable,
  streamForProvider,
  type AiSubscriptionStatuses,
} from '@genoffice/ai-provider'
import { registerCodexImageGenerator, type CodexImageGenerator } from '../src/codex-image-generator'
import { HEADLESS_LEDGER_FILE, HEADLESS_LOCK_FILE } from '../src/headless-ledger'
import { analyzeMediaTool, generateImageTool } from '../src/media-tools'
import type { AiToolCallContext } from '../src/tool-routing'
import { dataUrl, keyMedia, status, tempDir, writeSettings } from './routing-helpers'

const keyGen = vi.mocked(generateImageWithProvider)
const keyAnalyze = vi.mocked(analyzeMediaWithProvider)
const stream = vi.mocked(streamForProvider)
const codexGen = vi.fn<CodexImageGenerator>()

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3])
const READY: AiSubscriptionStatuses = {
  'claude-code': status('claude-code', 'ready'),
  codex: status('codex', 'ready'),
}
/** the switch as the settings screen turns it on: with the consent of the current warning */
const ON = {
  headlessSubscriptionEnabled: true,
  headlessSubscriptionConsentVersion: HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
}
/** the hourly cap there used to be; requests past it must run all the same */
const OLD_HOURLY_CAP = 20
const image = { mediaUrls: [dataUrl(8)], requirements: 'describe' }

let dataDir: string
const headless = (statuses: AiSubscriptionStatuses = READY): AiToolCallContext => ({
  path: 'headless',
  statuses,
  dataDir,
})
const ledgerPath = () => join(dataDir, HEADLESS_LEDGER_FILE)
const ledgerRuns = (): number[] =>
  existsSync(ledgerPath())
    ? (JSON.parse(readFileSync(ledgerPath(), 'utf-8')) as { runs: number[] }).runs
    : []
/** a ledger that already holds what used to be this hour's whole allowance */
function fillLedger(): number {
  const oldest = Date.now() - 10 * 60_000
  const runs = Array.from({ length: OLD_HOURLY_CAP }, (_, i) => oldest + i)
  writeFileSync(ledgerPath(), JSON.stringify({ version: 1, runs }))
  return oldest
}

beforeEach(() => {
  dataDir = tempDir('genoffice-headless-')
  keyGen.mockReset()
  keyAnalyze.mockReset()
  stream.mockReset()
  codexGen.mockReset()
  keyGen.mockResolvedValue({ bytes: PNG, mime: 'image/png' })
  codexGen.mockResolvedValue({ bytes: PNG, mime: 'image/png' })
  keyAnalyze.mockResolvedValue('from the key provider')
  stream.mockImplementation(async (_provider, _config, _system, _messages, _tools, _max, cb) => {
    cb.onDelta('from the AI provider')
  })
  setCodexImageGenerationAvailable(true)
  registerCodexImageGenerator(codexGen)
})

afterEach(() => {
  setCodexImageGenerationAvailable(false)
  registerCodexImageGenerator(null)
})

describe('automatic-call path with the subscription setting off (the default)', () => {
  it('generates no image on the subscription and says where the setting is', async () => {
    const r = await generateImageTool(
      writeSettings(),
      { prompt: 'a logo' },
      { context: headless() },
    )
    expect(r.url).toBeUndefined()
    expect(r.errorCode).toBe('unavailable')
    expect(r.error).toMatch(/Settings > AI > Advanced/)
    expect(r.error).toMatch(/command-line/i)
    expect(codexGen).not.toHaveBeenCalled()
    expect(ledgerRuns()).toEqual([])
  })

  it('still generates through a filled-in key provider', async () => {
    const settings = writeSettings({ media: keyMedia({ imageProvider: 'codex' }, 'openai') })
    const r = await generateImageTool(settings, { prompt: 'a logo' }, { context: headless() })
    expect(r.url).toMatch(/^file:/)
    expect(keyGen.mock.calls[0]![0]).toBe('openai')
    expect(codexGen).not.toHaveBeenCalled()
  })

  it('shows no image to a subscription provider and says where the setting is', async () => {
    for (const provider of ['auto', 'claude-code', 'codex']) {
      const r = await analyzeMediaTool(writeSettings({ provider }), image, { context: headless() })
      expect(r.text).toBeUndefined()
      expect(r.errorCode).toBe('unavailable')
      expect(r.error).toMatch(/Settings > AI > Advanced/)
    }
    expect(stream).not.toHaveBeenCalled()
  })

  it('still analyzes through a key analysis provider, or a key chat provider the user selected', async () => {
    const keyAnalysis = writeSettings({ media: keyMedia({ analysisProvider: 'gemini' }, 'gemini') })
    expect(await analyzeMediaTool(keyAnalysis, image, { context: headless() })).toEqual({
      text: 'from the key provider',
    })
    const keyChat = writeSettings({
      provider: 'anthropic',
      providers: { anthropic: { apiKey: 'sk-ant', model: 'claude-sonnet-4-5' } },
    })
    expect(await analyzeMediaTool(keyChat, image, { context: headless() })).toEqual({
      text: 'from the AI provider',
    })
    expect(stream.mock.calls[0]![0]).toBe('anthropic')
    expect(ledgerRuns()).toEqual([])
  })
})

describe('automatic-call path with the subscription setting on', () => {
  it('generates through Codex and records the request', async () => {
    const before = Date.now()
    const r = await generateImageTool(
      writeSettings(ON),
      { prompt: 'a logo' },
      { context: headless() },
    )
    expect(r.url).toMatch(/^file:/)
    expect(codexGen).toHaveBeenCalledTimes(1)
    const runs = ledgerRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]).toBeGreaterThanOrEqual(before)
    expect(existsSync(join(dataDir, HEADLESS_LOCK_FILE))).toBe(false)
  })

  it('shows the image to the subscription provider and records the request', async () => {
    const r = await analyzeMediaTool(writeSettings(ON), image, { context: headless() })
    expect(r).toEqual({ text: 'from the AI provider' })
    expect(stream.mock.calls[0]![0]).toBe('claude-code')
    expect(ledgerRuns()).toHaveLength(1)
  })

  it('runs concurrent subscription requests one after another', async () => {
    let running = 0
    let peak = 0
    const slow = async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 20))
      running--
    }
    codexGen.mockImplementation(async () => {
      await slow()
      return { bytes: PNG, mime: 'image/png' }
    })
    stream.mockImplementation(async (_p, _c, _s, _m, _t, _max, cb) => {
      await slow()
      cb.onDelta('seen')
    })
    const settings = writeSettings(ON)
    const results = await Promise.all([
      generateImageTool(settings, { prompt: 'one' }, { context: headless() }),
      analyzeMediaTool(settings, image, { context: headless() }),
      generateImageTool(settings, { prompt: 'two' }, { context: headless() }),
    ])
    expect(results.every((r) => !r.error)).toBe(true)
    expect(peak).toBe(1)
    expect(ledgerRuns()).toHaveLength(3)
  })

  it('runs past what used to be the hourly limit', async () => {
    fillLedger()
    const settings = writeSettings(ON)
    const generated = await generateImageTool(
      settings,
      { prompt: 'a logo' },
      { context: headless() },
    )
    expect(generated.url).toMatch(/^file:/)
    expect(generated.errorCode).toBeUndefined()
    expect(generated.resetsAt).toBeUndefined()
    const analyzed = await analyzeMediaTool(settings, image, { context: headless() })
    expect(analyzed).toEqual({ text: 'from the AI provider' })
    expect(codexGen).toHaveBeenCalledTimes(1)
    expect(stream).toHaveBeenCalledTimes(1)
    expect(ledgerRuns()).toHaveLength(OLD_HOURLY_CAP + 2)
  })

  it('runs past a damaged ledger and starts the count over', async () => {
    writeFileSync(ledgerPath(), '{"version":1,"runs":[18')
    const settings = writeSettings(ON)
    const generated = await generateImageTool(
      settings,
      { prompt: 'a logo' },
      { context: headless() },
    )
    expect(generated.url).toMatch(/^file:/)
    expect(generated.errorCode).toBeUndefined()
    const analyzed = await analyzeMediaTool(settings, image, { context: headless() })
    expect(analyzed).toEqual({ text: 'from the AI provider' })
    expect(codexGen).toHaveBeenCalledTimes(1)
    expect(stream).toHaveBeenCalledTimes(1)
    expect(ledgerRuns()).toHaveLength(2)
  })

  it('stays on the subscription it chose, past what used to be the limit', async () => {
    fillLedger()
    const settings = writeSettings({
      ...ON,
      media: keyMedia({ imageProvider: 'codex' }, 'openai'),
    })
    const r = await generateImageTool(settings, { prompt: 'a logo' }, { context: headless() })
    expect(r.url).toMatch(/^file:/)
    expect(codexGen).toHaveBeenCalledTimes(1)
    expect(keyGen).not.toHaveBeenCalled()
  })

  it('reads a switch turned on under the older warning as off', async () => {
    const old = writeSettings({ headlessSubscriptionEnabled: true })
    const generated = await generateImageTool(old, { prompt: 'a logo' }, { context: headless() })
    expect(generated.errorCode).toBe('unavailable')
    expect(generated.error).toMatch(/Settings > AI > Advanced/)
    const analyzed = await analyzeMediaTool(old, image, { context: headless() })
    expect(analyzed.errorCode).toBe('unavailable')
    expect(codexGen).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    expect(ledgerRuns()).toEqual([])
  })

  it('leaves key routes out of the count and the queue', async () => {
    fillLedger()
    const settings = writeSettings({
      ...ON,
      media: keyMedia({ imageProvider: 'openai', analysisProvider: 'openai' }, 'openai'),
    })
    const generated = await generateImageTool(
      settings,
      { prompt: 'a logo' },
      { context: headless() },
    )
    expect(generated.url).toMatch(/^file:/)
    expect(await analyzeMediaTool(settings, image, { context: headless() })).toEqual({
      text: 'from the key provider',
    })
    expect(ledgerRuns()).toHaveLength(OLD_HOURLY_CAP)
  })

  it('counts a request that ends in an error', async () => {
    codexGen.mockRejectedValueOnce(new Error('codex crashed'))
    const r = await generateImageTool(
      writeSettings(ON),
      { prompt: 'a logo' },
      { context: headless() },
    )
    expect(r.error).toBe('codex crashed')
    expect(ledgerRuns()).toHaveLength(1)
  })

  it('uses no subscription when the caller gave no place for the ledger', async () => {
    const context: AiToolCallContext = { path: 'headless', statuses: READY }
    const r = await generateImageTool(writeSettings(ON), { prompt: 'a logo' }, { context })
    expect(r.errorCode).toBe('unavailable')
    expect(codexGen).not.toHaveBeenCalled()
    const analyzed = await analyzeMediaTool(writeSettings(ON), image, { context })
    expect(analyzed.errorCode).toBe('unavailable')
    expect(stream).not.toHaveBeenCalled()
  })
})

describe('an accepted metered login on the automatic-call path', () => {
  const metered = status('codex', 'metered', { loginMethod: 'metered', meteredAccepted: true })
  const selected = { provider: 'codex', meteredAccepted: { codex: true } }

  it('analyzes images like a key provider: setting off, no count', async () => {
    const r = await analyzeMediaTool(writeSettings(selected), image, {
      context: headless({ codex: metered }),
    })
    expect(r).toEqual({ text: 'from the AI provider' })
    expect(stream.mock.calls[0]![0]).toBe('codex')
    expect(ledgerRuns()).toEqual([])
  })

  it('is not counted, and not held back', async () => {
    fillLedger()
    const r = await analyzeMediaTool(writeSettings({ ...selected, ...ON }), image, {
      context: headless({ codex: metered }),
    })
    expect(r).toEqual({ text: 'from the AI provider' })
    expect(ledgerRuns()).toHaveLength(OLD_HOURLY_CAP)
  })

  it('is not picked by `auto`, and not used without the acceptance', async () => {
    const auto = await analyzeMediaTool(
      writeSettings({ provider: 'auto', meteredAccepted: { codex: true }, ...ON }),
      image,
      { context: headless({ codex: metered }) },
    )
    expect(auto.errorCode).toBe('unavailable')
    const notAccepted = await analyzeMediaTool(writeSettings({ provider: 'codex', ...ON }), image, {
      context: headless({ codex: status('codex', 'metered', { loginMethod: 'metered' }) }),
    })
    expect(notAccepted.errorCode).toBe('unavailable')
    expect(stream).not.toHaveBeenCalled()
  })

  it('never generates an image, with the setting on or off', async () => {
    for (const toggle of [{}, ON]) {
      const r = await generateImageTool(
        writeSettings({ ...selected, ...toggle }),
        { prompt: 'a logo' },
        { context: headless({ codex: metered }) },
      )
      expect(r.errorCode).toBe('unavailable')
    }
    expect(codexGen).not.toHaveBeenCalled()
  })
})

describe('screen path', () => {
  it('applies neither the setting nor the count', async () => {
    fillLedger()
    const context: AiToolCallContext = { path: 'screen', statuses: READY, dataDir }
    const generated = await generateImageTool(writeSettings(), { prompt: 'a logo' }, { context })
    expect(generated.url).toMatch(/^file:/)
    expect(codexGen).toHaveBeenCalledTimes(1)
    expect(await analyzeMediaTool(writeSettings(), image, { context })).toEqual({
      text: 'from the AI provider',
    })
    expect(ledgerRuns()).toHaveLength(OLD_HOURLY_CAP)
  })
})
