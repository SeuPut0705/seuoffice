/**
 * Studio: acid yellow on warm black, capitals so heavy they read as blocks.
 * Re-authored for the page-spec builder from the upstream design notes. The
 * upstream mutes secondary text with opacity; the builder writes run colors
 * without alpha, so each muted tier is the solid color that opacity produces
 * on its page. The full-bleed cover image is left out (covers carry no image),
 * and the monospace metadata face becomes the body font in small capitals.
 */
import type { PageSpec, SpecRun } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const NEAR_BLACK = '#1C1C1C'
const NEAR_BLACK_ALT = '#242422'
const YELLOW = '#F5D200'
const YELLOW_ALT = '#F0CC00'
/** Yellow at 58% on near-black: secondary text on dark pages. */
const YELLOW_MUTED = '#9A860C'
/** Yellow at 32% on near-black: notes and default chart bars on dark pages. */
const YELLOW_FAINT = '#615613'
/** Near-black at 62% on yellow: secondary text on yellow pages. */
const INK_MUTED = '#6E6111'
const BORDER_DARK = '#2E2E2C'

const TITLE_KO = 'Black Han Sans'
const TITLE_LATIN = 'Archivo Black'
const BODY = 'Pretendard'

const STYLE_SHEET = `Backgrounds: main ${NEAR_BLACK}. cover: ${NEAR_BLACK} with one full-height ${YELLOW} panel. content: ${NEAR_BLACK}, now and then a ${YELLOW} page. data: ${NEAR_BLACK}. closing: ${YELLOW}.
Colors: on ${NEAR_BLACK}: titles and main text ${YELLOW}, secondary text ${YELLOW_MUTED}, notes ${YELLOW_FAINT}, panels ${NEAR_BLACK_ALT}, hairlines ${BORDER_DARK}. On ${YELLOW}: titles and main text ${NEAR_BLACK}, secondary text ${INK_MUTED}, panels ${YELLOW_ALT}, hairlines ${NEAR_BLACK} at 18% opacity. Primary accent ${YELLOW}; secondary accent ${NEAR_BLACK} (the two swapped); card background ${NEAR_BLACK_ALT}; border ${BORDER_DARK}. No third hue, no grays.
Fonts: Korean title ${TITLE_KO}; Latin title and every numeral ${TITLE_LATIN}, capitals only; body and metadata ${BODY}. Big titles 44-48pt; subtitles 20-24pt; body 13-15pt; metadata labels 12pt bold capitals; hero numbers 72-80pt.
Layout library:
- cover: cover_split_color (a dark field with the title beside a full-height ${YELLOW} panel holding an 80pt figure), cover_typography_hero (a 48pt title across a dark page, a three-column metadata row at the foot)
- content: hero_big_number (one 80pt figure, one line under it), two_column_comparison (a dark panel and a ${YELLOW} panel split by a 2px rule), three_column_cards (columns under 2px top rules, no boxes), timeline_horizontal (a 2px ${YELLOW} line, numbered steps above)
- data: kpi_cards_row (stat cards: 2px top rule, a 64-72pt figure, a label, a quiet note), chart_with_insight (flat bars in ${YELLOW_FAINT}, the highlighted bar in ${YELLOW}, over a 2px baseline)
- closing: closing_thank_you (${YELLOW} page, one 48pt ${NEAR_BLACK} line low on the page), closing_cta (dark page, a 48pt title, contact lines in the metadata row)
Signature devices:
- Type as mass: capital titles at the top of the range, near the edges; the title is the only ornament.
- Chrome row: a 12pt label left and a counter right over a full-width 1px hairline.
- Metadata row: three 12pt columns at the foot of the cover, aligned left, center and right, under a 1px ${YELLOW} rect at 25% opacity.
- Heavy rule: a 2px rect in the page's main text color on stat card tops, chart baselines and comparison dividers.
- Bullets: an em dash in the page's main text color.
- Only rect fills take opacity; text is always solid. Square corners.
- Leave at least 40% of every page empty.
Overall style: A severe design-office manifesto of acid yellow on warm black, capitals so heavy they read as solid blocks, and nothing else.`

interface CoverCopy {
  titleFont: string
  chrome: string
  title: [string, string]
  lead: string
  /** The metadata row: who for whom and when (left), what (center), which round (right). */
  meta: { parties: string; date: string; project: string; round: string }
  figure: { value: string; label: string; note: string }
}

