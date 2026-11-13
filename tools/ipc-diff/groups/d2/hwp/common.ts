/**
 * What the hwp groups share (not a group): the case's `hosts.d2.hwp` answers
 * read as `crates/shell-ipc/d2/src/hwp/mod.rs`'s fakes read them, the process
 * state the Hangul modules read (UI language, headless mode, the clock, the
 * recovery store's run id), and the swap of the libraries the Rust side puts
 * behind `HwpEngine` for fake modules beside the group.
 *
 * The app compiles to CommonJS under tsx: its modules (and the packages they
 * require) sit in `require.cache`, which `cx.fresh` does not reach. Each case
 * drops the app's own modules from that cache, so their module state
 * (`ipcRegistered`, the recovery maps) starts over as `cx.fresh` intends.
 */
import { createRequire, registerHooks } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type * as ElectronUtils from '@seuoffice/electron-utils'
import type * as I18n from '@seuoffice/i18n'
import type { LoadContext } from '../../../types.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const APP = `${root}/apps/hwp/src/main/`

/** `require` as the Hangul main modules resolve it: their instance of a package */
export const appRequire = createRequire(`${APP}hwp-main.ts`)

/**
 * `NOW_MS` of the Rust fakes (2026-01-01 UTC): `Date.now()` of a case that
 * does not set `now_ms`
 */
export const NOW_MS = 1_767_225_600_000

/** `case[method]`, consumed in order, the last one repeating (Answers in mod.rs) */
export class Answers {
  private readonly map: Record<string, unknown>
  constructor(hosts: unknown) {
    this.map = { ...((hosts ?? {}) as Record<string, unknown>) }
  }
  next(method: string): unknown {
    const v = this.map[method]
    if (v === undefined) return undefined
    if (Array.isArray(v)) return v.length > 1 ? v.shift() : v[0]
    return v
  }
}

/** the case's `hosts.d2.hwp` */
export function hwpHosts(cx: LoadContext): Record<string, unknown> {
  const d2 = (cx.case.hosts?.d2 ?? {}) as Record<string, unknown>
  return (d2.hwp ?? {}) as Record<string, unknown>
}

/** What the case's fakes answer and log; set by `setUpCase`, read by the fake modules */
export interface HwpWorld {
  answers: Answers
  log: unknown[]
  uuid: number
}

const WORLD = Symbol.for('ipc-diff.d2.hwp.world')
export function world(): HwpWorld {
  return (globalThis as unknown as Record<symbol, HwpWorld>)[WORLD]
}

/**
 * The process state of one case, as the Rust fakes answer it: the UI
 * language, headless mode, the clock, a fresh recovery store state with the
 * probe's run id, crypto's UUIDs where the recovery store takes them. Drops
 * the app's modules from the require cache.
 */
export function setUpCase(cx: LoadContext): HwpWorld {
  const answers = new Answers(hwpHosts(cx))
  const w: HwpWorld = { answers, log: cx.electron.log, uuid: 0 }
  ;(globalThis as unknown as Record<symbol, HwpWorld>)[WORLD] = w
  const lang = answers.next('ui_lang')
  const i18n = appRequire('@seuoffice/i18n') as typeof I18n
  i18n.setUiLang(i18n.normalizeLang(typeof lang === 'string' ? lang : 'en'))
  const utils = appRequire('@seuoffice/electron-utils') as typeof ElectronUtils
  utils.setHeadlessMode(answers.next('is_headless_mode') === true)
  const now = answers.next('now_ms')
  Date.now = () => (typeof now === 'number' ? now : NOW_MS)
  const shared = ((cx.case.hosts ?? {}).shared ?? {}) as Record<string, unknown>
  ;(globalThis as unknown as Record<symbol, unknown>)[
    Symbol.for('seuoffice.recovery-store.shared')
  ] = {
    shuttingDown: false,
    epochs: new Map(),
    queues: new Map(),
    runId: typeof shared.recoveryRunId === 'string' ? shared.recoveryRunId : '0000000000000000',
    discarded: new Set(),
  }
  for (const key of Object.keys(appRequire.cache)) {
    if (key.startsWith(APP)) delete appRequire.cache[key]
  }
  return w
}

/** `00000000-0000-4000-8000-000000000001`, ... as FakeShell::random_uuid */
export function nextUuid(): string {
  const w = world()
  w.uuid++
  return `00000000-0000-4000-8000-${String(w.uuid).padStart(12, '0')}`
}

/**
 * Resolves `specifier` to a fake file when it is imported by a module whose
 * path contains `from` (or by any module when `from` is empty). The fake is a
 * file, not a `data:` URL: the CommonJS loader reads what it resolves.
 */
export function swap(table: { specifier: string; from: string; fake: string }[]): void {
  registerHooks({
    resolve(specifier, context, next) {
      const parent = context.parentURL ?? ''
      const hit = table.find((t) => t.specifier === specifier && parent.includes(t.from))
      if (hit) return { url: pathToFileURL(hit.fake).href, shortCircuit: true }
      return next(specifier, context)
    },
  })
}

/** a file in groups/d2/hwp/, beside this one */
export const here = (name: string): string => resolve(dirname(fileURLToPath(import.meta.url)), name)
