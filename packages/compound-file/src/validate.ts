/**
 * The gate every compound file passes before a reader gets its bytes.
 *
 * A compound file is a small file system: a header, sector tables (DIFAT, FAT,
 * mini FAT) and a directory whose entries name chains of sectors. Readers
 * follow those chains and links as they find them. The `cfb` library, for one,
 * follows a looping chain until memory runs out, builds one chain per backward
 * link of a chain, and walks sibling links that loop forever. This gate reads
 * the raw tables itself and refuses a file whose tables do not describe a
 * tree of streams over sectors of the file, so that a reader which only
 * follows them ends, in memory a small multiple of the file size.
 */

/** An OLE2/CFB compound document starts with this 8-byte signature. */
export const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const
/** A compound file is at least its 512-byte header. */
export const OLE2_HEADER_BYTES = 512

/** Stable failure codes of the gate and the opener; callers map them onto their own error type. */
export type Ole2FailureCode = 'not_cfb' | 'truncated' | 'limits_exceeded' | 'corrupt'

/** A compound file the gate refused, or that could not be read after it passed. */
export class CompoundFileError extends Error {
  readonly code: Ole2FailureCode
  /** the reason alone, for a caller that words its own message */
  readonly detail: string

  constructor(code: Ole2FailureCode, detail: string) {
    super(`Not a readable compound file: ${detail}`)
    this.name = 'CompoundFileError'
    this.code = code
    this.detail = detail
  }
}

export function isCompoundFileError(error: unknown): error is CompoundFileError {
  return error instanceof CompoundFileError
}

export function hasOle2Signature(bytes: Uint8Array): boolean {
  if (bytes.length < OLE2_MAGIC.length) return false
  return OLE2_MAGIC.every((value, index) => bytes[index] === value)
}

/**
 * Directory entries a file may hold. A document with thousands of embedded
 * objects stays far below it; cfb's path building is quadratic in the count
 * (about a second at this size), so the count cannot be left to the file.
 */
export const MAX_DIRECTORY_ENTRIES = 32768
/** Storages nested inside one another. cfb keeps every entry's whole path, so depth multiplies memory. */
export const MAX_STORAGE_DEPTH = 64

/**
 * What cfb may copy while it builds its sector chains: four times the file,
 * and 64 MiB for a small one. It builds a chain from every sector no earlier
 * chain ran through, so a chain that runs backwards costs one copy of its rest
 * per backward link: a file whose chains run forwards costs at most two.
 */
const CHAIN_COPY_FILE_MULTIPLE = 4
const CHAIN_COPY_FLOOR_BYTES = 64 * 1024 * 1024

const FREE_SECTOR = 0xffffffff
const END_OF_CHAIN = 0xfffffffe
const NO_ENTRY = 0xffffffff
const HEADER_FAT_SLOTS = 109
const MINI_SECTOR_BYTES = 64
const MINI_STREAM_CUTOFF = 4096
const ENTRY_BYTES = 128
const TYPE_UNUSED = 0
const TYPE_STORAGE = 1
const TYPE_STREAM = 2
const TYPE_ROOT = 5

/** offsets in the header */
const MAJOR_VERSION = 26
const SECTOR_SHIFT = 30
const MINI_SECTOR_SHIFT = 32
const FAT_SECTOR_COUNT = 44
const DIRECTORY_START = 48
const MINI_CUTOFF = 56
const MINI_FAT_START = 60
const MINI_FAT_SECTOR_COUNT = 64
const DIFAT_START = 68
const DIFAT_SECTOR_COUNT = 72
const HEADER_DIFAT = 76
/** offsets in a directory entry */
const ENTRY_TYPE = 66
const ENTRY_LINKS = [68, 72, 76] as const
const ENTRY_CHILD = 76
const ENTRY_START = 116
const ENTRY_SIZE = 120

/**
 * A table value that names a sector. Readers take the 32 bits as a signed
 * number and end a chain at the first negative one, which is every marker
 * (free, end of chain, FAT sector, DIFAT sector).
 */
const namesSector = (value: number): boolean => value < 0x80000000

function refuse(code: Ole2FailureCode, detail: string): never {
  throw new CompoundFileError(code, detail)
}

/**
 * No chain of a table loops, whichever entry it is followed from. The chains
 * the directory names are checked one by one; this covers the start fields
 * nothing vouches for (of a stream of no bytes, say), which some readers
 * follow all the same.
 */
