/**
 * The pieces of `packages/ai-provider/src` that the editors' AI modules need:
 * `subscription/contract.offSubscriptionStatus`, the readers of the media
 * block that `media.ts` adds (`mediaConfigUsable`, `activeMediaProvider`,
 * `activeMediaConfig`), `image-backend`, `registry` (the vision capability),
 * the screens' helpers of `free-ai`, and `free-connect`.
 *
 * - Settings are the JSON a settings file holds; the module state of
 *   `image-backend` (`codexImageAvailable`) is the last argument of the
 *   functions that read it, set before every call on both sides.
 * - free-connect: `fetch` of a case is a list of answers taken one per call
 *   (the last repeats): `{ status, location?, opaque?, json?, jsonThrows?,
 *   throws? }`; each call logs `["fetch", url, init]` with the `init` fields
 *   the module sets. `connectOpenRouter` runs the real TypeScript against a
 *   real loopback server: the browser of the case (`browser`) asks the
 *   requests of `requests` of it, and the answers are logged.
 */
import type { Case, FnSpec, Group } from '../types.ts'
import { cases, g, loadPatched, must, type J } from './b5-agent-apps-lib.ts'

const contract = await import('../../../packages/ai-provider/src/subscription/contract.ts')
const media = await import('../../../packages/ai-provider/src/media.ts')
const imageBackend = await import('../../../packages/ai-provider/src/image-backend.ts')
const registry = await import('../../../packages/ai-provider/src/registry.ts')
const freeAi = await import('../../../packages/ai-provider/src/free-ai.ts')

const constant = (value: unknown): FnSpec => ({
  ts: () => value,
  cases: [{ args: [] }],
  single: 'a constant',
})

// ---------------------------------------------------------------------------
// subscription/contract
// ---------------------------------------------------------------------------

const contractFns: Group = {
  'ai-provider/subscription/contract.offSubscriptionStatus': {
    ts: (a) => contract.offSubscriptionStatus(a[0] as 'codex'),
    cases: cases(['claude-code'], ['codex'], ['chatgpt']),
  },
}

// ---------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------

const mediaMeta = (id: string): J => media.AI_MEDIA_PROVIDERS.find((m) => m.id === id)

/** a media block as the settings hold it */
const mediaBlock = (over: J = {}): J => ({
  imageProvider: 'openai',
  analysisProvider: 'gemini',
  videoAnalysisProvider: 'gemini',
  providers: {
    openai: { apiKey: 'sk-o', imageModel: 'gpt-image-2', analysisModel: 'gpt-5.6-luna' },
    gemini: { apiKey: 'gk', imageModel: '', analysisModel: '' },
    stability: { apiKey: 'st', imageModel: '', analysisModel: '' },
    deepseek: { apiKey: '  ', imageModel: '', analysisModel: '' },
    custom: { apiKey: '', baseUrl: 'https://llm.test/v1', imageModel: '', analysisModel: '' },
    microsoft: { apiKey: 'ms', baseUrl: '', imageModel: '', analysisModel: '' },
  },
  ...over,
})

const mediaSettings: J[] = [
  { media: mediaBlock() },
  {
    media: mediaBlock({
      imageProvider: 'codex',
      analysisProvider: 'chat',
      videoAnalysisProvider: 'none',
    }),
  },
  { media: mediaBlock({ imageProvider: 'deepseek', analysisProvider: 'deepseek' }) },
  {
    media: mediaBlock({
      imageProvider: 'stability',
      analysisProvider: 'stability',
      videoAnalysisProvider: 'openai',
    }),
  },
  { media: mediaBlock({ imageProvider: 'custom', analysisProvider: 'custom' }) },
  { media: mediaBlock({ imageProvider: 'microsoft' }) },
  {
    media: mediaBlock({ imageProvider: 'nope', analysisProvider: '', videoAnalysisProvider: null }),
  },
  { media: mediaBlock({ providers: null }) },
  {},
]

const capabilityCases = (): Case[] =>
  mediaSettings.flatMap((settings) =>
    ['image', 'analysis', 'video'].map((cap): Case => ({ args: [settings, cap] })),
  )

const mediaFns: Group = {
  'ai-provider/media.mediaConfigUsable': {
    ts: (a) => media.mediaConfigUsable(mediaMeta(a[0] as string), a[1] as J),
    cases: cases(
      ['openai', { apiKey: 'sk' }],
      ['openai', { apiKey: '  ' }],
      ['openai', { apiKey: '', baseUrl: 'https://x.test' }],
      ['openai'],
      ['openai', {}],
      ['custom', { baseUrl: 'https://x.test', apiKey: '' }],
      ['custom', { baseUrl: '  ', apiKey: 'k' }],
      ['custom', { apiKey: 'k' }],
      ['microsoft', { baseUrl: ' https://m.test ' }],
    ),
  },
  'ai-provider/media.activeMediaProvider': {
    ts: (a) => media.activeMediaProvider(a[0] as J, a[1] as 'image'),
    cases: capabilityCases(),
  },
  'ai-provider/media.activeMediaConfig': {
    ts: (a) => media.activeMediaConfig(a[0] as J, a[1] as 'image'),
    cases: capabilityCases(),
  },
}

// ---------------------------------------------------------------------------
// image-backend
// ---------------------------------------------------------------------------

