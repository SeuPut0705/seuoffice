//! Every ported function by its TypeScript name, for `tools/main-diff`.
//!
//! A request names `<module>.<function>` (the TypeScript file without `.ts`)
//! and carries the arguments as JSON. The answer is the wire form the
//! comparison prints on both sides:
//!
//! - `{"value":v}` for a value, `{}` for `undefined`;
//! - `{"error":{"code":c,"message":m}}` where the TypeScript throws, `code`
//!   being the `code` of a Node error or `null`;
//! - followed by `"logs":[[...],...]` when the function logged, one array of
//!   arguments per call of its logger.

mod b2_cli;
mod b2_misc;
mod b2_print;
mod b2_recovery;
mod b2_remote;
mod b3_projects;
mod b3_session;
mod b3_shell;
mod b3_update;
mod b3b4_rest;
mod b4_docs;
mod b4_fonts;
mod b4_html;
mod b4_hwp;
mod b4_markdown;
mod b4_pdf;
mod b4_pdf_store;
mod b4_sheets;
mod b4_slides;
mod b5_agent;
mod b5_ai;
mod b5_kb;
mod b5_mcp;
mod b5_provider;
mod b6_apps;
mod b6_shell;
mod b6_tabs;
mod b6_utils;
mod d2_hwp_recovery;
mod fakes;
mod files;
mod node_fs;
mod node_path;
mod settings;
mod update;
mod w_shell;

use serde_json::{Map, Value};

/// What the TypeScript throws, as the comparison sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct CallError {
    pub code: Option<String>,
    pub message: String,
}

impl CallError {
    pub fn plain(message: impl Into<String>) -> Self {
        CallError {
            code: None,
            message: message.into(),
        }
    }
}

impl From<crate::node_fs::NodeError> for CallError {
    fn from(e: crate::node_fs::NodeError) -> Self {
        CallError {
            code: e.code.map(str::to_string),
            message: e.message,
        }
    }
}

/// `Ok(None)` is `undefined`.
pub type Answer = Result<Option<Value>, CallError>;

/// What a call may read besides its arguments, and what it leaves besides
/// its answer.
pub struct Context {
    /// the clock of the call, in milliseconds since the epoch, where the
    /// TypeScript would read `Date.now()` or `new Date()`
    pub now_ms: f64,
    /// one entry per call of the function's logger
    pub logs: Vec<Vec<Value>>,
}

/// One group's table: `None` when the group has no function of that name.
type Group = fn(&str, &[Value], &mut Context) -> Option<Answer>;

const GROUPS: &[Group] = &[
    update::call,
    settings::call,
    files::call,
    node_path::call,
    node_fs::call,
    b2_misc::call,
    b2_recovery::call,
    b2_remote::call,
    b2_print::call,
    b3_session::call,
    b3_update::call,
    b3_shell::call,
    b4_docs::call,
    b4_sheets::call,
    b4_slides::call,
    b4_markdown::call,
    b4_html::call,
    b4_pdf::call,
    b4_hwp::call,
    b5_ai::call,
    b5_agent::call,
    b6_utils::call,
    b6_shell::call,
    b6_apps::call,
    b6_tabs::call,
    d2_hwp_recovery::call,
    w_shell::call,
    b2_cli::call,
    b4_fonts::call,
    b4_pdf_store::call,
    b3b4_rest::call,
    b3_projects::call,
    b5_mcp::call,
    b5_provider::call,
    b5_kb::call,
];

/// Runs `name` with `args`; `None` when no group has it.
pub fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    GROUPS.iter().find_map(|group| group(name, args, cx))
}

/// [`call`] over the JSON request `{ "args": [...], "now": ms }`, answered in
/// the wire form, printed as `JSON.stringify` prints it.
pub fn call_json(name: &str, request: &str) -> String {
    let request: Value = match serde_json::from_str(request) {
        Ok(v) => v,
        Err(e) => return wire(Err(CallError::plain(format!("bad request: {e}"))), &[]),
    };
    let args = request
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let now_ms = request.get("now").and_then(Value::as_f64).unwrap_or(0.0);
    let mut cx = Context {
        now_ms,
        logs: Vec::new(),
    };
    let answer = call(name, &args, &mut cx)
        .unwrap_or_else(|| Err(CallError::plain(format!("no such function: {name}"))));
    wire(answer, &cx.logs)
}

fn wire(answer: Answer, logs: &[Vec<Value>]) -> String {
    let mut out = Map::new();
    match answer {
        Ok(Some(v)) => {
            out.insert("value".into(), v);
        }
        Ok(None) => {}
        Err(e) => {
            let mut err = Map::new();
            err.insert("code".into(), e.code.map_or(Value::Null, Value::String));
            err.insert("message".into(), Value::String(e.message));
            out.insert("error".into(), Value::Object(err));
        }
    }
    if !logs.is_empty() {
        let logs = logs.iter().map(|line| Value::Array(line.clone())).collect();
        out.insert("logs".into(), Value::Array(logs));
    }
    let mut text = String::new();
    print_js(&Value::Object(out), &mut text);
    text
}

/// `JSON.stringify` of a value whose objects hold their keys in the order
/// JavaScript would: numbers print as JavaScript prints them, a non-finite
/// one as `null`.
pub fn print_js(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match n.as_f64() {
            Some(x) if x.is_finite() => out.push_str(&jscompat::number_to_string(x)),
            _ => out.push_str("null"),
        },
        Value::String(s) => out.push_str(&serde_json::to_string(s).expect("a string prints")),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                print_js(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).expect("a key prints"));
                out.push(':');
                print_js(v, out);
            }
            out.push('}');
        }
    }
}

/// The argument at `i`, `undefined` (`None`) past the end.
pub(crate) fn arg(args: &[Value], i: usize) -> Option<&Value> {
    args.get(i)
}

/// The argument at `i` as a string, or the `TypeError`-like refusal the
/// comparison reports when a spec passes something else.
pub(crate) fn str_arg(args: &[Value], i: usize) -> Result<&str, CallError> {
    args.get(i)
        .and_then(Value::as_str)
        .ok_or_else(|| CallError::plain(format!("argument {i} is not a string")))
}
