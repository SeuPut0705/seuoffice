/**
 * Neo-Grid Bold: paper, ink and electric lemon panels on a strict 12 x 8 grid,
 * set in heavy capitals. Re-authored for the page-spec builder from the
 * upstream design notes. The grid is scaled to the 1280x720 page (26px frame,
 * 8px gaps); the poster-sized numerals are capped at the generator's 80pt; the
 * grain-filled photo stand-ins and the checkered tile are left out. The
 * monospace labels become bold capitals in the body face.
 */
import type { PageSpec } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const PUTTY = '#ECECE8'
const PAPER = '#F5F4EF'
const INK = '#0A0A0A'
const LEMON = '#E6FF3D'
const MUTED = '#8A8A85'

const TITLE_KO = 'Black Han Sans'
const TITLE_LATIN = 'Space Grotesk'
const BODY = 'Pretendard'

const STYLE_SHEET = `Backgrounds: cover: ${PUTTY} with ${PAPER}, ${INK} and ${LEMON} panels. content: ${PUTTY}. data: ${PUTTY}. closing: ${PUTTY} with one large ${INK} panel. The ${PUTTY} shows only as frame and gaps.
Colors: main text ${INK} on ${PAPER} or ${LEMON}, ${PAPER} on ${INK}; labels on ${INK} are ${MUTED}; primary accent ${LEMON} (signal panels, swatches, second series), never text on a light panel; secondary accent ${INK} (inverted panels, first series); card background ${PAPER}; border ${INK} 1.5pt, on tables and tags only.
Fonts: Korean title ${TITLE_KO}; Latin title and numerals ${TITLE_LATIN} bold capitals; body ${BODY}; labels ${BODY} bold capitals. Big titles 40-48pt; panel headlines 24-32pt; subtitles 18-22pt; body 12-15pt; labels 11-13pt; hero numbers 64-80pt.
Layout library:
- cover: cover_split_color (${PAPER} title panel beside ${LEMON} and ${INK} panels), cover_typography_hero (${INK} title panel eight columns wide, ${LEMON} numeral panel)
- content: three_column_cards (panels in ${PAPER}, ${INK}, ${PAPER}), two_column_comparison (${PAPER} against ${INK}), hero_big_number (80pt figure filling a ${LEMON} panel), timeline_horizontal (numbered panels joined by ${INK} rightArrow shapes)
- data: kpi_cards_row (four panels, one ${LEMON}), chart_with_insight (${INK} and ${LEMON} bar pairs on 2pt axes, insight in an ${INK} panel)
- closing: closing_cta (${INK} panel with a ${PAPER} title, contact in a ${LEMON} panel), closing_thank_you (${LEMON} panel, ${INK} title, a block stamp)
Signature devices:
- Grid: 12 columns x 8 rows inside a 26px frame, 8px gaps (columns 95px, rows 77px). Panels span whole cells; four to eight panels per page.
- Panel: a square rect in ${PAPER}, ${INK} or ${LEMON}; depth comes only from colors meeting at the gaps. One to three ${LEMON} panels per page.
- Highlight swatch: a ${LEMON} rect behind one headline line, ${INK} text on it, 8px past each end.
- Lemon word: on an ${INK} panel one word or figure may turn ${LEMON}.
- Block stamp: a 2x2 square with top-left and bottom-right cells filled in ${INK} or ${LEMON}, 36-48px, in a panel corner.
- Page tag: a small rect at bottom left with "01 / 12" in ${TITLE_LATIN}.
- No rounded corners, no circles except donut charts, no italic.
Overall style: A dense editorial poster of putty, ink and electric lemon panels on a strict grid, set in heavy capitals.`

/** Grid geometry on the 1280x720 page: column/row start and the size of a span. */
const colX = (c: number): number => 26 + 103 * c
const rowY = (r: number): number => 24 + 85 * r
const spanW = (n: number): number => 103 * n - 8
const spanH = (n: number): number => 85 * n - 8

interface CoverCopy {
  titleFont: string
  eyebrow: string
  /** The first line in ink, the second on the lemon swatch. */
  title: [string, string]
  /** Width of the lemon swatch behind the second title line. */
  swatchW: number
  edition: { label: string; value: string }
  facts: [{ label: string; value: string }, { label: string; value: string }]
  stat: { value: string; label: string }
  summary: string
}

function panel(c: number, r: number, cols: number, rows: number, fill: string) {
  return {
    type: 'shape' as const,
    shape: 'rect',
    x: colX(c),
    y: rowY(r),
    w: spanW(cols),
    h: spanH(rows),
    fill,
  }
}

/** Two diagonal squares of a block stamp, top-left corner at (x, y). */
function stamp(x: number, y: number, cell: number, fill: string): PageSpec['elements'] {
  return [
    { type: 'shape', shape: 'rect', x, y, w: cell, h: cell, fill },
    { type: 'shape', shape: 'rect', x: x + cell, y: y + cell, w: cell, h: cell, fill },
  ]
}

