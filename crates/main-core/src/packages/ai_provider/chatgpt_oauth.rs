//! `packages/ai-provider/src/chatgpt/oauth.ts`: the OAuth side of the ChatGPT
//! connection (decision 0081): OpenAI's "Sign in with ChatGPT" for
//! open-source, locally run apps. The app registers itself as an agent of the
//! user's ChatGPT account and gets tokens of its own, scoped to the user's
//! ChatGPT plan. The sign-in page is OpenAI's, in the system browser; the app
//! never sees a password and has no client secret.
//!
//! Every network call goes through an injectable fetch ([`FetchLike`]), so
//! tests never reach OpenAI.
//!
//! What stays behind a seam:
//! - The loopback server (`http.createServer`) is [`Rt::listen`] and
//!   [`Rt::respond`].
//! - `openBrowser` is a function the caller passed in: [`Rt::call`] under the
//!   name [`OPEN_BROWSER_CALL`] with the address as its only argument.
//! - `createPublicKey` and `verify` of `node:crypto` (the signature of an ID
//!   token) have no Rust in `main-core`: [`JwtSignatureVerifier`] is the
//!   seam, and the host brings the implementation.

use std::cell::Cell;
use std::rc::Rc;

use jscompat::{JsonValue, buffer_from_base64, js_regex, json_parse, number_to_string};
use sha2::{Digest, Sha256};

use super::fetch::{AiFetch, AiFetchWatch, Init, KeyedFetchBase, call_base, keyed_fetch};
use super::free_connect::{FreeConnectPage, base64url, free_connect_page_html};
use super::jsval::{Obj, as_record, as_str, object, prop, text};
use super::subscription_contract::subscription_login_error_code_test;
use super::task::{HttpRequest, JsError, Request, RequestBody, Response, Rt, Settle, Signal};

/// `FetchLike`: the fetch a call goes through; `aiFetch` when the caller gave none.
pub type FetchLike = KeyedFetchBase;

pub const CHATGPT_ISSUER: &str = "https://auth.openai.com";
pub const CHATGPT_AUTHORIZE_URL: &str = "https://auth.openai.com/api/accounts/authorize";
pub const CHATGPT_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/oauth/token";
pub const CHATGPT_JWKS_URL: &str = "https://auth.openai.com/.well-known/jwks.json";
pub const CHATGPT_OIDC_CONFIG_URL: &str =
    "https://auth.openai.com/.well-known/openid-configuration";
/// the API the tokens are bound to, sent as `resource` on every authorization and token call
pub const CHATGPT_RESOURCE: &str = "https://api.openai.com/v1";
/// the client id of a first registration; the callback brings the id OpenAI issued
pub const CHATGPT_DYNAMIC_CLIENT_ID: &str = "dynamic_agent_client";
/// the scope that lets requests draw on the user's ChatGPT plan
pub const CHATGPT_PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
pub const CHATGPT_SCOPES: [&str; 6] = [
    "openid",
    "profile",
    "email",
    "offline_access",
    "resource.invoke",
    CHATGPT_PLAN_SCOPE,
];

/// The loopback path the browser comes back to.
pub const CHATGPT_CALLBACK_PATH: &str = "/auth/callback";
pub const CHATGPT_LEGACY_CALLBACK_PATH: &str = "/callback";

/// how long the browser sign-in may take before the waiting server gives up
pub const CHATGPT_SIGN_IN_TIMEOUT_MS: f64 = 10.0 * 60.0 * 1000.0;

/// the name `openBrowser` has in [`Rt::call`]
pub const OPEN_BROWSER_CALL: &str = "openBrowser";

const REQUEST_TIMEOUT_MS: f64 = 20_000.0;
/// an ID token is accepted this long past its expiry, for a PC clock that runs a little behind
const CLOCK_SKEW_SECONDS: f64 = 300.0;

/// `ChatGptSignInFailure`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatGptSignInFailure {
    Cancelled,
    Timeout,
    Denied,
    NoPlan,
    Network,
}

impl ChatGptSignInFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatGptSignInFailure::Cancelled => "cancelled",
            ChatGptSignInFailure::Timeout => "timeout",
            ChatGptSignInFailure::Denied => "denied",
            ChatGptSignInFailure::NoPlan => "no-plan",
            ChatGptSignInFailure::Network => "network",
        }
    }
}

