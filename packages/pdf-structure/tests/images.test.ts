import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeAll, describe, expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
// extract/* only: the pdf2docx index pulls in modules whose ambient
// declarations live outside this package's tsconfig
import { PdfLoadError, type PdfiumModule } from '../../pdf2docx/src/extract/pdfium'
import { encodeRgbaPng } from '../../pdf2docx/src/extract/png'
import { decodePngRgba } from '../../pdf2docx/tests/helpers/png-decode'
import { extractEmbeddedImages, MIN_IMAGE_PX } from '../src/images'

/** same bootstrap as pdf2docx/tests/helpers/wasm.ts, without its index import */
async function loadPdfium(): Promise<PdfiumModule> {
  const require = createRequire(import.meta.url)
  const raw = readFileSync(require.resolve('@embedpdf/pdfium/pdfium.wasm'))
  const wasmBinary = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  const { init } = (await import('@embedpdf/pdfium')) as unknown as {
    init(overrides: object): Promise<object>
  }
  // thisProgram: emscripten writes argv[1] (the vitest path) through an
  // ASCII-only path; a checkout under a non-ASCII folder would abort init
  // (same fix as apps/pdf/src/main/text-edit.ts loadPdfium)
  const wrapped = (await init({ wasmBinary, thisProgram: 'genoffice-pdf' })) as {
    pdfium?: unknown
  }
  const mod = (wrapped.pdfium ?? wrapped) as PdfiumModule & { _PDFiumExt_Init(): void }
  mod._PDFiumExt_Init()
  return mod
}

/** opaque gradient with a per-image seed so distinct images differ in content */
function gradient(width: number, height: number, seed: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      rgba[i] = (x * 5 + seed) & 0xff
      rgba[i + 1] = (y * 3 + seed * 7) & 0xff
      rgba[i + 2] = (x * y + seed * 13) & 0xff
      rgba[i + 3] = 255
    }
  }
  return rgba
}

const A = { w: 100, h: 60, rgba: gradient(100, 60, 1) }
const B = { w: 40, h: 80, rgba: gradient(40, 80, 2) }
const C = { w: 64, h: 48, rgba: gradient(64, 48, 3) }
const TINY = { w: 16, h: 16, rgba: gradient(16, 16, 4) }

const png = (img: { w: number; h: number; rgba: Uint8Array }): Uint8Array =>
  encodeRgbaPng(img.rgba, img.w, img.h)

/**
 * Page 1: A drawn smaller than natural, the tiny image, B drawn larger.
 * Page 2: A again as a separate XObject (same pixels), then C.
 * Page 3: no images.
 */
async function buildFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const p1 = pdf.addPage([600, 800])
  p1.drawImage(await pdf.embedPng(png(A)), { x: 20, y: 700, width: 50, height: 30 })
  p1.drawImage(await pdf.embedPng(png(TINY)), { x: 100, y: 700, width: 16, height: 16 })
  p1.drawImage(await pdf.embedPng(png(B)), { x: 200, y: 200, width: 200, height: 400 })
  const p2 = pdf.addPage([600, 800])
  p2.drawImage(await pdf.embedPng(png(A)), { x: 50, y: 50, width: 300, height: 180 })
  p2.drawImage(await pdf.embedPng(png(C)), { x: 400, y: 400, width: 64, height: 48 })
  pdf.addPage([600, 800])
  return pdf.save()
}

let m: PdfiumModule
let fixture: Uint8Array

beforeAll(async () => {
  m = await loadPdfium()
  fixture = await buildFixture()
})

describe('extractEmbeddedImages', () => {
  it('returns each distinct image at natural size, skipping tiny ones and duplicates', () => {
    const images = extractEmbeddedImages(m, fixture, [1, 2, 3])
    expect(images.map(({ page, width, height }) => ({ page, width, height }))).toEqual([
      { page: 1, width: A.w, height: A.h },
      { page: 1, width: B.w, height: B.h },
      { page: 2, width: C.w, height: C.h },
    ])
    for (const [img, src] of [
      [images[0]!, A],
      [images[1]!, B],
      [images[2]!, C],
    ] as const) {
      const decoded = decodePngRgba(img.png)
      expect(decoded.width).toBe(src.w)
      expect(decoded.height).toBe(src.h)
      expect(Array.from(decoded.rgba)).toEqual(Array.from(src.rgba))
    }
  })

  it('reads only the chosen pages', () => {
    const images = extractEmbeddedImages(m, fixture, [2])
    expect(images.map(({ page, width, height }) => ({ page, width, height }))).toEqual([
      { page: 2, width: A.w, height: A.h },
      { page: 2, width: C.w, height: C.h },
    ])
    expect(extractEmbeddedImages(m, fixture, [3])).toEqual([])
  })

  it('keeps the size threshold tunable', () => {
    expect(MIN_IMAGE_PX).toBe(32)
    const images = extractEmbeddedImages(m, fixture, [1], { minImagePx: 8 })
    expect(images.map(({ width, height }) => [width, height])).toEqual([
      [A.w, A.h],
      [TINY.w, TINY.h],
      [B.w, B.h],
    ])
  })

  it('throws PdfLoadError when the document cannot be opened', () => {
    const garbage = new TextEncoder().encode('not a pdf at all')
    expect(() => extractEmbeddedImages(m, garbage, [1])).toThrow(PdfLoadError)
  })

  it('rejects page numbers outside the document', () => {
    expect(() => extractEmbeddedImages(m, fixture, [4])).toThrow(RangeError)
    expect(() => extractEmbeddedImages(m, fixture, [0])).toThrow(RangeError)
  })
})
