//! `apps/shell/src/main/generate/materials.ts`: material status for the
//! generate window: size, whether the file can be read (and if not, why), its
//! text length, and whether it is open somewhere with unsaved changes.
//!
//! The file reader (`parseFileToText` of `@seuoffice/file-parse`) is an
//! engine this crate does not hold: [`FileParser`] is the seam, and
//! [`InspectHost`] carries it with the other reads of one inspection. The
//! module-level length cache is a [`MaterialLengthCache`] the caller keeps.
//! Promises are plain calls; a rejection is a [`Failure`].

use jscompat::node_path::host::{basename, extname, is_absolute, resolve};
use jscompat::number_to_string;
use serde_json::{Map, Value};

use super::generate_api::{AiTargetKind, MaterialProblem, Notices};
use super::limits::{
    LONG_MATERIAL_NOTICE_CHARS, MAX_IMAGE_MATERIAL_BYTES, MAX_MATERIAL_BYTES, MAX_MATERIALS,
    USAGE_NOTICE_CHARS,
};
use crate::packages::electron_utils::unsaved_files::{OpenFilesHolder, file_has_unsaved_changes};
use crate::packages::file_parse::attachable::{attachable_exts, attachable_max_bytes};
use crate::shell::renderer_disposal::Failure;

/// `ParsedFile` of `@seuoffice/file-parse`, the parts this module reads
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParsedFile {
    pub ok: bool,
    pub error: Option<String>,
    /// `text`, `image`, ...
    pub kind: Option<String>,
    /// absent when the reader gave no string
    pub text: Option<String>,
}

/// `parseFileToText(path)`: reads a file as the redaction-aware reader does
pub trait FileParser {
    fn parse_file_to_text(&mut self, path: &str) -> Result<ParsedFile, Failure>;
}

/// pictures: handed over as images, no text to measure
pub const IMAGE_MATERIAL_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// The largest material of this extension: pictures to the receiving editors'
/// cap, formats whose size is pictures (zip-based documents, PDF) at any size,
/// the rest to `MAX_MATERIAL_BYTES`.
pub fn material_max_bytes(ext: &str) -> f64 {
    if IMAGE_MATERIAL_EXTS.contains(&ext) {
        return MAX_IMAGE_MATERIAL_BYTES;
    }
    if attachable_max_bytes(ext).is_finite() {
        MAX_MATERIAL_BYTES
    } else {
        f64::INFINITY
    }
}

/// The formats `parseFileToText` reads by a file's last extension that make material.
const PARSED_MATERIAL_EXTS: [&str; 28] = [
    "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "log", "py", "doc",
    "docx", "odt", "ppt", "pptx", "xlsx", "xlsm", "pdf", "xmind", "epub", "hwp", "hwpx", "png",
    "jpg", "jpeg", "gif", "webp",
];

/// `SUPPORTED_MATERIAL_EXTS`: the attachable formats the reader reads, in the order of the set
pub fn supported_material_exts() -> Vec<&'static str> {
    attachable_exts()
        .into_iter()
        .filter(|ext| PARSED_MATERIAL_EXTS.contains(ext))
        .collect()
}

/// `SUPPORTED_MATERIAL_EXTS.has(ext)`
pub fn is_supported_material_ext(ext: &str) -> bool {
    supported_material_exts().contains(&ext)
}

#[derive(Debug, Clone, PartialEq)]
pub struct MaterialStatus {
    /// the path, or `untitled:<webContentsId>` for a document never saved
    pub key: String,
    pub name: String,
    pub path: Option<String>,
    /// lowercased extension without the dot ('' when none)
    pub ext: String,
    pub size_bytes: Option<f64>,
    /// set when the file is left out of the materials
    pub problem: Option<MaterialProblem>,
    /// open in a tab with unsaved changes (or the host could not say): blocks "make"
    pub unsaved: bool,
    /// characters of text the file reads as; 0 for pictures and for files not read
    pub text_length: f64,
}

