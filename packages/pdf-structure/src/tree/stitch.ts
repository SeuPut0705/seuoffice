/**
 * Reflow joining across page boundaries. pdf2docx's stitchCrossPageParagraphs
 * (pipeline.ts, P32) already joined the single-column boundaries it accepts;
 * it skips multi-column pages and pages with page-pinned art because a Word
 * page break matters there. Reflow output has no pages, so this pass runs
 * the same tests on every remaining boundary: on multi-column pages the
 * tail is the end of the last column and the head the start of the first.
 *
 * Thresholds are pdf2docx's (STITCH_* in pipeline.ts) — keep them in sync.
 */
import type { IrPage, PageColumn, TextBlock } from '../../../pdf2docx/src/ir'
import { lineFontSize, lineWidth, type Draft, type TextDraft } from './draft'

/** the continuation's font size must stay within this ratio of the tail's */
const STITCH_SIZE_TOL = 1.1
/** left edges must agree within this many ems */
const STITCH_LEFT_TOL_EMS = 0.6
/** the tail line must reach this share of its block's widest line (unfinished) */
const STITCH_TAIL_FULL_RATIO = 0.9
/** the earlier page's content must span this share of the page height */
const STITCH_PREV_FILL_MIN = 0.72

const joinable = (d: Draft | undefined): d is TextDraft =>
  d !== undefined &&
  d.kind === 'text' &&
  d.role === 'paragraph' &&
  d.ir.list === undefined &&
  d.ir.tocEntry === undefined &&
  d.ir.cardId === undefined &&
  d.segments.length > 0

const isMultiColumn = (p: IrPage): boolean =>
  (p.sections?.length ?? 0) > 1 || (p.sections ?? []).some((s) => s.columns.length > 1)

export function columnOf(page: IrPage, block: TextBlock): PageColumn | undefined {
  for (const section of page.sections ?? []) {
    for (const column of section.columns) if (column.blocks.includes(block)) return column
  }
  return undefined
}

function contentFill(page: IrPage): number {
  if (page.heightPt <= 0 || page.blocks.length === 0) return 0
  let top = Number.NEGATIVE_INFINITY
  let bottom = Number.POSITIVE_INFINITY
  for (const b of page.blocks) {
    if (b.box.y1 > top) top = b.box.y1
    if (b.box.y0 < bottom) bottom = b.box.y0
  }
  return (top - bottom) / page.heightPt
}

/** the boundary passes pdf2docx's stitch tests (columns made relative) */
function shouldJoin(prev: IrPage, cur: IrPage, tail: TextDraft, head: TextDraft): boolean {
  if (tail.ir.dir !== head.ir.dir) return false
  if (contentFill(prev) < STITCH_PREV_FILL_MIN) return false
  const tailSeg = tail.segments[tail.segments.length - 1]!
  const headSeg = head.segments[0]!
  const tailLine = tailSeg.lines[tailSeg.lines.length - 1]
  const headLine = headSeg.lines[0]
  if (!tailLine || !headLine) return false
  const fontSize = lineFontSize(tailLine)
  const sizeRatio = fontSize / lineFontSize(headLine)
  if (sizeRatio > STITCH_SIZE_TOL || sizeRatio < 1 / STITCH_SIZE_TOL) return false
  const widest = tailSeg.lines.reduce((max, l) => Math.max(max, lineWidth(l)), 0)
  if (lineWidth(tailLine) < STITCH_TAIL_FULL_RATIO * widest) return false
  // left alignment: raw x on single-column pages (pdf2docx's test), relative
  // to the block's own column when either page has columns
  const columns = isMultiColumn(prev) || isMultiColumn(cur)
  const tailX = tailSeg.box.x0 - (columns ? (tail.column?.box.x0 ?? 0) : 0)
  const headX = headSeg.box.x0 - (columns ? (head.column?.box.x0 ?? 0) : 0)
  if (Math.abs(tailX - headX) > STITCH_LEFT_TOL_EMS * fontSize) return false
  if (head.ir.firstLineIndentPt > STITCH_LEFT_TOL_EMS * fontSize) return false
  return true
}

/**
 * Join paragraphs across analyzed page boundaries. `pages[i]` holds page i's
 * drafts in reading order; joined heads move into their tail draft. Pages
 * the IR already stitched (`flowsFromPrev`) are left alone.
 */
export function joinAcrossPages(
  irPages: IrPage[],
  pages: Draft[][],
  eligible: (pageIndex: number) => boolean,
): void {
  for (let i = 1; i < pages.length; i++) {
    const prev = irPages[i - 1]!
    const cur = irPages[i]!
    if (!eligible(i - 1) || !eligible(i)) continue
    if (cur.flowsFromPrev) continue
    if (prev.scanned || prev.degraded || prev.canvas || cur.scanned || cur.degraded || cur.canvas) {
      continue
    }
    const prevDrafts = pages[i - 1]!
    const curDrafts = pages[i]!
    const tail = prevDrafts[prevDrafts.length - 1]
    const head = curDrafts[0]
    if (!joinable(tail) || !joinable(head) || head.segments.length !== 1) continue
    if (!shouldJoin(prev, cur, tail, head)) continue
    tail.segments.push(...head.segments)
    curDrafts.shift()
    // a page holding nothing but the continuation passes the joined draft
    // on as its tail, so a paragraph can run across several pages; emission
    // only writes a draft on its own start page
    if (curDrafts.length === 0) curDrafts.push(tail)
  }
}
