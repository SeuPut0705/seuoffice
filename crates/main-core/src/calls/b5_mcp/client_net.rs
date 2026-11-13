//! Group `b5-mcp`, slice `client_net`: see tools/main-diff/groups/b5-mcp/client-net.ts.
//!
//! The names are `<file>.<export>`. The scenarios drive the state machines of
//! `shell/mcp_client/{oauth_loopback,oauth,remote}` with the script the
//! TypeScript runs the real modules with: [`World`] is the host. It answers
//! `fetch` from the case's scripted answers, resolves names from the case's
//! table, numbers timers, streams and servers as the TypeScript's fakes do,
//! and writes each call it is asked for in the list (`net`, `timers`,
//! `store`, `server`, `browser`, `events`) and the step it happens in.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use jscompat::{JsonValue, json_parse, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg};
use crate::packages::ai_provider::settings_secrets::CodecThrow;
use crate::packages::google_drive::oauth::SignInPage;
use crate::packages::mcp_sdk::auth::AuthHost;
use crate::packages::mcp_sdk::client::net::{
    Body, FetchError, FetchHost, FetchInit, FetchResponse, Headers, Redirect,
};
use crate::packages::mcp_sdk::client::{AbortReason, OutputCheck};
use crate::shell::mcp_client::address::ResolveFailed;
use crate::shell::mcp_client::listing::McpListing;
use crate::shell::mcp_client::oauth::{
    AuthFetch, MCP_SIGN_IN_TIMEOUT_MS, McpOAuthAccess, McpSignInOptions, McpSignInResult, NetHost,
    RefreshNet, RefreshOutcome, SignIn, SignInContext, SignInHost, SignInResult, StoredOAuth,
    access_token_expired, parse_stored_oauth, refresh_stored_oauth, revoke_stored_oauth,
    serialize_stored_oauth, store_oauth_access,
};
use crate::shell::mcp_client::oauth_loopback::{
    LoopbackHost, LoopbackOutcome, LoopbackPages, LoopbackReceiver, LoopbackResponse,
};
use crate::shell::mcp_client::remote::{
    RemoteConnection, RemoteError, RemoteHost, RemoteMcpConnectionOptions, RemoteMcpError,
    RemoteMcpErrorReason, RemoteResult, RemoteServerSettings, SignalRef, status_failure_of,
};
use crate::shell::mcp_client::secrets::McpSecretCodec;
use crate::shell::mcp_client::store::{McpOAuthConfig, create_mcp_servers_store};
use crate::shell::mcp_servers_api::McpTransport;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = cx;
    let first = arg(args, 0).cloned().unwrap_or(Value::Null);
    let answer = match name {
        "oauth-loopback.scenario" => ok(run_loopback(&first)),
        "oauth.parseStoredOAuth" => ok(parse_stored(&first)),
        "oauth.serializeStoredOAuth" => {
            ok(Value::String(serialize_stored_oauth(&stored_of(&first))))
        }
        "oauth.accessTokenExpired" => ok(Value::Bool(access_token_expired(
            &stored_of(&first),
            arg(args, 1).and_then(Value::as_f64).unwrap_or(f64::NAN),
        ))),
        "oauth.authFetch" => ok(run_auth_fetch(&first)),
        "oauth.refreshStoredOAuth" => ok(run_refresh(&first)),
        "oauth.revokeStoredOAuth" => ok(run_revoke(&first)),
        "oauth.signIn" => ok(run_sign_in(&first)),
        "oauth.storeOAuthAccess" => return Some(run_store_access(args)),
        "oauth.MCP_SIGN_IN_TIMEOUT_MS" => ok(Value::from(MCP_SIGN_IN_TIMEOUT_MS)),
        "remote.scenario" => return Some(run_remote(&first)),
        "remote.statusFailureOf" => ok(status_failure(&first)),
        "remote.RemoteMcpError" => ok(remote_error(&first, arg(args, 1))),
        _ => return None,
    };
    Some(answer)
}

fn ok(value: Value) -> Answer {
    Ok(Some(value))
}

// ---- JSON helpers ----

fn jv(value: &Value) -> JsonValue {
    json_value_from_serde(value)
}

fn sv(value: &JsonValue) -> Value {
    json_value_to_serde(value)
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn bool_field(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool) == Some(true)
}

fn hex_bytes(text: &str) -> Vec<u8> {
    let digits: Vec<u8> = text.bytes().collect();
    digits
        .chunks(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16).unwrap_or(0) as u8;
            let low = pair
                .get(1)
                .map_or(0, |b| (*b as char).to_digit(16).unwrap_or(0) as u8);
            high << 4 | low
        })
        .collect()
}

