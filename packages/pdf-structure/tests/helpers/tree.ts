/** Small readers over a DocumentTree for assertions. */
import type { DocumentTree, InlineRun, TreeBlock } from '../../src/tree'
import { runsText } from '../../src/tree'

export const textOf = (runs: InlineRun[]): string => runsText(runs).replace(/\s+/g, ' ').trim()

export function blockText(block: TreeBlock): string {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'listItem':
      return textOf(block.runs)
    default:
      return ''
  }
}

export const bodyBlocks = (tree: DocumentTree): TreeBlock[] =>
  tree.blocks.filter((b) => b.kind !== 'pageBreak')

export const findBlock = (tree: DocumentTree, needle: string): TreeBlock | undefined =>
  tree.blocks.find((b) => blockText(b).includes(needle))

export const paragraphsContaining = (tree: DocumentTree, needle: string): TreeBlock[] =>
  tree.blocks.filter((b) => b.kind === 'paragraph' && blockText(b).includes(needle))
