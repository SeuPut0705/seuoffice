//! `apps/sheets/src/main/document-locale.ts`.

use crate::packages::i18n::document_locale;
use crate::packages::xlsx_gateway::legacy_csv_charset_for;

/// `legacyCsvCharset()`: which legacy code page an unmarked CSV was most
/// likely written in on this install. `requested_locale` is the process-wide
/// requested locale `documentLocale()` reads.
pub fn legacy_csv_charset(requested_locale: &str) -> Option<&'static str> {
    legacy_csv_charset_for(&document_locale(requested_locale))
}
