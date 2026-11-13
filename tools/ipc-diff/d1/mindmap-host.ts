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
 *   `.../generate-handoff`'s two functions are replaced for the mind map's main
 *   files (a wrapper module that re-exports the real one);
 * - the network sits one level lower: `safe-remote-url` and
 *   `fetch-image-bytes` run for real, over `node:dns/promises`' `lookup` and
 *   undici's `fetch`, `getGlobalDispatcher` and `Agent`, which electron-utils
 *   is given fakes of (`hosts.d1.mindmap.dns`, `.network`, `.proxy`), so the
 *   SSRF guard is compared as well;
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
import type { Group, LoadContext } from '../types.ts'

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

interface Pending {
  fn: (...args: unknown[]) => void
  args: unknown[]
  /** `performance.now()` when it is due */
  due: number
  /** for an interval: its period */
  every?: number
  handle: { unref?: () => void }
}
/** the timers the case's code has pending, so a trigger can let time pass (`advanceClock`) */
let pending: Pending[] = []

// A timer nobody waits for must not hold the process: a request left open by a case ends with it.
// The image download's retry pauses (500 and 1500 ms, remote-image.ts) are not waited for either:
// the Rust fetcher's `sleep` does not wait.
const realTimers = {
  setTimeout: globalThis.setTimeout,
  setInterval: globalThis.setInterval,
  clearTimeout: globalThis.clearTimeout,
  clearInterval: globalThis.clearInterval,
}
function timer(kind: 'setTimeout' | 'setInterval') {
  return (fn: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const ms = kind === 'setTimeout' && (delay === 500 || delay === 1500) ? 0 : (delay ?? 0)
    const entry: Pending = {
      fn,
      args,
      due: performance.now() + ms,
      ...(kind === 'setInterval' ? { every: ms } : {}),
      handle: {},
    }
    entry.handle = (realTimers[kind] as (...a: unknown[]) => { unref?: () => void })(
      (...a: unknown[]) => {
        if (entry.every === undefined) pending = pending.filter((p) => p !== entry)
        fn(...a)
      },
      ms,
      ...args,
    )
    entry.handle.unref?.()
    pending.push(entry)
    return entry.handle
  }
}
function clearer(kind: 'clearTimeout' | 'clearInterval') {
  return (handle: unknown) => {
    pending = pending.filter((p) => p.handle !== handle)
    realTimers[kind](handle as never)
  }
}
Object.assign(globalThis, {
  setTimeout: timer('setTimeout'),
  setInterval: timer('setInterval'),
  clearTimeout: clearer('clearTimeout'),
  clearInterval: clearer('clearInterval'),
})

/**
 * Lets `ms` of time pass: every timer due within it runs once, in the order
 * their time comes (the Rust side's `run_due`); an interval is due again a
 * period after it ran
 */
