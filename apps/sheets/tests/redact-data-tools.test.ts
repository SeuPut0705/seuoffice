// @vitest-environment jsdom
/**
 * A person running a data tool over a cell hidden from AI.
 *
 * These tools are not moves the grid dispatches as one command with a source:
 * the editor reads cells itself and writes what it read, or something worked
 * out from it, into other cells (or into a name). The value then sits where
 * no mark covers it. The grid here is a real Univer workbook and the handlers
 * are the ones the ribbon and the dialogs call; a leak is any cell the AI's
 * read would hand over that shows the hidden number.
 */
import {
  CommandType,
  ICommandService,
  IUniverInstanceService,
  LocaleType,
  LogLevel,
  Univer,
} from '@univerjs/core'
import type { IRange } from '@univerjs/core'
import { UniverDocsPlugin } from '@univerjs/docs'
import { UniverRenderEnginePlugin } from '@univerjs/engine-render'
import { FUniver } from '@univerjs/core/lib/facade'
import { UniverSheetsPlugin } from '@univerjs/sheets'
import '@univerjs/sheets/facade'
import { describe, expect, it, vi } from 'vitest'

import { buildRedactionIndex, type RedactionIndex } from '../src/renderer/ai/redact'
import { redactGuardForOps } from '../src/renderer/ai/redact-guard'
import { applyDataTable } from '../src/renderer/data-table'
import {
  handleCreateConsolidate,
  handleCreateNamesFromSelection,
  handleCreateSubtotal,
  type DataToolsContext,
} from '../src/renderer/data-tools-actions'
import { createEditJournal } from '../src/renderer/edit-journal'
import { applyFillSeries } from '../src/renderer/fill-series-apply'
import { solveGoalSeek } from '../src/renderer/goal-seek'
import { t } from '../src/renderer/i18n/locale'
import { pasteSpecialCarriesWithheld } from '../src/renderer/paste-special'
import { collectPickListValues } from '../src/renderer/pick-from-list'
import { refreshPivotTables, type PivotActionContext } from '../src/renderer/pivot-actions'
import {
  guardInternalPaste,
  installRedactMoveGuard,
  type InternalPasteService,
} from '../src/renderer/redact-move-guard'
import { handleRibbonCommand, type RibbonCommandContext } from '../src/renderer/ribbon-actions'
import type { LazyWorkbookState, UniverRuntime } from '../src/renderer/univer-state'
import { applyAiPivotAdd } from '../src/renderer/workbook-ops'

/** The hidden number, and the part of it any value built from it still shows. */
const SECRET = '13800138000'
const STEM = '138001380'
const REFUSED = t('redactMoveRefused')

type Cell = string | number | { f: string; v?: string | number } | null

