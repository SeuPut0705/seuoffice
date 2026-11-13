//! `apps/shell/src/main/mcp-client/local.ts`: running a "my PC" MCP server
//! (user MCP spec 5.3, 5.5, 5.6): the one place the app starts a program a
//! person typed in, and only after they approved that exact launch (4.5).
//!
//! The TypeScript `createLocalMcpConnection` closes over a child process, a
//! `Client` of the MCP SDK, promises that wait for one another, an idle timer
//! and abort signals. None of those is here. [`LocalMcpConnection`] is the
//! state the closure held; the process, the pipes, the timers, the temporary
//! folder, the registry of started children and the settling of the promises
//! the TypeScript hands out are behind [`LocalMcpHost`], and everything that
//! happens to them later is an event the caller delivers. The connection owns
//! one `mcp_sdk::client::Client` per child and drives it with an
//! [`ExternalTransport`](crate::packages::mcp_sdk::client::ExternalTransport)
//! (the `ChildProcessTransport` of the TypeScript: the child's pipes are the
//! caller's).
//!
//! # Driving protocol
//!
//! Calls (the methods of `LocalMcpConnection` of the TypeScript): [`ensure`],
//! [`list_tools`], [`call_tool`] and [`stop`] each take a `call` number of the
//! caller's choosing and settle it exactly once through
//! [`LocalMcpHost::settle`] (possibly before the method returns). A call's
//! `AbortSignal` is [`CallSignal`]: `Live` means the caller later calls
//! [`abort`] when the signal aborts, and [`release`] when the signal is
//! dropped (the SDK never removes its abort listener, so an abort after the
//! call settled still reaches the server as `notifications/cancelled`).
//! `status`, `stderr_tail`, `retry`, `set_server`, `planned_launch` and the
//! listener sets are plain methods; a listener is a number the host is given
//! back through [`LocalMcpHost::state_changed`] and
//! [`LocalMcpHost::tools_changed`]. `deps.appSignal` aborting is
//! [`app_abort`].
//!
//! Events of the child, by the number [`LocalMcpHost::spawn`] was given:
//! [`on_stdout`], [`on_stderr`] (the `data` of the two pipes),
//! [`on_child_exit`] (`exit`), [`on_child_close`] (`close`),
//! [`on_child_error`] (`error`), [`on_stdin_error`] (`error` of the stdin).
//! A timer that fires is [`on_timeout`] (the idle timer, the 5 s wait for a
//! stopped process, and the timers of the SDK's requests all come through it;
//! the grace timer of `killProcessTree` is the host's: it calls
//! `subscription_process::on_kill_timeout` itself). The events of one child
//! arrive in the order Node emits them, and every step of the caller runs to
//! quiescence before the next (the TypeScript's promises settle between two
//! events).
//!
//! What the plain-call port changes, none of it observable by a case:
//!
//! - `await kit.resolveCommand(...)` is one synchronous call over
//!   [`McpRuntimeKit`]; a stop that arrives "during" the lookup cannot
//!   happen. A kit that throws is [`LocalMcpHost::take_lookup_failure`]
//!   (the trait answers a [`RuntimeResolution`], not a rejection).
//! - `mkdir` + `mkdtemp` + `rm` are [`LocalMcpHost::make_work_dir`] and
//!   [`LocalMcpHost::remove_work_dir`].
//! - `stdin.write(...)` returning `false` (back pressure) has no counterpart:
//!   the host queues the write; the SDK does not wait for the drain either.
//! - A stdout chunk that overflows the `ReadBuffer` is `onerror` of the
//!   transport here; in the TypeScript the exception escapes the `data`
//!   listener.
//! - Waiters that resume together after a start settles run in the order the
//!   promise reactions of the TypeScript do: calls without an `AbortSignal`
//!   first, then those with one, each group in call order.
//! - Tool output validation (Ajv) stays behind
//!   [`LocalMcpHost::compile_output_schema`] and
//!   [`LocalMcpHost::validate_output`]: engine-waiting.
//!
//! [`ensure`]: LocalMcpConnection::ensure
//! [`list_tools`]: LocalMcpConnection::list_tools
//! [`call_tool`]: LocalMcpConnection::call_tool
//! [`stop`]: LocalMcpConnection::stop
//! [`abort`]: LocalMcpConnection::abort
//! [`release`]: LocalMcpConnection::release
//! [`app_abort`]: LocalMcpConnection::app_abort
//! [`on_stdout`]: LocalMcpConnection::on_stdout
//! [`on_stderr`]: LocalMcpConnection::on_stderr
//! [`on_child_exit`]: LocalMcpConnection::on_child_exit
//! [`on_child_close`]: LocalMcpConnection::on_child_close
//! [`on_child_error`]: LocalMcpConnection::on_child_error
//! [`on_stdin_error`]: LocalMcpConnection::on_stdin_error
//! [`on_timeout`]: LocalMcpConnection::on_timeout
//! [`RuntimeResolution`]: super::local_launch::RuntimeResolution

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{JsObject, JsonValue, math_round, number_to_string, slice_utf16};

use super::fingerprint::{PlanEnv, PlanShape, launch_review_needed, plan_fingerprint};
use super::limits::MCP_CALL_TIMEOUT_MS;
use super::listing::{ListedTool, McpListing};
use super::local_launch::{
    LaunchServer, LocalLaunchProblem, McpRuntimeKit, PlanOptions, PlannedLaunch, PreparedLaunch,
    prepare_local_launch, process_platform,
};
use super::store::McpServerConfig;
use crate::packages::agent_core::user_mcp_result::{
    MCP_RESULT_MAX_CHARS, ShapedMcpResult, shape_mcp_result,
};
use crate::packages::ai_provider::jsval::{object, text};
use crate::packages::ai_provider::subscription_process::{
    KillHost, KillTreeOptions, kill_process_tree,
};
use crate::packages::mcp_sdk::client::net::FetchHost;
use crate::packages::mcp_sdk::client::{
    AbortReason, Client, ClientError, ClientHost, ExternalTransport, HandlerError, HandlerOutcome,
    OpId, OutputCheck, RequestOptions, Settled, Signal,
};
use crate::packages::mcp_sdk::stdio::{ReadBuffer, serialize_message};
use crate::packages::mcp_sdk::types::{McpError, error_code};
use crate::shell::mcp_servers_api::McpFailReason;
use crate::shell::mcp_servers_api::McpServerKind;

use super::hub::{
    ConnError, ConnId, ConnOutcome, LocalConnection, LocalProblem, LocalReason, LocalState,
    OpId as HubOpId,
};

/// Idle time after which a server is ended (5.3), a tunable default
pub const MCP_LOCAL_IDLE_MS: f64 = 10.0 * 60_000.0;
/// Limit of a start up to the MCP handshake; npx may download the package first
pub const MCP_LOCAL_START_TIMEOUT_MS: f64 = 3.0 * 60_000.0;
/// Failed starts in a row after which the server waits for the person (5.3)
pub const MCP_LOCAL_MAX_START_FAILURES: f64 = 3.0;
/// Standard-error lines kept for the reason view
pub const MCP_STDERR_TAIL_LINES: usize = 20;
const STDERR_LINE_MAX_CHARS: f64 = 1_000.0;
/// Longest wait for a stopped process to be gone
const EXIT_WAIT_MS: f64 = 5_000.0;
/// Pages of a tool list read before giving up on a server that never ends it
const MAX_LIST_PAGES: u32 = 100;

/// `LocalMcpFailure`: why a server is not usable right now
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalMcpFailure {
    StartFailed,
    RuntimeMissing,
}

impl LocalMcpFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            LocalMcpFailure::StartFailed => "start-failed",
            LocalMcpFailure::RuntimeMissing => "runtime-missing",
        }
    }

    fn reason(self) -> LocalMcpErrorReason {
        match self {
            LocalMcpFailure::StartFailed => LocalMcpErrorReason::StartFailed,
            LocalMcpFailure::RuntimeMissing => LocalMcpErrorReason::RuntimeMissing,
        }
    }
}

/// `LocalLaunchProblem | 'did-not-start'`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalMcpProblem {
    Launch(LocalLaunchProblem),
    DidNotStart,
}

impl LocalMcpProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            LocalMcpProblem::Launch(problem) => problem.as_str(),
            LocalMcpProblem::DidNotStart => "did-not-start",
        }
    }
}

/// `LocalMcpState`: what the connection is doing. `Idle`: not running, starts
/// at the next need (never started, ended after the idle time, or exited).
#[derive(Debug, Clone, PartialEq)]
pub enum LocalMcpState {
    Idle,
    Starting,
    Running,
    ReviewRequired,
    Failed {
        reason: LocalMcpFailure,
        /// what went wrong, for the reason view
        problem: LocalMcpProblem,
        /// English; holds no secret
        message: String,
    },
}

impl LocalMcpState {
    /// The state as the TypeScript's object, keys in its order
    pub fn to_json(&self) -> JsonValue {
        match self {
            LocalMcpState::Idle => object(vec![("state", text("idle"))]),
            LocalMcpState::Starting => object(vec![("state", text("starting"))]),
            LocalMcpState::Running => object(vec![("state", text("running"))]),
            LocalMcpState::ReviewRequired => object(vec![("state", text("review-required"))]),
            LocalMcpState::Failed {
                reason,
                problem,
                message,
            } => object(vec![
                ("state", text("failed")),
                ("reason", text(reason.as_str())),
                ("problem", text(problem.as_str())),
                ("message", text(message.as_str())),
            ]),
        }
    }
}