fn steps_of(cfg: &Value) -> Vec<Value> {
    cfg.get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

// ---- pure ----

/// `StoredOAuth` as `JSON.parse(JSON.stringify(stored))` shows it
fn stored_json(stored: &StoredOAuth) -> Value {
    json_parse(&serialize_stored_oauth(stored)).map_or(Value::Null, |v| sv(&v))
}

/// a `StoredOAuth` object of a case, as the TypeScript is handed it
fn stored_of(value: &Value) -> StoredOAuth {
    let value = jv(value);
    let prop = |key: &str| value.get(key).map(|v| v.into_owned());
    StoredOAuth {
        tokens: prop("tokens").unwrap_or(JsonValue::Null),
        expires_at: match prop("expiresAt") {
            Some(JsonValue::Number(at)) => Some(at),
            _ => None,
        },
        authorization_server_url: match prop("authorizationServerUrl") {
            Some(JsonValue::String(url)) => url,
            _ => String::new(),
        },
        metadata: prop("metadata").unwrap_or(JsonValue::Null),
        resource: match prop("resource") {
            Some(JsonValue::String(resource)) => Some(resource),
            _ => None,
        },
        registered_client: match prop("registeredClient") {
            Some(JsonValue::Null) | None => None,
            Some(client) => Some(client),
        },
    }
}

fn parse_stored(text: &Value) -> Value {
    match parse_stored_oauth(text.as_str().unwrap_or("")) {
        Some(stored) => stored_json(&stored),
        None => Value::Null,
    }
}

fn status_failure(reason: &Value) -> Value {
    let error = reason
        .as_str()
        .and_then(RemoteMcpErrorReason::from_name)
        .map(|reason| RemoteMcpError {
            server_name: "web".to_owned(),
            reason,
        });
    status_failure_of(error.as_ref()).map_or(Value::Null, |f| Value::String(f.as_str().to_owned()))
}

fn remote_error(name: &Value, reason: Option<&Value>) -> Value {
    let reason = reason
        .and_then(Value::as_str)
        .and_then(RemoteMcpErrorReason::from_name)
        .unwrap_or(RemoteMcpErrorReason::Unreachable);
    let error = RemoteMcpError {
        server_name: name.as_str().unwrap_or("").to_owned(),
        reason,
    };
    json!({
        "name": "RemoteMcpError",
        "message": error.message(),
        "reason": reason.as_str(),
        "serverName": error.server_name,
    })
}

// ---- the world ----

#[derive(Default)]
struct Out {
    net: Vec<Value>,
    timers: Vec<Value>,
    store: Vec<Value>,
    server: Vec<Value>,
    events: Vec<Value>,
}

struct World {
    out: Out,
    /// shared so the closure that opens the browser can write to it
    browser: Rc<RefCell<Vec<Value>>>,
    specs: VecDeque<Value>,
    next_stream: u64,
    /// stream number to `closed`
    streams: HashMap<u64, bool>,
    /// per timer: whether it is live
    timers: Vec<bool>,
    resolve: HashMap<String, Vec<String>>,
    clock: f64,
    random_state: u32,
    oauth: Option<McpOAuthConfig>,
    writes: usize,
    fail_write: Vec<usize>,
    listen_fails: bool,
    listened: u16,
    /// port and whether the server is closed
    servers: Vec<(u16, bool)>,
}

impl World {
    fn new(cfg: &Value) -> World {
        let resolve = match cfg.get("resolve") {
            Some(Value::Object(map)) => map
                .iter()
                .map(|(host, addresses)| {
                    let list = addresses
                        .as_array()
                        .map(|a| {
                            a.iter()
                                .filter_map(|x| x.as_str().map(str::to_owned))
                                .collect()
                        })
                        .unwrap_or_default();
                    (host.clone(), list)
                })
                .collect(),
            _ => HashMap::new(),
        };
        let oauth = cfg
            .get("oauth")
            .filter(|v| v.is_object())
            .map(|held| McpOAuthConfig {
                client_id: str_field(held, "clientId").unwrap_or("").to_owned(),
                client_secret: str_field(held, "clientSecret").unwrap_or("").to_owned(),
                tokens: str_field(held, "tokens").unwrap_or("").to_owned(),
            });
        World {
            out: Out::default(),
            browser: Rc::new(RefCell::new(Vec::new())),
            specs: cfg
                .get("fetches")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .into(),
            next_stream: 0,
            streams: HashMap::new(),
            timers: Vec::new(),
            resolve,
            clock: cfg
                .get("now")
                .and_then(Value::as_f64)
                .unwrap_or(1_000_000.0),
            random_state: cfg.get("seed").and_then(Value::as_u64).unwrap_or(1) as u32,
            oauth,
            writes: 0,
            fail_write: cfg
                .get("failWrite")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|n| n.as_u64().map(|n| n as usize))
                        .collect()
                })
                .unwrap_or_default(),
            listen_fails: bool_field(cfg, "listenFails"),
            listened: 0,
            servers: Vec::new(),
        }
    }

    fn take_step(&mut self) -> Value {
        let out = std::mem::take(&mut self.out);
        let browser = std::mem::take(&mut *self.browser.borrow_mut());
        json!({
            "net": out.net,
            "timers": out.timers,
            "store": out.store,
            "server": out.server,
            "browser": browser,
            "events": out.events,
        })
    }

    /// `step.n` of a step that fires a timer: whether it was live (and is not now)
    fn fire(&mut self, n: u64) -> bool {
        match self.timers.get_mut((n as usize).wrapping_sub(1)) {
            Some(live) if *live => {
                *live = false;
                true
            }
            _ => false,
        }
    }

    /// the port a `loopback` step goes to: the server `index`, else the last
    fn request_port(&self, step: &Value) -> Option<u16> {
        let server = match step.get("server").and_then(Value::as_u64) {
            Some(index) => self.servers.get(index as usize),
            None => self.servers.last(),
        };
        let force = bool_field(step, "force");
        server
            .filter(|(_, closed)| force || !closed)
            .map(|(port, _)| *port)
    }
}

