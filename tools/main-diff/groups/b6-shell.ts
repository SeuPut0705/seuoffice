/**
 * Group `b6-shell`: the modules of apps/shell/src/main that call Electron
 * (batch B6 of decision 0030). Electron is the fake of electron-fake.ts; each
 * case installs the objects it describes, and each call of a fake is one log
 * line, as the Rust fakes of calls/b6_shell.rs write it. A scenario is a
 * list of steps over one set of fakes; where a module keeps state at module
 * level, a case that needs a clean slate loads its own copy of the module
 * (`?case=` in the import) or gives its webContents ids of its own.
 *
 * - error-dialog: steps `call` (a parent, a message, an error value) and
 *   `settle` (the oldest box is answered).
 * - permission-guard: the check handler of the default session answers each
 *   probe; `micOpen` lists the webContents the slides editor records in.
 * - cli-link: `installCliLinkBestEffort` runs with `process.platform`,
 *   `process.env`, `process.resourcesPath` and the console replaced; the
 *   launcher record goes to `SEUOFFICE_AUTH_DIR` of the case, and the
 *   platforms are the ones `installCliLink` answers without touching the
 *   machine (it would link into /usr/local/bin otherwise).
 * - pointer-size: `installPointerSize` reads the pointer through a fake `reg`
 *   program on PATH whose output the steps change.
 * - renderer-disposal: steps `release`, `flush` (the queued `setImmediate`s),
 *   `emit` (`render-process-gone` of a webContents), `was` and `can`.
 * - ui-scale, crash-watch, renderer-watchdog, recovery-shell, updater:
 *   scenarios described at their runners below.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module'
import os, { tmpdir } from 'node:os'
import { join } from 'node:path'
import v8 from 'node:v8'
import fsPromises from 'node:fs/promises'
import { setUiLang } from '@seuoffice/i18n'
import { useElectron } from '../electron-fake.ts'
import { fakeParent } from '../fakes.ts'
import type { Case, FnSpec, Group, TsContext } from '../types.ts'

// loaded after electron-fake.ts has registered its hooks: a static import
// would resolve 'electron' before them
const errorDialog = await import('../../../apps/shell/src/main/error-dialog.ts')
const shellGuard = await import('../../../apps/shell/src/main/permission-guard.ts')
const cliLink = await import('../../../apps/shell/src/main/cli-link.ts')
const pointer = await import('../../../apps/shell/src/main/pointer-size.ts')
const disposal = await import('../../../apps/shell/src/main/renderer-disposal.ts')
const uiScale = await import('../../../apps/shell/src/main/ui-scale.ts')
const crashWatch = await import('../../../apps/shell/src/main/crash-watch.ts')
const watchdog = await import('../../../apps/shell/src/main/renderer-watchdog.ts')
const updateRestart = await import('../../../apps/shell/src/main/update-restart.ts')
const sessionRecord = await import('../../../apps/shell/src/main/session-record.ts')

// any: the fakes take the typed parameters of the function they stand in for
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (...args: any[]) => unknown

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const realImmediate = globalThis.setImmediate
const realTimeout = globalThis.setTimeout
/** lets every promise chain that can finish without the outside world finish */
const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => realImmediate(resolve))
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => realTimeout(resolve, ms))
/** until the case's own child processes (the unpacking of a download) have answered */
const settle = async (): Promise<void> => {
  const until = Date.now() + 10_000
  await tick()
  while (process.getActiveResourcesInfo().includes('ProcessWrap') && Date.now() < until) await sleep(10)
  await tick()
}

/** `Date` and `performance.now` of the case: the clock every call reads */
function withClock<T>(clock: { ms: number }, run: () => T): T {
  const RealDate = Date
  class FakeDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock.ms)
      else super(...(args as [number]))
    }
    static now(): number {
      return clock.ms
    }
  }
  const realPerf = performance.now
  let perf = 0
  globalThis.Date = FakeDate as unknown as DateConstructor
  performance.now = () => (perf += 10)
  const restore = (): void => {
    globalThis.Date = RealDate
    performance.now = realPerf
  }
  let result: T
  try {
    result = run()
  } catch (error) {
    restore()
    throw error
  }
  if (result instanceof Promise) {
    return result.finally(restore) as T
  }
  restore()
  return result
}

/** `process.platform`, `process.env` ... replaced for the call */
function withProcess<T>(
  patch: { platform?: string; env?: Record<string, string>; extra?: Record<string, unknown> },
  run: () => T,
): T {
  const proc = process as unknown as Record<string, unknown>
  const saved: [string, PropertyDescriptor | undefined][] = []
  const set = (key: string, value: unknown): void => {
    saved.push([key, Object.getOwnPropertyDescriptor(process, key)])
    Object.defineProperty(process, key, { value, configurable: true, writable: true })
  }
  if (patch.platform !== undefined) set('platform', patch.platform)
  if (patch.env !== undefined) set('env', { ...patch.env })
  for (const [key, value] of Object.entries(patch.extra ?? {})) set(key, value)
  const restore = (): void => {
    for (const [key, descriptor] of saved.reverse()) {
      if (descriptor) Object.defineProperty(process, key, descriptor)
      else delete proc[key]
    }
  }
  let result: T
  try {
    result = run()
  } catch (error) {
    restore()
    throw error
  }
  if (result instanceof Promise) return result.finally(restore) as T
  restore()
  return result
}

/** the console of the case: each call is a log line, `console` first */
function withConsole<T>(cx: TsContext, run: () => T): T {
  const saved = { log: console.log, warn: console.warn }
  console.log = (...args: unknown[]) => cx.log('console.log', ...args)
  console.warn = (...args: unknown[]) => cx.log('console.warn', ...args)
  const restore = (): void => {
    console.log = saved.log
    console.warn = saved.warn
  }
  let result: T
  try {
    result = run()
  } catch (error) {
    restore()
    throw error
  }
  if (result instanceof Promise) return result.finally(restore) as T
  restore()
  return result
}

// ---------------------------------------------------------------------------
// error-dialog
// ---------------------------------------------------------------------------

interface ErrorStep {
  call?: { parent: unknown; message: string; err: unknown }
  settle?: boolean
}

function thrownOf(spec: unknown): unknown {
  const o = (spec ?? {}) as { error?: string; value?: unknown; undefined?: boolean }
  if (o.undefined) return undefined
  if (o.error !== undefined) return new Error(o.error)
  return o.value
}

async function runErrorDialog(steps: ErrorStep[], cx: TsContext): Promise<void> {
  const pending: (() => void)[] = []
  useElectron({
    dialog: {
      showMessageBox: (...given: unknown[]) => {
        if (given.length === 2) cx.log('over', given[1])
        else cx.log('box', given[0])
        return new Promise((resolve) => pending.push(() => resolve({ response: 0 })))
      },
    },
  })
  for (const step of steps) {
    if (step.call) {
      errorDialog.showErrorDialog(
        fakeParent(step.call.parent) as never,
        step.call.message,
        thrownOf(step.call.err),
      )
    }
    if (step.settle) {
      pending.shift()?.()
      await tick()
    }
  }
  while (pending.length > 0) {
    pending.shift()?.()
    await tick()
  }
}

const call = (message: string, err: unknown, parent: unknown = null): ErrorStep => ({
  call: { parent, message, err },
})
const SETTLE: ErrorStep = { settle: true }

const errorDialogCases: Case[] = [
  {
    args: [[call('Could not open', { error: 'disk full' }, 'live')]],
    note: 'an Error: its message is the detail, parented',
  },
  {
    args: [[call('Could not open', { error: 'disk full' }, 'destroyed')]],
    note: 'a destroyed parent: the box has none',
  },
  { args: [[call('No window', { value: 'plain text' })]], note: 'no parent, a string' },
  { args: [[call('Number', { value: 42 }, 'live')]], note: 'a number is printed as one' },
  { args: [[call('Null', { value: null })]], note: 'null' },
  { args: [[call('Undefined', { undefined: true })]], note: 'undefined' },
  { args: [[call('List', { value: [1, [2, null, 3]] })]], note: 'an array joins' },
  { args: [[call('Object', { value: { a: 1 } })]], note: 'an object' },
  { args: [[call('통합', { error: '한글 오류 \u{1f4a5}' })]], note: 'unicode text' },
  { args: [[call('', { error: '' })]], note: 'empty texts' },
  {
    args: [[call('first', { error: 'one' }), call('second', { error: 'two' }), SETTLE]],
    note: 'a box is up: the second call is dropped',
  },
  {
    args: [
      [call('first', { error: 'one' }), SETTLE, call('second', { error: 'two' }, 'live'), SETTLE],
    ],
    note: 'answered: the next call shows its box',
  },
  {
    args: [[call('first', { error: 'one' }), call('second', { error: 'two' }), call('third', { value: 3 })]],
    note: 'never answered while calls come: only the first shows',
  },
]

// ---------------------------------------------------------------------------
// permission-guard
// ---------------------------------------------------------------------------

interface GuardScenario {
  env: Record<string, string>
  rendererDir: string
  micOpen: number[]
  probes: { permission: string; id?: number; url?: string; mediaType?: string }[]
}

async function runShellGuard(o: GuardScenario, cx: TsContext): Promise<unknown> {
  const listeners: Fn[] = []
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => (resolveReady = resolve))
  const guarded: { check?: Fn } = {}
  const app = {
    on: (event: string, listener: Fn) => {
      cx.log('app.on', event)
      listeners.push(listener)
    },
    whenReady: () => {
      cx.log('app.whenReady')
      return ready
    },
  }
  const session = {
    defaultSession: {
      setPermissionRequestHandler: () => cx.log('session.setPermissionRequestHandler', 'default'),
      setPermissionCheckHandler: (handler: Fn) => {
        cx.log('session.setPermissionCheckHandler', 'default')
        guarded.check = handler
      },
    },
  }
  useElectron({ app, session })
  shellGuard.installShellPermissionGuard({
    microphoneOpen: (id: number) => {
      cx.log('microphoneOpen', id)
      return o.micOpen.includes(id)
    },
    rendererDir: o.rendererDir,
    env: o.env,
  })
  resolveReady()
  await tick()
  return o.probes.map((p) =>
    guarded.check?.({ id: p.id ?? 1 }, p.permission, 'o', {
      isMainFrame: true,
      requestingUrl: p.url,
      mediaType: p.mediaType,
    }),
  )
}

const ALL_DEV_ENV = {
  ELECTRON_RENDERER_URL: 'http://localhost:5170',
  DOCS_RENDERER_URL: 'http://localhost:5171',
  SHEETS_RENDERER_URL: 'http://localhost:5172',
  SLIDES_RENDERER_URL: 'http://localhost:5173',
  PDF_RENDERER_URL: 'http://localhost:5174',
  MARKDOWN_RENDERER_URL: 'http://localhost:5175',
  HTML_RENDERER_URL: 'http://localhost:5176',
  MINDMAP_RENDERER_URL: 'http://localhost:5177',
  HWP_RENDERER_URL: 'http://localhost:5178',
  EPUB_RENDERER_URL: 'http://localhost:5179',
}
const fullscreen = (url: string, id = 1) => ({ permission: 'fullscreen', url, id })

const guardCases: Case[] = [
  {
    args: [
      {
        env: {},
        rendererDir: '$DIR/renderer',
        micOpen: [],
        probes: [
          fullscreen('file://$DIR/renderer/index.html'),
          fullscreen('file://$DIR/other/index.html'),
          fullscreen('http://localhost:5170/'),
          fullscreen('genoffice-app://docs/index.html'),
          fullscreen('genoffice-app://elsewhere/index.html'),
          { permission: 'fullscreen' },
        ],
      },
    ],
    note: 'no dev server: the renderer folder and the scheme only',
  },
  {
    args: [
      {
        env: ALL_DEV_ENV,
        rendererDir: '$DIR/renderer',
        micOpen: [],
        probes: Object.values(ALL_DEV_ENV)
          .map((url) => fullscreen(`${url}/index.html`))
          .concat([fullscreen('http://localhost:6000/'), fullscreen('https://example.com/')]),
      },
    ],
    note: 'every editor has a dev server',
  },
  {
    args: [
      {
        env: { DOCS_RENDERER_URL: '', ELECTRON_RENDERER_URL: 'http://127.0.0.1:5000' },
        rendererDir: '$DIR/r',
        micOpen: [],
        probes: [fullscreen('http://127.0.0.1:5000/x'), fullscreen('http://localhost/')],
      },
    ],
    note: 'an empty variable names nothing',
  },
  {
    args: [
      {
        env: { SLIDES_RENDERER_URL: 'http://localhost:5173' },
        rendererDir: '$DIR/renderer/',
        micOpen: [3],
        probes: [
          { permission: 'media', id: 3, url: 'http://localhost:5173/', mediaType: 'audio' },
          { permission: 'media', id: 4, url: 'http://localhost:5173/', mediaType: 'audio' },
          { permission: 'media', id: 3, url: 'http://localhost:5173/', mediaType: 'video' },
          { permission: 'media', id: 3, url: 'file://$DIR/renderer/sub/index.html', mediaType: 'audio' },
          { permission: 'clipboard-read', url: 'file://$DIR/renderer/index.html' },
          { permission: 'geolocation', url: 'file://$DIR/renderer/index.html' },
        ],
      },
    ],
    note: 'the narration microphone, a trailing slash on the folder',
  },
  {
    args: [
      {
        env: { ELECTRON_RENDERER_URL: 'not a url' },
        rendererDir: '$DIR/렌더러',
        micOpen: [],
        probes: [fullscreen('file://$DIR/렌더러/index.html'), fullscreen('not a url')],
      },
    ],
    note: 'an unparsable dev address, a unicode folder',
  },
]

// ---------------------------------------------------------------------------
// cli-link
// ---------------------------------------------------------------------------

interface CliScenario {
  settingsPath: string
  packaged: boolean
  resourcesPath: string
  platform: string
  version: string
  env: Record<string, string>
}

async function runCliLink(o: CliScenario, cx: TsContext): Promise<void> {
  useElectron({ app: { isPackaged: o.packaged, getVersion: () => o.version } })
  withConsole(cx, () =>
    withProcess(
      { platform: o.platform, env: o.env, extra: { resourcesPath: o.resourcesPath } },
      () => cliLink.installCliLinkBestEffort(o.settingsPath),
    ),
  )
}

const cliScenario = (extra: Partial<CliScenario> = {}): CliScenario => ({
  settingsPath: '$DIR/settings.json',
  packaged: true,
  resourcesPath: '/Applications/SeuOffice.app/Contents/Resources',
  platform: 'freebsd',
  version: '1.2.3',
  env: { SEUOFFICE_AUTH_DIR: '$DIR/auth' },
  ...extra,
})

const cliLinkScenarios: Case[] = [
  { args: [cliScenario({ packaged: false })], note: 'a dev run does nothing' },
  {
    args: [cliScenario({ env: { SEUOFFICE_AUTH_DIR: '$DIR/auth', APPIMAGE: '/tmp/x.AppImage' } })],
    note: 'an AppImage run is temporary',
  },
  {
    args: [cliScenario({ resourcesPath: '/Volumes/SeuOffice/SeuOffice.app/Contents/Resources' })],
    note: 'a disk image is temporary',
  },
  {
    args: [cliScenario({ resourcesPath: '/tmp/.mount_seuoXYZ/usr/resources' })],
    note: 'a FUSE mount is temporary',
  },
  {
    args: [cliScenario()],
    note: 'packaged, an unsupported platform: the launcher is recorded, no location',
  },
  {
    args: [cliScenario({ version: '2.0.0' })],
    files: {
      'settings.json': JSON.stringify({ cliLink: { version: '1.0.0', status: 'linked' }, other: 1 }),
    },
    note: 'a record of an older version is replaced, other settings stay',
  },
  {
    args: [cliScenario({ platform: 'win32' })],
    files: { 'settings.json': JSON.stringify({ cliLink: { version: '1.2.3', status: 'present' } }) },
    note: 'Windows: the same version was checked: stop after the launcher file',
  },
  {
    args: [cliScenario({ platform: 'win32', resourcesPath: 'C:\\app\\resources' })],
    files: {
      'settings.json': JSON.stringify({ cliLink: { version: '1.2.3' } }),
      'auth/launcher': 'stale\n',
    },
    note: 'Windows, same version, a launcher file that changed',
  },
  {
    args: [cliScenario()],
    files: { 'auth/launcher': { dir: true } },
    note: 'the launcher path is a folder: the write fails and is reported',
  },
  {
    args: [cliScenario()],
    files: { 'auth/launcher': '/Applications/SeuOffice.app/Contents/Resources/cli\n' },
    note: 'the launcher file is already right',
  },
  {
    args: [cliScenario()],
    files: { 'settings.json': '[1, 2' },
    note: 'a corrupt settings file reads as empty',
  },
]

/** `launcherFilePath(env, homeDir)`: the case's folder is the home */
const launcherPathCases: Case[] = [
  ...[
    { env: { SEUOFFICE_AUTH_DIR: '/custom/auth' }, note: 'the variable wins' },
    { env: { SEUOFFICE_AUTH_DIR: '' }, note: 'an empty variable is unset' },
    { env: {}, note: 'no variable: the app home folder' },
  ].map(({ env, note }): Case => ({ args: [env, '$DIR/home'], note })),
  {
    args: [{}, '$DIR/home'],
    files: { 'home/.ieumoffice/data.txt': 'old' },
    note: 'only an old home folder with data: it is used as it is',
  },
  {
    args: [{}, '$DIR/home'],
    files: { 'home/.ieumoffice/data.txt': 'old', 'home/.seuoffice/data.txt': 'new' },
    note: 'both hold data: the current name wins',
  },
  {
    args: [{}, '$DIR/home'],
    files: { 'home/.ieumoffice/data.txt': 'old', 'home/.seuoffice/.DS_Store': '' },
    note: 'the current folder holds nothing but a .DS_Store: the old one is kept',
  },
]

const ephemeralCases = cases(
  ['/Applications/SeuOffice.app/Contents/Resources', {}],
  ['/Applications/SeuOffice.app/Contents/Resources', { APPIMAGE: '/tmp/a.AppImage' }],
  ['/Applications/SeuOffice.app/Contents/Resources', { APPIMAGE: '' }],
  ['/Volumes/SeuOffice/SeuOffice.app/Contents/Resources', {}],
  ['/Volumes', {}],
  ['/tmp/.mount_abc123/usr/share', {}],
  ['/tmp/.mount_/usr/share', {}],
  ['/home/u/.mount_x', {}],
  ['C:\\Volumes\\x', {}],
  ['/Volumes/한글/앱', {}],
)