/// `LocalMcpErrorReason`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalMcpErrorReason {
    Disabled,
    ReviewRequired,
    StartFailed,
    RuntimeMissing,
    Unreachable,
    Timeout,
}

impl LocalMcpErrorReason {
    pub fn as_str(self) -> &'static str {
        match self {
            LocalMcpErrorReason::Disabled => "disabled",
            LocalMcpErrorReason::ReviewRequired => "review-required",
            LocalMcpErrorReason::StartFailed => "start-failed",
            LocalMcpErrorReason::RuntimeMissing => "runtime-missing",
            LocalMcpErrorReason::Unreachable => "unreachable",
            LocalMcpErrorReason::Timeout => "timeout",
        }
    }
}

/// `LocalMcpError`: a failure to start or reach the server; its message names
/// no secret
#[derive(Debug, Clone, PartialEq)]
pub struct LocalMcpError {
    pub reason: LocalMcpErrorReason,
    pub message: String,
    pub problem: Option<LocalMcpProblem>,
}

impl LocalMcpError {
    fn new(reason: LocalMcpErrorReason, message: &str, problem: Option<LocalMcpProblem>) -> Self {
        LocalMcpError {
            reason,
            message: message.to_owned(),
            problem,
        }
    }

    /// The error as a case writes it
    pub fn to_json(&self) -> JsonValue {
        object(vec![
            ("error", text("LocalMcpError")),
            ("reason", text(self.reason.as_str())),
            ("message", text(self.message.as_str())),
            (
                "problem",
                self.problem.map_or(JsonValue::Null, |p| text(p.as_str())),
            ),
        ])
    }
}

/// What a call of the connection rejects with: the caller's own abort
/// (`AbortError`, "The call was cancelled") or a [`LocalMcpError`]
#[derive(Debug, Clone, PartialEq)]
pub enum CallFailure {
    Aborted,
    Local(LocalMcpError),
}

/// Which method a call is
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallKind {
    Ensure,
    List,
    Tool,
    Stop,
}

/// What a call resolves with
#[derive(Debug, Clone, PartialEq)]
pub enum CallOutcome {
    /// `ensure`
    Ensured,
    /// `stop`
    Stopped,
    /// `listTools`
    Listing(McpListing),
    /// `callTool`
    Result(ShapedMcpResult),
}

/// The caller's number for one call of the connection
pub type CallId = u64;

/// What the host calls a child it spawned: the number the connection gave
pub type ChildId = u64;

/// The `AbortSignal` a call was given
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CallSignal {
    /// none
    None,
    /// not aborted yet: the caller reports it with `abort`
    Live,
    /// aborted already
    Aborted,
}

/// What `spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
/// shell: false, windowsHide: true, detached })` is given
pub struct SpawnRequest<'a> {
    pub command: &'a str,
    pub args: &'a [String],
    pub cwd: &'a str,
    pub env: &'a JsObject<String>,
    pub windows_hide: bool,
    /// POSIX: its own process group, so the whole group can be ended
    pub detached: bool,
}

/// What the connection does to the world.
pub trait LocalMcpHost {
    /// `deps.kit`
    fn kit(&self) -> &dyn McpRuntimeKit;
    /// whether the kit threw (rejected) in its last lookup: the trait answers
    /// a resolution, so a throw is reported here; reading it clears it
    fn take_lookup_failure(&mut self) -> bool;
    /// `tmpdir()`
    fn tmp_dir(&mut self) -> String;
    /// `mkdir(root, { recursive: true })` then `mkdtemp(join(root, 'ieum-mcp-'))`:
    /// the new folder, or the message of what threw
    fn make_work_dir(&mut self, root: &str) -> Result<String, String>;
    /// `rm(path, { recursive: true, force: true })`, a failure ignored
    fn remove_work_dir(&mut self, path: &str);
    /// `spawn(...)`; `Err` is what it threw (its message). `child` names the
    /// process in later events
    fn spawn(&mut self, child: ChildId, request: &SpawnRequest<'_>) -> Result<(), String>;
    /// `child.pid`
    fn child_pid(&mut self, child: ChildId) -> Option<f64>;
    /// `registry.track(child, { provider: USER_MCP_CHILD_KIND, command })`,
    /// called only when the connection has a registry
    fn track_child(&mut self, child: ChildId, command: &str);
    /// `child.stdin.write(data)`
    fn write_stdin(&mut self, child: ChildId, data: &str);
    /// `child.stdin.destroyed`
    fn stdin_destroyed(&mut self, child: ChildId) -> bool;
    /// what `killProcessTree` calls of the process
    fn kill_host(&mut self) -> &mut dyn KillHost;
    /// `setTimeout(callback, ms)`: the timer's number, given back to
    /// [`LocalMcpConnection::on_timeout`] when it fires
    fn set_timeout(&mut self, ms: f64) -> u64;
    /// `setTimeout(...)` followed by `timer.unref?.()`, for the idle timer
    fn set_idle_timeout(&mut self, ms: f64) -> u64;
    /// `clearTimeout(timer)`
    fn clear_timeout(&mut self, timer: u64);
    /// a state listener runs
    fn state_changed(&mut self, listener: u64, state: &LocalMcpState);
    /// a tools-changed listener runs
    fn tools_changed(&mut self, listener: u64);
    /// the promise of a call settles
    fn settle(&mut self, call: CallId, kind: CallKind, outcome: Result<CallOutcome, CallFailure>);
    /// `ajv.compile(schema)` of a tool's `outputSchema`; engine-waiting
    fn compile_output_schema(&mut self, schema: &JsonValue) -> Result<u64, String>;
    /// `validator(structuredContent)`; engine-waiting
    fn validate_output(&mut self, validator: u64, structured_content: &JsonValue) -> OutputCheck;
}

/// `LocalMcpDeps` without the kit, the spawn function, the registry object and
/// the app's signal (they are the host and [`LocalMcpConnection::app_abort`])
#[derive(Debug, Clone, Default)]
pub struct LocalMcpOptions {
    /// `clientInfo.name`
    pub client_name: String,
    /// `clientInfo.version`
    pub client_version: String,
    /// `registry` is not `null`: started children are recorded
    pub registry: bool,
    /// the app's environment the system variables are read from
    pub base_env: Option<JsObject<String>>,
    /// see `MCP_LOCAL_SYSTEM_ENV`
    pub system_env: Option<Vec<String>>,
    pub platform: Option<String>,
    /// the folder the per-start empty working folders are made in; the temp folder when absent
    pub work_root: Option<String>,
    pub idle_ms: Option<f64>,
    pub call_timeout_ms: Option<f64>,
    pub start_timeout_ms: Option<f64>,
    pub max_start_failures: Option<f64>,
    pub result_max_chars: Option<f64>,
    /// `appSignal` is aborted already
    pub app_aborted: bool,
}

/// `StderrTail`: lines of standard error, the last few only; a line never
/// grows without bound
struct StderrTail {
    lines: Vec<String>,
    partial: String,
    max: usize,
}

impl StderrTail {
    fn new(max: usize) -> Self {
        StderrTail {
            lines: Vec::new(),
            partial: String::new(),
            max,
        }
    }

    fn push(&mut self, chunk: &[u8]) {
        let combined = format!("{}{}", self.partial, String::from_utf8_lossy(chunk));
        // split(/\r?\n/): the part after the last newline keeps a trailing \r
        let mut parts: Vec<&str> = combined.split('\n').collect();
        let last = parts.pop().unwrap_or("");
        self.partial = slice_utf16(last, -STDERR_LINE_MAX_CHARS, None);
        for part in parts {
            self.add(part.strip_suffix('\r').unwrap_or(part));
        }
    }

    fn end(&mut self) {
        if !self.partial.is_empty() {
            let partial = std::mem::take(&mut self.partial);
            self.add(&partial);
        }
        self.partial.clear();
    }

    fn clear(&mut self) {
        self.lines.clear();
        self.partial.clear();
    }

    fn snapshot(&self) -> Vec<String> {
        if self.partial.is_empty() {
            return self.lines.clone();
        }
        let mut all = self.lines.clone();
        all.push(self.partial.clone());
        if all.len() > self.max {
            all.drain(..all.len() - self.max);
        }
        all
    }

    fn add(&mut self, line: &str) {
        if line.is_empty() {
            return;
        }
        self.lines
            .push(slice_utf16(line, 0.0, Some(STDERR_LINE_MAX_CHARS)));
        if self.lines.len() > self.max {
            let extra = self.lines.len() - self.max;
            self.lines.drain(..extra);
        }
    }
}

/// What of a child the transport and the kill read and write
struct ChildIo {
    id: ChildId,
    pid: Option<f64>,
    platform: String,
    /// `endTree` has run
    ended: bool,
    /// the transport finished (`closed` of `ChildProcessTransport`)
    closed: bool,
    /// `transport.start()` ran (its listeners are on the child)
    started: bool,
    /// the `gone` promise resolved: the process exited and its streams closed
    gone: bool,
    cwd: String,
    buffer: ReadBuffer,
}

struct ChildSlot {
    client: Client,
    io: ChildIo,
}

/// `endTree()`: end the process tree once
fn end_tree(host: &mut dyn LocalMcpHost, io: &mut ChildIo) {
    if io.ended {
        return;
    }
    io.ended = true;
    let options = KillTreeOptions {
        platform: Some(io.platform.as_str()),
        ..KillTreeOptions::default()
    };
    kill_process_tree(io.pid, &options, host.kill_host());
}

/// What the SDK's `Client` told while a call into it ran
enum ClientEvent {
    Settled(OpId, Result<Settled, ClientError>),
    /// `client.onclose`
    Closed(ChildId),
    /// the notification handler for `ToolListChangedNotificationSchema`
    ToolsChanged,
}

/// The host of one `Client` call: the child's pipe is written through the
/// connection's host, what the client reports is collected in `events`
struct ProcHost<'a> {
    host: &'a mut dyn LocalMcpHost,
    io: &'a mut ChildIo,
    events: &'a mut Vec<ClientEvent>,
}

