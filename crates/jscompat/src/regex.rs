//! JavaScript regular expressions, so a pattern is ported by copying it.
//!
//! The engine is `regress`, which implements the ECMAScript grammar and
//! matching rules (ASCII `\d` `\w` `\b`, JavaScript `\s`, lookaround,
//! backreferences). The result offsets are bytes.
//!
//! JavaScript without the `u` flag walks UTF-16 code units: a character
//! outside the BMP is two of them, to `.`, to a class, to a count (`.{2}`),
//! to `\B` and to a lookbehind. Where the text a search can reach holds such
//! a character, it is searched as its units ([`UnitMatches`]); any other
//! text has one unit per character and is searched as it is. A pattern that
//! cannot tell the two apart ([`walks_whole_characters`]) is never searched
//! as units. JavaScript can match one half of a pair, which a `&str` cannot
//! hold:
//!
//! - [`JsRegex::replace_all`] builds its answer from units, as JavaScript
//!   does. A half left alone in it is U+FFFD, which is what JavaScript writes
//!   for it as UTF-8.
//! - A match, a capture or a piece of [`JsRegex::split`] that begins or ends
//!   inside a pair moves that end to the end of the character: the character
//!   belongs to what holds its first half, and nothing of the text is lost or
//!   given twice.
//!
//! What a call costs beyond the search itself: nothing for a pattern that
//! walks whole characters and has no `i`; otherwise one pass over the bytes
//! from where the search starts (over the whole text for a pattern with a
//! lookbehind). A loop that calls [`JsRegex::find_from`] once per match of a
//! large text pays that pass every time; [`JsRegex::find_iter`] pays it once.
//! Where such a loop is needed, the fix is a handle that prepares the text
//! once (its units, its shadow) and is searched many times; none exists yet.
//!
//! Under `i` without `u` JavaScript maps each UTF-16 unit to upper case and
//! never gives a character outside ASCII an ASCII letter. `regress` folds as
//! Unicode does, so for three characters it does: U+0131 is `i`, U+017F is
//! `s`, and U+212A is `k` in a class and a word character. Every such
//! pattern searches the text with those three replaced ([`JsRegex::shadow`]).
//! What that cannot make right is a pattern that itself names a cased
//! character outside ASCII (`/\u0131/i` matches `I` in `regress`), so
//! [`JsRegex::new`] refuses to build one.

use std::fmt;

/// The most entries the backtrack stack of one search may hold.
///
/// A loop whose body is more than one character matcher keeps entries for
/// each turn until the match attempt ends; every other pattern keeps a number
/// set by the pattern. One entry is 40 bytes on a 64-bit target, so the bound
/// is 168 MB, and the counting allocator measured a peak of 209 MB while the
/// stack makes its last step to the bound (`tests/limit.rs`). On one unclosed tag read by
/// `<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>` (three entries per character) it
/// answers up to 1.39M characters and stops from 1.40M; V8 answers up to 8M
/// and throws a `RangeError` from 9M (Node 22.23.5). Between the two a search
/// refuses where the TypeScript answers: a listed difference, never a wrong
/// answer. Chosen for a browser tab and a wasm32 module whose memory does not
/// shrink.
pub const BACKTRACK_LIMIT: usize = 1 << 22;

/// A search stopped at [`BACKTRACK_LIMIT`], as V8 throws a `RangeError` when
/// its stack runs out: what the search would have answered is not known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RegexLimit;

impl fmt::Display for RegexLimit {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a regular expression needed more memory than one search may take")
    }
}

impl std::error::Error for RegexLimit {}

/// A regular expression whose searches cannot fail.
///
/// Its searches panic if one passes [`BACKTRACK_LIMIT`], and that cannot
/// happen: only a loop that is more than one character matcher and may turn
/// more than 4,096 times grows the stack with the text, and
/// `jscompat/tests/sites.rs` fails when a pattern with such a loop, or a
/// pattern it cannot read, is built as a `JsRegex`. Such a pattern is a
/// [`TryJsRegex`].
#[derive(Debug)]
pub struct JsRegex {
    regex: regress::Regex,
    /// `i` without `u`: the text is searched through [`JsRegex::shadow`].
    shadows: bool,
    /// No `u`, and the pattern can tell a pair from one character: a text
    /// outside the BMP is searched as its UTF-16 units.
    counts_units: bool,
    /// The pattern has a lookbehind: a search reads the text before its start.
    looks_behind: bool,
}