function line(
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  sizePt: number,
  color: string,
  font: string,
  bold = false,
): PageSpec['elements'][number] {
  return {
    type: 'text',
    x,
    y,
    w,
    h,
    paragraphs: [{ runs: [{ text, sizePt, color, font, ...(bold ? { bold: true } : {}) }] }],
  }
}

/** A paper title panel with a lemon swatch, a lemon edition panel, two ink panels and a paper summary panel. */
function cover(copy: CoverCopy): PageSpec {
  const titleX = colX(0) + 32
  const factX = colX(9) + 28
  return {
    background: PUTTY,
    elements: [
      panel(0, 0, 9, 5, PAPER),
      panel(9, 0, 3, 3, LEMON),
      panel(9, 3, 3, 5, INK),
      panel(0, 5, 4, 3, INK),
      panel(4, 5, 5, 3, PAPER),
      ...stamp(colX(9) - 8 - 32 - 36, rowY(0) + 28, 18, INK),
      { type: 'shape', shape: 'rect', x: titleX - 8, y: 246, w: copy.swatchW, h: 84, fill: LEMON },
      line(titleX, 56, 640, 26, copy.eyebrow, 13, INK, BODY, true),
      line(titleX, 150, 840, 88, copy.title[0], 48, INK, copy.titleFont),
      line(titleX, 252, 840, 88, copy.title[1], 48, INK, copy.titleFont),
      line(factX, rowY(0) + 28, 240, 24, copy.edition.label, 12, INK, BODY, true),
      line(factX, rowY(0) + 64, 240, 140, copy.edition.value, 80, INK, TITLE_LATIN, true),
      line(factX, rowY(3) + 32, 240, 24, copy.facts[0].label, 12, MUTED, BODY, true),
      line(factX, rowY(3) + 60, 240, 44, copy.facts[0].value, 24, PAPER, TITLE_LATIN, true),
      line(factX, rowY(3) + 124, 240, 24, copy.facts[1].label, 12, MUTED, BODY, true),
      line(factX, rowY(3) + 152, 240, 44, copy.facts[1].value, 24, PAPER, copy.titleFont, true),
      ...stamp(colX(12) - 8 - 28 - 48, rowY(8) - 8 - 28 - 48, 24, LEMON),
      line(colX(0) + 32, rowY(5) + 28, 330, 124, copy.stat.value, 72, LEMON, TITLE_LATIN, true),
      line(colX(0) + 32, rowY(5) + 160, 330, 52, copy.stat.label, 14, PAPER, BODY, true),
      line(colX(4) + 32, rowY(5) + 28, 440, 120, copy.summary, 18, INK, BODY),
      {
        type: 'shape',
        shape: 'rect',
        x: colX(4) + 32,
        y: rowY(8) - 8 - 28 - 32,
        w: 104,
        h: 32,
        fill: INK,
        valign: 'middle',
        paragraphs: [
          {
            align: 'center',
            runs: [{ text: '01 / 12', sizePt: 12, bold: true, color: PAPER, font: TITLE_LATIN }],
          },
        ],
      },
    ],
  }
}

export const neoGridBold: SlideTemplate = {
  id: 'neo-grid-bold',
  name: 'Neo-Grid Bold',
  scheme: 'light',
  description:
    'An editorial poster grid of paper, ink and neon lemon panels set in heavy capitals.',
  fonts: { title: TITLE_KO, body: BODY, latinTitle: TITLE_LATIN },
  palette: [PUTTY, PAPER, INK, LEMON, MUTED],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      titleFont: TITLE_KO,
      eyebrow: '디자인 리더십 포럼 2026',
      title: ['크게 설계하고', '선명하게 출시하라'],
      swatchW: 580,
      edition: { label: '제3회', value: '03' },
      facts: [
        { label: '일시', value: '2026.11.20' },
        { label: '장소', value: '서울' },
      ],
      stat: { value: '120+', label: '연사와 참가 팀' },
      summary: '디자인 조직을 이끄는 사람들이 하루 동안 나누는 실전 사례와 도구',
    }),
    en: cover({
      titleFont: TITLE_LATIN,
      eyebrow: 'DESIGN LEADERSHIP FORUM 2026',
      title: ['DESIGN LOUD,', 'SHIP CLEAR'],
      swatchW: 470,
      edition: { label: 'EDITION', value: '03' },
      facts: [
        { label: 'DATE', value: '2026.11.20' },
        { label: 'CITY', value: 'SEOUL' },
      ],
      stat: { value: '120+', label: 'SPEAKERS AND TEAMS' },
      summary:
        'One day of field notes, tools and hard lessons from the people who lead design teams',
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/neo-grid-bold',
  },
}