impl FetchHost for ProcHost<'_> {}

impl ClientHost for ProcHost<'_> {
    fn set_timeout(&mut self, ms: f64) -> u64 {
        self.host.set_timeout(ms)
    }

    fn clear_timeout(&mut self, timer: u64) {
        self.host.clear_timeout(timer)
    }

    fn settle(&mut self, op: OpId, outcome: Result<Settled, ClientError>) {
        self.events.push(ClientEvent::Settled(op, outcome));
    }

    /// `client.onerror = () => undefined`
    fn on_error(&mut self, _error: &ClientError) {}

    /// `client.onclose`: the process exited, or the connection was closed
    fn on_close(&mut self) {
        end_tree(&mut *self.host, &mut *self.io);
        self.events.push(ClientEvent::Closed(self.io.id));
    }

    fn on_notification(&mut self, _notification: &JsonValue) {
        self.events.push(ClientEvent::ToolsChanged);
    }

    /// 5.6: the app answers no request of the server's (sampling, roots,
    /// elicitation, ...)
    fn fallback_request(&mut self, request: &JsonValue) -> Option<HandlerOutcome> {
        let method = match request.get("method").as_deref() {
            Some(JsonValue::String(method)) => method.clone(),
            _ => "undefined".to_owned(),
        };
        Some(HandlerOutcome::Error(HandlerError::mcp(
            error_code::METHOD_NOT_FOUND,
            &format!("Method not found: {method}"),
        )))
    }

    /// `ChildProcessTransport.send`
    fn write(&mut self, message: &JsonValue) -> Result<(), ClientError> {
        if self.io.closed || self.host.stdin_destroyed(self.io.id) {
            return Err(ClientError::Mcp(McpError::new(
                error_code::CONNECTION_CLOSED,
                "The server is not running",
                None,
            )));
        }
        self.host
            .write_stdin(self.io.id, &serialize_message(message));
        Ok(())
    }

    /// `ChildProcessTransport.close`: `this.end(); this.finish()`
    fn close_transport(&mut self) -> bool {
        end_tree(&mut *self.host, &mut *self.io);
        if self.io.closed {
            return false;
        }
        self.io.closed = true;
        self.io.buffer.clear();
        true
    }

    fn compile_output_schema(&mut self, schema: &JsonValue) -> Result<u64, String> {
        self.host.compile_output_schema(schema)
    }

    fn validate_output(&mut self, validator: u64, structured_content: &JsonValue) -> OutputCheck {
        self.host.validate_output(validator, structured_content)
    }
}

/// what a request of the client stands for
enum OpKind {
    Connect(ChildId),
    Page(CallId),
    Tool(CallId),
}

/// what a call does once the server runs
enum Work {
    Ensure,
    List {
        cursor: Option<String>,
        page: u32,
        tools: Vec<ListedTool>,
    },
    Tool {
        name: String,
        args: JsonValue,
    },
}

struct Call {
    id: CallId,
    /// the method the call is, fixed when it begins: its settle names it
    kind: CallKind,
    work: Work,
    /// the call has an `AbortSignal`
    has_signal: bool,
    /// `signal.aborted`
    aborted: bool,
    /// waiting for a start to settle
    waiting: bool,
    /// the child the call's requests go to, once it runs
    child: Option<ChildId>,
}

/// an abort listener of the SDK, kept for the signal of `call`
struct SignalRef {
    call: CallId,
    child: ChildId,
    op: OpId,
}

/// why a call did not get its answer
enum Failure {
    Aborted,
    Local(LocalMcpError),
    Client(ClientError),
}

struct StartCtx {
    id: u64,
    /// the lifetime the start began under (`own`)
    own: u64,
}

enum AfterProcess {
    Nothing,
    /// the first `await stopProcess()` of `stop()`
    StopFirst(u64),
    /// the `stopProcess()` after a pending start of `stop()`
    StopSecond(u64),
}

enum ExitThen {
    Process(AfterProcess),
    /// the wait of a failed start for its process to be gone
    StartFailure {
        own: u64,
        timed_out: bool,
    },
}

/// `Promise.race([current.gone, timer])`: whichever comes first
struct ExitWait {
    child: ChildId,
    timer: u64,
    then: ExitThen,
}

/// one `stop()` under way
struct StopCtx {
    id: u64,
    who: Option<CallId>,
    /// the start `starting` was when `stop` began
    pending: Option<u64>,
    /// how that start settled (true: it resolved)
    start_result: Option<bool>,
    /// waiting for `pending` after the first process wait
    waiting_start: bool,
}

/// `createLocalMcpConnection(initial, deps)`
pub struct LocalMcpConnection {
    server: McpServerConfig,
    server_id: String,
    client_info: JsonValue,
    registry: bool,
    base_env: Option<JsObject<String>>,
    system_env: Option<Vec<String>>,
    platform: String,
    work_root: Option<String>,
    idle_ms: f64,
    call_timeout_ms: f64,
    start_timeout_ms: f64,
    max_failures: f64,
    result_max_chars: f64,
    app_aborted: bool,

    tail: StderrTail,
    tool_listeners: Vec<u64>,
    state_listeners: Vec<u64>,
    state: LocalMcpState,
    running: Option<ChildId>,
    starting: Option<StartCtx>,
    /// the generation of `lifetime`: `stop` aborts it and begins the next
    lifetime: u64,
    /// the `initialize` requests whose abort listener is on the current lifetime
    lifetime_clients: Vec<(ChildId, OpId)>,
    failures: f64,
    busy: u32,
    idle_timer: Option<u64>,
    restart_when_idle: bool,
    /// the last start found a resolved plan other than the approved one (4.5)
    plan_review: bool,

    children: Vec<ChildSlot>,
    ops: Vec<(OpId, OpKind)>,
    calls: Vec<Call>,
    waiters: Vec<CallId>,
    signals: Vec<SignalRef>,
    /// signals that aborted (an `AbortSignal` aborts once)
    aborted_calls: Vec<CallId>,
    exit_waits: Vec<ExitWait>,
    stops: Vec<StopCtx>,
    next_child: ChildId,
    next_op: OpId,
    next_start: u64,
    next_stop: u64,
}

fn describe_seconds(ms: f64) -> String {
    number_to_string(math_round(ms / 1000.0))
}

impl LocalMcpConnection {
    pub fn new(initial: McpServerConfig, options: LocalMcpOptions) -> Self {
        let state = if launch_review_needed(&initial.to_json()) {
            LocalMcpState::ReviewRequired
        } else {
            LocalMcpState::Idle
        };
        LocalMcpConnection {
            server_id: initial.id.clone(),
            server: initial,
            client_info: object(vec![
                ("name", text(options.client_name.as_str())),
                ("version", text(options.client_version.as_str())),
            ]),
            registry: options.registry,
            base_env: options.base_env,
            system_env: options.system_env,
            platform: options
                .platform
                .unwrap_or_else(|| process_platform().to_owned()),
            work_root: options.work_root,
            idle_ms: options.idle_ms.unwrap_or(MCP_LOCAL_IDLE_MS),
            call_timeout_ms: options.call_timeout_ms.unwrap_or(MCP_CALL_TIMEOUT_MS),
            start_timeout_ms: options
                .start_timeout_ms
                .unwrap_or(MCP_LOCAL_START_TIMEOUT_MS),
            max_failures: options
                .max_start_failures
                .unwrap_or(MCP_LOCAL_MAX_START_FAILURES),
            result_max_chars: options.result_max_chars.unwrap_or(MCP_RESULT_MAX_CHARS),
            app_aborted: options.app_aborted,
            tail: StderrTail::new(MCP_STDERR_TAIL_LINES),
            tool_listeners: Vec::new(),
            state_listeners: Vec::new(),
            state,
            running: None,
            starting: None,
            lifetime: 0,
            lifetime_clients: Vec::new(),
            failures: 0.0,
            busy: 0,
            idle_timer: None,
            restart_when_idle: false,
            plan_review: false,
            children: Vec::new(),
            ops: Vec::new(),
            calls: Vec::new(),
            waiters: Vec::new(),
            signals: Vec::new(),
            aborted_calls: Vec::new(),
            exit_waits: Vec::new(),
            stops: Vec::new(),
            next_child: 0,
            next_op: 0,
            next_start: 0,
            next_stop: 0,
        }
    }

    // ---- reads ----

    /// `serverId`
    pub fn server_id(&self) -> &str {
        &self.server_id
    }

    /// `status()`
    pub fn status(&self) -> &LocalMcpState {
        &self.state
    }

    /// `stderrTail()`: the last lines the server wrote to standard error, for
    /// the reason view only
    pub fn stderr_tail(&self) -> Vec<String> {
        self.tail.snapshot()
    }

    /// `onToolsChanged(listener)`
    pub fn add_tools_listener(&mut self, listener: u64) {
        if !self.tool_listeners.contains(&listener) {
            self.tool_listeners.push(listener);
        }
    }

