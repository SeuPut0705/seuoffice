// Group `mtx` of comparison (f): vendor/mtx of packages/pptx-engine
// (lzcomp.ts, ctf.ts, index.ts). The Rust side answers in
// crates/office-wasm/src/calls/pptx_mtx.rs to `pptxMtx.<module>.<TypeScript name>`.
//
// No tracked deck embeds a font, and a corpus document hands the runner its
// text parts only, so every input is built here: LZCOMP streams written with
// the decoder's own BitWriter and AHuff, CTF containers and cmap tables byte by
// byte, MTX payloads of both, and seeded truncations and byte flips of each
// (the runner mutates text, and these functions read bytes).
import { ctfToSfnt, sanitizeCmap } from '../../packages/pptx-engine/src/vendor/mtx/ctf'
import { mtxToSfnt } from '../../packages/pptx-engine/src/vendor/mtx/index'
import {
  AHuff,
  BitReader,
  BitWriter,
  MtxError,
  unpackLz,
  unpackMtx,
} from '../../packages/pptx-engine/src/vendor/mtx/lzcomp'
import type { CallSpec, Input } from '../docx-diff/calls-spec'
import { mulberry32 } from '../docx-diff/synthetic'

type Bytes = number[]

const pattern = (length: number, byte: (i: number) => number): Bytes =>
  Array.from({ length }, (_, i) => byte(i) & 0xff)

const ascii = (text: string): Bytes => [...text].map((c) => c.charCodeAt(0) & 0xff)

const s16 = (v: number): Bytes => [(v >> 8) & 0xff, v & 0xff]

const be24 = (v: number): Bytes => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]

const randomBytes = (length: number, seed: number): Bytes => {
  const random = mulberry32(seed)
  return pattern(length, () => Math.floor(random() * 256))
}

/** Big-endian byte builder, as the package's tests build CTF containers. */
class BE {
  bytes: Bytes = []
  u8(v: number): this {
    this.bytes.push(v & 0xff)
    return this
  }
  u16(v: number): this {
    return this.u8(v >> 8).u8(v)
  }
  u32(v: number): this {
    return this.u16(v >>> 16).u16(v & 0xffff)
  }
  tag(t: string): this {
    for (const ch of t) this.u8(ch.charCodeAt(0))
    return this
  }
  raw(a: ArrayLike<number>): this {
    for (let i = 0; i < a.length; i++) this.bytes.push(a[i]!)
    return this
  }
}

/** One to three byte flips, a truncation, or both. */
function damage(bytes: Bytes, random: () => number): Bytes {
  const out = [...bytes]
  const pick = (n: number): number => Math.floor(random() * n)
  const kind = random()
  if (kind < 0.6) {
    for (let flips = 1 + pick(3); flips > 0 && out.length > 0; flips--) {
      const at = pick(out.length)
      out[at] = out[at]! ^ (1 + pick(255))
    }
  }
  if (kind >= 0.4) out.length = pick(out.length + 1)
  return out
}

const DAMAGED = 320

/** `count` damaged copies of `seeds`, each seed picked and damaged from one fixed seed. */
function damaged<T>(
  seeds: T[],
  seed: number,
  damageOne: (seed: T, random: () => number) => T,
  count = DAMAGED,
): T[] {
  const random = mulberry32(seed)
  return Array.from({ length: count }, () =>
    damageOne(seeds[Math.floor(random() * seeds.length)]!, random),
  )
}

// ── lzcomp.ts: the classes, driven by scripts ──────────────────────────────

type WriterOp = { bit: boolean } | { value: [number, number] } | 'bytes'

/** What the writer holds at each `bytes` and at the end. */
function driveBitWriter(ops: WriterOp[]): Bytes[] {
  const writer = new BitWriter()
  const snapshots: Bytes[] = []
  for (const op of ops) {
    if (op === 'bytes') snapshots.push([...writer.bytes()])
    else if ('bit' in op) writer.outputBit(op.bit)
    else writer.writeValue(op.value[0], op.value[1])
  }
  snapshots.push([...writer.bytes()])
  return snapshots
}

type ReaderOp = 'bit' | { value: number }

/** What the reader gave until the script ends or it throws, and what it threw. */
function driveBitReader(
  bytes: Bytes,
  ops: ReaderOp[],
): { values: Array<boolean | number>; error?: string } {
  const reader = new BitReader(Uint8Array.from(bytes))
  const values: Array<boolean | number> = []
  try {
    for (const op of ops) values.push(op === 'bit' ? reader.inputBit() : reader.readValue(op.value))
  } catch (error) {
    return { values, error: String(error) }
  }
  return { values }
}

type HuffOp = { write: number } | 'read'

interface HuffScript {
  range: number
  /** The reader's bytes; none is the `null` reader of the encoder. */
  bytes?: Bytes
  ops: HuffOp[]
}

/** The symbols read, the bits written, and what the coder threw. */
function driveAHuff({ range, bytes, ops }: HuffScript): {
  symbols: number[]
  bytes: Bytes
  error?: string
} {
  const huff = new AHuff(bytes === undefined ? null : new BitReader(Uint8Array.from(bytes)), range)
  const writer = new BitWriter()
  const symbols: number[] = []
  let error: string | undefined
  try {
    for (const op of ops) {
      if (op === 'read') symbols.push(huff.readSymbol())
      else huff.writeSymbol(writer, op.write)
    }
  } catch (thrown) {
    error = String(thrown)
  }
  return { symbols, bytes: [...writer.bytes()], error }
}

const bits = (...values: number[]): WriterOp[] => values.map((v) => ({ bit: v === 1 }))

const WRITER_SCRIPTS: WriterOp[][] = [
  [],
  ['bytes'],
  bits(1),
  bits(1, 0, 1, 1, 0, 0, 1),
  bits(1, 0, 1, 1, 0, 0, 1, 0),
  [...bits(1, 1, 1, 1, 1, 1, 1, 1, 1), 'bytes', ...bits(0)],
  [{ value: [5, 3] }, 'bytes', { value: [0xabcdef, 24] }],
  [{ value: [-1, 32] }],
  // `>>>` takes the count modulo 32: bit 32 is bit 0 again
  [{ value: [0x1_0000_0001, 33] }],
  // ToUint32(3.7) is 3; the counts 1.5 and 0.5 shift by 1 and 0
  [{ value: [3.7, 2.5] }],
  [{ value: [-5, 8] }],
  [{ value: [255, 0] }, { value: [255, -3] }, 'bytes', { value: [1, 1] }],
  [{ value: [2 ** 40 + 5, 40] }],
  [{ value: [0x8000_0000, 32] }, 'bytes', { value: [12345, 70] }],
  [{ value: [1e21, 16] }],
  [{ value: [-0.5, 4] }],
  pattern(100, (i) => i).map((i): WriterOp =>
    i % 13 === 0 ? 'bytes' : { bit: (i * 7) % 3 === 0 },
  ),
]

