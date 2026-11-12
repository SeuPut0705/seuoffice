/**
 * Where the file's privacy marks sit on the grid of this session.
 *
 * The marks are kept as the file holds them: keyed by the name the FILE knows
 * each sheet by, in the file's coordinates. That is what a save sends — the
 * gateway renames, removes and shifts them with the sheet edits of the same
 * save — so nothing here moves a stored mark. What the grid, the tint and the
 * AI ask is derived instead, per sheet id, by replaying the journal.
 *
 * Sheet names are not used to find a sheet on screen: a person renames sheets
 * mid-session, and marks looked up by the current name were dropped (or, after
 * two sheets swapped names, laid over the other sheet's cells) until the next
 * save and reopen.
 */
import type { SheetRedactionState } from '@genoffice/xlsx-gateway/gateway/xlsx-redaction'

import {
  redactionIndexBySheetId,
  type CellMark,
  type RedactionIndex,
  type SheetRefLike,
} from './ai/redact'
import { resolveDuplicateSource, type EditJournal } from './edit-journal'
import type { MarkKey } from './redact-actions'
import { shiftMarksThroughOps } from './redact-marks-shift'
import { screenToFile } from './view-transform'

/**
 * The file sheet whose part a copy made this session will be cloned from
 * (through copies of copies), for every copy still on screen.
 *
 * A copy holds its source's values, so it answers with its source's marks: the
 * marks the store holds for the source now, moved through the copy's own row
 * and column ops (the journal hands a copy its source's pending ops when it is
 * made, and records the copy's later ones). That is exactly what the save
 * writes for it — the gateway gives a sheet added as a copy the marks of
 * `sourceSheetName`, shifted by the ops addressed to the copy — so the store
 * never holds an entry for a copy, and the save cannot apply one twice.
 */
function unsavedCopies(journal: EditJournal): { copyId: string; sourceId: string }[] {
  const copies: { copyId: string; sourceId: string }[] = []
  for (const [copyId, added] of journal.sheets.added) {
    if (added.sourceSheetId === undefined || journal.sheets.removed.has(copyId)) continue
    const sourceId = resolveDuplicateSource(journal, copyId)
    if (sourceId !== undefined) copies.push({ copyId, sourceId })
  }
  return copies
}

/**
 * The index every reader asks, for the session as it stands now.
 *
 * `fileSheets` are the sheets as the file was opened (their ids are stable for
 * the session, their names are the ones the marks are keyed by).
 */
export function sessionRedactionIndex(
  states: readonly SheetRedactionState[],
  fileSheets: readonly SheetRefLike[],
  journal: EditJournal,
): RedactionIndex {
  const marksByFileName = new Map<string, readonly CellMark[]>()
  for (const state of states) {
    marksByFileName.set(state.sheetName, [
      ...(marksByFileName.get(state.sheetName) ?? []),
      ...state.marks,
    ])
  }
  const onScreen = new Map<string, CellMark[]>()
  const place = (sheetId: string, fileName: string | undefined): void => {
    const marks = fileName === undefined ? undefined : marksByFileName.get(fileName)
    if (!marks || marks.length === 0) return
    const placed = shiftMarksThroughOps(marks, journal.structuralOps.get(sheetId) ?? [])
    if (placed.length > 0) onScreen.set(sheetId, placed)
  }
  const fileNameById = new Map(fileSheets.map((sheet) => [sheet.id, sheet.name]))
  for (const sheet of fileSheets) {
    if (!journal.sheets.removed.has(sheet.id)) place(sheet.id, sheet.name)
  }
  // A deleted source still hands its marks to the copies made from it.
  for (const { copyId, sourceId } of unsavedCopies(journal)) {
    place(copyId, fileNameById.get(sourceId))
  }
  return redactionIndexBySheetId(onScreen)
}

/**
 * Where a selection on the grid sits in the file, or why it has no place yet.
 *
 * A mark is written into the package part, so it names the sheet and the cells
 * the FILE has: the sheet by the name it was opened under (the save carries the
 * rename), the cells before this session's row and column edits (the save
 * shifts them). A row or a sheet created this session has neither, so the
 * person is asked to save first rather than handed a mark the save would
 * misplace.
 *
 * A sheet with a copy that is not in the file yet waits for the save too: the
 * copy answers with this sheet's marks, so showing a cell here would show the
 * same value on the copy, where the person never asked for it.
 */
export type MarkPlace =
  | { readonly ok: true; readonly sheetName: string; readonly area: MarkKey }
  | { readonly ok: false; readonly reason: 'unsaved-row' | 'unsaved-sheet' | 'unsaved-copy' }

export function markPlaceInFile(
  fileSheets: readonly SheetRefLike[],
  journal: EditJournal,
  sheetId: string,
  screen: MarkKey,
): MarkPlace {
  const sheet = fileSheets.find((candidate) => candidate.id === sheetId)
  if (!sheet || journal.sheets.removed.has(sheetId)) return { ok: false, reason: 'unsaved-sheet' }
  if (unsavedCopies(journal).some((copy) => copy.sourceId === sheetId)) {
    return { ok: false, reason: 'unsaved-copy' }
  }
  const ops = journal.structuralOps.get(sheetId) ?? []
  const startRow = screenToFile(ops, 'row', screen.startRow)
  const endRow = screenToFile(ops, 'row', screen.endRow)
  const startColumn = screenToFile(ops, 'column', screen.startColumn)
  const endColumn = screenToFile(ops, 'column', screen.endColumn)
  if (startRow === null || endRow === null || startColumn === null || endColumn === null) {
    return { ok: false, reason: 'unsaved-row' }
  }
  return { ok: true, sheetName: sheet.name, area: { startRow, endRow, startColumn, endColumn } }
}
