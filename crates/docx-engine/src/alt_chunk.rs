//! w:altChunk import (display only): packages/docx-engine/src/alt-chunk.ts.
//! The chunk part stays untouched in the package; the host converts HTML or
//! MHT to a docx, which the parser then reads like any other document.
//!
//! Not ported: `setAltChunkHtmlConverter`, `hasAltChunkHtmlConverter` and
//! `altChunkToDocx`. The HTML converter belongs to the host (it needs a
//! browser), and `altChunkToDocx` is async over the zip and calls it; the host
//! keeps them and calls the functions here.
//!
//! `TextDecoder` is `encoding_rs`, which implements the same Encoding
//! Standard as the `@exodus/bytes` decoder the TypeScript uses.

use std::borrow::Cow;
use std::rc::Rc;

use encoding_rs::{Encoding, UTF_8, UTF_16BE, UTF_16LE, WINDOWS_1252};
use jscompat::{JsMap, base64, js_regex, trim, trim_start, truthy};
use serde::Serialize;

use crate::package::{RelInfo, resolve_relationship_target_path};

/// `AltChunkKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AltChunkKind {
    Html,
    Mht,
    Docx,
}

const DOCX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/// `altChunkKind`
pub fn alt_chunk_kind(path: &str, content_type: Option<&str>, head: &[u8]) -> Option<AltChunkKind> {
    if head.starts_with(&[0x50, 0x4b, 3, 4]) {
        return Some(AltChunkKind::Docx);
    }
    let ct = content_type.map(|ct| trim(ct.split(';').next().unwrap_or(ct)).to_lowercase());
    match ct.as_deref() {
        Some("text/html" | "application/xhtml+xml") => return Some(AltChunkKind::Html),
        Some("message/rfc822" | "multipart/related") => return Some(AltChunkKind::Mht),
        Some(DOCX_CONTENT_TYPE) => return Some(AltChunkKind::Docx),
        _ => {}
    }
    let ext = path.rsplit('.').next().unwrap_or(path).to_lowercase();
    match &*ext {
        "htm" | "html" | "xhtml" => return Some(AltChunkKind::Html),
        "mht" | "mhtml" | "eml" => return Some(AltChunkKind::Mht),
        "docx" | "docm" | "dotx" => return Some(AltChunkKind::Docx),
        _ => {}
    }
    let text = latin1(head, head.len());
    if js_regex!(r"^(MIME-Version|From|Subject|Content-Type):", "i").test(trim_start(&text)) {
        return Some(AltChunkKind::Mht);
    }
    if js_regex!(r"<!doctype\s+html|<html[\s>]", "i").test(&text) {
        return Some(AltChunkKind::Html);
    }
    None
}

/// `latin1`: bytes as Latin-1 text (header and markup sniffing).
fn latin1(bytes: &[u8], limit: usize) -> String {
    bytes
        .iter()
        .take(limit)
        .map(|byte| char::from(*byte))
        .collect()
}

/// `new TextDecoder(label)`: `None` where the constructor throws.
fn text_decoder(label: &str) -> Option<&'static Encoding> {
    // the replacement labels throw by the standard
    Encoding::for_label_no_replacement(label.as_bytes())
}

/// `new TextDecoder(label).decode(bytes)`: the BOM of the decoder's own
/// encoding is dropped (`ignoreBOM` is false), malformed input becomes U+FFFD.
fn decode(encoding: &'static Encoding, bytes: &[u8]) -> String {
    encoding.decode_with_bom_removal(bytes).0.into_owned()
}

/// `decodeWithCharset`
fn decode_with_charset(bytes: &[u8], charset: Option<&str>) -> String {
    let label = js_regex!(r#"^["']|["']$"#, "g")
        .replace_all(trim(charset.unwrap_or("")), |_| String::new())
        .to_lowercase();
    for candidate in [&*label, "utf-8"] {
        if candidate.is_empty() {
            continue;
        }
        let Some(encoding) = text_decoder(candidate) else {
            continue;
        };
        if candidate != "utf-8" {
            return decode(encoding, bytes);
        }
        // `fatal: true`: the BOM is still dropped, a malformed sequence throws
        let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
        if let Some(text) = encoding.decode_without_bom_handling_and_without_replacement(body) {
            return text.into_owned();
        }
    }
    decode(WINDOWS_1252, bytes)
}

/// `decodeHtmlBytes`: HTML bytes to a string by the BOM, then `<meta charset>`,
/// then UTF-8 with a windows-1252 fallback.
pub fn decode_html_bytes(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        return decode(UTF_8, rest);
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        return decode(UTF_16LE, rest);
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
        return decode(UTF_16BE, rest);
    }
    let head = latin1(bytes, 4096);
    let meta = js_regex!(r#"<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)"#, "i")
        .exec(&head)
        .and_then(|found| found.get(1))
        .or_else(|| {
            js_regex!(r#"<\?xml[^>]+encoding\s*=\s*["']([\w-]+)"#, "i")
                .exec(&head)
                .and_then(|found| found.get(1))
        });
    decode_with_charset(bytes, meta)
}

/// `MimePart`
struct MimePart<'a> {
    headers: JsMap<String>,
    body: &'a [u8],
}

impl MimePart<'_> {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).map(String::as_str)
    }
}