const writeLauncherCases: Case[] = [
  { args: ['$DIR/launcher', '/opt/app/cli'], note: 'a new file' },
  {
    args: ['$DIR/launcher', '/opt/app/cli'],
    files: { launcher: '/opt/app/cli\n' },
    note: 'already right: not written',
  },
  {
    args: ['$DIR/launcher', '/opt/app/cli'],
    files: { launcher: '/old/cli\n' },
    note: 'a changed folder: rewritten',
  },
  { args: ['$DIR/a/b/c/launcher', '/opt/cli'], note: 'the folders are made' },
  { args: ['$DIR/launcher', '/opt/한글/cli'], note: 'unicode' },
  { args: ['$DIR/launcher', ''], note: 'an empty folder name writes a newline' },
  { args: ['$DIR/d', '/opt/cli'], files: { d: { dir: true } }, note: 'a folder in the way' },
  {
    args: ['$DIR/f/launcher', '/opt/cli'],
    files: { f: 'a file where a folder should be' },
    note: 'a file in the way of the folder',
  },
]

// ---------------------------------------------------------------------------
// pointer-size
// ---------------------------------------------------------------------------

const parseCases = cases(
  ['    CursorBaseSize    REG_DWORD    0x40'],
  ['    CursorBaseSize    REG_DWORD    0x20'],
  ['    CursorBaseSize    REG_DWORD    0x200'],
  ['    CursorBaseSize    REG_DWORD    0x10'],
  ['    CursorBaseSize    REG_DWORD    0x201'],
  ['    CursorBaseSize    REG_DWORD    0xF'],
  ['    CursorBaseSize    REG_SZ    48'],
  ['    CursorBaseSize    REG_SZ    48.5'],
  ['    CursorBaseSize    REG_SZ    abc'],
  ['    CursorBaseSize    REG_SZ    1e2'],
  ['    CursorBaseSize    REG_SZ    0b1000000'],
  ['    CursorBaseSize    REG_DWORD    0x'],
  ['HKEY_CURRENT_USER\\Control Panel\\Cursors\r\n    CursorBaseSize    REG_DWORD    0x30\r\n'],
  ['no value here'],
  [''],
)

interface ReadSpec {
  platform: string
  run: null | { output: string } | { throws: true }
}

async function runRead(o: ReadSpec, cx: TsContext): Promise<number | null> {
  const run =
    o.run === null
      ? undefined
      : async (cmd: string, args: string[]): Promise<string> => {
          cx.log('run', cmd, args)
          if ('throws' in o.run!) throw new Error('no such value')
          return (o.run as { output: string }).output
        }
  return pointer.readPointerSize(run, o.platform as NodeJS.Platform)
}

const out = (output: string): ReadSpec['run'] => ({ output })
const readCases: Case[] = [
  { args: [{ platform: 'win32', run: out('    CursorBaseSize    REG_DWORD    0x40') }] },
  { args: [{ platform: 'win32', run: { throws: true } }], note: 'no such value' },
  { args: [{ platform: 'darwin', run: out('    CursorBaseSize    REG_DWORD    0x40') }], note: 'only Windows reads it' },
  { args: [{ platform: 'linux', run: null }], note: 'the stock runner is never reached' },
  { args: [{ platform: 'win32', run: out('garbage') }], note: 'unreadable output' },
  { args: [{ platform: 'win32', run: out('    CursorBaseSize    REG_DWORD    0x1000') }], note: 'implausible' },
  { args: [{ platform: 'win32', run: null }], note: 'the stock runner: no reg on this machine' },
]

const applyPointerCases: Case[] = [
  { args: [{ px: 32, destroyed: false, rejects: false }] },
  { args: [{ px: 64, destroyed: false, rejects: true }], note: 'a renderer torn down mid-call' },
  { args: [{ px: 48, destroyed: true, rejects: false }], note: 'destroyed: nothing runs' },
]

interface FakeStyled {
  destroyed?: boolean
  rejects?: boolean
}

function styledContents(name: string, spec: FakeStyled, cx: TsContext) {
  const listeners: Record<string, Fn> = {}
  return {
    listeners,
    isDestroyed: () => spec.destroyed ?? false,
    executeJavaScript: (script: string) => {
      cx.log(name, 'execute', script)
      return spec.rejects ? Promise.reject(new Error('gone')) : Promise.resolve(undefined)
    },
    on: (event: string, listener: Fn) => {
      cx.log(name, 'on', event)
      listeners[event] = listener
    },
  }
}

type PointerStep = { focus: true; out: string | null } | { created: string } | { load: string }

interface PointerScenario {
  platform: string
  initialOut: string | null
  contents: Record<string, FakeStyled>
  steps: PointerStep[]
}