    /// the function `onToolsChanged` returned
    pub fn remove_tools_listener(&mut self, listener: u64) {
        self.tool_listeners.retain(|l| *l != listener);
    }

    /// `onStateChanged(listener)`
    pub fn add_state_listener(&mut self, listener: u64) {
        if !self.state_listeners.contains(&listener) {
            self.state_listeners.push(listener);
        }
    }

    /// the function `onStateChanged` returned
    pub fn remove_state_listener(&mut self, listener: u64) {
        self.state_listeners.retain(|l| *l != listener);
    }

    /// `plannedLaunch()`: the command this server runs, as the confirmation
    /// shows it
    pub fn planned_launch(&self, host: &dyn LocalMcpHost) -> PlannedLaunch {
        prepare_local_launch(
            &self.launch_server(),
            host.kit(),
            &PlanOptions {
                base_env: self.base_env.clone(),
                platform: Some(self.platform.clone()),
                system_env: self.system_env.clone(),
                offer_download: None,
            },
        )
        .plan
    }

    fn launch_server(&self) -> LaunchServer {
        LaunchServer {
            command: self.server.command.clone(),
            args: self.server.args.clone(),
            env: self.server.env.clone(),
        }
    }

    // ---- state ----

    fn set_state(&mut self, host: &mut dyn LocalMcpHost, next: LocalMcpState) {
        self.state = next.clone();
        for listener in self.state_listeners.clone() {
            host.state_changed(listener, &next);
        }
    }

    fn clear_idle(&mut self, host: &mut dyn LocalMcpHost) {
        if let Some(timer) = self.idle_timer.take() {
            host.clear_timeout(timer);
        }
    }

    fn arm_idle(&mut self, host: &mut dyn LocalMcpHost) {
        self.clear_idle(host);
        if self.running.is_none() || self.busy > 0 {
            return;
        }
        if self.restart_when_idle {
            self.restart_when_idle = false;
            self.stop_process(host, AfterProcess::Nothing);
            return;
        }
        self.idle_timer = Some(host.set_idle_timeout(self.idle_ms));
    }

    fn fail_start(
        &mut self,
        host: &mut dyn LocalMcpHost,
        reason: LocalMcpFailure,
        problem: LocalMcpProblem,
        message: &str,
        permanent: bool,
    ) -> LocalMcpError {
        let failed = LocalMcpState::Failed {
            reason,
            problem,
            message: message.to_owned(),
        };
        if reason == LocalMcpFailure::StartFailed {
            self.failures = if permanent {
                self.max_failures
            } else {
                self.failures + 1.0
            };
            if self.failures >= self.max_failures {
                self.set_state(host, failed);
            } else {
                self.set_state(host, LocalMcpState::Idle);
            }
        } else {
            self.set_state(host, failed);
        }
        LocalMcpError::new(reason.reason(), message, Some(problem))
    }

    /// `gate()`
    fn gate(&mut self, host: &mut dyn LocalMcpHost) -> Option<LocalMcpError> {
        if self.app_aborted {
            return Some(LocalMcpError::new(
                LocalMcpErrorReason::Unreachable,
                "The app is closing",
                None,
            ));
        }
        if !self.server.enabled {
            return Some(LocalMcpError::new(
                LocalMcpErrorReason::Disabled,
                "The server is turned off",
                None,
            ));
        }
        if self.server.kind != McpServerKind::Local {
            return Some(LocalMcpError::new(
                LocalMcpErrorReason::StartFailed,
                "Not a local server",
                None,
            ));
        }
        if launch_review_needed(&self.server.to_json()) {
            if self.state != LocalMcpState::ReviewRequired {
                self.set_state(host, LocalMcpState::ReviewRequired);
            }
            return Some(LocalMcpError::new(
                LocalMcpErrorReason::ReviewRequired,
                "The command must be approved again",
                None,
            ));
        }
        if let LocalMcpState::Failed {
            reason,
            problem,
            message,
        } = &self.state
        {
            return Some(LocalMcpError {
                reason: reason.reason(),
                message: message.clone(),
                problem: Some(*problem),
            });
        }
        None
    }

    /// `describeFailure(error)`
    fn describe_failure(&self, failure: &Failure) -> String {
        match failure {
            Failure::Local(error) => match error.reason {
                LocalMcpErrorReason::Disabled => "the server is turned off".to_owned(),
                LocalMcpErrorReason::ReviewRequired => {
                    "its command changed and must be approved again in settings".to_owned()
                }
                LocalMcpErrorReason::RuntimeMissing => {
                    "the program it needs is not on this PC".to_owned()
                }
                LocalMcpErrorReason::StartFailed => "the server could not be started".to_owned(),
                LocalMcpErrorReason::Timeout => format!(
                    "the server did not answer within {} seconds",
                    describe_seconds(self.call_timeout_ms)
                ),
                LocalMcpErrorReason::Unreachable => "the server could not be reached".to_owned(),
            },
            Failure::Client(ClientError::Mcp(error)) => {
                if error.code == error_code::REQUEST_TIMEOUT {
                    format!(
                        "the server did not answer within {} seconds",
                        describe_seconds(self.call_timeout_ms)
                    )
                } else if error.code == error_code::CONNECTION_CLOSED {
                    "the server stopped during the call".to_owned()
                } else {
                    format!(
                        "the server refused the call ({})",
                        slice_utf16(&error.message, 0.0, Some(500.0))
                    )
                }
            }
            Failure::Client(_) | Failure::Aborted => "the server could not be reached".to_owned(),
        }
    }

    // ---- the client of a child ----

    fn new_op(&mut self, kind: OpKind) -> OpId {
        let op = self.next_op;
        self.next_op += 1;
        self.ops.push((op, kind));
        op
    }

    /// Run `f` on the client of `child` with its host, then act on what the
    /// client reported. `None` when the child is gone.
    fn with_client<R>(
        &mut self,
        host: &mut dyn LocalMcpHost,
        child: ChildId,
        f: impl FnOnce(&mut Client, &mut dyn ClientHost) -> R,
    ) -> Option<R> {
        let index = self.children.iter().position(|s| s.io.id == child)?;
        let mut events: Vec<ClientEvent> = Vec::new();
        let result = {
            let slot = &mut self.children[index];
            let mut adapter = ProcHost {
                host: &mut *host,
                io: &mut slot.io,
                events: &mut events,
            };
            f(&mut slot.client, &mut adapter)
        };
        self.process_events(host, events);
        Some(result)
    }

    fn process_events(&mut self, host: &mut dyn LocalMcpHost, events: Vec<ClientEvent>) {
        for event in events {
            match event {
                ClientEvent::Settled(op, outcome) => self.on_client_settled(host, op, outcome),
                ClientEvent::Closed(child) => self.on_client_closed(host, child),
                ClientEvent::ToolsChanged => {
                    for listener in self.tool_listeners.clone() {
                        host.tools_changed(listener);
                    }
                }
            }
        }
    }

    /// `client.onclose` after `endTree()`
    fn on_client_closed(&mut self, host: &mut dyn LocalMcpHost, child: ChildId) {
        if self.running == Some(child) {
            self.running = None;
            self.clear_idle(host);
            if self.state == LocalMcpState::Running {
                self.set_state(host, LocalMcpState::Idle);
            }
        }
    }

    fn on_client_settled(
        &mut self,
        host: &mut dyn LocalMcpHost,
        op: OpId,
        outcome: Result<Settled, ClientError>,
    ) {
        let Some(index) = self.ops.iter().position(|(o, _)| *o == op) else {
            return;
        };
        let (_, kind) = self.ops.remove(index);
        match kind {
            OpKind::Connect(child) => self.on_connect_settled(host, child, outcome),
            OpKind::Page(call) => self.on_page_settled(host, call, outcome),
            OpKind::Tool(call) => self.on_tool_settled(host, call, outcome),
        }
    }

    fn maybe_drop_slot(&mut self, child: ChildId) {
        self.children
            .retain(|s| !(s.io.id == child && s.io.gone && s.io.closed));
    }

    // ---- the events of a child ----

    /// `child.stdout` `data`
    pub fn on_stdout(&mut self, host: &mut dyn LocalMcpHost, child: ChildId, chunk: &[u8]) {
        let appended = match self.children.iter_mut().find(|s| s.io.id == child) {
            Some(slot) => slot.io.buffer.append(chunk),
            None => return,
        };
        if let Err(error) = appended {
            let error = ClientError::from(error);
            self.with_client(host, child, |client, h| client.on_transport_error(h, error));
            return;
        }
        loop {
            let read = match self.children.iter_mut().find(|s| s.io.id == child) {
                Some(slot) => slot.io.buffer.read_message(),
                None => return,
            };
            match read {
                Err(error) => {
                    let error = ClientError::from(error);
                    self.with_client(host, child, |client, h| client.on_transport_error(h, error));
                }
                Ok(None) => break,
                Ok(Some(message)) => {
                    self.with_client(host, child, |client, h| client.on_message(h, message));
                }
            }
        }
    }

    /// `child.stderr` `data`: only the last lines stay, in memory
    pub fn on_stderr(&mut self, _host: &mut dyn LocalMcpHost, _child: ChildId, chunk: &[u8]) {
        self.tail.push(chunk);
    }

    /// `child` `exit`
    pub fn on_child_exit(&mut self, host: &mut dyn LocalMcpHost, child: ChildId) {
        let started = self
            .children
            .iter()
            .find(|s| s.io.id == child)
            .is_some_and(|s| s.io.started);
        if started {
            self.transport_finish(host, child);
        }
    }

