//! `apps/shell/src/main/drive/drive-vault.ts`: the Drive refresh token in
//! `google-drive.json` in the data folder, always encrypted. Where encryption
//! is not available nothing is written and the connection lasts only until
//! the app closes (decision 0033): the token can change every Drive file, so
//! it is never kept as plain text.
//!
//! The Drive connection (`TokenVault` of connection.ts) is not in main-core
//! yet; the host that builds it calls [`DriveVault`]'s three methods from the
//! `load`, `save` and `clear` of its vault.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use jscompat::{JsObject, JsonValue, base64, buffer_from_base64, json_parse, json_stringify};
use main_core::shell::ai_secrets::{SafeStorageLike, linux_keyring_seals};
use main_core::shell::atomic_write::atomic_write_file;

use crate::secrets::OsSafeStorage;

/// `SecretCipher`: the operating system's encryption for one secret (Electron
/// safeStorage: DPAPI on Windows, the keychain on macOS). Injected so tests
/// run without the operating system.
pub trait SecretCipher: Send + Sync {
    fn available(&self) -> bool;
    fn encrypt(&self, text: &str) -> Result<Vec<u8>, String>;
    fn decrypt(&self, bytes: &[u8]) -> Result<String, String>;
}

/// `driveTokenSeals(storage, platform)`: whether safeStorage really protects
/// the Drive token here. Windows (DPAPI) and macOS (the keychain) do. On
/// Linux without a keyring Chromium reports encryption as available but uses
/// `basic_text`, a key built into the program, so the token would only look
/// sealed: that counts as no encryption. `platform` is `process.platform`.
pub fn drive_token_seals(storage: &dyn SafeStorageLike, platform: &str) -> bool {
    if !storage.is_encryption_available() {
        return false;
    }
    if platform == "linux" {
        return linux_keyring_seals(storage);
    }
    true
}

/// The cipher `registerDriveIpc` builds over `safeStorage`
pub struct SafeStorageCipher {
    storage: Arc<dyn SafeStorageLike + Send + Sync>,
    platform: String,
}

impl SafeStorageCipher {
    /// `platform` is `process.platform`
    pub fn new(storage: Arc<dyn SafeStorageLike + Send + Sync>, platform: &str) -> Self {
        SafeStorageCipher {
            storage,
            platform: platform.to_owned(),
        }
    }

    /// The cipher over the shell's `safeStorage` ([`OsSafeStorage`]) on this
    /// platform, as `registerDriveIpc` builds it
    pub fn over_os(storage: Arc<OsSafeStorage>) -> Self {
        let platform = if cfg!(target_os = "macos") {
            "darwin"
        } else if cfg!(windows) {
            "win32"
        } else {
            "linux"
        };
        Self::new(storage, platform)
    }
}

impl SecretCipher for SafeStorageCipher {
    fn available(&self) -> bool {
        drive_token_seals(&*self.storage, &self.platform)
    }

    fn encrypt(&self, text: &str) -> Result<Vec<u8>, String> {
        self.storage.encrypt_string(text).map_err(|e| e.0)
    }

    fn decrypt(&self, bytes: &[u8]) -> Result<String, String> {
        self.storage.decrypt_string(bytes).map_err(|e| e.0)
    }
}

/// `TokenVault`
pub struct DriveVault {
    file_path: PathBuf,
    cipher: Arc<dyn SecretCipher>,
}

/// `createDriveVault(filePath, cipher)`
pub fn create_drive_vault(
    file_path: impl Into<PathBuf>,
    cipher: Arc<dyn SecretCipher>,
) -> DriveVault {
    DriveVault {
        file_path: file_path.into(),
        cipher,
    }
}

impl DriveVault {
    /// `vault.load()`: the kept refresh token; none when the file is missing,
    /// unreadable or damaged, holds another version, was encrypted by another
    /// user or PC, or this PC cannot decrypt now
    pub fn load(&self) -> Option<String> {
        let bytes = fs::read(&self.file_path).ok()?;
        let raw = json_parse(&String::from_utf8_lossy(&bytes)).ok()?;
        let JsonValue::Object(raw) = raw else {
            return None;
        };
        let (Some(JsonValue::Number(version)), Some(JsonValue::String(token))) =
            (raw.get("version"), raw.get("token"))
        else {
            return None;
        };
        if *version != 1.0 || !self.cipher.available() {
            return None;
        }
        let token = self.cipher.decrypt(&buffer_from_base64(token)).ok()?;
        (!token.is_empty()).then_some(token)
    }

    /// `vault.save(refreshToken)`: false when the token could not be kept (no
    /// encryption here, or the write failed): the connection then lasts this
    /// run only
    pub fn save(&self, refresh_token: &str) -> bool {
        if !self.cipher.available() {
            return false;
        }
        let Ok(sealed) = self.cipher.encrypt(refresh_token) else {
            return false;
        };
        let mut file = JsObject::new();
        file.set("version", JsonValue::Number(1.0));
        file.set("token", JsonValue::String(base64(&sealed)));
        let text = json_stringify(&JsonValue::Object(file));
        atomic_write_file(&self.file_path.to_string_lossy(), text.as_bytes()).is_ok()
    }

