// The shared candidate list and how the pickers split it (#864, PR A).
//
// The case that matters most is the one the maintainers called out: Chromium reports
// family names in the system's language, so a Windows outside the CJK locales
// enumerates `SimSun` while our candidate holds the localized spelling. Matching
// spellings literally would hide a font that is really installed — in either
// direction, so both the localized-named and the English-named candidates are covered.
import { describe, expect, it } from 'vitest'
import { CJK_FAMILY_ALIASES, SIMPLIFIED_CJK_FAMILIES } from '@genoffice/i18n'
import {
  BUILTIN_FONT_FAMILIES,
  familyForTypedName,
  findFontMatch,
  fontFamiliesFor,
  fontFamilyLabel,
  matchesFontQuery,
  partitionFontFamilies,
  splitHangulFamilies,
  systemFamiliesBesidesCandidates,
  type FontFamilyInfoMap,
} from '../src/font-list'

// Nanum Myeongjo (the other Korean serif) is not a built-in candidate.

/** every spelling the alias table knows for a family, its own name first */
function spellingsOf(family: string): readonly string[] {
  for (const [key, aliases] of Object.entries(CJK_FAMILY_ALIASES)) {
    const group = [key, ...aliases]
    if (group.includes(family)) return group
  }
  return [family]
}

/** the Simplified CJK candidate whose alias entry names `english`, e.g. the SimSun one */
function candidateFor(english: string): string {
  const found = SIMPLIFIED_CJK_FAMILIES.find((f) => spellingsOf(f).includes(english))
  if (found === undefined) throw new Error(`no Simplified CJK candidate spells ${english}`)
  return found
}

/** the other spelling of the same family, e.g. the kana name reported on a ja Windows */
function localizedSpellingOf(english: string): string {
  const found = spellingsOf(english).find((s) => s !== english)
  if (found === undefined) throw new Error(`no localized spelling for ${english}`)
  return found
}

