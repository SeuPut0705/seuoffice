import * as CFB from 'cfb'
import { createHash } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { buildZip } from '../docx-diff/package-zips'
import { assertCompoundFile } from '../../packages/compound-file/src/validate'
import { assertSoundCompoundFile } from '../../packages/file-parse/src/damaged-file'
import { docToText } from '../../packages/file-parse/src/doc'
import { pptToText } from '../../packages/file-parse/src/ppt'
import type { Input, Spec } from './spec'

const EMPTY = new Uint8Array()
const FREESECT = -1
const ENDOFCHAIN = -2
const FATSECT = -3
const DIFSECT = -4
const NOSTREAM = -1

/* ---- compound files: the helpers of compound-cases.ts, which does not export them ---- */

function fill(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (seed + i * 31) & 0xff
  return out
}

function int32s(values: readonly number[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  const view = new DataView(out.buffer)
  for (let k = 0; k < length / 4; k++) view.setInt32(k * 4, values[k] ?? FREESECT, true)
  return out
}

interface Entry { name: string; type: number; left?: number; right?: number; child?: number; start: number; size: number }

/** One directory sector; slots past `entries` are unused, as cfb writes them. */
function directory(entries: readonly Entry[], sectorSize = 512): Uint8Array {
  const out = new Uint8Array(sectorSize)
  const view = new DataView(out.buffer)
  for (let slot = 0; slot < sectorSize / 128; slot++) {
    const at = slot * 128
    const entry = entries[slot]
    if (entry) {
      for (let k = 0; k < entry.name.length; k++) view.setUint16(at + 2 * k, entry.name.charCodeAt(k), true)
      view.setUint16(at + 64, (entry.name.length + 1) * 2, true)
      out[at + 66] = entry.type
      out[at + 67] = 1
      view.setInt32(at + 116, entry.start, true)
      view.setInt32(at + 120, entry.size, true)
    }
    view.setInt32(at + 68, entry?.left ?? NOSTREAM, true)
    view.setInt32(at + 72, entry?.right ?? NOSTREAM, true)
    view.setInt32(at + 76, entry?.child ?? NOSTREAM, true)
  }
  return out
}

interface Layout {
  version?: 3 | 4
  dirStart: number
  dirCount?: number
  miniFat?: readonly [start: number, count: number]
  difat?: readonly [start: number, count: number]
  headerFat: readonly number[]
  fatCount?: number
  sectors: readonly Uint8Array[]
  length?: number
}

/** A compound file written field by field, for layouts cfb never writes. */
function compound(layout: Layout): Uint8Array {
  const version = layout.version ?? 3
  const size = version === 4 ? 4096 : 512
  const out = new Uint8Array(size * (layout.sectors.length + 1))
  const view = new DataView(out.buffer)
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
  view.setUint16(24, 0x3e, true)
  view.setUint16(26, version, true)
  view.setUint16(28, 0xfffe, true)
  view.setUint16(30, version === 4 ? 12 : 9, true)
  view.setUint16(32, 6, true)
  view.setInt32(40, layout.dirCount ?? 0, true)
  view.setInt32(44, layout.fatCount ?? layout.headerFat.length, true)
  view.setInt32(48, layout.dirStart, true)
  view.setInt32(56, 4096, true)
  const [miniStart, miniCount] = layout.miniFat ?? [ENDOFCHAIN, 0]
  view.setInt32(60, miniStart, true)
  view.setInt32(64, miniCount, true)
  const [difatStart, difatCount] = layout.difat ?? [ENDOFCHAIN, 0]
  view.setInt32(68, difatStart, true)
  view.setInt32(72, difatCount, true)
  out.set(int32s(layout.headerFat, 436), 76)
  layout.sectors.forEach((sector, k) => out.set(sector.subarray(0, size), (k + 1) * size))
  return layout.length === undefined ? out : out.slice(0, layout.length)
}

/** A file as cfb writes it, with `streams` added by path. */
function written(streams: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
  const container = CFB.utils.cfb_new()
  for (const [path, content] of streams) CFB.utils.cfb_add(container, path, Buffer.from(content))
  return new Uint8Array(CFB.write(container, { type: 'buffer' }) as Buffer)
}

const concat = (parts: readonly Uint8Array[]): Buffer => Buffer.concat(parts)
const le16 = (value: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(value & 0xffff); return b }
const le32 = (value: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(value >>> 0); return b }

/* ---- PowerPoint: a record writer ---- */

/** RecordHeader: recVerInstance, recType, recLen (declared, as given when it is not the body's). */
const record = (verInstance: number, type: number, body: Uint8Array, declared = body.length): Buffer =>
  concat([le16(verInstance), le16(type), le32(declared), body])
const container = (type: number, ...children: Uint8Array[]): Buffer => record(0x000f, type, concat(children))
const atom = (type: number, body: Uint8Array): Buffer => record(0, type, body)

const RT = {
  document: 0x03e8, documentAtom: 0x03e9, endDocument: 0x03ea, slide: 0x03ee, slideAtom: 0x03ef, notes: 0x03f0,
  environment: 0x03f2, slidePersist: 0x03f3, mainMaster: 0x03f8, drawing: 0x040c, list: 0x07d0, textHeader: 0x0f9f,
  textChars: 0x0fa0, textBytes: 0x0fa8, slideList: 0x0ff0, userEdit: 0x0ff5, currentUser: 0x0ff6, headersFooters: 0x0fd9,
  persistDirectory: 0x1772, dgContainer: 0xf002, spgrContainer: 0xf003, spContainer: 0xf004, fdg: 0xf008, clientTextbox: 0xf00d,
  cstring: 0x0fba,
}

const textChars = (text: string): Buffer => atom(RT.textChars, Buffer.from(text, 'utf16le'))
const textBytes = (bytes: string | Uint8Array): Buffer => atom(RT.textBytes, typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : bytes)
const textbox = (...children: Uint8Array[]): Buffer => container(RT.clientTextbox, atom(RT.textHeader, le32(1)), ...children)
const shape = (...children: Uint8Array[]): Buffer => container(RT.spContainer, ...children)
const group = (...children: Uint8Array[]): Buffer => container(RT.spgrContainer, ...children)
/** A slide's drawing: a group shape whose first shape holds no text, then one text box per entry. */
const drawingOf = (...boxes: Uint8Array[]): Buffer =>
  container(RT.drawing, container(RT.dgContainer, atom(RT.fdg, Buffer.alloc(8)), group(shape(), ...boxes.map(box => shape(box)))))
const slideAtom = (): Buffer => atom(RT.slideAtom, Buffer.alloc(24))
const slideOf = (...texts: Uint8Array[]): Buffer => container(RT.slide, slideAtom(), drawingOf(...texts.map(text => textbox(text))))
const slideListWith = (...texts: Uint8Array[]): Buffer =>
  container(RT.slideList, ...texts.map(text => concat([atom(RT.slidePersist, Buffer.alloc(20)), atom(RT.textHeader, le32(2)), text])))
const documentOf = (...children: Uint8Array[]): Buffer => container(RT.document, atom(RT.documentAtom, Buffer.alloc(40)), ...children)

/** The Current User stream: one CurrentUserAtom naming the offset of the last UserEditAtom. */
function currentUser(offset: number, extra: Uint8Array = EMPTY): Buffer {
  return concat([atom(RT.currentUser, concat([le32(0x14), le32(0xe391c05f), le32(offset), le16(0), le16(0), Buffer.alloc(4), extra])), EMPTY])
}

/** `PowerPoint Document` and `Current User` with one edit: a PersistDirectoryAtom and the UserEditAtom after it. */
function deck(top: readonly Uint8Array[], options: { persist?: Uint8Array; lastEdit?: number; persistOffset?: number; cuOffset?: number } = {}): { ppt: Buffer; user: Buffer } {
  const body = concat(top)
  const persist = atom(RT.persistDirectory, options.persist ?? concat([le32((1 << 20) | 1), le32(0)]))
  const persistAt = body.length
  const editAt = persistAt + persist.length
  const edit = atom(RT.userEdit, concat([Buffer.alloc(8), le32(options.lastEdit ?? 0), le32(options.persistOffset ?? persistAt), Buffer.alloc(12)]))
  return { ppt: concat([body, persist, edit]), user: currentUser(options.cuOffset ?? editAt) }
}

const pptFile = (parts: { ppt: Uint8Array; user: Uint8Array }): Uint8Array =>
  written([['/Current User', parts.user], ['/PowerPoint Document', parts.ppt]])

const pptOf = (...top: Uint8Array[]): Uint8Array => pptFile(deck(top))

/* ---- Word: a FIB, a piece table and the property tables ---- */

interface WordPiece { text: string; unicode?: boolean }

interface WordSpec {
  pieces: WordPiece[]
  /** Character counts of the stories; ccpText defaults to every character of the pieces. */
  ccp?: Partial<Record<'text' | 'ftn' | 'hdd' | 'atn' | 'edn' | 'txbx' | 'hdrTxbx', number>>
  /** Runs of text marked deleted, as [first, last) character positions of the piece text. */
  deleted?: Array<[number, number]>
  /** Runs a paragraph property turns into a paragraph mark, as [first, last) character positions. */
  paragraphMarks?: Array<[number, number]>
  /** The stories of the header table (plcfhdd), as character offsets from the start of the header story. */
  headerStarts?: number[]
  bookmarks?: string[]
  /** Table stream name: `1Table` unless this says 0. */
  tableNumber?: 0 | 1
  /** PRC entries (flag 1) before the piece table: their sizes. */
  prc?: number[]
}

interface WordBuilt { word: Buffer; table: Buffer }

const FIB_SIZE = 0x400

function word(spec: WordSpec): WordBuilt {
  const word = Buffer.alloc(FIB_SIZE)
  const table: Buffer[] = []
  // text, one piece after another
  let cursor = FIB_SIZE
  let cp = 0
  const placed = spec.pieces.map(piece => {
    const raw = piece.unicode ? Buffer.from(piece.text, 'utf16le') : Buffer.from(piece.text, 'latin1')
    const entry = { start: cursor, cp, length: piece.text.length, unicode: piece.unicode === true, raw }
    cursor += raw.length
    cp += piece.text.length
    return entry
  })
  const text = concat(placed.map(piece => piece.raw))
  const filePosOf = (position: number): number => {
    const piece = placed.find(candidate => position >= candidate.cp && position <= candidate.cp + candidate.length) ?? placed[placed.length - 1]!
    return piece.start + (position - piece.cp) * (piece.unicode ? 2 : 1)
  }
  let body = concat([word, text])
  const pad512 = (): void => { if (body.length % 512) body = concat([body, Buffer.alloc(512 - (body.length % 512))]) }
  pad512()

  // CLX: PRC entries, then the piece table
  const clx: Buffer[] = []
  for (const size of spec.prc ?? []) clx.push(concat([Buffer.from([1]), le16(size), Buffer.alloc(size, 7)]))
  const plc: Buffer[] = placed.map(piece => le32(piece.cp)).concat([le32(cp)])
  for (const piece of placed) {
    plc.push(le16(0), le32(piece.unicode ? piece.start : (piece.start * 2) | 0x40000000), le16(0))
  }
  const plcPcd = concat(plc)
  clx.push(concat([Buffer.from([2]), le32(plcPcd.length), plcPcd]))
  const clxBuffer = concat(clx)
  table.push(clxBuffer)
  let tableLength = clxBuffer.length
  const addTable = (data: Buffer): [number, number] => { const at = tableLength; table.push(data); tableLength += data.length; return [at, data.length] }

  const ccp = { text: cp, ftn: 0, hdd: 0, atn: 0, edn: 0, txbx: 0, hdrTxbx: 0, ...spec.ccp }
  word.writeUInt16LE(0xa5ec, 0)
  word.writeUInt16LE(spec.tableNumber === 0 ? 0 : 0x0200, 0xa)
  word.writeUInt32LE(FIB_SIZE, 0x18)
  word.writeUInt32LE(ccp.text, 0x4c)
  word.writeUInt32LE(ccp.ftn, 0x50)
  word.writeUInt32LE(ccp.hdd, 0x54)
  word.writeUInt32LE(ccp.atn, 0x5c)
  word.writeUInt32LE(ccp.edn, 0x60)
  word.writeUInt32LE(ccp.txbx, 0x64)
  word.writeUInt32LE(ccp.hdrTxbx, 0x68)
  word.writeUInt32LE(0, 0x1a2)

  if (spec.headerStarts) {
    const [at, length] = addTable(concat(spec.headerStarts.map(le32)))
    word.writeUInt32LE(at, 0xf2)
    word.writeUInt32LE(length, 0xf6)
  }
  if (spec.bookmarks) {
    const names = concat(spec.bookmarks.map(name => concat([le16(name.length), Buffer.from(name, 'utf16le')])))
    const [at, length] = addTable(concat([le16(0xffff), le16(spec.bookmarks.length), le16(0), names]))
    word.writeUInt32LE(at, 0x142)
    word.writeUInt32LE(length, 0x146)
    const [fAt, fLength] = addTable(concat(spec.bookmarks.map((_, index) => le32(index * 3)).concat([le32(0)])))
    word.writeUInt32LE(fAt, 0x14a)
    word.writeUInt32LE(fLength, 0x14e)
    const [lAt, lLength] = addTable(concat(spec.bookmarks.map((_, index) => le32(index * 3 + 2)).concat([le32(0)])))
    word.writeUInt32LE(lAt, 0x152)
    word.writeUInt32LE(lLength, 0x156)
  }
  // an FKP page: one run per range, runs in between that carry nothing
  const fkp = (ranges: Array<[number, number]>, properties: (hole: boolean) => Buffer, bx: (offset: number) => Buffer): Buffer => {
    const runs: Array<{ start: number; hole: boolean }> = []
    let end = 0
    for (const [from, to] of ranges) {
      if (runs.length > 0 && end !== from) runs.push({ start: end, hole: true })
      runs.push({ start: from, hole: false })
      end = to
    }
    const page = Buffer.alloc(512)
    runs.forEach((run, index) => page.writeUInt32LE(filePosOf(run.start), index * 4))
    page.writeUInt32LE(filePosOf(end), runs.length * 4)
    runs.forEach((run, index) => {
      const props = properties(run.hole)
      const offset = 0x40 + index * 8
      props.copy(page, offset * 2)
      bx(offset).copy(page, (runs.length + 1) * 4 + index * bx(0).length)
    })
    page.writeUInt8(runs.length, 511)
    return page
  }
  const addPage = (page: Buffer, at: number): void => {
    const pageNumber = body.length / 512
    body = concat([body, page])
    const [tableAt, length] = addTable(concat([le32(0), le32(0xffffff), le32(pageNumber)]))
    word.writeUInt32LE(tableAt, at)
    word.writeUInt32LE(length, at + 4)
  }
  // a CHPX page: sprmCFRMarkDel (0x0800) with the operand 1 over each deleted range
  if (spec.deleted?.length) {
    const page = fkp(spec.deleted, hole => (hole ? Buffer.from([2, 0x00, 0x08]) : Buffer.from([3, 0x00, 0x08, 0x01])), offset => Buffer.from([offset]))
    // a CHPX page keeps one byte per run after the positions, where the BX of a paragraph page keeps thirteen
    addPage(page, 0xfa)
  }
  // a PAPX page: 0x2417 with an operand over each range; the runs between hold 0x2403
  if (spec.paragraphMarks?.length) {
    const page = fkp(spec.paragraphMarks, hole => Buffer.from([3, 0, 0, hole ? 0x03 : 0x17, 0x24, 1]), offset => concat([Buffer.from([offset]), Buffer.alloc(12)]))
    addPage(page, 0x102)
  }
  // the FIB was copied into `body` before its fields were set
  body.set(word, 0)
  return { word: body, table: concat(table) }
}

const wordFile = (spec: WordSpec, names: [string, string] = ['/WordDocument', '/1Table']): Uint8Array => {
  const built = word(spec)
  return written([[names[0], built.word], [spec.tableNumber === 0 ? '/0Table' : names[1], built.table]])
}

/* ---- inputs ---- */

const named = (label: string, bytes: Uint8Array): Input => ({ label, bytes })
const korean = '\uc548\ub155\ud558\uc138\uc694 \uc2ac\ub77c\uc774\ub4dc \u3042\u3044\u3046'

function builtPpt(): Input[] {
  const slides = [slideOf(textChars('Welcome to the deck'), textBytes('Second box\r\nline two')), slideOf(textChars(`${korean}\r\nastral \u{1f600} mark`)), slideOf(textBytes('\x80\x81\x85\x9f caf\xe9'))]
  const notes = container(RT.notes, atom(0x03f1, Buffer.alloc(8)), drawingOf(textbox(textChars('speaker notes'))))
  const master = container(RT.mainMaster, slideAtom(), drawingOf(textbox(textChars('master text'))), atom(RT.cstring, Buffer.from('Master', 'utf16le')))
  const listed = slideListWith(textChars('outline one'), textBytes('outline two'))
  const doc = documentOf(container(RT.environment, atom(0x0fa3, Buffer.alloc(6))), listed, atom(RT.endDocument, EMPTY))
  const edit = (top: Uint8Array[]): Uint8Array => pptFile(deck(top))
  const long = 'long text that runs past the mini stream cutoff. '.repeat(120)
  const inputs: Input[] = [
    named('three slides with notes and master', edit([doc, master, ...slides, notes])),
    named('slides only', pptOf(...slides)),
    named('slide list of the document only (no slide containers)', pptOf(doc)),
    named('document with an empty slide list', pptOf(documentOf(slideListWith()))),
    named('document without a slide list', pptOf(documentOf())),
    named('two documents, the second without a slide list', pptOf(doc, documentOf())),
    named('no records at all', pptFile({ ppt: Buffer.alloc(40), user: currentUser(0) })),
    named('long text in a stream of the FAT', pptOf(slideOf(textChars(long)), slideOf(textBytes(long)))),
    named('text with CR, CRLF and trailing space', pptOf(slideOf(textChars('  a\rb\r\nc \u00a0\ufeff'), textBytes('x\ry\r\r\nz')))),
    named('empty and blank text boxes', pptOf(slideOf(textChars(''), textBytes(''), textChars(' \r\n ')))),
    named('later text atom replaces an earlier one in a box', pptOf(container(RT.slide, slideAtom(), drawingOf(textbox(textChars('first'), textBytes('second')))))),
    named('slide whose drawing has no group shape (TypeError)', pptOf(container(RT.slide, slideAtom(), container(RT.drawing, container(RT.dgContainer, atom(RT.fdg, Buffer.alloc(8))))))),
    named('slide with an empty drawing record', pptOf(container(RT.slide, slideAtom(), container(RT.drawing)))),
    named('slide without a drawing', pptOf(container(RT.slide, slideAtom()), slideOf(textChars('after')))),
    named('slide with two drawings, the last empty', pptOf(container(RT.slide, slideAtom(), drawingOf(textbox(textChars('lost'))), container(RT.drawing)))),
    named('nested group shapes (their boxes are not read)', pptOf(container(RT.slide, container(RT.drawing, container(RT.dgContainer, group(shape(), group(shape(textbox(textChars('deep')))), shape(textbox(textChars('top'))))))))),
    named('two group shapes in one drawing, the last wins', pptOf(container(RT.slide, container(RT.drawing, container(RT.dgContainer, group(shape(textbox(textChars('one')))), group(shape(textbox(textChars('two'))))))))),
    named('shape with two text boxes, the last wins', pptOf(container(RT.slide, container(RT.drawing, container(RT.dgContainer, group(shape(textbox(textChars('a')), textbox(textChars('b'))))))))),
    named('records the reader does not know, and ones it skips', pptOf(atom(0x1234, Buffer.alloc(5)), atom(0x6969, Buffer.alloc(3)), slideOf(textChars('kept')), atom(0xffff, EMPTY))),
    // its mutants reach records ppt-to-text reads again without end (a defect of
    // the TypeScript, reported); Rust refuses them, the TypeScript never answers
    { ...named('headers and footers record is read again as records', pptOf(documentOf(container(RT.headersFooters, atom(RT.textHeader, le32(1)), slideListWith(textChars('inside'))), listed))), mutate: false },
    named('end document atom with a body (thrown string)', pptOf(atom(RT.endDocument, Buffer.alloc(4)), slideOf(textChars('x')))),
    named('end document atom inside a document', pptOf(documentOf(atom(RT.endDocument, Buffer.alloc(2))))),
    named('slide persist atom of any size', pptOf(documentOf(container(RT.slideList, atom(RT.slidePersist, Buffer.alloc(3)), textChars('after short persist'), atom(RT.slidePersist, Buffer.alloc(40)), textBytes('after long persist'))))),
    named('slide atom shorter than its fields', pptOf(container(RT.slide, atom(RT.slideAtom, Buffer.alloc(2)), drawingOf(textbox(textChars('x')))))),
    named('text header atom of two bytes', pptOf(container(RT.slide, container(RT.drawing, container(RT.dgContainer, group(shape(container(RT.clientTextbox, atom(RT.textHeader, Buffer.alloc(2)), textChars('ab'))))))))),
    named('odd length text chars atom', pptOf(slideOf(atom(RT.textChars, Buffer.from('a\u0000b\u0000c', 'latin1'))))),
    named('lone surrogate free text with a surrogate pair', pptOf(slideOf(textChars('\u{10000}\u{10ffff}')))),
    named('text bytes with every byte value', pptOf(slideOf(textBytes(Buffer.from(Array.from({ length: 256 }, (_, i) => i)))))),
  ]
  // the edit history
  const body = concat([doc, ...slides])
  inputs.push(named('Current User names an offset past the stream', pptFile({ ppt: body, user: currentUser(0x7fffffff) })))
  inputs.push(named('Current User names a negative offset', pptFile({ ppt: body, user: currentUser(-5 >>> 0) })))
  inputs.push(named('Current User names offset 0 (records, not an edit)', pptFile({ ppt: body, user: currentUser(0) })))
  inputs.push(named('Current User names the document container', pptFile({ ppt: body, user: currentUser(8) })))
  inputs.push(named('Current User holds two atoms (thrown string)', pptFile({ ppt: body, user: concat([currentUser(0), currentUser(0)]) })))
  inputs.push(named('Current User holds no CurrentUserAtom (TypeError)', pptFile({ ppt: body, user: atom(0x1234, Buffer.alloc(30)) })))
  inputs.push(named('Current User atom of four bytes', pptFile({ ppt: body, user: atom(RT.currentUser, Buffer.alloc(4)) })))
  inputs.push(named('Current User stream is empty (TypeError)', pptFile({ ppt: body, user: EMPTY })))
  inputs.push(named('Current User stream of a few bytes', pptFile({ ppt: body, user: Buffer.from([1, 2, 3]) })))
  inputs.push(named('PowerPoint Document stream is empty', pptFile({ ppt: EMPTY, user: currentUser(0) })))
  inputs.push(named('PowerPoint Document stream of a few bytes', pptFile({ ppt: Buffer.from([1, 2, 3, 4, 5]), user: currentUser(0) })))
  inputs.push(named('no PowerPoint Document stream (TypeError)', written([['/Current User', currentUser(0)]])))
  inputs.push(named('no Current User stream (TypeError)', written([['/PowerPoint Document', body]])))
  inputs.push(named('neither stream', written([['/Other', fill(100, 1)]])))
  // a persist directory atom first: the edit it needs is missing
  const persist = atom(RT.persistDirectory, concat([le32((1 << 20) | 1), le32(0)]))
  inputs.push(named('persist directory atom before any edit (TypeError)', pptFile({ ppt: concat([body, persist]), user: currentUser(body.length) })))
  const twoEdits = (): Uint8Array => {
    const first = deck([doc, slides[0]!])
    const firstLength = first.ppt.length
    const secondPersistAt = firstLength + slides[1]!.length
    const persist2 = atom(RT.persistDirectory, concat([le32((1 << 20) | 2), le32(0)]))
    const edit2At = secondPersistAt + persist2.length
    const firstEditAt = first.ppt.length - 36
    const edit2 = atom(RT.userEdit, concat([Buffer.alloc(8), le32(firstEditAt), le32(secondPersistAt), Buffer.alloc(12)]))
    return pptFile({ ppt: concat([first.ppt, slides[1]!, persist2, edit2]), user: currentUser(edit2At) })
  }
  inputs.push(named('two edits, the second points back at the first', twoEdits()))
  inputs.push(named('user edit atom shorter than its fields', pptFile({ ppt: concat([body, atom(RT.userEdit, Buffer.alloc(10))]), user: currentUser(body.length) })))
  inputs.push(named('user edit names a persist directory past the stream', pptFile(deck([doc, ...slides], { persistOffset: 0x10000 }))))
  inputs.push(named('user edit names a last edit past the stream', pptFile(deck([doc, ...slides], { lastEdit: 0x10000 }))))
  inputs.push(named('persist directory with many entries', pptFile(deck([doc, ...slides], { persist: concat([le32((0xfff << 20) | 5), fill(0x4000, 3), le32(0xffffffff), le32(0x7fffffff)]) }))))
  inputs.push(named('persist directory atom of three bytes', pptFile(deck([doc, ...slides], { persist: Buffer.from([1, 2, 3]) }))))
  // record lengths that do not fit
  const declared = (text: string, length: number): Buffer => concat([le16(0), le16(RT.textChars), le32(length), Buffer.from(text, 'utf16le')])
  inputs.push(named('text chars atom longer than the stream', pptOf(container(RT.slide, container(RT.drawing, container(RT.dgContainer, group(shape(container(RT.clientTextbox, declared('cut off', 0x1000))))))))))
  inputs.push(named('record of negative length', pptOf(slideOf(textChars('before')), record(0, 0x1234, EMPTY, 0xfffffff0), slideOf(textChars('after')))))
  inputs.push(named('container longer than the stream', pptOf(record(0x0f, RT.slide, slideOf(textChars('half')), 0x7fffffff))))
  inputs.push(named('container of length zero holding records', pptOf(record(0x0f, RT.slide, EMPTY, 0), slideOf(textChars('after')))))
  inputs.push(named('truncated in the middle of a record header', pptOf(slideOf(textChars('whole')), Buffer.from([0x0f, 0x00, 0xee]))))
  inputs.push(named('truncated slide', pptOf(slideOf(textChars('whole')).subarray(0, 40))))
  inputs.push(named('slide list container with a negative length', pptOf(documentOf(record(0x0f, RT.slideList, textChars('x'), 0xfffffff8)))))
  inputs.push(named('byte atom of length zero', pptOf(slideOf(atom(RT.textBytes, EMPTY)))))
  inputs.push(named('byte atom longer than the stream', pptOf(slideOf(record(0, RT.textBytes, Buffer.from('abc', 'latin1'), 40)))))
  // the stack: a container inside itself, thousands of levels deep
  const nested = (depth: number, type: number): Buffer => { let b: Buffer = textChars('deep'); for (let i = 0; i < depth; i++) b = record(0x0f, type, b); return b }
  inputs.push({ label: 'slide nested 100 deep', bytes: pptOf(nested(100, RT.slide)), isolate: true })
  inputs.push({ label: 'slide nested 20000 deep (RangeError)', bytes: pptOf(nested(20000, RT.slide)), isolate: true })
  inputs.push({ label: 'group shapes nested 20000 deep (RangeError)', bytes: pptOf(container(RT.slide, container(RT.drawing, container(RT.dgContainer, nested(20000, RT.spgrContainer))))), isolate: true })
  // streams named as cfb finds them
  const parts = deck([doc, ...slides])
  inputs.push(named('stream names in other letter case', written([['/current user', parts.user], ['/POWERPOINT DOCUMENT', parts.ppt]])))
  inputs.push(named('streams inside a storage', written([['/Dir/Current User', parts.user], ['/Dir/PowerPoint Document', parts.ppt]])))
  inputs.push(named('first stream of a name wins over a nested one', written([['/A/PowerPoint Document', Buffer.alloc(50)], ['/Current User', parts.user], ['/PowerPoint Document', parts.ppt]])))
  inputs.push(named('name with a dotless i (U+0131) that upper-cases to I', written([['/Current User', parts.user], ['/PowerPo\u0131nt Document', parts.ppt]])))
  inputs.push(named('name with a long s (U+017F) that upper-cases to S', written([['/Current U\u017fer', parts.user], ['/PowerPoint Document', parts.ppt]])))
  inputs.push(named('Kelvin sign (U+212A) is not a k', written([['/Current User', parts.user], ['/PowerPoint Document', parts.ppt], ['/\u212a', fill(10, 1)]])))
  inputs.push(named('stream name with a trailing slash', written([['/Current User', parts.user], ['/PowerPoint Document/', parts.ppt]])))
  inputs.push(named('stream name with a slash inside', written([['/Current User', parts.user], ['/x/PowerPoint Document', parts.ppt]])))
  inputs.push(named('stream with control characters in its name', written([['/Current User', parts.user], ['/\u0005PowerPoint Document', parts.ppt]])))
  inputs.push(named('streams are a storage and a stream of the same name', written([['/Current User/x', fill(20, 1)], ['/Current User', parts.user], ['/PowerPoint Document', parts.ppt]])))
  // other containers
  inputs.push(named('not a compound file', Buffer.from('plain text, not a presentation')))
  inputs.push(named('empty file', EMPTY))
  inputs.push(named('a zip', buildZip([{ name: '[Content_Types].xml', data: '<Types/>' }])))
  inputs.push(named('signature only', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])))
  inputs.push(named('header of a compound file without sectors', compound({ dirStart: 0, headerFat: [], sectors: [] })))
  return inputs
}

