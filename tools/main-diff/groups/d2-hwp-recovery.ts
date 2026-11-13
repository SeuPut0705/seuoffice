/**
 * Group `d2-hwp-recovery`: `apps/hwp/src/main/recovery.ts` (crash recovery for
 * HWP and HWPX documents) and `hwpFormatOfPath` of `apps/hwp/src/shared/ipc.ts`.
 *
 * The module holds the state of every view in module-level maps, so each case
 * loads it as a fresh patched copy (`loadPatched`, as b6-apps does) and plays a
 * scenario over it. A case is `[world, steps]`; the answer is one entry per
 * recorded step, `{ op, value | error, flushes? }`, and the folder after the
 * call is compared as for every group (the recovery copies under
 * `$DIR/userData/hwp-autosave`).
 *
 * Names: `ipc.hwpFormatOfPath` is the one plain function. Every other name is
 * `recovery.<member>`: `recovery.<export>` for an export of recovery.ts,
 * `recovery.ipc.<key of HWP_CHANNELS>` for the handler registered on that
 * channel (`recoveryBegin`, `recoveryNewTabs`, `recoveryWrite`,
 * `recoveryOpened`, `recoveryFlushed`), `recovery.contract.<method>` for a
 * method of `hwpRecoveryContract`, `recovery.listener.<name>` for the view
 * listeners `trackHwpRecovery` registers (`renderProcessGone`, `destroyed`)
 * and `recovery.timer.<name>` for the callbacks of its timers
 * (`dontSaveHoldEnded`, `flushTimedOut`). Each name's cases play at least one
 * step of it; the Rust runs the same scenario over `HwpRecovery`
 * (calls/d2_hwp_recovery.rs).
 *
 * World: `{ lang, headless, install, userData, views, host, focused,
 * response, orig, shuttingDown }`.
 * - `views[id]`: the fake `WebContents` (`destroyed`, `parent`: the window
 *   `BrowserWindow.fromWebContents` answers, `flushThrows`: its `send` of the
 *   flush channel throws); `focused` is `getFocusedWindow`'s window
 * - `host[id]`: the state the host answers from (`savePath`, `untitledCopy`,
 *   `openPath`, `dirty`); `queueFile`, `queueUntitledCopy` and `markDirty`
 *   change it as hwp-main would and are logged, as `saveBaseOf` is
 * - `response`: the answers of the dialog (a number, or one per box)
 * - `orig`: files the scenario puts under ORIG before it runs (the copies are
 *   named by a hash of the original's path, so the paths of the cases are
 *   fixed ones, never under `$DIR`)
 *
 * Steps: `{ call, args, as? }` (a result named by `as` is read back as
 * `{ $var }` in a later argument), `{ install }`, `{ gone: id }`,
 * `{ destroy: id }`, `{ fire: 'dontSave:<id>' | 'flush:<token>' }`, and the
 * silent edits `{ host: { id, ... } }`, `{ view: { id, ... } }`,
 * `{ world: { lang, headless } }` (a key set to null is removed).
 *
 * The clock is `cx.now`, `crypto.randomUUID` answers `uuid-1`, `uuid-2`, ...,
 * the run id is fixed, `setTimeout` and `clearTimeout` are a table the
 * scenario fires (each call one log line named by its owner `dontSave:<id>` or
 * `flush:<token>`), and `console.warn` is one `warn` line.
 * `applySaveFixes`, `bytesMatchFormat`, `newTabsOf` and `readHwpDefaultFormat`
 * stay real.
 */
import crypto, { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32 } from 'node:zlib'
import { setImmediate as tick } from 'node:timers/promises'
import { HWP_CHANNELS, hwpFormatOfPath } from '../../../apps/hwp/src/shared/ipc.ts'
import { useElectron } from '../electron-fake.ts'
import { fakeDialog, fakeParent } from '../fakes.ts'
import type { Case, FileSpec, Group, TsContext } from '../types.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any

const repo = new URL('../../../', import.meta.url)
const scratch = new URL('../out/d2-hwp-recovery/', import.meta.url)
let scratchCount = 0
let scratchReady = false

function scratchFile(name: string, source: string): string {
  if (!scratchReady) {
    mkdirSync(fileURLToPath(scratch), { recursive: true })
    process.on('exit', () => rmSync(fileURLToPath(scratch), { recursive: true, force: true }))
    scratchReady = true
  }
  scratchCount += 1
  const path = fileURLToPath(new URL(`${scratchCount}-${name}`, scratch))
  writeFileSync(path, source)
  return pathToFileURL(path).href
}

/** `from` replaced by `to` where the source has it, or an error naming the file */
function must(src: string, from: string, to: string, file: string): string {
  if (!src.includes(from)) throw new Error(`${file}: no ${JSON.stringify(from)} to patch`)
  return src.split(from).join(to)
}

/**
 * The module at `file` (from the repository root) as a copy of its source:
 * `patch` first, then every relative import made absolute so the copy can sit
 * in the scratch folder.
 */
async function loadPatched(file: string, patch: (src: string) => string): Promise<J> {
  const original = new URL(file, repo)
  const dir = dirname(fileURLToPath(original))
  const src = patch(readFileSync(original, 'utf8')).replace(
    /(from\s+|import\()\s*'(\.{1,2}\/[^']+)'/g,
    (_m: string, pre: string, spec: string) => {
      const target = resolvePath(dir, spec)
      const withExt = /\.(ts|mts|js|json)$/.test(target) ? target : `${target}.ts`
      return `${pre}'${pathToFileURL(withExt).href}'`
    },
  )
  return import(scratchFile(basename(file).replace(/\.ts$/, '.mts'), src))
}

/**
 * recovery.ts with its timers and its warnings handed to the scenario
 * (`globalThis.__d2hr`), and `getUiLang` answering the case's language.
 */
function recoveryModule(): Promise<J> {
  const file = 'recovery.ts'
  return loadPatched('apps/hwp/src/main/recovery.ts', (src) => {
    let out = must(
      src,
      "import { getUiLang } from '@seuoffice/i18n'",
      'const getUiLang = (): string => (globalThis as any).__d2hr.lang',
      file,
    )
    out = must(
      out,
      'let host: HwpRecoveryHost | null = null',
      'const __t = (globalThis as any).__d2hr\nlet host: HwpRecoveryHost | null = null',
      file,
    )
    out = must(
      out,
      'setTimeout(() => {\n      dontSaveByWc.delete(wcId)',
      '__t.setTimeout(`dontSave:${wcId}`, () => {\n      dontSaveByWc.delete(wcId)',
      file,
    )
    out = must(
      out,
      'const timer = setTimeout(() => {\n      flushWaiters.delete(token)',
      'const timer = __t.setTimeout(`flush:${token}`, () => {\n      flushWaiters.delete(token)',
      file,
    )
    out = must(out, 'clearTimeout(', '__t.clearTimeout(', file)
    return must(out, 'console.warn(', '__t.warn(', file)
  })
}

const g = globalThis as J
const SHARED = Symbol.for('seuoffice.recovery-store.shared')
const RUN = '0123456789abcdef'
const ORIG = join(tmpdir(), 'main-diff-d2-hwp-recovery-orig')

/**
 * apps/hwp is CommonJS to the loader, so dialog-strings.ts reads the language
 * from the CommonJS copy of @seuoffice/i18n (as in b4-hwp).
 */
const i18n = createRequire(import.meta.url)('@seuoffice/i18n') as {
  setUiLang: (lang: 'en' | 'ko', requested?: string) => void
}

const settle = async (): Promise<void> => {
  await tick()
  await tick()
}

const maskTmp = (text: string): string => text.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')
const hexOf = (bytes: Uint8Array | null): string | null =>
  bytes === null ? null : Buffer.from(bytes).toString('hex')

/** `{ hex }` is a Uint8Array; any other value goes through as it is */
function decode(value: J): J {
  return value && typeof value === 'object' && !Array.isArray(value) && 'hex' in value
    ? new Uint8Array(Buffer.from(value.hex as string, 'hex'))
    : value
}

