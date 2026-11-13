/**
 * The File menu's exports (PDF, page images, HTML, Markdown, Hangul) cannot
 * carry the mark that hides content from AI. A document that holds hidden
 * content asks the person first (Word instead, export without the marks, or
 * cancel); an export nobody can be asked about (the CLI, an automation hook,
 * a headless run) is refused and writes nothing; an unmarked document exports
 * as before. Real file actions on a real editor; the main process is a stub
 * that records what it would write.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildBlankDocx, docxHoldsHiddenContent } from '@seuoffice/docx-engine'
import { editorExtensions } from '../src/renderer/editor/extensions'
import type { DocState } from '../src/renderer/doc-state'
import type { OpenDocxResult } from '../src/shared/ipc'
import type { MarkedExportFormat } from '../src/shared/open-file'

const handoff = new Map<string, Uint8Array>()
vi.mock('../src/renderer/doc-bytes', () => ({
  fetchDocBytes: async (url: string) => {
    const bytes = handoff.get(url)
    if (!bytes) throw new Error(`no bytes for ${url}`)
    handoff.delete(url)
    return bytes.slice()
  },
}))

vi.mock('../src/renderer/components/toast-bus', () => ({
  showToast: () => {},
  setToastEmitter: () => {},
}))

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: () => ({ width: 10, height: 10 }),
        render: () => ({ promise: Promise.resolve() }),
        cleanup: () => {},
      }),
    }),
    destroy: async () => {},
  }),
}))
vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: 'worker.js' }))

const { loadFile, save, exportPdf, exportImages, exportHtml, exportHwp, exportMarkdown } =
  await import('../src/renderer/file-actions')
type Ctx = Parameters<typeof loadFile>[0]

const SECRET = '13800138000'
const LABEL = 'client phone'

let urlSeq = 0
function openResult(path: string, bytes: Uint8Array): OpenDocxResult {
  const url = `test-bytes://${++urlSeq}`
  handoff.set(url, bytes)
  return { path, name: path.split('/').pop() ?? path, dataUrl: url, hash: 'h' }
}

type Choice = 'docx' | 'clear' | 'cancel'
let desktop: Record<string, ReturnType<typeof vi.fn>>
let statuses: string[] = []
/** the docx handed to the Hangul export, per call */
let hwpDocx: Uint8Array[] = []
let pick: { path: string; kind?: string; dir?: string; pdfPath?: string } | null = null

function installDesktop(): void {
  statuses = []
  hwpDocx = []
  pick = null
  desktop = {
    getRecentFiles: vi.fn(async () => []),
    getSystemLocale: vi.fn(async () => 'en-US'),
    docPasswordIntentRevision: vi.fn(async () => 0),
    discardDocPasswordIntents: vi.fn(async () => ({ ok: true })),
    confirmMarkedExport: vi.fn(async (): Promise<Choice> => 'cancel'),
    pickSaveAsPath: vi.fn(async () => pick),
    saveDocxAs: vi.fn(async (path: string) => ({ ok: true, path })),
    saveDocx: vi.fn(async (path: string) => ({ ok: true, path })),
    saveDocxNew: vi.fn(async () => ({ ok: true, path: '/docs/new.docx' })),
    writeRecoveryCopy: vi.fn(async (path: string) => ({ ok: true, path })),
    exportPdf: vi.fn(async (_n: string, _w: number, _h: number, outPath?: string) => ({
      ok: true,
      path: outPath ?? '/picked/report.pdf',
    })),
    exportHtml: vi.fn(async (_n: string, _html: string, outPath?: string) => ({
      ok: true,
      path: outPath ?? '/picked/report.html',
    })),
    exportMarkdown: vi.fn(async (_n: string, _md: string, _i: unknown[], outPath?: string) => ({
      ok: true,
      path: outPath ?? '/picked/report.md',
      imagesDropped: 0,
    })),
    exportHwp: vi.fn(async (_n: string, docx: ArrayBuffer, outPath?: string) => {
      hwpDocx.push(new Uint8Array(docx))
      return { ok: true, path: outPath ?? '/picked/report.hwp' }
    }),
    pickExportImagesTarget: vi.fn(async () => ({
      path: '/picked/report.png',
      dir: '/picked',
      pdfPath: '/tmp/menu.pdf',
    })),
    takeExportPdf: vi.fn(async () => ({ ok: true, base64: btoa('%PDF') })),
    writeExportImage: vi.fn(async (dir: string, fileName: string) => ({
      ok: true,
      path: `${dir}/${fileName}`,
    })),
  }
  ;(window as unknown as { desktop: unknown }).desktop = desktop
}

