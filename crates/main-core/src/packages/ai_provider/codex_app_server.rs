//! `packages/ai-provider/src/codex-app-server.ts`: the JSON-RPC bridge to
//! `codex app-server`, which this app uses as a language-model backend.
//!
//! ## What the caller owns
//!
//! The module variables of the TypeScript (the pool `clients`, `codexOff`,
//! `statusLoginKind`, the `runtime` of `setCodexAppServerRuntime`) are
//! [`CodexAppServerState`]; every call takes it as [`CodexApp`]. The two
//! `WeakMap`s (`listedModels`, `defaultModels`) are fields of the client they
//! belong to: an entry is gone with its process, as in the TypeScript.
//!
//! `setCodexAppServerRuntime` is [`CodexAppServerRuntime`], a field of the
//! state: `resolve` and `kill_tree` replace the real lookup and the real
//! `killProcessTree`. Its `spawn` hook (the process spawner handed to
//! `spawnSubscriptionProgram`) is not ported: the host behind
//! [`Rt::spawn`] is the spawner, and the comparison scripts it.
//!
//! The four calls the TypeScript makes at import time (`onSubscriptionLoginChange`,
//! `onSubscriptionOffChange`, `setCodexAccountSource`,
//! `setSubscriptionModelSource('codex', ...)`) are the functions of
//! [`CodexHooks`], which [`codex_hooks`] builds; the caller hands each to the
//! module that owns the registry.
//!
//! ## The process
//!
//! A [`CodexAppServerClient`] is one child on stdio. Its stdout is read as
//! lines ([`BoundedRpcStdout`], capped at [`MAX_RPC_LINE_BYTES`]), each line
//! a JSON-RPC message; a request is [`CodexAppServerClient::request`]. Where
//! the TypeScript starts a request synchronously and lets its promise run on
//! (`void requestWire(...)`), the port starts it at once too
//! ([`CodexAppServerClient::request_wire_start`]) and drops the answer.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{
    JsMap, JsonValue, buffer_from_base64, js_regex, json_parse, json_stringify, math_max,
    node_path::host, number_to_string, slice_utf16, trim,
};
use sha2::{Digest, Sha256};

use super::effort::{ai_effort_of, ai_efforts_of};
use super::jsval::{
    Obj, as_record, as_str, assign, entries_of, length16, number, object, prop, spread, text,
};
use super::protocols_shared::{
    StreamCallbacks, parse_tool_input, throw_if_tool_count_over_budget,
    throw_if_tool_json_over_budget,
};
use super::run_error::ai_run_error;
use super::subscription_contract::subscription_models_of;
use super::subscription_locate::{
    SubscriptionLocateOptions, SubscriptionProgram, resolve_subscription_program,
};
use super::subscription_process::{
    KillHost, KillTreeOptions, KillerSpawn, Signal as KillSignal, SubscriptionSpawnOptions,
    kill_process_tree, on_kill_timeout, on_killer_error, spawn_subscription_program,
};
use super::subscription_status::codex_account_info;
use super::subscription_temp_dirs::{
    SubscriptionTempDirsState, TempDirOptions, create_tracked_temp_dir, remove_tracked_temp_dir,
};
use super::task::{
    Child, ChildEvent, Id, JsError, LocalBoxFuture, Rt, Settle, SpawnRequest, Stdio, StringDecoder,
    Wait,
};
use super::task::{FsOp, Signal};
use super::types::AiChatResponse;
use super::watchdog::create_stream_watchdog;
use crate::packages::i18n::PRODUCT_NAME;

const DIAGNOSTIC_LIMIT: usize = 16_000;
const REQUEST_TIMEOUT_MS: f64 = 30_000.0;
const IDLE_SHUTDOWN_MS: f64 = 120_000.0;
const MAX_NATIVE_SESSIONS: usize = 64;
const MAX_MODEL_PAGES: usize = 10;
const MAX_MCP_STATUS_PAGES: usize = 10;
const CODEX_TEMP_PREFIX: &str = "seuoffice-codex-app-server-";
const RATE_LIMIT_READ_TIMEOUT_MS: f64 = 5_000.0;
const CODEX_PERMISSION_PROFILE: &str = "seuoffice";

/// How this client names itself to Codex, which passes it on to OpenAI: the
/// product, not the project it is based on. Also the tag around a turn's payload.
fn codex_client_name() -> String {
    PRODUCT_NAME.to_lowercase()
}

/// `CODEX_BASE_INSTRUCTIONS`
fn codex_base_instructions() -> String {
    format!(
        "You are the language-model backend embedded in {PRODUCT_NAME}. Never inspect or modify local files, run shell commands, browse, call MCP, use apps, or invoke any built-in Codex tool. The caller supplies the complete relevant conversation and a JSON Schema. Return exactly one assistant response matching that schema; {PRODUCT_NAME} itself executes document tools."
    )
}

/// Max buffered stdout line: a child that writes megabytes without a newline
/// would grow the RPC buffer until the process dies.
pub const MAX_RPC_LINE_BYTES: usize = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// reading unknown values
// ---------------------------------------------------------------------------

/// `objectValue(value)`: `value && typeof value === 'object'`, which holds for
/// an object and for an array. A property of an array is `undefined` here
/// (none of the names read below is an index); `Object.keys` and
/// `Object.values` of it list its items.
#[derive(Clone, Copy)]
struct Like<'a>(&'a JsonValue);

fn like(value: Option<&JsonValue>) -> Option<Like<'_>> {
    match value {
        Some(v @ (JsonValue::Object(_) | JsonValue::Array(_))) => Some(Like(v)),
        _ => None,
    }
}

impl<'a> Like<'a> {
    fn get(self, key: &str) -> Option<&'a JsonValue> {
        match self.0 {
            JsonValue::Object(o) => o.get(key),
            _ => None,
        }
    }

    /// `Object.entries(value)`
    fn entries(self) -> Vec<(String, JsonValue)> {
        entries_of(self.0)
    }
}

/// `value?.key` over an `objectValue`
fn lget<'a>(value: Option<Like<'a>>, key: &str) -> Option<&'a JsonValue> {
    value.and_then(|v| v.get(key))
}

/// `finiteNumber(value)`
fn finite_number(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(x)) if x.is_finite() => Some(*x),
        _ => None,
    }
}

/// `value === true`
fn is_true(value: Option<&JsonValue>) -> bool {
    matches!(value, Some(JsonValue::Bool(true)))
}

fn sha256_hex(input: &str) -> String {
    let digest = Sha256::digest(input.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// messages and errors
// ---------------------------------------------------------------------------

/// `RpcMessage`: the fields a message of the app-server may carry. A field
/// the line did not have is `None`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RpcMessage {
    pub id: Option<JsonValue>,
    pub method: Option<JsonValue>,
    pub params: Option<JsonValue>,
    pub result: Option<JsonValue>,
    pub error: Option<JsonValue>,
}

impl RpcMessage {
    /// A parsed line read as an `RpcMessage`: the fields of an object, none
    /// for any other value (a property of a number, a string or an array is
    /// `undefined`).
    fn of(value: &JsonValue) -> RpcMessage {
        let field = |key: &str| as_record(value).and_then(|o| o.get(key)).cloned();
        RpcMessage {
            id: field("id"),
            method: field("method"),
            params: field("params"),
            result: field("result"),
            error: field("error"),
        }
    }

    /// `typeof message.method === 'string'`
    pub fn method_str(&self) -> Option<&str> {
        as_str(self.method.as_ref())
    }
}

fn unsafe_tools_error(message: &str) -> JsError {
    ai_run_error("unsafe-tools", message, Some("codex"), None)
}

fn signed_out_error() -> JsError {
    ai_run_error(
        "signed-out",
        "Codex CLI is not signed in. Run codex login, then try again.",
        Some("codex"),
        None,
    )
}

/// `cancelledError()`
fn cancelled_error() -> JsError {
    JsError::error("Codex app-server request was cancelled").named("AbortError")
}

/// `abortError()`
fn abort_error() -> JsError {
    JsError::error("The Codex account check was cancelled").named("AbortError")
}

/// `rpcError(error)`
fn rpc_error(error: Option<&JsonValue>) -> JsError {
    let value = like(error);
    let message = as_str(lget(value, "message")).unwrap_or("Unknown app-server error");
    let code = match lget(value, "code") {
        Some(JsonValue::Number(code)) => format!(" ({})", number_to_string(*code)),
        _ => String::new(),
    };
    let data = match lget(value, "data") {
        None => String::new(),
        Some(data) => format!(": {}", json_stringify(data)),
    };
    JsError::error(format!("Codex app-server error{code}: {message}{data}"))
}

/// `appendDiagnostic(current, chunk)`
fn append_diagnostic(current: &str, chunk: &str) -> String {
    let next = format!("{current}{chunk}");
    if length16(&next) <= DIAGNOSTIC_LIMIT {
        next
    } else {
        slice_utf16(&next, -(DIAGNOSTIC_LIMIT as f64), None)
    }
}

/// `error instanceof Error ? error : new Error(String(error))`
fn as_error(error: JsError) -> JsError {
    if error.is_error() {
        error
    } else {
        JsError::error(error.to_js_string())
    }
}

// ---------------------------------------------------------------------------
// the bounded stdout reader
// ---------------------------------------------------------------------------

/// `attachBoundedRpcStdout`'s state: the child's stdout split into RPC lines,
/// with a cap on the line being buffered. Over the cap the reader stops, the
/// child is killed and `on_overflow` reports a bounded diagnostic, which fails
/// every in-flight request instead of letting the buffer grow. A trailing line
/// without a newline is still delivered when the stream ends. A failing
/// `on_line` is reported through `on_overflow` the same way.
pub struct BoundedRpcStdout {
    /// a multi-byte UTF-8 sequence that straddles two chunks stays intact
    decoder: StringDecoder,
    pending: String,
    /// UTF-8 bytes buffered for the current line, including any partial
    /// sequence held by the decoder
    pending_bytes: usize,
    stopped: bool,
    on_line: Box<dyn FnMut(&str) -> Result<(), JsError>>,
    on_overflow: Box<dyn FnMut(JsError)>,
    kill: Box<dyn FnMut()>,
}

impl BoundedRpcStdout {
    pub fn new(
        kill: impl FnMut() + 'static,
        on_line: impl FnMut(&str) -> Result<(), JsError> + 'static,
        on_overflow: impl FnMut(JsError) + 'static,
    ) -> BoundedRpcStdout {
        BoundedRpcStdout {
            decoder: StringDecoder::new(),
            pending: String::new(),
            pending_bytes: 0,
            stopped: false,
            on_line: Box::new(on_line),
            on_overflow: Box::new(on_overflow),
            kill: Box::new(kill),
        }
    }

    /// `emit(line)`
    fn emit(&mut self, line: &str) {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Err(error) = (self.on_line)(line) {
            // `onLine` writes back to the child (rejecting an unsupported server request, for
            // one) and fails once stdin is no longer writable, which is a normal shutdown race
            // while buffered stdout lines are still being delivered.
            self.stopped = true;
            self.pending.clear();
            self.pending_bytes = 0;
            (self.on_overflow)(as_error(error));
        }
    }

    /// `flush`: the stream ended (`'end'` or `'close'`)
    pub fn end(&mut self) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        let tail = format!("{}{}", self.pending, self.decoder.end());
        self.pending.clear();
        self.pending_bytes = 0;
        if !tail.is_empty() {
            self.emit(&tail);
        }
    }

    /// `child.stdout.on('data', chunk => ...)`
    pub fn data(&mut self, chunk: &[u8]) {
        if self.stopped {
            return;
        }
        let decoded = self.decoder.write(chunk);
        self.pending.push_str(&decoded);
        let all = std::mem::take(&mut self.pending);
        let mut parts: Vec<String> = all.split('\n').map(str::to_owned).collect();
        self.pending = parts.pop().unwrap_or_default();
        if parts.is_empty() {
            self.pending_bytes += chunk.len();
        } else {
            self.pending_bytes = self.pending.len();
            for part in parts {
                self.emit(&part);
                if self.stopped {
                    return;
                }
            }
        }
        if self.pending_bytes > MAX_RPC_LINE_BYTES {
            self.stopped = true;
            self.pending.clear();
            self.pending_bytes = 0;
            (self.on_overflow)(JsError::error(format!(
                "Codex app-server stdout line exceeded {MAX_RPC_LINE_BYTES} bytes without a newline; the child was stopped"
            )));
            (self.kill)();
        }
    }
}

/// `attachBoundedRpcStdout(child, onLine, onOverflow)` for an `onLine` that
/// fails: `kill` is `child.kill()`.
pub fn attach_bounded_rpc_stdout_fallible(
    child: &Child,
    kill: impl FnMut() + 'static,
    on_line: impl FnMut(&str) -> Result<(), JsError> + 'static,
    on_overflow: impl FnMut(JsError) + 'static,
) {
    let reader = Rc::new(RefCell::new(BoundedRpcStdout::new(
        kill,
        on_line,
        on_overflow,
    )));
    child.on(move |event| match event {
        ChildEvent::Stdout(chunk) => reader.borrow_mut().data(chunk),
        // the stdout stream ends with the child's streams
        ChildEvent::Close { .. } => reader.borrow_mut().end(),
        _ => {}
    });
}

