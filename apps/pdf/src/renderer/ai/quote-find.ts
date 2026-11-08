/**
 * Finding a cited quote on its page (reading-assist spec 4.7). The model copies
 * 8 to 20 words from the page; the page's text, as the text layer reads it,
 * breaks lines, splits words at line ends with a hyphen and may join or split
 * runs differently. Both sides are folded the same way before comparing:
 *
 * - whitespace of any kind (spaces, line breaks, no-break spaces) is dropped,
 *   so a missing or extra space between runs never matters;
 * - hyphens and dashes are dropped, so "infor-\nmation" matches "information"
 *   and "well-known" matches a line-end "well-\nknown";
 * - case, compatibility forms (ligatures, full-width letters) and curly quotes
 *   are folded.
 *
 * Pure: the viewer turns the span into rectangles with the search index.
 */
import type { PageEntry } from '../search'

/** a span of the page text, [start, end) */
export interface QuoteSpan {
  start: number
  end: number
}

/** shortest folded quote worth looking for (a few characters would match anywhere) */
const MIN_FOLDED = 4

const SKIP = /[\s\u00AD\u200B-\u200D\u2060\uFEFF\-\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032`\u00B4]/
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/

/** the folded text and, for each folded character, the index it came from */
export function foldForQuote(text: string): { folded: string; map: number[] } {
  let folded = ''
  const map: number[] = []
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (SKIP.test(ch)) continue
    const unit = SINGLE_QUOTES.test(ch)
      ? "'"
      : DOUBLE_QUOTES.test(ch)
        ? '"'
        : ch.normalize('NFKC').toLowerCase()
    for (const c of unit) {
      if (SKIP.test(c)) continue
      for (let k = 0; k < c.length; k++) {
        folded += c[k]
        map.push(i)
      }
    }
  }
  return { folded, map }
}

function spanOf(map: readonly number[], at: number, length: number): QuoteSpan {
  return { start: map[at]!, end: map[at + length - 1]! + 1 }
}

/**
 * Where the whole quote is in the page text, or null. Only the whole quote
 * counts: a part of it could be another passage, and a citation that is not
 * found goes to its page alone.
 */
export function findQuoteSpan(pageText: string, quote: string): QuoteSpan | null {
  const q = foldForQuote(quote).folded
  if (q.length < MIN_FOLDED) return null
  const page = foldForQuote(pageText)
  const at = page.folded.indexOf(q)
  return at >= 0 ? spanOf(page.map, at, q.length) : null
}

/** the PDF user-space rectangles of a span, interpolated within runs like the viewer search */
export function spanRects(entry: PageEntry, span: QuoteSpan): [number, number, number, number][] {
  const rects: [number, number, number, number][] = []
  for (const it of entry.items) {
    if (it.end <= span.start || it.start >= span.end) continue
    const len = it.end - it.start
    if (len <= 0) continue
    const lo = (Math.max(span.start, it.start) - it.start) / len
    const hi = (Math.min(span.end, it.end) - it.start) / len
    const x1 = it.x + it.w * lo
    const x2 = it.x + it.w * hi
    if (x2 - x1 < 0.01) continue
    rects.push([x1, it.y, x2, it.y + it.h])
  }
  return rects
}

/** the quote's rectangles on a page, or null when the page does not have it */
export function findQuoteRects(
  entry: PageEntry | undefined,
  quote: string,
): [number, number, number, number][] | null {
  if (!entry) return null
  const span = findQuoteSpan(entry.text, quote)
  if (!span) return null
  const rects = spanRects(entry, span)
  return rects.length > 0 ? rects : null
}
