import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { zh } from './quick-look/zh'
import { en } from './quick-look/en'
import { ja } from './quick-look/ja'
import { ko } from './quick-look/ko'
import { fr } from './quick-look/fr'
import { de } from './quick-look/de'
import { es } from './quick-look/es'
import { th } from './quick-look/th'
import { id } from './quick-look/id'
import { ru } from './quick-look/ru'
import { ar } from './quick-look/ar'
import { pt } from './quick-look/pt'
import { it } from './quick-look/it'
import { pl } from './quick-look/pl'
import { cs } from './quick-look/cs'
import { nl } from './quick-look/nl'
import { ms } from './quick-look/ms'
import { he } from './quick-look/he'
import { hi } from './quick-look/hi'
import { zhTW } from './quick-look/zh-TW'
import { vi } from './quick-look/vi'

/**
 * Quick Look preview modal and standalone Explorer preview window strings.
 * Sharded per language; `zh` defines the key set.
 */
export const quickLookStrings = defineStrings({
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

export type QuickLookStringKey = keyof typeof zh

const translate = createI18n(quickLookStrings)

export function quickLookText(lang: Lang, key: QuickLookStringKey, params?: Params): string {
  return translate(lang, key, params)
}
