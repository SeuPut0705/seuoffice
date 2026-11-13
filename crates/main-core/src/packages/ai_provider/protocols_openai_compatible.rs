//! `packages/ai-provider/src/protocols/openai-compatible.ts`: the OpenAI chat
//! completions protocol (`POST <base>/chat/completions`), streamed as SSE or
//! answered as one JSON body, and the one-shot chat of the same endpoint.
//!
//! The module's `usageRejectedGateways` is [`OpenAiCompatibleState`], which
//! the caller owns and hands to every call as `&Rc<RefCell<..>>`.
//!
//! Agent messages, tool definitions and the provider config are
//! [`JsonValue`]s (`AgentMessage[]`, `AgentToolDef[]`, `AiProviderConfig`);
//! an `AgentToolCall` handed to `cb.on_tool_call` is the object
//! `{ id, name, input, inputError?, truncated?, signature? }` in that key
//! order.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{
    JsMap, JsObject, JsonValue, js_regex, json_parse, json_stringify, number_to_string,
    sort_by_number, to_number,
};

use super::fetch::{AiFetch, Init, KeyedFetchBase, keyed_fetch};
use super::http_error::http_body_detail;
use super::jsval::{Obj, as_str, coalesce, js_string, number, prop, prop2, text, value_key};
use super::protocols_shared::{
    CappedReadOptions, SseDataEvents, StreamCallbacks, endpoint_url, js_length,
    json_body_instead_of_sse, open_ai_content_text, parse_tool_input, read_capped_response_text,
    sse_error_text, throw_if_credits_notice, throw_if_tool_count_over_budget,
    throw_if_tool_json_over_budget, usage_count,
};
use super::providers::opencode_session_headers;
use super::registry::model_echoes_reasoning;
use super::task::{JsError, Request, RequestBody, Response, Rt};
use super::watchdog::{StreamWatchdog, create_stream_watchdog};

/// `AiChatResponse`: `{ ok, content?, error? }`
#[derive(Debug, Clone, PartialEq)]
pub struct AiChatResponse {
    pub ok: bool,
    pub content: Option<String>,
    pub error: Option<String>,
}

impl AiChatResponse {
    /// `{ ok: true, content }`
    pub fn succeeded(content: String) -> AiChatResponse {
        AiChatResponse {
            ok: true,
            content: Some(content),
            error: None,
        }
    }

    /// `{ ok: false, error }`
    pub fn failed(error: String) -> AiChatResponse {
        AiChatResponse {
            ok: false,
            content: None,
            error: Some(error),
        }
    }

    /// The object `JSON.stringify` writes for it.
    pub fn to_json(&self) -> JsonValue {
        let mut out = Obj::new();
        out.set("ok", JsonValue::Bool(self.ok));
        if let Some(content) = &self.content {
            out.set("content", text(content.clone()));
        }
        if let Some(error) = &self.error {
            out.set("error", text(error.clone()));
        }
        JsonValue::Object(out)
    }
}

/// `Per-endpoint request shaping resolved from the provider registry`
#[derive(Debug, Clone, Default)]
pub struct OpenAiRequestOptions {
    pub omit_temperature: bool,
    /// send the output cap as OpenAI's renamed `max_completion_tokens`
    /// (GPT-5.x/o-series 400 on `max_tokens`)
    pub use_max_completion_tokens: bool,
    /// vendor-specific fields merged into the request body (e.g. DeepSeek's
    /// `thinking`)
    pub body_extras: Option<Obj>,
    /// Both the connect timeout and the idle timeout of this request. Turns on
    /// a watchdog of its own. `None` keeps the caller's watchdog as it is.
    pub timeout_ms: Option<f64>,
    /// output cap for one-shot chat; on a streamed turn it overrides the
    /// positional cap
    pub max_tokens: Option<f64>,
    /// sampling temperature; 0.3 when not given
    pub temperature: Option<f64>,
}

/// The module state of `openai-compatible.ts`: `usageRejectedGateways`.
#[derive(Debug, Clone, Default)]
pub struct OpenAiCompatibleState {
    usage_rejected_gateways: JsMap<()>,
}

impl OpenAiCompatibleState {
    /// `resetUsageRejectedGateways()`: test hook
    pub fn reset_usage_rejected_gateways(&mut self) {
        self.usage_rejected_gateways.clear();
    }

