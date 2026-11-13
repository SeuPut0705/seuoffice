//! `packages/google-drive/src/oauth.ts`: the page the browser shows once the
//! Google sign-in is back on this PC. Only the pure part is here: the HTML.

/// `SignInPage`: the page the browser shows once it is back on this PC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInPage {
    pub lang: String,
    pub title: String,
    pub body: String,
}

/// `escapeHtml(text)`: each of `& < > " '` as its decimal character
/// reference.
fn escape_html(text: &str) -> String {
    jscompat::js_regex!(r#"[&<>"']"#, "g").replace_all(text, |m| {
        format!("&#{};", m.as_str().encode_utf16().next().unwrap_or(0))
    })
}

/// `signInPageHtml(page)`: a self-contained page: no script, no outside
/// resource.
pub fn sign_in_page_html(page: &SignInPage) -> String {
    format!(
        "<!doctype html>\n\
<html lang=\"{lang}\"><head><meta charset=\"utf-8\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
<title>{title}</title>\n\
<style>body{{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0}}\n\
main{{max-width:28rem;padding:2rem;text-align:center}}h1{{font-size:1.4rem}}p{{line-height:1.6}}</style>\n\
</head><body><main><h1>{title}</h1><p>{body}</p></main></body></html>",
        lang = escape_html(&page.lang),
        title = escape_html(&page.title),
        body = escape_html(&page.body),
    )
}

// ---------------------------------------------------------------------------
// the sign-in itself: the loopback server, the token exchange, the refresh
// ---------------------------------------------------------------------------
//
// What the TypeScript awaits goes through `ai_provider::task`: the loopback
// server is `Rt::listen`, a token call is a fetch of the `Fetcher` the caller
// names, and the caller's `openBrowser` is `Rt::call("openBrowser", [url])`
// (a truthy answer: a browser took the address).

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::{JsonValue, json_parse, math_max, number_to_string, trim};
use sha2::{Digest, Sha256};

use crate::packages::ai_provider::jsval::Obj;
use crate::packages::ai_provider::task::{
    Fetcher, HttpRequest, JsError, Request, RequestBody, Response, Rt, Server, Settle, Signal,
};

/// `GOOGLE_AUTH_URL`
pub const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
/// `GOOGLE_TOKEN_URL`
pub const GOOGLE_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
/// `GOOGLE_REVOKE_URL`
pub const GOOGLE_REVOKE_URL: &str = "https://oauth2.googleapis.com/revoke";

/// `DRIVE_SCOPE`: the one scope the app asks for (decision 0085).
pub const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

/// `MAX_PICKED_FILES`: the most picked file ids one round trip hands on.
pub const MAX_PICKED_FILES: usize = 50;

/// `GOOGLE_SIGN_IN_TIMEOUT_MS`: how long the browser sign-in may take before
/// the waiting server gives up.
pub const GOOGLE_SIGN_IN_TIMEOUT_MS: f64 = 10.0 * 60.0 * 1000.0;

const REQUEST_TIMEOUT_MS: f64 = 20_000.0;

/// `() => number`: a clock the caller passes (`now`); `Date.now` when absent.
pub type Clock = Rc<dyn Fn() -> f64>;

/// `now()` of a function whose `now` defaults to `Date.now`.
pub fn clock_now(rt: &Rt, now: Option<&Clock>) -> f64 {
    match now {
        Some(clock) => clock(),
        None => rt.now(),
    }
}

/// `GoogleClient`: the OAuth client the app was built with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoogleClient {
    pub client_id: String,
    pub client_secret: String,
}

/// `GoogleSignInFailure`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoogleSignInFailure {
    Cancelled,
    Timeout,
    Denied,
    Scope,
    Network,
}

impl GoogleSignInFailure {
    /// the reason as the TypeScript spells it
    pub fn as_str(self) -> &'static str {
        match self {
            GoogleSignInFailure::Cancelled => "cancelled",
            GoogleSignInFailure::Timeout => "timeout",
            GoogleSignInFailure::Denied => "denied",
            GoogleSignInFailure::Scope => "scope",
            GoogleSignInFailure::Network => "network",
        }
    }
}

/// `GoogleTokens`
#[derive(Debug, Clone, PartialEq)]
pub struct GoogleTokens {
    pub refresh_token: String,
    pub access_token: String,
    /// epoch ms after which the access token must not be used
    pub expires_at: f64,
}

/// `GoogleSignInResult`
pub type GoogleSignInResult = Result<GoogleTokens, GoogleSignInFailure>;

