/**
 * Design templates, batch C: editorial-tri-tone, emerald-editorial and vellum.
 * Each module is imported directly (the catalog wires them in later) and must
 * pass the template validator with no problems.
 */
import { describe, expect, it } from 'vitest'
import type { PageSpec } from '../src/slides/page-spec'
import { validateSlideTemplate } from '../src/slides/template-check'
import {
  SLIDE_TEMPLATE_FONTS,
  SLIDE_TEMPLATE_ID_PATTERN,
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_STYLE_MAX_CHARS,
  type SlideTemplate,
  type SlideTemplateScheme,
} from '../src/slides/templates/contract'
import { editorialTriTone } from '../src/slides/templates/editorial-tri-tone'
import { emeraldEditorial } from '../src/slides/templates/emerald-editorial'
import { vellum } from '../src/slides/templates/vellum'

/** Each template with its fixed id, name and scheme from the template list. */
const BATCH: [string, SlideTemplate, string, SlideTemplateScheme][] = [
  ['editorial-tri-tone', editorialTriTone, 'Editorial Tri-Tone', 'mixed'],
  ['emerald-editorial', emeraldEditorial, 'Emerald Editorial', 'mixed'],
  ['vellum', vellum, 'Vellum', 'dark'],
]

const PAGE_TYPES = ['cover', 'content', 'data', 'closing'] as const