/// `parseMimeHeaders`
fn parse_mime_headers(raw: &str) -> JsMap<String> {
    let mut headers = JsMap::new();
    // folded continuation lines start with whitespace
    let unfolded = js_regex!(r"\r?\n[ \t]+", "g").replace_all(raw, |_| " ".to_owned());
    for line in js_regex!(r"\r?\n").split(&unfolded) {
        let Some(colon) = line.find(':').filter(|colon| *colon > 0) else {
            continue;
        };
        headers.set(
            trim(&line[..colon]).to_lowercase(),
            trim(&line[colon + 1..]).to_owned(),
        );
    }
    headers
}

/// The two names `headerParam` is called with; its `new RegExp` of each.
#[derive(Clone, Copy)]
enum Param {
    Boundary,
    Charset,
}

/// `headerParam`
fn header_param(value: Option<&str>, name: Param) -> Option<&str> {
    let value = truthy(value)?;
    let pattern = match name {
        Param::Boundary => js_regex!(r#"boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))"#, "i"),
        Param::Charset => js_regex!(r#"charset\s*=\s*(?:"([^"]*)"|([^;\s]+))"#, "i"),
    };
    let found = pattern.exec(value)?;
    found.get(1).or_else(|| found.get(2))
}

/// `/\r?\n\r?\n/.exec(latin1(bytes))` over the bytes: where the first match
/// starts and ends. Neither `\r?` can give back a character to let the
/// pattern match, so no backtracking is needed.
fn blank_line(text: &[u8]) -> Option<(usize, usize)> {
    (0..text.len()).find_map(|start| {
        let mut at = start;
        if text.get(at) == Some(&b'\r') {
            at += 1;
        }
        if text.get(at) != Some(&b'\n') {
            return None;
        }
        at += 1;
        if text.get(at) == Some(&b'\r') {
            at += 1;
        }
        (text.get(at) == Some(&b'\n')).then_some((start, at + 1))
    })
}

/// `splitHeadersBody`: only the first 64 KiB are searched for the blank line.
fn split_headers_body(bytes: &[u8]) -> MimePart<'_> {
    let sniffed = bytes.get(..65536).unwrap_or(bytes);
    match blank_line(sniffed) {
        None => MimePart {
            headers: parse_mime_headers(&latin1(sniffed, sniffed.len())),
            body: &[],
        },
        Some((index, end)) => MimePart {
            headers: parse_mime_headers(&latin1(sniffed, index)),
            body: bytes.get(end..).unwrap_or_default(),
        },
    }
}

/// `indexOfBytes`
fn index_of_bytes(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    let last = hay.len().checked_sub(needle.len())?;
    (from..=last).find(|at| hay.get(*at..).is_some_and(|rest| rest.starts_with(needle)))
}

/// `splitMultipart`
fn split_multipart<'a>(body: &'a [u8], boundary: &str) -> Vec<MimePart<'a>> {
    let mut parts = Vec::new();
    // `new TextEncoder().encode`: the Latin-1 text of the header as UTF-8
    let marker = format!("--{boundary}");
    let marker = marker.as_bytes();
    let mut pos = index_of_bytes(body, marker, 0);
    while let Some(at) = pos {
        let mut start = at + marker.len();
        if body.get(start) == Some(&0x2d) && body.get(start + 1) == Some(&0x2d) {
            break;
        }
        if body.get(start) == Some(&0x0d) {
            start += 1;
        }
        if body.get(start) == Some(&0x0a) {
            start += 1;
        }
        let next = index_of_bytes(body, marker, start);
        let mut end = next.unwrap_or(body.len());
        let before = |end: usize| end.checked_sub(1).and_then(|last| body.get(last)).copied();
        if before(end) == Some(0x0a) {
            end -= 1;
        }
        if before(end) == Some(0x0d) {
            end -= 1;
        }
        parts.push(split_headers_body(
            body.get(start..start.max(end)).unwrap_or_default(),
        ));
        pos = next;
    }
    parts
}

