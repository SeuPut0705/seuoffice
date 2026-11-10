/**
 * The app's save journal under co-editing. A saved file is the original
 * package plus the journal, so a page that reverted and replayed its own edits
 * must end with the journal of a page that only applied the log in order: a
 * late joiner. Anything the reverts leave behind in the journal is a file that
 * differs from the screen and from every other page's file.
 */
import { CommandType, IUniverInstanceService } from '@univerjs/core'
import { afterEach, describe, expect, it } from 'vitest'
import { createEditJournal, type EditJournal } from '../src/renderer/edit-journal'
import { savePayload } from './collab/journal'
import { int, pick, randomEdit, seeded } from './collab/random-edit'
import { Room } from './collab/room'
import { disposeAll, type OpenedBook } from './collab/sheets-workbook'

afterEach(disposeAll)

const cell = (row: number, column: number) => ({
  startRow: row,
  endRow: row,
  startColumn: column,
  endColumn: column,
})

const seeds = (count: number) =>
  process.env.COLLAB_SEED
    ? [Number(process.env.COLLAB_SEED)]
    : Array.from({ length: Number(process.env.COLLAB_SEEDS ?? count) }, (_, i) => i + 1)

describe('the save journal while co-editing', () => {
  it('typing into a styled cell while a remote change arrives does not reset the cell’s style in the file', () => {
    const room = new Room({ 2: { 2: { v: 'base', s: 'bold' } } })
    const journal = createEditJournal()
    const a = room.join()
    const b = room.join(journal)
    expect(
      b.edit('b1', 'sheet.command.set-range-values', {
        subUnitId: 's1',
        range: cell(2, 2),
        value: { v: 'from b' },
      }),
    ).toBe(true)
    expect(
      a.edit('a1', 'sheet.command.set-range-values', {
        subUnitId: 's1',
        range: cell(4, 1),
        value: { v: 'from a' },
      }),
    ).toBe(true)
    // a first: b clears its cell, sets the old one back (style by id), applies a's edit, types again
    room.settle(a, b)
    const shown = b.workbook.getSheetBySheetId('s1')!.getCellRaw(2, 2)
    expect(shown?.v).toBe('from b')
    expect(shown?.s).toBe('bold')
    // the file keeps the cell's own style: the entry writes a value and nothing else
    expect(journal.cells.get('s1')?.get('2:2')).toEqual({
      row: 2,
      column: 2,
      hasValue: true,
      value: 'from b',
    })
    const reference = createEditJournal()
    room.late(reference)
    expect(savePayload(journal)).toEqual(savePayload(reference))
  })

  it('an insert reverted and replayed around a remote change does not journal the sheet’s merges again', () => {
    const room = new Room()
    const journal = createEditJournal()
    const a = room.join()
    const b = room.join(journal)
    expect(
      a.edit('a1', 'sheet.command.add-worksheet-merge', {
        subUnitId: 's1',
        selections: [{ ...cell(8, 1), endColumn: 2 }],
        defaultMerge: true,
      }),
    ).toBe(true)
    room.settle(a)
    expect(
      b.edit('b1', 'sheet.command.insert-row-by-range', {
        subUnitId: 's1',
        range: { startRow: 3, endRow: 3, startColumn: 0, endColumn: 11 },
        direction: 0,
      }),
    ).toBe(true)
    expect(
      a.edit('a2', 'sheet.command.set-range-values', {
        subUnitId: 's1',
        range: cell(0, 0),
        value: { v: 'from a' },
      }),
    ).toBe(true)
    // a first: b takes its insert back (rows and every merge), applies a's edit, inserts again
    room.settle(a, b)
    expect(b.workbook.getSheetBySheetId('s1')!.getConfig().mergeData).toEqual([
      expect.objectContaining({ startRow: 9, endRow: 9, startColumn: 1, endColumn: 2 }),
    ])
    expect(savePayload(journal).structural).toEqual([
      {
        sheetId: 's1',
        kind: 'merge-cells',
        range: { startRow: 8, endRow: 8, startColumn: 1, endColumn: 2 },
      },
      { sheetId: 's1', kind: 'insert-rows', index: 3, count: 1 },
    ])
    const reference = createEditJournal()
    room.late(reference)
    expect(savePayload(journal)).toEqual(savePayload(reference))
  })

  it('a refused command that had already written a cell leaves no trace in the journal', () => {
    const room = new Room({ 0: { 0: { v: 'kept', s: 'bold' } } })
    const journal = createEditJournal()
    const a = room.join(journal)
    a.commands.registerCommand({
      id: 'test.mutation.unsyncable',
      type: CommandType.MUTATION,
      handler: () => true,
    })
    a.commands.registerCommand({
      id: 'test.command.unsyncable',
      type: CommandType.COMMAND,
      handler: () => {
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
    a.commands.syncExecuteCommand('test.command.unsyncable', {})
    expect(a.adapter.flush('a1')).toBe(false)
    expect(a.workbook.getSheetBySheetId('s1')?.getCellRaw(0, 0)).toMatchObject({
      v: 'kept',
      s: 'bold',
    })
    expect(savePayload(journal)).toEqual(savePayload(createEditJournal()))
  })

  it('refuses to copy a sheet: every other page would save the copy as an empty sheet', () => {
    const room = new Room({ 0: { 0: { v: 'copied' } } })
    const a = room.join()
    expect(a.edit('a1', 'sheet.command.copy-sheet', { subUnitId: 's1' })).toBe(false)
    expect(a.workbook.getSheets().map((sheet) => sheet.getSheetId())).toEqual(['s1', 's2'])
  })

  it('a removed sheet that undo brings back returns with its cells, and the journal forgets the removal', () => {
    const room = new Room()
    const journal = createEditJournal()
    const a = room.join()
    const b = room.join(journal)
    expect(a.edit('a1', 'sheet.command.remove-sheet', { subUnitId: 's2' })).toBe(true)
    room.settle(a)
    expect(b.workbook.getSheetBySheetId('s2')).toBeFalsy()
    // undo acts on the focused workbook; a headless page has none until it is told
    a.univer.__getInjector().get(IUniverInstanceService).focusUnit(a.workbook.getUnitId())
    a.commands.syncExecuteCommand('univer.command.undo')
    expect(a.adapter.flush('a2')).toBe(true)
    room.settle(a)
    expect(b.workbook.getSheetBySheetId('s2')?.getCellRaw(0, 0)?.v).toBe('data')
    expect(savePayload(journal).sheets).toEqual([])
  })

  it('every page ends with the journal of the log in order, for every seed', () => {
    let edits = 0
    for (const seed of seeds(60)) {
      const random = seeded(seed)
      const room = new Room({
        0: { 0: { v: 'name' }, 1: { v: 'amount' } },
        1: { 0: { v: 'kim' }, 1: { v: 3 } },
        2: { 0: { v: 'lee' }, 1: { v: 4 }, 2: { f: '=B2+B3' } },
        6: { 3: { v: 'bold', s: 'bold' } },
      })
      const pages: { page: OpenedBook; journal: EditJournal }[] = []
      for (let i = 0, count = 2 + (seed % 3); i < count; i++) {
        const journal = createEditJournal()
        pages.push({ page: room.join(journal), journal })
      }
      for (let step = 0; step < 90; step++) {
        const { page } = pick(random, pages)
        const roll = random()
        if (roll < 0.55) {
          if (randomEdit(page, random, `p${room.pages.indexOf(page)}.${edits}`)) edits += 1
        } else if (roll < 0.8) room.submit(page)
        else room.catchUp(page, int(random, room.log.length + 1))
        if (step % 30 !== 29) continue
        room.settle(...pages.map((entry) => entry.page))
        const reference = createEditJournal()
        const late = room.late(reference)
        const expected = savePayload(reference)
        for (const { page: other, journal } of pages) {
          expect(
            savePayload(journal),
            `seed ${seed}, step ${step}, page ${room.pages.indexOf(other)}`,
          ).toEqual(expected)
        }
        late.dispose()
        room.pages.pop()
      }
      disposeAll()
    }
    expect(edits).toBeGreaterThan(0)
  }, 600_000)
})
