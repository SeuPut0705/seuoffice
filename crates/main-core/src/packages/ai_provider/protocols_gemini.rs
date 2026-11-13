//! `packages/ai-provider/src/protocols/gemini.ts`: the Gemini
//! `generateContent` protocol, streamed and not.
//!
//! Messages, tools, settings and every chunk of a stream are [`JsonValue`]s,
//! read as the TypeScript reads loosely typed data: see `protocols_anthropic`
//! for the helpers ([`read`], [`items_or_empty`]) that reproduce what a `null`
//! or a value of the wrong type makes it throw.

use std::borrow::Cow;
use std::rc::Rc;

use jscompat::{JsonValue, json_parse, json_stringify, number_to_string};

use super::fetch::{AiFetch, Init, KeyedFetchBase, keyed_fetch};
use super::http_error::http_body_detail;
use super::jsval::{
    Obj, as_str, coalesce, js_string, js_string_or_empty, number, object, prop, prop2, slice_to,
    text, value_key,
};
use super::protocols_anthropic::{
    array_to_map, has_usage, items_or_empty, on_bytes_of, read, set_some, tool_defs, truthy,
};
use super::protocols_gemini_schema::to_gemini_schema;
use super::protocols_shared::{
    CappedReadOptions, SseDataEvents, StreamCallbacks, endpoint_url, is_plain_object,
    json_body_instead_of_sse, read_capped_response_text, sse_error_text, throw_if_credits_notice,
    throw_if_tool_count_over_budget, usage_count,
};
use super::providers::opencode_session_headers;
use super::task::{JsError, Request, RequestBody, Rt};
use super::types::AiChatResponse;
use super::watchdog::{StreamWatchdog, create_stream_watchdog};

pub const GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";

/// Merge a Gemini usageMetadata object into an accumulator (every stream chunk carries
/// one; the last chunk's counts are the turn's totals).
fn merge_gemini_usage(target: &mut Obj, usage: Option<&JsonValue>) {
    let Some(usage) = usage.filter(|u| u.truthy()) else {
        return;
    };
    let input = usage_count(prop(usage, "promptTokenCount"));
    let output = usage_count(prop(usage, "candidatesTokenCount"));
    if let Some(input) = input {
        target.set("inputTokens", number(input));
    }
    if let Some(output) = output {
        target.set("outputTokens", number(output));
    }
}

// Gemini 3 rejects a model turn whose first functionCall lacks its thoughtSignature;
// calls that never had one (other provider's history) go back with Google's bypass sentinel.
const SKIP_SIGNATURE: &str = "skip_thought_signature_validator";

/// `geminiToolCall(part)`: an `AgentToolCall` of a part that holds a function call.
fn gemini_tool_call(rt: &Rt, part: &JsonValue) -> Obj {
    let signature = coalesce(
        prop(part, "thoughtSignature"),
        prop(part, "thought_signature"),
    );
    let args = prop2(Some(part), "functionCall", "args");
    let input_error = match args {
        None => None,
        Some(args) if is_plain_object(Some(args)) => None,
        Some(args) => Some(format!(
            "tool input must be a JSON object; raw: {}",
            slice_to(&json_stringify(args), 500)
        )),
    };
    let mut call = Obj::new();
    call.set("id", text(rt.random_uuid()));
    call.set(
        "name",
        coalesce(prop2(Some(part), "functionCall", "name"), None)
            .cloned()
            .unwrap_or_else(|| text("")),
    );
    call.set(
        "input",
        match args {
            Some(args @ JsonValue::Object(_)) => args.clone(),
            _ => JsonValue::Object(Obj::new()),
        },
    );
    if let Some(error) = input_error {
        call.set("inputError", text(error));
    }
    if let Some(signature) = signature
        && signature.truthy()
    {
        call.set("signature", signature.clone());
    }
    call
}

/// `(m.toolCalls ?? []).entries()`: the items of an array.
fn tool_call_entries(value: Option<&JsonValue>) -> Result<Vec<JsonValue>, JsError> {
    match coalesce(value, None) {
        None => Ok(Vec::new()),
        Some(JsonValue::Array(items)) => Ok(items.clone()),
        Some(_) => Err(JsError::type_error(
            "(m.toolCalls ?? []).entries is not a function or its return value is not iterable",
        )),
    }
}

