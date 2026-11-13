//! `@modelcontextprotocol/sdk` 1.32.1 `types.js`: the protocol versions, the
//! error codes, `McpError` and the JSON-RPC envelopes `shared/protocol.js`
//! writes, with their keys in the order the TypeScript writes them.

use jscompat::{JsObject, JsonValue, number_to_string};

pub const JSONRPC_VERSION: &str = "2.0";
pub const LATEST_PROTOCOL_VERSION: &str = "2025-11-25";
pub const DEFAULT_NEGOTIATED_PROTOCOL_VERSION: &str = "2025-03-26";
pub const SUPPORTED_PROTOCOL_VERSIONS: [&str; 5] = [
    LATEST_PROTOCOL_VERSION,
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];

/// `ErrorCode`
pub mod error_code {
    pub const CONNECTION_CLOSED: f64 = -32000.0;
    pub const REQUEST_TIMEOUT: f64 = -32001.0;
    pub const PARSE_ERROR: f64 = -32700.0;
    pub const INVALID_REQUEST: f64 = -32600.0;
    pub const METHOD_NOT_FOUND: f64 = -32601.0;
    pub const INVALID_PARAMS: f64 = -32602.0;
    pub const INTERNAL_ERROR: f64 = -32603.0;
    pub const URL_ELICITATION_REQUIRED: f64 = -32042.0;
}

/// `McpError`: `message` is the `Error`'s message, `MCP error ${code}:
/// ${message}`; `data` is `undefined` when `None`.
#[derive(Debug, Clone, PartialEq)]
pub struct McpError {
    pub code: f64,
    pub message: String,
    pub data: Option<JsonValue>,
}

impl McpError {
    /// `new McpError(code, message, data)`
    pub fn new(code: f64, message: &str, data: Option<JsonValue>) -> Self {
        McpError {
            code,
            message: format!("MCP error {}: {message}", number_to_string(code)),
            data,
        }
    }
}

fn object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut out = JsObject::new();
    for (key, value) in entries {
        out.set(key, value);
    }
    JsonValue::Object(out)
}

/// The answer to a request: `{ result, jsonrpc: '2.0', id }`
pub fn result_response(id: JsonValue, result: JsonValue) -> JsonValue {
    object(vec![
        ("result", result),
        ("jsonrpc", JsonValue::String(JSONRPC_VERSION.into())),
        ("id", id),
    ])
}

/// The error answer to a request: `{ jsonrpc: '2.0', id, error: { code,
/// message, data? } }`
pub fn error_response(
    id: JsonValue,
    code: f64,
    message: &str,
    data: Option<JsonValue>,
) -> JsonValue {
    let mut error = vec![
        ("code", JsonValue::Number(code)),
        ("message", JsonValue::String(message.into())),
    ];
    if let Some(data) = data {
        error.push(("data", data));
    }
    object(vec![
        ("jsonrpc", JsonValue::String(JSONRPC_VERSION.into())),
        ("id", id),
        ("error", object(error)),
    ])
}

/// An outgoing request: `{ ...request, jsonrpc: '2.0', id }`, the request
/// being `{ method, params }` with `params` left out when `None`
pub fn request(method: &str, params: Option<JsonValue>, id: f64) -> JsonValue {
    let mut entries = vec![("method", JsonValue::String(method.into()))];
    if let Some(params) = params {
        entries.push(("params", params));
    }
    entries.push(("jsonrpc", JsonValue::String(JSONRPC_VERSION.into())));
    entries.push(("id", JsonValue::Number(id)));
    object(entries)
}

/// An outgoing notification: `{ ...notification, jsonrpc: '2.0' }`
pub fn notification(method: &str, params: Option<JsonValue>) -> JsonValue {
    let mut entries = vec![("method", JsonValue::String(method.into()))];
    if let Some(params) = params {
        entries.push(("params", params));
    }
    entries.push(("jsonrpc", JsonValue::String(JSONRPC_VERSION.into())));
    object(entries)
}
