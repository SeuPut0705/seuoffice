// @vitest-environment node
/**
 * Split-view copy pairs (decision 0036): while the same PDF is open in two
 * panes, a save from one copy must not silently clobber a write the sibling
 * pane made in the meantime. A manual save asks first and cancel keeps the
 * disk copy; an automatic save defers silently. Without a copy pair the save
 * behaves exactly as before.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
const showMessageBox = vi.fn()

interface FakeWebContents {
  id: number
  once: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  listeners: Map<string, () => void>
}

let nextWcId = 1

function makeFakeWebContents(): FakeWebContents {
  const listeners = new Map<string, () => void>()
  const wc: FakeWebContents = {
    id: nextWcId++,
    listeners,
    once: vi.fn((event: string, handler: () => void) => {
      listeners.set(event, handler)
    }),
    on: vi.fn((event: string, handler: () => void) => {
      listeners.set(event, handler)
    }),
    setWindowOpenHandler: vi.fn(),
    loadURL: vi.fn(),
  }
  return wc
}

vi.mock('electron', () => ({
  app: { on: vi.fn(), whenReady: vi.fn(() => new Promise(() => {})) },
  dialog: { showMessageBox: (...args: unknown[]) => showMessageBox(...args) },
  shell: {},
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

import { setOpenPathProbe } from '@genoffice/electron-utils'
import { createPdfView } from '../src/main/pdf-main'
import { PDF_CHANNELS } from '../src/shared/ipc'
import type { SavePdfResult } from '../src/shared/ipc'

const tempDirs = new Set<string>()

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-save-conflict-'))
  tempDirs.add(dir)
  return dir
}

/** A loadable one-page PDF whose bytes differ per label */
async function pdfBytes(label: string): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  doc.setTitle(label)
  return Buffer.from(await doc.save())
}

async function makePdfFile(): Promise<string> {
  const path = join(makeDir(), 'document.pdf')
  writeFileSync(path, await pdfBytes('original'))
  return path
}

afterEach(() => {
  setOpenPathProbe(null)
  vi.restoreAllMocks()
  showMessageBox.mockReset()
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

const readGranted = (wcId: number, path: string) =>
  handlers.get(PDF_CHANNELS.readFile)!({ sender: { id: wcId } }, path) as Promise<ArrayBuffer>

const save = (wcId: number, request: Record<string, unknown>) =>
  handlers.get(PDF_CHANNELS.save)!({ sender: { id: wcId } }, request) as Promise<SavePdfResult>

const savedRequest = (path: string, extra: Record<string, unknown> = {}) => ({
  path,
  markups: [],
  drawings: [],
  formValues: [],
  stamps: [],
  ...extra,
})

/** A view whose renderer read the file, which records the disk state */
async function openedView(path: string): Promise<number> {
  const view = createPdfView(path)
  const wcId = (view.webContents as unknown as FakeWebContents).id
  new Uint8Array(await readGranted(wcId, path))
  return wcId
}

const isPdf = (path: string): boolean => readFileSync(path).subarray(0, 4).toString() === '%PDF'

describe('a save with no copy pair is unchanged', () => {
  it('does not ask anything even when another program changed the disk', async () => {
    const path = await makePdfFile()
    const wcId = await openedView(path)
    const external = await pdfBytes('changed elsewhere')
    writeFileSync(path, external)

    expect(await save(wcId, savedRequest(path))).toMatchObject({ ok: true })
    expect(readFileSync(path).equals(external)).toBe(false)
    expect(isPdf(path)).toBe(true)
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})

describe('a copy pair holds this PDF (the path is open in another pane)', () => {
  it('defers an automatic save silently, keeping the sibling pane’s bytes', async () => {
    const path = await makePdfFile()
    const wcId = await openedView(path)
    const external = await pdfBytes('changed elsewhere')
    writeFileSync(path, external)
    setOpenPathProbe((each) => each === path)

    expect(await save(wcId, savedRequest(path, { auto: true }))).toEqual({
      ok: false,
      error: 'external-modified',
    })
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(readFileSync(path).equals(external)).toBe(true)
  })

  it('asks before a manual save, and cancel keeps the disk copy', async () => {
    const path = await makePdfFile()
    const wcId = await openedView(path)
    const external = await pdfBytes('changed elsewhere')
    writeFileSync(path, external)
    setOpenPathProbe((each) => each === path)
    showMessageBox.mockResolvedValue({ response: 1, checkboxChecked: false })

    expect(await save(wcId, savedRequest(path))).toEqual({
      ok: false,
      error: 'external-modified',
    })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(showMessageBox.mock.calls[0]![0]).toMatchObject({ type: 'warning' })
    expect(readFileSync(path).equals(external)).toBe(true)
  })

  it('writes when the user overwrites, and the next save asks nothing', async () => {
    const path = await makePdfFile()
    const wcId = await openedView(path)
    writeFileSync(path, await pdfBytes('changed elsewhere'))
    setOpenPathProbe((each) => each === path)
    showMessageBox.mockResolvedValue({ response: 0, checkboxChecked: false })

    expect(await save(wcId, savedRequest(path))).toMatchObject({ ok: true })
    expect(isPdf(path)).toBe(true)

    // the record was refreshed on save: the disk still matches it, so no second question
    expect(await save(wcId, savedRequest(path))).toMatchObject({ ok: true })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
  })

  it('asks nothing while the disk still matches this copy’s own record', async () => {
    const path = await makePdfFile()
    const wcId = await openedView(path)
    setOpenPathProbe((each) => each === path)

    expect(await save(wcId, savedRequest(path))).toMatchObject({ ok: true })
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})
