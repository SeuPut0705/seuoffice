import { describe, expect, it } from 'vitest'

import { buildRedactionIndex, type RedactionIndex } from '../src/renderer/ai/redact'
import { createEditJournal } from '../src/renderer/edit-journal'
import { loadedRedactions } from '../src/renderer/ai/redact-load'
import {
  getActiveSheetInfo,
  readSheetFeatures,
  type WorkbookReadContext,
} from '../src/renderer/ai/workbook-readers'

const NOTE_TEXT = 'client phone 13800138000'
const DV_LITERAL = '13800138000'

type RangeStub = {
  getA1Notation: () => string
  getRow: () => number
  getLastRow: () => number
  getColumn: () => number
  getLastColumn: () => number
}

function range(
  a1: string,
  startRow: number,
  endRow: number,
  startColumn: number,
  endColumn: number,
): RangeStub {
  return {
    getA1Notation: () => a1,
    getRow: () => startRow,
    getLastRow: () => endRow,
    getColumn: () => startColumn,
    getLastColumn: () => endColumn,
  }
}

/// `read_sheet_features` reports workbook structures, not cells — but two of
/// those structures carry cell-adjacent content: a note is anchored to a cell
/// and holds free text, and a data-validation rule can store a literal value.
/// Both are the same leak as an unprojected cell, reached through a side door.
function ctxWith(options: { withheld: boolean }): WorkbookReadContext {
  const worksheet = {
    getSheetId: () => 'sh1',
    getSheetName: () => 'Customers',
    getFreeze: () => ({ xSplit: 0, ySplit: 0 }),
    getDataValidations: () => [
      {
        getRanges: () => [range('B2:B10', 1, 9, 1, 1)],
        rule: {
          type: 'cellIs',
          operator: 'equal',
          formula1: DV_LITERAL,
          formula2: undefined,
        },
      },
      {
        getRanges: () => [range('D2:D10', 1, 9, 3, 3)],
        rule: { type: 'list', operator: undefined, formula1: 'a,b,c', formula2: undefined },
      },
    ],
    getNotes: () => [
      { row: 1, col: 1, note: NOTE_TEXT },
      { row: 2, col: 3, note: 'public note' },
    ],
  }
  return {
    univerRef: {
      current: {
        univerAPI: {
          getActiveWorkbook: () => ({
            getActiveSheet: () => worksheet,
            getSheetBySheetId: () => worksheet,
            getDefinedNames: () => [],
          }),
        },
      } as never,
    },
    lazyWorkbookRef: { current: null },
    adapterRef: { current: { getSnapshot: () => ({ revision: 0, sheets: [] }) } } as never,
    redactionLoadRef: {
      current: loadedRedactions(
        options.withheld
          ? buildRedactionIndex(
              [
                {
                  sheetName: 'Customers',
                  marks: [
                    {
                      startRow: 1,
                      endRow: 9,
                      startColumn: 1,
                      endColumn: 1,
                      label: 'client phone',
                    },
                  ],
                },
              ],
              [{ id: 'sh1', name: 'Customers' }],
            )
          : buildRedactionIndex([], [{ id: 'sh1', name: 'Customers' }]),
      ),
    },
  } as unknown as WorkbookReadContext
}

describe('read_sheet_features does not leak a withheld value through a side door', () => {
  it('replaces a note anchored on a withheld cell with the placeholder', () => {
    const output = readSheetFeatures(ctxWith({ withheld: true }))
    expect(output).not.toContain(NOTE_TEXT)
    expect(output).toContain('- B2: {{client phone}}')
  })

  it('leaves a note on a cell that is not withheld alone', () => {
    // Hiding every note would gut the tool; only the withheld one changes.
    const output = readSheetFeatures(ctxWith({ withheld: true }))
    expect(output).toContain('- D3: public note')
  })

  it('drops the formula of a validation rule covering a withheld cell', () => {
    const output = readSheetFeatures(ctxWith({ withheld: true }))
    expect(output).not.toContain(DV_LITERAL)
    // The rule itself is still reported: the model has to know not to break it.
    expect(output).toContain('B2:B10: cellIs equal (withheld)')
  })

  it('leaves a validation rule on an untouched column alone', () => {
    const output = readSheetFeatures(ctxWith({ withheld: true }))
    expect(output).toContain('D2:D10: list a,b,c')
  })

  it('reports everything verbatim when nothing is withheld', () => {
    const output = readSheetFeatures(ctxWith({ withheld: false }))
    expect(output).toContain(NOTE_TEXT)
    expect(output).toContain(`B2:B10: cellIs equal ${DV_LITERAL}`)
  })
})

const PHONE_HEADER = '13800138000'
const B1 = { startRow: 0, endRow: 0, startColumn: 1, endColumn: 1 }
const B2_B10 = { startRow: 1, endRow: 9, startColumn: 1, endColumn: 1 }

