/**
 * Sequences in which the real app could break what co-editing relies on: every
 * page shows the log in order plus its own unconfirmed edits, the fingerprint
 * covers only what people put in, and a saved file is the same whoever saves.
 */
import {
  CommandType,
  CustomCommandExecutionError,
  ICommandService,
  IUniverInstanceService,
} from '@univerjs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { personEditVetoed } from '../src/renderer/ai/run-lock'
import { createEditJournal } from '../src/renderer/edit-journal'
import { aiRunLock } from '../src/renderer/univer-state'
import { fingerprintText } from '../src/web/collab-fingerprint'
import { savePayload } from './collab/journal'
import { Room } from './collab/room'
import { disposeAll, type OpenedBook } from './collab/sheets-workbook'

afterEach(() => {
  disposeAll()
  aiRunLock.active = false
})

const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'
const at = (row: number, column: number, endRow = row, endColumn = column) => ({
  startRow: row,
  endRow,
  startColumn: column,
  endColumn,
})
const wholeRow = (row: number) => at(row, 0, row, 11)
const cellOf = (page: OpenedBook, row: number, column: number, sheet = 's1') =>
  page.workbook.getSheetBySheetId(sheet)?.getCellRaw(row, column)
const styleOf = (page: OpenedBook, row: number, column: number) =>
  page.workbook.getStyles().getStyleByCell(cellOf(page, row, column))

function type(
  page: OpenedBook,
  id: string,
  row: number,
  column: number,
  value: unknown,
  sheet = 's1',
): void {
  const cell = typeof value === 'string' && value.startsWith('=') ? { f: value } : { v: value }
  expect(
    page.edit(id, 'sheet.command.set-range-values', {
      subUnitId: sheet,
      range: at(row, column),
      value: cell,
    }),
  ).toBe(true)
}

function insertRow(page: OpenedBook, id: string, row: number): void {
  expect(
    page.edit(id, 'sheet.command.insert-row-by-range', {
      subUnitId: 's1',
      range: wholeRow(row),
      direction: 0,
    }),
  ).toBe(true)
}

/** Univer's move command asks its interceptors first and runs its mutations a tick later */
async function moveRange(page: OpenedBook, id: string, from: object, to: object): Promise<void> {
  await page.commands.executeCommand('sheet.command.move-range', {
    unitId: page.workbook.getUnitId(),
    fromSubUnitId: 's1',
    toSubUnitId: 's1',
    fromRange: from,
    toRange: to,
  })
  expect(page.adapter.flush(id)).toBe(true)
}

function undo(page: OpenedBook, id: string): boolean {
  // undo acts on the focused workbook; a headless page has none until it is told
  page.univer.__getInjector().get(IUniverInstanceService).focusUnit(page.workbook.getUnitId())
  page.commands.syncExecuteCommand('univer.command.undo')
  return page.adapter.flush(id)
}

function expectSame(room: Room): void {
  const texts = room.pages.map((page) => fingerprintText(page.workbook))
  for (const text of texts) expect(text).toBe(texts[0])
}