    /// `usageRejectedGateways.has(baseUrl)`
    pub fn usage_rejected(&self, base_url: &str) -> bool {
        self.usage_rejected_gateways.has(base_url)
    }
}

/// `for (const x of value)` over an array; the TypeError of anything else.
pub(super) fn iterate_or_throw<'a>(
    value: Option<&'a JsonValue>,
    source: &str,
) -> Result<&'a [JsonValue], JsError> {
    match value {
        Some(JsonValue::Array(items)) => Ok(items),
        _ => Err(JsError::type_error(format!("{source} is not iterable"))),
    }
}

/// `for (const x of value ?? [])` where `value` is a property chain.
pub(super) fn iterate_or_empty(value: Option<&JsonValue>) -> Result<&[JsonValue], JsError> {
    match value {
        None | Some(JsonValue::Null) => Ok(&[]),
        Some(JsonValue::Array(items)) => Ok(items),
        Some(other) => {
            let what = match other {
                JsonValue::Number(x) => format!("number {}", number_to_string(*x)),
                JsonValue::Bool(b) => format!("boolean {b}"),
                // a string iterates by character; the shape never arrives here
                _ => "object".to_owned(),
            };
            Err(JsError::type_error(format!(
                "{what} is not iterable (cannot read property Symbol(Symbol.iterator))"
            )))
        }
    }
}

/// `obj[key] = value` for a key whose value is `undefined` left out.
pub(super) fn put(object: &mut Obj, key: &str, value: Option<&JsonValue>) {
    if let Some(value) = value {
        object.set(key, value.clone());
    }
}

/// `value.length > 0` / `!!value.length` of an array or string
pub(super) fn length_truthy(value: Option<&JsonValue>) -> bool {
    value
        .and_then(|v| v.get("length"))
        .is_some_and(|length| length.truthy())
}

pub(super) fn is_truthy(value: Option<&JsonValue>) -> bool {
    value.is_some_and(JsonValue::truthy)
}

/// `choices?.[0]`
fn first_choice(choices: Option<&JsonValue>) -> Option<&JsonValue> {
    match choices {
        Some(JsonValue::Array(items)) => items.first(),
        Some(JsonValue::Object(o)) => o.get("0"),
        _ => None,
    }
}

/// `x.<key> === 'literal'`
pub(super) fn is_str(value: Option<&JsonValue>, literal: &str) -> bool {
    as_str(value) == Some(literal)
}

pub(super) fn read_null_error(key: &str) -> JsError {
    JsError::type_error(format!("Cannot read properties of null (reading '{key}')"))
}

