import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
import { defaultRegistry } from '../src/cli'
import { createContext, disposeContext, runWithInline } from '../src/mcp/run'
import { buildArgv, resolveTools, TOOLS } from '../src/mcp/tools'
import { run, tempDir } from './helpers'

// The search / image / media commands are the automatic-call path. Nothing here may reach a
// vendor CLI or the network: the status check and the key providers are replaced, and every test
// that could land on a subscription login replaces the tool or the image generator as well.
const fakes = vi.hoisted(() => ({
  detect: vi.fn(),
  generateWithKey: vi.fn(),
  analyzeWithKey: vi.fn(),
}))

vi.mock('@genoffice/ai-provider/subscription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider/subscription')>()),
  detectSubscriptionLogin: fakes.detect,
}))

vi.mock('@genoffice/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider')>()),
  generateImageWithProvider: fakes.generateWithKey,
  analyzeMediaWithProvider: fakes.analyzeWithKey,
}))

/** the switch as the settings screen turns it on: with the consent of the current warning */
const ON = {
  headlessSubscriptionEnabled: true,
  headlessSubscriptionConsentVersion: HEADLESS_SUBSCRIPTION_CONSENT_VERSION,
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const READY: Record<string, SubscriptionDetection> = {
  'claude-code': { provider: 'claude-code', state: 'ready', loginMethod: 'subscription' },
  codex: { provider: 'codex', state: 'ready', loginMethod: 'subscription' },
  // the terminal command has no ChatGPT connection of its own
  chatgpt: { provider: 'chatgpt', state: 'signed-out' },
}

const METERED_CLAUDE: SubscriptionDetection = {
  provider: 'claude-code',
  state: 'metered',
  loginMethod: 'metered',
  loginKind: 'api_key/firstParty',
}

const KEY_IMAGE = {
  imageProvider: 'openai',
  providers: { openai: { apiKey: 'sk-test', imageModel: 'gpt-image-1' } },
}

/** A data folder as the app keeps it: ai-settings.json plus whatever the tools put next to it. */
function dataFolder(settings: Record<string, unknown> = {}): {
  dir: string
  env: NodeJS.ProcessEnv
} {
  const dir = tempDir()
  writeFileSync(
    join(dir, 'ai-settings.json'),
    JSON.stringify({ provider: 'auto', providers: {}, ...settings }),
  )
  return {
    dir,
    env: {
      ...process.env,
      GENOFFICE_USER_DATA: dir,
      GENOFFICE_AI_SETTINGS: '',
      GENOFFICE_AUDIT_LOG: 'off',
      GENOFFICE_ALLOWED_ROOTS: '',
    },
  }
}

function photo(): string {
  const path = join(tempDir(), 'photo.png')
  writeFileSync(path, PNG)
  return path
}

beforeEach(() => {
  // the replacement must be in force before any command runs, or a test would start a real CLI
  expect(vi.isMockFunction(detectSubscriptionLogin)).toBe(true)
  fakes.detect.mockReset()
  fakes.detect.mockImplementation(async (provider: string) => READY[provider])
  fakes.generateWithKey.mockReset()
  fakes.generateWithKey.mockResolvedValue({ bytes: new Uint8Array(PNG), mime: 'image/png' })
  fakes.analyzeWithKey.mockReset()
  fakes.analyzeWithKey.mockResolvedValue('A single dark pixel.')
})

afterEach(() => {
  vi.restoreAllMocks()
  aiSearch.registerCodexImageGenerator(null)
  setCodexImageGenerationAvailable(false)
})

describe('image on the automatic-call path', () => {
  it('answers unavailable, with where to configure it, when the switch is off and no key is set', async () => {
    const { env, dir } = dataFolder()
    const r = await run(['image', 'a cat', '--out', join(dir, 'cat.png'), '--json'], { env })
    expect(r.code).toBe(4)
    const error = r.json()
    expect(Object.keys(error).sort()).toEqual(
      ['code', 'command', 'detail', 'error', 'message', 'status', 'suggestion'].sort(),
    )
    expect(error.status).toBe('error')
    expect(error.error).toBe('app_unavailable')
    expect(error.detail).toEqual({ errorCode: 'unavailable' })
    expect(error.message).toContain('Image generation is unavailable')
    expect(error.message).toContain('Settings > AI > Advanced')
    expect(error.suggestion).toContain('do not retry')
    expect(fakes.detect).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'cat.png'))).toBe(false)
  })

  it('names the subscription switch when Codex could make the image but the switch is off', async () => {
    const generate = vi.fn()
    setCodexImageGenerationAvailable(true)
    aiSearch.registerCodexImageGenerator(generate)
    const { env, dir } = dataFolder()
    const r = await run(['image', 'a cat', '--out', join(dir, 'cat.png'), '--json'], { env })
    expect(r.code).toBe(4)
    expect(r.json().detail).toEqual({ errorCode: 'unavailable' })
    expect(r.json().message).toContain(
      'use a subscription login only after that is turned on under Settings > AI > Advanced',
    )
    // off means: behave as if no subscription existed, so nothing is asked of the CLIs either
    expect(fakes.detect).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it('uses the key provider when the switch is off and a key is set', async () => {
    const generate = vi.fn()
    setCodexImageGenerationAvailable(true)
    aiSearch.registerCodexImageGenerator(generate)
    const { env, dir } = dataFolder({ media: KEY_IMAGE })
    const out = join(dir, 'cat.png')
    const r = await run(['image', 'a cat', '--out', out, '--json'], { env })
    expect(r.code).toBe(0)
    expect(fakes.generateWithKey).toHaveBeenCalledTimes(1)
    expect(fakes.generateWithKey.mock.calls[0]![0]).toBe('openai')
    expect(generate).not.toHaveBeenCalled()
    expect(fakes.detect).not.toHaveBeenCalled()
    expect(r.json().output_path).toBe(out)
    expect(r.json().detail.mime).toBe('image/png')
    expect(readFileSync(out).equals(PNG)).toBe(true)
    // a key request is not a subscription request: no ledger is started
    expect(existsSync(join(dir, 'headless-subscription-ledger.json'))).toBe(false)
  })

  it('uses the Codex subscription when the switch is on, counted in the folder of the settings', async () => {
    const generate = vi.fn(async () => ({ bytes: new Uint8Array(PNG), mime: 'image/png' }))
    setCodexImageGenerationAvailable(true)
    aiSearch.registerCodexImageGenerator(generate)
    const tool = vi.spyOn(aiSearch, 'generateImageTool')
    const { env, dir } = dataFolder({
      ...ON,
      // a key is filled in as well, but Codex is the selected image provider
      media: { ...KEY_IMAGE, imageProvider: 'codex' },
    })
    const out = join(dir, 'cat.png')
    const r = await run(['image', 'a cat', '--out', out, '--json'], { env })
    expect(r.code).toBe(0)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(fakes.generateWithKey).not.toHaveBeenCalled()
    // only Codex makes images, so only Codex is asked for its status
    expect(fakes.detect.mock.calls.map((call) => call[0])).toEqual(['codex'])
    const context = tool.mock.calls[0]![2]!.context!
    expect(context.path).toBe('headless')
    expect(context.dataDir).toBe(dir)
    expect(context.statuses?.codex).toMatchObject({ state: 'ready', meteredAccepted: false })
    expect(existsSync(join(dir, 'headless-subscription-ledger.json'))).toBe(true)
    expect(readFileSync(out).equals(PNG)).toBe(true)
  })

  it('keeps the ledger beside a settings file named by GENOFFICE_AI_SETTINGS', async () => {
    setCodexImageGenerationAvailable(true)
    aiSearch.registerCodexImageGenerator(async () => ({
      bytes: new Uint8Array(PNG),
      mime: 'image/png',
    }))
    const tool = vi.spyOn(aiSearch, 'generateImageTool')
    const elsewhere = tempDir()
    const { env, dir } = dataFolder()
    const settings = join(elsewhere, 'custom-settings.json')
    writeFileSync(settings, JSON.stringify({ provider: 'auto', providers: {}, ...ON }))
    const r = await run(['image', 'a cat', '--out', join(dir, 'cat.png'), '--json'], {
      env: { ...env, GENOFFICE_AI_SETTINGS: settings },
    })
    expect(r.code).toBe(0)
    expect(tool.mock.calls[0]![0]).toBe(settings)
    expect(tool.mock.calls[0]![2]!.context!.dataDir).toBe(elsewhere)
    expect(existsSync(join(elsewhere, 'headless-subscription-ledger.json'))).toBe(true)
    expect(existsSync(join(dir, 'headless-subscription-ledger.json'))).toBe(false)
  })

  it('runs past what used to be the hourly limit', async () => {
    const generate = vi.fn(async () => ({ bytes: new Uint8Array(PNG), mime: 'image/png' }))
    setCodexImageGenerationAvailable(true)
    aiSearch.registerCodexImageGenerator(generate)
    const { env, dir } = dataFolder(ON)
    // the old cap was 20 an hour
    for (let i = 0; i < 20; i++) {
      await aiSearch.runHeadlessSubscriptionCall(dir, async () => undefined)
    }
    const out = join(dir, 'cat.png')
    const r = await run(['image', 'a cat', '--out', out, '--json'], { env })
    expect(r.code).toBe(0)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(readFileSync(out).equals(PNG)).toBe(true)
    expect(aiSearch.headlessSubscriptionUsage(dir).used).toBe(21)
  })

  it('reads a switch turned on under the older warning as off', async () => {
    const generate = vi.fn(async () => ({ bytes: new Uint8Array(PNG), mime: 'image/png' }))
    setCodexImageGenerationAvailable(true)
    aiSearch.registerCodexImageGenerator(generate)
    const { env, dir } = dataFolder({ headlessSubscriptionEnabled: true })
    const r = await run(['image', 'a cat', '--out', join(dir, 'cat.png'), '--json'], { env })
    expect(r.code).toBe(4)
    expect(r.json().detail).toEqual({ errorCode: 'unavailable' })
    expect(generate).not.toHaveBeenCalled()
    expect(fakes.detect).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'headless-subscription-ledger.json'))).toBe(false)
  })

  it('passes on the note of an ignored --model and keeps the result shape', async () => {
    const { env, dir } = dataFolder({ media: KEY_IMAGE })
    const out = join(dir, 'cat.png')
    const r = await run(['image', 'a cat', '--out', out, '--model', 'fal-bria-rmbg', '--json'], {
      env,
    })
    expect(r.code).toBe(0)
    const ok = r.json()
    expect(Object.keys(ok).sort()).toEqual(
      ['command', 'detail', 'output_path', 'status', 'summary'].sort(),
    )
    expect(Object.keys(ok.detail).sort()).toEqual(['bytes', 'mime', 'note', 'source_url'])
    expect(ok.detail.note).toContain('no longer supported')
  })
})

