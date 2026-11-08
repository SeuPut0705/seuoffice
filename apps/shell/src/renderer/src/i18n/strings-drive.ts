import { createI18n, defineStrings, type Lang, type Params } from '@genoffice/i18n'
import { zh } from './drive/zh'
import { en } from './drive/en'
import { ja } from './drive/ja'
import { ko } from './drive/ko'
import { fr } from './drive/fr'
import { de } from './drive/de'
import { es } from './drive/es'
import { th } from './drive/th'
import { id } from './drive/id'
import { ru } from './drive/ru'
import { ar } from './drive/ar'
import { pt } from './drive/pt'
import { it } from './drive/it'
import { pl } from './drive/pl'
import { cs } from './drive/cs'
import { nl } from './drive/nl'
import { ms } from './drive/ms'
import { he } from './drive/he'
import { hi } from './drive/hi'
import { zhTW } from './drive/zh-TW'
import { vi } from './drive/vi'

/**
 * Google Drive on the home screen and in Settings (decision 0033). Sharded per language; `zh` defines the key set.
 */
export const driveUiStrings = defineStrings({
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

export type DriveStringKey = keyof typeof zh

const translate = createI18n(driveUiStrings)

export function driveUiText(lang: Lang, key: DriveStringKey, params?: Params): string {
  return translate(lang, key, params)
}
