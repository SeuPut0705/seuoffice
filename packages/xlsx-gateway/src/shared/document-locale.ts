/// The language a document is read and drawn for: which pattern a date format
/// the file leaves to its viewer stands for (builtin numFmtIds 27-36 and
/// 50-58, resolved by the engine per language code), which names and marks a
/// number format is drawn with, which legacy code page an unmarked text file
/// was most likely written in. These are the languages the app's screen once
/// had; the screen has fewer now and documents do not, so the code comes from
/// the language the install asks for (its stored choice, else the system's;
/// on the web the browser's), never from the UI language.

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

/// Map a language value ('ja-JP', 'zh_CN', 'zh-Hant-HK', 'de') to its code. A
/// language without a code is English, as it always was.
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

/// Excel writes a CSV in the system's legacy code page and marks nothing.
/// Bytes that read cleanly in more than one of them (GBK and Shift_JIS both
/// give plausible CJK) are settled by the language of the install.
const LEGACY_CSV_CHARSETS: Partial<Record<string, string>> = {
  zh: 'gb18030',
  'zh-TW': 'big5',
  ja: 'shift_jis',
  ko: 'euc-kr',
}

/// The code page to try first for a document locale (a documentLocaleFor code)
export function legacyCsvCharsetFor(locale: string): string | undefined {
  return LEGACY_CSV_CHARSETS[locale]
}
