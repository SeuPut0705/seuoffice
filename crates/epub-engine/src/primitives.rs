//! `paths.ts`, `fonts.ts`, `sha1.ts` and `encoding.ts` of `packages/epub-engine`.
//!
//! The diff wire carries bytes as arrays of numbers and the text handed to
//! `encodeEntryText` as UTF-16 code units, so a lone surrogate crosses intact.

use jscompat::{decode_uri_component, trim};
use serde_json::{Value, json};

pub const IDPF_FONT_OBFUSCATION: &str = "http://www.idpf.org/2008/embedding";
pub const ADOBE_FONT_OBFUSCATION: &str = "http://ns.adobe.com/pdf/enc#RC";

const IDPF_PREFIX_BYTES: usize = 1040;
const ADOBE_PREFIX_BYTES: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedHref {
    pub path: String,
    pub fragment: Option<String>,
}

/// `/^[a-z][a-z0-9+.-]*:/i`
fn starts_with_scheme(text: &str) -> bool {
    let mut bytes = text.bytes();
    if !bytes.next().is_some_and(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    for b in bytes {
        match b {
            b':' => return true,
            b'+' | b'.' | b'-' => {}
            _ if b.is_ascii_alphanumeric() => {}
            _ => return false,
        }
    }
    false
}

pub fn has_url_scheme(href: &str) -> bool {
    let trimmed = trim(href);
    let bytes = trimmed.as_bytes();
    starts_with_scheme(trimmed)
        || (bytes.len() >= 2
            && matches!(bytes[0], b'/' | b'\\')
            && matches!(bytes[1], b'/' | b'\\'))
}

pub fn normalize_zip_path(path: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            out.pop();
            continue;
        }
        out.push(segment);
    }
    out.join("/")
}

pub fn directory_of(path: &str) -> &str {
    path.rfind('/').map_or("", |slash| &path[..=slash])
}

pub fn file_name_of(path: &str) -> &str {
    path.rfind('/').map_or(path, |slash| &path[slash + 1..])
}

fn percent_decode(text: &str) -> String {
    decode_uri_component(text).unwrap_or_else(|_| text.to_owned())
}

pub fn resolve_href(base_path: &str, href: &str) -> Option<ResolvedHref> {
    let trimmed = trim(href);
    if has_url_scheme(trimmed) {
        return None;
    }
    let (before_hash, raw_fragment) = match trimmed.find('#') {
        Some(hash) => (&trimmed[..hash], &trimmed[hash + 1..]),
        None => (trimmed, ""),
    };
    let raw_path = before_hash
        .find('?')
        .map_or(before_hash, |query| &before_hash[..query]);
    let fragment = (!raw_fragment.is_empty()).then(|| percent_decode(raw_fragment));
    if raw_path.is_empty() {
        return Some(ResolvedHref {
            path: normalize_zip_path(base_path),
            fragment,
        });
    }
    let decoded = percent_decode(raw_path);
    let joined = if decoded.starts_with('/') {
        decoded
    } else {
        format!("{}{decoded}", directory_of(base_path))
    };
    Some(ResolvedHref {
        path: normalize_zip_path(&joined),
        fragment,
    })
}

pub fn is_font_obfuscation_algorithm(value: &str) -> bool {
    value == IDPF_FONT_OBFUSCATION || value == ADOBE_FONT_OBFUSCATION
}

fn uuid_bytes(identifier: &str) -> Option<[u8; 16]> {
    let trimmed = trim(identifier);
    let rest = match trimmed.get(..9) {
        Some(prefix) if prefix.eq_ignore_ascii_case("urn:uuid:") => &trimmed[9..],
        _ => trimmed,
    };
    let hex: Vec<u8> = rest
        .bytes()
        .filter(|b| !matches!(b, b'{' | b'}' | b'-'))
        .collect();
    if hex.len() != 32 || !hex.iter().all(u8::is_ascii_hexdigit) {
        return None;
    }
    let digit = |b: u8| char::from(b).to_digit(16).unwrap_or(0) as u8;
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = digit(hex[2 * i]) << 4 | digit(hex[2 * i + 1]);
    }
    Some(out)
}

pub fn font_obfuscation_key(algorithm: &str, identifier: &str) -> Option<Vec<u8>> {
    if algorithm == ADOBE_FONT_OBFUSCATION {
        return uuid_bytes(identifier).map(|key| key.to_vec());
    }
    let stripped: String = identifier
        .chars()
        .filter(|c| !matches!(c, ' ' | '\t' | '\r' | '\n'))
        .collect();
    Some(sha1(stripped.as_bytes()).to_vec())
}