async function runPointer(o: PointerScenario, cx: TsContext): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'pointer-reg-'))
  const outFile = join(tmp, 'out')
  const countFile = join(tmp, 'count')
  mkdirSync(join(tmp, 'bin'))
  writeFileSync(
    join(tmp, 'bin', 'reg'),
    '#!/bin/sh\ncat "$POINTER_REG_OUT"\ncode=$?\necho x >> "$POINTER_REG_COUNT"\nexit $code\n',
  )
  chmodSync(join(tmp, 'bin', 'reg'), 0o755)
  const setOut = (text: string | null): void => {
    if (text === null) rmSync(outFile, { force: true })
    else writeFileSync(outFile, text)
  }
  const runs = (): number => (existsSync(countFile) ? readFileSync(countFile, 'utf8').length / 2 : 0)
  const waitForRun = async (before: number): Promise<void> => {
    if (o.platform !== 'win32') return
    const until = Date.now() + 5000
    while (runs() <= before && Date.now() < until) await sleep(5)
    await sleep(250)
    await tick()
  }
  const contents = Object.fromEntries(
    Object.entries(o.contents).map(([name, spec]) => [name, styledContents(name, spec, cx)]),
  )
  const appListeners: Record<string, Fn> = {}
  const app = {
    on: (event: string, listener: Fn) => {
      cx.log('app.on', event)
      appListeners[event] = listener
    },
  }
  useElectron({
    webContents: {
      getAllWebContents: () => {
        cx.log('getAllWebContents')
        return Object.values(contents)
      },
    },
  })
  const env = {
    ...process.env,
    PATH: `${join(tmp, 'bin')}:${process.env.PATH ?? ''}`,
    POINTER_REG_OUT: outFile,
    POINTER_REG_COUNT: countFile,
  } as Record<string, string>
  try {
    await withProcess({ platform: o.platform, env }, async () => {
      let spawned = 1
      setOut(o.initialOut)
      pointer.installPointerSize(app as never)
      await waitForRun(0)
      for (const step of o.steps) {
        if ('focus' in step) {
          setOut(step.out)
          const before = runs()
          spawned += 1
          appListeners['browser-window-focus']?.()
          await waitForRun(before)
        } else if ('created' in step) {
          appListeners['web-contents-created']?.({}, contents[step.created])
        } else {
          contents[step.load]?.listeners['did-finish-load']?.()
        }
        await tick()
      }
      // every `reg` the case started has answered before the fakes go away
      await waitForRun(spawned - 1)
      await tick(5)
    })
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const REG40 = '    CursorBaseSize    REG_DWORD    0x40'
const REG30 = '    CursorBaseSize    REG_DWORD    0x30'
const pointerScenarios: Case[] = [
  {
    args: [
      {
        platform: 'win32',
        initialOut: REG40,
        contents: { a: {}, b: { destroyed: true }, c: { rejects: true } },
        steps: [{ created: 'a' }, { load: 'a' }, { focus: true, out: REG40 }, { focus: true, out: REG30 }],
      },
    ],
    note: 'the size is written to every live view, only when it changed',
  },
  {
    args: [
      {
        platform: 'win32',
        initialOut: null,
        contents: { a: {} },
        steps: [{ created: 'a' }, { load: 'a' }, { focus: true, out: REG30 }, { load: 'a' }],
      },
    ],
    note: 'no size at first; a window loaded later gets the size the focus found',
  },
  {
    args: [
      {
        platform: 'win32',
        initialOut: REG40,
        contents: { a: {} },
        steps: [{ focus: true, out: null }, { focus: true, out: null }, { created: 'a' }, { load: 'a' }],
      },
    ],
    note: 'the size is gone: nothing is written, and the memory says so',
  },
  {
    args: [
      {
        platform: 'darwin',
        initialOut: REG40,
        contents: { a: {} },
        steps: [{ focus: true, out: REG30 }, { created: 'a' }, { load: 'a' }],
      },
    ],
    note: 'macOS has no setting read here',
  },
]

// ---------------------------------------------------------------------------
// renderer-disposal
// ---------------------------------------------------------------------------

interface DisposalContents {
  id: number
  pid?: number
  destroyed?: boolean
  /** methods that throw: `isDestroyed`, `getOSProcessId`, `forcefullyCrashRenderer`, `once`, `close` */
  throws?: string[]
}

interface DisposalStep {
  release?: string
  flush?: true
  emit?: string
  was?: string
  can?: { target: string; peers: string[] }
}

interface DisposalScenario {
  contents: Record<string, DisposalContents>
  peersThrow?: boolean
  steps: DisposalStep[]
}

/** each case gets webContents ids of its own: the module keeps the closed ones for good */
let disposalBase = 0

async function runDisposal(o: DisposalScenario, cx: TsContext): Promise<unknown[]> {
  const base = (disposalBase += 1000)
  const immediates: Fn[] = []
  const onceListeners: Record<string, Fn> = {}
  const fake = (name: string, spec: DisposalContents) => {
    const throwIf = (method: string): void => {
      if (spec.throws?.includes(method)) throw new Error(`${name}.${method} failed`)
    }
    return {
      id: base + spec.id,
      isDestroyed: () => {
        cx.log(name, 'isDestroyed')
        throwIf('isDestroyed')
        return spec.destroyed ?? false
      },
      getOSProcessId: () => {
        cx.log(name, 'getOSProcessId')
        throwIf('getOSProcessId')
        return spec.pid ?? 0
      },
      forcefullyCrashRenderer: () => {
        cx.log(name, 'forcefullyCrashRenderer')
        throwIf('forcefullyCrashRenderer')
      },
      once: (event: string, listener: Fn) => {
        cx.log(name, 'once', event)
        throwIf('once')
        onceListeners[name] = listener
      },
      close: () => {
        cx.log(name, 'close')
        throwIf('close')
      },
    }
  }
  const contents = Object.fromEntries(
    Object.entries(o.contents).map(([name, spec]) => [name, fake(name, spec)]),
  )
  useElectron({
    webContents: {
      getAllWebContents: () => {
        cx.log('getAllWebContents')
        if (o.peersThrow) throw new Error('getAllWebContents failed')
        return Object.values(contents)
      },
    },
  })
  const realSet = globalThis.setImmediate
  globalThis.setImmediate = ((fn: Fn) => {
    cx.log('setImmediate')
    immediates.push(fn)
    return {}
  }) as never
  try {
    const results: unknown[] = []
    for (const step of o.steps) {
      if (step.release) {
        results.push(disposal.releaseClosedRenderer(contents[step.release] as never))
      } else if (step.flush) {
        while (immediates.length > 0) immediates.shift()?.()
      } else if (step.emit) {
        onceListeners[step.emit]?.()
      } else if (step.was) {
        results.push(disposal.wasReleasedRenderer(contents[step.was]?.id ?? base + 999))
      } else if (step.can) {
        try {
          results.push(
            disposal.canEndRendererProcess(
              contents[step.can.target] as never,
              step.can.peers.map((name) => contents[name]) as never,
            ),
          )
        } catch (error) {
          results.push({ error: (error as Error).message })
        }
      }
    }
    return results
  } finally {
    globalThis.setImmediate = realSet
  }
}

const dc = (id: number, extra: Partial<DisposalContents> = {}): DisposalContents => ({ id, ...extra })
const release = (name: string): DisposalStep => ({ release: name })
const FLUSH: DisposalStep = { flush: true }

const releaseCases: Case[] = [
  {
    args: [{ contents: { a: dc(1, { pid: 10 }) }, steps: [release('a'), release('a'), FLUSH] }],
    note: 'a live process alone: crashed on purpose, destroyed when it is gone; the second call does nothing',
  },
  {
    args: [{ contents: { a: dc(1, { pid: 10 }) }, steps: [release('a'), { emit: 'a' }, FLUSH] }],
    note: 'the process is gone: the view is destroyed in an immediate',
  },
  {
    args: [{ contents: { a: dc(1) }, steps: [release('a'), FLUSH] }],
    note: 'no process id: destroyed at once, nothing crashed',
  },
  {
    args: [{ contents: { a: dc(1, { destroyed: true }) }, steps: [release('a'), FLUSH] }],
    note: 'already destroyed',
  },
  {
    args: [
      {
        contents: { a: dc(1, { pid: 10 }), b: dc(2, { pid: 10 }) },
        steps: [release('a'), FLUSH, { emit: 'a' }, FLUSH],
      },
    ],
    note: 'a process that serves a live view stays; the closed view waits for it',
  },
  {
    args: [
      {
        contents: { a: dc(1, { pid: 10 }), b: dc(2, { pid: 10 }) },
        steps: [release('b'), release('a'), FLUSH],
      },
    ],
    note: 'the other view was released first: its process may end',
  },
  {
    args: [
      {
        contents: { a: dc(1, { pid: 10 }), b: dc(2, { pid: 10, destroyed: true }), c: dc(3, { pid: 11 }) },
        steps: [release('a'), FLUSH],
      },
    ],
    note: 'peers that are destroyed or elsewhere do not count',
  },
  {
    args: [{ contents: { a: dc(1, { pid: 10, throws: ['isDestroyed'] }) }, steps: [release('a'), release('a')] }],
    note: 'a view torn down meanwhile: false, and it counts as closed',
  },
  {
    args: [{ contents: { a: dc(1, { pid: 10, throws: ['getOSProcessId'] }) }, steps: [release('a'), FLUSH] }],
    note: 'the process id cannot be read',
  },
  {
    args: [{ contents: { a: dc(1, { pid: 10, throws: ['once'] }) }, steps: [release('a'), FLUSH] }],
    note: 'the listener cannot be added',
  },
  {
    args: [{ contents: { a: dc(1, { pid: 10, throws: ['forcefullyCrashRenderer'] }) }, steps: [release('a'), FLUSH] }],
    note: 'the crash call throws',
  },
  {
    args: [{ contents: { a: dc(1, { pid: 10 }) }, peersThrow: true, steps: [release('a'), FLUSH] }],
    note: 'the list of views throws',
  },
  {
    args: [{ contents: { a: dc(1, { throws: ['close'] }) }, steps: [release('a'), FLUSH] }],
    note: 'close throws inside the immediate',
  },
]

const wasCases: Case[] = [
  { args: [{ contents: { a: dc(1, { pid: 10 }) }, steps: [{ was: 'a' }, release('a'), { was: 'a' }] }] },
  { args: [{ contents: { a: dc(1), b: dc(2) }, steps: [release('a'), { was: 'b' }, { was: 'zz' }] }] },
  {
    args: [{ contents: { a: dc(1, { destroyed: true }) }, steps: [release('a'), { was: 'a' }] }],
    note: 'a destroyed view is marked too',
  },
]

const canCases: Case[] = [
  {
    args: [{ contents: { a: dc(1, { pid: 10 }) }, steps: [{ can: { target: 'a', peers: ['a'] } }] }],
    note: 'alone in its process',
  },
  {
    args: [
      {
        contents: { a: dc(1, { pid: 10 }), b: dc(2, { pid: 10 }) },
        steps: [{ can: { target: 'a', peers: ['a', 'b'] } }],
      },
    ],
    note: 'a live view shares the process',
  },
  {
    args: [
      {
        contents: { a: dc(1, { pid: 10 }), b: dc(2, { pid: 10 }) },
        steps: [release('b'), { can: { target: 'a', peers: ['a', 'b'] } }],
      },
    ],
    note: 'the one sharing it is already closed',
  },
  {
    args: [{ contents: { a: dc(1, { destroyed: true, pid: 10 }) }, steps: [{ can: { target: 'a', peers: [] } }] }],
    note: 'a destroyed target',
  },
  { args: [{ contents: { a: dc(1) }, steps: [{ can: { target: 'a', peers: [] } }] }], note: 'no process id' },
  {
    args: [
      {
        contents: { a: dc(1, { pid: 10 }), b: dc(2, { pid: 11 }), c: dc(3, { pid: 10, destroyed: true }) },
        steps: [{ can: { target: 'a', peers: ['b', 'c', 'a'] } }],
      },
    ],
    note: 'other processes and destroyed peers',
  },
  {
    args: [
      {
        contents: { a: dc(1, { pid: 10, throws: ['getOSProcessId'] }) },
        steps: [{ can: { target: 'a', peers: [] } }],
      },
    ],
    note: 'throws out of the call',
  },
  {
    args: [
      {
        contents: { a: dc(1, { pid: 10 }), b: dc(2, { pid: 10, throws: ['isDestroyed'] }) },
        steps: [{ can: { target: 'a', peers: ['b'] } }],
      },
    ],
    note: 'a peer throws',
  },
]

// ---------------------------------------------------------------------------
// ui-scale
// ---------------------------------------------------------------------------

function styleContents(name: string, spec: FakeStyled, cx: TsContext) {
  return {
    isDestroyed: () => {
      cx.log(name, 'isDestroyed')
      return spec.destroyed ?? false
    },
    executeJavaScript: (script: string) => {
      cx.log(name, 'execute', script)
      return spec.rejects ? Promise.reject(new Error('gone')) : Promise.resolve(undefined)
    },
  }
}

interface UiScaleRun {
  path: string
  scale?: number
  direction?: number
  contents?: FakeStyled[]
  listeners?: number
}

async function runUiScale(kind: 'set' | 'change', o: UiScaleRun, cx: TsContext): Promise<unknown> {
  const contents = (o.contents ?? []).map((spec, i) => styleContents(`c${i}`, spec, cx))
  useElectron({
    webContents: {
      getAllWebContents: () => {
        cx.log('getAllWebContents')
        return contents
      },
    },
  })
  // a listener stays registered for the life of the module: it only speaks for its own case
  const live = { on: true }
  for (let i = 0; i < (o.listeners ?? 0); i++) {
    uiScale.onUiScaleChanged((scale: number) => {
      if (live.on) cx.log('listener', i, scale)
    })
  }
  try {
    const value =
      kind === 'change'
        ? uiScale.changeUiScale(o.path, o.direction as 1 | -1 | 0)
        : uiScale.setUiScale(o.path, o.scale as number)
    return { value }
  } catch (error) {
    // the message names the temporary file: only the code is compared
    return { threw: (error as { code?: string }).code ?? null }
  } finally {
    live.on = false
    await tick()
  }
}

const SCALE_FILE = (value: unknown): Record<string, string> => ({
  'settings.json': JSON.stringify({ uiScale: value, keep: 'me' }),
})

const readScaleCases: Case[] = [
  { args: ['$DIR/settings.json'], note: 'no file' },
  { args: ['$DIR/settings.json'], files: SCALE_FILE(1.25) },
  { args: ['$DIR/settings.json'], files: SCALE_FILE(1.1) },
  { args: ['$DIR/settings.json'], files: SCALE_FILE(9) },
  { args: ['$DIR/settings.json'], files: SCALE_FILE(0.2) },
  { args: ['$DIR/settings.json'], files: SCALE_FILE(-3) },
  { args: ['$DIR/settings.json'], files: SCALE_FILE('1.5') },
  { args: ['$DIR/settings.json'], files: SCALE_FILE(null) },
  { args: ['$DIR/settings.json'], files: { 'settings.json': '{"uiScale": 1e999}' } },
  { args: ['$DIR/settings.json'], files: { 'settings.json': 'not json' } },
  { args: ['$DIR/settings.json'], files: { 'settings.json': '[1.5]' } },
]

const clampCases = cases([0.5], [1], [1.3], [1.5], [2], [-1], [1e9], [1.0000001], [1.4999999], [0])
const stepCases = cases(
  [1, 1],
  [1, -1],
  [1.1, 1],
  [1.1, -1],
  [1.25, 1],
  [1.5, 1],
  [1.5, -1],
  [1.2, 1],
  [1.2, -1],
  [0.5, 1],
  [9, -1],
  [1.1000000001, 1],
  [1.25 - 1e-10, 1],
)

const applyScaleCases: Case[] = [
  { args: [{ scale: 1.25, destroyed: false, rejects: false }] },
  { args: [{ scale: 3, destroyed: false, rejects: true }], note: 'clamped; a renderer torn down mid-call' },
  { args: [{ scale: 1.1, destroyed: true }], note: 'destroyed: nothing runs' },
  { args: [{ scale: 0.1, destroyed: false }], note: 'clamped up' },
]

const applyAllCases: Case[] = [
  { args: [{ scale: 1.5, contents: [{}, { destroyed: true }, { rejects: true }] }], note: 'the live ones get it' },
  { args: [{ scale: 1.1, contents: [] }], note: 'no webContents' },
  { args: [{ scale: 7, contents: [{ destroyed: true }] }], note: 'only a destroyed one' },
]

const setScaleCases: Case[] = [
  {
    args: [{ path: '$DIR/settings.json', scale: 1.25, contents: [{}, { destroyed: true }], listeners: 2 }],
    files: SCALE_FILE(1),
    note: 'persisted, applied, announced',
  },
  { args: [{ path: '$DIR/settings.json', scale: 9, listeners: 1 }], note: 'clamped before it is stored' },
  { args: [{ path: '$DIR/settings.json', scale: 0, contents: [{}] }], files: SCALE_FILE(1.5), note: 'clamped up' },
  {
    args: [{ path: '$DIR/missing/settings.json', scale: 1.25, contents: [{}], listeners: 1 }],
    note: 'unwritable: nothing is applied, nobody is told',
  },
]

const changeScaleCases: Case[] = [
  { args: [{ path: '$DIR/settings.json', direction: 1, contents: [{}], listeners: 1 }], files: SCALE_FILE(1.1) },
  { args: [{ path: '$DIR/settings.json', direction: -1, contents: [{}] }], files: SCALE_FILE(1.25) },
  { args: [{ path: '$DIR/settings.json', direction: 0, contents: [{}], listeners: 1 }], files: SCALE_FILE(1.5), note: 'reset' },
  { args: [{ path: '$DIR/settings.json', direction: 1, contents: [] }], note: 'no file: from 1' },
  { args: [{ path: '$DIR/settings.json', direction: 1, contents: [] }], files: SCALE_FILE(1.5), note: 'already at the top' },
  { args: [{ path: '$DIR/settings.json', direction: -1, contents: [] }], files: SCALE_FILE(1), note: 'already at the bottom' },
  { args: [{ path: '$DIR/missing/settings.json', direction: 1, listeners: 1 }], note: 'unwritable' },
]

const listenerCases: Case[] = [
  { args: [{ path: '$DIR/settings.json', scale: 1.1, listeners: 3 }], note: 'three listeners, in order' },
  { args: [{ path: '$DIR/settings.json', scale: 2, listeners: 1 }], note: 'one, with the clamped scale' },
  { args: [{ path: '$DIR/settings.json', scale: 1.1, listeners: 0 }], note: 'none' },
]

// ---------------------------------------------------------------------------
// crash-watch
// ---------------------------------------------------------------------------

interface Sources {
  appKB: number[]
  free: number
  total: number
  ai: number
  cli: number
  heapUsed: number
  heapLimit: number
  rss: number
}

/** the machine the figures read: each read is one log line, in the order it happens */
function withSources<T>(src: Sources, cx: TsContext, run: () => T): T {
  const machine = os as unknown as Record<string, Fn>
  const engine = v8 as unknown as Record<string, Fn>
  const memory = process.memoryUsage as unknown as Record<string, Fn>
  const saved = {
    freemem: machine.freemem,
    totalmem: machine.totalmem,
    heap: engine.getHeapStatistics,
    rss: memory.rss,
  }
  machine.freemem = () => {
    cx.log('freemem')
    return src.free
  }
  machine.totalmem = () => {
    cx.log('totalmem')
    return src.total
  }
  engine.getHeapStatistics = () => {
    cx.log('getHeapStatistics')
    return { used_heap_size: src.heapUsed, heap_size_limit: src.heapLimit }
  }
  memory.rss = () => {
    cx.log('rss')
    return src.rss
  }
  syncBuiltinESMExports()
  try {
    return run()
  } finally {
    machine.freemem = saved.freemem
    machine.totalmem = saved.totalmem
    engine.getHeapStatistics = saved.heap
    memory.rss = saved.rss
    syncBuiltinESMExports()
  }
}

const MBYTES = 1024 * 1024
const SRC: Sources = {
  appKB: [51_200, 102_400, 1_000],
  free: 3000.4 * MBYTES,
  total: 16_000.5 * MBYTES,
  ai: 2,
  cli: 1,
  heapUsed: 120.5 * MBYTES,
  heapLimit: 4144 * MBYTES,
  rss: 310.49 * MBYTES,
}

function metricsApp(src: Sources, cx: TsContext) {
  return {
    getAppMetrics: () => {
      cx.log('getAppMetrics')
      return src.appKB.map((kb) => ({ memory: { workingSetSize: kb } }))
    },
  }
}

const figureCases = (extra: Partial<Sources>[]): Case[] =>
  extra.map((e): Case => ({ args: [{ ...SRC, ...e }] }))
const FIGURE_SOURCES: Partial<Sources>[] = [
  {},
  { appKB: [], ai: 0, cli: 0 },
  { free: 0.5 * MBYTES, total: 0.5 * MBYTES, rss: 0.5 * MBYTES, heapUsed: 2.5 * MBYTES },
  { appKB: [1023, 1], free: 2.5 * MBYTES, heapLimit: 0 },
  { appKB: [0.5, 0.5], rss: 1.5 * MBYTES + 1 },
]

const lowMemoryCases = cases(
  [511, 16000],
  [512, 16000],
  [1280, 16000],
  [1279, 16000],
  [1281, 16000],
  [100, 1000],
  [0, 0],
  [511.9, 100],
)
const heapShortCases = cases([850, 1000], [851, 1000], [10, 0], [0, 0], [4000, 4144], [3523, 4144], [3524, 4144])

const crashPathCases = cases([{ userData: '/home/u/data' }], [{ userData: 'C:\\Users\\u\\AppData' }], [{ userData: '' }])

const promptCases = cases(['clean-exit'], ['killed'], ['crashed'], ['oom'], ['launch-failed'], ['abnormal-exit'], [''])

type ErrSpec = { error: { name?: string; code?: unknown; message?: string } } | { value: unknown }

function thrown(spec: ErrSpec): unknown {
  if ('value' in spec) return spec.value
  const o = spec.error
  const error = new Error(o.message ?? 'x')
  if (o.name !== undefined) error.name = o.name
  if (o.code !== undefined) (error as unknown as { code: unknown }).code = o.code
  return error
}

interface LowStep {
  clock?: number
  probe?: { freeMB: number; totalMB: number; heapMB: number; heapLimitMB: number } | 'throws'
  stop?: true
}

interface LowScenario {
  userData: string
  sampleMs?: number
  cooldownMs?: number
  /** the options' own probe, or the stock one over `src` */
  probe: 'given' | 'stock'
  memory: 'ok' | 'throws'
  src?: Sources
  steps: LowStep[]
}

async function runLowMemory(o: LowScenario, cx: TsContext): Promise<void> {
  const clock = { ms: cx.now }
  const state: { clock: number; probe?: LowStep['probe'] } = { clock: 0 }
  let timerFn: Fn | undefined
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  globalThis.setInterval = ((fn: Fn, ms: number) => {
    cx.log('setInterval', ms)
    timerFn = fn
    return { unref: () => cx.log('unref') }
  }) as never
  globalThis.clearInterval = (() => cx.log('clearInterval')) as never
  useElectron({
    app: {
      getPath: (name: string) => {
        cx.log('getPath', name)
        return o.userData
      },
    },
  })
  try {
    await withClock(clock, () =>
      withSources(o.src ?? SRC, cx, () => {
        const stop = crashWatch.startLowMemoryWatch({
          memory: () => {
            cx.log('memory')
            if (o.memory === 'throws') throw new Error('memory failed')
            return { appMB: 100, aiStreams: 1 }
          },
          probe:
            o.probe === 'given'
              ? () => {
                  cx.log('probe')
                  if (state.probe === 'throws' || state.probe === undefined) throw new Error('probe failed')
                  return state.probe
                }
              : undefined,
          sampleMs: o.sampleMs,
          cooldownMs: o.cooldownMs,
          now: () => {
            cx.log('now')
            return state.clock
          },
        } as never)
        for (const step of o.steps) {
          if (step.clock !== undefined) state.clock = step.clock
          state.probe = step.probe
          if (step.stop) stop()
          else timerFn?.()
        }
      }),
    )
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
  }
}

const SHORT_PC = { freeMB: 100, totalMB: 8000, heapMB: 100, heapLimitMB: 4000 }
const SHORT_HEAP = { freeMB: 5000, totalMB: 8000, heapMB: 3500, heapLimitMB: 4000 }
const FINE = { freeMB: 5000, totalMB: 8000, heapMB: 100, heapLimitMB: 4000 }
const COOL = 10 * 60_000

const lowMemoryScenarios: Case[] = [
  {
    args: [
      {
        userData: '$DIR',
        probe: 'given',
        memory: 'ok',
        steps: [{ clock: 1e6, probe: SHORT_PC }, { clock: 1e6 + COOL - 1, probe: SHORT_PC }, { clock: 1e6 + COOL, probe: SHORT_HEAP }],
      },
    ],
    note: 'a line; the cooldown holds the second; then a heap line',
  },
  {
    args: [{ userData: '$DIR', probe: 'given', memory: 'ok', steps: [{ clock: 5, probe: FINE }, { clock: 6, probe: SHORT_HEAP }] }],
    note: 'nothing short; then the heap',
  },
  {
    args: [{ userData: '$DIR', probe: 'given', memory: 'throws', steps: [{ clock: 5, probe: SHORT_PC }, { clock: 6, probe: SHORT_PC }] }],
    note: 'the figures throw: best effort, the cooldown was already taken',
  },
  {
    args: [{ userData: '$DIR', probe: 'given', memory: 'ok', steps: [{ clock: 5, probe: 'throws' }, { clock: 6, probe: SHORT_PC }] }],
    note: 'the probe throws once',
  },
  {
    args: [{ userData: '$DIR', probe: 'given', memory: 'ok', sampleMs: 1000, cooldownMs: 10, steps: [{ clock: 100, probe: SHORT_PC }, { clock: 111, probe: SHORT_PC }, { stop: true }] }],
    note: 'options of its own, then stopped',
  },
  {
    args: [{ userData: '$DIR', probe: 'stock', memory: 'ok', steps: [{ clock: 1 }, { clock: 2e6 }] }],
    note: 'the stock probe over the machine: plenty free',
  },
  {
    args: [
      {
        userData: '$DIR',
        probe: 'stock',
        memory: 'ok',
        src: { ...SRC, free: 100 * MBYTES },
        steps: [{ clock: 1 }],
      },
    ],
    note: 'the stock probe: the PC is short',
  },
  {
    args: [
      {
        userData: '$DIR',
        probe: 'stock',
        memory: 'ok',
        src: { ...SRC, heapUsed: 3800 * MBYTES },
        steps: [{ clock: 1 }],
      },
    ],
    note: 'the stock probe: the heap is short',
  },
]

interface CrashWc {
  id: number
  destroyed?: boolean
  editor?: string | 'throws'
  doc?: { kind: string; title: string; filePath?: string } | null
  parent?: 'live' | 'destroyed' | 'throws' | null
  untitled?: 'copy' | 'throws' | null
  close?: boolean | 'throws'
  reloadThrows?: boolean
}

type CrashEvent =
  | { exception: ErrSpec }
  | { rejection: ErrSpec }
  | { child: { type: string; reason: string; exitCode: number } }
  | { render: { wc: string; reason: string; exitCode: number } }
  | { answer: number | 'reject' }

interface CrashScenario {
  userData: string
  prompt: boolean
  memory: 'none' | 'ok' | 'throws'
  untitledCopyOf: boolean
  reopenUntitled: boolean
  wcs: Record<string, CrashWc>
  released?: string[]
  events: CrashEvent[]
}

// apart from the ids of the disposal cases: the module keeps the closed ones for good
let crashBase = 1_000_000

async function runCrashWatch(o: CrashScenario, cx: TsContext): Promise<void> {
  const base = (crashBase += 1000)
  const clock = { ms: cx.now }
  const appListeners: Record<string, Fn> = {}
  const procHandlers: Record<string, Fn> = {}
  const pending: ((answer: number | 'reject') => void)[] = []
  const wcs = Object.fromEntries(
    Object.entries(o.wcs).map(([name, spec]) => [
      name,
      {
        __name: name,
        id: base + spec.id,
        isDestroyed: () => spec.destroyed ?? false,
        reload: () => {
          cx.log('reload', name)
          if (spec.reloadThrows) throw new Error('reload failed')
        },
      },
    ]),
  )
  const nameOf = (wc: unknown): string => (wc as { __name: string }).__name
  const specOf = (wc: unknown): CrashWc => o.wcs[nameOf(wc)]
  useElectron({
    app: {
      on: (event: string, listener: Fn) => {
        cx.log('app.on', event)
        appListeners[event] = listener
      },
      getPath: (name: string) => {
        cx.log('getPath', name)
        return o.userData
      },
    },
    dialog: {
      showMessageBox: (...given: unknown[]) => {
        if (given.length === 2) cx.log('over', given[1])
        else cx.log('box', given[0])
        return new Promise((resolve, reject) =>
          pending.push((answer) =>
            answer === 'reject' ? reject(new Error('dialog failed')) : resolve({ response: answer }),
          ),
        )
      },
    },
  })
  const realOn = process.on
  const realWarn = console.warn
  process.on = ((event: string, listener: Fn) => {
    if (event === 'uncaughtExceptionMonitor' || event === 'unhandledRejection') {
      cx.log('process.on', event)
      procHandlers[event] = listener
      return process
    }
    return realOn.call(process, event as never, listener as never)
  }) as never
  console.warn = (prefix: unknown, error: unknown) =>
    cx.log('warn', prefix, error instanceof Error ? error.message : error)
  try {
    await withClock(clock, async () => {
      for (const name of o.released ?? []) {
        disposal.releaseClosedRenderer(
          { id: wcs[name].id, isDestroyed: () => true } as never,
          () => [],
        )
      }
      crashWatch.startCrashWatch({
        editorOf: (wc: unknown) => {
          cx.log('editorOf', nameOf(wc))
          if (specOf(wc).editor === 'throws') throw new Error('editorOf failed')
          return specOf(wc).editor ?? 'docs'
        },
        documentOf: (wc: unknown) => {
          cx.log('documentOf', nameOf(wc))
          return specOf(wc).doc ?? null
        },
        parentWindow: (wc: unknown) => {
          cx.log('parentWindow', nameOf(wc))
          if (specOf(wc).parent === 'throws') throw new Error('parentWindow failed')
          return fakeParent(specOf(wc).parent) as never
        },
        closeDocument: (wc: unknown) => {
          cx.log('closeDocument', nameOf(wc))
          if (specOf(wc).close === 'throws') throw new Error('closeDocument failed')
          return specOf(wc).close ?? true
        },
        reopen: (path: string) => cx.log('reopen', path),
        untitledCopyOf: o.untitledCopyOf
          ? (wc: unknown) => {
              cx.log('untitledCopyOf', nameOf(wc))
              if (specOf(wc).untitled === 'throws') throw new Error('untitledCopyOf failed')
              return specOf(wc).untitled === 'copy' ? { copyOf: nameOf(wc) } : null
            }
          : undefined,
        reopenUntitled: o.reopenUntitled
          ? (doc: unknown, copy: unknown) => cx.log('reopenUntitled', doc, copy)
          : undefined,
        t: (key: string, params?: { title: string }) => {
          cx.log('t', key, params?.title ?? null)
          return `<${key}${params ? `:${params.title}` : ''}>`
        },
        prompt: o.prompt,
        memory:
          o.memory === 'none'
            ? undefined
            : () => {
                cx.log('memory')
                if (o.memory === 'throws') throw new Error('memory failed')
                return { appMB: 100, freeMB: 2000 }
              },
      } as never)
      for (const event of o.events) {
        if ('exception' in event) procHandlers.uncaughtExceptionMonitor(thrown(event.exception))
        else if ('rejection' in event) procHandlers.unhandledRejection(thrown(event.rejection))
        else if ('child' in event) appListeners['child-process-gone']({}, event.child)
        else if ('render' in event) {
          const { wc, ...details } = event.render
          appListeners['render-process-gone']({}, wcs[wc], details)
        } else pending.shift()?.(event.answer)
        await tick()
      }
    })
  } finally {
    process.on = realOn
    console.warn = realWarn
  }
}

const cw = (id: number, extra: Partial<CrashWc> = {}): CrashWc => ({
  id,
  doc: { kind: 'docs', title: 'Report', filePath: '/docs/report.docx' },
  ...extra,
})
const scenario = (extra: Partial<CrashScenario>): CrashScenario => ({
  userData: '$DIR',
  prompt: true,
  memory: 'ok',
  untitledCopyOf: true,
  reopenUntitled: true,
  wcs: { a: cw(1) },
  events: [],
  ...extra,
})
const render = (wc: string, reason: string, exitCode = 1): CrashEvent => ({ render: { wc, reason, exitCode } })

const crashScenarios: Case[] = [
  {
    args: [
      scenario({
        events: [
          { exception: { error: { name: 'TypeError', code: 'E_BAD', message: 'secret path /x' } } },
          { exception: { error: { name: 'weird name!!', message: 'm' } } },
          { exception: { value: 'a string' } },
          { exception: { value: 7 } },
          { rejection: { error: { message: 'late' } } },
          { rejection: { value: 'plain' } },
        ],
      }),
    ],
    note: 'main-process errors: the class and the code, never the message',
  },
  {
    args: [
      scenario({
        memory: 'none',
        events: [
          { child: { type: 'GPU', reason: 'crashed', exitCode: 139 } },
          { child: { type: 'Utility', reason: 'killed', exitCode: 0 } },
          { child: { type: 'GPU', reason: 'killed', exitCode: 0 } },
          { child: { type: 'Utility', reason: 'clean-exit', exitCode: 0 } },
          { child: { type: 'Utility', reason: 'oom', exitCode: 9 } },
        ],
      }),
    ],
    note: 'child processes: a normal exit and an ended utility are not crashes; no figures',
  },
  {
    args: [scenario({ memory: 'throws', events: [render('a', 'crashed', 11), { answer: 1 }] })],
    note: 'a crashed renderer: the record goes out without figures; the user chooses to reopen',
  },
  {
    args: [scenario({ events: [render('a', 'killed'), render('a', 'clean-exit')] })],
    note: 'killed is logged but not asked about; a clean exit is not logged',
  },
  {
    args: [scenario({ prompt: false, events: [render('a', 'crashed')] })],
    note: 'unattended: record only',
  },
  {
    args: [scenario({ released: ['a'], events: [render('a', 'crashed')] })],
    note: 'a renderer the shell ended on purpose',
  },
  {
    args: [scenario({ wcs: { a: cw(1, { editor: 'throws' }) }, events: [render('a', 'oom'), { answer: 0 }] })],
    note: 'the editor cannot be told: other; the answer 0 reopens',
  },
  {
    args: [
      scenario({
        wcs: { a: cw(1, { doc: { kind: 'slides', title: 'Deck' } }) },
        events: [render('a', 'crashed'), { answer: 0 }],
      }),
    ],
    note: 'slides reload in place',
  },
  {
    args: [
      scenario({
        wcs: { a: cw(1, { doc: { kind: 'slides', title: 'Deck' }, reloadThrows: true }) },
        events: [render('a', 'crashed'), { answer: 0 }, render('a', 'crashed'), { answer: 1 }],
      }),
    ],
    note: 'a reload that throws leaves the tab; "later" does nothing; the next crash prompts again',
  },
  {
    args: [
      scenario({
        wcs: { a: cw(1, { doc: { kind: 'docs', title: 'Untitled 1' }, untitled: 'copy', editor: 'docs' }) },
        events: [render('a', 'crashed'), { answer: 0 }],
      }),
    ],
    note: 'an untitled document comes back from its copy',
  },
  {
    args: [
      scenario({
        reopenUntitled: false,
        wcs: { a: cw(1, { doc: { kind: 'docs', title: 'Untitled 1' }, untitled: 'copy' }) },
        events: [render('a', 'crashed'), { answer: 0 }],
      }),
    ],
    note: 'no way to reopen an untitled copy: the tab just closes',
  },
  {
    args: [
      scenario({
        untitledCopyOf: false,
        wcs: { a: cw(1, { doc: { kind: 'pdf', title: 'Scan' }, untitled: 'copy' }) },
        events: [render('a', 'crashed'), { answer: 0 }],
      }),
    ],
    note: 'the editor cannot name a copy: a file-less tab closes',
  },
  {
    args: [
      scenario({
        wcs: { a: cw(1, { untitled: 'throws' }) },
        events: [render('a', 'crashed'), { answer: 0 }],
      }),
    ],
    note: 'the copy lookup throws: handled as before (reopen the file)',
  },
  {
    args: [
      scenario({
        wcs: { a: cw(1, { close: false }) },
        events: [render('a', 'crashed'), { answer: 0 }],
      }),
    ],
    note: 'the tab could not be closed: nothing reopens',
  },
  {
    args: [
      scenario({
        wcs: { a: cw(1, { close: 'throws' }) },
        events: [render('a', 'crashed'), { answer: 0 }],
      }),
    ],
    note: 'closing throws',
  },
  {
    args: [
      scenario({
        wcs: { a: cw(1, { parent: 'live' }), b: cw(2, { parent: 'destroyed' }), c: cw(3, { parent: 'throws' }) },
        events: [
          render('a', 'crashed'),
          render('b', 'crashed'),
          render('c', 'crashed'),
          { answer: 1 },
          { answer: 1 },
          { answer: 1 },
        ],
      }),
    ],
    note: 'the box sits over a live parent, none for a destroyed one, and a throwing lookup gives up',
  },
  {
    args: [
      scenario({
        events: [render('a', 'crashed'), render('a', 'crashed'), { answer: 'reject' }, render('a', 'crashed')],
      }),
    ],
    note: 'a second crash while the box is up is not asked again; a failed box frees the renderer',
  },
  {
    args: [
      scenario({
        wcs: { a: cw(1, { destroyed: true }), b: cw(2, { doc: null }) },
        events: [render('a', 'crashed'), render('b', 'crashed')],
      }),
    ],
    note: 'a destroyed renderer and a chrome renderer have nothing to ask',
  },
  {
    args: [
      scenario({
        wcs: { a: cw(1, { doc: { kind: 'docs', title: 'No file' } }) },
        events: [render('a', 'crashed'), { answer: 0 }],
      }),
    ],
    note: 'a document without a file closes',
  },
]

const memoryFigureSpec = (name: string): FnSpec => ({
  ts: (a, cx) => {
    const src = a[0] as Sources
    useElectron({ app: metricsApp(src, cx) })
    return withSources(src, cx, () =>
      name === 'main'
        ? crashWatch.mainProcessFigures()
        : crashWatch.memoryFigures({
            aiStreams: () => {
              cx.log('aiStreams')
              return src.ai
            },
            cliChildren: () => {
              cx.log('cliChildren')
              return src.cli
            },
          }),
    )
  },
  cases: figureCases(FIGURE_SOURCES),
})

// ---------------------------------------------------------------------------
// renderer-watchdog
// ---------------------------------------------------------------------------

interface DogWc {
  id: number
  pid: number
  destroyed?: boolean
  doc: { kind: string; title: string; filePath?: string } | null
  url: string
  parent?: 'live' | 'destroyed' | 'throws' | null
  attached?: boolean
  /** the debugger command that rejects */
  failOn?: string
  close?: 'throws'
}

interface DogMetric {
  pid: number
  type: string
  memKB: number
  cpu?: number
}

interface DogStep {
  clock?: number
  metrics?: DogMetric[] | 'throws'
  answer?: number | 'reject'
}

interface DogScenario {
  userData: string
  totalMem: number
  options: Record<string, number>
  wcs: Record<string, DogWc>
  steps: DogStep[]
}

const metricJson = (m: DogMetric): unknown => ({
  pid: m.pid,
  type: m.type,
  memory: { workingSetSize: m.memKB },
  cpu: { percentCPUUsage: 0, ...(m.cpu === undefined ? {} : { cumulativeCPUUsage: m.cpu }) },
})

async function runWatchdog(o: DogScenario, cx: TsContext): Promise<void> {
  const clock = { ms: cx.now }
  const pending: ((answer: number | 'reject') => void)[] = []
  const inflight = { n: 0 }
  let metrics: DogMetric[] | 'throws' = []
  let timerFn: Fn | undefined
  const wcs = Object.entries(o.wcs).map(([name, spec]) => ({
    name,
    spec,
    id: spec.id,
    isDestroyed: () => spec.destroyed ?? false,
    getOSProcessId: () => spec.pid,
    getURL: () => spec.url,
    debugger: {
      isAttached: () => spec.attached ?? false,
      attach: (version: string) => cx.log(name, 'attach', version),
      sendCommand: async (method: string, params?: unknown) => {
        cx.log(name, 'send', method, params ?? null)
        if (spec.failOn === method) throw new Error(`${method} failed`)
        return method === 'Profiler.stop' ? { profile: { nodes: [{ id: 1 }], name } } : {}
      },
      detach: () => cx.log(name, 'detach'),
    },
  }))
  const byName = (name: string) => wcs.find((w) => w.name === name)
  const nameOf = (wc: unknown): string => (wc as { name: string }).name
  useElectron({
    app: {
      getPath: (name: string) => {
        cx.log('getPath', name)
        return o.userData
      },
      getAppMetrics: () => {
        cx.log('getAppMetrics')
        if (metrics === 'throws') throw new Error('getAppMetrics failed')
        return metrics.map(metricJson)
      },
    },
    webContents: {
      getAllWebContents: () => {
        cx.log('getAllWebContents')
        return wcs
      },
    },
    dialog: {
      showMessageBox: (...given: unknown[]) => {
        if (given.length === 2) cx.log('over', given[1])
        else cx.log('box', given[0])
        return new Promise((resolve, reject) =>
          pending.push((answer) =>
            answer === 'reject' ? reject(new Error('dialog failed')) : resolve({ response: answer }),
          ),
        )
      },
    },
  })
  // the files and the timers a report waits on: the end of a report is when none is left
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  const realTimeout = globalThis.setTimeout
  const fsp = fsPromises as unknown as Record<string, Fn>
  const originals = ['writeFile', 'readdir', 'rm'].map((key) => [key, fsp[key]] as const)
  globalThis.setInterval = ((fn: Fn, ms: number) => {
    cx.log('setInterval', ms)
    timerFn = fn
    return { unref: () => cx.log('unref') }
  }) as never
  globalThis.clearInterval = (() => cx.log('clearInterval')) as never
  globalThis.setTimeout = ((fn: Fn, ms: number, ...rest: unknown[]) => {
    inflight.n++
    return realTimeout(() => {
      inflight.n--
      fn(...rest)
    }, ms)
  }) as never
  for (const [key, original] of originals) {
    fsp[key] = (...args: unknown[]) => {
      inflight.n++
      return (original(...args) as Promise<unknown>).finally(() => inflight.n--)
    }
  }
  syncBuiltinESMExports()
  const settle = async (): Promise<void> => {
    for (let quiet = 0; quiet < 3; ) {
      await tick(1)
      quiet = inflight.n === 0 ? quiet + 1 : 0
    }
  }
  try {
    await withClock(clock, () =>
      withSources({ ...SRC, total: o.totalMem }, cx, async () => {
        watchdog.startRendererWatchdog({
          describe: (wc: unknown) => {
            cx.log('describe', nameOf(wc))
            return byName(nameOf(wc))?.spec.doc ?? null
          },
          parentWindow: (wc: unknown) => {
            cx.log('parentWindow', nameOf(wc))
            if (byName(nameOf(wc))?.spec.parent === 'throws') throw new Error('parentWindow failed')
            return fakeParent(byName(nameOf(wc))?.spec.parent) as never
          },
          closeDocument: (wc: unknown) => {
            cx.log('closeDocument', nameOf(wc))
            if (byName(nameOf(wc))?.spec.close === 'throws') throw new Error('closeDocument failed')
          },
          t: (key: string, params?: Record<string, unknown>) => {
            cx.log('t', key, params ?? null)
            return `<${key}>`
          },
          ...o.options,
        } as never)
        for (const step of o.steps) {
          if (step.clock !== undefined) clock.ms = step.clock
          if (step.metrics !== undefined) {
            metrics = step.metrics
            timerFn?.()
          }
          if (step.answer !== undefined) pending.shift()?.(step.answer)
          await settle()
        }
      }),
    )
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.clearInterval = realClearInterval
    globalThis.setTimeout = realTimeout
    for (const [key, original] of originals) fsp[key] = original
    syncBuiltinESMExports()
  }
}

const dogWc = (id: number, extra: Partial<DogWc> = {}): DogWc => ({
  id,
  pid: 100 + id,
  doc: { kind: 'docs', title: 'Big sheet', filePath: '/docs/big.xlsx' },
  url: `genoffice-app://docs/index.html?tab=${id}`,
  ...extra,
})
const hot = (pid: number, cpu?: number, memKB = 3 * 1024 * 1024): DogMetric => ({ pid, type: 'Tab', memKB, cpu })
const dog = (extra: Partial<DogScenario>): DogScenario => ({
  userData: '$DIR',
  totalMem: 16 * 1024 * MBYTES,
  options: { hotSamplesBeforeReport: 2, profileMs: 1 },
  wcs: { a: dogWc(1) },
  steps: [],
  ...extra,
})
const T0 = 1_794_452_400_000
const sampleAt = (ms: number, metrics: DogStep['metrics']): DogStep => ({ clock: ms, metrics })

const watchdogCases: Case[] = [
  {
    args: [
      dog({
        steps: [
          sampleAt(T0, [hot(101)]),
          sampleAt(T0 + 30_000, [hot(101)]),
          { answer: 1 },
          sampleAt(T0 + 60_000, [hot(101)]),
        ],
      }),
    ],
    note: 'memory: two hot samples report, a profile is taken, the user closes the document',
  },
  {
    args: [
      dog({
        steps: [
          sampleAt(T0, [hot(101)]),
          sampleAt(T0 + 30_000, [hot(101)]),
          { answer: 0 },
          sampleAt(T0 + 60_000, [hot(101)]),
          sampleAt(T0 + 90_000, [hot(101)]),
        ],
      }),
    ],
    note: 'wait: the cooldown holds the next report back',
  },
  {
    args: [
      dog({
        steps: [
          sampleAt(T0, [hot(101)]),
          sampleAt(T0 + 30_000, [hot(101)]),
          { answer: 2 },
          sampleAt(T0 + 2_000_000, [hot(101)]),
          sampleAt(T0 + 2_030_000, [hot(101)]),
        ],
      }),
    ],
    note: "don't remind again: the renderer is ignored for good",
  },
  {
    args: [
      dog({
        steps: [
          sampleAt(T0, [hot(101, 0)]),
          sampleAt(T0 + 10_000, [hot(101, 12, 100)]),
          sampleAt(T0 + 20_000, [hot(101, 24, 100)]),
          { answer: 0 },
        ],
      }),
    ],
    note: 'cpu: the cumulative seconds make 120 percent of a core',
  },
  {
    args: [
      dog({
        options: { hotSamplesBeforeReport: 1, profileMs: 0, reportCooldownMs: 1000 },
        steps: [
          sampleAt(T0, [hot(101)]),
          { answer: 0 },
          sampleAt(T0 + 2000, [hot(101)]),
          sampleAt(T0 + 4000, [hot(101, undefined, 4 * 1024 * 1024)]),
          { answer: 0 },
        ],
      }),
    ],
    note: 'memory-only reports repeat only after 25 percent growth',
  },
  {
    args: [
      dog({
        options: { hotSamplesBeforeReport: 1, profileMs: 0, reportCooldownMs: 1000 },
        steps: [
          sampleAt(T0, [hot(101, 0)]),
          { answer: 0 },
          sampleAt(T0 + 5000, [hot(101, 6, 100)]),
          { answer: 0 },
        ],
      }),
    ],
    note: 'a burning core repeats on every cooldown',
  },
  {
    args: [
      dog({
        wcs: { a: dogWc(1, { doc: null }) },
        options: { hotSamplesBeforeReport: 1, profileMs: 1 },
        steps: [sampleAt(T0, [hot(101)])],
      }),
    ],
    note: 'a chrome renderer is logged, never asked',
  },
  {
    args: [
      dog({
        wcs: { a: dogWc(1, { attached: true }) },
        options: { hotSamplesBeforeReport: 1, profileMs: 1 },
        steps: [sampleAt(T0, [hot(101)]), { answer: 0 }],
      }),
    ],
    note: 'another debugger holds the renderer: no profile',
  },
  {
    args: [
      dog({
        wcs: { a: dogWc(1, { failOn: 'Profiler.start' }) },
        options: { hotSamplesBeforeReport: 1, profileMs: 1 },
        steps: [sampleAt(T0, [hot(101)]), { answer: 0 }],
      }),
    ],
    note: 'the profiler fails: detached, no prune, the prompt still comes',
  },
  {
    args: [
      dog({
        options: { hotSamplesBeforeReport: 1, profileMs: 1 },
        steps: [sampleAt(T0, 'throws'), sampleAt(T0 + 1, [hot(101)]), { answer: 0 }],
      }),
    ],
    note: 'the metrics throw once',
  },
  {
    args: [
      dog({
        wcs: { a: dogWc(1, { parent: 'live' }), b: dogWc(2, { parent: 'throws' }) },
        options: { hotSamplesBeforeReport: 1, profileMs: 0 },
        steps: [
          sampleAt(T0, [hot(101)]),
          { answer: 1 },
          sampleAt(T0 + 1_000_000, [hot(102)]),
          sampleAt(T0 + 2_000_000, [hot(102)]),
        ],
      }),
    ],
    note: 'a live parent; a parent lookup that throws only skips the box',
  },
  {
    args: [
      dog({
        wcs: { a: dogWc(1, { close: 'throws', parent: 'destroyed' }) },
        options: { hotSamplesBeforeReport: 1, profileMs: 0 },
        steps: [sampleAt(T0, [hot(101)]), { answer: 1 }, { answer: 1 }],
      }),
    ],
    note: 'closing throws; a destroyed parent has no box over it',
  },
  {
    args: [
      dog({
        options: { hotSamplesBeforeReport: 1, profileMs: 0 },
        steps: [sampleAt(T0, [hot(101)]), { answer: 'reject' }],
      }),
    ],
    note: 'a failed box only means the renderer keeps running',
  },
  {
    args: [
      dog({
        wcs: { a: dogWc(1, { destroyed: true }) },
        options: { hotSamplesBeforeReport: 1, profileMs: 0 },
        steps: [
          sampleAt(T0, [hot(101), { pid: 555, type: 'GPU', memKB: 9e9 }, hot(999)]),
        ],
      }),
    ],
    note: 'only Tab metrics of a live view count',
  },
  {
    args: [
      dog({
        totalMem: 64 * 1024 * MBYTES,
        options: { hotSamplesBeforeReport: 1, profileMs: 0 },
        steps: [sampleAt(T0, [hot(101, undefined, 6 * 1024 * 1024)]), { answer: 0 }],
      }),
    ],
    note: 'the memory limit is an eighth of a big PC',
  },
  {
    args: [
      dog({
        totalMem: 2 * 1024 * MBYTES,
        options: { hotSamplesBeforeReport: 1, profileMs: 0 },
        steps: [sampleAt(T0, [hot(101, undefined, 1800 * 1024)]), { answer: 0 }],
      }),
    ],
    note: 'and at least 1536 MB on a small one',
  },
  {
    args: [
      dog({
        options: { hotSamplesBeforeReport: 1, profileMs: 0 },
        steps: [
          sampleAt(T0, [hot(101)]),
          { answer: 0 },
          sampleAt(T0 + 1_000_000, []),
          sampleAt(T0 + 2_000_000, [hot(101)]),
          { answer: 0 },
        ],
      }),
    ],
    note: 'a renderer that left and came back starts over',
  },
]

const reportFiles = (stamps: number[]): Record<string, string> =>
  Object.fromEntries(
    stamps.flatMap((s) => [
      [`renderer-watchdog-${s}.json`, '{}'],
      [`renderer-watchdog-${s}.cpuprofile`, '{}'],
    ]),
  )

const pruneCases: Case[] = [
  {
    args: [
      dog({
        options: { hotSamplesBeforeReport: 1, profileMs: 1 },
        steps: [sampleAt(T0, [hot(101)]), { answer: 0 }],
      }),
    ],
    files: {
      ...reportFiles([1, 2, 3, 4, 5, 6, 7]),
      'renderer-watchdog-x.json': 'not a stamp',
      'other.json': '{}',
    },
    note: 'only the newest five stamps stay (the report just written is one)',
  },
  {
    args: [
      dog({
        options: { hotSamplesBeforeReport: 1, profileMs: 0 },
        steps: [sampleAt(T0, [hot(101)]), { answer: 0 }],
      }),
    ],
    files: reportFiles([T0 + 1, T0 + 2]),
    note: 'newer stamps than the clock count as newer',
  },
]

// ---------------------------------------------------------------------------
// recovery-shell
// ---------------------------------------------------------------------------
// The editors' main modules, the tab manager and launch-recovery are replaced
// for recovery-shell.ts alone (no other module that imports them sees the
// fakes): each export is a function of the case's table. The recovery store
// and the session record are the real ones, over the case's folder.

const RECOVERY_BOX = Symbol.for('main-diff.recovery')
const recoveryBox: { fns: Record<string, Fn> } = { fns: {} }
;(globalThis as Record<symbol, unknown>)[RECOVERY_BOX] = recoveryBox

const RECOVERY_FAKES: Record<string, string[]> = {
  'docs-main': ['discardDocsRecovery', 'docsRecoveryIdentity'],
  'sheets-main': [
    'createSheetsView',
    'discardSheetsRecovery',
    'migrateSheetsLegacyRecovery',
    'sheetsRecoveryIdentity',
  ],
  'pdf-main': ['createPdfView', 'discardPdfRecovery', 'pdfRecoveryIdentity'],
  'slides-main': ['slidesRecoveryIdentity'],
  'markdown-main': ['markdownRecoveryIdentity', 'setMarkdownRecoveryTitleSource'],
  'html-main': ['htmlRecoveryIdentity', 'setHtmlRecoveryTitleSource'],
  'mindmap-main': ['discardMindmapRecovery', 'mindmapRecoveryIdentity', 'setMindmapRecoveryTitleHook'],
  'hwp-main': ['hwpDiscardRecoveryCopy', 'hwpRecoveryIdentity', 'setHwpRecoveryTitle'],
  'diagram-main': ['diagramRecoveryIdentity', 'discardDiagramRecovery', 'setDiagramRecoveryTitleHook'],
  'tab-manager': ['createPlainEditorView'],
  'launch-recovery': ['planLaunch', 'resolveLaunchDecisions'],
}
const FAKE_URL = 'main-diff:recovery-'

// Node keeps the answer of a `require` by the folder of the requiring file and the
// request text, so these redirects, scoped to recovery-shell.ts, also reach the other
// files of that folder that make the same request and load after it.
registerHooks({
  resolve(specifier, context, next) {
    const name = specifier.split('/').pop() ?? ''
    if (
      specifier.startsWith('.') &&
      name in RECOVERY_FAKES &&
      context.parentURL?.includes('/apps/shell/src/main/recovery-shell.ts')
    ) {
      return { url: `${FAKE_URL}${name}`, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.startsWith(FAKE_URL)) return next(url, context)
    const names = RECOVERY_FAKES[url.slice(FAKE_URL.length)]
    const source = [
      `const box = globalThis[Symbol.for('main-diff.recovery')]`,
      ...names.map((name) => `export const ${name} = (...args) => box.fns.${name}(...args)`),
    ].join('\n')
    return { format: 'module', source, shortCircuit: true }
  },
})

const recovery = await import('../../../apps/shell/src/main/recovery-shell.ts')
const { registerRecoveryEditor } = await import('@seuoffice/electron-utils')

type IdentityJson = { kind: string; filePath?: string; untitledId?: string; ext?: string }

interface RecContents {
  id: number
  destroyed?: boolean
}

interface RecTab {
  id: string
  kind: string
  title: string
  filePath?: string
  contents?: string
}

interface PlannedJson {
  key: string
  kind: string
  title: string
  filePath?: string
  open: { type: 'file' } | { type: 'untitledCopy'; copy: IdentityJson; saveAsDefaultPath?: string }
}

interface OutcomeJson {
  storeDecisions: { identity: IdentityJson; decision: string }[]
  remove: string[]
  replace: PlannedJson[]
  append: PlannedJson[]
  front?: string
  split?: { a: string; b: string; orientation: string; ratio: number; focus: string }
  launchPaths: string[]
  splitMemoryOrHome: boolean
}

type RecStep =
  | { identity: { kind: string; contents: string } }
  | { tabCopy: { tab: { id: string; filePath?: string }; kind: string; contents: string | null } }
  | { crashedCopy: { tab: { id?: string; kind: string; filePath?: string }; contents: string } }
  | { opener: { planned: PlannedJson; kind: string; title: string; filePath?: string; call: 'open' | 'needsUser' } }
  | { reopen: { kind: string; title: string; copy: IdentityJson } }
  | { discard: { kind: string; contents: string } }
  | { titles: true }
  | { pushHwp: true }
  | { launch: true }
  | { answer: unknown }
  | { openTab: string }
  | { needsUserTab: string }

interface RecScenario {
  userData: string
  /** the editors' answers: an identity, `null`, or `throws` */
  identities?: Record<string, IdentityJson | null | 'throws'>
  /** editors with a recovery contract, and how it opens a copy */
  contracts?: string[]
  contractOpens?: 'ok' | 'throws' | 'rejects'
  contents: Record<string, RecContents>
  strip?: RecTab[]
  blocked?: boolean
  launchPaths?: string[]
  reopenedByInstaller?: boolean
  plan?: { restoreRun: boolean; plainLaunch: boolean; tabs: PlannedJson[]; items: unknown[] } | 'throws'
  outcome?: OutcomeJson
  managerThrows?: string[]
  depsThrow?: string[]
  steps: RecStep[]
}

let recoverySerial = 0

async function runRecovery(o: RecScenario, cx: TsContext): Promise<unknown[]> {
  const serial = (recoverySerial += 1)
  const tid = (name: string): string => `${serial}:${name}`
  const shown = (id: unknown): unknown =>
    typeof id === 'string' ? id.replace(`${serial}:`, '') : id
  const clock = { ms: cx.now }
  let nextTab = 0
  let nextView = 0
  const specs: Record<string, { kind: string; title: string; filePath?: string; opener: any }> = {}
  const strip: { id: string; kind: string; title: string; filePath?: string }[] = (o.strip ?? []).map(
    (t) => ({ id: tid(t.id), kind: t.kind, title: t.title, ...(t.filePath ? { filePath: t.filePath } : {}) }),
  )
  let split = false
  let gateApply: Fn | undefined
  const contents = Object.fromEntries(
    Object.entries(o.contents).map(([name, spec]) => [
      name,
      { name, id: spec.id, isDestroyed: () => spec.destroyed ?? false },
    ]),
  )
  const nameOfId = (id: number): string => Object.values(contents).find((c) => c.id === id)?.name ?? `#${id}`
  const throwIf = (list: string[] | undefined, method: string): void => {
    if (list?.includes(method)) throw new Error(`${method} failed`)
  }
  const identityFor = (editor: string) => (arg: unknown): unknown => {
    cx.log(`${editor}RecoveryIdentity`, typeof arg === 'number' ? nameOfId(arg) : (arg as { name: string }).name)
    const answer = o.identities?.[editor]
    if (answer === 'throws') throw new Error(`${editor} identity failed`)
    return answer ?? null
  }
  const view = (): { webContents: { id: number } } => ({ webContents: { id: 900 + ++nextView } })
  const summary = (s: { kind: string; title: string; filePath?: string }) => ({
    kind: s.kind,
    title: s.title,
    ...(s.filePath ? { filePath: s.filePath } : {}),
  })
  const manager = {
    hydrateSession: (arg: { tabs: typeof specs[string][] }) => {
      throwIf(o.managerThrows, 'hydrateSession')
      cx.log('hydrateSession', arg.tabs.map(summary))
      return arg.tabs.map((spec) => {
        const id = tid(`t${++nextTab}`)
        specs[id] = spec
        strip.push({ id, kind: spec.kind, title: spec.title, ...(spec.filePath ? { filePath: spec.filePath } : {}) })
        return id
      })
    },
    addUnloadedTab: (spec: typeof specs[string]) => {
      throwIf(o.managerThrows, 'addUnloadedTab')
      cx.log('addUnloadedTab', summary(spec))
      const id = tid(`t${++nextTab}`)
      specs[id] = spec
      strip.push({ id, kind: spec.kind, title: spec.title, ...(spec.filePath ? { filePath: spec.filePath } : {}) })
      return id
    },
    activateTab: (id: string) => {
      throwIf(o.managerThrows, 'activateTab')
      cx.log('activateTab', shown(id))
    },
    closeTabWithoutPrompt: (id: string) => {
      throwIf(o.managerThrows, 'closeTabWithoutPrompt')
      cx.log('closeTabWithoutPrompt', shown(id))
      const at = strip.findIndex((t) => t.id === id)
      if (at >= 0) strip.splice(at, 1)
    },
    reorderTab: (id: string, slot: number) => {
      throwIf(o.managerThrows, 'reorderTab')
      cx.log('reorderTab', shown(id), slot)
      const at = strip.findIndex((t) => t.id === id)
      if (at >= 0) strip.splice(slot, 0, ...strip.splice(at, 1))
    },
    beginSplit: (a: string, b: string, orientation: string, ratio: number, focus: string) => {
      throwIf(o.managerThrows, 'beginSplit')
      cx.log('beginSplit', shown(a), shown(b), orientation, ratio, focus)
      split = true
    },
    splitState: () => (split ? {} : null),
    openHomeTab: () => {
      throwIf(o.managerThrows, 'openHomeTab')
      cx.log('openHomeTab')
    },
    list: () => strip.map((t) => ({ ...t })),
    webContentsForTab: (id: string) => {
      const tab = (o.strip ?? []).find((t) => tid(t.id) === id)
      return tab?.contents ? contents[tab.contents] : undefined
    },
  }
  const deps = {
    userDataDir: o.userData,
    gate: {
      blocking: () => {
        cx.log('gate.blocking')
        return o.blocked ?? false
      },
      publishNone: () => cx.log('gate.publishNone'),
      publish: (items: unknown[], apply: Fn) => {
        cx.log('gate.publish', items)
        gateApply = apply
      },
    },
    manager: () => manager,
    launchPaths: o.launchPaths ?? [],
    openLaunchPaths: (paths: string[]) => {
      cx.log('openLaunchPaths', paths)
      throwIf(o.depsThrow, 'openLaunchPaths')
    },
    restoreSplitMemoryOrHome: () => {
      cx.log('restoreSplitMemoryOrHome')
      throwIf(o.depsThrow, 'restoreSplitMemoryOrHome')
    },
    afterSheetsOpen: () => cx.log('afterSheetsOpen'),
    settled: () => {
      cx.log('settled')
      throwIf(o.depsThrow, 'settled')
    },
    sessionChanged: () => {
      cx.log('sessionChanged')
      throwIf(o.depsThrow, 'sessionChanged')
    },
    reopenedByInstaller: o.reopenedByInstaller,
  }
  const openerDeps = { blocked: () => deps.gate.blocking(), afterSheetsOpen: deps.afterSheetsOpen }
  const f = recoveryBox.fns
  for (const editor of ['docs', 'sheets', 'pdf', 'markdown', 'html', 'mindmap', 'hwp', 'slides', 'diagram']) {
    f[`${editor}RecoveryIdentity`] = identityFor(editor)
  }
  for (const [fn, label] of [
    ['discardDocsRecovery', 'discardDocsRecovery'],
    ['discardSheetsRecovery', 'discardSheetsRecovery'],
    ['discardPdfRecovery', 'discardPdfRecovery'],
    ['discardMindmapRecovery', 'discardMindmapRecovery'],
    ['hwpDiscardRecoveryCopy', 'hwpDiscardRecoveryCopy'],
    ['discardDiagramRecovery', 'discardDiagramRecovery'],
  ]) {
    f[fn] = (c: { name: string }) => cx.log(label, c.name)
  }
  f.createPdfView = () => {
    cx.log('createPdfView')
    return view()
  }
  f.createSheetsView = (opts: unknown) => {
    cx.log('createSheetsView', opts)
    return view()
  }
  f.createPlainEditorView = (kind: string, filePath?: string) => {
    cx.log('createPlainEditorView', kind, filePath ?? null)
    return view()
  }
  f.migrateSheetsLegacyRecovery = () => cx.log('migrateSheetsLegacyRecovery')
  for (const fn of [
    'setMarkdownRecoveryTitleSource',
    'setHtmlRecoveryTitleSource',
    'setMindmapRecoveryTitleHook',
    'setDiagramRecoveryTitleHook',
  ]) {
    f[fn] = (titleOf: unknown) => cx.log(fn, typeof titleOf)
  }
  f.setHwpRecoveryTitle = (c: { name: string }, title: string) => cx.log('setHwpRecoveryTitle', c.name, title)
  f.planLaunch = (input: { judgment: unknown; previous: { status: string }; launchPaths: string[] }) => {
    cx.log('planLaunch', { judgment: input.judgment, previous: input.previous.status, launchPaths: input.launchPaths })
    if (o.plan === 'throws') throw new Error('planLaunch failed')
    return o.plan
  }
  f.resolveLaunchDecisions = (_plan: unknown, result: unknown) => {
    cx.log('resolveLaunchDecisions', result ?? null)
    return o.outcome
  }
  const unregister = (o.contracts ?? []).map((kind) =>
    registerRecoveryEditor({
      kind,
      writeCopiesNow: () => undefined,
      openFileWithDecision: () => undefined,
      openUntitledCopy: (c: { id: number }, request: unknown) => {
        cx.log('openUntitledCopy', kind, c.id, request)
        if (o.contractOpens === 'throws') throw new Error('open threw')
        if (o.contractOpens === 'rejects') return Promise.reject(new Error('open rejected'))
        return undefined
      },
      isUnprotectable: () => false,
    } as never),
  )
  const realOn = console.warn
  console.warn = (prefix: unknown, error: unknown) =>
    cx.log('warn', prefix, error instanceof Error ? error.message : error)
  useElectron({
    app: {
      getPath: () => o.userData,
    },
  })
  sessionRecord.resetSessionRecordForTests()
  const realSetTimeout = globalThis.setTimeout
  // the recorder's timers never fire in a case
  globalThis.setTimeout = (() => ({ unref() {} })) as never
  const contentsOf = (name: string | null): never => (name === null ? undefined : contents[name]) as never
  const planned = (p: PlannedJson): never => p as never
  const results: unknown[] = []
  try {
    await withClock(clock, async () => {
      for (const step of o.steps) {
        try {
          if ('identity' in step) {
            results.push(recovery.editorRecoveryIdentity(step.identity.kind as never, contentsOf(step.identity.contents)) ?? null)
          } else if ('tabCopy' in step) {
            const { tab, kind, contents: name } = step.tabCopy
            results.push(
              recovery.tabUntitledCopy({ ...tab, id: tid(tab.id) }, kind as never, contentsOf(name)) ?? null,
            )
          } else if ('crashedCopy' in step) {
            const { tab, contents: name } = step.crashedCopy
            results.push(
              recovery.crashedUntitledCopy(
                { ...tab, ...(tab.id ? { id: tid(tab.id) } : {}), kind: tab.kind as never },
                contentsOf(name),
              ) ?? null,
            )
          } else if ('opener' in step) {
            const { planned: p, kind, title, filePath, call: which } = step.opener
            const opener = recovery.restoredTabOpener(planned(p), openerDeps)
            const context = { kind, title, ...(filePath ? { filePath } : {}) } as never
            if (which === 'open') {
              try {
                results.push({ opened: (opener.open(context) as { view: { webContents: { id: number } } }).view.webContents.id })
              } catch (error) {
                results.push({ threw: (error as Error).message })
              }
            } else {
              results.push({ needsUser: await opener.needsUser?.(context) })
            }
          } else if ('reopen' in step) {
            recovery.reopenUntitledCopy(manager as never, step.reopen.kind as never, step.reopen.title, step.reopen.copy as never, openerDeps)
            results.push(null)
          } else if ('discard' in step) {
            recovery.discardEditorRecovery(step.discard.kind as never, contentsOf(step.discard.contents))
            results.push(null)
          } else if ('titles' in step) {
            recovery.installRecoveryTitleSources((c: unknown) => String(c) as never)
            results.push(null)
          } else if ('pushHwp' in step) {
            recovery.pushHwpRecoveryTitles(manager as never)
            results.push(null)
          } else if ('launch' in step) {
            recovery.runLaunchRecovery(deps as never)
            results.push(null)
          } else if ('answer' in step) {
            await gateApply?.(step.answer)
            results.push(null)
          } else if ('openTab' in step) {
            const spec = specs[tid(step.openTab)]
            try {
              const loaded = spec.opener.open({ kind: spec.kind, title: spec.title, filePath: spec.filePath })
              results.push({ opened: loaded.view.webContents.id })
            } catch (error) {
              results.push({ threw: (error as Error).message })
            }
          } else {
            const spec = specs[tid(step.needsUserTab)]
            results.push({ needsUser: await spec.opener.needsUser?.({ kind: spec.kind, title: spec.title, filePath: spec.filePath }) })
          }
        } catch (error) {
          results.push({ error: (error as Error).message })
        }
        await tick()
      }
    })
  } finally {
    console.warn = realOn
    globalThis.setTimeout = realSetTimeout
    for (const off of unregister) off()
  }
  return results
}

const uid = (id: string, kind = 'docs', ext = '.docx'): IdentityJson => ({ kind, untitledId: id, ext })
const fid = (path: string, kind = 'docs'): IdentityJson => ({ kind, filePath: path })
const rc = (id: number, extra: Partial<RecContents> = {}): RecContents => ({ id, ...extra })
const COPY = (id: string, kind = 'docs', ext = '.docx'): Record<string, string> => ({
  [`${kind}-autosave/untitled/${id}${ext}`]: 'copy bytes',
})
const file = (key: string, kind: string, title: string, filePath?: string): PlannedJson => ({
  key,
  kind,
  title,
  ...(filePath ? { filePath } : {}),
  open: { type: 'file' },
})
const copyTab = (key: string, kind: string, title: string, copy: IdentityJson, saveAs?: string): PlannedJson => ({
  key,
  kind,
  title,
  open: { type: 'untitledCopy', copy, ...(saveAs ? { saveAsDefaultPath: saveAs } : {}) },
})
const rec = (extra: Partial<RecScenario> & { steps: RecStep[] }): RecScenario => ({ userData: '$DIR', contents: { c: rc(1), d: rc(2) }, ...extra })
const OUTCOME_NONE: OutcomeJson = { storeDecisions: [], remove: [], replace: [], append: [], launchPaths: [], splitMemoryOrHome: false }
const SESSION = (tabs: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ version: 1, cleanExit: false, startedAt: 1000, restoreRun: false, pastStartup: true, tabs, ...extra })
const idKinds = {
  docs: fid('/a.docx'),
  sheets: uid('s1', 'sheets', '.xlsx'),
  pdf: fid('/a.pdf', 'pdf'),
  markdown: uid('m1', 'markdown', '.md'),
  html: fid('/a.html', 'html'),
  mindmap: uid('mm1', 'mindmap', '.mm'),
  hwp: uid('h1', 'hwp', '.hwpx'),
  slides: fid('/a.pptx', 'slides'),
  diagram: uid('d1', 'diagram', '.drawio'),
}

const identityCases: Case[] = [
  {
    args: [
      rec({
        identities: idKinds,
        steps: Object.keys(idKinds).map((kind): RecStep => ({ identity: { kind, contents: 'c' } })),
      }),
    ],
    note: 'each editor is asked in its own way',
  },
  {
    args: [
      rec({
        identities: { docs: 'throws', slides: null },
        steps: [
          { identity: { kind: 'docs', contents: 'c' } },
          { identity: { kind: 'slides', contents: 'c' } },
          { identity: { kind: 'home', contents: 'c' } },
          { identity: { kind: 'help', contents: 'c' } },
          { identity: { kind: 'docs', contents: 'c' } },
        ],
      }),
    ],
    note: 'a throwing editor, no answer, and kinds with no editor',
  },
  {
    args: [rec({ contents: { c: rc(1, { destroyed: true }) }, identities: idKinds, steps: [{ identity: { kind: 'docs', contents: 'c' } }] })],
    note: 'a destroyed webContents is not asked',
  },
]

const tabCopyCases: Case[] = [
  {
    args: [
      rec({
        identities: { docs: uid('u1'), pdf: fid('/a.pdf', 'pdf') },
        steps: [
          { tabCopy: { tab: { id: 'a' }, kind: 'docs', contents: 'c' } },
          { tabCopy: { tab: { id: 'a' }, kind: 'pdf', contents: 'c' } },
          { tabCopy: { tab: { id: 'a', filePath: '/x' }, kind: 'sheets', contents: 'c' } },
        ],
      }),
    ],
    note: 'the editor says untitled, file, or nothing (and the tab has a file)',
  },
  {
    args: [
      rec({
        contracts: ['docs'],
        steps: [
          { reopen: { kind: 'docs', title: 'Untitled', copy: uid('u9') } },
          { tabCopy: { tab: { id: 't1' }, kind: 'docs', contents: null } },
          { tabCopy: { tab: { id: 't1', filePath: '/now/saved.docx' }, kind: 'docs', contents: null } },
          { tabCopy: { tab: { id: 'other' }, kind: 'docs', contents: 'c' } },
        ],
      }),
    ],
    note: 'a restored tab not loaded yet answers with the copy it was restored from, until it has a file',
  },
  {
    args: [rec({ contents: { c: rc(1, { destroyed: true }) }, identities: { docs: uid('u1') }, steps: [{ tabCopy: { tab: { id: 'a' }, kind: 'docs', contents: 'c' } }] })],
    note: 'a destroyed webContents is not asked',
  },
]

const crashedCopyCases: Case[] = [
  {
    args: [
      rec({
        identities: { docs: uid('u1'), pdf: uid('p1', 'pdf', '.pdf'), sheets: fid('/s.xlsx', 'sheets') },
        steps: [
          { crashedCopy: { tab: { id: 'a', kind: 'docs' }, contents: 'c' } },
          { crashedCopy: { tab: { id: 'a', kind: 'pdf' }, contents: 'c' } },
          { crashedCopy: { tab: { id: 'a', kind: 'sheets' }, contents: 'c' } },
          { crashedCopy: { tab: { id: 'a', kind: 'home' }, contents: 'c' } },
          { crashedCopy: { tab: { id: 'a', kind: 'help' }, contents: 'c' } },
        ],
      }),
    ],
    files: COPY('u1'),
    note: 'only an untitled document whose copy is on disk',
  },
  {
    args: [
      rec({
        contracts: ['docs'],
        steps: [
          { reopen: { kind: 'docs', title: 'Untitled', copy: uid('u2') } },
          { crashedCopy: { tab: { id: 't1', kind: 'docs' }, contents: 'c' } },
          { crashedCopy: { tab: { id: 't1', kind: 'docs', filePath: '/x.docx' }, contents: 'c' } },
          { crashedCopy: { tab: { kind: 'docs' }, contents: 'c' } },
        ],
      }),
    ],
    files: COPY('u2'),
    note: 'the editor says nothing: the planned copy of a restored tab, when the tab has no file and an id',
  },
  {
    args: [
      rec({
        identities: { docs: { kind: 'bogus', untitledId: 'u1', ext: '.docx' } },
        steps: [{ crashedCopy: { tab: { id: 'a', kind: 'docs' }, contents: 'c' } }],
      }),
    ],
    note: 'a kind the store refuses throws out of the call',
  },
]

const openerCases: Case[] = [
  {
    args: [
      rec({
        steps: [
          { opener: { planned: file('k', 'docs', 'A', '/a.docx'), kind: 'docs', title: 'A', filePath: '/a.docx', call: 'open' } },
          { opener: { planned: file('k', 'sheets', 'S', '/s.xlsx'), kind: 'sheets', title: 'S', filePath: '/s.xlsx', call: 'open' } },
          { opener: { planned: copyTab('k', 'docs', 'U', uid('u1')), kind: 'docs', title: 'U', call: 'open' } },
          { opener: { planned: copyTab('k', 'pdf', 'P', uid('p1', 'pdf', '.pdf'), '/was/here.pdf'), kind: 'pdf', title: 'P', call: 'open' } },
          { opener: { planned: copyTab('k', 'sheets', 'S2', uid('s1', 'sheets', '.xlsx')), kind: 'sheets', title: 'S2', call: 'open' } },
        ],
        contracts: ['docs', 'pdf', 'sheets'],
      }),
    ],
    note: 'a file tab loads plainly; copies open through the editor contract',
  },
  {
    args: [
      rec({
        blocked: true,
        contracts: ['docs'],
        steps: [
          { opener: { planned: file('k', 'docs', 'A', '/a.docx'), kind: 'docs', title: 'A', filePath: '/a.docx', call: 'open' } },
          { opener: { planned: copyTab('k', 'docs', 'U', uid('u1')), kind: 'docs', title: 'U', call: 'open' } },
          { opener: { planned: file('k', 'docs', 'A', '/a.docx'), kind: 'docs', title: 'A', filePath: '/a.docx', call: 'needsUser' } },
          { opener: { planned: copyTab('k', 'docs', 'U', uid('u1')), kind: 'docs', title: 'U', call: 'needsUser' } },
        ],
      }),
    ],
    note: 'the launch list is not answered: nothing loads, everything waits on the user',
  },
  {
    args: [
      rec({
        contracts: ['docs'],
        contractOpens: 'throws',
        steps: [
          { opener: { planned: copyTab('k', 'docs', 'U', uid('u1')), kind: 'docs', title: 'U', call: 'open' } },
          { opener: { planned: copyTab('k', 'slides', 'D', uid('d1', 'slides', '.pptx')), kind: 'slides', title: 'D', call: 'open' } },
          { opener: { planned: copyTab('k', 'home', 'H', uid('h1', 'home', '.x')), kind: 'home', title: 'H', call: 'open' } },
        ],
      }),
    ],
    note: 'a throwing contract is only warned about; an editor without a contract cannot open a copy',
  },
  {
    args: [
      rec({
        contracts: ['docs'],
        contractOpens: 'rejects',
        steps: [{ opener: { planned: copyTab('k', 'docs', 'U', uid('u1')), kind: 'docs', title: 'U', call: 'open' } }],
      }),
    ],
    note: 'a rejecting contract is only warned about',
  },
  {
    args: [
      rec({
        steps: [
          { opener: { planned: file('k', 'docs', 'A'), kind: 'docs', title: 'A', call: 'needsUser' } },
          { opener: { planned: file('k', 'home', 'H', '/h'), kind: 'home', title: 'H', filePath: '/h', call: 'needsUser' } },
          { opener: { planned: file('k', 'docs', 'A', '/a.docx'), kind: 'docs', title: 'A', filePath: '/a.docx', call: 'needsUser' } },
        ],
      }),
    ],
    note: 'no file, an editor with no copies, a file with no copy: nobody waits',
  },
]

const reopenCases: Case[] = [
  {
    args: [rec({ contracts: ['docs'], steps: [{ reopen: { kind: 'docs', title: 'Untitled 3', copy: uid('u3') } }, { openTab: 't1' }] })],
    note: 'a new tab that opens the copy',
  },
  {
    args: [rec({ managerThrows: ['addUnloadedTab'], steps: [{ reopen: { kind: 'docs', title: 'X', copy: uid('u3') } }] })],
    note: 'the manager throws out of the call',
  },
]

const discardCases: Case[] = [
  {
    args: [
      rec({
        steps: ['docs', 'sheets', 'pdf', 'mindmap', 'hwp', 'diagram', 'slides', 'markdown', 'html', 'home'].map(
          (kind): RecStep => ({ discard: { kind, contents: 'c' } }),
        ),
      }),
    ],
    note: 'six editors discard their copy; the others have nothing to do',
  },
  { args: [rec({ contents: { c: rc(1, { destroyed: true }) }, steps: [{ discard: { kind: 'docs', contents: 'c' } }] })], note: 'destroyed' },
]

const titleCases: Case[] = [{ args: [rec({ steps: [{ titles: true }] })] }]

const hwpCases: Case[] = [
  {
    args: [
      rec({
        strip: [
          { id: 'a', kind: 'hwp', title: 'Unsaved', contents: 'c' },
          { id: 'b', kind: 'hwp', title: 'Saved', filePath: '/s.hwp', contents: 'c' },
          { id: 'c', kind: 'docs', title: 'Doc', contents: 'c' },
          { id: 'd', kind: 'hwp', title: 'Gone', contents: 'd' },
          { id: 'e', kind: 'hwp', title: 'Not loaded' },
        ],
        contents: { c: rc(1), d: rc(2, { destroyed: true }) },
        steps: [{ pushHwp: true }],
      }),
    ],
    note: 'only untitled hwp tabs with a live view are told',
  },
  { args: [rec({ strip: [], steps: [{ pushHwp: true }] })], note: 'no tabs' },
]

const SAVED = { version: 1 }
const LAUNCH_PLAN = (extra: Partial<NonNullable<Exclude<RecScenario['plan'], 'throws'>>> = {}) => ({
  restoreRun: true,
  plainLaunch: false,
  tabs: [file('k1', 'docs', 'A', '/a.docx'), copyTab('k2', 'docs', 'Untitled', uid('u1'))],
  items: [],
  ...extra,
})

const launchCases: Case[] = [
  {
    args: [rec({ plan: { restoreRun: false, plainLaunch: true, tabs: [], items: [] }, steps: [{ launch: true }] })],
    note: 'no previous record: a plain launch, Home or the remembered split',
  },
  {
    args: [
      rec({
        launchPaths: ['/open/me.docx'],
        plan: { restoreRun: false, plainLaunch: true, tabs: [], items: [] },
        steps: [{ launch: true }],
      }),
    ],
    note: 'a plain launch with files',
  },
  {
    args: [
      rec({
        plan: LAUNCH_PLAN({ items: [] }),
        outcome: { ...OUTCOME_NONE, front: 'k1', split: { a: 'k1', b: 'k2', orientation: 'row', ratio: 0.4, focus: 'a' }, launchPaths: [], splitMemoryOrHome: false },
        steps: [{ launch: true }, { openTab: 't1' }, { openTab: 't2' }],
      }),
    ],
    files: { 'session-record.json': SESSION([{ kind: 'docs', title: 'A', filePath: '/a.docx' }]), 'docs-autosave/untitled/u1.docx': 'x' },
    note: 'an abnormal exit with nothing to ask: tabs come back, the front one and the split are laid out',
  },
  {
    args: [
      rec({
        plan: LAUNCH_PLAN({ items: [{ id: 'r1', title: 'A' }] }),
        outcome: {
          ...OUTCOME_NONE,
          storeDecisions: [
            { identity: fid('/a.docx'), decision: 'restore' },
            { identity: uid('u1'), decision: 'discard' },
            { identity: { kind: 'bogus', filePath: '/z' }, decision: 'later' },
          ],
          remove: ['k2', 'nope'],
          replace: [copyTab('k1', 'docs', 'A (copy)', uid('ux'))],
          append: [file('k9', 'pdf', 'New', '/n.pdf')],
          front: 'k9',
          launchPaths: [],
          splitMemoryOrHome: true,
        },
        blocked: true,
        steps: [{ launch: true }, { needsUserTab: 't1' }, { answer: { decisions: { r1: 'restore' } } }, { openTab: 't3' }],
      }),
    ],
    files: { 'session-record.json': SESSION([{ kind: 'docs', title: 'A', filePath: '/a.docx' }]) },
    note: 'a launch list: Home stays up, nothing loads; the answer records its decisions and rebuilds the strip',
  },
  {
    args: [
      rec({
        plan: LAUNCH_PLAN({ items: [{ id: 'r1', title: 'A' }] }),
        outcome: { ...OUTCOME_NONE, remove: ['k1'], launchPaths: ['/x.docx'], splitMemoryOrHome: false },
        steps: [{ launch: true }, { answer: { dismissed: true } }],
      }),
    ],
    files: { 'session-record.json': SESSION([{ kind: 'docs', title: 'A', filePath: '/a.docx' }]) },
    note: 'a dismissed list; launch files take the front',
  },
  {
    args: [
      rec({
        plan: LAUNCH_PLAN(),
        outcome: { ...OUTCOME_NONE, append: [file('k5', 'docs', 'E', '/e.docx')], front: 'k5' },
        managerThrows: ['addUnloadedTab'],
        steps: [{ launch: true }],
      }),
    ],
    files: { 'session-record.json': SESSION([{ kind: 'docs', title: 'A', filePath: '/a.docx' }]) },
    note: 'laying out fails: Home comes to the front and the launch settles',
  },
  {
    args: [
      rec({
        plan: LAUNCH_PLAN(),
        outcome: { ...OUTCOME_NONE, front: 'k1' },
        managerThrows: ['openHomeTab', 'activateTab'],
        depsThrow: ['settled'],
        steps: [{ launch: true }],
      }),
    ],
    files: { 'session-record.json': SESSION([{ kind: 'docs', title: 'A', filePath: '/a.docx' }]) },
    note: 'Home cannot be shown either; settling throws and is only warned about',
  },
  {
    args: [
      rec({
        plan: LAUNCH_PLAN(),
        depsThrow: ['sessionChanged'],
        outcome: OUTCOME_NONE,
        steps: [{ launch: true }],
      }),
    ],
    files: { 'session-record.json': SESSION([{ kind: 'docs', title: 'A', filePath: '/a.docx' }]) },
    note: 'the session record cannot be updated: warned, the launch goes on',
  },
  {
    args: [rec({ plan: 'throws', launchPaths: ['/f.docx'], steps: [{ launch: true }] })],
    files: { 'session-record.json': '{ corrupt' },
    note: 'the plan throws: a plain launch with files',
  },
  {
    args: [
      rec({
        plan: LAUNCH_PLAN(),
        reopenedByInstaller: true,
        managerThrows: ['hydrateSession'],
        steps: [{ launch: true }],
      }),
    ],
    files: { 'session-record.json': SESSION([], { cleanExit: true }) },
    note: 'reopened by the installer, and the strip cannot be rebuilt: plain launch',
  },
  {
    args: [
      rec({
        plan: LAUNCH_PLAN(),
        outcome: OUTCOME_NONE,
        steps: [{ launch: true }],
      }),
    ],
    files: { 'session-record.json': SESSION([], { cleanExit: true }), 'docs-autosave/untitled/z.docx': 'left over' },
    note: 'a clean exit with a copy left undecided',
  },
  {
    args: [
      rec({
        plan: LAUNCH_PLAN({ plainLaunch: true }),
        launchPaths: ['/a.docx', '/b.docx'],
        steps: [{ launch: true }],
      }),
    ],
    files: { 'session-record.json': SESSION([], { cleanExit: true, restoreRun: true, pastStartup: false }) },
    note: 'the plan says plain launch with two files',
  },
  {
    args: [
      rec({
        plan: LAUNCH_PLAN({ restoreRun: false, plainLaunch: true }),
        depsThrow: ['restoreSplitMemoryOrHome'],
        steps: [{ launch: true }],
      }),
    ],
    note: 'the plain launch throws: out of the call',
  },
]
void SAVED

// ---------------------------------------------------------------------------
// updater
// ---------------------------------------------------------------------------
// electron-updater and update-window.ts are replaced for updater.ts alone.
// Every case loads its own copy of updater.ts (`?case=`): it keeps its state
// at module level. The clock, the timers, the process and the console are the
// case's; electron-updater is a fake whose calls are log lines, and whose
// events are the steps'.

const UPDATER_BOX = Symbol.for('main-diff.updater')
const updaterBox: { updater: Record<string, unknown>; window: Record<string, Fn> } = {
  updater: {},
  window: {},
}
;(globalThis as Record<symbol, unknown>)[UPDATER_BOX] = updaterBox

const WINDOW_EXPORTS = [
  'setUpdateParentWindow',
  'currentUpdateUiState',
  'showUpdateWindow',
  'isUpdateWindowOpen',
  'pushUpdateState',
  'closeUpdateWindow',
]
const UPDATER_URL = 'main-diff:updater-'

registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes('/apps/shell/src/main/updater.ts')) {
      if (specifier === 'electron-updater') return { url: `${UPDATER_URL}electron-updater`, shortCircuit: true }
      if (specifier === './update-window') return { url: `${UPDATER_URL}update-window`, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.startsWith(UPDATER_URL)) return next(url, context)
    const box = `const box = globalThis[Symbol.for('main-diff.updater')]`
    const source =
      url === `${UPDATER_URL}electron-updater`
        ? [
            box,
            'export const autoUpdater = new Proxy({}, {',
            '  get: (_, key) => box.updater[key],',
            '  set: (_, key, value) => { box.updater[key] = value; return true },',
            '})',
            'export class CancellationToken {}',
          ]
        : [box, ...WINDOW_EXPORTS.map((n) => `export const ${n} = (...args) => box.window.${n}(...args)`)]
    return { format: 'module', source: source.join('\n'), shortCircuit: true }
  },
})

