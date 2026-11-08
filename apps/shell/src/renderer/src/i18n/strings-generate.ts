import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { zh } from './generate/zh'
import { en } from './generate/en'
import { ja } from './generate/ja'
import { ko } from './generate/ko'
import { fr } from './generate/fr'
import { de } from './generate/de'
import { es } from './generate/es'
import { th } from './generate/th'
import { id } from './generate/id'
import { ru } from './generate/ru'
import { ar } from './generate/ar'
import { pt } from './generate/pt'
import { it } from './generate/it'
import { pl } from './generate/pl'
import { cs } from './generate/cs'
import { nl } from './generate/nl'
import { ms } from './generate/ms'
import { he } from './generate/he'
import { hi } from './generate/hi'
import { zhTW } from './generate/zh-TW'
import { vi } from './generate/vi'

/**
 * The generate window and its Home entry points ("make a new document from
 * these files"). Sharded per language; `zh` defines the key set.
 */
export const generateStrings = defineStrings({
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

export type GenerateStringKey = keyof typeof zh

const translate = createI18n(generateStrings)

export function generateText(lang: Lang, key: GenerateStringKey, params?: Params): string {
  return translate(lang, key, params)
}
