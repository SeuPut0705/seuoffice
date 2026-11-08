/**
 * Embedded-image extraction ("images inside the page", spec §4): every image
 * object drawn on the chosen pages comes out at its natural pixel size as a
 * PNG. Decorations below MIN_IMAGE_PX and exact duplicates are skipped.
 *
 * Pure function like pdf2docx: the caller owns PDFium wasm setup and passes
 * the initialized module in. The original bytes are never modified; the
 * temporary matrix change below only touches PDFium's in-memory copy.
 */
import {
  BITMAP_FORMAT_BGR,
  BITMAP_FORMAT_BGRA,
  BITMAP_FORMAT_BGRX,
  BITMAP_FORMAT_GRAY,
  FPDF_PAGEOBJ_FORM,
  FPDF_PAGEOBJ_IMAGE,
  withAlloc,
  withPdfDocument,
  type PdfiumModule,
} from '../../../pdf2docx/src/extract/pdfium'
import { encodeRgbaPng } from '../../../pdf2docx/src/extract/png'

/** images narrower or shorter than this (natural px) are decorations and skipped */
export const MIN_IMAGE_PX = 32

/**
 * Total-pixel ceiling for one extracted image. The wasm heap has a hard 2 GiB
 * limit; beyond this the image is rendered proportionally smaller instead of
 * failing the allocation and vanishing (same ceiling pdf2docx uses).
 */
export const MAX_IMAGE_TOTAL_PX = 24_000_000

/** form XObjects nest; PDFium guards cycles, this bounds pathological depth */
const MAX_FORM_DEPTH = 16

export interface EmbeddedImage {
  /** 1-based page number the image is drawn on (first occurrence) */
  page: number
  /** pixel width of `png` */
  width: number
  /** pixel height of `png` */
  height: number
  png: Uint8Array
}

export interface ExtractEmbeddedImagesOptions {
  password?: string
  /** overrides MIN_IMAGE_PX */
  minImagePx?: number
}

interface Rgba {
  rgba: Uint8Array
  width: number
  height: number
}

/**
 * Extract the images embedded in `pages` (1-based, in the given order; a page
 * listed twice is read once). Throws PdfLoadError when the document cannot be
 * opened and RangeError for a page number outside the document.
 */
export function extractEmbeddedImages(
  m: PdfiumModule,
  pdf: Uint8Array,
  pages: readonly number[],
  options: ExtractEmbeddedImagesOptions = {},
): EmbeddedImage[] {
  const minPx = options.minImagePx ?? MIN_IMAGE_PX
  return withPdfDocument(
    m,
    pdf,
    (doc) => {
      const pageCount = m._FPDF_GetPageCount(doc)
      for (const p of pages) {
        if (!Number.isInteger(p) || p < 1 || p > pageCount) {
          throw new RangeError(`page ${p} is outside 1-${pageCount}`)
        }
      }
      const out: EmbeddedImage[] = []
      const seen = new Map<string, Uint8Array[]>()
      for (const p of new Set(pages)) {
        const page = m._FPDF_LoadPage(doc, p - 1)
        if (!page) throw new Error(`PDFium could not load page ${p}`)
        try {
          for (const obj of collectImageObjects(m, page)) {
            const px = extractImageRgba(m, doc, page, obj, minPx)
            if (!px) continue
            const png = encodeRgbaPng(px.rgba, px.width, px.height)
            if (isDuplicate(seen, png)) continue
            out.push({ page: p, width: px.width, height: px.height, png })
          }
        } finally {
          m._FPDF_ClosePage(page)
        }
      }
      return out
    },
    options.password,
  )
}

/** image objects in content order, descending into form XObjects */
function collectImageObjects(m: PdfiumModule, page: number): number[] {
  const found: number[] = []
  const visit = (obj: number, depth: number): void => {
    if (!obj) return
    const type = m._FPDFPageObj_GetType(obj)
    if (type === FPDF_PAGEOBJ_IMAGE) {
      found.push(obj)
    } else if (
      type === FPDF_PAGEOBJ_FORM &&
      depth < MAX_FORM_DEPTH &&
      typeof m._FPDFFormObj_CountObjects === 'function' &&
      typeof m._FPDFFormObj_GetObject === 'function'
    ) {
      const children = m._FPDFFormObj_CountObjects(obj)
      for (let i = 0; i < children; i++) visit(m._FPDFFormObj_GetObject(obj, i), depth + 1)
    }
  }
  const count = m._FPDFPage_CountObjects(page)
  for (let i = 0; i < count; i++) visit(m._FPDFPage_GetObject(page, i), 0)
  return found
}

function naturalSize(m: PdfiumModule, obj: number): [number, number] {
  return withAlloc(m, 8, (p) =>
    m._FPDFImageObj_GetImagePixelSize(obj, p, p + 4)
      ? [m.HEAPU32[p >> 2]!, m.HEAPU32[(p >> 2) + 1]!]
      : [0, 0],
  )
}

