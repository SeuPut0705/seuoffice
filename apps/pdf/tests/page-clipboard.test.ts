import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { afterEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()

let nextWcId = 1
let lastWcId = 0

vi.mock('electron', () => ({
  app: { on: vi.fn(), whenReady: vi.fn(() => new Promise(() => {})) },
  dialog: {},
  shell: {},
  BrowserWindow: class {},
  WebContentsView: class {
    webContents = {
      id: (lastWcId = nextWcId++),
      once: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn(),
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

import { createPdfView } from '../src/main/pdf-main'
import { holdCopiedPages } from '../src/main/page-clipboard'
import { PDF_CHANNELS } from '../src/shared/ipc'
import type { CopyPagesResult, PastePagesResult } from '../src/shared/ipc'

let dir: string | null = null

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
  holdCopiedPages(null)
})

/** A PDF whose pages are told apart by their width; opened in its own view */
async function openPdf(name: string, widths: number[]): Promise<{ path: string; wcId: number }> {
  dir ??= mkdtempSync(join(tmpdir(), 'pdf-page-clipboard-'))
  const path = join(dir, name)
  const doc = await PDFDocument.create()
  for (const width of widths) doc.addPage([width, 200])
  writeFileSync(path, await doc.save({ useObjectStreams: false }))
  createPdfView(path)
  return { path, wcId: lastWcId }
}

async function pageWidths(path: string): Promise<number[]> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)))
  return doc.getPages().map((page) => page.getWidth())
}

const call = <T>(channel: string, wcId: number, ...args: unknown[]): Promise<T> =>
  Promise.resolve(handlers.get(channel)!({ sender: { id: wcId } }, ...args)) as Promise<T>

/** A save request as the editor sends it: every list present, empty unless overridden */
const edits = (path: string, pending: Record<string, unknown> = {}) => ({
  path,
  markups: [],
  drawings: [],
  formValues: [],
  stamps: [],
  ...pending,
})

const copy = (wcId: number, source: Record<string, unknown>, pages: unknown) =>
  call<CopyPagesResult>(PDF_CHANNELS.copyPages, wcId, { source, pages })

const paste = (wcId: number, path: string, afterPageIndex: number) =>
  call<PastePagesResult>(PDF_CHANNELS.pastePages, wcId, { path, afterPageIndex })

describe('page clipboard', () => {
  it('pastes nothing and leaves the file alone when no page was copied', async () => {
    const b = await openPdf('b.pdf', [300, 310])
    const before = readFileSync(b.path)
    expect(await call<number>(PDF_CHANNELS.copiedPageCount, b.wcId)).toBe(0)
    expect(await paste(b.wcId, b.path, 0)).toEqual({ ok: true, insertedCount: 0 })
    expect(readFileSync(b.path)).toEqual(before)
  })

  it('copies pages of one PDF into another view without writing the source', async () => {
    const a = await openPdf('a.pdf', [100, 110, 120, 130, 140])
    const b = await openPdf('b.pdf', [300, 310])
    const sourceBefore = readFileSync(a.path)

    expect(await copy(a.wcId, edits(a.path), [2, 1])).toEqual({ ok: true, count: 2 })
    expect(readFileSync(a.path)).toEqual(sourceBefore)
    expect(await call<number>(PDF_CHANNELS.copiedPageCount, b.wcId)).toBe(2)

    expect(await paste(b.wcId, b.path, 0)).toEqual({ ok: true, insertedCount: 2 })
    expect(await pageWidths(b.path)).toEqual([300, 110, 120, 310])
  })

  it('pastes at the front and duplicates pages within the same PDF', async () => {
    const a = await openPdf('a.pdf', [100, 110, 120])
    expect(await copy(a.wcId, edits(a.path), [2])).toEqual({ ok: true, count: 1 })
    expect(await paste(a.wcId, a.path, -1)).toEqual({ ok: true, insertedCount: 1 })
    expect(await pageWidths(a.path)).toEqual([120, 100, 110, 120])
    // the clipboard keeps its pages: a second paste lands the same page again
    expect(await paste(a.wcId, a.path, 3)).toEqual({ ok: true, insertedCount: 1 })
    expect(await pageWidths(a.path)).toEqual([120, 100, 110, 120, 120])
  })

  it('copies the pages as displayed: the pending order and deletions count, the file does not change', async () => {
    const a = await openPdf('a.pdf', [100, 110, 120, 130])
    const b = await openPdf('b.pdf', [300])
    const sourceBefore = readFileSync(a.path)
    // page 2 deleted, the rest shown as 4, 1, 3: positions 0 and 1 are the 130 and 100 wide pages
    const pending = edits(a.path, { deletedPages: [1], pageOrder: [3, 0, 2] })

    expect(await copy(a.wcId, pending, [0, 1])).toEqual({ ok: true, count: 2 })
    expect(readFileSync(a.path)).toEqual(sourceBefore)
    expect(await paste(b.wcId, b.path, 0)).toEqual({ ok: true, insertedCount: 2 })
    expect(await pageWidths(b.path)).toEqual([300, 130, 100])
  })

  it('refuses a file the view was not given', async () => {
    const a = await openPdf('a.pdf', [100, 110])
    const b = await openPdf('b.pdf', [300])
    const targetBefore = readFileSync(b.path)

    expect((await copy(b.wcId, edits(a.path), [0])).ok).toBe(false)
    expect((await copy(a.wcId, edits(a.path, { targetPath: b.path }), [0])).ok).toBe(false)
    expect(await call<number>(PDF_CHANNELS.copiedPageCount, a.wcId)).toBe(0)

    expect(await copy(a.wcId, edits(a.path), [0])).toEqual({ ok: true, count: 1 })
    expect((await paste(a.wcId, b.path, 0)).ok).toBe(false)
    expect(readFileSync(b.path)).toEqual(targetBefore)
    // a sender that is not a PDF view learns nothing about the clipboard
    expect(await call<number>(PDF_CHANNELS.copiedPageCount, 9999)).toBe(0)
  })

  it('keeps what was copied when a later copy names no page', async () => {
    const a = await openPdf('a.pdf', [100, 110])
    expect(await copy(a.wcId, edits(a.path), [1])).toEqual({ ok: true, count: 1 })
    expect((await copy(a.wcId, edits(a.path), [7, -1, 'x'])).ok).toBe(false)
    expect(await call<number>(PDF_CHANNELS.copiedPageCount, a.wcId)).toBe(1)
  })

  it('does not copy from a password-protected session', async () => {
    const a = await openPdf('a.pdf', [100, 110])
    const result = await copy(a.wcId, edits(a.path, { decryption: { userPassword: 'pw' } }), [0])
    expect(result).toMatchObject({ ok: false, protected: true })
    expect(await call<number>(PDF_CHANNELS.copiedPageCount, a.wcId)).toBe(0)
  })
})
