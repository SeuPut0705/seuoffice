//! `apps/shell/src/main/mcp-client/secrets.ts`: the secrets of user MCP
//! servers (spec 10): header values, the OAuth client secret and tokens, and
//! env values of local servers. On disk they are sealed with the operating
//! system's encryption; where that is unavailable the file field stays empty
//! and the value lives in memory until the app closes.
//!
//! The TypeScript is generic over `T extends McpSecretFields` and only ever
//! used with `McpServerConfig`; here the functions take that type.
//!
//! Assumed API of the `deps` slice: `shell::drive::drive_vault::drive_token_seals(
//! storage: &dyn SafeStorageLike, platform: &str) -> bool`.

use std::rc::Rc;

use jscompat::{JsObject, JsonValue, base64, buffer_from_base64, slice_utf16};

use super::store::McpServerConfig;
use crate::packages::ai_provider::jsval::length16;
use crate::packages::ai_provider::settings_secrets::{CodecThrow, SEALED_PREFIX, is_sealed_secret};
use crate::shell::ai_secrets::SafeStorageLike;
use crate::shell::drive::drive_vault::drive_token_seals;

/// `McpSecretCodec`
pub trait McpSecretCodec {
    /// whether a value sealed now is really protected (the Drive vault rule)
    fn can_seal(&self) -> bool;
    /// the `sealed:v1:` form; only called when `can_seal()`
    fn seal(&self, plain: &str) -> Result<String, CodecThrow>;
    /// the plain value, or `None` when it cannot be opened here
    fn open(&self, sealed: &str) -> Result<Option<String>, CodecThrow>;
}

/// `safeStorageMcpCodec(storage, platform)`: Electron safeStorage under the
/// same rule as the Drive token. `platform` is `process.platform` by default.
pub struct SafeStorageMcpCodec<'h> {
    pub storage: Rc<dyn SafeStorageLike + 'h>,
    pub platform: String,
}

/// `isSealedSecret(value)` of a string
fn sealed_form(value: &str) -> bool {
    is_sealed_secret(&JsonValue::String(value.to_owned()))
}

impl McpSecretCodec for SafeStorageMcpCodec<'_> {
    fn can_seal(&self) -> bool {
        drive_token_seals(&*self.storage, &self.platform)
    }

    fn seal(&self, plain: &str) -> Result<String, CodecThrow> {
        let bytes = self.storage.encrypt_string(plain)?;
        Ok(format!("{SEALED_PREFIX}{}", base64(&bytes)))
    }

    fn open(&self, sealed: &str) -> Result<Option<String>, CodecThrow> {
        if !sealed_form(sealed) || !self.storage.is_encryption_available() {
            return Ok(None);
        }
        let buffer = buffer_from_base64(&sealed[SEALED_PREFIX.len()..]);
        // sealed by another account or PC: null
        Ok(self.storage.decrypt_string(&buffer).ok())
    }
}

/// `McpSecretRef`: where a secret sits in one server: `headers:<name>`,
/// `env:<name>`, `oauth:clientSecret`, `oauth:tokens`
pub type McpSecretRef = String;

/// `mapValues(record, prefix, fn)`
fn map_values(
    record: &JsObject<String>,
    prefix: &str,
    f: &mut dyn FnMut(&str, &str) -> String,
) -> JsObject<String> {
    record
        .entries()
        .into_iter()
        .map(|(k, v)| (k.to_owned(), f(v, &format!("{prefix}:{k}"))))
        .collect()
}

/// `mapServerSecrets(server, fn)`: apply `f` to every secret value of a
/// server, leaving everything else as it is
pub fn map_server_secrets(
    server: &McpServerConfig,
    f: &mut dyn FnMut(&str, &str) -> String,
) -> McpServerConfig {
    let mut out = server.clone();
    out.headers = map_values(&server.headers, "headers", f);
    out.env = map_values(&server.env, "env", f);
    out.oauth = server.oauth.as_ref().map(|oauth| {
        let mut mapped = oauth.clone();
        mapped.client_secret = f(&oauth.client_secret, "oauth:clientSecret");
        mapped.tokens = f(&oauth.tokens, "oauth:tokens");
        mapped
    });
    out
}

/// `sealServerSecrets(server, codec)`: the form written to the file: each
/// non-empty value sealed, or left empty when this PC cannot seal (the second
/// answer names those, for the card's notice)
pub fn seal_server_secrets(
    server: &McpServerConfig,
    codec: &dyn McpSecretCodec,
) -> (McpServerConfig, Vec<McpSecretRef>) {
    let mut memory_only: Vec<McpSecretRef> = Vec::new();
    let can_seal = codec.can_seal();
    let sealed = map_server_secrets(server, &mut |value, reference| {
        if value.is_empty() || sealed_form(value) {
            return value.to_owned();
        }
        if can_seal {
            // fall through on a throw: an unsealable value is never written plain
            if let Ok(sealed) = codec.seal(value) {
                return sealed;
            }
        }
        memory_only.push(reference.to_owned());
        String::new()
    });
    (sealed, memory_only)
}

/// `openServerSecrets(server, codec)`: the plain form for this run. A value
/// that cannot be opened (sealed by another account or PC) becomes empty and
/// is listed in the second answer; a plain value written by hand is taken as
/// it is and sealed on the next save.
pub fn open_server_secrets(
    server: &McpServerConfig,
    codec: &dyn McpSecretCodec,
) -> (McpServerConfig, Vec<McpSecretRef>) {
    let mut unreadable: Vec<McpSecretRef> = Vec::new();
    let opened = map_server_secrets(server, &mut |value, reference| {
        if !sealed_form(value) {
            return value.to_owned();
        }
        match codec.open(value) {
            Ok(Some(plain)) => plain,
            // a throw reads as null
            Ok(None) | Err(_) => {
                unreadable.push(reference.to_owned());
                String::new()
            }
        }
    });
    (opened, unreadable)
}

/// Shorter values show no characters at all, so the last four never reveal
/// most of one
const MIN_LENGTH_TO_SHOW_LAST4: usize = 8;

/// `McpSecretView`: a secret as a screen may see it
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpSecretView {
    /// `missing`, `memory-only` or `saved`
    pub state: &'static str,
    pub last4: String,
}

impl McpSecretView {
    pub fn to_json(&self) -> JsonValue {
        crate::packages::ai_provider::jsval::object(vec![
            ("state", JsonValue::String(self.state.to_owned())),
            ("last4", JsonValue::String(self.last4.clone())),
        ])
    }
}

/// `secretView(value, memoryOnly)`
pub fn secret_view(value: &str, memory_only: bool) -> McpSecretView {
    if value.is_empty() {
        return McpSecretView {
            state: "missing",
            last4: String::new(),
        };
    }
    McpSecretView {
        state: if memory_only { "memory-only" } else { "saved" },
        last4: if length16(value) >= MIN_LENGTH_TO_SHOW_LAST4 {
            slice_utf16(value, -4.0, None)
        } else {
            String::new()
        },
    }
}