/** A dark field with chrome, title, lead and the metadata row, beside a full-height yellow panel with one figure. */
function cover(copy: CoverCopy): PageSpec {
  const small = (text: string, color: string): SpecRun => ({
    text,
    sizePt: 12,
    bold: true,
    color,
    font: BODY,
  })
  return {
    background: NEAR_BLACK,
    elements: [
      { type: 'shape', shape: 'rect', x: 896, y: 0, w: 384, h: 720, fill: YELLOW },
      {
        type: 'text',
        x: 64,
        y: 48,
        w: 520,
        h: 24,
        paragraphs: [{ runs: [small(copy.chrome, YELLOW_MUTED)] }],
      },
      {
        type: 'text',
        x: 632,
        y: 48,
        w: 200,
        h: 24,
        paragraphs: [{ align: 'right', runs: [small('01 / 32', YELLOW_MUTED)] }],
      },
      { type: 'shape', shape: 'rect', x: 64, y: 84, w: 768, h: 1, fill: BORDER_DARK },
      {
        type: 'text',
        x: 64,
        y: 168,
        w: 790,
        h: 232,
        paragraphs: copy.title.map((text) => ({
          runs: [{ text, sizePt: 48, color: YELLOW, font: copy.titleFont }],
        })),
      },
      { type: 'shape', shape: 'rect', x: 64, y: 424, w: 120, h: 2, fill: YELLOW },
      {
        type: 'text',
        x: 64,
        y: 448,
        w: 740,
        h: 88,
        paragraphs: [{ runs: [{ text: copy.lead, sizePt: 20, color: YELLOW_MUTED, font: BODY }] }],
      },
      { type: 'shape', shape: 'rect', x: 64, y: 600, w: 768, h: 1, fill: `${YELLOW}40` },
      {
        type: 'text',
        x: 64,
        y: 620,
        w: 272,
        h: 60,
        paragraphs: [
          { runs: [small(copy.meta.parties, YELLOW)] },
          { runs: [small(copy.meta.date, YELLOW_MUTED)] },
        ],
      },
      {
        type: 'text',
        x: 344,
        y: 620,
        w: 240,
        h: 30,
        paragraphs: [{ align: 'center', runs: [small(copy.meta.project, YELLOW)] }],
      },
      {
        type: 'text',
        x: 592,
        y: 620,
        w: 240,
        h: 30,
        paragraphs: [{ align: 'right', runs: [small(copy.meta.round, YELLOW)] }],
      },
      { type: 'shape', shape: 'rect', x: 936, y: 312, w: 304, h: 2, fill: NEAR_BLACK },
      {
        type: 'text',
        x: 936,
        y: 330,
        w: 304,
        h: 140,
        paragraphs: [
          { runs: [{ text: copy.figure.value, sizePt: 80, color: NEAR_BLACK, font: TITLE_LATIN }] },
        ],
      },
      {
        type: 'text',
        x: 936,
        y: 484,
        w: 304,
        h: 72,
        paragraphs: [
          { runs: [small(copy.figure.label, NEAR_BLACK)] },
          { runs: [small(copy.figure.note, INK_MUTED)] },
        ],
      },
    ],
  }
}

export const studio: SlideTemplate = {
  id: 'studio',
  name: 'Studio',
  scheme: 'dark',
  description: 'Acid yellow on warm black, with capitals so heavy they read as solid blocks.',
  fonts: { title: TITLE_KO, body: BODY, latinTitle: TITLE_LATIN },
  palette: [
    NEAR_BLACK,
    NEAR_BLACK_ALT,
    YELLOW,
    YELLOW_ALT,
    YELLOW_MUTED,
    YELLOW_FAINT,
    INK_MUTED,
    BORDER_DARK,
  ],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      titleFont: TITLE_KO,
      chrome: '크리에이티브 리뷰 — 2차',
      title: ['소음은 줄이고', '배짱은 키우고'],
      lead: '도시 공공자전거의 새 얼굴: 워드마크부터 길 안내 표지까지',
      meta: {
        parties: '디자인팀 × 교통정책팀',
        date: '2027년 3월',
        project: '아이덴티티 제안',
        round: '두 번째 검토',
      },
      figure: { value: '312', label: '새 표지를 다는 대여소', note: '2027년 가을까지 교체' },
    }),
    en: cover({
      titleFont: TITLE_LATIN,
      chrome: 'CREATIVE REVIEW — ROUND 2',
      title: ['LESS NOISE,', 'MORE NERVE'],
      lead: 'A new identity for a city bike-share network, from wordmark to wayfinding',
      meta: {
        parties: 'DESIGN × TRANSIT TEAM',
        date: 'MARCH 2027',
        project: 'IDENTITY PROPOSAL',
        round: 'SECOND REVIEW',
      },
      figure: { value: '312', label: 'STATIONS GET THE NEW SIGNS', note: 'ROLLOUT BY AUTUMN 2027' },
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/studio',
  },
}
