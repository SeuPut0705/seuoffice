import { describe, expect, it } from 'vitest'
import { LANGS, type Lang } from '@genoffice/i18n'
import { SKILL_PICKER_STRINGS, type SkillPickerStringKey } from '../src/strings-skill-picker'

const KEYS = Object.keys(SKILL_PICKER_STRINGS.zh) as SkillPickerStringKey[]
const NON_LATIN: readonly Lang[] = ['zh', 'ja', 'ko', 'th', 'ru', 'ar', 'he', 'hi', 'zh-TW']
/** keys that are mostly a folder or product name and may read alike */
const MAY_MATCH_EN = new Set<SkillPickerStringKey>(['sourceAppGitHub'])

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('SKILL_PICKER_STRINGS', () => {
  it('has every key, non-empty, in all 21 languages', () => {
    expect(Object.keys(SKILL_PICKER_STRINGS).sort()).toEqual([...LANGS].sort())
    for (const lang of LANGS) {
      const dict = SKILL_PICKER_STRINGS[lang] as Record<string, string>
      expect(Object.keys(dict).sort(), lang).toEqual([...KEYS].sort())
      for (const key of KEYS) expect(dict[key]?.trim().length, `${lang}.${key}`).toBeGreaterThan(0)
    }
  })

  it('keeps the same placeholders in every language', () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(placeholders(SKILL_PICKER_STRINGS[lang][key]), `${lang}.${key}`).toEqual(
          placeholders(SKILL_PICKER_STRINGS.zh[key]),
        )
      }
    }
  })

  it('is translated, not copied from English, in non-Latin-script languages', () => {
    for (const lang of NON_LATIN) {
      for (const key of KEYS) {
        if (MAY_MATCH_EN.has(key)) continue
        expect(SKILL_PICKER_STRINGS[lang][key], `${lang}.${key}`).not.toBe(
          SKILL_PICKER_STRINGS.en[key],
        )
      }
    }
  })

  it('names the program folders in plain text only in the source labels', () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        if (key === 'sourceUser' || key === 'sourcePlugin' || key === 'sourceCodex') continue
        expect(SKILL_PICKER_STRINGS[lang][key], `${lang}.${key}`).not.toMatch(
          /claude|anthropic|openai|chatgpt|codex/i,
        )
      }
    }
  })

  it('says the spec sentences in Korean', () => {
    const ko = SKILL_PICKER_STRINGS.ko
    expect(ko.manage).toBe('스킬 관리…')
    expect(ko.scriptsNotice).toBe('이 스킬의 스크립트는 일반 AI 창에서 실행되지 않습니다')
    expect(ko.tooLarge).toBe('스킬이 너무 커서 함께 보낼 수 없습니다')
    expect(ko.missing).toBe('없음')
  })
})
