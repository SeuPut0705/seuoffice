/**
 * Heading levels (spec §1), strongest evidence first:
 *   1. a PDF bookmark whose title matches the line, on the page it targets
 *   2. a printed-TOC entry (IR `tocEntry`) whose title matches the line
 *   3. font statistics: lines clearly larger (or bolder) than body text,
 *      ranked by size. Tiers already seen in 1–2 reuse those levels.
 * Levels never exceed 6.
 */
import type { RawBookmark } from './pdfium-doc'
import { lineText } from './inline'
import { allLines, textStyle, type TextDraft } from './draft'

const MAX_LEVEL = 6
/** "clearly above" body text: at least this size ratio */
const HEADING_SIZE_RATIO = 1.15
/** headings are short */
const HEADING_MAX_LINES = 3
const HEADING_MAX_CHARS = 200
/** bold-at-body-size headings: one short line, no sentence punctuation at its end */
const BOLD_HEADING_MAX_CHARS = 80

export interface TocTarget {
  title: string
  level: number
  pageLabel: string
  /** analyzed page index of the TOC entry itself */
  tocPageIndex: number
  /** analyzed page index of the matched heading (set by assignHeadingLevels) */
  targetPageIndex?: number
}

/** normalized comparison key: NFKC, case-folded, letters and digits only */
export const matchKey = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')

/** leading section numbering ("1.", "2.3", "IV.", "Chapter 3", Korean "chapter N") */
const NUMBERING_RE =
  /^\s*(?:(?:chapter|section|part)\s+)?(?:[0-9]+(?:\.[0-9]+)*[.):]?|[ivxlc]+[.):]|[a-z][.)])\s+|^\s*제\s*[0-9]+\s*[장절편부]\s*/iu

const titleKeys = (text: string): string[] => {
  const keys = [matchKey(text)]
  const stripped = text.replace(NUMBERING_RE, '')
  if (stripped !== text) keys.push(matchKey(stripped))
  return keys.filter((k) => k.length > 0)
}

const titlesMatch = (a: string, b: string): boolean => {
  const ka = titleKeys(a)
  const kb = titleKeys(b)
  return ka.some((k) => kb.includes(k))
}

export const draftText = (d: TextDraft): string => allLines(d).map(lineText).join(' ')

const setLevel = (d: TextDraft, level: number, source: TextDraft['levelSource']): void => {
  d.role = 'heading'
  d.headingLevel = Math.max(1, Math.min(MAX_LEVEL, level))
  d.levelSource = source
}

const headingEligible = (d: TextDraft): boolean =>
  d.role === 'paragraph' && d.segments.length === 1 && !d.ir.list && !d.ir.tocEntry

function applyBookmarks(
  drafts: TextDraft[],
  bookmarks: RawBookmark[],
  analyzedIndexOf: (sourceIndex: number) => number | undefined,
): void {
  for (const bm of bookmarks) {
    if (bm.title === '' || bm.pageIndex < 0) continue
    const pageIndex = analyzedIndexOf(bm.pageIndex)
    if (pageIndex === undefined) continue
    const hit = drafts.find(
      (d) =>
        d.pageIndex === pageIndex &&
        headingEligible(d) &&
        d.levelSource === undefined &&
        allLines(d).length <= HEADING_MAX_LINES &&
        titlesMatch(draftText(d), bm.title),
    )
    if (hit) setLevel(hit, bm.level, 'bookmark')
  }
}

const pageNumberOfLabel = (label: string): number | undefined =>
  /^[0-9]+$/.test(label) ? Number(label) : undefined

function applyToc(
  drafts: TextDraft[],
  entries: TocTarget[],
  pageNumberOf: (pageIndex: number) => number,
): void {
  const candidatesOf = (e: TocTarget): TextDraft[] =>
    drafts.filter(
      (d) =>
        headingEligible(d) &&
        d.pageIndex > e.tocPageIndex &&
        allLines(d).length <= HEADING_MAX_LINES &&
        titlesMatch(draftText(d), e.title),
    )
  // printed labels are offset from PDF page numbers by front matter; learn
  // the offset from entries with exactly one candidate
  const offsets: number[] = []
  for (const e of entries) {
    const label = pageNumberOfLabel(e.pageLabel)
    const c = candidatesOf(e)
    if (label !== undefined && c.length === 1) offsets.push(pageNumberOf(c[0]!.pageIndex) - label)
  }
  offsets.sort((a, b) => a - b)
  const offset = offsets.length > 0 ? offsets[Math.floor(offsets.length / 2)]! : 0
  for (const e of entries) {
    const label = pageNumberOfLabel(e.pageLabel)
    const candidates = candidatesOf(e)
    const pool = candidates.filter((d) => d.levelSource === undefined)
    if (pool.length === 0) {
      // already a bookmark heading: the entry still points at it
      const owned = candidates.find((d) => d.levelSource === 'bookmark')
      if (owned) e.targetPageIndex = owned.pageIndex
      continue
    }
    const expected = label !== undefined ? label + offset : undefined
    const pick =
      expected === undefined
        ? pool[0]!
        : pool.reduce((best, d) =>
            Math.abs(pageNumberOf(d.pageIndex) - expected) <
            Math.abs(pageNumberOf(best.pageIndex) - expected)
              ? d
              : best,
          )
    setLevel(pick, e.level, 'toc')
    e.targetPageIndex = pick.pageIndex
  }
}