const editors: Editor[] = []

function makeCtx(): Ctx {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorExtensions,
  })
  editors.push(editor)
  const state: Record<string, unknown> = {
    editor,
    doc: null as DocState | null,
    dirtyRef: { current: false },
    saveInFlightRef: { current: false },
    saveIncompleteRef: { current: false },
    pendingMixedExportRef: { current: false },
    printAutoOpenedPreviewRef: { current: false },
    section: null,
    sectionDirty: false,
    sections: [],
    sectionsDirty: [],
    trailingStartType: null,
    pageColor: null,
    pageColorDirty: false,
    header: null,
    headerDirty: false,
    footer: null,
    footerDirty: false,
    hfVariants: {},
    hfVariantsDirty: [],
    sectionHfEdits: {},
    hfLinks: {},
    titlePg: false,
    titlePgDirty: false,
    evenOddHf: false,
    evenOddHfDirty: false,
    mirrorMargins: false,
    mirrorMarginsDirty: false,
    pgNumEdit: null,
    pgNumDirtySections: [],
    pendingNumbering: { newDefs: [], restartNums: [], levelEdits: [], picBullets: [] },
    numberingDirty: false,
    styleUpserts: {},
    comments: [],
    commentsDirty: false,
    watermark: null,
    watermarkDirty: false,
    watermarkStyle: null,
    watermarkPicture: null,
    inkAnnotations: [],
    inksDirty: false,
    footnotes: [],
    endnotes: [],
    notesDirty: false,
    sources: [],
    sourcesDirty: false,
    zoteroDocumentData: '',
    zoteroDocumentDataDirty: false,
    themeFonts: null,
    themeFontsDirty: false,
    themeColors: null,
    themeColorsDirty: false,
    protection: null,
    protectionDirty: false,
    writeProtection: null,
    writeProtectionDirty: false,
    removePersonalInfo: false,
    removePersonalInfoDirty: false,
    setStatus: (text: string) => statuses.push(text),
    setDoc: (next: unknown) => {
      state.doc = typeof next === 'function' ? (next as (p: unknown) => unknown)(state.doc) : next
    },
  }
  return new Proxy(state, {
    get(target, key) {
      if (
        typeof key === 'string' &&
        !(key in target) &&
        key !== 'settleFontSettings' &&
        /^(set|on|prompt|bump)/.test(key)
      )
        return () => {}
      return target[key as string]
    },
  }) as unknown as Ctx
}

/** the words after "Call " hidden from AI the way the editor's mark writes them */
function hideSecret(editor: Editor): void {
  editor.commands.setContent({
    type: 'doc',
    content: [
      {
        type: 'docParagraph',
        attrs: { docxIndex: null },
        content: [
          { type: 'text', text: 'Call ' },
          {
            type: 'text',
            text: SECRET,
            marks: [
              {
                type: 'redaction',
                attrs: {
                  label: LABEL,
                  rawRPr: `<w:rPr><w:bdr w:val="single" w:sz="6" w:color="6B4FC0"/><go:redact w:label="${LABEL}"/></w:rPr>`,
                },
              },
            ],
          },
        ],
      },
    ],
  })
}

