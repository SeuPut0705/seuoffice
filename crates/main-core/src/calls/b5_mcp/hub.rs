//! Group `b5-mcp`, slice `hub`: see tools/main-diff/groups/b5-mcp/hub.ts.
//!
//! `hub.scenario` drives `McpHubIpc` (the hub behind the channels of
//! `hub-ipc.ts`) over a real store on `$DIR/mcp-servers.json` and the scripted
//! fake connections the spec describes. The Rust plays the world around the
//! sans-IO hub: every call of a fake connection is one line of the step's
//! `calls`, an operation that is not held answers at once (the answer reaches
//! the hub when the step's quiet point is pumped), a held one waits for a
//! `release` step or an abort, and the events of the fakes (a changed tool
//! list, a changed local state) are delivered before the answers. After each
//! step (and the batch of events it produced) the hub's notices are taken, each
//! is logged with the settings view it holds and the windows are told of each,
//! as `registerMcpHubIpc`'s listener does.
//!
//! `hub-app.scenario` is the app wiring (`AppHubHost`, `AppIpcHost`) over fake
//! windows; `hub.redirectSafeFetch` is the guard over a fake network.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use jscompat::{
    JsObject, JsonValue, decode_uri_component, encode_uri_component, js_regex, json_stringify,
    json_value_from_serde, json_value_to_serde,
};
use serde_json::Value;

use super::super::{Answer, CallError, Context, arg};
use crate::packages::agent_core::user_mcp_result::ShapedMcpResult;
use crate::packages::ai_provider::jsval::{as_str, number, object, prop, text};
use crate::packages::ai_provider::settings_secrets::{CodecThrow, SEALED_PREFIX};
use crate::packages::i18n::Lang;
use crate::packages::mcp_sdk::client::net::{
    Body, FetchError, FetchHost, FetchInit, FetchResponse, Headers, Redirect,
};
use crate::shell::ai_secrets::SafeStorageLike;
use crate::shell::mcp_client::fingerprint::{PlanEnv, PlanShape, plan_fingerprint};
use crate::shell::mcp_client::hub::{
    ConnError, ConnId, ConnOutcome, LocalConnection, LocalProblem, LocalReason, LocalState, McpHub,
    McpHubHost, OpId, RemoteConnection, RemoteReason, Reply, SharedStore, SignInOptions,
    SignInResult, Ticket, redirect_safe_fetch,
};
use crate::shell::mcp_client::hub_app::{
    AppHubHost, AppIpcHost, McpAppHost, McpConnectionFactory, McpWindow,
};
use crate::shell::mcp_client::hub_ipc::{IpcReply, IpcValue, McpHubIpc, McpHubIpcHost};
use crate::shell::mcp_client::listing::{
    ListedTool, McpListing, accept_first_listing, approve_launch,
};
use crate::shell::mcp_client::local_launch::{
    LaunchSource, LocalLaunchProblem, McpRuntimeId, PlannedEnvOrigin, PlannedEnvVar, PlannedLaunch,
    PlannedLaunchBlocked, PlannedLaunchReady, ResolveOptions, RuntimeDownloadItem, RuntimeMissing,
    RuntimeMissingDetail, RuntimeResolution, process_platform,
};
use crate::shell::mcp_client::secrets::{McpSecretCodec, SafeStorageMcpCodec};
use crate::shell::mcp_client::store::{
    McpOAuthConfig, McpServerConfig, McpServersFile, NewMcpServerInput, RuntimeAllowance,
    create_mcp_servers_store, mcp_servers_file_path, new_mcp_server_config,
    normalize_mcp_servers_file,
};
use crate::shell::mcp_servers_api::{McpFailReason, McpServerKind};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = cx;
    Some(match name {
        "hub.scenario" => scenario(args),
        "hub-app.scenario" => app_scenario(args),
        "hub.redirectSafeFetch" => redirect_case(args),
        _ => return None,
    })
}

// ---- small helpers over JsonValue --------------------------------------------

fn json_arg(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

fn out(value: JsonValue) -> Answer {
    Ok(Some(json_value_to_serde(&value)))
}

fn items(value: Option<&JsonValue>) -> Vec<JsonValue> {
    match value {
        Some(JsonValue::Array(items)) => items.clone(),
        _ => Vec::new(),
    }
}

fn strings(value: Option<&JsonValue>) -> Vec<String> {
    items(value)
        .iter()
        .filter_map(|i| as_str(Some(i)).map(str::to_owned))
        .collect()
}

fn string_map(value: Option<&JsonValue>) -> JsObject<String> {
    let mut out = JsObject::new();
    if let Some(JsonValue::Object(o)) = value {
        for (k, v) in o.entries() {
            if let JsonValue::String(s) = v {
                out.set(k, s.clone());
            }
        }
    }
    out
}

fn same(value: &JsonValue, other: &str) -> bool {
    matches!(value, JsonValue::String(s) if s == other)
}

/// `merge(into, patch)` of the spec: objects merge, anything else is replaced
fn merge(into: &mut JsonValue, patch: &JsonValue) {
    let JsonValue::Object(patch) = patch else {
        *into = patch.clone();
        return;
    };
    if !matches!(into, JsonValue::Object(_)) {
        *into = JsonValue::Object(JsObject::new());
    }
    let JsonValue::Object(target) = into else {
        return;
    };
    for (key, value) in patch.entries() {
        let both_objects = matches!(value, JsonValue::Object(_))
            && matches!(target.get(key), Some(JsonValue::Object(_)));
        if both_objects {
            if let Some(cur) = target.get_mut(key) {
                merge(cur, value);
            }
        } else {
            target.set(key, value.clone());
        }
    }
}

fn config_of(json: &JsonValue) -> Option<McpServerConfig> {
    normalize_mcp_servers_file(&object(vec![(
        "servers",
        JsonValue::Array(vec![json.clone()]),
    )]))
    .servers
    .into_iter()
    .next()
}

/// `sortKeys(value)`
fn sort_keys(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(items) => JsonValue::Array(items.iter().map(sort_keys).collect()),
        JsonValue::Object(o) => {
            let mut entries: Vec<(&str, &JsonValue)> = o.entries();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            let mut out = JsObject::new();
            for (k, v) in entries {
                out.set(k, sort_keys(v));
            }
            JsonValue::Object(out)
        }
        other => other.clone(),
    }
}

// ---- the fakes' vocabulary ---------------------------------------------------

fn remote_reason(name: &str) -> RemoteReason {
    match name {
        "http-error" => RemoteReason::HttpError,
        "timeout" => RemoteReason::Timeout,
        "aborted" => RemoteReason::Aborted,
        "refused-redirect" => RemoteReason::RefusedRedirect,
        "insecure-address" => RemoteReason::InsecureAddress,
        "login-required" => RemoteReason::LoginRequired,
        "server-error" => RemoteReason::ServerError,
        _ => RemoteReason::Unreachable,
    }
}

fn local_reason(name: &str) -> LocalReason {
    match name {
        "disabled" => LocalReason::Disabled,
        "review-required" => LocalReason::ReviewRequired,
        "start-failed" => LocalReason::StartFailed,
        "runtime-missing" => LocalReason::RuntimeMissing,
        "timeout" => LocalReason::Timeout,
        _ => LocalReason::Unreachable,
    }
}

fn launch_problem(name: &str) -> LocalLaunchProblem {
    match name {
        "empty-command" => LocalLaunchProblem::EmptyCommand,
        "needs-command-window" => LocalLaunchProblem::NeedsCommandWindow,
        "not-a-program" => LocalLaunchProblem::NotAProgram,
        _ => LocalLaunchProblem::RuntimeMissing,
    }
}

fn local_problem(name: &str) -> LocalProblem {
    if name == "did-not-start" {
        LocalProblem::DidNotStart
    } else {
        LocalProblem::Launch(launch_problem(name))
    }
}

fn fail_reason(name: &str) -> McpFailReason {
    if name == "runtime-missing" {
        McpFailReason::RuntimeMissing
    } else {
        McpFailReason::StartFailed
    }
}

fn local_state_of(state: &JsonValue) -> LocalState {
    match as_str(prop(state, "state")) {
        Some("starting") => LocalState::Starting,
        Some("running") => LocalState::Running,
        Some("review-required") => LocalState::ReviewRequired,
        Some("failed") => LocalState::Failed {
            reason: fail_reason(as_str(prop(state, "reason")).unwrap_or_default()),
            problem: local_problem(as_str(prop(state, "problem")).unwrap_or_default()),
            message: as_str(prop(state, "message"))
                .unwrap_or_default()
                .to_owned(),
        },
        _ => LocalState::Idle,
    }
}

