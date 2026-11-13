/**
 * Group `a/subscription`: the AI subscription channels (`ai:subscription-*`,
 * `packages/ai-provider/src/subscription/ipc.ts`) registered as
 * `registerAiIpc` of `apps/docs/src/main/docs-main.ts` registers them, and
 * the shell entry's `home:open-subscription-install-help`.
 *
 * docs-main starts the whole app when it is imported, so it is not loaded.
 * Its statements that build what the registration is given (the settings
 * file, its reads and writes, the broadcast of `ai:settings-changed`) and the
 * `ensureSubscriptionIpc(ipcMain, {...})` call itself are taken from its
 * source with the TypeScript parser (each must be found exactly once) and run
 * over the names they use: the fake Electron and the real helpers the entry
 * imports. The shell entry's handler of the install help is taken the same
 * way.
 *
 * What the Rust port reaches through its batch hosts is stood in here, from
 * the same `hosts.a.subscription` (crates/shell-ipc/a/src/probe/subscription.rs
 * describes its keys and the host log lines, written the same here):
 * `getUiLang`, `aiSubscriptionLoginWindowText` and `aiChatGptSignInPages` of
 * the entry's own helpers, and `detect`, `listModels` and `locate` of the
 * registration's setup (its stand-ins for tests), so that no case depends on
 * the programs of the PC the gate runs on. The ChatGPT sign-in itself (a
 * loopback server and an authorize URL with random values) is not driven
 * here; the unit tests of the Rust port cover it.
 */
import type * as Ipc from '../../../../packages/ai-provider/src/subscription/ipc.ts'
import type { Call, Case, Group, LoadContext, View } from '../../types.ts'
import { setCodexImageGenerationAvailable } from '../../../../packages/ai-provider/src/image-backend.ts'
import {
  normalizeAiSettings,
  sealAiSecrets,
  withMigratedSubscriptionNoticeVersion,
  withStoredUnknownFields,
} from '../../../../packages/ai-provider/src/index.ts'
import {
  SUBSCRIPTION_CHATGPT_USAGE_URL,
  SUBSCRIPTION_INSTALL_URLS,
} from '../../../../packages/ai-provider/src/subscription/contract.ts'
import {
  isHeadlessMode,
  safeExternalUrl,
  writeJsonAtomic,
} from '../../../../packages/electron-utils/src/index.ts'
import {
  SHELL_SUBSCRIPTION_CHANNELS,
  isSubscriptionProviderId,
} from '../../../../apps/shell/src/shared/subscription-api.ts'
import { withMeteredAccepted, withSubscriptionOff } from '../../../../apps/docs/src/main/ai-run.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { entryStatements, runWith } from './lib/entry-source.ts'

const IPC = 'packages/ai-provider/src/subscription/ipc.ts'

/** docs-main's statements, in its order */
const docsCode = entryStatements('apps/docs/src/main/docs-main.ts', [
  'function userDataPath(',
  'function readJson<T>(',
  'const SETTINGS_PATH =',
  'function writeAiSettingsFile(',
  'function broadcastAiSettingsChanged(',
  'function storedAiSettings(',
  'function migratedNoticeVersion(',
  'ensureSubscriptionIpc(ipcMain, {',
])
const shellCode = entryStatements('apps/shell/src/main/index.ts', [
  'ipcMain.handle(SHELL_SUBSCRIPTION_CHANNELS.openInstallHelp,',
])

// ---- hosts.a.subscription -----------------------------------------------------------------

interface Detection {
  state?: string
  version?: string
  loginMethod?: string
  planName?: string
  error?: string
  programPath?: string
  loginKind?: string
  account?: string
  throws?: string
}
interface Program {
  command: string
  prefixArgs?: string[]
  entry?: string
  source?: string
  env?: Record<string, string>
}
interface World {
  windowText?: Record<string, { title?: string; guide?: string; closing?: string }>
  pages?: unknown
  detections?: Record<string, Detection>
  models?: Record<string, unknown[]>
  programs?: Record<string, Program>
}

const clean = (value: unknown): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined),
  )

