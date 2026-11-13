//! `packages/ai-provider/src/free-connect.ts`: getting a free connection's
//! key. The OpenRouter browser sign-in (OAuth PKCE) and the Gemini key check.
//!
//! The network is behind [`FreeConnectNet`] (the injectable `fetch`) and
//! [`OpenRouterHost`] (the loopback servers, the browser, the random bytes);
//! the caller implements them. The waiting server's events are explicit
//! methods of [`CodeWait`] that the host's `await_outcome` calls: the first
//! call that settles the wait decides, as the first `settle` of the
//! TypeScript's promise does. A `signal` is the host's: `signal?.aborted` is
//! [`FreeConnectNet::signal_aborted`].
//!
//! Engine-waiting: the HTTP client and the loopback servers themselves.

use super::free_ai_browser::{GEMINI_FREE_MODEL, OPENROUTER_FREE_MODELS};
use super::jsval::{as_str, number, object, prop, text};
use jscompat::{JsonValue, base64, js_regex, json_stringify, sort_by_number, to_primitive, trim};
use sha2::{Digest, Sha256};
use url::Url;

pub const OPENROUTER_AUTH_URL: &str = "https://openrouter.ai/auth";
pub const OPENROUTER_KEYS_URL: &str = "https://openrouter.ai/api/v1/auth/keys";
pub const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
pub const OPENROUTER_KEY_INFO_URL: &str = "https://openrouter.ai/api/v1/key";
pub const GEMINI_MODELS_URL: &str = "https://generativelanguage.googleapis.com/v1beta/models";

/// how long the browser sign-in may take before the waiting server gives up
pub const OPENROUTER_SIGN_IN_TIMEOUT_MS: f64 = 10.0 * 60.0 * 1000.0;

/// the timeout the host puts on each request (`withTimeout`)
pub const REQUEST_TIMEOUT_MS: f64 = 20_000.0;

/// `FreeConnectFailure`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreeConnectFailure {
    Cancelled,
    Timeout,
    Denied,
    Invalid,
    Network,
}

impl FreeConnectFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            FreeConnectFailure::Cancelled => "cancelled",
            FreeConnectFailure::Timeout => "timeout",
            FreeConnectFailure::Denied => "denied",
            FreeConnectFailure::Invalid => "invalid",
            FreeConnectFailure::Network => "network",
        }
    }
}

/// `FreeConnectResult`
#[derive(Debug, Clone, PartialEq)]
pub enum FreeConnectResult {
    Ok { api_key: String, model: String },
    Failed(FreeConnectFailure),
}

impl FreeConnectResult {
    /// The object the TypeScript builds, its keys in the order it writes them.
    pub fn to_json(&self) -> JsonValue {
        match self {
            FreeConnectResult::Ok { api_key, model } => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("apiKey", text(api_key.as_str())),
                ("model", text(model.as_str())),
            ]),
            FreeConnectResult::Failed(reason) => object(vec![
                ("ok", JsonValue::Bool(false)),
                ("reason", text(reason.as_str())),
            ]),
        }
    }
}

/// `FreeConnectPage`: the page the browser shows once it is back on this PC
#[derive(Debug, Clone, PartialEq)]
pub struct FreeConnectPage {
    pub lang: String,
    pub title: String,
    pub body: String,
}

/// the `RequestInit` fields the module sets, in the order it writes them
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FetchRequest {
    pub url: String,
    pub method: Option<&'static str>,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    /// `redirect: 'manual'`, which `keyedFetch` adds
    pub redirect_manual: bool,
}

/// what the module reads of a `Response`
#[derive(Debug, Clone, PartialEq)]
pub struct FetchResponse {
    pub status: u16,
    /// `response.type === 'opaqueredirect'`
    pub opaque_redirect: bool,
    /// `response.headers.get('location')`
    pub location: Option<String>,
    /// `await response.json()`; `Err` is a body that is not JSON
    pub json: Result<JsonValue, String>,
}

