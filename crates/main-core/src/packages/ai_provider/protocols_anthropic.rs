//! `packages/ai-provider/src/protocols/anthropic.ts`: the Anthropic Messages
//! protocol, streamed and not.
//!
//! The messages, tools, provider settings and every event of a stream are
//! [`JsonValue`]s: the TypeScript reads them as loosely typed data from a
//! renderer or a gateway. Where it reads a property with a plain `.`, a
//! `null` there throws a `TypeError` worded as V8 words it ([`read`]); where
//! it iterates a value, a number or an object there throws the V8 one too
//! ([`items_or_empty`]). The helpers at the top are also the ones
//! `protocols_gemini` uses.

use std::rc::Rc;

use jscompat::{JsMap, JsonValue, json_parse, json_stringify, number_to_string};

use super::fetch::{AiFetch, Init, KeyedFetchBase, keyed_fetch};
use super::http_error::http_body_detail;
use super::jsval::{
    Obj, as_str, coalesce, js_string, js_string_or_empty, length16, number, object, prop, prop2,
    text, value_key,
};
use super::protocols_shared::{
    CappedReadOptions, SseDataEvents, StreamCallbacks, endpoint_url, json_body_instead_of_sse,
    parse_tool_input, read_capped_response_text, sse_error_text, throw_if_credits_notice,
    throw_if_tool_count_over_budget, throw_if_tool_json_over_budget, usage_count,
};
use super::providers::opencode_session_headers;
use super::task::{JsError, Request, RequestBody, Rt};
use super::types::AiChatResponse;
use super::watchdog::{StreamWatchdog, create_stream_watchdog};

pub const ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";

// ---- reads the TypeScript does on loosely typed data ----

/// `value.key` without `?.`: a `null` has no properties. `None` is
/// `undefined`.
pub(super) fn read<'a>(value: &'a JsonValue, key: &str) -> Result<Option<&'a JsonValue>, JsError> {
    match value {
        JsonValue::Null => Err(JsError::type_error(format!(
            "Cannot read properties of null (reading '{key}')"
        ))),
        other => Ok(prop(other, key)),
    }
}

/// The `TypeError` a `for...of` over a value that has no iterator throws.
fn not_iterable(value: &JsonValue) -> JsError {
    let what = match value {
        JsonValue::Number(x) => format!("number {}", number_to_string(*x)),
        JsonValue::Bool(flag) => format!("boolean {flag}"),
        _ => "object".to_owned(),
    };
    JsError::type_error(format!(
        "{what} is not iterable (cannot read property Symbol(Symbol.iterator))"
    ))
}

/// `for (const item of value ?? [])`: the items of an array, the code points
/// of a string, nothing for `null` and `undefined`.
pub(super) fn items_or_empty(value: Option<&JsonValue>) -> Result<Vec<JsonValue>, JsError> {
    match coalesce(value, None) {
        None => Ok(Vec::new()),
        Some(JsonValue::Array(items)) => Ok(items.clone()),
        Some(JsonValue::String(s)) => Ok(s.chars().map(|c| text(c.to_string())).collect()),
        Some(other) => Err(not_iterable(other)),
    }
}

/// `value.map(...)`: the items of an array, else the `TypeError` the call
/// throws, where `not_a_function` is the message V8 words for the expression
/// that is not one (it names the source text, and a spread adds a clause).
pub(super) fn array_to_map<'a>(
    value: Option<&'a JsonValue>,
    not_a_function: &str,
) -> Result<&'a Vec<JsonValue>, JsError> {
    match value {
        Some(JsonValue::Array(items)) => Ok(items),
        None => Err(JsError::type_error(
            "Cannot read properties of undefined (reading 'map')",
        )),
        Some(JsonValue::Null) => Err(JsError::type_error(
            "Cannot read properties of null (reading 'map')",
        )),
        Some(_) => Err(JsError::type_error(not_a_function)),
    }
}

/// `{ key: value }` where an `undefined` value leaves the key out.
pub(super) fn set_some(target: &mut Obj, key: &str, value: Option<&JsonValue>) {
    if let Some(value) = value {
        target.set(key, value.clone());
    }
}

/// `value ? ...` of a property: the value is there and truthy.
pub(super) fn truthy(value: Option<&JsonValue>) -> bool {
    value.is_some_and(JsonValue::truthy)
}

