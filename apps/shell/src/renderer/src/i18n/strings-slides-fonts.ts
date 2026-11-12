import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './slides-fonts/en'
import { ko } from './slides-fonts/ko'

/**
 * Settings → General "AI slide fonts" field.
 * Sharded per language; `en` defines the key set.
 */
export const slidesFontsStrings = defineStrings({
  en,
  ko,
})

export type SlidesFontsStringKey = keyof typeof en

const translate = createI18n(slidesFontsStrings)

export function slidesFontsText(lang: Lang, key: SlidesFontsStringKey, params?: Params): string {
  return translate(lang, key, params)
}
