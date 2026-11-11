import { describe, expect, it } from 'vitest'

import { applyStructuralOps, type StructuralOp } from '../src/gateway/xlsx-structure'

const SHEET = 'Data'

/// A column op whose span is empty: it leaves a sheet without <cols>
/// byte-identical, and sitting between two ops it stops them forming a run —
/// so `sequential` replays the ops one at a time, the way the save did before
/// runs were batched.
const BREAK: StructuralOp = { kind: 'set-col-size', start: 5, end: 4, size: null }

function sequential(xml: string, ops: readonly StructuralOp[]): string {
  return applyStructuralOps(
    xml,
    ops.flatMap((op) => [op, BREAK]),
    SHEET,
  )
}

function worksheet(rows: string, tail = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D40"/><sheetFormatPr defaultRowHeight="15"/><sheetData>${rows}</sheetData>${tail}</worksheet>`
}

/// Deterministic pseudo-random source so a failure reproduces.
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
}

function sparseRows(next: () => number, count: number): string {
  let rows = ''
  for (let row = 1; row <= count; row += 1) {
    if (next() < 0.4) continue
    const attrs = [
      next() < 0.4 ? ` ht="${15 + Math.floor(next() * 10)}"` : '',
      next() < 0.3 ? ' customHeight="1"' : '',
      next() < 0.2 ? ' hidden="1"' : '',
      next() < 0.2 ? ` outlineLevel="${1 + Math.floor(next() * 3)}"` : '',
      next() < 0.1 ? ' collapsed="1"' : '',
    ]
      .sort(() => next() - 0.5)
      .join('')
    rows +=
      next() < 0.3
        ? `<row r="${row}"${attrs}/>`
        : `<row r="${row}"${attrs}><c r="A${row}"><v>${row}</v></c></row>`
  }
  return rows
}

function rowOp(next: () => number, rows: number): StructuralOp {
  const start = Math.floor(next() * rows)
  const end = Math.min(rows + 5, start + Math.floor(next() * 6))
  const pick = next()
  if (pick < 0.45) {
    return {
      kind: 'set-row-size',
      start,
      end,
      size: next() < 0.25 ? null : 12 + Math.floor(next() * 20),
    }
  }
  if (pick < 0.75) return { kind: 'set-rows-hidden', start, end, hidden: next() < 0.6 }
  return {
    kind: 'set-rows-outline',
    start,
    end,
    level: Math.floor(next() * 4),
    ...(next() < 0.5 ? {} : { collapsed: next() < 0.5 }),
  }
}

describe('runs of row attribute ops', () => {
  it('match the one-op-at-a-time result byte for byte', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = random(seed)
      const rowCount = 5 + Math.floor(next() * 30)
      const xml = worksheet(sparseRows(next, rowCount))
      const ops = Array.from({ length: 2 + Math.floor(next() * 12) }, () => rowOp(next, rowCount))
      expect(applyStructuralOps(xml, ops, SHEET), `seed ${seed}`).toBe(sequential(xml, ops))
    }
  })

  it('match it on an empty <sheetData/> and past the last row', () => {
    const ops: StructuralOp[] = [
      { kind: 'set-row-size', start: 8, end: 9, size: 30 },
      { kind: 'set-rows-hidden', start: 2, end: 3, hidden: true },
      { kind: 'set-row-size', start: 3, end: 3, size: null },
    ]
    const empty = worksheet('').replace('<sheetData></sheetData>', '<sheetData/>')
    expect(applyStructuralOps(empty, ops, SHEET)).toBe(sequential(empty, ops))
    const short = worksheet('<row r="1"><c r="A1"><v>1</v></c></row>')
    expect(applyStructuralOps(short, ops, SHEET)).toBe(sequential(short, ops))
  })

  it('fall back to the sequential pass on rows out of order', () => {
    const xml = worksheet(
      '<row r="5"><c r="A5"><v>5</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>',
    )
    const ops: StructuralOp[] = [
      { kind: 'set-row-size', start: 0, end: 6, size: 20 },
      { kind: 'set-rows-hidden', start: 3, end: 3, hidden: true },
    ]
    expect(applyStructuralOps(xml, ops, SHEET)).toBe(sequential(xml, ops))
  })

  it('collapse an undo that restores every line separately', () => {
    // Undoing a 3,000-row height change journals one op per row.
    let rows = ''
    for (let row = 1; row <= 3000; row += 1) {
      rows += `<row r="${row}" ht="${15 + (row % 7)}"><c r="A${row}"><v>${row}</v></c></row>`
    }
    const xml = worksheet(rows)
    const ops: StructuralOp[] = Array.from({ length: 3000 }, (_, row) => ({
      kind: 'set-row-size' as const,
      start: row,
      end: row,
      size: 15 + ((row + 1) % 7),
    }))
    const started = performance.now()
    const result = applyStructuralOps(xml, ops, SHEET)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(result).toContain('<row r="3000" ht="19" customHeight="1">')
    expect(result.match(/customHeight="1"/g)).toHaveLength(3000)
  })
})

