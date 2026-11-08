import { readFileSync } from 'node:fs'
import {
  convertPdfToDocx,
  convertPdfToPptx,
  convertPdfToXlsx,
  extract,
  PdfLoadError,
  type OcrEngine,
  type PdfiumModule,
} from '@genoffice/pdf2docx'
import { createVisionOcrEngine, createWindowsOcrEngine } from '../../../pdf2docx/src/ocr-vision'
import { clipText } from '../preview'
import { ocrHelperPath, pdfiumWasmPath } from '../resources'

let pdfiumPromise: Promise<PdfiumModule> | null = null

/** Same bootstrap as the app (apps/shell/src/main/pdf2docx-local.ts): wasm bytes read by us, thisProgram pinned so CJK argv cannot abort emscripten init. */
export function loadPdfium(): Promise<PdfiumModule> {
  pdfiumPromise ??= (async () => {
    const { init } = (await import('@embedpdf/pdfium')) as unknown as {
      init(overrides: object): Promise<object>
    }
    const raw = readFileSync(pdfiumWasmPath())
    const wasmBinary = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
    const wrapped = (await init({ wasmBinary, thisProgram: 'genoffice' })) as { pdfium?: unknown }
    const m = (wrapped.pdfium ?? wrapped) as PdfiumModule & { _PDFiumExt_Init(): void }
    m._PDFiumExt_Init()
    return m
  })()
  return pdfiumPromise
}

let ocrEngine: OcrEngine | null | undefined
export function ocr(): OcrEngine | null {
  if (ocrEngine !== undefined) return ocrEngine
  const helper = ocrHelperPath()
  const create = process.platform === 'darwin' ? createVisionOcrEngine : createWindowsOcrEngine
  ocrEngine = helper ? create(helper) : null
  return ocrEngine
}

export interface PdfMetadata {
  title?: string
  author?: string
  subject?: string
  keywords?: string
  creator?: string
  producer?: string
}

const META_TAGS: [keyof PdfMetadata, string][] = [
  ['title', 'Title'],
  ['author', 'Author'],
  ['subject', 'Subject'],
  ['keywords', 'Keywords'],
  ['creator', 'Creator'],
  ['producer', 'Producer'],
]

function pdfMetadata(m: PdfiumModule, doc: number): PdfMetadata {
  const out: PdfMetadata = {}
  for (const [key, tag] of META_TAGS) {
    const value = extract.readMetaText(m, doc, tag)
    if (value) out[key] = value
  }
  return out
}

/** Opens without a password first, so `encrypted` reflects the document rather than the caller's flags. */
async function openPdf<T>(
  bytes: Uint8Array,
  password: string | undefined,
  fn: (m: PdfiumModule, doc: number, encrypted: boolean) => T,
): Promise<T> {
  const m = await loadPdfium()
  try {
    return extract.withPdfDocument(m, bytes, (doc) => fn(m, doc, false))
  } catch (err) {
    if (
      !(err instanceof PdfLoadError) ||
      err.code !== 'password-required' ||
      password === undefined
    )
      throw err
    return extract.withPdfDocument(m, bytes, (doc) => fn(m, doc, true), password)
  }
}

export interface PdfInfo extends PdfMetadata {
  pages: number | null
  encrypted: boolean
}

export async function pdfInfo(bytes: Uint8Array, password?: string): Promise<PdfInfo> {
  try {
    return await openPdf(bytes, password, (m, doc, encrypted) => ({
      pages: m._FPDF_GetPageCount(doc),
      encrypted,
      ...pdfMetadata(m, doc),
    }))
  } catch (err) {
    if (err instanceof PdfLoadError && err.code === 'password-required' && password === undefined)
      return { pages: null, encrypted: true }
    throw err
  }
}

/** Default per-page preview: a dense text page is 3-4k characters, so 20 pages stay under 80k. */
export const PDF_PAGE_PREVIEW_CHARS = 4000
export const PDF_DEFAULT_PAGES = 20

export interface PdfPageText {
  page: number
  width_pt: number
  height_pt: number
  text: string
  truncated: boolean
}

export interface PdfText extends PdfMetadata {
  pages: number
  encrypted: boolean
  pages_read: PdfPageText[]
}

export interface PdfTextOptions {
  password?: string
  maxChars: number
  /** 1-based inclusive page span, chosen once the page count is known */
  select: (pageCount: number) => [number, number]
}

export async function pdfText(bytes: Uint8Array, opts: PdfTextOptions): Promise<PdfText> {
  return openPdf(bytes, opts.password, (m, doc, encrypted) => {
    const pages = m._FPDF_GetPageCount(doc)
    const [from, to] = opts.select(pages)
    const pages_read: PdfPageText[] = []
    for (let page = from; page <= to; page++) pages_read.push(readPage(m, doc, page, opts.maxChars))
    return { pages, encrypted, ...pdfMetadata(m, doc), pages_read }
  })
}

