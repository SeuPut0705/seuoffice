import type JSZip from 'jszip'
import { sanitizeLabel } from '@genoffice/agent-core/redact-core'
import {
  REDACTION_PART_PATH,
  parseRedactionNameMirror,
  parseRedactionPart,
  type RedactionMark,
  type SheetRedactionState,
} from '@genoffice/xlsx-gateway/gateway/xlsx-redaction'
import { parseSheetElements } from '@genoffice/xlsx-gateway/gateway/xlsx-sheets'
import { RedactionMarkError } from './redaction-error'

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
 * The record is parsed by the gateway's own parsers, the ones the editor
 * calls, and the two copies are consulted in the editor's order: the part
 * when it reads, the defined names when the part is missing or damaged. What
 * the editor answers with "unreadable" (and then withholds every cell) fails
 * the read here.
 *
 * Two places are stricter than the editor, never looser. A part naming a
 * sheet the workbook does not have fails the read, where the editor drops
 * those marks: a sheet renamed in another program keeps its values hidden
 * instead of losing the mark with the name. And on a sheet that has marks, a
 * cell whose address cannot be read is withheld, because whether a mark
 * covers it cannot be decided.
 */

const WORKBOOK_PART_PATH = 'xl/workbook.xml'

/** the label for a cell that could not be checked against the marks */
const UNKNOWN_LABEL = 'private'

const CELL_REF = /^([A-Za-z]{1,3})([1-9]\d{0,6})$/

/** the marks of every sheet that has any, by sheet name */
export type XlsxRedactions = ReadonlyMap<string, readonly RedactionMark[]>

async function readStates(zip: JSZip, workbookXml: string): Promise<SheetRedactionState[]> {
  const part = zip.file(REDACTION_PART_PATH)
  let partDamaged = false
  if (part) {
    try {
      return parseRedactionPart(await part.async('text'))
    } catch {
      partDamaged = true
    }
  }
  try {
    const mirrored = parseRedactionNameMirror(
      workbookXml,
      parseSheetElements(workbookXml).map((sheet) => sheet.name),
    )
    // the copy in the defined names answers for a damaged part only when it
    // has marks to give: an empty copy beside a damaged part is not "no marks"
    if (!partDamaged || mirrored.length > 0) return mirrored
  } catch {
    // falls through to the refusal: the copy is damaged too
  }
  throw new RedactionMarkError('the record of the cells withheld in this workbook cannot be read')
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
 * The marker standing in for the cell at `ref`, or null when no mark of this
 * sheet covers it. `marks` are one sheet's marks; pass none for a sheet
 * without any and every cell reads as itself.
 */
export function withheldCellMarker(
  marks: readonly RedactionMark[] | undefined,
  ref: string | undefined,
): string | null {
  if (!marks) return null
  const at = ref === undefined ? null : CELL_REF.exec(ref)
  if (!at) return marker(UNKNOWN_LABEL)
  const row = Number(at[2]) - 1
  let column = 0
  for (const letter of at[1]!.toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64)
  column -= 1
  for (const mark of marks) {
    if (
      row >= mark.startRow &&
      row <= mark.endRow &&
      column >= mark.startColumn &&
      column <= mark.endColumn
    ) {
      return marker(mark.label)
    }
  }
  return null
}
