//! `apps/shell/src/main/open-documents.ts`: `userData/open-documents.json`,
//! the files the running shell has open in tabs, for other processes.

use std::collections::HashSet;
use std::fs;

use jscompat::{json_to_string, random_uuid, string_less_than, to_iso_string};
use serde::Serialize;

use crate::node_fs::{NodeError, node_error, node_error2};

pub const OPEN_DOCUMENTS_FILE: &str = "open-documents.json";

/// `OpenDocumentsRegistry`: the keys in the order of the TypeScript literal.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct OpenDocumentsRegistry {
    pub pid: u32,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub paths: Vec<String>,
}

/// `new Date(ms).toISOString()` of an invalid time value throws this
/// `RangeError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidTime;

/// `reportedWriteErrors`: the write failures already warned about. The
/// TypeScript keeps one for the process; the caller keeps one here.
#[derive(Debug, Default)]
pub struct ReportedWriteErrors(HashSet<String>);

impl ReportedWriteErrors {
    pub fn new() -> Self {
        Self::default()
    }
}

/// `publishOpenDocuments(path, paths)`. `pid` is `process.pid` and `now_ms`
/// the clock of `new Date()`. `warn` is `console.warn` after its label: it
/// gets the error's message, once for each distinct error code (or message
/// where there is no code).
pub fn publish_open_documents(
    path: &str,
    paths: &[String],
    pid: u32,
    now_ms: f64,
    reported: &mut ReportedWriteErrors,
    warn: &mut dyn FnMut(&str),
) -> Result<bool, InvalidTime> {
    // `[...new Set(paths)].sort()`: the default sort compares UTF-16 code units
    let mut unique: Vec<String> = Vec::new();
    for item in paths {
        if !unique.contains(item) {
            unique.push(item.clone());
        }
    }
    unique.sort_by(|a, b| {
        if string_less_than(a, b) {
            std::cmp::Ordering::Less
        } else if string_less_than(b, a) {
            std::cmp::Ordering::Greater
        } else {
            std::cmp::Ordering::Equal
        }
    });
    let registry = OpenDocumentsRegistry {
        pid,
        updated_at: to_iso_string(now_ms).ok_or(InvalidTime)?,
        paths: unique,
    };
    let temp_path = format!("{path}.{pid}.{}.tmp", random_uuid());
    let written = (|| -> Result<(), NodeError> {
        let text = json_to_string(&registry).expect("a registry prints");
        fs::write(&temp_path, text).map_err(|e| node_error(&e, "open", &temp_path))?;
        fs::rename(&temp_path, path).map_err(|e| node_error2(&e, "rename", &temp_path, path))?;
        Ok(())
    })();
    match written {
        Ok(()) => Ok(true),
        Err(err) => {
            let _ = fs::remove_file(&temp_path);
            let key = err.code.map_or_else(|| err.message.clone(), str::to_owned);
            if reported.0.insert(key) {
                warn(&err.message);
            }
            Ok(false)
        }
    }
}

/// `clearOpenDocuments`
pub fn clear_open_documents(path: &str) {
    let _ = fs::remove_file(path);
}
