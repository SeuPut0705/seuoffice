/**
 * The design templates' shared font set in the PowerPoint editor: the folder comes from
 * templateFontsDir, every bundled face resolves to its own file (no substitute), the picker
 * lists the families the OS enumeration cannot see, and nothing is written into the folder.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as opentype from 'opentype.js'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { RunStyle } from '@genoffice/pptx-render'
import { templateFontsDir } from '@genoffice/electron-utils/template-fonts-dir'
import { TEMPLATE_FONTS, TEMPLATE_FONT_FAMILY_NAMES } from '@genoffice/ui/template-fonts'
import { BUILTIN_FONT_FAMILIES } from '@genoffice/ui'

/** apps/slides, the app path of a standalone dev run (the shell's apps/shell resolves the same) */
const APP_PATH = resolve(__dirname, '..')

const electronApp = vi.hoisted(() => ({
  isPackaged: false,
  getAppPath: (): string => '',
  getPath: (): string => '',
}))
vi.mock('electron', () => ({ app: electronApp }))

// Hermetic: no system, user-store or Office cloud font may answer for a bundled family (this
// machine may well have Pretendard installed), so every directory scan comes back empty.
vi.mock('../src/main/font-scan', () => ({
  scanFontDirs: (tasks: Array<{ kind: 'flat' | 'cloud' }>) =>
    tasks.map((t) =>
      t.kind === 'flat' ? { kind: 'flat', files: [] } : { kind: 'cloud', roots: [] },
    ),
}))

vi.mock('../src/main/shaped-metrics', () => ({
  initShapedMetrics: () => {},
  shapedMeasure: () => null,
  shapedFamily: () => null,
  gtMeasure: () => null,
  complexScriptOf: () => null,
}))

import {
  createSystemFontMetrics,
  familyAvailable,
  getPrivateFontData,
  getTemplateFontDir,
  listPrivateFontFaces,
  resetFontRegistry,
} from '../src/main/fonts'
import { initTemplateFonts, templateFontFolder } from '../src/main/template-fonts'
import { pickerFontSections } from '../src/renderer/system-fonts'

const FOLDER = resolve(APP_PATH, '../../packages/ui/template-fonts')

const style = (fontFamily: string, over: Partial<RunStyle> = {}): RunStyle => ({
  fontFamily,
  fontSizePx: 100,
  bold: false,
  italic: false,
  ...over,
})

/** name, size and mtime of everything in the folder */
function snapshot(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .map((name) => {
      const s = statSync(join(dir, name))
      return `${name}|${s.size}|${s.mtimeMs}`
    })
}

const sameBytes = (a: ArrayBuffer | null, file: string): boolean =>
  !!a && Buffer.from(a).equals(readFileSync(join(FOLDER, file)))

let before: string[]
beforeAll(() => {
  electronApp.getAppPath = () => APP_PATH
  before = snapshot(FOLDER)
})

describe('where the bundled font set is read from', () => {
  it('a dev run reads the checkout folder through templateFontsDir', () => {
    electronApp.isPackaged = false
    expect(templateFontFolder()).toBe(
      templateFontsDir({ isPackaged: false, getAppPath: () => APP_PATH, resourcesPath: '' }),
    )
    expect(templateFontFolder()).toBe(FOLDER)
  })

  it('the installed app reads the one copy under its resources', () => {
    const had = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
    Object.defineProperty(process, 'resourcesPath', {
      value: 'X:\\app\\resources',
      configurable: true,
    })
    electronApp.isPackaged = true
    try {
      expect(templateFontFolder()).toBe(join('X:\\app\\resources', 'template-fonts'))
    } finally {
      electronApp.isPackaged = false
      if (had) Object.defineProperty(process, 'resourcesPath', had)
      else delete (process as { resourcesPath?: string }).resourcesPath
    }
  })

  it('startup hands that folder to the font registry', () => {
    initTemplateFonts()
    resetFontRegistry()
    expect(getTemplateFontDir()).toBe(FOLDER)
  })
})

