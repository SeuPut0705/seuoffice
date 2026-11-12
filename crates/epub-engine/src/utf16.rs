//! JavaScript strings as UTF-16 code units.
//!
//! A chapter, a block text and a notation are JavaScript strings that can hold
//! a lone surrogate (a range may split a pair, `&#xD800;` decodes to one), which
//! a Rust `String` cannot. Everything that can carry one is a `Vec<u16>`; the
//! helpers here are the string methods the ports use, on units.

use serde_json::Value;

/// A string literal as units.
pub fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// The units as text; a lone surrogate becomes U+FFFD, as it does when
/// JavaScript writes the string as UTF-8.
pub fn lossy(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// `text.indexOf(needle, from)` for a `from` that is a valid offset.
pub fn index_of(text: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if from > text.len() {
        return if needle.is_empty() {
            Some(text.len())
        } else {
            None
        };
    }
    if needle.is_empty() {
        return Some(from);
    }
    (from..text.len().saturating_sub(needle.len() - 1)).find(|&at| text[at..].starts_with(needle))
}

/// `text.lastIndexOf(unit, from)`; a negative `from` counts as 0 and `None` stands for -1.
pub fn last_index_of_unit(text: &[u16], unit: u16, from: isize) -> Option<usize> {
    if text.is_empty() {
        return None;
    }
    let start = (from.max(0) as usize).min(text.len() - 1);
    (0..=start).rev().find(|&at| text[at] == unit)
}

/// `/\s/` of a JavaScript regular expression, on one unit. A surrogate is no space.
pub fn is_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(jscompat::is_js_space)
}

/// `/[ \t\r\n]/`
pub fn is_ascii_blank(unit: u16) -> bool {
    matches!(unit, 0x20 | 0x09 | 0x0D | 0x0A)
}

/// `text.trim()`
pub fn trim(text: &[u16]) -> &[u16] {
    let start = text
        .iter()
        .position(|&u| !is_space(u))
        .unwrap_or(text.len());
    let end = text
        .iter()
        .rposition(|&u| !is_space(u))
        .map_or(start, |i| i + 1);
    &text[start..end]
}

/// `text.trim() === ''`
pub fn is_blank(text: &[u16]) -> bool {
    text.iter().all(|&u| is_space(u))
}

/// A list of code units as the diff wire writes a string.
pub fn to_wire(units: &[u16]) -> Value {
    Value::Array(units.iter().map(|&u| Value::from(u)).collect())
}

/// The units of a wire string; `None` where the value is not a list of them.
pub fn from_wire(value: &Value) -> Option<Vec<u16>> {
    value
        .as_array()?
        .iter()
        .map(|unit| u16::try_from(unit.as_u64()?).ok())
        .collect()
}

/// `JSON.stringify(text)`: the string quoted, a lone surrogate written as its
/// `\udXXX` escape.
pub fn json_quote(text: &[u16], out: &mut String) {
    out.push('"');
    let mut i = 0;
    while i < text.len() {
        let unit = text[i];
        let (ch, width) = match unit {
            0xD800..=0xDBFF
                if text
                    .get(i + 1)
                    .is_some_and(|n| (0xDC00..=0xDFFF).contains(n)) =>
            {
                let pair = [unit, text[i + 1]];
                (char::decode_utf16(pair).next().and_then(Result::ok), 2)
            }
            0xD800..=0xDFFF => (None, 1),
            _ => (char::from_u32(u32::from(unit)), 1),
        };
        match ch {
            None => out.push_str(&format!("\\u{unit:04x}")),
            Some('"') => out.push_str("\\\""),
            Some('\\') => out.push_str("\\\\"),
            Some('\u{8}') => out.push_str("\\b"),
            Some('\u{c}') => out.push_str("\\f"),
            Some('\n') => out.push_str("\\n"),
            Some('\r') => out.push_str("\\r"),
            Some('\t') => out.push_str("\\t"),
            Some(c) if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            Some(c) => out.push(c),
        }
        i += width;
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_quote_escapes_like_json_stringify() {
        let mut out = String::new();
        json_quote(
            &[
                0x61, 0x22, 0x5c, 0x0a, 0x1f, 0xD800, 0x62, 0xD83D, 0xDE00, 0xDC00,
            ],
            &mut out,
        );
        assert_eq!(out, "\"a\\\"\\\\\\n\\u001f\\ud800b\u{1F600}\\udc00\"");
    }

    #[test]
    fn index_of_follows_the_string_method() {
        let hay = units("a;b;c");
        assert_eq!(index_of(&hay, &units(";"), 0), Some(1));
        assert_eq!(index_of(&hay, &units(";"), 2), Some(3));
        assert_eq!(index_of(&hay, &units(";"), 4), None);
        assert_eq!(index_of(&hay, &units(""), 9), Some(5));
    }

    #[test]
    fn last_index_of_unit_clamps_and_misses() {
        let hay = units("a\nb\nc");
        assert_eq!(last_index_of_unit(&hay, 0x0A, 3), Some(3));
        assert_eq!(last_index_of_unit(&hay, 0x0A, 2), Some(1));
        assert_eq!(last_index_of_unit(&hay, 0x0A, -1), None);
        assert_eq!(last_index_of_unit(&units("\nb"), 0x0A, -1), Some(0));
        assert_eq!(last_index_of_unit(&hay, 0x0A, 99), Some(3));
    }
}
