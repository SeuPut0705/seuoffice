import { describe, expect, it } from 'vitest'
import { parseFileToText, xlsxToText } from '../src/index'
import { xlsxWithheldCells } from '../src/xlsx'
import { RedactionMarkError } from '../src/redaction-error'
import {
  FAKE_LABEL_TEXT,
  LABEL_CELL_TEXT,
  PLACEHOLDER,
  RECORD_KINDS,
  SECRET,
  STRING_KINDS,
  TAG_MUTATION_NAMES,
  WITHHELD_WORDS,
  mutatedHiddenBook,
  type RecordKind,
  type StringKind,
} from '../../xlsx-gateway/tests/helpers/hidden-book'
import { writeFixture } from './helpers/fixtures'

/**
 * The hidden-from-AI workbook with its tags written another valid way: the
 * readers of a file that has no sheet editor behind it (attachments, the
 * knowledge base, the search index) hand over no hidden word and none of the
 * values computed from it, whatever the tags look like. A reader may refuse
 * the file, which is a safe answer; it may not hand the words over, and it may
 * not hand over fewer placeholders than the unrewritten file does.
 */

const PRIVATE = '{{private}}'

/** what a model reads of the unrewritten workbook, cell by cell */
const EXPECTED_TEXT = [
  `# Data\n${LABEL_CELL_TEXT} | Phone`,
  `Kim | ${PLACEHOLDER} | ${PRIVATE} | ${PRIVATE} | ${PRIVATE}`,
  `Lee | ${PLACEHOLDER}`,
  ' |  | 2',
].join('\n')
const EXPECTED_REPORT = `# Report\n${PRIVATE} | ${PRIVATE} |  | beside\n${PRIVATE} | ${PRIVATE}`

const PROBES = [
  ['Data', 'A2', false, null],
  ['Data', 'B2', false, PLACEHOLDER],
  ['Data', 'B3', false, PLACEHOLDER],
  ['Data', 'C2', true, PRIVATE],
  ['Data', 'D2', true, PRIVATE],
  ['Data', 'E2', true, PRIVATE],
  ['Data', 'C5', true, null],
  ['Report', 'A3', false, PRIVATE],
  ['Report', 'B3', false, PRIVATE],
  ['Report', 'A4', false, PRIVATE],
  ['Report', 'B4', false, PRIVATE],
  ['Report', 'D3', false, null],
] as const

async function outcome<T>(read: () => Promise<T>): Promise<{ value: T } | { refused: string }> {
  try {
    return { value: await read() }
  } catch (error) {
    // refusing the file is a safe answer; anything else is a failure
    if (error instanceof RedactionMarkError) return { refused: error.message }
    throw error
  }
}

function expectNoWords(text: string): void {
  for (const word of WITHHELD_WORDS) expect(text).not.toContain(word)
}

describe('the unrewritten workbook, which the rewritten ones are compared with', () => {
  it.each(RECORD_KINDS)('reads withheld, record: %s', async (record) => {
    const bytes = await mutatedHiddenBook('none', { record })
    expect(await xlsxToText(bytes)).toBe(`${EXPECTED_TEXT}\n\n${EXPECTED_REPORT}`)
    const marker = await xlsxWithheldCells(bytes)
    expect(PROBES.map(([sheet, ref, formula]) => marker?.(sheet, ref, formula))).toEqual(
      PROBES.map((probe) => probe[3]),
    )
  })
})

describe.each(TAG_MUTATION_NAMES)('tags rewritten: %s', (mutation) => {
  describe.each(RECORD_KINDS)('record: %s', (record: RecordKind) => {
    describe.each(STRING_KINDS)('phone as a %s string', (strings: StringKind) => {
      const book = () => mutatedHiddenBook(mutation, { record, strings })

      it('xlsxToText hands over no hidden word', async () => {
        const read = await outcome(async () => xlsxToText(await book()))
        expectNoWords('refused' in read ? read.refused : read.value)
      })

      it('xlsxToText reads it as the unrewritten workbook, nothing more withheld or less', async () => {
        const read = await outcome(async () => xlsxToText(await book()))
        if ('refused' in read) return
        // the label cell is the one a mutation may fill with markup-like text
        const text = read.value.replaceAll(FAKE_LABEL_TEXT, LABEL_CELL_TEXT)
        expect(text).toBe(`${EXPECTED_TEXT}\n\n${EXPECTED_REPORT}`)
      })

      it('parseFileToText hands over no hidden word', async () => {
        const path = writeFixture(
          `mutated-${mutation.replace(/\W+/g, '-')}-${record}-${strings}.xlsx`,
          await book(),
        )
        const result = await parseFileToText(path)
        expectNoWords(JSON.stringify(result))
        expect(JSON.stringify(result)).not.toContain(SECRET)
      })

      it('xlsxWithheldCells withholds the marked cells and the cells computed from them', async () => {
        const read = await outcome(async () => xlsxWithheldCells(await book()))
        if ('refused' in read) return expectNoWords(read.refused)
        const marker = read.value
        expect(marker).not.toBeNull()
        for (const [sheet, ref, formula, expected] of PROBES) {
          if (expected !== null)
            expect(marker?.(sheet, ref, formula), `${sheet}!${ref}`).toMatch(/^\{\{.+\}\}$/)
        }
      })

      it('xlsxWithheldCells reports what it does for the unrewritten workbook', async () => {
        const read = await outcome(async () => xlsxWithheldCells(await book()))
        if ('refused' in read) return
        expect(PROBES.map(([sheet, ref, formula]) => read.value?.(sheet, ref, formula))).toEqual(
          PROBES.map((probe) => probe[3]),
        )
      })
    })
  })
})