const READER_SCRIPTS: Array<{ bytes: Bytes; ops: ReaderOp[] }> = [
  { bytes: [], ops: ['bit'] },
  { bytes: [], ops: [{ value: 0 }] },
  { bytes: [0xa5], ops: Array<ReaderOp>(8).fill('bit') },
  { bytes: [0xa5], ops: Array<ReaderOp>(9).fill('bit') },
  { bytes: [0xff, 0xff, 0xff, 0xff], ops: [{ value: 32 }] },
  // 33 bits: the first is shifted out of 32
  { bytes: [0x80, 0, 0, 0, 1], ops: [{ value: 33 }] },
  { bytes: [0xff, 0xff, 0xff, 0xff, 0xff], ops: [{ value: 33 }] },
  { bytes: [0b1011_0000], ops: [{ value: 2.5 }, 'bit'] },
  { bytes: [0x12, 0x34, 0x56], ops: [{ value: 24 }] },
  { bytes: [0x12, 0x34, 0x56], ops: [{ value: 4 }, { value: 12 }, { value: 8 }, 'bit'] },
  { bytes: [0x5a], ops: [{ value: -1 }, { value: 0 }, 'bit', { value: 7 }] },
  { bytes: [1, 2], ops: [{ value: 100 }] },
  {
    bytes: pattern(16, (i) => i * 17),
    ops: [{ value: 7 }, 'bit', { value: 31 }, { value: 17 }, { value: 9 }, { value: 64 }],
  },
]

const writes = (...symbols: number[]): HuffOp[] => symbols.map((write) => ({ write }))
const reads = (count: number): HuffOp[] => Array<HuffOp>(count).fill('read')

/** What `symbols` code to with a fresh coder of `range`. */
function coded(range: number, symbols: number[]): Bytes {
  const writer = new BitWriter()
  const huff = new AHuff(null, range)
  for (const symbol of symbols) huff.writeSymbol(writer, symbol)
  return [...writer.bytes()]
}

/** `count` symbols below `range`, most of them small, so the tree keeps reordering. */
const skewed = (range: number, count: number, seed: number): number[] => {
  const random = mulberry32(seed)
  return Array.from({ length: count }, () => Math.floor(range * random() ** 3))
}

const READ_BACK: Array<[number, number[]]> = [
  [8, skewed(8, 300, 4)],
  [267, skewed(267, 500, 5)],
  [2, [0, 1, 1, 0, 1, 1, 1]],
  [323, skewed(323, 400, 6)],
  [512, skewed(512, 200, 7)],
]

const HUFF_SCRIPTS: HuffScript[] = [
  { range: 8, ops: writes(0, 7, 3, 3, 3, 3, 1) },
  { range: 2, ops: writes(0, 1, 1, 1, 0, 1) },
  { range: 3, ops: writes(2, 2, 0, 1, 2) },
  { range: 13, ops: writes(...skewed(13, 200, 1)) },
  // 258 to 511: the weights of the LZ symbol coder; 256 and 512 are not. 257 is
  // left out: the TypeScript constructor reads symbol 257 past its table and a
  // write then never returns, so there is no answer to compare. The decoder
  // makes ranges 8 and 267 to 323 only.
  ...[256, 258, 300, 511, 512, 600].map((range) => ({
    range,
    ops: writes(0, 255, 256 % range, range - 1, range - 3, range - 2, range - 2, 1),
  })),
  { range: 267, ops: writes(...skewed(267, 3000, 2)) },
  { range: 8, ops: writes(...skewed(8, 2000, 3)) },
  ...READ_BACK.map(([range, symbols]) => ({
    range,
    bytes: coded(range, symbols),
    ops: reads(symbols.length),
  })),
  // past the end of the bits: the symbols read, then the error
  { range: 8, bytes: coded(8, [1, 2, 3]), ops: reads(20) },
  // no reader: readSymbol throws a TypeError
  { range: 8, ops: reads(1) },
  { range: 8, ops: [...writes(1, 2), 'read'] },
  // one coder writes and reads: both move its weights
  { range: 8, bytes: coded(8, [5, 5, 5]), ops: [...writes(5, 5), ...reads(3)] },
  { range: 267, bytes: randomBytes(64, 8), ops: reads(100) },
  { range: 2, bytes: [0b1010_0110], ops: reads(9) },
]

// A symbol outside the range sends the TypeScript into an endless loop: refuse it here.
for (const { range, ops } of HUFF_SCRIPTS) {
  for (const op of ops) {
    if (op !== 'read' && !(Number.isInteger(op.write) && op.write >= 0 && op.write < range)) {
      throw new Error(`calls-mtx: symbol ${op.write} outside range ${range}`)
    }
  }
}

const HUFF_DAMAGED: HuffScript[] = damaged(
  HUFF_SCRIPTS.filter((script) => script.bytes !== undefined && script.bytes.length > 0),
  0x4d_5458_01,
  (script, random) => ({ ...script, bytes: damage(script.bytes!, random) }),
  100,
)

// ── lzcomp.ts: LZCOMP streams ──────────────────────────────────────────────

/**
 * A copy of `length` bytes whose source ends `distance` bytes before the
 * first byte it writes. `digits` replace the 2-bit chunks of the coded length.
 */
interface Copy {
  distance: number
  length: number
  ranges?: number
  digits?: number[]
}

type LzItem = number | 'dup2' | 'dup4' | 'dup6' | Copy

const octalDigits = (n: number): number => (n < 8 ? 1 : 1 + octalDigits(Math.floor(n / 8)))

/** The base-4 digits of the coded length, most significant first. */
function lengthDigits(copy: Copy): number[] {
  if (copy.digits) return copy.digits
  let value = (copy.distance >= 512 ? copy.length - 1 : copy.length) - 2
  if (value < 0) throw new Error(`calls-mtx: a copy of ${copy.length} cannot be coded`)
  const digits: number[] = []
  do {
    digits.unshift(value & 3)
    value = Math.floor(value / 4)
  } while (value > 0)
  return digits
}

/**
 * An LZCOMP stream of `items` as MTX_LZCOMP_PackMemory writes one, with the
 * decoder's own coders. A symbol out of range would hang the coder, so each
 * is checked first.
 */