function assertNoLoop(
  entries: number,
  next: (index: number) => number,
  table: string,
  sectorCount: number,
): void {
  // 0, or one more than the entry the walk that first reached this one started from
  const reachedBy = new Uint32Array(entries)
  for (let start = 0; start < entries; start++) {
    if (reachedBy[start] !== 0) continue
    // a marker and a link out of the table both end a walk
    for (let index = start; index < entries; index = next(index)) {
      if (reachedBy[index] === start + 1) refuse('corrupt', `${table} loops at entry ${index}`)
      if (reachedBy[index] !== 0) break
      const target = next(index)
      if (namesSector(target) && target >= sectorCount) {
        refuse('corrupt', `${table} entry ${index} points past its sector storage at ${target}`)
      }
      reachedBy[index] = start + 1
    }
  }
}

/**
 * Refuse, with a CompoundFileError, bytes that are not a compound file a
 * reader can follow to its end:
 * - the header: signature, version 3 with 512-byte sectors or version 4 with
 *   4096-byte ones, 64-byte mini sectors, the 4096-byte mini stream cutoff;
 * - the sector tables: the FAT sector list is the header's slots and then the
 *   DIFAT chain, without a gap and as long as the header says; no chain of
 *   the FAT or the mini FAT loops, whichever entry it is followed from; the
 *   directory chain, the mini FAT chain, the mini stream and every stream's
 *   chain stay inside the file and the tables, and no sector (or mini sector)
 *   belongs to two of them;
 * - a stream's declared size fits the chain it names. With no shared sector
 *   the streams together hold at most the file's own bytes twice over (once
 *   in sectors, once in the mini stream), however many entries there are;
 * - the directory: a bounded number of entries; the root first and alone; the
 *   child and sibling links form a tree from it, bounded in depth, with no
 *   entry reached twice and no link out of range; an entry outside the tree
 *   links to nothing;
 * - the chains cfb builds, one from every sector no earlier chain ran through,
 *   stay within the copy budget above.
 */