/** Layout names listed for one page type: the `- type: a (...), b (...)` line of the library. */
function layoutsOf(styleSheet: string, type: string): string[] {
  const line = styleSheet.split('\n').find((l) => l.startsWith(`- ${type}: `)) ?? ''
  // Names sit at the top level of the line, outside the parenthesized descriptions.
  let depth = 0
  let top = ''
  for (const c of line.slice(`- ${type}: `.length)) {
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (depth === 0) top += c
  }
  return top
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function runs(spec: PageSpec) {
  return spec.elements.flatMap((el) =>
    el.type === 'image' ? [] : (el.paragraphs ?? []).flatMap((p) => p.runs),
  )
}

describe.each(BATCH)('%s', (id, template, name, scheme) => {
  // Building and auditing both covers takes a second or two; give it room on a busy machine.
  it('passes the template validator with no problems', { timeout: 30_000 }, async () => {
    expect(await validateSlideTemplate(template)).toEqual([])
  })

  it('carries its fixed id, name and scheme, bundled fonts and the pinned source', () => {
    expect([template.id, template.name, template.scheme]).toEqual([id, name, scheme])
    expect(template.id).toMatch(SLIDE_TEMPLATE_ID_PATTERN)
    for (const font of Object.values(template.fonts)) expect(SLIDE_TEMPLATE_FONTS).toContain(font)
    expect(template.styleSheet.length).toBeLessThanOrEqual(SLIDE_TEMPLATE_STYLE_MAX_CHARS)
    expect(template.source.commit).toBe(SLIDE_TEMPLATE_SOURCE_COMMIT)
    expect(template.source.path).toBe(`bold-template-pack/templates/${id}`)
  })

  it('names its sections and at least two layout variants per page type', () => {
    for (const heading of ['Backgrounds', 'Colors', 'Fonts', 'Layout library', 'Signature devices'])
      expect(template.styleSheet).toContain(`${heading}:`)
    expect(template.styleSheet).toContain('Overall style:')
    for (const type of PAGE_TYPES) {
      const layouts = layoutsOf(template.styleSheet, type)
      expect(layouts.length, type).toBeGreaterThanOrEqual(2)
      for (const layout of layouts) expect(layout).toMatch(/^[a-z_]+$/)
    }
  })

  it('keeps every cover text run in a solid six-digit color and a named font', () => {
    for (const spec of Object.values(template.sampleCover)) {
      for (const r of runs(spec)) {
        expect(r.color).toMatch(/^#[0-9A-F]{6}$/)
        expect(r.font).toBeTruthy()
      }
    }
  })
})

describe('editorial-tri-tone', () => {
  it('leads with grotesque titles, as upstream does, and no serif', () => {
    expect(editorialTriTone.fonts).toEqual({
      title: 'Pretendard',
      body: 'Pretendard',
      latinTitle: 'Space Grotesk',
    })
    expect(editorialTriTone.styleSheet).not.toMatch(/italic/i)
  })

  it('marks title emphasis by weight: a heavy line, then a regular-weight phrase', () => {
    expect(editorialTriTone.styleSheet).toMatch(/- Emphasis: .*heavy to regular weight/)
    for (const spec of Object.values(editorialTriTone.sampleCover)) {
      const title = spec.elements.find(
        (el) =>
          el.type === 'text' && el.paragraphs.some((p) => p.runs.some((r) => r.sizePt === 44)),
      )
      if (title?.type !== 'text') throw new Error('no title box on the cover')
      const [heavy, emphasis] = title.paragraphs.map((p) => p.runs[0]!)
      expect(heavy!.bold).toBe(true)
      expect(emphasis!.bold).toBeUndefined()
      expect(emphasis!.color).toBe(heavy!.color)
      for (const r of runs(spec)) expect(r.italic).toBeUndefined()
    }
  })

  it('stays inside its three inks', () => {
    expect(editorialTriTone.palette).toEqual(['#F2B6C6', '#F2D86A', '#7A1F35'])
    expect(editorialTriTone.styleSheet).toMatch(/never white, gray or black/)
  })

  it('opens pages with a section marker and uses roundRect pills', () => {
    expect(editorialTriTone.styleSheet).toMatch(/- Section marker: .*"§ 01 — Title"/)
    expect(editorialTriTone.styleSheet).toMatch(/- Pill: a roundRect/)
    for (const spec of Object.values(editorialTriTone.sampleCover)) {
      const pills = spec.elements.filter((el) => el.type === 'shape' && el.shape === 'roundRect')
      expect(pills).toHaveLength(3)
    }
  })
})

describe('emerald-editorial', () => {
  it('draws the double-rule ornament as two stacked 4px rules on each side', () => {
    expect(emeraldEditorial.styleSheet).toMatch(/- Double-rule ornament: .*two stacked 4px/)
    for (const spec of Object.values(emeraldEditorial.sampleCover)) {
      const rules = spec.elements.filter(
        (el) => el.type === 'shape' && el.shape === 'rect' && el.h === 4 && el.w === 220,
      )
      expect(rules).toHaveLength(4)
      const left = rules.filter((el) => el.x < 640)
      const right = rules.filter((el) => el.x > 640)
      expect(left.map((el) => el.y)).toEqual(right.map((el) => el.y))
      expect(left[1]!.y - left[0]!.y).toBe(7)
    }
  })

  it('keeps square corners on every cover shape', () => {
    expect(emeraldEditorial.styleSheet).toMatch(/Square corners on every shape/)
    for (const spec of Object.values(emeraldEditorial.sampleCover)) {
      for (const el of spec.elements) if (el.type === 'shape') expect(el.shape).toBe('rect')
    }
  })
})

describe('vellum', () => {
  it('uses one field for every page type and a teal pin-note on every page', () => {
    expect(vellum.styleSheet).toMatch(/cover, content, data and closing are all #2A3870/)
    expect(vellum.styleSheet).toMatch(/- Pin-note: every page carries .*#3A7878/)
    for (const spec of Object.values(vellum.sampleCover)) {
      expect(spec.background).toBe('#2A3870')
      const pin = spec.elements.at(-1)!
      expect(pin.type).toBe('text')
      expect(pin.x).toBeLessThan(160)
      expect(pin.y).toBeGreaterThan(560)
      if (pin.type === 'text') {
        for (const p of pin.paragraphs) for (const r of p.runs) expect(r.color).toBe('#3A7878')
      }
    }
  })

  it('centers the cover title and sets its emphasis upright in the bright yellow', () => {
    for (const spec of Object.values(vellum.sampleCover)) {
      const title = spec.elements.find(
        (el) =>
          el.type === 'text' && el.paragraphs.some((p) => p.runs.some((r) => r.sizePt === 46)),
      )
      expect(title?.type).toBe('text')
      if (title?.type !== 'text') continue
      for (const p of title.paragraphs) expect(p.align).toBe('center')
      const emphasis = title.paragraphs.flatMap((p) => p.runs).filter((r) => r.bold)
      expect(emphasis).toHaveLength(1)
      expect(emphasis[0]!.color).toBe('#F5E168')
      expect(emphasis[0]!.italic).toBeUndefined()
    }
  })
})
