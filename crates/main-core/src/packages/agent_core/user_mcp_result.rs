//! `packages/agent-core/src/user-mcp/result.ts`: what of an MCP tool result
//! reaches the AI (user MCP spec 5.5).
//!
//! Only `content` text blocks and `structuredContent` (as JSON text) go on;
//! every other block is counted in one line instead. `isError` stays a tool
//! error. A result longer than the limit keeps its start and a note that it
//! was cut. A result is read as `unknown` was: a [`JsonValue`], `None` for
//! `undefined`.

use jscompat::{JsonValue, json_parse, json_stringify, number_to_string, slice_utf16};

/// Longest result passed to the AI, in characters; a tunable default
pub const MCP_RESULT_MAX_CHARS: f64 = 200_000.0;

/// `ShapedMcpResult`
#[derive(Debug, Clone, PartialEq)]
pub struct ShapedMcpResult {
    pub output: String,
    pub is_error: bool,
}

pub const MCP_RESULT_UNREADABLE: &str = "The server returned a result this app could not read.";
pub const MCP_RESULT_EMPTY: &str = "(The tool returned no content.)";
pub const MCP_ERROR_EMPTY: &str = "(The tool reported an error without a message.)";

fn non_text_line(n: usize) -> String {
    if n == 1 {
        "[1 non-text item was not passed on.]".to_owned()
    } else {
        format!("[{n} non-text items were not passed on.]")
    }
}

/// The same JSON value, whatever its spacing; `None` when the text is not JSON
fn canonical_json(text: &str) -> Option<String> {
    json_parse(text).ok().map(|value| json_stringify(&value))
}

/// `output.charCodeAt(pos)`: the position is truncated, NaN is 0
fn char_code_at(units: &[u16], pos: f64) -> Option<u16> {
    let pos = if pos.is_nan() { 0.0 } else { pos.trunc() };
    if pos < 0.0 || pos >= units.len() as f64 {
        return None;
    }
    Some(units[pos as usize])
}

fn cut(output: &str, max_chars: f64) -> String {
    let units: Vec<u16> = output.encode_utf16().collect();
    let length = units.len() as f64;
    if length <= max_chars {
        return output.to_owned();
    }
    let mut end = f64::max(0.0, max_chars);
    // do not leave half of a surrogate pair at the end
    let last = char_code_at(&units, end - 1.0);
    if end > 0.0 && last.is_some_and(|unit| (0xd800..=0xdbff).contains(&unit)) {
        end -= 1.0;
    }
    format!(
        "{}\n\n[The result was cut because it was long: the first {} of {} characters are shown.]",
        slice_utf16(output, 0.0, Some(end)),
        number_to_string(end),
        number_to_string(length),
    )
}

fn unreadable() -> ShapedMcpResult {
    ShapedMcpResult {
        output: MCP_RESULT_UNREADABLE.to_owned(),
        is_error: true,
    }
}

/// Turn an MCP `CallToolResult` (as received, unchecked) into the tool output the AI gets
pub fn shape_mcp_result(result: Option<&JsonValue>, max_chars: f64) -> ShapedMcpResult {
    // an array is an object that has none of the three keys
    let object = match result {
        Some(JsonValue::Object(object)) => Some(object),
        Some(JsonValue::Array(_)) => None,
        _ => return unreadable(),
    };
    let read = |key: &str| object.and_then(|o| o.get(key));
    let content = read("content");
    let structured_content = read("structuredContent");
    let failed = matches!(read("isError"), Some(JsonValue::Bool(true)));
    let blocks: &[JsonValue] = match content {
        None => &[],
        Some(JsonValue::Array(items)) => items,
        Some(_) => return unreadable(),
    };
    let mut texts: Vec<String> = Vec::new();
    let mut skipped = 0usize;
    for block in blocks {
        let text = match block {
            JsonValue::Object(b) => match (b.get("type"), b.get("text")) {
                (Some(JsonValue::String(kind)), Some(JsonValue::String(text)))
                    if kind == "text" =>
                {
                    Some(text)
                }
                _ => None,
            },
            _ => None,
        };
        match text {
            Some(text) => texts.push(text.clone()),
            None => skipped += 1,
        }
    }
    if let Some(value) = structured_content
        && !matches!(value, JsonValue::Null)
    {
        let json = json_stringify(value);
        // servers often repeat the structured value as a text block; send it once
        if !texts
            .iter()
            .any(|t| canonical_json(t).as_deref() == Some(json.as_str()))
        {
            texts.push(json);
        }
    }
    if skipped > 0 {
        texts.push(non_text_line(skipped));
    }
    let output = texts.join("\n\n");
    if output.is_empty() {
        return ShapedMcpResult {
            output: if failed {
                MCP_ERROR_EMPTY
            } else {
                MCP_RESULT_EMPTY
            }
            .to_owned(),
            is_error: failed,
        };
    }
    ShapedMcpResult {
        output: cut(&output, max_chars),
        is_error: failed,
    }
}

/// `McpCallAnswer`: the hub's answer to a call, the result already shaped
/// for the AI, or the reason the call could not be made (English, naming the
/// server).
#[derive(Debug, Clone, PartialEq)]
pub enum McpCallAnswer {
    Answered { output: String, is_error: bool },
    Failed { error: String },
}

/// A shaped result as the hub answers it
pub fn shaped_mcp_answer(shaped: &ShapedMcpResult) -> McpCallAnswer {
    McpCallAnswer::Answered {
        output: shaped.output.clone(),
        is_error: shaped.is_error,
    }
}

pub const MCP_NO_ANSWER: &str = "The MCP connection did not answer.";

/// An answer that crossed a process boundary, checked; anything else is unreadable
pub fn mcp_call_answer_of(raw: Option<&JsonValue>) -> McpCallAnswer {
    let failed = |error: &str| McpCallAnswer::Failed {
        error: error.to_owned(),
    };
    let answer = match raw {
        None | Some(JsonValue::Null) => return failed(MCP_NO_ANSWER),
        Some(JsonValue::Object(answer)) => answer,
        Some(_) => return failed(MCP_RESULT_UNREADABLE),
    };
    match answer.get("ok") {
        Some(JsonValue::Bool(false)) => {
            let error = match answer.get("error") {
                Some(JsonValue::String(error)) => error.as_str(),
                _ => "",
            };
            failed(if error.is_empty() {
                "The call could not be made."
            } else {
                error
            })
        }
        Some(JsonValue::Bool(true)) => match answer.get("output") {
            Some(JsonValue::String(output)) => McpCallAnswer::Answered {
                output: output.clone(),
                is_error: matches!(answer.get("isError"), Some(JsonValue::Bool(true))),
            },
            _ => failed(MCP_RESULT_UNREADABLE),
        },
        _ => failed(MCP_RESULT_UNREADABLE),
    }
}
