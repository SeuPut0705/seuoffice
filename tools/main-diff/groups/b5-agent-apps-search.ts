/**
 * The pieces of `packages/ai-search/src` that the editors' AI modules and the
 * Slides AI part need: `index` (the environment key of a backend, the picture
 * filter), `media-call-abort`, `media-tools` (the settings file, the media
 * budget and roots), `search-tools`, `tool-routing`, `tool-capabilities`.
 *
 * - The process variables the search backends read are set from the case's
 *   `env` (every other one is cleared); the module state of the routing
 *   (`codexImageAvailable`, the registered Codex generator) is the case's
 *   `state: { available, generator }`, set before every call.
 * - search-tools runs against a fake `webSearch`/`imageSearch`: the case's
 *   `answers` are taken one per call (`{ ok }` or `{ throw }`), each call logs
 *   `["web" | "image", query, max, options]`.
 * - media-call-abort: steps `begin`, `destroy`, `abort`, `end` over fake
 *   windows; every step answers which calls are aborted.
 */
import type { Case, FnSpec, Group } from '../types.ts'
import {
  NO_SEARCH_ENV,
  cases,
  fakeSender,
  g,
  loadPatched,
  must,
  tick,
  withEnv,
  type J,
} from './b5-agent-apps-lib.ts'

const aiIndex = await import('../../../packages/ai-search/src/index.ts')
const mediaAbort = await import('../../../packages/ai-search/src/media-call-abort.ts')
const mediaTools = await import('../../../packages/ai-search/src/media-tools.ts')
const toolRouting = await import('../../../packages/ai-search/src/tool-routing.ts')
const toolCapabilities = await import('../../../packages/ai-search/src/tool-capabilities.ts')
const codexGenerator = await import('../../../packages/ai-search/src/codex-image-generator.ts')
const imageBackend = await import('../../../packages/ai-provider/src/image-backend.ts')
const legacy = await import('../../../packages/ai-provider/src/legacy-settings.ts')

const constant = (value: unknown): FnSpec => ({
  ts: () => value,
  cases: [{ args: [] }],
  single: 'a constant',
})

/** the settings the tools route on: a partial file read the way the app reads it */
// a file without `providers` is the pre-provider shape, read as one custom endpoint
const norm = (partial: object): J => legacy.normalizeAiSettings({ providers: {}, ...partial })

// ---------------------------------------------------------------------------
// index
// ---------------------------------------------------------------------------

const BACKENDS = [
  'serper',
  'serply',
  'searchapi',
  'tavily',
  'parallel',
  'exa',
  'firecrawl',
  'keenable',
]
const ENV_NAME: Record<string, string> = {
  serper: 'SERPER_API_KEY',
  serply: 'SERPLY_API_KEY',
  searchapi: 'SEARCHAPI_API_KEY',
  tavily: 'TAVILY_API_KEY',
  parallel: 'PARALLEL_API_KEY',
  exa: 'EXA_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
  keenable: 'KEENABLE_API_KEY',
}

const indexFns: Group = {
  'ai-search/index.MIN_USABLE_IMAGE_PX': constant(aiIndex.MIN_USABLE_IMAGE_PX),
  'ai-search/index.searchEnvKey': {
    ts: (a) =>
      withEnv({ ...NO_SEARCH_ENV, ...(a[1] as Record<string, string>) }, () =>
        aiIndex.searchEnvKey(a[0] as 'serper'),
      ),
    cases: [
      ...BACKENDS.map((backend): Case => ({
        args: [backend, { [ENV_NAME[backend]!]: `key-${backend}` }],
      })),
      { args: ['serper', { SERPER_API_KEY: '  spaced key \n' }] },
      { args: ['serper', {}] },
      { args: ['exa', { SERPER_API_KEY: 'other' }] },
      { args: ['nope', { SERPER_API_KEY: 'other' }] },
    ],
  },
  'ai-search/index.filterUsableImages': {
    ts: (a) => aiIndex.filterUsableImages(a[0] as J),
    cases: cases(
      [
        [
          { url: 'a' },
          { url: 'b', width: 100, height: 500 },
          { url: 'c', width: 500, height: 500 },
        ],
      ],
      [
        [
          { url: 'a', width: 200, height: 200 },
          { url: 'b', width: 199, height: 200 },
          { url: 'c', width: 200, height: 199 },
        ],
      ],
      [
        [
          { url: 'a', width: 300 },
          { url: 'b', height: 150 },
          { url: 'c', height: 400 },
        ],
      ],
      [
        [
          { url: 'a', width: null, height: null },
          { url: 'b', width: null, height: 100 },
        ],
      ],
      [
        [
          { url: 'a', width: '300', height: 300 },
          { url: 'b', width: '3', height: 300 },
          { url: 'c', width: 'x', height: 300 },
        ],
      ],
      [
        [
          { url: 'a', width: 300, height: '250' },
          { url: 'b', width: 300, height: 'x' },
        ],
      ],
      [[]],
    ),
  },
}