fn listing_of(value: &JsonValue) -> McpListing {
    McpListing {
        tools: items(prop(value, "tools"))
            .iter()
            .map(|t| ListedTool {
                name: as_str(prop(t, "name")).unwrap_or_default().to_owned(),
                description: as_str(prop(t, "description")).map(str::to_owned),
                input_schema: prop(t, "inputSchema").cloned(),
                annotations: prop(t, "annotations").cloned(),
            })
            .collect(),
        instructions: as_str(prop(value, "instructions")).map(str::to_owned),
    }
}

fn runtime_id(name: &str) -> McpRuntimeId {
    match name {
        "uv" => McpRuntimeId::Uv,
        "python" => McpRuntimeId::Python,
        _ => McpRuntimeId::Node,
    }
}

fn missing_detail(name: &str) -> RuntimeMissingDetail {
    match name {
        "unsupported-platform" => RuntimeMissingDetail::UnsupportedPlatform,
        "declined" => RuntimeMissingDetail::Declined,
        "download-needed" => RuntimeMissingDetail::DownloadNeeded,
        "offline" => RuntimeMissingDetail::Offline,
        "hash-mismatch" => RuntimeMissingDetail::HashMismatch,
        "extract-failed" => RuntimeMissingDetail::ExtractFailed,
        "python-install-failed" => RuntimeMissingDetail::PythonInstallFailed,
        _ => RuntimeMissingDetail::NotFound,
    }
}

/// a `PlannedLaunch` as the spec writes it
fn plan_of(plan: &JsonValue) -> PlannedLaunch {
    if matches!(prop(plan, "ok"), Some(JsonValue::Bool(true))) {
        return PlannedLaunch::Ready(PlannedLaunchReady {
            command: as_str(prop(plan, "command")).unwrap_or_default().to_owned(),
            args: strings(prop(plan, "args")),
            added_args: strings(prop(plan, "addedArgs")),
            env: items(prop(plan, "env"))
                .iter()
                .map(|e| PlannedEnvVar {
                    name: as_str(prop(e, "name")).unwrap_or_default().to_owned(),
                    origin: match as_str(prop(e, "origin")) {
                        Some("registered") => PlannedEnvOrigin::Registered,
                        Some("app") => PlannedEnvOrigin::App,
                        _ => PlannedEnvOrigin::System,
                    },
                })
                .collect(),
            dropped_env: strings(prop(plan, "droppedEnv")),
            source: if as_str(prop(plan, "source")) == Some("app") {
                LaunchSource::App
            } else {
                LaunchSource::Pc
            },
            runtime: as_str(prop(plan, "runtime")).map(runtime_id),
        });
    }
    let runtime = match prop(plan, "runtime") {
        Some(missing @ JsonValue::Object(_)) => Some(RuntimeMissing {
            detail: missing_detail(as_str(prop(missing, "detail")).unwrap_or_default()),
            runtime: as_str(prop(missing, "runtime")).map(runtime_id),
            downloads: items(prop(missing, "downloads"))
                .iter()
                .map(|d| RuntimeDownloadItem {
                    runtime: runtime_id(as_str(prop(d, "runtime")).unwrap_or_default()),
                    version: as_str(prop(d, "version")).unwrap_or_default().to_owned(),
                    bytes: match prop(d, "bytes") {
                        Some(JsonValue::Number(n)) => *n,
                        _ => 0.0,
                    },
                })
                .collect(),
            message: as_str(prop(missing, "message"))
                .unwrap_or_default()
                .to_owned(),
        }),
        _ => None,
    };
    PlannedLaunch::Blocked(PlannedLaunchBlocked {
        problem: launch_problem(as_str(prop(plan, "problem")).unwrap_or_default()),
        runtime,
        message: as_str(prop(plan, "message")).unwrap_or_default().to_owned(),
    })
}

/// `planFingerprint(plan)` of a ready plan as the spec writes it
fn fingerprint_of(plan: &JsonValue) -> String {
    match plan_of(plan) {
        PlannedLaunch::Ready(ready) => plan_fingerprint(&PlanShape {
            command: ready.command,
            args: ready.args,
            env: ready
                .env
                .iter()
                .map(|e| PlanEnv {
                    name: e.name.clone(),
                    origin: e.origin.as_str().to_owned(),
                })
                .collect(),
        }),
        PlannedLaunch::Blocked(_) => String::new(),
    }
}

fn remote_defaults() -> JsonValue {
    json_value_from_serde(&serde_json::json!({
        "listing": "LISTING",
        "listError": null,
        "callResult": { "content": [{ "type": "text", "text": "found it" }] },
        "callErrors": [],
        "hold": [],
        "signInNeeded": false,
        "signInResult": { "ok": true },
        "signInOpens": null,
    }))
}

fn local_defaults() -> JsonValue {
    json_value_from_serde(&serde_json::json!({
        "listing": "LISTING",
        "listError": null,
        "ensureError": null,
        "callResult": { "output": "local result", "isError": false },
        "hold": [],
        "listSetsRunning": false,
        "stderr": ["npm ERR! could not find package"],
        "state": { "state": "idle" },
    }))
}

// ---- the fake connections ----------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum OpKind {
    RemoteList,
    RemoteCall,
    SignIn,
    Revoke,
    Close,
    LocalEnsure,
    LocalList,
    LocalCall,
    Stop,
}

struct ConnState {
    label: String,
    conn: ConnId,
    cfg: JsonValue,
    state: LocalState,
}

struct Held {
    label: String,
    method: String,
    op: OpId,
    kind: OpKind,
    st: Rc<RefCell<ConnState>>,
}

enum Event {
    ToolsChanged(ConnId),
    StateChanged(ConnId, LocalState),
}

struct Shared {
    logs: Vec<String>,
    held: Vec<Held>,
    ready: VecDeque<(OpId, ConnOutcome)>,
    /// operations started and not yet delivered: label, method, kind
    live: HashMap<OpId, (String, String, OpKind)>,
    events: VecDeque<Event>,
    conns: HashMap<String, Rc<RefCell<ConnState>>>,
    listings: HashMap<String, McpListing>,
    remote_count: usize,
    local_count: usize,
    remote_defaults: JsonValue,
    local_defaults: JsonValue,
    plan: JsonValue,
    plan_hook: Option<(String, JsonValue)>,
    lang: Lang,
    watchable: HashSet<i64>,
    onces: HashMap<i64, usize>,
    sent: Vec<(i64, String)>,
    store: Option<SharedStore<'static>>,
    clock: Rc<Cell<f64>>,
}

type SharedRef = Rc<RefCell<Shared>>;

fn held_method(cfg: &JsonValue, method: &str) -> bool {
    items(prop(cfg, "hold")).iter().any(|m| same(m, method))
}

fn cfg_error(cfg: &JsonValue, key: &str) -> Option<JsonValue> {
    match prop(cfg, key) {
        Some(JsonValue::Null) | None => None,
        Some(other) => Some(other.clone()),
    }
}

fn local_error(e: &JsonValue) -> ConnError {
    ConnError::Local {
        reason: local_reason(as_str(prop(e, "reason")).unwrap_or_default()),
        problem: as_str(prop(e, "problem")).map(local_problem),
    }
}

