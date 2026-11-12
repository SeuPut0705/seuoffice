/**
 * `open_documents` close on a PDF tab that has a crash-recovery copy, through
 * the shell's control, the shell's recovery routing and the PDF editor's real
 * main-process module. Only Electron and the other editors are stand-ins; the
 * recovery store is the real one over a throwaway folder.
 *
 * What is pinned here: a close with unsaved:"discard" drops the copy the way
 * the close prompt's "Don't Save" does (nothing left for the launch list, no
 * question on the next open, the file opens as saved), and a refused
 * save-close leaves the tab and its copy alone.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

type IpcHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
const showMessageBox = vi.fn()

interface FakeWebContents {
  id: number
  listeners: Map<string, () => void>
  sentArgs: [string, ...unknown[]][]
  destroyed: boolean
  once: (event: string, handler: () => void) => void
  on: (event: string, handler: () => void) => void
  setWindowOpenHandler: () => void
  loadURL: () => void
  isDestroyed: () => boolean
  reload: () => void
  send: (channel: string, ...args: unknown[]) => void
}

let nextWcId = 1

function makeFakeWebContents(): FakeWebContents {
  const listeners = new Map<string, () => void>()
  const wc: FakeWebContents = {
    id: nextWcId++,
    listeners,
    sentArgs: [],
    destroyed: false,
    once: (event, handler) => void listeners.set(event, handler),
    on: (event, handler) => void listeners.set(event, handler),
    setWindowOpenHandler: () => {},
    loadURL: () => {},
    isDestroyed: () => wc.destroyed,
    reload: () => {},
    send: (channel, ...args) => void wc.sentArgs.push([channel, ...args]),
  }
  return wc
}

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => {})),
    getPath: (name: string) => join(tmpdir(), `shell-pdf-discard-test-${name}`),
    getLocale: () => 'en-US',
  },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
  shell: {},
  webContents: { fromId: () => undefined },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
  },
  WebContentsView: class {
    webContents = makeFakeWebContents()
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    removeHandler: vi.fn(),
  },
}))

// the shell's recovery routing reaches every editor; only the PDF editor is real here
vi.mock('../../../docs/src/main/docs-main', () => ({
  discardDocsRecovery: vi.fn(),
  docsRecoveryIdentity: () => null,
}))
vi.mock('../../../sheets/src/main/sheets-main', () => ({
  createSheetsView: vi.fn(),
  discardSheetsRecovery: vi.fn(),
  migrateSheetsLegacyRecovery: vi.fn(),
  sheetsRecoveryIdentity: () => null,
}))
vi.mock('../../../slides/src/main/slides-main', () => ({ slidesRecoveryIdentity: () => null }))
vi.mock('../../../markdown/src/main/markdown-main', () => ({
  markdownRecoveryIdentity: () => null,
  setMarkdownRecoveryTitleSource: vi.fn(),
}))
vi.mock('../../../html/src/main/html-main', () => ({
  htmlRecoveryIdentity: () => null,
  setHtmlRecoveryTitleSource: vi.fn(),
}))
vi.mock('../../../mindmap/src/main/mindmap-main', () => ({
  discardMindmapRecovery: vi.fn(),
  mindmapRecoveryIdentity: () => null,
  setMindmapRecoveryTitleHook: vi.fn(),
}))
vi.mock('../../../hwp/src/main/hwp-main', () => ({
  hwpDiscardRecoveryCopy: vi.fn(),
  hwpRecoveryIdentity: () => null,
  setHwpRecoveryTitle: vi.fn(),
}))
vi.mock('../../../diagram/src/main/diagram-main', () => ({
  discardDiagramRecovery: vi.fn(),
  diagramRecoveryIdentity: () => null,
  setDiagramRecoveryTitleHook: vi.fn(),
}))
vi.mock('../../src/main/tab-manager', () => ({ createPlainEditorView: vi.fn() }))

import type { WebContents } from 'electron'
import {
  createRecoveryStore,
  newUntitledRecoveryId,
  recoveryEditor,
  type RecoveryStore,
} from '@seuoffice/electron-utils'
import {
  configurePdfRuntime,
  createPdfView,
  setPdfRecoveryStore,
} from '../../../pdf/src/main/pdf-main'
import { PDF_CHANNELS } from '../../../pdf/src/shared/ipc'
import type { SavePdfRequest } from '../../../pdf/src/shared/ipc'
import type { OpenDocumentTab } from '../../src/shared/tabs-api'
import { createOpenDocumentsControl } from '../../src/main/mcp/open-documents-bridge'
import { createOpenDocumentTools } from '../../src/main/mcp/tools/open-documents-tools'
import { discardEditorRecovery } from '../../src/main/recovery-shell'

const tempDirs = new Set<string>()
let store: RecoveryStore

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

/** a two-page document with stable bytes */
async function pdfBytes(): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false })
  doc.addPage([300, 400])
  doc.addPage([300, 400])
  return Buffer.from(await doc.save({ useObjectStreams: false }))
}

