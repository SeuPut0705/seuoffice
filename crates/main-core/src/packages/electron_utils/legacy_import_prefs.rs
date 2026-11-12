//! `packages/electron-utils/src/legacy-import-prefs.ts`: "Convert without
//! asking next time" on the legacy-format import dialogs, stored per format
//! under `legacyImportSkipConfirm` in `app-settings.json`.

use std::fs;

use jscompat::{JsObject, JsonValue, json_parse};

use super::atomic_write::write_json_atomic;
use crate::node_fs::NodeError;

pub const LEGACY_IMPORT_SKIP_KEY: &str = "legacyImportSkipConfirm";

pub const LEGACY_IMPORT_KINDS: [&str; 6] = ["word97", "odt", "hwp", "ods", "odp", "ppt"];

/// `readSettings(settingsPath)`: the stored object, or `{}` when the file is
/// missing, corrupt or holds anything but an object.
fn read_settings(settings_path: &str) -> JsObject<JsonValue> {
    let Ok(bytes) = fs::read(settings_path) else {
        return JsObject::new();
    };
    // readFileSync(path, 'utf8'): a byte order mark stays in the text
    let text = String::from_utf8_lossy(&bytes);
    match json_parse(&text) {
        Ok(JsonValue::Object(object)) => object,
        _ => JsObject::new(),
    }
}

/// `skipMap(settings)`: the formats set to `true`, as an object whose keys
/// are in the order of `LEGACY_IMPORT_KINDS`.
fn skip_map(settings: &JsObject<JsonValue>) -> JsObject<JsonValue> {
    let mut out = JsObject::new();
    let Some(JsonValue::Object(raw)) = settings.get(LEGACY_IMPORT_SKIP_KEY) else {
        return out;
    };
    for kind in LEGACY_IMPORT_KINDS {
        if raw.get(kind) == Some(&JsonValue::Bool(true)) {
            out.set(kind, JsonValue::Bool(true));
        }
    }
    out
}

/// `{ ...settings, [LEGACY_IMPORT_SKIP_KEY]: map }`, written atomically.
fn write_with_map(
    settings_path: &str,
    settings: &JsObject<JsonValue>,
    map: JsObject<JsonValue>,
) -> Result<(), NodeError> {
    let mut next = settings.clone();
    next.set(LEGACY_IMPORT_SKIP_KEY, JsonValue::Object(map));
    write_json_atomic(settings_path, &JsonValue::Object(next))
}

pub fn read_legacy_import_skip(settings_path: &str, kind: &str) -> bool {
    skip_map(&read_settings(settings_path)).get(kind) == Some(&JsonValue::Bool(true))
}

pub fn write_legacy_import_skip(
    settings_path: &str,
    kind: &str,
    skip: bool,
) -> Result<(), NodeError> {
    let settings = read_settings(settings_path);
    let mut map = skip_map(&settings);
    // `map[kind] = true` on a plain object: an own `__proto__` is not made
    if skip {
        if kind != "__proto__" {
            map.set(kind, JsonValue::Bool(true));
        }
    } else {
        // `delete map[kind]`
        map = map
            .entries()
            .into_iter()
            .filter(|(key, _)| *key != kind)
            .map(|(key, value)| (key.to_owned(), value.clone()))
            .collect();
    }
    write_with_map(settings_path, &settings, map)
}

/// true while no format is set to skip, i.e. every legacy import still asks
pub fn read_legacy_import_prompt(settings_path: &str) -> bool {
    skip_map(&read_settings(settings_path)).is_empty()
}

/// on: clear every skip flag; off: skip the confirmation for every format
pub fn write_legacy_import_prompt(settings_path: &str, prompt: bool) -> Result<(), NodeError> {
    let settings = read_settings(settings_path);
    let mut map = JsObject::new();
    if !prompt {
        for kind in LEGACY_IMPORT_KINDS {
            map.set(kind, JsonValue::Bool(true));
        }
    }
    write_with_map(settings_path, &settings, map)
}