async function load(cx: LoadContext): Promise<void> {
  const hostsA = (cx.case.hosts?.a ?? {}) as { subscription?: World; lang?: string }
  const world = hostsA.subscription ?? {}
  const lang = hostsA.lang ?? 'ko'
  const log = cx.electron.log
  const real = await cx.fresh<typeof Ipc>(IPC)
  setCodexImageGenerationAvailable(true)
  runWith(docsCode, {
    app: cx.electron.app,
    ipcMain: cx.electron.ipcMain,
    webContents: cx.electron.webContents,
    shell: cx.electron.shell,
    join,
    existsSync,
    readFileSync,
    isHeadlessMode,
    writeJsonAtomic,
    sealAiSecrets,
    withStoredUnknownFields,
    normalizeAiSettings,
    withMigratedSubscriptionNoticeVersion,
    withMeteredAccepted,
    withSubscriptionOff,
    safeExternalUrl,
    getUiLang: () => {
      log.push(['getUiLang'])
      return lang
    },
    aiSubscriptionLoginWindowText: (l: string, provider: string) => {
      log.push(['aiSubscriptionLoginWindowText', l, provider])
      return world.windowText?.[provider] ?? {}
    },
    aiChatGptSignInPages: (l: string) => {
      log.push(['aiChatGptSignInPages', l])
      const page = (what: string) => ({ lang: l, title: what, body: what })
      return world.pages ?? { done: page('done'), failed: page('failed') }
    },
    // the registration as the entry makes it, plus the stand-ins for tests
    ensureSubscriptionIpc: (ipcMain: unknown, setup: Record<string, unknown>) =>
      real.ensureSubscriptionIpc(
        ipcMain as never,
        {
          ...setup,
          detect: async (provider: string, options?: { configuredPath?: string }) => {
            log.push(['detect', provider, options?.configuredPath ?? null])
            const given = world.detections?.[provider] ?? {}
            if (given.throws !== undefined) throw new Error(given.throws)
            return clean({ ...given, provider, state: given.state ?? 'not-installed' })
          },
          listModels: async (provider: string, options?: { configuredPath?: string }) => {
            log.push(['listModels', provider, options?.configuredPath ?? null])
            return world.models?.[provider] ?? []
          },
          locate: async (provider: string, options?: { configuredPath?: string }) => {
            log.push(['locate', provider, options?.configuredPath ?? null])
            const given = world.programs?.[provider]
            if (given === undefined) return null
            return {
              provider,
              command: given.command,
              prefixArgs: given.prefixArgs ?? [],
              env: given.env ?? {},
              entry: given.entry ?? given.command,
              source: given.source ?? 'path',
            }
          },
        } as never,
      ),
  })
  runWith(shellCode, {
    ipcMain: cx.electron.ipcMain,
    shell: cx.electron.shell,
    SHELL_SUBSCRIPTION_CHANNELS,
    isSubscriptionProviderId,
    safeExternalUrl,
    SUBSCRIPTION_CHATGPT_USAGE_URL,
    SUBSCRIPTION_INSTALL_URLS,
  })
}

// ---- cases ------------------------------------------------------------------------------------

const views: View[] = [
  { view: 1, window: 1, surface: 'Shell' },
  { view: 2, window: 2, surface: 'Docs' },
]
const docs = (channel: string, ...args: unknown[]): Call => ({ channel, view: 2, args })
const shell = (channel: string, ...args: unknown[]): Call => ({ channel, view: 1, args })
const sub = (world: World, rest: Record<string, unknown> = {}) => ({
  a: { subscription: world, ...rest },
})
const settings = (value: unknown) => ({ 'userData/ai-settings.json': JSON.stringify(value) })
const folder = { userData: { dir: true as const } }
const provider = (id: unknown) => ({ provider: id })

const meteredClaude: World = {
  detections: {
    'claude-code': {
      state: 'metered',
      version: '2.1.0',
      loginMethod: 'metered',
      loginKind: 'api-key',
    },
  },
}