function extractImageRgba(
  m: PdfiumModule,
  doc: number,
  page: number,
  obj: number,
  minPx: number,
): Rgba | null {
  const [w, h] = naturalSize(m, obj)
  if (w > 0 && h > 0 && Math.min(w, h) < minPx) return null
  const px = (w > 0 && h > 0 ? renderAtSize(m, doc, page, obj, w, h) : null) ?? rawBitmap(m, obj)
  if (!px || Math.min(px.width, px.height) < minPx) return null
  return px
}

/**
 * Render the object (soft masks and image masks applied, page placement
 * ignored) with its matrix temporarily set to the natural pixel size, so the
 * bitmap comes out upright at the source resolution; restored afterwards.
 */
function renderAtSize(
  m: PdfiumModule,
  doc: number,
  page: number,
  obj: number,
  w: number,
  h: number,
): Rgba | null {
  const fit = Math.min(1, Math.sqrt(MAX_IMAGE_TOTAL_PX / (w * h)))
  const tw = Math.max(1, Math.round(w * fit))
  const th = Math.max(1, Math.round(h * fit))
  return withAlloc(m, 6 * 4, (f6) => {
    if (!m._FPDFPageObj_GetMatrix(obj, f6)) return null
    const base = f6 >> 2
    const orig = Array.from(m.HEAPF32.subarray(base, base + 6))
    m.HEAPF32.set([tw, 0, 0, th, 0, 0], base)
    if (!m._FPDFPageObj_SetMatrix(obj, f6)) return null
    try {
      const bitmap = m._FPDFImageObj_GetRenderedBitmap(doc, page, obj)
      if (!bitmap) return null
      try {
        return bitmapToRgba(m, bitmap)
      } finally {
        m._FPDFBitmap_Destroy(bitmap)
      }
    } finally {
      m.HEAPF32.set(orig, base)
      m._FPDFPageObj_SetMatrix(obj, f6)
    }
  })
}

/** fallback: the decoded image without masks, already at natural size */
function rawBitmap(m: PdfiumModule, obj: number): Rgba | null {
  const bitmap = m._FPDFImageObj_GetBitmap(obj)
  if (!bitmap) return null
  try {
    return bitmapToRgba(m, bitmap)
  } finally {
    m._FPDFBitmap_Destroy(bitmap)
  }
}

function bitmapToRgba(m: PdfiumModule, bitmap: number): Rgba | null {
  const width = m._FPDFBitmap_GetWidth(bitmap)
  const height = m._FPDFBitmap_GetHeight(bitmap)
  const stride = m._FPDFBitmap_GetStride(bitmap)
  const format = m._FPDFBitmap_GetFormat(bitmap)
  const buffer = m._FPDFBitmap_GetBuffer(bitmap)
  if (width <= 0 || height <= 0 || !buffer) return null
  const bytesPerPixel =
    format === BITMAP_FORMAT_BGRA || format === BITMAP_FORMAT_BGRX
      ? 4
      : format === BITMAP_FORMAT_BGR
        ? 3
        : format === BITMAP_FORMAT_GRAY
          ? 1
          : 0
  if (bytesPerPixel === 0) return null
  const rgba = new Uint8Array(width * height * 4)
  const heap = m.HEAPU8
  for (let y = 0; y < height; y++) {
    const rowIn = buffer + y * stride
    for (let x = 0; x < width; x++) {
      const src = rowIn + x * bytesPerPixel
      const dst = (y * width + x) * 4
      if (bytesPerPixel === 1) {
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = heap[src]!
        rgba[dst + 3] = 255
      } else {
        rgba[dst] = heap[src + 2]!
        rgba[dst + 1] = heap[src + 1]!
        rgba[dst + 2] = heap[src]!
        rgba[dst + 3] = format === BITMAP_FORMAT_BGRA ? heap[src + 3]! : 255
      }
    }
  }
  return { rgba, width, height }
}

/**
 * The PNG encoder is deterministic, so equal pixels give equal bytes. Bucket
 * by a cheap hash, then compare bytes exactly so a collision never drops a
 * distinct image. Records `png` when it is new.
 */
function isDuplicate(seen: Map<string, Uint8Array[]>, png: Uint8Array): boolean {
  let hash = 0x811c9dc5
  for (let i = 0; i < png.length; i++) hash = Math.imul(hash ^ png[i]!, 0x01000193)
  const key = `${png.length}:${hash >>> 0}`
  const bucket = seen.get(key)
  if (bucket?.some((other) => bytesEqual(other, png))) return true
  if (bucket) bucket.push(png)
  else seen.set(key, [png])
  return false
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