const imageSettings: J[] = [
  null,
  {},
  { media: { imageProvider: 'none' } },
  { media: { imageProvider: 'codex' } },
  { media: { imageProvider: 'openai', providers: { openai: { apiKey: 'sk', imageModel: '' } } } },
  { media: { imageProvider: 'openai', providers: { openai: { apiKey: '', imageModel: 'm' } } } },
  { media: { imageProvider: 'deepseek', providers: { deepseek: { apiKey: 'k' } } } },
  { media: { imageProvider: 'stability', providers: { stability: { apiKey: 'k' } } } },
  {
    media: {
      imageProvider: 'custom',
      providers: { custom: { baseUrl: 'https://x.test', imageModel: '' } },
    },
  },
  {
    media: {
      imageProvider: 'custom',
      providers: { custom: { baseUrl: 'https://x.test', imageModel: 'img' } },
    },
  },
  {
    media: {
      imageProvider: 'nope',
      providers: { gemini: { apiKey: 'g' }, openai: { apiKey: 'o' } },
    },
  },
  { media: { imageProvider: 'codex', providers: { openai: { apiKey: 'o' } } } },
  {
    media: {
      imageProvider: 'none',
      providers: { gemini: { apiKey: 'g' }, openai: { apiKey: 'o' } },
    },
  },
]

function withCodex<T>(available: boolean, run: () => T): T {
  imageBackend.setCodexImageGenerationAvailable(available)
  try {
    return run()
  } finally {
    imageBackend.setCodexImageGenerationAvailable(false)
  }
}

const contexts: J[] = [
  undefined,
  {},
  { codex: { provider: 'codex', state: 'ready' } },
  { codex: { provider: 'codex', state: 'metered' } },
  { codex: { provider: 'codex', state: 'ready' }, codexImageAvailable: false },
  { codexImageAvailable: true },
  { codex: { provider: 'codex', state: 'ready' }, codexImageAvailable: true },
]

const backendCases: Case[] = imageSettings.flatMap((settings) =>
  contexts.map((context): Case => ({ args: [settings, context ?? null, false] })),
)
backendCases.push(
  { args: [imageSettings[3], { codex: { provider: 'codex', state: 'ready' } }, true] },
  { args: [imageSettings[10], { codex: { provider: 'codex', state: 'ready' } }, true] },
  { args: [imageSettings[12], { codex: { provider: 'codex', state: 'ready' } }, true] },
  { args: [imageSettings[0], { codex: { provider: 'codex', state: 'ready' } }, true] },
  { args: [imageSettings[3], { codex: { provider: 'codex', state: 'metered' } }, true] },
  { args: [imageSettings[4], { codex: { provider: 'codex', state: 'ready' } }, true] },
  { args: [imageSettings[3], { codex: { provider: 'codex', state: 'ready' } }, false] },
)

async function freshImageBackend(): Promise<J> {
  return loadPatched('packages/ai-provider/src/image-backend.ts', (src) => src)
}

