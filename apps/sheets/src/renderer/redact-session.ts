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
import type { EditJournal } from './edit-journal'
import type { MarkKey } from './redact-actions'
import { shiftMarksThroughOps } from './redact-marks-shift'
import { screenToFile } from './view-transform'

/** The slice of the edit journal the marks follow. */
export type MarkJournal = Pick<EditJournal, 'structuralOps' | 'sheets'>

/**
 * The index every reader asks, for the session as it stands now.
 *
 * `fileSheets` are the sheets as the file was opened (their ids are stable for
 * the session, their names are the ones the marks are keyed by).
 */
export function sessionRedactionIndex(
  states: readonly SheetRedactionState[],
  fileSheets: readonly SheetRefLike[],
  journal: MarkJournal,
): RedactionIndex {
  const marksByFileName = new Map<string, readonly CellMark[]>()
  for (const state of states) {
    marksByFileName.set(state.sheetName, [
      ...(marksByFileName.get(state.sheetName) ?? []),
      ...state.marks,
    ])
  }
  const onScreen = new Map<string, CellMark[]>()
  for (const sheet of fileSheets) {
    if (journal.sheets.removed.has(sheet.id)) continue
    const marks = marksByFileName.get(sheet.name)
    if (!marks || marks.length === 0) continue
    const placed = shiftMarksThroughOps(marks, journal.structuralOps.get(sheet.id) ?? [])
    if (placed.length > 0) onScreen.set(sheet.id, placed)
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
 */
export type MarkPlace =
  | { readonly ok: true; readonly sheetName: string; readonly area: MarkKey }
  | { readonly ok: false; readonly reason: 'unsaved-row' | 'unsaved-sheet' }

export function markPlaceInFile(
  fileSheets: readonly SheetRefLike[],
  journal: MarkJournal,
  sheetId: string,
  screen: MarkKey,
): MarkPlace {
  const sheet = fileSheets.find((candidate) => candidate.id === sheetId)
  if (!sheet || journal.sheets.removed.has(sheetId)) return { ok: false, reason: 'unsaved-sheet' }
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