export function assertCompoundFile(bytes: Uint8Array): void {
  if (bytes.length === 0) refuse('not_cfb', 'the file is empty')
  if (!hasOle2Signature(bytes)) {
    refuse('not_cfb', 'the file does not start with the OLE2 compound-document signature')
  }
  if (bytes.length < OLE2_HEADER_BYTES) {
    refuse('truncated', `the file is ${bytes.length} bytes, shorter than the 512-byte OLE2 header`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u32 = (at: number): number => view.getUint32(at, true)

  // The byte-order field (offset 28) is not checked: some writers leave another value there, the
  // file is read as little-endian whatever it says, and every check below still applies.
  const major = view.getUint16(MAJOR_VERSION, true)
  const sectorShift = view.getUint16(SECTOR_SHIFT, true)
  if (!((major === 3 && sectorShift === 9) || (major === 4 && sectorShift === 12))) {
    refuse(
      'corrupt',
      `version ${major} with sector shift ${sectorShift} is neither version 3 with 512-byte sectors nor version 4 with 4096-byte ones`,
    )
  }
  if (view.getUint16(MINI_SECTOR_SHIFT, true) !== 6) {
    refuse('corrupt', 'the mini sector size is not 64 bytes')
  }
  if (u32(MINI_CUTOFF) !== MINI_STREAM_CUTOFF) {
    refuse('corrupt', 'the mini stream cutoff is not 4096 bytes')
  }
  const sectorBytes = 1 << sectorShift
  // sector n starts (n + 1) sectors into the file; the last one may be cut short
  const sectorCount = Math.ceil(bytes.length / sectorBytes) - 1
  if (sectorCount < 1) refuse('truncated', 'the file holds no sector after its header')
  const offsetOf = (sector: number): number => (sector + 1) * sectorBytes
  const linksPerSector = sectorBytes / 4

  const claimed = new Uint8Array(sectorCount)
  const claim = (sector: number, what: string): void => {
    if (sector >= sectorCount) {
      refuse('corrupt', `${what} points at sector ${sector}, past the end of the file`)
    }
    if (claimed[sector]) {
      refuse('corrupt', `${what} reaches sector ${sector}, which it or another chain already uses`)
    }
    claimed[sector] = 1
  }
  /** a sector of a table is read whole, so the end of the file may not cut it */
  const claimTable = (sector: number, what: string): void => {
    claim(sector, what)
    if (offsetOf(sector) + sectorBytes > bytes.length) {
      refuse('truncated', `${what} holds sector ${sector}, which the end of the file cuts short`)
    }
  }

  // The FAT sector list: readers disagree on a list with a gap or a wrong
  // count (one stops at the gap, another reads the header as a table), so the
  // list has neither and every reader follows the same FAT.
  const fatSectors: number[] = []
  let listEnded = false
  const fatSlot = (value: number): void => {
    if (value === FREE_SECTOR || value === END_OF_CHAIN) {
      listEnded = true
      return
    }
    if (listEnded) refuse('corrupt', 'the FAT sector list has a gap')
    claimTable(value, 'the FAT sector list')
    fatSectors.push(value)
  }
  for (let slot = 0; slot < HEADER_FAT_SLOTS; slot++) fatSlot(u32(HEADER_DIFAT + slot * 4))
  let difatSectors = 0
  let difat = u32(DIFAT_START)
  while (namesSector(difat)) {
    claimTable(difat, 'the DIFAT chain')
    difatSectors++
    const base = offsetOf(difat)
    for (let slot = 0; slot < linksPerSector - 1; slot++) fatSlot(u32(base + slot * 4))
    difat = u32(base + sectorBytes - 4)
  }
  if (difat !== END_OF_CHAIN && difat !== FREE_SECTOR) {
    refuse('corrupt', 'the DIFAT chain does not end with an end-of-chain mark')
  }
  if (difatSectors !== u32(DIFAT_SECTOR_COUNT)) {
    refuse(
      'corrupt',
      `the header counts ${u32(DIFAT_SECTOR_COUNT)} DIFAT sectors and the chain holds ${difatSectors}`,
    )
  }
  if (fatSectors.length !== u32(FAT_SECTOR_COUNT)) {
    refuse(
      'corrupt',
      `the header counts ${u32(FAT_SECTOR_COUNT)} FAT sectors and lists ${fatSectors.length}`,
    )
  }
  if (fatSectors.length === 0) refuse('corrupt', 'the file has no FAT')
  const fatEntries = fatSectors.length * linksPerSector
  const fat = (sector: number): number =>
    u32(offsetOf(fatSectors[Math.floor(sector / linksPerSector)]!) + (sector % linksPerSector) * 4)

  /** The sectors of a chain in the FAT, each claimed for it. */
  const chainOf = (start: number, what: string, table = false): number[] => {
    const sectors: number[] = []
    for (let sector = start; namesSector(sector); sector = fat(sector)) {
      if (table) claimTable(sector, what)
      else claim(sector, what)
      if (sector >= fatEntries) {
        refuse('corrupt', `${what} reaches sector ${sector}, which the FAT does not cover`)
      }
      sectors.push(sector)
    }
    return sectors
  }
  assertNoLoop(fatEntries, fat, 'the FAT', sectorCount)

  const directorySectors = chainOf(u32(DIRECTORY_START), 'the directory chain', true)
  if (directorySectors.length === 0) refuse('corrupt', 'the file has no directory')
  const entriesPerSector = sectorBytes / ENTRY_BYTES
  const entryCount = directorySectors.length * entriesPerSector
  if (entryCount > MAX_DIRECTORY_ENTRIES) {
    refuse(
      'limits_exceeded',
      `the directory holds ${entryCount} entries, over the limit of ${MAX_DIRECTORY_ENTRIES}`,
    )
  }
  const entryAt = (index: number): number =>
    offsetOf(directorySectors[Math.floor(index / entriesPerSector)]!) +
    (index % entriesPerSector) * ENTRY_BYTES
  /** version 3 keeps a size in 32 bits and leaves the upper half undefined */
  const sizeOf = (entry: number): number =>
    u32(entry + ENTRY_SIZE) + (major === 4 ? u32(entry + ENTRY_SIZE + 4) * 0x100000000 : 0)

  // A table or stream of nothing names no chain: writers leave anything in its start field.
  const miniFatSectors =
    u32(MINI_FAT_SECTOR_COUNT) === 0 ? [] : chainOf(u32(MINI_FAT_START), 'the mini FAT chain', true)
  const miniFatEntries = miniFatSectors.length * linksPerSector
  const miniFat = (mini: number): number =>
    u32(offsetOf(miniFatSectors[Math.floor(mini / linksPerSector)]!) + (mini % linksPerSector) * 4)

  const root = entryAt(0)
  if (bytes[root + ENTRY_TYPE] !== TYPE_ROOT) {
    refuse('corrupt', 'the first directory entry is not the root entry')
  }
  // the root entry names the mini stream, the chain small streams are cut from
  const miniStreamBytes =
    sizeOf(root) === 0
      ? 0
      : chainOf(u32(root + ENTRY_START), 'the mini stream').length * sectorBytes
  if (sizeOf(root) > miniStreamBytes) {
    refuse(
      'corrupt',
      `the mini stream declares ${sizeOf(root)} bytes and its chain holds ${miniStreamBytes}`,
    )
  }
  const miniSectorCount = miniStreamBytes / MINI_SECTOR_BYTES
  assertNoLoop(miniFatEntries, miniFat, 'the mini FAT', miniSectorCount)
  const miniClaimed = new Uint8Array(miniSectorCount)

  for (let index = 1; index < entryCount; index++) {
    const entry = entryAt(index)
    const type = bytes[entry + ENTRY_TYPE]
    if (type === TYPE_ROOT) refuse('corrupt', `directory entry ${index} is a second root entry`)
    if (type !== TYPE_UNUSED && type !== TYPE_STORAGE && type !== TYPE_STREAM) {
      refuse('corrupt', `directory entry ${index} has the unknown type ${type}`)
    }
    if (type !== TYPE_STREAM) continue
    const size = sizeOf(entry)
    if (size === 0) continue
    const what = `stream ${index}`
    let held: number
    if (size >= MINI_STREAM_CUTOFF) {
      held = chainOf(u32(entry + ENTRY_START), what).length * sectorBytes
    } else {
      let miniSectors = 0
      for (let mini = u32(entry + ENTRY_START); namesSector(mini); mini = miniFat(mini)) {
        if (mini >= miniSectorCount) {
          refuse(
            'corrupt',
            `${what} points at mini sector ${mini}, past the end of the mini stream`,
          )
        }
        if (mini >= miniFatEntries) {
          refuse(
            'corrupt',
            `${what} reaches mini sector ${mini}, which the mini FAT does not cover`,
          )
        }
        if (miniClaimed[mini]) {
          refuse(
            'corrupt',
            `${what} reaches mini sector ${mini}, which it or another stream already uses`,
          )
        }
        miniClaimed[mini] = 1
        miniSectors++
      }
      held = miniSectors * MINI_SECTOR_BYTES
    }
    if (size > held) {
      refuse('corrupt', `${what} declares ${size} bytes and its chain holds ${held}`)
    }
  }

  // The directory tree. A reader that meets an entry twice walks in a circle,
  // and the root entry is met again whenever an unused entry links to entry 0
  // (some writers leave unused entries filled with zeros), so it has no
  // siblings to walk from there.
  const depth = new Int32Array(entryCount).fill(-1)
  depth[0] = 0
  const pending = [0]
  while (pending.length > 0) {
    const index = pending.pop()!
    const entry = entryAt(index)
    for (const link of ENTRY_LINKS) {
      const target = u32(entry + link)
      if (target === NO_ENTRY) continue
      if (index === 0 && link !== ENTRY_CHILD) refuse('corrupt', 'the root entry has a sibling')
      if (target >= entryCount) {
        refuse('corrupt', `directory entry ${index} links to entry ${target}, which does not exist`)
      }
      if (depth[target] !== -1) {
        refuse('corrupt', `the directory reaches entry ${target} twice`)
      }
      depth[target] = depth[index]! + (link === ENTRY_CHILD ? 1 : 0)
      if (depth[target]! > MAX_STORAGE_DEPTH) {
        refuse(
          'limits_exceeded',
          `the directory nests storages deeper than the limit of ${MAX_STORAGE_DEPTH}`,
        )
      }
      pending.push(target)
    }
  }
  for (let index = 1; index < entryCount; index++) {
    if (depth[index] !== -1) continue
    const entry = entryAt(index)
    // some writers leave an unused entry filled with zeros, which reads as three links to entry 0
    const unused = bytes[entry + ENTRY_TYPE] === TYPE_UNUSED
    for (const link of ENTRY_LINKS) {
      const target = u32(entry + link)
      if (target === NO_ENTRY || (unused && target === 0)) continue
      refuse('corrupt', `directory entry ${index} is outside the directory tree and links into it`)
    }
  }

  // What cfb does with the FAT beyond the chains above: a chain from every
  // sector no earlier chain ran through, starting at the directory's first
  // sector and wrapping around, and one more for an entry of 4096 bytes or
  // more (of any type) whose first sector it holds no chain for. It keeps
  // them all until it has read the directory.
  const budget = Math.ceil(
    Math.max(CHAIN_COPY_FLOOR_BYTES, CHAIN_COPY_FILE_MULTIPLE * bytes.length) / sectorBytes,
  )
  let walked = 0
  const reached = new Uint8Array(sectorCount)
  const chainStart = new Uint8Array(sectorCount)
  const walkFrom = (start: number): void => {
    for (let sector = start; namesSector(sector); sector = fat(sector)) {
      if (++walked > budget) {
        refuse(
          'limits_exceeded',
          'the sector chains run backwards so often that reading them would copy the file many times over',
        )
      }
      if (sector < sectorCount) reached[sector] = 1
      if (sector >= fatEntries) break
    }
  }
  const directoryStart = directorySectors[0]!
  for (let nth = 0; nth < sectorCount; nth++) {
    const sector = (nth + directoryStart) % sectorCount
    if (reached[sector]) continue
    chainStart[sector] = 1
    walkFrom(sector)
  }
  for (let index = 1; index < entryCount; index++) {
    const entry = entryAt(index)
    if (view.getInt32(entry + ENTRY_SIZE, true) < MINI_STREAM_CUTOFF) continue
    const start = u32(entry + ENTRY_START)
    if (!namesSector(start)) continue
    if (start < sectorCount) {
      if (chainStart[start]) continue
      chainStart[start] = 1
    }
    walkFrom(start)
  }
}
