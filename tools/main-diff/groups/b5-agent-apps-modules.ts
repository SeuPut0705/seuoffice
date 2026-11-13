/**
 * The editors' AI modules that register `ipcMain` handlers:
 * `shell/ai-naming-service`, `docs/free-ai-ipc`, `html/ai-search-ipc`,
 * `hwp/ai-image`, `mindmap/ai-image`. Each case is a scenario: the module's
 * register function runs against a fake `ipcMain` that keeps the handlers,
 * and the steps call them as the renderer would. The libraries behind the
 * handlers (the chat of a provider, the free-connect transports, the search
 * and media tools) are stubs the case drives; each call of a stub or of a
 * fake Electron object is one log line, as the Rust fakes of
 * `calls/b5_agent/apps/modules.rs` write it.
 *
 * - shell/ai-naming-service: `{ userData, lang, statuses, steps }`; a step is
 *   `{ input, chat?, timer? }` where `chat` is `{ ok, content? }`,
 *   `{ ok: false, error }` or `{ throw }` and `timer` fires the 30 second
 *   timer when the chat ends.
 * - docs/free-ai-ipc: steps `connect` (a name, the input, the `open` address
 *   of the sign-in, the `gemini` answer), `finish` (a name and the answer of
 *   its sign-in), `cancel`, `disconnect`, `quota`, `openKeyPage`.
 * - html/ai-search-ipc: steps `register`, `web`, `image`.
 * - hwp/ai-image, mindmap/ai-image: steps `generate` and `analyze` over a
 *   window `{ id, destroyed }`.
 */
import { setUiLang } from '@seuoffice/i18n'
import { useElectron } from '../electron-fake.ts'
import type { Case, FnSpec, Group } from '../types.ts'
import {
  NO_SEARCH_ENV,
  fakeSender,
  g,
  loadPatched,
  must,
  repoUrl,
  tick,
  withEnv,
  type J,
} from './b5-agent-apps-lib.ts'

const hwpIpc = await import('../../../apps/hwp/src/shared/ipc.ts')
const mindmapIpc = await import('../../../apps/mindmap/src/shared/ipc.ts')
const namingService = await import('../../../apps/shell/src/main/ai-naming-service.ts')

const constant = (value: unknown): FnSpec => ({
  ts: () => value,
  cases: [{ args: [] }],
  single: 'a constant',
})

type Handler = (...args: J[]) => unknown

/** an `ipcMain` that keeps its `handle` callbacks by channel */
function ipcRecorder(): { ipcMain: J; handlers: Map<string, Handler>; channels: string[] } {
  const handlers = new Map<string, Handler>()
  const channels: string[] = []
  return {
    ipcMain: {
      handle: (channel: string, fn: Handler) => {
        channels.push(channel)
        handlers.set(channel, fn)
      },
      on: (channel: string, fn: Handler) => {
        channels.push(`on:${channel}`)
        handlers.set(channel, fn)
      },
    },
    handlers,
    channels,
  }
}

// ---------------------------------------------------------------------------
// shell/ai-naming-service
// ---------------------------------------------------------------------------

interface NamingStep {
  input?: unknown
  chat?: { ok?: boolean; content?: string; error?: unknown; throw?: unknown }
  timer?: boolean
}

interface NamingSpec {
  userData: string
  lang: string
  statuses?: J
  steps: NamingStep[]
}

