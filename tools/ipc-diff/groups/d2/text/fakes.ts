/**
 * What the two text editors' groups (`d2/html`, `d2/markdown`) share: the
 * case's answers, read the way the Rust fakes read them
 * (`crates/shell-ipc/d2/src/html/fake.rs`, `Answers`), the process state the
 * shell gives an editor (headless mode, the UI language, the clock, the
 * split-pane probe, the open-files source, the recovery store's run id), the
 * Electron objects the editors' entry modules use beyond the case's, and the
 * engine modules the Rust side puts behind its host traits, replaced for the
 * group by a module hook (`html-fakes.ts`, `markdown-fakes.ts` are those
 * modules).
 */
import { readFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type * as ElectronUtils from '@seuoffice/electron-utils'
import type * as I18n from '@seuoffice/i18n'
import type { Call, Group, LoadContext, TriggerContext } from '../../../types.ts'
import { inert, withInert } from '../../w/shell-index.ts'

/**
 * The packages as the editors' entry modules load them: they are CommonJS
 * under tsx, and their `require` gets module instances of its own, apart from
 * this file's `import`; the process state must be set on theirs
 */
const editorRequire = createRequire(new URL('../../../../../apps/html/src/main/', import.meta.url))
const { setHeadlessMode, setOpenFilesSource, setOpenPathProbe } = editorRequire(
  '@seuoffice/electron-utils',
) as typeof ElectronUtils
const { setUiLang } = editorRequire('@seuoffice/i18n') as typeof I18n

/** the case's answers by method name, as the Rust fakes' `Answers` */
export class Answers {
  private readonly queued = new Map<string, unknown[]>()
  readonly taken = new Set<number>()

  constructor(
    readonly c: Record<string, unknown>,
    readonly log: unknown[],
  ) {
    for (const [k, v] of Object.entries(c)) this.queued.set(k, Array.isArray(v) ? [...v] : [v])
  }

  has(key: string): boolean {
    return key in this.c
  }

  /** whether `path` is in the case's list under `key` */
  listed(key: string, path: string): boolean {
    const list = this.c[key]
    return Array.isArray(list) && list.includes(path)
  }

  /** an array is consumed one item per call, its last item repeats */
  answer(method: string): unknown {
    const q = this.queued.get(method)
    if (!q || q.length === 0) return undefined
    return q.length > 1 ? q.shift() : q[0]
  }

  bool(method: string, fallback: boolean): boolean {
    const v = this.answer(method)
    return typeof v === 'boolean' ? v : fallback
  }

  string(method: string): string | null {
    const v = this.answer(method)
    return typeof v === 'string' ? v : null
  }

  /** a string's UTF-8 bytes; `{error}` throws it */
  bytes(method: string, fallback: string): Buffer {
    const v = this.answer(method)
    if (typeof v === 'string') return Buffer.from(v, 'utf8')
    if (v !== null && typeof v === 'object') {
      const error = 'error' in v ? v.error : undefined
      throw new Error(typeof error === 'string' ? error : 'failed')
    }
    return Buffer.from(fallback, 'utf8')
  }
}

const STATE = Symbol.for('ipc-diff.d2.text')

/** the answers of the app the current case runs; the fake modules read it */
export function answers(): Answers {
  const a = (globalThis as Record<symbol, Answers | undefined>)[STATE]
  if (!a) throw new Error('no d2 text case is loaded')
  return a
}

/** the text of a page an engine is handed, as the log writes it */
export function fileText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The engines behind the Rust host traits, by the specifier, the resolved
 * file or the importing file, each replaced by the module of that name in
 * this folder for every case of the group
 */
const REPLACED: {
  test: (specifier: string, url: string, parent: string) => boolean
  module: string
}[] = [
  { test: (s) => s === '@seuoffice/file-parse', module: 'file-parse.ts' },
  { test: (s) => s === '@seuoffice/odt-engine', module: 'odt-engine.ts' },
  {
    test: (s) => s === '@seuoffice/electron-utils/generate-handoff',
    module: 'generate-handoff.ts',
  },
  {
    test: (_s, url) => url.endsWith('/packages/html2docx/src/index.ts'),
    module: 'html2docx.ts',
  },
  {
    test: (_s, url) => url.endsWith('/packages/html2docx/src/drivers/electron.ts'),
    module: 'html2docx-driver.ts',
  },
  // the ids of the page image exports and the Docs conversions (`MarkdownShell::random_uuid`)
  {
    test: (s, _u, parent) => s === 'node:crypto' && COUNTED.some((f) => parent.endsWith(f)),
    module: 'counted-crypto.ts',
  },
  {
    test: (s, _u, parent) => s === 'node:fs/promises' && parent.endsWith(COUNTED[0]),
    module: 'image-export-fs.ts',
  },
]
const COUNTED = [
  '/apps/markdown/src/main/image-export.ts',
  '/apps/markdown/src/main/conversion-lifecycle.ts',
] as const

let hooked = false
function hookEngines(): void {
  if (hooked) return
  hooked = true
  const folder = new URL('./', import.meta.url).href
  registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context)
      const parent = context.parentURL ?? ''
      // a fake re-exports what it keeps of the module it replaces
      if (parent.startsWith(folder)) return resolved
      const hit = REPLACED.find((r) => r.test(specifier, resolved.url, parent))
      if (!hit) return resolved
      return { url: new URL(hit.module, folder).href, format: 'module', shortCircuit: true }
    },
  })
}

