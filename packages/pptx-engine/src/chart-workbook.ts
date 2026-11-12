/**
 * The workbook embedded beside a chart part, which PowerPoint and Word open for
 * "Edit Data": one Sheet1 with the categories in column A and one column per
 * series from B, the cells the chart's c:f references point at.
 *
 *   A1        | B1 (ser 0 name) | C1 (ser 1 name) ...
 *   A2 (cat0) | B2 (val 0,0)    | C2 (val 1,0)   ...
 */
import { call } from './engine'

export const CHART_WORKBOOK_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package'
export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
// Series data columns start at B (column A holds the categories):
// 0 → B … 24 → Z, 25 → AA, 26 → AB, … (plain charCode arithmetic breaks past Z).
export const colLetter = (i: number): string => {
  let n = i + 2 // 1-based column number: A = 1, B = 2
  let label = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    label = String.fromCharCode(65 + rem) + label
    n = Math.floor((n - 1) / 26)
  }
  return label
}
export interface ChartWorkbookData {
  categories: string[]
  series: Array<{ name: string; values: (number | null | undefined)[] }>
  /** column A as numbers instead of category names: a scatter chart's x values */
  xValues?: number[]
}
/** The workbook's parts, by path inside the xlsx package. */
export function chartWorkbookParts(arg0: ChartWorkbookData): Record<string, string> {
  return call('chartWorkbookParts', [arg0]) as never
}
/**
 * A zip of `files`, stored without compression: the chart engines insert charts
 * synchronously, and a chart's workbook is a few hundred bytes.
 */
export function storedZip(files: Record<string, string>): Uint8Array {
  return call('storedZip', [files]) as never
}
export function chartWorkbookXlsx(data: ChartWorkbookData): Uint8Array {
  return call('chartWorkbookXlsx', [data]) as never
}