/// `attachBoundedRpcStdout(child, onLine, onOverflow)`: registers the
/// reader on the child's events; `kill` ends the child on an overflow.
pub fn attach_bounded_rpc_stdout(
    child: &Child,
    kill: impl Fn() + 'static,
    mut on_line: impl FnMut(&str) + 'static,
    on_overflow: impl FnMut(JsError) + 'static,
) {
    attach_bounded_rpc_stdout_fallible(
        child,
        move || kill(),
        move |line| {
            on_line(line);
            Ok(())
        },
        on_overflow,
    );
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

/// `codex app-server` has no switch that skips the user's `config.toml` (only
/// `codex exec` has one), so each thing that file can bring into a run is
/// overridden here. Feature switches go through `-c features.<name>=false`: an
/// unknown name there is a warning, while after `--disable` it stops Codex from
/// starting. The login is untouched; it is read from the same Codex home.
/// MCP servers are named tables that cannot be emptied from here; they are
/// switched off per thread (see [`codex_mcp_server_overrides`]).
pub const CODEX_CONFIG_OVERRIDES: &[&str] = &[
    // user hooks, plugins (with their MCP servers, skills and hooks), ChatGPT
    // connectors, and personal memories
    "features.hooks=false",
    "features.plugins=false",
    "features.apps=false",
    "features.memories=false",
    // the program the user has Codex run after each turn
    "notify=[]",
    // no prompt history file
    "history.persistence=\"none\"",
    // the built-in OpenAI provider on its default address, whatever provider or
    // address (a proxy, another vendor) the user configured: empty is "not set"
    "model_provider=\"openai\"",
    "openai_base_url=\"\"",
    // the list of the user's skills is not added to the prompt
    "skills.include_instructions=false",
    // Codex's own web search: a way out the app neither sees nor guards
    "web_search=\"disabled\"",
];

/// `codexAppServerLaunchArgs()`
pub fn codex_app_server_launch_args() -> Vec<String> {
    let mut args = vec!["app-server".to_owned()];
    for override_ in CODEX_CONFIG_OVERRIDES {
        args.push("-c".to_owned());
        args.push((*override_).to_owned());
    }
    args.push("--listen".to_owned());
    args.push("stdio://".to_owned());
    args
}

/// A hook that finds the Codex program: `resolveSubscriptionProgram`'s
/// replacement (`CodexAppServerRuntime.resolve`).
pub type ResolveHook = Rc<
    dyn Fn(
        &Rt,
        &str,
        &SubscriptionLocateOptions,
    ) -> LocalBoxFuture<Result<SubscriptionProgram, JsError>>,
>;

/// A hook that ends a child's process tree (`CodexAppServerRuntime.killTree`).
pub type KillTreeHook = Rc<dyn Fn(&Rt, &Child)>;

/// `CodexAppServerRuntime`: how the bridge finds and ends the Codex program.
/// `None` is the real one.
#[derive(Clone, Default)]
pub struct CodexAppServerRuntime {
    pub resolve: Option<ResolveHook>,
    pub kill_tree: Option<KillTreeHook>,
}

/// What `killProcessTree` calls of the process, over the runtime: the
/// signals are commands to the host, the grace timer is a runtime timer, and
/// the taskkill child of Windows is started as a promise left to run.
struct RtKillHost {
    rt: Rt,
}

impl KillHost for RtKillHost {
    fn process_platform(&self) -> String {
        self.rt.platform()
    }

    fn env_var(&self, key: &str) -> Option<String> {
        self.rt.env(key)
    }

    fn kill(&mut self, pid: f64, signal: Option<KillSignal>) -> Result<(), String> {
        self.rt.kill_pid(pid, signal.map(KillSignal::as_str));
        Ok(())
    }

    fn spawn_killer(
        &mut self,
        pid: f64,
        command: &str,
        args: &[String],
        options: &KillerSpawn,
    ) -> Result<u64, String> {
        let rt = self.rt.clone();
        let request = SpawnRequest {
            command: command.to_owned(),
            args: args.to_vec(),
            cwd: Some(options.cwd.clone()),
            env: None,
            stdio: [Stdio::Ignore, Stdio::Ignore, Stdio::Ignore],
            detached: false,
            windows_hide: options.windows_hide,
            shell: None,
        };
        self.rt.spawn_local(async move {
            match rt.spawn(request).await {
                Ok(killer) => {
                    let on_error = rt.clone();
                    killer.on(move |event| {
                        if matches!(event, ChildEvent::Error(_)) {
                            on_killer_error(
                                pid,
                                &mut RtKillHost {
                                    rt: on_error.clone(),
                                },
                            );
                        }
                    });
                }
                Err(_) => on_killer_error(pid, &mut RtKillHost { rt }),
            }
        });
        Ok(0)
    }

    fn unref_killer(&mut self, _killer: u64) -> Result<(), String> {
        Ok(())
    }

    fn set_kill_timeout(&mut self, ms: f64, pid: f64) -> u64 {
        let rt = self.rt.clone();
        self.rt
            .set_timeout(ms, move || on_kill_timeout(pid, &mut RtKillHost { rt }))
    }

    fn unref_timer(&mut self, _timer: u64) {}
}

/// `killProcessTree(child)`
fn real_kill_tree(rt: &Rt, child: &Child) {
    kill_process_tree(
        child.pid(),
        &KillTreeOptions::default(),
        &mut RtKillHost { rt: rt.clone() },
    );
}

// ---------------------------------------------------------------------------
// the module state
// ---------------------------------------------------------------------------

/// The variables of `codex-app-server.ts`, which the caller owns.
#[derive(Default)]
pub struct CodexAppServerState {
    /// `runtime`
    pub runtime: CodexAppServerRuntime,
    /// the pool, by the entry of the program (lower case on Windows)
    clients: JsMap<CodexAppServerClient>,
    /// Codex is turned off in this app (decision 0114). A process started
    /// meanwhile, for a request that chose Codex before the switch, serves that
    /// request and ends; none joins the pool.
    pub codex_off: bool,
    /// the kind of login the status check last read through this bridge
    /// (`signed-out` when it found none); `None` until a status check ran
    pub status_login_kind: Option<String>,
    /// the state of `subscription/temp-dirs.ts`, which the session folders go through
    pub temp_dirs: Rc<RefCell<SubscriptionTempDirsState>>,
    /// the next token that names a cached reading
    next_token: u64,
}

/// What every call of this module takes.
pub type CodexApp = Rc<RefCell<CodexAppServerState>>;

/// `shutdownCodexAppServers()`: stop every child process during shutdown or
/// integration-test cleanup.
pub fn shutdown_codex_app_servers(app: &CodexApp) {
    let clients: Vec<CodexAppServerClient> = app.borrow().clients.values().cloned().collect();
    for client in clients {
        client.stop(None);
    }
    app.borrow_mut().clients.clear();
}

/// `retireCodexAppServers()`: the app ran Codex's own login or logout, or
/// Codex was turned off in this app. A running app-server may go on with the
/// login it started with, and one turned off must not stay: none of them
/// serves another request. Each is ended at once when idle, and after the runs
/// it is serving otherwise. The next request starts a process of its own.
pub fn retire_codex_app_servers(app: &CodexApp) {
    let clients: Vec<(String, CodexAppServerClient)> = app
        .borrow()
        .clients
        .iter()
        .map(|(key, client)| (key.to_owned(), client.clone()))
        .collect();
    for (key, client) in clients {
        app.borrow_mut().clients.delete(&key);
        client.end_once_unused();
    }
}

/// The calls the module makes at import time, for the modules that own the
/// registries to keep.
pub struct CodexHooks {
    /// `onSubscriptionLoginChange((provider) => ...)`
    pub login_change: Rc<dyn Fn(&str)>,
    /// `onSubscriptionOffChange(({ provider, off }) => ...)`
    pub off_change: Rc<dyn Fn(&str, bool)>,
    /// `setCodexAccountSource(({ configuredPath, signal }) => ...)`
    pub account_source:
        Rc<dyn Fn(&Rt, Option<String>, Signal) -> LocalBoxFuture<Result<JsonValue, JsError>>>,
    /// `setSubscriptionModelSource('codex', ({ configuredPath, signal }) => ...)`
    pub model_source:
        Rc<dyn Fn(&Rt, Option<String>, Signal) -> LocalBoxFuture<Result<JsonValue, JsError>>>,
}

/// The hooks of this module over `app`.
pub fn codex_hooks(app: &CodexApp) -> CodexHooks {
    let login_app = app.clone();
    let off_app = app.clone();
    let account_app = app.clone();
    let models_app = app.clone();
    CodexHooks {
        login_change: Rc::new(move |provider: &str| {
            if provider == "codex" {
                retire_codex_app_servers(&login_app);
            }
        }),
        off_change: Rc::new(move |provider: &str, off: bool| {
            if provider != "codex" {
                return;
            }
            off_app.borrow_mut().codex_off = off;
            if off {
                retire_codex_app_servers(&off_app);
            }
        }),
        account_source: Rc::new(
            move |rt: &Rt,
                  configured_path: Option<String>,
                  signal: Signal|
                  -> LocalBoxFuture<Result<JsonValue, JsError>> {
                let rt = rt.clone();
                let app = account_app.clone();
                Box::pin(async move {
                    read_codex_account(&rt, &app, configured_path.as_deref(), Some(&signal)).await
                })
            },
        ),
        model_source: Rc::new(
            move |rt: &Rt,
                  configured_path: Option<String>,
                  signal: Signal|
                  -> LocalBoxFuture<Result<JsonValue, JsError>> {
                let rt = rt.clone();
                let app = models_app.clone();
                Box::pin(async move {
                    list_codex_subscription_models(
                        &rt,
                        &app,
                        configured_path.as_deref(),
                        Some(&signal),
                    )
                    .await
                })
            },
        ),
    }
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

/// `NativeSession`
#[derive(Debug, Clone, PartialEq)]
pub struct NativeSession {
    pub thread_id: String,
    pub signature: String,
    pub message_fingerprints: Vec<String>,
    /// Created with the thread and kept alive as long as it: the thread's cwd and
    /// permission profile are bound to this path, and later localImage files land
    /// here. Removed only when the session is dropped.
    pub temp_dir: String,
}

/// A session as the client holds it: the object the TypeScript passes around.
pub type SessionRef = Rc<RefCell<NativeSession>>;

struct Pending {
    settle: Settle<Result<JsonValue, JsError>>,
    timer: Id,
}

#[derive(Default)]
struct ClientState {
    pending: Vec<(f64, Pending)>,
    notification_listeners: Vec<(u64, Rc<dyn Fn(&RpcMessage)>)>,
    sessions: JsMap<SessionRef>,
    next_id: f64,
    next_listener: u64,
    stderr: String,
    closed: bool,
    users: usize,
    idle_timer: Option<Id>,
    close_listeners: Vec<(u64, Rc<dyn Fn(&JsError)>)>,
    stop_when_released: bool,
    /// the list this process gave, read once (`listedModels`)
    listed_models: Option<(u64, Wait<Result<Vec<JsonValue>, JsError>>)>,
    /// the default model this process listed (`defaultModels`)
    default_models: Option<(u64, Wait<Result<String, JsError>>)>,
}

struct ClientInner {
    rt: Rt,
    app: CodexApp,
    key: String,
    /// `None` while the process is being started
    child: RefCell<Option<Child>>,
    st: RefCell<ClientState>,
    /// `this.initialized`
    initialized: Wait<Result<(), JsError>>,
    init: Settle<Result<(), JsError>>,
}

/// `CodexAppServerClient`: one `codex app-server` process.
#[derive(Clone)]
pub struct CodexAppServerClient(Rc<ClientInner>);

impl CodexAppServerClient {
    /// `new CodexAppServerClient(program, onClosed)`. Sanitised environment, no
    /// shell, registered so that quitting or crashing ends it. The temp dir as
    /// working directory keeps the project configuration of wherever the app
    /// was started out of the process.
    fn starting(rt: &Rt, app: &CodexApp, key: &str) -> CodexAppServerClient {
        let (init, initialized) = rt.deferred::<Result<(), JsError>>();
        CodexAppServerClient(Rc::new(ClientInner {
            rt: rt.clone(),
            app: app.clone(),
            key: key.to_owned(),
            child: RefCell::new(None),
            st: RefCell::new(ClientState {
                next_id: 1.0,
                ..ClientState::default()
            }),
            initialized,
            init,
        }))
    }

    /// The part of the constructor that starts the process. The TypeScript
    /// spawns synchronously, so the client is in the pool before anything is
    /// awaited; here the pool holds it from [`CodexAppServerClient::starting`]
    /// on, and [`CodexAppServerClient::ready`] waits for the process.
    async fn launch(&self, program: &SubscriptionProgram) -> Result<(), JsError> {
        let rt = &self.0.rt;
        let child = spawn_subscription_program(
            rt,
            program,
            &codex_app_server_launch_args(),
            &SubscriptionSpawnOptions {
                cwd: Some(rt.tmpdir()),
                stdio: Some([Stdio::Pipe, Stdio::Pipe, Stdio::Pipe]),
                ..SubscriptionSpawnOptions::default()
            },
        )
        .await?;
        *self.0.child.borrow_mut() = Some(child.clone());
        let client = self.clone();
        let kill_client = client.clone();
        let line_client = client.clone();
        let overflow_client = client.clone();
        attach_bounded_rpc_stdout_fallible(
            &child,
            move || kill_client.kill_tree(),
            move |line| line_client.on_line(line),
            move |error| overflow_client.fail(error),
        );
        let on_child = client.clone();
        child.on(move |event| match event {
            ChildEvent::Stderr(chunk) => {
                let mut st = on_child.0.st.borrow_mut();
                st.stderr = append_diagnostic(&st.stderr, &String::from_utf8_lossy(chunk));
            }
            ChildEvent::Error(error) => {
                let code = error.props.get("code");
                on_child.fail(if as_str(code) == Some("ENOENT") {
                    ai_run_error(
                        "not-installed",
                        "Codex CLI was not found",
                        Some("codex"),
                        None,
                    )
                } else {
                    error.clone()
                });
            }
            ChildEvent::Close { code, .. } => {
                let detail = trim(&on_child.0.st.borrow().stderr).to_owned();
                let code = code.map_or_else(|| "unknown".to_owned(), number_to_string);
                let suffix = if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                };
                on_child.fail(JsError::error(format!(
                    "Codex app-server exited ({code}){suffix}"
                )));
            }
            _ => {}
        });
        client.begin_initialize();
        Ok(())
    }

    /// `this.initialized = this.initialize()`: the `initialize` request starts
    /// at once, the `initialized` notification follows its answer.
    fn begin_initialize(&self) {
        let params = object(vec![
            (
                "clientInfo",
                object(vec![
                    ("name", text(codex_client_name())),
                    ("title", text(PRODUCT_NAME)),
                    ("version", text("0.1.0")),
                ]),
            ),
            (
                "capabilities",
                object(vec![
                    ("experimentalApi", JsonValue::Bool(false)),
                    ("requestAttestation", JsonValue::Bool(false)),
                ]),
            ),
        ]);
        let started = self.request_wire_start("initialize", Some(&params), REQUEST_TIMEOUT_MS);
        let client = self.clone();
        self.0.rt.spawn_local(async move {
            let outcome = async {
                started?.await?;
                client.notify("initialized", None)
            }
            .await;
            client.0.init.settle(outcome);
        });
    }

    /// `get isClosed()`
    pub fn is_closed(&self) -> bool {
        self.0.st.borrow().closed
    }

    /// The module state this client belongs to.
    pub fn app(&self) -> &CodexApp {
        &self.0.app
    }

    /// `retain()`
    pub fn retain(&self) {
        let timer = {
            let mut st = self.0.st.borrow_mut();
            st.users += 1;
            st.idle_timer.take()
        };
        self.0.rt.clear_timeout(timer);
    }

    /// `release()`
    pub fn release(&self) {
        let stop = {
            let mut st = self.0.st.borrow_mut();
            st.users = st.users.saturating_sub(1);
            if st.users > 0 || st.closed {
                return;
            }
            st.stop_when_released
        };
        if stop {
            self.close(None);
            return;
        }
        let client = self.clone();
        let timer = self
            .0
            .rt
            .set_timeout(IDLE_SHUTDOWN_MS, move || client.close(None));
        self.0.st.borrow_mut().idle_timer = Some(timer);
    }

    /// A cancelled run must not leave the process, or anything it started,
    /// behind. The process is shared, so it ends as soon as no other run is
    /// using it.
    pub fn stop_when_unused(&self) {
        self.0.st.borrow_mut().stop_when_released = true;
    }

    /// The process is out of date (it holds a login that was since changed): it
    /// ends now when no run is using it, otherwise as soon as the last of them
    /// is done.
    pub fn end_once_unused(&self) {
        let unused = {
            let mut st = self.0.st.borrow_mut();
            st.stop_when_released = true;
            st.users == 0
        };
        if unused {
            self.close(None);
        }
    }

    /// `ready()`
    pub async fn ready(&self) -> Result<(), JsError> {
        self.0.initialized.clone().await
    }

    /// `request(method, params)` with the default timeout.
    pub async fn request(
        &self,
        method: &str,
        params: Option<&JsonValue>,
    ) -> Result<JsonValue, JsError> {
        self.ready().await?;
        self.request_wire(method, params, REQUEST_TIMEOUT_MS).await
    }

    /// `notify(method, params)`
    pub fn notify(&self, method: &str, params: Option<&JsonValue>) -> Result<(), JsError> {
        let mut message = vec![("method", text(method))];
        if let Some(params) = params {
            message.push(("params", params.clone()));
        }
        self.write(&object(message))
    }

    /// `onNotification(listener)`: answers the function that stops the listening.
    pub fn on_notification(&self, listener: Rc<dyn Fn(&RpcMessage)>) -> Rc<dyn Fn()> {
        let id = {
            let mut st = self.0.st.borrow_mut();
            st.next_listener += 1;
            let id = st.next_listener;
            st.notification_listeners.push((id, listener));
            id
        };
        let client = self.clone();
        Rc::new(move || {
            client
                .0
                .st
                .borrow_mut()
                .notification_listeners
                .retain(|(listener, _)| *listener != id);
        })
    }

    /// `onClose(listener)`: called once with the reason when the process is
    /// gone, however it ended.
    pub fn on_close(&self, listener: Rc<dyn Fn(&JsError)>) -> Rc<dyn Fn()> {
        let id = {
            let mut st = self.0.st.borrow_mut();
            st.next_listener += 1;
            let id = st.next_listener;
            st.close_listeners.push((id, listener));
            id
        };
        let client = self.clone();
        Rc::new(move || {
            client
                .0
                .st
                .borrow_mut()
                .close_listeners
                .retain(|(listener, _)| *listener != id);
        })
    }

    /// `getSession(id)`
    pub fn get_session(&self, id: &str) -> Option<SessionRef> {
        self.0.st.borrow().sessions.get(id).cloned()
    }

    /// `setSession(id, session)`
    pub fn set_session(&self, id: &str, session: SessionRef) {
        let mut evicted_sessions = Vec::new();
        {
            let mut st = self.0.st.borrow_mut();
            st.sessions.delete(id);
            st.sessions.set(id, session);
            while st.sessions.len() > MAX_NATIVE_SESSIONS {
                let Some(oldest) = st.sessions.keys().next().map(str::to_owned) else {
                    break;
                };
                if let Some(evicted) = st.sessions.delete(&oldest) {
                    evicted_sessions.push(evicted);
                }
            }
        }
        for evicted in evicted_sessions {
            self.dispose_session(&evicted.borrow(), true);
        }
    }

    /// `deleteSession(id)`
    pub fn delete_session(&self, id: &str) {
        let session = self.0.st.borrow_mut().sessions.delete(id);
        if let Some(session) = session {
            self.dispose_session(&session.borrow(), true);
        }
    }

    /// Drop a session's temp dir and, when the process is still alive, its
    /// native thread. `signal` is false during shutdown, where the child is
    /// already gone.
    fn dispose_session(&self, session: &NativeSession, signal: bool) {
        let rt = self.0.rt.clone();
        let temp_dirs = self.0.app.borrow().temp_dirs.clone();
        let path = session.temp_dir.clone();
        rt.spawn_local({
            let rt = rt.clone();
            async move {
                remove_tracked_temp_dir(&rt, &temp_dirs, &path, &TempDirOptions::default()).await;
            }
        });
        if signal && !self.is_closed() {
            let params = object(vec![("threadId", text(&session.thread_id))]);
            // the answer is not awaited: `.catch(() => undefined)`
            let _ = self.request_wire_start("thread/delete", Some(&params), REQUEST_TIMEOUT_MS);
        }
    }

    /// `stop(reason)`
    pub fn stop(&self, reason: Option<JsError>) {
        self.close(reason);
    }

    /// `requestWire(method, params, timeoutMs)` as far as it runs before its
    /// first `await`: the request is registered and written. The `Err` is the
    /// rejection of the promise the TypeScript returns.
    pub fn request_wire_start(
        &self,
        method: &str,
        params: Option<&JsonValue>,
        timeout_ms: f64,
    ) -> Result<Wait<Result<JsonValue, JsError>>, JsError> {
        if self.is_closed() {
            return Err(JsError::error("Codex app-server is not running"));
        }
        let id = {
            let mut st = self.0.st.borrow_mut();
            let id = st.next_id;
            st.next_id += 1.0;
            id
        };
        let (settle, wait) = self.0.rt.deferred::<Result<JsonValue, JsError>>();
        let client = self.clone();
        let timed_out = settle.clone();
        let method_name = method.to_owned();
        let timer = self.0.rt.set_timeout(timeout_ms, move || {
            client.take_pending(id);
            timed_out.settle(Err(JsError::error(format!(
                "Codex app-server request timed out: {method_name}"
            ))));
        });
        self.0
            .st
            .borrow_mut()
            .pending
            .push((id, Pending { settle, timer }));
        let mut message = vec![("method", text(method)), ("id", number(id))];
        if let Some(params) = params {
            message.push(("params", params.clone()));
        }
        if let Err(error) = self.write(&object(message)) {
            self.0.rt.clear_timeout(Some(timer));
            self.take_pending(id);
            return Err(error);
        }
        Ok(wait)
    }

    /// `requestWire(method, params, timeoutMs)`
    async fn request_wire(
        &self,
        method: &str,
        params: Option<&JsonValue>,
        timeout_ms: f64,
    ) -> Result<JsonValue, JsError> {
        self.request_wire_start(method, params, timeout_ms)?.await
    }

    /// `this.pending.get(id)` followed by `this.pending.delete(id)`
    fn take_pending(&self, id: f64) -> Option<Pending> {
        let mut st = self.0.st.borrow_mut();
        let at = st.pending.iter().position(|(key, _)| *key == id)?;
        Some(st.pending.remove(at).1)
    }

    /// `write(message)`
    fn write(&self, message: &JsonValue) -> Result<(), JsError> {
        if self.is_closed()
            || !self
                .0
                .child
                .borrow()
                .as_ref()
                .is_some_and(Child::stdin_writable)
        {
            return Err(JsError::error("Codex app-server input is closed"));
        }
        if let Some(child) = self.0.child.borrow().as_ref() {
            child.write(format!("{}\n", json_stringify(message)).as_bytes());
        }
        Ok(())
    }

    /// `onLine(line)`
    fn on_line(&self, line: &str) -> Result<(), JsError> {
        let parsed = match json_parse(line) {
            Ok(parsed) => parsed,
            Err(_) => {
                let mut st = self.0.st.borrow_mut();
                st.stderr =
                    append_diagnostic(&st.stderr, &format!("\nInvalid stdout JSON: {line}"));
                return Ok(());
            }
        };
        if matches!(parsed, JsonValue::Null) {
            return Err(JsError::type_error(
                "Cannot read properties of null (reading 'method')",
            ));
        }
        let message = RpcMessage::of(&parsed);
        if let (Some(method), Some(id)) = (message.method_str(), &message.id) {
            // SeuOffice deliberately disables Codex-owned tools. Reply instead of
            // leaving an unexpected server request pending forever.
            return self.write(&object(vec![
                ("id", id.clone()),
                (
                    "error",
                    object(vec![
                        ("code", number(-32601.0)),
                        (
                            "message",
                            text(format!("Unsupported server request: {method}")),
                        ),
                    ]),
                ),
            ]));
        }
        if let Some(JsonValue::Number(id)) = &message.id {
            let Some(pending) = self.take_pending(*id) else {
                return Ok(());
            };
            self.0.rt.clear_timeout(Some(pending.timer));
            pending.settle.settle(match &message.error {
                Some(error) => Err(rpc_error(Some(error))),
                None => Ok(message.result.clone().unwrap_or(JsonValue::Null)),
            });
            return Ok(());
        }
        if let Some(method) = message.method_str() {
            if method == "mcpServer/startupStatus/updated" {
                // Every thread of this process has its MCP servers switched off, so one starting means
                // the switch-off did not hold. Nothing may run with it attached.
                let status = as_str(lget(like(message.params.as_ref()), "status"));
                if status == Some("starting") || status == Some("ready") {
                    self.close(Some(unsafe_tools_error(
                        "Codex started an MCP server that was switched off",
                    )));
                    return Ok(());
                }
            }
            let listeners: Vec<Rc<dyn Fn(&RpcMessage)>> = self
                .0
                .st
                .borrow()
                .notification_listeners
                .iter()
                .map(|(_, listener)| listener.clone())
                .collect();
            for listener in listeners {
                listener(&message);
            }
        }
        Ok(())
    }

    /// `fail(error)`
    fn fail(&self, error: JsError) {
        let (pending, sessions, close_listeners, idle_timer) = {
            let mut st = self.0.st.borrow_mut();
            if st.closed {
                return;
            }
            st.closed = true;
            let idle_timer = st.idle_timer.take();
            let pending = std::mem::take(&mut st.pending);
            let sessions: Vec<SessionRef> = st.sessions.values().cloned().collect();
            st.sessions.clear();
            st.notification_listeners.clear();
            // a turn waits on notifications, not on a request: tell it the process is gone
            let close_listeners: Vec<Rc<dyn Fn(&JsError)>> = st
                .close_listeners
                .drain(..)
                .map(|(_, listener)| listener)
                .collect();
            (pending, sessions, close_listeners, idle_timer)
        };
        self.0.rt.clear_timeout(idle_timer);
        self.0.init.settle(Err(error.clone()));
        for (_, pending) in pending {
            self.0.rt.clear_timeout(Some(pending.timer));
            pending.settle.settle(Err(error.clone()));
        }
        for session in sessions {
            self.dispose_session(&session.borrow(), false);
        }
        for listener in close_listeners {
            listener(&error);
        }
        self.on_closed();
    }

    /// `onClosed()`: leave the pool when this client is the one in it.
    fn on_closed(&self) {
        let mut app = self.0.app.borrow_mut();
        let pooled = app
            .clients
            .get(&self.0.key)
            .is_some_and(|client| Rc::ptr_eq(&client.0, &self.0));
        if pooled {
            app.clients.delete(&self.0.key);
        }
    }

    /// `runtime.killTree(this.child)`: the whole tree, as Codex starts helper
    /// processes of its own.
    fn kill_tree(&self) {
        let hook = self.0.app.borrow().runtime.kill_tree.clone();
        let Some(child) = self.0.child.borrow().clone() else {
            return;
        };
        match hook {
            Some(hook) => hook(&self.0.rt, &child),
            None => real_kill_tree(&self.0.rt, &child),
        }
    }

    /// `close(reason)`
    fn close(&self, reason: Option<JsError>) {
        if self.is_closed() {
            return;
        }
        self.kill_tree();
        self.fail(
            reason.unwrap_or_else(|| JsError::error("Codex app-server stopped after being idle")),
        );
    }

    /// `listedModelEntries(client)`: the list each running process gave, read
    /// once for what a run needs from it (the default model, the levels a
    /// model takes); an entry is gone with its process, and a failed reading
    /// is not kept, so the next run asks again.
    fn listed_model_entries(&self) -> Wait<Result<Vec<JsonValue>, JsError>> {
        if let Some((_, known)) = &self.0.st.borrow().listed_models {
            return known.clone();
        }
        let reader = self.clone();
        let reading = self
            .0
            .rt
            .share(async move { read_model_entries(&reader).await });
        let token = self.next_token();
        self.0.st.borrow_mut().listed_models = Some((token, reading.clone()));
        let client = self.clone();
        let watched = reading.clone();
        self.0.rt.spawn_local(async move {
            if watched.await.is_err() {
                let mut st = client.0.st.borrow_mut();
                if st.listed_models.as_ref().is_some_and(|(t, _)| *t == token) {
                    st.listed_models = None;
                }
            }
        });
        reading
    }

    fn next_token(&self) -> u64 {
        let mut app = self.0.app.borrow_mut();
        app.next_token += 1;
        app.next_token
    }

    /// `defaultModelFor(client)`: the model of a run whose configuration names
    /// none. Left out of the thread, Codex takes the model from the user's own
    /// `config.toml`, the file this bridge otherwise overrides, and that one
    /// may only exist at the provider the user configured there. So a model is
    /// always named: the default of the list Codex itself gives. The list is
    /// read once per process. Without a default the run fails rather than
    /// leave the choice to that file.
    fn default_model_for(&self) -> Wait<Result<String, JsError>> {
        if let Some((_, known)) = &self.0.st.borrow().default_models {
            return known.clone();
        }
        let listed = self.listed_model_entries();
        let reading = self.0.rt.share(async move {
            match listed.await {
                Ok(entries) => {
                    let default_model = model_catalog_of(&entries).default_model;
                    if default_model.is_empty() {
                        Err(JsError::error(
                            "Codex listed no model, so there is no default model to run with",
                        ))
                    } else {
                        Ok(default_model)
                    }
                }
                Err(error) => {
                    if error.is("AiRunError") {
                        return Err(error);
                    }
                    let detail = error.message_or_string();
                    if js_regex!(r"^Codex app-server error \((?:-32601|-32600)\)").test(&detail) {
                        return Err(ai_run_error(
                            "needs-update",
                            "Codex is too old for this app: it cannot list its models, so there is no default model to run with",
                            Some("codex"),
                            None,
                        ));
                    }
                    Err(JsError::error(format!(
                        "Codex could not report its default model: {detail}"
                    ))
                    .with("cause", error.to_json()))
                }
            }
        });
        let token = self.next_token();
        self.0.st.borrow_mut().default_models = Some((token, reading.clone()));
        // a failed reading is not kept: the next run asks again
        let client = self.clone();
        let watched = reading.clone();
        self.0.rt.spawn_local(async move {
            if watched.await.is_err() {
                let mut st = client.0.st.borrow_mut();
                if st.default_models.as_ref().is_some_and(|(t, _)| *t == token) {
                    st.default_models = None;
                }
            }
        });
        reading
    }
}

// ---------------------------------------------------------------------------
// the pool
// ---------------------------------------------------------------------------

/// `clientFor(cliPathValue)`
async fn client_for(
    rt: &Rt,
    app: &CodexApp,
    cli_path: Option<&str>,
) -> Result<CodexAppServerClient, JsError> {
    let options = SubscriptionLocateOptions {
        configured_path: cli_path.map(str::to_owned),
        ..SubscriptionLocateOptions::default()
    };
    let resolve = app.borrow().runtime.resolve.clone();
    let program = match resolve {
        Some(resolve) => resolve(rt, "codex", &options).await?,
        None => resolve_subscription_program(rt, "codex", &options).await?,
    };
    let key = if rt.platform() == "win32" {
        program.entry.to_lowercase()
    } else {
        program.entry.clone()
    };
    let existing = app.borrow().clients.get(&key).cloned();
    if let Some(existing) = existing
        && !existing.is_closed()
    {
        return Ok(existing);
    }
    // the client is pooled before the process is awaited, as it is in the TypeScript
    let client = CodexAppServerClient::starting(rt, app, &key);
    let off = app.borrow().codex_off;
    if off {
        client.stop_when_unused();
    } else {
        app.borrow_mut().clients.set(key, client.clone());
    }
    if let Err(error) = client.launch(&program).await {
        client.fail(error.clone());
        return Err(error);
    }
    Ok(client)
}

/// `withClient(cliPath, action, signal)`
async fn with_client<T, Fut>(
    rt: &Rt,
    app: &CodexApp,
    cli_path: Option<&str>,
    signal: Option<&Signal>,
    action: impl FnOnce(CodexAppServerClient) -> Fut,
) -> Result<T, JsError>
where
    Fut: Future<Output = Result<T, JsError>>,
{
    let client = client_for(rt, app, cli_path).await?;
    client.retain();
    let outcome = async {
        client.ready().await?;
        action(client.clone()).await
    }
    .await;
    // cancelled by the user or by the watchdog, at whatever step
    if signal.is_some_and(Signal::aborted) {
        client.stop_when_unused();
    }
    client.release();
    outcome
}

// ---------------------------------------------------------------------------
// the prompt
// ---------------------------------------------------------------------------

/// `imageExtension(image)`
fn image_extension(image: &JsonValue) -> &'static str {
    let mime = as_str(prop(image, "mime")).unwrap_or("");
    let subtype = mime
        .split('/')
        .nth(1)
        .map(str::to_lowercase)
        .unwrap_or_default();
    match subtype.as_str() {
        "jpeg" | "jpg" => ".jpg",
        "png" => ".png",
        "webp" => ".webp",
        "gif" => ".gif",
        _ => ".img",
    }
}

