// @vitest-environment node
/**
 * The first explicit save of an untitled document (a recovered untitled copy,
 * a skill template's copy). It lives in a working file outside the user's
 * folders, and the save asks where the document goes. That is asked before
 * anything is written: cancelling leaves the edits pending and the document
 * unsaved, so the tab still asks before it closes. A page operation, a
 * conversion or a print that saves the pending edits first goes the same way.
 * The renderer's flow runs here against the main process's own handlers.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

type IpcHandler = (event: { sender: unknown }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
const showMessageBox = vi.fn()
const showSaveDialog = vi.fn()

interface FakeWebContents {
  id: number
  listeners: Map<string, () => void>
  once: (event: string, handler: () => void) => void
  on: (event: string, handler: () => void) => void
  setWindowOpenHandler: () => void
  loadURL: () => void
  isDestroyed: () => boolean
  reload: () => void
  send: () => void
}

let nextWcId = 1

vi.mock('electron', () => ({
  app: { on: vi.fn(), whenReady: vi.fn(() => new Promise(() => {})) },
  dialog: {
    showMessageBox: (...args: unknown[]) => showMessageBox(...args),
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...args),
  },
  shell: {},
  webContents: { fromId: () => undefined },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
  },
  WebContentsView: class {
    webContents: FakeWebContents = (() => {
      const listeners = new Map<string, () => void>()
      return {
        id: nextWcId++,
        listeners,
        once: (event: string, handler: () => void) => void listeners.set(event, handler),
        on: (event: string, handler: () => void) => void listeners.set(event, handler),
        setWindowOpenHandler: () => {},
        loadURL: () => {},
        isDestroyed: () => false,
        reload: () => {},
        send: () => {},
      }
    })()
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

import {
  createRecoveryStore,
  newUntitledRecoveryId,
  recoveryEditor,
  type RecoveryStore,
} from '@genoffice/electron-utils'
import {
  configurePdfRuntime,
  createPdfView,
  requestPdfClose,
  setPdfRecoveryStore,
} from '../src/main/pdf-main'
import { saveUntitledCopy, type UntitledSaveApi } from '../src/renderer/untitled-save'
import { PDF_CHANNELS } from '../src/shared/ipc'
import type { SavePdfRequest, SavePdfResult } from '../src/shared/ipc'

const tempDirs = new Set<string>()
let store: RecoveryStore

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

beforeEach(() => {
  store = createRecoveryStore({ userDataDir: makeDir('pdf-first-save-data-') })
  setPdfRecoveryStore(store)
  showMessageBox.mockReset()
  showSaveDialog.mockReset()
})

afterEach(() => {
  setPdfRecoveryStore(undefined)
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

const pageCount = async (path: string) =>
  (await PDFDocument.load(readFileSync(path))).getPageCount()

/** A recovered untitled two-page document in its tab, with the second page deleted on screen */
async function untitledDocument() {
  const bytes = await PDFDocument.create({ updateMetadata: false }).then((doc) => {
    doc.addPage([300, 400])
    doc.addPage([300, 400])
    return doc.save({ useObjectStreams: false })
  })
  const copy = { kind: 'pdf' as const, untitledId: newUntitledRecoveryId(), ext: '.pdf' }
  await store.writeCopy(copy, Buffer.from(bytes), { title: 'Draft' })
  configurePdfRuntime({ preloadPath: '' })
  const view = createPdfView(null).webContents as unknown as FakeWebContents
  const call = <T>(channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!({ sender: view }, ...args)) as Promise<T>
  await call(PDF_CHANNELS.consumePending)
  const folder = makeDir('pdf-first-save-docs-')
  await recoveryEditor('pdf')!.openUntitledCopy(view as never, {
    copy,
    title: 'Draft',
    saveAsDefaultPath: join(folder, 'Draft.pdf'),
  })
  const working = (await call<string | null>(PDF_CHANNELS.consumePending))!
  await call(PDF_CHANNELS.readFile, working)
  // the renderer tells the main process of its pending edit
  handlers.get(PDF_CHANNELS.dirtyChanged)!({ sender: view }, true)

  const api: UntitledSaveApi = {
    pickUntitledCopyTarget: (path, name) => call(PDF_CHANNELS.pickUntitledCopyTarget, path, name),
    adoptUntitledCopy: (path) => call(PDF_CHANNELS.adoptUntitledCopy, path),
  }
  /** the save of the pending edit into the file the view shows */
  const saveEdits = vi.fn(async () => {
    const request: SavePdfRequest = {
      path: working,
      markups: [],
      drawings: [],
      formValues: [],
      stamps: [],
      deletedPages: [1],
    }
    return (await call<SavePdfResult>(PDF_CHANNELS.save, request)).ok
  })
  return { view, call, working, folder, api, saveEdits, before: readFileSync(working) }
}