impl FetchResponse {
    /// `response.ok`
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The injectable `fetch`, and the abort state of the caller's signal.
pub trait FreeConnectNet {
    /// `fetchImpl(url, init)`; `Err` is a rejection
    fn fetch(&mut self, request: &FetchRequest) -> Result<FetchResponse, String>;
    /// `signal?.aborted`
    fn signal_aborted(&self) -> bool;
}

/// `REDIRECT_STATUSES`
const REDIRECT_STATUSES: [u16; 5] = [301, 302, 303, 307, 308];

/// `keyedFetch(url, init, undefined, fetchImpl)`: one request that follows
/// nothing; an answer that is a redirect is refused (the key must not travel
/// to the address it names).
fn keyed_fetch(
    net: &mut dyn FreeConnectNet,
    mut request: FetchRequest,
) -> Result<FetchResponse, String> {
    request.redirect_manual = true;
    let response = net.fetch(&request)?;
    let redirected = response.opaque_redirect
        || (REDIRECT_STATUSES.contains(&response.status) && response.location.is_some());
    if redirected {
        return Err("redirect refused".to_owned());
    }
    Ok(response)
}

/// `base64url(bytes)`
pub fn base64url(bytes: &[u8]) -> String {
    let standard = base64(bytes);
    let swapped: String = standard
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    swapped.trim_end_matches('=').to_owned()
}

/// `pkcePair()`: a PKCE verifier and its S256 challenge; `random` is the
/// 32 bytes `randomBytes(32)` gives.
pub fn pkce_pair(random: &[u8; 32]) -> (String, String) {
    let verifier = base64url(random);
    let digest = Sha256::digest(verifier.as_bytes());
    let challenge = base64url(&digest);
    (verifier, challenge)
}

/// one value of `URLSearchParams.toString()`: the form encoding, a space as `+`
fn form_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(byte));
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

/// `openRouterAuthUrl(port, challenge)`: the sign-in page address for a
/// callback port and challenge.
pub fn open_router_auth_url(port: f64, challenge: &str) -> String {
    let callback = format!(
        "http://localhost:{}/callback",
        jscompat::number_to_string(port)
    );
    let params = [
        ("callback_url", callback.as_str()),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
    ];
    let query: Vec<String> = params
        .iter()
        .map(|(k, v)| format!("{}={}", form_encode(k), form_encode(v)))
        .collect();
    format!("{OPENROUTER_AUTH_URL}?{}", query.join("&"))
}

/// `escapeHtml(text)`
pub fn escape_html(value: &str) -> String {
    let mut out = String::new();
    for c in value.chars() {
        match c {
            '&' | '<' | '>' | '"' | '\'' => out.push_str(&format!("&#{};", u32::from(c))),
            other => out.push(other),
        }
    }
    out
}

/// `freeConnectPageHtml(page)`: a self-contained page: no script, no outside
/// resource.
pub fn free_connect_page_html(page: &FreeConnectPage) -> String {
    format!(
        "<!doctype html>\n<html lang=\"{lang}\"><head><meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>{title}</title>\n<style>body{{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0}}\nmain{{max-width:28rem;padding:2rem;text-align:center}}h1{{font-size:1.4rem}}p{{line-height:1.6}}</style>\n</head><body><main><h1>{title}</h1><p>{body}</p></main></body></html>",
        lang = escape_html(&page.lang),
        title = escape_html(&page.title),
        body = escape_html(&page.body),
    )
}

/// What the waiting server answers one request with.
#[derive(Debug, Clone, PartialEq)]
pub enum CallbackReply {
    /// `404`, `Content-Type: text/plain; charset=utf-8`, an empty body
    NotFound,
    /// `200` with these headers, in the order written, and this page
    Page {
        headers: Vec<(&'static str, &'static str)>,
        html: String,
    },
}

/// What `waitForCode` settles with.
#[derive(Debug, Clone, PartialEq)]
pub enum CodeResult {
    Code(String),
    Failed(FreeConnectFailure),
}

/// The state of one wait for the browser: `answered` and the promise of
/// `waitForCode`. The host's servers call [`CodeWait::handle`] for each
/// request; its timer, [`CodeWait::timeout`]; the abort listener,
/// [`CodeWait::abort`].
#[derive(Debug)]
pub struct CodeWait {
    pages_done: FreeConnectPage,
    pages_failed: FreeConnectPage,
    answered: bool,
    outcome: Option<CodeResult>,
}

impl CodeWait {
    pub fn new(done: FreeConnectPage, failed: FreeConnectPage) -> Self {
        CodeWait {
            pages_done: done,
            pages_failed: failed,
            answered: false,
            outcome: None,
        }
    }

    /// the first `settle(...)` decides; later ones change nothing
    fn settle(&mut self, result: CodeResult) {
        if self.outcome.is_none() {
            self.outcome = Some(result);
        }
    }

    /// `settle({ ok: false, reason: 'timeout' })`, from the timer
    pub fn timeout(&mut self) {
        self.settle(CodeResult::Failed(FreeConnectFailure::Timeout));
    }