/// Whether any byte of `text` is one `wanted` accepts, eight bytes at a time:
/// `in_word` is whether a word of eight holds one.
fn any_byte(text: &str, in_word: impl Fn(u64) -> bool, wanted: impl Fn(u8) -> bool) -> bool {
    let (words, rest) = text.as_bytes().as_chunks::<8>();
    words.iter().any(|word| in_word(u64::from_le_bytes(*word)))
        || rest.iter().any(|byte| wanted(*byte))
}

/// The top bit of each byte of a word that is zero.
fn zero_bytes(word: u64) -> u64 {
    word.wrapping_sub(0x0101_0101_0101_0101) & !word & 0x8080_8080_8080_8080
}

/// A character outside the BMP is four bytes of UTF-8, and only it is: its
/// first byte is the only one with its four top bits set.
fn holds_a_pair(text: &str) -> bool {
    any_byte(
        text,
        |word| word & (word << 1) & (word << 2) & (word << 3) & 0x8080_8080_8080_8080 != 0,
        |byte| byte >= 0xf0,
    )
}

/// Whether the text may hold one of [`FOLDED_TO_ASCII`]: a first byte of
/// theirs, 0xC4, 0xC5 or 0xE2.
fn may_hold_a_folded(text: &str) -> bool {
    any_byte(
        text,
        |word| {
            zero_bytes((word & 0xfefe_fefe_fefe_fefe) ^ 0xc4c4_c4c4_c4c4_c4c4) != 0
                || zero_bytes(word ^ 0xe2e2_e2e2_e2e2_e2e2) != 0
        },
        |byte| matches!(byte, 0xc4 | 0xc5 | 0xe2),
    )
}

/// The part of a text a search reads, as a regex without `u` walks it.
struct Units {
    /// Its UTF-16 units.
    units: Vec<u16>,
    /// For each unit index a byte offset of the whole text: where its
    /// character begins, or for the second half of a pair where it ends; the
    /// length of the text after the last.
    bytes: Vec<usize>,
}

impl Units {
    /// `window` begins at byte `base` of the text.
    fn of(window: &str, base: usize) -> Self {
        let mut units = Vec::with_capacity(window.len());
        let mut bytes = Vec::with_capacity(window.len() + 1);
        for (at, c) in window.char_indices() {
            let mut pair = [0; 2];
            let encoded = c.encode_utf16(&mut pair);
            units.extend_from_slice(encoded);
            bytes.push(base + at);
            if encoded.len() == 2 {
                bytes.push(base + at + c.len_utf8());
            }
        }
        bytes.push(base + window.len());
        Self { units, bytes }
    }
}

/// The matches of a text searched as UTF-16 units, one at a time: each with
/// its range in units, and itself with byte ranges of the text.
struct UnitMatches<'r> {
    regex: &'r regress::Regex,
    text: Units,
    /// Where `lastIndex` stands, in units; `None` after the last match.
    next: Option<usize>,
    /// The last search stopped at [`BACKTRACK_LIMIT`].
    exceeded: bool,
}

impl Iterator for UnitMatches<'_> {
    type Item = (std::ops::Range<usize>, regress::Match);

    fn next(&mut self) -> Option<Self::Item> {
        let from = self.next.take()?;
        let mut matches = self.regex.find_from_ucs2(&self.text.units, from);
        let Some(mut found) = matches.next() else {
            self.exceeded = matches.limit_exceeded();
            return None;
        };
        let in_units = found.range.clone();
        // as `lastIndex` moves: past the match, one unit further after an empty one
        let after = in_units.end + usize::from(in_units.is_empty());
        self.next = (after <= self.text.units.len()).then_some(after);
        let bytes = &self.text.bytes;
        found.range = bytes[in_units.start]..bytes[in_units.end];
        for capture in found.captures.iter_mut().flatten() {
            *capture = bytes[capture.start]..bytes[capture.end];
        }
        Some((in_units, found))
    }
}