describe('the fingerprint holds only what people put in', () => {
  const currency = { n: { pattern: '$#,##0.00' } }

  it('a number format the formula engine derives later does not change it, with or without a calculation', async () => {
    const room = new Room({ 1: { 1: { v: 10, t: 2, s: currency } } })
    const ja = createEditJournal()
    const jb = createEditJournal()
    const a = room.join(ja)
    const b = room.join(jb)
    // b stands for a page in manual calculation: the engine's results never reach its cells
    b.commands.beforeCommandExecuted((info, options) => {
      const calculated = (options as { applyFormulaCalculationResult?: boolean } | undefined)
        ?.applyFormulaCalculationResult
      if (info.id === SET_RANGE_VALUES && calculated)
        throw new CustomCommandExecutionError('manual')
    })
    type(a, 'a1', 8, 4, '=B2')
    const before = fingerprintText(a.workbook)
    const hashBefore = await a.adapter.fingerprint()
    room.settle(a)
    // the engine writes the result and the source's format into the formula cell, later
    await vi.waitFor(() => expect(styleOf(a, 8, 4)?.n?.pattern).toBe('$#,##0.00'))
    expect(styleOf(b, 8, 4)?.n).toBeUndefined()
    expect(fingerprintText(a.workbook)).toBe(before)
    expect(await a.adapter.fingerprint()).toBe(hashBefore)
    expect(await b.adapter.fingerprint()).toBe(hashBefore)
    // the saved file is the same from both pages: neither journal holds the derived format
    expect(savePayload(ja)).toEqual(savePayload(jb))
    expect(savePayload(ja).edits).toEqual([
      { sheetId: 's1', row: 8, column: 4, writeValue: true, value: null, formula: '=B2' },
    ])
  })

  it('the derived format a typed-over formula cell keeps does not change it either', async () => {
    const room = new Room({ 1: { 1: { v: 10, t: 2, s: currency } } })
    const a = room.join()
    const b = room.join()
    type(a, 'a1', 8, 4, '=B2')
    await vi.waitFor(() => expect(styleOf(a, 8, 4)?.n?.pattern).toBe('$#,##0.00'))
    type(a, 'a2', 8, 4, 5)
    // b receives the formula and the value over it in one go: its engine never derives the format
    room.settle(a)
    expect(cellOf(b, 8, 4)?.v).toBe(5)
    expect(styleOf(a, 8, 4)?.n?.pattern).toBe('$#,##0.00')
    expect(styleOf(b, 8, 4)?.n).toBeUndefined()
    expectSame(room)
    // a format a person sets on a row is still covered
    expect(
      a.edit('a3', 'sheet.command.set-row-data', {
        subUnitId: 's1',
        rowData: { 3: { s: { n: { pattern: '0.0%' } } } },
      }),
    ).toBe(true)
    expect(fingerprintText(a.workbook)).not.toBe(fingerprintText(b.workbook))
  })
})

describe('a mutation that does not run', () => {
  it('a remote mutation another listener cancels fails this page instead of being dropped', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    // what a lock on the workbook does: it cancels every mutation of it
    b.commands.beforeCommandExecuted((info) => {
      if (info.type === CommandType.MUTATION && info.id === SET_RANGE_VALUES)
        throw new CustomCommandExecutionError('locked')
    })
    type(a, 'a1', 0, 0, 'from a')
    expect(() => room.settle(a)).toThrow(/could not apply/)
    // and the page stays failed for whatever the engine asks next
    expect(() => b.adapter.fingerprint()).toThrow()
  })

  it('the AI run lock lets co-editing’s own mutations through', () => {
    aiRunLock.active = true
    const mutation = {
      id: SET_RANGE_VALUES,
      type: CommandType.MUTATION,
      params: { unitId: 'book' },
    }
    expect(personEditVetoed({ ...mutation, options: {} }, 'book')).toBe(true)
    expect(personEditVetoed({ ...mutation, options: { fromCollab: true } }, 'book')).toBe(false)
  })
})

