/**
 * What a synced mutation may carry on the wire. Every page replays the log,
 * later openers included, so a mutation another page could not apply (a sheet
 * of a billion rows, a format over the whole grid, text nested a thousand
 * levels deep) would hang or break every one of them. `decode` runs each remote
 * mutation through `checkWireMutation`, and a page checks its own before it
 * sends them, so nothing a page emits is refused by the others.
 *
 * The shapes are the params of the Univer mutations co-editing sends
 * (collab-mutations.ts), in their wire form: no unit id, style objects
 * instead of style ids. The bounds are Excel's.
 */

export const MAX_ROWS = 1_048_576
export const MAX_COLUMNS = 16_384
/** Cells one mutation writes or covers with a cell range: one whole column */
export const MAX_CELLS = MAX_ROWS
/**
 * What Univer walks for a sheet's merges, all of them: every merge mutation rebuilds the sheet's
 * span cache over each merged cell (about 35 ms and 50 MB per million cells, measured headless)
 */
export const MAX_MERGED_CELLS = MAX_CELLS
/**
 * Merged cells one op may make Univer rebuild, summed over its mutations that rebuild the span
 * cache (adapter: rebuildWork). A received merge mutation on a sheet holding 1,048,576 merged
 * cells took 106 to 121 ms with the adapter and Univer's listeners (measured in vitest, machine
 * load 8), so the bound is about one second. It leaves an ordinary edit room: a merge is two
 * rebuilds, and 201 subtotal rows inserted at once fit while the sheet holds under 41,000
 * merged cells.
 */
export const MAX_REBUILD_WORK = 8 * MAX_MERGED_CELLS
/** Merges on one sheet: a removal compares each of its ranges with each of them */
export const MAX_MERGES = 65_536
const MAX_TEXT = 32_767
const MAX_FORMULA = 8_192
export const MAX_SHEET_NAME = 31
const MAX_NUMBER_FORMAT = 255
const MAX_ID = 128
const MAX_RANGES = 4_096
const MAX_SHEETS = 65_536
/** JSON nodes inside one free-form value (rich text, `custom`), and how deep they may nest */
const MAX_JSON_DEPTH = 12
const MAX_JSON_NODES = 100_000
/** Keys that carry links, embedded objects or other documents; the cell editor writes some empty */
const LINK_KEYS = new Set([
  'customRanges',
  'customBlocks',
  'drawings',
  'drawingsOrder',
  'headers',
  'footers',
  'url',
  'href',
  'hyperlink',
  'linkUrl',
  'linkId',
])
/** Keys Univer's deep clone would assign through to the object's prototype */
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** What the cell editor leaves in a link or drawing key when the text has none */
const isEmpty = (value: unknown): boolean =>
  value === null ||
  (Array.isArray(value) && value.length === 0) ||
  (isRecord(value) && Object.keys(value).length === 0)

/** A mutation outside these shapes or bounds; `tooLarge` when only a bound was crossed */
export class WireMutationError extends Error {
  constructor(
    message: string,
    readonly tooLarge: boolean,
  ) {
    super(message)
  }
}

interface Budget {
  cells: number
  rows: number
  columns: number
}

type Check = (value: unknown, path: string, budget: Budget) => void

function bad(path: string, what: string): never {
  throw new WireMutationError(`${path}: ${what}`, false)
}

function tooLarge(path: string, what: string): never {
  throw new WireMutationError(`${path}: ${what}`, true)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const optional =
  (check: Check): Check =>
  (value, path, budget) => {
    if (value !== undefined) check(value, path, budget)
  }

const nullable =
  (check: Check): Check =>
  (value, path, budget) => {
    if (value !== undefined && value !== null) check(value, path, budget)
  }

const either =
  (...checks: Check[]): Check =>
  (value, path, budget) => {
    let first: unknown
    for (const check of checks) {
      try {
        check(value, path, budget)
        return
      } catch (error) {
        first ??= error
      }
    }
    throw first
  }

const text =
  (max: number): Check =>
  (value, path) => {
    if (typeof value !== 'string') bad(path, 'not a string')
    if (value.length > max) tooLarge(path, `longer than ${max} characters`)
  }

const number =
  (min: number, max: number): Check =>
  (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) bad(path, 'not a number')
    if (value < min || value > max) tooLarge(path, `outside ${min}..${max}`)
  }

