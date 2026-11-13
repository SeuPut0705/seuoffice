/**
 * A row or a column added to a table is inserted across the whole sheet, and
 * one deleted from it is deleted across the whole sheet: the op moves or
 * removes cells that are no part of the table. The write guard judges what the
 * op does to the sheet, using where the table is.
 *
 * "Row N" below is the sheet row (1-based) the op reaches; the table ops count
 * their rows inside the table's data area, header excluded, so data row 2 of a
 * table that starts on row 1 is sheet row 3.
 */
import { describe, expect, it } from 'vitest'

import { buildRedactionIndex, NO_REDACTIONS, type RedactionIndex } from '../src/renderer/ai/redact'
import { redactGuardForOps, type GuardTable } from '../src/renderer/ai/redact-guard'
import { createEditJournal, recordTableAdd } from '../src/renderer/edit-journal'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'
import {
  applyAiTableColumnAdd,
  applyAiTableColumnDelete,
  applyAiTableRowAdd,
  applyAiTableRowDelete,
} from '../src/renderer/workbook-ops'

const SHEETS = [
  { id: 'sh1', name: 'Customers' },
  { id: 'sh2', name: 'Orders' },
]

const hiddenAt = (...cells: [row: number, column: number][]): RedactionIndex =>
  buildRedactionIndex(
    [
      {
        sheetName: 'Customers',
        marks: cells.map(([row, column]) => ({
          startRow: row,
          endRow: row,
          startColumn: column,
          endColumn: column,
          label: 'client phone',
        })),
      },
    ],
    SHEETS,
  )

/** B3 */
const B3 = hiddenAt([2, 1])
/** the table over A1:C4, header on row 1 */
const SALES: GuardTable = { name: 'Sales', startRow: 0, endRow: 3, startColumn: 0, endColumn: 2 }
/** the same size, beside the marked column: E1:G4 */
const BESIDE: GuardTable = { name: 'Sales', startRow: 0, endRow: 3, startColumn: 4, endColumn: 6 }
/** the same size, below the marked row: A10:C13 */
const BELOW: GuardTable = { name: 'Sales', startRow: 9, endRow: 12, startColumn: 0, endColumn: 2 }

function guard(ops: Record<string, unknown>[], table: GuardTable | null, index = B3) {
  return redactGuardForOps(
    ops.map((op) => ({ sheetId: 'sh1', tableName: 'Sales', ...op })),
    index,
    (id) => SHEETS.find((sheet) => sheet.id === id)?.name,
    (name) => SHEETS.find((sheet) => sheet.name === name)?.id,
    (sheetId) => (sheetId === 'sh1' && table ? [table] : []),
  )
}

describe('add_table_row', () => {
  it('is refused when it inserts a row above a withheld cell', () => {
    // before data row 2, which is row 3: B3 slides to B4 and its mark stays
    const refusal = guard([{ op: 'add_table_row', row: 2 }], SALES)
    expect(refusal?.where).toBe('Customers!B3')
    expect(refusal?.reason).toContain('add_table_row')
    expect(refusal?.reason).toContain('{{client phone}}')
    expect(guard([{ op: 'add_table_row', row: 1, count: 3 }], SALES)).not.toBeNull()
  })

  it('is allowed when every withheld cell is above the row it inserts', () => {
    expect(guard([{ op: 'add_table_row', row: 3 }], SALES)).toBeNull()
    // appended: before row 5
    expect(guard([{ op: 'add_table_row' }], SALES)).toBeNull()
  })

  it('is refused at the end of the table when a withheld cell is below it', () => {
    const below = hiddenAt([5, 1])
    expect(guard([{ op: 'add_table_row' }], SALES, below)?.where).toBe('Customers!B6')
  })

  it('shifts the whole sheet, so a table beside the marked column is refused too', () => {
    expect(guard([{ op: 'add_table_row', row: 1 }], BESIDE)).not.toBeNull()
  })

  it('is allowed on a table below every withheld cell', () => {
    expect(guard([{ op: 'add_table_row', row: 2 }], BELOW)).toBeNull()
    expect(guard([{ op: 'add_table_row' }], BELOW)).toBeNull()
  })
})