/// `message.images ?? []`
fn images_of(message: &JsonValue) -> Vec<&JsonValue> {
    match prop(message, "images") {
        Some(JsonValue::Array(images)) => images.iter().collect(),
        _ => Vec::new(),
    }
}

/// `materializeImages(messages, tempDir)`
async fn materialize_images(
    rt: &Rt,
    messages: &[JsonValue],
    temp_dir: &str,
) -> Result<Vec<String>, JsError> {
    let mut paths: Vec<String> = Vec::new();
    for message in messages {
        if as_str(prop(message, "role")) != Some("user") {
            continue;
        }
        for image in images_of(message) {
            let path = host::join(&[
                temp_dir,
                &format!("image-{}{}", paths.len() + 1, image_extension(image)),
            ]);
            let data = buffer_from_base64(as_str(prop(image, "base64")).unwrap_or(""));
            rt.fs(FsOp::WriteFile {
                path: path.clone(),
                data,
                mode: None,
                flag: None,
            })
            .await?;
            paths.push(path);
        }
    }
    Ok(paths)
}

/// An object with the entries that are not `undefined`.
fn entries_of_present(entries: Vec<(&str, Option<JsonValue>)>) -> JsonValue {
    object(
        entries
            .into_iter()
            .filter_map(|(key, value)| value.map(|v| (key, v)))
            .collect(),
    )
}

