//! `apps/shell/src/main/mcp-client/remote.ts`: one remote MCP server as the
//! shell's main process reaches it (user MCP spec 5.2, 5.5, 5.6, 5.7, 4.8).
//! Streamable HTTP first and legacy SSE once when the server does not speak
//! it; every request goes to the registered origin only and a redirect
//! elsewhere ends the request. The client declares no capabilities, so the
//! server's sampling, elicitation and roots requests are answered "method not
//! found".
//!
//! Plain http is checked against the addresses the name resolves to when
//! connecting and again before every request. The request itself still
//! resolves the name on its own (the host's `fetch` takes no resolver), so a
//! name that changes its answer in the moment between the check and the
//! request is not caught.
//!
//! Error texts carry the server name and a reason word, never an address,
//! header, token or server message.
//!
//! # Driving a connection
//!
//! [`RemoteConnection`] is `createRemoteMcpConnection(options)`'s closure.
//! Everything the TypeScript awaits is an operation: the caller names it with
//! a number of its choosing (`op`), starts it with the method of the same
//! name as the TypeScript's, and the connection answers it, exactly once:
//! [`RemoteConnection::take_finished`] lists the answers (possibly one that
//! came before the method returned) after every call the caller drove.
//!
//! * `connect`, `list_tools`, `call_tool`, `sign_in`, `revoke` and `close`
//!   start operations. `needs_sign_in`, `on_tools_changed` and
//!   `off_tools_changed` answer at once. The `AbortSignal` of
//!   `connect(signal)`, `listTools(signal)`, `callTool(..., signal)` and
//!   `signIn({ signal })` is a [`SignalRef`]: a number of the caller's
//!   choosing, and whether it is aborted already. The same number is the
//!   same signal. Its later abort is [`RemoteConnection::on_abort`]; when the
//!   caller drops the signal it calls [`RemoteConnection::release_signal`]
//!   (the SDK never removes its abort listeners, so an abort after an
//!   operation settled still sends `notifications/cancelled`).
//! * A request the connection makes is [`FetchHost::fetch`] on the host (a
//!   plain call that answers once the headers are in); the body of an SSE
//!   answer is a [`Body::Stream`] the caller feeds back with
//!   [`RemoteConnection::on_stream_chunk`], `on_stream_end` and
//!   `on_stream_error`. A timer [`LoopbackHost::set_timeout`] started firing
//!   is [`RemoteConnection::on_timeout`]; a request of the loopback server of
//!   a sign-in is [`RemoteConnection::on_loopback_request`] (by port).
//! * Concurrent requests of one connection run one after the other, because
//!   a host call blocks: the TypeScript's single shared token refresh
//!   (`refreshing`) needs no state here, since a second request reads the
//!   token the first one stored.
//! * The 5 s that `close` and `signIn` give the end of a server-side session
//!   is the host's limit on the DELETE request ([`NetHost::fetch_limited`]
//!   with [`TERMINATE_TIMEOUT_MS`]) together with the timer the TypeScript
//!   starts for it (never cleared, so its firing does nothing).
//!
//! What stays engine-waiting: the validator of a tool's `outputSchema` (Ajv
//! in the TypeScript) is [`RemoteHost::compile_output_schema`] and
//! [`RemoteHost::validate_output`].

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use jscompat::{JsObject, JsonValue};
use url::Url;

use super::address::AddressCheck;
use super::hub::{
    ConnError, ConnOutcome, RemoteConnection as HubRemoteConnection, RemoteReason, SignInOptions,
    SignInResult as HubSignInResult,
};
use super::limits::MCP_CALL_TIMEOUT_MS;
use super::listing::{ListedTool, McpListing};
use super::oauth::{
    AuthFetch, McpOAuthAccess, McpSignInFailure, McpSignInOptions, McpSignInResult, NetHost,
    RefreshOutcome, SignIn, SignInContext, SignInHost, SignInResult, StoredOAuth,
    access_token_expired, check_address, is_unresolved, parse_stored_oauth, refresh_stored_oauth,
    revoke_stored_oauth, serialize_stored_oauth,
};
use super::oauth_loopback::{LoopbackHost, LoopbackPages};
use crate::packages::ai_provider::jsval::{as_str, object, prop, text};
use crate::packages::google_drive::oauth::SignInPage;
use crate::packages::i18n::PRODUCT_NAME;
use crate::packages::mcp_sdk::auth::extract_www_authenticate_params;
use crate::packages::mcp_sdk::client::net::{
    self, Body, FetchError, FetchHost, FetchInit, FetchResponse, Headers, Redirect,
};
use crate::packages::mcp_sdk::client::{
    AbortReason, Client, ClientError, ClientHost, OpId, OutputCheck, RequestOptions, Settled,
    Signal, Transport,
};
use crate::packages::mcp_sdk::sse_client::SseTransport;
use crate::packages::mcp_sdk::streamable_http_client::StreamableHttpTransport;
use crate::packages::mcp_sdk::types::error_code;
use crate::shell::mcp_servers_api::{McpFailReason, McpTransport};

/// `TERMINATE_TIMEOUT_MS`: ending the server-side session on close is
/// courtesy; it may not hold up closing
pub const TERMINATE_TIMEOUT_MS: f64 = 5_000.0;

/// `RemoteMcpErrorReason`: unreachable: no answer, or an answer that is not
/// MCP; timeout: the time limit passed; aborted: the person stopped it;
/// refused-redirect: the server sent the request to another origin;
/// insecure-address: plain http to an address outside this PC and the private
/// ranges; login-required: the server wants a sign-in (or a new key);
/// server-error: the server answered the request with an MCP error;
/// http-error: the server answered, but with an HTTP error status and no MCP
/// (often a wrong address).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteMcpErrorReason {
    Unreachable,
    HttpError,
    Timeout,
    Aborted,
    RefusedRedirect,
    InsecureAddress,
    LoginRequired,
    ServerError,
}

impl RemoteMcpErrorReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoteMcpErrorReason::Unreachable => "unreachable",
            RemoteMcpErrorReason::HttpError => "http-error",
            RemoteMcpErrorReason::Timeout => "timeout",
            RemoteMcpErrorReason::Aborted => "aborted",
            RemoteMcpErrorReason::RefusedRedirect => "refused-redirect",
            RemoteMcpErrorReason::InsecureAddress => "insecure-address",
            RemoteMcpErrorReason::LoginRequired => "login-required",
            RemoteMcpErrorReason::ServerError => "server-error",
        }
    }

    pub fn from_name(name: &str) -> Option<RemoteMcpErrorReason> {
        [
            RemoteMcpErrorReason::Unreachable,
            RemoteMcpErrorReason::HttpError,
            RemoteMcpErrorReason::Timeout,
            RemoteMcpErrorReason::Aborted,
            RemoteMcpErrorReason::RefusedRedirect,
            RemoteMcpErrorReason::InsecureAddress,
            RemoteMcpErrorReason::LoginRequired,
            RemoteMcpErrorReason::ServerError,
        ]
        .into_iter()
        .find(|reason| reason.as_str() == name)
    }
}

/// `RemoteMcpError`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteMcpError {
    pub server_name: String,
    pub reason: RemoteMcpErrorReason,
}

impl RemoteMcpError {
    /// `error.message`: `<server name>: <reason>`
    pub fn message(&self) -> String {
        format!("{}: {}", self.server_name, self.reason.as_str())
    }
}

/// What a server card shows after a failure: a fail reason or `login-required`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatusFailure {
    Fail(McpFailReason),
    LoginRequired,
}

impl StatusFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            StatusFailure::Fail(reason) => reason.as_str(),
            StatusFailure::LoginRequired => "login-required",
        }
    }
}