/// what an operation answers, as the spec's fake computes it
fn outcome_of(sh: &mut Shared, st: &Rc<RefCell<ConnState>>, kind: OpKind) -> ConnOutcome {
    let mut st = st.borrow_mut();
    match kind {
        OpKind::RemoteList => match cfg_error(&st.cfg, "listError") {
            Some(JsonValue::String(reason)) if !reason.is_empty() => {
                ConnOutcome::Listed(Err(ConnError::Remote(remote_reason(&reason))))
            }
            _ => {
                let name = as_str(prop(&st.cfg, "listing"))
                    .unwrap_or_default()
                    .to_owned();
                ConnOutcome::Listed(Ok(sh.listings.get(&name).cloned().unwrap_or(McpListing {
                    tools: Vec::new(),
                    instructions: None,
                })))
            }
        },
        OpKind::RemoteCall => {
            let first = match st.cfg.clone() {
                JsonValue::Object(_) => match items(prop(&st.cfg, "callErrors")).first() {
                    Some(JsonValue::String(reason)) => Some(reason.clone()),
                    _ => None,
                },
                _ => None,
            };
            if let Some(reason) = first {
                if let JsonValue::Object(o) = &mut st.cfg
                    && let Some(JsonValue::Array(list)) = o.get_mut("callErrors")
                {
                    list.remove(0);
                }
                return ConnOutcome::RemoteCalled(Err(ConnError::Remote(remote_reason(&reason))));
            }
            ConnOutcome::RemoteCalled(Ok(prop(&st.cfg, "callResult")
                .cloned()
                .unwrap_or(JsonValue::Null)))
        }
        OpKind::SignIn => {
            let result = prop(&st.cfg, "signInResult")
                .cloned()
                .unwrap_or(JsonValue::Null);
            ConnOutcome::SignedIn(
                if matches!(prop(&result, "ok"), Some(JsonValue::Bool(true))) {
                    SignInResult::Ok
                } else {
                    SignInResult::Failed(
                        as_str(prop(&result, "reason"))
                            .unwrap_or_default()
                            .to_owned(),
                    )
                },
            )
        }
        OpKind::Revoke => ConnOutcome::Revoked,
        OpKind::Close => ConnOutcome::Closed,
        OpKind::Stop => ConnOutcome::Stopped,
        OpKind::LocalEnsure => {
            if let LocalState::Failed {
                reason, problem, ..
            } = &st.state
            {
                return ConnOutcome::Ensured(Err(ConnError::Local {
                    reason: if *reason == McpFailReason::RuntimeMissing {
                        LocalReason::RuntimeMissing
                    } else {
                        LocalReason::StartFailed
                    },
                    problem: Some(*problem),
                }));
            }
            match cfg_error(&st.cfg, "ensureError") {
                Some(e) => ConnOutcome::Ensured(Err(local_error(&e))),
                None => ConnOutcome::Ensured(Ok(())),
            }
        }
        OpKind::LocalList => {
            if st.state == LocalState::ReviewRequired {
                return ConnOutcome::Listed(Err(ConnError::Local {
                    reason: LocalReason::ReviewRequired,
                    problem: None,
                }));
            }
            if let Some(e) = cfg_error(&st.cfg, "listError") {
                return ConnOutcome::Listed(Err(local_error(&e)));
            }
            if matches!(
                prop(&st.cfg, "listSetsRunning"),
                Some(JsonValue::Bool(true))
            ) {
                st.state = LocalState::Running;
                let conn = st.conn;
                sh.events
                    .push_back(Event::StateChanged(conn, LocalState::Running));
            }
            let name = as_str(prop(&st.cfg, "listing"))
                .unwrap_or_default()
                .to_owned();
            ConnOutcome::Listed(Ok(sh.listings.get(&name).cloned().unwrap_or(McpListing {
                tools: Vec::new(),
                instructions: None,
            })))
        }
        OpKind::LocalCall => {
            let result = prop(&st.cfg, "callResult")
                .cloned()
                .unwrap_or(JsonValue::Null);
            ConnOutcome::LocalCalled(Ok(ShapedMcpResult {
                output: as_str(prop(&result, "output"))
                    .unwrap_or_default()
                    .to_owned(),
                is_error: matches!(prop(&result, "isError"), Some(JsonValue::Bool(true))),
            }))
        }
    }
}

/// what an aborted operation answers
fn abort_outcome(kind: OpKind) -> ConnOutcome {
    match kind {
        OpKind::RemoteList => ConnOutcome::Listed(Err(ConnError::Remote(RemoteReason::Aborted))),
        OpKind::RemoteCall => {
            ConnOutcome::RemoteCalled(Err(ConnError::Remote(RemoteReason::Aborted)))
        }
        OpKind::SignIn => ConnOutcome::SignedIn(SignInResult::Failed("cancelled".to_owned())),
        OpKind::LocalEnsure => ConnOutcome::Ensured(Err(ConnError::Abort)),
        OpKind::LocalList => ConnOutcome::Listed(Err(ConnError::Abort)),
        OpKind::LocalCall => ConnOutcome::LocalCalled(Err(ConnError::Abort)),
        OpKind::Revoke => ConnOutcome::Revoked,
        OpKind::Close => ConnOutcome::Closed,
        OpKind::Stop => ConnOutcome::Stopped,
    }
}

/// `operation(...)` of the spec: one operation of a fake starts
fn start(
    sh: &SharedRef,
    st: &Rc<RefCell<ConnState>>,
    op: OpId,
    method: &str,
    kind: OpKind,
    detail: &str,
) {
    let label = st.borrow().label.clone();
    let mut s = sh.borrow_mut();
    s.logs.push(format!("{label}.{method}{detail}"));
    s.live.insert(op, (label.clone(), method.to_owned(), kind));
    if held_method(&st.borrow().cfg, method) {
        s.held.push(Held {
            label,
            method: method.to_owned(),
            op,
            kind,
            st: st.clone(),
        });
        return;
    }
    let outcome = outcome_of(&mut s, st, kind);
    s.ready.push_back((op, outcome));
}

/// the `AbortSignal` of `op` aborted
fn abort_op(sh: &SharedRef, op: OpId) {
    let mut s = sh.borrow_mut();
    let Some((label, method, kind)) = s.live.remove(&op) else {
        return;
    };
    s.logs.push(format!("{label}.abort {method}"));
    s.held.retain(|h| h.op != op);
    s.ready.retain(|(o, _)| *o != op);
    s.ready.push_back((op, abort_outcome(kind)));
}

struct FakeRemote {
    st: Rc<RefCell<ConnState>>,
    sh: SharedRef,
}

impl RemoteConnection<'static> for FakeRemote {
    fn list_tools(&mut self, op: OpId) {
        start(&self.sh, &self.st, op, "listTools", OpKind::RemoteList, "");
    }

    fn call_tool(&mut self, op: OpId, name: &str, args: &JsonValue) {
        let detail = format!(" {name} {}", json_stringify(args));
        start(
            &self.sh,
            &self.st,
            op,
            "callTool",
            OpKind::RemoteCall,
            &detail,
        );
    }

    fn needs_sign_in(&self) -> bool {
        matches!(
            prop(&self.st.borrow().cfg, "signInNeeded"),
            Some(JsonValue::Bool(true))
        )
    }

    fn sign_in(&mut self, op: OpId, options: SignInOptions<'static>) {
        let done = &options.pages.done;
        let detail = format!(
            " {}",
            json_stringify(&object(vec![
                ("lang", text(done.lang.as_str())),
                ("title", text(done.title.as_str())),
            ]))
        );
        start(&self.sh, &self.st, op, "signIn", OpKind::SignIn, &detail);
        let opens = as_str(prop(&self.st.borrow().cfg, "signInOpens")).map(str::to_owned);
        if let Some(url) = opens {
            let ok = (options.open_external)(&url);
            let label = self.st.borrow().label.clone();
            self.sh
                .borrow_mut()
                .logs
                .push(format!("{label}.openExternal {url} -> {ok}"));
        }
    }

    fn revoke(&mut self, op: OpId) {
        start(&self.sh, &self.st, op, "revoke", OpKind::Revoke, "");
    }

    fn close(&mut self, op: OpId) {
        start(&self.sh, &self.st, op, "close", OpKind::Close, "");
    }

    fn abort(&mut self, op: OpId) {
        abort_op(&self.sh, op);
    }
}

struct FakeLocal {
    st: Rc<RefCell<ConnState>>,
    sh: SharedRef,
}

impl LocalConnection for FakeLocal {
    fn status(&self) -> LocalState {
        self.st.borrow().state.clone()
    }

    fn stderr_tail(&self) -> Vec<String> {
        strings(prop(&self.st.borrow().cfg, "stderr"))
    }

    fn ensure(&mut self, op: OpId) {
        start(&self.sh, &self.st, op, "ensure", OpKind::LocalEnsure, "");
    }

    fn list_tools(&mut self, op: OpId) {
        start(&self.sh, &self.st, op, "listTools", OpKind::LocalList, "");
    }

    fn call_tool(&mut self, op: OpId, name: &str, args: &JsonValue) {
        let detail = format!(" {name} {}", json_stringify(args));
        start(
            &self.sh,
            &self.st,
            op,
            "callTool",
            OpKind::LocalCall,
            &detail,
        );
    }

    fn stop(&mut self, op: OpId) {
        start(&self.sh, &self.st, op, "stop", OpKind::Stop, "");
    }

