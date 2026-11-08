/**
 * Blue Professional: warm cream paper with one cobalt accent, in the manner of
 * a consulting brief. Re-authored for the page-spec builder from the upstream
 * design notes. The tinted cards, borders and atmosphere circles become shape
 * fills and outlines with alpha; the hover lift on the button and the
 * diagonal clipped cover panel are left out (the panel is a straight tinted
 * rect). The green and red change chips are dropped to keep a single hue.
 */
import type { PageSpec } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const CREAM = '#FDFAE7'
const COBALT = '#1E2BFA'
const TEXT = '#111111'
const MUTED = '#6B6B6B'
const LIGHT = '#9A9A9A'

/** Cobalt at the opacities the design uses on shape fills and outlines (8%, 20%, 25%, 40%). */
const COBALT_8 = `${COBALT}14`
const COBALT_20 = `${COBALT}33`
const COBALT_25 = `${COBALT}40`
const COBALT_40 = `${COBALT}66`

const TITLE_KO = 'Pretendard'
const TITLE_LATIN = 'Space Grotesk'
const BODY = 'Pretendard'

const STYLE_SHEET = `Backgrounds: cover: ${CREAM} with a ${COBALT} panel at 8% opacity on the right third. content: ${CREAM}. data: ${CREAM}. closing: ${CREAM} with two concentric circles. Never white.
Colors: headlines and main text ${TEXT}; body ${MUTED}; meta lines ${LIGHT}; primary accent ${COBALT} (eyebrows, numerals, bars, step circles, the one solid button); secondary accent ${COBALT} at 15% opacity (bar tracks, second series), never a second hue; card background ${COBALT} at 4% opacity; border ${COBALT} at 20% opacity, 1pt. Headlines are never ${COBALT}; text on ${COBALT} is ${CREAM}.
Fonts: Korean title ${TITLE_KO} bold; Latin title, eyebrows and numerals ${TITLE_LATIN}; body ${BODY}. Big titles 40-48pt; headlines 32-36pt; subtitles 18-22pt; body 13-15pt; eyebrows 12-14pt bold capitals; hero numbers 48-72pt.
Layout library:
- cover: cover_split_color (title at left, tinted panel at right with one ${COBALT} figure in circles), cover_typography_hero (48pt title under the accent line)
- content: three_column_cards (tinted cards), two_column_comparison (two tinted cards), timeline_horizontal (56px ${COBALT} step circles on a hairline), hero_big_number (72pt ${COBALT} figure beside a paragraph)
- data: kpi_cards_row (tinted cards with ${COBALT} numerals), chart_with_insight (${COBALT} bars on 15% tracks, insight card at right)
- closing: closing_cta (centered title, one ${COBALT} pill button with ${CREAM} text), closing_thank_you (centered title inside two concentric circles)
Signature devices:
- Slide header: on content and data pages a ${COBALT} capital eyebrow at top left, a tag pill at top right (roundRect in ${COBALT} at 8% opacity), then one headline.
- Tinted card: a roundRect filled ${COBALT} at 4% opacity with a 1pt ${COBALT} outline at 20% opacity; never solid, never a hard frame.
- Accent line: a 60x4px ${COBALT} rect above a cover or closing title.
- Dot grid: nine 8px ${COBALT} circles at 25% opacity in a 3x3 square. Concentric circles: two ellipses with a 1pt ${COBALT} outline at 20-40% opacity, no fill. Cover and closing only.
- Progress bar: a 6px ${COBALT} strip on the bottom edge, as long as the share of the deck shown.
- Text is always a solid color; only shape fills and outlines take opacity.
Overall style: A calm consulting brief on warm cream paper where one cobalt blue carries every number, label and call to action.`

interface CoverCopy {
  titleFont: string
  /** Eyebrow, meta and tag face: the body face for Korean, the Latin title face for English. */
  labelFont: string
  eyebrow: string
  title: [string, string]
  subtitle: string
  meta: string
  tag: string
  figure: string
  figureLabel: string
}