/// `statusFailureOf(error)`: what a server card shows after a failure, or
/// `None` when nothing is wrong with the server (the person stopped a call).
/// `error` is `None` for an error that is not a `RemoteMcpError`.
pub fn status_failure_of(error: Option<&RemoteMcpError>) -> Option<StatusFailure> {
    let Some(error) = error else {
        return Some(StatusFailure::Fail(McpFailReason::Unreachable));
    };
    match error.reason {
        RemoteMcpErrorReason::Aborted => None,
        RemoteMcpErrorReason::LoginRequired => Some(StatusFailure::LoginRequired),
        RemoteMcpErrorReason::RefusedRedirect => {
            Some(StatusFailure::Fail(McpFailReason::RefusedRedirect))
        }
        RemoteMcpErrorReason::InsecureAddress => {
            Some(StatusFailure::Fail(McpFailReason::InsecureAddress))
        }
        RemoteMcpErrorReason::HttpError => Some(StatusFailure::Fail(McpFailReason::HttpError)),
        _ => Some(StatusFailure::Fail(McpFailReason::Unreachable)),
    }
}

/// `RemoteServerSettings`: the registered server as the connection needs it
#[derive(Debug, Clone)]
pub struct RemoteServerSettings {
    pub name: String,
    pub url: String,
    pub transport: McpTransport,
    /// sent as given on every request; values are secrets
    pub headers: JsObject<String>,
}

/// `RemoteMcpConnectionOptions` without what the host supplies (`oauth`,
/// `fetch`, `resolve` and `now`)
#[derive(Debug, Clone)]
pub struct RemoteMcpConnectionOptions {
    pub server: RemoteServerSettings,
    /// `clientInfo.name`; the product name when `None`
    pub client_name: Option<String>,
    /// `clientInfo.version`: the app version
    pub client_version: String,
    /// `callTimeoutMs`
    pub call_timeout_ms: Option<f64>,
}

/// An `AbortSignal` of an operation: `id` names it, `aborted` is its reason
/// when it is aborted already
#[derive(Debug, Clone, PartialEq)]
pub struct SignalRef {
    pub id: u64,
    pub aborted: Option<AbortReason>,
}

/// What an operation answers
#[derive(Debug, Clone, PartialEq)]
pub enum RemoteResult {
    /// `connect`
    Connected,
    /// `listTools`
    Listing(McpListing),
    /// `callTool`: the server's result as it came
    Called(JsonValue),
    /// `signIn`
    SignedIn(McpSignInResult),
    /// `revoke`
    Revoked,
    /// `close`
    Closed,
}

/// What an operation rejects with
#[derive(Debug, Clone, PartialEq)]
pub enum RemoteError {
    Remote(RemoteMcpError),
    /// an error that is not a `RemoteMcpError` (the store's write failed, a
    /// sign-in threw): its text
    Failed(String),
}

pub type RemoteOutcome = Result<RemoteResult, RemoteError>;

/// What the connection does to the world besides requests and timers: the
/// network and the loopback server ([`SignInHost`]), the OAuth values
/// ([`McpOAuthAccess`]) and the validator of tool output.
pub trait RemoteHost: SignInHost + McpOAuthAccess {
    /// `ajv.compile(schema)` of a tool's `outputSchema`: the validator's
    /// number, or the message of the error compiling threw. Engine-waiting.
    fn compile_output_schema(&mut self, schema: &JsonValue) -> Result<u64, String>;
    /// `validator(structuredContent)`. Engine-waiting.
    fn validate_output(&mut self, validator: u64, structured_content: &JsonValue) -> OutputCheck;
}

/// `PROTOCOL_HEADERS`: headers the transport owns; a configured header of the same name is not sent
const PROTOCOL_HEADERS: [&str; 5] = [
    "content-type",
    "accept",
    "mcp-session-id",
    "mcp-protocol-version",
    "last-event-id",
];

const REDIRECT_STATUSES: [u16; 5] = [301, 302, 303, 307, 308];

/// the `name` of the [`FetchError`] a `RemoteMcpError` thrown by the fetch
/// becomes on its way through the SDK; its message is the reason
const REMOTE_ERROR: &str = "RemoteMcpError";

fn remote_failure(reason: RemoteMcpErrorReason) -> FetchError {
    FetchError::other(REMOTE_ERROR, reason.as_str())
}

/// `err instanceof RemoteMcpError`: its reason
fn remote_reason(error: &ClientError) -> Option<RemoteMcpErrorReason> {
    match error {
        ClientError::Fetch(fetch) if fetch.name == REMOTE_ERROR => {
            RemoteMcpErrorReason::from_name(&fetch.message)
        }
        _ => None,
    }
}

type ClientId = u64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Streamable,
    Sse,
}

/// one `Client` and what it was attached with
struct Slot {
    id: ClientId,
    client: Client,
    kind: Kind,
}

