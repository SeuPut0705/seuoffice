/**
 * The save request of a co-editing page, as the engine takes it.
 *
 * The app's own save empties its journal with every save, so one request
 * carries what a person did since the last one, and its bounds are set for
 * that. A co-editing session's journal holds every edit since the session's
 * base file. Its structural records are sent compacted (collab-journal.ts),
 * and a request that still holds more than one save's worth is taken up to a
 * wider bound: an edit that would fill the room is refused before it runs, so
 * more can only come from several people using the last room at one moment.
 */
import { z } from 'zod'
import type { StructuralJournalOp } from '../renderer/edit-journal'
import {
  type WorkbookSaveRequest,
  type WorkbookStructuralOp,
  workbookSaveRequestSchema,
  workbookStructuralOpSchema,
} from '../shared/desktop-api'
import { compactStructuralOps, STRUCTURAL_OPS_LIMIT } from './collab-journal'

/** Every structural record a co-editing save takes, past the bound of one request */
const CO_EDITED_STRUCTURAL_OPS = 4 * STRUCTURAL_OPS_LIMIT

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
  const structuralOps = compactSaveStructuralOps(input.structuralOps)
  const parsed = workbookSaveRequestSchema.safeParse({
    ...input,
    structuralOps: structuralOps.slice(0, STRUCTURAL_OPS_LIMIT),
  })
  if (!parsed.success) {
    if (parsed.error.issues.every((issue) => issue.message === NOTHING_TO_APPLY)) return null
    throw parsed.error
  }
  if (structuralOps.length <= STRUCTURAL_OPS_LIMIT) return parsed.data
  const rest = z
    .array(workbookStructuralOpSchema)
    .max(CO_EDITED_STRUCTURAL_OPS - STRUCTURAL_OPS_LIMIT)
    .parse(structuralOps.slice(STRUCTURAL_OPS_LIMIT))
  return { ...parsed.data, structuralOps: [...parsed.data.structuralOps, ...rest] }
}
