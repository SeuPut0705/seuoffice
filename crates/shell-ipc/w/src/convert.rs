//! What the handlers share to read the renderer's values and to rethrow
//! `main-core`'s errors as the TypeScript did.

use main_core::node_fs::NodeError;
use shell_contract::IpcValue;
use shell_contract::error::IpcError;

/// A Node file error as the handler rethrew it: `Error: <message>`
pub fn node_error(e: NodeError) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: e.message,
    }
}

/// `obj[key]` of a value the renderer sent, `undefined` when absent
pub fn field<'a>(value: &'a IpcValue, key: &str) -> Option<&'a IpcValue> {
    match value {
        IpcValue::Object(entries) => entries.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}