const at = (row: number, column: number): IRange => ({
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

/**
 * A workbook with `grid` from A1, `hidden` cells marked, and `dependents`
 * the formula cells that compute from them (what `redact-derived` answers in
 * the app; no formula engine runs here).
 */
function boot(grid: Cell[][], hidden: IRange[], dependents: IRange[] = []) {
  const univer = new Univer({
    logLevel: LogLevel.SILENT,
    locale: LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: {} },
  })
  // ribbon-actions loads the sheets-ui facade, which reads the render manager
  univer.registerPlugin(UniverRenderEnginePlugin)
  univer.registerPlugin(UniverDocsPlugin)
  univer.registerPlugin(UniverSheetsPlugin)
  const univerAPI = FUniver.newAPI(univer)
  const cellData: Record<number, Record<number, object>> = {}
  grid.forEach((line, row) => {
    cellData[row] = {}
    line.forEach((cell, column) => {
      if (cell === null) return
      cellData[row]![column] = typeof cell === 'object' ? cell : { v: cell }
    })
  })
  univerAPI.createWorkbook({
    id: 'wb',
    name: 'tools',
    sheetOrder: ['s'],
    sheets: { s: { id: 's', name: 'Sheet1', rowCount: 30, columnCount: 10, cellData } },
  })
  const injector = univer.__getInjector()
  injector.get(IUniverInstanceService).focusUnit('wb')
  const runtime = { univer, univerAPI } as unknown as UniverRuntime
  const marks = buildRedactionIndex(
    [{ sheetName: 'Sheet1', marks: hidden.map((range) => ({ ...range, label: 'client phone' })) }],
    [{ id: 's', name: 'Sheet1' }],
  )
  const inDependents = (row: number, column: number): boolean =>
    dependents.some(
      (range) =>
        row >= range.startRow &&
        row <= range.endRow &&
        column >= range.startColumn &&
        column <= range.endColumn,
    )
  const index: RedactionIndex = {
    ...marks,
    labelAt: (sheetId, row, column) =>
      marks.labelAt(sheetId, row, column) ?? (inDependents(row, column) ? 'private' : null),
    marksFor: (sheetId) => marks.marksFor(sheetId),
    derivedFor: () => dependents,
  }
  const notices: string[] = []
  installRedactMoveGuard(runtime, {
    redactions: () => index,
    notify: (message) => notices.push(message),
  })
  const worksheet = univerAPI.getActiveWorkbook()!.getActiveSheet()!
  const valueAt = (row: number, column: number) =>
    worksheet.getRange(row, column, 1, 1).getValue() as string | number | null
  /** Every cell the AI may read that shows the hidden number. */
  const leaks = (): string[] => {
    const out: string[] = []
    for (let row = 0; row < 30; row++) {
      for (let column = 0; column < 10; column++) {
        if (index.labelAt('s', row, column) !== null) continue
        if (String(valueAt(row, column) ?? '').includes(STEM)) {
          out.push(`${'ABCDEFGHIJ'[column]}${row + 1}`)
        }
      }
    }
    return out
  }
  const select = (range: IRange) =>
    univerAPI
      .getActiveWorkbook()!
      .setActiveRange(
        worksheet.getRange(
          range.startRow,
          range.startColumn,
          range.endRow - range.startRow + 1,
          range.endColumn - range.startColumn + 1,
        ),
      )
  const messages: string[] = []
  const ctx = {
    univerRef: { current: runtime },
    lazyWorkbookRef: { current: null },
    setMessage: (message: string) => messages.push(message),
    setPendingEdits: () => {},
  } as unknown as RibbonCommandContext & DataToolsContext
  const run = async (id: string, params?: object): Promise<boolean> => {
    try {
      return (await injector.get(ICommandService).executeCommand(id, params)) === true
    } catch {
      return false
    }
  }
  const commands = injector.get(ICommandService)
  return {
    runtime,
    univerAPI,
    ctx,
    index,
    valueAt,
    leaks,
    notices,
    messages,
    select,
    run,
    commands,
  }
}

describe('Remove Duplicates', () => {
  // row 2 repeats row 1; removing it pulls the row with the hidden phone up
  const GRID: Cell[][] = [
    ['Kim', '555'],
    ['Kim', '555'],
    ['Lee', SECRET],
  ]

  it('is refused when the range holds a hidden cell', () => {
    const { ctx, select, valueAt, leaks, notices } = boot(GRID, [at(2, 1)])
    select(area(0, 0, 2, 1))
    handleRibbonCommand(ctx, 'remove-duplicates:0')
    expect(leaks()).toEqual([])
    expect(valueAt(1, 1)).toBe('555')
    expect(notices).toEqual([REFUSED])
  })

  it('still runs on a range without one', () => {
    const { ctx, select, valueAt, notices } = boot(GRID, [at(9, 9)])
    select(area(0, 0, 2, 1))
    handleRibbonCommand(ctx, 'remove-duplicates:0')
    expect(valueAt(1, 0)).toBe('Lee')
    expect(notices).toEqual([])
  })

  it('is refused over a formula that computes from a hidden cell: its value would be written down', () => {
    const { ctx, select, notices } = boot(GRID, [at(9, 9)], [at(2, 1)])
    select(area(0, 0, 2, 1))
    handleRibbonCommand(ctx, 'remove-duplicates:0')
    expect(notices).toEqual([REFUSED])
  })
})

describe('Flash Fill', () => {
  it('is refused when a column it reads from holds a hidden cell', () => {
    // B1 shows the pattern (copy column A); filling B2 would write A2's number
    const { ctx, select, leaks, notices } = boot([['abc', 'abc'], [SECRET], ['def']], [at(1, 0)])
    select(area(0, 1, 2, 1))
    handleRibbonCommand(ctx, 'flash-fill')
    expect(leaks()).toEqual([])
    expect(notices).toEqual([REFUSED])
  })

  it('still fills from columns without one', () => {
    const { ctx, select, valueAt, notices } = boot([['abc', 'abc'], ['xyz'], ['def']], [at(9, 9)])
    select(area(0, 1, 2, 1))
    handleRibbonCommand(ctx, 'flash-fill')
    expect(valueAt(1, 1)).toBe('xyz')
    expect(notices).toEqual([])
  })
})

describe('Copy the cell above (Ctrl+\' and Ctrl+Shift+")', () => {
  it.each(['copy-above:value', 'copy-above:formula'])(
    '%s is refused under a hidden cell',
    (command) => {
      const { ctx, select, leaks, notices } = boot([['Phone'], [SECRET], [null]], [at(1, 0)])
      select(at(2, 0))
      handleRibbonCommand(ctx, command)
      expect(leaks()).toEqual([])
      expect(notices).toEqual([REFUSED])
    },
  )

  it('still copies an ordinary cell', () => {
    const { ctx, select, valueAt } = boot([['Phone'], ['none'], [null]], [at(9, 9)])
    select(at(2, 0))
    handleRibbonCommand(ctx, 'copy-above:value')
    expect(valueAt(2, 0)).toBe('none')
  })
})

describe('Subtotal', () => {
  it('is refused when the column it groups by holds a hidden cell: the total row is named after it', () => {
    const { ctx, select, leaks } = boot(
      [
        ['Phone', 'Amount'],
        [SECRET, 10],
        [SECRET, 20],
        ['555', 5],
      ],
      [area(1, 0, 2, 0)],
    )
    select(area(0, 0, 3, 1))
    expect(handleCreateSubtotal(ctx, { groupCol: 0, valueCol: 1, agg: 'sum' })).toBe(REFUSED)
    expect(leaks()).toEqual([])
  })

  it('still runs when only the summed column is hidden: the totals are formulas over it', () => {
    const { ctx, select, valueAt, leaks } = boot(
      [
        ['Team', 'Pay'],
        ['a', 13800138000],
        ['b', 5],
      ],
      [at(1, 1)],
    )
    select(area(0, 0, 2, 1))
    expect(handleCreateSubtotal(ctx, { groupCol: 0, valueCol: 1, agg: 'sum' })).toBeNull()
    expect(valueAt(2, 0)).toBe('a Total')
    expect(leaks()).toEqual([])
  })
})

describe('Consolidate by left labels', () => {
  it('is refused when a label column holds a hidden cell: labels are copied as text', () => {
    const { ctx, select, leaks } = boot(
      [
        ['Kim', 1],
        [SECRET, 2],
      ],
      [at(1, 0)],
    )
    select(at(0, 4))
    expect(
      handleCreateConsolidate(ctx, { fn: 'sum', references: ['Sheet1!A1:B2'], leftLabels: true }),
    ).toBe(REFUSED)
    expect(leaks()).toEqual([])
  })

  it('still runs when only the numbers are hidden: they are reached through formulas', () => {
    const { ctx, select, valueAt, leaks } = boot(
      [
        ['Kim', 1],
        ['Lee', 13800138000],
      ],
      [at(1, 1)],
    )
    select(at(0, 4))
    expect(
      handleCreateConsolidate(ctx, { fn: 'sum', references: ['Sheet1!A1:B2'], leftLabels: true }),
    ).toBeNull()
    expect(valueAt(1, 4)).toBe('Lee')
    expect(leaks()).toEqual([])
  })
})

describe('Fill Series', () => {
  it('is refused when a seed is hidden: the series continues its number', () => {
    const { runtime, select, leaks } = boot([[13800138000], [null], [null]], [at(0, 0)])
    select(area(0, 0, 2, 0))
    const result = applyFillSeries(
      runtime,
      { direction: 'columns', type: 'linear', dateUnit: 'day', trend: false, step: 1, stop: null },
      t,
    )
    expect(result).toBe(REFUSED)
    expect(leaks()).toEqual([])
  })
})

describe('Create Names from Selection', () => {
  it('is refused when a label is hidden: the name would be made of its text', () => {
    const { ctx, univerAPI, select, notices } = boot(
      [
        ['Kim', 1],
        [SECRET, 2],
      ],
      [at(1, 0)],
    )
    select(area(0, 0, 1, 1))
    handleCreateNamesFromSelection(ctx, 'left')
    const names = univerAPI
      .getActiveWorkbook()!
      .getDefinedNames()
      .map((name) => name.getName())
    expect(names.filter((name) => name.includes(STEM))).toEqual([])
    expect(names).toEqual([])
    expect(notices).toEqual([REFUSED])
  })
})

describe('Goal Seek and Data Table', () => {
  // C1 computes from the hidden B1; what these tools write is worked out from C1
  const GRID: Cell[][] = [[2, 13800138000, { f: '=A1*B1' }], [1], [2]]

  it('Goal Seek is refused on a formula that computes from a hidden cell', async () => {
    const { runtime, valueAt } = boot(GRID, [at(0, 1)], [at(0, 2)])
    await expect(
      solveGoalSeek(runtime, { setCell: 'C1', toValue: 100, byCell: 'A1' }),
    ).rejects.toThrow(REFUSED)
    expect(valueAt(0, 0)).toBe(2)
  })

  it('a Data Table is refused when its formula computes from a hidden cell', async () => {
    // column table B1:C3: inputs in B2:B3, the formula in C1
    const { runtime, leaks } = boot(
      [
        [2, null, { f: '=A1*E1' }, null, 13800138000],
        [null, 1],
        [null, 2],
      ],
      [at(0, 4)],
      [at(0, 2)],
    )
    await expect(
      applyDataTable(runtime, { tableRange: 'B1:C3', rowInputCell: null, columnInputCell: 'A1' }),
    ).rejects.toThrow(REFUSED)
    expect(leaks()).toEqual([])
  })
})

describe('Pick From Drop-down List', () => {
  it('does not offer the value of a hidden cell, and still lists the cells around it', () => {
    const column = ['Kim', SECRET, 'Lee', '']
    const read = (row: number) => (column[row] ? { display: column[row]!, cell: null } : null)
    const withheld = (row: number) => row === 1
    expect(collectPickListValues(read, 3, 4, withheld).map((entry) => entry.display)).toEqual([
      'Kim',
      'Lee',
    ])
    expect(collectPickListValues(read, 3, 4).map((entry) => entry.display)).toEqual([
      SECRET,
      'Kim',
      'Lee',
    ])
  })
})

describe('PivotTable', () => {
  const GRID: Cell[][] = [
    ['Phone', 'Amount'],
    [SECRET, 10],
    ['555', 5],
  ]

  it('is not built from a source that holds a hidden cell: its labels and totals are plain cells', () => {
    const { runtime, leaks } = boot(GRID, [at(1, 0)])
    const state = { editJournal: createEditJournal() } as unknown as LazyWorkbookState
    expect(() =>
      applyAiPivotAdd(runtime, state, {
        op: 'add_pivot',
        sheetId: 's',
        sourceRange: 'A1:B3',
        targetCell: 'E1',
        rowFieldIndices: [0],
        values: [{ fieldIndex: 1, aggregation: 'sum' }],
      } as unknown as Parameters<typeof applyAiPivotAdd>[2]),
    ).toThrow(REFUSED)
    expect(leaks()).toEqual([])
  })

  it('is refused to the AI before any of its plan runs', () => {
    const { index } = boot(GRID, [at(1, 0)])
    const refusal = redactGuardForOps(
      [{ op: 'add_pivot', sheetId: 's', sourceRange: 'A1:B3', targetCell: 'E1' }],
      index,
    )
    expect(refusal?.where).toBe('A2')
    expect(
      redactGuardForOps([{ op: 'add_pivot', sheetId: 's', sourceRange: 'A3:B3' }], index),
    ).toBeNull()
  })

  it('is not refreshed from a source that holds a hidden cell', () => {
    const { runtime, leaks } = boot(GRID, [at(1, 0)])
    const state = {
      formulaMode: true,
      flags: { preloadComplete: true },
      editJournal: createEditJournal(),
      file: {
        sheets: [{ id: 's', pivotTables: [{ path: 'p', cachePath: null }], pivotRanges: [] }],
      },
      pivotDefinitions: new Map([
        ['p', { sourceSheet: 'Sheet1', sourceRef: 'A1:B3', outputRef: 'E1:F4' }],
      ]),
    } as unknown as LazyWorkbookState
    const ctx = {
      univerRef: { current: runtime },
      lazyWorkbookRef: { current: state },
    } as unknown as PivotActionContext
    expect(() => refreshPivotTables(ctx, 's')).toThrow(REFUSED)
    expect(leaks()).toEqual([])
  })
})

describe('Merge Cells', () => {
  it('is refused over a hidden cell: the merge moves the first filled cell to the top-left', async () => {
    // A1 is empty, so the merged cell would show B1's number at A1
    const { run, valueAt, leaks, notices } = boot([[null, SECRET]], [at(0, 1)])
    await run('sheet.command.add-worksheet-merge', {
      unitId: 'wb',
      subUnitId: 's',
      selections: [area(0, 0, 0, 1)],
      defaultMerge: true,
    })
    expect(leaks()).toEqual([])
    expect(valueAt(0, 0)).toBeNull()
    expect(notices).toEqual([REFUSED])
  })

  it('still merges a range without one', async () => {
    const { run, valueAt, notices } = boot([[null, 'title']], [at(9, 9)])
    await run('sheet.command.add-worksheet-merge', {
      unitId: 'wb',
      subUnitId: 's',
      selections: [area(0, 0, 0, 1)],
      defaultMerge: true,
    })
    expect(valueAt(0, 0)).toBe('title')
    expect(notices).toEqual([])
  })
})

describe('table rows and columns (the table plug-in shifts the cells around the table)', () => {
  const IDS = [
    'sheet.command.table-insert-row',
    'sheet.command.table-insert-col',
    'sheet.command.table-remove-row',
    'sheet.command.table-remove-col',
    'sheet.command.table-insert-row-at',
    'sheet.command.table-insert-column-at',
    'sheet.command.table-remove-column-at',
  ]

  /** The command stands in for the plug-in's: what matters is whether it gets to run. */
  function withCommand(id: string, hidden: IRange[]) {
    const booted = boot([['a', SECRET]], hidden)
    const ran = vi.fn(() => true)
    booted.commands.registerCommand({ id, type: CommandType.COMMAND, handler: ran })
    return { ...booted, ran }
  }

  it.each(IDS)('%s does not run on a sheet that holds a hidden cell', async (id) => {
    const { run, ran, notices } = withCommand(id, [at(0, 1)])
    await run(id, { unitId: 'wb', subUnitId: 's', tableId: 't' })
    expect(ran).not.toHaveBeenCalled()
    expect(notices).toEqual([REFUSED])
  })

  it('runs on a sheet without one', async () => {
    const { run, ran, notices } = withCommand(IDS[0]!, [])
    await run(IDS[0]!, { unitId: 'wb', subUnitId: 's', tableId: 't' })
    expect(ran).toHaveBeenCalledTimes(1)
    expect(notices).toEqual([])
  })
})

describe('writing down the value of a formula that computes from a hidden cell', () => {
  // C1 = a formula over the hidden B1: withheld as a formula, the hidden value once it is a constant
  const GRID: Cell[][] = [['x', SECRET, { f: '=B1', v: `a,${SECRET}` }]]

  it('Text to Columns is refused on it', async () => {
    const { run, leaks, notices } = boot(GRID, [at(0, 1)], [at(0, 2)])
    await run('sheet.command.split-text-to-columns', {
      unitId: 'wb',
      subUnitId: 's',
      range: at(0, 2),
      delimiter: 2,
    })
    expect(leaks()).toEqual([])
    expect(notices).toEqual([REFUSED])
  })

  /** Stands in for Univer's clipboard service: one remembered copy of C1. */
  function pasteOf(index: RedactionIndex) {
    const pasted = vi.fn(async () => true)
    const service: InternalPasteService = {
      _pasteInternal: pasted,
      _copyContentCache: {
        get: () => ({ subUnitId: 's', range: { rows: [0], cols: [2] }, copyType: 'copy' }),
      },
    }
    const notices: string[] = []
    guardInternalPaste(service, { redactions: () => index, notify: (m) => notices.push(m) })
    return { service, pasted, notices }
  }

  it('Paste Values is refused on it, an ordinary paste keeps the formula and goes through', async () => {
    const { index } = boot(GRID, [at(0, 1)], [at(0, 2)])
    const { service, pasted, notices } = pasteOf(index)
    expect(await service._pasteInternal('copy', 'special-paste-value')).toBe(false)
    expect(pasted).not.toHaveBeenCalled()
    expect(notices).toEqual([REFUSED])
    expect(await service._pasteInternal('copy', 'default-paste')).toBe(true)
    expect(await service._pasteInternal('copy', 'special-paste-formula')).toBe(true)
  })

  it('the Paste Special dialog refuses the kinds that write its value', () => {
    const { index } = boot(GRID, [at(0, 1)], [at(0, 2)])
    const copy = {
      kind: 'internal',
      unitId: 'wb',
      subUnitId: 's',
      rows: [0],
      cols: [2],
      cut: false,
    }
    const options = { operation: 'none', skipBlanks: false, transpose: false, link: false }
    const carries = (overrides: object) =>
      pasteSpecialCarriesWithheld(
        index,
        copy as Parameters<typeof pasteSpecialCarriesWithheld>[1],
        { type: 'all', ...options, ...overrides } as Parameters<
          typeof pasteSpecialCarriesWithheld
        >[2],
      )
    expect(carries({ type: 'values' })).toBe(true)
    expect(carries({ type: 'values-numfmt' })).toBe(true)
    expect(carries({ transpose: true })).toBe(true)
    expect(carries({ operation: 'add' })).toBe(true)
    // these leave a formula behind, which stays withheld where it lands
    expect(carries({ type: 'all' })).toBe(false)
    expect(carries({ type: 'formulas' })).toBe(false)
    expect(carries({ link: true })).toBe(false)
    expect(carries({ type: 'formats' })).toBe(false)
  })

  it('the dialog still refuses every value paste of the hidden cell itself', () => {
    const { index } = boot(GRID, [at(0, 1)], [at(0, 2)])
    const copy = {
      kind: 'internal',
      unitId: 'wb',
      subUnitId: 's',
      rows: [0],
      cols: [1],
      cut: false,
    }
    const options = { operation: 'none', skipBlanks: false, transpose: false }
    const carries = (overrides: object) =>
      pasteSpecialCarriesWithheld(
        index,
        copy as Parameters<typeof pasteSpecialCarriesWithheld>[1],
        { type: 'all', link: false, ...options, ...overrides } as Parameters<
          typeof pasteSpecialCarriesWithheld
        >[2],
      )
    expect(carries({ type: 'all' })).toBe(true)
    expect(carries({ type: 'formulas' })).toBe(true)
    expect(carries({ link: true })).toBe(true)
    expect(carries({ type: 'formats' })).toBe(false)
    expect(
      pasteSpecialCarriesWithheld(index, { kind: 'text', rows: [[SECRET]], withheld: true }, {
        type: 'all',
        link: false,
        ...options,
      } as Parameters<typeof pasteSpecialCarriesWithheld>[2]),
    ).toBe(true)
  })
})