/// The matches of a shadow, one at a time, with byte ranges of the text.
struct ShadowMatches<'r> {
    regex: &'r regress::Regex,
    /// The shadow of the text from byte `base` on.
    shadow: String,
    base: usize,
    /// Where `lastIndex` stands, in bytes of the shadow; `None` after the last match.
    next: Option<usize>,
    /// The last search stopped at [`BACKTRACK_LIMIT`].
    exceeded: bool,
}

impl Iterator for ShadowMatches<'_> {
    type Item = regress::Match;

    fn next(&mut self) -> Option<Self::Item> {
        let from = self.next.take()?;
        let mut matches = self.regex.find_from(&self.shadow, from);
        let Some(mut found) = matches.next() else {
            self.exceeded = matches.limit_exceeded();
            return None;
        };
        let end = found.range.end;
        // as `lastIndex` moves: past the match, one character further after an empty one
        let after = match found.range.is_empty() {
            true => end + self.shadow[end..].chars().next().map_or(1, char::len_utf8),
            false => end,
        };
        self.next = (after <= self.shadow.len()).then_some(after);
        found.range = self.base + found.range.start..self.base + end;
        for capture in found.captures.iter_mut().flatten() {
            *capture = self.base + capture.start..self.base + capture.end;
        }
        Some(found)
    }
}

/// How a text is searched.
enum Search<'r, 't> {
    /// As it is.
    Plain(regress::Matches<'r, 't>),
    /// Through its shadow.
    Shadowed(ShadowMatches<'r>),
    /// As its UTF-16 units.
    InUnits(UnitMatches<'r>),
}

impl Search<'_, '_> {
    /// Whether the search ended at [`BACKTRACK_LIMIT`] rather than for want
    /// of matches.
    fn limit_exceeded(&self) -> bool {
        match self {
            Self::Plain(matches) => matches.limit_exceeded(),
            Self::Shadowed(matches) => matches.exceeded,
            Self::InUnits(matches) => matches.exceeded,
        }
    }
}

/// The matches of a search, then [`RegexLimit`] if it stopped at the bound.
pub struct JsMatches<'r, 't> {
    search: Search<'r, 't>,
    text: &'t str,
    done: bool,
}

impl<'t> Iterator for JsMatches<'_, 't> {
    type Item = Result<JsMatch<'t>, RegexLimit>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        match self.search.next() {
            Some(found) => Some(Ok(JsMatch {
                text: self.text,
                found,
            })),
            None => {
                self.done = true;
                self.search.limit_exceeded().then_some(Err(RegexLimit))
            }
        }
    }
}

/// A search of a [`JsRegex`] passed the bound, which `tests/sites.rs`
/// proves no `JsRegex` can.
fn unreachable_limit(limit: RegexLimit) -> ! {
    panic!("{limit}: a JsRegex holds a pattern that belongs in a TryJsRegex")
}

impl Iterator for Search<'_, '_> {
    type Item = regress::Match;

    fn next(&mut self) -> Option<Self::Item> {
        match self {
            Self::Plain(matches) => matches.next(),
            Self::Shadowed(matches) => matches.next(),
            Self::InUnits(matches) => matches.next().map(|(_, found)| found),
        }
    }
}

/// The pieces `split` cuts a text of `length` into, from its matches in order.
fn pieces_between(
    matches: impl Iterator<Item = std::ops::Range<usize>>,
    length: usize,
) -> Vec<std::ops::Range<usize>> {
    let mut pieces = Vec::new();
    let mut piece_start = 0;
    for found in matches {
        // an empty match at the start of a piece, and any match at the end
        // of the text, splits nothing
        if found.end == piece_start || found.start >= length {
            continue;
        }
        pieces.push(piece_start..found.start);
        piece_start = found.end;
    }
    pieces.push(piece_start..length);
    pieces
}

