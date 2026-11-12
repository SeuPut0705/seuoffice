/**
 * A sheet duplicated from the tab menu takes its hidden cells with it.
 *
 * The copy holds the same values as its source. The save gives it the
 * source's marks (the gateway does that for a sheet added as a copy), but
 * until that save and the reopen after it the session had no marks for the
 * copy at all: the in-app AI, MCP reads and dry runs read the hidden values
 * from it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SheetRedactionState } from '@genoffice/xlsx-gateway/gateway/xlsx-redaction'

import {
  createEditJournal,
  recordSheetDuplicate,
  recordSheetRemove,
  recordSheetRename,
  recordStructuralOp,
} from '../src/renderer/edit-journal'
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
const B2 = { startRow: 1, endRow: 1, startColumn: 1, endColumn: 1 }
const HIDDEN = '{{client phone}}'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('what the in-app AI reads from a sheet a person just duplicated', () => {
  it('withholds the cell on the copy at once', () => {
    const journal = createEditJournal()
    recordSheetDuplicate(journal, 'copy', 'Data (2)', 's1')
    const index = sessionRedactionIndex([PHONE_B2], FILE_SHEETS, journal)
    const grid = { s1: { B2: SECRET, C2: 'plain' }, copy: { B2: SECRET, C2: 'plain' } }
    expect(aiReads(index, grid, 'copy', 'B2')).toBe(HIDDEN)
    expect(aiReads(index, grid, 's1', 'B2')).toBe(HIDDEN)
    // the rest of the copy reads as before
    expect(aiReads(index, grid, 'copy', 'C2')).toBe('plain')
  })

  it('withholds it where the source shows it at that moment', () => {
    const journal = createEditJournal()
    // A row inserted above the phone number before the copy is made: the
    // source shows it in B3, and so does the copy.
    recordStructuralOp(journal, 's1', { kind: 'insert-rows', index: 0, count: 1 })
    recordSheetDuplicate(journal, 'copy', 'Data (2)', 's1')
    const index = sessionRedactionIndex([PHONE_B2], FILE_SHEETS, journal)
    const grid = { s1: { B3: SECRET }, copy: { B2: 'plain', B3: SECRET } }
    expect(aiReads(index, grid, 'copy', 'B3')).toBe(HIDDEN)
    expect(aiReads(index, grid, 'copy', 'B2')).toBe('plain')
  })

  it('follows later row and column edits on the copy and on the source separately', () => {
    const journal = createEditJournal()
    recordSheetDuplicate(journal, 'copy', 'Data (2)', 's1')
    recordStructuralOp(journal, 'copy', { kind: 'insert-cols', index: 0, count: 1 })
    recordStructuralOp(journal, 's1', { kind: 'insert-rows', index: 0, count: 2 })
    const index = sessionRedactionIndex([PHONE_B2], FILE_SHEETS, journal)
    const grid = { s1: { B4: SECRET, B2: 'plain' }, copy: { C2: SECRET, B2: 'plain' } }
    expect(aiReads(index, grid, 'copy', 'C2')).toBe(HIDDEN)
    expect(aiReads(index, grid, 'copy', 'B2')).toBe('plain')
    expect(aiReads(index, grid, 's1', 'B4')).toBe(HIDDEN)
    expect(aiReads(index, grid, 's1', 'B2')).toBe('plain')
  })

  it('withholds it on a copy of the copy', () => {
    const journal = createEditJournal()
    recordSheetDuplicate(journal, 'copy', 'Data (2)', 's1')
    recordStructuralOp(journal, 'copy', { kind: 'insert-rows', index: 0, count: 1 })
    recordSheetDuplicate(journal, 'copy2', 'Data (3)', 'copy')
    const index = sessionRedactionIndex([PHONE_B2], FILE_SHEETS, journal)
    expect(aiReads(index, { copy2: { B3: SECRET } }, 'copy2', 'B3')).toBe(HIDDEN)
  })

  it('keeps withholding it after the copy is renamed and the source deleted', () => {
    const journal = createEditJournal()
    recordSheetDuplicate(journal, 'copy', 'Data (2)', 's1')
    recordSheetRename(journal, 'copy', 'Clients', undefined)
    recordSheetRemove(journal, 's1')
    const index = sessionRedactionIndex([PHONE_B2], FILE_SHEETS, journal)
    expect(aiReads(index, { copy: { B2: SECRET } }, 'copy', 'B2')).toBe(HIDDEN)
  })

  it('leaves a sheet duplicated from one without hidden cells readable', () => {
    const journal = createEditJournal()
    recordSheetDuplicate(journal, 'copy', 'Other (2)', 's2')
    const index = sessionRedactionIndex([PHONE_B2], FILE_SHEETS, journal)
    expect(aiReads(index, { copy: { B2: 'plain' } }, 'copy', 'B2')).toBe('plain')
  })
})

describe('changing what is hidden while a copy is not in the file yet', () => {
  it('is refused on the copy, which has no marks of its own to change', () => {
    const journal = createEditJournal()
    recordSheetDuplicate(journal, 'copy', 'Data (2)', 's1')
    expect(markPlaceInFile(FILE_SHEETS, journal, 'copy', B2)).toEqual({
      ok: false,
      reason: 'unsaved-sheet',
    })
  })

  it('is refused on the source: showing its cell would show the cell on the copy', () => {
    const journal = createEditJournal()
    recordSheetDuplicate(journal, 'copy', 'Data (2)', 's1')
    recordSheetDuplicate(journal, 'copy2', 'Data (3)', 'copy')
    recordSheetRemove(journal, 'copy')
    // `copy2` still answers with the marks of `s1`, through the deleted copy.
    expect(markPlaceInFile(FILE_SHEETS, journal, 's1', B2)).toEqual({
      ok: false,
      reason: 'unsaved-copy',
    })
  })

  it('is allowed on the source again once the copy is gone, and on other sheets all along', () => {
    const journal = createEditJournal()
    recordSheetDuplicate(journal, 'copy', 'Data (2)', 's1')
    expect(markPlaceInFile(FILE_SHEETS, journal, 's2', B2)).toEqual({
      ok: true,
      sheetName: 'Other',
      area: B2,
    })
    recordSheetRemove(journal, 'copy')
    expect(markPlaceInFile(FILE_SHEETS, journal, 's1', B2)).toEqual({
      ok: true,
      sheetName: 'Data',
      area: B2,
    })
  })
})

describe('the file saved after a person duplicated a sheet with a hidden cell', () => {
  it('prints the value from neither sheet', async () => {
    const journal = createEditJournal()
    recordSheetDuplicate(journal, 'copy', 'Data (2)', 's1')
    const text = await savedText(
      await workbookWithSecret([PHONE_B2]),
      journal,
      [PHONE_B2],
      ['s1', 'copy'],
    )
    expect(text).toContain('# Data (2)')
    expect(text).not.toContain(SECRET)
  })

  it('still hides it on a copy that got a row inserted above the cell', async () => {
    const journal = createEditJournal()
    recordSheetDuplicate(journal, 'copy', 'Data (2)', 's1')
    recordStructuralOp(journal, 'copy', { kind: 'insert-rows', index: 0, count: 1 })
    // what the session shows and what the file will say agree: B3 on the copy
    const index = sessionRedactionIndex([PHONE_B2], FILE_SHEETS, journal)
    expect(aiReads(index, { copy: { B3: SECRET } }, 'copy', 'B3')).toBe(HIDDEN)
    const text = await savedText(
      await workbookWithSecret([PHONE_B2]),
      journal,
      [PHONE_B2],
      ['s1', 'copy'],
    )
    expect(text).toContain('# Data (2)')
    expect(text).not.toContain(SECRET)
  })
})
