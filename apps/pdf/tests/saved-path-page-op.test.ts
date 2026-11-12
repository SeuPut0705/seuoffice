// @vitest-environment node
/**
 * A page operation saves the pending edits first, and that save can move the
 * document: the first save of an untitled copy asks where it goes, and a blank
 * PDF takes its file name from its content. The main process then grants only
 * the new path, so the operation has to be written there. The renderer's flow
 * runs here against the main process's own handlers.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
const showSaveDialog = vi.fn()

let nextWcId = 1
let lastWcId = 0

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => {})),
    getPath: (name: string) => join(tmpdir(), 'pdf-saved-path-app', name),
  },
  dialog: { showSaveDialog: (...args: unknown[]) => showSaveDialog(...args) },
  shell: {},
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
  },
  WebContentsView: class {
    webContents = {
      id: (lastWcId = nextWcId++),
      once: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(),
      isDestroyed: () => false,
      send: vi.fn(),
    }
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

import { createPdfView, markPdfUntitledCopy, markPdfUntitledPath } from '../src/main/pdf-main'
import { holdCopiedPages } from '../src/main/page-clipboard'
import { pasteCopiedPages, type PagePasteApi } from '../src/renderer/page-paste'
import {
  NO_WRITTEN_STEPS,
  recordWritten,
  stepWrittenFile,
  writeInPlace,
  type NoUndoGate,
  type PendingEdits,
  type WrittenHistoryApi,
} from '../src/renderer/written-history'
import { PDF_CHANNELS } from '../src/shared/ipc'
import type {
  CopyPagesResult,
  PdfAutoRenameResult,
  SavePdfRequest,
  SavePdfResult,
  SetPageSizeResult,
} from '../src/shared/ipc'

const tempDirs = new Set<string>()

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
  holdCopiedPages(null)
  showSaveDialog.mockReset()
})

interface OpenView {
  /** the file the view was opened on */
  path: string
  call<T>(channel: string, ...args: unknown[]): Promise<T>
  /** what the view's renderer calls, answered by the main process's handlers */
  api: PagePasteApi & WrittenHistoryApi
}

/** A one-page document the view has read; `mark` is what the shell said of the file first */
async function openedView(mark: (path: string) => void): Promise<OpenView> {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-saved-path-'))
  tempDirs.add(dir)
  const path = join(dir, 'document.pdf')
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  writeFileSync(path, await doc.save({ useObjectStreams: false }))
  mark(path)
  createPdfView(path)
  const wcId = lastWcId
  const call = <T>(channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!({ sender: { id: wcId } }, ...args)) as Promise<T>
  await call(PDF_CHANNELS.readFileChunk, path, 0, 1024)
  return {
    path,
    call,
    api: {
      readFileChunk: (...args) => call(PDF_CHANNELS.readFileChunk, ...args),
      restoreFile: (request) => call(PDF_CHANNELS.restoreFile, request),
      copiedPageCount: () => call(PDF_CHANNELS.copiedPageCount),
      pastePages: (request) => call(PDF_CHANNELS.pastePages, request),
    },
  }
}

async function pageSizes(path: string): Promise<number[][]> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)))
  return doc.getPages().map((page) => [page.getWidth(), page.getHeight()])
}

/** The save of a highlight the person drew, into the file the view shows */
async function saveHighlight(view: OpenView): Promise<boolean> {
  const request: SavePdfRequest = {
    path: view.path,
    markups: [
      {
        pageIndex: 0,
        type: 'highlight',
        color: [1, 0.87, 0.35],
        quads: [[50, 120, 150, 120, 50, 100, 150, 100]],
      },
    ],
    drawings: [],
    formValues: [],
    stamps: [],
  }
  return (await view.call<SavePdfResult>(PDF_CHANNELS.save, request)).ok
}

/** The editor's Save with a highlight pending in an untitled copy: the edit goes into the
 *  copy, then the person picks `picked` in the dialog and the document moves there */
const savedToPickedPath = (view: OpenView, picked: string): PendingEdits => ({
  fileBytes: readFileSync(view.path).byteLength,
  save: async () => {
    if (!(await saveHighlight(view))) return null
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: picked })
    return view.call<string | null>(PDF_CHANNELS.adoptUntitledCopy, view.path, 'picked.pdf')
  },
})