/// `onBytes`: a byte arrived. Pings the watchdog and the caller.
pub(super) fn on_bytes_of(wd: &StreamWatchdog, cb: &StreamCallbacks) -> Rc<dyn Fn()> {
    let wd = wd.clone();
    let activity = cb.on_activity.clone();
    Rc::new(move || {
        wd.touch();
        if let Some(activity) = &activity {
            activity();
        }
    })
}

/// `onUsage` of an accumulator that holds a count.
pub(super) fn has_usage(usage: &Obj) -> bool {
    usage.get("inputTokens").is_some() || usage.get("outputTokens").is_some()
}

fn anthropic_messages(messages: &JsonValue) -> Result<Vec<JsonValue>, JsError> {
    let mut out = Vec::new();
    for m in array_to_map(Some(messages), "messages.map is not a function")? {
        let role = read(m, "role")?;
        if as_str(role) == Some("user") {
            // Keep plain-text content as a string; only upgrade to a content block array when images are present
            let images = prop(m, "images");
            let has_images = images
                .and_then(|i| i.get("length"))
                .is_some_and(|len| len.truthy());
            if !has_images {
                let mut user = Obj::new();
                user.set("role", text("user"));
                set_some(&mut user, "content", prop(m, "text"));
                out.push(JsonValue::Object(user));
                continue;
            }
            let mut content = Vec::new();
            if truthy(prop(m, "text")) {
                content.push(object(vec![
                    ("type", text("text")),
                    ("text", prop(m, "text").cloned().unwrap_or(JsonValue::Null)),
                ]));
            }
            for img in array_to_map(
                images,
                "m.images.map is not a function or its return value is not iterable",
            )? {
                let mut source = Obj::new();
                source.set("type", text("base64"));
                set_some(&mut source, "media_type", read(img, "mime")?);
                set_some(&mut source, "data", read(img, "base64")?);
                content.push(object(vec![
                    ("type", text("image")),
                    ("source", JsonValue::Object(source)),
                ]));
            }
            out.push(object(vec![
                ("role", text("user")),
                ("content", JsonValue::Array(content)),
            ]));
            continue;
        }
        if as_str(role) == Some("assistant") {
            let mut content = Vec::new();
            if truthy(prop(m, "text")) {
                content.push(object(vec![
                    ("type", text("text")),
                    ("text", prop(m, "text").cloned().unwrap_or(JsonValue::Null)),
                ]));
            }
            for call in items_or_empty(prop(m, "toolCalls"))? {
                let mut block = Obj::new();
                block.set("type", text("tool_use"));
                set_some(&mut block, "id", read(&call, "id")?);
                set_some(&mut block, "name", read(&call, "name")?);
                set_some(&mut block, "input", read(&call, "input")?);
                content.push(JsonValue::Object(block));
            }
            // Anthropic rejects empty content arrays; a prior empty terminal turn
            // (tool work with no prose) would otherwise poison every follow-up.
            if content.is_empty() {
                content.push(object(vec![
                    ("type", text("text")),
                    ("text", text("(no content)")),
                ]));
            }
            out.push(object(vec![
                ("role", text("assistant")),
                ("content", JsonValue::Array(content)),
            ]));
            continue;
        }
        // tool results travel back as a user message of tool_result blocks
        let mut content = Vec::new();
        for r in array_to_map(prop(m, "results"), "m.results.map is not a function")? {
            let mut block = Obj::new();
            block.set("type", text("tool_result"));
            set_some(&mut block, "tool_use_id", read(r, "id")?);
            set_some(&mut block, "content", read(r, "output")?);
            if truthy(read(r, "isError")?) {
                block.set("is_error", JsonValue::Bool(true));
            }
            content.push(JsonValue::Object(block));
        }
        out.push(object(vec![
            ("role", text("user")),
            ("content", JsonValue::Array(content)),
        ]));
    }
    Ok(out)
}

/// An `AgentToolCall`: `{ id, name, input, inputError?, truncated? }`.
fn tool_call(id: JsonValue, name: JsonValue, input: JsonValue, input_error: Option<String>) -> Obj {
    let mut call = Obj::new();
    call.set("id", id);
    call.set("name", name);
    call.set("input", input);
    if let Some(error) = input_error {
        call.set("inputError", text(error));
    }
    call
}