fn headers_json(headers: Option<&Headers>) -> Value {
    let mut out = Map::new();
    if let Some(headers) = headers {
        for (name, value) in headers.entries() {
            out.insert(name, Value::String(value));
        }
    }
    Value::Object(out)
}

impl World {
    fn scripted_fetch(
        &mut self,
        url: &str,
        init: &FetchInit,
        limit_ms: Option<f64>,
    ) -> Result<FetchResponse, FetchError> {
        let redirect = match init.redirect {
            Some(Redirect::Follow) => json!("follow"),
            Some(Redirect::Manual) => json!("manual"),
            Some(Redirect::Error) => json!("error"),
            None => Value::Null,
        };
        // only the 20 s of a sign-in request is a limit the TypeScript's fetch sees
        let logged_limit = match limit_ms {
            Some(ms) if ms == 20_000.0 => json!(ms),
            _ => Value::Null,
        };
        self.out.net.push(json!([
            "fetch",
            url,
            init.method.clone().unwrap_or_else(|| "GET".to_owned()),
            headers_json(init.headers.as_ref()),
            init.body.clone().map_or(Value::Null, Value::String),
            redirect,
            logged_limit,
        ]));
        let Some(spec) = self.specs.pop_front() else {
            return Err(FetchError::type_error("no scripted response"));
        };
        if bool_field(&spec, "limit") {
            return Err(if limit_ms == Some(20_000.0) {
                FetchError::other("TimeoutError", "The operation was aborted due to timeout")
            } else {
                FetchError::other("AbortError", "This operation was aborted")
            });
        }
        if let Some(reject) = spec.get("reject") {
            let message = str_field(reject, "message").unwrap_or("");
            let mut error = if bool_field(reject, "typeError") {
                FetchError::type_error(message)
            } else {
                FetchError::other(str_field(reject, "name").unwrap_or("Error"), message)
            };
            if let Some(cause) = reject.get("cause") {
                error.cause = Some(Box::new(FetchError::other(
                    str_field(cause, "name").unwrap_or("Error"),
                    str_field(cause, "message").unwrap_or(""),
                )));
            }
            return Err(error);
        }
        let status = spec.get("status").and_then(Value::as_u64).unwrap_or(200) as u16;
        let null_body = matches!(status, 204 | 205 | 304);
        let body = if bool_field(&spec, "stream") {
            self.next_stream += 1;
            self.streams.insert(self.next_stream, false);
            Body::Stream(self.next_stream)
        } else if null_body {
            Body::None
        } else if let Some(hex) = str_field(&spec, "hex") {
            Body::Bytes(hex_bytes(hex))
        } else if let Some(text) = str_field(&spec, "body") {
            Body::Bytes(text.as_bytes().to_vec())
        } else {
            Body::None
        };
        let mut headers = Headers::new();
        if let Some(Value::Object(map)) = spec.get("headers") {
            for (key, value) in map {
                headers.append(key, value.as_str().unwrap_or(""));
            }
        }
        let opaque = bool_field(&spec, "opaque");
        Ok(FetchResponse {
            status: if opaque { 0 } else { status },
            status_text: str_field(&spec, "statusText").unwrap_or("").to_owned(),
            headers,
            url: str_field(&spec, "url").unwrap_or("").to_owned(),
            redirected: bool_field(&spec, "redirected"),
            opaque_redirect: opaque,
            body,
        })
    }
}

impl FetchHost for World {
    fn fetch(&mut self, url: &str, init: &FetchInit) -> Result<FetchResponse, FetchError> {
        self.scripted_fetch(url, init, None)
    }

