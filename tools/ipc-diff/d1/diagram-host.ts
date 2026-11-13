/**
 * The TypeScript half of crates/shell-ipc/d1/src/diagram/fakes.rs: loads the
 * diagram editor's main process (`apps/diagram/src/main`) on the case's fake
 * Electron and redirects what the Rust `DiagramEngine` and `DiagramShell`
 * stand for to fakes that answer from `hosts.d1.diagram` and log the same
 * lines (see the table in fakes.rs):
 *
 * - `@seuoffice/drawio-model`'s `openDiagram`, `@seuoffice/file-parse`'s
 *   `parseFileToText` and `diagramPictureExtOf`, `@seuoffice/electron-utils`'s
 *   `assertFileSaved` and `node:crypto`'s `randomBytes` are replaced for the
 *   diagram's main files (a wrapper module that re-exports the real one);
 * - `./diagram-session` is replaced by a module that does nothing;
 * - the hooks the shell sets (`setDiagram*Hook`, the runtime's project
 *   folder functions) log and answer;
 * - the views the shell made are made with `createDiagramView(path)`, the
 *   headless job with `exportDiagramHeadless`.
 *
 * Every file of `apps/diagram/src/main` is loaded afresh for each case (they
 * are CommonJS: their entries are dropped from `require.cache` before the
 * case's load), so their module state starts over.
 */
import { createRequire, registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setUiLang } from '@seuoffice/i18n'
import { detectDiagramFormat } from '@seuoffice/drawio-model'
import { useElectron } from '../../main-diff/electron-fake.ts'
import type * as DiagramMain from '../../../apps/diagram/src/main/diagram-main.ts'
import type * as AiAttachments from '../../../apps/diagram/src/main/ai-attachments.ts'
import type * as Recovery from '../../../apps/diagram/src/main/recovery-main.ts'
import type * as PrintDocument from '../../../apps/diagram/src/main/print-document.ts'
import type * as Headless from '../../../apps/diagram/src/main/headless-main.ts'
import type { FakeContents } from '../fakes.ts'
import type { LoadContext } from '../types.ts'

const root = resolve(import.meta.dirname, '../../..')
// the diagram's main files are CommonJS: `require` gives the instances they use
const req = createRequire(import.meta.url)
const { setHeadlessMode, setOpenPathProbe } = req(
  '@seuoffice/electron-utils',
) as typeof import('@seuoffice/electron-utils')
const MAIN = 'apps/diagram/src/main'
const MAIN_PATH = `/${MAIN}/`
const KEY = Symbol.for('ipc-diff.d1.diagram')

type Json = Record<string, unknown>

interface Box {
  /** the case's number: the query of the files loaded for it */
  n: number
  /** `hosts.d1.diagram` */
  d1: Json
  log: (line: unknown[]) => void
  /** the view the next `WebContentsView` or hidden window is made for */
  nextView?: number
  tokens: number
  [name: string]: unknown
}
const box: Box = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  n: 0,
  d1: {},
  log: () => {},
  tokens: 0,
}) as Box

const asObject = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})

box.openDiagram = (name: string, bytes: Uint8Array) => {
  box.log(['drawio.openDiagram', name, bytes.byteLength])
  const scripted = asObject(asObject(box.d1.openDiagram)[name])
  if (Object.keys(scripted).length > 0) {
    if (scripted.ok !== true) {
      return { ok: false, reason: String(scripted.reason ?? ''), message: String(scripted.message ?? '') }
    }
    return {
      ok: true,
      file: {
        xml: String(scripted.xml ?? ''),
        format: String(scripted.format ?? ''),
        root: String(scripted.root ?? ''),
        pages: scripted.anyPageCompressed === true ? [{ compressed: true }] : [],
      },
    }
  }
  const fail = (reason: string) => ({ ok: false, reason, message: reason })
  const format = detectDiagramFormat(name)
  if (format === null || format === 'vsdx') return fail('unsupported')
  if (format === 'drawio.svg' || format === 'drawio.png') return fail('no_original')
  let xml: string
  try {
    xml = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return fail('not_xml')
  }
  const rootName = xml.includes('<mxfile')
    ? 'mxfile'
    : xml.includes('<mxGraphModel')
      ? 'mxGraphModel'
      : undefined
  if (!rootName) return fail('no_diagram')
  return { ok: true, file: { xml, format, root: rootName, pages: [] } }
}

