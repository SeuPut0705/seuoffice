/**
 * The TypeScript half of crates/shell-ipc/d1/src/slides/fake.rs: loads the slides
 * editor's main process (`apps/slides/src/main`) on the case's fake Electron the
 * way the shell loads it (`registerSlidesIpc`, the runtime and the hooks the
 * shell sets) and redirects what the Rust `SlidesEngine` and `SlidesShell` stand
 * for to fakes that answer from `hosts.d1.slides` and log the same lines:
 *
 * - `@seuoffice/pptx-engine`, `pptx-ops` and `pptx-render` run on the fake deck of
 *   `slides-engine.ts` (wrapper modules over the real ones);
 * - `fonts.ts`, `shaped-metrics.ts`, `metafile-fonts.ts` and the template
 *   selection hooks are stubbed (no font scan, no shaping, no store);
 * - the shell's hooks (`setSlidesOpenedHook`, `configureSlidesRuntime`, ...) log
 *   and answer.
 *
 * Every file of `apps/slides/src/main` is loaded afresh for each case, so its
 * module state starts over. Timers do not keep the process alive.
 */
import type { Group } from '../types.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setUiLang } from '@seuoffice/i18n'
import { useElectron } from '../../main-diff/electron-fake.ts'
import { makeDesktop } from './slides-desktop.ts'
import { makeEngine, type EngineBox } from './slides-engine.ts'
import type * as SlidesMain from '../../../apps/slides/src/main/slides-main.ts'
import type { LoadContext } from '../types.ts'

const RealDate = Date
const root = resolve(import.meta.dirname, '../../..')
const MAIN = 'apps/slides/src/main'
const MAIN_PATH = `/${MAIN}/`
const KEY = Symbol.for('ipc-diff.d1.slides')

type Json = Record<string, unknown>

interface Box extends EngineBox {
  d1: Json
  [name: string]: unknown
}
const box: Box = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  d1: {},
  log: () => {},
  blankSlides: 1,
  fixtures: {},
}) as Box

const asObject = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

// a timer nobody waits for must not hold the process: a request left open by a case ends with it.
// A short timer (the show's focus and release debounce) runs before the next call, as the
// probe's wait for idle workers lets the Rust side's run.
const shortTimers = new Set<unknown>()
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
;(globalThis as Record<string, unknown>).setTimeout = (
  fn: () => void,
  ms?: number,
  ...a: unknown[]
) => {
  if (typeof ms === 'number' && ms > 0 && ms <= 200) {
    const handle = setImmediate(() => fn(...(a as [])))
    shortTimers.add(handle)
    return handle
  }
  const timer = realSetTimeout(fn, ms, ...a)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return timer
}
;(globalThis as Record<string, unknown>).clearTimeout = (handle: never) =>
  shortTimers.has(handle) ? clearImmediate(handle) : realClearTimeout(handle)
const realSetInterval = globalThis.setInterval
;(globalThis as Record<string, unknown>).setInterval = (...a: Parameters<typeof setInterval>) => {
  const timer = realSetInterval(...a)
  timer.unref?.()
  return timer
}

const fakes = makeEngine({
  log: (line) => box.log(line),
  get blankSlides() {
    return box.blankSlides
  },
  get fixtures() {
    return box.fixtures
  },
} as EngineBox)
box.fakes = fakes

const SELF = `globalThis[Symbol.for('ipc-diff.d1.slides')]`

// the wrappers: the real module's exports over which the fakes sit (CommonJS, as the
// slides files are compiled to it); every override is a getter
const WRAPPERS: Record<string, Record<string, string>> = {
  '@seuoffice/pptx-engine': Object.fromEntries(
    Object.keys(fakes.engine).map((k) => [k, `${SELF}.fakes.engine[${JSON.stringify(k)}]`]),
  ),
  '@seuoffice/pptx-render': Object.fromEntries(
    Object.keys(fakes.render).map((k) => [k, `${SELF}.fakes.render[${JSON.stringify(k)}]`]),
  ),
  // every name made from a random UUID counts up, as the Rust fake's `random_uuid` does
  'node:crypto': { randomUUID: `() => ${SELF}.randomUUID()` },
  '@seuoffice/electron-utils/generate-handoff': {
    takeGenerateHandoff: `(t, v) => ${SELF}.takeGenerateHandoff(t, v)`,
    reportGenerateRunStarted: `(t, v, p) => ${SELF}.reportGenerateRunStarted(t, v, p)`,
  },
  '@seuoffice/file-parse': {
    parseFileToText: `(path) => ${SELF}.parseFileToText(path)`,
    diagramPictureExtOf: `() => undefined`,
  },
}

