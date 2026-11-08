/**
 * Design templates, batch A: blue-professional, monochrome, neo-grid-bold and
 * block-frame. Each one must pass the template validator with no problem and
 * carry the style-sheet sections and layout variants the page generator reads.
 */
import { describe, expect, it } from 'vitest'
import { validateSlideTemplate } from '../src/slides/template-check'
import { blockFrame } from '../src/slides/templates/block-frame'
import { blueProfessional } from '../src/slides/templates/blue-professional'
import {
  SLIDE_TEMPLATE_FONTS,
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_SOURCE_REPO,
  SLIDE_TEMPLATE_STYLE_MAX_CHARS,
  type SlideTemplate,
} from '../src/slides/templates/contract'
import { monochrome } from '../src/slides/templates/monochrome'
import { neoGridBold } from '../src/slides/templates/neo-grid-bold'

/** id, name and scheme from the fixed list, with the template module. */
const BATCH: [string, string, string, SlideTemplate][] = [
  ['blue-professional', 'Blue Professional', 'light', blueProfessional],
  ['monochrome', 'Monochrome', 'light', monochrome],
  ['neo-grid-bold', 'Neo-Grid Bold', 'light', neoGridBold],
  ['block-frame', 'BlockFrame', 'light', blockFrame],
]

describe.each(BATCH)('%s', (id, name, scheme, template) => {
  it('passes the template validator with no problem', async () => {
    expect(await validateSlideTemplate(template)).toEqual([])
  })

  it('matches its fixed list entry and the pinned upstream source', () => {
    expect([template.id, template.name, template.scheme]).toEqual([id, name, scheme])
    expect(template.source).toEqual({
      repo: SLIDE_TEMPLATE_SOURCE_REPO,
      commit: SLIDE_TEMPLATE_SOURCE_COMMIT,
      path: `bold-template-pack/templates/${id}`,
    })
    for (const font of Object.values(template.fonts)) expect(SLIDE_TEMPLATE_FONTS).toContain(font)
    expect(template.styleSheet.length).toBeLessThanOrEqual(SLIDE_TEMPLATE_STYLE_MAX_CHARS)
  })

  it('names its page types, colors, fonts, layouts and devices in the style sheet', () => {
    for (const heading of ['Backgrounds', 'Colors', 'Fonts', 'Layout library', 'Signature devices'])
      expect(template.styleSheet).toContain(`${heading}:`)
    expect(template.styleSheet).toContain('Overall style:')
    for (const type of ['cover', 'content', 'data', 'closing']) {
      // at least two layout variants per page type
      expect(template.styleSheet).toMatch(new RegExp(`- ${type}: \\w+ .*, \\w+`))
      expect(template.styleSheet).toMatch(new RegExp(`${type}: `))
    }
    for (const role of [
      'main text',
      'primary accent',
      'secondary accent',
      'card background',
      'border',
    ])
      expect(template.styleSheet).toContain(role)
    expect(template.styleSheet).toMatch(/Korean title /)
    expect(template.styleSheet).toMatch(/\d+-\d+pt/)
  })

  it('writes every cover text run as a solid six-digit palette color in one of its fonts', () => {
    const fonts = new Set(Object.values(template.fonts))
    for (const spec of Object.values(template.sampleCover)) {
      for (const el of spec.elements) {
        expect(el.type).not.toBe('image')
        if (el.type === 'image') continue
        for (const p of el.paragraphs ?? [])
          for (const r of p.runs) {
            expect(r.color).toMatch(/^#[0-9A-F]{6}$/)
            expect(fonts.has(r.font ?? '')).toBe(true)
          }
      }
    }
  })
})

describe('template-specific devices', () => {
  it('blue-professional keeps cobalt as its only hue and tints cards instead of framing them', () => {
    expect(blueProfessional.palette).toEqual([
      '#FDFAE7',
      '#1E2BFA',
      '#111111',
      '#6B6B6B',
      '#9A9A9A',
    ])
    expect(blueProfessional.styleSheet).toMatch(/never a second hue/)
    expect(blueProfessional.styleSheet).toMatch(
      /- Tinted card: a roundRect filled #1E2BFA at 4% opacity/,
    )
    expect(blueProfessional.styleSheet).toMatch(/Headlines are never #1E2BFA/)
  })

  it('monochrome has no hue at all: every palette color is a near-neutral cream or graphite', () => {
    for (const color of monochrome.palette) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
      expect(Math.max(r!, g!, b!) - Math.min(r!, g!, b!)).toBeLessThanOrEqual(40)
    }
    expect(monochrome.styleSheet).toMatch(/there is no hue/)
    expect(monochrome.styleSheet).toMatch(/- Short rule: a 36x1px #1A1A16 rect/)
    expect(monochrome.styleSheet).toMatch(/- Ledger cell: a 1px #1A1A16 rule on top/)
  })

  it('neo-grid-bold lays its cover panels on the 12 x 8 grid and keeps lemon off light text', () => {
    expect(neoGridBold.styleSheet).toMatch(/12 columns x 8 rows inside a 26px frame/)
    expect(neoGridBold.styleSheet).toMatch(/never text on a light panel/)
    const cols = new Set(Array.from({ length: 12 }, (_, c) => 26 + 103 * c))
    const rows = new Set(Array.from({ length: 8 }, (_, r) => 24 + 85 * r))
    for (const spec of Object.values(neoGridBold.sampleCover)) {
      const panels = spec.elements.filter((el) => el.type === 'shape' && el.w >= 300 && el.h >= 200)
      expect(panels.length).toBeGreaterThanOrEqual(4)
      for (const p of panels) {
        expect(cols.has(p.x)).toBe(true)
        expect(rows.has(p.y)).toBe(true)
        expect((p.w + 8) % 103).toBe(0)
        expect((p.h + 8) % 85).toBe(0)
      }
    }
  })

  it('block-frame lifts each framed card with a black block offset down and right', () => {
    expect(blockFrame.styleSheet).toMatch(
      /- Offset block: a solid #000000 rect the size of the card/,
    )
    for (const spec of Object.values(blockFrame.sampleCover)) {
      const framed = spec.elements.filter(
        (el) => el.type === 'shape' && el.shape === 'rect' && el.stroke?.color === '#000000',
      )
      expect(framed.length).toBeGreaterThanOrEqual(5)
      for (const card of framed) {
        if (card.type !== 'shape') continue
        const block = spec.elements[spec.elements.indexOf(card) - 1]
        expect(block).toMatchObject({ type: 'shape', fill: '#000000', w: card.w, h: card.h })
        expect([4, 8]).toContain(block!.x - card.x)
        expect(block!.y - card.y).toBe(block!.x - card.x)
      }
    }
  })
})
