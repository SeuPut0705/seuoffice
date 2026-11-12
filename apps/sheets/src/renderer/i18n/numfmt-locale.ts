/**
 * BCP-47 tags `numfmt` uses for number formats (weekday/month names,
 * decimal and grouping marks). This is deliberately separate from the React
 * i18n module so plain modules (Univer locale wiring, format previews) do not
 * pull the translation dictionaries into their graph.
 *
 * Keyed by document locale: the language documents are read for names more
 * languages than the UI has, and every row here is reached through it.
 *
 * Malay has no numfmt pack, so it keeps English formatting.
 */
import { getDocumentLocale } from '../document-locale'

const NUMFMT_LOCALES: Record<string, string> = {
  zh: 'zh-CN',
  en: 'en',
  ja: 'ja-JP',
  ko: 'ko-KR',
  fr: 'fr-FR',
  de: 'de-DE',
  es: 'es-ES',
  th: 'th-TH',
  id: 'id-ID',
  ru: 'ru-RU',
  ar: 'ar-SA',
  pt: 'pt-BR',
  it: 'it-IT',
  pl: 'pl-PL',
  cs: 'cs-CZ',
  nl: 'nl-NL',
  ms: 'en',
  he: 'he-IL',
  hi: 'hi-IN',
  'zh-TW': 'zh-TW',
  vi: 'vi-VN',
}

export function numfmtLocaleFor(documentLocale: string): string {
  return NUMFMT_LOCALES[documentLocale] ?? 'en'
}

/**
 * The tag number formats are drawn with in this window. Cells, chart labels,
 * clipboard text and the Format Cells preview all read it here, so they agree.
 */
export function numfmtLocale(): string {
  return numfmtLocaleFor(getDocumentLocale())
}