/// `PickRequest`: Google's file picker on the consent page; `multiple` lets
/// the person choose more than one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PickRequest {
    pub multiple: bool,
}

/// A sign-in that showed the picker: the tokens and the ids of the chosen
/// files (`GooglePickResult`'s `ok` side).
#[derive(Debug, Clone, PartialEq)]
pub struct GooglePicked {
    pub tokens: GoogleTokens,
    pub picked: Vec<String>,
}

/// `GooglePickResult`
pub type GooglePickResult = Result<GooglePicked, GoogleSignInFailure>;

/// `GoogleSignInOptions['pages']`: what the browser shows after the sign-in,
/// by outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignInPages {
    pub done: SignInPage,
    pub failed: SignInPage,
}

/// `GoogleSignInOptions`; `openBrowser` is `Rt::call("openBrowser", [url])`.
#[derive(Clone)]
pub struct GoogleSignInOptions {
    pub client: GoogleClient,
    pub pages: SignInPages,
    pub signal: Option<Signal>,
    pub fetch: Option<Fetcher>,
    pub timeout_ms: Option<f64>,
    pub now: Option<Clock>,
    pub pick: Option<PickRequest>,
}

/// `base64url(bytes)`
fn base64url(bytes: &[u8]) -> String {
    let standard = jscompat::base64(bytes);
    standard
        .replace('+', "-")
        .replace('/', "_")
        .trim_end_matches('=')
        .to_owned()
}

/// `pkcePair()`: a PKCE verifier and its S256 challenge.
pub fn pkce_pair(rt: &Rt) -> (String, String) {
    let verifier = base64url(&rt.random_bytes(32));
    let challenge = base64url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

/// `redirectUri(port)`: the loopback address Google sends the browser back to.
pub fn redirect_uri(port: f64) -> String {
    format!("http://127.0.0.1:{}/callback", number_to_string(port))
}

/// `new URLSearchParams(pairs).toString()`
fn form(pairs: &[(&str, &str)]) -> String {
    url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs.iter())
        .finish()
}

/// `googleAuthUrl(clientId, port, challenge, state, pick)`: the consent page
/// address.
pub fn google_auth_url(
    client_id: &str,
    port: f64,
    challenge: &str,
    state: &str,
    pick: Option<&PickRequest>,
) -> String {
    let redirect = redirect_uri(port);
    let mut pairs = vec![
        ("client_id", client_id),
        ("redirect_uri", redirect.as_str()),
        ("response_type", "code"),
        ("scope", DRIVE_SCOPE),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        // a refresh token on every sign-in, so a second sign-in replaces the first cleanly
        ("access_type", "offline"),
        ("prompt", "consent"),
    ];
    if let Some(pick) = pick {
        pairs.push(("trigger_onepick", "true"));
        if pick.multiple {
            pairs.push(("allow_multiple", "true"));
        }
    }
    format!("{GOOGLE_AUTH_URL}?{}", form(&pairs))
}

/// `pickedFileIds(raw)`: the file ids in a `picked_file_ids` answer:
/// comma-separated, each checked against Drive's id shape, duplicates
/// dropped, at most `MAX_PICKED_FILES`.
pub fn picked_file_ids(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for id in raw.split(',') {
        let trimmed = trim(id);
        if jscompat::js_regex!(r"^[\w-]{1,200}$").test(trimmed)
            && !out.iter().any(|seen| seen == trimmed)
        {
            out.push(trimmed.to_owned());
        }
        if out.len() >= MAX_PICKED_FILES {
            break;
        }
    }
    out
}

/// `value.key` on a parsed JSON value: `undefined` is `None`; reading a
/// property of `null` throws as JavaScript does.
pub(crate) fn member(value: &JsonValue, key: &str) -> Result<Option<JsonValue>, JsError> {
    if matches!(value, JsonValue::Null) {
        return Err(JsError::type_error(format!(
            "Cannot read properties of null (reading '{key}')"
        )));
    }
    Ok(value.get(key).map(std::borrow::Cow::into_owned))
}

/// `await response.json()`
pub(crate) async fn response_json(response: &Response) -> Result<JsonValue, JsError> {
    let text = response.text().await?;
    json_parse(&text).map_err(|e| JsError::new("SyntaxError", e.message()))
}

/// `withTimeout(signal)`
fn with_timeout(rt: &Rt, signal: Option<&Signal>) -> Signal {
    let timeout = rt.timeout_signal(REQUEST_TIMEOUT_MS);
    match signal {
        Some(signal) => rt.any_signal(&[signal, &timeout]),
        None => timeout,
    }
}

