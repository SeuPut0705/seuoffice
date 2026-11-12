// @vitest-environment jsdom
/**
 * A person moving, sorting, filling or pasting a cell hidden from AI.
 *
 * A mark is a rectangle over an address. These operations carry the value to
 * another address (or put a second copy of it there) and leave the mark where
 * it was, so the in-app AI reads the value at its new place and an innocent
 * cell is hidden instead. The grid here is a real Univer workbook running the
 * real commands; what the AI would read is asked through the same per-cell
 * question the read tools ask (`modelCellValue`).
 */
import {
  ICommandService,
  IUniverInstanceService,
  LocaleType,
  LogLevel,
  RANGE_TYPE,
  Univer,
} from '@univerjs/core'
import type { IRange } from '@univerjs/core'
import { FUniver } from '@univerjs/core/lib/facade'
import { SheetsSelectionsService, UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { describe, expect, it, vi } from 'vitest'

import {
  buildRedactionIndex,
  modelCellValue,
  NO_REDACTIONS,
  type RedactionIndex,
} from '../src/renderer/ai/redact'
import { REDACTIONS_NOT_LOADED, redactionIndexOf } from '../src/renderer/ai/redact-load'
import { t } from '../src/renderer/i18n/locale'
import {
  guardInternalPaste,
  installRedactMoveGuard,
  pasteSourceHoldsHidden,
  type InternalPasteService,
} from '../src/renderer/redact-move-guard'
import type { UniverRuntime } from '../src/renderer/univer-state'

const SECRET = '13800138000'
const SHEETS = [{ id: 's', name: 'Sheet1' }]
const ROWS = 6
const COLUMNS = 6

const cell = (row: number, column: number): IRange => ({
  startRow: row,
  endRow: row,
  startColumn: column,
  endColumn: column,
})
const area = (
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
): IRange => ({
  startRow,
  endRow,
  startColumn,
  endColumn,
})
/** The row header of row 2 dragged down past row 4, as the grid dispatches it. */
const MOVE_ROW_2_BELOW_ROW_4 = {
  fromRange: area(1, 0, 1, 9),
  toRange: area(4, 0, 4, 9),
  range: { ...area(1, 0, 1, 9), rangeType: RANGE_TYPE.ROW },
}

/** B2 is hidden: the phone number sits at row 1, column 1. */
const HIDDEN_B2 = buildRedactionIndex(
  [{ sheetName: 'Sheet1', marks: [{ ...cell(1, 1), label: 'client phone' }] }],
  SHEETS,
)

function boot(index: RedactionIndex = HIDDEN_B2) {
  const univer = new Univer({
    logLevel: LogLevel.SILENT,
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: {} },
  })
  univer.registerPlugin(UniverSheetsPlugin)
  const univerAPI = FUniver.newAPI(univer)
  const cellData: Record<number, Record<number, { v: string }>> = {}
  for (let row = 0; row < ROWS; row++) {
    cellData[row] = {}
    for (let column = 0; column < COLUMNS; column++) {
      cellData[row]![column] = { v: `${'ABCDEF'[column]}${row + 1}` }
    }
  }
  cellData[1]![1] = { v: SECRET }
  univerAPI.createWorkbook({
    id: 'wb',
    name: 'marks',
    sheetOrder: ['s'],
    sheets: { s: { id: 's', name: 'Sheet1', rowCount: 20, columnCount: 10, cellData } },
  })
  const injector = univer.__getInjector()
  injector.get(IUniverInstanceService).focusUnit('wb')
  const runtime = { univer, univerAPI } as unknown as UniverRuntime
  const live = { index }
  const notices: string[] = []
  installRedactMoveGuard(runtime, {
    redactions: () => live.index,
    notify: (message) => notices.push(message),
  })
  const worksheet = univerAPI.getActiveWorkbook()!.getActiveSheet()!
  const valueAt = (row: number, column: number) =>
    worksheet.getRange(row, column, 1, 1).getValue() as string | number | null
  /** Every address where the AI's read would hand the phone number over. */
  const leaks = (): string[] => {
    const out: string[] = []
    for (let row = 0; row < 20; row++) {
      for (let column = 0; column < 10; column++) {
        const seen = modelCellValue(live.index, 's', row, column, valueAt(row, column))
        if (String(seen) === SECRET) out.push(`${'ABCDEFGHIJ'[column]}${row + 1}`)
      }
    }
    return out
  }
  const commands = injector.get(ICommandService)
  /** A refused command rejects; the person just sees the notice. */
  const run = async (id: string, params?: object): Promise<boolean> => {
    try {
      return (await commands.executeCommand(id, params)) === true
    } catch {
      return false
    }
  }
  const select = (range: IRange) =>
    injector.get(SheetsSelectionsService).setSelections([{ range, primary: null, style: null }])
  return { run, select, valueAt, leaks, notices, live }
}

