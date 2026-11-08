// @vitest-environment node
/**
 * The note channels of the pdf main process (reading-assist spec 4.9, 5.4):
 * they act on the asking view's own PDF only, never take a path from the
 * renderer, refuse a PDF without a saved path, answer with a reason without
 * the shell, and a save in place moves the note link to the new hash.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { PDF_CHANNELS } from '../src/shared/ipc'
import type { PdfApi, PdfNoteResult } from '../src/shared/ipc'

type Handler = (event: { sender: FakeContents }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
let lastContents: FakeContents
let nextId = 1200
class FakeContents extends EventEmitter {
  id = ++nextId
  setWindowOpenHandler = vi.fn()
  loadURL = vi.fn()
  loadFile = vi.fn()
  isDestroyed = () => false
  send = vi.fn()
}
const userData = mkdtempSync(join(tmpdir(), 'note-handler-ud-'))
const showSaveDialog = vi.fn()
const invoke = vi.fn()
const exposed = new Map<string, unknown>()
vi.mock('electron', () => ({
  app: { on: vi.fn(), whenReady: () => new Promise(() => {}), getPath: () => userData },
  dialog: { showSaveDialog: (...args: unknown[]) => showSaveDialog(...args) },
  shell: {},
  webContents: { fromId: () => undefined },
  BrowserWindow: { fromWebContents: () => null, getFocusedWindow: () => null },
  WebContentsView: class {
    webContents = (lastContents = new FakeContents())
  },
  ipcMain: {
    handle: (channel: string, fn: Handler) => handlers.set(channel, fn),
    on: (channel: string, fn: Handler) => handlers.set(channel, fn),
    removeHandler: vi.fn(),
  },
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => exposed.set(name, api) },
  ipcRenderer: {
    invoke: (...args: unknown[]) => invoke(...args),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}))
vi.mock('@genoffice/electron-utils/drop-open', () => ({ installDropOpenBridge: vi.fn() }))

import {
  configurePdfRuntime,
  createPdfView,
  markPdfUntitledPath,
  pdfFileRenamed,
} from '../src/main/pdf-main'
import { ResultStore, documentHashOfFile } from '../../../packages/pdf-structure/src/store'

const openNote = vi.fn((_path: string) => true)
const insertIntoNote = vi.fn((_path: string, _text: string) => true)

async function writePdf(dir: string, name = 'Paper.pdf'): Promise<string> {
  const doc = await PDFDocument.create()
  doc.addPage([300, 300])
  doc.addPage([300, 300])
  const path = join(dir, name)
  writeFileSync(path, await doc.save({ useObjectStreams: false }))
  return path
}

const call = (channel: string, ...args: unknown[]) =>
  handlers.get(channel)!({ sender: lastContents }, ...args) as Promise<PdfNoteResult>

beforeEach(() => {
  showSaveDialog.mockReset()
  openNote.mockClear()
  insertIntoNote.mockClear()
  configurePdfRuntime({ preloadPath: '', openNote, insertIntoNote })
})

describe('pdf:note-open', () => {
  it('asks with a default next to the PDF, makes the note and opens it through the shell', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'note-handler-'))
    const pdf = await writePdf(dir)
    createPdfView(pdf)
    showSaveDialog.mockImplementation(async (options: { defaultPath: string }) => ({
      canceled: false,
      filePath: options.defaultPath,
    }))
    const result = await call(PDF_CHANNELS.noteOpen, { title: 'A Study' })
    expect(result).toEqual({ ok: true })
    const options = showSaveDialog.mock.calls[0].at(-1) as {
      defaultPath: string
      filters: Array<{ extensions: string[] }>
    }
    expect(options.defaultPath.startsWith(join(dir, 'Paper '))).toBe(true)
    expect(options.defaultPath.endsWith('.md')).toBe(true)
    expect(options.filters[0].extensions).toEqual(['md'])
    expect(openNote).toHaveBeenCalledWith(options.defaultPath)
    expect(readFileSync(options.defaultPath, 'utf8')).toBe('# A Study\n')
  })

  it('refuses a view without a saved file and an untitled blank', async () => {
    createPdfView(null)
    expect(await call(PDF_CHANNELS.noteOpen, {})).toEqual({ ok: false, reason: 'unsaved' })
    const dir = mkdtempSync(join(tmpdir(), 'note-handler-'))
    const blank = await writePdf(dir, 'Untitled.pdf')
    markPdfUntitledPath(blank)
    createPdfView(blank)
    expect(await call(PDF_CHANNELS.noteOpen, {})).toEqual({ ok: false, reason: 'unsaved' })
    expect(showSaveDialog).not.toHaveBeenCalled()
  })

  it('answers with a reason and asks nothing when the shell did not inject the note calls', async () => {
    configurePdfRuntime({ preloadPath: '' })
    const dir = mkdtempSync(join(tmpdir(), 'note-handler-'))
    createPdfView(await writePdf(dir))
    expect(await call(PDF_CHANNELS.noteOpen, {})).toEqual({ ok: false, reason: 'unavailable' })
    expect(showSaveDialog).not.toHaveBeenCalled()
  })
})

describe('pdf:note-insert', () => {
  it('ignores any path in the request and inserts into the linked note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'note-handler-'))
    const pdf = await writePdf(dir)
    const notePath = join(dir, 'linked.md')
    writeFileSync(notePath, '# linked\n')
    await new ResultStore(userData).setNoteLink(pdf, {
      notePath,
      docHash: await documentHashOfFile(pdf),
    })
    createPdfView(pdf)
    const evil = join(dir, 'evil.md')
    const result = await call(PDF_CHANNELS.noteInsert, {
      kind: 'quote',
      excerpt: 'Quoted',
      page: 2,
      body: 'Memo',
      notePath: evil,
      pdfPath: join(dir, 'other.pdf'),
    })
    expect(result).toEqual({ ok: true })
    expect(showSaveDialog).not.toHaveBeenCalled()
    expect(insertIntoNote).toHaveBeenCalledWith(
      notePath,
      '> Quoted ([p.2](Paper.pdf#page=2))\n\nMemo',
    )
    expect(existsSync(evil)).toBe(false)
    expect(readFileSync(notePath, 'utf8')).toBe('# linked\n')
  })

  it('refuses a malformed request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'note-handler-'))
    createPdfView(await writePdf(dir))
    expect((await call(PDF_CHANNELS.noteInsert, { kind: 'quote', page: 'x' })).ok).toBe(false)
    expect(insertIntoNote).not.toHaveBeenCalled()
  })
})

describe('a new blank PDF and its first save', () => {
  const save = (path: string) =>
    handlers.get(PDF_CHANNELS.save)!(
      { sender: lastContents },
      {
        path,
        markups: [
          {
            pageIndex: 0,
            type: 'highlight',
            color: [1, 1, 0],
            quads: [[10, 40, 90, 40, 10, 20, 90, 20]],
          },
        ],
        drawings: [],
        formValues: [],
        stamps: [],
      },
    ) as Promise<{ ok: boolean }>
  const ask = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({ sender: lastContents }, ...args) as Promise<boolean> | boolean

  it('waits until the person saves it in place, then the note works; auto-naming still may rename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'note-handler-'))
    const blank = await writePdf(dir, 'Untitled-7.pdf')
    markPdfUntitledPath(blank)
    createPdfView(blank)
    expect(await ask(PDF_CHANNELS.noteUnsaved)).toBe(true)
    expect(await call(PDF_CHANNELS.noteOpen, {})).toEqual({ ok: false, reason: 'unsaved' })

    expect((await save(blank)).ok).toBe(true)
    expect(await ask(PDF_CHANNELS.noteUnsaved)).toBe(false)
    // the untitled name is still the shell's: content-derived naming keeps working
    expect(await ask(PDF_CHANNELS.isUntitled, blank)).toBe(true)
    showSaveDialog.mockImplementation(async (options: { defaultPath: string }) => ({
      canceled: false,
      filePath: options.defaultPath,
    }))
    expect(await call(PDF_CHANNELS.noteOpen, {})).toEqual({ ok: true })
    expect(showSaveDialog).toHaveBeenCalled()
  })

  it('a blank renamed before its first save is still not saved under the new name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'note-handler-'))
    const blank = await writePdf(dir, 'Untitled-8.pdf')
    markPdfUntitledPath(blank)
    createPdfView(blank)
    const moved = join(dir, 'Moved.pdf')
    pdfFileRenamed(lastContents as never, blank, moved)
    expect(await ask(PDF_CHANNELS.noteUnsaved)).toBe(true)
    expect(await call(PDF_CHANNELS.noteOpen, {})).toEqual({ ok: false, reason: 'unsaved' })
  })

  it('a PDF the person opened is saved; a view without a file is not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'note-handler-'))
    createPdfView(await writePdf(dir))
    expect(await ask(PDF_CHANNELS.noteUnsaved)).toBe(false)
    createPdfView(null)
    expect(await ask(PDF_CHANNELS.noteUnsaved)).toBe(true)
  })
})

describe('the note link after a save', () => {
  it('moves to the saved file’s new hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'note-handler-'))
    const pdf = await writePdf(dir)
    const notePath = join(dir, 'n.md')
    writeFileSync(notePath, '# n\n')
    const store = new ResultStore(userData)
    const before = await documentHashOfFile(pdf)
    await store.setNoteLink(pdf, { notePath, docHash: before })
    createPdfView(pdf)
    const saved = (await handlers.get(PDF_CHANNELS.save)!(
      { sender: lastContents },
      {
        path: pdf,
        markups: [
          {
            pageIndex: 0,
            type: 'highlight',
            color: [1, 1, 0],
            quads: [[10, 40, 90, 40, 10, 20, 90, 20]],
          },
        ],
        drawings: [],
        formValues: [],
        stamps: [],
      },
    )) as { ok: boolean }
    expect(saved.ok).toBe(true)
    const after = await documentHashOfFile(pdf)
    expect(after).not.toBe(before)
    await vi.waitFor(async () => {
      const found = await store.findNoteLink(pdf, after)
      expect(found).toMatchObject({ notePath, docHash: after, matchedBy: 'path' })
    })
  })
})

describe('preload: note calls', () => {
  it('sends only the title on open, the text parts on insert, and survives a missing handler', async () => {
    await import('../src/preload/index')
    const api = exposed.get('pdfApi') as PdfApi
    invoke.mockResolvedValue({ ok: true })
    await api.noteOpen({ title: 'T', notePath: 'C:\\evil.md' } as never)
    expect(invoke).toHaveBeenLastCalledWith(PDF_CHANNELS.noteOpen, { title: 'T' })
    const request = { kind: 'quote', excerpt: 'x', page: 1 } as const
    await api.noteInsert(request)
    expect(invoke).toHaveBeenLastCalledWith(PDF_CHANNELS.noteInsert, request)
    invoke.mockRejectedValueOnce(new Error('No handler registered'))
    expect(await api.noteOpen()).toEqual({ ok: false, reason: 'unavailable' })
    invoke.mockResolvedValueOnce(true)
    expect(await api.noteUnsaved()).toBe(true)
    expect(invoke).toHaveBeenLastCalledWith(PDF_CHANNELS.noteUnsaved)
    invoke.mockRejectedValueOnce(new Error('No handler registered'))
    expect(await api.noteUnsaved()).toBe(false)
  })
})
