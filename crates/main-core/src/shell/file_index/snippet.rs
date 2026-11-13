//! `apps/shell/src/main/file-index/snippet.ts`: the excerpt shown under a
//! search hit. Offsets count UTF-16 code units, as in `text_marks`.

use jscompat::{js_regex, math_max, slice_utf16, trim};

use crate::shell::text_marks::{TextMark, find_ranges, find_text_ranges, fold_text, slice_units};

/// `SnippetPart`
pub type SnippetPart = TextMark;

const WINDOW: usize = 150;
const LEAD: usize = 40;

/// `text.replace(/\s+/g, ' ')`
fn collapse_white_space(text: &str) -> String {
    js_regex!(r"\s+", "g").replace_all(text, |_| " ".to_owned())
}

/// A ~150-char excerpt around the first matched needle with every needle
/// occurrence inside it flagged. Returns `None` when no needle occurs.
pub fn build_snippet<S: AsRef<str>>(text: &str, needles: &[S]) -> Option<Vec<SnippetPart>> {
    if needles.iter().all(|n| n.as_ref().is_empty()) || text.is_empty() {
        return None;
    }
    let compact = collapse_white_space(text);
    let ranges = find_text_ranges(&compact, needles);
    if ranges.is_empty() {
        return None;
    }
    let units: Vec<u16> = compact.encode_utf16().collect();
    let start = ranges[0].0.saturating_sub(LEAD);
    let end = units.len().min(start + WINDOW);
    let mut parts: Vec<SnippetPart> = Vec::new();
    let mut cursor = start;
    let part = |text: String, hit: bool| TextMark { text, hit };
    if start > 0 {
        parts.push(part("\u{2026}".to_owned(), false));
    }
    for &(s, e) in &ranges {
        if s >= end {
            break;
        }
        if s > cursor {
            parts.push(part(slice_units(&units, cursor, s), false));
        }
        let stop = e.min(end);
        parts.push(part(slice_units(&units, s.max(cursor), stop), true));
        cursor = stop;
    }
    if cursor < end {
        parts.push(part(slice_units(&units, cursor, end), false));
    }
    if end < units.len() {
        parts.push(part("\u{2026}".to_owned(), false));
    }
    Some(parts)
}

/// up to `chars` of text starting a little before the first needle hit, or the head of the text
pub fn excerpt<S: AsRef<str>>(text: &str, needles: &[S], chars: f64) -> String {
    let compact = collapse_white_space(text);
    let compact = trim(&compact);
    let ranges = find_text_ranges(compact, needles);
    let start = match ranges.first() {
        Some(first) => math_max(0.0, first.0 as f64 - (chars / 4.0).floor()),
        None => 0.0,
    };
    slice_utf16(compact, start, Some(start + chars))
}

/// true when any needle occurs in the (folded) text
pub fn contains_any<S: AsRef<str>>(text: &str, needles: &[S]) -> bool {
    let needles: Vec<String> = needles
        .iter()
        .map(|n| fold_text(n.as_ref()))
        .filter(|n| !n.is_empty())
        .collect();
    !find_ranges(&fold_text(text), &needles, None).is_empty()
}
