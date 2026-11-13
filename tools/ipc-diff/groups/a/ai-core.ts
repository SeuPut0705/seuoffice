/**
 * Group `a/ai-core`: the shared AI channels (`registerAiIpc` of
 * `apps/docs/src/main/docs-main.ts`: settings, streams, chat, model lists,
 * search, the page reader) and the per-app channels the entries answer
 * themselves (`docs:consume-ai-doc-content` of docs-main,
 * `sheets:ai-tool-capabilities` of sheets-main).
 *
 * docs-main and sheets-main start a whole app when imported, so they are not
 * loaded. The statements that answer the group's channels (and the small
 * functions and constants they use) are taken from their sources with the
 * TypeScript parser (each must be found exactly once) and run over the names
 * they use: the fake Electron and the real helpers the entries import
 * (`@seuoffice/ai-provider`, `@seuoffice/ai-search`, the docs `ai-run`,
 * `stream-coalesce`, `ai-keepalive` and `read-url-ipc` modules). The provider
 * transports run for real over `hosts.a.net` (the table of
 * crates/shell-ipc/a/src/runtime/testing.rs), served by a `fetch` that logs the
 * same `["fetch", n, "node", method, url, headers, body]` lines.
 *
 * What the Rust port reaches through its batch host is stood in here, from the
 * same `hosts.a.aiCore` (crates/shell-ipc/a/src/probe/ai_core.rs describes the
 * keys and the log lines, written the same here): the search backends
 * (`webSearch`, `imageSearch` of `@seuoffice/ai-search`, replaced where
 * `search-tools.ts` imports them), `readUrlTool`, `aiToolCapabilities`,
 * `fetchRemoteImage` with `readBodyCapped`, `sharedSubscriptionStatuses` and
 * `isHeadlessMode`. `hosts.a.lang` is the UI language. `hosts.a.now` pins
 * `Date.now()` for the case, as the probe pins the Rust runtime's clock
 * (`checkedAt` and `elapsedMs` of `ai:local-test`).
 *
 * Not compared (the unit tests of the Rust port cover them):
 * - a stream's cancel and a closed view (the gate cannot end a view), the
 *   keepalive of a local server (5 second timer), the first listing of the key
 *   providers' models 5 seconds after start;
 * - `ai:codex-models` with Codex on: it starts the CLI of the PC.
 * Scripted statuses stay clear of 429, 503 and 529, which `aiFetch` retries
 * after a delay.
 */
import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  AI_MEDIA_PROVIDERS,
  AI_SEARCH_PROVIDERS,
  activeCustomEndpoint,
  cancelLocalTestForIpc,
  chatForProvider,
  inspectLocalModelForIpc,
  isAiOverloadedError,
  listLocalModelsForIpc,
  localEndpointTimeoutMs,
  maxOutputTokensOf,
  normalizeAiSettings,
  sanitizeAiSettings,
  sanitizeCliPath,
  sealAiSecrets,
  streamForProvider,
  subscriptionOffIn,
  testLocalModelForIpc,
  testMediaProvider,
  withMigratedSubscriptionNoticeVersion,
  withStoredUnknownFields,
} from '../../../../packages/ai-provider/src/index.ts'
import { listCodexModels } from '../../../../packages/ai-provider/src/codex-app-server.ts'
import { listCustomModelsForIpc } from '../../../../packages/ai-provider/src/custom-models.ts'
import {
  createKeyModelRefresher,
  withStoredMainFields,
} from '../../../../packages/ai-provider/src/key-models.ts'
import {
  abortMediaCalls,
  imageSearchTool,
  readAiSettingsFile,
  testSearchProvider,
  webSearchTool,
  withMediaCallSignal,
} from '../../../../packages/ai-search/src/index.ts'
import {
  abortOnDestroyed,
  isHeadlessMode,
  setHeadlessMode,
  writeJsonAtomic,
} from '../../../../packages/electron-utils/src/index.ts'
import { aiRunRefusal } from '../../../../packages/electron-utils/src/ai-run-guard.ts'
import { MAX_REMOTE_IMAGE_BYTES } from '../../../../packages/electron-utils/src/remote-image.ts'
import { createI18n } from '../../../../packages/i18n/src/index.ts'
import {
  aiChatFailure,
  aiStreamErrorChunk,
  resolveAiRun,
  subscriptionStreamCallbacks,
} from '../../../../apps/docs/src/main/ai-run.ts'
import { startFirstChunkKeepalive } from '../../../../apps/docs/src/main/ai-keepalive.ts'
import {
  normalizeReadUrlRequest,
  unexpectedReadUrlFailure,
} from '../../../../apps/docs/src/main/read-url-ipc.ts'
import { createChunkCoalescer } from '../../../../apps/docs/src/main/stream-coalesce.ts'
import type { Call, Case, Group, LoadContext, View } from '../../types.ts'
import { entryStatements, runWith } from './lib/entry-source.ts'

