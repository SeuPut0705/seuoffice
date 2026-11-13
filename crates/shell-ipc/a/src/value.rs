//! IPC values to and from `main-core`'s JSON values, which hold what the
//! TypeScript handlers saw as plain objects. `undefined` is `None` at the top
//! and, as `JSON.stringify` writes it, dropped from objects and `null` in
//! arrays. Bytes and dates have no JSON form; a handler that takes them reads
//! the `IpcValue` itself.

use jscompat::{JsObject, JsonValue};
use shell_contract::IpcValue;

/// One argument as `main-core` takes it: `None` for `undefined` or a value
/// JSON cannot hold
pub fn to_json(value: &IpcValue) -> Option<JsonValue> {
    Some(match value {
        IpcValue::Undefined | IpcValue::Bytes(..) | IpcValue::Date(_) => return None,
        IpcValue::Null => JsonValue::Null,
        IpcValue::Bool(b) => JsonValue::Bool(*b),
        IpcValue::Number(n) => JsonValue::Number(*n),
        IpcValue::String(s) => JsonValue::String(s.clone()),
        IpcValue::Array(items) => JsonValue::Array(
            items
                .iter()
                .map(|item| to_json(item).unwrap_or(JsonValue::Null))
                .collect(),
        ),
        IpcValue::Object(entries) => JsonValue::Object(
            entries
                .iter()
                .filter_map(|(k, v)| Some((k.clone(), to_json(v)?)))
                .collect::<JsObject<JsonValue>>(),
        ),
    })
}

/// The `index`th argument, `None` when absent or `undefined`
pub fn arg(args: &[IpcValue], index: usize) -> Option<JsonValue> {
    args.get(index).and_then(to_json)
}

/// A `main-core` answer as the renderer receives it
pub fn from_json(value: &JsonValue) -> IpcValue {
    match value {
        JsonValue::Null => IpcValue::Null,
        JsonValue::Bool(b) => IpcValue::Bool(*b),
        JsonValue::Number(n) => IpcValue::Number(*n),
        JsonValue::String(s) => IpcValue::String(s.clone()),
        JsonValue::Array(items) => IpcValue::Array(items.iter().map(from_json).collect()),
        JsonValue::Object(object) => IpcValue::Object(
            object
                .entries()
                .into_iter()
                .map(|(k, v)| (k.to_owned(), from_json(v)))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undefined_leaves_objects_and_is_null_in_arrays() {
        let value = IpcValue::Object(vec![
            ("a".into(), IpcValue::Undefined),
            (
                "b".into(),
                IpcValue::Array(vec![IpcValue::Undefined, IpcValue::Number(1.0)]),
            ),
        ]);
        let json = to_json(&value).unwrap();
        assert_eq!(
            from_json(&json),
            IpcValue::Object(vec![(
                "b".into(),
                IpcValue::Array(vec![IpcValue::Null, IpcValue::Number(1.0)])
            )])
        );
        assert_eq!(to_json(&IpcValue::Undefined), None);
    }
}
