/**
 * Emerald Editorial: a magazine front page in emerald, navy ink and oat paper,
 * with heavy serif display type, a masthead and the double-rule ornament.
 * Re-authored for the page-spec builder from the upstream design notes. The
 * ornament's stacked rules are drawn as thin solid rects; display sizes are
 * scaled down into the page generator's point ranges, so the upstream jumbo
 * numerals become 80pt figures on an ink panel.
 */
import type { PageSpec } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const EMERALD = '#3CD896'
const EMERALD_DEEP = '#25B377'
const INK = '#0F1A5C'
const PAPER = '#F1E9D6'

const TITLE_KO = 'Noto Serif KR'
const TITLE_LATIN = 'Playfair Display'
const BODY = 'Pretendard'

const STYLE_SHEET = `Backgrounds: main ${EMERALD}. cover: ${EMERALD} with masthead and footline. content: ${EMERALD}. data: ${EMERALD}, charts in ${INK} cards. closing: ${INK}.
Colors: main text ${INK}; text on ${INK} is ${EMERALD}; text on ${PAPER} is ${INK}. Primary accent ${INK}; secondary accent ${PAPER} (alternate tiles, second data series); card background ${INK} or ${PAPER}, alternating; border ${INK}. ${EMERALD_DEEP} only to part two adjacent ${EMERALD} areas. No other hue, no white.
Fonts: Korean title ${TITLE_KO} bold; Latin title and every numeral ${TITLE_LATIN} bold; body ${BODY}; labels 12-14pt bold, Latin in capitals. Big titles 40-48pt; subtitles 18-24pt; body 13-15pt; hero numbers 64-80pt.
Layout library:
- cover: cover_magazine (masthead, a centered title split by the ornament, a row of pills, footline), cover_typography_hero (one centered 48pt title between two full-width 4px rules)
- content: hero_big_number (an 80pt numeral on a full-height ${INK} left panel, headline on the ${EMERALD} right), three_column_cards (tiles in ${INK}, ${PAPER}, ${INK}), timeline_horizontal (steps under 4px top rules, 40pt numerals), two_column_comparison (columns split by a 4px vertical rule)
- data: chart_with_insight (an ${INK} card; rect bars in ${EMERALD}, second series ${PAPER}, 2px ${EMERALD} grid lines at 22% opacity), kpi_cards_row (${INK} and ${PAPER} tiles, 64pt figures, a small delta pill)
- closing: closing_thank_you (${INK} surface, an ${EMERALD} 48pt title with the ornament), closing_cta (masthead, footline, one contact line)
Signature devices:
- Double-rule ornament: a short centered word (24-32pt, title font) with two stacked 4px ${INK} rects 3px apart on each side, same length both sides.
- Masthead and footline: two 12pt bold labels at opposite ends, top and bottom, each set off by a full-width 4px rule.
- Rule: every separator, list row border and tile divider is a 4px ${INK} rect; only chart grid lines are 2px.
- Tile: an ${INK} rect with ${EMERALD} text, or ${PAPER} with ${INK} text.
- Pill: a strict rect, ${INK} with ${EMERALD} text or ${PAPER} with ${INK} text.
- Agenda row: a 40pt numeral, a 24pt name and a 12pt label between 4px rules.
- Square corners on every shape. Only rect fills take opacity; text is always solid.
Overall style: A fashion-magazine front page in emerald, navy ink and oat paper, with heavy serif display type and playbill double rules.`

interface CoverCopy {
  titleFont: string
  masthead: [string, string]
  /** Display line, connector word inside the ornament, display line. */
  title: [string, string, string]
  lede: string
  pills: [string, string, string]
  footline: [string, string]
}