/// `openAiMessages(system, messages, echoReasoning)`
fn open_ai_messages(
    system: &str,
    messages: &JsonValue,
    echo_reasoning: bool,
) -> Result<JsonValue, JsError> {
    let mut out: Vec<JsonValue> = Vec::new();
    let mut head = Obj::new();
    head.set("role", text("system"));
    head.set("content", text(system));
    out.push(JsonValue::Object(head));
    for m in iterate_or_throw(Some(messages), "messages")? {
        let role = prop(m, "role");
        if is_str(role, "user") {
            let images = prop(m, "images");
            let mut user = Obj::new();
            user.set("role", text("user"));
            if !length_truthy(images) {
                put(&mut user, "content", prop(m, "text"));
            } else {
                let mut parts: Vec<JsonValue> = Vec::new();
                if is_truthy(prop(m, "text")) {
                    let mut part = Obj::new();
                    part.set("type", text("text"));
                    put(&mut part, "text", prop(m, "text"));
                    parts.push(JsonValue::Object(part));
                }
                let Some(JsonValue::Array(images)) = images else {
                    return Err(JsError::type_error("m.images.map is not a function"));
                };
                for img in images {
                    let mut url = Obj::new();
                    url.set(
                        "url",
                        text(format!(
                            "data:{};base64,{}",
                            value_key(prop(img, "mime")),
                            value_key(prop(img, "base64"))
                        )),
                    );
                    let mut part = Obj::new();
                    part.set("type", text("image_url"));
                    part.set("image_url", JsonValue::Object(url));
                    parts.push(JsonValue::Object(part));
                }
                user.set("content", JsonValue::Array(parts));
            }
            out.push(JsonValue::Object(user));
        } else if is_str(role, "assistant") {
            let tool_calls = prop(m, "toolCalls");
            let has_tools = is_truthy(tool_calls)
                && tool_calls
                    .and_then(|t| t.get("length"))
                    .is_some_and(|n| matches!(&*n, JsonValue::Number(x) if *x > 0.0));
            // content:null with no tool_calls is an empty assistant turn; some OpenAI-
            // compatible proxies drop or reject the follow-up conversation after that.
            let mut assistant = Obj::new();
            assistant.set("role", text("assistant"));
            let content = if is_truthy(prop(m, "text")) {
                prop(m, "text").cloned().unwrap_or(JsonValue::Null)
            } else if has_tools {
                JsonValue::Null
            } else {
                text("(no content)")
            };
            assistant.set("content", content);
            if echo_reasoning && is_truthy(prop(m, "reasoning")) {
                put(&mut assistant, "reasoning_content", prop(m, "reasoning"));
            }
            if has_tools {
                let Some(JsonValue::Array(calls)) = tool_calls else {
                    return Err(JsError::type_error("m.toolCalls.map is not a function"));
                };
                let mut mapped: Vec<JsonValue> = Vec::new();
                for call in calls {
                    let mut function = Obj::new();
                    put(&mut function, "name", prop(call, "name"));
                    if let Some(input) = prop(call, "input") {
                        function.set("arguments", text(json_stringify(input)));
                    }
                    let mut entry = Obj::new();
                    put(&mut entry, "id", prop(call, "id"));
                    entry.set("type", text("function"));
                    entry.set("function", JsonValue::Object(function));
                    mapped.push(JsonValue::Object(entry));
                }
                assistant.set("tool_calls", JsonValue::Array(mapped));
            }
            out.push(JsonValue::Object(assistant));
        } else {
            for r in iterate_or_throw(prop(m, "results"), "m.results")? {
                // OpenAI has no structured is_error flag (Anthropic sends one); prefix the
                // content so the model can tell a failed call from a successful one and retry.
                let mut tool = Obj::new();
                tool.set("role", text("tool"));
                put(&mut tool, "tool_call_id", prop(r, "id"));
                if is_truthy(prop(r, "isError")) {
                    tool.set(
                        "content",
                        text(format!("Error: {}", value_key(prop(r, "output")))),
                    );
                } else {
                    put(&mut tool, "content", prop(r, "output"));
                }
                out.push(JsonValue::Object(tool));
            }
        }
    }
    Ok(JsonValue::Array(out))
}

/// `AiTokenUsage` of two usage figures, `None` when neither is a count.
fn usage_of(input: Option<&JsonValue>, output: Option<&JsonValue>) -> Option<JsonValue> {
    let input = usage_count(input);
    let output = usage_count(output);
    if input.is_none() && output.is_none() {
        return None;
    }
    let mut usage = Obj::new();
    if let Some(input) = input {
        usage.set("inputTokens", number(input));
    }
    if let Some(output) = output {
        usage.set("outputTokens", number(output));
    }
    Some(JsonValue::Object(usage))
}

