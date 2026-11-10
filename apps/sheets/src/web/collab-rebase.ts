/**
 * Rewriting this page's unconfirmed mutations so they keep their meaning after
 * remote changes ran before them. Revert-and-replay already converges whatever
 * this does (a page sends exactly what it replayed); this only decides what a
 * local edit points at once rows or columns moved under it:
 *
 * - a cell, range or row typed at a coordinate follows that row or column when
 *   a remote insert, remove or move shifts it, and vanishes with it when a
 *   remote remove deleted it;
 * - formula text typed locally follows the rows and columns it refers to, and
 *   the new name of a sheet someone renamed meanwhile;
 * - a local insert or remove still lands between the same neighbours.
 *
 * When two inserts meet at one index, the remote rows come first. Sheet name
 * clashes and edits of removed sheets are settled at replay time, where the
 * current workbook is at hand (collab-adapter.ts).
 */
import {
  deserializeRangeWithSheet,
  generateStringWithSequence,
  LexerTreeBuilder,
  sequenceNodeType,
  serializeRangeToRefString,
  type ISequenceNode,
} from '@univerjs/engine-formula'
import type { IRange } from '@univerjs/core'
import {
  ADD_MERGE,
  INSERT_COL,
  INSERT_ROW,
  MOVE_COLS,
  MOVE_RANGE,
  MOVE_ROWS,
  type Mutation,
  type Params,
  REMOVE_COL,
  REMOVE_MERGE,
  REMOVE_NUMFMT,
  REMOVE_ROWS,
  REORDER_RANGE,
  SET_COL_DATA,
  SET_COL_HIDDEN,
  SET_COL_VISIBLE,
  SET_COL_WIDTH,
  SET_COLUMN_COUNT,
  SET_DEFINED_NAME,
  SET_NUMFMT,
  SET_RANGE_VALUES,
  SET_ROW_AUTO_HEIGHT,
  SET_ROW_COUNT,
  SET_ROW_DATA,
  SET_ROW_HEIGHT,
  SET_ROW_HIDDEN,
  SET_ROW_IS_AUTO_HEIGHT,
  SET_ROW_VISIBLE,
} from './collab-mutations'

export type Axis = 'row' | 'col'

/** A change to the row or column axis of one sheet, in the coordinates it ran in */
export type AxisChange = (
  | { sheet: string; axis: Axis; kind: 'insert'; at: number; count: number }
  | { sheet: string; axis: Axis; kind: 'remove'; at: number; count: number }
  /** the `count` lines from `from` go before line `to` (both before the move) */
  | { sheet: string; axis: Axis; kind: 'move'; from: number; count: number; to: number }
) & {
  /** the sheet's name when the change ran: formulas written before a later rename use it */
  name?: string
}

/** A sheet got another name; formulas that name it follow */
export interface RenameChange {
  kind: 'rename'
  sheet: string
  from: string
  to: string
}

/** A remote change local mutations are rewritten past */
export type Change = AxisChange | RenameChange

/** The axis change a structural mutation makes; null for every other mutation */
export function axisChangeOf(mutation: Mutation): AxisChange | null {
  const p = mutation.params
  const sheet = String(p.subUnitId)
  const range = p.range as IRange | undefined
  switch (mutation.id) {
    case INSERT_ROW:
      return {
        sheet,
        axis: 'row',
        kind: 'insert',
        at: range!.startRow,
        count: range!.endRow - range!.startRow + 1,
      }
    case REMOVE_ROWS:
      return {
        sheet,
        axis: 'row',
        kind: 'remove',
        at: range!.startRow,
        count: range!.endRow - range!.startRow + 1,
      }
    case INSERT_COL:
      return {
        sheet,
        axis: 'col',
        kind: 'insert',
        at: range!.startColumn,
        count: range!.endColumn - range!.startColumn + 1,
      }
    case REMOVE_COL:
      return {
        sheet,
        axis: 'col',
        kind: 'remove',
        at: range!.startColumn,
        count: range!.endColumn - range!.startColumn + 1,
      }
    case MOVE_ROWS: {
      const source = p.sourceRange as IRange
      const target = p.targetRange as IRange
      return {
        sheet,
        axis: 'row',
        kind: 'move',
        from: source.startRow,
        count: source.endRow - source.startRow + 1,
        to: target.startRow,
      }
    }
    case MOVE_COLS: {
      const source = p.sourceRange as IRange
      const target = p.targetRange as IRange
      return {
        sheet,
        axis: 'col',
        kind: 'move',
        from: source.startColumn,
        count: source.endColumn - source.startColumn + 1,
        to: target.startColumn,
      }
    }
    default:
      return null
  }
}

