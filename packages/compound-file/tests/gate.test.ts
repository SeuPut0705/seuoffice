import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as CFB from 'cfb'
import { describe, expect, it } from 'vitest'

import {
  CompoundFileError,
  MAX_DIRECTORY_ENTRIES,
  MAX_STORAGE_DEPTH,
  assertCompoundFile,
  openOle2Container,
  readCompoundFile,
  type Ole2FailureCode,
  type Ole2Limits,
} from '../src/index'
import {
  END,
  FAT_SECTOR,
  FREE,
  HOSTILE_FILES,
  REFUSAL_MS,
  chained,
  rawCompound,
  type RawEntry,
} from './helpers/raw-compound'

const LIMITS: Ole2Limits = { maxBytes: 64 * 1024 * 1024, maxStreamBytes: 64 * 1024 * 1024 }

const REPO = fileURLToPath(new URL('../../../', import.meta.url))

/** The code the gate refuses the bytes with, or null when it lets them through. */
function refusalOf(bytes: Uint8Array): Ole2FailureCode | null {
  try {
    assertCompoundFile(bytes)
    return null
  } catch (error) {
    if (error instanceof CompoundFileError) return error.code
    throw error
  }
}

const ROOT: RawEntry = { name: 'Root Entry', type: 5, child: 1 }
const STREAM: RawEntry = { name: 'Data', type: 2, start: 2, size: 4096 }
/** a sound file of one 4096-byte stream in sectors 2 to 9; each case below breaks one thing in it */
const soundTables = { sectors: 10, fat: { 0: FAT_SECTOR, 1: END, ...chained(2, 8) } }
const sound = (): Uint8Array => rawCompound({ ...soundTables, entries: [ROOT, STREAM] })
const patched = (change: (view: DataView) => void): Uint8Array => {
  const bytes = sound()
  change(new DataView(bytes.buffer))
  return bytes
}

describe('a hostile compound file', () => {
  for (const { what, build, code } of HOSTILE_FILES) {
    it(`${what} is refused by the opener, quickly`, () => {
      const bytes = build()
      const started = performance.now()
      const result = openOle2Container(bytes, LIMITS)
      expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
      expect(result.ok ? 'opened' : result.code).toBe(code)
    })

    it(`${what} is refused before cfb gets the container`, () => {
      const bytes = build()
      const started = performance.now()
      let thrown: unknown
      try {
        readCompoundFile(bytes)
      } catch (error) {
        thrown = error
      }
      expect(performance.now() - started).toBeLessThan(REFUSAL_MS)
      expect(thrown).toBeInstanceOf(CompoundFileError)
      expect((thrown as CompoundFileError).code).toBe(code)
    })
  }
})