let updaterSerial = 0

interface UpdaterEventSpec {
  type: 'update-available' | 'download-progress' | 'update-downloaded' | 'error'
  version?: string
  notes?: unknown
  transferred?: number
  percent?: number
  file?: string
  message?: string
}

interface CheckScript {
  events?: UpdaterEventSpec[]
  result: 'none' | 'null' | { available: boolean; version?: string } | { throws: { message: string; code?: string } }
}

type UpdaterStep =
  | { init: true }
  | { manual: true }
  | { event: UpdaterEventSpec }
  | { action: 'download' | 'install' | 'later' | 'openDownload' }
  | { timer: number }
  | { immediate: number }
  | { willQuit: true }

interface UpdaterScenario {
  userData: string
  lang: 'en' | 'ko'
  platform: string
  packaged: boolean
  env: Record<string, string>
  version: string
  execPath: string
  argv: string[]
  uptime: number
  channel: 'latest' | 'stable'
  autoCheck: boolean
  updater: {
    checks: CheckScript[]
    downloads: { events?: UpdaterEventSpec[]; rejects?: string }[]
    install: 'true' | 'false' | 'none'
    /** a folder, `none` (no such method), `throws`, or `nodir` (an answer without a cache folder) */
    cacheDir: string
    httpDownload: boolean
    macMethods: boolean
  }
  dialogs: number[]
  steps: UpdaterStep[]
}

