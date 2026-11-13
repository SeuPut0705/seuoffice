// @vitest-environment node
/**
 * A PDF, page images and an ODT cannot carry the mark that hides content from
 * AI. The File menu exports of such a document ask first (Word keeps the mark,
 * or export without it, or cancel); nothing that cannot ask (the command-line
 * export) writes it. A document with nothing hidden is exported as before.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JSONContent } from '@tiptap/core'

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
const webContents: FakeWebContents[] = []
let nextWebContentsId = 1

const { printMarkdownPdf } = vi.hoisted(() => ({ printMarkdownPdf: vi.fn() }))
vi.mock('../src/main/print-pdf', () => ({ printMarkdownPdf }))

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

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
    on: vi.fn(),
    quit: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => {})),
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null
    }
    static getFocusedWindow() {
      return null
    }
  },
  dialog: {
    showMessageBox: (...args: unknown[]) => showMessageBox(...args),
    showOpenDialog: vi.fn(),
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...args),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn(),
  },
  net: { fetch: vi.fn() },
  protocol: { handle: vi.fn() },
  shell: { openExternal: vi.fn(), showItemInFolder: vi.fn() },
  WebContentsView: class {
    webContents = makeWebContents()
  },
}))

import { askMarkedExport } from '../src/main/odt-export'
import { createMarkdownView } from '../src/main/markdown-main'
import { planMarkedExport } from '../src/renderer/export/marked-export'
import { holdsRedaction } from '../src/renderer/editor/redact'
import { MARKDOWN_CHANNELS } from '../src/shared/ipc'
import type { ExportResult, SaveMarkdownResult } from '../src/shared/ipc'

const SECRET = '13800138000'
const marked = (): JSONContent => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Call ' },
        {
          type: 'text',
          text: SECRET,
          marks: [{ type: 'bold' }, { type: 'redaction', attrs: { label: 'client phone' } }],
        },
      ],
    },
  ],
})
const plain = (): JSONContent => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
})

describe('the question before a menu export', () => {
  it.each(['pdf', 'png', 'odt'] as const)(
    'asks before a marked document is exported as %s, and writes nothing until answered',
    async (format) => {
      let release: (choice: 'clear') => void = () => {}
      const ask = vi.fn(() => new Promise<'clear'>((resolve) => (release = resolve)))
      const planning = planMarkedExport(format, marked(), ask)
      let settled = false
      void planning.then(() => (settled = true))
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(ask).toHaveBeenCalledWith(format)
      expect(settled).toBe(false)
      release('clear')
      expect((await planning).kind).toBe('write')
    },
  )

  it.each(['pdf', 'png', 'odt'] as const)('cancel exports %s nowhere', async (format) => {
    expect(await planMarkedExport(format, marked(), async () => 'cancel')).toEqual({
      kind: 'declined',
    })
  })

  it.each(['pdf', 'png', 'odt'] as const)(
    'export without the marks writes the words with the marks off (%s)',
    async (format) => {
      const original = marked()
      const plan = await planMarkedExport(format, original, async () => 'clear')
      expect(plan.kind).toBe('write')
      if (plan.kind !== 'write') return
      expect(holdsRedaction(plan.json)).toBe(false)
      expect(JSON.stringify(plan.json)).toContain(SECRET)
      // the open document keeps its marks
      expect(holdsRedaction(original)).toBe(true)
    },
  )

  it.each(['pdf', 'png', 'odt'] as const)(
    'Word is the way that keeps the mark (%s)',
    async (format) => {
      expect(await planMarkedExport(format, marked(), async () => 'docx')).toEqual({
        kind: 'save-as-docx',
      })
    },
  )

  it.each(['pdf', 'png', 'odt'] as const)(
    'a document with nothing hidden is exported as %s without a question',
    async (format) => {
      const ask = vi.fn()
      const json = plain()
      expect(await planMarkedExport(format, json, ask)).toEqual({ kind: 'write', json })
      expect(ask).not.toHaveBeenCalled()
    },
  )

  it.each(['docx', 'docs'] as const)('%s keeps the mark, so it is not asked', async (format) => {
    const ask = vi.fn()
    const json = marked()
    expect(await planMarkedExport(format, json, ask)).toEqual({ kind: 'write', json })
    expect(ask).not.toHaveBeenCalled()
  })

  it.each(['pdf', 'png', 'odt'] as const)(
    'refuses %s when no one can be asked (command line, AI)',
    async (format) => {
      expect(await planMarkedExport(format, marked(), null)).toEqual({ kind: 'refused' })
    },
  )
})

describe('the box', () => {
  it.each(['pdf', 'png'] as const)('%s: Word, without the marks, cancel last', async (format) => {
    for (const lang of ['en', 'ko'] as const) {
      const shown: Array<{ buttons: string[]; cancelId: number; detail: string }> = []
      const choice = await askMarkedExport(
        format,
        async (options) => (shown.push(options), { response: 0 }),
        lang,
      )
      expect(choice).toBe('docx')
      expect(shown[0]!.buttons).toHaveLength(3)
      expect(new Set(shown[0]!.buttons).size).toBe(3)
      expect(shown[0]!.cancelId).toBe(2)
      expect(shown[0]!.detail).toContain(
        lang === 'en' ? 'has no hidden-from-AI marks' : '숨김 표시가 없',
      )
    }
  })

  it('answers without the marks for the middle button, cancel for the last and a closed box', async () => {
    const answer = (response: number) => askMarkedExport('pdf', async () => ({ response }), 'en')
    expect(await answer(1)).toBe('clear')
    expect(await answer(2)).toBe('cancel')
    expect(await answer(-1)).toBe('cancel')
  })

  it('names the format that cannot keep the hiding, in English and Korean', async () => {
    const message = async (format: 'pdf' | 'png' | 'odt', lang: 'en' | 'ko') => {
      let out = ''
      await askMarkedExport(format, async (o) => ((out = o.message), { response: 2 }), lang)
      return out
    }
    expect(await message('pdf', 'en')).toContain('PDF')
    expect(await message('odt', 'en')).toContain('ODT')
    expect(await message('pdf', 'ko')).not.toBe(await message('pdf', 'en'))
  })
})

const temporaryDirectories: string[] = []
afterEach(() => {
  vi.clearAllMocks()
  for (const contents of webContents.splice(0)) contents.listeners.get('destroyed')?.()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const invoke = <T>(channel: string, contents: FakeWebContents, ...args: unknown[]) =>
  handlers.get(channel)!({ sender: contents }, ...args) as Promise<T>

async function openDocument(): Promise<{ directory: string; contents: FakeWebContents }> {
  const directory = mkdtempSync(join(tmpdir(), 'markdown-marked-export-'))
  temporaryDirectories.push(directory)
  const mdPath = join(directory, 'note.md')
  writeFileSync(mdPath, '# Note\n\nbody')
  const contents = createMarkdownView(mdPath).webContents as unknown as FakeWebContents
  await invoke(MARKDOWN_CHANNELS.readFile, contents, mdPath)
  return { directory, contents }
}

const saveAsPdf = (contents: FakeWebContents, holdsHiddenContent: boolean) =>
  invoke<SaveMarkdownResult>(MARKDOWN_CHANNELS.save, contents, {
    text: '# Note\n\nedited',
    imageSources: [],
    mode: 'saveAs',
    pdfHtml: '<html><body>Note</body></html>',
    ...(holdsHiddenContent ? { holdsHiddenContent: true } : {}),
  })

describe('Save As › PDF', () => {
  it('writes nothing for a marked document until the renderer has asked', async () => {
    const { directory, contents } = await openDocument()
    const target = join(directory, 'note.pdf')
    printMarkdownPdf.mockResolvedValue(Buffer.from('%PDF-1.4 test'))
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })

    expect(await saveAsPdf(contents, true)).toEqual({ ok: true, path: target, exportAs: 'pdf' })
    expect(existsSync(target)).toBe(false)
    expect(printMarkdownPdf).not.toHaveBeenCalled()

    // the export the renderer then runs writes to the path the dialog approved
    const written = await invoke<ExportResult>(MARKDOWN_CHANNELS.exportPdf, contents, {
      html: '<html><body>Note</body></html>',
      suggestedName: 'note',
      saveAsTarget: target,
    })
    expect(written).toEqual({ ok: true, path: target })
    expect(existsSync(target)).toBe(true)
    expect(showSaveDialog).toHaveBeenCalledTimes(1)
  })

  it('refuses a PDF export aimed at a path the dialog did not approve', async () => {
    const { directory, contents } = await openDocument()
    const target = join(directory, 'note.pdf')
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    await saveAsPdf(contents, true)
    const result = await invoke<ExportResult>(MARKDOWN_CHANNELS.exportPdf, contents, {
      html: '<html></html>',
      suggestedName: 'note',
      saveAsTarget: join(directory, 'elsewhere.pdf'),
    })
    expect(result.ok).toBe(false)
    expect(existsSync(join(directory, 'elsewhere.pdf'))).toBe(false)
  })

  it('still writes the PDF straight away when nothing is hidden', async () => {
    const { directory, contents } = await openDocument()
    const target = join(directory, 'note.pdf')
    printMarkdownPdf.mockResolvedValue(Buffer.from('%PDF-1.4 test'))
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    expect(await saveAsPdf(contents, false)).toEqual({ ok: true, path: target, exported: 'pdf' })
    expect(existsSync(target)).toBe(true)
  })
})
