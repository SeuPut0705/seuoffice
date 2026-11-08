/**
 * Find blank-page candidates (the PDF tools window, decision 0030). Nothing
 * is removed here: the window shows the candidates and the user picks which
 * pages go. The rules lean towards "not blank":
 *
 * - a page with any visible character in its text layer (an invisible OCR
 *   layer included) is never a candidate;
 * - a page that draws nothing at all is 'empty';
 * - otherwise the page is rendered and counts as 'nearly-white' only when its
 *   ink is scattered specks: almost no dark pixels inside the margins, and no
 *   small area where dark pixels gather the way strokes of a glyph do.
 *
 * Runs on a PDFium module with a document already open; the structure-job
 * process calls it so a long document never stalls the app.
 */

/** the PDFium calls this needs (both the editor's and pdf2docx's modules have them) */
export interface BlankPagesPdfium {
  HEAPU8: Uint8Array
  _FPDF_GetPageCount(doc: number): number
  _FPDF_LoadPage(doc: number, index: number): number
  _FPDF_ClosePage(page: number): void
  _FPDF_GetPageWidthF(page: number): number
  _FPDF_GetPageHeightF(page: number): number
  _FPDFPage_CountObjects(page: number): number
  _FPDFText_LoadPage(page: number): number
  _FPDFText_ClosePage(textPage: number): void
  _FPDFText_CountChars(textPage: number): number
  _FPDFText_GetUnicode(textPage: number, index: number): number
  _FPDFBitmap_Create(width: number, height: number, alpha: number): number
  _FPDFBitmap_Destroy(bitmap: number): void
  _FPDFBitmap_FillRect(
    bitmap: number,
    left: number,
    top: number,
    width: number,
    height: number,
    color: number,
  ): number
  _FPDFBitmap_GetBuffer(bitmap: number): number
  _FPDFBitmap_GetStride(bitmap: number): number
  _FPDF_RenderPageBitmap(
    bitmap: number,
    page: number,
    startX: number,
    startY: number,
    sizeX: number,
    sizeY: number,
    rotate: number,
    flags: number,
  ): void
}

export type BlankReason = 'empty' | 'nearly-white'

export interface PageThumb {
  width: number
  height: number
  /** BGRA, 4 bytes a pixel, no row padding */
  bgra: Uint8Array
}

export interface BlankPageCandidate {
  /** 1-based */
  page: number
  reason: BlankReason
  /** null once MAX_THUMBS candidates have one */
  thumb: PageThumb | null
}

export interface BlankPagesResult {
  pageCount: number
  candidates: BlankPageCandidate[]
}

/** pixels on the long side of the page render the judgement looks at */
export const RENDER_LONG_SIDE = 600
/** pixels on the long side of a candidate's thumbnail */
export const THUMB_LONG_SIDE = 240
/** candidates past this many come without a thumbnail (they travel between processes) */
export const MAX_THUMBS = 120

/** luminance (0-255) below which a pixel counts as ink */
const INK_LUMA = 160
/** share of each side left out: scanner shadows and punched holes sit there */
const BORDER = 0.04
/** square cells ink is gathered in, in render pixels */
const CELL = 12
/** a cell this full of ink holds a stroke, not a speck */
const DENSE_CELL = 0.15
/** most ink a nearly white page may have, as a share of the area inside the margins */
const MAX_INK = 0.005

/** FPDF_ANNOT: draw annotation appearances too, so a stamped page is not blank */
const RENDER_FLAGS = 0x01

/** whether a page's own text has a character that shows */
function hasVisibleText(m: BlankPagesPdfium, page: number): boolean {
  const text = m._FPDFText_LoadPage(page)
  if (!text) return false
  try {
    const count = m._FPDFText_CountChars(text)
    for (let i = 0; i < count; i++) {
      const code = m._FPDFText_GetUnicode(text, i)
      // spaces, controls, no-break space and pdfium's generated hyphen/line markers
      if (code > 0x20 && code !== 0xa0 && code !== 0xfffe && code !== 0xfeff) return true
    }
    return false
  } finally {
    m._FPDFText_ClosePage(text)
  }
}

/**
 * Whether a rendered page (BGRA) is white but for scattered specks. Exported
 * so the rule can be tested on drawn bitmaps.
 */
