import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'

import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { applyCellEditsToXlsx, type SheetStructuralOps } from '../src/gateway/xlsx-gateway'
import { saveWorkbookViaSidecar, type ArchiveClient } from '../src/gateway/xlsx-package-io'
import {
  REDACTION_MIRROR_PREFIX,
  REDACTION_PART_PATH,
  parseRedactionPart,
  readRedactionRecord,
  type SheetRedactionState,
} from '../src/gateway/xlsx-redaction'
import type { DefinedNamesState } from '../src/gateway/xlsx-defined-names'
import type { SheetEditPlan } from '../src/gateway/xlsx-sheets'
import {
  HIDDEN_MARKS,
  LABEL,
  RECORD_KINDS,
  REDACTION_REL_TYPE,
  SECRET,
  TAG_MUTATION_NAMES,
  hiddenBook,
  mutatedHiddenBook,
  mutatePackage,
  padSheet,
  type RecordKind,
} from './helpers/hidden-book'
import { childNamed, childrenNamed, parseXml } from './helpers/xml-oracle'

/**
 * A mark must survive every save of a workbook whose XML is spelled another
 * valid way: not duplicated (the part's relationship and content type, the
 * mirrored names), not lost, and not left on the cells that were moved away.
 * The record is read back with a real XML parser, not with the patterns the
 * gateway reads it with.
 */

/** `startRow,startColumn:endRow,endColumn label`, one per mark, by sheet */
type Marks = Record<string, string[]>

function described(
  sheetName: string,
  mark: SheetRedactionState['marks'][number],
): [string, string] {
  return [
    sheetName,
    `${mark.startRow},${mark.startColumn}:${mark.endRow},${mark.endColumn} ${mark.label}`,
  ]
}

function marksOf(states: readonly SheetRedactionState[]): Marks {
  const out: Marks = {}
  for (const state of states) {
    for (const mark of state.marks) {
      const [sheet, text] = described(state.sheetName, mark)
      ;(out[sheet] ??= []).push(text)
    }
  }
  for (const sheet of Object.keys(out)) out[sheet]!.sort()
  return out
}

interface PackageRecord {
  readonly part: Marks | undefined
  readonly sheetNames: readonly string[]
  readonly mirror: Marks
  readonly mirrorEntries: number
  readonly relationships: number
  readonly overrides: number
}

/** everything a saved package says about its marks, read without the gateway's own readers */
async function recordOf(bytes: Buffer): Promise<PackageRecord> {
  const zip = await JSZip.loadAsync(bytes)
  const part = await zip.file(REDACTION_PART_PATH)?.async('string')
  const workbook = parseXml(await zip.file('xl/workbook.xml')!.async('string'))
  const sheetNames = childrenNamed(childNamed(workbook, 'sheets'), 'sheet').map(
    (sheet) => sheet.attributes.name!,
  )
  const mirrored = childrenNamed(childNamed(workbook, 'definedNames'), 'definedName').filter(
    (name) => name.attributes.name!.startsWith(REDACTION_MIRROR_PREFIX),
  )
  const mirror: SheetRedactionState[] = mirrored.map((entry) => {
    const payload = JSON.parse(entry.text.trim().slice(1, -1).replaceAll('""', '"')) as {
      sheet: number
      from: [number, number]
      to: [number, number]
      label: string
    }
    return {
      sheetName: sheetNames[payload.sheet]!,
      marks: [
        {
          startRow: payload.from[0],
          startColumn: payload.from[1],
          endRow: payload.to[0],
          endColumn: payload.to[1],
          label: payload.label,
        },
      ],
    }
  })
  const relationships = childrenNamed(
    parseXml(await zip.file('xl/_rels/workbook.xml.rels')!.async('string')),
    'Relationship',
  ).filter((rel) => rel.attributes.Type === REDACTION_REL_TYPE)
  const overrides = childrenNamed(
    parseXml(await zip.file('[Content_Types].xml')!.async('string')),
    'Override',
  ).filter((override) => override.attributes.PartName === `/${REDACTION_PART_PATH}`)
  return {
    sheetNames,
    part:
      part === undefined
        ? undefined
        : marksOf(
            (
              JSON.parse(part) as {
                sheets: { name: string; marks: SheetRedactionState['marks'][number][] }[]
              }
            ).sheets.map((sheet) => ({ sheetName: sheet.name, marks: sheet.marks })),
          ),
    mirror: marksOf(mirror),
    mirrorEntries: mirrored.length,
    relationships: relationships.length,
    overrides: overrides.length,
  }
}