/// Emits a complete (non-streamed) Anthropic message delivered as a plain JSON body.
fn emit_anthropic_json_message(
    rt: &Rt,
    body_text: &str,
    cb: &StreamCallbacks,
) -> Result<(), JsError> {
    let Ok(msg) = json_parse(body_text) else {
        return Err(JsError::error(format!(
            "Claude returned an unparseable JSON body: {}",
            http_body_detail(body_text)?
        )));
    };
    let error = read(&msg, "error")?;
    if truthy(error) {
        return Err(JsError::error(sse_error_text(error, "Claude error")));
    }
    let mut emitted = false;
    let mut tool_calls: Vec<Obj> = Vec::new();
    for block in items_or_empty(prop(&msg, "content"))? {
        let block_type = read(&block, "type")?;
        if as_str(block_type) == Some("text") && truthy(prop(&block, "text")) {
            emitted = true;
            (cb.on_delta)(prop(&block, "text").cloned().unwrap_or(JsonValue::Null));
        } else if as_str(block_type) == Some("tool_use") && truthy(prop(&block, "name")) {
            emitted = true;
            // A complete JSON body carries the whole turn at once, so the per-turn tool
            // budget of the streamed path has to be applied here as well
            throw_if_tool_count_over_budget((tool_calls.len() + 1) as f64, "anthropic")?;
            let id = match coalesce(prop(&block, "id"), None) {
                Some(id) => id.clone(),
                None => text(rt.random_uuid()),
            };
            let name = prop(&block, "name").cloned().unwrap_or(JsonValue::Null);
            let input = match coalesce(prop(&block, "input"), None) {
                Some(input) => input.clone(),
                None => JsonValue::Object(Obj::new()),
            };
            tool_calls.push(tool_call(id, name, input, None));
        }
    }
    let stop_reason = prop(&msg, "stop_reason");
    // a max_tokens stop may have cut off the last tool call's arguments
    if as_str(stop_reason) == Some("max_tokens")
        && let Some(last) = tool_calls.last_mut()
    {
        last.set("truncated", JsonValue::Bool(true));
    }
    for call in tool_calls {
        (cb.on_tool_call)(JsonValue::Object(call));
    }
    if !emitted {
        return Err(JsError::error(format!(
            "Claude returned no content: {}",
            http_body_detail(body_text)?
        )));
    }
    if let Some(reason) = stop_reason
        && reason.truthy()
        && let Some(on_stop_reason) = &cb.on_stop_reason
    {
        on_stop_reason(reason.clone());
    }
    let mut json_usage = Obj::new();
    merge_anthropic_usage(&mut json_usage, prop(&msg, "usage"));
    if has_usage(&json_usage)
        && let Some(on_usage) = &cb.on_usage
    {
        on_usage(JsonValue::Object(json_usage));
    }
    Ok(())
}

/// Merge an Anthropic usage object into an accumulator (input arrives on message_start,
/// the running output total on message_delta; stream events and JSON bodies share the shape).
fn merge_anthropic_usage(target: &mut Obj, usage: Option<&JsonValue>) {
    let Some(usage) = usage.filter(|u| u.truthy()) else {
        return;
    };
    // input_tokens excludes the cached prefix; the billed input is all three together
    let fresh = usage_count(prop(usage, "input_tokens"));
    let cached = usage_count(prop(usage, "cache_read_input_tokens")).unwrap_or(0.0)
        + usage_count(prop(usage, "cache_creation_input_tokens")).unwrap_or(0.0);
    let input = match fresh {
        None => (cached > 0.0).then_some(cached),
        Some(fresh) => Some(fresh + cached),
    };
    let output = usage_count(prop(usage, "output_tokens"));
    if let Some(input) = input {
        target.set("inputTokens", number(input));
    }
    if let Some(output) = output {
        target.set("outputTokens", number(output));
    }
}

/// `tools` as a list: `tools.length > 0` and `tools.map`.
pub(super) fn tool_defs(tools: &JsonValue) -> &[JsonValue] {
    match tools {
        JsonValue::Array(tools) => tools,
        _ => &[],
    }
}

