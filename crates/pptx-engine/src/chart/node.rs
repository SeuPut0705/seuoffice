//! Reads over the object tree fast-xml-parser gives chart.ts and chartex.ts,
//! each named by the JavaScript expression it stands for.

use jscompat::{Radix, parse_int, to_number, value_to_string, value_truthy};
use serde_json::Value;

/// A value of the tree, `None` being `undefined`.
pub(crate) type Node<'a> = Option<&'a Value>;

/// `node?.[key]`. A text or a list has none of the names read here.
pub(crate) fn get<'a>(node: Node<'a>, key: &str) -> Node<'a> {
    node?.as_object()?.get(key)
}

/// `node?.[key]?.['@_val']`, for a value that is not a boolean.
pub(crate) fn val<'a>(node: Node<'a>, key: &str) -> Node<'a> {
    get(get(node, key), "@_val")
}

/// `Array.isArray(node) ? node[0] : node`
pub(crate) fn first(node: Node<'_>) -> Node<'_> {
    match node {
        Some(Value::Array(items)) => items.first(),
        other => other,
    }
}

/// `node?.[0]`: an element of a list. A text indexes to one character, whose
/// properties are all `undefined` as `None`'s are.
pub(crate) fn at0(node: Node<'_>) -> Node<'_> {
    match node {
        Some(Value::Array(items)) => items.first(),
        _ => None,
    }
}

/// `Array.isArray(raw) ? raw : raw ? [raw] : []`
pub(crate) fn list(node: Node<'_>) -> &[Value] {
    match node {
        Some(Value::Array(items)) => items,
        Some(value) if value_truthy(Some(value)) => std::slice::from_ref(value),
        _ => &[],
    }
}

/// `if (node)`
pub(crate) fn truthy(node: Node<'_>) -> bool {
    value_truthy(node)
}

/// `node === text`
pub(crate) fn is(node: Node<'_>, text: &str) -> bool {
    matches!(node, Some(Value::String(found)) if found == text)
}

/// `typeof node === 'string' ? node : undefined`
pub(crate) fn as_str(node: Node<'_>) -> Option<&str> {
    match node {
        Some(Value::String(text)) => Some(text),
        _ => None,
    }
}

/// `typeof node === 'object'` (the tree holds no `null`)
pub(crate) fn is_object(node: Node<'_>) -> bool {
    matches!(node, Some(Value::Object(_) | Value::Array(_) | Value::Null))
}

/// `String(node)`
pub(crate) fn string_of(node: Node<'_>) -> String {
    match node {
        Some(Value::String(text)) => text.clone(),
        other => value_to_string(other),
    }
}

/// `parseInt(node, 10)`
pub(crate) fn int(node: Node<'_>) -> f64 {
    match node {
        Some(Value::String(text)) => parse_int(text, Radix::Ten),
        other => parse_int(&value_to_string(other), Radix::Ten),
    }
}

/// `Number(node)`
pub(crate) fn number(node: Node<'_>) -> f64 {
    match node {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => to_number(text),
        other => to_number(&value_to_string(other)),
    }
}

/// `x || 0` over a number
pub(crate) fn or0(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() { 0.0 } else { x }
}

/// `key in node`, which throws on a text.
pub(crate) fn has_key(node: &Value, key: &str) -> Result<bool, String> {
    match node {
        Value::Object(map) => Ok(map.contains_key(key)),
        Value::Array(_) => Ok(false),
        other => Err(format!(
            "TypeError: Cannot use 'in' operator to search for '{key}' in {}",
            value_to_string(Some(other))
        )),
    }
}

/// `a !== b` over two values of the tree: texts by value, nodes by identity.
pub(crate) fn not_same(a: Node<'_>, b: Node<'_>) -> bool {
    match (a, b) {
        (None, None) => false,
        (Some(Value::String(x)), Some(Value::String(y))) => x != y,
        (Some(x @ (Value::Object(_) | Value::Array(_))), Some(y)) => !std::ptr::eq(x, y),
        (Some(x), Some(y)) => x != y,
        _ => true,
    }
}

/// How the TypeScript reads a CT_Boolean `val` at a site.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TsBoolRead {
    /// `el?.['@_val'] === '1'`
    EqOne,
    /// `el?.['@_val'] !== '0'`
    NotZero,
}

/// A CT_Boolean element (`<c:delete val="1"/>`), the one place its `val`
/// is read.
///
/// ledger chart-xsd-boolean: the TypeScript compares `val` with `'1'` or
/// `'0'` only. By ECMA-376 `val` is an xsd:boolean (`1`, `true`, `0`,
/// `false`) and an element without it is true. Those two cases are read by
/// the format; an absent element and any other `val` keep the reading of
/// the TypeScript, so text that is not valid answers as it does there.
pub fn xsd_bool(el: Node<'_>, ts: TsBoolRead) -> bool {
    let Some(present) = el else {
        return ts == TsBoolRead::NotZero;
    };
    if is(Some(present), "") {
        return true;
    }
    let raw = get(Some(present), "@_val");
    match as_str(raw) {
        Some("1" | "true") => true,
        Some("0" | "false") => false,
        _ => match ts {
            TsBoolRead::EqOne => is(raw, "1"),
            TsBoolRead::NotZero => !is(raw, "0"),
        },
    }
}