function advanceClock(ms: number): void {
  const horizon = performance.now() + ms
  const due = pending.filter((p) => p.due <= horizon).sort((a, b) => a.due - b.due)
  for (const entry of due) {
    if (entry.every === undefined) {
      pending = pending.filter((p) => p !== entry)
      realTimers.clearTimeout(entry.handle as never)
    } else {
      entry.due = performance.now() + entry.every
    }
    entry.fn(...entry.args)
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
box.attachableExts = () => list('exts', ['txt', 'md', 'xmind', 'png', 'jpg', 'jpeg', 'gif', 'webp'])
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

box.dnsLookup = async (host: string) => {
  box.log(['dns.lookup', host])
  const found = asObject(box.d1.dns)[host]
  if (!Array.isArray(found)) throw new Error(`getaddrinfo ENOTFOUND ${host}`)
  return found.map((a: Json) => ({ address: text(a.address), family: a.family ?? 4 }))
}

type Lookup = (
  host: string,
  options: { all: boolean },
  callback: (err: Error | null, address: unknown) => void,
) => void

class FakeAgent {
  constructor(private readonly options: { connect: { lookup: Lookup } }) {}
  /** what the agent answers a connect-time lookup of `host` with */
  pinned(host: string): unknown {
    let answer: unknown = null
    this.options.connect.lookup(host, { all: true }, (_err, address) => {
      answer = address
    })
    return answer
  }
  close(): Promise<void> {
    box.log(['undici.agent.close'])
    return Promise.resolve()
  }
}

box.undici = {
  Agent: FakeAgent,
  getGlobalDispatcher: () => (box.d1.proxy === true ? { [Symbol('proxy agent')]: 1 } : {}),
  fetch: async (url: string, init: Json) => {
    const shown: Json = {}
    if (init.headers) shown.headers = init.headers
    shown.signal = init.signal !== undefined
    const agent = init.dispatcher as FakeAgent | undefined
    shown.pinned = agent ? agent.pinned(new URL(url).hostname.toLowerCase()) : null
    box.log(['undici.fetch', url, shown])
    const page = asObject(asObject(box.d1.network)[url])
    if (Object.keys(page).length === 0) throw new TypeError('fetch failed')
    if (typeof page.throws === 'string') throw new Error(page.throws)
    const body = page.body
    const chunks = typeof body === 'string' ? [body] : Array.isArray(body) ? (body as string[]) : []
    const resp = new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(Buffer.from(chunk))
          controller.close()
        },
      }),
      {
        status: typeof page.status === 'number' ? page.status : 200,
        headers: asObject(page.headers) as Record<string, string>,
      },
    )
    Object.defineProperty(resp, 'url', { value: url })
    return resp
  },
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
const UTILS_PATH = '/packages/electron-utils/src/'
/** what electron-utils' `safe-remote-url` imports from the network: ES modules over the case's fakes */
const NETWORK: Record<string, string> = {
  undici: [
    `const u = ${SELF}.undici`,
    'export const fetch = (...a) => u.fetch(...a)',
    'export const getGlobalDispatcher = () => u.getGlobalDispatcher()',
    'export const Agent = u.Agent',
  ].join('\n'),
  'node:dns/promises': `export const lookup = (...a) => ${SELF}.dnsLookup(...a)`,
}

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (parent.includes(UTILS_PATH) && specifier in NETWORK) {
      return { url: `${FAKE}net?name=${encodeURIComponent(specifier)}`, shortCircuit: true }
    }
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
    if (url.startsWith(`${FAKE}net?`)) {
      const name = new URL(url).searchParams.get('name')!
      return { format: 'module', shortCircuit: true, source: NETWORK[name] }
    }
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
            if (args.length === 0) super(clock as number)
            else super(...(args as [number]))
          }
          static override now(): number {
            return clock
          }
        } as DateConstructor)
      : RealDate
  box.openQueue = (
    Array.isArray(box.d1.openXmind) ? [...(box.d1.openXmind as Json[])] : []
  ) as Json[]
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
  box.main = main
  box.queries = queries
  pending = []

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

  // the views the shell made (`open` absent: none)
  const open: OpenEntry[] = Array.isArray(box.d1.open) ? (box.d1.open as OpenEntry[]) : []
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

/** The TypeScript half of `probe_trigger` (mindmap/mod.rs): the exported function each trigger is named after */
export const mindmapTriggers: NonNullable<Group['triggers']> = {
  'd1/mindmap:requestMindmapSave': (cx, view, args) =>
    main().requestMindmapSave(cx.contents(view) as never, args[0] === 'saveAs' ? 'saveAs' : 'save'),
  'd1/mindmap:requestMindmapClose': (cx, view, args) =>
    main().requestMindmapClose(
      cx.contents(view) as never,
      args[0] === true
        ? (cx.electron.BrowserWindow as { fromWebContents(wc: unknown): never }).fromWebContents(
            cx.contents(view),
          )
        : undefined,
    ),
  'd1/mindmap:mindmapSaveToPath': (cx, view, args) =>
    main().mindmapSaveToPath(cx.contents(view) as never, text(args[0])),
  'd1/mindmap:mindmapFileRenamed': (cx, view, args) =>
    main().mindmapFileRenamed(cx.contents(view) as never, text(args[0]), text(args[1])),
  'd1/mindmap:sendMindmapMenuCommand': (cx, view, args) =>
    main().sendMindmapMenuCommand(cx.contents(view) as never, text(args[0]) as never),
  'd1/mindmap:sendMindmapExportRequest': (cx, view, args) =>
    main().sendMindmapExportRequest(cx.contents(view) as never, text(args[0]) as never),
  'd1/mindmap:mindmapReadOutline': (cx, view) =>
    queries().mindmapReadOutline(cx.contents(view) as never),
  'd1/mindmap:mindmapReadBytes': (cx, view) =>
    queries().mindmapReadBytes(cx.contents(view) as never),
  'd1/mindmap:writeMindmapCopiesNow': (_cx, _view, args) =>
    main().writeMindmapCopiesNow(typeof args[0] === 'number' ? args[0] : 5000),
  'd1/mindmap:discardMindmapRecovery': (cx, view) =>
    main().discardMindmapRecovery(cx.contents(view) as never),
  'd1/mindmap:mindmapFilePath': (_cx, view) => main().mindmapFilePath(view),
  'd1/mindmap:mindmapIsDirty': (_cx, view) => main().mindmapIsDirty(view),
  /** not a TypeScript function: time passes (the Rust side runs the timers due within it) */
  'd1/mindmap:advanceClock': (_cx, _view, args) =>
    advanceClock(typeof args[0] === 'number' ? args[0] : 0),
}

const main = (): typeof MindmapMain => box.main as typeof MindmapMain
const queries = (): typeof McpQueries => box.queries as typeof McpQueries