describe('runs of merge and unmerge ops', () => {
  const merges = (refs: readonly string[]): string =>
    `<mergeCells count="${refs.length}">${refs.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
  const area = (startRow: number, endRow: number, column: number) => ({
    startRow,
    endRow,
    startColumn: column,
    endColumn: column,
  })

  it('unmerging every region matches the one-op-at-a-time result', () => {
    const xml = worksheet('<row r="1"/>', merges(['A1:A2', 'B1:B2', 'A3:A4', 'A1:A2']))
    const all: StructuralOp[] = [
      { kind: 'unmerge-cells', range: area(0, 1, 0) },
      { kind: 'unmerge-cells', range: area(2, 3, 0) },
      { kind: 'unmerge-cells', range: area(0, 1, 0) },
      { kind: 'unmerge-cells', range: area(0, 1, 1) },
    ]
    expect(applyStructuralOps(xml, all, SHEET)).toBe(sequential(xml, all))
    expect(applyStructuralOps(xml, all, SHEET)).not.toContain('mergeCell')
    const some = all.slice(0, 2)
    expect(applyStructuralOps(xml, some, SHEET)).toBe(sequential(xml, some))
    const missing: StructuralOp[] = [
      { kind: 'unmerge-cells', range: area(9, 10, 3) },
      { kind: 'unmerge-cells', range: area(0, 1, 1) },
    ]
    expect(applyStructuralOps(xml, missing, SHEET)).toBe(sequential(xml, missing))
  })

  it('merging many regions matches it, with or without an existing section', () => {
    const ops: StructuralOp[] = [
      { kind: 'merge-cells', range: area(0, 1, 0) },
      { kind: 'merge-cells', range: area(0, 1, 1) },
      { kind: 'merge-cells', range: area(4, 6, 2) },
    ]
    const bare = worksheet('<row r="1"/>')
    expect(applyStructuralOps(bare, ops, SHEET)).toBe(sequential(bare, ops))
    const filtered = worksheet('<row r="1"/>', '<autoFilter ref="A1:D9"/>')
    expect(applyStructuralOps(filtered, ops, SHEET)).toBe(sequential(filtered, ops))
    const withSection = worksheet('<row r="1"/>', merges(['D1:D2']))
    expect(applyStructuralOps(withSection, ops, SHEET)).toBe(sequential(withSection, ops))
  })

  it('unmerging thousands of regions stays fast', () => {
    const refs: string[] = []
    const ops: StructuralOp[] = []
    for (let row = 0; row < 6000; row += 2) {
      refs.push(`A${row + 1}:A${row + 2}`)
      ops.push({ kind: 'unmerge-cells', range: area(row, row + 1, 0) })
    }
    const xml = worksheet('<row r="1"/>', merges(refs))
    const started = performance.now()
    const result = applyStructuralOps(xml, ops, SHEET)
    expect(performance.now() - started).toBeLessThan(2_000)
    expect(result).not.toContain('<mergeCell')
  })
})
