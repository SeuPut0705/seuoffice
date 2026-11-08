/**
 * Grove: a quiet literary monograph of deep forest and parchment, regular-weight
 * serif titles with one terracotta phrase. Re-authored for the page-spec builder
 * from the upstream design notes; the entrance motion is left out. The builder
 * writes run colors without alpha, so the faint watermark numeral and the muted
 * text tiers are the solid colors their upstream opacity produces on each
 * surface; hairlines keep their opacity as translucent rect fills.
 */
import type { PageSpec, SpecRun } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const FOREST = '#192B1B'
const FOREST_ALT = '#1E3221'
const PARCHMENT = '#E8E4D6'
const PARCHMENT_ALT = '#DEDAD0'
const CREAM = '#D4CFBF'
/** Cream at 60% on forest: secondary text on dark pages. */
const CREAM_MUTED = '#898D7D'
/** Forest at 58% on parchment: secondary text on light pages. */
const FOREST_MUTED = '#70796A'
/** Cream at 6% on forest: the watermark numeral. */
const WATERMARK = '#243525'
const CORAL = '#C8524A'

const TITLE_KO = 'Gowun Batang'
const TITLE_LATIN = 'Playfair Display'
const BODY = 'Gowun Dodum'

const STYLE_SHEET = `Backgrounds: main ${FOREST}. cover: ${FOREST} with a ${PARCHMENT} column. content: ${FOREST}; quote and reading pages ${PARCHMENT}. data: ${FOREST}. closing: ${FOREST}.
Colors: on ${FOREST}: titles and main text ${CREAM} (never white), secondary ${CREAM_MUTED}, panels ${FOREST_ALT}, hairlines ${CREAM} at 12% opacity. On ${PARCHMENT}: titles and main text ${FOREST}, secondary ${FOREST_MUTED}, panels ${PARCHMENT_ALT}, hairlines ${FOREST} at 14% opacity. Primary accent ${CORAL}, the only accent: kickers, rules, one headline phrase, figures, bullets; never a fill or body text. Secondary accent ${CREAM_MUTED}. Card background ${FOREST_ALT}; border ${CREAM} at 12% opacity.
Fonts: Korean title ${TITLE_KO}; Latin title and every figure ${TITLE_LATIN}; body, labels and kickers ${BODY}. Regular weight only, never bold. Big titles 40-48pt; subtitles 18-22pt; body 13-15pt; labels 12pt capitals; stat figures 40-56pt.
Layout library:
- cover: cover_split_color (title on forest, a parchment column of stats), cover_typography_hero (kicker, coral rule, 48pt title, watermark numeral)
- content: two_column_comparison (two panels split by one hairline), three_column_cards (three notes, each over a hairline), hero_big_number (a 56pt coral figure), timeline_horizontal (a hairline, coral dots)
- data: kpi_cards_row (stats in a row), chart_with_insight (bars in ${CREAM_MUTED}, the highlighted bar in ${CORAL})
- closing: closing_thank_you (a title with a coral phrase), closing_cta (kicker, coral rule, title, contact lines)
Signature devices:
- Coral phrase: one phrase of a headline in ${CORAL}; Latin headlines italicize it, Korean ones change color only.
- Kicker triad: 12pt capitals in ${CORAL}, a 36x1px ${CORAL} rect, then the headline. Once per page.
- Chrome rows on content pages: 12pt label left, counter right, 1px hairlines between them and the body.
- Stat: a ${CORAL} ${TITLE_LATIN} figure over a 12pt capital label, a hairline under, no box.
- Watermark numeral: an 80pt ${TITLE_LATIN} ordinal in solid ${WATERMARK} on forest (${PARCHMENT_ALT} on parchment) in the empty bottom-right corner, never under other text.
- Quote mark: an 80pt ${CORAL} opening quote above the quote.
- Bullets: an em dash in ${CORAL}. Hairlines 1px only; square corners. Only rect fills take opacity; text is always solid.
Overall style: A quiet literary monograph of deep forest and parchment, regular-weight serif titles with one terracotta phrase, and hairlines in wide margins.`

interface CoverCopy {
  titleFont: string
  kicker: string
  /** Two title lines; the second holds the coral phrase. */
  title: [string, { before: string; coral: string; after: string }]
  /** Latin headlines italicize the coral phrase; Korean ones only color it. */
  italic: boolean
  lead: string
  foot: string
  stats: [
    { value: string; label: string },
    { value: string; label: string },
    { value: string; label: string },
  ]
}

