/**
 * Group `b4-slides`: the modules of apps/slides/src/main that hold no Electron
 * object, except shaped-metrics.ts (HarfBuzz compiled to wasm; not ported).
 *
 * Bytes cross as hex strings (a reader of a binary format is fed hand-made
 * files, truncated and malformed ones among them). A `null` argument is an
 * argument left out where the TypeScript has a default. Names of files that
 * another app also has are prefixed `slides/`. Functions that keep state
 * (the seed queue, the Save As targets, the template store) take a script of
 * steps and answer one result per step; the template store's clock counts up
 * from the clock of the call by one a call, and a `tick` step moves it.
 */
import { readFileSync, rmSync } from 'node:fs'
import { deflateSync, gzipSync } from 'node:zlib'
import { cfbKind, isCfbHeader } from '../../../apps/slides/src/main/cfb-sniff.ts'
import { buildExportImagePaths } from '../../../apps/slides/src/main/export-images.ts'
import { scanFontDirs, type ScanTask } from '../../../apps/slides/src/main/font-scan.ts'
import {
  GENERATED_PAGE_TTL_MS,
  cleanupExpiredGeneratedPages,
} from '../../../apps/slides/src/main/generated-page-temp.ts'
import { neutralizeJpegOrientation } from '../../../apps/slides/src/main/jpeg-orientation.ts'
import {
  displayMime,
  rasterImageExt,
  sniffImageMime,
} from '../../../apps/slides/src/main/media-mime.ts'
import {
  MAX_METAFILE_GUNZIP_BYTES,
  listMetafileFonts,
  scanMetafileFonts,
} from '../../../apps/slides/src/main/metafile-fonts.ts'
import {
  audioSampleFormats,
  mp4VideoSize,
  unplayableAudioCodec,
} from '../../../apps/slides/src/main/mp4-audio-sniff.ts'
import {
  newPasteCascade,
  pageKey,
  pasteShiftPx,
  recordPaste,
} from '../../../apps/slides/src/main/paste-cascade.ts'
import {
  PDF_EXPORT_HEIGHT_IN,
  PDF_EXPORT_TIMEOUT_MS,
  PRINT_READY_SCRIPT,
  buildPdfExportHtml,
  buildPdfLinkOverlays,
  exportPageWidthIn,
  exportSlidesPdf,
} from '../../../apps/slides/src/main/pdf-export.ts'
import { DEFAULT_PICTURE_DPI, pictureFrame } from '../../../apps/slides/src/main/picture-frame.ts'
import {
  SaveAsImageTargets,
  resolveSlidesSaveAsPick,
  slidesSaveAsFilters,
  slidesSaveAsSuggestion,
} from '../../../apps/slides/src/main/save-as-formats.ts'
import {
  queueSlidesSeedFor,
  takeSlidesSeed,
  takeSlidesSeedEntry,
} from '../../../apps/slides/src/main/seed-queue.ts'
import {
  TEMPLATE_SELECTION_FILE,
  TEMPLATE_SELECTION_MAX_DOCUMENTS,
  TEMPLATE_SELECTION_TOUCH_INTERVAL_MS,
  TemplateSelectionMemory,
  TemplateSelectionStore,
} from '../../../apps/slides/src/main/template-selection-store.ts'
import { audioFrame, videoFrame, videoSize } from '../../../apps/slides/src/main/video-size.ts'
import type { Case, FileSpec, FnSpec, Group } from '../types.ts'

const str = (a: unknown[], i: number): string => a[i] as string
const bytes = (a: unknown[], i: number): Buffer => Buffer.from(str(a, i), 'hex')
/** a `null` argument is an argument left out */
const orUndefined = <T>(value: T | null | undefined): T | undefined =>
  value === null ? undefined : value
const hx = (b: Uint8Array): string => Buffer.from(b).toString('hex')
const cases = (...lists: unknown[][]): Case[] => lists.map((args): Case => ({ args }))

/** a constant: its second case adds a file, so the two answers differ */
function constant(value: unknown): FnSpec {
  return {
    ts: () => value,
    cases: [{ args: [] }, { args: [], files: { 'x.txt': 'x' } }],
  }
}

type Op = Record<string, unknown>

// ---------- byte builders ----------

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n)
  return b
}
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n)
  return b
}
const u16be = (n: number): Buffer => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}
const u32be = (n: number): Buffer => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}
type Part = Buffer | number[] | string
const toBuffer = (p: Part): Buffer =>
  typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p)
const cat = (...parts: Part[]): Buffer => Buffer.concat(parts.map(toBuffer))

// ---------- cfb-sniff ----------

const NO = 0xffffffff
const END = 0xfffffffe
const FAT_MARK = 0xfffffffd
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

interface CfbAt {
  sb: number
  dir: number
  fat: number
  entry: (i: number) => number
}
interface CfbOptions {
  v4?: boolean
  /** the name of the one stream of the directory */
  name?: string
  /** leave unused entries zero filled, as some writers do */
  zeroUnused?: boolean
  mutate?: (b: Buffer, at: CfbAt) => void
}

/** a compound file of a header, one FAT sector and one directory sector */
function cfb(options: CfbOptions = {}): Buffer {
  const sb = options.v4 ? 4096 : 512
  const b = Buffer.alloc(sb * 3)
  Buffer.from(CFB_MAGIC).copy(b, 0)
  b.writeUInt16LE(0x3e, 24)
  b.writeUInt16LE(options.v4 ? 4 : 3, 26)
  b.writeUInt16LE(0xfffe, 28)
  b.writeUInt16LE(options.v4 ? 12 : 9, 30)
  b.writeUInt16LE(6, 32)
  b.writeUInt32LE(1, 44)
  b.writeUInt32LE(1, 48)
  b.writeUInt32LE(4096, 56)
  b.writeUInt32LE(END, 60)
  b.writeUInt32LE(0, 64)
  b.writeUInt32LE(END, 68)
  b.writeUInt32LE(0, 72)
  for (let i = 0; i < 109; i++) b.writeUInt32LE(i === 0 ? 0 : NO, 76 + i * 4)
  const fat = sb
  for (let i = 0; i < sb / 4; i++) b.writeUInt32LE(NO, fat + i * 4)
  b.writeUInt32LE(FAT_MARK, fat)
  b.writeUInt32LE(END, fat + 4)
  const dir = sb * 2
  const entry = (i: number): number => dir + i * 128
  for (let i = 0; i < sb / 128; i++) {
    if (options.zeroUnused && i > 1) continue
    for (const link of [68, 72, 76]) b.writeUInt32LE(NO, entry(i) + link)
    b.writeUInt32LE(END, entry(i) + 116)
  }
  const named = (i: number, name: string, type: number): void => {
    const text = Buffer.from(name, 'utf16le')
    text.copy(b, entry(i))
    b.writeUInt16LE(text.length + 2, entry(i) + 64)
    b.writeUInt8(type, entry(i) + 66)
  }
  named(0, 'Root Entry', 5)
  b.writeUInt32LE(1, entry(0) + 76)
  named(1, options.name ?? 'PowerPoint Document', 2)
  options.mutate?.(b, { sb, dir, fat, entry })
  return b
}

const damaged: Record<string, Buffer> = {
  'version 2': cfb({ mutate: (b) => b.writeUInt16LE(2, 26) }),
  'version 4 with 512-byte sectors': cfb({ mutate: (b) => b.writeUInt16LE(4, 26) }),
  'sector shift 10': cfb({ mutate: (b) => b.writeUInt16LE(10, 30) }),
  'sector shift 12 with version 3': cfb({ mutate: (b) => b.writeUInt16LE(12, 30) }),
  'mini shift 7': cfb({ mutate: (b) => b.writeUInt16LE(7, 32) }),
  'cutoff 1000': cfb({ mutate: (b) => b.writeUInt32LE(1000, 56) }),
  'cut inside the directory': cfb().subarray(0, 1536 - 100),
  'cut inside the FAT sector': cfb().subarray(0, 700),
  'header only': cfb().subarray(0, 512),
  'magic only': Buffer.from(CFB_MAGIC),
  'FAT count 2': cfb({ mutate: (b) => b.writeUInt32LE(2, 44) }),
  'FAT count 0': cfb({ mutate: (b) => b.writeUInt32LE(0, 44) }),
  'FAT slot gap': cfb({ mutate: (b) => b.writeUInt32LE(1, 76 + 2 * 4) }),
  'directory chain loops': cfb({ mutate: (b, at) => b.writeUInt32LE(1, at.fat + 4) }),
  'directory start past the file': cfb({ mutate: (b) => b.writeUInt32LE(5, 48) }),
  'DIFAT chain onto the FAT sector': cfb({ mutate: (b) => b.writeUInt32LE(0, 68) }),
  'DIFAT count 1': cfb({ mutate: (b) => b.writeUInt32LE(1, 72) }),
  'mini FAT onto the FAT sector': cfb({
    mutate: (b) => {
      b.writeUInt32LE(1, 64)
      b.writeUInt32LE(0, 60)
    },
  }),
  'root is a storage': cfb({ mutate: (b, at) => b.writeUInt8(1, at.entry(0) + 66) }),
  'second root': cfb({ mutate: (b, at) => b.writeUInt8(5, at.entry(2) + 66) }),
  'unknown entry type': cfb({ mutate: (b, at) => b.writeUInt8(9, at.entry(2) + 66) }),
  'child out of range': cfb({ mutate: (b, at) => b.writeUInt32LE(99, at.entry(0) + 76) }),
  'entry reached twice': cfb({ mutate: (b, at) => b.writeUInt32LE(1, at.entry(1) + 72) }),
  'root has a sibling': cfb({ mutate: (b, at) => b.writeUInt32LE(1, at.entry(0) + 68) }),
  'orphan links into the tree': cfb({
    mutate: (b, at) => {
      b.writeUInt8(2, at.entry(3) + 66)
      b.writeUInt32LE(1, at.entry(3) + 68)
    },
  }),
  'small stream with no chain': cfb({ mutate: (b, at) => b.writeUInt32LE(100, at.entry(1) + 120) }),
  'big stream with no chain': cfb({ mutate: (b, at) => b.writeUInt32LE(5000, at.entry(1) + 120) }),
  'big stream on the FAT sector': cfb({
    mutate: (b, at) => {
      b.writeUInt32LE(5000, at.entry(1) + 120)
      b.writeUInt32LE(0, at.entry(1) + 116)
    },
  }),
  'mini stream with no chain': cfb({ mutate: (b, at) => b.writeUInt32LE(100, at.entry(0) + 120) }),
  'v4 size over 2^32': cfb({
    v4: true,
    mutate: (b, at) => b.writeUInt32LE(1, at.entry(1) + 124),
  }),
}

const cfbSamples: [string, Buffer][] = [
  ['legacy', cfb()],
  ['encrypted', cfb({ name: 'EncryptedPackage' })],
  ['v4 legacy', cfb({ v4: true })],
  ['v4 encrypted', cfb({ v4: true, name: 'EncryptedPackage' })],
  ['zero filled unused entries', cfb({ zeroUnused: true })],
  ['name that is only part of it', cfb({ name: 'Encrypted' })],
  ['another name', cfb({ name: 'x' })],
  ...Object.entries(damaged),
  [
    'encrypted name in a damaged file',
    cfb({ name: 'EncryptedPackage', mutate: (b) => b.writeUInt16LE(2, 26) }),
  ],
]

// ---------- jpeg-orientation ----------

/** a TIFF body: `tags` are [tag, value] of the first IFD */
function tiff(le: boolean, tags: [number, number][]): Buffer {
  const w16 = (n: number): Buffer => (le ? u16(n) : u16be(n))
  const w32 = (n: number): Buffer => (le ? u32(n) : u32be(n))
  return cat(
    le ? 'II' : 'MM',
    w16(42),
    w32(8),
    w16(tags.length),
    ...tags.map(([tag, value]) => cat(w16(tag), w16(3), w32(1), w16(value), w16(0))),
    w32(0),
  )
}

const seg = (marker: number, data: Buffer): Buffer =>
  cat([0xff, marker], u16be(data.length + 2), data)
const exifSeg = (body: Buffer): Buffer => seg(0xe1, cat('Exif\0\0', body))
const SOI = Buffer.from([0xff, 0xd8])
const SOS = Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9])
const jpeg = (...segments: Buffer[]): Buffer => cat(SOI, ...segments, SOS)
const JFIF = seg(0xe0, cat('JFIF\0', [1, 1, 0, 0, 1, 0, 1, 0, 0]))