const HOST = Symbol.for('ipc-diff.a.ai-core')
const BACKENDS = 'ipc-diff:ai-search-backends'
/** the real module the stand-in re-exports, found when the specifier is first resolved */
const real: Record<string, string> = {}

// synchronous hooks, as tools/main-diff/electron-fake.ts: they answer `import` and `require`.
// `search-tools.ts` imports the search backends from './index': they are the host's here.
registerHooks({
  resolve(specifier, context, next) {
    if (
      specifier.replace(/\.ts$/, '') === './index' &&
      context.parentURL?.endsWith('/packages/ai-search/src/search-tools.ts')
    ) {
      real[BACKENDS] = next(specifier, context).url
      return { url: BACKENDS, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === BACKENDS) {
      const forward = (name: string): string =>
        `export const ${name} = (...args) => globalThis[Symbol.for('ipc-diff.a.ai-core')].${name}(...args)`
      return {
        format: 'module',
        source: `export * from ${JSON.stringify(real[url])}\n${['webSearch', 'imageSearch'].map(forward).join('\n')}`,
        shortCircuit: true,
      }
    }
    return next(url, context)
  },
})

// ---- the statements of the entries --------------------------------------------------------

/** the module's statements that answer the group's channels, `export` taken off */
const code = (entry: string, starts: readonly string[]): string =>
  entryStatements(entry, starts).replace(/^export /gm, '')

/** docs-main's statements, in its order */
const docsCode = code('apps/docs/src/main/docs-main.ts', [
  'const tMain =',
  'const tm =',
  'function userDataPath(',
  'function readJson<T>(',
  'const SETTINGS_PATH =',
  'function writeAiSettingsFile(',
  'const activeAiStreams =',
  'function broadcastAiSettingsChanged(',
  'function storedAiSettings(',
  'function migratedNoticeVersion(',
  'function screenToolContext(',
  'const AI_RUN_TEXTS',
  'const keyModelRefresher =',
  'function writeRendererAiSettings(',
  "ipcMain.handle('ai:get-settings'",
  "ipcMain.handle('ai:tool-capabilities'",
  "ipcMain.handle('ai:set-settings'",
  "ipcMain.handle('ai:codex-models'",
  "ipcMain.handle('ai:custom-models'",
  "ipcMain.handle('ai:local-models'",
  "ipcMain.handle('ai:local-inspect'",
  "ipcMain.handle('ai:local-test',",
  "ipcMain.handle('ai:local-test-cancel'",
  "ipcMain.handle('ai:stream',",
  "ipcMain.handle('ai:stream-cancel'",
  "ipcMain.handle('ai:web-search'",
  "ipcMain.handle('ai:image-search'",
  "ipcMain.handle('ai:read-url'",
  "ipcMain.handle(\n    'ai:fetch-image',",
  "ipcMain.handle('ai:search-test'",
  "ipcMain.handle('ai:media-test'",
  "ipcMain.handle('ai:chat'",
  "ipcMain.handle('docs:consume-ai-doc-content'",
])
const sheetsCode = code('apps/sheets/src/main/sheets-main.ts', [
  'ipcMain.handle(IPC_CHANNELS.aiToolCapabilities,',
])

// ---- hosts.a.aiCore and hosts.a.net -----------------------------------------------------

/** an answer the case scripts: a value, or `{"$throw": message}` */
type Scripted = unknown
interface World {
  statuses?: Record<string, unknown>
  headless?: boolean
  capabilities?: unknown
  webSearch?: Scripted
  imageSearch?: Scripted
  readUrl?: Scripted
  fetchImage?: { contentType?: string; hex: string } | null
  pendingDocs?: Record<string, unknown>
}
interface FetchRule {
  method?: string
  url?: string
  urlIncludes?: string
  status?: number
  statusText?: string
  headers?: Record<string, string>
  body?: (string | { hex: string } | { error: string })[]
  times?: number | 'always'
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  500: 'Internal Server Error',
}

/** `FakeNet` of crates/shell-ipc/a/src/runtime/testing.rs for the text bodies this group scripts */
function fakeFetch(rules: FetchRule[], log: unknown[][]): typeof fetch {
  const used = rules.map(() => 0)
  let count = 0
  return (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = Object.entries((init.headers ?? {}) as Record<string, string>)
    const n = count++
    log.push(['fetch', n, 'node', method, url, headers, init.body ?? null])
    const at = rules.findIndex((rule, i) => {
      const times = rule.times === 'always' ? Infinity : (rule.times ?? 1)
      return (
        used[i]! < times &&
        (rule.method ?? 'GET').toUpperCase() === method &&
        (rule.url === undefined || rule.url === url) &&
        (rule.urlIncludes === undefined || url.includes(rule.urlIncludes))
      )
    })
    if (at < 0) {
      throw new TypeError('fetch failed', {
        cause: new Error(`no scripted response for ${method} ${url}`),
      })
    }
    used[at]!++
    const rule = rules[at]!
    const status = rule.status ?? 200
    const body = rule.body?.map((chunk) => (typeof chunk === 'string' ? chunk : '')).join('')
    return new Response(rule.body === undefined ? null : body, {
      status,
      statusText: rule.statusText ?? STATUS_TEXT[status] ?? '',
      headers: rule.headers,
    })
  }) as typeof fetch
}