/// `sameText(a, b)`: equal bytes, compared in constant time.
fn same_text(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |diff, (x, y)| diff | (x ^ y))
            == 0
}

/// The result of `waitForCode`.
#[derive(Debug, Clone, PartialEq)]
enum CodeOutcome {
    Code {
        code: String,
        port: f64,
        picked: Vec<String>,
    },
    Failed(GoogleSignInFailure),
}

/// `url.searchParams.get(name)`
fn query_get(url: &url::Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// The handler of the loopback server (`handle` of `waitForCode`): it answers
/// one `/callback` request whose `state` matches.
struct Callback {
    rt: Rt,
    pages: SignInPages,
    pick: bool,
    state: String,
    port: Rc<Cell<f64>>,
    answered: Rc<Cell<bool>>,
    settle: Settle<CodeOutcome>,
}

impl Callback {
    fn handle(&self, request: HttpRequest) {
        let Some(url) = url::Url::parse("http://127.0.0.1")
            .ok()
            .and_then(|base| base.join(&request.url).ok())
        else {
            // `new URL` throws in a handler no promise awaits
            return;
        };
        let returned_state = query_get(&url, "state").unwrap_or_default();
        // a stray request (favicon, another program guessing) neither answers nor ends the wait
        if request.method != "GET"
            || url.path() != "/callback"
            || self.answered.get()
            || !same_text(&returned_state, &self.state)
        {
            self.rt.respond(
                request.id,
                404.0,
                vec![(
                    "Content-Type".to_owned(),
                    "text/plain; charset=utf-8".to_owned(),
                )],
                b"",
            );
            return;
        }
        self.answered.set(true);
        let code = query_get(&url, "code").filter(|c| !c.is_empty());
        // the token answer is checked again; this only spares a round trip when Drive was unticked
        let scope = query_get(&url, "scope");
        let granted = scope
            .as_deref()
            .is_none_or(|scope| scope.split(' ').any(|part| part == DRIVE_SCOPE));
        let ok = code.is_some() && granted;
        self.rt.respond(
            request.id,
            200.0,
            vec![
                (
                    "Content-Type".to_owned(),
                    "text/html; charset=utf-8".to_owned(),
                ),
                (
                    "Content-Security-Policy".to_owned(),
                    "default-src 'none'; style-src 'unsafe-inline'".to_owned(),
                ),
                ("Cache-Control".to_owned(), "no-store".to_owned()),
            ],
            sign_in_page_html(if ok {
                &self.pages.done
            } else {
                &self.pages.failed
            })
            .as_bytes(),
        );
        match code {
            Some(code) if granted => self.settle.settle(CodeOutcome::Code {
                code,
                port: self.port.get(),
                picked: picked_file_ids(query_get(&url, "picked_file_ids").as_deref()),
            }),
            Some(_) => self
                .settle
                .settle(CodeOutcome::Failed(GoogleSignInFailure::Scope)),
            // closing the picker comes back as a refusal; nothing was asked of Google then
            None => self.settle.settle(CodeOutcome::Failed(if self.pick {
                GoogleSignInFailure::Cancelled
            } else {
                GoogleSignInFailure::Denied
            })),
        }
    }
}

/// The `try` of `waitForCode`: the server the caller closes in its `finally`
/// goes into `slot` as soon as it listens.
async fn listen_and_wait(
    rt: &Rt,
    options: &GoogleSignInOptions,
    challenge: &str,
    state: &str,
    slot: &RefCell<Option<Server>>,
) -> Result<CodeOutcome, JsError> {
    let (settle, outcome) = rt.deferred::<CodeOutcome>();
    let port = Rc::new(Cell::new(0.0_f64));
    let callback = Callback {
        rt: rt.clone(),
        pages: options.pages.clone(),
        pick: options.pick.is_some(),
        state: state.to_owned(),
        port: port.clone(),
        answered: Rc::new(Cell::new(false)),
        settle: settle.clone(),
    };
    let (server, bound) = rt
        .listen("127.0.0.1", 0.0, move |request| callback.handle(request))
        .await?;
    port.set(bound);
    *slot.borrow_mut() = Some(server);
    let timer = {
        let settle = settle.clone();
        rt.set_timeout(
            options.timeout_ms.unwrap_or(GOOGLE_SIGN_IN_TIMEOUT_MS),
            move || settle.settle(CodeOutcome::Failed(GoogleSignInFailure::Timeout)),
        )
    };
    let on_abort = options.signal.as_ref().map(|signal| {
        let settle = settle.clone();
        signal.on_abort(move |_| settle.settle(CodeOutcome::Failed(GoogleSignInFailure::Cancelled)))
    });
    if options.signal.as_ref().is_some_and(Signal::aborted) {
        settle.settle(CodeOutcome::Failed(GoogleSignInFailure::Cancelled));
    } else {
        let address = google_auth_url(
            &options.client.client_id,
            bound,
            challenge,
            state,
            options.pick.as_ref(),
        );
        let opened = rt
            .call(
                "openBrowser",
                JsonValue::Array(vec![JsonValue::String(address)]),
            )
            .await?;
        if !opened.truthy() {
            settle.settle(CodeOutcome::Failed(GoogleSignInFailure::Network));
        }
    }
    let result = outcome.await;
    rt.clear_timeout(Some(timer));
    if let (Some(signal), Some(listener)) = (options.signal.as_ref(), on_abort) {
        signal.off(listener);
    }
    Ok(result)
}

/// `waitForCode(options, challenge, state)`: wait for the browser to come
/// back with a code. The redirect names 127.0.0.1, so only that address is
/// bound: nothing off this PC can reach the server, and it answers one
/// `/callback` request whose `state` matches.
async fn wait_for_code(
    rt: &Rt,
    options: &GoogleSignInOptions,
    challenge: &str,
    state: &str,
) -> CodeOutcome {
    let slot: RefCell<Option<Server>> = RefCell::new(None);
    let outcome = match listen_and_wait(rt, options, challenge, state, &slot).await {
        Ok(outcome) => outcome,
        Err(_) => CodeOutcome::Failed(GoogleSignInFailure::Network),
    };
    // finally: server.close(), then closeAllConnections (nothing to do here)
    if let Some(server) = slot.borrow_mut().take() {
        server.close();
    }
    outcome
}

/// `tokensFrom(body, now)`
struct AnswerTokens {
    access_token: String,
    expires_at: f64,
    refresh_token: Option<String>,
}

fn tokens_from(body: &JsonValue, now: f64) -> Result<Option<AnswerTokens>, JsError> {
    let access_token = match member(body, "access_token")? {
        Some(JsonValue::String(token)) if !token.is_empty() => token,
        _ => return Ok(None),
    };
    let seconds = match member(body, "expires_in")? {
        Some(JsonValue::Number(seconds)) if seconds.is_finite() => seconds,
        _ => 0.0,
    };
    // a minute's margin so a token is never used in its last moments
    let expires_at = now + math_max(0.0, seconds - 60.0) * 1000.0;
    let refresh_token = match member(body, "refresh_token")? {
        Some(JsonValue::String(token)) if !token.is_empty() => Some(token),
        _ => None,
    };
    Ok(Some(AnswerTokens {
        access_token,
        expires_at,
        refresh_token,
    }))
}

fn form_post(body: String) -> Request {
    Request {
        method: Some("POST".to_owned()),
        headers: vec![(
            "Content-Type".to_owned(),
            "application/x-www-form-urlencoded".to_owned(),
        )],
        body: Some(RequestBody::Text(body)),
        redirect: None,
    }
}

/// `exchangeGoogleCode(client, code, verifier, port, fetchImpl, signal, now)`:
/// trade the code from the browser for tokens.
#[allow(clippy::too_many_arguments)]
pub async fn exchange_google_code(
    rt: &Rt,
    client: &GoogleClient,
    code: &str,
    verifier: &str,
    port: f64,
    fetch: Fetcher,
    signal: Option<&Signal>,
    now: Option<&Clock>,
) -> GoogleSignInResult {
    let tried: Result<GoogleSignInResult, JsError> = async {
        let redirect = redirect_uri(port);
        let request = form_post(form(&[
            ("code", code),
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
            ("redirect_uri", redirect.as_str()),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier),
        ]));
        let timeout = with_timeout(rt, signal);
        let response = rt
            .fetch(fetch, GOOGLE_TOKEN_URL, request, Some(&timeout))
            .await?;
        if response.status() == 400.0 || response.status() == 401.0 {
            return Ok(Err(GoogleSignInFailure::Denied));
        }
        if !response.ok() {
            return Ok(Err(GoogleSignInFailure::Network));
        }
        let body = response_json(&response).await?;
        if let Some(JsonValue::String(scope)) = member(&body, "scope")?
            && !scope.split(' ').any(|part| part == DRIVE_SCOPE)
        {
            return Ok(Err(GoogleSignInFailure::Scope));
        }
        let now_ms = clock_now(rt, now);
        let Some(tokens) = tokens_from(&body, now_ms)? else {
            return Ok(Err(GoogleSignInFailure::Network));
        };
        let Some(refresh_token) = tokens.refresh_token else {
            return Ok(Err(GoogleSignInFailure::Network));
        };
        Ok(Ok(GoogleTokens {
            refresh_token,
            access_token: tokens.access_token,
            expires_at: tokens.expires_at,
        }))
    }
    .await;
    match tried {
        Ok(result) => result,
        Err(_) => Err(if signal.is_some_and(Signal::aborted) {
            GoogleSignInFailure::Cancelled
        } else {
            GoogleSignInFailure::Network
        }),
    }
}