/// `emitOpenAiJsonMessage(bodyText, cb)`: emits a complete (non-streamed)
/// chat completion delivered as a plain JSON body.
fn emit_open_ai_json_message(
    rt: &Rt,
    body_text: &str,
    cb: &StreamCallbacks,
) -> Result<(), JsError> {
    let msg = match json_parse(body_text) {
        Ok(msg) => msg,
        Err(_) => {
            return Err(JsError::error(format!(
                "The model returned an unparseable JSON body: {}",
                http_body_detail(body_text)?
            )));
        }
    };
    if matches!(msg, JsonValue::Null) {
        return Err(read_null_error("error"));
    }
    if is_truthy(prop(&msg, "error")) {
        return Err(JsError::error(sse_error_text(
            prop(&msg, "error"),
            "Model error",
        )));
    }
    let choice = first_choice(prop(&msg, "choices"));
    let mut emitted = false;
    let reasoning = prop2(choice, "message", "reasoning_content");
    if is_truthy(reasoning) {
        emitted = true;
        if let (Some(on_reasoning_delta), Some(reasoning)) = (&cb.on_reasoning_delta, reasoning) {
            on_reasoning_delta(&js_string(reasoning));
        }
    }
    let content = prop2(choice, "message", "content");
    if is_truthy(content) {
        // A gateway may answer with `content` as an array of parts; concatenated raw it
        // reaches the loop as "[object Object]", so flatten it first.
        let flat = open_ai_content_text(content);
        if !flat.is_empty() {
            emitted = true;
            (cb.on_delta)(&flat);
        }
    }
    let mut tool_calls: Vec<Obj> = Vec::new();
    for tc in iterate_or_empty(prop2(choice, "message", "tool_calls"))? {
        let name = prop2(Some(tc), "function", "name");
        if !is_truthy(name) {
            continue;
        }
        // A complete JSON body carries the whole turn at once, so the per-turn tool
        // budget of the streamed path has to be applied here as well
        throw_if_tool_count_over_budget(tool_calls.len() as f64 + 1.0, "openai-compatible")?;
        emitted = true;
        let arguments = match prop2(Some(tc), "function", "arguments") {
            None | Some(JsonValue::Null) => String::new(),
            Some(JsonValue::String(s)) => s.clone(),
            Some(_) => return Err(JsError::type_error("json.trim is not a function")),
        };
        let (input, error) = parse_tool_input(&arguments);
        let mut call = Obj::new();
        match coalesce(prop(tc, "id"), None) {
            Some(id) => call.set("id", id.clone()),
            None => call.set("id", text(rt.random_uuid())),
        }
        put(&mut call, "name", name);
        call.set("input", JsonValue::Object(input));
        if let Some(error) = error {
            call.set("inputError", text(error));
        }
        tool_calls.push(call);
    }
    // a 'length' finish may have cut off the last tool call's arguments
    let length_finish = is_str(choice.and_then(|c| prop(c, "finish_reason")), "length");
    if length_finish && let Some(last) = tool_calls.last_mut() {
        last.set("truncated", JsonValue::Bool(true));
    }
    for call in tool_calls {
        (cb.on_tool_call)(JsonValue::Object(call));
    }
    if !emitted {
        return Err(JsError::error(format!(
            "The model returned no content: {}",
            http_body_detail(body_text)?
        )));
    }
    if length_finish && let Some(on_stop_reason) = &cb.on_stop_reason {
        on_stop_reason("max_tokens");
    }
    if let Some(json_usage) = prop(&msg, "usage").filter(|u| u.truthy())
        && let Some(usage) = usage_of(
            prop(json_usage, "prompt_tokens"),
            prop(json_usage, "completion_tokens"),
        )
        && let Some(on_usage) = &cb.on_usage
    {
        on_usage(usage);
    }
    Ok(())
}

/// The headers a request goes out with, in the order of the record literal.
pub(super) fn request_headers(
    rt: &Rt,
    config: &JsonValue,
    base_url: &str,
    session_id: Option<&str>,
) -> Vec<(String, String)> {
    let mut headers: JsObject<String> = JsObject::new();
    headers.set("Content-Type", "application/json".to_owned());
    if is_truthy(prop(config, "apiKey")) {
        headers.set(
            "Authorization",
            format!("Bearer {}", value_key(prop(config, "apiKey"))),
        );
    }
    for (name, value) in opencode_session_headers(rt, Some(base_url), session_id) {
        headers.set(name, value);
    }
    headers
        .entries()
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.clone()))
        .collect()
}

pub(super) fn post(headers: Vec<(String, String)>, body: Obj) -> Request {
    Request {
        method: Some("POST".to_owned()),
        headers,
        body: Some(RequestBody::Text(json_stringify(&JsonValue::Object(body)))),
        redirect: None,
    }
}

/// `HTTP ${response.status}: ${httpBodyDetail(await readCappedResponseText(response, onBytes))}`
pub(super) async fn http_failure(
    response: &Response,
    on_bytes: Rc<dyn Fn()>,
) -> Result<String, JsError> {
    let body = read_capped_response_text(response, &CappedReadOptions::on_bytes(on_bytes)).await?;
    Ok(format!(
        "HTTP {}: {}",
        number_to_string(response.status()),
        http_body_detail(&body)?
    ))
}