    fn cancel_body(&mut self, stream: u64) {
        if let Some(closed) = self.streams.get_mut(&stream) {
            *closed = true;
        }
        self.out.net.push(json!(["cancel", stream]));
    }

    fn abort_body(&mut self, stream: u64) {
        if let Some(closed) = self.streams.get_mut(&stream) {
            if *closed {
                return;
            }
            *closed = true;
        }
        self.out.net.push(json!(["abort", stream]));
    }
}

impl AuthHost for World {
    fn random_bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len)
            .map(|_| {
                self.random_state = (self.random_state * 73 + 41) % 256;
                self.random_state as u8
            })
            .collect()
    }
}

impl NetHost for World {
    fn fetch_limited(
        &mut self,
        url: &str,
        init: &FetchInit,
        limit_ms: Option<f64>,
    ) -> Result<FetchResponse, FetchError> {
        self.scripted_fetch(url, init, limit_ms)
    }

    fn resolve_host(&mut self, host: &str) -> Result<Vec<String>, ResolveFailed> {
        self.out.net.push(json!(["resolve", host]));
        self.resolve
            .get(host)
            .cloned()
            .ok_or_else(|| ResolveFailed(format!("getaddrinfo ENOTFOUND {host}")))
    }

    fn now(&mut self) -> f64 {
        self.clock
    }
}

impl RefreshNet for World {
    fn now(&mut self) -> f64 {
        self.clock
    }
}

impl LoopbackHost for World {
    fn listen(&mut self) -> Result<u16, String> {
        self.out.server.push(json!(["listen", 0, "127.0.0.1"]));
        if self.listen_fails {
            return Err("listen failed".to_owned());
        }
        self.listened += 1;
        let port = 40_000 + self.listened;
        self.servers.push((port, false));
        Ok(port)
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        self.timers.push(true);
        let n = self.timers.len() as u64;
        self.out.timers.push(json!(["setTimeout", n, ms]));
        n
    }

    fn clear_timeout(&mut self, timer: u64) {
        if let Some(live) = self.timers.get_mut((timer as usize).wrapping_sub(1)) {
            *live = false;
        }
        self.out.timers.push(json!(["clearTimeout", timer]));
    }

    fn respond(&mut self, port: u16, response: &LoopbackResponse) {
        let headers: Vec<Value> = response
            .headers
            .iter()
            .map(|(name, value)| json!([name, value]))
            .collect();
        self.out.server.push(json!([
            "respond",
            port,
            response.status,
            headers,
            response.body.clone().map_or(Value::Null, Value::String),
        ]));
    }

    fn close_server(&mut self, port: u16) {
        self.out.server.push(json!(["close", port]));
        for server in &mut self.servers {
            if server.0 == port {
                server.1 = true;
            }
        }
    }

    fn close_idle_connections(&mut self, port: u16) {
        self.out.server.push(json!(["closeIdle", port]));
    }

    fn close_all_connections(&mut self, port: u16) {
        self.out.server.push(json!(["closeAll", port]));
    }
}

impl SignInHost for World {}

impl McpOAuthAccess for World {
    fn read(&mut self) -> Option<McpOAuthConfig> {
        self.oauth.clone()
    }

    fn write_tokens(&mut self, tokens: &str) -> Result<(), String> {
        let index = self.writes;
        self.writes += 1;
        self.out.store.push(json!(["writeTokens", tokens]));
        if self.fail_write.contains(&index) {
            return Err("disk full".to_owned());
        }
        let held = self.oauth.get_or_insert_with(|| McpOAuthConfig {
            client_id: String::new(),
            client_secret: String::new(),
            tokens: String::new(),
        });
        held.tokens = tokens.to_owned();
        Ok(())
    }
}

impl RemoteHost for World {
    fn compile_output_schema(&mut self, _schema: &JsonValue) -> Result<u64, String> {
        Err("no validator".to_owned())
    }

    fn validate_output(&mut self, _validator: u64, _structured_content: &JsonValue) -> OutputCheck {
        OutputCheck::Valid
    }
}

fn pages() -> LoopbackPages {
    LoopbackPages {
        done: SignInPage {
            lang: "en".to_owned(),
            title: "Signed in".to_owned(),
            body: "You can close this tab & return.".to_owned(),
        },
        failed: SignInPage {
            lang: "en".to_owned(),
            title: "Not signed in".to_owned(),
            body: "Try <again>.".to_owned(),
        },
    }
}

fn config_of(value: Option<&Value>) -> Option<McpOAuthConfig> {
    let held = value.filter(|v| v.is_object())?;
    Some(McpOAuthConfig {
        client_id: str_field(held, "clientId").unwrap_or("").to_owned(),
        client_secret: str_field(held, "clientSecret").unwrap_or("").to_owned(),
        tokens: str_field(held, "tokens").unwrap_or("").to_owned(),
    })
}

