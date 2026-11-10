/**
 * Which Univer mutations co-editing sends, and how each one is undone.
 *
 * A local edit travels as the mutations its command executed. When a remote
 * change arrives the adapter reverts the edits the server has not confirmed,
 * applies the remote mutations and replays its own. That is only correct when
 * the revert is exact, so a mutation is sent only when this table can compute,
 * right before it runs, the mutations that put back everything it changes
 * (its inverse). Everything else a person could trigger is blocked in
 * co-editing; derived mutations (formula results, `onlyLocal` reactions, file
 * loads) are recomputed by every page and never sent.
 *
 * Style ids are page-local (`Styles.add` draws random ids), so on the wire a
 * cell's `s` is always the style object; a page turns it back into its own id
 * before a mutation that stores `s` verbatim runs.
 */
import {
  type ICellData,
  type IRange,
  type IStyleData,
  type Workbook,
  type Worksheet,
  IUniverInstanceService,
  Tools,
  UniverInstanceType,
} from '@univerjs/core'
import { IDefinedNamesService } from '@univerjs/engine-formula'
import {
  factoryRemoveNumfmtUndoMutation,
  factorySetNumfmtUndoMutation,
  MoveColsMutationUndoFactory,
  MoveRowsMutationUndoFactory,
  ReorderRangeUndoMutationFactory,
  SetFrozenMutationFactory,
  SetWorksheetDefaultStyleMutationFactory,
} from '@univerjs/sheets'

export type Params = Record<string, unknown>

/** One mutation as `ICommandService` runs it */
export interface Mutation {
  readonly id: string
  readonly params: Params
}

/** What computing an inverse may read: the injector and the co-edited workbook */
export interface MutationEnv {
  readonly accessor: { get<T>(id: unknown): T }
  readonly workbook: Workbook
}

interface Synced {
  /** the mutations that restore what `params` is about to change; read before it runs */
  inverse(env: MutationEnv, params: Params): Mutation[]
  /** objects in `params` whose `s` may be a style id */
  styled?(params: Params): Record<string, unknown>[]
  /** the handler merges an `s` object into the cell's style; otherwise it stores `s` as given */
  mergesStyle?: true
}

export const SET_RANGE_VALUES = 'sheet.mutation.set-range-values'
export const INSERT_ROW = 'sheet.mutation.insert-row'
export const INSERT_COL = 'sheet.mutation.insert-col'
export const REMOVE_ROWS = 'sheet.mutation.remove-rows'
export const REMOVE_COL = 'sheet.mutation.remove-col'
export const MOVE_ROWS = 'sheet.mutation.move-rows'
export const MOVE_COLS = 'sheet.mutation.move-columns'
export const MOVE_RANGE = 'sheet.mutation.move-range'
export const REORDER_RANGE = 'sheet.mutation.reorder-range'
export const ADD_MERGE = 'sheet.mutation.add-worksheet-merge'
export const REMOVE_MERGE = 'sheet.mutation.remove-worksheet-merge'
export const SET_ROW_DATA = 'sheet.mutation.set-row-data'
export const SET_COL_DATA = 'sheet.mutation.set-col-data'
export const SET_ROW_HEIGHT = 'sheet.mutation.set-worksheet-row-height'
export const SET_ROW_IS_AUTO_HEIGHT = 'sheet.mutation.set-worksheet-row-is-auto-height'
export const SET_ROW_AUTO_HEIGHT = 'sheet.mutation.set-worksheet-row-auto-height'
export const SET_ROW_HIDDEN = 'sheet.mutation.set-row-hidden'
export const SET_ROW_VISIBLE = 'sheet.mutation.set-row-visible'
export const SET_COL_WIDTH = 'sheet.mutation.set-worksheet-col-width'
export const SET_COL_HIDDEN = 'sheet.mutation.set-col-hidden'
export const SET_COL_VISIBLE = 'sheet.mutation.set-col-visible'
export const SET_ROW_COUNT = 'sheet.mutation.set-worksheet-row-count'
export const SET_COLUMN_COUNT = 'sheet.mutation.set-worksheet-column-count'
export const SET_NUMFMT = 'sheet.mutation.set.numfmt'
export const REMOVE_NUMFMT = 'sheet.mutation.remove.numfmt'
export const INSERT_SHEET = 'sheet.mutation.insert-sheet'
export const REMOVE_SHEET = 'sheet.mutation.remove-sheet'
export const SET_SHEET_NAME = 'sheet.mutation.set-worksheet-name'
export const SET_SHEET_ORDER = 'sheet.mutation.set-worksheet-order'
export const SET_SHEET_HIDDEN = 'sheet.mutation.set-worksheet-hidden'
export const SET_TAB_COLOR = 'sheet.mutation.set-tab-color'
export const SET_FROZEN = 'sheet.mutation.set-frozen'
export const TOGGLE_GRIDLINES = 'sheet.mutation.toggle-gridlines'
export const SET_GRIDLINES_COLOR = 'sheet.mutation.set-gridlines-color'
export const SET_RIGHT_TO_LEFT = 'sheet.mutation.set-worksheet-right-to-left'
export const SET_DEFAULT_STYLE = 'sheet.mutation.set-worksheet-default-style'
export const SET_DEFINED_NAME = 'formula.mutation.set-defined-name'
export const REMOVE_DEFINED_NAME = 'formula.mutation.remove-defined-name'