function builtDoc(): Input[] {
  const plain = (text: string, extra: Partial<WordSpec> = {}): Uint8Array => wordFile({ pieces: [{ text }], ...extra })
  const inputs: Input[] = [
    named('one compressed piece', plain('Hello world.\rSecond paragraph\r')),
    named('one unicode piece', wordFile({ pieces: [{ text: `${korean}\r`, unicode: true }] })),
    named('compressed and unicode pieces', wordFile({ pieces: [{ text: 'English text, ' }, { text: `${korean}, `, unicode: true }, { text: 'and caf\xe9 again\r' }] })),
    named('astral characters in a unicode piece', wordFile({ pieces: [{ text: 'a\u{1f600}b\u{10ffff}c\rend', unicode: true }] })),
    named('long text in streams of the FAT', wordFile({ pieces: [{ text: 'A paragraph of reasonable length for a document.\r'.repeat(300) }] })),
    named('long unicode text', wordFile({ pieces: [{ text: `${korean}\r`.repeat(400), unicode: true }] })),
    named('control characters of Word', plain('a\x02b\x05c\x07d\x08e\x0bf\x0cg\x0dh\x1fi\x1ej\x01k\x03l\x04m\x06n\x00o')),
    named('bytes 0x80 to 0x9f of a compressed piece', plain(Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x80 + i)).join('') + '\r')),
    named('fields: simple, nested, unbalanced', plain('a \x13 HYPERLINK "x" \x14link text\x15 b \x13 outer \x13 inner \x14shown\x15 \x14 outer shown\x15 c \x13 never closed d \x14 only separator \x15 e \x15 \x14 f\r')),
    named('fields with the separator after text and in a row', plain('\x13\x14\x15 \x13x\x15 \x13\x13\x14y\x15\x15 \x13a\x14b\x14c\x15\r')),
    named('footnote, header and text box stories', wordFile({ pieces: [{ text: 'body text\rfootnote one\rheader text\r\rtext in a box\rbox two\r' }], ccp: { text: 10, ftn: 13, hdd: 14, txbx: 17 }, headerStarts: [0, 1, 2, 3, 4, 5, 6, 8, 14] })),
    named('text boxes only after the body', wordFile({ pieces: [{ text: 'body\rbox one\rbox two\r' }], ccp: { text: 5, txbx: 16 } })),
    named('annotations, endnotes and header text boxes', wordFile({ pieces: [{ text: 'body\rnote\rend\rbox\rhdrbox\r' }], ccp: { text: 5, atn: 5, edn: 4, txbx: 4, hdrTxbx: 7 } })),
    named('stories longer than the pieces', wordFile({ pieces: [{ text: 'short' }], ccp: { text: 50, ftn: 20, txbx: 30 } })),
    named('deleted runs', wordFile({ pieces: [{ text: 'keep DELETED keep again GONE end\r' }], deleted: [[5, 12], [23, 27]] })),
    named('deleted runs next to each other', wordFile({ pieces: [{ text: 'abcdefghijklmnop\r' }], deleted: [[2, 5], [5, 8], [10, 12]] })),
    named('deleted run in a unicode piece', wordFile({ pieces: [{ text: 'abcdefgh', unicode: true }, { text: 'ijklmnop' }], deleted: [[2, 5], [6, 10]] })),
    named('deleted run over the whole text', wordFile({ pieces: [{ text: 'everything is deleted' }], deleted: [[0, 21]] })),
    named('paragraph marks from a property', wordFile({ pieces: [{ text: 'one two three four five six\r' }], paragraphMarks: [[3, 4], [7, 8], [13, 14]] })),
    named('paragraph marks in a unicode piece', wordFile({ pieces: [{ text: 'one two three', unicode: true }], paragraphMarks: [[3, 4], [7, 8]] })),
    named('headers: separators only (blanked) and real text', wordFile({ pieces: [{ text: 'body\r\x03\r\x04\r' + 'real header\r\x0d\r' }], ccp: { text: 5, hdd: 4 + 4 + 12 + 2 }, headerStarts: [0, 2, 4, 6, 8, 10, 12, 18, 20] })),
    named('header table end before its start', wordFile({ pieces: [{ text: 'body\rheader text\r' }], ccp: { text: 5, hdd: 12 }, headerStarts: [8, 2, 0, 12] })),
    named('header table too short', wordFile({ pieces: [{ text: 'body\rheader\r' }], ccp: { text: 5, hdd: 7 }, headerStarts: [0] })),
    named('bookmarks', wordFile({ pieces: [{ text: 'a bookmarked text\r' }], bookmarks: ['first', 'second', 'a name'] })),
    named('table stream 0Table', wordFile({ pieces: [{ text: 'zero table\r' }], tableNumber: 0 })),
    named('PRC entries before the piece table', wordFile({ pieces: [{ text: 'with prc\r' }], prc: [4, 0, 20] })),
    named('empty body', plain('')),
    named('white space body and text box', wordFile({ pieces: [{ text: ' \r\r  box\r' }], ccp: { text: 3, txbx: 7 } })),
    named('text of 0x1f only', plain('\x1f')),
    named('many small pieces', wordFile({ pieces: Array.from({ length: 40 }, (_, i) => ({ text: `p${i}\r`, unicode: i % 3 === 0 })) })),
  ]
  const good = word({ pieces: [{ text: 'Hello world.\rSecond paragraph\r' }] })
  const goodFile = written([['/WordDocument', good.word], ['/1Table', good.table]])
  const broken = (label: string, edit: (word: Buffer, table: Buffer) => [Buffer, Buffer]): Input => {
    const [w, t] = edit(Buffer.from(good.word), Buffer.from(good.table))
    return named(label, written([['/WordDocument', w], ['/1Table', t]]))
  }
  inputs.push(
    broken('wrong magic number', w => [Object.assign(w, { 0: 0x12 }), Buffer.from(good.table)]),
    broken('WordDocument stream of one byte', () => [Buffer.from([0xec]), Buffer.from(good.table)]),
    broken('WordDocument stream cut after the magic', w => [w.subarray(0, 4), Buffer.from(good.table)]),
    broken('WordDocument stream cut in the FIB', w => [w.subarray(0, 0x60), Buffer.from(good.table)]),
    broken('WordDocument stream cut before the piece table fields', w => [w.subarray(0, 0x180), Buffer.from(good.table)]),
    broken('Table stream empty', w => [w, Buffer.alloc(0)]),
    broken('Table stream of three bytes', w => [w, Buffer.from([2, 0, 0])]),
    broken('flag of the piece table is not 2', (w, t) => [w, Object.assign(t, { 0: 5 })]),
    broken('piece table size zero', (w, t) => { t.writeUInt32LE(0, 1); return [w, t] }),
    broken('piece table size 4 (no pieces)', (w, t) => { t.writeUInt32LE(4, 1); return [w, t] }),
    broken('piece table size not a multiple of 12', (w, t) => { t.writeUInt32LE(30, 1); return [w, t] }),
    broken('piece table size 0xffffffff', (w, t) => { t.writeUInt32LE(0xffffffff, 1); return [w, t] }),
    broken('piece starts past the stream', (w, t) => { t.writeUInt32LE(0x3fffffff | 0x40000000, 5 + 8 + 2); return [w, t] }),
    broken('piece with a flag of the high bit', (w, t) => { t.writeUInt32LE(0xc0000400, 5 + 8 + 2); return [w, t] }),
    broken('piece end before its start', (w, t) => { t.writeUInt32LE(0, 5 + 4); t.writeUInt32LE(30, 5); return [w, t] }),
    broken('piece positions in the wrong order', (w, t) => { t.writeUInt32LE(100, 5); t.writeUInt32LE(2, 5 + 4); return [w, t] }),
    broken('ccpText larger than the text', w => { w.writeUInt32LE(5000, 0x4c); return [w, Buffer.from(good.table)] }),
    broken('ccpText 0xffffffff', w => { w.writeUInt32LE(0xffffffff, 0x4c); return [w, Buffer.from(good.table)] }),
    broken('ccpTxbx beyond the text', w => { w.writeUInt32LE(9, 0x4c); w.writeUInt32LE(100, 0x64); return [w, Buffer.from(good.table)] }),
    broken('lcbSttbfBkmk set over nothing', w => { w.writeUInt32LE(40, 0x146); w.writeUInt32LE(0, 0x142); return [w, Buffer.from(good.table)] }),
    broken('bookmark table with single byte marker', (w, t) => { w.writeUInt32LE(0, 0x142); w.writeUInt32LE(12, 0x146); t.writeUInt16LE(0x1234, 0); return [w, t] }),
    broken('bookmark table without positions', (w, t) => { t.writeUInt16LE(0xffff, 0); w.writeUInt32LE(0, 0x142); w.writeUInt32LE(8, 0x146); w.writeUInt32LE(0, 0x14e); return [w, t] }),
    broken('lcbPlcfhdd of 8 pointing past the table', w => { w.writeUInt32LE(0x7fffff, 0xf2); w.writeUInt32LE(8, 0xf6); return [w, Buffer.from(good.table)] }),
    broken('lcbPlcfhdd of 7 (header stories skipped)', w => { w.writeUInt32LE(7, 0xf6); return [w, Buffer.from(good.table)] }),
    broken('character property table over nothing', w => { w.writeUInt32LE(0, 0xfa); w.writeUInt32LE(20, 0xfe); return [w, Buffer.from(good.table)] }),
    broken('character property count not whole', w => { w.writeUInt32LE(0, 0xfa); w.writeUInt32LE(13, 0xfe); return [w, Buffer.from(good.table)] }),
    broken('paragraph property table over nothing', w => { w.writeUInt32LE(0, 0x102); w.writeUInt32LE(20, 0x106); return [w, Buffer.from(good.table)] }),
    broken('lcbPlcfbtePapx below 4', w => { w.writeUInt32LE(2, 0x106); return [w, Buffer.from(good.table)] }),
    broken('lcbPlcfbteChpx 0xffffffff', w => { w.writeUInt32LE(0xffffffff, 0xfe); return [w, Buffer.from(good.table)] }),
    broken('table stream chosen by the wrong flag', w => { w.writeUInt16LE(0, 0xa); return [w, Buffer.from(good.table)] }),
    broken('fcClx past the table', w => { w.writeUInt32LE(0x1000, 0x1a2); return [w, Buffer.from(good.table)] }),
    broken('fcClx at a PRC entry that never ends', w => [w, concat([Buffer.alloc(0), Buffer.from([1, 0, 0]).subarray(0, 1)])]),
  )
  // streams as word-extractor looks them up
  inputs.push(named('no Table stream', written([['/WordDocument', good.word]])))
  inputs.push(named('no WordDocument stream', written([['/1Table', good.table]])))
  inputs.push(named('streams in a storage are not found', written([['/Dir/WordDocument', good.word], ['/Dir/1Table', good.table]])))
  inputs.push(named('stream names in other letter case', written([['/worddocument', good.word], ['/1table', good.table]])))
  inputs.push(named('a storage named WordDocument', written([['/WordDocument/x', good.word], ['/1Table', good.table]])))
  inputs.push(named('an entry named __proto__ (stream)', written([['/__proto__', fill(40, 1)], ['/WordDocument', good.word], ['/1Table', good.table]])))
  inputs.push(named('a storage named __proto__', written([['/__proto__/x', fill(40, 1)], ['/WordDocument', good.word], ['/1Table', good.table]])))
  inputs.push(named('a storage named __proto__ inside another storage', written([['/Dir/__proto__/x', fill(40, 1)], ['/WordDocument', good.word], ['/1Table', good.table]])))
  inputs.push(named('streams named like Object.prototype members', written([['/constructor', fill(40, 1)], ['/toString', fill(40, 2)], ['/WordDocument', good.word], ['/1Table', good.table]])))
  inputs.push(named('streams as FAT streams and as mini streams', written([['/WordDocument', concat([good.word, Buffer.alloc(4100)])], ['/1Table', good.table]])))
  inputs.push(named('both Table streams, the flag chooses', written([['/WordDocument', good.word], ['/0Table', Buffer.alloc(40)], ['/1Table', good.table]])))
  inputs.push(named('the compound file of the sample', goodFile))
  inputs.push({ label: 'a file of 7.5 MB whose FAT is listed in DIFAT sectors', bytes: written([['/WordDocument', good.word], ['/1Table', good.table], ['/Padding', Buffer.alloc(7_500_000, 1)]]), mutate: false })
  // other containers
  inputs.push(named('not a compound file nor a zip', Buffer.from('plain text, not a document')))
  inputs.push(named('empty file', EMPTY))
  inputs.push(named('one byte', Buffer.from([0xd0])))
  inputs.push(named('two bytes of a compound file', Buffer.from([0xd0, 0xcf])))
  inputs.push(named('RTF text', Buffer.from('{\\rtf1\\ansi Hello}')))
  inputs.push(named('PK and nothing else', Buffer.from([0x50, 0x4b])))
  inputs.push(named('PK of an empty archive', buildZip([])))
  inputs.push(named('PK of a spanned archive marker', Buffer.from([0x50, 0x4b, 0x07, 0x08, 1, 2, 3, 4, 5])))
  inputs.push(named('PK with another signature', Buffer.from([0x50, 0x4b, 0x01, 0x02, 1, 2, 3, 4, 5])))
  return inputs
}