/// `ChatGptSignInFailed`: why, the step it failed at (one of
/// `AI_SUBSCRIPTION_LOGIN_FAILURE_STEPS`), and the token endpoint's answer
/// when that was it.
#[derive(Debug, Clone, PartialEq)]
pub struct ChatGptSignInFailed {
    pub reason: ChatGptSignInFailure,
    pub step: Option<&'static str>,
    /// the token endpoint's HTTP status, on `token-refused`, `token-resent` and `token-http`
    pub http_status: Option<f64>,
    /// the OAuth `error` code of the token endpoint or the callback, when it has an identifier's shape
    pub oauth_error: Option<String>,
}

impl ChatGptSignInFailed {
    fn of(reason: ChatGptSignInFailure, step: Option<&'static str>) -> Self {
        ChatGptSignInFailed {
            reason,
            step,
            http_status: None,
            oauth_error: None,
        }
    }

    /// `{ ok: false, reason, step?, httpStatus?, oauthError? }`
    pub fn to_json(&self) -> JsonValue {
        let mut out = Obj::new();
        out.set("ok", JsonValue::Bool(false));
        out.set("reason", text(self.reason.as_str()));
        if let Some(step) = self.step {
            out.set("step", text(step));
        }
        if let Some(status) = self.http_status {
            out.set("httpStatus", JsonValue::Number(status));
        }
        if let Some(error) = &self.oauth_error {
            out.set("oauthError", text(error.clone()));
        }
        JsonValue::Object(out)
    }
}

/// `ChatGptTokenSet`
#[derive(Debug, Clone, PartialEq)]
pub struct ChatGptTokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// epoch milliseconds
    pub expires_at: f64,
    pub scopes: Vec<String>,
    /// present on a sign-in, and on a refresh when OpenAI sends a new one
    pub id_token: Option<String>,
    /// The answer had no `scope` field: the scopes are then empty.
    pub scope_missing: bool,
}

impl ChatGptTokenSet {
    /// the object `tokenSetOf` builds: `idToken` after `scopeMissing`
    pub fn to_json(&self) -> JsonValue {
        let mut out = Obj::new();
        out.set("accessToken", text(self.access_token.clone()));
        out.set("refreshToken", text(self.refresh_token.clone()));
        out.set("expiresAt", JsonValue::Number(self.expires_at));
        out.set(
            "scopes",
            JsonValue::Array(self.scopes.iter().map(|s| text(s.clone())).collect()),
        );
        if self.scope_missing {
            out.set("scopeMissing", JsonValue::Bool(true));
        }
        if let Some(id_token) = &self.id_token {
            out.set("idToken", text(id_token.clone()));
        }
        JsonValue::Object(out)
    }
}

/// `base64url(bytes)`; the argument is `Buffer`
fn base64url_of(bytes: &[u8]) -> String {
    base64url(bytes)
}

fn random_token(rt: &Rt) -> String {
    base64url_of(&rt.random_bytes(32))
}

