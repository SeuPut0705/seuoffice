//! `apps/docs/src/main/atomic-write.ts`: the electron-utils writer under the
//! app's name, and the zip signature check.

pub use crate::packages::electron_utils::atomic_write::atomic_write_file;

/// `'PK\x03\x04'` local-file-header check: `bytes.length >= 4 &&
/// bytes.readUInt32LE(0) === 0x04034b50`.
pub fn looks_like_zip(bytes: &[u8]) -> bool {
    bytes
        .first_chunk::<4>()
        .is_some_and(|head| u32::from_le_bytes(*head) == 0x0403_4b50)
}
