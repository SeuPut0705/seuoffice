/**
 * Checks one design template against the template contract: the field rules,
 * the style sheet's colors, fonts and wording, and both sample covers (page-spec
 * validation, palette, fonts and the geometry audit).
 *
 * Node only: the covers are built with pptx-engine to be audited, so this module
 * is exported from the `slides` entry and not from the renderer-safe
 * `slides/templates` subpath. It calls neither a model nor the network.
 */
import { HeuristicMetrics } from '@genoffice/pptx-render'
import { auditDeck } from './audit-deck'
import { buildPagePptx, parsePageSpec, type PageSpec } from './page-spec'
import { pageColors, pageText } from './stage-check'
import {
  SLIDE_TEMPLATE_FONTS,
  SLIDE_TEMPLATE_ID_PATTERN,
  SLIDE_TEMPLATE_SCHEMES,
  SLIDE_TEMPLATE_STYLE_MAX_CHARS,
} from './templates/contract'

export type TemplateProblemCode =
  | 'field'
  | 'style_length'
  | 'style_color'
  | 'style_font'
  | 'style_banned_word'
  | 'cover_spec'
  | 'cover_image'
  | 'cover_color'
  | 'cover_font'
  | 'cover_text_alpha'
  | 'cover_text'
  | 'cover_audit'
  | 'cover_composition'

export interface TemplateProblem {
  code: TemplateProblemCode
  /** The field the problem is in: `id`, `fonts.body`, `styleSheet`, `sampleCover.ko` … */
  where: string
  message: string
}

/**
 * Effects a page spec cannot draw, so a style sheet must not mention them. A
 * word also matches inside a longer one ("shadows"), and by its stem
 * ("rotation", "animated").
 */
export const SLIDE_TEMPLATE_BANNED_WORDS = [
  'gradient',
  'glow',
  'blur',
  'texture',
  'shadow',
  'rotate',
  'animation',
] as const

const BANNED_STEMS: Record<(typeof SLIDE_TEMPLATE_BANNED_WORDS)[number], string> = {
  gradient: 'gradient',
  glow: 'glow',
  blur: 'blur',
  texture: 'textur',
  shadow: 'shadow',
  rotate: 'rotat',
  animation: 'animat',
}

/**
 * Font names a style sheet is searched for besides the bundled ones: the fonts
 * the upstream templates were designed with and the usual system fallbacks. A
 * style sheet is free text, so a font outside this vocabulary is not detected.
 */
const FOREIGN_FONTS = [
  'Inter',
  'Bodoni Moda',
  'Bricolage Grotesque',
  'JetBrains Mono',
  'IBM Plex Mono',
  'Source Serif 4',
  'Instrument Serif',
  'Cormorant Garamond',
  'Manrope',
  'Jost',
  'DM Sans',
  'Barlow',
  'Lora',
  'Courier Prime',
  'Courier New',
  'Noto Serif SC',
  'Noto Sans SC',
  'Noto Sans KR',
  'ZCOOL XiaoWei',
  'Helvetica Neue',
  'Helvetica',
  'Arial',
  'Georgia',
  'Segoe UI',
  'Times New Roman',
  'Malgun Gothic',
]

/** Words that mark a cover as a sample instead of a real first slide (with their endings: "templates"). */
const COVER_BANNED_WORDS = [
  /(?<![a-z0-9])preview[a-z]*/i,
  /(?<![a-z0-9])template[a-z]*/i,
  /미리보기/,
  /템플릿/,
]