/** a scripted answer, or its `$throw` as a rejection */
function scripted(answer: Scripted): unknown {
  if (answer && typeof answer === 'object' && '$throw' in answer) {
    throw new Error(String(answer.$throw))
  }
  return answer === undefined ? null : answer
}

const unhex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16))

const REAL_DATE_NOW = Date.now

async function load(cx: LoadContext): Promise<void> {
  const hostsA = (cx.case.hosts?.a ?? {}) as {
    aiCore?: World
    net?: { fetch?: FetchRule[] }
    lang?: string
    now?: number
  }
  const world = hostsA.aiCore ?? {}
  const log = cx.electron.log
  globalThis.fetch = fakeFetch(hostsA.net?.fetch ?? [], log)
  if (hostsA.now !== undefined) {
    const now = hostsA.now
    Date.now = () => now
  } else {
    Date.now = REAL_DATE_NOW
  }
  setHeadlessMode(world.headless === true)
  const electron = cx.electron as unknown as {
    ipcMain: unknown
    app: unknown
    webContents: unknown
  }

  const pendingAiDocContents = new Map<number, unknown>(
    Object.entries(world.pendingDocs ?? {}).map(([view, content]) => [Number(view), content]),
  )
  ;(globalThis as Record<symbol, unknown>)[HOST] = {
    webSearch: (query: string, max: number, options: unknown) => {
      log.push(['webSearch', query, max, options])
      return scripted(world.webSearch)
    },
    imageSearch: (query: string, max: number, options: unknown) => {
      log.push(['imageSearch', query, max, options])
      return scripted(world.imageSearch)
    },
  }
  const names = {
    ipcMain: electron.ipcMain,
    app: electron.app,
    webContents: electron.webContents,
    join,
    existsSync,
    readFileSync,
    Buffer,
    IPC_CHANNELS: { aiToolCapabilities: 'sheets:ai-tool-capabilities' },
    // the entries' own helpers
    getUiLang: () => hostsA.lang ?? 'ko',
    createI18n,
    pendingAiDocContents,
    sharedSubscriptionStatuses: () => world.statuses ?? {},
    isHeadlessMode,
    writeJsonAtomic,
    // `@seuoffice/ai-provider`
    AI_MEDIA_PROVIDERS,
    AI_SEARCH_PROVIDERS,
    activeCustomEndpoint,
    cancelLocalTestForIpc,
    chatForProvider,
    inspectLocalModelForIpc,
    isAiOverloadedError,
    listCodexModels,
    listCustomModelsForIpc,
    listLocalModelsForIpc,
    localEndpointTimeoutMs,
    maxOutputTokensOf,
    normalizeAiSettings,
    sanitizeAiSettings,
    sanitizeCliPath,
    sealAiSecrets,
    streamForProvider,
    subscriptionOffIn,
    testLocalModelForIpc,
    testMediaProvider,
    withMigratedSubscriptionNoticeVersion,
    withStoredUnknownFields,
    createKeyModelRefresher,
    withStoredMainFields,
    // `@seuoffice/ai-search`: the tools that wait on the network are the host's
    abortMediaCalls,
    imageSearchTool,
    testSearchProvider,
    webSearchTool,
    withMediaCallSignal,
    aiToolCapabilities: (settings: unknown, context: unknown) => {
      log.push(['aiToolCapabilities', settings, context])
      return world.capabilities ?? {}
    },
    readUrlTool: (_settingsPath: string, url: string, offset: number) => {
      log.push(['readUrlTool', url, offset])
      return scripted(world.readUrl)
    },
    // `@seuoffice/electron-utils`
    abortOnDestroyed,
    aiRunRefusal,
    MAX_REMOTE_IMAGE_BYTES,
    fetchRemoteImage: async (url: string) => {
      log.push(['fetchRemoteImage', url])
      const image = world.fetchImage
      if (!image) return null
      return {
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-type' ? (image.contentType ?? '') : null),
        },
        bytes: unhex(image.hex),
      }
    },
    readBodyCapped: async (response: { bytes: Uint8Array }) => response.bytes,
    // the docs entry's modules
    aiChatFailure,
    aiStreamErrorChunk,
    resolveAiRun,
    subscriptionStreamCallbacks,
    startFirstChunkKeepalive,
    normalizeReadUrlRequest,
    unexpectedReadUrlFailure,
    createChunkCoalescer,
  }
  runWith(docsCode, names)
  runWith(sheetsCode, {
    ...names,
    readAiSettingsFile,
    SETTINGS_PATH: () => join(cx.dir, 'userData', 'ai-settings.json'),
  })
}