const REFUSED = [t('redactMoveRefused')]

describe('a person moving a hidden cell', () => {
  it('refuses a drag of the cell to another place', async () => {
    const { run, valueAt, leaks, notices } = boot()
    await run('sheet.command.move-range', { fromRange: cell(1, 1), toRange: cell(3, 3) })
    expect(leaks()).toEqual([])
    expect(valueAt(1, 1)).toBe(SECRET)
    expect(valueAt(3, 3)).toBe('D4')
    expect(notices).toEqual(REFUSED)
  })

  it('refuses a drag of a block that holds it', async () => {
    const { run, leaks, notices } = boot()
    await run('sheet.command.move-range', {
      fromRange: area(0, 0, 2, 2),
      toRange: area(8, 0, 10, 2),
    })
    expect(leaks()).toEqual([])
    expect(notices).toEqual(REFUSED)
  })

  it('refuses a drag that would land on it: only an undo moving cells could bring it back', async () => {
    const { run, valueAt, leaks, notices } = boot()
    await run('sheet.command.move-range', { fromRange: cell(3, 3), toRange: cell(1, 1) })
    expect(valueAt(1, 1)).toBe(SECRET)
    expect(valueAt(3, 3)).toBe('D4')
    expect(leaks()).toEqual([])
    expect(notices).toEqual(REFUSED)
  })

  it('refuses dragging its row to another position', async () => {
    const { run, valueAt, leaks, notices } = boot()
    await run('sheet.command.move-rows', MOVE_ROW_2_BELOW_ROW_4)
    expect(leaks()).toEqual([])
    expect(valueAt(1, 1)).toBe(SECRET)
    expect(notices).toEqual(REFUSED)
  })

  it('refuses every move while the marks of the workbook are not known', async () => {
    const { run, valueAt, notices } = boot(redactionIndexOf(REDACTIONS_NOT_LOADED))
    await run('sheet.command.move-range', { fromRange: cell(2, 2), toRange: cell(8, 8) })
    expect(valueAt(2, 2)).toBe('C3')
    expect(notices).toEqual(REFUSED)
  })

  it('refuses inserting cells that would push it down', async () => {
    const { run, valueAt, leaks, notices } = boot()
    await run('sheet.command.insert-range-move-down', { range: cell(0, 1) })
    expect(leaks()).toEqual([])
    expect(valueAt(1, 1)).toBe(SECRET)
    expect(notices).toEqual(REFUSED)
  })

  it('refuses deleting cells that would pull it left, with the selection standing in', async () => {
    const { run, select, valueAt, leaks, notices } = boot()
    select(cell(1, 0))
    await run('sheet.command.delete-range-move-left')
    expect(leaks()).toEqual([])
    expect(valueAt(1, 1)).toBe(SECRET)
    expect(notices).toEqual(REFUSED)
  })
})