// modules that are replaced whole (no real load; `pptx-ops` reads markdown prompts the
// CommonJS loader cannot take): their exports
const PACKAGE_STUBS: Record<string, string> = {
  '@seuoffice/pipelines/slides': Object.keys(fakes.pipelines)
    .map((k) => `exports.${k} = (...a) => ${SELF}.fakes.pipelines.${k}(...a)`)
    .join('\n'),
  // the catalog of template covers: one template, whose sample cover is the language name
  '@seuoffice/pipelines/slides/templates': `exports.listSlideTemplates = () => [{ id: 'plain', sampleCover: { ko: 'ko', en: 'en' } }]`,
  '@seuoffice/pptx-ops': Object.keys(fakes.ops)
    .map((k) => `exports.${k} = (...a) => ${SELF}.fakes.ops.${k}(...a)`)
    .join('\n'),
}

// the shared electron stub lists a fixed set of names; the slides main also uses
// `systemPreferences` and `desktopCapturer`, so its files get every name the case faked
PACKAGE_STUBS.electron = `module.exports = new Proxy({}, { get: (_, key) => globalThis[Symbol.for('main-diff.electron')].fake[key] })`
// the same for files of the slides main
const STUBS: Record<string, string> = {
  'fonts.ts': `
    exports.createSystemFontMetrics = () => ({ displayFamily: () => undefined })
    exports.resetFontRegistry = () => {}
    exports.registerEmbeddedFonts = () => false
    exports.listPrivateFontFaces = () => ${SELF}.privateFontFaces()
    exports.getPrivateFontData = (id) => ${SELF}.privateFontData(id)
    exports.setUserFontDir = () => {}
    exports.setTemplateFontDir = () => {}
    exports.fontFileFamilies = (path) => ${SELF}.fontFileFamilies(path)`,
  'shaped-metrics.ts': `
    exports.shapedMetricsReady = () => Promise.resolve()
    exports.refineComplexWidths = async () => false
    exports.initShapedMetrics = () => {}`,
  'metafile-fonts.ts': `exports.listMetafileFonts = () => []`,
  // the hidden window that prints the PDF is the shell's: the fake logs, writes and reports
  'pdf-export.ts': `
    exports.exportSlidesPdf = ${SELF}.exportSlidesPdf
    exports.buildPdfLinkOverlays = () => ''`,
  'template-selection-ipc.ts': `
    exports.registerTemplateSelectionIpc = () => {}
    exports.followTemplateSelection = () => {}
    exports.inheritTemplateSelection = () => {}
    exports.moveSlidesTemplateSelection = () => {}`,
}

/** an image of the fake desktop: `logOn` is the call that logs the one `nativeImage.info` line */
function sizedImage(e: LoadContext['electron'], bytes: Buffer, logOn: 'isEmpty' | 'getSize') {
  let logged = false
  const note = () => {
    if (logged) return
    logged = true
    e.log.push(['nativeImage.info', bytes.length])
  }
  return {
    toPNG: () => bytes,
    isEmpty: () => {
      if (logOn === 'isEmpty') note()
      return bytes.length === 0
    },
    getSize: () => {
      note()
      return bytes.length === 0 ? { width: 0, height: 0 } : { width: 640, height: 480 }
    },
  }
}

box.exportSlidesPdf = async (opts: { filePath?: unknown; openExportedPdf(path: string): void }) => {
  const path = typeof opts.filePath === 'string' ? opts.filePath : undefined
  box.log(['exportSlidesPdf', path ?? null])
  if (path !== undefined) {
    writeFileSync(path, '%PDF-1.7')
    opts.openExportedPdf(path)
  }
  return { ok: path !== undefined, ...(path !== undefined ? { path } : {}) }
}
box.randomUUID = () =>
  `00000000-0000-4000-8000-${String(++(box.uuids as number)).padStart(12, '0')}`