/// `streamOpenAiCompatible(baseUrl, config, system, messages, tools,
/// maxTokens, cb, options)`
#[allow(clippy::too_many_arguments)]
pub async fn stream_open_ai_compatible(
    rt: &Rt,
    fx: &AiFetch,
    st: &Rc<RefCell<OpenAiCompatibleState>>,
    base_url: &str,
    config: &JsonValue,
    system: &str,
    messages: &JsonValue,
    tools: &JsonValue,
    max_tokens: f64,
    cb: &StreamCallbacks,
    options: &OpenAiRequestOptions,
) -> Result<(), JsError> {
    let wd = create_stream_watchdog(rt, Some(&cb.signal), options.timeout_ms, options.timeout_ms);
    wd.guard(async {
        let request_usage = !st.borrow().usage_rejected(base_url);
        let first = open_ai_compatible_turn(
            rt,
            fx,
            base_url,
            config,
            system,
            messages,
            tools,
            max_tokens,
            cb,
            &wd,
            options,
            request_usage,
        )
        .await;
        match first {
            Ok(()) => Ok(()),
            Err(e) => {
                // Some gateways reject the (spec) stream_options field outright; a 400 that
                // names it is retried once without it, and the gateway is remembered so
                // later turns skip the extra round trip — those providers never report usage.
                if !js_regex!(r"HTTP 4\d\d:[\s\S]*stream_options", "i").test(&e.message_or_string())
                {
                    return Err(e);
                }
                st.borrow_mut().usage_rejected_gateways.set(base_url, ());
                open_ai_compatible_turn(
                    rt, fx, base_url, config, system, messages, tools, max_tokens, cb, &wd,
                    options, false,
                )
                .await
            }
        }
    })
    .await
}

/// One tool call of a stream, filled in by fragments keyed by index.
#[derive(Clone)]
struct PendingTool {
    id: JsonValue,
    name: String,
    json: String,
    /// the number `a - b` of the sort reads the index as
    index: f64,
}

/// The `Map` key of a tool call's `index`: `Map` compares by SameValueZero,
/// an object is never found again.
fn index_key(index: Option<&JsonValue>, objects: &mut u64) -> String {
    match index {
        None => "u".to_owned(),
        Some(JsonValue::Null) => "n".to_owned(),
        Some(JsonValue::Bool(b)) => format!("b{b}"),
        Some(JsonValue::Number(x)) => format!("d{}", number_to_string(*x)),
        Some(JsonValue::String(s)) => format!("s{s}"),
        Some(JsonValue::Array(_) | JsonValue::Object(_)) => {
            *objects += 1;
            format!("o{objects}")
        }
    }
}

/// What `index` is as an operand of `a - b`.
fn index_number(index: Option<&JsonValue>) -> f64 {
    match index {
        None => f64::NAN,
        Some(JsonValue::Null) => 0.0,
        Some(JsonValue::Bool(b)) => f64::from(u8::from(*b)),
        Some(JsonValue::Number(x)) => *x,
        Some(other) => to_number(&js_string(other)),
    }
}

/// `flushTools()`
fn flush_tools(
    pending_tools: &mut JsMap<PendingTool>,
    stop_reason: Option<&str>,
    emitted: &mut bool,
    cb: &StreamCallbacks,
) {
    let mut entries: Vec<PendingTool> = pending_tools.values().cloned().collect();
    sort_by_number(&mut entries, |a, b| a.index - b.index);
    let last = entries.len().saturating_sub(1);
    for (position, pending) in entries.into_iter().enumerate() {
        if !pending.name.is_empty() {
            let (input, error) = parse_tool_input(&pending.json);
            *emitted = true;
            let mut call = Obj::new();
            call.set("id", pending.id);
            call.set("name", text(pending.name));
            call.set("input", JsonValue::Object(input));
            if let Some(error) = error {
                call.set("inputError", text(error));
            }
            // a 'length' finish cuts off the last streaming tool's arguments
            if stop_reason == Some("max_tokens") && position == last {
                call.set("truncated", JsonValue::Bool(true));
            }
            (cb.on_tool_call)(JsonValue::Object(call));
        }
    }
    pending_tools.clear();
}