fn init_of(cfg: Option<&Value>) -> FetchInit {
    let mut init = FetchInit::default();
    let Some(cfg) = cfg else {
        return init;
    };
    init.method = str_field(cfg, "method").map(str::to_owned);
    if let Some(Value::Object(map)) = cfg.get("headers") {
        let mut headers = Headers::new();
        for (key, value) in map {
            headers.append(key, value.as_str().unwrap_or(""));
        }
        init.headers = Some(headers);
    }
    init.body = str_field(cfg, "body").map(str::to_owned);
    init
}

// ---- oauth-loopback ----

fn outcome_json(outcome: &LoopbackOutcome) -> Value {
    match outcome {
        LoopbackOutcome::Code(code) => json!({ "ok": true, "code": code }),
        LoopbackOutcome::Failed(reason) => json!({ "ok": false, "reason": reason.as_str() }),
    }
}

fn run_loopback(cfg: &Value) -> Value {
    let mut world = World::new(cfg);
    let state = str_field(cfg, "state").unwrap_or("").to_owned();
    let timeout_ms = cfg.get("timeoutMs").and_then(Value::as_f64).unwrap_or(0.0);
    let mut aborted = bool_field(cfg, "aborted");
    let mut receivers: Vec<LoopbackReceiver> = Vec::new();
    let mut reported: Vec<bool> = Vec::new();
    let mut out: Vec<Value> = Vec::new();
    for step in steps_of(cfg) {
        match str_field(&step, "op").unwrap_or("") {
            "timer" => {
                let n = step.get("n").and_then(Value::as_u64).unwrap_or(1);
                if world.fire(n) {
                    for receiver in &mut receivers {
                        receiver.on_timeout(&mut world, n);
                    }
                }
            }
            "now" => world.clock = step.get("ms").and_then(Value::as_f64).unwrap_or(0.0),
            "loopback" => {
                if let Some(port) = world.request_port(&step) {
                    let method = str_field(&step, "method").unwrap_or("GET");
                    let target = str_field(&step, "target").unwrap_or("");
                    if let Some(receiver) = receivers.iter_mut().find(|r| r.port() == port) {
                        receiver.on_request(&mut world, method, target);
                    }
                }
            }
            "start" => {
                match LoopbackReceiver::start(&mut world, &state, &pages(), timeout_ms, aborted) {
                    Ok(receiver) => {
                        world
                            .out
                            .events
                            .push(json!(["started", receiver.redirect_uri()]));
                        receivers.push(receiver);
                        reported.push(false);
                    }
                    Err(message) => world.out.events.push(json!(["startError", message])),
                }
            }
            "abort" => {
                aborted = true;
                for receiver in &mut receivers {
                    receiver.on_abort(&mut world);
                }
            }
            "close" => {
                if let Some(receiver) = receivers.last_mut() {
                    receiver.close(&mut world);
                }
            }
            other => {
                out.push(json!({ "error": format!("no such step: {other}") }));
                continue;
            }
        }
        for (receiver, done) in receivers.iter().zip(reported.iter_mut()) {
            if !*done && let Some(outcome) = receiver.outcome() {
                *done = true;
                world
                    .out
                    .events
                    .push(json!(["outcome", outcome_json(outcome)]));
            }
        }
        out.push(world.take_step());
    }
    Value::Array(out)
}

// ---- oauth ----

fn run_auth_fetch(cfg: &Value) -> Value {
    let mut world = World::new(cfg);
    let mut out: Vec<Value> = Vec::new();
    for step in steps_of(cfg) {
        let url = str_field(&step, "url").unwrap_or("");
        let init = init_of(step.get("init"));
        let result = AuthFetch::new(&mut world).fetch(url, &init);
        match result {
            Ok(response) => world.out.events.push(json!(["response", response.status])),
            Err(error) => world
                .out
                .events
                .push(json!(["error", error.name, error.message])),
        }
        out.push(world.take_step());
    }
    Value::Array(out)
}

fn run_refresh(cfg: &Value) -> Value {
    let mut world = World::new(cfg);
    let stored = stored_of(cfg.get("stored").unwrap_or(&Value::Null));
    let config = config_of(cfg.get("config"));
    let result = match refresh_stored_oauth(&stored, config.as_ref(), &mut world) {
        RefreshOutcome::Refreshed(next) => json!({ "ok": true, "stored": stored_json(&next) }),
        RefreshOutcome::Refused => json!({ "ok": false, "reason": "refused" }),
        RefreshOutcome::Network => json!({ "ok": false, "reason": "network" }),
    };
    json!({ "result": result, "out": world.take_step() })
}

