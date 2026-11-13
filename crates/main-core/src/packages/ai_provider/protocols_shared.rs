//! `packages/ai-provider/src/protocols/shared.ts`: endpoint URLs, the SSE
//! framing every streaming protocol reads its body with, the capped body
//! reads, the tool-input parser and the callbacks of a streamed turn.

use std::collections::VecDeque;
use std::rc::Rc;

use jscompat::{JsonValue, js_regex, json_parse, json_stringify, trim};

use super::jsval::{ErrorClass, Obj, error_class, length16, number, slice_to};
use super::task::{JsError, Response, Signal};
use crate::packages::mcp_sdk::streamable_http_client::Utf8Stream;

/// `err instanceof AiCreditsError`: a non-SSE reply whose text is the
/// gateway's credits-exhausted notice surfaces as this typed error.
pub fn is_ai_credits_error(err: &JsonValue) -> bool {
    error_class(err) == ErrorClass::AiCreditsError
}

// ---- endpoint URL composition ----

/// `new URL(input)` throws this for an input it cannot read.
pub fn invalid_url(input: &str) -> JsError {
    JsError::type_error("Invalid URL")
        .with("code", JsonValue::String("ERR_INVALID_URL".into()))
        .with("input", JsonValue::String(input.into()))
}

/// `new URL(input)`
pub fn parse_url(input: &str) -> Result<url::Url, JsError> {
    url::Url::parse(input).map_err(|_| invalid_url(input))
}

/// `endpointUrl(baseUrl, path, search)`: a provider endpoint path appended to
/// a base URL by setting its `pathname`; the query stays, the fragment goes.
pub fn endpoint_url(base_url: &str, path: &str, search: Option<&str>) -> Result<String, JsError> {
    let mut url = parse_url(base_url)?;
    let base = js_regex!(r"/+$").replace_all(url.path(), |_| String::new());
    let suffix = js_regex!(r"^/+").replace_all(path, |_| String::new());
    let pathname = if suffix.is_empty() {
        base
    } else {
        format!("{base}/{suffix}")
    };
    // the pathname setter of a URL that cannot be a base does nothing
    if !url.cannot_be_a_base() {
        url.set_path(&pathname);
    }
    url.set_fragment(None);
    if let Some(search) = search {
        // `url.search = s`: a leading `?` is dropped, an empty one clears the query
        let query = search.strip_prefix('?').unwrap_or(search);
        if search.is_empty() {
            url.set_query(None);
        } else {
            url.set_query(Some(query));
        }
    }
    Ok(url.to_string())
}

// ---- streaming (SSE line splitting shared by all providers) ----

/// Max buffered SSE line: a gateway sending GB without newline would OOM main.
pub const MAX_SSE_LINE_BYTES: f64 = 4.0 * 1024.0 * 1024.0;
pub const MAX_RESPONSE_BODY_BYTES: f64 = MAX_SSE_LINE_BYTES;

/// `new ResponseBodyTooLargeError(receivedBytes, capBytes)`
pub fn response_body_too_large_error(received_bytes: f64, cap_bytes: f64) -> JsError {
    JsError::new(
        "ResponseBodyTooLargeError",
        format!(
            "Response body exceeded the {}-byte limit ({} bytes)",
            jscompat::number_to_string(cap_bytes),
            jscompat::number_to_string(received_bytes)
        ),
    )
    .with("receivedBytes", number(received_bytes))
    .with("capBytes", number(cap_bytes))
}

/// `CappedReadOptions`
#[derive(Clone, Default)]
pub struct CappedReadOptions {
    pub max_bytes: Option<f64>,
    pub on_bytes: Option<Rc<dyn Fn()>>,
    /// `onOverflow: 'truncate'` keeps what fit under the cap and never throws
    pub truncate: bool,
}

impl CappedReadOptions {
    /// the `() => void` form of the options
    pub fn on_bytes(on_bytes: Rc<dyn Fn()>) -> CappedReadOptions {
        CappedReadOptions {
            on_bytes: Some(on_bytes),
            ..CappedReadOptions::default()
        }
    }
}

