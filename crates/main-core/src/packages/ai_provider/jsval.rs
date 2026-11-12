//! Helpers the ported settings code shares: the reads and writes the
//! TypeScript does on plain objects and `unknown` values, over
//! [`JsonValue`].
//!
//! A key whose value is `undefined` is left out of an object here: the
//! comparison writes the objects with `JSON.stringify`, which leaves such a
//! key out as well. Where a key set later would take its place from an
//! `undefined` one, the caller says so.
//!
//! A plain assignment `table[id] = value` with `id` from data does not make
//! an own key when `id` is `__proto__` (it sets the prototype). [`assign`]
//! does the same: it skips that key.

use jscompat::{
    JsObject, JsTypeError, JsonValue, number_to_string, slice_utf16, to_primitive, trim,
};

/// `Record<string, unknown>` as a JSON object.
pub type Obj = JsObject<JsonValue>;

/// `isRecord(value)`: an object that is not an array and not `null`.
pub fn as_record(value: &JsonValue) -> Option<&Obj> {
    match value {
        JsonValue::Object(object) => Some(object),
        _ => None,
    }
}

/// `value.key` for an own key of an object; `None` is `undefined`, and it
/// is also what any other value answers for a name no prototype has.
pub fn prop<'a>(value: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    as_record(value).and_then(|object| object.get(key))
}

/// `value?.a?.b` over the two steps.
pub fn prop2<'a>(value: Option<&'a JsonValue>, a: &str, b: &str) -> Option<&'a JsonValue> {
    value.and_then(|v| prop(v, a)).and_then(|v| prop(v, b))
}

/// `value ?? other`: `null` and `undefined` both fall through.
pub fn coalesce<'a>(
    value: Option<&'a JsonValue>,
    other: Option<&'a JsonValue>,
) -> Option<&'a JsonValue> {
    match value {
        None | Some(JsonValue::Null) => other,
        some => some,
    }
}

/// `typeof value === 'string'`
pub fn as_str(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(text)) => Some(text),
        _ => None,
    }
}

/// `Number.isInteger(x)`
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `typeof value === 'number' && Number.isInteger(value)`
pub fn as_integer(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(x)) if is_integer(*x) => Some(*x),
        _ => None,
    }
}

/// The `str` helper of the TypeScript: a string trimmed, anything else `''`.
pub fn str_trim(value: Option<&JsonValue>) -> String {
    as_str(value)
        .map(|t| trim(t).to_owned())
        .unwrap_or_default()
}

pub fn text(value: impl Into<String>) -> JsonValue {
    JsonValue::String(value.into())
}

pub fn number(x: f64) -> JsonValue {
    JsonValue::Number(x)
}

/// An object literal: the entries in the order written.
pub fn object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut out = Obj::new();
    for (key, value) in entries {
        out.set(key, value);
    }
    JsonValue::Object(out)
}

pub fn string_list(items: &[&str]) -> JsonValue {
    JsonValue::Array(items.iter().map(|s| text(*s)).collect())
}

/// `table[key] = value` on a plain object: `__proto__` makes no own key.
pub fn assign(table: &mut Obj, key: &str, value: JsonValue) {
    if key != "__proto__" {
        table.set(key, value);
    }
}

