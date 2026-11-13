//! `packages/agent-core/src/redact-core.ts`: withholding, the rules every
//! editor shares. A span the reader keeps from the model is a `{{label}}`
//! marker to it; this file builds, reads and checks those markers and
//! assembles the prompt section about them.
//!
//! Every function is pure. Lengths and cuts count UTF-16 code units, as the
//! TypeScript does.

use jscompat::{JsMap, js_regex, slice_utf16, trim};

use crate::packages::ai_provider::jsval::length16;

/// The form the model sees.
const OPEN: &str = "{{";
const CLOSE: &str = "}}";

/// Long enough to name what a span stands for, short enough to stay readable.
pub const MAX_LABEL_LENGTH: usize = 40;

/// `sanitizeLabel(raw, options)`: clean a label for storage and for the model
/// prompt. `for_comment` is `options.forComment`: also strip the characters
/// an XML comment cannot carry.
pub fn sanitize_label(raw: &str, for_comment: bool) -> String {
    let label_strip = js_regex!(r#"[{}<>="']"#, "g");
    let label_strip_comment = js_regex!(r#"[{}<>="'*/]"#, "g");
    let stripped = if for_comment {
        label_strip_comment.replace_all(raw, |_| String::new())
    } else {
        label_strip.replace_all(raw, |_| String::new())
    };
    let spaced = js_regex!(r"\s+", "g").replace_all(&stripped, |_| " ".to_owned());
    let cut = cut_label(trim(&spaced), MAX_LABEL_LENGTH);
    trim(&cut).to_owned()
}

/// `cutLabel(text, max)`: `slice(0, max)` without leaving half of a surrogate
/// pair at the end.
fn cut_label(text: &str, max: usize) -> String {
    if length16(text) <= max {
        return text.to_owned();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut end = max;
    let last = units[end - 1];
    if (0xd800..=0xdbff).contains(&last) {
        end -= 1;
    }
    String::from_utf16_lossy(&units[..end])
}

/// `placeholderSource(label)`: what the model reads in place of the withheld
/// words.
pub fn placeholder_source(label: &str) -> String {
    let clean = sanitize_label(label, false);
    let shown = if clean.is_empty() { "private" } else { &clean };
    format!("{OPEN}{shown}{CLOSE}")
}

/// `isWholePlaceholder(text)`: true when the text is nothing but one whole
/// marker.
pub fn is_whole_placeholder(text: &str) -> bool {
    let t = trim(text);
    t.starts_with(OPEN) && t.ends_with(CLOSE) && length16(t) > length16(OPEN) + length16(CLOSE)
}

/// `readPlaceholderLabel(text)`: the label a whole marker stands for, or
/// `None` (`null`) when the text is not one.
pub fn read_placeholder_label(text: &str) -> Option<String> {
    let t = trim(text);
    if !is_whole_placeholder(t) {
        return None;
    }
    let label = sanitize_label(
        &slice_utf16(
            t,
            length16(OPEN) as f64,
            Some((length16(t) - length16(CLOSE)) as f64),
        ),
        false,
    );
    if label.is_empty() { None } else { Some(label) }
}

/// `collectPlaceholders(text)`: every whole marker in the text, in order.
pub fn collect_placeholders(text: &str) -> Vec<String> {
    js_regex!(r"\{\{[^{}]*\}\}", "g")
        .find_iter(text)
        .map(|m| m.as_str().to_owned())
        .collect()
}

/// `PlaceholderIssue['reason']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaceholderReason {
    Missing,
    Unknown,
    Split,
}

impl PlaceholderReason {
    /// the word the TypeScript writes
    pub fn as_str(self) -> &'static str {
        match self {
            PlaceholderReason::Missing => "missing",
            PlaceholderReason::Unknown => "unknown",
            PlaceholderReason::Split => "split",
        }
    }
}

/// `PlaceholderIssue`, its fields in the order the TypeScript builds them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaceholderIssue {
    /// what the model's answer actually contains at that spot; "" when absent
    pub found: String,
    /// the marker the model was given, "" when it invented one
    pub expected: String,
    pub reason: PlaceholderReason,
}