/// `streamAnthropic(config, system, messages, tools, maxTokens, cb, baseUrl,
/// bodyExtras)`; `None` for `base_url` is its default. `body_extras` are the
/// request fields the route adds, such as the effort (`output_config`).
#[allow(clippy::too_many_arguments)]
pub async fn stream_anthropic(
    rt: &Rt,
    fx: &AiFetch,
    config: &JsonValue,
    system: &str,
    messages: &JsonValue,
    tools: &JsonValue,
    max_tokens: f64,
    cb: &StreamCallbacks,
    base_url: Option<&str>,
    body_extras: Option<&Obj>,
) -> Result<(), JsError> {
    let base_url = base_url.unwrap_or(ANTHROPIC_BASE_URL);
    let wd = create_stream_watchdog(rt, Some(&cb.signal), None, None);
    wd.guard(anthropic_turn(
        rt,
        fx,
        config,
        system,
        messages,
        tools,
        max_tokens,
        cb,
        base_url,
        &wd,
        body_extras,
    ))
    .await
}

/// A `Map` key: a primitive by value (`SameValueZero`), an object or an
/// array by identity, which `identity` counts out.
fn map_key(index: &JsonValue, identity: &mut u64) -> String {
    match index {
        JsonValue::Number(x) => format!("n{}", number_to_string(*x)),
        JsonValue::String(s) => format!("s{s}"),
        JsonValue::Bool(flag) => format!("b{flag}"),
        JsonValue::Null => "null".to_owned(),
        JsonValue::Array(_) | JsonValue::Object(_) => {
            *identity += 1;
            format!("o{identity}")
        }
    }
}

#[derive(Clone)]
struct PendingTool {
    id: JsonValue,
    name: JsonValue,
    json: String,
}

/// `new Error(message, { cause })` of a failed fetch: the message and the
/// cause the failure names, which is where Node keeps the real reason.
fn fetch_failed(e: JsError) -> JsError {
    // a refused redirect is the provider's answer, not a failed connection
    if e.is("AiRedirectRefusedError") {
        return e;
    }
    let message = if e.is_error() {
        Some(text(e.message.clone()))
    } else {
        e.prop("message").cloned()
    };
    let shown = match &message {
        Some(message) if message.truthy() => js_string(message),
        _ => e.to_js_string(),
    };
    let cause_text = match e.prop("cause") {
        Some(cause) if cause.truthy() => {
            let code = prop(cause, "code").filter(|c| c.truthy());
            let message = prop(cause, "message").filter(|m| m.truthy());
            format!(" cause={}", js_string(code.or(message).unwrap_or(cause)))
        }
        _ => String::new(),
    };
    JsError::error(format!("Claude fetch failed: {shown}{cause_text}")).with("cause", e.to_json())
}