/** Where line `index` is after `change`; null when the change removed it */
export function mapIndex(change: AxisChange, index: number): number | null {
  switch (change.kind) {
    case 'insert':
      return index >= change.at ? index + change.count : index
    case 'remove':
      if (index < change.at) return index
      return index < change.at + change.count ? null : index - change.count
    case 'move': {
      const { from, count, to } = change
      if (index >= from && index < from + count)
        return (to < from ? to : to - count) + (index - from)
      if (to < from && index >= to && index < from) return index + count
      if (to > from && index >= from + count && index < to) return index - count
      return index
    }
  }
}

/**
 * Where an insertion point (a gap before line `index`) is after `change`.
 * A remote insert at the same gap goes first, so the point moves past it.
 */
function mapGap(change: AxisChange, index: number): number {
  switch (change.kind) {
    case 'insert':
      return index >= change.at ? index + change.count : index
    case 'remove':
      if (index <= change.at) return index
      return index >= change.at + change.count ? index - change.count : change.at
    case 'move': {
      const mapped = mapIndex(change, index)
      return mapped ?? index
    }
  }
}

/** The lines of [start, end] after `change`, as maximal runs */
export function mapSpan(change: AxisChange, start: number, end: number): [number, number][] {
  if (change.kind === 'insert' && change.at > start && change.at <= end) {
    // lines inserted inside the span are new: the span splits around them
    return [
      [start, change.at - 1],
      [change.at + change.count, end + change.count],
    ]
  }
  const mapped: number[] = []
  for (let index = start; index <= end; index++) {
    const to = mapIndex(change, index)
    if (to !== null) mapped.push(to)
  }
  mapped.sort((a, b) => a - b)
  const runs: [number, number][] = []
  for (const index of mapped) {
    const last = runs[runs.length - 1]
    if (last && last[1] + 1 === index) last[1] = index
    else runs.push([index, index])
  }
  return runs
}

const ROW_KEYS = ['startRow', 'endRow'] as const
const COL_KEYS = ['startColumn', 'endColumn'] as const

/** `range` after `change` on its axis, split where it has to be; whole-axis ranges stay */
function mapRange(change: AxisChange, range: IRange): IRange[] {
  const [startKey, endKey] = change.axis === 'row' ? ROW_KEYS : COL_KEYS
  const start = range[startKey]
  const end = range[endKey]
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    Number.isNaN(start) ||
    Number.isNaN(end)
  )
    return [range]
  return mapSpan(change, start, end).map(([s, e]) => ({ ...range, [startKey]: s, [endKey]: e }))
}

/** A single range after `change`: the hull of its pieces, or null when nothing is left */
function hullRange(change: AxisChange, range: IRange): IRange | null {
  const pieces = mapRange(change, range)
  if (pieces.length === 0) return null
  const [startKey, endKey] = change.axis === 'row' ? ROW_KEYS : COL_KEYS
  return {
    ...range,
    [startKey]: pieces[0]![startKey],
    [endKey]: pieces[pieces.length - 1]![endKey],
  }
}

type Matrix = Record<string, Record<string, unknown> | undefined>