describe('the first save of an untitled document', () => {
  it('asks where it goes before anything is written', async () => {
    const doc = await untitledDocument()
    const target = join(doc.folder, 'Report.pdf')
    const atTheDialog: Array<{ savesSoFar: number; workingFileUntouched: boolean }> = []
    showSaveDialog.mockImplementationOnce(async () => {
      atTheDialog.push({
        savesSoFar: doc.saveEdits.mock.calls.length,
        workingFileUntouched: readFileSync(doc.working).equals(doc.before),
      })
      return { canceled: false, filePath: target }
    })

    expect(await saveUntitledCopy(doc.api, doc.working, 'Draft.pdf', doc.saveEdits)).toBe(target)

    expect(atTheDialog).toEqual([{ savesSoFar: 0, workingFileUntouched: true }])
    expect(showSaveDialog.mock.calls[0]!.at(-1)).toMatchObject({
      defaultPath: join(doc.folder, 'Draft.pdf'),
    })
    // the edit is in the picked file, which is this tab's document now
    expect(await pageCount(target)).toBe(1)
    expect(await doc.call(PDF_CHANNELS.isUntitledCopy, target)).toBe(false)
    await expect(doc.call(PDF_CHANNELS.readFileChunk, target, 0, 64)).resolves.toMatchObject({
      fileSize: readFileSync(target).byteLength,
    })
    await vi.waitFor(() => expect(existsSync(doc.working)).toBe(false))
  })

  it('writes nothing when the person cancels: the edit stays pending, the document unsaved', async () => {
    const doc = await untitledDocument()
    showSaveDialog.mockResolvedValueOnce({ canceled: true })

    expect(await saveUntitledCopy(doc.api, doc.working, 'Draft.pdf', doc.saveEdits)).toBeNull()

    expect(doc.saveEdits).not.toHaveBeenCalled()
    expect(readFileSync(doc.working).equals(doc.before)).toBe(true)
    expect(await doc.call(PDF_CHANNELS.isUntitledCopy, doc.working)).toBe(true)
    expect(await doc.call(PDF_CHANNELS.recoveryState, doc.working)).toEqual({ unsaved: true })
    // closing the tab still asks; Cancel there keeps the tab and its document
    showMessageBox.mockResolvedValueOnce({ response: 2 })
    expect(await requestPdfClose(doc.view as never)).toBe(false)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(existsSync(doc.working)).toBe(true)
    expect(store.listCopies({ untitled: true })).toHaveLength(1)
  })

  it('asks again on the next save after a cancel', async () => {
    const doc = await untitledDocument()
    const target = join(doc.folder, 'Report.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: true })
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })

    expect(await saveUntitledCopy(doc.api, doc.working, 'Draft.pdf', doc.saveEdits)).toBeNull()
    expect(await saveUntitledCopy(doc.api, doc.working, 'Draft.pdf', doc.saveEdits)).toBe(target)

    expect(showSaveDialog).toHaveBeenCalledTimes(2)
    expect(doc.saveEdits).toHaveBeenCalledTimes(1)
    expect(await pageCount(target)).toBe(1)
  })

  it('does not move the document when the edits could not be saved', async () => {
    const doc = await untitledDocument()
    const target = join(doc.folder, 'Report.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })

    expect(await saveUntitledCopy(doc.api, doc.working, 'Draft.pdf', async () => false)).toBeNull()

    expect(existsSync(target)).toBe(false)
    expect(await doc.call(PDF_CHANNELS.isUntitledCopy, doc.working)).toBe(true)
    expect(readFileSync(doc.working).equals(doc.before)).toBe(true)
  })

  it('is not moved by the main process without a place the person picked', async () => {
    const doc = await untitledDocument()

    expect(await doc.call(PDF_CHANNELS.adoptUntitledCopy, doc.working)).toBeNull()

    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(await doc.call(PDF_CHANNELS.isUntitledCopy, doc.working)).toBe(true)
  })
})