async function runNaming(spec: NamingSpec, log: (...args: unknown[]) => void): Promise<unknown> {
  const rec = ipcRecorder()
  useElectron({ ipcMain: rec.ipcMain, app: { getPath: () => spec.userData } })
  let fire: (() => void) | undefined
  let step: NamingStep = {}
  g.__b5Naming = {
    chat: async (provider: string, config: J, system: string, prompt: string) => {
      log('chat', provider, config, system, prompt)
      if (step.timer) fire?.()
      const c = step.chat ?? { ok: true, content: '' }
      if (c.throw !== undefined) throw c.throw
      if (c.ok === false) return { ok: false, error: c.error }
      return { ok: true, content: c.content }
    },
    statuses: () => {
      log('statuses')
      return spec.statuses ?? {}
    },
    setTimer: (callback: () => void) => {
      fire = callback
      return 0
    },
    clearTimer: () => {},
    warn: (...args: unknown[]) => log('warn', ...args),
  }
  const mod = await loadPatched('apps/shell/src/main/ai-naming-service.ts', (src) => {
    let out = must(
      src,
      "import { chatForProvider } from '@seuoffice/ai-provider'\nimport { sharedSubscriptionStatuses } from '@seuoffice/ai-provider/subscription'",
      [
        'const chatForProvider = (...a: any[]): any => (globalThis as any).__b5Naming.chat(...a)',
        'const sharedSubscriptionStatuses = (): any => (globalThis as any).__b5Naming.statuses()',
      ].join('\n'),
      'ai-naming-service.ts',
    )
    out = must(
      out,
      'const timer = setTimeout(() => controller.abort(), NAMING_TIMEOUT_MS)',
      'const timer = (globalThis as any).__b5Naming.setTimer(() => controller.abort())',
      'ai-naming-service.ts',
    )
    out = must(
      out,
      'clearTimeout(timer)',
      '(globalThis as any).__b5Naming.clearTimer(timer)',
      'ai-naming-service.ts',
    )
    out = must(out, 'console.warn(', '(globalThis as any).__b5Naming.warn(', 'ai-naming-service.ts')
    return out
  })
  mod.registerAiNamingIpc(() => {
    log('lang')
    return spec.lang
  })
  const handler = rec.handlers.get(mod.AI_NAMING_SUGGEST_CHANNEL)!
  const results: unknown[] = []
  for (const s of spec.steps) {
    step = s
    results.push(await handler({ sender: { id: 1 } }, s.input))
    await tick()
  }
  return { channels: rec.channels, results }
}

const NAMING_FILE = (over: J = {}): string =>
  JSON.stringify({
    provider: 'anthropic',
    providers: { anthropic: { apiKey: 'k-ant', model: 'claude-sonnet-5-5' } },
    ...over,
  })

const READY_CODEX = { codex: { provider: 'codex', state: 'ready', meteredAccepted: false } }

const namingCase = (spec: Partial<NamingSpec>, file: string | null, note: string): Case => ({
  args: [{ userData: '$DIR/ud', lang: 'English', ...spec }],
  ...(file === null ? {} : { files: { 'ud/ai-settings.json': file } }),
  note,
})

const namingCases: Case[] = [
  namingCase(
    {
      steps: [
        { input: { content: '' } },
        { input: { content: '  \n\t ' } },
        { input: {} },
        { input: null },
        { input: { content: 5 } },
        {},
      ],
    },
    NAMING_FILE(),
    'nothing to name the file from: no provider is asked',
  ),
  namingCase(
    { steps: [{ input: { content: 'Quarterly numbers' } }] },
    null,
    'no settings file: no provider connected',
  ),
  namingCase(
    { steps: [{ input: { content: 'Quarterly numbers' } }] },
    '{ not json',
    'a broken settings file reads as no file',
  ),
  namingCase(
    {
      steps: [
        {
          input: { content: 'Quarterly revenue by region\n\n\n\nNorth is up.' },
          chat: { ok: true, content: 'Q3 Revenue Plan' },
        },
      ],
    },
    NAMING_FILE(),
    'a key provider names the file',
  ),
  namingCase(
    {
      lang: 'Korean',
      steps: [
        {
          input: { content: 'x'.repeat(5000) },
          chat: { ok: true, content: '\n  \n"Sure, here is a name:"\nSecond line' },
        },
      ],
    },
    NAMING_FILE(),
    'a long text is cut; the first non-blank line of the answer is the name',
  ),
  namingCase(
    {
      steps: [
        { input: { content: 'abc' }, chat: { ok: true, content: '///\n' } },
        { input: { content: 'abc' }, chat: { ok: true } },
        { input: { content: 'abc' }, chat: { ok: true, content: '' } },
      ],
    },
    NAMING_FILE(),
    'an answer that sanitises away to nothing is a failed naming',
  ),
  namingCase(
    {
      steps: [
        { input: { content: 'abc' }, chat: { ok: false, error: 'rate limited' } },
        { input: { content: 'abc' }, chat: { ok: false, error: { code: 429 } }, timer: true },
      ],
    },
    NAMING_FILE(),
    'the provider answers with an error; the timer decides the reason',
  ),
  namingCase(
    {
      steps: [
        { input: { content: 'abc' }, chat: { throw: 'offline' } },
        { input: { content: 'abc' }, chat: { throw: 'cut off' }, timer: true },
      ],
    },
    NAMING_FILE(),
    'the provider rejects',
  ),
  namingCase(
    {
      steps: [{ input: { content: 'abc' }, chat: { ok: true, content: 'Done Name' }, timer: true }],
    },
    NAMING_FILE(),
    'a timer that fired after the answer changes nothing',
  ),
  namingCase(
    { statuses: READY_CODEX, steps: [{ input: { content: 'abc' } }] },
    NAMING_FILE({ provider: 'codex', subscriptionNoticeVersion: 0 }),
    'a subscription whose first-connection notice is unread',
  ),
  namingCase(
    {
      statuses: READY_CODEX,
      steps: [{ input: { content: 'abc' }, chat: { ok: true, content: 'Plan B' } }],
    },
    NAMING_FILE({
      provider: 'codex',
      subscriptionNoticeVersion: 2,
      providers: { codex: { apiKey: '', model: '' } },
    }),
    'a subscription with the notice acknowledged',
  ),
  namingCase(
    { steps: [{ input: { content: 'abc' } }] },
    NAMING_FILE({ provider: 'glm' }),
    'the selected provider is not configured',
  ),
]