box.takeGenerateHandoff = (target: string, view: number) => {
  box.log(['generate-handoff.takeGenerateHandoff', target, view])
  const handoff = box.handoff
  box.handoff = null
  return handoff
}
box.reportGenerateRunStarted = (target: string, view: number, paths: string[]) => {
  box.log(['generate-handoff.reportGenerateRunStarted', target, view, paths])
  return true
}
box.parseFileToText = async (path: string) => {
  box.log(['file-parse.parseFileToText', path])
  try {
    return { ok: true, kind: 'text', text: readFileSync(path, 'utf8') }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}
box.privateFontFaces = () => {
  const faces = (box.fixtures as Json).fontFaces
  return Array.isArray(faces) ? structuredClone(faces) : []
}
box.privateFontData = (id: unknown) => {
  const data = asObject((box.fixtures as Json).fontData)
  return typeof id === 'string' && Object.hasOwn(data, id) ? structuredClone(data[id]) : null
}
box.fontFileFamilies = (path: string) => {
  box.log(['fonts.fontFileFamilies', path])
  const name = path.split('/').at(-1) ?? path
  return [name.split('.')[0] ?? name]
}

function wrapperSource(name: string, real: string): string {
  const overrides = Object.entries(WRAPPERS[name]).map(
    ([key, expr]) =>
      `Object.defineProperty(out, ${JSON.stringify(key)}, { enumerable: true, get: () => ${expr} })`,
  )
  return [
    `const real = require(${JSON.stringify(real.startsWith('file:') ? fileURLToPath(real) : real)})`,
    'const out = { ...real }',
    ...overrides,
    'module.exports = out',
  ].join('\n')
}
const FAKE = 'ipc-diff-d1-slides:'

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (parent.includes(MAIN_PATH)) {
      if (specifier in PACKAGE_STUBS) {
        return { url: `${FAKE}stub?name=${encodeURIComponent(specifier)}`, shortCircuit: true }
      }
      if (specifier in WRAPPERS) {
        const real = next(specifier, context).url
        return {
          url: `${FAKE}wrap?name=${encodeURIComponent(specifier)}&real=${encodeURIComponent(real)}`,
          shortCircuit: true,
        }
      }
      if (specifier.startsWith('./')) {
        const file = `${specifier.slice(2)}.ts`
        if (file in STUBS) {
          return { url: `${FAKE}stub?name=${encodeURIComponent(file)}`, shortCircuit: true }
        }
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(`${FAKE}wrap?`)) {
      const params = new URL(url).searchParams
      return {
        format: 'commonjs',
        shortCircuit: true,
        source: wrapperSource(params.get('name')!, params.get('real')!),
      }
    }
    if (url.startsWith(`${FAKE}stub?`)) {
      const name = new URL(url).searchParams.get('name')!
      return { format: 'commonjs', shortCircuit: true, source: STUBS[name] ?? PACKAGE_STUBS[name] }
    }
    return next(url, context)
  },
})

export async function loadSlides(cx: LoadContext): Promise<SlidesMainModule> {
  const e = cx.electron
  const d1 = asObject(asObject(cx.case.hosts).d1)
  box.d1 = asObject(d1.slides)
  box.log = (line) => e.log.push(line)
  box.blankSlides = typeof box.d1.blankSlides === 'number' ? box.d1.blankSlides : 1
  box.fixtures = asObject(box.d1.fixtures)
  box.uuids = 0
  const handoff = asObject(box.d1.handoff)
  box.handoff =
    Object.keys(handoff).length === 0
      ? null
      : {
          id: String(handoff.id ?? ''),
          mode: 'make',
          target: 'slides',
          materials: ((handoff.materials as Json[] | undefined) ?? []).map((m) => ({
            path: String(m.path ?? ''),
            name: String(m.name ?? ''),
          })),
          text: String(handoff.text ?? ''),
          defaultText: false,
          createdAt: 0,
        }
  // a case may fix the clock (`new Date()` and `Date.now()` answer it) so that names made from it match
  const clock = box.d1.clock
  globalThis.Date =
    typeof clock === 'number'
      ? (class FixedDate extends RealDate {
          constructor(...args: unknown[]) {
            if (args.length === 0) super(clock as number)
            else super(...(args as [number]))
          }
          static override now(): number {
            return clock
          }
        } as DateConstructor)
      : RealDate

  for (const v of cx.case.views ?? [{ view: 1 }]) {
    Object.assign(e.contents(v.view), {
      setWindowOpenHandler() {},
      getURL: () => '',
      loadURL: async () => {},
      reload() {},
      cut: () => e.log.push(['webContents.clipboard', v.view, 'cut']),
      copy: () => e.log.push(['webContents.clipboard', v.view, 'copy']),
      paste: () => e.log.push(['webContents.clipboard', v.view, 'paste']),
    })
  }
  const bw = e.BrowserWindow as Record<string, unknown>
  // no window has the focus: dialogs have no parent (the Rust fake's `dialog_parent`)
  bw.getFocusedWindow = () => null
  const desktop = makeDesktop(e, box.d1.externalDisplay === true, () =>
    Number(box.standaloneView ?? 1),
  )
  // the fake desktop is a Mac's: the slides main asks `process.platform` about the window snap
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  const noop = () => {}
  const markers = new Map<string, Buffer>()
  Object.assign(e, {
    session: {
      defaultSession: { protocol: { handle: noop }, setDisplayMediaRequestHandler: noop },
      fromPartition: () => ({ webRequest: { onBeforeRequest: noop } }),
    },
    // every picture is 640x480 and an empty one has no size; asking one for its size is one log line
    nativeImage: {
      ...(e.nativeImage as object),
      createFromBuffer: (bytes: Buffer) => sizedImage(e, Buffer.from(bytes), 'getSize'),
      createFromPath: (path: string) => sizedImage(e, readFileSync(path), 'isEmpty'),
      createThumbnailFromPath: async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
    },
    // the clipboard's custom formats (the slide and element markers) live in the fake too
    clipboard: {
      ...(e.clipboard as object),
      readBuffer: (format: string) => markers.get(format) ?? Buffer.alloc(0),
      writeBuffer: (format: string, bytes: Buffer) => {
        e.log.push(['clipboard.writeBuffer', format, bytes.length])
        markers.set(format, Buffer.from(bytes))
      },
    },
    ...desktop,
  })
  useElectron(e)
  setUiLang('en')

  // the slides files are CommonJS (tsx compiles them so), cached by file: a case
  // clears them, so its module state starts over, and loads them after the hooks above
  const load = createRequire(`${root}/${MAIN}/slides-main.ts`)
  for (const key of Object.keys(load.cache)) if (key.includes(MAIN_PATH)) delete load.cache[key]
  const main = load(`${root}/${MAIN}/slides-main.ts`) as SlidesMainModule
  main.configureSlidesRuntime({
    preloadPath: '/slides/out/preload/index.js',
    newDocumentDir: async () => {
      const dir = box.d1.projectDir
      return typeof dir === 'string' ? dir : null
    },
    // the shell picks the folder: the fake writes into the case's project folder
    ...(typeof box.d1.projectDir === 'string'
      ? {
          writeNewDocument: async (_id: number, name: string, bytes: Uint8Array) => {
            const path = `${box.d1.projectDir}/${name}`
            writeFileSync(path, bytes)
            return path
          },
        }
      : {}),
  })
  main.setSlidesOpenedHook((wc, path) => {
    e.log.push(['slidesOpenedHook', wc.id, path])
  })
  main.setSlidesShowBleed((wc, on) => {
    e.log.push(['showChrome.setBleed', wc.id, on])
  })
  main.registerSlidesIpc()
  box.main = main
  return main
}