describe('delete_table_row', () => {
  it('is refused when the row it deletes holds a withheld cell', () => {
    // data row 2 is row 3
    expect(guard([{ op: 'delete_table_row', row: 2 }], SALES)?.where).toBe('Customers!B3')
    // a run of rows that reaches it
    expect(guard([{ op: 'delete_table_row', row: 1, count: 2 }], SALES)).not.toBeNull()
  })

  it('is allowed on the rows around it', () => {
    expect(guard([{ op: 'delete_table_row', row: 1 }], SALES)).toBeNull()
    expect(guard([{ op: 'delete_table_row', row: 3 }], SALES)).toBeNull()
  })

  it('is allowed on a table away from the marked row', () => {
    expect(guard([{ op: 'delete_table_row', row: 2 }], BELOW)).toBeNull()
  })
})

describe('add_table_column', () => {
  it('is refused when it inserts a column before a withheld one', () => {
    expect(guard([{ op: 'add_table_column', column: 2, columnName: 'x' }], SALES)?.where).toBe(
      'Customers!B3',
    )
    expect(guard([{ op: 'add_table_column', column: 1, columnName: 'x' }], SALES)).not.toBeNull()
  })

  it('is allowed after the last withheld column', () => {
    expect(guard([{ op: 'add_table_column', column: 3, columnName: 'x' }], SALES)).toBeNull()
    expect(guard([{ op: 'add_table_column', columnName: 'x' }], SALES)).toBeNull()
  })

  it('is allowed on a table beside the marked column', () => {
    expect(guard([{ op: 'add_table_column', column: 1, columnName: 'x' }], BESIDE)).toBeNull()
  })
})

describe('delete_table_column', () => {
  it('is refused when the column it deletes holds a withheld cell', () => {
    expect(guard([{ op: 'delete_table_column', column: 2 }], SALES)?.where).toBe('Customers!B3')
  })

  it('is allowed on the columns around it', () => {
    expect(guard([{ op: 'delete_table_column', column: 1 }], SALES)).toBeNull()
    expect(guard([{ op: 'delete_table_column', column: 3 }], SALES)).toBeNull()
  })

  it('is allowed on a table beside the marked column', () => {
    expect(guard([{ op: 'delete_table_column', column: 1 }], BESIDE)).toBeNull()
  })
})

describe('where the table is not known', () => {
  it('is refused on a sheet that holds a withheld cell, for every table op', () => {
    for (const op of [
      { op: 'add_table_row' },
      { op: 'delete_table_row', row: 1 },
      { op: 'add_table_column', columnName: 'x' },
      { op: 'delete_table_column', column: 1 },
    ]) {
      expect(guard([op], null)?.reason, op.op).toContain(op.op)
    }
  })

  it('is allowed on a sheet that holds none', () => {
    expect(guard([{ op: 'add_table_row', sheetId: 'sh2', tableName: 'Orders' }], null)).toBeNull()
  })

  it('is refused when the caller gives no tables at all', () => {
    expect(
      redactGuardForOps([{ op: 'add_table_row', sheetId: 'sh1', tableName: 'Sales' }], B3),
    ).not.toBeNull()
  })
})

describe('a batch', () => {
  it('places a table the batch made itself, and follows it through its own ops', () => {
    const ops = (range: string) => [
      { op: 'add_table', sheetId: 'sh1', name: 'Fresh', range },
      { op: 'add_table_row', sheetId: 'sh1', tableName: 'Fresh', row: 1 },
    ]
    expect(redactGuardForOps(ops('A1:C4'), B3)).not.toBeNull()
    expect(redactGuardForOps(ops('A10:C13'), B3)).toBeNull()
  })

  it('judges the second op against the table the first left', () => {
    // the first op appends a row (the table is A1:C5 now); a second append lands
    // before row 6, which shifts the withheld cell on row 6
    expect(
      guard([{ op: 'add_table_row' }, { op: 'add_table_row' }], SALES, hiddenAt([5, 1])),
    ).not.toBeNull()
    expect(guard([{ op: 'add_table_row' }, { op: 'add_table_row' }], SALES)).toBeNull()
  })

  it('leaves a workbook that withholds nothing alone', () => {
    expect(
      redactGuardForOps(
        [{ op: 'add_table_row', sheetId: 'sh1', tableName: 'Sales' }],
        NO_REDACTIONS,
      ),
    ).toBeNull()
  })
})

