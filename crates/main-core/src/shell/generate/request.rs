//! `apps/shell/src/main/generate/request.ts`: the generate request (8.1) and
//! its checks. Every entry point builds the same request; the main process
//! checks it again before anything opens, whatever the window last showed.
//!
//! The request arrives as the JSON the renderer sent (`unknown`).

use jscompat::node_path::host::is_absolute;
use jscompat::trim;
use serde_json::{Map, Value};

use super::generate_api::{
    AI_TARGET_KINDS, AiTargetKind, CONVERT_KINDS, ConvertKind, GenerateMode, GenerateRequest,
    RequestKind, ai_target_str, convert_kind_str, parse_convert_kind,
};
use super::limits::{MAX_MATERIALS, MAX_REQUEST_TEXT_CHARS};
use super::materials::{MaterialStatus, ext_of, material_key, summarize_materials};
use crate::packages::electron_utils::generate_handoff::GenerateHandoffTarget;
use crate::shell::renderer_disposal::Failure;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestShapeError {
    BadMode,
    BadKind,
    NoMaterial,
    TooMany,
    BadPath,
    BadText,
    ConvertNeedsOne,
    ConvertSourceMismatch,
}

impl RequestShapeError {
    pub fn as_str(self) -> &'static str {
        match self {
            RequestShapeError::BadMode => "bad-mode",
            RequestShapeError::BadKind => "bad-kind",
            RequestShapeError::NoMaterial => "no-material",
            RequestShapeError::TooMany => "too-many",
            RequestShapeError::BadPath => "bad-path",
            RequestShapeError::BadText => "bad-text",
            RequestShapeError::ConvertNeedsOne => "convert-needs-one",
            RequestShapeError::ConvertSourceMismatch => "convert-source-mismatch",
        }
    }
}

/// `isAiTargetKind(value)`
pub fn is_ai_target_kind(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| {
        AI_TARGET_KINDS
            .iter()
            .any(|kind| ai_target_str(*kind) == text)
    })
}

/// `isConvertKind(value)`
pub fn is_convert_kind(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|text| {
        CONVERT_KINDS
            .iter()
            .any(|kind| convert_kind_str(*kind) == text)
    })
}

/// 8.6: the one source type each conversion reads
fn convert_source_exts(kind: ConvertKind) -> &'static [&'static str] {
    match kind {
        ConvertKind::MindmapToMarkdown | ConvertKind::MindmapToSlides => &["xmind"],
        ConvertKind::MarkdownToMindmap => &["md", "markdown"],
    }
}

/// 8.6: the conversions a material list allows: only when there is exactly
/// one material and its type is the conversion's source.
pub fn available_conversions(material_paths: &[String]) -> Vec<ConvertKind> {
    if material_paths.len() != 1 {
        return Vec::new();
    }
    let ext = ext_of(&material_paths[0]);
    CONVERT_KINDS
        .iter()
        .copied()
        .filter(|kind| convert_source_exts(*kind).contains(&ext.as_str()))
        .collect()
}

/// Shape check: mode and kind go together, at least one and at most
/// `MAX_MATERIALS` absolute paths (duplicates folded), text only for `ai`.
/// Whether each file can actually be read is `prepare_generate_request`'s job.
pub fn validate_generate_request(raw: &Value) -> Result<GenerateRequest, RequestShapeError> {
    let empty = Map::new();
    let input = raw.as_object().unwrap_or(&empty);
    let mode = match input.get("mode").and_then(Value::as_str) {
        Some("ai") => GenerateMode::Ai,
        Some("convert") => GenerateMode::Convert,
        _ => return Err(RequestShapeError::BadMode),
    };
    let kind = input.get("kind");
    let kind_ok = match mode {
        GenerateMode::Ai => is_ai_target_kind(kind),
        GenerateMode::Convert => is_convert_kind(kind),
    };
    if !kind_ok {
        return Err(RequestShapeError::BadKind);
    }
    let Some(listed) = input
        .get("materials")
        .and_then(Value::as_array)
        .filter(|list| !list.is_empty())
    else {
        return Err(RequestShapeError::NoMaterial);
    };
    let mut materials: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for path in listed {
        let Some(path) = path.as_str() else {
            return Err(RequestShapeError::BadPath);
        };
        if path.is_empty() || path.encode_utf16().count() > 4096 || !is_absolute(path) {
            return Err(RequestShapeError::BadPath);
        }
        let key = material_key(path);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        materials.push(path.to_owned());
    }
    if materials.len() > MAX_MATERIALS {
        return Err(RequestShapeError::TooMany);
    }
    // `input.text ?? ''`
    let text = match input.get("text") {
        None | Some(Value::Null) => "",
        Some(Value::String(text)) => text.as_str(),
        Some(_) => return Err(RequestShapeError::BadText),
    };
    if text.encode_utf16().count() > MAX_REQUEST_TEXT_CHARS {
        return Err(RequestShapeError::BadText);
    }
    let request_kind = match mode {
        GenerateMode::Ai => {
            let text = kind.and_then(Value::as_str).unwrap_or_default();
            RequestKind::Ai(GenerateHandoffTarget::parse(text).expect("the kind was checked above"))
        }
        GenerateMode::Convert => {
            let text = kind.and_then(Value::as_str).unwrap_or_default();
            RequestKind::Convert(parse_convert_kind(text).expect("the kind was checked above"))
        }
    };
    if mode == GenerateMode::Convert {
        if !trim(text).is_empty() {
            return Err(RequestShapeError::BadText);
        }
        if materials.len() != 1 {
            return Err(RequestShapeError::ConvertNeedsOne);
        }
        let RequestKind::Convert(convert) = request_kind else {
            unreachable!("a conversion request has a conversion kind");
        };
        if !available_conversions(&materials).contains(&convert) {
            return Err(RequestShapeError::ConvertSourceMismatch);
        }
    }
    Ok(GenerateRequest {
        mode,
        kind: request_kind,
        materials,
        text: text.to_owned(),
    })
}

