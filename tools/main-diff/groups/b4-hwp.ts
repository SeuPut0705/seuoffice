/**
 * Group `b4-hwp`: atomic-write.ts, dialog-strings.ts, field-kinds.ts,
 * print-document.ts, save-as-formats.ts, save-fixes.ts, save-plan.ts,
 * section-tails.ts and tab-widths.ts of apps/hwp/src/main.
 *
 * Names are `<ts-file>.<export>`; the three files other apps have under the
 * same name (atomic-write, print-document, save-as-formats) are written
 * `hwp/<ts-file>.<export>`.
 *
 * Conventions (crates/main-core/src/calls/b4_hwp.rs reads the same ones):
 *
 * - bytes cross as lowercase hex. A function that answers bytes takes a last
 *   argument, 'exact' for the hex of the bytes or 'inflated' for what they
 *   hold (the streams of a compound file, the entries of a zip, each inflated),
 *   because a deflate stream is not the same bytes from Node's zlib and from
 *   zlib-rs. Files that are not deflated are compared 'exact';
 * - a number JSON cannot carry is the string 'NaN', 'Infinity', '-Infinity'
 *   or '-0';
 * - a Map crosses as its [key, value] entries;
 * - the print windows are fakes driven by a script of outcomes, and each call
 *   of one is one log line.
 *
 * The HWP 5 files are built here, record by record, in a compound file the
 * container library writes (as the module's own tests do from the engine's
 * export); the HWPX files are zips written by hand, so each entry's method,
 * flags and extra field are the case's own.
 */
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'
import * as CFB from 'cfb'
import { createRequire } from 'node:module'
import { hasOle2Signature } from '../../../packages/compound-file/src/index.ts'
import { atomicWriteFile } from '../../../apps/hwp/src/main/atomic-write.ts'
import { tm } from '../../../apps/hwp/src/main/dialog-strings.ts'
import type { DlgKey } from '../../../apps/hwp/src/main/dialog-strings.ts'
import { fieldKindsOf, restoreFieldKinds } from '../../../apps/hwp/src/main/field-kinds.ts'
import type { FieldKinds } from '../../../apps/hwp/src/main/field-kinds.ts'
import { openHwp, pathsOf } from '../../../apps/hwp/src/main/hwp5-file.ts'
import {
  badJob,
  imageFile,
  ownIds,
  printJobToPdf,
  printJobToPrinter,
  printableHtml,
  sideMm,
} from '../../../apps/hwp/src/main/print-document.ts'
import type { PrintWindow } from '../../../apps/hwp/src/main/print-document.ts'
import {
  saveAsDefaultPath,
  saveAsFilters,
  saveAsTarget,
} from '../../../apps/hwp/src/main/save-as-formats.ts'
import { applySaveFixes } from '../../../apps/hwp/src/main/save-fixes.ts'
import type { SaveBase } from '../../../apps/hwp/src/main/save-fixes.ts'
import {
  backupPathFor,
  bytesMatchFormat,
  needsBackup,
  withFormatExtension,
} from '../../../apps/hwp/src/main/save-plan.ts'
import { restoreSectionTails, sectionTailsOf } from '../../../apps/hwp/src/main/section-tails.ts'
import type { SectionTails } from '../../../apps/hwp/src/main/section-tails.ts'
import {
  MAX_NEW_TABS,
  hwpxMemoCountOf,
  newTabsOf,
  writeTabWidths,
} from '../../../apps/hwp/src/main/tab-widths.ts'
import type { MeasuredTab, TabSpot } from '../../../apps/hwp/src/main/tab-widths.ts'
import type { HwpFormat } from '../../../apps/hwp/src/shared/ipc.ts'
import type { Case, Group, TsContext } from '../types.ts'

/**
 * apps/hwp is CommonJS to the loader, so dialog-strings.ts reads the language from the CommonJS
 * copy of @seuoffice/i18n; an ES import here would set the language of another copy. The
 * language is set and read through the copy the module under test uses.
 */
const i18n = createRequire(import.meta.url)('@seuoffice/i18n') as {
  getRequestedLocale: () => string
  getUiLang: () => 'en' | 'ko'
  setUiLang: (lang: 'en' | 'ko', requested?: string) => void
}

const str = (a: unknown[], i: number): string => a[i] as string
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const unhex = (text: string): Buffer => Buffer.from(text, 'hex')
const orUndefined = <T>(value: T | null | undefined): T | undefined =>
  value === null ? undefined : value

const NUMBERS: Record<string, number> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
  '-0': -0,
}
const num = (value: unknown): number =>
  typeof value === 'string' ? (NUMBERS[value] as number) : (value as number)

const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))
const CONSTANT = 'a constant'

// ---------- bytes, as the answers show them ----------

const MAX_INFLATE = 64 * 1024 * 1024

/** the entries of a zip by its central directory: [name, method, inflated hex] */
function zipListing(zip: Buffer): unknown {
  try {
    let end = -1
    for (let at = zip.length - 22; at >= 0; at--) {
      if (zip.readUInt32LE(at) === 0x06054b50) {
        end = at
        break
      }
    }
    if (end < 0) return null
    const count = zip.readUInt16LE(end + 10)
    let at = zip.readUInt32LE(end + 16)
    const entries: unknown[] = []
    for (let n = 0; n < count; n++) {
      const method = zip.readUInt16LE(at + 10)
      const compressed = zip.readUInt32LE(at + 20)
      const nameLength = zip.readUInt16LE(at + 28)
      const extra = zip.readUInt16LE(at + 30)
      const comment = zip.readUInt16LE(at + 32)
      const local = zip.readUInt32LE(at + 42)
      const nameEnd = at + 46 + nameLength
      if (nameEnd > zip.length) return null
      const name = zip.toString('utf8', at + 46, nameEnd)
      const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
      if (dataAt + compressed > zip.length) return null
      const raw = zip.subarray(dataAt, dataAt + compressed)
      const content =
        method === 8 ? inflateRawSync(raw, { maxOutputLength: MAX_INFLATE }) : Buffer.from(raw)
      entries.push([name, method, content.toString('hex')])
      at += 46 + nameLength + extra + comment
    }
    return entries
  } catch {
    return null
  }
}

/** what a file holds: its streams or entries, inflated */
function normalized(bytes: Uint8Array): unknown {
  const buffer = Buffer.from(bytes)
  if (!hasOle2Signature(buffer)) return { zip: zipListing(buffer) }
  let opened: ReturnType<typeof openHwp>
  try {
    opened = openHwp(buffer)
  } catch {
    opened = null
  }
  if (!opened) return { hwp: null }
  const paths = pathsOf(opened)
  const root = paths[0] ?? ''
  const streams: unknown[] = []
  for (const path of paths) {
    if (path.endsWith('/')) continue
    const name = `/${path.slice(root.length)}`
    const raw = Buffer.from((CFB.find(opened.cfb, name)?.content ?? []) as Uint8Array)
    const body = name.startsWith('/BodyText/') || name === '/DocInfo'
    let shown: string | null
    if (opened.compressed && body) {
      try {
        shown = inflateRawSync(raw, { maxOutputLength: MAX_INFLATE }).toString('hex')
      } catch {
        shown = null
      }
    } else {
      shown = raw.toString('hex')
    }
    streams.push([name, shown])
  }
  return { hwp: { compressed: opened.compressed, streams } }
}

const bytesOut = (bytes: Uint8Array, mode: unknown): unknown =>
  mode === 'exact' ? hex(bytes) : normalized(bytes)

// ---------- HWP 5 files ----------

const PARA_HEADER = 66
const PARA_TEXT = 67
const PARA_CHAR_SHAPE = 68
const PARA_LINE_SEG = 69
const CTRL_HEADER = 71
const LIST_HEADER = 72
const MEMO_LIST = 93
const ID_MAPPINGS = 17
const FACE_NAME = 19
const BIN_DATA = 18
const CHAR_SHAPE = 21
const UNKNOWN_FIELD = 0x25756e6b
const TABLE_CONTROL = 0x74626c20
const EQUATION = 0x65716564

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0)
  return b
}
const pad = (n: number): Buffer => Buffer.alloc(n)
const chars = (text: string): Buffer => Buffer.from(text, 'utf16le')

/** One record: its header word (tag, level, size), a full size after it where the size is 0xfff or more. */
function rec(tag: number, level: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const big = payload.length >= 0xfff
  const word = (tag | (level << 10) | ((big ? 0xfff : payload.length) << 20)) >>> 0
  return Buffer.concat([u32(word), ...(big ? [u32(payload.length)] : []), payload])
}

/** A character that takes eight code units: the unit, twelve bytes, the unit again. */
const extended = (unit: number, data: Buffer): Buffer => Buffer.concat([u16(unit), data, u16(unit)])
/** A tab: its width, its kind and three words more; the engine writes them all zero. */
const tabChar = (width = 0, kind = 0, more = 0): Buffer =>
  extended(9, Buffer.concat([u32(width), u16(kind), u16(more), u16(0), u16(0)]))
const fieldBegin = (kind: number): Buffer => extended(3, Buffer.concat([u32(kind), pad(8)]))
const fieldEnd = (): Buffer => extended(4, pad(12))
const objectChar = (): Buffer => extended(11, pad(12))

/** A paragraph: its header, its text (the paragraph end closes it), then what hangs on it one level down. */
function para(level: number, text: Buffer, ...children: Buffer[]): Buffer {
  const header = Buffer.alloc(24)
  header.writeUInt32LE(((text.length >> 1) + 1) >>> 0, 0)
  return Buffer.concat([
    rec(PARA_HEADER, level, header),
    rec(PARA_TEXT, level + 1, Buffer.concat([text, chars('\r')])),
    ...children,
  ])
}

/** A paragraph without text, as the lists after the body hold them. */
function emptyPara(level: number): Buffer {
  const header = Buffer.alloc(24)
  header.writeUInt32LE(0x80000001, 0)
  return Buffer.concat([
    rec(PARA_HEADER, level, header),
    rec(PARA_CHAR_SHAPE, level + 1, pad(8)),
    rec(PARA_LINE_SEG, level + 1, pad(36)),
  ])
}

/** A table in a paragraph at `level`: the control, then one list header and its paragraphs per cell. */
function table(level: number, cells: Buffer[][]): Buffer {
  return Buffer.concat([
    rec(CTRL_HEADER, level + 1, Buffer.concat([u32(TABLE_CONTROL), pad(40)])),
    ...cells.flatMap((cell) => [rec(LIST_HEADER, level + 2, pad(34)), ...cell]),
  ])
}

/** A field's control: '%unk', then what tells this field from another. */
const fieldControl = (level: number, name: string): Buffer =>
  rec(CTRL_HEADER, level + 1, Buffer.concat([u32(UNKNOWN_FIELD), Buffer.from(name)]))

/** An equation's control, with its own instance bytes and, when `caption`, the list under it. */
function equation(level: number, instance: string, caption: boolean): Buffer {
  return Buffer.concat([
    rec(CTRL_HEADER, level + 1, Buffer.concat([u32(EQUATION), Buffer.from(instance)])),
    ...(caption ? [rec(LIST_HEADER, level + 2, pad(16)), emptyPara(level + 2)] : []),
  ])
}

/** A master page beyond the first: `kind` is what tells one from another. */
function masterPage(kind: number, paragraphs = 1): Buffer {
  const header = Buffer.alloc(34)
  header.writeUInt32LE(paragraphs, 0)
  header.writeUInt32LE(67180, 8)
  header.writeUInt32LE(51024, 12)
  header.writeUInt8(kind, 18)
  return Buffer.concat([
    rec(LIST_HEADER, 1, header),
    ...Array.from({ length: paragraphs }, () => emptyPara(1)),
  ])
}

function memo(number: number): Buffer {
  const header = Buffer.alloc(16)
  header.writeUInt32LE(1, 0)
  return Buffer.concat([rec(MEMO_LIST, 1, u32(number)), rec(LIST_HEADER, 1, header), emptyPara(1)])
}

/** DocInfo: the id mappings (the counts of fonts by language), the fonts, shapes and pictures they count. */
function docInfo(fonts: number[] = [2, 1, 0, 0, 0, 0, 0], shapes = 2, shapeTag = 'shape'): Buffer {
  return Buffer.concat([
    rec(16, 0, pad(26)),
    rec(ID_MAPPINGS, 0, Buffer.concat([u32(1), ...fonts.map(u32), pad(16)])),
    rec(BIN_DATA, 1, Buffer.from('bin1')),
    ...Array.from({ length: fonts.reduce((sum, n) => sum + n, 0) }, (_, i) =>
      rec(FACE_NAME, 1, Buffer.from(`font${i}`)),
    ),
    ...Array.from({ length: shapes }, (_, i) => rec(CHAR_SHAPE, 1, Buffer.from(`${shapeTag}${i}`))),
    rec(27, 1, Buffer.from('after the ids')),
  ])
}

