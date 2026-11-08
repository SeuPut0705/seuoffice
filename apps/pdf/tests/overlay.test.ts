// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  PDFArray,
  PDFDocument,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream,
  degrees,
} from 'pdf-lib'
import { overlayMatrix, overlayPdfBytes } from '../src/main/overlay'

/** apply [a b c d e f] to a point of the form */
const at = (m: number[], x: number, y: number) => [
  m[0]! * x + m[2]! * y + m[4]!,
  m[1]! * x + m[3]! * y + m[5]!,
]

/** turn a point of the page's own space the way a viewer shows /Rotate (clockwise) */
function seen(rotation: number, box: { width: number; height: number }, [x, y]: number[]) {
  switch (rotation) {
    case 90:
      return [y!, box.width - x!]
    case 180:
      return [box.width - x!, box.height - y!]
    case 270:
      return [box.height - y!, x!]
    default:
      return [x!, y!]
  }
}

async function textPdf(lines: string[], size: [number, number] = [300, 400], rotate = 0) {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const line of lines) {
    const page = doc.addPage(size)
    page.setRotation(degrees(rotate))
    page.drawText(line, { x: 20, y: 200, size: 12, font })
  }
  return doc.save({ useObjectStreams: false })
}

/** each page's content streams, decoded, in drawing order */
async function streams(bytes: Uint8Array): Promise<string[][]> {
  const doc = await PDFDocument.load(bytes)
  return doc.getPages().map((page) => {
    const contents = page.node.Contents()
    const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : []
    return refs.map((ref) => {
      const stream = doc.context.lookup(ref as PDFRef) as PDFRawStream
      return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode())
    })
  })
}

describe('overlayMatrix', () => {
  const box = { x: 0, y: 0, width: 200, height: 100 }
  for (const rotation of [0, 90, 180, 270]) {
    it(`stands the form upright, fitted and centred, on a page turned ${rotation}°`, () => {
      const m = overlayMatrix(rotation, box, 50, 50)
      const quarter = rotation % 180 !== 0
      const seenBox = quarter ? { width: 100, height: 200 } : { width: 200, height: 100 }
      const corner = (x: number, y: number) =>
        seen(rotation, box, at(m, x, y)).map((v) => Math.round(v * 1000) / 1000)
      const fit = Math.min(seenBox.width, seenBox.height)
      const left = (seenBox.width - fit) / 2
      const bottom = (seenBox.height - fit) / 2
      // the form's bottom-left and top-right corners land where they would upright
      expect(corner(0, 0)).toEqual([left, bottom])
      expect(corner(50, 50)).toEqual([left + fit, bottom + fit])
    })
  }

  it('fits inside a crop box that does not start at the origin', () => {
    const m = overlayMatrix(0, { x: 10, y: 20, width: 100, height: 100 }, 200, 100)
    expect(at(m, 0, 0)).toEqual([10, 45])
    expect(at(m, 200, 100)).toEqual([110, 95])
  })
})

describe('overlayPdfBytes', () => {
  it('draws the background ahead of the page content when behind', async () => {
    const out = await overlayPdfBytes(await textPdf(['one', 'two']), await textPdf(['bg']), {
      behind: true,
      backgroundPage: 0,
      pages: null,
    })
    for (const page of await streams(out)) {
      expect(page[0]).toMatch(/\/Background-?\w* Do/)
      expect(page.slice(1).join('\n')).not.toMatch(/\/Background/)
      expect(page.join('\n')).toMatch(/Tj/)
    }
  })

  it('draws it after the page content when in front, on the chosen pages only', async () => {
    const out = await overlayPdfBytes(
      await textPdf(['one', 'two', 'three']),
      await textPdf(['a', 'b']),
      { behind: false, backgroundPage: 1, pages: [0, 2] },
    )
    const pages = await streams(out)
    expect(pages[0]!.at(-1)).toMatch(/\/Background-?\w* Do/)
    expect(pages[1]!.join('\n')).not.toMatch(/\/Background/)
    expect(pages[2]!.at(-1)).toMatch(/\/Background-?\w* Do/)
  })

  it('keeps page count, sizes and rotation, and leaves the inputs untouched', async () => {
    const doc = await textPdf(['one'], [612, 792], 90)
    const bg = await textPdf(['bg'])
    const before = [Buffer.from(doc), Buffer.from(bg)]
    const out = await PDFDocument.load(
      await overlayPdfBytes(doc, bg, { behind: true, backgroundPage: 0, pages: null }),
    )
    expect(out.getPageCount()).toBe(1)
    expect([out.getPage(0).getWidth(), out.getPage(0).getRotation().angle]).toEqual([612, 90])
    expect(Buffer.from(doc).equals(before[0]!)).toBe(true)
    expect(Buffer.from(bg).equals(before[1]!)).toBe(true)
  })

  it('copies the document unchanged when the background page has no content', async () => {
    const empty = await PDFDocument.create()
    empty.addPage([100, 100])
    const out = await overlayPdfBytes(
      await textPdf(['one']),
      await empty.save({ useObjectStreams: false }),
      { behind: true, backgroundPage: 0, pages: null },
    )
    expect((await streams(out))[0]!.join('\n')).not.toMatch(/\/Background/)
  })

  it('refuses a background page that does not exist', async () => {
    await expect(
      overlayPdfBytes(await textPdf(['one']), await textPdf(['bg']), {
        behind: true,
        backgroundPage: 3,
        pages: null,
      }),
    ).rejects.toThrow()
  })
})
