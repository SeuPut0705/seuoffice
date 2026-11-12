// Whole-document passes run after the block list is built: protected leading
// breaks, balanced DBCS spacing, image z-order normalization.
import type { Block } from './types'
import { invoke } from './engine'

export function applyProtectedLeadingBreaks(blocks: Block[]): void {
  const done = invoke('applyProtectedLeadingBreaks', [blocks]) as typeof blocks
  blocks.splice(0, blocks.length, ...done)
}
export function keepsHangulKanaSingle(font: string | undefined): boolean {
  return invoke('keepsHangulKanaSingle', [font]) as never
}