export function isNearlyWhite(
  bgra: Uint8Array,
  width: number,
  height: number,
  stride = width * 4,
): boolean {
  const x0 = Math.floor(width * BORDER)
  const y0 = Math.floor(height * BORDER)
  const x1 = width - x0
  const y1 = height - y0
  const cols = Math.ceil((x1 - x0) / CELL)
  const rows = Math.ceil((y1 - y0) / CELL)
  const cells = new Uint32Array(cols * rows)
  let ink = 0
  for (let y = y0; y < y1; y++) {
    const row = y * stride
    const cellRow = Math.floor((y - y0) / CELL) * cols
    for (let x = x0; x < x1; x++) {
      const at = row + x * 4
      // BGRA; Rec. 601 luma
      const luma = 0.114 * bgra[at]! + 0.587 * bgra[at + 1]! + 0.299 * bgra[at + 2]!
      if (luma < INK_LUMA) {
        ink++
        cells[cellRow + Math.floor((x - x0) / CELL)]!++
      }
    }
  }
  const area = (x1 - x0) * (y1 - y0)
  if (area <= 0) return true
  if (ink / area > MAX_INK) return false
  const dense = CELL * CELL * DENSE_CELL
  for (const count of cells) if (count >= dense) return false
  return true
}

/** a box-filtered copy of a BGRA bitmap scaled to `longSide` */
export function shrinkBitmap(
  bgra: Uint8Array,
  width: number,
  height: number,
  stride: number,
  longSide: number,
): PageThumb {
  const scale = Math.min(1, longSide / Math.max(width, height))
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const out = new Uint8Array(w * h * 4)
  for (let ty = 0; ty < h; ty++) {
    const sy0 = Math.floor((ty * height) / h)
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * height) / h))
    for (let tx = 0; tx < w; tx++) {
      const sx0 = Math.floor((tx * width) / w)
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * width) / w))
      let b = 0
      let g = 0
      let r = 0
      let n = 0
      for (let y = sy0; y < sy1; y++) {
        for (let x = sx0; x < sx1; x++) {
          const at = y * stride + x * 4
          b += bgra[at]!
          g += bgra[at + 1]!
          r += bgra[at + 2]!
          n++
        }
      }
      const to = (ty * w + tx) * 4
      out[to] = b / n
      out[to + 1] = g / n
      out[to + 2] = r / n
      out[to + 3] = 255
    }
  }
  return { width: w, height: h, bgra: out }
}

/** a white thumbnail the shape of a page, for a page that draws nothing */
function whiteThumb(pageW: number, pageH: number): PageThumb {
  const scale = THUMB_LONG_SIDE / Math.max(pageW, pageH, 1)
  const width = Math.max(1, Math.round(pageW * scale))
  const height = Math.max(1, Math.round(pageH * scale))
  return { width, height, bgra: new Uint8Array(width * height * 4).fill(255) }
}

/** The blank-page candidates of an open document, in page order */
export function findBlankPages(
  m: BlankPagesPdfium,
  doc: number,
  onProgress?: (done: number, total: number) => void,
): BlankPagesResult {
  const pageCount = m._FPDF_GetPageCount(doc)
  const candidates: BlankPageCandidate[] = []
  let thumbs = 0
  for (let index = 0; index < pageCount; index++) {
    const page = m._FPDF_LoadPage(doc, index)
    if (!page) {
      onProgress?.(index + 1, pageCount)
      continue
    }
    try {
      if (hasVisibleText(m, page)) continue
      const pageW = m._FPDF_GetPageWidthF(page)
      const pageH = m._FPDF_GetPageHeightF(page)
      const wantThumb = thumbs < MAX_THUMBS
      if (m._FPDFPage_CountObjects(page) === 0) {
        candidates.push({
          page: index + 1,
          reason: 'empty',
          thumb: wantThumb ? whiteThumb(pageW, pageH) : null,
        })
        if (wantThumb) thumbs++
        continue
      }
      const scale = RENDER_LONG_SIDE / Math.max(pageW, pageH, 1)
      const width = Math.max(1, Math.round(pageW * scale))
      const height = Math.max(1, Math.round(pageH * scale))
      const bitmap = m._FPDFBitmap_Create(width, height, 0)
      if (!bitmap) continue
      try {
        m._FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff)
        m._FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, RENDER_FLAGS)
        const stride = m._FPDFBitmap_GetStride(bitmap)
        const ptr = m._FPDFBitmap_GetBuffer(bitmap)
        // a view, not a copy: read before the bitmap is destroyed
        const pixels = m.HEAPU8.subarray(ptr, ptr + stride * height)
        if (!isNearlyWhite(pixels, width, height, stride)) continue
        candidates.push({
          page: index + 1,
          reason: 'nearly-white',
          thumb: wantThumb ? shrinkBitmap(pixels, width, height, stride, THUMB_LONG_SIDE) : null,
        })
        if (wantThumb) thumbs++
      } finally {
        m._FPDFBitmap_Destroy(bitmap)
      }
    } finally {
      m._FPDF_ClosePage(page)
      onProgress?.(index + 1, pageCount)
    }
  }
  return { pageCount, candidates }
}
