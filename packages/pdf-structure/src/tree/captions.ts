/**
 * Caption binding: a short paragraph directly above or below an image or a
 * table that opens with a caption word and a number ("Figure 3.", or the
 * Korean, Chinese and Japanese equivalents) belongs to that object and
 * leaves the body flow.
 */
import { lineText } from './inline'
import {
  allLines,
  textStyle,
  type Draft,
  type ImageDraft,
  type TableDraft,
  type TextDraft,
} from './draft'

/** caption words; Latin ones need a separator before the number */
const CAPTION_RE = new RegExp(
  '^\\s*(?:' +
    [
      '(?:Figure|Fig\\.?|Table|Tab\\.|Chart|Plate|Exhibit|Illustration|Abbildung|Abb\\.|Tabelle|Tableau|Tabla|Figura|Tabela|Рисунок|Рис\\.|Таблица)\\s*',
      '(?:그림|표|도표|사진|圖|图|表|図|插图|附图)\\s*',
    ].join('|') +
    ')' +
    // number: arabic (3, 2.1, 3-4), roman (IV), or CJK numerals
    '(?:[0-9０-９]+(?:[.\\-–][0-9]+)*|[IVXLC]+\\b|[一二三四五六七八九十百]+)' +
    '(?=$|[\\s.:：、。)）\\-–—])',
  'u',
)

/** captions are short: at most this many lines and characters */
const CAPTION_MAX_LINES = 3
const CAPTION_MAX_CHARS = 300
/** vertical gap to the object, in caption font sizes (with a floor in points) */
const CAPTION_GAP_EMS = 3
const CAPTION_GAP_MIN_PT = 24

export const isCaptionText = (text: string): boolean => CAPTION_RE.test(text.trim())

function isCaptionCandidate(d: Draft): d is TextDraft {
  if (d.kind !== 'text' || d.role !== 'paragraph' || d.segments.length !== 1) return false
  if (d.ir.list || d.ir.tocEntry) return false
  const lines = allLines(d)
  if (lines.length === 0 || lines.length > CAPTION_MAX_LINES) return false
  const text = lines.map(lineText).join(' ')
  return text.length <= CAPTION_MAX_CHARS && isCaptionText(text)
}

/**
 * Bind captions on one page's drafts (reading order). Bound caption drafts
 * get role 'caption' and are removed from the returned list.
 */
export function bindCaptions(drafts: Draft[]): Draft[] {
  const taken = new Set<TextDraft>()
  const candidates = drafts.filter(isCaptionCandidate)
  for (const host of drafts) {
    if (host.kind !== 'image' && host.kind !== 'table') continue
    const order: Array<'above' | 'below'> =
      host.kind === 'table' ? ['above', 'below'] : ['below', 'above']
    let best: { draft: TextDraft; position: 'above' | 'below'; gap: number } | null = null
    for (const position of order) {
      for (const c of candidates) {
        if (taken.has(c)) continue
        const cap = c.ir.box
        const obj = host.ir.box
        if (Math.min(cap.x1, obj.x1) - Math.max(cap.x0, obj.x0) <= 0) continue
        const gap = position === 'below' ? obj.y0 - cap.y1 : cap.y0 - obj.y1
        const limit = Math.max(CAPTION_GAP_MIN_PT, CAPTION_GAP_EMS * textStyle(allLines(c)).size)
        if (gap < -2 || gap > limit) continue
        if (!best || gap < best.gap) best = { draft: c, position, gap }
      }
      if (best) break
    }
    if (best) {
      taken.add(best.draft)
      best.draft.role = 'caption'
      ;(host as ImageDraft | TableDraft).caption = { draft: best.draft, position: best.position }
    }
  }
  return drafts.filter((d) => d.kind !== 'text' || !taken.has(d))
}