/**
 * Mutations every page derives for itself from the synced state or from the
 * engine, whatever the execution options say: the formula engine's control
 * and result channel, and popups that are view state.
 */
const DERIVED = new Set([
  'formula.mutation.register-function',
  'formula.mutation.set-array-formula-data',
  'formula.mutation.set-formula-data',
  'formula.mutation.set-feature-calculation',
  'formula.mutation.remove-feature-calculation',
  'formula.mutation.set-formula-calculation-start',
  'formula.mutation.set-trigger-formula-calculation-start',
  'formula.mutation.set-formula-string-batch-calculation',
  'formula.mutation.set-formula-string-batch-calculation-result',
  'formula.mutation.set-formula-calculation-stop',
  'formula.mutation.set-formula-calculation-notification',
  'formula.mutation.set-formula-calculation-result',
  'formula.mutation.set-formula-dependency-calculation',
  'formula.mutation.set-formula-dependency-calculation-result',
  'formula.mutation.set-cell-formula-dependency-calculation',
  'formula.mutation.set-cell-formula-dependency-calculation-result',
  'formula.mutation.set-qualified-formula-string-calculation',
  'formula.mutation.set-qualified-formula-string-calculation-result',
  'formula.mutation.set-other-formula',
  'formula.mutation.remove-other-formula',
  'formula.mutation.set-super-table',
  'formula.mutation.remove-super-table',
  'formula.mutation.set-image-formula-data',
  'formula.mutation.clear-image-formula-data',
  'sheet.mutation.toggle-note-popup',
  'sheet.mutation.mark-dirty-filter-change',
  'sheet.mutation.copy-worksheet-end',
])

export type MutationClass = 'synced' | 'derived' | 'blocked'

/** `options` are the execution options the mutation runs with */
export function classify(
  id: string,
  options: { onlyLocal?: boolean; fromFormula?: boolean } | undefined,
): MutationClass {
  if (options?.onlyLocal || options?.fromFormula || DERIVED.has(id)) return 'derived'
  return SYNCED.has(id) ? 'synced' : 'blocked'
}

export function isSynced(id: string): boolean {
  return SYNCED.has(id)
}

export function isDerivedId(id: string): boolean {
  return DERIVED.has(id)
}

/** Every mutation id this table sends, for the classification report */
export function syncedIds(): string[] {
  return [...SYNCED.keys()]
}

export function derivedIds(): string[] {
  return [...DERIVED]
}

