//! `packages/ai-provider/src/settings-secrets.ts`: keys and tokens in
//! ai-settings.json, sealed by the operating system.
//!
//! The TypeScript holds the codec in a module variable that the main process
//! (Electron safeStorage) or the terminal command registers. Here the codec
//! is a parameter, `None` being "no codec registered".

use super::jsval::{Obj, as_record, assign, text};
use jscompat::JsonValue;

pub const SEALED_PREFIX: &str = "sealed:v1:";

/// What a codec call throws: the `message` of the error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodecThrow(pub String);

/// `AiSecretCodec`
pub trait AiSecretCodec {
    /// the sealed form, or `None` when this PC cannot seal now (the value
    /// stays plain)
    fn seal(&self, plain: &str) -> Result<Option<String>, CodecThrow>;
    /// the plain value, or `None` when it cannot be opened
    fn open(&self, sealed: &str) -> Result<Option<String>, CodecThrow>;
}

/// `isSealedSecret(value)`
pub fn is_sealed_secret(value: &JsonValue) -> bool {
    matches!(value, JsonValue::String(t) if t.starts_with(SEALED_PREFIX))
}

/// A copy of `record` with `fn` applied to the string at `key`, if there is one
fn map_field(record: &Obj, key: &str, f: &mut dyn FnMut(&str) -> String) -> Obj {
    match record.get(key) {
        Some(JsonValue::String(value)) => {
            let mut out = record.clone();
            out.set(key, text(f(value)));
            out
        }
        _ => record.clone(),
    }
}

/// `fn` applied to every `apiKey` of a provider table (`{ id: { apiKey } }`)
fn map_table(table: Option<&JsonValue>, f: &mut dyn FnMut(&str) -> String) -> Option<JsonValue> {
    let table = table?;
    let Some(table_obj) = as_record(table) else {
        return Some(table.clone());
    };
    let mut out = Obj::new();
    for (id, config) in table_obj.entries() {
        let mapped = match as_record(config) {
            Some(c) => JsonValue::Object(map_field(c, "apiKey", f)),
            None => config.clone(),
        };
        // `out[id] = ...`: `__proto__` makes no own key
        assign(&mut out, id, mapped);
    }
    Some(JsonValue::Object(out))
}

/// `mapAiSecrets(settings, fn)`: a copy of a stored or working settings
/// object with `fn` applied to every secret it can hold: the chat
/// providers' keys, the custom endpoints' keys, the media and search
/// providers' keys, and read_url's GitHub token. Anything not shaped like
/// settings passes through untouched.
pub fn map_ai_secrets(settings: &JsonValue, f: &mut dyn FnMut(&str) -> String) -> JsonValue {
    let Some(record) = as_record(settings) else {
        return settings.clone();
    };
    let mut s = record.clone();
    if s.get("providers").is_some()
        && let Some(v) = map_table(s.get("providers"), f)
    {
        s.set("providers", v)
    }
    if let Some(JsonValue::Array(list)) = s.get("customEndpoints") {
        let mapped: Vec<JsonValue> = list
            .iter()
            .map(|e| match as_record(e) {
                Some(r) => JsonValue::Object(map_field(r, "apiKey", f)),
                None => e.clone(),
            })
            .collect();
        s.set("customEndpoints", JsonValue::Array(mapped));
    }
    for key in ["media", "search"] {
        if let Some(block) = s.get(key).and_then(as_record).cloned() {
            let mut next = block.clone();
            // `providers: undefined` is no key in the JSON the comparison writes
            if let Some(v) = map_table(block.get("providers"), f) {
                next.set("providers", v);
            }
            s.set(key, JsonValue::Object(next));
        }
    }
    if let Some(block) = s.get("readUrl").and_then(as_record).cloned() {
        s.set(
            "readUrl",
            JsonValue::Object(map_field(&block, "githubToken", f)),
        );
    }
    JsonValue::Object(s)
}

/// `sealedAiSecretsIn(settings)`: every sealed value in a stored settings
/// object, without repeats.
pub fn sealed_ai_secrets_in(settings: &JsonValue) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    map_ai_secrets(settings, &mut |v| {
        if v.starts_with(SEALED_PREFIX) && !found.iter().any(|f| f == v) {
            found.push(v.to_owned());
        }
        v.to_owned()
    });
    found
}

/// `openSecretValue(value)`: one stored value opened: plain stays plain, a
/// sealed one that cannot be opened is empty.
pub fn open_secret_value(codec: Option<&dyn AiSecretCodec>, value: &str) -> String {
    if !value.starts_with(SEALED_PREFIX) {
        return value.to_owned();
    }
    match codec.map(|c| c.open(value)) {
        Some(Ok(Some(plain))) => plain,
        _ => String::new(),
    }
}

/// `sealSecretValue(value)`: one value as it goes to disk: sealed when it is
/// plain, non-empty and this PC can seal.
pub fn seal_secret_value(codec: Option<&dyn AiSecretCodec>, value: &str) -> String {
    if value.is_empty() || value.starts_with(SEALED_PREFIX) {
        return value.to_owned();
    }
    let Some(codec) = codec else {
        return value.to_owned();
    };
    match codec.seal(value) {
        Ok(Some(sealed)) => sealed,
        _ => value.to_owned(),
    }
}

/// `openAiSecrets(stored)`: the settings as they were read, with sealed
/// values opened (empty when they cannot be).
pub fn open_ai_secrets(codec: Option<&dyn AiSecretCodec>, stored: &JsonValue) -> JsonValue {
    map_ai_secrets(stored, &mut |v| open_secret_value(codec, v))
}

/// `sealAiSecrets(settings)`: the settings as they go to disk: plain
/// non-empty values sealed when this PC can.
pub fn seal_ai_secrets(codec: Option<&dyn AiSecretCodec>, settings: &JsonValue) -> JsonValue {
    map_ai_secrets(settings, &mut |v| seal_secret_value(codec, v))
}
