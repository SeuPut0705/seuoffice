/**
 * Vellum: one deep periwinkle field on every page, warm yellow serif type set
 * centered on it, and a small teal pin-note in the bottom-left corner.
 * Re-authored for the page-spec builder from the upstream design notes. The
 * upstream typewriter face has no bundled match, so labels and pin-notes use
 * the body font. Text cannot carry alpha, so the upstream 62% yellow for lead
 * text is the solid blend of that yellow over the field; hairlines and muted
 * bars keep their translucency as rect fills.
 */
import type { PageSpec, SpecRun } from '../page-spec'
import {
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  type SlideTemplate,
} from './contract'

const NAVY = '#2A3870'
const NAVY_DEEP = '#1F2858'
const NAVY_MID = '#34407A'
const YELLOW = '#E8D85C'
/** The yellow at 62% over the navy field, as a solid color for lead and caption text */
const YELLOW_SOFT = '#A09B64'
const YELLOW_BRIGHT = '#F5E168'
const TEAL = '#3A7878'

const TITLE_KO = 'Gowun Batang'
const TITLE_LATIN = 'Playfair Display'
const BODY = 'Gowun Dodum'

const STYLE_SHEET = `Backgrounds: main ${NAVY}; cover, content, data and closing are all ${NAVY}. Only two_column_comparison splits into ${NAVY_DEEP} (left) and ${NAVY_MID} (right) halves.
Colors: main text ${YELLOW}; lead text ${YELLOW_SOFT}; primary accent ${YELLOW}; emphasis ${YELLOW_BRIGHT}; secondary accent ${TEAL}, only for kickers, pin-notes, short rules, list numbers and quote marks; card background: none, content floats on the field; border a ${YELLOW} hairline at 20% opacity. No white, no black.
Fonts: Korean title ${TITLE_KO}; Latin title and numerals ${TITLE_LATIN} italic, regular weight; body, kickers and pin-notes ${BODY}. Big titles 36-48pt; subtitles 18-24pt; body 13-15pt; kickers and pin-notes 12pt; stat numerals 48-64pt.
Layout library:
- cover: cover_typography_hero (kicker, short ${TEAL} rule, a centered two-line 48pt title, one lead line), cover_dark_minimal (one centered 40pt title alone on the field)
- content: hero_big_number (one centered 64pt numeral over a 14pt caption), two_column_comparison (${NAVY_DEEP} and ${NAVY_MID} halves, each a kicker, a 24pt title and a numbered list), three_column_cards (three centered columns with no boxes, split by hairlines: a ${TEAL} number, a 22pt title, 13pt body)
- data: kpi_cards_row (centered stats: a 56pt italic figure over a 12pt ${YELLOW_SOFT} label, split by hairlines), chart_with_insight (rect bars in ${YELLOW} at 32% opacity, the key bar solid ${YELLOW}, a hairline baseline)
- closing: closing_thank_you (one centered 44pt title and a lead line), closing_cta (centered title, a ${TEAL} rule, one contact line)
Signature devices:
- Pin-note: every page carries two or three 12pt ${TEAL} lines at the bottom left, a page counter ("03 / 09") and a short label. Never omit it.
- Centered: every title, lead and list column is center aligned within 55-75% of the width, with wide empty field.
- Emphasis: one phrase per title turns upright bold in ${YELLOW_BRIGHT}; the rest stays regular (Latin: italic).
- Kicker: a 12pt ${TEAL} label above the title, then a 28x2px ${TEAL} rect.
- Quote: a 72pt ${TEAL} quote mark centered above a 28pt italic quote.
- Lists are numbered "01", "02" in ${TEAL}, never bullets.
- Hairline: a 1px ${YELLOW} rect at 20% opacity, the only line weight. Only rect fills take opacity; text is always solid.
- Square corners; no cards.
Overall style: A quiet essay pinned to a periwinkle gallery wall, set in warm yellow serif type with one small teal note.`

interface CoverCopy {
  kicker: string
  /** Two title lines; one phrase of the second is the emphasis. */
  title: [SpecRun[], SpecRun[]]
  lead: string
  pin: [string, string]
}

/** Kicker, teal rule, a centered two-line title and a lead line on the bare field; the pin-note sits bottom left. */
function cover(copy: CoverCopy): PageSpec {
  return {
    background: NAVY,
    elements: [
      {
        type: 'text',
        x: 240,
        y: 160,
        w: 800,
        h: 26,
        paragraphs: [
          { align: 'center', runs: [{ text: copy.kicker, sizePt: 13, color: TEAL, font: BODY }] },
        ],
      },
      { type: 'shape', shape: 'rect', x: 626, y: 202, w: 28, h: 2, fill: TEAL },
      {
        type: 'text',
        x: 160,
        y: 232,
        w: 960,
        h: 176,
        paragraphs: copy.title.map((runs) => ({ align: 'center' as const, runs })),
      },
      {
        type: 'text',
        x: 240,
        y: 436,
        w: 800,
        h: 60,
        paragraphs: [
          {
            align: 'center',
            runs: [{ text: copy.lead, sizePt: 18, color: YELLOW_SOFT, font: BODY }],
          },
        ],
      },
      {
        type: 'text',
        x: 77,
        y: 612,
        w: 420,
        h: 56,
        paragraphs: copy.pin.map((text) => ({
          runs: [{ text, sizePt: 12, color: TEAL, font: BODY }],
        })),
      },
    ],
  }
}

const ko = (text: string, emphasis = false): SpecRun => ({
  text,
  sizePt: 46,
  ...(emphasis ? { bold: true } : {}),
  color: emphasis ? YELLOW_BRIGHT : YELLOW,
  font: TITLE_KO,
})

const en = (text: string, emphasis = false): SpecRun => ({
  text,
  sizePt: 46,
  ...(emphasis ? { bold: true } : { italic: true }),
  color: emphasis ? YELLOW_BRIGHT : YELLOW,
  font: TITLE_LATIN,
})

export const vellum: SlideTemplate = {
  id: 'vellum',
  name: 'Vellum',
  scheme: 'dark',
  description:
    'A single deep periwinkle field with warm yellow serif type set centered and a small teal pin-note on every page.',
  fonts: { title: TITLE_KO, body: BODY, latinTitle: TITLE_LATIN },
  palette: [NAVY, NAVY_DEEP, NAVY_MID, YELLOW, YELLOW_SOFT, YELLOW_BRIGHT, TEAL],
  styleSheet: STYLE_SHEET,
  sampleCover: {
    ko: cover({
      kicker: '연구 노트 · 제4권',
      title: [[ko('기억은 어떻게')], [ko('도시', true), ko('를 바꾸는가')]],
      lead: '오래된 동네 열두 곳에서 모은 이야기와 기록',
      pin: ['01 / 12', '도시사 세미나 · 2026 가을'],
    }),
    en: cover({
      kicker: 'RESEARCH NOTES · VOLUME 4',
      title: [[en('How memory')], [en('reshapes the '), en('city', true)]],
      lead: 'Stories and records gathered from twelve old neighborhoods',
      pin: ['01 / 12', 'URBAN HISTORY SEMINAR · AUTUMN 2026'],
    }),
  },
  source: {
    repo: SLIDE_TEMPLATE_SOURCE_REPO,
    commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
    path: 'bold-template-pack/templates/vellum',
  },
}
