import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { zh } from './skills/zh'
import { en } from './skills/en'
import { ja } from './skills/ja'
import { ko } from './skills/ko'
import { fr } from './skills/fr'
import { de } from './skills/de'
import { es } from './skills/es'
import { th } from './skills/th'
import { id } from './skills/id'
import { ru } from './skills/ru'
import { ar } from './skills/ar'
import { pt } from './skills/pt'
import { it } from './skills/it'
import { pl } from './skills/pl'
import { cs } from './skills/cs'
import { nl } from './skills/nl'
import { ms } from './skills/ms'
import { he } from './skills/he'
import { hi } from './skills/hi'
import { zhTW } from './skills/zh-TW'
import { vi } from './skills/vi'

/**
 * Settings → Skills: the list, the editor, imports and updates. Sharded per
 * language; `zh` defines the key set.
 */
export const skillsUiStrings = defineStrings({
  zh,
  en,
  ja,
  ko,
  fr,
  de,
  es,
  th,
  id,
  ru,
  ar,
  pt,
  it,
  pl,
  cs,
  nl,
  ms,
  he,
  hi,
  'zh-TW': zhTW,
  vi,
})

export type SkillsStringKey = keyof typeof zh

const translate = createI18n(skillsUiStrings)

export function skillsText(lang: Lang, key: SkillsStringKey, params?: Params): string {
  return translate(lang, key, params)
}