/// `conversationForPrompt(messages)`
fn conversation_for_prompt(messages: &[JsonValue]) -> Vec<JsonValue> {
    let mut image_index = 0usize;
    messages
        .iter()
        .map(|message| match as_str(prop(message, "role")) {
            Some("user") => {
                let names: Vec<JsonValue> = images_of(message)
                    .iter()
                    .map(|_| {
                        image_index += 1;
                        text(format!("image-{image_index}"))
                    })
                    .collect();
                entries_of_present(vec![
                    ("role", Some(text("user"))),
                    ("text", prop(message, "text").cloned()),
                    (
                        "attachedImages",
                        (!names.is_empty()).then_some(JsonValue::Array(names)),
                    ),
                ])
            }
            Some("assistant") => {
                let calls = match prop(message, "toolCalls") {
                    Some(JsonValue::Array(calls)) if !calls.is_empty() => Some(JsonValue::Array(
                        calls
                            .iter()
                            .map(|call| {
                                entries_of_present(vec![
                                    ("id", prop(call, "id").cloned()),
                                    ("name", prop(call, "name").cloned()),
                                    ("input", prop(call, "input").cloned()),
                                ])
                            })
                            .collect(),
                    )),
                    _ => None,
                };
                entries_of_present(vec![
                    ("role", Some(text("assistant"))),
                    ("text", prop(message, "text").cloned()),
                    ("toolCalls", calls),
                ])
            }
            _ => entries_of_present(vec![
                ("role", Some(text("tool"))),
                ("results", prop(message, "results").cloned()),
            ]),
        })
        .collect()
}

/// `codexAppServerOutputSchema(tools)`
pub fn codex_app_server_output_schema(tools: &[JsonValue]) -> JsonValue {
    let mut tool_calls = vec![("type", text("array"))];
    if tools.is_empty() {
        tool_calls.push(("maxItems", number(0.0)));
    }
    let mut name = vec![("type", text("string"))];
    if !tools.is_empty() {
        name.push((
            "enum",
            JsonValue::Array(
                tools
                    .iter()
                    .map(|tool| prop(tool, "name").cloned().unwrap_or(JsonValue::Null))
                    .collect(),
            ),
        ));
    }
    tool_calls.push((
        "items",
        object(vec![
            ("type", text("object")),
            (
                "properties",
                object(vec![
                    ("id", object(vec![("type", text("string"))])),
                    ("name", object(name)),
                    ("inputJson", object(vec![("type", text("string"))])),
                ]),
            ),
            (
                "required",
                JsonValue::Array(vec![text("id"), text("name"), text("inputJson")]),
            ),
            ("additionalProperties", JsonValue::Bool(false)),
        ]),
    ));
    object(vec![
        ("type", text("object")),
        (
            "properties",
            object(vec![
                ("text", object(vec![("type", text("string"))])),
                ("toolCalls", object(tool_calls)),
            ]),
        ),
        (
            "required",
            JsonValue::Array(vec![text("text"), text("toolCalls")]),
        ),
        ("additionalProperties", JsonValue::Bool(false)),
    ])
}