    fn retry(&mut self) {
        let label = self.st.borrow().label.clone();
        self.sh.borrow_mut().logs.push(format!("{label}.retry"));
        let failed = matches!(self.st.borrow().state, LocalState::Failed { .. });
        if failed {
            let conn = {
                let mut st = self.st.borrow_mut();
                st.state = LocalState::Idle;
                st.conn
            };
            self.sh
                .borrow_mut()
                .events
                .push_back(Event::StateChanged(conn, LocalState::Idle));
        }
    }

    fn set_server(&mut self, _server: &McpServerConfig) {
        let label = self.st.borrow().label.clone();
        self.sh.borrow_mut().logs.push(format!("{label}.setServer"));
    }

    fn abort(&mut self, op: OpId) {
        abort_op(&self.sh, op);
    }

    fn abort_app(&mut self) {
        let label = self.st.borrow().label.clone();
        self.sh.borrow_mut().logs.push(format!("{label}.appAbort"));
    }
}

fn new_remote(sh: &SharedRef, conn: ConnId) -> Box<dyn RemoteConnection<'static> + 'static> {
    let mut s = sh.borrow_mut();
    s.remote_count += 1;
    let label = format!("remote#{}", s.remote_count);
    let st = Rc::new(RefCell::new(ConnState {
        label: label.clone(),
        conn,
        cfg: s.remote_defaults.clone(),
        state: LocalState::Idle,
    }));
    s.conns.insert(label, st.clone());
    Box::new(FakeRemote { st, sh: sh.clone() })
}

fn new_local(sh: &SharedRef, conn: ConnId) -> Box<dyn LocalConnection + 'static> {
    let mut s = sh.borrow_mut();
    s.local_count += 1;
    let label = format!("local#{}", s.local_count);
    let cfg = s.local_defaults.clone();
    let state = local_state_of(prop(&cfg, "state").unwrap_or(&JsonValue::Null));
    let st = Rc::new(RefCell::new(ConnState {
        label: label.clone(),
        conn,
        cfg,
        state,
    }));
    s.conns.insert(label, st.clone());
    Box::new(FakeLocal { st, sh: sh.clone() })
}

/// the hub's deps of the spec
struct Host {
    sh: SharedRef,
}

fn resolve_missing() -> RuntimeResolution {
    RuntimeResolution::Missing(RuntimeMissing {
        detail: RuntimeMissingDetail::Offline,
        runtime: None,
        downloads: Vec::new(),
        message: "offline".to_owned(),
    })
}

fn planned(sh: &SharedRef) -> PlannedLaunch {
    sh.borrow_mut().logs.push("plannedLaunch".to_owned());
    let (hook, store) = {
        let mut s = sh.borrow_mut();
        (s.plan_hook.take(), s.store.clone())
    };
    if let (Some((name, set)), Some(store)) = (hook, store) {
        let _ = store.borrow_mut().update(&mut |file| {
            if let Some(target) = file.servers.iter_mut().find(|s| s.name == name) {
                *target = assigned(target, &set);
            }
            None
        });
    }
    plan_of(&sh.borrow().plan.clone())
}

/// `Object.assign(server, set)`
fn assigned(server: &McpServerConfig, set: &JsonValue) -> McpServerConfig {
    let mut json = server.to_json();
    if let (JsonValue::Object(target), JsonValue::Object(set)) = (&mut json, set) {
        for (k, v) in set.entries() {
            target.set(k, v.clone());
        }
    }
    config_of(&json).unwrap_or_else(|| server.clone())
}

fn open_external_logged(sh: &SharedRef, url: &str) -> bool {
    sh.borrow_mut().logs.push(format!("openExternal {url}"));
    true
}

impl McpHubHost<'static> for Host {
    fn remote(
        &self,
        conn: ConnId,
        _server: &McpServerConfig,
        _store: &SharedStore<'static>,
    ) -> Box<dyn RemoteConnection<'static> + 'static> {
        new_remote(&self.sh, conn)
    }

    fn local(&self, conn: ConnId, _server: &McpServerConfig) -> Box<dyn LocalConnection + 'static> {
        new_local(&self.sh, conn)
    }

    fn resolve_command(&self, command: &str, options: &ResolveOptions) -> RuntimeResolution {
        self.sh.borrow_mut().logs.push(format!(
            "kit.resolveCommand {command} offerDownload={}",
            options.offer_download
        ));
        resolve_missing()
    }

    fn planned_launch(&self, _server: &McpServerConfig) -> PlannedLaunch {
        planned(&self.sh)
    }

    fn lang(&self) -> Lang {
        self.sh.borrow().lang
    }

    fn open_external(&self, url: &str) -> bool {
        open_external_logged(&self.sh, url)
    }

    fn open_settings(&self, server_id: &str) {
        self.sh
            .borrow_mut()
            .logs
            .push(format!("openSettings {server_id}"));
    }

    fn now_ms(&self) -> f64 {
        self.sh.borrow().clock.get()
    }
}

/// the window parts of `registerMcpHubIpc`'s deps: the shell window (id 1)
/// and an editor (id 7)
struct IpcHost {
    sh: SharedRef,
}

impl McpHubIpcHost for IpcHost {
    fn is_settings_sender(&mut self, sender_id: f64) -> bool {
        sender_id == 1.0
    }

    fn watch_destroyed(&mut self, sender_id: f64) -> bool {
        let id = sender_id as i64;
        let mut s = self.sh.borrow_mut();
        if !s.watchable.contains(&id) {
            return false;
        }
        *s.onces.entry(id).or_insert(0) += 1;
        true
    }

    fn broadcast_tools_changed(&mut self) {
        let mut s = self.sh.borrow_mut();
        s.sent.push((1, "mcp-tools:changed".to_owned()));
        s.sent.push((7, "mcp-tools:changed".to_owned()));
    }

    fn settings_window_open(&mut self) -> bool {
        true
    }

    fn send_settings_changed(&mut self, _view: &JsonValue) {
        self.sh
            .borrow_mut()
            .sent
            .push((1, "mcp-servers:changed".to_owned()));
    }
}

// ---- the store of the case ----------------------------------------------------

struct FakeCodec;

impl McpSecretCodec for FakeCodec {
    fn can_seal(&self) -> bool {
        true
    }

    fn seal(&self, plain: &str) -> Result<String, CodecThrow> {
        Ok(format!("{SEALED_PREFIX}{}", encode_uri_component(plain)))
    }

    fn open(&self, sealed: &str) -> Result<Option<String>, CodecThrow> {
        if !sealed.starts_with(SEALED_PREFIX) {
            return Ok(None);
        }
        decode_uri_component(&sealed[SEALED_PREFIX.len()..])
            .map(Some)
            .map_err(|e| CodecThrow(e.to_string()))
    }
}

fn seed_server(
    listings: &HashMap<String, McpListing>,
    spec: &JsonValue,
) -> Option<McpServerConfig> {
    let kind = if as_str(prop(spec, "kind")) == Some("local") {
        McpServerKind::Local
    } else {
        McpServerKind::Remote
    };
    let get = |key: &str| prop(spec, key);
    let input = NewMcpServerInput {
        name: as_str(get("name")).unwrap_or_default().to_owned(),
        kind: Some(kind),
        url: as_str(get("url")).map(str::to_owned),
        transport: None,
        headers: get("headers").map(|h| string_map(Some(h))),
        oauth: match get("oauth") {
            Some(o @ JsonValue::Object(_)) => Some(McpOAuthConfig {
                client_id: as_str(prop(o, "clientId")).unwrap_or_default().to_owned(),
                client_secret: as_str(prop(o, "clientSecret"))
                    .unwrap_or_default()
                    .to_owned(),
                tokens: as_str(prop(o, "tokens")).unwrap_or_default().to_owned(),
            }),
            _ => None,
        },
        command: as_str(get("command")).map(str::to_owned),
        args: get("args").map(|a| strings(Some(a))),
        env: get("env").map(|e| string_map(Some(e))),
    };
    let mut json = new_mcp_server_config(&input).to_json();
    if matches!(get("approvePlan"), Some(JsonValue::Bool(true))) {
        let ready = json_value_from_serde(&serde_json::json!({
            "ok": true,
            "command": "/usr/bin/node",
            "args": ["/usr/lib/npx-cli.js", "--yes", "-y", "docs-mcp"],
            "addedArgs": ["--yes"],
            "env": [
                { "name": "PATH", "origin": "system" },
                { "name": "API_KEY", "origin": "registered" }
            ],
            "droppedEnv": [],
            "source": "pc",
            "runtime": "node",
        }));
        json = approve_launch(&json, &fingerprint_of(&ready));
    }
    if let Some(name) = as_str(get("listing"))
        && let Some(listing) = listings.get(name)
    {
        json = accept_first_listing(&json, listing);
    }
    if let Some(patch) = get("patch") {
        merge(&mut json, patch);
    }
    config_of(&json)
}

