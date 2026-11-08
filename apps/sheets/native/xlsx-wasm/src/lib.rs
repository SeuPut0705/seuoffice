//! Browser entry point of the xlsx engine, built for wasm32-wasip1 as a reactor.
//!
//! The host (a Web Worker) writes the workbook into a preopened directory and
//! then sends the same JSON requests the desktop sidecar speaks, one buffer in
//! and one buffer out. Only the commands the web viewer needs are answered.

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use xlsx_sidecar::{CellRange, SidecarError, WorkbookSessions};

const PROTOCOL_VERSION: u8 = 1;

fn default_locale() -> String {
    "zh".to_owned()
}

#[derive(Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
enum Command {
    Open {
        path: PathBuf,
        #[serde(default = "default_locale")]
        locale: String,
        #[serde(default, rename = "shortDateFormat")]
        short_date_format: Option<String>,
    },
    ReadRange {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "sheetId")]
        sheet_id: String,
        range: CellRange,
    },
    Close {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    #[serde(other)]
    Unsupported,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    version: u8,
    request_id: String,
    #[serde(flatten)]
    command: Command,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    version: u8,
    request_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

impl Response {
    fn success(request_id: String, result: Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            request_id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    fn failure(request_id: String, code: &'static str, message: String) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            request_id,
            ok: false,
            result: None,
            error: Some(ErrorBody { code, message }),
        }
    }

    fn from_error(request_id: String, error: SidecarError) -> Self {
        let code = match error {
            SidecarError::InvalidRequest(_) => "invalid_request",
            SidecarError::Io(_) => "io_error",
            SidecarError::Workbook(_) => "workbook_error",
            SidecarError::Cancelled => "cancelled",
        };
        Self::failure(request_id, code, error.to_string())
    }
}

fn to_json_value<T: Serialize>(value: T) -> Result<Value, SidecarError> {
    serde_json::to_value(value).map_err(SidecarError::from)
}

thread_local! {
    static SESSIONS: RefCell<WorkbookSessions> = RefCell::new(WorkbookSessions::new());
}

fn handle(request: Request) -> Response {
    let request_id = request.request_id;
    if request.version != PROTOCOL_VERSION {
        return Response::failure(
            request_id,
            "unsupported_version",
            "Unsupported sidecar protocol version.".into(),
        );
    }
    let command = match request.command {
        Command::Unsupported => {
            return Response::failure(
                request_id,
                "unsupported_on_web",
                "This command is not available in the web build.".into(),
            );
        }
        command => command,
    };
    let result = SESSIONS.with(|sessions| {
        let mut sessions = sessions.borrow_mut();
        match command {
            Command::Open {
                path,
                locale,
                short_date_format,
            } => sessions
                .open_with_locale(
                    &path,
                    &locale,
                    short_date_format.as_deref(),
                    &AtomicBool::new(false),
                )
                .and_then(to_json_value),
            Command::ReadRange {
                session_id,
                sheet_id,
                range,
            } => sessions
                .read_range(&session_id, &sheet_id, &range)
                .and_then(to_json_value),
            Command::Close { session_id } => sessions
                .close(&session_id)
                .and_then(|()| to_json_value(serde_json::json!({ "closed": true }))),
            Command::Unsupported => unreachable!("rejected above"),
        }
    });
    match result {
        Ok(value) => Response::success(request_id, value),
        Err(error) => Response::from_error(request_id, error),
    }
}

fn respond(input: &[u8]) -> Response {
    match serde_json::from_slice::<Request>(input) {
        Ok(request) => handle(request),
        Err(error) => Response::failure(String::new(), "invalid_request", error.to_string()),
    }
}

/// Hands the host a buffer of `len` bytes to fill before calling `seu_call`.
#[unsafe(no_mangle)]
pub extern "C" fn seu_alloc(len: u32) -> *mut u8 {
    Box::into_raw(vec![0u8; len as usize].into_boxed_slice()).cast::<u8>()
}

/// Releases a buffer from `seu_alloc` or a response from `seu_call`, with the same length.
///
/// # Safety
/// `ptr` and `len` must be exactly a pointer and length this module handed out, freed once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn seu_free(ptr: *mut u8, len: u32) {
    drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len as usize)) });
}

/// Runs one JSON request and returns `(response pointer << 32) | response length`.
///
/// # Safety
/// `ptr` and `len` must describe a readable buffer, normally one from `seu_alloc`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn seu_call(ptr: *const u8, len: u32) -> u64 {
    let input = unsafe { std::slice::from_raw_parts(ptr, len as usize) };
    let body = serde_json::to_vec(&respond(input)).unwrap_or_else(|_| b"{}".to_vec());
    let length = body.len() as u64;
    let pointer = Box::into_raw(body.into_boxed_slice()).cast::<u8>() as usize as u64;
    (pointer << 32) | length
}
