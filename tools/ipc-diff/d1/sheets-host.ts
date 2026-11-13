/**
 * The TypeScript half of crates/shell-ipc/d1/src/sheets/fakes.rs: loads the
 * sheets editor's main process (`apps/sheets/src/main/sheets-main.ts`) on the
 * case's fake Electron and redirects what the Rust `WorkbookEngine`,
 * `SheetsShell` and `ScreenCapture` stand for to fakes that answer from
 * `hosts.d1.sheets` and log the same lines (the table in fakes.rs):
 *
 * - `./xlsx-sidecar-client` is a fake client (`xlsx.*`); the gateway readers
 *   and writers sheets-main calls on top of it (`xlsx-package-io`, the pivot,
 *   slicer, connection and query readers, the CSV importers, `./legacy-import`,
 *   `./workbook-redactions`, `office-encryption`, `remote-table`) are wrapper
 *   modules over the real ones with the calls the Rust trait methods stand
 *   for replaced;
 * - `node:crypto`'s `randomUUID` counts up (`11111111-0000-4000-8000-…`), the
 *   clock is `hosts.d1.sheets.clock`, and the recovery store's run id is fixed,
 *   so every name made from them is the same on both sides;
 * - the hooks the shell sets (`setSheets*Hook`, the runtime's project folder
 *   functions) log and answer;
 * - the tabs the shell made are made with `createSheetsView()`, and what it
 *   set up before the renderer's first call with the module's exported
 *   functions (`hosts.d1.sheets.startup`, fakes.rs).
 *
 * Every file of `apps/sheets/src/main` is loaded afresh for each case, so its
 * module state starts over.
 */
import { createRequire, registerHooks } from 'node:module'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setUiLang } from '@seuoffice/i18n'
import { useElectron } from '../../main-diff/electron-fake.ts'
import type * as SheetsMain from '../../../apps/sheets/src/main/sheets-main.ts'
import type { FakeContents } from '../fakes.ts'
import type { LoadContext } from '../types.ts'

const RealDate = Date
const req = createRequire(import.meta.url)
const { setHeadlessMode, setOpenPathProbe } = req(
  '@seuoffice/electron-utils',
) as typeof import('@seuoffice/electron-utils')
const root = resolve(import.meta.dirname, '../../..')
const MAIN = 'apps/sheets/src/main'
const MAIN_PATH = `/${MAIN}/`
const KEY = Symbol.for('ipc-diff.d1.sheets')

type Json = Record<string, unknown>

interface Box {
  /** `hosts.d1.sheets` */
  d1: Json
  log: (line: unknown[]) => void
  sessions: number
  uuids: number
  /** the snapshot the last archive read named: the gateway readers do not get it */
  lastSnapshot: string
  exitListeners: (() => void)[]
  [name: string]: unknown
}
const box: Box = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  d1: {},
  log: () => {},
  sessions: 0,
  uuids: 0,
  lastSnapshot: '',
  exitListeners: [],
}) as Box

const asObject = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {})
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

/** the work folder of an ODS export has the process's temp folder and a random suffix */
const scrub = (path: string): string => path.replace(/^.*seuoffice-ods-export-[^/]+/, '<ods>')

const fails = (name: string): void => {
  const message = asObject(box.d1[name]).error
  if (typeof message === 'string') throw new Error(message)
}
const answer = (name: string): unknown => (name in box.d1 ? box.d1[name] : { fake: name })

// ---- the sidecar client ----

