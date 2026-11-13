//! `packages/pdf-structure/src/store/note-links.ts`: the note links (reading-
//! assist spec 5.4): which Markdown note belongs to which PDF, in one file
//! `pdf-store/note-links.json`. A link is keyed by the PDF's path, not by its
//! content hash; the hash is the fallback.

use jscompat::{JsObject, JsonValue};

use super::reading::{is_segment, num, object, record, string};

/// `noteLinkKey(pdfPath, platform)`: the key of a PDF, its `path.resolve()`d
/// path, lower-cased on Windows (the module of the pdf editor's note links
/// holds the one port of it)
pub use crate::pdf::note_link::note_link_key;

/// `NOTE_LINKS_FILE`
pub const NOTE_LINKS_FILE: &str = "note-links.json";

/// `NoteLink`
#[derive(Debug, Clone, PartialEq)]
pub struct NoteLink {
    /// absolute path of the Markdown note
    pub note_path: String,
    /// content hash of the PDF when the link was last written or updated
    pub doc_hash: String,
    /// epoch ms of the last write
    pub updated_at: f64,
}

impl NoteLink {
    /// `{ notePath, docHash, updatedAt }`
    pub fn to_value(&self) -> JsonValue {
        object(vec![
            ("notePath", JsonValue::String(self.note_path.clone())),
            ("docHash", JsonValue::String(self.doc_hash.clone())),
            ("updatedAt", JsonValue::Number(self.updated_at)),
        ])
    }
}

/// `NoteLinks`: `{ version: 1, links }`, the links keyed by `noteLinkKey(pdf path)`
#[derive(Debug, Clone, PartialEq)]
pub struct NoteLinks {
    pub links: JsObject<NoteLink>,
}

impl NoteLinks {
    /// `{ version: 1, links }` as it is written
    pub fn to_value(&self) -> JsonValue {
        let links: JsObject<JsonValue> = self
            .links
            .entries()
            .into_iter()
            .map(|(key, link)| (key.to_owned(), link.to_value()))
            .collect();
        object(vec![
            ("version", JsonValue::Number(1.0)),
            ("links", JsonValue::Object(links)),
        ])
    }
}

/// `FoundNoteLink['matchedBy']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchedBy {
    Path,
    DocHash,
}

impl MatchedBy {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchedBy::Path => "path",
            MatchedBy::DocHash => "docHash",
        }
    }
}

/// `FoundNoteLink`: a link found for a PDF, and how it was found
#[derive(Debug, Clone, PartialEq)]
pub struct FoundNoteLink {
    pub link: NoteLink,
    /// the key of the link in `NoteLinks.links`
    pub pdf_key: String,
    pub matched_by: MatchedBy,
}

impl FoundNoteLink {
    /// `{ ...link, pdfKey, matchedBy }`
    pub fn to_value(&self) -> JsonValue {
        object(vec![
            ("notePath", JsonValue::String(self.link.note_path.clone())),
            ("docHash", JsonValue::String(self.link.doc_hash.clone())),
            ("updatedAt", JsonValue::Number(self.link.updated_at)),
            ("pdfKey", JsonValue::String(self.pdf_key.clone())),
            (
                "matchedBy",
                JsonValue::String(self.matched_by.as_str().to_owned()),
            ),
        ])
    }
}

/// `asNoteLinks(raw)`: the readable links of a parsed file; anything else
/// counts as no links
pub fn as_note_links(raw: Option<&JsonValue>) -> NoteLinks {
    let mut out = NoteLinks {
        links: JsObject::new(),
    };
    let Some(r) = record(raw) else {
        return out;
    };
    if r.get("version") != Some(&JsonValue::Number(1.0)) {
        return out;
    }
    let Some(links) = record(r.get("links")) else {
        return out;
    };
    for (key, link) in links.entries() {
        let Some(link) = record(Some(link)) else {
            continue;
        };
        let Some(note_path) = string(link.get("notePath")).filter(|p| !p.is_empty()) else {
            continue;
        };
        if !is_segment(link.get("docHash")) {
            continue;
        }
        let Some(updated_at) = num(link.get("updatedAt")) else {
            continue;
        };
        out.links.set(
            key,
            NoteLink {
                note_path: note_path.to_owned(),
                doc_hash: string(link.get("docHash")).unwrap_or_default().to_owned(),
                updated_at,
            },
        );
    }
    out
}