/** A cell matrix with its keys moved by `change`; cells on removed lines are dropped */
function mapMatrix(change: AxisChange, matrix: Matrix): Matrix {
  const out: Matrix = {}
  for (const [rowKey, columns] of Object.entries(matrix)) {
    if (!columns) continue
    for (const [colKey, cell] of Object.entries(columns)) {
      let row: number | null = Number(rowKey)
      let col: number | null = Number(colKey)
      if (change.axis === 'row') row = mapIndex(change, row)
      else col = mapIndex(change, col)
      if (row === null || col === null) continue
      ;(out[row] ??= {})[col] = cell
    }
  }
  return out
}

function mapKeys<T>(change: AxisChange, record: Record<string, T>): Record<number, T> {
  const out: Record<number, T> = {}
  for (const [key, value] of Object.entries(record)) {
    const to = mapIndex(change, Number(key))
    if (to !== null) out[to] = value
  }
  return out
}

function isEmpty(record: object): boolean {
  return Object.keys(record).length === 0
}

const lexer = new LexerTreeBuilder()

/**
 * `formula` with its references to the changed sheet (named `changedName`)
 * moved by `change`. A reference whose lines were all removed becomes #REF!.
 * `onChangedSheet`: the formula sits on that sheet, so its references without
 * a sheet name point there.
 */
export function shiftFormula(
  formula: string,
  onChangedSheet: boolean,
  changedName: string | undefined,
  change: AxisChange,
): string {
  if (!formula.startsWith('=')) return formula
  const nodes = lexer.sequenceNodesBuilder(formula) as (string | ISequenceNode)[] | undefined
  if (!nodes) return formula
  let changed = false
  const out = nodes.map((node) => {
    if (typeof node === 'string' || node.nodeType !== sequenceNodeType.REFERENCE) return node
    const ref = deserializeRangeWithSheet(node.token)
    if (ref.sheetName ? ref.sheetName !== changedName : !onChangedSheet) return node
    const range = ref.range
    const [startKey, endKey] = change.axis === 'row' ? ROW_KEYS : COL_KEYS
    if (range[startKey] === null || range[startKey] === undefined || Number.isNaN(range[startKey]))
      return node
    const moved = hullRange(change, range)
    if (moved && moved[startKey] === range[startKey] && moved[endKey] === range[endKey]) return node
    changed = true
    const token = moved ? serializeRangeToRefString({ ...ref, range: moved }) : '#REF!'
    return { ...node, token }
  })
  return changed ? `=${generateStringWithSequence(out)}` : formula
}

/** `formula` with its references to the sheet named `from` naming it `to` */
export function renameInFormula(formula: string, from: string, to: string): string {
  if (!formula.startsWith('=') || from === to) return formula
  const nodes = lexer.sequenceNodesBuilder(formula) as (string | ISequenceNode)[] | undefined
  if (!nodes) return formula
  let changed = false
  const out = nodes.map((node) => {
    if (typeof node === 'string' || node.nodeType !== sequenceNodeType.REFERENCE) return node
    const ref = deserializeRangeWithSheet(node.token)
    if (ref.sheetName !== from) return node
    changed = true
    return { ...node, token: serializeRangeToRefString({ ...ref, sheetName: to }) }
  })
  return changed ? `=${generateStringWithSequence(out)}` : formula
}

export interface SheetNames {
  nameOf(sheetId: string): string | undefined
}

/** `cells` with every formula text passed through `rewrite`; the same object when none changed */
function mapCellFormulas(cells: Matrix, rewrite: (formula: string) => string): Matrix {
  let changed = false
  const out: Matrix = {}
  for (const [row, columns] of Object.entries(cells)) {
    if (!columns) continue
    out[row] = {}
    for (const [col, cell] of Object.entries(columns)) {
      const f = (cell as { f?: unknown } | null)?.f
      if (typeof f === 'string') {
        const next = rewrite(f)
        if (next !== f) {
          changed = true
          out[row]![col] = { ...(cell as object), f: next }
          continue
        }
      }
      out[row]![col] = cell
    }
  }
  return changed ? out : cells
}

