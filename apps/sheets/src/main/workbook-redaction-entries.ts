/**
 * The marks that hide cells from the model, read out of a workbook package
 * through two questions about it: is this entry there, and what is its text.
 *
 * Kept apart from `workbook-redactions.ts` on purpose. That module answers the
 * two questions through the desktop's archive client, whose module also holds
 * the save planner; the web build asks them of its engine worker on every
 * open, a view-only page included, and must not load the planner to do it.
 * Nothing here may import the planner or the archive client.
 *
 * Why the answer has three states, and why there is a second place to read
 * the marks from, is told in `workbook-redactions.ts`.
 */
import {
  REDACTION_PART_PATH,
  parseRedactionNameMirror,
  parseRedactionPart,
  type SheetRedactionState,
} from '@seuoffice/xlsx-gateway/gateway/xlsx-redaction'
import { parseSheetElements } from '@seuoffice/xlsx-gateway/gateway/xlsx-sheets'

const WORKBOOK_PART_PATH = 'xl/workbook.xml'

/**
 * `source` says which copy answered, so the renderer can tell the reader that
 * the file came back from somewhere that drops the part. It never changes
 * which cells are withheld — both copies are written from the same state on
 * the same save — it only decides whether the workbook is fully intact.
 */
export type RedactionPartRead =
  | { readonly status: 'absent' }
  | {
      readonly status: 'ok'
      readonly states: readonly SheetRedactionState[]
      readonly source: 'part' | 'mirror'
    }
  | { readonly status: 'unreadable'; readonly error: string }

/** The two reads the marks need from a package; the web build answers them from its engine worker. */
export interface RedactionEntryReader {
  has(path: string): Promise<boolean>
  readText(path: string): Promise<string>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function readRedactionEntries(
  reader: RedactionEntryReader,
): Promise<RedactionPartRead> {
  if (await reader.has(REDACTION_PART_PATH)) {
    try {
      const text = await reader.readText(REDACTION_PART_PATH)
      return { status: 'ok', states: parseRedactionPart(text), source: 'part' }
    } catch (error) {
      // The mirror is a rescue, not a second diagnosis: only an answer it can
      // actually give replaces the part's. When it cannot, the part's error is
      // the one worth showing — it names what is actually wrong with the file.
      const fromMirror = await readRedactionNameMirror(reader)
      if (fromMirror.status === 'ok') return fromMirror
      return { status: 'unreadable', error: messageOf(error) }
    }
  }
  return readRedactionNameMirror(reader)
}

/**
 * Rebuild the marks from the workbook's defined names.
 *
 * A workbook that never withheld anything has no mirrored entries, which is
 * the `absent` this returns — the same answer the missing part gives, and for
 * the same reason. A mirrored entry this version cannot read is `unreadable`
 * for the reason the part is: a record of what was withheld that fails to
 * parse must not be read as "nothing was withheld".
 */
async function readRedactionNameMirror(reader: RedactionEntryReader): Promise<RedactionPartRead> {
  try {
    const workbookXml = await reader.readText(WORKBOOK_PART_PATH)
    // The mirror records each sheet by its position, so the positions are read
    // back out of the same file — the one the marks have to be resolved against.
    const states = parseRedactionNameMirror(
      workbookXml,
      parseSheetElements(workbookXml).map((sheet) => sheet.name),
    )
    return states.length === 0 ? { status: 'absent' } : { status: 'ok', states, source: 'mirror' }
  } catch (error) {
    return { status: 'unreadable', error: messageOf(error) }
  }
}
