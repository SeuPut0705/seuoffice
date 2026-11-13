//! `apps/shell/src/main/mcp-client/hub.ts`: the one place the app holds the
//! person's MCP servers (user MCP spec 5.1): the store, and a connection per
//! server (remote or "my PC") shared by every window.
//!
//! # Driving the hub
//!
//! The TypeScript hub is a set of `async` functions that await three kinds of
//! things: the store and the host (`plannedLaunch`, the runtime kit,
//! `openExternal`), which are plain synchronous calls here, and the
//! connections' operations (`listTools`, `callTool`, `ensure`, `signIn`,
//! `revoke`, `stop`, `close`), which really wait. A connection is behind
//! [`RemoteConnection`] / [`LocalConnection`]; the hub is a state machine the
//! caller owns (never a global):
//!
//! - A method that starts an operation takes an [`OpId`] the hub made up.
//!   The connection answers it exactly once, later, with
//!   [`McpHub::on_settled`]. The hub never waits and the connection never
//!   calls back into the hub from inside one of its methods.
//! - The `AbortSignal` the TypeScript hands to an operation is the same
//!   [`OpId`]: when it aborts the hub calls `abort(op)`, and the connection
//!   settles the operation as it settles an aborted one (the TypeScript
//!   rejects: [`ConnError::Abort`] for a local one, `aborted` for a remote
//!   one). A signal that is aborted already when the operation starts is
//!   announced by `abort(op)` right after the start.
//! - What a connection reports by itself reaches the hub as
//!   [`McpHub::on_tools_changed`] and [`McpHub::on_local_state_changed`].
//!   The hub tells each connection its [`ConnId`] when it makes it, and the
//!   caller routes these events by it. Events of a connection the hub no
//!   longer follows (`live.unsubscribe`) are ignored.
//! - A public method that awaits answers [`Reply::Now`] when it finished at
//!   once and [`Reply::Later`] with a [`Ticket`] otherwise; the answer comes
//!   from [`McpHub::take_settled`]. A call can only be answered, never
//!   rejected. Methods that write the store return `Err` where the
//!   TypeScript's promise rejects.
//! - `notify()` of the TypeScript queues a microtask that tells the listeners
//!   once, when the stack next empties or at the next `await`, with the view
//!   as it is then. The hub models that: `notify()` only queues, and the hub
//!   *flushes* (turns the queued notice into a [`ChangedNotice`] holding
//!   `settings_view()` at that moment) at every point the TypeScript lets
//!   microtasks run while a notice is queued: before each awaited store write,
//!   `plannedLaunch` or `store.load`; after starting an awaited connection
//!   operation (`listTools`, `ensure`, `callTool`, `signIn`, `revoke`, `stop`);
//!   after the `finally` of `readListing`; at the end of `relist` and of
//!   `change`. The notice a continuation leaves queued at its end
//!   ([`McpHub::on_settled`], a connection event, a public method) stays queued:
//!   another continuation of the same microtask drain may add to it. Whatever
//!   is still queued when the caller asks [`McpHub::take_changed`] fires too,
//!   so the caller asks once after every step it drove (a method call, and
//!   the batch of events the connections produced) and tells its listeners
//!   of each notice, in order.
//!   Listeners, `onChanged` and its unsubscribe are the caller's.
//!
//! What has no counterpart: the `AbortSignal` handed to `deps.kit.resolveCommand`
//! (a plain host call is not cancelled), the `AbortSignal` handed to
//! `deps.local` (the connection learns that the app quits from
//! [`LocalConnection::abort_app`]), and `onToolsChanged` / `onStateChanged`
//! unsubscribe handles (see above).

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use jscompat::{
    JsMap, JsObject, JsonValue, js_regex, json_stringify, random_uuid, slice_utf16, trim,
};

use super::address::{AddressCheck, check_server_address};
use super::fingerprint::{
    PlanEnv, PlanShape, launch_review_needed, plan_fingerprint, server_launch_fingerprint,
};
use super::hub_strings::{
    McpLaunchProblemKey, McpSignInPages, mcp_launch_problem_text, mcp_sign_in_pages,
};
use super::listing::{
    McpListing, accept_first_listing, apply_listing, approve_instructions, approve_launch,
    approve_tool, mark_tools_seen, set_tool_permission, tools_awaiting_review,
};
use super::local_launch::{
    LocalLaunchProblem, McpRuntimeId, PlannedLaunch, PlannedLaunchReady, ResolveOptions,
    RuntimeMissing, RuntimeResolution,
};
use super::paste::{PasteResult, PastedServer, parse_mcp_paste};
use super::secrets::secret_view;
use super::store::{
    McpOAuthConfig, McpServerConfig, McpServersFile, McpServersStore, NewMcpServerInput,
    RuntimeAllowance, new_mcp_server_config, normalize_mcp_servers_file,
};
use crate::node_fs::NodeError;
use crate::packages::agent_core::user_mcp_names::{
    MCP_SERVER_NAME_MAX, ToolNameProblem, map_server_tool_names, server_name_problem,
};
use crate::packages::agent_core::user_mcp_result::{
    MCP_RESULT_MAX_CHARS, McpCallAnswer, ShapedMcpResult, shape_mcp_result, shaped_mcp_answer,
};
use crate::packages::ai_provider::jsval::{number, object, prop, text};
use crate::packages::i18n::Lang;
use crate::packages::mcp_sdk::client::net::{
    Body, FetchError, FetchHost, FetchInit, FetchResponse, Headers, Redirect, cancel_body,
};
use crate::shell::mcp_servers_api::{
    McpFailReason, McpPermission, McpServerKind, McpServerStatusFacts, McpServerStatusInfo,
    McpTransport, server_status_of,
};

// ---- what the connections look like ----------------------------------------

/// The number the hub gives one operation of a connection
pub type OpId = u64;

/// The number the hub gives one connection it made through [`McpHubHost`]
pub type ConnId = u64;

/// The answer to a public method that did not finish at once
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Ticket(pub u64);

/// What a public method that awaits answers: the value, or a ticket whose
/// value [`McpHub::take_settled`] hands out later
#[derive(Debug, Clone, PartialEq)]
pub enum Reply<T> {
    Now(T),
    Later(Ticket),
}

/// `RemoteMcpError['reason']` (`RemoteMcpErrorReason`)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteReason {
    Unreachable,
    HttpError,
    Timeout,
    Aborted,
    RefusedRedirect,
    InsecureAddress,
    LoginRequired,
    ServerError,
}

/// `LocalMcpError['reason']` (`LocalMcpErrorReason`)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalReason {
    Disabled,
    ReviewRequired,
    StartFailed,
    RuntimeMissing,
    Unreachable,
    Timeout,
}

/// `LocalLaunchProblem | 'did-not-start'`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalProblem {
    Launch(LocalLaunchProblem),
    DidNotStart,
}

/// What an operation of a connection rejects with, as far as the hub tells the
/// kinds apart (`troubleOf`)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConnError {
    /// a `RemoteMcpError`
    Remote(RemoteReason),
    /// a `LocalMcpError` with its `problem` (`null` is `None`); its message is
    /// never read by the hub
    Local {
        reason: LocalReason,
        problem: Option<LocalProblem>,
    },
    /// an `Error` named `AbortError`
    Abort,
    /// anything else that was thrown
    Other,
}

/// `LocalMcpState`
#[derive(Debug, Clone, PartialEq)]
pub enum LocalState {
    Idle,
    Starting,
    Running,
    ReviewRequired,
    Failed {
        /// `LocalMcpFailure`: only `StartFailed` or `RuntimeMissing`
        reason: McpFailReason,
        problem: LocalProblem,
        /// English, holds no secret; the hub does not read it
        message: String,
    },
}

/// What `RemoteMcpConnection.signIn` resolves with (`McpSignInResult`)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignInResult {
    Ok,
    /// `McpSignInFailure`: `cancelled`, `timeout`, `denied`, `not-supported`,
    /// `client-required`, `network`, `insecure-address`, `key-in-use`
    Failed(String),
}

/// `McpSignInOptions` as the hub gives it; the signal is the operation's
/// [`OpId`] (see the module)
#[derive(Clone)]
pub struct SignInOptions<'h> {
    /// `openExternal: (url) => deps.openExternal(url)`: the system browser;
    /// `false` when it did not open
    pub open_external: Rc<dyn Fn(&str) -> bool + 'h>,
    /// what the browser shows once it is back, in the person's language
    pub pages: McpSignInPages,
}

/// How an operation of a connection ended: what the connection hands to
/// [`McpHub::on_settled`]. The variant is the one of the operation that was
/// started; any other is ignored.
#[derive(Debug, Clone, PartialEq)]
pub enum ConnOutcome {
    /// `listTools` of either kind
    Listed(Result<McpListing, ConnError>),
    /// `RemoteMcpConnection.callTool`: the server's `CallToolResult`, as it came
    RemoteCalled(Result<JsonValue, ConnError>),
    /// `LocalMcpConnection.ensure`
    Ensured(Result<(), ConnError>),
    /// `LocalMcpConnection.callTool`: the result, shaped by the connection
    LocalCalled(Result<ShapedMcpResult, ConnError>),
    /// `signIn`
    SignedIn(SignInResult),
    /// `revoke()`; a rejection is swallowed by the hub, so there is none
    Revoked,
    /// `close()`; a rejection is swallowed by the hub, so there is none
    Closed,
    /// `LocalMcpConnection.stop()`; a rejection is swallowed by the hub
    Stopped,
}

/// The methods hub.ts calls on a `RemoteMcpConnection`. Each `op` is answered
/// once through [`McpHub::on_settled`]; none of these calls back into the hub.
pub trait RemoteConnection<'h> {
    /// `listTools(signal)`: every page of tools/list and the instructions;
    /// answers [`ConnOutcome::Listed`]
    fn list_tools(&mut self, op: OpId);
    /// `callTool(name, args, signal)`: the server's result as it came;
    /// answers [`ConnOutcome::RemoteCalled`]
    fn call_tool(&mut self, op: OpId, name: &str, args: &JsonValue);
    /// `needsSignIn()`: the server asked for a sign-in that has not happened,
    /// or whose refresh was refused
    fn needs_sign_in(&self) -> bool;
    /// `signIn(options)`: the browser sign-in; answers [`ConnOutcome::SignedIn`]
    fn sign_in(&mut self, op: OpId, options: SignInOptions<'h>);
    /// `revoke()`: before the server is deleted, ask for revocation when
    /// offered, then forget the tokens; answers [`ConnOutcome::Revoked`]
    fn revoke(&mut self, op: OpId);
    /// `close()`; answers [`ConnOutcome::Closed`]
    fn close(&mut self, op: OpId);
    /// the `AbortSignal` of `op` aborted
    fn abort(&mut self, op: OpId);
}

/// The methods hub.ts calls on a `LocalMcpConnection`. Each `op` is answered
/// once through [`McpHub::on_settled`]; none of these calls back into the hub.
pub trait LocalConnection {
    /// `status()`
    fn status(&self) -> LocalState;
    /// `stderrTail()`: the last lines the server wrote to standard error
    fn stderr_tail(&self) -> Vec<String>;
    /// `ensure(signal)`: start the server unless it runs; answers
    /// [`ConnOutcome::Ensured`]
    fn ensure(&mut self, op: OpId);
    /// `listTools(signal)`: the tool list and instructions, starting the
    /// server when needed; answers [`ConnOutcome::Listed`]
    fn list_tools(&mut self, op: OpId);
    /// `callTool(name, args, signal)`: only the caller's own abort rejects
    /// ([`ConnError::Abort`]); answers [`ConnOutcome::LocalCalled`]
    fn call_tool(&mut self, op: OpId, name: &str, args: &JsonValue);
    /// `stop()`: end the process; answers [`ConnOutcome::Stopped`]
    fn stop(&mut self, op: OpId);
    /// `retry()`: clear a failed state so the next need tries again
    fn retry(&mut self);
    /// `setServer(server)`: a changed configuration
    fn set_server(&mut self, server: &McpServerConfig);
    /// the `AbortSignal` of `op` aborted
    fn abort(&mut self, op: OpId);
    /// the `appSignal` given to `deps.local` aborted: the app is quitting
    fn abort_app(&mut self);
}

/// The store the hub and the remote connections' OAuth access share
/// (`storeOAuthAccess(store, serverId)` reads and writes it)
pub type SharedStore<'h> = Rc<RefCell<McpServersStore<'h>>>;

/// `McpHubDeps` without the store: what the hub asks of the app
pub trait McpHubHost<'h> {
    /// `deps.remote(server, storeOAuthAccess(store, server.id))`: the
    /// connection gets its `conn` id (for the events it reports) and the
    /// shared store its `McpOAuthAccess` is made over
    fn remote(
        &self,
        conn: ConnId,
        server: &McpServerConfig,
        store: &SharedStore<'h>,
    ) -> Box<dyn RemoteConnection<'h> + 'h>;
    /// `deps.local(server, appSignal)`
    fn local(&self, conn: ConnId, server: &McpServerConfig) -> Box<dyn LocalConnection + 'h>;
    /// `deps.kit.resolveCommand(command, options)`
    fn resolve_command(&self, command: &str, options: &ResolveOptions) -> RuntimeResolution;
    /// `deps.plannedLaunch(server)`
    fn planned_launch(&self, server: &McpServerConfig) -> PlannedLaunch;
    /// `deps.lang()`
    fn lang(&self) -> Lang;
    /// `deps.openExternal(url)`; `false` when the system browser did not open
    fn open_external(&self, url: &str) -> bool;
    /// `deps.openSettings(serverId)`
    fn open_settings(&self, server_id: &str);
    /// `Date.now()`, for the age of a held paste
    fn now_ms(&self) -> f64;
}

