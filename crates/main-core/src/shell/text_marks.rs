//! `apps/shell/src/shared/text-marks.ts`: where the search words sit in a text,
//! and the text cut into hit and non-hit runs.
//!
//! Every offset is a UTF-16 code unit offset, as the TypeScript's `indexOf`,
//! `length` and `slice` count; a Rust string is walked as its units where an
//! offset is read or made. `Intl.Segmenter` (graphemes) is the extended
//! grapheme cluster rule of `unicode-segmentation`. A slice that would cut a
//! surrogate pair in half gives U+FFFD where JavaScript keeps the lone half,
//! which a Rust string cannot hold.

use std::collections::HashSet;

use jscompat::{JsRegex, js_regex};
use serde::Serialize;
use unicode_segmentation::UnicodeSegmentation;

/// `TextMark`: a run of the text and whether it is a hit.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TextMark {
    pub text: String,
    pub hit: bool,
}

/// `[start, end)` in UTF-16 code units.
pub type Range = (usize, usize);

/// `WORD_CHAR`
fn word_char_re() -> &'static JsRegex {
    js_regex!(r"^[\p{L}\p{N}\p{M}]$", "u")
}

/// `CJK_START`
fn cjk_start_re() -> &'static JsRegex {
    js_regex!(
        r"^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]",
        "u"
    )
}

/// `WORD_CHAR.test(String.fromCodePoint(cp))`: a letter, a number or a mark.
pub(crate) fn is_word_char(c: char) -> bool {
    if c.is_ascii() {
        return c.is_ascii_alphanumeric();
    }
    let mut buffer = [0u8; 4];
    word_char_re().test(c.encode_utf8(&mut buffer))
}

/// `WORD_CHAR.test(hay[at])`: one code unit, so half of a pair is no word
/// character, whatever the character is.
fn is_word_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_word_char)
}

/// NFKC folds fullwidth forms and compatibility ideographs onto their base; same fold as the index
pub fn fold_text(text: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfkc()
        .normalize(text)
        .to_lowercase()
}

/// `text.slice(from, to)` over code units already counted.
pub(crate) fn slice_units(units: &[u16], from: usize, to: usize) -> String {
    let to = to.min(units.len());
    if from >= to {
        return String::new();
    }
    String::from_utf16_lossy(&units[from..to])
}

/// `hay.indexOf(needle, from)` over code units.
fn index_of_units(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if from > hay.len() {
        return None;
    }
    hay[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|at| at + from)
}

fn find_ranges_in<S: AsRef<str>>(
    hay: &[u16],
    needles: &[S],
    allow_mid_word: Option<&dyn Fn(usize) -> bool>,
) -> Vec<Range> {
    let mut ranges: Vec<Range> = Vec::new();
    for n in needles {
        let n = n.as_ref();
        let Some(first) = n.chars().next() else {
            continue;
        };
        let word_start = !cjk_start_re().test(n) && is_word_char(first);
        let needle: Vec<u16> = n.encode_utf16().collect();
        let mut at = index_of_units(hay, &needle, 0);
        while let Some(pos) = at {
            if !word_start
                || pos == 0
                || !is_word_unit(hay[pos - 1])
                || allow_mid_word.is_some_and(|allowed| allowed(pos))
            {
                ranges.push((pos, pos + needle.len()));
            }
            at = index_of_units(hay, &needle, pos + 1);
        }
    }
    merge_ranges(ranges)
}

/// Merged [start, end) spans of every needle in `hay`. A Latin/digit needle
/// must begin at a word start (the index only matches whole words and their
/// prefixes, so "is" inside "minneapolis" is not a hit); a CJK needle may sit
/// anywhere. `allow_mid_word` permits matches inside a compatibility character.
/// Overlapping spans fuse so adjacent bigram hits read as one run.
pub fn find_ranges<S: AsRef<str>>(
    hay: &str,
    needles: &[S],
    allow_mid_word: Option<&dyn Fn(usize) -> bool>,
) -> Vec<Range> {
    let units: Vec<u16> = hay.encode_utf16().collect();
    find_ranges_in(&units, needles, allow_mid_word)
}

fn merge_ranges(mut ranges: Vec<Range>) -> Vec<Range> {
    ranges.sort_by(|a, b| a.0.cmp(&b.0));
    let mut merged: Vec<Range> = Vec::new();
    for r in ranges {
        match merged.last_mut() {
            Some(last) if r.0 <= last.1 => last.1 = last.1.max(r.1),
            _ => merged.push(r),
        }
    }
    merged
}

/// Match in folded text, then map each hit back to whole graphemes in the original text.
pub fn find_text_ranges<S: AsRef<str>>(text: &str, needles: &[S]) -> Vec<Range> {
    let folded: Vec<u16> = fold_text(text).encode_utf16().collect();
    let folded_needles: Vec<String> = needles.iter().map(|n| fold_text(n.as_ref())).collect();
    // `/^[ -~]*$/.test(text)`
    if text.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return find_ranges_in(&folded, &folded_needles, None);
    }

    let mut starts: Vec<usize> = Vec::new();
    let mut ends: Vec<usize> = Vec::new();
    let mut changed_length: HashSet<usize> = HashSet::new();
    let mut index = 0usize;
    for segment in text.graphemes(true) {
        let segment_length = segment.encode_utf16().count();
        let length = fold_text(segment).encode_utf16().count();
        for _ in 0..length {
            if length != segment_length {
                changed_length.insert(starts.len());
            }
            starts.push(index);
            ends.push(index + segment_length);
        }
        index += segment_length;
    }
    if starts.len() != folded.len() {
        return Vec::new();
    }
    let allowed = |at: usize| changed_length.contains(&at);
    let ranges = find_ranges_in(
        &folded,
        &folded_needles,
        Some(&allowed as &dyn Fn(usize) -> bool),
    );
    merge_ranges(
        ranges
            .into_iter()
            .map(|(s, e)| (starts[s], ends[e - 1]))
            .collect(),
    )
}

/// the whole text split into hit / non-hit runs; a single non-hit run when nothing matches
pub fn mark_text<S: AsRef<str>>(text: &str, needles: &[S]) -> Vec<TextMark> {
    let ranges = find_text_ranges(text, needles);
    if ranges.is_empty() {
        return vec![TextMark {
            text: text.to_owned(),
            hit: false,
        }];
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut out: Vec<TextMark> = Vec::new();
    let mut cursor = 0usize;
    for (s, e) in ranges {
        if s > cursor {
            out.push(TextMark {
                text: slice_units(&units, cursor, s),
                hit: false,
            });
        }
        out.push(TextMark {
            text: slice_units(&units, s, e),
            hit: true,
        });
        cursor = e;
    }
    if cursor < units.len() {
        out.push(TextMark {
            text: slice_units(&units, cursor, units.len()),
            hit: false,
        });
    }
    out
}
