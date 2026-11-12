import { createI18n, defineStrings, type Lang, type Params } from '@seuoffice/i18n'
import { en } from './pdf-tools/en'
import { ko } from './pdf-tools/ko'

/**
 * The PDF tools window. Sharded per language; `en` defines the key set. The
 * tool and option names (`tool*`, `optPerSheet` … `optRotateLeft`) are the PDF
 * editor's own ribbon strings, copied so both places name a command the same.
 */
export const pdfToolsStrings = defineStrings({
  en,
  ko,
})

export type PdfToolsStringKey = keyof typeof en

const translate = createI18n(pdfToolsStrings)

export function pdfToolsText(lang: Lang, key: PdfToolsStringKey, params?: Params): string {
  return translate(lang, key, params)
}