function lzStream(
  items: LzItem[],
  {
    version = 2,
    runLength = false,
    outLen = items.reduce<number>((n, item) => n + (typeof item === 'object' ? item.length : 1), 0),
  }: { version?: number; runLength?: boolean; outLen?: number } = {},
): Bytes {
  const writer = new BitWriter()
  if (version !== 1) writer.outputBit(runLength)
  const distCoder = new AHuff(null, 8)
  const lenCoder = new AHuff(null, 8)
  writer.writeValue(outLen, 24)
  let numDistRanges = 1
  while (1 + (1 << (3 * numDistRanges)) - 1 < outLen) numDistRanges++
  const dup2 = 256 + 8 * numDistRanges
  const symCoder = new AHuff(null, dup2 + 3)
  for (const item of items) {
    if (typeof item === 'number') {
      if (!(Number.isInteger(item) && item >= 0 && item < 256)) {
        throw new Error(`calls-mtx: literal ${item}`)
      }
      symCoder.writeSymbol(writer, item)
    } else if (item === 'dup2') symCoder.writeSymbol(writer, dup2)
    else if (item === 'dup4') symCoder.writeSymbol(writer, dup2 + 1)
    else if (item === 'dup6') symCoder.writeSymbol(writer, dup2 + 2)
    else {
      const ranges = item.ranges ?? octalDigits(item.distance - 1)
      const digits = lengthDigits(item)
      if (!(item.distance >= 1 && ranges >= 1 && ranges <= numDistRanges)) {
        throw new Error(`calls-mtx: distance ${item.distance} in ${numDistRanges} ranges`)
      }
      if (digits.length === 0 || digits.some((d) => !(Number.isInteger(d) && d >= 0 && d < 4))) {
        throw new Error(`calls-mtx: length digits ${digits.join()}`)
      }
      const more = (i: number): number => (i < digits.length - 1 ? 4 : 0)
      symCoder.writeSymbol(writer, 256 + (ranges - 1) * 8 + digits[0]! + more(0))
      for (let i = 1; i < digits.length; i++) lenCoder.writeSymbol(writer, digits[i]! + more(i))
      for (let k = ranges - 1; k >= 0; k--) {
        distCoder.writeSymbol(writer, Math.floor((item.distance - 1) / 8 ** k) % 8)
      }
    }
  }
  return [...writer.bytes()]
}

/** The test's DUP coding: a byte equal to the one two, four or six back is one symbol. */
const dups = (data: Bytes): LzItem[] =>
  data.map((c, i): LzItem =>
    i >= 2 && data[i - 2] === c
      ? 'dup2'
      : i >= 4 && data[i - 4] === c
        ? 'dup4'
        : i >= 6 && data[i - 6] === c
          ? 'dup6'
          : c,
  )

/** Greedy LZ items: the longest earlier match of four bytes or more, else a DUP, else a literal. */
function compress(data: Bytes): LzItem[] {
  let numDistRanges = 1
  while (1 + (1 << (3 * numDistRanges)) - 1 < data.length) numDistRanges++
  const reach = Math.min(8 ** numDistRanges, 2048)
  const items: LzItem[] = []
  let pos = 0
  while (pos < data.length) {
    let best = 0
    let bestEnd = 0
    for (let start = pos - 1; start >= 0 && pos - start <= reach; start--) {
      let length = 0
      while (
        pos + length < data.length &&
        start + length < pos &&
        data[start + length] === data[pos + length]
      ) {
        length++
      }
      if (length > best) {
        best = length
        bestEnd = start + length - 1
      }
    }
    if (best >= 4) {
      items.push({ distance: pos - bestEnd, length: best })
      pos += best
    } else {
      items.push(
        pos >= 2 && data[pos - 2] === data[pos]
          ? 'dup2'
          : pos >= 4 && data[pos - 4] === data[pos]
            ? 'dup4'
            : pos >= 6 && data[pos - 6] === data[pos]
              ? 'dup6'
              : data[pos]!,
      )
      pos++
    }
  }
  return items
}

interface Lz {
  items: LzItem[]
  version?: number
  runLength?: boolean
  outLen?: number
  /** The version the decoder is told, where it is not the one written. */
  readAs?: number
}

const HELLO = ascii('Hello, MTX!')
const LOREM = ascii(
  'the quick brown fox jumps over the lazy dog; the quick brown fox naps. '.repeat(6),
)
const SKEWED = pattern(2000, (i) => (i % 37 === 0 ? 98 : i % 101 === 0 ? 99 : 97))

/** Every class of coded length: one to five 2-bit digits. */
const LENGTHS: LzItem[] = [
  ...ascii('abcdefghijklmnop'),
  ...[
    [1, 2],
    [1, 3],
    [2, 5],
    [3, 6],
    [1, 17],
    [5, 18],
    [7, 66],
    [8, 67],
    [1, 258],
    [4, 1000],
  ].map(([distance, length]) => ({ distance: distance!, length: length! })),
]

/** Every class of distance: one to five octal digits, either side of 512; 4,353 positions, five ranges. */
const DISTANCES: LzItem[] = [
  ...pattern(300, (i) => i * 31 + 7),
  ...[
    [1, 4],
    [8, 4],
    [9, 4],
    [64, 4],
    [65, 4],
    [511, 4],
    [512, 4],
    [513, 5],
    [4096, 4],
    [4097, 4],
    [5000, 6],
    [7000, 3],
  ].map(([distance, length]) => ({ distance: distance!, length: length! })),
  { distance: 3, length: 4, ranges: 5 },
  { distance: 1, length: 4000 },
]

const zeros = (count: number): number[] => Array<number>(count).fill(0)

/** Length digits past 32 bits: `<<` wraps the coded length as the decoder builds it. */
const WRAPS: Lz[] = [
  { digits: [2, ...zeros(15)], length: 0 },
  { digits: Array<number>(16).fill(3), length: 1 },
  { digits: [3, ...zeros(15), 1], length: 3 },
  { digits: [...Array<number>(15).fill(3), 2], length: 0 },
].map(({ digits, length }) => ({
  items: [...ascii('xyz'), { distance: 1, length, digits }, ...ascii('end')],
}))

/** The run-length layer: escape byte first, then escape + count + byte runs. */
const RUN_LENGTH: Lz[] = (
  [
    [0xaa, 1, 2, 3],
    [0xaa, 7, 0xaa, 5, 9, 8],
    [0xaa, 0xaa, 0, 4],
    [0, 0, 255, 1, 3],
    [0xaa, 1, 0xaa],
    [0xaa, 1, 0xaa, 3],
    [0xaa],
    [],
    [0, 1, 2, 3, 0, 4, 9, { distance: 1, length: 7 }],
    [0xaa, 5, 6, 'dup2', 'dup2', 0],
    [0xaa, 1, 'dup2', 3, 9],
  ] as LzItem[][]
).map((items) => ({ items, runLength: true }))

/** outLen on either side of a power of 8 changes the number of distance ranges, and so the DUP symbols. */
const RANGE_EDGES: Lz[] = [8, 9, 64, 65, 512, 513, 4096, 4097].map((size) => ({
  items: [...pattern(size - 3, (i) => i * 13), 'dup2', 'dup4', 'dup6'],
}))

