//! `indexOf`, `lastIndexOf`, a prefix counted in UTF-16 code units and
//! `replace` with a function. Offsets are UTF-8 bytes, as everywhere in the
//! engines; where JavaScript counts UTF-16 code units the function says how
//! it maps.

use crate::{JsMatch, JsRegex, RegexLimit, TryJsRegex};

/// `text.indexOf(search, from)` for a `from` inside the text, on a character
/// boundary.
pub fn index_of(text: &str, search: &str, from: usize) -> Option<usize> {
    text.get(from..)?.find(search).map(|at| at + from)
}

/// `text.lastIndexOf(search, from)`: the last occurrence starting at or
/// before `from`, a negative `from` reading as 0. A byte offset at a character
/// boundary stands for the same place as JavaScript's UTF-16 index, and one
/// inside a character for its last code unit, so the answer is the same
/// place.
pub fn last_index_of(text: &str, search: &str, from: i64) -> Option<usize> {
    let haystack = text.as_bytes();
    let needle = search.as_bytes();
    let last_start = haystack.len().checked_sub(needle.len())?;
    let from = usize::try_from(from.max(0))
        .unwrap_or(usize::MAX)
        .min(last_start);
    (0..=from).rev().find(|&at| {
        text.is_char_boundary(at)
            && haystack
                .get(at..)
                .is_some_and(|rest| rest.starts_with(needle))
    })
}

/// `text.slice(0, units)` where `units` counts UTF-16 code units. A pair the
/// end would split is left out whole: a Rust string cannot hold half of it.
pub fn prefix_utf16(text: &str, units: usize) -> &str {
    let mut count = 0;
    for (at, ch) in text.char_indices() {
        count += ch.len_utf16();
        if count > units {
            return text.get(..at).unwrap_or(text);
        }
    }
    text
}

/// `text.replace(regex, (m) => replacement(m))` of a regex without the `g`
/// flag: the first match only.
pub fn replace_first_with(
    regex: &JsRegex,
    text: &str,
    replacement: impl FnOnce(&JsMatch<'_>) -> String,
) -> String {
    let Some(found) = regex.exec(text) else {
        return text.to_owned();
    };
    let mut out = String::with_capacity(text.len());
    out.push_str(text.get(..found.start()).unwrap_or_default());
    out.push_str(&replacement(&found));
    out.push_str(text.get(found.end()..).unwrap_or_default());
    out
}

/// `text.replace(regex, (m) => replacement(m))` of a regex built at run time,
/// without the `g` flag: the first match only; [`RegexLimit`] if the search stopped.
pub fn try_replace_first_with(
    regex: &TryJsRegex,
    text: &str,
    replacement: impl FnOnce(&JsMatch<'_>) -> String,
) -> Result<String, RegexLimit> {
    let Some(found) = regex.try_exec(text)? else {
        return Ok(text.to_owned());
    };
    let mut out = String::with_capacity(text.len());
    out.push_str(text.get(..found.start()).unwrap_or_default());
    out.push_str(&replacement(&found));
    out.push_str(text.get(found.end()..).unwrap_or_default());
    Ok(out)
}

/// A pattern built at run time, written the way `new RegExp(pattern)` without
/// the `u` flag reads it: a character outside the BMP is two code units, and
/// `\uD83D(?:)\uDE00` written for each says so where the pattern text itself
/// cannot (`JsRegex::new` refuses such a character, and a pair of adjacent
/// escapes). Equal to the pattern
/// when it holds none.
pub fn units_pattern(pattern: &str) -> std::borrow::Cow<'_, str> {
    if pattern.chars().all(|c| c.len_utf8() < 4) {
        return std::borrow::Cow::Borrowed(pattern);
    }
    let mut out = String::with_capacity(pattern.len() + 8);
    for c in pattern.chars() {
        if c.len_utf8() < 4 {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            let [high, low] = *c.encode_utf16(&mut units).iter().as_slice() else {
                unreachable!("a character outside the BMP is two units")
            };
            // the empty group keeps the two halves from reading as one character
            out.push_str(&format!("\\u{high:04X}(?:)\\u{low:04X}"));
        }
    }
    std::borrow::Cow::Owned(out)
}

/// Text as a pattern that matches only itself: every syntax character of a
/// regular expression escaped with a backslash, and `/` too.
pub fn regex_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(
            c,
            '\\' | '^'
                | '$'
                | '.'
                | '*'
                | '+'
                | '?'
                | '('
                | ')'
                | '['
                | ']'
                | '{'
                | '}'
                | '|'
                | '/'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_pattern_names_astral_characters_by_their_units() {
        assert_eq!(super::units_pattern("a(b"), "a(b");
        assert_eq!(
            super::units_pattern("Id=\"\u{1F600}\""),
            "Id=\"\\uD83D(?:)\\uDE00\""
        );
        let pattern = super::units_pattern("Id=\"\u{1F600}\"");
        let re = crate::TryJsRegex::new(&pattern, "").unwrap();
        assert!(re.try_test("x Id=\"\u{1F600}\" y").unwrap());
        assert!(!re.try_test("x Id=\"b\" y").unwrap());
    }

    use super::*;

    #[test]
    fn escaped_text_matches_itself_only() {
        let text = r"a+(b)[c]{2}.*?^$|\/";
        // a pattern made at run time, as the callers make theirs
        let escaped = regex_escape(text);
        let regex = crate::TryJsRegex::new(&escaped, "").unwrap();
        let found = regex.try_exec(text).unwrap();
        assert_eq!(found.map(|found| found.as_str()), Some(text));
        let escaped = regex_escape("+21");
        let plus = crate::TryJsRegex::new(&escaped, "").unwrap();
        assert_eq!(plus.try_test("221"), Ok(false));
        assert_eq!(plus.try_test("+21"), Ok(true));
    }

    #[test]
    fn try_replace_first_replaces_one_match() {
        let regex = TryJsRegex::new("a", "").unwrap();
        assert_eq!(
            try_replace_first_with(&regex, "aa", |_| "b".to_owned()).unwrap(),
            "ba"
        );
    }

    #[test]
    fn last_index_of_clamps() {
        assert_eq!(last_index_of("<a<a", "<a", 3), Some(2));
        assert_eq!(last_index_of("<a<a", "<a", 1), Some(0));
        assert_eq!(last_index_of("<a<a", "<a", -1), Some(0));
        assert_eq!(last_index_of("x<a", "<a", 0), None);
        assert_eq!(last_index_of("\u{D55C}<a", "<a", 2), None);
        assert_eq!(last_index_of("\u{D55C}<a", "<a", 3), Some(3));
    }

    #[test]
    fn slice_counts_utf16_units() {
        assert_eq!(prefix_utf16("\u{D55C}ab", 2), "\u{D55C}a");
        assert_eq!(prefix_utf16("a\u{1F600}b", 2), "a");
        assert_eq!(prefix_utf16("a\u{1F600}b", 3), "a\u{1F600}");
        assert_eq!(prefix_utf16("ab", 9), "ab");
    }
}
