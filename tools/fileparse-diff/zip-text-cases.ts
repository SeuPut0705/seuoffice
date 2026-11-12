import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeflateRaw, deflateRawSync } from 'node:zlib'
import JSZip from 'jszip'
import { assertZipInflatesWithinLimits } from '../../packages/zip-gate/src/index'
import { isTextPart, readZipTextParts } from './reference/zip-text-parts'
import type { Input, Spec } from './spec'

const DATE = new Date(Date.UTC(2024, 0, 2, 3, 4, 6))
const EMPTY = new Uint8Array()
type Bytes = Uint8Array | string
const bytesOf = (value: Bytes | undefined) =>
  value === undefined ? EMPTY : typeof value === 'string' ? new TextEncoder().encode(value) : value

/** Deterministic filler standing in for pictures, fonts and embedded objects. */
function bin(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  let state = seed >>> 0
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out[i] = state >>> 24
  }
  return out
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...bin(600, 7)])

interface JsZipOptions { compression?: 'STORE' | 'DEFLATE'; streamFiles?: boolean; comment?: string; platform?: 'DOS' | 'UNIX' }
/** A JSZip archive with fixed dates; `null` is a folder entry. */
async function jszip(parts: Record<string, Bytes | null>, options: JsZipOptions = {}): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, data] of Object.entries(parts)) {
    if (data === null) zip.file(name, null, { dir: true, date: DATE, createFolders: false })
    else zip.file(name, data, { date: DATE, createFolders: false, unixPermissions: 0o644 })
  }
  return zip.generateAsync({ type: 'uint8array', compression: options.compression ?? 'DEFLATE',
    streamFiles: options.streamFiles, comment: options.comment, platform: options.platform })
}

