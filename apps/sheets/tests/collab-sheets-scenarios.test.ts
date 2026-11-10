/**
 * Co-editing on real Univer workbooks, case by case: two people edit at the
 * same version, the server orders one before the other, and both pages must
 * show the same workbook (and the edit each person meant, where that is
 * possible). A late joiner replays the log from the base file.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { fingerprintText } from '../src/web/collab-fingerprint'
import { Room } from './collab/room'
import { disposeAll, type OpenedBook } from './collab/sheets-workbook'

afterEach(disposeAll)

const range = (row: number, column: number, endRow = row, endColumn = column) => ({
  startRow: row,
  endRow,
  startColumn: column,
  endColumn,
})

function type(
  book: OpenedBook,
  id: string,
  sheet: string,
  row: number,
  column: number,
  value: unknown,
): void {
  const cell = typeof value === 'string' && value.startsWith('=') ? { f: value } : { v: value }
  expect(
    book.edit(id, 'sheet.command.set-range-values', {
      subUnitId: sheet,
      range: range(row, column),
      value: cell,
    }),
  ).toBe(true)
}

const print = (page: OpenedBook) => fingerprintText(page.workbook)

function expectConverged(room: Room): void {
  const late = room.late()
  const reference = print(late)
  for (const page of room.pages) expect(print(page)).toBe(reference)
}

const cell = (page: OpenedBook, row: number, column: number, sheet = 's1') =>
  page.workbook.getSheetBySheetId(sheet)?.getCellRaw(row, column)

describe('co-editing a workbook', () => {
  it('two people type in different cells', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    type(a, 'a1', 's1', 0, 0, 'from a')
    type(b, 'b1', 's1', 5, 3, 'from b')
    room.settle(a, b)
    for (const page of room.pages) {
      expect(cell(page, 0, 0)?.v).toBe('from a')
      expect(cell(page, 5, 3)?.v).toBe('from b')
    }
    expectConverged(room)
  })

  it('two people type in the same cell: the later in server order wins', () => {
    const room = new Room({ 2: { 2: { v: 'old' } } })
    const a = room.join()
    const b = room.join()
    type(a, 'a1', 's1', 2, 2, 'from a')
    type(b, 'b1', 's1', 2, 2, 'from b')
    room.settle(a, b)
    for (const page of room.pages) expect(cell(page, 2, 2)?.v).toBe('from b')
    expectConverged(room)
  })

  for (const first of ['inserter', 'typist'] as const) {
    it(`one inserts a row above a cell another is editing (${first} first)`, () => {
      const room = new Room({ 4: { 1: { v: 'row five' } } })
      const a = room.join()
      const b = room.join()
      expect(
        a.edit('a1', 'sheet.command.insert-row-by-range', {
          subUnitId: 's1',
          range: range(1, 0, 1, 11),
        }),
      ).toBe(true)
      type(b, 'b1', 's1', 4, 2, 'next to row five')
      room.settle(...(first === 'inserter' ? [a, b] : [b, a]))
      for (const page of room.pages) {
        expect(cell(page, 5, 1)?.v).toBe('row five')
        expect(cell(page, 5, 2)?.v).toBe('next to row five')
      }
      expectConverged(room)
    })

    it(`one deletes the row another edits (${first} first)`, () => {
      const room = new Room({ 3: { 0: { v: 'doomed' } }, 6: { 0: { v: 'stays' } } })
      const a = room.join()
      const b = room.join()
      expect(
        a.edit('a1', 'sheet.command.remove-row-by-range', {
          subUnitId: 's1',
          range: range(3, 0, 3, 11),
        }),
      ).toBe(true)
      type(b, 'b1', 's1', 3, 1, 'typed into the doomed row')
      type(b, 'b2', 's1', 6, 1, 'typed next to stays')
      room.settle(...(first === 'inserter' ? [a, b] : [b, a]))
      for (const page of room.pages) {
        expect(cell(page, 5, 0)?.v).toBe('stays')
        expect(cell(page, 5, 1)?.v).toBe('typed next to stays')
      }
      // removed first: the edit of the removed row is dropped; typed first: the remove takes it away
      for (const page of room.pages)
        expect(JSON.stringify(page.snapshot().sheets.s1!.cellData)).not.toContain('doomed row')
      expectConverged(room)
    })

    it(`a formula typed while another inserts a row above its reference (${first} first)`, () => {
      const room = new Room({ 9: { 1: { v: 42 } } })
      const a = room.join()
      const b = room.join()
      expect(
        a.edit('a1', 'sheet.command.insert-row-by-range', {
          subUnitId: 's1',
          range: range(4, 0, 4, 11),
        }),
      ).toBe(true)
      type(b, 'b1', 's1', 0, 3, '=B10*2')
      room.settle(...(first === 'inserter' ? [a, b] : [b, a]))
      for (const page of room.pages) {
        expect(cell(page, 10, 1)?.v).toBe(42)
        expect(cell(page, 0, 3)?.f).toBe('=B11*2')
      }
      expectConverged(room)
    })
  }

  it('concurrent sheet add and rename keep distinct names', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    expect(
      a.edit('a1', 'sheet.command.insert-sheet', {
        index: 2,
        sheet: { id: 'from-a', name: 'Plan' },
      }),
    ).toBe(true)
    expect(
      b.edit('b1', 'sheet.command.set-worksheet-name', { subUnitId: 's2', name: 'Plan' }),
    ).toBe(true)
    room.settle(b, a)
    for (const page of room.pages) {
      const names = page.workbook.getSheets().map((sheet) => sheet.getName())
      expect(names).toEqual(['Sheet1', 'Plan', 'Plan (2)'])
    }
    expectConverged(room)
  })

  it('style and value on one cell from two people both land', () => {
    const room = new Room({ 1: { 1: { v: 'plain' } } })
    const a = room.join()
    const b = room.join()
    expect(
      a.edit('a1', 'sheet.command.set-style', {
        subUnitId: 's1',
        range: range(1, 1),
        style: { type: 'bl', value: 1 },
      }),
    ).toBe(true)
    type(b, 'b1', 's1', 1, 1, 'retyped')
    room.settle(a, b)
    for (const page of room.pages) {
      const value = cell(page, 1, 1)
      expect(value?.v).toBe('retyped')
      expect(page.workbook.getStyles().getStyleByCell(value)).toMatchObject({ bl: 1 })
    }
    expectConverged(room)
  })

  it('a late joiner reaches the same workbook from the base file and the log', () => {
    const room = new Room({ 0: { 0: { v: 1 } } })
    const a = room.join()
    const b = room.join()
    type(a, 'a1', 's1', 0, 1, '=A1+1')
    expect(
      b.edit('b1', 'sheet.command.insert-row-by-range', {
        subUnitId: 's1',
        range: range(0, 0, 0, 11),
        direction: 0,
      }),
    ).toBe(true)
    room.settle(a, b)
    type(b, 'b2', 's1', 3, 3, 'later')
    room.settle(b)
    const late = room.late()
    expect(late.workbook.getSheetBySheetId('s1')?.getCellRaw(1, 1)?.f).toBe('=A2+1')
    expectConverged(room)
  })
})
