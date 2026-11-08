/**
 * BlockFrame: framed square cards on candy pastel grounds, each lifted by a
 * solid black block offset behind it. Re-authored for the page-spec builder
 * from the upstream design notes. The hard offset depth becomes a black rect
 * drawn first, 8px down and right; the tilted cards and badges stay straight
 * (a page spec cannot tilt a shape); the diagonal stripe block and the dot
 * pattern are left out, and the ten-point star becomes the star5 shape.
 */
import type { PageSpec } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const BLACK = '#000000'
const WHITE = '#FFFFFF'
const OFFWHITE = '#FFFDF5'
const PINK = '#FE90E8'
const BLUE = '#C0F7FE'
const GREEN = '#99E885'
const YELLOW = '#F7CB46'
const CREAM = '#FFDC8B'

const TITLE_KO = 'Do Hyeon'
const TITLE_LATIN = 'Archivo Black'
const BODY = 'Pretendard'

const STYLE_SHEET = `Backgrounds: cover: ${CREAM}. content: ${OFFWHITE}, ${BLUE} or ${GREEN} for openers. data: ${BLUE}. closing: ${BLACK}. Neighbours never share a ground.
Colors: main text ${BLACK}; text on ${BLACK} is ${WHITE}; primary accent ${YELLOW} (buttons, number squares); secondary accent ${PINK} (label pills, stars, first series); ${BLUE}, ${GREEN}, ${CREAM} for grounds, stat cards, more series; card background ${WHITE}; border ${BLACK}. No sixth pastel.
Fonts: Korean title ${TITLE_KO}; Latin title and numerals ${TITLE_LATIN}, capitals only; body and labels ${BODY}, labels bold capitals. Big titles 40-48pt; headlines 32-40pt; card titles 18-22pt; body 13-15pt; labels 11-13pt; hero numbers 56-80pt.
Layout library:
- cover: cover_split_color (framed ${WHITE} title card at left, two framed pastel stat cards at right), cover_typography_hero (48pt title on a pastel ground, a ${YELLOW} button, one star)
- content: three_column_cards (framed ${WHITE} cards with pastel icon squares), two_column_comparison (two framed cards on different pastels), timeline_horizontal (framed pastel step cards joined by 28x4px ${BLACK} bars), hero_big_number (80pt figure in a framed ${YELLOW} card)
- data: kpi_cards_row (framed stat cards in cycling pastels with a 16px dot), chart_with_insight (framed ${WHITE} chart card, pastel bars outlined in ${BLACK})
- closing: closing_cta (${BLACK} page, a card with a 3pt ${WHITE} outline over a ${YELLOW} offset block), closing_thank_you (${BLACK} page, ${WHITE} title, two pastel stars)
Signature devices:
- Frame: every card is a square rect with a 3pt ${BLACK} outline, 2pt on pills, buttons and small chrome.
- Offset block: a solid ${BLACK} rect the size of the card, drawn first, 8px right and 8px down of it (4px for pills and buttons). On ${BLACK} pages it is ${YELLOW}.
- Label pill: a framed pastel rect with a ${BODY} bold capital label and a 4px offset block, above each region headline.
- Button: a framed ${YELLOW} rect with a 4px offset block and ${TITLE_LATIN} capitals; it may straddle a card's bottom edge.
- Icon square: a 56px framed pastel square with one capital letter.
- Star: a pastel star5 with a 2pt ${BLACK} outline on a card corner; at most two per page.
- Square corners everywhere; the only circle is the 16px stat dot.
Overall style: A loud pop-graphic zine of framed cards on candy pastel grounds, lifted by solid black offset blocks.`

interface CoverCopy {
  titleFont: string
  label: string
  title: [string, string]
  subtitle: string
  button: string
  stats: [Stat, Stat]
}

interface Stat {
  value: string
  label: string
}

const FRAME = { color: BLACK, widthPt: 3 }
const FRAME_SMALL = { color: BLACK, widthPt: 2 }

/** A black block offset behind a card, then the framed card itself. */
function lifted(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  offset: number,
  frame: { color: string; widthPt: number },
): PageSpec['elements'] {
  return [
    { type: 'shape', shape: 'rect', x: x + offset, y: y + offset, w, h, fill: BLACK },
    { type: 'shape', shape: 'rect', x, y, w, h, fill, stroke: frame },
  ]
}