const HEX6 = /^#[0-9a-f]{6}$/i
const NEUTRAL = new Set(['#FFFFFF', '#000000'])
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/
const NON_LATIN_SCRIPT = /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u3400-\u9fff\uac00-\ud7af]/
const COMMIT = /^[0-9a-f]{40}$/
const LANGS = ['ko', 'en'] as const

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isText(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Matches `word` where it is not part of a longer Latin word; scripts without word spacing match anywhere. */
function wholeWord(word: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(word)}(?![A-Za-z0-9])`, 'i')
}

/** JSON text with object keys sorted, so two values compare by content. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_key, value: unknown) =>
    isRecord(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  )
}

/**
 * Checks one template and returns every problem found; an empty list means the
 * template is valid. Each message names the value at fault so the template file
 * can be fixed from the message alone.
 */
export async function validateSlideTemplate(template: unknown): Promise<TemplateProblem[]> {
  const problems: TemplateProblem[] = []
  const add = (code: TemplateProblemCode, where: string, message: string): void => {
    problems.push({ code, where, message })
  }
  if (!isRecord(template)) {
    add('field', 'template', 'a template must be an object')
    return problems
  }
  const t = template

  // ── Field rules ──
  if (typeof t.id !== 'string' || !SLIDE_TEMPLATE_ID_PATTERN.test(t.id)) {
    add('field', 'id', `id ${JSON.stringify(t.id)} must match ${SLIDE_TEMPLATE_ID_PATTERN}`)
  }
  if (!isText(t.name)) add('field', 'name', 'name must be a non-empty string')
  if (!SLIDE_TEMPLATE_SCHEMES.some((s) => s === t.scheme)) {
    add(
      'field',
      'scheme',
      `scheme ${JSON.stringify(t.scheme)} must be one of ${SLIDE_TEMPLATE_SCHEMES.join(', ')}`,
    )
  }
  if (!isText(t.description)) {
    add('field', 'description', 'description must be one English sentence')
  } else if (NON_LATIN_SCRIPT.test(t.description)) {
    add('field', 'description', 'description must be written in English')
  }

  const fonts = new Set<string>()
  let fontsValid = true
  if (!isRecord(t.fonts)) {
    fontsValid = false
    add('field', 'fonts', 'fonts must be { title, body, latinTitle? }')
  } else {
    for (const role of ['title', 'body', 'latinTitle'] as const) {
      const font = t.fonts[role]
      if (font === undefined && role === 'latinTitle') continue
      if (typeof font === 'string' && SLIDE_TEMPLATE_FONTS.some((f) => f === font)) {
        fonts.add(font)
        continue
      }
      fontsValid = false
      add(
        'field',
        `fonts.${role}`,
        `fonts.${role} ${JSON.stringify(font)} is not a font bundled with the app (${SLIDE_TEMPLATE_FONTS.join(', ')})`,
      )
    }
  }

  const palette = new Set<string>()
  let paletteValid = true
  if (!Array.isArray(t.palette) || t.palette.length === 0) {
    paletteValid = false
    add('field', 'palette', 'palette must be a non-empty list of #RRGGBB colors')
  } else {
    for (const color of t.palette as unknown[]) {
      if (typeof color === 'string' && HEX6.test(color)) {
        palette.add(color.toUpperCase())
        continue
      }
      paletteValid = false
      add('field', 'palette', `palette entry ${JSON.stringify(color)} is not a #RRGGBB color`)
    }
  }
  const inPalette = (color: string): boolean => palette.has(color) || NEUTRAL.has(color)

  if (!isRecord(t.source)) {
    add('field', 'source', 'source must be { repo, commit, path }')
  } else {
    if (!isText(t.source.repo)) add('field', 'source.repo', 'source.repo must name the repository')
    if (typeof t.source.commit !== 'string' || !COMMIT.test(t.source.commit)) {
      add('field', 'source.commit', 'source.commit must be the full 40-character commit hash')
    }
    if (!isText(t.source.path)) {
      add('field', 'source.path', 'source.path must be the template folder in the repository')
    }
  }

  // ── Style sheet ──
  if (!isText(t.styleSheet)) {
    add('field', 'styleSheet', 'styleSheet must be a non-empty string')
  } else {
    const style = t.styleSheet
    if (NON_LATIN_SCRIPT.test(style)) {
      add('field', 'styleSheet', 'styleSheet must be written in English')
    }
    if (style.length > SLIDE_TEMPLATE_STYLE_MAX_CHARS) {
      add(
        'style_length',
        'styleSheet',
        `styleSheet is ${style.length} characters; the limit is ${SLIDE_TEMPLATE_STYLE_MAX_CHARS}`,
      )
    }
    const colors = new Set<string>()
    for (const m of style.matchAll(/#[0-9A-Za-z]+|\b(?:rgb|hsl)a?\([^)]*\)/g)) colors.add(m[0])
    for (const color of colors) {
      if (!HEX6.test(color)) {
        add('style_color', 'styleSheet', `color "${color}" is not written as #RRGGBB`)
      } else if (paletteValid && !inPalette(color.toUpperCase())) {
        add('style_color', 'styleSheet', `color ${color} is not in the palette`)
      }
    }
    if (fontsValid) {
      // Longest name first, each match blanked out, so "Helvetica Neue" is not also read as "Helvetica".
      let rest = style
      const known = [...SLIDE_TEMPLATE_FONTS, ...FOREIGN_FONTS].sort((a, b) => b.length - a.length)
      for (const font of known) {
        const re = wholeWord(font)
        if (!re.test(rest)) continue
        rest = rest.replace(new RegExp(re.source, 'gi'), ' ')
        if (!fonts.has(font)) {
          add(
            'style_font',
            'styleSheet',
            `font "${font}" is not one of this template's fonts (${[...fonts].join(', ')})`,
          )
        }
      }
    }
    for (const word of SLIDE_TEMPLATE_BANNED_WORDS) {
      const found = new RegExp(`[a-z]*${BANNED_STEMS[word]}[a-z]*`, 'i').exec(style)
      if (found) {
        add(
          'style_banned_word',
          'styleSheet',
          `"${found[0]}" (banned word "${word}"): a page spec cannot draw it; rewrite the device as solid shapes or drop it`,
        )
      }
    }
  }

  // ── Sample covers ──
  if (!isRecord(t.sampleCover)) {
    add('field', 'sampleCover', 'sampleCover must be { ko, en }, each one page spec')
    return problems
  }
  const parsedCovers: PageSpec[] = []
  for (const lang of LANGS) {
    const where = `sampleCover.${lang}`
    const raw = t.sampleCover[lang]
    if (!isRecord(raw)) {
      add('field', where, `${where} must be a page spec`)
      continue
    }
    if (
      Array.isArray(raw.elements) &&
      raw.elements.some((el) => isRecord(el) && el.type === 'image')
    ) {
      add('cover_image', where, 'a sample cover must not contain an image element')
    }
    const parsed = parsePageSpec(JSON.stringify(raw))
    if (!parsed.ok) {
      add('cover_spec', where, `page-spec validation failed: ${parsed.error}`)
      continue
    }
    const spec = parsed.spec
    parsedCovers.push(spec)
    for (const warning of parsed.warnings)
      add('cover_spec', where, `page-spec validation: ${warning}`)
    // The stored cover must be exactly what the builder draws: anything validation
    // drops, clamps or rewrites would be audited in a shape the file does not hold.
    const rawEls = Array.isArray(raw.elements) ? (raw.elements as unknown[]) : []
    if (canonical({ ...raw, elements: [] }) !== canonical({ ...spec, elements: [] })) {
      add('cover_spec', where, 'page-spec validation changes the page fields outside "elements"')
    }
    for (let i = 0; i < Math.max(rawEls.length, spec.elements.length); i++) {
      const kept = spec.elements[i]
      if (canonical(rawEls[i]) === canonical(kept)) continue
      add(
        'cover_spec',
        where,
        `element ${i} is changed by page-spec validation: stored ${canonical(rawEls[i])}, validated ${canonical(kept)}`,
      )
      break
    }

    if (paletteValid) {
      for (const color of pageColors(spec)) {
        if (!inPalette(color)) add('cover_color', where, `color ${color} is not in the palette`)
      }
    }
    // The builder writes a run color as six digits, so alpha on text is lost:
    // a numeral meant to be faint would land fully opaque. Fills and strokes keep alpha.
    for (const [i, el] of spec.elements.entries()) {
      if (el.type === 'image') continue
      const translucent = new Set<string>()
      for (const p of el.paragraphs ?? []) {
        for (const r of p.runs) if (r.color && !HEX6.test(r.color)) translucent.add(r.color)
      }
      for (const color of translucent) {
        add(
          'cover_text_alpha',
          where,
          `element ${i}: text color ${color} carries alpha, which text cannot keep; use a six-digit palette color (only shape fills and strokes may be translucent)`,
        )
      }
    }
    if (fontsValid) {
      const used = new Set<string>()
      for (const el of spec.elements) {
        if (el.type === 'image') continue
        for (const p of el.paragraphs ?? []) {
          for (const r of p.runs) if (r.text.trim()) used.add(r.font ?? '')
        }
      }
      for (const font of used) {
        if (fonts.has(font)) continue
        add(
          'cover_font',
          where,
          font
            ? `font "${font}" is not one of this template's fonts (${[...fonts].join(', ')})`
            : `a text run names no font; every run must use one of ${[...fonts].join(', ')}`,
        )
      }
    }

    const text = pageText(spec)
    if (lang === 'ko' && !HANGUL.test(text)) {
      add('cover_text', where, 'the Korean cover has no Korean text')
    }
    if (lang === 'en' && HANGUL.test(text)) {
      add('cover_text', where, 'the English cover contains Korean text')
    }
    const own = [t.name, t.id, typeof t.id === 'string' ? t.id.replace(/-/g, ' ') : ''].filter(
      isText,
    )
    const shown = new Map<string, string>()
    for (const re of [...own.map(wholeWord), ...COVER_BANNED_WORDS]) {
      const found = re.exec(text)
      if (found) shown.set(found[0].toLowerCase(), found[0])
    }
    for (const word of shown.values()) {
      add(
        'cover_text',
        where,
        `the cover shows "${word}"; it must read as a real first slide, without the template name or sample wording`,
      )
    }

    const { bytes } = await buildPagePptx(spec, { fetchImage: async () => null })
    const pages = await auditDeck(bytes, { metrics: new HeuristicMetrics() })
    for (const issue of pages.flatMap((page) => page.issues)) {
      add('cover_audit', where, `geometry audit: ${issue}`)
    }
  }

  if (parsedCovers.length === LANGS.length) {
    const shape = (spec: PageSpec): string =>
      spec.elements.map((el) => (el.type === 'shape' ? `shape:${el.shape}` : el.type)).join(' ')
    const [ko, en] = parsedCovers.map(shape)
    if (ko !== en) {
      add(
        'cover_composition',
        'sampleCover',
        `the two covers are not the same composition: ko is [${ko}], en is [${en}]`,
      )
    }
  }
  return problems
}