const namingFns: Group = {
  'ai-naming-service.AI_NAMING_SUGGEST_CHANNEL': constant(namingService.AI_NAMING_SUGGEST_CHANNEL),
  'ai-naming-service.registerAiNamingIpc': {
    ts: (a, cx) => runNaming(a[0] as NamingSpec, cx.log),
    cases: namingCases,
  },
}

// ---------------------------------------------------------------------------
// docs/free-ai-ipc
// ---------------------------------------------------------------------------

interface FreeStep {
  connect?: string
  input?: unknown
  open?: string
  gemini?: J
  geminiThrows?: boolean
  finish?: string
  result?: J
  cancel?: boolean
  disconnect?: unknown
  quota?: unknown
  quotaAnswer?: J
  openKeyPage?: unknown
}

interface FreeSpec {
  lang?: string
  settings: J
  writeOk?: boolean
  window?: { destroyed?: boolean; minimized?: boolean } | null
  openThrows?: boolean
  steps: FreeStep[]
}

async function runFreeAi(spec: FreeSpec, log: (...args: unknown[]) => void): Promise<unknown> {
  setUiLang((spec.lang ?? 'en') as 'en')
  const rec = ipcRecorder()
  useElectron({
    ipcMain: rec.ipcMain,
    shell: {
      openExternal: async (url: string) => {
        log('openExternal', url)
        if (spec.openThrows) throw new Error('no browser')
      },
    },
  })
  const deferred = new Map<string, { resolve: (value: J) => void; settled: boolean }>()
  let current: FreeStep = {}
  g.__b5Free = {
    connectGemini: async (apiKey: unknown) => {
      log('connectGemini', apiKey)
      if (current.geminiThrows) throw new Error('gemini failed')
      return current.gemini
    },
    connectOpenRouter: async (options: J) => {
      log('connectOpenRouter', options.pages)
      let resolve!: (value: J) => void
      const promise = new Promise<J>((r) => (resolve = r))
      const entry = { resolve, settled: false }
      deferred.set(current.connect!, entry)
      options.signal.addEventListener('abort', () => {
        entry.settled = true
        resolve({ ok: false, reason: 'cancelled' })
      })
      if (current.open !== undefined) {
        const opened = await options.openBrowser(current.open)
        log('opened', current.open, opened)
      }
      return promise
    },
    openRouterFreeQuota: async (key: string) => {
      log('openRouterFreeQuota', key)
      return current.quotaAnswer
    },
  }
  const mod = await loadPatched('apps/docs/src/main/free-ai-ipc.ts', (src) =>
    must(
      src,
      "import {\n  connectGemini,\n  connectOpenRouter,\n  openRouterFreeQuota,\n} from '@seuoffice/ai-provider/free-connect'",
      [
        'const connectGemini = (...a: any[]): any => (globalThis as any).__b5Free.connectGemini(...a)',
        'const connectOpenRouter = (...a: any[]): any => (globalThis as any).__b5Free.connectOpenRouter(...a)',
        'const openRouterFreeQuota = (...a: any[]): any => (globalThis as any).__b5Free.openRouterFreeQuota(...a)',
      ].join('\n'),
      'free-ai-ipc.ts',
    ),
  )
  let settings: J = spec.settings
  const window = spec.window
  mod.registerFreeAiIpc({
    readSettings: () => settings,
    writeSettings: (next: J) => {
      log('write', next)
      if (spec.writeOk === false) return false
      settings = next
      return true
    },
    windowFor: () => {
      log('windowFor')
      if (window === null || window === undefined) return undefined
      return {
        isDestroyed: () => !!window.destroyed,
        isMinimized: () => !!window.minimized,
        restore: () => log('restore'),
        show: () => log('show'),
        focus: () => log('focus'),
      }
    },
  })
  const event = { sender: { id: 1 } }
  const results: [string, unknown][] = []
  const direct: unknown[] = []
  const handler = (channel: string): Handler => rec.handlers.get(channel)!
  for (const step of spec.steps) {
    current = step
    if (step.connect !== undefined) {
      const name = step.connect
      const run = Promise.resolve(handler('ai:free-connect')(event, step.input)).then(
        (value) => results.push([name, value ?? null]),
        (error) => results.push([name, { error: String(error?.message ?? error) }]),
      )
      void run
    } else if (step.finish !== undefined) {
      const entry = deferred.get(step.finish)
      if (entry && !entry.settled) {
        entry.settled = true
        entry.resolve(step.result)
      }
    } else if (step.cancel) {
      await handler('ai:free-connect-cancel')(event)
    } else if (step.disconnect !== undefined) {
      direct.push((await handler('ai:free-disconnect')(event, step.disconnect)) ?? null)
    } else if (step.quota !== undefined) {
      direct.push((await handler('ai:free-quota')(event, step.quota)) ?? null)
    } else if (step.openKeyPage !== undefined) {
      direct.push((await handler('ai:free-open-key-page')(event, step.openKeyPage)) ?? null)
    }
    await tick()
  }
  return { channels: rec.channels, results, direct, settings }
}