const tierKey = (size: number, bold: boolean): string => `${size}|${bold ? 'b' : 'r'}`

function applyFontStats(drafts: TextDraft[]): void {
  // body size: the char-weighted mode over every paragraph-like draft
  const bySize = new Map<number, number>()
  let bodyBoldChars = 0
  let bodyChars = 0
  const styles = new Map<TextDraft, ReturnType<typeof textStyle>>()
  for (const d of drafts) {
    const st = textStyle(allLines(d))
    styles.set(d, st)
    if (d.role === 'caption') continue
    bySize.set(st.size, (bySize.get(st.size) ?? 0) + st.chars)
  }
  let body = 0
  let best = -1
  for (const [s, n] of bySize) {
    if (n > best) {
      body = s
      best = n
    }
  }
  if (body <= 0) return
  for (const d of drafts) {
    const st = styles.get(d)!
    if (st.size === body) {
      bodyChars += st.chars
      if (st.bold) bodyBoldChars += st.chars
    }
  }
  const bodyIsBold = bodyChars > 0 && bodyBoldChars / bodyChars > 0.5

  const candidates: TextDraft[] = []
  for (const d of drafts) {
    if (!headingEligible(d) || d.levelSource !== undefined) continue
    const lines = allLines(d)
    const text = draftText(d).trim()
    if (lines.length > HEADING_MAX_LINES || text.length > HEADING_MAX_CHARS) continue
    if (!/\p{L}/u.test(text)) continue
    const st = styles.get(d)!
    const larger = st.size >= body * HEADING_SIZE_RATIO
    const bolder =
      !bodyIsBold &&
      st.bold &&
      st.size >= body * 0.98 &&
      lines.length === 1 &&
      text.length <= BOLD_HEADING_MAX_CHARS &&
      !/[.,;:!?。，；：]$/.test(text)
    if (larger || bolder) candidates.push(d)
  }
  if (candidates.length === 0) return

  // tiers by size (desc), bold above regular at equal size
  const tiers = new Map<string, { size: number; bold: boolean }>()
  for (const d of candidates) {
    const st = styles.get(d)!
    tiers.set(tierKey(st.size, st.bold), { size: st.size, bold: st.bold })
  }
  // levels bookmark/TOC headings already established per tier
  const known = new Map<string, Map<number, number>>()
  for (const d of drafts) {
    if (d.levelSource !== 'bookmark' && d.levelSource !== 'toc') continue
    const st = styles.get(d)!
    const key = tierKey(st.size, st.bold)
    const votes = known.get(key) ?? new Map<number, number>()
    votes.set(d.headingLevel!, (votes.get(d.headingLevel!) ?? 0) + 1)
    known.set(key, votes)
  }
  const ordered = [...tiers.entries()].sort(
    ([, a], [, b]) => b.size - a.size || Number(b.bold) - Number(a.bold),
  )
  const levelOf = new Map<string, number>()
  let prev = 0
  for (const [key] of ordered) {
    const votes = known.get(key)
    let level: number
    if (votes) {
      level = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0]
    } else {
      level = prev + 1
    }
    level = Math.min(MAX_LEVEL, level)
    levelOf.set(key, level)
    prev = level
  }
  for (const d of candidates) {
    const st = styles.get(d)!
    setLevel(d, levelOf.get(tierKey(st.size, st.bold))!, 'font')
  }
}

export function assignHeadingLevels(
  drafts: TextDraft[],
  input: {
    bookmarks: RawBookmark[]
    tocEntries: TocTarget[]
    analyzedIndexOf: (sourceIndex: number) => number | undefined
    pageNumberOf: (pageIndex: number) => number
  },
): void {
  applyBookmarks(drafts, input.bookmarks, input.analyzedIndexOf)
  applyToc(drafts, input.tocEntries, input.pageNumberOf)
  applyFontStats(drafts)
}
