import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './skills/en'
import { ko } from './skills/ko'

/**
 * Settings → Skills: the list, the editor, imports and updates. Sharded per
 * language; `en` defines the key set.
 */
export const skillsUiStrings = defineStrings({
  en,
  ko,
})

export type SkillsStringKey = keyof typeof en

const translate = createI18n(skillsUiStrings)

export function skillsText(lang: Lang, key: SkillsStringKey, params?: Params): string {
  return translate(lang, key, params)
}