const FREE_SETTINGS: J = {
  provider: 'auto',
  providers: {
    openrouter: { apiKey: 'or-old', model: 'old/model:free' },
    gemini: { apiKey: 'g-old', model: 'gemini-3.5-flash-lite' },
    anthropic: { apiKey: 'k', model: 'm' },
  },
}
const FREE_OK: J = { ok: true, apiKey: 'sk-or-new', model: 'new/model:free' }

const freeCase = (spec: Partial<FreeSpec>, note: string): Case => ({
  args: [{ settings: FREE_SETTINGS, window: { destroyed: false, minimized: false }, ...spec }],
  note,
})

const freeCases: Case[] = [
  freeCase(
    {
      steps: [
        {
          connect: 'A',
          input: { provider: 'gemini', apiKey: 'AIza-key' },
          gemini: { ok: true, apiKey: 'AIza-key', model: 'gemini-3.5-flash-lite' },
        },
      ],
    },
    'a Gemini key is written; the window is not raised',
  ),
  freeCase(
    {
      steps: [
        {
          connect: 'A',
          input: { provider: 'gemini', apiKey: 'bad' },
          gemini: { ok: false, reason: 'invalid' },
        },
      ],
    },
    'a refused Gemini key is passed on and nothing is written',
  ),
  freeCase(
    {
      writeOk: false,
      steps: [
        {
          connect: 'A',
          input: { provider: 'gemini', apiKey: 'k' },
          gemini: { ok: true, apiKey: 'k', model: 'm' },
        },
      ],
    },
    'the settings were refused: network',
  ),
  freeCase(
    { steps: [{ connect: 'A', input: { provider: 'gemini' }, geminiThrows: true }] },
    'the key check rejects',
  ),
  freeCase(
    {
      steps: [
        { connect: 'A', input: { provider: 'openrouter' } },
        { finish: 'A', result: FREE_OK },
      ],
    },
    'the browser sign-in finishes: the window is raised and the connection written',
  ),
  freeCase(
    {
      window: { destroyed: false, minimized: true },
      lang: 'ko',
      steps: [
        { connect: 'A', input: { provider: 'openrouter' }, open: 'https://openrouter.ai/auth?x=1' },
        { finish: 'A', result: FREE_OK },
      ],
    },
    'a minimized window is restored; the Korean pages; the address is opened',
  ),
  freeCase(
    {
      window: { destroyed: true },
      steps: [
        { connect: 'A', input: { provider: 'openrouter' }, open: 'javascript:alert(1)' },
        { finish: 'A', result: { ok: false, reason: 'timeout' } },
      ],
    },
    'an address that is not http(s) is not opened; a destroyed window is left alone',
  ),
  freeCase(
    {
      window: null,
      openThrows: true,
      steps: [
        { connect: 'A', input: { provider: 'openrouter' }, open: 'https://openrouter.ai/x' },
        { finish: 'A', result: FREE_OK },
      ],
    },
    'no window; the browser rejects',
  ),
  freeCase(
    {
      steps: [
        { connect: 'A', input: { provider: 'openrouter' } },
        { cancel: true },
        { cancel: true },
      ],
    },
    'a cancel ends the sign-in that waits: no window, nothing written',
  ),
  freeCase(
    {
      steps: [
        { connect: 'A', input: { provider: 'openrouter' } },
        { connect: 'B', input: { provider: 'openrouter' } },
        { finish: 'B', result: FREE_OK },
        { finish: 'A', result: FREE_OK },
      ],
    },
    'a newer sign-in replaces the one that waits',
  ),
  freeCase(
    {
      steps: [
        { connect: 'A', input: { provider: 'openrouter' } },
        { connect: 'B', input: { provider: 'openrouter' }, open: 'https://openrouter.ai/b' },
        { finish: 'A', result: FREE_OK },
        { cancel: true },
        { finish: 'B', result: FREE_OK },
      ],
    },
    'the replaced sign-in does not free the pending slot of the newer one',
  ),
  freeCase(
    {
      steps: [
        { connect: 'A', input: { provider: 'openrouter' } },
        { finish: 'A', result: { ok: false, reason: 'denied' } },
        { cancel: true },
      ],
    },
    'a denied sign-in raises the window and writes nothing',
  ),
  freeCase(
    {
      writeOk: false,
      steps: [
        { connect: 'A', input: { provider: 'openrouter' } },
        { finish: 'A', result: FREE_OK },
      ],
    },
    'a sign-in whose key could not be written: network',
  ),
  freeCase(
    {
      steps: [
        { connect: 'A', input: { provider: 'nope' } },
        { connect: 'B', input: null },
        { connect: 'C', input: 'openrouter' },
        { connect: 'D', input: { provider: 5 } },
      ],
    },
    'anything else is invalid',
  ),
  freeCase(
    {
      steps: [
        { disconnect: { provider: 'openrouter' } },
        { disconnect: { provider: 'gemini' } },
        { disconnect: { provider: 'nope' } },
        { disconnect: null },
      ],
    },
    'disconnect writes the settings without the key',
  ),
  freeCase(
    {
      settings: { ...FREE_SETTINGS, provider: 'gemini' },
      steps: [{ disconnect: { provider: 'gemini' } }],
    },
    'the selected provider falls back to auto',
  ),
  freeCase(
    {
      steps: [
        { quota: { provider: 'openrouter' }, quotaAnswer: { used: 1, limit: 50, remaining: 49 } },
        { quota: { provider: 'gemini' } },
        { quota: { provider: 'nope' } },
        { quota: null },
      ],
    },
    'the allowance of OpenRouter only',
  ),
  freeCase(
    {
      settings: { provider: 'auto', providers: {} },
      steps: [{ quota: { provider: 'openrouter' }, quotaAnswer: null }],
    },
    'no stored key asks with an empty one',
  ),
  freeCase(
    {
      steps: [
        { openKeyPage: { provider: 'openrouter' } },
        { openKeyPage: { provider: 'gemini' } },
        { openKeyPage: { provider: 'nope' } },
        { openKeyPage: null },
      ],
    },
    'the page where a key is made',
  ),
]

