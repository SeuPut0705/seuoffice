//! `objects/media.ts`: picture bytes, format sniffing, base64 and data URLs,
//! and the neutral placeholder picture.

use jscompat::js_regex;
use serde::Serialize;

/// `ImageFormat`
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ImageFormat {
    /// file extension without the dot
    pub ext: String,
    pub mime: String,
}

impl ImageFormat {
    fn of(ext: &str, mime: &str) -> Self {
        Self {
            ext: ext.to_string(),
            mime: mime.to_string(),
        }
    }
}

/// `NEUTRAL_PLACEHOLDER_PNG`: a 1x1 light grey PNG, stretched to the object's
/// size.
pub const NEUTRAL_PLACEHOLDER_PNG: [u8; 69] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0x78, 0xf1, 0xe2, 0x05,
    0x00, 0x05, 0x74, 0x02, 0xb9, 0xe7, 0x3f, 0x14, 0xc9, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

/// `at`: the bytes of `b` from `offset` equal `bytes` (a missing byte is
/// `undefined` in JavaScript and equals nothing).
fn at(b: &[u8], offset: usize, bytes: &[u8]) -> bool {
    bytes
        .iter()
        .enumerate()
        .all(|(i, v)| b.get(offset + i) == Some(v))
}

/// `sniffImage`: the format of picture bytes the bridge docx can show, or
/// `None` (SVM, unknown ...).
pub fn sniff_image(bytes: &[u8]) -> Option<ImageFormat> {
    if bytes.len() < 4 {
        return None;
    }
    if at(bytes, 0, &[0x89, 0x50, 0x4e, 0x47]) {
        return Some(ImageFormat::of("png", "image/png"));
    }
    if at(bytes, 0, &[0xff, 0xd8, 0xff]) {
        return Some(ImageFormat::of("jpeg", "image/jpeg"));
    }
    if at(bytes, 0, &[0x47, 0x49, 0x46, 0x38]) {
        return Some(ImageFormat::of("gif", "image/gif"));
    }
    if at(bytes, 0, &[0x42, 0x4d]) {
        return Some(ImageFormat::of("bmp", "image/bmp"));
    }
    if at(bytes, 0, &[0x49, 0x49, 0x2a, 0x00]) || at(bytes, 0, &[0x4d, 0x4d, 0x00, 0x2a]) {
        return Some(ImageFormat::of("tiff", "image/tiff"));
    }
    // EMF: EMR_HEADER record type 1, " EMF" signature at 40
    if at(bytes, 0, &[0x01, 0x00, 0x00, 0x00]) && at(bytes, 40, &[0x20, 0x45, 0x4d, 0x46]) {
        return Some(ImageFormat::of("emf", "image/x-emf"));
    }
    // WMF: placeable header, or a plain memory/disk metafile header
    if at(bytes, 0, &[0xd7, 0xcd, 0xc6, 0x9a])
        || ((at(bytes, 0, &[0x01, 0x00]) || at(bytes, 0, &[0x02, 0x00]))
            && at(bytes, 2, &[0x09, 0x00]))
    {
        return Some(ImageFormat::of("wmf", "image/x-wmf"));
    }
    // `String.fromCharCode(...bytes)`: one char per byte
    let head: String = bytes[..bytes.len().min(512)]
        .iter()
        .map(|&b| char::from(b))
        .collect();
    if js_regex!(r"^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]").test(&head) {
        return Some(ImageFormat::of("svg", "image/svg+xml"));
    }
    None
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// `base64Encode`
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    let mut i = 0;
    while i < bytes.len() {
        let a = bytes[i] as usize;
        let b = if i + 1 < bytes.len() {
            bytes[i + 1] as usize
        } else {
            0
        };
        let c = if i + 2 < bytes.len() {
            bytes[i + 2] as usize
        } else {
            0
        };
        out.push(B64[a >> 2] as char);
        out.push(B64[((a & 3) << 4) | (b >> 4)] as char);
        out.push(if i + 1 < bytes.len() {
            B64[((b & 15) << 2) | (c >> 6)] as char
        } else {
            '='
        });
        out.push(if i + 2 < bytes.len() {
            B64[c & 63] as char
        } else {
            '='
        });
        i += 3;
    }
    out
}

/// `B64_INDEX`: the value of a code unit below 128, or -1.
fn b64_index(code: u16) -> i32 {
    match code {
        0x2d => 62, // '-'
        0x5f => 63, // '_'
        c if c < 128 => B64
            .iter()
            .position(|&v| u16::from(v) == c)
            .map_or(-1, |p| p as i32),
        _ => -1,
    }
}

/// `base64Decode`: decodes base64 (white space ignored); `None` when it is not
/// base64. Both alphabets are read, padding is dropped, nothing is checked
/// beyond the characters.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let clean = js_regex!(r"[\s=]+", "g").replace_all(text, |_| String::new());
    let units: Vec<u16> = clean.encode_utf16().collect();
    let mut out = Vec::with_capacity(units.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &code in &units {
        let v = b64_index(code);
        if v < 0 {
            return None;
        }
        acc = (acc << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((acc >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// `dataUrlBytes`: the bytes of a `data:...;base64,...` URL, or `None` (lazy
/// media URLs, other schemes).
pub fn data_url_bytes(url: Option<&str>) -> Option<Vec<u8>> {
    let url = jscompat::truthy(url)?;
    let m = js_regex!(r"^data:[^,]*?;base64,(.*)$", "s").exec(url)?;
    base64_decode(m.get(1)?)
}

/// `sameBytes`
pub fn same_bytes(a: &[u8], b: &[u8]) -> bool {
    a == b
}