const LZ: Lz[] = [
  { items: [] },
  { items: [65] },
  { items: HELLO },
  { items: HELLO, version: 1 },
  { items: HELLO, version: 1, readAs: 2 },
  { items: HELLO, readAs: 1 },
  ...[0, 3, 1.5, -1, 255].map((readAs) => ({ items: ascii('Hello'), readAs })),
  { items: pattern(3000, (i) => i * 7919 + (i >> 3)) },
  { items: dups([9, 1, 9, 1, 9, 1, 9, 1, 5, 6, 7, 8, 5, 6, 7, 8, 5, 6, 7, 8, 42]) },
  // DUPs at the start read the preload
  { items: ['dup6', 'dup4', 'dup2', 'dup6', 1, 'dup6'] },
  { items: LENGTHS },
  { items: DISTANCES },
  // a copy from the first byte of the preload, and one from before it
  { items: [{ distance: 1, length: 7168 }] },
  { items: [{ distance: 1, length: 7169 }] },
  // from 512 on, a copy is one byte longer than coded
  { items: [{ distance: 512, length: 6657 }] },
  { items: [{ distance: 512, length: 6658 }] },
  { items: [...ascii('0123456789'), { distance: 1, length: 7178 }] },
  { items: [...ascii('0123456789'), { distance: 1, length: 7179 }] },
  // a copy runs past outLen, and the items after it are never read
  { items: [...ascii('abcdefghij'), { distance: 1, length: 30 }], outLen: 20 },
  { items: [...ascii('abcdefghij'), 'dup2', 'dup2', 'dup4', 5], outLen: 12 },
  ...WRAPS,
  ...RUN_LENGTH,
  ...RANGE_EDGES,
  // the stream ends long before outLen: eight ranges, 323 symbols
  { items: ascii('abc'), outLen: 0xffffff },
  { items: ascii('abc'), outLen: 0xffffff, version: 1 },
  { items: SKEWED },
  { items: compress(LOREM) },
  { items: compress(LOREM), runLength: true },
]

const LZ_INPUTS: Input[] = LZ.map(({ items, version = 2, runLength, outLen, readAs }) => ({
  args: { bytes: lzStream(items, { version, runLength, outLen }), version: readAs ?? version },
}))

const LZ_TRUNCATED: Input[] = [
  { args: { bytes: [], version: 2 } },
  { args: { bytes: [], version: 1 } },
  { args: { bytes: lzStream(HELLO).slice(0, 2), version: 2 } },
  { args: { bytes: lzStream(HELLO).slice(0, 5), version: 2 } },
  { args: { bytes: lzStream(HELLO, { version: 1 }).slice(0, 3), version: 1 } },
]

const LZ_SEED_STREAMS: Lz[] = [
  { items: HELLO },
  { items: pattern(3000, (i) => i * 7919 + (i >> 3)) },
  { items: dups([9, 1, 9, 1, 9, 1, 9, 1, 5, 6, 7, 8, 5, 6, 7, 8, 5, 6, 7, 8, 42]) },
  { items: LENGTHS },
  { items: DISTANCES },
  { items: [...ascii('abcdefghij'), { distance: 1, length: 30 }], outLen: 20 },
  WRAPS[1]!,
  RUN_LENGTH[1]!,
  RUN_LENGTH[3]!,
  RUN_LENGTH[8]!,
  { items: compress(LOREM) },
  { items: SKEWED, version: 1 },
]

const LZ_SEEDS: Array<{ bytes: Bytes; version: number }> = LZ_SEED_STREAMS.map((lz) => ({
  bytes: lzStream(lz.items, lz),
  version: lz.version ?? 2,
}))

const LZ_DAMAGED: Input[] = damaged(LZ_SEEDS, 0x4d_5458_02, (seed, random) => ({
  ...seed,
  bytes: damage(seed.bytes, random),
})).map((args) => ({ args }))

// ── ctf.ts: cmap tables ────────────────────────────────────────────────────

/** A record: platform, encoding, and the index of its subtable or `{ at }`, a raw offset. */
type CmapRecord = [number, number, number | { at: number }]

/** A cmap table: version, records, then `subtables` placed one after another. */
function cmap(
  records: CmapRecord[],
  subtables: Bytes[],
  { version = 0, numTables = records.length }: { version?: number; numTables?: number } = {},
): Bytes {
  const offsets: number[] = []
  let off = 4 + 8 * records.length
  for (const subtable of subtables) {
    offsets.push(off)
    off += subtable.length
  }
  const out = new BE().u16(version).u16(numTables)
  for (const [platform, encoding, sub] of records) {
    out
      .u16(platform)
      .u16(encoding)
      .u32(typeof sub === 'number' ? offsets[sub]! : sub.at)
  }
  for (const subtable of subtables) out.raw(subtable)
  return out.bytes
}

/** The test's one-segment format 4 (24 bytes); the language is at +4. */
const fmt4 = (lang: number, length = 24): Bytes =>
  new BE()
    .u16(4)
    .u16(length)
    .u16(lang)
    .u16(2)
    .u16(2)
    .u16(0)
    .u16(0)
    .u16(0xffff)
    .u16(0)
    .u16(1)
    .u16(0)
    .u16(0).bytes
const fmt12 = (lang: number, length = 28): Bytes =>
  new BE().u16(12).u16(0).u32(length).u32(lang).u32(1).u32(0x20).u32(0x7e).u32(3).bytes
const fmt13 = (lang: number, length = 28): Bytes =>
  new BE().u16(13).u16(0).u32(length).u32(lang).u32(1).u32(0).u32(0xffff).u32(1).bytes
const fmt14 = (length: number): Bytes => new BE().u16(14).u32(length).u32(0).bytes
const fmt0 = (lang: number): Bytes =>
  new BE()
    .u16(0)
    .u16(262)
    .u16(lang)
    .raw(pattern(256, (i) => i & 0x7f)).bytes
const fmt6 = (lang: number): Bytes =>
  new BE().u16(6).u16(14).u16(lang).u16(0x20).u16(2).u16(5).u16(6).bytes
const fmt2 = new BE().u16(2).u16(518).u16(0).raw(zeros(512)).bytes
const fmt8 = (length = 16): Bytes => new BE().u16(8).u16(0).u32(length).u32(0).u32(0).bytes

const CMAP_CLEAN = cmap([[3, 1, 0]], [fmt4(0)])
const CMAP_LANG4 = cmap([[3, 1, 0]], [fmt4(3)])
const CMAP_LONG14 = cmap(
  [
    [0, 5, 1],
    [3, 1, 0],
    [3, 10, 0],
  ],
  [fmt4(0), fmt14(0x7fffffff)],
)
const CMAP_SHARED = cmap(
  [
    [0, 3, 0],
    [3, 1, 0],
  ],
  [fmt4(3)],
)
/** Formats 8, 10 and 13: long lengths, no language check. */
const CMAP_FORMATS = cmap(
  [
    [0, 4, 0],
    [3, 10, 1],
    [0, 5, 2],
  ],
  [fmt8(), new BE().u16(10).u16(0).u32(20).u32(0).u32(0).u32(0).bytes, fmt13(1)],
)
/** A format 12 and a shared format 4, both with a language on platform 3. */
const CMAP_MIXED = cmap(
  [
    [3, 10, 0],
    [3, 1, 1],
    [0, 3, 1],
  ],
  [fmt12(0x0102_0304), fmt4(0x0506)],
)