fn run_revoke(cfg: &Value) -> Value {
    let mut world = World::new(cfg);
    let stored = stored_of(cfg.get("stored").unwrap_or(&Value::Null));
    let config = config_of(cfg.get("config"));
    let result = revoke_stored_oauth(&stored, config.as_ref(), &mut world);
    json!({ "result": result, "out": world.take_step() })
}

fn sign_in_json(result: &SignInResult) -> Value {
    match result {
        SignInResult::Signed(stored) => json!({ "ok": true, "stored": stored_json(stored) }),
        SignInResult::Failed(reason) => json!({ "ok": false, "reason": reason.as_str() }),
        SignInResult::Threw(message) => json!({ "threw": message }),
    }
}

fn run_sign_in(cfg: &Value) -> Value {
    let mut world = World::new(cfg);
    let open_fails = bool_field(cfg, "openFails");
    let browser = Rc::clone(&world.browser);
    let open = move |url: &str| {
        browser.borrow_mut().push(json!(["open", url]));
        !open_fails
    };
    let mut aborted = bool_field(cfg, "aborted");
    let mut sign: Option<SignIn> = None;
    let mut reported = false;
    let mut out: Vec<Value> = Vec::new();
    for step in steps_of(cfg) {
        match str_field(&step, "op").unwrap_or("") {
            "timer" => {
                let n = step.get("n").and_then(Value::as_u64).unwrap_or(1);
                if world.fire(n)
                    && let Some(sign) = sign.as_mut()
                {
                    sign.on_timeout(&mut world, n);
                }
            }
            "now" => world.clock = step.get("ms").and_then(Value::as_f64).unwrap_or(0.0),
            "loopback" => {
                if let Some(port) = world.request_port(&step)
                    && let Some(sign) = sign.as_mut()
                {
                    let method = str_field(&step, "method").unwrap_or("GET");
                    let target = str_field(&step, "target").unwrap_or("");
                    sign.on_request(&mut world, port, method, target);
                }
            }
            "start" => {
                let context = SignInContext {
                    open_external: &open,
                    server_url: str_field(cfg, "serverUrl")
                        .unwrap_or("https://mcp.example/mcp")
                        .to_owned(),
                    resource_metadata_url: str_field(cfg, "resourceMetadataUrl")
                        .and_then(|u| url::Url::parse(u).ok())
                        .map(|u| u.as_str().to_owned()),
                    scope: str_field(cfg, "scope").map(str::to_owned),
                    config: config_of(cfg.get("config")),
                    client_name: str_field(cfg, "clientName")
                        .unwrap_or("SeuOffice")
                        .to_owned(),
                    pages: pages(),
                    timeout_ms: cfg.get("timeoutMs").and_then(Value::as_f64),
                    aborted,
                };
                sign = Some(SignIn::start(&mut world, context));
            }
            "abort" => {
                aborted = true;
                if let Some(sign) = sign.as_mut() {
                    sign.on_abort(&mut world);
                }
            }
            other => {
                out.push(json!({ "error": format!("no such step: {other}") }));
                continue;
            }
        }
        if !reported
            && let Some(sign) = sign.as_mut()
            && let Some(result) = sign.take_result()
        {
            reported = true;
            world
                .out
                .events
                .push(json!(["signIn", sign_in_json(&result)]));
        }
        out.push(world.take_step());
    }
    Value::Array(out)
}

// ---- storeOAuthAccess ----

struct NoSeal;

impl McpSecretCodec for NoSeal {
    fn can_seal(&self) -> bool {
        false
    }

    fn seal(&self, _plain: &str) -> Result<String, CodecThrow> {
        Err(CodecThrow("cannot seal".to_owned()))
    }

    fn open(&self, _sealed: &str) -> Result<Option<String>, CodecThrow> {
        Ok(None)
    }
}

fn run_store_access(args: &[Value]) -> Answer {
    let file = args
        .first()
        .and_then(Value::as_str)
        .ok_or_else(|| CallError::plain("argument 0 is not a string"))?;
    let mut mcp = create_mcp_servers_store(file, Rc::new(NoSeal));
    let steps = args
        .get(1)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<Value> = Vec::new();
    for step in steps {
        let id = str_field(&step, "id").unwrap_or("");
        match str_field(&step, "op").unwrap_or("") {
            "load" => {
                mcp.load();
                out.push(json!("loaded"));
            }
            "read" => {
                let held = store_oauth_access(&mut mcp, id).read();
                out.push(held.map_or(Value::Null, |c| sv(&c.to_json())));
            }
            "write" => {
                let tokens = str_field(&step, "tokens").unwrap_or("");
                store_oauth_access(&mut mcp, id)
                    .write_tokens(tokens)
                    .map_err(CallError::plain)?;
                out.push(json!("written"));
            }
            "file" => out.push(match std::fs::read(file) {
                Ok(bytes) => Value::String(String::from_utf8_lossy(&bytes).into_owned()),
                Err(_) => Value::Null,
            }),
            other => return Err(CallError::plain(format!("no such step: {other}"))),
        }
    }
    ok(Value::Array(out))
}

