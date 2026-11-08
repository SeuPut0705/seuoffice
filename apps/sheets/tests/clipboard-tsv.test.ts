import { CellModeEnum, CellValueType } from '@univerjs/core'
import { describe, expect, it } from 'vitest'

import {
  clipboardField,
  generateWithCapturedMatrix,
  plainTextFromCells,
} from '../src/renderer/clipboard-tsv'

describe('clipboard TSV serialization', () => {
  it('booleans copy as TRUE/FALSE, not 1/0', () => {
    expect(clipboardField({ v: 1, t: CellValueType.BOOLEAN })).toBe('TRUE')
    expect(clipboardField({ v: 0, t: CellValueType.BOOLEAN })).toBe('FALSE')
  })

  it('serializes empty booleans as empty, not FALSE or TRUE', () => {
    expect(clipboardField({ v: null, t: CellValueType.BOOLEAN })).toBe('')
    expect(clipboardField({ v: undefined, t: CellValueType.BOOLEAN })).toBe('')
    expect(clipboardField({ v: '', t: CellValueType.BOOLEAN })).toBe('')
  })

  it('prefers the formatted display text', () => {
    expect(clipboardField({ v: 44614, displayV: '2/22/2022' })).toBe('2/22/2022')
  })

  it('quotes fields with embedded newlines and normalizes \\r to \\n', () => {
    expect(clipboardField({ v: 'greater \r\rthan' })).toBe('"greater \n\nthan"')
    expect(clipboardField({ v: 'a\r\rb' })).toBe('"a\n\nb"')
    expect(clipboardField({ v: 'a\r\nb' })).toBe('"a\nb"')
    expect(clipboardField({ v: 'a\tb' })).toBe('"a\tb"')
    expect(clipboardField({ v: 'say "hi"' })).toBe('"say ""hi"""')
    expect(clipboardField({ v: 'plain' })).toBe('plain')
  })

  it('keeps significant trailing newlines (quoted) instead of stripping them', () => {
    expect(clipboardField({ v: 'a\n' })).toBe('"a\n"')
    expect(clipboardField({ v: 'a\r\n' })).toBe('"a\n"')
    expect(clipboardField({ v: 'plain' })).toBe('plain')
  })

  it('assembles rows with empty fields for missing cells (no column drift)', () => {
    const cells: Record<string, { v: string }> = { '0:0': { v: 'a' }, '0:2': { v: 'c' } }
    const plain = plainTextFromCells([0, 1], [0, 1, 2], (row, column) => cells[`${row}:${column}`])
    expect(plain).toBe('a\t\tc\n\t\t')
  })
})

describe('copy matrix reuse', () => {
  class FakeSheet {
    reads = 0
    getMatrixWithMergedCells(
      row: number,
      column: number,
      endRow: number,
      endColumn: number,
      _mode?: CellModeEnum,
    ) {
      this.reads += 1
      return {
        getValue: (r: number, c: number) => ({
          v: `${r}:${c}`,
          area: [row, column, endRow, endColumn],
        }),
      }
    }
  }
  const area = { startRow: 2, endRow: 5, startColumn: 1, endColumn: 3 }

  it('hands back the matrix the copy read in both-value mode', () => {
    const sheet = new FakeSheet()
    const { result, matrix } = generateWithCapturedMatrix(
      sheet,
      () => {
        sheet.getMatrixWithMergedCells(2, 1, 5, 3, CellModeEnum.Both)
        return 'content'
      },
      () => area,
    )
    expect(result).toBe('content')
    expect(matrix?.getValue(4, 2)).toMatchObject({ v: '4:2' })
    expect(sheet.reads).toBe(1)
    // the recorder is gone: the prototype method answers again
    expect(Object.prototype.hasOwnProperty.call(sheet, 'getMatrixWithMergedCells')).toBe(false)
  })

  it('declines a recording that is not in both-value mode or does not cover the copy', () => {
    const raw = new FakeSheet()
    expect(
      generateWithCapturedMatrix(
        raw,
        () => raw.getMatrixWithMergedCells(2, 1, 5, 3, CellModeEnum.Raw),
        () => area,
      ).matrix,
    ).toBeNull()
    const narrow = new FakeSheet()
    expect(
      generateWithCapturedMatrix(
        narrow,
        () => narrow.getMatrixWithMergedCells(3, 1, 5, 3, CellModeEnum.Both),
        () => area,
      ).matrix,
    ).toBeNull()
    const none = new FakeSheet()
    expect(
      generateWithCapturedMatrix(
        none,
        () => null,
        () => null,
      ).matrix,
    ).toBeNull()
  })

  it('removes the recorder even when the copy throws', () => {
    const sheet = new FakeSheet()
    expect(() =>
      generateWithCapturedMatrix(
        sheet,
        () => {
          throw new Error('boom')
        },
        () => area,
      ),
    ).toThrow('boom')
    expect(Object.prototype.hasOwnProperty.call(sheet, 'getMatrixWithMergedCells')).toBe(false)
  })
})