/** A session over a file, with whatever sheet structures a test puts in it. */
function fileCtx(options: {
  marks: (typeof B1)[]
  /** formula cells that compute from the marks, as `redact-derived` answers */
  derived?: (typeof B1)[]
  worksheet?: object
  tables?: object[]
  pivotTables?: object[]
  definitions?: [string, object][]
  journal?: (journal: ReturnType<typeof createEditJournal>) => void
  visuals?: object[]
}): WorkbookReadContext {
  const worksheet = {
    getSheetId: () => 'sh1',
    getSheetName: () => 'Customers',
    getFreeze: () => ({ xSplit: 0, ySplit: 0 }),
    getDataValidations: () => [],
    getConditionalFormattingRules: () => [],
    getFilter: () => null,
    getNotes: () => [],
    getMergedRanges: () => [],
    ...options.worksheet,
  }
  const editJournal = createEditJournal()
  options.journal?.(editJournal)
  const marks = buildRedactionIndex(
    [
      {
        sheetName: 'Customers',
        marks: options.marks.map((mark) => ({ ...mark, label: 'client phone' })),
      },
    ],
    [{ id: 'sh1', name: 'Customers' }],
  )
  const derived = options.derived ?? []
  const index: RedactionIndex = {
    ...marks,
    labelAt: (sheetId, row, column) =>
      marks.labelAt(sheetId, row, column) ??
      (derived.some(
        (area) =>
          row >= area.startRow &&
          row <= area.endRow &&
          column >= area.startColumn &&
          column <= area.endColumn,
      )
        ? 'private'
        : null),
    marksFor: (sheetId) => marks.marksFor(sheetId),
    labelsFor: (sheetId) => marks.labelsFor(sheetId),
    derivedFor: () => derived,
  }
  return {
    univerRef: {
      current: {
        univerAPI: {
          getActiveWorkbook: () => ({
            getActiveSheet: () => worksheet,
            getSheetBySheetId: () => worksheet,
            getSheets: () => [worksheet],
            getDefinedNames: () => [],
            getActiveRange: () => null,
          }),
        },
      } as never,
    },
    lazyWorkbookRef: {
      current: {
        formulaMode: true,
        loadedRanges: new Map(),
        file: {
          visuals: options.visuals ?? [],
          sheets: [
            {
              id: 'sh1',
              name: 'Customers',
              rowCount: 10,
              columnCount: 4,
              tables: options.tables ?? [],
              pivotTables: options.pivotTables ?? [],
              pivotRanges: [],
            },
          ],
        },
        editJournal,
        sheetProtections: new Map([['sh1', { protected: false }]]),
        pivotDefinitions: new Map(options.definitions ?? []),
      },
    } as never,
    adapterRef: { current: { getSnapshot: () => ({ revision: 0, sheets: [] }) } } as never,
    redactionLoadRef: { current: loadedRedactions(index) },
  } as unknown as WorkbookReadContext
}