const integer =
  (min: number, max: number): Check =>
  (value, path, budget) => {
    if (!Number.isInteger(value)) bad(path, 'not an integer')
    number(min, max)(value, path, budget)
  }

const flag: Check = (value, path) => {
  if (value !== 0 && value !== 1) bad(path, 'not 0 or 1')
}

const boolean: Check = (value, path) => {
  if (typeof value !== 'boolean') bad(path, 'not a boolean')
}

/** Univer's small numeric enums */
const enumeration = integer(0, 64)
const id = text(MAX_ID)
/**
 * Excel's rule: 1 to 31 characters, none of `\ / ? * [ ] :`, no apostrophe at either end; and no
 * control characters, which an XML file cannot hold
 */
const sheetName: Check = (value, path, budget) => {
  text(MAX_SHEET_NAME)(value, path, budget)
  // eslint-disable-next-line no-control-regex
  if (!/^(?!')[^\\/?*[\]:\u0000-\u001f\u007f]+(?<!')$/.test(value as string))
    bad(path, 'not a sheet name Excel takes')
}
const color = text(64)
const row = integer(0, MAX_ROWS - 1)
const column = integer(0, MAX_COLUMNS - 1)
const size = number(0, 100_000)

type Shape = Record<string, Check>

function object(shape: Shape, required: readonly string[] = []): Check {
  return (value, path, budget) => {
    if (!isRecord(value)) bad(path, 'not an object')
    for (const key of required) if (value[key] === undefined) bad(`${path}.${key}`, 'missing')
    for (const [key, field] of Object.entries(value)) {
      // absent on the wire: JSON drops it
      if (field === undefined) continue
      const check = Object.hasOwn(shape, key) ? shape[key] : undefined
      if (!check) bad(`${path}.${key}`, 'unknown field')
      check(field, `${path}.${key}`, budget)
    }
  }
}

function list(item: Check, max: number): Check {
  return (value, path, budget) => {
    if (!Array.isArray(value)) bad(path, 'not an array')
    if (value.length > max) tooLarge(path, `more than ${max} items`)
    value.forEach((entry, index) => item(entry, `${path}[${index}]`, budget))
  }
}

function index(key: string, max: number, path: string): number {
  if (!/^(0|[1-9]\d*)$/.test(key)) bad(`${path}.${key}`, 'not an index')
  const at = Number(key)
  if (at >= max) tooLarge(`${path}.${key}`, `index past ${max - 1}`)
  return at
}

function spend(budget: Budget, key: keyof Budget, amount: number, path: string): void {
  budget[key] -= amount
  if (budget[key] < 0) tooLarge(path, `covers too many ${key}`)
}

/** `{ [row]: { [column]: cell } }`, every cell counted against the mutation's budget */
function matrix(cell: Check): Check {
  return (value, path, budget) => {
    if (!isRecord(value)) bad(path, 'not a cell matrix')
    for (const [r, columns] of Object.entries(value)) {
      index(r, MAX_ROWS, path)
      if (columns === null || columns === undefined) continue
      if (!isRecord(columns)) bad(`${path}.${r}`, 'not a row of cells')
      for (const [c, entry] of Object.entries(columns)) {
        index(c, MAX_COLUMNS, `${path}.${r}`)
        spend(budget, 'cells', 1, path)
        cell(entry, `${path}.${r}.${c}`, budget)
      }
    }
  }
}

/** `{ [row or column]: entry }` */
function lines(axis: 'rows' | 'columns', entry: Check): Check {
  return (value, path, budget) => {
    if (!isRecord(value)) bad(path, 'not a line record')
    for (const [key, item] of Object.entries(value)) {
      index(key, axis === 'rows' ? MAX_ROWS : MAX_COLUMNS, path)
      spend(budget, axis, 1, path)
      entry(item, `${path}.${key}`, budget)
    }
  }
}

