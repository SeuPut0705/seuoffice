//! `packages/ai-provider/src/local-test.ts`: the four-step connection test of
//! the local AI card. A user has just typed an address, so silence, a refusal
//! or a model that cannot call tools are ordinary answers: nothing here
//! throws.
//!
//! The test sends fixed probe prompts, no document, attachment or user
//! conversation, and observes the single fake tool call without executing it.
//!
//! The chat and tool probes are the OpenAI-compatible transports of
//! `protocols_openai_compatible.rs`.
//!
//! `skippedResult()` here and `skippedTestResult()` of `local-ipc.ts` are the
//! same object in the TypeScript; both are [`AiLocalTestResult::skipped`].

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::{JsonValue, js_regex, math_round, trim};

use super::fetch::AiFetch;
use super::jsval::{Obj, as_record, length16, number, object, prop, text};
use super::local_models::{
    AiLocalDiscoveryErrorCode, AiLocalDiscoveryRequest, AiLocalDiscoveryResult,
    AiLocalModelSummary, AiLocalRequestOptions, AiLocalServerKind, list_local_models,
};
use super::local_profile::{
    DEFAULT_LOCAL_TIMEOUT_MS, MAX_LOCAL_MODEL_ID_LENGTH, MAX_LOCAL_TIMEOUT_MS, MIN_LOCAL_TIMEOUT_MS,
};
use super::network_error::is_ai_network_error;
use super::protocols_openai_compatible::{
    OpenAiCompatibleState, OpenAiRequestOptions, chat_open_ai_compatible, stream_open_ai_compatible,
};
use super::protocols_shared::StreamCallbacks;
use super::task::{JsError, Rt, Signal};
use super::watchdog::create_stream_watchdog;

/// `AiLocalCheckStatus`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiLocalCheckStatus {
    Pass,
    Fail,
    Skip,
}

impl AiLocalCheckStatus {
    fn as_str(self) -> &'static str {
        match self {
            AiLocalCheckStatus::Pass => "pass",
            AiLocalCheckStatus::Fail => "fail",
            AiLocalCheckStatus::Skip => "skip",
        }
    }
}

/// `AiLocalCheckCode`: why a check did not pass. `Unreachable` nothing
/// answered, `Timeout` the budget ran out, `Http` a route refused the
/// request, `Shape` the answer was not an OpenAI-compatible body,
/// `ModelMissing` the server does not list the chosen model, `NoChat` the
/// model returned no text, `NoToolCall` the model did not call the probe tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiLocalCheckCode {
    Unreachable,
    Timeout,
    Http,
    Shape,
    ModelMissing,
    NoChat,
    NoToolCall,
}

impl AiLocalCheckCode {
    fn as_str(self) -> &'static str {
        match self {
            AiLocalCheckCode::Unreachable => "unreachable",
            AiLocalCheckCode::Timeout => "timeout",
            AiLocalCheckCode::Http => "http",
            AiLocalCheckCode::Shape => "shape",
            AiLocalCheckCode::ModelMissing => "model-missing",
            AiLocalCheckCode::NoChat => "no-chat",
            AiLocalCheckCode::NoToolCall => "no-tool-call",
        }
    }

    /// the discovery code a failed list names, as a check code
    fn of_discovery(code: AiLocalDiscoveryErrorCode) -> AiLocalCheckCode {
        match code {
            AiLocalDiscoveryErrorCode::Unreachable => AiLocalCheckCode::Unreachable,
            AiLocalDiscoveryErrorCode::Timeout => AiLocalCheckCode::Timeout,
            AiLocalDiscoveryErrorCode::Http => AiLocalCheckCode::Http,
            AiLocalDiscoveryErrorCode::Shape => AiLocalCheckCode::Shape,
        }
    }
}

/// `AiLocalCheck`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AiLocalCheck {
    pub status: AiLocalCheckStatus,
    pub code: Option<AiLocalCheckCode>,
}

impl AiLocalCheck {
    const SKIP: AiLocalCheck = AiLocalCheck {
        status: AiLocalCheckStatus::Skip,
        code: None,
    };
    const PASS: AiLocalCheck = AiLocalCheck {
        status: AiLocalCheckStatus::Pass,
        code: None,
    };

    fn fail(code: AiLocalCheckCode) -> AiLocalCheck {
        AiLocalCheck {
            status: AiLocalCheckStatus::Fail,
            code: Some(code),
        }
    }

    pub fn to_json(&self) -> JsonValue {
        let mut entries = vec![("status", text(self.status.as_str()))];
        if let Some(code) = self.code {
            entries.push(("code", text(code.as_str())));
        }
        object(entries)
    }
}