/// `RefreshResult`'s failure: `Revoked`: Google no longer honours the
/// refresh token (the user removed the app's access, changed the password,
/// or a test-mode token aged out); the connection is over. `Network`: try
/// again later; the token may still be good.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshFailure {
    Revoked,
    Network,
}

impl RefreshFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            RefreshFailure::Revoked => "revoked",
            RefreshFailure::Network => "network",
        }
    }
}

/// `RefreshResult`'s `ok` side.
#[derive(Debug, Clone, PartialEq)]
pub struct Refreshed {
    pub access_token: String,
    pub expires_at: f64,
}

/// `RefreshResult`
pub type RefreshResult = Result<Refreshed, RefreshFailure>;

/// `refreshGoogleToken(client, refreshToken, fetchImpl, signal, now)`: a
/// fresh access token from the refresh token.
pub async fn refresh_google_token(
    rt: &Rt,
    client: &GoogleClient,
    refresh_token: &str,
    fetch: Fetcher,
    signal: Option<&Signal>,
    now: Option<&Clock>,
) -> RefreshResult {
    let tried: Result<RefreshResult, JsError> = async {
        let request = form_post(form(&[
            ("client_id", client.client_id.as_str()),
            ("client_secret", client.client_secret.as_str()),
            ("refresh_token", refresh_token),
            ("grant_type", "refresh_token"),
        ]));
        let timeout = with_timeout(rt, signal);
        let response = rt
            .fetch(fetch, GOOGLE_TOKEN_URL, request, Some(&timeout))
            .await?;
        if response.status() == 400.0 || response.status() == 401.0 {
            let body = response_json(&response)
                .await
                .unwrap_or_else(|_| JsonValue::Object(Obj::new()));
            // invalid_grant is the one answer that means the grant itself is gone
            return Ok(
                if member(&body, "error")? == Some(JsonValue::String("invalid_grant".to_owned())) {
                    Err(RefreshFailure::Revoked)
                } else {
                    Err(RefreshFailure::Network)
                },
            );
        }
        if !response.ok() {
            return Ok(Err(RefreshFailure::Network));
        }
        let body = response_json(&response).await?;
        let now_ms = clock_now(rt, now);
        Ok(match tokens_from(&body, now_ms)? {
            Some(tokens) => Ok(Refreshed {
                access_token: tokens.access_token,
                expires_at: tokens.expires_at,
            }),
            None => Err(RefreshFailure::Network),
        })
    }
    .await;
    tried.unwrap_or(Err(RefreshFailure::Network))
}

