/**
 * Document-level PDFium reads the IR does not carry: bookmarks, the Info
 * dictionary, page fingerprints, and an in-memory page subset for encrypted
 * sources pdf-lib cannot copy. Functions beyond pdf2docx's PdfiumModule are
 * feature-detected (all are exported by @embedpdf/pdfium 2.15).
 */
import type { PdfiumModule } from '../../../pdf2docx/src/extract/pdfium'
import { readMetaText, withAlloc } from '../../../pdf2docx/src/extract'
import { Sha256 } from './hash'
import type { DocumentInfo } from './types'

export interface TreePdfium extends PdfiumModule {
  _FPDFBookmark_GetFirstChild?(doc: number, bookmark: number): number
  _FPDFBookmark_GetNextSibling?(doc: number, bookmark: number): number
  /** UTF-16LE title incl. NUL; returns bytes needed */
  _FPDFBookmark_GetTitle?(bookmark: number, buffer: number, buflen: number): number
  _FPDFBookmark_GetDest?(doc: number, bookmark: number): number
  _FPDFBookmark_GetAction?(bookmark: number): number
  _FPDF_CreateNewDocument?(): number
  /** const int* indices */
  _FPDF_ImportPagesByIndex?(
    dest: number,
    src: number,
    indices: number,
    length: number,
    index: number,
  ): number
  _PDFiumExt_OpenFileWriter?(): number
  _PDFiumExt_SaveAsCopy?(doc: number, writer: number): number
  _PDFiumExt_GetFileWriterSize?(writer: number): number
  _PDFiumExt_GetFileWriterData?(writer: number, buf: number, size: number): number
  _PDFiumExt_CloseFileWriter?(writer: number): void
}

const PDFACTION_GOTO = 1
const FPDF_PAGEOBJ_TEXT = 1
const FPDF_PAGEOBJ_PATH = 2
const FPDF_PAGEOBJ_IMAGE = 3
const FPDF_PAGEOBJ_SHADING = 4
const FPDF_PAGEOBJ_FORM = 5

/** bookmark nodes visited at most (cyclic /Next chains exist in the wild) */
const MAX_BOOKMARKS = 5000
const MAX_BOOKMARK_DEPTH = 32

export interface RawBookmark {
  title: string
  /** 1-based depth */
  level: number
  /** 0-based page index in the source document, -1 when unresolved */
  pageIndex: number
}

function bookmarkTitle(m: TreePdfium, bm: number): string {
  const get = m._FPDFBookmark_GetTitle!.bind(m)
  const needed = get(bm, 0, 0)
  if (needed <= 2) return ''
  return withAlloc(m, needed, (buf) => {
    get(bm, buf, needed)
    return new TextDecoder('utf-16le').decode(m.HEAPU8.subarray(buf, buf + needed - 2)).trim()
  })
}

function bookmarkPage(m: TreePdfium, doc: number, bm: number): number {
  let dest = m._FPDFBookmark_GetDest?.(doc, bm) ?? 0
  if (!dest) {
    const action = m._FPDFBookmark_GetAction?.(bm) ?? 0
    if (action && m._FPDFAction_GetType?.(action) === PDFACTION_GOTO) {
      dest = m._FPDFAction_GetDest?.(doc, action) ?? 0
    }
  }
  if (!dest || !m._FPDFDest_GetDestPageIndex) return -1
  return m._FPDFDest_GetDestPageIndex(doc, dest)
}

/** the document outline flattened in document order */
export function readBookmarks(m: TreePdfium, doc: number): RawBookmark[] {
  if (!m._FPDFBookmark_GetFirstChild || !m._FPDFBookmark_GetNextSibling) return []
  if (!m._FPDFBookmark_GetTitle) return []
  const out: RawBookmark[] = []
  const seen = new Set<number>()
  const walk = (parent: number, level: number): void => {
    if (level > MAX_BOOKMARK_DEPTH) return
    let bm = m._FPDFBookmark_GetFirstChild!(doc, parent)
    while (bm && !seen.has(bm) && seen.size < MAX_BOOKMARKS) {
      seen.add(bm)
      out.push({ title: bookmarkTitle(m, bm), level, pageIndex: bookmarkPage(m, doc, bm) })
      walk(bm, level + 1)
      bm = m._FPDFBookmark_GetNextSibling!(doc, bm)
    }
  }
  walk(0, 1)
  return out
}

export function readDocumentInfo(m: PdfiumModule, doc: number): DocumentInfo {
  const info: DocumentInfo = {}
  const title = readMetaText(m, doc, 'Title')
  const author = readMetaText(m, doc, 'Author')
  const subject = readMetaText(m, doc, 'Subject')
  const keywords = readMetaText(m, doc, 'Keywords')
  if (title) info.title = title
  if (author) info.author = author
  if (subject) info.subject = subject
  if (keywords) info.keywords = keywords
  return info
}

// ── page fingerprints ──

