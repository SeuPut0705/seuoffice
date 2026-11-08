/**
 * Batches of blocks for one AI highlight call each (reading-assist spec 4.6:
 * about 2,500 tokens, tunable). The same rough token count as translation
 * (translate/batch.ts), measured on the plain text that is sent.
 */
import { BLOCK_OVERHEAD_TOKENS, estimateTokens } from '../translate/batch'

/** source tokens per batch (spec 4.6: about 2,500, tunable) */
export const HIGHLIGHT_BATCH_TOKENS = 2_500

export interface HighlightBatchOptions {
  /** token budget of one batch; default HIGHLIGHT_BATCH_TOKENS */
  maxTokens?: number
}

/**
 * Cut items into batches in reading order. A batch closes before the item
 * that would take it over the budget; an item over the budget on its own
 * goes alone.
 */
export function batchHighlightItems<I extends { text: string }>(
  items: readonly I[],
  options: HighlightBatchOptions = {},
): I[][] {
  const max = options.maxTokens ?? HIGHLIGHT_BATCH_TOKENS
  if (!Number.isFinite(max) || max <= 0) {
    throw new RangeError(`highlight batch: invalid token budget ${max}`)
  }
  const batches: I[][] = []
  let current: I[] = []
  let used = 0
  for (const item of items) {
    const tokens = estimateTokens(item.text) + BLOCK_OVERHEAD_TOKENS
    if (current.length > 0 && used + tokens > max) {
      batches.push(current)
      current = []
      used = 0
    }
    current.push(item)
    used += tokens
  }
  if (current.length > 0) batches.push(current)
  return batches
}
