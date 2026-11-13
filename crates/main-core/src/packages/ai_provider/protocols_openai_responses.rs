//! `packages/ai-provider/src/protocols/openai-responses.ts`: the OpenAI
//! Responses API (`POST /v1/responses`). GPT-5.4+ and GPT-6 call tools only
//! here (Chat Completions 400s unless reasoning is off), so this is the route
//! that keeps their reasoning on in the agent loop.
//!
//! Nothing is stored server-side (`store: false`); the reasoning the model did
//! before a tool call comes back as an encrypted item and rides on the turn's
//! first tool call `signature`, the same opaque slot Gemini uses for its
//! thought signature, so the next request can replay it ahead of the function
//! calls.
//!
//! Messages, tool definitions, the provider config and the response items are
//! [`JsonValue`]s, as in `protocols_openai_compatible`.

use std::rc::Rc;

use jscompat::{JsMap, JsObject, JsonValue, json_parse, json_stringify, number_to_string};

use super::fetch::{AiFetch, Init, KeyedFetchBase, keyed_fetch};
use super::http_error::http_body_detail;
use super::jsval::{
    Obj, as_str, coalesce, js_string, js_string_or_empty, number, prop, prop2, text, value_key,
};
use super::protocols_openai_compatible::{
    http_failure, is_str, is_truthy, iterate_or_empty, iterate_or_throw, length_truthy, put,
    read_null_error,
};
use super::protocols_shared::{
    CappedReadOptions, SseDataEvents, StreamCallbacks, endpoint_url, json_body_instead_of_sse,
    parse_tool_input, read_capped_response_text, sse_error_text, throw_if_credits_notice,
    throw_if_tool_count_over_budget, throw_if_tool_json_over_budget, usage_count,
};
use super::task::{JsError, Rt};
use super::types::AiChatResponse;
use super::watchdog::{StreamWatchdog, create_stream_watchdog};

/// `REASONING_SIGNATURE_PREFIX`
const REASONING_SIGNATURE_PREFIX: &str = "oai-rs:";

/// `reasoningSignature(id, encrypted)`
fn reasoning_signature(id: &JsonValue, encrypted: &JsonValue) -> String {
    let mut parsed = Obj::new();
    parsed.set("id", id.clone());
    parsed.set("encrypted", encrypted.clone());
    format!(
        "{REASONING_SIGNATURE_PREFIX}{}",
        json_stringify(&JsonValue::Object(parsed))
    )
}

/// `parseReasoningSignature(signature)`: `(id, encrypted)`
fn parse_reasoning_signature(signature: Option<&str>) -> Option<(String, String)> {
    let rest = signature?.strip_prefix(REASONING_SIGNATURE_PREFIX)?;
    let parsed = json_parse(rest).ok()?;
    match (prop(&parsed, "id"), prop(&parsed, "encrypted")) {
        (Some(JsonValue::String(id)), Some(JsonValue::String(encrypted))) => {
            Some((id.clone(), encrypted.clone()))
        }
        _ => None,
    }
}