async function runScenario(args: unknown[], cx: TsContext): Promise<unknown> {
  const world = args[0] as J
  const steps = args[1] as J[]
  const { log } = cx
  // after electron-fake registered its hooks: the package's index imports 'electron'
  const { setHeadlessMode } = (await import('@seuoffice/electron-utils')) as {
    setHeadlessMode: (on: boolean) => void
  }
  const views = new Map<number, J>(
    Object.entries(world.views ?? {}).map(([k, v]) => [Number(k), v]),
  )
  const view = (id: number): J => {
    if (!views.has(id)) views.set(id, {})
    return views.get(id)
  }
  const hosts = new Map<number, J>(Object.entries(world.host ?? {}).map(([k, v]) => [Number(k), v]))
  const hostOf = (id: number): J => {
    if (!hosts.has(id)) hosts.set(id, {})
    return hosts.get(id)
  }
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  const timers = new Map<string, () => void>()
  const listeners = {
    gone: new Map<number, () => void>(),
    destroyed: new Map<number, () => void>(),
  }
  const vars = new Map<string, unknown>()
  const pending: { settled: boolean }[] = []
  const CHANNEL = HWP_CHANNELS as J

  const wcs = new Map<number, J>()
  const wc = (id: number): J => {
    let one = wcs.get(id)
    if (!one) {
      one = {
        id,
        isDestroyed: () => view(id).destroyed === true,
        send: (channel: string, ...rest: unknown[]) => {
          log('send', id, channel, ...rest)
          if (channel === CHANNEL.recoveryFlush && view(id).flushThrows === true) {
            throw new Error('send failed')
          }
        },
        reload: () => log('reload', id),
        on: (event: string, fn: () => void) => {
          if (event === 'render-process-gone') listeners.gone.set(id, fn)
        },
        once: (event: string, fn: () => void) => {
          if (event === 'destroyed') listeners.destroyed.set(id, fn)
        },
      }
      wcs.set(id, one)
    }
    return one
  }

  const host = {
    savePathOf: (id: number) => hostOf(id).savePath ?? undefined,
    untitledCopyOf: (id: number) => hostOf(id).untitledCopy ?? undefined,
    openPathOf: (id: number) => hostOf(id).openPath ?? undefined,
    saveBaseOf: (id: number) => {
      log('saveBaseOf', id)
      return {}
    },
    isDirty: (id: number) => hostOf(id).dirty === true,
    markDirty: (id: number) => {
      log('markDirty', id)
      hostOf(id).dirty = true
    },
    queueFile: (id: number, path: string) => {
      log('queueFile', id, path)
      hostOf(id).openPath = path
      hostOf(id).savePath = path
    },
    queueUntitledCopy: (id: number, path: string, copy: J) => {
      log('queueUntitledCopy', id, path, copy)
      const one = hostOf(id)
      one.openPath = path
      one.savePath = undefined
      one.untitledCopy = copy
    },
  }

  const scenario = {
    lang: world.lang ?? 'en',
    setTimeout: (label: string, fn: () => void, ms: number): string => {
      log('setTimeout', label, ms)
      timers.set(label, fn)
      return label
    },
    clearTimeout: (label: string | undefined): void => {
      if (label === undefined) return
      log('clearTimeout', label)
      timers.delete(label)
    },
    warn: (message: string, err: unknown): void => {
      log('warn', maskTmp(`${message} ${err instanceof Error ? err.message : String(err)}`))
    },
  }

  const realNow = Date.now
  const patched = crypto as unknown as { randomUUID: () => string }
  const realUuid = patched.randomUUID
  let counter = 0
  const origDir = world.origDir as string
  rmSync(origDir, { recursive: true, force: true })
  for (const [name, file] of Object.entries(world.orig ?? {}) as [string, J][]) {
    const path = join(origDir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, file.text)
    utimesSync(path, file.mtimeMs / 1000, file.mtimeMs / 1000)
  }
  holder()[SHARED] = {
    shuttingDown: world.shuttingDown === true,
    epochs: new Map(),
    queues: new Map(),
    runId: RUN,
    discarded: new Set(),
  }
  Date.now = () => cx.now
  patched.randomUUID = () => `uuid-${++counter}`
  syncBuiltinESMExports()
  setHeadlessMode(world.headless === true)
  i18n.setUiLang(scenario.lang)
  useElectron({
    app: {
      getPath: (name: string) => {
        if (name === 'userData') return world.userData
        throw new Error(`Failed to get '${name}' path`)
      },
    },
    BrowserWindow: {
      fromWebContents: (one: J) => fakeParent(view(one.id).parent),
      getFocusedWindow: () => fakeParent(world.focused),
    },
    dialog: fakeDialog(world.response, log),
    ipcMain: {
      handle: (channel: string, fn: () => unknown) => handlers.set(channel, fn),
      on: (channel: string, fn: () => unknown) => handlers.set(channel, fn),
      removeHandler: () => {},
    },
  })
  g.__d2hr = scenario

  const out: J[] = []
  try {
    const mod = await recoveryModule()
    mod.registerHwpRecoveryIpc()
    if (world.install !== false) mod.installHwpRecovery(host)
    const event = (id: number): J => ({ sender: wc(id) })
    const handle = (key: string, id: number, ...rest: unknown[]): unknown =>
      handlers.get(CHANNEL[key])!(event(id), ...rest)

    const calls: Record<string, (a: J[]) => unknown> = {
      'recovery.hwpRecoveryIdentityOf': (a) => mod.hwpRecoveryIdentityOf(a[0]),
      'recovery.hwpRecoveryIdentity': (a) => mod.hwpRecoveryIdentity(wc(a[0])),
      'recovery.setHwpRecoveryTitle': (a) => mod.setHwpRecoveryTitle(wc(a[0]), a[1]),
      'recovery.hwpRecoverySaveAsDefault': (a) => mod.hwpRecoverySaveAsDefault(a[0]),
      'recovery.noteHwpPathConsumed': (a) => mod.noteHwpPathConsumed(a[0]),
      'recovery.hwpRecoveryOnRead': async (a) => hexOf(await mod.hwpRecoveryOnRead(wc(a[0]), a[1])),
      'recovery.hwpRecoveryFileRenamed': (a) => mod.hwpRecoveryFileRenamed(wc(a[0]), a[1], a[2]),
      'recovery.hwpRecoveryBeforeSave': (a) => mod.hwpRecoveryBeforeSave(a[0]),
      'recovery.hwpRecoverySaved': (a) => mod.hwpRecoverySaved(a[0], a[1]),
      'recovery.hwpRecoveryDontSave': (a) => mod.hwpRecoveryDontSave(wc(a[0])),
      'recovery.trackHwpRecovery': (a) => mod.trackHwpRecovery(wc(a[0])),
      'recovery.ipc.recoveryBegin': (a) => handle('recoveryBegin', a[0]),
      'recovery.ipc.recoveryNewTabs': (a) => handle('recoveryNewTabs', a[0], decode(a[1]), a[2]),
      'recovery.ipc.recoveryWrite': (a) => handle('recoveryWrite', a[0], decode(a[1]), a[2], a[3]),
      'recovery.ipc.recoveryOpened': (a) => handle('recoveryOpened', a[0], a[1]),
      'recovery.ipc.recoveryFlushed': (a) => handle('recoveryFlushed', a[0], a[1]),
      'recovery.contract.writeCopiesNow': () => {
        const one = { settled: false }
        pending.push(one)
        void mod.hwpRecoveryContract.writeCopiesNow().then(() => {
          one.settled = true
        })
        return undefined
      },
      'recovery.contract.openFileWithDecision': (a) =>
        mod.hwpRecoveryContract.openFileWithDecision(wc(a[0]), a[1]),
      'recovery.contract.openUntitledCopy': (a) =>
        mod.hwpRecoveryContract.openUntitledCopy(wc(a[0]), a[1]),
      'recovery.contract.isUnprotectable': (a) => mod.hwpRecoveryContract.isUnprotectable(wc(a[0])),
    }

    const substitute = (value: J): J => {
      if (Array.isArray(value)) return value.map(substitute)
      if (value && typeof value === 'object') {
        if ('$var' in value) return vars.get(value.$var as string)
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v)]))
      }
      return value
    }
    const edit = (target: J, changes: J): void => {
      for (const [key, value] of Object.entries(changes)) {
        if (key === 'id') continue
        if (value === null) delete target[key]
        else target[key] = value
      }
    }

    const record = async (op: string, run: () => unknown, as?: string): Promise<J> => {
      const entry: J = { op }
      try {
        const value = await run()
        if (value !== undefined) entry.value = value
        if (as !== undefined) vars.set(as, value)
      } catch (err) {
        entry.error = maskTmp(err instanceof Error ? err.message : String(err))
      }
      return entry
    }

    for (const s of steps) {
      let entry: J | null = null
      if (s.host) edit(hostOf(s.host.id), s.host)
      else if (s.view) edit(view(s.view.id), s.view)
      else if (s.world) {
        if (s.world.lang !== undefined) {
          scenario.lang = s.world.lang
          i18n.setUiLang(s.world.lang)
        }
        if (s.world.headless !== undefined) setHeadlessMode(s.world.headless === true)
      } else if (s.install) {
        entry = await record('recovery.installHwpRecovery', () => mod.installHwpRecovery(host))
      } else if (s.gone !== undefined) {
        entry = await record('recovery.listener.renderProcessGone', () => {
          listeners.gone.get(s.gone)?.()
        })
      } else if (s.destroy !== undefined) {
        view(s.destroy).destroyed = true
        const listener = listeners.destroyed.get(s.destroy)
        listeners.destroyed.delete(s.destroy)
        entry = await record('recovery.listener.destroyed', () => {
          listener?.()
        })
      } else if (s.fire !== undefined) {
        const label = s.fire as string
        const op = label.startsWith('dontSave:')
          ? 'recovery.timer.dontSaveHoldEnded'
          : 'recovery.timer.flushTimedOut'
        entry = await record(op, () => {
          const fn = timers.get(label)
          timers.delete(label)
          fn?.()
          return fn !== undefined
        })
      } else {
        const a = substitute(s.args ?? [])
        entry = await record(s.call, () => calls[s.call]!(a), s.as)
      }
      await settle()
      if (entry) {
        if (pending.length > 0) entry.flushes = pending.map((one) => one.settled)
        out.push(entry)
      }
    }
  } finally {
    Date.now = realNow
    patched.randomUUID = realUuid
    syncBuiltinESMExports()
    setHeadlessMode(false)
    delete g.__d2hr
    rmSync(origDir, { recursive: true, force: true })
  }
  return out
}

const holder = (): Record<symbol, unknown> => globalThis as unknown as Record<symbol, unknown>

// ---------------------------------------------------------------------------
// the cases
// ---------------------------------------------------------------------------

type Step = Record<string, unknown>

const U = '$DIR/userData'
const OLE = 'd0cf11e0a1b11ae1'
const HWP_A = `${OLE}0a0a`
const HWP_B = `${OLE}0b0b0b`
const ZIP = '504b0304'
const HWPX_A = `${ZIP}0a0a`