// ---------------------------------------------------------------------------
// media-call-abort
// ---------------------------------------------------------------------------

interface AbortStep {
  begin?: string
  sender?: number
  destroyed?: boolean
  destroy?: number
  abort?: number
  end?: string
}

async function runMediaAbort(steps: AbortStep[]): Promise<unknown> {
  const senders = new Map<number, J>()
  const senderOf = (id: number, destroyed: boolean): J => {
    let s = senders.get(id)
    if (!s) {
      s = fakeSender(id, destroyed)
      senders.set(id, s)
    }
    if (destroyed) s.destroyed = true
    return s
  }
  const signals = new Map<string, AbortSignal>()
  const gates = new Map<string, () => void>()
  const running: Promise<unknown>[] = []
  const answers: unknown[] = []
  for (const step of steps) {
    if (step.begin !== undefined) {
      const name = step.begin
      const sender = senderOf(step.sender ?? 1, step.destroyed ?? false)
      running.push(
        mediaAbort.withMediaCallSignal(
          sender,
          (signal: AbortSignal) =>
            new Promise<void>((resolve) => {
              signals.set(name, signal)
              gates.set(name, resolve)
            }),
        ),
      )
    } else if (step.destroy !== undefined) {
      senderOf(step.destroy, false).destroy()
    } else if (step.abort !== undefined) {
      mediaAbort.abortMediaCalls(step.abort)
    } else if (step.end !== undefined) {
      gates.get(step.end)?.()
    }
    await tick()
    answers.push(Object.fromEntries([...signals].map(([name, signal]) => [name, signal.aborted])))
  }
  for (const gate of gates.values()) gate()
  await Promise.all(running)
  return answers
}

const abortCases: Case[] = [
  {
    args: [[{ begin: 'a' }, { begin: 'b', sender: 2 }, { abort: 1 }, { end: 'a' }, { abort: 2 }]],
    note: 'a stop names its window only',
  },
  {
    args: [[{ begin: 'a' }, { begin: 'b' }, { abort: 1 }, { begin: 'c' }]],
    note: 'both calls of a window end; a later one is fresh',
  },
  {
    args: [[{ begin: 'a' }, { destroy: 1 }, { begin: 'b' }]],
    note: 'a destroyed window ends its call; a call started after is aborted at once',
  },
  {
    args: [
      [
        { begin: 'a', destroyed: true },
        { begin: 'b', sender: 2 },
      ],
    ],
    note: 'a window destroyed before the call',
  },
  {
    args: [[{ begin: 'a' }, { end: 'a' }, { destroy: 1 }, { abort: 1 }]],
    note: 'a call that settled is no longer reached',
  },
  {
    args: [[{ begin: 'a' }, { end: 'a' }, { begin: 'b' }, { abort: 1 }]],
    note: 'the window is forgotten, then known again',
  },
  { args: [[{ abort: 7 }, { begin: 'a', sender: 7 }, { abort: 8 }]], note: 'nothing to stop' },
  {
    args: [[{ begin: 'a' }, { begin: 'b', sender: 2 }, { destroy: 1 }, { abort: 2 }]],
    note: 'a window that goes away takes its own calls only',
  },
  {
    args: [[{ begin: 'a' }, { begin: 'b' }, { end: 'a' }, { abort: 1 }]],
    note: 'a call that settled leaves the other one of its window in flight',
  },
]