/// `AiLocalTestResult`. The fields are in the order the TypeScript sets
/// them.
#[derive(Debug, Clone, PartialEq)]
pub struct AiLocalTestResult {
    pub server: AiLocalCheck,
    pub model: AiLocalCheck,
    pub chat: AiLocalCheck,
    pub tools: AiLocalCheck,
    /// epoch milliseconds when the test started
    pub checked_at: f64,
    pub elapsed_ms: f64,
    /// the server's list, when the server check read it
    pub models: Option<Vec<AiLocalModelSummary>>,
    /// which wire shape answered the list probe
    pub server_kind: Option<AiLocalServerKind>,
    /// invalid input: every check is skip and no request was sent
    pub input_error_shape: bool,
    /// the caller cancelled the test: the request in flight was aborted,
    /// nothing more was sent, and every check that had not answered yet is
    /// skip
    pub cancelled: bool,
}

impl AiLocalTestResult {
    /// the result before any check ran
    fn started(checked_at: f64) -> AiLocalTestResult {
        AiLocalTestResult {
            server: AiLocalCheck::SKIP,
            model: AiLocalCheck::SKIP,
            chat: AiLocalCheck::SKIP,
            tools: AiLocalCheck::SKIP,
            checked_at,
            elapsed_ms: 0.0,
            models: None,
            server_kind: None,
            input_error_shape: false,
            cancelled: false,
        }
    }

    /// `skippedResult()`: the answer for a payload the test cannot run:
    /// nothing was sent.
    pub fn skipped(rt: &Rt) -> AiLocalTestResult {
        AiLocalTestResult {
            input_error_shape: true,
            ..AiLocalTestResult::started(rt.now())
        }
    }

    pub fn to_json(&self) -> JsonValue {
        let mut entries = vec![
            ("server", self.server.to_json()),
            ("model", self.model.to_json()),
            ("chat", self.chat.to_json()),
            ("tools", self.tools.to_json()),
            ("checkedAt", number(self.checked_at)),
            ("elapsedMs", number(self.elapsed_ms)),
        ];
        if let Some(models) = &self.models {
            entries.push((
                "models",
                JsonValue::Array(models.iter().map(AiLocalModelSummary::to_json).collect()),
            ));
        }
        if let Some(kind) = self.server_kind {
            entries.push(("serverKind", text(kind.as_str())));
        }
        if self.input_error_shape {
            entries.push(("inputError", text("shape")));
        }
        if self.cancelled {
            entries.push(("cancelled", JsonValue::Bool(true)));
        }
        object(entries)
    }
}

/// `AiLocalTestOptions`: what a caller in the main process may add to a
/// test. Aborting the signal ends the request in flight and sends no further
/// check.
#[derive(Clone, Default)]
pub struct AiLocalTestOptions {
    pub signal: Option<Signal>,
}

/// the IPC layer's string limits, repeated so a direct caller gets the same answer
const MAX_BASE_URL_LENGTH: usize = 2048;
const MAX_API_KEY_LENGTH: usize = 8192;

/// Fixed probe text. These are constants on purpose: the connection test
/// must never carry a document, an attachment or a conversation.
const CHECK_SYSTEM_PROMPT: &str = "You are answering a connection test of an AI server. The test only checks that this chat works. Reply briefly.";
const CHAT_USER_PROMPT: &str = "ping";
const TOOL_USER_PROMPT: &str = "Run the seuoffice_probe tool now with ok set to true.";

/// enough for a short greeting; a local model may still be warming up
const CHAT_MAX_TOKENS: f64 = 32.0;
/// deep enough for a thinking model to finish the one small call
const TOOL_MAX_TOKENS: f64 = 128.0;

/// `PROBE_TOOL.name`
const PROBE_TOOL_NAME: &str = "seuoffice_probe";

/// `PROBE_TOOL`: the single fake tool the tool check offers. It is not
/// registered anywhere and the call is only observed.
fn probe_tool() -> JsonValue {
    object(vec![
        ("name", text(PROBE_TOOL_NAME)),
        (
            "description",
            text(
                "Connection probe. Call this once with {\"ok\": true} to confirm tool calling works.",
            ),
        ),
        (
            "inputSchema",
            object(vec![
                ("type", text("object")),
                (
                    "properties",
                    object(vec![("ok", object(vec![("type", text("boolean"))]))]),
                ),
                ("required", JsonValue::Array(vec![text("ok")])),
                ("additionalProperties", JsonValue::Bool(false)),
            ]),
        ),
    ])
}