/// `PrepareError`: a shape error, or one of the two this step adds
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrepareError {
    Shape(RequestShapeError),
    NoReadableMaterial,
    UnsavedMaterial,
}

impl PrepareError {
    pub fn as_str(self) -> &'static str {
        match self {
            PrepareError::Shape(error) => error.as_str(),
            PrepareError::NoReadableMaterial => "no-readable-material",
            PrepareError::UnsavedMaterial => "unsaved-material",
        }
    }
}

/// What `prepareGenerateRequest` answers.
#[derive(Debug, Clone, PartialEq)]
pub enum Prepared {
    Ready {
        request: GenerateRequest,
        ready: Vec<MaterialStatus>,
        excluded: Vec<MaterialStatus>,
    },
    Refused {
        error: PrepareError,
        unsaved: Option<Vec<MaterialStatus>>,
        excluded: Option<Vec<MaterialStatus>>,
    },
}

impl Prepared {
    /// the TypeScript object, its keys in the order of the literals
    pub fn to_value(&self) -> Value {
        let list = |items: &[MaterialStatus]| {
            Value::Array(items.iter().map(MaterialStatus::to_value).collect())
        };
        let mut out = Map::new();
        match self {
            Prepared::Ready {
                request,
                ready,
                excluded,
            } => {
                out.insert("ok".to_owned(), Value::Bool(true));
                out.insert(
                    "request".to_owned(),
                    serde_json::to_value(request).expect("a request prints"),
                );
                out.insert("ready".to_owned(), list(ready));
                out.insert("excluded".to_owned(), list(excluded));
            }
            Prepared::Refused {
                error,
                unsaved,
                excluded,
            } => {
                out.insert("ok".to_owned(), Value::Bool(false));
                out.insert("error".to_owned(), Value::from(error.as_str()));
                if let Some(unsaved) = unsaved {
                    out.insert("unsaved".to_owned(), list(unsaved));
                }
                if let Some(excluded) = excluded {
                    out.insert("excluded".to_owned(), list(excluded));
                }
            }
        }
        Value::Object(out)
    }
}

/// `prepareGenerateRequest(raw, inspect)`: the request as it may go ahead:
/// the shape is valid, every material was read again just now, the unreadable
/// ones are left out (with their reasons), and nothing is open with unsaved
/// changes. Applies to `ai` and `convert`.
///
/// `Promise.all`: every material is inspected, and the first rejection (in
/// the order of the list) is the answer.
pub fn prepare_generate_request(
    raw: &Value,
    inspect: &mut dyn FnMut(&str) -> Result<MaterialStatus, Failure>,
) -> Result<Prepared, Failure> {
    let request = match validate_generate_request(raw) {
        Ok(request) => request,
        Err(error) => {
            return Ok(Prepared::Refused {
                error: PrepareError::Shape(error),
                unsaved: None,
                excluded: None,
            });
        }
    };
    let mut statuses: Vec<MaterialStatus> = Vec::new();
    let mut failure: Option<Failure> = None;
    for path in &request.materials {
        match inspect(path) {
            Ok(status) => statuses.push(status),
            Err(error) => {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
    }
    if let Some(error) = failure {
        return Err(error);
    }
    let kind_for_notices: AiTargetKind = match request.kind {
        RequestKind::Ai(kind) => kind,
        RequestKind::Convert(_) => AiTargetKind::Mindmap,
    };
    let summary = summarize_materials(&statuses, kind_for_notices);
    if !summary.unsaved.is_empty() {
        return Ok(Prepared::Refused {
            error: PrepareError::UnsavedMaterial,
            unsaved: Some(summary.unsaved),
            excluded: Some(summary.excluded),
        });
    }
    if summary.ready.is_empty() {
        return Ok(Prepared::Refused {
            error: PrepareError::NoReadableMaterial,
            unsaved: None,
            excluded: Some(summary.excluded),
        });
    }
    let materials = summary
        .ready
        .iter()
        .map(|s| s.path.clone().unwrap_or_default())
        .collect();
    Ok(Prepared::Ready {
        request: GenerateRequest {
            materials,
            ..request
        },
        ready: summary.ready,
        excluded: summary.excluded,
    })
}