/// Whether no match of the pattern can tell a character outside the BMP from
/// its two units, so that the pattern is searched over characters whatever
/// the text holds. Read from the pattern text, and `false` wherever that
/// reading does not settle it:
///
/// - nothing in it matches half a pair: no `.`, no negated class, no `\S`,
///   `\W`, `\D`, no class or escape that reaches outside ASCII;
/// - nothing in it holds between the halves of a pair without consuming:
///   no `\B`, no lookbehind;
/// - every alternative begins by consuming a character it cannot do without,
///   so a match is never empty and never begins between the halves.
///
/// A match then begins and ends between characters, and what it tests of a
/// character outside the BMP (a word character, a line end, one of the
/// characters it names) is false of the character and of each half alike.
fn walks_whole_characters(pattern: &str) -> bool {
    let chars: Vec<char> = pattern.chars().collect();
    let mut at = 0;
    let mut depth = 0usize;
    // the alternative being read at depth 0 has consumed a character it cannot do without
    let mut begun = false;
    while at < chars.len() {
        // the atom here: its length, and whether it consumes one character
        let (length, consumes) = match chars[at] {
            '\\' => match chars.get(at + 1) {
                Some('d' | 'w' | 's' | 't' | 'n' | 'r' | 'f' | 'v') => (2, true),
                Some('b') => (2, false),
                Some(escaped) if escaped.is_ascii() && !escaped.is_ascii_alphanumeric() => {
                    (2, true)
                }
                _ => return false,
            },
            '[' => {
                let mut end = at + 1;
                if chars.get(end) == Some(&'^') {
                    return false;
                }
                loop {
                    match chars.get(end) {
                        Some(']') => break,
                        Some('\\') => match chars.get(end + 1) {
                            Some('d' | 'w' | 's' | 't' | 'n' | 'r' | 'f' | 'v' | 'b') => end += 2,
                            Some(escaped)
                                if escaped.is_ascii() && !escaped.is_ascii_alphanumeric() =>
                            {
                                end += 2
                            }
                            _ => return false,
                        },
                        Some(c) if c.is_ascii() => end += 1,
                        _ => return false,
                    }
                }
                (end + 1 - at, true)
            }
            '(' => {
                if (depth == 0 && !begun)
                    || chars[at + 1..].starts_with(&['?', '<', '='])
                    || chars[at + 1..].starts_with(&['?', '<', '!'])
                {
                    return false;
                }
                depth += 1;
                (1, false)
            }
            ')' => {
                depth = depth.saturating_sub(1);
                (1, false)
            }
            '|' => {
                if depth == 0 {
                    if !begun {
                        return false;
                    }
                    begun = false;
                }
                (1, false)
            }
            '.' => return false,
            '^' | '$' | '*' | '+' | '?' => (1, false),
            // a count is read with the atom it follows; anywhere else it settles nothing
            '{' | '}' if !begun => return false,
            c if u32::from(c) > 0xffff => return false,
            _ => (1, true),
        };
        at += length;
        if !consumes {
            continue;
        }
        // whether the quantifier that follows lets the atom match nothing
        let optional = match chars.get(at) {
            Some('?' | '*') => true,
            Some('{') => {
                let digits = chars[at + 1..]
                    .iter()
                    .take_while(|c| c.is_ascii_digit())
                    .count();
                let closed = match chars.get(at + 1 + digits) {
                    Some('}') => Some(at + 1 + digits),
                    Some(',') => {
                        let more = chars[at + 2 + digits..]
                            .iter()
                            .take_while(|c| c.is_ascii_digit())
                            .count();
                        (chars.get(at + 2 + digits + more) == Some(&'}'))
                            .then_some(at + 2 + digits + more)
                    }
                    _ => None,
                };
                let Some(closed) = closed.filter(|_| digits > 0) else {
                    return false;
                };
                let least = &chars[at + 1..at + 1 + digits];
                at = closed + 1;
                least.iter().all(|digit| *digit == '0')
            }
            _ => false,
        };
        if depth == 0 && !optional {
            begun = true;
        }
    }
    begun
}

/// The characters `regress` matches as ASCII letters under `i` without `u`.
const FOLDED_TO_ASCII: [char; 3] = ['\u{131}', '\u{17f}', '\u{212a}'];
/// Characters as long in UTF-8 as U+0131 and U+017F, with no case, that are
/// neither spaces nor line ends nor in Latin-1, which an octal escape names.
const TWO_BYTE_STAND_INS: [char; 4] = ['\u{2c7}', '\u{2d8}', '\u{2d9}', '\u{2da}'];
/// The same for U+212A.
const THREE_BYTE_STAND_INS: [char; 2] = ['\u{2192}', '\u{2190}'];