function pageText(m: PdfiumModule, page: number): string {
  const textPage = m._FPDFText_LoadPage(page)
  if (!textPage) return ''
  try {
    const count = m._FPDFText_CountChars(textPage)
    if (count <= 0) return ''
    return withAlloc(m, (count + 1) * 2, (buf) => {
      const written = m._FPDFText_GetText(textPage, 0, count, buf)
      const units = Math.max(0, written - 1)
      return new TextDecoder('utf-16le').decode(m.HEAPU8.subarray(buf, buf + units * 2))
    })
  } finally {
    m._FPDFText_ClosePage(textPage)
  }
}

function hashObjects(m: PdfiumModule, objects: number[], hash: Sha256, counts: number[]): void {
  for (const obj of objects) {
    const type = m._FPDFPageObj_GetType(obj)
    if (type >= 0 && type < counts.length) counts[type]!++
    if (type === FPDF_PAGEOBJ_IMAGE) {
      const size = m._FPDFImageObj_GetImageDataRaw(obj, 0, 0)
      if (size > 0) {
        withAlloc(m, size, (buf) => {
          m._FPDFImageObj_GetImageDataRaw(obj, buf, size)
          hash.update('\u0001img:')
          hash.update(m.HEAPU8.subarray(buf, buf + size))
        })
      }
    } else if (
      type === FPDF_PAGEOBJ_FORM &&
      m._FPDFFormObj_CountObjects &&
      m._FPDFFormObj_GetObject
    ) {
      const n = m._FPDFFormObj_CountObjects(obj)
      const kids: number[] = []
      for (let i = 0; i < n; i++) kids.push(m._FPDFFormObj_GetObject(obj, i))
      hashObjects(m, kids, hash, counts)
    }
  }
}

/**
 * Content hash of one page: its text (whitespace-normalized), the raw bytes
 * of every image object, the object census and the page size. Nothing about
 * the page's position enters, so reordering pages keeps each fingerprint,
 * and a page copied into a range subset hashes the same.
 */
export function pageFingerprint(m: PdfiumModule, doc: number, index: number): string {
  const page = m._FPDF_LoadPage(doc, index)
  if (!page) return new Sha256().update(`unloadable`).hex()
  try {
    const hash = new Sha256()
    const w = Math.round(m._FPDF_GetPageWidthF(page))
    const h = Math.round(m._FPDF_GetPageHeightF(page))
    hash.update(`size:${w}x${h}\u0001text:`)
    hash.update(pageText(m, page).replace(/\s+/g, ' ').trim())
    const objects: number[] = []
    const count = m._FPDFPage_CountObjects(page)
    for (let i = 0; i < count; i++) objects.push(m._FPDFPage_GetObject(page, i))
    const counts = [0, 0, 0, 0, 0, 0]
    hashObjects(m, objects, hash, counts)
    const census = [FPDF_PAGEOBJ_TEXT, FPDF_PAGEOBJ_PATH, FPDF_PAGEOBJ_IMAGE, FPDF_PAGEOBJ_SHADING]
      .map((t) => counts[t])
      .join(',')
    hash.update(`\u0001objects:${census}`)
    return hash.hex()
  } finally {
    m._FPDF_ClosePage(page)
  }
}

// ── PDFium page subset (encrypted sources) ──

/** copy the given 0-based pages into a new unencrypted in-memory PDF */
export function subsetWithPdfium(m: TreePdfium, doc: number, indices: number[]): Uint8Array | null {
  if (
    !m._FPDF_CreateNewDocument ||
    !m._FPDF_ImportPagesByIndex ||
    !m._PDFiumExt_OpenFileWriter ||
    !m._PDFiumExt_SaveAsCopy ||
    !m._PDFiumExt_GetFileWriterSize ||
    !m._PDFiumExt_GetFileWriterData ||
    !m._PDFiumExt_CloseFileWriter
  ) {
    return null
  }
  const dest = m._FPDF_CreateNewDocument()
  if (!dest) return null
  try {
    const ok = withAlloc(m, indices.length * 4, (ptr) => {
      indices.forEach((v, i) => (m.HEAPU32[(ptr >> 2) + i] = v))
      return m._FPDF_ImportPagesByIndex!(dest, doc, ptr, indices.length, 0)
    })
    if (!ok) return null
    const writer = m._PDFiumExt_OpenFileWriter()
    try {
      if (!m._PDFiumExt_SaveAsCopy(dest, writer)) return null
      const size = m._PDFiumExt_GetFileWriterSize(writer)
      return withAlloc(m, size, (buf) => {
        m._PDFiumExt_GetFileWriterData!(writer, buf, size)
        return Uint8Array.from(m.HEAPU8.subarray(buf, buf + size))
      })
    } finally {
      m._PDFiumExt_CloseFileWriter(writer)
    }
  } finally {
    m._FPDF_CloseDocument(dest)
  }
}
