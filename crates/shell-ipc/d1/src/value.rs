//! Reading a handler's arguments and building its answer. The TypeScript
//! handlers read loosely typed arguments (`typeof x === 'string'`, a
//! property of something that may not be an object); these helpers read an
//! [`IpcValue`] the same way, and bridge to the `JsonValue` that `main-core`
//! functions take.

use jscompat::{JsObject, JsonValue};
use shell_contract::{BytesKind, IpcError, IpcValue};

static UNDEFINED: IpcValue = IpcValue::Undefined;

/// A handler's arguments after the `event`: `(event, a, b) => …` reads
/// `args.get(0)` and `args.get(1)`; a missing argument is `undefined`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Args(Vec<IpcValue>);

impl Args {
    pub fn new(values: Vec<IpcValue>) -> Self {
        Args(values)
    }

    pub fn get(&self, index: usize) -> &IpcValue {
        self.0.get(index).unwrap_or(&UNDEFINED)
    }

    /// the argument, `undefined` when missing
    pub fn take(&mut self, index: usize) -> IpcValue {
        match self.0.get_mut(index) {
            Some(value) => std::mem::replace(value, IpcValue::Undefined),
            None => IpcValue::Undefined,
        }
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `typeof args[index] === 'string' ? args[index] : null`
    pub fn str(&self, index: usize) -> Option<&str> {
        as_str(self.get(index))
    }

    /// `typeof args[index] === 'number' ? args[index] : null`
    pub fn num(&self, index: usize) -> Option<f64> {
        as_num(self.get(index))
    }

    /// `typeof args[index] === 'boolean' ? args[index] : null`
    pub fn bool(&self, index: usize) -> Option<bool> {
        as_bool(self.get(index))
    }
}

pub fn as_str(value: &IpcValue) -> Option<&str> {
    match value {
        IpcValue::String(text) => Some(text),
        _ => None,
    }
}

pub fn as_num(value: &IpcValue) -> Option<f64> {
    match value {
        IpcValue::Number(x) => Some(*x),
        _ => None,
    }
}

pub fn as_bool(value: &IpcValue) -> Option<bool> {
    match value {
        IpcValue::Bool(flag) => Some(*flag),
        _ => None,
    }
}

/// The bytes of an `ArrayBuffer`, a `Uint8Array` or a `Buffer`
pub fn as_bytes(value: &IpcValue) -> Option<&[u8]> {
    match value {
        IpcValue::Bytes(_, bytes) => Some(bytes),
        _ => None,
    }
}

/// `value.key` of an object, `undefined` otherwise. A read on `null` or
/// `undefined` throws in JavaScript; a handler that relies on that throw
/// checks [`is_nullish`] first.
pub fn field<'a>(value: &'a IpcValue, key: &str) -> &'a IpcValue {
    match value {
        IpcValue::Object(entries) => entries
            .iter()
            .find(|(name, _)| name == key)
            .map_or(&UNDEFINED, |(_, value)| value),
        _ => &UNDEFINED,
    }
}

pub fn is_nullish(value: &IpcValue) -> bool {
    matches!(value, IpcValue::Undefined | IpcValue::Null)
}

/// `!!value`
pub fn truthy(value: &IpcValue) -> bool {
    match value {
        IpcValue::Undefined | IpcValue::Null => false,
        IpcValue::Bool(flag) => *flag,
        IpcValue::Number(x) => *x != 0.0 && !x.is_nan(),
        IpcValue::String(text) => !text.is_empty(),
        IpcValue::Bytes(..) | IpcValue::Date(_) | IpcValue::Array(_) | IpcValue::Object(_) => true,
    }
}

/// An object literal, keys in the order written
pub fn obj<const N: usize>(entries: [(&str, IpcValue); N]) -> IpcValue {
    IpcValue::Object(
        entries
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

pub fn string(text: impl Into<String>) -> IpcValue {
    IpcValue::String(text.into())
}

pub fn num(x: f64) -> IpcValue {
    IpcValue::Number(x)
}

/// A main-side `Buffer`: the renderer receives a `Uint8Array`
pub fn buffer(bytes: Vec<u8>) -> IpcValue {
    IpcValue::Bytes(BytesKind::Uint8Array, bytes)
}

/// `value ?? null` of an optional answer
pub fn or_null(value: Option<IpcValue>) -> IpcValue {
    value.unwrap_or(IpcValue::Null)
}

/// `throw new Error(message)`
pub fn thrown(message: impl Into<String>) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: message.into(),
    }
}

/// `value` as `main-core` takes it. What JSON has no word for is decided as
/// a handler passing the object through would see it: an `undefined`
/// property is left out (reading it gives `undefined` either way), an
/// `undefined` array item is `null`; bytes and dates have no `JsonValue` and
/// make the whole conversion `None`, so a handler that meets them decides.
pub fn to_json(value: &IpcValue) -> Option<JsonValue> {
    Some(match value {
        IpcValue::Undefined | IpcValue::Null => JsonValue::Null,
        IpcValue::Bool(flag) => JsonValue::Bool(*flag),
        IpcValue::Number(x) => JsonValue::Number(*x),
        IpcValue::String(text) => JsonValue::String(text.clone()),
        IpcValue::Bytes(..) | IpcValue::Date(_) => return None,
        IpcValue::Array(items) => {
            JsonValue::Array(items.iter().map(to_json).collect::<Option<Vec<_>>>()?)
        }
        IpcValue::Object(entries) => {
            let mut object = JsObject::new();
            for (key, item) in entries {
                if !matches!(item, IpcValue::Undefined) {
                    object.set(key.clone(), to_json(item)?);
                }
            }
            JsonValue::Object(object)
        }
    })
}

/// A `main-core` answer as the renderer receives it
pub fn from_json(value: &JsonValue) -> IpcValue {
    match value {
        JsonValue::Null => IpcValue::Null,
        JsonValue::Bool(flag) => IpcValue::Bool(*flag),
        JsonValue::Number(x) => IpcValue::Number(*x),
        JsonValue::String(text) => IpcValue::String(text.clone()),
        JsonValue::Array(items) => IpcValue::Array(items.iter().map(from_json).collect()),
        JsonValue::Object(object) => IpcValue::Object(
            object
                .entries()
                .into_iter()
                .map(|(key, item)| (key.to_owned(), from_json(item)))
                .collect(),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_round_trip_drops_undefined_properties_and_refuses_bytes() {
        let value = obj([
            ("a", num(1.0)),
            ("gone", IpcValue::Undefined),
            (
                "list",
                IpcValue::Array(vec![IpcValue::Undefined, string("x")]),
            ),
        ]);
        let json = to_json(&value).unwrap();
        assert_eq!(
            from_json(&json),
            obj([
                ("a", num(1.0)),
                ("list", IpcValue::Array(vec![IpcValue::Null, string("x")])),
            ])
        );
        assert_eq!(to_json(&obj([("b", buffer(vec![1]))])), None);
    }

    #[test]
    fn missing_arguments_and_fields_read_as_undefined() {
        let args = Args::new(vec![string("p"), IpcValue::Null]);
        assert_eq!(args.str(0), Some("p"));
        assert_eq!(args.str(1), None);
        assert_eq!(args.get(5), &IpcValue::Undefined);
        assert_eq!(field(&IpcValue::Null, "x"), &IpcValue::Undefined);
        assert!(!truthy(&num(f64::NAN)));
        assert!(truthy(&IpcValue::Array(vec![])));
    }
}
