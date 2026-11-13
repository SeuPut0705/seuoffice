//! `apps/shell/src/main/quick-look/extract.ts` and the data shapes of
//! `apps/shell/src/shared/quick-look-api.ts` it fills.
//!
//! What the preview reads a file with is not in this crate: the text of a
//! document comes from `parseFileToText` of `@seuoffice/file-parse` and the
//! thumbnail of a ZIP-based file from JSZip behind the zip-bomb gate of
//! `@seuoffice/docx-engine`. Both are the [`QuickLookEngines`] the caller
//! passes. The thumbnail of an HWP 5 file is read here (the compound-file
//! gate, the container reader and the raw inflater are this crate's).

mod extract;
mod parse;

use serde_json::{Map, Value};

pub use extract::{
    ParsedFile, QuickLookCache, QuickLookEngines, ZipArchive, extract_embedded_thumbnail,
    extract_quick_look,
};
pub use parse::{
    parse_doc_blocks_from_text, parse_mindmap_from_text, parse_sheets_from_text,
    parse_slides_from_text,
};

/// `QuickLookFamily`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    Docx,
    Xlsx,
    Pptx,
    Pdf,
    Hwp,
    Xmind,
    Md,
    Html,
    Image,
    Text,
    Unsupported,
}

impl Family {
    pub fn as_str(self) -> &'static str {
        match self {
            Family::Docx => "docx",
            Family::Xlsx => "xlsx",
            Family::Pptx => "pptx",
            Family::Pdf => "pdf",
            Family::Hwp => "hwp",
            Family::Xmind => "xmind",
            Family::Md => "md",
            Family::Html => "html",
            Family::Image => "image",
            Family::Text => "text",
            Family::Unsupported => "unsupported",
        }
    }
}

/// `FAMILY_BY_EXT[ext]` of an extension already cleaned
fn family_by_ext(ext: &str) -> Option<Family> {
    Some(match ext {
        "docx" | "doc" | "odt" => Family::Docx,
        "xlsx" | "xlsm" | "xls" | "csv" | "tsv" => Family::Xlsx,
        "pptx" | "ppt" => Family::Pptx,
        "pdf" => Family::Pdf,
        "hwp" | "hwpx" => Family::Hwp,
        "xmind" => Family::Xmind,
        "md" | "markdown" => Family::Md,
        "html" | "htm" => Family::Html,
        "png" | "jpg" | "jpeg" | "gif" | "webp" => Family::Image,
        "txt" | "json" | "xml" | "log" | "py" => Family::Text,
        _ => return None,
    })
}

/// `quickLookFamilyOf(ext)`
pub fn quick_look_family_of(ext: &str) -> Family {
    let trimmed = jscompat::trim(ext);
    let clean = trimmed.strip_prefix('.').unwrap_or(trimmed).to_lowercase();
    family_by_ext(&clean).unwrap_or(Family::Unsupported)
}

/// `isQuickLookSupportedPath(filePath)`
pub fn is_quick_look_supported_path(file_path: &str) -> bool {
    let norm = file_path.replace('\\', "/");
    let base = norm.rsplit('/').next().unwrap_or("");
    // `lastIndexOf('.')` counts UTF-16 units, and only "is it past 0" matters
    let Some(dot) = base.rfind('.') else {
        return false;
    };
    if dot == 0 {
        return false;
    }
    family_by_ext(&base[dot + 1..].to_lowercase()).is_some()
}

/// `QuickLookErrorCode`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    Missing,
    Encrypted,
    Unsupported,
    Unreadable,
}

impl ErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::Missing => "missing",
            ErrorCode::Encrypted => "encrypted",
            ErrorCode::Unsupported => "unsupported",
            ErrorCode::Unreadable => "unreadable",
        }
    }
}

/// `QuickLookSheet`
#[derive(Debug, Clone, PartialEq)]
pub struct Sheet {
    pub name: String,
    pub rows: Vec<Vec<String>>,
    pub truncated_rows: bool,
    pub truncated_cols: bool,
}

/// `QuickLookSlide`
#[derive(Debug, Clone, PartialEq)]
pub struct Slide {
    pub number: f64,
    pub title: String,
    pub bullets: Vec<String>,
    pub notes: Vec<String>,
}

/// `QuickLookDocBlock['kind']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Heading,
    Paragraph,
    Bullet,
    Table,
    Code,
}

impl BlockKind {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockKind::Heading => "heading",
            BlockKind::Paragraph => "paragraph",
            BlockKind::Bullet => "bullet",
            BlockKind::Table => "table",
            BlockKind::Code => "code",
        }
    }
}

/// `QuickLookDocBlock`
#[derive(Debug, Clone, PartialEq)]
pub struct DocBlock {
    pub kind: BlockKind,
    pub level: Option<u32>,
    pub text: Option<String>,
    pub rows: Option<Vec<Vec<String>>>,
}