/** A small framed rect with a centered label, lifted by a 4px block. */
function chip(
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  text: string,
  sizePt: number,
  font: string,
): PageSpec['elements'] {
  return [
    { type: 'shape', shape: 'rect', x: x + 4, y: y + 4, w, h, fill: BLACK },
    {
      type: 'shape',
      shape: 'rect',
      x,
      y,
      w,
      h,
      fill,
      stroke: FRAME_SMALL,
      valign: 'middle',
      paragraphs: [{ align: 'center', runs: [{ text, sizePt, bold: true, color: BLACK, font }] }],
    },
  ]
}

/** A framed pastel stat card with its dot, a big numeral and a label. */
function statCard(
  y: number,
  fill: string,
  dot: string,
  { value, label }: Stat,
): PageSpec['elements'] {
  return [
    ...lifted(920, y, 272, 200, fill, 8, FRAME),
    {
      type: 'shape',
      shape: 'ellipse',
      x: 1160,
      y: y + 16,
      w: 16,
      h: 16,
      fill: dot,
      stroke: FRAME_SMALL,
    },
    {
      type: 'text',
      x: 944,
      y: y + 24,
      w: 200,
      h: 112,
      paragraphs: [{ runs: [{ text: value, sizePt: 64, color: BLACK, font: TITLE_LATIN }] }],
    },
    {
      type: 'text',
      x: 944,
      y: y + 144,
      w: 224,
      h: 40,
      paragraphs: [{ runs: [{ text: label, sizePt: 12, bold: true, color: BLACK, font: BODY }] }],
    },
  ]
}

/** A framed white title card with a pink label pill and a stapled yellow button; two stat cards at right; a star. */
function cover(copy: CoverCopy): PageSpec {
  return {
    background: CREAM,
    elements: [
      ...lifted(80, 120, 800, 440, WHITE, 8, FRAME),
      ...chip(112, 152, 300, 40, PINK, copy.label, 12, BODY),
      {
        type: 'text',
        x: 112,
        y: 220,
        w: 740,
        h: 196,
        paragraphs: copy.title.map((text) => ({
          runs: [{ text, sizePt: 48, color: BLACK, font: copy.titleFont }],
        })),
      },
      {
        type: 'text',
        x: 112,
        y: 432,
        w: 740,
        h: 64,
        paragraphs: [{ runs: [{ text: copy.subtitle, sizePt: 18, color: BLACK, font: BODY }] }],
      },
      ...chip(112, 528, 260, 56, YELLOW, copy.button, 16, copy.titleFont),
      ...statCard(120, BLUE, PINK, copy.stats[0]),
      ...statCard(360, GREEN, YELLOW, copy.stats[1]),
      {
        type: 'shape',
        shape: 'star5',
        x: 1096,
        y: 584,
        w: 112,
        h: 108,
        fill: PINK,
        stroke: FRAME_SMALL,
      },
      ...chip(80, 640, 120, 40, WHITE, '01 / 12', 12, TITLE_LATIN),
    ],
  }
}

export const blockFrame: SlideTemplate = {
  id: 'block-frame',
  name: 'BlockFrame',
  scheme: 'light',
  description:
    'Neo-brutalist framed cards on candy pastel grounds, lifted by solid black offset blocks.',
  fonts: { title: TITLE_KO, body: BODY, latinTitle: TITLE_LATIN },
  palette: [OFFWHITE, PINK, BLUE, GREEN, YELLOW, CREAM, BLACK, WHITE],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      titleFont: TITLE_KO,
      label: '2026 신제품 발표',
      title: ['크게 생각하고', '빠르게 만든다'],
      subtitle: '네 사람이 아흔 날 만에 앱을 출시한 과정',
      button: '10월 30일 공개',
      stats: [
        { value: '90', label: '출시까지 걸린 날' },
        { value: '4', label: '함께 만든 사람' },
      ],
    }),
    en: cover({
      titleFont: TITLE_LATIN,
      label: '2026 PRODUCT LAUNCH',
      title: ['LOUD IDEAS,', 'SHIPPED FAST'],
      subtitle: 'How a team of four shipped an app in ninety days',
      button: 'LIVE OCT 30',
      stats: [
        { value: '90', label: 'DAYS TO LAUNCH' },
        { value: '4', label: 'PEOPLE ON THE TEAM' },
      ],
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/block-frame',
  },
}
