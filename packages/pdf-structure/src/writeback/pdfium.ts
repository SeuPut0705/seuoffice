/**
 * The PDFium surface the writeback edits pages with, plus page geometry
 * (crop origin and /Rotate) and a page bitmap for color sampling.
 *
 * Tree regions live in display space: user space shifted to the crop box
 * origin and turned upright by /Rotate (pdf2docx extractPage). Page objects
 * live in raw user space. PageFrame converts between the two.
 */
import { withAlloc, type PdfiumModule } from '../../../pdf2docx/src/extract/pdfium'
import type { Rect } from '../tree/types'

export interface WritebackPdfium extends PdfiumModule {
  _FPDF_GetSecurityHandlerRevision(doc: number): number
  _FPDFText_GetCharAngle(textPage: number, index: number): number
  _FPDFText_LoadFont(doc: number, data: number, size: number, fontType: number, cid: number): number
  _FPDFText_SetText(textObj: number, text: number): number
  _FPDFPageObj_CreateTextObj(doc: number, font: number, size: number): number
  _FPDFPageObj_CreateNewRect(x: number, y: number, width: number, height: number): number
  _FPDFPageObj_SetFillColor(obj: number, r: number, g: number, b: number, a: number): number
  _FPDFPageObj_SetStrokeColor(obj: number, r: number, g: number, b: number, a: number): number
  _FPDFPageObj_SetStrokeWidth(obj: number, width: number): number
  _FPDFPath_SetDrawMode(path: number, fillMode: number, stroke: number): number
  _FPDFTextObj_SetTextRenderMode(obj: number, mode: number): number
  _FPDFPage_InsertObject(page: number, obj: number): void
  _FPDFPage_GenerateContent(page: number): number
  _PDFiumExt_OpenFileWriter(): number
  _PDFiumExt_SaveAsCopy(doc: number, writer: number): number
  _PDFiumExt_GetFileWriterSize(writer: number): number
  _PDFiumExt_GetFileWriterData(writer: number, buf: number, size: number): number
  _PDFiumExt_CloseFileWriter(writer: number): void
}

export const FPDF_PAGEOBJ_TEXT = 1
export const FPDF_PAGEOBJ_FORM = 5
export const FPDF_FONT_TRUETYPE = 2
export const FPDF_FILLMODE_ALTERNATE = 1
export const FPDF_TEXTRENDERMODE_FILL_STROKE = 2
/** render modes that paint nothing (3 invisible, 7 clip only) */
export const INVISIBLE_RENDER_MODES = new Set([3, 7])

export type Rgb = readonly [number, number, number]

const EXPORTS: (keyof WritebackPdfium)[] = [
  '_FPDF_GetSecurityHandlerRevision',
  '_FPDFText_GetCharAngle',
  '_FPDFText_LoadFont',
  '_FPDFText_SetText',
  '_FPDFPageObj_CreateTextObj',
  '_FPDFPageObj_CreateNewRect',
  '_FPDFPageObj_SetFillColor',
  '_FPDFPageObj_SetStrokeColor',
  '_FPDFPageObj_SetStrokeWidth',
  '_FPDFPath_SetDrawMode',
  '_FPDFTextObj_SetTextRenderMode',
  '_FPDFPage_InsertObject',
  '_FPDFPage_GenerateContent',
  '_PDFiumExt_OpenFileWriter',
  '_PDFiumExt_SaveAsCopy',
  '_PDFiumExt_GetFileWriterSize',
  '_PDFiumExt_GetFileWriterData',
  '_PDFiumExt_CloseFileWriter',
]

/** the module with the editing exports checked present */
export function asWritebackPdfium(m: PdfiumModule): WritebackPdfium {
  const missing = EXPORTS.filter((k) => typeof (m as Partial<WritebackPdfium>)[k] !== 'function')
  if (missing.length > 0) {
    throw new Error(`the PDFium module lacks page-editing exports: ${missing.join(', ')}`)
  }
  return m as WritebackPdfium
}

/** NUL-terminated UTF-16LE copy of `text` on the wasm heap (caller frees) */
export function utf16Ptr(m: PdfiumModule, text: string): number {
  const ptr = m._malloc((text.length + 1) * 2)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    m.HEAPU8[ptr + i * 2] = c & 0xff
    m.HEAPU8[ptr + i * 2 + 1] = c >> 8
  }
  m.HEAPU8[ptr + text.length * 2] = 0
  m.HEAPU8[ptr + text.length * 2 + 1] = 0
  return ptr
}

export function saveDocument(m: WritebackPdfium, doc: number): Uint8Array {
  const writer = m._PDFiumExt_OpenFileWriter()
  try {
    if (!m._PDFiumExt_SaveAsCopy(doc, writer)) throw new Error('PDFium could not save the document')
    const size = m._PDFiumExt_GetFileWriterSize(writer)
    return withAlloc(m, size, (buf) => {
      m._PDFiumExt_GetFileWriterData(writer, buf, size)
      return Uint8Array.from(m.HEAPU8.subarray(buf, buf + size))
    })
  } finally {
    m._PDFiumExt_CloseFileWriter(writer)
  }
}

