import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'

import { readRedactionEntries } from '../src/main/workbook-redaction-entries'
import { redactionSessionFor } from '../src/renderer/ai/redact-load'
import type { TFunc } from '../src/renderer/i18n/locale'
import {
  HIDDEN_MARKS,
  LABEL,
  RECORD_KINDS,
  STRING_KINDS,
  TAG_MUTATION_NAMES,
  mutatedHiddenBook,
  type RecordKind,
} from '../../../packages/xlsx-gateway/tests/helpers/hidden-book'

/**
 * The hidden-from-AI workbook with its tags written another valid way: the
 * sheet editor finds the marks (in the package part, or in the hidden defined
 * names where Excel leaves them when the part is gone) and its AI readers
 * withhold the marked cells. A record that cannot be read withholds every
 * cell; it is never read as "nothing is withheld", and no mark is dropped.
 */

const SHEETS = [
  { id: 'sheet-data', name: 'Data' },
  { id: 'sheet-report', name: 'Report' },
]
const t = ((key: string) => key) as TFunc

async function readerOf(bytes: Uint8Array) {
  const zip = await JSZip.loadAsync(bytes)
  return {
    has: async (path: string) => zip.file(path) !== null,
    readText: async (path: string) => {
      const file = zip.file(path)
      if (file === null) throw new Error(`Workbook is missing ${path}.`)
      return file.async('string')
    },
  }
}

describe.each(['none', ...TAG_MUTATION_NAMES] as const)('tags rewritten: %s', (mutation) => {
  describe.each(RECORD_KINDS)('record: %s', (record: RecordKind) => {
    describe.each(STRING_KINDS)('phone as a %s string', (strings) => {
      const book = () => mutatedHiddenBook(mutation, { record, strings })

      it('the marks are found, from the copy the file still has', async () => {
        const result = await readRedactionEntries(await readerOf(await book()))
        expect(result).toEqual({
          status: 'ok',
          states: HIDDEN_MARKS,
          source: record === 'mirror' ? 'mirror' : 'part',
        })
      })

      it('withholds the marked cells and no others', async () => {
        const result = await readRedactionEntries(await readerOf(await book()))
        const session = redactionSessionFor(
          result.status === 'ok'
            ? { status: 'ok', states: result.states, source: result.source }
            : { status: 'unreadable', error: 'unreadable' },
          SHEETS,
          t,
        )
        expect(session.load.status).toBe('loaded')
        // B2 and B3 of Data, zero-based
        expect(session.index.labelAt('sheet-data', 1, 1)).toBe(LABEL)
        expect(session.index.labelAt('sheet-data', 2, 1)).toBe(LABEL)
        expect(session.index.labelAt('sheet-data', 0, 1)).toBeNull()
        expect(session.index.labelAt('sheet-data', 3, 1)).toBeNull()
        expect(session.index.labelAt('sheet-report', 1, 1)).toBeNull()
      })
    })
  })
})
