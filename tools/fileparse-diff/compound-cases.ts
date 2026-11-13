import * as CFB from 'cfb'
import type { Input, Spec } from './spec'

const EMPTY = new Uint8Array()
const FREESECT = -1
const ENDOFCHAIN = -2
const FATSECT = -3
const DIFSECT = -4
const NOSTREAM = -1

/**
 * cfb's reading of a compound file: its stream entries, in directory order.
 * An entry cfb leaves without content is read as empty, as `toOwnedBytes` of
 * packages/doc2docx/src/compound.ts reads it.
 */
function compoundStreams(bytes: Uint8Array): Array<{ name: string; bytes: number[] }> {
  const { FileIndex } = CFB.read(Buffer.from(bytes), { type: 'buffer' })
  return FileIndex.filter((entry) => entry.type === 2).map(({ name, content }) => ({
    name,
    bytes: content ? Array.from(content) : [],
  }))
}

function fill(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (seed + i * 31) & 0xff
  return out
}

/** Little-endian int32 values, FREESECT after the last one. */
function int32s(values: readonly number[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  const view = new DataView(out.buffer)
  for (let k = 0; k < length / 4; k++) view.setInt32(k * 4, values[k] ?? FREESECT, true)
  return out
}

interface Entry {
  name: string
  type: number
  left?: number
  right?: number
  child?: number
  start: number
  size: number
}

/** One directory sector; slots past `entries` are unused, as cfb writes them. */
function directory(entries: readonly Entry[], sectorSize = 512): Uint8Array {
  const out = new Uint8Array(sectorSize)
  const view = new DataView(out.buffer)
  for (let slot = 0; slot < sectorSize / 128; slot++) {
    const at = slot * 128
    const entry = entries[slot]
    if (entry) {
      for (let k = 0; k < entry.name.length; k++)
        view.setUint16(at + 2 * k, entry.name.charCodeAt(k), true)
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

/** A DIFAT sector: `locations`, FREESECT after them, then `next`. */
function difatSector(locations: readonly number[], next: number): Uint8Array {
  return int32s([...locations, ...Array<number>(127 - locations.length).fill(FREESECT), next], 512)
}

const root = (child: number, start: number, size: number): Entry => ({
  name: 'Root Entry',
  type: 5,
  child,
  start,
  size,
})

/** A file as cfb writes it, with `streams` added by path. */
function written(streams: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
  const container = CFB.utils.cfb_new()
  for (const [path, content] of streams) CFB.utils.cfb_add(container, path, Buffer.from(content))
  return new Uint8Array(CFB.write(container, { type: 'buffer' }) as Buffer)
}

/** The offset of the directory entry named `name` in a file cfb wrote. */
function entryAt(bytes: Uint8Array, name: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let at = 512; at + 128 <= bytes.length; at += 128) {
    if (view.getUint16(at + 64, true) !== (name.length + 1) * 2) continue
    let same = true
    for (let k = 0; k < name.length && same; k++)
      same = view.getUint16(at + 2 * k, true) === name.charCodeAt(k)
    if (same) return at
  }
  throw new Error(`no directory entry ${name}`)
}

function builtCompounds(): Input[] {
  const mixed = written([
    ['/WordDocument', fill(5000, 1)],
    ['/1Table', fill(300, 2)],
    ['/Empty', EMPTY],
    ['/\u0005SummaryInformation', fill(180, 3)],
    ['/한글 스트림', fill(70, 4)],
    ['/Emoji \u{1F600}', fill(10, 5)],
    ['/ObjectPool/_1234/\u0001Ole', fill(20, 6)],
    ['/ObjectPool/_1234/CONTENTS', fill(4096, 7)],
    ['/Edge4095', fill(4095, 8)],
  ])
  const mixedView = new DataView(mixed.buffer)
  const word = entryAt(mixed, 'WordDocument')
  const table = entryAt(mixed, '1Table')
  const wordStart = mixedView.getInt32(word + 116, true)
  const fatAt = (mixedView.getInt32(76, true) + 1) * 512
  const edit = (label: string, change: (view: DataView) => void): Input => {
    const bytes = mixed.slice()
    change(new DataView(bytes.buffer))
    return { label, bytes }
  }

  const dataSectors = (count: number, seed: number) =>
    Array.from({ length: count }, (_, k) => fill(512, seed + k))
  const fatSectors = Array.from({ length: 109 }, (_, k) => k)
  const fullHeaderFat = int32s(
    [
      ...Array<number>(109).fill(FATSECT),
      DIFSECT,
      FATSECT,
      ENDOFCHAIN,
      113,
      114,
      115,
      116,
      117,
      118,
      119,
      ENDOFCHAIN,
    ],
    512,
  )
  const fatThenGap = int32s(
    [FATSECT, DIFSECT, DIFSECT, ENDOFCHAIN, ...Array.from({ length: 124 }, (_, k) => k + 5)],
    512,
  )

  return [
    { label: 'cfb: mini, regular, empty, unicode and nested streams', bytes: mixed },
    { label: 'cfb: one small stream', bytes: written([['/a', new TextEncoder().encode('hello')]]) },
    {
      label: 'cfb: 24 streams over two MiniFAT sectors and seven directory sectors',
      bytes: written(
        Array.from(
          { length: 24 },
          (_, k) => [`/s${String(k).padStart(2, '0')}`, fill(500, k)] as const,
        ),
      ),
    },
    { label: 'cfb: one stream over two FAT sectors', bytes: written([['/Big', fill(70_000, 9)]]) },
    { label: 'cfb: last sector cut short', bytes: mixed.slice(0, mixed.length - 301) },
    { label: 'file shorter than a header', bytes: mixed.slice(0, 511) },
    edit('header signature', (view) => view.setUint8(0, 0xd1)),
    edit('major version 5', (view) => view.setUint16(26, 5, true)),
    edit('major version 4 with 512-byte sectors', (view) => view.setUint16(26, 4, true)),
    edit('sector shift 10', (view) => view.setUint16(30, 10, true)),
    edit('mini sector shift 7', (view) => view.setUint8(32, 7)),
    edit('reserved header byte set', (view) => view.setUint8(35, 1)),
    edit('directory sector count in a version 3 header', (view) => view.setInt32(40, 1, true)),
    edit('mini stream cutoff 8192', (view) => view.setUint32(56, 0x2000, true)),
    edit('DIFAT count without a DIFAT chain', (view) => view.setInt32(72, 1, true)),
    edit('directory start past the file', (view) => view.setInt32(48, 100_000, true)),
    edit('directory start before the file', (view) => view.setInt32(48, -5, true)),
    edit('negative stream size', (view) => view.setInt32(table + 120, -256, true)),
    edit('negative start and size read as an unused entry', (view) => {
      view.setInt32(table + 116, -7, true)
      view.setInt32(table + 120, -7, true)
    }),
    edit('MiniFAT location no chain starts at', (view) => {
      view.setInt32(60, 100_000, true)
      view.setInt32(64, 0, true)
    }),
    edit('regular stream starting past the file', (view) =>
      view.setInt32(word + 116, 100_000, true),
    ),
    edit('regular stream starting inside its chain', (view) =>
      view.setInt32(word + 116, wordStart + 2, true),
    ),
    edit('FAT entry pointing past the file', (view) =>
      view.setInt32(fatAt + wordStart * 4, 0x0fffffff, true),
    ),
    {
      label: 'version 4: 4096-byte sectors, mini and regular streams',
      bytes: compound({
        version: 4,
        dirStart: 1,
        dirCount: 1,
        miniFat: [2, 1],
        headerFat: [0],
        sectors: [
          int32s([FATSECT, ENDOFCHAIN, ENDOFCHAIN, ENDOFCHAIN, 5, ENDOFCHAIN], 4096),
          directory(
            [
              root(1, 3, 128),
              { name: 'Small', type: 2, right: 2, start: 0, size: 100 },
              { name: 'Large', type: 2, start: 4, size: 5000 },
            ],
            4096,
          ),
          int32s([1, ENDOFCHAIN], 4096),
          fill(4096, 10),
          fill(4096, 11),
          fill(4096, 12),
        ],
      }),
    },
    {
      label: 'DIFAT chain naming the 110th FAT sector',
      bytes: compound({
        dirStart: 111,
        difat: [109, 1],
        headerFat: fatSectors,
        fatCount: 110,
        sectors: [
          fullHeaderFat,
          ...Array.from({ length: 108 }, () => int32s([], 512)),
          difatSector([110], ENDOFCHAIN),
          int32s([], 512),
          directory([root(1, ENDOFCHAIN, 0), { name: 'Big', type: 2, start: 112, size: 4096 }]),
          ...dataSectors(8, 20),
        ],
      }),
    },
    {
      label: 'two DIFAT sectors after a short header list, as cfb reads them',
      bytes: compound({
        dirStart: 3,
        difat: [1, 2],
        headerFat: [0],
        fatCount: 2,
        sectors: [
          fatThenGap,
          difatSector([130], 2),
          difatSector([], ENDOFCHAIN),
          directory([root(1, ENDOFCHAIN, 0), { name: 'Big', type: 2, start: 4, size: 65_536 }]),
          ...dataSectors(126, 40),
          int32s([129, 131, FATSECT, 132, ENDOFCHAIN], 512),
          ...dataSectors(2, 200),
        ],
      }),
    },
    {
      label: 'directory cut inside its third entry',
      bytes: compound({
        dirStart: 3,
        miniFat: [1, 1],
        headerFat: [0],
        length: 2404,
        sectors: [
          int32s([FATSECT, ENDOFCHAIN, ENDOFCHAIN, ENDOFCHAIN], 512),
          int32s([ENDOFCHAIN], 512),
          fill(512, 30),
          directory([
            root(1, 2, 64),
            { name: 'Small', type: 2, right: 2, start: 0, size: 50 },
            { name: 'Part', type: 2, start: 0, size: 10 },
          ]),
        ],
      }),
    },
  ]
}

/**
 * Cycles cfb reads to an answer, which the Rust reader refuses. They seed no
 * mutations: a mutant may be one of the cycles cfb never leaves. Those (a
 * FAT cycle of 2,560 bytes, a DIFAT sector naming itself, sibling and parent
 * links in a cycle) are built by the tests of
 * crates/file-parse/src/compound.rs and never reach `CFB.read`: on the FAT
 * cycle and the sibling cycle it runs until memory runs out.
 */
function cyclesCfbFinishes(): Input[] {
  const difatChain = (nexts: readonly number[], count: number) =>
    compound({
      dirStart: 1,
      difat: [2, count],
      headerFat: [0],
      sectors: [
        int32s([FATSECT, ENDOFCHAIN, ...nexts.map(() => DIFSECT)], 512),
        directory([root(NOSTREAM, ENDOFCHAIN, 0)]),
        ...nexts.map((next) => difatSector([ENDOFCHAIN], next)),
      ],
    })
  return [
    {
      label: 'MiniFAT cycle',
      mutate: false,
      bytes: compound({
        dirStart: 1,
        miniFat: [2, 1],
        headerFat: [0],
        sectors: [
          int32s([FATSECT, ENDOFCHAIN, ENDOFCHAIN, ENDOFCHAIN], 512),
          directory([root(1, 3, 512), { name: 'Loop', type: 2, start: 0, size: 200 }]),
          int32s([1, 0], 512),
          fill(512, 4),
        ],
      }),
    },
    {
      label: 'two DIFAT sectors naming each other, three declared',
      mutate: false,
      bytes: difatChain([3, 2], 3),
    },
    {
      label: 'three streams sharing one chain past the file size',
      mutate: false,
      bytes: compound({
        dirStart: 1,
        headerFat: [0],
        sectors: [
          int32s([FATSECT, ENDOFCHAIN, 3, 4, 5, 6, 7, 8, 9, ENDOFCHAIN], 512),
          directory([
            root(1, ENDOFCHAIN, 0),
            { name: 'A', type: 2, right: 2, start: 2, size: 4096 },
            { name: 'B', type: 2, right: 3, start: 2, size: 4096 },
            { name: 'C', type: 2, start: 2, size: 4096 },
          ]),
          ...Array.from({ length: 8 }, (_, k) => fill(512, 2 + k)),
        ],
      }),
    },
  ]
}

export const SPECS: Spec[] = [
  {
    fn: 'compoundStreams',
    extensions: ['doc', 'ppt'],
    built: () => [...builtCompounds(), ...cyclesCfbFinishes()],
    call: ({ bytes = EMPTY }) => compoundStreams(bytes),
  },
]