/// `revokeGoogleToken(token, fetchImpl)`: ask Google to forget the grant.
/// Best effort: the app forgets the token either way.
pub async fn revoke_google_token(rt: &Rt, token: &str, fetch: Fetcher) -> bool {
    let tried: Result<bool, JsError> = async {
        let request = form_post(form(&[("token", token)]));
        let timeout = with_timeout(rt, None);
        let response = rt
            .fetch(fetch, GOOGLE_REVOKE_URL, request, Some(&timeout))
            .await?;
        Ok(response.ok())
    }
    .await;
    tried.unwrap_or(false)
}

/// `signInWithGoogle(options)`: the whole browser sign-in: consent in the
/// browser (with Google's picker when `pick` is given), then the code traded
/// for tokens.
pub async fn sign_in_with_google(rt: &Rt, options: &GoogleSignInOptions) -> GooglePickResult {
    let Some(fetch) = options.fetch else {
        return Err(GoogleSignInFailure::Network);
    };
    let (verifier, challenge) = pkce_pair(rt);
    let state = base64url(&rt.random_bytes(16));
    let (code, port, picked) = match wait_for_code(rt, options, &challenge, &state).await {
        CodeOutcome::Code { code, port, picked } => (code, port, picked),
        CodeOutcome::Failed(reason) => return Err(reason),
    };
    let tokens = exchange_google_code(
        rt,
        &options.client,
        &code,
        &verifier,
        port,
        fetch,
        options.signal.as_ref(),
        options.now.as_ref(),
    )
    .await?;
    Ok(GooglePicked { tokens, picked })
}
