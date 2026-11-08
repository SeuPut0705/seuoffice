// @vitest-environment node
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib'
import { imagesToPdfBytes, orientedImageMatrix, readImageInfo } from '../src/main/images-to-pdf'

/**
 * A JPEG pdf-lib can embed: it only reads the header, so the scan data can be
 * a stub. `orientation` adds an APP1 Exif segment (big- or little-endian TIFF).
 */
function jpeg(width: number, height: number, orientation?: number, little = false): Uint8Array {
  const parts: number[] = [0xff, 0xd8]
  if (orientation !== undefined) {
    const w16 = (v: number) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff])
    const w32 = (v: number) =>
      little
        ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]
        : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
    const tiff = [
      ...(little ? [0x49, 0x49] : [0x4d, 0x4d]),
      ...w16(42),
      ...w32(8),
      ...w16(1),
      // one IFD entry: tag 0x0112 (Orientation), SHORT, count 1, value
      ...w16(0x0112),
      ...w16(3),
      ...w32(1),
      ...w16(orientation),
      0,
      0,
      ...w32(0),
    ]
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
    const length = body.length + 2
    parts.push(0xff, 0xe1, length >> 8, length & 0xff, ...body)
  }
  // SOF0: precision 8, height, width, 3 components
  parts.push(0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3)
  parts.push(1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0)
  parts.push(0xff, 0xd9)
  return Uint8Array.from(parts)
}

/** A real RGB PNG of one colour */
function png(width: number, height: number): Uint8Array {
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
  ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  )
}

const sizes = async (bytes: Uint8Array) =>
  (await PDFDocument.load(bytes)).getPages().map((p) => [p.getWidth(), p.getHeight()])

/** apply a matrix [a b c d e f] to the image's unit-square point (u, v) */
const at = (m: number[], u: number, v: number) => [
  m[0]! * u + m[2]! * v + m[4]!,
  m[1]! * u + m[3]! * v + m[5]!,
]

describe('readImageInfo', () => {
  it('reads a JPEG size and its EXIF orientation in either byte order', () => {
    expect(readImageInfo(jpeg(40, 30))).toEqual({
      kind: 'jpg',
      width: 40,
      height: 30,
      orientation: 1,
    })
    expect(readImageInfo(jpeg(40, 30, 6))?.orientation).toBe(6)
    expect(readImageInfo(jpeg(40, 30, 8, true))?.orientation).toBe(8)
    // an out-of-range value is read as upright
    expect(readImageInfo(jpeg(40, 30, 12))?.orientation).toBe(1)
  })

  it('reads a PNG size and refuses what is neither', () => {
    expect(readImageInfo(png(7, 5))).toEqual({ kind: 'png', width: 7, height: 5, orientation: 1 })
    expect(readImageInfo(new TextEncoder().encode('GIF89a......'))).toBeNull()
    expect(readImageInfo(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull()
    expect(readImageInfo(new Uint8Array())).toBeNull()
  })
})

describe('orientedImageMatrix', () => {
  // where the stored image's top-left corner (u 0, v 1) is meant to be seen
  const box = { x: 10, y: 20, w: 100, h: 50 }
  const topLeft: Record<number, [number, number]> = {
    1: [10, 70], // top-left
    2: [110, 70], // mirrored: top-right
    3: [110, 20], // 180°: bottom-right
    4: [10, 20], // flipped: bottom-left
    5: [10, 70], // transposed: top-left
    6: [110, 70], // 90° clockwise: top-right
    7: [110, 20], // transverse: bottom-right
    8: [10, 20], // 90° counter-clockwise: bottom-left
  }
  for (const [orientation, corner] of Object.entries(topLeft)) {
    it(`orientation ${orientation} puts the stored top-left corner where it is seen`, () => {
      const m = orientedImageMatrix(Number(orientation), box.x, box.y, box.w, box.h)
      expect(at(m, 0, 1)).toEqual(corner)
      // the image fills the box exactly
      const corners = [at(m, 0, 0), at(m, 1, 0), at(m, 0, 1), at(m, 1, 1)]
      expect(corners.map((c) => c[0]).sort((a, b) => a - b)).toEqual([10, 10, 110, 110])
      expect(corners.map((c) => c[1]).sort((a, b) => a - b)).toEqual([20, 20, 70, 70])
    })
  }
})

describe('imagesToPdfBytes', () => {
  it('makes one page per image, in order, each the image size at 96 dpi', async () => {
    const out = await imagesToPdfBytes([jpeg(400, 200), png(80, 120)], {
      paper: null,
      marginPt: 0,
    })
    expect(await sizes(out)).toEqual([
      [300, 150],
      [60, 90],
    ])
  })

  it('turns a page for a photo whose EXIF says it was taken on its side', async () => {
    const out = await imagesToPdfBytes([jpeg(400, 200, 6)], { paper: null, marginPt: 0 })
    expect(await sizes(out)).toEqual([[150, 300]])
  })

  it('puts each image on the paper, landscape for a wide one, and draws it once', async () => {
    const a4 = { w: 595, h: 842 }
    const out = await imagesToPdfBytes([jpeg(400, 200), jpeg(200, 400), jpeg(400, 200, 8)], {
      paper: a4,
      marginPt: 28,
    })
    expect(await sizes(out)).toEqual([
      [842, 595],
      [595, 842],
      [595, 842],
    ])
    const doc = await PDFDocument.load(out)
    for (const page of doc.getPages()) {
      const xobjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict)
      expect(xobjects?.keys()).toHaveLength(1)
    }
  })

  it('keeps a huge image within the largest page viewers accept', async () => {
    const out = await imagesToPdfBytes([jpeg(30_000, 1_000)], { paper: null, marginPt: 0 })
    const [[w, h]] = (await sizes(out)) as [[number, number]]
    expect(w).toBeCloseTo(14_400)
    expect(h).toBeCloseTo(480)
  })

  it('refuses something that is not a JPEG or PNG', async () => {
    await expect(
      imagesToPdfBytes([new TextEncoder().encode('not an image')], { paper: null, marginPt: 0 }),
    ).rejects.toThrow()
  })
})
