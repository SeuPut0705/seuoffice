// @vitest-environment node
/**
 * Pasting copied pages writes the file at once, like the other page
 * operations: the file from before it is kept for Undo, and a file too large
 * to keep is asked about first. The main process's own handlers answer here.
 */
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
import { pasteCopiedPages, type PagePasteApi } from '../src/renderer/page-paste'
import {
  MAX_WRITTEN_STEPS,
  NO_WRITTEN_STEPS,
  recordWritten,
  stepWrittenFile,
  type NoUndoGate,
  type NoUndoQuestion,
  type WrittenHistoryApi,
} from '../src/renderer/written-history'
import { PDF_CHANNELS } from '../src/shared/ipc'
import type { CopyPagesResult } from '../src/shared/ipc'

let dir: string | null = null

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
  holdCopiedPages(null)
})

interface OpenPdf {
  path: string
  wcId: number
  /** what the view's renderer calls, answered by the main process's handlers */
  api: PagePasteApi & WrittenHistoryApi
}

/** A PDF whose pages are told apart by their width, opened in its own view */
async function openPdf(name: string, widths: number[]): Promise<OpenPdf> {
  dir ??= mkdtempSync(join(tmpdir(), 'pdf-page-paste-'))
  const path = join(dir, name)
  const doc = await PDFDocument.create()
  for (const width of widths) doc.addPage([width, 200])
  writeFileSync(path, await doc.save({ useObjectStreams: false }))
  createPdfView(path)
  const wcId = lastWcId
  const call = <T>(channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!({ sender: { id: wcId } }, ...args)) as Promise<T>
  return {
    path,
    wcId,
    api: {
      readFileChunk: (...args) => call(PDF_CHANNELS.readFileChunk, ...args),
      restoreFile: (request) => call(PDF_CHANNELS.restoreFile, request),
      copiedPageCount: () => call(PDF_CHANNELS.copiedPageCount),
      pastePages: (request) => call(PDF_CHANNELS.pastePages, request),
    },
  }
}

async function pageWidths(path: string): Promise<number[]> {
  const doc = await PDFDocument.load(new Uint8Array(readFileSync(path)))
  return doc.getPages().map((page) => page.getWidth())
}

/** Copies pages (by position) of `from`, as its thumbnails do */
async function copyPages(from: OpenPdf, pages: number[]): Promise<void> {
  const copied = (await handlers.get(PDF_CHANNELS.copyPages)!(
    { sender: { id: from.wcId } },
    { source: { path: from.path, markups: [], drawings: [], formValues: [], stamps: [] }, pages },
  )) as CopyPagesResult
  expect(copied).toEqual({ ok: true, count: pages.length })
}

/** The person at the document: what they were asked, and the answer they give every time */
function person(answer: boolean, maxBytes?: number) {
  const asked: NoUndoQuestion[] = []
  const gate: NoUndoGate = {
    consent: { given: false },
    confirm: (question) => {
      asked.push(question)
      return answer
    },
    ...(maxBytes === undefined ? {} : { limits: { bytes: maxBytes, steps: MAX_WRITTEN_STEPS } }),
  }
  return { asked, gate }
}

describe('pasting copied pages into the file', () => {
  it('can be undone: Undo puts the file back as it was, Redo pastes again', async () => {
    const a = await openPdf('a.pdf', [100, 110, 120])
    const b = await openPdf('b.pdf', [300, 310])
    await copyPages(a, [1])
    const original = readFileSync(b.path)
    const user = person(false)

    const pasted = await pasteCopiedPages(b.api, b.path, 0, user.gate)
    expect(pasted).toMatchObject({ pasted: true, count: 1 })
    if (!pasted.pasted) return
    expect(await pageWidths(b.path)).toEqual([300, 110, 310])
    expect(user.asked).toEqual([])

    const steps = recordWritten(NO_WRITTEN_STEPS, pasted.before)
    const undone = await stepWrittenFile(b.api, b.path, steps, 'undo', {
      diskChanged: false,
      gate: user.gate,
    })
    expect(undone.ok).toBe(true)
    expect(readFileSync(b.path).equals(original)).toBe(true)
    if (!undone.ok) return
    const redone = await stepWrittenFile(b.api, b.path, undone.steps, 'redo', {
      diskChanged: false,
      gate: user.gate,
    })
    expect(redone.ok).toBe(true)
    expect(await pageWidths(b.path)).toEqual([300, 110, 310])
    expect(user.asked).toEqual([])
  })

  it('asks before it writes a file too large to keep, and Cancel writes nothing', async () => {
    const a = await openPdf('a.pdf', [100, 110])
    const b = await openPdf('b.pdf', [300, 310])
    await copyPages(a, [0])
    const original = readFileSync(b.path)
    const user = person(false, 16)

    expect(await pasteCopiedPages(b.api, b.path, 0, user.gate)).toEqual({
      pasted: false,
      why: 'declined',
    })
    expect(user.asked).toEqual([{ fileBytes: original.byteLength, limitBytes: 16 }])
    expect(readFileSync(b.path).equals(original)).toBe(true)
  })

  it('pastes after Continue, keeps no step, and does not ask again for the document', async () => {
    const a = await openPdf('a.pdf', [100, 110])
    const b = await openPdf('b.pdf', [300, 310])
    await copyPages(a, [0])
    const user = person(true, 16)

    expect(await pasteCopiedPages(b.api, b.path, 0, user.gate)).toEqual({
      pasted: true,
      count: 1,
      path: b.path,
      before: null,
    })
    expect(await pasteCopiedPages(b.api, b.path, 0, user.gate)).toMatchObject({ pasted: true })
    expect(await pageWidths(b.path)).toEqual([300, 100, 100, 310])
    expect(user.asked).toHaveLength(1)
  })

  it('asks nothing when no page is copied', async () => {
    const b = await openPdf('b.pdf', [300, 310])
    const original = readFileSync(b.path)
    const user = person(true, 16)

    expect(await pasteCopiedPages(b.api, b.path, 0, user.gate)).toEqual({
      pasted: false,
      why: 'empty',
    })
    expect(user.asked).toEqual([])
    expect(readFileSync(b.path).equals(original)).toBe(true)
  })
})
