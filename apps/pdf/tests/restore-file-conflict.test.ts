// @vitest-environment node
/**
 * Undo and Redo of a page operation write a kept copy of the whole file back.
 * That copy holds nothing another program wrote since, so the write is refused
 * unless the file is still what this view's last write in place left there.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()

interface FakeWebContents {
  id: number
  once: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
}

let nextWcId = 1

vi.mock('electron', () => ({
  app: { on: vi.fn(), whenReady: vi.fn(() => new Promise(() => {})) },
  dialog: {},
  shell: {},
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
  },
  WebContentsView: class {
    webContents: FakeWebContents = {
      id: nextWcId++,
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
import { PDF_CHANNELS } from '../src/shared/ipc'
import type { RestoreFileResult, SetPageSizeResult } from '../src/shared/ipc'

const tempDirs = new Set<string>()

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

/** A loadable one-page PDF whose bytes differ per label */
async function pdfBytes(label: string): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  doc.setTitle(label)
  return Buffer.from(await doc.save())
}

interface OpenView {
  wcId: number
  path: string
  /** the file as the view first read it */
  before: Buffer
}

/** A view that read its file, as the renderer does on open */
async function openedView(): Promise<OpenView> {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-restore-conflict-'))
  tempDirs.add(dir)
  const path = join(dir, 'document.pdf')
  const before = await pdfBytes('original')
  writeFileSync(path, before)
  const wcId = (createPdfView(path).webContents as unknown as FakeWebContents).id
  await handlers.get(PDF_CHANNELS.readFileChunk)!({ sender: { id: wcId } }, path, 0, 1024)
  return { wcId, path, before }
}

/** A page operation written in place; returns the file it left */
async function resizePages(view: OpenView): Promise<Buffer> {
  const result = (await handlers.get(PDF_CHANNELS.setPageSize)!(
    { sender: { id: view.wcId } },
    { path: view.path, width: 300, height: 400 },
  )) as SetPageSizeResult
  expect(result).toEqual({ ok: true })
  return readFileSync(view.path)
}

const restore = (view: OpenView, bytes: Buffer) =>
  handlers.get(PDF_CHANNELS.restoreFile)!(
    { sender: { id: view.wcId } },
    {
      path: view.path,
      bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    },
  ) as Promise<RestoreFileResult>

describe('writing a kept copy back over the file (Undo and Redo of a page operation)', () => {
  it('puts the file back, and forward again, while nothing else touched it', async () => {
    const view = await openedView()
    const after = await resizePages(view)
    expect(after.equals(view.before)).toBe(false)

    expect(await restore(view, view.before)).toEqual({ ok: true })
    expect(readFileSync(view.path).equals(view.before)).toBe(true)
    expect(await restore(view, after)).toEqual({ ok: true })
    expect(readFileSync(view.path).equals(after)).toBe(true)
  })

  it('refuses once another program has changed the file, leaving its bytes', async () => {
    const view = await openedView()
    await resizePages(view)
    const outside = await pdfBytes('changed elsewhere')
    writeFileSync(view.path, outside)

    expect(await restore(view, view.before)).toEqual({ ok: false, error: 'external-modified' })
    expect(readFileSync(view.path).equals(outside)).toBe(true)
  })

  it('still refuses after the view has read the changed file again', async () => {
    const view = await openedView()
    await resizePages(view)
    const outside = await pdfBytes('changed elsewhere')
    writeFileSync(view.path, outside)
    // printing, for one, reads the file from its start without showing it
    await handlers.get(PDF_CHANNELS.readFileChunk)!({ sender: { id: view.wcId } }, view.path, 0, 64)

    expect(await restore(view, view.before)).toEqual({ ok: false, error: 'external-modified' })
    expect(readFileSync(view.path).equals(outside)).toBe(true)
  })

  it('does not bring back a file another program removed', async () => {
    const view = await openedView()
    await resizePages(view)
    rmSync(view.path)

    expect(await restore(view, view.before)).toEqual({ ok: false, error: 'external-modified' })
    expect(existsSync(view.path)).toBe(false)
  })

  it('refuses a file this view has not written in place', async () => {
    const view = await openedView()

    expect(await restore(view, await pdfBytes('never shown'))).toEqual({
      ok: false,
      error: 'external-modified',
    })
    expect(readFileSync(view.path).equals(view.before)).toBe(true)
  })

  it('goes ahead when only the file’s time changed', async () => {
    const view = await openedView()
    await resizePages(view)
    const later = new Date(Date.now() + 60_000)
    utimesSync(view.path, later, later)

    expect(await restore(view, view.before)).toEqual({ ok: true })
    expect(readFileSync(view.path).equals(view.before)).toBe(true)
  })
})