// ---- the world ---------------------------------------------------------------

struct Entry {
    label: String,
    done: bool,
    value: JsonValue,
    reported: bool,
}

struct World {
    sh: SharedRef,
    store: SharedStore<'static>,
    ipc: McpHubIpc<'static>,
    host: IpcHost,
    dir: String,
    names: Vec<(String, String)>,
    tokens: Vec<String>,
    plans: JsonValue,
    clock: Rc<Cell<f64>>,
    entries: Vec<Entry>,
    tickets: HashMap<Ticket, String>,
}

const UNDEFINED: &str = "<undefined>";

fn make_world(config: &JsonValue) -> Result<World, CallError> {
    let dir = as_str(prop(config, "dir"))
        .ok_or_else(|| CallError::plain("no dir"))?
        .to_owned();
    let mut listings = HashMap::new();
    if let Some(JsonValue::Object(o)) = prop(config, "listings") {
        for (name, value) in o.entries() {
            listings.insert(name.to_owned(), listing_of(value));
        }
    }
    let mut r_defaults = remote_defaults();
    if let Some(patch) = prop(config, "remote") {
        merge(&mut r_defaults, patch);
    }
    let mut l_defaults = local_defaults();
    if let Some(patch) = prop(config, "local") {
        merge(&mut l_defaults, patch);
    }
    let plan = prop(config, "plan").cloned().unwrap_or_else(|| {
        json_value_from_serde(&serde_json::json!({
            "ok": true,
            "command": "/usr/bin/node",
            "args": ["/usr/lib/npx-cli.js", "--yes", "-y", "docs-mcp"],
            "addedArgs": ["--yes"],
            "env": [
                { "name": "PATH", "origin": "system" },
                { "name": "API_KEY", "origin": "registered" }
            ],
            "droppedEnv": [],
            "source": "pc",
            "runtime": "node",
        }))
    });
    let clock = Rc::new(Cell::new(1_794_452_400_000.0));
    let lang = if as_str(prop(config, "lang")) == Some("ko") {
        Lang::Ko
    } else {
        Lang::En
    };
    let sh: SharedRef = Rc::new(RefCell::new(Shared {
        logs: Vec::new(),
        held: Vec::new(),
        ready: VecDeque::new(),
        live: HashMap::new(),
        events: VecDeque::new(),
        conns: HashMap::new(),
        listings: listings.clone(),
        remote_count: 0,
        local_count: 0,
        remote_defaults: r_defaults,
        local_defaults: l_defaults,
        plan,
        plan_hook: None,
        lang,
        watchable: HashSet::new(),
        onces: HashMap::new(),
        sent: Vec::new(),
        store: None,
        clock: clock.clone(),
    }));
    let file = format!("{dir}/mcp-servers.json");
    let store: SharedStore<'static> = Rc::new(RefCell::new(create_mcp_servers_store(
        &file,
        Rc::new(FakeCodec),
    )));
    store.borrow_mut().load();
    let mut servers = Vec::new();
    for spec in items(prop(config, "servers")) {
        if let Some(server) = seed_server(&listings, &spec) {
            servers.push(server);
        }
    }
    let mut names = Vec::new();
    for s in &servers {
        names.push((s.id.clone(), s.name.clone()));
    }
    let runtimes = prop(config, "runtimes").cloned();
    store
        .borrow_mut()
        .update(&mut |f: &mut McpServersFile| {
            f.servers.extend(servers.iter().cloned());
            if let Some(JsonValue::Object(o)) = &runtimes {
                for (k, v) in o.entries() {
                    let allowed = matches!(prop(v, "allowed"), Some(JsonValue::Bool(true)));
                    f.runtimes.set(k, RuntimeAllowance { allowed });
                }
            }
            None
        })
        .map_err(CallError::from)?;
    sh.borrow_mut().store = Some(store.clone());
    let host: Rc<dyn McpHubHost<'static>> = Rc::new(Host { sh: sh.clone() });
    let hub = McpHub::new(host, store.clone());
    Ok(World {
        sh: sh.clone(),
        store,
        ipc: McpHubIpc::new(hub),
        host: IpcHost { sh },
        dir,
        names,
        tokens: Vec::new(),
        plans: prop(config, "plans").cloned().unwrap_or(JsonValue::Null),
        clock,
        entries: Vec::new(),
        tickets: HashMap::new(),
    })
}

/// the quiet point: the fakes' events and answers reach the hub until none is left
fn pump(ipc: &mut McpHubIpc<'static>, sh: &SharedRef) {
    loop {
        let event = sh.borrow_mut().events.pop_front();
        if let Some(event) = event {
            match event {
                Event::ToolsChanged(conn) => ipc.hub.on_tools_changed(conn),
                Event::StateChanged(conn, state) => ipc.hub.on_local_state_changed(conn, &state),
            }
            continue;
        }
        let ready = sh.borrow_mut().ready.pop_front();
        if let Some((op, outcome)) = ready {
            sh.borrow_mut().live.remove(&op);
            ipc.hub.on_settled(op, outcome);
            continue;
        }
        break;
    }
}

// ---- the steps ---------------------------------------------------------------

fn subst(world: &World, value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::String(s) => {
            if let Some(name) = s.strip_prefix("$id:") {
                let id = world
                    .store
                    .borrow()
                    .get()
                    .servers
                    .iter()
                    .find(|x| x.name == name)
                    .map(|x| x.id.clone());
                return text(id.unwrap_or_else(|| format!("no-server-{name}")));
            }
            if let Some(n) = s.strip_prefix("$paste:") {
                return text(
                    n.parse::<usize>()
                        .ok()
                        .and_then(|i| world.tokens.get(i).cloned())
                        .unwrap_or_else(|| "no-token".to_owned()),
                );
            }
            if s == "$fp" {
                return text(fingerprint_of(&world.sh.borrow().plan));
            }
            if let Some(name) = s.strip_prefix("$fp:") {
                return text(fingerprint_of(
                    prop(&world.plans, name).unwrap_or(&JsonValue::Null),
                ));
            }
            value.clone()
        }
        JsonValue::Array(items) => {
            JsonValue::Array(items.iter().map(|v| subst(world, v)).collect())
        }
        JsonValue::Object(o) => {
            let mut out = JsObject::new();
            for (k, v) in o.entries() {
                out.set(k, subst(world, v));
            }
            JsonValue::Object(out)
        }
        other => other.clone(),
    }
}

/// who sent: the id and whether the sender can be watched
fn sender_of(world: &World, name: &str) -> f64 {
    if let Some(id) = name
        .strip_prefix("watch:")
        .and_then(|n| n.parse::<i64>().ok())
    {
        world.sh.borrow_mut().watchable.insert(id);
        return id as f64;
    }
    if let Some(id) = name
        .strip_prefix("plain:")
        .and_then(|n| n.parse::<i64>().ok())
    {
        return id as f64;
    }
    if name == "shell" { 1.0 } else { 7.0 }
}

fn dispatch<H: McpHubIpcHost>(
    ipc: &mut McpHubIpc<'static>,
    host: &mut H,
    channel: &str,
    sender: f64,
    args: &[JsonValue],
) -> Option<IpcReply> {
    let a = |i: usize| args.get(i);
    Some(match channel {
        "mcp-tools:list" => IpcReply::Now(Ok(Some(ipc.tools_list()))),
        "mcp-tools:call" => ipc.tools_call(host, sender, a(0)),
        "mcp-tools:cancel" => {
            ipc.tools_cancel(sender, a(0));
            IpcReply::Now(Ok(None))
        }
        "mcp-tools:retry" => IpcReply::Now(Ok(Some(ipc.tools_retry(a(0))))),
        "mcp-tools:open-settings" => IpcReply::Now(Ok(Some(ipc.tools_open_settings(a(0))))),
        "mcp-servers:list" => ipc.servers_list(host, sender),
        "mcp-servers:parse-paste" => ipc.servers_parse_paste(host, sender, a(0)),
        "mcp-servers:add" => ipc.servers_add(host, sender, a(0)),
        "mcp-servers:edit" => ipc.servers_edit(host, sender, a(0), a(1)),
        "mcp-servers:remove" => ipc.servers_remove(host, sender, a(0)),
        "mcp-servers:test" => ipc.servers_test(host, sender, a(0)),
        "mcp-servers:sign-in" => ipc.servers_sign_in(host, sender, a(0)),
        "mcp-servers:cancel-sign-in" => ipc.servers_cancel_sign_in(host, sender, a(0)),
        "mcp-servers:approve-tool" => ipc.servers_approve_tool(host, sender, a(0), a(1)),
        "mcp-servers:approve-instructions" => ipc.servers_approve_instructions(host, sender, a(0)),
        "mcp-servers:approve-launch" => ipc.servers_approve_launch(host, sender, a(0), a(1)),
        "mcp-servers:set-tool-permission" => {
            ipc.servers_set_tool_permission(host, sender, a(0), a(1), a(2))
        }
        "mcp-servers:set-keep-results-inside" => {
            ipc.servers_set_keep_results_inside(host, sender, a(0), a(1))
        }
        "mcp-servers:set-enabled" => ipc.servers_set_enabled(host, sender, a(0), a(1)),
        "mcp-servers:mark-tools-seen" => ipc.servers_mark_tools_seen(host, sender, a(0)),
        "mcp-servers:planned-launch" => ipc.servers_planned_launch(host, sender, a(0)),
        "mcp-servers:answer-runtime-download" => {
            ipc.servers_answer_runtime_download(host, sender, a(0), a(1))
        }
        "mcp-servers:retry" => ipc.servers_retry(host, sender, a(0)),
        _ => return None,
    })
}