/// The entries `Object.entries(value)` lists: an object's own, an array's
/// items by index, a string's code units (a unit of a pair is U+FFFD here),
/// nothing for any other value.
pub fn entries_of(value: &JsonValue) -> Vec<(String, JsonValue)> {
    match value {
        JsonValue::Object(object) => object
            .entries()
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v.clone()))
            .collect(),
        JsonValue::Array(items) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        JsonValue::String(t) => t
            .encode_utf16()
            .enumerate()
            .map(|(i, unit)| {
                let c = char::from_u32(u32::from(unit)).unwrap_or(char::REPLACEMENT_CHARACTER);
                (i.to_string(), text(c.to_string()))
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// `{ ...value }`: a copy of an object, the items of an array by index, the
/// code units of a string, nothing for any other value.
pub fn spread(value: Option<&JsonValue>) -> Obj {
    let mut out = Obj::new();
    if let Some(value) = value {
        for (key, item) in entries_of(value) {
            out.set(key, item);
        }
    }
    out
}

/// `const { a, b, ...rest } = object`: a copy without those keys.
pub fn without(object: &Obj, keys: &[&str]) -> Obj {
    let mut out = Obj::new();
    for (key, value) in object.entries() {
        if !keys.contains(&key) {
            out.set(key, value.clone());
        }
    }
    out
}

/// `String(value)`
pub fn js_string(value: &JsonValue) -> String {
    match to_primitive(Some(value)) {
        Ok(primitive) => primitive.to_js_string(),
        Err(_) => match value {
            JsonValue::Number(x) => number_to_string(*x),
            _ => String::new(),
        },
    }
}

/// `String(value)`, throwing for an object that converts to no primitive.
pub fn js_string_checked(value: &JsonValue) -> Result<String, JsTypeError> {
    Ok(to_primitive(Some(value))?.to_js_string())
}

/// `String(value ?? '')`, throwing as [`js_string_checked`] does.
pub fn js_string_or_empty_checked(value: Option<&JsonValue>) -> Result<String, JsTypeError> {
    match coalesce(value, None) {
        None => Ok(String::new()),
        Some(v) => js_string_checked(v),
    }
}

/// The key `table[value]` reads: `String(value)`, `undefined` for none.
pub fn value_key(value: Option<&JsonValue>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(v) => js_string(v),
    }
}

/// `String(value ?? '')`
pub fn js_string_or_empty(value: Option<&JsonValue>) -> String {
    match coalesce(value, None) {
        None => String::new(),
        Some(v) => js_string(v),
    }
}

/// `text.length` in UTF-16 code units.
pub fn length16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(0, end)`
pub fn slice_to(text: &str, end: usize) -> String {
    slice_utf16(text, 0.0, Some(end as f64))
}

/// What the comparison writes for a thrown value: an object with a `$class`
/// naming the error class the TypeScript built it with, or any other value.
/// `message`, `code` and `cause` are the properties of the error. An
/// `AiTimeoutError` carries `ms` and its message is made from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    /// not an `Error` (a string, a number, a plain object)
    Plain,
    Error,
    AiRunError,
    AiTimeoutError,
    AiCreditsError,
}

pub fn error_class(value: &JsonValue) -> ErrorClass {
    match as_str(prop(value, "$class")) {
        Some("Error") => ErrorClass::Error,
        Some("AiRunError") => ErrorClass::AiRunError,
        Some("AiTimeoutError") => ErrorClass::AiTimeoutError,
        Some("AiCreditsError") => ErrorClass::AiCreditsError,
        _ => ErrorClass::Plain,
    }
}

impl ErrorClass {
    pub fn is_error(self) -> bool {
        self != ErrorClass::Plain
    }

    /// `error.name`
    pub fn name(self) -> &'static str {
        match self {
            ErrorClass::Error => "Error",
            ErrorClass::AiRunError => "AiRunError",
            ErrorClass::AiTimeoutError => "AiTimeoutError",
            ErrorClass::AiCreditsError => "AiCreditsError",
            ErrorClass::Plain => "",
        }
    }
}

/// `err.message` of a thrown value; `None` is `undefined`.
pub fn thrown_message(value: &JsonValue) -> Option<JsonValue> {
    match error_class(value) {
        ErrorClass::Plain => prop(value, "message").cloned(),
        ErrorClass::AiTimeoutError => {
            let ms = match prop(value, "ms") {
                Some(JsonValue::Number(x)) => *x,
                _ => f64::NAN,
            };
            Some(text(super::watchdog::ai_timeout_error_message(ms)))
        }
        _ => Some(
            prop(value, "message")
                .cloned()
                .unwrap_or_else(|| text(String::new())),
        ),
    }
}

/// `err.cause`; `None` is `undefined`.
pub fn thrown_cause(value: &JsonValue) -> Option<&JsonValue> {
    prop(value, "cause")
}

/// `err.code`
pub fn thrown_code(value: &JsonValue) -> Option<&JsonValue> {
    prop(value, "code")
}

/// `String(err)`; the `TypeError` is what the conversion throws for a plain
/// object with an own `toString` key.
pub fn thrown_to_string(value: &JsonValue) -> Result<String, JsTypeError> {
    let class = error_class(value);
    if !class.is_error() {
        return js_string_checked(value);
    }
    // Error.prototype.toString
    let name = class.name();
    let message = match thrown_message(value) {
        Some(JsonValue::String(m)) => m,
        Some(other) => js_string_checked(&other)?,
        None => String::new(),
    };
    Ok(if message.is_empty() {
        name.to_owned()
    } else {
        format!("{name}: {message}")
    })
}