    /// `child.stdin` `error`: a server that exits mid-write
    pub fn on_stdin_error(&mut self, host: &mut dyn LocalMcpHost, child: ChildId) {
        self.on_child_exit(host, child);
    }

    /// `child` `error`: the process could not start, or could not be signalled
    pub fn on_child_error(&mut self, host: &mut dyn LocalMcpHost, child: ChildId) {
        // the `gone` listener first: a child that never started emits no close
        if host.child_pid(child).is_none() {
            self.finish_gone(host, child);
        }
        self.on_child_exit(host, child);
    }

    /// `child` `close`: the process has exited and its streams are closed
    pub fn on_child_close(&mut self, host: &mut dyn LocalMcpHost, child: ChildId) {
        self.finish_gone(host, child);
    }

    /// `finish()` of `ChildProcessTransport`
    fn transport_finish(&mut self, host: &mut dyn LocalMcpHost, child: ChildId) {
        let Some(slot) = self.children.iter_mut().find(|s| s.io.id == child) else {
            return;
        };
        if slot.io.closed {
            return;
        }
        slot.io.closed = true;
        slot.io.buffer.clear();
        self.with_client(host, child, |client, h| client.on_transport_closed(h));
        self.maybe_drop_slot(child);
    }

    /// `done()` of the `gone` promise
    fn finish_gone(&mut self, host: &mut dyn LocalMcpHost, child: ChildId) {
        let Some(slot) = self.children.iter_mut().find(|s| s.io.id == child) else {
            return;
        };
        if slot.io.gone {
            return;
        }
        slot.io.gone = true;
        let cwd = slot.io.cwd.clone();
        self.tail.end();
        host.remove_work_dir(&cwd);
        let waits: Vec<ExitWait> = {
            let (done, rest): (Vec<ExitWait>, Vec<ExitWait>) = std::mem::take(&mut self.exit_waits)
                .into_iter()
                .partition(|w| w.child == child);
            self.exit_waits = rest;
            done
        };
        for wait in waits {
            self.run_exit_then(host, wait.then);
        }
        self.maybe_drop_slot(child);
    }

    /// A timer fires: whether it was one of the connection's (the idle timer,
    /// a wait for a process to be gone, or a request of the SDK)
    pub fn on_timeout(&mut self, host: &mut dyn LocalMcpHost, timer: u64) -> bool {
        if self.idle_timer == Some(timer) {
            self.idle_timer = None;
            if self.busy == 0 {
                self.stop_process(host, AfterProcess::Nothing);
            }
            return true;
        }
        if let Some(index) = self.exit_waits.iter().position(|w| w.timer == timer) {
            let wait = self.exit_waits.remove(index);
            self.run_exit_then(host, wait.then);
            return true;
        }
        let ids: Vec<ChildId> = self.children.iter().map(|s| s.io.id).collect();
        for child in ids {
            let owned = self
                .with_client(host, child, |client, h| client.on_timeout(h, timer))
                .unwrap_or(false);
            if owned {
                return true;
            }
        }
        false
    }

    // ---- calls ----

    /// `ensure(signal)`: start the server unless it runs
    pub fn ensure(&mut self, host: &mut dyn LocalMcpHost, call: CallId, signal: CallSignal) {
        self.begin_call(host, call, Work::Ensure, signal);
    }

    /// `listTools(signal)`: the tool list and instructions, read from the
    /// server (starting it when needed)
    pub fn list_tools(&mut self, host: &mut dyn LocalMcpHost, call: CallId, signal: CallSignal) {
        let work = Work::List {
            cursor: None,
            page: 0,
            tools: Vec::new(),
        };
        self.begin_call(host, call, work, signal);
    }

    /// `callTool(name, args, signal)`. A tool error, a server that cannot be
    /// started or reached and a call over the time limit all resolve as a
    /// tool error naming the server and the reason; only the caller's own
    /// abort rejects.
    pub fn call_tool(
        &mut self,
        host: &mut dyn LocalMcpHost,
        call: CallId,
        name: &str,
        args: JsonValue,
        signal: CallSignal,
    ) {
        let work = Work::Tool {
            name: name.to_owned(),
            args,
        };
        self.begin_call(host, call, work, signal);
    }

    /// `busy += 1; clearIdle(); await ensureRunning(signal)` and what follows
    fn begin_call(
        &mut self,
        host: &mut dyn LocalMcpHost,
        id: CallId,
        work: Work,
        signal: CallSignal,
    ) {
        let kind = match &work {
            Work::Ensure => CallKind::Ensure,
            Work::List { .. } => CallKind::List,
            Work::Tool { .. } => CallKind::Tool,
        };
        self.calls.push(Call {
            id,
            kind,
            work,
            has_signal: signal != CallSignal::None,
            aborted: signal == CallSignal::Aborted,
            waiting: false,
            child: None,
        });
        self.busy += 1;
        self.clear_idle(host);
        if signal == CallSignal::Aborted {
            self.finish_call(host, id, Err(Failure::Aborted));
            return;
        }
        if let Some(error) = self.gate(host) {
            self.finish_call(host, id, Err(Failure::Local(error)));
            return;
        }
        if let Some(child) = self.running {
            self.run_task(host, id, child);
            return;
        }
        if let Some(call) = self.calls.iter_mut().find(|c| c.id == id) {
            call.waiting = true;
        }
        self.waiters.push(id);
        if self.starting.is_none() {
            self.start_server(host);
        }
    }

    /// The signal of `call` aborted
    pub fn abort(&mut self, host: &mut dyn LocalMcpHost, call: CallId) {
        if self.aborted_calls.contains(&call) {
            return;
        }
        self.aborted_calls.push(call);
        let mut waiting = false;
        if let Some(c) = self.calls.iter_mut().find(|c| c.id == call) {
            c.aborted = true;
            waiting = c.waiting;
        }
        // the listener of `ensureRunning` first
        if waiting {
            self.waiters.retain(|w| *w != call);
            if let Some(c) = self.calls.iter_mut().find(|c| c.id == call) {
                c.waiting = false;
            }
            self.finish_call(host, call, Err(Failure::Aborted));
        }
        // then the SDK's listeners of this signal, in the order they were added
        let listeners: Vec<(ChildId, OpId)> = self
            .signals
            .iter()
            .filter(|s| s.call == call)
            .map(|s| (s.child, s.op))
            .collect();
        for (child, op) in listeners {
            self.with_client(host, child, |client, h| {
                client.on_abort(h, op, AbortReason::default_abort())
            });
        }
    }

    /// The signal of `call` is dropped: its SDK listeners go with it
    pub fn release(&mut self, call: CallId) {
        let released: Vec<(ChildId, OpId)> = self
            .signals
            .iter()
            .filter(|s| s.call == call)
            .map(|s| (s.child, s.op))
            .collect();
        for (child, op) in released {
            if let Some(slot) = self.children.iter_mut().find(|s| s.io.id == child) {
                slot.client.release(op);
            }
        }
        self.signals.retain(|s| s.call != call);
    }

    /// `task(current)` of `withServer`
    fn run_task(&mut self, host: &mut dyn LocalMcpHost, id: CallId, child: ChildId) {
        let Some(call) = self.calls.iter_mut().find(|c| c.id == id) else {
            return;
        };
        call.child = Some(child);
        let has_signal = call.has_signal;
        let tool_params = match &call.work {
            Work::Ensure => {
                self.finish_call(host, id, Ok(CallOutcome::Ensured));
                return;
            }
            Work::List { .. } => {
                self.request_page(host, id, child);
                return;
            }
            Work::Tool { name, args } => object(vec![
                ("name", text(name.as_str())),
                ("arguments", args.clone()),
            ]),
        };
        let op = self.new_op(OpKind::Tool(id));
        let options = self.request_options(has_signal);
        if has_signal {
            self.signals.push(SignalRef {
                call: id,
                child,
                op,
            });
        }
        self.with_client(host, child, |client, h| {
            client.call_tool(h, op, tool_params, &options)
        });
    }

    fn request_options(&self, has_signal: bool) -> RequestOptions {
        RequestOptions {
            timeout: Some(self.call_timeout_ms),
            signal: has_signal.then(Signal::default),
        }
    }

    /// one `client.listTools(cursor ? { cursor } : {}, { signal, timeout })`
    fn request_page(&mut self, host: &mut dyn LocalMcpHost, id: CallId, child: ChildId) {
        let Some(call) = self.calls.iter().find(|c| c.id == id) else {
            return;
        };
        let Work::List { cursor, .. } = &call.work else {
            return;
        };
        let mut params = JsObject::new();
        if let Some(cursor) = cursor.as_deref().filter(|c| !c.is_empty()) {
            params.set("cursor", text(cursor));
        }
        let params = JsonValue::Object(params);
        let has_signal = call.has_signal;
        let op = self.new_op(OpKind::Page(id));
        let options = self.request_options(has_signal);
        if has_signal {
            self.signals.push(SignalRef {
                call: id,
                child,
                op,
            });
        }
        self.with_client(host, child, |client, h| {
            client.list_tools(h, op, Some(params), &options)
        });
    }