/** A local mutation's formula texts after a remote rename; nothing else names a sheet by its name */
function renameInMutation(mutation: Mutation, change: RenameChange): Mutation[] {
  const p = mutation.params
  if (mutation.id === SET_RANGE_VALUES) {
    const cells = (p.cellValue ?? {}) as Matrix
    const renamed = mapCellFormulas(cells, (f) => renameInFormula(f, change.from, change.to))
    return renamed === cells
      ? [mutation]
      : [{ id: mutation.id, params: { ...p, cellValue: renamed } }]
  }
  if (mutation.id === SET_DEFINED_NAME && typeof p.formulaOrRefString === 'string') {
    const text = p.formulaOrRefString
    const renamed = renameInFormula(`=${text}`, change.from, change.to).slice(1)
    return renamed === text
      ? [mutation]
      : [{ id: mutation.id, params: { ...p, formulaOrRefString: renamed } }]
  }
  return [mutation]
}

/**
 * A local mutation expressed after `change` ran before it. Empty when what it
 * edits is gone; several when a range split.
 */
export function transformMutation(
  mutation: Mutation,
  change: Change,
  names: SheetNames,
): Mutation[] {
  if (change.kind === 'rename') return renameInMutation(mutation, change)
  const p = mutation.params
  const same = p.subUnitId === change.sheet
  const changedName = change.name ?? names.nameOf(change.sheet)
  const with_ = (params: Params): Mutation[] => [{ id: mutation.id, params: { ...p, ...params } }]
  const onAxis = (axis: Axis): boolean => same && change.axis === axis

  switch (mutation.id) {
    case SET_RANGE_VALUES: {
      let cells = (p.cellValue ?? {}) as Matrix
      if (same) cells = mapMatrix(change, cells)
      cells = mapCellFormulas(cells, (f) => shiftFormula(f, same, changedName, change))
      return isEmpty(cells) ? [] : with_({ cellValue: cells })
    }
    case MOVE_RANGE: {
      const from = p.from as { subUnitId: string; value: Matrix }
      const to = p.to as { subUnitId: string; value: Matrix }
      const side = (s: { subUnitId: string; value: Matrix }) =>
        s.subUnitId === change.sheet ? { ...s, value: mapMatrix(change, s.value) } : s
      const out: Params = { from: side(from), to: side(to) }
      for (const key of ['fromRange', 'toRange'] as const) {
        const range = p[key] as IRange | undefined
        const sheet = key === 'fromRange' ? from.subUnitId : to.subUnitId
        if (range && sheet === change.sheet) {
          const moved = hullRange(change, range)
          if (!moved) return []
          out[key] = moved
        }
      }
      return with_(out)
    }
    case REORDER_RANGE: {
      if (!same) return [mutation]
      const range = p.range as IRange
      const [startKey, endKey] = change.axis === 'row' ? ROW_KEYS : COL_KEYS
      const at = change.kind === 'move' ? Math.min(change.from, change.to) : change.at
      if (change.axis === 'row') {
        // rows reordered by the sort: a change before the range shifts it, one inside voids the sort
        if (at > range[endKey]) return [mutation]
        if (
          change.kind !== 'move' &&
          at + (change.kind === 'remove' ? change.count : 0) <= range[startKey]
        ) {
          const delta = change.kind === 'insert' ? change.count : -change.count
          const order: Record<number, number> = {}
          for (const [from, to] of Object.entries(p.order as Record<string, number>))
            order[Number(from) + delta] = to + delta
          return with_({
            range: { ...range, startRow: range.startRow + delta, endRow: range.endRow + delta },
            order,
          })
        }
        return []
      }
      const moved = hullRange(change, range)
      return moved ? with_({ range: moved }) : []
    }
    case ADD_MERGE:
    case REMOVE_MERGE: {
      if (!same) return [mutation]
      const ranges = ((p.ranges ?? []) as IRange[]).flatMap((range) => {
        const moved = hullRange(change, range)
        if (!moved) return []
        const single = moved.startRow === moved.endRow && moved.startColumn === moved.endColumn
        return single ? [] : [moved]
      })
      return ranges.length === 0 ? [] : with_({ ranges })
    }
    case SET_NUMFMT: {
      if (!same) return [mutation]
      const values: Record<string, { ranges: IRange[] }> = {}
      for (const [id, value] of Object.entries(p.values as Record<string, { ranges: IRange[] }>)) {
        const ranges = value.ranges.flatMap((range) => mapRange(change, range))
        if (ranges.length > 0) values[id] = { ...value, ranges }
      }
      return isEmpty(values) ? [] : with_({ values })
    }
    case REMOVE_NUMFMT: {
      if (!same) return [mutation]
      const ranges = ((p.ranges ?? []) as IRange[]).flatMap((range) => mapRange(change, range))
      return ranges.length === 0 ? [] : with_({ ranges })
    }
    case INSERT_ROW:
    case INSERT_COL: {
      const axis: Axis = mutation.id === INSERT_ROW ? 'row' : 'col'
      if (!onAxis(axis)) return [mutation]
      const range = p.range as IRange
      const [startKey, endKey] = axis === 'row' ? ROW_KEYS : COL_KEYS
      const start = mapGap(change, range[startKey])
      return with_({
        range: { ...range, [startKey]: start, [endKey]: start + range[endKey] - range[startKey] },
      })
    }
    case REMOVE_ROWS:
    case REMOVE_COL: {
      const axis: Axis = mutation.id === REMOVE_ROWS ? 'row' : 'col'
      if (!onAxis(axis)) return [mutation]
      // remove the highest run first so the lower runs keep their coordinates
      return mapRange(change, p.range as IRange)
        .reverse()
        .map((range) => ({ id: mutation.id, params: { ...p, range } }))
    }
    case MOVE_ROWS:
    case MOVE_COLS: {
      const axis: Axis = mutation.id === MOVE_ROWS ? 'row' : 'col'
      if (!onAxis(axis)) return [mutation]
      const source = p.sourceRange as IRange
      const target = p.targetRange as IRange
      const [startKey, endKey] = axis === 'row' ? ROW_KEYS : COL_KEYS
      const pieces = mapRange(change, source)
      if (pieces.length !== 1) return []
      const moved = pieces[0]!
      if (moved[endKey] - moved[startKey] !== source[endKey] - source[startKey]) return []
      const to = mapGap(change, target[startKey])
      if (to >= moved[startKey] && to <= moved[endKey] + 1) return []
      const count = source[endKey] - source[startKey]
      return with_({
        sourceRange: moved,
        targetRange: { ...target, [startKey]: to, [endKey]: to + count },
      })
    }
    case SET_ROW_DATA:
    case SET_COL_DATA: {
      const axis: Axis = mutation.id === SET_ROW_DATA ? 'row' : 'col'
      if (!onAxis(axis)) return [mutation]
      const key = axis === 'row' ? 'rowData' : 'columnData'
      const data = mapKeys(change, (p[key] ?? {}) as Record<string, unknown>)
      return isEmpty(data) ? [] : with_({ [key]: data })
    }
    case SET_ROW_HEIGHT:
    case SET_ROW_IS_AUTO_HEIGHT:
    case SET_ROW_HIDDEN:
    case SET_ROW_VISIBLE:
    case SET_COL_WIDTH:
    case SET_COL_HIDDEN:
    case SET_COL_VISIBLE: {
      const axis: Axis = mutation.id.includes('-col') ? 'col' : 'row'
      if (!onAxis(axis)) return [mutation]
      const ranges = ((p.ranges ?? []) as IRange[]).flatMap((range) => mapRange(change, range))
      if (ranges.length === 0) return []
      const out: Params = { ranges }
      for (const key of ['rowHeight', 'autoHeightInfo', 'colWidth'] as const) {
        const value = p[key]
        if (value && typeof value === 'object')
          out[key] = mapKeys(change, value as Record<string, unknown>)
      }
      return with_(out)
    }
    case SET_ROW_AUTO_HEIGHT: {
      if (!onAxis('row')) return [mutation]
      const info = ((p.rowsAutoHeightInfo ?? []) as { row: number; autoHeight: unknown }[]).flatMap(
        (item) => {
          const row = mapIndex(change, item.row)
          return row === null ? [] : [{ ...item, row }]
        },
      )
      return info.length === 0 ? [] : with_({ rowsAutoHeightInfo: info })
    }
    case SET_ROW_COUNT:
    case SET_COLUMN_COUNT: {
      const axis: Axis = mutation.id === SET_ROW_COUNT ? 'row' : 'col'
      if (!onAxis(axis) || change.kind === 'move') return [mutation]
      const key = axis === 'row' ? 'rowCount' : 'columnCount'
      const delta = change.kind === 'insert' ? change.count : -change.count
      return with_({ [key]: Number(p[key]) + delta })
    }
    case SET_DEFINED_NAME: {
      const text = p.formulaOrRefString
      if (typeof text !== 'string' || changedName === undefined) return [mutation]
      // a defined name has no sheet of its own: only references naming the changed sheet move
      const shifted = shiftFormula(`=${text}`, false, changedName, change).slice(1)
      return shifted === text ? [mutation] : with_({ formulaOrRefString: shifted })
    }
    default:
      return [mutation]
  }
}

