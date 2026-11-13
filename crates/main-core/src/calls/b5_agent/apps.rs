//! The functions of the `b5-agent-apps` part (tools/main-diff/groups/
//! b5-agent-apps*.ts): the editors' AI modules (`shell/ai-naming-service`,
//! `docs/free-ai-ipc`, `html/ai-search-ipc`, `hwp/ai-image`, `mindmap/ai-image`,
//! `{diagram,epub,mindmap}/ai-attachments`) and the pieces of
//! `packages/ai-search`, `packages/ai-provider/src/{free-ai,free-connect,
//! image-backend,media,registry,subscription/contract}.ts` and
//! `packages/file-parse` they call.
//!
//! Names are `<module>.<function>`; a package file is `<package>/<file>`
//! (`ai-search/tool-routing.resolveImageRoute`). Settings, statuses and
//! answers are the JSON value, read as JavaScript would hold it; a top-level
//! JSON `null` argument is `undefined`. What a module calls outside itself is
//! a fake the spec describes; each call of a fake is one `logs` line, and the
//! TypeScript writes the same lines. A scenario plays the part of the caller
//! that drives the Rust (the handlers `ipcMain` calls).

mod attachments;
mod modules;
mod provider;
mod search;

use jscompat::{JsonValue, json_value_from_serde, json_value_to_serde};
use serde_json::Value;

use super::super::{Answer, CallError, Context, arg};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    provider::call(name, args, cx)
        .or_else(|| search::call(name, args, cx))
        .or_else(|| modules::call(name, args, cx))
        .or_else(|| attachments::call(name, args, cx))
}

/// The argument at `i` as a JavaScript value; a top-level `null` is `undefined`.
fn jv(args: &[Value], i: usize) -> Option<JsonValue> {
    match arg(args, i) {
        None | Some(Value::Null) => None,
        Some(v) => Some(json_value_from_serde(v)),
    }
}

/// The argument at `i` with `null` kept.
fn jv_exact(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

fn out(value: JsonValue) -> Answer {
    Ok(Some(json_value_to_serde(&value)))
}

fn out_bool(flag: bool) -> Answer {
    Ok(Some(Value::Bool(flag)))
}

fn out_str(text: impl Into<String>) -> Answer {
    Ok(Some(Value::String(text.into())))
}

/// `null` where the TypeScript returns `null`
fn out_opt(value: Option<JsonValue>) -> Answer {
    out(value.unwrap_or(JsonValue::Null))
}

fn out_list(items: &[&str]) -> Answer {
    out(JsonValue::Array(
        items
            .iter()
            .map(|s| JsonValue::String((*s).to_owned()))
            .collect(),
    ))
}

fn bool_arg(args: &[Value], i: usize) -> bool {
    arg(args, i).and_then(Value::as_bool).unwrap_or(false)
}

fn f64_arg(args: &[Value], i: usize) -> f64 {
    arg(args, i).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

/// the text of a string argument, or `""`
fn text_arg(args: &[Value], i: usize) -> &str {
    arg(args, i).and_then(Value::as_str).unwrap_or("")
}

/// bytes of a hex string
fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2)
        .filter_map(|i| u8::from_str_radix(hex.get(i * 2..i * 2 + 2)?, 16).ok())
        .collect()
}