box.client = {
  async open(path: string, locale: string, shortDate: string) {
    box.log(['xlsx.open', scrub(path), locale, shortDate])
    fails('open')
    const id = `00000000-0000-4000-8000-${String(++box.sessions).padStart(12, '0')}`
    return {
      sessionId: id,
      name: basename(path),
      entryCount: 1,
      sheets: [box.d1.sheet ?? { id: 's1', name: 'Sheet1' }],
      styles: [],
      dxfStyles: [],
      visuals: [],
      definedNames: [],
    }
  },
  async close(id: string) {
    box.log(['xlsx.close', id])
  },
  async readRange() {
    box.log(['xlsx.readRange'])
    fails('readRange')
    return answer('readRange')
  },
  async readFormulaCells() {
    box.log(['xlsx.readFormulaCells'])
    return answer('readFormulaCells')
  },
  async findCells() {
    box.log(['xlsx.findCells'])
    return answer('findCells')
  },
  async readRowOutline() {
    box.log(['xlsx.readRowOutline'])
    return answer('readRowOutline')
  },
  async readMedia() {
    box.log(['xlsx.readMedia'])
    return answer('readMedia')
  },
  async listExternalLinks(input: { path: string; baseDir: string }) {
    box.log(['xlsx.listExternalLinks', input.path, input.baseDir])
    return answer('listExternalLinks')
  },
  async updateExternalLinks(input: { path: string; baseDir: string }) {
    box.log(['xlsx.updateExternalLinks', input.path, input.baseDir])
    return answer('updateExternalLinks')
  },
  async readExternalLinkUsage(input: { path: string }) {
    box.log(['xlsx.readExternalLinkUsage', input.path])
    return answer('readExternalLinkUsage')
  },
  async recalcCells(input: { path: string; edits: Json[]; reads: unknown[] }) {
    box.log(['xlsx.recalcCells', input.path, input.edits.length, input.reads.length])
    return {
      cells: input.edits.map((edit) => {
        const typed = text(edit.input)
        const number = Number(typed)
        return {
          sheet: edit.sheet,
          row: edit.row,
          column: edit.column,
          formatted: typed,
          ...(typed.trim() !== '' && Number.isFinite(number) ? { number } : {}),
          isFormula: typed.startsWith('='),
        }
      }),
    }
  },
  async archiveManifest(snapshot: string) {
    box.lastSnapshot = snapshot
    const slicers = Array.isArray(box.d1.readSlicerState) && box.d1.readSlicerState.length > 0
    return {
      entries: [
        { name: 'xl/workbook.xml' },
        ...(slicers ? [{ name: 'xl/slicers/slicer1.xml' }] : []),
      ],
    }
  },
  async convertWorkbook(input: { path: string; targetPath: string }) {
    box.log(['xlsx.convertWorkbook', scrub(input.path), scrub(input.targetPath)])
    fails('convertWorkbook')
    writeFileSync(input.targetPath, 'xlsx')
    return { sheets: 1, cells: 0 }
  },
  async convertToOds(input: { path: string; targetPath: string }) {
    box.log(['xlsx.convertToOds', scrub(input.path), scrub(input.targetPath)])
    fails('convertToOds')
    writeFileSync(input.targetPath, 'ods')
    const scripted = asObject(box.d1.convertToOds)
    const counts = asObject(scripted.dropped)
    const dropped: Record<string, number> = {}
    for (const kind of [
      'macros',
      'charts',
      'images',
      'shapes',
      'conditionalFormats',
      'validations',
      'pivots',
      'slicers',
      'sparklines',
      'comments',
    ]) {
      dropped[kind] = typeof counts[kind] === 'number' ? (counts[kind] as number) : 0
    }
    return {
      formulasDropped: typeof scripted.formulasDropped === 'number' ? scripted.formulasDropped : 0,
      dropped,
    }
  },
}

// ---- the gateway readers (the wrappers' overrides) ----

box.saveWorkbookViaSidecar = async (input: { sourcePath: string; targetPath: string }) => {
  box.log(['xlsx.writeWorkbook', scrub(input.sourcePath), scrub(input.targetPath)])
  fails('writeWorkbook')
  writeFileSync(
    input.targetPath,
    Buffer.concat([readFileSync(input.sourcePath), Buffer.from('+edits')]),
  )
  return { touchedEntries: ['xl/worksheets/sheet1.xml'] }
}
box.promoteFileAtomically = async (from: string, to: string) => {
  box.log(['xlsx.promoteFileAtomically', scrub(from), scrub(to)])
  renameSync(from, to)
}
box.readArchiveEntryText = async (_client: unknown, snapshot: string, entry: string) => {
  box.lastSnapshot = snapshot
  return JSON.stringify({ snapshot, entry })
}
box.readArchiveEntriesText = async (_client: unknown, snapshot: string, wanted: string[]) => {
  box.lastSnapshot = snapshot
  return new Map(wanted.map((name) => [name, '']))
}
box.parsePivotDefinition = (pivotXml: string, cacheXml: string) => {
  const pivot = JSON.parse(pivotXml) as { snapshot: string; entry: string }
  const cache = JSON.parse(cacheXml) as { entry: string }
  box.log(['xlsx.readPivotDefinition', pivot.snapshot, pivot.entry, cache.entry])
  return answer('readPivotDefinition')
}
box.parseSlicerState = async () => {
  box.log(['xlsx.readSlicerState', box.lastSnapshot])
  return answer('readSlicerState')
}
box.refreshableQueriesOf = async () => {
  box.log(['xlsx.listConnections', box.lastSnapshot])
  return asObject(answer('listConnections')).connections
}
box.connectionSourceOf = async (_read: unknown, id: string) => {
  box.log(['xlsx.refreshConnection', box.lastSnapshot, id])
  return asObject(box.d1.refreshOutcome).unknown === true
    ? undefined
    : { url: 'http://example.test/t' }
}
box.fetchRemoteTable = async () =>
  asObject(box.d1.refreshOutcome).noTable === true ? null : answer('refreshConnection')