function fileHeader(flags: number): Buffer {
  const header = Buffer.alloc(256)
  header.write('HWP Document File', 0, 'latin1')
  header.writeUInt32LE(0x05010000, 32)
  header.writeUInt32LE(flags, 36)
  return header
}

interface HwpOptions {
  /** the streams are deflated (and the header says so) */
  compressed?: boolean
  flags?: number
  header?: Buffer
  docInfo?: Buffer
  sections?: Buffer[]
  /** more streams, as they are written */
  streams?: Record<string, Buffer>
  /** a body stream the file holds as it is, whatever its header says */
  rawSections?: Record<number, Buffer>
}

/** A compound file the way the module reads one: FileHeader, DocInfo, BodyText/Section<n> and more. */
function hwp(options: HwpOptions = {}): Buffer {
  const compressed = options.compressed ?? false
  const pack = (data: Buffer): Buffer => (compressed ? deflateRawSync(data) : data)
  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(
    cfb,
    '/FileHeader',
    options.header ?? fileHeader((compressed ? 1 : 0) | (options.flags ?? 0)),
  )
  CFB.utils.cfb_add(cfb, '/DocInfo', pack(options.docInfo ?? docInfo()))
  ;(options.sections ?? [Buffer.alloc(0)]).forEach((section, index) => {
    CFB.utils.cfb_add(
      cfb,
      `/BodyText/Section${index}`,
      options.rawSections?.[index] ?? pack(section),
    )
  })
  for (const [path, data] of Object.entries(options.streams ?? {})) {
    CFB.utils.cfb_add(cfb, path, data)
  }
  return CFB.write(cfb, { type: 'buffer' }) as Buffer
}

/** Streams a real file carries beside the body: a small one, a nested one, a large one, and names with odd letters. */
const EXTRA_STREAMS: Record<string, Buffer> = {
  '/PrvText': chars('preview'),
  '/Scripts/DefaultJScript': Buffer.from('script'),
  '/BinData/BIN0001.png': Buffer.from('png bytes'),
  '/BinData/BIN0002.JPG': Buffer.alloc(5000, 7),
  '/BinData/B\u0130N0003.PNG': Buffer.from('dotted'),
  '/\u0005HwpSummaryInformation': Buffer.from('summary'),
}

// ---------- zips ----------

interface ZipSpec {
  name: string
  data: Buffer
  /** 8 deflated (the default), 0 stored; any other number is written as the method without its algorithm */
  method?: number
  flags?: number
  extra?: Buffer
  /** the bytes written as the entry's data, whatever its method says */
  rawData?: Buffer
}

/** A zip with the entries as the cases give them. A data descriptor follows an entry whose flags say so. */
function zip(entries: ZipSpec[], comment = ''): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const method = entry.method ?? 8
    const data = entry.rawData ?? (method === 8 ? deflateRawSync(entry.data) : entry.data)
    const name = Buffer.from(entry.name)
    const extra = entry.extra ?? Buffer.alloc(0)
    const flags = entry.flags ?? 0
    const crc = crc32(entry.data)
    const descriptor = (flags & 8) !== 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    if (!descriptor) {
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(data.length, 18)
      local.writeUInt32LE(entry.data.length, 22)
    }
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(extra.length, 28)
    const tail = descriptor
      ? Buffer.concat([u32(0x08074b50), u32(crc), u32(data.length), u32(entry.data.length)])
      : Buffer.alloc(0)
    locals.push(local, name, extra, data, tail)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(extra.length, 30)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name, extra)
    offset += local.length + name.length + extra.length + data.length + tail.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(Buffer.byteLength(comment), 20)
  return Buffer.concat([...locals, directory, end, Buffer.from(comment)])
}

/** The bytes with `bytes` written at `at` */
function patch(file: Buffer, at: number, ...bytes: number[]): Buffer {
  const copy = Buffer.from(file)
  bytes.forEach((byte, index) => {
    copy[at + index] = byte
  })
  return copy
}

/** The offset of the end-of-central-directory record */
const endOf = (file: Buffer): number => file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))

// ---------- documents with tabs ----------

/** A tab with values: width, left kind, none of the rest. */
const filledTab = (): Buffer => tabChar(4000, 0x0100 + 1, 0)

function tabsSection(extra = 0): Buffer {
  return Buffer.concat([
    // 0: one tab without values
    para(0, Buffer.concat([chars('\uc81c\ubaa9'), tabChar(), chars('3')])),
    // 1: a tab without values, then one with a width
    para(0, Buffer.concat([chars('a'), tabChar(), chars('b'), filledTab(), chars('c')])),
    // 2: a table: cell 0 with a tab, cell 1 with two paragraphs, the second holding a table of its own
    para(
      0,
      Buffer.concat([chars('t'), objectChar()]),
      table(0, [
        [para(2, Buffer.concat([chars('x'), tabChar()]))],
        [
          para(2, chars('no tabs')),
          para(
            2,
            Buffer.concat([tabChar(), chars('y'), objectChar()]),
            table(2, [[para(4, Buffer.concat([tabChar(), tabChar(1, 0)]))], []]),
          ),
        ],
      ]),
    ),
    // 3: two tables in one paragraph, other controls, a kind that counts as left
    para(
      0,
      Buffer.concat([
        extended(2, pad(12)),
        tabChar(0, 0x0100),
        extended(16, pad(12)),
        tabChar(0, 0, 1),
        tabChar(0, 2),
        chars('\ud83d\ude00'),
        tabChar(),
        objectChar(),
        objectChar(),
      ]),
      table(0, [[para(2, tabChar())]]),
      table(0, [[para(2, chars('b'))], [para(2, tabChar())]]),
    ),
    // 4: a character that takes eight units and is cut short: nothing is read past it
    Buffer.concat([
      rec(PARA_HEADER, 0, pad(24)),
      rec(PARA_TEXT, 1, Buffer.concat([chars('ab'), tabChar().subarray(0, 10)])),
    ]),
    // 5: a tab that is the last thing of its text: it ends where the text ends
    Buffer.concat([rec(PARA_HEADER, 0, pad(24)), rec(PARA_TEXT, 1, tabChar())]),
    ...Array.from({ length: extra }, () => para(0, Buffer.concat([tabChar(), chars('.')]))),
  ])
}

const section1 = (): Buffer =>
  Buffer.concat([
    para(0, Buffer.concat([tabChar(), tabChar()])),
    para(0, chars('plain')),
    para(0, Buffer.concat([chars('p'), tabChar()]), table(0, [[para(2, tabChar())]])),
  ])

const TABS_HWP = hwp({ sections: [tabsSection(), section1()], streams: EXTRA_STREAMS })
const TABS_HWP_DEFLATED = hwp({
  compressed: true,
  sections: [tabsSection(), section1()],
  streams: EXTRA_STREAMS,
})
const TABS_HWP_BIG = hwp({ sections: [tabsSection(60)] })
const TABS_HWP_MANY = hwp({
  sections: [para(0, Buffer.concat(Array.from({ length: MAX_NEW_TABS + 1 }, () => tabChar())))],
})
const TABS_HWP_NONE = hwp({ sections: [para(0, chars('no tabs here'))] })

// ---------- HWPX ----------

const NS =
  'xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"'
