/**
 * What one built-in design template is. A template hands the page generator a
 * ready-made style sheet, and shows the user one sample cover per language.
 *
 * Renderer-safe: this folder is imported by its own subpath
 * (`@genoffice/pipelines/slides/templates`), so nothing in it may load a
 * package or a file outside the folder at run time. Types are imported with
 * `import type` only.
 */
import type { PageSpec } from '../page-spec'

export const SLIDE_TEMPLATE_SCHEMES = ['light', 'dark', 'mixed'] as const
export type SlideTemplateScheme = (typeof SLIDE_TEMPLATE_SCHEMES)[number]

export const SLIDE_TEMPLATE_ID_PATTERN = /^[a-z0-9-]+$/

/** The style sheet rides along with every page request, so its length is capped. */
export const SLIDE_TEMPLATE_STYLE_MAX_CHARS = 2400

/** Fonts bundled with the app for templates; a template may name no other font. */
export const SLIDE_TEMPLATE_FONTS = [
  'Pretendard',
  'Noto Serif KR',
  'Black Han Sans',
  'Do Hyeon',
  'Gowun Dodum',
  'Gowun Batang',
  'Bebas Neue',
  'Space Grotesk',
  'Playfair Display',
  'Archivo Black',
] as const

/** The MIT-licensed project the templates are re-authored from, and the commit they were read at. */
export const SLIDE_TEMPLATE_SOURCE_REPO = 'zarazhangrui/frontend-slides'
export const SLIDE_TEMPLATE_SOURCE_COMMIT = '9906a34d640d2111f724544cbc50f7f130569ae1'

export interface SlideTemplateFonts {
  /** Korean title font */
  title: string
  body: string
  /** Latin title and numeral font, when it differs from `title` */
  latinTitle?: string
}

export interface SlideTemplate {
  /** The upstream slug, unique in the list */
  id: string
  /** The upstream English name; never translated */
  name: string
  scheme: SlideTemplateScheme
  /** One English sentence; the UI shows its own translated descriptions */
  description: string
  fonts: SlideTemplateFonts
  /** Every color the style sheet and the sample covers use, as `#RRGGBB` (white and black need no entry) */
  palette: readonly string[]
  /** The style sheet the page generator reads (shape: guides/design.md, "Style sheet first") */
  styleSheet: string
  /** The same first slide in Korean and in English, on the 1280x720 canvas */
  sampleCover: { ko: PageSpec; en: PageSpec }
  source: {
    repo: string
    /** Full commit hash the upstream files were read at */
    commit: string
    /** Folder of the template inside the upstream repository */
    path: string
  }
}
