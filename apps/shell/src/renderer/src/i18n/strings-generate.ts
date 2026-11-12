import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './generate/en'
import { ko } from './generate/ko'

/**
 * The generate window and its Home entry points ("make a new document from
 * these files"). Sharded per language; `en` defines the key set.
 */
export const generateStrings = defineStrings({
  en,
  ko,
})

export type GenerateStringKey = keyof typeof en

const translate = createI18n(generateStrings)

export function generateText(lang: Lang, key: GenerateStringKey, params?: Params): string {
  return translate(lang, key, params)
}