export function inverseOf(env: MutationEnv, mutation: Mutation): Mutation[] {
  const entry = SYNCED.get(mutation.id)
  if (!entry) throw new Error(`co-editing cannot undo ${mutation.id}`)
  return entry.inverse(env, mutation.params)
}

/**
 * The wire form: no unit id, style objects instead of this page's style ids.
 * `trigger` (the command that ran the mutation) stays: Univer's listeners
 * react to a mutation by it, and sheets-formula drops the formula of every
 * cell a set-range-values without a style trigger touches.
 */
export function toWire(workbook: Workbook, mutation: Mutation): Mutation {
  const params = Tools.deepClone(mutation.params)
  delete params.unitId
  const styles = workbook.getStyles()
  for (const holder of SYNCED.get(mutation.id)?.styled?.(params) ?? []) {
    if (typeof holder.s !== 'string') continue
    const style = styles.get(holder.s)
    if (style) holder.s = Tools.deepClone(style)
    else delete holder.s
  }
  return { id: mutation.id, params }
}

/** The local form of a wire mutation, ready to execute in `workbook` */
export function fromWire(workbook: Workbook, mutation: Mutation): Mutation {
  const entry = SYNCED.get(mutation.id)
  if (!entry) throw new Error(`co-editing does not apply ${mutation.id}`)
  const params = Tools.deepClone(mutation.params)
  params.unitId = workbook.getUnitId()
  if (!entry.mergesStyle) {
    const styles = workbook.getStyles()
    for (const holder of entry.styled?.(params) ?? []) {
      if (holder.s && typeof holder.s === 'object')
        holder.s = styles.setValue(holder.s as IStyleData)
    }
  }
  return { id: mutation.id, params }
}

type CellMatrix = Record<string, Record<string, ICellData | null | undefined> | undefined>

function cellsOf(matrix: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  if (!matrix || typeof matrix !== 'object') return out
  for (const row of Object.values(matrix as CellMatrix)) {
    if (!row || typeof row !== 'object') continue
    for (const cell of Object.values(row))
      if (cell && typeof cell === 'object') out.push(cell as Record<string, unknown>)
  }
  return out
}

function valuesOf(record: unknown): Record<string, unknown>[] {
  if (!record || typeof record !== 'object') return []
  return Object.values(record as Record<string, unknown>).filter(
    (value): value is Record<string, unknown> => !!value && typeof value === 'object',
  )
}

function sheetOf(env: MutationEnv, params: Params): Worksheet {
  const sheet = env.workbook.getSheetBySheetId(String(params.subUnitId))
  if (!sheet) throw new Error(`no sheet ${String(params.subUnitId)}`)
  return sheet
}

const unitOf = (env: MutationEnv): string => env.workbook.getUnitId()

function mutation(id: string, params: Params): Mutation {
  return { id, params }
}

/**
 * Put back the cells at `keys` exactly: clear them, then set the old cells.
 * Setting alone would merge the old style into the current one, so a style key
 * the forward edit added would survive.
 */
function restoreCells(
  env: MutationEnv,
  subUnitId: string,
  keys: Iterable<[number, number]>,
): Mutation[] {
  const sheet = env.workbook.getSheetBySheetId(subUnitId)
  if (!sheet) throw new Error(`no sheet ${subUnitId}`)
  const matrix = sheet.getCellMatrix()
  const clear: CellMatrix = {}
  const restore: CellMatrix = {}
  let restored = false
  for (const [row, column] of keys) {
    ;(clear[row] ??= {})[column] = null
    const old = matrix.getValue(row, column)
    if (old && !Tools.isEmptyObject(old)) {
      ;(restore[row] ??= {})[column] = Tools.deepClone(old)
      restored = true
    }
  }
  const unitId = unitOf(env)
  const out = [mutation(SET_RANGE_VALUES, { unitId, subUnitId, cellValue: clear })]
  if (restored) out.push(mutation(SET_RANGE_VALUES, { unitId, subUnitId, cellValue: restore }))
  return out
}

