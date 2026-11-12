import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'

import JSZip from 'jszip'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  applyCellEditsToXlsx,
  readBasicWorkbook,
  type SheetStructuralOps,
} from '../src/gateway/xlsx-gateway'
import { saveWorkbookViaSidecar, type ArchiveClient } from '../src/gateway/xlsx-package-io'
import {
  REDACTION_PART_PATH,
  applyRedactionNameMirror,
  parseRedactionPart,
  serializeRedactionPart,
  type SheetRedactionState,
} from '../src/gateway/xlsx-redaction'
import type { SheetEditPlan } from '../src/gateway/xlsx-sheets'

/// A cell hidden from AI has to stay hidden through every save, whatever the
/// save does to the workbook and whatever the caller knows about the marks.
/// Each case here saves through the gateway and then reads the saved file the
/// way a reader would: the marks from the part, the values from the sheets.

const SECRET = '13800138000'
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const B2 = { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1, label: 'client phone' }
const MARKS: readonly SheetRedactionState[] = [{ sheetName: 'Data', marks: [B2] }]

const text = (ref: string, value: string) =>
  `<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`

/// Data: the hidden phone at B2, a neighbour below it. Other: nothing hidden.
async function workbook(marks: { part?: string; mirror?: boolean } = {}): Promise<Buffer> {
  const zip = new JSZip()
  const sheets = ['Data', 'Other']
  let workbookXml =
    `<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets>` +
    sheets
      .map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('') +
    '</sheets></workbook>'
  if (marks.mirror !== false) workbookXml = applyRedactionNameMirror(workbookXml, MARKS, sheets)
  zip.file('xl/workbook.xml', workbookXml)
  zip.file(
    'xl/_rels/workbook.xml.rels',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      '</Relationships>',
  )
  zip.file(
    '[Content_Types].xml',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      '</Types>',
  )
  zip.file(
    'xl/worksheets/sheet1.xml',
    `<worksheet xmlns="${NS}"><sheetData>` +
      `<row r="1">${text('A1', 'Name')}${text('B1', 'Phone')}</row>` +
      `<row r="2">${text('A2', 'Kim')}${text('B2', SECRET)}</row>` +
      `<row r="3">${text('A3', 'Lee')}${text('B3', 'public')}</row>` +
      '</sheetData></worksheet>',
  )
  zip.file(
    'xl/worksheets/sheet2.xml',
    `<worksheet xmlns="${NS}"><sheetData><row r="1">${text('A1', 'stock')}</row></sheetData></worksheet>`,
  )
  zip.file(REDACTION_PART_PATH, marks.part ?? serializeRedactionPart(MARKS))
  return zip.generateAsync({ type: 'nodebuffer' })
}

interface Save {
  readonly ops?: readonly SheetStructuralOps[]
  readonly plan?: SheetEditPlan
  readonly states: readonly SheetRedactionState[] | null
  readonly edits?: Parameters<typeof applyCellEditsToXlsx>[1]
}

/// The sidecar's archive commands over an in-memory zip: the streaming save
/// path without the Rust binary. Sizes and checksums are those of the entry
/// contents, which is all the manifest comparison looks at.
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

let directory: string
let fileSeq = 0

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'redaction-save-'))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

/// Both ways the gateway assembles a saved package. They share the planner,
/// and a hidden cell has to come out of either one the same.
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
            null,
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
          redactionStates: save.states,
        })
        return readFile(path)
      },
    ],
  ]

function address(row: number, column: number): string {
  return `${String.fromCharCode(65 + column)}${row + 1}`
}

/// What the saved file withholds and what it hands over:
/// `hidden` is the value under every mark, as `Sheet!B2=value`;
/// `exposed` is every cell that holds the secret with no mark over it.
async function read(bytes: Buffer): Promise<{ hidden: string[]; exposed: string[] }> {
  const zip = await JSZip.loadAsync(bytes)
  const part = await zip.file(REDACTION_PART_PATH)?.async('string')
  const states = part === undefined ? [] : parseRedactionPart(part)
  const { snapshot } = await readBasicWorkbook(bytes)
  const hidden: string[] = []
  const exposed: string[] = []
  for (const state of states) {
    const sheet = snapshot.sheets.find((candidate) => candidate.name === state.sheetName)
    for (const mark of state.marks) {
      const at = address(mark.startRow, mark.startColumn)
      hidden.push(`${state.sheetName}!${at}=${String(sheet?.cells[at]?.value ?? '')}`)
    }
  }
  for (const sheet of snapshot.sheets) {
    const marks = states.find((state) => state.sheetName === sheet.name)?.marks ?? []
    for (const [at, cell] of Object.entries(sheet.cells)) {
      if (cell.value !== SECRET) continue
      const covered = marks.some(
        (mark) =>
          at === address(mark.startRow, mark.startColumn) /* every mark here is a single cell */,
      )
      if (!covered) exposed.push(`${sheet.name}!${at}`)
    }
  }
  return { hidden: hidden.sort(), exposed: exposed.sort() }
}

