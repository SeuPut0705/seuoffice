//! Values between the handlers and `main-core`: `main-core` speaks JSON
//! (`serde_json` for what it serializes, `jscompat` for what it inspects as
//! a JavaScript value), the IPC speaks [`IpcValue`].

use jscompat::{JsObject, JsonValue};
use serde::Serialize;
use shell_contract::{BytesKind, IpcValue};

/// A serialized `main-core` value as the renderer receives it
pub fn to_ipc(value: &impl Serialize) -> IpcValue {
    from_json(&serde_json::to_value(value).expect("main-core values serialize"))
}

fn from_json(value: &serde_json::Value) -> IpcValue {
    use serde_json::Value;
    match value {
        Value::Null => IpcValue::Null,
        Value::Bool(b) => IpcValue::Bool(*b),
        Value::Number(n) => IpcValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => IpcValue::String(s.clone()),
        Value::Array(items) => IpcValue::Array(items.iter().map(from_json).collect()),
        Value::Object(entries) => IpcValue::Object(
            entries
                .iter()
                .map(|(k, v)| (k.clone(), from_json(v)))
                .collect(),
        ),
    }
}

/// What a renderer sent, as the TypeScript checks it with `typeof`,
/// `Array.isArray` and `Object.entries`: `undefined` fails every check `null`
/// fails; a typed array is an object of its indices, an `ArrayBuffer` and a
/// `Date` objects without own keys.
pub fn to_js(value: &IpcValue) -> JsonValue {
    match value {
        IpcValue::Undefined | IpcValue::Null => JsonValue::Null,
        IpcValue::Bool(b) => JsonValue::Bool(*b),
        IpcValue::Number(n) => JsonValue::Number(*n),
        IpcValue::String(s) => JsonValue::String(s.clone()),
        IpcValue::Bytes(BytesKind::Uint8Array, bytes) => {
            let mut object = JsObject::new();
            for (i, byte) in bytes.iter().enumerate() {
                object.set(i.to_string(), JsonValue::Number(f64::from(*byte)));
            }
            JsonValue::Object(object)
        }
        IpcValue::Bytes(BytesKind::ArrayBuffer, _) | IpcValue::Date(_) => {
            JsonValue::Object(JsObject::new())
        }
        IpcValue::Array(items) => JsonValue::Array(items.iter().map(to_js).collect()),
        IpcValue::Object(entries) => {
            let mut object = JsObject::new();
            for (k, v) in entries {
                object.set(k.clone(), to_js(v));
            }
            JsonValue::Object(object)
        }
    }
}
