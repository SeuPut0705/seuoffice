/**
 * Families whose file names do not spell them resolve through the installed files' own name
 * tables (Times New Roman → times.ttf, A2Z 1 → 에이투지체-1Thin.otf), including the OS's
 * style-word-stripped spellings (a face declared "Paperlogy 1 Thin" is enumerated as
 * "Paperlogy 1", "Eras Bold ITC" as "Eras ITC"); a family no file declares still falls to
 * the substitute chain.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import * as opentype from 'opentype.js'

const store = mkdtempSync(join(tmpdir(), 'slides-font-family-'))

vi.mock('../src/main/shaped-metrics', () => ({
  initShapedMetrics: () => {},
  shapedMeasure: () => null,
  shapedFamily: () => null,
  gtMeasure: () => null,
  complexScriptOf: () => null,
}))

import {
  displayFamilyFor,
  familyAvailable,
  fvarInstanceNames,
  instanceFamilyKeys,
  resetFontRegistry,
  setUserFontDir,
} from '../src/main/fonts'

/** A real sfnt under a chosen family name (same helper as font-install-local). */
function fontBytes(familyName: string, styleName = 'Regular'): Buffer {
  const box = new opentype.Path()
  box.moveTo(100, 0)
  box.lineTo(100, 700)
  box.lineTo(500, 700)
  box.lineTo(500, 0)
  box.close()
  const font = new opentype.Font({
    familyName,
    styleName,
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
      new opentype.Glyph({ name: 'A', unicode: 65, advanceWidth: 600, path: box }),
    ],
  })
  return Buffer.from(font.toArrayBuffer())
}

beforeAll(() => {
  // File names that spell nothing like the families they carry (like a download folder or a
  // Korean font file name does).
  writeFileSync(join(store, 'font (3).ttf'), fontBytes('Ieum Probe Family'))
  writeFileSync(join(store, 'mystery-file.ttf'), fontBytes('Ieum Probe Paperlogy 1 Thin'))
  writeFileSync(join(store, 'another-file.ttf'), fontBytes('Ieum Probe Eras Bold ITC'))
  setUserFontDir(store)
  resetFontRegistry()
})

afterAll(() => {
  setUserFontDir('')
  resetFontRegistry()
  rmSync(store, { recursive: true, force: true })
})

describe('resolving installed families by their declared names', () => {
  it('finds a file whose name spells nothing like the family', () => {
    expect(familyAvailable('Ieum Probe Family')).toBe(true)
  })

  it('answers the OS style-word-stripped spelling of a face family', () => {
    // A trailing weight word is dropped by the OS's family enumeration
    expect(familyAvailable('Ieum Probe Paperlogy 1')).toBe(true)
    // …and the declared spelling itself still resolves
    expect(familyAvailable('Ieum Probe Paperlogy 1 Thin')).toBe(true)
    // The same for a style word inside the name ("Eras Bold ITC" → "Eras ITC")
    expect(familyAvailable('Ieum Probe Eras ITC')).toBe(true)
  })

  it('leaves a family no file declares to the substitute chain', () => {
    expect(familyAvailable('Ieum Probe Nowhere')).toBe(false)
  })
})

describe('variable-font named instances', () => {
  /** A minimal fvar table: one 20-byte axis and `names` instances of 8 bytes each. */
  function fvarTable(names: Array<string | undefined>): Buffer {
    const header = 16
    const axisSize = 20
    const instanceSize = 8
    const buf = Buffer.alloc(header + axisSize + names.length * instanceSize)
    buf.writeUInt16BE(1, 0) // majorVersion
    buf.writeUInt16BE(16, 4) // axesArrayOffset
    buf.writeUInt16BE(1, 8) // axisCount
    buf.writeUInt16BE(axisSize, 10)
    buf.writeUInt16BE(names.length, 12)
    buf.writeUInt16BE(instanceSize, 14)
    const base = header + axisSize
    names.forEach((_, i) => buf.writeUInt16BE(300 + i, base + i * instanceSize))
    return buf
  }

  it('reads the instance subfamily names of an fvar table', () => {
    const names = fvarTable(['Banner', 'Regular Display', undefined])
    expect(
      fvarInstanceNames(names, (id) =>
        id === 300 ? 'Banner' : id === 301 ? 'Regular Display' : undefined,
      ),
    ).toEqual(['Banner', 'Regular Display'])
  })

  it('turns an instance name into the family the OS enumerates', () => {
    // "Sitka" + "Banner Semibold" → the OS family "Sitka Banner"
    expect(instanceFamilyKeys('Sitka', 'Banner Semibold')).toContain('sitkabanner')
    // "Segoe UI Variable" + "Regular Display" → "Segoe UI Variable Display"
    expect(instanceFamilyKeys('Segoe UI Variable', 'Regular Display')).toContain(
      'segoeuivariabledisplay',
    )
    // A bare weight instance adds no family of its own
    expect(instanceFamilyKeys('Sitka', 'Regular')).toEqual([])
  })
})

describe('drawing family of a hit', () => {
  it('keeps the requested spelling when the face family only adds OS-dropped style words', () => {
    // RAGE.TTF declares "Rage Italic" but the OS enumerates "Rage"; CSS resolves "Rage" only
    expect(displayFamilyFor('Rage', 'Rage Italic')).toBe('Rage')
    expect(displayFamilyFor('Paperlogy 4', 'Paperlogy 4 Regular')).toBe('Paperlogy 4')
  })

  it('keeps the face family of an alias or same-name hit', () => {
    // Calibri resolves through the bundled Carlito face, served under its own name
    expect(displayFamilyFor('Calibri', 'Carlito')).toBe('Carlito')
    expect(displayFamilyFor('Times New Roman', 'Times New Roman')).toBe('Times New Roman')
  })
})
