// @vitest-environment node
import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from 'pdf-lib'
import {
  LEVEL_TARGETS,
  compressPdfBytes,
  type ImageRecoder,
  type SourceImage,
} from '../src/main/compress'

/**
 * A JPEG pdf-lib embeds (it reads only the header). `padding` adds a comment
 * segment so the picture is large; `orientation` adds an EXIF orientation.
 */
function jpeg(width: number, height: number, padding = 0, orientation?: number): Uint8Array {
  const parts: number[] = [0xff, 0xd8]
  if (orientation !== undefined) {
    const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation]
    tiff.push(0, 0, 0, 0, 0, 0)
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
    parts.push(0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body)
  }
  for (let left = padding; left > 0; left -= 65000) {
    const n = Math.min(65000, left)
    parts.push(0xff, 0xfe, (n + 2) >> 8, (n + 2) & 0xff, ...new Array<number>(n).fill(0x20))
  }
  parts.push(0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3)
  parts.push(1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9)
  return Uint8Array.from(parts)
}

/** a noisy RGBA PNG: big after Flate, and with transparency (pdf-lib adds a soft mask) */
function noisyPng(width: number, height: number): Uint8Array {
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
  ihdr[9] = 6
  let seed = 7
  const rows: Buffer[] = []
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(width * 4 + 1)
    for (let i = 1; i < row.length; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff
      row[i] = i % 4 === 0 ? 200 : (seed >> 16) & 0xff
    }
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

/** a recoder that halves each picture and answers with a tiny JPEG, logging what it got */
function halving(log: { source: SourceImage; target: { longSide: number; quality: number } }[]) {
  const recode: ImageRecoder = async (source, target) => {
    log.push({ source, target })
    const width = Math.max(1, Math.round(source.width / 2))
    const height = Math.max(1, Math.round(source.height / 2))
    return { jpeg: jpeg(width, height), width, height }
  }
  return recode
}

async function sample(): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([600, 800])
  const big = await doc.embedJpg(jpeg(1200, 900, 80_000))
  page.drawImage(big, { x: 0, y: 400, width: 300, height: 225 })
  const small = await doc.embedJpg(jpeg(100, 80, 2_000))
  page.drawImage(small, { x: 0, y: 0, width: 50, height: 40 })
  const turned = await doc.embedJpg(jpeg(900, 1200, 80_000, 6))
  page.drawImage(turned, { x: 300, y: 0, width: 100, height: 100 })
  const png = await doc.embedPng(noisyPng(220, 220))
  page.drawImage(png, { x: 300, y: 400, width: 200, height: 200 })
  return doc.save({ useObjectStreams: false })
}

/** every picture in the file: its size, filter, and whether it has a soft mask */
async function pictures(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes)
  const out: { w: number; h: number; filter: string; smask: boolean; cs: string }[] = []
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue
    const d = object.dict
    if (d.lookup(PDFName.of('Subtype'))?.toString() !== '/Image') continue
    out.push({
      w: (d.lookup(PDFName.of('Width')) as PDFNumber).asNumber(),
      h: (d.lookup(PDFName.of('Height')) as PDFNumber).asNumber(),
      filter: String(d.lookup(PDFName.of('Filter'))),
      smask: d.get(PDFName.of('SMask')) instanceof PDFRef,
      cs: String(d.lookup(PDFName.of('ColorSpace'))),
    })
  }
  return out.sort((a, b) => b.w * b.h - a.w * a.h)
}

describe('compressPdfBytes', () => {
  it('shrinks the large pictures and leaves small, turned and mask pictures alone', async () => {
    const log: Parameters<typeof halving>[0] = []
    const input = await sample()
    const before = Buffer.from(input)
    const { bytes, recoded } = await compressPdfBytes(input, 'medium', halving(log))
    expect(Buffer.from(input).equals(before)).toBe(true)
    expect(recoded).toBe(2)
    // asked for the large JPEG and the PNG's colour, at the level's targets
    expect(log.map((l) => [l.source.kind, l.source.width])).toEqual([
      ['jpeg', 1200],
      ['raw', 220],
    ])
    expect(log[0]!.target).toEqual(LEVEL_TARGETS.medium)
    expect(log[1]!.source).toMatchObject({ kind: 'raw', components: 3 })
    expect(await pictures(bytes)).toEqual([
      // the EXIF-turned JPEG stays as it was
      { w: 900, h: 1200, filter: '/DCTDecode', smask: false, cs: '/DeviceRGB' },
      { w: 600, h: 450, filter: '/DCTDecode', smask: false, cs: '/DeviceRGB' },
      // the PNG's soft mask is kept, at its own size, still grey
      { w: 220, h: 220, filter: '/FlateDecode', smask: false, cs: '/DeviceGray' },
      { w: 110, h: 110, filter: '/DCTDecode', smask: true, cs: '/DeviceRGB' },
      { w: 100, h: 80, filter: '/DCTDecode', smask: false, cs: '/DeviceRGB' },
    ])
    expect(bytes.length).toBeLessThan(input.length)
  })

  it('keeps a picture the recoder could not make smaller', async () => {
    const bigger: ImageRecoder = async (source) => ({
      jpeg: jpeg(source.width, source.height, 300_000),
      width: source.width,
      height: source.height,
    })
    const { recoded } = await compressPdfBytes(await sample(), 'light', bigger)
    expect(recoded).toBe(0)
  })

  it('keeps a picture the recoder gave up on', async () => {
    const { recoded } = await compressPdfBytes(await sample(), 'strong', async () => null)
    expect(recoded).toBe(0)
  })

  it('counts its progress and stops when asked', async () => {
    const seen: number[] = []
    await compressPdfBytes(await sample(), 'light', halving([]), {
      onProgress: (done, total) => seen.push(done * 10 + total),
    })
    expect(seen).toEqual([12, 22])
    const stop = new AbortController()
    stop.abort()
    await expect(
      compressPdfBytes(await sample(), 'light', halving([]), { signal: stop.signal }),
    ).rejects.toThrow()
  })

  it('leaves CMYK pictures, image masks and colour-key masks alone', async () => {
    const doc = await PDFDocument.create()
    const page = doc.addPage([200, 200])
    const ctx = doc.context
    const data = new Uint8Array(100_000).fill(7)
    const kinds: Record<string, unknown>[] = [
      { ColorSpace: 'DeviceCMYK', BitsPerComponent: 8 },
      { ImageMask: true, BitsPerComponent: 1 },
      { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Mask: [0, 10, 0, 10, 0, 10] },
    ]
    for (const extra of kinds) {
      const ref = ctx.register(
        PDFRawStream.of(
          ctx.obj({
            Type: 'XObject',
            Subtype: 'Image',
            Width: 300,
            Height: 300,
            ...extra,
          }) as PDFDict,
          data,
        ),
      )
      page.node.newXObject('Im', ref)
    }
    const log: Parameters<typeof halving>[0] = []
    const { recoded } = await compressPdfBytes(await doc.save(), 'strong', halving(log))
    expect([recoded, log.length]).toEqual([0, 0])
  })
})
