//! `apps/shell/src/main/csv-import-limit.ts`.

use jscompat::{JsObject, JsonValue};

/// `CSV_IMPORT_LIMIT_CHOICES_MB` of `@seuoffice/xlsx-gateway/gateway/csv-limits`:
/// the steps the setting offers, in MB.
pub const CSV_IMPORT_LIMIT_CHOICES_MB: [f64; 3] = [64.0, 128.0, 256.0];

/// `CSV_IMPORT_DEFAULT_LIMIT_MB` of the same file: the ceiling a delimited
/// import starts at, in MB.
pub const CSV_IMPORT_DEFAULT_LIMIT_MB: f64 = 256.0;

/// `csvImportLimitMb(settings)`: the user's choice when it is one of the
/// offered steps, the default otherwise.
pub fn csv_import_limit_mb(settings: &JsObject<JsonValue>) -> f64 {
    let saved = settings.get("csvImportLimitMb");
    let mb = match saved {
        Some(JsonValue::Number(saved)) => *saved,
        _ => CSV_IMPORT_DEFAULT_LIMIT_MB,
    };
    if CSV_IMPORT_LIMIT_CHOICES_MB.contains(&mb) {
        mb
    } else {
        CSV_IMPORT_DEFAULT_LIMIT_MB
    }
}