/// `c` is one of a pair of cases, in any direction.
fn has_case(c: char) -> bool {
    !c.to_uppercase().eq([c]) || !c.to_lowercase().eq([c])
}

/// Whether `regress` under `i` without `u` matches the characters this
/// pattern names as JavaScript does, once the text is shadowed: every one is
/// ASCII, or has no case and stands outside a class. A class or an escape
/// that can reach outside ASCII (`\u`, `\p`, `\x80` and `\200` and above) is
/// not followed further.
fn icase_without_unicode_is_exact(pattern: &str) -> bool {
    let mut chars = pattern.chars();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        let named = match c {
            '\\' => match chars.next() {
                Some('u' | 'p' | 'P') => return false,
                Some('x')
                    if chars.clone().next().is_some_and(
                        |digit| matches!(digit, '8' | '9' | 'a'..='f' | 'A'..='F'),
                    ) =>
                {
                    return false;
                }
                Some('2' | '3')
                    if chars
                        .clone()
                        .take(2)
                        .filter(|digit| ('0'..='7').contains(digit))
                        .count()
                        == 2 =>
                {
                    return false;
                }
                Some(escaped) => escaped,
                None => return true,
            },
            '[' => {
                in_class = true;
                continue;
            }
            ']' => {
                in_class = false;
                continue;
            }
            c => c,
        };
        if !named.is_ascii()
            && (in_class
                || has_case(named)
                || TWO_BYTE_STAND_INS.contains(&named)
                || THREE_BYTE_STAND_INS.contains(&named))
        {
            return false;
        }
    }
    true
}

/// Whether a pattern without `u` names a character outside the BMP: itself,
/// or as the escapes of its two halves one after the other. JavaScript reads
/// that as two units, each its own atom (`/[\u{1F600}]/` is a class of two
/// halves); `regress` reads one character, which no unit of a text is.
fn names_a_pair(pattern: &str) -> bool {
    let half = |text: &str, first_digits: &[char]| {
        let mut chars = text.chars();
        chars.next() == Some('\\')
            && chars.next() == Some('u')
            && chars.next().is_some_and(|c| matches!(c, 'd' | 'D'))
            && chars
                .next()
                .is_some_and(|c| first_digits.contains(&c.to_ascii_lowercase()))
            && chars.next().is_some_and(|c| c.is_ascii_hexdigit())
            && chars.next().is_some_and(|c| c.is_ascii_hexdigit())
    };
    let mut rest = pattern;
    while let Some(c) = rest.chars().next() {
        if u32::from(c) > 0xffff {
            return true;
        }
        if c != '\\' {
            rest = &rest[c.len_utf8()..];
        } else if half(rest, &['8', '9', 'a', 'b']) && half(&rest[6..], &['c', 'd', 'e', 'f']) {
            return true;
        } else {
            // the escaped character is not read again as the start of an escape
            rest = &rest[1..];
            rest = &rest[rest.chars().next().map_or(0, char::len_utf8)..];
        }
    }
    false
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

/// What `new RegExp(pattern).exec(text)` throws for a pattern built at run
/// time: a `SyntaxError` from the constructor, or the search stopped at the
/// bound where V8 throws a `RangeError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegexError {
    Syntax(RegexSyntaxError),
    Limit(RegexLimit),
}

impl fmt::Display for RegexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RegexError::Syntax(error) => error.fmt(f),
            RegexError::Limit(limit) => limit.fmt(f),
        }
    }
}

impl std::error::Error for RegexError {}

impl From<RegexSyntaxError> for RegexError {
    fn from(error: RegexSyntaxError) -> Self {
        RegexError::Syntax(error)
    }
}

