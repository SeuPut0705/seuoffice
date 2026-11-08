/**
 * Coral: flat coral, ink and cream planes with condensed poster capitals.
 * Re-authored for the page-spec builder from the upstream design notes; devices
 * the builder cannot draw as solid shapes (the diagonal hatch, the zigzag line)
 * are left out. Text is always a solid color: the builder writes run colors
 * without alpha, so the upstream translucent numeral is set in the darker coral.
 */
import type { PageSpec } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const CORAL = '#E85D5D'
const CORAL_DARK = '#D44A4A'
const CREAM = '#F5F0E8'
const CREAM_DARK = '#E8E0D4'
const INK = '#1A1A1A'
const GRAY = '#6B6B6B'
const WHITE = '#FFFFFF'

const TITLE_KO = 'Black Han Sans'
const TITLE_LATIN = 'Bebas Neue'
const BODY = 'Pretendard'

const STYLE_SHEET = `Backgrounds: main ${CREAM}. cover: a ${CORAL} band across the top third over ${CREAM}, with one ${INK} block. content: ${CREAM}. data: ${CREAM}. closing: ${INK}.
Colors: main text ${INK}; body and small text ${GRAY}; text on ${INK} is ${CREAM}; primary accent ${CORAL}; secondary accent ${CORAL_DARK} (second data series, wallpaper numeral); card background ${WHITE}; border ${CREAM_DARK}. Text on ${CORAL} is ${INK}, never white. Titles are ${INK}, ${CREAM} or ${CORAL}, never ${GRAY}.
Fonts: Korean title ${TITLE_KO}; Latin title and every numeral ${TITLE_LATIN}, capitals only; body and labels ${BODY}. Big titles 40-48pt; subtitles 18-24pt; body 13-15pt; labels 12pt bold; hero numbers 64-80pt.
Layout library:
- cover: cover_split_color (color band above a cream field that holds the title), cover_typography_hero (one surface, a 48pt title, one 80pt figure as anchor)
- content: three_column_cards (white cards on cream), two_column_comparison (a ${CORAL} half against an ${INK} or cream half), hero_big_number (an 80pt figure inside a color region), timeline_horizontal (a 4px ${INK} line with ${CORAL} dots ringed in ${CREAM})
- data: kpi_cards_row (white tiles in a row), chart_with_insight (bars built from rect shapes in ${CORAL}, comparison series ${CORAL_DARK})
- closing: closing_cta (${INK} surface, ${CREAM} title, contact line in ${CORAL}), closing_thank_you (${INK} surface with one ${CORAL} block)
Signature devices:
- Color planes: two or three solid regions of ${CORAL}, ${INK} and ${CREAM} per page, meeting at hard straight edges; that edge is the layout. Fill every region.
- Card: a ${WHITE} rect with a 5px ${CORAL} bar along its top edge as its only trim.
- Tile: a ${WHITE} rect with a 4px ${CORAL} bar along its left edge, holding a ${TITLE_LATIN} value over a ${BODY} label.
- Accent rule: an 80x4px ${CORAL} rect under a headline (60x4px on closing pages).
- Icon square: a 48px ${CORAL} square holding one white ${TITLE_LATIN} character.
- Divider: a full-width 3px ${INK} rect at 15% opacity. Only rect fills take opacity; text is always a solid color.
- Wallpaper numeral: a 64-80pt ${TITLE_LATIN} numeral in solid ${CORAL_DARK} in an empty part of a ${CORAL} region, never under other text.
- Square corners on every rect; circles only as timeline dots.
Overall style: A bold magazine poster of flat coral, ink and cream planes, oversized condensed capitals and a single warm accent.`

interface CoverCopy {
  titleFont: string
  eyebrow: string
  year: string
  title: [string, string]
  subtitle: string
  /** Two facts under the title: a date in numerals, then a name in the title font. */
  tiles: [{ value: string; label: string }, { value: string; label: string }]
}