/// `QuickLookMindmapNode`
#[derive(Debug, Clone, PartialEq)]
pub struct MindmapNode {
    pub depth: u32,
    pub text: String,
}

/// `QuickLookMindmapSheet`
#[derive(Debug, Clone, PartialEq)]
pub struct MindmapSheet {
    pub title: String,
    pub nodes: Vec<MindmapNode>,
}

/// `QuickLookPayload`; [`QuickLookPayload::to_json`] writes the keys in the
/// order `extractQuickLook`'s spreads leave them
#[derive(Debug, Clone, PartialEq)]
pub struct QuickLookPayload {
    pub ok: bool,
    pub path: String,
    pub name: String,
    pub ext: String,
    pub family: Family,
    pub size_bytes: f64,
    pub mtime_ms: f64,
    pub thumbnail_data_url: Option<String>,
    pub doc_blocks: Option<Vec<DocBlock>>,
    pub sheets: Option<Vec<Sheet>>,
    pub slides: Option<Vec<Slide>>,
    pub mindmap: Option<Vec<MindmapSheet>>,
    pub plain_text: Option<String>,
    pub truncated: Option<bool>,
    pub error: Option<ErrorCode>,
    /// `Some(None)`: the key is there, `undefined`
    pub error_message: Option<Option<String>>,
}

fn rows_json(rows: &[Vec<String>]) -> Value {
    Value::Array(
        rows.iter()
            .map(|row| Value::Array(row.iter().cloned().map(Value::String).collect()))
            .collect(),
    )
}

fn strings_json(items: &[String]) -> Value {
    Value::Array(items.iter().cloned().map(Value::String).collect())
}

fn number(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

impl DocBlock {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("kind".into(), self.kind.as_str().into());
        if let Some(level) = self.level {
            o.insert("level".into(), level.into());
        }
        if let Some(text) = &self.text {
            o.insert("text".into(), text.clone().into());
        }
        if let Some(rows) = &self.rows {
            o.insert("rows".into(), rows_json(rows));
        }
        Value::Object(o)
    }
}

impl Sheet {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("name".into(), self.name.clone().into());
        o.insert("rows".into(), rows_json(&self.rows));
        o.insert("truncatedRows".into(), self.truncated_rows.into());
        o.insert("truncatedCols".into(), self.truncated_cols.into());
        Value::Object(o)
    }
}

impl Slide {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("number".into(), number(self.number));
        o.insert("title".into(), self.title.clone().into());
        o.insert("bullets".into(), strings_json(&self.bullets));
        o.insert("notes".into(), strings_json(&self.notes));
        Value::Object(o)
    }
}

impl MindmapSheet {
    pub fn to_json(&self) -> Value {
        let nodes = self
            .nodes
            .iter()
            .map(|node| {
                let mut o = Map::new();
                o.insert("depth".into(), node.depth.into());
                o.insert("text".into(), node.text.clone().into());
                Value::Object(o)
            })
            .collect();
        let mut o = Map::new();
        o.insert("title".into(), self.title.clone().into());
        o.insert("nodes".into(), Value::Array(nodes));
        Value::Object(o)
    }
}

impl QuickLookPayload {
    pub fn to_json(&self) -> Value {
        let mut o = Map::new();
        o.insert("ok".into(), self.ok.into());
        o.insert("path".into(), self.path.clone().into());
        o.insert("name".into(), self.name.clone().into());
        o.insert("ext".into(), self.ext.clone().into());
        o.insert("family".into(), self.family.as_str().into());
        o.insert("sizeBytes".into(), number(self.size_bytes));
        o.insert("mtimeMs".into(), number(self.mtime_ms));
        if let Some(url) = &self.thumbnail_data_url {
            o.insert("thumbnailDataUrl".into(), url.clone().into());
        }
        if let Some(blocks) = &self.doc_blocks {
            o.insert(
                "docBlocks".into(),
                Value::Array(blocks.iter().map(DocBlock::to_json).collect()),
            );
        }
        if let Some(sheets) = &self.sheets {
            o.insert(
                "sheets".into(),
                Value::Array(sheets.iter().map(Sheet::to_json).collect()),
            );
        }
        if let Some(slides) = &self.slides {
            o.insert(
                "slides".into(),
                Value::Array(slides.iter().map(Slide::to_json).collect()),
            );
        }
        if let Some(mindmap) = &self.mindmap {
            o.insert(
                "mindmap".into(),
                Value::Array(mindmap.iter().map(MindmapSheet::to_json).collect()),
            );
        }
        if let Some(text) = &self.plain_text {
            o.insert("plainText".into(), text.clone().into());
        }
        if let Some(truncated) = self.truncated {
            o.insert("truncated".into(), truncated.into());
        }
        if let Some(error) = self.error {
            o.insert("error".into(), error.as_str().into());
        }
        // `errorMessage: undefined` keeps its key in a structured clone but not in JSON
        if let Some(Some(message)) = &self.error_message {
            o.insert("errorMessage".into(), message.clone().into());
        }
        Value::Object(o)
    }
}