export type SlidesMainModule = typeof SlidesMain

/**
 * The TypeScript side of the triggers (crates/shell-ipc/d1/src/slides/mod.rs
 * `probe_trigger`): what the shell runs on the loaded entry. The File menu's
 * items are found by their English label and clicked, with the view the menu's
 * commands go to made the active one, as the shell's tab switch does.
 */
const MENU_ITEMS: Record<string, string> = {
  'save-as': 'Save As…',
  'export-pdf': 'Export as PDF…',
  'export-images': 'Export as PNG…',
  'export-images-jpg': 'Export as JPG…',
}
interface MenuItem {
  label?: string
  submenu?: MenuItem[]
  click?: (item: MenuItem, window: unknown, event: unknown) => unknown
}
export const slidesTriggers: NonNullable<Group['triggers']> = {
  'd1/slides:requestSlidesClose': (cx, view, args) =>
    (box.main as SlidesMainModule).requestSlidesClose(
      cx.contents(view) as never,
      args[0] === true
        ? (cx.electron.BrowserWindow as { fromId(id: number): never }).fromId(view)
        : undefined,
    ),
  'd1/slides:slidesMenu': (cx, view, args) => {
    const main = box.main as SlidesMainModule
    main.setActiveSlidesWebContents(cx.contents(view) as never)
    const menu = main.buildSlidesMenu() as unknown as { template: MenuItem[] }
    const file = menu.template.find((item) => item.label === 'File')
    const item = (file?.submenu as MenuItem[] | undefined)?.find(
      (entry) => entry.label === MENU_ITEMS[String(args[0])],
    )
    if (!item?.click) throw new Error(`no menu item for ${String(args[0])}`)
    item.click(item, undefined, undefined)
  },
  // `createSlidesWindow(path)`: the window's page loads and the deck opens in it
  'd1/slides:openFileInWindow': async (cx, view, args) => {
    box.standaloneView = view
    ;(box.main as SlidesMainModule).createSlidesWindow(String(args[0]))
    await cx.contents(view).emit('did-finish-load')
  },
  // `createSlidesView(path)`: the tab queues the path its renderer opens when it mounts
  'd1/slides:createSlidesView': (cx, view, args) => {
    box.standaloneView = view
    ;(box.main as SlidesMainModule).createSlidesView(String(args[0]))
  },
}