/// who an operation of a `Client` belongs to
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CopOwner {
    Connect,
    /// the caller's operation
    List(u64),
    Call(u64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimerOwner {
    Client(ClientId),
    /// the 5 s of `dropClient`'s race
    Race,
}

/// `challenge`: what the server's last 401 said about where to sign in
#[derive(Debug, Clone, Default)]
struct Challenge {
    resource_metadata_url: Option<String>,
    scope: Option<String>,
}

/// the `attach` in flight
struct Attempt {
    /// whether the `auto` transport may fall back to SSE if this one fails
    can_fall_back: bool,
}

/// `connecting`
struct Connecting {
    /// `mine`: the generation when the connection started
    mine: u64,
    attempt: Option<Attempt>,
}

enum Event {
    /// an operation of a `Client` settled
    Settled {
        client: ClientId,
        cop: u64,
        outcome: Result<Settled, ClientError>,
    },
    /// `open()` settled
    Opened(Result<ClientId, RemoteMcpError>),
}

/// everything the fetch the `Client`s use reads and writes
struct Shared {
    server_name: String,
    /// `server.url` as registered
    server_url: String,
    /// `serverUrl.href`
    href: String,
    /// `serverUrl.origin`
    origin: String,
    headers: JsObject<String>,
    key_configured: bool,
    transport: McpTransport,
    client_info: JsonValue,
    client_name: String,
    timeout: f64,
    active: Option<ClientId>,
    connecting: Option<Connecting>,
    /// bumped by close, so a connection finishing after it is dropped
    generation: u64,
    sign_in_needed: bool,
    challenge: Challenge,
    /// a failure the fetch saw while connecting
    seen_failure: Option<RemoteMcpErrorReason>,
    /// the server answered a request of this connection attempt with an HTTP error status (not 401)
    answered_error: bool,
    listeners: Vec<u64>,
    /// the listeners the server's tool-list-changed notifications called, not yet taken
    changed: Vec<u64>,
    next_client: u64,
    next_cop: u64,
    timers: Vec<(u64, TimerOwner)>,
    streams: Vec<(u64, ClientId)>,
    cops: Vec<(u64, CopOwner)>,
    queue: VecDeque<Event>,
    /// the limit the host gives requests while the session is being ended
    fetch_limit: Option<f64>,
}

impl Shared {
    fn fail(&self, reason: RemoteMcpErrorReason) -> RemoteMcpError {
        RemoteMcpError {
            server_name: self.server_name.clone(),
            reason,
        }
    }

    /// `record(reason)`: the failure is kept, and thrown
    fn record(&mut self, reason: RemoteMcpErrorReason) -> FetchError {
        self.seen_failure = Some(reason);
        remote_failure(reason)
    }
}

fn is_header_token(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
}

/// `headers.set(name, value)`, which throws a `TypeError` for a name or a
/// value that is not a header's
fn set_header(headers: &mut Headers, name: &str, value: &str) -> Result<(), FetchError> {
    let trimmed = value.trim_matches(|c| matches!(c, '\t' | '\n' | '\r' | ' '));
    let value_ok =
        value.encode_utf16().all(|unit| unit <= 0xFF) && !trimmed.contains(['\0', '\r', '\n']);
    if !is_header_token(name) || !value_ok {
        return Err(FetchError::type_error("Headers.set: invalid header"));
    }
    headers.set(name, value);
    Ok(())
}

fn cancel(host: &mut dyn RemoteHost, body: &Body) {
    if let Body::Stream(stream) = body {
        host.cancel_body(*stream);
    }
}

/// `send(bearer)` of `serverFetch`
fn send(
    host: &mut dyn RemoteHost,
    st: &mut Shared,
    url: &Url,
    init: &FetchInit,
    bearer: Option<&str>,
) -> Result<FetchResponse, FetchError> {
    let mut headers = init.headers.clone().unwrap_or_default();
    for (name, value) in st.headers.entries() {
        if !PROTOCOL_HEADERS.contains(&name.to_lowercase().as_str()) {
            set_header(&mut headers, name, value)?;
        }
    }
    if let Some(bearer) = bearer {
        set_header(&mut headers, "Authorization", &format!("Bearer {bearer}"))?;
    }
    let next = FetchInit {
        method: init.method.clone(),
        headers: Some(headers),
        body: init.body.clone(),
        redirect: Some(Redirect::Manual),
    };
    let response = match st.fetch_limit {
        Some(limit) => host.fetch_limited(url.as_str(), &next, Some(limit))?,
        None => host.fetch(url.as_str(), &next)?,
    };
    if response.status >= 400 && response.status != 401 {
        st.answered_error = true;
    }
    if response.opaque_redirect {
        return Err(st.record(RemoteMcpErrorReason::RefusedRedirect));
    }
    if REDIRECT_STATUSES.contains(&response.status) {
        let target = net::redirect_target(&response, url.as_str());
        let same = target
            .as_ref()
            .is_some_and(|t| t.origin().ascii_serialization() == st.origin);
        if !same {
            cancel(host, &response.body);
            return Err(st.record(RemoteMcpErrorReason::RefusedRedirect));
        }
    }
    Ok(response)
}

/// `refreshNow(stored)`
fn refresh_now(
    host: &mut dyn RemoteHost,
    st: &mut Shared,
    stored: &StoredOAuth,
) -> Result<StoredOAuth, FetchError> {
    let config = host.read();
    let outcome = {
        let mut fetch = AuthFetch::new(&mut *host);
        refresh_stored_oauth(stored, config.as_ref(), &mut fetch)
    };
    match outcome {
        RefreshOutcome::Refreshed(next) => {
            host.write_tokens(&serialize_stored_oauth(&next))
                .map_err(|message| FetchError::other("Error", &message))?;
            Ok(*next)
        }
        RefreshOutcome::Refused => {
            st.sign_in_needed = true;
            host.write_tokens("")
                .map_err(|message| FetchError::other("Error", &message))?;
            Err(st.record(RemoteMcpErrorReason::LoginRequired))
        }
        RefreshOutcome::Network => Err(st.record(RemoteMcpErrorReason::Unreachable)),
    }
}

/// `currentTokens()`
fn current_tokens(
    host: &mut dyn RemoteHost,
    st: &mut Shared,
) -> Result<Option<StoredOAuth>, FetchError> {
    if st.key_configured {
        return Ok(None);
    }
    let held = host.read().map(|config| config.tokens).unwrap_or_default();
    let Some(stored) = parse_stored_oauth(&held) else {
        return Ok(None);
    };
    let now = host.now();
    if access_token_expired(&stored, now) {
        refresh_now(host, st, &stored).map(Some)
    } else {
        Ok(Some(stored))
    }
}

fn access_token(stored: &StoredOAuth) -> Option<String> {
    as_str(prop(&stored.tokens, "access_token")).map(str::to_owned)
}

/// `serverFetch(input, init)`: the fetch every MCP request goes through
fn server_fetch(
    host: &mut dyn RemoteHost,
    st: &mut Shared,
    input: &str,
    init: &FetchInit,
) -> Result<FetchResponse, FetchError> {
    let url = Url::parse(input).map_err(|_| FetchError::type_error("Invalid URL"))?;
    if url.origin().ascii_serialization() != st.origin {
        return Err(st.record(RemoteMcpErrorReason::RefusedRedirect));
    }
    let check = check_address(&mut *host, url.as_str());
    if !matches!(check, AddressCheck::Allowed { .. }) {
        return Err(st.record(if is_unresolved(check) {
            RemoteMcpErrorReason::Unreachable
        } else {
            RemoteMcpErrorReason::InsecureAddress
        }));
    }

    let stored = current_tokens(host, st)?;
    let bearer = stored.as_ref().and_then(access_token);
    let mut response = send(host, st, &url, init, bearer.as_deref())?;
    if response.status != 401 {
        return Ok(response);
    }
    let params = extract_www_authenticate_params(&response.headers);
    st.challenge = Challenge {
        resource_metadata_url: params.resource_metadata_url,
        scope: params.scope,
    };
    cancel(host, &response.body);
    if let Some(stored) = stored {
        // a token the server no longer takes, before its time: one refresh, one retry
        let renewed = refresh_now(host, st, &stored)?;
        response = send(host, st, &url, init, access_token(&renewed).as_deref())?;
        if response.status != 401 {
            return Ok(response);
        }
        cancel(host, &response.body);
    }
    st.sign_in_needed = true;
    Err(st.record(RemoteMcpErrorReason::LoginRequired))
}

/// What a `Client` calls on its host: the fetch of this connection, its
/// timers, and the answers of its operations
struct Ctx<'a> {
    host: &'a mut dyn RemoteHost,
    shared: &'a mut Shared,
    client: ClientId,
}

impl FetchHost for Ctx<'_> {
    fn fetch(&mut self, url: &str, init: &FetchInit) -> Result<FetchResponse, FetchError> {
        let response = server_fetch(&mut *self.host, &mut *self.shared, url, init)?;
        if let Body::Stream(stream) = response.body {
            self.shared.streams.push((stream, self.client));
        }
        Ok(response)
    }

    fn read_body(&mut self, stream: u64) -> Result<Vec<u8>, FetchError> {
        self.host.read_body(stream)
    }

    fn cancel_body(&mut self, stream: u64) {
        self.host.cancel_body(stream);
    }

    fn abort_body(&mut self, stream: u64) {
        self.host.abort_body(stream);
    }
}

impl ClientHost for Ctx<'_> {
    fn set_timeout(&mut self, ms: f64) -> u64 {
        let timer = self.host.set_timeout(ms);
        self.shared
            .timers
            .push((timer, TimerOwner::Client(self.client)));
        timer
    }

    fn clear_timeout(&mut self, timer: u64) {
        self.shared.timers.retain(|(t, _)| *t != timer);
        self.host.clear_timeout(timer);
    }

    fn settle(&mut self, op: OpId, outcome: Result<Settled, ClientError>) {
        self.shared.queue.push_back(Event::Settled {
            client: self.client,
            cop: op,
            outcome,
        });
    }

    /// `next.onerror = () => {}`: transport errors surface through the request that hit them
    fn on_error(&mut self, _error: &ClientError) {}

    /// `next.onclose = () => { if (client === next) client = null }`
    fn on_close(&mut self) {
        if self.shared.active == Some(self.client) {
            self.shared.active = None;
        }
    }

    fn on_notification(&mut self, _notification: &JsonValue) {
        let listeners = self.shared.listeners.clone();
        self.shared.changed.extend(listeners);
    }

    fn compile_output_schema(&mut self, schema: &JsonValue) -> Result<u64, String> {
        self.host.compile_output_schema(schema)
    }

    fn validate_output(&mut self, validator: u64, structured_content: &JsonValue) -> OutputCheck {
        self.host.validate_output(validator, structured_content)
    }
}

