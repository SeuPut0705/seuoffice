import { callEngine } from './engine'

export interface XlsxTextOptions {
  /// Sheet XML past this many extracted characters is not even parsed.
  maxChars?: number
  /// In a workbook that withholds cells, every sheet is scanned for the
  /// formulas that depend on them; a sheet whose XML is larger than this is
  /// withheld whole instead.
  formulaScanMaxBytes?: number
}

/** How many bytes of sheet XML are read for a budget of extracted characters. */
export function sheetXmlByteLimit(budgetChars: number): number {
  // Infinity crosses as its spelling
  return Number(callEngine<number | string>('sheetXmlByteLimit', [budgetChars]))
}

/** Drop whole rows past the budget, keeping the document well-formed; a
 *  truncated prefix is always cut back to its last complete row. */
export function clipSheetXml(xml: string, budgetChars: number, truncated = false): string {
  return callEngine<string>('clipSheetXml', [xml, budgetChars, truncated])
}

/** extract sheet text from an xlsx: one "# SheetName" section per sheet, cells joined with " | " */
export async function xlsxToText(bytes: Uint8Array, opts: XlsxTextOptions = {}): Promise<string> {
  return callEngine<string>('xlsxToText', [bytes, opts])
}

/** what a model reads in place of text that may be a withheld cell (a chart title, say) */
export const UNKNOWN_CELL_MARKER = '{{private}}'

/** The engine keeps a few opened records of withheld cells; one it let go is opened again. */
const EVICTED = 'WithheldEvicted'

/**
 * A reader for the cells of a workbook that its sheet editor withholds from a
 * model: `marker(sheet, ref, hasFormula)` is the placeholder to give instead
 * of the cell's value and formula, or null when the cell reads as itself. A
 * workbook that withholds nothing gives null; one whose record cannot be read
 * throws RedactionMarkError.
 */
export async function xlsxWithheldCells(
  bytes: Uint8Array,
): Promise<((sheet: string, ref: string, hasFormula: boolean) => string | null) | null> {
  let handle = callEngine<number | null>('xlsxWithheldOpen', [bytes])
  if (handle === null) return null
  return (sheet, ref, hasFormula) => {
    try {
      return callEngine<string | null>('xlsxWithheldMarker', [handle, sheet, ref, hasFormula])
    } catch (error) {
      if (!(error instanceof Error) || error.name !== EVICTED) throw error
      handle = callEngine<number>('xlsxWithheldOpen', [bytes])
      return callEngine<string | null>('xlsxWithheldMarker', [handle, sheet, ref, hasFormula])
    }
  }
}
