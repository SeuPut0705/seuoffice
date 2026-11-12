//! `String.prototype.slice`, `String.prototype.replace` with a replacement
//! string, and `<` on strings.

use crate::JsRegex;

/// `text.slice(start, end)`, the indexes counted in UTF-16 code units: a
/// negative one counts from the end, NaN is 0, `None` for `end` is the length.
/// A surrogate pair cut in half gives U+FFFD where JavaScript keeps the lone
/// half, which a Rust string cannot hold.
pub fn slice_utf16(text: &str, start: f64, end: Option<f64>) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let length = units.len() as f64;
    let clamp = |index: f64| {
        let index = if index.is_nan() { 0.0 } else { index.trunc() };
        if index < 0.0 {
            (length + index).max(0.0)
        } else {
            index.min(length)
        }
    };
    let from = clamp(start);
    let to = end.map_or(length, clamp);
    if to <= from {
        return String::new();
    }
    String::from_utf16_lossy(&units[from as usize..to as usize])
}

/// `a < b` on strings: UTF-16 code units compared in order, a prefix first.
/// Rust orders by code point, which differs above U+FFFF.
pub fn string_less_than(a: &str, b: &str) -> bool {
    a.encode_utf16().lt(b.encode_utf16())
}

/// GetSubstitution of ECMAScript: `replacement` with `$$`, `$&`, `` $` ``,
/// `$'`, `$n` and `$nn` expanded for a match of `matched` at byte `position`
/// of `text`. `captures` are the groups of the pattern, `None` for one that did
/// not take part. `$<` and a `$n` past the groups stay as written.
pub fn get_substitution(
    matched: &str,
    text: &str,
    position: usize,
    captures: &[Option<&str>],
    replacement: &str,
) -> String {
    let mut out = String::with_capacity(replacement.len());
    let mut rest = replacement;
    while let Some(at) = rest.find('$') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let bytes = rest.as_bytes();
        let taken = match bytes.get(1).copied() {
            Some(b'$') => {
                out.push('$');
                2
            }
            Some(b'&') => {
                out.push_str(matched);
                2
            }
            Some(b'`') => {
                out.push_str(text.get(..position).unwrap_or(""));
                2
            }
            Some(b'\'') => {
                let tail = (position + matched.len()).min(text.len());
                out.push_str(text.get(tail..).unwrap_or(""));
                2
            }
            Some(first @ b'0'..=b'9') => {
                let one = usize::from(first - b'0');
                let two = bytes
                    .get(2)
                    .filter(|digit| digit.is_ascii_digit())
                    .map(|digit| one * 10 + usize::from(digit - b'0'));
                let (index, length) = match two {
                    Some(index) if index <= captures.len() => (index, 3),
                    _ => (one, 2),
                };
                match index.checked_sub(1).and_then(|at| captures.get(at)) {
                    Some(capture) => out.push_str(capture.unwrap_or("")),
                    None => out.push_str(&rest[..length]),
                }
                length
            }
            _ => {
                out.push('$');
                1
            }
        };
        rest = &rest[taken..];
    }
    out.push_str(rest);
    out
}

/// `text.replace(regex, replacement)` for a regex without the `g` flag that
/// has `groups` capture groups: the first match only, `$` patterns of
/// `replacement` expanded.
pub fn replace_first(regex: &JsRegex, groups: usize, text: &str, replacement: &str) -> String {
    let Some(found) = regex.exec(text) else {
        return text.to_owned();
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
    out
}

/// `text.replace(needle, replacement)` with a string `needle`: the first
/// occurrence only, the replacement patterns applied.
pub fn replace_first_string(text: &str, needle: &str, replacement: &str) -> String {
    match text.find(needle) {
        Some(at) => {
            let end = at + needle.len();
            let piece = get_substitution(&text[at..end], text, at, &[], replacement);
            format!("{}{piece}{}", &text[..at], &text[end..])
        }
        None => text.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // answers of node 22: 'a-b-c'.replace('-', R)
    #[test]
    fn string_patterns() {
        assert_eq!(replace_first_string("a-b-c", "-", "[$&]"), "a[-]b-c");
        assert_eq!(replace_first_string("a-b-c", "-", "$$"), "a$b-c");
        assert_eq!(replace_first_string("a-b-c", "-", "$`"), "aab-c");
        assert_eq!(replace_first_string("a-b-c", "-", "$'"), "ab-cb-c");
        assert_eq!(replace_first_string("a-b-c", "-", "$1$"), "a$1$b-c");
        assert_eq!(replace_first_string("a-b-c", "x", "$&"), "a-b-c");
        assert_eq!(replace_first_string("abc", "", "$&!"), "!abc");
    }

    // 'xaby'.replace(/(a)(b)?/, R) and /(a)/ for $nn falling back to $n
    #[test]
    fn group_patterns() {
        let g = [Some("a"), None];
        assert_eq!(get_substitution("a", "xay", 1, &g, "<$1|$2|$3>"), "<a||$3>");
        assert_eq!(get_substitution("a", "xay", 1, &g, "$01$10$0"), "aa0$0");
    }
}