/** user-space bounds of a page object, or null */
export function objectBounds(m: PdfiumModule, obj: number): Rect | null {
  return withAlloc(m, 16, (p) => {
    if (!m._FPDFPageObj_GetBounds(obj, p, p + 4, p + 8, p + 12)) return null
    const f = m.HEAPF32
    return { x0: f[p >> 2]!, y0: f[(p >> 2) + 1]!, x1: f[(p >> 2) + 2]!, y1: f[(p >> 2) + 3]! }
  })
}

export function objectFillColor(m: PdfiumModule, obj: number): Rgb | null {
  return withAlloc(m, 16, (p) => {
    if (!m._FPDFPageObj_GetFillColor(obj, p, p + 4, p + 8, p + 12)) return null
    const u = m.HEAPU32
    return [u[p >> 2]!, u[(p >> 2) + 1]!, u[(p >> 2) + 2]!]
  })
}

// ── page frame ──

/**
 * Display space ↔ user space of one page. Display space is what the tree
 * and the rendered bitmap use: origin at the crop box's lower-left corner,
 * upright after /Rotate, size widthPt × heightPt.
 */
export class PageFrame {
  readonly widthPt: number
  readonly heightPt: number
  /** quarter turns of /Rotate (0–3) */
  readonly rotation: number
  private readonly dx: number
  private readonly dy: number
  private readonly userW: number
  private readonly userH: number

  constructor(m: PdfiumModule, page: number) {
    this.widthPt = m._FPDF_GetPageWidthF(page)
    this.heightPt = m._FPDF_GetPageHeightF(page)
    const r = m._FPDFPage_GetRotation(page)
    this.rotation = r >= 1 && r <= 3 ? r : 0
    const odd = this.rotation % 2 === 1
    this.userW = odd ? this.heightPt : this.widthPt
    this.userH = odd ? this.widthPt : this.heightPt
    const origin = withAlloc(m, 16, (p) => {
      // flipped boxes exist: the origin is the minimum corner (pdf2docx pageOriginOffset)
      const read = (fn: (pg: number, l: number, b: number, r: number, t: number) => number) =>
        fn(page, p, p + 4, p + 8, p + 12)
          ? {
              l: Math.min(m.HEAPF32[p >> 2]!, m.HEAPF32[(p >> 2) + 2]!),
              b: Math.min(m.HEAPF32[(p >> 2) + 1]!, m.HEAPF32[(p >> 2) + 3]!),
            }
          : null
      return read(m._FPDFPage_GetCropBox.bind(m)) ?? read(m._FPDFPage_GetMediaBox.bind(m))
    })
    this.dx = origin ? -origin.l : 0
    this.dy = origin ? -origin.b : 0
  }

  toDisplay(x: number, y: number): [number, number] {
    const sx = x + this.dx
    const sy = y + this.dy
    switch (this.rotation) {
      case 1:
        return [sy, this.userW - sx]
      case 2:
        return [this.userW - sx, this.userH - sy]
      case 3:
        return [this.userH - sy, sx]
      default:
        return [sx, sy]
    }
  }

  toUser(X: number, Y: number): [number, number] {
    let sx: number
    let sy: number
    switch (this.rotation) {
      case 1:
        sx = this.userW - Y
        sy = X
        break
      case 2:
        sx = this.userW - X
        sy = this.userH - Y
        break
      case 3:
        sx = Y
        sy = this.userH - X
        break
      default:
        sx = X
        sy = Y
    }
    return [sx - this.dx, sy - this.dy]
  }

  rectToDisplay(r: Rect): Rect {
    return spanRect(this.toDisplay(r.x0, r.y0), this.toDisplay(r.x1, r.y1))
  }

  rectToUser(r: Rect): Rect {
    return spanRect(this.toUser(r.x0, r.y0), this.toUser(r.x1, r.y1))
  }

  /** user-space text axes [a, b, c, d] that draw upright in display space */
  textAxes(): readonly [number, number, number, number] {
    switch (this.rotation) {
      case 1:
        return [0, 1, -1, 0]
      case 2:
        return [-1, 0, 0, -1]
      case 3:
        return [0, -1, 1, 0]
      default:
        return [1, 0, 0, 1]
    }
  }

  /** quarter turns added to a FPDFText char angle to make it display-relative */
  get angleDelta(): number {
    return this.rotation * (Math.PI / 2)
  }
}

const spanRect = (a: [number, number], b: [number, number]): Rect => ({
  x0: Math.min(a[0], b[0]),
  y0: Math.min(a[1], b[1]),
  x1: Math.max(a[0], b[0]),
  y1: Math.max(a[1], b[1]),
})

// ── page bitmap ──

/** an opaque RGBA render of a page in display space */
export interface PageBitmap {
  rgba: Uint8Array
  width: number
  height: number
  /** pixels per point */
  scale: number
  heightPt: number
}

const BITMAP_FORMAT_BGRX = 3
const BITMAP_FORMAT_BGRA = 4
const BITMAP_FORMAT_BGR = 2
const BITMAP_FORMAT_GRAY = 1