const imageBackendFns: Group = {
  'ai-provider/image-backend.configuredImageKeyProviders': {
    ts: (a) => imageBackend.configuredImageKeyProviders(a[0] as J),
    cases: imageSettings.map((settings): Case => ({ args: [settings] })),
  },
  'ai-provider/image-backend.imageProviderSelection': {
    ts: (a) =>
      withCodex(a[2] as boolean, () =>
        a[1] === null
          ? imageBackend.imageProviderSelection(a[0] as J)
          : imageBackend.imageProviderSelection(a[0] as J, a[1] as boolean),
      ),
    cases: imageSettings.flatMap((settings): Case[] => [
      { args: [settings, true, false] },
      { args: [settings, false, false] },
      { args: [settings, null, false] },
      { args: [settings, null, true] },
    ]),
  },
  'ai-provider/image-backend.resolveImageBackend': {
    ts: (a) =>
      withCodex(a[2] as boolean, () =>
        a[1] === null
          ? imageBackend.resolveImageBackend(a[0] as J)
          : imageBackend.resolveImageBackend(a[0] as J, a[1] as J),
      ),
    cases: backendCases,
  },
  'ai-provider/image-backend.setCodexImageGenerationAvailable': {
    ts: async (a) => {
      const mod = await freshImageBackend()
      return (a[0] as (boolean | 'get')[]).map((step) =>
        step === 'get'
          ? mod.codexImageGenerationAvailable()
          : (mod.setCodexImageGenerationAvailable(step), null),
      )
    },
    cases: cases([[true, 'get', false, 'get']], [['get', true, true, 'get']], [[false, 'get']]),
  },
  'ai-provider/image-backend.codexImageGenerationAvailable': {
    ts: async (a) => {
      const mod = await freshImageBackend()
      return (a[0] as (boolean | 'get')[]).map((step) =>
        step === 'get'
          ? mod.codexImageGenerationAvailable()
          : (mod.setCodexImageGenerationAvailable(step), null),
      )
    },
    cases: cases([['get']], [[true, 'get']], [['get', true, 'get', false, 'get']]),
  },
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

const visionModels = [
  'minimax-m2.7',
  'MiniMax-M2.7-highspeed',
  'minimax-m2.7x',
  'vendor/minimax-m2.7',
  'MiniMax-M3',
  'zai-org/GLM-5.3',
  'QWEN/qwen3.8-flash',
  'zai-org/glm-5.3-flash',
  'MiniMaxAI/MiniMax-M3',
  'minimaxai/minimax-m2.5',
  'qwen/qwen3.8-flash',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-120b-x',
  'deepseek-v4-pro',
  'deep-seek-v4-pro-2',
  'deepseek-v4-flash',
  'deepseek-v4-flash-vision',
  'deepseek-v4.1-flash',
  'x/deepseek-v4-pro',
  'ling-3.0-flash',
  'ling-3.0-flash-vl',
  'Ling-3.0-flash-VL',
  'ling-3.0-tiny',
  'ling-2.6-1t',
  'ling-2.6-flash',
  'ring-2.6-1t',
  'longcat-2.0',
  'longcat-2.0-preview',
  'longcat-2.5-preview',
  'claude-sonnet-5-5',
  'gpt-5.6-luna',
  '',
]

const providerIds = [
  'claude-code',
  'chatgpt',
  'codex',
  'anthropic',
  'glm',
  'qwen',
  'hunyuan',
  'spark',
  'mistral',
  'upstage',
  'exaone',
  'openrouter',
  'custom',
  'gateway',
  'opencode-go',
  'auto',
  'nope',
  '',
]

const registryFns: Group = {
  'ai-provider/registry.modelLacksVision': {
    ts: (a) => registry.modelLacksVision(a[0] as string),
    cases: cases(...visionModels.map((m) => [m])),
  },
  'ai-provider/registry.getProviderAdapter': {
    ts: (a) => registry.getProviderAdapter(a[0] as 'codex').capabilities.vision,
    cases: cases(...providerIds.map((id) => [id])),
  },
}

// ---------------------------------------------------------------------------
// free-ai (the screens' helpers)
// ---------------------------------------------------------------------------

const freeSettings = (over: J = {}): J => ({
  provider: 'auto',
  theme: 'dark',
  providers: {
    openrouter: { apiKey: 'or-key', model: 'nvidia/nemotron-3-super-120b-a12b:free', extra: 1 },
    gemini: { apiKey: 'g-key', model: 'gemini-3.5-flash-lite' },
    anthropic: { apiKey: '', model: '' },
  },
  ...over,
})

const freeAiFns: Group = {
  'ai-provider/free-ai.FREE_AI_PROVIDERS': constant(freeAi.FREE_AI_PROVIDERS),
  'ai-provider/free-ai.OPENROUTER_FREE_MODELS': constant(freeAi.OPENROUTER_FREE_MODELS),
  'ai-provider/free-ai.GEMINI_FREE_MODEL': constant(freeAi.GEMINI_FREE_MODEL),
  'ai-provider/free-ai.FREE_AI_KEY_PAGES': constant(freeAi.FREE_AI_KEY_PAGES),
  'ai-provider/free-ai.FREE_AI_IPC_CHANNELS': constant(freeAi.FREE_AI_IPC_CHANNELS),
  'ai-provider/free-ai.isFreeAiProvider': {
    ts: (a) => freeAi.isFreeAiProvider(a[0]),
    cases: cases(
      ['openrouter'],
      ['gemini'],
      ['openai'],
      [''],
      [null],
      [5],
      [['openrouter']],
      [true],
      ['OpenRouter'],
    ),
  },
  'ai-provider/free-ai.isOpenRouterFreeModel': {
    ts: (a) => freeAi.isOpenRouterFreeModel(a[0] as string | undefined),
    cases: cases(
      ['a/b:free'],
      [' a/b:free '],
      ['a/b:free\n'],
      ['a/b:free-x'],
      ['a/b'],
      [''],
      [':free'],
      [],
      [5],
      [null],
    ),
  },
  'ai-provider/free-ai.freeAiConnected': {
    ts: (a) => freeAi.freeAiConnected(a[0] as J, a[1] as 'openrouter'),
    cases: cases(
      [freeSettings(), 'openrouter'],
      [freeSettings(), 'gemini'],
      [
        freeSettings({ providers: { openrouter: { apiKey: 'k', model: 'paid/model' } } }),
        'openrouter',
      ],
      [freeSettings({ providers: { gemini: { apiKey: 'k', model: 'any' } } }), 'gemini'],
      [freeSettings({ providers: { gemini: { apiKey: ' ', model: 'any' } } }), 'gemini'],
      [freeSettings({ providers: { gemini: { apiKey: 'k', model: ' ' } } }), 'gemini'],
      [freeSettings({ providers: {} }), 'gemini'],
      [{}, 'gemini'],
      [
        freeSettings({ providers: { openrouter: { apiKey: 'k', model: 'x:free ' } } }),
        'openrouter',
      ],
    ),
  },
  'ai-provider/free-ai.keyProviderModels': {
    ts: (a) =>
      freeAi.keyProviderModels(a[0] as 'openrouter', a[1] as string, a[2] as string[] | undefined),
    cases: cases(
      ['openrouter', 'google/gemma-4-31b-it:free'],
      ['openrouter', ' google/gemma-4-31b-it:free '],
      ['openrouter', 'some/paid-model'],
      ['openrouter', 'some/paid-model', ['new/model', 'other/model']],
      ['openrouter', '', ['x:free']],
      ['openrouter', 'custom:free', ['x:free']],
      ['gemini', 'gemini-3.8-flash'],
      ['gemini', 'custom:free'],
      ['gemini', 'unknown-model'],
      ['gemini', '', ['gemini-3.8-flash', ' fresh-model ', 5, 'fresh-model']],
      ['deepseek', ''],
      ['nope', 'm', ['a']],
      ['nope', ''],
    ),
  },
  'ai-provider/free-ai.withFreeAiConnection': {
    ts: (a) =>
      freeAi.withFreeAiConnection(
        a[0] as J,
        a[1] as 'openrouter',
        a[2] as { apiKey: string; model: string },
      ),
    cases: cases(
      [freeSettings(), 'openrouter', { apiKey: 'new-key', model: 'm:free' }],
      [freeSettings(), 'gemini', { apiKey: 'new-key', model: 'gm' }],
      [freeSettings({ provider: 'gemini' }), 'gemini', { apiKey: 'k2', model: 'gm2' }],
      [
        freeSettings({ providers: { gemini: { apiKey: 'old', model: 'old', note: 'kept' } } }),
        'gemini',
        { apiKey: 'k', model: 'm' },
      ],
      [{ providers: {} }, 'openrouter', { apiKey: 'k', model: 'm' }],
      [{ providers: {}, provider: 'auto', z: 1 }, 'gemini', { apiKey: '', model: '' }],
    ),
  },
  'ai-provider/free-ai.withoutFreeAiConnection': {
    ts: (a) => freeAi.withoutFreeAiConnection(a[0] as J, a[1] as 'openrouter'),
    cases: cases(
      [freeSettings(), 'openrouter'],
      [freeSettings({ provider: 'openrouter' }), 'openrouter'],
      [freeSettings({ provider: 'gemini' }), 'openrouter'],
      [freeSettings({ provider: 'gemini' }), 'gemini'],
      [{ providers: {} }, 'gemini'],
      [
        { providers: { gemini: { apiKey: 'k', model: 'm', note: 'kept' } }, provider: 'anthropic' },
        'gemini',
      ],
    ),
  },
  'ai-provider/free-ai.freeAiConnectResultOf': {
    ts: (a) => freeAi.freeAiConnectResultOf(a[0]),
    cases: cases(
      [{ ok: true, provider: 'gemini', model: 'm' }],
      [{ ok: true, provider: 'openrouter', model: 'm:free', extra: 1 }],
      [{ ok: true, provider: 'nope', model: 'm' }],
      [{ ok: true, provider: 'gemini', model: 5 }],
      [{ ok: true, provider: 'gemini' }],
      [{ ok: 'true', provider: 'gemini', model: 'm' }],
      [{ ok: false, reason: 'cancelled' }],
      [{ ok: false, reason: 'timeout' }],
      [{ ok: false, reason: 'denied' }],
      [{ ok: false, reason: 'invalid' }],
      [{ ok: false, reason: 'network' }],
      [{ ok: false, reason: 'other' }],
      [{}],
      [null],
      ['text'],
      [7],
      [[]],
    ),
  },
  'ai-provider/free-ai.freeAiQuotaOf': {
    ts: (a) => freeAi.freeAiQuotaOf(a[0]),
    cases: cases(
      [{ used: 1, limit: 50, remaining: 49 }],
      [{ used: 0, limit: 0, remaining: 0, extra: 1 }],
      [{ used: -1, limit: 50, remaining: 49 }],
      [{ used: 1, limit: '50', remaining: 49 }],
      [{ used: 1, limit: 50 }],
      [{ used: null, limit: 50, remaining: 49 }],
      [{ used: 1, limit: 1e999, remaining: 49 }],
      [{}],
      [null],
      [5],
    ),
  },
}

// ---------------------------------------------------------------------------
// free-connect
// ---------------------------------------------------------------------------

interface FetchStep {
  status?: number
  location?: string
  opaque?: boolean
  json?: unknown
  jsonThrows?: boolean
  throws?: string
}

/** `fetch` of a case: the steps taken one per call, the last repeating; every call is logged */
function fakeFetch(steps: FetchStep[] | undefined, log: (...args: unknown[]) => void) {
  const queue = [...(steps ?? [])]
  let last: FetchStep = { status: 200 }
  return async (url: string, init: J = {}): Promise<J> => {
    const shown: Record<string, unknown> = {}
    if (init.method !== undefined) shown.method = init.method
    if (init.headers !== undefined) shown.headers = init.headers
    if (init.body !== undefined) shown.body = init.body
    if (init.redirect !== undefined) shown.redirect = init.redirect
    log('fetch', url, shown)
    const step = queue.shift() ?? last
    last = step
    if (step.throws !== undefined) throw new Error(step.throws)
    const status = step.status ?? 200
    return {
      status,
      ok: status >= 200 && status < 300,
      type: step.opaque ? 'opaqueredirect' : 'basic',
      headers: { get: (name: string) => (name === 'location' ? (step.location ?? null) : null) },
      json: async () => {
        if (step.jsonThrows) throw new Error('bad json')
        return step.json
      },
      body: null,
    }
  }
}

/** the `signal` of a case: none, or one that is already aborted */
const signalOf = (aborted: unknown): AbortSignal | undefined =>
  aborted ? AbortSignal.abort() : undefined

const okKey = { status: 200, json: { key: ' sk-or-123 ' } }
const modelsList = (data: unknown): FetchStep => ({ status: 200, json: { data } })
const tools = ['tools']

let randomCount = 0
async function freeConnectModule(random?: string): Promise<J> {
  randomCount += 1
  g.__b5Random = Buffer.from(random ?? '00'.repeat(32), 'hex')
  return loadPatched('packages/ai-provider/src/free-connect.ts', (src) =>
    must(
      must(
        src,
        "import { createHash, randomBytes } from 'node:crypto'",
        "import { createHash } from 'node:crypto'\nconst randomBytes = (_n: number): Buffer => (globalThis as any).__b5Random",
        'free-connect.ts',
      ),
      'options.timeoutMs ?? OPENROUTER_SIGN_IN_TIMEOUT_MS',
      '(globalThis as any).__b5Timer(options.timeoutMs ?? OPENROUTER_SIGN_IN_TIMEOUT_MS)',
      'free-connect.ts',
    ),
  )
}
void randomCount

const HEX_A = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f'
const HEX_B = 'ff'.repeat(32)
const HEX_C = 'fb'.repeat(16) + 'ef'.repeat(16)

const page = (over: J = {}): J => ({
  lang: 'en',
  title: 'Connected',
  body: 'Back to the app.',
  ...over,
})

interface ConnectSpec {
  fetch?: FetchStep[]
  aborted?: boolean
  browser?: 'ok' | 'refuse' | 'throw'
  requests?: { method?: string; path: string }[]
  after?: 'abort' | 'abort-late' | 'timeout'
  timeoutMs?: number
  random?: string
}

async function runConnectOpenRouter(
  spec: ConnectSpec,
  log: (...args: unknown[]) => void,
): Promise<unknown> {
  const mod = await freeConnectModule(spec.random)
  const controller = new AbortController()
  if (spec.aborted) controller.abort()
  g.__b5Timer = (ms: number): number => {
    log('timer', ms)
    return Math.min(ms, 40)
  }
  const norm = (url: string): string => url.replace(/localhost%3A\d+/, 'localhost%3APORT')
  const result = await mod.connectOpenRouter({
    openBrowser: async (url: string) => {
      log('openBrowser', norm(url))
      if (spec.browser === 'throw') throw new Error('no browser')
      if (spec.browser === 'refuse') return false
      if (spec.after === 'abort') {
        controller.abort()
        return true
      }
      const port = new URL(decodeURIComponent(new URL(url).searchParams.get('callback_url')!)).port
      for (const request of spec.requests ?? []) {
        const response = await fetch(`http://127.0.0.1:${port}${request.path}`, {
          method: request.method ?? 'GET',
        })
        log(
          'response',
          response.status,
          response.headers.get('content-type'),
          response.headers.get('content-security-policy'),
          response.headers.get('cache-control'),
          await response.text(),
        )
      }
      if (spec.after === 'abort-late') controller.abort()
      return true
    },
    pages: {
      done: page({ title: 'Done <1>' }),
      failed: page({ lang: 'ko', title: 'Failed', body: 'It\'s "bad" & sad' }),
    },
    signal: controller.signal,
    fetch: fakeFetch(spec.fetch, log),
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
  })
  return result
}

const connectCases: Case[] = [
  {
    args: [
      {
        random: HEX_A,
        requests: [{ path: '/callback?code=abc' }],
        fetch: [
          okKey,
          modelsList([
            { id: 'nvidia/nemotron-3-super-120b-a12b:free', supported_parameters: tools },
          ]),
        ],
      },
    ],
    note: 'the browser comes back with a code: key and the first tested model',
  },
  {
    args: [{ random: HEX_B, requests: [{ path: '/callback' }] }],
    note: 'the browser comes back without a code: denied, the failed page',
  },
  {
    args: [{ requests: [{ path: '/callback?code=' }] }],
    note: 'an empty code is no code',
  },
  {
    args: [
      {
        requests: [
          { path: '/other' },
          { method: 'POST', path: '/callback?code=x' },
          { path: '/callback?code=ok' },
        ],
        fetch: [okKey, { status: 500 }],
      },
    ],
    note: 'other paths and methods are 404; the callback then settles; the models list fails',
  },
  { args: [{ after: 'abort' }], note: 'the user cancels while the browser is open' },
  {
    args: [{ requests: [{ path: '/callback' }, { path: '/callback?code=again' }] }],
    note: 'a second callback is not served',
  },
  {
    args: [
      {
        after: 'abort-late',
        requests: [{ path: '/callback?code=abc' }],
        fetch: [okKey, { status: 500 }],
      },
    ],
    note: 'a cancel after the code came settles nothing: the first answer decides',
  },
  { args: [{ aborted: true }], note: 'cancelled before the browser opens: no browser is opened' },
  { args: [{ browser: 'refuse' }], note: 'no browser took the address' },
  { args: [{ browser: 'throw' }], note: 'the browser rejects' },
  {
    args: [{ after: 'timeout', timeoutMs: 40, requests: [] }],
    note: 'the browser never comes back',
  },
  {
    args: [{ requests: [{ path: '/callback?code=abc' }], fetch: [{ status: 403 }] }],
    note: 'the key exchange is denied',
  },
  {
    args: [{ requests: [{ path: '/callback?code=a%20b' }], fetch: [{ status: 400 }] }],
    note: 'denied with 400',
  },
  {
    args: [{ requests: [{ path: '/callback?code=abc' }], fetch: [{ status: 502 }] }],
    note: 'the key exchange fails: network',
  },
]

const connectOpenRouterFn: FnSpec = {
  ts: (a, cx) => runConnectOpenRouter(a[0] as ConnectSpec, cx.log),
  cases: connectCases,
}

const pageCases = [
  page(),
  page({ lang: 'ko', title: 'A & B', body: '<script>alert("x")</script>' }),
  page({ title: "it's", body: '' }),
  page({ lang: '"><x', title: '', body: 'a\'b"c<d>e&f' }),
]

const fetchCall = (
  spec: { fetch?: FetchStep[]; aborted?: boolean },
  cx: { log: (...a: unknown[]) => void },
) => ({
  fetchImpl: fakeFetch(spec.fetch, cx.log),
  signal: signalOf(spec.aborted),
})

const freeConnectFns: Group = {
  'ai-provider/free-connect.OPENROUTER_AUTH_URL': constant('https://openrouter.ai/auth'),
  'ai-provider/free-connect.OPENROUTER_KEYS_URL': constant(
    'https://openrouter.ai/api/v1/auth/keys',
  ),
  'ai-provider/free-connect.OPENROUTER_MODELS_URL': constant('https://openrouter.ai/api/v1/models'),
  'ai-provider/free-connect.OPENROUTER_KEY_INFO_URL': constant('https://openrouter.ai/api/v1/key'),
  'ai-provider/free-connect.GEMINI_MODELS_URL': constant(
    'https://generativelanguage.googleapis.com/v1beta/models',
  ),
  'ai-provider/free-connect.OPENROUTER_SIGN_IN_TIMEOUT_MS': constant(600000),
  'ai-provider/free-connect.pkcePair': {
    ts: async (a) => (await freeConnectModule(a[0] as string)).pkcePair(),
    cases: cases([HEX_A], [HEX_B], [HEX_C], ['00'.repeat(32)]),
  },
  'ai-provider/free-connect.openRouterAuthUrl': {
    ts: async (a) => (await freeConnectModule()).openRouterAuthUrl(a[0] as number, a[1] as string),
    cases: cases(
      [8080, 'abc'],
      [0, ''],
      [54321, 'a-b_c'],
      [1e21, 'x y'],
      [65535, 'chal+lenge/=&'],
      [4242, 'a*b.c~d!e'],
    ),
  },
  'ai-provider/free-connect.freeConnectPageHtml': {
    ts: async (a) => (await freeConnectModule()).freeConnectPageHtml(a[0] as J),
    cases: cases(...pageCases.map((p) => [p])),
  },
  'ai-provider/free-connect.plausibleApiKey': {
    ts: async (a) => (await freeConnectModule()).plausibleApiKey(a[0]),
    cases: cases(
      ['abcdefghijklmnopqrst'],
      ['  abcdefghijklmnopqrst  '],
      ['abcdefghijklmnopqrs'],
      ['a'.repeat(256)],
      ['a'.repeat(257)],
      ['abcdefghij klmnopqrstuv'],
      ['abcdefghijklmnopqrst\n'],
      ['abcdefghij.klmn_opqr-stuv'],
      ['abcdefghijklmnopqrst!'],
      [''],
      [5],
      [null],
      [],
    ),
  },
  'ai-provider/free-connect.exchangeOpenRouterCode': {
    ts: async (a, cx) => {
      const spec = a[2] as J
      const { fetchImpl, signal } = fetchCall(spec, cx)
      return (await freeConnectModule()).exchangeOpenRouterCode(
        a[0] as string,
        a[1] as string,
        fetchImpl,
        signal,
      )
    },
    cases: cases(
      ['code1', 'verifier1', { fetch: [okKey] }],
      ['c', 'v', { fetch: [{ status: 200, json: { key: '   ' } }] }],
      ['c', 'v', { fetch: [{ status: 200, json: { key: 5 } }] }],
      ['c', 'v', { fetch: [{ status: 200, json: {} }] }],
      ['c', 'v', { fetch: [{ status: 200, json: null }] }],
      ['c', 'v', { fetch: [{ status: 200, jsonThrows: true }] }],
      ['c', 'v', { fetch: [{ status: 400 }] }],
      ['c', 'v', { fetch: [{ status: 403 }] }],
      ['c', 'v', { fetch: [{ status: 401 }] }],
      ['c', 'v', { fetch: [{ status: 500 }] }],
      ['c', 'v', { fetch: [{ status: 302, location: 'https://evil.test/x' }] }],
      ['c', 'v', { fetch: [{ status: 200, opaque: true }] }],
      ['c', 'v', { fetch: [{ status: 307 }] }],
      ['c', 'v', { fetch: [{ throws: 'offline' }] }],
      ['c', 'v', { fetch: [{ throws: 'offline' }], aborted: true }],
      ['c', 'v', { fetch: [{ status: 200, jsonThrows: true }], aborted: true }],
    ),
  },
  'ai-provider/free-connect.pickOpenRouterFreeModel': {
    ts: async (a, cx) => {
      const spec = a[0] as J
      const { fetchImpl, signal } = fetchCall(spec, cx)
      return (await freeConnectModule()).pickOpenRouterFreeModel(fetchImpl, signal)
    },
    cases: cases(
      [
        {
          fetch: [
            modelsList([
              { id: 'google/gemma-4-31b-it:free', supported_parameters: tools },
              { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', supported_parameters: tools },
            ]),
          ],
        },
      ],
      [
        {
          fetch: [
            modelsList([
              {
                id: 'nvidia/nemotron-3-super-120b-a12b:free',
                supported_parameters: ['temperature'],
              },
              { id: 'google/gemma-4-31b-it:free', supported_parameters: tools },
            ]),
          ],
        },
      ],
      [
        {
          fetch: [
            modelsList([
              { id: 'x/short:free', context_length: 8000, supported_parameters: tools },
              { id: 'y/long:free', context_length: 128000, supported_parameters: tools },
              { id: 'z/paid', context_length: 999999, supported_parameters: tools },
            ]),
          ],
        },
      ],
      [
        {
          fetch: [
            modelsList([
              { id: 'x/a:free', context_length: 5, supported_parameters: tools },
              { id: 'y/b:free', supported_parameters: tools },
              { id: 'z/c:free', context_length: '9', supported_parameters: tools },
            ]),
          ],
        },
      ],
      [
        {
          fetch: [
            modelsList([
              { id: 'x/a:free', context_length: 'big', supported_parameters: tools },
              { id: 'y/b:free', context_length: 3, supported_parameters: tools },
            ]),
          ],
        },
      ],
      [
        {
          fetch: [
            modelsList([
              { id: 'x/a:free', context_length: 7, supported_parameters: tools },
              { id: 'y/b:free', context_length: 7, supported_parameters: tools },
            ]),
          ],
        },
      ],
      [
        {
          fetch: [
            modelsList([
              { id: 'x/nofree', supported_parameters: tools },
              { id: 5 },
              { id: 'x/b:free', supported_parameters: 'tools' },
            ]),
          ],
        },
      ],
      [{ fetch: [modelsList([])] }],
      [{ fetch: [modelsList('nope')] }],
      [{ fetch: [modelsList([null, { id: 'a:free', supported_parameters: tools }])] }],
      [{ fetch: [modelsList([{ id: 'a:free', supported_parameters: tools }, null])] }],
      [{ fetch: [{ status: 200, json: null }] }],
      [{ fetch: [{ status: 200, jsonThrows: true }] }],
      [{ fetch: [{ status: 503 }] }],
      [
        {
          fetch: [{ status: 503, json: { data: [{ id: 'a:free', supported_parameters: tools }] } }],
        },
      ],
      [{ fetch: [{ throws: 'offline' }] }],
    ),
  },
  'ai-provider/free-connect.connectOpenRouter': connectOpenRouterFn,
  'ai-provider/free-connect.connectGemini': {
    ts: async (a, cx) => {
      const spec = a[1] as J
      const { fetchImpl, signal } = fetchCall(spec, cx)
      return (await freeConnectModule()).connectGemini(a[0], fetchImpl, signal)
    },
    cases: cases(
      ['AIzaSyA1234567890abcdefgh', { fetch: [{ status: 200 }] }],
      ['  AIzaSyA1234567890abcdefgh  ', { fetch: [{ status: 204 }] }],
      ['AIzaSyA1234567890abcdefgh', { fetch: [{ status: 400 }] }],
      ['AIzaSyA1234567890abcdefgh', { fetch: [{ status: 401 }] }],
      ['AIzaSyA1234567890abcdefgh', { fetch: [{ status: 403 }] }],
      ['AIzaSyA1234567890abcdefgh', { fetch: [{ status: 404 }] }],
      ['AIzaSyA1234567890abcdefgh', { fetch: [{ status: 429 }] }],
      ['AIzaSyA1234567890abcdefgh', { fetch: [{ status: 302, location: 'https://evil.test' }] }],
      ['AIzaSyA1234567890abcdefgh', { fetch: [{ throws: 'offline' }] }],
      ['AIzaSyA1234567890abcdefgh', { fetch: [{ throws: 'offline' }], aborted: true }],
      ['too short', { fetch: [{ status: 200 }] }],
      [5, { fetch: [{ status: 200 }] }],
      [null, {}],
    ),
  },
  'ai-provider/free-connect.openRouterFreeQuota': {
    ts: async (a, cx) => {
      const spec = a[1] as J
      const { fetchImpl, signal } = fetchCall(spec, cx)
      return (await freeConnectModule()).openRouterFreeQuota(a[0] as string, fetchImpl, signal)
    },
    cases: cases(
      [
        'key1',
        {
          fetch: [
            {
              status: 200,
              json: { data: { free_model_daily_requests: { used: 3, limit: 50, remaining: 47 } } },
            },
          ],
        },
      ],
      [
        '  key1  ',
        {
          fetch: [
            {
              status: 200,
              json: {
                data: { free_model_daily_requests: { used: 0, limit: 0, remaining: 0, extra: 1 } },
              },
            },
          ],
        },
      ],
      ['', { fetch: [{ status: 200 }] }],
      ['   ', { fetch: [{ status: 200 }] }],
      [
        'key1',
        {
          fetch: [
            { status: 200, json: { data: { free_model_daily_requests: { used: 3, limit: 50 } } } },
          ],
        },
      ],
      [
        'key1',
        {
          fetch: [
            {
              status: 200,
              json: { data: { free_model_daily_requests: { used: -1, limit: 50, remaining: 1 } } },
            },
          ],
        },
      ],
      ['key1', { fetch: [{ status: 200, json: { data: { free_model_daily_requests: null } } }] }],
      ['key1', { fetch: [{ status: 200, json: { data: null } }] }],
      ['key1', { fetch: [{ status: 200, json: {} }] }],
      ['key1', { fetch: [{ status: 200, json: null }] }],
      ['key1', { fetch: [{ status: 200, jsonThrows: true }] }],
      ['key1', { fetch: [{ status: 401 }] }],
      [
        'key1',
        {
          fetch: [
            {
              status: 401,
              json: { data: { free_model_daily_requests: { used: 1, limit: 2, remaining: 1 } } },
            },
          ],
        },
      ],
      ['key1', { fetch: [{ status: 301, location: 'https://evil.test' }] }],
      ['key1', { fetch: [{ throws: 'offline' }] }],
    ),
  },
}

// ---------------------------------------------------------------------------
// file-parse (the diagram names behind the attachment list) and drawio-model
// ---------------------------------------------------------------------------

const attachable = await import('../../../packages/file-parse/src/attachable.ts')
const fileParseDiagram = await import('../../../packages/file-parse/src/diagram.ts')
const drawioFormat = await import('../../../packages/drawio-model/src/format.ts')

const DIAGRAM_NAMES = [
  'a.drawio',
  'A.DRAWIO',
  'a.dio',
  'a.drawio.svg',
  'a.drawio.png',
  'A.Drawio.PNG',
  'a.vsdx',
  'a.VSDX',
  'a.svg',
  'a.png',
  'drawio',
  '.drawio',
  'a.drawio.svg.bak',
  'a.drawio.jpg',
  'dir/sub.drawio.png',
  'dir\\\\sub.drawio.svg',
  '',
]

/** `diagramPictureExtOf` with the diagram engine behind a stub that reads the file's first word */
async function diagramPictureExtModule(): Promise<J> {
  return loadPatched('packages/file-parse/src/diagram.ts', (src) =>
    must(
      src,
      'extractDiagramXml(basename(filePath), readFileSync(filePath), nodePageCodec)',
      '(globalThis as any).__b5Diagram.extract(readFileSync(filePath).toString("utf8"))',
      'diagram.ts',
    ),
  )
}

const fileParseFns: Group = {
  'drawio-model/format.detectDiagramFormat': {
    ts: (a) => drawioFormat.detectDiagramFormat(a[0] as string),
    cases: cases(...DIAGRAM_NAMES.map((n) => [n])),
  },
  'file-parse/attachable.diagramPictureExtOfName': {
    ts: (a) => attachable.diagramPictureExtOfName(a[0] as string),
    cases: cases(...DIAGRAM_NAMES.map((n) => [n])),
  },
  'file-parse/diagram.diagramFormatOf': {
    ts: (a) => fileParseDiagram.diagramFormatOf(a[0] as string),
    cases: cases(...DIAGRAM_NAMES.map((n) => [`/docs/${n}`])),
  },
  'file-parse/diagram.diagramPictureExtOf': {
    ts: async (a) => {
      g.__b5Diagram = {
        extract: (text: string) => {
          if (text.startsWith('THROW')) throw new Error('unreadable')
          return text.startsWith('NOORIG') ? { ok: false, reason: 'no_original' } : { ok: true }
        },
      }
      return (await diagramPictureExtModule()).diagramPictureExtOf(a[0] as string)
    },
    cases: [
      {
        args: ['$DIR/a.drawio.svg'],
        files: { 'a.drawio.svg': '<svg>diagram</svg>' },
        note: 'holds its diagram',
      },
      {
        args: ['$DIR/b.drawio.png'],
        files: { 'b.drawio.png': 'NOORIG picture only' },
        note: 'only carries the name',
      },
      {
        args: ['$DIR/c.DRAWIO.PNG'],
        files: { 'c.DRAWIO.PNG': 'THROW' },
        note: 'the extraction throws',
      },
      { args: ['$DIR/missing.drawio.svg'], note: 'a file that is gone keeps its name' },
      {
        args: ['$DIR/d.drawio.svg'],
        files: { 'd.drawio.svg': { text: 'NOORIG' + 'x'.repeat(50 * 1024 * 1024) } },
        note: 'past the attachment cap: not read',
      },
      {
        args: ['$DIR/e.drawio.svg'],
        files: { 'e.drawio.svg': { text: 'NOORIG' + 'x'.repeat(50 * 1024 * 1024 - 6) } },
        note: 'at the cap: read',
      },
      {
        args: ['$DIR/f.drawio'],
        files: { 'f.drawio': 'NOORIG' },
        note: 'a plain diagram is no picture',
      },
      { args: ['$DIR/g.png'], files: { 'g.png': 'NOORIG' }, note: 'any other name' },
      {
        args: ['$DIR/dir.drawio.svg'],
        files: { 'dir.drawio.svg': { dir: true } },
        note: 'a folder with the name',
      },
    ],
  },
}

export const providerGroup: Group = {
  ...fileParseFns,
  ...contractFns,
  ...mediaFns,
  ...imageBackendFns,
  ...registryFns,
  ...freeAiFns,
  ...freeConnectFns,
}