impl From<RegexLimit> for RegexError {
    fn from(limit: RegexLimit) -> Self {
        RegexError::Limit(limit)
    }
}

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

    /// `m.indices[index]` of a regex with the `d` flag, as byte offsets;
    /// `None` where JavaScript has `undefined`.
    pub fn range(&self, index: usize) -> Option<std::ops::Range<usize>> {
        self.found.group(index)
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
    ///
    /// A pattern JavaScript builds is refused in two cases, where `regress`
    /// would answer otherwise than JavaScript. Under `i` without `u` it names
    /// a cased character outside ASCII, or holds a class or an escape that
    /// can reach one: `regress` would match it as Unicode folds. Without `u`
    /// it names a character outside the BMP: `regress` would read one
    /// character where JavaScript reads two units.
    pub fn new(pattern: &str, flags: &str) -> Result<Self, RegexSyntaxError> {
        let without_u = !flags.contains(['u', 'v']);
        let shadows = flags.contains('i') && without_u;
        if shadows && !icase_without_unicode_is_exact(pattern) {
            return Err(RegexSyntaxError(format!(
                "/{pattern}/{flags}: a cased character outside ASCII under `i` without `u` is not matched as JavaScript matches it"
            )));
        }
        if without_u && names_a_pair(pattern) {
            return Err(RegexSyntaxError(format!(
                "/{pattern}/{flags}: a character outside the BMP in a pattern without `u` is not matched as JavaScript matches it"
            )));
        }
        regress::Regex::with_flags(pattern, flags)
            .map(|mut regex| {
                regex.set_backtrack_limit(Some(BACKTRACK_LIMIT));
                regex
            })
            .map(|regex| Self {
                regex,
                shadows,
                counts_units: without_u && !walks_whole_characters(pattern),
                looks_behind: pattern.contains("(?<=") || pattern.contains("(?<!"),
            })
            .map_err(|error| RegexSyntaxError(error.to_string()))
    }

    /// The text the engine searches in place of `text`, byte for byte as
    /// long: each character of [`FOLDED_TO_ASCII`] replaced by one the text
    /// does not hold, a different one each, so a backreference still tells
    /// them apart. `None` where the text holds none of the three.
    fn shadow(&self, text: &str) -> Option<String> {
        if !self.shadows || !may_hold_a_folded(text) || !text.contains(FOLDED_TO_ASCII) {
            return None;
        }
        let mut two_byte = TWO_BYTE_STAND_INS
            .into_iter()
            .filter(|stand_in| !text.contains(*stand_in));
        let three_byte = THREE_BYTE_STAND_INS
            .into_iter()
            .find(|stand_in| !text.contains(*stand_in));
        let stand_ins = [
            two_byte.next().unwrap_or(TWO_BYTE_STAND_INS[0]),
            two_byte.next().unwrap_or(TWO_BYTE_STAND_INS[1]),
            three_byte.unwrap_or(THREE_BYTE_STAND_INS[0]),
        ];
        Some(
            text.chars()
                .map(|c| {
                    FOLDED_TO_ASCII
                        .iter()
                        .position(|folded| *folded == c)
                        .map_or(c, |at| stand_ins[at])
                })
                .collect(),
        )
    }

    /// The search from byte `start`, as JavaScript makes it. Without a
    /// lookbehind a search reads nothing before `start` but the character
    /// just before it, for `\b` and for `^` under `m`: only the text from
    /// that character on is looked at, shadowed and turned into units.
    fn search<'r, 't>(&'r self, text: &'t str, start: usize) -> Search<'r, 't> {
        let start = start.min(text.len());
        let base = match self.looks_behind {
            true => 0,
            false => text[..start]
                .char_indices()
                .next_back()
                .map_or(0, |(at, _)| at),
        };
        // the character before `start` is no pair to anything read of it
        let reached = if self.looks_behind {
            text
        } else {
            &text[start..]
        };
        let in_units = self.counts_units && holds_a_pair(reached);
        match self.shadow(&text[base..]) {
            None if !in_units => Search::Plain(self.regex.find_from(text, start)),
            Some(shadow) if !in_units => Search::Shadowed(ShadowMatches {
                regex: &self.regex,
                shadow,
                base,
                next: Some(start - base),
                exceeded: false,
            }),
            shadow => Search::InUnits(UnitMatches {
                regex: &self.regex,
                text: Units::of(shadow.as_deref().unwrap_or(&text[base..]), base),
                next: Some(text[base..start].encode_utf16().count()),
                exceeded: false,
            }),
        }
    }

    /// Whether a search reads the text from its start on before it searches:
    /// the regex is under `i` without `u`, or its pattern can tell a
    /// character outside the BMP from its two units. A loop that calls
    /// [`JsRegex::find_from`] once per match with such a regex reads the rest
    /// of the text every time; `jscompat/tests/sites.rs` lists the calls
    /// that do.
    pub fn reads_ahead(&self) -> bool {
        self.shadows || self.counts_units
    }

    /// The matches from byte `start`, then [`RegexLimit`] if the search
    /// stopped at the bound.
    fn matches<'r, 't>(&'r self, text: &'t str, start: usize) -> JsMatches<'r, 't> {
        JsMatches {
            search: self.search(text, start),
            text,
            done: false,
        }
    }

    fn checked_test(&self, text: &str) -> Result<bool, RegexLimit> {
        self.matches(text, 0)
            .next()
            .transpose()
            .map(|found| found.is_some())
    }

    fn checked_replace_all(
        &self,
        text: &str,
        mut replacement: impl FnMut(&JsMatch<'_>) -> String,
    ) -> Result<String, RegexLimit> {
        let mut matches = match self.search(text, 0) {
            Search::InUnits(mut matches) => {
                let units: Vec<u16> = text.encode_utf16().collect();
                let mut out = Vec::with_capacity(units.len());
                let mut copied = 0;
                for (in_units, found) in matches.by_ref() {
                    out.extend_from_slice(&units[copied..in_units.start]);
                    out.extend(replacement(&JsMatch { text, found }).encode_utf16());
                    copied = in_units.end;
                }
                if matches.exceeded {
                    return Err(RegexLimit);
                }
                out.extend_from_slice(&units[copied..]);
                return Ok(String::from_utf16_lossy(&out));
            }
            matches => matches,
        };
        let mut out = String::with_capacity(text.len());
        let mut copied = 0;
        for found in matches.by_ref() {
            let found = JsMatch { text, found };
            out.push_str(&text[copied..found.start()]);
            out.push_str(&replacement(&found));
            copied = found.end();
        }
        if matches.limit_exceeded() {
            return Err(RegexLimit);
        }
        out.push_str(&text[copied..]);
        Ok(out)
    }

    fn checked_split<'t>(&self, text: &'t str) -> Result<Vec<&'t str>, RegexLimit> {
        if text.is_empty() {
            return Ok(if self.checked_test(text)? {
                Vec::new()
            } else {
                vec![text]
            });
        }
        let mut matches = match self.search(text, 0) {
            Search::InUnits(mut matches) => {
                let in_units: Vec<_> = matches.by_ref().map(|(in_units, _)| in_units).collect();
                if matches.exceeded {
                    return Err(RegexLimit);
                }
                let bytes = &matches.text.bytes;
                return Ok(
                    pieces_between(in_units.into_iter(), matches.text.units.len())
                        .into_iter()
                        .map(|piece| &text[bytes[piece.start]..bytes[piece.end]])
                        .collect(),
                );
            }
            matches => matches,
        };
        let found: Vec<_> = matches.by_ref().map(|found| found.range()).collect();
        if matches.limit_exceeded() {
            return Err(RegexLimit);
        }
        Ok(pieces_between(found.into_iter(), text.len())
            .into_iter()
            .map(|piece| &text[piece])
            .collect())
    }

    /// `regex.test(text)`
    pub fn test(&self, text: &str) -> bool {
        self.checked_test(text)
            .unwrap_or_else(|limit| unreachable_limit(limit))
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
        self.matches(text, start)
            .map(|found| found.unwrap_or_else(|limit| unreachable_limit(limit)))
    }

    /// `text.replace(regex, () => replacement(m))` with the `g` flag.
    pub fn replace_all(
        &self,
        text: &str,
        replacement: impl FnMut(&JsMatch<'_>) -> String,
    ) -> String {
        self.checked_replace_all(text, replacement)
            .unwrap_or_else(|limit| unreachable_limit(limit))
    }

    /// `text.split(regex)` for a regex without capture groups.
    pub fn split<'t>(&self, text: &'t str) -> Vec<&'t str> {
        self.checked_split(text)
            .unwrap_or_else(|limit| unreachable_limit(limit))
    }
}