const jpegSamples: [string, Buffer][] = [
  ['little endian 6', jpeg(exifSeg(tiff(true, [[0x0112, 6]])))],
  ['big endian 8', jpeg(exifSeg(tiff(false, [[0x0112, 8]])))],
  ['big endian 3 after JFIF', jpeg(JFIF, exifSeg(tiff(false, [[0x0112, 3]])))],
  ['already 1', jpeg(exifSeg(tiff(true, [[0x0112, 1]])))],
  ['0', jpeg(exifSeg(tiff(false, [[0x0112, 0]])))],
  ['no orientation tag', jpeg(exifSeg(tiff(true, [[0x011a, 72]])))],
  [
    'orientation second',
    jpeg(
      exifSeg(
        tiff(true, [
          [0x011a, 72],
          [0x0112, 5],
        ]),
      ),
    ),
  ],
  ['no tags', jpeg(exifSeg(tiff(false, [])))],
  [
    'APP1 that is no Exif, then Exif',
    jpeg(seg(0xe1, cat('http://ns\0xmp')), exifSeg(tiff(true, [[0x0112, 2]]))),
  ],
  ['bad byte order', jpeg(exifSeg(cat('XX', u16(42), u32(8), u16(0))))],
  ['IFD past the segment', jpeg(exifSeg(cat('II', u16(42), u32(4000), u16(1))))],
  ['count past the segment', jpeg(exifSeg(cat('II', u16(42), u32(8), u16(500))))],
  [
    'tag cut short',
    jpeg(seg(0xe1, cat('Exif\0\0', 'II', u16(42), u32(8), u16(1), u16(0x0112), u16(3)))),
  ],
  ['SOI only', SOI],
  ['no SOI', Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04])],
  ['3 bytes', Buffer.from([0xff, 0xd8, 0xff])],
  ['not a marker', cat(SOI, [0x00, 0xe1, 0x00, 0x08])],
  ['EOI first', cat(SOI, [0xff, 0xd9, 0xff, 0xe1, 0x00, 0x02])],
  ['SOS before APP1', cat(SOI, SOS, exifSeg(tiff(true, [[0x0112, 6]])))],
  ['segment length 1', cat(SOI, [0xff, 0xe1, 0x00, 0x01, 0xaa, 0xbb])],
  ['segment past the end', cat(SOI, [0xff, 0xe1, 0x01, 0x00, 0xaa, 0xbb])],
  ['Exif header cut short', cat(SOI, [0xff, 0xe1, 0x00, 0x08], 'Exif\0\0')],
  ['byte order then nothing', cat(SOI, [0xff, 0xe1, 0x00, 0x0a], 'Exif\0\0', 'II')],
  ['Exif with one 0 missing', cat(SOI, [0xff, 0xe1, 0x00, 0x0c], 'Exif\0', 'IIx', u16(42))],
]

// ---------- media-mime ----------

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const emfHeader = (): Buffer => {
  const b = Buffer.alloc(88)
  b.writeUInt32LE(1, 0)
  b.writeUInt32LE(88, 4)
  b.writeUInt32LE(0x464d4520, 40)
  return b
}
const mimeSamples: [string, Buffer][] = [
  ['png', Buffer.from(PNG)],
  ['png prefix', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
  ['png cut', Buffer.from([0x89, 0x50, 0x4e])],
  ['jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])],
  ['jpeg SOI only', Buffer.from([0xff, 0xd8])],
  ['gif', cat('GIF89a')],
  ['bmp', cat('BM', [1, 2, 3])],
  ['webp', cat('RIFF', u32(4), 'WEBP')],
  ['riff but avi', cat('RIFF', u32(4), 'AVI ')],
  ['riff short', cat('RIFF', u32(4), 'WEB')],
  ['tiff little', Buffer.from([0x49, 0x49, 0x2a, 0x00, 0])],
  ['tiff big', Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0])],
  ['tiff cut', Buffer.from([0x49, 0x49, 0x2a])],
  ['emf', emfHeader()],
  ['emf 44 bytes', emfHeader().subarray(0, 44)],
  ['emf 43 bytes', emfHeader().subarray(0, 43)],
  ['emf without signature', Buffer.from([1, 0, 0, 0, ...new Array<number>(56).fill(0)])],
  ['wmf placeable', Buffer.from([0xd7, 0xcd, 0xc6, 0x9a, 0, 0])],
  ['svg text', cat('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ['empty', Buffer.alloc(0)],
  ['zeros', Buffer.alloc(64)],
]

// ---------- metafile-fonts ----------

const utf16z = (text: string, chars: number): Buffer => {
  const b = Buffer.alloc(chars * 2)
  Buffer.from(text, 'utf16le').copy(b, 0, 0, chars * 2)
  return b
}

/** EMR_EXTCREATEFONTINDIRECTW with a LOGFONTW */
function emfFont(face: string, weight: number, italic: number, size = 104): Buffer {
  const b = Buffer.alloc(size)
  b.writeUInt32LE(82, 0)
  b.writeUInt32LE(size, 4)
  const lf = 12
  b.writeInt32LE(weight, lf + 16)
  b.writeUInt8(italic, lf + 20)
  utf16z(face, 32).copy(b, lf + 28, 0, Math.max(0, Math.min(64, size - lf - 28)))
  return b
}

/** an EmfPlusObject record of a font */
function plusFont(face: string, style: number, nameLen = face.length, size?: number): Buffer {
  const total = size ?? Math.max(40, 12 + 24 + face.length * 2 + (face.length % 2) * 2)
  const b = Buffer.alloc(total)
  b.writeUInt16LE(0x4008, 0)
  b.writeUInt16LE(6 << 8, 2)
  b.writeUInt32LE(total, 4)
  b.writeUInt32LE(total - 12, 8)
  if (total >= 28) b.writeInt32LE(style, 12 + 12)
  if (total >= 36) b.writeUInt32LE(nameLen, 12 + 20)
  Buffer.from(face, 'utf16le').copy(b, 12 + 24, 0, Math.max(0, total - 36))
  return b
}

/** EMR_COMMENT holding EMF+ records */
function emfComment(...plus: Buffer[]): Buffer {
  const body = Buffer.concat(plus)
  const dataSize = 4 + body.length
  const size = 16 + body.length
  const b = Buffer.alloc(size)
  b.writeUInt32LE(70, 0)
  b.writeUInt32LE(size, 4)
  b.writeUInt32LE(dataSize, 8)
  b.writeUInt32LE(0x2b464d45, 12)
  body.copy(b, 16)
  return b
}

const emf = (...records: Buffer[]): Buffer => Buffer.concat([emfHeader(), ...records])

const wmfPlaceable = (): Buffer => {
  const b = Buffer.alloc(22)
  b.writeUInt32LE(0x9ac6cdd7, 0)
  return b
}
const wmfHeader = (): Buffer => {
  const b = Buffer.alloc(18)
  b.writeUInt16LE(1, 0)
  b.writeUInt16LE(9, 2)
  return b
}
/** META_CREATEFONTINDIRECT with a LOGFONT16 */
function wmfFont(face: string, weight: number, italic: number, size = 56): Buffer {
  const b = Buffer.alloc(size)
  b.writeUInt32LE(size / 2, 0)
  b.writeUInt16LE(0x02fb, 4)
  const lf = 6
  b.writeInt16LE(weight, lf + 8)
  b.writeUInt8(italic, lf + 10)
  Buffer.from(face, 'latin1').copy(b, lf + 18, 0, Math.max(0, size - lf - 18))
  return b
}
const wmf = (placeable: boolean, ...records: Buffer[]): Buffer =>
  Buffer.concat([...(placeable ? [wmfPlaceable()] : []), wmfHeader(), ...records])

const notPlus = (() => {
  const c = emfComment(plusFont('Nope', 0))
  c.writeUInt32LE(0x11111111, 12)
  return c
})()
const dataSize3 = (() => {
  const c = emfComment(plusFont('Three', 0))
  c.writeUInt32LE(3, 8)
  return c
})()
const shortComment = (() => {
  const c = Buffer.alloc(12)
  c.writeUInt32LE(70, 0)
  c.writeUInt32LE(12, 4)
  return c
})()
const otherFunction = (() => {
  const r = wmfFont('Other', 400, 0)
  r.writeUInt16LE(0x02fa, 4)
  return r
})()
const noSignature = (() => {
  const h = emfHeader()
  h.writeUInt32LE(0, 40)
  return Buffer.concat([h, emfFont('AsWmf', 400, 0)])
})()

const metafiles: [string, Buffer][] = [
  ['emf one font', emf(emfFont('Calibri', 400, 0))],
  ['emf bold italic', emf(emfFont('Cambria', 700, 1))],
  ['emf weight 599 and 600', emf(emfFont('A', 599, 0), emfFont('B', 600, 0))],
  ['emf negative weight', emf(emfFont('Neg', -700, 0))],
  [
    'emf duplicates by case',
    emf(emfFont('Arial', 400, 0), emfFont('ARIAL', 400, 0), emfFont('arial', 700, 0)),
  ],
  ['emf control characters and spaces', emf(emfFont('\u0001  Wing\u007fdings \u0002x', 400, 0))],
  ['emf empty face', emf(emfFont('', 400, 0), emfFont('\u0002', 400, 0))],
  ['emf Korean and astral', emf(emfFont('맑은 고딕', 400, 0), emfFont('Font\u{1F600}', 400, 1))],
  ['emf face fills the field', emf(emfFont('X'.repeat(32), 400, 0, 332))],
  ['emf too small a record', emf(emfFont('Small', 400, 0, 100))],
  ['emf plus font', emf(emfComment(plusFont('Segoe UI', 0)))],
  ['emf plus bold italic', emf(emfComment(plusFont('Segoe UI', 3)))],
  ['emf plus italic', emf(emfComment(plusFont('Ital', 2)))],
  ['emf plus negative style', emf(emfComment(plusFont('Neg', -1)))],
  ['emf plus two records', emf(emfComment(plusFont('One', 1), plusFont('Two', 0)))],
  ['emf plus name length past record', emf(emfComment(plusFont('Long', 0, 40)))],
  ['emf plus name length 0', emf(emfComment(plusFont('Zero', 0, 0)))],
  ['emf plus record too small', emf(emfComment(plusFont('Tiny', 0, 4, 20)))],
  ['emf plus record past the comment', emf(emfComment(plusFont('Past', 0, 4, 40).subarray(0, 30)))],
  ['emf comment not EMF+', emf(notPlus)],
  ['emf comment data size 3', emf(dataSize3)],
  ['emf comment too short', emf(shortComment)],
  [
    'emf mixed',
    emf(
      emfFont('Mix', 400, 0),
      emfComment(plusFont('Mix', 0), plusFont('Plus', 1)),
      emfFont('End', 700, 1),
    ),
  ],
  ['emf record size 4', emf(Buffer.from([82, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 0]))],
  ['emf record past the end', emf(emfFont('Cut', 400, 0).subarray(0, 100))],
  ['emf header only', emfHeader()],
  ['wmf placeable', wmf(true, wmfFont('Tahoma', 400, 0))],
  ['wmf plain bold italic', wmf(false, wmfFont('Verdana', 700, 1))],
  ['wmf latin1', wmf(false, wmfFont('Caf\u00e9 \u00ff', 400, 0))],
  [
    'wmf three fonts',
    wmf(true, wmfFont('One', 400, 0), wmfFont('Two', 600, 0), wmfFont('one', 400, 0)),
  ],
  ['wmf full name', wmf(false, wmfFont('W'.repeat(32), 400, 0, 56))],
  ['wmf short record', wmf(false, wmfFont('Short', 400, 0, 20))],
  ['wmf record size 2 words', wmf(false, Buffer.from([2, 0, 0, 0, 0xfb, 0x02]))],
  ['wmf record past the end', wmf(false, wmfFont('Cut', 400, 0).subarray(0, 40))],
  ['wmf header only', wmf(true)],
  ['wmf other function', wmf(false, otherFunction)],
  ['emf header without the signature', noSignature],
  ['emf header 43 bytes', emfHeader().subarray(0, 43)],
  ['17 bytes', Buffer.alloc(17, 1)],
  ['18 zero bytes', Buffer.alloc(18)],
  ['empty', Buffer.alloc(0)],
]

const emfGz = gzipSync(emf(emfFont('Gz', 400, 0)))
const withByte = (at: number, value: number): Buffer => {
  const g = Buffer.from(emfGz)
  g[at] = value
  return g
}
const gzSamples: [string, Buffer][] = [
  ['gzip', emfGz],
  ['gzip wmf', gzipSync(wmf(true, wmfFont('GzWmf', 700, 0)))],
  ['gzip and zero padding', Buffer.concat([emfGz, Buffer.alloc(7)])],
  ['gzip and garbage', Buffer.concat([emfGz, Buffer.from('garbage bytes here')])],
  ['gzip and one byte', Buffer.concat([emfGz, Buffer.from([0xff])])],
  ['two members', Buffer.concat([emfGz, gzipSync(emf(emfFont('Second', 400, 1)))])],
  [
    'zero padding then a member',
    Buffer.concat([emfGz, Buffer.alloc(3), gzipSync(emf(emfFont('Lost', 400, 1)))]),
  ],
  ['gzip cut', emfGz.subarray(0, emfGz.length - 5)],
  ['gzip bad checksum', Buffer.concat([emfGz.subarray(0, emfGz.length - 8), Buffer.alloc(8, 1)])],
  ['gzip method 7', withByte(2, 7)],
  ['gzip reserved flag', withByte(3, 0x20)],
  ['gzip empty content', gzipSync(Buffer.alloc(0))],
  ['3 bytes of gzip', Buffer.from([0x1f, 0x8b, 0x08])],
  ['2 bytes of gzip', Buffer.from([0x1f, 0x8b])],
  ['deflate, no gzip', deflateSync(emf(emfFont('Z', 400, 0)))],
]
// an EMF header then zeros: 64 MiB exactly passes, one byte more is refused
const limitFile = (extra: number): Buffer => {
  const b = Buffer.alloc(MAX_METAFILE_GUNZIP_BYTES + extra)
  emfHeader().copy(b, 0)
  return b
}
const atLimit = gzipSync(limitFile(0))
const overLimit = gzipSync(limitFile(1))
const atLimitWithFont = (() => {
  const head = emf(emfFont('AtLimit', 400, 0))
  const b = Buffer.alloc(MAX_METAFILE_GUNZIP_BYTES)
  head.copy(b, 0)
  return gzipSync(b)
})()
const bomb = gzipSync(Buffer.alloc(MAX_METAFILE_GUNZIP_BYTES * 2))

// ---------- mp4 ----------

const box = (type: string, ...payload: Part[]): Buffer => {
  const body = cat(...payload)
  return cat(u32be(body.length + 8), type, body)
}
const fixed = (n: number): Buffer => u32be(Math.round(n * 65536))
const IDENTITY = cat(
  u32be(0x10000),
  u32be(0),
  u32be(0),
  u32be(0),
  u32be(0x10000),
  u32be(0),
  u32be(0),
  u32be(0),
  u32be(0x40000000),
)
const ROTATED = cat(
  u32be(0),
  u32be(0x10000),
  u32be(0),
  u32be(0xffff0000),
  u32be(0),
  u32be(0),
  u32be(0),
  u32be(0),
  u32be(0x40000000),
)

function tkhd(width: number, height: number, matrix: Buffer = IDENTITY, v1 = false): Buffer {
  const head = v1
    ? cat([1, 0, 0, 3], Buffer.alloc(8), Buffer.alloc(8), u32be(1), u32be(0), Buffer.alloc(8))
    : cat([0, 0, 0, 3], u32be(0), u32be(0), u32be(1), u32be(0), u32be(0))
  return box('tkhd', head, Buffer.alloc(8), Buffer.alloc(8), matrix, fixed(width), fixed(height))
}
const hdlr = (handler: string): Buffer =>
  box('hdlr', [0, 0, 0, 0], u32be(0), handler, Buffer.alloc(12), 'Handler\0')
const entry = (format: string, size = 86): Buffer =>
  cat(u32be(size), format, Buffer.alloc(Math.max(0, size - 8)))
const stsd = (...formats: string[]): Buffer =>
  box('stsd', [0, 0, 0, 0], u32be(formats.length), ...formats.map((f) => entry(f)))
const track = (kind: string, formats: string[], head?: Buffer): Buffer =>
  box(
    'trak',
    head ?? tkhd(0, 0),
    box(
      'mdia',
      box('mdhd', Buffer.alloc(24)),
      hdlr(kind),
      box('minf', hdlr('url '), box('stbl', stsd(...formats))),
    ),
  )
const moov = (...tracks: Buffer[]): Buffer => box('moov', ...tracks)
const FTYP = box('ftyp', 'isom', u32be(0), 'isom')
/** a track holding one audio `stsd` made by hand */
const rawAudio = (stsdBody: Part[]): Buffer =>
  cat(
    FTYP,
    moov(
      box('trak', box('mdia', hdlr('soun'), box('minf', box('stbl', box('stsd', ...stsdBody))))),
    ),
  )
const bigBox = (() => {
  const inner = moov(track('soun', ['ac-3']))
  return cat(FTYP, u32be(1), 'moov', u32be(0), u32be(inner.length + 8), inner.subarray(8))
})()
const zeroSizeBox = (() => {
  const inner = moov(track('soun', ['dtsh']))
  return cat(FTYP, u32be(0), 'moov', inner.subarray(8))
})()

const mp4s: [string, Buffer][] = [
  ['video 1920x1080', cat(FTYP, moov(track('vide', ['avc1'], tkhd(1920, 1080))))],
  ['video rotated', cat(FTYP, moov(track('vide', ['avc1'], tkhd(1920, 1080, ROTATED))))],
  [
    'video tkhd version 1',
    cat(FTYP, moov(track('vide', ['hvc1'], tkhd(640, 360, IDENTITY, true)))),
  ],
  ['video fractional', cat(FTYP, moov(track('vide', ['avc1'], tkhd(1280.5, 720.25))))],
  [
    'video zero size then a second',
    cat(FTYP, moov(track('vide', ['avc1'], tkhd(0, 0)), track('vide', ['avc1'], tkhd(320, 240)))),
  ],
  [
    'video and AAC',
    cat(FTYP, moov(track('vide', ['avc1'], tkhd(100, 50)), track('soun', ['mp4a']))),
  ],
  [
    'video and AC-3',
    cat(FTYP, moov(track('vide', ['avc1'], tkhd(100, 50)), track('soun', ['ac-3']))),
  ],
  ['audio EC-3', cat(FTYP, moov(track('soun', ['ec-3'])))],
  ['audio ALAC upper case', cat(FTYP, moov(track('soun', ['ALAC'])))],
  ['audio two formats, second bad', cat(FTYP, moov(track('soun', ['mp4a', 'dtsc'])))],
  ['audio DTS variants', cat(FTYP, moov(track('soun', ['dtsx']), track('soun', ['samr'])))],
  ['audio unknown format', cat(FTYP, moov(track('soun', ['xyz1'])))],
  ['audio with spaces', cat(FTYP, moov(track('soun', ['  a ', 'sawb'])))],
  ['video track with an audio format', cat(FTYP, moov(track('vide', ['ac-3'], tkhd(10, 10))))],
  [
    'track without hdlr',
    cat(FTYP, moov(box('trak', tkhd(10, 10), box('mdia', box('minf', box('stbl', stsd('ac-3'))))))),
  ],
  [
    'hdlr only in minf',
    cat(
      FTYP,
      moov(
        box(
          'trak',
          tkhd(10, 10),
          box('mdia', box('minf', hdlr('soun'), box('stbl', stsd('ac-3')))),
        ),
      ),
    ),
  ],
  [
    'hdlr cut short',
    cat(FTYP, moov(box('trak', box('mdia', box('hdlr', [0, 0, 0, 0], u32be(0), 'so'))))),
  ],
  ['stsd count larger than entries', rawAudio([[0, 0, 0, 0], u32be(5), entry('ac-3')])],
  ['stsd entry too small', rawAudio([[0, 0, 0, 0], u32be(1), u32be(4), 'ac-3'])],
  ['stsd entry past the box', rawAudio([[0, 0, 0, 0], u32be(1), u32be(900), 'ac-3'])],
  ['stsd cut short', rawAudio([[0, 0, 0]])],
  [
    'tkhd cut short',
    cat(FTYP, moov(box('trak', box('tkhd', Buffer.alloc(40)), box('mdia', hdlr('vide'))))),
  ],
  ['no moov', FTYP],
  ['moov inside udta only', cat(FTYP, box('udta', moov(track('soun', ['ac-3']))))],
  [
    'unknown boxes between',
    cat(
      FTYP,
      box('free', Buffer.alloc(10)),
      moov(box('udta', Buffer.alloc(20)), track('soun', ['alac'])),
    ),
  ],
  ['64-bit size box', bigBox],
  ['64-bit size with high word', cat(FTYP, u32be(1), 'moov', u32be(1), u32be(0))],
  ['64-bit size cut', cat(FTYP, u32be(1), 'moov', u32be(0))],
  ['size 0 box to the end', zeroSizeBox],
  ['box size 4', cat(FTYP, u32be(4), 'moov', Buffer.alloc(8))],
  ['box past the end', cat(FTYP, u32be(5000), 'moov', Buffer.alloc(8))],
  ['trak in trak', cat(FTYP, moov(box('trak', track('soun', ['ac-3']))))],
  ['first box cut', Buffer.from([0, 0, 0])],
  ['empty', Buffer.alloc(0)],
]

// ---------- webm / avi ----------

const vsize = (n: number): Buffer =>
  n < 127 ? Buffer.from([0x80 | n]) : Buffer.from([0x40 | (n >> 8), n & 0xff])
const el = (id: number[], ...payload: Buffer[]): Buffer => {
  const body = Buffer.concat(payload)
  return cat(id, vsize(body.length), body)
}
const uint = (id: number[], n: number, len = 2): Buffer => {
  const b = Buffer.alloc(len)
  for (let i = len - 1, v = n; i >= 0; i--, v = Math.floor(v / 256)) b[i] = v % 256
  return el(id, b)
}
const PW = [0xb0]
const PH = [0xba]
const DW = [0x54, 0xb0]
const DH = [0x54, 0xba]
const EBML_HEAD = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], cat('webm')))
const videoEl = (...inner: Buffer[]): Buffer => el([0xe0], ...inner)
const trackEntry = (...inner: Buffer[]): Buffer => el([0xae], uint([0xd7], 1, 1), ...inner)
const tracksEl = (...entries: Buffer[]): Buffer => el([0x16, 0x54, 0xae, 0x6b], ...entries)
const segment = (...inner: Buffer[]): Buffer => el([0x18, 0x53, 0x80, 0x67], ...inner)
const cluster = (): Buffer => el([0x1f, 0x43, 0xb6, 0x75], Buffer.alloc(4))
const webm = (...inner: Buffer[]): Buffer => cat(EBML_HEAD, segment(...inner))
const plainWebm = webm(tracksEl(trackEntry(videoEl(uint(PW, 1920), uint(PH, 1080)))))