/// what an operation does once there is a client
enum After {
    Connect,
    List,
    Call { name: String, arguments: JsonValue },
}

/// an operation waiting for `connecting` (`untilAborted(connecting, signal)`)
struct Waiter {
    op: u64,
    signal: Option<u64>,
    then: After,
}

struct ListRun {
    op: u64,
    signal: Option<u64>,
    client: ClientId,
    tools: Vec<ListedTool>,
    seen: Vec<String>,
}

struct CallRun {
    op: u64,
    signal: Option<u64>,
}

/// what aborts with a signal, in the order it was registered
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reg {
    Waiter(u64),
    Cop { client: ClientId, cop: u64 },
    SignIn(u64),
}

struct SignalState {
    id: u64,
    aborted: Option<AbortReason>,
    regs: Vec<Reg>,
}

struct SignInRun {
    id: u64,
    op: u64,
    machine: SignIn,
}

/// `createRemoteMcpConnection(options)`'s closure; see the module doc
pub struct RemoteConnection {
    clients: Vec<Slot>,
    shared: Shared,
    waiters: Vec<Waiter>,
    lists: Vec<ListRun>,
    calls: Vec<CallRun>,
    signals: Vec<SignalState>,
    sign_ins: Vec<SignInRun>,
    /// `signInAbort`: the attempt that is the latest
    sign_in_current: Option<u64>,
    next_run: u64,
    pumping: bool,
    /// the answers of operations, not yet taken
    finished: Vec<(u64, RemoteOutcome)>,
}

impl RemoteConnection {
    /// `createRemoteMcpConnection(options)`: `Err` is the message of what `new URL(server.url)` throws
    pub fn new(options: RemoteMcpConnectionOptions) -> Result<RemoteConnection, String> {
        let server = options.server;
        let url = Url::parse(&server.url).map_err(|_| "Invalid URL".to_owned())?;
        let client_name = options
            .client_name
            .unwrap_or_else(|| PRODUCT_NAME.to_owned());
        let key_configured = server
            .headers
            .entries()
            .iter()
            .any(|(name, _)| name.to_lowercase() == "authorization");
        Ok(RemoteConnection {
            clients: Vec::new(),
            shared: Shared {
                server_name: server.name,
                server_url: server.url,
                href: url.as_str().to_owned(),
                origin: url.origin().ascii_serialization(),
                headers: server.headers,
                key_configured,
                transport: server.transport,
                client_info: object(vec![
                    ("name", text(client_name.as_str())),
                    ("version", text(options.client_version)),
                ]),
                client_name,
                timeout: options.call_timeout_ms.unwrap_or(MCP_CALL_TIMEOUT_MS),
                active: None,
                connecting: None,
                generation: 0,
                sign_in_needed: false,
                challenge: Challenge::default(),
                seen_failure: None,
                answered_error: false,
                listeners: Vec::new(),
                changed: Vec::new(),
                next_client: 0,
                next_cop: 0,
                timers: Vec::new(),
                streams: Vec::new(),
                cops: Vec::new(),
                queue: VecDeque::new(),
                fetch_limit: None,
            },
            waiters: Vec::new(),
            lists: Vec::new(),
            calls: Vec::new(),
            signals: Vec::new(),
            sign_ins: Vec::new(),
            sign_in_current: None,
            next_run: 0,
            pumping: false,
            finished: Vec::new(),
        })
    }

    /// the answers of operations since the last call, in the order they came
    pub fn take_finished(&mut self) -> Vec<(u64, RemoteOutcome)> {
        std::mem::take(&mut self.finished)
    }

    /// the `onToolsChanged` listeners the server's notifications called since
    /// the last call, in the order they were called
    pub fn take_tools_changed(&mut self) -> Vec<u64> {
        std::mem::take(&mut self.shared.changed)
    }

    /// the promise of operation `op` settles
    fn finish(&mut self, op: u64, outcome: RemoteOutcome) {
        self.finished.push((op, outcome));
    }

    // ---- the operations ----

    /// `connect(signal)`: connect now ("연결 확인"); later calls connect on first use by themselves
    pub fn connect(&mut self, host: &mut dyn RemoteHost, op: u64, signal: Option<SignalRef>) {
        let signal = self.use_signal(signal);
        self.ready(host, op, signal, After::Connect);
        self.pump(host);
    }

    /// `listTools(signal)`: every page of tools/list, and the instructions from initialize
    pub fn list_tools(&mut self, host: &mut dyn RemoteHost, op: u64, signal: Option<SignalRef>) {
        let signal = self.use_signal(signal);
        self.ready(host, op, signal, After::List);
        self.pump(host);
    }

    /// `callTool(name, args, signal)`: the server's result as it came; shaping
    /// it for the model is the caller's
    pub fn call_tool(
        &mut self,
        host: &mut dyn RemoteHost,
        op: u64,
        name: &str,
        args: JsonValue,
        signal: Option<SignalRef>,
    ) {
        let signal = self.use_signal(signal);
        self.ready(
            host,
            op,
            signal,
            After::Call {
                name: name.to_owned(),
                arguments: args,
            },
        );
        self.pump(host);
    }

    /// `onToolsChanged(listener)`: the server said its tool list changed;
    /// `listener` is what [`RemoteConnection::take_tools_changed`] lists
    pub fn on_tools_changed(&mut self, listener: u64) {
        if !self.shared.listeners.contains(&listener) {
            self.shared.listeners.push(listener);
        }
    }

    /// the unsubscribe `onToolsChanged` returned
    pub fn off_tools_changed(&mut self, listener: u64) {
        self.shared.listeners.retain(|l| *l != listener);
    }

    /// `needsSignIn()`: the server asked for a sign-in that has not happened,
    /// or whose refresh was refused
    pub fn needs_sign_in(&self) -> bool {
        self.shared.sign_in_needed
    }

    /// `signIn(options)`: the browser sign-in; a newer attempt cancels the one before
    pub fn sign_in(
        &mut self,
        host: &mut dyn RemoteHost,
        op: u64,
        options: McpSignInOptions<'_>,
        signal: Option<SignalRef>,
    ) {
        if self.shared.key_configured {
            self.finish(
                op,
                Ok(RemoteResult::SignedIn(McpSignInResult::Failed(
                    McpSignInFailure::KeyInUse,
                ))),
            );
            return;
        }
        let run_id = self.next_run;
        self.next_run += 1;
        if let Some(previous) = self.sign_in_current {
            self.abort_sign_in(host, previous);
        }
        self.sign_in_current = Some(run_id);
        let signal = self.use_signal(signal);
        let aborted = self.signal_aborted(signal);
        let config = host.read();
        let context = SignInContext {
            open_external: options.open_external,
            server_url: self.shared.server_url.clone(),
            resource_metadata_url: self.shared.challenge.resource_metadata_url.clone(),
            scope: self.shared.challenge.scope.clone(),
            config,
            client_name: self.shared.client_name.clone(),
            pages: options.pages,
            timeout_ms: options.timeout_ms,
            aborted,
        };
        let machine = SignIn::start(&mut *host, context);
        self.sign_ins.push(SignInRun {
            id: run_id,
            op,
            machine,
        });
        self.register(signal, Reg::SignIn(run_id));
        self.settle_sign_in(host, run_id);
        self.pump(host);
    }

    /// `revoke()`: before the server is deleted, ask for revocation when
    /// offered, then forget the tokens
    pub fn revoke(&mut self, host: &mut dyn RemoteHost, op: u64) {
        let held = host.read();
        let stored = parse_stored_oauth(held.as_ref().map_or("", |c| c.tokens.as_str()));
        if let Some(stored) = stored {
            let mut fetch = AuthFetch::new(&mut *host);
            revoke_stored_oauth(&stored, held.as_ref(), &mut fetch);
        }
        if held.as_ref().is_some_and(|c| !c.tokens.is_empty()) {
            let _ = host.write_tokens("");
        }
        self.drop_client(host);
        self.pump(host);
        self.finish(op, Ok(RemoteResult::Revoked));
    }