/** a stored zip with `Contents/section0.xml` holding one tab without values */
function hwpxWithTab(): string {
  const name = Buffer.from('Contents/section0.xml')
  const data = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p id="0"><hp:run><hp:t>a<hp:tab width="0" leader="0" type="1"/>b</hp:t></hp:run></hp:p></hs:sec>',
  )
  const crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + data.length, 16)
  return Buffer.concat([local, name, data, central, name, end]).toString('hex')
}
const HWPX_TAB = hwpxWithTab()

const A = '/d/a.hwp'
const B = '/d/b.hwpx'
const C = '/d/c.txt'
const A_COPY = `${A}.copy`

const OLD = 946_684_800_000
const FUTURE = 4_102_444_800_000

const sha16 = (path: string): string => createHash('sha1').update(path).digest('hex').slice(0, 16)

interface CopyOptions {
  hex?: string
  state?: string
  title?: string
  runId?: string
  writtenAt?: number
}

/** a recovery copy of a file, as an earlier run left it */
function fileCopy(path: string, o: CopyOptions = {}): Record<string, FileSpec> {
  const ext = extname(path).toLowerCase()
  const name = `${sha16(path)}${ext}`
  const dir = 'userData/hwp-autosave'
  return {
    [`${dir}/${name}`]: { hex: o.hex ?? HWP_A },
    [`${dir}/${name}.meta.json`]: JSON.stringify({
      version: 1,
      kind: 'hwp',
      filePath: path,
      untitledId: null,
      title: o.title ?? basename(path),
      writtenAt: o.writtenAt ?? OLD,
      runId: o.runId ?? 'oldrun0000000000',
      state: o.state ?? 'undecided',
    }),
  }
}

/** a recovery copy of an untitled document, as an earlier run left it */
function untitledCopy(id: string, ext: string, o: CopyOptions = {}): Record<string, FileSpec> {
  const dir = 'userData/hwp-autosave/untitled'
  return {
    [`${dir}/${id}${ext}`]: { hex: o.hex ?? HWP_A },
    [`${dir}/${id}${ext}.meta.json`]: JSON.stringify({
      version: 1,
      kind: 'hwp',
      filePath: null,
      untitledId: id,
      title: o.title ?? 'Old draft',
      writtenAt: o.writtenAt ?? OLD,
      runId: o.runId ?? 'oldrun0000000000',
      state: o.state ?? 'later',
    }),
  }
}

const settings = (value: string): Record<string, FileSpec> => ({
  'userData/app-settings.json': value,
})
const merge = (...files: Record<string, FileSpec>[]): Record<string, FileSpec> =>
  Object.assign({}, ...files)

const world = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  lang: 'en',
  userData: U,
  origDir: ORIG,
  ...over,
})
/** the host's state for view 1 (and the others by id) */
const host = (state: Record<string, Record<string, unknown>>): Record<string, unknown> => state
const saved = (path: string, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  savePath: path,
  ...more,
})

const call = (fn: string, ...args: unknown[]): Step => ({ call: fn, args })
const R = (name: string, ...args: unknown[]): Step => call(`recovery.${name}`, ...args)
const IPC = (name: string, ...args: unknown[]): Step => call(`recovery.ipc.${name}`, ...args)
const CT = (name: string, ...args: unknown[]): Step => call(`recovery.contract.${name}`, ...args)
const track = (id: number): Step => R('trackHwpRecovery', id)
const begin = (id: number): Step => IPC('recoveryBegin', id)
const write = (id: number, hex: string | null, format: unknown, tabs?: unknown): Step =>
  IPC('recoveryWrite', id, hex === null ? null : { hex }, format, tabs ?? null)
const identity = (id: number): Step => R('hwpRecoveryIdentityOf', id)
const onRead = (id: number, path: string): Step => R('hwpRecoveryOnRead', id, path)
const dontSave = (id: number): Step => R('hwpRecoveryDontSave', id)
const saveDone = (id: number, as = 'b'): Step[] => [
  { ...R('hwpRecoveryBeforeSave', id), as },
  R('hwpRecoverySaved', id, { $var: as }),
]
const decide = (id: number, filePath: string, decision: string): Step =>
  CT('openFileWithDecision', id, { filePath, decision })
const opened = (id: number, password: unknown = true): Step => IPC('recoveryOpened', id, password)
const destroy = (id: number): Step => ({ destroy: id })
const gone = (id: number): Step => ({ gone: id })
const fire = (label: string): Step => ({ fire: label })
const setHost = (id: number, changes: Record<string, unknown>): Step => ({
  host: { id, ...changes },
})
const setView = (id: number, changes: Record<string, unknown>): Step => ({
  view: { id, ...changes },
})
const dirty = (id: number): Step => setHost(id, { dirty: true })

/** begin a turn and write it: the copy of view `id` is on disk afterwards */
const copyOut = (id: number, hex = HWP_A, format = 'hwp'): Step[] => [
  begin(id),
  write(id, hex, format),
]

const one = (
  steps: Step[],
  over: Record<string, unknown> = {},
  extra: Partial<Case> = {},
): Case => ({
  args: [world(over), steps],
  ...extra,
})

const NAMES = new Set<string>()
const MISSING: string[] = []
/** a function's table entry: the cases must each play a step of `fn` */
function fnSpec(fn: string, cases: Case[], single?: string): Group[string] {
  NAMES.add(fn)
  const ops = (steps: Step[]): string[] =>
    steps.map((s) =>
      s.install
        ? 'recovery.installHwpRecovery'
        : s.gone !== undefined
          ? 'recovery.listener.renderProcessGone'
          : s.destroy !== undefined
            ? 'recovery.listener.destroyed'
            : s.fire !== undefined
              ? String(s.fire).startsWith('dontSave:')
                ? 'recovery.timer.dontSaveHoldEnded'
                : 'recovery.timer.flushTimedOut'
              : String(s.call),
    )
  cases.forEach((c, i) => {
    if (!ops(c.args[1] as Step[]).includes(fn)) MISSING.push(`${fn} case ${i}`)
  })
  return { ts: (a, cx) => runScenario(a, cx), cases, ...(single ? { single } : {}) }
}

export const group: Group = {}

group['ipc.hwpFormatOfPath'] = {
  ts: (a) => hwpFormatOfPath(a[0] as string),
  cases: [
    '/d/a.hwp',
    '/d/a.hwpx',
    '/d/a.HWP',
    'B.HwPx',
    '/d/a.hwpxx',
    '/d/a.hwp.txt',
    '/d/a.txt.hwp',
    'hwp',
    '.hwp',
    '',
    '/d/a.hwp\n',
    '/d/\ud55c\uae00.hwpx',
    '/d/a.hwp ',
    '/d/a.hwq',
  ].map((path) => ({ args: [path] })),
}

// ---- identity, title, format ----

group['recovery.installHwpRecovery'] = fnSpec('recovery.installHwpRecovery', [
  one(
    [identity(1), { install: true }, identity(1)],
    { install: false, host: host({ '1': saved(A) }) },
    { note: 'before the install there is no identity, after it the file' },
  ),
  one(
    [onRead(1, A), { install: true }, onRead(1, A)],
    { install: false, host: host({ '1': saved(A) }) },
    {
      note: 'a read before the install settles nothing',
    },
  ),
  one(
    [begin(1), { install: true }, begin(1)],
    { install: false, host: host({ '1': saved(A) }) },
    {
      note: 'a begin before the install is refused',
    },
  ),
])

group['recovery.hwpRecoveryIdentityOf'] = fnSpec('recovery.hwpRecoveryIdentityOf', [
  one([identity(1)], { host: host({ '1': saved(A) }) }, { note: 'a file' }),
  one([identity(1), identity(1)], {}, { note: 'untitled: one uuid, the same twice' }),
  one([identity(1), identity(2)], {}, { note: 'two views, two uuids' }),
  one([identity(1)], { host: host({ '1': saved('') }) }, { note: 'an empty save path is no file' }),
  one(
    [identity(1)],
    {},
    {
      files: settings('{"hwpDefaultFormat":"hwpx"}'),
      note: 'the default format hwpx',
    },
  ),
  one(
    [identity(1)],
    {},
    {
      files: settings('{"hwpDefaultFormat":"doc"}'),
      note: 'an unknown default format is hwp',
    },
  ),
  one([identity(1)], {}, { files: settings('[1]'), note: 'settings that are an array' }),
  one([identity(1)], {}, { files: settings('{'), note: 'settings that are not JSON' }),
  one(
    [identity(1)],
    { host: host({ '1': { untitledCopy: { name: 'x.hwp', format: 'hwpx' } } }) },
    {
      files: settings('{"hwpDefaultFormat":"hwp"}'),
      note: 'the copy opened on wins over the default',
    },
  ),
  one(
    [identity(1)],
    { host: host({ '1': { untitledCopy: { name: 'x.hwpx', format: 'hwp' } } }) },
    { files: settings('{"hwpDefaultFormat":"hwpx"}'), note: 'and the other way' },
  ),
  one([identity(1)], { install: false, host: host({ '1': saved(A) }) }, { note: 'no host: null' }),
  one(
    [
      identity(1),
      setHost(1, { savePath: A }),
      identity(1),
      setHost(1, { savePath: null }),
      identity(1),
    ],
    {},
    {
      note: 'a save path set later wins, then the cached untitled identity again',
    },
  ),
])