/** the sidecar's archive commands over an in-memory zip, as redaction-save.test.ts has them */
function archiveStub(): ArchiveClient {
  const entriesOf = async (path: string): Promise<Map<string, Buffer>> => {
    const zip = await JSZip.loadAsync(await readFile(path))
    const entries = new Map<string, Buffer>()
    for (const [name, file] of Object.entries(zip.files)) {
      if (!file.dir) entries.set(name, await file.async('nodebuffer'))
    }
    return entries
  }
  const manifestOf = (entries: ReadonlyMap<string, Buffer>) =>
    [...entries].map(([name, bytes]) => ({
      name,
      crc32: crc32(bytes),
      compressedSize: bytes.length,
      uncompressedSize: bytes.length,
    }))
  return {
    archiveManifest: async (path) => ({ entries: manifestOf(await entriesOf(path)) }),
    readEntries: async ({ path, entries, outputDir }) => {
      const all = await entriesOf(path)
      const extracted: { name: string; path: string }[] = []
      for (const [index, name] of entries.entries()) {
        const bytes = all.get(name)
        if (bytes === undefined) throw new Error(`missing entry ${name}`)
        const target = join(outputDir, `entry-${index}`)
        await writeFile(target, bytes)
        extracted.push({ name, path: target })
      }
      return { entries: extracted }
    },
    scanEntries: async ({ path, entries, needle }) => {
      const all = await entriesOf(path)
      return {
        matches: entries.filter((name) => all.get(name)?.toString('utf8').includes(needle)),
      }
    },
    saveArchive: async ({ sourcePath, targetPath, replacements, removals, additions }) => {
      const before = await entriesOf(sourcePath)
      const after = new Map(before)
      for (const name of removals) after.delete(name)
      for (const { name, contentPath } of [...replacements, ...additions]) {
        after.set(name, await readFile(contentPath))
      }
      const zip = new JSZip()
      for (const [name, bytes] of after) zip.file(name, bytes, { createFolders: false })
      await writeFile(targetPath, await zip.generateAsync({ type: 'nodebuffer' }))
      return { beforeEntries: manifestOf(before), afterEntries: manifestOf(after) }
    },
  }
}

interface Save {
  readonly ops?: readonly SheetStructuralOps[]
  readonly plan?: SheetEditPlan
  readonly states: readonly SheetRedactionState[] | null
  readonly edits?: Parameters<typeof applyCellEditsToXlsx>[1]
  readonly names?: DefinedNamesState
}

let directory: string
let fileSeq = 0

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'redaction-tag-mutations-'))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** both ways the gateway assembles a saved package */
const ASSEMBLERS: readonly (readonly [string, (source: Buffer, save: Save) => Promise<Buffer>])[] =
  [
    [
      'in memory',
      async (source, save) =>
        (
          await applyCellEditsToXlsx(
            source,
            save.edits ?? [],
            save.ops ?? [],
            [],
            save.plan,
            [],
            [],
            [],
            [],
            [],
            save.names ?? null,
            [],
            [],
            [],
            save.states,
          )
        ).buffer,
    ],
    [
      'through the sidecar',
      async (source, save) => {
        const path = join(directory, `book-${++fileSeq}.xlsx`)
        await writeFile(path, source)
        await saveWorkbookViaSidecar({
          client: archiveStub(),
          sourcePath: path,
          targetPath: path,
          edits: save.edits ?? [],
          structuralOps: save.ops,
          sheetPlan: save.plan,
          definedNamesState: save.names ?? null,
          redactionStates: save.states,
        })
        return readFile(path)
      },
    ],
  ]

const SECOND_MARK: SheetRedactionState = {
  sheetName: 'Report',
  marks: [{ startRow: 3, endRow: 3, startColumn: 0, endColumn: 0, label: 'pivot phone' }],
}
const DATA_AFTER_ROW_INSERT: SheetRedactionState = {
  sheetName: 'Data',
  marks: [{ startRow: 2, endRow: 3, startColumn: 1, endColumn: 1, label: LABEL }],
}
const RENAMED: SheetRedactionState = { sheetName: 'Clients', marks: HIDDEN_MARKS[0]!.marks }
const ONE_RECORD = marksOf(HIDDEN_MARKS)
const INSERT_ROW_ABOVE: readonly SheetStructuralOps[] = [
  { sheetName: 'Data', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] },
]