#[allow(clippy::too_many_arguments)]
async fn anthropic_turn(
    rt: &Rt,
    fx: &AiFetch,
    config: &JsonValue,
    system: &str,
    messages: &JsonValue,
    tools: &JsonValue,
    max_tokens: f64,
    cb: &StreamCallbacks,
    base_url: &str,
    wd: &StreamWatchdog,
    body_extras: Option<&Obj>,
) -> Result<(), JsError> {
    let on_bytes = on_bytes_of(wd, cb);
    let tool_list = tool_defs(tools);
    let sent = async {
        let url = endpoint_url(base_url, "v1/messages", None)?;
        let mut headers = vec![
            ("Content-Type".to_owned(), "application/json".to_owned()),
            ("x-api-key".to_owned(), value_key(prop(config, "apiKey"))),
            ("anthropic-version".to_owned(), "2023-06-01".to_owned()),
            // Renderer fetches and the net.fetch rescue path go through Chromium's network stack,
            // which adds browser-semantics headers; Anthropic rejects those with 403 "Request not
            // allowed". This header is the official opt-in for browser/Electron environments.
            (
                "anthropic-dangerous-direct-browser-access".to_owned(),
                "true".to_owned(),
            ),
        ];
        headers.extend(opencode_session_headers(
            rt,
            Some(base_url),
            cb.session_id.as_deref(),
        ));
        let mut body = Obj::new();
        set_some(&mut body, "model", prop(config, "model"));
        body.set("max_tokens", number(max_tokens));
        body.set("system", text(system));
        body.set("messages", JsonValue::Array(anthropic_messages(messages)?));
        if !tool_list.is_empty() {
            let mut declared = Vec::new();
            for t in tool_list {
                let mut tool = Obj::new();
                set_some(&mut tool, "name", prop(t, "name"));
                set_some(&mut tool, "description", prop(t, "description"));
                set_some(&mut tool, "input_schema", prop(t, "inputSchema"));
                declared.push(JsonValue::Object(tool));
            }
            body.set("tools", JsonValue::Array(declared));
        }
        if let Some(extras) = body_extras {
            for (key, value) in extras.entries() {
                body.set(key, value.clone());
            }
        }
        body.set("stream", JsonValue::Bool(true));
        let init = Init {
            request: Request {
                method: Some("POST".to_owned()),
                headers,
                body: Some(RequestBody::Text(json_stringify(&JsonValue::Object(body)))),
                redirect: None,
            },
            signal: Some(wd.signal.clone()),
        };
        keyed_fetch(rt, fx, &url, &init, None, &KeyedFetchBase::Ai).await
    }
    .await;
    let response = match sent {
        Ok(response) => response,
        Err(e) => return Err(fetch_failed(e)),
    };
    // headers arrived: ping the renderer watchdog too, or a slow first chunk could trip it
    on_bytes();
    if !response.ok() || !response.has_body() {
        let detail =
            read_capped_response_text(&response, &CappedReadOptions::on_bytes(on_bytes.clone()))
                .await?;
        return Err(JsError::error(format!(
            "Claude HTTP {}: {}",
            number_to_string(response.status()),
            http_body_detail(&detail)?
        )));
    }
    if let Some(json_body) = json_body_instead_of_sse(&response, Some(on_bytes.clone())).await? {
        throw_if_credits_notice(&json_body)?;
        return emit_anthropic_json_message(rt, &json_body, cb);
    }
    // tool_use inputs stream as partial JSON per content block
    let mut pending_tools: JsMap<PendingTool> = JsMap::new();
    let mut identity = 0u64;
    // Some gateways omit the optional block index on delta/stop events; track the
    // last started block so parallel tools don't cross-wire into index 0
    let mut current_tool_index = map_key(&number(0.0), &mut identity);
    // emission deferred to stream end: message_delta's stop_reason arrives after all
    // blocks, and a max_tokens stop must mark the last (cut-off) tool call as truncated
    let mut completed_tools: Vec<Obj> = Vec::new();
    let mut stop_reason: Option<JsonValue> = None;
    let mut emitted = false;
    let mut turn_usage = Obj::new();
    {
        let mut events = SseDataEvents::new(&response, Some(on_bytes.clone()));
        while let Some(sse) = events.next().await? {
            // A truncated frame or a non-JSON keep-alive from a proxy skips that event
            // rather than killing the turn.
            let Some(event) = &sse.json else { continue };
            let event_type = read(event, "type")?;
            let index = coalesce(prop(event, "index"), None);
            if as_str(event_type) == Some("message_start") {
                merge_anthropic_usage(&mut turn_usage, prop2(Some(event), "message", "usage"));
            } else if as_str(event_type) == Some("content_block_start")
                && as_str(prop2(Some(event), "content_block", "type")) == Some("tool_use")
            {
                let tool_index = match index {
                    Some(index) => map_key(index, &mut identity),
                    None => map_key(&number(0.0), &mut identity),
                };
                current_tool_index = tool_index.clone();
                if !pending_tools.has(&tool_index) {
                    throw_if_tool_count_over_budget(
                        (pending_tools.len() + completed_tools.len() + 1) as f64,
                        "anthropic",
                    )?;
                }
                let block = prop(event, "content_block");
                let id = match coalesce(block.and_then(|b| prop(b, "id")), None) {
                    Some(id) => id.clone(),
                    None => text(rt.random_uuid()),
                };
                let name = coalesce(block.and_then(|b| prop(b, "name")), None)
                    .cloned()
                    .unwrap_or_else(|| text(""));
                pending_tools.set(
                    tool_index,
                    PendingTool {
                        id,
                        name,
                        json: String::new(),
                    },
                );
            } else if as_str(event_type) == Some("content_block_delta") {
                let delta = prop(event, "delta");
                let delta_type = delta.and_then(|d| prop(d, "type"));
                let delta_text = delta.and_then(|d| prop(d, "text"));
                if as_str(delta_type) == Some("text_delta") && truthy(delta_text) {
                    emitted = true;
                    (cb.on_delta)(delta_text.cloned().unwrap_or(JsonValue::Null));
                } else if as_str(delta_type) == Some("input_json_delta") {
                    let key = match index {
                        Some(index) => map_key(index, &mut identity),
                        None => current_tool_index.clone(),
                    };
                    if let Some(pending) = pending_tools.get_mut(&key) {
                        pending.json.push_str(&js_string_or_empty(
                            delta.and_then(|d| prop(d, "partial_json")),
                        ));
                        throw_if_tool_json_over_budget(
                            length16(&pending.json) as f64,
                            "anthropic",
                        )?;
                    }
                }
            } else if as_str(event_type) == Some("content_block_stop") {
                let stop_index = match index {
                    Some(index) => map_key(index, &mut identity),
                    None => current_tool_index.clone(),
                };
                if let Some(pending) = pending_tools.delete(&stop_index) {
                    // Match the OpenAI route: drop nameless tool calls instead of feeding
                    // an empty-name call to the loop (which would always fail as unknown)
                    if pending.name.truthy() {
                        let (input, error) = parse_tool_input(&pending.json);
                        completed_tools.push(tool_call(
                            pending.id,
                            pending.name,
                            JsonValue::Object(input),
                            error,
                        ));
                    }
                }
            } else if as_str(event_type) == Some("message_delta") {
                if let Some(reason) = prop(event, "delta").and_then(|d| prop(d, "stop_reason"))
                    && reason.truthy()
                {
                    stop_reason = Some(reason.clone());
                }
                // message_delta's usage.output_tokens is the running total for the message;
                // it supersedes anything message_start reported for the output side
                merge_anthropic_usage(&mut turn_usage, prop(event, "usage"));
            } else if as_str(event_type) == Some("error") || truthy(prop(event, "error")) {
                // also catches gateway errors delivered in a non-Anthropic shape (no `type` field)
                return Err(JsError::error(sse_error_text(
                    prop(event, "error"),
                    "Claude stream error",
                )));
            }
        }
    }
    // Buffered tool arguments can take minutes; a gateway dropping the connection
    // meanwhile is a billed in-progress turn, not the replayable empty stream below.
    if !pending_tools.is_empty() && stop_reason.is_none() {
        let received: f64 = pending_tools
            .values()
            .map(|p| length16(&p.json) as f64)
            .sum();
        return Err(JsError::error(format!(
            "Claude stream closed while sending tool arguments ({} chars received); the connection was dropped. If this recurs on a large request (e.g. generating a whole document), ask for the output in several smaller parts.",
            number_to_string(received)
        )));
    }
    // A max_tokens stop can cut a tool_use block before its content_block_stop: emit
    // the partial call as truncated rather than dropping it and answering "done".
    let leftovers: Vec<PendingTool> = pending_tools.values().cloned().collect();
    for pending in leftovers {
        let (input, error) = parse_tool_input(&pending.json);
        let mut call = tool_call(pending.id, pending.name, JsonValue::Object(input), error);
        call.set("truncated", JsonValue::Bool(true));
        completed_tools.push(call);
    }
    pending_tools.clear();
    if as_str(stop_reason.as_ref()) == Some("max_tokens")
        && let Some(last) = completed_tools.last_mut()
    {
        last.set("truncated", JsonValue::Bool(true));
    }
    let any_completed = !completed_tools.is_empty();
    for call in completed_tools {
        (cb.on_tool_call)(JsonValue::Object(call));
    }
    // A stream with no content AND no message framing (no stop_reason ever seen)
    // is a gateway soft-failure, not a model turn: surface it instead of letting
    // it dissolve into an empty "successful" turn with no diagnostics. A genuine
    // empty closing turn (common after tool-heavy runs) still carries end_turn.
    // The "(empty stream)" suffix is a contract: app renderers match it to
    // classify the failure as empty output (fail fast, no billed retries).
    if !emitted && !any_completed && stop_reason.is_none() {
        return Err(JsError::error("Claude returned no content (empty stream)"));
    }
    let Some(stop_reason) = stop_reason else {
        return Err(JsError::error("Claude stream ended before a stop_reason"));
    };
    if let Some(on_stop_reason) = &cb.on_stop_reason {
        on_stop_reason(stop_reason.clone());
    }
    if has_usage(&turn_usage)
        && let Some(on_usage) = &cb.on_usage
    {
        on_usage(JsonValue::Object(turn_usage));
    }
    Ok(())
}

