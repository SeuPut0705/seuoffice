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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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
  markPdfUntitledCopy,
  pdfIsDirty,
  requestPdfClose,
  setPdfRecoveryStore,
} from '../src/main/pdf-main'
import {
  createUntitledSaver,
  type UntitledSave,
  type UntitledSaveApi,
} from '../src/renderer/untitled-save'
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
  return { view, call, copy, working, folder, api, saveEdits, before: readFileSync(working) }
}

type UntitledDocument = Awaited<ReturnType<typeof untitledDocument>>

/** The first save of the document, as the editor runs it */
const firstSave = (
  doc: UntitledDocument,
  saveEdits: () => Promise<boolean> = doc.saveEdits,
): Promise<UntitledSave> => createUntitledSaver(doc.api).save(doc.working, 'Draft.pdf', saveEdits)

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

    expect(await firstSave(doc)).toEqual({ saved: true, path: target })

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

    expect(await firstSave(doc)).toEqual({ saved: false, why: 'cancelled' })

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

    expect(await firstSave(doc)).toEqual({ saved: false, why: 'cancelled' })
    expect(await firstSave(doc)).toEqual({ saved: true, path: target })

    expect(showSaveDialog).toHaveBeenCalledTimes(2)
    expect(doc.saveEdits).toHaveBeenCalledTimes(1)
    expect(await pageCount(target)).toBe(1)
  })

  it('does not move the document when the edits could not be saved', async () => {
    const doc = await untitledDocument()
    const target = join(doc.folder, 'Report.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })

    expect(await firstSave(doc, async () => false)).toEqual({ saved: false, why: 'unsaved' })

    expect(existsSync(target)).toBe(false)
    expect(await doc.call(PDF_CHANNELS.isUntitledCopy, doc.working)).toBe(true)
    expect(readFileSync(doc.working).equals(doc.before)).toBe(true)
  })

  it('is not moved by the main process without a place the person picked', async () => {
    const doc = await untitledDocument()

    expect(await doc.call(PDF_CHANNELS.adoptUntitledCopy, doc.working)).toEqual({
      ok: false,
      error: 'pdf: no place was picked for this document',
    })

    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(await doc.call(PDF_CHANNELS.isUntitledCopy, doc.working)).toBe(true)
  })

  it('is one save while the place is being asked for: a second request neither asks nor writes', async () => {
    const doc = await untitledDocument()
    const saver = createUntitledSaver(doc.api)
    let second: Promise<UntitledSave> | undefined
    showSaveDialog.mockImplementationOnce(async () => {
      // the menu, a page operation or a tool asks for a save while the dialog is open
      second = saver.save(doc.working, 'Draft.pdf', doc.saveEdits)
      return { canceled: true }
    })

    const first = await saver.save(doc.working, 'Draft.pdf', doc.saveEdits)

    expect(first).toEqual({ saved: false, why: 'cancelled' })
    expect(await second).toEqual({ saved: false, why: 'cancelled' })
    expect(showSaveDialog).toHaveBeenCalledTimes(1)
    expect(doc.saveEdits).not.toHaveBeenCalled()
    expect(readFileSync(doc.working).equals(doc.before)).toBe(true)
  })
})

/**
 * What the document's state is for everything that asks, once its renderer
 * holds no pending edit any more (the edits are in the working file).
 */
async function stateOf(doc: UntitledDocument) {
  handlers.get(PDF_CHANNELS.dirtyChanged)!({ sender: doc.view }, false)
  const copy = await store.readCopy(doc.copy)
  const told = await doc.call<{ unsaved: boolean }>(PDF_CHANNELS.recoveryState, doc.working)
  const state = {
    // what the shell asks before it closes the tab, and what MCP lists as unsaved
    tabUnsaved: pdfIsDirty(doc.view.id),
    // what the editor reads to show the tab as unsaved
    editorToldUnsaved: told.unsaved,
    closeAsks: false,
    workingFilePages: existsSync(doc.working) ? await pageCount(doc.working) : null,
    recoveryCopyPages: copy ? (await PDFDocument.load(copy)).getPageCount() : null,
  }
  // Cancel in the close prompt, when there is one
  showMessageBox.mockReset()
  showMessageBox.mockResolvedValueOnce({ response: 2 })
  const closes = await requestPdfClose(doc.view as never)
  state.closeAsks = showMessageBox.mock.calls.length === 1 && !closes
  showMessageBox.mockReset()
  return state
}

/** unsaved, with the edit (one page left) in the working file and in the recovery copy */
const STILL_UNSAVED = {
  tabUnsaved: true,
  editorToldUnsaved: true,
  closeAsks: true,
  workingFilePages: 1,
  recoveryCopyPages: 1,
}