fn rejected(message: &str) -> JsonValue {
    object(vec![("rejected", text(message))])
}

/// what a handler's value prints as: `undefined` is `<undefined>`, `null` stays `null`
fn printed(result: IpcValue) -> JsonValue {
    match result {
        Ok(Some(value)) => value,
        Ok(None) => text(UNDEFINED),
        Err(error) => rejected(&error.message),
    }
}

fn track(world: &mut World, label: &str, reply: Option<IpcReply>) {
    let mut entry = Entry {
        label: label.to_owned(),
        done: false,
        value: JsonValue::Null,
        reported: false,
    };
    match reply {
        Some(IpcReply::Now(result)) => {
            entry.done = true;
            entry.value = printed(result);
        }
        Some(IpcReply::Later(ticket)) => {
            world.tickets.insert(ticket, label.to_owned());
        }
        None => {}
    }
    world.entries.push(entry);
}

/// what a case's step does; the record's `result` when it has one of its own
fn run_step(
    world: &mut World,
    step: &JsonValue,
    index: usize,
) -> (Option<JsonValue>, Option<String>) {
    let label = format!("p{index}");
    match as_str(prop(step, "op")).unwrap_or_default() {
        "ipc" => {
            let channel = as_str(prop(step, "channel")).unwrap_or_default().to_owned();
            let args: Vec<JsonValue> = items(prop(step, "args"))
                .iter()
                .map(|v| subst(world, v))
                .collect();
            let sender = sender_of(world, as_str(prop(step, "sender")).unwrap_or("shell"));
            match dispatch(&mut world.ipc, &mut world.host, &channel, sender, &args) {
                None => (
                    Some(object(vec![("noHandler", JsonValue::Bool(true))])),
                    None,
                ),
                Some(reply) => {
                    track(world, &label, Some(reply));
                    (None, Some(label))
                }
            }
        }
        "hub" => {
            match as_str(prop(step, "method")) {
                Some("stopAll") => match world.ipc.hub.stop_all() {
                    Reply::Now(()) => track(world, &label, Some(IpcReply::Now(Ok(None)))),
                    Reply::Later(ticket) => track(world, &label, Some(IpcReply::Later(ticket))),
                },
                Some("load") => {
                    world.ipc.hub.load();
                    track(world, &label, Some(IpcReply::Now(Ok(None))));
                }
                _ => track(world, &label, None),
            }
            (None, Some(label))
        }
        "destroy" => {
            let id = match prop(step, "id") {
                Some(JsonValue::Number(n)) => *n as i64,
                _ => 0,
            };
            let count = world.sh.borrow_mut().onces.remove(&id).unwrap_or(0);
            for _ in 0..count {
                world.ipc.sender_destroyed(id as f64);
            }
            (None, None)
        }
        op @ ("remote" | "local") => {
            let n = match prop(step, "conn") {
                Some(JsonValue::Number(n)) => *n as usize,
                _ => 0,
            };
            let key = format!("{op}#{n}");
            let st = world.sh.borrow().conns.get(&key).cloned();
            if let (Some(st), Some(set)) = (st, prop(step, "set")) {
                merge(&mut st.borrow_mut().cfg, set);
            }
            (None, None)
        }
        "defaults" => {
            let mut s = world.sh.borrow_mut();
            if let Some(patch) = prop(step, "remote") {
                merge(&mut s.remote_defaults, patch);
            }
            if let Some(patch) = prop(step, "local") {
                merge(&mut s.local_defaults, patch);
            }
            (None, None)
        }
        "release" => {
            let conn = as_str(prop(step, "conn")).unwrap_or_default().to_owned();
            let method = as_str(prop(step, "method")).unwrap_or_default().to_owned();
            let mut s = world.sh.borrow_mut();
            let at = s
                .held
                .iter()
                .position(|h| h.label == conn && h.method == method);
            match at {
                Some(at) => {
                    let held = s.held.remove(at);
                    let outcome = outcome_of(&mut s, &held.st, held.kind);
                    s.ready.push_back((held.op, outcome));
                    (None, None)
                }
                None => (Some(text("nothing held")), None),
            }
        }
        "localState" => {
            let n = match prop(step, "conn") {
                Some(JsonValue::Number(n)) => *n as usize,
                _ => 0,
            };
            let st = world.sh.borrow().conns.get(&format!("local#{n}")).cloned();
            if let (Some(st), Some(state)) = (st, prop(step, "state")) {
                let state = local_state_of(state);
                let conn = {
                    let mut s = st.borrow_mut();
                    s.state = state.clone();
                    s.conn
                };
                world
                    .sh
                    .borrow_mut()
                    .events
                    .push_back(Event::StateChanged(conn, state));
            }
            (None, None)
        }
        "toolsChanged" => {
            let key = as_str(prop(step, "conn")).unwrap_or_default().to_owned();
            let st = world.sh.borrow().conns.get(&key).cloned();
            if let Some(st) = st {
                let conn = st.borrow().conn;
                world
                    .sh
                    .borrow_mut()
                    .events
                    .push_back(Event::ToolsChanged(conn));
            }
            (None, None)
        }
        "plan" => {
            world.sh.borrow_mut().plan = prop(step, "plan").cloned().unwrap_or(JsonValue::Null);
            (None, None)
        }
        "planHook" => {
            world.sh.borrow_mut().plan_hook = Some((
                as_str(prop(step, "name")).unwrap_or_default().to_owned(),
                prop(step, "set").cloned().unwrap_or(JsonValue::Null),
            ));
            (None, None)
        }
        "storeEdit" => {
            let name = as_str(prop(step, "name")).unwrap_or_default().to_owned();
            let set = prop(step, "set").cloned().unwrap_or(JsonValue::Null);
            let _ = world.store.borrow_mut().update(&mut |file| {
                if let Some(target) = file.servers.iter_mut().find(|s| s.name == name) {
                    *target = assigned(target, &set);
                }
                None
            });
            (None, None)
        }
        "store" => (Some(sort_keys(&world.store.borrow().get().to_json())), None),
        "file" => {
            let path = format!("{}/mcp-servers.json", world.dir);
            (
                Some(match std::fs::read_to_string(&path) {
                    Ok(content) => text(content),
                    Err(_) => JsonValue::Null,
                }),
                None,
            )
        }
        "view" => {
            let view = if as_str(prop(step, "which")) == Some("editor") {
                JsonValue::Array(world.ipc.hub.editor_list())
            } else {
                world.ipc.hub.settings_view()
            };
            (Some(sort_keys(&view)), None)
        }
        "clock" => {
            if let Some(JsonValue::Number(n)) = prop(step, "advance") {
                world.clock.set(world.clock.get() + n);
            }
            (None, None)
        }
        "lang" => {
            world.sh.borrow_mut().lang = if as_str(prop(step, "lang")) == Some("ko") {
                Lang::Ko
            } else {
                Lang::En
            };
            (None, None)
        }
        other => (Some(object(vec![("unknownStep", text(other))])), None),
    }
}