/// `readCappedResponseText(response, options)`
pub async fn read_capped_response_text(
    response: &Response,
    opts: &CappedReadOptions,
) -> Result<String, JsError> {
    let max_bytes = opts.max_bytes.unwrap_or(MAX_RESPONSE_BODY_BYTES);
    let truncate = opts.truncate;
    let declared_bytes = match response.header("content-length") {
        Some(v) => jscompat::to_number(&v),
        // Number(null) is 0
        None => 0.0,
    };
    if !truncate && declared_bytes.is_finite() && declared_bytes > max_bytes {
        if response.has_body() {
            response.cancel();
        }
        return Err(response_body_too_large_error(declared_bytes, max_bytes));
    }
    if !response.has_body() {
        return Ok(String::new());
    }
    let mut decoder = Utf8Stream::new();
    let mut text = String::new();
    let mut bytes = 0.0;
    let result: Result<(), JsError> = async {
        loop {
            let Some(value) = response.read().await? else {
                break;
            };
            if let Some(on_bytes) = &opts.on_bytes {
                on_bytes();
            }
            let total = bytes + value.len() as f64;
            if truncate && total >= max_bytes {
                let keep = (max_bytes - bytes).max(0.0) as usize;
                text.push_str(&decoder.decode(&value[..keep.min(value.len())], false));
                break;
            }
            if total > max_bytes {
                return Err(response_body_too_large_error(total, max_bytes));
            }
            bytes += value.len() as f64;
            text.push_str(&decoder.decode(&value, false));
        }
        Ok(())
    }
    .await;
    // finally: reader.cancel()
    response.cancel();
    match result {
        Ok(()) => {
            text.push_str(&decoder.decode(&[], true));
            Ok(text)
        }
        // truncate mode reports whatever arrived: the caller is already reporting the status
        Err(_) if truncate => {
            text.push_str(&decoder.decode(&[], true));
            Ok(text)
        }
        Err(e) => Err(e),
    }
}

/// `openAiContentText(content)`: an OpenAI `content` field flattened to text.
pub fn open_ai_content_text(content: Option<&JsonValue>) -> String {
    match content {
        Some(JsonValue::String(s)) => s.clone(),
        Some(JsonValue::Array(parts)) => parts
            .iter()
            .map(|part| match part {
                JsonValue::Object(o) => match o.get("text") {
                    Some(JsonValue::String(t)) => t.clone(),
                    _ => String::new(),
                },
                _ => String::new(),
            })
            .collect(),
        _ => String::new(),
    }
}

/// `sseLines(body, onBytes)`: the lines of a body. Dropping it is the
/// generator's `finally`: the body is cancelled.
pub struct SseLines<'a> {
    response: &'a Response,
    on_bytes: Option<Rc<dyn Fn()>>,
    decoder: Utf8Stream,
    buffer: String,
    line_bytes: f64,
    ready: VecDeque<String>,
    ended: bool,
}

impl<'a> SseLines<'a> {
    pub fn new(response: &'a Response, on_bytes: Option<Rc<dyn Fn()>>) -> SseLines<'a> {
        SseLines {
            response,
            on_bytes,
            decoder: Utf8Stream::new(),
            buffer: String::new(),
            line_bytes: 0.0,
            ready: VecDeque::new(),
            ended: false,
        }
    }

    /// The next line; `None` at the end.
    pub async fn next(&mut self) -> Result<Option<String>, JsError> {
        loop {
            if let Some(line) = self.ready.pop_front() {
                return Ok(Some(line));
            }
            if self.ended {
                return Ok(None);
            }
            let Some(value) = self.response.read().await? else {
                self.ended = true;
                // flush the decoder: a stream cut mid-character ends in U+FFFD
                let tail = self.decoder.decode(&[], true);
                self.buffer.push_str(&tail);
                if !self.buffer.is_empty() {
                    return Ok(Some(std::mem::take(&mut self.buffer)));
                }
                return Ok(None);
            };
            if let Some(on_bytes) = &self.on_bytes {
                on_bytes();
            }
            for &byte in &value {
                if byte == 0x0a {
                    self.line_bytes = 0.0;
                    continue;
                }
                self.line_bytes += 1.0;
                if self.line_bytes > MAX_SSE_LINE_BYTES {
                    return Err(JsError::error(format!(
                        "SSE line exceeded buffer limit ({} bytes, cap {}); the gateway sent a line without newline.",
                        jscompat::number_to_string(self.line_bytes),
                        jscompat::number_to_string(MAX_SSE_LINE_BYTES)
                    )));
                }
            }
            let text = self.decoder.decode(&value, false);
            self.buffer.push_str(&text);
            let mut lines: Vec<String> = self.buffer.split('\n').map(str::to_owned).collect();
            self.buffer = lines.pop().unwrap_or_default();
            self.ready.extend(lines);
        }
    }
}

impl Drop for SseLines<'_> {
    fn drop(&mut self) {
        self.response.cancel();
    }
}

/// Per-tool streamed argument buffer cap.
pub const MAX_TOOL_JSON_CHARS: f64 = 512_000.0;

/// `SseDataEvent`: `json` is `None` (`undefined`) for a non-JSON payload.
#[derive(Debug, Clone, PartialEq)]
pub struct SseDataEvent {
    pub raw: String,
    pub json: Option<JsonValue>,
}

/// `sseDataEvents(body, onBytes)`: the `data:` payloads framed into whole events.
pub struct SseDataEvents<'a> {
    lines: SseLines<'a>,
    parts: Vec<String>,
    ready: VecDeque<SseDataEvent>,
    ended: bool,
}

