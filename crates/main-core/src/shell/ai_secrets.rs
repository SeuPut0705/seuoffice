//! `apps/shell/src/main/ai-secrets.ts`: keys and tokens in ai-settings.json
//! under the operating system's protection (decision 0063). The app seals
//! them with Electron safeStorage on Windows (DPAPI under the user's account)
//! and on Linux when a real keyring holds the key. macOS keeps them plain.
//! Any platform opens a sealed value it can.
//!
//! The terminal command runs without Electron, so it starts this app hidden
//! with `REVEAL_FLAG`, hands it the sealed values on stdin and reads the
//! plain ones back on stdout.
//!
//! `process.stdin` is a list of [`StdinEvent`]s the caller delivers, and the
//! timers of `readStdin` are its `Timeout` event and the caller's own write.

use std::fs;

use jscompat::{JsObject, JsonValue, base64, buffer_from_base64, json_parse, json_stringify};

use crate::node_fs::NodeError;
use crate::packages::ai_provider::jsval::{
    Obj, as_record, entries_of, length16, prop, spread, text,
};
use crate::packages::ai_provider::settings_secrets::{
    AiSecretCodec, CodecThrow, SEALED_PREFIX, is_sealed_secret, map_ai_secrets, open_secret_value,
    seal_ai_secrets, seal_secret_value,
};
use crate::packages::electron_utils::atomic_write::write_json_atomic;

/// `SafeStorageLike`: what the codec calls on Electron's `safeStorage`.
pub trait SafeStorageLike {
    fn is_encryption_available(&self) -> bool;
    /// `encryptString(plain)`: the bytes of the buffer
    fn encrypt_string(&self, plain: &str) -> Result<Vec<u8>, CodecThrow>;
    /// `decryptString(sealed)`
    fn decrypt_string(&self, sealed: &[u8]) -> Result<String, CodecThrow>;
    /// `getSelectedStorageBackend?.()`, Linux only: which password store holds
    /// the key; `None` where the method is missing
    fn get_selected_storage_backend(&self) -> Option<String> {
        None
    }
}

/// Linux password stores that really protect the key. Without a keyring
/// Chromium falls back to `basic_text`, a key built into the program.
const LINUX_KEYRINGS: [&str; 4] = ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"];

/// `linuxKeyringSeals(storage)`: whether a real keyring holds the safeStorage
/// key (Linux only).
pub fn linux_keyring_seals(storage: &dyn SafeStorageLike) -> bool {
    let backend = storage.get_selected_storage_backend().unwrap_or_default();
    LINUX_KEYRINGS.contains(&backend.as_str())
}

/// `platformSeals(storage, platform)`: whether this platform seals at all,
/// apart from the key being ready. `platform` is `process.platform`.
pub fn platform_seals(storage: &dyn SafeStorageLike, platform: &str) -> bool {
    if !storage.is_encryption_available() {
        return false;
    }
    if platform == "win32" {
        return true;
    }
    if platform == "linux" {
        return linux_keyring_seals(storage);
    }
    false
}

/// `sealingKeyOnDisk(localStatePath)`: whether Chromium's key for safeStorage
/// is on disk yet (`Local State`, `os_crypt.encrypted_key`).
pub fn sealing_key_on_disk(local_state_path: &str) -> bool {
    let Ok(bytes) = fs::read(local_state_path) else {
        return false;
    };
    let Ok(state) = json_parse(&String::from_utf8_lossy(&bytes)) else {
        return false;
    };
    matches!(
        prop(&state, "os_crypt").and_then(|c| prop(c, "encrypted_key")),
        Some(JsonValue::String(key)) if !key.is_empty()
    )
}

/// `safeStorageCodec(storage, platform, keyOnDisk)`
pub struct SafeStorageCodec<'a> {
    pub storage: &'a dyn SafeStorageLike,
    /// `process.platform`
    pub platform: &'a str,
    /// Windows: values stay plain until this says the key would survive a crash
    pub key_on_disk: &'a dyn Fn() -> bool,
}