const freeFns: Group = {
  'docs/free-ai-ipc.registerFreeAiIpc': {
    ts: (a, cx) => runFreeAi(a[0] as FreeSpec, cx.log),
    cases: freeCases,
  },
}

// ---------------------------------------------------------------------------
// html/ai-search-ipc
// ---------------------------------------------------------------------------

interface HtmlSearchStep {
  register?: boolean
  web?: { query?: unknown; max?: unknown }
  image?: { query?: unknown; max?: unknown }
}

interface HtmlSearchSpec {
  userData: string
  env?: Record<string, string>
  answers?: { ok?: unknown; throw?: string }[]
  steps: HtmlSearchStep[]
}

async function runHtmlSearch(
  spec: HtmlSearchSpec,
  log: (...args: unknown[]) => void,
): Promise<unknown> {
  const queue = [...(spec.answers ?? [])]
  g.__b5Search = {
    call: async (kind: string, query: string, max: number, options: J) => {
      log(kind, query, max, options)
      const answer = queue.shift() ?? { ok: { results: [], method: 'none' } }
      if (answer.throw !== undefined) throw new Error(answer.throw)
      return answer.ok
    },
  }
  g.__b5SearchTools = await loadPatched('packages/ai-search/src/search-tools.ts', (src) =>
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
  const mod = await loadPatched('apps/html/src/main/ai-search-ipc.ts', (src) =>
    must(
      src,
      "import { imageSearchTool, webSearchTool } from '@seuoffice/ai-search'",
      [
        'const webSearchTool = (...a: any[]): any => (globalThis as any).__b5SearchTools.webSearchTool(...a)',
        'const imageSearchTool = (...a: any[]): any => (globalThis as any).__b5SearchTools.imageSearchTool(...a)',
      ].join('\n'),
      'ai-search-ipc.ts',
    ),
  )
  const rec = ipcRecorder()
  useElectron({ ipcMain: rec.ipcMain, app: { getPath: () => spec.userData } })
  const answers: unknown[] = []
  await withEnv({ ...NO_SEARCH_ENV, ...spec.env }, async () => {
    for (const step of spec.steps) {
      if (step.register) {
        const before = rec.channels.length
        mod.registerHtmlAiSearchIpc()
        answers.push(rec.channels.slice(before))
        continue
      }
      const call = step.web ?? step.image!
      const channel = step.web ? 'ai:web-search' : 'ai:image-search'
      const args: unknown[] = []
      if ('query' in call) args.push(call.query)
      else args.push(undefined)
      if ('max' in call) args.push(call.max)
      answers.push(await rec.handlers.get(channel)!({ sender: { id: 1 } }, ...args))
    }
  })
  return answers
}

const htmlCase = (spec: Partial<HtmlSearchSpec>, file: string | null, note: string): Case => ({
  args: [{ userData: '$DIR/ud', ...spec }],
  ...(file === null ? {} : { files: { 'ud/ai-settings.json': file } }),
  note,
})

const htmlCases: Case[] = [
  htmlCase(
    { steps: [{ register: true }, { register: true }, { register: true }] },
    null,
    'handlers are registered once',
  ),
  htmlCase(
    {
      steps: [{ register: true }, { web: { query: 'cats' } }, { image: { query: 'dogs' } }],
      answers: [
        { ok: { results: [1], method: 'parallel' } },
        { ok: { images: [2], method: 'duckduckgo' } },
      ],
    },
    '{}',
    'default result counts: 6 and 8',
  ),
  htmlCase(
    {
      steps: [
        { register: true },
        { web: { query: 'cats', max: 3 } },
        { web: { query: 'cats', max: 0 } },
        { image: { query: 'dogs', max: 2 } },
        { image: { query: 'dogs', max: '9' } },
      ],
    },
    JSON.stringify({
      providers: {},
      search: { provider: 'serper', providers: { serper: { apiKey: ' sk ' } } },
    }),
    'a number is taken as given; a string is not',
  ),
  htmlCase(
    {
      steps: [
        { register: true },
        { web: { query: 7 } },
        { web: { query: null } },
        { web: { query: { a: 1 } } },
        { web: { query: ['x', 'y'] } },
        { web: {} },
        { image: { query: true, max: null } },
      ],
    },
    null,
    'the query is String()ed',
  ),
  htmlCase(
    {
      steps: [{ register: true }, { web: { query: 'cats' } }, { image: { query: 'dogs' } }],
      answers: [{ throw: 'down' }, { throw: 'also down' }],
    },
    '{}',
    'a failing backend answers an error object',
  ),
  htmlCase(
    { env: { EXA_API_KEY: 'env-exa' }, steps: [{ register: true }, { web: { query: 'q' } }] },
    JSON.stringify({ providers: {}, search: { provider: 'exa' } }),
    'the environment stands in for the key of the selected provider',
  ),
]

const htmlFns: Group = {
  'html/ai-search-ipc.registerHtmlAiSearchIpc': {
    ts: (a, cx) => runHtmlSearch(a[0] as HtmlSearchSpec, cx.log),
    cases: htmlCases,
  },
}

// ---------------------------------------------------------------------------
// hwp/ai-image and mindmap/ai-image
// ---------------------------------------------------------------------------

interface MediaStep {
  generate?: { op?: unknown; sender?: { id: number; destroyed?: boolean }; answer?: J }
  analyze?: { op?: unknown; sender?: { id: number; destroyed?: boolean }; answer?: J }
}

interface MediaSpec {
  userData: string
  temp: string
  statuses?: J
  files?: Record<string, string | null>
  pastedImageDir?: string
  steps: MediaStep[]
}

async function runMedia(
  file: 'apps/hwp/src/main/ai-image.ts' | 'apps/mindmap/src/main/ai-image.ts',
  channels: { aiGenerateImage: string; analyzeMedia?: string },
  spec: MediaSpec,
  log: (...args: unknown[]) => void,
): Promise<unknown> {
  let step: MediaStep = {}
  g.__b5Media = {
    generate: async (settingsPath: string, op: J, options: J) => {
      log('generateImageTool', settingsPath, op, {
        mediaRoots: options.mediaRoots,
        context: options.context,
        aborted: options.signal.aborted,
      })
      return step.generate?.answer
    },
    analyze: async (settingsPath: string, op: J, options: J) => {
      log('analyzeMediaTool', settingsPath, op, {
        context: options.context,
        aborted: options.signal.aborted,
      })
      return step.analyze?.answer
    },
    statuses: () => {
      log('statuses')
      return spec.statuses ?? {}
    },
  }
  const rec = ipcRecorder()
  useElectron({
    ipcMain: rec.ipcMain,
    app: {
      getPath: (name: string) => {
        log('getPath', name)
        return name === 'temp' ? spec.temp : spec.userData
      },
    },
  })
  const mod = await loadPatched(file, (src) => {
    let out = src.replace(
      /import \{[^}]*\} from '@seuoffice\/ai-search'/,
      [
        `import { withMediaCallSignal } from '${repoUrl('packages/ai-search/src/media-call-abort.ts')}'`,
        `import { documentMediaRoots } from '${repoUrl('packages/ai-search/src/media-tools.ts')}'`,
        'const generateImageTool = (...a: any[]): any => (globalThis as any).__b5Media.generate(...a)',
        'const analyzeMediaTool = (...a: any[]): any => (globalThis as any).__b5Media.analyze(...a)',
      ].join('\n'),
    )
    out = must(
      out,
      "import { sharedSubscriptionStatuses } from '@seuoffice/ai-provider/subscription'",
      'const sharedSubscriptionStatuses = (): any => (globalThis as any).__b5Media.statuses()',
      file,
    )
    return must(
      out,
      "import { fetchImageBytes } from '@seuoffice/electron-utils/fetch-image-bytes'",
      'const fetchImageBytes = (_url: unknown): any => null',
      file,
    )
  })
  const filePathOf = (id: number): string | null => {
    log('filePathOf', id)
    return spec.files?.[String(id)] ?? null
  }
  if (file.includes('hwp')) mod.registerHwpImageIpc({ filePathOf })
  else mod.registerMindmapImageIpc({ filePathOf, pastedImageDir: spec.pastedImageDir })
  const answers: unknown[] = []
  for (const s of spec.steps) {
    step = s
    const call = s.generate ?? s.analyze!
    const sender = fakeSender(call.sender?.id ?? 1, call.sender?.destroyed ?? false)
    const channel = s.generate ? channels.aiGenerateImage : channels.analyzeMedia!
    // a handler that rejects (a `String()` that throws) leaves the rest of
    // the scenario to run
    try {
      answers.push((await rec.handlers.get(channel)!({ sender }, call.op)) ?? null)
    } catch (error) {
      answers.push({ thrown: String(error) })
    }
  }
  return answers
}