fn gemini_contents(messages: &JsonValue) -> Result<Vec<JsonValue>, JsError> {
    let mut out = Vec::new();
    for m in array_to_map(Some(messages), "messages.map is not a function")? {
        let role = read(m, "role")?;
        if as_str(role) == Some("user") {
            let images = prop(m, "images");
            let has_images = images
                .and_then(|i| i.get("length"))
                .is_some_and(|len| len.truthy());
            if !has_images {
                let mut part = Obj::new();
                set_some(&mut part, "text", prop(m, "text"));
                out.push(object(vec![
                    ("role", text("user")),
                    ("parts", JsonValue::Array(vec![JsonValue::Object(part)])),
                ]));
                continue;
            }
            let mut parts = Vec::new();
            if truthy(prop(m, "text")) {
                parts.push(object(vec![(
                    "text",
                    prop(m, "text").cloned().unwrap_or(JsonValue::Null),
                )]));
            }
            for img in array_to_map(
                images,
                "m.images.map is not a function or its return value is not iterable",
            )? {
                let mut inline = Obj::new();
                set_some(&mut inline, "mime_type", read(img, "mime")?);
                set_some(&mut inline, "data", read(img, "base64")?);
                parts.push(object(vec![("inline_data", JsonValue::Object(inline))]));
            }
            out.push(object(vec![
                ("role", text("user")),
                ("parts", JsonValue::Array(parts)),
            ]));
            continue;
        }
        if as_str(role) == Some("assistant") {
            let mut parts = Vec::new();
            if truthy(prop(m, "text")) {
                parts.push(object(vec![(
                    "text",
                    prop(m, "text").cloned().unwrap_or(JsonValue::Null),
                )]));
            }
            for (i, call) in tool_call_entries(prop(m, "toolCalls"))?.iter().enumerate() {
                let signature = match coalesce(read(call, "signature")?, None) {
                    Some(signature) => Some(signature.clone()),
                    None if i == 0 => Some(text(SKIP_SIGNATURE)),
                    None => None,
                };
                let mut function_call = Obj::new();
                set_some(&mut function_call, "name", read(call, "name")?);
                set_some(&mut function_call, "args", read(call, "input")?);
                let mut part = Obj::new();
                part.set("functionCall", JsonValue::Object(function_call));
                if let Some(signature) = signature
                    && signature.truthy()
                {
                    part.set("thoughtSignature", signature);
                }
                parts.push(JsonValue::Object(part));
            }
            // Gemini rejects model turns with empty parts lists.
            if parts.is_empty() {
                parts.push(object(vec![("text", text("(no content)"))]));
            }
            out.push(object(vec![
                ("role", text("model")),
                ("parts", JsonValue::Array(parts)),
            ]));
            continue;
        }
        let mut parts = Vec::new();
        for r in array_to_map(prop(m, "results"), "m.results.map is not a function")? {
            let mut function_response = Obj::new();
            set_some(&mut function_response, "name", read(r, "name")?);
            let mut response = Obj::new();
            if truthy(read(r, "isError")?) {
                set_some(&mut response, "error", read(r, "output")?);
            } else {
                set_some(&mut response, "result", read(r, "output")?);
            }
            function_response.set("response", JsonValue::Object(response));
            parts.push(object(vec![(
                "functionResponse",
                JsonValue::Object(function_response),
            )]));
        }
        out.push(object(vec![
            ("role", text("user")),
            ("parts", JsonValue::Array(parts)),
        ]));
    }
    Ok(out)
}

/// `value?.[0]`
fn first_of(value: Option<&JsonValue>) -> Option<JsonValue> {
    match value {
        None | Some(JsonValue::Null) => None,
        Some(value) => value.get("0").map(Cow::into_owned),
    }
}

/// What one chunk adds to a turn: the reasons it finished with.
struct Finish {
    stop_reason: Option<&'static str>,
    abnormal: Option<JsonValue>,
}

/// The `finishReason` of a chunk's first candidate, sorted as both paths sort it.
/// Answers whether the chunk names one at all.
fn finish_of(candidate: Option<&JsonValue>, finish: &mut Finish) -> bool {
    let reason = candidate.and_then(|c| prop(c, "finishReason"));
    if reason.is_some_and(|r| r.truthy()) {
        if as_str(reason) == Some("MAX_TOKENS") {
            finish.stop_reason = Some("max_tokens");
        } else if as_str(reason) != Some("STOP") {
            finish.abnormal = reason.cloned();
        }
        return true;
    }
    false
}

