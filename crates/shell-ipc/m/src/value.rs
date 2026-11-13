//! Moving between the IPC value and the JSON values `main-core` takes.
//! `main-core` ports hold what TypeScript typed as `unknown` either as
//! jscompat's `JsonValue` (key order as `JSON.parse` keeps it) or as
//! `serde_json::Value`; a handler converts at the boundary and nowhere else.

use jscompat::{JsObject, JsonValue};
use shell_contract::IpcValue;

/// `JSON.stringify` semantics: `undefined` is `None` (a dropped key, or
/// `null` inside an array); bytes and dates, which no JSON-taking port
/// receives, become `null`, and non-finite numbers `null` as JSON writes them
pub fn to_json(value: &IpcValue) -> Option<JsonValue> {
    Some(match value {
        IpcValue::Undefined => return None,
        IpcValue::Null | IpcValue::Bytes(..) | IpcValue::Date(_) => JsonValue::Null,
        IpcValue::Bool(b) => JsonValue::Bool(*b),
        IpcValue::Number(n) if n.is_finite() => JsonValue::Number(*n),
        IpcValue::Number(_) => JsonValue::Null,
        IpcValue::String(s) => JsonValue::String(s.clone()),
        IpcValue::Array(items) => JsonValue::Array(
            items
                .iter()
                .map(|item| to_json(item).unwrap_or(JsonValue::Null))
                .collect(),
        ),
        IpcValue::Object(entries) => {
            let mut object = JsObject::new();
            for (key, item) in entries {
                if let Some(item) = to_json(item) {
                    object.set(key.clone(), item);
                }
            }
            JsonValue::Object(object)
        }
    })
}

#[cfg(test)]
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

/// As [`to_json`], into `serde_json` (built with `preserve_order`)
pub fn to_serde(value: &IpcValue) -> Option<serde_json::Value> {
    use serde_json::Value;
    Some(match value {
        IpcValue::Undefined => return None,
        IpcValue::Null | IpcValue::Bytes(..) | IpcValue::Date(_) => Value::Null,
        IpcValue::Bool(b) => Value::Bool(*b),
        IpcValue::Number(n) => serde_json::Number::from_f64(*n).map_or(Value::Null, Value::Number),
        IpcValue::String(s) => Value::String(s.clone()),
        IpcValue::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| to_serde(item).unwrap_or(Value::Null))
                .collect(),
        ),
        IpcValue::Object(entries) => Value::Object(
            entries
                .iter()
                .filter_map(|(k, v)| to_serde(v).map(|v| (k.clone(), v)))
                .collect(),
        ),
    })
}

pub fn from_serde(value: &serde_json::Value) -> IpcValue {
    use serde_json::Value;
    match value {
        Value::Null => IpcValue::Null,
        Value::Bool(b) => IpcValue::Bool(*b),
        Value::Number(n) => IpcValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => IpcValue::String(s.clone()),
        Value::Array(items) => IpcValue::Array(items.iter().map(from_serde).collect()),
        Value::Object(map) => IpcValue::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), from_serde(v)))
                .collect(),
        ),
    }
}

/// The `i`th argument; a missing one is `undefined`, as in JavaScript
pub fn arg(args: &[IpcValue], i: usize) -> &IpcValue {
    args.get(i).unwrap_or(&IpcValue::Undefined)
}

/// `typeof v === 'string'`
pub fn as_str(value: &IpcValue) -> Option<&str> {
    match value {
        IpcValue::String(s) => Some(s),
        _ => None,
    }
}

/// `typeof v === 'number'`
pub fn as_number(value: &IpcValue) -> Option<f64> {
    match value {
        IpcValue::Number(n) => Some(*n),
        _ => None,
    }
}

/// `v[key]` of an object; `undefined` for anything else or a missing key
pub fn field<'a>(value: &'a IpcValue, key: &str) -> &'a IpcValue {
    match value {
        IpcValue::Object(entries) => entries
            .iter()
            .find(|(k, _)| k == key)
            .map_or(&IpcValue::Undefined, |(_, v)| v),
        _ => &IpcValue::Undefined,
    }
}

/// `typeof v === 'object' && v !== null` (arrays included, as in JavaScript)
pub fn is_object(value: &IpcValue) -> bool {
    matches!(value, IpcValue::Object(_) | IpcValue::Array(_))
}

pub fn string(s: impl Into<String>) -> IpcValue {
    IpcValue::String(s.into())
}

/// An object literal, keys in the order written
pub fn object<const N: usize>(entries: [(&str, IpcValue); N]) -> IpcValue {
    IpcValue::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    )
}

pub fn strings<S: AsRef<str>>(items: impl IntoIterator<Item = S>) -> IpcValue {
    IpcValue::Array(
        items
            .into_iter()
            .map(|s| IpcValue::String(s.as_ref().to_owned()))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn undefined_drops_an_object_key_and_is_null_in_an_array() {
        let value = IpcValue::Object(vec![
            ("a".into(), IpcValue::Undefined),
            (
                "b".into(),
                IpcValue::Array(vec![IpcValue::Undefined, IpcValue::Number(f64::NAN)]),
            ),
        ]);
        let json = to_json(&value).unwrap();
        assert_eq!(
            from_json(&json),
            object([("b", IpcValue::Array(vec![IpcValue::Null, IpcValue::Null]))])
        );
        assert_eq!(
            to_serde(&value).unwrap(),
            serde_json::json!({ "b": [null, null] })
        );
    }

    #[test]
    fn keys_keep_their_order_both_ways() {
        let value = object([("z", IpcValue::Number(1.0)), ("a", string("x"))]);
        assert_eq!(from_json(&to_json(&value).unwrap()), value);
        assert_eq!(from_serde(&to_serde(&value).unwrap()), value);
    }
}