const secXml = (...body: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ${NS}>${body.join('')}</hs:sec>`
const tabEl = (width = 0, leader = 0, type = 1): string =>
  `<hp:tab width="${width}" leader="${leader}" type="${type}"/>`
const p = (...inner: string[]): string =>
  `<hp:p id="0" paraPrIDRef="1"><hp:run charPrIDRef="0"><hp:t>${inner.join('')}</hp:t></hp:run></hp:p>`
const cell = (...paras: string[]): string =>
  `<hp:tc><hp:subList>${paras.join('')}</hp:subList></hp:tc>`
const tbl = (...cells: string[]): string => `<hp:tbl><hp:tr>${cells.join('')}</hp:tr></hp:tbl>`
/** a paragraph that holds tables: its text, then the tables in its run */
const pt = (text: string, ...tables: string[]): string =>
  `<hp:p id="1"><hp:run><hp:t>${text}</hp:t>${tables.join('')}</hp:run></hp:p>`

const SECTION0 = secXml(
  p('\uc81c\ubaa9', tabEl(), '3'),
  p('a', tabEl(), 'b', tabEl(1500, 2, 3), 'c', tabEl()),
  pt(
    't',
    tbl(
      cell(p('x', tabEl())),
      cell(p('none'), pt('y', tbl(cell(p(tabEl(), tabEl(7)), p('z')), cell()))),
    ),
    tbl(cell(p(tabEl()))),
  ),
  // quirks: a tab in a comment, one with the width in single quotes, one with '>' in an attribute
  '<!-- <hp:tab width="0" leader="0" type="1"/> -->',
  p(
    "<hp:tab width='0' leader='0' type='1'/>",
    '<hp:tab width="0" note="a>b" leader="0" type="1"/>',
  ),
  '<hp:p id="9"><hp:run><hp:t>\ud83d\ude00 \u00fcn\u00ef<hp:tab width="0" leader="9" type="9"/></hp:t></hp:run></hp:p>',
  '<hp:p id="10"/>',
  '<hp:p id="11"><hp:tab width="0"/></hp:p>',
)
const SECTION1 = secXml(p(tabEl(), tabEl()), p('plain'))

const mimetype = (): ZipSpec => ({
  name: 'mimetype',
  data: Buffer.from('application/hwp+zip'),
  method: 0,
})
const header = (): ZipSpec => ({ name: 'Contents/header.xml', data: Buffer.from('<hh:head/>') })

const HWPX = zip([
  mimetype(),
  header(),
  { name: 'Contents/section0.xml', data: Buffer.from(SECTION0) },
  { name: 'Contents/section1.xml', data: Buffer.from(SECTION1) },
  { name: 'Contents/content.hpf', data: Buffer.from('<opf/>'), method: 0 },
])
const HWPX_STORED = zip([
  mimetype(),
  { name: 'Contents/section0.xml', data: Buffer.from(SECTION0), method: 0 },
  { name: 'Contents/section1.xml', data: Buffer.from(SECTION1), method: 0 },
])
const HWPX_ODD = zip(
  [
    mimetype(),
    // sections out of order by number, one with a descriptor and one with an extra field
    {
      name: 'Contents/section10.xml',
      data: Buffer.from(secXml(p(tabEl()))),
      flags: 8,
    },
    {
      name: 'Contents/section2.xml',
      data: Buffer.from(secXml(p(tabEl(), tabEl()))),
      extra: Buffer.from('xx'),
    },
    { name: 'Contents/section00.xml', data: Buffer.from(secXml(p(tabEl()))), method: 0 },
    {
      name: 'Contents/section0.xml',
      data: Buffer.from(secXml(p(tabEl(), 'k', tabEl()))),
      method: 0,
    },
    { name: 'Contents/section3.xml.bak', data: Buffer.from(secXml(p(tabEl()))), method: 0 },
    { name: 'Contents/Section4.xml', data: Buffer.from(secXml(p(tabEl()))), method: 0 },
  ],
  'a comment',
)

const HWPX_MEMOS = zip([
  mimetype(),
  {
    name: 'Contents/section0.xml',
    data: Buffer.from(
      secXml(
        '<hp:ctrl><hp:fieldBegin id="1" type="MEMO" name="m"/></hp:ctrl>',
        "<hp:ctrl><hp:fieldBegin type = 'MEMO'/></hp:ctrl>",
        '<hp:fieldBegin type="memo"/>',
        '<hp:fieldBegin datatype="MEMO"/>',
        '<hp:fieldBegin type="MEMO">',
        '<x a=">" type="MEMO">',
        '<hp:fieldBegin type="MEMOS"/>',
      ),
    ),
  },
  {
    name: 'Contents/section1.xml',
    data: Buffer.from(secXml('<hp:fieldBegin\ntype="MEMO"/>', '<hp:fieldBegin type="MEMO"/>')),
    method: 0,
  },
])
const HWPX_NO_MEMOS = zip([
  mimetype(),
  { name: 'Contents/section0.xml', data: Buffer.from(SECTION1) },
])

// ---------- the cases of a group of functions ----------

/** the spots of a file, then each one measured */
const spotsOf = (file: Buffer, format: HwpFormat): TabSpot[] => newTabsOf(file, format)
const measured = (
  spots: TabSpot[],
  width = 6000,
  type = 0,
  fill = 3,
): (TabSpot & { width: number; type: number; fill: number })[] =>
  spots.map((spot, index) => ({ ...spot, width: width + index, type, fill }))

// ---------- print-document ----------

const maskRand = (text: string): string =>
  text.replace(/\/ieum-hwp-print-[A-Za-z0-9]{6}/g, '/ieum-hwp-print-<rand>')
const maskTmp = (text: string): string => text.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')

/** the call, with the random part of a temp folder's name masked in what it throws */
async function masked<T>(run: () => T | Promise<T>, mask = maskRand): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof Error) error.message = mask(error.message)
    throw error
  }
}

interface WindowScript {
  createWindow?: 'throws'
  loadFile?: 'throws'
  printToPDF?: 'throws'
  pdfHex?: string
  destroyThrows?: boolean
  print?: 'throws' | { success: boolean; reason?: string }
}

/** the folder as the spec shows it: each file by name, print.html as text, the rest as hex */
function listing(dir: string): unknown[] {
  return readdirSync(dir)
    .sort()
    .map((name) => [
      name,
      name === 'print.html'
        ? readFileSync(join(dir, name), 'utf8')
        : readFileSync(join(dir, name)).toString('hex'),
    ])
}

async function printCall(
  a: unknown[],
  cx: TsContext,
  run: (job: never, create: () => PrintWindow) => Promise<unknown>,
): Promise<unknown> {
  const script = a[1] as WindowScript
  let workDir: string | undefined
  const window = {
    async loadFile(path: string) {
      workDir = dirname(path)
      cx.log('loadFile', maskRand(path), listing(workDir))
      if (script.loadFile === 'throws') throw new Error('load failed')
    },
    webContents: {
      async printToPDF(options: unknown) {
        cx.log('printToPDF', options)
        if (script.printToPDF === 'throws') throw new Error('printToPDF threw')
        return Buffer.from(script.pdfHex ?? '', 'hex')
      },
      print(options: unknown, callback: (success: boolean, reason: string) => void) {
        cx.log('print', options)
        if (script.print === 'throws') throw new Error('print threw')
        const outcome = script.print as { success: boolean; reason?: string } | undefined
        callback(outcome?.success ?? false, outcome?.reason ?? '')
      },
    },
    destroy() {
      cx.log('destroy')
      if (script.destroyThrows) throw new Error('destroy threw')
    },
  } as unknown as PrintWindow
  try {
    return await masked(() =>
      run(a[0] as never, () => {
        cx.log('createWindow')
        if (script.createWindow === 'throws') throw new Error('createWindow threw')
        return window
      }),
    )
  } finally {
    if (workDir) rmSync(workDir, { recursive: true, force: true })
  }
}

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const PAGE = (extra = ''): string => `<svg xmlns="http://www.w3.org/2000/svg" ${extra}></svg>`
const SVG_IDS =
  '<svg><defs><clipPath id="c1"><rect/></clipPath></defs><g clip-path="url(#c1)" id="g"><use href="#g"/><image href="ieum-image:0"/><image href="ieum-image:12"/></g></svg>'
const job = (pages: unknown[], images: unknown[] = [], mode: unknown = 'pdf'): unknown => ({
  mode,
  pages,
  images,
})
const page = (
  svg: unknown = PAGE(),
  width: unknown = 793.7,
  height: unknown = 1122.5,
): unknown => ({
  svg,
  width,
  height,
})

// ---------- dialog-strings ----------

const DLG_KEYS: DlgKey[] = [
  'dlgSaveTitle',
  'untitledFile',
  'dlgExportPdfTitle',
  'filterHwp',
  'filterHwpx',
  'filterPdf',
  'closeUnsavedMsg',
  'closeUnsavedDetail',
  'btnSave',
  'btnDontSave',
  'btnCancel',
  'closeMemoMsg',
  'closeMemoDetail',
  'btnDiscardClose',
  'dlgAddAttachment',
  'filterSupported',
  'filterAll',
  'errUnsupportedExt',
  'errNotFile',
  'errTooLarge',
  'errImageTooLarge',
  'errUnreadable',
  'errFileTooLarge',
  'errParseFailed',
  'errImageNoText',
  'errNotImage',
]

// ---------- field kinds ----------

const KIND_ME = 0x656d2525 // '%%me'
const KIND_D = 0x642a2525 // '%%*d'
const KIND_SIG = 0x676973 // 'sig'

/** the paragraphs of a document with fields; `written` is the kind each field's opening character holds */
function fieldSection(written: (name: string) => number, extra = 0): Buffer {
  const field = (name: string, kind: number): Buffer =>
    Buffer.concat([chars('a'), fieldBegin(kind), chars(name), fieldEnd(), chars('b')])
  return Buffer.concat([
    para(0, field('memo', written('memo')), fieldControl(0, 'memo')),
    // a table first: the field is the second control of the paragraph
    para(
      0,
      Buffer.concat([objectChar(), field('date', written('date'))]),
      table(0, [[para(2, chars('cell'))]]),
      fieldControl(0, 'date'),
    ),
    para(0, field('sig', written('sig')), fieldControl(0, 'sig')),
    // a field whose own kind is unknown
    para(0, field('none', UNKNOWN_FIELD), fieldControl(0, 'none')),
    // a field of another control id
    para(
      0,
      field('link', KIND_ME),
      rec(CTRL_HEADER, 1, Buffer.concat([u32(0x6b6c6824), Buffer.from('link')])),
    ),
    // a field character without a control record, and one with a control too short to name its id
    para(0, field('lost', KIND_D)),
    para(0, field('short', KIND_D), rec(CTRL_HEADER, 1, Buffer.from([1, 2]))),
    // a field character that is the last thing of its text
    Buffer.concat([
      rec(PARA_HEADER, 0, pad(24)),
      rec(PARA_TEXT, 1, fieldBegin(written('memo'))),
      fieldControl(0, 'edge'),
    ]),
    ...Array.from({ length: extra }, () => para(0, chars('filler text of a long section'))),
  ])
}

const KINDS: Record<string, number> = { memo: KIND_ME, date: KIND_D, sig: KIND_SIG }
const FIELDS_OPENED = hwp({ sections: [fieldSection((n) => KINDS[n] as number)] })
const FIELDS_ENGINE = hwp({ sections: [fieldSection(() => UNKNOWN_FIELD)] })
const FIELDS_OPENED_DEFLATED = hwp({
  compressed: true,
  sections: [fieldSection((n) => KINDS[n] as number), fieldSection((n) => KINDS[n] as number)],
})
const FIELDS_ENGINE_DEFLATED = hwp({
  compressed: true,
  sections: [fieldSection(() => UNKNOWN_FIELD), fieldSection(() => UNKNOWN_FIELD)],
})
const FIELDS_OPENED_BIG = hwp({ sections: [fieldSection((n) => KINDS[n] as number, 120)] })
const FIELDS_ENGINE_BIG = hwp({ sections: [fieldSection(() => UNKNOWN_FIELD, 120)] })
const FIELDS_NONE = hwp({ sections: [para(0, chars('no fields'))] })

const entriesOf = (kinds: FieldKinds | null): [string, number][] =>
  kinds ? [...kinds.entries()] : []
const KEPT = entriesOf(fieldKindsOf(FIELDS_OPENED))
const KEPT_TWO = entriesOf(fieldKindsOf(FIELDS_OPENED_DEFLATED))

// ---------- section tails ----------

const MEMO_COMMAND = (second: number, first = 0): Buffer => chars(`MEMO/${first}/${second}/`)

/** a body: text, then an equation (without or with its caption), memos anchored as given */
function tailSection(options: {
  caption?: 'none' | 'bare' | 'captioned'
  tails?: Buffer[]
  anchors?: Buffer[]
  eqLevel?: number
  more?: Buffer
}): Buffer {
  const equationFor = options.caption ?? 'none'
  const inTable = options.eqLevel === 3
  const eq = (level: number): Buffer => equation(level, 'eq-1', equationFor === 'captioned')
  return Buffer.concat([
    para(0, Buffer.concat([chars('body'), ...(options.anchors ?? []), chars('.')])),
    equationFor === 'none'
      ? para(0, chars('no equation'))
      : inTable
        ? para(0, Buffer.concat([objectChar()]), table(0, [[para(2, chars('in cell'), eq(2))]]))
        : para(0, Buffer.concat([chars('eq'), objectChar()]), eq(0)),
    ...(options.more ? [options.more] : []),
    ...(options.tails ?? []),
  ])
}

const TAIL_STREAMS: Record<string, Buffer> = {
  '/BinData/BIN0001.png': Buffer.from('png'),
  '/BinData/BIN0002.JPG': Buffer.alloc(4500, 3),
  '/BinData/B\u0130N0003.PNG': Buffer.from('dotted'),
}

const ORIGINAL_TAILS = [masterPage(4), masterPage(5, 2), memo(1), memo(2), memo(3)]
const tailsFile = (section: Buffer, options: HwpOptions = {}): Buffer =>
  hwp({ sections: [section], streams: TAIL_STREAMS, ...options })

const TAILS_OPENED = tailsFile(tailSection({ caption: 'captioned', tails: ORIGINAL_TAILS }))
const TAILS_OPENED_DEFLATED = tailsFile(
  tailSection({ caption: 'captioned', tails: ORIGINAL_TAILS }),
  { compressed: true },
)
const TAILS_OPENED_TABLE = tailsFile(
  tailSection({ caption: 'captioned', eqLevel: 3, tails: [masterPage(4)] }),
)
const TAILS_OPENED_TWO = hwp({
  sections: [
    tailSection({ caption: 'none', tails: [masterPage(4)] }),
    tailSection({ caption: 'none', tails: [memo(7), masterPage(8)] }),
  ],
  streams: TAIL_STREAMS,
})
const TAILS_OPENED_CAPTION_ONLY = tailsFile(tailSection({ caption: 'captioned' }))

const KEPT_TAILS = sectionTailsOf(TAILS_OPENED)
const KEPT_TAILS_DEFLATED = sectionTailsOf(TAILS_OPENED_DEFLATED)
const KEPT_TAILS_TABLE = sectionTailsOf(TAILS_OPENED_TABLE)
const KEPT_TAILS_TWO = sectionTailsOf(TAILS_OPENED_TWO)
const KEPT_CAPTION_ONLY = sectionTailsOf(TAILS_OPENED_CAPTION_ONLY)

const tailsJson = (tails: SectionTails | null): unknown =>
  tails === null
    ? null
    : {
        sections: tails.sections,
        tails: [...tails.tails.entries()].map(([index, lists]) => [
          index,
          lists.map((list) => ({
            key: list.key,
            bytes: hex(list.bytes),
            ...(list.memo === undefined ? {} : { memo: list.memo }),
          })),
        ]),
        ids: [...tails.ids.entries()],
        binData: tails.binData,
        captions: [...tails.captions.entries()].map(([digest, caption]) => [
          digest,
          { bytes: hex(caption.bytes), level: caption.level },
        ]),
      }

interface TailsJson {
  sections: number
  tails: [number, { key: string; bytes: string; memo?: number }[]][]
  ids: [string, string[]][]
  binData: string[]
  captions: [string, { bytes: string; level: number }][]
}

function tailsFrom(json: TailsJson): SectionTails {
  const tails: SectionTails['tails'] = new Map()
  for (const [index, lists] of json.tails) {
    tails.set(
      index,
      lists.map((list) => ({
        key: list.key,
        bytes: unhex(list.bytes),
        ...(list.memo === undefined ? {} : { memo: list.memo }),
      })),
    )
  }
  const captions: SectionTails['captions'] = new Map()
  for (const [digest, caption] of json.captions) {
    captions.set(digest, { bytes: unhex(caption.bytes), level: caption.level })
  }
  return {
    sections: json.sections,
    tails,
    ids: new Map(json.ids),
    binData: json.binData,
    captions,
  }
}

const KEPT_JSON = tailsJson(KEPT_TAILS) as TailsJson
const KEPT_JSON_DEFLATED = tailsJson(KEPT_TAILS_DEFLATED) as TailsJson
const KEPT_JSON_TABLE = tailsJson(KEPT_TAILS_TABLE) as TailsJson
const KEPT_JSON_TWO = tailsJson(KEPT_TAILS_TWO) as TailsJson
const KEPT_JSON_CAPTION = tailsJson(KEPT_CAPTION_ONLY) as TailsJson

/** what the engine writes: the body as it was, without the caption and without the lists after it */
const engineSection = (options: Parameters<typeof tailSection>[0] = {}): Buffer =>
  tailSection({ caption: 'bare', ...options })

const tailsCases = (): Case[] => {
  const withAnchors = [MEMO_COMMAND(1), MEMO_COMMAND(3, 12)]
  const rest = (kept: TailsJson, file: Buffer, mode = 'exact', note?: string): Case => ({
    args: [hex(file), kept, mode],
    ...(note ? { note } : {}),
  })
  return [
    rest(
      KEPT_JSON,
      tailsFile(engineSection({ anchors: withAnchors })),
      'exact',
      'lists and caption put back',
    ),
    rest(KEPT_JSON, tailsFile(engineSection({ anchors: [] })), 'exact', 'no memo has its field'),
    rest(
      KEPT_JSON,
      tailsFile(engineSection({ anchors: [MEMO_COMMAND(2), MEMO_COMMAND(99)] })),
      'exact',
      'only memo 2',
    ),
    rest(
      KEPT_JSON,
      tailsFile(
        tailSection({
          caption: 'captioned',
          tails: [masterPage(5, 3), memo(3)],
          anchors: withAnchors,
        }),
      ),
      'exact',
      'a list the engine wrote stays as it wrote it, the rest come back in the kept order',
    ),
    rest(KEPT_JSON, TAILS_OPENED, 'exact', 'nothing lacks: untouched'),
    rest(
      KEPT_JSON,
      tailsFile(engineSection({ anchors: withAnchors }), {
        docInfo: docInfo([2, 1, 0, 0, 0, 0, 0], 3),
      }),
      'exact',
      'a record added after the ids is fine',
    ),
    rest(
      KEPT_JSON,
      tailsFile(engineSection({ anchors: withAnchors }), {
        docInfo: docInfo([2, 1, 0, 0, 0, 0, 0], 2, 'moved'),
      }),
      'exact',
      'a shape is not where it was',
    ),
    rest(
      KEPT_JSON,
      tailsFile(engineSection({ anchors: withAnchors }), {
        docInfo: docInfo([1, 1, 0, 0, 0, 0, 0], 2),
      }),
      'exact',
      'a font fewer',
    ),
    rest(
      KEPT_JSON,
      tailsFile(engineSection({ anchors: withAnchors }), {
        docInfo: docInfo([2, 1, 0, 0, 0, 0, 0], 1),
      }),
      'exact',
      'a shape fewer',
    ),
    rest(
      KEPT_JSON,
      hwp({
        sections: [engineSection({ anchors: withAnchors })],
        streams: { '/BinData/BIN0001.png': Buffer.from('png') },
      }),
      'exact',
      'a picture is gone',
    ),
    rest(
      KEPT_JSON,
      hwp({
        sections: [engineSection({ anchors: withAnchors }), para(0, chars('second'))],
        streams: TAIL_STREAMS,
      }),
      'exact',
      'a section more',
    ),
    rest(
      { ...KEPT_JSON, sections: 2 },
      tailsFile(engineSection({ anchors: withAnchors })),
      'exact',
      'the kept file had two sections',
    ),
    rest(
      KEPT_JSON,
      hwp({
        sections: [Buffer.concat([para(0, chars('x')), rec(PARA_HEADER, 0, pad(24))])],
        streams: TAIL_STREAMS,
      }),
      'exact',
      'a body that ends in a paragraph of its own level',
    ),
    rest(
      KEPT_JSON,
      tailsFile(
        Buffer.concat([
          engineSection({ anchors: withAnchors }),
          rec(MEMO_LIST, 1, u32(9)),
          rec(30, 1),
        ]),
      ),
      'exact',
      'a memo list without its list header: the tail cannot be read',
    ),
    rest(
      KEPT_JSON,
      tailsFile(
        Buffer.concat([
          engineSection({ anchors: withAnchors }),
          rec(LIST_HEADER, 1, pad(34)),
          rec(50, 0),
        ]),
      ),
      'exact',
      'a tail with a record at level 0',
    ),
    rest(
      KEPT_JSON,
      tailsFile(
        Buffer.concat([
          engineSection({ anchors: withAnchors }),
          rec(30, 2, pad(4)),
          rec(LIST_HEADER, 2),
        ]),
      ),
      'exact',
      'a tail of another level',
    ),
    rest(
      KEPT_JSON,
      hwp({
        sections: [engineSection({ anchors: withAnchors }).subarray(0, 30)],
        streams: TAIL_STREAMS,
      }),
      'exact',
      'a section that is not a whole list of records',
    ),
    rest(
      KEPT_JSON,
      tailsFile(engineSection({ anchors: withAnchors }), { compressed: true }),
      'inflated',
      'deflated',
    ),
    rest(
      KEPT_JSON_DEFLATED,
      tailsFile(engineSection({ anchors: withAnchors }), { compressed: true }),
      'inflated',
      'deflated, kept from a deflated file',
    ),
    rest(
      KEPT_JSON,
      tailsFile(engineSection({ anchors: withAnchors }), {
        compressed: true,
        rawSections: { 0: Buffer.from('not deflate data') },
      }),
      'inflated',
      'a section that is not deflate data',
    ),
    {
      args: [hex(zip([mimetype()])), KEPT_JSON, 'exact'],
      note: 'a zip',
    },
    { args: ['', KEPT_JSON, 'exact'], note: 'empty' },
    {
      args: [
        hex(
          Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), pad(600)]),
        ),
        KEPT_JSON,
        'exact',
      ],
      note: 'a header the gate refuses',
    },
    rest(
      KEPT_JSON,
      hwp({ sections: [engineSection({ anchors: withAnchors })], flags: 2, streams: TAIL_STREAMS }),
      'exact',
      'encrypted',
    ),
    // equations
    rest(
      KEPT_JSON_CAPTION,
      tailsFile(tailSection({ caption: 'bare' })),
      'exact',
      'a caption alone, put back',
    ),
    rest(KEPT_JSON_CAPTION, TAILS_OPENED_CAPTION_ONLY, 'exact', 'a caption that is there'),
    rest(
      KEPT_JSON_CAPTION,
      tailsFile(tailSection({ caption: 'none' })),
      'exact',
      'no equation in the saved body',
    ),
    rest(
      KEPT_JSON_TABLE,
      tailsFile(tailSection({ caption: 'bare', eqLevel: 3 })),
      'exact',
      'the equation sits where it sat: the same levels',
    ),
    rest(
      KEPT_JSON_TABLE,
      tailsFile(tailSection({ caption: 'bare' })),
      'exact',
      'the equation moved out of its cell: the levels shift down',
    ),
    rest(
      KEPT_JSON,
      tailsFile(
        Buffer.concat([
          para(0, chars('x')),
          para(
            0,
            Buffer.concat([objectChar()]),
            table(0, [
              [para(2, chars('c'), table(2, [[para(4, chars('d'), equation(4, 'eq-1', false))]]))],
            ]),
          ),
          ...[masterPage(4)].slice(0, 0),
        ]),
      ),
      'exact',
      'the equation moved deeper: its caption goes two levels down',
    ),
    rest(
      KEPT_JSON_TWO,
      hwp({
        sections: [engineSection({}), engineSection({ anchors: [MEMO_COMMAND(7)] })],
        streams: TAIL_STREAMS,
      }),
      'exact',
      'two sections, memos kept from the second',
    ),
    rest(
      KEPT_JSON_TWO,
      hwp({
        sections: [
          tailSection({ caption: 'none', tails: [masterPage(4)] }),
          engineSection({ anchors: [MEMO_COMMAND(7)] }),
        ],
        streams: TAIL_STREAMS,
      }),
      'exact',
      'one of the two sections is whole',
    ),
    {
      args: [
        hex(tailsFile(engineSection({ anchors: withAnchors }))),
        { ...KEPT_JSON, tails: [], captions: [] },
        'exact',
      ],
      note: 'kept nothing: untouched',
    },
    rest(
      KEPT_JSON,
      tailsFile(
        engineSection({
          anchors: [
            chars('MEMO/1/1'),
            chars('MEMO/'),
            chars('MEMO/1/'),
            chars('MEMO/x/1/'),
            chars('MEMO/1/2'),
            chars('MEMO/1/1234567890123/'),
            chars('MEMO/1/12345678901234/'),
          ],
        }),
      ),
      'exact',
      'anchors that are not whole',
    ),
    rest(
      KEPT_JSON,
      tailsFile(
        Buffer.concat([
          engineSection({ anchors: withAnchors }),
          rec(CTRL_HEADER, 1022, Buffer.concat([u32(EQUATION), Buffer.from('eq-1')])),
        ]),
      ),
      'exact',
      'an equation so deep that its caption cannot be shifted to it',
    ),
  ]
}

export const group: Group = {
  // ---------- atomic-write ----------
  'hwp/atomic-write.atomicWriteFile': {
    ts: (a: unknown[]) => masked(() => atomicWriteFile(str(a, 0), Buffer.from(str(a, 1))), maskTmp),
    cases: [
      { args: ['$DIR/a.hwp', 'new'] },
      { args: ['$DIR/a.hwp', 'new'], files: { 'a.hwp': 'old' } },
      {
        args: ['$DIR/a.hwpx', ''],
        files: { 'a.hwpx': 'old' },
        note: 'an empty file replaces text',
      },
      { args: ['$DIR/\ud55c\uae00\u{1F600}.hwp', 'caf\u00e9'] },
      { args: ['$DIR/none/a.hwp', 'x'], note: 'no folder' },
      { args: ['$DIR/a.hwp', 'x'], files: { 'a.hwp': { dir: true } }, note: 'a folder as target' },
    ] as Case[],
  },

  // ---------- dialog-strings ----------
  'dialog-strings.tm': {
    ts: (a: unknown[]) => {
      const before = i18n.getUiLang()
      const requested = i18n.getRequestedLocale()
      i18n.setUiLang(str(a, 0) as 'en' | 'ko')
      try {
        return tm(
          str(a, 1) as DlgKey,
          orUndefined(a[2]) as Record<string, string | number> | undefined,
        )
      } finally {
        i18n.setUiLang(before, requested)
      }
    },
    cases: [
      ...(['en', 'ko'] as const).flatMap((lang) =>
        DLG_KEYS.map((key): Case => ({ args: [lang, key, null] })),
      ),
      ...cases(
        ['en', 'errUnsupportedExt', { ext: 'pdf' }],
        ['ko', 'errUnsupportedExt', { ext: '\u00fcn\u00ef\u{1F600}' }],
        ['en', 'errUnsupportedExt', {}],
        ['en', 'errUnsupportedExt', { ext: null }],
        ['en', 'errUnsupportedExt', { ext: 0 }],
        ['en', 'errUnsupportedExt', { other: 'x' }],
        ['en', 'errUnsupportedExt', { ext: '$&' }],
        ['en', 'errTooLarge', { mb: 5 }],
        ['ko', 'errTooLarge', { mb: 1.5 }],
        ['en', 'errTooLarge', { mb: 1e21 }],
        ['en', 'errTooLarge', { mb: -0 }],
        ['en', 'errTooLarge', { mb: '' }],
        ['ko', 'errTooLarge', null],
        ['en', 'btnSave', { ext: 'unused' }],
        ['en', 'noSuchKey', null],
        ['ko', 'noSuchKey', { a: 1 }],
        ['en', '', null],
      ),
    ],
  },

  // ---------- field-kinds ----------
  'field-kinds.fieldKindsOf': {
    ts: (a: unknown[]) => {
      const kinds = fieldKindsOf(unhex(str(a, 0)))
      return kinds === null ? null : [...kinds.entries()]
    },
    cases: [
      { args: [hex(FIELDS_OPENED)], note: 'three kept kinds' },
      { args: [hex(FIELDS_OPENED_DEFLATED)], note: 'deflated, two sections' },
      { args: [hex(FIELDS_OPENED_BIG)], note: 'a long section' },
      { args: [hex(FIELDS_ENGINE)], note: 'every kind unknown: none kept' },
      { args: [hex(FIELDS_NONE)], note: 'no fields' },
      {
        args: [
          hex(
            hwp({ sections: [fieldSection((n) => ({ memo: 5, date: 6, sig: 7 })[n] as number)] }),
          ),
        ],
        note: 'other kinds of the same fields',
      },
      {
        args: [hex(hwp({ sections: [para(0, chars('x')), fieldSection(() => KIND_SIG)] }))],
        note: 'the fields in the second paragraph on',
      },
      { args: [hex(hwp({ sections: [Buffer.alloc(0)] }))], note: 'an empty section' },
      {
        args: [hex(hwp({ sections: [fieldSection(() => KIND_ME)], flags: 2 }))],
        note: 'encrypted',
      },
      {
        args: [hex(hwp({ sections: [fieldSection(() => KIND_ME)], flags: 4 }))],
        note: 'a distribution copy',
      },
      {
        args: [
          hex(
            hwp({
              sections: [fieldSection(() => KIND_ME)],
              streams: { '/ViewText/Section0': Buffer.from('v') },
            }),
          ),
        ],
        note: 'a view copy of the body',
      },
      {
        args: [hex(hwp({ sections: [fieldSection(() => KIND_ME)], header: Buffer.alloc(30) }))],
        note: 'a header too short',
      },
      {
        args: [hex(hwp({ sections: [fieldSection(() => KIND_ME)], header: Buffer.alloc(256) }))],
        note: 'a header without the signature',
      },
      {
        args: [
          hex(
            hwp({
              compressed: true,
              sections: [Buffer.alloc(0)],
              rawSections: { 0: Buffer.from('xx') },
            }),
          ),
        ],
        note: 'a section that is not deflate data',
      },
      {
        args: [
          hex(hwp({ sections: [Buffer.concat([para(0, chars('a')), Buffer.from([1, 2, 3])])] })),
        ],
        note: 'a section that is not a whole list of records',
      },
      { args: [hex(zip([mimetype()]))], note: 'a zip' },
      { args: [''], note: 'empty' },
      { args: ['d0cf11e0a1b11ae1'], note: 'only the signature' },
    ] as Case[],
  },
  'field-kinds.restoreFieldKinds': {
    ts: (a: unknown[]) => {
      const result = restoreFieldKinds(unhex(str(a, 0)), new Map(a[1] as [string, number][]))
      return { bytes: bytesOut(result.bytes, a[2]), restored: result.restored }
    },
    cases: [
      { args: [hex(FIELDS_ENGINE), KEPT, 'exact'], note: 'three fields get their kinds' },
      { args: [hex(FIELDS_OPENED), KEPT, 'exact'], note: 'kinds that are there already' },
      { args: [hex(FIELDS_ENGINE), [], 'exact'], note: 'nothing kept' },
      { args: [hex(FIELDS_NONE), KEPT, 'exact'], note: 'no field in the file' },
      {
        args: [hex(FIELDS_ENGINE_BIG), entriesOf(fieldKindsOf(FIELDS_OPENED_BIG)), 'exact'],
        note: 'a long section (a stream of the big kind)',
      },
      { args: [hex(FIELDS_ENGINE_DEFLATED), KEPT_TWO, 'inflated'], note: 'deflated, two sections' },
      {
        args: [hex(FIELDS_ENGINE), [[KEPT[0]![0], 4294967295]], 'exact'],
        note: 'the largest kind',
      },
      { args: [hex(FIELDS_ENGINE), [[KEPT[0]![0], 0]], 'exact'], note: 'kind zero' },
      {
        args: [hex(FIELDS_ENGINE), [[KEPT[0]![0], -1]], 'exact'],
        note: 'a kind below zero: the write throws',
      },
      {
        args: [hex(FIELDS_ENGINE), [[KEPT[0]![0], 4294967296]], 'exact'],
        note: 'a kind above 32 bits',
      },
      { args: [hex(FIELDS_ENGINE), [[KEPT[0]![0], 1.5]], 'exact'], note: 'a fraction is cut' },
      {
        args: [
          hex(FIELDS_ENGINE),
          [
            [KEPT[0]![0], 2.9999],
            ['x', 1],
          ],
          'exact',
        ],
        note: 'an entry no field has',
      },
      {
        args: [
          hex(FIELDS_ENGINE),
          [
            [KEPT[0]![0], 7],
            [KEPT[0]![0], 9],
          ],
          'exact',
        ],
        note: 'a digest set again',
      },
      {
        args: [
          hex(hwp({ sections: [fieldSection(() => UNKNOWN_FIELD)], flags: 2 })),
          KEPT,
          'exact',
        ],
        note: 'encrypted',
      },
      {
        args: [
          hex(
            hwp({
              compressed: true,
              sections: [Buffer.alloc(0)],
              rawSections: { 0: Buffer.from('xx') },
            }),
          ),
          KEPT,
          'inflated',
        ],
        note: 'not deflate data',
      },
      { args: [hex(zip([mimetype()])), KEPT, 'exact'], note: 'a zip' },
      { args: ['', KEPT, 'exact'], note: 'empty' },
    ] as Case[],
  },

  // ---------- print-document ----------
  'hwp/print-document.sideMm': {
    ts: (a: unknown[]) => sideMm(num(a[0])),
    cases: cases(
      [793.7],
      [793.7008],
      [1122.52],
      [816],
      [1056],
      [793.5],
      [794],
      [(210.05 * 96) / 25.4],
      [(210.0500001 * 96) / 25.4],
      [(209.95 * 96) / 25.4],
      [(209.9499 * 96) / 25.4],
      [0],
      [-5],
      [1],
      [100.123456],
      [1e9],
      [1e21],
      [0.0001],
      ['NaN'],
      ['Infinity'],
      ['-Infinity'],
      ['-0'],
      [2.5],
      [38.0267],
    ),
  },
  'hwp/print-document.ownIds': {
    ts: (a: unknown[]) => ownIds(str(a, 0), str(a, 1)),
    cases: cases(
      [SVG_IDS, 'p0-'],
      [SVG_IDS, 'p12-'],
      [SVG_IDS, ''],
      [SVG_IDS, '$&'],
      [SVG_IDS, "$1$'$`"],
      ['', 'p-'],
      ['<g id="a" id="b" xid="c" data-id="d" ID="e"/>', 'q-'],
      ['<g id=""/><g id="x y"/><g id=\'single\'/>', 'q-'],
      ['<g fill="url(#a b)" stroke="url(#)" a="url(#x)url(#y)"/>', 'q-'],
      ['<use href="#a"/><use xlink:href="#b"/><use href="x#c"/><use href="#"/>', 'q-'],
      [
        '<g id="\u00fcn\u00ef\u{1F600}" fill="url(#\u{1F600})" href="#\u0131\u017F\u212A"/>',
        'p\u{1F600}-',
      ],
      ['<g id="a">id="b"</g>', 'z-'],
      ['<g\tid="a"\nhref="#a"/>', 'tab-'],
    ),
  },
  'hwp/print-document.imageFile': {
    ts: (a: unknown[]) => {
      const file = imageFile(str(a, 0), num(a[1]))
      return file === null ? null : { name: file.name, bytes: hex(file.bytes) }
    },
    cases: cases(
      [PNG, 0],
      ['data:image/jpeg;base64,/9j/4AAQ', 3],
      ['data:image/gif;base64,R0lGODlh', 1],
      ['data:image/bmp;base64,Qk0=', 2],
      ['data:image/webp;base64,UklGRg==', 4],
      ['data:image/svg+xml;base64,PHN2Zy8+', 5],
      ['data:image/png;base64,', 6],
      ['data:image/png;base64,iVBO\nRw0K Ggo=', 7],
      ['data:image/png;base64,iVBOR=w0KGgo=', 8],
      ['data:image/png;base64,iVB\u202fORw0K\u205fGgo=', 9],
      ['data:image/png;base64,\u00a0iVBORw0KGgo=\u3000', 10],
      ['data:image/png;base64,iVBORw0KGg', 11],
      ['data:image/png;base64,i', 12],
      ['data:image/png;base64,iVBORw0KGgo=\ufeff', 13],
      ['data:image/tiff;base64,AAAA', 0],
      ['data:image/png;charset=x;base64,AAAA', 0],
      ['data:image/PNG;base64,AAAA', 0],
      ['data:image/png;base64,AA-A', 0],
      ['data:image/png;base64,AA_A', 0],
      ['data:text/plain;base64,AAAA', 0],
      ['image/png;base64,AAAA', 0],
      [' data:image/png;base64,AAAA', 0],
      ['data:image/png;base64,AAAA ', 14],
      ['data:image/png;base64,AAAA\n', 15],
      ['data:image/png;base64,\u00fc', 0],
      ['data:image/constructor;base64,AAAA', 0],
      ['', 0],
      [PNG, 1.5],
      [PNG, -3],
      [PNG, 1e21],
      [PNG, 'NaN'],
      [PNG, '-0'],
    ),
  },
  'hwp/print-document.badJob': {
    ts: (a: unknown[]) => badJob(a[0]),
    cases: cases(
      [job([page()], [PNG])],
      [job([page()], [], 'print')],
      [job([page(), page('<svg/>', 1, 99999.9)])],
      [null],
      [0],
      [''],
      [false],
      [7],
      ['text'],
      [true],
      [[]],
      [[1, 2]],
      [{}],
      [job([page()], [], 'other')],
      [job([page()], [], null)],
      [job([page()], [], 'PDF')],
      [job([])],
      [{ mode: 'pdf', images: [] }],
      [{ mode: 'pdf', pages: 'x', images: [] }],
      [{ mode: 'pdf', pages: {}, images: [] }],
      [{ mode: 'pdf', pages: [page()] }],
      [{ mode: 'pdf', pages: [page()], images: 'x' }],
      [job([page()], [PNG, 5])],
      [job([page()], [PNG, null])],
      [job(Array.from({ length: 5000 }, () => page()))],
      [job(Array.from({ length: 5001 }, () => page()))],
      [job(Array.from({ length: 5001 }, () => 0))],
      [job([null])],
      [job([5])],
      [job(['<svg/>'])],
      [job([[page()]])],
      [job([{ width: 1, height: 1 }])],
      [job([page(5)])],
      [job([page('')])],
      [job([page('<svg')])],
      [job([page('<svg>')])],
      [job([page(' \n\t<svg/>')])],
      [job([page('\ufeff<svg/>')])],
      [job([page('\u00a0<svg/>')])],
      [job([page('\u0085<svg/>')])],
      [job([page('<SVG/>')])],
      [job([page('<svg/>', 0)])],
      [job([page('<svg/>', -1)])],
      [job([page('<svg/>', 100000)])],
      [job([page('<svg/>', 99999.99)])],
      [job([page('<svg/>', 1e-300)])],
      [job([page('<svg/>', '5')])],
      [job([page('<svg/>', null)])],
      [job([page('<svg/>', 5, 0)])],
      [job([page('<svg/>', 5, 'x')])],
      [job([page('<svg/>', 5, undefined)])],
      [job([{ svg: '<svg/>', width: 5 }])],
    ),
  },
  'hwp/print-document.printableHtml': {
    ts: (a: unknown[], cx: TsContext) =>
      printableHtml(
        (a[0] as { svg: string; width: unknown; height: unknown }[]).map((item) => ({
          svg: item.svg,
          width: num(item.width),
          height: num(item.height),
        })),
        (index) => {
          cx.log('picture', index)
          return `<${index}>`
        },
      ),
    cases: [
      { args: [[]], note: 'no page' },
      {
        args: [[{ svg: PAGE(), width: 793.7, height: 1122.52 }]],
        note: 'one A4 page',
      },
      {
        args: [
          [
            { svg: SVG_IDS, width: 816, height: 1056 },
            { svg: SVG_IDS, width: 420, height: 595.3 },
            { svg: '<svg/>', width: 1, height: 1e5 - 1 },
          ],
        ],
        note: 'three pages: Letter, a page of no paper side, an extreme one',
      },
      {
        args: [
          [
            {
              svg: '<svg><image href="ieum-image:007"/><image href="ieum-image:99999999999999999999"/><image href="ieum-image:1.5"/><image href="ieum-image:"/><image href=\'ieum-image:3\'/><image href="ieum-image:2"/></svg>',
              width: 100,
              height: 100,
            },
          ],
        ],
        note: 'the pictures of a page, by the number they are called with',
      },
      {
        args: [
          [
            {
              svg: `<svg>${'<image href="ieum-image:1' + '0'.repeat(400) + '"/>'}</svg>`,
              width: 'Infinity',
              height: 'NaN',
            },
          ],
        ],
        note: 'a number past a double, sides that are no number',
      },
      {
        args: [
          [{ svg: '<svg id="x">\u00fcn\u00ef\u{1F600}</svg>', width: 1122.52, height: 793.7 }],
        ],
        note: 'landscape, non-ASCII',
      },
      {
        args: [[{ svg: '<svg/>', width: 0, height: -3 }]],
        note: 'sides below one pixel',
      },
    ] as Case[],
  },
  'hwp/print-document.printJobToPdf': {
    ts: (a: unknown[], cx: TsContext) =>
      printCall(a, cx, async (jobArg, create) =>
        (await printJobToPdf(jobArg, create)).toString('hex'),
      ),
    cases: [
      { args: [job([page()]), { pdfHex: '255044462d' }], note: 'one page, no picture' },
      {
        args: [
          job(
            [page(SVG_IDS), page('<svg><image href="ieum-image:1"/></svg>')],
            [PNG, 'data:image/jpeg;base64,/9j/4AAQ', 'data:image/tiff;base64,AAAA'],
          ),
          { pdfHex: '00ff10' },
        ],
        note: 'pictures: two written as files, one left in the page',
      },
      {
        args: [
          job(
            [
              page(
                '<svg><image href="ieum-image:0"/><image href="ieum-image:1"/><image href="ieum-image:2"/></svg>',
              ),
            ],
            [
              'data:image/svg+xml;base64,PHN2Zy8+',
              'data:image/png;base64,iVB\u202fORw0K',
              'not a data url',
            ],
          ),
          { pdfHex: '' },
        ],
        note: 'a picture of each other kind, an empty pdf',
      },
      { args: [job([page()]), { createWindow: 'throws' }], note: 'the window cannot be made' },
      { args: [job([page()]), { loadFile: 'throws' }], note: 'the page does not load' },
      { args: [job([page()]), { printToPDF: 'throws' }], note: 'printing throws' },
      {
        args: [job([page()]), { destroyThrows: true }],
        note: 'destroy throws: the folder is left',
      },
      {
        args: [job([page()]), { loadFile: 'throws', destroyThrows: true }],
        note: 'the load fails and so does destroy',
      },
      {
        args: [job([page('<svg/>', 1, 2), page('<svg/>', 210, 297)]), { pdfHex: '00' }],
        note: 'sides',
      },
    ] as Case[],
  },
  'hwp/print-document.printJobToPrinter': {
    ts: (a: unknown[], cx: TsContext) =>
      printCall(a, cx, (jobArg, create) => printJobToPrinter(jobArg, create)),
    cases: [
      { args: [job([page()], [PNG], 'print'), { print: { success: true } }], note: 'sent' },
      {
        args: [job([page()], [], 'print'), { print: { success: false, reason: 'cancelled' } }],
        note: 'canceled',
      },
      {
        args: [
          job([page()], [], 'print'),
          { print: { success: false, reason: 'Print job CANCELED by the user' } },
        ],
        note: 'canceled, in capitals',
      },
      {
        args: [job([page()], [], 'print'), { print: { success: false, reason: 'failed' } }],
        note: 'failed',
      },
      {
        args: [job([page()], [], 'print'), { print: { success: false, reason: '' } }],
        note: 'failed without a reason',
      },
      { args: [job([page()], [], 'print'), { print: { success: false } }], note: 'no outcome' },
      {
        args: [job([page()], [], 'print'), { print: { success: true, reason: 'cancel' } }],
        note: 'sent with a reason',
      },
      { args: [job([page()], [], 'print'), { print: 'throws' }], note: 'print throws' },
      { args: [job([page()], [], 'print'), { createWindow: 'throws' }], note: 'no window' },
      {
        args: [job([page()], [], 'print'), { loadFile: 'throws', print: { success: true } }],
        note: 'no load',
      },
      {
        args: [job([page()], [], 'print'), { destroyThrows: true, print: { success: true } }],
        note: 'destroy throws',
      },
      {
        args: [
          job([page()], [], 'print'),
          { print: { success: false, reason: '\u212Ancel \u017F' } },
        ],
        note: 'letters that fold to cancel only with u',
      },
    ] as Case[],
  },

  // ---------- save-as-formats ----------
  'hwp/save-as-formats.saveAsFilters': {
    ts: (a: unknown[], cx: TsContext) =>
      saveAsFilters(str(a, 0) as HwpFormat, a[1] as boolean, (key) => {
        cx.log('label', key)
        return `L(${key})`
      }),
    cases: cases(['hwp', true], ['hwp', false], ['hwpx', true], ['hwpx', false]),
  },
  'hwp/save-as-formats.saveAsDefaultPath': {
    ts: (a: unknown[]) => saveAsDefaultPath(str(a, 0), a[1] as boolean),
    cases: cases(
      ['a.hwp', true],
      ['a.hwpx', true],
      ['a.HWP', true],
      ['a.HwPx', true],
      ['a.hwp', false],
      ['a.hwpx', false],
      ['a.txt', true],
      ['a.hwpxx', true],
      ['a.hwp.hwp', true],
      ['.hwp', true],
      ['hwp', true],
      ['', true],
      ['dir.hwp/name', true],
      ['\u00fcn\u00ef\u{1F600}.hwp', true],
      ['a.hwp\n', true],
      ['a.hwp ', true],
      ['\u0131.hwpx', true],
      ['a.\u212Awp', true],
      ['a.hw\u017F', true],
    ),
  },
  'hwp/save-as-formats.saveAsTarget': {
    ts: (a: unknown[]) => saveAsTarget(str(a, 0), str(a, 1) as HwpFormat, a[2] as boolean),
    cases: cases(
      ['/d/a.pdf', 'hwp', true],
      ['/d/a.PDF', 'hwpx', true],
      ['/d/a.pdf', 'hwp', false],
      ['/d/a.hwp', 'hwp', true],
      ['/d/a.hwpx', 'hwp', true],
      ['/d/a.HWPX', 'hwp', false],
      ['/d/a', 'hwp', true],
      ['/d/a', 'hwpx', false],
      ['/d/a.txt', 'hwpx', true],
      ['/d/a.pdf.hwp', 'hwpx', true],
      ['/d/a.hwp.pdf', 'hwpx', true],
      ['', 'hwp', true],
      ['', 'hwpx', false],
      ['/d/\u00fcn\u00ef\u{1F600}.pdf', 'hwp', true],
      ['/d/a.pdf\n', 'hwp', true],
      ['/d/a.pd\u017F', 'hwp', true],
    ),
  },

  // ---------- save-plan ----------
  'save-plan.backupPathFor': {
    ts: (a: unknown[]) => backupPathFor(str(a, 0)),
    cases: cases(['/d/a.hwp'], ['a'], [''], ['/d/\u00fcn\u00ef\u{1F600}.hwpx'], ['/d/a.bak']),
  },
  'save-plan.needsBackup': {
    ts: (a: unknown[]) => needsBackup(str(a, 0), a[1] as boolean, new Set(a[2] as string[])),
    cases: cases(
      ['/d/a.hwp', true, []],
      ['/d/a.hwp', false, []],
      ['/d/a.hwp', true, ['/d/a.hwp']],
      ['/d/a.hwp', false, ['/d/a.hwp']],
      ['/d/a.hwp', true, ['/d/b.hwp', '/d/A.hwp']],
      ['', true, ['']],
      ['\u00fc', true, ['u\u0308']],
    ),
  },
  'save-plan.bytesMatchFormat': {
    ts: (a: unknown[]) => bytesMatchFormat(unhex(str(a, 0)), str(a, 1) as HwpFormat),
    cases: cases(
      ['504b0304', 'hwpx'],
      ['504b030400', 'hwpx'],
      ['504b0304', 'hwp'],
      ['504b0305', 'hwpx'],
      ['504b03', 'hwpx'],
      ['d0cf11e0a1b11ae1', 'hwp'],
      ['d0cf11e0a1b11ae100ff', 'hwp'],
      ['d0cf11e0a1b11ae1', 'hwpx'],
      ['d0cf11e0a1b11ae0', 'hwp'],
      ['d0cf11e0a1b11a', 'hwp'],
      ['', 'hwp'],
      ['', 'hwpx'],
      ['00504b0304', 'hwpx'],
    ),
  },
  'save-plan.withFormatExtension': {
    ts: (a: unknown[]) => withFormatExtension(str(a, 0), str(a, 1) as HwpFormat),
    cases: cases(
      ['/d/a.hwp', 'hwpx'],
      ['/d/a.hwpx', 'hwp'],
      ['/d/a.HWP', 'hwpx'],
      ['/d/a.HwPx', 'hwp'],
      ['/d/a', 'hwp'],
      ['/d/a', 'hwpx'],
      ['/d/a.txt', 'hwp'],
      ['/d/a.hwpxx', 'hwp'],
      ['/d/a.hwp.txt', 'hwpx'],
      ['', 'hwp'],
      ['.hwp', 'hwpx'],
      ['/d/a.hwp\n', 'hwpx'],
      ['/d/\u00fcn\u00ef\u{1F600}', 'hwp'],
      ['/d/a.\u212Awp', 'hwp'],
    ),
  },

  // ---------- section-tails ----------
  'section-tails.sectionTailsOf': {
    ts: (a: unknown[]) => tailsJson(sectionTailsOf(unhex(str(a, 0)))),
    cases: [
      { args: [hex(TAILS_OPENED)], note: 'master pages, memos and a caption' },
      { args: [hex(TAILS_OPENED_DEFLATED)], note: 'deflated' },
      { args: [hex(TAILS_OPENED_TABLE)], note: 'an equation in a cell' },
      { args: [hex(TAILS_OPENED_TWO)], note: 'two sections' },
      { args: [hex(TAILS_OPENED_CAPTION_ONLY)], note: 'a caption alone' },
      { args: [hex(tailsFile(tailSection({ caption: 'bare' })))], note: 'nothing to keep' },
      {
        args: [hex(tailsFile(tailSection({ caption: 'bare', tails: [masterPage(4)] })))],
        note: 'a master page alone',
      },
      {
        args: [hex(tailsFile(tailSection({ caption: 'bare', tails: [memo(5), memo(5)] })))],
        note: 'a memo number twice',
      },
      {
        args: [
          hex(
            tailsFile(tailSection({ caption: 'bare', tails: [masterPage(4)] }), {
              docInfo: Buffer.alloc(0),
            }),
          ),
        ],
        note: 'no id mappings',
      },
      {
        args: [
          hex(
            tailsFile(tailSection({ caption: 'bare', tails: [masterPage(4)] }), {
              docInfo: Buffer.concat([rec(ID_MAPPINGS, 0, pad(8))]),
            }),
          ),
        ],
        note: 'id mappings too short',
      },
      {
        args: [
          hex(
            tailsFile(tailSection({ caption: 'bare', tails: [masterPage(4)] }), {
              docInfo: Buffer.concat([
                rec(ID_MAPPINGS, 0, pad(32)),
                rec(CHAR_SHAPE, 1, Buffer.from('s')),
              ]),
            }),
          ),
        ],
        note: 'id mappings just long enough, no font',
      },
      {
        args: [
          hex(
            tailsFile(tailSection({ caption: 'bare', tails: [masterPage(4)] }), {
              docInfo: Buffer.concat([
                rec(ID_MAPPINGS, 0, Buffer.concat([u32(0), u32(9999), pad(24)])),
              ]),
            }),
          ),
        ],
        note: 'a font count past the records',
      },
      {
        args: [
          hex(
            tailsFile(tailSection({ caption: 'bare', tails: [masterPage(4)] }), {
              docInfo: Buffer.concat([
                rec(ID_MAPPINGS, 0, Buffer.concat([u32(0), u32(0xffffffff), pad(24)])),
              ]),
            }),
          ),
        ],
        note: 'a negative font count',
      },
      {
        args: [
          hex(
            tailsFile(tailSection({ caption: 'bare', tails: [masterPage(4)] }), {
              docInfo: Buffer.concat([rec(ID_MAPPINGS, 0, pad(36)), rec(FACE_NAME, 1)]),
            }),
          ),
        ],
        note: 'a font more than the counts',
      },
      {
        args: [
          hex(
            tailsFile(tailSection({ caption: 'bare', tails: [masterPage(4)] }), {
              docInfo: docInfo([0, 0, 0, 0, 0, 0, 1]),
            }),
          ),
        ],
        note: 'a font of the last language',
      },
      {
        args: [
          hex(
            tailsFile(tailSection({ caption: 'bare', tails: [masterPage(4)] }), {
              docInfo: Buffer.concat([rec(ID_MAPPINGS, 0, pad(36)), rec(30, 5, pad(0xfff + 3))]),
            }),
          ),
        ],
        note: 'a record with a full size',
      },
      {
        args: [
          hex(
            tailsFile(tailSection({ caption: 'bare', tails: [masterPage(4)] }), {
              compressed: true,
              rawSections: { 0: Buffer.from('zz') },
            }),
          ),
        ],
        note: 'a section that is not deflate data',
      },
      {
        args: [
          hex(
            hwp({
              compressed: true,
              sections: [tailSection({ tails: [masterPage(4)] })],
              docInfo: Buffer.alloc(0),
              rawSections: {},
            }).subarray(0, 0),
          ),
        ],
        note: 'empty',
      },
      {
        args: [
          hex(
            tailsFile(
              Buffer.concat([
                para(0, chars('x')),
                rec(LIST_HEADER, 1, pad(34)),
                rec(PARA_HEADER, 0, pad(24)),
              ]),
            ),
          ),
        ],
        note: 'a record at level 0 after the lists',
      },
      {
        args: [hex(tailsFile(Buffer.concat([para(0, chars('x')), rec(MEMO_LIST, 1, u32(1))])))],
        note: 'a memo list without its list header',
      },
      {
        args: [
          hex(
            tailsFile(
              Buffer.concat([
                para(0, chars('x')),
                rec(MEMO_LIST, 1, Buffer.from([1, 2])),
                rec(LIST_HEADER, 1),
              ]),
            ),
          ),
        ],
        note: 'a memo list too short for its number',
      },
      {
        args: [hex(tailsFile(Buffer.concat([para(0, chars('x')), rec(80, 1)])))],
        note: 'a tail that is neither',
      },
      {
        args: [hex(tailsFile(Buffer.concat([rec(80, 1), rec(LIST_HEADER, 1)])))],
        note: 'no body paragraph',
      },
      {
        args: [
          hex(
            tailsFile(
              Buffer.concat([para(0, chars('x')), rec(LIST_HEADER, 1, pad(10)), masterPage(4)]),
            ),
          ),
        ],
        note: 'a master page header shorter than its kind',
      },
      {
        args: [hex(tailsFile(Buffer.concat([para(0, chars('x'), rec(30, 1)), masterPage(6, 0)])))],
        note: 'a page without paragraphs',
      },
      {
        args: [
          hex(
            hwp({
              sections: [
                tailSection({ caption: 'captioned', tails: [masterPage(4)] }),
                tailSection({ caption: 'captioned' }),
              ],
              streams: TAIL_STREAMS,
            }),
          ),
        ],
        note: 'the same caption in two sections',
      },
      {
        args: [
          hex(
            tailsFile(
              Buffer.concat([
                para(0, chars('x')),
                rec(CTRL_HEADER, 1, Buffer.from([1])),
                rec(CTRL_HEADER, 1, u32(EQUATION)),
                rec(LIST_HEADER, 2),
                rec(PARA_HEADER, 2, pad(24)),
                rec(30, 4),
                rec(CTRL_HEADER, 1, u32(EQUATION)),
                rec(LIST_HEADER, 1),
              ]),
            ),
          ),
        ],
        note: 'captions: short control, a list at another level',
      },
      {
        args: [
          hex(
            tailsFile(
              Buffer.concat([
                para(0, chars('x')),
                rec(CTRL_HEADER, 1, u32(EQUATION)),
                rec(LIST_HEADER, 2),
                rec(PARA_HEADER, 2, pad(24)),
              ]),
            ),
          ),
        ],
        note: 'a caption that ends with the section',
      },
      {
        args: [
          hex(
            tailsFile(tailSection({ caption: 'captioned', tails: [masterPage(4)] }), { flags: 4 }),
          ),
        ],
        note: 'a distribution copy',
      },
      { args: [hex(zip([mimetype()]))], note: 'a zip' },
      { args: [''], note: 'empty' },
    ] as Case[],
  },
  'section-tails.restoreSectionTails': {
    ts: (a: unknown[]) => {
      const result = restoreSectionTails(unhex(str(a, 0)), tailsFrom(a[1] as TailsJson))
      return {
        bytes: bytesOut(result.bytes, a[2]),
        restored: result.restored,
        ...(result.skipped === undefined ? {} : { skipped: result.skipped }),
      }
    },
    cases: tailsCases(),
  },

  // ---------- tab-widths ----------
  'tab-widths.MAX_NEW_TABS': { ts: () => MAX_NEW_TABS, cases: [{ args: [] }], single: CONSTANT },
  'tab-widths.hwpxMemoCountOf': {
    ts: (a: unknown[]) => hwpxMemoCountOf(unhex(str(a, 0))),
    cases: [
      { args: [hex(HWPX_MEMOS)], note: 'anchors in two sections, in the forms the regex takes' },
      { args: [hex(HWPX_NO_MEMOS)], note: 'none' },
      { args: [hex(HWPX)], note: 'sections with tabs and no memo' },
      { args: [hex(zip([mimetype()]))], note: 'a zip without a section' },
      { args: [hex(HWPX_ODD)], note: 'sections in odd places' },
      {
        args: [
          hex(
            zip([
              {
                name: 'Contents/section0.xml',
                data: Buffer.from('<a type="MEMO"><b type="MEMO"/>'),
                method: 9,
              },
            ]),
          ),
        ],
        note: 'a method this does not handle',
      },
      {
        args: [
          hex(
            zip([
              { name: 'Contents/section0.xml', data: Buffer.from('<a type="MEMO">'), flags: 1 },
            ]),
          ),
        ],
        note: 'an encrypted entry',
      },
      {
        args: [
          hex(
            zip([
              {
                name: 'Contents/section0.xml',
                data: Buffer.from('<a type="MEMO">'),
                rawData: Buffer.from('not deflate data'),
              },
            ]),
          ),
        ],
        note: 'a deflated entry that is not deflate data',
      },
      { args: [hex(HWPX_MEMOS.subarray(0, 100))], note: 'cut short' },
      { args: ['010203'], note: 'bytes that are no zip' },
      { args: [''], note: 'empty' },
      { args: [hex(TABS_HWP)], note: 'an HWP 5 file' },
    ] as Case[],
  },
  'tab-widths.newTabsOf': {
    ts: (a: unknown[]) => newTabsOf(unhex(str(a, 0)), str(a, 1) as HwpFormat),
    cases: [
      { args: [hex(TABS_HWP), 'hwp'], note: 'two sections, tables, cells in cells' },
      { args: [hex(TABS_HWP_DEFLATED), 'hwp'], note: 'deflated' },
      { args: [hex(TABS_HWP_BIG), 'hwp'], note: 'a long section' },
      { args: [hex(TABS_HWP_MANY), 'hwp'], note: 'more than the most a save measures' },
      { args: [hex(TABS_HWP_NONE), 'hwp'], note: 'no tab' },
      { args: [hex(HWPX), 'hwpx'], note: 'a hwpx: sections, tables, quirks' },
      { args: [hex(HWPX_STORED), 'hwpx'], note: 'stored entries' },
      {
        args: [hex(HWPX_ODD), 'hwpx'],
        note: 'sections out of order, a descriptor, an extra field, a comment',
      },
      { args: [hex(HWPX_NO_MEMOS), 'hwpx'], note: 'a section without empty tabs' },
      { args: [hex(HWPX), 'hwp'], note: 'a zip read as HWP 5' },
      { args: [hex(TABS_HWP), 'hwpx'], note: 'an HWP 5 file read as a zip' },
      { args: [hex(zip([mimetype()])), 'hwpx'], note: 'no section' },
      {
        args: [
          hex(zip([{ name: 'Contents/section0.xml', data: Buffer.from(SECTION1), method: 9 }])),
          'hwpx',
        ],
        note: 'a method this does not handle',
      },
      {
        args: [
          hex(zip([{ name: 'Contents/section0.xml', data: Buffer.from(SECTION1), flags: 1 }])),
          'hwpx',
        ],
        note: 'an encrypted entry',
      },
      {
        args: [
          hex(
            zip([{ name: 'Contents/section0.xml', data: Buffer.from(SECTION1) }], 'c'.repeat(300)),
          ),
          'hwpx',
        ],
        note: 'a long comment',
      },
      { args: [hex(patch(HWPX, endOf(HWPX) + 10, 0xff, 0xff)), 'hwpx'], note: 'a zip64 count' },
      {
        args: [hex(patch(HWPX, endOf(HWPX) + 16, 0xff, 0xff, 0xff, 0xff)), 'hwpx'],
        note: 'a zip64 offset',
      },
      { args: [hex(patch(HWPX, endOf(HWPX) + 4, 1)), 'hwpx'], note: 'another disk' },
      {
        args: [hex(patch(HWPX, endOf(HWPX) + 12, 0xff, 0xff, 0xff, 0x7f)), 'hwpx'],
        note: 'a directory that does not fit',
      },
      {
        args: [hex(patch(HWPX, endOf(HWPX) + 16, 5)), 'hwpx'],
        note: 'a directory that starts early',
      },
      { args: [hex(HWPX.subarray(0, HWPX.length - 5)), 'hwpx'], note: 'no end record' },
      { args: [hex(HWPX.subarray(0, 10)), 'hwpx'], note: 'cut short' },
      { args: [hex(patch(HWPX, 0, 0)), 'hwpx'], note: 'a local header that is none' },
      {
        args: [
          hex(
            zip([
              {
                name: 'Contents/section0.xml',
                data: Buffer.from(SECTION1),
                rawData: Buffer.from('not deflate data'),
              },
            ]),
          ),
          'hwpx',
        ],
        note: 'a section that is not deflate data',
      },
      { args: ['010203', 'hwp'], note: 'three bytes' },
      { args: ['010203', 'hwpx'], note: 'three bytes' },
      { args: ['', 'hwp'], note: 'empty' },
      { args: ['', 'hwpx'], note: 'empty' },
    ] as Case[],
  },
  'tab-widths.writeTabWidths': {
    ts: (a: unknown[]) => {
      const result = writeTabWidths(unhex(str(a, 0)), str(a, 1) as HwpFormat, a[2] as MeasuredTab[])
      return { bytes: bytesOut(result.bytes, a[3]), written: result.written }
    },
    cases: writeCases(),
  },

  // ---------- save-fixes ----------
  'save-fixes.applySaveFixes': {
    ts: (a: unknown[]) => {
      const base = a[3] as { tails: TailsJson | null; kinds: [string, number][] | null }
      const given: SaveBase = {
        tails: base.tails === null ? undefined : tailsFrom(base.tails),
        kinds: base.kinds === null ? undefined : new Map(base.kinds),
      }
      const result = applySaveFixes(
        unhex(str(a, 0)),
        str(a, 1) as HwpFormat,
        a[2] === null ? undefined : (a[2] as MeasuredTab[]),
        given,
      )
      return {
        bytes: bytesOut(result.bytes, a[4]),
        ...(result.tailsSkipped === undefined ? {} : { tailsSkipped: result.tailsSkipped }),
      }
    },
    cases: saveFixCases(),
  },
}