/// `decodeQuotedPrintable`. The text is read by UTF-16 code unit, each giving
/// its low byte where it is not an `=XX` escape.
pub fn decode_quoted_printable(text: &str) -> Vec<u8> {
    quoted_printable(text.encode_utf16(), text.len())
}

/// `decodeQuotedPrintable` over code units: UTF-16 for a string, bytes for
/// `latin1(bytes)`. One pass, holding three units at a time: the TypeScript
/// counts the output in a first pass to size it, and a 32 MiB part must
/// decode at about its own size (the memory test of the package).
fn quoted_printable(units: impl Iterator<Item = u16>, len: usize) -> Vec<u8> {
    let mut src = SoftBreaksRemoved {
        units,
        ahead: std::collections::VecDeque::with_capacity(2),
    };
    let hex = |unit: u16| char::from_u32(u32::from(unit)).and_then(|ch| ch.to_digit(16));
    let mut out = Vec::with_capacity(len);
    // the current unit and the two after it: an `=XX` escape needs both
    let (mut a, mut b, mut c) = (src.next(), src.next(), src.next());
    while let Some(unit) = a {
        if unit == 0x3d
            && let (Some(high), Some(low)) = (b.and_then(hex), c.and_then(hex))
        {
            out.push(u8::try_from(high * 16 + low).unwrap_or_default());
            (a, b, c) = (src.next(), src.next(), src.next());
            continue;
        }
        out.push(unit.to_le_bytes()[0]);
        (a, b, c) = (b, c, src.next());
    }
    out
}

/// `text.replace(/=\r?\n/g, '')` as it is read.
struct SoftBreaksRemoved<I> {
    units: I,
    ahead: std::collections::VecDeque<u16>,
}

impl<I: Iterator<Item = u16>> Iterator for SoftBreaksRemoved<I> {
    type Item = u16;

    fn next(&mut self) -> Option<u16> {
        loop {
            let unit = self.ahead.pop_front().or_else(|| self.units.next())?;
            if unit != 0x3d {
                return Some(unit);
            }
            while self.ahead.len() < 2 {
                let Some(next) = self.units.next() else { break };
                self.ahead.push_back(next);
            }
            match (self.ahead.front(), self.ahead.get(1)) {
                (Some(0x0a), _) => {
                    self.ahead.pop_front();
                }
                (Some(0x0d), Some(0x0a)) => {
                    self.ahead.drain(..2);
                }
                _ => return Some(unit),
            }
        }
    }
}

/// `decodeBase64`: the bytes that are not base64 dropped, then `atob`
/// (forgiving-base64 decode), which throws on what is left malformed.
fn decode_base64(text: &[u8]) -> Result<Vec<u8>, String> {
    let clean: Vec<u8> = text
        .iter()
        .copied()
        .filter(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        .collect();
    let mut data = &clean[..];
    if data.len().is_multiple_of(4) {
        data = data
            .strip_suffix(b"==")
            .or_else(|| data.strip_suffix(b"="))
            .unwrap_or(data);
    }
    if data.len() % 4 == 1 || data.contains(&b'=') {
        return Err("InvalidCharacterError: Invalid character".to_owned());
    }
    let sextet = |byte: u8| -> u32 {
        match byte {
            b'A'..=b'Z' => u32::from(byte - b'A'),
            b'a'..=b'z' => u32::from(byte - b'a') + 26,
            b'0'..=b'9' => u32::from(byte - b'0') + 52,
            b'+' => 62,
            _ => 63,
        }
    };
    let mut out = Vec::with_capacity(data.len() / 4 * 3 + 2);
    for group in data.chunks(4) {
        let bits = group
            .iter()
            .fold(0u32, |bits, byte| bits << 6 | sextet(*byte))
            << (6 * (4 - group.len()));
        let bytes = bits.to_be_bytes();
        // 4 characters give 3 bytes, 3 give 2, 2 give 1: the rest are spare bits
        out.extend_from_slice(bytes.get(1..group.len()).unwrap_or_default());
    }
    Ok(out)
}

/// `decodeTransfer`
fn decode_transfer<'a>(part: &MimePart<'a>) -> Result<Cow<'a, [u8]>, String> {
    let enc = part.header("content-transfer-encoding").unwrap_or("");
    // `toLowerCase()` of Latin-1 text maps no character but A-Z onto a-z
    if enc.eq_ignore_ascii_case("quoted-printable") {
        return Ok(Cow::Owned(quoted_printable(
            part.body.iter().map(|&byte| u16::from(byte)),
            part.body.len(),
        )));
    }
    if enc.eq_ignore_ascii_case("base64") {
        return decode_base64(part.body).map(Cow::Owned);
    }
    Ok(Cow::Borrowed(part.body))
}