/// `chatGptPkcePair()`: a PKCE verifier and its S256 challenge
pub fn chatgpt_pkce_pair(rt: &Rt) -> (String, String) {
    let verifier = random_token(rt);
    let challenge = base64url_of(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// `chatGptRedirectUri(port, path)`
pub fn chatgpt_redirect_uri(port: f64, path: Option<&str>) -> String {
    format!(
        "http://127.0.0.1:{}{}",
        number_to_string(port),
        path.unwrap_or(CHATGPT_CALLBACK_PATH)
    )
}

/// `ChatGptAuthorizeParams`
#[derive(Debug, Clone, PartialEq)]
pub struct ChatGptAuthorizeParams {
    pub port: f64,
    pub challenge: String,
    pub state: String,
    pub nonce: String,
    pub host_id: String,
    /// the id OpenAI issued at an earlier sign-in of this host; `None`: register anew
    pub client_id: Option<String>,
    /// the callback path of this attempt; `None`: the one new registrations use
    pub callback_path: Option<String>,
    /// the app's name, shown to the user on a first registration
    pub agent_name: String,
}

/// `new URLSearchParams(pairs).toString()`
fn form_body(pairs: &[(&str, &str)]) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in pairs {
        serializer.append_pair(name, value);
    }
    serializer.finish()
}

/// `chatGptAuthorizeUrl(params)`: the sign-in page address
pub fn chatgpt_authorize_url(params: &ChatGptAuthorizeParams) -> String {
    let client_id = match &params.client_id {
        Some(id) if !id.is_empty() => id.as_str(),
        _ => CHATGPT_DYNAMIC_CLIENT_ID,
    };
    let redirect_uri = chatgpt_redirect_uri(params.port, params.callback_path.as_deref());
    let scope = CHATGPT_SCOPES.join(" ");
    let mut pairs: Vec<(&str, &str)> = vec![
        ("client_id", client_id),
        ("ext_agent_host_id", &params.host_id),
        ("response_type", "code"),
        ("redirect_uri", &redirect_uri),
        ("scope", &scope),
        ("resource", CHATGPT_RESOURCE),
        ("state", &params.state),
        ("nonce", &params.nonce),
        ("code_challenge_method", "S256"),
        ("code_challenge", &params.challenge),
    ];
    // the name hint belongs to a new registration only
    if params.client_id.as_deref().is_none_or(str::is_empty) {
        pairs.push(("agent_name_hint", &params.agent_name));
    }
    format!("{CHATGPT_AUTHORIZE_URL}?{}", form_body(&pairs))
}

/// `withTimeout(signal)`
fn with_timeout(rt: &Rt, signal: Option<&Signal>) -> Signal {
    let timeout = rt.timeout_signal(REQUEST_TIMEOUT_MS);
    match signal {
        Some(signal) => rt.any_signal(&[signal, &timeout]),
        None => timeout,
    }
}

fn clock(rt: &Rt, now: Option<&dyn Fn() -> f64>) -> f64 {
    match now {
        Some(now) => now(),
        None => rt.now(),
    }
}

/// `await response.json()`: the body as text, parsed
pub async fn response_json(response: &Response) -> Result<JsonValue, JsError> {
    let body = response.text().await?;
    json_parse(&body).map_err(|e| JsError::new("SyntaxError", e.message()))
}

/// `if (x)` of a value a function the caller passed in answered
fn js_truthy(value: &JsonValue) -> bool {
    match value {
        JsonValue::Null => false,
        JsonValue::Bool(b) => *b,
        JsonValue::Number(n) => !(*n == 0.0 || n.is_nan()),
        JsonValue::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `ChatGptCallback`
#[derive(Debug, Clone, PartialEq)]
pub enum ChatGptCallback {
    Ok {
        code: String,
        client_id: String,
        port: f64,
    },
    Failed(ChatGptSignInFailed),
}

impl ChatGptCallback {
    pub fn to_json(&self) -> JsonValue {
        match self {
            ChatGptCallback::Ok {
                code,
                client_id,
                port,
            } => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("code", text(code.clone())),
                ("clientId", text(client_id.clone())),
                ("port", JsonValue::Number(*port)),
            ]),
            ChatGptCallback::Failed(failed) => failed.to_json(),
        }
    }
}

/// what the browser shows after the sign-in, by outcome
#[derive(Debug, Clone, PartialEq)]
pub struct ChatGptPages {
    pub done: FreeConnectPage,
    pub failed: FreeConnectPage,
}

/// `ChatGptCallbackOptions`. `openBrowser` is [`OPEN_BROWSER_CALL`].
#[derive(Clone)]
pub struct ChatGptCallbackOptions {
    /// the address to open, once the waiting server knows its port
    pub authorize_url: Rc<dyn Fn(f64) -> String>,
    pub state: String,
    /// the path the browser comes back to; `None`: the one new registrations use
    pub callback_path: Option<String>,
    /// The client id this attempt signs in again with.
    pub client_id: Option<String>,
    pub pages: ChatGptPages,
    pub signal: Option<Signal>,
    pub timeout_ms: Option<f64>,
}

fn failed_callback(reason: ChatGptSignInFailure, step: Option<&'static str>) -> ChatGptCallback {
    ChatGptCallback::Failed(ChatGptSignInFailed::of(reason, step))
}

/// `waitForChatGptCallback(options)`: wait for the browser to come back with
/// a code. OpenAI sends it to `127.0.0.1` (never `localhost`), so only that
/// address is bound. One request to the callback path with the right `state`
/// is answered; anything else gets a 404 and leaves the wait as it is.
pub async fn wait_for_chatgpt_callback(
    rt: &Rt,
    options: &ChatGptCallbackOptions,
) -> ChatGptCallback {
    let (settle, outcome) = rt.deferred::<ChatGptCallback>();
    let answered = Rc::new(Cell::new(false));
    let port = Rc::new(Cell::new(0.0_f64));
    let path = options
        .callback_path
        .clone()
        .unwrap_or_else(|| CHATGPT_CALLBACK_PATH.to_owned());

    let handle = {
        let rt = rt.clone();
        let settle: Settle<ChatGptCallback> = settle.clone();
        let answered = answered.clone();
        let port = port.clone();
        let state = options.state.clone();
        let wanted_client = options.client_id.clone();
        let pages = options.pages.clone();
        move |req: HttpRequest| {
            let Ok(base) = url::Url::parse("http://127.0.0.1") else {
                return;
            };
            let Ok(url) = base.join(&req.url) else {
                return;
            };
            let get = |name: &str| {
                url.query_pairs()
                    .find(|(k, _)| k == name)
                    .map(|(_, v)| v.into_owned())
            };
            if req.method != "GET"
                || url.path() != path
                || answered.get()
                || get("state").as_deref() != Some(state.as_str())
            {
                rt.respond(
                    req.id,
                    404.0,
                    vec![("Content-Type".into(), "text/plain; charset=utf-8".into())],
                    b"",
                );
                return;
            }
            answered.set(true);
            let code = get("code").filter(|c| !c.is_empty());
            let named = get("client_id").filter(|c| !c.is_empty());
            let client_id = named
                .clone()
                .or_else(|| wanted_client.clone())
                .filter(|c| !c.is_empty());
            let callback_error = get("error").filter(|c| !c.is_empty());
            let failed_step: Option<&'static str> = if callback_error.is_some() {
                Some("callback-error")
            } else if code.is_none() || client_id.is_none() {
                Some("callback-incomplete")
            } else if wanted_client.as_deref().is_some_and(|w| !w.is_empty())
                && named.is_some()
                && named != wanted_client
            {
                // OpenAI's guide: a callback naming a client id other than the one signing in is rejected
                Some("callback-client-mismatch")
            } else {
                None
            };
            let ok = failed_step.is_none();
            let page = if ok { &pages.done } else { &pages.failed };
            rt.respond(
                req.id,
                200.0,
                vec![
                    ("Content-Type".into(), "text/html; charset=utf-8".into()),
                    (
                        "Content-Security-Policy".into(),
                        "default-src 'none'; style-src 'unsafe-inline'".into(),
                    ),
                    ("Cache-Control".into(), "no-store".into()),
                ],
                free_connect_page_html(page).as_bytes(),
            );
            settle.settle(match (failed_step, code, client_id) {
                (None, Some(code), Some(client_id)) => ChatGptCallback::Ok {
                    code,
                    client_id,
                    port: port.get(),
                },
                (step, _, _) => {
                    let mut failed = ChatGptSignInFailed::of(ChatGptSignInFailure::Denied, step);
                    if let Some(error) = callback_error
                        && subscription_login_error_code_test(&error)
                    {
                        failed.oauth_error = Some(error);
                    }
                    ChatGptCallback::Failed(failed)
                }
            });
        }
    };

    let (server, listening_port) = match rt.listen("127.0.0.1", 0.0, handle).await {
        Ok(listening) => listening,
        Err(_) => return failed_callback(ChatGptSignInFailure::Network, Some("loopback")),
    };
    port.set(listening_port);

    let result: Result<ChatGptCallback, JsError> = async {
        let on_timeout = settle.clone();
        let timer = rt.set_timeout(
            options.timeout_ms.unwrap_or(CHATGPT_SIGN_IN_TIMEOUT_MS),
            move || on_timeout.settle(failed_callback(ChatGptSignInFailure::Timeout, None)),
        );
        let mut listener = None;
        if let Some(signal) = &options.signal {
            let on_abort = settle.clone();
            listener = Some(signal.on_abort(move |_| {
                on_abort.settle(failed_callback(ChatGptSignInFailure::Cancelled, None))
            }));
        }
        if options.signal.as_ref().is_some_and(Signal::aborted) {
            settle.settle(failed_callback(ChatGptSignInFailure::Cancelled, None));
        } else {
            let url = (options.authorize_url)(port.get());
            let opened = rt
                .call(OPEN_BROWSER_CALL, JsonValue::Array(vec![text(url)]))
                .await?;
            if !js_truthy(&opened) {
                settle.settle(failed_callback(
                    ChatGptSignInFailure::Network,
                    Some("browser"),
                ));
            }
        }
        let result = outcome.await;
        rt.clear_timeout(Some(timer));
        if let (Some(signal), Some(listener)) = (&options.signal, listener) {
            signal.off(listener);
        }
        Ok(result)
    }
    .await;
    server.close();
    match result {
        Ok(result) => result,
        Err(_) => failed_callback(ChatGptSignInFailure::Network, Some("browser")),
    }
}