async function runUpdater(o: UpdaterScenario, cx: TsContext): Promise<unknown> {
  const n = (updaterSerial += 1)
  const updater = await import(`../../../apps/shell/src/main/updater.ts?case=${n}`)
  const clock = { ms: cx.now }
  const listeners: Record<string, Fn[]> = {}
  const original = async () => 'original'
  const checks = [...o.updater.checks]
  const downloads = [...o.updater.downloads]
  let checkAt = 0
  let downloadAt = 0
  const raw = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners[event] ?? []) listener(...args)
  }
  const fake: Record<string, unknown> = {
    on(event: string, listener: Fn) {
      ;(listeners[event] ??= []).push(listener)
      return fake
    },
    httpExecutor: o.updater.httpDownload ? { download: original } : {},
  }
  const emit = async (spec: UpdaterEventSpec): Promise<void> => {
    if (spec.type === 'update-available') raw('update-available', { version: spec.version, releaseNotes: spec.notes })
    else if (spec.type === 'download-progress') raw('download-progress', { transferred: spec.transferred, percent: spec.percent })
    else if (spec.type === 'error') raw('error', new Error(spec.message))
    else if (typeof fake.updateDownloaded === 'function') {
      await (fake.updateDownloaded as Fn)(null, { downloadedFile: spec.file, version: spec.version })
    } else raw('update-downloaded', { version: spec.version, downloadedFile: spec.file })
  }
  const stored: Record<string, unknown> = {}
  for (const name of [
    'logger',
    'channel',
    'allowDowngrade',
    'allowPrerelease',
    'autoDownload',
    'fullChangelog',
    'autoInstallOnAppQuit',
    'disableDifferentialDownload',
  ]) {
    Object.defineProperty(fake, name, {
      get: () => stored[name],
      set: (value: unknown) => {
        cx.log('autoUpdater.set', name, name === 'logger' ? '<logger>' : value)
        stored[name] = value
      },
    })
  }
  fake.checkForUpdates = async () => {
    cx.log('autoUpdater.checkForUpdates')
    const script = checks[Math.min(checkAt++, checks.length - 1)]
    for (const event of script.events ?? []) await emit(event)
    if (script.result === 'none') return { isUpdateAvailable: false, updateInfo: { version: '0.0.0' } }
    if (script.result === 'null') return null
    if ('throws' in script.result) {
      throw Object.assign(new Error(script.result.throws.message), script.result.throws.code ? { code: script.result.throws.code } : {})
    }
    return {
      isUpdateAvailable: script.result.available,
      updateInfo: script.result.version === undefined ? undefined : { version: script.result.version },
    }
  }
  fake.downloadUpdate = async () => {
    cx.log('autoUpdater.downloadUpdate')
    const script = downloads[Math.min(downloadAt++, downloads.length - 1)] ?? {}
    for (const event of script.events ?? []) await emit(event)
    if (script.rejects) throw new Error(script.rejects)
  }
  if (o.updater.install !== 'none') {
    fake.install = (silent: boolean, force: boolean) => {
      cx.log('autoUpdater.install', silent, force)
      return o.updater.install === 'true'
    }
  }
  if (o.updater.cacheDir !== 'none') {
    fake.getOrCreateDownloadHelper = async () => {
      cx.log('autoUpdater.getOrCreateDownloadHelper')
      if (o.updater.cacheDir === 'throws') throw new Error('no helper')
      return { cacheDir: o.updater.cacheDir === 'nodir' ? 123 : o.updater.cacheDir }
    }
  }
  if (o.updater.macMethods) {
    fake.dispatchUpdateDownloaded = (event: unknown) => raw('update-downloaded', event)
    fake.updateDownloaded = async (_info: unknown, event: unknown) => {
      ;(fake.dispatchUpdateDownloaded as Fn)(event)
      return []
    }
  }
  updaterBox.updater = fake
  let windowOpen = false
  let actions: Record<string, Fn> = {}
  updaterBox.window = {
    setUpdateParentWindow: () => cx.log('setUpdateParentWindow'),
    currentUpdateUiState: () => null,
    showUpdateWindow: (_win: unknown, state: unknown, given: Record<string, Fn>, options?: unknown) => {
      cx.log('showUpdateWindow', state, options ?? null)
      windowOpen = true
      actions = given
    },
    isUpdateWindowOpen: () => windowOpen,
    pushUpdateState: (patch: unknown) => cx.log('pushUpdateState', patch),
    closeUpdateWindow: () => {
      cx.log('closeUpdateWindow')
      windowOpen = false
    },
  }
  const dialogs = [...o.dialogs]
  const appListeners: Record<string, Fn> = {}
  useElectron({
    app: {
      isPackaged: o.packaged,
      getVersion: () => o.version,
      getPath: () => o.userData,
      on: (event: string, listener: Fn) => {
        appListeners[event] = listener
      },
      quit: () => cx.log('app.quit'),
    },
    dialog: {
      showMessageBox: async (options: unknown) => {
        cx.log('box', options)
        return { response: dialogs.shift() ?? 0 }
      },
    },
    shell: {
      openExternal: async (url: string) => {
        cx.log('openExternal', url)
      },
    },
  })
  // the updater is CommonJS and holds its own copy of the language module
  setUiLang(o.lang as never)
  createRequire(import.meta.url)('@seuoffice/i18n').setUiLang(o.lang)
  updateRestart.cancelUpdateRestart()
  // the timers of the case: ids from 1, in the order they are set
  let timerId = 0
  const timers: { fn: Fn; cleared: boolean }[] = []
  const immediates: Fn[] = []
  const saved = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setImmediate: globalThis.setImmediate,
  }
  globalThis.setTimeout = ((fn: Fn, ms: number) => {
    cx.log('setTimeout', ms)
    timers.push({ fn, cleared: false })
    return { id: (timerId += 1), unref() {} }
  }) as never
  globalThis.setInterval = ((fn: Fn, ms: number) => {
    cx.log('setInterval', ms)
    timers.push({ fn, cleared: false })
    return { id: (timerId += 1), unref() {} }
  }) as never
  globalThis.clearInterval = ((timer: { id: number }) => {
    cx.log('clearInterval', timer.id)
    timers[timer.id - 1].cleared = true
  }) as never
  globalThis.setImmediate = ((fn: Fn) => {
    cx.log('setImmediate')
    immediates.push(fn)
    return {}
  }) as never
  try {
    await withConsole(cx, () =>
      withClock(clock, () =>
        withProcess(
          { platform: o.platform, env: o.env, extra: { argv: o.argv, execPath: o.execPath, uptime: () => o.uptime } },
          async () => {
            for (const step of o.steps) {
              if ('init' in step) {
                updater.initAutoUpdater(() => null, () => o.autoCheck, o.channel)
              } else if ('manual' in step) {
                await updater.checkForUpdatesNow()
              } else if ('event' in step) {
                await emit(step.event)
              } else if ('action' in step) {
                const name = { download: 'onDownload', install: 'onInstall', later: 'onLater', openDownload: 'onOpenDownload' }[step.action]
                actions[name]?.()
              } else if ('timer' in step) {
                const timer = timers[step.timer - 1]
                if (timer && !timer.cleared) timer.fn()
              } else if ('immediate' in step) {
                immediates[step.immediate - 1]?.()
              } else {
                appListeners['will-quit']?.()
              }
              await settle()
            }
          },
        ),
      ),
    )
  } finally {
    Object.assign(globalThis, saved)
  }
  return {
    restartRequested: updateRestart.updateRestartRequested(),
    resumeWrapped: (() => {
      const download = (fake.httpExecutor as { download?: Fn }).download
      return typeof download === 'function' && download !== original
    })(),
  }
}

