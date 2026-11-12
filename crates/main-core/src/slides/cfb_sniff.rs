//! `apps/slides/src/main/cfb-sniff.ts`.

use crate::packages::compound_file::{is_cfb_header as header_is_cfb, is_damaged_compound_file};

/// `Buffer.from('EncryptedPackage', 'utf16le')`
const ENCRYPTED_STREAM_UTF16: [u8; 32] = [
    b'E', 0, b'n', 0, b'c', 0, b'r', 0, b'y', 0, b'p', 0, b't', 0, b'e', 0, b'd', 0, b'P', 0, b'a',
    0, b'c', 0, b'k', 0, b'a', 0, b'g', 0, b'e', 0,
];

/// `isCfbHeader(head)`
pub fn is_cfb_header(head: &[u8]) -> bool {
    header_is_cfb(head)
}

/// What `cfbKind` answers when the file has the CFB magic number.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CfbKind {
    Legacy,
    Encrypted,
    Damaged,
}

impl CfbKind {
    pub fn as_str(self) -> &'static str {
        match self {
            CfbKind::Legacy => "legacy",
            CfbKind::Encrypted => "encrypted",
            CfbKind::Damaged => "damaged",
        }
    }
}

/// `cfbKind(bytes)`: `None` is `null`
pub fn cfb_kind(bytes: &[u8]) -> Option<CfbKind> {
    if !is_cfb_header(bytes) {
        return None;
    }
    if is_damaged_compound_file(bytes) {
        return Some(CfbKind::Damaged);
    }
    // bytes.includes(ENCRYPTED_STREAM_UTF16)
    if bytes
        .windows(ENCRYPTED_STREAM_UTF16.len())
        .any(|window| window == ENCRYPTED_STREAM_UTF16)
    {
        Some(CfbKind::Encrypted)
    } else {
        Some(CfbKind::Legacy)
    }
}
