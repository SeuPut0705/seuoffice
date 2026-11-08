/**
 * Where the suggestions of an AI highlight run are on the pages
 * (reading-assist spec 4.6): a block's page is found again by its page
 * fingerprint, and the quote is looked up in that page's text as the PDF.js
 * text layer reads it (the viewer's search index). The text layer breaks
 * lines and words differently from the block text the model saw, so both
 * sides are folded the way citations are (ai/quote-find.ts: whitespace and
 * hyphens dropped, case and compatibility forms folded), and, as there, only
 * the whole quote counts: a suggestion is never placed on part of its sentence. A
 * quote that is not found (a scanned or AI-read page, a page that changed)
 * has no place, is not drawn and cannot be accepted. Pure.
 */
import { blockKeyString } from '../../../../../packages/pdf-structure/src/store/keys'
import type { TranslationBlockKey } from '../../../../../packages/pdf-structure/src/store/keys'
import type {
  HighlightBlockEntry,
  HighlightLabel,
  HighlightRun,
  HighlightSuggestionState,
} from '../../../../../packages/pdf-structure/src/store/reading'
import type { MarkupInput } from '../../shared/ipc'
import { findQuoteRects } from '../ai/quote-find'
import type { PageEntry, SearchIndex } from '../search'

export type Rect = [number, number, number, number]

/** the whole quote's rectangles on a page (PDF user space), or null when it is not there */
export function findWholeQuote(entry: PageEntry | undefined, quote: string): Rect[] | null {
  return findQuoteRects(entry, quote)
}

/** one suggestion as the screen shows it */
export interface SuggestionView {
  /** unique in the run: the block key and the suggestion id */
  key: string
  blockKey: TranslationBlockKey
  /** the suggestion id within its block */
  id: string
  label: HighlightLabel
  quote: string
  state: HighlightSuggestionState
  /** original page index the block starts on; null when no page of the file has its fingerprint */
  page: number | null
  /** where the quote is; null when the text layer does not have it */
  found: { origIdx: number; rects: Rect[] } | null
}

export const suggestionKey = (blockKey: TranslationBlockKey, id: string): string =>
  `${blockKeyString(blockKey)}#${id}`

/**
 * The run's suggestions in block order. `fingerprints` are the file's page
 * fingerprints in page order (null while unknown: nothing has a page);
 * `index` is the viewer's text index (null while not read: nothing is
 * found). A quote is looked for on its block's page, then the next page (a
 * paragraph that runs over a page break starts on the first).
 */
export function suggestionViews(
  run: HighlightRun,
  blocks: readonly HighlightBlockEntry[],
  fingerprints: readonly string[] | null,
  index: SearchIndex | null,
): SuggestionView[] {
  const labels = new Map(run.labels.map((l) => [l.id, l]))
  const out: SuggestionView[] = []
  for (const block of blocks) {
    const at = fingerprints ? fingerprints.indexOf(block.key.pageFingerprint) : -1
    const page = at >= 0 ? at : null
    for (const s of block.suggestions) {
      const label = labels.get(s.labelId)
      if (!label) continue
      let found: SuggestionView['found'] = null
      if (page !== null && index) {
        for (const origIdx of [page, page + 1]) {
          const rects = findWholeQuote(index[origIdx], s.quote)
          if (rects) {
            found = { origIdx, rects }
            break
          }
        }
      }
      out.push({
        key: suggestionKey(block.key, s.id),
        blockKey: block.key,
        id: s.id,
        label,
        quote: s.quote,
        state: s.state,
        page,
        found,
      })
    }
  }
  return out
}

/** markup quads (the order the selection path writes) from text rectangles */
export function rectsToQuads(rects: readonly Rect[]): number[][] {
  return rects.map((r) => [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]])
}

/** the rectangle around all of them, or null */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null
  return [
    Math.min(...rects.map((r) => r[0])),
    Math.min(...rects.map((r) => r[1])),
    Math.max(...rects.map((r) => r[2])),
    Math.max(...rects.map((r) => r[3])),
  ]
}

/**
 * The highlight an accepted suggestion becomes in the editing document: the
 * label's color, its name as the category (saved as /Subj), the quote's
 * place. Null when the suggestion has no place.
 */
export function suggestionMarkup(view: SuggestionView): MarkupInput | null {
  if (!view.found) return null
  return {
    pageIndex: view.found.origIdx,
    type: 'highlight',
    color: [view.label.color[0], view.label.color[1], view.label.color[2]],
    quads: rectsToQuads(view.found.rects),
    subject: view.label.name,
  }
}
