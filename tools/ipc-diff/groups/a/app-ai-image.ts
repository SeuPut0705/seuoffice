/**
 * Group `a/app-ai-image`: the six per-app image generation channels:
 * `docs:ai-generate-image` (`apps/docs/src/main/docs-main.ts`),
 * `html:ai-generate-image` (`html-main.ts`), `hwp:ai-generate-image`
 * (`apps/hwp/src/main/ai-image.ts`), `markdown:ai-generate-image`
 * (`markdown-main.ts`), `mindmap:ai-generate-image`
 * (`apps/mindmap/src/main/ai-image.ts`) and `sheets:ai-generate-image`
 * (`sheets-main.ts`).
 *
 * The hwp and mindmap modules are loaded as they are. The four entries start
 * a whole app when imported, so their handler statements (and the small
 * functions they call) are taken from their sources with the TypeScript parser
 * and run over the names they use: the fake Electron, the real
 * `generateImageTool`, `withMediaCallSignal`, `documentMediaRoots` and
 * `localMediaRoots`, and stand-ins for the entries' own state
 * (`openDocByWc`, `sheetsTabs`, `htmlFilePath`, `markdownFilePath`: no open
 * document, so no media root from a file).
 *
 * What the Rust port reaches through its batch host is stood in here from the
 * same `hosts.a.appAiImage` (crates/shell-ipc/a/src/probe/app_ai_image.rs
 * describes the keys and the log line, written the same here):
 * `sharedSubscriptionStatuses()` and the Codex generator
 * (`registerCodexImageGenerator`, `setCodexImageGenerationAvailable`). The key
 * providers' HTTP is `hosts.a.net` (the table of
 * crates/shell-ipc/a/src/runtime/testing.rs), served by a `fetch` that logs the
 * same `["fetch", n, "node", method, url, headers, body]` lines.
 *
 * Not compared: an image that is stored (a generated picture's file name is a
 * random UUID, on both sides): the unit tests of the Rust port cover the
 * store; here the Codex route answers `{url}` of its own and the key route is
 * driven to its failure.
 */
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import {
  registerCodexImageGenerator,
  type CodexImageRequest,
} from '../../../../packages/ai-search/src/codex-image-generator.ts'
import { withMediaCallSignal } from '../../../../packages/ai-search/src/media-call-abort.ts'
import {
  documentMediaRoots,
  generateImageTool,
  localMediaRoots,
} from '../../../../packages/ai-search/src/media-tools.ts'
import { setCodexImageGenerationAvailable } from '../../../../packages/ai-provider/src/image-backend.ts'
import { HTML_CHANNELS } from '../../../../apps/html/src/shared/ipc.ts'
import { MARKDOWN_CHANNELS } from '../../../../apps/markdown/src/shared/ipc.ts'
import { IPC_CHANNELS } from '../../../../apps/sheets/src/shared/ipc-channels.ts'
import type * as HwpImage from '../../../../apps/hwp/src/main/ai-image.ts'
import type * as MindmapImage from '../../../../apps/mindmap/src/main/ai-image.ts'
import type { Call, Case, Group, LoadContext, View } from '../../types.ts'
import { entryStatements, runWith } from './lib/entry-source.ts'

const HOST = Symbol.for('ipc-diff.a.app-ai-image')
const SUBSCRIPTION = 'ipc-diff:ai-provider-subscription'
/** the real module the stand-in re-exports, found when the specifier is first resolved */
const real: Record<string, string> = {}

// synchronous hooks, as tools/main-diff/electron-fake.ts: they answer `import` and `require`
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@seuoffice/ai-provider/subscription') {
      real[SUBSCRIPTION] = next(specifier, context).url
      return { url: SUBSCRIPTION, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === SUBSCRIPTION) {
      const forward = `export const sharedSubscriptionStatuses = () => globalThis[Symbol.for('ipc-diff.a.app-ai-image')].sharedSubscriptionStatuses()`
      return {
        format: 'module',
        source: `export * from ${JSON.stringify(real[url])}\n${forward}`,
        shortCircuit: true,
      }
    }
    return next(url, context)
  },
})

// ---- hosts.a.appAiImage and hosts.a.net -------------------------------------------------

interface Codex {
  available?: boolean
  registered?: boolean
  results?: { url?: string; throw?: string }[]
}
interface World {
  statuses?: Record<string, unknown>
  codex?: Codex
}
interface FetchRule {
  method?: string
  url?: string
  urlIncludes?: string
  status?: number
  statusText?: string
  headers?: Record<string, string>
  body?: string
  times?: number | 'always'
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  400: 'Bad Request',
  401: 'Unauthorized',
  429: 'Too Many Requests',
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
    return new Response(rule.body ?? null, {
      status,
      statusText: rule.statusText ?? STATUS_TEXT[status] ?? '',
      headers: rule.headers,
    })
  }) as typeof fetch
}