/// An empty key leaves the bytes as they were: `x ^ undefined` is `x`.
pub fn obfuscate_font_with_key(bytes: &[u8], algorithm: &str, key: &[u8]) -> Vec<u8> {
    let mut out = bytes.to_vec();
    let prefix = if algorithm == ADOBE_FONT_OBFUSCATION {
        ADOBE_PREFIX_BYTES
    } else {
        IDPF_PREFIX_BYTES
    };
    if !key.is_empty() {
        for (i, byte) in out.iter_mut().take(prefix).enumerate() {
            *byte ^= key[i % key.len()];
        }
    }
    out
}

pub fn obfuscate_font(bytes: &[u8], algorithm: &str, identifier: &str) -> Option<Vec<u8>> {
    font_obfuscation_key(algorithm, identifier)
        .map(|key| obfuscate_font_with_key(bytes, algorithm, &key))
}

pub fn deobfuscate_font(bytes: &[u8], algorithm: &str, identifier: &str) -> Option<Vec<u8>> {
    obfuscate_font(bytes, algorithm, identifier)
}

pub fn sha1(data: &[u8]) -> [u8; 20] {
    let bit_length = (data.len() as u64).wrapping_mul(8);
    let mut padded = vec![0u8; ((data.len() + 8) / 64 + 1) * 64];
    padded[..data.len()].copy_from_slice(data);
    padded[data.len()] = 0x80;
    let end = padded.len();
    padded[end - 8..].copy_from_slice(&bit_length.to_be_bytes());

    let mut h = [
        0x6745_2301u32,
        0xefcd_ab89,
        0x98ba_dcfe,
        0x1032_5476,
        0xc3d2_e1f0,
    ];
    let mut w = [0u32; 80];
    for block in padded.as_chunks::<64>().0 {
        for (t, word) in block.as_chunks::<4>().0.iter().enumerate() {
            w[t] = u32::from_be_bytes(*word);
        }
        for t in 16..80 {
            w[t] = (w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (t, word) in w.iter().enumerate() {
            let (f, k) = match t {
                0..=19 => ((b & c) | (!b & d), 0x5a82_7999),
                20..=39 => (b ^ c ^ d, 0x6ed9_eba1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8f1b_bcdc),
                _ => (b ^ c ^ d, 0xca62_c1d6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        for (state, value) in h.iter_mut().zip([a, b, c, d, e]) {
            *state = state.wrapping_add(value);
        }
    }
    let mut out = [0u8; 20];
    for (chunk, state) in out.as_chunks_mut::<4>().0.iter_mut().zip(h) {
        *chunk = state.to_be_bytes();
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EpubTextEncoding {
    Utf8,
    Utf16Le,
    Utf16Be,
}

impl EpubTextEncoding {
    pub fn label(self) -> &'static str {
        match self {
            Self::Utf8 => "utf-8",
            Self::Utf16Le => "utf-16le",
            Self::Utf16Be => "utf-16be",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedText {
    pub text: String,
    pub encoding: EpubTextEncoding,
    pub valid: bool,
}

fn sniff_encoding(bytes: &[u8]) -> EpubTextEncoding {
    match bytes {
        [0xff, 0xfe, ..] => EpubTextEncoding::Utf16Le,
        [0xfe, 0xff, ..] => EpubTextEncoding::Utf16Be,
        _ => EpubTextEncoding::Utf8,
    }
}

/// WHATWG UTF-16 decoding with replacement: an unpaired surrogate is one
/// U+FFFD, and an odd last byte adds one more unless a lead surrogate is
/// still pending, which that same U+FFFD then covers.
fn decode_utf16(bytes: &[u8], little_endian: bool) -> (String, bool) {
    let mut text = String::with_capacity(bytes.len());
    let mut valid = true;
    let mut lead: Option<u16> = None;
    for pair in bytes.as_chunks::<2>().0 {
        let unit = if little_endian {
            u16::from_le_bytes(*pair)
        } else {
            u16::from_be_bytes(*pair)
        };
        if let Some(high) = lead.take() {
            if (0xdc00..0xe000).contains(&unit) {
                let scalar =
                    0x10000 + ((u32::from(high) - 0xd800) << 10) + (u32::from(unit) - 0xdc00);
                text.push(char::from_u32(scalar).unwrap_or('\u{fffd}'));
                continue;
            }
            text.push('\u{fffd}');
            valid = false;
        }
        match unit {
            0xd800..=0xdbff => lead = Some(unit),
            0xdc00..=0xdfff => {
                text.push('\u{fffd}');
                valid = false;
            }
            _ => text.push(char::from_u32(u32::from(unit)).unwrap_or('\u{fffd}')),
        }
    }
    if lead.is_some() || bytes.len() % 2 == 1 {
        text.push('\u{fffd}');
        valid = false;
    }
    (text, valid)
}

pub fn decode_entry_text(bytes: &[u8]) -> DecodedText {
    let encoding = sniff_encoding(bytes);
    let (text, valid) = match encoding {
        EpubTextEncoding::Utf8 => match std::str::from_utf8(bytes) {
            Ok(text) => (text.to_owned(), true),
            Err(_) => (String::from_utf8_lossy(bytes).into_owned(), false),
        },
        EpubTextEncoding::Utf16Le => decode_utf16(bytes, true),
        EpubTextEncoding::Utf16Be => decode_utf16(bytes, false),
    };
    DecodedText {
        text,
        encoding,
        valid,
    }
}

/// `encoding` is any string, as the TypeScript accepts one: what is not
/// `utf-8` writes UTF-16, little-endian only for `utf-16le`.
pub fn encode_entry_text(units: &[u16], encoding: &str) -> Vec<u8> {
    if encoding == "utf-8" {
        let text: String = char::decode_utf16(units.iter().copied())
            .map(|c| c.unwrap_or('\u{fffd}'))
            .collect();
        return text.into_bytes();
    }
    let little_endian = encoding == "utf-16le";
    units
        .iter()
        .flat_map(|unit| {
            if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            }
        })
        .collect()
}

fn type_error(message: String) -> (String, String) {
    ("TypeError".to_owned(), message)
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, (String, String)> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| type_error(format!("args.{key} is not a string")))
}

fn arg_numbers<T: TryFrom<u64>>(args: &Value, key: &str) -> Result<Vec<T>, (String, String)> {
    args.get(key)
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .map(|item| item.as_u64().and_then(|n| T::try_from(n).ok()))
                .collect()
        })
        .ok_or_else(|| type_error(format!("args.{key} is not an array of code units")))
}

fn bytes_value(bytes: &[u8]) -> Value {
    Value::from(bytes.to_vec())
}

/// The diff harness entry: `function` is the TypeScript export name.
pub fn call(
    function: &str,
    text: &str,
    bytes: &[u8],
    args: &Value,
) -> Result<Value, (String, String)> {
    Ok(match function {
        "hasUrlScheme" => json!(has_url_scheme(text)),
        "normalizeZipPath" => json!(normalize_zip_path(text)),
        "directoryOf" => json!(directory_of(text)),
        "fileNameOf" => json!(file_name_of(text)),
        "resolveHref" => match resolve_href(arg_str(args, "basePath")?, text) {
            Some(resolved) => json!({ "path": resolved.path, "fragment": resolved.fragment }),
            None => Value::Null,
        },
        "isFontObfuscationAlgorithm" => json!(is_font_obfuscation_algorithm(text)),
        "fontObfuscationKey" => font_obfuscation_key(arg_str(args, "algorithm")?, text)
            .map_or(Value::Null, |key| bytes_value(&key)),
        "obfuscateFontWithKey" => bytes_value(&obfuscate_font_with_key(
            bytes,
            arg_str(args, "algorithm")?,
            &arg_numbers::<u8>(args, "key")?,
        )),
        "obfuscateFont" => obfuscate_font(bytes, arg_str(args, "algorithm")?, text)
            .map_or(Value::Null, |out| bytes_value(&out)),
        "deobfuscateFont" => deobfuscate_font(bytes, arg_str(args, "algorithm")?, text)
            .map_or(Value::Null, |out| bytes_value(&out)),
        "sha1" => bytes_value(&sha1(bytes)),
        "decodeEntryText" => {
            let decoded = decode_entry_text(bytes);
            json!({ "text": decoded.text, "encoding": decoded.encoding.label(), "valid": decoded.valid })
        }
        "encodeEntryText" => bytes_value(&encode_entry_text(
            &arg_numbers::<u16>(args, "units")?,
            arg_str(args, "encoding")?,
        )),
        _ => return Err(("Error".to_owned(), format!("unknown function {function}"))),
    })
}