export function renderPageBitmap(
  m: PdfiumModule,
  page: number,
  frame: PageFrame,
  scale: number,
): PageBitmap | null {
  const width = Math.max(1, Math.round(frame.widthPt * scale))
  const height = Math.max(1, Math.round(frame.heightPt * scale))
  const bitmap = m._FPDFBitmap_Create(width, height, 0)
  if (!bitmap) return null
  try {
    m._FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff)
    m._FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 0)
    const stride = m._FPDFBitmap_GetStride(bitmap)
    const format = m._FPDFBitmap_GetFormat(bitmap)
    const buffer = m._FPDFBitmap_GetBuffer(bitmap)
    if (!buffer) return null
    const heap = m.HEAPU8
    const rgba = new Uint8Array(width * height * 4)
    const bpp =
      format === BITMAP_FORMAT_BGRA || format === BITMAP_FORMAT_BGRX
        ? 4
        : format === BITMAP_FORMAT_BGR
          ? 3
          : format === BITMAP_FORMAT_GRAY
            ? 1
            : 0
    if (bpp === 0) return null
    for (let y = 0; y < height; y++) {
      const row = buffer + y * stride
      for (let x = 0; x < width; x++) {
        const s = row + x * bpp
        const d = (y * width + x) * 4
        if (bpp === 1) {
          rgba[d] = rgba[d + 1] = rgba[d + 2] = heap[s]!
        } else {
          rgba[d] = heap[s + 2]!
          rgba[d + 1] = heap[s + 1]!
          rgba[d + 2] = heap[s]!
        }
        rgba[d + 3] = 255
      }
    }
    return { rgba, width, height, scale, heightPt: frame.heightPt }
  } finally {
    m._FPDFBitmap_Destroy(bitmap)
  }
}

/** pixel rectangle [x0, y0, x1, y1) of a display rect, clipped to the bitmap */
function pixelRect(b: PageBitmap, r: Rect): [number, number, number, number] {
  const clamp = (v: number, hi: number) => Math.max(0, Math.min(hi, v))
  return [
    clamp(Math.floor(r.x0 * b.scale), b.width),
    clamp(Math.floor((b.heightPt - r.y1) * b.scale), b.height),
    clamp(Math.ceil(r.x1 * b.scale), b.width),
    clamp(Math.ceil((b.heightPt - r.y0) * b.scale), b.height),
  ]
}

const median = (values: number[]): number => {
  if (values.length === 0) return 255
  values.sort((a, b) => a - b)
  return values[values.length >> 1]!
}

/** most common surroundings of a box: per-channel median of a ring just outside it */
export function sampleBackground(b: PageBitmap, box: Rect): Rgb {
  const h = box.y1 - box.y0
  const pad = Math.max(2 / b.scale, h * 0.2)
  const [ox0, oy0, ox1, oy1] = pixelRect(b, {
    x0: box.x0 - pad,
    y0: box.y0 - pad,
    x1: box.x1 + pad,
    y1: box.y1 + pad,
  })
  const [ix0, iy0, ix1, iy1] = pixelRect(b, box)
  const ch: [number[], number[], number[]] = [[], [], []]
  // a sparse grid keeps big boxes cheap
  const step = Math.max(1, Math.floor(Math.max(ox1 - ox0, oy1 - oy0) / 200))
  for (let y = oy0; y < oy1; y += 1) {
    const inRow = y >= iy0 && y < iy1
    for (let x = ox0; x < ox1; x += inRow ? 1 : step) {
      if (inRow && x >= ix0 && x < ix1) {
        x = ix1 - 1
        continue
      }
      const i = (y * b.width + x) * 4
      ch[0].push(b.rgba[i]!)
      ch[1].push(b.rgba[i + 1]!)
      ch[2].push(b.rgba[i + 2]!)
    }
  }
  return [median(ch[0]), median(ch[1]), median(ch[2])]
}

/** ink color inside a box: median of its darkest tenth of pixels */
export function sampleInk(b: PageBitmap, box: Rect): Rgb {
  const [x0, y0, x1, y1] = pixelRect(b, box)
  const px: [number, number, number, number][] = []
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * b.width + x) * 4
      const r = b.rgba[i]!
      const g = b.rgba[i + 1]!
      const bl = b.rgba[i + 2]!
      px.push([r * 0.299 + g * 0.587 + bl * 0.114, r, g, bl])
    }
  }
  if (px.length === 0) return [0, 0, 0]
  px.sort((a, c) => a[0] - c[0])
  const dark = px.slice(0, Math.max(1, Math.floor(px.length / 10)))
  const pick = dark[dark.length >> 1]!
  return [pick[1], pick[2], pick[3]]
}

const luminance = (c: Rgb): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]

/** least luminance gap between drawn text and the paint below it */
const MIN_INK_CONTRAST = 80

/** the sampled ink, or black / white when it would not stand out from the background */
export function readableInk(ink: Rgb, background: Rgb): Rgb {
  if (Math.abs(luminance(ink) - luminance(background)) >= MIN_INK_CONTRAST) return ink
  return luminance(background) > 128 ? [0, 0, 0] : [255, 255, 255]
}