// ---- the entries' handler statements ------------------------------------------------------

/** the module's statements that answer the group's channels, `export` taken off */
const code = (entry: string, starts: readonly string[]): string =>
  entryStatements(entry, starts).replace(/^export /gm, '')

const docsCode = code('apps/docs/src/main/docs-main.ts', [
  'function docsMediaRoots(',
  'function screenToolContext(',
  "ipcMain.handle(\n    'docs:ai-generate-image',",
])
const htmlCode = code('apps/html/src/main/html-main.ts', [
  'ipcMain.handle(\n    HTML_CHANNELS.aiGenerateImage,',
])
const markdownCode = code('apps/markdown/src/main/markdown-main.ts', [
  'ipcMain.handle(\n    MARKDOWN_CHANNELS.aiGenerateImage,',
])
const sheetsCode = code('apps/sheets/src/main/sheets-main.ts', [
  'function sheetsMediaRoots(',
  'ipcMain.handle(\n    IPC_CHANNELS.aiGenerateImage,',
])

async function load(cx: LoadContext): Promise<void> {
  const world = ((cx.case.hosts?.a ?? {}) as { appAiImage?: World }).appAiImage ?? {}
  const net = ((cx.case.hosts?.a ?? {}) as { net?: { fetch?: FetchRule[] } }).net ?? {}
  const codex = world.codex ?? {}
  const results = [...(codex.results ?? [])]
  ;(globalThis as Record<symbol, unknown>)[HOST] = {
    sharedSubscriptionStatuses: () => world.statuses ?? {},
  }
  setCodexImageGenerationAvailable(codex.available === true)
  registerCodexImageGenerator(
    codex.registered === true
      ? async (request: CodexImageRequest) => {
          cx.electron.log.push([
            'codexImageGenerator',
            {
              prompt: request.prompt,
              ...(request.aspectRatio !== undefined ? { aspectRatio: request.aspectRatio } : {}),
            },
          ])
          const answer = results.shift() ?? { throw: 'no scripted codex image' }
          if (answer.throw !== undefined) throw new Error(answer.throw)
          return { url: answer.url ?? '' }
        }
      : null,
  )
  globalThis.fetch = fakeFetch(net.fetch ?? [], cx.electron.log)

  const electron = cx.electron as unknown as { ipcMain: unknown; app: unknown }
  // hwp and mindmap: the modules as they are
  const hwp = await cx.fresh<typeof HwpImage>('apps/hwp/src/main/ai-image.ts')
  hwp.registerHwpImageIpc({ filePathOf: () => null })
  const mindmap = await cx.fresh<typeof MindmapImage>('apps/mindmap/src/main/ai-image.ts')
  mindmap.registerMindmapImageIpc({
    filePathOf: () => null,
    pastedImageDir: join(cx.dir, 'temp', 'seuoffice-pasted'),
  })
  // docs, html, markdown, sheets: the entries' own statements; no document is open
  const names = {
    ipcMain: electron.ipcMain,
    app: electron.app,
    join,
    generateImageTool,
    withMediaCallSignal,
    documentMediaRoots,
    localMediaRoots,
    sharedSubscriptionStatuses: () => world.statuses ?? {},
    SETTINGS_PATH: () => join(cx.dir, 'userData', 'ai-settings.json'),
    openDocByWc: new Map<number, string>(),
    sheetsTabs: new Map(),
    htmlFilePath: () => undefined,
    markdownFilePath: () => undefined,
    HTML_CHANNELS,
    MARKDOWN_CHANNELS,
    IPC_CHANNELS,
  }
  runWith(docsCode, names)
  runWith(htmlCode, names)
  runWith(markdownCode, names)
  runWith(sheetsCode, names)
}

// ---- cases ----------------------------------------------------------------------------------

const views: View[] = [
  { view: 1, window: 1, surface: 'Docs' },
  { view: 2, window: 2, surface: 'Html' },
  { view: 3, window: 3, surface: 'Hwp' },
  { view: 4, window: 4, surface: 'Markdown' },
  { view: 5, window: 5, surface: 'Mindmap' },
  { view: 6, window: 6, surface: 'Sheets' },
]
const channels = [
  'docs:ai-generate-image',
  'html:ai-generate-image',
  'hwp:ai-generate-image',
  'markdown:ai-generate-image',
  'mindmap:ai-generate-image',
  'sheets:ai-generate-image',
]
/** one call per app, the view of its surface */
const each = (...args: unknown[]): Call[] =>
  channels.map((channel, i) => ({ channel, view: i + 1, args }))

