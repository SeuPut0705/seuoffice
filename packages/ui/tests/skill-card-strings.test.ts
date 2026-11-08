import { describe, expect, it } from 'vitest'
import { LANGS, type Lang } from '@genoffice/i18n'
import { SKILL_CARD_STRINGS, type SkillCardStringKey } from '../src/strings-skill-card'

const KEYS = Object.keys(SKILL_CARD_STRINGS.zh) as SkillCardStringKey[]
const NON_LATIN: readonly Lang[] = ['zh', 'ja', 'ko', 'th', 'ru', 'ar', 'he', 'hi', 'zh-TW']

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('SKILL_CARD_STRINGS', () => {
  it('has every key, non-empty, in all 21 languages', () => {
    expect(Object.keys(SKILL_CARD_STRINGS).sort()).toEqual([...LANGS].sort())
    for (const lang of LANGS) {
      const dict = SKILL_CARD_STRINGS[lang] as Record<string, string>
      expect(Object.keys(dict).sort(), lang).toEqual([...KEYS].sort())
      for (const key of KEYS) expect(dict[key]?.trim().length, `${lang}.${key}`).toBeGreaterThan(0)
    }
  })

  it('keeps the same placeholders in every language', () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(placeholders(SKILL_CARD_STRINGS[lang][key]), `${lang}.${key}`).toEqual(
          placeholders(SKILL_CARD_STRINGS.zh[key]),
        )
      }
    }
  })

  it('is translated, not copied from English, in non-Latin-script languages', () => {
    for (const lang of NON_LATIN) {
      for (const key of KEYS) {
        expect(SKILL_CARD_STRINGS[lang][key], `${lang}.${key}`).not.toBe(SKILL_CARD_STRINGS.en[key])
      }
    }
  })

  it('names no AI company', () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(SKILL_CARD_STRINGS[lang][key], `${lang}.${key}`).not.toMatch(
          /claude|anthropic|openai|chatgpt|codex/i,
        )
      }
    }
  })

  it('says the spec sentences in Korean', () => {
    const ko = SKILL_CARD_STRINGS.ko
    expect(ko.skillUsed).toBe('{title} 스킬을 썼습니다')
    expect(ko.copyNotice).toBe('내 스킬로 사본을 만들어 저장하고, 원래 스킬은 끕니다')
    expect(ko.saved).toBe('저장했습니다')
    expect(ko.openSettings).toBe('설정에서 보기')
    expect(ko.unsaved).toBe('저장하지 않은 스킬 제안')
    expect(ko.cardEditTitle).toBe('스킬 고치기')
    expect(ko.templateCheck).toBe('이 문서를 양식으로 함께 저장')
    expect(ko.templateBlank).toBe('비운 양식 만들기')
    expect(ko.templateAsIs).toBe('원래 문서 그대로 저장')
    expect(ko.invokeAuto).toBe('스스로 쓰기')
    expect(ko.invokeManual).toBe('부를 때만')
    expect(ko.replace).toBe('바꾸기')
  })
})