/**
 * `change` expressed after the local structural mutation `local` ran before
 * it. A remote remove that spans lines a local insert added splits around them.
 */
export function transformChange(change: AxisChange, local: AxisChange): AxisChange[] {
  if (change.sheet !== local.sheet || change.axis !== local.axis) return [change]
  switch (change.kind) {
    case 'insert': {
      // the remote rows came first at a shared gap, so only a local change strictly before moves them
      const at =
        local.kind === 'insert' && local.at === change.at ? change.at : mapGap(local, change.at)
      return [{ ...change, at }]
    }
    case 'remove':
      return mapSpan(local, change.at, change.at + change.count - 1)
        .reverse()
        .map(([start, end]) => ({ ...change, at: start, count: end - start + 1 }))
    case 'move': {
      const pieces = mapSpan(local, change.from, change.from + change.count - 1)
      if (pieces.length !== 1) return []
      const [start, end] = pieces[0]!
      if (end - start + 1 !== change.count) return []
      return [{ ...change, from: start, to: mapGap(local, change.to) }]
    }
  }
}

/** Every axis change in `mutations`, in order */
export function axisChangesOf(mutations: readonly Mutation[]): AxisChange[] {
  return mutations.flatMap((mutation) => {
    const change = axisChangeOf(mutation)
    return change ? [change] : []
  })
}

/**
 * `local` (ops of mutations made in order on this page) rewritten to run
 * after the remote `changes`. Each change is carried past the local
 * structural mutations as they go, because a later local mutation was made in
 * the coordinates its earlier siblings left behind. The ops keep their
 * boundaries; an op may end up empty.
 */
export function rebaseMutations(
  local: readonly (readonly Mutation[])[],
  changes: readonly Change[],
  names: SheetNames,
): Mutation[][] {
  let current = local.map((op) => op.slice())
  for (const remote of changes) {
    let pending: Change[] = [remote]
    current = current.map((op) =>
      op.flatMap((mutation) => {
        let rewritten: Mutation[] = [mutation]
        for (const change of pending)
          rewritten = rewritten.flatMap((m) => transformMutation(m, change, names))
        // the remote change, carried past what the local mutation did in the coordinates both started from
        for (const localChange of axisChangesOf([mutation]))
          pending = pending.flatMap((change): Change[] =>
            change.kind === 'rename' ? [change] : transformChange(change, localChange),
          )
        return rewritten
      }),
    )
  }
  return current
}