interface RawEntry {
  name: Bytes
  /** the bytes stored for the entry, already compressed when `method` is 8 */
  data?: Bytes
  method?: number
  flags?: number
  time?: number
  date?: number
  crc?: number
  compSize?: number
  size?: number
  version?: number
  madeBy?: number
  internal?: number
  external?: number
  localName?: Bytes
  localExtra?: Uint8Array
  extra?: Uint8Array
  comment?: Bytes
  localSig?: number
  centralSig?: number
  /** the local header offset the central record gives, when not its own */
  at?: number
  /** bytes after the data, such as a data descriptor */
  after?: Uint8Array
  /** false: only a central record is written */
  local?: boolean
}
interface RawLayout {
  prefix?: Uint8Array
  /** offsets as if the prefix were not there */
  unshifted?: boolean
  gap?: Uint8Array
  disk?: number
  cdDisk?: number
  diskEntries?: number
  count?: number
  cdSize?: number
  cdOffset?: number
  zip64Locator?: boolean
  comment?: Bytes
  trailing?: Uint8Array
}
/** A zip written field by field, for layouts JSZip never writes. */
function raw(entries: RawEntry[], layout: RawLayout = {}): Uint8Array {
  const out: Uint8Array[] = []
  let pos = 0
  const push = (...parts: Uint8Array[]) => { for (const part of parts) { out.push(part); pos += part.length } }
  const prefix = layout.prefix ?? EMPTY
  push(prefix)
  const base = layout.unshifted ? prefix.length : 0
  const offsets: number[] = []
  for (const entry of entries) {
    offsets.push(pos - base)
    if (entry.local === false) continue
    const name = bytesOf(entry.localName ?? entry.name)
    const extra = entry.localExtra ?? EMPTY
    const data = bytesOf(entry.data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(entry.localSig ?? 0x04034b50, 0)
    head.writeUInt16LE(entry.version ?? 20, 4)
    head.writeUInt16LE(entry.flags ?? 0, 6)
    head.writeUInt16LE(entry.method ?? 0, 8)
    head.writeUInt16LE(entry.time ?? 0x1823, 10)
    head.writeUInt16LE(entry.date ?? 0x5822, 12)
    head.writeUInt32LE(entry.crc ?? 0x1234abcd, 14)
    head.writeUInt32LE(entry.compSize ?? data.length, 18)
    head.writeUInt32LE(entry.size ?? data.length, 22)
    head.writeUInt16LE(name.length, 26)
    head.writeUInt16LE(extra.length, 28)
    push(head, name, extra, data, entry.after ?? EMPTY)
  }
  push(layout.gap ?? EMPTY)
  const cdStart = pos - base
  entries.forEach((entry, n) => {
    const name = bytesOf(entry.name)
    const extra = entry.extra ?? EMPTY
    const comment = bytesOf(entry.comment)
    const data = bytesOf(entry.data)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(entry.centralSig ?? 0x02014b50, 0)
    head.writeUInt16LE(entry.madeBy ?? 20, 4)
    head.writeUInt16LE(entry.version ?? 20, 6)
    head.writeUInt16LE(entry.flags ?? 0, 8)
    head.writeUInt16LE(entry.method ?? 0, 10)
    head.writeUInt16LE(entry.time ?? 0x1823, 12)
    head.writeUInt16LE(entry.date ?? 0x5822, 14)
    head.writeUInt32LE(entry.crc ?? 0x1234abcd, 16)
    head.writeUInt32LE(entry.compSize ?? data.length, 20)
    head.writeUInt32LE(entry.size ?? data.length, 24)
    head.writeUInt16LE(name.length, 28)
    head.writeUInt16LE(extra.length, 30)
    head.writeUInt16LE(comment.length, 32)
    head.writeUInt16LE(entry.internal ?? 0, 36)
    head.writeUInt32LE(entry.external ?? 0, 38)
    head.writeUInt32LE(entry.at ?? offsets[n]!, 42)
    push(head, name, extra, comment)
  })
  const cdSize = pos - base - cdStart
  if (layout.zip64Locator) {
    const locator = Buffer.alloc(20)
    locator.writeUInt32LE(0x07064b50, 0)
    locator.writeUInt32LE(1, 16)
    push(locator)
  }
  const comment = bytesOf(layout.comment)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(layout.disk ?? 0, 4)
  end.writeUInt16LE(layout.cdDisk ?? 0, 6)
  end.writeUInt16LE(layout.diskEntries ?? entries.length, 8)
  end.writeUInt16LE(layout.count ?? entries.length, 10)
  end.writeUInt32LE(layout.cdSize ?? cdSize, 12)
  end.writeUInt32LE(layout.cdOffset ?? cdStart, 16)
  end.writeUInt16LE(comment.length, 20)
  push(end, comment, layout.trailing ?? EMPTY)
  return new Uint8Array(Buffer.concat(out))
}
const deflated = (text: Bytes) => ({ method: 8, data: new Uint8Array(deflateRawSync(bytesOf(text))), size: bytesOf(text).length })
/** The raw deflate of `size` zero bytes, fed in 64 KiB slices so the zeros are never held whole. */
async function deflatedZeros(size: number) {
  const deflater = createDeflateRaw()
  const chunks: Buffer[] = []
  deflater.on('data', (chunk: Buffer) => chunks.push(chunk))
  const ended = once(deflater, 'end')
  const slice = Buffer.alloc(64 * 1024)
  for (let left = size; left > 0; left -= slice.length) {
    if (!deflater.write(left < slice.length ? slice.subarray(0, left) : slice)) await once(deflater, 'drain')
  }
  deflater.end()
  await ended
  return { method: 8, data: new Uint8Array(Buffer.concat(chunks)), size }
}
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`
const CONTENT_TYPES = xml('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>')
const RELS = xml('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="t" Target="word/document.xml"/></Relationships>')

async function readZipTextPartsOf(bytes: Uint8Array): Promise<number[]> {
  const dir = mkdtempSync(join(tmpdir(), 'zip-text-parts-'))
  try {
    const path = join(dir, 'input.zip')
    writeFileSync(path, bytes)
    return Array.from(await readZipTextParts(path))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function builtArchives(): Promise<Input[]> {
  const inputs: Input[] = []
  const add = (label: string, bytes: Uint8Array) => inputs.push({ label, bytes })
  // the zip gate runs first in Rust: it refuses what the TypeScript copies, or refuses in its own words
  const divergent = (label: string, bytes: Uint8Array) => add(`gate first: ${label}`, bytes)

  const docx = {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': RELS,
    'docProps/thumbnail.jpeg': bin(900, 1),
    'word/': null,
    'word/document.xml': xml(`<w:document><w:body>${'<w:p><w:r><w:t>words</w:t></w:r></w:p>'.repeat(300)}</w:body></w:document>`),
    'word/_rels/document.xml.rels': RELS,
    'word/media/image1.png': PNG,
    'word/media/image2.EMF': bin(300, 2),
    'word/fonts/font1.odttf': bin(500, 3),
    'word/embeddings/oleObject1.bin': bin(400, 4),
    'customXml/item1.xml': xml('<b:Sources/>'),
  }
  add('docx deflated', await jszip(docx))
  add('docx stored', await jszip(docx, { compression: 'STORE' }))
  add('docx data descriptors', await jszip(docx, { streamFiles: true }))
  add('docx unix with archive comment', await jszip(docx, { platform: 'UNIX', comment: 'made elsewhere' }))
  add('epub', await jszip({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': xml('<container/>'),
    'OEBPS/content.opf': xml('<package/>'),
    'OEBPS/toc.ncx': xml('<ncx/>'),
    'OEBPS/nav.xhtml': '<html><body>nav</body></html>',
    'OEBPS/ch1.html': '<p>one</p>',
    'OEBPS/ch2.htm': '<p>two</p>',
    'OEBPS/ch3.xht': '<p>three</p>',
    'OEBPS/style.css': 'p { margin: 0 }',
    'OEBPS/images/cover.jpg': bin(700, 5),
    'OEBPS/fonts/serif.ttf': bin(300, 6),
  }))
  add('odt', await jszip({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': xml('<office:document-content><text:p>odt words</text:p></office:document-content>'),
    'styles.xml': xml('<office:document-styles/>'),
    'meta.xml': xml('<office:document-meta/>'),
    'settings.xml': xml('<office:document-settings/>'),
    'manifest.rdf': '<rdf:RDF/>',
    'META-INF/manifest.xml': xml('<manifest:manifest/>'),
    'Pictures/1000000000.png': PNG,
    'Thumbnails/thumbnail.png': PNG,
    'Configurations2/': null,
  }))
  add('xmind', await jszip({
    'content.json': JSON.stringify([{ rootTopic: { title: 'root' } }]),
    'metadata.json': '{}',
    'manifest.json': '{"file-entries":{}}',
    'content.xml': xml('<xmap-content/>'),
    'Thumbnails/thumbnail.png': PNG,
    'resources/abc123.jpeg': bin(200, 8),
  }))
  add('hwpx', await jszip({
    mimetype: 'application/hwp+zip',
    'version.xml': xml('<hv:HCFVersion/>'),
    'settings.xml': xml('<ha:HWPApplicationSetting/>'),
    'Contents/content.hpf': xml('<opf:package/>'),
    'Contents/header.xml': xml('<hh:head/>'),
    'Contents/section0.xml': xml('<hs:sec><hp:p><hp:run><hp:t>한글 본문</hp:t></hp:run></hp:p></hs:sec>'),
    'BinData/image1.bmp': bin(400, 9),
    'Preview/PrvText.txt': '미리보기',
    'Preview/PrvImage.png': PNG,
    'META-INF/container.rdf': '<rdf:RDF/>',
    'META-INF/manifest.xml': xml('<odf:manifest/>'),
  }))
  add('xlsm', await jszip({
    '[Content_Types].xml': CONTENT_TYPES,
    'xl/workbook.xml': xml('<workbook/>'),
    'xl/worksheets/sheet1.xml': xml('<worksheet><sheetData/></worksheet>'),
    'xl/sharedStrings.xml': xml('<sst><si><t>cell</t></si></sst>'),
    'xl/vbaProject.bin': bin(800, 10),
    'xl/printerSettings/printerSettings1.bin': bin(100, 11),
  }))
  add('pptx media kinds', await jszip({
    'ppt/presentation.xml': xml('<p:presentation/>'),
    'ppt/slides/slide1.xml': xml('<p:sld><a:t>slide</a:t></p:sld>'),
    'ppt/slides/_rels/slide1.xml.rels': RELS,
    'ppt/media/image1.svg': '<svg/>',
    'ppt/media/image2.wdp': bin(100, 12),
    'ppt/media/media1.mp4': bin(900, 13),
    'ppt/embeddings/Microsoft_Excel_Worksheet.xlsx': bin(300, 14),
    'ppt/notesSlides/notesSlide1.xml': xml('<p:notes/>'),
  }))
  add('extension case and odd names', await jszip({
    'A.XML': xml('<a/>'),
    'b.Rels': RELS,
    'c.JSON': '{}',
    'D.PNG': PNG,
    'e.': 'dot only',
    'f.xml ': 'trailing space',
    'dir.xml/inner': 'no extension under a dotted folder',
    '.hidden': 'leading dot',
    '그림/사진.png': PNG,
    '문서/본문.xml': xml('<본문/>'),
    'word\\media\\back.png': PNG,
  }))
  add('large deflated text part', await jszip({ 'word/document.xml': xml(`<w:t>${'many words, '.repeat(40000)}</w:t>`), 'a.png': PNG }))
  add('duplicate names', raw([
    { name: 'word/document.xml', data: 'first' },
    { name: 'word/document.xml', data: 'second' },
    { name: 'word/media/a.png', data: PNG },
    { name: 'word/media/a.png', data: PNG },
  ]))

  add('empty archive', raw([]))
  add('empty name kept', raw([{ name: '', data: 'nameless' }, { name: 'x.png', data: PNG }]))
  add('name not UTF-8', raw([{ name: new Uint8Array([0xff, 0x2e, 0x78, 0x6d, 0x6c]), data: 'kept' }, { name: new Uint8Array([0x61, 0xc3, 0x2e, 0x70, 0x6e, 0x67]), flags: 0x0800, data: PNG }]))
  add('every flag but encryption', raw([{ name: 'a.xml', flags: 0xfffe, data: 'text' }, { name: 'a.png', flags: 0xfffe, data: PNG }, { name: 'b.png', flags: 0x0808, data: PNG }]))
  add('times dates crc versions attributes', raw([
    { name: 'a.xml', time: 0xffff, date: 0xffff, crc: 0xffffffff, version: 45, madeBy: 0x031e, internal: 1, external: 0x81a40000, data: 'a' },
    { name: 'b.jpg', time: 0, date: 0, crc: 0xfedcba98, version: 10, madeBy: 0x0a3f, external: 0x20, data: bin(50, 15) },
  ]))
  add('methods kept as they are', raw([
    { name: 'a.xml', ...deflated(xml('<a>deflated</a>')) },
    { name: 'b.xml', data: 'stored' },
    { name: 'c.png', ...deflated(PNG) },
  ]))
  add('directory with an unknown method', raw([{ name: 'd/', method: 12 }, { name: 'd/a.xml', data: 'x' }]))
  add('directory with data', raw([{ name: 'd/', data: 'abc' }]))
  add('directory declaring 0xffffffff bytes', raw([{ name: 'd/', size: 0xffffffff }]))
  add('stored part claiming more than it holds', raw([{ name: 'a.xml', data: 'hi', size: 100 }, { name: 'a.png', data: PNG, size: 9999 }]))
  add('deflated part claiming more than it inflates to', raw([{ name: 'a.xml', ...deflated('hello'), size: 500 }]))
  add('deflate stream with bytes after its end', raw([{ name: 'a.xml', data: new Uint8Array([...deflated('hello').data, ...bin(50, 16)]), method: 8, size: 5 }]))
  add('local name and extra unlike the central ones', raw([
    { name: 'a.xml', localName: 'a-much-longer-local-name.xml', localExtra: bin(9, 17), extra: new Uint8Array([0x55, 0x54, 0, 0]), comment: 'entry comment', data: 'central name wins' },
    { name: 'p.png', localName: 'q', extra: bin(12, 18), comment: 'c', data: PNG },
  ]))
  add('data descriptors after the data', raw([
    { name: 'a.xml', flags: 0x0808, data: 'described', after: new Uint8Array([0x50, 0x4b, 0x07, 0x08, ...bin(12, 19)]) },
    { name: 'a.png', flags: 0x0008, data: PNG, after: bin(12, 20) },
  ]))
  add('prefix with shifted offsets', raw([{ name: 'a.xml', data: 'after a stub' }, { name: 'b.gif', data: PNG }], { prefix: bin(333, 21) }))
  add('gap before the central directory', raw([{ name: 'a.xml', data: 'x' }], { gap: bin(77, 22) }))
  add('archive comment', raw([{ name: 'a.xml', data: 'x' }], { comment: 'a comment' }))
  add('longest archive comment', raw([{ name: 'a.xml', data: 'x' }], { comment: bin(0xffff, 23) }))
  add('end record past the search window', raw([{ name: 'a.xml', data: 'x' }], { comment: bin(0xffff, 24), trailing: new Uint8Array([0]) }))
  const fake = Buffer.alloc(22)
  fake.writeUInt32LE(0x06054b50, 0)
  add('end record inside the archive comment', raw([{ name: 'a.xml', data: 'x' }], { comment: new Uint8Array([...fake, 1, 2, 3]) }))
  add('directory record size covering the end record', raw([{ name: 'a.xml', data: 'x' }], { cdSize: 46 + 5 + 22 }))
  add('count below the records', raw([{ name: 'a.xml', data: 'x' }, { name: 'b.xml', data: 'y' }], { count: 1 }))
  add('count zero', raw([{ name: 'a.xml', data: 'x' }], { count: 0, diskEntries: 0 }))
  add('shared bytes within the archive size', raw([
    { name: 'a.xml', data: 'shared' },
    { name: 'b.xml', data: 'shared', local: false, at: 0 },
  ]))
  add('10000 parts', raw(Array.from({ length: 10000 }, (_, n) => ({ name: `m/${n}.png`, data: n % 1000 === 0 ? 'x' : EMPTY }))))

  add('empty file', EMPTY)
  add('21 bytes', bin(21, 25))
  add('22 zero bytes', new Uint8Array(22))
  add('count 0xffff', raw([{ name: 'a.xml', data: 'x' }], { count: 0xffff }))
  add('directory size 0xffffffff', raw([{ name: 'a.xml', data: 'x' }], { cdSize: 0xffffffff }))
  add('directory offset 0xffffffff', raw([{ name: 'a.xml', data: 'x' }], { cdOffset: 0xffffffff }))
  const overflowing = { name: 'a.xml', data: 'x', extra: bin(4, 26), comment: 'abc' }
  add('last record comment past the directory', raw([overflowing], { cdSize: 46 + 5 + 4 + 3 - 2 }))

  divergent('zip64 locator before the end record', raw([{ name: 'a.xml', data: 'x' }], { zip64Locator: true }))
  divergent('disk number 0xffff', raw([{ name: 'a.xml', data: 'x' }], { disk: 0xffff }))
  divergent('directory disk 0xffff', raw([{ name: 'a.xml', data: 'x' }], { cdDisk: 0xffff }))
  divergent('entries on disk 0xffff', raw([{ name: 'a.xml', data: 'x' }], { diskEntries: 0xffff }))
  divergent('directory past the end', raw([{ name: 'a.xml', data: 'x' }], { cdSize: 46 + 5 + 1000 }))
  divergent('directory offset at a local header', raw([{ name: 'a.xml', data: 'x' }], { cdOffset: 0 }))
  divergent('count above the records', raw([{ name: 'a.xml', data: 'x' }], { count: 3 }))
  divergent('last record name past the directory', raw([overflowing], { cdSize: 46 + 3 }))
  divergent('part compressed size 0xffffffff', raw([{ name: 'a.xml', data: 'x', compSize: 0xffffffff }]))
  divergent('part size 0xffffffff', raw([{ name: 'a.png', data: 'x', size: 0xffffffff }]))
  divergent('part local offset 0xffffffff', raw([{ name: 'a.xml', data: 'x', at: 0xffffffff }]))
  divergent('text part local offset past the end', raw([{ name: 'a.xml', data: 'x', at: 0xfffffff0 }]))
  divergent('text part local header signature', raw([{ name: 'a.xml', data: 'x', localSig: 0 }]))
  divergent('picture local header signature', raw([{ name: 'a.xml', data: 'x' }, { name: 'a.png', data: PNG, localSig: 0x12345678 }]))
  divergent('picture local offset past the end', raw([{ name: 'a.png', data: PNG, at: 0x7fffffff }]))
  divergent('text part data past the end', raw([{ name: 'a.xml', data: 'x', compSize: 5000, size: 5000 }]))
  divergent('picture data past the end', raw([{ name: 'a.png', data: 'x', compSize: 5000, size: 5000 }]))
  divergent('prepended stub, offsets not shifted', raw([{ name: 'a.xml', data: 'x' }], { prefix: bin(64, 27), unshifted: true }))
  divergent('encrypted text part', raw([{ name: 'a.xml', flags: 0x0001, data: 'secret' }]))
  divergent('encrypted picture', raw([{ name: 'a.png', flags: 0x0009, data: PNG }]))
  divergent('encrypted directory', raw([{ name: 'd/', flags: 0x0001 }]))
  divergent('unsupported method on a text part', raw([{ name: 'a.xml', method: 12, data: 'bzip2?' }]))
  divergent('unsupported method on a picture', raw([{ name: 'a.png', method: 99, data: PNG }]))
  divergent('damaged deflate text part', raw([{ name: 'a.xml', method: 8, data: new Uint8Array([0xff, 0, 1]), size: 5 }]))
  divergent('damaged deflate picture', raw([{ name: 'a.png', method: 8, data: new Uint8Array([0xff]), size: 5 }]))
  divergent('cut deflate text part', raw([{ name: 'a.xml', method: 8, data: deflated(bin(400, 28)).data.subarray(0, 50), size: 400 }]))
  divergent('stored text part under-declared', raw([{ name: 'a.xml', data: 'hello', size: 3 }]))
  divergent('deflated picture under-declared', raw([{ name: 'a.png', ...deflated(bin(100, 29)), size: 10 }]))
  divergent('deflated text part under-declared', raw([{ name: 'a.xml', ...deflated('x'.repeat(5000)), size: 4999 }]))
  divergent('part declaring past the part limit', raw([{ name: 'big.bin', data: 'x', size: 512 * 1024 * 1024 + 1 }]))
  // megabytes each: compared after the gate only, where both sides refuse and the ledger holds no copy
  divergent('10001 parts', raw(Array.from({ length: 10001 }, (_, n) => ({ name: `m/${n}.png`, data: EMPTY }))))
  inputs[inputs.length - 1]!.mutate = false
  const half = await deflatedZeros(512 * 1024 * 1024)
  divergent('parts inflating past the total limit', raw([
    { name: 'a.bin', ...half },
    { name: 'b.bin', ...half },
    { name: 'c.bin', ...half },
    { name: 'd.bin', data: 'x' },
  ]))
  inputs[inputs.length - 1]!.mutate = false
  const shared = 'x'.repeat(1000)
  divergent('text parts sharing bytes past the archive size', raw([
    { name: 'a.xml', data: shared },
    { name: 'b.xml', data: shared, local: false, at: 0 },
    { name: 'c.xml', data: shared, local: false, at: 0 },
  ]))
  return inputs
}

let archives: Promise<Input[]> | undefined
const built = () => (archives ??= builtArchives())
const ARCHIVES = ['docx', 'pptx', 'xlsx', 'xlsm', 'epub', 'hwpx', 'odt', 'xmind']

const NAMES = [
  '', '/', 'a', 'mimetype', '.rels', '_rels/.rels', 'a.', 'a..xml', 'A.XML', 'x.Xml', 'a.b.xml', 'dir.xml/file', 'dir/file.png',
  'file.png/', 'x.xml/', 'a.xml ', 'a. xml', 'a.xmlx', 'a.xm', 'a.jpeg', 'a.xml.png', 'a.png.xml', 'word\\media\\a.png', 'a.png\\b',
  'a.xml', 'a.rels', 'a.json', 'a.txt', 'a.html', 'a.htm', 'a.xhtml', 'a.xht', 'a.opf', 'a.ncx', 'a.hpf',
  'a.svg', 'a.css', 'a.bin', 'a.rdf', 'a.odttf', 'a.HPF', 'a.Opf', 'a.\u212Aml', 'a.\uFF38ML', 'a.XHT\u0130', '사진.XML', '문서/그림.png',
  '__proto__', 'a.__proto__', 'a.constructor', 'a.hasOwnProperty', 'a.toString', 'a.valueOf',
]

export const SPECS: Spec[] = [
  { fn: 'isTextPart', extensions: [], mutateText: true,
    built: () => NAMES.map((text, n) => ({ label: `name ${n}`, text })),
    call: ({ text = '' }) => isTextPart(text) },
  // the export as it is: it never inflates, so what the gate refuses it copies or refuses in other words
  { fn: 'readZipTextParts', extensions: ARCHIVES, mutation: 'none',
    built: async () => (await built()).filter(input => input.mutate !== false),
    call: ({ bytes = EMPTY }) => readZipTextPartsOf(bytes) },
  // what the Rust reader is: the gate, then the copy
  { fn: 'gatedReadZipTextParts', engineFn: 'readZipTextParts', extensions: ARCHIVES, mutation: 'container',
    built,
    call: async ({ bytes = EMPTY }) => {
      await assertZipInflatesWithinLimits(bytes)
      return readZipTextPartsOf(bytes)
    } },
]