box.diagramPictureExtOf = (path: string) => {
  box.log(['fileParse.diagramPictureExtOf', path])
  const ext = asObject(box.d1.pictureExt)[basename(path)]
  return typeof ext === 'string' ? ext : null
}

box.parseFileToText = async (path: string) => {
  box.log(['fileParse.parseFileToText', path])
  const scripted = asObject(asObject(box.d1.parseFileToText)[basename(path)])
  if (Object.keys(scripted).length > 0) return scripted
  try {
    return { ok: true, kind: 'text', text: readFileSync(path, 'utf8') }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

box.assertFileSaved = async (path: string) => {
  box.log(['electronUtils.assertFileSaved', path])
  const message = asObject(box.d1.unsaved)[basename(path)]
  if (typeof message === 'string') throw new Error(message)
}

box.randomBytes = (size: number) => {
  box.tokens++
  return Buffer.from(box.tokens.toString(16).padStart(size * 2, '0'), 'hex')
}

// the wrappers: the real module's exports, over which the fakes sit. The
// diagram's main files are CommonJS, so a wrapper is a CommonJS module.
const box_ = `globalThis[Symbol.for('ipc-diff.d1.diagram')]`
const FAKES: Record<string, string> = {
  '@seuoffice/drawio-model': `openDiagram: (name, bytes) => ${box_}.openDiagram(name, bytes)`,
  '@seuoffice/file-parse': `parseFileToText: (path) => ${box_}.parseFileToText(path), diagramPictureExtOf: (path) => ${box_}.diagramPictureExtOf(path)`,
  '@seuoffice/electron-utils': `assertFileSaved: (path) => ${box_}.assertFileSaved(path)`,
  'node:crypto': `randomBytes: (size) => ${box_}.randomBytes(size)`,
}
const wrapper = (name: string, real: string): string =>
  [
    `const real = require(${JSON.stringify(real.startsWith('file:') ? fileURLToPath(real) : real)})`,
    `module.exports = { ...real, ${FAKES[name]} }`,
    `Object.defineProperty(module.exports, '__esModule', { value: true })`,
  ].join('\n')
const FAKE = 'ipc-diff-d1:'
const SESSION_FAKE = `${FAKE}diagram-session`

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (parent.includes(MAIN_PATH)) {
      if (specifier === './diagram-session') return { url: SESSION_FAKE, shortCircuit: true }
      if (specifier in FAKES) {
        const real = next(specifier, context).url
        return { url: `${FAKE}wrap?name=${encodeURIComponent(specifier)}&real=${encodeURIComponent(real)}`, shortCircuit: true }
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === SESSION_FAKE) {
      return {
        format: 'module',
        shortCircuit: true,
        source:
          'export const diagramSession = () => ({})\nexport const diagramRequestLog = () => ({ allowed: 0, refused: 0, blocked: [], schemes: [] })',
      }
    }
    if (url.startsWith(`${FAKE}wrap?`)) {
      const params = new URL(url).searchParams
      return {
        format: 'commonjs',
        shortCircuit: true,
        source: wrapper(params.get('name')!, params.get('real')!),
      }
    }
    return next(url, context)
  },
})

