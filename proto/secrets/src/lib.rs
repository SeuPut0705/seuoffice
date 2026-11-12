//! Open Electron `safeStorage` secrets from outside Electron (throwaway proof).
//!
//! `sealed:v1:<base64 of the safeStorage blob>` and bare base64 blobs are both
//! accepted. The key comes from the OS the same way Chromium OSCrypt gets it:
//! the macOS login keychain item `<app name> Safe Storage`, or Windows DPAPI
//! applied to `os_crypt.encrypted_key` in `<userData>/Local State`.

mod format;
mod platform;

use base64::{engine::general_purpose::STANDARD, Engine};
use std::fmt;
use std::path::PathBuf;
use std::sync::OnceLock;

pub use platform::{probe_keychain_item, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE};

pub const SEALED_PREFIX: &str = "sealed:v1:";

/// A failure with the stage that produced it and, when the OS gave one, its code
/// (macOS OSStatus, Windows HRESULT/Win32 error).
#[derive(Debug, Clone)]
pub struct OpenError {
    pub stage: &'static str,
    pub message: String,
    pub os_code: Option<i32>,
}

impl OpenError {
    pub fn new(stage: &'static str, message: impl Into<String>) -> Self {
        Self { stage, message: message.into(), os_code: None }
    }
    pub fn os(stage: &'static str, message: impl Into<String>, code: i32) -> Self {
        Self { stage, message: message.into(), os_code: Some(code) }
    }
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.stage, self.message)?;
        if let Some(code) = self.os_code {
            write!(f, " (os code {code})")?;
        }
        Ok(())
    }
}

impl std::error::Error for OpenError {}

/// The raw safeStorage blob inside a `sealed:v1:` string or a bare base64 string.
pub fn blob_of(sealed_or_raw: &str) -> Result<Vec<u8>, OpenError> {
    let b64 = sealed_or_raw.strip_prefix(SEALED_PREFIX).unwrap_or(sealed_or_raw);
    STANDARD
        .decode(b64.trim())
        .map_err(|e| OpenError::new("base64", e.to_string()))
}

/// What a blob looks like, without opening it: safe to print.
pub fn describe_blob(blob: &[u8]) -> String {
    let head: String = blob.iter().take(3).map(|b| if b.is_ascii_graphic() { *b as char } else { '?' }).collect();
    format!("prefix={head} bytes={} body_mod16={}", blob.len(), blob.len().saturating_sub(3) % 16)
}

pub struct Options {
    /// macOS only: let the keychain show its access prompt. Off by default so a
    /// refused access fails with an OS code instead of waiting for a click.
    pub allow_interaction: bool,
    pub keychain_service: String,
    pub keychain_account: String,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            allow_interaction: false,
            keychain_service: KEYCHAIN_SERVICE.into(),
            keychain_account: KEYCHAIN_ACCOUNT.into(),
        }
    }
}

/// Opens blobs sealed under one userData folder; the OS key is fetched once.
pub struct Opener {
    user_data: PathBuf,
    options: Options,
    key: OnceLock<Result<Vec<u8>, OpenError>>,
}

impl Opener {
    pub fn new(user_data: impl Into<PathBuf>, options: Options) -> Self {
        Self { user_data: user_data.into(), options, key: OnceLock::new() }
    }

    fn key(&self) -> Result<&[u8], OpenError> {
        self.key
            .get_or_init(|| platform::os_key(&self.user_data, &self.options))
            .as_ref()
            .map(|k| k.as_slice())
            .map_err(Clone::clone)
    }

    pub fn open_blob(&self, blob: &[u8]) -> Result<String, OpenError> {
        let body = format::strip_v10(blob)?;
        let key = self.key()?;
        let plain = platform::decrypt(key, body)?;
        String::from_utf8(plain).map_err(|_| OpenError::new("decode", "plaintext is not UTF-8"))
    }

    pub fn open(&self, sealed_or_raw: &str) -> Result<String, OpenError> {
        self.open_blob(&blob_of(sealed_or_raw)?)
    }
}
