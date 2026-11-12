//! The read side of packages/docx-engine/src/notes.ts (word/footnotes.xml,
//! word/endnotes.xml): `parseNotesXml`, `nextNoteId`, `rootAttributes`.
//!
//! Entries carrying a w:type attribute (separator, continuationSeparator, ...)
//! are structural; only typeless entries are real notes.

use jscompat::{
    Radix, RegexError, TryJsRegex, js_regex, number_to_string, parse_int, trim, trim_start, truthy,
};
use serde::{Deserialize, Serialize};

use crate::vml::math_max;
use crate::xml_text::decode_entities;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoteKind {
    Footnote,
    Endnote,
}

/// One footnote or endnote, as `parseNotesXml` reads it without a paragraph
/// reader: the fields a reader adds (`richParas`, `spacing`) are absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteInfo {
    /// original w:id, unique within its part
    pub id: String,
    /// plain text, paragraphs joined with \n
    #[serde(default)]
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zotero_field: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_ref_mark: Option<bool>,
}

/// Root attributes for a regenerated part: the original root's when they
/// declare namespaces, else `fallback`, plus every `required` prefix the base
/// does not bind. `root_tag` goes into the pattern unescaped, as in the
/// original, and only when there is an original text.
pub fn root_attributes(
    original_xml: Option<&str>,
    root_tag: &str,
    fallback: &str,
    required: &[(String, String)],
) -> Result<String, RegexError> {
    let attrs = match truthy(original_xml) {
        Some(original_xml) => TryJsRegex::new(&format!(r"<{root_tag}\b([^>]*?)/?>"), "")?
            .try_exec(original_xml)?
            .and_then(|found| found.get(1))
            .map(trim),
        None => None,
    };
    let base = match attrs {
        Some(attrs) if attrs.contains("xmlns:") => attrs,
        _ => fallback,
    };
    let mut out = base.to_owned();
    for (prefix, uri) in required {
        if !base.contains(&format!("xmlns:{prefix}=")) {
            out.push_str(&format!(" xmlns:{prefix}=\"{uri}\""));
        }
    }
    Ok(out)
}

/// The note's self-reference mark run, spaced self-closing and paired forms
/// included.
fn has_note_ref_mark(entry_xml: &str) -> bool {
    js_regex!(r"<w:(?:footnote|endnote)Ref\b\s*\/?>").test(entry_xml)
}

/// Real notes (separator entries excluded), in file order. The paragraph
/// reader of the original (`read`, supplied by the document parser) is not
/// ported: these are the notes it returns without one.
pub fn parse_notes_xml(xml: &str, kind: NoteKind) -> Vec<NoteInfo> {
    note_entries_of(xml, kind)
        .into_iter()
        .map(|entry| NoteInfo {
            style_id: js_regex!(r#"<w:pStyle w:val="([^"]+)""#)
                .exec(entry.xml)
                .and_then(|found| found.get(1))
                .map(str::to_owned),
            zotero_field: js_regex!(r"ADDIN\s+(?:ZOTERO_|CSL_)")
                .test(entry.xml)
                .then_some(true),
            no_ref_mark: (!has_note_ref_mark(entry.xml)).then_some(true),
            id: entry.id.to_owned(),
            text: entry.text,
        })
        .collect()
}

/// The entry's paragraph slices in order (self-closing form first: the
/// open-to-close alternative would swallow it).
fn note_paragraphs_of(entry_xml: &str) -> impl Iterator<Item = &str> {
    js_regex!(r"<w:p(?:\s[^>]*)?\/>|<w:p[\s>][\s\S]*?<\/w:p>")
        .find_iter(entry_xml)
        .map(|found| found.as_str())
}

struct NoteEntry<'x> {
    id: &'x str,
    text: String,
    xml: &'x str,
}

/// Typeless (real) note entries with their exact XML slice and plain text.
fn note_entries_of(xml: &str, kind: NoteKind) -> Vec<NoteEntry<'_>> {
    // the attribute run must not end in "/" so a self-closing empty entry is
    // not read as an open tag over the next entry
    let entry = match kind {
        NoteKind::Footnote => js_regex!(r"<w:footnote(\s[^>]*[^/>])?>([\s\S]*?)</w:footnote>"),
        NoteKind::Endnote => js_regex!(r"<w:endnote(\s[^>]*[^/>])?>([\s\S]*?)</w:endnote>"),
    };
    let mut out = Vec::new();
    for found in entry.find_iter(xml) {
        let attrs = found.get(1).unwrap_or("");
        if js_regex!(r#"w:type=(?:"[^"]*"|'[^']*')"#).test(attrs) {
            continue;
        }
        let id = js_regex!(r#"w:id=(?:"([^"]+)"|'([^']+)')"#)
            .exec(attrs)
            .and_then(|id| truthy(id.get(1)).or(truthy(id.get(2))));
        let Some(id) = id else {
            continue;
        };
        out.push(NoteEntry {
            id,
            text: note_entry_plain_text(found.get(2).unwrap_or("")),
            xml: found.as_str(),
        });
    }
    out
}

/// Paragraph texts joined with newlines; the first paragraph starts with the
/// self-reference mark and a spacer.
fn note_entry_plain_text(inner_xml: &str) -> String {
    let mut paras: Vec<String> = note_paragraphs_of(inner_xml).map(note_plain_text).collect();
    if let Some(first) = paras.first_mut() {
        *first = trim_start(first).to_owned();
    }
    paras.join("\n")
}

fn note_plain_text(xml: &str) -> String {
    let texts: String = js_regex!(r"<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>")
        .find_iter(xml)
        .map(|found| found.get(1).unwrap_or(""))
        .collect();
    decode_entities(&texts)
}

/// Next free numeric note id (separator ids -1/0 and existing notes considered).
pub fn next_note_id(notes: &[NoteInfo]) -> String {
    let mut max = 0.0;
    for note in notes {
        let n = parse_int(&note.id, Radix::Ten);
        if n.is_finite() {
            max = math_max(max, n);
        }
    }
    number_to_string(max + 1.0)
}