// ---- remote ----

fn listing_json(listing: &McpListing) -> Value {
    let tools: Vec<Value> = listing
        .tools
        .iter()
        .map(|tool| {
            let mut entry = Map::new();
            entry.insert("name".into(), Value::String(tool.name.clone()));
            if let Some(schema) = &tool.input_schema {
                entry.insert("inputSchema".into(), sv(schema));
            }
            if let Some(description) = &tool.description {
                entry.insert("description".into(), Value::String(description.clone()));
            }
            if let Some(annotations) = &tool.annotations {
                entry.insert("annotations".into(), sv(annotations));
            }
            Value::Object(entry)
        })
        .collect();
    json!({
        "tools": tools,
        "instructions": listing.instructions.clone().map_or(Value::Null, Value::String),
    })
}

/// the event a settled operation shows
fn settle_event(id: &str, outcome: Result<RemoteResult, RemoteError>) -> Value {
    match outcome {
        Ok(result) => {
            let value = match result {
                RemoteResult::Connected | RemoteResult::Revoked | RemoteResult::Closed => {
                    Value::Null
                }
                RemoteResult::Listing(listing) => listing_json(&listing),
                RemoteResult::Called(value) => sv(&value),
                RemoteResult::SignedIn(McpSignInResult::Ok) => json!({ "ok": true }),
                RemoteResult::SignedIn(McpSignInResult::Failed(reason)) => {
                    json!({ "ok": false, "reason": reason.as_str() })
                }
            };
            json!(["settle", id, "ok", value])
        }
        Err(RemoteError::Remote(error)) => json!([
            "settle",
            id,
            "error",
            { "remote": error.reason.as_str(), "message": error.message() }
        ]),
        Err(RemoteError::Failed(message)) => {
            json!(["settle", id, "error", { "failed": message }])
        }
    }
}