describe('insert_rows and insert_cols through a mark that spans them', () => {
  const span = buildRedactionIndex(
    [
      {
        sheetName: 'Customers',
        marks: [{ startRow: 1, endRow: 2, startColumn: 1, endColumn: 2, label: 'client phone' }],
      },
    ],
    SHEETS,
  )
  const run = (op: Record<string, unknown>) => redactGuardForOps([{ sheetId: 'sh1', ...op }], span)

  it('refuses an insert inside the mark: the lower cells move, the mark does not', () => {
    // B2:C3, a row inserted before row 3
    expect(run({ op: 'insert_rows', row: 3, count: 1 })).not.toBeNull()
    expect(run({ op: 'insert_cols', column: 'C', count: 1 })).not.toBeNull()
  })

  it('allows an insert past the end of it', () => {
    expect(run({ op: 'insert_rows', row: 4, count: 1 })).toBeNull()
    expect(run({ op: 'insert_cols', column: 'D', count: 1 })).toBeNull()
  })
})

/**
 * The guard against what the executor really does: each table op is run
 * through the real `applyAiTable*` functions over a recording stand-in for
 * the Univer sheet, and the guard's answer must be the answer the recorded
 * calls give.
 */
describe('the guard agrees with the executor', () => {
  interface Call {
    readonly kind: 'insertRowsBefore' | 'deleteRows' | 'insertColumnsBefore' | 'deleteColumns'
    readonly at: number
    readonly count: number
  }

  function execute(op: Record<string, unknown>, table: GuardTable): Call[] {
    const calls: Call[] = []
    const record = (kind: Call['kind']) => (at: number, count: number) => {
      calls.push({ kind, at, count })
    }
    const sheet = {
      insertRowsBefore: record('insertRowsBefore'),
      deleteRows: record('deleteRows'),
      insertColumnsBefore: record('insertColumnsBefore'),
      deleteColumns: record('deleteColumns'),
      getRange: () => ({ setValue: () => undefined }),
    }
    const runtime = {
      univerAPI: { getActiveWorkbook: () => ({ getSheetBySheetId: () => sheet }) },
    } as unknown as UniverRuntime
    const journal = createEditJournal()
    recordTableAdd(journal, {
      sheetId: 'sh1',
      name: table.name,
      area: {
        startRow: table.startRow,
        endRow: table.endRow,
        startColumn: table.startColumn,
        endColumn: table.endColumn,
      },
      columnNames: ['a', 'b', 'c'],
      bandedRows: true,
    })
    const state = { editJournal: journal } as unknown as LazyWorkbookState
    const full = { sheetId: 'sh1', tableName: table.name, ...op } as never
    if (op.op === 'add_table_row') applyAiTableRowAdd(runtime, state, full)
    else if (op.op === 'add_table_column') applyAiTableColumnAdd(runtime, state, full)
    else if (op.op === 'delete_table_row') applyAiTableRowDelete(runtime, state, full)
    else applyAiTableColumnDelete(runtime, state, full)
    return calls
  }

  /** whether a cell at (row, column) is moved or removed by the calls */
  function touched(calls: readonly Call[], row: number, column: number): boolean {
    return calls.some(({ kind, at, count }) => {
      if (kind === 'insertRowsBefore') return row >= at
      if (kind === 'insertColumnsBefore') return column >= at
      if (kind === 'deleteRows') return row >= at && row < at + count
      return column >= at && column < at + count
    })
  }

  const OPS: Record<string, unknown>[] = [
    { op: 'add_table_row' },
    { op: 'add_table_row', row: 1 },
    { op: 'add_table_row', row: 3, count: 2 },
    { op: 'delete_table_row', row: 1 },
    { op: 'delete_table_row', row: 2, count: 2 },
    { op: 'add_table_column', columnName: 'x' },
    { op: 'add_table_column', column: 2, columnName: 'x' },
    { op: 'delete_table_column', column: 1 },
    { op: 'delete_table_column', column: 2, count: 2 },
  ]

  it.each(OPS.map((op) => [JSON.stringify(op), op] as const))(
    '%s: refused exactly when a withheld cell would be moved or removed',
    (_label, op) => {
      const calls = execute(op, SALES)
      for (let row = 0; row < 8; row += 1) {
        for (let column = 0; column < 6; column += 1) {
          // a delete takes the cell away, an insert slides it: either way it leaves its mark
          const refused = guard([op], SALES, hiddenAt([row, column])) !== null
          expect(refused, `a hidden cell at ${row},${column}`).toBe(touched(calls, row, column))
        }
      }
    },
  )
})