impl AiSecretCodec for SafeStorageCodec<'_> {
    fn seal(&self, plain: &str) -> Result<Option<String>, CodecThrow> {
        // Linux keeps the key in the keyring itself, so only Windows waits for Local State
        if platform_seals(self.storage, self.platform)
            && (self.platform != "win32" || (self.key_on_disk)())
        {
            let bytes = self.storage.encrypt_string(plain)?;
            Ok(Some(format!("{SEALED_PREFIX}{}", base64(&bytes))))
        } else {
            Ok(None)
        }
    }

    fn open(&self, sealed: &str) -> Result<Option<String>, CodecThrow> {
        if !sealed.starts_with(SEALED_PREFIX) || !self.storage.is_encryption_available() {
            return Ok(None);
        }
        let buffer = buffer_from_base64(&sealed[SEALED_PREFIX.len()..]);
        Ok(self.storage.decrypt_string(&buffer).ok())
    }
}

/// `holdsPlainSecrets(stored)`: whether a stored settings object still holds a
/// plain, non-empty key or token.
pub fn holds_plain_secrets(stored: &JsonValue) -> bool {
    let mut found = false;
    map_ai_secrets(stored, &mut |v| {
        if !v.is_empty() && !v.starts_with(SEALED_PREFIX) {
            found = true;
        }
        v.to_owned()
    });
    found
}

/// `sealStoredAiSettings(path)`: seal the plain keys an existing file holds.
/// Leaves the file alone when it cannot be read, holds nothing plain, or this
/// PC cannot seal. Returns whether it rewrote the file.
pub fn seal_stored_ai_settings(
    codec: Option<&dyn AiSecretCodec>,
    path: &str,
) -> Result<bool, NodeError> {
    let stored = (|| {
        if !std::path::Path::new(path).exists() {
            return None;
        }
        let bytes = fs::read(path).ok()?;
        json_parse(&String::from_utf8_lossy(&bytes)).ok()
    })();
    let Some(stored) = stored else {
        return Ok(false);
    };
    if !holds_plain_secrets(&stored) {
        return Ok(false);
    }
    let sealed = seal_ai_secrets(codec, &stored);
    if holds_plain_secrets(&sealed) {
        return Ok(false);
    }
    write_json_atomic(path, &sealed)?;
    Ok(true)
}

/// `Object.fromEntries(Object.entries(keys).map(...))` over a value that is
/// an object (an array too), one value mapped.
fn map_entries(keys: &JsonValue, f: &mut dyn FnMut(&JsonValue) -> JsonValue) -> JsonValue {
    // `Object.fromEntries` writes each key as an own property, `__proto__` too
    let mut out = Obj::new();
    for (id, value) in entries_of(keys) {
        out.set(id, f(&value));
    }
    JsonValue::Object(out)
}

/// `openFileSearchKeys(stored)`: the home search's reranking keys
/// (`fileSearch.keys` in app-settings.json) under the same protection. Opened
/// before the settings are normalized, sealed after.
pub fn open_file_search_keys(codec: Option<&dyn AiSecretCodec>, stored: &JsonValue) -> JsonValue {
    // `typeof stored !== 'object' || stored === null`
    if !matches!(stored, JsonValue::Object(_) | JsonValue::Array(_)) {
        return stored.clone();
    }
    let open = |keys: &JsonValue| -> JsonValue {
        if matches!(keys, JsonValue::Object(_) | JsonValue::Array(_)) {
            map_entries(keys, &mut |v| match v {
                JsonValue::String(t) => text(open_secret_value(codec, t)),
                other => other.clone(),
            })
        } else {
            keys.clone()
        }
    };
    let mut out = spread(Some(stored));
    let source = as_record(stored);
    if let Some(keys) = source.and_then(|s| s.get("keys")) {
        out.set("keys", open(keys));
    }
    if let Some(keys) = source.and_then(|s| s.get("jevKeys")) {
        out.set("jevKeys", open(keys));
    }
    JsonValue::Object(out)
}

/// `sealFileSearchKeys(settings)`
pub fn seal_file_search_keys(codec: Option<&dyn AiSecretCodec>, settings: &JsonValue) -> JsonValue {
    let mut out = spread(Some(settings));
    if let Some(keys) = prop(settings, "keys") {
        out.set(
            "keys",
            map_entries(keys, &mut |v| match v {
                JsonValue::String(t) => text(seal_secret_value(codec, t)),
                other => other.clone(),
            }),
        );
    }
    JsonValue::Object(out)
}