/// A regular expression whose searches can stop at [`BACKTRACK_LIMIT`], for a
/// pattern with a loop that grows the stack with the text. Each search answers
/// [`RegexLimit`] where it stopped; the caller refuses what it reads with a
/// reason, as the TypeScript throws, and never takes the stop for "no match".
#[derive(Debug)]
pub struct TryJsRegex(JsRegex);

impl TryJsRegex {
    /// `new RegExp(pattern, flags)`, refused where [`JsRegex::new`] refuses.
    pub fn new(pattern: &str, flags: &str) -> Result<Self, RegexSyntaxError> {
        JsRegex::new(pattern, flags).map(Self)
    }

    /// `regex.test(text)`
    pub fn try_test(&self, text: &str) -> Result<bool, RegexLimit> {
        self.0.checked_test(text)
    }

    /// `regex.exec(text)` of a regex without the `g` flag.
    pub fn try_exec<'t>(&self, text: &'t str) -> Result<Option<JsMatch<'t>>, RegexLimit> {
        self.0.matches(text, 0).next().transpose()
    }

    /// `text.matchAll(regex)`: the matches, then [`RegexLimit`] if the search stopped.
    pub fn try_find_iter<'r, 't>(&'r self, text: &'t str) -> JsMatches<'r, 't> {
        self.0.matches(text, 0)
    }

    /// The `exec` loop after `regex.lastIndex = start`.
    pub fn try_find_from<'r, 't>(&'r self, text: &'t str, start: usize) -> JsMatches<'r, 't> {
        self.0.matches(text, start)
    }

    /// `text.replace(regex, () => replacement(m))` with the `g` flag.
    pub fn try_replace_all(
        &self,
        text: &str,
        replacement: impl FnMut(&JsMatch<'_>) -> String,
    ) -> Result<String, RegexLimit> {
        self.0.checked_replace_all(text, replacement)
    }

    /// `text.split(regex)` for a regex without capture groups.
    pub fn try_split<'t>(&self, text: &'t str) -> Result<Vec<&'t str>, RegexLimit> {
        self.0.checked_split(text)
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

