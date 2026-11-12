//! `apps/pdf/src/main/signature-store.ts`: the reusable signatures persisted
//! in userData. A signature's data stays the value the file or the renderer
//! gave (keys and key order included), so it is a [`JsonValue`].

use super::node_io::{read_file_bytes, write_file_mode};
use crate::node_fs::{NodeError, namespaced, node_error, node_error2};
use jscompat::node_path::host;
use jscompat::{JsonValue, json_parse, json_stringify, random_uuid};
use std::fs;

/// Oldest entries are evicted beyond this; keeps the userData JSON bounded
pub const MAX_SAVED_SIGNATURES: usize = 10;

/// `SavedSignature`
#[derive(Debug, Clone, PartialEq)]
pub struct SavedSignature {
    pub id: String,
    pub created_at: f64,
    pub data: JsonValue,
}

fn is_finite_dim(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::Number(x)) if x.is_finite() && *x > 0.0)
}

/// `value[key]` of an object, an array or a string (`None` is `undefined`)
fn field<'a>(value: &'a JsonValue, key: &str) -> Option<std::borrow::Cow<'a, JsonValue>> {
    value.get(key)
}

/// Runtime validation for IPC payloads and for entries read back from disk
pub fn is_signature_data(value: &JsonValue) -> bool {
    // `typeof value !== 'object' || value === null`
    if !matches!(value, JsonValue::Object(_) | JsonValue::Array(_)) {
        return false;
    }
    if !is_finite_dim(field(value, "width").as_deref())
        || !is_finite_dim(field(value, "height").as_deref())
    {
        return false;
    }
    match field(value, "kind").as_deref() {
        Some(JsonValue::String(kind)) if kind == "image" => {
            matches!(field(value, "image").as_deref(), Some(JsonValue::String(image)) if !image.is_empty())
        }
        Some(JsonValue::String(kind)) if kind == "strokes" => {
            let paths = field(value, "paths");
            let Some(JsonValue::Array(paths)) = paths.as_deref() else {
                return false;
            };
            !paths.is_empty()
                && paths.iter().all(|p| match p {
                    JsonValue::Array(points) => {
                        // an odd-length path pairs a coordinate with undefined and writes NaN into the InkList
                        points.len() >= 4
                            && points.len() % 2 == 0
                            && points
                                .iter()
                                .all(|n| matches!(n, JsonValue::Number(x) if x.is_finite()))
                    }
                    _ => false,
                })
        }
        _ => false,
    }
}

/// Drop malformed entries (hand-edited file, older formats) instead of failing the whole list
pub fn sanitize_signatures(raw: &JsonValue) -> Vec<SavedSignature> {
    let JsonValue::Array(entries) = raw else {
        return Vec::new();
    };
    let mut out: Vec<SavedSignature> = Vec::new();
    for entry in entries {
        if !matches!(entry, JsonValue::Object(_) | JsonValue::Array(_)) {
            continue;
        }
        let Some(JsonValue::String(id)) = field(entry, "id").as_deref().cloned() else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        let data = field(entry, "data");
        let Some(data) = data.as_deref() else {
            continue;
        };
        if !is_signature_data(data) {
            continue;
        }
        if out.iter().any(|s| s.id == id) {
            continue;
        }
        let created_at = match field(entry, "createdAt").as_deref() {
            Some(JsonValue::Number(x)) if x.is_finite() => *x,
            _ => 0.0,
        };
        out.push(SavedSignature {
            id,
            created_at,
            data: data.clone(),
        });
    }
    out
}