const mediaAbortFns: Group = {
  'ai-search/media-call-abort.withMediaCallSignal': {
    ts: (a) => runMediaAbort(a[0] as AbortStep[]),
    cases: abortCases,
  },
  'ai-search/media-call-abort.abortMediaCalls': {
    ts: (a) => runMediaAbort(a[0] as AbortStep[]),
    cases: [
      { args: [[{ begin: 'a' }, { begin: 'b' }, { abort: 1 }]] },
      { args: [[{ begin: 'a' }, { abort: 2 }, { abort: 1 }]] },
      {
        args: [
          [{ begin: 'a' }, { begin: 'b', sender: 2 }, { abort: 2 }, { end: 'b' }, { abort: 1 }],
        ],
      },
      {
        args: [[{ begin: 'a' }, { begin: 'b' }, { end: 'a' }, { abort: 1 }]],
        note: 'a call that settled leaves the other one of its window in flight',
      },
    ],
  },
}

// ---------------------------------------------------------------------------
// media-tools
// ---------------------------------------------------------------------------

const settingsFileCases: Case[] = [
  {
    args: ['$DIR/ai-settings.json'],
    files: {
      'ai-settings.json': JSON.stringify({
        provider: 'anthropic',
        providers: { anthropic: { apiKey: 'k', model: 'm' } },
      }),
    },
  },
  { args: ['$DIR/missing.json'], note: 'no file: the defaults' },
  {
    args: ['$DIR/ai-settings.json'],
    files: { 'ai-settings.json': '{not json' },
    note: 'a broken file reads as no file',
  },
  {
    args: ['$DIR/ai-settings.json'],
    files: { 'ai-settings.json': '[1,2]' },
    note: 'a file that is not an object',
  },
  {
    args: ['$DIR/ai-settings.json'],
    files: {
      'ai-settings.json': JSON.stringify({
        providers: {},
        search: { provider: 'serper', providers: { serper: { apiKey: ' sk ' } } },
      }),
    },
  },
  {
    args: ['$DIR/dir.json'],
    files: { 'dir.json': { dir: true } },
    note: 'a folder cannot be read',
  },
]

const realCases: Case[] = [
  { args: ['$DIR/docs/a.png', ['$DIR/docs']], files: { 'docs/a.png': 'x' } },
  {
    args: ['$DIR/docs/a.png', ['$DIR/other']],
    files: { 'docs/a.png': 'x', 'other/b.png': 'y' },
    note: 'outside the roots',
  },
  {
    args: ['$DIR/docs/a.png', []],
    files: { 'docs/a.png': 'x' },
    note: 'no roots: the extension check alone',
  },
  {
    args: ['$DIR/docs-evil/a.png', ['$DIR/docs']],
    files: { 'docs/a.png': 'x', 'docs-evil/a.png': 'y' },
    note: 'a sibling that shares the prefix',
  },
  { args: ['$DIR/docs/missing.png', ['$DIR/docs']], files: { 'docs/a.png': 'x' }, note: 'missing' },
  { args: ['$DIR/docs', ['$DIR/docs']], files: { 'docs/a.png': 'x' }, note: 'the root itself' },
  {
    args: ['$DIR/docs/a.png', ['$DIR/nope', '$DIR/docs']],
    files: { 'docs/a.png': 'x' },
    note: 'a root that is missing is passed over',
  },
  {
    args: ['$DIR/docs/a.png', ['$DIR/nope']],
    files: { 'docs/a.png': 'x' },
    note: 'every root missing',
  },
]

