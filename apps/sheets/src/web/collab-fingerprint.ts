/**
 * The co-editing fingerprint of a workbook: a hash of what people type and
 * format, equal on every page that holds the same edits. It covers the sheet
 * order and each sheet's name, visibility, tab color, view settings, sizes of
 * rows and columns, merges, and every cell's value, formula text, rich text
 * and resolved style, plus the defined names. It leaves out what each page
 * derives on its own: formula results (a formula cell counts by its text),
 * array-formula spill cells, measured auto heights, style ids (a style counts
 * by its content) and empty or default row and column records.
 *
 * A cell's number format is left out as well. The formula engine writes the
 * format of a formula's sources into the formula cell's own style, together
 * with the result: later than the edit, never on a page that does not
 * calculate, and once only (a cell that has a format keeps it). The style then
 * stays when the formula is typed over, and nothing in the workbook tells such
 * a format from one a person chose. Number formats of rows, columns and the
 * sheet default are always a person's and are covered.
 */
import type { ICellData, IStyleData, Workbook, Worksheet } from '@univerjs/core'
import { CellValueType } from '@univerjs/core'

/** `object` with its keys sorted and its nulls, undefineds and empty objects dropped */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const item = canonical((value as Record<string, unknown>)[key])
    if (item === null || item === undefined) continue
    if (typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) continue
    out[key] = item
  }
  return out
}

function styleOf(workbook: Workbook, s: unknown): unknown {
  if (!s) return undefined
  const style = typeof s === 'string' ? workbook.getStyles().get(s) : (s as IStyleData)
  return style ? canonical(style) : undefined
}

/** A cell's style without its number format, which the formula engine may have put there */
function cellStyleOf(workbook: Workbook, s: unknown): unknown {
  if (!s) return undefined
  const style = typeof s === 'string' ? workbook.getStyles().get(s) : (s as IStyleData)
  if (!style) return undefined
  const { n: _derivable, ...own } = style
  return canonical(own)
}

function cellPrint(workbook: Workbook, cell: ICellData): unknown {
  const formula = typeof cell.f === 'string' && cell.f !== '' ? cell.f : undefined
  const shared = typeof cell.si === 'string' && cell.si !== '' ? cell.si : undefined
  const print: Record<string, unknown> = { s: cellStyleOf(workbook, cell.s) }
  if (formula !== undefined || shared !== undefined) {
    print.f = formula
    print.si = shared
  } else if (cell.v !== undefined && cell.v !== null) {
    // the stored type follows from the value except for booleans and forced text
    print.v = cell.v
    if (cell.t === CellValueType.BOOLEAN || cell.t === CellValueType.FORCE_STRING) print.t = cell.t
  }
  if (cell.p?.body) print.p = { dataStream: cell.p.body.dataStream, textRuns: cell.p.body.textRuns }
  if (cell.custom) print.custom = cell.custom
  return canonical(print)
}

function linesPrint(
  workbook: Workbook,
  data: Record<number, Record<string, unknown> | undefined>,
  keys: string[],
): unknown {
  const out: Record<string, unknown> = {}
  for (const [index, line] of Object.entries(data)) {
    if (!line) continue
    const print: Record<string, unknown> = {}
    for (const key of keys) {
      const value = line[key]
      if (value === undefined || value === null) continue
      // 0 is the default of every flag kept here
      if (key !== 's' && key !== 'h' && key !== 'w' && value === 0) continue
      print[key] = key === 's' ? styleOf(workbook, value) : value
    }
    const kept = canonical(print)
    if (kept && Object.keys(kept as object).length > 0) out[index] = kept
  }
  return out
}

function sheetPrint(
  workbook: Workbook,
  sheet: Worksheet,
  spills: (row: number, column: number) => boolean,
): unknown {
  const config = sheet.getConfig()
  const cells: Record<string, Record<string, unknown>> = {}
  sheet.getCellMatrix().forValue((row, column, cell) => {
    // a spill cell holds a result of the formula above it; a cell with its own formula is not one
    if (!cell || (!cell.f && !cell.si && spills(row, column))) return
    const print = cellPrint(workbook, cell)
    if (print && Object.keys(print as object).length > 0) (cells[row] ??= {})[column] = print
  })
  const merges = config.mergeData
    .map((m) => [m.startRow, m.startColumn, m.endRow, m.endColumn])
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]! || a[3]! - b[3]!)
  return canonical({
    id: sheet.getSheetId(),
    name: config.name,
    hidden: config.hidden || undefined,
    tabColor: config.tabColor || undefined,
    rowCount: config.rowCount,
    columnCount: config.columnCount,
    defaultRowHeight: config.defaultRowHeight,
    defaultColumnWidth: config.defaultColumnWidth,
    defaultStyle: styleOf(workbook, sheet.getDefaultCellStyle()),
    freeze: config.freeze,
    showGridlines: config.showGridlines,
    gridlinesColor: config.gridlinesColor,
    rightToLeft: config.rightToLeft || undefined,
    merges,
    rows: linesPrint(workbook, sheet.getRowManager().getRowData() as never, ['h', 'hd', 'ia', 's']),
    columns: linesPrint(workbook, sheet.getColumnManager().getColumnData() as never, [
      'w',
      'hd',
      's',
    ]),
    cells,
  })
}

export interface FingerprintSources {
  /** array-formula spill cells: results, written by the formula engine on each page */
  spill?: ((sheetId: string, row: number, column: number) => boolean) | undefined
  /** defined names as the formula engine holds them */
  definedNames?(): {
    id: string
    name: string
    formulaOrRefString: string
    localSheetId?: string
    hidden?: boolean
    comment?: string
  }[]
}

/** The canonical text the hash covers; read synchronously, so it is the state at the call */
export function fingerprintText(workbook: Workbook, sources: FingerprintSources = {}): string {
  const sheets = workbook.getSheetOrders().map((id) => {
    const sheet = workbook.getSheetBySheetId(id)
    return sheet
      ? sheetPrint(workbook, sheet, (row, column) => sources.spill?.(id, row, column) ?? false)
      : null
  })
  const names = (sources.definedNames?.() ?? [])
    .map((name) =>
      // a name loaded from the file has a random id on each page; it is known by its name
      canonical({
        name: name.name,
        formulaOrRefString: name.formulaOrRefString,
        localSheetId: name.localSheetId,
        hidden: name.hidden || undefined,
        comment: name.comment || undefined,
      }),
    )
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  return JSON.stringify({ sheets, names })
}

export async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
