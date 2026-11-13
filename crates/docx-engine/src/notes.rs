//! The read side of packages/docx-engine/src/notes.ts (word/footnotes.xml,
//! word/endnotes.xml): `parseNotesXml`, `nextNoteId`, `rootAttributes`,
//! `noteModelText`.
//!
//! Entries carrying a w:type attribute (separator, continuationSeparator, ...)
//! are structural; only typeless entries are real notes.

use jscompat::{
    Radix, RegexError, RegexLimit, TryJsRegex, js_regex, number_to_string, parse_int, trim,
    trim_start, truthy, try_js_regex,
};
use ooxml_xml::{XNode, serialize};
use serde::{Deserialize, Serialize};

use crate::vml::math_max;
use crate::withheld::{parse_entry, placeholder_source, runs_text, withheld_text};
use crate::xml_text::{decode_entities, decode_numeric_char_refs};

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
    /// the text as a model may read it, each run hidden from AI as its
    /// placeholder; absent when the note hides nothing
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_text: Option<String>,
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

/// A note's text as a model may read it, from its display runs: each run
/// hidden from AI as its placeholder (neighbours under one label as one),
/// `None` when no run hides anything. Kept in step with the runs when a person
/// accepts or rejects a change in the note.
///
/// `noteModelText`
pub fn note_model_text(rich_paras: &[Vec<crate::model::NoteRun>]) -> Option<String> {
    if !rich_paras.iter().any(|runs| {
        runs.iter()
            .any(|run| run.redact.is_some() && run.del.is_none())
    }) {
        return None;
    }
    Some(
        rich_paras
            .iter()
            .map(|runs| {
                let mut line = String::new();
                let mut label: Option<&str> = None;
                for run in runs {
                    if run.del.is_some() {
                        continue;
                    }
                    match run.redact.as_deref() {
                        None => line.push_str(&run.text),
                        Some(redact) if Some(redact) != label => {
                            line.push_str(&placeholder_source(redact));
                        }
                        Some(_) => {}
                    }
                    label = run.redact.as_deref();
                }
                line
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

/// A note as the parser finds it, before a paragraph reader is asked.
struct ParsedNote {
    id: String,
    text: String,
    model_text: Option<String>,
    /// the entry as the parser read it, for the readers that take XML
    entry_xml: String,
}

/// The real notes of a part, found in the parser's tree: markup inside CDATA is
/// text, not a note; none when the part does not parse.
fn parsed_notes(xml: &str, kind: NoteKind) -> Vec<ParsedNote> {
    let Some(root) = parse_entry(xml) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in root.find_children(entry_tag(kind)) {
        // separator / continuation entries
        if entry.attr("w:type").is_some() {
            continue;
        }
        // an entry with no body at all (<w:footnote w:id="1"/>) is no note
        let Some(id) = truthy(entry.attr("w:id")).filter(|_| !entry.children().is_empty()) else {
            continue;
        };
        let text = note_tree_text(entry);
        // each run hidden from AI as its placeholder, or the whole note withheld
        // when a mark sits where no run accounts for it
        let model_text = withheld_text(entry, &note_tree_text);
        out.push(ParsedNote {
            id: id.to_owned(),
            text,
            model_text,
            entry_xml: serialize(entry),
        });
    }
    out
}

fn entry_tag(kind: NoteKind) -> &'static str {
    match kind {
        NoteKind::Footnote => "w:footnote",
        NoteKind::Endnote => "w:endnote",
    }
}

/// Real notes (separator entries excluded), in file order. The paragraph
/// reader of the original (`read`, supplied by the document parser) is not
/// ported here: these are the notes it returns without one.
pub fn parse_notes_xml(xml: &str, kind: NoteKind) -> Vec<NoteInfo> {
    parsed_notes(xml, kind)
        .into_iter()
        .map(|note| NoteInfo {
            style_id: js_regex!(r#"<w:pStyle w:val="([^"]+)""#)
                .exec(&note.entry_xml)
                .and_then(|found| found.get(1))
                .map(str::to_owned),
            zotero_field: js_regex!(r"ADDIN\s+(?:ZOTERO_|CSL_)")
                .test(&note.entry_xml)
                .then_some(true),
            no_ref_mark: (!has_note_ref_mark(&note.entry_xml)).then_some(true),
            id: note.id,
            text: note.text,
            model_text: note.model_text,
        })
        .collect()
}

/// `NoteParagraph`: one note paragraph read through the document's run
/// extraction and property resolver.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteParagraph {
    /// display runs, the self-reference mark run excluded
    pub runs: Vec<crate::model::NoteRun>,
    /// w:pStyle of the paragraph
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style_id: Option<String>,
    /// before / after / line resolved through the style chain and docDefaults
    pub spacing: crate::model::NoteInfoSpacing,
}

/// `parseNotesXml(xml, kind, read)` with a paragraph reader: the notes carry
/// `richParas` and `spacing` as the model holds them. `Err` where the reader does.
pub fn parse_notes_xml_with(
    xml: &str,
    kind: NoteKind,
    read: &mut dyn FnMut(&str) -> Result<NoteParagraph, String>,
) -> Result<Vec<crate::model::NoteInfo>, String> {
    let mut out = Vec::new();
    for note in parsed_notes(xml, kind) {
        let mut paras = Vec::new();
        for p_xml in note_paragraphs_of(&note.entry_xml) {
            paras.push(read(p_xml)?);
        }
        let first = paras.first();
        let mut rich_paras: Vec<Vec<crate::model::NoteRun>> =
            paras.iter().map(|para| para.runs.clone()).collect();
        // the first paragraph opens with the self-reference mark and a spacer; a
        // spacer that was its own run empties out and is dropped entirely
        if let Some(run) = rich_paras.first_mut().and_then(|runs| runs.first_mut()) {
            run.text = trim_start(&run.text).to_owned();
        }
        if rich_paras
            .first()
            .and_then(|runs| runs.first())
            .is_some_and(|run| run.text.is_empty())
        {
            rich_paras[0].remove(0);
        }
        let style_id = match first {
            Some(first) => first.style_id.clone(),
            None => js_regex!(r#"<w:pStyle w:val="([^"]+)""#)
                .exec(&note.entry_xml)
                .and_then(|found| found.get(1))
                .map(str::to_owned),
        };
        out.push(crate::model::NoteInfo {
            id: note.id,
            text: note.text,
            model_text: note.model_text,
            rich_paras: first.is_some().then_some(rich_paras),
            style_id: truthy(style_id.as_deref()).map(str::to_owned),
            zotero_field: js_regex!(r"ADDIN\s+(?:ZOTERO_|CSL_)")
                .test(&note.entry_xml)
                .then_some(crate::model::True),
            spacing: first.map(|first| first.spacing.clone()),
            no_ref_mark: (!has_note_ref_mark(&note.entry_xml)).then_some(crate::model::True),
            revisions_resolved: None,
        });
    }
    Ok(out)
}

/// The entry's paragraph slices in order (self-closing form first: the
/// open-to-close alternative would swallow it).
fn note_paragraphs_of(entry_xml: &str) -> impl Iterator<Item = &str> {
    js_regex!(r"<w:p(?:\s[^>]*)?\/>|<w:p[\s>][\s\S]*?<\/w:p>")
        .find_iter(entry_xml)
        .map(|found| found.as_str())
}

/// An entry of a notes part with its exact XML slice, whether it carries a
/// w:type, and its w:id as the parser reads it.
pub(crate) struct NoteSlice<'x> {
    pub(crate) id: Option<String>,
    pub(crate) typed: bool,
    pub(crate) xml: &'x str,
}

/// `noteSlicesOf`: every entry of a notes part with its exact XML slice, found
/// the way the parser finds them: any quotes, white space around `=` and
/// before the closing `>`, `>` or `/>` inside a value, and nothing inside a
/// comment or CDATA taken for a tag. The save keeps an entry's bytes only when it finds it here; one
/// it misses is written anew from plain text and loses its runs, a
/// hidden-from-AI mark among them.
pub(crate) fn note_slices_of(xml: &str, kind: NoteKind) -> Result<Vec<NoteSlice<'_>>, RegexLimit> {
    let tokens = match kind {
        NoteKind::Footnote => try_js_regex!(
            r#"<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(/?)w:footnote\b((?:[^>"']|"[^"]*"|'[^']*')*?)(/?)>"#,
            "g"
        ),
        NoteKind::Endnote => try_js_regex!(
            r#"<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(/?)w:endnote\b((?:[^>"']|"[^"]*"|'[^']*')*?)(/?)>"#,
            "g"
        ),
    };
    let mut out = Vec::new();
    // the start of the open tag and its attributes
    let mut open: Option<(usize, &str)> = None;
    for found in tokens.try_find_iter(xml) {
        let found = found?;
        // a comment, CDATA or a processing instruction
        let Some(attrs) = found.get(2) else {
            continue;
        };
        if found.get(1) != Some("/") {
            // a self-closing entry has no body: it is no note, and nothing to keep
            if found.get(3) != Some("/") {
                open = Some((found.start(), attrs));
            }
            continue;
        }
        let Some((start, attrs)) = open.take() else {
            continue;
        };
        out.push(NoteSlice {
            id: attr_value(
                attrs,
                js_regex!(r#"(?:^|\s)w:id\s*=\s*(?:"([^"]*)"|'([^']*)')"#),
            ),
            typed: attr_value(
                attrs,
                js_regex!(r#"(?:^|\s)w:type\s*=\s*(?:"([^"]*)"|'([^']*)')"#),
            )
            .is_some(),
            xml: &xml[start..found.end()],
        });
    }
    Ok(out)
}

/// An attribute of an open tag's text, written with either quote, its entities decoded.
fn attr_value(attrs: &str, pattern: &jscompat::JsRegex) -> Option<String> {
    let found = pattern.exec(attrs)?;
    Some(decode_entities(found.get(1).or(found.get(2))?))
}

pub(crate) struct NoteEntry<'x> {
    pub(crate) id: String,
    pub(crate) text: String,
    pub(crate) xml: &'x str,
}

/// `noteEntriesOf`: typeless (real) note entries with their exact XML slice and
/// their text as the parser reads it.
pub(crate) fn note_entries_of(xml: &str, kind: NoteKind) -> Result<Vec<NoteEntry<'_>>, RegexLimit> {
    Ok(note_slices_of(xml, kind)?
        .into_iter()
        .filter_map(|slice| {
            let id = slice.id.filter(|id| !id.is_empty());
            match (slice.typed, id) {
                (false, Some(id)) => Some(NoteEntry {
                    id,
                    text: entry_text(slice.xml),
                    xml: slice.xml,
                }),
                _ => None,
            }
        })
        .collect())
}

/// `entryText`: a note slice's text as the parser reads it (the pattern's
/// reading when it does not parse).
pub(crate) fn entry_text(entry_xml: &str) -> String {
    match parse_entry(entry_xml) {
        Some(node) => note_tree_text(&node),
        None => note_entry_plain_text(entry_xml),
    }
}

/// `noteTreeText`: a parsed note's text: its paragraphs' run text, the first
/// one's leading spacer dropped.
fn note_tree_text(entry: &XNode) -> String {
    let mut paras: Vec<String> = entry
        .find_children("w:p")
        .map(|para| decode_numeric_char_refs(&runs_text(para)).into_owned())
        .collect();
    if let Some(first) = paras.first_mut() {
        *first = trim_start(first).to_owned();
    }
    paras.join("\n")
}

/// Paragraph texts joined with newlines; the first paragraph starts with the
/// self-reference mark and a spacer.
pub(crate) fn note_entry_plain_text(inner_xml: &str) -> String {
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
