/**
 * What the document overview sends (reading-assist spec 4.8, 8): the whole
 * document's structured text, page by page, each page headed by its original
 * page number so the model can say where a term first appears.
 *
 * Up to `INSIGHTS_SINGLE_CALL_MAX_CHARS` the overview is one model call. A
 * longer document becomes a document job: the pages are cut into batches of at
 * most that size (a page longer than a batch is cut into pieces), each batch
 * gets a partial summary, and one last call merges them.
 *
 * Pure: the tree comes from the structure channel, nothing is sent here.
 */
import { treeToStructuredText } from '../../../../../../packages/pdf-structure/src/structured-text/format'
import type { DocumentTree } from '../../../../../../packages/pdf-structure/src/tree/types'

/** the most text one overview call carries (tunable); above it the overview is a document job */
export const INSIGHTS_SINGLE_CALL_MAX_CHARS = 60_000

/** one page of the text sent */
export interface InsightsPageText {
  /** 1-based original page */
  page: number
  text: string
}

/** one batch of a long document: the pages it covers and the text sent for it */
export interface InsightsBatch {
  pages: number[]
  text: string
}

export type InsightsPlan =
  | {
      mode: 'single'
      /** pages whose text is sent, ascending */
      pages: number[]
      text: string
    }
  | {
      mode: 'job'
      pages: number[]
      batches: InsightsBatch[]
      /** model calls: one per batch, then the merge */
      calls: number
    }

/** the pages of the tree that have text, in page order */
export function insightsPages(tree: DocumentTree): InsightsPageText[] {
  return treeToStructuredText(tree)
    .map((p) => ({ page: p.page, text: p.text.trim() }))
    .filter((p) => p.text.length > 0)
    .sort((a, b) => a.page - b.page)
}

/** a page as it is sent: a header line with its number, then its text */
export function pageBlock(page: number, text: string, continued = false): string {
  return `[page ${page}${continued ? ', continued' : ''}]\n${text}`
}

const JOINER = '\n\n'

/** one call when it fits, else batches of at most `max` characters and a merge */
export function planInsights(
  pages: readonly InsightsPageText[],
  max: number = INSIGHTS_SINGLE_CALL_MAX_CHARS,
): InsightsPlan {
  const numbers = pages.map((p) => p.page)
  const whole = pages.map((p) => pageBlock(p.page, p.text)).join(JOINER)
  if (whole.length <= max) return { mode: 'single', pages: numbers, text: whole }

  const batches: InsightsBatch[] = []
  let text = ''
  let covered: number[] = []
  const flush = () => {
    if (!text) return
    batches.push({ pages: covered, text })
    text = ''
    covered = []
  }
  const add = (block: string, page: number) => {
    if (text && text.length + JOINER.length + block.length > max) flush()
    text = text ? `${text}${JOINER}${block}` : block
    if (covered.at(-1) !== page) covered.push(page)
  }
  for (const p of pages) {
    const block = pageBlock(p.page, p.text)
    if (block.length <= max) {
      add(block, p.page)
      continue
    }
    // a page longer than a batch: cut its text into pieces that fit with their header
    const room = Math.max(1, max - pageBlock(p.page, '', true).length)
    for (let at = 0; at < p.text.length; at += room) {
      add(pageBlock(p.page, p.text.slice(at, at + room), at > 0), p.page)
    }
  }
  flush()
  return { mode: 'job', pages: numbers, batches, calls: batches.length + 1 }
}