describe('media on the automatic-call path', () => {
  it('answers unavailable, naming the switch and the key area, when the switch is off and no key is set', async () => {
    const { env } = dataFolder()
    const r = await run(['media', photo(), '--json'], { env })
    expect(r.code).toBe(4)
    const error = r.json()
    expect(error.error).toBe('app_unavailable')
    expect(error.detail).toEqual({ errorCode: 'unavailable' })
    expect(error.message).toContain('Image analysis is unavailable')
    expect(error.message).toContain(
      'select an image analysis provider key under Settings > AI > Advanced',
    )
    expect(error.message).toContain(
      'use a subscription login only after that is turned on under Settings > AI > Advanced',
    )
    expect(fakes.detect).not.toHaveBeenCalled()
    expect(fakes.analyzeWithKey).not.toHaveBeenCalled()
  })

  it('uses the key provider when the switch is off and a key is set', async () => {
    const { env } = dataFolder({
      media: { analysisProvider: 'gemini', providers: { gemini: { apiKey: 'k' } } },
    })
    const r = await run(['media', photo(), '--ask', 'what is it?', '--json'], { env })
    expect(r.code).toBe(0)
    expect(fakes.analyzeWithKey).toHaveBeenCalledTimes(1)
    expect(fakes.analyzeWithKey.mock.calls[0]![0]).toBe('gemini')
    expect(r.json().detail.text).toBe('A single dark pixel.')
    expect(fakes.detect).not.toHaveBeenCalled()
  })

  it('does not ask the CLIs for their status when a key provider answers, even with the switch on', async () => {
    const { env } = dataFolder({
      ...ON,
      media: { analysisProvider: 'gemini', providers: { gemini: { apiKey: 'k' } } },
    })
    const r = await run(['media', photo(), '--json'], { env })
    expect(r.code).toBe(0)
    expect(fakes.analyzeWithKey).toHaveBeenCalledTimes(1)
    expect(fakes.detect).not.toHaveBeenCalled()
  })

  it('passes the headless context, the statuses and the data folder when the switch is on', async () => {
    const tool = vi.spyOn(aiSearch, 'analyzeMediaTool').mockResolvedValue({ text: 'A cat.' })
    const { env, dir } = dataFolder(ON)
    const file = photo()
    const r = await run(['media', file, '--json'], { env })
    expect(r.code).toBe(0)
    expect(r.json().detail.text).toBe('A cat.')
    expect(tool).toHaveBeenCalledTimes(1)
    const [settingsPath, op, options] = tool.mock.calls[0]!
    expect(settingsPath).toBe(join(dir, 'ai-settings.json'))
    expect(op.mediaUrls).toEqual([file])
    expect(options!.context!.path).toBe('headless')
    expect(options!.context!.dataDir).toBe(dir)
    expect(options!.context!.statuses).toMatchObject({
      'claude-code': { provider: 'claude-code', state: 'ready' },
      codex: { provider: 'codex', state: 'ready' },
    })
    expect(fakes.detect.mock.calls.map((call) => call[0]).sort()).toEqual([
      'chatgpt',
      'claude-code',
      'codex',
    ])
  })

  it('keeps the account a CLI names out of the tool context, the result and the audit log', async () => {
    const ACCOUNT = 'jun.il@school.kr'
    fakes.detect.mockImplementation(async (provider: string) => ({
      ...READY[provider]!,
      account: ACCOUNT,
    }))
    const tool = vi.spyOn(aiSearch, 'analyzeMediaTool').mockResolvedValue({ text: 'A cat.' })
    const { env, dir } = dataFolder(ON)
    const audit = join(dir, 'audit.jsonl')
    const r = await run(['media', photo(), '--json'], {
      env: { ...env, GENOFFICE_AUDIT_LOG: audit },
    })
    expect(r.code).toBe(0)
    const context = tool.mock.calls[0]![2]!.context!
    expect(context.statuses?.['claude-code']).toMatchObject({ state: 'ready' })
    expect(JSON.stringify(context)).not.toContain('school.kr')
    expect(`${r.stdout}\n${r.stderr}`).not.toContain('school.kr')
    expect(readFileSync(audit, 'utf8')).not.toContain('school.kr')
    // nothing was written next to the settings either
    for (const name of readdirSync(dir)) {
      expect(readFileSync(join(dir, name), 'utf8'), name).not.toContain('school.kr')
    }
  })

  it('behaves as not connected when the status check fails', async () => {
    fakes.detect.mockRejectedValue(new Error('spawn EACCES'))
    const { env } = dataFolder(ON)
    const r = await run(['media', photo(), '--json'], { env })
    expect(r.code).toBe(4)
    expect(r.json().detail).toEqual({ errorCode: 'unavailable' })
    expect(fakes.detect).toHaveBeenCalled()
  })

  it('treats an accepted metered login the user selected like a key: no switch needed', async () => {
    const tool = vi.spyOn(aiSearch, 'analyzeMediaTool').mockResolvedValue({ text: 'A cat.' })
    fakes.detect.mockResolvedValue(METERED_CLAUDE)
    const { env, dir } = dataFolder({
      provider: 'claude-code',
      meteredAccepted: { 'claude-code': true },
    })
    // the acceptance as the app records it, in the same folder
    await createMeteredAcceptanceFileStore(dir).write({
      'claude-code': meteredLoginFingerprint(METERED_CLAUDE)!,
    })
    const before = readFileSync(join(dir, 'ai-settings.json'), 'utf8')
    const r = await run(['media', photo(), '--json'], { env })
    expect(r.code).toBe(0)
    const context = tool.mock.calls[0]![2]!.context!
    expect(context.statuses?.['claude-code']).toMatchObject({
      state: 'metered',
      meteredAccepted: true,
    })
    // only the selected provider is asked
    expect(fakes.detect.mock.calls.map((call) => call[0])).toEqual(['claude-code'])
    const caps = await run(['capabilities', '--json'], { env })
    expect(caps.json().detail.image_analysis).toEqual({
      available: true,
      via: 'claude-code',
      route: 'key',
      metered: true,
    })
    expect(caps.json().detail.automatic_calls).toEqual({ subscription_enabled: false })
    expect(readFileSync(join(dir, 'ai-settings.json'), 'utf8')).toBe(before)
  })

  it('does not count a metered login whose acceptance the app never recorded, and leaves the app files alone', async () => {
    fakes.detect.mockResolvedValue(METERED_CLAUDE)
    const { env, dir } = dataFolder({
      provider: 'claude-code',
      meteredAccepted: { 'claude-code': true },
    })
    const before = readFileSync(join(dir, 'ai-settings.json'), 'utf8')
    const r = await run(['media', photo(), '--json'], { env })
    expect(r.code).toBe(4)
    expect(r.json().detail).toEqual({ errorCode: 'unavailable' })
    // the app owns its settings and its acceptance record: this process only reads them
    expect(readFileSync(join(dir, 'ai-settings.json'), 'utf8')).toBe(before)
    expect(existsSync(join(dir, 'subscription-metered.json'))).toBe(false)
  })

  it('reports the hourly limit with the time it frees again', async () => {
    const resetsAt = Date.UTC(2031, 0, 2, 3, 4, 5)
    vi.spyOn(aiSearch, 'analyzeMediaTool').mockResolvedValue({
      error: 'Subscription use from the command line and integrations is limited',
      errorCode: 'headless-limit',
      resetsAt,
    })
    const { env } = dataFolder(ON)
    const r = await run(['media', photo(), '--json'], { env })
    expect(r.code).toBe(4)
    const error = r.json()
    expect(error.detail).toEqual({ errorCode: 'headless-limit', resetsAt })
    expect(error.message).toContain('2031-01-02T03:04:05.000Z')
    expect(error.suggestion).toContain('2031-01-02T03:04:05.000Z')
    const human = await run(['media', photo()], { env })
    expect(human.code).toBe(4)
    expect(human.stderr).toContain('2031-01-02T03:04:05.000Z')
  })

  it.each([
    ['signed-out', 'Claude Code is not signed in', 'sign in'],
    ['not-installed', 'Codex CLI was not found', 'install'],
    ['not-connected', 'No AI provider is connected', 'Settings > AI'],
    ['metered-not-accepted', 'billed by usage, which has not been accepted', 'billed by usage'],
    ['needs-update', 'Claude Code is too old for this app', 'update'],
    ['unsafe-tools', 'the run was stopped', 'tell the user'],
    ['rate-limit', 'usage limit reached', 'usage limit'],
    ['credits', 'insufficient credit', 'out of credit'],
    ['network', 'fetch failed', 'network'],
    ['overloaded', 'overloaded', 'retry once'],
    ['timeout', 'Image analysis timed out', 'retry once'],
  ] as const)('says what to do about a %s failure', async (errorCode, text, hint) => {
    vi.spyOn(aiSearch, 'analyzeMediaTool').mockResolvedValue({ error: text, errorCode })
    const { env } = dataFolder()
    const r = await run(['media', photo(), '--json'], { env })
    expect(r.code).toBe(4)
    const error = r.json()
    expect(error.message).toBe(text)
    expect(error.detail).toEqual({ errorCode })
    expect(error.suggestion).toContain(hint)
  })

  it('adds the time a subscription limit frees again when the provider did not word it', async () => {
    const resetsAt = Date.UTC(2031, 5, 6, 7, 8, 9)
    vi.spyOn(aiSearch, 'analyzeMediaTool').mockResolvedValue({
      error: 'usage limit reached',
      errorCode: 'rate-limit',
      resetsAt,
    })
    const r = await run(['media', photo(), '--json'], { env: dataFolder().env })
    expect(r.json().detail).toEqual({ errorCode: 'rate-limit', resetsAt })
    expect(r.json().message).toBe(
      'usage limit reached (possible again at 2031-06-06T07:08:09.000Z)',
    )
  })

  it('keeps a failure without a cause as it was: the message, exit 4, no detail', async () => {
    vi.spyOn(aiSearch, 'analyzeMediaTool').mockResolvedValue({ error: 'boom' })
    const r = await run(['media', photo(), '--json'], { env: dataFolder().env })
    expect(r.code).toBe(4)
    expect(r.json().message).toBe('boom')
    expect(r.json().detail).toBeUndefined()
    expect(r.json().suggestion).toContain('retry once')
  })
})

