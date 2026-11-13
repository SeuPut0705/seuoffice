// @vitest-environment node
/**
 * A PDF cannot carry the mark that hides content from AI. The File menu's PDF
 * export (and Save As › PDF) of a page holding hidden content asks first: export
 * without the marks, or cancel (the HTML page itself is the file that keeps the
 * marks). The command-line export has no one to ask and writes nothing for such
 * a page. A page with nothing hidden is exported as before.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: { sender: FakeWebContents }, ...args: unknown[]) => unknown

interface FakeWebContents {
  id: number
  listeners: Map<string, () => void>
  isDestroyed: ReturnType<typeof vi.fn>
  loadFile: ReturnType<typeof vi.fn>
  loadURL: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  setWindowOpenHandler: ReturnType<typeof vi.fn>
}

const handlers = new Map<string, IpcHandler>()
const showSaveDialog = vi.fn()
const showMessageBox = vi.fn()
const showItemInFolder = vi.fn()
const webContents: FakeWebContents[] = []
let nextWebContentsId = 1

const { convertHtmlToDocx, docxToOdt, printedHtml } = vi.hoisted(() => ({
  convertHtmlToDocx: vi.fn(),
  docxToOdt: vi.fn(),
  printedHtml: [] as string[],
}))
vi.mock('../../../packages/html2docx/src', () => ({ convertHtmlToDocx }))
vi.mock('../../../packages/html2docx/src/drivers/electron', () => ({
  ElectronBrowserDriver: {
    create: vi.fn(async () => ({
      close: vi.fn(async () => {}),
      destroyNow: vi.fn(),
      isWindowDestroyed: vi.fn(() => false),
    })),
  },
}))
vi.mock('@seuoffice/odt-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@seuoffice/odt-engine')>()),
  docxToOdt,
}))

function makeWebContents(): FakeWebContents {
  const listeners = new Map<string, () => void>()
  const contents: FakeWebContents = {
    id: nextWebContentsId++,
    listeners,
    isDestroyed: vi.fn(() => false),
    loadFile: vi.fn(),
    loadURL: vi.fn(),
    once: vi.fn((event: string, listener: () => void) => listeners.set(event, listener)),
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  }
  webContents.push(contents)
  return contents
}

vi.mock('electron', async () => {
  const { readFile } = await import('node:fs/promises')
  return {
    app: {
      getPath: vi.fn(() => tmpdir()),
      on: vi.fn(),
      quit: vi.fn(),
      whenReady: vi.fn(() => new Promise(() => {})),
    },
    // the hidden print window of the PDF export
    BrowserWindow: class {
      static fromWebContents() {
        return null
      }
      static getFocusedWindow() {
        return null
      }
      private loaded = ''
      loadFile = vi.fn(async (path: string) => {
        this.loaded = await readFile(path, 'utf8')
      })
      webContents = {
        printToPDF: vi.fn(async () => {
          printedHtml.push(this.loaded)
          return Buffer.from('%PDF-1.7 page')
        }),
      }
      destroy = vi.fn()
    },
    dialog: {
      showMessageBox: (...args: unknown[]) => showMessageBox(...args),
      showSaveDialog: (...args: unknown[]) => showSaveDialog(...args),
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
      on: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
      removeHandler: vi.fn(),
    },
    net: { fetch: vi.fn() },
    protocol: {
      handle: vi.fn(),
      registerSchemesAsPrivileged: vi.fn(),
    },
    shell: {
      openExternal: vi.fn(),
      showItemInFolder: (...args: unknown[]) => showItemInFolder(...args),
    },
    WebContentsView: class {
      webContents = makeWebContents()
    },
  }
})

import { setHeadlessMode } from '@seuoffice/electron-utils'
import { createHtmlView } from '../src/main/html-main'
import { askMarkedExport } from '../src/main/odt-export'
import { HTML_CHANNELS } from '../src/shared/ipc'
import type { ExportResult, SaveHtmlResult } from '../src/shared/ipc'

const SECRET = '13800138000'
const MARKED = `<p>Call <span data-gx-redact="client phone">${SECRET}</span></p>`
const PLAIN = '<p>Hello</p>'

const temporaryDirectories: string[] = []

afterEach(() => {
  vi.clearAllMocks()
  setHeadlessMode(false)
  printedHtml.length = 0
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const invoke = <T>(channel: string, contents: FakeWebContents, ...args: unknown[]) =>
  handlers.get(channel)!({ sender: contents }, ...args) as Promise<T>

async function openPage(html: string): Promise<{ directory: string; contents: FakeWebContents }> {
  const directory = mkdtempSync(join(tmpdir(), 'html-marked-pdf-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'page.html')
  writeFileSync(path, html)
  const contents = createHtmlView(path).webContents as unknown as FakeWebContents
  await invoke(HTML_CHANNELS.readFile, contents, path)
  return { directory, contents }
}

const exportPdf = (contents: FakeWebContents, html: string, outPath?: string) =>
  invoke<ExportResult>(HTML_CHANNELS.exportPdf, contents, {
    html,
    suggestedName: 'page',
    ...(outPath ? { outPath } : {}),
  })

describe('File › Export › PDF', () => {
  it('asks before a page holding hidden content is written, with Word-free two-way choices', async () => {
    const { directory, contents } = await openPage(MARKED)
    const target = join(directory, 'page.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    showMessageBox.mockResolvedValueOnce({ response: 0 })

    expect(await exportPdf(contents, MARKED)).toEqual({ ok: true, path: target })

    expect(showMessageBox).toHaveBeenCalledTimes(1)
    const box = showMessageBox.mock.calls[0]![0] as {
      buttons: string[]
      cancelId: number
      detail: string
    }
    expect(box.buttons).toHaveLength(2)
    expect(box.cancelId).toBe(1)
    expect(box.detail).toContain('has no hidden-from-AI marks')
  })

  it('writes the words with the marks off when exported without the marks', async () => {
    const { directory, contents } = await openPage(MARKED)
    const target = join(directory, 'page.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    await exportPdf(contents, MARKED)
    expect(readFileSync(target, 'utf8')).toBe('%PDF-1.7 page')
    expect(printedHtml).toHaveLength(1)
    expect(printedHtml[0]).toContain(SECRET)
    expect(printedHtml[0]).not.toContain('data-gx-redact')
  })

  it('cancel writes nothing', async () => {
    const { directory, contents } = await openPage(MARKED)
    const target = join(directory, 'page.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    expect(await exportPdf(contents, MARKED)).toEqual({ ok: true, canceled: true })
    expect(existsSync(target)).toBe(false)
    expect(printedHtml).toHaveLength(0)
  })

  it('a closed box is a cancel', async () => {
    const { directory, contents } = await openPage(MARKED)
    const target = join(directory, 'page.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    showMessageBox.mockResolvedValueOnce({ response: -1 })
    expect(await exportPdf(contents, MARKED)).toEqual({ ok: true, canceled: true })
    expect(existsSync(target)).toBe(false)
  })

  it('does not ask about a page with nothing hidden', async () => {
    const { directory, contents } = await openPage(PLAIN)
    const target = join(directory, 'page.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    expect(await exportPdf(contents, PLAIN)).toEqual({ ok: true, path: target })
    expect(showMessageBox).not.toHaveBeenCalled()
    expect(readFileSync(target, 'utf8')).toBe('%PDF-1.7 page')
  })

  it('the command-line export refuses a marked page and writes nothing', async () => {
    const { directory, contents } = await openPage(MARKED)
    const target = join(directory, 'cli.pdf')
    setHeadlessMode(true)
    const result = await exportPdf(contents, MARKED, target)
    expect(result.ok).toBe(false)
    expect('error' in result && result.error.length).toBeGreaterThan(10)
    expect(existsSync(target)).toBe(false)
    expect(showMessageBox).not.toHaveBeenCalled()
  })

  it('the command-line export still writes a page with nothing hidden', async () => {
    const { directory, contents } = await openPage(PLAIN)
    const target = join(directory, 'cli.pdf')
    setHeadlessMode(true)
    expect(await exportPdf(contents, PLAIN, target)).toEqual({ ok: true, path: target })
    expect(existsSync(target)).toBe(true)
  })
})

describe('Save As › PDF', () => {
  const saveAsPdf = (contents: FakeWebContents, html: string) =>
    invoke<SaveHtmlResult>(HTML_CHANNELS.save, contents, {
      text: html,
      imageSources: [],
      mode: 'saveAs',
    })

  it('asks for a marked page, and cancel writes nothing', async () => {
    const { directory, contents } = await openPage(MARKED)
    const target = join(directory, 'copy.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    showMessageBox.mockResolvedValueOnce({ response: 1 })
    expect(await saveAsPdf(contents, MARKED)).toEqual({ ok: true, canceled: true })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    expect(existsSync(target)).toBe(false)
  })

  it('writes the copy without the marks when the person agrees', async () => {
    const { directory, contents } = await openPage(MARKED)
    const target = join(directory, 'copy.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    showMessageBox.mockResolvedValueOnce({ response: 0 })
    expect(await saveAsPdf(contents, MARKED)).toMatchObject({ ok: true, path: target })
    expect(existsSync(target)).toBe(true)
    expect(printedHtml[0]).not.toContain('data-gx-redact')
  })

  it('does not ask about a page with nothing hidden', async () => {
    const { directory, contents } = await openPage(PLAIN)
    const target = join(directory, 'copy.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    expect(await saveAsPdf(contents, PLAIN)).toMatchObject({ ok: true, path: target })
    expect(showMessageBox).not.toHaveBeenCalled()
  })
})

describe('the box', () => {
  it.each(['en', 'ko'] as const)('has export without the marks and cancel, in %s', async (lang) => {
    const shown: Array<{ buttons: string[]; cancelId: number; message: string; detail: string }> =
      []
    const choice = await askMarkedExport(
      'pdf',
      async (options) => (shown.push(options), { response: 0 }),
      lang,
    )
    expect(choice).toBe('clear')
    expect(shown[0]!.buttons).toHaveLength(2)
    expect(shown[0]!.cancelId).toBe(1)
    expect(shown[0]!.message).toContain('PDF')
    expect(shown[0]!.detail).toContain(
      lang === 'en' ? 'has no hidden-from-AI marks' : '숨김 표시가 없',
    )
  })

  it('answers cancel for the cancel button and for a closed box', async () => {
    for (const response of [1, -1]) {
      expect(await askMarkedExport('pdf', async () => ({ response }), 'en')).toBe('cancel')
    }
  })
})