const IDS = Symbol.for('ipc-diff.d2.text.ids')

/** the n-th `randomUUID()` of the case's image exports, as the Rust fake counts them */
export function countedUuid(): string {
  const holder = globalThis as unknown as Record<symbol, number>
  const n = (holder[IDS] ?? 0) + 1
  holder[IDS] = n
  return `${String(n).padStart(6, '0')}aa-0000-4000-8000-000000000000`
}

const RealDate = Date
const RECOVERY = Symbol.for('seuoffice.recovery-store.shared')

/** `Date` with `Date.now()` and `new Date()` at the case's `now` */
function fixedDate(now: number): DateConstructor {
  class Fixed extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now)
      else super(...(args as [number]))
    }
    static now(): number {
      return now
    }
  }
  return Fixed as unknown as DateConstructor
}

/** a webContents of the case with what the editors' view set-up calls */
function viewContents(cx: LoadContext, id: number): Record<string, unknown> {
  const wc = cx.electron.contents(id) as Record<string, unknown>
  Object.assign(wc, {
    once: () => wc,
    on: () => wc,
    setWindowOpenHandler: () => {},
    loadURL: async () => {},
    reload: () => cx.electron.log.push(['webContents.reload', id]),
  })
  return wc
}

/** a webContents of no case view: the view the module makes at load */
function offstage(id: number): Record<string, unknown> {
  return withInert({
    id,
    once() {},
    on() {},
    setWindowOpenHandler() {},
    loadURL: async () => {},
    isDestroyed: () => false,
  })
}

export interface TextEditorElectron {
  /** the case view the next `new WebContentsView()` (`create<App>View`) hands out */
  nextView: number | null
  /** the case view the next headless export window shows */
  nextHidden: number | null
}

/**
 * The outbound calls into an editor by `<what>`: each runs on what the case
 * loaded, for a view, with the step's arguments
 */
export type Outbound<L> = Record<string, (loaded: L, view: number, args: unknown[]) => unknown>

/**
 * A `d2/<app>:<what>` trigger step (the shell's or another area's call into
 * the editor); `defer` when it waits for the renderer's answer, taken by a
 * later `awaitStep`
 */
export function triggerStep(
  app: 'html' | 'markdown',
  what: string,
  args: unknown[] = [],
  more: { view?: number; defer?: true } = {},
): Call {
  const name = `d2/${app}:${what}`
  return { channel: name, kind: 'trigger', name, view: 1, args, ...more }
}

/** the reply of the deferred step at `index` */
export const awaitStep = (index: number): Call => ({ channel: '', args: [], await: index })

/** `Group.triggers` for `outbound`, each run on what the current case loaded */
export function groupTriggers<L>(
  app: 'html' | 'markdown',
  outbound: Outbound<L>,
  loaded: () => L,
): NonNullable<Group['triggers']> {
  return Object.fromEntries(
    Object.entries(outbound).map(([what, run]) => [
      `d2/${app}:${what}`,
      (_cx: TriggerContext, view: number, args: unknown[]) => run(loaded(), view, args),
    ]),
  )
}

/**
 * Sets up one case for a text editor: the answers of `hosts.d2.<app>`, the
 * process state, the clock, the recovery store's run id, and the Electron
 * names the entry module reaches. Returns what the group's triggers steer.
 */