const mediaToolsFns: Group = {
  'ai-search/media-tools.MEDIA_BUDGET': constant(mediaTools.MEDIA_BUDGET),
  'ai-search/media-tools.readAiSettingsFile': {
    ts: (a) => mediaTools.readAiSettingsFile(a[0] as string),
    cases: settingsFileCases,
  },
  'ai-search/media-tools.localMediaRoots': {
    ts: (a) => mediaTools.localMediaRoots(...(a as (string | null | undefined)[])),
    cases: cases([], ['/a'], ['/a', '', null, '/b'], [null, null], ['', '/c']),
  },
  'ai-search/media-tools.documentMediaRoots': {
    ts: (a) => mediaTools.documentMediaRoots(a[0] as string | null, a[1] as string | null),
    cases: cases(
      ['/docs/work/a.docx', '/tmp/seuoffice-pasted'],
      [null, '/tmp/seuoffice-pasted'],
      ['', ''],
      ['/docs/work/a.docx', null],
      ['a.docx', '/p'],
      ['/a.docx', '/p'],
    ),
  },
  'ai-search/media-tools.isLocalMediaPathAllowed': {
    ts: (a) => mediaTools.isLocalMediaPathAllowed(a[0] as string, a[1] as string[]),
    cases: realCases,
  },
}

// ---------------------------------------------------------------------------
// search-tools
// ---------------------------------------------------------------------------

async function searchToolsModule(): Promise<J> {
  return loadPatched('packages/ai-search/src/search-tools.ts', (src) =>
    must(
      src,
      "import { imageSearch, searchEnvKey, webSearch, type SearchOptions } from './index'",
      [
        "import { searchEnvKey, type SearchOptions } from './index'",
        'const webSearch = (...a: any[]): any => (globalThis as any).__b5Search.call("web", ...a)',
        'const imageSearch = (...a: any[]): any => (globalThis as any).__b5Search.call("image", ...a)',
      ].join('\n'),
      'search-tools.ts',
    ),
  )
}

interface SearchAnswer {
  ok?: unknown
  throw?: string
}

function useSearch(answers: SearchAnswer[] | undefined, log: (...args: unknown[]) => void): void {
  const queue = [...(answers ?? [])]
  g.__b5Search = {
    call: async (kind: string, query: string, max: number, options: J) => {
      log(kind, query, max, options)
      const answer = queue.shift() ?? { ok: { results: [], method: 'none' } }
      if (answer.throw !== undefined) throw new Error(answer.throw)
      return answer.ok
    },
  }
}

const SEARCH_SETTINGS: J[] = [
  {},
  { search: { provider: 'keenable' } },
  { search: { provider: 'parallel' } },
  { search: { provider: 'parallel', providers: { parallel: { apiKey: ' pk ' } } } },
  { search: { provider: 'serper', providers: { serper: { apiKey: ' sk ' } } } },
  { search: { provider: 'serper' } },
  { search: { provider: 'serply', providers: { serply: { apiKey: 'sp' } } } },
  { search: { provider: 'searchapi', providers: { searchapi: { apiKey: 'sa' } } } },
  { search: { provider: 'tavily', providers: { tavily: { apiKey: 'tv' } } } },
  { search: { provider: 'exa', providers: { exa: { apiKey: 'ex' } } } },
  { search: { provider: 'firecrawl', providers: { firecrawl: { apiKey: 'fc' } } } },
  { search: { provider: 'keenable', providers: { keenable: { apiKey: 'kn' } } } },
  { search: { provider: 'nope', providers: { nope: { apiKey: 'x' } } } },
  { search: { provider: 'serper', providers: { serper: { apiKey: '  ' } } } },
  { search: { provider: 'exa', providers: null } },
]

const SEARCH_ENVS: Record<string, string>[] = [
  {},
  { SERPER_API_KEY: ' env-serper ', EXA_API_KEY: 'env-exa', PARALLEL_API_KEY: 'env-par' },
]

const searchSettingsCases = (): Case[] =>
  SEARCH_SETTINGS.flatMap((settings) => SEARCH_ENVS.map((env): Case => ({ args: [settings, env] })))

