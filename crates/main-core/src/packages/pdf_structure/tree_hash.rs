//! `packages/pdf-structure/src/tree/hash.ts`: `sha256Hex`. The TypeScript
//! hashes by hand so the tree builder needs no `node:crypto`; the digest is
//! SHA-256 of the UTF-8 bytes (`TextEncoder` writes a lone surrogate as
//! U+FFFD, which a Rust `str` never holds).

use sha2::{Digest, Sha256};

/// `sha256Hex(data)` of a string: lower-case hex of the 32-byte digest
pub fn sha256_hex(data: &str) -> String {
    sha256_hex_bytes(data.as_bytes())
}

/// `sha256Hex(data)` of bytes
pub fn sha256_hex_bytes(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