const CMAPS: Bytes[] = [
  [],
  [0],
  [0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 1],
  [0, 0, 0, 1, 0, 3, 0, 1, 0, 0, 0],
  [0, 0, 0xff, 0xff, ...zeros(40)],
  CMAP_CLEAN,
  CMAP_LANG4,
  // platform 0 keeps its language
  cmap([[0, 3, 0]], [fmt4(3)]),
  // one subtable under platforms 0 and 3: written twice, zeroed by the last write
  CMAP_SHARED,
  // the same records out of order: the platform-0 copy is written last and keeps the language
  cmap(
    [
      [3, 1, 0],
      [0, 3, 0],
    ],
    [fmt4(3)],
  ),
  CMAP_LONG14,
  cmap(
    [
      [0, 5, 1],
      [3, 1, 0],
    ],
    [fmt4(0), fmt14(10)],
  ),
  cmap([[3, 10, 0]], [fmt12(5)]),
  cmap([[3, 10, 0]], [fmt12(0)]),
  cmap([[0, 4, 0]], [fmt12(5)]),
  cmap([[3, 10, 0]], [fmt12(0, 4)]),
  cmap([[3, 10, 0]], [fmt12(5, 3)]),
  cmap([[1, 0, 0]], [fmt0(0)]),
  cmap([[3, 1, 0]], [fmt0(1)]),
  cmap(
    [
      [3, 1, 0],
      [3, 1, 1],
    ],
    [fmt4(0), fmt6(2)],
  ),
  cmap([[3, 1, 0]], [fmt2]),
  CMAP_FORMATS,
  cmap([[0, 4, 0]], [fmt8(0x100)]),
  cmap([[3, 10, 0]], [fmt13(1, 0x7fff_ffff)]),
  // the offset runs past the table: dropped, and nothing is left
  cmap([[3, 1, { at: 1000 }]], []),
  cmap(
    [
      [3, 1, 0],
      [3, 1, { at: 37 }],
    ],
    [fmt4(0)],
  ),
  // a long format whose length field would run past the table
  cmap([[3, 10, 0]], [[0, 12, 0, 0, 0, 40]]),
  cmap([[3, 1, 0]], [fmt4(0, 2)]),
  cmap([[3, 1, 0]], [fmt4(0, 200)]),
  cmap([[3, 1, 0]], [fmt4(0, 4)]),
  // a format 4 of length 4 or 5: its language is read past it, or past the table
  cmap([[3, 1, 0]], [[0, 4, 0, 4]]),
  cmap([[3, 1, 0]], [[0, 4, 0, 5, 9]]),
  cmap([[3, 1, 0]], [[0, 4, 0, 4, 0, 7, 1, 1]]),
  cmap([[3, 1, 0]], [fmt4(9)], { version: 1 }),
  cmap([[3, 1, 0]], [fmt4(0)], { numTables: 2 }),
  cmap([[3, 1, 0]], [fmt4(0)], { numTables: 0 }),
  // subtables placed in the other order, and one no record keeps
  cmap(
    [
      [3, 1, 1],
      [0, 3, 0],
    ],
    [fmt4(5), fmt4(0)],
  ),
  cmap(
    [
      [3, 1, 0],
      [9, 9, { at: 0xffff_fff0 }],
    ],
    [fmt4(0), fmt6(0)],
  ),
  CMAP_MIXED,
]

const CMAP_SEEDS = [CMAP_CLEAN, CMAP_LANG4, CMAP_LONG14, CMAP_SHARED, CMAP_FORMATS, CMAP_MIXED]

// ── ctf.ts: CTF containers ─────────────────────────────────────────────────

/** A glyph of the CTF glyf table: its record (stream 0), push values (stream 1), instructions (stream 2). */
interface Glyph {
  s0: Bytes
  push?: Bytes
  code?: Bytes
}

interface Simple {
  /** 255UShort codes of the points of each contour; the first counts one point less. */
  contours: Bytes[]
  flags: Bytes
  payload: Bytes
  bbox?: [number, number, number, number]
  pushCount?: Bytes
  push?: Bytes
  codeSize?: Bytes
  code?: Bytes
}

function simple(g: Simple): Glyph {
  const count = s16(g.contours.length)
  const start = g.bbox ? [...s16(0x7fff), ...count, ...g.bbox.flatMap((v) => s16(v))] : count
  return {
    s0: [
      ...start,
      ...g.contours.flat(),
      ...g.flags,
      ...g.payload,
      ...(g.pushCount ?? [0]),
      ...(g.codeSize ?? [0]),
    ],
    push: g.push,
    code: g.code,
  }
}

/** The test's square: (0,0) (100,0) (100,100) (0,100), all on the curve. */
const SQUARE_PARTS: Simple = { contours: [[3]], flags: [0, 11, 1, 10], payload: [0, 100, 100, 100] }
const square = (extra: Partial<Simple> = {}): Glyph => simple({ ...SQUARE_PARTS, ...extra })

const EMPTY: Glyph = { s0: s16(0) }
const SQUARE = square()

const tripletBytes = (flag: number): number => {
  const f = flag & 0x7f
  return f < 84 ? 1 : f < 120 ? 2 : f < 124 ? 3 : 4
}

/** One point of each of the 128 triplet encodings, a quarter of them off the curve, in four contours. */
function everyTriplet(byte: (point: number, k: number) => number): Glyph {
  const flags = pattern(128, (i) => i | (i % 4 === 1 ? 0x80 : 0))
  return simple({
    contours: [[31], [32], [32], [32]],
    flags,
    payload: flags.flatMap((flag, i) => pattern(tripletBytes(flag), (k) => byte(i, k))),
  })
}

const ALL_A = everyTriplet((i, k) => i * 37 + k * 11)
// 16-bit deltas of 65535 wrap to -1 in an Int16Array
const ALL_MAX = everyTriplet(() => 0xff)
// zero payloads: a class without an offset gives a zero delta, flagged and not written
const ALL_ZERO = everyTriplet(() => 0)

const BIG_COUNT_FLAGS = pattern(763, (i) => i * 7)
/** Contours of 2, 254 and 506 more points: the three long 255UShort codes. */
const BIG_COUNTS = simple({
  contours: [
    [253, 0, 2],
    [255, 1],
    [254, 0],
  ],
  flags: BIG_COUNT_FLAGS,
  payload: BIG_COUNT_FLAGS.flatMap((flag, i) => pattern(tripletBytes(flag), (k) => i + k)),
})

const TWO_CONTOURS = simple({
  contours: [[3], [4]],
  flags: [0, 11, 1, 10, 0, 11, 1, 10],
  payload: [0, 100, 100, 100, 0, 100, 100, 100],
})
const OFF_CURVE = simple({ contours: [[2]], flags: [0x80, 0x8b, 0x81], payload: [0, 50, 50] })
const BBOX = square({ bbox: [-5, -6, 200, 300] })
/** An explicit bbox, then no contour: nothing is written. */
const BBOX_EMPTY: Glyph = {
  s0: [...s16(0x7fff), ...s16(0), ...[1, 2, 3, 4].flatMap((v) => s16(v))],
}
/** An explicit bbox, then a negative count: a header, no point. */
const BBOX_NEGATIVE: Glyph = {
  s0: [...s16(0x7fff), ...s16(-3), ...[1, 2, 3, 4].flatMap((v) => s16(v)), 0, 0],
}

const composite = (numContours: number, rest: Bytes): Glyph => ({
  s0: [...s16(numContours), ...[-10, -20, 300, 400].flatMap((v) => s16(v)), ...rest],
})