const ready = { codex: { provider: 'codex', state: 'ready' } }
const codexWorld = (results: Codex['results'], rest: World = {}): { a: { appAiImage: World } } => ({
  a: {
    appAiImage: {
      statuses: ready,
      codex: { available: true, registered: true, results },
      ...rest,
    },
  },
})
const settings = (value: unknown) => ({ 'userData/ai-settings.json': JSON.stringify(value) })
const undef = { $: 'u' }

const cases: Case[] = [
  {
    note: 'nothing is connected or configured: image generation is unavailable',
    views,
    hosts: { a: { appAiImage: {} } },
    calls: each({ prompt: 'a red fox' }),
  },
  {
    note: 'a prompt that is empty, blank or missing is refused before the route is looked at',
    views,
    hosts: { a: { appAiImage: {} } },
    calls: [
      ...each({ prompt: '   ' }),
      { channel: 'docs:ai-generate-image', view: 1, args: [{}] },
      { channel: 'html:ai-generate-image', view: 2, args: [null] },
      { channel: 'hwp:ai-generate-image', view: 3, args: [] },
      { channel: 'markdown:ai-generate-image', view: 4, args: [{ prompt: null }] },
      { channel: 'mindmap:ai-generate-image', view: 5, args: [{ prompt: undef }] },
      { channel: 'sheets:ai-generate-image', view: 6, args: ['text'] },
    ],
  },
  {
    note: 'the Codex route: the prompt is trimmed and the ratio passed; each app has its own answer',
    views,
    hosts: codexWorld([
      { url: 'file:///gen/1.png' },
      { url: 'file:///gen/2.png' },
      { url: 'file:///gen/3.png' },
      { url: 'file:///gen/4.png' },
      { url: 'file:///gen/5.png' },
      { url: 'file:///gen/6.png' },
    ]),
    calls: each({ prompt: '  an owl on a branch ', aspectRatio: '16:9' }),
  },
  {
    note: 'String() of the op: a list is joined, a number is its text, a falsy ratio is none',
    views,
    hosts: codexWorld([
      { url: 'file:///gen/a.png' },
      { url: 'file:///gen/b.png' },
      { url: 'file:///gen/c.png' },
    ]),
    calls: [
      {
        channel: 'docs:ai-generate-image',
        view: 1,
        args: [{ prompt: ['a', 'b'], aspectRatio: 0 }],
      },
      { channel: 'markdown:ai-generate-image', view: 4, args: [{ prompt: 42, aspectRatio: 169 }] },
      { channel: 'sheets:ai-generate-image', view: 6, args: [{ prompt: 'x', aspectRatio: '' }] },
    ],
  },
  {
    note: 'a Codex failure is an error answer, not a rejection; the next call goes on',
    views,
    hosts: codexWorld([{ throw: 'codex is busy' }, { url: 'file:///gen/ok.png' }]),
    calls: [
      { channel: 'hwp:ai-generate-image', view: 3, args: [{ prompt: 'owl' }] },
      { channel: 'mindmap:ai-generate-image', view: 5, args: [{ prompt: 'owl' }] },
    ],
  },
  {
    note: 'Codex is offered but no generator is registered: unavailable, with the key hint only',
    views,
    hosts: {
      a: { appAiImage: { statuses: ready, codex: { available: true, registered: false } } },
    },
    calls: [{ channel: 'docs:ai-generate-image', view: 1, args: [{ prompt: 'owl' }] }],
  },
  {
    note: 'a key provider is chosen and refuses: the failure is an error answer after one request',
    views,
    files: settings({
      // media is read only beside a stored `providers` (resolveAiSettings)
      providers: {},
      media: {
        imageProvider: 'openai',
        providers: { openai: { apiKey: 'sk-test', imageModel: 'gpt-image-1' } },
      },
    }),
    hosts: {
      a: {
        appAiImage: {},
        net: {
          fetch: [
            {
              method: 'POST',
              urlIncludes: '/images/generations',
              status: 401,
              headers: { 'content-type': 'application/json' },
              body: '{"error":{"message":"bad key"}}',
            },
          ],
        },
      },
    },
    calls: [
      { channel: 'docs:ai-generate-image', view: 1, args: [{ prompt: 'fox', aspectRatio: '1:1' }] },
      { channel: 'sheets:ai-generate-image', view: 6, args: [{ prompt: 'fox' }] },
    ],
  },
]

export const group: Group = {
  batch: 'A',
  load,
  cases,
}