const mediaSpec = (spec: Partial<MediaSpec>): MediaSpec => ({
  userData: '/ud',
  temp: '/tmp',
  files: { '1': '/docs/work/map.xmind' },
  pastedImageDir: '/tmp/seuoffice-pasted',
  steps: [],
  ...spec,
})

const IMG = 'data:image/png;base64,AAAA'

const generateSteps = (): MediaStep[][] => [
  [
    {
      generate: {
        op: { prompt: 'a cat', aspectRatio: '16:9' },
        answer: { url: 'file:///g/1.png' },
      },
    },
  ],
  [
    {
      generate: { op: { prompt: 7, aspectRatio: 0 }, answer: { error: 'x', code: 'unavailable' } },
    },
  ],
  [{ generate: { op: { aspectRatio: '' }, sender: { id: 2 } } }],
  [{ generate: { op: null } }, { generate: { op: 'text' } }, { generate: {} }],
  [{ generate: { op: { prompt: null, aspectRatio: null }, sender: { id: 1, destroyed: true } } }],
  [{ generate: { op: { prompt: { a: 1 }, aspectRatio: ['4:3'] } } }],
]

const mediaCases = (extra: Partial<MediaSpec>, steps: MediaStep[][]): Case[] =>
  steps.map((s, i): Case => ({
    args: [
      mediaSpec({
        ...extra,
        steps: s,
        statuses: i === 1 ? { codex: { provider: 'codex', state: 'ready' } } : {},
      }),
    ],
  }))