    fn on_page_settled(
        &mut self,
        host: &mut dyn LocalMcpHost,
        id: CallId,
        outcome: Result<Settled, ClientError>,
    ) {
        let Some(index) = self.calls.iter().position(|c| c.id == id) else {
            return;
        };
        let result = match outcome {
            Ok(Settled::Result(result)) => result,
            Ok(Settled::Connected) => return,
            Err(error) => {
                if self.calls[index].aborted {
                    self.finish_call(host, id, Err(Failure::Aborted));
                    return;
                }
                let timed_out = matches!(
                    &error,
                    ClientError::Mcp(e) if e.code == error_code::REQUEST_TIMEOUT
                );
                let message = self.describe_failure(&Failure::Client(error));
                let reason = if timed_out {
                    LocalMcpErrorReason::Timeout
                } else {
                    LocalMcpErrorReason::Unreachable
                };
                let failure = LocalMcpError::new(reason, &message, None);
                self.finish_call(host, id, Err(Failure::Local(failure)));
                return;
            }
        };
        let next = match result.get("nextCursor").as_deref() {
            Some(JsonValue::String(cursor)) if !cursor.is_empty() => Some(cursor.clone()),
            _ => None,
        };
        let more = {
            let Work::List {
                cursor,
                page,
                tools,
            } = &mut self.calls[index].work
            else {
                return;
            };
            tools.extend(listed_tools(&result));
            *page += 1;
            match next {
                Some(next) if *page < MAX_LIST_PAGES => {
                    *cursor = Some(next);
                    true
                }
                _ => false,
            }
        };
        let Some(child) = self.calls[index].child else {
            return;
        };
        if more {
            self.request_page(host, id, child);
            return;
        }
        let instructions = self
            .children
            .iter()
            .find(|s| s.io.id == child)
            .and_then(|s| s.client.get_instructions().map(str::to_owned));
        let Work::List { tools, .. } = &mut self.calls[index].work else {
            return;
        };
        let tools = std::mem::take(tools);
        self.finish_call(
            host,
            id,
            Ok(CallOutcome::Listing(McpListing {
                tools,
                instructions,
            })),
        );
    }

    fn on_tool_settled(
        &mut self,
        host: &mut dyn LocalMcpHost,
        id: CallId,
        outcome: Result<Settled, ClientError>,
    ) {
        match outcome {
            Ok(Settled::Result(result)) => {
                let shaped = shape_mcp_result(Some(&result), self.result_max_chars);
                self.finish_call(host, id, Ok(CallOutcome::Result(shaped)));
            }
            Ok(Settled::Connected) => {}
            Err(error) => self.finish_call(host, id, Err(Failure::Client(error))),
        }
    }

    /// `finally { busy -= 1; armIdle() }` and the settling of the promise
    fn finish_call(
        &mut self,
        host: &mut dyn LocalMcpHost,
        id: CallId,
        result: Result<CallOutcome, Failure>,
    ) {
        let Some(index) = self.calls.iter().position(|c| c.id == id) else {
            return;
        };
        let call = self.calls.remove(index);
        self.busy -= 1;
        self.arm_idle(host);
        let outcome = match (&call.work, result) {
            (_, Ok(outcome)) => Ok(outcome),
            (Work::Tool { .. }, Err(failure)) => {
                if call.aborted {
                    Err(CallFailure::Aborted)
                } else {
                    Ok(CallOutcome::Result(ShapedMcpResult {
                        output: format!(
                            "{}: {}.",
                            self.server.name,
                            self.describe_failure(&failure)
                        ),
                        is_error: true,
                    }))
                }
            }
            (_, Err(Failure::Aborted)) => Err(CallFailure::Aborted),
            (_, Err(Failure::Local(error))) => Err(CallFailure::Local(error)),
            (_, Err(Failure::Client(error))) => Err(CallFailure::Local(LocalMcpError::new(
                LocalMcpErrorReason::Unreachable,
                &self.describe_failure(&Failure::Client(error)),
                None,
            ))),
        };
        host.settle(id, call.kind, outcome);
    }

    // ---- starting ----

    /// `starting = start().finally(...)`: begin a start; it ends in
    /// [`Self::finish_start`]
    fn start_server(&mut self, host: &mut dyn LocalMcpHost) {
        let id = self.next_start;
        self.next_start += 1;
        let own = self.lifetime;
        self.starting = Some(StartCtx { id, own });
        self.set_state(host, LocalMcpState::Starting);
        self.tail.clear();
        let child = match self.launch_child(host) {
            Ok(child) => child,
            Err(error) => {
                self.finish_start(host, Err(error));
                return;
            }
        };
        let op = self.new_op(OpKind::Connect(child));
        self.lifetime_clients.push((child, op));
        if let Some(slot) = self.children.iter_mut().find(|s| s.io.id == child) {
            slot.io.started = true;
        }
        let options = RequestOptions {
            timeout: Some(self.start_timeout_ms),
            signal: Some(Signal::default()),
        };
        self.with_client(host, child, |client, h| {
            client.connect(h, op, Box::new(ExternalTransport::new()), options)
        });
    }

    /// `start()` up to `client.connect(...)`: the plan, the approval check, the
    /// working folder and the process
    fn launch_child(&mut self, host: &mut dyn LocalMcpHost) -> Result<ChildId, LocalMcpError> {
        let plan_options = PlanOptions {
            base_env: self.base_env.clone(),
            platform: Some(self.platform.clone()),
            system_env: self.system_env.clone(),
            offer_download: Some(true),
        };
        let prepared = prepare_local_launch(&self.launch_server(), host.kit(), &plan_options);
        if host.take_lookup_failure() {
            return Err(self.fail_start(
                host,
                LocalMcpFailure::StartFailed,
                LocalMcpProblem::DidNotStart,
                "The program could not be looked up",
                false,
            ));
        }
        let PreparedLaunch { plan, env } = prepared;
        let (ready, env) = match (plan, env) {
            (PlannedLaunch::Ready(ready), Some(env)) => (ready, env),
            (PlannedLaunch::Ready(_), None) => {
                return Err(self.fail_start(
                    host,
                    LocalMcpFailure::StartFailed,
                    LocalMcpProblem::DidNotStart,
                    "no environment",
                    true,
                ));
            }
            (PlannedLaunch::Blocked(blocked), _) => {
                let problem = LocalMcpProblem::Launch(blocked.problem);
                if blocked.problem == LocalLaunchProblem::RuntimeMissing {
                    return Err(self.fail_start(
                        host,
                        LocalMcpFailure::RuntimeMissing,
                        problem,
                        &blocked.message,
                        false,
                    ));
                }
                return Err(self.fail_start(
                    host,
                    LocalMcpFailure::StartFailed,
                    problem,
                    &blocked.message,
                    true,
                ));
            }
        };
        // 4.5: the program resolves elsewhere since the person allowed it (the PC's runtime gone
        // and the app's in its place, another version): what would run now is asked about again
        let shape = PlanShape {
            command: ready.command.clone(),
            args: ready.args.clone(),
            env: ready
                .env
                .iter()
                .map(|v| PlanEnv {
                    name: v.name.clone(),
                    origin: v.origin.as_str().to_owned(),
                })
                .collect(),
        };
        if Some(plan_fingerprint(&shape).as_str()) != self.server.approved_plan.as_deref() {
            self.plan_review = true;
            self.set_state(host, LocalMcpState::ReviewRequired);
            return Err(LocalMcpError::new(
                LocalMcpErrorReason::ReviewRequired,
                "The command must be approved again",
                None,
            ));
        }
        self.plan_review = false;

        let root = match &self.work_root {
            Some(root) => root.clone(),
            None => host.tmp_dir(),
        };
        let cwd = match host.make_work_dir(&root) {
            Ok(cwd) => cwd,
            Err(_) => {
                return Err(self.fail_start(
                    host,
                    LocalMcpFailure::StartFailed,
                    LocalMcpProblem::DidNotStart,
                    "No working folder could be made",
                    false,
                ));
            }
        };
        let child = self.next_child;
        self.next_child += 1;
        let request = SpawnRequest {
            command: &ready.command,
            args: &ready.args,
            cwd: &cwd,
            env: &env,
            windows_hide: true,
            detached: self.platform != "win32",
        };
        if let Err(message) = host.spawn(child, &request) {
            host.remove_work_dir(&cwd);
            return Err(self.fail_start(
                host,
                LocalMcpFailure::StartFailed,
                LocalMcpProblem::DidNotStart,
                &message,
                false,
            ));
        }
        if self.registry {
            host.track_child(child, &ready.command);
        }
        let pid = host.child_pid(child);
        let mut client = Client::new(self.client_info.clone());
        client.set_fallback_request_handler();
        client.set_notification_handler();
        self.children.push(ChildSlot {
            client,
            io: ChildIo {
                id: child,
                pid,
                platform: self.platform.clone(),
                ended: false,
                closed: false,
                started: false,
                gone: false,
                cwd,
                buffer: ReadBuffer::new(),
            },
        });
        Ok(child)
    }

    fn on_connect_settled(
        &mut self,
        host: &mut dyn LocalMcpHost,
        child: ChildId,
        outcome: Result<Settled, ClientError>,
    ) {
        let own = self.starting.as_ref().map_or(self.lifetime, |s| s.own);
        match outcome {
            Err(error) => {
                self.with_client(host, child, |client, h| client.close(h));
                if let Some(slot) = self.children.iter_mut().find(|s| s.io.id == child) {
                    end_tree(host, &mut slot.io);
                }
                let timed_out = matches!(
                    &error,
                    ClientError::Mcp(e) if e.code == error_code::REQUEST_TIMEOUT
                );
                self.await_exit(host, child, ExitThen::StartFailure { own, timed_out });
            }
            Ok(_) => {
                if own != self.lifetime {
                    self.with_client(host, child, |client, h| client.close(h));
                    self.finish_start(
                        host,
                        Err(LocalMcpError::new(
                            LocalMcpErrorReason::Unreachable,
                            "The server was stopped",
                            None,
                        )),
                    );
                    return;
                }
                self.failures = 0.0;
                self.running = Some(child);
                self.set_state(host, LocalMcpState::Running);
                self.finish_start(host, Ok(child));
            }
        }
    }