describe('read_sheet_features: names and rule values that are copies of a hidden cell', () => {
  const FILE_TABLE = {
    name: 'Clients',
    range: { startRow: 0, endRow: 9, startColumn: 0, endColumn: 1 },
    columns: ['Name', PHONE_HEADER],
    headerRowCount: 1,
  }

  it('prints a table column name as the placeholder of its hidden header cell', () => {
    const output = readSheetFeatures(fileCtx({ marks: [B1], tables: [FILE_TABLE] }))
    expect(output).not.toContain(PHONE_HEADER)
    expect(output).toContain('- Clients: A1:B10 columns[Name, {{client phone}}]')
  })

  it('prints the column names of a table whose header row is not hidden', () => {
    const output = readSheetFeatures(fileCtx({ marks: [B2_B10], tables: [FILE_TABLE] }))
    expect(output).toContain(`- Clients: A1:B10 columns[Name, ${PHONE_HEADER}]`)
  })

  it('does the same for a table made this session', () => {
    const output = readSheetFeatures(
      fileCtx({
        marks: [B1],
        journal: (journal) =>
          journal.tableAdds.push({
            sheetId: 'sh1',
            name: 'Fresh',
            area: { startRow: 0, endRow: 9, startColumn: 0, endColumn: 1 },
            columnNames: ['Name', PHONE_HEADER],
            bandedRows: true,
          } as never),
      }),
    )
    expect(output).not.toContain(PHONE_HEADER)
    expect(output).toContain('- Fresh: A1:B10 columns[Name, {{client phone}}]')
  })

  const PIVOT = [{ path: 'pivot1', cachePath: 'cache1', outputRef: 'E3:F9' }]
  const definition = (source: { sourceSheet: string; sourceRef: string }) =>
    [
      'pivot1',
      {
        outputRef: 'E3:F9',
        fields: [{ name: 'Name' }, { name: PHONE_HEADER }],
        rowFields: [1],
        colFields: [0, -2],
        dataFields: [{ name: `Count of ${PHONE_HEADER}`, field: 1 }],
        pageFields: [],
        unsupported: [],
        ...source,
      },
    ] as [string, object]

  it('prints a pivot field name as the placeholder of its hidden source header', () => {
    const output = readSheetFeatures(
      fileCtx({
        marks: [B1],
        pivotTables: PIVOT,
        definitions: [definition({ sourceSheet: 'Customers', sourceRef: 'A1:B10' })],
      }),
    )
    expect(output).not.toContain(PHONE_HEADER)
    expect(output).toContain(
      '- E3:F9: rows[{{client phone}}] cols[Name] values[{{client phone}}] source=Customers!A1:B10',
    )
  })

  it('prints the field names of a pivot whose source headers are not hidden', () => {
    const output = readSheetFeatures(
      fileCtx({
        marks: [B2_B10],
        pivotTables: PIVOT,
        definitions: [definition({ sourceSheet: 'Customers', sourceRef: 'A1:B10' })],
      }),
    )
    expect(output).toContain(`rows[${PHONE_HEADER}] cols[Name] values[Count of ${PHONE_HEADER}]`)
  })

  it('withholds every field name of a pivot whose source it cannot place', () => {
    const output = readSheetFeatures(
      fileCtx({
        marks: [B2_B10],
        pivotTables: PIVOT,
        definitions: [definition({ sourceSheet: '', sourceRef: '' })],
      }),
    )
    expect(output).not.toContain(PHONE_HEADER)
    expect(output).toContain('rows[{{private}}] cols[{{private}}] values[{{private}}]')
  })

  it('drops the kept values of a filter column that holds a hidden cell', () => {
    const filter = {
      getRange: () => ({
        getRange: () => ({ startRow: 0, endRow: 9, startColumn: 0, endColumn: 1 }),
      }),
      getColumnFilterCriteria: (column: number) =>
        column === 0 ? { filters: { filters: ['Kim'] } } : { filters: { filters: [PHONE_HEADER] } },
    }
    const output = readSheetFeatures(
      fileCtx({ marks: [B2_B10], worksheet: { getFilter: () => filter } }),
    )
    expect(output).not.toContain(PHONE_HEADER)
    expect(output).toContain('AutoFilter: A1:B10;A keeps [Kim];B keeps (withheld)')
  })

  const RULES = [
    {
      ranges: [B2_B10],
      rule: { type: 'highlightCell', subType: 'number', operator: 'equal', value: 13800138000 },
    },
    {
      ranges: [{ startRow: 1, endRow: 9, startColumn: 0, endColumn: 0 }],
      rule: { type: 'highlightCell', subType: 'text', operator: 'containsText', value: 'Kim' },
    },
  ]

  it('drops the value of a conditional format over a hidden cell', () => {
    const output = readSheetFeatures(
      fileCtx({ marks: [B2_B10], worksheet: { getConditionalFormattingRules: () => RULES } }),
    )
    expect(output).not.toContain(PHONE_HEADER)
    expect(output).toContain(
      '- B2:B10: type="highlightCell" subType="number" operator="equal" value=(withheld)',
    )
    expect(output).toContain('- A2:A10: type="highlightCell" subType="text"')
    expect(output).toContain('value="Kim"')
  })

  it('treats a formula that computes from a hidden cell as hidden, for a validation rule too', () => {
    const validations = [
      {
        getRanges: () => [range('D2:D10', 1, 9, 3, 3)],
        rule: { type: 'cellIs', operator: 'equal', formula1: DV_LITERAL, formula2: undefined },
      },
    ]
    const output = readSheetFeatures(
      fileCtx({
        marks: [B2_B10],
        derived: [{ startRow: 1, endRow: 9, startColumn: 3, endColumn: 3 }],
        worksheet: { getDataValidations: () => validations },
      }),
    )
    expect(output).not.toContain(DV_LITERAL)
    expect(output).toContain('D2:D10: cellIs equal (withheld)')
  })
})

describe('get_workbook_context: the names of the columns the person selected', () => {
  const selection = { sheetId: 'sh1', a1: 'A1:B10', columns: ['Name', PHONE_HEADER] }

  it('are left out when one of the header cells is hidden: the range alone is given', () => {
    const info = getActiveSheetInfo(fileCtx({ marks: [B1] }), selection)
    expect(JSON.stringify(info)).not.toContain(PHONE_HEADER)
    expect(info.selection).toBe('A1:B10')
    expect(info.selectionColumns).toBeUndefined()
  })

  it('are given when no header cell is hidden', () => {
    const info = getActiveSheetInfo(fileCtx({ marks: [B2_B10] }), selection)
    expect(info.selectionColumns).toEqual(['Name', PHONE_HEADER])
  })
})