    /// `close()`
    pub fn close(&mut self, host: &mut dyn RemoteHost, op: u64) {
        if let Some(current) = self.sign_in_current {
            self.abort_sign_in(host, current);
        }
        self.drop_client(host);
        self.pump(host);
        self.finish(op, Ok(RemoteResult::Closed));
    }

    // ---- what the world tells ----

    /// a timer started through the host fired: whether it was this connection's
    pub fn on_timeout(&mut self, host: &mut dyn RemoteHost, timer: u64) -> bool {
        let position = self.shared.timers.iter().position(|(t, _)| *t == timer);
        let owner = position.map(|index| self.shared.timers.remove(index).1);
        let owned = match owner {
            Some(TimerOwner::Client(id)) => {
                self.call_client(host, id, |client, ctx| client.on_timeout(ctx, timer));
                true
            }
            Some(TimerOwner::Race) => true,
            None => {
                let mut found = None;
                for run in &mut self.sign_ins {
                    if run.machine.on_timeout(&mut *host, timer) {
                        found = Some(run.id);
                        break;
                    }
                }
                match found {
                    Some(id) => {
                        self.settle_sign_in(host, id);
                        true
                    }
                    None => false,
                }
            }
        };
        self.pump(host);
        owned
    }

    /// the `AbortSignal` named `signal` aborted with `reason`
    pub fn on_abort(&mut self, host: &mut dyn RemoteHost, signal: u64, reason: AbortReason) {
        let regs = match self.signals.iter_mut().find(|s| s.id == signal) {
            Some(state) => {
                if state.aborted.is_some() {
                    return;
                }
                state.aborted = Some(reason.clone());
                state.regs.clone()
            }
            None => {
                self.signals.push(SignalState {
                    id: signal,
                    aborted: Some(reason),
                    regs: Vec::new(),
                });
                return;
            }
        };
        for reg in regs {
            match reg {
                Reg::Waiter(op) => {
                    if let Some(index) = self.waiters.iter().position(|w| w.op == op) {
                        self.waiters.remove(index);
                        let error = self.shared.fail(RemoteMcpErrorReason::Aborted);
                        self.finish(op, Err(RemoteError::Remote(error)));
                    }
                }
                Reg::Cop { client, cop } => {
                    let reason = reason.clone();
                    self.call_client(host, client, |c, ctx| c.on_abort(ctx, cop, reason));
                }
                Reg::SignIn(run) => self.abort_sign_in(host, run),
            }
        }
        self.pump(host);
    }

    /// the signal named `signal` is gone: its listeners go with it
    pub fn release_signal(&mut self, signal: u64) {
        let Some(index) = self.signals.iter().position(|s| s.id == signal) else {
            return;
        };
        let state = self.signals.remove(index);
        for reg in state.regs {
            if let Reg::Cop { client, cop } = reg
                && let Some(slot) = self.clients.iter_mut().find(|s| s.id == client)
            {
                slot.client.release(cop);
            }
        }
    }

    /// a chunk of the body of a [`Body::Stream`] arrived
    pub fn on_stream_chunk(&mut self, host: &mut dyn RemoteHost, stream: u64, bytes: &[u8]) {
        if let Some(client) = self.stream_owner(stream) {
            self.call_client(host, client, |c, ctx| c.on_stream_chunk(ctx, stream, bytes));
        }
        self.pump(host);
    }

    /// the body of a [`Body::Stream`] ended
    pub fn on_stream_end(&mut self, host: &mut dyn RemoteHost, stream: u64) {
        if let Some(client) = self.stream_owner(stream) {
            self.call_client(host, client, |c, ctx| c.on_stream_end(ctx, stream));
        }
        self.pump(host);
    }

    /// the body of a [`Body::Stream`] failed
    pub fn on_stream_error(&mut self, host: &mut dyn RemoteHost, stream: u64, error: &FetchError) {
        if let Some(client) = self.stream_owner(stream) {
            self.call_client(host, client, |c, ctx| c.on_stream_error(ctx, stream, error));
        }
        self.pump(host);
    }

    /// a request of the loopback server of a sign-in (on `port`): whether a sign-in of this connection waits there
    pub fn on_loopback_request(
        &mut self,
        host: &mut dyn RemoteHost,
        port: u16,
        method: &str,
        target: &str,
    ) -> bool {
        let mut found = None;
        for run in &mut self.sign_ins {
            if run.machine.on_request(&mut *host, port, method, target) {
                found = Some(run.id);
                break;
            }
        }
        let routed = found.is_some();
        if let Some(id) = found {
            self.settle_sign_in(host, id);
        }
        self.pump(host);
        routed
    }

    // ---- signals ----

    fn stream_owner(&self, stream: u64) -> Option<ClientId> {
        self.shared
            .streams
            .iter()
            .find(|(s, _)| *s == stream)
            .map(|(_, client)| *client)
    }

    /// the signal of an operation, made on first use
    fn use_signal(&mut self, signal: Option<SignalRef>) -> Option<u64> {
        let signal = signal?;
        if !self.signals.iter().any(|s| s.id == signal.id) {
            self.signals.push(SignalState {
                id: signal.id,
                aborted: signal.aborted,
                regs: Vec::new(),
            });
        }
        Some(signal.id)
    }

    fn signal_aborted(&self, signal: Option<u64>) -> bool {
        signal.is_some_and(|id| {
            self.signals
                .iter()
                .any(|s| s.id == id && s.aborted.is_some())
        })
    }

    /// `{ signal }` of a request's options
    fn signal_option(&self, signal: Option<u64>) -> Option<Signal> {
        let id = signal?;
        let aborted = self
            .signals
            .iter()
            .find(|s| s.id == id)
            .and_then(|s| s.aborted.clone());
        Some(Signal { aborted })
    }

    fn register(&mut self, signal: Option<u64>, reg: Reg) {
        if let Some(id) = signal
            && let Some(state) = self.signals.iter_mut().find(|s| s.id == id)
        {
            state.regs.push(reg);
        }
    }

    fn unregister(&mut self, signal: Option<u64>, reg: Reg) {
        if let Some(id) = signal
            && let Some(state) = self.signals.iter_mut().find(|s| s.id == id)
        {
            state.regs.retain(|r| *r != reg);
        }
    }

    // ---- clients ----