/// `oauthErrorOf(body)`: the token endpoint's OAuth error code, passed on
/// only with an identifier's shape: never free text
fn oauth_error_of(body: Option<&JsonValue>) -> Option<String> {
    let code = as_str(body.and_then(|b| prop(b, "error")))?;
    subscription_login_error_code_test(code).then(|| code.to_owned())
}

/// `tokenSetOf(body, now)`; `Err` is the `TypeError` a `null` body makes
fn token_set_of(body: &JsonValue, now: f64) -> Result<Option<ChatGptTokenSet>, JsError> {
    if matches!(body, JsonValue::Null) {
        return Err(JsError::type_error(
            "Cannot read properties of null (reading 'access_token')",
        ));
    }
    let Some(access_token) = as_str(prop(body, "access_token")).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let Some(refresh_token) = as_str(prop(body, "refresh_token")).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let seconds = match prop(body, "expires_in") {
        Some(JsonValue::Number(n)) if n.is_finite() && *n > 0.0 => *n,
        _ => 3600.0,
    };
    let scope = as_str(prop(body, "scope"));
    let scopes: Vec<String> = match scope {
        Some(scope) => js_regex!(r"\s+")
            .split(scope)
            .into_iter()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        None => Vec::new(),
    };
    Ok(Some(ChatGptTokenSet {
        access_token: access_token.to_owned(),
        refresh_token: refresh_token.to_owned(),
        expires_at: now + seconds * 1000.0,
        scopes,
        id_token: as_str(prop(body, "id_token"))
            .filter(|t| !t.is_empty())
            .map(str::to_owned),
        scope_missing: scope.is_none(),
    }))
}