const searchFns: Group = {
  'ai-search/search-tools.keylessSearchBackend': {
    ts: async (a) => (await searchToolsModule()).keylessSearchBackend(a[0] as J),
    cases: SEARCH_SETTINGS.map((settings): Case => ({ args: [settings] })),
  },
  'ai-search/search-tools.selectedSearchKey': {
    ts: async (a) =>
      withEnv({ ...NO_SEARCH_ENV, ...(a[1] as Record<string, string>) }, async () =>
        (await searchToolsModule()).selectedSearchKey(a[0] as J),
      ),
    cases: searchSettingsCases(),
  },
  'ai-search/search-tools.searchOptionsFromSettings': {
    ts: async (a) =>
      withEnv({ ...NO_SEARCH_ENV, ...(a[1] as Record<string, string>) }, async () =>
        (await searchToolsModule()).searchOptionsFromSettings(a[0] as J),
      ),
    cases: searchSettingsCases(),
  },
  'ai-search/search-tools.webSearchTool': {
    ts: async (a, cx) => {
      const spec = a[0] as {
        answers?: SearchAnswer[]
        query: string
        max?: number
        env?: Record<string, string>
      }
      useSearch(spec.answers, cx.log)
      const mod = await searchToolsModule()
      return withEnv({ ...NO_SEARCH_ENV, ...spec.env }, async () =>
        spec.max === undefined
          ? mod.webSearchTool(a[1] as string, spec.query)
          : mod.webSearchTool(a[1] as string, spec.query, spec.max),
      )
    },
    cases: [
      {
        args: [
          { query: 'cats', answers: [{ ok: { results: [1], method: 'parallel' } }] },
          '$DIR/s.json',
        ],
        files: { 's.json': '{}' },
      },
      {
        args: [{ query: 'cats', max: 3 }, '$DIR/s.json'],
        files: {
          's.json': JSON.stringify({
            providers: {},
            search: { provider: 'serper', providers: { serper: { apiKey: 'sk' } } },
          }),
        },
      },
      { args: [{ query: 'q', max: 0 }, '$DIR/missing.json'], note: 'no settings file' },
      {
        args: [{ query: 'q', answers: [{ throw: 'down' }] }, '$DIR/s.json'],
        files: { 's.json': '{}' },
        note: 'the backend rejects',
      },
      {
        args: [{ query: 'q', env: { EXA_API_KEY: 'env' } }, '$DIR/s.json'],
        files: { 's.json': JSON.stringify({ providers: {}, search: { provider: 'exa' } }) },
        note: 'the environment stands in for the key',
      },
    ],
  },
  'ai-search/search-tools.imageSearchTool': {
    ts: async (a, cx) => {
      const spec = a[0] as { answers?: SearchAnswer[]; query: string; max?: number }
      useSearch(spec.answers, cx.log)
      const mod = await searchToolsModule()
      return withEnv(NO_SEARCH_ENV, async () =>
        spec.max === undefined
          ? mod.imageSearchTool(a[1] as string, spec.query)
          : mod.imageSearchTool(a[1] as string, spec.query, spec.max),
      )
    },
    cases: [
      {
        args: [
          { query: 'dogs', answers: [{ ok: { images: [], method: 'duckduckgo' } }] },
          '$DIR/s.json',
        ],
        files: { 's.json': '{}' },
      },
      {
        args: [{ query: 'dogs', max: 2 }, '$DIR/s.json'],
        files: {
          's.json': JSON.stringify({
            providers: {},
            search: { provider: 'serply', providers: { serply: { apiKey: 'sp' } } },
          }),
        },
      },
      { args: [{ query: 'dogs', answers: [{ throw: 'down' }] }, '$DIR/missing.json'] },
    ],
  },
  'ai-search/search-tools.testSearchProvider': {
    ts: async (a, cx) => {
      useSearch(a[2] as SearchAnswer[] | undefined, cx.log)
      const mod = await searchToolsModule()
      return withEnv(NO_SEARCH_ENV, () => mod.testSearchProvider(a[0] as 'serper', a[1] as string))
    },
    cases: cases(
      ['serper', 'sk', [{ ok: { results: [], method: 'serper' } }]],
      ['serper', '  sk  ', [{ ok: { results: [], method: 'serper' } }]],
      ['serper', '   ', []],
      ['exa', '', []],
      ['parallel', '', [{ ok: { results: [], method: 'parallel' } }]],
      ['keenable', '', [{ ok: { results: [], method: 'duckduckgo' } }]],
      ['tavily', 'tk', [{ ok: { results: [], method: 'duckduckgo' } }]],
      ['firecrawl', 'fk', [{ ok: { results: [], method: 'error', error: 'quota' } }]],
      ['searchapi', 'ak', [{ ok: { results: [], method: 'error' } }]],
      ['serply', 'ak', [{ ok: { results: [] } }]],
      ['serply', 'ak', [{ throw: 'network' }]],
    ),
  },
}