    /// `onAbort`: `settle({ ok: false, reason: 'cancelled' })`
    pub fn abort(&mut self) {
        self.settle(CodeResult::Failed(FreeConnectFailure::Cancelled));
    }

    /// no browser took the sign-in address
    fn browser_refused(&mut self) {
        self.settle(CodeResult::Failed(FreeConnectFailure::Network));
    }

    /// the result once something settled the wait
    pub fn outcome(&self) -> Option<&CodeResult> {
        self.outcome.as_ref()
    }

    /// `handle(req, res)`: one request to a loopback server. `req_url` is
    /// `req.url` (`None` reads as `/`); `Err` is the `TypeError` of
    /// `new URL(...)` on an address that does not parse.
    pub fn handle(&mut self, method: &str, req_url: Option<&str>) -> Result<CallbackReply, String> {
        let base = Url::parse("http://localhost").map_err(|e| e.to_string())?;
        let url = base
            .join(req_url.unwrap_or("/"))
            .map_err(|_| "Invalid URL".to_owned())?;
        if method != "GET" || url.path() != "/callback" || self.answered {
            return Ok(CallbackReply::NotFound);
        }
        self.answered = true;
        let code = url
            .query_pairs()
            .find(|(k, _)| k == "code")
            .map(|(_, v)| v.into_owned());
        let code = code.filter(|c| !c.is_empty());
        let page = if code.is_some() {
            &self.pages_done
        } else {
            &self.pages_failed
        };
        let html = free_connect_page_html(page);
        match code {
            Some(code) => self.settle(CodeResult::Code(code)),
            None => self.settle(CodeResult::Failed(FreeConnectFailure::Denied)),
        }
        Ok(CallbackReply::Page {
            headers: vec![
                ("Content-Type", "text/html; charset=utf-8"),
                (
                    "Content-Security-Policy",
                    "default-src 'none'; style-src 'unsafe-inline'",
                ),
                ("Cache-Control", "no-store"),
            ],
            html,
        })
    }
}

/// The loopback servers, the browser and the random source of the OpenRouter
/// sign-in. `connect_open_router` waits for the browser's redirect inside
/// [`OpenRouterHost::await_outcome`], so it is the middle step of a connect
/// (`FreeAiIpc::plan_connect`, this, `FreeAiIpc::finish_open_router`) that
/// the caller runs off the core thread: a `cancel` or a newer `connect` must
/// land on the core thread meanwhile, and reaches this host as its own
/// `signal_aborted` flag.
pub trait OpenRouterHost: FreeConnectNet {
    /// `randomBytes(32)`
    fn random_bytes(&mut self) -> [u8; 32];
    /// binds `127.0.0.1` on a free port, and `::1` on the same port when this
    /// PC has it; the port. `Err` is a bind that failed.
    fn listen(&mut self) -> Result<f64, String>;
    /// `options.openBrowser(url)`; `Err` is a rejection
    fn open_browser(&mut self, url: &str) -> Result<bool, String>;
    /// `setTimeout(..., timeoutMs)`: the timer that gives the sign-in up; when
    /// it fires the host calls [`CodeWait::timeout`]
    fn start_timer(&mut self, timeout_ms: f64);
    /// Serves the callback until `wait` is settled: each request goes to
    /// [`CodeWait::handle`], the timer to [`CodeWait::timeout`], an abort of
    /// the caller's signal to [`CodeWait::abort`].
    fn await_outcome(&mut self, wait: &mut CodeWait);
    /// `server.close()` and `closeAllConnections()` of every server started
    fn close_servers(&mut self);
}

/// `OpenRouterConnectOptions` without the callbacks the host holds
#[derive(Debug, Clone, PartialEq)]
pub struct OpenRouterConnectOptions {
    pub done: FreeConnectPage,
    pub failed: FreeConnectPage,
    /// `timeoutMs`; `None` is [`OPENROUTER_SIGN_IN_TIMEOUT_MS`]
    pub timeout_ms: Option<f64>,
}