/// What a public method that awaits finally answers
#[derive(Debug, Clone, PartialEq)]
pub enum HubAnswer {
    /// `call`: the `McpCallAnswer`
    Call(JsonValue),
    /// `test`
    Test(Result<JsonValue, NodeError>),
    /// `signIn`
    SignIn(JsonValue),
    /// `remove`
    Remove(Result<JsonValue, NodeError>),
    /// `stopAll`
    StopAll,
}

// ---- texts the model reads (English, no secret, no address) -------------------

fn fail_text(reason: McpFailReason) -> &'static str {
    match reason {
        McpFailReason::Unreachable => "the server could not be reached",
        McpFailReason::HttpError => "the server answered with an error; its address may be wrong",
        McpFailReason::RuntimeMissing => "the program it needs is not on this PC",
        McpFailReason::StartFailed => "the server could not be started",
        McpFailReason::RefusedRedirect => {
            "the server sent the request to another address, which this app does not follow"
        }
        McpFailReason::InsecureAddress => "its address may not be reached over plain http",
    }
}

/// a tool name as quoted back to the model: what it sent, shortened
fn quoted(value: &str) -> String {
    json_stringify(&JsonValue::String(slice_utf16(value, 0.0, Some(80.0))))
}

fn refusal(error: String) -> JsonValue {
    object(vec![("ok", JsonValue::Bool(false)), ("error", text(error))])
}

mod words {
    use super::{McpFailReason, StopReason, fail_text, quoted};

    pub fn unknown_server(name: &str) -> String {
        format!(
            "No MCP server named {} is registered in this app.",
            quoted(name)
        )
    }
    pub fn unknown_tool(s: &str, t: &str) -> String {
        format!("{s}: the server has no tool named {}.", quoted(t))
    }
    pub fn disabled(s: &str) -> String {
        format!("{s}: the server is turned off in Settings.")
    }
    pub fn removing(s: &str) -> String {
        format!("{s}: the server is being removed in Settings.")
    }
    pub fn unusable(s: &str, t: &str) -> String {
        format!(
            "{s}: the tool {} cannot be used because of its name.",
            quoted(t)
        )
    }
    pub fn tool_off(s: &str, t: &str) -> String {
        format!("{s}: the tool {} is turned off in Settings.", quoted(t))
    }
    pub fn pending(s: &str, t: &str) -> String {
        format!(
            "{s}: the tool {} changed and waits for the person\u{2019}s review in Settings.",
            quoted(t)
        )
    }
    pub fn command(s: &str) -> String {
        format!("{s}: its command changed and must be approved again in Settings.")
    }
    pub fn login(s: &str) -> String {
        format!("{s}: the server needs the person to sign in again in Settings.")
    }
    pub fn failed(s: &str, reason: McpFailReason) -> String {
        format!("{s}: {}.", fail_text(reason))
    }
    pub fn timeout(s: &str) -> String {
        format!("{s}: the server did not answer in time.")
    }
    pub fn server_error(s: &str) -> String {
        format!("{s}: the server refused the request.")
    }
    pub fn stopped(reason: StopReason, s: &str) -> String {
        match reason {
            StopReason::Cancelled => format!("{s}: the call was stopped."),
            StopReason::Disabled => format!("{s}: the server was turned off during the call."),
            StopReason::Removed => format!("{s}: the server was removed during the call."),
            StopReason::Closing => format!("{s}: the app is closing."),
        }
    }
}

/// `StopReason`: the keys of `TEXT.stopped`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopReason {
    Cancelled,
    Disabled,
    Removed,
    Closing,
}

/// What went wrong with a connection, a listing or a call
#[derive(Debug, Clone, Copy, PartialEq)]
enum Trouble {
    Stopped(StopReason),
    Login,
    Failed(McpFailReason),
    /// this call only; the server status stays
    Call(CallText),
}

/// the `text: (server) => string` of `{ kind: 'call' }`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CallText {
    Timeout,
    ServerError,
    Disabled,
    Command,
    /// `(s) => TEXT.failed(s, 'unreachable')`
    Unreachable,
    UnknownServer,
}

fn trouble_text(server: &str, trouble: Trouble) -> String {
    match trouble {
        Trouble::Stopped(reason) => words::stopped(reason, server),
        Trouble::Login => words::login(server),
        Trouble::Failed(reason) => words::failed(server, reason),
        Trouble::Call(CallText::Timeout) => words::timeout(server),
        Trouble::Call(CallText::ServerError) => words::server_error(server),
        Trouble::Call(CallText::Disabled) => words::disabled(server),
        Trouble::Call(CallText::Command) => words::command(server),
        Trouble::Call(CallText::Unreachable) => words::failed(server, McpFailReason::Unreachable),
        Trouble::Call(CallText::UnknownServer) => words::unknown_server(server),
    }
}

/// `troubleOf(error, signal)`; `aborted` is the reason of `signal` when it
/// is aborted
fn trouble_of(error: Option<&ConnError>, aborted: Option<StopReason>) -> Trouble {
    if let Some(reason) = aborted {
        return Trouble::Stopped(reason);
    }
    match error {
        Some(ConnError::Remote(reason)) => match reason {
            RemoteReason::Aborted => Trouble::Stopped(StopReason::Cancelled),
            RemoteReason::LoginRequired => Trouble::Login,
            RemoteReason::RefusedRedirect => Trouble::Failed(McpFailReason::RefusedRedirect),
            RemoteReason::InsecureAddress => Trouble::Failed(McpFailReason::InsecureAddress),
            RemoteReason::Unreachable => Trouble::Failed(McpFailReason::Unreachable),
            RemoteReason::HttpError => Trouble::Failed(McpFailReason::HttpError),
            RemoteReason::Timeout => Trouble::Call(CallText::Timeout),
            RemoteReason::ServerError => Trouble::Call(CallText::ServerError),
        },
        Some(ConnError::Local { reason, .. }) => match reason {
            LocalReason::Disabled => Trouble::Call(CallText::Disabled),
            LocalReason::ReviewRequired => Trouble::Call(CallText::Command),
            LocalReason::RuntimeMissing => Trouble::Failed(McpFailReason::RuntimeMissing),
            LocalReason::StartFailed => Trouble::Failed(McpFailReason::StartFailed),
            LocalReason::Timeout => Trouble::Call(CallText::Timeout),
            LocalReason::Unreachable => Trouble::Call(CallText::Unreachable),
        },
        Some(ConnError::Abort) => Trouble::Stopped(StopReason::Cancelled),
        Some(ConnError::Other) | None => Trouble::Failed(McpFailReason::Unreachable),
    }
}

fn answer_json(answer: &McpCallAnswer) -> JsonValue {
    match answer {
        McpCallAnswer::Answered { output, is_error } => object(vec![
            ("ok", JsonValue::Bool(true)),
            ("output", text(output.as_str())),
            ("isError", JsonValue::Bool(*is_error)),
        ]),
        McpCallAnswer::Failed { error } => refusal(error.clone()),
    }
}

/// `{ ok: false, problem, detail? }`
fn invalid(problem: &str, detail: Option<&str>) -> JsonValue {
    let mut entries = vec![("ok", JsonValue::Bool(false)), ("problem", text(problem))];
    if let Some(detail) = detail {
        entries.push(("detail", text(detail)));
    }
    object(entries)
}

fn ok_json() -> JsonValue {
    object(vec![("ok", JsonValue::Bool(true))])
}

// ---- per-server state ----------------------------------------------------------

/// `Live`: what the hub holds of one server's connections
struct Live {
    remote: Option<ConnId>,
    /// what the remote connection was made from; a change makes a new one
    remote_key: String,
    local: Option<ConnId>,
    /// connection attempts under way (remote)
    connecting: i64,
    failure: Option<McpFailReason>,
    local_problem: Option<LocalProblem>,
    /// the server asked for a sign-in (remote)
    login_required: bool,
    /// a tool list was read from the live connection in this run (5.7)
    listed: bool,
    /// the sign-in under way: its operation and whether it was aborted
    sign_in: Option<SignInCtl>,
    /// `live.unsubscribe` ran: the connections' events are not followed any more
    unsubscribed: bool,
}

/// The `AbortController` of a sign-in
struct SignInCtl {
    op: OpId,
    conn: ConnId,
    aborted: bool,
}

/// `Call`
struct CallEntry {
    server_id: String,
    caller: String,
    run: u64,
}

/// One running `call(...)`: the controller and the coroutine
struct Run {
    key: String,
    server_id: String,
    server_name: String,
    tool: String,
    input: JsonValue,
    /// the `AbortSignal` of the call's controller, with its reason
    aborted: Option<StopReason>,
    phase: RunPhase,
    ticket: Ticket,
}

enum RunPhase {
    /// `ensureListed`: waiting for the first listing of this run
    Waiting,
    Ensuring {
        op: OpId,
        conn: ConnId,
    },
    LocalCall {
        op: OpId,
        conn: ConnId,
    },
    RemoteCall {
        op: OpId,
        conn: ConnId,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopKind {
    Disabled,
    Removed,
}

impl StopKind {
    fn reason(self) -> StopReason {
        match self {
            StopKind::Disabled => StopReason::Disabled,
            StopKind::Removed => StopReason::Removed,
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Target {
    Local(ConnId),
    Remote(ConnId),
}

/// who gets the end of a `relist`
enum ListingOwner {
    /// `live.listing`: the calls waiting in `ensureListed`
    Shared,
    /// `test`
    Test(Ticket),
    /// `relistQuietly`
    Quiet,
}

/// the parts of a server the coroutines keep across an await
#[derive(Clone)]
struct SrvRef {
    id: String,
    name: String,
    kind: McpServerKind,
}

impl SrvRef {
    fn of(server: &McpServerConfig) -> SrvRef {
        SrvRef {
            id: server.id.clone(),
            name: server.name.clone(),
            kind: server.kind,
        }
    }
}

/// An operation of a connection the hub waits for: where its coroutine goes on
enum Pending {
    /// `relist` at `await readListing(...)`
    Listing {
        id: String,
        kind: McpServerKind,
        first: bool,
        /// the signal handed to it is `app.signal`
        signal_app: bool,
        owner: ListingOwner,
        target: Target,
        /// `live.connecting` was raised for it
        connecting: bool,
    },
    /// `runCall`, local: `await conn.ensure(signal)`
    Ensure {
        run: u64,
        srv: SrvRef,
        conn: ConnId,
    },
    /// `runCall`, local: `await conn.callTool(...)`
    LocalCall {
        run: u64,
        srv: SrvRef,
    },
    /// `runCall`, remote: `await conn.callTool(...)`
    RemoteCall {
        run: u64,
        srv: SrvRef,
        conn: ConnId,
    },
    SignIn {
        id: String,
        ticket: Ticket,
    },
    /// `remove`: `await revoker.revoke().catch(() => {})`
    Revoke {
        ticket: Ticket,
        id: String,
        revoker: ConnId,
    },
    /// `remove`: `await live.local.stop().catch(() => {})`
    RemoveStop {
        ticket: Ticket,
        id: String,
        revoker: Option<ConnId>,
    },
    /// `void conn.close().catch(() => {})`
    Close {
        conn: ConnId,
    },
    /// one of the `stops` of `stopAll`
    StopAllPart {
        ticket: Ticket,
    },
}

const HEADER_NAME_CHARS: &str = "!#$%&'*+.^_`|~-";

/// `HEADER_NAME.test(name)`
fn header_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || HEADER_NAME_CHARS.contains(c))
}

/// `BAD_HEADER_VALUE.test(value)`
fn bad_header_value(value: &str) -> bool {
    value.contains(['\r', '\n', '\0'])
}

/// `BAD_ENV_NAME.test(name)`
fn bad_env_name(name: &str) -> bool {
    name.contains(['=', '\0'])
}

const PASTE_TOKENS_MAX: usize = 8;
const PASTE_TOKEN_TTL_MS: f64 = 60.0 * 60_000.0;

fn same_name(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}

/// `remoteKeyOf(s)`
fn remote_key_of(s: &McpServerConfig) -> String {
    let mut pairs: Vec<(String, String)> = s
        .headers
        .entries()
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.clone()))
        .collect();
    // `Array.prototype.sort()` compares the pairs as the texts `k,v`
    pairs.sort_by(|a, b| {
        format!("{},{}", a.0, a.1)
            .encode_utf16()
            .cmp(format!("{},{}", b.0, b.1).encode_utf16())
    });
    json_stringify(&JsonValue::Array(vec![
        text(s.name.as_str()),
        text(s.url.as_str()),
        text(s.transport.as_str()),
        JsonValue::Array(
            pairs
                .into_iter()
                .map(|(k, v)| JsonValue::Array(vec![text(k), text(v)]))
                .collect(),
        ),
    ]))
}

fn string_list(items: &[String]) -> JsonValue {
    JsonValue::Array(items.iter().map(|s| text(s.as_str())).collect())
}

fn string_of(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(s)) => Some(s),
        _ => None,
    }
}

