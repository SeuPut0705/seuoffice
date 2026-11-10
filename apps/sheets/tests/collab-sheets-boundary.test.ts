/**
 * The holes an independent review found in what a page accepts from the log:
 * a merge that walks the whole grid, the editor's own rich text refused,
 * prototype keys slipping past the shape check, and sheet names Excel forbids
 * or that two sheets share.
 */
import { BooleanNumber, Direction, DocumentDataModel } from '@univerjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_COLUMNS, MAX_ROWS, WireMutationError } from '../src/web/collab-wire-check'
import { Room } from './collab/room'
import { disposeAll, type OpenedBook } from './collab/sheets-workbook'

afterEach(disposeAll)

const ADD_MERGE = 'sheet.mutation.add-worksheet-merge'

const op = (id: string, params: unknown) => ({ id: `hostile-${id}`, m: [[id, params]] })

const range = (startRow: number, startColumn: number, endRow: number, endColumn: number) => ({
  startRow,
  startColumn,
  endRow,
  endColumn,
})

function decodeError(page: OpenedBook, json: unknown): unknown {
  try {
    page.adapter.decode(json as never)
  } catch (error) {
    return error
  }
  return null
}

/** What a page that skipped every local check would put in the log, as each page receives it */
function receive(pages: readonly OpenedBook[], json: unknown): void {
  for (const page of pages) {
    const wire = JSON.parse(JSON.stringify(json)) as unknown
    page.adapter.integrate([page.adapter.decode(wire as never)], [])
  }
}

const mergesOf = (page: OpenedBook, sheet = 's1') =>
  page.workbook.getSheetBySheetId(sheet)!.getConfig().mergeData

const namesOf = (page: OpenedBook) => page.workbook.getSheets().map((sheet) => sheet.getName())

describe('a merge is bounded by the cells Univer walks for it', () => {
  it('refuses a merge over the whole grid at decode, as too large', () => {
    const page = new Room().join()
    const error = decodeError(
      page,
      op(ADD_MERGE, { subUnitId: 's1', ranges: [range(0, 0, MAX_ROWS - 2, MAX_COLUMNS - 2)] }),
    )
    expect(error).toBeInstanceOf(WireMutationError)
    expect((error as WireMutationError).tooLarge).toBe(true)
  })

  it('refuses a new sheet that arrives with a whole-grid merge', () => {
    const page = new Room().join()
    const error = decodeError(
      page,
      op('sheet.mutation.insert-sheet', {
        index: 0,
        sheet: {
          id: 'big',
          name: 'Big',
          rowCount: MAX_ROWS,
          columnCount: MAX_COLUMNS,
          mergeData: [range(0, 0, MAX_ROWS - 1, MAX_COLUMNS - 1)],
        },
      }),
    )
    expect(error).toBeInstanceOf(WireMutationError)
    expect((error as WireMutationError).tooLarge).toBe(true)
  })

  it('takes a too-large merge back on the page that made it and tells the person', () => {
    const told: string[] = []
    const room = new Room()
    const a = room.join(undefined, { onBlocked: (id, reason) => told.push(`${reason}: ${id}`) })
    expect(
      a.edit('rows', 'sheet.command.set-worksheet-row-count', {
        subUnitId: 's1',
        rowCount: MAX_ROWS,
      }),
    ).toBe(true)
    expect(
      a.edit('merge', 'sheet.command.add-worksheet-merge', {
        subUnitId: 's1',
        selections: [range(0, 0, MAX_ROWS - 1, 1)],
        defaultMerge: true,
      }),
    ).toBe(false)
    expect(a.emitted.map((sent) => sent.id)).toEqual(['rows'])
    expect(mergesOf(a)).toEqual([])
    expect(told).toEqual([`too-large: ${ADD_MERGE}`])
  })

  it('drops, on every page alike, a merge that would take a sheet past its merged-cell bound', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    const tall = (column: number) => range(0, column, 599_999, column)
    receive([a, b], op(ADD_MERGE, { subUnitId: 's1', ranges: [tall(0)] }))
    receive([a, b], op(ADD_MERGE, { subUnitId: 's1', ranges: [tall(1)] }))
    expect(mergesOf(a)).toEqual([tall(0)])
    expect(mergesOf(b)).toEqual(mergesOf(a))
  })
})

