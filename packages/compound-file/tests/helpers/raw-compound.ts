/**
 * Compound files written table by table, for the cases a library writer never
 * produces: a chain that loops, a link past the end, two entries on one chain.
 * Nothing here is checked: the file is what the description says.
 */

export const FREE = 0xffffffff
export const END = 0xfffffffe
export const FAT_SECTOR = 0xfffffffd
export const NO_ENTRY = 0xffffffff

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const HEADER_FAT_SLOTS = 109
const ENTRY_BYTES = 128

export interface RawEntry {
  name: string
  /** 0 unused, 1 storage, 2 stream, 5 root */
  type: 0 | 1 | 2 | 5
  start?: number
  size?: number
  left?: number
  right?: number
  child?: number
}

export interface RawCompound {
  /** 512 (version 3, the default) or 4096 (version 4) */
  sectorBytes?: 512 | 4096
  /** sectors after the header */
  sectors: number
  /** the sectors that hold the FAT, in order (default: sector 0) */
  fatSectors?: number[]
  /** FAT links by sector; a sector not named is free */
  fat: Record<number, number>
  /** the sectors that hold the directory, in order (default: sector 1) */
  directory?: number[]
  entries: RawEntry[]
  /** directory slots after the entries: marked unused (the default), or left as zeros */
  unusedEntries?: 'marked' | 'zeros'
  /** the sectors that hold the mini FAT, in order, and its links by mini sector */
  miniFat?: { sectors: number[]; links: Record<number, number> }
  /** the contents of sectors */
  data?: Record<number, Uint8Array>
  /** bytes to cut from the end of the file, to leave its last sector short */
  cutFromEnd?: number
}

export function rawCompound(spec: RawCompound): Uint8Array {
  const sectorBytes = spec.sectorBytes ?? 512
  const linksPerSector = sectorBytes / 4
  const fatSectors = spec.fatSectors ?? [0]
  const directory = spec.directory ?? [1]
  const bytes = new Uint8Array(sectorBytes * (spec.sectors + 1))
  const view = new DataView(bytes.buffer)
  const at = (sector: number): number => sectorBytes * (sector + 1)

  bytes.set(SIGNATURE, 0)
  view.setUint16(24, 0x3e, true)
  view.setUint16(26, sectorBytes === 512 ? 3 : 4, true)
  view.setUint16(28, 0xfffe, true)
  view.setUint16(30, sectorBytes === 512 ? 9 : 12, true)
  view.setUint16(32, 6, true)
  view.setUint32(40, sectorBytes === 512 ? 0 : directory.length, true)
  view.setUint32(44, fatSectors.length, true)
  view.setUint32(48, directory[0]!, true)
  view.setUint32(56, 0x1000, true)
  view.setUint32(60, spec.miniFat?.sectors[0] ?? END, true)
  view.setUint32(64, spec.miniFat?.sectors.length ?? 0, true)
  view.setUint32(68, END, true)
  view.setUint32(72, 0, true)
  for (let slot = 0; slot < HEADER_FAT_SLOTS; slot++) {
    view.setUint32(76 + slot * 4, fatSectors[slot] ?? FREE, true)
  }

  for (const sector of fatSectors) bytes.fill(0xff, at(sector), at(sector) + sectorBytes)
  for (const [sector, link] of Object.entries(spec.fat)) {
    const index = Number(sector)
    const table = fatSectors[Math.floor(index / linksPerSector)]!
    view.setUint32(at(table) + (index % linksPerSector) * 4, link, true)
  }
  if (spec.miniFat) {
    const { sectors, links } = spec.miniFat
    for (const sector of sectors) bytes.fill(0xff, at(sector), at(sector) + sectorBytes)
    for (const [mini, link] of Object.entries(links)) {
      const index = Number(mini)
      const table = sectors[Math.floor(index / linksPerSector)]!
      view.setUint32(at(table) + (index % linksPerSector) * 4, link, true)
    }
  }

  const perSector = sectorBytes / ENTRY_BYTES
  for (let index = 0; index < directory.length * perSector; index++) {
    const offset = at(directory[Math.floor(index / perSector)]!) + (index % perSector) * ENTRY_BYTES
    const entry = spec.entries[index]
    if (!entry) {
      if (spec.unusedEntries === 'zeros') continue
      for (const link of [68, 72, 76]) view.setUint32(offset + link, NO_ENTRY, true)
      continue
    }
    const name = `${entry.name}\0`
    for (let char = 0; char < name.length; char++) {
      view.setUint16(offset + char * 2, name.charCodeAt(char), true)
    }
    view.setUint16(offset + 64, name.length * 2, true)
    bytes[offset + 66] = entry.type
    bytes[offset + 67] = 1
    view.setUint32(offset + 68, entry.left ?? NO_ENTRY, true)
    view.setUint32(offset + 72, entry.right ?? NO_ENTRY, true)
    view.setUint32(offset + 76, entry.child ?? NO_ENTRY, true)
    view.setUint32(offset + 116, entry.start ?? END, true)
    view.setUint32(offset + 120, entry.size ?? 0, true)
  }

  for (const [sector, content] of Object.entries(spec.data ?? {})) {
    bytes.set(content, at(Number(sector)))
  }
  return spec.cutFromEnd ? bytes.slice(0, bytes.length - spec.cutFromEnd) : bytes
}