describe('subscription CLIs started for a request', () => {
  it('are recorded beside the settings for a request that can run on a login, not for the report', async () => {
    // a fresh copy of the module: the record is set up once per process
    vi.resetModules()
    const cloud = await import('../src/cloud')
    const subscription = await import('@genoffice/ai-provider/subscription')
    const registry = subscription.sharedSubscriptionChildRegistry()
    const { env, dir } = dataFolder(ON)
    const record = subscription.leftoverRecordFile(dir)

    const report = await cloud.headlessCall(env, 'capabilities')
    expect(report.context.statuses?.['claude-code']?.state).toBe('ready')
    await registry.flushed()
    expect(existsSync(record)).toBe(false)

    await cloud.headlessCall(env, 'media')
    await registry.flushed()
    expect(existsSync(record)).toBe(true)

    // what the exit and signal handlers run
    subscription.shutdownSubscriptionChildren()
    expect(existsSync(record)).toBe(false)
  })

  it('are not prepared for at all when no subscription can answer', async () => {
    vi.resetModules()
    const cloud = await import('../src/cloud')
    const subscription = await import('@genoffice/ai-provider/subscription')
    const { env, dir } = dataFolder()
    const before = process.listenerCount('exit')
    const call = await cloud.headlessCall(env, 'media')
    expect(call.context).toEqual({ path: 'headless', dataDir: dir })
    expect(process.listenerCount('exit')).toBe(before)
    await subscription.sharedSubscriptionChildRegistry().flushed()
    expect(existsSync(subscription.leftoverRecordFile(dir))).toBe(false)
  })
})