    /// `vault.clear()`
    pub fn clear(&self) {
        let _ = fs::remove_file(&self.file_path);
    }
}

#[cfg(test)]
mod tests {
    use main_core::packages::ai_provider::settings_secrets::CodecThrow;

    use super::*;

    /// seals by reversing the bytes behind a marker; `owner` is the "user"
    /// whose key it is, so a value sealed by another one does not open
    struct Storage {
        available: bool,
        backend: Option<&'static str>,
        owner: &'static str,
    }

    impl SafeStorageLike for Storage {
        fn is_encryption_available(&self) -> bool {
            self.available
        }
        fn encrypt_string(&self, plain: &str) -> Result<Vec<u8>, CodecThrow> {
            let mut out = format!("{}:", self.owner).into_bytes();
            out.extend(plain.bytes().rev());
            Ok(out)
        }
        fn decrypt_string(&self, sealed: &[u8]) -> Result<String, CodecThrow> {
            let head = format!("{}:", self.owner);
            let body = sealed
                .strip_prefix(head.as_bytes())
                .ok_or_else(|| CodecThrow("not sealed by this user".into()))?;
            Ok(String::from_utf8(body.iter().rev().copied().collect()).unwrap())
        }
        fn get_selected_storage_backend(&self) -> Option<String> {
            self.backend.map(str::to_owned)
        }
    }

    fn storage(available: bool, owner: &'static str) -> Arc<Storage> {
        Arc::new(Storage {
            available,
            backend: None,
            owner,
        })
    }

    fn vault_in(name: &str, storage: Arc<Storage>, platform: &str) -> (DriveVault, PathBuf) {
        let dir = std::env::temp_dir().join(format!("shell-a-vault-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("google-drive.json");
        let cipher = Arc::new(SafeStorageCipher::new(storage, platform));
        (create_drive_vault(path.clone(), cipher), path)
    }

    #[test]
    fn a_token_is_kept_sealed_and_read_back() {
        let (vault, path) = vault_in("sealed", storage(true, "me"), "darwin");
        assert!(vault.save("1//refresh-token"));
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("refresh-token"), "{on_disk}");
        assert_eq!(vault.load().as_deref(), Some("1//refresh-token"));
    }

    #[test]
    fn nothing_is_written_where_encryption_is_not_available() {
        let (vault, path) = vault_in("none", storage(false, "me"), "win32");
        assert!(!vault.save("1//refresh-token"));
        assert!(!path.exists());
        assert_eq!(vault.load(), None);
    }

    #[test]
    fn linux_counts_only_with_a_real_keyring() {
        let basic = Arc::new(Storage {
            available: true,
            backend: Some("basic_text"),
            owner: "me",
        });
        let (vault, path) = vault_in("basic", basic.clone(), "linux");
        assert!(!vault.save("t"));
        assert!(!path.exists());
        assert!(!drive_token_seals(&*basic, "linux"));
        assert!(drive_token_seals(&*basic, "darwin"));
        let keyring = Storage {
            available: true,
            backend: Some("gnome_libsecret"),
            owner: "me",
        };
        assert!(drive_token_seals(&keyring, "linux"));
    }

    #[test]
    fn a_token_another_user_sealed_or_a_damaged_file_is_none() {
        let (mine, path) = vault_in("foreign", storage(true, "me"), "darwin");
        assert!(mine.save("secret"));
        let theirs = create_drive_vault(
            path.clone(),
            Arc::new(SafeStorageCipher::new(storage(true, "them"), "darwin")),
        );
        assert_eq!(theirs.load(), None);

        for damaged in [
            "not json",
            "null",
            "[]",
            r#"{"version":2,"token":"AAAA"}"#,
            r#"{"version":1}"#,
            r#"{"version":1,"token":7}"#,
            r#"{"version":1,"token":""}"#,
        ] {
            fs::write(&path, damaged).unwrap();
            assert_eq!(mine.load(), None, "{damaged}");
        }
        fs::remove_file(&path).unwrap();
        assert_eq!(mine.load(), None);
    }

    #[test]
    fn a_sealed_token_stays_closed_while_encryption_is_unavailable() {
        let (vault, path) = vault_in("later", storage(true, "me"), "darwin");
        assert!(vault.save("secret"));
        let locked = create_drive_vault(
            path,
            Arc::new(SafeStorageCipher::new(storage(false, "me"), "darwin")),
        );
        assert_eq!(locked.load(), None);
    }

    #[test]
    fn clear_removes_the_file_and_forgives_a_missing_one() {
        let (vault, path) = vault_in("clear", storage(true, "me"), "darwin");
        assert!(vault.save("secret"));
        vault.clear();
        assert!(!path.exists());
        vault.clear();
    }
}