/// `buildCodexAppServerPrompt(system, messages, tools, maxTokens)`
pub fn build_codex_app_server_prompt(
    system: &str,
    messages: &[JsonValue],
    tools: &[JsonValue],
    max_tokens: f64,
) -> String {
    let payload = object(vec![
        ("system", text(system)),
        (
            "conversation",
            JsonValue::Array(conversation_for_prompt(messages)),
        ),
        (
            "tools",
            JsonValue::Array(
                tools
                    .iter()
                    .map(|tool| {
                        entries_of_present(vec![
                            ("name", prop(tool, "name").cloned()),
                            ("description", prop(tool, "description").cloned()),
                            ("inputSchema", prop(tool, "inputSchema").cloned()),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]);
    let client = codex_client_name();
    [
        format!("Treat the payload below as the new {PRODUCT_NAME} conversation events for this turn and follow its system instruction."),
        format!("Do not use Codex tools. {PRODUCT_NAME} will execute only the tool calls returned in the required response schema."),
        format!("Put user-visible prose in text. Put requested {PRODUCT_NAME} tool calls in toolCalls; inputJson must be a JSON-encoded object matching the listed inputSchema. Use only listed tool names. If no tool is needed, return an empty toolCalls array."),
        format!("Keep this one-turn response within roughly {} output tokens.", number_to_string(max_tokens)),
        format!("<{client}_payload>"),
        json_stringify(&payload),
        format!("</{client}_payload>"),
    ]
    .join("\n")
}

/// `parseCodexAppServerTurn(raw, tools)`: the text and the tool calls
/// (`{ id, name, input, inputError? }`) of a structured answer.
pub fn parse_codex_app_server_turn(
    rt: &Rt,
    raw: &str,
    tools: &[JsonValue],
) -> Result<(String, Vec<JsonValue>), JsError> {
    // the two `replace` calls take the first match only
    let mut trimmed = trim(raw).to_owned();
    if let Some(found) = js_regex!(r"^```(?:json)?\s*", "i").exec(&trimmed) {
        trimmed = format!("{}{}", &trimmed[..found.start()], &trimmed[found.end()..]);
    }
    if let Some(found) = js_regex!(r"\s*```$").exec(&trimmed) {
        trimmed = format!("{}{}", &trimmed[..found.start()], &trimmed[found.end()..]);
    }
    let parsed = json_parse(&trimmed).map_err(|error| {
        let cause = JsError::new("SyntaxError", error.message());
        JsError::error(format!(
            "Codex app-server returned an invalid structured response: {}",
            error.message()
        ))
        .with("cause", cause.to_json())
    })?;
    let parsed_like = like(Some(&parsed));
    let Some(JsonValue::String(turn_text)) = lget(parsed_like, "text") else {
        return Err(JsError::error(
            "Codex app-server returned a response with an invalid text field",
        ));
    };
    let Some(JsonValue::Array(calls)) = lget(parsed_like, "toolCalls") else {
        return Err(JsError::error(
            "Codex app-server returned a response with an invalid toolCalls field",
        ));
    };
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| as_str(prop(tool, "name")))
        .collect();
    // the response schema only caps an empty tool list, so cap the parsed turn here
    throw_if_tool_count_over_budget(calls.len() as f64, "codex-app-server")?;
    let mut tool_calls = Vec::new();
    for call in calls {
        let Some(name) = like(Some(call)).and_then(|c| as_str(c.get("name"))) else {
            return Err(JsError::error(
                "Codex app-server returned an invalid tool call",
            ));
        };
        if !names.contains(&name) {
            return Err(JsError::error(format!(
                "Codex app-server requested an unknown tool: {name}"
            )));
        }
        let input_json = as_str(prop(call, "inputJson")).unwrap_or("");
        throw_if_tool_json_over_budget(length16(input_json) as f64, "codex-app-server")?;
        let (input, error) = parse_tool_input(input_json);
        let id = match as_str(prop(call, "id")) {
            Some(id) if !id.is_empty() => id.to_owned(),
            _ => format!("codex-{}", rt.random_uuid()),
        };
        let mut entry = vec![
            ("id", text(id)),
            ("name", text(name)),
            ("input", JsonValue::Object(input)),
        ];
        if let Some(error) = error {
            entry.push(("inputError", text(error)));
        }
        tool_calls.push(object(entry));
    }
    if turn_text.is_empty() && tool_calls.is_empty() {
        return Err(JsError::error("Codex app-server returned no content"));
    }
    Ok((turn_text.clone(), tool_calls))
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/// `fingerprint(message)`
fn fingerprint(message: &JsonValue) -> String {
    sha256_hex(&json_stringify(message))
}

/// `sessionSignature(system, tools, model, effort)`: what a reused thread must
/// have been started with. The effort is part of it: a turn's effort also holds
/// for the turns after it, so a thread run at one level is not reused at
/// another, nor at the default.
fn session_signature(
    system: &str,
    tools: &[JsonValue],
    model: &str,
    effort: Option<&str>,
) -> String {
    sha256_hex(&json_stringify(&object(vec![
        ("system", text(system)),
        ("tools", JsonValue::Array(tools.to_vec())),
        ("model", text(model)),
        ("effort", text(effort.unwrap_or(""))),
    ])))
}

/// `incrementalMessages(existing, signature, messages)`
fn incremental_messages(
    existing: Option<&NativeSession>,
    signature: &str,
    messages: &[JsonValue],
) -> Option<Vec<JsonValue>> {
    let existing = existing?;
    if existing.signature != signature {
        return None;
    }
    let known = existing.message_fingerprints.len();
    if messages.len() < known {
        return None;
    }
    for (message, print) in messages.iter().zip(&existing.message_fingerprints) {
        if &fingerprint(message) != print {
            return None;
        }
    }
    // The assistant response is already native app-server history. SeuOffice's
    // following tool results or user message are the only new events to inject.
    Some(
        messages[known..]
            .iter()
            .filter(|m| as_str(prop(m, "role")) != Some("assistant"))
            .cloned()
            .collect(),
    )
}

/// `optionalThreadId(result)`
fn optional_thread_id(result: Option<&JsonValue>) -> Option<String> {
    let thread = like(lget(like(result), "thread"));
    match lget(thread, "id") {
        Some(JsonValue::String(id)) if !id.is_empty() => Some(id.clone()),
        _ => None,
    }
}

/// `threadIdFrom(result)`
fn thread_id_from(result: &JsonValue) -> Result<String, JsError> {
    optional_thread_id(Some(result))
        .ok_or_else(|| JsError::error("Codex app-server did not return a thread id"))
}

/// `finalMessageFromTurn(params)`
fn final_message_from_turn(params: Option<&JsonValue>) -> String {
    let turn = like(lget(like(params), "turn"));
    let items: &[JsonValue] = match lget(turn, "items") {
        Some(JsonValue::Array(items)) => items,
        _ => &[],
    };
    for value in items.iter().rev() {
        let item = like(Some(value));
        if as_str(lget(item, "type")) == Some("agentMessage")
            && let Some(JsonValue::String(item_text)) = lget(item, "text")
        {
            return item_text.clone();
        }
    }
    String::new()
}

/// `codexThreadStartParams(config, tempDir, mode, mcpServers)`: Codex keeps
/// its own shell tool even when told not to use it, and the plain read-only
/// sandbox still lets that tool read the whole disk. A permission profile
/// confines reads to platform paths plus our temp dir. An explicit `sandbox`
/// would disable the profile, so it is only used in the fallback. `mode` is
/// `"profile"` or `"read-only"`.
pub fn codex_thread_start_params(
    config: &JsonValue,
    temp_dir: &str,
    mode: &str,
    mcp_servers: &Obj,
) -> Result<JsonValue, JsError> {
    let model = config_model_trimmed(config)?;
    let mut base = Obj::new();
    if !model.is_empty() {
        base.set("model", text(model));
    }
    base.set("cwd", text(temp_dir));
    base.set("approvalPolicy", text("never"));
    base.set("serviceName", text(codex_client_name()));
    base.set("baseInstructions", text(codex_base_instructions()));
    // nothing of the thread is written to the user's Codex home
    base.set("ephemeral", JsonValue::Bool(true));
    let mcp = (!mcp_servers.is_empty()).then(|| {
        let mut mcp = Obj::new();
        mcp.set("mcp_servers", JsonValue::Object(mcp_servers.clone()));
        mcp
    });
    if mode == "read-only" {
        base.set("sandbox", text("read-only"));
        if let Some(mcp) = mcp {
            base.set("config", JsonValue::Object(mcp));
        }
        return Ok(JsonValue::Object(base));
    }
    let mut filesystem = Obj::new();
    filesystem.set(":minimal", text("read"));
    filesystem.set(temp_dir, text("read"));
    let mut permissions = Obj::new();
    permissions.set(
        CODEX_PERMISSION_PROFILE,
        object(vec![("filesystem", JsonValue::Object(filesystem))]),
    );
    let mut config_out = Obj::new();
    config_out.set("default_permissions", text(CODEX_PERMISSION_PROFILE));
    config_out.set("permissions", JsonValue::Object(permissions));
    if let Some(mcp) = mcp {
        for (key, value) in mcp.entries() {
            config_out.set(key, value.clone());
        }
    }
    base.set("config", JsonValue::Object(config_out));
    Ok(JsonValue::Object(base))
}

/// `config.model.trim()`, with the `TypeError` the TypeScript throws for a
/// configuration without a string `model`.
fn config_model_trimmed(config: &JsonValue) -> Result<String, JsError> {
    match config {
        JsonValue::Null => Err(JsError::type_error(
            "Cannot read properties of null (reading 'model')",
        )),
        JsonValue::Object(o) => match o.get("model") {
            Some(JsonValue::String(model)) => Ok(trim(model).to_owned()),
            Some(JsonValue::Null) => Err(JsError::type_error(
                "Cannot read properties of null (reading 'trim')",
            )),
            None => Err(JsError::type_error(
                "Cannot read properties of undefined (reading 'trim')",
            )),
            Some(_) => Err(JsError::type_error("config.model.trim is not a function")),
        },
        // a property of a string, a number, a boolean or an array: `undefined`
        _ => Err(JsError::type_error(
            "Cannot read properties of undefined (reading 'trim')",
        )),
    }
}

/// `activePermissionProfileId(result)`
pub fn active_permission_profile_id(result: &JsonValue) -> Option<String> {
    let active = like(lget(like(Some(result)), "activePermissionProfile"));
    as_str(lget(active, "id")).map(str::to_owned)
}

/// `codexMcpServerOverrides(configRead)`: the per-thread override that
/// switches off every MCP server in the configuration Codex reports
/// (`config/read`). A launch argument cannot do this: an override table is
/// merged into the user's, so the servers have to be named. Only the names are
/// read; a server's command and environment are not looked at.
pub fn codex_mcp_server_overrides(config_read: &JsonValue) -> Result<Obj, JsError> {
    let config = like(lget(like(Some(config_read)), "config"));
    let Some(config) = config else {
        return Err(JsError::error(
            "Codex app-server did not return its configuration",
        ));
    };
    let mut overrides = Obj::new();
    let servers = like(config.get("mcp_servers"));
    for (name, _) in servers.map(Like::entries).unwrap_or_default() {
        assign(
            &mut overrides,
            &name,
            object(vec![("enabled", JsonValue::Bool(false))]),
        );
    }
    Ok(overrides)
}

/// `codexAttachedMcpServers(statusList)`: names of the MCP servers a thread
/// can use, from `mcpServerStatus/list` for that thread: a server in any state
/// but `disabled`, or one that lists a tool. Fails when the value is not such
/// a list, because then nothing is known.
pub fn codex_attached_mcp_servers(status_list: &JsonValue) -> Result<Vec<String>, JsError> {
    let Some(JsonValue::Array(data)) = lget(like(Some(status_list)), "data") else {
        return Err(JsError::error(
            "Codex app-server did not list its MCP servers",
        ));
    };
    let mut attached = Vec::new();
    for value in data {
        let Some(entry) = like(Some(value)) else {
            return Err(JsError::error(
                "Codex app-server did not list its MCP servers",
            ));
        };
        let enabled =
            matches!(entry.get("runtimeStatus"), Some(JsonValue::String(s)) if s != "disabled");
        let tools = like(entry.get("tools")).map_or(0, |t| t.entries().len());
        if enabled || tools > 0 {
            attached.push(as_str(entry.get("name")).unwrap_or("").to_owned());
        }
    }
    Ok(attached)
}

/// `assertNoMcpServers(client, threadId)`: the run is refused unless Codex
/// itself confirms that the thread has no MCP server: the switch-off is
/// checked by its result, not trusted. A thread that cannot be checked counts
/// as unsafe, and the process is ended with it.
async fn assert_no_mcp_servers(
    client: &CodexAppServerClient,
    thread_id: &str,
) -> Result<(), JsError> {
    let mut attached = 0usize;
    let checked = async {
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_MCP_STATUS_PAGES {
            let params = object(vec![
                ("threadId", text(thread_id)),
                ("detail", text("toolsAndAuthOnly")),
                (
                    "cursor",
                    cursor.clone().map_or(JsonValue::Null, JsonValue::String),
                ),
                ("limit", number(100.0)),
            ]);
            let result = client
                .request("mcpServerStatus/list", Some(&params))
                .await?;
            attached += codex_attached_mcp_servers(&result)?.len();
            cursor = match lget(like(Some(&result)), "nextCursor") {
                Some(JsonValue::String(next)) if !next.is_empty() => Some(next.clone()),
                _ => None,
            };
            if cursor.is_none() {
                break;
            }
        }
        Ok::<bool, JsError>(cursor.is_none())
    }
    .await
    .unwrap_or(false);
    if checked && attached == 0 {
        return Ok(());
    }
    let error = unsafe_tools_error(if checked {
        "Codex attached an MCP server to the run although all of them were switched off"
    } else {
        "Codex could not confirm that no MCP server is attached to the run"
    });
    client.stop(Some(error.clone()));
    Err(error)
}

/// `startNativeThread(client, config, tempDir)`
async fn start_native_thread(
    client: &CodexAppServerClient,
    config: &JsonValue,
    temp_dir: &str,
) -> Result<String, JsError> {
    let params = object(vec![
        ("includeLayers", JsonValue::Bool(false)),
        ("cwd", text(temp_dir)),
    ]);
    let overrides = match client.request("config/read", Some(&params)).await {
        Ok(read) => codex_mcp_server_overrides(&read),
        Err(error) => Err(error),
    };
    // without the names nothing can be switched off, so nothing is started
    let mcp_servers = overrides
        .map_err(|_| unsafe_tools_error("Codex could not report its configured MCP servers"))?;
    let thread_id = start_thread_with_permissions(client, config, temp_dir, &mcp_servers).await?;
    assert_no_mcp_servers(client, &thread_id).await?;
    Ok(thread_id)
}

/// `startThreadWithPermissions(client, config, tempDir, mcpServers)`
async fn start_thread_with_permissions(
    client: &CodexAppServerClient,
    config: &JsonValue,
    temp_dir: &str,
    mcp_servers: &Obj,
) -> Result<String, JsError> {
    let profile_params = codex_thread_start_params(config, temp_dir, "profile", mcp_servers);
    let attempt = match profile_params {
        Ok(params) => client.request("thread/start", Some(&params)).await,
        Err(error) => Err(error),
    };
    let profile = match attempt {
        Ok(result) => {
            if active_permission_profile_id(&result).as_deref() == Some(CODEX_PERMISSION_PROFILE) {
                if let Ok(thread_id) = thread_id_from(&result) {
                    return Ok(thread_id);
                }
                None
            } else {
                Some(result)
            }
        }
        // Older Codex builds reject the profile keys; fall through to the sandbox.
        Err(_) => None,
    };
    // A user config.toml sandbox_mode or an older Codex ignored the profile. Discard
    // that thread before falling back so it does not linger under looser permissions.
    if let Some(abandoned) = optional_thread_id(profile.as_ref()) {
        let params = object(vec![("threadId", text(abandoned))]);
        let _ = client.request("thread/delete", Some(&params)).await;
    }
    let params = codex_thread_start_params(config, temp_dir, "read-only", mcp_servers)?;
    thread_id_from(&client.request("thread/start", Some(&params)).await?)
}

// ---------------------------------------------------------------------------
// usage and errors of a turn
// ---------------------------------------------------------------------------

/// `CodexRateLimitWindow`
struct RateLimitWindow {
    used_percent: f64,
    minutes: Option<f64>,
    /// epoch milliseconds
    resets_at: Option<f64>,
}

/// `rateLimitWindows(snapshot)`: the windows of a `RateLimitSnapshot`
/// (`account/rateLimits/updated`, `account/rateLimits/read`)
fn rate_limit_windows(snapshot: Option<&JsonValue>) -> Vec<RateLimitWindow> {
    let value = like(snapshot);
    let mut windows = Vec::new();
    for key in ["primary", "secondary"] {
        let window = like(lget(value, key));
        let used_percent = finite_number(lget(window, "usedPercent"));
        let (Some(window), Some(used_percent)) = (window, used_percent) else {
            continue;
        };
        // Codex reports the reset time in epoch seconds
        let resets_at = finite_number(window.get("resetsAt"));
        windows.push(RateLimitWindow {
            used_percent,
            minutes: finite_number(window.get("windowDurationMins")),
            resets_at: resets_at.filter(|at| *at > 0.0).map(|at| at * 1000.0),
        });
    }
    windows
}

/// `codexSubscriptionUsage(snapshot)`: the usage Codex reports, as the windows
/// the app shows. Codex names a window by its length: five hours and seven
/// days are passed on, any other length (the free plan has one 30-day window)
/// is not. A window without a reset time is not a usage value, and neither is
/// a snapshot of another limit than the account's main one.
pub fn codex_subscription_usage(snapshot: Option<&JsonValue>) -> Vec<JsonValue> {
    let limit_id = lget(like(snapshot), "limitId");
    if !matches!(limit_id, None | Some(JsonValue::Null)) && as_str(limit_id) != Some("codex") {
        return Vec::new();
    }
    let mut usage = Vec::new();
    for window in rate_limit_windows(snapshot) {
        let name = match window.minutes {
            Some(300.0) => "five_hour",
            Some(10080.0) => "seven_day",
            _ => continue,
        };
        let Some(resets_at) = window.resets_at else {
            continue;
        };
        usage.push(object(vec![
            ("provider", text("codex")),
            ("window", text(name)),
            (
                "utilization",
                number((window.used_percent / 100.0).clamp(0.0, 1.0)),
            ),
            ("resetsAt", number(resets_at)),
        ]));
    }
    usage
}

/// `limitResetTime(snapshot)`: when an exhausted limit is usable again: the
/// latest reset among the windows that are used up
fn limit_reset_time(snapshot: Option<&JsonValue>) -> Option<f64> {
    rate_limit_windows(snapshot)
        .into_iter()
        .filter(|w| w.used_percent >= 100.0)
        .filter_map(|w| w.resets_at)
        .reduce(math_max)
}

/// `httpStatusOf(codexErrorInfo)`
fn http_status_of(info: Option<&JsonValue>) -> Option<f64> {
    like(info)?
        .entries()
        .into_iter()
        .find_map(|(_, detail)| finite_number(lget(like(Some(&detail)), "httpStatusCode")))
}

/// `isUsageLimitError(turnError)`
fn is_usage_limit_error(turn_error: Option<&JsonValue>) -> bool {
    as_str(lget(like(turn_error), "codexErrorInfo")) == Some("usageLimitExceeded")
}

/// `codexRunError(turnError, rateLimits)`: the error of a failed turn
/// (`TurnError`: `message` plus `codexErrorInfo`) as the error the app reports.
/// A used-up subscription limit and a rejected login get their own kinds;
/// `rate_limits` is the last snapshot Codex gave, for the reset time.
/// Everything else keeps Codex's message.
pub fn codex_run_error(turn_error: Option<&JsonValue>, rate_limits: Option<&JsonValue>) -> JsError {
    let value = like(turn_error);
    let message = match lget(value, "message") {
        Some(JsonValue::String(m)) if !m.is_empty() => m.clone(),
        _ => "Codex turn failed".to_owned(),
    };
    let info = lget(value, "codexErrorInfo");
    if as_str(info) == Some("usageLimitExceeded") {
        return ai_run_error(
            "rate-limit",
            message,
            Some("codex"),
            limit_reset_time(rate_limits),
        );
    }
    if as_str(info) == Some("unauthorized") || http_status_of(info) == Some(401.0) {
        return ai_run_error("signed-out", message, Some("codex"), None);
    }
    JsError::error(message)
}

// ---------------------------------------------------------------------------
// waiting for a turn
// ---------------------------------------------------------------------------

/// `CodexTurnTransport`
pub trait CodexTurnTransport {
    /// `request(method, params)`
    fn request(
        &self,
        method: &str,
        params: Option<JsonValue>,
    ) -> LocalBoxFuture<Result<JsonValue, JsError>>;
    /// `onNotification(listener)`: answers the function that stops the listening
    fn on_notification(&self, listener: Rc<dyn Fn(&RpcMessage)>) -> Rc<dyn Fn()>;
    /// `onClose?.(listener)`: the process ended; without it a turn only ends by
    /// its own notifications
    fn on_close(&self, listener: Rc<dyn Fn(&JsError)>) -> Option<Rc<dyn Fn()>>;
}

impl CodexTurnTransport for CodexAppServerClient {
    fn request(
        &self,
        method: &str,
        params: Option<JsonValue>,
    ) -> LocalBoxFuture<Result<JsonValue, JsError>> {
        let client = self.clone();
        let method = method.to_owned();
        Box::pin(async move { client.request(&method, params.as_ref()).await })
    }

    fn on_notification(&self, listener: Rc<dyn Fn(&RpcMessage)>) -> Rc<dyn Fn()> {
        CodexAppServerClient::on_notification(self, listener)
    }

    fn on_close(&self, listener: Rc<dyn Fn(&JsError)>) -> Option<Rc<dyn Fn()>> {
        Some(CodexAppServerClient::on_close(self, listener))
    }
}

/// The `start` argument of [`wait_for_turn`]: called once the turn's listeners
/// are in place.
pub type TurnStart = Box<dyn FnOnce() -> LocalBoxFuture<Result<JsonValue, JsError>>>;

struct TurnState {
    turn_id: String,
    final_text: String,
    settled: bool,
    /// the last error Codex reported for the turn; it decides nothing until the turn itself ends
    reported_error: Option<JsonValue>,
    rate_limits: Option<JsonValue>,
    interrupted: bool,
    unsubscribe: Option<Rc<dyn Fn()>>,
    unsubscribe_close: Option<Rc<dyn Fn()>>,
    abort_listener: Option<Id>,
}

struct Turn {
    rt: Rt,
    client: Rc<dyn CodexTurnTransport>,
    thread_id: String,
    signal: Signal,
    cb: StreamCallbacks,
    st: RefCell<TurnState>,
    settle: Settle<Result<String, JsError>>,
}

impl Turn {
    /// `finish(error?)`
    fn finish(&self, error: Option<JsError>) {
        let (unsubscribe, unsubscribe_close, abort_listener) = {
            let mut st = self.st.borrow_mut();
            if st.settled {
                return;
            }
            st.settled = true;
            (
                st.unsubscribe.take(),
                st.unsubscribe_close.take(),
                st.abort_listener.take(),
            )
        };
        if let Some(unsubscribe) = unsubscribe {
            unsubscribe();
        }
        if let Some(unsubscribe_close) = unsubscribe_close {
            unsubscribe_close();
        }
        if let Some(listener) = abort_listener {
            self.signal.off(listener);
        }
        self.settle.settle(match error {
            Some(error) => Err(error),
            None => Ok(self.st.borrow().final_text.clone()),
        });
    }

    /// `fail(turnError)`
    fn fail(self: &Rc<Self>, turn_error: Option<JsonValue>) {
        let rate_limits = self.st.borrow().rate_limits.clone();
        if !is_usage_limit_error(turn_error.as_ref())
            || limit_reset_time(rate_limits.as_ref()).is_some()
        {
            self.finish(Some(codex_run_error(
                turn_error.as_ref(),
                rate_limits.as_ref(),
            )));
            return;
        }
        // The turn did not come with the limits; ask for them, briefly, for the reset time.
        let (done, timeout) = self.rt.deferred::<Option<JsonValue>>();
        self.rt
            .set_timeout(RATE_LIMIT_READ_TIMEOUT_MS, move || done.settle(None));
        let read = self.client.request("account/rateLimits/read", None);
        let turn = self.clone();
        self.rt.spawn_local(async move {
            let read: LocalBoxFuture<Option<JsonValue>> = Box::pin(async move { read.await.ok() });
            let timeout: LocalBoxFuture<Option<JsonValue>> = Box::pin(timeout);
            let (_, result) = turn.rt.race(vec![read, timeout]).await;
            let limits = lget(like(result.as_ref()), "rateLimits");
            turn.finish(Some(codex_run_error(turn_error.as_ref(), limits)));
        });
    }

    /// `interrupt()`
    fn interrupt(&self) {
        let turn_id = {
            let mut st = self.st.borrow_mut();
            if st.turn_id.is_empty() || st.interrupted {
                return;
            }
            st.interrupted = true;
            st.turn_id.clone()
        };
        let params = object(vec![
            ("threadId", text(&self.thread_id)),
            ("turnId", text(turn_id)),
        ]);
        let request = self.client.request("turn/interrupt", Some(params));
        self.rt.spawn_local(async move {
            let _ = request.await;
        });
    }

    /// The listener of `client.onNotification`
    fn on_message(self: &Rc<Self>, message: &RpcMessage) {
        let method = message.method_str().unwrap_or("");
        let params = like(message.params.as_ref());
        if method == "account/rateLimits/updated" {
            // account-wide, so it carries no thread id
            let limits = lget(params, "rateLimits").cloned();
            self.st.borrow_mut().rate_limits = limits.clone();
            let usage = codex_subscription_usage(limits.as_ref());
            if !usage.is_empty()
                && let Some(on_usage) = &self.cb.on_subscription_usage
            {
                on_usage(JsonValue::Array(usage));
            }
            return;
        }
        let Some(params) = params else { return };
        if as_str(params.get("threadId")) != Some(self.thread_id.as_str()) {
            return;
        }
        // A reconnect notice is not data: while only those arrive, the idle timeout keeps running.
        if (method != "error" || !is_true(params.get("willRetry")))
            && let Some(on_activity) = &self.cb.on_activity
        {
            on_activity();
        }
        let event_turn_id = as_str(params.get("turnId")).unwrap_or("");
        {
            let st = self.st.borrow();
            if !st.turn_id.is_empty() && !event_turn_id.is_empty() && event_turn_id != st.turn_id {
                return;
            }
        }
        match method {
            "turn/started" => {
                let turn = like(params.get("turn"));
                if let Some(JsonValue::String(id)) = lget(turn, "id") {
                    self.st.borrow_mut().turn_id = id.clone();
                }
            }
            "item/completed" => {
                let item = like(params.get("item"));
                if as_str(lget(item, "type")) == Some("agentMessage")
                    && let Some(JsonValue::String(item_text)) = lget(item, "text")
                {
                    self.st.borrow_mut().final_text = item_text.clone();
                }
            }
            "item/reasoning/summaryTextDelta" => {
                if let Some(JsonValue::String(delta)) = params.get("delta")
                    && let Some(on_reasoning) = &self.cb.on_reasoning_delta
                {
                    on_reasoning(JsonValue::String(delta.clone()));
                }
            }
            "turn/completed" => {
                let turn = like(params.get("turn"));
                {
                    let mut st = self.st.borrow_mut();
                    if let Some(JsonValue::String(id)) = lget(turn, "id") {
                        st.turn_id = id.clone();
                    }
                    if st.final_text.is_empty() {
                        st.final_text = final_message_from_turn(message.params.as_ref());
                    }
                }
                if as_str(lget(turn, "status")) == Some("failed") {
                    let error = match lget(turn, "error") {
                        None | Some(JsonValue::Null) => self.st.borrow().reported_error.clone(),
                        Some(error) => Some(error.clone()),
                    };
                    self.fail(error);
                } else {
                    self.finish(None);
                }
            }
            "error" => {
                // willRetry: a dropped model stream Codex reconnects on its own ("Reconnecting... 2/5");
                // the turn is still live and ends with turn/completed.
                if is_true(params.get("willRetry")) {
                    return;
                }
                // Codex reports warnings this way too, so an error alone does not fail the turn: the
                // turn's own outcome (turn/completed, or the process ending) does.
                let reported = match like(params.get("error")) {
                    Some(error) => error.0.clone(),
                    None => params.0.clone(),
                };
                self.st.borrow_mut().reported_error = Some(reported);
            }
            _ => {}
        }
    }
}

/// `waitForTurn(client, threadId, start, signal, cb)`: the final text of the
/// turn.
pub async fn wait_for_turn(
    rt: &Rt,
    client: Rc<dyn CodexTurnTransport>,
    thread_id: &str,
    start: TurnStart,
    signal: &Signal,
    cb: &StreamCallbacks,
) -> Result<String, JsError> {
    if signal.aborted() {
        return Err(cancelled_error());
    }
    let (settle, wait) = rt.deferred::<Result<String, JsError>>();
    let turn = Rc::new(Turn {
        rt: rt.clone(),
        client: client.clone(),
        thread_id: thread_id.to_owned(),
        signal: signal.clone(),
        cb: cb.clone(),
        st: RefCell::new(TurnState {
            turn_id: String::new(),
            final_text: String::new(),
            settled: false,
            reported_error: None,
            rate_limits: None,
            interrupted: false,
            unsubscribe: None,
            unsubscribe_close: None,
            abort_listener: None,
        }),
        settle,
    });
    let notified = turn.clone();
    let unsubscribe = client.on_notification(Rc::new(move |message: &RpcMessage| {
        notified.on_message(message)
    }));
    turn.st.borrow_mut().unsubscribe = Some(unsubscribe);
    let closed = turn.clone();
    let unsubscribe_close = client.on_close(Rc::new(move |error: &JsError| {
        let reported = closed.st.borrow().reported_error.clone();
        closed.finish(Some(match reported {
            Some(reported) if !error.is("AiRunError") => codex_run_error(Some(&reported), None),
            _ => error.clone(),
        }));
    }));
    turn.st.borrow_mut().unsubscribe_close = unsubscribe_close;
    let aborted = turn.clone();
    let abort_listener = signal.on_abort(move |_| {
        aborted.interrupt();
        aborted.finish(Some(cancelled_error()));
    });
    turn.st.borrow_mut().abort_listener = Some(abort_listener);
    let started = start();
    let running = turn.clone();
    rt.spawn_local(async move {
        match started.await {
            Ok(result) => {
                let started_turn = like(lget(like(Some(&result)), "turn"));
                if let Some(JsonValue::String(id)) = lget(started_turn, "id") {
                    running.st.borrow_mut().turn_id = id.clone();
                }
                // An abort that raced the turn/start response settled locally; stop the server turn too.
                if running.signal.aborted() {
                    running.interrupt();
                }
            }
            Err(error) => running.finish(Some(as_error(error))),
        }
    });
    wait.await
}

// ---------------------------------------------------------------------------
// a run
// ---------------------------------------------------------------------------

/// `{ refreshToken: false }`
fn refresh_token_false() -> JsonValue {
    object(vec![("refreshToken", JsonValue::Bool(false))])
}

/// `assertRunnableAccount(client)`: whether Codex may be used on a metered
/// login (an API key, say) is decided where the provider is selected, from the
/// status check and the user's "use anyway". That decision is about the login
/// the status check saw. So a run is stopped here in the one case the
/// selection cannot see: Codex is now on a metered login of another kind than
/// the status check last read (the user switched logins since). The next
/// status check picks the new login up.
async fn assert_runnable_account(client: &CodexAppServerClient) -> Result<(), JsError> {
    let account = client
        .request("account/read", Some(&refresh_token_false()))
        .await?;
    let Some(login) = codex_account_info(Some(&account)) else {
        return Ok(());
    };
    if !login.signed_in {
        return Err(signed_out_error());
    }
    if login.login_method.as_deref() == Some("subscription") {
        return Ok(());
    }
    let status_kind = client.app().borrow().status_login_kind.clone();
    if let Some(status_kind) = status_kind
        && login.login_kind.as_deref() != Some(status_kind.as_str())
    {
        return Err(ai_run_error(
            "metered-not-accepted",
            "Codex is signed in with a login that is billed by usage, which has not been accepted",
            Some("codex"),
            None,
        ));
    }
    Ok(())
}

/// `modelEntryId(entry)`: the id a `model/list` entry is selected by
fn model_entry_id(entry: Like<'_>) -> String {
    match entry.get("id") {
        Some(JsonValue::String(id)) => id.clone(),
        _ => match entry.get("model") {
            Some(JsonValue::String(model)) => model.clone(),
            _ => String::new(),
        },
    }
}

/// `modelEntryEfforts(entry)`: the known effort levels Codex lists for one
/// `model/list` entry
fn model_entry_efforts(entry: Like<'_>) -> Option<Vec<&'static str>> {
    let options: Vec<JsonValue> = match entry.get("supportedReasoningEfforts") {
        Some(JsonValue::Array(options)) => options
            .iter()
            .map(|option| {
                lget(like(Some(option)), "reasoningEffort")
                    .cloned()
                    .unwrap_or(JsonValue::Null)
            })
            .collect(),
        _ => Vec::new(),
    };
    ai_efforts_of(Some(&JsonValue::Array(options)))
}

/// `codexListedEffort(listed, model, configured)`: the configured effort when
/// one page of a `model/list` answer lists it for `model`, `None` otherwise
/// (Codex then runs the level it would anyway).
pub fn codex_listed_effort(
    listed: &JsonValue,
    model: &str,
    configured: Option<&JsonValue>,
) -> Option<&'static str> {
    let effort = ai_effort_of(configured)?;
    let data: &[JsonValue] = match lget(like(Some(listed)), "data") {
        Some(JsonValue::Array(data)) => data,
        _ => &[],
    };
    for value in data {
        let Some(entry) = like(Some(value)) else {
            continue;
        };
        if is_true(entry.get("hidden")) {
            continue;
        }
        if model_entry_id(entry) != model && as_str(entry.get("model")) != Some(model) {
            continue;
        }
        return model_entry_efforts(entry)
            .is_some_and(|efforts| efforts.contains(&effort))
            .then_some(effort);
    }
    None
}

/// `readModelEntries(client)`: every entry of `model/list` that is not hidden,
/// page by page, as Codex gives it
async fn read_model_entries(client: &CodexAppServerClient) -> Result<Vec<JsonValue>, JsError> {
    let mut entries = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_MODEL_PAGES {
        let params = object(vec![
            (
                "cursor",
                cursor.clone().map_or(JsonValue::Null, JsonValue::String),
            ),
            ("limit", number(100.0)),
            ("includeHidden", JsonValue::Bool(false)),
        ]);
        let answer = client.request("model/list", Some(&params)).await?;
        let result = like(Some(&answer));
        if let Some(JsonValue::Array(data)) = lget(result, "data") {
            for value in data {
                match like(Some(value)) {
                    Some(entry) if !is_true(entry.get("hidden")) => entries.push(value.clone()),
                    _ => {}
                }
            }
        }
        cursor = match lget(result, "nextCursor") {
            Some(JsonValue::String(next)) => Some(next.clone()),
            _ => None,
        };
        if cursor.as_deref().is_none_or(str::is_empty) {
            break;
        }
    }
    Ok(entries)
}

/// `CodexModelCatalog`
struct ModelCatalog {
    models: Vec<String>,
    default_model: String,
}

/// `modelCatalogOf(entries)`
fn model_catalog_of(entries: &[JsonValue]) -> ModelCatalog {
    let mut models: Vec<String> = Vec::new();
    let mut default_model = String::new();
    for value in entries {
        let Some(entry) = like(Some(value)) else {
            continue;
        };
        let id = model_entry_id(entry);
        if id.is_empty() || models.contains(&id) {
            continue;
        }
        models.push(id.clone());
        if is_true(entry.get("isDefault")) {
            default_model = id;
        }
    }
    if default_model.is_empty() {
        default_model = models.first().cloned().unwrap_or_default();
    }
    ModelCatalog {
        models,
        default_model,
    }
}

/// `effortFor(client, model, configured)`: the configured effort when the
/// model takes it, `None` otherwise: Codex then runs the level it would run
/// anyway. Only a configured level makes the bridge read the list (once per
/// process), and a list it cannot read leaves the level out rather than
/// failing the run.
async fn effort_for(
    client: &CodexAppServerClient,
    model: &str,
    configured: Option<&JsonValue>,
) -> Option<&'static str> {
    let effort = ai_effort_of(configured)?;
    let entries = client.listed_model_entries().await.ok();
    let listed = match entries {
        Some(entries) => object(vec![("data", JsonValue::Array(entries))]),
        None => object(Vec::new()),
    };
    codex_listed_effort(&listed, model, Some(&text(effort)))
}

/// `runCodexAppServer(config, system, messages, tools, maxTokens, cb)`
async fn run_codex_app_server(
    rt: &Rt,
    app: &CodexApp,
    config: &JsonValue,
    system: &str,
    messages: &[JsonValue],
    tools: &[JsonValue],
    max_tokens: f64,
    cb: &StreamCallbacks,
) -> Result<(), JsError> {
    let native_session_id = match &cb.session_id {
        Some(id) => id.clone(),
        None => format!("one-shot-{}", rt.random_uuid()),
    };
    // One-shot chats and the connection test have no reusable transport id, so
    // their thread and temp dir are dropped as soon as the turn ends.
    let ephemeral = cb.session_id.is_none();
    let cli_path = as_str(prop(config, "cliPath")).map(str::to_owned);
    with_client(
        rt,
        app,
        cli_path.as_deref(),
        Some(&cb.signal),
        |client| async move {
            assert_runnable_account(&client).await?;
            let configured_model = config_model_trimmed(config)?;
            let model = if configured_model.is_empty() {
                client.default_model_for().await?
            } else {
                configured_model
            };
            let effort = effort_for(&client, &model, prop(config, "effort")).await;
            let signature = session_signature(system, tools, &model, effort);
            let mut session = client.get_session(&native_session_id);
            let mut next_messages = incremental_messages(
                session.as_ref().map(|s| s.borrow()).as_deref(),
                &signature,
                messages,
            );
            if session.is_none() || next_messages.is_none() {
                if session.is_some() {
                    client.delete_session(&native_session_id);
                }
                let temp_dirs = app.borrow().temp_dirs.clone();
                let temp_dir = create_tracked_temp_dir(
                    rt,
                    &temp_dirs,
                    CODEX_TEMP_PREFIX,
                    &TempDirOptions::default(),
                )
                .await?;
                let mut with_model = spread(Some(config));
                with_model.set("model", text(&model));
                let thread_id =
                    match start_native_thread(&client, &JsonValue::Object(with_model), &temp_dir)
                        .await
                    {
                        Ok(thread_id) => thread_id,
                        Err(error) => {
                            remove_tracked_temp_dir(
                                rt,
                                &temp_dirs,
                                &temp_dir,
                                &TempDirOptions::default(),
                            )
                            .await;
                            return Err(error);
                        }
                    };
                let fresh = Rc::new(RefCell::new(NativeSession {
                    thread_id,
                    signature,
                    message_fingerprints: Vec::new(),
                    temp_dir,
                }));
                client.set_session(&native_session_id, fresh.clone());
                session = Some(fresh);
                next_messages = Some(messages.to_vec());
            }
            let (Some(session), Some(next_messages)) = (session, next_messages) else {
                return Ok(());
            };
            let outcome = run_turn(
                rt,
                &client,
                &session,
                &next_messages,
                system,
                tools,
                max_tokens,
                effort,
                messages,
                cb,
            )
            .await;
            if outcome.is_err() {
                client.delete_session(&native_session_id);
            }
            if ephemeral {
                client.delete_session(&native_session_id);
            }
            outcome
        },
    )
    .await
}

/// The `try` block of `run`: one turn on a session.
async fn run_turn(
    rt: &Rt,
    client: &CodexAppServerClient,
    session: &SessionRef,
    next_messages: &[JsonValue],
    system: &str,
    tools: &[JsonValue],
    max_tokens: f64,
    effort: Option<&'static str>,
    messages: &[JsonValue],
    cb: &StreamCallbacks,
) -> Result<(), JsError> {
    let (thread_id, temp_dir) = {
        let session = session.borrow();
        (session.thread_id.clone(), session.temp_dir.clone())
    };
    let image_paths = materialize_images(rt, next_messages, &temp_dir).await?;
    let prompt = build_codex_app_server_prompt(system, next_messages, tools, max_tokens);
    let mut input = vec![object(vec![
        ("type", text("text")),
        ("text", text(prompt)),
        ("text_elements", JsonValue::Array(Vec::new())),
    ])];
    for path in image_paths {
        input.push(object(vec![
            ("type", text("localImage")),
            ("path", text(path)),
        ]));
    }
    let mut params = vec![
        ("threadId", text(&thread_id)),
        ("input", JsonValue::Array(input)),
        ("outputSchema", codex_app_server_output_schema(tools)),
    ];
    if let Some(effort) = effort {
        params.push(("effort", text(effort)));
    }
    let params = object(params);
    let transport: Rc<dyn CodexTurnTransport> = Rc::new(client.clone());
    let request = transport.request("turn/start", Some(params));
    let raw = wait_for_turn(
        rt,
        transport,
        &thread_id,
        Box::new(move || request),
        &cb.signal,
        cb,
    )
    .await?;
    let (turn_text, tool_calls) = parse_codex_app_server_turn(rt, &raw, tools)?;
    session.borrow_mut().message_fingerprints = messages.iter().map(fingerprint).collect();
    if !turn_text.is_empty() {
        (cb.on_delta)(JsonValue::String(turn_text.clone()));
    }
    for call in tool_calls {
        (cb.on_tool_call)(call);
    }
    Ok(())
}

/// `streamCodexAppServer(config, system, messages, tools, maxTokens, cb)`
pub async fn stream_codex_app_server(
    rt: &Rt,
    app: &CodexApp,
    config: &JsonValue,
    system: &str,
    messages: &[JsonValue],
    tools: &[JsonValue],
    max_tokens: f64,
    cb: &StreamCallbacks,
) -> Result<(), JsError> {
    let wd = create_stream_watchdog(rt, Some(&cb.signal), None, None);
    let touched = wd.clone();
    let outer_activity = cb.on_activity.clone();
    let inner = StreamCallbacks {
        signal: wd.signal.clone(),
        on_activity: Some(Rc::new(move || {
            touched.touch();
            if let Some(on_activity) = &outer_activity {
                on_activity();
            }
        })),
        ..cb.clone()
    };
    wd.guard(run_codex_app_server(
        rt, app, config, system, messages, tools, max_tokens, &inner,
    ))
    .await
}

/// `chatCodexAppServer(config, system, user, signal)`
pub async fn chat_codex_app_server(
    rt: &Rt,
    app: &CodexApp,
    config: &JsonValue,
    system: &str,
    user: &str,
    signal: &Signal,
) -> Result<AiChatResponse, JsError> {
    let content = Rc::new(RefCell::new(String::new()));
    let collected = content.clone();
    // No sessionId: a one-shot chat/connection test is not reused, so it runs as
    // an ephemeral turn whose thread and temp dir are dropped when it ends.
    let cb = StreamCallbacks {
        on_delta: Rc::new(move |delta: JsonValue| {
            if let JsonValue::String(delta) = delta {
                collected.borrow_mut().push_str(&delta);
            }
        }),
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
    let user_message = object(vec![("role", text("user")), ("text", text(user))]);
    run_codex_app_server(rt, app, config, system, &[user_message], &[], 1024.0, &cb).await?;
    let content = content.borrow().clone();
    Ok(if content.is_empty() {
        AiChatResponse::failed("Codex app-server returned no content".to_owned())
    } else {
        AiChatResponse::succeeded(text(content))
    })
}

// ---------------------------------------------------------------------------
// reads for the status check
// ---------------------------------------------------------------------------

/// `new Promise(... signal.addEventListener('abort', onAbort) ... read.then(resolve, reject)`:
/// the answer of a reading that is already running, or the abort error when
/// the signal aborts first. The reading itself goes on.
async fn abortable<T: Clone + 'static>(
    rt: &Rt,
    signal: Option<&Signal>,
    read: Wait<Result<T, JsError>>,
) -> Result<T, JsError> {
    let Some(signal) = signal else {
        return read.await;
    };
    let (settle, wait) = rt.deferred::<Result<T, JsError>>();
    let aborted = settle.clone();
    let listener = signal.on_abort(move |_| aborted.settle(Err(abort_error())));
    let signal = signal.clone();
    rt.spawn_local(async move {
        let outcome = read.await;
        settle.settle(outcome);
        signal.off(listener);
    });
    wait.await
}

/// `readCodexAccount(cliPath, signal)`: the app-server's `account/read`
/// result, as is: what kind of login Codex is on (`chatgpt` with a plan,
/// `apiKey`, ...). It is what the subscription status check asks for;
/// `codexAccountInfo` there maps it and drops the email. The login itself is
/// never read: Codex only says what kind it is.
pub async fn read_codex_account(
    rt: &Rt,
    app: &CodexApp,
    cli_path: Option<&str>,
    signal: Option<&Signal>,
) -> Result<JsonValue, JsError> {
    if signal.is_some_and(Signal::aborted) {
        return Err(abort_error());
    }
    let reading_rt = rt.clone();
    let reading_app = app.clone();
    let cli_path = cli_path.map(str::to_owned);
    let read = rt.share(async move {
        let kind_app = reading_app.clone();
        let outcome = with_client(
            &reading_rt,
            &reading_app,
            cli_path.as_deref(),
            None,
            |client| async move {
                let account = client
                    .request("account/read", Some(&refresh_token_false()))
                    .await?;
                if let Some(login) = codex_account_info(Some(&account)) {
                    kind_app.borrow_mut().status_login_kind = if login.signed_in {
                        login.login_kind
                    } else {
                        Some("signed-out".to_owned())
                    };
                }
                Ok(account)
            },
        )
        .await;
        if outcome.is_err() {
            // the status check went on without this reading, so it is no longer what the check saw
            reading_app.borrow_mut().status_login_kind = None;
        }
        outcome
    });
    abortable(rt, signal, read).await
}

/// `listCodexModels(cliPath)`: a `CodexModelCatalog`, `{ models, defaultModel }`.
pub async fn list_codex_models(
    rt: &Rt,
    app: &CodexApp,
    cli_path: Option<&str>,
) -> Result<JsonValue, JsError> {
    with_client(rt, app, cli_path, None, |client| async move {
        let answer = client
            .request("account/read", Some(&refresh_token_false()))
            .await?;
        let account = like(Some(&answer));
        if is_true(lget(account, "requiresOpenaiAuth"))
            && matches!(lget(account, "account"), None | Some(JsonValue::Null))
        {
            return Err(signed_out_error());
        }
        let catalog = model_catalog_of(&read_model_entries(&client).await?);
        Ok(object(vec![
            (
                "models",
                JsonValue::Array(catalog.models.iter().map(text).collect()),
            ),
            ("defaultModel", text(catalog.default_model)),
        ]))
    })
    .await
}

/// `codexSubscriptionModels(entries)`: the entries of `model/list` as the
/// connection status lists them: the id a selection stores, Codex's display
/// name, the model behind the id when that is another name, and which one an
/// empty selection runs on. That is the entry Codex flags as its default, or
/// the first one when it flags none: the same choice `defaultModelFor` makes
/// for a run.
pub fn codex_subscription_models(entries: &JsonValue) -> Vec<JsonValue> {
    let JsonValue::Array(entries) = entries else {
        return Vec::new();
    };
    let mut listed = Vec::new();
    for value in entries {
        let Some(entry) = like(Some(value)) else {
            continue;
        };
        if is_true(entry.get("hidden")) {
            continue;
        }
        let id = model_entry_id(entry);
        let efforts = model_entry_efforts(entry);
        if id.is_empty() {
            continue;
        }
        let resolved = match entry.get("model") {
            Some(JsonValue::String(model)) if *model != id => Some(text(model)),
            _ => None,
        };
        let (efforts_value, default_effort) = match &efforts {
            Some(efforts) => (
                Some(JsonValue::Array(efforts.iter().map(|e| text(*e)).collect())),
                entry.get("defaultReasoningEffort").cloned(),
            ),
            None => (None, None),
        };
        listed.push(entries_of_present(vec![
            ("id", Some(text(id))),
            (
                "label",
                Some(text(as_str(entry.get("displayName")).unwrap_or(""))),
            ),
            ("resolved", resolved),
            (
                "isDefault",
                is_true(entry.get("isDefault")).then_some(JsonValue::Bool(true)),
            ),
            ("efforts", efforts_value),
            ("defaultEffort", default_effort),
        ]));
    }
    // ids Codex could not be given back, and names out of bounds, end here
    let models = subscription_models_of(Some(&JsonValue::Array(listed))).unwrap_or_default();
    let flagged = models
        .iter()
        .rposition(|model| is_true(prop(model, "isDefault")));
    let fallback = flagged.or(if models.is_empty() { None } else { Some(0) });
    models
        .iter()
        .enumerate()
        .map(|(index, model)| {
            let resolved = match prop(model, "resolved") {
                Some(JsonValue::String(r)) if !r.is_empty() => Some(text(r)),
                _ => None,
            };
            let default_effort = match prop(model, "defaultEffort") {
                Some(JsonValue::String(d)) if !d.is_empty() => Some(text(d)),
                _ => None,
            };
            entries_of_present(vec![
                ("id", prop(model, "id").cloned()),
                ("label", prop(model, "label").cloned()),
                ("resolved", resolved),
                (
                    "isDefault",
                    (Some(index) == fallback).then_some(JsonValue::Bool(true)),
                ),
                ("efforts", prop(model, "efforts").cloned()),
                ("defaultEffort", default_effort),
            ])
        })
        .collect()
}

/// `listCodexSubscriptionModels(cliPath, signal)`: the models Codex offers,
/// read from the app-server's `model/list`: no thread is opened and no turn is
/// run, so nothing is asked of a model. It is what the subscription status
/// check asks for. The list is an array of `AiSubscriptionModel`.
pub async fn list_codex_subscription_models(
    rt: &Rt,
    app: &CodexApp,
    cli_path: Option<&str>,
    signal: Option<&Signal>,
) -> Result<JsonValue, JsError> {
    if signal.is_some_and(Signal::aborted) {
        return Err(abort_error());
    }
    let reading_rt = rt.clone();
    let reading_app = app.clone();
    let cli_path = cli_path.map(str::to_owned);
    let reading_signal = signal.cloned();
    let reading = rt.share(async move {
        with_client(
            &reading_rt,
            &reading_app,
            cli_path.as_deref(),
            reading_signal.as_ref(),
            |client| async move {
                let entries = read_model_entries(&client).await?;
                Ok(JsonValue::Array(codex_subscription_models(
                    &JsonValue::Array(entries),
                )))
            },
        )
        .await
    });
    abortable(rt, signal, reading).await
}
