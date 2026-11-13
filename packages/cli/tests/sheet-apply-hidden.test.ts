import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { xlsxSidecarPath } from '../src/resources'
import { PLACEHOLDER, SECRET } from './hidden-text-fixtures'
import { run, tempDir } from './helpers'
import { expectNoGiveaway, richHiddenXlsx } from './rich-hidden-xlsx'

const sidecar = Boolean(xlsxSidecarPath())

/**
 * The book (rich-hidden-xlsx): B2 holds the hidden phone number, C2 `=B2*2` and
 * D2 `=C2+1` compute from it, A3 and B3 are plain, a note and a list validation
 * sit on B2 and the name Phone points at it.
 */

/** ops that would read, overwrite, move or publish the hidden cell, or one computed from it */
const REFUSED: Record<string, unknown[]> = {
  'set_cell on the cell': [{ op: 'set_cell', address: 'B2', value: 'X' }],
  'set_cell guessing the cell': [
    { op: 'set_cell', address: 'B2', value: 'X', expectedValue: Number(SECRET) },
  ],
  'set_cell on a cell computed from it': [{ op: 'set_cell', address: 'C2', value: 1 }],
  'set_cell formula reading it': [{ op: 'set_cell', address: 'F2', value: '=B2' }],
  'set_cell formula reading it, absolute': [{ op: 'set_cell', address: 'F2', value: '=$B$2+1' }],
  'set_cell formula reading its column': [{ op: 'set_cell', address: 'F2', value: '=SUM(B:B)' }],
  'set_cell formula reading a cell computed from it': [
    { op: 'set_cell', address: 'F2', value: '=C2' },
  ],
  'set_cell formula through the defined name': [{ op: 'set_cell', address: 'F2', value: '=Phone' }],
  'set_formula reading it': [{ op: 'set_formula', address: 'F2', formula: '=B2' }],
  'set_range over it': [{ op: 'set_range', start: 'A2', values: [['a', 'b']] }],
  clear_cell: [{ op: 'clear_cell', address: 'B2' }],
  'clear_range over it': [{ op: 'clear_range', range: 'A2:C2' }],
  'fill_range from it': [{ op: 'fill_range', source: 'B2', target: 'B4:B5' }],
  'fill_range onto it': [{ op: 'fill_range', source: 'B3', target: 'B2' }],
  'copy_range from it': [{ op: 'copy_range', source: 'B2:C2', target: 'F2' }],
  'copy_range onto it': [{ op: 'copy_range', source: 'A3:B3', target: 'A2' }],
  'move_range from it': [{ op: 'move_range', source: 'B2', target: 'F2' }],
  'find_replace over it': [{ op: 'find_replace', range: 'A1:D3', find: '1380', replace: 'x' }],
  'find_replace counting it': [
    { op: 'find_replace', range: 'B2', find: SECRET.slice(0, 3), replace: SECRET.slice(0, 3) },
  ],
  'sort_range over it': [{ op: 'sort_range', range: 'A2:D3', byColumn: 'B', order: 'asc' }],
  'convert_to_values on a cell computed from it': [{ op: 'convert_to_values', range: 'C2:D2' }],
  'merge_cells over it': [{ op: 'merge_cells', range: 'A2:B2' }],
  'delete_rows holding it': [{ op: 'delete_rows', row: 2, count: 1 }],
  'delete_cols holding it': [{ op: 'delete_cols', column: 'B', count: 1 }],
  'insert_rows above it': [{ op: 'insert_rows', row: 2, count: 1 }],
  'insert_cols before it': [{ op: 'insert_cols', column: 'B', count: 1 }],
  duplicate_sheet: [{ op: 'duplicate_sheet', sheet: 'table', name: 'copy' }],
  delete_sheet: [
    { op: 'add_sheet', name: 'other' },
    { op: 'delete_sheet', sheet: 'table' },
  ],
  'add_pivot from it': [
    {
      op: 'add_pivot',
      sourceRange: 'A1:C3',
      rowFields: ['Name'],
      values: [{ field: 'Phone', agg: 'sum' }],
      targetCell: 'H1',
    },
  ],
  'add_table over it': [{ op: 'add_table', range: 'A1:C3', name: 'People' }],
}

/** ops that leave the cell alone: they still run, and the cell stays hidden */
const ALLOWED: Record<string, unknown[]> = {
  'a plain cell': [{ op: 'set_cell', address: 'A3', value: 'Park' }],
  'a formula over plain cells': [{ op: 'set_cell', address: 'E3', value: '=A3&B3' }],
  'formatting the cell': [{ op: 'format_range', range: 'B2', format: { bold: true } }],
  'a note on the cell': [{ op: 'set_note', address: 'B2', text: 'again' }],
  'a width': [{ op: 'set_col_width', column: 'B', widthPx: 120 }],
  'a row below': [{ op: 'insert_rows', row: 4, count: 1 }],
}

async function sheetXml(file: string): Promise<string> {
  return (await JSZip.loadAsync(readFileSync(file)))
    .file('xl/worksheets/sheet1.xml')!
    .async('string')
}