async function openDoc(marked: boolean): Promise<Ctx> {
  const ctx = makeCtx()
  expect(await loadFile(ctx, openResult('/docs/report.docx', await buildBlankDocx({})))).toBe('ok')
  if (marked) hideSecret(ctx.editor!)
  else ctx.editor!.commands.insertContent('plain words')
  ctx.dirtyRef.current = true
  return ctx
}

interface ExportCase {
  format: MarkedExportFormat
  /** the File menu's own action: a person, no path */
  menu(ctx: Ctx): Promise<boolean>
  /** a path handed in with nobody to ask (CLI, automation hook, headless) */
  silent(ctx: Ctx, onRefused: (message: string) => void): Promise<boolean>
  /** a Save As pick of this format */
  saveAsPick: { path: string; kind: string; dir?: string; pdfPath?: string }
  /** how many times the main process was told to write this format */
  writes(): number
}

const cases: ExportCase[] = [
  {
    format: 'pdf',
    menu: (ctx) => exportPdf(ctx),
    silent: (ctx, onRefused) => exportPdf(ctx, '/out/x.pdf', { onRefused }),
    saveAsPick: { path: '/out/report.pdf', kind: 'pdf' },
    writes: () => desktop.exportPdf.mock.calls.length,
  },
  {
    format: 'png',
    menu: (ctx) => exportImages(ctx),
    silent: (ctx, onRefused) =>
      exportImages(ctx, { path: '/out/x.png', dir: '/out', pdfPath: '/tmp/x.pdf' }, { onRefused }),
    saveAsPick: { path: '/out/report.png', kind: 'png', dir: '/out', pdfPath: '/tmp/s.pdf' },
    writes: () => desktop.writeExportImage.mock.calls.length,
  },
  {
    format: 'html',
    menu: (ctx) => exportHtml(ctx),
    silent: (ctx, onRefused) => exportHtml(ctx, '/out/x.html', { onRefused }),
    saveAsPick: { path: '/out/report.html', kind: 'html' },
    writes: () => desktop.exportHtml.mock.calls.length,
  },
  {
    format: 'md',
    menu: (ctx) => exportMarkdown(ctx),
    silent: (ctx, onRefused) => exportMarkdown(ctx, '/out/x.md', { onRefused }),
    saveAsPick: { path: '/out/report.md', kind: 'md' },
    writes: () => desktop.exportMarkdown.mock.calls.length,
  },
  {
    format: 'hwp',
    menu: (ctx) => exportHwp(ctx),
    silent: (ctx, onRefused) => exportHwp(ctx, '/out/x.hwpx', { onRefused }),
    saveAsPick: { path: '/out/report.hwpx', kind: 'hwpx' },
    writes: () => desktop.exportHwp.mock.calls.length,
  },
]

const answer = (choice: Choice) => desktop.confirmMarkedExport.mockResolvedValue(choice)

