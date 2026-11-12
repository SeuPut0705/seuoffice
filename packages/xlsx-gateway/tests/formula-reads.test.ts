import { describe, expect, it } from 'vitest'

import type { RangeBounds } from '../src/domain/cell-address'
import { parseRange } from '../src/domain/cell-address'
import {
  areaLookup,
  cellsDerivedFromWithheld,
  formulaReads,
  type NameDefinition,
  type ReadsSheet,
} from '../src/gateway/formula-reads'

const MAX_ROW = 1_048_575
const MAX_COLUMN = 16_383

const area = (a1: string): RangeBounds => parseRange(a1)

/** what `formulaReads` lists, as `Sheet!A1:B2` strings */
function listed(formula: string): string[] | string {
  const result = formulaReads(formula)
  if (result.unknown !== null) return `unknown: ${result.unknown}`
  return result.reads.map(
    (read) =>
      `${read.sheet === undefined ? '' : `${read.sheet}!`}` +
      `${read.startRow},${read.startColumn}-${read.endRow},${read.endColumn}`,
  )
}

describe('the cells a formula reads', () => {
  it('lists cells and ranges, with or without the leading = and the $ anchors', () => {
    expect(listed('=B2')).toEqual(['1,1-1,1'])
    expect(listed('$B$2+C3*2')).toEqual(['1,1-1,1', '2,2-2,2'])
    expect(listed('=SUM(A1:B3)')).toEqual(['0,0-2,1'])
    expect(listed('=SUM(B3:A1)')).toEqual(['0,0-2,1'])
  })

  it('lists whole columns and whole rows to the edge of the grid', () => {
    expect(listed('=SUM(B:B)')).toEqual([`0,1-${MAX_ROW},1`])
    expect(listed('=SUM($A:$C)')).toEqual([`0,0-${MAX_ROW},2`])
    expect(listed('=SUM(2:3)')).toEqual([`1,0-2,${MAX_COLUMN}`])
  })

  it('keeps the sheet a reference names, quoted or not', () => {
    expect(listed('=Data!B2')).toEqual(['Data!1,1-1,1'])
    expect(listed("='Q1 data'!A1:A2+1")).toEqual(['Q1 data!0,0-1,0'])
    expect(listed("='It''s'!B:B")).toEqual([`It's!0,1-${MAX_ROW},1`])
    expect(listed('=데이터!B2')).toEqual(['데이터!1,1-1,1'])
  })

  it('reads nothing from text, numbers, errors and array constants', () => {
    expect(listed('="B2 is "&1.5E3')).toEqual([])
    expect(listed('=IF(TRUE,#N/A,{1,2;3,"A1"})')).toEqual([])
    expect(listed('=Data!#REF!+1')).toEqual([])
  })

  it('does not cut a function or a longer word into a reference', () => {
    expect(listed('=LOG10(100)+ATAN2(1,2)')).toEqual([])
    expect(listed('=_xlfn.XLOOKUP(A1,B:B,C:C)')).toEqual([
      '0,0-0,0',
      `0,1-${MAX_ROW},1`,
      `0,2-${MAX_ROW},2`,
    ])
    expect(formulaReads('=Rate2024*A1')).toMatchObject({ names: ['rate2024'], unknown: null })
  })

  it('lists the arguments of the functions that return one of them as a reference', () => {
    expect(listed('=INDEX(A1:A9,3)+CHOOSE(1,B1:B2,C1:C2)')).toEqual([
      '0,0-8,0',
      '0,1-1,1',
      '0,2-1,2',
    ])
  })

  it.each([
    ['INDIRECT', '=INDIRECT("B"&2)'],
    ['OFFSET', '=SUM(OFFSET(A1,1,1))'],
    ['GETPIVOTDATA', '=GETPIVOTDATA("Sum",A3)'],
    ['CELL', '=CELL("contents")'],
    ['a spill reference', '=SUM(A1#)'],
    ['the stored spill operator', '=SUM(_xlfn.ANCHORARRAY(A1))'],
    ['a range built from a function result', '=SUM(INDEX(A:A,1):B5)'],
    ['a range of two qualified ends', '=SUM(Data!A1:Data!B2)'],
    ['a structured reference', '=SUM(Table1[Amount])'],
    ['a this-row reference', '=[@Amount]*2'],
    ['a reference into another workbook', '=[1]Sheet1!A1'],
    ['a quoted reference into another workbook', "='C:\\dir\\[Book.xlsx]Sheet1'!A1"],
    ['a 3-D reference', '=SUM(Sheet1:Sheet3!A1)'],
    ['a quoted 3-D reference', "=SUM('Sheet 1:Sheet 3'!A1)"],
    ['a function nobody listed', '=MYMACRO(1)'],
    ['a reference off the grid', '=XFE1'],
    ['an unterminated string', '="abc'],
    ['a character that is not formula syntax', '=A1 ¤ 2'],
    ['no text at all', '='],
  ])('cannot list what a formula with %s reads', (_what, formula) => {
    expect(formulaReads(formula).unknown).not.toBeNull()
  })
})

