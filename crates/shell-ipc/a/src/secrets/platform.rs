//! Where each OS keeps the safeStorage key, and Chromium's values from before
//! the `v10` prefix.

use super::{Key, KeyPlace};

#[cfg(target_os = "macos")]
mod imp {
    use security_framework::passwords::{get_generic_password, set_generic_password};

    use super::{Key, KeyPlace};

    /// errSecItemNotFound: no app has made the item yet
    const ITEM_NOT_FOUND: i32 = -25300;

    pub fn load_or_create_key(place: &KeyPlace) -> Option<Key> {
        let (service, account) = (place.keychain_service(), place.keychain_account());
        let password = match get_generic_password(&service, &account) {
            Ok(password) => password,
            // only a missing item is made anew: a refused or failed read keeps
            // the item, so the values sealed under it stay openable later
            Err(e) if e.code() == ITEM_NOT_FOUND => {
                let password = super::super::new_keychain_password()?;
                set_generic_password(&service, &account, password.as_bytes()).ok()?;
                password.into_bytes()
            }
            Err(_) => return None,
        };
        Some(Key::mac_from_password(&password))
    }

    /// Chromium on macOS took a value without the prefix as plain text
    pub fn open_unprefixed(value: &[u8]) -> Option<Vec<u8>> {
        Some(value.to_vec())
    }
}

#[cfg(windows)]
mod imp {
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    use super::{Key, KeyPlace};

    const DPAPI_PREFIX: &[u8] = b"DPAPI";

    fn blob(data: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        }
    }

    /// Copies DPAPI's output and frees it
    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: on success DPAPI hands back a LocalAlloc'd buffer of
        // `cbData` bytes, read once here and freed
        unsafe {
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData.cast());
            bytes
        }
    }

    fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        let input = blob(data);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        // SAFETY: `input` points at `data` for the whole call
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        (ok != 0).then(|| take(out))
    }

    fn protect(data: &[u8]) -> Option<Vec<u8>> {
        let input = blob(data);
        let mut out = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: null_mut(),
        };
        // SAFETY: `input` points at `data` for the whole call
        let ok = unsafe {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            )
        };
        (ok != 0).then(|| take(out))
    }

    pub fn load_or_create_key(place: &KeyPlace) -> Option<Key> {
        let path = place.local_state();
        let mut state = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes).ok()?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
            Err(_) => return None,
        };
        if let Some(stored) = state["os_crypt"]["encrypted_key"].as_str() {
            let raw = jscompat::buffer_from_base64(stored);
            let key = unprotect(raw.strip_prefix(DPAPI_PREFIX)?)?;
            return Some(Key::Win(key.try_into().ok()?));
        }
        // no key yet: make one where Chromium would, keeping the file's other keys
        let mut key = [0u8; 32];
        getrandom::fill(&mut key).ok()?;
        let mut stored = DPAPI_PREFIX.to_vec();
        stored.extend(protect(&key)?);
        let root = state.as_object_mut()?;
        let os_crypt = root
            .entry("os_crypt")
            .or_insert_with(|| serde_json::json!({}))
            .as_object_mut()?;
        os_crypt.insert(
            "encrypted_key".into(),
            serde_json::Value::String(jscompat::base64(&stored)),
        );
        let text = serde_json::to_vec(&state).ok()?;
        let tmp = path.with_extension("seuoffice-tmp");
        std::fs::create_dir_all(path.parent()?).ok()?;
        std::fs::write(&tmp, text).ok()?;
        std::fs::rename(&tmp, &path).ok()?;
        Some(Key::Win(key))
    }

    /// Chromium on Windows sealed values with DPAPI alone before `v10`
    pub fn open_unprefixed(value: &[u8]) -> Option<Vec<u8>> {
        unprotect(value)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::{Key, KeyPlace};

    /// Releases are macOS and Windows only; a Linux shell (the runners)
    /// keeps values plain, as the Electron build did without a keyring
    pub fn load_or_create_key(_: &KeyPlace) -> Option<Key> {
        None
    }

    pub fn open_unprefixed(_: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

pub use imp::{load_or_create_key, open_unprefixed};
