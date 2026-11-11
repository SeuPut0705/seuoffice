//! JavaScript regular expressions, so a pattern is ported by copying it.
//!
//! The engine is `regress`, which implements the ECMAScript grammar and
//! matching rules (ASCII `\d` `\w` `\b`, JavaScript `\s`, lookaround,
//! backreferences). It walks UTF-8 text by character, where JavaScript without
//! the `u` flag walks UTF-16 code units: a character outside the BMP counts
//! once here and twice there. That shows only where a pattern counts
//! characters (`.{2}`, `[^x]{3}`); the result offsets are bytes either way.

use std::fmt;

#[derive(Debug)]
pub struct JsRegex {
    regex: regress::Regex,
}

/// What `new RegExp(pattern)` throws as a `SyntaxError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegexSyntaxError(String);

impl fmt::Display for RegexSyntaxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Invalid regular expression: {}", self.0)
    }
}

impl std::error::Error for RegexSyntaxError {}

/// One match: `m[0]`, `m[1]`... of JavaScript, and `m.index` as a byte offset.
#[derive(Debug, Clone)]
pub struct JsMatch<'t> {
    text: &'t str,
    found: regress::Match,
}

impl<'t> JsMatch<'t> {
    /// `m[index]`; `None` where JavaScript has `undefined` (a group that did
    /// not take part in the match).
    pub fn get(&self, index: usize) -> Option<&'t str> {
        self.found.group(index).map(|range| &self.text[range])
    }

    /// `m[0]`
    pub fn as_str(&self) -> &'t str {
        &self.text[self.found.range()]
    }

    pub fn start(&self) -> usize {
        self.found.start()
    }

    pub fn end(&self) -> usize {
        self.found.end()
    }
}

impl JsRegex {
    /// `new RegExp(pattern, flags)`. The `g` flag is not state here: use
    /// [`JsRegex::find_iter`] or [`JsRegex::find_from`] where the JavaScript
    /// loops on `lastIndex`.
    pub fn new(pattern: &str, flags: &str) -> Result<Self, RegexSyntaxError> {
        regress::Regex::with_flags(pattern, flags)
            .map(|regex| Self { regex })
            .map_err(|error| RegexSyntaxError(error.to_string()))
    }

    /// `regex.test(text)`
    pub fn test(&self, text: &str) -> bool {
        self.regex.find(text).is_some()
    }

    /// `regex.exec(text)` of a regex without the `g` flag, and `text.match(regex)`.
    pub fn exec<'t>(&self, text: &'t str) -> Option<JsMatch<'t>> {
        self.find_from(text, 0).next()
    }

    /// `text.matchAll(regex)`, and the `while ((m = regex.exec(text)))` loop.
    pub fn find_iter<'r, 't>(&'r self, text: &'t str) -> impl Iterator<Item = JsMatch<'t>> + 'r
    where
        't: 'r,
    {
        self.find_from(text, 0)
    }

    /// The `exec` loop after `regex.lastIndex = start`.
    pub fn find_from<'r, 't>(
        &'r self,
        text: &'t str,
        start: usize,
    ) -> impl Iterator<Item = JsMatch<'t>> + 'r
    where
        't: 'r,
    {
        self.regex
            .find_from(text, start)
            .map(move |found| JsMatch { text, found })
    }

    /// `text.replace(regex, () => replacement(m))` with the `g` flag.
    pub fn replace_all(
        &self,
        text: &str,
        mut replacement: impl FnMut(&JsMatch<'_>) -> String,
    ) -> String {
        let mut out = String::with_capacity(text.len());
        let mut copied = 0;
        for found in self.find_iter(text) {
            out.push_str(&text[copied..found.start()]);
            out.push_str(&replacement(&found));
            copied = found.end();
        }
        out.push_str(&text[copied..]);
        out
    }

    /// `text.split(regex)` for a regex without capture groups.
    pub fn split<'t>(&self, text: &'t str) -> Vec<&'t str> {
        if text.is_empty() {
            return if self.test(text) {
                Vec::new()
            } else {
                vec![text]
            };
        }
        let mut pieces = Vec::new();
        let mut piece_start = 0;
        for found in self.find_iter(text) {
            // an empty match at the start of a piece, and any match at the end
            // of the text, splits nothing
            if found.end() == piece_start || found.start() >= text.len() {
                continue;
            }
            pieces.push(&text[piece_start..found.start()]);
            piece_start = found.end();
        }
        pieces.push(&text[piece_start..]);
        pieces
    }
}

/// A regex literal: compiled once, on first use.
///
/// ```
/// let digits = jscompat::js_regex!(r"^\d+$");
/// assert!(digits.test("42"));
/// ```
#[macro_export]
macro_rules! js_regex {
    ($pattern:expr) => {
        $crate::js_regex!($pattern, "")
    };
    ($pattern:expr, $flags:expr) => {{
        static REGEX: ::std::sync::LazyLock<$crate::JsRegex> = ::std::sync::LazyLock::new(|| {
            $crate::JsRegex::new($pattern, $flags).expect("a pattern literal that compiles")
        });
        &*REGEX
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_follow_javascript_not_unicode() {
        // \d and \w are ASCII; \s is the WhiteSpace and LineTerminator set
        assert!(!js_regex!(r"^\d$").test("\u{0663}"));
        assert!(!js_regex!(r"^\w$").test("\u{00e9}"));
        assert!(js_regex!(r"^\s$").test("\u{feff}"));
        assert!(!js_regex!(r"^\s$").test("\u{0085}"));
    }

    #[test]
    fn a_group_that_took_no_part_is_absent() {
        let found = js_regex!(r"(a)|(b)").exec("b").unwrap();
        assert_eq!(found.get(0), Some("b"));
        assert_eq!(found.get(1), None);
        assert_eq!(found.get(2), Some("b"));
    }

    #[test]
    fn lookahead_and_backreference_match_as_in_javascript() {
        let quoted = js_regex!(r#"(["'])(.*?)\1(?=\s|$)"#);
        let found = quoted.exec(r#"x "a'b" 'c'"#).unwrap();
        assert_eq!(found.get(2), Some("a'b"));
        assert_eq!((found.start(), found.end()), (2, 7));
    }

    #[test]
    fn find_from_resumes_like_last_index() {
        let regex = js_regex!(r"a+");
        let text = "aa b aaa";
        let all: Vec<_> = regex.find_iter(text).map(|m| m.as_str()).collect();
        assert_eq!(all, ["aa", "aaa"]);
        let later: Vec<_> = regex.find_from(text, 1).map(|m| m.start()).collect();
        assert_eq!(later, [1, 5]);
    }

    #[test]
    fn replace_all_keeps_the_text_between_matches() {
        let regex = JsRegex::new("B", "i").unwrap();
        assert_eq!(
            regex.replace_all("abcB", |m| format!("<{}>", m.as_str())),
            "a<b>c<B>"
        );
    }

    #[test]
    fn a_pattern_javascript_rejects_is_an_error() {
        assert!(JsRegex::new("w:(", "").is_err());
        assert!(JsRegex::new("a{2,1}", "").is_err());
    }
}