const copyOf = (name: string, sourceSheetName = 'Data') => ({ name, sourceSheetName })

describe.each(ASSEMBLERS)('a duplicated sheet keeps its hidden cells (%s)', (_path, save) => {
  it('hides the copy of a hidden cell on the new sheet', async () => {
    const saved = await save(await workbook(), {
      plan: {
        renames: [],
        removals: [],
        additions: [copyOf('Data (2)')],
        order: ['Data', 'Other', 'Data (2)'],
      },
      states: MARKS,
    })
    expect(await read(saved)).toEqual({
      hidden: [`Data (2)!B2=${SECRET}`, `Data!B2=${SECRET}`],
      exposed: [],
    })
  })

  it('follows the rows and columns each copy went through', async () => {
    // A copy of a copy reaches the gateway as two copies of the file sheet,
    // each with the row and column edits it saw: the first copy got a row
    // above the value, the second inherited that row and then got a column.
    const saved = await save(await workbook(), {
      plan: {
        renames: [],
        removals: [],
        additions: [copyOf('Data (2)'), copyOf('Data (3)')],
        order: ['Data', 'Other', 'Data (2)', 'Data (3)'],
      },
      ops: [
        { sheetName: 'Data (2)', ops: [{ kind: 'insert-rows', index: 0, count: 1 }] },
        {
          sheetName: 'Data (3)',
          ops: [
            { kind: 'insert-rows', index: 0, count: 1 },
            { kind: 'insert-cols', index: 0, count: 1 },
          ],
        },
      ],
      states: MARKS,
    })
    expect(await read(saved)).toEqual({
      hidden: [`Data (2)!B3=${SECRET}`, `Data (3)!C3=${SECRET}`, `Data!B2=${SECRET}`],
      exposed: [],
    })
  })

  it('takes the copy as it was taken, not as the source ends up', async () => {
    // The source got a row after the copy was made: its own mark moves, the
    // copy's stays with the copy's cells.
    const saved = await save(await workbook(), {
      plan: {
        renames: [],
        removals: [],
        additions: [copyOf('Data (2)')],
        order: ['Data', 'Other', 'Data (2)'],
      },
      ops: [{ sheetName: 'Data', ops: [{ kind: 'insert-rows', index: 0, count: 2 }] }],
      states: MARKS,
    })
    expect(await read(saved)).toEqual({
      hidden: [`Data (2)!B2=${SECRET}`, `Data!B4=${SECRET}`],
      exposed: [],
    })
  })

  it('hides the copy when its source is renamed in the same save', async () => {
    const saved = await save(await workbook(), {
      plan: {
        renames: [{ sheetName: 'Data', newName: 'Clients' }],
        removals: [],
        additions: [copyOf('Data (2)')],
        order: ['Clients', 'Other', 'Data (2)'],
      },
      states: MARKS,
    })
    expect(await read(saved)).toEqual({
      hidden: [`Clients!B2=${SECRET}`, `Data (2)!B2=${SECRET}`],
      exposed: [],
    })
  })

  it('hides the copy when its source is removed in the same save', async () => {
    const saved = await save(await workbook(), {
      plan: {
        renames: [],
        removals: ['Data'],
        additions: [copyOf('Kept copy')],
        order: ['Other', 'Kept copy'],
      },
      states: MARKS,
    })
    expect(await read(saved)).toEqual({ hidden: [`Kept copy!B2=${SECRET}`], exposed: [] })
  })

  it('hides the copy that takes the name of its removed source', async () => {
    const saved = await save(await workbook(), {
      plan: {
        renames: [],
        removals: ['Data'],
        additions: [copyOf('Data')],
        order: ['Other', 'Data'],
      },
      states: MARKS,
    })
    expect(await read(saved)).toEqual({ hidden: [`Data!B2=${SECRET}`], exposed: [] })
  })

  it('keeps one mark when the caller already listed it for the copy', async () => {
    const saved = await save(await workbook(), {
      plan: {
        renames: [],
        removals: [],
        additions: [copyOf('Data (2)')],
        order: ['Data', 'Other', 'Data (2)'],
      },
      states: [...MARKS, { sheetName: 'Data (2)', marks: [B2] }],
    })
    expect(await read(saved)).toEqual({
      hidden: [`Data (2)!B2=${SECRET}`, `Data!B2=${SECRET}`],
      exposed: [],
    })
  })

  it('refuses a copy whose source is itself a sheet added in this save', async () => {
    // Nothing in the file can seed such a copy, so there are no cells to
    // carry marks for; the save has to fail rather than write a blank sheet.
    await expect(
      save(await workbook(), {
        plan: {
          renames: [],
          removals: [],
          additions: [copyOf('Data (2)'), copyOf('Data (3)', 'Data (2)')],
          order: ['Data', 'Other', 'Data (2)', 'Data (3)'],
        },
        states: MARKS,
      }),
    ).rejects.toThrow(/Data \(2\)/)
  })
})