export function setUpTextCase(cx: LoadContext, app: 'html' | 'markdown'): TextEditorElectron {
  hookEngines()
  const hosts = (cx.case.hosts ?? {}) as Record<string, Record<string, unknown> | undefined>
  const c = (hosts.d2?.[app] ?? {}) as Record<string, unknown>
  const a = new Answers(c, cx.electron.log)
  ;(globalThis as Record<symbol, Answers>)[STATE] = a

  setHeadlessMode(c.is_headless === true)
  setUiLang(c.ui_lang === 'ko' ? 'ko' : 'en')
  setOpenPathProbe((path) => a.listed('open_elsewhere', path))
  setOpenFilesSource(() =>
    ((c.unsaved_files as string[] | undefined) ?? []).map((filePath) => ({
      filePath,
      dirty: true,
    })),
  )
  globalThis.Date = typeof c.now === 'number' ? fixedDate(c.now) : RealDate
  ;(globalThis as unknown as Record<symbol, number>)[IDS] = 0
  // the image host upload's request (`upload_fetch`): `{status, text}` answers, else it fails
  globalThis.fetch = async (_url: unknown, init?: { method?: string }) => {
    cx.electron.log.push(['fetch', init?.method ?? 'GET'])
    const answer = a.answer('upload_fetch') as { status?: number; text?: string } | undefined
    if (answer === null || typeof answer !== 'object') throw new TypeError('fetch failed')
    return new Response(answer.text ?? '', { status: answer.status ?? 200 })
  }
  // the store's process state starts afresh, with the probe's run id
  const holder = globalThis as unknown as Record<symbol, unknown>
  delete holder[RECOVERY]
  const shared = (hosts.shared ?? {}) as { recoveryRunId?: string }
  holder[RECOVERY] = {
    shuttingDown: false,
    epochs: new Map(),
    queues: new Map(),
    runId: shared.recoveryRunId ?? '0000000000000000',
    discarded: new Set(),
  }

  const steer: TextEditorElectron = { nextView: null, nextHidden: null }
  const views = cx.case.views ?? [{ view: 1 }]
  for (const v of views) viewContents(cx, v.view)
  const caseWindows = cx.electron.BrowserWindow as {
    getAllWindows(): Record<string, unknown>[]
    fromWebContents(wc: unknown): unknown
    fromId(id: number): unknown
    getFocusedWindow(): unknown
  }
  for (const win of caseWindows.getAllWindows()) {
    const id = win.id as number
    Object.assign(win, {
      isFullScreen: () => false,
      isSimpleFullScreen: () => false,
      setFullScreenable: (on: boolean) =>
        cx.electron.log.push(['BrowserWindow.setFullScreenable', id, on]),
      setSimpleFullScreen: (on: boolean) =>
        cx.electron.log.push(['BrowserWindow.setSimpleFullScreen', id, on]),
      getContentBounds: () => ({ x: 0, y: 0, width: 1200, height: 850 }),
      once: () => {},
    })
  }

  let made = 900
  function WebContentsView(): unknown {
    const id = steer.nextView
    steer.nextView = null
    return { webContents: id === null ? offstage(made++) : viewContents(cx, id) }
  }
  /** a hidden print window, a headless export window, or a present window */
  function BrowserWindow(options: { show?: boolean; webPreferences?: { preload?: string } }) {
    if (options?.show === false && options.webPreferences?.preload === undefined) {
      let page = ''
      return {
        loadFile: async (path: string) => {
          page = path
        },
        webContents: {
          printToPDF: async () => {
            cx.electron.log.push(['printToPDF', fileText(page)])
            return answers().bytes('print_pdf', '%PDF')
          },
        },
        destroy: () => {},
        isDestroyed: () => false,
      }
    }
    if (options?.show === false) {
      const id = steer.nextHidden
      steer.nextHidden = null
      const wc = id === null ? offstage(made++) : viewContents(cx, id)
      return withInert({ id: 950, webContents: wc, isDestroyed: () => false, destroy() {} })
    }
    cx.electron.log.push(['openPresentWindow'])
    const view = answers().answer('open_present_window')
    const wc = typeof view === 'number' ? viewContents(cx, view) : offstage(made++)
    return withInert({ id: 960, webContents: wc, once() {}, isDestroyed: () => false })
  }
  Object.assign(BrowserWindow, caseWindows)

  cx.install({
    protocol: inert(),
    WebContentsView,
    BrowserWindow,
    net: {
      fetch: async (url: string) => {
        a.answer('net_fetch')
        cx.electron.log.push(['net.fetch', url])
        throw new TypeError('Failed to fetch')
      },
    },
  })
  return steer
}

export { fileURLToPath, pathToFileURL }