export async function loadDiagram(cx: LoadContext): Promise<void> {
  const e = cx.electron
  const d1 = asObject(asObject(cx.case.hosts).d1)
  box.n++
  box.d1 = asObject(d1.diagram)
  box.log = (line) => e.log.push(line)
  box.tokens = 0
  box.nextView = undefined

  // what the shell's views and hidden windows are
  const views = cx.case.views ?? [{ view: 1 }]
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
  class FakeBrowserWindow {
    static getAllWindows = bw.getAllWindows
    static fromWebContents = bw.fromWebContents
    static fromId = bw.fromId
    static getFocusedWindow = bw.getFocusedWindow
    webContents: FakeContents
    private destroyed = false
    private html = ''
    constructor(options?: { webPreferences?: { preload?: string } }) {
      // a hidden window of a job has the preload; the print window has none
      this.webContents = options?.webPreferences?.preload
        ? e.contents(box.nextView!)
        : (this.printContents() as unknown as FakeContents)
    }
    private printContents(): unknown {
      const self = this
      return {
        id: 900,
        setWindowOpenHandler() {},
        on() {},
        once() {},
        getURL: () => '',
        executeJavaScript: async () => undefined,
        printToPDF: async () => {
          e.log.push(['diagram.renderPdf', self.html])
          const hex = box.d1.pdf
          return typeof hex === 'string' ? Buffer.from(hex, 'hex') : Buffer.from('%PDF-fake')
        },
      }
    }
    async loadURL(url: string): Promise<void> {
      const token = url.split('/print/')[1]
      if (token === undefined) return
      const { takePrintDocument } = req(resolve(root, MAIN, 'print-document.ts')) as typeof PrintDocument
      this.html = takePrintDocument(token) ?? ''
    }
    isDestroyed = () => this.destroyed
    destroy = () => {
      this.destroyed = true
    }
    show() {}
    focus() {}
  }
  class FakeWebContentsView {
    webContents: FakeContents
    constructor() {
      this.webContents = e.contents(box.nextView!)
    }
  }
  Object.assign(e, { BrowserWindow: FakeBrowserWindow, WebContentsView: FakeWebContentsView })
  useElectron(e)

  setUiLang('en')
  setHeadlessMode(box.d1.headless === true)
  const elsewhere = Array.isArray(box.d1.openElsewhere) ? (box.d1.openElsewhere as string[]) : []
  setOpenPathProbe((path: string) => {
    e.log.push(['electronUtils.isPathOpenElsewhere', path])
    return elsewhere.includes(path)
  })

  // the case's own instances of the diagram's files
  for (const key of Object.keys(req.cache)) if (key.includes(MAIN_PATH)) delete req.cache[key]
  const load = <T>(file: string): T => req(resolve(root, MAIN, file)) as T
  const main = load<typeof DiagramMain>('diagram-main.ts')
  const ai = load<typeof AiAttachments>('ai-attachments.ts')
  const recovery = load<typeof Recovery>('recovery-main.ts')
  const headless = load<typeof Headless>('headless-main.ts')

  const writer = box.d1.writeNewDocument
  main.configureDiagramRuntime({
    preloadPath: '/diagram/out/preload/index.js',
    newDocumentDir: async (id) => {
      e.log.push(['diagram.newDocumentDir', id])
      const dir = box.d1.newDocumentDir
      return typeof dir === 'string' ? dir : null
    },
    ...(writer === undefined || writer === null
      ? {}
      : {
          writeNewDocument: async (id: number, fileName: string, bytes: Uint8Array) => {
            e.log.push(['diagram.writeNewDocument', id, fileName, bytes.byteLength])
            const answer = asObject(writer)
            if (typeof answer.error === 'string') throw new Error(answer.error)
            return typeof answer.path === 'string' ? answer.path : null
          },
        }),
  })
  main.setDiagramFileSavedHook((wc, path) => {
    e.log.push(['diagram.fileSaved', wc.id, path])
  })
  main.setDiagramRecoveryTitleHook((wc) => {
    e.log.push(['diagram.recoveryTitle', wc.id])
    const title = box.d1.recoveryTitle
    return typeof title === 'string' ? title : null
  })
  main.setDiagramHelpHook((wc) => {
    e.log.push(['diagram.help', wc.id])
  })
  main.setDiagramOpenFailedHook((wc, message) => {
    e.log.push(['diagram.openFailed', wc.id, message])
    return box.d1.openFailed === true
  })
  ai.setDiagramProvisionalTitleHook((wc, title) => {
    e.log.push(['diagram.provisionalTitle', wc.id, title])
  })

  // the views the shell made (`open` absent: none)
  const open = Array.isArray(box.d1.open)
    ? (box.d1.open as { view: number; path?: string; decision?: 'restore' | 'original'; seed?: string }[])
    : []
  for (const entry of open) {
    box.nextView = entry.view
    main.createDiagramView(entry.path ?? null)
    if (entry.decision) recovery.setViewOpenDecision(entry.view, entry.decision)
    if (entry.seed !== undefined) main.queueDiagramSeedFor(e.contents(entry.view) as never, { xml: entry.seed })
  }
  const job = asObject(box.d1.headlessJob)
  if (typeof job.path === 'string') {
    box.nextView = job.view as number
    void headless.exportDiagramHeadless(job.path, resolve(cx.dir, 'headless-out.png'), 'png', {} as never).catch(() => {})
  }
}