box.listWorkbookQueries = async () => {
  box.log(['xlsx.readQueries', box.lastSnapshot])
  return answer('readQueries')
}
box.readWorkbookRedactionPart = async (_client: unknown, snapshot: string) => {
  box.log(['xlsx.readRedactions', scrub(snapshot)])
  return 'readRedactions' in box.d1 ? box.d1.readRedactions : { status: 'absent' }
}
box.convertLegacyWorkbook = async (
  _client: unknown,
  source: string,
  target: string,
  charset?: string,
) => {
  box.log(['legacy.convertLegacyWorkbook', scrub(source), scrub(target), charset ?? null])
  fails('convertLegacyWorkbook')
  writeFileSync(target, 'xlsx')
  return { kind: 'workbook', formulasDropped: 0 }
}
// the delimited import is decoded and converted by one Rust trait method: the
// decoded text carries what the second call logs
box.decodeCsvBuffer = async (bytes: Buffer, charset?: string) =>
  JSON.stringify({ csv: bytes.byteLength, charset: charset ?? null })
box.csvToXlsxBufferForOpen = async (
  source: string,
  sheet: string,
  delimiter?: string,
  control?: { onProgress?: (progress: unknown) => void },
) => {
  if (source === '') {
    box.log(['csv.blankXlsx'])
    return { buffer: Buffer.from('xlsx'), empty: true }
  }
  const decoded = JSON.parse(source) as { csv: number; charset: string | null }
  box.log(['csv.csvToXlsxBufferForOpen', decoded.csv, decoded.charset, sheet, delimiter ?? null])
  if ('progress' in box.d1) control?.onProgress?.(box.d1.progress)
  return { buffer: Buffer.from('xlsx'), empty: decoded.csv === 0 }
}
box.sheetCsvToXlsxBuffer = async (content: string, sheet: string) => {
  box.log(['csv.sheetCsvToXlsxBuffer', content, sheet])
  return Buffer.from(`xlsx:${content}`)
}
const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
box.isCfbHeader = (head: Uint8Array) => Buffer.from(head).subarray(0, 8).equals(CFB)
box.isEncryptedOfficeFile = (bytes: Buffer) => Buffer.from(bytes).subarray(0, 8).equals(CFB)
box.encryptOoxml = (bytes: Buffer, password: string) => {
  box.log(['encryption.encryptOoxml', bytes.byteLength, password])
  return Buffer.concat([bytes, Buffer.from(`+enc:${password}`)])
}
box.unlockOfficeFile = async (bytes: Buffer, ask: (retry: boolean) => Promise<string | null>) => {
  box.log(['encryption.unlockOfficeFile', bytes.byteLength])
  const password = await ask(false)
  return password === null ? null : { bytes: Buffer.from('xlsx'), password, asked: true }
}
box.assertFileSaved = async (path: string) => {
  const unsaved = box.d1.unsaved
  if (Array.isArray(unsaved) && unsaved.includes(path))
    throw new Error('The file has unsaved changes.')
}
box.parseFileToText = async (path: string) => {
  box.log(['fileParse.parseFileToText', path])
  const scripted = asObject(asObject(box.d1.parse)[basename(path)])
  if (Object.keys(scripted).length > 0) return scripted
  try {
    return { ok: true, kind: 'text', text: readFileSync(path, 'utf8') }
  } catch {
    return { ok: false, error: 'unreadable' }
  }
}
// the diagram name of a picture the parser opens, by file name (the case's `pictureExt`)
box.diagramPictureExtOf = (path: string) => {
  const ext = asObject(box.d1.pictureExt)[basename(path)]
  return typeof ext === 'string' ? ext : null
}
box.randomUUID = () => `11111111-0000-4000-8000-${String(++box.uuids).padStart(12, '0')}`