/// `waitForCode(options, challenge)`: wait for the browser to come back with
/// a code.
fn wait_for_code(
    host: &mut dyn OpenRouterHost,
    options: &OpenRouterConnectOptions,
    challenge: &str,
) -> CodeResult {
    let network = CodeResult::Failed(FreeConnectFailure::Network);
    let port = match host.listen() {
        Ok(port) => port,
        Err(_) => {
            host.close_servers();
            return network;
        }
    };
    let mut wait = CodeWait::new(options.done.clone(), options.failed.clone());
    host.start_timer(options.timeout_ms.unwrap_or(OPENROUTER_SIGN_IN_TIMEOUT_MS));
    if host.signal_aborted() {
        wait.abort();
    } else {
        match host.open_browser(&open_router_auth_url(port, challenge)) {
            Ok(true) => {}
            Ok(false) => wait.browser_refused(),
            Err(_) => {
                host.close_servers();
                return network;
            }
        }
    }
    host.await_outcome(&mut wait);
    let result = wait.outcome().cloned().unwrap_or(network);
    host.close_servers();
    result
}

/// `exchangeOpenRouterCode(code, verifier, fetchImpl, signal)`: trade the
/// code from the browser for a key.
pub fn exchange_open_router_code(
    net: &mut dyn FreeConnectNet,
    code: &str,
    verifier: &str,
) -> Result<String, FreeConnectFailure> {
    let attempt = (|| -> Result<Result<String, FreeConnectFailure>, String> {
        let body = json_stringify(&object(vec![
            ("code", text(code)),
            ("code_verifier", text(verifier)),
            ("code_challenge_method", text("S256")),
        ]));
        let response = keyed_fetch(
            net,
            FetchRequest {
                url: OPENROUTER_KEYS_URL.to_owned(),
                method: Some("POST"),
                headers: vec![("Content-Type".to_owned(), "application/json".to_owned())],
                body: Some(body),
                redirect_manual: false,
            },
        )?;
        if response.status == 400 || response.status == 403 {
            return Ok(Err(FreeConnectFailure::Denied));
        }
        if !response.ok() {
            return Ok(Err(FreeConnectFailure::Network));
        }
        let body = response.json?;
        // `body.key` of a `null` body throws
        if matches!(body, JsonValue::Null) {
            return Err("null body".to_owned());
        }
        Ok(match prop(&body, "key") {
            Some(JsonValue::String(key)) if !trim(key).is_empty() => Ok(trim(key).to_owned()),
            _ => Err(FreeConnectFailure::Network),
        })
    })();
    match attempt {
        Ok(result) => result,
        Err(_) if net.signal_aborted() => Err(FreeConnectFailure::Cancelled),
        Err(_) => Err(FreeConnectFailure::Network),
    }
}

/// `Number(x ?? 0)` of a model entry's `context_length`
fn context_length(entry: &JsonValue) -> f64 {
    match prop(entry, "context_length") {
        None | Some(JsonValue::Null) => 0.0,
        Some(value) => to_primitive(Some(value)).map_or(f64::NAN, |p| p.to_number()),
    }
}

/// `pickOpenRouterFreeModel(fetchImpl, signal)`: the free model a new
/// OpenRouter connection runs on: the first of the tested ones OpenRouter
/// still lists with tool support, else the free model with tool support and
/// the longest context, else the first tested one.
pub fn pick_open_router_free_model(net: &mut dyn FreeConnectNet) -> String {
    let first = OPENROUTER_FREE_MODELS[0].to_owned();
    let response = match net.fetch(&FetchRequest {
        url: OPENROUTER_MODELS_URL.to_owned(),
        ..FetchRequest::default()
    }) {
        Ok(response) => response,
        Err(_) => return first,
    };
    if !response.ok() {
        return first;
    }
    let Ok(body) = response.json else {
        return first;
    };
    // `body.data` of a `null` body throws
    if matches!(body, JsonValue::Null) {
        return first;
    }
    let entries: Vec<&JsonValue> = match prop(&body, "data") {
        Some(JsonValue::Array(items)) => items.iter().collect(),
        _ => Vec::new(),
    };
    let mut usable: Vec<&JsonValue> = Vec::new();
    for entry in entries {
        // `m.id` of a `null` entry throws
        if matches!(entry, JsonValue::Null) {
            return first;
        }
        let tools = matches!(
            prop(entry, "supported_parameters"),
            Some(JsonValue::Array(params))
                if params.iter().any(|p| matches!(p, JsonValue::String(s) if s == "tools"))
        );
        if matches!(prop(entry, "id"), Some(JsonValue::String(id)) if id.ends_with(":free"))
            && tools
        {
            usable.push(entry);
        }
    }
    let id_of = |entry: &JsonValue| as_str(prop(entry, "id")).unwrap_or_default().to_owned();
    let tested = OPENROUTER_FREE_MODELS
        .iter()
        .find(|id| usable.iter().any(|m| id_of(*m) == **id));
    if let Some(tested) = tested {
        return (*tested).to_owned();
    }
    sort_by_number(&mut usable, |a, b| context_length(b) - context_length(a));
    usable.first().map_or(first, |entry| id_of(*entry))
}

