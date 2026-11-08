/**
 * The repetition filter (spec §7): a reading model sometimes falls into a
 * loop and writes the same phrase over and over. Such a block is dropped, not
 * trimmed. Two signals:
 *
 * - inside one block: a large share of its word n-grams belong to n-grams
 *   that occur many times (a looping phrase covers most of the block)
 * - across blocks: the same text block repeated many times in a row
 *
 * Words are letter/digit runs; CJK characters count one each, since those
 * scripts do not separate words with spaces.
 */
import type { AiContentBlock } from './content'
import { runsText } from '../tree/inline'

export interface AiReadRepetitionTuning {
  /** n-gram length in words */
  ngram: number
  /** blocks with fewer n-grams than this are never judged */
  minNgrams: number
  /** an n-gram counts as repeating when it occurs at least this often */
  minCount: number
  /** share of n-gram positions held by repeating n-grams that marks a loop */
  minShare: number
  /** identical text blocks allowed in a row; the rest of the run is dropped */
  maxSameBlocks: number
  /** blocks with fewer words are not compared for identical runs */
  sameBlockMinWords: number
}

export const AI_READ_REPETITION: Readonly<AiReadRepetitionTuning> = Object.freeze({
  ngram: 3,
  minNgrams: 12,
  minCount: 5,
  minShare: 0.5,
  maxSameBlocks: 3,
  sameBlockMinWords: 3,
})

const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}\p{M}]+/gu

function words(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []) as string[]
}

function tuning(t: Partial<AiReadRepetitionTuning> | undefined): AiReadRepetitionTuning {
  return { ...AI_READ_REPETITION, ...t }
}

/** does this text loop a phrase abnormally? */
export function findRepetitionLoop(
  text: string,
  options?: Partial<AiReadRepetitionTuning>,
): boolean {
  const t = tuning(options)
  const w = words(text)
  const total = w.length - t.ngram + 1
  if (total < t.minNgrams) return false
  const grams: string[] = []
  const counts = new Map<string, number>()
  for (let i = 0; i < total; i++) {
    const g = w.slice(i, i + t.ngram).join('\u0001')
    grams.push(g)
    counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  let repeating = 0
  for (const g of grams) if (counts.get(g)! >= t.minCount) repeating++
  return repeating / total >= t.minShare
}

/** the texts of a block the in-block check looks at (each judged alone) */
function blockTexts(b: AiContentBlock): string[] {
  switch (b.kind) {
    case 'heading':
    case 'paragraph':
    case 'listItem':
      return [runsText(b.runs)]
    case 'table':
      return [
        ...b.table.cells.map((c) => c.paragraphs.map(runsText).join(' ')),
        ...(b.caption ? [runsText(b.caption.runs)] : []),
      ]
    case 'figure':
      return b.caption ? [runsText(b.caption.runs)] : []
    case 'math':
      return []
  }
}

/** a block's text for the identical-run check, or null when not compared */
function sameKey(b: AiContentBlock, minWords: number): string | null {
  if (b.kind !== 'heading' && b.kind !== 'paragraph' && b.kind !== 'listItem') return null
  const w = words(runsText(b.runs))
  return w.length >= minWords ? w.join(' ') : null
}

/** drop looping blocks; returns the kept blocks and how many were dropped */
export function filterRepetitions(
  blocks: readonly AiContentBlock[],
  options?: Partial<AiReadRepetitionTuning>,
): { blocks: AiContentBlock[]; dropped: number } {
  const t = tuning(options)
  const kept: AiContentBlock[] = []
  let dropped = 0
  let runKey: string | null = null
  let runLength = 0
  for (const b of blocks) {
    if (blockTexts(b).some((text) => findRepetitionLoop(text, t))) {
      dropped++
      continue
    }
    const key = sameKey(b, t.sameBlockMinWords)
    if (key !== null && key === runKey) runLength++
    else {
      runKey = key
      runLength = 1
    }
    if (key !== null && runLength > t.maxSameBlocks) {
      dropped++
      continue
    }
    kept.push(b)
  }
  return { blocks: kept, dropped }
}