describe('reference rewrites that ride on a structural edit', () => {
  it('an insert replayed after someone changed a formula below it keeps their formula', () => {
    const room = new Room({ 5: { 0: { v: 3 }, 3: { f: '=A6' } } })
    const journals = [createEditJournal(), createEditJournal()]
    const a = room.join(journals[0])
    const b = room.join(journals[1])
    insertRow(a, 'a1', 1)
    type(b, 'b1', 5, 3, '=A6*2')
    // b first: a's insert runs again after b's formula, and its rewrite must start from that formula
    room.settle(b, a)
    for (const page of room.pages) expect(cellOf(page, 6, 3)?.f).toBe('=A7*2')
    expectSame(room)
    const late = createEditJournal()
    room.late(late)
    expectSame(room)
    for (const journal of journals) expect(savePayload(journal)).toEqual(savePayload(late))
    expect(savePayload(late).edits).toContainEqual(
      expect.objectContaining({ row: 6, column: 3, formula: '=A7*2' }),
    )
  })

  it('an insert replayed after someone typed a formula above a formula column does not wipe it', () => {
    const room = new Room({ 0: { 0: { v: 7 } }, 2: { 3: { f: '=A3' } }, 3: { 3: { f: '=A4' } } })
    const journals = [createEditJournal(), createEditJournal()]
    const a = room.join(journals[0])
    const b = room.join(journals[1])
    insertRow(a, 'a1', 1)
    type(b, 'b1', 1, 3, '=A1')
    room.settle(b, a)
    for (const page of room.pages) {
      // b's formula moved down with the insert and is still a formula
      expect(cellOf(page, 2, 3)?.f).toBe('=A1')
      expect(cellOf(page, 3, 3)?.f).toBe('=A4')
      expect(cellOf(page, 4, 3)?.f).toBe('=A5')
    }
    expectSame(room)
    const late = createEditJournal()
    room.late(late)
    expectSame(room)
    for (const journal of journals) expect(savePayload(journal)).toEqual(savePayload(late))
    // screen and file agree on the cell the stale rewrite used to freeze
    expect(savePayload(late).edits).toContainEqual(
      expect.objectContaining({ row: 2, column: 3, formula: '=A1' }),
    )
  })

  it('a remove replayed after someone changed a formula below it keeps their formula', () => {
    const room = new Room({ 5: { 3: { f: '=A6' } } })
    const journals = [createEditJournal(), createEditJournal()]
    const a = room.join(journals[0])
    const b = room.join(journals[1])
    expect(
      a.edit('a1', 'sheet.command.remove-row-by-range', { subUnitId: 's1', range: wholeRow(1) }),
    ).toBe(true)
    type(b, 'b1', 5, 3, '=A6*2')
    room.settle(b, a)
    for (const page of room.pages) expect(cellOf(page, 4, 3)?.f).toBe('=A5*2')
    expectSame(room)
    const late = createEditJournal()
    room.late(late)
    for (const journal of journals) expect(savePayload(journal)).toEqual(savePayload(late))
  })

  it('a formula a remote move brought in follows a replayed insert', async () => {
    const room = new Room({ 8: { 5: { f: '=A9' } } })
    const a = room.join()
    const b = room.join()
    insertRow(a, 'a1', 1)
    await moveRange(b, 'b1', at(8, 5), at(8, 7))
    room.settle(b, a)
    for (const page of room.pages) expect(cellOf(page, 9, 7)?.f).toBe('=A10')
    expectSame(room)
    room.late()
    expectSame(room)
  })

  it('a rename replayed after someone typed a reference to the old name carries that reference', () => {
    const room = new Room()
    const journals = [createEditJournal(), createEditJournal()]
    const a = room.join(journals[0])
    const b = room.join(journals[1])
    expect(
      a.edit('a1', 'sheet.command.set-worksheet-name', { subUnitId: 's2', name: 'Plan 2' }),
    ).toBe(true)
    type(b, 'b1', 3, 3, '=Data!A1')
    room.settle(b, a)
    for (const page of room.pages) expect(cellOf(page, 3, 3)?.f).toBe("='Plan 2'!A1")
    expectSame(room)
    const late = createEditJournal()
    room.late(late)
    expectSame(room)
    for (const journal of journals) expect(savePayload(journal)).toEqual(savePayload(late))
  })

  it('a reference typed to the old name while someone renames the sheet follows the rename', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    expect(
      a.edit('a1', 'sheet.command.set-worksheet-name', { subUnitId: 's2', name: 'Plan' }),
    ).toBe(true)
    type(b, 'b1', 3, 3, '=Data!A1')
    // the rename first: b's unconfirmed formula still names the sheet as it was
    room.settle(a, b)
    for (const page of room.pages) expect(cellOf(page, 3, 3)?.f).toBe('=Plan!A1')
    expectSame(room)
    room.late()
    expectSame(room)
  })
})

