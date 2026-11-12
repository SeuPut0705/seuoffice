/**
 * The language a document is read and drawn for: the date formats a file
 * leaves to its viewer, the names and marks of number and date formats, the
 * order text is sorted in, the legacy code page of an unmarked text file.
 * These are the languages the app's screen once had; the screen has fewer now
 * and documents do not, so the code comes from the language the install asks
 * for (its stored choice, else the system's; on the web the host's or the
 * browser's), never from the UI language.
 */
const DOCUMENT_LOCALES = [
  'zh',
  'ja',
  'ko',
  'fr',
  'de',
  'es',
  'th',
  'id',
  'ru',
  'ar',
  'pt',
  'it',
  'pl',
  'cs',
  'nl',
  'ms',
  'he',
  'hi',
  'vi',
] as const

/**
 * Map a language value ('ja-JP', 'zh_CN', 'zh-Hant-HK', 'de') to its code. A
 * language without a code is English, as it always was. Every code is also a
 * BCP-47 tag the Intl formatters take.
 */
export function documentLocaleFor(requested: string | null | undefined): string {
  const value = requested?.trim().toLowerCase()
  if (!value) return 'en'
  // traditional-script Chinese variants must win over the generic 'zh' prefix
  if (/^zh[-_](tw|hk|mo|hant)/.test(value)) return 'zh-TW'
  for (const code of DOCUMENT_LOCALES) {
    if (value === code || value.startsWith(`${code}-`) || value.startsWith(`${code}_`)) return code
  }
  // 'in' is the legacy ISO code for Indonesian still reported by some systems
  if (/^in\b/.test(value) || /^in[-_]/.test(value)) return 'id'
  // 'iw' is the legacy ISO code for Hebrew
  if (/^iw\b/.test(value) || /^iw[-_]/.test(value)) return 'he'
  return 'en'
}