/** Word arguments and more, then a scale. */
const COMPOSITE = composite(-1, [
  ...s16(0x21),
  ...s16(1),
  0,
  10,
  0,
  20,
  ...s16(0x08),
  ...s16(1),
  5,
  6,
  0x40,
  0x00,
])
/** An x and y scale, a 2 by 2, and a 2 by 2 that wins over a scale. */
const COMPOSITE_TRANSFORMS = composite(-1, [
  ...s16(0x60),
  ...s16(1),
  1,
  2,
  0x40,
  0,
  0x20,
  0,
  ...s16(0xa0),
  ...s16(2),
  3,
  4,
  ...pattern(8, (i) => i),
  ...s16(0x88),
  ...s16(3),
  5,
  6,
  ...pattern(8, (i) => 8 - i),
])
/** Instructions after the components, from a count of -2. */
const COMPOSITE_INSTRUCTIONS: Glyph = {
  ...composite(-2, [...s16(0x101), ...s16(1), 0, 1, 0, 2, 2, 3]),
  push: [1, 255, 7],
  code: [0xb0, 1, 0x2b],
}
const COMPOSITE_TRUNCATED = composite(-1, [...s16(0x21), ...s16(1), 0, 10])

/** Push values: bytes and words, runs past 8 and 255, both hop codes, every 255Short code. */
const PUSHES: Glyph[] = [
  square({ pushCount: [3], push: [5, 255, 50, 250, 7] }),
  square({ pushCount: [10], push: pattern(10, (i) => i + 1) }),
  square({ pushCount: [9], push: pattern(9, (i) => i).flatMap((i) => [253, 0x12, i]) }),
  square({ pushCount: [255, 45], push: pattern(298, () => 7) }),
  square({ pushCount: [5], push: [10, 20, 0xfb, 30] }),
  square({ pushCount: [7], push: [10, 20, 0xfc, 30, 40] }),
  square({ pushCount: [5], push: [253, 0x80, 0x00, 250, 255, 255, 0xfb, 254, 3] }),
  square({ pushCount: [7], push: [1, 255, 50, 2, 255, 60, 3, 250, 0, 250, 251] }),
  square({ pushCount: [5], push: [250, 253, 250, 250, 250, 254, 9, 254, 0, 250, 255, 0] }),
  // a hop before two values, with one value left, with four left for 0xFC
  square({ pushCount: [3], push: [0xfb, 1] }),
  square({ pushCount: [3], push: [1, 2, 0xfb, 4] }),
  square({ pushCount: [4], push: [1, 2, 0xfc, 3, 4] }),
  // the push stream ends
  square({ pushCount: [4], push: [1, 2] }),
]

/** Instruction sizes in every 255UShort code. */
const CODES: Glyph[] = [
  square({ codeSize: [5], code: [1, 2, 3, 4, 5] }),
  square({ codeSize: [253, 1, 0], code: pattern(256, (i) => i) }),
  square({ codeSize: [255, 3], code: pattern(256, (i) => 255 - i) }),
  square({ codeSize: [254, 0], code: pattern(506, (i) => i * 3) }),
  square({ codeSize: [1], code: [0x2a] }),
  // the instruction stream ends
  square({ codeSize: [9], code: [1, 2] }),
]

/** The test's cvt: 10, 10 + 200, 210 - 5. */
const CVT_TEST = new BE().u16(3).u8(10).u8(238).u16(200).u8(239).u8(5).bytes
/** Every code: plain, word, negative, positive from 248 up. */
const CVT_ALL = new BE()
  .u16(7)
  .u8(10)
  .u8(238)
  .u16(200)
  .u8(239)
  .u8(5)
  .u8(248)
  .u8(3)
  .u8(255)
  .u8(255)
  .u8(247)
  .u8(0)
  .u8(237).bytes
/** The running sum wraps at 16 bits. */
const CVT_WRAP = new BE().u16(2).u8(238).u16(32767).u8(238).u16(10).bytes

function head(indexToLocFormat = 0, size = 54): Bytes {
  const out = zeros(size)
  const put = (at: number, values: Bytes): void => {
    values.forEach((v, i) => {
      if (at + i < size) out[at + i] = v
    })
  }
  put(0, [0, 1, 0, 0])
  // checksumAdjustment: zeroed on the way in, recomputed on the way out
  put(8, [0x12, 0x34, 0x56, 0x78])
  put(12, [0x5f, 0x0f, 0x3c, 0xf5])
  put(18, s16(1000))
  put(50, s16(indexToLocFormat))
  return out
}

const maxp = (numGlyphs: number, size = 32): Bytes =>
  [0, 1, 0, 0, ...s16(numGlyphs), ...zeros(26)].slice(0, size)

interface Entry {
  tag: string
  data: Bytes
  /** Directory fields that do not describe `data`; `end` is the end of stream 0. */
  offset?: number | 'end'
  length?: number
}

/** Stream 0 of a CTF container: header, directory, then the data of each entry in order. */
function ctfStream(entries: Entry[], numTables = entries.length): Bytes {
  const dataAt = 12 + 16 * entries.length
  const end = dataAt + entries.reduce((n, entry) => n + entry.data.length, 0)
  const out = new BE().u32(0x00010000).u16(numTables).u16(0).u16(0).u16(0)
  let off = dataAt
  for (const entry of entries) {
    const offset = entry.offset === 'end' ? end : (entry.offset ?? off)
    out
      .tag(entry.tag)
      .u32(0)
      .u32(offset)
      .u32(entry.length ?? entry.data.length)
    off += entry.data.length
  }
  for (const entry of entries) out.raw(entry.data)
  return out.bytes
}

interface Font {
  /** `null`: no glyf table. */
  glyphs?: Glyph[] | null
  format?: number
  numGlyphs?: number
  loca?: boolean
  cvt?: Bytes | null
  head?: Bytes | null
  maxp?: Bytes | null
  hmtx?: boolean
  extra?: Entry[]
  glyfLast?: boolean
  numTables?: number
}

/** The three streams of a CTF font; its directory lists cvt, glyf, head, hmtx, loca, maxp, then `extra`. */
function font({
  glyphs = [EMPTY, SQUARE],
  format = 0,
  numGlyphs = glyphs?.length ?? 2,
  loca = false,
  cvt = CVT_TEST,
  head: headTable = head(format),
  maxp: maxpTable = maxp(numGlyphs),
  hmtx: withHmtx = true,
  extra = [],
  glyfLast = false,
  numTables,
}: Font = {}): Bytes[] {
  const glyf: Entry[] = glyphs ? [{ tag: 'glyf', data: glyphs.flatMap((g) => g.s0) }] : []
  const entries: Entry[] = [
    ...(cvt ? [{ tag: 'cvt ', data: cvt }] : []),
    ...(glyfLast ? [] : glyf),
    ...(headTable ? [{ tag: 'head', data: headTable }] : []),
    ...(withHmtx
      ? [
          {
            tag: 'hmtx',
            data: pattern(Math.min(numGlyphs, 64), (i) => i).flatMap((i) => [
              ...s16(500 + i),
              ...s16(i),
            ]),
          },
        ]
      : []),
    ...(loca ? [{ tag: 'loca', data: [] }] : []),
    ...(maxpTable ? [{ tag: 'maxp', data: maxpTable }] : []),
    ...extra,
    ...(glyfLast ? glyf : []),
  ]
  return [
    ctfStream(entries, numTables),
    (glyphs ?? []).flatMap((g) => g.push ?? []),
    (glyphs ?? []).flatMap((g) => g.code ?? []),
  ]
}