/// Emits a complete (non-streamed) Gemini response delivered as a plain JSON body.
/// `streamGenerateContent` without SSE framing yields an array of chunks; a gateway
/// may also send a single `generateContent`-shaped object: handle both.
fn emit_gemini_json_message(rt: &Rt, body_text: &str, cb: &StreamCallbacks) -> Result<(), JsError> {
    let Ok(parsed) = json_parse(body_text) else {
        return Err(JsError::error(format!(
            "Gemini returned an unparseable JSON body: {}",
            http_body_detail(body_text)?
        )));
    };
    let events = match parsed {
        JsonValue::Array(events) => events,
        single => vec![single],
    };
    let mut emitted = false;
    let mut tool_call_count = 0.0;
    let mut finish = Finish {
        stop_reason: None,
        abnormal: None,
    };
    let mut usage = Obj::new();
    for event in &events {
        let error = read(event, "error")?;
        if truthy(error) {
            return Err(JsError::error(sse_error_text(error, "Gemini error")));
        }
        if let Some(reason) = prop(event, "promptFeedback").and_then(|f| prop(f, "blockReason"))
            && reason.truthy()
        {
            return Err(JsError::error(format!(
                "Gemini blocked the prompt ({})",
                js_string(reason)
            )));
        }
        merge_gemini_usage(&mut usage, prop(event, "usageMetadata"));
        let candidate = first_of(prop(event, "candidates"));
        finish_of(candidate.as_ref(), &mut finish);
        for part in items_or_empty(prop2(candidate.as_ref(), "content", "parts"))? {
            let part_text = read(&part, "text")?;
            if truthy(part_text) {
                emitted = true;
                (cb.on_delta)(part_text.cloned().unwrap_or(JsonValue::Null));
            }
            if truthy(prop2(Some(&part), "functionCall", "name")) {
                emitted = true;
                // A complete JSON body carries the whole turn at once, so the per-turn
                // tool budget of the streamed path has to be applied here as well
                tool_call_count += 1.0;
                throw_if_tool_count_over_budget(tool_call_count, "gemini")?;
                (cb.on_tool_call)(JsonValue::Object(gemini_tool_call(rt, &part)));
            }
        }
    }
    if !emitted {
        return Err(JsError::error(match &finish.abnormal {
            Some(abnormal) => format!(
                "Gemini returned no content (finishReason={})",
                js_string(abnormal)
            ),
            None => format!(
                "Gemini returned no content: {}",
                http_body_detail(body_text)?
            ),
        }));
    }
    if let Some(reason) = finish.stop_reason
        && let Some(on_stop_reason) = &cb.on_stop_reason
    {
        on_stop_reason(text(reason));
    }
    if has_usage(&usage)
        && let Some(on_usage) = &cb.on_usage
    {
        on_usage(JsonValue::Object(usage));
    }
    Ok(())
}

/// `GeminiRequestOptions`: per-endpoint request shaping resolved from the
/// provider registry.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GeminiRequestOptions {
    pub omit_temperature: Option<bool>,
}

/// `streamGemini(config, system, messages, tools, maxTokens, cb, baseUrl,
/// options)`; `None` for `base_url` is its default.
#[allow(clippy::too_many_arguments)]
pub async fn stream_gemini(
    rt: &Rt,
    fx: &AiFetch,
    config: &JsonValue,
    system: &str,
    messages: &JsonValue,
    tools: &JsonValue,
    max_tokens: f64,
    cb: &StreamCallbacks,
    base_url: Option<&str>,
    options: &GeminiRequestOptions,
) -> Result<(), JsError> {
    let base_url = base_url.unwrap_or(GEMINI_BASE_URL);
    let wd = create_stream_watchdog(rt, Some(&cb.signal), None, None);
    wd.guard(gemini_turn(
        rt, fx, config, system, messages, tools, max_tokens, cb, base_url, &wd, options,
    ))
    .await
}

/// `systemInstruction: { parts: [{ text: system }] }`
fn system_instruction(system: &str) -> JsonValue {
    object(vec![(
        "parts",
        JsonValue::Array(vec![object(vec![("text", text(system))])]),
    )])
}