/// ids and the folder as the record reads them
fn normalized(value: &JsonValue, names: &[(String, String)], dirs: &[String]) -> JsonValue {
    match value {
        JsonValue::String(s) => {
            let mut s = s.clone();
            for (id, name) in names {
                s = s.replace(id.as_str(), &format!("<id:{name}>"));
            }
            s = js_regex!(
                r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
                "g"
            )
            .replace_all(&s, |_| "<uuid>".to_owned());
            for dir in dirs {
                s = s.replace(dir.as_str(), "$DIR");
            }
            JsonValue::String(s)
        }
        JsonValue::Array(items) => {
            JsonValue::Array(items.iter().map(|v| normalized(v, names, dirs)).collect())
        }
        JsonValue::Object(o) => {
            let mut out = JsObject::new();
            for (k, v) in o.entries() {
                out.set(k, normalized(v, names, dirs));
            }
            JsonValue::Object(out)
        }
        other => other.clone(),
    }
}

fn scenario(args: &[Value]) -> Answer {
    let config = json_arg(args, 0);
    let steps = items(Some(&json_arg(args, 1)));
    let mut world = make_world(&config)?;
    let dirs = vec![world.dir.clone()];
    let mut records: Vec<JsonValue> = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let start_logs = world.sh.borrow().logs.len();
        let start_sent = world.sh.borrow().sent.len();
        let (result, label) = run_step(&mut world, step, index);
        pump(&mut world.ipc, &world.sh);
        for (ticket, value) in world.ipc.take_settled() {
            if let Some(label) = world.tickets.remove(&ticket)
                && let Some(entry) = world.entries.iter_mut().find(|e| e.label == label)
            {
                entry.done = true;
                entry.value = printed(value);
            }
        }
        let mut notice_views: Vec<JsonValue> = Vec::new();
        for notice in world.ipc.take_changed() {
            notice_views.push(sort_keys(&notice.view));
            let mut host = IpcHost {
                sh: world.sh.clone(),
            };
            world.ipc.on_changed(&mut host, &notice);
        }
        let mut record = JsObject::new();
        record.set("i", number(index as f64));
        record.set("op", text(as_str(prop(step, "op")).unwrap_or_default()));
        if as_str(prop(step, "op")) == Some("ipc") {
            record.set(
                "channel",
                text(as_str(prop(step, "channel")).unwrap_or_default()),
            );
        }
        if let Some(result) = result {
            record.set("result", result);
        }
        if let Some(label) = &label
            && let Some(entry) = world.entries.iter_mut().find(|e| &e.label == label)
        {
            if entry.done {
                let value = entry.value.clone();
                entry.reported = true;
                if as_str(prop(step, "op")) == Some("ipc")
                    && let Some(JsonValue::String(token)) = prop(&value, "token")
                {
                    world.tokens.push(token.clone());
                }
                record.set("result", value);
            } else {
                record.set("pending", text(label.as_str()));
            }
        }
        let mut settled = world
            .entries
            .iter_mut()
            .filter(|e| e.done && !e.reported && Some(&e.label) != label.as_ref())
            .collect::<Vec<_>>();
        settled.sort_by(|a, b| a.label.cmp(&b.label));
        if !settled.is_empty() {
            let mut map = JsObject::new();
            for entry in settled {
                entry.reported = true;
                map.set(entry.label.as_str(), entry.value.clone());
            }
            record.set("settled", JsonValue::Object(map));
        }
        let (calls, sent) = {
            let s = world.sh.borrow();
            (s.logs[start_logs..].to_vec(), s.sent[start_sent..].to_vec())
        };
        if !calls.is_empty() {
            record.set(
                "calls",
                JsonValue::Array(calls.iter().map(|c| text(c.as_str())).collect()),
            );
        }
        if !notice_views.is_empty() {
            record.set("notices", JsonValue::Array(notice_views));
        }
        if !sent.is_empty() {
            record.set(
                "sent",
                JsonValue::Array(
                    sent.iter()
                        .map(|(to, channel)| {
                            JsonValue::Array(vec![number(*to as f64), text(channel.as_str())])
                        })
                        .collect(),
                ),
            );
        }
        for server in world.store.borrow().get().servers {
            match world.names.iter_mut().find(|(id, _)| *id == server.id) {
                Some(entry) => entry.1 = server.name.clone(),
                None => world.names.push((server.id.clone(), server.name.clone())),
            }
        }
        records.push(normalized(&JsonValue::Object(record), &world.names, &dirs));
    }
    let _ = std::fs::remove_file(format!("{}/mcp-servers.json", world.dir));
    out(JsonValue::Array(records))
}

// ---- hub-app -----------------------------------------------------------------

type AppSent = Rc<RefCell<Vec<(f64, String, Vec<JsonValue>)>>>;

struct AppWin {
    id: f64,
    destroyed: bool,
    sent: AppSent,
}

impl McpWindow for AppWin {
    fn id(&self) -> f64 {
        self.id
    }

    fn is_destroyed(&self) -> bool {
        self.destroyed
    }

    fn send(&self, channel: &str, args: &[JsonValue]) {
        self.sent
            .borrow_mut()
            .push((self.id, channel.to_owned(), args.to_vec()));
    }
}

struct AppStorage;

impl SafeStorageLike for AppStorage {
    fn is_encryption_available(&self) -> bool {
        true
    }

    fn encrypt_string(&self, plain: &str) -> Result<Vec<u8>, CodecThrow> {
        Ok(format!("enc:{plain}").into_bytes())
    }

    fn decrypt_string(&self, sealed: &[u8]) -> Result<String, CodecThrow> {
        let text = String::from_utf8_lossy(sealed).into_owned();
        Ok(text.chars().skip(4).collect())
    }
}

struct FakeApp {
    lang: Lang,
    shell: AppWin,
    editor: AppWin,
    gone: AppWin,
    shell_open: Cell<bool>,
    logs: Rc<RefCell<Vec<String>>>,
    clock: Rc<Cell<f64>>,
}

impl McpAppHost for FakeApp {
    fn lang(&self) -> Lang {
        self.lang
    }

    fn shell_contents(&self) -> Option<&dyn McpWindow> {
        if self.shell_open.get() {
            Some(&self.shell)
        } else {
            None
        }
    }

    fn open_integrations(&self) {
        self.logs.borrow_mut().push("openIntegrations".to_owned());
    }

    fn shell_open_external(&self, url: &str) -> Result<(), String> {
        self.logs
            .borrow_mut()
            .push(format!("shell.openExternal {url}"));
        Ok(())
    }

    fn all_web_contents(&self) -> Vec<&dyn McpWindow> {
        vec![&self.shell, &self.editor, &self.gone]
    }

    fn watch_destroyed(&self, _sender_id: f64) -> bool {
        false
    }

    fn now_ms(&self) -> f64 {
        self.clock.get()
    }
}

/// the connections `startMcpHub` builds are real ones in the TypeScript and
/// are never reached by these cases; the fakes stand in
struct AppConnections {
    sh: SharedRef,
}

impl McpConnectionFactory<'static> for AppConnections {
    fn remote(
        &self,
        conn: ConnId,
        _server: &McpServerConfig,
        _store: &SharedStore<'static>,
    ) -> Box<dyn RemoteConnection<'static> + 'static> {
        new_remote(&self.sh, conn)
    }

    fn local(&self, conn: ConnId, _server: &McpServerConfig) -> Box<dyn LocalConnection + 'static> {
        new_local(&self.sh, conn)
    }

    fn resolve_command(&self, _command: &str, _options: &ResolveOptions) -> RuntimeResolution {
        resolve_missing()
    }

    fn planned_launch(&self, _server: &McpServerConfig) -> PlannedLaunch {
        planned(&self.sh)
    }
}

