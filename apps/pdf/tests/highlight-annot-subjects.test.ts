// @vitest-environment node
/**
 * The /Subj read channel (reading-assist spec 4.3): the main process reads the
 * categories of a file's markup annotations, only for a file granted to the
 * asking view, and the preload passes the call through.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { PDF_CHANNELS } from '../src/shared/ipc'
import type { PdfApi } from '../src/shared/ipc'

type Handler = (event: { sender: FakeContents }, ...args: unknown[]) => unknown
const handlers = new Map<string, Handler>()
let lastContents: FakeContents
let nextId = 900
class FakeContents extends EventEmitter {
  id = ++nextId
  setWindowOpenHandler = vi.fn()
  loadURL = vi.fn()
  loadFile = vi.fn()
  isDestroyed = () => false
  send = vi.fn()
}
const invoke = vi.fn()
const exposed = new Map<string, unknown>()
vi.mock('electron', () => ({
  app: { on: vi.fn(), whenReady: () => new Promise(() => {}), getPath: () => '/fake' },
  dialog: {},
  shell: {},
  BrowserWindow: { fromWebContents: () => null },
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

import { applySaveRequest } from '../src/main/save-pdf'
import { readAnnotSubjects } from '../src/main/annot-subjects'
import { createPdfView } from '../src/main/pdf-main'

/** a two-page file with an accepted AI highlight on page 2, a plain one on page 1 */
async function fileWithSubjects(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.addPage([300, 300])
  doc.addPage([300, 300])
  const blank = await doc.save({ useObjectStreams: false })
  const quad = [[10, 40, 90, 40, 10, 20, 90, 20]]
  const out = await applySaveRequest(blank, {
    path: '/x.pdf',
    markups: [
      { pageIndex: 0, type: 'highlight', color: [1, 1, 0], quads: quad },
      { pageIndex: 1, type: 'highlight', color: [0, 1, 0], quads: quad, subject: '결과' },
      { pageIndex: 1, type: 'underline', color: [0, 0, 1], quads: quad, subject: 'Method' },
    ],
    drawings: [],
    formValues: [],
    stamps: [],
  })
  return out.bytes
}

function writeTemp(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'hl-subj-'))
  const path = join(dir, 'doc.pdf')
  writeFileSync(path, bytes)
  return path
}

describe('readAnnotSubjects', () => {
  it('returns the page, object number and /Subj of markup annotations', async () => {
    const subjects = await readAnnotSubjects(await fileWithSubjects())
    expect(subjects.map(({ pageIndex, subj }) => ({ pageIndex, subj }))).toEqual([
      { pageIndex: 1, subj: '결과' },
      { pageIndex: 1, subj: 'Method' },
    ])
    for (const s of subjects) expect(Number.isInteger(s.objNum) && s.objNum > 0).toBe(true)
    expect(new Set(subjects.map((s) => s.objNum)).size).toBe(2)
  })

  it('answers none for bytes that are not a PDF', async () => {
    expect(await readAnnotSubjects(new TextEncoder().encode('not a pdf'))).toEqual([])
  })
})

describe('pdf:annot-subjects handler', () => {
  it('reads the view’s own file', async () => {
    const path = writeTemp(await fileWithSubjects())
    createPdfView(path)
    const got = (await handlers.get(PDF_CHANNELS.annotSubjects)!(
      { sender: lastContents },
      path,
    )) as Array<{ subj: string }>
    expect(got.map((s) => s.subj)).toEqual(['결과', 'Method'])
  })

  it('refuses a path not granted to the view', async () => {
    const granted = writeTemp(await fileWithSubjects())
    const other = writeTemp(await fileWithSubjects())
    createPdfView(granted)
    const call = handlers.get(PDF_CHANNELS.annotSubjects)!
    await expect(call({ sender: lastContents }, other)).rejects.toThrow(/not granted/)
    await expect(call({ sender: lastContents }, 42)).rejects.toThrow(/not granted/)
  })

  it('refuses another view’s file', async () => {
    const a = writeTemp(await fileWithSubjects())
    createPdfView(a)
    const first = lastContents
    createPdfView(null)
    await expect(
      handlers.get(PDF_CHANNELS.annotSubjects)!({ sender: lastContents }, a),
    ).rejects.toThrow(/not granted/)
    expect(first.id).not.toBe(lastContents.id)
  })
})

describe('preload: annotSubjects', () => {
  it('passes the call to its channel', async () => {
    await import('../src/preload/index')
    const api = exposed.get('pdfApi') as PdfApi
    invoke.mockResolvedValue([])
    await api.annotSubjects('C:\\docs\\a.pdf')
    expect(invoke).toHaveBeenLastCalledWith(PDF_CHANNELS.annotSubjects, 'C:\\docs\\a.pdf')
  })
})