group['recovery.hwpRecoveryIdentity'] = fnSpec('recovery.hwpRecoveryIdentity', [
  one(
    [track(1), R('hwpRecoveryIdentity', 1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a tracked view',
    },
  ),
  one(
    [R('hwpRecoveryIdentity', 1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a view that is not tracked',
    },
  ),
  one(
    [track(1), R('hwpRecoveryIdentity', 1), destroy(1), R('hwpRecoveryIdentity', 1)],
    {},
    {
      note: 'untitled, then the view is destroyed',
    },
  ),
  one(
    [track(2), R('hwpRecoveryIdentity', 1), R('hwpRecoveryIdentity', 2)],
    {},
    {
      note: 'another view is tracked',
    },
  ),
])

group['recovery.setHwpRecoveryTitle'] = fnSpec('recovery.setHwpRecoveryTitle', [
  one([R('setHwpRecoveryTitle', 1, 'My notes'), ...copyOut(1)], {}, { note: 'the tab title' }),
  one([R('setHwpRecoveryTitle', 1, '   '), ...copyOut(1)], {}, { note: 'only blanks: ignored' }),
  one([R('setHwpRecoveryTitle', 1, ''), ...copyOut(1)], {}, { note: 'empty: ignored' }),
  one(
    [R('setHwpRecoveryTitle', 1, '\ufeff\u00a0'), ...copyOut(1)],
    {},
    {
      note: 'U+FEFF and NBSP are white space to trim',
    },
  ),
  one(
    [R('setHwpRecoveryTitle', 1, '\u0085'), ...copyOut(1)],
    {},
    {
      note: 'U+0085 is not white space to trim',
    },
  ),
  one(
    [R('setHwpRecoveryTitle', 1, ' padded '), ...copyOut(1)],
    {},
    {
      note: 'the title is kept as given',
    },
  ),
  one(
    [R('setHwpRecoveryTitle', 1, 'First'), R('setHwpRecoveryTitle', 1, 'Second'), ...copyOut(1)],
    {},
    { note: 'the last one wins' },
  ),
  one(
    [R('setHwpRecoveryTitle', 1, 'Named'), ...copyOut(1)],
    { host: host({ '1': saved(A) }) },
    { note: 'a file copy is titled by its file, never by this' },
  ),
])

group['recovery.hwpRecoverySaveAsDefault'] = fnSpec('recovery.hwpRecoverySaveAsDefault', [
  one(
    [
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', untitledId: 'abc', ext: '.hwp' },
        title: 'T',
        saveAsDefaultPath: '/d/where.hwp',
      }),
      R('hwpRecoverySaveAsDefault', 1),
    ],
    {},
    { note: 'set by openUntitledCopy' },
  ),
  one([R('hwpRecoverySaveAsDefault', 1)], {}, { note: 'nothing set' }),
  one(
    [
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', untitledId: 'abc', ext: '.hwp' },
        title: 'T',
        saveAsDefaultPath: '/d/where.hwp',
      }),
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', untitledId: 'abc', ext: '.hwp' },
        title: 'T',
      }),
      R('hwpRecoverySaveAsDefault', 1),
    ],
    {},
    { note: 'a second open without one clears it' },
  ),
  one(
    [
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', untitledId: 'abc', ext: '.hwp' },
        title: 'T',
        saveAsDefaultPath: '/d/where.hwp',
      }),
      R('hwpRecoverySaveAsDefault', 1),
      ...saveDone(1),
      R('hwpRecoverySaveAsDefault', 1),
    ],
    {},
    { note: 'a save drops it' },
  ),
  one(
    [
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', untitledId: 'abc', ext: '.hwp' },
        title: 'T',
        saveAsDefaultPath: '',
      }),
      R('hwpRecoverySaveAsDefault', 1),
    ],
    {},
    { note: 'an empty suggestion is none' },
  ),
  one(
    [
      track(1),
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', untitledId: 'abc', ext: '.hwp' },
        title: 'T',
        saveAsDefaultPath: '/d/where.hwp',
      }),
      destroy(1),
      R('hwpRecoverySaveAsDefault', 1),
    ],
    {},
    { note: 'the view is destroyed' },
  ),
])

group['recovery.noteHwpPathConsumed'] = fnSpec('recovery.noteHwpPathConsumed', [
  one(
    [R('noteHwpPathConsumed', 1), decide(1, A, 'restore')],
    {},
    {
      note: 'consumed: a decision reloads the view',
    },
  ),
  one(
    [decide(1, A, 'restore'), R('noteHwpPathConsumed', 1)],
    {},
    { note: 'consumed after the decision: no reload' },
  ),
  one(
    [R('noteHwpPathConsumed', 1), setView(1, { destroyed: true }), decide(1, A, 'restore')],
    {},
    { note: 'consumed but destroyed: nothing at all' },
  ),
  one(
    [R('noteHwpPathConsumed', 2), decide(1, A, 'restore')],
    {},
    {
      note: 'another view consumed its path',
    },
  ),
  one(
    [
      track(1),
      R('noteHwpPathConsumed', 1),
      destroy(1),
      setView(1, { destroyed: null }),
      decide(1, A, 'original'),
    ],
    {},
    { note: 'the mark goes with the view' },
  ),
])

// ---- the read path ----

const ASK = { response: 0 }
group['recovery.hwpRecoveryOnRead'] = fnSpec('recovery.hwpRecoveryOnRead', [
  one([onRead(1, A)], { host: host({ '1': saved(A) }) }, { note: 'no copy: the file' }),
  one(
    [onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 0 },
    {
      files: fileCopy(A),
      note: 'a copy: asked, restore',
    },
  ),
  one(
    [onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 1 },
    {
      files: fileCopy(A),
      note: 'asked, discard: the copy goes',
    },
  ),
  one(
    [onRead(1, A)],
    { host: host({ '1': saved(A) }), response: [] },
    {
      files: fileCopy(A),
      note: 'the box answers nothing: restore',
    },
  ),
  one(
    [onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 0, lang: 'ko' },
    {
      files: fileCopy(A, { state: 'later' }),
      note: 'in Korean, a copy the user put off',
    },
  ),
  one(
    [onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 0, views: { '1': { parent: 'live' } } },
    {
      files: fileCopy(A),
      note: 'the box over the view window',
    },
  ),
  one(
    [onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 0, views: { '1': { parent: 'destroyed' } } },
    {
      files: fileCopy(A),
      note: 'the window is gone: a box without a parent',
    },
  ),
  one(
    [onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 0, focused: 'live' },
    {
      files: fileCopy(A),
      note: 'no window of its own: the focused one',
    },
  ),
  one(
    [onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 0, focused: 'destroyed' },
    {
      files: fileCopy(A),
      note: 'the focused window is gone too',
    },
  ),
  one(
    [onRead(1, A)],
    { host: host({ '1': saved(A) }) },
    {
      files: fileCopy(A, { state: 'restoreChosen', hex: HWP_B }),
      note: 'restore chosen in the launch list: no box',
    },
  ),
  one(
    [onRead(1, ORIG_PATH('a.hwp'))],
    {
      host: host({ '1': saved(ORIG_PATH('a.hwp')) }),
      response: 0,
      orig: { 'a.hwp': { text: 'x', mtimeMs: FUTURE } },
    },
    {
      files: fileCopy(ORIG_PATH('a.hwp')),
      note: 'the file is newer than the copy: the box says so',
    },
  ),
  one(
    [onRead(1, ORIG_PATH('a.hwp'))],
    {
      host: host({ '1': saved(ORIG_PATH('a.hwp')) }),
      response: 0,
      orig: { 'a.hwp': { text: 'x', mtimeMs: OLD } },
    },
    {
      files: fileCopy(ORIG_PATH('a.hwp')),
      note: 'the file is older',
    },
  ),
  one(
    [onRead(1, A)],
    { host: host({ '1': saved(A) }), headless: true, response: 0 },
    {
      files: fileCopy(A),
      note: 'headless: the file, the copy untouched',
    },
  ),
  one(
    [onRead(1, A)],
    { install: false, host: host({ '1': saved(A) }) },
    {
      files: fileCopy(A),
      note: 'no host',
    },
  ),
  one(
    [decide(1, A, 'original'), onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 0 },
    {
      files: fileCopy(A),
      note: 'the launch list chose the file',
    },
  ),
  one(
    [decide(1, A, 'restore'), onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 0 },
    {
      files: fileCopy(A, { state: 'later' }),
      note: 'the launch list chose the copy: no box, the copy is marked loaded',
    },
  ),
  one(
    [decide(1, A, 'restore'), onRead(1, A)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'the launch list chose a copy that is gone',
    },
  ),
  one(
    [decide(1, B, 'restore'), onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 0 },
    {
      files: fileCopy(A),
      note: 'a decision for another file does not count',
    },
  ),
  one(
    [onRead(1, A), onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 0 },
    {
      files: fileCopy(A),
      note: 'asked once: a reload takes the same answer',
    },
  ),
  one(
    [onRead(1, A), onRead(1, A)],
    { host: host({ '1': saved(A) }), response: 1 },
    {
      files: fileCopy(A),
      note: 'discarded once: the reload reads the file',
    },
  ),
  one(
    [onRead(1, A), onRead(2, A)],
    { host: host({ '1': saved(A), '2': saved(A) }), response: 0 },
    {
      files: fileCopy(A),
      note: 'the other pane of a split reads the file',
    },
  ),
  one(
    [onRead(1, A), onRead(2, A)],
    { host: host({ '1': saved(A), '2': saved(B) }), response: 0 },
    {
      files: merge(fileCopy(A), fileCopy(B, { hex: HWPX_A })),
      note: 'another file in the other view is asked about on its own',
    },
  ),
  one(
    [onRead(1, A), setHost(1, { savePath: B }), onRead(1, B), onRead(2, A)],
    { host: host({ '1': saved(A), '2': saved(A) }), response: 0 },
    {
      files: fileCopy(A),
      note: 'a view moved to another file frees the first one',
    },
  ),
  one(
    [onRead(1, A), dirty(1)],
    { host: host({ '1': saved(A) }), response: 0 },
    { files: fileCopy(A, { hex: HWPX_A }), note: 'a copy of other bytes' },
  ),
  one(
    [
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', untitledId: 'abc', ext: '.hwp' },
        title: 'T',
      }),
      onRead(1, '/tmp/queued.hwp'),
    ],
    {},
    {
      files: untitledCopy('abc', '.hwp'),
      note: 'an untitled copy: marked loaded, the view is dirty',
    },
  ),
  one([onRead(1, '/tmp/template.hwp')], {}, { note: 'a view without a file: the path as is' }),
  one(
    [
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', untitledId: 'abc', ext: '.hwp' },
        title: 'T',
      }),
      onRead(1, '/tmp/queued.hwp'),
    ],
    {},
    { note: 'an untitled copy whose files are gone' },
  ),
  one(
    [onRead(1, A), begin(1)],
    { host: host({ '1': saved(A) }), response: 0 },
    {
      files: fileCopy(A),
      note: 'a restored view may take copies again',
    },
  ),
  one(
    [decide(1, A, 'restore'), onRead(1, A)],
    { host: host({ '1': saved(A) }) },
    {
      files: { [`userData/hwp-autosave/${sha16(A)}.hwp`]: { dir: true } },
      note: 'a copy that cannot be read: the file, the view is not dirty',
    },
  ),
  one(
    [onRead(1, A), begin(1)],
    { host: host({ '1': saved(A) }), response: 0 },
    {
      files: { [`userData/hwp-autosave/${sha16(A)}.hwp`]: { dir: true } },
      note: 'a copy that cannot be read after asking: the file, asked once',
    },
  ),
])