function opsFile(dir: string, ops: unknown[]): string {
  const path = join(dir, `ops-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(path, JSON.stringify(ops))
  return path
}

describe.skipIf(!sidecar)('sheet apply over a cell hidden from AI', () => {
  for (const [name, ops] of Object.entries(REFUSED)) {
    it(`refuses ${name}, says nothing of the cell, writes nothing`, async () => {
      const dir = tempDir()
      const file = await richHiddenXlsx(dir)
      const before = readFileSync(file)
      for (const flags of [[], ['--dry-run']]) {
        const applied = await run([
          'sheet',
          'apply',
          file,
          '--ops',
          opsFile(dir, ops),
          ...flags,
          '--json',
        ])
        expect(applied.code, `${name} ${flags.join(' ')}: ${applied.stdout}`).not.toBe(0)
        expectNoGiveaway(applied.stdout + applied.stderr, name)
        expect(readFileSync(file).equals(before)).toBe(true)
      }
    })
  }

  for (const [name, ops] of Object.entries(ALLOWED)) {
    it(`still applies ${name}, and the cell stays hidden`, async () => {
      const dir = tempDir()
      const file = await richHiddenXlsx(dir)
      const applied = await run(['sheet', 'apply', file, '--ops', opsFile(dir, ops), '--json'])
      expect(applied.code, applied.stdout).toBe(0)
      expectNoGiveaway(applied.stdout + applied.stderr, name)
      const read = await run(['sheet', 'read', file, '--json'])
      expect(read.json().detail.rows[1][1]).toBe(PLACEHOLDER)
      expectNoGiveaway(read.stdout, `sheet read after ${name}`)
      // the cell still holds its number in the file, under the mark
      expect(await sheetXml(file)).toContain(`<v>${SECRET}</v>`)
    })
  }

  it('best-effort drops the refused op and applies the rest', async () => {
    const dir = tempDir()
    const file = await richHiddenXlsx(dir)
    const ops = opsFile(dir, [
      { op: 'set_cell', address: 'B2', value: 'X' },
      { op: 'set_cell', address: 'A3', value: 'Park' },
    ])
    const applied = await run(['sheet', 'apply', file, '--ops', ops, '--best-effort', '--json'])
    expectNoGiveaway(applied.stdout + applied.stderr, 'best-effort')
    expect(await sheetXml(file)).toContain(`<v>${SECRET}</v>`)
    expect(await sheetXml(file)).toContain('Park')
  })

  it('--cells refuses the hidden cell and what is computed from it', async () => {
    const dir = tempDir()
    const file = await richHiddenXlsx(dir)
    const before = readFileSync(file)
    for (const cells of [
      [{ cell: 'B2', value: 'X' }],
      [{ cell: 'C2', value: 1 }],
      [{ cell: 'F2', formula: '=B2' }],
      [{ cell: 'F2', value: '=B2*3' }],
    ]) {
      const spec = join(dir, 'cells.json')
      writeFileSync(spec, JSON.stringify(cells))
      const applied = await run(['sheet', 'apply', file, '--cells', spec, '--json'])
      expect(applied.code, JSON.stringify(cells)).not.toBe(0)
      expectNoGiveaway(applied.stdout + applied.stderr, '--cells')
      expect(readFileSync(file).equals(before)).toBe(true)
    }
    const spec = join(dir, 'ok.json')
    writeFileSync(spec, JSON.stringify([{ cell: 'A3', value: 'Park' }]))
    expect((await run(['sheet', 'apply', file, '--cells', spec, '--json'])).code).toBe(0)
    expect(await sheetXml(file)).toContain(`<v>${SECRET}</v>`)
  })
})

describe.skipIf(!sidecar)('sheet links --break over a workbook with a hidden cell', () => {
  it('refuses: a formula computed from the cell would become its value', async () => {
    const dir = tempDir()
    const file = await richHiddenXlsx(dir)
    const before = readFileSync(file)
    const broken = await run(['sheet', 'links', file, '--break', '1', '--json'])
    expect(broken.code).not.toBe(0)
    expect(broken.stdout).toContain('hidden from AI')
    expectNoGiveaway(broken.stdout + broken.stderr, 'links --break')
    expect(readFileSync(file).equals(before)).toBe(true)
  })
})

describe.skipIf(!sidecar)('an unmarked workbook takes the same ops as before', () => {
  it('writes B2, copies it and deletes its row', async () => {
    const dir = tempDir()
    const table = join(dir, 'table.json')
    writeFileSync(
      table,
      JSON.stringify([
        ['Name', 'Phone'],
        ['Kim', 1],
        ['Lee', 2],
      ]),
    )
    const file = join(dir, 'plain.xlsx')
    expect(
      (await run(['create', '--type', 'xlsx', '--from', table, '--out', file, '--json'])).code,
    ).toBe(0)
    for (const ops of [
      [{ op: 'set_cell', address: 'B2', value: 9 }],
      [{ op: 'copy_range', source: 'A2:B2', target: 'D2' }],
      [{ op: 'set_cell', address: 'D3', value: '=B2' }],
      [{ op: 'delete_rows', row: 3, count: 1 }],
    ]) {
      const applied = await run(['sheet', 'apply', file, '--ops', opsFile(dir, ops), '--json'])
      expect(applied.code, applied.stdout).toBe(0)
    }
  })
})