    fn call_client<R>(
        &mut self,
        host: &mut dyn RemoteHost,
        id: ClientId,
        call: impl FnOnce(&mut Client, &mut Ctx<'_>) -> R,
    ) -> Option<R> {
        let slot = self.clients.iter_mut().find(|s| s.id == id)?;
        let mut ctx = Ctx {
            host: &mut *host,
            shared: &mut self.shared,
            client: id,
        };
        Some(call(&mut slot.client, &mut ctx))
    }

    fn new_cop(&mut self, owner: CopOwner) -> u64 {
        let cop = self.shared.next_cop;
        self.shared.next_cop += 1;
        self.shared.cops.push((cop, owner));
        cop
    }

    /// `classify(err, signal)`: the reason; `aborted` is `signal?.aborted`
    fn classify(&self, error: &ClientError, aborted: bool) -> RemoteMcpErrorReason {
        if aborted {
            return RemoteMcpErrorReason::Aborted;
        }
        if let Some(reason) = remote_reason(error) {
            return reason;
        }
        match error {
            ClientError::Mcp(mcp) => {
                if mcp.code == error_code::REQUEST_TIMEOUT {
                    RemoteMcpErrorReason::Timeout
                } else if mcp.code == error_code::CONNECTION_CLOSED {
                    RemoteMcpErrorReason::Unreachable
                } else {
                    RemoteMcpErrorReason::ServerError
                }
            }
            ClientError::StreamableHttp { code, .. } if *code >= 400.0 => {
                RemoteMcpErrorReason::HttpError
            }
            _ => {
                if self.shared.answered_error {
                    RemoteMcpErrorReason::HttpError
                } else {
                    RemoteMcpErrorReason::Unreachable
                }
            }
        }
    }

    // ---- connecting ----

    /// `ready(signal)`: the client is there, or the operation waits for it
    fn ready(&mut self, host: &mut dyn RemoteHost, op: u64, signal: Option<u64>, then: After) {
        if let Some(client) = self.shared.active {
            self.proceed(host, op, signal, then, client);
            return;
        }
        if self.shared.connecting.is_none() {
            self.shared.connecting = Some(Connecting {
                mine: self.shared.generation,
                attempt: None,
            });
            self.open(host);
        }
        // `untilAborted(connecting, signal)`
        if self.signal_aborted(signal) {
            let error = self.shared.fail(RemoteMcpErrorReason::Aborted);
            self.finish(op, Err(RemoteError::Remote(error)));
            return;
        }
        self.waiters.push(Waiter { op, signal, then });
        self.register(signal, Reg::Waiter(op));
    }

    /// `open()` up to its first wait
    fn open(&mut self, host: &mut dyn RemoteHost) {
        self.shared.seen_failure = None;
        self.shared.answered_error = false;
        let check = check_address(&mut *host, &self.shared.server_url);
        if !matches!(check, AddressCheck::Allowed { .. }) {
            let reason = if is_unresolved(check) {
                RemoteMcpErrorReason::Unreachable
            } else {
                RemoteMcpErrorReason::InsecureAddress
            };
            let error = self.shared.fail(reason);
            self.shared.queue.push_back(Event::Opened(Err(error)));
            return;
        }
        if self.shared.transport == McpTransport::Sse {
            self.attach(host, Kind::Sse, false);
        } else {
            self.attach(host, Kind::Streamable, true);
        }
    }

    /// `attach(kind)` up to the wait for `connect`
    fn attach(&mut self, host: &mut dyn RemoteHost, kind: Kind, can_fall_back: bool) {
        let id = self.shared.next_client;
        self.shared.next_client += 1;
        let transport: Box<dyn Transport> = match kind {
            Kind::Sse => Box::new(SseTransport::new(&self.shared.href)),
            Kind::Streamable => Box::new(StreamableHttpTransport::new(&self.shared.href)),
        };
        let mut client = Client::new(self.shared.client_info.clone());
        client.set_notification_handler();
        self.clients.push(Slot { id, client, kind });
        if let Some(connecting) = self.shared.connecting.as_mut() {
            connecting.attempt = Some(Attempt { can_fall_back });
        }
        let cop = self.new_cop(CopOwner::Connect);
        let options = RequestOptions {
            timeout: Some(self.shared.timeout),
            signal: None,
        };
        self.call_client(host, id, |client, ctx| {
            client.connect(ctx, cop, transport, options);
        });
    }

    /// `fallsBack(err)`: a server that does not speak Streamable HTTP answers its POST with 4xx or another type
    fn falls_back(&self, error: &ClientError) -> bool {
        if remote_reason(error).is_some() || self.shared.seen_failure.is_some() {
            return false;
        }
        match error {
            ClientError::StreamableHttp { code, .. } => {
                *code == -1.0 || (*code >= 400.0 && *code < 500.0)
            }
            _ => false,
        }
    }

    fn close_client(&mut self, host: &mut dyn RemoteHost, id: ClientId) {
        self.call_client(host, id, |client, ctx| client.close(ctx));
    }

    /// what follows an `attach`
    fn on_attached(
        &mut self,
        host: &mut dyn RemoteHost,
        client: ClientId,
        outcome: Result<Settled, ClientError>,
    ) {
        let attempt = self
            .shared
            .connecting
            .as_mut()
            .and_then(|connecting| connecting.attempt.take());
        match outcome {
            Ok(_) => self.shared.queue.push_back(Event::Opened(Ok(client))),
            Err(error) => {
                self.close_client(host, client);
                if attempt.is_some_and(|a| a.can_fall_back) && self.falls_back(&error) {
                    self.attach(host, Kind::Sse, false);
                    return;
                }
                let reason = match remote_reason(&error) {
                    Some(reason) => reason,
                    None => match self.shared.seen_failure {
                        Some(seen) => seen,
                        None => self.classify(&error, false),
                    },
                };
                let error = self.shared.fail(reason);
                self.shared.queue.push_back(Event::Opened(Err(error)));
            }
        }
    }

    /// `open().then(...).finally(...)` and the operations that waited for it
    fn on_opened(&mut self, host: &mut dyn RemoteHost, result: Result<ClientId, RemoteMcpError>) {
        let mine = self
            .shared
            .connecting
            .as_ref()
            .map_or(self.shared.generation, |c| c.mine);
        let outcome = match result {
            Ok(next) => {
                if mine != self.shared.generation {
                    self.close_client(host, next);
                    Err(self.shared.fail(RemoteMcpErrorReason::Aborted))
                } else {
                    self.shared.active = Some(next);
                    self.shared.sign_in_needed = false;
                    // a 4xx before the SSE fallback worked says nothing about later failures
                    self.shared.answered_error = false;
                    Ok(next)
                }
            }
            Err(error) => Err(error),
        };
        self.shared.connecting = None;
        for waiter in std::mem::take(&mut self.waiters) {
            self.unregister(waiter.signal, Reg::Waiter(waiter.op));
            match &outcome {
                Ok(client) => self.proceed(host, waiter.op, waiter.signal, waiter.then, *client),
                Err(error) => self.finish(waiter.op, Err(RemoteError::Remote(error.clone()))),
            }
        }
    }

    /// an operation that has its client
    fn proceed(
        &mut self,
        host: &mut dyn RemoteHost,
        op: u64,
        signal: Option<u64>,
        then: After,
        client: ClientId,
    ) {
        match then {
            After::Connect => self.finish(op, Ok(RemoteResult::Connected)),
            After::List => {
                self.lists.push(ListRun {
                    op,
                    signal,
                    client,
                    tools: Vec::new(),
                    seen: Vec::new(),
                });
                self.list_page(host, op, None);
            }
            After::Call { name, arguments } => {
                self.calls.push(CallRun { op, signal });
                let cop = self.new_cop(CopOwner::Call(op));
                let options = RequestOptions {
                    timeout: Some(self.shared.timeout),
                    signal: self.signal_option(signal),
                };
                self.register(signal, Reg::Cop { client, cop });
                let params = object(vec![("name", text(name)), ("arguments", arguments)]);
                let started = self.call_client(host, client, |c, ctx| {
                    c.call_tool(ctx, cop, params, &options);
                });
                if started.is_none() {
                    self.not_connected(client, cop);
                }
            }
        }
    }

    /// the operation of a client that is gone
    fn not_connected(&mut self, client: ClientId, cop: u64) {
        self.shared.queue.push_back(Event::Settled {
            client,
            cop,
            outcome: Err(ClientError::plain("Not connected")),
        });
    }

    /// one page of `tools/list`
    fn list_page(&mut self, host: &mut dyn RemoteHost, op: u64, cursor: Option<String>) {
        let Some(run) = self.lists.iter().find(|r| r.op == op) else {
            return;
        };
        let (client, signal) = (run.client, run.signal);
        let cop = self.new_cop(CopOwner::List(op));
        let options = RequestOptions {
            timeout: Some(self.shared.timeout),
            signal: self.signal_option(signal),
        };
        self.register(signal, Reg::Cop { client, cop });
        let params = cursor.map(|cursor| object(vec![("cursor", text(cursor))]));
        let started = self.call_client(host, client, |c, ctx| {
            c.list_tools(ctx, cop, params, &options);
        });
        if started.is_none() {
            self.not_connected(client, cop);
        }
    }

    // ---- what the clients settled ----

    fn on_settled(
        &mut self,
        host: &mut dyn RemoteHost,
        client: ClientId,
        cop: u64,
        outcome: Result<Settled, ClientError>,
    ) {
        let Some(index) = self.shared.cops.iter().position(|(c, _)| *c == cop) else {
            return;
        };
        let owner = self.shared.cops.remove(index).1;
        match owner {
            CopOwner::Connect => self.on_attached(host, client, outcome),
            CopOwner::List(op) => self.on_page(host, op, outcome),
            CopOwner::Call(op) => {
                let Some(index) = self.calls.iter().position(|r| r.op == op) else {
                    return;
                };
                let run = self.calls.remove(index);
                let answer = match outcome {
                    Ok(Settled::Result(result)) => Ok(RemoteResult::Called(result)),
                    Ok(Settled::Connected) => Ok(RemoteResult::Called(JsonValue::Null)),
                    Err(error) => {
                        let reason = self.classify(&error, self.signal_aborted(run.signal));
                        Err(RemoteError::Remote(self.shared.fail(reason)))
                    }
                };
                self.finish(op, answer);
            }
        }
    }

    /// a page of `tools/list` came, or failed
    fn on_page(
        &mut self,
        host: &mut dyn RemoteHost,
        op: u64,
        outcome: Result<Settled, ClientError>,
    ) {
        let Some(index) = self.lists.iter().position(|r| r.op == op) else {
            return;
        };
        let page = match outcome {
            Ok(Settled::Result(page)) => page,
            Ok(Settled::Connected) => JsonValue::Null,
            Err(error) => {
                let run = self.lists.remove(index);
                let reason = self.classify(&error, self.signal_aborted(run.signal));
                self.finish(op, Err(RemoteError::Remote(self.shared.fail(reason))));
                return;
            }
        };
        if let Some(JsonValue::Array(tools)) = prop(&page, "tools") {
            for tool in tools {
                let mut listed = ListedTool {
                    name: as_str(prop(tool, "name")).unwrap_or("").to_owned(),
                    description: None,
                    input_schema: prop(tool, "inputSchema").cloned(),
                    annotations: None,
                };
                if let Some(description) = as_str(prop(tool, "description")) {
                    listed.description = Some(description.to_owned());
                }
                if let Some(annotations) = prop(tool, "annotations").filter(|a| a.truthy()) {
                    listed.annotations = Some(annotations.clone());
                }
                self.lists[index].tools.push(listed);
            }
        }
        let cursor = as_str(prop(&page, "nextCursor")).map(str::to_owned);
        if let Some(cursor) = cursor {
            // a server that hands back a cursor it gave before would never end the list
            if !self.lists[index].seen.contains(&cursor) {
                self.lists[index].seen.push(cursor.clone());
                self.list_page(host, op, Some(cursor));
                return;
            }
        }
        let run = self.lists.remove(index);
        let instructions = self
            .clients
            .iter()
            .find(|s| s.id == run.client)
            .and_then(|s| s.client.get_instructions())
            .map(str::to_owned);
        self.finish(
            op,
            Ok(RemoteResult::Listing(McpListing {
                tools: run.tools,
                instructions,
            })),
        );
    }

    // ---- signing in ----

    /// `signInAbort.abort()` for one attempt
    fn abort_sign_in(&mut self, host: &mut dyn RemoteHost, run: u64) {
        let Some(index) = self.sign_ins.iter().position(|r| r.id == run) else {
            return;
        };
        self.sign_ins[index].machine.on_abort(&mut *host);
        self.settle_sign_in(host, run);
    }

    /// what follows `signInToServer(...)` once it answered
    fn settle_sign_in(&mut self, host: &mut dyn RemoteHost, run: u64) {
        let Some(index) = self.sign_ins.iter().position(|r| r.id == run) else {
            return;
        };
        if !self.sign_ins[index].machine.is_done() {
            return;
        }
        let mut finished = self.sign_ins.remove(index);
        let Some(result) = finished.machine.take_result() else {
            return;
        };
        let op = finished.op;
        let outcome = match result {
            SignInResult::Failed(reason) => {
                Ok(RemoteResult::SignedIn(McpSignInResult::Failed(reason)))
            }
            SignInResult::Threw(message) => Err(RemoteError::Failed(message)),
            SignInResult::Signed(stored) => {
                match host.write_tokens(&serialize_stored_oauth(&stored)) {
                    Err(message) => Err(RemoteError::Failed(format!("Error: {message}"))),
                    Ok(()) => {
                        self.shared.sign_in_needed = false;
                        // the next use connects with the new token
                        self.drop_client(host);
                        Ok(RemoteResult::SignedIn(McpSignInResult::Ok))
                    }
                }
            }
        };
        if self.sign_in_current == Some(run) {
            self.sign_in_current = None;
        }
        self.pump(host);
        self.finish(op, outcome);
    }

    /// `dropClient()`
    fn drop_client(&mut self, host: &mut dyn RemoteHost) {
        self.shared.generation += 1;
        let Some(current) = self.shared.active.take() else {
            return;
        };
        let Some(slot) = self.clients.iter().find(|s| s.id == current) else {
            return;
        };
        let holds_session = slot.kind == Kind::Streamable
            && slot.client.session_id().is_some_and(|id| !id.is_empty());
        if holds_session {
            // `Promise.race([terminateSession().catch(...), 5 s timer])`
            let timer = host.set_timeout(TERMINATE_TIMEOUT_MS);
            self.shared.timers.push((timer, TimerOwner::Race));
            self.shared.fetch_limit = Some(TERMINATE_TIMEOUT_MS);
            self.call_client(host, current, |client, ctx| client.terminate_session(ctx));
            self.shared.fetch_limit = None;
        }
        self.close_client(host, current);
    }

    // ---- the queue ----

    /// the continuations of what the clients settled, in the order they came
    fn pump(&mut self, host: &mut dyn RemoteHost) {
        if self.pumping {
            return;
        }
        self.pumping = true;
        while let Some(event) = self.shared.queue.pop_front() {
            match event {
                Event::Settled {
                    client,
                    cop,
                    outcome,
                } => self.on_settled(host, client, cop, outcome),
                Event::Opened(result) => self.on_opened(host, result),
            }
        }
        self.pumping = false;
        self.sweep();
    }

    /// drops the clients that closed and that nothing refers to any more
    fn sweep(&mut self) {
        let shared = &self.shared;
        let lists = &self.lists;
        self.clients.retain(|slot| {
            slot.client.is_connected()
                || shared.active == Some(slot.id)
                || lists.iter().any(|run| run.client == slot.id)
        });
        let live: Vec<ClientId> = self.clients.iter().map(|s| s.id).collect();
        self.shared
            .streams
            .retain(|(_, client)| live.contains(client));
        self.shared.timers.retain(|(_, owner)| match owner {
            TimerOwner::Client(client) => live.contains(client),
            TimerOwner::Race => true,
        });
    }
}

// ---- the hub's view ----------------------------------------------------------

fn conn_error(error: RemoteError) -> ConnError {
    match error {
        RemoteError::Remote(error) => ConnError::Remote(match error.reason {
            RemoteMcpErrorReason::Unreachable => RemoteReason::Unreachable,
            RemoteMcpErrorReason::HttpError => RemoteReason::HttpError,
            RemoteMcpErrorReason::Timeout => RemoteReason::Timeout,
            RemoteMcpErrorReason::Aborted => RemoteReason::Aborted,
            RemoteMcpErrorReason::RefusedRedirect => RemoteReason::RefusedRedirect,
            RemoteMcpErrorReason::InsecureAddress => RemoteReason::InsecureAddress,
            RemoteMcpErrorReason::LoginRequired => RemoteReason::LoginRequired,
            RemoteMcpErrorReason::ServerError => RemoteReason::ServerError,
        }),
        RemoteError::Failed(_) => ConnError::Other,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OpKind {
    List,
    Call,
    SignIn,
    Revoke,
    Close,
}

fn conn_outcome(kind: OpKind, outcome: RemoteOutcome) -> ConnOutcome {
    match (kind, outcome) {
        (OpKind::List, Ok(RemoteResult::Listing(listing))) => ConnOutcome::Listed(Ok(listing)),
        (OpKind::List, Err(error)) => ConnOutcome::Listed(Err(conn_error(error))),
        (OpKind::Call, Ok(RemoteResult::Called(result))) => ConnOutcome::RemoteCalled(Ok(result)),
        (OpKind::Call, Err(error)) => ConnOutcome::RemoteCalled(Err(conn_error(error))),
        (OpKind::SignIn, Ok(RemoteResult::SignedIn(McpSignInResult::Ok))) => {
            ConnOutcome::SignedIn(HubSignInResult::Ok)
        }
        (OpKind::SignIn, Ok(RemoteResult::SignedIn(McpSignInResult::Failed(reason)))) => {
            ConnOutcome::SignedIn(HubSignInResult::Failed(reason.as_str().to_owned()))
        }
        // the hub has no rejection of `signIn`: a sign-in that threw is a network failure to it
        (OpKind::SignIn, _) => ConnOutcome::SignedIn(HubSignInResult::Failed("network".to_owned())),
        (OpKind::Revoke, _) => ConnOutcome::Revoked,
        (OpKind::Close, _) => ConnOutcome::Closed,
        (OpKind::List, Ok(_)) => ConnOutcome::Listed(Err(ConnError::Other)),
        (OpKind::Call, Ok(_)) => ConnOutcome::RemoteCalled(Err(ConnError::Other)),
    }
}

struct HubRemoteInner<'h> {
    core: RemoteConnection,
    host: Box<dyn RemoteHost + 'h>,
    kinds: HashMap<u64, OpKind>,
    settled: Vec<(u64, ConnOutcome)>,
    tools_changed: bool,
}

impl HubRemoteInner<'_> {
    /// moves what the connection answered into what the hub is told
    fn collect(&mut self) {
        for (op, outcome) in self.core.take_finished() {
            self.core.release_signal(op);
            if let Some(kind) = self.kinds.remove(&op) {
                self.settled.push((op, conn_outcome(kind, outcome)));
            }
        }
        if !self.core.take_tools_changed().is_empty() {
            self.tools_changed = true;
        }
    }
}

/// A [`RemoteConnection`] with its host, as hub.rs's `RemoteConnection` trait
/// asks for it. The handle is cheap to clone: the host of the hub hands one
/// clone to the hub (boxed) and keeps another to deliver what the world tells
/// it (`on_timeout`, the stream events, `on_loopback_request`), then asks
/// `take_settled` / `take_tools_changed` after each of them, and drives
/// `McpHub::on_settled` and `McpHub::on_tools_changed` with the answers.
/// The signal of an operation is its number; its signal is released when the
/// operation answers.
pub struct HubRemote<'h> {
    inner: Rc<RefCell<HubRemoteInner<'h>>>,
}

