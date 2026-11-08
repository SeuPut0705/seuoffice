/**
 * Signal: a sober long-form briefing on navy and cream, editorial serif
 * headlines with one gold phrase, hairlines in place of boxes. Re-authored for
 * the page-spec builder from the upstream design notes; the faint grid overlay
 * on dark pages and the image scrim are left out, and the pyramid bands mix
 * gold into navy as translucent rect fills. The upstream serif is replaced by
 * Noto Serif KR, whose Latin letters come from the same serif family, so one
 * font carries Korean and Latin titles.
 */
import type { PageSpec, SpecRun } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const NAVY = '#1C2644'
const NAVY_ALT = '#232F55'
const CREAM = '#F0ECE3'
const CREAM_ALT = '#E6E0D4'
const TEXT_WARM = '#E2DCD0'
const MUTED_DARK = '#8A96A8'
const HINT_DARK = '#4E5A6E'
const INK = '#1A2030'
const MUTED_LIGHT = '#5A6270'
const GOLD = '#C8A870'
const BORDER_DARK = '#2E3D5C'
const BORDER_LIGHT = '#CAC4B4'

const TITLE = 'Noto Serif KR'
const BODY = 'Pretendard'

const STYLE_SHEET = `Backgrounds: main ${NAVY}. cover: ${NAVY}. content: ${CREAM} for dense reading, ${NAVY} for statements. data: ${CREAM}. closing: ${NAVY}.
Colors: on ${NAVY}: titles and main text ${TEXT_WARM} (never white), secondary text ${MUTED_DARK}, notes ${HINT_DARK}, panels ${NAVY_ALT}, hairlines ${BORDER_DARK}. On ${CREAM}: titles and main text ${INK}, secondary text ${MUTED_LIGHT}, panels ${CREAM_ALT}, hairlines ${BORDER_LIGHT}. Primary accent ${GOLD}, the only accent: rules, kickers, figures, one phrase per headline; never body text or a large fill. Secondary accent ${HINT_DARK}. Card background ${CREAM_ALT}; border ${BORDER_DARK} or ${BORDER_LIGHT}.
Fonts: titles and every figure ${TITLE}, Korean and Latin alike; body, labels and kickers ${BODY}. Big titles 40-48pt; subtitles 18-22pt; body 12-15pt; kickers and labels 12pt bold capitals; stat figures 54-72pt.
Layout library:
- cover: cover_magazine (title left, two gold figures right of a vertical hairline, a hairline foot row), cover_dark_minimal (kicker, gold rule, a 48pt title, one lead line)
- content: two_column_comparison (two panels split by a 1px hairline), three_column_cards (columns under 1px top hairlines, no boxes), timeline_horizontal (a 1px spine, 9px ${GOLD} dots, dates above), hero_big_number (a 72pt gold figure)
- data: kpi_cards_row (1px top hairline, gold serif figure, sans label), chart_with_insight (bars in ${HINT_DARK}, the highlighted bar in ${GOLD}, on a 1px baseline)
- closing: closing_thank_you (navy, one serif sentence, a gold rule), closing_cta (navy, title, contact lines)
Signature devices:
- Gold phrase: one phrase of a serif headline in ${GOLD}; Latin headlines italicize it, Korean ones change color only.
- Kicker: 12pt bold capitals in ${GOLD}, a 36x1px ${GOLD} rect between kicker and headline.
- Chrome rows: 12pt label left, counter right, a 1px hairline under the top row and over the foot row; none on cover and closing pages.
- Stat: a ${TITLE} figure in ${GOLD} over a ${BODY} label, a 1px hairline above.
- Tier band: a rect with a 3px ${GOLD} left bar, filled ${GOLD} at 70% opacity at the top tier down to 10% at the base.
- Bullets: an em dash in ${GOLD}.
- No cards, no rounded corners; circles only as timeline dots. Only rect fills take opacity; text is always solid.
Overall style: A sober long-form briefing on navy and cream paper, editorial serif headlines with one gold phrase, and hairlines in place of boxes.`

interface CoverCopy {
  kicker: string
  /** Two title lines; the second ends in the gold phrase. */
  title: [string, { before: string; gold: string; after: string }]
  /** Latin headlines italicize the gold phrase; Korean ones only color it. */
  italic: boolean
  lead: string
  stats: [{ value: string; label: string }, { value: string; label: string }]
  foot: [string, string]
}

