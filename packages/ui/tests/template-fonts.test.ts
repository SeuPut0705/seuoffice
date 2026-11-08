// The one font set the design templates share: what the data list promises must be
// what the shipped folder holds, nothing more, and within the size budget.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { JAPANESE_FAMILIES, KOREAN_FAMILIES } from '@genoffice/i18n'
import { BUILTIN_FONT_FAMILIES, fontFamiliesFor, matchesFontQuery } from '../src/font-list'
import {
  TEMPLATE_FONTS,
  TEMPLATE_FONTS_MAX_BYTES,
  TEMPLATE_FONTS_README,
  TEMPLATE_FONT_FACE_REGISTRATIONS,
  TEMPLATE_FONT_FAMILY_NAMES,
  TEMPLATE_FONT_FILES,
  templateFontFileOf,
  templateFontUrl,
} from '../src/template-fonts'

const FOLDER = resolve(import.meta.dirname, '../template-fonts')
const fontFiles = TEMPLATE_FONTS.flatMap((f) => f.faces.map((face) => face.file))

describe('template font folder', () => {
  it('holds every listed font file', () => {
    for (const file of fontFiles) expect(statSync(join(FOLDER, file)).isFile(), file).toBe(true)
  })

  it('ships a license text for every family, and it is the OFL 1.1', () => {
    for (const family of TEMPLATE_FONTS) {
      expect(family.license).toBe('OFL-1.1')
      const text = readFileSync(join(FOLDER, family.licenseFile), 'utf8')
      expect(text, family.licenseFile).toContain('SIL OPEN FONT LICENSE Version 1.1')
    }
  })

  it('holds only the font files, their license texts and the readme', () => {
    const expected = new Set([
      ...fontFiles,
      ...TEMPLATE_FONTS.map((f) => f.licenseFile),
      TEMPLATE_FONTS_README,
    ])
    expect(new Set(readdirSync(FOLDER))).toEqual(expected)
  })

  it('has a readme naming every family, its license, distributor and version', () => {
    const readme = readFileSync(join(FOLDER, TEMPLATE_FONTS_README), 'utf8')
    for (const family of TEMPLATE_FONTS) {
      expect(readme).toContain(family.family)
      expect(readme).toContain(family.licenseFile)
      expect(readme).toContain(family.licenseUrl)
      expect(readme).toContain(family.distributorUrl)
      expect(readme).toContain(family.version)
      for (const face of family.faces) expect(readme).toContain(face.file)
    }
  })

  it('stays within the size budget', () => {
    const total = fontFiles.reduce((sum, file) => sum + statSync(join(FOLDER, file)).size, 0)
    expect(total).toBeLessThanOrEqual(TEMPLATE_FONTS_MAX_BYTES)
  })
})