/// `fileSearchHoldsPlainKeys(stored)`: whether stored reranking settings still
/// hold a plain, non-empty key.
pub fn file_search_holds_plain_keys(stored: &JsonValue) -> bool {
    let Some(keys) = prop(stored, "keys") else {
        return false;
    };
    matches!(keys, JsonValue::Object(_) | JsonValue::Array(_))
        && entries_of(keys).iter().any(|(_, v)| {
            matches!(v, JsonValue::String(t) if !t.is_empty() && !t.starts_with(SEALED_PREFIX))
        })
}

/// The hidden entry the terminal command starts to open sealed values
pub const REVEAL_FLAG: &str = "--reveal-ai-secrets";
pub const MAX_REVEAL_VALUES: usize = 64;
const MAX_SEALED_LENGTH: usize = 16_384;
const MAX_STDIN_BYTES: usize = 2 * 1024 * 1024;
/// the limit `readStdin` waits for the end of stdin: its `Timeout` event
pub const STDIN_TIMEOUT_MS: f64 = 5_000.0;

/// `revealRequestOf(text)`: the sealed values a reveal request asks for, or
/// `None` when it is not one.
pub fn reveal_request_of(request: &str) -> Option<Vec<String>> {
    let raw = json_parse(request).ok()?;
    let JsonValue::Array(items) = raw else {
        return None;
    };
    if items.len() > MAX_REVEAL_VALUES {
        return None;
    }
    let mut values = Vec::new();
    for v in &items {
        if !is_sealed_secret(v) {
            return None;
        }
        let JsonValue::String(t) = v else {
            return None;
        };
        if length16(t) > MAX_SEALED_LENGTH {
            return None;
        }
        values.push(t.clone());
    }
    Some(values)
}

/// `revealAnswer(values, codec)`: the answer line: every value this PC could
/// open, keyed by its sealed form.
pub fn reveal_answer(
    values: Option<&[String]>,
    codec: &dyn AiSecretCodec,
) -> Result<String, CodecThrow> {
    let Some(values) = values else {
        let mut answer: JsObject<JsonValue> = JsObject::new();
        answer.set("status", text("error"));
        answer.set("error", text("bad request"));
        return Ok(json_stringify(&JsonValue::Object(answer)));
    };
    let mut secrets: Obj = Obj::new();
    for v in values {
        if let Some(plain) = codec.open(v)? {
            secrets.set(v.as_str(), text(plain));
        }
    }
    let mut answer: Obj = Obj::new();
    answer.set("status", text("ok"));
    answer.set("secrets", JsonValue::Object(secrets));
    Ok(json_stringify(&JsonValue::Object(answer)))
}

/// What happens to `process.stdin` while `readStdin` waits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StdinEvent {
    Data(Vec<u8>),
    End,
    Error,
    /// the five-second timer
    Timeout,
}

/// `readStdin()`: the text of stdin, read until its end, an error, the
/// timeout, or more than 2 MiB (which leaves nothing).
pub fn read_stdin(events: impl IntoIterator<Item = StdinEvent>) -> String {
    let mut chunks: Vec<u8> = Vec::new();
    let mut size = 0usize;
    for event in events {
        match event {
            StdinEvent::Data(chunk) => {
                size += chunk.len();
                if size > MAX_STDIN_BYTES {
                    return String::new();
                }
                chunks.extend_from_slice(&chunk);
            }
            StdinEvent::End | StdinEvent::Error | StdinEvent::Timeout => break,
        }
    }
    // Buffer.concat(chunks).toString('utf8'): a BOM stays
    String::from_utf8_lossy(&chunks).into_owned()
}

/// `runRevealEntry(codec)` without the process: the line to print and the
/// exit code. The caller writes the line to stdout, waiting for the write for
/// at most two seconds.
pub fn run_reveal_entry(
    codec: &dyn AiSecretCodec,
    stdin: impl IntoIterator<Item = StdinEvent>,
) -> Result<(String, i32), CodecThrow> {
    let request = read_stdin(stdin);
    let values = reveal_request_of(&request);
    let line = reveal_answer(values.as_deref(), codec)? + "\n";
    let code = if line.starts_with("{\"status\":\"ok\"") {
        0
    } else {
        1
    };
    Ok((line, code))
}
