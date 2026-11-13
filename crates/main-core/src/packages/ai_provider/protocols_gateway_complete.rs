//! `packages/ai-provider/src/protocols/gateway-complete.ts`: `gateway-complete`
//! (seuoffice decision 0009): an HTTP gateway that speaks the OpenAI
//! chat-completions request and SSE shape, authenticated with the caller's
//! token. The token is asked for on every request and goes only into that
//! request's Authorization header: it is never part of the settings, so it
//! cannot reach ai-settings.json, and it is not put in error messages.
//!
//! The module's `tokenProvider` is [`GatewayState`], which the caller owns and
//! hands to every call as `&Rc<RefCell<..>>`.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsonValue, trim};

use super::fetch::AiFetch;
use super::jsval::{spread, text};
use super::protocols_openai_compatible::{
    AiChatResponse, OpenAiCompatibleState, OpenAiRequestOptions, chat_open_ai_compatible,
    stream_open_ai_compatible,
};
use super::protocols_shared::StreamCallbacks;
use super::run_error::ai_run_error;
use super::task::{JsError, LocalBoxFuture, Rt, Signal};
use super::watchdog::StreamWatchdog;

/// `GatewayTokenProvider`: hands over the token for one request; an empty
/// string means there is none.
pub type GatewayTokenProvider =
    Rc<dyn Fn(Rt, Option<Signal>) -> LocalBoxFuture<Result<String, JsError>>>;

/// `GATEWAY_TOKEN_ENV`: the environment variable the default provider reads,
/// on every request.
pub const GATEWAY_TOKEN_ENV: &str = "SEUOFFICE_AI_GATEWAY_TOKEN";

/// The module state of `gateway-complete.ts`: `tokenProvider`. `None` is the
/// environment variable.
#[derive(Clone, Default)]
pub struct GatewayState {
    token_provider: Option<GatewayTokenProvider>,
}

impl GatewayState {
    /// `setGatewayTokenProvider(next)`: registers the process's token
    /// provider; `None` restores the environment variable.
    pub fn set_gateway_token_provider(&mut self, next: Option<GatewayTokenProvider>) {
        self.token_provider = next;
    }
}

/// `withRequestToken(config, baseUrl, signal)`: the request's config with
/// this request's token in place of any key.
async fn with_request_token(
    rt: &Rt,
    gw: &Rc<RefCell<GatewayState>>,
    config: &JsonValue,
    base_url: &str,
    signal: &Signal,
) -> Result<JsonValue, JsError> {
    if base_url.is_empty() {
        return Err(ai_run_error(
            "not-connected",
            "The AI gateway has no URL: set it in Settings",
            None,
            None,
        ));
    }
    let provider = gw.borrow().token_provider.clone();
    let token = match provider {
        Some(provider) => provider(rt.clone(), Some(signal.clone())).await?,
        None => rt.env(GATEWAY_TOKEN_ENV).unwrap_or_default(),
    };
    let token = trim(&token);
    if token.is_empty() {
        return Err(ai_run_error(
            "not-connected",
            "The AI gateway has no token for this request",
            None,
            None,
        ));
    }
    let mut authorized = spread(Some(config));
    authorized.set("apiKey", text(token));
    Ok(JsonValue::Object(authorized))
}

/// `streamGatewayComplete(baseUrl, config, system, messages, tools,
/// maxTokens, cb, options)`; `timeout_ms` is `options.timeoutMs`.
#[allow(clippy::too_many_arguments)]
pub async fn stream_gateway_complete(
    rt: &Rt,
    fx: &AiFetch,
    gw: &Rc<RefCell<GatewayState>>,
    st: &Rc<RefCell<OpenAiCompatibleState>>,
    base_url: &str,
    config: &JsonValue,
    system: &str,
    messages: &JsonValue,
    tools: &JsonValue,
    max_tokens: f64,
    cb: &StreamCallbacks,
    timeout_ms: Option<f64>,
) -> Result<(), JsError> {
    let authorized = with_request_token(rt, gw, config, base_url, &cb.signal).await?;
    let options = OpenAiRequestOptions {
        timeout_ms,
        ..OpenAiRequestOptions::default()
    };
    stream_open_ai_compatible(
        rt,
        fx,
        st,
        base_url,
        &authorized,
        system,
        messages,
        tools,
        max_tokens,
        cb,
        &options,
    )
    .await
}

/// `chatGatewayComplete(wd, baseUrl, config, system, user)`
#[allow(clippy::too_many_arguments)]
pub async fn chat_gateway_complete(
    rt: &Rt,
    fx: &AiFetch,
    gw: &Rc<RefCell<GatewayState>>,
    st: &Rc<RefCell<OpenAiCompatibleState>>,
    wd: &StreamWatchdog,
    base_url: &str,
    config: &JsonValue,
    system: &str,
    user: &str,
) -> Result<AiChatResponse, JsError> {
    let authorized = match with_request_token(rt, gw, config, base_url, &wd.signal).await {
        Ok(authorized) => authorized,
        // like the other config errors of a one-shot call: a failed reply, not a rejection
        Err(e) => return Ok(AiChatResponse::failed(e.message_or_string())),
    };
    chat_open_ai_compatible(
        rt,
        fx,
        st,
        wd,
        base_url,
        &authorized,
        system,
        user,
        &OpenAiRequestOptions::default(),
    )
    .await
}
