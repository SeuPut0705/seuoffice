//! Chromium OSCrypt `v10` blobs, the format Electron `safeStorage` writes.
//!
//! macOS:   `v10` + AES-128-CBC(PKCS7), key = PBKDF2-HMAC-SHA1(keychain
//!          password, "saltysalt", 1003 rounds, 16 bytes), IV = 16 spaces.
//! Windows: `v10` + 12-byte nonce + AES-256-GCM(ciphertext || 16-byte tag),
//!          key = DPAPI-unprotected `os_crypt.encrypted_key` of `Local State`.

use crate::OpenError;
use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};

pub const V10: &[u8] = b"v10";
const MAC_SALT: &[u8] = b"saltysalt";
const MAC_ROUNDS: u32 = 1003;
const MAC_IV: [u8; 16] = [b' '; 16];
const WIN_NONCE_LEN: usize = 12;
const WIN_TAG_LEN: usize = 16;

pub fn mac_key_from_password(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, MAC_SALT, MAC_ROUNDS, &mut key);
    key
}

pub fn strip_v10(blob: &[u8]) -> Result<&[u8], OpenError> {
    match blob.strip_prefix(V10) {
        Some(body) => Ok(body),
        None => {
            let head: Vec<String> = blob.iter().take(4).map(|b| format!("{b:02x}")).collect();
            Err(OpenError::new(
                "format",
                format!("not a v10 blob (first bytes {})", head.join(" ")),
            ))
        }
    }
}

pub fn decrypt_mac(key: &[u8; 16], body: &[u8]) -> Result<Vec<u8>, OpenError> {
    cbc::Decryptor::<aes::Aes128>::new(key.into(), &MAC_IV.into())
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .map_err(|_| OpenError::new("decrypt", "AES-128-CBC/PKCS7 failed (wrong key or damaged blob)"))
}

pub fn decrypt_win(key: &[u8], body: &[u8]) -> Result<Vec<u8>, OpenError> {
    if body.len() < WIN_NONCE_LEN + WIN_TAG_LEN {
        return Err(OpenError::new("format", "v10 body shorter than nonce + tag"));
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| OpenError::new("key", format!("AES-256 key must be 32 bytes, got {}", key.len())))?;
    let (nonce, sealed) = body.split_at(WIN_NONCE_LEN);
    cipher
        .decrypt(Nonce::from_slice(nonce), sealed)
        .map_err(|_| OpenError::new("decrypt", "AES-256-GCM tag mismatch (wrong key or damaged blob)"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::BlockEncryptMut;

    #[test]
    fn pbkdf2_known_answer() {
        // python3: hashlib.pbkdf2_hmac('sha1', b'peanuts', b'saltysalt', 1003, 16).hex()
        assert_eq!(
            mac_key_from_password(b"peanuts"),
            [0xd9, 0xa0, 0x9d, 0x49, 0x9b, 0x4e, 0x1b, 0x74, 0x61, 0xf2, 0x8e, 0x67, 0x97, 0x2c, 0x6d, 0xbd]
        );
    }

    #[test]
    fn mac_roundtrip_non_ascii() {
        let key = mac_key_from_password(b"some-keychain-password");
        let plain = "sk-test-한글-✓-0001".as_bytes();
        let ct = cbc::Encryptor::<aes::Aes128>::new((&key).into(), &MAC_IV.into())
            .encrypt_padded_vec_mut::<Pkcs7>(plain);
        assert_eq!(decrypt_mac(&key, &ct).unwrap(), plain);
        assert!(decrypt_mac(&mac_key_from_password(b"other"), &ct).is_err());
    }

    #[test]
    fn win_roundtrip_non_ascii() {
        let key = [7u8; 32];
        let nonce = [9u8; 12];
        let plain = "sk-test-한글-✓-0001".as_bytes();
        let ct = Aes256Gcm::new_from_slice(&key).unwrap().encrypt(Nonce::from_slice(&nonce), plain).unwrap();
        let mut body = nonce.to_vec();
        body.extend(ct);
        assert_eq!(decrypt_win(&key, &body).unwrap(), plain);
        body[20] ^= 1;
        assert!(decrypt_win(&key, &body).is_err());
    }

    #[test]
    fn rejects_foreign_prefix() {
        assert!(strip_v10(b"v11abc").is_err());
        assert_eq!(strip_v10(b"v10abc").unwrap(), b"abc");
    }
}
