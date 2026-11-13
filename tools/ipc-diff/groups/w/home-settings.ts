/**
 * Group `w/home-settings`: home's settings and app facts, the handlers of
 * `registerHomeIpc` and `registerResultStoreIpc` in
 * `apps/shell/src/main/index.ts`, loaded with the entry module itself.
 *
 * What the app does beyond the settings file is fixed as the Rust fake
 * (`HomeApp`, `probe_hosts` of home_settings.rs) answers it, from the case's
 * `hosts.w.homeApp`: the version, `os.release()`, the clock, the notices
 * path, the decision endpoint (a `fetch` that answers `decision`), and the MCP
 * runtime. This group leaves the MCP runtime as the entry module has it
 * before the app is ready (not configured: turning the server on fails); the
 * log file side is `w/home-settings-mcp`.
 */
import fs, { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import {
  applyMcpSettings,
  configureMcpRuntime,
} from '../../../../apps/shell/src/main/mcp/app-mcp.ts'
import type { Case, Group, LoadContext } from '../../types.ts'
import { loadShellIndex } from './shell-index.ts'

const NOW = 1_700_000_000_000

/** what `hosts.w.homeApp` carries (the Rust fake reads the same keys) */
export interface HomeApp {
  version?: string
  osRelease?: string
  nowMs?: number
  noticesPath?: string
  /** the decision endpoint: the error code the Rust fake answers, and the reply the TypeScript's `fetch` gives */
  decision?: { code?: string; status?: number; body?: string; retryAfter?: string }
  /** the MCP runtime is configured with this log file */
  mcpLogFile?: string
}

export const homeApp = (extra: HomeApp = {}) => ({
  version: '1.2.3',
  osRelease: release(),
  nowMs: NOW,
  noticesPath: join(process.cwd(), 'apps', 'shell', 'build', 'THIRD-PARTY-NOTICES.txt'),
  ...extra,
})

/** the shell window is not up in the comparison: no main window, as `shellWindow` is null */
const NO_MAIN_WINDOW = { mainWindow: { view: 99, window: 99 } }

export const hosts = (extra: HomeApp = {}, shared: Record<string, unknown> = {}) => ({
  shared: { ...NO_MAIN_WINDOW, ...shared },
  w: { homeApp: homeApp(extra) },
})

export async function loadHome(cx: LoadContext): Promise<void> {
  // the folder watchers the shell starts are real `fs.watch`es: their late events would reach a later case
  Object.assign(fs, { watch: () => ({ on: () => {}, close: () => {} }) })
  const w = cx.case.hosts?.w
  // the case's own `hosts()` built it: the keys are the ones HomeApp lists
  const app: HomeApp = w && typeof w === 'object' && 'homeApp' in w ? (w.homeApp as HomeApp) : {}
  Date.now = () => app.nowMs ?? NOW
  globalThis.fetch = (async () => {
    const d = app.decision
    if (d?.status === undefined) throw new Error('no network in the comparison')
    return new Response(d.body ?? '', {
      status: d.status,
      headers: d.retryAfter ? { 'retry-after': d.retryAfter } : {},
    })
  }) as typeof fetch
  // the MCP module is shared by the group's cases: put it back as a fresh start has it
  await applyMcpSettings({ enabled: false, port: 3093, background: false, logging: false })
  if (app.mcpLogFile) {
    // the logger empties its file when it is made; the case's own content stays
    const seeded = existsSync(app.mcpLogFile) ? readFileSync(app.mcpLogFile) : undefined
    configureMcpRuntime({
      version: app.version ?? '',
      defaultSaveDir: () => '',
      openPath: () => false,
      logFilePath: app.mcpLogFile,
    })
    if (seeded !== undefined) writeFileSync(app.mcpLogFile, seeded)
  }
  await loadShellIndex(cx, { version: app.version })
}

export const SETTINGS = 'userData/app-settings.json'
export const saved = (settings: unknown): Record<string, string> => ({
  [SETTINGS]: JSON.stringify(settings),
})
export const call = (channel: string, ...args: unknown[]) => ({ channel, args })
export const undef = { $: 'u' }

const get = (channel: string) => call(channel)
const DECISION_OK = JSON.stringify({
  answers: {
    d0: { type: 'score', score: 0, confidence: 1, probabilities: { 0: 1, 1: 0, 2: 0 } },
    d1: { type: 'score', score: 0, confidence: 1, probabilities: { 0: 1, 1: 0, 2: 0 } },
  },
})

const cases: Case[] = [
  // ---- app facts and flags ----
  {
    note: 'the version is the app host',
    hosts: hosts({ version: '9.8.7' }),
    calls: [get('home:get-app-version')],
  },
  {
    note: 'a view the channel is not open to is refused',
    views: [{ view: 2, surface: 'Docs' }],
    hosts: hosts(),
    calls: [get('home:get-app-version')],
  },
  {
    note: 'onboarding: not seen, then seen',
    hosts: hosts(),
    files: { userData: { dir: true } },
    calls: [
      get('home:onboarding-seen'),
      get('home:set-onboarding-seen'),
      get('home:onboarding-seen'),
    ],
  },
  {
    note: 'onboarding seen in the file; a non-boolean value is not seen',
    hosts: hosts(),
    files: saved({ onboardingSeen: 'yes', other: 1 }),
    calls: [
      get('home:onboarding-seen'),
      get('home:set-onboarding-seen'),
      get('home:onboarding-seen'),
    ],
  },
  {
    note: 'onboarding cannot be saved without the folder: false',
    hosts: hosts(),
    calls: [get('home:set-onboarding-seen')],
  },
  {
    note: 'update check: on by default, off in the file, a string is on',
    hosts: hosts(),
    files: saved({ autoUpdateCheck: false }),
    calls: [get('home:get-auto-update-check')],
  },
  {
    note: 'update check: not a boolean in the file reads as on',
    hosts: hosts(),
    files: saved({ autoUpdateCheck: 'off' }),
    calls: [get('home:get-auto-update-check')],
  },
  {
    note: 'update check: switch off and on, a non-boolean is ignored',
    hosts: hosts(),
    files: saved({ lang: 'ko' }),
    calls: [
      get('home:get-auto-update-check'),
      call('home:set-auto-update-check', false),
      get('home:get-auto-update-check'),
      call('home:set-auto-update-check', 'no'),
      call('home:set-auto-update-check', true),
      get('home:get-auto-update-check'),
    ],
  },
  {
    note: 'update check: the write fails without the folder',
    hosts: hosts(),
    calls: [call('home:set-auto-update-check', false)],
  },

  // ---- auto save default ----
  {
    note: 'auto save: the defaults, then saved values, a bad time reads 0',
    hosts: hosts(),
    files: saved({ autoSaveDefault: true, autoSaveDefaultUpdatedAt: 123 }),
    calls: [get('home:get-auto-save-default')],
  },
  {
    note: 'auto save: wrong types in the file',
    hosts: hosts(),
    files: saved({ autoSaveDefault: 'true', autoSaveDefaultUpdatedAt: -5 }),
    calls: [get('home:get-auto-save-default')],
  },
  {
    note: 'auto save: turn on (stamp, event), same value again does nothing, off again',
    hosts: hosts({ nowMs: 1_800_000_000_123 }),
    files: { userData: { dir: true } },
    calls: [
      get('home:get-auto-save-default'),
      call('home:set-auto-save-default', true),
      call('home:set-auto-save-default', true),
      get('home:get-auto-save-default'),
      call('home:set-auto-save-default', 'on'),
      call('home:set-auto-save-default', false),
      get('home:get-auto-save-default'),
    ],
  },
  {
    note: 'auto save: a failed write leaves the new value in memory and sends nothing',
    hosts: hosts(),
    calls: [call('home:set-auto-save-default', true), get('home:get-auto-save-default')],
  },

  // ---- csv import limit ----
  {
    note: 'csv limit: default, a saved step, a value that is no step',
    hosts: hosts(),
    files: saved({ csvImportLimitMb: 128 }),
    calls: [get('home:get-csv-import-limit')],
  },
  {
    note: 'csv limit: a saved value that is not a step reads as the default',
    hosts: hosts(),
    files: saved({ csvImportLimitMb: 100 }),
    calls: [get('home:get-csv-import-limit')],
  },
  {
    note: 'csv limit: set a step, again (no write), a non-step, a string, a fraction',
    hosts: hosts(),
    files: saved({ lang: 'ko' }),
    calls: [
      get('home:get-csv-import-limit'),
      call('home:set-csv-import-limit', 64),
      get('home:get-csv-import-limit'),
      call('home:set-csv-import-limit', 64),
      call('home:set-csv-import-limit', 100),
      call('home:set-csv-import-limit', '128'),
      call('home:set-csv-import-limit', 64.5),
      call('home:set-csv-import-limit', 128),
      get('home:get-csv-import-limit'),
    ],
  },
  {
    note: 'csv limit: a value that is no step is not saved',
    hosts: hosts(),
    files: saved({ lang: 'ko' }),
    calls: [call('home:set-csv-import-limit', 100), get('home:get-csv-import-limit')],
  },
  {
    note: 'csv limit: the write fails without the folder',
    hosts: hosts(),
    calls: [call('home:set-csv-import-limit', 128)],
  },

  // ---- the default app ----
  {
    note: 'default app: a build that is not packaged never claims the types',
    hosts: hosts(),
    calls: [get('home:get-default-app-status'), get('home:set-default-app')],
  },

  // ---- the default save folder ----
  {
    note: 'save folder: <Documents>/SeuOffice, made on the way',
    hosts: hosts(),
    files: { userData: { dir: true } },
    calls: [get('home:get-default-save-dir')],
  },
  {
    note: 'save folder: the saved folder',
    hosts: hosts(),
    files: saved({ defaultSaveDir: '$DIR/chosen' }),
    calls: [get('home:get-default-save-dir')],
  },
  {
    note: 'save folder: a relative saved folder is ignored',
    hosts: hosts(),
    files: saved({ defaultSaveDir: 'relative' }),
    calls: [get('home:get-default-save-dir')],
  },
  {
    note: 'save folder: a saved folder that cannot be made falls back to Documents',
    hosts: hosts(),
    files: {
      ...saved({ defaultSaveDir: '$DIR/afile/inside' }),
      afile: 'a file, not a folder',
    },
    calls: [get('home:get-default-save-dir')],
  },
  {
    note: 'save folder: nothing can be made',
    hosts: hosts(),
    files: { documents: 'a file', home: 'a file', userData: 'a file' },
    calls: [get('home:get-default-save-dir')],
  },
  {
    note: 'pick the save folder: chosen and saved',
    hosts: hosts({}, { dialogs: { open: [['$DIR/picked']] } }),
    files: { userData: { dir: true } },
    calls: [call('home:pick-default-save-dir'), get('home:get-default-save-dir')],
  },
  {
    note: 'pick the save folder: cancelled, then the English title',
    hosts: hosts({}, { dialogs: { open: [null] } }),
    files: saved({ language: 'en', defaultSaveDir: '$DIR/chosen' }),
    calls: [call('home:pick-default-save-dir')],
  },
  {
    note: 'pick the save folder: an empty answer is a cancel',
    hosts: hosts({}, { dialogs: { open: [[]] } }),
    files: saved({ language: 'ko' }),
    calls: [call('home:pick-default-save-dir')],
  },
  {
    note: 'pick the save folder: a folder that cannot be used is reported (English)',
    hosts: hosts({}, { dialogs: { open: [['$DIR/afile/inside']] } }),
    files: { ...saved({ language: 'en' }), afile: 'a file, not a folder' },
    calls: [call('home:pick-default-save-dir')],
  },
  {
    note: 'pick the save folder: a folder that cannot be used is reported (Korean)',
    hosts: hosts({}, { dialogs: { open: [['$DIR/afile/inside']] } }),
    files: { ...saved({ language: 'ko' }), afile: 'a file, not a folder' },
    calls: [call('home:pick-default-save-dir')],
  },
  {
    note: 'pick the save folder: the write fails after a good pick',
    hosts: hosts({}, { dialogs: { open: [['$DIR/picked']] } }),
    files: { documents: { dir: true } },
    calls: [call('home:pick-default-save-dir')],
  },

  // ---- the file search settings ----
  {
    note: 'search settings: the defaults',
    hosts: hosts(),
    calls: [get('home:get-file-search-settings')],
  },
  {
    note: 'search settings: saved, trimmed and cut, the former jev names, a wrong endpoint',
    hosts: hosts(),
    files: saved({
      fileSearch: {
        rerank: true,
        jevEndpoint: 'direct',
        jevKeys: { direct: `  ${'k'.repeat(600)}  `, openrouter: 5 },
        customBaseUrl: ` ${'u'.repeat(600)} `,
        customModel: 'm'.repeat(200),
        cloudflareAccountId: ' acct ',
        cloudflareModel: '   ',
      },
    }),
    calls: [get('home:get-file-search-settings')],
  },
  {
    note: 'search settings: an unknown endpoint, a string for the keys, rerank not true',
    hosts: hosts(),
    files: saved({ fileSearch: { endpoint: 'nope', keys: 'abc', rerank: 1 } }),
    calls: [get('home:get-file-search-settings')],
  },
  {
    note: 'search settings: the value is not an object',
    hosts: hosts(),
    files: saved({ fileSearch: 'x' }),
    calls: [get('home:get-file-search-settings')],
  },
  {
    note: 'search settings: a patch keeps the other fields and merges the keys',
    hosts: hosts(),
    files: saved({
      fileSearch: { rerank: false, endpoint: 'openai', keys: { openai: 'sk-1', kev: 'old' } },
    }),
    calls: [
      call('home:set-file-search-settings', {
        rerank: true,
        keys: { kev: '  new  ', custom: 'c' },
        customModel: 'gpt',
      }),
      get('home:get-file-search-settings'),
    ],
  },
  {
    note: 'search settings: an undefined field reads as missing, not as the old value',
    hosts: hosts(),
    files: saved({
      fileSearch: { rerank: true, endpoint: 'kev', keys: { kev: 'k' }, cloudflareModel: 'x' },
    }),
    calls: [
      call('home:set-file-search-settings', {
        rerank: undef,
        endpoint: undef,
        keys: { kev: undef },
      }),
    ],
  },
  {
    note: 'search settings: a patch that is not an object',
    hosts: hosts(),
    files: saved({ fileSearch: { rerank: true, endpoint: 'rizzo' } }),
    calls: [
      call('home:set-file-search-settings', null),
      call('home:set-file-search-settings', 'x'),
      call('home:set-file-search-settings'),
      call('home:set-file-search-settings', [1, 2]),
    ],
  },
  {
    note: 'search settings: the write fails without the folder',
    hosts: hosts(),
    calls: [call('home:set-file-search-settings', { rerank: true })],
  },
  {
    note: 'search test: a hosted endpoint without a key',
    hosts: hosts(),
    calls: [
      call('home:test-file-search-rerank', { endpoint: 'openai', keys: { openai: '   ' } }),
      call('home:test-file-search-rerank'),
    ],
  },
  {
    note: 'search test: a local server answers',
    hosts: hosts({ decision: { status: 200, body: DECISION_OK } }),
    calls: [call('home:test-file-search-rerank', { endpoint: 'kev' })],
  },
  {
    note: 'search test: a hosted endpoint, an error status',
    hosts: hosts({ decision: { code: 'http-500', status: 500, body: 'boom' } }),
    calls: [
      call('home:test-file-search-rerank', { endpoint: 'openrouter', keys: { openrouter: 'k' } }),
    ],
  },
  {
    note: 'search test: rate limited with a long wait',
    hosts: hosts({ decision: { code: 'rate-limit', status: 429, retryAfter: '3600' } }),
    calls: [call('home:test-file-search-rerank', { endpoint: 'rizzo' })],
  },
  {
    note: 'search test: a reply that is not JSON',
    hosts: hosts({ decision: { code: 'invalid-response', status: 200, body: 'not json' } }),
    calls: [call('home:test-file-search-rerank', { endpoint: 'kev' })],
  },
  {
    note: 'search test: a custom server without an address',
    hosts: hosts({ decision: { code: 'missing-url' } }),
    calls: [call('home:test-file-search-rerank', { endpoint: 'custom' })],
  },
  {
    note: 'search test: a custom address that is not https',
    hosts: hosts({ decision: { code: 'insecure-url' } }),
    calls: [
      call('home:test-file-search-rerank', { endpoint: 'custom', customBaseUrl: 'ftp://host/x' }),
    ],
  },
  {
    note: 'search test: a custom address that is no address',
    hosts: hosts({ decision: { code: 'bad-url' } }),
    calls: [
      call('home:test-file-search-rerank', { endpoint: 'custom', customBaseUrl: 'not a url' }),
    ],
  },
  {
    note: 'search test: Cloudflare without an account',
    hosts: hosts({ decision: { code: 'missing-account' } }),
    calls: [
      call('home:test-file-search-rerank', { endpoint: 'cloudflare', keys: { cloudflare: 'k' } }),
    ],
  },

  // ---- which kinds home shows ----
  {
    note: 'kinds: the first order',
    hosts: hosts(),
    calls: [get('home:get-home-kinds')],
  },
  {
    note: 'kinds: a saved order missing newer kinds, unknown and doubled ids',
    hosts: hosts(),
    files: saved({
      homeKinds: { order: ['pdf', 'nope', 'docx', 'pdf', 'hwp'], hidden: ['hwp', 'zzz', 'xlsx'] },
    }),
    calls: [get('home:get-home-kinds')],
  },
  {
    note: 'kinds: the saved value is not an object',
    hosts: hosts(),
    files: saved({ homeKinds: ['docx'] }),
    calls: [get('home:get-home-kinds')],
  },
  {
    note: 'kinds: set an order and hidden kinds, read back, then the first state is stored empty',
    hosts: hosts(),
    files: { userData: { dir: true } },
    calls: [
      call('home:set-home-kinds', {
        order: ['md', 'docx', 'xlsx'],
        hidden: ['pptx', 'md', 'bogus'],
      }),
      get('home:get-home-kinds'),
      call('home:set-home-kinds', {
        order: ['docx', 'xlsx', 'pptx', 'md', 'html', 'xmind', 'drawio', 'hwp', 'pdf', 'pdfTools'],
        hidden: [],
      }),
      call('home:set-home-kinds', null),
      call('home:set-home-kinds'),
      call('home:set-home-kinds', 'docx'),
    ],
  },
  {
    note: 'kinds: the write fails without the folder: no event',
    hosts: hosts(),
    calls: [call('home:set-home-kinds', { hidden: ['md'] })],
  },

  // ---- Hangul save format and legacy import prompt ----
  {
    note: 'hwp format: the default, a saved hwpx, a saved value that is not a format',
    hosts: hosts(),
    files: saved({ hwpDefaultFormat: 'hwpx' }),
    calls: [get('home:get-hwp-default-format')],
  },
  {
    note: 'hwp format: a saved value that is not a format',
    hosts: hosts(),
    files: saved({ hwpDefaultFormat: 'doc' }),
    calls: [get('home:get-hwp-default-format')],
  },
  {
    note: 'hwp format: set hwpx, a junk value gives hwp, read back',
    hosts: hosts(),
    files: { userData: { dir: true } },
    calls: [
      call('home:set-hwp-default-format', 'hwpx'),
      get('home:get-hwp-default-format'),
      call('home:set-hwp-default-format', 'rtf'),
      call('home:set-hwp-default-format'),
      call('home:set-hwp-default-format', 5),
    ],
  },
  {
    note: 'hwp format: the write fails without the folder',
    hosts: hosts(),
    calls: [call('home:set-hwp-default-format', 'hwpx')],
  },
  {
    note: 'legacy prompt: asks by default, not when a format is skipped',
    hosts: hosts(),
    files: saved({ legacyImportSkipConfirm: { word97: true, ppt: false } }),
    calls: [get('home:get-legacy-import-prompt')],
  },
  {
    note: 'legacy prompt: default',
    hosts: hosts(),
    calls: [get('home:get-legacy-import-prompt')],
  },
  {
    note: 'legacy prompt: turn off, back on, undefined means on',
    hosts: hosts(),
    files: saved({ lang: 'ko' }),
    calls: [
      call('home:set-legacy-import-prompt', false),
      get('home:get-legacy-import-prompt'),
      call('home:set-legacy-import-prompt', true),
      call('home:set-legacy-import-prompt', false),
      call('home:set-legacy-import-prompt'),
      call('home:set-legacy-import-prompt', 0),
    ],
  },
  {
    note: 'legacy prompt: the write fails without the folder',
    hosts: hosts(),
    calls: [call('home:set-legacy-import-prompt', false)],
  },

  // ---- MCP (the runtime is not configured: turning the server on fails) ----
  {
    note: 'mcp: the status before anything is set',
    hosts: hosts(),
    calls: [get('home:get-mcp-status')],
  },
  {
    note: 'mcp: settings kept while the server stays off, read back from the file and the runtime',
    hosts: hosts(),
    files: { userData: { dir: true } },
    calls: [
      call('home:set-mcp-settings', { port: 4000, logging: true }),
      get('home:get-mcp-status'),
      call('home:set-mcp-settings', { port: 70000, background: true }),
      call('home:set-mcp-settings', { port: 3.5, enabled: 'yes', logging: undef }),
      call('home:set-mcp-settings', { port: '5000' }),
    ],
  },
  {
    note: 'mcp: switching the server on fails, the settings stay saved',
    hosts: hosts(),
    files: saved({ mcpPort: 4001, mcpBackground: true }),
    calls: [
      call('home:set-mcp-settings', { enabled: true }),
      get('home:get-mcp-status'),
      call('home:set-mcp-settings', { enabled: false }),
    ],
  },
  {
    note: 'mcp: a patch that is not an object answers the status',
    hosts: hosts(),
    calls: [
      call('home:set-mcp-settings', null),
      call('home:set-mcp-settings', 'on'),
      call('home:set-mcp-settings'),
      call('home:set-mcp-settings', [true]),
    ],
  },
  {
    note: 'mcp: saved settings are the base of a patch',
    hosts: hosts(),
    files: saved({ mcpPort: 'x', mcpBackground: true, mcpLogging: 1 }),
    calls: [call('home:set-mcp-settings', { logging: true })],
  },
  {
    note: 'mcp: the write fails without the folder',
    hosts: hosts(),
    calls: [call('home:set-mcp-settings', { port: 4000 })],
  },
  {
    note: 'mcp: logs and the log file when the runtime has none',
    hosts: hosts(),
    calls: [get('home:get-mcp-logs'), get('home:clear-mcp-logs'), get('home:open-mcp-log-file')],
  },

  // ---- links ----
  {
    note: 'help: a topic and none',
    hosts: hosts(),
    calls: [call('home:open-help', 'shortcuts'), call('home:open-help', 7), call('home:open-help')],
  },
  {
    note: 'repository: opened, and a browser that fails is not reported',
    hosts: hosts({}, { osShell: { openExternalError: 'no browser' } }),
    calls: [get('home:open-github-repo')],
  },
  {
    note: 'repository: opened',
    hosts: hosts(),
    calls: [get('home:open-github-repo')],
  },
  {
    note: 'notices: opened',
    hosts: hosts(),
    calls: [get('home:open-license-notices')],
  },
  {
    note: 'notices: the file cannot be opened: nothing is reported',
    hosts: hosts({}, { osShell: { openPath: 'not found' } }),
    calls: [get('home:open-license-notices')],
  },
  {
    note: 'survey: open it (Korean): details copied, survey opened',
    hosts: hosts({}, { dialogs: { message: [{ response: 0 }] } }),
    files: saved({ language: 'ko' }),
    calls: [get('home:open-feedback-survey')],
  },
  {
    note: 'survey: cancel it (English): nothing copied or opened',
    hosts: hosts({ version: '2.0.0' }, { dialogs: { message: [{ response: 1 }] } }),
    files: saved({ language: 'en' }),
    calls: [get('home:open-feedback-survey')],
  },
  {
    note: 'survey: the browser fails after the details are copied',
    hosts: hosts(
      {},
      { dialogs: { message: [{ response: 0 }] }, osShell: { openExternalError: 'x' } },
    ),
    files: saved({ language: 'en' }),
    calls: [get('home:open-feedback-survey')],
  },

  // ---- the PDF result store ----
  {
    note: 'result store: no store yet is 0 bytes; deleting it is no error',
    hosts: hosts(),
    files: { userData: { dir: true } },
    calls: [get('home:result-store-size'), get('home:result-store-delete-all')],
  },
  {
    note: 'result store: size counts files in folders; delete-all removes only the store',
    hosts: hosts(),
    files: {
      'userData/pdf-store/a.bin': { hex: '00112233' },
      'userData/pdf-store/doc/b.json': '{"a":1}',
      'userData/pdf-store/doc/deeper/c.txt': 'hello',
      'userData/keep.txt': 'stays',
    },
    calls: [
      get('home:result-store-size'),
      get('home:result-store-delete-all'),
      get('home:result-store-size'),
    ],
  },
]

export const group: Group = {
  batch: 'W',
  load: loadHome,
  cases,
  single: {
    'home:open-help':
      'the tab manager opens the help tab; the answer is always undefined and the shell window is not up here',
  },
}