impl MaterialStatus {
    /// The JSON of the TypeScript object. A status that comes from a path is
    /// `{ key, name, path, ext, unsaved, textLength }` with `sizeBytes` and
    /// `problem` added after them; the one of `untitledMaterial` is written in
    /// its own order.
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        out.insert("key".to_owned(), Value::from(self.key.as_str()));
        out.insert("name".to_owned(), Value::from(self.name.as_str()));
        if self.path.is_none() {
            out.insert("ext".to_owned(), Value::from(self.ext.as_str()));
            if let Some(problem) = self.problem {
                out.insert(
                    "problem".to_owned(),
                    serde_json::to_value(problem).expect("a problem prints"),
                );
            }
            out.insert("unsaved".to_owned(), Value::Bool(self.unsaved));
            out.insert("textLength".to_owned(), Value::from(self.text_length));
            return Value::Object(out);
        }
        if let Some(path) = &self.path {
            out.insert("path".to_owned(), Value::from(path.as_str()));
        }
        out.insert("ext".to_owned(), Value::from(self.ext.as_str()));
        out.insert("unsaved".to_owned(), Value::Bool(self.unsaved));
        out.insert("textLength".to_owned(), Value::from(self.text_length));
        if let Some(size) = self.size_bytes {
            out.insert("sizeBytes".to_owned(), Value::from(size));
        }
        if let Some(problem) = self.problem {
            out.insert(
                "problem".to_owned(),
                serde_json::to_value(problem).expect("a problem prints"),
            );
        }
        Value::Object(out)
    }
}

/// `(await stat(path))` as this module reads it
#[derive(Debug, Clone, PartialEq)]
pub struct FileStat {
    pub is_file: bool,
    pub size: f64,
    pub mtime_ms: Option<f64>,
}

/// `InspectDeps`: the reads of one inspection. A call that rejects is a
/// [`Failure`]. The open-files question (`hasUnsavedChanges`) is not a host
/// call: `inspect_material` is handed the filled [`OpenFilesHolder`].
pub trait InspectHost {
    fn stat(&mut self, path: &str) -> Result<FileStat, Failure>;
    fn parse(&mut self, path: &str) -> Result<ParsedFile, Failure>;
    /// `deps.parse` was given: an injected parser bypasses the length cache
    fn injected_parse(&self) -> bool;
}

/// Text lengths by path + size + mtime, so reopening the status does not
/// parse every file again. Holds numbers only, never text.
#[derive(Debug, Default)]
pub struct MaterialLengthCache {
    entries: Vec<(String, f64)>,
}

const LENGTH_CACHE_MAX: usize = 64;

impl MaterialLengthCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, key: &str) -> Option<f64> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| *v)
    }

    /// `rememberLength`: the key is deleted and set again, so it is the newest
    fn remember(&mut self, key: &str, length: f64) {
        self.entries.retain(|(k, _)| k != key);
        self.entries.push((key.to_owned(), length));
        if self.entries.len() > LENGTH_CACHE_MAX {
            self.entries.remove(0);
        }
    }
}

/// `extOf(path)`: the last extension, lowercased, without the dot
pub fn ext_of(path: &str) -> String {
    let ext = extname(path);
    // `.slice(1)`: the dot is one unit; '' stays ''
    ext.get(1..).unwrap_or("").to_lowercase()
}

/// one spelling per file, for de-duplicating the list (case-folded on Windows)
pub fn material_key(path: &str) -> String {
    let resolved = resolve(&[path]);
    if cfg!(windows) {
        resolved.to_lowercase()
    } else {
        resolved
    }
}

/// a document that was never saved: it cannot be material until it is
pub fn untitled_material(web_contents_id: f64, title: &str) -> MaterialStatus {
    MaterialStatus {
        key: format!("untitled:{}", number_to_string(web_contents_id)),
        name: title.to_owned(),
        path: None,
        ext: String::new(),
        size_bytes: None,
        problem: Some(MaterialProblem::Untitled),
        unsaved: false,
        text_length: 0.0,
    }
}

fn with_problem(mut status: MaterialStatus, problem: MaterialProblem) -> MaterialStatus {
    status.problem = Some(problem);
    status
}

