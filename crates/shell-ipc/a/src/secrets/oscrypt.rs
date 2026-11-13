//! Chromium OSCrypt `v10` values, the bytes Electron's `safeStorage` writes,
//! so the shell opens what the Electron build sealed and the Electron build
//! opens what the shell seals.
//!
//! - macOS: `v10` + AES-128-CBC (PKCS7, IV of 16 spaces); the key is
//!   PBKDF2-HMAC-SHA1 of the keychain password, salt `saltysalt`, 1003
//!   rounds, 16 bytes.
//! - Windows: `v10` + 12-byte nonce + AES-256-GCM (ciphertext and 16-byte
//!   tag); the key is the 32 bytes DPAPI keeps in `Local State`.
//!
//! A value without the prefix is what Chromium wrote before it encrypted:
//! plain on macOS, a bare DPAPI blob on Windows.

use aes::cipher::block_padding::Pkcs7;
use aes::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use aes_gcm::aead::Aead;
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};

pub const V10: &[u8] = b"v10";
const MAC_SALT: &[u8] = b"saltysalt";
const MAC_ROUNDS: u32 = 1003;
const MAC_IV: [u8; 16] = [b' '; 16];
const WIN_NONCE_LEN: usize = 12;
const WIN_TAG_LEN: usize = 16;

/// The key of one platform's values
#[derive(Clone)]
pub enum Key {
    Mac([u8; 16]),
    Win([u8; 32]),
}

impl Key {
    pub fn mac_from_password(password: &[u8]) -> Key {
        let mut key = [0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, MAC_SALT, MAC_ROUNDS, &mut key);
        Key::Mac(key)
    }

    /// `v10` and the ciphertext of `plain`; `nonce` is used by the Windows
    /// format only
    pub fn seal(&self, plain: &[u8], nonce: [u8; WIN_NONCE_LEN]) -> Vec<u8> {
        let mut out = V10.to_vec();
        match self {
            Key::Mac(key) => out.extend(
                cbc::Encryptor::<aes::Aes128>::new(key.into(), &MAC_IV.into())
                    .encrypt_padded_vec_mut::<Pkcs7>(plain),
            ),
            Key::Win(key) => {
                let sealed = Aes256Gcm::new(key.into())
                    .encrypt(Nonce::from_slice(&nonce), plain)
                    .expect("AES-GCM encrypts any length the API takes");
                out.extend(nonce);
                out.extend(sealed);
            }
        }
        out
    }

    /// What the key makes of a stored value
    pub fn open(&self, value: &[u8]) -> Opened {
        let Some(body) = value.strip_prefix(V10) else {
            return Opened::Unprefixed;
        };
        let plain = match self {
            Key::Mac(key) => cbc::Decryptor::<aes::Aes128>::new(key.into(), &MAC_IV.into())
                .decrypt_padded_vec_mut::<Pkcs7>(body)
                .ok(),
            Key::Win(key) if body.len() >= WIN_NONCE_LEN + WIN_TAG_LEN => {
                let (nonce, sealed) = body.split_at(WIN_NONCE_LEN);
                Aes256Gcm::new(key.into())
                    .decrypt(Nonce::from_slice(nonce), sealed)
                    .ok()
            }
            Key::Win(_) => None,
        };
        plain.map_or(Opened::Failed, Opened::Plain)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Opened {
    Plain(Vec<u8>),
    /// a `v10` value this key does not open (another user or PC, damaged)
    Failed,
    /// no `v10` prefix: what Chromium wrote before it encrypted
    Unprefixed,
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLAIN: &str = "sk-test-한글-✓-0001";

    #[test]
    fn mac_key_is_chromiums_pbkdf2() {
        // python3: hashlib.pbkdf2_hmac('sha1', b'peanuts', b'saltysalt', 1003, 16)
        let Key::Mac(key) = Key::mac_from_password(b"peanuts") else {
            unreachable!()
        };
        assert_eq!(
            key,
            [
                0xd9, 0xa0, 0x9d, 0x49, 0x9b, 0x4e, 0x1b, 0x74, 0x61, 0xf2, 0x8e, 0x67, 0x97, 0x2c,
                0x6d, 0xbd
            ]
        );
    }

    #[test]
    fn mac_value_matches_an_outside_encryption() {
        // printf 'sk-test-한글-✓-0001' | openssl enc -aes-128-cbc
        //   -K d9a09d499b4e1b7461f28e67972c6dbd -iv 2020…20 (16 spaces)
        let body = [
            0x45, 0x71, 0xbf, 0x9c, 0x5b, 0xe2, 0x29, 0x38, 0x66, 0x68, 0xfb, 0xe7, 0xc1, 0xc9,
            0xe8, 0x41, 0xe0, 0x8c, 0x84, 0x29, 0xe1, 0x44, 0x55, 0x55, 0xf9, 0x31, 0xe5, 0x6b,
            0xc0, 0x74, 0x01, 0x98,
        ];
        let mut value = V10.to_vec();
        value.extend(body);
        let key = Key::mac_from_password(b"peanuts");
        assert_eq!(key.seal(PLAIN.as_bytes(), [0; 12]), value);
        assert_eq!(key.open(&value), Opened::Plain(PLAIN.as_bytes().to_vec()));
    }

    #[test]
    fn win_value_round_trips_and_a_changed_byte_fails() {
        let key = Key::Win([7; 32]);
        let mut value = key.seal(PLAIN.as_bytes(), [9; 12]);
        assert_eq!(&value[..3], b"v10");
        assert_eq!(&value[3..15], &[9; 12]);
        assert_eq!(value.len(), 3 + 12 + PLAIN.len() + 16);
        assert_eq!(key.open(&value), Opened::Plain(PLAIN.as_bytes().to_vec()));
        value[20] ^= 1;
        assert_eq!(key.open(&value), Opened::Failed);
        assert_eq!(key.open(b"v10short"), Opened::Failed);
    }

    #[test]
    fn another_key_fails_and_no_prefix_is_unprefixed() {
        let sealed = Key::mac_from_password(b"a").seal(b"x", [0; 12]);
        assert_eq!(Key::mac_from_password(b"b").open(&sealed), Opened::Failed);
        assert_eq!(Key::Win([1; 32]).open(b"plain"), Opened::Unprefixed);
    }
}
