import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import * as opentype from 'opentype.js'
import type { RunStyle } from '@genoffice/pptx-render'

vi.mock('../src/main/shaped-metrics', () => ({
  initShapedMetrics: () => {},
  shapedMeasure: () => null,
  shapedFamily: () => null,
  gtMeasure: () => null,
  complexScriptOf: () => null,
}))

import {
  createSystemFontMetrics,
  getPrivateFontData,
  listPrivateFontFaces,
  registerEmbeddedFonts,
} from '../src/main/fonts'

const style = (fontFamily: string, over: Partial<RunStyle> = {}): RunStyle => ({
  fontFamily,
  fontSizePx: 100,
  bold: false,
  italic: false,
  ...over,
})

describe('document-embedded fonts', () => {
  it('a bold-only embed serves plain runs too (PowerPoint draws the only embedded face)', () => {
    const sfnt = new Uint8Array(
      readFileSync(join(__dirname, '../../docs/src/renderer/fonts/Caladea-Bold.ttf')),
    )
    expect(registerEmbeddedFonts([{ typeface: 'Zz Embed Bold Only', style: 'bold', sfnt }])).toBe(
      true,
    )
    const m = createSystemFontMetrics()
    expect(m.displayFamily!(style('Zz Embed Bold Only'))).toMatch(/Caladea/)
    expect(m.measure('MMMM', style('Zz Embed Bold Only'))).toBe(
      m.measure('MMMM', style('Zz Embed Bold Only', { bold: true })),
    )
  })
})

/** A real sfnt whose own family name is `familyName` (name 1), at an OS/2 weight. */
function weightedFont(familyName: string, styleName: string, weightClass: number, adv: number) {
  const box = new opentype.Path()
  box.moveTo(100, 0)
  box.lineTo(100, 700)
  box.lineTo(adv - 100, 700)
  box.lineTo(adv - 100, 0)
  box.close()
  const font = new opentype.Font({
    familyName,
    styleName,
    // Typed as a string, but opentype.js writes it straight into OS/2 usWeightClass
    weightClass: weightClass as unknown as string,
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [
      new opentype.Glyph({
        name: '.notdef',
        unicode: 0,
        advanceWidth: 600,
        path: new opentype.Path(),
      }),
      new opentype.Glyph({
        name: 'space',
        unicode: 32,
        advanceWidth: 250,
        path: new opentype.Path(),
      }),
      new opentype.Glyph({ name: 'A', unicode: 65, advanceWidth: adv, path: box }),
    ],
  })
  return new Uint8Array(font.toArrayBuffer())
}

describe('"Family Bold" typefaces draw with the face they were measured with', () => {
  // A Bold file listed under its own GDI family ("나눔스퀘어 Bold") whose name records carry
  // the base family: Chromium resolves neither spelling to that face (its weight-suffix
  // lookup skips " bold"), so the face must reach the canvas as a FontFace under the
  // requested name — and must not take the base family's slot from the sibling Regular.
  it('an embedded Bold face registers under the requested name, beside its Regular sibling', () => {
    registerEmbeddedFonts([
      {
        typeface: 'Ieum Probe Square',
        style: 'regular',
        sfnt: weightedFont('Ieum Probe Square', 'Regular', 400, 600),
      },
      {
        typeface: 'Ieum Probe Square Bold',
        style: 'bold',
        sfnt: weightedFont('Ieum Probe Square', 'Bold', 700, 700),
      },
    ])
    const m = createSystemFontMetrics()
    // Regular first, so a later Bold-face registration that lands on its slot shows
    expect(m.displayFamily!(style('Ieum Probe Square'))).toBe('Ieum Probe Square')
    for (const over of [{}, { bold: true }, { italic: true }, { bold: true, italic: true }])
      expect(m.displayFamily!(style('Ieum Probe Square Bold', over))).toBe('Ieum Probe Square Bold')
    expect(m.measure('A', style('Ieum Probe Square Bold'))).toBe(70)
    expect(m.measure('A', style('Ieum Probe Square'))).toBe(60)
    expect(weightOf('Ieum Probe Square|00')).toBe(400)
    expect(weightOf('Ieum Probe Square Bold|00')).toBe(700)
    expect(weightOf('Ieum Probe Square Bold|10')).toBe(700)
    // The upright face serves the italic runs undeclared, so Chromium slants it
    expect(faceIds('Ieum Probe Square Bold')).toEqual([
      'Ieum Probe Square Bold|00',
      'Ieum Probe Square Bold|10',
    ])
  })

  it('a "Bold" name landing on a Regular-weight face keeps the face its own name', () => {
    registerEmbeddedFonts([
      {
        typeface: 'Ieum Probe Plain Bold',
        style: 'regular',
        sfnt: weightedFont('Ieum Probe Plain', 'Regular', 400, 600),
      },
    ])
    const m = createSystemFontMetrics()
    expect(m.displayFamily!(style('Ieum Probe Plain Bold'))).toBe('Ieum Probe Plain')
  })

  const nanumBold = 'C:\\Windows\\Fonts\\NanumSquareB.ttf'
  it.runIf(process.platform === 'win32' && existsSync(nanumBold))(
    'installed 나눔스퀘어 Bold is served to the canvas (Windows with NanumSquare installed)',
    () => {
      const m = createSystemFontMetrics()
      for (const over of [{}, { bold: true }, { italic: true }])
        expect(m.displayFamily!(style('나눔스퀘어 Bold', over))).toBe('나눔스퀘어 Bold')
      expect(weightOf('나눔스퀘어 Bold|00')).toBe(700)
      expect(weightOf('나눔스퀘어 Bold|10')).toBe(700)
      // No italic face exists: declaring the upright one italic would draw it unslanted
      expect(faceIds('나눔스퀘어 Bold')).toEqual(['나눔스퀘어 Bold|00', '나눔스퀘어 Bold|10'])
    },
  )
})

/** OS/2 weight of the bytes served for a registered private face. */
function weightOf(id: string): number {
  expect(faceIds(id.split('|')[0]!)).toContain(id)
  return opentype.parse(getPrivateFontData(id)!).tables.os2.usWeightClass
}

function faceIds(family: string): string[] {
  return listPrivateFontFaces()
    .filter((f) => f.family === family)
    .map((f) => f.id)
    .sort()
}

describe('alias families split by weight across files', () => {
  const office = existsSync('/Applications/Microsoft PowerPoint.app/Contents/Resources/DFonts')
  it.runIf(process.platform === 'darwin' && office)(
    'Yu Gothic UI bold resolves to the Bold collection, registering a distinct bold face',
    () => {
      const m = createSystemFontMetrics()
      m.displayFamily!(style('Yu Gothic UI'))
      m.displayFamily!(style('Yu Gothic UI', { bold: true }))
      const ids = listPrivateFontFaces().map((f) => f.id)
      expect(ids).toContain('Yu Gothic UI|00')
      expect(ids).toContain('Yu Gothic UI|10')
    },
  )
})
