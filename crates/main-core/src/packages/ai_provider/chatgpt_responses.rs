//! `packages/ai-provider/src/chatgpt/responses.ts`: one turn on the user's
//! ChatGPT plan, over OpenAI's public Responses API with the app's own tokens
//! (decision 0081). No program is started: the request goes from this process
//! to `api.openai.com/v1/responses`.
//!
//! The turn speaks the same protocol as the Claude Code bridge: the app's
//! tools and a response schema are written into the input, the model answers
//! with one JSON object, and `parseClaudeCodeTurn` reads it. The request
//! carries only what the plan-usage docs list (`model`, `input`, `store:
//! false`, `stream: true`) plus images as `input_image` parts.
//!
//! The module registers its model list at import time
//! (`setSubscriptionModelSource('chatgpt', ...)`): [`install`] registers
//! [`chatgpt_model_source`] under [`MODEL_SOURCE_PROVIDER`].

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsonValue, js_regex, json_stringify, number_to_string, trim};

use super::chatgpt_connection::{ChatGptConnection, ChatGptConnectionModuleState};
use super::chatgpt_oauth::{FetchLike, response_json};
use super::claude_code_cli::{
    ClaudeCodeContentBlock, ClaudeCodeParseError, TurnTextScanner, build_claude_code_input,
    parse_claude_code_turn,
};
use super::fetch::{AiFetch, Init, keyed_fetch};
use super::jsval::{Obj, as_str, number, object, prop, slice_to, str_trim, text};
use super::protocols_shared::{SseDataEvents, StreamCallbacks, is_plain_object, usage_count};
use super::run_error::ai_run_error;
use super::subscription_models::{
    SubscriptionModelSource, SubscriptionModelsState, set_subscription_model_source,
};
use super::task::{JsError, Request, Response, Rt, Signal};
use super::types::AiChatResponse;
use super::watchdog::create_stream_watchdog;

pub const CHATGPT_RESPONSES_URL: &str = "https://api.openai.com/v1/responses";
pub const CHATGPT_MODELS_URL: &str = "https://api.openai.com/v1/models";

/// the provider id the model source is registered under
pub const MODEL_SOURCE_PROVIDER: &str = "chatgpt";

const PROVIDER: &str = "chatgpt";
const EMPTY_STREAM_MARK: &str = "(empty stream)";
const TOOL_ARGS_DROP_MARK: &str = "while sending tool arguments";
const MODEL_LIST_TIMEOUT_MS: f64 = 15_000.0;

const PLAIN_INSTRUCTIONS: &str = "You are the language-model backend embedded in an office application. You have no tools of your own: you cannot read or change files, run commands, browse the web or call any tool, and you must not try. Answer the request directly.";