function* matrixKeys(matrix: unknown): Generator<[number, number]> {
  if (!matrix || typeof matrix !== 'object') return
  for (const [row, columns] of Object.entries(matrix as CellMatrix)) {
    if (!columns) continue
    for (const column of Object.keys(columns)) yield [Number(row), Number(column)]
  }
}

function* rangeKeys(
  sheet: Worksheet,
  range: IRange,
  axis: 'row' | 'col',
): Generator<[number, number]> {
  const matrix = sheet.getCellMatrix().getMatrix() as CellMatrix
  for (const [row, columns] of Object.entries(matrix)) {
    if (!columns) continue
    const r = Number(row)
    for (const column of Object.keys(columns)) {
      const c = Number(column)
      if (
        axis === 'row'
          ? r >= range.startRow && r <= range.endRow
          : c >= range.startColumn && c <= range.endColumn
      )
        yield [r, c]
    }
  }
}

/** Put back the row (or column) objects at `indexes` exactly: drop each, then assign the old one */
function restoreLines(
  env: MutationEnv,
  subUnitId: string,
  axis: 'row' | 'col',
  indexes: Iterable<number>,
): Mutation[] {
  const sheet = env.workbook.getSheetBySheetId(subUnitId)
  if (!sheet) throw new Error(`no sheet ${subUnitId}`)
  const data =
    axis === 'row'
      ? (sheet.getRowManager().getRowData() as Record<number, object | undefined>)
      : (sheet.getColumnManager().getColumnData() as Record<number, object | undefined>)
  const drop: Record<number, null> = {}
  const restore: Record<number, object> = {}
  let restored = false
  for (const index of indexes) {
    drop[index] = null
    const old = data[index]
    if (old && Object.keys(old).length > 0) {
      restore[index] = Tools.deepClone(old)
      restored = true
    }
  }
  const unitId = unitOf(env)
  const id = axis === 'row' ? SET_ROW_DATA : SET_COL_DATA
  const key = axis === 'row' ? 'rowData' : 'columnData'
  const out = [mutation(id, { unitId, subUnitId, [key]: drop })]
  if (restored) out.push(mutation(id, { unitId, subUnitId, [key]: restore }))
  return out
}

function* rangeLines(ranges: unknown, axis: 'row' | 'col'): Generator<number> {
  for (const range of (ranges ?? []) as IRange[]) {
    const start = axis === 'row' ? range.startRow : range.startColumn
    const end = axis === 'row' ? range.endRow : range.endColumn
    for (let index = start; index <= end; index++) yield index
  }
}

function* keysOf(record: unknown): Generator<number> {
  for (const key of Object.keys((record ?? {}) as object)) yield Number(key)
}

const linesOfRanges = (axis: 'row' | 'col'): Synced => ({
  inverse: (env, params) =>
    restoreLines(env, String(params.subUnitId), axis, rangeLines(params.ranges, axis)),
})

/** A sheet setting the mutation replaces whole: its inverse is the same mutation with the old value */
function sheetSetting(
  id: string,
  param: string,
  read: (sheet: Worksheet) => unknown,
): [string, Synced] {
  return [
    id,
    {
      inverse: (env, params) => [mutation(id, { ...params, [param]: read(sheetOf(env, params)) })],
    },
  ]
}

/**
 * Put back the sheet's merges exactly. Univer's MergeCellController shifts
 * merges outside the moved lines on every move mutation without a mutation of
 * its own, so a reverse move alone does not restore them.
 */
function restoreMerges(env: MutationEnv, params: Params): Mutation[] {
  const sheet = sheetOf(env, params)
  // merges can outlive the grid (a column removal shrinks the count, not the merges past it)
  const whole = {
    startRow: 0,
    endRow: Number.MAX_SAFE_INTEGER,
    startColumn: 0,
    endColumn: Number.MAX_SAFE_INTEGER,
  }
  const unitId = unitOf(env)
  return [
    mutation(REMOVE_MERGE, { unitId, subUnitId: params.subUnitId, ranges: [whole] }),
    mutation(ADD_MERGE, {
      unitId,
      subUnitId: params.subUnitId,
      ranges: Tools.deepClone(sheet.getConfig().mergeData),
    }),
  ]
}

