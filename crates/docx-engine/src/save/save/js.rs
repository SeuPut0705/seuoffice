//! The JavaScript string operations the save writes in, over what `jscompat`
//! gives: UTF-16 lengths and slices, the first-match replacements whose
//! search can pass the regex bound, and the base64 JSZip reads.

use jscompat::{JsMatch, RegexLimit, TryJsRegex, get_substitution};

/// A search that stopped at the bound, or a regex that did not compile, as
/// the message the TypeScript's thrown error would carry.
pub fn limit(error: RegexLimit) -> String {
    error.to_string()
}

/// `text.length`
pub fn len16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.replace(regex, replacement)` for a regex without the `g` flag that
/// has `groups` capture groups; the `$` patterns of `replacement` apply.
pub fn replace_first(
    regex: &TryJsRegex,
    groups: usize,
    text: &str,
    replacement: &str,
) -> Result<String, String> {
    let Some(found) = regex.try_exec(text).map_err(limit)? else {
        return Ok(text.to_owned());
    };
    let captures: Vec<Option<&str>> = (1..=groups).map(|index| found.get(index)).collect();
    let mut out = String::with_capacity(text.len() + replacement.len());
    out.push_str(&text[..found.start()]);
    out.push_str(&get_substitution(
        found.as_str(),
        text,
        found.start(),
        &captures,
        replacement,
    ));
    out.push_str(&text[found.end()..]);
    Ok(out)
}

/// `text.replace(regex, (m) => replacement(m))` for a regex without the `g` flag.
pub fn replace_first_with(
    regex: &TryJsRegex,
    text: &str,
    replacement: impl FnOnce(&JsMatch<'_>) -> String,
) -> Result<String, String> {
    let Some(found) = regex.try_exec(text).map_err(limit)? else {
        return Ok(text.to_owned());
    };
    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..found.start()]);
    out.push_str(&replacement(&found));
    out.push_str(&text[found.end()..]);
    Ok(out)
}

/// `text.replace(regex, (m) => replacement(m))` with the `g` flag.
pub fn replace_all_with(
    regex: &TryJsRegex,
    text: &str,
    replacement: impl FnMut(&JsMatch<'_>) -> String,
) -> Result<String, String> {
    regex.try_replace_all(text, replacement).map_err(limit)
}

/// `new RegExp(pattern, flags)` over a pattern built at run time: refused as
/// JavaScript refuses a bad pattern.
pub fn dynamic(pattern: &str, flags: &str) -> Result<TryJsRegex, String> {
    TryJsRegex::new(pattern, flags).map_err(|error| error.to_string())
}

/// JSZip's `base64.decode` of a `{ base64: true }` file: characters outside
/// the alphabet are dropped, a data URL or a length that is no whole number
/// of bytes is refused.
pub fn jszip_base64(input: &str) -> Result<Vec<u8>, String> {
    if input.starts_with("data:") {
        return Err("Invalid base64 input, it looks like a data url.".to_owned());
    }
    let chars: Vec<u8> = input
        .bytes()
        .filter(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        .collect();
    if !chars.len().is_multiple_of(4) {
        return Err("Invalid base64 input, bad content length.".to_owned());
    }
    let value = |byte: u8| -> u8 {
        match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => 64,
        }
    };
    let mut out = Vec::with_capacity(chars.len() / 4 * 3);
    for group in chars.chunks(4) {
        let (e1, e2, e3, e4) = (
            value(group[0]),
            value(group[1]),
            value(group[2]),
            value(group[3]),
        );
        out.push((e1 << 2) | (e2 >> 4));
        if e3 != 64 {
            out.push(((e2 & 15) << 4) | (e3 >> 2));
        }
        if e4 != 64 {
            out.push(((e3 & 3) << 6) | e4);
        }
    }
    Ok(out)
}