const SELF = `globalThis[Symbol.for('ipc-diff.d1.sheets')]`
// the wrappers: the real module's exports, over which the fakes sit. They are
// CommonJS because the sheets files are compiled to it; every override is a
// getter, so a case's answers are read at each use
const WRAPPERS: Record<string, Record<string, string>> = {
  '@seuoffice/electron-utils': { assertFileSaved: `(p) => ${SELF}.assertFileSaved(p)` },
  '@seuoffice/electron-utils/office-encryption': {
    isCfbHeader: `(b) => ${SELF}.isCfbHeader(b)`,
    isEncryptedOfficeFile: `(b) => ${SELF}.isEncryptedOfficeFile(b)`,
    unlockOfficeFile: `(b, a) => ${SELF}.unlockOfficeFile(b, a)`,
    encryptOoxml: `(b, p) => ${SELF}.encryptOoxml(b, p)`,
  },
  '@seuoffice/electron-utils/remote-table': {
    fetchRemoteTable: `(s) => ${SELF}.fetchRemoteTable(s)`,
  },
  '@seuoffice/xlsx-gateway/gateway/csv-import': {
    decodeCsvBuffer: `(b, c) => ${SELF}.decodeCsvBuffer(b, c)`,
  },
  '@seuoffice/xlsx-gateway/gateway/csv-import-xlsx': {
    csvToXlsxBufferForOpen: `(...a) => ${SELF}.csvToXlsxBufferForOpen(...a)`,
    sheetCsvToXlsxBuffer: `(c, s) => ${SELF}.sheetCsvToXlsxBuffer(c, s)`,
  },
  '@seuoffice/xlsx-gateway/gateway/xlsx-package-io': {
    promoteFileAtomically: `(f, t) => ${SELF}.promoteFileAtomically(f, t)`,
    readArchiveEntriesText: `(...a) => ${SELF}.readArchiveEntriesText(...a)`,
    readArchiveEntryText: `(...a) => ${SELF}.readArchiveEntryText(...a)`,
    saveWorkbookViaSidecar: `(i) => ${SELF}.saveWorkbookViaSidecar(i)`,
  },
  '@seuoffice/xlsx-gateway/gateway/xlsx-connection-refresh': {
    connectionSourceOf: `(...a) => ${SELF}.connectionSourceOf(...a)`,
    refreshableQueriesOf: `(...a) => ${SELF}.refreshableQueriesOf(...a)`,
  },
  '@seuoffice/xlsx-gateway/gateway/xlsx-connections': {
    listWorkbookQueries: `(...a) => ${SELF}.listWorkbookQueries(...a)`,
  },
  '@seuoffice/xlsx-gateway/gateway/xlsx-pivot': {
    parsePivotDefinition: `(...a) => ${SELF}.parsePivotDefinition(...a)`,
  },
  '@seuoffice/xlsx-gateway/gateway/xlsx-slicer': {
    parseSlicerState: `(...a) => ${SELF}.parseSlicerState(...a)`,
  },
  'node:crypto': { randomUUID: `() => ${SELF}.randomUUID()` },
  '@seuoffice/file-parse': {
    parseFileToText: `(p) => ${SELF}.parseFileToText(p)`,
    diagramPictureExtOf: `(p) => ${SELF}.diagramPictureExtOf(p)`,
  },
  './workbook-redactions': {
    readWorkbookRedactionPart: `(...a) => ${SELF}.readWorkbookRedactionPart(...a)`,
  },
  './legacy-import': { convertLegacyWorkbook: `(...a) => ${SELF}.convertLegacyWorkbook(...a)` },
}

const CLIENT_METHODS = [
  'open',
  'close',
  'readRange',
  'readFormulaCells',
  'findCells',
  'readRowOutline',
  'readMedia',
  'listExternalLinks',
  'updateExternalLinks',
  'readExternalLinkUsage',
  'recalcCells',
  'archiveManifest',
  'convertWorkbook',
  'convertToOds',
]
const CLIENT_SOURCE = [
  `const box = ${SELF}`,
  'export class XlsxSidecarClient {',
  '  start() {}',
  '  stop() {}',
  '  onProcessExit(listener) { box.exitListeners.push(listener); return () => {} }',
  ...CLIENT_METHODS.map((m) => `  ${m}(...a) { return box.client.${m}(...a) }`),
  '}',
].join('\n')

