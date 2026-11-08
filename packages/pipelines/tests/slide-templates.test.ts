/**
 * The built-in design templates as the renderer sees them: the list, the
 * lookup, and the guarantee that this entry never loads Node-only code.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  findSlideTemplate,
  listSlideTemplates,
  SLIDE_TEMPLATE_FONTS,
  SLIDE_TEMPLATE_ID_PATTERN,
  SLIDE_TEMPLATE_SOURCE_COMMIT,
  SLIDE_TEMPLATE_STYLE_MAX_CHARS,
} from '../src/slides/templates/index'

const loaded = vi.hoisted(() => [] as string[])
vi.mock('@genoffice/pptx-engine', () => {
  loaded.push('pptx-engine')
  return {}
})
vi.mock('@genoffice/pptx-render', () => {
  loaded.push('pptx-render')
  return {}
})

const here = dirname(fileURLToPath(import.meta.url))
const ENTRY = resolve(here, '../src/slides/templates/index.ts')

/** The fixed list: id, name and scheme in display order. */
const ROSTER = [
  ['coral', 'Coral', 'mixed'],
  ['blue-professional', 'Blue Professional', 'light'],
  ['monochrome', 'Monochrome', 'light'],
  ['neo-grid-bold', 'Neo-Grid Bold', 'light'],
  ['block-frame', 'BlockFrame', 'light'],
  ['raw-grid', 'Raw Grid', 'light'],
  ['studio', 'Studio', 'dark'],
  ['signal', 'Signal', 'mixed'],
  ['grove', 'Grove', 'mixed'],
  ['editorial-tri-tone', 'Editorial Tri-Tone', 'mixed'],
  ['emerald-editorial', 'Emerald Editorial', 'mixed'],
  ['vellum', 'Vellum', 'dark'],
] as const

describe('listSlideTemplates', () => {
  it('lists exactly the fixed templates in display order, each with its fixed name and scheme', () => {
    const list = listSlideTemplates()
    expect(list.map((t) => [t.id, t.name, t.scheme])).toEqual(ROSTER.map((row) => [...row]))
    expect(new Set(list.map((t) => t.id)).size).toBe(list.length)
  })

  it('returns the same list every time', () => {
    expect(listSlideTemplates()).toBe(listSlideTemplates())
  })
})

describe('findSlideTemplate', () => {
  it('finds a template by id or by name, ignoring case and outer spaces', () => {
    const coral = listSlideTemplates()[0]!
    for (const key of ['coral', 'CORAL', 'Coral', '  coRAL  ']) {
      expect(findSlideTemplate(key)).toBe(coral)
    }
    for (const t of listSlideTemplates()) {
      expect(findSlideTemplate(t.id.toUpperCase())).toBe(t)
      expect(findSlideTemplate(t.name.toLowerCase())).toBe(t)
    }
  })

  it('returns undefined for an unknown or empty key', () => {
    expect(findSlideTemplate('no-such-template')).toBeUndefined()
    expect(findSlideTemplate('')).toBeUndefined()
    expect(findSlideTemplate('   ')).toBeUndefined()
  })
})

describe('coral', () => {
  const coral = findSlideTemplate('coral')!

  it('carries the fields of the contract', () => {
    expect(coral.id).toMatch(SLIDE_TEMPLATE_ID_PATTERN)
    expect(coral.fonts.latinTitle).toBe('Bebas Neue')
    expect(coral.fonts.body).toBe('Pretendard')
    for (const font of Object.values(coral.fonts)) expect(SLIDE_TEMPLATE_FONTS).toContain(font)
    expect(coral.styleSheet.length).toBeLessThanOrEqual(SLIDE_TEMPLATE_STYLE_MAX_CHARS)
    expect(coral.source.commit).toBe(SLIDE_TEMPLATE_SOURCE_COMMIT)
    expect(coral.source.path).toBe('bold-template-pack/templates/coral')
  })

  it('names its page types, colors, fonts, layouts and devices in the style sheet', () => {
    for (const heading of ['Backgrounds', 'Colors', 'Fonts', 'Layout library', 'Signature devices'])
      expect(coral.styleSheet).toContain(`${heading}:`)
    expect(coral.styleSheet).toContain('Overall style:')
    for (const type of ['cover', 'content', 'data', 'closing'])
      expect(coral.styleSheet).toMatch(new RegExp(`- ${type}: \\w+ .*, \\w+`))
  })

  it('keeps the bar on top of cards and the bar on the left of tiles', () => {
    expect(coral.styleSheet).toMatch(/bar along its top edge/)
    expect(coral.styleSheet).toMatch(/bar along its left edge/)
  })

  it('asks for opacity on a rect fill only, never on text', () => {
    // Text run colors are written without alpha, so a translucent numeral would land opaque.
    const translucent = coral.styleSheet
      .split(/\r?\n/)
      .filter((line) => /opacity|alpha|translucent|transparent/i.test(line))
    expect(translucent).toHaveLength(1)
    expect(translucent[0]).toMatch(/^- Divider: .* rect at 15% opacity/)
    expect(translucent[0]).toMatch(/text is always a solid color/)
    expect(coral.styleSheet).toMatch(/- Wallpaper numeral: .* numeral in solid #D44A4A /)
    for (const spec of Object.values(coral.sampleCover)) {
      for (const el of spec.elements) {
        if (el.type === 'image') continue
        for (const p of el.paragraphs ?? [])
          for (const r of p.runs) expect(r.color).toMatch(/^#[0-9A-F]{6}$/)
      }
    }
  })
})

/** Specifiers a module loads at run time; `import type` and `export type` lines are erased by the compiler. */
function valueImports(source: string): string[] {
  const out: string[] = []
  const statement =
    /^\s*(?:import|export)\s+(type\s+)?(?:\*\s*(?:as\s+\w+\s*)?|\w+\s*,?\s*)?(?:\{[^}]*\}\s*)?from\s*['"]([^'"]+)['"]/gm
  for (const m of source.matchAll(statement)) if (!m[1]) out.push(m[2]!)
  for (const m of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]!)
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]!)
  return out
}

function moduleFile(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier)
  const hit = [`${base}.ts`, resolve(base, 'index.ts'), base].find((f) => existsSync(f))
  if (!hit) throw new Error(`cannot resolve ${specifier} from ${from}`)
  return hit
}

describe('the renderer-safe templates entry', () => {
  it('reaches only files of its own folder and no package at all', () => {
    const folder = dirname(ENTRY)
    const seen = new Set<string>()
    const packages: string[] = []
    const queue = [ENTRY]
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const specifier of valueImports(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('.')) queue.push(moduleFile(file, specifier))
        else packages.push(`${specifier} (from ${file})`)
      }
    }
    expect(packages).toEqual([])
    expect([...seen].filter((file) => dirname(file) !== folder)).toEqual([])
    // the walk really followed the catalog down to a template file
    expect([...seen].some((file) => file.endsWith('coral.ts'))).toBe(true)
  })

  it('loads without pptx-engine or pptx-render, which the slides entry does pull in', async () => {
    expect(listSlideTemplates().length).toBeGreaterThan(0)
    expect(loaded).toEqual([])
    await import('../src/slides/index')
    expect(loaded).toContain('pptx-engine')
  })
})