describe('the gate refuses', () => {
  const nested = (levels: number): Uint8Array => {
    const entries: RawEntry[] = [ROOT]
    for (let level = 1; level <= levels; level++) {
      entries.push({ name: `d${level}`, type: 1, child: level < levels ? level + 1 : undefined })
    }
    const directorySectors = Math.ceil(entries.length / 4)
    return rawCompound({
      sectors: 1 + directorySectors,
      fat: { 0: FAT_SECTOR, ...chained(1, directorySectors) },
      directory: Array.from({ length: directorySectors }, (_unused, index) => 1 + index),
      entries,
    })
  }
  const directoryOf = (entryCount: number): Uint8Array => {
    const directorySectors = entryCount / 4
    const fatCount = Math.ceil((directorySectors + 8) / 127)
    const fatSectors = Array.from({ length: fatCount }, (_unused, index) => index)
    return rawCompound({
      sectors: fatCount + directorySectors,
      fatSectors,
      fat: {
        ...Object.fromEntries(fatSectors.map((sector) => [sector, FAT_SECTOR])),
        ...chained(fatCount, directorySectors),
      },
      directory: Array.from({ length: directorySectors }, (_unused, index) => fatCount + index),
      entries: [{ name: 'Root Entry', type: 5 }],
    })
  }

  const CASES: Array<[string, () => Uint8Array, Ole2FailureCode]> = [
    [
      'a sector size that is neither 512 nor 4096',
      () => patched((v) => v.setUint16(30, 10, true)),
      'corrupt',
    ],
    ['a mini sector size other than 64', () => patched((v) => v.setUint16(32, 7, true)), 'corrupt'],
    [
      'a mini stream cutoff other than 4096',
      () => patched((v) => v.setUint32(56, 0x2000, true)),
      'corrupt',
    ],
    [
      'a FAT sector list with a gap',
      () =>
        patched((v) => {
          v.setUint32(76, FREE, true)
          v.setUint32(80, 0, true)
        }),
      'corrupt',
    ],
    [
      'a FAT sector count the list does not match',
      () => patched((v) => v.setUint32(44, 2, true)),
      'corrupt',
    ],
    [
      'a DIFAT chain that loops',
      () => {
        const bytes = rawCompound({ ...soundTables, sectors: 11, entries: [ROOT, STREAM] })
        const view = new DataView(bytes.buffer)
        view.setUint32(68, 10, true)
        view.setUint32(72, 1, true)
        // DIFAT sector 10 lists no further FAT sector and names itself as the next one
        for (let slot = 0; slot < 127; slot++) view.setUint32(512 * 11 + slot * 4, FREE, true)
        view.setUint32(512 * 11 + 508, 10, true)
        return bytes
      },
      'corrupt',
    ],
    [
      'an unreferenced FAT link past the end of the file',
      () =>
        rawCompound({
          ...soundTables,
          fat: { ...soundTables.fat, 50: 90 },
          entries: [ROOT, STREAM],
        }),
      'corrupt',
    ],
    [
      'a FAT loop among entries for sectors the file does not have',
      () =>
        rawCompound({
          ...soundTables,
          fat: { ...soundTables.fat, 50: 51, 51: 50 },
          entries: [ROOT, STREAM],
        }),
      'corrupt',
    ],
    [
      'a directory chain that loops',
      () =>
        rawCompound({
          sectors: 3,
          fat: { 0: FAT_SECTOR, 1: 2, 2: 1 },
          directory: [1, 2],
          entries: [ROOT],
        }),
      'corrupt',
    ],
    [
      'a FAT sector that a stream also uses',
      () => rawCompound({ ...soundTables, entries: [ROOT, { ...STREAM, start: 0 }] }),
      'corrupt',
    ],
    [
      'a stream that declares more bytes than its chain holds',
      () => rawCompound({ ...soundTables, entries: [ROOT, { ...STREAM, size: 4097 }] }),
      'corrupt',
    ],
    [
      'a small stream outside the mini stream',
      () => rawCompound({ ...soundTables, entries: [ROOT, { ...STREAM, start: 0, size: 100 }] }),
      'corrupt',
    ],
    [
      'a sibling link to an entry that does not exist',
      () => rawCompound({ ...soundTables, entries: [ROOT, { ...STREAM, left: 99 }] }),
      'corrupt',
    ],
    [
      'a child link back to the root',
      () => rawCompound({ ...soundTables, entries: [ROOT, { name: 'Dir', type: 1, child: 0 }] }),
      'corrupt',
    ],
    [
      'a root entry with a sibling',
      () => rawCompound({ ...soundTables, entries: [{ ...ROOT, right: 1 }, STREAM] }),
      'corrupt',
    ],
    [
      'a second root entry',
      () => rawCompound({ ...soundTables, entries: [ROOT, STREAM, { name: 'Root 2', type: 5 }] }),
      'corrupt',
    ],
    [
      'a file whose first entry is not the root',
      () => rawCompound({ ...soundTables, entries: [{ ...ROOT, type: 1 }, STREAM] }),
      'corrupt',
    ],
    [
      'an entry outside the tree that links into it',
      () =>
        rawCompound({
          ...soundTables,
          entries: [ROOT, STREAM, { name: 'Lost', type: 2, left: 1 }],
        }),
      'corrupt',
    ],
    [
      'storages nested deeper than the limit',
      () => nested(MAX_STORAGE_DEPTH + 1),
      'limits_exceeded',
    ],
    [
      'more directory entries than the limit',
      () => directoryOf(MAX_DIRECTORY_ENTRIES + 4),
      'limits_exceeded',
    ],
    ['a file that ends inside its FAT', () => sound().slice(0, 512 + 100), 'truncated'],
  ]

  for (const [what, build, code] of CASES) {
    it(what, () => {
      expect(refusalOf(build())).toBe(code)
    })
  }
})

