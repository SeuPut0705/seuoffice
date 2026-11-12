/**
 * Conversion to Markdown / EPUB, the picture export and the files of a
 * translation are structure jobs: they read the file on disk, so the pending
 * edits are saved first, and that save can move the document (the first save
 * of an untitled copy asks where it goes). The main process then grants only
 * the new path, and the job has to name it. The editor's flows run here
 * against the pdf editor's own handlers and the shell's structure handlers,
 * bound to the editor's grant table the way the shell binds them.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { createI18n } from '@seuoffice/i18n'

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => unknown
const handlers = new Map<string, IpcHandler>()
const showSaveDialog = vi.fn()

let nextWcId = 1
let lastWcId = 0

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => {})),
    getPath: (name: string) => join(tmpdir(), 'pdf-saved-path-jobs-app', name),
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

import { documentHashOfFile } from '../../../packages/pdf-structure/src/store'
import { createPdfConvertUiHandlers } from '../../shell/src/main/pdf-convert-ui-handlers'
import { createPdfStructureHandlers } from '../../shell/src/main/pdf-structure/handlers'
import type { StructureJob } from '../../shell/src/main/pdf-structure/protocol'
import type { JobRunOutcome } from '../../shell/src/main/pdf-structure/runner'
import { createPdfView, markPdfUntitledCopy, pdfPathGranted } from '../src/main/pdf-main'
import {
  ConvertDialog,
  type ConvertDialogApi,
  type ConvertDialogProps,
} from '../src/renderer/convert/ConvertDialog'
import { exportEmbeddedImages } from '../src/renderer/convert/embedded-images'
import { strings } from '../src/renderer/i18n/strings'
import { createUntitledSaver } from '../src/renderer/untitled-save'
import { PDF_CHANNELS } from '../src/shared/ipc'
import type { SavePdfRequest, SavePdfResult } from '../src/shared/ipc'

const translate = createI18n(strings)
const t: ConvertDialogProps['t'] = (key, params) => translate('en', key, params)

// these tests do real file work behind a dialog: room for a busy machine (read when the
// tests below are defined)
vi.setConfig({ testTimeout: 20_000 })

const tempDirs = new Set<string>()
let root: Root | null = null
let container: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => showSaveDialog.mockReset())

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  container?.remove()
  root = null
  container = null
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
})

/** An untitled copy the view has read, and the shell's handlers answering that view */
async function untitledCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-saved-path-jobs-'))
  tempDirs.add(dir)
  const path = join(dir, 'Draft.pdf')
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  writeFileSync(path, await doc.save({ useObjectStreams: false }))
  markPdfUntitledCopy(path)
  createPdfView(path)
  const wcId = lastWcId
  const call = <T>(channel: string, ...args: unknown[]) =>
    Promise.resolve(handlers.get(channel)!({ sender: { id: wcId } }, ...args)) as Promise<T>
  await call(PDF_CHANNELS.readFileChunk, path, 0, 1024)

  /** the jobs the structure process was given, each answered as if it had written its files */
  const jobs: StructureJob[] = []
  /** what the shell's save / folder dialog answers, in order */
  const picks: string[] = []
  const structure = createPdfStructureHandlers({
    runner: {
      run: async (_owner, _jobId, job): Promise<JobRunOutcome> => {
        jobs.push(job)
        if (job.op === 'markdown') {
          writeFileSync(job.outPath, '# converted\n')
          const value = { docHash: 'h', outPath: job.outPath, warnings: [] }
          return { ok: true, value: { ...value, assetsWritten: 0, assetsReused: 0 } }
        }
        if (job.op === 'images') {
          const file = join(job.outDir, `${job.baseName}-p1-1.png`)
          writeFileSync(file, 'png')
          const images = [{ page: 1, file, width: 64, height: 64 }]
          return { ok: true, value: { docHash: 'h', outDir: job.outDir, images } }
        }
        return { ok: false, error: 'failed', message: `no answer for ${job.op}` }
      },
      cancel: () => false,
      cancelOwner: () => 0,
    },
    store: () => {
      throw new Error('no result store in this test')
    },
    // apps/shell/src/main/pdf-structure-ipc.ts binds the editor's grant table like this
    isGranted: (owner, granted) => pdfPathGranted(owner, granted),
    pickPath: async () => picks.shift() ?? null,
    hashFile: documentHashOfFile,
  })
  const opened: string[] = []
  const shown: string[] = []
  const ui = createPdfConvertUiHandlers({
    ownsSource: (viewId, source) => pdfPathGranted(viewId, source),
    exists: (file) => existsSync(file),
    showInFolder: (file) => void shown.push(file),
    findMarkdownTab: () => undefined,
    closeTab: async () => {},
    activateView: () => {},
    openDocument: (file) => {
      opened.push(file)
      return true
    },
  })
  const ctx = { owner: wcId, progress: () => {} }
  const api = {
    pickTarget: (request) => structure.pickTarget(wcId, request),
    convert: (request) => structure.convert(ctx, request),
    extractImages: (request: Parameters<typeof structure.extractImages>[1]) =>
      structure.extractImages(ctx, request),
    cancel: async (jobId) => structure.cancel(wcId, jobId),
    onProgress: () => () => {},
    releaseTarget: (request) => ui.releaseTarget(wcId, request),
    openResult: async (request) => ui.openResult(wcId, request),
    revealResult: async (request) => ui.revealResult(wcId, request),
  } satisfies ConvertDialogApi & Record<string, unknown>

  const picked = join(dir, 'Report.pdf')
  /**
   * What the editor does before a structure job when a highlight is pending:
   * the person picks `Report.pdf` in the save dialog, the edit goes into the
   * working file and the document moves there. Resolves to where it is now.
   */
  const saveMovesDocument = vi.fn(async (): Promise<string | null> => {
    const request: SavePdfRequest = {
      path,
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
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: picked })
    const out = await createUntitledSaver({
      pickUntitledCopyTarget: (file, name) => call(PDF_CHANNELS.pickUntitledCopyTarget, file, name),
      adoptUntitledCopy: (file) => call(PDF_CHANNELS.adoptUntitledCopy, file),
    }).save(
      path,
      'Draft.pdf',
      async () => (await call<SavePdfResult>(PDF_CHANNELS.save, request)).ok,
    )
    return out.saved ? out.path : null
  })
  return {
    dir,
    path,
    picked,
    wcId,
    jobs,
    picks,
    structure,
    ctx,
    api,
    opened,
    shown,
    saveMovesDocument,
  }
}