describe('commands that end without an executed event', () => {
  it('a command another listener cancelled does not stop a later refused command being taken back whole', () => {
    const room = new Room()
    const a = room.join()
    const commands = a.univer.__getInjector().get(ICommandService)
    commands.registerCommand({
      id: 'test.command.guarded',
      type: CommandType.COMMAND,
      handler: () => true,
    })
    // a guard registered after the adapter, as the app's protection and pivot guards are
    commands.beforeCommandExecuted((info) => {
      if (info.id === 'test.command.guarded') throw new CustomCommandExecutionError('guarded')
    })
    commands.registerCommand({
      id: 'test.mutation.unsyncable',
      type: CommandType.MUTATION,
      handler: () => true,
    })
    commands.registerCommand({
      id: 'test.command.paste-with-blocked-part',
      type: CommandType.COMMAND,
      handler: () => {
        commands.syncExecuteCommand(SET_RANGE_VALUES, {
          unitId: a.workbook.getUnitId(),
          subUnitId: 's1',
          cellValue: { 0: { 0: { v: 'pasted half' } } },
        })
        return commands.syncExecuteCommand('test.mutation.unsyncable', {
          unitId: a.workbook.getUnitId(),
        })
      },
    })
    expect(commands.syncExecuteCommand('test.command.guarded', {})).toBe(false)
    commands.syncExecuteCommand('test.command.paste-with-blocked-part', {})
    expect(a.adapter.flush('a1')).toBe(false)
    expect(a.emitted).toEqual([])
    expect(cellOf(a, 0, 0)?.v).toBeUndefined()
  })
})

describe('undo after someone else’s change', () => {
  it('does not take back a value someone typed over this page’s edit', () => {
    const room = new Room({ 4: { 2: { v: 'before' } } })
    const a = room.join()
    const b = room.join()
    type(a, 'a1', 4, 2, 'from a')
    room.settle(a)
    type(b, 'b1', 4, 2, 'from b')
    room.settle(b)
    undo(a, 'a2')
    room.settle(a)
    for (const page of room.pages) expect(cellOf(page, 4, 2)?.v).toBe('from b')
  })

  it('does not write an old value where a remote move put another record', async () => {
    const room = new Room({ 4: { 2: { v: 'before' } }, 7: { 2: { v: 'other' } } })
    const a = room.join()
    const b = room.join()
    type(a, 'a1', 4, 2, 'from a')
    room.settle(a)
    await moveRange(b, 'b1', at(7, 2), at(4, 2))
    room.settle(b)
    undo(a, 'a2')
    room.settle(a)
    for (const page of room.pages) expect(cellOf(page, 4, 2)?.v).toBe('other')
  })

  it('does not remove a merge someone else made over the range this page tried to merge', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    const merge = (page: OpenedBook, id: string, range: ReturnType<typeof at>) =>
      page.edit(id, 'sheet.command.add-worksheet-merge', {
        subUnitId: 's1',
        selections: [range],
        defaultMerge: true,
      })
    expect(merge(a, 'a1', at(2, 1, 3, 2))).toBe(true)
    expect(merge(b, 'b1', at(3, 2, 4, 3))).toBe(true)
    // b first: its merge stands, a's overlapping one is dropped
    room.settle(b, a)
    undo(a, 'a2')
    room.settle(a)
    for (const page of room.pages) {
      expect(page.workbook.getSheetBySheetId('s1')!.getConfig().mergeData).toEqual([
        expect.objectContaining(at(3, 2, 4, 3)),
      ])
    }
  })

  it('still undoes this page’s own edit when the others only wrote other cells', () => {
    const room = new Room({ 4: { 2: { v: 'before' } } })
    const a = room.join()
    const b = room.join()
    type(a, 'a1', 4, 2, 'from a')
    room.settle(a)
    type(b, 'b1', 9, 9, 'elsewhere')
    room.settle(b)
    expect(undo(a, 'a2')).toBe(true)
    room.settle(a)
    for (const page of room.pages) {
      expect(cellOf(page, 4, 2)?.v).toBe('before')
      expect(cellOf(page, 9, 9)?.v).toBe('elsewhere')
    }
  })
})

