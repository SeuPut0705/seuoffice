//! `packages/xlsx-gateway/src`: the two small pieces the sheets main process reads.

/// `CSV_IMPORT_DEFAULT_LIMIT_MB` (gateway/csv-limits.ts): the ceiling a
/// delimited import starts at, in MB
pub const CSV_IMPORT_DEFAULT_LIMIT_MB: f64 = 256.0;

/// `legacyCsvCharsetFor(locale)` (shared/document-locale.ts): the code page to
/// try first for a document locale. The TypeScript indexes an object literal,
/// so a name the prototype has (`constructor`) answers a function there; no
/// caller passes one (the locale is a `documentLocaleFor` code), and only the
/// own keys answer here.
pub fn legacy_csv_charset_for(locale: &str) -> Option<&'static str> {
    match locale {
        "zh" => Some("gb18030"),
        "zh-TW" => Some("big5"),
        "ja" => Some("shift_jis"),
        "ko" => Some("euc-kr"),
        _ => None,
    }
}