describe('rich text as the cell editor writes it', () => {
  /** The editor's document snapshot for "ab" with "a" bold: Univer's model plus the empty drawing keys the editor sets */
  function partlyBold(): unknown {
    const model = new DocumentDataModel({
      id: '__INTERNAL_EDITOR__DOCS_NORMAL',
      body: {
        dataStream: 'ab\r\n',
        textRuns: [{ st: 0, ed: 1, ts: { bl: BooleanNumber.TRUE } }],
        paragraphs: [{ startIndex: 2 }],
        customRanges: [],
        customBlocks: [],
      },
      documentStyle: {},
    })
    const snapshot = model.getSnapshot()
    snapshot.drawings = {}
    snapshot.drawingsOrder = []
    return JSON.parse(JSON.stringify(snapshot))
  }

  it('is shared with the others', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    const p = partlyBold()
    expect(
      a.edit('bold', 'sheet.command.set-range-values', {
        subUnitId: 's1',
        range: range(3, 3, 3, 3),
        value: { 3: { 3: { p } } },
      }),
    ).toBe(true)
    room.settle(a)
    const shown = b.workbook.getSheetBySheetId('s1')!.getCellRaw(3, 3)?.p
    expect(shown?.body?.dataStream).toBe('ab\r\n')
    expect(shown?.body?.textRuns).toEqual([{ st: 0, ed: 1, ts: { bl: 1 } }])
  })

  it('still refuses drawings in it', () => {
    const page = new Room().join()
    const p = { ...(partlyBold() as object), drawingsOrder: ['d1'], drawings: { d1: {} } }
    const error = decodeError(
      page,
      op('sheet.mutation.set-range-values', { subUnitId: 's1', cellValue: { 0: { 0: { p } } } }),
    )
    expect(error).toBeInstanceOf(WireMutationError)
  })
})

describe('keys of the object prototype', () => {
  it.each([
    ['constructor', '{"v":1,"constructor":{"deep":[[[[[[[[[[[[[[1]]]]]]]]]]]]]]}}'],
    ['toString', '{"v":1,"toString":"x"}'],
    ['__proto__', '{"v":1,"__proto__":{"polluted":true}}'],
  ])('refuses %s in a cell as a wire error', (_key, cellJson) => {
    const page = new Room().join()
    const cell = JSON.parse(cellJson) as unknown
    const error = decodeError(
      page,
      op('sheet.mutation.set-range-values', { subUnitId: 's1', cellValue: { 0: { 0: cell } } }),
    )
    expect(error).toBeInstanceOf(WireMutationError)
  })
})

describe('sheet names', () => {
  it.each(['a/b', 'a\\b', 'a?', 'a*', '[a]', 'a:b', "'a", "a'", ''])(
    'refuses the name %j Excel forbids',
    (name) => {
      const page = new Room().join()
      expect(
        decodeError(page, op('sheet.mutation.set-worksheet-name', { subUnitId: 's1', name })),
      ).toBeInstanceOf(WireMutationError)
      expect(
        decodeError(
          page,
          op('sheet.mutation.insert-sheet', {
            index: 0,
            sheet: { id: 'n', name, rowCount: 10, columnCount: 10 },
          }),
        ),
      ).toBeInstanceOf(WireMutationError)
    },
  )

  it('gives a received rename onto a taken name the same free name on every page', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    receive([a, b], op('sheet.mutation.set-worksheet-name', { subUnitId: 's2', name: 'sheet1' }))
    expect(namesOf(a)).toEqual(['Sheet1', 'sheet1 (2)'])
    expect(namesOf(b)).toEqual(namesOf(a))
  })

  it('gives a received sheet with a taken name the same free name on every page', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    // what the app sends for a new sheet, with the name a modified client would put in it
    const maker = room.join()
    expect(
      maker.edit('new', 'sheet.command.insert-sheet', {
        index: 2,
        sheet: { id: 's3', name: 'Fresh' },
      }),
    ).toBe(true)
    const sent = JSON.parse(JSON.stringify(maker.adapter.encode(maker.emitted[0]!))) as {
      m: [string, { sheet: { name: string } }][]
    }
    for (const [, params] of sent.m) if (params.sheet) params.sheet.name = 'Data'
    receive([a, b], sent)
    expect(namesOf(a)).toEqual(['Sheet1', 'Data', 'Data (2)'])
    expect(namesOf(b)).toEqual(namesOf(a))
  })

  it('keeps a free name within 31 characters', () => {
    const room = new Room()
    const a = room.join()
    const long = 'x'.repeat(31)
    receive([a], op('sheet.mutation.set-worksheet-name', { subUnitId: 's1', name: long }))
    receive([a], op('sheet.mutation.set-worksheet-name', { subUnitId: 's2', name: long }))
    expect(namesOf(a)).toEqual([long, `${'x'.repeat(27)} (2)`])
  })
})

const rowCountOf = (page: OpenedBook, sheet = 's1') =>
  page.workbook.getSheetBySheetId(sheet)!.getRowCount()
const columnCountOf = (page: OpenedBook, sheet = 's1') =>
  page.workbook.getSheetBySheetId(sheet)!.getColumnCount()

