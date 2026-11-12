//! The per-OS source of the key and the matching cipher.

use crate::{format, OpenError, Options};
use std::path::Path;

pub const KEYCHAIN_SERVICE: &str = "seuoffice Safe Storage";
pub const KEYCHAIN_ACCOUNT: &str = "seuoffice Key";

#[cfg(target_os = "macos")]
mod imp {
    use super::*;
    use security_framework::os::macos::keychain::SecKeychain;

    fn read_item(service: &str, account: &str, allow_interaction: bool) -> Result<Vec<u8>, OpenError> {
        // Without this the legacy keychain API waits on the access prompt; with
        // it a refused item fails at once (errSecInteractionNotAllowed, -25308).
        let _no_ui = if allow_interaction {
            None
        } else {
            Some(
                SecKeychain::disable_user_interaction()
                    .map_err(|e| OpenError::os("keychain", e.to_string(), e.code()))?,
            )
        };
        let keychain = SecKeychain::default().map_err(|e| OpenError::os("keychain", e.to_string(), e.code()))?;
        let (password, _item) = keychain
            .find_generic_password(service, account)
            .map_err(|e| OpenError::os("keychain", e.to_string(), e.code()))?;
        Ok(password.to_vec())
    }

    pub fn os_key(_user_data: &Path, o: &Options) -> Result<Vec<u8>, OpenError> {
        let password = read_item(&o.keychain_service, &o.keychain_account, o.allow_interaction)?;
        Ok(format::mac_key_from_password(&password).to_vec())
    }

    pub fn decrypt(key: &[u8], body: &[u8]) -> Result<Vec<u8>, OpenError> {
        let key: &[u8; 16] = key.try_into().map_err(|_| OpenError::new("key", "mac key must be 16 bytes"))?;
        format::decrypt_mac(key, body)
    }

    /// Reads one generic password and reports only its length.
    pub fn probe_keychain_item(service: &str, account: &str, allow_interaction: bool) -> Result<usize, OpenError> {
        read_item(service, account, allow_interaction).map(|p| p.len())
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    const DPAPI_PREFIX: &[u8] = b"DPAPI";

    fn unprotect(data: &[u8]) -> Result<Vec<u8>, OpenError> {
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB::default();
        // SAFETY: `input` points at `data` for the whole call; on success `out`
        // holds a LocalAlloc'd buffer that is copied and then freed below.
        unsafe {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
                .map_err(|e| OpenError::os("dpapi", e.message(), e.code().0))?;
            let plain = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
            Ok(plain)
        }
    }

    pub fn os_key(user_data: &Path, _o: &Options) -> Result<Vec<u8>, OpenError> {
        let path = user_data.join("Local State");
        let text = std::fs::read_to_string(&path)
            .map_err(|e| OpenError::os("local-state", format!("{}: {e}", path.display()), e.raw_os_error().unwrap_or(0)))?;
        let json: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| OpenError::new("local-state", format!("not JSON: {e}")))?;
        let b64 = json["os_crypt"]["encrypted_key"]
            .as_str()
            .ok_or_else(|| OpenError::new("local-state", "os_crypt.encrypted_key missing"))?;
        let raw = STANDARD.decode(b64).map_err(|e| OpenError::new("local-state", format!("encrypted_key base64: {e}")))?;
        let dpapi = raw
            .strip_prefix(DPAPI_PREFIX)
            .ok_or_else(|| OpenError::new("local-state", "encrypted_key has no DPAPI prefix"))?;
        unprotect(dpapi)
    }

    pub fn decrypt(key: &[u8], body: &[u8]) -> Result<Vec<u8>, OpenError> {
        format::decrypt_win(key, body)
    }

    pub fn probe_keychain_item(_: &str, _: &str, _: bool) -> Result<usize, OpenError> {
        Err(OpenError::new("keychain", "macOS only"))
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::*;

    pub fn os_key(_: &Path, _: &Options) -> Result<Vec<u8>, OpenError> {
        Err(OpenError::new("platform", "only macOS and Windows are covered by this proof"))
    }
    pub fn decrypt(_: &[u8], _: &[u8]) -> Result<Vec<u8>, OpenError> {
        Err(OpenError::new("platform", "unsupported platform"))
    }
    pub fn probe_keychain_item(_: &str, _: &str, _: bool) -> Result<usize, OpenError> {
        Err(OpenError::new("keychain", "macOS only"))
    }
}

pub(crate) use imp::{decrypt, os_key};
pub use imp::probe_keychain_item;