/** A coral band across the top and an ink panel down the right, around a cream field with the title and two tiles. */
function cover(copy: CoverCopy): PageSpec {
  const tile = (
    x: number,
    { value, label }: { value: string; label: string },
    font: string,
  ): PageSpec['elements'] => [
    { type: 'shape', shape: 'rect', x, y: 584, w: 300, h: 96, fill: WHITE },
    { type: 'shape', shape: 'rect', x, y: 584, w: 4, h: 96, fill: CORAL },
    {
      type: 'text',
      x: x + 24,
      y: 594,
      w: 260,
      h: 46,
      paragraphs: [{ runs: [{ text: value, sizePt: 24, color: INK, font }] }],
    },
    {
      type: 'text',
      x: x + 24,
      y: 646,
      w: 260,
      h: 24,
      paragraphs: [{ runs: [{ text: label, sizePt: 12, bold: true, color: GRAY, font: BODY }] }],
    },
  ]
  return {
    background: CREAM,
    elements: [
      { type: 'shape', shape: 'rect', x: 0, y: 0, w: 1280, h: 232, fill: CORAL },
      { type: 'shape', shape: 'rect', x: 1040, y: 0, w: 240, h: 720, fill: INK },
      {
        type: 'text',
        x: 80,
        y: 44,
        w: 880,
        h: 26,
        paragraphs: [
          { runs: [{ text: copy.eyebrow, sizePt: 14, bold: true, color: INK, font: BODY }] },
        ],
      },
      {
        type: 'text',
        x: 80,
        y: 84,
        w: 880,
        h: 132,
        paragraphs: [{ runs: [{ text: copy.year, sizePt: 80, color: INK, font: TITLE_LATIN }] }],
      },
      {
        type: 'text',
        x: 80,
        y: 264,
        w: 880,
        h: 180,
        paragraphs: copy.title.map((text) => ({
          runs: [{ text, sizePt: 48, color: INK, font: copy.titleFont }],
        })),
      },
      { type: 'shape', shape: 'rect', x: 80, y: 460, w: 80, h: 4, fill: CORAL },
      {
        type: 'text',
        x: 80,
        y: 484,
        w: 880,
        h: 40,
        paragraphs: [{ runs: [{ text: copy.subtitle, sizePt: 20, color: GRAY, font: BODY }] }],
      },
      { type: 'shape', shape: 'rect', x: 80, y: 556, w: 880, h: 3, fill: `${INK}26` },
      ...tile(80, copy.tiles[0], TITLE_LATIN),
      ...tile(404, copy.tiles[1], copy.titleFont),
    ],
  }
}

export const coral: SlideTemplate = {
  id: 'coral',
  name: 'Coral',
  scheme: 'mixed',
  description: 'Flat coral, ink and cream planes with oversized condensed capitals.',
  fonts: { title: TITLE_KO, body: BODY, latinTitle: TITLE_LATIN },
  palette: [CORAL, CORAL_DARK, CREAM, CREAM_DARK, INK, GRAY, WHITE],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      titleFont: TITLE_KO,
      eyebrow: '연간 브랜드 리포트',
      year: '2026',
      title: ['더 뜨겁게,', '더 가까이'],
      subtitle: '작은 스튜디오가 열두 달 만에 단골 독자를 만든 방법',
      tiles: [
        { value: '2026.03', label: '발행' },
        { value: '브랜드팀', label: '작성' },
      ],
    }),
    en: cover({
      titleFont: TITLE_LATIN,
      eyebrow: 'ANNUAL BRAND REPORT',
      year: '2026',
      title: ['TURN UP', 'THE WARMTH'],
      subtitle: 'How a small studio won a loyal audience in twelve months',
      tiles: [
        { value: 'MARCH 2026', label: 'PUBLISHED' },
        { value: 'BRAND TEAM', label: 'PREPARED BY' },
      ],
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/coral',
  },
}