fn app_scenario(args: &[Value]) -> Answer {
    let config = json_arg(args, 0);
    let steps = items(Some(&json_arg(args, 1)));
    let dir = as_str(prop(&config, "dir"))
        .map(str::to_owned)
        .ok_or_else(|| CallError::plain("no dir"))?;
    let sent: AppSent = Rc::new(RefCell::new(Vec::new()));
    let logs = Rc::new(RefCell::new(Vec::new()));
    let clock = Rc::new(Cell::new(1_794_452_400_000.0));
    let win = |id: f64, destroyed: bool| AppWin {
        id,
        destroyed,
        sent: sent.clone(),
    };
    let app = Rc::new(FakeApp {
        lang: if as_str(prop(&config, "lang")) == Some("ko") {
            Lang::Ko
        } else {
            Lang::En
        },
        shell: win(1.0, false),
        editor: win(7.0, false),
        gone: win(9.0, true),
        shell_open: Cell::new(!matches!(
            prop(&config, "shellOpen"),
            Some(JsonValue::Bool(false))
        )),
        logs: logs.clone(),
        clock: clock.clone(),
    });
    let store: SharedStore<'static> = Rc::new(RefCell::new(create_mcp_servers_store(
        &mcp_servers_file_path(&dir),
        Rc::new(SafeStorageMcpCodec {
            storage: Rc::new(AppStorage),
            platform: process_platform().to_owned(),
        }),
    )));
    let sh: SharedRef = Rc::new(RefCell::new(Shared {
        logs: Vec::new(),
        held: Vec::new(),
        ready: VecDeque::new(),
        live: HashMap::new(),
        events: VecDeque::new(),
        conns: HashMap::new(),
        listings: HashMap::new(),
        remote_count: 0,
        local_count: 0,
        remote_defaults: remote_defaults(),
        local_defaults: local_defaults(),
        plan: JsonValue::Null,
        plan_hook: None,
        lang: app.lang,
        watchable: HashSet::new(),
        onces: HashMap::new(),
        sent: Vec::new(),
        store: Some(store.clone()),
        clock: clock.clone(),
    }));
    let host: Rc<dyn McpHubHost<'static>> = Rc::new(AppHubHost {
        app: app.clone(),
        connections: Box::new(AppConnections { sh: sh.clone() }),
    });
    let mut ipc = McpHubIpc::new(McpHub::new(host, store));
    // `void hub.load()`
    ipc.hub.load();
    let mut records: Vec<JsonValue> = Vec::new();
    let forms = vec![dir.clone()];
    for (index, step) in steps.iter().enumerate() {
        let start_logs = logs.borrow().len();
        let start_sent = sent.borrow().len();
        let mut record = JsObject::new();
        record.set("i", number(index as f64));
        let op = as_str(prop(step, "op")).unwrap_or_default().to_owned();
        record.set("op", text(op.as_str()));
        let mut host = AppIpcHost { app: &*app };
        match op.as_str() {
            "ipc" => {
                let channel = as_str(prop(step, "channel")).unwrap_or_default().to_owned();
                record.set("channel", text(channel.as_str()));
                let sender = match as_str(prop(step, "sender")) {
                    Some("shell") => 1.0,
                    Some("editor") => 7.0,
                    _ => 99.0,
                };
                let call_args = items(prop(step, "args"));
                match dispatch(&mut ipc, &mut host, &channel, sender, &call_args) {
                    None => {
                        record.set("result", object(vec![("noHandler", JsonValue::Bool(true))]))
                    }
                    Some(IpcReply::Now(result)) => record.set("result", printed(result)),
                    Some(IpcReply::Later(_)) => {}
                }
            }
            "openSettingsByName" => {
                let name = as_str(prop(step, "name")).unwrap_or_default().to_owned();
                record.set(
                    "result",
                    object(vec![(
                        "ok",
                        JsonValue::Bool(ipc.hub.open_settings_by_name(&name)),
                    )]),
                );
            }
            "shell" => app
                .shell_open
                .set(matches!(prop(step, "open"), Some(JsonValue::Bool(true)))),
            "file" => {
                let path = mcp_servers_file_path(&dir);
                record.set(
                    "result",
                    match std::fs::read_to_string(&path) {
                        Ok(content) => text(content),
                        Err(_) => JsonValue::Null,
                    },
                );
            }
            "view" => record.set("result", ipc.hub.settings_view()),
            _ => {}
        }
        pump(&mut ipc, &sh);
        let mut notices = 0usize;
        for notice in ipc.take_changed() {
            notices += 1;
            ipc.on_changed(&mut AppIpcHost { app: &*app }, &notice);
        }
        let calls: Vec<String> = logs.borrow()[start_logs..].to_vec();
        if !calls.is_empty() {
            record.set(
                "calls",
                JsonValue::Array(calls.iter().map(|c| text(c.as_str())).collect()),
            );
        }
        if notices > 0 {
            record.set("notices", number(notices as f64));
        }
        let fresh: Vec<(f64, String, Vec<JsonValue>)> = sent.borrow()[start_sent..].to_vec();
        let is_batch = |s: &(f64, String, Vec<JsonValue>)| {
            s.1 == "mcp-tools:changed" || s.1 == "mcp-servers:changed"
        };
        let batch: Vec<&(f64, String, Vec<JsonValue>)> =
            fresh.iter().filter(|s| is_batch(s)).collect();
        if !batch.is_empty() {
            record.set(
                "sent",
                JsonValue::Array(
                    batch
                        .iter()
                        .map(|s| JsonValue::Array(vec![number(s.0), text(s.1.as_str())]))
                        .collect(),
                ),
            );
        }
        let others: Vec<&(f64, String, Vec<JsonValue>)> =
            fresh.iter().filter(|s| !is_batch(s)).collect();
        if !others.is_empty() {
            record.set(
                "other",
                JsonValue::Array(
                    others
                        .iter()
                        .map(|s| {
                            JsonValue::Array(vec![
                                number(s.0),
                                text(s.1.as_str()),
                                JsonValue::Array(s.2.clone()),
                            ])
                        })
                        .collect(),
                ),
            );
        }
        records.push(normalized(&JsonValue::Object(record), &[], &forms));
    }
    let _ = std::fs::remove_file(mcp_servers_file_path(&dir));
    out(JsonValue::Array(records))
}

// ---- redirectSafeFetch -------------------------------------------------------

struct FakeNet {
    given: FetchResponse,
    logs: Vec<String>,
    cancelled: bool,
}

impl FetchHost for FakeNet {
    fn fetch(&mut self, url: &str, init: &FetchInit) -> Result<FetchResponse, FetchError> {
        let redirect = match init.redirect {
            Some(Redirect::Manual) => "manual",
            Some(Redirect::Follow) => "follow",
            Some(Redirect::Error) => "error",
            None => "undefined",
        };
        self.logs.push(format!("fetch {url} redirect={redirect}"));
        Ok(self.given.clone())
    }

    fn cancel_body(&mut self, _stream: u64) {
        self.cancelled = true;
    }
}

fn redirect_case(args: &[Value]) -> Answer {
    let spec = json_arg(args, 0);
    let kind = as_str(prop(&spec, "kind")).unwrap_or_default().to_owned();
    let url = as_str(prop(&spec, "url"))
        .unwrap_or("https://law.example.com/mcp")
        .to_owned();
    let mut headers = Headers::new();
    if let Some(JsonValue::Object(o)) = prop(&spec, "headers") {
        for (k, v) in o.entries() {
            if let JsonValue::String(v) = v {
                headers.append(k, v);
            }
        }
    }
    let given = if kind == "opaque" {
        FetchResponse {
            status: 0,
            status_text: String::new(),
            headers: Headers::new(),
            url: String::new(),
            redirected: false,
            opaque_redirect: true,
            body: Body::None,
        }
    } else {
        FetchResponse {
            status: match prop(&spec, "status") {
                Some(JsonValue::Number(n)) => *n as u16,
                _ => 200,
            },
            status_text: String::new(),
            headers,
            url: if kind == "followed" {
                url.clone()
            } else {
                String::new()
            },
            redirected: kind == "followed",
            opaque_redirect: false,
            body: Body::Stream(1),
        }
    };
    let init = match prop(&spec, "init") {
        Some(i @ JsonValue::Object(_)) => FetchInit {
            method: as_str(prop(i, "method")).map(str::to_owned),
            redirect: match as_str(prop(i, "redirect")) {
                Some("follow") => Some(Redirect::Follow),
                Some("error") => Some(Redirect::Error),
                Some("manual") => Some(Redirect::Manual),
                _ => None,
            },
            ..FetchInit::default()
        },
        _ => FetchInit::default(),
    };
    let mut net = FakeNet {
        given: given.clone(),
        logs: Vec::new(),
        cancelled: false,
    };
    let response = redirect_safe_fetch(&mut net, &url, &init)
        .map_err(|e| CallError::plain(e.to_js_string()))?;
    out(object(vec![
        ("same", JsonValue::Bool(response == given)),
        ("status", number(f64::from(response.status))),
        (
            "location",
            response
                .headers
                .get("location")
                .map_or(JsonValue::Null, text),
        ),
        ("redirected", JsonValue::Bool(response.redirected)),
        ("bodyCancelled", JsonValue::Bool(net.cancelled)),
        (
            "fetched",
            JsonValue::Array(net.logs.iter().map(|l| text(l.as_str())).collect()),
        ),
    ]))
}
