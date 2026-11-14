//! `packages/file-parse/src/hidden-content.ts`: whether a file holds content a
//! person hid from AI, read from its bytes only. Only whether a mark is there
//! is read, never what it hides.

use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};
use jscompat::{is_js_space, js_regex, try_js_regex};
use ooxml_pkg::{DEFAULT_ZIP_LIMITS, LoadFailure, load_zip_package_staged};

use crate::pptx_redaction::PPTX_REDACT_EXT_URI;
use crate::redaction::REDACT_NAMESPACES;

/// The first words of the message of a `RedactionMarkError`.
const REDACTION_MARK_ERROR_PREFIX: &str = "Redaction marks in this file";

/// the formats whose files can hold the mark, by extension
pub const HIDDEN_CONTENT_EXTENSIONS: [&str; 8] = [
    "docx", "pptx", "xlsx", "xlsm", "md", "markdown", "html", "htm",
];

/// `0x10ffff` has seven decimal digits and six hexadecimal ones; a run of more
/// digits (leading zeros aside) is past it however `Number` or `parseInt`
/// round it.
fn code_point_of(digits: &str, radix: u32, max_digits: usize) -> Option<char> {
    let significant = digits.trim_start_matches('0');
    if significant.len() > max_digits {
        return None;
    }
    let code = if significant.is_empty() {
        0
    } else {
        u32::from_str_radix(significant, radix).ok()?
    };
    // a surrogate and anything past 0x10ffff are left as written
    char::from_u32(code)
}

/// `/&#(?:x([0-9a-fA-F]+)|(\d+));/g` replaced by the code point where it is one
fn spelled_out(xml: &str) -> String {
    if !xml.contains("&#") {
        return xml.to_owned();
    }
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(at) = rest.find("&#") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 2..];
        let (radix, body) = match after.strip_prefix('x') {
            Some(hex) => (16, hex),
            None => (10, after),
        };
        let length = body
            .bytes()
            .take_while(|byte| {
                if radix == 16 {
                    byte.is_ascii_hexdigit()
                } else {
                    byte.is_ascii_digit()
                }
            })
            .count();
        if length > 0 && body[length..].starts_with(';') {
            let consumed = at + 2 + (after.len() - body.len()) + length + 1;
            match code_point_of(&body[..length], radix, if radix == 16 { 6 } else { 7 }) {
                Some(found) => out.push(found),
                None => out.push_str(&rest[at..consumed]),
            }
            rest = &rest[consumed..];
        } else {
            out.push_str("&#");
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-')
}

/// `/<(?:[\w.-]+:)?redact[\s/>]/`
fn holds_redact_element(text: &str) -> bool {
    let bytes = text.as_bytes();
    let redact_at = |from: usize| -> bool {
        let Some(after) = text[from..].strip_prefix("redact") else {
            return false;
        };
        after
            .chars()
            .next()
            .is_some_and(|next| next == '/' || next == '>' || is_js_space(next))
    };
    let mut from = 0;
    while let Some(found) = text[from..].find('<') {
        let start = from + found + 1;
        // a prefix is the whole run of name characters, then a colon
        let run = bytes[start..]
            .iter()
            .take_while(|byte| is_name_byte(**byte))
            .count();
        if run > 0 && bytes.get(start + run) == Some(&b':') && redact_at(start + run + 1) {
            return true;
        }
        if redact_at(start) {
            return true;
        }
        from = start;
    }
    false
}

/// Whether a package part's XML shows a trace of the mark (docx run mark, deck extension).
pub fn xml_holds_mark(xml: &str) -> bool {
    let text = spelled_out(xml);
    REDACT_NAMESPACES.iter().any(|ns| text.contains(ns))
        || text.contains(PPTX_REDACT_EXT_URI)
        || holds_redact_element(&text)
}

/// Whether a Markdown file's text holds a span hidden from AI. `Err` where the
/// search stops at its bound.
pub fn markdown_holds_mark(text: &str) -> Result<bool, String> {
    try_js_regex!(r"<span\b[^>]*\bdata-redaction\b", "i")
        .try_test(text)
        .map_err(|limit| limit.to_string())
}

/// Whether an HTML page's text holds any mark of the HTML app.
pub fn html_holds_mark(text: &str) -> bool {
    js_regex!(r"data-gx-redact|gx:redact:", "i").test(text)
}

/// The text of a page or Markdown file as far as the marks need it.
fn mark_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        return UTF_16LE.decode_without_bom_handling(rest).0.into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xfe, 0xff]) {
        return UTF_16BE.decode_without_bom_handling(rest).0.into_owned();
    }
    WINDOWS_1252
        .decode_without_bom_handling(bytes)
        .0
        .into_owned()
}

/// `^word/.*\.xml$` (`prefix` `word/`) and `^ppt/.*\.xml$`: `.` takes no line terminator
fn is_part_under(path: &str, prefix: &str) -> bool {
    let Some(middle) = path
        .strip_prefix(prefix)
        .and_then(|rest| rest.strip_suffix(".xml"))
    else {
        return false;
    };
    !middle.contains(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// Whether a file with extension `ext` (no dot) holds content hidden from AI.
/// `Err` is what the TypeScript throws, and every refusal that closes the
/// caller: a zip the gate refuses, a part that cannot be read, a search that
/// reached its bound.
pub fn file_holds_hidden_content(bytes: &[u8], ext: &str) -> Result<bool, String> {
    let lowered = ext.to_lowercase();
    let kind = lowered.strip_prefix('.').unwrap_or(&lowered);
    if !HIDDEN_CONTENT_EXTENSIONS.contains(&kind) {
        return Ok(false);
    }
    match kind {
        "md" | "markdown" => return markdown_holds_mark(&mark_text(bytes)),
        "html" | "htm" => return Ok(html_holds_mark(&mark_text(bytes))),
        "xlsx" | "xlsm" => {
            if !bytes.starts_with(b"PK") {
                return Ok(false);
            }
            return match crate::xlsx::xlsx_withheld_cells(bytes) {
                Ok(withheld) => Ok(withheld.is_some()),
                Err(message) if message.starts_with(REDACTION_MARK_ERROR_PREFIX) => Ok(true),
                Err(message) => Err(message),
            };
        }
        _ => {}
    }
    /// JSZip's `lastIndexOfSignature` for the end of central directory record,
    /// with room after it for the record's 22 bytes.
    fn has_whole_end_record(bytes: &[u8]) -> bool {
        const END_RECORD: usize = 22;
        bytes
            .windows(4)
            .rposition(|window| window == b"PK\x05\x06")
            .is_some_and(|at| bytes.len() - at >= END_RECORD)
    }
    // `JSZip.loadAsync(bytes).catch(() => null)`: a zip JSZip cannot load holds
    // no mark. JSZip reads the end record at the last signature in the file and
    // fails when there is none or when fewer than its 22 bytes follow it; the
    // gate fails on those too. Any other refusal of the gate stays an error,
    // the closed side.
    let package = match load_zip_package_staged(bytes, &DEFAULT_ZIP_LIMITS, false) {
        Ok(package) => package,
        Err(LoadFailure::Archive(_)) => return Ok(false),
        Err(_) if !has_whole_end_record(bytes) => return Ok(false),
        Err(failure) => return Err(failure.into_message()),
    };
    let prefix = if kind == "docx" { "word/" } else { "ppt/" };
    for part in package.parts() {
        if part.is_dir || !is_part_under(part.name.as_str(), prefix) {
            continue;
        }
        let text = part.text().map_err(|error| error.to_string())?;
        if xml_holds_mark(text) {
            return Ok(true);
        }
    }
    Ok(false)
}