const extraTables = (count: number): Entry[] =>
  pattern(count, (i) => i).map((i) => ({
    tag: `x${String(i).padStart(3, '0')}`,
    data: pattern(i % 6, (k) => i + k),
  }))

const PUSHED = square({ pushCount: [1], push: [7] })
/** A glyf rebuilt to `squares` × 24 + `pushed` × 26 bytes. */
const rebuiltTo = (squares: number, pushed: number): Bytes[] =>
  font({
    glyphs: [EMPTY, ...Array<Glyph>(squares).fill(SQUARE), ...Array<Glyph>(pushed).fill(PUSHED)],
  })

const GLYPH_SETS: Glyph[][] = [
  [EMPTY, SQUARE, ALL_A],
  [EMPTY, ALL_MAX],
  [ALL_ZERO, EMPTY],
  [BBOX, BBOX_EMPTY, BBOX_NEGATIVE, SQUARE],
  [TWO_CONTOURS, OFF_CURVE, BIG_COUNTS],
  [EMPTY, COMPOSITE, COMPOSITE_TRANSFORMS, COMPOSITE_INSTRUCTIONS],
  ...PUSHES.map((g) => [EMPTY, g, SQUARE]),
  ...CODES.map((g) => [EMPTY, g]),
]

const CTF: Bytes[][] = [
  font(),
  font({ format: 1 }),
  // neither 0 nor 1: written long, and the head says 1
  font({ format: 2 }),
  font({ format: -1 }),
  font({ loca: true }),
  font({ loca: true, format: 1 }),
  font({ glyphs: null }),
  // a loca and no glyf: the loca stays empty
  font({ glyphs: null, loca: true }),
  font({ numGlyphs: 0 }),
  font({ numGlyphs: 1 }),
  // a third glyph read from the head table that follows the glyf records
  font({ numGlyphs: 3 }),
  font({ cvt: null }),
  font({ cvt: CVT_ALL }),
  font({ cvt: CVT_WRAP }),
  font({ cvt: [0, 0] }),
  // five values: the last three are read from the glyf records after it
  font({ cvt: [0, 5, 1, 2] }),
  font({ head: head(0, 52) }),
  font({ head: head(0, 51) }),
  font({ head: null }),
  font({ maxp: null }),
  font({ maxp: maxp(2, 6) }),
  // numGlyphs past the end of maxp: the DataView throws a RangeError
  font({ maxp: maxp(2, 5) }),
  font({ glyphs: null, maxp: maxp(2, 5) }),
  ...GLYPH_SETS.map((glyphs) => font({ glyphs })),
  font({ glyphs: [EMPTY, COMPOSITE_TRUNCATED], glyfLast: true }),
  font({ glyphs: [EMPTY, square({ pushCount: [2] })], glyfLast: true }),
  font({ glyphs: [EMPTY, { s0: SQUARE.s0.slice(0, 8) }], glyfLast: true }),
  // device metrics are dropped
  font({
    extra: [
      { tag: 'hdmx', data: [0, 0, 0, 2] },
      { tag: 'VDMX', data: [0, 1] },
    ],
  }),
  font({ extra: [{ tag: 'cmap', data: CMAP_LANG4 }] }),
  font({ extra: [{ tag: 'cmap', data: CMAP_CLEAN }] }),
  font({ extra: [{ tag: 'cmap', data: CMAP_LONG14 }] }),
  font({ extra: [{ tag: 'cmap', data: [0, 0] }] }),
  // tags in byte order: upper case first, a Latin-1 letter last; lengths 0 to 7
  font({
    extra: [
      { tag: 'OS/2', data: [1] },
      { tag: 'name', data: [1, 2] },
      { tag: 'post', data: [1, 2, 3] },
      { tag: 'prep', data: pattern(5, (i) => i) },
      { tag: '\u00e9tag', data: [9] },
      { tag: 'AAAA', data: [] },
      { tag: 'zzzz', data: pattern(7, (i) => 200 + i) },
    ],
  }),
  // a tag twice: the sort keeps their order, the last head takes the checksum
  font({ extra: [{ tag: 'hmtx', data: [9, 9, 9, 9] }] }),
  font({ extra: [{ tag: 'head', data: head(1) }] }),
  font({ extra: [{ tag: 'head', data: head(1) }], format: 1 }),
  font({ extra: [{ tag: 'glyf', data: [EMPTY, SQUARE].flatMap((g) => g.s0) }] }),
  font({ extra: [{ tag: 'name', data: [], offset: 'end' }] }),
  font({ extra: [{ tag: 'name', data: [1, 2, 3], offset: 99999 }] }),
  font({ extra: [{ tag: 'name', data: [1], length: 99999 }] }),
  font({ extra: [{ tag: 'glyf', data: [], offset: 99999 }] }),
  font({ extra: [{ tag: 'hdmx', data: [], offset: 99999 }] }),
  // one directory entry more than written, and one fewer
  font({ numTables: 6 }),
  font({ numTables: 4 }),
  [[], [], []],
  [ctfStream([]), [], []],
  // 2, 3, 4, 8, 9, 16 and 17 tables: every searchRange step
  font({ glyphs: null, cvt: null, hmtx: false }),
  font({ glyphs: null, cvt: null }),
  font({ glyphs: null }),
  font({ extra: extraTables(2) }),
  font({ extra: extraTables(3) }),
  font({ extra: extraTables(10) }),
  font({ extra: extraTables(11) }),
]

/** 0x1fffe is the last glyf size a short loca addresses; 0x20000 is promoted to long. */
const LOCA_EDGES: Bytes[][] = [rebuiltTo(5458, 3), rebuiltTo(5457, 4)]

const CTF_SEEDS: Bytes[][] = [
  font(),
  font({ loca: true, glyphs: [EMPTY, SQUARE, ALL_A] }),
  font({ glyphs: [EMPTY, COMPOSITE, COMPOSITE_TRANSFORMS, COMPOSITE_INSTRUCTIONS] }),
  font({ glyphs: [EMPTY, PUSHES[6]!, PUSHES[4]!, CODES[0]!] }),
  font({
    cvt: CVT_ALL,
    extra: [
      { tag: 'cmap', data: CMAP_LANG4 },
      { tag: 'hdmx', data: [1, 2, 3] },
    ],
  }),
  font({ glyphs: [BBOX, TWO_CONTOURS, OFF_CURVE], format: 1 }),
]

/** A damage of one stream, mostly the directory and glyph records of stream 0. */
const damageStreams = (streams: Bytes[], random: () => number): Bytes[] => {
  const which = random() < 0.7 ? 0 : random() < 0.5 ? 1 : 2
  return streams.map((stream, i) => (i === which ? damage(stream, random) : stream))
}

const CTF_DAMAGED = damaged(CTF_SEEDS, 0x4d_5458_03, damageStreams)