    /// what follows `await Promise.race([gone, wait])` in a failed start
    fn after_start_failure(&mut self, host: &mut dyn LocalMcpHost, own: u64, timed_out: bool) {
        let error = if own != self.lifetime {
            LocalMcpError::new(
                LocalMcpErrorReason::Unreachable,
                "The server was stopped",
                None,
            )
        } else {
            let message = if timed_out {
                "The server did not answer in time"
            } else {
                "The server did not start"
            };
            self.fail_start(
                host,
                LocalMcpFailure::StartFailed,
                LocalMcpProblem::DidNotStart,
                message,
                false,
            )
        };
        self.finish_start(host, Err(error));
    }

    /// `start()` settles: `starting = null`, and the calls waiting for it go on
    fn finish_start(
        &mut self,
        host: &mut dyn LocalMcpHost,
        result: Result<ChildId, LocalMcpError>,
    ) {
        let Some(ctx) = self.starting.take() else {
            return;
        };
        let resolved = result.is_ok();
        // the reactions of `stop()` on the same promise run before those of the waiters
        let mut ready: Vec<u64> = Vec::new();
        for stop in &mut self.stops {
            if stop.pending == Some(ctx.id) {
                stop.start_result = Some(resolved);
                if stop.waiting_start {
                    ready.push(stop.id);
                }
            }
        }
        for stop in ready {
            self.stop_start_settled(host, stop);
        }
        let waiters = std::mem::take(&mut self.waiters);
        let (plain, signalled): (Vec<CallId>, Vec<CallId>) = waiters.into_iter().partition(|id| {
            self.calls
                .iter()
                .find(|c| c.id == *id)
                .is_some_and(|c| !c.has_signal)
        });
        for id in plain.into_iter().chain(signalled) {
            if let Some(call) = self.calls.iter_mut().find(|c| c.id == id) {
                call.waiting = false;
            }
            match &result {
                Ok(child) => self.run_task(host, id, *child),
                Err(error) => self.finish_call(host, id, Err(Failure::Local(error.clone()))),
            }
        }
    }

    // ---- stopping ----

    /// `Promise.race([gone, setTimeout(done, EXIT_WAIT_MS)])`: the timer is
    /// always made and never cleared
    fn await_exit(&mut self, host: &mut dyn LocalMcpHost, child: ChildId, then: ExitThen) {
        let timer = host.set_timeout(EXIT_WAIT_MS);
        let gone = self
            .children
            .iter()
            .find(|s| s.io.id == child)
            .is_none_or(|s| s.io.gone);
        if gone {
            self.run_exit_then(host, then);
        } else {
            self.exit_waits.push(ExitWait { child, timer, then });
        }
    }

    fn run_exit_then(&mut self, host: &mut dyn LocalMcpHost, then: ExitThen) {
        match then {
            ExitThen::Process(after) => self.after_process(host, after),
            ExitThen::StartFailure { own, timed_out } => {
                self.after_start_failure(host, own, timed_out)
            }
        }
    }

    fn after_process(&mut self, host: &mut dyn LocalMcpHost, after: AfterProcess) {
        match after {
            AfterProcess::Nothing => {}
            AfterProcess::StopFirst(stop) => self.stop_first_done(host, stop),
            AfterProcess::StopSecond(stop) => self.stop_final(host, stop),
        }
    }

    /// `stopProcess()`: end the process tree and wait (a little) until it is gone
    fn stop_process(&mut self, host: &mut dyn LocalMcpHost, after: AfterProcess) {
        self.clear_idle(host);
        let Some(child) = self.running.take() else {
            self.after_process(host, after);
            return;
        };
        if matches!(self.state, LocalMcpState::Running | LocalMcpState::Starting) {
            self.set_state(host, LocalMcpState::Idle);
        }
        self.with_client(host, child, |client, h| client.close(h));
        self.await_exit(host, child, ExitThen::Process(after));
    }

    /// `stop()`: end the process (calls under way end as tool errors); the next
    /// need starts it again
    pub fn stop(&mut self, host: &mut dyn LocalMcpHost, call: CallId) {
        self.stop_with(host, Some(call));
    }

    /// `app_abort`: `appSignal` aborted: `void connection.stop()`
    pub fn app_abort(&mut self, host: &mut dyn LocalMcpHost) {
        self.app_aborted = true;
        self.stop_with(host, None);
    }

    fn stop_with(&mut self, host: &mut dyn LocalMcpHost, who: Option<CallId>) {
        // lifetime.abort(); lifetime = new AbortController()
        self.lifetime += 1;
        for (child, op) in std::mem::take(&mut self.lifetime_clients) {
            self.with_client(host, child, |client, h| {
                client.on_abort(h, op, AbortReason::default_abort())
            });
        }
        self.restart_when_idle = false;
        let id = self.next_stop;
        self.next_stop += 1;
        let pending = self.starting.as_ref().map(|s| s.id);
        self.stops.push(StopCtx {
            id,
            who,
            pending,
            start_result: None,
            waiting_start: false,
        });
        self.stop_process(host, AfterProcess::StopFirst(id));
    }

    /// after `await stopProcess()` of `stop()`
    fn stop_first_done(&mut self, host: &mut dyn LocalMcpHost, stop: u64) {
        let Some(ctx) = self.stops.iter_mut().find(|s| s.id == stop) else {
            return;
        };
        if ctx.pending.is_none() {
            self.stop_final(host, stop);
            return;
        }
        match ctx.start_result {
            Some(_) => self.stop_start_settled(host, stop),
            None => ctx.waiting_start = true,
        }
    }

    /// `await pending.then(() => stopProcess(), () => undefined)`
    fn stop_start_settled(&mut self, host: &mut dyn LocalMcpHost, stop: u64) {
        let resolved = self
            .stops
            .iter()
            .find(|s| s.id == stop)
            .and_then(|s| s.start_result)
            .unwrap_or(false);
        if resolved {
            self.stop_process(host, AfterProcess::StopSecond(stop));
        } else {
            self.stop_final(host, stop);
        }
    }

    fn stop_final(&mut self, host: &mut dyn LocalMcpHost, stop: u64) {
        if matches!(self.state, LocalMcpState::Starting | LocalMcpState::Running) {
            self.set_state(host, LocalMcpState::Idle);
        }
        let Some(index) = self.stops.iter().position(|s| s.id == stop) else {
            return;
        };
        let ctx = self.stops.remove(index);
        if let Some(call) = ctx.who {
            host.settle(call, CallKind::Stop, Ok(CallOutcome::Stopped));
        }
    }

    // ---- configuration ----

    /// `retry()`: clear a failed state so the next need tries again
    pub fn retry(&mut self, host: &mut dyn LocalMcpHost) {
        self.failures = 0.0;
        if matches!(self.state, LocalMcpState::Failed { .. }) {
            let next = if launch_review_needed(&self.server.to_json()) {
                LocalMcpState::ReviewRequired
            } else {
                LocalMcpState::Idle
            };
            self.set_state(host, next);
        }
    }

    /// `setServer(next)`: a changed configuration. A launch that now needs
    /// approval stops at once; another change of the command, arguments or
    /// variables restarts the server once the calls under way have finished.
    pub fn set_server(&mut self, host: &mut dyn LocalMcpHost, next: McpServerConfig) {
        let before = std::mem::replace(&mut self.server, next.clone());
        let review_needed = launch_review_needed(&next.to_json());
        if review_needed || !next.enabled {
            if review_needed {
                self.set_state(host, LocalMcpState::ReviewRequired);
            }
            self.stop_with(host, None);
            return;
        }
        // a review the launcher found (another resolved program) ends only with a new approval
        if self.state == LocalMcpState::ReviewRequired
            && (!self.plan_review || before.approved_plan != next.approved_plan)
        {
            self.plan_review = false;
            self.set_state(host, LocalMcpState::Idle);
        }
        let launch_changed = before.command != next.command
            || before.args != next.args
            || sorted_env(&before.env) != sorted_env(&next.env);
        if !launch_changed {
            return;
        }
        // a new launch deserves a fresh try
        self.failures = 0.0;
        if matches!(self.state, LocalMcpState::Failed { .. }) {
            self.set_state(host, LocalMcpState::Idle);
        }
        if self.running.is_none() {
            return;
        }
        if self.busy == 0 {
            self.stop_process(host, AfterProcess::Nothing);
        } else {
            self.restart_when_idle = true;
        }
    }
}

/// `Object.entries(env).sort()`: the pairs ordered as their `key,value` strings
fn sorted_env(env: &JsObject<String>) -> Vec<(String, String)> {
    let mut entries: Vec<(String, String)> = env
        .entries()
        .into_iter()
        .map(|(key, value)| (key.to_owned(), value.clone()))
        .collect();
    entries.sort_by(|a, b| {
        format!("{},{}", a.0, a.1)
            .encode_utf16()
            .cmp(format!("{},{}", b.0, b.1).encode_utf16())
    });
    entries
}

