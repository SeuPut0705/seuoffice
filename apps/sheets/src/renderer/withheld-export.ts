/// Which sheets a copy would hand over with a cell hidden from the AI in it.
/// A PDF page is the value as text, and it records no mark, so whatever reads
/// the file later reads the cell. A mark whose record could not be read
/// withholds every cell (see redact-load.ts).

import type { RedactionIndex } from './ai/redact'
import { redactGuardForSheetExport } from './ai/redact-guard'

export interface ExportedSheet {
  readonly id: string
  readonly name: string
}

export function sheetsExposeWithheld(
  index: RedactionIndex,
  sheets: readonly ExportedSheet[],
): boolean {
  return sheets.some(
    (sheet) => redactGuardForSheetExport('pdf', index, sheet.id, sheet.name) !== null,
  )
}
