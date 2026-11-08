/**
 * Raw Grid: a neobrutalist grid of 3px black rules, pastel pink and sage cells
 * and heavy capitals. Re-authored for the page-spec builder from the upstream
 * design notes: the hard offset depth becomes a solid black block drawn behind a
 * card, and the faint wallpaper numerals become solid white numerals on a
 * pastel cell, since the builder writes run colors without alpha. The system
 * font stack upstream is replaced by bundled fonts of the same weight.
 */
import type { PageSpec } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const BLACK = '#0A0A0A'
const WHITE = '#FFFFFF'
const PINK = '#F2D4CF'
const GREEN = '#E5EDD6'
const GRAY = '#F5F5F5'
const DARK_GRAY = '#333333'

const TITLE_KO = 'Do Hyeon'
const TITLE_LATIN = 'Archivo Black'
const BODY = 'Pretendard'

/** A 3px rule in points, the stroke every bordered cell carries. */
const RULE_PT = 2.25

const STYLE_SHEET = `Backgrounds: main ${WHITE}. cover: ${WHITE} cut by 3px ${BLACK} rules into cells, one ${PINK}, one ${GREEN}. content: ${WHITE}. data: ${WHITE}. closing: a ${BLACK} band over ${GREEN}.
Colors: main text ${BLACK}; quiet text ${DARK_GRAY}; text on ${BLACK} is ${WHITE}; primary accent ${PINK} (warm cell); secondary accent ${GREEN} (cool cell); card background ${WHITE}, quiet cells ${GRAY}; border ${BLACK}, always. Pink and green are fills only, never text, and sit side by side. Titles are ${BLACK}, or ${WHITE} on ${BLACK}.
Fonts: Korean title ${TITLE_KO}; Latin title and every numeral ${TITLE_LATIN}, capitals only; body and labels ${BODY}. Big titles 40-48pt; subtitles 18-22pt; body 13-15pt in sentence case; labels 12pt bold capitals; hero numbers 64-80pt.
Layout library:
- cover: cover_split_color (a white title cell beside a pink cell over a green cell), cover_typography_hero (label pill, 48pt title, a row of fact cells)
- content: three_column_cards (three cells sharing rules), two_column_comparison (a pink half, a green half), hero_big_number (an 80pt figure in a card with an offset block), timeline_horizontal (step cells joined by 32px black squares with a white arrow)
- data: kpi_cards_row (stat tiles edge to edge, one of them ${BLACK}), chart_with_insight (bar tracks: bordered 36px white rects filled pink or black to the value, value inside the fill)
- closing: closing_cta (black band, a white 48pt title, an arrow-led contact line), closing_thank_you (green field, one card with an offset block)
Signature devices:
- Rules as grid: cells meet edge to edge at 3px ${BLACK} lines, no gaps; padding lives inside cells.
- Offset block: a solid ${BLACK} rect the size of a card, drawn first, 6px right and 6px down (4px for small items), so a hard black edge shows past the card's right and bottom.
- Label pill: a ${BLACK} rect holding 12pt bold white capitals, often led by an arrow; the section tag.
- Rule stub: a 60x4px ${BLACK} rect under a headline.
- Icon box: a 48px ${WHITE} square with a 3px ${BLACK} border holding 1-3 ${TITLE_LATIN} characters.
- Wallpaper numeral: a 64-80pt ${TITLE_LATIN} ordinal in solid ${WHITE} in an empty corner of a pink or green cell, never under other text.
- Square corners; no italics; emphasis is weight alone.
Overall style: A raw zine grid of hard black rules, pastel pink and sage cells and heavy capitals, loud in its structure and quiet inside each cell.`

interface CoverCopy {
  titleFont: string
  tag: string
  title: [string, string]
  subtitle: string
  /** The two fact cells under the title: who presents, then when. */
  facts: [
    { label: string; value: string; font: string },
    { label: string; value: string; font: string },
  ]
  stat: { value: string; label: string }
  chartLabel: string
}

/** One year of the cover chart: a bordered white track with a fill as long as the value. */
interface Bar {
  value: string
  w: number
  fill: string
  text: string
}

const BARS: [Bar, Bar, Bar] = [
  { value: '1,200', w: 120, fill: PINK, text: BLACK },
  { value: '2,500', w: 250, fill: PINK, text: BLACK },
  { value: '4,000', w: 400, fill: BLACK, text: WHITE },
]