function oneLines(sheet: Worksheet, range: IRange, axis: 'row' | 'col'): Record<number, object> {
  const data =
    axis === 'row'
      ? (sheet.getRowManager().getRowData() as Record<number, object | undefined>)
      : (sheet.getColumnManager().getColumnData() as Record<number, object | undefined>)
  const start = axis === 'row' ? range.startRow : range.startColumn
  const end = axis === 'row' ? range.endRow : range.endColumn
  const info: Record<number, object> = {}
  for (let index = start; index <= end; index++) {
    const line = data[index]
    if (line && Object.keys(line).length > 0) info[index - start] = Tools.deepClone(line)
  }
  return info
}

const SYNCED_ENTRIES: [string, Synced][] = [
  [
    SET_RANGE_VALUES,
    {
      inverse: (env, params) =>
        restoreCells(env, String(params.subUnitId), matrixKeys(params.cellValue)),
      styled: (params) => cellsOf(params.cellValue),
      mergesStyle: true,
    },
  ],
  [
    MOVE_RANGE,
    {
      inverse: (env, params) => {
        const from = params.from as { subUnitId: string; value: CellMatrix }
        const to = params.to as { subUnitId: string; value: CellMatrix }
        const read = (subUnitId: string, value: CellMatrix): CellMatrix => {
          const matrix = env.workbook.getSheetBySheetId(subUnitId)?.getCellMatrix()
          if (!matrix) throw new Error(`no sheet ${subUnitId}`)
          const old: CellMatrix = {}
          for (const [row, column] of matrixKeys(value)) {
            const cell = matrix.getValue(row, column)
            ;(old[row] ??= {})[column] = cell ? Tools.deepClone(cell) : null
          }
          return old
        }
        return [
          mutation(MOVE_RANGE, {
            ...params,
            from: { ...from, value: read(from.subUnitId, from.value) },
            to: { ...to, value: read(to.subUnitId, to.value) },
          }),
        ]
      },
      styled: (params) => [
        ...cellsOf((params.from as { value?: unknown } | undefined)?.value),
        ...cellsOf((params.to as { value?: unknown } | undefined)?.value),
      ],
    },
  ],
  [
    REORDER_RANGE,
    {
      inverse: (_env, params) => [
        mutation(REORDER_RANGE, ReorderRangeUndoMutationFactory(params as never) as never),
      ],
    },
  ],
  // Univer shifts the merges below an inserted or removed line in reaction to the mutation and
  // keeps those inside a removed one, so only a full restore of the merges is exact
  [
    INSERT_ROW,
    {
      inverse: (env, params) => [
        mutation(REMOVE_ROWS, {
          unitId: params.unitId,
          subUnitId: params.subUnitId,
          range: params.range,
        }),
        ...restoreMerges(env, params),
      ],
      styled: (params) => valuesOf(params.rowInfo),
    },
  ],
  [
    INSERT_COL,
    {
      inverse: (env, params) => [
        mutation(REMOVE_COL, {
          unitId: params.unitId,
          subUnitId: params.subUnitId,
          range: params.range,
        }),
        ...restoreMerges(env, params),
      ],
      styled: (params) => valuesOf(params.colInfo),
    },
  ],
  [
    REMOVE_ROWS,
    {
      inverse: (env, params) => {
        const sheet = sheetOf(env, params)
        const range = params.range as IRange
        const insert = mutation(INSERT_ROW, {
          unitId: unitOf(env),
          subUnitId: params.subUnitId,
          range: { ...range },
          rowInfo: oneLines(sheet, range, 'row'),
        })
        return [
          insert,
          ...restoreCells(env, String(params.subUnitId), rangeKeys(sheet, range, 'row')).slice(1),
          ...restoreMerges(env, params),
        ]
      },
    },
  ],
  [
    REMOVE_COL,
    {
      inverse: (env, params) => {
        const sheet = sheetOf(env, params)
        const range = params.range as IRange
        const insert = mutation(INSERT_COL, {
          unitId: unitOf(env),
          subUnitId: params.subUnitId,
          range: { ...range },
          colInfo: oneLines(sheet, range, 'col'),
        })
        return [
          insert,
          ...restoreCells(env, String(params.subUnitId), rangeKeys(sheet, range, 'col')).slice(1),
          ...restoreMerges(env, params),
        ]
      },
    },
  ],
  [
    MOVE_ROWS,
    {
      inverse: (env, params) => [
        mutation(
          MOVE_ROWS,
          MoveRowsMutationUndoFactory(env.accessor as never, params as never) as never,
        ),
        ...restoreMerges(env, params),
      ],
    },
  ],
  [
    MOVE_COLS,
    {
      inverse: (env, params) => [
        mutation(
          MOVE_COLS,
          MoveColsMutationUndoFactory(env.accessor as never, params as never) as never,
        ),
        ...restoreMerges(env, params),
      ],
    },
  ],
  // removing a merge takes every merge that touches the range, so either way only a full restore is exact
  [ADD_MERGE, { inverse: restoreMerges }],
  [REMOVE_MERGE, { inverse: restoreMerges }],
  [
    SET_ROW_DATA,
    {
      inverse: (env, params) =>
        restoreLines(env, String(params.subUnitId), 'row', keysOf(params.rowData)),
      styled: (params) => valuesOf(params.rowData),
    },
  ],
  [
    SET_COL_DATA,
    {
      inverse: (env, params) =>
        restoreLines(env, String(params.subUnitId), 'col', keysOf(params.columnData)),
      styled: (params) => valuesOf(params.columnData),
    },
  ],
  [SET_ROW_HEIGHT, linesOfRanges('row')],
  [SET_ROW_IS_AUTO_HEIGHT, linesOfRanges('row')],
  [SET_ROW_HIDDEN, linesOfRanges('row')],
  [SET_ROW_VISIBLE, linesOfRanges('row')],
  [
    SET_ROW_AUTO_HEIGHT,
    {
      inverse: (env, params) =>
        restoreLines(
          env,
          String(params.subUnitId),
          'row',
          ((params.rowsAutoHeightInfo ?? []) as { row: number }[]).map((info) => info.row),
        ),
    },
  ],
  [SET_COL_WIDTH, linesOfRanges('col')],
  [SET_COL_HIDDEN, linesOfRanges('col')],
  [SET_COL_VISIBLE, linesOfRanges('col')],
  sheetSetting(SET_ROW_COUNT, 'rowCount', (sheet) => sheet.getRowCount()),
  sheetSetting(SET_COLUMN_COUNT, 'columnCount', (sheet) => sheet.getColumnCount()),
  [
    SET_NUMFMT,
    {
      inverse: (env, params) =>
        (
          factorySetNumfmtUndoMutation(
            env.accessor as never,
            params as never,
          ) as unknown as Mutation[]
        ).map((item) => mutation(item.id, item.params)),
    },
  ],
  [
    REMOVE_NUMFMT,
    {
      inverse: (env, params) =>
        (
          factoryRemoveNumfmtUndoMutation(
            env.accessor as never,
            params as never,
          ) as unknown as Mutation[]
        ).map((item) => mutation(item.id, item.params)),
    },
  ],
  [
    INSERT_SHEET,
    {
      inverse: (_env, params) => {
        const sheet = params.sheet as { id: string; name: string }
        return [
          mutation(REMOVE_SHEET, {
            unitId: params.unitId,
            subUnitId: sheet.id,
            subUnitName: sheet.name,
          }),
        ]
      },
      styled: (params) => {
        const sheet = params.sheet as
          { cellData?: unknown; rowData?: unknown; columnData?: unknown } | undefined
        return [
          ...cellsOf(sheet?.cellData),
          ...valuesOf(sheet?.rowData),
          ...valuesOf(sheet?.columnData),
        ]
      },
    },
  ],
  [
    REMOVE_SHEET,
    {
      inverse: (env, params) => {
        const sheet = sheetOf(env, params)
        return [
          mutation(INSERT_SHEET, {
            unitId: unitOf(env),
            index: env.workbook.getConfig().sheetOrder.indexOf(sheet.getSheetId()),
            sheet: Tools.deepClone(sheet.getConfig()),
          }),
        ]
      },
    },
  ],
  sheetSetting(SET_SHEET_NAME, 'name', (sheet) => sheet.getName()),
  sheetSetting(SET_SHEET_HIDDEN, 'hidden', (sheet) => sheet.getConfig().hidden),
  sheetSetting(SET_TAB_COLOR, 'color', (sheet) => sheet.getConfig().tabColor),
  sheetSetting(TOGGLE_GRIDLINES, 'showGridlines', (sheet) => sheet.getConfig().showGridlines),
  sheetSetting(SET_GRIDLINES_COLOR, 'color', (sheet) => sheet.getConfig().gridlinesColor),
  sheetSetting(SET_RIGHT_TO_LEFT, 'rightToLeft', (sheet) => sheet.getConfig().rightToLeft),
  [
    SET_SHEET_ORDER,
    {
      inverse: (env, params) => {
        // the handler splices out whatever sits at `fromOrder`; anything but this sheet loses a sheet
        const order = env.workbook.getConfig().sheetOrder
        if (order[Number(params.fromOrder)] !== params.subUnitId)
          throw new Error('sheet order move from the wrong position')
        const toOrder = Math.min(Number(params.toOrder), order.length - 1)
        return [
          mutation(SET_SHEET_ORDER, { ...params, fromOrder: toOrder, toOrder: params.fromOrder }),
        ]
      },
    },
  ],
  [
    SET_FROZEN,
    {
      inverse: (env, params) => [
        mutation(
          SET_FROZEN,
          Tools.deepClone(
            SetFrozenMutationFactory(env.accessor as never, params as never),
          ) as never,
        ),
      ],
    },
  ],
  [
    SET_DEFAULT_STYLE,
    {
      inverse: (env, params) => [
        mutation(
          SET_DEFAULT_STYLE,
          Tools.deepClone(
            SetWorksheetDefaultStyleMutationFactory(env.accessor as never, params as never),
          ) as never,
        ),
      ],
    },
  ],
  [
    SET_DEFINED_NAME,
    {
      inverse: (env, params) => {
        const old = env.accessor
          .get<{ getValueById(unitId: string, id: string): Params | null | undefined }>(
            IDefinedNamesService,
          )
          .getValueById(unitOf(env), String(params.id))
        return old
          ? [mutation(SET_DEFINED_NAME, { ...Tools.deepClone(old), unitId: unitOf(env) })]
          : [
              mutation(REMOVE_DEFINED_NAME, {
                unitId: unitOf(env),
                id: params.id,
                name: params.name,
              }),
            ]
      },
    },
  ],
  [
    REMOVE_DEFINED_NAME,
    {
      inverse: (env, params) => {
        const old = env.accessor
          .get<{ getValueById(unitId: string, id: string): Params | null | undefined }>(
            IDefinedNamesService,
          )
          .getValueById(unitOf(env), String(params.id))
        return old
          ? [mutation(SET_DEFINED_NAME, { ...Tools.deepClone(old), unitId: unitOf(env) })]
          : []
      },
    },
  ],
]

const SYNCED = new Map<string, Synced>(SYNCED_ENTRIES)

/** The co-edited workbook of `accessor`, by unit id */
export function workbookOf(accessor: MutationEnv['accessor'], unitId: string): Workbook | null {
  return (
    accessor
      .get<IUniverInstanceService>(IUniverInstanceService)
      .getUnit<Workbook>(unitId, UniverInstanceType.UNIVER_SHEET) ?? null
  )
}