/* ---- Word 2007 packages handed to word-extractor ---- */

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml'
const types = (...entries: string[]): string => `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${entries.join('')}</Types>`
const override = (part: string, type: string): string => `<Override PartName="${part}" ContentType="${CT}.${type}+xml"/>`
const CONTENT_TYPES = types(
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
  '<Default Extension="xml" ContentType="application/xml"/>',
  override('/word/document.xml', 'document.main'),
  override('/word/footnotes.xml', 'footnotes'),
  override('/word/endnotes.xml', 'endnotes'),
  override('/word/comments.xml', 'comments'),
  override('/word/header1.xml', 'header'),
  override('/word/footer1.xml', 'footer'),
)
const root = (name: string, inner: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${name} xmlns:w="${W}">${inner}</w:${name}>`
const p = (...runs: string[]): string => `<w:p>${runs.join('')}</w:p>`
const r = (text: string): string => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`
const box = (...paragraphs: string[]): string => `<w:r><w:pict><v:textbox xmlns:v="urn:v"><w:txbxContent>${paragraphs.join('')}</w:txbxContent></v:textbox></w:pict></w:r>`
const documentXml = (body: string): string => root('document', `<w:body>${body}</w:body>`)

const docxOf = (parts: Record<string, string | Uint8Array>, method = 8): Uint8Array =>
  buildZip(Object.entries(parts).map(([name, data]) => ({ name, data, method })))
const packageOf = (body: string, extra: Record<string, string> = {}): Record<string, string> => ({
  '[Content_Types].xml': CONTENT_TYPES, 'word/document.xml': documentXml(body), ...extra,
})

function builtDocx(): Input[] {
  const inputs: Input[] = []
  const add = (label: string, bytes: Uint8Array): void => { inputs.push({ label, bytes, isolate: true, mutate: false }) }
  add('paragraphs, tabs and breaks', docxOf(packageOf(p(r('One'), '<w:r><w:tab/></w:r>', r('two'), '<w:r><w:br/></w:r>', r('three'), '<w:r><w:br w:type="page"/></w:r>') + p(r('Second paragraph')))))
  add('stored entries', docxOf(packageOf(p(r('stored text'))), 0))
  add('table with cells and rows', docxOf(packageOf('<w:tbl><w:tr><w:tc>' + p(r('a1')) + '</w:tc><w:tc>' + p(r('b1')) + '</w:tc></w:tr><w:tr><w:tc>' + p(r('a2')) + '</w:tc><w:tc><w:tbl><w:tr><w:tc>' + p(r('nested')) + '</w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>' + p(r('after'))))) 
  add('deleted text and field instructions', docxOf(packageOf(p(r('keep '), '<w:del><w:r><w:delText>gone</w:delText><w:t>deleted</w:t></w:r></w:del>', '<w:r><w:instrText> HYPERLINK "x" </w:instrText></w:r>', r(' shown')))))
  add('tabs element holds no text', docxOf(packageOf('<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>' + r('with a tab stop') + '</w:p>')))
  add('text boxes in the body', docxOf(packageOf(p(r('before'), box(p(r('box one')), p(r('box line two')))) + p(box(p(r('box two')))))))
  add('empty text box', docxOf(packageOf(p(box('')) + p(r('x')))))
  add('text box inside a drawing is dropped', docxOf(packageOf(p('<w:r><w:drawing><w:inline><w:txbxContent>' + p(r('inside drawing')) + '</w:txbxContent></w:inline></w:drawing></w:r>', r('x')))))
  add('text box in a cell and in a nested text box', docxOf(packageOf('<w:tbl><w:tr><w:tc>' + p(box(p(r('in cell box')))) + '</w:tc></w:tr></w:tbl>' + p(box(p(r('outer'), box(p(r('inner')))))))))
  add('footnotes, endnotes, comments, headers and footers', docxOf(packageOf(p(r('main text')), {
    'word/footnotes.xml': root('footnotes', '<w:footnote w:type="separator">' + p('<w:r><w:separator/></w:r>') + '</w:footnote><w:footnote w:id="1">' + p(r('a footnote')) + '</w:footnote>'),
    'word/endnotes.xml': root('endnotes', '<w:endnote w:id="1">' + p(r('an endnote')) + '</w:endnote>'),
    'word/comments.xml': root('comments', '<w:comment w:id="0">' + p(r('a comment')) + '</w:comment>'),
    'word/header1.xml': root('hdr', p(r('header text'), box(p(r('header box'))))),
    'word/footer1.xml': root('ftr', p(r('footer text'))),
  })))
  add('Default content type names the main part', docxOf({ '[Content_Types].xml': types(`<Default Extension="xml" ContentType="${CT}.document.main+xml"/>`), 'word/document.xml': documentXml(p(r('by default'))), 'x.txt': 'ignored' }))
  add('content types last in the archive', docxOf({ 'word/document.xml': documentXml(p(r('late types'))), '[Content_Types].xml': CONTENT_TYPES }))
  add('override part names with leading slashes', docxOf({ '[Content_Types].xml': types(override('///word/document.xml', 'document.main')), 'word/document.xml': documentXml(p(r('slashes'))) }))
  add('part listed twice, last wins and is read twice', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: documentXml(p(r('first'))), method: 8 }, { name: 'word/document.xml', data: documentXml(p(r('second'))), method: 8 }]))
  add('second document part replaces the body', docxOf(packageOf(p(r('main')), { 'word/header1.xml': root('document', p(r('as document'))) })))
  add('no document part', docxOf({ '[Content_Types].xml': CONTENT_TYPES }))
  add('no content types (Error)', docxOf({ 'word/document.xml': documentXml(p(r('x'))) }))
  add('content type unknown to the reader', docxOf({ '[Content_Types].xml': types('<Override PartName="/word/document.xml" ContentType="text/plain"/>'), 'word/document.xml': documentXml(p(r('x'))) }))
  add('inherited names as content types', docxOf({ '[Content_Types].xml': types('<Override PartName="/word/document.xml" ContentType="constructor"/><Default Extension="xml" ContentType="toString"/>'), 'word/document.xml': documentXml(p(r('x'))) }))
  add('override without a part name (TypeError message)', docxOf({ '[Content_Types].xml': types(`<Override ContentType="${CT}.document.main+xml"/>`), 'word/document.xml': documentXml(p(r('x'))) }))
  add('override without a content type', docxOf({ '[Content_Types].xml': types('<Override PartName="/word/document.xml"/>', '<Default Extension="xml"/>'), 'word/document.xml': documentXml(p(r('x'))) }))
  add('override named __proto__', docxOf({ '[Content_Types].xml': types(override('/__proto__', 'document.main'), override('/action', 'footers'), override('/word/document.xml', 'document.main')), 'word/document.xml': documentXml(p(r('x'))), 'action': documentXml(p(r('action part'))), 'type': documentXml(p(r('type part'))) }))
  add('parts with names of Object.prototype members', docxOf({ ...packageOf(p(r('main'))), constructor: documentXml(p(r('constructor part'))), toString: documentXml(p(r('toString part'))), __proto__x: 'x' }))
  add('part named __proto__', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: '__proto__', data: documentXml(p(r('proto part'))), method: 8 }]))
  add('default extension __proto__ and undefined', docxOf({ '[Content_Types].xml': types(`<Default Extension="__proto__" ContentType="${CT}.document.main+xml"/><Default ContentType="${CT}.document.main+xml"/>`), 'a.__proto__': documentXml(p(r('a'))), 'b.undefined': documentXml(p(r('b'))) }))
  add('file names without extension, dot files and trailing dots', docxOf({ ...packageOf(p(r('x'))), noext: documentXml(p(r('1'))), '.hidden': documentXml(p(r('2'))), 'trail.': documentXml(p(r('3'))), 'a.b.xml': documentXml(p(r('4'))), 'dir.d/file': documentXml(p(r('5'))) }))
  // text and the chunks of 4096 bytes the parser is fed
  for (const lead of [0, 1, 2]) {
    const pad = 4096 - 3 * 150 - 600
    const body = p(r('x'.repeat(0) + 'a'.repeat(pad + lead))) + p(r(`${korean.repeat(40)} \u{1f600} end`))
    add(`non-ASCII text across the 4096 byte boundary (offset ${lead})`, docxOf(packageOf(body)))
    add(`the same stored (offset ${lead})`, docxOf(packageOf(body), 0))
  }
  const big = Array.from({ length: 2500 }, (_, i) => p(r(`paragraph ${i} ${korean}`))).join('')
  add('a body of several 16 KiB zlib buffers', docxOf(packageOf(big)))
  add('a body of several 16 KiB buffers, stored', docxOf(packageOf(big), 0))
  add('a body over 64 KiB compressed', docxOf(packageOf(Array.from({ length: 6000 }, (_, i) => p(r(`${i}:${Math.imul(i, 2654435761) >>> 0} ${Math.imul(i, 40503) >>> 0}`))).join(''))))
  add('XML declaration, doctype, comments, CDATA, processing instruction', docxOf(packageOf('<!-- c --><?pi x?>' + p(r('a'), '<w:r><w:t><![CDATA[cdata text]]></w:t></w:r>', r('&amp;&lt;&#65;&#x42;')))))
  add('entities and CR LF in text', docxOf({ '[Content_Types].xml': CONTENT_TYPES, 'word/document.xml': '<w:document xmlns:w="' + W + '"><w:p><w:t>a\r\nb\rc&amp;d</w:t></w:p></w:document>' }))
  // XML the parser or the handlers refuse
  const xmlCase = (label: string, document: string): void => add(label, docxOf({ '[Content_Types].xml': CONTENT_TYPES, 'word/document.xml': document }))
  xmlCase('unclosed tag', `<w:document xmlns:w="${W}"><w:p>`)
  xmlCase('mismatched tags', `<w:document xmlns:w="${W}"><w:p></w:q></w:document>`)
  xmlCase('not XML', 'plain text')
  xmlCase('empty part', '')
  xmlCase('text after the root', `<w:document xmlns:w="${W}"/>tail`)
  xmlCase('two roots', `<w:document xmlns:w="${W}"/><w:document/>`)
  xmlCase('bad entity', `<w:document xmlns:w="${W}"><w:p><w:t>&bogus;</w:t></w:p></w:document>`)
  xmlCase('root that is not w:document (tab without context)', `<x><w:tab/></x>`)
  xmlCase('paragraph closed without a context', `<x><w:p/></x>`)
  xmlCase('cell closed without a context', `<x><w:tc/></x>`)
  xmlCase('row closed without a context', `<x><w:tr/></x>`)
  xmlCase('text in a root that is not w:document', `<x>text<w:tr/></x>`)
  xmlCase('text box closed without a context', `<x><w:txbxContent/></x>`)
  xmlCase('footnote opened without a context', `<x><w:footnote/></x>`)
  xmlCase('footnote with a type', `<w:document xmlns:w="${W}"><w:footnote w:type="content"><w:tab/><w:p/></w:footnote><w:tab/></w:document>`)
  xmlCase('footnote closed twice over the context', `<w:document xmlns:w="${W}"><w:footnote/></w:document>`)
  xmlCase('del and tabs and drawing unbalanced by the document end', `<w:document xmlns:w="${W}"><w:del><w:p/></w:del><w:tabs/><w:drawing/><w:tc><w:p/></w:tc></w:document>`)
  xmlCase('cell closes after the document emptied the context', `<w:document xmlns:w="${W}"><w:tc><w:tr/></w:tc><w:p/></w:document>`)
  xmlCase('text box inside a footnote', `<w:footnotes xmlns:w="${W}"><w:footnote><w:txbxContent><w:p/></w:txbxContent></w:footnote></w:footnotes>`)
  xmlCase('text box with its context consumed', `<w:document xmlns:w="${W}"><w:tc><w:txbxContent><w:tr/></w:txbxContent></w:tc></w:document>`)
  xmlCase('text box whose pieces were taken', `<w:document xmlns:w="${W}"><w:txbxContent><w:txbxContent><w:p/></w:txbxContent></w:txbxContent></w:document>`)
  xmlCase('textbox in a header', `<w:hdr xmlns:w="${W}"><w:p><w:txbxContent><w:p/></w:txbxContent></w:p></w:hdr>`)
  xmlCase('duplicate attributes', `<w:document xmlns:w="${W}" a="1" a="2"><w:p/></w:document>`)
  xmlCase('BOM and a doctype', `\ufeff<!DOCTYPE x [<!ENTITY a "b">]><w:document xmlns:w="${W}"/>`)
  add('a bad part after a good one: the first error wins', docxOf({ '[Content_Types].xml': CONTENT_TYPES, 'word/document.xml': documentXml(p(r('ok'))), 'word/footnotes.xml': '<broken', 'word/endnotes.xml': '<also broken' }))
  add('a bad content types part', docxOf({ '[Content_Types].xml': '<Types><Override', 'word/document.xml': documentXml(p(r('x'))) }))
  return inputs
}