// ---------------------------------------------------------------------------
// tool-routing and tool-capabilities
// ---------------------------------------------------------------------------

interface RouteState {
  available: boolean
  generator: boolean
}

function withRouting<T>(state: RouteState, run: () => T): T {
  imageBackend.setCodexImageGenerationAvailable(state.available)
  codexGenerator.registerCodexImageGenerator(
    state.generator ? async () => ({ url: 'file:///x.png' }) : null,
  )
  try {
    return run()
  } finally {
    imageBackend.setCodexImageGenerationAvailable(false)
    codexGenerator.registerCodexImageGenerator(null)
  }
}

const READY = (provider: string): J => ({ provider, state: 'ready', meteredAccepted: false })
const METERED = (provider: string): J => ({ provider, state: 'metered', meteredAccepted: true })

const mediaSet = (over: J): J => ({
  imageProvider: 'codex',
  analysisProvider: 'chat',
  videoAnalysisProvider: 'none',
  providers: {
    openai: { apiKey: 'sk-o', imageModel: 'gpt-image-2', analysisModel: 'gpt-5.6-luna' },
    gemini: { apiKey: 'gk', imageModel: '', analysisModel: '' },
    custom: { apiKey: '', baseUrl: 'https://llm.test/v1', imageModel: '', analysisModel: '' },
    deepseek: { apiKey: 'dk', imageModel: '', analysisModel: '' },
  },
  ...over,
})

const ROUTE_SETTINGS: J[] = [
  norm({}),
  norm({
    provider: 'anthropic',
    providers: { anthropic: { apiKey: 'k', model: 'claude-sonnet-5-5' } },
  }),
  norm({ provider: 'glm', providers: { glm: { apiKey: 'k', model: 'glm-4.6' } } }),
  norm({
    provider: 'deepseek',
    providers: { deepseek: { apiKey: 'k', model: 'deepseek-v4-pro' } },
  }),
  norm({ provider: 'codex', subscriptionOff: { codex: true } }),
  norm({
    media: mediaSet({
      imageProvider: 'openai',
      analysisProvider: 'gemini',
      videoAnalysisProvider: 'gemini',
    }),
  }),
  norm({
    media: mediaSet({
      imageProvider: 'none',
      analysisProvider: 'custom',
      videoAnalysisProvider: 'custom',
    }),
  }),
  norm({
    headlessSubscriptionEnabled: true,
    headlessSubscriptionConsentVersion: 2,
    provider: 'codex',
  }),
  norm({
    headlessSubscriptionEnabled: true,
    headlessSubscriptionConsentVersion: 1,
    provider: 'codex',
  }),
  norm({ metered: 1, meteredAccepted: { codex: true }, provider: 'codex' }),
  norm({ provider: 'claude-code', subscriptionOff: { 'claude-code': true } }),
  norm({ provider: 'claude-code' }),
  norm({
    media: mediaSet({
      imageProvider: 'none',
      analysisProvider: 'custom',
      videoAnalysisProvider: 'custom',
      providers: {
        custom: {
          apiKey: 'ck',
          baseUrl: 'https://llm.test/v1',
          imageModel: '',
          analysisModel: 'my-vision',
        },
      },
    }),
  }),
  norm({
    media: mediaSet({
      imageProvider: 'none',
      analysisProvider: 'openai',
      videoAnalysisProvider: 'none',
    }),
  }),
  norm({
    media: mediaSet({ analysisProvider: 'chat', videoAnalysisProvider: 'gemini' }),
  }),
]

const ROUTE_CONTEXTS: (J | null)[] = [
  null,
  { path: 'screen' },
  { path: 'screen', statuses: { codex: READY('codex') } },
  {
    path: 'screen',
    statuses: {
      'claude-code': READY('claude-code'),
      codex: READY('codex'),
      chatgpt: READY('chatgpt'),
    },
  },
  { path: 'screen', statuses: { codex: METERED('codex') } },
  { path: 'headless', statuses: { codex: READY('codex') } },
  { path: 'headless', statuses: { codex: READY('codex') }, dataDir: '/d' },
  {
    path: 'headless',
    statuses: { codex: METERED('codex'), chatgpt: READY('chatgpt') },
    dataDir: '/d',
  },
  { path: 'headless', dataDir: '' },
]