/// `ResolvedTestInput`
struct ResolvedTestInput {
    base_url: String,
    api_key: String,
    model: String,
    typed: bool,
    timeout_ms: f64,
}

/// `normalizedBaseOf(raw)` with the length bound
fn normalized_base_of(raw: Option<&JsonValue>) -> Option<String> {
    let JsonValue::String(raw) = raw? else {
        return None;
    };
    let trimmed = js_regex!(r"/+$").replace_all(trim(raw), |_| String::new());
    if trimmed.is_empty() || length16(&trimmed) > MAX_BASE_URL_LENGTH {
        return None;
    }
    let url = url::Url::parse(&trimmed).ok()?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return None;
    }
    Some(trimmed)
}

/// `timeoutOf(raw)`: a total budget in the window the settings contract allows
fn timeout_of(raw: Option<&JsonValue>) -> f64 {
    match raw {
        Some(JsonValue::Number(x)) if x.is_finite() => {
            MAX_LOCAL_TIMEOUT_MS.min(MIN_LOCAL_TIMEOUT_MS.max(math_round(*x)))
        }
        _ => DEFAULT_LOCAL_TIMEOUT_MS,
    }
}

/// `resolveInput(raw)`: the typed input with every malformed field rejected.
/// `None` means the caller sent something the four checks cannot run
/// against: no request is made.
fn resolve_input(raw: &JsonValue) -> Option<ResolvedTestInput> {
    let record = as_record(raw)?;
    let base_url = normalized_base_of(record.get("baseUrl"))?;
    let model = match record.get("model") {
        Some(JsonValue::String(m)) => trim(m).to_owned(),
        _ => String::new(),
    };
    if model.is_empty() || length16(&model) > MAX_LOCAL_MODEL_ID_LENGTH {
        return None;
    }
    let api_key = match record.get("apiKey") {
        None => String::new(),
        Some(JsonValue::String(key)) => trim(key).to_owned(),
        Some(_) => return None,
    };
    if length16(&api_key) > MAX_API_KEY_LENGTH {
        return None;
    }
    Some(ResolvedTestInput {
        base_url,
        api_key,
        model,
        typed: record.get("typed") == Some(&JsonValue::Bool(true)),
        timeout_ms: timeout_of(record.get("timeoutMs")),
    })
}

/// `requestFailureCode(error, deadline)`: the code a thrown request error
/// stands for, or `None` when the error says nothing about the four steps (a
/// plain empty stream says "no tool call").
fn request_failure_code(rt: &Rt, error: &JsError, deadline: f64) -> Option<AiLocalCheckCode> {
    if error.is("AiTimeoutError") || rt.now() >= deadline {
        return Some(AiLocalCheckCode::Timeout);
    }
    if is_ai_network_error(&error.to_json()) {
        return Some(AiLocalCheckCode::Unreachable);
    }
    let message = error.message_or_string();
    if js_regex!(r"^HTTP \d{3}\b").test(&message) {
        return Some(AiLocalCheckCode::Http);
    }
    if error.is("ResponseBodyTooLargeError") {
        return Some(AiLocalCheckCode::Shape);
    }
    if js_regex!(r"unparseable JSON|non-JSON response", "i").test(&message) {
        return Some(AiLocalCheckCode::Shape);
    }
    None
}

/// `chatFailureCode(error)`: the one-shot chat reports HTTP, malformed and
/// empty answers in its result.
fn chat_failure_code(error: &str) -> AiLocalCheckCode {
    if js_regex!(r"^HTTP \d{3}\b").test(error) {
        return AiLocalCheckCode::Http;
    }
    if js_regex!(r"non-JSON response", "i").test(error) {
        return AiLocalCheckCode::Shape;
    }
    AiLocalCheckCode::NoChat
}

/// `{ apiKey, model }`, the provider config of the probes
fn probe_config(input: &ResolvedTestInput) -> JsonValue {
    let mut config = Obj::new();
    config.set("apiKey", text(input.api_key.clone()));
    config.set("model", text(input.model.clone()));
    JsonValue::Object(config)
}

