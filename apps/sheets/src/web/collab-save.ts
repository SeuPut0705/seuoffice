/**
 * The save request of a co-editing page, as the engine takes it.
 *
 * The app's own save empties its journal with every save, so one request
 * carries what a person did since the last one. A co-editing session's
 * journal holds every edit since the session's base file, so its structural
 * records are sent compacted (collab-journal.ts).
 */
import type { StructuralJournalOp } from '../renderer/edit-journal'
import {
  type WorkbookSaveRequest,
  type WorkbookStructuralOp,
  workbookSaveRequestSchema,
} from '../shared/desktop-api'
import { compactStructuralOps } from './collab-journal'

/** The request schema's answer to a request that changes nothing */
const NOTHING_TO_APPLY = 'A save needs at least one edit.'

/** `ops` (each in the coordinates the ones before it on its sheet left) in fewer records */
export function compactSaveStructuralOps(
  ops: readonly WorkbookStructuralOp[],
): WorkbookStructuralOp[] {
  const bySheet = new Map<string, StructuralJournalOp[]>()
  for (const { sheetId, ...record } of ops) {
    const sheetOps = bySheet.get(sheetId) ?? []
    // a request's record is the journal's with its sheet (edit-journal.ts, toSaveStructuralOps);
    // the two types differ only in how an absent optional field is spelled
    sheetOps.push(record as StructuralJournalOp)
    bySheet.set(sheetId, sheetOps)
  }
  return [...bySheet].flatMap(([sheetId, sheetOps]) =>
    compactStructuralOps(sheetOps).map((op) => ({ sheetId, ...op })),
  )
}

/**
 * `input` checked as a save request; null when it changes nothing, which is
 * the base file as it is (a save before anyone's first edit).
 */
export function coEditedSaveRequest(input: WorkbookSaveRequest): WorkbookSaveRequest | null {
  const parsed = workbookSaveRequestSchema.safeParse({
    ...input,
    structuralOps: compactSaveStructuralOps(input.structuralOps),
  })
  if (parsed.success) return parsed.data
  if (parsed.error.issues.every((issue) => issue.message === NOTHING_TO_APPLY)) return null
  throw parsed.error
}