// ── lzcomp.ts and index.ts: MTX payloads ───────────────────────────────────

/** An MTX payload of three blocks; `off1` and `off2` replace the offsets the blocks give. */
function mtxOf(
  blocks: Bytes[],
  {
    version = 2,
    off1,
    off2,
    copyLimit = 0,
  }: { version?: number; off1?: number; off2?: number; copyLimit?: number } = {},
): Bytes {
  const first = 10 + blocks[0]!.length
  return [
    version,
    ...be24(copyLimit),
    ...be24(off1 ?? first),
    ...be24(off2 ?? first + blocks[1]!.length),
    ...blocks.flat(),
  ]
}

/** The MTX payload of CTF streams, each LZ-compressed. */
const mtx = (
  streams: Bytes[],
  { version = 2, copies = false }: { version?: number; copies?: boolean } = {},
): Bytes =>
  mtxOf(
    streams.map((stream) => lzStream(copies ? compress(stream) : stream, { version })),
    { version },
  )

const BLOCKS = [[1, 2, 3], [4, 5], [6]].map((block) => lzStream(block))

const UNPACK_MTX: Bytes[] = [
  [],
  [2],
  zeros(9),
  // three empty blocks: the first cannot be read
  [2, 0, 0, 0, 0, 0, 10, 0, 0, 10],
  [1, 0, 0, 0, 0, 0, 10, 0, 0, 10],
  mtxOf(BLOCKS),
  mtxOf(BLOCKS, { version: 3 }),
  mtxOf(
    [[1, 2, 3], [4, 5], [6]].map((block) => lzStream(block, { version: 1 })),
    { version: 1 },
  ),
  // blocks with the run-length bit read as version 1
  mtxOf(BLOCKS, { version: 1 }),
  mtxOf(BLOCKS, { copyLimit: 0xabcdef }),
  mtxOf(BLOCKS, { off1: 9 }),
  mtxOf(BLOCKS, { off1: 10000 }),
  // the second block ends before it starts: the first is read before that is seen
  mtxOf(BLOCKS, { off2: 10 }),
  mtxOf(BLOCKS, { off2: 10000 }),
  [...mtxOf(BLOCKS), 0xde, 0xad],
  mtxOf([BLOCKS[0]!.slice(0, 2), BLOCKS[1]!, BLOCKS[2]!]),
  mtx(font()),
  mtx(font(), { copies: true }),
  mtx(font(), { version: 1 }),
]

const UNPACK_MTX_SEEDS = [
  mtxOf(BLOCKS),
  mtx(font()),
  mtx(font(), { version: 1 }),
  mtx(font({ glyphs: [EMPTY, SQUARE, ALL_A] }), { copies: true }),
]

const MTX_FONTS: Bytes[] = [
  [1, 2, 3],
  zeros(64),
  mtx(font()),
  mtx(font(), { version: 1 }),
  mtx(font({ glyphs: [EMPTY, SQUARE, ALL_A], loca: true }), { copies: true }),
  mtx(font({ format: 2, extra: [{ tag: 'cmap', data: CMAP_LANG4 }] })),
  mtx(font({ glyphs: [EMPTY, COMPOSITE_INSTRUCTIONS, PUSHES[4]!] }), { copies: true }),
  // decodable MTX, but no head; a RangeError inside; CTF streams of three bytes
  mtx(font({ head: null })),
  mtx(font({ maxp: maxp(2, 5) })),
  mtxOf(BLOCKS),
]

const MTX_SEEDS = MTX_FONTS.slice(2, 7)

const bytesOf = (args: Record<string, unknown>): Uint8Array => Uint8Array.from(args.bytes as Bytes)

const streamsOf = (args: Record<string, unknown>): [Uint8Array, Uint8Array, Uint8Array] => {
  const [s0, s1, s2] = (args.streams as Bytes[]).map((stream) => Uint8Array.from(stream))
  return [s0!, s1!, s2!]
}

export const MTX: CallSpec[] = [
  {
    fn: 'pptxMtx.lzcomp.MtxError',
    call: (text) => {
      const error = new MtxError(text)
      return { name: error.name, message: error.message, string: String(error) }
    },
    built: [
      '',
      'CTF stream truncated',
      'unexpected end of LZ stream',
      'line\nbreak',
      'Error: nested',
      ' ',
      'constructor',
      '\u{1F600} past the BMP',
      '\uD55C\uAE00',
    ].map((text) => ({ text })),
  },
  {
    fn: 'pptxMtx.lzcomp.BitWriter',
    call: (_text, args) => driveBitWriter(args.ops as WriterOp[]),
    built: WRITER_SCRIPTS.map((ops) => ({ args: { ops } })),
    mutation: 'none',
  },
  {
    fn: 'pptxMtx.lzcomp.BitReader',
    call: (_text, args) => driveBitReader(args.bytes as Bytes, args.ops as ReaderOp[]),
    built: READER_SCRIPTS.map(({ bytes, ops }) => ({ args: { bytes, ops } })),
    mutation: 'none',
  },
  {
    fn: 'pptxMtx.lzcomp.AHuff',
    call: (_text, args) => driveAHuff(args as unknown as HuffScript),
    built: [...HUFF_SCRIPTS, ...HUFF_DAMAGED].map((script) => ({ args: { ...script } })),
    mutation: 'none',
  },
  {
    fn: 'pptxMtx.lzcomp.unpackLz',
    call: (_text, args) => [...unpackLz(bytesOf(args), args.version as number)],
    built: [...LZ_INPUTS, ...LZ_TRUNCATED, ...LZ_DAMAGED],
    mutation: 'none',
  },
  {
    fn: 'pptxMtx.lzcomp.unpackMtx',
    call: (_text, args) => unpackMtx(bytesOf(args)).map((block) => [...block]),
    built: [...UNPACK_MTX, ...damaged(UNPACK_MTX_SEEDS, 0x4d_5458_04, damage)].map((bytes) => ({
      args: { bytes },
    })),
    mutation: 'none',
  },
  {
    fn: 'pptxMtx.ctf.sanitizeCmap',
    call: (_text, args) => [...sanitizeCmap(bytesOf(args))],
    built: [...CMAPS, ...damaged(CMAP_SEEDS, 0x4d_5458_05, damage)].map((bytes) => ({
      args: { bytes },
    })),
    mutation: 'none',
  },
  {
    fn: 'pptxMtx.ctf.ctfToSfnt',
    call: (_text, args) => [...ctfToSfnt(streamsOf(args))],
    built: [...CTF, ...LOCA_EDGES, ...CTF_DAMAGED].map((streams) => ({ args: { streams } })),
    mutation: 'none',
  },
  {
    fn: 'pptxMtx.index.mtxToSfnt',
    call: (_text, args) => {
      const sfnt = mtxToSfnt(bytesOf(args))
      return sfnt === null ? null : [...sfnt]
    },
    built: [...MTX_FONTS, ...damaged(MTX_SEEDS, 0x4d_5458_06, damage)].map((bytes) => ({
      args: { bytes },
    })),
    mutation: 'none',
  },
]