fn form_request(url_body: String, signal: Signal) -> Init {
    Init {
        request: Request {
            method: Some("POST".into()),
            headers: vec![(
                "Content-Type".into(),
                "application/x-www-form-urlencoded".into(),
            )],
            body: Some(RequestBody::Text(url_body)),
            redirect: None,
        },
        signal: Some(signal),
    }
}

/// the `request` of `exchangeChatGptCode`
#[derive(Debug, Clone, PartialEq)]
pub struct ChatGptCodeRequest {
    pub code: String,
    pub client_id: String,
    pub verifier: String,
    pub port: f64,
    /// the callback path the code was asked for with; `None`: the one new registrations use
    pub callback_path: Option<String>,
}

/// `{ ok: true; tokens } | ChatGptSignInFailed`
#[derive(Debug, Clone, PartialEq)]
pub enum ChatGptExchange {
    Ok(ChatGptTokenSet),
    Failed(ChatGptSignInFailed),
}

impl ChatGptExchange {
    pub fn to_json(&self) -> JsonValue {
        match self {
            ChatGptExchange::Ok(tokens) => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("tokens", tokens.to_json()),
            ]),
            ChatGptExchange::Failed(failed) => failed.to_json(),
        }
    }
}

/// `exchangeChatGptCode(request, fetchImpl, signal, now)`: trade the code from
/// the browser for tokens
pub async fn exchange_chatgpt_code(
    rt: &Rt,
    fx: &AiFetch,
    request: &ChatGptCodeRequest,
    fetch_impl: &FetchLike,
    signal: Option<&Signal>,
    now: Option<&dyn Fn() -> f64>,
) -> ChatGptExchange {
    let reached = Cell::new(false);
    // a code is good once: sent again after a try that may have arrived, it can only be refused
    let resent = Rc::new(Cell::new(false));
    let attempt: Result<ChatGptExchange, JsError> = async {
        let body = form_body(&[
            ("grant_type", "authorization_code"),
            ("code", &request.code),
            ("client_id", &request.client_id),
            ("code_verifier", &request.verifier),
            (
                "redirect_uri",
                &chatgpt_redirect_uri(request.port, request.callback_path.as_deref()),
            ),
            ("resource", CHATGPT_RESOURCE),
        ]);
        let init = form_request(body, with_timeout(rt, signal));
        let watched = resent.clone();
        let watch = AiFetchWatch {
            // a block page is the edge's answer: the token service never saw that try
            on_resend: Some(Rc::new(move |why| {
                if why != "blocked" {
                    watched.set(true);
                }
            })),
        };
        let response =
            keyed_fetch(rt, fx, CHATGPT_TOKEN_URL, &init, Some(&watch), fetch_impl).await?;
        reached.set(true);
        if !response.ok() {
            let json = response_json(&response).await.ok();
            let oauth_error = oauth_error_of(json.as_ref());
            // most likely the first try arrived and its answer was lost on the way
            if resent.get() && oauth_error.as_deref() == Some("invalid_grant") {
                return Ok(ChatGptExchange::Failed(ChatGptSignInFailed {
                    reason: ChatGptSignInFailure::Network,
                    step: Some("token-resent"),
                    http_status: Some(response.status()),
                    oauth_error,
                }));
            }
            let status = response.status();
            let refused = status == 400.0 || status == 401.0 || status == 403.0;
            return Ok(ChatGptExchange::Failed(ChatGptSignInFailed {
                reason: if refused {
                    ChatGptSignInFailure::Denied
                } else {
                    ChatGptSignInFailure::Network
                },
                step: Some(if refused {
                    "token-refused"
                } else {
                    "token-http"
                }),
                http_status: Some(status),
                oauth_error,
            }));
        }
        let json = response_json(&response).await?;
        let tokens = token_set_of(&json, clock(rt, now))?;
        Ok(match tokens {
            Some(tokens) => ChatGptExchange::Ok(tokens),
            None => ChatGptExchange::Failed(ChatGptSignInFailed::of(
                ChatGptSignInFailure::Network,
                Some("token-unreadable"),
            )),
        })
    }
    .await;
    match attempt {
        Ok(result) => result,
        Err(_) => {
            if signal.is_some_and(Signal::aborted) {
                return ChatGptExchange::Failed(ChatGptSignInFailed::of(
                    ChatGptSignInFailure::Cancelled,
                    None,
                ));
            }
            ChatGptExchange::Failed(ChatGptSignInFailed::of(
                ChatGptSignInFailure::Network,
                Some(if reached.get() {
                    "token-unreadable"
                } else {
                    "token-unreachable"
                }),
            ))
        }
    }
}

