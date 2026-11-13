//! `apps/shell/src/main/file-index/extract-worker.ts`: the worker-thread entry
//! where text extraction and directory walks run so a slow PDF or a stalled
//! network folder never blocks the main process. The `parentPort` message loop
//! stays with the host (the thread, `postMessage`, the `old-names-env`
//! import); [`handle_message`] is what it does per message.

use serde_json::{Map, Number, Value};

use super::extract::{Extracted, FileParser, extract_text};
use super::scan::{ScanLimits, ScannedFile, scan_files};

/// `WorkerRequest`
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerRequest {
    Extract { id: f64, path: String },
    Scan { id: f64, root: String },
}

/// `WorkerResponse`
#[derive(Debug, Clone, PartialEq)]
pub enum WorkerResponse {
    Extract {
        id: f64,
        result: Extracted,
    },
    Scan {
        id: f64,
        files: Vec<ScannedFile>,
        truncated: bool,
    },
}

fn number(id: f64) -> Value {
    Number::from_f64(id).map_or(Value::Null, Value::Number)
}

impl WorkerResponse {
    /// the object `postMessage` sends, its keys in the order the literal writes them
    pub fn to_value(&self) -> Value {
        let mut out = Map::new();
        match self {
            WorkerResponse::Extract { id, result } => {
                out.insert("id".into(), number(*id));
                out.insert("type".into(), Value::from("extract"));
                out.insert("result".into(), result.to_value());
            }
            WorkerResponse::Scan {
                id,
                files,
                truncated,
            } => {
                out.insert("id".into(), number(*id));
                out.insert("type".into(), Value::from("scan"));
                out.insert(
                    "files".into(),
                    serde_json::to_value(files).expect("scanned files serialize"),
                );
                out.insert("truncated".into(), Value::Bool(*truncated));
            }
        }
        Value::Object(out)
    }
}

/// The `parentPort.on('message', ...)` handler: the answer to post for one request.
pub fn handle_message(request: &WorkerRequest, parser: &mut dyn FileParser) -> WorkerResponse {
    match request {
        WorkerRequest::Extract { id, path } => WorkerResponse::Extract {
            id: *id,
            result: extract_text(path, parser),
        },
        WorkerRequest::Scan { id, root } => {
            let result = scan_files(root, &ScanLimits::default());
            WorkerResponse::Scan {
                id: *id,
                files: result.files,
                truncated: result.truncated,
            }
        }
    }
}
