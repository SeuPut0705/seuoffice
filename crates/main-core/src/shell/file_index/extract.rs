//! `apps/shell/src/main/file-index/extract.ts`: the text of one file for the
//! index. `@seuoffice/file-parse` (`parseFileToText`, `redactHtmlSource`) is
//! engine work that waits for its Rust port: it sits behind [`FileParser`],
//! and what is ported is the judgment around it (the size gate, the HTML path,
//! the cut, the shape of the answer). A `Promise` is a plain call.

use std::fs;

use jscompat::node_path::host::extname;
use jscompat::{js_regex, slice_utf16};
use serde_json::{Map, Value};

use crate::markdown::fs_util::read_file_utf8;
use crate::node_fs::{namespaced, node_error};

/// larger files are indexed by name and folder only
pub const MAX_EXTRACT_BYTES: u64 = 64 * 1024 * 1024;
/// body text kept for snippets and indexed; longer files are cut
pub const MAX_BODY_CHARS: usize = 1_000_000;

/// `Extracted`
#[derive(Debug, Clone, PartialEq)]
pub enum Extracted {
    Text(String),
    NameOnly,
    Error(String),
}

impl Extracted {
    /// `{ kind: 'text', text }`, `{ kind: 'name-only' }` or `{ kind: 'error', error }`
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        match self {
            Extracted::Text(text) => {
                out.insert("kind".into(), Value::from("text"));
                out.insert("text".into(), Value::from(text.as_str()));
            }
            Extracted::NameOnly => {
                out.insert("kind".into(), Value::from("name-only"));
            }
            Extracted::Error(error) => {
                out.insert("kind".into(), Value::from("error"));
                out.insert("error".into(), Value::from(error.as_str()));
            }
        }
        Value::Object(out)
    }
}

/// `ParsedFileKind` of `@seuoffice/file-parse`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParsedFileKind {
    Text,
    Image,
    Unsupported,
}

/// `ParsedFile` of `@seuoffice/file-parse`: what `extractText` reads of it
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedFile {
    pub ok: bool,
    pub text: Option<String>,
    pub kind: ParsedFileKind,
    pub error: Option<String>,
}

/// What `extractText` calls of `@seuoffice/file-parse`. `Err` is what the
/// `catch` of `extractText` writes: the message of an `Error`, `String(e)` of
/// anything else.
pub trait FileParser {
    /// `redactHtmlSource(source)`
    fn redact_html_source(&mut self, source: &str) -> Result<String, String>;
    /// `parseFileToText(path)`
    fn parse_file_to_text(&mut self, path: &str) -> Result<ParsedFile, String>;
}

/// `stripMarkup(html)`
fn strip_markup(html: &str) -> String {
    let text =
        js_regex!(r"<(script|style)[\s\S]*?</\1>", "gi").replace_all(html, |_| " ".to_owned());
    let text = js_regex!(r"<[^>]+>", "g").replace_all(&text, |_| " ".to_owned());
    text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// `.slice(0, MAX_BODY_CHARS)`
fn cut_body(text: &str) -> String {
    slice_utf16(text, 0.0, Some(MAX_BODY_CHARS as f64))
}

pub fn extract_text(path: &str, parser: &mut dyn FileParser) -> Extracted {
    let meta = match fs::metadata(namespaced(path)) {
        Ok(meta) => meta,
        Err(e) => return Extracted::Error(node_error(&e, "stat", path).message),
    };
    if meta.len() > MAX_EXTRACT_BYTES {
        return Extracted::NameOnly;
    }
    let ext: String = extname(path)
        .chars()
        .skip(1)
        .collect::<String>()
        .to_lowercase();
    if ext == "html" || ext == "htm" {
        // what the page withholds from a model goes before the tags do: the index
        // feeds excerpts to the knowledge base and the reranker. A mark that cannot
        // be processed throws, and the catch keeps the body out of the index
        let source = match read_file_utf8(path) {
            Ok(source) => source,
            Err(e) => return Extracted::Error(e.message),
        };
        return match parser.redact_html_source(&source) {
            Ok(redacted) => Extracted::Text(cut_body(&strip_markup(&redacted))),
            Err(message) => Extracted::Error(message),
        };
    }
    let parsed = match parser.parse_file_to_text(path) {
        Ok(parsed) => parsed,
        Err(message) => return Extracted::Error(message),
    };
    if parsed.kind == ParsedFileKind::Unsupported {
        return Extracted::NameOnly;
    }
    if !parsed.ok || parsed.kind != ParsedFileKind::Text {
        return Extracted::Error(parsed.error.unwrap_or_else(|| "parse failed".to_owned()));
    }
    Extracted::Text(cut_body(parsed.text.as_deref().unwrap_or("")))
}