describe('partitionFontFamilies', () => {
  it('keeps MS Gothic / MS Mincho / Hiragino Mincho under the names ja machines report', () => {
    const { builtin } = partitionFontFamilies(
      ['MS Gothic', 'MS Mincho', 'Hiragino Mincho', 'Meiryo'],
      [localizedSpellingOf('MS Gothic'), localizedSpellingOf('MS Mincho'), 'Hiragino Mincho ProN'],
    )
    expect(builtin).toEqual(['MS Gothic', 'MS Mincho', 'Hiragino Mincho'])
  })

  it('keeps a localized candidate the machine reports under its English name', () => {
    // a Windows outside the CJK locales: SimSun is enumerated, the localized name is not
    const songti = candidateFor('SimSun')
    const fangsongGb = candidateFor('FangSong_GB2312')
    const { builtin } = partitionFontFamilies(
      [songti, fangsongGb, 'PingFang SC'],
      ['SimSun', 'FangSong_GB2312', 'Arial'],
    )
    expect(builtin).toContain(songti)
    expect(builtin).toContain(fangsongGb)
    // …while a family the machine genuinely lacks still drops out
    expect(builtin).not.toContain('PingFang SC')
  })

  it('keeps an English-named candidate the machine reports under its localized name', () => {
    // Japanese Windows: Yu Gothic and Meiryo are enumerated under their kana names
    const yuGothic = localizedSpellingOf('Yu Gothic')
    const meiryo = localizedSpellingOf('Meiryo')
    const { builtin } = partitionFontFamilies(['Yu Gothic', 'Meiryo'], [yuGothic, meiryo, 'Arial'])
    expect(builtin).toEqual(['Yu Gothic', 'Meiryo'])
  })

  it('keeps the JhengHei and DengXian Light candidates on zh-TW / non-zh Windows', () => {
    // zh-TW Windows reports JhengHei's family under its zh-TW spelling, so the alias
    // entry must carry every spelling of it; DengXian Light's candidate is spelled
    // with the space the localized name uses (the alias key must match it)
    const jhengHeiSpellings = spellingsOf('Microsoft JhengHei')
    expect(jhengHeiSpellings.length).toBe(3) // English + zh + zh-TW spellings
    const pmingliu = localizedSpellingOf('PMingLiU')
    const dengxianLight = candidateFor('DengXian Light')
    const { builtin } = partitionFontFamilies(
      ['Microsoft JhengHei', 'PMingLiU', dengxianLight],
      [...jhengHeiSpellings.filter((s) => s !== 'Microsoft JhengHei'), pmingliu, 'DengXian Light'],
    )
    expect(builtin).toContain('Microsoft JhengHei')
    expect(builtin).toContain('PMingLiU')
    expect(builtin).toContain(dengxianLight)
  })

  it('treats every spelling of a family as present when the machine reports one (CJK-locale Windows)', () => {
    const songti = candidateFor('SimSun')
    // both spellings name the same installed font, so both keep their slot
    const { builtin } = partitionFontFamilies([songti, 'SimSun'], [songti])
    expect(builtin).toEqual([songti, 'SimSun'])
  })

  it('keeps every candidate when the enumeration is unavailable or denied', () => {
    const songti = candidateFor('SimSun')
    const { builtin, system } = partitionFontFamilies(['Calibri', songti, 'Hiragino Sans'], [])
    expect(builtin).toEqual(['Calibri', songti, 'Hiragino Sans'])
    expect(system).toEqual([])
  })

  it('keeps catalog families the enumeration cannot see through knownAvailable', () => {
    const { builtin, system } = partitionFontFamilies(
      ['Noto Serif SC'],
      ['Arial'],
      ['Noto Serif SC'],
    )
    expect(builtin).toContain('Noto Serif SC')
    expect(system).not.toContain('Noto Serif SC')
  })

  it('keeps every candidate while enumeration is pending, even with catalog installs', () => {
    const { builtin } = partitionFontFamilies(['Calibri', 'Noto Serif SC'], [], ['Noto Serif SC'])
    expect(builtin).toEqual(['Calibri', 'Noto Serif SC'])
  })

  it('lists the machine families that are not candidates under system, in order', () => {
    const { system } = partitionFontFamilies(['Arial'], ['Arial', 'Comic Sans MS', 'Menlo'])
    expect(system).toEqual(['Comic Sans MS', 'Menlo'])
  })
})

describe('systemFamiliesBesidesCandidates', () => {
  it('drops the candidates from the machine list, keeping its order', () => {
    const system = systemFamiliesBesidesCandidates(
      ['Arial', 'Calibri'],
      ['Arial', 'Menlo', 'Calibri', 'Comic Sans MS'],
    )
    expect(system).toEqual(['Menlo', 'Comic Sans MS'])
  })

  it('keeps a docs picker from listing a builtin twice', () => {
    // docs keeps the full candidate list visible and appends the machine families
    // beside it: without the dedupe, every installed builtin would appear twice
    const candidates = fontFamiliesFor('en')
    const machine = ['Arial', 'Times New Roman', 'Georgia', 'Menlo']
    const system = systemFamiliesBesidesCandidates(candidates, machine)
    for (const f of candidates) expect(system).not.toContain(f)
    expect(system).toEqual(['Menlo'])
  })
})

describe('candidate lists', () => {
  it('carry Windows, macOS and downloadable names for the same script', () => {
    const sc = fontFamiliesFor('zh')
    expect(sc).toContain(candidateFor('SimSun')) // Windows
    expect(sc).toContain('PingFang SC') // macOS
    expect(sc).toContain('Songti SC') // macOS serif
    expect(sc).toContain('Noto Serif SC') // downloadable
  })

  it('offer a serif next to the sans for every CJK script', () => {
    for (const [lang, sans, serif] of [
      ['zh', 'Noto Sans SC', 'Noto Serif SC'],
      ['zh-TW', 'Noto Sans TC', 'Noto Serif TC'],
      ['ja', 'Noto Sans JP', 'Noto Serif JP'],
      ['ko', 'Noto Sans KR', 'Noto Serif KR'],
    ] as const) {
      const list = fontFamiliesFor(lang)
      expect(list).toContain(sans)
      expect(list).toContain(serif)
    }
  })

  it('has no duplicate candidates in the merged list', () => {
    expect(new Set(BUILTIN_FONT_FAMILIES).size).toBe(BUILTIN_FONT_FAMILIES.length)
  })
})

