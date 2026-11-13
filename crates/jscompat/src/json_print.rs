//! `JSON.stringify` of a [`JsonValue`] with an indent, and the conversions
//! between a [`JsonValue`] and a `serde_json::Value`.
//!
//! The order of the keys is the one JavaScript writes (integer keys first),
//! a number is printed as JavaScript prints it (a non-finite one as `null`),
//! and a string is escaped as the well-formed `JSON.stringify` does.

use crate::{JsObject, JsonValue, number_to_string};

/// `JSON.stringify(value)`.
pub fn json_stringify(value: &JsonValue) -> String {
    json_stringify_pretty(value, 0)
}

/// `JSON.stringify(value, null, indent)`; an `indent` of 0 writes no white
/// space (the argument is 0..=10 in JavaScript, and this is not clamped).
pub fn json_stringify_pretty(value: &JsonValue, indent: usize) -> String {
    let mut out = String::new();
    write_value(value, indent, 0, &mut out);
    out
}

/// A string as `JSON.stringify` quotes it.
pub fn json_quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `JSON.stringify(text.slice(start, end))`, the indexes counted in UTF-16
/// code units as [`crate::slice_utf16`] counts them. Where the slice cuts a
/// surrogate pair, the lone half is written as the well-formed
/// `JSON.stringify` writes it, a `\udXXX` escape: those six ASCII characters
/// are what JavaScript's text holds, so the answer is exact where
/// `json_quote(&slice_utf16(..))` would hold U+FFFD.
pub fn json_quote_slice(text: &str, start: f64, end: Option<f64>) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let range = crate::replace::slice_range(units.len(), start, end);
    let mut out = String::from("\"");
    let mut whole = String::new();
    for unit in char::decode_utf16(units[range].iter().copied()) {
        match unit {
            Ok(c) => whole.push(c),
            Err(lone) => {
                let quoted = json_quote(&std::mem::take(&mut whole));
                out.push_str(&quoted[1..quoted.len() - 1]);
                out.push_str(&format!("\\u{:04x}", lone.unpaired_surrogate()));
            }
        }
    }
    out.push_str(&json_quote(&whole)[1..]);
    out
}

fn newline(indent: usize, depth: usize, out: &mut String) {
    if indent > 0 {
        out.push('\n');
        for _ in 0..indent * depth {
            out.push(' ');
        }
    }
}

fn write_value(value: &JsonValue, indent: usize, depth: usize, out: &mut String) {
    match value {
        JsonValue::Null => out.push_str("null"),
        JsonValue::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        JsonValue::Number(x) => {
            if x.is_finite() {
                out.push_str(&number_to_string(*x));
            } else {
                out.push_str("null");
            }
        }
        JsonValue::String(text) => out.push_str(&json_quote(text)),
        JsonValue::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(indent, depth + 1, out);
                write_value(item, indent, depth + 1, out);
            }
            newline(indent, depth, out);
            out.push(']');
        }
        JsonValue::Object(object) => {
            if object.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (key, item)) in object.entries().into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(indent, depth + 1, out);
                out.push_str(&json_quote(key));
                out.push(':');
                if indent > 0 {
                    out.push(' ');
                }
                write_value(item, indent, depth + 1, out);
            }
            newline(indent, depth, out);
            out.push('}');
        }
    }
}

/// A `serde_json::Value` read as the value `JSON.parse` would give for its
/// text: a number is a double, an object keeps its keys (the integer-like
/// ones are put first when the object is read back).
pub fn json_value_from_serde(value: &serde_json::Value) -> JsonValue {
    match value {
        serde_json::Value::Null => JsonValue::Null,
        serde_json::Value::Bool(flag) => JsonValue::Bool(*flag),
        serde_json::Value::Number(n) => JsonValue::Number(n.as_f64().unwrap_or(f64::NAN)),
        serde_json::Value::String(text) => JsonValue::String(text.clone()),
        serde_json::Value::Array(items) => {
            JsonValue::Array(items.iter().map(json_value_from_serde).collect())
        }
        serde_json::Value::Object(map) => {
            let mut object = JsObject::new();
            for (key, item) in map {
                object.set(key.clone(), json_value_from_serde(item));
            }
            JsonValue::Object(object)
        }
    }
}

/// A [`JsonValue`] as a `serde_json::Value` whose keys are in the order
/// JavaScript writes them (needs serde_json's `preserve_order`); a
/// non-finite number is `null`, as `JSON.stringify` writes it.
pub fn json_value_to_serde(value: &JsonValue) -> serde_json::Value {
    match value {
        JsonValue::Null => serde_json::Value::Null,
        JsonValue::Bool(flag) => serde_json::Value::Bool(*flag),
        JsonValue::Number(x) => serde_json::Number::from_f64(*x)
            .map_or(serde_json::Value::Null, serde_json::Value::Number),
        JsonValue::String(text) => serde_json::Value::String(text.clone()),
        JsonValue::Array(items) => {
            serde_json::Value::Array(items.iter().map(json_value_to_serde).collect())
        }
        JsonValue::Object(object) => {
            let mut map = serde_json::Map::new();
            for (key, item) in object.entries() {
                map.insert(key.to_owned(), json_value_to_serde(item));
            }
            serde_json::Value::Object(map)
        }
    }
}