/** `count` sectors from `first`, each linked to the next and the last one ending the chain */
export function chained(first: number, count: number): Record<number, number> {
  const links: Record<number, number> = {}
  for (let nth = 0; nth < count; nth++)
    links[first + nth] = nth === count - 1 ? END : first + nth + 1
  return links
}

const ROOT: RawEntry = { name: 'Root Entry', type: 5, child: 1 }

/**
 * A stream of 4096 bytes whose chain never ends: sector 3 leads to 4 and 4
 * back to 3. The stream starts inside the loop, at a sector an earlier chain
 * (2 → 3 → 4) already ran through, which is where cfb follows a chain without
 * looking back.
 */
export function fatCycleFile(streamName = 'WordDocument'): Uint8Array {
  return rawCompound({
    sectors: 5,
    fat: { 0: FAT_SECTOR, 1: END, 2: 3, 3: 4, 4: 3 },
    entries: [ROOT, { name: streamName, type: 2, start: 3, size: 4096 }],
  })
}

/** A stream whose chain goes from sector 2 to sector 9 of a file that ends after sector 3. */
export function chainPastEndFile(streamName = 'WordDocument'): Uint8Array {
  return rawCompound({
    sectors: 4,
    fat: { 0: FAT_SECTOR, 1: END, 2: 9 },
    entries: [ROOT, { name: streamName, type: 2, start: 2, size: 4096 }],
  })
}

/** Two streams that are each other's left sibling. */
export function siblingCycleFile(): Uint8Array {
  return rawCompound({
    sectors: 2,
    fat: { 0: FAT_SECTOR, 1: END },
    entries: [ROOT, { name: 'A', type: 2, left: 2 }, { name: 'B', type: 2, left: 1 }],
  })
}

/**
 * `streams` directory entries that all name one chain of `chainBytes` bytes: a
 * file of little more than the chain that claims `streams` times its size.
 */
export function sharedChainFile(streams: number, chainBytes: number): Uint8Array {
  const directorySectors = Math.ceil((streams + 1) / 4)
  const dataSectors = Math.ceil(chainBytes / 512)
  const fatCount = Math.ceil((directorySectors + dataSectors + 8) / 127)
  const fatSectors = Array.from({ length: fatCount }, (_unused, index) => index)
  const firstData = fatCount + directorySectors
  const entries: RawEntry[] = [ROOT]
  for (let index = 1; index <= streams; index++) {
    entries.push({
      name: `s${index}`,
      type: 2,
      start: firstData,
      size: chainBytes,
      right: index < streams ? index + 1 : NO_ENTRY,
    })
  }
  return rawCompound({
    sectors: firstData + dataSectors,
    fatSectors,
    fat: {
      ...Object.fromEntries(fatSectors.map((sector) => [sector, FAT_SECTOR])),
      ...chained(fatCount, directorySectors),
      ...chained(firstData, dataSectors),
    },
    directory: Array.from({ length: directorySectors }, (_unused, index) => fatCount + index),
    entries,
  })
}