/// a model slug as the API takes it
fn is_model_name(name: &str) -> bool {
    js_regex!(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$").test(name)
}

/// `ChatGptBridgeDeps`
#[derive(Clone)]
pub struct ChatGptBridgeDeps {
    /// the state `aiFetch` reads
    pub fx: AiFetch,
    /// `deps.fetch ?? aiFetch`
    pub fetch: FetchLike,
    /// `deps.connection`: `None` is `undefined` (the process's own, read from
    /// `module`); `Some(None)` is `null` (none)
    pub connection: Option<Option<ChatGptConnection>>,
    pub module: Rc<RefCell<ChatGptConnectionModuleState>>,
}

impl ChatGptBridgeDeps {
    /// `deps.connection !== undefined ? deps.connection : chatGptConnection()`
    fn connection(&self) -> Option<ChatGptConnection> {
        match &self.connection {
            Some(connection) => connection.clone(),
            None => self.module.borrow().chatgpt_connection(),
        }
    }
}

/// `ResponsesInputPart`
#[derive(Debug, Clone, PartialEq)]
pub enum ResponsesInputPart {
    InputText(String),
    InputImage(String),
}

impl ResponsesInputPart {
    pub fn to_json(&self) -> JsonValue {
        match self {
            ResponsesInputPart::InputText(t) => object(vec![
                ("type", text("input_text")),
                ("text", text(t.clone())),
            ]),
            ResponsesInputPart::InputImage(url) => object(vec![
                ("type", text("input_image")),
                ("image_url", text(url.clone())),
            ]),
        }
    }
}

/// `chatGptInputParts(systemPrompt, content)`: the Claude Code input blocks as
/// Responses API parts, the instructions first
pub fn chatgpt_input_parts(
    system_prompt: &[String],
    content: &[ClaudeCodeContentBlock],
) -> Vec<ResponsesInputPart> {
    let mut parts = Vec::new();
    let instructions = system_prompt
        .iter()
        .filter(|part| !trim(part).is_empty())
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n\n");
    if !instructions.is_empty() {
        parts.push(ResponsesInputPart::InputText(format!(
            "<instructions>\n{instructions}\n</instructions>"
        )));
    }
    for block in content {
        match block {
            ClaudeCodeContentBlock::Text(t) => parts.push(ResponsesInputPart::InputText(t.clone())),
            ClaudeCodeContentBlock::Image { media_type, data } => {
                parts.push(ResponsesInputPart::InputImage(format!(
                    "data:{media_type};base64,{data}"
                )));
            }
        }
    }
    parts
}

/// `chatGptRequestBody(model, parts)`
pub fn chatgpt_request_body(model: &str, parts: &[ResponsesInputPart]) -> String {
    json_stringify(&object(vec![
        ("model", text(model)),
        (
            "input",
            JsonValue::Array(vec![object(vec![
                ("role", text("user")),
                (
                    "content",
                    JsonValue::Array(parts.iter().map(ResponsesInputPart::to_json).collect()),
                ),
            ])]),
        ),
        ("store", JsonValue::Bool(false)),
        ("stream", JsonValue::Bool(true)),
    ]))
}

/// `errorFields(body)`: `(code, message, param)`, each cut at 500 units
fn error_fields(body: Option<&JsonValue>) -> (String, String, String) {
    let empty = JsonValue::Object(Obj::new());
    let record = match body {
        Some(b) if is_plain_object(Some(b)) => b,
        _ => &empty,
    };
    let error = match prop(record, "error") {
        Some(e) if is_plain_object(Some(e)) => e,
        _ => &empty,
    };
    let str_of = |v: Option<&JsonValue>| -> String {
        as_str(v).map(|s| slice_to(s, 500)).unwrap_or_default()
    };
    let message = str_of(prop(error, "message"));
    let message = if message.is_empty() {
        str_of(prop(record, "detail"))
    } else {
        message
    };
    (
        str_of(prop(error, "code")),
        message,
        str_of(prop(error, "param")),
    )
}

/// `chatGptFailure(status, body, connection)`: the error a refused or failed
/// request is reported as. A session OpenAI no longer accepts is dropped so
/// the card asks to sign in again; a used-up plan is a rate limit; a part the
/// plan does not take is named.
pub async fn chatgpt_failure(
    rt: &Rt,
    status: f64,
    body: Option<&JsonValue>,
    connection: Option<&ChatGptConnection>,
) -> JsError {
    let (code, message, param) = error_fields(body);
    if code == "subscription_sharing_usage_limit_exceeded" {
        return ai_run_error(
            "rate-limit",
            "The ChatGPT plan has reached its usage limit for this app.",
            Some(PROVIDER),
            None,
        );
    }
    if status == 401.0 || code == "subscription_sharing_invalid_user" {
        if let Some(connection) = connection {
            let _ = connection.drop_session(rt).await;
        }
        return ai_run_error(
            "signed-out",
            "ChatGPT signed this app out. Sign in again.",
            Some(PROVIDER),
            None,
        );
    }
    if code == "subscription_sharing_user_not_eligible" {
        return JsError::error("This ChatGPT account cannot use its plan in other apps.");
    }
    if code == "subscription_sharing_unsupported_capability" {
        let named = if param.is_empty() {
            String::new()
        } else {
            format!(" ({param})")
        };
        return JsError::error(format!(
            "ChatGPT does not accept this kind of input on the plan{named}."
        ));
    }
    // 503s were already retried by aiFetch; "HTTP 503" lets the run say the service is busy
    let detail = if !message.is_empty() {
        message
    } else if !code.is_empty() {
        code
    } else {
        "request failed".to_owned()
    };
    JsError::error(format!(
        "ChatGPT HTTP {}: {detail}",
        number_to_string(status)
    ))
}

/// `modelFor(config, accessToken, deps, signal)`: the run's model: the chosen
/// one, else the first the plan lists, else none (an error)
async fn model_for(
    rt: &Rt,
    config: &JsonValue,
    access_token: &str,
    deps: &ChatGptBridgeDeps,
    signal: &Signal,
) -> Result<String, JsError> {
    let chosen = str_trim(prop(config, "model"));
    if !chosen.is_empty() {
        if !is_model_name(&chosen) {
            return Err(JsError::error(format!(
                "Invalid ChatGPT model name: {chosen}"
            )));
        }
        return Ok(chosen);
    }
    let models = read_chatgpt_models(rt, &deps.fx, access_token, &deps.fetch, Some(signal)).await?;
    let first = models
        .first()
        .and_then(|m| as_str(prop(m, "id")))
        .map(str::to_owned);
    match first {
        Some(first) if !first.is_empty() => Ok(first),
        _ => Err(JsError::error("ChatGPT listed no model this plan can use")),
    }
}

/// `TurnOutcome`
struct TurnOutcome {
    raw: String,
    stop_reason: &'static str,
}

/// `readTurn(response, onText, cb)`: read one response stream to its end: the
/// text, and why it stopped
async fn read_turn(
    rt: &Rt,
    response: &Response,
    on_text: &mut dyn FnMut(&str),
    cb: &StreamCallbacks,
) -> Result<TurnOutcome, JsError> {
    if !response.has_body() {
        return Err(JsError::error(format!(
            "ChatGPT returned no content {EMPTY_STREAM_MARK}"
        )));
    }
    let mut raw = String::new();
    let mut completed = false;
    let mut stop_reason = "end_turn";
    let mut events = SseDataEvents::new(response, cb.on_activity.clone());
    while let Some(event) = events.next().await? {
        let Some(data) = event.json.filter(|d| is_plain_object(Some(d))) else {
            continue;
        };
        let kind = as_str(prop(&data, "type")).unwrap_or("");
        if kind == "response.output_text.delta"
            && let Some(delta) = as_str(prop(&data, "delta"))
        {
            raw.push_str(delta);
            on_text(delta);
        } else if kind == "response.completed" || kind == "response.incomplete" {
            let empty = JsonValue::Object(Obj::new());
            let result = match prop(&data, "response") {
                Some(r) if is_plain_object(Some(r)) => r,
                _ => &empty,
            };
            let usage = prop(result, "usage").filter(|u| is_plain_object(Some(*u)));
            if let Some(usage) = usage
                && let Some(on_usage) = &cb.on_usage
            {
                let mut fields = Obj::new();
                if let Some(input_tokens) = usage_count(prop(usage, "input_tokens")) {
                    fields.set("inputTokens", number(input_tokens));
                }
                if let Some(output_tokens) = usage_count(prop(usage, "output_tokens")) {
                    fields.set("outputTokens", number(output_tokens));
                }
                on_usage(JsonValue::Object(fields));
            }
            if kind == "response.incomplete" {
                let details = match prop(result, "incomplete_details") {
                    Some(d) if is_plain_object(Some(d)) => d,
                    _ => &empty,
                };
                stop_reason = if as_str(prop(details, "reason")) == Some("max_output_tokens") {
                    "max_tokens"
                } else {
                    "incomplete"
                };
            }
            completed = true;
        } else if kind == "response.failed" || kind == "error" {
            // `response.failed` carries the response with its error. An `error` event is the
            // error itself in the API reference (`code`, `message`, `param` on the event),
            // and wraps it as `error: { code, message }` in what Codex reads off this stream.
            let result = if kind == "error" {
                let inner = match prop(&data, "error") {
                    Some(e) if is_plain_object(Some(e)) => e.clone(),
                    _ => data.clone(),
                };
                Some(object(vec![("error", inner)]))
            } else {
                prop(&data, "response").cloned()
            };
            let failure = chatgpt_failure(rt, 200.0, result.as_ref(), None).await;
            // a cause the run tells the user about (a used-up plan) stays as it is
            if !raw.is_empty() || failure.is("AiRunError") {
                return Err(failure);
            }
            return Err(
                JsError::error(format!("{} {EMPTY_STREAM_MARK}", failure.message))
                    .with("cause", failure.to_json()),
            );
        }
    }
    // a stream that ends without `response.completed` did not finish
    if !completed {
        return Err(JsError::error(if raw.is_empty() {
            format!("ChatGPT returned no content {EMPTY_STREAM_MARK}")
        } else {
            format!("ChatGPT stopped {TOOL_ARGS_DROP_MARK}: the stream ended early")
        }));
    }
    Ok(TurnOutcome { raw, stop_reason })
}

/// `postTurn(config, parts, cb, deps)`
async fn post_turn(
    rt: &Rt,
    config: &JsonValue,
    parts: &[ResponsesInputPart],
    cb: &StreamCallbacks,
    deps: &ChatGptBridgeDeps,
) -> Result<(Response, ChatGptConnection), JsError> {
    let Some(connection) = deps.connection() else {
        return Err(ai_run_error(
            "signed-out",
            "ChatGPT is not connected in this process.",
            Some(PROVIDER),
            None,
        ));
    };
    let access_token = connection.access_token(rt, Some(&cb.signal)).await?;
    let model = model_for(rt, config, &access_token, deps, &cb.signal).await?;
    let init = Init {
        request: Request {
            method: Some("POST".into()),
            headers: vec![
                ("Authorization".into(), format!("Bearer {access_token}")),
                ("Content-Type".into(), "application/json".into()),
                ("Accept".into(), "text/event-stream".into()),
            ],
            body: Some(super::task::RequestBody::Text(chatgpt_request_body(
                &model, parts,
            ))),
            redirect: None,
        },
        signal: Some(cb.signal.clone()),
    };
    let response = keyed_fetch(
        rt,
        &deps.fx,
        CHATGPT_RESPONSES_URL,
        &init,
        None,
        &deps.fetch,
    )
    .await?;
    if !response.ok() {
        let body = response_json(&response).await.ok();
        return Err(chatgpt_failure(rt, response.status(), body.as_ref(), Some(&connection)).await);
    }
    if let Some(on_activity) = &cb.on_activity {
        on_activity();
    }
    Ok((response, connection))
}

/// `runStructuredTurn(config, system, messages, tools, maxTokens, cb, deps)`
#[allow(clippy::too_many_arguments)]
async fn run_structured_turn(
    rt: &Rt,
    config: &JsonValue,
    system: &str,
    messages: &[JsonValue],
    tools: &[JsonValue],
    max_tokens: f64,
    cb: &StreamCallbacks,
    deps: &ChatGptBridgeDeps,
) -> Result<(), JsError> {
    let input = build_claude_code_input(system, messages, tools, max_tokens)?;
    if input.truncated
        && let Some(on_input_truncated) = &cb.on_input_truncated
    {
        on_input_truncated();
    }
    let parts = chatgpt_input_parts(&input.system_prompt, &input.content);
    let (response, _) = post_turn(rt, config, &parts, cb, deps).await?;
    let mut scanner = TurnTextScanner::new();
    let mut emitted = String::new();
    let outcome = read_turn(
        rt,
        &response,
        &mut |delta| {
            let scanned = scanner.push(delta);
            if !scanned.is_empty() {
                emitted.push_str(&scanned);
                (cb.on_delta)(text(scanned));
            }
        },
        cb,
    )
    .await?;
    if outcome.stop_reason == "max_tokens"
        && let Some(on_stop_reason) = &cb.on_stop_reason
    {
        on_stop_reason(text("max_tokens"));
    }
    match parse_claude_code_turn(rt, &outcome.raw, tools, PROVIDER) {
        Ok(turn) => {
            // the scanner delivered the text as it came; the rest (or all, for an answer it could not follow)
            let rest = turn.text.strip_prefix(emitted.as_str()).unwrap_or_default();
            if !rest.is_empty() {
                (cb.on_delta)(text(rest));
            }
            for call in turn.tool_calls {
                (cb.on_tool_call)(call);
            }
            Ok(())
        }
        Err(ClaudeCodeParseError::Other(error)) => Err(error),
        Err(ClaudeCodeParseError::Structure(message)) => {
            let cause = JsError::new("ClaudeCodeStructureError", message.clone()).to_json();
            if !emitted.is_empty() {
                return Err(JsError::error(format!(
                    "ChatGPT returned a structured response that broke off {TOOL_ARGS_DROP_MARK}: {message}"
                ))
                .with("cause", cause));
            }
            Err(JsError::error(format!(
                "ChatGPT returned an invalid structured response: {message} {EMPTY_STREAM_MARK}"
            ))
            .with("cause", cause))
        }
    }
}

/// `streamChatGpt(config, system, messages, tools, maxTokens, cb, deps)`: one
/// streamed turn of the agent loop: text deltas, then the tool calls the
/// model requests
#[allow(clippy::too_many_arguments)]
pub async fn stream_chatgpt(
    rt: &Rt,
    config: &JsonValue,
    system: &str,
    messages: &[JsonValue],
    tools: &[JsonValue],
    max_tokens: f64,
    cb: &StreamCallbacks,
    deps: &ChatGptBridgeDeps,
) -> Result<(), JsError> {
    let wd = create_stream_watchdog(rt, Some(&cb.signal), None, None);
    let touch = wd.clone();
    let outer = cb.on_activity.clone();
    let wrapped = StreamCallbacks {
        signal: wd.signal.clone(),
        on_activity: Some(Rc::new(move || {
            touch.touch();
            if let Some(outer) = &outer {
                outer();
            }
        })),
        ..cb.clone()
    };
    wd.guard(run_structured_turn(
        rt, config, system, messages, tools, max_tokens, &wrapped, deps,
    ))
    .await
}

/// `chatChatGpt(config, system, user, signal, deps)`: one-shot text chat: the
/// answer is the model's text as it is; an `AiChatResponse`
pub async fn chat_chatgpt(
    rt: &Rt,
    config: &JsonValue,
    system: &str,
    user: &str,
    signal: &Signal,
    deps: &ChatGptBridgeDeps,
) -> Result<AiChatResponse, JsError> {
    let cb = StreamCallbacks {
        on_delta: Rc::new(|_| {}),
        on_tool_call: Rc::new(|_| {}),
        on_reasoning_delta: None,
        on_stop_reason: None,
        on_usage: None,
        on_subscription_usage: None,
        on_input_truncated: None,
        on_activity: None,
        session_id: None,
        signal: signal.clone(),
    };
    let parts = chatgpt_input_parts(
        &[system.to_owned(), PLAIN_INSTRUCTIONS.to_owned()],
        &[ClaudeCodeContentBlock::Text(user.to_owned())],
    );
    let (response, _) = post_turn(rt, config, &parts, &cb, deps).await?;
    let outcome = read_turn(rt, &response, &mut |_| {}, &cb).await?;
    Ok(if outcome.raw.is_empty() {
        AiChatResponse::failed("ChatGPT returned no content".to_owned())
    } else {
        AiChatResponse::succeeded(text(outcome.raw))
    })
}

/// `chatGptModelsOf(body)`: the plan's models as the picker shows them
/// (`{ id, label }`); entries the catalog does not list for display are left out
pub fn chatgpt_models_of(body: &JsonValue) -> Vec<JsonValue> {
    let empty: Vec<JsonValue> = Vec::new();
    let entries = match (prop(body, "models"), prop(body, "data")) {
        (Some(JsonValue::Array(models)), _) => models,
        (_, Some(JsonValue::Array(data))) => data,
        _ => &empty,
    };
    let mut models = Vec::new();
    for entry in entries {
        if !is_plain_object(Some(entry)) {
            continue;
        }
        if let Some(visibility) = prop(entry, "visibility")
            && as_str(Some(visibility)) != Some("list")
        {
            continue;
        }
        let id = as_str(prop(entry, "slug"))
            .or_else(|| as_str(prop(entry, "id")))
            .unwrap_or("");
        if !is_model_name(id) {
            continue;
        }
        let label = match as_str(prop(entry, "display_name")) {
            Some(name) if !name.is_empty() => name,
            _ => id,
        };
        models.push(object(vec![("id", text(id)), ("label", text(label))]));
    }
    models
}

/// `readChatGptModels(accessToken, fetchImpl, signal)`: read the model
/// catalog: an authenticated GET, no model call
pub async fn read_chatgpt_models(
    rt: &Rt,
    fx: &AiFetch,
    access_token: &str,
    fetch_impl: &FetchLike,
    signal: Option<&Signal>,
) -> Result<Vec<JsonValue>, JsError> {
    let timeout = rt.timeout_signal(MODEL_LIST_TIMEOUT_MS);
    let combined = match signal {
        Some(signal) => rt.any_signal(&[signal, &timeout]),
        None => timeout,
    };
    let init = Init {
        request: Request {
            headers: vec![("Authorization".into(), format!("Bearer {access_token}"))],
            ..Request::default()
        },
        signal: Some(combined),
    };
    let response = keyed_fetch(rt, fx, CHATGPT_MODELS_URL, &init, None, fetch_impl).await?;
    if !response.ok() {
        return Err(JsError::error(format!(
            "ChatGPT model list failed with HTTP {}",
            number_to_string(response.status())
        )));
    }
    Ok(chatgpt_models_of(&response_json(&response).await?))
}

/// `listChatGptModels(deps, signal)`: the model list of the process's
/// connection, for the status service
pub async fn list_chatgpt_models(
    rt: &Rt,
    deps: &ChatGptBridgeDeps,
    signal: Option<&Signal>,
) -> Result<Vec<JsonValue>, JsError> {
    let Some(connection) = deps.connection() else {
        return Ok(Vec::new());
    };
    let access_token = connection.access_token(rt, signal).await?;
    read_chatgpt_models(rt, &deps.fx, &access_token, &deps.fetch, signal).await
}

/// The source the module registers at import time: `({ signal }) =>
/// listChatGptModels({}, signal)`. `deps` is `{}`: the process's connection
/// and `aiFetch`.
pub async fn chatgpt_model_source(
    rt: &Rt,
    fx: &AiFetch,
    module: &Rc<RefCell<ChatGptConnectionModuleState>>,
    signal: &Signal,
) -> Result<Vec<JsonValue>, JsError> {
    let deps = ChatGptBridgeDeps {
        fx: fx.clone(),
        fetch: FetchLike::Ai,
        connection: None,
        module: module.clone(),
    };
    list_chatgpt_models(rt, &deps, Some(signal)).await
}

/// `setSubscriptionModelSource('chatgpt', ({ signal }) => listChatGptModels({}, signal))`
/// of the module's import: the caller runs it once, with the state of
/// `subscription_models` and the module variables this module reads.
pub fn install(
    models: &mut SubscriptionModelsState,
    rt: &Rt,
    fx: &AiFetch,
    module: &Rc<RefCell<ChatGptConnectionModuleState>>,
) {
    let (rt, fx, module) = (rt.clone(), fx.clone(), module.clone());
    let source: SubscriptionModelSource = Rc::new(move |_configured_path, signal| {
        let (rt, fx, module) = (rt.clone(), fx.clone(), module.clone());
        Box::pin(async move { chatgpt_model_source(&rt, &fx, &module, &signal).await })
    });
    set_subscription_model_source(models, MODEL_SOURCE_PROVIDER, Some(source));
}