/** The conversion dialog as the editor shows it; `filePath` is where the document was when it opened */
async function convertDialog(props: Partial<ConvertDialogProps> & Pick<ConvertDialogProps, 'api'>) {
  const onClose = vi.fn()
  const el = document.createElement('div')
  container = el
  document.body.appendChild(el)
  root = createRoot(el)
  await act(async () =>
    root!.render(
      createElement(ConvertDialog, {
        format: 'md',
        filePath: '',
        fileName: 'Draft.pdf',
        pageCount: 1,
        docInfo: {},
        password: undefined,
        lang: 'en',
        t,
        prepare: async () => null,
        pageText: async () => '',
        onClose,
        ...props,
      } as ConvertDialogProps),
    ),
  )
  /**
   * Lets the dialog work until its run has ended: it closed, or it shows why it could not
   * go on. Between a click and that end lie the save of the edits, the copy to the picked
   * file and the job, which are real file work and take as long as the machine makes them
   * take. A fixed number of turns ran out before the job on a busy runner.
   */
  const runEnded = () =>
    act(async () => {
      await vi.waitFor(
        () => {
          const ended = onClose.mock.calls.length > 0 || el.querySelector('[data-error="run"]')
          expect(ended).toBeTruthy()
        },
        { timeout: 15_000, interval: 10 },
      )
    })
  return { el, onClose, runEnded }
}