/** the record every reader of the saved package would find, whichever copy it reads */
function expectRecord(actual: PackageRecord, expected: Marks): void {
  const marks = Object.values(expected).reduce((count, sheet) => count + sheet.length, 0)
  expect(actual.part ?? {}).toEqual(expected)
  // a mark keyed by a name no sheet has covers nothing
  for (const sheet of Object.keys(expected)) expect(actual.sheetNames).toContain(sheet)
  expect(actual.mirror).toEqual(expected)
  expect(actual.mirrorEntries).toBe(marks)
  expect(actual.relationships).toBe(marks === 0 ? 0 : 1)
  expect(actual.overrides).toBe(marks === 0 ? 0 : 1)
}

/** the cells of the sheet named `name` that hold the secret, found with the XML oracle */
async function secretCells(bytes: Buffer, name: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes)
  const parse = async (path: string) => parseXml(await zip.file(path)!.async('string'))
  const sheet = childrenNamed(childNamed(await parse('xl/workbook.xml'), 'sheets'), 'sheet').find(
    (entry) => entry.attributes.name === name,
  )
  const rel = childrenNamed(await parse('xl/_rels/workbook.xml.rels'), 'Relationship').find(
    (entry) => entry.attributes.Id === sheet?.attributes.id,
  )
  const shared = childrenNamed(await parse('xl/sharedStrings.xml'), 'si').map(
    (entry) => childNamed(entry, 't')?.text ?? '',
  )
  const sheetData = childNamed(await parse(`xl/${rel?.attributes.Target}`), 'sheetData')
  return childrenNamed(sheetData, 'row')
    .flatMap((row) => childrenNamed(row, 'c'))
    .filter((cell) => {
      // a formula's cached result is not the cell's content: the readers trace it
      if (childNamed(cell, 'f') !== undefined) return false
      const inline = childNamed(childNamed(cell, 'is'), 't')?.text
      const value =
        cell.attributes.t === 's'
          ? shared[Number(childNamed(cell, 'v')?.text)]
          : (inline ?? childNamed(cell, 'v')?.text)
      return value === SECRET
    })
    .map((cell) => cell.attributes.r!)
}

/** every XML part of the saved package is well-formed, as a strict parser reads it */
async function expectWellFormed(bytes: Buffer): Promise<void> {
  const zip = await JSZip.loadAsync(bytes)
  for (const path of Object.keys(zip.files)) {
    if (!/\.(?:xml|rels)$/.test(path)) continue
    const xml = await zip.file(path)!.async('string')
    expect(() => parseXml(xml), path).not.toThrow()
  }
}

/** the secret sits in a cell a mark covers, and in no other */
async function expectSecretCovered(bytes: Buffer, states: readonly SheetRedactionState[]) {
  const holding = await secretCells(bytes, states[0]!.sheetName)
  expect(holding.length).toBeGreaterThan(0)
  for (const at of holding) {
    const column = at.charCodeAt(0) - 65
    const row = Number(at.slice(1)) - 1
    expect(
      states[0]!.marks.some(
        (mark) =>
          row >= mark.startRow &&
          row <= mark.endRow &&
          column >= mark.startColumn &&
          column <= mark.endColumn,
      ),
      `${at} holds the secret`,
    ).toBe(true)
  }
}

describe.each(['none', ...TAG_MUTATION_NAMES] as const)(
  'the workbook with the tags rewritten: %s',
  (mutation) => {
    it.each(RECORD_KINDS)('is well-formed (record: %s)', async (record) => {
      await expectWellFormed(Buffer.from(await mutatedHiddenBook(mutation, { record })))
    })
  },
)