/// `responsesInput(messages)`
fn responses_input(messages: &JsonValue) -> Result<JsonValue, JsError> {
    let mut out: Vec<JsonValue> = Vec::new();
    for m in iterate_or_throw(Some(messages), "messages")? {
        let role = prop(m, "role");
        if is_str(role, "user") {
            let images = prop(m, "images");
            let mut content: Vec<JsonValue> = Vec::new();
            if is_truthy(prop(m, "text")) || !length_truthy(images) {
                let mut part = Obj::new();
                part.set("type", text("input_text"));
                put(&mut part, "text", prop(m, "text"));
                content.push(JsonValue::Object(part));
            }
            match images {
                None | Some(JsonValue::Null) => {}
                Some(JsonValue::Array(images)) => {
                    for img in images {
                        let mut part = Obj::new();
                        part.set("type", text("input_image"));
                        part.set(
                            "image_url",
                            text(format!(
                                "data:{};base64,{}",
                                value_key(prop(img, "mime")),
                                value_key(prop(img, "base64"))
                            )),
                        );
                        part.set("detail", text("auto"));
                        content.push(JsonValue::Object(part));
                    }
                }
                Some(_) => {
                    return Err(JsError::type_error(
                        "(m.images ?? []).map is not a function",
                    ));
                }
            }
            let mut user = Obj::new();
            user.set("role", text("user"));
            user.set("content", JsonValue::Array(content));
            out.push(JsonValue::Object(user));
        } else if is_str(role, "assistant") {
            let calls: &[JsonValue] = match prop(m, "toolCalls") {
                None | Some(JsonValue::Null) => &[],
                Some(JsonValue::Array(calls)) => calls,
                Some(_) => return Err(JsError::type_error("m.toolCalls.map is not a function")),
            };
            let signature = calls
                .first()
                .and_then(|call| prop(call, "signature"))
                .and_then(|s| as_str(Some(s)));
            if let Some((id, encrypted)) = parse_reasoning_signature(signature) {
                let mut item = Obj::new();
                item.set("type", text("reasoning"));
                item.set("id", text(id));
                item.set("encrypted_content", text(encrypted));
                item.set("summary", JsonValue::Array(Vec::new()));
                out.push(JsonValue::Object(item));
            }
            // an assistant item with no text and no calls is an empty turn the API
            // rejects, so keep the placeholder the Chat Completions path uses
            if is_truthy(prop(m, "text")) || calls.is_empty() {
                let mut part = Obj::new();
                part.set("type", text("output_text"));
                if is_truthy(prop(m, "text")) {
                    put(&mut part, "text", prop(m, "text"));
                } else {
                    part.set("text", text("(no content)"));
                }
                let mut item = Obj::new();
                item.set("role", text("assistant"));
                item.set("content", JsonValue::Array(vec![JsonValue::Object(part)]));
                out.push(JsonValue::Object(item));
            }
            for call in calls {
                let mut item = Obj::new();
                item.set("type", text("function_call"));
                put(&mut item, "call_id", prop(call, "id"));
                put(&mut item, "name", prop(call, "name"));
                if let Some(input) = prop(call, "input") {
                    item.set("arguments", text(json_stringify(input)));
                }
                out.push(JsonValue::Object(item));
            }
        } else {
            for r in iterate_or_throw(prop(m, "results"), "m.results")? {
                let mut item = Obj::new();
                item.set("type", text("function_call_output"));
                put(&mut item, "call_id", prop(r, "id"));
                if is_truthy(prop(r, "isError")) {
                    item.set(
                        "output",
                        text(format!("Error: {}", value_key(prop(r, "output")))),
                    );
                } else {
                    put(&mut item, "output", prop(r, "output"));
                }
                out.push(JsonValue::Object(item));
            }
        }
    }
    Ok(JsonValue::Array(out))
}

/// `OpenAiResponsesOptions`: per-endpoint request shaping resolved from the
/// provider registry.
#[derive(Debug, Clone, Default)]
pub struct OpenAiResponsesOptions {
    /// `reasoning.effort` to request; absent = the model's default
    pub reasoning_effort: Option<String>,
    /// vendor-specific fields merged into the request body
    pub body_extras: Option<Obj>,
    pub headers: Option<JsObject<String>>,
    pub idle_timeout_ms: Option<f64>,
}

