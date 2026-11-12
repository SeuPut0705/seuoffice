//! `crypto.createHash('sha1').update(data).digest('hex')`.

use sha1::{Digest, Sha1};

/// The SHA-1 of `data` as lowercase hex, as Node's `digest('hex')` writes it.
pub fn sha1_hex(data: &[u8]) -> String {
    Sha1::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::sha1_hex;

    // answers of Node 22's crypto.createHash('sha1')
    #[test]
    fn known_digests() {
        assert_eq!(sha1_hex(b""), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
        assert_eq!(sha1_hex(b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
    }
}