const tracked = (...ids: number[]): Step[] => ids.map(track)
const NEW_PATH = '/d/renamed.hwp'
const RENAME = (id: number, from: string, to: string): Step =>
  R('hwpRecoveryFileRenamed', id, from, to)

// ---- rename, save, "Don't Save" ----

group['recovery.hwpRecoveryFileRenamed'] = fnSpec('recovery.hwpRecoveryFileRenamed', [
  one(
    [...tracked(1), ...copyOut(1), setHost(1, { savePath: NEW_PATH }), RENAME(1, A, NEW_PATH)],
    { host: host({ '1': saved(A) }) },
    { note: 'the copy moves to the new name and the view is reset' },
  ),
  one(
    [...tracked(1), setHost(1, { savePath: NEW_PATH }), RENAME(1, A, NEW_PATH)],
    { host: host({ '1': saved(A) }) },
    {
      files: fileCopy(A),
      note: 'a view that owns no copy leaves the old one',
    },
  ),
  one(
    [...tracked(1), ...copyOut(1), RENAME(1, A, NEW_PATH)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'the save path is not the new name: nothing moves',
    },
  ),
  one(
    [
      ...tracked(1),
      onRead(1, A),
      setHost(1, { savePath: NEW_PATH }),
      RENAME(1, A, NEW_PATH),
      onRead(1, NEW_PATH),
    ],
    { host: host({ '1': saved(A) }), response: 0 },
    { files: fileCopy(A), note: 'a restored copy follows, and the decision follows the name' },
  ),
  one(
    [
      ...tracked(1),
      ...copyOut(1),
      dontSave(1),
      setHost(1, { savePath: NEW_PATH }),
      RENAME(1, A, NEW_PATH),
    ],
    { host: host({ '1': saved(A) }) },
    {
      note: 'the old copy is already gone: nothing to write, the old entry is deleted, the view is reset',
    },
  ),
  one(
    [
      ...tracked(1),
      ...copyOut(1),
      setView(1, { destroyed: true }),
      setHost(1, { savePath: NEW_PATH }),
      RENAME(1, A, NEW_PATH),
    ],
    { host: host({ '1': saved(A) }) },
    { note: 'a destroyed view is not reset' },
  ),
  one(
    [decide(1, A, 'original'), onRead(1, A), RENAME(1, A, NEW_PATH), onRead(2, A)],
    { host: host({ '1': saved(A), '2': saved(A) }), response: 1 },
    {
      files: fileCopy(A),
      note: 'the loaded path follows: the other view is asked about the old name',
    },
  ),
  one(
    [decide(1, A, 'original'), onRead(1, A), RENAME(1, B, NEW_PATH), onRead(2, A)],
    { host: host({ '1': saved(A), '2': saved(A) }), response: 1 },
    {
      files: fileCopy(A),
      note: 'the rename of another file: the other view still reads as the other pane',
    },
  ),
  one(
    [...tracked(1), ...copyOut(1), setHost(1, { savePath: NEW_PATH }), RENAME(1, A, NEW_PATH)],
    { host: host({ '1': saved(A) }) },
    {
      files: { [`userData/hwp-autosave/${sha16(NEW_PATH)}.hwp`]: { dir: true } },
      note: 'the new slot cannot be written: warned, the old copy stays',
    },
  ),
  one([...tracked(1), RENAME(1, A, NEW_PATH)], { install: false }, { note: 'no host' }),
])

group['recovery.hwpRecoveryBeforeSave'] = fnSpec('recovery.hwpRecoveryBeforeSave', [
  one([R('hwpRecoveryBeforeSave', 1)], { host: host({ '1': saved(A) }) }, { note: 'a file' }),
  one(
    [R('hwpRecoveryBeforeSave', 1), R('hwpRecoveryBeforeSave', 1)],
    {},
    {
      note: 'untitled: the slot of the view, the same twice',
    },
  ),
  one([R('hwpRecoveryBeforeSave', 1)], { install: false }, { note: 'no host' }),
  one(
    [R('hwpRecoveryBeforeSave', 1)],
    { host: host({ '1': { untitledCopy: { name: 'x.hwpx', format: 'hwpx' } } }) },
    {
      note: 'untitled, from a hwpx copy',
    },
  ),
])

