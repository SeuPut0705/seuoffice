// Whole-document passes run after the block list is built: protected leading
// breaks, balanced DBCS spacing, image z-order normalization.
import type { Block, Run, TableModel, TextboxDisplay } from './types'
import { invoke } from './engine'

export function applyProtectedLeadingBreaks(blocks: Block[]): void {
  const done = invoke('applyProtectedLeadingBreaks', [blocks]) as typeof blocks
  blocks.forEach((block, i) => {
    const next = done[i]! as unknown as Record<string, unknown>
    const held = block as unknown as Record<string, unknown>
    for (const key of Object.keys(held)) if (!(key in next)) delete held[key]
    Object.assign(held, next)
  })
}
export function keepsHangulKanaSingle(font: string | undefined): boolean {
  return invoke('keepsHangulKanaSingle', [font]) as never
}
/** every run container reachable from the parsed blocks (tables, textboxes, nested tables) */
export function blockRunGroups(blocks: Block[]): Array<Run[] | undefined> {
  const groups: Array<Run[] | undefined> = []
  const fromBoxes = (boxes?: TextboxDisplay[]) => {
    for (const box of boxes ?? []) for (const para of box.paras) groups.push(para.runs)
  }
  const fromTable = (table?: TableModel) => {
    if (!table) return
    for (const row of table.rows) {
      for (const cell of row) {
        for (const para of cell.richParas ?? []) groups.push(para.runs)
        fromBoxes(cell.anchoredBoxes)
        for (const nested of cell.nestedTables ?? []) fromTable(nested)
      }
    }
  }
  for (const b of blocks) {
    groups.push(b.runs)
    groups.push(b.strayRuns)
    fromTable(b.table ?? undefined)
    fromBoxes(b.textboxes)
  }
  return groups
}
