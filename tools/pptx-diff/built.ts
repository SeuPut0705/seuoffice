import './stable-zip'
import JSZip from 'jszip'
import { createRequire } from 'node:module'
import { crc32, deflateRawSync } from 'node:zlib'
import type PptxGenJS from 'pptxgenjs'
import { createBlankPptx } from './reference/blank'
import { buildZip, hostileContainers } from '../docx-diff/package-zips'

const PptxGenerator = createRequire(import.meta.url)('pptxgenjs') as typeof PptxGenJS

export async function builtDecks(): Promise<Array<[string, Uint8Array]>> {
  const blank = await createBlankPptx()
  const deck = new PptxGenerator()
  deck.author = 'SeuOffice parity gate'
  deck.title = 'Built parity inputs'
  deck.layout = 'LAYOUT_WIDE'
  const slide = deck.addSlide()
  slide.addText(' 2026 & <text> \uD55C\uAE00 \u{1F600} ', { x: 1, y: 1, w: 6, h: 1 })
  slide.addShape(deck.ShapeType.rect, { x: 1, y: 3, w: 2, h: 1, fill: { color: '336699' } })
  slide.addTable(
    [
      [{ text: 'A' }, { text: 'B' }],
      [{ text: '1' }, { text: '2' }],
    ],
    { x: 4, y: 3, w: 3, h: 1 },
  )
  deck.addSlide().addText('Second slide', { x: 1, y: 1, w: 4, h: 1 })
  // pptxgenjs stamps docProps/core.xml with the clock: one fixed time, so the
  // deck is the same bytes on every run (see stable-zip.ts)
  const written = await JSZip.loadAsync((await deck.write({ outputType: 'uint8array' })) as Uint8Array)
  const core = await written.file('docProps/core.xml')?.async('string')
  if (core !== undefined) {
    written.file(
      'docProps/core.xml',
      core.replace(/(<dcterms:(?:created|modified)\b[^>]*>)[^<]*/g, '$11980-01-01T00:00:00Z'),
    )
  }
  for (const entry of Object.values(written.files)) entry.date = new Date(Date.UTC(1980, 0, 1))
  const generated = await written.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
  const brokenChain = await JSZip.loadAsync(blank)
  brokenChain.remove('ppt/slides/_rels/slide1.xml.rels')
  const titleFallback = await JSZip.loadAsync(blank)
  titleFallback.remove('ppt/slides/_rels/slide1.xml.rels')
  titleFallback.file(
    'ppt/slides/slide1.xml',
    '<p:sld><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr></p:sp></p:spTree></p:cSld></p:sld>',
  )
  titleFallback.file(
    'ppt/slideLayouts/slideLayout1.xml',
    '<p:sldLayout type="title"><p:cSld><p:spTree/></p:cSld></p:sldLayout>',
  )
  return [
    ['blank deck', blank],
    ['pptxgenjs text, shape, table and two slides', generated],
    [
      'missing slide relationship fallback',
      await brokenChain.generateAsync({ type: 'uint8array' }),
    ],
    ['title placeholder fallback', await titleFallback.generateAsync({ type: 'uint8array' })],
  ]
}

export function builtContainers(): Array<[string, Uint8Array]> {
  const parts = [
    {
      name: 'ppt/presentation.xml',
      data: '<p:presentation><p:sldSz cx="12.9pt" cy="0"/></p:presentation>',
    },
    { name: 'text.xml', data: new Uint8Array([0xef, 0xbb, 0xbf, 0xe2, 0x82, 0x61, 0x80]) },
  ]
  const stored = buildZip(parts)
  const staleCrc = stored.slice()
  const firstNameLength = Buffer.byteLength(parts[0]!.name)
  staleCrc[30 + firstNameLength + 1] = 80
  // JSZip takes an Info-ZIP Unicode Path whose checksum matches the header name; the Word
  // loader blanks these fields before JSZip sees them, PackageArchive.open does not
  const headerName = Buffer.from('ppt/a.xml')
  const unicodePath = Buffer.from('ppt/\uD55C\uAE00.xml')
  const unicodeField = Buffer.alloc(9 + unicodePath.length)
  unicodeField.writeUInt16LE(0x7075, 0)
  unicodeField.writeUInt16LE(5 + unicodePath.length, 2)
  unicodeField.writeUInt8(1, 4)
  unicodeField.writeUInt32LE(crc32(headerName), 5)
  unicodePath.copy(unicodeField, 9)
  const staleUnicodeField = Buffer.from(unicodeField)
  staleUnicodeField.writeUInt32LE(0, 5)
  return [
    ['empty zip', buildZip([])],
    ['stored UTF8/BOM/invalid sequences', stored],
    ['deflated parts', buildZip(parts.map((part) => ({ ...part, method: 8 })))],
    ['stale checksum accepted', staleCrc],
    ['truncated file', stored.subarray(0, stored.length - 15)],
    ['not zip', new TextEncoder().encode('not a zip')],
    [
      'duplicate names, last bytes win in first position',
      buildZip([
        { name: 'same.xml', data: 'first' },
        { name: 'other.xml', data: 'middle' },
        { name: 'same.xml', data: 'last' },
      ]),
    ],
    [
      'unsafe paths normalized by JSZip',
      buildZip([
        { name: '../ppt/x.xml', data: '<x/>' },
        { name: 'ppt/../x.xml', data: '<y/>' },
        { name: 'ppt/folder/', data: '' },
      ]),
    ],
    [
      'per-part declared limit',
      buildZip([{ name: 'oversize.xml', data: '', declaredSize: 512 * 1024 * 1024 + 1 }]),
    ],
    [
      'part count limit',
      buildZip(Array.from({ length: 10_001 }, (_, index) => ({ name: `${index}.xml`, data: '' }))),
    ],
    [
      'invalid deflate',
      buildZip([{ name: 'bad.xml', data: '<x/>', method: 8, payload: new Uint8Array([7]) }]),
    ],
    [
      'lie about inflated size',
      buildZip([
        { name: 'small.xml', data: 'content bigger than one', method: 8, declaredSize: 1 },
      ]),
    ],
    [
      'bytes after the deflate stream',
      buildZip([
        {
          name: 'a.xml',
          data: '<a/>',
          method: 8,
          payload: Buffer.concat([deflateRawSync('<a/>'), Buffer.from('trailing')]),
        },
      ]),
    ],
    [
      'Unicode Path field that renames an entry',
      buildZip([
        { name: headerName, data: '<a/>', extra: unicodeField },
        { name: 'ppt/b.xml', data: '<b/>' },
      ]),
    ],
    [
      'Unicode Path field with a stale checksum',
      buildZip([{ name: headerName, data: '<a/>', extra: staleUnicodeField }]),
    ],
    ['unknown compression', buildZip([{ name: 'bad.xml', data: 'x', method: 99 }])],
    ['encrypted entry', buildZip([{ name: 'bad.xml', data: 'x', flags: 0x0801 }])],
    ...Object.entries(hostileContainers()),
  ]
}