/// `UNUSABLE_GRANT_ERRORS`: refresh-token errors after which the stored session is of no more use
const UNUSABLE_GRANT_ERRORS: [&str; 6] = [
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
];

/// `ChatGptRefreshResult`: ok: new tokens (store them all at once, the
/// refresh token included); signed-out: the session is gone and the user must
/// sign in again; failed: a passing failure: keep the tokens and try later.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatGptRefreshResult {
    Ok(ChatGptTokenSet),
    SignedOut,
    Failed,
}

impl ChatGptRefreshResult {
    pub fn to_json(&self) -> JsonValue {
        match self {
            ChatGptRefreshResult::Ok(tokens) => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("tokens", tokens.to_json()),
            ]),
            ChatGptRefreshResult::SignedOut => object(vec![
                ("ok", JsonValue::Bool(false)),
                ("reason", text("signed-out")),
            ]),
            ChatGptRefreshResult::Failed => object(vec![
                ("ok", JsonValue::Bool(false)),
                ("reason", text("failed")),
            ]),
        }
    }
}

/// `refreshChatGptTokens(request, fetchImpl, signal, now)`
pub async fn refresh_chatgpt_tokens(
    rt: &Rt,
    fx: &AiFetch,
    client_id: &str,
    refresh_token: &str,
    fetch_impl: &FetchLike,
    signal: Option<&Signal>,
    now: Option<&dyn Fn() -> f64>,
) -> ChatGptRefreshResult {
    let attempt: Result<ChatGptRefreshResult, JsError> = async {
        let body = form_body(&[
            ("grant_type", "refresh_token"),
            ("client_id", client_id),
            ("refresh_token", refresh_token),
            ("resource", CHATGPT_RESOURCE),
        ]);
        let init = form_request(body, with_timeout(rt, signal));
        let response = keyed_fetch(rt, fx, CHATGPT_TOKEN_URL, &init, None, fetch_impl).await?;
        if !response.ok() {
            let status = response.status();
            if (400.0..500.0).contains(&status) {
                let json = response_json(&response)
                    .await
                    .unwrap_or_else(|_| JsonValue::Object(Obj::new()));
                // a `null` body is read as a record and throws
                if matches!(json, JsonValue::Null) {
                    return Err(JsError::type_error(
                        "Cannot read properties of null (reading 'error')",
                    ));
                }
                let code = as_str(prop(&json, "error")).unwrap_or("");
                // an unknown 4xx is no proof the session is gone: try again later
                if UNUSABLE_GRANT_ERRORS.contains(&code) || status == 401.0 {
                    return Ok(ChatGptRefreshResult::SignedOut);
                }
            }
            return Ok(ChatGptRefreshResult::Failed);
        }
        let json = response_json(&response).await?;
        let tokens = token_set_of(&json, clock(rt, now))?;
        Ok(match tokens {
            Some(tokens) => ChatGptRefreshResult::Ok(tokens),
            None => ChatGptRefreshResult::Failed,
        })
    }
    .await;
    attempt.unwrap_or(ChatGptRefreshResult::Failed)
}