impl Clone for HubRemote<'_> {
    fn clone(&self) -> Self {
        HubRemote {
            inner: Rc::clone(&self.inner),
        }
    }
}

impl<'h> HubRemote<'h> {
    pub fn new(
        options: RemoteMcpConnectionOptions,
        host: Box<dyn RemoteHost + 'h>,
    ) -> Result<HubRemote<'h>, String> {
        Ok(HubRemote {
            inner: Rc::new(RefCell::new(HubRemoteInner {
                core: RemoteConnection::new(options)?,
                host,
                kinds: HashMap::new(),
                settled: Vec::new(),
                tools_changed: false,
            })),
        })
    }

    /// the answers of operations since the last call, to hand to `McpHub::on_settled`
    pub fn take_settled(&self) -> Vec<(u64, ConnOutcome)> {
        std::mem::take(&mut self.inner.borrow_mut().settled)
    }

    /// whether the server said its tool list changed since the last call (`McpHub::on_tools_changed`)
    pub fn take_tools_changed(&self) -> bool {
        std::mem::take(&mut self.inner.borrow_mut().tools_changed)
    }

    /// a timer the host's `set_timeout` started fired: whether it was this connection's
    pub fn on_timeout(&self, timer: u64) -> bool {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        let owned = inner.core.on_timeout(&mut *inner.host, timer);
        inner.collect();
        owned
    }

    /// a chunk of a response body arrived
    pub fn on_stream_chunk(&self, stream: u64, bytes: &[u8]) {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        inner.core.on_stream_chunk(&mut *inner.host, stream, bytes);
        inner.collect();
    }

    /// a response body ended
    pub fn on_stream_end(&self, stream: u64) {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        inner.core.on_stream_end(&mut *inner.host, stream);
        inner.collect();
    }

    /// a response body failed
    pub fn on_stream_error(&self, stream: u64, error: &FetchError) {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        inner.core.on_stream_error(&mut *inner.host, stream, error);
        inner.collect();
    }

    /// a request of the loopback server of a sign-in: whether this connection's
    pub fn on_loopback_request(&self, port: u16, method: &str, target: &str) -> bool {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        let routed = inner
            .core
            .on_loopback_request(&mut *inner.host, port, method, target);
        inner.collect();
        routed
    }
}