/// `runChatCheck(input, deadline, controller)`
async fn run_chat_check(
    rt: &Rt,
    fx: &AiFetch,
    st: &Rc<RefCell<OpenAiCompatibleState>>,
    input: &ResolvedTestInput,
    deadline: f64,
    controller: &Signal,
) -> AiLocalCheck {
    let remaining = deadline - rt.now();
    if remaining <= 0.0 {
        return AiLocalCheck::fail(AiLocalCheckCode::Timeout);
    }
    let config = probe_config(input);
    let wd = create_stream_watchdog(rt, Some(controller), Some(remaining), Some(remaining));
    let options = OpenAiRequestOptions {
        timeout_ms: Some(remaining),
        max_tokens: Some(CHAT_MAX_TOKENS),
        temperature: Some(0.0),
        ..OpenAiRequestOptions::default()
    };
    let response = wd
        .guard(chat_open_ai_compatible(
            rt,
            fx,
            st,
            &wd,
            &input.base_url,
            &config,
            CHECK_SYSTEM_PROMPT,
            CHAT_USER_PROMPT,
            &options,
        ))
        .await;
    match response {
        Ok(response) if response.ok => match &response.content {
            // `response.content?.trim()`
            Some(JsonValue::String(content)) if !trim(content).is_empty() => AiLocalCheck::PASS,
            None | Some(JsonValue::Null) | Some(JsonValue::String(_)) => {
                AiLocalCheck::fail(AiLocalCheckCode::NoChat)
            }
            // a truthy `content` that is no string: `.trim` is not a function
            Some(_) => {
                let error = JsError::type_error("response.content?.trim is not a function");
                AiLocalCheck::fail(
                    request_failure_code(rt, &error, deadline)
                        .unwrap_or(AiLocalCheckCode::Unreachable),
                )
            }
        },
        Ok(response) => {
            AiLocalCheck::fail(chat_failure_code(response.error.as_deref().unwrap_or("")))
        }
        Err(error) => AiLocalCheck::fail(
            request_failure_code(rt, &error, deadline).unwrap_or(AiLocalCheckCode::Unreachable),
        ),
    }
}

/// `runToolsCheck(input, deadline, controller)`
async fn run_tools_check(
    rt: &Rt,
    fx: &AiFetch,
    st: &Rc<RefCell<OpenAiCompatibleState>>,
    input: &ResolvedTestInput,
    deadline: f64,
    controller: &Signal,
) -> AiLocalCheck {
    let remaining = deadline - rt.now();
    if remaining <= 0.0 {
        return AiLocalCheck::fail(AiLocalCheckCode::Timeout);
    }
    let config = probe_config(input);
    let messages = JsonValue::Array(vec![object(vec![
        ("role", text("user")),
        ("text", text(TOOL_USER_PROMPT)),
    ])]);
    let tools = JsonValue::Array(vec![probe_tool()]);
    let probe_called = Rc::new(Cell::new(false));
    let seen = probe_called.clone();
    let callbacks = StreamCallbacks {
        on_delta: Rc::new(|_: JsonValue| {}),
        // Observed only. Nothing executes the fake tool or forwards the call
        // to the application's tools; the name is the whole answer this
        // check needs.
        on_tool_call: Rc::new(move |call: JsonValue| {
            if prop(&call, "name") == Some(&text(PROBE_TOOL_NAME)) {
                seen.set(true);
            }
        }),
        on_reasoning_delta: None,
        on_stop_reason: None,
        on_usage: None,
        on_subscription_usage: None,
        on_input_truncated: None,
        on_activity: None,
        session_id: None,
        signal: controller.clone(),
    };
    let options = OpenAiRequestOptions {
        timeout_ms: Some(remaining),
        max_tokens: Some(TOOL_MAX_TOKENS),
        temperature: Some(0.0),
        ..OpenAiRequestOptions::default()
    };
    let streamed = stream_open_ai_compatible(
        rt,
        fx,
        st,
        &input.base_url,
        &config,
        CHECK_SYSTEM_PROMPT,
        &messages,
        &tools,
        TOOL_MAX_TOKENS,
        &callbacks,
        &options,
    )
    .await;
    match streamed {
        Ok(()) if probe_called.get() => AiLocalCheck::PASS,
        Ok(()) => AiLocalCheck::fail(AiLocalCheckCode::NoToolCall),
        Err(_) if probe_called.get() => AiLocalCheck::PASS,
        Err(error) => AiLocalCheck::fail(
            request_failure_code(rt, &error, deadline).unwrap_or(AiLocalCheckCode::NoToolCall),
        ),
    }
}

