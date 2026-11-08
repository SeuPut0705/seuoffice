/**
 * Text under a markup (reading-assist spec 4.3, 10.3): the characters of the
 * PDF.js text content whose boxes overlap the annotation's QuadPoints, on
 * plain and rotated pages, for quads written in any corner order (other
 * programs' annotations) — and the same through a real file read by PDF.js.
 */
import { describe, expect, it } from 'vitest'
import { PDFDocument, PDFName, PDFString, StandardFonts, degrees } from 'pdf-lib'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import { textUnderQuads, type TextRun } from '../src/renderer/annot-panel/text-under'
import { scanPageAnnots } from '../src/renderer/annot-panel/scan'

/** a horizontal run: each character 10 units wide, 12 high, baseline at y */
const run = (str: string, x: number, y: number, extra: Partial<TextRun> = {}): TextRun => ({
  str,
  transform: [12, 0, 0, 12, x, y],
  width: str.length * 10,
  height: 12,
  ...extra,
})

/** quad in the order this app writes: top-left, top-right, bottom-left, bottom-right */
const zQuad = (x1: number, y1: number, x2: number, y2: number): number[] => [
  x1,
  y2,
  x2,
  y2,
  x1,
  y1,
  x2,
  y1,
]

/** counter-clockwise from bottom-left, as some other programs write QuadPoints */
const ccwQuad = (x1: number, y1: number, x2: number, y2: number): number[] => [
  x1,
  y1,
  x2,
  y1,
  x2,
  y2,
  x1,
  y2,
]

describe('textUnderQuads', () => {
  it('takes the characters whose boxes fall inside the quad', () => {
    const runs = [run('Hello world', 100, 700)]
    // "world" starts at character 6 → x 160..210
    expect(textUnderQuads(runs, [zQuad(158, 697, 212, 714)])).toBe('world')
  })

  it('reads quads written in another corner order the same way', () => {
    const runs = [run('Hello world', 100, 700)]
    expect(textUnderQuads(runs, [ccwQuad(158, 697, 212, 714)])).toBe('world')
  })

  it('joins several quads over several lines with a space and keeps document order', () => {
    const runs = [
      run('first line ends', 100, 700, { hasEOL: true }),
      run('next line here', 100, 680),
    ]
    const quads = [zQuad(190, 697, 252, 714), zQuad(98, 677, 189, 694)]
    expect(textUnderQuads(runs, quads)).toBe('ends next line')
  })

  it('does not put a space between adjacent CJK runs', () => {
    const runs = [run('가나다', 100, 700), run('라마', 130, 700)]
    expect(textUnderQuads(runs, [zQuad(98, 697, 152, 714)])).toBe('가나다라마')
  })

  it('returns an empty string when no text lies under the markup (scanned page)', () => {
    expect(textUnderQuads([], [zQuad(0, 0, 100, 100)])).toBe('')
    expect(textUnderQuads([run('far away', 400, 100)], [zQuad(0, 600, 100, 700)])).toBe('')
  })

  it('follows text drawn upward on a page shown rotated', () => {
    // text running in +y: the run's x axis is (0, 1), its up axis is (-1, 0)
    const up: TextRun = {
      str: 'Hello world',
      transform: [0, 12, -12, 0, 300, 100],
      width: 110,
      height: 12,
    }
    // "world" covers y 160..210; the glyphs sit to the left of the baseline x=300
    expect(textUnderQuads([up], [zQuad(286, 158, 302, 212)])).toBe('world')
    expect(textUnderQuads([up], [ccwQuad(286, 158, 302, 212)])).toBe('world')
  })

  it('skips runs with no width and marked-content entries', () => {
    const runs = [run('', 100, 700), { ...run('abc', 100, 700), width: 0 }, run('abc', 100, 700)]
    expect(textUnderQuads(runs, [zQuad(98, 697, 132, 714)])).toBe('abc')
  })
})

/** a real file: a rotated page, text, and a Highlight written like another program writes it */
async function foreignPdf(o: { rotate: number; textRotate: number }): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([400, 600])
  page.setRotation(degrees(o.rotate))
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const size = 12
  const before = 'Alpha '
  const target = 'Beta'
  const x = 50
  const y = 300
  page.drawText(`${before}${target} Gamma`, {
    x,
    y,
    size,
    font,
    rotate: degrees(o.textRotate),
  })
  const start = font.widthOfTextAtSize(before, size)
  const end = start + font.widthOfTextAtSize(target, size)
  let q: number[]
  if (o.textRotate === 90) {
    // the line runs up from (x, y); glyphs extend to the left of x
    q = ccwQuad(x - size, y + start + 1, x + 2, y + end - 1)
  } else {
    q = ccwQuad(x + start + 1, y - 2, x + end - 1, y + size)
  }
  const annot = pdf.context.obj({
    Type: 'Annot',
    Subtype: 'Highlight',
    Rect: [
      Math.min(q[0]!, q[4]!),
      Math.min(q[1]!, q[5]!),
      Math.max(q[0]!, q[4]!),
      Math.max(q[1]!, q[5]!),
    ],
    QuadPoints: q,
    C: [0.2, 0.8, 0.2],
    CreationDate: PDFString.of('D:20240102030405Z'),
  })
  page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annot)]))
  return pdf.save()
}

async function withPdf<T>(bytes: Uint8Array, fn: (doc: PDFDocumentProxy) => Promise<T>) {
  const task = getDocument({ data: bytes.slice() })
  try {
    return await fn((await task.promise) as unknown as PDFDocumentProxy)
  } finally {
    await task.destroy()
  }
}

describe('scanPageAnnots on a real file', () => {
  it("reads the text under another program's highlight on a rotated page", async () => {
    const bytes = await foreignPdf({ rotate: 90, textRotate: 0 })
    const page = await withPdf(bytes, (doc) => scanPageAnnots(doc, 0))
    expect(page.markups).toHaveLength(1)
    expect(page.markups[0]).toMatchObject({ type: 'highlight', text: 'Beta' })
    expect(page.markups[0]!.color).toEqual([
      expect.closeTo(0.2, 1),
      expect.closeTo(0.8, 1),
      expect.closeTo(0.2, 1),
    ])
    expect(page.markups[0]!.createdMs).toBe(Date.UTC(2024, 0, 2, 3, 4, 5))
  })

  it('reads text drawn rotated in user space', async () => {
    const bytes = await foreignPdf({ rotate: 270, textRotate: 90 })
    const page = await withPdf(bytes, (doc) => scanPageAnnots(doc, 0))
    expect(page.markups[0]?.text).toBe('Beta')
  })
})
