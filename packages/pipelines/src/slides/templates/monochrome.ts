/**
 * Monochrome: black ink on ivory paper and nothing else, like a typeset
 * research ledger. Re-authored for the page-spec builder from the upstream
 * design notes. The ultra-light display weight has no bundled match, so the
 * literary serif the upstream keeps for quotes leads the titles instead; the
 * monospace labels become tracked capitals in the body face. The entrance
 * motion and the tonal pyramid fill are left out, and no hue is added.
 */
import type { PageSpec } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const PAPER = '#FAFADF'
const PAPER_ALT = '#F2F2D2'
const PAPER_WARM = '#F5F0E4'
const INK = '#1A1A16'
const GRAPHITE = '#5E5E54'
const GRAPHITE_LIGHT = '#8A8A80'

const TITLE_KO = 'Gowun Batang'
const TITLE_LATIN = 'Playfair Display'
const BODY = 'Pretendard'

const STYLE_SHEET = `Backgrounds: every page ${PAPER}, never white or dark. cover: ${PAPER}. content: ${PAPER}. data: ${PAPER}; insight and timeline pages ${PAPER_WARM}. closing: ${PAPER}.
Colors: headlines and main text ${INK}; lead paragraphs ${GRAPHITE}; labels and source notes ${GRAPHITE_LIGHT}; primary accent ${INK} (accent means darker ink; there is no hue); secondary accent ${GRAPHITE_LIGHT} (default bars, second series); card background ${PAPER_ALT}; border ${INK}, 1px hairlines only. No other color.
Fonts: Korean title ${TITLE_KO}; Latin title, quotes and figures ${TITLE_LATIN}, mixed case, never bold; body and labels ${BODY}, labels in tracked capitals. Big titles 40-48pt; headlines 32-36pt; lead 18-22pt; body 12-15pt; labels 10-12pt; hero numbers 54-72pt.
Layout library:
- cover: cover_typography_hero (46pt title, a 36px rule, one lead line, three ledger cells along the foot), cover_magazine (kicker row over a hairline, title in the left two thirds, one large figure at right)
- content: two_column_comparison (columns split by a 1px vertical rule), three_column_cards (${PAPER_ALT} cards, 16px corners, serif titles), timeline_horizontal (a 1px rule with 8px ${INK} dots), hero_big_number (a 72pt figure, a lead line, a source note)
- data: kpi_cards_row (three ledger cells), chart_with_insight (${GRAPHITE_LIGHT} bars, the one that matters in ${INK}, 1px axes)
- closing: closing_thank_you (one centered serif line over a 36px rule), closing_cta (quiet title, contact lines as labels between hairlines)
Signature devices:
- Chrome rows: content and data pages carry a kicker row at top and a foot row at bottom, two ${GRAPHITE_LIGHT} labels each, set off by a full-width 1px ${INK} rule.
- Short rule: a 36x1px ${INK} rect as punctuation under a kicker or title.
- Ledger cell: a 1px ${INK} rule on top, a large ${TITLE_LATIN} figure, a ${BODY} label, a small ${GRAPHITE_LIGHT} source note.
- Pull quote: ${TITLE_LATIN} italic in English, ${TITLE_KO} in Korean, alone with wide margins.
- Bullets: an em dash in ${GRAPHITE_LIGHT}; never dots, checks or numbers.
- Square corners except 16px on cards; circles only as timeline dots and donuts. No arrows between steps; space shows the order.
- Keep the outer 100px empty. Emphasis comes from size, space and a rule, never from bold or color.
Overall style: A quiet research ledger in black ink on ivory paper, where hairline rules, light serif titles and wide margins do all the work.`

interface CoverCopy {
  titleFont: string
  kicker: string
  date: string
  title: [string, string]
  lead: string
  /** Three ledger cells along the foot: a figure and what it counts. */
  cells: [Cell, Cell, Cell]
}

interface Cell {
  value: string
  label: string
}

/** A kicker row over a hairline, a two-line serif title, a short rule, a lead line and three ledger cells. */
function cover(copy: CoverCopy): PageSpec {
  const label = (text: string, align?: 'right') => ({
    ...(align ? { align } : {}),
    runs: [{ text, sizePt: 11, color: GRAPHITE_LIGHT, font: BODY }],
  })
  const cell = (x: number, { value, label: name }: Cell): PageSpec['elements'] => [
    { type: 'shape', shape: 'rect', x, y: 548, w: 300, h: 1, fill: INK },
    {
      type: 'text',
      x,
      y: 562,
      w: 300,
      h: 68,
      paragraphs: [{ runs: [{ text: value, sizePt: 36, color: INK, font: TITLE_LATIN }] }],
    },
    { type: 'text', x, y: 636, w: 300, h: 24, paragraphs: [label(name)] },
  ]
  return {
    background: PAPER,
    elements: [
      { type: 'text', x: 100, y: 56, w: 560, h: 24, paragraphs: [label(copy.kicker)] },
      { type: 'text', x: 680, y: 56, w: 500, h: 24, paragraphs: [label(copy.date, 'right')] },
      { type: 'shape', shape: 'rect', x: 100, y: 92, w: 1080, h: 1, fill: INK },
      {
        type: 'text',
        x: 100,
        y: 172,
        w: 980,
        h: 190,
        paragraphs: copy.title.map((text) => ({
          runs: [{ text, sizePt: 46, color: INK, font: copy.titleFont }],
        })),
      },
      { type: 'shape', shape: 'rect', x: 100, y: 388, w: 36, h: 1, fill: INK },
      {
        type: 'text',
        x: 100,
        y: 412,
        w: 820,
        h: 80,
        paragraphs: [{ runs: [{ text: copy.lead, sizePt: 20, color: GRAPHITE, font: BODY }] }],
      },
      ...cell(100, copy.cells[0]),
      ...cell(490, copy.cells[1]),
      ...cell(880, copy.cells[2]),
    ],
  }
}

export const monochrome: SlideTemplate = {
  id: 'monochrome',
  name: 'Monochrome',
  scheme: 'light',
  description:
    'Black ink on ivory paper with no color at all, hairline rules, serif titles and wide margins.',
  fonts: { title: TITLE_KO, body: BODY, latinTitle: TITLE_LATIN },
  palette: [PAPER, PAPER_ALT, PAPER_WARM, INK, GRAPHITE, GRAPHITE_LIGHT],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      titleFont: TITLE_KO,
      kicker: '현장 연구 보고서 — 제3호',
      date: '2026년 10월',
      title: ['조용한 사용자들이', '남긴 기록'],
      lead: '열두 가구의 일상을 일 년 동안 지켜보며 찾은 다섯 가지 습관',
      cells: [
        { value: '12', label: '관찰한 가구' },
        { value: '340', label: '모은 생활 일지' },
        { value: '5', label: '찾아낸 습관' },
      ],
    }),
    en: cover({
      titleFont: TITLE_LATIN,
      kicker: 'FIELD RESEARCH REPORT — NO. 3',
      date: 'OCTOBER 2026',
      title: ['What the quiet users', 'left behind'],
      lead: 'Five habits found in a year of watching twelve households live',
      cells: [
        { value: '12', label: 'HOUSEHOLDS OBSERVED' },
        { value: '340', label: 'DIARY ENTRIES COLLECTED' },
        { value: '5', label: 'HABITS FOUND' },
      ],
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/monochrome',
  },
}