/* ---- archives the zip reader of word-extractor refuses ---- */

/**
 * Whether the reader answers at all: a part whose inflated size is not the declared one never settles,
 * because yauzl's byte count error is raised on a stream whose `destroy` it replaced.
 */
async function answers(bytes: Uint8Array): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const silent = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 1500) })
  const done = docToText(bytes).then(() => true, () => true)
  return Promise.race([done, silent]).finally(() => clearTimeout(timer))
}

async function builtZips(): Promise<Input[]> {
  const inputs: Input[] = []
  const add = (label: string, bytes: Uint8Array): void => { inputs.push({ label, bytes, isolate: true, mutate: false }) }
  const doc = documentXml(p(r('the document text')))
  const ok = (extra: Partial<Parameters<typeof buildZip>[0][number]> = {}) => [
    { name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 },
    { name: 'word/document.xml', data: doc, method: 8, ...extra },
  ]
  const good = buildZip(ok())
  add('a valid two part archive', good)
  const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const patched = (bytes: Uint8Array, at: number, ...values: number[]): Uint8Array => { const out = bytes.slice(); values.forEach((value, k) => { out[at + k] = value }); return out }
  const endAt = good.length - 22
  // the end record
  add('end record cut off', good.subarray(0, good.length - 1))
  add('end record missing (junk in its place)', concat([good.subarray(0, endAt), Buffer.alloc(22, 1)]))
  add('end record comment longer than declared', buildZip(ok(), { trailer: Buffer.from('xx') }))
  add('end record comment declared, shorter present', buildZip(ok(), { comment: Buffer.from('abcd') }))
  add('end record of a second disk', buildZip(ok(), { diskNumber: 1 }))
  add('more entries counted than present', buildZip(ok(), { count: 3 }))
  add('fewer entries counted than present', buildZip(ok(), { count: 1 }))
  add('no entries counted', buildZip(ok(), { count: 0 }))
  add('central directory offset past the file', buildZip(ok(), { directoryOffset: 0x7fffffff }))
  add('central directory offset at the end record', buildZip(ok(), { directoryOffset: good.length - 22 }))
  add('central directory offset inside a local header', buildZip(ok(), { directoryOffset: 10 }))
  add('central directory offset 0xffffffff without zip64 records', buildZip(ok(), { directoryOffset: 0xffffffff }))
  add('entry count 0xffff without zip64 records', buildZip(ok(), { count: 0xffff }))
  // zip64
  const zip64 = (options: { signature?: number; locatorSignature?: number; count?: number; offset?: number } = {}) => buildZip(ok(), {
    count: 0xffff, directoryOffset: 0xffffffff,
    gap: (offset, length) => {
      const record = Buffer.alloc(56); record.writeUInt32LE(options.signature ?? 0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeBigUInt64LE(BigInt(options.count ?? 2), 24); record.writeBigUInt64LE(BigInt(options.count ?? 2), 32); record.writeBigUInt64LE(BigInt(length), 40); record.writeBigUInt64LE(BigInt(options.offset ?? offset), 48)
      const locator = Buffer.alloc(20); locator.writeUInt32LE(options.locatorSignature ?? 0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + length), 8); locator.writeUInt32LE(1, 16)
      return concat([record, locator])
    },
  })
  add('zip64 end records', zip64())
  add('zip64 end record with a bad signature', zip64({ signature: 1 }))
  add('zip64 locator with a bad signature', zip64({ locatorSignature: 1 }))
  add('zip64 directory offset past the file', zip64({ offset: 0x7fffffff }))
  add('zip64 entry count of one', zip64({ count: 1 }))
  // central directory entries
  const central = (bytes: Uint8Array, entry: number): number => { let at = view(bytes).getUint32(endAt + 16, true); for (let k = 0; k < entry; k++) at += 46 + view(bytes).getUint16(at + 28, true) + view(bytes).getUint16(at + 30, true) + view(bytes).getUint16(at + 32, true); return at }
  const second = central(good, 1)
  add('central header with a bad signature', patched(good, second, 0, 0, 0, 0))
  add('central directory offset 20 bytes before the end of the file (unexpected EOF)', buildZip(ok(), { directoryOffset: good.length - 20 }))
  add('strong encryption flag', buildZip(ok({ flags: 0x0840 })))
  add('encrypted flag on the document part', buildZip(ok({ flags: 0x0801 })))
  add('encrypted flag on a part nobody reads', buildZip([...ok(), { name: 'other.bin', data: 'x', method: 0, flags: 0x0801 }]))
  add('unsupported compression method', buildZip(ok({ method: 99 })))
  add('unsupported compression method on a part nobody reads', buildZip([...ok(), { name: 'other.bin', data: 'x', method: 99 }]))
  add('stored size mismatch (declared larger)', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: doc, method: 0, declaredSize: doc.length + 5 }]))
  add('stored size mismatch (compressed size smaller)', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: doc, method: 0, compressedSize: 10 }]))
  add('stored with the right sizes', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 0 }, { name: 'word/document.xml', data: doc, method: 0 }]))
  add('stored and encrypted flag with a size 12 larger', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: doc, method: 0, flags: 0x0801, declaredSize: doc.length - 12 }]))
  const extra = (...fields: Array<[number, Uint8Array]>): Uint8Array => concat(fields.map(([id, data]) => concat([le16(id), le16(data.length), data])))
  add('extra field longer than its buffer', buildZip(ok({ extra: Buffer.from([1, 0, 0xff, 0xff, 1, 2]) })))
  add('extra field of three bytes (ignored)', buildZip(ok({ extra: Buffer.from([1, 0, 0]) })))
  add('unknown extra fields', buildZip(ok({ extra: extra([0x9999, Buffer.from('abc')], [0x5455, Buffer.alloc(5)]) })))
  add('zip64 sizes declared without the extra field', buildZip(ok({ compressedSize: 0xffffffff })))
  add('zip64 extra field too short for sizes', buildZip(ok({ compressedSize: 0xffffffff, extra: extra([1, Buffer.alloc(4)]) })))
  const doc64 = deflateRawSync(Buffer.from(doc))
  const le64 = (value: number): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(value)); return b }
  add('zip64 extra field with both sizes', buildZip(ok({ compressedSize: 0xffffffff, declaredSize: 0xffffffff, payload: doc64, extra: extra([1, concat([le64(doc.length), le64(doc64.length)])]) })))
  add('zip64 extra field with the uncompressed size only', buildZip(ok({ declaredSize: 0xffffffff, payload: doc64, extra: extra([1, le64(doc.length)]) })))
  add('zip64 extra field with the offset of a local header', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8, localOffset: 0xffffffff, extra: extra([1, le64(0)]) }, { name: 'word/document.xml', data: doc, method: 8 }]))
  add('zip64 extra field with a wrong size', buildZip(ok({ compressedSize: 0xffffffff, declaredSize: 0xffffffff, payload: doc64, extra: extra([1, concat([le64(doc.length), le64(1 << 30)])]) })))
  const unicodePath = (name: string, crcOf: string, version = 1): Uint8Array => {
    const crc = Buffer.alloc(4); crc.writeUInt32LE(crc32Of(Buffer.from(crcOf)), 0)
    return extra([0x7075, concat([Buffer.from([version]), crc, Buffer.from(name)])])
  }
  add('Info-ZIP unicode path with the right crc', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/doc.xml', data: doc, method: 8, extra: unicodePath('word/document.xml', 'word/doc.xml') }]))
  add('Info-ZIP unicode path with the wrong crc', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: doc, method: 8, extra: unicodePath('word/other.xml', 'x') }]))
  add('Info-ZIP unicode path of another version', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: doc, method: 8, extra: unicodePath('word/other.xml', 'word/document.xml', 2) }]))
  add('Info-ZIP unicode path too short', buildZip(ok({ extra: extra([0x7075, Buffer.from([1, 2, 3])]) })))
  add('Info-ZIP unicode path that is invalid UTF-8', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: doc, method: 8, extra: extra([0x7075, concat([Buffer.from([1]), le32(crc32Of(Buffer.from('word/document.xml'))), Buffer.from([0xff, 0xfe, 0x80])])]) }]))
  // names
  add('backslashes in names become slashes', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word\\document.xml', data: doc, method: 8 }]))
  add('absolute name', buildZip([...ok(), { name: '/abs.xml', data: '<a/>', method: 8 }]))
  add('drive letter name', buildZip([...ok(), { name: 'C:evil.xml', data: '<a/>', method: 8 }]))
  add('name with ..', buildZip([...ok(), { name: 'a/../b.xml', data: '<a/>', method: 8 }]))
  add('name that is ..', buildZip([...ok(), { name: '..', data: '<a/>', method: 8 }]))
  add('name with dots that are not ..', buildZip([...ok(), { name: 'a/.../b.xml', data: '<a/>', method: 8 }]))
  add('names in cp437 (no UTF-8 flag)', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8, flags: 0 }, { name: Buffer.from([0x77, 0x6f, 0x72, 0x64, 0x2f, 0x84, 0x94, 0x81, 0xe1, 0xfe, 0x01, 0x1f, 0x7f, 0x80, 0xff]), data: '<a/>', method: 8, flags: 0 }, { name: 'word/document.xml', data: doc, method: 8, flags: 0 }]))
  add('names in UTF-8 with Korean and invalid bytes', buildZip([...ok(), { name: Buffer.from([...Buffer.from('word/\uc548\ub155'), 0xff, 0xc3]), data: '<a/>', method: 8 }]))
  add('empty name', buildZip([...ok(), { name: '', data: '<a/>', method: 8 }]))
  // local headers and data
  add('local header offset past the file (RangeError)', buildZip(ok({ localOffset: 0x7fffffff })))
  add('local header offset inside the data', buildZip(ok({ localOffset: 40 })))
  add('local header with a bad signature', patched(good, 0, 1, 2, 3, 4))
  add('local header name length beyond the data', (() => { const out = good.slice(); view(out).setUint16(26, 0xffff, true); return out })())
  add('local header extra length beyond the data', (() => { const out = good.slice(); view(out).setUint16(28, 0xffff, true); return out })())
  add('local header extra length shifts the data', (() => { const out = good.slice(); view(out).setUint16(28, 3, true); return out })())
  add('data overflows the file', buildZip(ok({ compressedSize: 0x100000 })))
  add('compressed size 0xfffffff0', buildZip(ok({ compressedSize: 0xfffffff0 })))
  add('prepended bytes without adjusting offsets', buildZip(ok(), { prepend: Buffer.from('JUNK') }))
  add('bytes between the directory and the end record', buildZip(ok(), { gap: Buffer.from('gap') }))
  add('empty deflate payload (unexpected end of file)', buildZip(ok({ payload: EMPTY })))
  add('empty stored part (no root element)', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: '', method: 0 }]))
  add('empty deflated part', buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: '', method: 8 }]))
  const bodyDeflated = deflateRawSync(Buffer.from(doc))
  const deflated = (payload: Uint8Array, declaredSize?: number) => buildZip(ok({ payload, declaredSize }))
  add('deflate: reserved block type', deflated(Buffer.from([0x07, 0, 0, 0])))
  add('deflate: stored block with bad lengths', deflated(Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00])))
  add('deflate: stored block cut short', deflated(Buffer.from([0x01, 0x05, 0x00, 0xfa, 0xff, 0x41])))
  add('deflate: fixed block with a bad distance', deflated(Buffer.from([0x4b, 0x4c, 0x4a, 0x4e, 0x4c, 0x4a, 0x06, 0xff, 0xff, 0xff])))
  add('deflate: dynamic block with bad code lengths', deflated(Buffer.from([0x05, 0xe0, 0x3d, 0x0a, 0x00, 0x00, 0x00, 0x00])))
  add('deflate: truncated stream', deflated(bodyDeflated.subarray(0, bodyDeflated.length >> 1)))
  add('deflate: truncated by one byte', deflated(bodyDeflated.subarray(0, bodyDeflated.length - 1)))
  add('deflate: trailing garbage after the stream', deflated(concat([bodyDeflated, Buffer.from('trailing garbage')])))
  for (let k = 0; k < bodyDeflated.length; k += 11) {
    const flipped = Buffer.from(bodyDeflated); flipped[k] ^= 0x41 + k
    const mutant = deflated(flipped)
    if (await answers(mutant)) add(`deflate: payload byte ${k} changed`, mutant)
  }
  const bigText = Array.from({ length: 4000 }, (_, i) => `<w:p><w:r><w:t>line ${i} ${Math.imul(i, 40503) >>> 0}</w:t></w:r></w:p>`).join('')
  const bigDoc = documentXml(bigText)
  const bigDeflated = deflateRawSync(Buffer.from(bigDoc))
  const big = (payload: Uint8Array, declaredSize: number = bigDoc.length) => buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: bigDoc, method: 8, payload, declaredSize }])
  add('a large part, truncated mid-stream', big(bigDeflated.subarray(0, bigDeflated.length >> 1)))
  for (const at of [40, 400, 3000, 20000]) {
    const flipped = Buffer.from(bigDeflated); flipped[Math.min(at, flipped.length - 1)] ^= 0x55
    const mutant = big(flipped)
    if (await answers(mutant)) add(`a large part, byte ${at} changed`, mutant)
  }
  const endChanged = big(concat([bigDeflated.subarray(0, bigDeflated.length - 4), Buffer.from([0xff, 0xff, 0xff, 0xff])]))
  if (await answers(endChanged)) add('a large part, the end of the stream changed', endChanged)
  const noise = Buffer.concat(Array.from({ length: 4000 }, (_, i) => createHash('sha256').update(`noise ${i}`).digest()))
  const noisyDoc = Buffer.concat([Buffer.from(`<w:document xmlns:w="${W}"><w:p><w:t>`), Buffer.from(noise.toString('base64')), Buffer.from('</w:t></w:p></w:document>')])
  const noisy = buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: noisyDoc, method: 8 }])
  add('a part over 64 KiB compressed', noisy)
  const noisyDeflated = deflateRawSync(noisyDoc)
  const cutNoisy = buildZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES, method: 8 }, { name: 'word/document.xml', data: noisyDoc, method: 8, payload: noisyDeflated.subarray(0, 66000) }])
  if (await answers(cutNoisy)) add('a part over 64 KiB compressed, cut in the second chunk', cutNoisy)
  return inputs
}
function crc32Of(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1 }
  return (crc ^ 0xffffffff) >>> 0
}