/// A regex literal whose searches can stop at [`BACKTRACK_LIMIT`]: see [`TryJsRegex`].
#[macro_export]
macro_rules! try_js_regex {
    ($pattern:expr) => {
        $crate::try_js_regex!($pattern, "")
    };
    ($pattern:expr, $flags:expr) => {{
        static REGEX: ::std::sync::LazyLock<$crate::TryJsRegex> =
            ::std::sync::LazyLock::new(|| {
                $crate::TryJsRegex::new($pattern, $flags).expect("a pattern literal that compiles")
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
    fn a_pattern_that_walks_whole_characters_is_told_from_its_text() {
        for pattern in [
            "a",
            r"<w:drawing[\s>]",
            r"<\/?w:tbl(?=[\s/>])",
            r"<w:pPr(?=[\s/>])|<\/w:pPr>",
            r"^\d+$",
            r"\bdata-redaction\b",
            r"a?b",
            r"a{2,3}(?:b|c)*",
            r"[a-z]{1,3}[0-9]+",
            r"<\/span\b",
            "\u{d55c}+",
        ] {
            assert!(walks_whole_characters(pattern), "{pattern}");
        }
        for pattern in [
            "",
            ".",
            "a.",
            r"<w:t[^>]*>",
            r"a\S",
            r"a\W",
            r"a\D",
            r"a\B",
            r"(?<=a)b",
            r"(?<!a)b",
            r"a*",
            r"a?",
            r"a{0}",
            r"a{0,2}",
            r"a|",
            r"|a",
            r"(a)",
            r"(?:a)+b",
            r"(?=a)",
            r"\b",
            r"^",
            r"a\1",
            r"a[\u0080-\uffff]",
            r"a\uD83D",
            r"a\x41",
            "a[\u{d55c}]",
            r"a{2",
            r"a|b*",
            r"[\s\S]",
            r"a[\S]",
        ] {
            assert!(!walks_whole_characters(pattern), "{pattern}");
        }
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
