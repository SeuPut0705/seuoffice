import type { OpenedBook } from './sheets-workbook'

const WORDS = ['north', 'south', 'east', 'west', 'total', 'Plan', 'Data']

/** mulberry32, the same scheduler randomness the conformance kit uses */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!
}

export function int(random: () => number, below: number): number {
  return Math.floor(random() * below)
}

const columnName = (column: number) => String.fromCharCode(65 + column)

/** Direction values of Univer's insert commands */
const UP = 0
const LEFT = 3

/** One random edit through a real Univer command; false when it changed nothing */
export function randomEdit(book: OpenedBook, random: () => number, id: string): boolean {
  const sheets = book.workbook.getSheets().map((sheet) => sheet.getSheetId())
  const subUnitId = pick(random, sheets)
  const sheet = book.workbook.getSheetBySheetId(subUnitId)!
  const rows = Math.min(sheet.getRowCount(), 30)
  const row = int(random, rows)
  const column = int(random, 10)
  const cell = { startRow: row, endRow: row, startColumn: column, endColumn: column }
  const lines = (count: number) => ({
    startRow: row,
    endRow: Math.min(row + count - 1, rows - 1),
    startColumn: 0,
    endColumn: 11,
  })
  const roll = random()
  if (roll < 0.25) {
    return book.edit(id, 'sheet.command.set-range-values', {
      subUnitId,
      range: cell,
      value: { v: pick(random, WORDS) },
    })
  }
  if (roll < 0.35) {
    const ref = `${columnName(int(random, 8))}${1 + int(random, 25)}`
    const target = random() < 0.3 ? `Data!${ref}` : ref
    // Formulas go to a few cells of one column, so that people often write one where another's
    // row or column change is about to rewrite references: the rewrite must not win over it.
    const formulaCell = { startRow: row % 6, endRow: row % 6, startColumn: 2, endColumn: 2 }
    return book.edit(id, 'sheet.command.set-range-values', {
      subUnitId,
      range: formulaCell,
      value: { f: `=${target}+1` },
    })
  }
  if (roll < 0.43) {
    const style = pick(random, [
      { type: 'bl', value: 1 },
      { type: 'it', value: 1 },
      { type: 'bg', value: { rgb: '#ffcc00' } },
      { type: 'fs', value: 14 },
    ])
    return book.edit(id, 'sheet.command.set-style', {
      subUnitId,
      range: { ...cell, endRow: row + int(random, 3) },
      style,
    })
  }
  if (roll < 0.53) {
    return book.edit(id, 'sheet.command.insert-row-by-range', {
      subUnitId,
      range: lines(1 + int(random, 2)),
      direction: UP,
    })
  }
  if (roll < 0.61) {
    if (rows < 6) return false
    return book.edit(id, 'sheet.command.remove-row-by-range', {
      subUnitId,
      range: lines(1 + int(random, 2)),
    })
  }
  if (roll < 0.66) {
    const at = int(random, 8)
    return book.edit(id, 'sheet.command.insert-col-by-range', {
      subUnitId,
      range: { startRow: 0, endRow: rows - 1, startColumn: at, endColumn: at },
      direction: LEFT,
    })
  }
  if (roll < 0.7) {
    const at = int(random, 8)
    return book.edit(id, 'sheet.command.remove-col-by-range', {
      subUnitId,
      range: { startRow: 0, endRow: rows - 1, startColumn: at, endColumn: at },
    })
  }
  if (roll < 0.74) {
    const from = int(random, rows - 3)
    const to = int(random, rows - 1)
    if (to >= from && to <= from + 2) return false
    return book.edit(id, 'test.command.move-rows', { subUnitId, from, count: 2, to })
  }
  if (roll < 0.78) {
    return book.edit(id, 'sheet.command.add-worksheet-merge', {
      subUnitId,
      selections: [{ ...cell, endColumn: column + 1 }],
      defaultMerge: true,
    })
  }
  if (roll < 0.82) {
    return book.edit(id, 'sheet.command.set-row-height', {
      subUnitId,
      ranges: [lines(1)],
      value: 20 + int(random, 40),
    })
  }
  if (roll < 0.85) {
    return book.edit(id, 'sheet.command.set-rows-hidden', { subUnitId, ranges: [lines(1)] })
  }
  if (roll < 0.89) {
    const name = pick(random, WORDS)
    return book.edit(id, 'sheet.command.insert-sheet', {
      index: int(random, sheets.length + 1),
      sheet: { id: `${id}-sheet`, name },
    })
  }
  if (roll < 0.93) {
    return book.edit(id, 'sheet.command.set-worksheet-name', {
      subUnitId,
      name: pick(random, WORDS),
    })
  }
  if (roll < 0.95) {
    if (sheets.length < 2) return false
    return book.edit(id, 'sheet.command.remove-sheet', { subUnitId })
  }
  if (roll < 0.97) {
    return book.edit(id, 'sheet.command.set-worksheet-order', {
      subUnitId,
      order: int(random, sheets.length),
    })
  }
  return book.edit(id, 'sheet.command.set-tab-color', {
    subUnitId,
    color: pick(random, ['#ff0000', '#00aa00']),
  })
}