const upd = (extra: Partial<Omit<UpdaterScenario, 'updater'>> & { updater?: Partial<UpdaterScenario['updater']> }): UpdaterScenario => ({
  userData: '$DIR',
  lang: 'en',
  platform: 'win32',
  packaged: true,
  env: {},
  version: '1.0.0',
  execPath: '$DIR/app/SeuOffice.exe',
  argv: ['SeuOffice'],
  uptime: 12.34,
  channel: 'latest',
  autoCheck: true,
  dialogs: [],
  steps: [],
  ...extra,
  updater: {
    checks: [{ result: 'none' }],
    downloads: [{}],
    install: 'true',
    cacheDir: '$DIR/cache',
    httpDownload: true,
    macMethods: true,
    ...extra.updater,
  },
})

const INIT: UpdaterStep = { init: true }
const MANUAL: UpdaterStep = { manual: true }
const act = (action: 'download' | 'install' | 'later' | 'openDownload'): UpdaterStep => ({ action })
const timer = (n: number): UpdaterStep => ({ timer: n })
const available = (version: string, notes?: unknown): UpdaterEventSpec => ({ type: 'update-available', version, notes })
const found = (version: string, notes?: unknown): CheckScript => ({
  events: [available(version, notes)],
  result: { available: true, version },
})
const downloaded = (version: string, file = '$DIR/dl/update.exe'): UpdaterEventSpec => ({ type: 'update-downloaded', version, file })
const progress = (transferred: number, percent: number): UpdaterEventSpec => ({ type: 'download-progress', transferred, percent })
const NOTES = [
  { version: '2.0.0', note: '<h2>Added</h2><ul><li>One <strong>big</strong> thing</li></ul>' },
  { version: '1.5.0', note: '<p>Older <code>fix</code></p>' },
]
const DL = { 'dl/update.exe': '0123456789', 'app/keep': '' }
/** the first check (15 s after the start) and the hourly one are timers 1 and 2 */
const FIRST_CHECK = timer(1)
const HOURLY = timer(2)