/// `revokeChatGptSession(request, fetchImpl, signal)`: revoke the renewable
/// session at sign-out. true means the session is surely gone.
pub async fn revoke_chatgpt_session(
    rt: &Rt,
    fx: &AiFetch,
    client_id: &str,
    refresh_token: &str,
    fetch_impl: &FetchLike,
    signal: Option<&Signal>,
) -> bool {
    let attempt: Result<bool, JsError> = async {
        let config_init = Init {
            request: Request::default(),
            signal: Some(with_timeout(rt, signal)),
        };
        let config = call_base(
            rt,
            fx,
            fetch_impl,
            CHATGPT_OIDC_CONFIG_URL,
            &config_init,
            None,
        )
        .await?;
        if !config.ok() {
            return Ok(false);
        }
        let config_json = response_json(&config).await?;
        if matches!(config_json, JsonValue::Null) {
            return Err(JsError::type_error(
                "Cannot read properties of null (reading 'revocation_endpoint')",
            ));
        }
        let endpoint = prop(&config_json, "revocation_endpoint");
        // the address comes off the network: only OpenAI's own sign-in host gets the token
        let Some(endpoint) = as_str(endpoint) else {
            return Ok(false);
        };
        let parsed = super::protocols_shared::parse_url(endpoint)?;
        if parsed.origin().ascii_serialization() != CHATGPT_ISSUER {
            return Ok(false);
        }
        let body = form_body(&[
            ("token", refresh_token),
            ("token_type_hint", "refresh_token"),
            ("client_id", client_id),
        ]);
        let init = form_request(body, with_timeout(rt, signal));
        let response = keyed_fetch(rt, fx, endpoint, &init, None, fetch_impl).await?;
        Ok(response.ok())
    }
    .await;
    attempt.unwrap_or(false)
}

// ── The ID token ──

/// `ChatGptIdentity`
#[derive(Debug, Clone, PartialEq)]
pub struct ChatGptIdentity {
    /// the account's stable id
    pub subject: String,
    /// for display only; never written anywhere
    pub email: Option<String>,
}

impl ChatGptIdentity {
    pub fn to_json(&self) -> JsonValue {
        let mut out = Obj::new();
        out.set("subject", text(self.subject.clone()));
        if let Some(email) = &self.email {
            out.set("email", text(email.clone()));
        }
        JsonValue::Object(out)
    }
}

/// `fetchChatGptSigningKeys(fetchImpl, signal)`: the keys OpenAI signs ID tokens with
pub async fn fetch_chatgpt_signing_keys(
    rt: &Rt,
    fx: &AiFetch,
    fetch_impl: &FetchLike,
    signal: Option<&Signal>,
) -> Result<Vec<JsonValue>, JsError> {
    let init = Init {
        request: Request::default(),
        signal: Some(with_timeout(rt, signal)),
    };
    let response = call_base(rt, fx, fetch_impl, CHATGPT_JWKS_URL, &init, None).await?;
    if !response.ok() {
        return Err(JsError::error(format!(
            "JWKS request failed with HTTP {}",
            number_to_string(response.status())
        )));
    }
    let body = response_json(&response).await?;
    if matches!(body, JsonValue::Null) {
        return Err(JsError::type_error(
            "Cannot read properties of null (reading 'keys')",
        ));
    }
    Ok(match prop(&body, "keys") {
        Some(JsonValue::Array(keys)) => keys
            .iter()
            .filter(|key| as_record(key).is_some())
            .cloned()
            .collect(),
        _ => Vec::new(),
    })
}

/// `signatureValid(alg, data, signature, jwk)`: `createPublicKey` and
/// `verify` of `node:crypto`. `main-core` has no crypto for RS256 and ES256,
/// so the host brings it. `Err` is what `createPublicKey` or `verify` threw
/// (a malformed key); an `alg` that is neither is `Ok(false)` once the key
/// was read.
pub trait JwtSignatureVerifier {
    fn signature_valid(
        &self,
        alg: &str,
        data: &[u8],
        signature: &[u8],
        jwk: &JsonValue,
    ) -> Result<bool, JsError>;
}