/** Kicker, coral rule, title and lead on forest with a watermark numeral; a parchment column of three stats on the right. */
function cover(copy: CoverCopy): PageSpec {
  const small = (text: string, color: string): SpecRun => ({
    text,
    sizePt: 12,
    color,
    font: BODY,
  })
  const titleRun = (text: string, color: string, italic = false): SpecRun => ({
    text,
    sizePt: 48,
    ...(italic ? { italic: true } : {}),
    color,
    font: copy.titleFont,
  })
  const [line1, line2] = copy.title
  const line2Runs = [
    ...(line2.before ? [titleRun(line2.before, CREAM)] : []),
    titleRun(line2.coral, CORAL, copy.italic),
    ...(line2.after ? [titleRun(line2.after, CREAM)] : []),
  ]
  const stat = (y: number, s: { value: string; label: string }): PageSpec['elements'] => [
    {
      type: 'text',
      x: 984,
      y,
      w: 256,
      h: 80,
      paragraphs: [{ runs: [{ text: s.value, sizePt: 40, color: CORAL, font: TITLE_LATIN }] }],
    },
    {
      type: 'text',
      x: 984,
      y: y + 84,
      w: 256,
      h: 40,
      paragraphs: [{ runs: [small(s.label, FOREST_MUTED)] }],
    },
    { type: 'shape', shape: 'rect', x: 984, y: y + 132, w: 256, h: 1, fill: `${FOREST}24` },
  ]
  return {
    background: FOREST,
    elements: [
      { type: 'shape', shape: 'rect', x: 944, y: 0, w: 336, h: 720, fill: PARCHMENT },
      {
        type: 'text',
        x: 128,
        y: 128,
        w: 720,
        h: 24,
        paragraphs: [{ runs: [small(copy.kicker, CORAL)] }],
      },
      { type: 'shape', shape: 'rect', x: 128, y: 168, w: 36, h: 1, fill: CORAL },
      {
        type: 'text',
        x: 128,
        y: 196,
        w: 760,
        h: 210,
        paragraphs: [{ runs: [titleRun(line1, CREAM)] }, { runs: line2Runs }],
      },
      {
        type: 'text',
        x: 128,
        y: 430,
        w: 640,
        h: 80,
        paragraphs: [{ runs: [{ text: copy.lead, sizePt: 18, color: CREAM_MUTED, font: BODY }] }],
      },
      { type: 'shape', shape: 'rect', x: 128, y: 600, w: 600, h: 1, fill: `${CREAM}1F` },
      {
        type: 'text',
        x: 128,
        y: 624,
        w: 480,
        h: 24,
        paragraphs: [{ runs: [small(copy.foot, CREAM_MUTED)] }],
      },
      {
        type: 'text',
        x: 760,
        y: 556,
        w: 168,
        h: 156,
        paragraphs: [
          {
            align: 'right',
            runs: [{ text: '04', sizePt: 80, color: WATERMARK, font: TITLE_LATIN }],
          },
        ],
      },
      ...stat(128, copy.stats[0]),
      ...stat(296, copy.stats[1]),
      ...stat(464, copy.stats[2]),
    ],
  }
}

export const grove: SlideTemplate = {
  id: 'grove',
  name: 'Grove',
  scheme: 'mixed',
  description:
    'Deep forest green and parchment with quiet serif titles, one terracotta accent and hairline rules.',
  fonts: { title: TITLE_KO, body: BODY, latinTitle: TITLE_LATIN },
  palette: [
    FOREST,
    FOREST_ALT,
    PARCHMENT,
    PARCHMENT_ALT,
    CREAM,
    CREAM_MUTED,
    FOREST_MUTED,
    WATERMARK,
    CORAL,
  ],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      titleFont: TITLE_KO,
      kicker: '네 번째 수확 보고서 · 2027',
      title: ['과수원이 올해', { before: '', coral: '가르쳐 준', after: ' 것들' }],
      italic: false,
      lead: '회원과 협력 농가에 전하는, 느리게 키운 열두 달의 기록',
      foot: '회원용 · 봄호',
      stats: [
        { value: '1,200', label: '새로 심은 나무' },
        { value: '38%', label: '상자당 물 사용 절감' },
        { value: '212', label: '함께하는 회원 가구' },
      ],
    }),
    en: cover({
      titleFont: TITLE_LATIN,
      kicker: 'FOURTH HARVEST REPORT · 2027',
      title: ['What the orchard', { before: 'taught us ', coral: 'this year', after: '' }],
      italic: true,
      lead: 'Notes from twelve months of slow growing, for our members and partner farms',
      foot: "MEMBERS' EDITION · SPRING",
      stats: [
        { value: '1,200', label: 'TREES PLANTED' },
        { value: '38%', label: 'LESS WATER PER CRATE' },
        { value: '212', label: 'MEMBER HOUSEHOLDS' },
      ],
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/grove',
  },
}