/* ---- the gate: every refusal of assertCompoundFile ---- */

const WORD = 'Word 97-2003'

function builtGate(): Input[] {
  const inputs: Input[] = []
  const add = (label: string, bytes: Uint8Array, type = WORD): void => { inputs.push({ label, bytes, args: { type } }) }
  const base = written([['/WordDocument', fill(5000, 1)], ['/1Table', fill(300, 2)], ['/Small', fill(100, 3)], ['/Store/Inner', fill(70, 4)], ['/Empty', EMPTY]])
  const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const edit = (bytes: Uint8Array, write: (view: DataView, bytes: Uint8Array) => void): Uint8Array => { const out = bytes.slice(); write(view(out), out); return out }
  add('a file cfb wrote', base)
  add('the same for a presentation', base, 'PowerPoint 97-2003')
  add('the same with an empty type', base, '')
  add('the same with a type of other characters', base, '\u00e9\u{1f600} \u0131')
  add('empty file', EMPTY)
  add('one byte of the signature', base.subarray(0, 1))
  add('wrong signature', edit(base, (_v, b) => { b[3] ^= 1 }))
  add('signature only', base.subarray(0, 8))
  add('signature and 100 bytes', base.subarray(0, 100))
  add('511 bytes', base.subarray(0, 511))
  add('header only (no sector)', base.subarray(0, 512))
  add('version 3 with sector shift 12', edit(base, v => v.setUint16(30, 12, true)))
  add('version 4 with sector shift 9', edit(base, v => v.setUint16(26, 4, true)))
  add('version 2', edit(base, v => v.setUint16(26, 2, true)))
  add('version 0', edit(base, v => v.setUint16(26, 0, true)))
  add('mini sector shift 7', edit(base, v => v.setUint16(32, 7, true)))
  add('mini stream cutoff 4097', edit(base, v => v.setUint32(56, 4097, true)))
  add('byte order mark not checked', edit(base, v => v.setUint16(28, 0x1234, true)))
  add('sector count not a multiple (cut short last sector)', base.subarray(0, base.length - 100))
  add('last sector of the file cut by one byte', base.subarray(0, base.length - 1))
  // the FAT sector list
  add('FAT list with a gap', edit(base, v => { v.setInt32(76 + 4, -1, true); v.setInt32(76 + 8, 0, true) }))
  add('FAT list names a sector past the file', edit(base, v => v.setInt32(76, 9999, true)))
  add('FAT list names the same sector twice', edit(base, v => { v.setInt32(76 + 4, v.getInt32(76, true), true); v.setInt32(44, 2, true) }))
  add('FAT list ended by a marker, then more', edit(base, v => { v.setInt32(76, -2, true); v.setInt32(76 + 4, 0, true) }))
  add('FAT sector count wrong', edit(base, v => v.setUint32(44, 5, true)))
  add('FAT sector count zero', edit(base, v => v.setUint32(44, 0, true)))
  add('no FAT sector at all', edit(base, v => { v.setUint32(44, 0, true); v.setInt32(76, -1, true) }))
  add('FAT list entry above 0x80000000', edit(base, v => v.setUint32(76, 0xfffffffd, true)))
  add('DIFAT start names a sector, none declared', edit(base, v => v.setUint32(68, 1, true)))
  add('DIFAT count declared, no chain', edit(base, v => v.setUint32(72, 1, true)))
  add('DIFAT chain that ends with a bad mark', edit(base, v => { v.setUint32(68, 1, true); v.setUint32(72, 1, true) }))
  // sectors of one table
  const fatTable = (entries: readonly number[], dir: Entry[], more: readonly Uint8Array[] = []): Uint8Array => compound({ dirStart: 1, headerFat: [0], sectors: [int32s(entries, 512), directory(dir), ...more] })
  const rootEntry = (child: number, start: number, size: number): Entry => ({ name: 'Root Entry', type: 5, child, start, size })
  add('a hand built file', fatTable([FATSECT, ENDOFCHAIN], [rootEntry(NOSTREAM, ENDOFCHAIN, 0)]))
  add('FAT entry pointing at itself', fatTable([FATSECT, ENDOFCHAIN, 2], [rootEntry(NOSTREAM, ENDOFCHAIN, 0)], [fill(512, 1)]))
  add('FAT two entries in a cycle', fatTable([FATSECT, ENDOFCHAIN, 3, 2], [rootEntry(NOSTREAM, ENDOFCHAIN, 0)], [fill(512, 1), fill(512, 2)]))
  add('FAT entry past the sectors', fatTable([FATSECT, ENDOFCHAIN, 99], [rootEntry(NOSTREAM, ENDOFCHAIN, 0)], [fill(512, 1)]))
  add('FAT entry that is a marker', fatTable([FATSECT, ENDOFCHAIN, DIFSECT, FATSECT], [rootEntry(NOSTREAM, ENDOFCHAIN, 0)], [fill(512, 1), fill(512, 2)]))
  add('directory chain missing', compound({ dirStart: ENDOFCHAIN, headerFat: [0], sectors: [int32s([FATSECT], 512)] }))
  add('directory start past the file', compound({ dirStart: 50, headerFat: [0], sectors: [int32s([FATSECT], 512)] }))
  add('directory start not covered by the FAT', compound({ dirStart: 1, headerFat: [0], sectors: [int32s([FATSECT], 512), directory([rootEntry(NOSTREAM, ENDOFCHAIN, 0)])] }))
  add('directory chain loops', compound({ dirStart: 1, headerFat: [0], sectors: [int32s([FATSECT, 1], 512), directory([rootEntry(NOSTREAM, ENDOFCHAIN, 0)])] }))
  add('directory chain of two sectors', compound({ dirStart: 1, headerFat: [0], sectors: [int32s([FATSECT, 2, ENDOFCHAIN], 512), directory([rootEntry(NOSTREAM, ENDOFCHAIN, 0)]), directory([])] }))
  add('directory sector cut by the end of the file', compound({ dirStart: 1, headerFat: [0], sectors: [int32s([FATSECT, ENDOFCHAIN], 512), directory([rootEntry(NOSTREAM, ENDOFCHAIN, 0)])], length: 512 * 2 + 300 }))
  add('first entry is not the root', fatTable([FATSECT, ENDOFCHAIN], [{ name: 'X', type: 1, start: 0, size: 0 }]))
  add('second root entry', fatTable([FATSECT, ENDOFCHAIN], [rootEntry(NOSTREAM, ENDOFCHAIN, 0), rootEntry(NOSTREAM, ENDOFCHAIN, 0)]))
  add('entry of an unknown type', fatTable([FATSECT, ENDOFCHAIN], [rootEntry(NOSTREAM, ENDOFCHAIN, 0), { name: 'Odd', type: 3, start: 0, size: 0 }]))
  add('entry of type 9', fatTable([FATSECT, ENDOFCHAIN], [rootEntry(NOSTREAM, ENDOFCHAIN, 0), { name: 'Odd', type: 9, start: 0, size: 0 }]))
  // streams against their chains
  const withStream = (size: number, start: number, entries: readonly number[], more: readonly Uint8Array[] = [], root: Entry = rootEntry(1, ENDOFCHAIN, 0)): Uint8Array =>
    compound({ dirStart: 1, headerFat: [0], sectors: [int32s(entries, 512), directory([root, { name: 'S', type: 2, start, size }]), ...more] })
  add('stream of one sector', withStream(500, 2, [FATSECT, ENDOFCHAIN, ENDOFCHAIN], [fill(512, 1)], rootEntry(1, ENDOFCHAIN, 0)).subarray(0, 512 * 4))
  add('big stream declaring more than its chain', withStream(5000, 2, [FATSECT, ENDOFCHAIN, ENDOFCHAIN], [fill(512, 1)]))
  add('big stream whose chain is long enough', withStream(1024 * 4, 2, [FATSECT, ENDOFCHAIN, 3, 4, 5, 6, 7, 8, 9, ENDOFCHAIN], Array.from({ length: 8 }, (_, k) => fill(512, k))))
  add('stream size larger than 2 GiB (version 3 reads 32 bits)', withStream(-1, 2, [FATSECT, ENDOFCHAIN, ENDOFCHAIN], [fill(512, 1)]))
  add('stream chain points past the file', withStream(5000, 77, [FATSECT, ENDOFCHAIN]))
  add('stream chain reaches a sector the FAT does not cover', compound({ dirStart: 1, headerFat: [0], sectors: [int32s([FATSECT, ENDOFCHAIN], 512), directory([rootEntry(1, ENDOFCHAIN, 0), { name: 'S', type: 2, start: 200, size: 5000 }]), ...Array.from({ length: 200 }, () => fill(512, 1))] }))
  add('stream claims the directory sector', withStream(5000, 1, [FATSECT, ENDOFCHAIN]))
  add('stream chain of zero length with a bad start', withStream(0, 9999, [FATSECT, ENDOFCHAIN]))
  add('mini stream: root declares bytes without a chain', withStream(10, 0, [FATSECT, ENDOFCHAIN], [], rootEntry(1, ENDOFCHAIN, 128)))
  add('mini stream: root chain longer', withStream(10, 0, [FATSECT, ENDOFCHAIN, ENDOFCHAIN], [fill(512, 1)], rootEntry(1, 2, 1000)))
  const miniFile = (streamStart: number, streamSize: number, miniTable: readonly number[], rootSize = 512, count = 1): Uint8Array => compound({
    dirStart: 1, miniFat: [3, count], headerFat: [0],
    sectors: [int32s([FATSECT, ENDOFCHAIN, ENDOFCHAIN, ENDOFCHAIN], 512), directory([rootEntry(1, 2, rootSize), { name: 'M', type: 2, start: streamStart, size: streamSize }]), fill(512, 1), int32s(miniTable, 512)],
  })
  add('mini stream of two mini sectors', miniFile(0, 100, [1, ENDOFCHAIN]))
  add('mini stream with one mini sector for 100 bytes', miniFile(0, 100, [ENDOFCHAIN]))
  add('mini stream sector past the mini stream', miniFile(20, 100, [1, ENDOFCHAIN]))
  add('mini FAT not covering a mini sector', compound({ dirStart: 1, miniFat: [3, 1], headerFat: [0], sectors: [int32s([FATSECT, ENDOFCHAIN, ENDOFCHAIN, ENDOFCHAIN], 512), directory([rootEntry(1, 2, 512), { name: 'M', type: 2, start: 0, size: 100 }]), fill(512, 1), int32s([1, ENDOFCHAIN], 512).subarray(0, 8)]}))
  add('mini stream sector used twice', compound({ dirStart: 1, miniFat: [3, 1], headerFat: [0], sectors: [int32s([FATSECT, ENDOFCHAIN, ENDOFCHAIN, ENDOFCHAIN], 512), directory([rootEntry(1, 2, 512), { name: 'M', type: 2, right: 2, start: 0, size: 100 }, { name: 'N', type: 2, start: 1, size: 100 }]), fill(512, 1), int32s([1, ENDOFCHAIN], 512)]}))
  add('mini FAT loop', miniFile(0, 100, [1, 0]))
  add('mini FAT entry past the mini stream', miniFile(0, 100, [60, ENDOFCHAIN]))
  add('mini FAT declared but with a bad start', compound({ dirStart: 1, miniFat: [50, 1], headerFat: [0], sectors: [int32s([FATSECT, ENDOFCHAIN], 512), directory([rootEntry(NOSTREAM, ENDOFCHAIN, 0)])] }))
  add('mini FAT start junk with a count of zero', compound({ dirStart: 1, miniFat: [50, 0], headerFat: [0], sectors: [int32s([FATSECT, ENDOFCHAIN], 512), directory([rootEntry(NOSTREAM, ENDOFCHAIN, 0)])] }))
  add('mini FAT chain cut by the end of the file', compound({ dirStart: 1, miniFat: [2, 1], headerFat: [0], sectors: [int32s([FATSECT, ENDOFCHAIN, ENDOFCHAIN], 512), directory([rootEntry(NOSTREAM, ENDOFCHAIN, 0)]), fill(512, 1)], length: 512 * 3 + 100 }))
  // the directory tree
  const tree = (...entries: Entry[]): Uint8Array => fatTable([FATSECT, ENDOFCHAIN], entries)
  const sibling = (index: number, type = 2): Entry => ({ name: `E${index}`, type, start: ENDOFCHAIN, size: 0 })
  add('root with a sibling', tree({ ...rootEntry(1, ENDOFCHAIN, 0), right: 2 }, sibling(1), sibling(2)))
  add('root with a left link', tree({ ...rootEntry(1, ENDOFCHAIN, 0), left: 2 }, sibling(1), sibling(2)))
  add('link to an entry that does not exist', tree(rootEntry(40, ENDOFCHAIN, 0), sibling(1)))
  add('link to entry 0xfffffffe', tree(rootEntry(-2, ENDOFCHAIN, 0), sibling(1)))
  add('entry reached twice', tree(rootEntry(1, ENDOFCHAIN, 0), { ...sibling(1), left: 2, right: 2 }, sibling(2)))
  add('entry linking to the root', tree(rootEntry(1, ENDOFCHAIN, 0), { ...sibling(1), left: 0 }))
  add('entry outside the tree that links into it', tree(rootEntry(1, ENDOFCHAIN, 0), sibling(1), { ...sibling(2), left: 1 }))
  add('unused entry filled with zeros (links to entry 0)', tree(rootEntry(1, ENDOFCHAIN, 0), sibling(1), { name: '', type: 0, left: 0, right: 0, child: 0, start: 0, size: 0 }))
  add('unused entry linking elsewhere', tree(rootEntry(1, ENDOFCHAIN, 0), sibling(1), { name: '', type: 0, left: 1, start: 0, size: 0 }))
  add('storage nested 64 deep', (() => { const entries: Entry[] = [rootEntry(1, ENDOFCHAIN, 0)]; for (let k = 1; k <= 64; k++) entries.push({ name: `S${k}`, type: 1, child: k < 64 ? k + 1 : NOSTREAM, start: 0, size: 0 }); return compound({ dirStart: 1, headerFat: [0], sectors: [int32s([FATSECT, ...Array.from({ length: 17 }, (_, k) => (k < 16 ? k + 2 : ENDOFCHAIN))], 512), ...Array.from({ length: 17 }, (_, k) => directory(entries.slice(k * 4, k * 4 + 4)))] }) })())
  add('storage nested 65 deep', (() => { const entries: Entry[] = [rootEntry(1, ENDOFCHAIN, 0)]; for (let k = 1; k <= 65; k++) entries.push({ name: `S${k}`, type: 1, child: k < 65 ? k + 1 : NOSTREAM, start: 0, size: 0 }); return compound({ dirStart: 1, headerFat: [0], sectors: [int32s([FATSECT, ...Array.from({ length: 17 }, (_, k) => (k < 16 ? k + 2 : ENDOFCHAIN))], 512), ...Array.from({ length: 17 }, (_, k) => directory(entries.slice(k * 4, k * 4 + 4)))] }) })())
  add('storage with child links as siblings (not deeper)', (() => { const entries: Entry[] = [rootEntry(1, ENDOFCHAIN, 0)]; for (let k = 1; k <= 70; k++) entries.push({ name: `S${k}`, type: 1, right: k < 70 ? k + 1 : NOSTREAM, start: 0, size: 0 }); return compound({ dirStart: 1, headerFat: [0], sectors: [int32s([FATSECT, ...Array.from({ length: 18 }, (_, k) => (k < 17 ? k + 2 : ENDOFCHAIN))], 512), ...Array.from({ length: 18 }, (_, k) => directory(entries.slice(k * 4, k * 4 + 4)))] }) })())
  // version 4
  const v4 = compound({ version: 4, dirStart: 1, headerFat: [0], sectors: [int32s([FATSECT, ENDOFCHAIN], 4096), directory([rootEntry(NOSTREAM, ENDOFCHAIN, 0)], 4096)] })
  add('version 4 file', v4)
  add('version 4 file with a size of 64 bits', edit(v4, v => v.setUint32(4096 * 2 + 124, 1, true)))
  add('version 4 file cut short', v4.subarray(0, 4096 * 2 - 10))
  // counts of directory entries
  const manyDirectory = (sectors: number): Uint8Array => {
    const fatSectors = Math.ceil((sectors + 8) / 128)
    const fat: number[] = []
    for (let k = 0; k < fatSectors; k++) fat.push(FATSECT)
    for (let k = 0; k < sectors; k++) fat.push(k < sectors - 1 ? fatSectors + k + 1 : ENDOFCHAIN)
    const fatTables = Array.from({ length: fatSectors }, (_, k) => int32s(fat.slice(k * 128, k * 128 + 128), 512))
    const dirs = Array.from({ length: sectors }, (_, k) => directory(k === 0 ? [rootEntry(NOSTREAM, ENDOFCHAIN, 0)] : []))
    return compound({ dirStart: fatSectors, headerFat: Array.from({ length: fatSectors }, (_, k) => k), sectors: [...fatTables, ...dirs] })
  }
  add('directory of 8192 sectors (32768 entries)', manyDirectory(8192))
  add('directory of 8193 sectors (over the limit)', manyDirectory(8193))
  // chains that run backwards, which cost cfb a copy each
  const backwards = (count: number): Uint8Array => {
    const fatSectors = Math.ceil((count + 3) / 128)
    const fat: number[] = Array.from({ length: fatSectors }, () => FATSECT)
    fat.push(ENDOFCHAIN) // the directory
    for (let k = fatSectors + 1; k < fatSectors + count; k++) fat.push(k === fatSectors + 1 ? ENDOFCHAIN : k - 1)
    const tables = Array.from({ length: fatSectors }, (_, k) => int32s(fat.slice(k * 128, k * 128 + 128), 512))
    return compound({ dirStart: fatSectors, headerFat: Array.from({ length: fatSectors }, (_, k) => k), sectors: [...tables, directory([rootEntry(NOSTREAM, ENDOFCHAIN, 0)]), ...Array.from({ length: count - 1 }, () => EMPTY)] })
  }
  add('chains running backwards, a few', backwards(100))
  add('chains running backwards, too many for the budget', backwards(1500))
  // DIFAT
  const manyFat = (fatCount: number): Uint8Array => {
    const difatSectors = Math.ceil((fatCount - 109) / 127)
    const fat: number[] = []
    for (let k = 0; k < fatCount; k++) fat.push(FATSECT)
    for (let k = 0; k < difatSectors; k++) fat.push(DIFSECT)
    fat.push(ENDOFCHAIN)
    const tables = Array.from({ length: fatCount }, (_, k) => int32s(fat.slice(k * 128, k * 128 + 128), 512))
    const difats = Array.from({ length: difatSectors }, (_, k) => difatSector(Array.from({ length: 127 }, (_, j) => (109 + k * 127 + j < fatCount ? 109 + k * 127 + j : ENDOFCHAIN)).filter(value => value !== ENDOFCHAIN), k < difatSectors - 1 ? fatCount + k + 1 : ENDOFCHAIN))
    return compound({ dirStart: fatCount + difatSectors, difat: [fatCount, difatSectors], headerFat: Array.from({ length: 109 }, (_, k) => k), fatCount, sectors: [...tables, ...difats, directory([rootEntry(NOSTREAM, ENDOFCHAIN, 0)])] })
  }
  add('a DIFAT chain of two sectors', manyFat(300))
  add('a DIFAT chain of one sector', manyFat(200))
  return inputs
}

function difatSector(locations: readonly number[], next: number): Uint8Array {
  return int32s([...locations, ...Array<number>(127 - locations.length).fill(FREESECT), next], 512)
}

const DEFAULT_TYPE = 'Word 97-2003'

export const SPECS: Spec[] = [
  { fn: 'pptToText', extensions: ['ppt'], isolate: true, built: builtPpt, call: ({ bytes = EMPTY }) => pptToText(bytes) },
  { fn: 'docToText', extensions: ['doc'], isolate: true, built: async () => [...builtDoc(), ...builtDocx(), ...(await builtZips())], call: ({ bytes = EMPTY }) => docToText(bytes) },
  // the gate itself, whose refusals the DamagedFileError of assertSoundCompoundFile hides
  { fn: 'assertCompoundFile', extensions: ['doc', 'ppt'], isolate: true, built: builtGate, call: ({ bytes = EMPTY }) => { assertCompoundFile(bytes); return null } },
  {
    fn: 'assertSoundCompoundFile', extensions: ['doc', 'ppt'], isolate: true, built: builtGate,
    call: ({ bytes = EMPTY, args }) => { assertSoundCompoundFile(bytes, String(args?.type ?? DEFAULT_TYPE)); return null },
  },
]
