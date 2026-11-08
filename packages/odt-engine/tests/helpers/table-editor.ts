/**
 * Test plumbing for the table layer: the registry in T6's order and the two
 * ways the editor saves a changed table (apps/docs `pmDocToSavePlan`):
 * - cell text only → `patchTableCellTexts(original, texts)` (untouched cells
 *   and paragraphs keep their bytes);
 * - structure or formatting → `generateTableModelXml(model, original)`.
 */
import {
  type Block,
  type CellParaPatch,
  type CellTextsPatch,
  type Run,
  type TableModel,
  generateTableModelXml,
  patchTableCellTexts,
} from '@genoffice/docx-engine'
import { ConversionRegistry } from '../../src/core'
import { registerTableConverters } from '../../src/table'
import { registerTextConverters } from '../../src/text'
import type { EditorOp } from './bridge'
import { registryOr } from './full'

/** Text first, then tables — the order T6 registers them. */
export function tableRegistry(): ConversionRegistry {
  return registryOr(() => registerTableConverters(registerTextConverters(new ConversionRegistry())))
}

/** A deep copy of a parsed table block's model. */
export const modelOf = (block: Block): TableModel =>
  JSON.parse(JSON.stringify(block.table)) as TableModel

/** Runs of one cell paragraph of the parsed model (deep copy). */
export function cellRuns(block: Block, row: number, tc: number, para = 0): Run[] {
  const p = block.table?.rows[row]?.[tc]?.richParas?.[para]
  return JSON.parse(JSON.stringify(p?.runs ?? [])) as Run[]
}

/** Replaces `[from, to)` of a run list's text with `insert` (typing into the run at `from`). */
export function editRuns(runs: Run[], from: number, to: number, insert: string): Run[] {
  let at = 0
  let inserted = false
  const out: Run[] = []
  for (const run of runs) {
    const start = at
    const end = at + run.text.length
    at = end
    let text = run.text
    const a = Math.max(from, start)
    const b = Math.min(to, end)
    if (b > a) text = text.slice(0, a - start) + text.slice(b - start)
    if (!inserted && from >= start && from <= end) {
      const k = from - start
      text = text.slice(0, k) + insert + text.slice(k)
      inserted = true
    }
    if (text !== '' || run.image) out.push({ ...run, text })
  }
  if (!inserted) out.push({ text: insert })
  return out
}

export interface CellEdit {
  row: number
  tc: number
  /** per paragraph: null keeps it, runs rewrite it; a different count rewrites the cell */
  paras?: CellParaPatch[]
  /** nested table edits of this cell (one grid per nested table) */
  nested?: Array<Array<Array<CellParaPatch[] | null>> | null>
}

/** The editor's cell-text save: `patchTableCellTexts` over the original `w:tbl`. */
export function patchCells(block: Block, edits: CellEdit[]): EditorOp {
  const rows = block.table?.rows ?? []
  const texts: Array<Array<CellTextsPatch | null>> = rows.map((row) => row.map(() => null))
  for (const e of edits) {
    texts[e.row][e.tc] = e.nested ? { nested: e.nested } : (e.paras as CellParaPatch[])
  }
  return { xml: patchTableCellTexts(block.originalXml as string, texts) }
}

/** The editor's structural save: the table regenerated from its (changed) model. */
export function regenerate(block: Block, change: (model: TableModel) => void): EditorOp {
  const model = modelOf(block)
  change(model)
  return { xml: generateTableModelXml(model, block.originalXml ?? undefined) }
}

/** Cell texts of a parsed table: `[row][tc]` → paragraphs joined by `\n`. */
export function tableTexts(block: Block): string[][] {
  return (block.table?.rows ?? []).map((row) =>
    row.map((cell) =>
      (cell.richParas ?? []).map((p) => p.runs.map((r) => r.text).join('')).join('\n'),
    ),
  )
}

/** null when equal, else both strings around their first difference (readable test failures). */
export function firstDiff(actual: string, expected: string): string | null {
  if (actual === expected) return null
  let i = 0
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++
  let a = actual.length - 1
  let e = expected.length - 1
  while (a >= i && e >= i && actual[a] === expected[e]) {
    a--
    e--
  }
  const from = Math.max(0, i - 120)
  return `at ${i}\n  actual:   …${actual.slice(from, a + 80)}…\n  expected: …${expected.slice(from, e + 80)}…`
}