const hwpCases: Case[] = [
  ...mediaCases({ files: { '1': '/docs/work/page.hwp' } }, generateSteps()),
  ...mediaCases({ files: {} }, [[{ generate: { op: { prompt: 'untitled' } } }]]),
  {
    args: [
      mediaSpec({
        steps: [
          {
            analyze: {
              op: {
                mediaUrls: [
                  IMG,
                  'https://x.test/a.png',
                  'DATA:IMAGE/jpeg;base64,BB',
                  'data:text/plain,hi',
                  5,
                  null,
                ],
                requirements: 'what is it',
              },
              answer: { text: 'a cat' },
            },
          },
        ],
      }),
    ],
    note: 'only image data URLs are taken',
  },
  {
    args: [
      mediaSpec({
        steps: [{ analyze: { op: { mediaUrls: ['https://x.test/a.png', 'data:text/plain,hi'] } } }],
      }),
    ],
    note: 'no picture',
  },
  {
    args: [
      mediaSpec({
        steps: [
          { analyze: { op: { mediaUrls: 'not a list' } } },
          { analyze: { op: null } },
          { analyze: {} },
        ],
      }),
    ],
    note: 'no list at all',
  },
  {
    args: [
      mediaSpec({
        statuses: { chatgpt: { provider: 'chatgpt', state: 'ready' } },
        steps: [
          {
            analyze: {
              op: { mediaUrls: [IMG], requirements: null },
              sender: { id: 3, destroyed: true },
            },
          },
          { analyze: { op: { mediaUrls: [IMG], requirements: 42 } } },
        ],
      }),
    ],
    note: 'a destroyed window, an odd requirement',
  },
  {
    args: [
      mediaSpec({
        steps: [
          { generate: { op: { prompt: { toString: 0 } } } },
          { generate: { op: { prompt: 'ok', aspectRatio: { toString: 0 } } } },
          { analyze: { op: { mediaUrls: [IMG, { toString: 0 }] } } },
          { analyze: { op: { mediaUrls: [IMG], requirements: { toString: 0 } } } },
          { generate: { op: { prompt: 'after' }, answer: { url: 'file:///g/2.png' } } },
        ],
      }),
    ],
    note: 'a String() that throws rejects the handler; the next call still runs',
  },
]