describe('template font list', () => {
  it('lists each family once and each file once', () => {
    expect(new Set(TEMPLATE_FONT_FAMILY_NAMES).size).toBe(TEMPLATE_FONTS.length)
    expect(new Set(fontFiles.map((f) => f.toLowerCase())).size).toBe(fontFiles.length)
  })

  it('gives every Korean family a regular face', () => {
    for (const family of TEMPLATE_FONTS.filter((f) => f.script === 'korean')) {
      expect(
        family.faces.some((face) => face.weight === 400),
        family.family,
      ).toBe(true)
    }
  })

  it('records where and when each family was taken from', () => {
    for (const family of TEMPLATE_FONTS) {
      expect(family.distributorUrl).toMatch(/^https:\/\/github\.com\//)
      expect(family.sourceUrl).toMatch(/^https:\/\/github\.com\//)
      expect(family.licenseUrl).toMatch(/^https:\/\/github\.com\//)
      expect(family.downloaded).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('template font faces and URLs', () => {
  it('registers every face under its family, a variable file over its weight range', () => {
    expect(TEMPLATE_FONT_FACE_REGISTRATIONS).toHaveLength(fontFiles.length)
    expect(new Set(TEMPLATE_FONT_FACE_REGISTRATIONS.map((x) => x.family))).toEqual(
      new Set(TEMPLATE_FONT_FAMILY_NAMES),
    )
    expect(TEMPLATE_FONT_FACE_REGISTRATIONS.filter((x) => x.family === 'Pretendard')).toEqual([
      { family: 'Pretendard', file: 'Pretendard-Regular.otf', weight: '400' },
      { family: 'Pretendard', file: 'Pretendard-Bold.otf', weight: '700' },
    ])
    expect(TEMPLATE_FONT_FACE_REGISTRATIONS.filter((x) => x.family === 'Playfair Display')).toEqual(
      [{ family: 'Playfair Display', file: 'PlayfairDisplay[wght].ttf', weight: '400 900' }],
    )
    expect([...TEMPLATE_FONT_FILES].sort()).toEqual([...fontFiles].sort())
  })

  it('names every listed file by URL and maps the URL back, the bracketed file included', () => {
    for (const file of fontFiles) expect(templateFontFileOf(templateFontUrl(file))).toBe(file)
    expect(templateFontUrl('PlayfairDisplay[wght].ttf')).toBe(
      'genoffice-docx-media://template-fonts/PlayfairDisplay%5Bwght%5D.ttf',
    )
  })

  it('refuses unlisted names, other hosts and schemes, and non-URLs', () => {
    for (const url of [
      templateFontUrl('README.md'),
      templateFontUrl('Pretendard-OFL.txt'),
      templateFontUrl('../../package.json'),
      'genoffice-docx-media://template-fonts/..%2F..%2Fpackage.json',
      'genoffice-docx-media://template-fonts/%2E%2E/README.md',
      'genoffice-docx-media://template-fonts/%E0%A4%A',
      `genoffice-docx-media://${'a'.repeat(64)}/Pretendard-Bold.otf`,
      'genoffice-app://template-fonts/Pretendard-Bold.otf',
      'not a url',
    ])
      expect(templateFontFileOf(url), url).toBeNull()
  })
})

describe('shared font list', () => {
  const korean = TEMPLATE_FONTS.filter((f) => f.script === 'korean').map((f) => f.family)
  const latin = TEMPLATE_FONTS.filter((f) => f.script === 'latin').map((f) => f.family)

  it('offers the Korean template families in the Korean group', () => {
    for (const family of korean) expect(KOREAN_FAMILIES).toContain(family)
  })

  it('offers the Latin title families in the Latin group', () => {
    const en = fontFamiliesFor('en')
    const firstJapanese = en.indexOf(JAPANESE_FAMILIES[0]!)
    for (const family of latin) {
      expect(KOREAN_FAMILIES).not.toContain(family)
      expect(en.indexOf(family), family).toBeGreaterThanOrEqual(0)
      expect(en.indexOf(family), family).toBeLessThan(firstJapanese)
    }
  })

  it('offers every template family to every UI language without duplicates', () => {
    for (const family of TEMPLATE_FONT_FAMILY_NAMES) {
      expect(BUILTIN_FONT_FAMILIES).toContain(family)
      expect(fontFamiliesFor('ko')).toContain(family)
    }
    expect(new Set(BUILTIN_FONT_FAMILIES).size).toBe(BUILTIN_FONT_FAMILIES.length)
  })

  it('finds the Korean template families by their Korean names', () => {
    expect(matchesFontQuery('고운바탕', 'Gowun Batang')).toBe(true)
    expect(matchesFontQuery('고운 돋움', 'Gowun Dodum')).toBe(true)
    expect(matchesFontQuery('도현', 'Do Hyeon')).toBe(true)
    expect(matchesFontQuery('검은고딕', 'Black Han Sans')).toBe(true)
    expect(matchesFontQuery('프리텐다드', 'Pretendard')).toBe(true)
    expect(matchesFontQuery('본명조', 'Noto Serif KR')).toBe(true)
  })
})