group['recovery.hwpRecoverySaved'] = fnSpec('recovery.hwpRecoverySaved', [
  one(
    [...tracked(1), ...copyOut(1), ...saveDone(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'the copy goes with the save',
    },
  ),
  one([...tracked(1), ...copyOut(1), ...saveDone(1)], {}, { note: 'untitled: its copy goes' }),
  one(
    [...tracked(1), ...copyOut(1), R('hwpRecoverySaved', 1, null)],
    {},
    {
      note: 'no identity from before the save: the copy stays',
    },
  ),
  one(
    [...tracked(1), ...copyOut(1), begin(1), ...saveDone(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    { note: 'a turn taken before the save is dropped' },
  ),
  one(
    [...tracked(1, 2), ...copyOut(1), ...saveDone(1)],
    { host: host({ '1': saved(A), '2': saved(A) }) },
    { note: 'the other pane is told to write again' },
  ),
  one(
    [...tracked(1, 2), ...copyOut(1), setView(2, { destroyed: true }), ...saveDone(1)],
    { host: host({ '1': saved(A), '2': saved(A) }) },
    { note: 'a destroyed other pane is left alone' },
  ),
  one(
    [...tracked(1, 2), ...copyOut(1), ...saveDone(1)],
    { host: host({ '1': saved(A), '2': saved(B) }) },
    { files: fileCopy(B, { hex: HWPX_A }), note: 'a view on another file is left alone' },
  ),
  one(
    [...tracked(1), ...copyOut(1), ...saveDone(1), identity(1), destroy(1)],
    {},
    { note: 'untitled: a new slot after the save; the destroy has nothing of its own to remove' },
  ),
  one(
    [...tracked(1), R('setHwpRecoveryTitle', 1, 'Draft'), ...saveDone(1), ...copyOut(1)],
    {},
    { note: 'the title is forgotten with the save' },
  ),
  one(
    [R('hwpRecoverySaved', 1, { kind: 'hwp', filePath: B })],
    { host: host({ '1': saved(A) }) },
    { files: fileCopy(B, { hex: HWPX_A }), note: 'the copy of the identity given goes' },
  ),
  one(
    [...tracked(1), ...copyOut(1), ...saveDone(1)],
    { host: host({ '1': saved(A) }), shuttingDown: true },
    { note: 'a save removes its copy also while the app is ending' },
  ),
])

group['recovery.hwpRecoveryDontSave'] = fnSpec('recovery.hwpRecoveryDontSave', [
  one(
    [...tracked(1), ...copyOut(1), dontSave(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'the copy goes, the hold timer is set',
    },
  ),
  one([...tracked(1), ...copyOut(1), dontSave(1)], {}, { note: 'untitled' }),
  one(
    [...tracked(1), ...copyOut(1), dontSave(1), dontSave(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'twice: the timer is cleared and set again',
    },
  ),
  one(
    [...tracked(1), begin(1), dontSave(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a turn taken before is dropped',
    },
  ),
  one(
    [...tracked(1), dontSave(1), begin(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'no copy while the tab closes',
    },
  ),
  one(
    [
      ...tracked(1, 2),
      ...copyOut(1),
      begin(2),
      dontSave(1),
      write(2, HWP_B, 'hwp'),
      begin(2),
      write(2, HWP_B, 'hwp'),
    ],
    { host: host({ '1': saved(A), '2': saved(A) }) },
    { note: 'the other pane is reset, its copies go on' },
  ),
  one(
    [...tracked(1, 2), ...copyOut(1), dontSave(1)],
    { host: host({ '1': saved(A), '2': saved(B) }) },
    { files: fileCopy(B, { hex: HWPX_A }), note: 'a view on another file is left alone' },
  ),
  one([...tracked(1), dontSave(1)], { install: false }, { note: 'no host: the timer only' }),
  one(
    [...tracked(1), dontSave(1)],
    { host: host({ '1': saved(A) }), shuttingDown: true },
    { files: fileCopy(A), note: 'while the app is ending the copy still goes' },
  ),
])

group['recovery.timer.dontSaveHoldEnded'] = fnSpec('recovery.timer.dontSaveHoldEnded', [
  one(
    [...tracked(1), dontSave(1), fire('dontSave:1'), begin(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'the hold ends: the view is reset and takes copies again',
    },
  ),
  one(
    [...tracked(1), dontSave(1), setView(1, { destroyed: true }), fire('dontSave:1')],
    {},
    { note: 'a destroyed view is not reset' },
  ),
  one([fire('dontSave:1')], {}, { note: 'no timer' }),
  one(
    [...tracked(1), dontSave(1), destroy(1), fire('dontSave:1')],
    {},
    { note: 'cleared by the destroy' },
  ),
  one(
    [...tracked(1), dontSave(1), dontSave(1), fire('dontSave:1'), fire('dontSave:1')],
    {},
    { note: 'one timer after two calls, fired once' },
  ),
  one(
    [...tracked(1, 2), dontSave(1), dontSave(2), fire('dontSave:2')],
    {},
    {
      note: 'a timer per view',
    },
  ),
])

group['recovery.trackHwpRecovery'] = fnSpec('recovery.trackHwpRecovery', [
  one(
    [track(1), CT('writeCopiesNow')],
    { host: host({ '1': saved(A, { dirty: true }) }) },
    {
      note: 'a tracked dirty view is flushed',
    },
  ),
  one(
    [track(2), CT('writeCopiesNow')],
    { host: host({ '1': saved(A, { dirty: true }) }) },
    {
      note: 'one that is not tracked is not (another is)',
    },
  ),
  one(
    [track(1), R('hwpRecoveryIdentity', 1)],
    { host: host({ '1': saved(A) }) },
    { note: 'its identity is known' },
  ),
  one(
    [track(1), track(1), CT('writeCopiesNow')],
    { host: host({ '1': saved(A, { dirty: true }) }) },
    {
      note: 'tracked twice, flushed once',
    },
  ),
  one(
    [track(2), track(1), CT('writeCopiesNow')],
    { host: host({ '1': { dirty: true }, '2': { dirty: true } }) },
    {
      note: 'the flush follows the order of tracking',
    },
  ),
])

group['recovery.listener.renderProcessGone'] = fnSpec('recovery.listener.renderProcessGone', [
  one(
    [track(1), ...copyOut(1), gone(1), destroy(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a crashed view leaves its copy for the reopened tab',
    },
  ),
  one(
    [track(1), ...copyOut(1), gone(2), destroy(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a clean close removes it, whatever another view did',
    },
  ),
  one(
    [gone(1), track(1), ...copyOut(1), destroy(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a crash before the tracking is not seen',
    },
  ),
  one(
    [track(1), ...copyOut(1), gone(1), gone(1), destroy(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'gone twice',
    },
  ),
])

group['recovery.listener.destroyed'] = fnSpec('recovery.listener.destroyed', [
  one(
    [track(1), ...copyOut(1), destroy(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'closed with nothing unsaved: the copy goes',
    },
  ),
  one(
    [track(1), ...copyOut(1), dirty(1), destroy(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'unsaved changes: the copy stays',
    },
  ),
  one(
    [track(1), ...copyOut(1), gone(1), destroy(1)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'crashed: the copy stays',
    },
  ),
  one(
    [track(1), ...copyOut(1), destroy(1)],
    { host: host({ '1': saved(A) }), shuttingDown: true },
    {
      note: 'while the app is ending a clean close keeps the copy',
    },
  ),
  one(
    [track(1), destroy(1)],
    { host: host({ '1': saved(A) }) },
    {
      files: fileCopy(A),
      note: 'a view that wrote no copy leaves one alone',
    },
  ),
  one(
    [track(1), dontSave(1), setHost(1, { savePath: A }), destroy(1)],
    { shuttingDown: true },
    {
      files: fileCopy(A),
      note: 'a copy that landed while the tab closed goes, also while the app ends',
    },
  ),
  one([track(1), ...copyOut(1), destroy(1)], {}, { note: 'untitled: its copy goes' }),
  one(
    [track(1), ...copyOut(1), dirty(1), destroy(1)],
    {},
    { note: 'untitled with unsaved changes' },
  ),
  one(
    [...tracked(1, 2), ...copyOut(1), destroy(1)],
    { host: host({ '1': saved(A), '2': saved(A) }) },
    { note: 'the other pane is told to write again' },
  ),
  one(
    [...tracked(1, 2), ...copyOut(1), dontSave(1), setView(1, { destroyed: null }), destroy(1)],
    { host: host({ '1': saved(A), '2': saved(A) }) },
    { note: 'a view closed after "Don\'t Save": its timer is cleared' },
  ),
  one(
    [track(1), dontSave(1), destroy(1), destroy(1), fire('dontSave:1')],
    { host: host({ '1': saved(A) }) },
    { note: 'a second destroy and a late timer do nothing' },
  ),
  one(
    [
      track(1),
      opened(1),
      R('hwpRecoverySaveAsDefault', 1),
      destroy(1),
      CT('isUnprotectable', 1),
      opened(1, false),
    ],
    { host: host({ '1': saved(A) }) },
    { note: 'the tables are cleaned: the protection mark is gone' },
  ),
  one(
    [
      track(1),
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', untitledId: 'abc', ext: '.hwp' },
        title: 'T',
      }),
      destroy(1),
      identity(1),
    ],
    {},
    { files: untitledCopy('abc', '.hwp'), note: 'the untitled slot is forgotten with the view' },
  ),
  one(
    [
      track(1),
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', untitledId: 'abc', ext: '.hwp' },
        title: 'T',
      }),
      onRead(1, '/tmp/q.hwp'),
      destroy(1),
    ],
    {},
    { files: untitledCopy('abc', '.hwp'), note: 'a loaded untitled copy closed clean goes' },
  ),
])

// ---- the renderer's channels ----

group['recovery.ipc.recoveryBegin'] = fnSpec('recovery.ipc.recoveryBegin', [
  one([begin(1)], { host: host({ '1': saved(A) }) }, { note: 'a hwp file' }),
  one([begin(1)], { host: host({ '1': saved(B) }) }, { note: 'a hwpx file' }),
  one([begin(1)], { host: host({ '1': saved('/d/UP.HWPX') }) }, { note: 'a capital extension' }),
  one([begin(1)], { host: host({ '1': saved(C) }) }, { note: 'another extension: hwp' }),
  one(
    [begin(1)],
    { host: host({ '1': saved(C, { untitledCopy: { name: 'c.hwpx', format: 'hwpx' } }) }) },
    {
      note: 'another extension: the format of the copy it was opened on',
    },
  ),
  one([begin(1)], {}, { note: 'untitled: hwp' }),
  one(
    [begin(1)],
    {},
    { files: settings('{"hwpDefaultFormat":"hwpx"}'), note: 'untitled: the default hwpx' },
  ),
  one([begin(1)], { headless: true, host: host({ '1': saved(A) }) }, { note: 'headless: no copy' }),
  one(
    [opened(1), begin(1)],
    { host: host({ '1': saved(A) }) },
    { note: 'a protected document: no copy' },
  ),
  one(
    [dontSave(1), begin(1)],
    { host: host({ '1': saved(A) }) },
    { note: 'after "Don\'t Save": no copy' },
  ),
  one([begin(1)], { install: false }, { note: 'no host' }),
  one(
    [begin(1), begin(2)],
    { host: host({ '1': saved(A), '2': saved(A) }) },
    { note: 'two views on a file' },
  ),
  one(
    [...tracked(1), dontSave(1), fire('dontSave:1'), begin(1)],
    { host: host({ '1': saved(A) }) },
    { note: 'taken again after the hold ends' },
  ),
  one(
    [begin(1), setView(1, { destroyed: true }), begin(1)],
    { host: host({ '1': saved(A) }) },
    { note: 'a destroyed view still gets a ticket (the write refuses it)' },
  ),
])

group['recovery.ipc.recoveryNewTabs'] = fnSpec('recovery.ipc.recoveryNewTabs', [
  one(
    [IPC('recoveryNewTabs', 1, { hex: HWPX_TAB }, 'hwpx')],
    { host: host({ '1': saved(B) }) },
    {
      note: 'no turn: nothing',
    },
  ),
  one(
    [begin(1), IPC('recoveryNewTabs', 1, { hex: HWPX_TAB }, 'hwpx')],
    { host: host({ '1': saved(B) }) },
    {
      note: 'a hwpx with a tab without values',
    },
  ),
  one(
    [
      begin(1),
      IPC('recoveryNewTabs', 1, { hex: HWPX_TAB }, 'hwpx'),
      IPC('recoveryNewTabs', 1, { hex: HWPX_TAB }, 'hwpx'),
    ],
    { host: host({ '1': saved(B) }) },
    { note: 'the turn is kept: the same answer twice' },
  ),
  one(
    [begin(1), IPC('recoveryNewTabs', 1, { hex: HWP_A }, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a hwp that holds nothing',
    },
  ),
  one(
    [begin(1), IPC('recoveryNewTabs', 1, { hex: HWP_A }, 'hwpx')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'bytes of the other format',
    },
  ),
  one(
    [begin(1), IPC('recoveryNewTabs', 1, { hex: HWPX_TAB }, 'hwp')],
    { host: host({ '1': saved(B) }) },
    {
      note: 'a zip given as hwp',
    },
  ),
  one(
    [begin(1), IPC('recoveryNewTabs', 1, 'text', 'hwpx')],
    { host: host({ '1': saved(B) }) },
    {
      note: 'not bytes',
    },
  ),
  one(
    [begin(1), IPC('recoveryNewTabs', 1, { hex: '' }, 'hwpx')],
    { host: host({ '1': saved(B) }) },
    {
      note: 'empty bytes',
    },
  ),
  one(
    [begin(1), IPC('recoveryNewTabs', 1, { hex: HWPX_TAB }, 7)],
    { host: host({ '1': saved(B) }) },
    {
      note: 'a format that is no string',
    },
  ),
  one(
    [begin(1), IPC('recoveryNewTabs', 1, { hex: HWPX_TAB }, 'odt')],
    { host: host({ '1': saved(B) }) },
    {
      note: 'a format that is neither',
    },
  ),
  one(
    [begin(1), IPC('recoveryNewTabs', 1, null, null)],
    { host: host({ '1': saved(B) }) },
    {
      note: 'no arguments',
    },
  ),
  one(
    [begin(1), IPC('recoveryNewTabs', 2, { hex: HWPX_TAB }, 'hwpx')],
    { host: host({ '1': saved(B) }) },
    {
      note: 'the turn of another view',
    },
  ),
  one(
    [begin(1), write(1, HWPX_TAB, 'hwpx'), IPC('recoveryNewTabs', 1, { hex: HWPX_TAB }, 'hwpx')],
    { host: host({ '1': saved(B) }) },
    {
      note: 'a write took the turn',
    },
  ),
])

const TABS = [{ sec: 0, para: 0, cells: [], tab: 0, tabs: 1, width: 1000, fill: 0, type: 0 }]
group['recovery.ipc.recoveryWrite'] = fnSpec('recovery.ipc.recoveryWrite', [
  one([...copyOut(1)], { host: host({ '1': saved(A) }) }, { note: 'written: a file copy' }),
  one([...copyOut(1, HWPX_A, 'hwpx')], { host: host({ '1': saved(B) }) }, { note: 'a hwpx copy' }),
  one([...copyOut(1)], {}, { note: 'an untitled copy, titled' }),
  one([...copyOut(1)], { lang: 'ko' }, { note: 'an untitled copy titled in Korean' }),
  one([write(1, HWP_A, 'hwp')], { host: host({ '1': saved(A) }) }, { note: 'no turn: superseded' }),
  one(
    [begin(1), write(1, HWP_A, 'hwp'), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a turn serves one write',
    },
  ),
  one(
    [begin(1), write(1, HWPX_A, 'hwpx')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'another format than the turn: refused',
    },
  ),
  one(
    [begin(1), write(1, HWPX_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'bytes that are not the format: refused',
    },
  ),
  one([begin(1), write(1, '', 'hwp')], { host: host({ '1': saved(A) }) }, { note: 'empty bytes' }),
  one([begin(1), write(1, null, 'hwp')], { host: host({ '1': saved(A) }) }, { note: 'not bytes' }),
  one(
    [begin(1), write(1, OLE.slice(0, 14), 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'one byte short of the magic',
    },
  ),
  one(
    [begin(1), write(1, HWP_A, 'rtf')],
    { host: host({ '1': saved(A) }) },
    { note: 'a format that is neither' },
  ),
  one(
    [begin(1), write(1, HWP_A, 5)],
    { host: host({ '1': saved(A) }) },
    { note: 'a format that is no string' },
  ),
  one(
    [begin(1), setView(1, { destroyed: true }), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a destroyed sender',
    },
  ),
  one(
    [begin(1), world_({ headless: true }), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'headless by the time it lands',
    },
  ),
  one(
    [begin(1), opened(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'protected since the turn began',
    },
  ),
  one(
    [begin(1), dontSave(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'after "Don\'t Save"',
    },
  ),
  one(
    [begin(1), setHost(1, { savePath: B }), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'Save As moved the document: superseded',
    },
  ),
  one(
    [begin(1), setHost(1, { savePath: null }), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'the file is gone from the view: another slot, superseded',
    },
  ),
  one(
    [begin(1), ...saveDone(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a save that landed meanwhile wins',
    },
  ),
  one(
    [begin(1), begin(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a second begin replaces the ticket',
    },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp', [])],
    { host: host({ '1': saved(A) }) },
    { note: 'tabs: an empty list' },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp', TABS)],
    { host: host({ '1': saved(A) }) },
    {
      note: 'tabs: measured ones that find no place in the bytes',
    },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp', 'tabs')],
    { host: host({ '1': saved(A) }) },
    { note: 'tabs that are no list' },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A, { untitledCopy: { name: 'z.hwp', format: 'hwp' } }) }) },
    { files: fileCopy(A, { hex: HWP_B }), note: 'the copy replaces the one an earlier run left' },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': { untitledCopy: { name: 'Letter.HWP', format: 'hwp' } } }) },
    { note: 'untitled, titled by the name of its copy without the extension' },
  ),
  one(
    [begin(1), write(1, HWPX_A, 'hwpx')],
    { host: host({ '1': { untitledCopy: { name: 'a.hwp.hwpx', format: 'hwpx' } } }) },
    { note: 'only the last extension goes' },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': { untitledCopy: { name: '.hwp', format: 'hwp' } } }) },
    { note: 'a name that is only an extension is kept whole' },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': { untitledCopy: { name: 'plain', format: 'hwp' } } }) },
    { note: 'a name without an extension' },
  ),
  one(
    [R('setHwpRecoveryTitle', 1, 'Tab title'), begin(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': { untitledCopy: { name: 'z.hwp', format: 'hwp' } } }) },
    { note: 'the tab title wins over the copy name' },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved('/d/\ud55c\uae00 \ubb38\uc11c.hwp') }) },
    {
      note: 'a file with a Hangul name',
    },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(C) }) },
    {
      note: 'a file that is no hwp: the copy keeps its extension, the format is hwp',
    },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      files: { 'userData/hwp-autosave': 'in the way' },
      note: 'the store folder is a file: the write fails, the view takes nothing',
    },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      files: { [`userData/hwp-autosave/${sha16(A)}.hwp`]: { dir: true } },
      note: 'the copy is a folder: the write fails',
    },
  ),
  one(
    [begin(1), write(1, HWP_A, 'hwp'), begin(1), write(1, HWP_B, 'hwp')],
    { host: host({ '1': saved(A) }) },
    {
      note: 'a later copy replaces the earlier',
    },
  ),
])

group['recovery.ipc.recoveryOpened'] = fnSpec('recovery.ipc.recoveryOpened', [
  one([opened(1, false)], {}, { note: 'nothing special' }),
  one([opened(1, true)], {}, { note: 'protected: the notice' }),
  one([opened(1, true), opened(1, true)], {}, { note: 'the notice only once' }),
  one([opened(1, true)], { lang: 'ko' }, { note: 'in Korean' }),
  one([opened(1, 1), opened(1, 'true'), opened(1, null)], {}, { note: 'only `true` protects' }),
  one([opened(1, true), opened(2, true)], {}, { note: 'a notice per view' }),
  one(
    [onRead(1, A), opened(1, false)],
    { host: host({ '1': saved(A) }), response: 0 },
    { files: fileCopy(A), note: 'a restored copy is reported' },
  ),
  one(
    [onRead(1, A), opened(1, false)],
    { host: host({ '1': saved(A) }), response: 1 },
    { files: fileCopy(A), note: 'a discarded copy is not' },
  ),
  one(
    [opened(1, false), opened(1, true), opened(1, false)],
    {},
    { note: 'protection is not undone' },
  ),
])

group['recovery.ipc.recoveryFlushed'] = fnSpec('recovery.ipc.recoveryFlushed', [
  one(
    [...tracked(1), CT('writeCopiesNow'), IPC('recoveryFlushed', 0, 1)],
    { host: host({ '1': { dirty: true } }) },
    {
      note: 'the token of a flush: its timer is cleared',
    },
  ),
  one(
    [...tracked(1), CT('writeCopiesNow'), IPC('recoveryFlushed', 0, 2)],
    { host: host({ '1': { dirty: true } }) },
    {
      note: 'a token nobody waits for',
    },
  ),
  one(
    [...tracked(1), CT('writeCopiesNow'), IPC('recoveryFlushed', 0, '1')],
    { host: host({ '1': { dirty: true } }) },
    {
      note: 'a token that is a string',
    },
  ),
  one(
    [...tracked(1), CT('writeCopiesNow'), IPC('recoveryFlushed', 0, 1.5)],
    { host: host({ '1': { dirty: true } }) },
    {
      note: 'a token that is no integer',
    },
  ),
  one(
    [
      ...tracked(1),
      CT('writeCopiesNow'),
      IPC('recoveryFlushed', 0, 1),
      IPC('recoveryFlushed', 0, 1),
    ],
    { host: host({ '1': { dirty: true } }) },
    { note: 'a token settles once' },
  ),
  one(
    [...tracked(1, 2), CT('writeCopiesNow'), IPC('recoveryFlushed', 0, 2)],
    { host: host({ '1': { dirty: true }, '2': { dirty: true } }) },
    { note: 'one of two flushes settled' },
  ),
  one(
    [
      ...tracked(1, 2),
      CT('writeCopiesNow'),
      IPC('recoveryFlushed', 0, 2),
      IPC('recoveryFlushed', 0, 1),
    ],
    { host: host({ '1': { dirty: true }, '2': { dirty: true } }) },
    { note: 'both settled, in the other order' },
  ),
  one(
    [
      ...tracked(1),
      CT('writeCopiesNow'),
      IPC('recoveryFlushed', 0, -1),
      IPC('recoveryFlushed', 0, 1e300),
      IPC('recoveryFlushed', 0, null),
    ],
    { host: host({ '1': { dirty: true } }) },
    {
      note: 'tokens that no flush gave',
    },
  ),
  one(
    [...tracked(1), CT('writeCopiesNow'), fire('flush:1'), IPC('recoveryFlushed', 0, 1)],
    { host: host({ '1': { dirty: true } }) },
    {
      note: 'after the timeout the token is gone',
    },
  ),
])

group['recovery.timer.flushTimedOut'] = fnSpec('recovery.timer.flushTimedOut', [
  one(
    [...tracked(1), CT('writeCopiesNow'), fire('flush:1')],
    { host: host({ '1': { dirty: true } }) },
    {
      note: 'the flush gives up: settled, no clear',
    },
  ),
  one([fire('flush:1')], {}, { note: 'no timer' }),
  one(
    [...tracked(1), CT('writeCopiesNow'), IPC('recoveryFlushed', 0, 1), fire('flush:1')],
    { host: host({ '1': { dirty: true } }) },
    { note: 'the timer was cleared by the answer' },
  ),
  one(
    [...tracked(1, 2), CT('writeCopiesNow'), fire('flush:2')],
    { host: host({ '1': { dirty: true }, '2': { dirty: true } }) },
    { note: 'one of two timed out' },
  ),
  one(
    [...tracked(1, 2), CT('writeCopiesNow'), fire('flush:2'), fire('flush:1')],
    { host: host({ '1': { dirty: true }, '2': { dirty: true } }) },
    { note: 'both timed out' },
  ),
  one(
    [...tracked(1), CT('writeCopiesNow'), fire('flush:1'), CT('writeCopiesNow'), fire('flush:2')],
    { host: host({ '1': { dirty: true } }) },
    { note: 'a second flush gets the next token' },
  ),
])

// ---- the contract ----

group['recovery.contract.writeCopiesNow'] = fnSpec('recovery.contract.writeCopiesNow', [
  one(
    [...tracked(1, 2), CT('writeCopiesNow')],
    { host: host({ '1': { dirty: true }, '2': { dirty: true } }) },
    {
      note: 'two dirty views: a flush each, waited for',
    },
  ),
  one(
    [...tracked(1), CT('writeCopiesNow')],
    { host: host({ '1': saved(A) }) },
    { note: 'nothing dirty: done at once' },
  ),
  one(
    [...tracked(1, 2), CT('writeCopiesNow')],
    {
      host: host({ '1': { dirty: true }, '2': { dirty: true } }),
      views: { '1': { destroyed: true } },
    },
    { note: 'a destroyed view is skipped' },
  ),
  one(
    [...tracked(1), opened(1), CT('writeCopiesNow')],
    { host: host({ '1': { dirty: true } }) },
    {
      note: 'a protected view is skipped',
    },
  ),
  one(
    [...tracked(1), CT('writeCopiesNow')],
    { host: host({ '1': { dirty: true } }), headless: true },
    {
      note: 'headless: none',
    },
  ),
  one(
    [...tracked(1), dontSave(1), CT('writeCopiesNow')],
    { host: host({ '1': { dirty: true } }) },
    {
      note: 'after "Don\'t Save": skipped',
    },
  ),
  one(
    [...tracked(1, 2), CT('writeCopiesNow')],
    {
      host: host({ '1': { dirty: true }, '2': { dirty: true } }),
      views: { '1': { flushThrows: true } },
    },
    { note: 'a view that cannot take the flush is settled at once' },
  ),
  one(
    [CT('writeCopiesNow')],
    { host: host({ '1': { dirty: true } }) },
    { note: 'no view is tracked' },
  ),
  one(
    [...tracked(1), CT('writeCopiesNow')],
    { install: false, host: host({ '1': { dirty: true } }) },
    {
      note: 'no host: nothing is due',
    },
  ),
  one(
    [...tracked(1), CT('writeCopiesNow'), IPC('recoveryFlushed', 0, 1), CT('writeCopiesNow')],
    { host: host({ '1': { dirty: true } }) },
    { note: 'a second flush gets the next token' },
  ),
  one(
    [...tracked(1), CT('writeCopiesNow'), setHost(1, { dirty: false }), CT('writeCopiesNow')],
    { host: host({ '1': { dirty: true } }) },
    { note: 'the view was saved meanwhile' },
  ),
])

group['recovery.contract.openFileWithDecision'] = fnSpec('recovery.contract.openFileWithDecision', [
  one([decide(1, A, 'restore')], {}, { note: 'a path the view does not have: queued' }),
  one(
    [decide(1, A, 'original')],
    { host: host({ '1': { openPath: A } }) },
    {
      note: 'the path is queued already: not again',
    },
  ),
  one(
    [decide(1, A, 'restore')],
    { host: host({ '1': { openPath: B } }) },
    { note: 'another path queued' },
  ),
  one(
    [decide(1, A, 'restore')],
    { views: { '1': { destroyed: true } } },
    { note: 'a destroyed view' },
  ),
  one([decide(1, A, 'restore')], { install: false }, { note: 'no host' }),
  one(
    [R('noteHwpPathConsumed', 1), decide(1, A, 'restore')],
    {},
    { note: 'the renderer has its path: reload' },
  ),
  one(
    [R('noteHwpPathConsumed', 1), decide(1, A, 'restore')],
    { host: host({ '1': { openPath: A } }) },
    {
      note: 'the same path, but the view already read it: reload only',
    },
  ),
  one(
    [decide(1, A, 'restore'), onRead(1, A)],
    {},
    {
      files: fileCopy(A, { state: 'later' }),
      note: 'the decision is used by the read: no box',
    },
  ),
  one(
    [decide(1, A, 'original'), onRead(1, A)],
    { response: 0 },
    {
      files: fileCopy(A),
      note: 'the decision to keep the file',
    },
  ),
])

const UNTITLED = { kind: 'hwp', untitledId: 'abc', ext: '.hwp' }
group['recovery.contract.openUntitledCopy'] = fnSpec('recovery.contract.openUntitledCopy', [
  one(
    [CT('openUntitledCopy', 1, { copy: UNTITLED, title: 'Draft' }), identity(1)],
    {},
    {
      note: 'an untitled hwp copy: queued as Draft.hwp',
    },
  ),
  one(
    [
      CT('openUntitledCopy', 1, { copy: { ...UNTITLED, ext: '.hwpx' }, title: 'Draft' }),
      identity(1),
    ],
    {},
    {
      note: 'a hwpx copy',
    },
  ),
  one(
    [
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', filePath: '/d/Up.HWPX' },
        title: 'Up',
        saveAsDefaultPath: '/d/Up.hwpx',
      }),
    ],
    {},
    { note: "a file copy whose original is missing: the copy path's extension, lower-cased" },
  ),
  one(
    [CT('openUntitledCopy', 1, { copy: { kind: 'hwp', filePath: C }, title: 'Plain' })],
    {},
    {
      note: 'a file copy that is no hwp: format hwp',
    },
  ),
  one([CT('openUntitledCopy', 1, { copy: UNTITLED, title: '' })], {}, { note: 'an empty title' }),
  one(
    [CT('openUntitledCopy', 1, { copy: UNTITLED, title: 'Draft' })],
    { views: { '1': { destroyed: true } } },
    {
      note: 'a destroyed view',
    },
  ),
  one(
    [CT('openUntitledCopy', 1, { copy: UNTITLED, title: 'Draft' })],
    { install: false },
    { note: 'no host' },
  ),
  one(
    [R('noteHwpPathConsumed', 1), CT('openUntitledCopy', 1, { copy: UNTITLED, title: 'Draft' })],
    {},
    {
      note: 'the renderer has its path: reload',
    },
  ),
  one(
    [
      CT('openUntitledCopy', 1, { copy: UNTITLED, title: 'Draft' }),
      begin(1),
      write(1, HWP_B, 'hwp'),
    ],
    {},
    {
      files: untitledCopy('abc', '.hwp'),
      note: 'the next copies go to the same slot, titled Draft',
    },
  ),
  one(
    [
      CT('openUntitledCopy', 1, {
        copy: { kind: 'hwp', untitledId: 'bad/id', ext: '.hwp' },
        title: 'Draft',
      }),
    ],
    {},
    { note: 'an id the store refuses: the TypeScript throws, the Rust warns and does nothing' },
  ),
])

group['recovery.contract.isUnprotectable'] = fnSpec('recovery.contract.isUnprotectable', [
  one([CT('isUnprotectable', 1)], {}, { note: 'nothing known' }),
  one([opened(1), CT('isUnprotectable', 1)], {}, { note: 'protected' }),
  one([opened(1), CT('isUnprotectable', 2)], {}, { note: 'another view' }),
  one([opened(1, false), CT('isUnprotectable', 1)], {}, { note: 'opened unprotected' }),
  one(
    [track(1), opened(1), destroy(1), CT('isUnprotectable', 1)],
    {},
    { note: 'the mark goes with the view' },
  ),
])

function world_(changes: Record<string, unknown>): Step {
  return { world: changes }
}

function ORIG_PATH(name: string): string {
  return join(ORIG, name)
}

if (MISSING.length > 0)
  throw new Error(`cases that play none of their function: ${MISSING.join(', ')}`)