impl<'a> SseDataEvents<'a> {
    pub fn new(response: &'a Response, on_bytes: Option<Rc<dyn Fn()>>) -> SseDataEvents<'a> {
        SseDataEvents {
            lines: SseLines::new(response, on_bytes),
            parts: Vec::new(),
            ready: VecDeque::new(),
            ended: false,
        }
    }

    fn flush(&mut self) -> Option<SseDataEvent> {
        if self.parts.is_empty() {
            return None;
        }
        let raw = self.parts.join("\n");
        self.parts.clear();
        let json = parse_json(&raw);
        Some(SseDataEvent { raw, json })
    }

    /// The next event; `None` at the end.
    pub async fn next(&mut self) -> Result<Option<SseDataEvent>, JsError> {
        loop {
            if let Some(event) = self.ready.pop_front() {
                return Ok(Some(event));
            }
            if self.ended {
                return Ok(None);
            }
            let Some(line) = self.lines.next().await? else {
                self.ended = true;
                if let Some(held) = self.flush() {
                    return Ok(Some(held));
                }
                return Ok(None);
            };
            if !line.starts_with("data:") {
                if let Some(held) = self.flush() {
                    self.ready.push_back(held);
                }
                continue;
            }
            let raw = trim(&line["data:".len()..]).to_owned();
            if raw.is_empty() {
                continue;
            }
            let json = parse_json(&raw);
            if raw == "[DONE]" || json.is_some() {
                if let Some(held) = self.flush() {
                    self.ready.push_back(held);
                }
                self.ready.push_back(SseDataEvent { raw, json });
                continue;
            }
            // Only a JSON opener starts a fragment; anything else alone is a keep-alive.
            if self.parts.is_empty() && !js_regex!(r"^[\[{]", "").test(&raw) {
                self.ready.push_back(SseDataEvent { raw, json });
                continue;
            }
            self.parts.push(raw);
            // Dispatch as soon as the joined fragments form a body.
            let joined = self.parts.join("\n");
            if let Some(whole) = parse_json(&joined) {
                self.parts.clear();
                self.ready.push_back(SseDataEvent {
                    raw: joined,
                    json: Some(whole),
                });
            }
        }
    }
}

/// `parseJson(value)`: `None` where `JSON.parse` throws.
pub fn parse_json(value: &str) -> Option<JsonValue> {
    json_parse(value).ok()
}

/// `throwIfToolJsonOverBudget(jsonLength, provider)`
pub fn throw_if_tool_json_over_budget(json_length: f64, provider: &str) -> Result<(), JsError> {
    if json_length > MAX_TOOL_JSON_CHARS {
        return Err(JsError::error(format!(
            "Tool call arguments exceeded the {provider} buffer limit ({} chars, cap {}); the provider kept streaming argument fragments without finishing. Ask for the output in several smaller parts.",
            jscompat::number_to_string(json_length),
            jscompat::number_to_string(MAX_TOOL_JSON_CHARS)
        )));
    }
    Ok(())
}

/// Max tool calls started per streamed turn.
pub const MAX_STREAM_TOOL_CALLS: f64 = 100.0;

/// `throwIfToolCountOverBudget(count, provider)`
pub fn throw_if_tool_count_over_budget(count: f64, provider: &str) -> Result<(), JsError> {
    if count > MAX_STREAM_TOOL_CALLS {
        return Err(JsError::error(format!(
            "Too many streamed tool calls ({}, cap {}) for {provider}; the provider kept starting tool calls without finishing the turn.",
            jscompat::number_to_string(count),
            jscompat::number_to_string(MAX_STREAM_TOOL_CALLS)
        )));
    }
    Ok(())
}

/// `StreamCallbacks`: an absent optional callback is `None`. Tool calls and
/// usage are the JSON objects the TypeScript hands over.
#[derive(Clone)]
pub struct StreamCallbacks {
    pub on_delta: Rc<dyn Fn(&str)>,
    /// `AgentToolCall`: `{ id, name, input, inputError?, truncated? }`
    pub on_tool_call: Rc<dyn Fn(JsonValue)>,
    pub on_reasoning_delta: Option<Rc<dyn Fn(&str)>>,
    pub on_stop_reason: Option<Rc<dyn Fn(&str)>>,
    /// `AiTokenUsage`
    pub on_usage: Option<Rc<dyn Fn(JsonValue)>>,
    /// `AiSubscriptionUsage[]`
    pub on_subscription_usage: Option<Rc<dyn Fn(JsonValue)>>,
    pub on_input_truncated: Option<Rc<dyn Fn()>>,
    pub on_activity: Option<Rc<dyn Fn()>>,
    pub session_id: Option<String>,
    pub signal: Signal,
}

/// `usageCount(value)`: a usage figure as a finite count.
pub fn usage_count(value: Option<&JsonValue>) -> Option<f64> {
    let n = match value {
        Some(JsonValue::String(s)) => jscompat::to_number(s),
        Some(JsonValue::Number(n)) => *n,
        _ => return None,
    };
    (n.is_finite() && n >= 0.0).then_some(n)
}

/// `repairUnescapedQuotes(json)`: a `"` inside a string whose next
/// non-white-space character is not structural is escaped.
fn repair_unescaped_quotes(json: &str) -> String {
    let chars: Vec<char> = json.chars().collect();
    let mut out = String::with_capacity(json.len());
    let mut in_str = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if !in_str {
            if c == '"' {
                in_str = true;
            }
            out.push(c);
            i += 1;
            continue;
        }
        if c == '\\' {
            out.push(c);
            i += 1;
            if let Some(next) = chars.get(i) {
                out.push(*next);
            }
            i += 1;
            continue;
        }
        if c == '"' {
            let mut j = i + 1;
            while j < chars.len() && " \n\r\t".contains(chars[j]) {
                j += 1;
            }
            match chars.get(j) {
                None => {
                    in_str = false;
                    out.push(c);
                }
                Some(next) if ",}]:".contains(*next) => {
                    in_str = false;
                    out.push(c);
                }
                Some(_) => out.push_str("\\\""),
            }
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// `sseErrorText(error, fallback)`: a readable message of a failure a
/// gateway reported inside a stream.
pub fn sse_error_text(error: Option<&JsonValue>, fallback: &str) -> String {
    match error {
        Some(JsonValue::String(s)) if !s.is_empty() => s.clone(),
        Some(value @ (JsonValue::Object(_) | JsonValue::Array(_))) => {
            if let JsonValue::Object(o) = value
                && let Some(JsonValue::String(message)) = o.get("message")
                && !message.is_empty()
            {
                return message.clone();
            }
            json_stringify(value)
        }
        _ => fallback.to_owned(),
    }
}

/// `jsonBodyInsteadOfSse(response, onBytes)`: the body text when a
/// `stream: true` request was answered with plain JSON, else `None`.
pub async fn json_body_instead_of_sse(
    response: &Response,
    on_bytes: Option<Rc<dyn Fn()>>,
) -> Result<Option<String>, JsError> {
    let content_type = response.header("content-type").unwrap_or_default();
    if content_type.to_lowercase().contains("application/json") {
        let opts = CappedReadOptions {
            on_bytes,
            ..CappedReadOptions::default()
        };
        return read_capped_response_text(response, &opts).await.map(Some);
    }
    Ok(None)
}

/// `new AiCreditsError(notice)`
pub fn ai_credits_error(notice: &str) -> JsError {
    JsError::new("AiCreditsError", notice)
}

fn credits_notice_text(value: &JsonValue) -> Option<String> {
    match value {
        JsonValue::String(s) => {
            let t = s.to_lowercase();
            let credits =
                t.contains("credit") && (t.contains("exhausted") || t.contains("insufficient"));
            credits.then(|| s.clone())
        }
        JsonValue::Array(items) => items.iter().find_map(credits_notice_text),
        JsonValue::Object(o) => o
            .entries()
            .into_iter()
            .find_map(|(_, v)| credits_notice_text(v).filter(|hit| !hit.is_empty())),
        _ => None,
    }
}

/// `throwIfCreditsNotice(bodyText)`
pub fn throw_if_credits_notice(body_text: &str) -> Result<(), JsError> {
    let Ok(parsed) = json_parse(body_text) else {
        return Ok(());
    };
    match credits_notice_text(&parsed) {
        Some(notice) if !notice.is_empty() => Err(ai_credits_error(&notice)),
        _ => Ok(()),
    }
}

/// `parseToolInput(json)`: `(input, error)`.
pub fn parse_tool_input(json: &str) -> (Obj, Option<String>) {
    if trim(json).is_empty() {
        return (Obj::new(), None);
    }
    let parsed = match json_parse(json) {
        Ok(v) => v,
        Err(e) => match json_parse(&repair_unescaped_quotes(json)) {
            Ok(v) => v,
            Err(_) => {
                return (
                    Obj::new(),
                    Some(format!("{}; raw: {}", e.message(), slice_to(json, 500))),
                );
            }
        },
    };
    match parsed {
        JsonValue::Object(o) => (o, None),
        _ => (
            Obj::new(),
            Some(format!(
                "tool input must be a JSON object; raw: {}",
                slice_to(json, 500)
            )),
        ),
    }
}

/// `isPlainObject(value)`
pub fn is_plain_object(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::Object(_)))
}

/// `json.length` in UTF-16 code units, as a number.
pub fn js_length(text: &str) -> f64 {
    length16(text) as f64
}
