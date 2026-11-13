//! Electron's `safeStorage` for the shell: the same values under the same
//! key, so nothing stored by the Electron build is re-sealed or lost, and a
//! fall back to the Electron build still opens what the shell sealed.
//!
//! The key is where Chromium keeps it: the keychain item `<name> Safe
//! Storage` on macOS, `os_crypt.encrypted_key` of `<userData>/Local State`
//! under DPAPI on Windows. Elsewhere encryption is not available; the
//! callers then keep values plain, as they did on Linux without a keyring.

mod oscrypt;
mod platform;

use std::path::PathBuf;
use std::sync::OnceLock;

use main_core::packages::ai_provider::settings_secrets::CodecThrow;
use main_core::shell::ai_secrets::SafeStorageLike;

pub use oscrypt::{Key, Opened};

const ENCRYPT_UNAVAILABLE: &str = "Error while encrypting the text provided to safeStorage.encryptString. Encryption is not available.";
const DECRYPT_UNAVAILABLE: &str = "Error while decrypting the ciphertext provided to safeStorage.decryptString. Decryption is not available.";
const DECRYPT_FAILED: &str =
    "Error while decrypting the ciphertext provided to safeStorage.decryptString.";

/// Where the key lives: the app name Electron had when it made it, and the
/// userData folder
#[derive(Clone, Debug)]
pub struct KeyPlace {
    /// `app.getName()` before ready: `seuoffice` for the installed app
    /// (decision 0019)
    pub app_name: String,
    pub user_data: PathBuf,
}

impl KeyPlace {
    pub fn keychain_service(&self) -> String {
        format!("{} Safe Storage", self.app_name)
    }

    pub fn keychain_account(&self) -> String {
        format!("{} Key", self.app_name)
    }

    pub fn local_state(&self) -> PathBuf {
        self.user_data.join("Local State")
    }
}

/// `safeStorage`. The key is read (or made, when there is none yet) the
/// first time a value is sealed or opened, as Chromium does; on macOS that
/// read may show the keychain's prompt once for a new build (decision 0029).
pub struct OsSafeStorage {
    place: KeyPlace,
    key: OnceLock<Option<Key>>,
}

impl OsSafeStorage {
    pub fn new(place: KeyPlace) -> Self {
        OsSafeStorage {
            place,
            key: OnceLock::new(),
        }
    }

    fn key(&self) -> Option<&Key> {
        self.key
            .get_or_init(|| platform::load_or_create_key(&self.place))
            .as_ref()
    }

    pub fn is_encryption_available(&self) -> bool {
        self.key().is_some()
    }

    pub fn encrypt_string(&self, plain: &str) -> Result<Vec<u8>, String> {
        let key = self.key().ok_or(ENCRYPT_UNAVAILABLE)?;
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).map_err(|e| e.to_string())?;
        Ok(key.seal(plain.as_bytes(), nonce))
    }

    pub fn decrypt_string(&self, sealed: &[u8]) -> Result<String, String> {
        let key = self.key().ok_or(DECRYPT_UNAVAILABLE)?;
        let plain = match key.open(sealed) {
            Opened::Plain(plain) => plain,
            Opened::Failed => return Err(DECRYPT_FAILED.into()),
            Opened::Unprefixed => platform::open_unprefixed(sealed).ok_or(DECRYPT_FAILED)?,
        };
        Ok(String::from_utf8_lossy(&plain).into_owned())
    }
}

impl SafeStorageLike for OsSafeStorage {
    fn is_encryption_available(&self) -> bool {
        OsSafeStorage::is_encryption_available(self)
    }

    fn encrypt_string(&self, plain: &str) -> Result<Vec<u8>, CodecThrow> {
        OsSafeStorage::encrypt_string(self, plain).map_err(CodecThrow)
    }

    fn decrypt_string(&self, sealed: &[u8]) -> Result<String, CodecThrow> {
        OsSafeStorage::decrypt_string(self, sealed).map_err(CodecThrow)
    }
}

/// A random keychain password as Chromium makes one: base64 of 16 bytes
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn new_keychain_password() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    Some(jscompat::base64(&bytes))
}