/** A white title cell on the left, a pink cell with a stat card over a green cell with a bar chart on the right. */
function cover(copy: CoverCopy): PageSpec {
  const label = (
    text: string,
    box: { x: number; y: number; w: number; h: number },
  ): PageSpec['elements'][number] => ({
    type: 'text',
    ...box,
    paragraphs: [{ runs: [{ text, sizePt: 12, bold: true, color: BLACK, font: BODY }] }],
  })
  const fact = (x: number, f: CoverCopy['facts'][number]): PageSpec['elements'][number] => ({
    type: 'text',
    x,
    y: 612,
    w: 300,
    h: 84,
    paragraphs: [
      { runs: [{ text: f.label, sizePt: 12, bold: true, color: DARK_GRAY, font: BODY }] },
      { runs: [{ text: f.value, sizePt: 20, color: BLACK, font: f.font }] },
    ],
  })
  const bar = (y: number, b: Bar): PageSpec['elements'] => [
    {
      type: 'shape',
      shape: 'rect',
      x: 840,
      y,
      w: 400,
      h: 40,
      fill: WHITE,
      stroke: { color: BLACK, widthPt: RULE_PT },
    },
    {
      type: 'shape',
      shape: 'rect',
      x: 840,
      y,
      w: b.w,
      h: 40,
      fill: b.fill,
      stroke: { color: BLACK, widthPt: RULE_PT },
      valign: 'middle',
      paragraphs: [
        { runs: [{ text: b.value, sizePt: 12, bold: true, color: b.text, font: BODY }] },
      ],
    },
  ]
  return {
    background: WHITE,
    elements: [
      { type: 'shape', shape: 'rect', x: 800, y: 0, w: 480, h: 400, fill: PINK },
      { type: 'shape', shape: 'rect', x: 800, y: 400, w: 480, h: 320, fill: GREEN },
      { type: 'shape', shape: 'rect', x: 0, y: 96, w: 800, h: 3, fill: BLACK },
      { type: 'shape', shape: 'rect', x: 0, y: 584, w: 800, h: 3, fill: BLACK },
      { type: 'shape', shape: 'rect', x: 400, y: 584, w: 3, h: 136, fill: BLACK },
      { type: 'shape', shape: 'rect', x: 797, y: 0, w: 3, h: 720, fill: BLACK },
      { type: 'shape', shape: 'rect', x: 800, y: 398, w: 480, h: 3, fill: BLACK },
      {
        type: 'shape',
        shape: 'rect',
        x: 64,
        y: 30,
        w: 320,
        h: 38,
        fill: BLACK,
        valign: 'middle',
        paragraphs: [
          { runs: [{ text: copy.tag, sizePt: 12, bold: true, color: WHITE, font: BODY }] },
        ],
      },
      {
        type: 'text',
        x: 64,
        y: 132,
        w: 700,
        h: 204,
        paragraphs: copy.title.map((text) => ({
          runs: [{ text, sizePt: 48, color: BLACK, font: copy.titleFont }],
        })),
      },
      { type: 'shape', shape: 'rect', x: 64, y: 360, w: 60, h: 4, fill: BLACK },
      {
        type: 'text',
        x: 64,
        y: 388,
        w: 680,
        h: 92,
        paragraphs: [{ runs: [{ text: copy.subtitle, sizePt: 20, color: BLACK, font: BODY }] }],
      },
      fact(64, copy.facts[0]),
      fact(440, copy.facts[1]),
      { type: 'shape', shape: 'rect', x: 870, y: 70, w: 344, h: 260, fill: BLACK },
      {
        type: 'shape',
        shape: 'rect',
        x: 864,
        y: 64,
        w: 344,
        h: 260,
        fill: WHITE,
        stroke: { color: BLACK, widthPt: RULE_PT },
      },
      {
        type: 'text',
        x: 896,
        y: 84,
        w: 288,
        h: 136,
        paragraphs: [
          { runs: [{ text: copy.stat.value, sizePt: 72, color: BLACK, font: TITLE_LATIN }] },
        ],
      },
      label(copy.stat.label, { x: 896, y: 236, w: 288, h: 64 }),
      label(copy.chartLabel, { x: 840, y: 432, w: 400, h: 28 }),
      ...bar(480, BARS[0]),
      ...bar(548, BARS[1]),
      ...bar(616, BARS[2]),
    ],
  }
}

export const rawGrid: SlideTemplate = {
  id: 'raw-grid',
  name: 'Raw Grid',
  scheme: 'light',
  description:
    'A neobrutalist grid of thick black rules, pastel pink and sage cells and heavy capitals.',
  fonts: { title: TITLE_KO, body: BODY, latinTitle: TITLE_LATIN },
  palette: [BLACK, WHITE, PINK, GREEN, GRAY, DARK_GRAY],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      titleFont: TITLE_KO,
      tag: '→ 시드 투자 설명회',
      title: ['작게 시작해서', '크게 증명하기'],
      subtitle: '주말에 만든 도구가 유료 고객 4,000팀의 업무 소프트웨어가 되기까지',
      facts: [
        { label: '발표', value: '창업팀', font: TITLE_KO },
        { label: '일시', value: '2027.03', font: TITLE_LATIN },
      ],
      stat: { value: '92%', label: '12개월 뒤에도 결제를 이어 가는 팀' },
      chartLabel: '유료 고객 팀 수 · 2024 / 2025 / 2026',
    }),
    en: cover({
      titleFont: TITLE_LATIN,
      tag: '→ SEED ROUND · DEMO DAY',
      title: ['START SMALL,', 'PROVE IT BIG'],
      subtitle: 'How three founders turned a weekend tool into software for 4,000 paying teams',
      facts: [
        { label: 'PRESENTED BY', value: 'FOUNDING TEAM', font: TITLE_LATIN },
        { label: 'DATE', value: 'MARCH 2027', font: TITLE_LATIN },
      ],
      stat: { value: '92%', label: 'OF TEAMS STILL PAYING AFTER 12 MONTHS' },
      chartLabel: 'PAYING TEAMS · 2024 / 2025 / 2026',
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/raw-grid',
  },
}