/// `leftoverBraces(text)`: braces a malformed marker left behind, with
/// well-formed markers masked out first.
fn leftover_braces(text: &str) -> Vec<String> {
    let masked =
        js_regex!(r"\{\{[^{}]*\}\}", "g").replace_all(text, |m| " ".repeat(length16(m.as_str())));
    let mut out: Vec<String> = Vec::new();
    for m in js_regex!(r"\{\{|\}\}", "g").find_iter(&masked) {
        out.push(m.as_str().to_owned());
    }
    for m in js_regex!(r"(?<!\{)\{[^{}]*\}(?!\})", "g").find_iter(&masked) {
        out.push(m.as_str().to_owned());
    }
    out
}

/// `checkPlaceholders(before, after)`: compare the markers in a model's answer
/// against the ones it was given.
pub fn check_placeholders(before: &str, after: &str) -> Vec<PlaceholderIssue> {
    let mut issues: Vec<PlaceholderIssue> = Vec::new();
    for stray in leftover_braces(after) {
        issues.push(PlaceholderIssue {
            found: stray,
            expected: String::new(),
            reason: PlaceholderReason::Split,
        });
    }

    let mut got_counts: JsMap<usize> = JsMap::new();
    for m in collect_placeholders(after) {
        let next = got_counts.get(&m).copied().unwrap_or(0) + 1;
        got_counts.set(m, next);
    }
    let mut want_counts: JsMap<usize> = JsMap::new();
    for m in collect_placeholders(before) {
        let next = want_counts.get(&m).copied().unwrap_or(0) + 1;
        want_counts.set(m, next);
    }

    for (marker, want) in want_counts.iter() {
        let have = got_counts.get(marker).copied().unwrap_or(0);
        if have < *want {
            issues.push(PlaceholderIssue {
                found: if have != 0 {
                    marker.to_owned()
                } else {
                    String::new()
                },
                expected: marker.to_owned(),
                reason: PlaceholderReason::Missing,
            });
        }
    }
    for (marker, have) in got_counts.iter() {
        if !want_counts.has(marker) {
            issues.push(PlaceholderIssue {
                found: marker.to_owned(),
                expected: String::new(),
                reason: PlaceholderReason::Unknown,
            });
            continue;
        }
        if *have > want_counts.get(marker).copied().unwrap_or(0) {
            issues.push(PlaceholderIssue {
                found: marker.to_owned(),
                expected: marker.to_owned(),
                reason: PlaceholderReason::Unknown,
            });
        }
    }
    issues
}

/// `PlaceholderSpec`: what the reader's document is called in this editor,
/// and what differs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlaceholderSpec {
    /// "document", "workbook", "presentation", "page"
    pub subject: String,
    /// what a placeholder stands in for, after "This {subject} contains {{...}}"
    pub opening: String,
    /// what a marker may not be split across: "a line break", "a cell boundary"
    pub boundary: String,
    /// the editor's own consequences, in order
    pub middle: Vec<String>,
}

/// `placeholderInstruction(labels, spec)`: the prompt section every editor
/// sends, assembled from the shared rules and the editor's own spec.
pub fn placeholder_instruction(labels: &[String], spec: &PlaceholderSpec) -> String {
    let mut distinct: Vec<&String> = Vec::new();
    for label in labels {
        if !distinct.contains(&label) {
            distinct.push(label);
        }
    }
    let list = distinct
        .iter()
        .map(|l| format!("- {}", placeholder_source(l)))
        .collect::<Vec<_>>()
        .join("\n");
    let mut lines: Vec<String> = vec![
        "## Private placeholders".to_owned(),
        format!(
            "This {} contains {{{{...}}}} placeholders. {}",
            spec.subject, spec.opening
        ),
        String::new(),
        "Treat every placeholder as one indivisible object:".to_owned(),
        "- Copy it character for character \u{2014} same letters, same order, same spacing."
            .to_owned(),
        format!(
            "- Never split it across {} or put a space inside it.",
            spec.boundary
        ),
        "- Never merge two into one, never split one into several, never reorder them.".to_owned(),
        "- Never rename, translate, re-case, expand or shorten it.".to_owned(),
        "- Never drop one, and never add a placeholder that was not already there.".to_owned(),
        String::new(),
    ];
    lines.extend(spec.middle.iter().cloned());
    lines.push(String::new());
    lines.push(format!("The placeholders in this {}:", spec.subject));
    lines.push(list);
    lines.join("\n")
}
