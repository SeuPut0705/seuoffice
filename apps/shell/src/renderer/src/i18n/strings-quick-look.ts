import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './quick-look/en'
import { ko } from './quick-look/ko'

/**
 * Quick Look preview modal and standalone Explorer preview window strings.
 * Sharded per language; `en` defines the key set.
 */
export const quickLookStrings = defineStrings({
  en,
  ko,
})

export type QuickLookStringKey = keyof typeof en

const translate = createI18n(quickLookStrings)

export function quickLookText(lang: Lang, key: QuickLookStringKey, params?: Params): string {
  return translate(lang, key, params)
}