/** A 100-byte stream in the mini stream whose mini FAT chain goes 0 → 1 → 0. */
export function miniFatCycleFile(streamName = 'WordDocument'): Uint8Array {
  return rawCompound({
    sectors: 4,
    fat: { 0: FAT_SECTOR, 1: END, 2: END, 3: END },
    miniFat: { sectors: [2], links: { 0: 1, 1: 0 } },
    entries: [
      { ...ROOT, start: 3, size: 128 },
      { name: streamName, type: 2, start: 0, size: 100 },
    ],
  })
}

/**
 * A stream of no bytes whose start names mini sector 0 of a mini FAT that goes
 * 0 → 1 → 0. Nothing has to follow the chain of an empty stream; some readers do.
 */
export function emptyStreamInLoopFile(streamName = 'WordDocument'): Uint8Array {
  return rawCompound({
    sectors: 4,
    fat: { 0: FAT_SECTOR, 1: END, 2: END, 3: END },
    miniFat: { sectors: [2], links: { 0: 1, 1: 0 } },
    entries: [
      { ...ROOT, start: 3, size: 128 },
      { name: streamName, type: 2, start: 0, size: 0 },
    ],
  })
}

/**
 * `sectors` sectors no directory entry names, chained from the last one back
 * to the first. cfb builds a chain from each of them to the end of the run:
 * about `sectors`² / 2 sectors of copies for a file of `sectors` sectors.
 */
export function backwardChainFile(sectors: number): Uint8Array {
  const fatCount = Math.ceil((sectors + 8) / 127)
  const fatSectors = Array.from({ length: fatCount }, (_unused, index) => index)
  const first = fatCount + 1
  const fat: Record<number, number> = { [fatCount]: END }
  for (const sector of fatSectors) fat[sector] = FAT_SECTOR
  for (let nth = 0; nth < sectors; nth++) fat[first + nth] = nth === 0 ? END : first + nth - 1
  return rawCompound({
    sectors: first + sectors,
    fatSectors,
    fat,
    directory: [fatCount],
    entries: [{ name: 'Root Entry', type: 5 }],
  })
}

/** A refusal reads the tables once; the bound only has to tell that from a reader that never ends. */
export const REFUSAL_MS = 5000

/** The hostile files every reader of a compound file is tried with, and the code each is refused with. */
export const HOSTILE_FILES: ReadonlyArray<{
  what: string
  build: () => Uint8Array
  code: 'corrupt' | 'limits_exceeded'
}> = [
  { what: 'a stream chain that loops', build: () => fatCycleFile(), code: 'corrupt' },
  {
    what: 'a chain that points past the end of the file',
    build: () => chainPastEndFile(),
    code: 'corrupt',
  },
  { what: 'siblings that link to each other', build: () => siblingCycleFile(), code: 'corrupt' },
  { what: 'a mini FAT chain that loops', build: () => miniFatCycleFile(), code: 'corrupt' },
  {
    what: 'an empty stream that starts inside a mini FAT loop',
    build: () => emptyStreamInLoopFile(),
    code: 'corrupt',
  },
  // 2048 entries on one 64 KiB chain: a 330 KiB file that claims 128 MiB of streams
  {
    what: 'many entries naming one chain',
    build: () => sharedChainFile(2048, 64 * 1024),
    code: 'corrupt',
  },
  // 600 sectors chained backwards: cfb would copy 180,000 sectors for a 300 KiB file
  {
    what: 'a chain that runs backwards sector by sector',
    build: () => backwardChainFile(600),
    code: 'limits_exceeded',
  },
]