/** Masthead, a centered title whose connector word sits in the double-rule ornament, a row of pills, footline. */
function cover(copy: CoverCopy): PageSpec {
  const label = (x: number, text: string, align: 'left' | 'right', y: number) => ({
    type: 'text' as const,
    x,
    y,
    w: 540,
    h: 26,
    paragraphs: [{ align, runs: [{ text, sizePt: 13, bold: true, color: INK, font: BODY }] }],
  })
  const display = (y: number, text: string) => ({
    type: 'text' as const,
    x: 80,
    y,
    w: 1120,
    h: 84,
    paragraphs: [
      {
        align: 'center' as const,
        runs: [{ text, sizePt: 48, bold: true, color: INK, font: copy.titleFont }],
      },
    ],
  })
  const rule = (x: number, y: number) => ({
    type: 'shape' as const,
    shape: 'rect',
    x,
    y,
    w: 220,
    h: 4,
    fill: INK,
  })
  const pill = (x: number, text: string, fill: string, color: string) => ({
    type: 'shape' as const,
    shape: 'rect',
    x,
    y: 508,
    w: 180,
    h: 40,
    fill,
    paragraphs: [
      { align: 'center' as const, runs: [{ text, sizePt: 13, bold: true, color, font: BODY }] },
    ],
  })
  return {
    background: EMERALD,
    elements: [
      label(80, copy.masthead[0], 'left', 40),
      label(660, copy.masthead[1], 'right', 40),
      { type: 'shape', shape: 'rect', x: 80, y: 78, w: 1120, h: 4, fill: INK },
      display(140, copy.title[0]),
      rule(320, 262),
      rule(320, 269),
      {
        type: 'text',
        x: 560,
        y: 244,
        w: 160,
        h: 52,
        paragraphs: [
          {
            align: 'center',
            runs: [
              { text: copy.title[1], sizePt: 28, bold: true, color: INK, font: copy.titleFont },
            ],
          },
        ],
      },
      rule(740, 262),
      rule(740, 269),
      display(312, copy.title[2]),
      {
        type: 'text',
        x: 160,
        y: 420,
        w: 960,
        h: 56,
        paragraphs: [
          {
            align: 'center',
            runs: [{ text: copy.lede, sizePt: 18, color: INK, font: BODY }],
          },
        ],
      },
      pill(340, copy.pills[0], INK, EMERALD),
      pill(550, copy.pills[1], PAPER, INK),
      pill(760, copy.pills[2], INK, EMERALD),
      { type: 'shape', shape: 'rect', x: 80, y: 632, w: 1120, h: 4, fill: INK },
      label(80, copy.footline[0], 'left', 654),
      label(660, copy.footline[1], 'right', 654),
    ],
  }
}

export const emeraldEditorial: SlideTemplate = {
  id: 'emerald-editorial',
  name: 'Emerald Editorial',
  scheme: 'mixed',
  description:
    'A magazine front page in emerald, navy ink and oat paper, with heavy serif display type and double-rule ornaments.',
  fonts: { title: TITLE_KO, body: BODY, latinTitle: TITLE_LATIN },
  palette: [EMERALD, EMERALD_DEEP, INK, PAPER],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      titleFont: TITLE_KO,
      masthead: ['분기 전략 브리핑', '제3호 · 2026 가을'],
      title: ['속도', '와', '방향'],
      lede: '다섯 개 사업부의 계획을 한 장의 지도로 묶은 내년 전략',
      pills: ['전략', '재무', '조직'],
      footline: ['기획실 발표', '2026년 10월 14일'],
    }),
    en: cover({
      titleFont: TITLE_LATIN,
      masthead: ['QUARTERLY STRATEGY BRIEFING', 'ISSUE 03 · AUTUMN 2026'],
      title: ['Speed', 'and', 'Direction'],
      lede: 'Five business units, one map: the plan for next year',
      pills: ['STRATEGY', 'FINANCE', 'PEOPLE'],
      footline: ['PRESENTED BY THE PLANNING OFFICE', 'OCTOBER 14, 2026'],
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/emerald-editorial',
  },
}
