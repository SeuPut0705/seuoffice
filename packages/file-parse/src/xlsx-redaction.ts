import type JSZip from 'jszip'
import { sanitizeLabel } from '@seuoffice/agent-core/redact-core'
import {
  REDACTION_PART_PATH,
  readRedactionRecord,
  type RedactionMark,
  type SheetRedactionState,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-redaction'
import { RedactionMarkError } from './redaction-error'
import type { DerivedSheet } from './xlsx-formula-redaction'

/**
 * Withheld cells of a workbook, read as another file's material.
 *
 * The sheet editor records the cells its reader withheld from a model in a
 * package part (`xl/gxRedactions.json`, keyed by sheet name) and copies the
 * same marks into hidden defined names, because a program that rebuilds the
 * package drops the part. Its own model gets `{{label}}` for such a cell and
 * neither its value nor its formula (apps/sheets `main/workbook-redactions.ts`,
 * `renderer/ai/redact.ts`).
 *
 * The record is read by the gateway's own reader, the one a save uses when it
 * has to move the marks itself, and the two copies are consulted in the
 * editor's order: the part when it reads, the defined names when the part is
 * missing or damaged (an empty copy beside a damaged part is not "no marks").
 * What the editor answers with "unreadable" (and then withholds every cell)
 * fails the read here.
 *
 * Two places are stricter than the editor, never looser. A part naming a
 * sheet the workbook does not have fails the read, where the editor drops
 * those marks: a sheet renamed in another program keeps its values hidden
 * instead of losing the mark with the name. And on a sheet that withholds
 * anything, a cell whose address cannot be read is withheld, because whether
 * it is one of the withheld cells cannot be decided.
 *
 * A formula that computes from a withheld cell is withheld as well, as
 * `{{private}}` (it is not the cell the reader labelled): see
 * `xlsx-formula-redaction`.
 */

const WORKBOOK_PART_PATH = 'xl/workbook.xml'

/** the label for a cell that could not be checked against the marks */
const UNKNOWN_LABEL = 'private'

const CELL_REF = /^([A-Za-z]{1,3})([1-9]\d{0,6})$/

/** the marks of every sheet that has any, by sheet name */
export type XlsxRedactions = ReadonlyMap<string, readonly RedactionMark[]>

async function readStates(zip: JSZip, workbookXml: string): Promise<SheetRedactionState[]> {
  try {
    return await readRedactionRecord(
      async () => zip.file(REDACTION_PART_PATH)?.async('text'),
      workbookXml,
    )
  } catch {
    throw new RedactionMarkError('the record of the cells withheld in this workbook cannot be read')
  }
}

/**
 * The cells this workbook withholds, or an empty map when it withholds none.
 * `sheetNames` are the sheets the caller is about to read, as it names them.
 */
export async function readXlsxRedactions(
  zip: JSZip,
  sheetNames: readonly string[],
): Promise<XlsxRedactions> {
  const workbookXml = await zip.file(WORKBOOK_PART_PATH)?.async('text')
  if (workbookXml === undefined) return new Map()
  const known = new Set(sheetNames)
  const bySheet = new Map<string, RedactionMark[]>()
  for (const state of await readStates(zip, workbookXml)) {
    if (state.marks.length === 0) continue
    if (!known.has(state.sheetName)) {
      throw new RedactionMarkError('cells are withheld on a sheet this workbook does not have')
    }
    const marks = bySheet.get(state.sheetName)
    if (marks) marks.push(...state.marks)
    else bySheet.set(state.sheetName, [...state.marks])
  }
  return bySheet
}

/** what a model reads in place of the cell: the editor's own marker for that label */
function marker(label: string): string {
  // a sheet's label goes through the stricter sanitiser (renderer/ai/redact.ts)
  return `{{${sanitizeLabel(label, { forComment: true }) || UNKNOWN_LABEL}}}`
}

/**
 * The marker standing in for the cell at `ref`, or null when the cell reads
 * as itself. `marks` are one sheet's marks and `derived` what the formula
 * trace found on it; a workbook without marks passes neither.
 */
export function withheldCellMarker(
  marks: readonly RedactionMark[] | undefined,
  ref: string | undefined,
  derived?: DerivedSheet,
  hasFormula = false,
): string | null {
  if (!marks && !derived) return null
  const at = ref === undefined ? null : CELL_REF.exec(ref)
  if (!at) return marks || derived?.any || hasFormula ? marker(UNKNOWN_LABEL) : null
  const row = Number(at[2]) - 1
  let column = 0
  for (const letter of at[1]!.toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64)
  column -= 1
  for (const mark of marks ?? []) {
    if (
      row >= mark.startRow &&
      row <= mark.endRow &&
      column >= mark.startColumn &&
      column <= mark.endColumn
    ) {
      return marker(mark.label)
    }
  }
  if (!derived) return null
  // A formula the worksheet parser sees and the scan did not was never traced.
  if (derived.withheld(row, column) || (hasFormula && !derived.knownFormula(row, column))) {
    return marker(UNKNOWN_LABEL)
  }
  return null
}