/** Kicker, gold rule, title and lead on the left; two gold figures right of a vertical hairline; a hairline foot row. */
function cover(copy: CoverCopy): PageSpec {
  const small = (text: string, color: string): SpecRun => ({
    text,
    sizePt: 12,
    bold: true,
    color,
    font: BODY,
  })
  const titleRun = (text: string, color: string, italic = false): SpecRun => ({
    text,
    sizePt: 44,
    ...(italic ? { italic: true } : {}),
    color,
    font: TITLE,
  })
  const [line1, line2] = copy.title
  const line2Runs = [
    ...(line2.before ? [titleRun(line2.before, TEXT_WARM)] : []),
    titleRun(line2.gold, GOLD, copy.italic),
    ...(line2.after ? [titleRun(line2.after, TEXT_WARM)] : []),
  ]
  const stat = (y: number, s: { value: string; label: string }): PageSpec['elements'] => [
    { type: 'shape', shape: 'rect', x: 928, y, w: 256, h: 1, fill: BORDER_DARK },
    {
      type: 'text',
      x: 928,
      y: y + 16,
      w: 256,
      h: 116,
      paragraphs: [{ runs: [{ text: s.value, sizePt: 54, color: GOLD, font: TITLE }] }],
    },
    {
      type: 'text',
      x: 928,
      y: y + 140,
      w: 256,
      h: 48,
      paragraphs: [{ runs: [small(s.label, MUTED_DARK)] }],
    },
  ]
  return {
    background: NAVY,
    elements: [
      {
        type: 'text',
        x: 96,
        y: 104,
        w: 720,
        h: 24,
        paragraphs: [{ runs: [small(copy.kicker, GOLD)] }],
      },
      { type: 'shape', shape: 'rect', x: 96, y: 144, w: 36, h: 1, fill: GOLD },
      {
        type: 'text',
        x: 96,
        y: 172,
        w: 740,
        h: 200,
        paragraphs: [{ runs: [titleRun(line1, TEXT_WARM)] }, { runs: line2Runs }],
      },
      {
        type: 'text',
        x: 96,
        y: 396,
        w: 700,
        h: 80,
        paragraphs: [{ runs: [{ text: copy.lead, sizePt: 20, color: MUTED_DARK, font: BODY }] }],
      },
      { type: 'shape', shape: 'rect', x: 880, y: 104, w: 1, h: 432, fill: BORDER_DARK },
      ...stat(104, copy.stats[0]),
      ...stat(320, copy.stats[1]),
      { type: 'shape', shape: 'rect', x: 96, y: 600, w: 1088, h: 1, fill: BORDER_DARK },
      {
        type: 'text',
        x: 96,
        y: 624,
        w: 520,
        h: 24,
        paragraphs: [{ runs: [small(copy.foot[0], MUTED_DARK)] }],
      },
      {
        type: 'text',
        x: 664,
        y: 624,
        w: 520,
        h: 24,
        paragraphs: [{ align: 'right', runs: [small(copy.foot[1], MUTED_DARK)] }],
      },
    ],
  }
}

export const signal: SlideTemplate = {
  id: 'signal',
  name: 'Signal',
  scheme: 'mixed',
  description:
    'A sober briefing on navy and cream with editorial serif titles, one gold accent and hairline rules.',
  fonts: { title: TITLE, body: BODY },
  palette: [
    NAVY,
    NAVY_ALT,
    CREAM,
    CREAM_ALT,
    TEXT_WARM,
    MUTED_DARK,
    HINT_DARK,
    INK,
    MUTED_LIGHT,
    GOLD,
    BORDER_DARK,
    BORDER_LIGHT,
  ],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      kicker: '3분기 이사회 브리핑 · 이사 열람용',
      title: ['흔들리는 시장에서', { before: '', gold: '오래 버티는', after: ' 자본' }],
      italic: false,
      lead: '포트폴리오 점검과 앞으로 3년의 자산 배분 전망',
      stats: [
        { value: '4.2%', label: '연 실질 수익률 목표' },
        { value: '18', label: '연속 흑자 연도' },
      ],
      foot: ['투자위원회', '2027년 10월'],
    }),
    en: cover({
      kicker: 'Q3 BOARD BRIEFING · FOR TRUSTEES ONLY',
      title: ['Patient capital for', { before: 'a ', gold: 'restless decade', after: '' }],
      italic: true,
      lead: 'Portfolio review and the allocation outlook for the next three years',
      stats: [
        { value: '4.2%', label: 'REAL RETURN TARGET PER YEAR' },
        { value: '18', label: 'CONSECUTIVE YEARS IN SURPLUS' },
      ],
      foot: ['INVESTMENT COMMITTEE', 'OCTOBER 2027'],
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/signal',
  },
}