const webms: [string, Buffer][] = [
  ['pixel size', plainWebm],
  [
    'display size wins',
    webm(
      tracksEl(trackEntry(videoEl(uint(PW, 1920), uint(PH, 1080), uint(DW, 1440), uint(DH, 1080)))),
    ),
  ],
  [
    'display width alone',
    webm(tracksEl(trackEntry(videoEl(uint(PW, 640), uint(PH, 360), uint(DW, 100))))),
  ],
  [
    'display height alone',
    webm(tracksEl(trackEntry(videoEl(uint(PW, 640), uint(PH, 360), uint(DH, 100))))),
  ],
  [
    'display zero',
    webm(tracksEl(trackEntry(videoEl(uint(PW, 640), uint(PH, 360), uint(DW, 0, 1), uint(DH, 50))))),
  ],
  ['one byte values', webm(tracksEl(trackEntry(videoEl(uint(PW, 200, 1), uint(PH, 100, 1)))))],
  ['four byte values', webm(tracksEl(trackEntry(videoEl(uint(PW, 3840, 4), uint(PH, 2160, 4)))))],
  ['eight byte values', webm(tracksEl(trackEntry(videoEl(uint(PW, 7680, 8), uint(PH, 4320, 8)))))],
  [
    'value size 9 skipped',
    webm(tracksEl(trackEntry(videoEl(el(PW, Buffer.alloc(9, 1)), uint(PH, 100))))),
  ],
  ['width only', webm(tracksEl(trackEntry(videoEl(uint(PW, 100)))))],
  ['height only', webm(tracksEl(trackEntry(videoEl(uint(PH, 100)))))],
  ['zero width', webm(tracksEl(trackEntry(videoEl(uint(PW, 0), uint(PH, 100)))))],
  [
    'audio entry then video',
    webm(
      tracksEl(
        trackEntry(el([0x83], Buffer.from([2]))),
        trackEntry(videoEl(uint(PW, 800), uint(PH, 600))),
      ),
    ),
  ],
  [
    'two video entries',
    webm(
      tracksEl(
        trackEntry(videoEl(uint(PW, 800), uint(PH, 600))),
        trackEntry(videoEl(uint(PW, 400), uint(PH, 300))),
      ),
    ),
  ],
  [
    'empty video then sized',
    webm(tracksEl(trackEntry(videoEl()), trackEntry(videoEl(uint(PW, 400), uint(PH, 300))))),
  ],
  [
    'cluster before tracks',
    webm(cluster(), tracksEl(trackEntry(videoEl(uint(PW, 800), uint(PH, 600))))),
  ],
  [
    'cluster after tracks',
    webm(tracksEl(trackEntry(videoEl(uint(PW, 800), uint(PH, 600)))), cluster()),
  ],
  [
    'unknown-size segment',
    cat(
      EBML_HEAD,
      [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
      tracksEl(trackEntry(videoEl(uint(PW, 800), uint(PH, 600)))),
    ),
  ],
  [
    'unknown-size one byte',
    cat(
      EBML_HEAD,
      [0x18, 0x53, 0x80, 0x67, 0xff],
      tracksEl(trackEntry(videoEl(uint(PW, 123), uint(PH, 45)))),
    ),
  ],
  [
    'unknown-size tracks',
    cat(
      EBML_HEAD,
      segment(cat([0x16, 0x54, 0xae, 0x6b, 0xff], trackEntry(videoEl(uint(PW, 11), uint(PH, 22))))),
    ),
  ],
  ['width value cut', plainWebm.subarray(0, plainWebm.length - 5)],
  ['height value cut', plainWebm.subarray(0, plainWebm.length - 1)],
  ['height missing', plainWebm.subarray(0, plainWebm.length - 4)],
  ['first byte zero', Buffer.from([0x00, 0x81, 0x00])],
  ['id cut', Buffer.from([0x1a, 0x45])],
  ['size cut', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
  ['header only', EBML_HEAD],
  ['empty', Buffer.alloc(0)],
]

const riffChunk = (id: string, payload: Buffer): Buffer =>
  cat(id, u32(payload.length), payload, payload.length % 2 ? [0] : [])
const avih = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(56)
  b.writeUInt32LE(w, 32)
  b.writeUInt32LE(h, 36)
  return riffChunk('avih', b)
}
const list = (kind: string, ...inner: Buffer[]): Buffer => {
  const body = Buffer.concat([Buffer.from(kind), ...inner])
  return cat('LIST', u32(body.length), body)
}
const avi = (...chunks: Buffer[]): Buffer => {
  const body = Buffer.concat([Buffer.from('AVI '), ...chunks])
  return cat('RIFF', u32(body.length), body)
}
const aviWithSize = (size: number): Buffer => {
  const f = Buffer.from(avi(list('hdrl', avih(640, 480))))
  f.writeUInt32LE(size, 4)
  return f
}
const avis: [string, Buffer][] = [
  ['640x480', avi(list('hdrl', avih(640, 480)))],
  ['zero width', avi(list('hdrl', avih(0, 480)))],
  ['zero height', avi(list('hdrl', avih(640, 0)))],
  ['large', avi(list('hdrl', avih(0xffffffff, 0xfffffffe)))],
  ['junk chunk first', avi(riffChunk('JUNK', Buffer.alloc(5)), list('hdrl', avih(320, 200)))],
  [
    'LIST of another kind first',
    avi(list('INFO', riffChunk('ISFT', Buffer.alloc(4))), list('hdrl', avih(1, 2))),
  ],
  ['hdrl without avih', avi(list('hdrl', riffChunk('strh', Buffer.alloc(56))))],
  ['avih cut', avi(list('hdrl', avih(640, 480))).subarray(0, 70)],
  ['RIFF size smaller than the file', aviWithSize(20)],
  ['RIFF size larger than the file', aviWithSize(0xffffff)],
  ['not AVI', cat('RIFF', u32(4), 'WAVE')],
  ['not RIFF', cat('RIFX', u32(4), 'AVI ')],
  ['11 bytes', Buffer.alloc(11)],
  ['chunk size over the file', avi(riffChunk('JUNK', Buffer.alloc(2))).subarray(0, 16)],
  ['empty', Buffer.alloc(0)],
]

// ---------- spec helpers ----------

const slide = { width: 12192000, height: 6858000 }

/** masks a temp folder's random part in what a call returns, throws or logs */
const maskRand = (text: string): string =>
  text.replace(/seuoffice-slides-pdf-[A-Za-z0-9]{6}/g, 'seuoffice-slides-pdf-<rand>')

interface PdfScript {
  createWindow?: 'throws'
  loadFile?: 'throws' | 'hangs'
  executeJavaScript?: 'throws' | 'hangs'
  printToPDF?: 'throws' | 'hangs'
  pdfHex?: string
  destroyThrows?: boolean
  openThrows?: boolean
}
const pdfCase = (extra: Record<string, unknown>, script: PdfScript = {}, note?: string): Case => ({
  args: [
    {
      pages: [
        { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>caf\u00e9</text></svg>' },
        { png: 'iVBORw0K' },
      ],
      widthPx: 1920,
      heightPx: 1080,
      filePath: '$DIR/out.pdf',
      script: { pdfHex: 'deadbeef', ...script },
      ...extra,
    },
  ],
  ...(note ? { note } : {}),
})

// template store scripts
const A = '/no/such/dir/a.pptx'
const B = '/no/such/dir/b.pptx'
const C = '/tmp/seu-tpl-absent.pptx'
const SH = '/bin/sh'
const ACCENT_NFC = '/no/such/\u00e9.pptx'
const ACCENT_NFD = '/no/such/e\u0301.pptx'
const sel = (kind: string, key: string, adjustments?: unknown) => ({
  kind,
  key,
  ...(adjustments === undefined ? {} : { adjustments }),
})
const FILE = TEMPLATE_SELECTION_FILE
const stored = (documents: Record<string, unknown>): string =>
  JSON.stringify({ version: 1, documents })
const rec = (key: string, extra: Record<string, unknown> = {}) => ({
  kind: 'builtin',
  key,
  adjustments: [],
  updatedAt: 5,
  usedAt: 7,
  ...extra,
})
const storeCase = (
  ops: unknown[],
  files?: Record<string, FileSpec>,
  extra: Record<string, unknown> = {},
  note?: string,
): Case => ({
  args: [{ userData: '$DIR/ud', ops, ...extra }],
  ...(files ? { files } : {}),
  ...(note ? { note } : {}),
})
const fileAt = (text: string): Record<string, FileSpec> => ({ [`ud/${FILE}`]: text })

/** a clock that counts up from the clock of the call, with `tick` steps */
function clockOf(start: number): { now: () => number; tick: (ms: number) => void } {
  let t = start
  return {
    now: () => t++,
    tick: (ms) => {
      t += ms
    },
  }
}

function runStore(a: unknown[], cx: { now: number }): unknown[] {
  const script = a[0] as { userData: string; maxDocuments?: number; ops: Op[] }
  const clock = clockOf(cx.now)
  const store = new TemplateSelectionStore(script.userData, {
    ...(script.maxDocuments === undefined ? {} : { maxDocuments: script.maxDocuments }),
    now: clock.now,
  })
  const results: unknown[] = []
  for (const op of script.ops) {
    try {
      switch (op.op) {
        case 'get':
          results.push(store.get(op.path as string))
          break
        case 'set':
          results.push(store.set(op.path as string, op.input))
          break
        case 'put':
          store.put(op.path as string, (op.selection ?? null) as never)
          results.push(null)
          break
        case 'copy':
          store.copy(op.from as string, op.to as string)
          results.push(null)
          break
        case 'move':
          store.move(op.from as string, op.to as string)
          results.push(null)
          break
        case 'tick':
          clock.tick(op.ms as number)
          results.push(null)
          break
        default:
          throw new Error(`unsupported op ${String(op.op)}`)
      }
    } catch (error) {
      const e = error as { code?: unknown; message: string }
      results.push({
        error: { code: typeof e.code === 'string' ? e.code : null, message: e.message },
      })
    }
  }
  return results
}

function runMemory(a: unknown[], cx: { now: number }): unknown[] {
  const script = a[0] as {
    userData: string
    maxDocuments?: number
    docs: Record<string, string>
    ops: Op[]
  }
  const clock = clockOf(cx.now)
  const memory = new TemplateSelectionMemory(script.userData, {
    ...(script.maxDocuments === undefined ? {} : { maxDocuments: script.maxDocuments }),
    now: clock.now,
  })
  const docs: Record<string, { path: string }> = {}
  for (const [name, path] of Object.entries(script.docs)) docs[name] = { path }
  const results: unknown[] = []
  const warn = console.warn
  console.warn = () => {}
  try {
    for (const op of script.ops) {
      switch (op.op) {
        case 'get':
          results.push(memory.get(docs[op.doc as string]!))
          break
        case 'set':
          results.push(memory.set(docs[op.doc as string]!, op.input))
          break
        case 'follow':
          memory.follow(docs[op.doc as string]!, op.from as string, op.to as string)
          results.push(null)
          break
        case 'inherit':
          memory.inherit(
            op.previous === null || op.previous === undefined
              ? undefined
              : docs[op.previous as string],
            docs[op.doc as string]!,
          )
          results.push(null)
          break
        case 'moved':
          memory.moved(op.old as string, op.new as string)
          results.push(null)
          break
        case 'setPath':
          docs[op.doc as string]!.path = op.path as string
          results.push(null)
          break
        case 'tick':
          clock.tick(op.ms as number)
          results.push(null)
          break
        default:
          throw new Error(`unsupported op ${String(op.op)}`)
      }
    }
  } finally {
    console.warn = warn
  }
  return results
}

// seed queue scripts
function runSeeds(a: unknown[]): unknown[] {
  const ops = a[0] as Op[]
  const made: { id: number; destroyed: boolean; listeners: (() => void)[] }[] = []
  const seen = new Set<number>()
  const results: unknown[] = []
  try {
    for (const op of ops) {
      switch (op.op) {
        case 'queue': {
          const fake = {
            id: op.id as number,
            destroyed: op.destroyed === true,
            listeners: [] as (() => void)[],
          }
          made.push(fake)
          seen.add(fake.id)
          queueSlidesSeedFor(
            {
              id: fake.id,
              isDestroyed: () => fake.destroyed,
              once: (_event: string, cb: () => void) => void fake.listeners.push(cb),
            } as never,
            new Uint8Array(Buffer.from(op.deck as string, 'hex')),
            (op.options ?? undefined) as never,
          )
          results.push(fake.listeners.length)
          break
        }
        case 'emit': {
          const fake = made[op.c as number]!
          const fired = fake.listeners.splice(0)
          for (const cb of fired) cb()
          results.push(fired.length)
          break
        }
        case 'take': {
          seen.add(op.id as number)
          const deck = takeSlidesSeed(op.id as number)
          results.push(deck === null ? null : hx(deck))
          break
        }
        case 'takeEntry': {
          seen.add(op.id as number)
          const found = takeSlidesSeedEntry(op.id as number)
          results.push(found === null ? null : { deck: hx(found.deck), options: found.options })
          break
        }
        default:
          throw new Error(`unsupported op ${String(op.op)}`)
      }
    }
  } finally {
    // the queue is module state: leave it empty for the next case
    for (const id of seen) takeSlidesSeedEntry(id)
  }
  return results
}

const queue = (id: number, deck: string, options?: unknown, destroyed = false): Op => ({
  op: 'queue',
  id,
  deck,
  destroyed,
  ...(options === undefined ? {} : { options }),
})
const FULL_OPTIONS = {
  askPathOnFirstSave: true,
  suggestedName: 'Template copy.pptx',
  recoveryId: { kind: 'slides', filePath: '/x/deck.pptx' },
  password: 'pw\u00e9\u{1F600}',
}
const seedScripts: unknown[][] = [
  [[queue(1, 'aabb'), { op: 'take', id: 1 }, { op: 'take', id: 1 }]],
  [[queue(2, '00ff10', FULL_OPTIONS), { op: 'takeEntry', id: 2 }, { op: 'takeEntry', id: 2 }]],
  [[queue(3, '', {}), { op: 'takeEntry', id: 3 }]],
  [[queue(4, 'ab', { askPathOnFirstSave: false }), { op: 'takeEntry', id: 4 }]],
  [
    [
      queue(5, 'ab', {
        suggestedName: '',
        recoveryId: { kind: 'slides', untitledId: 'u-1', ext: '.pptx' },
      }),
      { op: 'takeEntry', id: 5 },
    ],
  ],
  [[queue(6, 'aa', undefined, true), { op: 'take', id: 6 }]],
  [
    [
      queue(7, 'aa'),
      queue(7, 'bb', { password: 'x' }),
      { op: 'takeEntry', id: 7 },
      { op: 'take', id: 7 },
    ],
  ],
  [
    [
      queue(8, 'aa'),
      queue(9, 'bb'),
      { op: 'take', id: 9 },
      { op: 'take', id: 8 },
      { op: 'take', id: 8 },
    ],
  ],
  [[queue(10, 'aa'), { op: 'emit', c: 0 }, { op: 'emit', c: 0 }, { op: 'take', id: 10 }]],
  [
    [
      queue(11, 'aa'),
      queue(11, 'bb'),
      { op: 'emit', c: 0 },
      { op: 'take', id: 11 },
      { op: 'emit', c: 1 },
    ],
  ],
  [[queue(12, 'aa', undefined, true), { op: 'emit', c: 0 }, { op: 'take', id: 12 }]],
  [
    [
      { op: 'take', id: 99 },
      { op: 'takeEntry', id: 99 },
    ],
  ],
  [
    [
      queue(-1, 'cc'),
      queue(0, 'dd'),
      queue(2.5, 'ee'),
      { op: 'take', id: -1 },
      { op: 'take', id: 2.5 },
      { op: 'take', id: 0 },
    ],
  ],
]

export const group: Group = {
  // ---------- cfb-sniff.ts ----------
  'cfb-sniff.isCfbHeader': {
    ts: (a) => isCfbHeader(bytes(a, 0)),
    cases: cases(
      [hx(Buffer.from(CFB_MAGIC))],
      [hx(Buffer.from(CFB_MAGIC.slice(0, 7)))],
      [hx(cfb())],
      [hx(Buffer.from([...CFB_MAGIC.slice(0, 7), 0xe0]))],
      [hx(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))],
      [''],
    ),
  },
  'cfb-sniff.cfbKind': {
    ts: (a) => cfbKind(bytes(a, 0)),
    cases: [
      ...cfbSamples.map(([note, b]): Case => ({ args: [hx(b)], note })),
      ...cases(
        [hx(Buffer.from('PK\u0003\u0004 not a compound file'))],
        [''],
        [hx(Buffer.from(CFB_MAGIC.slice(0, 7)))],
      ),
    ],
  },

  // ---------- export-images.ts ----------
  'slides/export-images.buildExportImagePaths': {
    ts: (a) => buildExportImagePaths(str(a, 0), str(a, 1), a[2] as number, str(a, 3) as 'png'),
    cases: cases(
      ['/out', 'deck', 3, 'png'],
      ['/out/', 'deck', 1, 'jpg'],
      ['', 'deck', 2, 'png'],
      ['/out', 'deck', 0, 'png'],
      ['/out', 'deck', -4, 'png'],
      ['/out', 'deck', 99, 'png'],
      ['/out', 'deck', 100, 'png'],
      ['/out', 'deck', 101, 'jpg'],
      ['/out', 'deck', 2.9, 'png'],
      ['/out', 'deck', 0.5, 'png'],
      ['/out', 'deck', null, 'png'],
      ['/out/./sub/../x', 'a b/c', 2, 'png'],
      ['/out', '\u00e9\u{1F600}', 2, 'jpg'],
      ['rel', '', 1, ''],
    ),
  },

  // ---------- font-scan.ts ----------
  'font-scan.scanFontDirs': {
    ts: (a) => scanFontDirs(a[0] as ScanTask[], a[1] as number),
    cases: [
      { args: [[], 5000], note: 'no task' },
      {
        args: [[{ kind: 'flat', dir: '$DIR/fonts' }], 5000],
        files: {
          'fonts/a.ttf': 'x',
          'fonts/B.OTF': 'x',
          'fonts/c.ttc': 'x',
          'fonts/d.OtC': 'x',
          'fonts/e.txt': 'x',
          'fonts/f.ttf.bak': 'x',
          'fonts/ttf': 'x',
          'fonts/.ttf': 'x',
          'fonts/dir.ttf': { dir: true },
          'fonts/\u00e9.ttf': 'x',
          'fonts/g.ttf\n': 'x',
          'fonts/h.ttf\u212a': 'x',
        },
        note: 'extensions, case, a folder named like a font, line feed after the extension',
      },
      { args: [[{ kind: 'flat', dir: '$DIR/missing' }], 5000], note: 'unreadable dir' },
      { args: [[{ kind: 'flat', dir: '$DIR/file' }], 5000], files: { file: 'x' }, note: 'a file' },
      {
        args: [
          [
            { kind: 'cloud', base: '$DIR/cloud', sub: 'Fonts' },
            { kind: 'flat', dir: '$DIR/flat' },
            { kind: 'cloud', base: '$DIR/none', sub: 'x' },
          ],
          5000,
        ],
        files: {
          'cloud/id1/Fonts/Family One/1001.ttf': 'x',
          'cloud/id1/Fonts/Family One/1002.otf': 'x',
          'cloud/id1/Fonts/Empty Family/readme.txt': 'x',
          'cloud/id1/Fonts/Family Two/2001.TTC': 'x',
          'cloud/id1/Fonts/stray.ttf': 'x',
          'cloud/id2/Other/Family Three/3001.ttf': 'x',
          'cloud/id3/Fonts/Family Four/dir.ttf': { dir: true },
          'cloud/idfile': 'x',
          'cloud/id4/Fonts': 'a file where the families are',
          'flat/z.ttf': 'x',
        },
        note: 'cloud roots, empty families dropped, a root that is not readable',
      },
      {
        args: [
          [
            { kind: 'cloud', base: '$DIR/c', sub: 'S' },
            { kind: 'cloud', base: '$DIR/c', sub: 'S/Sub' },
          ],
          5000,
        ],
        files: { 'c/1/S/F/1.ttf': 'x', 'c/1/S/Sub/G/2.otf': 'x', 'c/2/S/F/3.ttf': 'x' },
        note: 'two cloud tasks over one base',
      },
    ],
  },

  // ---------- generated-page-temp.ts ----------
  'generated-page-temp.GENERATED_PAGE_TTL_MS': constant(GENERATED_PAGE_TTL_MS),
  'generated-page-temp.cleanupExpiredGeneratedPages': {
    ts: (a) => cleanupExpiredGeneratedPages(str(a, 0), a[1] as number),
    cases: (() => {
      const NOW = 1_700_000_000_000
      const day = 24 * 60 * 60 * 1000
      const old = NOW - 8 * day
      const edge = NOW - 7 * day
      const fresh = NOW - 6 * day
      const uuid = (n: number, tail = 'a'): string =>
        `1234567${n}-89ab-4cde-8f01-23456789abc${tail}`
      return [
        {
          args: ['$DIR', NOW],
          files: {
            [`seuoffice-local-pages/${uuid(1)}.pptx`]: { text: 'old', mtimeMs: old },
            [`seuoffice-local-pages/${uuid(2)}.pptx`]: { text: 'fresh', mtimeMs: fresh },
            [`seuoffice-local-pages/${uuid(3)}.pptx`]: { text: 'at the cutoff', mtimeMs: edge },
            [`seuoffice-local-pages/${uuid(4)}.pptx`]: { text: 'one ms older', mtimeMs: edge - 1 },
            [`seuoffice-cloud-pages/${uuid(5)}.pptx`]: { text: 'cloud old', mtimeMs: old },
            [`seuoffice-cloud-pages/${uuid(6, 'B')}.PPTX`]: { text: 'upper case', mtimeMs: old },
          },
          note: 'both folders, the cutoff, upper case',
        },
        {
          args: ['$DIR', NOW],
          files: {
            'seuoffice-local-pages/notes.txt': { text: 'x', mtimeMs: old },
            'seuoffice-local-pages/deck.pptx': { text: 'x', mtimeMs: old },
            [`seuoffice-local-pages/${uuid(1)}.pptx.bak`]: { text: 'x', mtimeMs: old },
            [`seuoffice-local-pages/x${uuid(1)}.pptx`]: { text: 'x', mtimeMs: old },
            [`seuoffice-local-pages/${uuid(1)}.pptx\n`]: { text: 'line feed', mtimeMs: old },
            [`seuoffice-local-pages/${uuid(7).replace('-4cde-', '-9cde-')}.pptx`]: {
              text: 'version 9',
              mtimeMs: old,
            },
            [`seuoffice-local-pages/${uuid(7).replace('-8f01-', '-cf01-')}.pptx`]: {
              text: 'variant c',
              mtimeMs: old,
            },
            [`seuoffice-local-pages/${uuid(8).replace('-4cde-', '-8cde-')}.pptx`]: {
              text: 'version 8',
              mtimeMs: old,
            },
            [`seuoffice-local-pages/${uuid(8).replace('-4cde-', '-0cde-')}.pptx`]: {
              text: 'version 0',
              mtimeMs: old,
            },
            [`seuoffice-local-pages/${uuid(9)}.pptx/inner.txt`]: {
              text: 'a folder named like a page',
              mtimeMs: old,
            },
            [`seuoffice-other/${uuid(1)}.pptx`]: { text: 'another folder', mtimeMs: old },
            [`nested/seuoffice-local-pages/${uuid(1)}.pptx`]: { text: 'nested', mtimeMs: old },
          },
          note: 'names that are not generated pages stay',
        },
        { args: ['$DIR/none', NOW], note: 'no folder' },
        {
          args: ['$DIR', NOW],
          files: { 'seuoffice-local-pages': 'a file' },
          note: 'a file where the folder should be',
        },
        {
          args: ['$DIR', NOW + 30 * day],
          files: { [`seuoffice-local-pages/${uuid(1)}.pptx`]: { text: 'x', mtimeMs: NOW } },
          note: 'later clock',
        },
        {
          args: ['$DIR', 0],
          files: { [`seuoffice-local-pages/${uuid(1)}.pptx`]: { text: 'x', mtimeMs: 1000 } },
          note: 'clock at zero',
        },
      ] as Case[]
    })(),
  },

  // ---------- jpeg-orientation.ts ----------
  'jpeg-orientation.neutralizeJpegOrientation': {
    ts: (a) => hx(neutralizeJpegOrientation(new Uint8Array(bytes(a, 0)))),
    cases: [
      ...jpegSamples.map(([note, b]): Case => ({ args: [hx(b)], note })),
      ...cases([''], ['ff'], ['ffd8ffd9']),
    ],
  },

  // ---------- media-mime.ts ----------
  'media-mime.sniffImageMime': {
    ts: (a) => sniffImageMime(new Uint8Array(bytes(a, 0))),
    cases: mimeSamples.map(([note, b]): Case => ({ args: [hx(b)], note })),
  },
  'media-mime.rasterImageExt': {
    ts: (a) => rasterImageExt(new Uint8Array(bytes(a, 0))),
    cases: mimeSamples.map(([note, b]): Case => ({ args: [hx(b)], note })),
  },
  'media-mime.displayMime': {
    ts: (a) => displayMime(str(a, 0), new Uint8Array(bytes(a, 1))),
    cases: [
      ...[
        'a.png',
        'a.JPG',
        'a.jpeg',
        'a.gif',
        'a.bmp',
        'a.webp',
        'a.SVG',
        'a.tif',
        'a.TIFF',
        'a.emf',
        'a.WMF',
        'media/image1.unknown',
        'noext',
        '',
        '.',
        'a.',
        '.png',
        'a.b.c.png',
        'a.png ',
        'a.\u0130',
        'a.\u0049\u0307',
        'a.\u212apg',
        'dir.d/file',
        'a.constructor',
        'constructor',
        'a.__proto__',
        'a.toString',
        'a.hasOwnProperty',
        'caf\u00e9.JPG',
        'a.\u{1F600}',
      ].map((ref): Case => ({ args: [ref, '00000000'], note: 'extension' })),
      ...cases(
        ['a.emf', hx(Buffer.from(PNG))],
        ['a.png', hx(emfHeader())],
        ['a.jpg', hx(cat('GIF89a'))],
        ['a.constructor', hx(Buffer.from([0xff, 0xd8, 0xff]))],
        ['image.png', ''],
      ),
    ],
  },

  // ---------- metafile-fonts.ts ----------
  'metafile-fonts.MAX_METAFILE_GUNZIP_BYTES': constant(MAX_METAFILE_GUNZIP_BYTES),
  'metafile-fonts.scanMetafileFonts': {
    ts: (a) => scanMetafileFonts(new Uint8Array(bytes(a, 0))),
    cases: [
      ...metafiles.map(([note, b]): Case => ({ args: [hx(b)], note })),
      ...gzSamples.map(([note, b]): Case => ({ args: [hx(b)], note })),
      { args: [hx(bomb)], note: 'gzip bomb: twice the limit' },
      { args: [hx(overLimit)], note: 'one byte over the limit, EMF header first' },
      { args: [hx(atLimit)], note: 'exactly the limit' },
      { args: [hx(atLimitWithFont)], note: 'exactly the limit, a font in it' },
    ],
  },
  'metafile-fonts.listMetafileFonts': {
    ts: (a) =>
      listMetafileFonts({
        entries: new Map(
          (a[0] as [string, string][]).map(([p, h]) => [p, new Uint8Array(Buffer.from(h, 'hex'))]),
        ),
      } as never),
    cases: cases(
      [[]],
      [[['ppt/media/image1.emf', hx(emf(emfFont('Calibri', 400, 0)))]]],
      [
        [
          ['ppt/media/a.emf', hx(emf(emfFont('Same', 400, 0)))],
          ['ppt/media/b.WMF', hx(wmf(true, wmfFont('same', 400, 0), wmfFont('Other', 700, 1)))],
          ['ppt/media/c.emz', hx(gzipSync(emf(emfFont('Zipped', 400, 1))))],
          ['ppt/media/d.wmz', hx(gzipSync(wmf(false, wmfFont('Zipped', 400, 1))))],
        ],
      ],
      [
        [
          ['ppt/media/image1.png', hx(emf(emfFont('NotMedia', 400, 0)))],
          ['ppt/media/sub/x.emf', hx(emf(emfFont('Nested', 400, 0)))],
          ['ppt/media/.emf', hx(emf(emfFont('Hidden', 400, 0)))],
          ['ppt/media/x.emf\n', hx(emf(emfFont('Line', 400, 0)))],
          ['xppt/media/x.emf', hx(emf(emfFont('Prefix', 400, 0)))],
          ['PPT/MEDIA/UP.EMF', hx(emf(emfFont('Upper', 400, 0)))],
          ['ppt/media/short.emf', ''],
        ],
      ],
      [
        [
          ['ppt/media/1.emf', hx(emf(emfFont('First', 400, 0), emfFont('Second', 400, 0)))],
          ['ppt/media/2.emf', hx(emf(emfFont('first', 400, 0), emfFont('Third', 400, 0)))],
        ],
      ],
    ),
  },

  // ---------- mp4-audio-sniff.ts ----------
  'mp4-audio-sniff.audioSampleFormats': {
    ts: (a) => audioSampleFormats(new Uint8Array(bytes(a, 0))),
    cases: mp4s.map(([note, b]): Case => ({ args: [hx(b)], note })),
  },
  'mp4-audio-sniff.mp4VideoSize': {
    ts: (a) => mp4VideoSize(new Uint8Array(bytes(a, 0))),
    cases: mp4s.map(([note, b]): Case => ({ args: [hx(b)], note })),
  },
  'mp4-audio-sniff.unplayableAudioCodec': {
    ts: (a) => unplayableAudioCodec(new Uint8Array(bytes(a, 0))),
    cases: mp4s.map(([note, b]): Case => ({ args: [hx(b)], note })),
  },

  // ---------- paste-cascade.ts ----------
  'paste-cascade.newPasteCascade': {
    ts: (a) => {
      const clip = newPasteCascade(a[0] as string | null)
      return { sourceKey: clip.sourceKey, counts: [...clip.counts] }
    },
    cases: cases(['1:0'], [null], [''], ['\u00e9:\u{1F600}']),
  },
  'paste-cascade.pageKey': {
    ts: (a) => pageKey(a[0] as number, a[1] as number),
    cases: cases(
      [1, 0],
      [7, 12],
      [0, 0],
      [-1, -2],
      [1.5, 2.25],
      [1e21, 1],
      [1e-7, 123456789012345680000],
      [2 ** 53, 5],
    ),
  },
  'paste-cascade.pasteShiftPx': {
    ts: (a) => {
      const clip = newPasteCascade(a[0] as string | null)
      for (const key of a[1] as string[]) recordPaste(clip, key)
      return pasteShiftPx(clip, str(a, 2))
    },
    cases: cases(
      ['1:0', [], '1:0'],
      ['1:0', [], '1:1'],
      ['1:0', ['1:0'], '1:0'],
      ['1:0', ['1:0', '1:0', '1:0'], '1:0'],
      ['1:0', ['1:1', '1:1'], '1:1'],
      ['1:0', ['1:1', '1:1'], '1:0'],
      [null, [], '1:0'],
      [null, ['1:0'], '1:0'],
      [null, ['1:0', '1:0'], '1:0'],
      ['', [], ''],
      ['', [''], ''],
      ['1:0', ['__proto__', 'constructor'], '__proto__'],
    ),
  },
  'paste-cascade.recordPaste': {
    ts: (a) => {
      const clip = newPasteCascade(a[0] as string | null)
      for (const key of a[1] as string[]) recordPaste(clip, key)
      recordPaste(clip, str(a, 2))
      return [...clip.counts]
    },
    cases: cases(
      ['1:0', [], '1:0'],
      ['1:0', ['1:0'], '1:0'],
      ['1:0', ['1:0', '2:0', '1:0'], '2:0'],
      [null, ['b', 'a'], 'c'],
      [null, ['b', 'a'], 'a'],
      [null, ['10', '2'], '1'],
      ['x', [], '__proto__'],
    ),
  },

  // ---------- pdf-export.ts ----------
  'slides/pdf-export.buildPdfLinkOverlays': {
    ts: (a) => buildPdfLinkOverlays(orUndefined(a[0]) as never),
    cases: cases(
      [null],
      [[]],
      [[{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, href: 'https://example.com/a?b=1&c=2' }]],
      [
        [
          { x: 0, y: 0, w: 1, h: 1, href: '#pg3' },
          { x: 0.5, y: 0.25, w: 0.125, h: 0.0625, href: 'mailto:a@b.c' },
        ],
      ],
      [[{ x: 1 / 3, y: 2 / 3, w: 0.123456, h: 0.9999999, href: 'x' }]],
      [[{ x: -0.5, y: -0.000001, w: 0.0000049, h: 12345.678, href: 'x' }]],
      [
        [
          { x: null, y: 0, w: 1, h: 1, href: 'nan' },
          { x: 0, y: 0, w: 1, h: 1, href: 'ok' },
        ],
      ],
      [[{ x: 1e305, y: 0, w: 1, h: 1, href: 'huge' }]],
      [
        [
          { x: 0, y: 0, w: 1, h: 1, href: '' },
          { x: 0, y: 0, w: 1, h: 1, href: 'kept' },
        ],
      ],
      [[{ x: 0, y: 0, w: 1, h: 1, href: '"><script>&amp;\'' }]],
      [[{ x: 0.05, y: 0.15, w: 0.25, h: 0.35, href: '\u00e9\u{1F600}' }]],
    ),
  },
  'slides/pdf-export.buildPdfExportHtml': {
    ts: (a) =>
      buildPdfExportHtml(
        a[0] as never,
        a[1] as number,
        a[2] as number,
        orUndefined(a[3]) as never,
        orUndefined(a[4]) as never,
      ),
    cases: cases(
      [[], 13.333, 7.5, null, null],
      [[{ svg: '<svg/>' }, { png: 'AAAA' }], 13.333, 7.5, null, null],
      [[{ svg: '<svg/>' }], 10, 7.5, [[{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, href: '#pg2' }]], null],
      [
        [{ png: 'A' }, { png: 'B' }, { svg: 'C' }],
        10,
        7.5,
        [[], [{ x: 0, y: 0, w: 1, h: 1, href: 'u' }]],
        '@font-face { font-family: X; }',
      ],
      [[{ png: 'A' }], 10, 7.5, null, 'a{}</style><script>x</script>'],
      [[{ png: 'A' }], 10, 7.5, null, 'a{}</STYLE>b</Style c</sty'],
      [[{ png: 'A' }], 10, 7.5, null, ''],
      [[{ png: 'A' }], 1e21, 1e-7, null, null],
      [[{ png: 'A' }], 0.1, 0.25, null, null],
      [
        [{ svg: '<svg>\u00e9\u{1F600}</svg>' }],
        13.333,
        7.5,
        [[{ x: 0, y: 0, w: 1, h: 1, href: 'a"b' }]],
        null,
      ],
    ),
  },
  'slides/pdf-export.PRINT_READY_SCRIPT': constant(PRINT_READY_SCRIPT),
  'slides/pdf-export.PDF_EXPORT_HEIGHT_IN': constant(PDF_EXPORT_HEIGHT_IN),
  'slides/pdf-export.PDF_EXPORT_TIMEOUT_MS': constant(PDF_EXPORT_TIMEOUT_MS),
  'slides/pdf-export.exportPageWidthIn': {
    ts: (a) => exportPageWidthIn(a[0] as number, a[1] as number),
    cases: cases(
      [1920, 1080],
      [1024, 768],
      [1, 1],
      [0, 0],
      [100, 0],
      [0, 100],
      [-5, 10],
      [5, -10],
      [1, 1000],
      [1000, 1],
      [1280, 720.5],
      [null, 5],
      [5, null],
      [1e308, 1],
      [1e-300, 1],
      [Infinity, 1],
      [1, Infinity],
    ),
  },
  'slides/pdf-export.exportSlidesPdf': {
    ts: async (a, cx) => {
      const o = a[0] as {
        pages: never
        widthPx: number
        heightPx: number
        filePath: string
        links?: never
        fontCss?: string | null
        timeoutMs?: number | null
        script: PdfScript
      }
      const s = o.script
      let workDir: string | undefined
      const never = <T>(): Promise<T> => new Promise<T>(() => {})
      try {
        const value = await exportSlidesPdf({
          pages: o.pages,
          widthPx: o.widthPx,
          heightPx: o.heightPx,
          filePath: o.filePath,
          ...(o.links ? { links: o.links } : {}),
          ...(o.fontCss ? { fontCss: o.fontCss } : {}),
          ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
          createWindow() {
            cx.log('createWindow')
            if (s.createWindow === 'throws') throw new Error('createWindow threw')
            return {
              async loadFile(path: string) {
                workDir = path.slice(0, path.lastIndexOf('/'))
                cx.log('loadFile', maskRand(path), readFileSync(path, 'utf8'))
                if (s.loadFile === 'throws') throw new Error('load failed')
                if (s.loadFile === 'hangs') return never<void>()
              },
              webContents: {
                async executeJavaScript(script: string, userGesture?: boolean) {
                  cx.log('executeJavaScript', script, userGesture)
                  if (s.executeJavaScript === 'throws') throw new Error('execute failed')
                  if (s.executeJavaScript === 'hangs') return never<void>()
                },
                async printToPDF(options: unknown) {
                  cx.log('printToPDF', options)
                  if (s.printToPDF === 'throws') throw new Error('printToPDF threw')
                  if (s.printToPDF === 'hangs') return never<Buffer>()
                  return Buffer.from(s.pdfHex ?? '', 'hex')
                },
              },
              destroy() {
                cx.log('destroy')
                if (s.destroyThrows) throw new Error('destroy threw')
              },
            } as never
          },
          openExportedPdf(path: string) {
            cx.log('openExportedPdf', path)
            if (s.openThrows) throw new Error('open threw')
          },
        })
        return JSON.parse(maskRand(JSON.stringify(value)))
      } catch (error) {
        if (error instanceof Error) error.message = maskRand(error.message)
        throw error
      } finally {
        if (workDir) rmSync(workDir, { recursive: true, force: true })
      }
    },
    cases: [
      pdfCase(
        {
          links: [[{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, href: '#pg2' }], []],
          fontCss: '@font-face { font-family: F; src: url(data:font/woff2;base64,AAAA); }',
        },
        {},
        'success with links and fonts',
      ),
      pdfCase({ widthPx: 1024, heightPx: 768, pages: [] }, { pdfHex: '' }, 'no pages, 4:3'),
      pdfCase({}, { loadFile: 'throws' }, 'loadFile throws'),
      pdfCase({}, { executeJavaScript: 'throws' }, 'executeJavaScript throws'),
      pdfCase({}, { printToPDF: 'throws' }, 'printToPDF throws'),
      pdfCase({ timeoutMs: 30 }, { loadFile: 'hangs' }, 'loadFile never settles'),
      pdfCase(
        { timeoutMs: 30 },
        { executeJavaScript: 'hangs' },
        'the print-ready script never settles',
      ),
      pdfCase({ timeoutMs: 30 }, { printToPDF: 'hangs' }, 'printToPDF never settles'),
      pdfCase({}, { destroyThrows: true }, 'destroy throws after a good export'),
      pdfCase({}, { loadFile: 'throws', destroyThrows: true }, 'both fail'),
      pdfCase({}, { createWindow: 'throws' }, 'createWindow throws'),
      pdfCase({}, { openThrows: true }, 'opening the exported file throws'),
      pdfCase({ filePath: '$DIR/missing/out.pdf' }, {}, 'target folder missing'),
      pdfCase({ filePath: '$DIR' }, {}, 'target is a folder'),
      pdfCase(
        { widthPx: 0, heightPx: 0, fontCss: 'x</style>y' },
        {},
        'degenerate size, style end in css',
      ),
    ],
  },

  // ---------- picture-frame.ts ----------
  'picture-frame.DEFAULT_PICTURE_DPI': constant(DEFAULT_PICTURE_DPI),
  'picture-frame.pictureFrame': {
    ts: (a) =>
      pictureFrame(
        a[0] as never,
        a[1] as never,
        orUndefined(a[2]) as never,
        orUndefined(a[3]) as never,
        orUndefined(a[4]) as never,
      ),
    cases: cases(
      [slide, { width: 1024, height: 768 }, { x: 96, y: 96 }, null, null],
      [slide, { width: 1024, height: 768 }, null, null, null],
      [slide, { width: 1024, height: 768 }, null, 96, null],
      [slide, { width: 1024, height: 768 }, { x: 72, y: 72 }, null, null],
      [slide, { width: 1024, height: 768 }, { x: 300, y: 150 }, 96, null],
      [slide, { width: 6000, height: 4000 }, { x: 72, y: 72 }, null, null],
      [slide, { width: 400, height: 9000 }, { x: 72, y: 72 }, null, null],
      [slide, null, null, null, null],
      [slide, { width: 0, height: 100 }, null, null, null],
      [slide, { width: 100, height: -1 }, null, null, null],
      [slide, { width: 100, height: 100 }, { x: 72, y: 72 }, null, { minEmu: 2000000 }],
      [slide, { width: 10, height: 10 }, { x: 72, y: 72 }, null, { minEmu: 12700000 }],
      [slide, { width: 100, height: 50 }, { x: 72, y: 72 }, null, { minEmu: 999999999 }],
      [
        slide,
        { width: 100, height: 50 },
        { x: 72, y: 72 },
        null,
        { center: { x: 1000000, y: 2000000 } },
      ],
      [
        slide,
        { width: 100, height: 50 },
        { x: 72, y: 72 },
        null,
        { center: { x: 1000000, y: 2000000 }, minEmu: 3000000 },
      ],
      [
        { width: 5000000, height: 3000000 },
        { width: 800, height: 600 },
        { x: 72, y: 72 },
        null,
        null,
      ],
      [{ width: 0, height: 0 }, { width: 800, height: 600 }, null, null, null],
      [{ width: 0, height: 0 }, null, null, null, null],
      [
        { width: 9144000, height: 6858000 },
        { width: 1.5, height: 2.5 },
        { x: 0.5, y: 3 },
        null,
        { minEmu: 1 },
      ],
    ),
  },

  // ---------- save-as-formats.ts ----------
  'slides/save-as-formats.slidesSaveAsFilters': {
    ts: (a) => slidesSaveAsFilters((key) => `${str(a, 0)}:${key}`),
    cases: cases(['PNG slides'], [''], ['\u00e9\u{1F600}']),
  },
  'slides/save-as-formats.slidesSaveAsSuggestion': {
    ts: (a) => slidesSaveAsSuggestion(str(a, 0)),
    cases: cases(
      ['/a/deck.pptx'],
      ['/a/DECK.PPTX'],
      ['deck.PpTx'],
      ['deck.pptx.pptx'],
      ['deck.ppt'],
      ['deck.pptxx'],
      ['deck.pptx\n'],
      [''],
      ['.pptx'],
      ['deck'],
      ['a.pptx.b'],
      ['caf\u00e9 \u{1F600}.pptx'],
      ['deck\u212a.pptx'],
    ),
  },
  'slides/save-as-formats.resolveSlidesSaveAsPick': {
    ts: (a) => resolveSlidesSaveAsPick(str(a, 0)),
    cases: cases(
      ['/a/deck.pdf'],
      ['/a/DECK.PDF'],
      ['/a/deck.png'],
      ['/a/deck.PnG'],
      ['/a/deck'],
      ['/a/deck.pptx'],
      ['/a/deck.key'],
      ['/a.d/deck'],
      ['C:\\a.d\\deck'],
      ['C:\\a\\deck.pdf'],
      ['.hidden'],
      ['/a/.hidden'],
      ['/a/x.'],
      ['deck.'],
      [''],
      ['/'],
      ['deck.pdf '],
      ['deck.png.bak'],
      ['\u0130.pdf'],
      ['r\u00e9sum\u00e9.PNG'],
      ['\u{1F600}/\u{1F600}'],
      ['\u{1F600}/.\u{1F600}'],
      ['a/\u{1F600}.b'],
    ),
  },
  'slides/save-as-formats.SaveAsImageTargets': {
    ts: (a) => {
      const targets = new SaveAsImageTargets()
      const results: unknown[] = []
      for (const op of a[0] as Op[]) {
        switch (op.op) {
          case 'authorize':
            targets.authorize(op.wcId as number, op.path as string)
            results.push(null)
            break
          case 'take':
            try {
              results.push(
                targets.take(
                  op.wcId as number,
                  op.path as string,
                  op.count === null ? NaN : (op.count as number),
                ),
              )
            } catch (error) {
              results.push({ throws: (error as Error).message })
            }
            break
          case 'forget':
            targets.forget(op.wcId as number)
            results.push(null)
            break
          default:
            throw new Error('unsupported op')
        }
      }
      return results
    },
    cases: cases(
      [[{ op: 'take', wcId: 1, path: '/a/deck.png', count: 3 }]],
      [
        [
          { op: 'authorize', wcId: 1, path: '/a/deck.png' },
          { op: 'take', wcId: 1, path: '/a/deck.png', count: 3 },
          { op: 'take', wcId: 1, path: '/a/deck.png', count: 3 },
        ],
      ],
      [
        [
          { op: 'authorize', wcId: 1, path: '/a/deck.png' },
          { op: 'take', wcId: 1, path: '/a/other.png', count: 1 },
          { op: 'take', wcId: 1, path: '/a/deck.png', count: 1 },
        ],
      ],
      [
        [
          { op: 'authorize', wcId: 1, path: '/a/deck.png' },
          { op: 'take', wcId: 2, path: '/a/deck.png', count: 1 },
          { op: 'take', wcId: 1, path: '/a/deck.png', count: 0 },
        ],
      ],
      [
        [
          { op: 'authorize', wcId: 1, path: '/a/one.png' },
          { op: 'authorize', wcId: 1, path: '/a/two.png' },
          { op: 'take', wcId: 1, path: '/a/one.png', count: 2 },
          { op: 'take', wcId: 1, path: '/a/two.png', count: 2 },
        ],
      ],
      [
        [
          { op: 'authorize', wcId: 3, path: '/a/d.png' },
          { op: 'forget', wcId: 3 },
          { op: 'take', wcId: 3, path: '/a/d.png', count: 2 },
          { op: 'forget', wcId: 9 },
        ],
      ],
      [
        [
          { op: 'authorize', wcId: 1, path: 'd' },
          { op: 'take', wcId: 1, path: 'd', count: 101 },
        ],
      ],
      [
        [
          { op: 'authorize', wcId: 1, path: 'd.png' },
          { op: 'take', wcId: 1, path: 'd.png', count: null },
          { op: 'take', wcId: 1, path: 'd.png', count: 2 },
        ],
      ],
      [
        [
          { op: 'authorize', wcId: 1, path: 'd.png' },
          { op: 'take', wcId: 1, path: 'd.png', count: -2 },
        ],
      ],
      [
        [
          { op: 'authorize', wcId: 1.5, path: 'd.png' },
          { op: 'authorize', wcId: -1, path: 'e.png' },
          { op: 'take', wcId: 1.5, path: 'd.png', count: 2.5 },
          { op: 'take', wcId: -1, path: 'e.png', count: 1 },
        ],
      ],
    ),
  },

  // ---------- seed-queue.ts ----------
  'seed-queue.queueSlidesSeedFor': {
    ts: (a) => runSeeds(a),
    cases: seedScripts.map((args): Case => ({ args })),
  },
  'seed-queue.takeSlidesSeed': {
    ts: (a) => runSeeds(a),
    cases: seedScripts.slice(0, 9).map((args): Case => ({ args })),
  },
  'seed-queue.takeSlidesSeedEntry': {
    ts: (a) => runSeeds(a),
    cases: seedScripts.slice(1, 13).map((args): Case => ({ args })),
  },

  // ---------- template-selection-store.ts ----------
  'template-selection-store.TEMPLATE_SELECTION_FILE': constant(TEMPLATE_SELECTION_FILE),
  'template-selection-store.TEMPLATE_SELECTION_MAX_DOCUMENTS': constant(
    TEMPLATE_SELECTION_MAX_DOCUMENTS,
  ),
  'template-selection-store.TEMPLATE_SELECTION_TOUCH_INTERVAL_MS': constant(
    TEMPLATE_SELECTION_TOUCH_INTERVAL_MS,
  ),
  'template-selection-store.TemplateSelectionStore': {
    ts: (a, cx) => runStore(a, cx),
    cases: [
      storeCase([{ op: 'get', path: A }], undefined, {}, 'nothing stored'),
      storeCase(
        [
          { op: 'set', path: A, input: sel('builtin', 'modern', ['mostly blue']) },
          { op: 'get', path: A },
          { op: 'get', path: B },
          { op: 'set', path: A, input: null },
          { op: 'get', path: A },
        ],
        undefined,
        {},
        'set, get, forget',
      ),
      storeCase(
        [
          { op: 'set', path: A, input: sel('saved', 'My Style') },
          { op: 'set', path: A, input: { kind: 'nope', key: 'x' } },
          { op: 'set', path: A, input: { kind: 'builtin', key: '' } },
          { op: 'set', path: A, input: { kind: 'builtin', key: '   ' } },
          { op: 'set', path: A, input: { kind: 'builtin', key: 'k'.repeat(129) } },
          { op: 'set', path: A, input: { kind: 'builtin', key: 'k'.repeat(128) } },
          { op: 'set', path: A, input: { kind: 'builtin', key: 'x', adjustments: 'text' } },
          { op: 'set', path: A, input: { kind: 'builtin', key: 'x', adjustments: {} } },
          { op: 'set', path: A, input: [1, 2] },
          { op: 'set', path: A, input: 'text' },
          { op: 'set', path: A, input: 7 },
          { op: 'set', path: A, input: true },
          { op: 'set', path: A },
          { op: 'get', path: A },
        ],
        undefined,
        {},
        'inputs that are not selections are ignored',
      ),
      storeCase(
        [
          { op: 'set', path: A, input: { kind: 'builtin', key: 'x', adjustments: null } },
          { op: 'set', path: B, input: { kind: 'builtin', key: 'x' } },
          {
            op: 'set',
            path: A,
            input: {
              kind: 'builtin',
              key: 'astral \u{1F600} key',
              adjustments: [' trim me ', '', '   ', 5, null, {}, 'two'],
              updatedAt: 99,
              usedAt: 98,
              extra: true,
            },
          },
          { op: 'get', path: A },
        ],
        undefined,
        {},
        'adjustments normalized, extra keys dropped',
      ),
      storeCase(
        [
          {
            op: 'set',
            path: A,
            input: sel('builtin', 'x', ['a'.repeat(300), 'b'.repeat(300), 'c'.repeat(100)]),
          },
          { op: 'set', path: B, input: sel('builtin', 'x', ['d'.repeat(700)]) },
          { op: 'set', path: C, input: sel('builtin', 'x', ['e'.repeat(599) + '\u{1F600}']) },
          {
            op: 'set',
            path: SH,
            input: sel('builtin', 'x', ['f'.repeat(598) + '\u{1F600}', 'older', 'g']),
          },
          { op: 'set', path: ACCENT_NFC, input: sel('builtin', 'x', ['h'.repeat(600), 'i']) },
        ],
        undefined,
        {},
        'adjustments over the cap: oldest dropped, newest cut at a code point',
      ),
      storeCase(
        [
          { op: 'set', path: C, input: sel('builtin', 'tmp') },
          { op: 'set', path: SH, input: sel('saved', 'sh') },
          { op: 'get', path: C },
          { op: 'get', path: '/private/tmp/seu-tpl-absent.pptx' },
          { op: 'get', path: SH },
        ],
        undefined,
        {},
        'a path that resolves, and one spelled as it resolves',
      ),
      storeCase(
        [
          { op: 'set', path: ACCENT_NFC, input: sel('builtin', 'nfc') },
          { op: 'get', path: ACCENT_NFD },
          { op: 'set', path: ACCENT_NFD, input: sel('builtin', 'nfd') },
          { op: 'get', path: ACCENT_NFC },
        ],
        undefined,
        {},
        'two spellings of one name',
      ),
      storeCase(
        [
          { op: 'set', path: A, input: sel('builtin', 'one') },
          { op: 'copy', from: A, to: B },
          { op: 'get', path: B },
          { op: 'get', path: A },
          { op: 'move', from: B, to: C },
          { op: 'get', path: B },
          { op: 'get', path: C },
          { op: 'copy', from: SH, to: C },
          { op: 'get', path: C },
        ],
        undefined,
        {},
        'copy, move, and a copy from a path with no record',
      ),
      storeCase(
        [
          { op: 'set', path: A, input: sel('builtin', 'one') },
          { op: 'set', path: B, input: sel('builtin', 'two') },
          { op: 'move', from: A, to: A },
          { op: 'copy', from: A, to: A },
          { op: 'move', from: A, to: B },
          { op: 'get', path: A },
          { op: 'get', path: B },
          { op: 'move', from: SH, to: SH },
          { op: 'copy', from: '/nothing/here.pptx', to: '/nothing/there.pptx' },
        ],
        undefined,
        {},
        'onto itself, onto a record, nothing to move',
      ),
      storeCase(
        [
          { op: 'set', path: '/tmp/q-one.pptx', input: sel('builtin', 'one') },
          { op: 'move', from: '/tmp/q-one.pptx', to: '/private/tmp/q-one.pptx' },
          { op: 'get', path: '/tmp/q-one.pptx' },
          { op: 'copy', from: '/private/tmp/q-one.pptx', to: '/tmp/q-one.pptx' },
          {
            op: 'put',
            path: '/nowhere/x.pptx',
            selection: {
              kind: 'saved',
              key: 'under the given spelling',
              adjustments: [],
              updatedAt: 4,
            },
          },
          { op: 'copy', from: '/nowhere/x.pptx', to: '/nowhere/../nowhere/x.pptx' },
          { op: 'move', from: '/nowhere/x.pptx', to: '/tmp/q-two.pptx' },
          { op: 'get', path: '/tmp/q-two.pptx' },
          { op: 'get', path: '/nowhere/x.pptx' },
        ],
        undefined,
        {},
        'two paths of one file',
      ),
      storeCase(
        [
          {
            op: 'put',
            path: A,
            selection: { kind: 'builtin', key: 'as it is', adjustments: ['x'], updatedAt: 1234 },
          },
          { op: 'get', path: A },
          { op: 'put', path: A, selection: null },
          { op: 'put', path: B, selection: null },
          { op: 'get', path: A },
        ],
        undefined,
        {},
        'put keeps updatedAt; forgetting what is not there writes nothing',
      ),
      storeCase(
        [
          { op: 'set', path: '/d/1', input: sel('builtin', 'one') },
          { op: 'set', path: '/d/2', input: sel('builtin', 'two') },
          { op: 'set', path: '/d/3', input: sel('builtin', 'three') },
          { op: 'get', path: '/d/1' },
          { op: 'set', path: '/d/4', input: sel('builtin', 'four') },
          { op: 'get', path: '/d/1' },
          { op: 'get', path: '/d/2' },
          { op: 'get', path: '/d/3' },
          { op: 'get', path: '/d/4' },
        ],
        undefined,
        { maxDocuments: 2 },
        'cap of 2: the least recently used go',
      ),
      storeCase(
        [
          { op: 'set', path: '/d/1', input: sel('builtin', 'one') },
          { op: 'set', path: '/d/2', input: sel('builtin', 'two') },
          { op: 'set', path: '/d/3', input: sel('builtin', 'three') },
        ],
        undefined,
        { maxDocuments: 1.5 },
        'fractional cap',
      ),
      storeCase(
        [
          { op: 'set', path: '/d/1', input: sel('builtin', 'one') },
          { op: 'set', path: '/d/2', input: sel('builtin', 'two') },
        ],
        undefined,
        { maxDocuments: 0 },
        'cap of 0 keeps the one just written',
      ),
      storeCase(
        [
          { op: 'set', path: '/d/1', input: sel('builtin', 'one') },
          { op: 'set', path: '/d/2', input: sel('builtin', 'two') },
          { op: 'tick', ms: 59_990 },
          { op: 'get', path: '/d/1' },
          { op: 'tick', ms: 60_000 },
          { op: 'get', path: '/d/1' },
          { op: 'get', path: '/d/2' },
        ],
        undefined,
        {},
        'a read rewrites the file once a minute',
      ),
      storeCase(
        [
          { op: 'get', path: A },
          { op: 'get', path: B },
          { op: 'get', path: '/d/n' },
          { op: 'get', path: '/d/10' },
          { op: 'get', path: '/d/2' },
        ],
        fileAt(
          stored({
            [A]: rec('a'),
            '/d/2': rec('two', { kind: 'saved', adjustments: ['x', 'y'] }),
            '/d/10': rec('ten', { updatedAt: 1, usedAt: 2 }),
            '/d/n': rec('n', { usedAt: undefined, updatedAt: 3 }),
            [B]: rec('b', { usedAt: 'text', updatedAt: 'text' }),
          }),
        ),
        {},
        'a valid file; usedAt falls back to updatedAt',
      ),
      storeCase(
        [
          { op: 'get', path: '2' },
          { op: 'get', path: '10' },
          { op: 'set', path: 'a', input: sel('builtin', 'x') },
          { op: 'set', path: '1', input: sel('builtin', 'one') },
        ],
        fileAt(stored({ a: rec('a'), '10': rec('ten'), '2': rec('two'), b: rec('b') })),
        {},
        'integer-like keys come first, in numeric order, when the file is written',
      ),
      storeCase(
        [
          { op: 'get', path: A },
          { op: 'get', path: '__proto__' },
          { op: 'set', path: B, input: sel('builtin', 'x') },
        ],
        fileAt(
          `{"version":1,"documents":{"${A}":${JSON.stringify(rec('a'))},"__proto__":${JSON.stringify(rec('proto'))}}}`,
        ),
        {},
        'a document named __proto__',
      ),
      storeCase(
        [
          { op: 'get', path: A },
          { op: 'get', path: B },
          { op: 'get', path: C },
          { op: 'set', path: SH, input: sel('builtin', 'x') },
        ],
        fileAt(
          stored({
            [A]: { kind: 'other', key: 'x', adjustments: [] },
            [B]: { kind: 'builtin', key: '', adjustments: [] },
            [C]: { kind: 'builtin', key: 'ok', adjustments: 'not a list' },
            '/d/ok': rec('fine'),
            '/d/null': null,
            '/d/num': 5,
            '/d/arr': [1],
            '/d/big': { kind: 'builtin', key: 'z'.repeat(129) },
            '/d/inf': { kind: 'saved', key: 'inf', updatedAt: Infinity, usedAt: -Infinity },
            '/d/long': { kind: 'saved', key: 'long', adjustments: ['p'.repeat(700)], updatedAt: 1 },
          }),
        ),
        {},
        'entries that do not validate are skipped, a bad adjustments value does not',
      ),
      storeCase(
        [
          { op: 'get', path: A },
          { op: 'set', path: A, input: sel('builtin', 'x') },
        ],
        fileAt('{not json'),
        {},
        'corrupt file',
      ),
      storeCase(
        [
          { op: 'get', path: A },
          { op: 'set', path: A, input: sel('builtin', 'x') },
        ],
        fileAt(''),
        {},
        'empty file',
      ),
      storeCase(
        [{ op: 'get', path: A }],
        fileAt('\ufeff' + stored({ [A]: rec('bom') })),
        {},
        'a byte order mark is no JSON',
      ),
      storeCase(
        [
          { op: 'get', path: A },
          { op: 'set', path: A, input: sel('builtin', 'x') },
        ],
        fileAt('[]'),
        {},
        'an array',
      ),
      storeCase([{ op: 'get', path: A }], fileAt('7'), {}, 'a number'),
      storeCase([{ op: 'get', path: A }], fileAt('null'), {}, 'null'),
      storeCase([{ op: 'get', path: A }], fileAt('{"documents":[]}'), {}, 'documents is a list'),
      storeCase([{ op: 'get', path: A }], fileAt('{"documents":"x"}'), {}, 'documents is a string'),
      storeCase(
        [
          { op: 'get', path: A },
          { op: 'set', path: A, input: sel('builtin', 'x') },
        ],
        fileAt('{"documents":null}'),
        {},
        'documents is null',
      ),
      storeCase(
        [
          { op: 'get', path: A },
          { op: 'set', path: A, input: sel('builtin', 'x') },
          { op: 'copy', from: A, to: B },
        ],
        { [`ud/${FILE}`]: { dir: true } },
        {},
        'the record file is a folder: every call throws EISDIR',
      ),
      storeCase(
        [
          { op: 'get', path: A },
          { op: 'set', path: A, input: sel('builtin', 'x') },
          { op: 'put', path: A, selection: null },
        ],
        { ud: 'a file where the folder should be' },
        {},
        'the user data folder is a file: reads see nothing, a write throws',
      ),
      storeCase(
        [
          { op: 'get', path: A },
          { op: 'set', path: B, input: sel('builtin', 'x') },
        ],
        { [`ud/${FILE}`]: { text: stored({ [A]: rec('locked') }), mode: 0 } },
        {},
        'the record file cannot be read',
      ),
      ...[59_993, 59_994, 59_995, 59_996, 59_997, 59_998, 59_999, 60_000].map((ms) =>
        storeCase(
          [
            { op: 'set', path: '/d/1', input: sel('builtin', 'one') },
            { op: 'set', path: '/d/2', input: sel('builtin', 'two') },
            { op: 'tick', ms },
            { op: 'get', path: '/d/1' },
            { op: 'set', path: '/d/3', input: sel('builtin', 'three') },
            { op: 'get', path: '/d/1' },
            { op: 'get', path: '/d/2' },
            { op: 'get', path: '/d/3' },
          ],
          undefined,
          { maxDocuments: 2 },
          `a read ${ms} ms on: a touched record outlives the one written after it; the clock moves a step on each call, so one of these is exactly a minute`,
        ),
      ),
    ],
  },
  'template-selection-store.TemplateSelectionMemory': {
    ts: (a, cx) => runMemory(a, cx),
    cases: [
      {
        args: [
          {
            userData: '$DIR/ud',
            docs: { draft: '', saved: A },
            ops: [
              { op: 'get', doc: 'draft' },
              { op: 'set', doc: 'draft', input: sel('builtin', 'modern', ['x']) },
              { op: 'get', doc: 'draft' },
              { op: 'set', doc: 'draft', input: { kind: 'bad', key: 'x' } },
              { op: 'get', doc: 'draft' },
              { op: 'set', doc: 'draft', input: null },
              { op: 'get', doc: 'draft' },
              { op: 'set', doc: 'saved', input: sel('saved', 'Mine') },
              { op: 'get', doc: 'saved' },
              { op: 'set', doc: 'saved', input: 5 },
              { op: 'set', doc: 'saved', input: null },
              { op: 'get', doc: 'saved' },
            ],
          },
        ],
        note: 'unsaved in memory, saved on disk',
      },
      {
        args: [
          {
            userData: '$DIR/ud',
            docs: { draft: '', other: '' },
            ops: [
              { op: 'set', doc: 'draft', input: sel('builtin', 'modern') },
              { op: 'follow', doc: 'draft', from: '', to: A },
              { op: 'get', doc: 'draft' },
              { op: 'setPath', doc: 'draft', path: A },
              { op: 'get', doc: 'draft' },
              { op: 'follow', doc: 'draft', from: A, to: B },
              { op: 'follow', doc: 'draft', from: A, to: A },
              { op: 'follow', doc: 'draft', from: A, to: '' },
              { op: 'follow', doc: 'other', from: '', to: C },
              { op: 'get', doc: 'draft' },
            ],
          },
        ],
        note: 'follow: the first save, Save As, and calls that do nothing',
      },
      {
        args: [
          {
            userData: '$DIR/ud',
            docs: { old: '', fresh: '', saved: B, third: '' },
            ops: [
              { op: 'set', doc: 'old', input: sel('builtin', 'kept', ['one']) },
              { op: 'inherit', previous: 'old', doc: 'fresh' },
              { op: 'get', doc: 'fresh' },
              { op: 'inherit', previous: null, doc: 'third' },
              { op: 'get', doc: 'third' },
              { op: 'set', doc: 'saved', input: sel('saved', 'disk') },
              { op: 'inherit', previous: 'saved', doc: 'third' },
              { op: 'get', doc: 'third' },
              { op: 'setPath', doc: 'fresh', path: A },
              { op: 'inherit', previous: 'old', doc: 'fresh' },
              { op: 'get', doc: 'fresh' },
            ],
          },
        ],
        note: 'inherit',
      },
      {
        args: [
          {
            userData: '$DIR/ud',
            docs: { saved: A },
            ops: [
              { op: 'set', doc: 'saved', input: sel('builtin', 'moved') },
              { op: 'moved', old: A, new: B },
              { op: 'get', doc: 'saved' },
              { op: 'setPath', doc: 'saved', path: B },
              { op: 'get', doc: 'saved' },
              { op: 'moved', old: '/none/a', new: '/none/b' },
              { op: 'moved', old: B, new: B },
            ],
          },
        ],
        note: 'moved',
      },
      {
        args: [
          {
            userData: '$DIR/ud',
            docs: { saved: A, draft: '' },
            ops: [
              { op: 'get', doc: 'saved' },
              { op: 'set', doc: 'saved', input: sel('builtin', 'x') },
              { op: 'get', doc: 'saved' },
              { op: 'set', doc: 'draft', input: sel('builtin', 'mem') },
              { op: 'follow', doc: 'draft', from: '', to: B },
              { op: 'follow', doc: 'saved', from: A, to: B },
              { op: 'moved', old: A, new: B },
            ],
          },
        ],
        files: { [`ud/${FILE}`]: { dir: true } },
        note: 'the record file is a folder: nothing throws, saved documents remember nothing',
      },
      {
        args: [
          {
            userData: '$DIR/ud',
            docs: { saved: A },
            ops: [
              { op: 'set', doc: 'saved', input: sel('builtin', 'x') },
              { op: 'get', doc: 'saved' },
              { op: 'follow', doc: 'saved', from: A, to: B },
              { op: 'moved', old: A, new: B },
            ],
          },
        ],
        files: { ud: 'a file' },
        note: 'the user data folder is a file',
      },
      {
        args: [
          {
            userData: '$DIR/ud',
            maxDocuments: 1,
            docs: { a: A, b: B },
            ops: [
              { op: 'set', doc: 'a', input: sel('builtin', 'one') },
              { op: 'set', doc: 'b', input: sel('builtin', 'two') },
              { op: 'get', doc: 'a' },
              { op: 'tick', ms: 100_000 },
              { op: 'get', doc: 'b' },
            ],
          },
        ],
        note: 'the cap and the clock',
      },
    ],
  },

  // ---------- video-size.ts ----------
  'video-size.videoSize': {
    ts: (a) => videoSize(new Uint8Array(bytes(a, 0)), str(a, 1)),
    cases: [
      ...mp4s.map(([note, b]): Case => ({ args: [hx(b), 'mp4'], note })),
      ...mp4s.slice(0, 4).flatMap(([note, b]): Case[] => [
        { args: [hx(b), 'M4V'], note },
        { args: [hx(b), 'mov'], note },
        { args: [hx(b), 'webm'], note: `${note}, as webm` },
      ]),
      ...webms.flatMap(([note, b]): Case[] => [
        { args: [hx(b), 'webm'], note },
        { args: [hx(b), 'mkv'], note },
      ]),
      ...avis.map(([note, b]): Case => ({ args: [hx(b), 'avi'], note })),
      ...cases(
        [hx(avis[0]![1]), 'AVI'],
        [hx(avis[0]![1]), 'mp4'],
        [hx(plainWebm), 'm\u212av'],
        [hx(plainWebm), 'MKV'],
        [hx(avis[0]![1]), 'gif'],
        [hx(avis[0]![1]), ''],
        [hx(mp4s[0]![1]), 'mp3'],
        [hx(mp4s[0]![1]), '.mp4'],
      ),
    ],
  },
  'video-size.videoFrame': {
    ts: (a) => videoFrame(a[0] as never, a[1] as never, orUndefined(a[2]) as never),
    cases: cases(
      [slide, { width: 1920, height: 1080 }, null],
      [slide, { width: 320, height: 240 }, null],
      [slide, { width: 640, height: 360 }, { x: 3000000, y: 2000000 }],
      [slide, { width: 100, height: 5000 }, null],
      [slide, null, null],
      [slide, null, { x: 100, y: 200 }],
      [slide, { width: 0, height: 100 }, null],
      [slide, { width: 100, height: 0 }, null],
      [slide, { width: -5, height: 100 }, null],
      [{ width: 9144000, height: 5143500 }, { width: 1280.5, height: 720.25 }, null],
      [{ width: 0, height: 0 }, { width: 100, height: 100 }, null],
      [{ width: 0, height: 0 }, null, null],
      [
        { width: 1000, height: 1000 },
        { width: 0.5, height: 0.5 },
        { x: 0.25, y: 0.75 },
      ],
    ),
  },
  'video-size.audioFrame': {
    ts: (a) => audioFrame(a[0] as never, orUndefined(a[1]) as never),
    cases: cases(
      [slide, null],
      [slide, { x: 1000, y: 2000 }],
      [{ width: 9144000, height: 5143500 }, null],
      [{ width: 0, height: 0 }, null],
      [
        { width: 1.5, height: 2.5 },
        { x: 0.5, y: -0.5 },
      ],
    ),
  },
}