describe('search on the automatic-call path', () => {
  it('never asks the CLIs for their status, whatever the settings say', async () => {
    const web = vi
      .spyOn(aiSearch, 'webSearchTool')
      .mockResolvedValue({ method: 'parallel', results: [{ title: 't', url: 'u', snippet: 's' }] })
    const images = vi
      .spyOn(aiSearch, 'imageSearchTool')
      .mockResolvedValue({ method: 'duckduckgo', images: [] })
    const { env, dir } = dataFolder({ provider: 'claude-code', ...ON })
    const r = await run(['search', 'ieum office', '--json'], { env })
    expect(r.code).toBe(0)
    expect(r.json().detail).toEqual({
      method: 'parallel',
      results: [{ title: 't', url: 'u', snippet: 's' }],
    })
    expect((await run(['search', 'cats', '--images', '--json'], { env })).code).toBe(0)
    expect(web.mock.calls[0]![0]).toBe(join(dir, 'ai-settings.json'))
    expect(images).toHaveBeenCalledTimes(1)
    expect(fakes.detect).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'headless-subscription-ledger.json'))).toBe(false)
  })
})

describe('the MCP tools are the same automatic-call path', () => {
  const tools = new Map(resolveTools(defaultRegistry()).map((t) => [t.name, t]))

  it('runs image and media with the headless context and answers the same error fields', async () => {
    const analyze = vi.spyOn(aiSearch, 'analyzeMediaTool')
    const generate = vi.spyOn(aiSearch, 'generateImageTool')
    const { env, dir } = dataFolder()
    const ctx = createContext({ cwd: dir, env, log: () => undefined })
    try {
      const media = buildArgv(tools.get('media')!, { source: photo() })
      const analyzed = await runWithInline(media.argv, media.inline, ctx)
      expect(analyzed.error?.code).toBe(4)
      expect(analyzed.error?.detail).toEqual({ errorCode: 'unavailable' })
      expect(analyze.mock.calls[0]![2]!.context).toMatchObject({ path: 'headless', dataDir: dir })

      const image = buildArgv(tools.get('image')!, { prompt: 'a cat', out: join(dir, 'c.png') })
      const generated = await runWithInline(image.argv, image.inline, ctx)
      expect(generated.error?.detail).toEqual({ errorCode: 'unavailable' })
      expect(generate.mock.calls[0]![2]!.context).toMatchObject({ path: 'headless', dataDir: dir })

      const caps = await runWithInline(buildArgv(tools.get('capabilities')!, {}).argv, [], ctx)
      expect(caps.ok?.detail?.image_generation).toMatchObject({ available: false, route: null })
      expect(caps.ok?.detail?.automatic_calls).toEqual({ subscription_enabled: false })
    } finally {
      disposeContext(ctx)
    }
    expect(fakes.detect).not.toHaveBeenCalled()
  })

  it('describes the tools without the special models that were removed', () => {
    for (const name of ['capabilities', 'search', 'image', 'media']) {
      const description = TOOLS.find((t) => t.name === name)!.description
      expect(description).not.toMatch(/background removal|upscale/i)
    }
    expect(tools.get('capabilities')!.description).toMatch(/subscription/)
  })
})

describe('no trace of the removed login', () => {
  it.each([
    'cloud.ts',
    'commands/search.ts',
    'commands/image.ts',
    'commands/media.ts',
    'commands/capabilities.ts',
    'mcp/tools.ts',
    'mcp/server.ts',
    'mcp/run.ts',
  ])('%s does not look for the removed login or its command line', (file) => {
    const source = readFileSync(join(__dirname, '..', 'src', file), 'utf8')
    expect(source).not.toMatch(
      /cloudToolsEnabled|auth\.json|GENOFFICE_AUTH_DIR|~\/\.(genoffice|ieumoffice)/,
    )
  })
})