/// Same payload = same signature: re-saving refreshes its position instead of duplicating
fn same_data(a: &JsonValue, b: &JsonValue) -> bool {
    let kind = |v: &JsonValue| match field(v, "kind").as_deref() {
        Some(JsonValue::String(k)) => Some(k.clone()),
        _ => None,
    };
    let (ka, kb) = (kind(a), kind(b));
    // `a.kind !== b.kind`: an absent kind equals an absent kind
    let number = |v: &JsonValue, key: &str| match field(v, key).as_deref() {
        Some(JsonValue::Number(x)) => Some(*x),
        _ => None,
    };
    // `undefined === undefined` holds, NaN === NaN does not
    let same_number = |x: Option<f64>, y: Option<f64>| match (x, y) {
        (Some(x), Some(y)) => x == y,
        (None, None) => true,
        _ => false,
    };
    if ka != kb
        || !same_number(number(a, "width"), number(b, "width"))
        || !same_number(number(a, "height"), number(b, "height"))
    {
        return false;
    }
    match ka.as_deref() {
        Some("image") => {
            matches!(
                (field(a, "image").as_deref(), field(b, "image").as_deref()),
                (Some(JsonValue::String(x)), Some(JsonValue::String(y))) if x == y
            )
        }
        Some("strokes") => {
            let (pa, pb) = (field(a, "paths"), field(b, "paths"));
            let (Some(JsonValue::Array(pa)), Some(JsonValue::Array(pb))) =
                (pa.as_deref(), pb.as_deref())
            else {
                return false;
            };
            pa.len() == pb.len()
                && pa.iter().zip(pb).all(|(p, q)| match (p, q) {
                    (JsonValue::Array(p), JsonValue::Array(q)) => {
                        p.len() == q.len()
                            && p.iter().zip(q).all(|(x, y)| {
                                matches!((x, y), (JsonValue::Number(x), JsonValue::Number(y)) if x == y)
                            })
                    }
                    _ => false,
                })
        }
        _ => false,
    }
}

/// Prepend a signature (newest first), dedupe identical payloads, cap the list size
pub fn add_signature(list: &[SavedSignature], data: &JsonValue, now: f64) -> Vec<SavedSignature> {
    let mut out = vec![SavedSignature {
        id: random_uuid(),
        created_at: now,
        data: data.clone(),
    }];
    out.extend(list.iter().filter(|s| !same_data(&s.data, data)).cloned());
    out.truncate(MAX_SAVED_SIGNATURES);
    out
}

pub fn remove_signature(list: &[SavedSignature], id: &str) -> Vec<SavedSignature> {
    list.iter().filter(|s| s.id != id).cloned().collect()
}

/// Missing or unreadable file is just an empty list; a broken JSON must not break signing
pub fn load_signatures(file_path: &str) -> Vec<SavedSignature> {
    let Ok(bytes) = read_file_bytes(file_path) else {
        return Vec::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    match json_parse(&text) {
        Ok(raw) => sanitize_signatures(&raw),
        Err(_) => Vec::new(),
    }
}

/// `JSON.stringify(list)`: a signature is `{ id, createdAt, data }`
fn list_json(list: &[SavedSignature]) -> String {
    let items = list
        .iter()
        .map(|s| {
            let mut object = jscompat::JsObject::new();
            object.set("id", JsonValue::String(s.id.clone()));
            object.set("createdAt", JsonValue::Number(s.created_at));
            object.set("data", s.data.clone());
            JsonValue::Object(object)
        })
        .collect();
    json_stringify(&JsonValue::Array(items))
}

/// Atomic write (tmp + rename) so a crash mid-write can't corrupt the saved list;
/// `pid` is `process.pid`
pub fn save_signatures(
    file_path: &str,
    list: &[SavedSignature],
    pid: u32,
) -> Result<(), NodeError> {
    let dir = host::dirname(file_path);
    fs::create_dir_all(namespaced(&dir)).map_err(|e| node_error(&e, "mkdir", &dir))?;
    let tmp = format!("{file_path}.{pid}.tmp");
    write_file_mode(&tmp, &list_json(list), 0o666)?;
    fs::rename(namespaced(&tmp), namespaced(file_path))
        .map_err(|e| node_error2(&e, "rename", &tmp, file_path))
}
