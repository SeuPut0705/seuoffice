/**
 * A write lands where the op puts it, not where it names it: a copy or a move
 * to one cell pastes a block the size of its source, and a pivot's output
 * fills a grid down and right of its target cell. The guard judges the cells
 * the op writes. And what is withheld is decided by the marks, never by what
 * the cell's value looks like.
 */
import { describe, expect, it } from 'vitest'

import { buildRedactionIndex, modelCellValue, type RedactionIndex } from '../src/renderer/ai/redact'
import { redactGuardForOps } from '../src/renderer/ai/redact-guard'

const SHEETS = [
  { id: 'sh1', name: 'Customers' },
  { id: 'sh2', name: 'Orders' },
]

/** B2 on Customers */
const INDEX: RedactionIndex = buildRedactionIndex(
  [
    {
      sheetName: 'Customers',
      marks: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 1, label: 'client phone' }],
    },
  ],
  SHEETS,
)

const sheetName = (id: string): string | undefined => SHEETS.find((sheet) => sheet.id === id)?.name
const sheetId = (name: string): string | undefined => SHEETS.find((s) => s.name === name)?.id
const guard = (ops: unknown[]) => redactGuardForOps(ops, INDEX, sheetName, sheetId)

describe.each(['copy_range', 'move_range'])('%s to one cell', (op) => {
  it('is refused when the block it pastes covers a withheld cell', () => {
    // A3:B3 lands on A2:B2: the target is A2 alone, the paste is two cells wide
    const refusal = guard([{ op, sheetId: 'sh1', source: 'A3:B3', target: 'A2' }])
    expect(refusal?.where).toBe('Customers!B2')
    // and down: A5:A6 lands on B1:B2
    expect(guard([{ op, sheetId: 'sh1', source: 'D5:D6', target: 'B1' }])?.where).toBe(
      'Customers!B2',
    )
  })

  it('stays allowed when the block it pastes misses every withheld cell', () => {
    expect(guard([{ op, sheetId: 'sh1', source: 'A5:B5', target: 'A3' }])).toBeNull()
    expect(guard([{ op, sheetId: 'sh1', source: 'A5:B5', target: 'D2' }])).toBeNull()
  })

  it('judges a target written as a range of the source size as it is', () => {
    expect(guard([{ op, sheetId: 'sh1', source: 'A3:B3', target: 'A2:B2' }])?.where).toBe(
      'Customers!B2',
    )
    expect(guard([{ op, sheetId: 'sh1', source: 'A3:B3', target: 'A4:B4' }])).toBeNull()
  })

  it('judges a paste on another sheet by that sheet marks', () => {
    expect(
      guard([{ op, sheetId: 'sh2', sourceSheetId: 'sh2', source: 'A3:B3', target: 'A2' }]),
    ).toBeNull()
  })
})

describe('add_pivot', () => {
  it('is refused when its output grid, down and right of the target, can reach a withheld cell', () => {
    const refusal = guard([
      {
        op: 'add_pivot',
        sheetId: 'sh2',
        targetSheetId: 'sh1',
        sourceRange: 'A1:C9',
        targetCell: 'A1',
        rowFields: 'Region',
      },
    ])
    expect(refusal?.where).toBe('Customers!B2')
  })

  it('stays allowed when the output starts below and right of every withheld cell', () => {
    expect(
      guard([
        {
          op: 'add_pivot',
          sheetId: 'sh2',
          targetSheetId: 'sh1',
          sourceRange: 'A1:C9',
          targetCell: 'D5',
          rowFields: 'Region',
        },
      ]),
    ).toBeNull()
  })
})

describe('a cell is withheld by its mark, not by what it holds', () => {
  const LITERAL = '{{client phone}}'

  it('still refuses a write into a withheld cell that holds the placeholder text itself', () => {
    expect(guard([{ op: 'set_cell', sheetId: 'sh1', address: 'B2', value: LITERAL }])?.where).toBe(
      'Customers!B2',
    )
    expect(
      guard([{ op: 'copy_range', sheetId: 'sh1', source: 'A3:B3', target: 'A2' }])?.where,
    ).toBe('Customers!B2')
  })

  it('reads a withheld cell as its placeholder whatever the value is', () => {
    expect(modelCellValue(INDEX, 'sh1', 1, 1, LITERAL)).toBe(LITERAL)
    expect(modelCellValue(INDEX, 'sh1', 1, 1, '13800138000')).toBe(LITERAL)
    // and an unmarked cell holding that text is a value like any other
    expect(modelCellValue(INDEX, 'sh1', 2, 1, LITERAL)).toBe(LITERAL)
    expect(INDEX.labelAt('sh1', 2, 1)).toBeNull()
  })
})