#[allow(clippy::too_many_arguments)]
async fn gemini_turn(
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
    options: &GeminiRequestOptions,
) -> Result<(), JsError> {
    let on_bytes = on_bytes_of(wd, cb);
    let url = endpoint_url(
        base_url,
        &format!(
            "models/{}:streamGenerateContent",
            value_key(prop(config, "model"))
        ),
        Some("?alt=sse"),
    )?;
    let mut headers = vec![
        ("Content-Type".to_owned(), "application/json".to_owned()),
        (
            "x-goog-api-key".to_owned(),
            value_key(prop(config, "apiKey")),
        ),
    ];
    headers.extend(opencode_session_headers(
        rt,
        Some(base_url),
        cb.session_id.as_deref(),
    ));
    let mut body = Obj::new();
    body.set("systemInstruction", system_instruction(system));
    body.set("contents", JsonValue::Array(gemini_contents(messages)?));
    let tool_list = tool_defs(tools);
    if !tool_list.is_empty() {
        let mut declarations = Vec::new();
        for t in tool_list {
            let mut declaration = Obj::new();
            set_some(&mut declaration, "name", prop(t, "name"));
            set_some(&mut declaration, "description", prop(t, "description"));
            // JSON Schema constructs the Gemini proto lacks (type unions,
            // $ref, ...) fail the whole request with HTTP 400
            declaration.set(
                "parameters",
                JsonValue::Object(to_gemini_schema(prop(t, "inputSchema"))?),
            );
            declarations.push(JsonValue::Object(declaration));
        }
        body.set(
            "tools",
            JsonValue::Array(vec![object(vec![(
                "functionDeclarations",
                JsonValue::Array(declarations),
            )])]),
        );
    }
    // Google recommends the default temperature (1.0) for the Gemini 3
    // family: lower values may cause looping or degraded reasoning, so omit
    // our hard-coded 0.3 for those models via omitTemperature.
    let mut generation_config = Obj::new();
    if options.omit_temperature != Some(true) {
        generation_config.set("temperature", number(0.3));
    }
    generation_config.set("maxOutputTokens", number(max_tokens));
    body.set("generationConfig", JsonValue::Object(generation_config));
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
    // headers arrived: ping the renderer watchdog too, or a slow first chunk could trip it
    on_bytes();
    if !response.ok() || !response.has_body() {
        let detail =
            read_capped_response_text(&response, &CappedReadOptions::on_bytes(on_bytes.clone()))
                .await?;
        return Err(JsError::error(format!(
            "Gemini HTTP {}: {}",
            number_to_string(response.status()),
            http_body_detail(&detail)?
        )));
    }
    if let Some(json_body) = json_body_instead_of_sse(&response, Some(on_bytes.clone())).await? {
        throw_if_credits_notice(&json_body)?;
        return emit_gemini_json_message(rt, &json_body, cb);
    }
    let mut finish = Finish {
        stop_reason: None,
        abnormal: None,
    };
    let mut saw_finish = false;
    let mut emitted = false;
    let mut tool_call_count = 0.0;
    let mut turn_usage = Obj::new();
    {
        let mut events = SseDataEvents::new(&response, Some(on_bytes.clone()));
        while let Some(sse) = events.next().await? {
            // A truncated frame or a non-JSON keep-alive from a proxy skips that event
            // rather than killing the turn.
            let Some(event) = &sse.json else { continue };
            let error = read(event, "error")?;
            if truthy(error) {
                return Err(JsError::error(sse_error_text(error, "Gemini stream error")));
            }
            if let Some(reason) = prop(event, "promptFeedback").and_then(|f| prop(f, "blockReason"))
                && reason.truthy()
            {
                return Err(JsError::error(format!(
                    "Gemini blocked the prompt ({})",
                    js_string(reason)
                )));
            }
            // every chunk carries usageMetadata; later chunks supersede earlier ones
            merge_gemini_usage(&mut turn_usage, prop(event, "usageMetadata"));
            let candidate = first_of(prop(event, "candidates"));
            if finish_of(candidate.as_ref(), &mut finish) {
                saw_finish = true;
            }
            for part in items_or_empty(prop2(candidate.as_ref(), "content", "parts"))? {
                let part_text = read(&part, "text")?;
                if truthy(part_text) {
                    emitted = true;
                    (cb.on_delta)(part_text.cloned().unwrap_or(JsonValue::Null));
                }
                // Gemini emits function calls whole, never as partial JSON
                if truthy(prop2(Some(&part), "functionCall", "name")) {
                    tool_call_count += 1.0;
                    throw_if_tool_count_over_budget(tool_call_count, "gemini")?;
                    emitted = true;
                    (cb.on_tool_call)(JsonValue::Object(gemini_tool_call(rt, &part)));
                }
            }
        }
    }
    // A safety/recitation stop that produced nothing, or a stream with no message
    // framing at all (gateway soft-failure), would otherwise look like an empty
    // success; a genuine empty turn still carries finishReason=STOP and passes
    if !emitted && let Some(abnormal) = &finish.abnormal {
        return Err(JsError::error(format!(
            "Gemini returned no content (finishReason={})",
            js_string(abnormal)
        )));
    }
    if !emitted && !saw_finish {
        return Err(JsError::error("Gemini returned no content (empty stream)"));
    }
    if !saw_finish {
        return Err(JsError::error("Gemini stream ended before a finishReason"));
    }
    if let Some(reason) = finish.stop_reason
        && let Some(on_stop_reason) = &cb.on_stop_reason
    {
        on_stop_reason(text(reason));
    }
    if has_usage(&turn_usage)
        && let Some(on_usage) = &cb.on_usage
    {
        on_usage(JsonValue::Object(turn_usage));
    }
    Ok(())
}