fn run_remote(cfg: &Value) -> Answer {
    let mut world = World::new(cfg);
    let server = cfg.get("server").unwrap_or(&Value::Null);
    let mut headers = jscompat::JsObject::new();
    if let Some(Value::Object(map)) = server.get("headers") {
        for (key, value) in map {
            headers.set(key.clone(), value.as_str().unwrap_or("").to_owned());
        }
    }
    let client_info = cfg.get("clientInfo");
    let options = RemoteMcpConnectionOptions {
        server: RemoteServerSettings {
            name: str_field(server, "name").unwrap_or("").to_owned(),
            url: str_field(server, "url").unwrap_or("").to_owned(),
            transport: if str_field(server, "transport") == Some("sse") {
                McpTransport::Sse
            } else {
                McpTransport::Auto
            },
            headers,
        },
        client_name: client_info
            .and_then(|c| str_field(c, "name"))
            .map(str::to_owned),
        client_version: client_info
            .and_then(|c| str_field(c, "version"))
            .unwrap_or("1.0.0")
            .to_owned(),
        call_timeout_ms: cfg.get("callTimeoutMs").and_then(Value::as_f64),
    };
    let mut conn = RemoteConnection::new(options).map_err(|message| CallError {
        code: Some("ERR_INVALID_URL".to_owned()),
        message,
    })?;
    // operation numbers and signal numbers are the position of their names
    let mut ops: Vec<String> = Vec::new();
    let mut signals: Vec<(String, bool)> = Vec::new();
    let mut listeners: Vec<String> = Vec::new();
    let mut latest: HashMap<String, u64> = HashMap::new();
    let browser = Rc::clone(&world.browser);
    let open_fails = Cell::new(false);
    let open = |url: &str| {
        browser.borrow_mut().push(json!(["open", url]));
        !open_fails.get()
    };
    let mut out: Vec<Value> = Vec::new();
    let new_op = |ops: &mut Vec<String>, step: &Value| -> u64 {
        let op = str_field(step, "op").unwrap_or("");
        ops.push(str_field(step, "id").unwrap_or(op).to_owned());
        (ops.len() - 1) as u64
    };
    let signal_of = |signals: &mut Vec<(String, bool)>, step: &Value| -> Option<SignalRef> {
        let name = str_field(step, "signal")?;
        let index = match signals.iter().position(|(n, _)| n == name) {
            Some(index) => index,
            None => {
                signals.push((
                    name.to_owned(),
                    step.get("aborted") == Some(&Value::Bool(true)),
                ));
                signals.len() - 1
            }
        };
        Some(SignalRef {
            id: index as u64,
            aborted: signals[index].1.then(AbortReason::default_abort),
        })
    };
    for step in steps_of(cfg) {
        match str_field(&step, "op").unwrap_or("") {
            "timer" => {
                let n = step.get("n").and_then(Value::as_u64).unwrap_or(1);
                if world.fire(n) {
                    conn.on_timeout(&mut world, n);
                }
            }
            "now" => world.clock = step.get("ms").and_then(Value::as_f64).unwrap_or(0.0),
            "loopback" => {
                if let Some(port) = world.request_port(&step) {
                    let method = str_field(&step, "method").unwrap_or("GET");
                    let target = str_field(&step, "target").unwrap_or("");
                    conn.on_loopback_request(&mut world, port, method, target);
                }
            }
            "connect" => {
                let op = new_op(&mut ops, &step);
                let signal = signal_of(&mut signals, &step);
                conn.connect(&mut world, op, signal);
            }
            "list" => {
                let op = new_op(&mut ops, &step);
                let signal = signal_of(&mut signals, &step);
                conn.list_tools(&mut world, op, signal);
            }
            "call" => {
                let op = new_op(&mut ops, &step);
                let signal = signal_of(&mut signals, &step);
                let name = str_field(&step, "name").unwrap_or("");
                let args = step.get("args").map(jv).unwrap_or_else(|| jv(&json!({})));
                conn.call_tool(&mut world, op, name, args, signal);
            }
            "signIn" => {
                open_fails.set(bool_field(&step, "openFails"));
                let op = new_op(&mut ops, &step);
                let signal = signal_of(&mut signals, &step);
                let options = McpSignInOptions {
                    open_external: &open,
                    pages: pages(),
                    timeout_ms: step.get("timeoutMs").and_then(Value::as_f64),
                };
                conn.sign_in(&mut world, op, options, signal);
            }
            "revoke" => {
                let op = new_op(&mut ops, &step);
                conn.revoke(&mut world, op);
            }
            "close" => {
                let op = new_op(&mut ops, &step);
                conn.close(&mut world, op);
            }
            "needs" => world
                .out
                .events
                .push(json!(["needsSignIn", conn.needs_sign_in()])),
            "subscribe" => {
                let name = str_field(&step, "name").unwrap_or("").to_owned();
                let id = listeners.len() as u64;
                listeners.push(name.clone());
                latest.insert(name, id);
                conn.on_tools_changed(id);
            }
            "unsubscribe" => {
                let name = str_field(&step, "name").unwrap_or("");
                if let Some(id) = latest.get(name) {
                    conn.off_tools_changed(*id);
                }
            }
            "abort" => {
                let name = str_field(&step, "signal").unwrap_or("");
                if let Some(index) = signals.iter().position(|(n, _)| n == name)
                    && !signals[index].1
                {
                    signals[index].1 = true;
                    conn.on_abort(&mut world, index as u64, AbortReason::default_abort());
                }
            }
            "resolve" => {
                world.resolve = match step.get("table") {
                    Some(Value::Object(map)) => map
                        .iter()
                        .map(|(host, addresses)| {
                            let list = addresses
                                .as_array()
                                .map(|a| {
                                    a.iter()
                                        .filter_map(|x| x.as_str().map(str::to_owned))
                                        .collect()
                                })
                                .unwrap_or_default();
                            (host.clone(), list)
                        })
                        .collect(),
                    _ => HashMap::new(),
                };
            }
            "chunk" => {
                let stream = step.get("stream").and_then(Value::as_u64).unwrap_or(1);
                if world.streams.get(&stream) == Some(&false) {
                    let bytes = str_field(&step, "text").unwrap_or("").as_bytes().to_vec();
                    conn.on_stream_chunk(&mut world, stream, &bytes);
                }
            }
            "end" => {
                let stream = step.get("stream").and_then(Value::as_u64).unwrap_or(1);
                if world.streams.get(&stream) == Some(&false) {
                    world.streams.insert(stream, true);
                    conn.on_stream_end(&mut world, stream);
                }
            }
            "streamError" => {
                let stream = step.get("stream").and_then(Value::as_u64).unwrap_or(1);
                if world.streams.get(&stream) == Some(&false) {
                    world.streams.insert(stream, true);
                    let error = FetchError::other(
                        str_field(&step, "name").unwrap_or("Error"),
                        str_field(&step, "text").unwrap_or(""),
                    );
                    conn.on_stream_error(&mut world, stream, &error);
                }
            }
            other => return Err(CallError::plain(format!("no such step: {other}"))),
        }
        for listener in conn.take_tools_changed() {
            let name = listeners
                .get(listener as usize)
                .cloned()
                .unwrap_or_default();
            world.out.events.push(json!(["toolsChanged", name]));
        }
        for (op, outcome) in conn.take_finished() {
            let id = ops.get(op as usize).cloned().unwrap_or_default();
            world.out.events.push(settle_event(&id, outcome));
        }
        out.push(world.take_step());
    }
    ok(Value::Array(out))
}
