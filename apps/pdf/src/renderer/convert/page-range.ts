/**
 * Page ranges typed in the conversion dialog: "1-5,8" style, 1-based page
 * numbers of the document as it is on disk once pending edits are saved.
 */

export type PageRangeResult =
  | { ok: true; pages: number[] }
  /** syntax: not a list of numbers and ranges; outOfRange: a page outside 1..pageCount */
  | { ok: false; reason: 'empty' | 'syntax' | 'outOfRange' }

/** dashes people type for a range: hyphen, en dash, em dash, full-width tilde and tilde */
const RANGE_RE = /^(\d{1,6})\s*(?:[-‐–—~～]\s*(\d{1,6}))?$/

/**
 * The pages a range string names, ascending and without repeats. A reversed
 * range ("5-3") is read as the same pages. Commas, semicolons and Asian commas
 * separate the parts.
 */
export function parsePageRange(text: string, pageCount: number): PageRangeResult {
  const parts = text
    .split(/[,;，、；]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return { ok: false, reason: 'empty' }
  const pages = new Set<number>()
  let outside = false
  for (const part of parts) {
    const m = RANGE_RE.exec(part)
    if (!m) return { ok: false, reason: 'syntax' }
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    if (lo < 1 || hi > pageCount) {
      outside = true
      continue
    }
    for (let page = lo; page <= hi; page++) pages.add(page)
  }
  if (outside) return { ok: false, reason: 'outOfRange' }
  return { ok: true, pages: [...pages].sort((x, y) => x - y) }
}