/// `decodeSegment(segment)`
fn decode_segment(segment: &str) -> Result<JsonValue, JsError> {
    let bytes = buffer_from_base64(segment);
    json_parse(&String::from_utf8_lossy(&bytes))
        .map_err(|e| JsError::new("SyntaxError", e.message()))
}

/// the `expected` of `verifyChatGptIdToken`
#[derive(Debug, Clone, PartialEq)]
pub struct ChatGptExpectedToken {
    pub client_id: String,
    pub nonce: Option<String>,
}

fn verify_id_token(
    id_token: &str,
    expected: &ChatGptExpectedToken,
    keys: &[JsonValue],
    now_seconds: f64,
    verifier: &dyn JwtSignatureVerifier,
) -> Result<Option<ChatGptIdentity>, JsError> {
    let parts: Vec<&str> = id_token.split('.').collect();
    if parts.len() != 3 {
        return Ok(None);
    }
    let (raw_header, raw_payload, raw_signature) = (parts[0], parts[1], parts[2]);
    let header = decode_segment(raw_header)?;
    let payload = decode_segment(raw_payload)?;
    if as_record(&header).is_none() || as_record(&payload).is_none() {
        return Ok(None);
    }
    let alg = as_str(prop(&header, "alg")).unwrap_or("");
    let kid = as_str(prop(&header, "kid"));
    let signature = buffer_from_base64(raw_signature);
    let data = format!("{raw_header}.{raw_payload}");
    // `keys.filter(...)` reads every key's `kid` before any signature is checked
    let mut candidates: Vec<&JsonValue> = Vec::new();
    for key in keys {
        let selected = match kid {
            Some(kid) if !kid.is_empty() => {
                if matches!(key, JsonValue::Null) {
                    return Err(JsError::type_error(
                        "Cannot read properties of null (reading 'kid')",
                    ));
                }
                as_str(prop(key, "kid")) == Some(kid)
            }
            _ => true,
        };
        if selected {
            candidates.push(key);
        }
    }
    let mut valid = false;
    for key in candidates {
        if verifier.signature_valid(alg, data.as_bytes(), &signature, key)? {
            valid = true;
            break;
        }
    }
    if !valid {
        return Ok(None);
    }
    if as_str(prop(&payload, "iss")) != Some(CHATGPT_ISSUER) {
        return Ok(None);
    }
    let wanted = JsonValue::String(expected.client_id.clone());
    let audience_ok = match prop(&payload, "aud") {
        Some(JsonValue::Array(audiences)) => audiences.contains(&wanted),
        Some(single) => *single == wanted,
        None => false,
    };
    if !audience_ok {
        return Ok(None);
    }
    match prop(&payload, "exp") {
        Some(JsonValue::Number(exp)) if *exp + CLOCK_SKEW_SECONDS >= now_seconds => {}
        _ => return Ok(None),
    }
    if let Some(nonce) = &expected.nonce
        && as_str(prop(&payload, "nonce")) != Some(nonce.as_str())
    {
        return Ok(None);
    }
    let Some(subject) = as_str(prop(&payload, "sub")).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    Ok(Some(ChatGptIdentity {
        subject: subject.to_owned(),
        email: as_str(prop(&payload, "email")).map(str::to_owned),
    }))
}

/// `verifyChatGptIdToken(idToken, expected, keys, nowSeconds)`: check an ID
/// token the way OpenAI asks: its signature against the published keys, the
/// issuer, the audience (the issued client id), the expiry, and the nonce of
/// this attempt when there is one. `None` when any check fails.
pub fn verify_chatgpt_id_token(
    id_token: &str,
    expected: &ChatGptExpectedToken,
    keys: &[JsonValue],
    now_seconds: f64,
    verifier: &dyn JwtSignatureVerifier,
) -> Option<ChatGptIdentity> {
    verify_id_token(id_token, expected, keys, now_seconds, verifier)
        .ok()
        .flatten()
}

/// `chatGptAttemptValues()`: fresh random values for one authorization
/// attempt, `(state, nonce)`
pub fn chatgpt_attempt_values(rt: &Rt) -> (String, String) {
    let state = random_token(rt);
    let nonce = random_token(rt);
    (state, nonce)
}