/// `requestBody(config, system, input, tools, maxTokens, options, stream)`
fn request_body(
    config: &JsonValue,
    system: &str,
    input: JsonValue,
    tools: &JsonValue,
    max_tokens: f64,
    options: &OpenAiResponsesOptions,
    stream: bool,
) -> String {
    let mut body = Obj::new();
    put(&mut body, "model", prop(config, "model"));
    body.set("instructions", text(system));
    body.set("input", input);
    if let JsonValue::Array(defs) = tools
        && !defs.is_empty()
    {
        let mut mapped: Vec<JsonValue> = Vec::new();
        for t in defs {
            let mut tool = Obj::new();
            tool.set("type", text("function"));
            put(&mut tool, "name", prop(t, "name"));
            put(&mut tool, "description", prop(t, "description"));
            put(&mut tool, "parameters", prop(t, "inputSchema"));
            tool.set("strict", JsonValue::Bool(false));
            mapped.push(JsonValue::Object(tool));
        }
        body.set("tools", JsonValue::Array(mapped));
    }
    body.set("max_output_tokens", number(max_tokens));
    body.set("store", JsonValue::Bool(false));
    body.set(
        "include",
        JsonValue::Array(vec![text("reasoning.encrypted_content")]),
    );
    let mut reasoning = Obj::new();
    reasoning.set("summary", text("auto"));
    if let Some(effort) = options.reasoning_effort.as_ref().filter(|e| !e.is_empty()) {
        reasoning.set("effort", text(effort.clone()));
    }
    body.set("reasoning", JsonValue::Object(reasoning));
    if let Some(extras) = &options.body_extras {
        body.assign(extras);
    }
    body.set("stream", JsonValue::Bool(stream));
    json_stringify(&JsonValue::Object(body))
}

/// `usageOf(raw)`
fn usage_of(raw: Option<&JsonValue>) -> Option<JsonValue> {
    let raw = raw.filter(|r| r.truthy())?;
    let input = usage_count(prop(raw, "input_tokens"));
    let output = usage_count(prop(raw, "output_tokens"));
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

/// `item.type` of an item; a `null` item throws as the read does.
fn item_type(item: &JsonValue) -> Result<Option<&JsonValue>, JsError> {
    if matches!(item, JsonValue::Null) {
        return Err(read_null_error("type"));
    }
    Ok(prop(item, "type"))
}

/// `emitFinishedItems(items, response, cb, alreadyStreamed)`: turns the
/// completed items of one response into callbacks; shared by the SSE and JSON
/// paths.
fn emit_finished_items(
    rt: &Rt,
    items: &[JsonValue],
    response: Option<&JsonValue>,
    cb: &StreamCallbacks,
    already_streamed: bool,
) -> Result<bool, JsError> {
    let mut emitted = already_streamed;
    let mut reasoning: Option<(JsonValue, JsonValue)> = None;
    let mut tool_calls: Vec<Obj> = Vec::new();
    for item in items {
        let kind = item_type(item)?;
        if is_str(kind, "reasoning") {
            if let (Some(id), Some(encrypted)) = (
                prop(item, "id").filter(|v| v.truthy()),
                prop(item, "encrypted_content").filter(|v| v.truthy()),
            ) {
                reasoning = Some((id.clone(), encrypted.clone()));
            }
            if !already_streamed {
                for part in iterate_or_empty(prop(item, "summary"))? {
                    if let Some(part_text) = prop(part, "text").filter(|t| t.truthy()) {
                        emitted = true;
                        if let Some(on_reasoning_delta) = &cb.on_reasoning_delta {
                            on_reasoning_delta(part_text.clone());
                        }
                    }
                }
            }
        } else if is_str(kind, "message") {
            if !already_streamed {
                for part in iterate_or_empty(prop(item, "content"))? {
                    if is_str(prop(part, "type"), "output_text")
                        && let Some(part_text) = prop(part, "text").filter(|t| t.truthy())
                    {
                        emitted = true;
                        (cb.on_delta)(part_text.clone());
                    }
                }
            }
        } else if is_str(kind, "function_call") && is_truthy(prop(item, "name")) {
            throw_if_tool_count_over_budget(tool_calls.len() as f64 + 1.0, "openai-responses")?;
            let arguments = match prop(item, "arguments") {
                None | Some(JsonValue::Null) => String::new(),
                Some(JsonValue::String(s)) => s.clone(),
                Some(_) => return Err(JsError::type_error("json.trim is not a function")),
            };
            let (input, error) = parse_tool_input(&arguments);
            let mut call = Obj::new();
            match coalesce(coalesce(prop(item, "call_id"), prop(item, "id")), None) {
                Some(id) => call.set("id", id.clone()),
                None => call.set("id", text(rt.random_uuid())),
            }
            put(&mut call, "name", prop(item, "name"));
            call.set("input", JsonValue::Object(input));
            if let Some(error) = error {
                call.set("inputError", text(error));
            }
            tool_calls.push(call);
        }
    }
    let cut_off = is_str(
        response.and_then(|r| prop2(Some(r), "incomplete_details", "reason")),
        "max_output_tokens",
    );
    if cut_off && let Some(last) = tool_calls.last_mut() {
        last.set("truncated", JsonValue::Bool(true));
    }
    if let (Some((id, encrypted)), Some(first)) = (&reasoning, tool_calls.first_mut()) {
        first.set("signature", text(reasoning_signature(id, encrypted)));
    }
    for call in tool_calls {
        emitted = true;
        (cb.on_tool_call)(JsonValue::Object(call));
    }
    if cut_off && let Some(on_stop_reason) = &cb.on_stop_reason {
        on_stop_reason(text("max_tokens"));
    }
    if let Some(usage) = usage_of(response.and_then(|r| prop(r, "usage")))
        && let Some(on_usage) = &cb.on_usage
    {
        on_usage(usage);
    }
    Ok(emitted)
}

/// `emitJsonResponse(bodyText, cb)`
fn emit_json_response(rt: &Rt, body_text: &str, cb: &StreamCallbacks) -> Result<(), JsError> {
    let response = match json_parse(body_text) {
        Ok(response) => response,
        Err(_) => {
            return Err(JsError::error(format!(
                "The model returned an unparseable JSON body: {}",
                http_body_detail(body_text)?
            )));
        }
    };
    if matches!(response, JsonValue::Null) {
        return Err(read_null_error("error"));
    }
    if is_truthy(prop(&response, "error")) {
        return Err(JsError::error(sse_error_text(
            prop(&response, "error"),
            "Model error",
        )));
    }
    let output: &[JsonValue] = match prop(&response, "output") {
        None | Some(JsonValue::Null) => &[],
        other => iterate_or_throw(other, "items")?,
    };
    let emitted = emit_finished_items(rt, output, Some(&response), cb, false)?;
    if !emitted {
        return Err(JsError::error(format!(
            "The model returned no content: {}",
            http_body_detail(body_text)?
        )));
    }
    Ok(())
}

/// The headers of a request: `Content-Type`, the key, then `options.headers`.
fn headers_of(config: &JsonValue, options: &OpenAiResponsesOptions) -> Vec<(String, String)> {
    let mut headers: JsObject<String> = JsObject::new();
    headers.set("Content-Type", "application/json".to_owned());
    if is_truthy(prop(config, "apiKey")) {
        headers.set(
            "Authorization",
            format!("Bearer {}", value_key(prop(config, "apiKey"))),
        );
    }
    if let Some(extra) = &options.headers {
        headers.assign(extra);
    }
    headers
        .entries()
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.clone()))
        .collect()
}