/// The tools of a `tools/list` result as `ListedTool`s: `description`,
/// `inputSchema` and `annotations` only when the server sent them
fn listed_tools(result: &JsonValue) -> Vec<ListedTool> {
    let Some(tools) = result.get("tools") else {
        return Vec::new();
    };
    let JsonValue::Array(tools) = &*tools else {
        return Vec::new();
    };
    tools
        .iter()
        .map(|tool| {
            let name = match tool.get("name").as_deref() {
                Some(JsonValue::String(name)) => name.clone(),
                _ => String::new(),
            };
            let description = match tool.get("description").as_deref() {
                Some(JsonValue::String(description)) => Some(description.clone()),
                _ => None,
            };
            ListedTool {
                name,
                description,
                input_schema: tool.get("inputSchema").map(|v| v.into_owned()),
                annotations: tool.get("annotations").map(|v| v.into_owned()),
            }
        })
        .collect()
}

// ---- the hub's view of a connection ----

impl LocalMcpFailure {
    fn fail_reason(self) -> McpFailReason {
        match self {
            LocalMcpFailure::StartFailed => McpFailReason::StartFailed,
            LocalMcpFailure::RuntimeMissing => McpFailReason::RuntimeMissing,
        }
    }
}

impl LocalMcpProblem {
    /// the hub's `LocalLaunchProblem | 'did-not-start'`
    pub fn hub_problem(self) -> LocalProblem {
        match self {
            LocalMcpProblem::Launch(problem) => LocalProblem::Launch(problem),
            LocalMcpProblem::DidNotStart => LocalProblem::DidNotStart,
        }
    }
}

impl LocalMcpErrorReason {
    fn hub_reason(self) -> LocalReason {
        match self {
            LocalMcpErrorReason::Disabled => LocalReason::Disabled,
            LocalMcpErrorReason::ReviewRequired => LocalReason::ReviewRequired,
            LocalMcpErrorReason::StartFailed => LocalReason::StartFailed,
            LocalMcpErrorReason::RuntimeMissing => LocalReason::RuntimeMissing,
            LocalMcpErrorReason::Unreachable => LocalReason::Unreachable,
            LocalMcpErrorReason::Timeout => LocalReason::Timeout,
        }
    }
}

impl LocalMcpState {
    /// the hub's `LocalMcpState`
    pub fn hub_state(&self) -> LocalState {
        match self {
            LocalMcpState::Idle => LocalState::Idle,
            LocalMcpState::Starting => LocalState::Starting,
            LocalMcpState::Running => LocalState::Running,
            LocalMcpState::ReviewRequired => LocalState::ReviewRequired,
            LocalMcpState::Failed {
                reason,
                problem,
                message,
            } => LocalState::Failed {
                reason: reason.fail_reason(),
                problem: problem.hub_problem(),
                message: message.clone(),
            },
        }
    }
}

fn conn_error(failure: CallFailure) -> ConnError {
    match failure {
        CallFailure::Aborted => ConnError::Abort,
        CallFailure::Local(error) => ConnError::Local {
            reason: error.reason.hub_reason(),
            problem: error.problem.map(LocalMcpProblem::hub_problem),
        },
    }
}

/// What a call settled with, as the hub's `McpHub::on_settled` takes it: the
/// host calls this from [`LocalMcpHost::settle`] (and queues the result: the
/// hub is not re-entered from inside a method of the connection)
pub fn conn_outcome(kind: CallKind, outcome: Result<CallOutcome, CallFailure>) -> ConnOutcome {
    match (kind, outcome) {
        (CallKind::Ensure, outcome) => {
            ConnOutcome::Ensured(outcome.map(|_| ()).map_err(conn_error))
        }
        (CallKind::List, Ok(CallOutcome::Listing(listing))) => ConnOutcome::Listed(Ok(listing)),
        (CallKind::List, Err(failure)) => ConnOutcome::Listed(Err(conn_error(failure))),
        (CallKind::Tool, Ok(CallOutcome::Result(shaped))) => ConnOutcome::LocalCalled(Ok(shaped)),
        (CallKind::Tool, Err(failure)) => ConnOutcome::LocalCalled(Err(conn_error(failure))),
        (CallKind::List, Ok(_)) => ConnOutcome::Listed(Err(ConnError::Other)),
        (CallKind::Tool, Ok(_)) => ConnOutcome::LocalCalled(Err(ConnError::Other)),
        (CallKind::Stop, _) => ConnOutcome::Stopped,
    }
}

/// a call whose start waits for the next step, in case its signal is announced aborted
enum Deferred {
    Ensure(CallId),
    List(CallId),
    Tool(CallId, String, JsonValue),
}

/// The hub's `LocalConnection` over a [`LocalMcpConnection`] and its host.
/// Every operation's `AbortSignal` is [`CallSignal::Live`]; a signal the hub
/// announces aborted right after the start (`abort(op)` before anything else)
/// is [`CallSignal::Aborted`]: the start of an operation waits for the next
/// method or event so that this order is the TypeScript's (nothing starts
/// under an aborted signal). The connection reports state changes and tool
/// changes to the host under `conn` (the listener number); the host routes
/// them to `McpHub::on_local_state_changed` / `on_tools_changed`.
pub struct LocalMcpAdapter<'h> {
    conn: LocalMcpConnection,
    host: Rc<RefCell<dyn LocalMcpHost + 'h>>,
    deferred: Option<Deferred>,
}

impl<'h> LocalMcpAdapter<'h> {
    pub fn new(
        conn: ConnId,
        server: McpServerConfig,
        options: LocalMcpOptions,
        host: Rc<RefCell<dyn LocalMcpHost + 'h>>,
    ) -> Self {
        let mut connection = LocalMcpConnection::new(server, options);
        connection.add_state_listener(conn);
        connection.add_tools_listener(conn);
        LocalMcpAdapter {
            conn: connection,
            host,
            deferred: None,
        }
    }

    fn start(&mut self, deferred: Deferred, signal: CallSignal) {
        let mut host = self.host.borrow_mut();
        match deferred {
            Deferred::Ensure(op) => self.conn.ensure(&mut *host, op, signal),
            Deferred::List(op) => self.conn.list_tools(&mut *host, op, signal),
            Deferred::Tool(op, name, args) => {
                self.conn.call_tool(&mut *host, op, &name, args, signal)
            }
        }
    }

    fn flush(&mut self) {
        if let Some(deferred) = self.deferred.take() {
            self.start(deferred, CallSignal::Live);
        }
    }

    /// `child.stdout` `data`
    pub fn on_stdout(&mut self, child: ChildId, chunk: &[u8]) {
        self.flush();
        self.conn
            .on_stdout(&mut *self.host.borrow_mut(), child, chunk);
    }

    /// `child.stderr` `data`
    pub fn on_stderr(&mut self, child: ChildId, chunk: &[u8]) {
        self.flush();
        self.conn
            .on_stderr(&mut *self.host.borrow_mut(), child, chunk);
    }

    /// `child` `exit`
    pub fn on_child_exit(&mut self, child: ChildId) {
        self.flush();
        self.conn.on_child_exit(&mut *self.host.borrow_mut(), child);
    }

    /// `child` `close`
    pub fn on_child_close(&mut self, child: ChildId) {
        self.flush();
        self.conn
            .on_child_close(&mut *self.host.borrow_mut(), child);
    }

    /// `child` `error`
    pub fn on_child_error(&mut self, child: ChildId) {
        self.flush();
        self.conn
            .on_child_error(&mut *self.host.borrow_mut(), child);
    }

    /// `child.stdin` `error`
    pub fn on_stdin_error(&mut self, child: ChildId) {
        self.flush();
        self.conn
            .on_stdin_error(&mut *self.host.borrow_mut(), child);
    }

    /// a timer fires
    pub fn on_timeout(&mut self, timer: u64) -> bool {
        self.flush();
        self.conn.on_timeout(&mut *self.host.borrow_mut(), timer)
    }
}

impl LocalConnection for LocalMcpAdapter<'_> {
    fn status(&self) -> LocalState {
        self.conn.status().hub_state()
    }

    fn stderr_tail(&self) -> Vec<String> {
        self.conn.stderr_tail()
    }

    fn ensure(&mut self, op: HubOpId) {
        self.flush();
        self.deferred = Some(Deferred::Ensure(op));
    }

    fn list_tools(&mut self, op: HubOpId) {
        self.flush();
        self.deferred = Some(Deferred::List(op));
    }

    fn call_tool(&mut self, op: HubOpId, name: &str, args: &JsonValue) {
        self.flush();
        self.deferred = Some(Deferred::Tool(op, name.to_owned(), args.clone()));
    }

    fn stop(&mut self, op: HubOpId) {
        self.flush();
        self.conn.stop(&mut *self.host.borrow_mut(), op);
    }

    fn retry(&mut self) {
        self.flush();
        self.conn.retry(&mut *self.host.borrow_mut());
    }

    fn set_server(&mut self, server: &McpServerConfig) {
        self.flush();
        self.conn
            .set_server(&mut *self.host.borrow_mut(), server.clone());
    }

    fn abort(&mut self, op: HubOpId) {
        let announced_first = match &self.deferred {
            Some(Deferred::Ensure(id) | Deferred::List(id) | Deferred::Tool(id, ..)) => *id == op,
            None => false,
        };
        if announced_first {
            if let Some(deferred) = self.deferred.take() {
                self.start(deferred, CallSignal::Aborted);
            }
            return;
        }
        self.flush();
        self.conn.abort(&mut *self.host.borrow_mut(), op);
    }

    fn abort_app(&mut self) {
        self.flush();
        self.conn.app_abort(&mut *self.host.borrow_mut());
    }
}