describe('each bundled face resolves to its own file', () => {
  const m = createSystemFontMetrics()

  /** the private face the layout registered for this request, with the bytes it serves */
  const served = (family: string, bold: boolean) => {
    m.displayFamily!(style(family, { bold }))
    const ids = listPrivateFontFaces().filter((f) => f.family === family)
    const face = ids.find((f) => f.bold === bold) ?? ids.find((f) => !f.bold && !f.italic)
    return face ? { face, bytes: getPrivateFontData(face.id) } : undefined
  }

  for (const fam of TEMPLATE_FONTS) {
    for (const face of fam.faces) {
      const bold = face.weight >= 700
      it(`${fam.family}${bold ? ' bold' : ''} → ${face.file}`, () => {
        expect(familyAvailable(fam.family)).toBe(true)
        expect(m.substituted!(style(fam.family, { bold }))).toBe(false)
        expect(m.displayFamily!(style(fam.family, { bold }))).toBe(fam.family)
        const hit = served(fam.family, bold)
        expect(hit).toBeDefined()
        expect(sameBytes(hit!.bytes, face.file)).toBe(true)
      })
    }
  }

  it('Pretendard draws its Regular and Bold files, nothing in between', () => {
    const weightOf = (bytes: ArrayBuffer | null | undefined) =>
      (opentype.parse(bytes!) as unknown as { tables: { os2: { usWeightClass: number } } }).tables
        .os2.usWeightClass
    expect(weightOf(served('Pretendard', false)!.bytes)).toBe(400)
    expect(weightOf(served('Pretendard', true)!.bytes)).toBe(700)
  })

  it('a family that ships only a Bold file draws plain runs with it (Space Grotesk)', () => {
    const hit = served('Space Grotesk', false)
    expect(sameBytes(hit!.bytes, 'SpaceGrotesk-Bold.ttf')).toBe(true)
  })

  it('a family without a Bold file keeps the Regular face for bold runs (Gowun Dodum)', () => {
    m.displayFamily!(style('Gowun Dodum', { bold: true }))
    const faces = listPrivateFontFaces().filter((f) => f.family === 'Gowun Dodum')
    // only the regular face: Chromium synthesizes the bold
    expect(faces.map((f) => f.bold)).toEqual([false])
    expect(sameBytes(getPrivateFontData(faces[0]!.id), 'GowunDodum-Regular.ttf')).toBe(true)
  })

  it("Playfair Display's variable file (bracketed name) serves its whole weight range", () => {
    m.displayFamily!(style('Playfair Display', { bold: true }))
    const faces = listPrivateFontFaces().filter((f) => f.family === 'Playfair Display')
    expect(faces.length).toBeGreaterThan(0)
    for (const f of faces) {
      expect(sameBytes(getPrivateFontData(f.id), 'PlayfairDisplay[wght].ttf')).toBe(true)
      expect(f.weight).toBe('400 900')
    }
    // static faces keep the bold flag's weight
    expect(listPrivateFontFaces().find((f) => f.family === 'Pretendard')?.weight).toBeUndefined()
  })

  it('measures with the bundled face metrics, not a substitute', () => {
    for (const fam of TEMPLATE_FONTS) {
      const face = fam.faces[0]!
      const font = opentype.parse(readFileSync(join(FOLDER, face.file)).buffer as ArrayBuffer)
      const ch = fam.script === 'korean' ? '가' : 'H'
      const expected = (font.charToGlyph(ch).advanceWidth! / font.unitsPerEm) * 100
      const bold = face.weight >= 700
      expect(m.measure(ch, style(fam.family, { bold })), fam.family).toBeCloseTo(expected, 3)
    }
  })

  it('characters a Latin face lacks keep the script fallback (Hangul in Bebas Neue)', () => {
    const ko = style('Bebas Neue', { substScript: 'ko' })
    expect(m.displayFamily!(ko, 'H')).toBe('Bebas Neue')
    expect(m.displayFamily!(ko, '가')).toBe('Malgun Gothic')
  })
})

describe('the slides font picker', () => {
  it('lists every bundled family even when the OS enumeration does not report it', () => {
    const { builtin } = pickerFontSections(BUILTIN_FONT_FAMILIES, ['Arial', 'Malgun Gothic'])
    for (const family of TEMPLATE_FONT_FAMILY_NAMES) expect(builtin).toContain(family)
    expect(builtin).toContain('Arial')
    // still a real gate: an absent non-bundled candidate stays hidden
    expect(builtin).not.toContain('Garamond')
  })
})

describe('the folder is a read-only source', () => {
  it('resolving, measuring and serving every face left it untouched', () => {
    expect(snapshot(FOLDER)).toEqual(before)
  })
})