describe('a person sorting a range that holds a hidden cell', () => {
  it('refuses the sort', async () => {
    const { run, valueAt, leaks, notices } = boot()
    await run('sheet.command.reorder-range', {
      unitId: 'wb',
      subUnitId: 's',
      range: area(0, 0, 5, 5),
      order: { 0: 5, 1: 4, 2: 3, 3: 2, 4: 1, 5: 0 },
    })
    expect(leaks()).toEqual([])
    expect(valueAt(1, 1)).toBe(SECRET)
    expect(notices).toEqual(REFUSED)
  })
})

describe('a person filling from a hidden cell', () => {
  it('refuses a fill-handle drag that starts on it', async () => {
    const { run, valueAt, leaks, notices } = boot()
    await run('sheet.command.auto-fill', {
      unitId: 'wb',
      subUnitId: 's',
      sourceRange: cell(1, 1),
      targetRange: area(1, 1, 4, 1),
      applyType: 'COPY',
    })
    expect(leaks()).toEqual([])
    expect(valueAt(2, 1)).toBe('B3')
    expect(notices).toEqual(REFUSED)
  })

  it('refuses Fill Down from it', async () => {
    const { run, select, valueAt, leaks, notices } = boot()
    select(area(1, 1, 3, 1))
    await run('sheet.command.copy-down')
    expect(leaks()).toEqual([])
    expect(valueAt(2, 1)).toBe('B3')
    expect(notices).toEqual(REFUSED)
  })

  it('lets a fill run over it: the new value sits under the same mark', async () => {
    const { run, valueAt, leaks, notices } = boot()
    await run('sheet.command.auto-fill', {
      unitId: 'wb',
      subUnitId: 's',
      sourceRange: cell(0, 1),
      targetRange: area(0, 1, 2, 1),
      applyType: 'COPY',
    })
    expect(valueAt(1, 1)).toBe('B1')
    expect(leaks()).toEqual([])
    expect(notices).toEqual([])
  })
})

describe('undoing an edit after the cell it moved was hidden', () => {
  it('refuses the undo that would carry the value back out', async () => {
    const { run, valueAt, leaks, notices, live } = boot(NO_REDACTIONS)
    await run('sheet.command.move-range', { fromRange: cell(1, 1), toRange: cell(3, 3) })
    expect(valueAt(3, 3)).toBe(SECRET)
    // the person hides the phone number where it is now: D4
    live.index = buildRedactionIndex(
      [{ sheetName: 'Sheet1', marks: [{ ...cell(3, 3), label: 'client phone' }] }],
      SHEETS,
    )
    await run('univer.command.undo')
    expect(leaks()).toEqual([])
    expect(valueAt(3, 3)).toBe(SECRET)
    expect(notices).toEqual(REFUSED)
  })
})

describe('ordinary editing next to hidden cells', () => {
  it('moves, sorts and fills ranges that hold none', async () => {
    const { run, select, valueAt, leaks, notices } = boot()
    await run('sheet.command.move-range', { fromRange: cell(2, 2), toRange: cell(8, 8) })
    expect(valueAt(8, 8)).toBe('C3')
    await run('sheet.command.reorder-range', {
      unitId: 'wb',
      subUnitId: 's',
      range: area(3, 0, 5, 5),
      order: { 3: 5, 4: 4, 5: 3 },
    })
    expect(valueAt(3, 0)).toBe('A6')
    await run('sheet.command.auto-fill', {
      unitId: 'wb',
      subUnitId: 's',
      sourceRange: cell(0, 3),
      targetRange: area(0, 3, 2, 3),
      applyType: 'COPY',
    })
    expect(valueAt(2, 3)).toBe('D1')
    select(cell(4, 4))
    await run('sheet.command.insert-range-move-down')
    expect(valueAt(4, 4)).toBeNull()
    await run('univer.command.undo')
    expect(valueAt(4, 4)).not.toBeNull()
    expect(notices).toEqual([])
    expect(leaks()).toEqual([])
    expect(valueAt(1, 1)).toBe(SECRET)
  })

  it('stays out of the way in a workbook that hides nothing', async () => {
    const { run, valueAt, notices } = boot(NO_REDACTIONS)
    await run('sheet.command.move-range', { fromRange: cell(1, 1), toRange: cell(3, 3) })
    expect(valueAt(3, 3)).toBe(SECRET)
    await run('univer.command.undo')
    expect(valueAt(1, 1)).toBe(SECRET)
    await run('sheet.command.move-rows', MOVE_ROW_2_BELOW_ROW_4)
    expect(valueAt(1, 1)).toBe('B3')
    expect(valueAt(3, 1)).toBe(SECRET)
    expect(notices).toEqual([])
  })
})