/// `streamOpenAiResponses(baseUrl, config, system, messages, tools,
/// maxTokens, cb, options)`
#[allow(clippy::too_many_arguments)]
pub async fn stream_open_ai_responses(
    rt: &Rt,
    fx: &AiFetch,
    base_url: &str,
    config: &JsonValue,
    system: &str,
    messages: &JsonValue,
    tools: &JsonValue,
    max_tokens: f64,
    cb: &StreamCallbacks,
    options: &OpenAiResponsesOptions,
) -> Result<(), JsError> {
    let wd = create_stream_watchdog(rt, Some(&cb.signal), None, options.idle_timeout_ms);
    wd.guard(responses_turn(
        rt, fx, base_url, config, system, messages, tools, max_tokens, cb, &wd, options,
    ))
    .await
}

/// The `Map` key `argumentChars` uses for a value (a string key is itself).
fn map_key(value: &JsonValue, objects: &mut u64) -> String {
    match value {
        JsonValue::String(s) => format!("s{s}"),
        JsonValue::Number(x) => format!("d{}", number_to_string(*x)),
        JsonValue::Bool(b) => format!("b{b}"),
        JsonValue::Null => "n".to_owned(),
        JsonValue::Array(_) | JsonValue::Object(_) => {
            *objects += 1;
            format!("o{objects}")
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn responses_turn(
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
    options: &OpenAiResponsesOptions,
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
    let url = endpoint_url(base_url, "responses", None)?;
    let headers = headers_of(config, options);
    let body = request_body(
        config,
        system,
        responses_input(messages)?,
        tools,
        max_tokens,
        options,
        true,
    );
    let init = Init {
        request: post_text(headers, body),
        signal: Some(wd.signal.clone()),
    };
    let response = keyed_fetch(rt, fx, &url, &init, None, &KeyedFetchBase::Ai).await?;
    on_bytes();
    if !response.ok() || !response.has_body() {
        return Err(JsError::error(
            http_failure(&response, on_bytes.clone()).await?,
        ));
    }
    if let Some(json_body) = json_body_instead_of_sse(&response, Some(on_bytes.clone())).await? {
        throw_if_credits_notice(&json_body)?;
        return emit_json_response(rt, &json_body, cb);
    }
    // function_call arguments stream per item; the item itself arrives complete
    // in output_item.done, which is what the turn is assembled from
    let mut argument_chars: JsMap<f64> = JsMap::new();
    let mut objects: u64 = 0;
    let mut finished: Vec<JsonValue> = Vec::new();
    let mut streamed_any = false;
    let mut completed: Option<JsonValue> = None;
    let mut terminal = false;
    {
        let mut events = SseDataEvents::new(&response, Some(on_bytes.clone()));
        while let Some(sse) = events.next().await? {
            if sse.raw == "[DONE]" {
                break;
            }
            let Some(event) = sse.json else {
                continue;
            };
            if matches!(event, JsonValue::Null) {
                return Err(read_null_error("type"));
            }
            match as_str(prop(&event, "type")) {
                Some("response.output_text.delta") => {
                    if let Some(delta) = prop(&event, "delta").filter(|d| d.truthy()) {
                        streamed_any = true;
                        (cb.on_delta)(delta.clone());
                    }
                }
                Some("response.reasoning_summary_text.delta") => {
                    if let Some(delta) = prop(&event, "delta").filter(|d| d.truthy()) {
                        streamed_any = true;
                        if let Some(on_reasoning_delta) = &cb.on_reasoning_delta {
                            on_reasoning_delta(delta.clone());
                        }
                    }
                }
                Some("response.output_item.added") => {
                    let item = prop(&event, "item");
                    if is_str(item.and_then(|i| prop(i, "type")), "function_call") {
                        throw_if_tool_count_over_budget(
                            argument_chars.len() as f64 + 1.0,
                            "openai-responses",
                        )?;
                        let key = match item.and_then(|i| coalesce(prop(i, "id"), None)) {
                            Some(id) => map_key(id, &mut objects),
                            None => format!("s{}", argument_chars.len()),
                        };
                        argument_chars.set(key, 0.0);
                    }
                }
                Some("response.function_call_arguments.delta") => {
                    let key = match coalesce(prop(&event, "item_id"), None) {
                        Some(id) => map_key(id, &mut objects),
                        None => "s".to_owned(),
                    };
                    let delta_length = match prop(&event, "delta")
                        .and_then(|d| d.get("length"))
                        .as_deref()
                    {
                        Some(JsonValue::Number(n)) => *n,
                        _ => 0.0,
                    };
                    let total = argument_chars.get(&key).copied().unwrap_or(0.0) + delta_length;
                    throw_if_tool_json_over_budget(total, "openai-responses")?;
                    argument_chars.set(key, total);
                }
                Some("response.output_item.done") => {
                    if let Some(item) = prop(&event, "item").filter(|i| i.truthy()) {
                        finished.push(item.clone());
                    }
                }
                Some("response.completed" | "response.incomplete") => {
                    completed = prop(&event, "response").cloned();
                    terminal = true;
                }
                Some("response.failed") => {
                    let error = coalesce(
                        prop(&event, "response").and_then(|r| prop(r, "error")),
                        None,
                    );
                    let fallback = text("response.failed");
                    return Err(JsError::error(sse_error_text(
                        Some(error.unwrap_or(&fallback)),
                        "Model stream error",
                    )));
                }
                Some("error") => {
                    let error = coalesce(
                        prop(&event, "error"),
                        coalesce(prop(&event, "message"), Some(&event)),
                    );
                    return Err(JsError::error(sse_error_text(error, "Model stream error")));
                }
                _ => {}
            }
            if terminal {
                break;
            }
        }
        // leaving the loop closes the generator: the body is cancelled
        drop(events);
    }
    if !terminal {
        let mut sent_call = false;
        for item in &finished {
            if is_str(item_type(item)?, "function_call") {
                sent_call = true;
                break;
            }
        }
        if sent_call || !argument_chars.is_empty() {
            return Err(JsError::error(
                "The model stream closed while sending tool arguments; the connection was dropped. If this recurs on a large request (e.g. generating a whole document), ask for the output in several smaller parts.",
            ));
        }
        if streamed_any {
            return Err(JsError::error(
                "The model stream ended before response.completed",
            ));
        }
    }
    let emitted = emit_finished_items(rt, &finished, completed.as_ref(), cb, streamed_any)?;
    if !emitted {
        return Err(JsError::error(if terminal {
            format!(
                "The model returned no content (status={})",
                match coalesce(completed.as_ref().and_then(|c| prop(c, "status")), None) {
                    Some(status) => js_string(status),
                    None => "unknown".to_owned(),
                }
            )
        } else {
            "The model returned no content (empty stream)".to_owned()
        }));
    }
    Ok(())
}

/// `post` with a body already written.
fn post_text(headers: Vec<(String, String)>, body: String) -> super::task::Request {
    super::task::Request {
        method: Some("POST".to_owned()),
        headers,
        body: Some(super::task::RequestBody::Text(body)),
        redirect: None,
    }
}

/// `chatOpenAiResponses(wd, baseUrl, config, system, user, options)`
#[allow(clippy::too_many_arguments)]
pub async fn chat_open_ai_responses(
    rt: &Rt,
    fx: &AiFetch,
    wd: &StreamWatchdog,
    base_url: &str,
    config: &JsonValue,
    system: &str,
    user: &str,
    options: &OpenAiResponsesOptions,
) -> Result<AiChatResponse, JsError> {
    let url = endpoint_url(base_url, "responses", None)?;
    let headers = headers_of(config, options);
    let mut message = Obj::new();
    message.set("role", text("user"));
    message.set("text", text(user));
    let body = request_body(
        config,
        system,
        responses_input(&JsonValue::Array(vec![JsonValue::Object(message)]))?,
        &JsonValue::Array(Vec::new()),
        // one-shot chats are prose: leave the model its own ceiling
        16384.0,
        options,
        false,
    );
    let init = Init {
        request: post_text(headers, body),
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
        return Err(read_null_error("error"));
    }
    if is_truthy(prop(&json, "error")) {
        return Ok(AiChatResponse::failed(sse_error_text(
            prop(&json, "error"),
            "Model error",
        )));
    }
    let output: &[JsonValue] = match prop(&json, "output") {
        None | Some(JsonValue::Null) => &[],
        Some(JsonValue::Array(items)) => items,
        Some(_) => {
            return Err(JsError::type_error(
                "(json.output ?? []).filter is not a function",
            ));
        }
    };
    let mut content = String::new();
    for item in output {
        if !is_str(item_type(item)?, "message") {
            continue;
        }
        for part in iterate_or_empty(prop(item, "content"))? {
            if is_str(prop(part, "type"), "output_text") {
                content.push_str(&js_string_or_empty(prop(part, "text")));
            }
        }
    }
    if content.is_empty() {
        return Ok(AiChatResponse::failed(
            "AI returned an empty response".to_owned(),
        ));
    }
    Ok(AiChatResponse::succeeded(text(content)))
}
