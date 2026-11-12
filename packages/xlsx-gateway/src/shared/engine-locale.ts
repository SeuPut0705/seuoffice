/// Builtin numFmtIds 27-36 and 50-58 record no pattern in the file: the viewer
/// resolves them for its own language, and the engine keeps one table per
/// language code (locale_reserved_number_format, locale_short_date_format).
/// These are the codes a workbook is opened with. They are the languages the
/// app's screen once had; the screen has fewer now and the engine's tables do
/// not, so the code comes from the language the install asks for (its stored
/// choice, else the system's), never from the UI language.

const ENGINE_LOCALES = [
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

/// Map a language value ('ja-JP', 'zh_CN', 'zh-Hant-HK', 'de') to the engine's
/// code. A language without a code is English, as it always was.
export function engineLocaleFor(requested: string | null | undefined): string {
  const value = requested?.trim().toLowerCase()
  if (!value) return 'en'
  // traditional-script Chinese variants must win over the generic 'zh' prefix
  if (/^zh[-_](tw|hk|mo|hant)/.test(value)) return 'zh-TW'
  for (const code of ENGINE_LOCALES) {
    if (value === code || value.startsWith(`${code}-`) || value.startsWith(`${code}_`)) return code
  }
  // 'in' is the legacy ISO code for Indonesian still reported by some systems
  if (/^in\b/.test(value) || /^in[-_]/.test(value)) return 'id'
  // 'iw' is the legacy ISO code for Hebrew
  if (/^iw\b/.test(value) || /^iw[-_]/.test(value)) return 'he'
  return 'en'
}