// Finding an installed Korean font. The system reports `HCR Batang`, the user
// knows it as its Korean name and types that; and among hundreds of system
// fonts in alphabetical order the Korean ones were effectively hidden.
describe('Korean names in the pickers', () => {
  const families = ['Arial', 'HCR Batang', 'NanumGothic', 'Pretendard', 'Malgun Gothic']
  const info: FontFamilyInfoMap = new Map([
    ['HCR Batang', { ko: '함초롬바탕', hangul: true }],
    ['NanumGothic', { ko: '나눔고딕', hangul: true }],
    ['Pretendard', { hangul: true }],
    ['Malgun Gothic', { ko: '맑은 고딕', hangul: true }],
  ])

  it('matches typed text anywhere in the name, not only at its start', () => {
    expect(matchesFontQuery('gothic', 'NanumGothic', info)).toBe(true)
    expect(matchesFontQuery('batang', 'HCR Batang', info)).toBe(true)
    expect(matchesFontQuery('gothic', 'Arial', info)).toBe(false)
    expect(matchesFontQuery('  ', 'Arial', info)).toBe(true)
  })

  it("matches a font's own Korean name, spaces aside", () => {
    expect(matchesFontQuery('함초롬', 'HCR Batang', info)).toBe(true)
    expect(matchesFontQuery('나눔 고딕', 'NanumGothic', info)).toBe(true)
    expect(matchesFontQuery('맑은고딕', 'Malgun Gothic', info)).toBe(true)
  })

  it('matches a known Korean reading of a font that carries no Korean name', () => {
    expect(matchesFontQuery('프리텐다드', 'Pretendard', info)).toBe(true)
    expect(matchesFontQuery('프리텐', 'Pretendard Variable')).toBe(true)
    expect(matchesFontQuery('지마켓', 'Gmarket Sans TTF')).toBe(true)
    expect(matchesFontQuery('프리텐다드', 'Arial', info)).toBe(false)
  })

  it('prefers the name the text starts, and says whether it can complete inline', () => {
    expect(findFontMatch('na', families, info)).toEqual({ family: 'NanumGothic', prefix: true })
    expect(findFontMatch('gothic', families, info)).toEqual({
      family: 'NanumGothic',
      prefix: false,
    })
    expect(findFontMatch('프리텐', families, info)).toEqual({ family: 'Pretendard', prefix: false })
    expect(findFontMatch('zzz', families, info)).toBeUndefined()
    expect(findFontMatch('', families, info)).toBeUndefined()
  })

  it('commits the family a fully typed Korean name stands for', () => {
    expect(familyForTypedName('함초롬바탕', families, info)).toBe('HCR Batang')
    expect(familyForTypedName('프리텐다드', families, info)).toBe('Pretendard')
  })

  it('keeps typed text that names no listed family, or names one already', () => {
    expect(familyForTypedName('Gmarket Sans', families, info)).toBe('Gmarket Sans')
    expect(familyForTypedName('함초롬', families, info)).toBe('함초롬')
    expect(familyForTypedName('Arial', families, info)).toBe('Arial')
  })

  it('labels a family with its Korean name only when the font has one', () => {
    expect(fontFamilyLabel('HCR Batang', info)).toBe('HCR Batang (함초롬바탕)')
    expect(fontFamilyLabel('Pretendard', info)).toBe('Pretendard')
    expect(fontFamilyLabel('HCR Batang')).toBe('HCR Batang')
  })

  it('splits out the Korean fonts in their listed order', () => {
    expect(splitHangulFamilies(families, info)).toEqual({
      hangul: ['HCR Batang', 'NanumGothic', 'Pretendard', 'Malgun Gothic'],
      other: ['Arial'],
    })
  })

  it('splits nothing out when no font info is given', () => {
    expect(splitHangulFamilies(families)).toEqual({ hangul: [], other: families })
  })
})
