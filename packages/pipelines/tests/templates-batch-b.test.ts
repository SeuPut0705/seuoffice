/**
 * Design templates raw-grid, studio, signal and grove: each passes the template
 * validator, and each style sheet keeps the sections, layouts and devices that
 * make the design recognizable.
 */
import { describe, expect, it } from 'vitest'
import { validateSlideTemplate } from '../src/slides/template-check'
import { LAYOUT_VARIANTS, PAGE_TYPES } from '../src/slides/outline'
import {
  SLIDE_TEMPLATE_FONTS,
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_STYLE_MAX_CHARS,
  type SlideTemplate,
} from '../src/slides/templates/contract'
import { grove } from '../src/slides/templates/grove'
import { rawGrid } from '../src/slides/templates/raw-grid'
import { signal } from '../src/slides/templates/signal'
import { studio } from '../src/slides/templates/studio'

/** id, name and scheme as the fixed template list has them. */
const BATCH: [string, SlideTemplate, string, string][] = [
  ['raw-grid', rawGrid, 'Raw Grid', 'light'],
  ['studio', studio, 'Studio', 'dark'],
  ['signal', signal, 'Signal', 'mixed'],
  ['grove', grove, 'Grove', 'mixed'],
]

/** The layout variants a style sheet lists for one page type, read from its "- type: …" line. */
function layoutsFor(styleSheet: string, type: string): string[] {
  const line = styleSheet.split('\n').find((l) => l.startsWith(`- ${type}: `)) ?? ''
  return [...line.matchAll(/\b([a-z]+(?:_[a-z0-9]+)+) \(/g)].map((m) => m[1]!)
}

/** Every text run of a cover, in element order. */
function coverRuns(t: SlideTemplate) {
  return Object.values(t.sampleCover).flatMap((spec) =>
    spec.elements.flatMap((el) =>
      el.type === 'image' ? [] : (el.paragraphs ?? []).flatMap((p) => p.runs),
    ),
  )
}

describe.each(BATCH)('%s', (id, t, name, scheme) => {
  it('passes the template validator with no problems', async () => {
    expect(await validateSlideTemplate(t)).toEqual([])
  })

  it('carries its fixed id, name and scheme and the pinned upstream source', () => {
    expect([t.id, t.name, t.scheme]).toEqual([id, name, scheme])
    expect(t.source.commit).toBe(SLIDE_TEMPLATE_SOURCE_COMMIT)
    expect(t.source.path).toBe(`bold-template-pack/templates/${id}`)
    for (const font of Object.values(t.fonts)) expect(SLIDE_TEMPLATE_FONTS).toContain(font)
    expect(t.styleSheet.length).toBeLessThanOrEqual(SLIDE_TEMPLATE_STYLE_MAX_CHARS)
  })

  it('names backgrounds, colors, fonts, layouts, devices and an overall style', () => {
    for (const heading of ['Backgrounds', 'Colors', 'Fonts', 'Layout library', 'Signature devices'])
      expect(t.styleSheet).toContain(`${heading}:`)
    expect(t.styleSheet).toMatch(/^Overall style: .+\.$/m)
    for (const type of ['cover', 'content', 'data', 'closing'])
      expect(t.styleSheet).toMatch(new RegExp(`(?:^|[ .])${type}: `))
  })

  it('offers at least two known layout variants for every page type', () => {
    for (const type of PAGE_TYPES) {
      const layouts = layoutsFor(t.styleSheet, type)
      expect(layouts.length, type).toBeGreaterThanOrEqual(2)
      for (const layout of layouts) expect(LAYOUT_VARIANTS[type]).toContain(layout)
    }
  })

  it('keeps every cover text run in a solid palette color and a template font', () => {
    const allowed = new Set([...t.palette, '#FFFFFF', '#000000'])
    const fonts = new Set(Object.values(t.fonts))
    for (const run of coverRuns(t)) {
      expect(run.color).toMatch(/^#[0-9A-F]{6}$/)
      expect(allowed.has(run.color!)).toBe(true)
      expect(fonts.has(run.font!)).toBe(true)
    }
  })

  it('asks for opacity on rect fills only, never on text', () => {
    for (const line of t.styleSheet.split('\n')) {
      if (!/opacity/i.test(line)) continue
      expect(line).not.toMatch(/text (?:is|in) .{0,40}opacity/i)
    }
  })
})

describe('raw-grid', () => {
  it('turns the offset depth into a solid black block drawn behind the card', () => {
    expect(rawGrid.styleSheet).toMatch(/- Offset block: a solid #0A0A0A rect .*drawn first/)
    const els = rawGrid.sampleCover.en.elements
    const card = els.findIndex(
      (el) => el.type === 'shape' && el.fill === '#FFFFFF' && el.stroke && el.w === 344,
    )
    const block = els[card - 1]!
    const front = els[card]!
    expect(block.type === 'shape' && block.fill).toBe('#0A0A0A')
    expect([block.x - front.x, block.y - front.y, block.w, block.h]).toEqual([
      6,
      6,
      front.w,
      front.h,
    ])
  })

  it('keeps pink and green as fills, never as text', () => {
    for (const run of coverRuns(rawGrid)) expect(['#F2D4CF', '#E5EDD6']).not.toContain(run.color)
  })
})

describe('studio', () => {
  it('stays binary: yellow and near-black titles, no third hue in the palette', () => {
    expect(studio.styleSheet).toMatch(/No third hue/)
    for (const spec of Object.values(studio.sampleCover)) {
      const title = spec.elements.find(
        (el) =>
          el.type === 'text' && el.paragraphs.some((p) => p.runs.some((r) => r.sizePt === 48)),
      )
      expect(title?.type === 'text' && title.paragraphs[0]!.runs[0]!.color).toBe('#F5D200')
    }
  })

  it('ends the cover with a three-column metadata row aligned left, center and right', () => {
    expect(studio.styleSheet).toMatch(/aligned left, center and right/)
    const row = studio.sampleCover.en.elements.filter((el) => el.type === 'text' && el.y === 620)
    expect(
      row.map((el) => (el.type === 'text' ? (el.paragraphs[0]!.align ?? 'left') : '')),
    ).toEqual(['left', 'center', 'right'])
  })
})

describe.each([
  ['signal', signal, '#C8A870', 'Gold phrase'],
  ['grove', grove, '#C8524A', 'Coral phrase'],
] as const)('%s', (_id, t, accent, device) => {
  it('sets one phrase of the cover title in the accent, italic only in Latin', () => {
    expect(t.styleSheet).toContain(`- ${device}: `)
    for (const [lang, spec] of Object.entries(t.sampleCover)) {
      const accented = spec.elements
        .flatMap((el) => (el.type === 'text' ? el.paragraphs.flatMap((p) => p.runs) : []))
        .filter((r) => r.color === accent && (r.sizePt ?? 0) >= 40 && !/^[\d.,%]+$/.test(r.text))
      expect(accented, lang).toHaveLength(1)
      expect(Boolean(accented[0]!.italic), lang).toBe(lang === 'en')
    }
  })
})

describe('grove', () => {
  it('draws the watermark numeral in a solid tone clear of all other text', () => {
    expect(grove.styleSheet).toMatch(
      /- Watermark numeral: .* in solid #243525 .*never under other text/,
    )
    expect(grove.styleSheet).toMatch(/never bold/)
    for (const run of coverRuns(grove)) expect(run.bold).toBeUndefined()
  })
})