// ---- cases -----------------------------------------------------------------------------------

const views: View[] = [
  { view: 1, window: 1, surface: 'Docs' },
  { view: 2, window: 2, surface: 'Shell' },
  { view: 3, window: 3, surface: 'Sheets' },
]
const docs = (channel: string, ...args: unknown[]): Call => ({ channel, view: 1, args })
const shell = (channel: string, ...args: unknown[]): Call => ({ channel, view: 2, args })
const aiCore = (world: World, rest: Record<string, unknown> = {}) => ({
  a: { aiCore: world, ...rest },
})
const file = (settings: unknown): Record<string, string> => ({
  'userData/ai-settings.json': JSON.stringify(settings),
})

/** the renderer's settings: DeepSeek with a key */
const renderer = {
  provider: 'deepseek',
  providers: { deepseek: { apiKey: 'sk-test', model: 'deepseek-chat' } },
}
const stored = {
  provider: 'deepseek',
  providers: {
    deepseek: { apiKey: 'sk-secret', model: 'deepseek-chat', models: ['deepseek-chat'] },
  },
  futureField: { kept: true },
}
const sse = (events: unknown[]): string[] => [
  ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
  'data: [DONE]\n\n',
]
const delta = (text: string) => ({ choices: [{ delta: { content: text } }] })
const streamRequest = (requestId: string, settings: unknown = renderer) => ({
  requestId,
  system: 'be brief',
  messages: [{ role: 'user', content: 'hi' }],
  settings,
})
const completions = (rule: FetchRule): FetchRule => ({
  method: 'POST',
  urlIncludes: '/chat/completions',
  ...rule,
})