describe.each(cases)('$format export of a document with content hidden from AI', (c) => {
  beforeEach(() => {
    ;(globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s }
    installDesktop()
    // the PDF export prints the pagination preview's page sheets
    const sheet = document.createElement('div')
    sheet.className = 'pv-page'
    sheet.style.width = '816px'
    sheet.style.height = '1056px'
    document.body.append(sheet)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (cb) {
      cb(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }))
    })
  })
  afterEach(() => {
    while (editors.length) editors.pop()!.destroy()
    document.querySelectorAll('.pv-page').forEach((sheet) => sheet.remove())
    vi.restoreAllMocks()
  })

  it('asks the person first and writes nothing on cancel', async () => {
    const ctx = await openDoc(true)
    answer('cancel')
    expect(await c.menu(ctx)).toBe(false)
    expect(desktop.confirmMarkedExport).toHaveBeenCalledTimes(1)
    expect(desktop.confirmMarkedExport).toHaveBeenCalledWith(c.format)
    expect(c.writes()).toBe(0)
    // the question comes before the export's own dialogs
    expect(desktop.pickExportImagesTarget).not.toHaveBeenCalled()
  })

  it('"export without the marks" writes, and the document keeps its marks', async () => {
    const ctx = await openDoc(true)
    answer('clear')
    expect(await c.menu(ctx)).toBe(true)
    expect(desktop.confirmMarkedExport).toHaveBeenCalledTimes(1)
    expect(c.writes()).toBeGreaterThan(0)
    expect(JSON.stringify(ctx.editor!.state.doc.toJSON())).toContain('redaction')
  })

  it('"save as Word" writes no copy in this format and offers Save As with Word first', async () => {
    const ctx = await openDoc(true)
    answer('docx')
    expect(await c.menu(ctx)).toBe(false)
    expect(c.writes()).toBe(0)
    expect(desktop.pickSaveAsPath).toHaveBeenCalledTimes(1)
    expect(desktop.pickSaveAsPath.mock.calls[0][2]).toBe('docx')
  })

  it('a document without hidden content exports as before, without asking', async () => {
    const ctx = await openDoc(false)
    expect(await c.menu(ctx)).toBe(true)
    expect(desktop.confirmMarkedExport).not.toHaveBeenCalled()
    expect(c.writes()).toBeGreaterThan(0)
  })

  it('a silent export (a path and nobody to ask) is refused with the reason and writes nothing', async () => {
    const ctx = await openDoc(true)
    const reasons: string[] = []
    expect(await c.silent(ctx, (message) => reasons.push(message))).toBe(false)
    expect(desktop.confirmMarkedExport).not.toHaveBeenCalled()
    expect(c.writes()).toBe(0)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('hidden from AI')
    expect(statuses).toContain(reasons[0])
  })

  it('a silent export of an unmarked document still writes', async () => {
    const ctx = await openDoc(false)
    expect(await c.silent(ctx, () => {})).toBe(true)
    expect(desktop.confirmMarkedExport).not.toHaveBeenCalled()
    expect(c.writes()).toBeGreaterThan(0)
  })

  it('Save As to this format asks too, and cancel writes nothing', async () => {
    const ctx = await openDoc(true)
    pick = c.saveAsPick
    answer('cancel')
    expect(await save(ctx, true)).toBe(false)
    expect(desktop.confirmMarkedExport).toHaveBeenCalledWith(c.format)
    expect(c.writes()).toBe(0)
    expect(desktop.saveDocxAs).not.toHaveBeenCalled()
  })

  it('Save As to this format, "save as Word": the same Save As again, Word first', async () => {
    const ctx = await openDoc(true)
    answer('docx')
    desktop.pickSaveAsPath.mockImplementation(async (_n, _s, format) =>
      format === 'docx' && desktop.pickSaveAsPath.mock.calls.length > 1
        ? { path: '/docs/copy.docx', kind: 'docx' }
        : c.saveAsPick,
    )
    expect(await save(ctx, true)).toBe(true)
    expect(c.writes()).toBe(0)
    expect(desktop.pickSaveAsPath).toHaveBeenCalledTimes(2)
    expect(desktop.pickSaveAsPath.mock.calls[1][2]).toBe('docx')
    expect(desktop.saveDocxAs).toHaveBeenCalledTimes(1)
    const written = new Uint8Array(desktop.saveDocxAs.mock.calls[0][1] as ArrayBuffer)
    expect(await docxHoldsHiddenContent(written)).toBe(true)
  })
})

describe('the Hangul copy', () => {
  beforeEach(() => {
    installDesktop()
  })
  afterEach(() => {
    while (editors.length) editors.pop()!.destroy()
    vi.restoreAllMocks()
  })

  it('is converted from a docx with no hidden-from-AI marks once the person chose to export without them', async () => {
    const ctx = await openDoc(true)
    desktop.confirmMarkedExport.mockResolvedValue('clear')
    expect(await exportHwp(ctx)).toBe(true)
    expect(hwpDocx).toHaveLength(1)
    expect(await docxHoldsHiddenContent(hwpDocx[0])).toBe(false)
  })
})