describe.each(['none', ...TAG_MUTATION_NAMES] as const)(
  'saved with the tags rewritten: %s',
  (mutation) => {
    describe.each(RECORD_KINDS)('record: %s', (record: RecordKind) => {
      describe.each(ASSEMBLERS)('%s', (_name, save) => {
        const source = async () =>
          Buffer.from(await mutatedHiddenBook(mutation, { record, pivotOver: 'Report' }))

        it('moves the marks with a row inserted above them, without being given them', async () => {
          const saved = await save(await source(), { ops: INSERT_ROW_ABOVE, states: null })
          expectRecord(await recordOf(saved), marksOf([DATA_AFTER_ROW_INSERT]))
          await expectSecretCovered(saved, [DATA_AFTER_ROW_INSERT])
          await expectWellFormed(saved)
        })

        it('takes the marks to a renamed sheet, without being given them', async () => {
          const saved = await save(await source(), {
            plan: {
              renames: [{ sheetName: 'Data', newName: 'Clients' }],
              removals: [],
              additions: [],
              order: ['Clients', 'Report'],
            },
            states: null,
          })
          expectRecord(await recordOf(saved), marksOf([RENAMED]))
          await expectSecretCovered(saved, [RENAMED])
          await expectWellFormed(saved)
        })

        it('writes the marks it is given once, over a record that is already there', async () => {
          const saved = await save(await source(), {
            states: [...HIDDEN_MARKS, SECOND_MARK],
          })
          expectRecord(await recordOf(saved), marksOf([...HIDDEN_MARKS, SECOND_MARK]))
        })

        it('removes every trace of the record when the last mark is cleared', async () => {
          const saved = await save(await source(), { states: [] })
          expectRecord(await recordOf(saved), {})
        })

        it('keeps the mirrored names through a save of the defined names', async () => {
          const saved = await save(await source(), {
            names: {
              names: [
                { name: 'phone', formula: 'Data!$B$2' },
                { name: 'greeting', formula: '"hello"' },
              ],
              preserveNames: [],
            },
            states: null,
          })
          const kept = await recordOf(saved)
          expect(kept.mirror).toEqual(record === 'part' ? {} : ONE_RECORD)
          expect(kept.mirrorEntries).toBe(record === 'part' ? 0 : 1)
          expect(kept.part ?? {}).toEqual(record === 'mirror' ? {} : ONE_RECORD)
        })

        it('reads back, through the gateway, the record it wrote', async () => {
          const saved = await save(await source(), { ops: INSERT_ROW_ABOVE, states: null })
          const zip = await JSZip.loadAsync(saved)
          const states = await readRedactionRecord(
            async () => zip.file(REDACTION_PART_PATH)?.async('string'),
            await zip.file('xl/workbook.xml')!.async('string'),
          )
          expect(marksOf(states)).toEqual(marksOf([DATA_AFTER_ROW_INSERT]))
        })
      })
    })
  },
)

/**
 * A worksheet past the size above which a reader looks for the spellings it
 * cannot read before it rewrites the part: the cells and the record must still
 * move together. The rows carry `>` and `/>` inside double-quoted values,
 * which no other spelling gives away.
 */
const LARGE = 2 * 1024 * 1024 + 1

describe.each(ASSEMBLERS)('a sheet past 2 MiB with > and /> inside values (%s)', (_name, save) => {
  const OPS: [string, readonly SheetStructuralOps[]][] = [
    ['insert_rows', [{ sheetName: 'Data', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] }]],
    ['insert_cols', [{ sheetName: 'Data', ops: [{ kind: 'insert-cols', index: 0, count: 1 }] }]],
    [
      'delete a row above',
      [{ sheetName: 'Data', ops: [{ kind: 'remove-rows', index: 0, count: 1 }] }],
    ],
    [
      'delete a column before',
      [{ sheetName: 'Data', ops: [{ kind: 'remove-cols', index: 0, count: 1 }] }],
    ],
  ]

  async function large(record: RecordKind): Promise<Buffer> {
    const book = await mutatePackage(
      await padSheet(await hiddenBook({ record, pivotOver: 'Report' }), LARGE),
      '> and /> inside values',
    )
    return Buffer.from(book)
  }

  it.each(OPS)('%s: the secret stays under its mark', async (_label, ops) => {
    const source = await large('part')
    const zip = await JSZip.loadAsync(source)
    // the part really is large, and its tags really are all double-quoted
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string')
    expect(sheet.length).toBeGreaterThan(LARGE)
    expect(sheet).toContain('data-x="a/>b>c"')
    expect(sheet).not.toMatch(/<!--|<!\[CDATA\[|<\/[^>\s]+\s+>/)

    const saved = await save(source, { ops, states: null })

    const savedZip = await JSZip.loadAsync(saved)
    const states = parseRedactionPart(await savedZip.file(REDACTION_PART_PATH)!.async('string'))
    await expectSecretCovered(saved, states)
    await expectWellFormed(saved)
  })
})
