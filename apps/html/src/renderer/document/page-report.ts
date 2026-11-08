import type { PageSetup } from './page-setup'

/** What the preview frame measured with the page laid out on paper (inspector.js, measurePaper). */
export interface PageMeasure {
  pages: number
  /** per page: share of the content box height the content reaches, 0..1 */
  fill: number[]
  /** per page: the first element that begins on it; null when the page only continues earlier ones */
  starts: Array<number | null>
  /** innermost elements a page boundary cuts: [sid, first page, last page], pages 0-based */
  splits: Array<[number, number, number]>
  /** elements that force a break before themselves: [sid, the page they start] */
  breaks: Array<[number, number]>
}

const MAX_PAGES = 100_000
/** a page that is not the last and holds less than this is worth pointing out */
const SPARSE = 0.4
const MM_PER_PX = 25.4 / 96

const isSid = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

/** The frame runs the document's own scripts, so its answer is checked field by field. */
export function readPageMeasure(raw: unknown): PageMeasure | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { pages, fill, starts, splits, breaks } = raw as Record<string, unknown>
  if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 1 || pages > MAX_PAGES)
    return null
  const isPage = (v: unknown): v is number => isSid(v) && v < pages
  if (!Array.isArray(fill) || fill.length !== pages) return null
  if (!fill.every((v) => typeof v === 'number' && v >= 0 && v <= 1)) return null
  if (!Array.isArray(starts) || starts.length !== pages) return null
  if (!starts.every((v) => v === null || isSid(v))) return null
  if (!Array.isArray(splits) || !Array.isArray(breaks)) return null
  const okSplit = (v: unknown) =>
    Array.isArray(v) && v.length === 3 && isSid(v[0]) && isPage(v[1]) && isPage(v[2]) && v[1] < v[2]
  const okBreak = (v: unknown) => Array.isArray(v) && v.length === 2 && isSid(v[0]) && isPage(v[1])
  if (!splits.every(okSplit) || !breaks.every(okBreak)) return null
  return {
    pages,
    fill: fill as number[],
    starts: starts as Array<number | null>,
    splits: splits as Array<[number, number, number]>,
    breaks: breaks as Array<[number, number]>,
  }
}

const percent = (v: number) => `${Math.round(v * 100)}%`

/**
 * The measurement in the words the model edits by: sids it can address and
 * page numbers as the reader counts them (from 1). `describe` names an element
 * the way the outline does; null for one the source no longer has.
 */
export function formatPageReport(
  setup: PageSetup,
  measure: PageMeasure,
  describe: (sid: number) => string | null,
): string {
  const name = (sid: number) => `sid=${sid}${describe(sid) ? ` ${describe(sid)}` : ''}`
  const mm = (px: number) => Math.round(px * MM_PER_PX)
  const lines = [
    `Print layout, measured with the print engine: ${measure.pages} page${measure.pages === 1 ? '' : 's'}; each page holds ${mm(setup.width)} × ${mm(setup.height)} mm of content.`,
  ]
  const forced = new Map(measure.breaks.map(([sid, page]) => [page, sid]))
  for (let page = 0; page < measure.pages; page++) {
    const parts = [`p${page + 1}: ${percent(measure.fill[page]!)} full`]
    const start = measure.starts[page]
    if (start !== null && start !== undefined) {
      const breakSid = forced.get(page)
      parts.push(
        `starts with ${name(start)}${breakSid !== undefined && page > 0 ? ` (forced page break before ${breakSid === start ? 'it' : `sid=${breakSid}`})` : ''}`,
      )
    }
    const carried = measure.splits.filter(([, from, to]) => from < page && page <= to)
    if (carried.length) parts.push(`continues ${carried.map(([sid]) => `sid=${sid}`).join(', ')}`)
    lines.push(parts.join('; '))
  }
  if (measure.splits.length)
    lines.push(
      `Cut by a page boundary: ${measure.splits.map(([sid, from, to]) => `${name(sid)} (p${from + 1}–p${to + 1})`).join('; ')}`,
    )
  const sparse = measure.fill
    .map((v, page) => ({ v, page }))
    .filter(({ v, page }) => page < measure.pages - 1 && v < SPARSE)
  if (sparse.length)
    lines.push(
      `Mostly empty before the last page: ${sparse.map(({ v, page }) => `p${page + 1} (${percent(v)})`).join(', ')}`,
    )
  if (!measure.splits.length && !sparse.length)
    lines.push('No page is mostly empty and nothing is cut by a page boundary.')
  return lines.join('\n')
}
