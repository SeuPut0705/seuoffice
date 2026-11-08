/**
 * Editorial Tri-Tone: an arts-magazine system in exactly three inks (blush
 * pink, butter and wine) with section markers, pills and rounded value cards.
 * Re-authored for the page-spec builder from the upstream design notes. The
 * upstream monospace label face and grotesque display face have no exact bundled
 * match, so titles take a heavy grotesque and labels the body font. The serif
 * accent face has no slot either, so headline emphasis is a weight contrast
 * (heavy against regular) instead of a face switch. The multi-series
 * area/dotted-line chart is reduced to solid rect bars. The upstream translucent
 * footer text is set solid: the builder writes run colors without alpha.
 */
import type { PageSpec, SpecRun } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const PINK = '#F2B6C6'
const BUTTER = '#F2D86A'
const BURGUNDY = '#7A1F35'

const TITLE_KO = 'Pretendard'
const TITLE_LATIN = 'Space Grotesk'
const BODY = 'Pretendard'

const STYLE_SHEET = `Backgrounds: main ${BUTTER}. cover: ${BUTTER} with a ${BURGUNDY} panel down the right third. content: ${BUTTER}, or ${PINK} for card pages. data: ${BURGUNDY}. closing: ${BURGUNDY}.
Colors: three inks only, never white, gray or black. Main text ${BURGUNDY}; text on ${BURGUNDY} is ${BUTTER}, numerals and emphasis there ${PINK}. Primary accent ${BURGUNDY}; secondary accent ${PINK} (second data series, pills); card background ${BUTTER} on dark or ${PINK} pages, ${BURGUNDY} on ${BUTTER}; border ${BURGUNDY}. Never ${PINK} text on ${BUTTER}.
Fonts: Korean title ${TITLE_KO} bold (heavy); Latin title, numerals and years ${TITLE_LATIN} bold; body, labels and pills ${BODY}. Big titles 36-48pt; subtitles 18-24pt; body 13-15pt; labels 12pt bold, Latin in capitals; hero numbers 64-80pt.
Layout library:
- cover: cover_split_color (title, pills and footer on ${BUTTER}, issue numeral on the ${BURGUNDY} panel), cover_typography_hero (one surface, a 48pt title over a row of pills)
- content: three_column_cards (on ${PINK}, roundRect cards alternating ${BURGUNDY} and ${BUTTER}), two_column_comparison (a ${BUTTER} half against a ${BURGUNDY} half), hero_big_number (an 80pt ${PINK} figure on ${BURGUNDY}), timeline_horizontal (a 4px ${BURGUNDY} axis at 15% opacity, 20px ${BURGUNDY} dots ringed in ${BUTTER}, bold years)
- data: chart_with_insight (a ${BUTTER} roundRect chart card on ${BURGUNDY}; rect bars in ${BURGUNDY}, comparison series ${PINK}), kpi_cards_row (${BUTTER} roundRect cards, 64pt ${BURGUNDY} figures)
- closing: closing_thank_you (${BUTTER} title, one ${PINK} sign-off line), closing_cta (title over a row of pills)
Signature devices:
- Section marker: every page opens top left with "§ 01 — Title" in ${BODY} 12pt bold.
- Emphasis: no second face; one phrase per title drops from heavy to regular weight, in ${PINK} on ${BURGUNDY}.
- Pill: a roundRect, ${BURGUNDY} with ${PINK} text or ${PINK} with ${BURGUNDY} text, 14-18pt; tags and legends are pills.
- Value card: a roundRect with no trim, a 20-24pt title over 13pt body.
- Divider: a 2px ${BUTTER} rect at 30% opacity on ${BURGUNDY}, solid ${BURGUNDY} on light pages. Only rect fills take opacity; text is always solid.
- Footer: deck title and date 12pt bottom left, then a row of 8px dots (current page solid, others at 30% opacity).
- Split pages: one half ${BUTTER}, the other ${BURGUNDY}, edge to edge.
Overall style: An independent arts magazine in three inks, blush pink, butter and wine, with heavy grotesque headlines and rounded pills.`

interface CoverCopy {
  marker: string
  /** Two title lines; the second carries the emphasis. */
  title: [SpecRun[], SpecRun[]]
  subtitle: string
  pills: [string, string, string]
  footer: string
  issueLabel: string
  places: string
}

