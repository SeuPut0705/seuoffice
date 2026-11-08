// @vitest-environment node
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { findBlankPages, isNearlyWhite, shrinkBitmap } from '../src/main/blank-pages'
import { loadPdfium, withDocument } from '../src/main/text-edit'

/** a BGRA bitmap filled by `shade(x, y)` (a grey level) */
function bitmap(width: number, height: number, shade: (x: number, y: number) => number) {
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = shade(x, y)
      out.set([v, v, v, 255], (y * width + x) * 4)
    }
  }
  return out
}

/** a greyscale PNG drawn by `shade(x, y)`, like a scanned page */
function png(width: number, height: number, shade: (x: number, y: number) => number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed))
    return Buffer.concat([len, typed, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 0
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width + 1)
    for (let x = 0; x < width; x++) row[x + 1] = shade(x, y)
    rows.push(row)
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.concat(rows))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

/** scattered 2×2 specks on an off-white scan, plus a dark scanner edge */
const speckled = (x: number, y: number) =>
  x < 8 ? 40 : (x * 7 + y * 13) % 997 === 0 || (x % 151 === 3 && y % 173 === 5) ? 30 : 235

describe('isNearlyWhite', () => {
  it('takes white, an off-white scan, and specks for blank', () => {
    expect(
      isNearlyWhite(
        bitmap(300, 400, () => 255),
        300,
        400,
      ),
    ).toBe(true)
    expect(
      isNearlyWhite(
        bitmap(300, 400, () => 228),
        300,
        400,
      ),
    ).toBe(true)
    expect(isNearlyWhite(bitmap(300, 400, speckled), 300, 400)).toBe(true)
  })

  it('ignores a dark scanner edge inside the margins it leaves out', () => {
    expect(
      isNearlyWhite(
        bitmap(300, 400, (x) => (x < 10 ? 0 : 255)),
        300,
        400,
      ),
    ).toBe(true)
  })

  it('does not take a small glyph-like mark or a grey page for blank', () => {
    const mark = (x: number, y: number) => (x >= 150 && x < 158 && y >= 200 && y < 210 ? 0 : 255)
    expect(isNearlyWhite(bitmap(300, 400, mark), 300, 400)).toBe(false)
    expect(
      isNearlyWhite(
        bitmap(300, 400, () => 120),
        300,
        400,
      ),
    ).toBe(false)
  })

  it('reads rows with padding', () => {
    const width = 30
    const stride = 128
    const padded = new Uint8Array(stride * 40).fill(255)
    expect(isNearlyWhite(padded, width, 40, stride)).toBe(true)
  })
})

describe('shrinkBitmap', () => {
  it('keeps the shape and averages the pixels', () => {
    const half = bitmap(200, 100, (x) => (x < 100 ? 0 : 255))
    const thumb = shrinkBitmap(half, 200, 100, 800, 20)
    expect([thumb.width, thumb.height]).toEqual([20, 10])
    expect(thumb.bgra[0]).toBe(0)
    // the last pixel of the last row: the white half
    expect(thumb.bgra[(9 * 20 + 19) * 4]).toBe(255)
  })
})

describe('findBlankPages', () => {
  async function sample(): Promise<Uint8Array> {
    const doc = await PDFDocument.create()
    const font = await doc.embedFont(StandardFonts.Helvetica)
    // 1: text
    doc.addPage([300, 400]).drawText('Hello', { x: 40, y: 300, size: 18, font })
    // 2: nothing at all
    doc.addPage([300, 400])
    // 3: only a tiny page number in the text layer
    doc.addPage([300, 400]).drawText('7', { x: 148, y: 20, size: 4, font })
    // 4: a scanned blank page with specks
    const scan = await doc.embedPng(png(600, 800, speckled))
    doc.addPage([300, 400]).drawImage(scan, { x: 0, y: 0, width: 300, height: 400 })
    // 5: a scanned page with a short line of text
    const text = await doc.embedPng(
      png(600, 800, (x, y) => (x >= 250 && x < 350 && y >= 400 && y < 412 ? 20 : 240)),
    )
    doc.addPage([300, 400]).drawImage(text, { x: 0, y: 0, width: 300, height: 400 })
    // 6: a white rectangle and nothing else
    doc
      .addPage([300, 400])
      .drawRectangle({ x: 0, y: 0, width: 300, height: 400, color: rgb(1, 1, 1) })
    return doc.save({ useObjectStreams: false })
  }

  it('names the empty and the nearly white pages, and only those', async () => {
    const m = await loadPdfium()
    const progress: number[] = []
    const result = await withDocument(m, await sample(), async (doc) =>
      findBlankPages(m, doc, (done) => progress.push(done)),
    )
    expect(result.pageCount).toBe(6)
    expect(result.candidates.map((c) => [c.page, c.reason])).toEqual([
      [2, 'empty'],
      [4, 'nearly-white'],
      [6, 'nearly-white'],
    ])
    expect(progress).toEqual([1, 2, 3, 4, 5, 6])
    for (const { thumb } of result.candidates) {
      expect(thumb).not.toBeNull()
      expect(Math.max(thumb!.width, thumb!.height)).toBe(240)
      expect(thumb!.bgra.length).toBe(thumb!.width * thumb!.height * 4)
    }
  })
})