/// `connectOpenRouter(options)`: the whole OpenRouter browser sign-in: a key
/// and the free model to run on.
pub fn connect_open_router(
    host: &mut dyn OpenRouterHost,
    options: &OpenRouterConnectOptions,
) -> FreeConnectResult {
    let random = host.random_bytes();
    let (verifier, challenge) = pkce_pair(&random);
    let code = match wait_for_code(host, options, &challenge) {
        CodeResult::Code(code) => code,
        CodeResult::Failed(reason) => return FreeConnectResult::Failed(reason),
    };
    let api_key = match exchange_open_router_code(host, &code, &verifier) {
        Ok(key) => key,
        Err(reason) => return FreeConnectResult::Failed(reason),
    };
    let model = pick_open_router_free_model(host);
    FreeConnectResult::Ok { api_key, model }
}

/// `plausibleApiKey(raw)`: how a pasted key looks before it is sent anywhere:
/// one token, no spaces.
pub fn plausible_api_key(raw: Option<&JsonValue>) -> Option<String> {
    let Some(JsonValue::String(raw)) = raw else {
        return None;
    };
    let key = trim(raw);
    js_regex!(r"^[A-Za-z0-9._-]{20,256}$")
        .test(key)
        .then(|| key.to_owned())
}

/// `connectGemini(rawKey, fetchImpl, signal)`: check a pasted Gemini key by
/// listing models: it costs nothing from the free allowance.
pub fn connect_gemini(
    net: &mut dyn FreeConnectNet,
    raw_key: Option<&JsonValue>,
) -> FreeConnectResult {
    let Some(api_key) = plausible_api_key(raw_key) else {
        return FreeConnectResult::Failed(FreeConnectFailure::Invalid);
    };
    let response = keyed_fetch(
        net,
        FetchRequest {
            url: format!("{GEMINI_MODELS_URL}?pageSize=1"),
            method: None,
            headers: vec![("x-goog-api-key".to_owned(), api_key.clone())],
            body: None,
            redirect_manual: false,
        },
    );
    match response {
        Ok(response) if response.ok() => FreeConnectResult::Ok {
            api_key,
            model: GEMINI_FREE_MODEL.to_owned(),
        },
        Ok(response) if matches!(response.status, 400 | 401 | 403) => {
            FreeConnectResult::Failed(FreeConnectFailure::Invalid)
        }
        Ok(_) => FreeConnectResult::Failed(FreeConnectFailure::Network),
        Err(_) if net.signal_aborted() => FreeConnectResult::Failed(FreeConnectFailure::Cancelled),
        Err(_) => FreeConnectResult::Failed(FreeConnectFailure::Network),
    }
}

/// `count(value)`: a finite, non-negative number
fn count(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(n)) if n.is_finite() && *n >= 0.0 => Some(*n),
        _ => None,
    }
}

/// `openRouterFreeQuota(apiKey, fetchImpl, signal)`: today's free requests on
/// an OpenRouter key; `None` when OpenRouter does not say.
pub fn open_router_free_quota(net: &mut dyn FreeConnectNet, api_key: &str) -> Option<JsonValue> {
    if trim(api_key).is_empty() {
        return None;
    }
    let response = keyed_fetch(
        net,
        FetchRequest {
            url: OPENROUTER_KEY_INFO_URL.to_owned(),
            method: None,
            headers: vec![(
                "Authorization".to_owned(),
                format!("Bearer {}", trim(api_key)),
            )],
            body: None,
            redirect_manual: false,
        },
    )
    .ok()?;
    if !response.ok() {
        return None;
    }
    let body = response.json.ok()?;
    // `body.data?.free_model_daily_requests` of a `null` body throws
    if matches!(body, JsonValue::Null) {
        return None;
    }
    let daily = prop(&body, "data").and_then(|d| prop(d, "free_model_daily_requests"));
    let daily = daily.filter(|d| !matches!(d, JsonValue::Null));
    let used = count(daily.and_then(|d| prop(d, "used")))?;
    let limit = count(daily.and_then(|d| prop(d, "limit")))?;
    let remaining = count(daily.and_then(|d| prop(d, "remaining")))?;
    Some(object(vec![
        ("used", number(used)),
        ("limit", number(limit)),
        ("remaining", number(remaining)),
    ]))
}