/** Butter field with title, pills and footer; a wine panel on the right holds the issue numeral. */
function cover(copy: CoverCopy): PageSpec {
  const pill = (x: number, w: number, text: string, fill: string, color: string) => ({
    type: 'shape' as const,
    shape: 'roundRect',
    x,
    y: 480,
    w,
    h: 44,
    fill,
    paragraphs: [
      {
        align: 'center' as const,
        runs: [{ text, sizePt: 15, bold: true, color, font: BODY }],
      },
    ],
  })
  const dot = (x: number, fill: string) => ({
    type: 'shape' as const,
    shape: 'ellipse',
    x,
    y: 658,
    w: 8,
    h: 8,
    fill,
  })
  return {
    background: BUTTER,
    elements: [
      { type: 'shape', shape: 'rect', x: 860, y: 0, w: 420, h: 720, fill: BURGUNDY },
      {
        type: 'text',
        x: 64,
        y: 56,
        w: 740,
        h: 26,
        paragraphs: [
          { runs: [{ text: copy.marker, sizePt: 12, bold: true, color: BURGUNDY, font: BODY }] },
        ],
      },
      {
        type: 'text',
        x: 64,
        y: 160,
        w: 760,
        h: 190,
        paragraphs: copy.title.map((runs) => ({ runs })),
      },
      {
        type: 'text',
        x: 64,
        y: 380,
        w: 760,
        h: 64,
        paragraphs: [{ runs: [{ text: copy.subtitle, sizePt: 18, color: BURGUNDY, font: BODY }] }],
      },
      pill(64, 160, copy.pills[0], BURGUNDY, PINK),
      pill(240, 190, copy.pills[1], PINK, BURGUNDY),
      pill(446, 220, copy.pills[2], BURGUNDY, PINK),
      { type: 'shape', shape: 'rect', x: 64, y: 620, w: 760, h: 2, fill: BURGUNDY },
      {
        type: 'text',
        x: 64,
        y: 648,
        w: 560,
        h: 26,
        paragraphs: [
          { runs: [{ text: copy.footer, sizePt: 12, bold: true, color: BURGUNDY, font: BODY }] },
        ],
      },
      dot(752, BURGUNDY),
      dot(768, `${BURGUNDY}4D`),
      dot(784, `${BURGUNDY}4D`),
      dot(800, `${BURGUNDY}4D`),
      dot(816, `${BURGUNDY}4D`),
      {
        type: 'text',
        x: 912,
        y: 96,
        w: 320,
        h: 132,
        paragraphs: [
          {
            runs: [{ text: 'No. 12', sizePt: 72, bold: true, color: PINK, font: TITLE_LATIN }],
          },
        ],
      },
      {
        type: 'text',
        x: 912,
        y: 248,
        w: 320,
        h: 26,
        paragraphs: [
          { runs: [{ text: copy.issueLabel, sizePt: 12, bold: true, color: BUTTER, font: BODY }] },
        ],
      },
      { type: 'shape', shape: 'rect', x: 912, y: 596, w: 320, h: 2, fill: `${BUTTER}4D` },
      {
        type: 'text',
        x: 912,
        y: 616,
        w: 320,
        h: 52,
        paragraphs: [{ runs: [{ text: copy.places, sizePt: 14, color: BUTTER, font: BODY }] }],
      },
    ],
  }
}

/** A title run: heavy by default, regular weight for the emphasized phrase. */
const titleRun = (font: string, text: string, emphasis = false): SpecRun => ({
  text,
  sizePt: 44,
  ...(emphasis ? {} : { bold: true }),
  color: BURGUNDY,
  font,
})

export const editorialTriTone: SlideTemplate = {
  id: 'editorial-tri-tone',
  name: 'Editorial Tri-Tone',
  scheme: 'mixed',
  description:
    'An arts-magazine system printed in blush pink, butter and wine, with heavy grotesque headlines, pills and rounded cards.',
  fonts: { title: TITLE_KO, body: BODY, latinTitle: TITLE_LATIN },
  palette: [PINK, BUTTER, BURGUNDY],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      marker: '§ 00 — 연간 편집 보고서',
      title: [[titleRun(TITLE_KO, '느리게 읽는')], [titleRun(TITLE_KO, '도시의 사계절', true)]],
      subtitle: '한 해 동안 펴낸 열두 권의 잡지와 그 독자들에 대한 기록',
      pills: ['에세이', '인터뷰', '사진'],
      footer: '2026 가을 · 편집부',
      issueLabel: '열두 번째 호',
      places: '서울 · 부산 · 제주 · 전주',
    }),
    en: cover({
      marker: '§ 00 — ANNUAL EDITORIAL REVIEW',
      title: [
        [titleRun(TITLE_LATIN, 'A City, Read Slowly')],
        [titleRun(TITLE_LATIN, 'in four seasons', true)],
      ],
      subtitle: 'A record of twelve issues and the readers who kept them',
      pills: ['ESSAYS', 'INTERVIEWS', 'PHOTOGRAPHY'],
      footer: 'AUTUMN 2026 · EDITORIAL DESK',
      issueLabel: 'ISSUE TWELVE',
      places: 'SEOUL · BUSAN · JEJU · JEONJU',
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/editorial-tri-tone',
  },
}