/** A title block on cream at left; a tinted panel at right holds one cobalt figure inside two circles. */
function cover(copy: CoverCopy): PageSpec {
  const dots: PageSpec['elements'] = []
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      dots.push({
        type: 'shape',
        shape: 'ellipse',
        x: 1180 + col * 20,
        y: 56 + row * 20,
        w: 8,
        h: 8,
        fill: COBALT_25,
      })
    }
  }
  return {
    background: CREAM,
    elements: [
      { type: 'shape', shape: 'rect', x: 860, y: 0, w: 420, h: 720, fill: COBALT_8 },
      {
        type: 'shape',
        shape: 'ellipse',
        x: 900,
        y: 160,
        w: 340,
        h: 340,
        stroke: { color: COBALT_20, widthPt: 1 },
      },
      {
        type: 'shape',
        shape: 'ellipse',
        x: 950,
        y: 210,
        w: 240,
        h: 240,
        stroke: { color: COBALT_40, widthPt: 1 },
      },
      ...dots,
      {
        type: 'text',
        x: 80,
        y: 92,
        w: 680,
        h: 28,
        paragraphs: [
          {
            runs: [
              { text: copy.eyebrow, sizePt: 14, bold: true, color: COBALT, font: copy.labelFont },
            ],
          },
        ],
      },
      { type: 'shape', shape: 'rect', x: 80, y: 196, w: 60, h: 4, fill: COBALT },
      {
        type: 'text',
        x: 80,
        y: 224,
        w: 740,
        h: 196,
        paragraphs: copy.title.map((text) => ({
          runs: [{ text, sizePt: 48, bold: true, color: TEXT, font: copy.titleFont }],
        })),
      },
      {
        type: 'text',
        x: 80,
        y: 444,
        w: 740,
        h: 44,
        paragraphs: [{ runs: [{ text: copy.subtitle, sizePt: 20, color: MUTED, font: BODY }] }],
      },
      { type: 'shape', shape: 'rect', x: 80, y: 540, w: 740, h: 1, fill: COBALT_20 },
      {
        type: 'text',
        x: 80,
        y: 570,
        w: 460,
        h: 28,
        paragraphs: [
          { runs: [{ text: copy.meta, sizePt: 13, color: LIGHT, font: copy.labelFont }] },
        ],
      },
      {
        type: 'shape',
        shape: 'roundRect',
        x: 600,
        y: 564,
        w: 220,
        h: 40,
        fill: COBALT_8,
        valign: 'middle',
        paragraphs: [
          {
            align: 'center',
            runs: [{ text: copy.tag, sizePt: 12, bold: true, color: COBALT, font: copy.labelFont }],
          },
        ],
      },
      {
        type: 'text',
        x: 950,
        y: 268,
        w: 240,
        h: 100,
        paragraphs: [
          {
            align: 'center',
            runs: [{ text: copy.figure, sizePt: 54, bold: true, color: COBALT, font: TITLE_LATIN }],
          },
        ],
      },
      {
        type: 'text',
        x: 960,
        y: 372,
        w: 220,
        h: 26,
        paragraphs: [
          {
            align: 'center',
            runs: [{ text: copy.figureLabel, sizePt: 12, color: MUTED, font: BODY }],
          },
        ],
      },
      { type: 'shape', shape: 'rect', x: 0, y: 714, w: 107, h: 6, fill: COBALT },
    ],
  }
}

export const blueProfessional: SlideTemplate = {
  id: 'blue-professional',
  name: 'Blue Professional',
  scheme: 'light',
  description:
    'Warm cream paper with a single cobalt blue accent, quiet tinted cards and a consulting-grade calm.',
  fonts: { title: TITLE_KO, body: BODY, latinTitle: TITLE_LATIN },
  palette: [CREAM, COBALT, TEXT, MUTED, LIGHT],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      titleFont: TITLE_KO,
      labelFont: BODY,
      eyebrow: '분기 경영 브리핑 · Q3 2026',
      title: ['꾸준한 성장,', '신뢰로 증명하다'],
      subtitle: '3분기 실적과 4분기 실행 계획',
      meta: '2026.10.14  |  전략기획팀',
      tag: '3분기 리뷰',
      figure: '+18%',
      figureLabel: '재계약률, 전년 대비',
    }),
    en: cover({
      titleFont: TITLE_LATIN,
      labelFont: TITLE_LATIN,
      eyebrow: 'QUARTERLY BRIEFING · Q3 2026',
      title: ['Steady growth,', 'proven by trust'],
      subtitle: 'Third-quarter results and the plan for Q4',
      meta: 'OCTOBER 14, 2026  |  STRATEGY TEAM',
      tag: 'Q3 REVIEW',
      figure: '+18%',
      figureLabel: 'RENEWAL RATE, YEAR ON YEAR',
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/blue-professional',
  },
}