const updaterScenarios: Case[] = [
  {
    args: [upd({ packaged: false, dialogs: [1, 0, 1], lang: 'ko', steps: [INIT, MANUAL, MANUAL, MANUAL] })],
    note: 'an unpacked run: the manual check points at the download page (button, then not)',
  },
  {
    args: [upd({ packaged: false, env: { SEUOFFICE_FAKE_UPDATE: '1.2.3' }, steps: [
      INIT, FIRST_CHECK, act('download'),
      ...Array.from({ length: 25 }, () => timer(2)),
      act('install'), act('openDownload'), MANUAL, act('download'), act('later'), timer(3), act('later'),
    ] })],
    note: 'the dev preview: a simulated download that completes, then the manual check shows the window again',
  },
  {
    args: [upd({ packaged: false, env: { SEUOFFICE_FAKE_UPDATE: '' }, steps: [INIT, MANUAL] })],
    note: 'an empty preview variable is none',
  },
  {
    args: [upd({ platform: 'linux', steps: [INIT, MANUAL] })],
    note: 'a Linux install without an AppImage has no updater',
  },
  {
    args: [upd({ platform: 'freebsd', env: { APPIMAGE: '/x' }, steps: [INIT] })],
    note: 'another platform',
  },
  {
    args: [upd({ platform: 'linux', env: { APPIMAGE: '/x.AppImage' }, channel: 'stable', updater: { checks: [found('2.0.0', NOTES)], downloads: [{ events: [progress(5, 10), progress(10, 100), downloaded('2.0.0')] }] }, steps: [INIT, FIRST_CHECK, act('download'), act('install'), { immediate: 1 }, { willQuit: true }] })],
    files: DL,
    note: 'an AppImage on the stable channel: a full update, the installer starts at will-quit',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0', NOTES)], downloads: [{ events: [progress(3, 30), progress(6, 60), downloaded('2.0.0')] }] }, steps: [INIT, FIRST_CHECK, { willQuit: true }, act('download'), { willQuit: true }, act('install'), { immediate: 1 }, { willQuit: true }, MANUAL] })],
    files: DL,
    note: 'Windows: update, download, restart and install; the installer starts only after the restart request',
  },
  {
    args: [upd({ lang: 'ko', updater: { checks: [found('2.0.0')], downloads: [{ events: [downloaded('2.0.0')] }], install: 'false' }, steps: [INIT, FIRST_CHECK, act('download'), act('install'), { immediate: 1 }, { willQuit: true }] })],
    files: { ...DL, 'app': { dir: true, mode: 0o555 } },
    note: 'a folder only an administrator can write: the window says so; the installer does not start',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0')], downloads: [{ events: [downloaded('2.0.0')] }], install: 'none' }, steps: [INIT, FIRST_CHECK, act('download'), act('install'), { immediate: 1 }, { willQuit: true }] })],
    files: DL,
    note: 'an updater without an install function',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0')], downloads: [{ events: [progress(1, 5)], rejects: 'net down' }, { events: [], rejects: 'net down again' }, {}] }, steps: [INIT, FIRST_CHECK, act('download'), act('download'), act('download'), act('openDownload'), act('install')] })],
    note: 'two failed downloads: the dialog stops offering retry; a failure is logged once',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0')], downloads: [{ events: [{ type: 'error', message: 'boom' }, progress(1, 1)] }] }, steps: [INIT, FIRST_CHECK, act('download'), { event: progress(2, 2) }, { event: { type: 'error', message: 'late' } }] })],
    note: 'error events are logged; progress counts only while a download runs',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0')], downloads: [{ events: [downloaded('1.9.9')] }] }, steps: [INIT, FIRST_CHECK, act('download'), act('later'), { event: downloaded('1.9.9') }, act('install')] })],
    note: 'a download of a version that is not the offered one is ignored; "install" before anything downloaded does nothing',
  },
  {
    args: [upd({ steps: [INIT, { event: progress(1, 1) }, act('download')] })],
    note: 'download with no update known',
  },
  {
    args: [upd({ argv: ['SeuOffice', '--updated'], version: '2.0.0', uptime: 3.25, steps: [INIT] })],
    files: { 'update-install-attempt.json': JSON.stringify({ version: '2.0.0', fromVersion: '1.0.0', visible: true, startedAt: '2026-11-12T02:59:00.000Z' }) },
    note: 'the installer ran and the app is at the new version: recorded, the record goes; reopened by the installer',
  },
  {
    args: [upd({ version: '2.0.0', uptime: 0.04, steps: [INIT] })],
    files: { 'update-install-attempt.json': JSON.stringify({ version: '2.0.0', fromVersion: '1.0.0', visible: false, startedAt: 'not a date' }) },
    note: 'a start time that is not a date',
  },
  {
    args: [upd({ version: '2.0.0', steps: [INIT] })],
    files: { 'update-install-attempt.json': JSON.stringify({ version: '2.0.0', fromVersion: '1.0.0', visible: false, startedAt: '2026-11-12T02:00:00.123Z' }) },
    note: 'long after the install start',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0')] }, steps: [INIT, FIRST_CHECK] })],
    files: { 'update-install-attempt.json': JSON.stringify({ version: '2.0.0', fromVersion: '1.0.0', visible: false, tries: 1 }) },
    note: 'an installer start that left the app at the old version: the next offer says so (install-failed)',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0')], downloads: [{ events: [downloaded('2.0.0')] }] }, steps: [INIT, FIRST_CHECK, act('download'), act('install'), { immediate: 1 }, { willQuit: true }] })],
    files: { ...DL, 'update-install-attempt.json': JSON.stringify({ version: '2.0.0', fromVersion: '1.0.0', visible: true }) },
    note: 'a second failure goes to the download page (manual), and the retry counts tries',
  },
  {
    args: [upd({ updater: { checks: [found('3.0.0')] }, steps: [INIT, FIRST_CHECK] })],
    files: { 'update-install-attempt.json': '{"version":"2.0.0"}' },
    note: 'a record that is not a record is ignored',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0', NOTES), found('2.0.0'), found('2.0.0', NOTES), found('3.0.0')] }, steps: [INIT, FIRST_CHECK, HOURLY, act('later'), HOURLY, HOURLY, HOURLY] })],
    note: 'a repeat of the shown version leaves the window; "later" mutes the version for the session; a newer one is offered',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0', NOTES), found('2.0.0')], downloads: [{ events: [progress(1, 10)] }] }, steps: [INIT, FIRST_CHECK, act('download'), act('later'), HOURLY, { event: available('2.0.0', undefined) }] })],
    note: 'a repeat for the same version, window closed: it is shown again at its phase, with the notes kept',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0'), found('3.0.0')], downloads: [{ events: [progress(1, 10)] }] }, steps: [INIT, FIRST_CHECK, act('download'), act('later'), HOURLY, MANUAL, MANUAL] })],
    note: 'a newer release during a download stays out; the scheduled check is skipped; a manual one brings back the flow',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0'), found('3.0.0')], downloads: [{ events: [downloaded('2.0.0')] }] }, steps: [INIT, FIRST_CHECK, act('download'), act('later'), MANUAL, HOURLY] })],
    files: DL,
    note: 'a newer release after a finished download; the window comes back inactive after "later"',
  },
  {
    args: [upd({ updater: { checks: [found('2.0.0')], downloads: [{ events: [downloaded('2.0.0')] }] }, steps: [INIT, FIRST_CHECK, act('download')] })],
    files: DL,
    note: 'a download that finishes behind a closed window shows it inactive',
  },
  {
    args: [upd({ autoCheck: false, steps: [INIT, FIRST_CHECK, HOURLY, MANUAL] })],
    note: 'background checks turned off: a manual check still asks',
  },
  {
    args: [upd({ updater: { checks: [{ result: { throws: { message: 'offline' } } }, { result: 'null' }, { result: { available: true } }] }, steps: [INIT, FIRST_CHECK, HOURLY, HOURLY] })],
    note: 'scheduled checks: a failure is logged, a skipped check is none, an available one without a version',
  },
  {
    args: [upd({ lang: 'ko', dialogs: [0, 0, 0, 0, 0, 0], updater: { checks: [{ result: 'none' }, { result: { throws: { message: 'offline' } } }, { result: { throws: { message: 'nothing', code: 'HTTP_ERROR_404' } } }, { result: { throws: { message: 'odd', code: 'ERR_SOMETHING' } } }, { result: 'null' }, found('2.0.0')] }, steps: [INIT, MANUAL, MANUAL, MANUAL, MANUAL, MANUAL, MANUAL] })],
    note: 'manual checks: up to date, failure, no release (up to date), another code, skipped, found',
  },
  {
    args: [upd({ dialogs: [0], updater: { checks: [{ result: { throws: { message: 'no feed', code: 'ERR_XML_MISSED_ELEMENT' } } }] }, steps: [INIT, MANUAL] })],
    note: 'a repository with no release counts as up to date',
  },
  {
    args: [upd({ updater: { cacheDir: 'none' }, steps: [INIT] })],
    note: 'the updater has no download helper: its cache is not looked at',
  },
  {
    args: [upd({ updater: { cacheDir: 'throws' }, steps: [INIT] })],
    note: 'the download helper throws',
  },
  {
    args: [upd({ updater: { cacheDir: 'nodir' }, steps: [INIT] })],
    note: 'the helper names no cache folder',
  },
  {
    args: [upd({ version: '1.0.0', updater: { cacheDir: '$DIR/cache' }, steps: [INIT, timer(3), timer(4), timer(5)] })],
    files: {
      'cache/pending/update-info.json': JSON.stringify({ fileName: 'SeuOffice-0.9.0.exe' }),
      'cache/pending/SeuOffice-0.9.0.exe': 'old',
      'cache/pending/current.blockmap': { dir: true },
    },
    note: 'an old download goes at the start; a removal that fails is tried again later, a few times',
  },
  {
    args: [upd({ updater: { cacheDir: '$DIR/cache', checks: [found('2.0.0')], downloads: [{ events: [progress(1, 1)] }] }, steps: [INIT, FIRST_CHECK, act('download'), timer(3)] })],
    files: {
      'cache/pending/update-info.json': JSON.stringify({ fileName: 'SeuOffice-0.9.0.exe' }),
      'cache/pending/SeuOffice-0.9.0.exe': 'old',
      'cache/pending/current.blockmap': { dir: true },
    },
    note: 'nothing is removed once a download runs',
  },
  {
    args: [upd({ channel: 'stable', steps: [INIT] })],
    note: 'stable channel settings',
  },
  {
    args: [upd({ updater: { httpDownload: false }, steps: [INIT] })],
    note: 'an executor without a download function: no resume wrapper',
  },
  {
    args: [upd({ platform: 'darwin', execPath: '/usr/bin/node', steps: [INIT, FIRST_CHECK, act('download'), MANUAL] })],
    note: 'macOS, not an app bundle: no self update; the notice and the manual phase',
  },
  {
    args: [upd({ platform: 'darwin', execPath: '$DIR/Apps/SeuOffice.app/Contents/MacOS/SeuOffice', updater: { checks: [found('2.0.0')], macMethods: false }, steps: [INIT, FIRST_CHECK, act('download'), act('openDownload')] })],
    files: { 'Apps/.SeuOffice.app.update/left': 'x', 'Apps/.SeuOffice.app.previous/left': 'y', 'Apps/SeuOffice.app/Contents/MacOS/SeuOffice': '' },
    note: 'a Mac that cannot stage: leftovers are removed; "download" opens the page',
  },
  {
    args: [upd({ platform: 'darwin', execPath: '$DIR/Apps/SeuOffice.app/Contents/MacOS/SeuOffice', lang: 'ko', updater: { checks: [found('2.0.0', NOTES)], downloads: [{ events: [progress(1, 50), downloaded('2.0.0', '$DIR/dl/update.zip')] }, { events: [downloaded('2.0.0', '$DIR/dl/missing.zip')] }] }, steps: [INIT, FIRST_CHECK, act('download'), act('download'), { willQuit: true }, act('install')] })],
    files: { 'dl/update.zip': 'not a zip', 'Apps/SeuOffice.app/Contents/MacOS/SeuOffice': '' },
    note: 'a Mac that stages: the zip cannot be unpacked, the download fails, twice means manual',
  },
  {
    args: [upd({ platform: 'darwin', execPath: '$DIR/Apps/SeuOffice.app/Contents/MacOS/SeuOffice', steps: [INIT] })],
    files: { 'update-install-attempt.json': JSON.stringify({ version: '2.0.0', fromVersion: '1.0.0', visible: false, tries: 1 }), 'Apps/SeuOffice.app/Contents/MacOS/SeuOffice': '' },
    note: 'macOS after a swap that did not take',
  },
  {
    args: [upd({ platform: 'darwin', execPath: '$DIR/Apps/SeuOffice.app/Contents/MacOS/SeuOffice', version: '1.0.0', updater: { checks: [found('2.0.0')] }, steps: [INIT, FIRST_CHECK] })],
    files: { 'update-install-attempt.json': JSON.stringify({ version: '2.0.0', fromVersion: '1.0.0', visible: false, tries: 1 }), 'Apps/SeuOffice.app/Contents/MacOS/SeuOffice': '' },
    note: 'a Mac swap that did not take is not retried: manual',
  },
]