/// The four checks, in order, into `result`. Returns when a check finished
/// with the test cancelled (the result then says `cancelled`).
#[allow(clippy::too_many_arguments)]
async fn run_checks(
    rt: &Rt,
    fx: &AiFetch,
    st: &Rc<RefCell<OpenAiCompatibleState>>,
    resolved: &ResolvedTestInput,
    deadline: f64,
    controller: &Signal,
    deadline_hit: &Cell<bool>,
    cancelled: &Cell<bool>,
    result: &mut AiLocalTestResult,
) {
    let timed_out = || deadline_hit.get() || deadline - rt.now() <= 0.0;
    // a cancelled test keeps the answers it already had; the rest stay skip
    let cancelled_result = |result: &mut AiLocalTestResult| result.cancelled = true;

    if timed_out() {
        result.server = AiLocalCheck::fail(AiLocalCheckCode::Timeout);
    } else {
        let listed = list_local_models(
            rt,
            fx,
            &AiLocalDiscoveryRequest {
                base_url: resolved.base_url.clone(),
                api_key: (!resolved.api_key.is_empty()).then(|| resolved.api_key.clone()),
            },
            Some(&AiLocalRequestOptions {
                signal: Some(controller.clone()),
            }),
        )
        .await;
        if cancelled.get() {
            return cancelled_result(result);
        }
        match listed {
            AiLocalDiscoveryResult::Ok { server, models } => {
                result.server = AiLocalCheck::PASS;
                result.server_kind = Some(server);
                result.model = if models.is_empty() {
                    // an empty list cannot judge the model at all
                    AiLocalCheck::SKIP
                } else if models.iter().any(|entry| entry.id == resolved.model) {
                    AiLocalCheck::PASS
                } else if resolved.typed {
                    // the user typed this id; the server's list not naming it
                    // is not proof that it is missing (the list may be partial
                    // or stale)
                    AiLocalCheck::SKIP
                } else {
                    AiLocalCheck::fail(AiLocalCheckCode::ModelMissing)
                };
                result.models = Some(models);
            }
            AiLocalDiscoveryResult::Failed(failure) => {
                // no list means this model cannot be judged; chat and tools still try
                result.server =
                    AiLocalCheck::fail(AiLocalCheckCode::of_discovery(failure.error_code));
            }
        }
    }

    let chat = if timed_out() {
        AiLocalCheck::fail(AiLocalCheckCode::Timeout)
    } else {
        run_chat_check(rt, fx, st, resolved, deadline, controller).await
    };
    if cancelled.get() {
        return cancelled_result(result);
    }
    result.chat = chat;

    let tools = if timed_out() {
        AiLocalCheck::fail(AiLocalCheckCode::Timeout)
    } else {
        run_tools_check(rt, fx, st, resolved, deadline, controller).await
    };
    if cancelled.get() {
        return cancelled_result(result);
    }
    result.tools = tools;
}

/// `testLocalModel(input, options)`: runs the four checks against one model
/// on one local server.
///
/// One deadline (`timeoutMs`, default 300s, clamped to 60s-600s) covers the
/// whole test: each request gets the time that is left, and once none is left
/// the remaining checks answer `timeout` without sending anything.
///
/// Aborting `options.signal` cancels the test: the request in flight is
/// aborted, no further check is sent, and the result says `cancelled`.
/// Malformed input returns `inputError: 'shape'` with every check skipped.
pub async fn test_local_model(
    rt: &Rt,
    fx: &AiFetch,
    st: &Rc<RefCell<OpenAiCompatibleState>>,
    input: &JsonValue,
    options: Option<&AiLocalTestOptions>,
) -> AiLocalTestResult {
    let Some(resolved) = resolve_input(input) else {
        return AiLocalTestResult::skipped(rt);
    };

    let started_at = rt.now();
    let mut result = AiLocalTestResult::started(started_at);
    let outer = options.and_then(|o| o.signal.clone());
    if outer.as_ref().is_some_and(Signal::aborted) {
        result.cancelled = true;
        return result;
    }

    let deadline = started_at + resolved.timeout_ms;
    let controller = rt.controller();
    let deadline_hit = Rc::new(Cell::new(false));
    let cancelled = Rc::new(Cell::new(false));
    let timer = {
        let controller = controller.clone();
        let deadline_hit = deadline_hit.clone();
        rt.set_timeout(resolved.timeout_ms, move || {
            deadline_hit.set(true);
            controller.abort(None);
        })
    };
    // the card was closed or moved to another server: end the request in flight
    let on_cancel = outer.as_ref().map(|outer| {
        let controller = controller.clone();
        let cancelled = cancelled.clone();
        outer.on_abort(move |_| {
            cancelled.set(true);
            controller.abort(None);
        })
    });

    run_checks(
        rt,
        fx,
        st,
        &resolved,
        deadline,
        &controller,
        &deadline_hit,
        &cancelled,
        &mut result,
    )
    .await;

    rt.clear_timeout(Some(timer));
    if let (Some(outer), Some(listener)) = (&outer, on_cancel) {
        outer.off(listener);
    }
    result.elapsed_ms = (rt.now() - started_at).max(0.0);
    result
}
