//! The read side of packages/docx-engine/src/lazy-media.ts: a large
//! document's pictures stay in the file on disk, and the zip handed to the
//! renderer holds a fixed-size placeholder per stripped part that names the
//! source document's sha256.

use crate::vml::shape::encode_uri_component;

/// `LAZY_MEDIA_SCHEME`
pub const LAZY_MEDIA_SCHEME: &str = "genoffice-docx-media";

/// `MAGIC`
const MAGIC: &[u8] = b"GENOFFICE-LAZY-MEDIA\n";

/// `LAZY_MEDIA_PLACEHOLDER_BYTES`: the magic, a sha256 in hex and a line feed.
pub const LAZY_MEDIA_PLACEHOLDER_BYTES: usize = MAGIC.len() + 64 + 1;

/// `lazyMediaHashOf`: the hash a placeholder part names. The TypeScript
/// decodes the bytes as windows-1252, which maps no byte above 0x7F to
/// ASCII, so the bytes are compared as they are.
pub fn lazy_media_hash_of(bytes: &[u8]) -> Option<&str> {
    if bytes.len() != LAZY_MEDIA_PLACEHOLDER_BYTES
        || !bytes.starts_with(MAGIC)
        || !bytes.ends_with(b"\n")
    {
        return None;
    }
    let hash = &bytes[MAGIC.len()..MAGIC.len() + 64];
    if !hash
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return None;
    }
    std::str::from_utf8(hash).ok()
}

/// `lazyMediaUrl`, for a hash `lazy_media_hash_of` accepted.
pub fn lazy_media_url(hash: &str, part_path: &str) -> String {
    let path: Vec<String> = part_path.split('/').map(encode_uri_component).collect();
    format!("{LAZY_MEDIA_SCHEME}://{hash}/{}", path.join("/"))
}