const ROUTE_STATES: RouteState[] = [
  { available: false, generator: false },
  { available: true, generator: false },
  { available: true, generator: true },
  { available: false, generator: true },
]

/** a generator is registered in a build that does not offer Codex image generation */
const genOnlyCases = (): Case[] =>
  [ROUTE_SETTINGS[0]!, ROUTE_SETTINGS[10]!].flatMap((settings) =>
    [ROUTE_CONTEXTS[2]!, ROUTE_CONTEXTS[3]!].map((context): Case => ({
      args: [settings, context, ROUTE_STATES[3]!],
    })),
  )

/** every settings against every context, two of the states */
const routeCases = (): Case[] =>
  ROUTE_SETTINGS.flatMap((settings) =>
    ROUTE_CONTEXTS.flatMap((context) =>
      [ROUTE_STATES[0]!, ROUTE_STATES[2]!].map((state): Case => ({
        args: [settings, context, state],
      })),
    ),
  )

const withContext = <T>(context: J | null, run: (c: J) => T, none: () => T): T =>
  context === null ? none() : run(context)

const routingFns: Group = {
  'ai-search/tool-routing.headlessSubscriptionBlocked': {
    ts: (a) => toolRouting.headlessSubscriptionBlocked(a[0] as J, a[1] as J),
    cases: ROUTE_SETTINGS.flatMap((settings): Case[] =>
      ROUTE_CONTEXTS.filter((c) => c !== null).map((context): Case => ({
        args: [settings, context],
      })),
    ),
  },
  'ai-search/tool-routing.codexImageRouteOffered': {
    ts: (a) => withRouting(a[0] as RouteState, () => toolRouting.codexImageRouteOffered()),
    cases: ROUTE_STATES.map((state): Case => ({ args: [state] })),
  },
  'ai-search/tool-routing.resolveImageRoute': {
    ts: (a) =>
      withRouting(a[2] as RouteState, () =>
        withContext(
          a[1] as J,
          (c) => toolRouting.resolveImageRoute(a[0] as J, c),
          () => toolRouting.resolveImageRoute(a[0] as J),
        ),
      ),
    cases: [...routeCases(), ...genOnlyCases()],
  },
  'ai-search/tool-routing.imageGenerationUnavailableMessage': {
    ts: (a) =>
      withRouting(a[2] as RouteState, () =>
        withContext(
          a[1] as J,
          (c) => toolRouting.imageGenerationUnavailableMessage(a[0] as J, c),
          () => toolRouting.imageGenerationUnavailableMessage(a[0] as J),
        ),
      ),
    cases: [...routeCases(), ...genOnlyCases()],
  },
  'ai-search/tool-routing.resolveImageAnalysisRoute': {
    ts: (a) =>
      withRouting(a[2] as RouteState, () =>
        withContext(
          a[1] as J,
          (c) => toolRouting.resolveImageAnalysisRoute(a[0] as J, c),
          () => toolRouting.resolveImageAnalysisRoute(a[0] as J),
        ),
      ),
    cases: routeCases(),
  },
  'ai-search/tool-routing.resolveVideoAnalysisRoute': {
    ts: (a) => toolRouting.resolveVideoAnalysisRoute(a[0] as J),
    cases: ROUTE_SETTINGS.map((settings): Case => ({ args: [settings] })),
  },
}