function readPage(m: PdfiumModule, doc: number, page: number, maxChars: number): PdfPageText {
  const handle = m._FPDF_LoadPage(doc, page - 1)
  if (!handle) return { page, width_pt: 0, height_pt: 0, text: '', truncated: false }
  try {
    const width_pt = round(m._FPDF_GetPageWidthF(handle))
    const height_pt = round(m._FPDF_GetPageHeightF(handle))
    const textPage = m._FPDFText_LoadPage(handle)
    let text = ''
    if (textPage) {
      try {
        text = pageText(m, textPage)
      } finally {
        m._FPDFText_ClosePage(textPage)
      }
    }
    return { page, width_pt, height_pt, ...clipText(text, maxChars) }
  } finally {
    m._FPDF_ClosePage(handle)
  }
}

/** Whole textpage in content order; pdfium hands back UTF-16LE with \r\n line breaks and a NUL terminator. */
function pageText(m: PdfiumModule, textPage: number): string {
  const count = m._FPDFText_CountChars(textPage)
  if (count <= 0) return ''
  const text = extract.withAlloc(m, (count + 1) * 2, (buf) => {
    const written = m._FPDFText_GetText(textPage, 0, count, buf)
    if (written <= 0) return ''
    return new TextDecoder('utf-16le').decode(m.HEAPU8.subarray(buf, buf + written * 2))
  })
  return joinSameLineBreaks(m, textPage, text).replace(/\0+$/, '').replace(/\r\n?/g, '\n').trimEnd()
}

/**
 * pdfium starts a new line whenever a glyph begins left of where the previous one ended.
 * PDFs printed by Chromium (Word → PDF export) place tightly kerned Hangul and digits that
 * way, so every few characters came back on their own line ("테\n스\n트"). A generated
 * break whose neighbours share a baseline and run left to right is dropped again; a wide
 * gap on the same line (a table cell) becomes a space.
 */
function joinSameLineBreaks(m: PdfiumModule, textPage: number, text: string): string {
  // GetText writes one UTF-16 unit per char index; bail out when that does not hold
  const count = m._FPDFText_CountChars(textPage)
  if (text.replace(/\0+$/, '').length !== count) return text
  return extract.withAlloc(m, 16, (xy) => {
    const origin = (i: number): [number, number] => {
      m._FPDFText_GetCharOrigin(textPage, i, xy, xy + 8)
      return [m.HEAPF64[xy / 8]!, m.HEAPF64[xy / 8 + 1]!]
    }
    let out = ''
    for (let i = 0; i < count; i++) {
      const isBreak =
        text[i] === '\r' &&
        text[i + 1] === '\n' &&
        m._FPDFText_IsGenerated(textPage, i) === 1 &&
        i > 0 &&
        i + 2 < count
      if (!isBreak) {
        out += text[i]
        continue
      }
      const [px, py] = origin(i - 1)
      const [nx, ny] = origin(i + 2)
      const size = Math.min(
        m._FPDFText_GetFontSize(textPage, i - 1),
        m._FPDFText_GetFontSize(textPage, i + 2),
      )
      if (size > 0 && Math.abs(ny - py) < size * 0.3 && nx > px) {
        if (nx - px > size * 2) out += ' '
        i += 1
        continue
      }
      out += text[i]
    }
    return out
  })
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

export type PdfTarget = 'docx' | 'pptx' | 'xlsx'

export interface PdfConvertOutcome {
  bytes: Uint8Array
  pages: number
  warnings: string[]
}

export async function convertPdf(
  bytes: Uint8Array,
  target: PdfTarget,
  opts: { password?: string; onProgress?: (page: number, total: number) => void },
): Promise<PdfConvertOutcome> {
  const pdfium = await loadPdfium()
  const engine = ocr()
  const convertOpts = {
    pdfium,
    ...(engine ? { ocr: engine } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts.password !== undefined ? { password: opts.password } : {}),
  }
  switch (target) {
    case 'docx': {
      const r = await convertPdfToDocx(bytes, convertOpts)
      return { bytes: r.docx, pages: r.pages, warnings: r.warnings }
    }
    case 'pptx': {
      const r = await convertPdfToPptx(bytes, convertOpts)
      return { bytes: r.pptx, pages: r.pages, warnings: r.warnings }
    }
    case 'xlsx': {
      const r = await convertPdfToXlsx(bytes, convertOpts)
      return { bytes: r.xlsx, pages: r.pages, warnings: r.warnings }
    }
  }
}