const rangeShape = object(
  {
    startRow: row,
    endRow: row,
    startColumn: column,
    endColumn: column,
    rangeType: optional(enumeration),
    startAbsoluteRefType: optional(enumeration),
    endAbsoluteRefType: optional(enumeration),
    unitId: optional(id),
    sheetId: optional(id),
  },
  ['startRow', 'endRow', 'startColumn', 'endColumn'],
)

type Range = { startRow: number; endRow: number; startColumn: number; endColumn: number }

/**
 * The cells a merge covers. Univer's span cache walks only the rows or columns of a whole-row or
 * whole-column merge (`rangeType`), but a saved file holds every cell of it, and opening that file
 * walks them all.
 */
const mergeCost = (range: Range): number =>
  (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1)

/** The cells `merges` cover together */
export function mergedCells(merges: readonly Range[]): number {
  let cells = 0
  for (const merge of merges) cells += mergeCost(merge)
  return cells
}

/** A range; `covers` says what of it the mutation visits one by one */
function range(covers: 'cells' | 'rows' | 'columns' | 'nothing'): Check {
  return (value, path, budget) => {
    rangeShape(value, path, budget)
    const { startRow, endRow, startColumn, endColumn } = value as Range
    if (endRow < startRow || endColumn < startColumn) bad(path, 'ends before it starts')
    const rows = endRow - startRow + 1
    const columns = endColumn - startColumn + 1
    if (covers === 'cells') spend(budget, 'cells', rows * columns, path)
    else if (covers === 'rows') spend(budget, 'rows', rows, path)
    else if (covers === 'columns') spend(budget, 'columns', columns, path)
  }
}

const ranges = (covers: Parameters<typeof range>[0]): Check => list(range(covers), MAX_RANGES)

const colorStyle = object({ rgb: nullable(color), th: optional(enumeration) })
const decoration = object(
  { s: flag, c: optional(flag), cl: optional(colorStyle), t: optional(enumeration) },
  ['s'],
)
const borderLine = object({ s: enumeration, cl: colorStyle }, ['s'])
const border = object(
  Object.fromEntries(
    ['t', 'r', 'b', 'l', 'tl_br', 'tl_bc', 'tl_mr', 'bl_tr', 'ml_tr', 'bc_tr'].map((key) => [
      key,
      nullable(borderLine),
    ]),
  ),
)

/** A cell, row, column or sheet style in its wire form: Univer's `IStyleData` keys only */
const style = object({
  ff: nullable(text(255)),
  fs: optional(number(0, 409)),
  it: optional(flag),
  bl: optional(flag),
  ul: optional(decoration),
  bbl: optional(decoration),
  st: optional(decoration),
  ol: optional(decoration),
  bg: nullable(colorStyle),
  bd: nullable(border),
  cl: nullable(colorStyle),
  va: nullable(enumeration),
  n: nullable(object({ pattern: text(MAX_NUMBER_FORMAT) }, ['pattern'])),
  tr: nullable(object({ a: number(-180, 180), v: optional(flag) }, ['a'])),
  td: nullable(enumeration),
  ht: nullable(enumeration),
  vt: nullable(enumeration),
  tb: nullable(enumeration),
  pd: nullable(
    object({ t: optional(size), r: optional(size), b: optional(size), l: optional(size) }),
  ),
})

/**
 * Free-form JSON (a cell's rich text, Univer's `custom` data): bounded depth and size, without
 * links or embedded objects
 */