const CAP_SETTINGS: unknown[] = [
  null,
  {},
  { providers: {} },
  { provider: 'anthropic', providers: { anthropic: { apiKey: 'k', model: 'claude-sonnet-5-5' } } },
  { provider: 'glm', providers: { glm: { apiKey: 'k', model: 'glm-4.6' } } },
  { providers: {}, search: { provider: 'serper', providers: { serper: { apiKey: 'sk' } } } },
  { providers: {}, search: { provider: 'serply', providers: { serply: { apiKey: 'sp' } } } },
  { providers: {}, search: { provider: 'exa', providers: { exa: { apiKey: 'ex' } } } },
  { providers: {}, search: { provider: 'keenable' } },
  { providers: {}, search: { provider: 'serper' } },
  {
    providers: {},
    media: mediaSet({
      imageProvider: 'openai',
      analysisProvider: 'gemini',
      videoAnalysisProvider: 'gemini',
    }),
  },
  {
    providers: {},
    media: mediaSet({
      imageProvider: 'none',
      analysisProvider: 'custom',
      videoAnalysisProvider: 'custom',
    }),
  },
  { providers: {}, provider: 'codex', subscriptionOff: { codex: true } },
]

const CAP_CONTEXTS: (J | null)[] = [
  null,
  { path: 'screen', statuses: { codex: READY('codex') } },
  { path: 'screen', statuses: { codex: METERED('codex') } },
  { path: 'headless', statuses: { codex: READY('codex') } },
]

const capCases = (): Case[] =>
  CAP_SETTINGS.flatMap((settings) =>
    CAP_CONTEXTS.flatMap((context) =>
      [
        { state: ROUTE_STATES[0]!, env: {} },
        { state: ROUTE_STATES[2]!, env: { SERPER_API_KEY: 'env-serper' } },
      ].map(({ state, env }): Case => ({ args: [settings, context, state, env] })),
    ),
  )

/** what the matrix above leaves out: each route kind the report names, one by one */
const extraCapCases = (): Case[] => {
  const screen = (statuses: J): J => ({ path: 'screen', statuses })
  const custom = (analysisModel: string): J => ({
    providers: {},
    media: mediaSet({
      imageProvider: 'none',
      analysisProvider: 'custom',
      videoAnalysisProvider: 'custom',
      providers: {
        custom: { apiKey: 'ck', baseUrl: 'https://llm.test/v1', imageModel: '', analysisModel },
      },
    }),
  })
  const sets: [J, J | null, RouteState][] = [
    [
      { providers: {}, provider: 'claude-code' },
      screen({ 'claude-code': READY('claude-code') }),
      ROUTE_STATES[0]!,
    ],
    [
      { providers: {}, provider: 'codex', meteredAccepted: { codex: true } },
      screen({ codex: METERED('codex') }),
      ROUTE_STATES[0]!,
    ],
    [
      {
        providers: {},
        search: { provider: 'searchapi', providers: { searchapi: { apiKey: 'sa' } } },
      },
      null,
      ROUTE_STATES[0]!,
    ],
    [{ providers: {} }, screen({ codex: READY('codex') }), ROUTE_STATES[3]!],
    [
      { providers: {}, provider: 'claude-code', subscriptionOff: { 'claude-code': true } },
      screen({ codex: READY('codex') }),
      ROUTE_STATES[2]!,
    ],
    [custom('my-vision'), null, ROUTE_STATES[0]!],
    [
      {
        providers: {},
        media: mediaSet({
          imageProvider: 'none',
          analysisProvider: 'openai',
          videoAnalysisProvider: 'none',
        }),
      },
      null,
      ROUTE_STATES[0]!,
    ],
    [
      {
        providers: {},
        media: mediaSet({ analysisProvider: 'chat', videoAnalysisProvider: 'gemini' }),
      },
      null,
      ROUTE_STATES[0]!,
    ],
  ]
  return sets.map(([settings, context, state]): Case => ({ args: [settings, context, state, {}] }))
}

const capabilityFns: Group = {
  'ai-search/tool-capabilities.aiToolCapabilities': {
    ts: (a) =>
      withEnv({ ...NO_SEARCH_ENV, ...(a[3] as Record<string, string>) }, () =>
        withRouting(a[2] as RouteState, () =>
          withContext(
            a[1] as J,
            (c) => toolCapabilities.aiToolCapabilities(a[0] as J, c),
            () => toolCapabilities.aiToolCapabilities(a[0] as J),
          ),
        ),
      ),
    cases: [...capCases(), ...extraCapCases()],
  },
}

export const searchGroup: Group = {
  ...indexFns,
  ...mediaAbortFns,
  ...mediaToolsFns,
  ...searchFns,
  ...routingFns,
  ...capabilityFns,
}