#[allow(clippy::too_many_arguments)]
async fn open_ai_compatible_turn(
    rt: &Rt,
    fx: &AiFetch,
    base_url: &str,
    config: &JsonValue,
    system: &str,
    messages: &JsonValue,
    tools: &JsonValue,
    max_tokens: f64,
    cb: &StreamCallbacks,
    wd: &StreamWatchdog,
    options: &OpenAiRequestOptions,
    request_usage: bool,
) -> Result<(), JsError> {
    let on_bytes: Rc<dyn Fn()> = {
        let wd = wd.clone();
        let activity = cb.on_activity.clone();
        Rc::new(move || {
            wd.touch();
            if let Some(activity) = &activity {
                activity();
            }
        })
    };
    // A caller that shapes one request (the local connection test) can cap the
    // output through the options; otherwise the turn's positional cap stands.
    let max_output_tokens = options.max_tokens.unwrap_or(max_tokens);
    let url = endpoint_url(base_url, "chat/completions", None)?;
    let headers = request_headers(rt, config, base_url, cb.session_id.as_deref());
    let mut body = Obj::new();
    put(&mut body, "model", prop(config, "model"));
    if options.use_max_completion_tokens {
        body.set("max_completion_tokens", number(max_output_tokens));
    } else {
        body.set("max_tokens", number(max_output_tokens));
    }
    let echoes = model_echoes_reasoning(&value_key_model(config));
    body.set("messages", open_ai_messages(system, messages, echoes)?);
    if let JsonValue::Array(defs) = tools
        && !defs.is_empty()
    {
        let mut mapped: Vec<JsonValue> = Vec::new();
        for t in defs {
            let mut function = Obj::new();
            put(&mut function, "name", prop(t, "name"));
            put(&mut function, "description", prop(t, "description"));
            put(&mut function, "parameters", prop(t, "inputSchema"));
            let mut tool = Obj::new();
            tool.set("type", text("function"));
            tool.set("function", JsonValue::Object(function));
            mapped.push(JsonValue::Object(tool));
        }
        body.set("tools", JsonValue::Array(mapped));
    }
    if !options.omit_temperature {
        body.set("temperature", number(options.temperature.unwrap_or(0.3)));
    }
    if let Some(extras) = &options.body_extras {
        body.assign(extras);
    }
    body.set("stream", JsonValue::Bool(true));
    // OpenAI-class providers only report usage in a stream when asked (a final
    // chunk with empty choices carries it); strict gateways that reject the
    // field are retried once without it by streamOpenAiCompatible.
    if request_usage {
        let mut stream_options = Obj::new();
        stream_options.set("include_usage", JsonValue::Bool(true));
        body.set("stream_options", JsonValue::Object(stream_options));
    }
    let init = Init {
        request: post(headers, body),
        signal: Some(wd.signal.clone()),
    };
    let response = keyed_fetch(rt, fx, &url, &init, None, &KeyedFetchBase::Ai).await?;
    // headers arrived: ping the renderer watchdog too, or a slow first chunk could trip it
    on_bytes();
    if !response.ok() || !response.has_body() {
        return Err(JsError::error(
            http_failure(&response, on_bytes.clone()).await?,
        ));
    }
    if let Some(json_body) = json_body_instead_of_sse(&response, Some(on_bytes.clone())).await? {
        throw_if_credits_notice(&json_body)?;
        return emit_open_ai_json_message(rt, &json_body, cb);
    }
    // tool call arguments stream in fragments keyed by index
    let mut pending_tools: JsMap<PendingTool> = JsMap::new();
    let mut objects: u64 = 0;
    let mut stop_reason: Option<String> = None;
    let mut abnormal_finish: Option<String> = None;
    let mut saw_finish = false;
    let mut saw_done = false;
    let mut emitted = false;
    let mut turn_usage: Option<JsonValue> = None;
    {
        let mut events = SseDataEvents::new(&response, Some(on_bytes.clone()));
        while let Some(sse) = events.next().await? {
            if sse.raw == "[DONE]" {
                saw_done = true;
                break;
            }
            // A truncated frame or a non-JSON keep-alive from a proxy skips that event
            // rather than killing the turn.
            let Some(event) = sse.json else {
                continue;
            };
            if matches!(event, JsonValue::Null) {
                return Err(read_null_error("error"));
            }
            if is_truthy(prop(&event, "error")) {
                return Err(JsError::error(sse_error_text(
                    prop(&event, "error"),
                    "Model stream error",
                )));
            }
            // The usage chunk arrives with empty choices right before [DONE]; some
            // providers (DeepSeek et al) attach usage to the last content chunk instead.
            if let Some(usage) = prop(&event, "usage").filter(|u| u.truthy())
                && let Some(usage) = usage_of(
                    prop(usage, "prompt_tokens"),
                    prop(usage, "completion_tokens"),
                )
            {
                turn_usage = Some(usage);
            }
            let choice = first_choice(prop(&event, "choices"));
            let Some(choice) = choice.filter(|c| c.truthy()) else {
                continue;
            };
            let reasoning = coalesce(
                prop2(Some(choice), "delta", "reasoning_content"),
                prop2(Some(choice), "delta", "reasoning"),
            );
            if let Some(JsonValue::String(reasoning)) = reasoning
                && !reasoning.is_empty()
            {
                emitted = true;
                if let Some(on_reasoning_delta) = &cb.on_reasoning_delta {
                    on_reasoning_delta(reasoning);
                }
            }
            let content = prop2(Some(choice), "delta", "content");
            if is_truthy(content) {
                // Same array-of-parts shape as the JSON body path above.
                let flat = open_ai_content_text(content);
                if !flat.is_empty() {
                    emitted = true;
                    (cb.on_delta)(&flat);
                }
            }
            for tc in iterate_or_empty(prop2(Some(choice), "delta", "tool_calls"))? {
                let index = prop(tc, "index");
                let key = index_key(index, &mut objects);
                if !pending_tools.has(&key) {
                    throw_if_tool_count_over_budget(
                        pending_tools.len() as f64 + 1.0,
                        "openai-compatible",
                    )?;
                    let id = match coalesce(prop(tc, "id"), None) {
                        Some(id) => id.clone(),
                        None => text(rt.random_uuid()),
                    };
                    pending_tools.set(
                        key.clone(),
                        PendingTool {
                            id,
                            name: String::new(),
                            json: String::new(),
                            index: index_number(index),
                        },
                    );
                }
                let Some(pending) = pending_tools.get_mut(&key) else {
                    continue;
                };
                if let Some(id) = prop(tc, "id").filter(|id| id.truthy()) {
                    pending.id = id.clone();
                }
                // Spec-compliant servers send the name once, but some local/proxy
                // servers resend the full (or growing) name on every delta; naive
                // concatenation then yields "read_fileread_file" and every call fails
                // as an unknown tool. Treat a delta that extends the accumulated name
                // as a resend, anything else as a fragment to append.
                let name = prop2(Some(tc), "function", "name");
                if is_truthy(name) {
                    let Some(name) = as_str(name) else {
                        return Err(JsError::type_error(
                            "tc.function.name.startsWith is not a function",
                        ));
                    };
                    pending.name = if name.starts_with(&pending.name) {
                        name.to_owned()
                    } else {
                        format!("{}{}", pending.name, name)
                    };
                }
                let arguments = prop2(Some(tc), "function", "arguments");
                if let Some(arguments) = arguments.filter(|a| a.truthy()) {
                    pending.json.push_str(&js_string(arguments));
                    throw_if_tool_json_over_budget(js_length(&pending.json), "openai-compatible")?;
                }
            }
            let finish_reason = prop(choice, "finish_reason").filter(|f| f.truthy());
            if let Some(finish_reason) = finish_reason {
                saw_finish = true;
                if is_str(Some(finish_reason), "length") {
                    stop_reason = Some("max_tokens".to_owned());
                } else if !is_str(Some(finish_reason), "stop")
                    && !is_str(Some(finish_reason), "tool_calls")
                {
                    abnormal_finish = Some(js_string(finish_reason));
                }
                flush_tools(&mut pending_tools, stop_reason.as_deref(), &mut emitted, cb);
            }
        }
        // leaving the loop closes the generator: the body is cancelled
        drop(events);
    }
    // No finish and no [DONE] with half-received arguments: the connection dropped
    if !saw_finish && !saw_done {
        let broken: Vec<&PendingTool> = pending_tools
            .values()
            .filter(|p| !p.name.is_empty() && parse_tool_input(&p.json).1.is_some())
            .collect();
        if !broken.is_empty() {
            let received: f64 = broken.iter().map(|p| js_length(&p.json)).sum();
            return Err(JsError::error(format!(
                "The model stream closed while sending tool arguments ({} chars received); the connection was dropped. If this recurs on a large request (e.g. generating a whole document), ask for the output in several smaller parts.",
                number_to_string(received)
            )));
        }
    }
    flush_tools(&mut pending_tools, stop_reason.as_deref(), &mut emitted, cb);
    if !saw_finish && !saw_done && emitted {
        return Err(JsError::error(
            "The model stream ended before a finish_reason or [DONE] marker",
        ));
    }
    // e.g. finish_reason=content_filter with no output, or a stream with no
    // message framing at all (gateway soft-failure) — surface both instead of an
    // empty success; a genuine empty turn still carries finish_reason=stop
    if !emitted && let Some(abnormal) = abnormal_finish {
        return Err(JsError::error(format!(
            "The model returned no content (finish_reason={abnormal})"
        )));
    }
    if !emitted && !saw_finish {
        return Err(JsError::error(
            "The model returned no content (empty stream)",
        ));
    }
    if let (Some(stop_reason), Some(on_stop_reason)) = (&stop_reason, &cb.on_stop_reason) {
        on_stop_reason(stop_reason);
    }
    if let (Some(turn_usage), Some(on_usage)) = (turn_usage, &cb.on_usage) {
        on_usage(turn_usage);
    }
    Ok(())
}

