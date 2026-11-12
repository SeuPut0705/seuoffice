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
