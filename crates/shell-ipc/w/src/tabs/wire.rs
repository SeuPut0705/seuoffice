//! `serde_json::Value` (what `main-core`'s `to_value` methods build) to the
//! shell's [`IpcValue`], and the `typeof` checks of the TypeScript handlers.

use serde_json::Value;
use shell_contract::value::IpcValue;

/// A JSON value as the structured clone would carry it
pub(super) fn to_ipc(value: &Value) -> IpcValue {
    match value {
        Value::Null => IpcValue::Null,
        Value::Bool(b) => IpcValue::Bool(*b),
        Value::Number(n) => IpcValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => IpcValue::String(s.clone()),
        Value::Array(items) => IpcValue::Array(items.iter().map(to_ipc).collect()),
        Value::Object(map) => {
            IpcValue::Object(map.iter().map(|(k, v)| (k.clone(), to_ipc(v))).collect())
        }
    }
}

/// `typeof v === 'string'`
pub(super) fn string(v: Option<&IpcValue>) -> Option<&str> {
    match v {
        Some(IpcValue::String(s)) => Some(s),
        _ => None,
    }
}

/// `typeof v === 'number'`
pub(super) fn number(v: Option<&IpcValue>) -> Option<f64> {
    match v {
        Some(IpcValue::Number(n)) => Some(*n),
        _ => None,
    }
}

/// `typeof v === 'number' && Number.isFinite(v)`
pub(super) fn finite(v: Option<&IpcValue>) -> Option<f64> {
    number(v).filter(|n| n.is_finite())
}

/// `Number.isInteger(v)`
pub(super) fn integer(v: Option<&IpcValue>) -> Option<f64> {
    finite(v).filter(|n| n.fract() == 0.0)
}