describe('a sheet never grows past Excel’s grid', () => {
  it('drops, on every page alike, received inserts that would take a sheet past 1,048,576 rows', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    receive(
      [a, b],
      op('sheet.mutation.set-worksheet-row-count', { subUnitId: 's1', rowCount: MAX_ROWS - 10 }),
    )
    receive([a, b], {
      id: 'hostile-rows',
      m: [
        ['sheet.mutation.insert-row', { subUnitId: 's1', range: range(0, 0, 4, 0) }],
        ['sheet.mutation.insert-row', { subUnitId: 's1', range: range(0, 0, 19, 0) }],
      ],
    })
    expect(rowCountOf(a)).toBe(MAX_ROWS - 5)
    expect(rowCountOf(b)).toBe(rowCountOf(a))
  })

  it('drops, on every page alike, received inserts that would take a sheet past 16,384 columns', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    receive(
      [a, b],
      op('sheet.mutation.set-worksheet-column-count', {
        subUnitId: 's1',
        columnCount: MAX_COLUMNS - 1,
      }),
    )
    receive([a, b], op('sheet.mutation.insert-col', { subUnitId: 's1', range: range(0, 0, 0, 1) }))
    expect(columnCountOf(a)).toBe(MAX_COLUMNS - 1)
    expect(columnCountOf(b)).toBe(columnCountOf(a))
  })

  it('refuses a row insert on a full sheet and tells the person', () => {
    const told: string[] = []
    const room = new Room()
    const a = room.join(undefined, { onBlocked: (id, reason) => told.push(`${reason}: ${id}`) })
    expect(
      a.edit('full', 'sheet.command.set-worksheet-row-count', {
        subUnitId: 's1',
        rowCount: MAX_ROWS,
      }),
    ).toBe(true)
    expect(
      a.edit('insert', 'sheet.command.insert-row-by-range', {
        subUnitId: 's1',
        range: range(3, 0, 3, 11),
        direction: Direction.UP,
      }),
    ).toBe(false)
    expect(rowCountOf(a)).toBe(MAX_ROWS)
    expect(a.emitted.map((sent) => sent.id)).toEqual(['full'])
    expect(told).toEqual(['too-large: sheet.mutation.insert-row'])
  })

  it('leaves out of its own edit an insert that someone else’s change made too many', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    expect(
      a.edit('insert', 'sheet.command.insert-row-by-range', {
        subUnitId: 's1',
        range: range(3, 0, 3, 11),
        direction: Direction.UP,
      }),
    ).toBe(true)
    expect(
      b.edit('full', 'sheet.command.set-worksheet-row-count', {
        subUnitId: 's1',
        rowCount: MAX_ROWS,
      }),
    ).toBe(true)
    room.settle(b, a)
    expect(rowCountOf(a)).toBe(MAX_ROWS)
    expect(rowCountOf(b)).toBe(MAX_ROWS)
  })
})

describe('the merge rebuilds one op may cause', () => {
  /** One merge of 1,048,576 cells, the most a sheet may hold */
  const fullMerge = range(0, 0, 524_287, 1)

  it('leaves out, on every page alike, what a received op does past its rebuild budget', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    receive([a, b], op(ADD_MERGE, { subUnitId: 's1', ranges: [fullMerge] }))
    const empty = ['sheet.mutation.remove-worksheet-merge', { subUnitId: 's1', ranges: [] }]
    receive([a, b], {
      id: 'hostile-rebuilds',
      m: [
        ...Array.from({ length: 40 }, () => empty),
        ['sheet.mutation.remove-worksheet-merge', { subUnitId: 's1', ranges: [fullMerge] }],
      ],
    })
    expect(mergesOf(a)).toEqual([fullMerge])
    expect(mergesOf(b)).toEqual(mergesOf(a))
  })

  it('refuses an edit that would rebuild a heavily merged sheet too often, and tells the person', () => {
    const told: string[] = []
    const room = new Room()
    const a = room.join(undefined, { onBlocked: (id, reason) => told.push(`${reason}: ${id}`) })
    expect(
      a.edit('rows', 'sheet.command.set-worksheet-row-count', {
        subUnitId: 's1',
        rowCount: 600_000,
      }),
    ).toBe(true)
    expect(
      a.edit('merge', 'sheet.command.add-worksheet-merge', {
        subUnitId: 's1',
        selections: [fullMerge],
        defaultMerge: true,
      }),
    ).toBe(true)
    // nine rebuilds of 1,048,576 merged cells pass the budget of eight
    for (let insert = 0; insert < 9; insert++) {
      void a.commands.executeCommand('sheet.command.insert-row-by-range', {
        unitId: a.workbook.getUnitId(),
        subUnitId: 's1',
        range: range(0, 0, 0, 11),
        direction: Direction.UP,
      })
    }
    expect(a.adapter.flush('subtotals')).toBe(false)
    expect(a.emitted.map((sent) => sent.id)).toEqual(['rows', 'merge'])
    expect(rowCountOf(a)).toBe(600_000)
    expect(told).toEqual(['too-large: sheet.mutation.insert-row'])
  }, 30_000)

  it('charges a whole-sheet merge for every cell a saved file would hold', () => {
    const page = new Room().join()
    const error = decodeError(
      page,
      op(ADD_MERGE, {
        subUnitId: 's1',
        ranges: [{ ...range(0, 0, MAX_ROWS - 1, MAX_COLUMNS - 1), rangeType: 3 }],
      }),
    )
    expect(error).toBeInstanceOf(WireMutationError)
    expect((error as WireMutationError).tooLarge).toBe(true)
  })
})

describe('sheet name control characters', () => {
  it.each(['a\u0000b', 'a\u001fb', 'a\u007fb', '\tTab'])('refuses %j', (name) => {
    const page = new Room().join()
    expect(
      decodeError(page, op('sheet.mutation.set-worksheet-name', { subUnitId: 's1', name })),
    ).toBeInstanceOf(WireMutationError)
  })
})