function wrapperSource(name: string, real: string): string {
  const overrides = Object.entries(WRAPPERS[name]).map(
    ([key, expr]) =>
      `Object.defineProperty(out, ${JSON.stringify(key)}, { enumerable: true, get: () => ${expr} })`,
  )
  const target = real.startsWith('file:') ? fileURLToPath(real) : real
  return [
    `const real = require(${JSON.stringify(target)})`,
    'const out = { ...real }',
    ...overrides,
    "Object.defineProperty(out, '__esModule', { value: true })",
    'module.exports = out',
  ].join('\n')
}
const FAKE = 'ipc-diff-d1-sheets:'
const CLIENT = `${FAKE}client`
// `electron` of the sheets files: the shared fake's names, and two it does not
// carry (the screen capturer and the permission check), kept in the box
const ELECTRON = `${FAKE}electron`
const ELECTRON_SOURCE = [
  `const box = ${SELF}`,
  "export * from 'electron'",
  'export const systemPreferences = { getMediaAccessStatus: (...a) => box.systemPreferences.getMediaAccessStatus(...a) }',
  'export const desktopCapturer = { getSources: (...a) => box.desktopCapturer.getSources(...a) }',
].join('\n')

registerHooks({
  resolve(specifier, context, next) {
    const parent = context.parentURL ?? ''
    if (parent.includes(MAIN_PATH)) {
      if (specifier === './xlsx-sidecar-client') return { url: CLIENT, shortCircuit: true }
      if (specifier === 'electron') return { url: ELECTRON, shortCircuit: true }
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
    if (url === CLIENT) return { format: 'module', shortCircuit: true, source: CLIENT_SOURCE }
    if (url === ELECTRON) return { format: 'module', shortCircuit: true, source: ELECTRON_SOURCE }
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

interface Startup {
  queued?: { view: number; path: string }[]
  newBlank?: boolean
  untitled?: string[]
  mcpWritable?: { view: number; path: string }[]
  headless?: { view: number; input?: string; out: string }[]
}

export async function loadSheets(cx: LoadContext): Promise<void> {
  const e = cx.electron
  const d1 = asObject(asObject(cx.case.hosts).d1)
  box.d1 = asObject(d1.sheets)
  box.log = (line) => e.log.push(line)
  box.sessions = 0
  box.uuids = 0
  box.lastSnapshot = ''
  box.exitListeners = []
  // a case may fix the clock (`new Date()` and `Date.now()` answer it)
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
  // the recovery store's run id is the one the probe's recovery state has
  const holder = globalThis as unknown as Record<symbol, unknown>
  holder[Symbol.for('seuoffice.recovery-store.shared')] = {
    shuttingDown: false,
    epochs: new Map(),
    queues: new Map(),
    runId: '0000000000000000',
    discarded: new Set(),
  }

  const startup = asObject(box.d1.startup) as Startup
  const headless = startup.headless ?? []
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
  // the windows know the id the screen capturer lists them by
  const bw = e.BrowserWindow as Record<string, () => Record<string, unknown>[]>
  for (const win of bw.getAllWindows()) win.getMediaSourceId = () => `window:${win.id}`

  const bwStatics = e.BrowserWindow as Record<string, unknown>
  // the hidden window of `exportPdf` (no preload) prints the page it loaded; a
  // headless run's (preload) is the view the case made for it
  class FakeBrowserWindow {
    static getAllWindows = bwStatics.getAllWindows
    static fromWebContents = bwStatics.fromWebContents
    static fromId = bwStatics.fromId
    static getFocusedWindow = bwStatics.getFocusedWindow
    private destroyed = false
    webContents: FakeContents
    constructor(options?: { webPreferences?: { preload?: string } }) {
      this.webContents = options?.webPreferences?.preload
        ? e.contents(nextView)
        : ({
            id: 900,
            printToPDF: async () => {
              e.log.push(['pdf.renderPdf'])
              return Buffer.from('%PDF-1.7')
            },
          } as unknown as FakeContents)
    }
    async loadFile(): Promise<void> {}
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
      this.webContents = e.contents(nextView)
    }
  }
  const screenStatus = Array.isArray(box.d1.screenStatus)
    ? [...(box.d1.screenStatus as string[])]
    : []
  const sources = [
    { id: 'screen:0', name: 'Screen 1' },
    { id: 'window:1', name: 'Window 1' },
    { id: 'window:7', name: 'Notes' },
  ]
  const thumbnail = (size: { width: number; height: number }) => {
    const full = size.width !== 320
    return {
      isEmpty: () => !full,
      toDataURL: () => '',
      toPNG: () => Buffer.from('\x89PNG', 'latin1'),
      getSize: () => ({ width: 2, height: 1 }),
      resize: () => thumbnail(size),
    }
  }
  const app = e.app as Record<string, unknown>
  Object.assign(app, {
    getAppPath: () => '/app',
    getSystemLocale: () => 'en-US',
    getVersion: () => '0.0.0-test',
    commandLine: { appendSwitch() {} },
  })
  Object.assign(e, {
    BrowserWindow: FakeBrowserWindow,
    WebContentsView: FakeWebContentsView,
    screen: { getAllDisplays: () => [{ size: { width: 1, height: 1 }, scaleFactor: 1 }] },
  })
  box.systemPreferences = { getMediaAccessStatus: () => screenStatus.shift() ?? 'granted' }
  box.desktopCapturer = {
    getSources: async (options: { thumbnailSize: { width: number; height: number } }) =>
      sources.map((s) => ({ ...s, thumbnail: thumbnail(options.thumbnailSize) })),
  }
  useElectron(e)

  setUiLang('en')
  setHeadlessMode(box.d1.headless === true)
  const elsewhere = Array.isArray(box.d1.openElsewhere) ? (box.d1.openElsewhere as string[]) : []
  setOpenPathProbe((path: string) => elsewhere.includes(path))

  // the sheets files are CommonJS (tsx compiles them so), cached by file: a case
  // clears them, so its module state starts over, and loads them after the hooks
  const load = createRequire(`${root}/${MAIN}/sheets-main.ts`)
  for (const key of Object.keys(load.cache)) if (key.includes(MAIN_PATH)) delete load.cache[key]
  const main = load(`${root}/${MAIN}/sheets-main.ts`) as typeof SheetsMain

  const writer = box.d1.writeNewDocument
  const create = box.d1.createDocument
  main.configureSheetsRuntime({
    preloadPath: '/sheets/out/preload/index.js',
    rendererFile: '/sheets/out/renderer/index.html',
    openGeneratedPath: (path: string) => {
      e.log.push(['shell.openGeneratedPath', path])
      return false
    },
    newDocumentDir: async (id: number) => {
      e.log.push(['shell.newDocumentDir', id])
      const dir = box.d1.newDocumentDir
      return typeof dir === 'string' ? dir : null
    },
    writeNewDocument: async (id: number, fileName: string, bytes: Uint8Array) => {
      e.log.push(['shell.writeNewDocument', id, fileName, bytes.byteLength])
      const scripted = asObject(writer)
      if (typeof scripted.error === 'string') throw new Error(scripted.error)
      return typeof scripted.path === 'string' ? scripted.path : null
    },
    ...(create === undefined
      ? {}
      : {
          createDocument: async (_request: unknown, id?: number) => {
            e.log.push(['shell.createDocument', id])
            return create as never
          },
        }),
  })
  main.setSheetsWorkbookOpenedHook((wc, path) => {
    e.log.push(['shell.workbookOpened', wc.id, path])
  })
  main.setSheetsActivateTabHook((id) => {
    e.log.push(['shell.activateTab', id])
  })
  main.setSheetsPasswordPrompt((_parent, fileName) => {
    e.log.push(['shell.passwordPrompt', fileName])
    const password = box.d1.password
    return (
      typeof password === 'string' ? { ask: async () => password, close() {} } : undefined
    ) as never
  })

  // the tabs the shell made, in view order
  const running = new Set(headless.map((h) => h.view))
  for (const v of views) {
    if ((v.surface ?? 'Shell') !== 'Sheets' || running.has(v.view)) continue
    nextView = v.view
    main.createSheetsView({ includeAiHandlers: false })
  }
  // what the shell set up before the renderer's first call
  for (const q of startup.queued ?? [])
    main.queueWorkbookForView(e.contents(q.view) as never, q.path)
  if (startup.newBlank) main.setSheetsNewBlank()
  for (const path of startup.untitled ?? []) main.markSheetsUntitledPath(path)
  for (const m of startup.mcpWritable ?? []) main.authorizeMcpSheetWrite(m.view, m.path)
  for (const h of headless) {
    nextView = h.view
    void main.exportSheetsPdfHeadless(h.input ?? '', h.out, 60_000).catch(() => {})
  }
  if (typeof box.d1.importLimit === 'number') {
    const limit = load(`${root}/${MAIN}/csv-import-limit.ts`) as {
      setDelimitedImportLimit(bytes: number): void
    }
    limit.setDelimitedImportLimit(box.d1.importLimit)
  }
}