/// `chatAnthropic(wd, config, system, user, baseUrl, bodyExtras)`: an
/// `AiChatResponse`, `{ ok: false, error }` or `{ ok: true, content }`.
#[allow(clippy::too_many_arguments)]
pub async fn chat_anthropic(
    rt: &Rt,
    fx: &AiFetch,
    wd: &StreamWatchdog,
    config: &JsonValue,
    system: &str,
    user: &str,
    base_url: Option<&str>,
    body_extras: Option<&Obj>,
) -> Result<AiChatResponse, JsError> {
    let base_url = base_url.unwrap_or(ANTHROPIC_BASE_URL);
    let url = endpoint_url(base_url, "v1/messages", None)?;
    let mut headers = vec![
        ("Content-Type".to_owned(), "application/json".to_owned()),
        ("x-api-key".to_owned(), value_key(prop(config, "apiKey"))),
        ("anthropic-version".to_owned(), "2023-06-01".to_owned()),
        // Fetch in the Electron main process goes through Chromium's network stack; this header avoids 403.
        (
            "anthropic-dangerous-direct-browser-access".to_owned(),
            "true".to_owned(),
        ),
    ];
    headers.extend(opencode_session_headers(rt, Some(base_url), None));
    let mut body = Obj::new();
    set_some(&mut body, "model", prop(config, "model"));
    body.set("max_tokens", number(8192.0));
    body.set("system", text(system));
    body.set(
        "messages",
        JsonValue::Array(vec![object(vec![
            ("role", text("user")),
            ("content", text(user)),
        ])]),
    );
    if let Some(extras) = body_extras {
        for (key, value) in extras.entries() {
            body.set(key, value.clone());
        }
    }
    let init = Init {
        request: Request {
            method: Some("POST".to_owned()),
            headers,
            body: Some(RequestBody::Text(json_stringify(&JsonValue::Object(body)))),
            redirect: None,
        },
        signal: Some(wd.signal.clone()),
    };
    let response = keyed_fetch(rt, fx, &url, &init, None, &KeyedFetchBase::Ai).await?;
    wd.touch();
    let touch: Rc<dyn Fn()> = {
        let wd = wd.clone();
        Rc::new(move || wd.touch())
    };
    if !response.ok() {
        let detail =
            read_capped_response_text(&response, &CappedReadOptions::on_bytes(touch.clone()))
                .await?;
        return Ok(AiChatResponse::failed(format!(
            "Claude HTTP {}: {}",
            number_to_string(response.status()),
            http_body_detail(&detail)?
        )));
    }
    // A 200 with an HTML shell / empty / truncated body (gateway soft-failure)
    // would make response.json() throw; return ok:false instead of leaking a
    // raw SyntaxError to the caller.
    let body_text =
        read_capped_response_text(&response, &CappedReadOptions::on_bytes(touch)).await?;
    let Ok(json) = json_parse(&body_text) else {
        return Ok(AiChatResponse::failed(format!(
            "Claude returned a non-JSON response: {}",
            http_body_detail(&body_text)?
        )));
    };
    let content = match read(&json, "content")? {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::Array(blocks)) => {
            let mut joined = String::new();
            for c in blocks {
                if as_str(read(c, "type")?) == Some("text") {
                    joined.push_str(&js_string_or_empty(prop(c, "text")));
                }
            }
            Some(joined)
        }
        Some(_) => {
            return Err(JsError::type_error(
                "json.content?.filter is not a function",
            ));
        }
    };
    match content {
        Some(content) if !content.is_empty() => Ok(AiChatResponse::succeeded(text(content))),
        _ => Ok(AiChatResponse::failed(
            "Claude returned an empty response".to_owned(),
        )),
    }
}
