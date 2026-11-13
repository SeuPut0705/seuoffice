/**
 * The TypeScript half of crates/shell-ipc/d1/src/mindmap/hosts.rs: loads the
 * mind map editor's main process (`apps/mindmap/src/main`) on the case's fake
 * Electron and redirects what the Rust `XmindEngine`, `FileParse`, `LinkNet`,
 * `PageRenderer` and `MindmapShell` stand for to fakes that answer from
 * `hosts.d1.mindmap` and log the same lines (the table in `Fake` of hosts.rs):
 *
 * - `@seuoffice/xmind-engine`'s `openXmind`, `@seuoffice/file-parse`'s
 *   `parseFileToText`, `diagramPictureExtOf`, `diagramPictureExtOfName` and its
 *   attachment limits, `@seuoffice/electron-utils`'s `assertFileSaved`,
 *   `.../fetch-image-bytes`'s `fetchImageBytes`, `.../safe-remote-url`'s
 *   `fetchWithSsrfGuard` and `.../generate-handoff`'s two functions are
 *   replaced for the mind map's main files (a wrapper module that re-exports
 *   the real one);
 * - `pageToPdf` runs on a fake `BrowserWindow` whose `printToPDF` logs the page;
 * - the hooks the shell sets (`setMindmap*Hook`, the runtime's project folder
 *   functions) log and answer;
 * - the views the shell made are made with `createMindmapView(path)`, and the
 *   calls the shell makes into the editor with its exported functions
 *   (`hosts.d1.mindmap.open` and `.startup`, probe.rs).
 *
 * Every file of `apps/mindmap/src/main` is loaded afresh for each case (a
 * `?case=n` query on its relative imports), so its module state starts over.
 * Timers do not keep the process alive: a request nobody answers is dropped
 * with the process.
 */
import { createRequire, registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setUiLang } from '@seuoffice/i18n'
import { setOpenPathProbe } from '@seuoffice/electron-utils'
import { useElectron } from '../../main-diff/electron-fake.ts'
import type * as MindmapMain from '../../../apps/mindmap/src/main/mindmap-main.ts'
import type * as SeedMain from '../../../apps/mindmap/src/main/seed-main.ts'
import type * as McpQueries from '../../../apps/mindmap/src/main/mcp-queries.ts'
import type { FakeContents } from '../fakes.ts'
import type { LoadContext } from '../types.ts'

const RealDate = Date
const root = resolve(import.meta.dirname, '../../..')
const MAIN = 'apps/mindmap/src/main'
const MAIN_PATH = `/${MAIN}/`
const KEY = Symbol.for('ipc-diff.d1.mindmap')

type Json = Record<string, unknown>

interface Box {
  /** the case's number: the query of the files loaded for it */
  n: number
  /** `hosts.d1.mindmap` */
  d1: Json
  log: (line: unknown[]) => void
  /** the scripted `openXmind` answers, one per call */
  openQueue: Json[]
  handoff: Json | null
  [name: string]: unknown
}
const box: Box = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  n: 0,
  d1: {},
  log: () => {},
  openQueue: [],
  handoff: null,
}) as Box

const asObject = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

// a timer nobody waits for must not hold the process: a request left open by a case ends with it
for (const name of ['setTimeout', 'setInterval'] as const) {
  const original = globalThis[name] as unknown as (...a: unknown[]) => { unref?: () => void }
  ;(globalThis as Record<string, unknown>)[name] = (...a: unknown[]) => {
    const timer = original(...a)
    timer.unref?.()
    return timer
  }
}

box.openXmind = async (bytes: Uint8Array) => {
  box.log(['xmind-engine.openXmind', bytes.byteLength])
  const scripted = box.openQueue.shift()
  if (scripted) return { status: text(scripted.status) || 'ok', detail: scripted.detail }
  const starts = (prefix: string) =>
    Buffer.from(bytes.subarray(0, prefix.length)).toString() === prefix
  const status = starts('XMIND')
    ? 'ok'
    : starts('OLD')
      ? 'legacy-format'
      : starts('ENC')
        ? 'encrypted'
        : bytes.byteLength === 0
          ? 'unreadable'
          : 'rejected'
  return { status, detail: 'fake' }
}

const attachable = (): Json => asObject(box.d1.attachable)
const list = (key: string, fallback: string[]): Set<string> => {
  const given = attachable()[key]
  return new Set(Array.isArray(given) ? (given as string[]) : fallback)
}
box.limit = (key: string, fallback: number): number =>
  typeof attachable()[key] === 'number' ? (attachable()[key] as number) : fallback