function writeCases(): Case[] {
  const spots = spotsOf(TABS_HWP, 'hwp')
  const deflatedSpots = spotsOf(TABS_HWP_DEFLATED, 'hwp')
  const hwpxSpots = spotsOf(HWPX, 'hwpx')
  const storedSpots = spotsOf(HWPX_STORED, 'hwpx')
  const oddSpots = spotsOf(HWPX_ODD, 'hwpx')
  const one = (spot: TabSpot, extra: Record<string, unknown> = {}): unknown[] => [
    { ...spot, width: 6000, type: 0, fill: 3, ...extra },
  ]
  const file = hex(TABS_HWP)
  const first = spots[0] as TabSpot
  const hwpCase = (measures: unknown, note: string, mode = 'exact', data = file): Case => ({
    args: [data, 'hwp', measures, mode],
    note,
  })
  const hwpxCase = (measures: unknown, note: string, data = HWPX_STORED, mode = 'exact'): Case => ({
    args: [hex(data), 'hwpx', measures, mode],
    note,
  })
  return [
    hwpCase(measured(spots), 'every spot, kind left'),
    hwpCase(measured(spots, 2000, 3, 255), 'every spot, the last kind and leader'),
    hwpCase(measured(spots, 1, 1, 0), 'every spot, kind right, no leader'),
    hwpCase(measured(spots, 2147483647 - spots.length + 1, 2, 7), 'the widest widths'),
    hwpCase(measured(spots.slice(0, 1)), 'one spot'),
    hwpCase(measured(spots.slice(2, 4)), 'two spots in the middle'),
    hwpCase(
      [...measured(spots.slice(0, 1)), ...measured(spots.slice(0, 1), 9, 1, 1)],
      'a spot measured twice: written once',
    ),
    hwpCase(measured(deflatedSpots), 'deflated', 'inflated', hex(TABS_HWP_DEFLATED)),
    hwpCase(measured(spotsOf(TABS_HWP_BIG, 'hwp')), 'a long section', 'exact', hex(TABS_HWP_BIG)),
    hwpCase([], 'nothing measured'),
    hwpCase(one(first, { tabs: first.tabs + 1 }), 'a tab count that does not match'),
    hwpCase(one(first, { tabs: String(first.tabs) }), 'a tab count that is a string'),
    hwpCase(one(first, { tabs: null }), 'a tab count that is null'),
    hwpCase(one(first, { width: 0 }), 'width zero'),
    hwpCase(one(first, { width: -5 }), 'a negative width'),
    hwpCase(one(first, { width: 1.5 }), 'a fraction as width'),
    hwpCase(one(first, { width: 2147483648 }), 'a width past the most'),
    hwpCase(one(first, { width: 2147483647 }), 'the widest'),
    hwpCase(one(first, { width: '600' }), 'a string as width'),
    hwpCase(one(first, { width: null }), 'null as width'),
    hwpCase(one(first, { width: 1e21 }), 'a width past every integer'),
    hwpCase(one(first, { type: 4 }), 'a kind past the last'),
    hwpCase(one(first, { type: -1 }), 'a kind below zero'),
    hwpCase(one(first, { type: 0.5 }), 'a fraction as kind'),
    hwpCase(one(first, { type: 3 }), 'the last kind'),
    hwpCase(one(first, { fill: 256 }), 'a leader past one byte'),
    hwpCase(one(first, { fill: 255 }), 'the last leader'),
    hwpCase(one(first, { fill: -1 }), 'a negative leader'),
    hwpCase(one(first, { fill: 0 }), 'no leader'),
    hwpCase(one(first, { fill: true }), 'a flag as leader'),
    hwpCase(one(first, { sec: 1 }), 'a section that is another one'),
    hwpCase(one(first, { sec: '0' }), 'a section number as a string: the key is the same'),
    hwpCase(one(first, { sec: null }), 'a null section'),
    hwpCase(one(first, { para: 0.0 }), 'the same paragraph'),
    hwpCase(one(first, { para: -0 }), 'paragraph minus zero'),
    hwpCase(one(first, { para: 99 }), 'a paragraph that is not there'),
    hwpCase(one(first, { tab: 5 }), 'a tab that is not there'),
    hwpCase(one(first, { tab: null }), 'a null tab'),
    hwpCase(
      one(first, { cells: [{ table: 0, cell: 0, para: 0 }] }),
      'cells the spot does not have',
    ),
    hwpCase(one(first, { cells: null }), 'null cells'),
    hwpCase(one(first, { cells: undefined }), 'no cells'),
    hwpCase(one(first, { cells: {} }), 'cells that are no list'),
    hwpCase(one(first, { cells: [null] }), 'a cell that is null'),
    hwpCase(one(first, { cells: [5] }), 'a cell that is a number'),
    hwpCase(one(first, { cells: ['abc'] }), 'a cell that is a string'),
    hwpCase(
      one(first, { cells: [{ table: '0', cell: 0, para: [0] }] }),
      'cell numbers as other types',
    ),
    hwpCase([null], 'a measure that is null'),
    hwpCase([5], 'a measure that is a number'),
    hwpCase(['abc'], 'a measure that is a string'),
    hwpCase([[]], 'a measure that is a list'),
    hwpCase([{}], 'a measure with nothing'),
    hwpCase(
      [...measured(spots.slice(0, 1)), null],
      'a good measure, then null: the throw drops the lot',
    ),
    hwpCase(
      (() => {
        const cell = spots.find((spot) => spot.cells.length > 0) as TabSpot
        return measured([cell])
      })(),
      'a tab in a cell',
    ),
    hwpCase(
      (() => {
        const nested = spots.find((spot) => spot.cells.length > 1) as TabSpot
        return measured([nested])
      })(),
      'a tab in a cell of a cell',
    ),
    hwpCase(measured(spots), 'bytes that are no file', 'exact', '010203'),
    hwpCase(measured(spots), 'a zip as HWP 5', 'exact', hex(HWPX_STORED)),
    hwpCase(measured(spots), 'empty', 'exact', ''),
    hwpCase(measured(spots), 'a file with no tab', 'exact', hex(TABS_HWP_NONE)),
    hwpCase(
      measured(spots),
      'a section that is not deflate data',
      'exact',
      hex(
        hwp({
          compressed: true,
          sections: [Buffer.alloc(0)],
          rawSections: { 0: Buffer.from('zz') },
        }),
      ),
    ),
    hwpCase(
      [
        ...Array.from({ length: MAX_NEW_TABS }, (_, i) => ({
          ...first,
          tab: 9000 + i,
          width: 5,
          type: 0,
          fill: 0,
        })),
        ...measured(spots.slice(0, 1)),
      ],
      'the measure after the last a save takes is dropped',
    ),
    hwpCase(
      [
        ...Array.from({ length: MAX_NEW_TABS - 1 }, (_, i) => ({
          ...first,
          tab: 9000 + i,
          width: 5,
          type: 0,
          fill: 0,
        })),
        ...measured(spots.slice(0, 1)),
      ],
      'the last measure a save takes is written',
    ),
    // HWPX
    hwpxCase(measured(storedSpots), 'every spot of stored sections'),
    hwpxCase(measured(storedSpots, 100, 3, 255), 'the last kind and leader'),
    hwpxCase(measured(storedSpots.slice(1, 3)), 'two spots'),
    hwpxCase(
      [...measured(storedSpots.slice(0, 1)), ...measured(storedSpots.slice(0, 1), 8, 2, 2)],
      'a spot twice',
    ),
    hwpxCase(measured(hwpxSpots), 'deflated sections', HWPX, 'inflated'),
    hwpxCase(
      measured(oddSpots),
      'sections of odd numbers, a descriptor, an extra field and a comment',
      HWPX_ODD,
      'inflated',
    ),
    hwpxCase(measured(oddSpots.slice(0, 2)), 'the first two of them', HWPX_ODD, 'inflated'),
    hwpxCase([], 'nothing measured'),
    hwpxCase(one(storedSpots[0] as TabSpot, { tabs: 99 }), 'a tab count that does not match'),
    hwpxCase(one(storedSpots[0] as TabSpot, { width: 0 }), 'width zero'),
    hwpxCase(one(storedSpots[0] as TabSpot, { fill: 300 }), 'a leader past a byte'),
    hwpxCase(one(storedSpots[0] as TabSpot, { sec: 7 }), 'a section that is not there'),
    hwpxCase([null], 'a measure that is null'),
    hwpxCase(measured(storedSpots), 'a file that is no zip', Buffer.from([1, 2, 3])),
    hwpxCase(measured(storedSpots), 'an HWP 5 file as a zip', TABS_HWP),
    hwpxCase(measured(storedSpots), 'a zip with no section', zip([mimetype()])),
    hwpxCase(
      measured(storedSpots),
      'a method this does not handle',
      zip([{ name: 'Contents/section0.xml', data: Buffer.from(SECTION1), method: 9 }]),
    ),
    hwpxCase(
      measured(storedSpots),
      'a section that is not deflate data',
      zip([
        {
          name: 'Contents/section0.xml',
          data: Buffer.from(SECTION1),
          rawData: Buffer.from('not deflate data'),
        },
      ]),
    ),
    hwpxCase(
      measured(
        spotsOf(
          zip([
            {
              name: 'Contents/section0.xml',
              data: Buffer.from(secXml(p(tabEl(), '\u{1F600}', tabEl(), '\u00fcn\u00ef'))),
              method: 0,
            },
          ]),
          'hwpx',
        ),
      ),
      'a section with astral and accented text',
      zip([
        {
          name: 'Contents/section0.xml',
          data: Buffer.from(secXml(p(tabEl(), '\u{1F600}', tabEl(), '\u00fcn\u00ef'))),
          method: 0,
        },
      ]),
    ),
    hwpxCase(
      measured(
        spotsOf(
          zip([
            {
              name: 'Contents/section0.xml',
              data: Buffer.from(
                secXml(
                  p(
                    '<hp:tab   width="0"   type="5" leader="2"/>',
                    '<hp:tab leader="1" width="0"/>',
                    '<hp:tab width="0"/>',
                    '<hp:tab type="2" width="0" leader="1">',
                    '</hp:tab>',
                  ),
                ),
              ),
              method: 0,
            },
          ]),
          'hwpx',
        ),
      ),
      'tabs with some attributes and not others',
      zip([
        {
          name: 'Contents/section0.xml',
          data: Buffer.from(
            secXml(
              p(
                '<hp:tab   width="0"   type="5" leader="2"/>',
                '<hp:tab leader="1" width="0"/>',
                '<hp:tab width="0"/>',
                '<hp:tab type="2" width="0" leader="1">',
                '</hp:tab>',
              ),
            ),
          ),
          method: 0,
        },
      ]),
    ),
  ]
}

