/// Excel writes a CSV in the system's legacy code page and marks nothing.
/// Bytes that read cleanly in more than one of them (GBK and Shift_JIS both
/// give plausible CJK) are settled by the language documents are read for
/// (documentLocaleFor in @genoffice/i18n), never by the UI language.
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