async function makePdfFile(): Promise<string> {
  const path = join(makeDir('shell-pdf-discard-doc-'), 'report.pdf')
  writeFileSync(path, await pdfBytes())
  return path
}

const invoke = <T>(channel: string, wc: FakeWebContents, ...args: unknown[]) =>
  handlers.get(channel)!({ sender: wc }, ...args) as Promise<T>

const consumePending = (wc: FakeWebContents) =>
  invoke<string | null>(PDF_CHANNELS.consumePending, wc)
const readView = async (wc: FakeWebContents, path: string) =>
  Buffer.from(await invoke<ArrayBuffer>(PDF_CHANNELS.readFile, wc, path))
/** the renderer's copy round: what a save of the edits on screen would write */
const writeCopy = (wc: FakeWebContents, request: SavePdfRequest) =>
  invoke<string>(PDF_CHANNELS.recoveryWriteCopy, wc, request)
const markDirty = (wc: FakeWebContents) =>
  handlers.get(PDF_CHANNELS.dirtyChanged)!({ sender: wc }, true)

/** a note the user drew on the first page and has not saved */
const notedRequest = (path: string): SavePdfRequest => ({
  path,
  markups: [
    {
      pageIndex: 0,
      type: 'highlight',
      color: [1, 0.87, 0.35],
      quads: [[50, 120, 200, 120, 50, 100, 200, 100]],
    },
  ],
  drawings: [],
  formValues: [],
  stamps: [],
})

/** a view the shell opened on `path` whose renderer asked for its file and read it */
async function openedView(path: string): Promise<FakeWebContents> {
  const wc = createPdfView(path).webContents as unknown as FakeWebContents
  const pending = await consumePending(wc)
  if (pending) await readView(wc, pending)
  return wc
}

/** a PDF tab with an unsaved note whose recovery copy is on disk */
async function notedView(path: string): Promise<FakeWebContents> {
  const wc = await openedView(path)
  expect(await writeCopy(wc, notedRequest(path))).toBe('written')
  markDirty(wc)
  return wc
}

const fileIdentity = (path: string) => ({ kind: 'pdf' as const, filePath: path })

function pdfTab(overrides: Partial<OpenDocumentTab> = {}): OpenDocumentTab {
  return { id: 't1', kind: 'pdf', title: 'report.pdf', active: true, dirty: true, ...overrides }
}

/** the control as the shell wires it; removing the tab destroys its view */
function harness(
  contents: FakeWebContents,
  docTab: OpenDocumentTab,
): {
  run: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
  closed: string[]
} {
  const closed: string[] = []
  const saveDir = makeDir('shell-pdf-discard-default-')
  const control = createOpenDocumentsControl({
    list: async () => [docTab],
    webContentsFor: () => contents as unknown as WebContents,
    closeTab: (id) => {
      closed.push(id)
      contents.destroyed = true
      contents.listeners.get('destroyed')?.()
      return true
    },
    recoveryDiscard: (tab, wc) => discardEditorRecovery(tab.kind, wc),
    defaultSaveDir: () => saveDir,
  })
  const [tool] = createOpenDocumentTools({ control, defaultSaveDir: () => saveDir })
  return { run: async (args) => (await tool!.handler(args)) as Record<string, unknown>, closed }
}

