/**
 * What co-editing does at its edges: every mutation it runs reaches
 * `CommandExecuted` the way the app's save journal listens for it, and an edit
 * it cannot share is refused instead of staying on one page.
 */
import { CommandType, type ICommandInfo, type IExecutionOptions } from '@univerjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { Room } from './collab/room'
import { disposeAll, type OpenedBook } from './collab/sheets-workbook'

afterEach(disposeAll)

const cell = (row: number, column: number) => ({
  startRow: row,
  endRow: row,
  startColumn: column,
  endColumn: column,
})

/**
 * The journal's view (App.tsx): the last value set-range-values gave each cell,
 * from every mutation of the workbook that is not a formula result. It does not
 * follow structural moves, so the scenario keeps rows in place.
 */
function journalOf(page: OpenedBook): Map<string, unknown> {
  const journal = new Map<string, unknown>()
  page.commands.onCommandExecuted((info: ICommandInfo, options?: IExecutionOptions) => {
    if (info.type !== CommandType.MUTATION || info.id !== 'sheet.mutation.set-range-values') return
    if ((options as { fromFormula?: boolean } | undefined)?.fromFormula) return
    const params = info.params as {
      unitId: string
      subUnitId: string
      cellValue: Record<string, Record<string, { v?: unknown } | null>>
    }
    if (params.unitId !== page.workbook.getUnitId()) return
    for (const [row, columns] of Object.entries(params.cellValue))
      for (const [column, value] of Object.entries(columns)) {
        const key = `${params.subUnitId}!${row}:${column}`
        if (value === null) journal.set(key, undefined)
        else if (value.v !== undefined) journal.set(key, value.v)
      }
  })
  return journal
}

describe('co-editing at its edges', () => {
  it('the save journal sees remote, reverted and replayed edits and ends at what the page shows', () => {
    const room = new Room({ 2: { 2: { v: 'base' } } })
    const a = room.join()
    const b = room.join()
    const journal = journalOf(b)
    expect(
      a.edit('a1', 'sheet.command.set-range-values', {
        subUnitId: 's1',
        range: cell(2, 2),
        value: { v: 'from a' },
      }),
    ).toBe(true)
    expect(
      b.edit('b1', 'sheet.command.set-range-values', {
        subUnitId: 's1',
        range: cell(2, 2),
        value: { v: 'from b' },
      }),
    ).toBe(true)
    expect(
      b.edit('b2', 'sheet.command.set-range-values', {
        subUnitId: 's1',
        range: cell(4, 1),
        value: { v: 'only b' },
      }),
    ).toBe(true)
    // a first: b reverts both of its edits, applies a's, replays its own
    room.settle(a, b)
    for (const [key, value] of journal) {
      const [sheet, at] = key.split('!') as [string, string]
      const [row, column] = at.split(':').map(Number) as [number, number]
      expect(b.workbook.getSheetBySheetId(sheet)?.getCellRaw(row, column)?.v, key).toBe(value)
    }
    expect(journal.get('s1!2:2')).toBe('from b')
    expect(journal.get('s1!4:1')).toBe('only b')
  })

  it('refuses a second sheet with a name already taken, on the page that tried it', () => {
    const room = new Room()
    const a = room.join()
    expect(
      a.edit('a1', 'sheet.command.set-worksheet-name', { subUnitId: 's2', name: 'sheet1' }),
    ).toBe(false)
    expect(a.workbook.getSheetBySheetId('s2')?.getName()).toBe('Data')
  })

  it('refuses an edit whose mutation it cannot undo, and leaves the workbook as it was', () => {
    const room = new Room()
    const a = room.join()
    a.commands.registerCommand({
      id: 'test.mutation.unsyncable',
      type: CommandType.MUTATION,
      handler: () => true,
    })
    a.commands.registerCommand({
      id: 'test.command.unsyncable',
      type: CommandType.COMMAND,
      handler: () => {
        // a cell the command writes first must not stay behind when the rest is refused
        a.commands.syncExecuteCommand('sheet.mutation.set-range-values', {
          unitId: a.workbook.getUnitId(),
          subUnitId: 's1',
          cellValue: { 0: { 0: { v: 'half' } } },
        })
        return a.commands.syncExecuteCommand('test.mutation.unsyncable', {
          unitId: a.workbook.getUnitId(),
        })
      },
    })
    // run to its end before the burst is reported, as a page's macrotask burst does
    a.commands.syncExecuteCommand('test.command.unsyncable', {})
    expect(a.adapter.flush('a1')).toBe(false)
    expect(a.emitted).toEqual([])
    expect(a.workbook.getSheetBySheetId('s1')?.getCellRaw(0, 0)?.v).toBeUndefined()
  })

  it('refuses a command it cannot share before any of its mutations runs', () => {
    const room = new Room()
    const a = room.join()
    let ran = false
    a.commands.registerCommand({
      id: 'sheet.command.add-conditional-rule',
      type: CommandType.COMMAND,
      handler: () => {
        ran = true
        return true
      },
    })
    expect(a.edit('a1', 'sheet.command.add-conditional-rule', {})).toBe(false)
    expect(ran).toBe(false)
  })

  it('a page that cannot edit refuses local edits but applies everyone else’s', () => {
    const room = new Room()
    const a = room.join()
    const viewer = room.join()
    viewer.adapter.setEditable(false)
    expect(
      viewer.edit('v1', 'sheet.command.set-range-values', {
        subUnitId: 's1',
        range: cell(0, 0),
        value: { v: 'viewer' },
      }),
    ).toBe(false)
    expect(
      a.edit('a1', 'sheet.command.set-range-values', {
        subUnitId: 's1',
        range: cell(0, 0),
        value: { v: 'editor' },
      }),
    ).toBe(true)
    room.settle(a)
    expect(viewer.workbook.getSheetBySheetId('s1')?.getCellRaw(0, 0)?.v).toBe('editor')
  })
})
