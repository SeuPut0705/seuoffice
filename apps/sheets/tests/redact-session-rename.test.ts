/**
 * A sheet renamed by a person keeps its hidden cells hidden, before any save.
 *
 * The part names sheets, and so did the on-screen index: the next time it was
 * rebuilt after a rename (a row inserted, another cell hidden) the marks under
 * the old name matched no sheet and were dropped, and the in-app AI read the
 * value until the workbook was saved and reopened.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SheetRedactionState } from '@genoffice/xlsx-gateway/gateway/xlsx-redaction'

import {
  createEditJournal,
  recordSheetInsert,
  recordSheetRename,
  recordStructuralOp,
} from '../src/renderer/edit-journal'
import { addMark } from '../src/renderer/redact-actions'
import { markPlaceInFile, sessionRedactionIndex } from '../src/renderer/redact-session'
import { aiReads, savedText, SECRET, workbookWithSecret } from './redact-session-helpers'

const FILE_SHEETS = [
  { id: 's1', name: 'Data' },
  { id: 's2', name: 'Other' },
]
const PHONE_B2: SheetRedactionState = {
  sheetName: 'Data',
  marks: [{ startRow: 1, endRow: 1, startColumn: 1, endColumn: 1, label: 'client phone' }],
}
const SALARY_A1: SheetRedactionState = {
  sheetName: 'Other',
  marks: [{ startRow: 0, endRow: 0, startColumn: 0, endColumn: 0, label: 'salary' }],
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('what the in-app AI reads after a person renames a sheet', () => {
  it('still withholds the cell once the index is rebuilt', () => {
    const journal = createEditJournal()
    recordSheetRename(journal, 's1', 'Clients', 'Data')
    const index = sessionRedactionIndex([PHONE_B2], FILE_SHEETS, journal)
    expect(aiReads(index, { s1: { B2: SECRET } }, 's1', 'B2')).toBe('{{client phone}}')
  })

  it('follows a row inserted above the cell on the renamed sheet', () => {
    const journal = createEditJournal()
    recordSheetRename(journal, 's1', 'Clients', 'Data')
    recordStructuralOp(journal, 's1', { kind: 'insert-rows', index: 0, count: 1 })
    const index = sessionRedactionIndex([PHONE_B2], FILE_SHEETS, journal)
    expect(aiReads(index, { s1: { B3: SECRET } }, 's1', 'B3')).toBe('{{client phone}}')
    expect(aiReads(index, { s1: { B2: 'plain' } }, 's1', 'B2')).toBe('plain')
  })

  it('follows a chain of renames', () => {
    const journal = createEditJournal()
    recordSheetRename(journal, 's1', 'Clients', 'Data')
    recordSheetRename(journal, 's1', 'Clients 2026', 'Data')
    const index = sessionRedactionIndex([PHONE_B2], FILE_SHEETS, journal)
    expect(aiReads(index, { s1: { B2: SECRET } }, 's1', 'B2')).toBe('{{client phone}}')
  })

  it('keeps each sheet its own marks when two sheets swap names', () => {
    const journal = createEditJournal()
    recordSheetRename(journal, 's1', 'Swap', 'Data')
    recordSheetRename(journal, 's2', 'Data', 'Other')
    recordSheetRename(journal, 's1', 'Other', 'Data')
    const index = sessionRedactionIndex([PHONE_B2, SALARY_A1], FILE_SHEETS, journal)
    const grid = {
      s1: { A1: 'Name', B2: SECRET },
      s2: { A1: '98000', B2: 'plain' },
    }
    expect(aiReads(index, grid, 's1', 'B2')).toBe('{{client phone}}')
    expect(aiReads(index, grid, 's2', 'A1')).toBe('{{salary}}')
    // and neither sheet hides the other's cell
    expect(aiReads(index, grid, 's1', 'A1')).toBe('Name')
    expect(aiReads(index, grid, 's2', 'B2')).toBe('plain')
  })

  it('leaves a workbook without renames as it was', () => {
    const index = sessionRedactionIndex([PHONE_B2], FILE_SHEETS, createEditJournal())
    expect(aiReads(index, { s1: { B2: SECRET, C2: 'plain' } }, 's1', 'B2')).toBe('{{client phone}}')
    expect(aiReads(index, { s1: { B2: SECRET, C2: 'plain' } }, 's1', 'C2')).toBe('plain')
  })
})

describe('a cell hidden after the sheet was renamed', () => {
  it('stays hidden in the saved file when a row was inserted above it too', async () => {
    const journal = createEditJournal()
    recordSheetRename(journal, 's1', 'Clients', 'Data')
    recordStructuralOp(journal, 's1', { kind: 'insert-rows', index: 0, count: 1 })
    // The person right-clicks the phone number where the grid shows it now: B3.
    const place = markPlaceInFile(FILE_SHEETS, journal, 's1', {
      startRow: 2,
      endRow: 2,
      startColumn: 1,
      endColumn: 1,
    })
    if (!place.ok) throw new Error(`hiding was refused: ${place.reason}`)
    const states = addMark([], place.sheetName, { ...place.area, label: 'client phone' })

    const index = sessionRedactionIndex(states, FILE_SHEETS, journal)
    expect(aiReads(index, { s1: { B3: SECRET } }, 's1', 'B3')).toBe('{{client phone}}')

    const text = await savedText(await workbookWithSecret([]), journal, states, ['s1'])
    expect(text).toContain('# Clients')
    expect(text).not.toContain(SECRET)
  })

  it('can be shown again from the renamed sheet', () => {
    const journal = createEditJournal()
    recordSheetRename(journal, 's1', 'Clients', 'Data')
    const place = markPlaceInFile(FILE_SHEETS, journal, 's1', {
      startRow: 1,
      endRow: 1,
      startColumn: 1,
      endColumn: 1,
    })
    // The mark the file holds is found under the name the file knows the sheet by.
    expect(place).toEqual({
      ok: true,
      sheetName: 'Data',
      area: { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 },
    })
  })
})

describe('a selection with no place in the file yet', () => {
  const B2 = { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 }

  it('is refused on a sheet added this session, whatever it is called by then', () => {
    const journal = createEditJournal()
    recordSheetInsert(journal, 'new', 'Sheet3')
    // A new sheet named like a file sheet that was renamed away must not be
    // taken for it: its mark would be saved onto the renamed sheet's cells.
    recordSheetRename(journal, 's1', 'Clients', 'Data')
    recordSheetRename(journal, 'new', 'Data', undefined)
    expect(markPlaceInFile(FILE_SHEETS, journal, 'new', B2)).toEqual({
      ok: false,
      reason: 'unsaved-sheet',
    })
  })

  it('is refused in a row inserted this session', () => {
    const journal = createEditJournal()
    recordStructuralOp(journal, 's1', { kind: 'insert-rows', index: 1, count: 1 })
    expect(markPlaceInFile(FILE_SHEETS, journal, 's1', B2)).toEqual({
      ok: false,
      reason: 'unsaved-row',
    })
  })

  it('is found where the file has the cell', () => {
    const journal = createEditJournal()
    recordStructuralOp(journal, 's1', { kind: 'insert-rows', index: 0, count: 1 })
    expect(
      markPlaceInFile(FILE_SHEETS, journal, 's1', {
        startRow: 2,
        endRow: 2,
        startColumn: 1,
        endColumn: 1,
      }),
    ).toEqual({ ok: true, sheetName: 'Data', area: B2 })
  })
})