describe('an edit too large to send', () => {
  it('is taken back whole and the person is told, instead of failing the session', () => {
    const room = new Room({ 0: { 0: { v: 'kept' } } })
    const told: string[] = []
    const journal = createEditJournal()
    const a = room.join(journal, {
      maxChangeBytes: 2_000,
      onBlocked: (id, reason) => told.push(`${reason ?? 'unshared'}: ${id}`),
    })
    type(a, 'small', 1, 0, 'fits')
    const value: Record<number, Record<number, { v: string }>> = {}
    for (let row = 0; row < 20; row++) {
      value[row] = {}
      for (let column = 0; column < 10; column++)
        value[row]![column] = { v: `a long cell text ${row}:${column}` }
    }
    expect(
      a.edit('big', 'sheet.command.set-range-values', {
        subUnitId: 's1',
        range: at(0, 0, 19, 9),
        value,
      }),
    ).toBe(false)
    expect(a.emitted.map((op) => op.id)).toEqual(['small'])
    expect(cellOf(a, 0, 0)?.v).toBe('kept')
    expect(cellOf(a, 5, 5)).toBeFalsy()
    expect(told).toEqual([`too-large: ${SET_RANGE_VALUES}`])
    // the save journal forgets it too
    expect(savePayload(journal).edits).toEqual([
      { sheetId: 's1', row: 1, column: 0, writeValue: true, value: 'fits' },
    ])
  })
})

describe('what the adapter relies on in Univer', () => {
  it('fails the page when a mutation it captured comes back as another object', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    // what a Univer that copied the command info between its listener rounds would do
    const listeners = (
      a.commands as unknown as { _collabMutationListeners: ((...args: unknown[]) => void)[] }
    )._collabMutationListeners
    listeners.forEach((listener, index) => {
      listeners[index] = (info, ...rest) => listener({ ...(info as object) }, ...rest)
    })
    a.edit('a1', 'sheet.command.set-range-values', {
      subUnitId: 's1',
      range: at(0, 0),
      value: { v: 'local only' },
    })
    // the edit would have stayed on this page without a word
    expect(() => a.adapter.fingerprint()).toThrow(/command info/)
    type(b, 'b1', 1, 1, 'from b')
    expect(() => room.settle(b)).toThrow()
  })

  it('keeps the sheet a person is on when their unconfirmed new sheet is taken back and put again', () => {
    const room = new Room()
    const a = room.join()
    const b = room.join()
    expect(
      a.edit('a1', 'sheet.command.insert-sheet', { index: 2, sheet: { id: 'new1', name: 'New' } }),
    ).toBe(true)
    expect(a.workbook.getActiveSheet()?.getSheetId()).toBe('new1')
    type(b, 'b1', 0, 0, 'from b')
    room.settle(b, a)
    expect(a.workbook.getActiveSheet()?.getSheetId()).toBe('new1')
  })
})

describe('the save journal’s marks', () => {
  it('taking back a row insert keeps what the page journaled without a mutation', () => {
    const room = new Room()
    const journal = createEditJournal()
    const a = room.join(journal)
    const b = room.join()
    insertRow(a, 'a1', 1)
    // the zoom a person set and a chart's cached values: journal writes no mutation carries
    journal.pageSetup.set('s1', { ...journal.pageSetup.get('s1'), zoomScale: 150 })
    journal.chartEdits.set('xl/charts/chart1.xml', { series: [{ index: 0, values: [1, 2, 3] }] })
    type(b, 'b1', 0, 0, 'from b')
    room.settle(b, a)
    expect(journal.pageSetup.get('s1')?.zoomScale).toBe(150)
    expect(journal.chartEdits.get('xl/charts/chart1.xml')).toEqual({
      series: [{ index: 0, values: [1, 2, 3] }],
    })
    expect(savePayload(journal).structural).toEqual([
      { sheetId: 's1', kind: 'insert-rows', index: 1, count: 1 },
    ])
  })
})