/// `decodeMhtToHtml`: MHT (Word "Single File Web Page") to the HTML document
/// string. Referenced image parts are inlined as data URLs by
/// Content-Location and Content-ID. `Err` where `atob` throws.
pub fn decode_mht_to_html(bytes: &[u8]) -> Result<Option<String>, String> {
    let top = split_headers_body(bytes);
    let boundary = header_param(top.header("content-type"), Param::Boundary)
        .filter(|boundary| !boundary.is_empty())
        .map(str::to_owned);
    let parts = match boundary {
        Some(boundary) => split_multipart(top.body, &boundary),
        None => vec![top],
    };
    let Some(html_index) = parts.iter().position(|part| {
        js_regex!(r"^text\/html", "i").test(trim(part.header("content-type").unwrap_or("")))
    }) else {
        return Ok(None);
    };
    let Some(html_part) = parts.get(html_index) else {
        return Ok(None);
    };
    let html_bytes = decode_transfer(html_part)?;
    let charset = header_param(html_part.header("content-type"), Param::Charset);
    let html = match charset.filter(|charset| !charset.is_empty()) {
        Some(charset) => decode_with_charset(&html_bytes, Some(charset)),
        None => decode_html_bytes(&html_bytes),
    };
    let base_location = html_part.header("content-location").unwrap_or("");
    // one map and one pass over the html
    let mut inline: JsMap<Rc<str>> = JsMap::new();
    for (index, part) in parts.iter().enumerate() {
        if index == html_index {
            continue;
        }
        let content_type = part.header("content-type").unwrap_or("");
        let ct = trim(content_type.split(';').next().unwrap_or(content_type)).to_lowercase();
        if !ct.starts_with("image/") {
            continue;
        }
        let data_url: Rc<str> =
            format!("data:{ct};base64,{}", base64(&decode_transfer(part)?)).into();
        if let Some(location) = truthy(part.header("content-location")) {
            inline.set(location.to_lowercase(), Rc::clone(&data_url));
            if !base_location.is_empty() {
                // `baseLocation.replace(/[^/]*$/, '')`
                let base = js_regex!(r"[^/]*$")
                    .exec(base_location)
                    .map_or(base_location, |found| &base_location[..found.start()]);
                if let Some(relative) = location.strip_prefix(base) {
                    inline.set(relative.to_lowercase(), Rc::clone(&data_url));
                }
            }
        }
        let cid = part
            .header("content-id")
            .map(|id| js_regex!(r"^<|>$", "g").replace_all(id, |_| String::new()));
        if let Some(cid) = cid.filter(|cid| !cid.is_empty()) {
            inline.set(format!("cid:{cid}").to_lowercase(), data_url);
        }
    }
    if inline.is_empty() {
        return Ok(Some(html));
    }
    Ok(Some(
        js_regex!(
            r#"\b(src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))"#,
            "gi"
        )
        .replace_all(&html, |found| {
            let key = found
                .get(2)
                .or_else(|| found.get(3))
                .or_else(|| found.get(4))
                .unwrap_or("")
                .to_lowercase();
            match inline.get(&key) {
                None => found.as_str().to_owned(),
                Some(data_url) => {
                    let quote = if found.get(3).is_some() { '\'' } else { '"' };
                    let attr = found.get(1).unwrap_or("");
                    format!("{attr}={quote}{data_url}{quote}")
                }
            }
        }),
    ))
}

/// `altChunkPartPath`; `source_path` defaults to `word/document.xml`.
pub fn alt_chunk_part_path(
    rels: &JsMap<RelInfo>,
    r_id: &str,
    source_path: Option<&str>,
) -> Option<String> {
    let source_path = source_path.unwrap_or("word/document.xml");
    let rel = rels.get(r_id)?;
    if rel.target_mode.as_deref() == Some("External")
        || !js_regex!(r"\/aFChunk$").test(&rel.rel_type)
    {
        return None;
    }
    resolve_relationship_target_path(source_path, &rel.target)
}