// ---------------------------------------------------------------------------
// the group
// ---------------------------------------------------------------------------

const constant = (name: string, read: () => unknown): FnSpec => ({
  ts: read,
  cases: [{ args: [], note: name }],
  single: 'a constant',
})

const manualCases = updaterScenarios.filter((c) =>
  JSON.stringify((c.args[0] as UpdaterScenario).steps).includes('"manual"'),
)
const scheduledCases = updaterScenarios.filter((c) => !manualCases.includes(c))

export const group: Group = {
  // ---- error-dialog
  'error-dialog.showErrorDialog': {
    ts: (a, cx) => runErrorDialog(a[0] as ErrorStep[], cx),
    cases: errorDialogCases,
  },

  // ---- permission-guard
  'permission-guard.installShellPermissionGuard': {
    ts: (a, cx) => runShellGuard(a[0] as GuardScenario, cx),
    cases: guardCases,
  },

  // ---- cli-link
  'cli-link.installCliLinkBestEffort': {
    ts: (a, cx) => runCliLink(a[0] as CliScenario, cx),
    cases: cliLinkScenarios,
  },
  'cli-link.isEphemeralInstall': {
    ts: (a) => cliLink.isEphemeralInstall(a[0] as string, a[1] as never),
    cases: ephemeralCases,
  },
  'cli-link.launcherFilePath': {
    ts: (a) => cliLink.launcherFilePath(a[0] as never, a[1] as string),
    cases: launcherPathCases,
  },
  'cli-link.writeLauncherFile': {
    ts: (a) => cliLink.writeLauncherFile(a[0] as string, a[1] as string),
    cases: writeLauncherCases,
  },

  // ---- pointer-size
  'pointer-size.POINTER_SIZE_VAR': constant('the property name', () => pointer.POINTER_SIZE_VAR),
  'pointer-size.parseCursorBaseSize': {
    ts: (a) => pointer.parseCursorBaseSize(a[0] as string),
    cases: parseCases,
  },
  'pointer-size.readPointerSize': {
    ts: (a, cx) => runRead(a[0] as ReadSpec, cx),
    cases: readCases,
  },
  'pointer-size.applyPointerSizeTo': {
    ts: async (a, cx) => {
      const o = a[0] as FakeStyled & { px: number }
      pointer.applyPointerSizeTo(styledContents('c0', o, cx) as never, o.px)
      await tick()
    },
    cases: applyPointerCases,
  },
  'pointer-size.installPointerSize': {
    ts: (a, cx) => runPointer(a[0] as PointerScenario, cx),
    cases: pointerScenarios,
  },

  // ---- renderer-disposal
  'renderer-disposal.releaseClosedRenderer': {
    ts: (a, cx) => runDisposal(a[0] as DisposalScenario, cx),
    cases: releaseCases,
  },
  'renderer-disposal.wasReleasedRenderer': {
    ts: (a, cx) => runDisposal(a[0] as DisposalScenario, cx),
    cases: wasCases,
  },
  'renderer-disposal.canEndRendererProcess': {
    ts: (a, cx) => runDisposal(a[0] as DisposalScenario, cx),
    cases: canCases,
  },

  // ---- ui-scale
  'ui-scale.UI_SCALE_KEY': constant('the settings key', () => uiScale.UI_SCALE_KEY),
  'ui-scale.UI_SCALE_STEPS': constant('the presets', () => [...uiScale.UI_SCALE_STEPS]),
  'ui-scale.UI_SCALE_MIN': constant('the lowest preset', () => uiScale.UI_SCALE_MIN),
  'ui-scale.UI_SCALE_MAX': constant('the highest preset', () => uiScale.UI_SCALE_MAX),
  'ui-scale.readUiScale': { ts: (a) => uiScale.readUiScale(a[0] as string), cases: readScaleCases },
  'ui-scale.clampUiScale': { ts: (a) => uiScale.clampUiScale(a[0] as number), cases: clampCases },
  'ui-scale.stepUiScale': {
    ts: (a) => uiScale.stepUiScale(a[0] as number, a[1] as 1 | -1),
    cases: stepCases,
  },
  'ui-scale.applyUiScaleTo': {
    ts: async (a, cx) => {
      const o = a[0] as FakeStyled & { scale: number }
      uiScale.applyUiScaleTo(styleContents('c0', o, cx) as never, o.scale)
      await tick()
    },
    cases: applyScaleCases,
  },
  'ui-scale.applyUiScaleToAll': {
    ts: async (a, cx) => {
      const o = a[0] as { scale: number; contents: FakeStyled[] }
      const contents = o.contents.map((spec, i) => styleContents(`c${i}`, spec, cx))
      useElectron({
        webContents: {
          getAllWebContents: () => {
            cx.log('getAllWebContents')
            return contents
          },
        },
      })
      uiScale.applyUiScaleToAll(o.scale)
      await tick()
    },
    cases: applyAllCases,
  },
  'ui-scale.setUiScale': {
    ts: (a, cx) => runUiScale('set', a[0] as UiScaleRun, cx),
    cases: setScaleCases,
  },
  'ui-scale.changeUiScale': {
    ts: (a, cx) => runUiScale('change', a[0] as UiScaleRun, cx),
    cases: changeScaleCases,
  },
  'ui-scale.onUiScaleChanged': {
    ts: (a, cx) => runUiScale('set', a[0] as UiScaleRun, cx),
    cases: listenerCases,
  },

  // ---- crash-watch
  'crash-watch.shouldPromptForGoneRenderer': {
    ts: (a) => crashWatch.shouldPromptForGoneRenderer(a[0] as string),
    cases: promptCases,
  },
  'crash-watch.crashLogPath': {
    ts: (a, cx) => {
      useElectron({
        app: {
          getPath: (name: string) => {
            cx.log('getPath', name)
            return (a[0] as { userData: string }).userData
          },
        },
      })
      return crashWatch.crashLogPath()
    },
    cases: crashPathCases,
  },
  'crash-watch.mainProcessFigures': memoryFigureSpec('main'),
  'crash-watch.memoryFigures': memoryFigureSpec('all'),
  'crash-watch.isLowMemory': {
    ts: (a) => crashWatch.isLowMemory(a[0] as number, a[1] as number),
    cases: lowMemoryCases,
  },
  'crash-watch.isHeapShort': {
    ts: (a) => crashWatch.isHeapShort(a[0] as number, a[1] as number),
    cases: heapShortCases,
  },
  'crash-watch.LOW_MEMORY_FLOOR_MB': constant('the floor', () => crashWatch.LOW_MEMORY_FLOOR_MB),
  'crash-watch.LOW_MEMORY_SHARE': constant('the share', () => crashWatch.LOW_MEMORY_SHARE),
  'crash-watch.HEAP_SHORT_SHARE': constant('the share', () => crashWatch.HEAP_SHORT_SHARE),
  'crash-watch.startLowMemoryWatch': {
    ts: (a, cx) => runLowMemory(a[0] as LowScenario, cx),
    cases: lowMemoryScenarios,
  },
  'crash-watch.startCrashWatch': {
    ts: (a, cx) => runCrashWatch(a[0] as CrashScenario, cx),
    cases: crashScenarios,
  },

  // ---- renderer-watchdog
  'renderer-watchdog.startRendererWatchdog': {
    ts: (a, cx) => runWatchdog(a[0] as DogScenario, cx),
    cases: [...watchdogCases, ...pruneCases],
  },

  // ---- recovery-shell
  'recovery-shell.editorRecoveryIdentity': {
    ts: (a, cx) => runRecovery(a[0] as RecScenario, cx),
    cases: identityCases,
  },
  'recovery-shell.tabUntitledCopy': {
    ts: (a, cx) => runRecovery(a[0] as RecScenario, cx),
    cases: tabCopyCases,
  },
  'recovery-shell.crashedUntitledCopy': {
    ts: (a, cx) => runRecovery(a[0] as RecScenario, cx),
    cases: crashedCopyCases,
  },
  'recovery-shell.restoredTabOpener': {
    ts: (a, cx) => runRecovery(a[0] as RecScenario, cx),
    cases: openerCases,
  },
  'recovery-shell.reopenUntitledCopy': {
    ts: (a, cx) => runRecovery(a[0] as RecScenario, cx),
    cases: reopenCases,
  },
  'recovery-shell.discardEditorRecovery': {
    ts: (a, cx) => runRecovery(a[0] as RecScenario, cx),
    cases: discardCases,
  },
  'recovery-shell.installRecoveryTitleSources': {
    ts: (a, cx) => runRecovery(a[0] as RecScenario, cx),
    cases: titleCases,
    single: 'the same lookup goes to the same four editors',
  },
  'recovery-shell.pushHwpRecoveryTitles': {
    ts: (a, cx) => runRecovery(a[0] as RecScenario, cx),
    cases: hwpCases,
  },
  'recovery-shell.runLaunchRecovery': {
    ts: (a, cx) => runRecovery(a[0] as RecScenario, cx),
    cases: launchCases,
  },

  // ---- updater
  'updater.checkForUpdatesNow': {
    ts: (a, cx) => runUpdater(a[0] as UpdaterScenario, cx),
    cases: manualCases,
  },
  'updater.initAutoUpdater': {
    ts: (a, cx) => runUpdater(a[0] as UpdaterScenario, cx),
    cases: scheduledCases,
  },
}