describe('a sound compound file still opens', () => {
  const opened = (bytes: Uint8Array): Map<string, Uint8Array> => {
    const result = openOle2Container(bytes, LIMITS)
    if (!result.ok) throw new Error(`${result.code}: ${result.detail}`)
    return new Map(result.container.streams().map((name) => [name, result.container.stream(name)!]))
  }
  const filled = (length: number, seed: number): Uint8Array =>
    Uint8Array.from({ length }, (_unused, index) => (index * 7 + seed) & 0xff)

  it.each([
    ['packages/file-parse/tests/fixtures/legacy-sample.doc', 'WordDocument'],
    ['packages/file-parse/tests/fixtures/legacy-sample.ppt', 'PowerPoint Document'],
    ['apps/sheets/native/xlsx-engine/tests/fixtures/cell-styles.xls', 'Workbook'],
    ['apps/hwp/tests/fixtures/memo.hwp', 'FileHeader'],
  ])('%s, with its %s stream', (path, stream) => {
    const streams = opened(readFileSync(`${REPO}${path}`))
    expect(streams.get(stream)?.length).toBeGreaterThan(0)
  })

  it('every compound file among the fixtures of the repository', () => {
    const folders = [
      'packages/doc2docx/tests/fixtures',
      'packages/file-parse/tests/fixtures',
      'packages/cli/tests/fixtures',
      'apps/hwp/tests/fixtures',
      'apps/hwp/src/renderer/assets',
      'apps/sheets/native/xlsx-engine/tests/fixtures',
      'e2e/assets',
    ]
    const refused: string[] = []
    let read = 0
    for (const folder of folders) {
      for (const name of readdirSync(`${REPO}${folder}`)) {
        if (!/\.(doc|dot|ppt|xls|hwp)$/i.test(name)) continue
        const bytes = readFileSync(`${REPO}${folder}/${name}`)
        // an HWPX or a DOCX under an old name is not a compound file
        if (bytes[0] !== 0xd0) continue
        read++
        const code = refusalOf(bytes)
        if (code) refused.push(`${folder}/${name}: ${code}`)
      }
    }
    expect(refused).toEqual([])
    expect(read).toBeGreaterThanOrEqual(20)
  })

  it('a file cfb wrote with more FAT sectors than the header lists', () => {
    // 8 MiB of streams need 129 FAT sectors: 109 in the header, the rest in a DIFAT sector
    const container = CFB.utils.cfb_new()
    const big = Buffer.from(filled(8 * 1024 * 1024, 1))
    CFB.utils.cfb_add(container, 'Big', big)
    CFB.utils.cfb_add(container, 'Small', Buffer.from(filled(100, 2)))
    const bytes = new Uint8Array(
      CFB.write(container, { type: 'buffer', fileType: 'cfb' }) as Buffer,
    )
    expect(new DataView(bytes.buffer).getUint32(72, true)).toBeGreaterThan(0)
    const streams = opened(bytes)
    expect(Buffer.from(streams.get('Big')!).equals(big)).toBe(true)
    expect([...streams.get('Small')!]).toEqual([...filled(100, 2)])
  })

  for (const sectorBytes of [512, 4096] as const) {
    it(`a file of ${sectorBytes}-byte sectors with a stream in sectors and one in the mini stream`, () => {
      const large = filled(4096 + 10, 3)
      const largeSectors = Math.ceil(large.length / sectorBytes)
      const small = filled(100, 4)
      // sector 0 FAT, 1 directory, 2 mini FAT, 3 the mini stream, then the large stream
      const data: Record<number, Uint8Array> = { 3: small }
      for (let nth = 0; nth < largeSectors; nth++) {
        data[4 + nth] = large.subarray(nth * sectorBytes, (nth + 1) * sectorBytes)
      }
      const bytes = rawCompound({
        sectorBytes,
        sectors: 4 + largeSectors,
        fat: { 0: FAT_SECTOR, 1: END, 2: END, 3: END, ...chained(4, largeSectors) },
        miniFat: { sectors: [2], links: { 0: 1, 1: END } },
        data,
        entries: [
          { ...ROOT, start: 3, size: 128 },
          { name: 'Large', type: 2, start: 4, size: large.length, right: 2 },
          { name: 'Small', type: 2, start: 0, size: small.length },
        ],
      })
      const streams = opened(bytes)
      expect([...streams.get('Large')!]).toEqual([...large])
      expect([...streams.get('Small')!]).toEqual([...small])
    })
  }

  it('a file whose unused directory entries are left as zeros', () => {
    const bytes = rawCompound({ ...soundTables, entries: [ROOT, STREAM], unusedEntries: 'zeros' })
    expect(opened(bytes).get('Data')?.length).toBe(4096)
  })

  for (const mark of [0xffff, 0xfeff, 0x0000]) {
    it(`a file whose byte-order field holds 0x${mark.toString(16).padStart(4, '0')}`, () => {
      // some writers leave another value there; cfb skips the field, and so did every reader
      // before the gate
      const bytes = patched((v) => v.setUint16(28, mark, true))
      expect(opened(bytes).get('Data')?.length).toBe(4096)
    })
  }

  it('a file without small streams whose unused mini FAT and mini stream starts name a sector', () => {
    const bytes = rawCompound({
      ...soundTables,
      entries: [{ ...ROOT, start: 0, size: 0 }, STREAM],
    })
    // no mini FAT sector, and sector 0 (the FAT) where its first one would be named
    new DataView(bytes.buffer).setUint32(60, 0, true)
    expect(opened(bytes).get('Data')?.length).toBe(4096)
  })

  it('a file whose last sector is cut short', () => {
    const bytes = rawCompound({ ...soundTables, entries: [ROOT, STREAM], cutFromEnd: 100 })
    expect(opened(bytes).get('Data')?.length).toBe(4096 - 100)
  })

  it('a stream whose chain goes back to an earlier sector', () => {
    const content = filled(4096, 5)
    // the stream's eight sectors in the order 6 7 8 9 2 3 4 5
    const order = [6, 7, 8, 9, 2, 3, 4, 5]
    const fat: Record<number, number> = { 0: FAT_SECTOR, 1: END }
    const data: Record<number, Uint8Array> = {}
    order.forEach((sector, nth) => {
      fat[sector] = order[nth + 1] ?? END
      data[sector] = content.subarray(nth * 512, (nth + 1) * 512)
    })
    const bytes = rawCompound({ sectors: 10, fat, data, entries: [ROOT, { ...STREAM, start: 6 }] })
    expect([...opened(bytes).get('Data')!]).toEqual([...content])
  })
})