/// `config.model` as `modelEchoesReasoning` reads it.
fn value_key_model(config: &JsonValue) -> String {
    value_key(prop(config, "model"))
}

/// `chatOpenAiCompatible(wd, baseUrl, config, system, user, options)`
#[allow(clippy::too_many_arguments)]
pub async fn chat_open_ai_compatible(
    rt: &Rt,
    fx: &AiFetch,
    _st: &Rc<RefCell<OpenAiCompatibleState>>,
    wd: &StreamWatchdog,
    base_url: &str,
    config: &JsonValue,
    system: &str,
    user: &str,
    options: &OpenAiRequestOptions,
) -> Result<AiChatResponse, JsError> {
    let Some(timeout_ms) = options.timeout_ms else {
        return chat_open_ai_compatible_turn(rt, fx, wd, base_url, config, system, user, options)
            .await;
    };
    // A one-shot check (the local connection test) owns one budget for its whole
    // request, so it can hand over the time it has left instead of sharing the
    // run-wide watchdog. The inner watchdog is linked to the caller's signal, so
    // a run cancel still stops the request.
    let timed = create_stream_watchdog(rt, Some(&wd.signal), Some(timeout_ms), Some(timeout_ms));
    timed
        .guard(chat_open_ai_compatible_turn(
            rt, fx, &timed, base_url, config, system, user, options,
        ))
        .await
}

