/**
 * Checking an AI highlight answer (reading-assist spec 4.6). A suggestion is
 * kept only when
 * - its block id is one of the batch's blocks and its label one of the run's
 *   labels (by name, or by id);
 * - its quote is in that block's text, comparing with whitespace normalized
 *   and nothing else (no case folding, no punctuation or spelling slack): a
 *   sentence the model made up or changed never becomes a suggestion;
 * - it is the first suggestion of that quote in its block.
 * Everything else is dropped and counted. Pure.
 */
import type { HighlightAnswerItem, HighlightLabelRef, HighlightRequestBlock } from './prompt'

/** whitespace runs (line breaks, tabs, no-break spaces) collapsed to one space, trimmed */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** the quote occurs in the block text, whitespace normalized on both sides */
export function quoteInBlock(quote: string, blockText: string): boolean {
  const q = normalizeWhitespace(quote)
  return q !== '' && normalizeWhitespace(blockText).includes(q)
}

/** one kept suggestion: the label's id and the quote as the block has it (whitespace normalized) */
export interface CheckedSuggestion {
  labelId: string
  quote: string
}

export interface HighlightCheck {
  /** block id → its kept suggestions, in answer order */
  byBlock: Map<string, CheckedSuggestion[]>
  /** entries in the answer */
  received: number
  /** entries dropped (unknown block or label, not in the block, repeated, malformed) */
  dropped: number
}

export function checkHighlightAnswer(
  items: readonly HighlightAnswerItem[],
  blocks: readonly HighlightRequestBlock[],
  labels: readonly HighlightLabelRef[],
): HighlightCheck {
  const texts = new Map(blocks.map((b) => [b.id, normalizeWhitespace(b.text)]))
  const byName = new Map(labels.map((l) => [l.name.trim(), l.id]))
  const byId = new Set(labels.map((l) => l.id))
  const byBlock = new Map<string, CheckedSuggestion[]>()
  const seen = new Map<string, Set<string>>()
  let dropped = 0
  for (const item of items) {
    const blockId =
      typeof item.blockId === 'string' || typeof item.blockId === 'number'
        ? String(item.blockId)
        : null
    const text = blockId === null ? undefined : texts.get(blockId)
    const label = typeof item.label === 'string' ? item.label.trim() : null
    const labelId =
      label === null ? undefined : (byName.get(label) ?? (byId.has(label) ? label : undefined))
    const quote = typeof item.quote === 'string' ? normalizeWhitespace(item.quote) : ''
    if (blockId === null || text === undefined || labelId === undefined || quote === '') {
      dropped++
      continue
    }
    if (!text.includes(quote)) {
      dropped++
      continue
    }
    let quotes = seen.get(blockId)
    if (!quotes) seen.set(blockId, (quotes = new Set()))
    if (quotes.has(quote)) {
      dropped++
      continue
    }
    quotes.add(quote)
    let kept = byBlock.get(blockId)
    if (!kept) byBlock.set(blockId, (kept = []))
    kept.push({ labelId, quote })
  }
  return { byBlock, received: items.length, dropped }
}