const cases: Case[] = [
  {
    note: 'the first window to ask starts the first check; every view hears the result',
    views,
    files: folder,
    hosts: sub({
      detections: {
        'claude-code': { state: 'ready', version: '2.1.0', loginMethod: 'subscription' },
        codex: { state: 'signed-out', version: '0.9.1' },
      },
      models: { 'claude-code': [{ id: 'sonnet', label: 'Sonnet' }] },
    }),
    calls: [docs('ai:subscription-statuses'), docs('ai:subscription-statuses')],
  },
  {
    note: 'a configured path reaches the detector and the finder',
    views,
    files: settings({ providers: { codex: { cliPath: '/opt/codex/bin/codex' } } }),
    hosts: sub({ detections: { codex: { state: 'ready', version: '0.9.1' } } }),
    calls: [docs('ai:subscription-recheck', { providers: ['codex'] })],
  },
  {
    note: 'recheck: every provider without a list; unknown ids and other payloads are left out',
    views,
    files: folder,
    hosts: sub({
      detections: {
        'claude-code': { state: 'needs-update', version: '1.0.0', programPath: '/usr/bin/claude' },
        codex: { state: 'error', error: 'it crashed' },
      },
    }),
    calls: [
      docs('ai:subscription-recheck'),
      docs('ai:subscription-recheck', { providers: ['codex', 'bogus', 7] }),
      docs('ai:subscription-recheck', { providers: 'codex' }),
      docs('ai:subscription-recheck', null),
    ],
  },
  {
    note: 'a detector that rejects reads as an error status',
    views,
    files: folder,
    hosts: sub({ detections: { codex: { throws: 'spawn failed' } } }),
    calls: [docs('ai:subscription-recheck', { providers: ['codex'] })],
  },
  {
    note: 'use anyway on a metered login is recorded in the settings file, and taken back',
    views,
    files: settings({ provider: 'claude-code' }),
    hosts: sub(meteredClaude),
    calls: [
      docs('ai:subscription-recheck'),
      docs('ai:subscription-metered', { provider: 'claude-code', accepted: true }),
      docs('ai:subscription-statuses'),
      docs('ai:subscription-metered', { provider: 'claude-code', accepted: false }),
    ],
  },
  {
    note: 'use anyway is refused without a provider, a real boolean or a metered login',
    views,
    files: folder,
    hosts: sub({ detections: { codex: { state: 'ready', version: '0.9.1' } } }),
    calls: [
      docs('ai:subscription-recheck'),
      docs('ai:subscription-metered', { provider: 'bogus', accepted: true }),
      docs('ai:subscription-metered', { provider: 'claude-code', accepted: 'yes' }),
      docs('ai:subscription-metered', { provider: 'codex' }),
      docs('ai:subscription-metered', { provider: 'codex', accepted: true }),
      docs('ai:subscription-metered'),
    ],
  },
  {
    note: 'a CLI turned off is not started: login, logout, install, update, use anyway; then back on',
    views,
    files: settings({ provider: 'codex' }),
    hosts: sub({ detections: { codex: { state: 'ready', version: '0.9.1' } } }),
    calls: [
      docs('ai:subscription-recheck'),
      docs('ai:subscription-off', { provider: 'codex', off: true }),
      docs('ai:subscription-login', provider('codex')),
      docs('ai:subscription-logout', provider('codex')),
      docs('ai:subscription-install', provider('codex')),
      docs('ai:subscription-update', provider('codex')),
      docs('ai:subscription-metered', { provider: 'codex', accepted: true }),
      docs('ai:subscription-statuses'),
      docs('ai:subscription-off', { provider: 'codex', off: false }),
    ],
  },
  {
    note: 'off is for a vendor CLI and a real boolean',
    views,
    files: folder,
    hosts: sub({}),
    calls: [
      docs('ai:subscription-off', { provider: 'chatgpt', off: true }),
      docs('ai:subscription-off', { provider: 'codex', off: 'true' }),
      docs('ai:subscription-off', { provider: 'bogus', off: true }),
      docs('ai:subscription-off'),
    ],
  },
  {
    note: 'login: an unknown provider is invalid; a program that cannot be found says so',
    views,
    files: folder,
    hosts: sub({}),
    calls: [
      docs('ai:subscription-login', provider('bogus')),
      docs('ai:subscription-login'),
      docs('ai:subscription-login', provider('codex')),
      docs('ai:subscription-login', { provider: 'claude-code', mode: 'window' }),
      docs('ai:subscription-statuses'),
    ],
  },
  {
    note: 'cancel login: nothing to end is not a failure; an unknown provider is invalid',
    views,
    files: folder,
    hosts: sub({}),
    calls: [
      docs('ai:subscription-cancel-login', provider('codex')),
      docs('ai:subscription-cancel-login', provider('chatgpt')),
      docs('ai:subscription-cancel-login', provider('bogus')),
    ],
  },
  {
    note: 'logout: ChatGPT forgets its connection and is looked at again; others are invalid when unknown',
    views,
    files: folder,
    hosts: sub({ detections: { chatgpt: { state: 'signed-out' } } }),
    calls: [
      docs('ai:subscription-logout', provider('chatgpt')),
      docs('ai:subscription-logout', provider('bogus')),
      docs('ai:subscription-logout', provider('codex')),
    ],
  },
  {
    note: 'install and update: a vendor CLI has a program, ChatGPT does not, an unknown id is invalid',
    views,
    files: folder,
    hosts: sub({}),
    calls: [
      docs('ai:subscription-install', provider('codex')),
      docs('ai:subscription-install', provider('claude-code')),
      docs('ai:subscription-install', provider('chatgpt')),
      docs('ai:subscription-install', provider('bogus')),
      docs('ai:subscription-update', provider('codex')),
      docs('ai:subscription-update', provider('chatgpt')),
      docs('ai:subscription-update', provider('bogus')),
    ],
  },
  {
    note: 'the Codex image backend is loaded in this process',
    views,
    files: folder,
    hosts: sub({}),
    calls: [docs('ai:subscription-codex-image')],
  },
  {
    note: 'the install help opens the vendor page in the system browser; an unknown provider opens nothing',
    views,
    files: folder,
    hosts: sub({}),
    calls: [
      shell('home:open-subscription-install-help', 'codex'),
      shell('home:open-subscription-install-help', 'claude-code'),
      shell('home:open-subscription-install-help', 'chatgpt'),
      shell('home:open-subscription-install-help', 'bogus'),
      shell('home:open-subscription-install-help'),
    ],
  },
]

export const group: Group = {
  batch: 'A',
  load,
  cases,
  single: {
    'ai:subscription-codex-image':
      'takes no argument and answers whether this process loaded the Codex image backend, which the entry always does',
  },
}