fn strings_of(value: Option<&JsonValue>) -> Vec<String> {
    match value {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|i| match i {
                JsonValue::String(s) => Some(s.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// a stored server read back from the form the listing functions work on
fn config_of(json: &JsonValue) -> Option<McpServerConfig> {
    normalize_mcp_servers_file(&object(vec![(
        "servers",
        JsonValue::Array(vec![json.clone()]),
    )]))
    .servers
    .into_iter()
    .next()
}

fn problem_key(problem: LocalProblem) -> McpLaunchProblemKey {
    match problem {
        LocalProblem::DidNotStart => McpLaunchProblemKey::DidNotStart,
        LocalProblem::Launch(p) => launch_key(p),
    }
}

fn launch_key(problem: LocalLaunchProblem) -> McpLaunchProblemKey {
    match problem {
        LocalLaunchProblem::EmptyCommand => McpLaunchProblemKey::EmptyCommand,
        LocalLaunchProblem::RuntimeMissing => McpLaunchProblemKey::RuntimeMissing,
        LocalLaunchProblem::NeedsCommandWindow => McpLaunchProblemKey::NeedsCommandWindow,
        LocalLaunchProblem::NotAProgram => McpLaunchProblemKey::NotAProgram,
    }
}

fn plan_shape(plan: &PlannedLaunchReady) -> PlanShape {
    PlanShape {
        command: plan.command.clone(),
        args: plan.args.clone(),
        env: plan
            .env
            .iter()
            .map(|e| PlanEnv {
                name: e.name.clone(),
                origin: e.origin.as_str().to_owned(),
            })
            .collect(),
    }
}

/// `resolveHeld(given, held)`: null keeps the held value; a name with null and
/// nothing held is malformed (`None`)
fn resolve_held(given: &JsObject<JsonValue>, held: &JsObject<String>) -> Option<JsObject<String>> {
    let mut out: JsObject<String> = JsObject::new();
    for (name, value) in given.entries() {
        match value {
            JsonValue::Null => {
                let kept = held.get(name)?;
                out.set(name, kept.clone());
            }
            JsonValue::String(value) => out.set(name, value.clone()),
            // the input was read by hub-input: a text or null
            _ => out.set(name, String::new()),
        }
    }
    Some(out)
}

/// `withKey(headers, key)`
fn with_key(headers: &JsObject<String>, key: &str) -> JsObject<String> {
    let mut out: JsObject<String> = JsObject::new();
    for (k, v) in headers.entries() {
        if k.to_lowercase() != "authorization" {
            out.set(k, v.clone());
        }
    }
    let trimmed = trim(key);
    let bare = match js_regex!(r"^bearer\s+", "i").exec(trimmed) {
        Some(found) => &trimmed[found.end()..],
        None => trimmed,
    };
    if !bare.is_empty() {
        out.set("Authorization", format!("Bearer {bare}"));
    }
    out
}

/// What the hub keeps of one `parsePaste`
struct HeldPaste {
    servers: Vec<PastedServer>,
    at: f64,
}

/// `HubResult`: a method that writes the store; `Err` is the rejection
pub type HubResult<T> = Result<T, NodeError>;

/// One run of the microtask `notify()` queues: what the `onChanged` listeners
/// read when it ran. `view` is `settingsView()` at that moment (the listener of
/// `hub-ipc` sends it to the shell window and broadcasts `mcp-tools:changed`).
#[derive(Debug, Clone, PartialEq)]
pub struct ChangedNotice {
    pub view: JsonValue,
}

/// The hub: state of `createMcpHub(deps)`
pub struct McpHub<'h> {
    host: Rc<dyn McpHubHost<'h> + 'h>,
    store: SharedStore<'h>,
    lives: JsMap<Live>,
    calls: JsMap<CallEntry>,
    runs: HashMap<u64, Run>,
    /// the calls waiting for the first listing of a server, by server id
    listings: JsMap<Vec<u64>>,
    remotes: HashMap<ConnId, Box<dyn RemoteConnection<'h> + 'h>>,
    locals: HashMap<ConnId, Box<dyn LocalConnection + 'h>>,
    /// calls under way on a remote connection (`remoteUse`)
    remote_use: HashMap<ConnId, i64>,
    /// remote connections replaced while calls still ran on them
    retiring: Vec<ConnId>,
    pastes: JsMap<HeldPaste>,
    /// Servers being turned off or removed: set before the store is written, so
    /// a call arriving meanwhile is refused instead of running (13)
    stopping: JsMap<StopKind>,
    app_aborted: bool,
    notify_queued: bool,
    /// the notices that fired and wait for [`McpHub::take_changed`]
    notices: Vec<ChangedNotice>,
    pending: HashMap<OpId, Pending>,
    settled: Vec<(Ticket, HubAnswer)>,
    stop_alls: HashMap<Ticket, usize>,
    next_op: u64,
    next_conn: u64,
    next_ticket: u64,
    next_run: u64,
}

impl<'h> McpHub<'h> {
    /// `createMcpHub(deps)`
    pub fn new(host: Rc<dyn McpHubHost<'h> + 'h>, store: SharedStore<'h>) -> Self {
        McpHub {
            host,
            store,
            lives: JsMap::new(),
            calls: JsMap::new(),
            runs: HashMap::new(),
            listings: JsMap::new(),
            remotes: HashMap::new(),
            locals: HashMap::new(),
            remote_use: HashMap::new(),
            retiring: Vec::new(),
            pastes: JsMap::new(),
            stopping: JsMap::new(),
            app_aborted: false,
            notify_queued: false,
            notices: Vec::new(),
            pending: HashMap::new(),
            settled: Vec::new(),
            stop_alls: HashMap::new(),
            next_op: 1,
            next_conn: 1,
            next_ticket: 1,
            next_run: 1,
        }
    }

    fn new_op(&mut self) -> OpId {
        let op = self.next_op;
        self.next_op += 1;
        op
    }

    fn new_conn(&mut self) -> ConnId {
        let conn = self.next_conn;
        self.next_conn += 1;
        conn
    }

    fn new_ticket(&mut self) -> Ticket {
        let ticket = Ticket(self.next_ticket);
        self.next_ticket += 1;
        ticket
    }

    fn settle(&mut self, ticket: Ticket, answer: HubAnswer) {
        self.settled.push((ticket, answer));
    }

    /// the answer of `ticket` when it already settled
    fn take_ticket(&mut self, ticket: Ticket) -> Option<HubAnswer> {
        let at = self.settled.iter().position(|(t, _)| *t == ticket)?;
        Some(self.settled.remove(at).1)
    }

    /// The answers of the methods that returned [`Reply::Later`], in the order
    /// they settled
    pub fn take_settled(&mut self) -> Vec<(Ticket, HubAnswer)> {
        std::mem::take(&mut self.settled)
    }

    // ---- notifying ----

    /// `notify()`: queue the notice (coalesced with one already queued)
    fn notify(&mut self) {
        self.notify_queued = true;
    }

    /// The microtask `notify()` queued runs: the listeners read the view as it is
    /// now. Called at every point the TypeScript lets microtasks run (an `await`,
    /// the end of an async function, the end of a continuation).
    fn flush(&mut self) {
        if std::mem::take(&mut self.notify_queued) {
            let view = self.settings_view();
            self.notices.push(ChangedNotice { view });
        }
    }

    /// `plannedLaunch(server)` of the deps, awaited
    fn plan_of(&mut self, server: &McpServerConfig) -> PlannedLaunch {
        self.flush();
        self.host.planned_launch(server)
    }

    /// The notices the listeners of `onChanged` heard, in order, after the step the
    /// caller drove (a public method, then the events its connections produced
    /// while it ran): the notice still queued at the end of the step fires too.
    pub fn take_changed(&mut self) -> Vec<ChangedNotice> {
        self.flush();
        std::mem::take(&mut self.notices)
    }

    // ---- store helpers ----

    fn server(&self, id: &str) -> Option<McpServerConfig> {
        self.store.borrow().server(id)
    }

    fn store_update(&mut self, change: &mut dyn FnMut(&mut McpServersFile)) -> HubResult<()> {
        // `await store.update(...)`: a pending notice fires before the write lands
        self.flush();
        self.store
            .borrow_mut()
            .update(&mut |file| {
                change(file);
                None
            })
            .map(|_| ())
    }

    /// `replaceServer(id, change)`
    fn replace_server(
        &mut self,
        id: &str,
        change: &mut dyn FnMut(&McpServerConfig) -> McpServerConfig,
    ) -> HubResult<Option<McpServerConfig>> {
        if self.server(id).is_none() {
            return Ok(None);
        }
        let mut changed: Option<McpServerConfig> = None;
        self.store_update(&mut |file| {
            file.servers = file
                .servers
                .iter()
                .map(|s| {
                    if s.id != id {
                        return s.clone();
                    }
                    let next = change(s);
                    changed = Some(next.clone());
                    next
                })
                .collect();
        })?;
        Ok(changed)
    }

    // ---- connections ----

    /// `liveOf(id)`
    fn live_of(&mut self, id: &str) -> &mut Live {
        if !self.lives.has(id) {
            self.lives.set(
                id,
                Live {
                    remote: None,
                    remote_key: String::new(),
                    local: None,
                    connecting: 0,
                    failure: None,
                    local_problem: None,
                    login_required: false,
                    listed: false,
                    sign_in: None,
                    unsubscribed: false,
                },
            );
        }
        self.lives.get_mut(id).expect("the live was just made")
    }

    /// `closeWhenUnused(conn)`
    fn close_when_unused(&mut self, conn: ConnId) {
        if self.remote_use.get(&conn).copied().unwrap_or(0) > 0 {
            if !self.retiring.contains(&conn) {
                self.retiring.push(conn);
            }
            return;
        }
        self.retiring.retain(|c| *c != conn);
        self.remote_use.remove(&conn);
        let op = self.new_op();
        self.pending.insert(op, Pending::Close { conn });
        if let Some(c) = self.remotes.get_mut(&conn) {
            c.close(op);
        }
    }

    /// `remoteOf(server)`: the remote connection made from the server's current settings
    fn remote_of(&mut self, server: &McpServerConfig) -> ConnId {
        let key = remote_key_of(server);
        let (current, current_key) = {
            let live = self.live_of(&server.id);
            (live.remote, live.remote_key.clone())
        };
        if let Some(conn) = current {
            if current_key == key {
                return conn;
            }
            self.close_when_unused(conn);
        }
        let conn = self.new_conn();
        let made = self.host.remote(conn, server, &self.store);
        self.remotes.insert(conn, made);
        let live = self.live_of(&server.id);
        live.remote = Some(conn);
        live.remote_key = key;
        conn
    }

    /// `localOf(server)`
    fn local_of(&mut self, server: &McpServerConfig) -> ConnId {
        if let Some(conn) = self.live_of(&server.id).local {
            return conn;
        }
        let conn = self.new_conn();
        let made = self.host.local(conn, server);
        self.locals.insert(conn, made);
        self.live_of(&server.id).local = Some(conn);
        conn
    }

    fn abort_op(&mut self, target: Target, op: OpId) {
        match target {
            Target::Local(conn) => {
                if let Some(c) = self.locals.get_mut(&conn) {
                    c.abort(op);
                }
            }
            Target::Remote(conn) => {
                if let Some(c) = self.remotes.get_mut(&conn) {
                    c.abort(op);
                }
            }
        }
    }

    /// after a change in the store: the connections follow the new settings
    fn follow(&mut self, id: &str) {
        let Some(server) = self.server(id) else {
            return;
        };
        let Some(live) = self.lives.get(id) else {
            return;
        };
        let local = live.local;
        let remote = live.remote;
        let key_changed = live.remote_key != remote_key_of(&server);
        if let Some(conn) = local
            && let Some(c) = self.locals.get_mut(&conn)
        {
            c.set_server(&server);
        }
        if let Some(conn) = remote
            && (key_changed || !server.enabled)
        {
            self.close_when_unused(conn);
            if let Some(live) = self.lives.get_mut(id) {
                live.remote = None;
                live.remote_key = String::new();
                live.listed = false;
            }
        }
    }

    // ---- status ----

    fn local_state(&self, id: &str) -> Option<LocalState> {
        let conn = self.lives.get(id)?.local?;
        self.locals.get(&conn).map(|c| c.status())
    }

    /// A local server whose command must be allowed (again): the stored command
    /// changed, or the launcher found that it now resolves to another program
    /// than the one the person allowed (4.5)
    fn command_review_needed(&self, server: &McpServerConfig) -> bool {
        if server.kind != McpServerKind::Local {
            return false;
        }
        launch_review_needed(&server.to_json())
            || matches!(
                self.local_state(&server.id),
                Some(LocalState::ReviewRequired)
            )
    }

    fn status_of(&self, server: &McpServerConfig) -> McpServerStatusInfo {
        let live = self.lives.get(&server.id);
        // approved tools or guide stored from an earlier listing: usable before connecting
        let listed_before = !server.tools.is_empty()
            || server.instructions.is_some()
            || server.pending_instructions.is_some();
        if server.kind == McpServerKind::Local {
            let state = self.local_state(&server.id);
            let failure = match &state {
                Some(LocalState::Failed { reason, .. }) => Some(*reason),
                _ => live.and_then(|l| l.failure),
            };
            return server_status_of(&McpServerStatusFacts {
                enabled: server.enabled,
                command_review_needed: self.command_review_needed(server),
                login_required: false,
                failure,
                connecting: matches!(state, Some(LocalState::Starting)),
                reached: live.is_some_and(|l| l.listed)
                    || (live.is_some() && matches!(state, Some(LocalState::Running))),
                listed_before,
            });
        }
        let needs_sign_in = live
            .and_then(|l| l.remote)
            .and_then(|conn| self.remotes.get(&conn))
            .is_some_and(|c| c.needs_sign_in());
        server_status_of(&McpServerStatusFacts {
            enabled: server.enabled,
            command_review_needed: false,
            login_required: live.is_some_and(|l| l.login_required)
                || (live.is_some() && needs_sign_in),
            failure: live.and_then(|l| l.failure),
            connecting: live.map_or(0, |l| l.connecting) > 0,
            reached: live.is_some_and(|l| l.listed),
            listed_before,
        })
    }

    fn review_of(&self, server: &McpServerConfig) -> Vec<&'static str> {
        let mut review = Vec::new();
        if !tools_awaiting_review(&server.to_json()).is_empty() {
            review.push("tools");
        }
        if server.pending_instructions.is_some() {
            review.push("instructions");
        }
        if self.command_review_needed(server) {
            review.push("command");
        }
        review
    }

    // ---- troubles ----

    /// What a trouble does to the server's status. A local server keeps its own
    /// state; a start that failed is noted here too, so a single failed start
    /// shows as "could not connect" with its reason and standard error (the
    /// launcher itself stops trying only after three).
    fn note(&mut self, srv: &SrvRef, trouble: Trouble, error: Option<&ConnError>) {
        self.live_of(&srv.id);
        if srv.kind != McpServerKind::Remote {
            let Trouble::Failed(reason) = trouble else {
                return;
            };
            let Some(ConnError::Local { problem, .. }) = error else {
                return;
            };
            let live = self.live_of(&srv.id);
            live.failure = Some(reason);
            live.local_problem = *problem;
            self.notify();
            return;
        }
        let live = self.live_of(&srv.id);
        match trouble {
            Trouble::Login => live.login_required = true,
            Trouble::Failed(reason) => live.failure = Some(reason),
            _ => return,
        }
        self.notify();
    }

    // ---- reading the tool list (5.7, 6.2) ----

    /// `relist(id, { first, signal })`: read the tool list from the live connection and
    /// save what it changes. `first`: the person's connection check of a server with
    /// nothing approved yet, which approves what it shows. `signal_app`: the signal is
    /// `app.signal`.
    fn begin_relist(&mut self, id: &str, first: bool, signal_app: bool, owner: ListingOwner) {
        let Some(server) = self.server(id) else {
            self.relist_done(owner, id, Ok(Some(Trouble::Call(CallText::UnknownServer))));
            return;
        };
        self.live_of(id);
        // readListing
        let (op, target, connecting) = if server.kind == McpServerKind::Local {
            let conn = self.local_of(&server);
            let op = self.new_op();
            (op, Target::Local(conn), false)
        } else {
            let conn = self.remote_of(&server);
            self.live_of(id).connecting += 1;
            self.notify();
            let op = self.new_op();
            (op, Target::Remote(conn), true)
        };
        self.pending.insert(
            op,
            Pending::Listing {
                id: id.to_owned(),
                kind: server.kind,
                first,
                signal_app,
                owner,
                target,
                connecting,
            },
        );
        match target {
            Target::Local(conn) => {
                if let Some(c) = self.locals.get_mut(&conn) {
                    c.list_tools(op);
                }
            }
            Target::Remote(conn) => {
                if let Some(c) = self.remotes.get_mut(&conn) {
                    c.list_tools(op);
                }
            }
        }
        // `await conn.listTools(...)` / `await readListing(...)`: the notice of
        // the connecting count (or of what an earlier step left) fires here
        self.flush();
        if signal_app && self.app_aborted {
            self.abort_op(target, op);
        }
    }

    /// what `relist` does with a listing that was read
    fn relist_apply(
        &mut self,
        id: &str,
        kind: McpServerKind,
        first: bool,
        listing: &McpListing,
    ) -> HubResult<Option<Trouble>> {
        // a list that lands while the server is turned off or removed is not applied
        if let Some(halt) = self.stopping.get(id) {
            return Ok(Some(Trouble::Stopped(halt.reason())));
        }
        if !self.server(id).is_some_and(|s| s.enabled) {
            return Ok(Some(Trouble::Stopped(StopReason::Disabled)));
        }
        if let Some(live) = self.lives.get_mut(id) {
            live.failure = None;
            live.local_problem = None;
            if kind == McpServerKind::Remote {
                live.login_required = false;
            }
        }
        self.replace_server(id, &mut |s| {
            let json = s.to_json();
            let next = if first {
                accept_first_listing(&json, listing)
            } else {
                apply_listing(&json, listing).0
            };
            config_of(&next).unwrap_or_else(|| s.clone())
        })?;
        if let Some(live) = self.lives.get_mut(id) {
            live.listed = true;
        }
        self.follow(id);
        self.notify();
        Ok(None)
    }

    /// the end of a `relist`: to whoever started it
    fn relist_done(&mut self, owner: ListingOwner, id: &str, outcome: HubResult<Option<Trouble>>) {
        // the end of `relist`: whoever awaits it continues after the notice
        self.flush();
        match owner {
            ListingOwner::Shared => {
                let waiters = self.listings.delete(id).unwrap_or_default();
                // a rejected listing leaves its waiters to the abort of their calls
                if let Ok(trouble) = outcome {
                    for run in waiters {
                        self.run_listed(run, trouble);
                    }
                }
            }
            ListingOwner::Test(ticket) => self.test_listed(ticket, id, outcome),
            ListingOwner::Quiet => {}
        }
    }

    /// `relistQuietly(id, from)`
    pub fn on_tools_changed(&mut self, conn: ConnId) {
        let owner = self
            .lives
            .iter()
            .find(|(_, live)| {
                !live.unsubscribed && (live.remote == Some(conn) || live.local == Some(conn))
            })
            .map(|(id, _)| id.to_owned());
        if let Some(id) = owner {
            self.begin_relist(&id, false, false, ListingOwner::Quiet);
        }
    }

    /// the `onStateChanged` listener of a local connection
    pub fn on_local_state_changed(&mut self, conn: ConnId, state: &LocalState) {
        let owner = self
            .lives
            .iter()
            .find(|(_, live)| !live.unsubscribed && live.local == Some(conn))
            .map(|(id, _)| id.to_owned());
        let Some(id) = owner else {
            return;
        };
        // a start that worked clears the failure of the one before
        if matches!(state, LocalState::Running)
            && let Some(live) = self.lives.get_mut(&id)
        {
            live.failure = None;
            live.local_problem = None;
        }
        self.notify();
    }

    // ---- the answers of the connections ----

    /// An operation of a connection ended: the continuation of the TypeScript that
    /// awaited it. It leaves its last notice queued: another continuation the
    /// TypeScript would have run in the same microtask drain may add to it, so the
    /// caller asks [`McpHub::take_changed`] once after the batch it delivers (after
    /// each event when they arrive in turns of the event loop).
    pub fn on_settled(&mut self, op: OpId, outcome: ConnOutcome) {
        let Some(pending) = self.pending.remove(&op) else {
            return;
        };
        match (pending, outcome) {
            (
                Pending::Listing {
                    id,
                    kind,
                    first,
                    signal_app,
                    owner,
                    connecting,
                    ..
                },
                ConnOutcome::Listed(result),
            ) => {
                if connecting {
                    if let Some(live) = self.lives.get_mut(&id) {
                        live.connecting -= 1;
                    }
                    // the `finally` of `readListing`: its notice fires before
                    // `relist` goes on with what was read
                    self.notify();
                    self.flush();
                }
                let outcome = match result {
                    Err(error) => {
                        let aborted =
                            (signal_app && self.app_aborted).then_some(StopReason::Closing);
                        let trouble = trouble_of(Some(&error), aborted);
                        let srv = SrvRef {
                            id: id.clone(),
                            name: String::new(),
                            kind,
                        };
                        self.note(&srv, trouble, Some(&error));
                        Ok(Some(trouble))
                    }
                    Ok(listing) => self.relist_apply(&id, kind, first, &listing),
                };
                self.relist_done(owner, &id, outcome);
            }
            (Pending::Ensure { run, srv, conn }, ConnOutcome::Ensured(result)) => match result {
                Ok(()) => self.local_call(run, srv, conn),
                Err(error) => self.run_failed(run, &srv, &error, true),
            },
            (Pending::LocalCall { run, srv }, ConnOutcome::LocalCalled(result)) => match result {
                Ok(shaped) => self.finish_run(run, answer_json(&shaped_mcp_answer(&shaped))),
                Err(error) => self.run_failed(run, &srv, &error, true),
            },
            (Pending::RemoteCall { run, srv, conn }, ConnOutcome::RemoteCalled(result)) => {
                let answer = match result {
                    Ok(result) => {
                        let live = self.live_of(&srv.id);
                        if live.failure.is_some() || live.login_required {
                            live.failure = None;
                            live.login_required = false;
                            self.notify();
                        }
                        answer_json(&shaped_mcp_answer(&shape_mcp_result(
                            Some(&result),
                            MCP_RESULT_MAX_CHARS,
                        )))
                    }
                    Err(error) => {
                        let aborted = self.runs.get(&run).and_then(|r| r.aborted);
                        let trouble = trouble_of(Some(&error), aborted);
                        self.note(&srv, trouble, None);
                        refusal(trouble_text(&srv.name, trouble))
                    }
                };
                self.remote_call_finally(conn);
                self.finish_run(run, answer);
            }
            (Pending::SignIn { id, ticket }, ConnOutcome::SignedIn(result)) => {
                if result == SignInResult::Ok {
                    if let Some(live) = self.lives.get_mut(&id) {
                        live.login_required = false;
                        live.failure = None;
                        live.listed = false;
                    }
                    self.notify();
                }
                if let Some(live) = self.lives.get_mut(&id)
                    && live.sign_in.as_ref().is_some_and(|ctl| ctl.op == op)
                {
                    live.sign_in = None;
                }
                let answer = match result {
                    SignInResult::Ok => ok_json(),
                    SignInResult::Failed(reason) => object(vec![
                        ("ok", JsonValue::Bool(false)),
                        ("reason", text(reason)),
                    ]),
                };
                self.settle(ticket, HubAnswer::SignIn(answer));
            }
            (
                Pending::Revoke {
                    ticket,
                    id,
                    revoker,
                },
                ConnOutcome::Revoked,
            ) => self.remove_after_revoke(ticket, &id, Some(revoker)),
            (
                Pending::RemoveStop {
                    ticket,
                    id,
                    revoker,
                },
                ConnOutcome::Stopped,
            ) => self.finish_remove(ticket, &id, revoker),
            (Pending::Close { conn }, ConnOutcome::Closed) => {
                let used = self.lives.values().any(|l| l.remote == Some(conn))
                    || self.retiring.contains(&conn);
                if !used {
                    self.remotes.remove(&conn);
                }
            }
            (Pending::StopAllPart { ticket }, ConnOutcome::Closed | ConnOutcome::Stopped) => {
                if let Some(left) = self.stop_alls.get_mut(&ticket) {
                    *left -= 1;
                    if *left == 0 {
                        self.stop_alls.remove(&ticket);
                        self.settle(ticket, HubAnswer::StopAll);
                    }
                }
            }
            // an answer of another kind than the operation: nothing to go on with
            _ => {}
        }
    }

    // ---- the AI windows ----

    fn find_by_name(&self, name: &str) -> Option<McpServerConfig> {
        self.store
            .borrow()
            .get()
            .servers
            .into_iter()
            .find(|s| s.name == name)
    }

    /// `editorList()`
    pub fn editor_list(&self) -> Vec<JsonValue> {
        let servers = self.store.borrow().get().servers;
        servers.iter().map(|s| self.editor_view(s)).collect()
    }

    fn editor_view(&self, server: &McpServerConfig) -> JsonValue {
        let status = self.status_of(server);
        let review = self.review_of(server);
        let entries = server.tools.entries();
        let originals: Vec<String> = entries.iter().map(|(name, _)| (*name).to_owned()).collect();
        let names = map_server_tool_names(&server.name, &originals);
        let tools: Vec<JsonValue> = entries
            .iter()
            .enumerate()
            .map(|(index, (name, tool))| {
                let mapped = names.get(index);
                let mut view = vec![
                    ("name", text(*name)),
                    (
                        "exposedName",
                        text(mapped.map_or(String::new(), |m| m.name.clone())),
                    ),
                    // the approved definition only: a pending one never reaches a window
                    ("description", text(tool.definition.description.as_str())),
                    (
                        "inputSchema",
                        JsonValue::Object(tool.definition.input_schema.clone()),
                    ),
                    ("permission", text(tool.permission.as_str())),
                    ("pending", JsonValue::Bool(tool.pending.is_some())),
                ];
                if let Some(problem) = mapped.and_then(|m| m.problem) {
                    view.push(("unusable", text(problem.as_str())));
                }
                let destructive = tool
                    .definition
                    .annotations
                    .as_ref()
                    .and_then(|a| a.get("destructiveHint"))
                    .is_some_and(|h| matches!(h, JsonValue::Bool(true)));
                if destructive {
                    view.push(("destructive", JsonValue::Bool(true)));
                }
                object(view)
            })
            .collect();
        let status_json = status.to_json();
        let mut view = vec![
            ("name", text(server.name.as_str())),
            (
                "status",
                prop(&status_json, "status")
                    .cloned()
                    .unwrap_or(JsonValue::Null),
            ),
        ];
        if let McpServerStatusInfo::Failed(reason) = status {
            view.push(("failReason", text(reason.as_str())));
        }
        if !review.is_empty() {
            view.push((
                "review",
                JsonValue::Array(review.iter().map(|r| text(*r)).collect()),
            ));
        }
        view.push(("newToolCount", number(server.new_tools.len() as f64)));
        view.push((
            "keepResultsInside",
            JsonValue::Bool(server.keep_results_inside),
        ));
        view.push((
            "instructions",
            match &server.instructions {
                Some(i) if server.pending_instructions.is_none() => text(i.text.as_str()),
                _ => JsonValue::Null,
            },
        ));
        view.push(("tools", JsonValue::Array(tools)));
        object(view)
    }

    /// why a call to this server and tool cannot go now, or `None`
    fn refusal_for(
        &self,
        server: &McpServerConfig,
        tool_name: &str,
        listed: bool,
    ) -> Option<String> {
        let status = self.status_of(server);
        match status {
            McpServerStatusInfo::Disabled => return Some(words::disabled(&server.name)),
            McpServerStatusInfo::ReviewRequiredCommand => {
                return Some(words::command(&server.name));
            }
            McpServerStatusInfo::LoginRequired => return Some(words::login(&server.name)),
            McpServerStatusInfo::Failed(reason) => {
                // an unreachable address may be back: the call tries to connect once more and
                // the status stays failed until it works; other failures wait for the person
                let retries_remote = server.kind == McpServerKind::Remote
                    && matches!(
                        reason,
                        McpFailReason::Unreachable | McpFailReason::HttpError
                    );
                // one failed start shows at once, but the launcher tries again until its third
                let retries_local = server.kind == McpServerKind::Local
                    && !matches!(
                        self.local_state(&server.id),
                        Some(LocalState::Failed { .. })
                    );
                if !retries_remote && !retries_local {
                    return Some(words::failed(&server.name, reason));
                }
            }
            _ => {}
        }
        let names: Vec<String> = server
            .tools
            .entries()
            .iter()
            .map(|(n, _)| (*n).to_owned())
            .collect();
        let Some(index) = names.iter().position(|n| n == tool_name) else {
            return listed.then(|| words::unknown_tool(&server.name, tool_name));
        };
        let Some(tool) = server.tools.get(&names[index]) else {
            return listed.then(|| words::unknown_tool(&server.name, tool_name));
        };
        // a tool with no usable AI-facing name is never declared; the main process refuses it too
        if map_server_tool_names(&server.name, &names)
            .get(index)
            .is_some_and(|m| m.problem.is_some())
        {
            return Some(words::unusable(&server.name, tool_name));
        }
        if tool.permission == McpPermission::Off {
            return Some(words::tool_off(&server.name, tool_name));
        }
        if tool.pending.is_some() {
            return Some(words::pending(&server.name, tool_name));
        }
        None
    }

    fn stopping_refusal(&self, server: &McpServerConfig) -> Option<String> {
        let halt = self.stopping.get(&server.id)?;
        Some(match halt {
            StopKind::Removed => words::removing(&server.name),
            StopKind::Disabled => words::disabled(&server.name),
        })
    }

    /// `call(caller, server, tool, input, callId)`; the answer is the result shaped
    /// for the AI (5.5), the same for both kinds of server, or the reason the call
    /// could not be made
    pub fn call(
        &mut self,
        caller: &str,
        server_name: &str,
        tool_name: &str,
        input: &JsonValue,
        call_id: &str,
    ) -> Reply<JsonValue> {
        let Some(found) = self.find_by_name(server_name) else {
            return Reply::Now(refusal(words::unknown_server(server_name)));
        };
        let listed = self.live_of(&found.id).listed;
        let early = self
            .stopping_refusal(&found)
            .or_else(|| self.refusal_for(&found, tool_name, listed));
        if let Some(early) = early {
            return Reply::Now(refusal(early));
        }

        let key = format!("{caller}\u{0}{call_id}");
        if let Some(previous) = self.calls.get(&key).map(|e| e.run) {
            self.abort_run(previous, StopReason::Cancelled);
        }
        let run = self.next_run;
        self.next_run += 1;
        let ticket = self.new_ticket();
        self.runs.insert(
            run,
            Run {
                key: key.clone(),
                server_id: found.id.clone(),
                server_name: found.name.clone(),
                tool: tool_name.to_owned(),
                input: input.clone(),
                aborted: None,
                phase: RunPhase::Waiting,
                ticket,
            },
        );
        self.calls.set(
            key,
            CallEntry {
                server_id: found.id.clone(),
                caller: caller.to_owned(),
                run,
            },
        );
        // the first use after the app started reads the list (5.7) and applies its changes
        self.ensure_listed(run);
        match self.take_ticket(ticket) {
            Some(HubAnswer::Call(answer)) => Reply::Now(answer),
            Some(other) => {
                self.settled.push((ticket, other));
                Reply::Later(ticket)
            }
            None => Reply::Later(ticket),
        }
    }

    /// `ensureListed(id, signal)`: the first listing of this run, shared by calls that arrive together
    fn ensure_listed(&mut self, run: u64) {
        let Some(id) = self.runs.get(&run).map(|r| r.server_id.clone()) else {
            return;
        };
        if self.live_of(&id).listed {
            self.after_listed(run, None);
            return;
        }
        if self.listings.has(&id) {
            if let Some(waiters) = self.listings.get_mut(&id) {
                waiters.push(run);
            }
            return;
        }
        self.listings.set(id.as_str(), vec![run]);
        self.begin_relist(&id, false, false, ListingOwner::Shared);
    }

    /// the listing a waiting call was waiting for ended
    fn run_listed(&mut self, run: u64, trouble: Option<Trouble>) {
        if !matches!(
            self.runs.get(&run).map(|r| &r.phase),
            Some(RunPhase::Waiting)
        ) {
            return;
        }
        self.after_listed(run, trouble);
    }

    /// `call` after `await ensureListed(...)`
    fn after_listed(&mut self, run: u64, trouble: Option<Trouble>) {
        let Some(entry) = self.runs.get(&run) else {
            return;
        };
        let (server_id, name, tool, aborted) = (
            entry.server_id.clone(),
            entry.server_name.clone(),
            entry.tool.clone(),
            entry.aborted,
        );
        if let Some(trouble) = trouble {
            self.finish_run(run, refusal(trouble_text(&name, trouble)));
            return;
        }
        if let Some(reason) = aborted {
            self.finish_run(
                run,
                refusal(trouble_text(&name, trouble_of(None, Some(reason)))),
            );
            return;
        }
        let Some(server) = self.server(&server_id) else {
            self.finish_run(run, refusal(words::stopped(StopReason::Removed, &name)));
            return;
        };
        let late = self
            .stopping_refusal(&server)
            .or_else(|| self.refusal_for(&server, &tool, true));
        if let Some(late) = late {
            self.finish_run(run, refusal(late));
            return;
        }
        self.run_call(run, &server);
    }

    /// `runCall(server, tool, input, signal)`: either kind answers the result shaped for the AI
    /// here in the main process (5.5)
    fn run_call(&mut self, run: u64, server: &McpServerConfig) {
        let srv = SrvRef::of(server);
        if server.kind == McpServerKind::Local {
            let conn = self.local_of(server);
            let op = self.new_op();
            self.pending.insert(op, Pending::Ensure { run, srv, conn });
            if let Some(r) = self.runs.get_mut(&run) {
                r.phase = RunPhase::Ensuring { op, conn };
            }
            if let Some(c) = self.locals.get_mut(&conn) {
                c.ensure(op);
            }
            // `await conn.ensure(...)`
            self.flush();
            return;
        }
        let conn = self.remote_of(server);
        *self.remote_use.entry(conn).or_insert(0) += 1;
        let op = self.new_op();
        let (tool, input) = match self.runs.get(&run) {
            Some(r) => (r.tool.clone(), r.input.clone()),
            None => return,
        };
        self.pending
            .insert(op, Pending::RemoteCall { run, srv, conn });
        if let Some(r) = self.runs.get_mut(&run) {
            r.phase = RunPhase::RemoteCall { op, conn };
        }
        if let Some(c) = self.remotes.get_mut(&conn) {
            c.call_tool(op, &tool, &input);
        }
        // `await conn.callTool(...)`
        self.flush();
    }

    /// local: `await conn.callTool(tool, input, signal)` after `ensure`
    fn local_call(&mut self, run: u64, srv: SrvRef, conn: ConnId) {
        let (tool, input) = match self.runs.get(&run) {
            Some(r) => (r.tool.clone(), r.input.clone()),
            None => return,
        };
        let op = self.new_op();
        self.pending.insert(op, Pending::LocalCall { run, srv });
        let aborted = match self.runs.get_mut(&run) {
            Some(r) => {
                r.phase = RunPhase::LocalCall { op, conn };
                r.aborted.is_some()
            }
            None => false,
        };
        if let Some(c) = self.locals.get_mut(&conn) {
            c.call_tool(op, &tool, &input);
        }
        // `await conn.callTool(...)`
        self.flush();
        if aborted {
            self.abort_op(Target::Local(conn), op);
        }
    }

    /// the catch of the local `runCall`
    fn run_failed(&mut self, run: u64, srv: &SrvRef, error: &ConnError, local: bool) {
        let aborted = self.runs.get(&run).and_then(|r| r.aborted);
        let trouble = trouble_of(Some(error), aborted);
        self.note(srv, trouble, if local { Some(error) } else { None });
        self.finish_run(run, refusal(trouble_text(&srv.name, trouble)));
    }

    /// the `finally` of the remote `runCall`
    fn remote_call_finally(&mut self, conn: ConnId) {
        let left = self.remote_use.get(&conn).copied().unwrap_or(1) - 1;
        self.remote_use.insert(conn, left);
        if left <= 0 && self.retiring.contains(&conn) {
            self.close_when_unused(conn);
        }
    }

    /// the end of `call`: the `finally` and the answer
    fn finish_run(&mut self, run: u64, answer: JsonValue) {
        let Some(entry) = self.runs.remove(&run) else {
            return;
        };
        if self.calls.get(&entry.key).map(|e| e.run) == Some(run) {
            self.calls.delete(&entry.key);
        }
        self.settle(entry.ticket, HubAnswer::Call(answer));
    }

    /// `controller.abort(reason)` of a call
    fn abort_run(&mut self, run: u64, reason: StopReason) {
        let Some(entry) = self.runs.get_mut(&run) else {
            return;
        };
        if entry.aborted.is_some() {
            return;
        }
        entry.aborted = Some(reason);
        match entry.phase {
            RunPhase::Waiting => {
                let (name, id) = (entry.server_name.clone(), entry.server_id.clone());
                if let Some(waiters) = self.listings.get_mut(&id) {
                    waiters.retain(|w| *w != run);
                }
                self.finish_run(run, refusal(words::stopped(reason, &name)));
            }
            RunPhase::Ensuring { op, conn } | RunPhase::LocalCall { op, conn } => {
                self.abort_op(Target::Local(conn), op)
            }
            RunPhase::RemoteCall { op, conn } => self.abort_op(Target::Remote(conn), op),
        }
    }

    /// `stopCalls(serverId, reason)`
    fn stop_calls(&mut self, server_id: Option<&str>, reason: StopReason) {
        let entries: Vec<(String, u64)> = self
            .calls
            .iter()
            .filter(|(_, e)| server_id.is_none_or(|id| e.server_id == id))
            .map(|(k, e)| (k.to_owned(), e.run))
            .collect();
        for (key, run) in entries {
            self.abort_run(run, reason);
            self.calls.delete(&key);
        }
    }

    /// `cancel(caller, callId)`
    pub fn cancel(&mut self, caller: &str, call_id: &str) {
        let key = format!("{caller}\u{0}{call_id}");
        let Some(run) = self.calls.get(&key).map(|e| e.run) else {
            return;
        };
        self.abort_run(run, StopReason::Cancelled);
        self.calls.delete(&key);
    }

    /// `cancelCaller(caller)`: the caller's window went away: stop every call of it
    pub fn cancel_caller(&mut self, caller: &str) {
        let entries: Vec<(String, u64)> = self
            .calls
            .iter()
            .filter(|(_, e)| e.caller == caller)
            .map(|(k, e)| (k.to_owned(), e.run))
            .collect();
        for (key, run) in entries {
            self.abort_run(run, StopReason::Cancelled);
            self.calls.delete(&key);
        }
    }

    /// `retryByName(name)`: `{ ok }`
    pub fn retry_by_name(&mut self, name: &str) -> bool {
        let Some(server) = self.find_by_name(name) else {
            return false;
        };
        let state = self.local_state(&server.id);
        self.retry(&server.id);
        // a runtime is downloaded only after the person agrees, and that question is Settings'
        if let Some(LocalState::Failed { reason, .. }) = state
            && reason == McpFailReason::RuntimeMissing
        {
            self.host.open_settings(&server.id);
        }
        true
    }

    /// `openSettingsByName(name)`: `{ ok }`
    pub fn open_settings_by_name(&mut self, name: &str) -> bool {
        let Some(server) = self.find_by_name(name) else {
            return false;
        };
        self.host.open_settings(&server.id);
        true
    }

    // ---- Settings ----

    fn tool_names_of(&self, server: &McpServerConfig) -> JsonValue {
        let names: Vec<String> = server
            .tools
            .entries()
            .iter()
            .map(|(n, _)| (*n).to_owned())
            .collect();
        let mut out: JsObject<JsonValue> = JsObject::new();
        for e in map_server_tool_names(&server.name, &names) {
            out.set(
                e.original.as_str(),
                object(vec![
                    ("exposedName", text(e.name.as_str())),
                    ("changed", JsonValue::Bool(e.changed)),
                    (
                        "problem",
                        e.problem
                            .map_or(JsonValue::Null, |p: ToolNameProblem| text(p.as_str())),
                    ),
                ]),
            );
        }
        JsonValue::Object(out)
    }

    /// `failureOf(server)`: the reason view of a failed local server
    fn failure_of(&self, server: &McpServerConfig) -> JsonValue {
        if server.kind != McpServerKind::Local {
            return JsonValue::Null;
        }
        let live = self.lives.get(&server.id);
        let state = self.local_state(&server.id);
        let failed: Option<(McpFailReason, LocalProblem)> = match &state {
            Some(LocalState::Failed {
                reason, problem, ..
            }) => Some((*reason, *problem)),
            _ => live.and_then(|l| {
                l.failure
                    .map(|f| (f, l.local_problem.unwrap_or(LocalProblem::DidNotStart)))
            }),
        };
        let Some((reason, problem)) = failed else {
            return JsonValue::Null;
        };
        let key = if problem == LocalProblem::Launch(LocalLaunchProblem::RuntimeMissing)
            || reason == McpFailReason::RuntimeMissing
        {
            McpLaunchProblemKey::RuntimeMissing
        } else {
            problem_key(problem)
        };
        let tail = live
            .and_then(|l| l.local)
            .and_then(|conn| self.locals.get(&conn))
            .map_or(Vec::new(), |c| c.stderr_tail());
        object(vec![
            ("text", text(mcp_launch_problem_text(self.host.lang(), key))),
            ("stderrTail", string_list(&tail)),
        ])
    }

    /// `settingsView()`
    pub fn settings_view(&self) -> JsonValue {
        let base = self.store.borrow().view();
        let views = match prop(&base, "servers") {
            Some(JsonValue::Array(views)) => views.clone(),
            _ => Vec::new(),
        };
        let servers: Vec<JsonValue> = views
            .iter()
            .map(|view| {
                let mut out = match view {
                    JsonValue::Object(o) => o.clone(),
                    _ => JsObject::new(),
                };
                let id = string_of(prop(view, "id")).unwrap_or_default().to_owned();
                match self.server(&id) {
                    None => {
                        out.set("status", McpServerStatusInfo::Disabled.to_json());
                        out.set("review", JsonValue::Array(Vec::new()));
                        out.set("toolNames", JsonValue::Object(JsObject::new()));
                        out.set("failure", JsonValue::Null);
                    }
                    Some(server) => {
                        out.set(
                            "launchReviewNeeded",
                            JsonValue::Bool(self.command_review_needed(&server)),
                        );
                        out.set("status", self.status_of(&server).to_json());
                        out.set(
                            "review",
                            JsonValue::Array(
                                self.review_of(&server).iter().map(|r| text(*r)).collect(),
                            ),
                        );
                        out.set("toolNames", self.tool_names_of(&server));
                        out.set("failure", self.failure_of(&server));
                    }
                }
                JsonValue::Object(out)
            })
            .collect();
        object(vec![
            (
                "sealing",
                prop(&base, "sealing").cloned().unwrap_or(JsonValue::Null),
            ),
            (
                "runtimes",
                prop(&base, "runtimes").cloned().unwrap_or(JsonValue::Null),
            ),
            ("servers", JsonValue::Array(servers)),
        ])
    }

    /// `checkName(name, exceptId)`
    fn check_name(&self, name: &str, except_id: Option<&str>) -> Option<JsonValue> {
        if let Some(problem) = server_name_problem(name, MCP_SERVER_NAME_MAX) {
            return Some(invalid("name", Some(problem.as_str())));
        }
        let taken = self
            .store
            .borrow()
            .get()
            .servers
            .iter()
            .any(|s| Some(s.id.as_str()) != except_id && same_name(&s.name, name));
        taken.then(|| invalid("name-taken", None))
    }

    /// `checkRemote(url, allowPlainHttp)`
    fn check_remote(&self, url: &str, allow_plain_http: Option<bool>) -> Option<JsonValue> {
        match check_server_address(url) {
            AddressCheck::Refused(problem) => Some(invalid("address", Some(problem.as_str()))),
            AddressCheck::Allowed { plain, .. } => (plain && allow_plain_http != Some(true))
                .then(|| invalid("plain-http-unconfirmed", None)),
        }
    }

    /// `checkHeaders(headers)`
    fn check_headers(&self, headers: &JsObject<String>) -> Option<JsonValue> {
        for (name, value) in headers.entries() {
            if !header_name_ok(name) || bad_header_value(value) {
                return Some(invalid("invalid", Some("headers")));
            }
        }
        None
    }

    /// `checkLaunch(command, args, env)`
    fn check_launch(
        &self,
        command: &str,
        args: &[String],
        env: &JsObject<String>,
    ) -> Option<JsonValue> {
        if trim(command).is_empty() || command.contains('\0') {
            return Some(invalid("invalid", Some("command")));
        }
        if args.iter().any(|a| a.contains('\0')) {
            return Some(invalid("invalid", Some("args")));
        }
        for (name, value) in env.entries() {
            if name.is_empty() || bad_env_name(name) || value.contains('\0') {
                return Some(invalid("invalid", Some("env")));
            }
        }
        None
    }

    /// `takePaste(ref)`
    fn take_paste(&mut self, token: &str, index: f64) -> Option<PastedServer> {
        let now = self.host.now_ms();
        let expired: Vec<String> = self
            .pastes
            .iter()
            .filter(|(_, entry)| now - entry.at > PASTE_TOKEN_TTL_MS)
            .map(|(token, _)| token.to_owned())
            .collect();
        for token in expired {
            self.pastes.delete(&token);
        }
        let entry = self.pastes.get(token)?;
        if index < 0.0 || index.fract() != 0.0 {
            return None;
        }
        entry.servers.get(index as usize).cloned()
    }

    /// `rememberPaste(servers)`
    fn remember_paste(&mut self, servers: Vec<PastedServer>) -> String {
        let token = random_uuid();
        let at = self.host.now_ms();
        self.pastes.set(token.as_str(), HeldPaste { servers, at });
        while self.pastes.len() > PASTE_TOKENS_MAX {
            let Some(oldest) = self.pastes.keys().next().map(str::to_owned) else {
                break;
            };
            self.pastes.delete(&oldest);
        }
        token
    }

    /// `parsePaste(text)`: `McpPasteView`
    pub fn parse_paste(&mut self, pasted: &str) -> JsonValue {
        let taken: Vec<String> = self
            .store
            .borrow()
            .get()
            .servers
            .iter()
            .map(|s| s.name.clone())
            .collect();
        let result = parse_mcp_paste(pasted, &taken);
        let (format, servers, ignored) = match result {
            PasteResult::Ok {
                format,
                servers,
                ignored,
            } => (format, servers, ignored),
            failed => return failed.to_json(),
        };
        let views = |record: &JsObject<String>| {
            let mut out: JsObject<JsonValue> = JsObject::new();
            for (k, v) in record.entries() {
                out.set(k, secret_view(v, false).to_json());
            }
            JsonValue::Object(out)
        };
        let shown: Vec<JsonValue> = servers
            .iter()
            .map(|s| {
                let strings = |record: &JsObject<String>| {
                    let mut out: JsObject<JsonValue> = JsObject::new();
                    for (k, v) in record.entries() {
                        out.set(k, text(v.as_str()));
                    }
                    JsonValue::Object(out)
                };
                object(vec![
                    ("pastedName", text(s.pasted_name.as_str())),
                    ("name", text(s.name.as_str())),
                    ("nameChanged", JsonValue::Bool(s.name_changed)),
                    ("kind", text(s.kind.as_str())),
                    ("url", text(s.url.as_str())),
                    ("transport", text(s.transport.as_str())),
                    ("headers", views(&s.headers)),
                    ("command", text(s.command.as_str())),
                    ("args", string_list(&s.args)),
                    ("env", views(&s.env)),
                    ("keyNeeded", JsonValue::Bool(s.key_needed)),
                    (
                        "keyEnvVar",
                        s.key_env_var.as_deref().map_or(JsonValue::Null, text),
                    ),
                    ("headerVars", strings(&s.header_vars)),
                    ("envVars", strings(&s.env_vars)),
                    (
                        "typeIgnored",
                        s.type_ignored.as_deref().map_or(JsonValue::Null, text),
                    ),
                    ("ignored", string_list(&s.ignored)),
                    (
                        "problem",
                        s.problem.map_or(JsonValue::Null, |p| text(p.as_str())),
                    ),
                ])
            })
            .collect();
        let token = self.remember_paste(servers);
        object(vec![
            ("ok", JsonValue::Bool(true)),
            ("token", text(token)),
            ("format", text(format.as_str())),
            ("ignored", string_list(&ignored)),
            ("servers", JsonValue::Array(shown)),
        ])
    }

    /// `add(input)`: `McpSettingsResult<{ id }>`
    pub fn add(&mut self, input: &JsonValue) -> HubResult<JsonValue> {
        let name = string_of(prop(input, "name"))
            .unwrap_or_default()
            .to_owned();
        if let Some(problem) = self.check_name(&name, None) {
            return Ok(problem);
        }
        let mut pasted: Option<PastedServer> = None;
        if let Some(reference) = prop(input, "paste").filter(|p| p.truthy()) {
            let token = string_of(prop(reference, "token")).unwrap_or_default();
            let index = match prop(reference, "index") {
                Some(JsonValue::Number(n)) => *n,
                _ => f64::NAN,
            };
            pasted = self.take_paste(token, index);
            if pasted.is_none() {
                return Ok(invalid("paste-expired", None));
            }
        }
        let held_headers = pasted
            .as_ref()
            .map(|p| p.headers.clone())
            .unwrap_or_default();
        let held_env = pasted.as_ref().map(|p| p.env.clone()).unwrap_or_default();
        if string_of(prop(input, "kind")) == Some("remote") {
            let url = string_of(prop(input, "url")).unwrap_or_default().to_owned();
            let allow = match prop(input, "allowPlainHttp") {
                Some(JsonValue::Bool(b)) => Some(*b),
                _ => None,
            };
            if let Some(problem) = self.check_remote(&url, allow) {
                return Ok(problem);
            }
            let mut headers = match prop(input, "headers") {
                Some(JsonValue::Object(given)) => match resolve_held(given, &held_headers) {
                    Some(resolved) => resolved,
                    None => return Ok(invalid("invalid", Some("headers"))),
                },
                _ => held_headers.clone(),
            };
            if let Some(key) = string_of(prop(input, "key")) {
                headers = with_key(&headers, key);
            }
            if let Some(problem) = self.check_headers(&headers) {
                return Ok(problem);
            }
            let oauth = match prop(input, "oauthClient") {
                Some(client @ JsonValue::Object(_)) => Some(McpOAuthConfig {
                    client_id: string_of(prop(client, "clientId"))
                        .unwrap_or_default()
                        .to_owned(),
                    client_secret: string_of(prop(client, "clientSecret"))
                        .unwrap_or_default()
                        .to_owned(),
                    tokens: String::new(),
                }),
                _ => None,
            };
            let transport = if string_of(prop(input, "transport")) == Some("sse") {
                McpTransport::Sse
            } else {
                McpTransport::Auto
            };
            let server = new_mcp_server_config(&NewMcpServerInput {
                name,
                kind: Some(McpServerKind::Remote),
                url: Some(url),
                transport: Some(transport),
                headers: Some(headers),
                oauth,
                ..NewMcpServerInput::default()
            });
            self.store_update(&mut |file| file.servers.push(server.clone()))?;
            self.notify();
            return Ok(object(vec![
                ("ok", JsonValue::Bool(true)),
                ("id", text(server.id.as_str())),
            ]));
        }
        let command = string_of(prop(input, "command"))
            .unwrap_or_default()
            .to_owned();
        let args = strings_of(prop(input, "args"));
        let env = match prop(input, "env") {
            Some(JsonValue::Object(given)) => resolve_held(given, &held_env),
            _ => Some(held_env.clone()),
        };
        let Some(env) = env else {
            return Ok(invalid("invalid", Some("env")));
        };
        if let Some(problem) = self.check_launch(&command, &args, &env) {
            return Ok(problem);
        }
        let server = new_mcp_server_config(&NewMcpServerInput {
            name,
            kind: Some(McpServerKind::Local),
            command: Some(command),
            args: Some(args),
            env: Some(env),
            ..NewMcpServerInput::default()
        });
        self.store_update(&mut |file| file.servers.push(server.clone()))?;
        self.notify();
        Ok(object(vec![
            ("ok", JsonValue::Bool(true)),
            ("id", text(server.id.as_str())),
        ]))
    }

    /// `edit(id, patch)`
    pub fn edit(&mut self, id: &str, patch: &JsonValue) -> HubResult<JsonValue> {
        let Some(current) = self.server(id) else {
            return Ok(invalid("not-found", None));
        };
        let mut next = current.clone();
        if let Some(name) = string_of(prop(patch, "name"))
            && name != current.name
        {
            if let Some(problem) = self.check_name(name, Some(id)) {
                return Ok(problem);
            }
            next.name = name.to_owned();
        }
        if current.kind == McpServerKind::Remote {
            if let Some(url) = string_of(prop(patch, "url"))
                && url != current.url
            {
                let allow = match prop(patch, "allowPlainHttp") {
                    Some(JsonValue::Bool(b)) => Some(*b),
                    _ => None,
                };
                if let Some(problem) = self.check_remote(url, allow) {
                    return Ok(problem);
                }
                next.url = url.to_owned();
                // a sign-in belongs to the address it was made for
                if let Some(oauth) = next.oauth.as_mut() {
                    oauth.tokens = String::new();
                }
            }
            if let Some(transport) = string_of(prop(patch, "transport")) {
                next.transport = if transport == "sse" {
                    McpTransport::Sse
                } else {
                    McpTransport::Auto
                };
            }
            let mut headers = current.headers.clone();
            if let Some(JsonValue::Object(given)) = prop(patch, "headers") {
                let Some(resolved) = resolve_held(given, &current.headers) else {
                    return Ok(invalid("invalid", Some("headers")));
                };
                headers = resolved;
            }
            if let Some(key) = string_of(prop(patch, "key")) {
                headers = with_key(&headers, key);
            }
            if let Some(problem) = self.check_headers(&headers) {
                return Ok(problem);
            }
            next.headers = headers;
            match prop(patch, "oauthClient") {
                Some(JsonValue::Null) => next.oauth = None,
                Some(client @ JsonValue::Object(_)) => {
                    let secret = string_of(prop(client, "clientSecret"))
                        .map(str::to_owned)
                        .or_else(|| current.oauth.as_ref().map(|o| o.client_secret.clone()))
                        .unwrap_or_default();
                    next.oauth = Some(McpOAuthConfig {
                        client_id: string_of(prop(client, "clientId"))
                            .unwrap_or_default()
                            .to_owned(),
                        client_secret: secret,
                        tokens: next
                            .oauth
                            .as_ref()
                            .map(|o| o.tokens.clone())
                            .unwrap_or_default(),
                    });
                }
                _ => {}
            }
        } else {
            if let Some(command) = string_of(prop(patch, "command")) {
                next.command = command.to_owned();
            }
            if let Some(JsonValue::Array(_)) = prop(patch, "args") {
                next.args = strings_of(prop(patch, "args"));
            }
            if let Some(JsonValue::Object(given)) = prop(patch, "env") {
                let Some(resolved) = resolve_held(given, &current.env) else {
                    return Ok(invalid("invalid", Some("env")));
                };
                next.env = resolved;
            }
            if let Some(problem) = self.check_launch(&next.command, &next.args, &next.env) {
                return Ok(problem);
            }
        }
        self.replace_server(id, &mut |_| next.clone())?;
        if (next.url != current.url || next.command != current.command)
            && let Some(live) = self.lives.get_mut(id)
        {
            live.listed = false;
            live.failure = None;
            live.local_problem = None;
        }
        self.follow(id);
        self.notify();
        Ok(ok_json())
    }

    /// `abort()` of a sign-in controller
    fn abort_sign_in(&mut self, id: &str) {
        let Some(live) = self.lives.get_mut(id) else {
            return;
        };
        let Some(ctl) = live.sign_in.as_mut() else {
            return;
        };
        if ctl.aborted {
            return;
        }
        ctl.aborted = true;
        let (conn, op) = (ctl.conn, ctl.op);
        self.abort_op(Target::Remote(conn), op);
    }

    /// `cancelSignIn(id)`
    pub fn cancel_sign_in(&mut self, id: &str) {
        self.abort_sign_in(id);
    }

    /// `remove(id)`
    pub fn remove(&mut self, id: &str) -> Reply<HubResult<JsonValue>> {
        let Some(server) = self.server(id) else {
            return Reply::Now(Ok(invalid("not-found", None)));
        };
        // before any wait: no call may start against a server on its way out (13)
        self.stopping.set(id, StopKind::Removed);
        self.stop_calls(Some(id), StopReason::Removed);
        self.abort_sign_in(id);
        let ticket = self.new_ticket();
        // 4.9: ask the server to revoke the sign-in before its tokens are forgotten
        if server.kind == McpServerKind::Remote {
            let held = self.lives.get(id).and_then(|l| l.remote);
            let conn = match held {
                Some(conn) => conn,
                None => {
                    let conn = self.new_conn();
                    let made = self.host.remote(conn, &server, &self.store);
                    self.remotes.insert(conn, made);
                    conn
                }
            };
            let op = self.new_op();
            self.pending.insert(
                op,
                Pending::Revoke {
                    ticket,
                    id: id.to_owned(),
                    revoker: conn,
                },
            );
            if let Some(c) = self.remotes.get_mut(&conn) {
                c.revoke(op);
            }
            // `await revoker.revoke()`
            self.flush();
            return Reply::Later(ticket);
        }
        self.remove_after_revoke(ticket, id, None);
        match self.take_ticket(ticket) {
            Some(HubAnswer::Remove(answer)) => Reply::Now(answer),
            Some(other) => {
                self.settled.push((ticket, other));
                Reply::Later(ticket)
            }
            None => Reply::Later(ticket),
        }
    }

    /// `remove` after the revocation: forget the server, then its connections
    fn remove_after_revoke(&mut self, ticket: Ticket, id: &str, revoker: Option<ConnId>) {
        // `await store.removeServer(id)`: a pending notice fires before the write lands
        self.flush();
        let removed = self.store.borrow_mut().remove_server(id);
        self.stop_calls(Some(id), StopReason::Removed);
        self.stopping.delete(id);
        if let Err(error) = removed {
            self.settle(ticket, HubAnswer::Remove(Err(error)));
            return;
        }
        let local = match self.lives.get_mut(id) {
            Some(live) => {
                live.unsubscribed = true;
                live.local
            }
            None => None,
        };
        if let Some(conn) = local {
            let op = self.new_op();
            self.pending.insert(
                op,
                Pending::RemoveStop {
                    ticket,
                    id: id.to_owned(),
                    revoker,
                },
            );
            if let Some(c) = self.locals.get_mut(&conn) {
                c.stop(op);
            }
            // `await live.local.stop()`
            self.flush();
            return;
        }
        self.finish_remove(ticket, id, revoker);
    }

    fn finish_remove(&mut self, ticket: Ticket, id: &str, revoker: Option<ConnId>) {
        let live_remote = self.lives.get(id).and_then(|l| l.remote);
        let live_local = self.lives.get(id).and_then(|l| l.local);
        if self.lives.has(id) {
            if let Some(conn) = live_remote {
                self.close_when_unused(conn);
            }
            if let Some(conn) = live_local {
                self.locals.remove(&conn);
            }
            self.lives.delete(id);
        }
        if let Some(conn) = revoker
            && Some(conn) != live_remote
        {
            let op = self.new_op();
            self.pending.insert(op, Pending::Close { conn });
            if let Some(c) = self.remotes.get_mut(&conn) {
                c.close(op);
            }
        }
        self.notify();
        self.settle(ticket, HubAnswer::Remove(Ok(ok_json())));
    }

    /// `runtimeQuestion(command, missing)`
    fn runtime_question(
        &self,
        command: &str,
        missing: Option<&RuntimeMissing>,
    ) -> Option<JsonValue> {
        let missing = missing?;
        if missing.detail != super::local_launch::RuntimeMissingDetail::DownloadNeeded
            || missing.downloads.is_empty()
        {
            return None;
        }
        let runtimes = self.store.borrow().get().runtimes;
        let allowed = missing
            .downloads
            .iter()
            .all(|d| runtimes.get(d.runtime.as_str()).is_some_and(|r| r.allowed));
        let runtime: McpRuntimeId = missing
            .runtime
            .or_else(|| missing.downloads.first().map(|d| d.runtime))
            .unwrap_or(McpRuntimeId::Node);
        let total: f64 = missing.downloads.iter().map(|d| d.bytes).sum();
        Some(object(vec![
            ("command", text(command)),
            ("runtime", text(runtime.as_str())),
            (
                "downloads",
                JsonValue::Array(
                    missing
                        .downloads
                        .iter()
                        .map(|d| {
                            object(vec![
                                ("runtime", text(d.runtime.as_str())),
                                ("version", text(d.version.as_str())),
                                ("bytes", number(d.bytes)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("totalBytes", number(total)),
            ("allowed", JsonValue::Bool(allowed)),
        ]))
    }

    /// `launchView(server, plan)`
    fn launch_view(&self, server: &McpServerConfig, plan: &PlannedLaunch) -> JsonValue {
        match plan {
            PlannedLaunch::Ready(ready) => object(vec![
                ("ok", JsonValue::Bool(true)),
                ("fingerprint", text(plan_fingerprint(&plan_shape(ready)))),
                ("command", text(ready.command.as_str())),
                ("args", string_list(&ready.args)),
                ("addedArgs", string_list(&ready.added_args)),
                (
                    "env",
                    JsonValue::Array(
                        ready
                            .env
                            .iter()
                            .map(|e| {
                                object(vec![
                                    ("name", text(e.name.as_str())),
                                    ("origin", text(e.origin.as_str())),
                                ])
                            })
                            .collect(),
                    ),
                ),
                ("droppedEnv", string_list(&ready.dropped_env)),
                ("source", text(ready.source.as_str())),
                (
                    "runtime",
                    ready.runtime.map_or(JsonValue::Null, |r| text(r.as_str())),
                ),
            ]),
            PlannedLaunch::Blocked(blocked) => object(vec![
                ("ok", JsonValue::Bool(false)),
                ("problem", text(blocked.problem.as_str())),
                (
                    "text",
                    text(mcp_launch_problem_text(
                        self.host.lang(),
                        launch_key(blocked.problem),
                    )),
                ),
                (
                    "question",
                    if blocked.problem == LocalLaunchProblem::RuntimeMissing {
                        self.runtime_question(&server.command, blocked.runtime.as_ref())
                            .unwrap_or(JsonValue::Null)
                    } else {
                        JsonValue::Null
                    },
                ),
            ]),
        }
    }

    /// `plannedLaunch(id)`: `McpPlannedLaunchAnswer`
    pub fn planned_launch(&mut self, id: &str) -> JsonValue {
        let Some(server) = self.server(id) else {
            return invalid_problem("not-found");
        };
        if server.kind != McpServerKind::Local {
            return invalid_problem("not-local");
        }
        let plan = self.plan_of(&server);
        object(vec![
            ("ok", JsonValue::Bool(true)),
            ("launch", self.launch_view(&server, &plan)),
        ])
    }

    /// `test(id)`: the person's connection check (4.6)
    pub fn test(&mut self, id: &str) -> Reply<HubResult<JsonValue>> {
        let Some(server) = self.server(id) else {
            return Reply::Now(Ok(failed_problem("not-found")));
        };
        if !server.enabled {
            return Reply::Now(Ok(failed_problem("disabled")));
        }
        self.live_of(id);
        if server.kind == McpServerKind::Local {
            if launch_review_needed(&server.to_json()) {
                return Reply::Now(Ok(failed_problem("launch-not-approved")));
            }
            let plan = self.plan_of(&server);
            if let PlannedLaunch::Blocked(blocked) = &plan {
                let question = if blocked.problem == LocalLaunchProblem::RuntimeMissing {
                    self.runtime_question(&server.command, blocked.runtime.as_ref())
                } else {
                    None
                };
                // allowed before: the start downloads it without asking (13)
                if let Some(question) = &question
                    && prop(question, "allowed") != Some(&JsonValue::Bool(true))
                {
                    return Reply::Now(Ok(object(vec![
                        ("ok", JsonValue::Bool(false)),
                        ("problem", text("runtime-download")),
                        ("question", question.clone()),
                    ])));
                }
                if question.is_none() {
                    // the card shows it as the server's failure, with its reason, once
                    let reason = if blocked.problem == LocalLaunchProblem::RuntimeMissing {
                        McpFailReason::RuntimeMissing
                    } else {
                        McpFailReason::StartFailed
                    };
                    let live = self.live_of(id);
                    live.failure = Some(reason);
                    live.local_problem = Some(LocalProblem::Launch(blocked.problem));
                    self.notify();
                    return Reply::Now(Ok(object(vec![
                        ("ok", JsonValue::Bool(false)),
                        ("problem", text("failed")),
                        ("reason", text(reason.as_str())),
                        (
                            "text",
                            text(mcp_launch_problem_text(
                                self.host.lang(),
                                launch_key(blocked.problem),
                            )),
                        ),
                    ])));
                }
            }
            let conn = self.local_of(&server);
            if let Some(c) = self.locals.get_mut(&conn) {
                c.retry();
            }
            let live = self.live_of(id);
            live.failure = None;
            live.local_problem = None;
        } else {
            let live = self.live_of(id);
            live.failure = None;
            live.login_required = false;
        }
        let first = server.tools.is_empty()
            && server.instructions.is_none()
            && server.pending_instructions.is_none();
        let ticket = self.new_ticket();
        self.begin_relist(id, first, true, ListingOwner::Test(ticket));
        match self.take_ticket(ticket) {
            Some(HubAnswer::Test(answer)) => Reply::Now(answer),
            Some(other) => {
                self.settled.push((ticket, other));
                Reply::Later(ticket)
            }
            None => Reply::Later(ticket),
        }
    }

    /// `test` after its `relist`
    fn test_listed(&mut self, ticket: Ticket, id: &str, outcome: HubResult<Option<Trouble>>) {
        let answer = match outcome {
            Err(error) => Err(error),
            Ok(Some(trouble)) => {
                if trouble == Trouble::Login {
                    Ok(failed_problem("login-required"))
                } else {
                    // the program resolves elsewhere than the person allowed: the command is shown again
                    let now = self.server(id);
                    if now.as_ref().is_some_and(|s| self.command_review_needed(s)) {
                        Ok(failed_problem("launch-not-approved"))
                    } else {
                        let reason = match trouble {
                            Trouble::Failed(reason) => reason,
                            _ => McpFailReason::Unreachable,
                        };
                        let failure = now
                            .as_ref()
                            .map(|s| self.failure_of(s))
                            .unwrap_or(JsonValue::Null);
                        let failure_text =
                            prop(&failure, "text").cloned().unwrap_or(JsonValue::Null);
                        Ok(object(vec![
                            ("ok", JsonValue::Bool(false)),
                            ("problem", text("failed")),
                            ("reason", text(reason.as_str())),
                            ("text", failure_text),
                        ]))
                    }
                }
            }
            Ok(None) => Ok(object(vec![
                ("ok", JsonValue::Bool(true)),
                (
                    "toolCount",
                    number(self.server(id).map_or(0, |s| s.tools.len()) as f64),
                ),
            ])),
        };
        self.settle(ticket, HubAnswer::Test(answer));
    }

    /// `signIn(id)`: the browser sign-in (4.8)
    pub fn sign_in(&mut self, id: &str) -> Reply<JsonValue> {
        let Some(server) = self.server(id) else {
            return Reply::Now(sign_in_refused("not-found"));
        };
        if server.kind != McpServerKind::Remote {
            return Reply::Now(sign_in_refused("not-remote"));
        }
        self.live_of(id);
        self.abort_sign_in(id);
        let conn = self.remote_of(&server);
        let op = self.new_op();
        self.live_of(id).sign_in = Some(SignInCtl {
            op,
            conn,
            aborted: false,
        });
        let ticket = self.new_ticket();
        self.pending.insert(
            op,
            Pending::SignIn {
                id: id.to_owned(),
                ticket,
            },
        );
        let host = self.host.clone();
        let options = SignInOptions {
            open_external: Rc::new(move |url: &str| host.open_external(url)),
            pages: mcp_sign_in_pages(self.host.lang()),
        };
        if let Some(c) = self.remotes.get_mut(&conn) {
            c.sign_in(op, options);
        }
        // `await ...signIn(...)`
        self.flush();
        if self.app_aborted {
            self.abort_sign_in(id);
        }
        Reply::Later(ticket)
    }

    /// `change(id, apply)`: a stored change, then the connections follow and the windows hear of it
    fn change(
        &mut self,
        id: &str,
        apply: &mut dyn FnMut(&McpServerConfig) -> McpServerConfig,
    ) -> HubResult<JsonValue> {
        let done = self.replace_server(id, apply)?;
        if done.is_none() {
            return Ok(invalid("not-found", None));
        }
        self.follow(id);
        self.notify();
        // the end of an async function: whoever awaits it continues after the notice
        self.flush();
        Ok(ok_json())
    }

    /// a listing function over the stored form of a server
    fn change_json(
        &mut self,
        id: &str,
        apply: &dyn Fn(&JsonValue) -> JsonValue,
    ) -> HubResult<JsonValue> {
        self.change(id, &mut |s| {
            config_of(&apply(&s.to_json())).unwrap_or_else(|| s.clone())
        })
    }

    /// `approveTool(id, tool)`
    pub fn approve_tool(&mut self, id: &str, tool: &str) -> HubResult<JsonValue> {
        self.change_json(id, &|s| approve_tool(s, tool))
    }

    /// `approveInstructions(id)`
    pub fn approve_instructions(&mut self, id: &str) -> HubResult<JsonValue> {
        self.change_json(id, &approve_instructions)
    }

    /// `setToolPermission(id, tool, permission)`
    pub fn set_tool_permission(
        &mut self,
        id: &str,
        tool: &str,
        permission: McpPermission,
    ) -> HubResult<JsonValue> {
        self.change_json(id, &|s| set_tool_permission(s, tool, permission))
    }

    /// `setKeepResultsInside(id, on)`
    pub fn set_keep_results_inside(&mut self, id: &str, on: bool) -> HubResult<JsonValue> {
        self.change(id, &mut |s| {
            let mut next = s.clone();
            next.keep_results_inside = on;
            next
        })
    }

    /// `markToolsSeen(id)`
    pub fn mark_tools_seen(&mut self, id: &str) -> HubResult<JsonValue> {
        self.change_json(id, &mark_tools_seen)
    }

    /// `answerRuntimeDownload(id, download)`: the answer to a runtime question
    pub fn answer_runtime_download(&mut self, id: &str, download: bool) -> HubResult<JsonValue> {
        let Some(server) = self.server(id) else {
            return Ok(invalid_problem("not-found"));
        };
        if server.kind != McpServerKind::Local {
            return Ok(invalid_problem("not-local"));
        }
        if download {
            let plan = self.plan_of(&server);
            let missing = match &plan {
                PlannedLaunch::Blocked(b) if b.problem == LocalLaunchProblem::RuntimeMissing => {
                    b.runtime.clone()
                }
                _ => None,
            };
            if let Some(missing) = missing.filter(|m| !m.downloads.is_empty()) {
                self.store_update(&mut |file| {
                    let mut runtimes = file.runtimes.clone();
                    for item in &missing.downloads {
                        runtimes.set(item.runtime.as_str(), RuntimeAllowance { allowed: true });
                    }
                    file.runtimes = runtimes;
                })?;
                // allowed now, so the kit downloads without asking
                let _ = self.host.resolve_command(
                    &server.command,
                    &ResolveOptions {
                        offer_download: true,
                    },
                );
                let local = self.lives.get(id).and_then(|l| l.local);
                if let Some(conn) = local
                    && let Some(c) = self.locals.get_mut(&conn)
                {
                    c.retry();
                }
                self.notify();
            }
        }
        Ok(self.planned_launch(id))
    }

    /// `approveLaunch(id, fingerprint)`: "Allow to run" (4.5), only for the very plan the
    /// person was shown
    pub fn approve_launch(&mut self, id: &str, fingerprint: &str) -> HubResult<JsonValue> {
        let Some(server) = self.server(id) else {
            return Ok(invalid("not-found", None));
        };
        if server.kind != McpServerKind::Local {
            return Ok(invalid("not-local", None));
        }
        let shape = server_launch_fingerprint(&server.to_json());
        let plan = self.plan_of(&server);
        let PlannedLaunch::Ready(ready) = &plan else {
            return Ok(invalid("launch-changed", None));
        };
        if plan_fingerprint(&plan_shape(ready)) != fingerprint {
            return Ok(invalid("launch-changed", None));
        }
        let mut stale = false;
        let done = self.replace_server(id, &mut |s| {
            // an edit that landed while the plan was computed is not what was shown
            if server_launch_fingerprint(&s.to_json()) != shape {
                stale = true;
                return s.clone();
            }
            config_of(&approve_launch(&s.to_json(), fingerprint)).unwrap_or_else(|| s.clone())
        })?;
        if done.is_none() {
            return Ok(invalid("not-found", None));
        }
        if stale {
            return Ok(invalid("launch-changed", None));
        }
        self.follow(id);
        self.notify();
        Ok(ok_json())
    }

    /// `retry(id)`
    pub fn retry(&mut self, id: &str) -> JsonValue {
        if self.server(id).is_none() {
            return invalid("not-found", None);
        }
        let local = match self.lives.get_mut(id) {
            Some(live) => {
                live.failure = None;
                live.local_problem = None;
                live.local
            }
            None => None,
        };
        if let Some(conn) = local
            && let Some(c) = self.locals.get_mut(&conn)
        {
            c.retry();
        }
        self.notify();
        ok_json()
    }

    /// `setEnabled(id, on)`
    pub fn set_enabled(&mut self, id: &str, on: bool) -> HubResult<JsonValue> {
        if on {
            // a removal under way stays in force
            if self.stopping.get(id) == Some(&StopKind::Disabled) {
                self.stopping.delete(id);
            }
            let result = self.change(id, &mut |s| {
                let mut next = s.clone();
                next.enabled = true;
                next
            })?;
            // turned back on: an old failure gets a fresh try
            if prop(&result, "ok") == Some(&JsonValue::Bool(true)) {
                self.retry(id);
            }
            return Ok(result);
        }
        // before the write: calls arriving meanwhile are refused, those under way end (13)
        self.stopping.set(id, StopKind::Disabled);
        self.stop_calls(Some(id), StopReason::Disabled);
        let result = self.change(id, &mut |s| {
            let mut next = s.clone();
            next.enabled = false;
            next
        });
        self.stop_calls(Some(id), StopReason::Disabled);
        if self.stopping.get(id) == Some(&StopKind::Disabled) {
            self.stopping.delete(id);
        }
        result
    }

    /// `stopAll()`: the app is quitting: stop every call, every server and any download under way
    pub fn stop_all(&mut self) -> Reply<()> {
        let first_abort = !self.app_aborted;
        self.app_aborted = true;
        if first_abort {
            // `app.abort('closing')`: the listeners made from `app.signal` in the
            // order they were added (a local connection's own, then the
            // operations that got the signal), then the signals made from it
            // with `AbortSignal.any` (the sign-ins)
            let mut conns: Vec<ConnId> = self.locals.keys().copied().collect();
            conns.sort_unstable();
            for conn in conns {
                if let Some(c) = self.locals.get_mut(&conn) {
                    c.abort_app();
                }
            }
            let mut listings: Vec<(Target, OpId)> = self
                .pending
                .iter()
                .filter_map(|(op, p)| match p {
                    Pending::Listing {
                        signal_app: true,
                        target,
                        ..
                    } => Some((*target, *op)),
                    _ => None,
                })
                .collect();
            listings.sort_unstable_by_key(|(_, op)| *op);
            for (target, op) in listings {
                self.abort_op(target, op);
            }
            let ids: Vec<String> = self.lives.keys().map(str::to_owned).collect();
            for id in ids {
                self.abort_sign_in(&id);
            }
        }
        self.stop_calls(None, StopReason::Closing);
        let ticket = self.new_ticket();
        let mut parts = 0usize;
        let ids: Vec<String> = self.lives.keys().map(str::to_owned).collect();
        for id in ids {
            self.abort_sign_in(&id);
            let (local, remote) = {
                let live = self.lives.get(&id).expect("a live of the list");
                (live.local, live.remote)
            };
            if let Some(conn) = local {
                let op = self.new_op();
                self.pending.insert(op, Pending::StopAllPart { ticket });
                parts += 1;
                if let Some(c) = self.locals.get_mut(&conn) {
                    c.stop(op);
                }
            }
            if let Some(conn) = remote {
                let op = self.new_op();
                self.pending.insert(op, Pending::StopAllPart { ticket });
                parts += 1;
                if let Some(c) = self.remotes.get_mut(&conn) {
                    c.close(op);
                }
            }
        }
        let retiring = std::mem::take(&mut self.retiring);
        for conn in retiring {
            let op = self.new_op();
            self.pending.insert(op, Pending::StopAllPart { ticket });
            parts += 1;
            if let Some(c) = self.remotes.get_mut(&conn) {
                c.close(op);
            }
        }
        if parts == 0 {
            return Reply::Now(());
        }
        self.stop_alls.insert(ticket, parts);
        Reply::Later(ticket)
    }

    /// `load()`: read `mcp-servers.json` (once, at start)
    pub fn load(&mut self) {
        // `await store.load()`
        self.flush();
        self.store.borrow_mut().load();
        self.notify();
    }
}

fn invalid_problem(problem: &str) -> JsonValue {
    object(vec![
        ("ok", JsonValue::Bool(false)),
        ("problem", text(problem)),
    ])
}

fn failed_problem(problem: &str) -> JsonValue {
    invalid_problem(problem)
}

fn sign_in_refused(reason: &str) -> JsonValue {
    object(vec![
        ("ok", JsonValue::Bool(false)),
        ("reason", text(reason)),
    ])
}

/// `redirectSafeFetch(base)(url, init)`: the network call behind remote servers.
/// Every request asks not to follow redirects; the connection then refuses one
/// to another origin. Should the network layer follow one anyway (Electron's
/// `net.fetch` with `manual` has not been seen here), the answer is turned back
/// into the redirect it followed, so the same refusal applies.
pub fn redirect_safe_fetch(
    base: &mut dyn FetchHost,
    url: &str,
    init: &FetchInit,
) -> Result<FetchResponse, FetchError> {
    let mut manual = init.clone();
    manual.redirect = Some(Redirect::Manual);
    let response = base.fetch(url, &manual)?;
    if response.opaque_redirect || !response.redirected {
        return Ok(response);
    }
    cancel_body(base, &response.body);
    let mut headers = Headers::new();
    headers.set("location", &response.url);
    Ok(FetchResponse {
        status: 307,
        status_text: String::new(),
        headers,
        url: String::new(),
        redirected: false,
        opaque_redirect: false,
        body: Body::None,
    })
}