function saveFixCases(): Case[] {
  // a document as the engine writes it: a tab without values, fields of unknown kind, an equation
  // without its caption, nothing after the body; and the file it was opened from
  const engineBody = (): Buffer =>
    Buffer.concat([
      para(0, Buffer.concat([chars('a'), tabChar(), chars('b')])),
      para(
        0,
        Buffer.concat([chars('a'), fieldBegin(UNKNOWN_FIELD), chars('m'), fieldEnd()]),
        fieldControl(0, 'memo'),
      ),
      para(0, Buffer.concat([chars('eq'), objectChar()]), equation(0, 'eq-1', false)),
      para(0, Buffer.concat([chars('x'), MEMO_COMMAND(1)])),
    ])
  const openedBody = (): Buffer =>
    Buffer.concat([
      para(0, Buffer.concat([chars('a'), tabChar(), chars('b')])),
      para(
        0,
        Buffer.concat([chars('a'), fieldBegin(KIND_ME), chars('m'), fieldEnd()]),
        fieldControl(0, 'memo'),
      ),
      para(0, Buffer.concat([chars('eq'), objectChar()]), equation(0, 'eq-1', true)),
      para(0, Buffer.concat([chars('x'), MEMO_COMMAND(1)])),
      masterPage(4),
      memo(1),
    ])
  const opened = hwp({ sections: [openedBody()], streams: TAIL_STREAMS })
  const engine = hwp({ sections: [engineBody()], streams: TAIL_STREAMS })
  const openedDeflated = hwp({ compressed: true, sections: [openedBody()], streams: TAIL_STREAMS })
  const engineDeflated = hwp({ compressed: true, sections: [engineBody()], streams: TAIL_STREAMS })
  const tails = tailsJson(sectionTailsOf(opened))
  const kinds = entriesOf(fieldKindsOf(opened))
  const tailsDeflated = tailsJson(sectionTailsOf(openedDeflated))
  const kindsDeflated = entriesOf(fieldKindsOf(openedDeflated))
  const tabs = measured(spotsOf(engine, 'hwp'))
  const tabsDeflated = measured(spotsOf(engineDeflated, 'hwp'))
  const hwpxTabs = measured(spotsOf(HWPX_STORED, 'hwpx'))
  return [
    { args: [hex(engine), 'hwp', tabs, { tails, kinds }, 'exact'], note: 'all three corrections' },
    { args: [hex(engine), 'hwp', null, { tails, kinds }, 'exact'], note: 'no tabs measured' },
    { args: [hex(engine), 'hwp', [], { tails, kinds }, 'exact'], note: 'an empty list of tabs' },
    { args: [hex(engine), 'hwp', tabs, { tails: null, kinds }, 'exact'], note: 'tabs and kinds' },
    { args: [hex(engine), 'hwp', tabs, { tails, kinds: null }, 'exact'], note: 'tabs and tails' },
    { args: [hex(engine), 'hwp', tabs, { tails: null, kinds: null }, 'exact'], note: 'tabs alone' },
    { args: [hex(engine), 'hwp', null, { tails: null, kinds }, 'exact'], note: 'kinds alone' },
    { args: [hex(engine), 'hwp', null, { tails, kinds: null }, 'exact'], note: 'tails alone' },
    {
      args: [hex(engine), 'hwp', null, { tails: null, kinds: null }, 'exact'],
      note: 'nothing to do',
    },
    {
      args: [hex(engine), 'hwp', null, { tails, kinds: [] }, 'exact'],
      note: 'no kind kept: a map that is not undefined',
    },
    {
      args: [hex(engine), 'hwpx', tabs, { tails, kinds }, 'exact'],
      note: 'hwpx: the tabs are looked for in a zip, kinds and tails are not used',
    },
    {
      args: [hex(HWPX_STORED), 'hwpx', hwpxTabs, { tails, kinds }, 'exact'],
      note: 'a hwpx with its tabs',
    },
    {
      args: [
        hex(HWPX),
        'hwpx',
        measured(spotsOf(HWPX, 'hwpx')),
        { tails: null, kinds: null },
        'inflated',
      ],
      note: 'a deflated hwpx',
    },
    {
      args: [
        hex(engineDeflated),
        'hwp',
        tabsDeflated,
        { tails: tailsDeflated, kinds: kindsDeflated },
        'inflated',
      ],
      note: 'deflated, all three',
    },
    {
      args: [
        hex(engine),
        'hwp',
        tabs,
        { tails: { ...(tails as TailsJson), sections: 3 }, kinds },
        'exact',
      ],
      note: 'tails skipped (sections), the rest applied',
    },
    {
      args: [
        hex(engine),
        'hwp',
        null,
        { tails: { ...(tails as TailsJson), binData: ['bin9.png'] }, kinds: null },
        'exact',
      ],
      note: 'tails skipped (bin-data)',
    },
    {
      args: [
        hex(engine),
        'hwp',
        null,
        { tails: { ...(tails as TailsJson), ids: [['21', ['0'.repeat(40)]]] }, kinds: null },
        'exact',
      ],
      note: 'tails skipped (ids)',
    },
    {
      args: [hex(zip([mimetype()])), 'hwp', tabs, { tails, kinds }, 'exact'],
      note: 'a zip as HWP 5: tails unreadable',
    },
    { args: ['', 'hwp', null, { tails, kinds }, 'exact'], note: 'empty: tails unreadable' },
    {
      args: [hex(opened), 'hwp', null, { tails, kinds }, 'exact'],
      note: 'a file that needs nothing',
    },
  ]
}
