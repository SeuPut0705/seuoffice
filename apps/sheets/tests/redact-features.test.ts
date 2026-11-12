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
  /** the file name of a second sheet (`sh2`) that swapped names with Customers this session */
  swappedWith?: string
}): WorkbookReadContext {
  const worksheet = {
    getSheetId: () => 'sh1',
    getSheetName: () => options.swappedWith ?? 'Customers',
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
    options.marks.length === 0
      ? []
      : [
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
  const other = { getSheetId: () => 'sh2', getSheetName: () => 'Customers' }
  return {
    univerRef: {
      current: {
        univerAPI: {
          getActiveWorkbook: () => ({
            getActiveSheet: () => worksheet,
            getSheetBySheetId: () => worksheet,
            getSheets: () => (options.swappedWith === undefined ? [worksheet] : [worksheet, other]),
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
            ...(options.swappedWith === undefined
              ? []
              : [
                  {
                    id: 'sh2',
                    name: options.swappedWith,
                    rowCount: 10,
                    columnCount: 4,
                    tables: [],
                    pivotTables: [],
                    pivotRanges: [],
                  },
                ]),
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

  it('looks for the source header on the sheet the file named, after two sheets swapped names', () => {
    // The file says the source is "Customers": that is sh1, now called
    // Archive, and not the sheet that took the name.
    const output = readSheetFeatures(
      fileCtx({
        marks: [B1],
        pivotTables: PIVOT,
        definitions: [definition({ sourceSheet: 'Customers', sourceRef: 'A1:B10' })],
        swappedWith: 'Archive',
      }),
    )
    expect(output).not.toContain(PHONE_HEADER)
    expect(output).toContain('rows[{{client phone}}] cols[Name] values[{{client phone}}]')
  })

  // A row inserted at the top this session: every cell of the sheet is one
  // row lower on screen than in the file, and the marks are asked on screen.
  const rowInsertedOnTop = (journal: ReturnType<typeof createEditJournal>) =>
    journal.structuralOps.set('sh1', [{ kind: 'insert-rows', index: 0, count: 1 }])
  const B2 = { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 }

  it('follows a table whose header a row inserted this session moved down', () => {
    const output = readSheetFeatures(
      fileCtx({ marks: [B2], tables: [FILE_TABLE], journal: rowInsertedOnTop }),
    )
    expect(output).not.toContain(PHONE_HEADER)
    expect(output).toContain('- Clients: A2:B11 columns[Name, {{client phone}}]')
  })

  it('follows a pivot source whose header a row inserted this session moved down', () => {
    const output = readSheetFeatures(
      fileCtx({
        marks: [B2],
        pivotTables: PIVOT,
        definitions: [definition({ sourceSheet: 'Customers', sourceRef: 'A1:B10' })],
        journal: rowInsertedOnTop,
      }),
    )
    expect(output).not.toContain(PHONE_HEADER)
    expect(output).toContain(
      'rows[{{client phone}}] cols[Name] values[{{client phone}}] source=Customers!A2:B11',
    )
  })

  it('withholds the names whose header row was deleted this session: the cell cannot be asked', () => {
    const output = readSheetFeatures(
      fileCtx({
        marks: [B2_B10],
        tables: [FILE_TABLE],
        journal: (journal) =>
          journal.structuralOps.set('sh1', [{ kind: 'remove-rows', index: 0, count: 1 }]),
      }),
    )
    expect(output).not.toContain(PHONE_HEADER)
    expect(output).toContain('columns[{{private}}, {{private}}]')
  })

  /** A pivot over A1:B10 whose third cache field is not a source column. */
  const withExtraField = (
    extra: object,
    reasons: string[] = [],
    second: object = { name: PHONE_HEADER },
  ) =>
    [
      'pivot1',
      {
        outputRef: 'E3:F9',
        fields: [{ name: 'Name' }, second, extra],
        rowFields: [2],
        colFields: [1],
        dataFields: [{ name: 'Count of Name', field: 0 }],
        pageFields: [],
        unsupported: reasons,
        sourceSheet: 'Customers',
        sourceRef: 'A1:B10',
      },
    ] as [string, object]
  // Excel names a manual group after its base field: "<header>2"
  const GROUP_OF_PHONE = { name: `${PHONE_HEADER}2` }

  it('withholds the name of a group field Excel added when its source holds a hidden cell', () => {
    const output = readSheetFeatures(
      fileCtx({
        marks: [B1],
        pivotTables: PIVOT,
        definitions: [
          withExtraField(GROUP_OF_PHONE, [
            `grouped field "${PHONE_HEADER}" does not support recompute`,
          ]),
        ],
      }),
    )
    expect(output).not.toContain(PHONE_HEADER)
    expect(output).toContain('rows[{{private}}] cols[{{client phone}}] values[Count of Name]')
    // the reason quotes field names: it is given without them
    expect(output).toContain('(recompute unsupported)')
  })

  it('prints a group field when nothing in the source is hidden', () => {
    const elsewhere = { startRow: 20, endRow: 20, startColumn: 3, endColumn: 3 }
    const output = readSheetFeatures(
      fileCtx({
        marks: [elsewhere],
        pivotTables: PIVOT,
        definitions: [withExtraField(GROUP_OF_PHONE)],
      }),
    )
    expect(output).toContain(`rows[${PHONE_HEADER}2] cols[${PHONE_HEADER}]`)
  })

  it('prints a calculated field, which the person named, whatever the source holds', () => {
    const output = readSheetFeatures(
      fileCtx({
        marks: [B1],
        pivotTables: PIVOT,
        definitions: [withExtraField({ name: 'Margin', formula: 'Name*2' })],
      }),
    )
    expect(output).toContain('rows[Margin] cols[{{client phone}}]')
  })

  it('withholds a field grouped in place when its column holds a hidden cell', () => {
    // the header "Signed" is not hidden; the dates under it are
    const grouped = { name: 'Signed', grouping: { kind: 'date', dateUnit: 'month' } }
    const definition = withExtraField({ name: 'Margin', formula: 'Name*2' }, [], grouped)
    const output = readSheetFeatures(
      fileCtx({ marks: [B2_B10], pivotTables: PIVOT, definitions: [definition] }),
    )
    expect(output).toContain('rows[Margin] cols[{{private}}]')
    // and ungrouped, the same field is named by its visible header
    const plain = withExtraField({ name: 'Margin', formula: 'Name*2' }, [], { name: 'Signed' })
    expect(
      readSheetFeatures(fileCtx({ marks: [B2_B10], pivotTables: PIVOT, definitions: [plain] })),
    ).toContain('rows[Margin] cols[Signed]')
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

describe('get_workbook_context: chart titles', () => {
  // A title is typed, or it is the text of a cell: a linked title, or the name
  // of the only series, which is the header cell of its column. The chart the
  // session holds carries the text, not where it came from.
  const chart = (id: string, chartPath?: string) => ({
    id,
    kind: 'chart',
    sheetId: 'sh1',
    ...(chartPath ? { chartPath } : {}),
    chart: {
      title: PHONE_HEADER,
      chartTypes: ['barChart'],
      series: [
        { name: PHONE_HEADER, categories: ['Kim'], values: [1], valuesRef: 'Customers!$B$2' },
      ],
    },
  })
  const FILE_CHART = chart('visual-1', 'xl/charts/chart1.xml')

  it('are withheld in a workbook with hidden cells: the text may be a hidden cell', () => {
    const info = getActiveSheetInfo(fileCtx({ marks: [B1], visuals: [FILE_CHART] }))
    expect(JSON.stringify(info)).not.toContain(PHONE_HEADER)
    expect(info.charts).toEqual([
      { path: 'xl/charts/chart1.xml', title: '{{private}}', types: 'barChart', sheetId: 'sh1' },
    ])
  })

  it('are withheld for a chart made this session too: its title is its series name', () => {
    const info = getActiveSheetInfo(
      fileCtx({
        marks: [B1],
        journal: (journal) => journal.visualAdds.push(chart('added-chart-1') as never),
      }),
    )
    expect(info.charts?.map((entry) => entry.title)).toEqual(['{{private}}'])
  })

  it('are given once the title was typed this session', () => {
    const info = getActiveSheetInfo(
      fileCtx({
        marks: [B1],
        visuals: [FILE_CHART],
        journal: (journal) =>
          journal.chartEdits.set('xl/charts/chart1.xml', { title: 'Phones by client' } as never),
      }),
    )
    expect(info.charts?.map((entry) => entry.title)).toEqual(['Phones by client'])
  })

  it('are given in a workbook without hidden cells', () => {
    const info = getActiveSheetInfo(fileCtx({ marks: [], visuals: [FILE_CHART] }))
    expect(info.charts?.map((entry) => entry.title)).toEqual([PHONE_HEADER])
  })
})