box.attachableExts = () =>
  list('exts', ['txt', 'md', 'xmind', 'png', 'jpg', 'jpeg', 'gif', 'webp'])
box.attachableImageExts = () => list('imageExts', ['png', 'jpg', 'jpeg', 'gif', 'webp'])

box.diagramPictureExt = (name: string, path: string) => {
  box.log([`file-parse.${name}`, path])
  const ext = asObject(box.d1.diagramPictureExt)[path]
  return typeof ext === 'string' ? ext : undefined
}

box.parseFileToText = async (path: string) => {
  box.log(['file-parse.parseFileToText', path])
  const scripted = asObject(asObject(box.d1.parseFileToText)[path])
  if (Object.keys(scripted).length > 0) {
    return {
      ok: scripted.ok === true,
      ...(typeof scripted.kind === 'string' ? { kind: scripted.kind } : {}),
      ...(typeof scripted.text === 'string' ? { text: scripted.text } : {}),
      damaged: scripted.damaged === true,
      ...(typeof scripted.error === 'string' ? { error: scripted.error } : {}),
    }
  }
  try {
    return { ok: true, kind: 'text', text: readFileSync(path, 'utf8') }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

box.assertFileSaved = async (path: string) => {
  box.log(['electron-utils.assertFileSaved', path])
  const unsaved = box.d1.unsaved
  if (Array.isArray(unsaved) && unsaved.includes(path)) {
    throw new Error('This file is open with unsaved changes. Save it, then try again.')
  }
}

box.fetchWithSsrfGuard = async (address: string) => {
  box.log(['safe-remote-url.fetchWithSsrfGuard', address])
  const page = asObject(asObject(box.d1.pages)[address])
  if (Object.keys(page).length === 0) return null
  if (page.throws === true) throw new Error('fetch failed')
  const headers: Record<string, string> = {}
  if (text(page.contentType) !== '') headers['content-type'] = text(page.contentType)
  const resp = new Response(Buffer.from(text(page.body)), {
    status: page.ok === false ? 500 : 200,
    headers,
  })
  Object.defineProperty(resp, 'url', { value: text(page.url) })
  return resp
}

box.fetchImageBytes = async (url: unknown) => {
  box.log(['fetch-image-bytes.fetchImageBytes', typeof url === 'string' ? url : null])
  const image = asObject(asObject(box.d1.images)[typeof url === 'string' ? url : ''])
  if (Object.keys(image).length === 0) return null
  return { base64: text(image.base64), mime: text(image.mime) }
}

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

const SELF = `globalThis[Symbol.for('ipc-diff.d1.mindmap')]`

// the wrappers: the real module's exports, over which the fakes sit. They are
// CommonJS because the mind map's files are compiled to it; every override is a
// getter, so a case's answers are read at each use, not at the first load
const WRAPPERS: Record<string, Record<string, string>> = {
  '@seuoffice/xmind-engine': { openXmind: `(...a) => ${SELF}.openXmind(...a)` },
  '@seuoffice/file-parse': {
    parseFileToText: `(path) => ${SELF}.parseFileToText(path)`,
    diagramPictureExtOf: `(path) => ${SELF}.diagramPictureExt('diagramPictureExtOf', path)`,
    diagramPictureExtOfName: `(path) => ${SELF}.diagramPictureExt('diagramPictureExtOfName', path)`,
    ATTACHABLE_EXTS: `${SELF}.attachableExts()`,
    ATTACHABLE_IMAGE_EXTS: `${SELF}.attachableImageExts()`,
    ATTACHABLE_MAX_BYTES: `${SELF}.limit('maxBytes', 20 * 1024 * 1024)`,
    ATTACHABLE_IMAGE_MAX_BYTES: `${SELF}.limit('imageMaxBytes', 5 * 1024 * 1024)`,
    attachableMaxBytes: `() => ${SELF}.limit('maxBytes', 20 * 1024 * 1024)`,
  },
  '@seuoffice/electron-utils': { assertFileSaved: `(path) => ${SELF}.assertFileSaved(path)` },
  '@seuoffice/electron-utils/fetch-image-bytes': {
    fetchImageBytes: `(url) => ${SELF}.fetchImageBytes(url)`,
  },
  '@seuoffice/electron-utils/safe-remote-url': {
    fetchWithSsrfGuard: `(address) => ${SELF}.fetchWithSsrfGuard(address)`,
  },
  '@seuoffice/electron-utils/generate-handoff': {
    takeGenerateHandoff: `(t, v) => ${SELF}.takeGenerateHandoff(t, v)`,
    reportGenerateRunStarted: `(t, v, p) => ${SELF}.reportGenerateRunStarted(t, v, p)`,
  },
}

function wrapperSource(name: string, real: string): string {
  const overrides = Object.entries(WRAPPERS[name]).map(
    ([key, expr]) =>
      `Object.defineProperty(out, ${JSON.stringify(key)}, { enumerable: true, get: () => ${expr} })`,
  )
  return [
    `const real = require(${JSON.stringify(fileURLToPath(real))})`,
    'const out = { ...real }',
    ...overrides,
    'module.exports = out',
  ].join('\n')
}
const FAKE = 'ipc-diff-d1-mindmap:'

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (parent.includes(MAIN_PATH)) {
      if (specifier in WRAPPERS) {
        const real = next(specifier, context).url
        return {
          url: `${FAKE}wrap?name=${encodeURIComponent(specifier)}&real=${encodeURIComponent(real)}`,
          shortCircuit: true,
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
    return next(url, context)
  },
})

interface OpenEntry {
  view: number
  path?: string
  decision?: 'restore' | 'original'
  seed?: { outline?: string; copy?: string }
}

export async function loadMindmap(cx: LoadContext): Promise<void> {
  const e = cx.electron
  const d1 = asObject(asObject(cx.case.hosts).d1)
  box.n++
  box.d1 = asObject(d1.mindmap)
  box.log = (line) => e.log.push(line)
  // a case may fix the clock (`new Date()` and `Date.now()` answer it) so that names made from it match
  const clock = box.d1.clock
  globalThis.Date =
    typeof clock === 'number'
      ? (class FixedDate extends RealDate {
          constructor(...args: unknown[]) {
            if (args.length === 0) super(clock)
            else super(...(args as [number]))
          }
          static override now(): number {
            return clock
          }
        } as DateConstructor)
      : RealDate
  box.openQueue = (Array.isArray(box.d1.openXmind) ? [...(box.d1.openXmind as Json[])] : []) as Json[]
  const handoff = asObject(box.d1.handoff)
  box.handoff =
    Object.keys(handoff).length === 0
      ? null
      : {
          id: text(handoff.id),
          mode: 'make',
          target: 'mindmap',
          materials: ((handoff.materials as Json[] | undefined) ?? []).map((m) => ({
            path: text(m.path),
            name: text(m.name),
          })),
          text: text(handoff.text),
          defaultText: false,
          createdAt: 0,
        }

  // what the shell's views are
  const views = cx.case.views ?? [{ view: 1 }]
  let nextView = views[0].view
  for (const v of views) {
    Object.assign(e.contents(v.view), {
      setWindowOpenHandler() {},
      on() {},
      once() {},
      getURL: () => '',
      loadURL: async () => {},
      reload() {},
    })
  }
  const bw = e.BrowserWindow as Record<string, unknown>
  // the hidden window of `pageToPdf`: it loads the page file, and printing logs the page
  class FakeBrowserWindow {
    static getAllWindows = bw.getAllWindows
    static fromWebContents = bw.fromWebContents
    static fromId = bw.fromId
    static getFocusedWindow = bw.getFocusedWindow
    private html = ''
    private destroyed = false
    webContents = {
      id: 900,
      printToPDF: async () => {
        e.log.push(['export-main.pageToPdf', this.html])
        const pdf = asObject(box.d1.pdf)
        if (typeof pdf.error === 'string') throw new Error(pdf.error)
        return Buffer.from('%PDF-1.7')
      },
    }
    async loadFile(path: string): Promise<void> {
      this.html = readFileSync(path, 'utf8')
    }
    isDestroyed = () => this.destroyed
    destroy = () => {
      this.destroyed = true
    }
  }
  class FakeWebContentsView {
    webContents: FakeContents
    constructor() {
      this.webContents = e.contents(nextView)
    }
  }
  Object.assign(e, {
    BrowserWindow: FakeBrowserWindow,
    WebContentsView: FakeWebContentsView,
    session: { fromPartition: () => ({ webRequest: { onBeforeRequest() {} } }) },
  })
  useElectron(e)

  setUiLang('en')
  const elsewhere = Array.isArray(box.d1.openElsewhere) ? (box.d1.openElsewhere as string[]) : []
  setOpenPathProbe((path: string) => {
    e.log.push(['electron-utils.isPathOpenElsewhere', path])
    return elsewhere.includes(path)
  })

  // the mind map's files are CommonJS (tsx compiles them so), cached by file: a
  // case clears them, so its module state (`registered`, `ipcRegistered`, the
  // seeds) starts over, and loads them after the hooks above
  const load = createRequire(`${root}/${MAIN}/mindmap-main.ts`)
  for (const key of Object.keys(load.cache)) if (key.includes(MAIN_PATH)) delete load.cache[key]
  const main = load(`${root}/${MAIN}/mindmap-main.ts`) as typeof MindmapMain
  const seeds = load(`${root}/${MAIN}/seed-main.ts`) as typeof SeedMain
  const queries = load(`${root}/${MAIN}/mcp-queries.ts`) as typeof McpQueries

  const writer = box.d1.writeNewDocument
  main.configureMindmapRuntime({
    preloadPath: '/mindmap/out/preload/index.js',
    newDocumentDir: async (id) => {
      e.log.push(['mindmap-main.newDocumentDir', id])
      const dir = box.d1.projectDir
      return typeof dir === 'string' ? dir : null
    },
    ...(writer === undefined || writer === null
      ? {}
      : {
          writeNewDocument: async (id: number, fileName: string, bytes: Uint8Array) => {
            e.log.push(['mindmap-main.writeNewDocument', id, fileName, bytes.byteLength])
            const answer = asObject(writer)
            if (typeof answer.error === 'string') throw new Error(answer.error)
            return typeof answer.path === 'string' ? answer.path : null
          },
        }),
  })
  main.setMindmapFileSavedHook((wc, path) => {
    e.log.push(['mindmap-main.fileSavedHook', wc.id, path])
  })
  main.setMindmapMakeFromDocumentHook((wc) => {
    e.log.push(['mindmap-main.makeFromDocumentHook', wc.id])
  })
  main.setMindmapRecoveryTitleHook((wc) => {
    e.log.push(['mindmap-main.recoveryTitleHook', wc.id])
    const title = box.d1.recoveryTitle
    return typeof title === 'string' ? title : null
  })
  main.setMindmapProvisionalTitleHook((wc, title) => {
    e.log.push(['ai-attachments.provisionalTitleHook', wc.id, title])
  })

  // the views the shell made (`open` absent: a new, untitled map in the first view)
  const open: OpenEntry[] = Array.isArray(box.d1.open)
    ? (box.d1.open as OpenEntry[])
    : [{ view: views[0].view }]
  for (const entry of open) {
    nextView = entry.view
    main.createMindmapView(entry.path ?? null)
    if (entry.decision && entry.path) {
      main.openMindmapFileWithDecision(e.contents(entry.view) as never, {
        filePath: entry.path,
        decision: entry.decision,
      })
    }
    if (entry.seed) {
      seeds.queueMindmapSeedFor(
        e.contents(entry.view) as never,
        entry.seed.outline !== undefined
          ? { outline: entry.seed.outline }
          : { bytes: Buffer.from(text(entry.seed.copy)) },
      )
    }
  }

  // the calls the shell, the menus and the MCP server make into the editor
  const startup = Array.isArray(box.d1.startup) ? (box.d1.startup as Json[]) : []
  for (const step of startup) {
    const view = typeof step.view === 'number' ? step.view : 1
    const contents = e.contents(view) as never
    switch (step.call) {
      case 'dirty':
        for (const fn of e.handlers.on.get('mindmap:dirty-changed') ?? [])
          fn({ sender: contents }, true)
        break
      case 'requestSave':
        void main.requestMindmapSave(contents, step.mode === 'saveAs' ? 'saveAs' : 'save')
        break
      case 'requestClose':
        void main.requestMindmapClose(
          contents,
          (e.BrowserWindow as { fromWebContents(wc: unknown): never }).fromWebContents(contents),
        )
        break
      case 'fileRenamed':
        main.mindmapFileRenamed(contents, text(step.from), text(step.to))
        break
      case 'menuCommand':
        main.sendMindmapMenuCommand(contents, text(step.command) as never)
        break
      case 'exportRequest':
        main.sendMindmapExportRequest(contents, text(step.format) as never)
        break
      case 'readOutline':
        queries.mindmapReadOutline(contents).catch(() => {})
        break
      case 'readBytes':
        queries.mindmapReadBytes(contents).catch(() => {})
        break
      case 'copiesNow':
        void main.writeMindmapCopiesNow()
        break
    }
  }
}