describe('a structure job whose save of the pending edits moves the document', () => {
  it('is refused for the working file of an untitled copy once the copy is saved', async () => {
    const copy = await untitledCopy()
    expect(await copy.saveMovesDocument()).toBe(copy.picked)
    const refused = {
      ok: false,
      error: 'not-granted',
      message: 'pdf: path not granted to this view',
    }

    // what the shell answers a renderer that still names the working file
    expect(await copy.structure.pickTarget(copy.wcId, { kind: 'md', path: copy.path })).toBeNull()
    const source = { jobId: 'j1', path: copy.path }
    expect(
      await copy.structure.convert(copy.ctx, { ...source, format: 'md', outPath: 'x.md' }),
    ).toEqual(refused)
    expect(
      await copy.structure.extractImages(copy.ctx, {
        ...source,
        outDir: copy.dir,
        baseName: 'x',
      }),
    ).toEqual(refused)
    expect(
      await copy.structure.writeBack(copy.ctx, {
        ...source,
        outPath: 'x.pdf',
        payload: { lang: 'de' },
      }),
    ).toEqual(refused)
    expect(await copy.structure.tree(copy.ctx, source)).toEqual(refused)
    expect(copy.jobs).toEqual([])
  })

  it('writes the pictures of the file an untitled copy was saved to', async () => {
    const copy = await untitledCopy()
    copy.picks.push(copy.dir)
    const notice = vi.fn()

    await exportEmbeddedImages({
      api: copy.api,
      password: undefined,
      baseName: 'Draft',
      t,
      prepare: copy.saveMovesDocument,
      onProgress: () => {},
      notice,
    })

    expect(copy.jobs).toMatchObject([
      { op: 'images', source: { pdfPath: copy.picked }, outDir: copy.dir },
    ])
    expect(copy.shown).toEqual([join(copy.dir, 'Draft-p1-1.png')])
    expect(notice.mock.calls).toEqual([[t('imgExportDone', { count: 1 })]])
  })

  it('converts the file an untitled copy was saved to (File › Markdown)', async () => {
    const copy = await untitledCopy()
    const target = join(copy.dir, 'Report.md')
    copy.picks.push(target)

    const { el, onClose, runEnded } = await convertDialog({
      api: copy.api,
      filePath: copy.path,
      prepare: copy.saveMovesDocument,
    })
    await act(async () => (el.querySelector('[data-action="convert"]') as HTMLElement).click())
    await runEnded()

    expect(copy.jobs).toMatchObject([
      { op: 'markdown', source: { pdfPath: copy.picked }, outPath: target },
    ])
    // the Markdown is written and opens in a tab, as after any conversion
    expect(readFileSync(target, 'utf8')).toBe('# converted\n')
    expect(copy.opened).toEqual([target])
    expect(onClose).toHaveBeenCalled()
    expect(el.querySelector('[data-error="run"]')).toBeNull()
  })

  it('converts it to the target Save As › Markdown picked', async () => {
    const copy = await untitledCopy()
    const target = join(copy.dir, 'Report.md')
    // the shell's Save As dialog picked the target while the working file was the document
    expect(copy.structure.grantTarget(copy.wcId, copy.path, target, 'md')).toBe(true)

    const { el, onClose, runEnded } = await convertDialog({
      api: copy.api,
      filePath: copy.path,
      initialTarget: target,
      prepare: copy.saveMovesDocument,
    })
    await runEnded()

    expect(copy.jobs).toMatchObject([
      { op: 'markdown', source: { pdfPath: copy.picked }, outPath: target },
    ])
    expect(copy.opened).toEqual([target])
    expect(onClose).toHaveBeenCalled()
    expect(el.querySelector('[data-error="run"]')).toBeNull()
  })

  it('runs on the path it has when the save moves nothing', async () => {
    const copy = await untitledCopy()
    const target = join(dirname(copy.path), 'Draft.md')
    copy.picks.push(target)

    const { el, onClose, runEnded } = await convertDialog({
      api: copy.api,
      filePath: copy.path,
      prepare: async () => copy.path,
    })
    await act(async () => (el.querySelector('[data-action="convert"]') as HTMLElement).click())
    await runEnded()

    expect(copy.jobs).toMatchObject([{ op: 'markdown', source: { pdfPath: copy.path } }])
    expect(onClose).toHaveBeenCalled()
  })
})