const cases: Case[] = [
  {
    note: 'settings: none stored, and a file with a key, a model list and a field of a newer build',
    views,
    calls: [docs('ai:get-settings')],
  },
  {
    note: 'settings read: a notice-seen file is migrated to a notice version on disk',
    views,
    files: file({ ...stored, subscriptionNoticeSeen: true }),
    calls: [docs('ai:get-settings'), shell('ai:get-settings')],
  },
  {
    note: 'settings save: schema-checked, the live model list and the CLIs turned off kept from the file, unknown fields kept, every view told',
    views,
    files: file({ ...stored, subscriptionOff: { codex: true } }),
    calls: [
      docs('ai:set-settings', {
        provider: 'deepseek',
        providers: {
          deepseek: { apiKey: 'sk-new', model: 'deepseek-reasoner', models: ['injected'] },
          custom: { apiKey: '', model: 'm', baseUrl: 'http://localhost:1234/v1' },
        },
        subscriptionOff: {},
      }),
      docs('ai:get-settings'),
    ],
  },
  {
    note: 'settings save: a payload that is not settings changes nothing and tells nobody',
    views,
    files: file(stored),
    calls: [
      docs('ai:set-settings', 5),
      docs('ai:set-settings', { provider: 'nope', providers: {} }),
      docs('ai:set-settings'),
      docs('ai:get-settings'),
    ],
  },
  {
    note: 'settings save in a headless run: the file stays, the windows are still told',
    views,
    files: file(stored),
    hosts: aiCore({ headless: true }),
    calls: [docs('ai:set-settings', renderer), docs('ai:get-settings')],
  },
  {
    note: 'tool capabilities ask the tools with the stored settings and the screen path, statuses included',
    views,
    files: file(stored),
    hosts: aiCore({
      statuses: { codex: { provider: 'codex', state: 'ready' } },
      capabilities: { webSearch: { available: true, route: 'free', provider: 'parallel' } },
    }),
    calls: [docs('ai:tool-capabilities')],
  },
  {
    note: 'tool capabilities with other statuses and no settings file',
    views,
    hosts: aiCore({ capabilities: { imageGeneration: { available: false } } }),
    calls: [docs('ai:tool-capabilities')],
  },
  {
    note: 'the sheets capabilities read the file as the search package does',
    views,
    files: file(stored),
    hosts: aiCore({ statuses: {}, capabilities: { webSearch: { available: true } } }),
    calls: [{ channel: 'sheets:ai-tool-capabilities', view: 3, args: [] }],
  },
  {
    note: 'the sheets capabilities with no file, and other capabilities',
    views,
    hosts: aiCore({ capabilities: { webSearch: { available: false } } }),
    calls: [{ channel: 'sheets:ai-tool-capabilities', view: 3, args: [] }],
  },
  {
    note: 'AI content queued for a tab is consumed once; another tab has its own',
    views,
    hosts: aiCore({ pendingDocs: { '1': { title: 'T', html: '<p>x</p>' } } }),
    calls: [
      docs('docs:consume-ai-doc-content'),
      docs('docs:consume-ai-doc-content'),
      { channel: 'docs:consume-ai-doc-content', view: 1, args: [] },
    ],
  },
  {
    note: 'Codex is not started for its list when it is turned off in this app',
    views,
    files: file({ ...stored, subscriptionOff: { codex: true } }),
    calls: [docs('ai:codex-models'), docs('ai:codex-models', '/usr/bin/codex')],
  },
  {
    note: 'custom models are listed from the servers models endpoint; no base URL asks nobody',
    views,
    hosts: {
      a: {
        net: {
          fetch: [
            {
              url: 'http://models.test/v1/models',
              body: ['{"data":[{"id":" a "},{"id":"b"},{"id":"a"}]}'],
            },
          ],
        },
      },
    },
    calls: [
      shell('ai:custom-models', { baseUrl: 'http://models.test/v1/', apiKey: 'k' }),
      shell('ai:custom-models', {}),
      shell('ai:custom-models'),
    ],
  },
  {
    note: 'local models and inspection: a malformed payload answers its shape; a server that answers 404 everywhere',
    views,
    hosts: { a: { net: { fetch: [{ status: 404, body: ['no'], times: 'always' }] } } },
    calls: [
      shell('ai:local-models', { baseUrl: 'ftp://x' }),
      shell('ai:local-models', { baseUrl: 'http://local.test:11434' }),
      shell('ai:local-inspect', {}),
      shell('ai:local-inspect', { baseUrl: 'http://local.test:11434', model: 'm' }),
    ],
  },
  {
    note: 'a cancel of a local test nobody runs',
    views,
    calls: [
      shell('ai:local-test-cancel', { testId: 't1' }),
      shell('ai:local-test-cancel', 't1'),
      shell('ai:local-test-cancel'),
    ],
  },
  {
    note: 'a local test: a malformed input is skipped; a server that answers 404 everywhere fails each check in turn',
    views,
    hosts: {
      a: {
        now: 1_700_000_000_000,
        net: { fetch: [{ status: 404, body: ['no'], times: 'always' }] },
      },
    },
    calls: [
      shell('ai:local-test', {}),
      shell('ai:local-test', { baseUrl: 'ftp://x', model: 'm' }),
      shell('ai:local-test', { baseUrl: 'http://local.test:11434/v1', model: 'm', testId: 't1' }),
    ],
  },
  {
    note: 'a local test: the server lists other models, the picked one is missing unless typed; chat and tools refused',
    views,
    hosts: {
      a: {
        now: 1_700_000_000_000,
        net: {
          fetch: [
            { urlIncludes: '/api/tags', status: 404, body: ['no'], times: 'always' },
            {
              urlIncludes: '/v1/models',
              body: ['{"data":[{"id":"other"}]}'],
              headers: { 'content-type': 'application/json' },
              times: 'always',
            },
            {
              method: 'POST',
              status: 401,
              body: ['{"error":{"message":"no key"}}'],
              times: 'always',
            },
          ],
        },
      },
    },
    calls: [
      shell('ai:local-test', { baseUrl: 'http://local.test:1234/v1', model: 'm' }),
      shell('ai:local-test', { baseUrl: 'http://local.test:1234/v1', model: 'm', typed: true }),
    ],
  },
  {
    note: 'a stream sends its chunks in order, then replies; a provider that fails ends with an error chunk',
    views,
    hosts: {
      a: {
        net: {
          fetch: [
            completions({
              headers: { 'content-type': 'text/event-stream' },
              body: sse([
                delta('Hel'),
                delta('lo'),
                { choices: [{ delta: {}, finish_reason: 'stop' }] },
              ]),
            }),
            completions({ status: 401, body: ['{"error":{"message":"bad key"}}'] }),
          ],
        },
      },
    },
    calls: [docs('ai:stream', streamRequest('r1')), docs('ai:stream', streamRequest('r2'))],
  },
  {
    note: 'a stream the provider cannot run is refused before any request: no key, settings that are not settings, no request at all',
    views,
    calls: [
      docs(
        'ai:stream',
        streamRequest('r3', { ...renderer, providers: { deepseek: { apiKey: '' } } }),
      ),
      docs('ai:stream', streamRequest('r4', 5)),
      docs('ai:stream', { requestId: 'r5', system: '', messages: [] }),
      docs('ai:stream'),
    ],
  },
  {
    note: 'stream cancel for a request that is not running ends nothing; the request-only scope too',
    views,
    calls: [
      docs('ai:stream-cancel', 'r-none'),
      docs('ai:stream-cancel', 'r-none', 'request'),
      docs('ai:stream-cancel'),
    ],
  },
  {
    note: 'chat answers the provider reply; a refusal and a failed call answer ok:false',
    views,
    hosts: {
      a: {
        net: {
          fetch: [
            completions({
              body: ['{"choices":[{"message":{"content":"Hi there"}}]}'],
              headers: { 'content-type': 'application/json' },
            }),
            completions({ status: 400, body: ['nope'] }),
          ],
        },
      },
    },
    calls: [
      docs('ai:chat', { system: 's', user: 'hello', settings: renderer }),
      docs('ai:chat', { system: 's', user: 'hello', settings: renderer }),
      docs('ai:chat', { system: 's', user: 'hello', settings: 5 }),
    ],
  },
  {
    note: 'a search goes to the backend the settings select; a rejection of the backend is an answer; the default counts',
    views,
    files: file({
      provider: 'deepseek',
      providers: { deepseek: { apiKey: '', model: '' } },
      search: { provider: 'serper', providers: { serper: { apiKey: 'sk-serper' } } },
    }),
    hosts: aiCore({
      webSearch: { results: [{ title: 't' }], method: 'serper' },
      imageSearch: { images: [], method: 'duckduckgo' },
    }),
    calls: [
      docs('ai:web-search', 'rust', 3),
      docs('ai:web-search', 'rust'),
      docs('ai:image-search', 'cats'),
      docs('ai:image-search', 'cats', 5),
    ],
  },
  {
    note: 'a backend that throws: the answer carries the error',
    views,
    hosts: aiCore({ webSearch: { $throw: 'boom' }, imageSearch: { $throw: 'boom' } }),
    calls: [docs('ai:web-search', 'rust'), docs('ai:image-search', 'cats')],
  },
  {
    note: 'a search test needs a known provider and a key, then asks the backend as that provider',
    views,
    hosts: aiCore({ webSearch: { results: [], method: 'serper' } }),
    calls: [
      shell('ai:search-test', { provider: 'nope' }),
      shell('ai:search-test'),
      shell('ai:search-test', { provider: 'serper', apiKey: '  ' }),
      shell('ai:search-test', { provider: 'serper', apiKey: 'k' }),
      shell('ai:search-test', { provider: 'tavily', apiKey: 'k' }),
    ],
  },
  {
    note: 'a media test checks the provider and its configuration before any request, then lists models',
    views,
    hosts: {
      a: {
        net: {
          fetch: [
            { urlIncludes: '/models', body: ['{"data":[]}'] },
            { urlIncludes: '/models', status: 401, body: ['no'] },
          ],
        },
      },
    },
    calls: [
      shell('ai:media-test', { provider: 'nope' }),
      shell('ai:media-test', { provider: 'openai' }),
      shell('ai:media-test', { provider: 'openai', config: { apiKey: 'sk-test' } }),
      shell('ai:media-test', { provider: 'openai', config: { apiKey: 'sk-bad' } }),
    ],
  },
  {
    note: 'a page is read through the tool with the offset; a url that is no string is refused; a throw is the unexpected failure',
    views,
    hosts: aiCore({ readUrl: { ok: true, text: 'abc', nextOffset: 3 } }),
    calls: [
      docs('ai:read-url', 'https://example.com/a', 40),
      docs('ai:read-url', 'https://example.com/a'),
      docs('ai:read-url', 5),
      docs('ai:read-url', '  '),
      docs('ai:read-url'),
    ],
  },
  {
    note: 'a read that throws',
    views,
    hosts: aiCore({ readUrl: { $throw: 'boom' } }),
    calls: [docs('ai:read-url', 'https://example.com/a')],
  },
  {
    note: 'a remote image comes back as base64 with the mime the server named',
    views,
    hosts: aiCore({ fetchImage: { contentType: 'image/png', hex: '010203' } }),
    calls: [docs('ai:fetch-image', 'https://i.test/a'), docs('ai:fetch-image')],
  },
  {
    note: 'a remote image that is a gif',
    views,
    hosts: aiCore({ fetchImage: { contentType: 'image/gif', hex: '04' } }),
    calls: [docs('ai:fetch-image', 'https://i.test/b')],
  },
  {
    note: 'a remote image of no known type is a jpeg',
    views,
    hosts: aiCore({ fetchImage: { hex: '05' } }),
    calls: [docs('ai:fetch-image', 'https://i.test/c')],
  },
  {
    note: 'a remote image that could not be had',
    views,
    hosts: aiCore({ fetchImage: null }),
    calls: [docs('ai:fetch-image', 'https://i.test/d')],
  },
]

export const group: Group = {
  batch: 'A',
  load,
  cases,
  single: {
    'ai:codex-models':
      'the only answer reachable without starting the Codex CLI of the PC is the refusal while Codex is turned off',
    'ai:local-test-cancel':
      'a test must be in flight to be cancelled; the gate has no way to hold one',
    'ai:stream-cancel':
      'always answers undefined; what it cuts is a stream the gate cannot hold open',
    'sheets:ai-tool-capabilities': 'the answer is the capabilities the case scripts',
  },
}