describe('pasting what was copied or cut inside the workbook', () => {
  /** Stands in for Univer's clipboard service: its copy cache and the internal paste it runs. */
  function clipboard(copyType: 'COPY' | 'CUT', rows: number[], cols: number[]) {
    const pasted = vi.fn(async () => true)
    const service: InternalPasteService = {
      _pasteInternal: pasted,
      _copyContentCache: {
        get: (id) =>
          id === 'copy-1' ? { subUnitId: 's', range: { rows, cols }, copyType } : undefined,
      },
    }
    const notices: string[] = []
    guardInternalPaste(service, {
      redactions: () => HIDDEN_B2,
      notify: (message) => notices.push(message),
    })
    return { service, pasted, notices }
  }

  it('refuses pasting a copy of the hidden cell: it would be a second, unmarked place', async () => {
    const { service, pasted, notices } = clipboard('COPY', [1], [1])
    expect(await service._pasteInternal('copy-1', 'default-paste')).toBe(false)
    expect(pasted).not.toHaveBeenCalled()
    expect(notices).toEqual(REFUSED)
  })

  it('refuses pasting a copied block that holds it, values only too', async () => {
    const { service, pasted, notices } = clipboard('COPY', [0, 1, 2], [0, 1])
    expect(await service._pasteInternal('copy-1', 'special-paste-value')).toBe(false)
    expect(pasted).not.toHaveBeenCalled()
    expect(notices).toEqual(REFUSED)
  })

  it('refuses pasting the cut cell: the value would leave its mark', async () => {
    const { service, pasted, notices } = clipboard('CUT', [1], [1])
    expect(await service._pasteInternal('copy-1', 'default-paste')).toBe(false)
    expect(pasted).not.toHaveBeenCalled()
    expect(notices).toEqual(REFUSED)
  })

  it('pastes a copy that holds no hidden cell', async () => {
    const { service, pasted, notices } = clipboard('COPY', [2, 3], [0, 1, 2])
    expect(await service._pasteInternal('copy-1', 'default-paste')).toBe(true)
    expect(pasted).toHaveBeenCalledWith('copy-1', 'default-paste')
    expect(notices).toEqual([])
  })

  it('pastes only the formatting of a copied hidden cell: no value travels', async () => {
    const { service, pasted, notices } = clipboard('COPY', [1], [1])
    expect(await service._pasteInternal('copy-1', 'special-paste-format')).toBe(true)
    expect(pasted).toHaveBeenCalledTimes(1)
    expect(notices).toEqual([])
  })

  it('answers the same for the Paste Special dialog', () => {
    expect(pasteSourceHoldsHidden(HIDDEN_B2, { subUnitId: 's', rows: [0, 1], cols: [1] })).toBe(
      true,
    )
    expect(pasteSourceHoldsHidden(HIDDEN_B2, { subUnitId: 's', rows: [0, 2], cols: [1] })).toBe(
      false,
    )
    expect(pasteSourceHoldsHidden(HIDDEN_B2, { subUnitId: 'other', rows: [1], cols: [1] })).toBe(
      false,
    )
  })
})
