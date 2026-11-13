//! `IpcValue` and `serde_json::Value`, for the `main-core` functions that take the latter.

use serde_json::{Map, Number, Value};
use shell_contract::IpcValue;

/// `value` as JSON; bytes, dates and non-finite numbers have no JSON form
pub fn ipc_to_serde(value: &IpcValue) -> Option<Value> {
    Some(match value {
        IpcValue::Undefined | IpcValue::Null => Value::Null,
        IpcValue::Bool(flag) => Value::Bool(*flag),
        IpcValue::Number(x) => number(*x)?,
        IpcValue::String(text) => Value::String(text.clone()),
        IpcValue::Bytes(..) | IpcValue::Date(_) => return None,
        IpcValue::Array(items) => {
            Value::Array(items.iter().map(ipc_to_serde).collect::<Option<Vec<_>>>()?)
        }
        IpcValue::Object(entries) => {
            let mut map = Map::new();
            for (key, item) in entries {
                if !matches!(item, IpcValue::Undefined) {
                    map.insert(key.clone(), ipc_to_serde(item)?);
                }
            }
            Value::Object(map)
        }
    })
}

fn number(x: f64) -> Option<Value> {
    if !x.is_finite() {
        return None;
    }
    if x.fract() == 0.0 && x.abs() < 9.0e15 {
        return Some(Value::Number(Number::from(x as i64)));
    }
    Number::from_f64(x).map(Value::Number)
}

pub fn serde_to_ipc(value: &Value) -> IpcValue {
    match value {
        Value::Null => IpcValue::Null,
        Value::Bool(flag) => IpcValue::Bool(*flag),
        Value::Number(n) => IpcValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => IpcValue::String(text.clone()),
        Value::Array(items) => IpcValue::Array(items.iter().map(serde_to_ipc).collect()),
        Value::Object(map) => IpcValue::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), serde_to_ipc(item)))
                .collect(),
        ),
    }
}