const HIDDEN_B2 = [area('B2')]

function sheet(
  name: string,
  formulas: Record<string, string>,
  marks: readonly RangeBounds[] = [],
  unknown: readonly RangeBounds[] = [],
): ReadsSheet {
  return {
    name,
    marks,
    unknown,
    formulas: Object.entries(formulas).map(([at, formula]) => ({ area: area(at), formula })),
  }
}

/** the derived cells of each sheet, as A1 strings */
function derived(
  sheets: readonly ReadsSheet[],
  names: readonly NameDefinition[] = [],
  budget?: number,
): string[][] {
  const a1 = (cell: RangeBounds) => {
    const column = String.fromCharCode(65 + cell.startColumn)
    const end = `${String.fromCharCode(65 + cell.endColumn)}${cell.endRow + 1}`
    const start = `${column}${cell.startRow + 1}`
    return start === end ? start : `${start}:${end}`
  }
  return cellsDerivedFromWithheld(sheets, names, budget).bySheet.map((areas) =>
    areas.map(a1).sort(),
  )
}

describe('the formula cells that show a withheld value', () => {
  it('finds a formula that reads the cell, and leaves the others', () => {
    expect(derived([sheet('Data', { C2: '=B2', C3: '=A3*2', C4: '=B3+1' }, HIDDEN_B2)])).toEqual([
      ['C2'],
    ])
  })

  it('follows a chain of formulas', () => {
    expect(
      derived([sheet('Data', { C2: '=B2', D2: '=C2*2', E2: '=D2+1', F2: '=A2' }, HIDDEN_B2)]),
    ).toEqual([['C2', 'D2', 'E2']])
  })

  it('finds a whole-column total, on the same sheet and from another', () => {
    expect(
      derived([
        sheet('Data', { D1: '=SUM(B:B)', D2: '=SUM(A:A)' }, HIDDEN_B2),
        sheet('Report', { A1: '=SUM(Data!B:B)', A2: "=COUNT('Data'!A:A)", A3: '=SUM(B:B)' }),
      ]),
    ).toEqual([['D1'], ['A1']])
  })

  it('matches a sheet name without case, as Excel does', () => {
    expect(derived([sheet('Data', {}, HIDDEN_B2), sheet('Report', { A1: '=DATA!B2' })])).toEqual([
      [],
      ['A1'],
    ])
  })

  it('resolves a defined name, through another name too', () => {
    const names = [
      { name: 'Phone', formula: 'Data!$B$2' },
      { name: 'Contact', formula: '=Phone' },
      { name: 'Rate', formula: '0.15' },
      { name: 'Names', formula: 'Data!$A:$A' },
    ]
    expect(
      derived(
        [
          sheet(
            'Data',
            { C1: '=Phone', C2: '=Contact&""', C3: '=Rate*2', C4: '=COUNTA(Names)' },
            HIDDEN_B2,
          ),
        ],
        names,
      ),
    ).toEqual([['C1', 'C2']])
  })

  it('withholds a formula whose name is undefined, unplaced or defined through itself', () => {
    const names = [
      { name: 'Loose', formula: 'B2' },
      { name: 'Ping', formula: 'Pong' },
      { name: 'Pong', formula: 'Ping' },
    ]
    expect(
      derived(
        [sheet('Data', { C1: '=Missing', C2: '=Loose', C3: '=Ping', C4: '=A1' }, HIDDEN_B2)],
        names,
      ),
    ).toEqual([['C1', 'C2', 'C3']])
  })

  it('takes every definition of a name, whatever sheet it is scoped to', () => {
    const names = [
      { name: 'Total', formula: 'Data!$A$1' },
      { name: 'total', formula: 'Data!$B$2' },
    ]
    expect(derived([sheet('Data', { C1: '=Total' }, HIDDEN_B2)], names)).toEqual([['C1']])
  })

  it('withholds what cannot be listed, and everything that reads it', () => {
    expect(
      derived([
        sheet('Data', { C1: '=INDIRECT("A1")', C2: '=C1+1', C3: '=Gone!A1', C4: '=A1' }, HIDDEN_B2),
      ]),
    ).toEqual([['C1', 'C2', 'C3']])
  })

  it('withholds an array formula over the whole range it fills', () => {
    const data: ReadsSheet = {
      name: 'Data',
      marks: HIDDEN_B2,
      unknown: [],
      formulas: [
        { area: area('D1:D3'), formula: '=B1:B3' },
        { area: area('E2'), formula: '=D3' },
        { area: area('F1:F3'), formula: '=A1:A3' },
      ],
    }
    expect(derived([data])).toEqual([['D1:D3', 'E2']])
  })

  it('withholds the cells a reader could not list, and what reads them', () => {
    expect(
      derived([
        sheet('Data', { C1: '=E5', C2: '=A1' }, HIDDEN_B2, [area('E5:E6')]),
        sheet(
          'Big',
          {},
          [],
          [{ startRow: 0, endRow: MAX_ROW, startColumn: 0, endColumn: MAX_COLUMN }],
        ),
        sheet('Report', { A1: '=Big!Z99', A2: '=Data!A1' }),
      ]),
    ).toEqual([
      ['C1', 'E5:E6'],
      [`A1:${String.fromCharCode(65 + MAX_COLUMN)}${MAX_ROW + 1}`],
      ['A1'],
    ])
  })

  it('ends on a cycle', () => {
    expect(
      derived([
        sheet('Data', { C1: '=C2+B2', C2: '=C3', C3: '=C1', D1: '=D2', D2: '=D1' }, HIDDEN_B2),
      ]),
    ).toEqual([['C1', 'C2', 'C3']])
  })

  it('withholds nothing in a workbook without marks, whatever its formulas say', () => {
    expect(
      derived([sheet('Data', { C1: '=INDIRECT("A1")', C2: '=MYMACRO()' }, [], [area('A1:Z9')])]),
    ).toEqual([[]])
  })

  it('withholds every formula once the trace runs past its budget', () => {
    const formulas: Record<string, string> = { C1: '=B2', D9: '=A1' }
    for (let row = 2; row <= 40; row += 1) formulas[`C${row}`] = `=C${row - 1}+1`
    const result = cellsDerivedFromWithheld([sheet('Data', formulas, HIDDEN_B2)], [], 10)
    expect(result.overBudget).toBe(true)
    expect(result.bySheet[0]).toHaveLength(41)
  })

  it('traces a 5,000-formula sheet in well under a second', () => {
    const formulas: Record<string, string> = {}
    // A chain of 2,500 running totals that starts at the hidden cell, and
    // 2,500 formulas that have nothing to do with it.
    formulas.C2 = '=B2'
    for (let row = 3; row <= 2501; row += 1) formulas[`C${row}`] = `=C${row - 1}+A${row}`
    for (let row = 2; row <= 2501; row += 1) formulas[`D${row}`] = `=SUM(A$2:A${row})`
    const started = performance.now()
    const result = cellsDerivedFromWithheld([sheet('Data', formulas, HIDDEN_B2)])
    const elapsed = performance.now() - started
    expect(result.overBudget).toBe(false)
    expect(result.bySheet[0]).toHaveLength(2500)
    expect(elapsed).toBeLessThan(1000)
  })
})

describe('asking cell by cell', () => {
  it('answers for single cells and for ranges', () => {
    const has = areaLookup([area('C2'), area('E1:F3')])
    expect(has(1, 2)).toBe(true)
    expect(has(2, 5)).toBe(true)
    expect(has(1, 3)).toBe(false)
    expect(has(3, 4)).toBe(false)
  })
})
