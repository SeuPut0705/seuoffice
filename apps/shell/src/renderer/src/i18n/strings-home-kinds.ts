import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './home-kinds/en'
import { ko } from './home-kinds/ko'

/**
 * Settings → General "new documents on Home" row.
 * Sharded per language; `en` defines the key set.
 */
export const homeKindsStrings = defineStrings({
  en,
  ko,
})

export type HomeKindsStringKey = keyof typeof en

const translate = createI18n(homeKindsStrings)

export function homeKindsText(lang: Lang, key: HomeKindsStringKey, params?: Params): string {
  return translate(lang, key, params)
}