describe('an untitled document stays unsaved until it is at the place chosen', () => {
  it('when the folder picked is gone by the time the file is copied there', async () => {
    const doc = await untitledDocument()
    const gone = makeDir('pdf-first-save-gone-')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: join(gone, 'Report.pdf') })

    const out = await firstSave(doc, async () => {
      rmSync(gone, { recursive: true })
      return doc.saveEdits()
    })

    expect(await stateOf(doc)).toEqual(STILL_UNSAVED)
    expect(out).toEqual({
      saved: false,
      why: 'failed',
      error: expect.stringContaining('ENOENT'),
    })
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'when the folder picked cannot be written to',
    async () => {
      const doc = await untitledDocument()
      const readOnly = makeDir('pdf-first-save-readonly-')
      chmodSync(readOnly, 0o555)
      showSaveDialog.mockResolvedValueOnce({
        canceled: false,
        filePath: join(readOnly, 'Report.pdf'),
      })
      try {
        const out = await firstSave(doc)

        expect(await stateOf(doc)).toEqual(STILL_UNSAVED)
        expect(out).toEqual({
          saved: false,
          why: 'failed',
          error: expect.stringContaining('EACCES'),
        })
      } finally {
        chmodSync(readOnly, 0o755)
      }
    },
  )

  it('when the place picked is a folder', async () => {
    const doc = await untitledDocument()
    const folder = join(doc.folder, 'Report.pdf')
    mkdirSync(folder)
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: folder })

    const out = await firstSave(doc)

    expect(await stateOf(doc)).toEqual(STILL_UNSAVED)
    // the reason is the system's own; which one differs by platform
    expect(out).toEqual({ saved: false, why: 'failed', error: expect.stringMatching(/\S/) })
    expect(statSync(folder).isDirectory()).toBe(true)
  })

  it('when its edits are saved into the working file while the dialog is open, and the dialog is cancelled', async () => {
    const doc = await untitledDocument()
    showSaveDialog.mockImplementationOnce(async () => {
      // a second save request (the menu, a tool) went straight to the file
      expect(await doc.saveEdits()).toBe(true)
      return { canceled: true }
    })

    const out = await firstSave(doc)

    expect(out).toEqual({ saved: false, why: 'cancelled' })
    expect(await stateOf(doc)).toEqual(STILL_UNSAVED)
  })

  it('and its recovery copy outlives a tab that goes away without "Don\'t Save"', async () => {
    const doc = await untitledDocument()
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: join(doc.folder, 'missing', 'Report.pdf'),
    })
    await firstSave(doc)
    handlers.get(PDF_CHANNELS.dirtyChanged)!({ sender: doc.view }, false)

    doc.view.listeners.get('destroyed')!()

    const copy = await store.readCopy(doc.copy)
    expect(copy && (await PDFDocument.load(copy)).getPageCount()).toBe(1)
  })

  it('and "Don\'t Save" in the close prompt is what gives it up', async () => {
    const doc = await untitledDocument()
    showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: join(doc.folder, 'missing', 'Report.pdf'),
    })
    await firstSave(doc)
    handlers.get(PDF_CHANNELS.dirtyChanged)!({ sender: doc.view }, false)

    showMessageBox.mockResolvedValueOnce({ response: 1 })
    expect(await requestPdfClose(doc.view as never)).toBe(true)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    doc.view.listeners.get('destroyed')!()

    expect(await store.readCopy(doc.copy)).toBeNull()
  })

  it('a page operation written into a template copy leaves it unsaved too', async () => {
    const working = join(makeDir('pdf-first-save-template-'), 'Template.pdf')
    const bytes = await PDFDocument.create().then((pdf) => {
      pdf.addPage([300, 400])
      return pdf.save()
    })
    writeFileSync(working, bytes)
    markPdfUntitledCopy(working)
    const view = createPdfView(working).webContents as unknown as FakeWebContents
    const call = <T>(channel: string, ...args: unknown[]) =>
      Promise.resolve(handlers.get(channel)!({ sender: view }, ...args)) as Promise<T>
    await call(PDF_CHANNELS.consumePending)
    await call(PDF_CHANNELS.readFile, working)
    // opened and only looked at: nothing of the person's is in it
    expect(pdfIsDirty(view.id)).toBe(false)
    expect(await call(PDF_CHANNELS.recoveryState, working)).toEqual({ unsaved: false })

    expect(
      await call(PDF_CHANNELS.setPageSize, { path: working, width: 500, height: 500 }),
    ).toEqual({ ok: true })

    expect(pdfIsDirty(view.id)).toBe(true)
    expect(await call(PDF_CHANNELS.recoveryState, working)).toEqual({ unsaved: true })
    showMessageBox.mockResolvedValueOnce({ response: 2 })
    expect(await requestPdfClose(view as never)).toBe(false)
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('and is saved once the copy is at the place chosen: nothing asks, the working file goes', async () => {
    const doc = await untitledDocument()
    const target = join(doc.folder, 'Report.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })

    expect(await firstSave(doc)).toEqual({ saved: true, path: target })

    handlers.get(PDF_CHANNELS.dirtyChanged)!({ sender: doc.view }, false)
    expect(pdfIsDirty(doc.view.id)).toBe(false)
    expect(await doc.call(PDF_CHANNELS.recoveryState, target)).toEqual({ unsaved: false })
    expect(await requestPdfClose(doc.view as never)).toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(await pageCount(target)).toBe(1)
    await vi.waitFor(() => expect(existsSync(doc.working)).toBe(false))
    expect(store.listCopies({ untitled: true })).toHaveLength(0)
  })
})