const plainJson: Check = (value, path) => {
  let nodes = 0
  const walk = (node: unknown, at: string, depth: number): void => {
    nodes += 1
    if (nodes > MAX_JSON_NODES) tooLarge(path, 'too many nodes')
    if (depth > MAX_JSON_DEPTH) tooLarge(at, 'nested too deep')
    if (node === null || typeof node === 'boolean') return
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) bad(at, 'not a number')
      return
    }
    if (typeof node === 'string') {
      if (node.length > MAX_TEXT) tooLarge(at, `longer than ${MAX_TEXT} characters`)
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}[${i}]`, depth + 1))
      return
    }
    if (!isRecord(node)) bad(at, 'not JSON')
    for (const [key, item] of Object.entries(node)) {
      if (RESERVED_KEYS.has(key)) bad(`${at}.${key}`, 'reserved key')
      if (LINK_KEYS.has(key) && !isEmpty(item))
        bad(`${at}.${key}`, 'links and embedded objects not allowed')
      walk(item, `${at}.${key}`, depth + 1)
    }
  }
  walk(value, path, 0)
}

const finite = number(-Number.MAX_VALUE, Number.MAX_VALUE)
const cellText = text(MAX_TEXT)
/** By its type, not by `either`: one value per cell, and a thrown error per cell is slow */
const cellValue: Check = (value, path, budget) => {
  if (typeof value === 'number') finite(value, path, budget)
  else if (typeof value !== 'boolean') cellText(value, path, budget)
}

const cell = nullable(
  object({
    v: nullable(cellValue),
    p: nullable(plainJson),
    s: nullable(style),
    t: nullable(enumeration),
    f: nullable(text(MAX_FORMULA)),
    si: nullable(id),
    ref: nullable(text(64)),
    xf: nullable(text(MAX_FORMULA)),
    custom: nullable(plainJson),
  }),
)

const rowData = nullable(
  object({
    h: optional(size),
    ia: optional(flag),
    ah: optional(size),
    hd: optional(flag),
    s: nullable(style),
    custom: nullable(plainJson),
  }),
)
const columnData = nullable(
  object({
    w: optional(size),
    hd: optional(flag),
    s: nullable(style),
    custom: nullable(plainJson),
  }),
)
const defaultStyle = nullable(either(id, style))

const worksheet = object(
  {
    id,
    name: sheetName,
    tabColor: nullable(color),
    hidden: optional(flag),
    freeze: optional(
      object({
        xSplit: integer(0, MAX_COLUMNS),
        ySplit: integer(0, MAX_ROWS),
        startRow: integer(-1, MAX_ROWS),
        startColumn: integer(-1, MAX_COLUMNS),
      }),
    ),
    rowCount: integer(1, MAX_ROWS),
    columnCount: integer(1, MAX_COLUMNS),
    zoomRatio: optional(number(0, 100)),
    scrollTop: optional(size),
    scrollLeft: optional(size),
    defaultColumnWidth: optional(size),
    defaultRowHeight: optional(size),
    mergeData: optional(ranges('cells')),
    cellData: optional(matrix(cell)),
    rowData: optional(lines('rows', rowData)),
    columnData: optional(lines('columns', columnData)),
    defaultStyle,
    rowHeader: optional(object({ width: size, hidden: optional(flag) })),
    columnHeader: optional(object({ height: size, hidden: optional(flag) })),
    showGridlines: optional(flag),
    gridlinesColor: nullable(color),
    rightToLeft: optional(flag),
    custom: nullable(plainJson),
  },
  ['id', 'name', 'rowCount', 'columnCount'],
)

const lineSizes = (axis: 'rows' | 'columns'): Check => either(size, lines(axis, nullable(size)))

/** Fields every sheet mutation carries */
const onSheet = (shape: Shape, required: readonly string[] = []): Check =>
  object({ subUnitId: id, trigger: optional(id), ...shape }, ['subUnitId', ...required])

/** A sheet setting the inverse reads back from the sheet: absent when the sheet has none */
const setting = (field: string, check: Check): Check => onSheet({ [field]: optional(check) })

const cellsAt = object({ subUnitId: id, value: matrix(cell) }, ['subUnitId', 'value'])

const definedName = {
  id,
  name: text(255),
  trigger: optional(id),
}

/** Every synced mutation id (collab-mutations.ts) and the params it may carry */
const WIRE: Record<string, Check> = {
  'sheet.mutation.set-range-values': onSheet({
    cellValue: optional(matrix(cell)),
    options: optional(object({ formatOnly: optional(boolean), contentsOnly: optional(boolean) })),
  }),
  'sheet.mutation.move-range': object(
    {
      fromRange: range('nothing'),
      toRange: range('nothing'),
      from: cellsAt,
      to: cellsAt,
      trigger: optional(id),
    },
    ['fromRange', 'toRange', 'from', 'to'],
  ),
  'sheet.mutation.reorder-range': onSheet({ range: range('cells'), order: lines('rows', row) }, [
    'range',
    'order',
  ]),
  'sheet.mutation.insert-row': onSheet(
    { range: range('rows'), rowInfo: optional(lines('rows', rowData)) },
    ['range'],
  ),
  'sheet.mutation.insert-col': onSheet(
    { range: range('columns'), colInfo: optional(lines('columns', columnData)) },
    ['range'],
  ),
  'sheet.mutation.remove-rows': onSheet({ range: range('rows') }, ['range']),
  'sheet.mutation.remove-col': onSheet({ range: range('columns') }, ['range']),
  'sheet.mutation.move-rows': onSheet({ sourceRange: range('rows'), targetRange: range('rows') }, [
    'sourceRange',
    'targetRange',
  ]),
  'sheet.mutation.move-columns': onSheet(
    { sourceRange: range('columns'), targetRange: range('columns') },
    ['sourceRange', 'targetRange'],
  ),
  // the span cache is rebuilt over every merge of the sheet (adapter: mergesFit, rebuildWork); a
  // removal only compares ranges, and what it leaves was bounded when it was added
  'sheet.mutation.add-worksheet-merge': onSheet({ ranges: ranges('cells') }, ['ranges']),
  'sheet.mutation.remove-worksheet-merge': onSheet({ ranges: ranges('nothing') }, ['ranges']),
  'sheet.mutation.set-row-data': onSheet({ rowData: lines('rows', rowData) }, ['rowData']),
  'sheet.mutation.set-col-data': onSheet({ columnData: lines('columns', columnData) }, [
    'columnData',
  ]),
  'sheet.mutation.set-worksheet-row-height': onSheet(
    { ranges: ranges('rows'), rowHeight: lineSizes('rows') },
    ['ranges', 'rowHeight'],
  ),
  'sheet.mutation.set-worksheet-row-is-auto-height': onSheet(
    { ranges: ranges('rows'), autoHeightInfo: either(flag, lines('rows', nullable(flag))) },
    ['ranges', 'autoHeightInfo'],
  ),
  'sheet.mutation.set-worksheet-row-auto-height': onSheet(
    {
      rowsAutoHeightInfo: list(object({ row, autoHeight: optional(size) }, ['row']), MAX_ROWS),
    },
    ['rowsAutoHeightInfo'],
  ),
  'sheet.mutation.set-row-hidden': onSheet({ ranges: ranges('rows') }, ['ranges']),
  'sheet.mutation.set-row-visible': onSheet({ ranges: ranges('rows') }, ['ranges']),
  'sheet.mutation.set-worksheet-col-width': onSheet(
    { ranges: ranges('columns'), colWidth: lineSizes('columns') },
    ['ranges', 'colWidth'],
  ),
  'sheet.mutation.set-col-hidden': onSheet({ ranges: ranges('columns') }, ['ranges']),
  'sheet.mutation.set-col-visible': onSheet({ ranges: ranges('columns') }, ['ranges']),
  'sheet.mutation.set-worksheet-row-count': onSheet({ rowCount: integer(1, MAX_ROWS) }, [
    'rowCount',
  ]),
  'sheet.mutation.set-worksheet-column-count': onSheet({ columnCount: integer(1, MAX_COLUMNS) }, [
    'columnCount',
  ]),
  'sheet.mutation.set.numfmt': onSheet(
    {
      values: record(object({ ranges: ranges('cells') }, ['ranges'])),
      refMap: record(object({ pattern: text(MAX_NUMBER_FORMAT) }, ['pattern'])),
    },
    ['values', 'refMap'],
  ),
  'sheet.mutation.remove.numfmt': onSheet({ ranges: ranges('cells') }, ['ranges']),
  'sheet.mutation.insert-sheet': object(
    {
      index: integer(0, MAX_SHEETS),
      sheet: worksheet,
      styles: optional(record(nullable(style))),
      trigger: optional(id),
    },
    ['index', 'sheet'],
  ),
  // the name the page had; a file may hold one Excel would not take (a CSV's file name)
  'sheet.mutation.remove-sheet': onSheet({ subUnitName: text(255) }, ['subUnitName']),
  'sheet.mutation.set-worksheet-name': onSheet({ name: sheetName }, ['name']),
  'sheet.mutation.set-worksheet-order': onSheet(
    { fromOrder: integer(0, MAX_SHEETS), toOrder: integer(0, MAX_SHEETS) },
    ['fromOrder', 'toOrder'],
  ),
  'sheet.mutation.set-worksheet-hidden': setting('hidden', flag),
  'sheet.mutation.set-tab-color': setting('color', nullable(color)),
  'sheet.mutation.set-frozen': onSheet(
    {
      startRow: integer(-1, MAX_ROWS),
      startColumn: integer(-1, MAX_COLUMNS),
      ySplit: integer(0, MAX_ROWS),
      xSplit: integer(0, MAX_COLUMNS),
      resetScroll: optional(boolean),
    },
    ['startRow', 'startColumn', 'ySplit', 'xSplit'],
  ),
  'sheet.mutation.toggle-gridlines': setting('showGridlines', flag),
  'sheet.mutation.set-gridlines-color': setting('color', nullable(color)),
  'sheet.mutation.set-worksheet-right-to-left': setting('rightToLeft', flag),
  'sheet.mutation.set-worksheet-default-style': onSheet({ defaultStyle }),
  'formula.mutation.set-defined-name': object(
    {
      ...definedName,
      formulaOrRefString: text(MAX_FORMULA),
      comment: optional(text(255)),
      localSheetId: optional(id),
      hidden: optional(boolean),
      formulaOrRefStringWithPrefix: optional(text(MAX_FORMULA)),
    },
    ['id', 'name', 'formulaOrRefString'],
  ),
  'formula.mutation.remove-defined-name': object(definedName, ['id']),
}

/** `{ [id]: entry }` keyed by short ids */
function record(entry: Check): Check {
  return (value, path, budget) => {
    if (!isRecord(value)) bad(path, 'not an object')
    const keys = Object.keys(value)
    if (keys.length > MAX_RANGES) tooLarge(path, `more than ${MAX_RANGES} entries`)
    for (const key of keys) {
      if (RESERVED_KEYS.has(key)) bad(`${path}.${key}`, 'reserved key')
      id(key, `${path} key`, budget)
      entry(value[key], `${path}.${key}`, budget)
    }
  }
}

/** Throws a `WireMutationError` unless `params` is what mutation `mutationId` may carry on the wire */
export function checkWireMutation(mutationId: string, params: unknown): void {
  const check = Object.hasOwn(WIRE, mutationId) ? WIRE[mutationId] : undefined
  if (!check) throw new WireMutationError(`unknown mutation ${mutationId}`, false)
  const budget: Budget = { cells: MAX_CELLS, rows: MAX_ROWS, columns: MAX_COLUMNS }
  try {
    check(params, 'params', budget)
  } catch (error) {
    if (!(error instanceof WireMutationError)) throw error
    throw new WireMutationError(`${mutationId} ${error.message}`, error.tooLarge)
  }
}

/** The ids `checkWireMutation` knows, for the test that keeps them equal to the synced ids */
export function checkedMutationIds(): string[] {
  return Object.keys(WIRE)
}

/** The first of `mutations` the other pages would refuse, or null */
export function firstInvalid(
  mutations: readonly { id: string; params: unknown }[],
): WireMutationError | null {
  for (const mutation of mutations) {
    try {
      checkWireMutation(mutation.id, mutation.params)
    } catch (error) {
      if (error instanceof WireMutationError) return error
      throw error
    }
  }
  return null
}

/**
 * Whether a sheet holding `merges` stays within the merge bounds once `added` joins them. Every
 * page decides it on the same state (the log so far), so a merge it drops is dropped everywhere.
 */
export function mergesFit(merges: readonly Range[], added: readonly Range[]): boolean {
  if (merges.length + added.length > MAX_MERGES) return false
  return mergedCells(merges) + mergedCells(added) <= MAX_MERGED_CELLS
}