/// `chatGemini(wd, config, system, user, baseUrl, options)`: an
/// `AiChatResponse`, `{ ok: false, error }` or `{ ok: true, content }`.
#[allow(clippy::too_many_arguments)]
pub async fn chat_gemini(
    rt: &Rt,
    fx: &AiFetch,
    wd: &StreamWatchdog,
    config: &JsonValue,
    system: &str,
    user: &str,
    base_url: Option<&str>,
    options: &GeminiRequestOptions,
) -> Result<AiChatResponse, JsError> {
    let base_url = base_url.unwrap_or(GEMINI_BASE_URL);
    let url = endpoint_url(
        base_url,
        &format!(
            "models/{}:generateContent",
            value_key(prop(config, "model"))
        ),
        None,
    )?;
    let mut headers = vec![
        ("Content-Type".to_owned(), "application/json".to_owned()),
        (
            "x-goog-api-key".to_owned(),
            value_key(prop(config, "apiKey")),
        ),
    ];
    headers.extend(opencode_session_headers(rt, Some(base_url), None));
    let mut generation_config = Obj::new();
    if options.omit_temperature != Some(true) {
        generation_config.set("temperature", number(0.3));
    }
    let body = object(vec![
        ("systemInstruction", system_instruction(system)),
        (
            "contents",
            JsonValue::Array(vec![object(vec![
                ("role", text("user")),
                (
                    "parts",
                    JsonValue::Array(vec![object(vec![("text", text(user))])]),
                ),
            ])]),
        ),
        ("generationConfig", JsonValue::Object(generation_config)),
    ]);
    let init = Init {
        request: Request {
            method: Some("POST".to_owned()),
            headers,
            body: Some(RequestBody::Text(json_stringify(&body))),
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
            "Gemini HTTP {}: {}",
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
            "Gemini returned a non-JSON response: {}",
            http_body_detail(&body_text)?
        )));
    };
    let candidate = first_of(read(&json, "candidates")?);
    let content = match prop2(candidate.as_ref(), "content", "parts") {
        None | Some(JsonValue::Null) => None,
        Some(JsonValue::Array(parts)) => {
            let mut joined = String::new();
            for p in parts {
                joined.push_str(&js_string_or_empty(read(p, "text")?));
            }
            Some(joined)
        }
        Some(_) => {
            return Err(JsError::type_error(
                "json.candidates?.[0]?.content?.parts?.map is not a function",
            ));
        }
    };
    match content {
        Some(content) if !content.is_empty() => Ok(AiChatResponse::succeeded(text(content))),
        _ => Ok(AiChatResponse::failed(
            "Gemini returned an empty response".to_owned(),
        )),
    }
}
