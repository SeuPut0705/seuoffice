//! The read side of packages/docx-engine/src/lazy-media.ts: a large
//! document's pictures stay in the file on disk, and the zip handed to the
//! renderer holds a fixed-size placeholder per stripped part that names the
//! source document's sha256.

use crate::vml::shape::encode_uri_component;

/// `LAZY_MEDIA_SCHEME`
pub const LAZY_MEDIA_SCHEME: &str = "seuoffice-docx-media";

/// `MAGIC`
const MAGIC: &[u8] = b"SEUOFFICE-LAZY-MEDIA\n";

/// `LAZY_MEDIA_PLACEHOLDER_BYTES`: the magic, a sha256 in hex and a line feed.
pub const LAZY_MEDIA_PLACEHOLDER_BYTES: usize = MAGIC.len() + 64 + 1;

/// `lazyMediaHashOf`: the hash a placeholder part names, under the current
/// header or an old one. The TypeScript decodes the bytes as windows-1252,
/// which maps no byte above 0x7F to ASCII, so the bytes are compared as they
/// are.
pub fn lazy_media_hash_of(bytes: &[u8]) -> Option<&str> {
    let magic = std::iter::once(MAGIC)
        .chain(crate::old_names::OLD_LAZY_MEDIA_MAGICS)
        .find(|magic| bytes.starts_with(magic))?;
    if bytes.len() != LAZY_MEDIA_PLACEHOLDER_BYTES || !bytes.ends_with(b"\n") {
        return None;
    }
    let hash = &bytes[magic.len()..magic.len() + 64];
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

/// `lazyMediaUrl` as exported: a hash that is no sha256 in lower-case hex is an error.
pub fn lazy_media_url_checked(hash: &str, part_path: &str) -> Result<String, String> {
    sha256_hex(hash)?;
    Ok(lazy_media_url(hash, part_path))
}

/// `HASH_RE` of lazy-media.ts.
fn sha256_hex(hash: &str) -> Result<(), String> {
    let is_hash = hash.len() == 64
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if is_hash {
        Ok(())
    } else {
        Err(format!("lazy media: not a sha256 hex: {hash}"))
    }
}

/// `lazyMediaPlaceholder`: the bytes of the placeholder part naming `hash`;
/// a hash that is no sha256 in lower-case hex is an error.
pub fn lazy_media_placeholder(hash: &str) -> Result<Vec<u8>, String> {
    sha256_hex(hash)?;
    let mut out = Vec::with_capacity(LAZY_MEDIA_PLACEHOLDER_BYTES);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(hash.as_bytes());
    out.push(b'\n');
    Ok(out)
}

/// `isLazyMediaPart`: pictures Chromium decodes itself; emf/wmf/tiff need
/// their bytes in the renderer.
pub fn is_lazy_media_part(part_path: &str) -> bool {
    jscompat::js_regex!(
        r"^word\/media\/[\x21-\x7e]+\.(?:png|jpe?g|gif|bmp|webp|svg)$",
        "i"
    )
    .test(part_path)
}

/// `MAX_LAZY_PART_CHARS`: max lazy-media part path chars served from the
/// source archive.
pub const MAX_LAZY_PART_CHARS: usize = 512;

/// What `parseLazyMediaUrl` returns.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LazyMediaUrl {
    pub hash: String,
    pub part_path: String,
}

/// `parseLazyMediaUrl`: the hash and the part path a lazy-media URL names;
/// `None` for a URL that is none, one that does not decode, or a path that is
/// too long, holds a NUL or climbs out with `..`.
pub fn parse_lazy_media_url(url: &str) -> Result<Option<LazyMediaUrl>, jscompat::RegexLimit> {
    let Some(found) =
        jscompat::try_js_regex!(r"^seuoffice-docx-media://([0-9a-f]{64})/(.+)$").try_exec(url)?
    else {
        return Ok(None);
    };
    let segments: Result<Vec<String>, _> = found
        .get(2)
        .unwrap_or_default()
        .split('/')
        .map(jscompat::decode_uri_component)
        .collect();
    let Ok(segments) = segments else {
        return Ok(None);
    };
    let part_path = segments.join("/");
    if part_path.encode_utf16().count() > MAX_LAZY_PART_CHARS || part_path.contains('\0') {
        return Ok(None);
    }
    if part_path.split('/').any(|segment| segment == "..") {
        return Ok(None);
    }
    Ok(Some(LazyMediaUrl {
        hash: found.get(1).unwrap_or_default().to_owned(),
        part_path,
    }))
}