const mindmapCases: Case[] = [
  ...mediaCases({}, generateSteps()),
  ...mediaCases({ files: {}, pastedImageDir: '' }, [
    [{ generate: { op: { prompt: 'untitled' } } }],
  ]),
  {
    args: [
      mediaSpec({
        steps: [
          { generate: { op: { prompt: { toString: 0 } } } },
          { generate: { op: { prompt: 'ok', aspectRatio: { toString: 0 } } } },
          { generate: { op: { prompt: 'after' }, answer: { url: 'file:///g/2.png' } } },
        ],
      }),
    ],
    note: 'a String() that throws rejects the handler; the next call still runs',
  },
]

const hwpFns: Group = {
  'hwp/ai-image.registerHwpImageIpc': {
    ts: (a, cx) =>
      runMedia('apps/hwp/src/main/ai-image.ts', hwpIpc.HWP_CHANNELS, a[0] as MediaSpec, cx.log),
    cases: hwpCases,
  },
}

const mindmapFns: Group = {
  'mindmap/ai-image.registerMindmapImageIpc': {
    ts: (a, cx) =>
      runMedia(
        'apps/mindmap/src/main/ai-image.ts',
        mindmapIpc.MINDMAP_CHANNELS,
        a[0] as MediaSpec,
        cx.log,
      ),
    cases: mindmapCases,
  },
}

export const modulesGroup: Group = {
  ...namingFns,
  ...freeFns,
  ...htmlFns,
  ...hwpFns,
  ...mindmapFns,
}
