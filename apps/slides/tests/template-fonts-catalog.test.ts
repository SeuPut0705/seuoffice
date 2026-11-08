/**
 * The built-in templates may only name fonts the app ships: the template
 * catalog (pipelines) and the bundled font set (ui) are checked against each
 * other here, the one place that sees both packages.
 */
import { describe, expect, it } from 'vitest'
import { listSlideTemplates, SLIDE_TEMPLATE_FONTS } from '@genoffice/pipelines/slides/templates'
import { TEMPLATE_FONTS, TEMPLATE_FONT_FAMILY_NAMES } from '@genoffice/ui/template-fonts'

const bundled = new Map(TEMPLATE_FONTS.map((f) => [f.family, f]))

/** True when the family ships a face of at least this weight (a variable file covers its range). */
function hasWeight(family: string, weight: number): boolean {
  const f = bundled.get(family)
  if (!f) return false
  return f.faces.some((face) => face.weight >= weight || (face.variableWeight?.max ?? 0) >= weight)
}

/** Single-weight display families: their one face is the heavy one, bold adds nothing. */
const DISPLAY_ONLY = new Set(
  TEMPLATE_FONTS.filter((f) => f.faces.length === 1 && !f.faces[0]!.variableWeight).map(
    (f) => f.family,
  ),
)

describe('template fonts against the bundled font set', () => {
  it('the template contract names exactly the bundled families', () => {
    expect([...SLIDE_TEMPLATE_FONTS].sort()).toEqual([...TEMPLATE_FONT_FAMILY_NAMES].sort())
  })

  it('every template names only bundled families', () => {
    for (const t of listSlideTemplates()) {
      const named = [t.fonts.title, t.fonts.body, t.fonts.latinTitle].filter(
        (f): f is string => !!f,
      )
      for (const family of named) expect(bundled.has(family), `${t.id}: ${family}`).toBe(true)
    }
  })

  it('bold runs on the sample covers use a family that ships a bold face', () => {
    const misses: string[] = []
    for (const t of listSlideTemplates()) {
      for (const [lang, page] of Object.entries(t.sampleCover)) {
        for (const el of page.elements) {
          const paragraphs = 'paragraphs' in el ? (el.paragraphs ?? []) : []
          for (const p of paragraphs) {
            for (const r of p.runs) {
              if (!r.bold || !r.font || DISPLAY_ONLY.has(r.font)) continue
              if (!hasWeight(r.font, 600)) misses.push(`${t.id}/${lang}: ${r.font}`)
            }
          }
        }
      }
    }
    expect(misses).toEqual([])
  })
})
