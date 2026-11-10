/**
 * The trust boundary of a co-edited workbook: a page decodes every op of the
 * log, written by pages it cannot vouch for, before anything runs. Ops a
 * modified client could send to hang or break every page (and every later
 * opener, since the log is replayed) must be refused there.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { syncedIds } from '../src/web/collab-mutations'
import { checkedMutationIds, MAX_COLUMNS, MAX_ROWS } from '../src/web/collab-wire-check'
import { Room } from './collab/room'
import { disposeAll } from './collab/sheets-workbook'

afterEach(disposeAll)

const decoder = () => new Room().join().adapter

const op = (id: string, params: unknown) => ({ id: 'hostile', m: [[id, params]] })

const cells = (matrix: unknown) => ({ subUnitId: 's1', cellValue: matrix })

const range = (startRow: number, startColumn: number, endRow: number, endColumn: number) => ({
  startRow,
  startColumn,
  endRow,
  endColumn,
})

const nested = (depth: number): unknown => {
  let node: unknown = { t: 'x' }
  for (let level = 0; level < depth; level++) node = { child: node }
  return node
}

const HOSTILE: [string, string, unknown][] = [
  [
    'a row count past Excel',
    'sheet.mutation.set-worksheet-row-count',
    { subUnitId: 's1', rowCount: 1e9 },
  ],
  [
    'a column count past Excel',
    'sheet.mutation.set-worksheet-column-count',
    { subUnitId: 's1', columnCount: MAX_COLUMNS + 1 },
  ],
  [
    'a fractional row count',
    'sheet.mutation.set-worksheet-row-count',
    { subUnitId: 's1', rowCount: 10.5 },
  ],
  [
    'a row count as text',
    'sheet.mutation.set-worksheet-row-count',
    { subUnitId: 's1', rowCount: '10' },
  ],
  [
    'a sheet id that is not a string',
    'sheet.mutation.set-worksheet-row-count',
    { subUnitId: 7, rowCount: 10 },
  ],
  ['a missing sheet id', 'sheet.mutation.set-row-hidden', { ranges: [range(0, 0, 0, 0)] }],
  [
    'an unknown field',
    'sheet.mutation.set-worksheet-name',
    { subUnitId: 's1', name: 'a', run: 'x' },
  ],
  [
    'a cell past the last row',
    'sheet.mutation.set-range-values',
    cells({ [MAX_ROWS]: { 0: { v: 1 } } }),
  ],
  [
    'a cell past the last column',
    'sheet.mutation.set-range-values',
    cells({ 0: { [MAX_COLUMNS]: { v: 1 } } }),
  ],
  ['a negative row key', 'sheet.mutation.set-range-values', cells({ '-1': { 0: { v: 1 } } })],
  ['a padded row key', 'sheet.mutation.set-range-values', cells({ '01': { 0: { v: 1 } } })],
  [
    'text past 32,767 characters',
    'sheet.mutation.set-range-values',
    cells({ 0: { 0: { v: 'x'.repeat(32_768) } } }),
  ],
  [
    'a formula past 8,192 characters',
    'sheet.mutation.set-range-values',
    cells({ 0: { 0: { f: `=${'1+'.repeat(4_100)}1` } } }),
  ],
  [
    'an unknown cell field',
    'sheet.mutation.set-range-values',
    cells({ 0: { 0: { v: 1, linkUrl: 'https://x' } } }),
  ],
  [
    'deeply nested rich text',
    'sheet.mutation.set-range-values',
    cells({ 0: { 0: { p: nested(50) } } }),
  ],
  [
    'a hyperlink in rich text',
    'sheet.mutation.set-range-values',
    cells({
      0: {
        0: {
          p: {
            body: {
              dataStream: 'x\r\n',
              customRanges: [
                { startIndex: 0, endIndex: 0, rangeType: 0, properties: { url: 'https://x' } },
              ],
            },
          },
        },
      },
    }),
  ],
  [
    'an unknown style key',
    'sheet.mutation.set-range-values',
    cells({ 0: { 0: { v: 1, s: { bl: 1, script: 'x' } } } }),
  ],
  [
    'a number format past 255 characters',
    'sheet.mutation.set-range-values',
    cells({ 0: { 0: { v: 1, s: { n: { pattern: '0'.repeat(256) } } } } }),
  ],
  [
    'a number format with extra fields',
    'sheet.mutation.set-range-values',
    cells({ 0: { 0: { v: 1, s: { n: { pattern: '0', link: 'x' } } } } }),
  ],
  [
    'a number format over the whole grid',
    'sheet.mutation.set.numfmt',
    {
      subUnitId: 's1',
      values: { f1: { ranges: [range(0, 0, MAX_ROWS - 1, MAX_COLUMNS - 1)] } },
      refMap: { f1: { pattern: '0.00' } },
    },
  ],
  [
    'a range that ends before it starts',
    'sheet.mutation.remove.numfmt',
    { subUnitId: 's1', ranges: [range(5, 0, 2, 0)] },
  ],
  [
    'the whole column hidden three times over',
    'sheet.mutation.set-row-hidden',
    { subUnitId: 's1', ranges: Array.from({ length: 3 }, () => range(0, 0, MAX_ROWS - 1, 0)) },
  ],
  [
    'thousands of ranges',
    'sheet.mutation.add-worksheet-merge',
    { subUnitId: 's1', ranges: Array.from({ length: 5_000 }, (_, i) => range(i, 0, i, 1)) },
  ],
  [
    'a sheet of a billion rows',
    'sheet.mutation.insert-sheet',
    { index: 0, sheet: { id: 'x', name: 'x', rowCount: 1e9, columnCount: 10 } },
  ],
  [
    'a defined name formula past 8,192 characters',
    'formula.mutation.set-defined-name',
    { id: 'n1', name: 'n', formulaOrRefString: `=${'A1+'.repeat(3_000)}A1` },
  ],
  [
    'a sheet name past 31 characters',
    'sheet.mutation.set-worksheet-name',
    { subUnitId: 's1', name: 'x'.repeat(32) },
  ],
]

describe('decode refuses what a modified client could send', () => {
  it.each(HOSTILE)('%s', (_name, id, params) => {
    const adapter = decoder()
    expect(() => adapter.decode(op(id, params) as never)).toThrow()
  })

  it('refuses a cell matrix of more than a column of cells', () => {
    const adapter = decoder()
    const row = Object.fromEntries(Array.from({ length: 1_024 }, (_, c) => [c, { v: 1 }]))
    const matrix = Object.fromEntries(Array.from({ length: 1_025 }, (_, r) => [r, row]))
    expect(() =>
      adapter.decode(op('sheet.mutation.set-range-values', cells(matrix)) as never),
    ).toThrow(/too many cells/)
  })

  it('still decodes what pages send', () => {
    const adapter = decoder()
    const sent = op('sheet.mutation.set-range-values', {
      subUnitId: 's1',
      trigger: 'sheet.command.set-range-values',
      cellValue: {
        0: {
          0: {
            v: 'kim',
            s: { bl: 1, n: { pattern: '0.00' }, bd: { t: { s: 1, cl: { rgb: '#000' } } } },
          },
        },
        1: { 1: { f: '=A1', si: 'abc' }, 2: null, 3: { p: { body: { dataStream: 'hi\r\n' } } } },
      },
    })
    expect(adapter.decode(sent as never).mutations).toHaveLength(1)
  })

  it('knows the params of every mutation co-editing sends', () => {
    expect(checkedMutationIds().sort()).toEqual(syncedIds().sort())
  })
})
