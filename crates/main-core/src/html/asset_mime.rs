//! `apps/html/src/main/asset-mime.ts`.
//!
//! The content type of a sibling file the preview may load through
//! `html-asset://`: by extension, by binary signature, or by the slot that
//! asked for it.

use jscompat::node_path::host::{basename, extname};
use jscompat::{js_regex, text_decoder_decode, trim};

/// Sibling files the preview may load through html-asset:// by extension.
/// Deliberately no json / txt / html: a page's own script must not be able to
/// read arbitrary neighbours and exfiltrate them.
pub const PREVIEW_ASSET_EXTS: [&str; 21] = [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif", ".ico", ".css", ".js",
    ".mjs", ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".webm", ".mp3", ".ogg", ".wav",
];

pub const ASSET_SNIFF_BYTES: usize = 64;

/// `ascii(head, start, length) === text`: the bytes are read as Latin-1
/// characters; `subarray` is cut short at the end of `head`.
fn ascii_is(head: &[u8], start: usize, text: &str) -> bool {
    head.get(start..(start + text.len()).min(head.len()))
        .is_some_and(|part| part == text.as_bytes())
}

/// `startsWith(head, bytes, offset)`
fn starts_with(head: &[u8], bytes: &[u8], offset: usize) -> bool {
    if head.len() < offset + bytes.len() {
        return false;
    }
    bytes
        .iter()
        .enumerate()
        .all(|(i, b)| head[offset + i] == *b)
}

/// `sniffBinaryAssetMime(head)`: binary signatures only: a file that starts
/// like a JPEG is not a secret.
pub fn sniff_binary_asset_mime(head: &[u8]) -> Option<&'static str> {
    if starts_with(head, &[0xff, 0xd8, 0xff], 0) {
        return Some("image/jpeg");
    }
    if starts_with(head, &[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0) {
        return Some("image/png");
    }
    if head.len() >= 6
        && ascii_is(head, 0, "GIF8")
        && matches!(head[4], b'7' | b'9')
        && head[5] == b'a'
    {
        return Some("image/gif");
    }
    if head.len() >= 12 && ascii_is(head, 0, "RIFF") {
        if ascii_is(head, 8, "WEBP") {
            return Some("image/webp");
        }
        if ascii_is(head, 8, "WAVE") {
            return Some("audio/wav");
        }
        return None;
    }
    if starts_with(head, &[0x42, 0x4d], 0) && starts_with(head, &[0, 0, 0, 0], 6) {
        return Some("image/bmp");
    }
    if starts_with(head, &[0x00, 0x00, 0x01, 0x00], 0) {
        return Some("image/x-icon");
    }
    if head.len() >= 12 && ascii_is(head, 4, "ftyp") {
        let brand = &head[8..12];
        return Some(
            if brand.starts_with(b"avi") && matches!(brand[3], b'f' | b's') {
                "image/avif"
            } else {
                "video/mp4"
            },
        );
    }
    if starts_with(head, &[0x1a, 0x45, 0xdf, 0xa3], 0) {
        return Some("video/webm");
    }
    if head.len() >= 4 && ascii_is(head, 0, "OggS") {
        return Some("audio/ogg");
    }
    if head.len() >= 3 && ascii_is(head, 0, "ID3") {
        return Some("audio/mpeg");
    }
    if head.len() >= 2 && head[0] == 0xff && (head[1] & 0xe6) == 0xe2 {
        return Some("audio/mpeg");
    }
    if head.len() >= 4 {
        if ascii_is(head, 0, "wOFF") {
            return Some("font/woff");
        }
        if ascii_is(head, 0, "wOF2") {
            return Some("font/woff2");
        }
        if ascii_is(head, 0, "OTTO") {
            return Some("font/otf");
        }
        if ascii_is(head, 0, "true") || starts_with(head, &[0x00, 0x01, 0x00, 0x00], 0) {
            let num_tables = if head.len() >= 6 {
                (u32::from(head[4]) << 8) | u32::from(head[5])
            } else {
                0
            };
            if num_tables > 0 && num_tables <= 64 {
                return Some("font/ttf");
            }
        }
    }
    None
}

/// `looksLikeSvg(head)`
fn looks_like_svg(head: &[u8]) -> bool {
    let decoded = text_decoder_decode(head);
    let text = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);
    js_regex!(r"^\s*<(\?xml|svg[\s>])", "i").test(text)
}

/// `AssetSlot`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetSlot {
    Image,
    Style,
    Other,
}

impl AssetSlot {
    pub fn as_str(self) -> &'static str {
        match self {
            AssetSlot::Image => "image",
            AssetSlot::Style => "style",
            AssetSlot::Other => "other",
        }
    }
}

/// `slotFromAccept(accept)`: Electron strips Sec-Fetch-* before
/// protocol.handle sees a request, so the slot is read from Accept: images
/// ask for `image/...`, stylesheets for `text/css`, everything else (script,
/// font, media, fetch) sends `*\/*`.
pub fn slot_from_accept(accept: Option<&str>) -> AssetSlot {
    let first = trim(accept.unwrap_or("")).to_lowercase();
    if first.starts_with("image/") {
        return AssetSlot::Image;
    }
    if first.starts_with("text/css") {
        return AssetSlot::Style;
    }
    AssetSlot::Other
}

/// `TEXT_MIME_BY_SLOT[slot]`
fn text_mime_by_slot(slot: AssetSlot) -> Option<&'static str> {
    match slot {
        AssetSlot::Image => None,
        AssetSlot::Style => Some("text/css; charset=utf-8"),
        AssetSlot::Other => Some("text/javascript; charset=utf-8"),
    }
}

/// `extensionlessAssetMime(target, head, accept)`: the content type for a
/// sibling file whose extension is not on the allowlist, or `None` when the
/// file must not be served.
pub fn extensionless_asset_mime(
    target: &str,
    head: &[u8],
    accept: Option<&str>,
) -> Option<&'static str> {
    let slot = slot_from_accept(accept);
    if let Some(binary) = sniff_binary_asset_mime(head) {
        let wanted = if binary.starts_with("image/") {
            slot == AssetSlot::Image
        } else {
            slot == AssetSlot::Other
        };
        return wanted.then_some(binary);
    }
    let name = basename(target, None);
    if !extname(&name).is_empty() || name.starts_with('.') {
        return None;
    }
    if slot == AssetSlot::Image {
        return looks_like_svg(head).then_some("image/svg+xml");
    }
    text_mime_by_slot(slot)
}

/// `editableImageMime(head)`: the data-URL label for a picture read back for
/// editing: PNG / GIF keep their type, any other image signature is labelled
/// JPEG the way fetchImage does.
pub fn editable_image_mime(head: &[u8]) -> Option<&'static str> {
    let mime = sniff_binary_asset_mime(head)?;
    if !mime.starts_with("image/") {
        return None;
    }
    Some(if mime == "image/png" || mime == "image/gif" {
        mime
    } else {
        "image/jpeg"
    })
}