#[allow(clippy::too_many_arguments)]
async fn chat_open_ai_compatible_turn(
    rt: &Rt,
    fx: &AiFetch,
    wd: &StreamWatchdog,
    base_url: &str,
    config: &JsonValue,
    system: &str,
    user: &str,
    options: &OpenAiRequestOptions,
) -> Result<AiChatResponse, JsError> {
    let url = endpoint_url(base_url, "chat/completions", None)?;
    let headers = request_headers(rt, config, base_url, None);
    let mut body = Obj::new();
    put(&mut body, "model", prop(config, "model"));
    let mut system_message = Obj::new();
    system_message.set("role", text("system"));
    system_message.set("content", text(system));
    let mut user_message = Obj::new();
    user_message.set("role", text("user"));
    user_message.set("content", text(user));
    body.set(
        "messages",
        JsonValue::Array(vec![
            JsonValue::Object(system_message),
            JsonValue::Object(user_message),
        ]),
    );
    if let Some(max_tokens) = options.max_tokens {
        body.set("max_tokens", number(max_tokens));
    }
    if !options.omit_temperature {
        body.set("temperature", number(options.temperature.unwrap_or(0.3)));
    }
    if let Some(extras) = &options.body_extras {
        body.assign(extras);
    }
    let init = Init {
        request: post(headers, body),
        signal: Some(wd.signal.clone()),
    };
    let response = keyed_fetch(rt, fx, &url, &init, None, &KeyedFetchBase::Ai).await?;
    wd.touch();
    let touch: Rc<dyn Fn()> = {
        let wd = wd.clone();
        Rc::new(move || wd.touch())
    };
    if !response.ok() {
        return Ok(AiChatResponse::failed(
            http_failure(&response, touch.clone()).await?,
        ));
    }
    // A 200 with an HTML shell / empty / truncated body (gateway soft-failure)
    // would make response.json() throw; return ok:false instead of leaking a
    // raw SyntaxError to the caller.
    let body_text =
        read_capped_response_text(&response, &CappedReadOptions::on_bytes(touch)).await?;
    let json = match json_parse(&body_text) {
        Ok(json) => json,
        Err(_) => {
            return Ok(AiChatResponse::failed(format!(
                "AI returned a non-JSON response: {}",
                http_body_detail(&body_text)?
            )));
        }
    };
    if matches!(json, JsonValue::Null) {
        return Err(read_null_error("choices"));
    }
    let content = prop2(first_choice(prop(&json, "choices")), "message", "content");
    match content.filter(|c| c.truthy()) {
        None => Ok(AiChatResponse::failed(
            "AI returned an empty response".to_owned(),
        )),
        Some(content) => Ok(AiChatResponse::succeeded(js_string(content))),
    }
}