/// `inspectMaterial(path, deps)`
pub fn inspect_material(
    host: &mut dyn InspectHost,
    cache: &mut MaterialLengthCache,
    open_files: &OpenFilesHolder,
    path: &str,
) -> Result<MaterialStatus, Failure> {
    let ext = ext_of(path);
    let base_name = basename(path, None);
    let base = MaterialStatus {
        key: path.to_owned(),
        // `basename(path) || path`
        name: if base_name.is_empty() {
            path.to_owned()
        } else {
            base_name
        },
        path: Some(path.to_owned()),
        ext: ext.clone(),
        size_bytes: None,
        problem: None,
        unsaved: false,
        text_length: 0.0,
    };
    if !is_absolute(path) {
        return Ok(with_problem(base, MaterialProblem::Missing));
    }
    if !is_supported_material_ext(&ext) {
        return Ok(with_problem(base, MaterialProblem::Unsupported));
    }

    let (size, mtime_ms) = match host.stat(path) {
        Ok(st) => {
            if !st.is_file {
                return Ok(with_problem(base, MaterialProblem::Missing));
            }
            (st.size, st.mtime_ms)
        }
        Err(_) => return Ok(with_problem(base, MaterialProblem::Missing)),
    };
    let mut sized = base;
    sized.size_bytes = Some(size);
    if size > material_max_bytes(&ext) {
        return Ok(with_problem(sized, MaterialProblem::TooLarge));
    }

    // before any read: a file with unsaved changes is not read until saved
    if file_has_unsaved_changes(open_files, path) {
        sized.unsaved = true;
        return Ok(sized);
    }

    let cache_key = match mtime_ms {
        Some(mtime) if !host.injected_parse() => Some(format!(
            "{}|{}|{}",
            material_key(path),
            number_to_string(size),
            number_to_string(mtime)
        )),
        _ => None,
    };
    if let Some(cached) = cache_key.as_deref().and_then(|key| cache.get(key)) {
        sized.text_length = cached;
        return Ok(sized);
    }

    let parsed = match host.parse(path) {
        Ok(parsed) => parsed,
        Err(_) => return Ok(with_problem(sized, MaterialProblem::Unreadable)),
    };
    if !parsed.ok {
        return Ok(with_problem(sized, MaterialProblem::Unreadable));
    }
    if parsed.kind.as_deref() == Some("image") {
        return Ok(sized);
    }
    let Some(text) = parsed
        .text
        .as_deref()
        .filter(|_| parsed.kind.as_deref() == Some("text"))
    else {
        return Ok(with_problem(sized, MaterialProblem::Unreadable));
    };
    // the length is all that is kept; the text goes out of scope here
    let text_length = text.encode_utf16().count() as f64;
    if let Some(key) = &cache_key {
        cache.remember(key, text_length);
    }
    sized.text_length = text_length;
    Ok(sized)
}

/// `generateNotices(kind, totalTextLength)`: two notices, neither blocks
/// "make". Thresholds are exclusive: exactly at the value is not "above" it.
pub fn generate_notices(kind: AiTargetKind, total_text_length: f64) -> Notices {
    Notices {
        usage: total_text_length > USAGE_NOTICE_CHARS,
        long_material: matches!(kind, AiTargetKind::Slides | AiTargetKind::Html)
            && total_text_length > LONG_MATERIAL_NOTICE_CHARS,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MaterialSummary {
    pub ready: Vec<MaterialStatus>,
    pub unsaved: Vec<MaterialStatus>,
    pub excluded: Vec<MaterialStatus>,
    pub total_bytes: f64,
    pub total_text_length: f64,
    pub notices: Notices,
    /// more listed rows than the cap (excluded rows do not count: they are not sent)
    pub too_many: bool,
    /// at least one readable material, none unsaved, not too many
    pub can_make: bool,
}

impl MaterialSummary {
    pub fn to_value(&self) -> Value {
        let list = |items: &[MaterialStatus]| {
            Value::Array(items.iter().map(MaterialStatus::to_value).collect())
        };
        let mut out = Map::new();
        out.insert("ready".to_owned(), list(&self.ready));
        out.insert("unsaved".to_owned(), list(&self.unsaved));
        out.insert("excluded".to_owned(), list(&self.excluded));
        out.insert("totalBytes".to_owned(), Value::from(self.total_bytes));
        out.insert(
            "totalTextLength".to_owned(),
            Value::from(self.total_text_length),
        );
        out.insert(
            "notices".to_owned(),
            serde_json::to_value(self.notices).expect("notices print"),
        );
        out.insert("tooMany".to_owned(), Value::Bool(self.too_many));
        out.insert("canMake".to_owned(), Value::Bool(self.can_make));
        Value::Object(out)
    }
}

/// `summarizeMaterials(statuses, kind)`
pub fn summarize_materials(statuses: &[MaterialStatus], kind: AiTargetKind) -> MaterialSummary {
    let unsaved: Vec<MaterialStatus> = statuses
        .iter()
        .filter(|s| s.problem.is_none() && s.unsaved)
        .cloned()
        .collect();
    let ready: Vec<MaterialStatus> = statuses
        .iter()
        .filter(|s| s.problem.is_none() && !s.unsaved)
        .cloned()
        .collect();
    let excluded: Vec<MaterialStatus> = statuses
        .iter()
        .filter(|s| s.problem.is_some())
        .cloned()
        .collect();
    let total_bytes = ready
        .iter()
        .fold(0.0, |sum, s| sum + s.size_bytes.unwrap_or(0.0));
    let total_text_length = ready.iter().fold(0.0, |sum, s| sum + s.text_length);
    let too_many = ready.len() + unsaved.len() > MAX_MATERIALS;
    let can_make = !ready.is_empty() && unsaved.is_empty() && !too_many;
    MaterialSummary {
        ready,
        unsaved,
        excluded,
        total_bytes,
        total_text_length,
        notices: generate_notices(kind, total_text_length),
        too_many,
        can_make,
    }
}
