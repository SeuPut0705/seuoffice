import { placeholderSource } from '@seuoffice/agent-core/redact-core'
import {
  columnIndex,
  formatAddress,
  parseAddress,
  parseRange,
  type RangeBounds,
} from '@seuoffice/xlsx-gateway/domain/cell-address'
import type { WorksheetState } from '@seuoffice/xlsx-gateway/domain/workbook.types'
import type { DefinedNameEntry } from '@seuoffice/xlsx-gateway/gateway/xlsx-defined-names'
import {
  readRedactionRecord,
  REDACTION_PART_PATH,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-redaction'
import { loadWorkbookZip, withheldCellsIn } from './xlsx'

/**
 * Stop a headless edit from reading, overwriting, moving or publishing a cell
 * hidden from AI. Mirrors the sheet editor's write guard
 * (apps/sheets/src/renderer/ai/redact-guard.ts), which this package cannot
 * import: that module sits beside the editor's Univer session.
 *
 * Reading the cell back is already withheld (see `withheldCellsOf`); what is
 * left is an edit that would replace what the reader hid, copy it into a cell
 * nothing withholds, or compute from it and write the result out. Every op
 * names its cells in A1 notation, so the test is a rectangle intersection with
 * the marks and with the cells computed from them.
 */

interface Withheld extends RangeBounds {
  /** the label the model may see, or null for a cell that merely computes from a hidden one */
  readonly label: string | null
}

export interface WithheldAreas {
  /** sheet id → rectangles: the marks, then the formula cells computed from them */
  on(sheetId: string): readonly Withheld[]
  /** the marks alone: what a shift moves out from under its record */
  marks(sheetId: string): readonly Withheld[]
  /** defined names whose range holds something withheld */
  readonly names: ReadonlySet<string>
}

/**
 * The cells of a workbook withheld from a model, or null when it withholds
 * none. A record that cannot be read refuses the edit, as every reader does.
 */
export async function withheldAreasOf(
  bytes: Uint8Array,
  sheets: readonly Pick<WorksheetState, 'id' | 'name' | 'cells'>[],
  definedNames: readonly DefinedNameEntry[],
): Promise<WithheldAreas | null> {
  const withheld = await withheldCellsIn(bytes)
  if (withheld === null) return null
  const zip = await loadWorkbookZip(bytes)
  const workbookXml = (await zip.file('xl/workbook.xml')?.async('string')) ?? ''
  const states = await readRedactionRecord(
    async () => zip.file(REDACTION_PART_PATH)?.async('string'),
    workbookXml,
  )
  const idByName = new Map(sheets.map((sheet) => [sheet.name, sheet.id]))
  const marksBySheet = new Map<string, Withheld[]>()
  for (const state of states) {
    const id = idByName.get(state.sheetName)
    if (id === undefined) continue
    marksBySheet.set(id, [
      ...(marksBySheet.get(id) ?? []),
      ...state.marks.map((m) => ({ ...m, label: m.label })),
    ])
  }
  const bySheet = new Map<string, Withheld[]>()
  for (const sheet of sheets) {
    const marks = marksBySheet.get(sheet.id) ?? []
    const derived: Withheld[] = []
    for (const [address, cell] of Object.entries(sheet.cells)) {
      if (withheld(sheet.name, address, cell.formula !== undefined) === null) continue
      const { row, column } = parseAddress(address)
      if (marks.some((m) => covers(m, row, column))) continue
      derived.push({
        startRow: row,
        endRow: row,
        startColumn: column,
        endColumn: column,
        label: null,
      })
    }
    bySheet.set(sheet.id, [...marks, ...derived])
  }
  const names = new Set<string>()
  for (const entry of definedNames) {
    for (const site of formulaRefs(`=${entry.formula}`)) {
      const id = site.sheetName === undefined ? undefined : idByName.get(site.sheetName)
      if (id !== undefined && (bySheet.get(id) ?? []).some((a) => intersects(a, site.bounds))) {
        names.add(entry.name.toLowerCase())
      }
    }
  }
  return {
    on: (sheetId) => bySheet.get(sheetId) ?? [],
    marks: (sheetId) => marksBySheet.get(sheetId) ?? [],
    names,
  }
}

function covers(area: RangeBounds, row: number, column: number): boolean {
  return (
    row >= area.startRow &&
    row <= area.endRow &&
    column >= area.startColumn &&
    column <= area.endColumn
  )
}

function intersects(area: RangeBounds, bounds: RangeBounds): boolean {
  return (
    area.startRow <= bounds.endRow &&
    area.endRow >= bounds.startRow &&
    area.startColumn <= bounds.endColumn &&
    area.endColumn >= bounds.startColumn
  )
}

const MAX_ROW = 1_048_575
const MAX_COLUMN = 16_383
const ENTIRE_SHEET: RangeBounds = {
  startRow: 0,
  endRow: Number.MAX_SAFE_INTEGER,
  startColumn: 0,
  endColumn: Number.MAX_SAFE_INTEGER,
}

type Op = Record<string, unknown>

/** op name → the cells it writes */
const WRITES: Record<string, (op: Op) => RangeBounds | null> = {
  set_cell: (op) => cellOf(op.address),
  set_formula: (op) => cellOf(op.address),
  clear_cell: (op) => cellOf(op.address),
  set_range: (op) => gridOf(op),
  clear_range: (op) => rangeOf(op.range),
  fill_range: (op) => rangeOf(op.target),
  copy_range: (op) => pasteOf(op),
  move_range: (op) => pasteOf(op),
  convert_to_values: (op) => rangeOf(op.range),
  sort_range: (op) => rangeOf(op.range),
  find_replace: (op) => rangeOf(op.range),
  // merging keeps the top-left value only; a one-cell merge changes nothing
  merge_cells: (op) => {
    const bounds = rangeOf(op.range)
    if (!bounds) return null
    return bounds.startRow === bounds.endRow && bounds.startColumn === bounds.endColumn
      ? null
      : bounds
  },
  add_table: (op) => rangeOf(op.range),
  delete_rows: (op) => rowBand(op.row, op.count),
  delete_cols: (op) => colBand(op.column, op.count),
  delete_sheet: () => ENTIRE_SHEET,
  // a copy carries the values to a sheet that has no marks
  duplicate_sheet: () => ENTIRE_SHEET,
}

interface ReadSite {
  sheetId?: string | undefined
  sheetName?: string | undefined
  bounds: RangeBounds
}

/** op name → the cells it takes values from */
const READS: Record<string, (op: Op) => ReadSite[]> = {
  copy_range: (op) => sourceOf(op),
  move_range: (op) => sourceOf(op),
  fill_range: (op) => sourceOf(op),
  set_formula: (op) => formulaRefs(op.formula),
  set_cell: (op) => formulaRefs(op.value),
  set_range: (op) => {
    const values = Array.isArray(op.values) ? op.values : []
    return values.flatMap((row) => (Array.isArray(row) ? row.flatMap(formulaRefs) : []))
  },
  add_pivot: (op) => {
    const bounds = rangeOf(op.sourceRange)
    return bounds ? [{ bounds }] : []
  },
}

function sourceOf(op: Op): ReadSite[] {
  const bounds = rangeOf(op.source)
  if (!bounds) return []
  return [{ sheetId: typeof op.sourceSheetId === 'string' ? op.sourceSheetId : undefined, bounds }]
}

/** A1 references of a formula, string literals set aside; a sheet prefix stays a name */
const FORMULA_REF =
  /(?:(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)(?![\w(])/g

function formulaRefs(value: unknown): ReadSite[] {
  if (typeof value !== 'string' || !value.startsWith('=')) return []
  const bare = value.replace(/"(?:[^"]|"")*"/g, '""')
  const out: ReadSite[] = []
  for (const m of bare.matchAll(FORMULA_REF)) {
    const bounds = refBounds(m[3]!.replace(/\$/g, ''))
    if (!bounds) continue
    out.push({ sheetName: m[1]?.replace(/''/g, "'") ?? m[2], bounds })
  }
  return out
}

/** the names a formula spells that are not cell references or function calls */
function namesIn(value: unknown): string[] {
  if (typeof value !== 'string' || !value.startsWith('=')) return []
  const bare = value.replace(/"(?:[^"]|"")*"/g, '""')
  return [...bare.matchAll(/(?<![\w.!'$])([A-Za-z_\\][\w.\\]*)(?![\w.(!])/g)].map((m) => m[1]!)
}

function refBounds(ref: string): RangeBounds | null {
  const cols = /^([A-Z]{1,3}):([A-Z]{1,3})$/.exec(ref)
  if (cols) {
    const a = columnIndex(cols[1]!)
    const b = columnIndex(cols[2]!)
    return { startRow: 0, endRow: MAX_ROW, startColumn: Math.min(a, b), endColumn: Math.max(a, b) }
  }
  const rows = /^(\d+):(\d+)$/.exec(ref)
  if (rows) {
    const a = Number(rows[1]) - 1
    const b = Number(rows[2]) - 1
    return {
      startRow: Math.min(a, b),
      endRow: Math.max(a, b),
      startColumn: 0,
      endColumn: MAX_COLUMN,
    }
  }
  return ref.includes(':') ? rangeOf(ref) : cellOf(ref)
}

/** ops that shift every cell at or below a point: refused when that carries a mark away from its cell */
const SHIFTS: Record<string, (op: Op) => (mark: RangeBounds) => boolean> = {
  insert_rows: (op) => {
    const from = rowStart(op.row)
    return (mark) => mark.startRow >= from
  },
  insert_cols: (op) => {
    const from = colStart(op.column)
    return (mark) => mark.startColumn >= from
  },
}

function cellOf(address: unknown): RangeBounds | null {
  if (typeof address !== 'string') return null
  try {
    const { row, column } = parseAddress(address)
    return { startRow: row, endRow: row, startColumn: column, endColumn: column }
  } catch {
    return null
  }
}

function rangeOf(range: unknown): RangeBounds | null {
  if (typeof range !== 'string') return null
  try {
    return parseRange(range)
  } catch {
    return null
  }
}

/**
 * Where a copy or move lands: a target that is one cell is the top-left of a
 * block the size of the source, so the cell alone would wave a paste through a
 * mark one column on.
 */
function pasteOf(op: Op): RangeBounds | null {
  const target = rangeOf(op.target)
  const source = rangeOf(op.source)
  if (!target || !source) return target
  const single = target.startRow === target.endRow && target.startColumn === target.endColumn
  if (!single) return target
  return {
    ...target,
    endRow: target.startRow + source.endRow - source.startRow,
    endColumn: target.startColumn + source.endColumn - source.startColumn,
  }
}

/** the whole grid a set_range writes: the anchor alone would wave a write through a mark one column on */
function gridOf(op: Op): RangeBounds | null {
  const explicit = rangeOf(op.range)
  const start = cellOf(op.start)
  if (!start || explicit) return explicit ?? start
  const values = op.values
  if (!Array.isArray(values) || values.length === 0) return start
  const width = values.reduce(
    (widest, row) => (Array.isArray(row) && row.length > widest ? row.length : widest),
    0,
  )
  return {
    startRow: start.startRow,
    endRow: start.startRow + values.length - 1,
    startColumn: start.startColumn,
    endColumn: start.startColumn + width - 1,
  }
}

function rowStart(row: unknown): number {
  return typeof row === 'number' && Number.isInteger(row) && row > 0 ? row - 1 : 0
}

function colStart(column: unknown): number {
  if (typeof column !== 'string' || column.length === 0) return 0
  try {
    return columnIndex(column)
  } catch {
    return 0
  }
}

function spanOf(count: unknown): number {
  return typeof count === 'number' && count > 0 ? Math.floor(count) : 1
}

function rowBand(row: unknown, count: unknown): RangeBounds {
  const start = rowStart(row)
  return {
    startRow: start,
    endRow: start + spanOf(count) - 1,
    startColumn: 0,
    endColumn: MAX_COLUMN,
  }
}

function colBand(column: unknown, count: unknown): RangeBounds {
  const start = colStart(column)
  return { startRow: 0, endRow: MAX_ROW, startColumn: start, endColumn: start + spanOf(count) - 1 }
}

function refusal(
  area: Withheld,
  bounds: RangeBounds,
  sheetName: string | undefined,
  reason: string,
): string {
  const row = Math.max(area.startRow, bounds.startRow)
  const column = Math.max(area.startColumn, bounds.startColumn)
  const address = formatAddress(row, column)
  const where = sheetName ? `${sheetName}!${address}` : address
  return `${reason} (${where}, ${placeholderSource(area.label ?? 'private')})`
}

/**
 * The first reason one op may not run over the withheld cells, or null.
 * `op` is as the DSL normalizes it: sheets named by id.
 */
export function withheldRefusal(
  op: Op,
  areas: WithheldAreas,
  sheetNameOf: (sheetId: string) => string | undefined,
  sheetIdOf: (sheetName: string) => string | undefined,
): string | null {
  const name = String(op.op ?? '')
  const sheetId = typeof op.sheetId === 'string' ? op.sheetId : ''
  if (!name || !sheetId) return null

  for (const site of READS[name]?.(op) ?? []) {
    const readSheetId =
      site.sheetId ?? (site.sheetName !== undefined ? sheetIdOf(site.sheetName) : sheetId)
    if (!readSheetId) continue
    for (const area of areas.on(readSheetId)) {
      if (!intersects(area, site.bounds)) continue
      return refusal(
        area,
        site.bounds,
        sheetNameOf(readSheetId),
        `${name} reads a cell hidden from AI; copying, moving or referencing it would put its value where the model can see it. Leave it out`,
      )
    }
  }
  // a name for a hidden range reads it as much as the range does
  if (areas.names.size > 0) {
    const spelled = [op.formula, op.value, ...(Array.isArray(op.values) ? op.values.flat() : [])]
    for (const text of spelled) {
      const hit = namesIn(text).find((n) => areas.names.has(n.toLowerCase()))
      if (hit === undefined) continue
      return `${name} reads a cell hidden from AI through the name ${hit}. Leave it out`
    }
  }

  const shift = SHIFTS[name]
  if (shift) {
    const shifts = shift(op)
    for (const mark of areas.marks(sheetId)) {
      if (!shifts(mark)) continue
      return refusal(
        mark,
        { ...mark, endRow: mark.startRow, endColumn: mark.startColumn },
        sheetNameOf(sheetId),
        `${name} would shift a cell hidden from AI out from under its mark`,
      )
    }
    return null
  }

  const bounds = WRITES[name]?.(op)
  if (!bounds) return null
  for (const area of areas.on(sheetId)) {
    if (!intersects(area, bounds)) continue
    return refusal(
      area,
      bounds,
      sheetNameOf(sheetId),
      `${name} would write into a cell hidden from AI; it was never shown those values, so it cannot have meant to replace them. Write around it`,
    )
  }
  return null
}