beforeEach(() => {
  store = createRecoveryStore({ userDataDir: makeDir('shell-pdf-discard-data-') })
  setPdfRecoveryStore(store)
  showMessageBox.mockReset()
})

afterEach(() => {
  setPdfRecoveryStore(undefined)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

describe('open_documents close on a PDF tab with a recovery copy', () => {
  it('discard drops the copy: nothing to restore at the next launch or the next open', async () => {
    const path = await makePdfFile()
    const original = readFileSync(path)
    const wc = await notedView(path)
    expect(store.listCopies()).toHaveLength(1)
    const { run, closed } = harness(wc, pdfTab({ filePath: path }))

    const result = await run({ action: 'close', target: path, unsaved: 'discard' })
    expect(result).toMatchObject({ closed: true, discardedUnsavedChanges: true })
    expect(closed).toEqual(['t1'])

    // nothing for the launch list to offer back
    expect(store.copyInfo(fileIdentity(path))).toBeNull()
    expect(store.listCopies()).toEqual([])
    expect(store.hasUnresolvedCopies()).toBe(false)
    // the file was never written, and opening it again asks no recovery question
    expect(readFileSync(path).equals(original)).toBe(true)
    const again = createPdfView(path).webContents as unknown as FakeWebContents
    expect(await consumePending(again)).toBe(path)
    expect(showMessageBox).not.toHaveBeenCalled()
    expect((await readView(again, path)).equals(original)).toBe(true)
  })

  it('a copy round still under way when the tab is discarded leaves nothing behind', async () => {
    const path = await makePdfFile()
    const wc = await notedView(path)
    const { run } = harness(wc, pdfTab({ filePath: path }))

    // the renderer's next round started before the close and lands after the discard
    const late = writeCopy(wc, notedRequest(path))
    await run({ action: 'close', target: path, unsaved: 'discard' })

    expect(await late).toBe('superseded')
    expect(store.listCopies()).toEqual([])
  })

  it('discard drops the copy of an untitled PDF restored from one', async () => {
    const copy = { kind: 'pdf' as const, untitledId: newUntitledRecoveryId(), ext: '.pdf' }
    await store.writeCopy(copy, await pdfBytes(), { title: 'Draft' })
    configurePdfRuntime({ preloadPath: '' })
    const wc = createPdfView(null).webContents as unknown as FakeWebContents
    expect(await consumePending(wc)).toBeNull()
    await recoveryEditor('pdf')!.openUntitledCopy(wc as never, { copy, title: 'Draft' })
    const working = (await consumePending(wc))!
    await readView(wc, working)
    expect(await writeCopy(wc, notedRequest(working))).toBe('written')
    markDirty(wc)
    expect(store.listCopies({ untitled: true })).toHaveLength(1)
    const { run, closed } = harness(wc, pdfTab({ title: 'Draft' }))

    await run({ action: 'close', target: 't1', unsaved: 'discard' })
    expect(closed).toEqual(['t1'])
    expect(store.copyInfo(copy)).toBeNull()
    expect(store.listCopies()).toEqual([])
  })

  it('a refused save-close keeps the tab, its copy and the copies that follow', async () => {
    const path = await makePdfFile()
    const wc = await notedView(path)
    const { run, closed } = harness(wc, pdfTab({ filePath: path }))

    await expect(run({ action: 'close', target: path })).rejects.toThrow(/unsaved:"discard"/)
    await expect(run({ action: 'close', target: path, unsaved: 'save' })).rejects.toThrow(
      /unsaved:"discard"/,
    )
    expect(closed).toEqual([])
    expect(store.copyInfo(fileIdentity(path))).not.toBeNull()
    expect(wc.sentArgs.map(([channel]) => channel)).not.toContain(PDF_CHANNELS.recoveryDropped)
    expect(await writeCopy(wc, notedRequest(path))).toBe('written')
  })
})
