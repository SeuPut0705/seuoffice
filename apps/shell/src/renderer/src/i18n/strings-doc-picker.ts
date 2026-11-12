import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './doc-picker/en'
import { ko } from './doc-picker/ko'

/**
 * The "Attach from SeuOffice documents" window: strings for its three groups,
 * its notices and its buttons. Sharded per language; `en` defines the key set.
 */
export const docPickerStrings = defineStrings({
  en,
  ko,
})

export type DocPickerStringKey = keyof typeof en

const translate = createI18n(docPickerStrings)

export function docPickerText(lang: Lang, key: DocPickerStringKey, params?: Params): string {
  return translate(lang, key, params)
}