impl<'h> HubRemoteConnection<'h> for HubRemote<'h> {
    fn list_tools(&mut self, op: u64) {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        inner.kinds.insert(op, OpKind::List);
        let signal = Some(SignalRef {
            id: op,
            aborted: None,
        });
        inner.core.list_tools(&mut *inner.host, op, signal);
        inner.collect();
    }

    fn call_tool(&mut self, op: u64, name: &str, args: &JsonValue) {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        inner.kinds.insert(op, OpKind::Call);
        let signal = Some(SignalRef {
            id: op,
            aborted: None,
        });
        inner
            .core
            .call_tool(&mut *inner.host, op, name, args.clone(), signal);
        inner.collect();
    }

    fn needs_sign_in(&self) -> bool {
        self.inner.borrow().core.needs_sign_in()
    }

    fn sign_in(&mut self, op: u64, options: SignInOptions<'h>) {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        inner.kinds.insert(op, OpKind::SignIn);
        let page = |page: &super::hub_strings::McpSignInPage| SignInPage {
            lang: page.lang.clone(),
            title: page.title.clone(),
            body: page.body.clone(),
        };
        let opened = options.open_external.clone();
        let sign_in = McpSignInOptions {
            open_external: &*opened,
            pages: LoopbackPages {
                done: page(&options.pages.done),
                failed: page(&options.pages.failed),
            },
            timeout_ms: None,
        };
        let signal = Some(SignalRef {
            id: op,
            aborted: None,
        });
        inner.core.sign_in(&mut *inner.host, op, sign_in, signal);
        inner.collect();
    }

    fn revoke(&mut self, op: u64) {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        inner.kinds.insert(op, OpKind::Revoke);
        inner.core.revoke(&mut *inner.host, op);
        inner.collect();
    }

    fn close(&mut self, op: u64) {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        inner.kinds.insert(op, OpKind::Close);
        inner.core.close(&mut *inner.host, op);
        inner.collect();
    }

    fn abort(&mut self, op: u64) {
        let mut guard = self.inner.borrow_mut();
        let inner = &mut *guard;
        inner
            .core
            .on_abort(&mut *inner.host, op, AbortReason::default_abort());
        inner.collect();
    }
}