/** The editor's Save of a blank PDF whose first text names the file */
const savedUnderContentName = (view: OpenView, base: string): PendingEdits => ({
  fileBytes: readFileSync(view.path).byteLength,
  save: async () => {
    if (!(await saveHighlight(view))) return null
    const renamed = await view.call<PdfAutoRenameResult>(PDF_CHANNELS.autoRename, view.path, base)
    return renamed.path ?? view.path
  },
})

/** Nobody is asked anything here: every file fits the Undo bound */
const gate: NoUndoGate = {
  consent: { given: false },
  confirm: () => {
    throw new Error('asked about a file that fits')
  },
}

const resize = (view: OpenView) => (path: string) =>
  view.call<SetPageSizeResult>(PDF_CHANNELS.setPageSize, { path, width: 300, height: 400 })

describe('a page operation whose save of the pending edits moves the document', () => {
  it('finds the working file of an untitled copy revoked once the copy is saved', async () => {
    const view = await openedView(markPdfUntitledCopy)
    const picked = join(dirname(view.path), 'picked.pdf')
    expect(await savedToPickedPath(view, picked).save()).toBe(picked)

    // what the main process answers a renderer that still names the working file
    expect(await resize(view)(view.path)).toEqual({
      ok: false,
      error: 'pdf: path not granted to this view',
    })
    await expect(view.api.readFileChunk(view.path, 0, 1024)).rejects.toThrow(
      'pdf: path not granted to this view',
    )
  })

  it('is written to the file an untitled copy was saved to, and can be undone there', async () => {
    const view = await openedView(markPdfUntitledCopy)
    const picked = join(dirname(view.path), 'picked.pdf')
    let saved: Buffer | null = null
    const pending = savedToPickedPath(view, picked)

    const change = await writeInPlace(view.api, view.path, resize(view), gate, {
      ...pending,
      save: async () => {
        const at = await pending.save()
        saved = at ? readFileSync(at) : null
        return at
      },
    })

    expect(change).toMatchObject({ status: 'run', path: picked, result: { ok: true } })
    expect(await pageSizes(picked)).toEqual([[300, 400]])
    if (change.status !== 'run') return
    const undone = await stepWrittenFile(
      view.api,
      picked,
      recordWritten(NO_WRITTEN_STEPS, change.before),
      'undo',
      { diskChanged: false, gate },
    )
    expect(undone.ok).toBe(true)
    // back to the file as the save left it: the highlight is in it, the old page size too
    expect(readFileSync(picked).equals(saved!)).toBe(true)
    expect(await pageSizes(picked)).toEqual([[200, 200]])
  })

  it('is written to the file a blank PDF was renamed to from its content', async () => {
    const view = await openedView(markPdfUntitledPath)
    const renamed = join(dirname(view.path), 'Quarterly report.pdf')

    const change = await writeInPlace(
      view.api,
      view.path,
      resize(view),
      gate,
      savedUnderContentName(view, 'Quarterly report'),
    )

    expect(change).toMatchObject({ status: 'run', path: renamed, result: { ok: true } })
    expect(await pageSizes(renamed)).toEqual([[300, 400]])
  })

  it('pastes copied pages into the file an untitled copy was saved to', async () => {
    const view = await openedView(markPdfUntitledCopy)
    const picked = join(dirname(view.path), 'picked.pdf')
    const copied = await view.call<CopyPagesResult>(PDF_CHANNELS.copyPages, {
      source: { path: view.path, markups: [], drawings: [], formValues: [], stamps: [] },
      pages: [0],
    })
    expect(copied).toEqual({ ok: true, count: 1 })

    const pasted = await pasteCopiedPages(
      view.api,
      view.path,
      0,
      gate,
      savedToPickedPath(view, picked),
    )

    expect(pasted).toMatchObject({ pasted: true, count: 1, path: picked })
    expect(await pageSizes(picked)).toHaveLength(2)
  })

  it('stays on its own path when the save moves nothing', async () => {
    const view = await openedView(() => {})

    const change = await writeInPlace(view.api, view.path, resize(view), gate, {
      fileBytes: readFileSync(view.path).byteLength,
      save: async () => ((await saveHighlight(view)) ? view.path : null),
    })

    expect(change).toMatchObject({ status: 'run', path: view.path, result: { ok: true } })
    expect(await pageSizes(view.path)).toEqual([[300, 400]])
  })
})
