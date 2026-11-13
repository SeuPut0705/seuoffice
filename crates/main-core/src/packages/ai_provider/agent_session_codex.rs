//! `packages/ai-provider/src/agent-session/codex.ts`: agent mode on Codex.
//! A Codex app-server of the session's own runs one thread in the project
//! folder with Codex's tools on, inside Codex's sandbox, and asks the app
//! before it goes beyond it. What keeps it contained is in the TypeScript's
//! header: a permission profile of the session, an approval policy under
//! which an approved command stays in the sandbox, the brain-only
//! configuration overrides, every user MCP server switched off for the thread
//! (the app's own server and the session's relays added, and the attached
//! list checked afterwards), and the login checked before the thread opens.
//!
//! ## Running
//!
//! [`start_codex_agent_session`] is the TypeScript's `startCodexAgentSession`:
//! it spawns the app-server through `Rt::spawn`, runs the handshake, and
//! answers a [`CodexAgentSession`], the handle of the running session. The
//! session's events go to the `on_event` callback the caller passes; a
//! permission request waits for [`AgentSession::answer`], which the caller
//! calls when the person answered (nothing awaits the renderer here). The
//! child's output reaches the session through `Child::on` listeners that run
//! inside `Runtime::feed`, as JavaScript runs the stream's listeners; a
//! request's promise is a `Rt::deferred` settled by the response line.
//!
//! Not options here, because the runtime replaces them: the TypeScript's
//! `deps.spawn` (`Rt::spawn`) and `deps.registry` (the shared registry of
//! `subscription_process`). `statSync` of the readable-folder check is
//! answered from `Rt::fs` stats made before the (pure) loop runs; see
//! [`codex_agent_readable_dirs`].

use std::cell::{Cell, RefCell};
use std::collections::HashSet;
use std::rc::Rc;

use jscompat::node_path::{host, posix, win32};
use jscompat::{
    JsMap, JsonValue, js_regex, json_parse, json_stringify, number_to_string, slice_utf16,
    text_decoder_decode, trim,
};

use super::agent_session_claude::{
    APP_MCP_SERVER_NAME, agent_usable_relays, is_agent_app_mcp_tool,
};
use super::agent_session_codex_sandbox_probe::{
    CodexSandboxProbeDeps, CodexSandboxProbeResult, default_kill_tree, probe_codex_sandbox,
};
use super::agent_session_policy::{
    AgentPolicyContext, agent_policy_verdict, comparable_path, is_inside_path, process_platform,
};
use super::agent_session_program_problem::AgentProgramProblem;
use super::agent_session_types::{
    AgentAction, AgentActionKind, AgentMcpRelay, AgentPermissionAnswer, AgentPermissionMode,
    AgentPermissionRequest, AgentPolicyVerdict, AgentSession, AgentSessionEvent,
    AgentSessionOptions, StringTable, new_agent_action,
};
use super::codex_app_server::{
    CODEX_CONFIG_OVERRIDES, active_permission_profile_id, attach_bounded_rpc_stdout,
    codex_attached_mcp_servers, codex_listed_effort, codex_mcp_server_overrides, codex_run_error,
};
use super::jsval::{
    Obj, as_integer, as_record, as_str, coalesce, length16, number, object, text, without,
};
use super::run_error::ai_run_error;
use super::subscription_locate::{
    LocateState, SubscriptionLocateOptions, SubscriptionProgram, resolve_subscription_program,
};
use super::subscription_process::{SubscriptionSpawnOptions, spawn_subscription_program};
use super::subscription_status::{SubscriptionLogin, codex_account_info};
use super::task::{
    Child, ChildEvent, FileKind, FsAnswer, FsOp, Id, JsError, LocalBoxFuture, Rt, Settle, Stdio,
};

const PROVIDER: &str = "codex";

/// `CODEX_AGENT_PROFILE`
pub const CODEX_AGENT_PROFILE: &str = "seuoffice-agent";
const REQUEST_TIMEOUT_MS: f64 = 30_000.0;
/// Opening the thread applies the permission profile, and Codex's Windows
/// sandbox sets file permissions on every folder the profile names; a folder
/// of many thousand files takes minutes the first time.
pub const THREAD_START_TIMEOUT_MS: f64 = 5.0 * 60_000.0;
const DIAGNOSTIC_LIMIT: usize = 4_000;
const DEFAULT_IDLE_MS: f64 = 30.0 * 60_000.0;
const MAX_MCP_STATUS_PAGES: usize = 10;

/// `AgentSandboxUnavailableError`: Codex's sandbox could not start on this PC
/// (a Windows without MXC, a policy against it)
pub fn agent_sandbox_unavailable_error() -> JsError {
    JsError::new(
        "AgentSandboxUnavailableError",
        "Codex sandbox (MXC) is not available on this PC; nothing was run",
    )
    .with("kind", text("sandbox-unavailable"))
}

/// `new AgentProgramError(problem, message)`
fn program_error(problem: AgentProgramProblem, message: impl Into<String>) -> JsError {
    JsError::new("AgentProgramError", message).with("problem", problem.to_json())
}

/// `error instanceof AiRunError ? error.kind : undefined`
fn run_error_kind(error: &JsError) -> Option<String> {
    if error.is("AiRunError") {
        as_str(error.prop("kind")).map(str::to_owned)
    } else {
        None
    }
}

/// `text(value)`: a string that is not empty
fn text_of(value: Option<&JsonValue>) -> Option<String> {
    match value {
        Some(JsonValue::String(value)) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

/// `isPlainObject(value) ? value : undefined`
fn record_of(value: Option<&JsonValue>) -> Option<&Obj> {
    value.and_then(as_record)
}

/// `new Error(String(error))` for what is no `Error`
fn as_error(error: JsError) -> JsError {
    if error.is_error() {
        error
    } else {
        JsError::error(error.to_js_string())
    }
}

/// The brain-only overrides. Skill instructions stay off; web search is the
/// person's choice for the project folder (the Codex app's default is cached
/// results), given after the inherited overrides.
pub fn codex_agent_launch_args(web_search: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = vec!["app-server".to_owned()];
    for override_ in CODEX_CONFIG_OVERRIDES
        .iter()
        .filter(|override_| !override_.starts_with("web_search="))
    {
        args.push("-c".to_owned());
        args.push((*override_).to_owned());
    }
    args.push("-c".to_owned());
    args.push(format!(
        "web_search=\"{}\"",
        codex_web_search_value(web_search)
    ));
    // Windows: the MXC sandbox, explicitly. Other systems ignore it.
    args.push("-c".to_owned());
    args.push("windows.sandbox=\"mxc\"".to_owned());
    args.push("--listen".to_owned());
    args.push("stdio://".to_owned());
    args
}

/// A known web search value; anything else is the default
fn codex_web_search_value(value: Option<&str>) -> &'static str {
    match value {
        Some("live") => "live",
        Some("disabled") => "disabled",
        _ => "cached",
    }
}

/// `codexAgentApprovalPolicy(mode)`: `untrusted` brings every command but
/// known-safe reads to the app; `never` does not ask, and what the sandbox
/// does not allow simply fails. `on-request` is never used.
pub fn codex_agent_approval_policy(mode: AgentPermissionMode) -> &'static str {
    match mode {
        AgentPermissionMode::AskCommands | AgentPermissionMode::AskWrites => "untrusted",
        AgentPermissionMode::TrustProject => "never",
    }
}

/// `codexAgentFilesystem(options, readableDirs)`: the session's file-system
/// rules (`Record<string, 'read' | 'write' | 'deny'>`): the platform's minimal
/// set and the folders a command needs, the open documents read-only, and the
/// protected folders denied.
pub fn codex_agent_filesystem(
    options: &AgentSessionOptions,
    readable_dirs: &[String],
) -> StringTable {
    let mut filesystem = StringTable::new();
    filesystem.set(":minimal", "read".to_owned());
    for dir in readable_dirs {
        filesystem.set(dir.as_str(), "read".to_owned());
    }
    if let Some(dir) = options
        .skill_bundle_dir
        .as_deref()
        .filter(|dir| !dir.is_empty())
    {
        filesystem.set(dir, "read".to_owned());
    }
    filesystem.set(options.project_root.as_str(), "write".to_owned());
    for path in &options.open_documents {
        filesystem.set(path.as_str(), "read".to_owned());
    }
    for path in &options.protected_paths {
        filesystem.set(path.as_str(), "deny".to_owned());
    }
    filesystem
}

/// `CODEX_PROFILE_GLOB.test(path)`: characters Codex reads as a glob in a
/// permission profile path
fn has_profile_glob(path: &str) -> bool {
    js_regex!(r"[*?\[\]]").test(path)
}

/// `codexProfilePathsLiteral(filesystem)`
pub fn codex_profile_paths_literal(filesystem: &StringTable) -> bool {
    filesystem
        .entries()
        .into_iter()
        .all(|(path, _)| path == ":minimal" || !has_profile_glob(path))
}

/// The directories of a PATH value, each as the loop reads it: trimmed, a
/// quote at either end taken off.
fn path_candidates(path_value: Option<&str>, platform: &str) -> Vec<String> {
    path_value
        .unwrap_or("")
        .split(if platform == "win32" { ';' } else { ':' })
        .map(|raw| js_regex!("^\"|\"$", "g").replace_all(trim(raw), |_| String::new()))
        .collect()
}

fn is_absolute_on(platform: &str, path: &str) -> bool {
    if platform == "win32" {
        win32::is_absolute(path)
    } else {
        posix::is_absolute(path)
    }
}

/// `codexAgentReadableDirs(pathValue, options, platform, exists)`: the
/// folders on PATH a command may read, so scripts can find their runtime:
/// absolute, existing folders that are not a drive root and not inside a
/// protected folder or the project. `exists` is the TypeScript's
/// `statSync(dir).isDirectory()`.
pub fn codex_agent_readable_dirs(
    path_value: Option<&str>,
    options: &AgentSessionOptions,
    platform: Option<&str>,
    exists: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    let platform = platform.unwrap_or(process_platform());
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for dir in path_candidates(path_value, platform) {
        if dir.is_empty() || !is_absolute_on(platform, &dir) || has_profile_glob(&dir) {
            continue;
        }
        let key = comparable_path(&dir, &dir, Some(platform));
        let root = if platform == "win32" {
            win32::parse(&key).root
        } else {
            posix::parse(&key).root
        };
        if seen.contains(&key) || root == key {
            continue;
        }
        if options.protected_paths.iter().any(|guard| {
            is_inside_path(
                &key,
                &comparable_path(guard, guard, Some(platform)),
                Some(platform),
            )
        }) {
            continue;
        }
        if is_inside_path(
            &key,
            &comparable_path(&options.project_root, &options.project_root, Some(platform)),
            Some(platform),
        ) {
            continue;
        }
        if !exists(&dir) {
            continue;
        }
        seen.insert(key);
        out.push(dir);
    }
    out
}

/// `{ filesystem }` or `{ filesystem, network: { enabled: true } }`
fn codex_agent_profile(
    network: Option<bool>,
    options: &AgentSessionOptions,
    readable_dirs: &[String],
) -> JsonValue {
    let filesystem = codex_agent_filesystem(options, readable_dirs);
    let mut table = Obj::new();
    for (path, access) in filesystem.entries() {
        table.set(path, text(access));
    }
    let filesystem = JsonValue::Object(table);
    if network == Some(true) {
        object(vec![
            ("filesystem", filesystem),
            ("network", object(vec![("enabled", JsonValue::Bool(true))])),
        ])
    } else {
        object(vec![("filesystem", filesystem)])
    }
}

/// `codexAgentThreadParams(options, model, userMcpServers, readableDirs)`;
/// `network` is the `network` field of the TypeScript's options.
pub fn codex_agent_thread_params(
    options: &AgentSessionOptions,
    network: Option<bool>,
    model: &str,
    user_mcp_servers: &Obj,
    readable_dirs: &[String],
) -> JsonValue {
    let mut mcp_servers: Obj = user_mcp_servers.clone();
    // a relay replaces the person's Codex server of the same name: the relay is what the session
    // gets, and the app asks before a call when the tool's permission says so (user MCP spec 9)
    for relay in agent_usable_relays(options.user_mcp_relays.as_deref()) {
        mcp_servers.set(
            relay.name.as_str(),
            object(vec![
                ("url", text(&relay.url)),
                (
                    "http_headers",
                    object(vec![(
                        "Authorization",
                        text(format!("Bearer {}", relay.token)),
                    )]),
                ),
                ("default_tools_approval_mode", text("approve")),
            ]),
        );
    }
    if let Some(app_mcp) = &options.app_mcp {
        mcp_servers.set(
            APP_MCP_SERVER_NAME,
            object(vec![
                ("url", text(&app_mcp.url)),
                (
                    "http_headers",
                    object(vec![(
                        "Authorization",
                        text(format!("Bearer {}", app_mcp.token)),
                    )]),
                ),
                // the app's own tools, which keep their own limits: without this, Codex asks
                // before each call, and under the `never` policy refuses them unasked
                ("default_tools_approval_mode", text("approve")),
            ]),
        );
    }
    let mut permissions = Obj::new();
    permissions.set(
        CODEX_AGENT_PROFILE,
        codex_agent_profile(network, options, readable_dirs),
    );
    object(vec![
        ("model", text(model)),
        ("cwd", text(&options.project_root)),
        (
            "approvalPolicy",
            text(codex_agent_approval_policy(options.mode)),
        ),
        ("serviceName", text(CODEX_AGENT_PROFILE)),
        ("developerInstructions", text(&options.instructions)),
        ("ephemeral", JsonValue::Bool(true)),
        (
            "config",
            object(vec![
                ("default_permissions", text(CODEX_AGENT_PROFILE)),
                ("permissions", JsonValue::Object(permissions)),
                ("mcp_servers", JsonValue::Object(mcp_servers)),
            ]),
        ),
    ])
}

/// `commandSummary(source)`: Codex's own reading of a command
/// (`commandActions`): the command without the shell it is wrapped in and
/// without doubled backslashes. Best effort, so only shown, never judged.
fn command_summary(source: &Obj) -> Option<String> {
    let actions: &[JsonValue] = match source.get("commandActions") {
        Some(JsonValue::Array(items)) => items,
        _ => &[],
    };
    let commands: Vec<String> = actions
        .iter()
        .filter_map(|action| record_of(Some(action)).and_then(|a| text_of(a.get("command"))))
        .collect();
    if commands.is_empty() {
        None
    } else {
        Some(commands.join("; "))
    }
}

/// `codexAgentAction(method, params, fileChangePaths)`: what a Codex approval
/// request asks for, in the policy's terms
pub fn codex_agent_action(
    method: &str,
    params: &Obj,
    file_change_paths: &JsMap<Vec<String>>,
) -> AgentAction {
    if method == "item/commandExecution/requestApproval" {
        let mut action = new_agent_action(AgentActionKind::Command, "commandExecution", Vec::new());
        action.command = Some(text_of(params.get("command")).unwrap_or_default());
        action.summary = command_summary(params);
        action.cwd = text_of(params.get("cwd"));
        action.reason = text_of(params.get("reason"));
        return action;
    }
    if method == "item/fileChange/requestApproval" {
        let item_id = text_of(params.get("itemId")).unwrap_or_default();
        let grant_root = text_of(params.get("grantRoot"));
        let mut paths: Vec<String> = file_change_paths.get(&item_id).cloned().unwrap_or_default();
        if let Some(root) = grant_root {
            paths.push(root);
        }
        let mut action = new_agent_action(AgentActionKind::Write, "fileChange", paths);
        action.reason = text_of(params.get("reason"));
        return action;
    }
    let mut action = new_agent_action(AgentActionKind::Other, method, Vec::new());
    action.reason = text_of(params.get("reason"));
    action
}

/// `codexDeclineDecision(params)`: the refusal an approval request accepts:
/// `decline` lets the turn go on, but a request may offer only `cancel`,
/// which ends the turn.
pub fn codex_decline_decision(params: &Obj) -> &'static str {
    match params.get("availableDecisions") {
        Some(JsonValue::Array(offered)) => {
            if offered
                .iter()
                .any(|decision| as_str(Some(decision)) == Some("decline"))
            {
                "decline"
            } else {
                "cancel"
            }
        }
        _ => "decline",
    }
}

/// `codexAppMcpExtraTools(statusList, relays)`: the tools Codex lists in one
/// page of `mcpServerStatus/list` that the session was not meant to get: of
/// the app's own server, and of each relay beyond the tools it listed at the
/// start. Other servers are the attachment check's; a tool listed under a
/// qualified name counts by its bare name.
pub fn codex_app_mcp_extra_tools(status_list: &JsonValue, relays: &[AgentMcpRelay]) -> Vec<String> {
    let data = match record_of(Some(status_list)).and_then(|list| list.get("data")) {
        Some(JsonValue::Array(data)) => data,
        _ => return Vec::new(),
    };
    let mut relay_by_name: JsMap<AgentMcpRelay> = JsMap::new();
    for relay in agent_usable_relays(Some(relays)) {
        relay_by_name.set(relay.name.clone(), relay);
    }
    let mut extra: Vec<String> = Vec::new();
    for entry in data {
        let Some(entry) = record_of(Some(entry)) else {
            continue;
        };
        let tools: Vec<String> = record_of(entry.get("tools"))
            .map(|tools| {
                tools
                    .entries()
                    .into_iter()
                    .map(|(k, _)| k.to_owned())
                    .collect()
            })
            .unwrap_or_default();
        let name = as_str(entry.get("name"));
        if name == Some(APP_MCP_SERVER_NAME) {
            for tool in tools {
                if !is_agent_app_mcp_tool(&tool) {
                    extra.push(tool);
                }
            }
            continue;
        }
        let Some(relay) = name.and_then(|name| relay_by_name.get(name)) else {
            continue;
        };
        let prefix = format!("mcp__{}__", relay.name);
        for tool in tools {
            let bare = match tool.strip_prefix(prefix.as_str()) {
                Some(bare) => bare,
                None => tool.as_str(),
            };
            if !relay.tools.iter().any(|known| known == bare) {
                extra.push(tool);
            }
        }
    }
    extra
}

/// `codexElicitationAnswer(params, relays)`: the answer to an MCP
/// elicitation. Codex asks this way before each MCP tool call; only the
/// app's own server and the session's relays are attached, and their tools
/// are the app's to allow. Anything else is declined. The object is
/// `{ action, content, _meta }`.
pub fn codex_elicitation_answer(params: &Obj, relays: &[AgentMcpRelay]) -> JsonValue {
    let meta = record_of(params.get("_meta"));
    let server_name = params.get("serverName");
    let app_server = as_str(server_name) == Some(APP_MCP_SERVER_NAME)
        || agent_usable_relays(Some(relays))
            .iter()
            .any(|relay| as_str(server_name) == Some(relay.name.as_str()));
    let tool_approval = app_server
        && as_str(params.get("mode")) == Some("form")
        && meta.and_then(|meta| as_str(meta.get("codex_approval_kind"))) == Some("mcp_tool_call");
    if tool_approval {
        object(vec![
            ("action", text("accept")),
            ("content", JsonValue::Object(Obj::new())),
            ("_meta", JsonValue::Null),
        ])
    } else {
        object(vec![
            ("action", text("decline")),
            ("content", JsonValue::Null),
            ("_meta", JsonValue::Null),
        ])
    }
}

/// `itemAction(item)`
fn item_action(item: &Obj) -> Option<AgentAction> {
    match as_str(item.get("type")) {
        Some("commandExecution") => {
            let mut action =
                new_agent_action(AgentActionKind::Command, "commandExecution", Vec::new());
            action.command = Some(text_of(item.get("command")).unwrap_or_default());
            action.summary = command_summary(item);
            action.cwd = text_of(item.get("cwd"));
            Some(action)
        }
        Some("fileChange") => {
            let changes: &[JsonValue] = match item.get("changes") {
                Some(JsonValue::Array(changes)) => changes,
                _ => &[],
            };
            let paths: Vec<String> = changes
                .iter()
                .filter_map(|change| {
                    record_of(Some(change)).and_then(|change| text_of(change.get("path")))
                })
                .collect();
            Some(new_agent_action(
                AgentActionKind::Write,
                "fileChange",
                paths,
            ))
        }
        Some("webSearch") => {
            let mut action = new_agent_action(AgentActionKind::WebSearch, "webSearch", Vec::new());
            action.target = text_of(item.get("query"));
            Some(action)
        }
        Some("mcpToolCall") => Some(new_agent_action(
            AgentActionKind::AppTool,
            &format!(
                "{}:{}",
                text_of(item.get("server")).unwrap_or_default(),
                text_of(item.get("tool")).unwrap_or_default()
            ),
            Vec::new(),
        )),
        _ => None,
    }
}

/// `itemStatus(item)`
fn item_status(item: &Obj) -> &'static str {
    match text_of(item.get("status")).as_deref() {
        Some("declined") => "denied",
        Some("failed") => "failed",
        _ => "done",
    }
}

/// What `deps.resolveProgram` is: a function from the configured path to the
/// program; the caller may make it with `Rt::call`.
pub type ResolveProgram =
    Rc<dyn Fn(Option<String>) -> LocalBoxFuture<Result<SubscriptionProgram, JsError>>>;

/// What `deps.probeSandbox` is: the filesystem, the probe folder and whether
/// the network is open.
pub type ProbeSandbox = Rc<
    dyn Fn(StringTable, String, bool) -> LocalBoxFuture<Result<CodexSandboxProbeResult, JsError>>,
>;

/// `CodexAgentDeps`; `deps.spawn` and `deps.registry` are not here (see the
/// module doc).
#[derive(Clone, Default)]
pub struct CodexAgentDeps {
    pub resolve_program: Option<ResolveProgram>,
    /// `NodeJS.ProcessEnv` the child's environment and PATH are read from; the app's own when absent
    pub base_env: Option<Vec<(String, String)>>,
    /// ends the child's process tree, given its pid; `killProcessTree(target, { force: true })` when absent
    pub kill_tree: Option<Rc<dyn Fn(Option<f64>)>>,
    pub idle_ms: Option<f64>,
    pub platform: Option<String>,
    pub thread_start_timeout_ms: Option<f64>,
    /// the check that Codex's sandbox starts and denies (Windows)
    pub probe_sandbox: Option<ProbeSandbox>,
}

/// `CodexAgentSessionOptions`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodexAgentSessionOptions {
    pub session: AgentSessionOptions,
    /// the person accepted a metered login for Codex
    pub metered_accepted: bool,
    /// Codex's own web search, as chosen for the project folder; cached results when absent
    pub web_search: Option<String>,
    /// commands may reach the internet (chosen for the project folder); off when absent
    pub network: Option<bool>,
}

struct RpcPending {
    method: String,
    settle: Settle<Result<JsonValue, JsError>>,
    timer: Id,
}

/// an approval request waiting for the person
struct ApprovalWait {
    rpc_id: JsonValue,
    decline_as: String,
}

struct St {
    open_documents: Vec<String>,
    ended: bool,
    stopping: bool,
    thread_id: String,
    turn_id: String,
    /// the configured level when the model takes it; every turn names it
    effort: Option<String>,
    busy: bool,
    stderr: String,
    next_id: f64,
    idle_timer: Option<Id>,
    reported_error: Option<JsonValue>,
    rpc_pending: Vec<(f64, RpcPending)>,
    /// approval requests waiting for the person, by the id shown to them
    pending: JsMap<ApprovalWait>,
    file_change_paths: JsMap<Vec<String>>,
}

/// The state of one running session: what the TypeScript's closures share.
struct Core {
    rt: Rt,
    platform: String,
    options: CodexAgentSessionOptions,
    network: bool,
    relays: Vec<AgentMcpRelay>,
    /// the MCP servers the thread may start: the app's own and the session's relays
    given_servers: Vec<String>,
    child: Child,
    on_event: Rc<dyn Fn(&AgentSessionEvent)>,
    kill_tree: Rc<dyn Fn(Option<f64>)>,
    idle_ms: f64,
    st: RefCell<St>,
}

impl Core {
    /// `emit(event)`
    fn emit(&self, event: AgentSessionEvent) {
        if !self.st.borrow().ended {
            (self.on_event)(&event);
        }
    }

    /// `writeLine(message)`
    fn write_line(&self, message: &JsonValue) {
        if !self.st.borrow().ended && self.child.stdin_writable() {
            self.child
                .write(format!("{}\n", json_stringify(message)).as_bytes());
        }
    }

    /// `end(error)`
    fn end(&self, error: Option<JsError>) {
        if self.st.borrow().ended {
            return;
        }
        if let Some(error) = &error {
            (self.on_event)(&AgentSessionEvent::Error {
                kind: run_error_kind(error),
                message: error.message.clone(),
            });
        }
        let (idle_timer, waiting) = {
            let mut st = self.st.borrow_mut();
            st.ended = true;
            (st.idle_timer, std::mem::take(&mut st.rpc_pending))
        };
        self.rt.clear_timeout(idle_timer);
        for (_, request) in waiting {
            self.rt.clear_timeout(Some(request.timer));
            request.settle.settle(Err(error
                .clone()
                .unwrap_or_else(|| JsError::error("The agent session has ended"))));
        }
        self.st.borrow_mut().pending = JsMap::new();
        (self.on_event)(&AgentSessionEvent::Ended);
    }

    /// `stopNow(error)`
    fn stop_now(&self, error: Option<JsError>) {
        self.st.borrow_mut().stopping = true;
        (self.kill_tree)(self.child.pid());
        self.end(error);
    }

    /// `armIdle()`
    fn arm_idle(self: &Rc<Self>) {
        let previous = self.st.borrow().idle_timer;
        self.rt.clear_timeout(previous);
        let core = self.clone();
        let timer = self
            .rt
            .set_timeout(self.idle_ms, move || core.stop_now(None));
        self.st.borrow_mut().idle_timer = Some(timer);
    }

    /// `request(method, params, timeoutMs)`
    async fn request(
        self: &Rc<Self>,
        method: &str,
        params: JsonValue,
        timeout_ms: f64,
    ) -> Result<JsonValue, JsError> {
        if self.st.borrow().ended {
            return Err(JsError::error("The agent session has ended"));
        }
        let (settle, wait) = self.rt.deferred::<Result<JsonValue, JsError>>();
        let id = {
            let mut st = self.st.borrow_mut();
            let id = st.next_id;
            st.next_id += 1.0;
            id
        };
        let core = self.clone();
        let step = method.to_owned();
        let timer = self.rt.set_timeout(timeout_ms, move || {
            let request = {
                let mut st = core.st.borrow_mut();
                let at = st.rpc_pending.iter().position(|(key, _)| *key == id);
                at.map(|at| st.rpc_pending.remove(at).1)
            };
            if let Some(request) = request {
                request.settle.settle(Err(program_error(
                    AgentProgramProblem::NoAnswer { step: step.clone() },
                    format!("Codex app-server request timed out: {step}"),
                )));
            }
        });
        self.st.borrow_mut().rpc_pending.push((
            id,
            RpcPending {
                method: method.to_owned(),
                settle,
                timer,
            },
        ));
        self.write_line(&object(vec![
            ("method", text(method)),
            ("id", number(id)),
            ("params", params),
        ]));
        wait.await
    }

    /// `answerApproval(rpcId, accept, declineAs)`
    fn answer_approval(&self, rpc_id: &JsonValue, accept: bool, decline_as: &str) {
        self.write_line(&object(vec![
            ("id", rpc_id.clone()),
            (
                "result",
                object(vec![(
                    "decision",
                    text(if accept { "accept" } else { decline_as }),
                )]),
            ),
        ]));
    }

    /// `onServerRequest(message)`
    fn on_server_request(&self, message: &Obj) {
        let rpc_id = message.get("id").cloned().unwrap_or(JsonValue::Null);
        let method = as_str(message.get("method")).unwrap_or("").to_owned();
        let empty = Obj::new();
        let params = record_of(message.get("params")).unwrap_or(&empty);
        if method == "item/commandExecution/requestApproval"
            || method == "item/fileChange/requestApproval"
        {
            let (action, open_documents) = {
                let st = self.st.borrow();
                (
                    codex_agent_action(&method, params, &st.file_change_paths),
                    st.open_documents.clone(),
                )
            };
            let decline_as = codex_decline_decision(params);
            let options = &self.options.session;
            let verdict = agent_policy_verdict(
                &action,
                &AgentPolicyContext {
                    mode: options.mode,
                    project_root: &options.project_root,
                    open_documents: &open_documents,
                    protected_paths: &options.protected_paths,
                    skill_bundle_dir: options.skill_bundle_dir.as_deref(),
                    allowances: None,
                    platform: Some(self.platform.as_str()),
                },
            );
            match verdict {
                AgentPolicyVerdict::Allow => self.answer_approval(&rpc_id, true, decline_as),
                // Codex reports the declined item itself, which the panel shows as denied
                AgentPolicyVerdict::Deny(_) => self.answer_approval(&rpc_id, false, decline_as),
                AgentPolicyVerdict::Ask => {
                    let id = self.rt.random_uuid();
                    self.st.borrow_mut().pending.set(
                        id.clone(),
                        ApprovalWait {
                            rpc_id,
                            decline_as: decline_as.to_owned(),
                        },
                    );
                    self.emit(AgentSessionEvent::Permission {
                        request: AgentPermissionRequest {
                            action,
                            id,
                            provider: PROVIDER.to_owned(),
                        },
                    });
                }
            }
            return;
        }
        if method == "mcpServer/elicitation/request" {
            self.write_line(&object(vec![
                ("id", rpc_id),
                ("result", codex_elicitation_answer(params, &self.relays)),
            ]));
            return;
        }
        // anything else (more permissions, questions, attestation, sign-in tokens) is not the
        // app's to grant: refuse it instead of leaving Codex waiting
        self.write_line(&object(vec![
            ("id", rpc_id),
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

    /// `onNotification(method, params)`
    fn on_notification(self: &Rc<Self>, method: &str, params: &Obj) {
        match method {
            "mcpServer/startupStatus/updated" => {
                let name = text_of(params.get("name"));
                let status = text_of(params.get("status"));
                if (status.as_deref() == Some("starting") || status.as_deref() == Some("ready"))
                    && !self
                        .given_servers
                        .iter()
                        .any(|given| given == name.as_deref().unwrap_or(""))
                {
                    self.stop_now(Some(ai_run_error(
                        "unsafe-tools",
                        "Codex started an MCP server that was switched off",
                        None,
                        None,
                    )));
                }
            }
            "item/started" => {
                let Some(item) = record_of(params.get("item")) else {
                    return;
                };
                let action = item_action(item);
                if as_str(item.get("type")) == Some("fileChange")
                    && let (Some(JsonValue::String(id)), Some(action)) = (item.get("id"), &action)
                {
                    self.st
                        .borrow_mut()
                        .file_change_paths
                        .set(id.clone(), action.paths.clone());
                }
                if let Some(action) = action {
                    self.emit(AgentSessionEvent::Tool {
                        action,
                        status: "running",
                    });
                }
            }
            "item/completed" => {
                let Some(item) = record_of(params.get("item")) else {
                    return;
                };
                if as_str(item.get("type")) == Some("agentMessage")
                    && let Some(message) = as_str(item.get("text"))
                    && !trim(message).is_empty()
                {
                    self.emit(AgentSessionEvent::Text {
                        text: message.to_owned(),
                    });
                    return;
                }
                if let Some(action) = item_action(item) {
                    self.emit(AgentSessionEvent::Tool {
                        action,
                        status: item_status(item),
                    });
                }
                if let Some(JsonValue::String(id)) = item.get("id") {
                    self.st.borrow_mut().file_change_paths.delete(id);
                }
            }
            "turn/started" => {
                let turn = record_of(params.get("turn"));
                if let Some(JsonValue::String(id)) = turn.and_then(|turn| turn.get("id")) {
                    self.st.borrow_mut().turn_id = id.clone();
                }
            }
            "turn/completed" => {
                {
                    let mut st = self.st.borrow_mut();
                    st.busy = false;
                    st.turn_id = String::new();
                }
                self.arm_idle();
                let turn = record_of(params.get("turn"));
                let status = turn.and_then(|turn| as_str(turn.get("status")));
                if status == Some("failed") {
                    let reported = self.st.borrow().reported_error.clone();
                    let turn_error = turn.and_then(|turn| turn.get("error"));
                    let error = codex_run_error(coalesce(turn_error, reported.as_ref()), None);
                    self.st.borrow_mut().reported_error = None;
                    self.emit(AgentSessionEvent::TurnDone { ok: false });
                    self.emit(AgentSessionEvent::Error {
                        kind: run_error_kind(&error),
                        message: error.message.clone(),
                    });
                    return;
                }
                self.st.borrow_mut().reported_error = None;
                self.emit(AgentSessionEvent::TurnDone {
                    ok: status != Some("interrupted"),
                });
            }
            "error" => {
                // a retried stream is still live; a warning arrives the same way, so only the
                // turn's own outcome decides
                if params.get("willRetry") != Some(&JsonValue::Bool(true)) {
                    self.st.borrow_mut().reported_error =
                        Some(match record_of(params.get("error")) {
                            Some(error) => JsonValue::Object(error.clone()),
                            None => JsonValue::Object(params.clone()),
                        });
                }
            }
            _ => {}
        }
    }

    /// `onLine(line)`
    fn on_line(self: &Rc<Self>, line: &str) {
        let Ok(JsonValue::Object(message)) = json_parse(line) else {
            return;
        };
        let method = as_str(message.get("method"));
        if method.is_some() && message.get("id").is_some() {
            self.on_server_request(&message);
            return;
        }
        if let Some(JsonValue::Number(id)) = message.get("id") {
            let waiting = {
                let mut st = self.st.borrow_mut();
                let at = st.rpc_pending.iter().position(|(key, _)| key == id);
                at.map(|at| st.rpc_pending.remove(at).1)
            };
            let Some(waiting) = waiting else {
                return;
            };
            self.rt.clear_timeout(Some(waiting.timer));
            if let Some(error) = message.get("error") {
                let empty = Obj::new();
                let error = record_of(Some(error)).unwrap_or(&empty);
                let detail = as_str(error.get("message")).unwrap_or("error");
                waiting.settle.settle(Err(program_error(
                    AgentProgramProblem::Refused {
                        step: waiting.method.clone(),
                        code: as_integer(error.get("code")),
                    },
                    format!("Codex app-server: {detail}"),
                )));
            } else {
                waiting.settle.settle(Ok(message
                    .get("result")
                    .cloned()
                    .unwrap_or(JsonValue::Null)));
            }
            return;
        }
        if let Some(method) = method {
            let empty = Obj::new();
            let params = record_of(message.get("params")).unwrap_or(&empty);
            self.on_notification(method, params);
        }
    }
}

/// `process.env` or `deps.baseEnv` as the TypeScript reads PATH from it
fn path_value_of(rt: &Rt, deps: &CodexAgentDeps) -> Option<String> {
    match &deps.base_env {
        Some(env) => {
            let get = |key: &str| env.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
            get("PATH").or_else(|| get("Path"))
        }
        None => rt.env("PATH").or_else(|| rt.env("Path")),
    }
}

/// `statSync(dir).isDirectory()` of every absolute PATH entry, asked before
/// the readable-folder loop runs
async fn stat_directories(rt: &Rt, path_value: Option<&str>, platform: &str) -> JsMap<bool> {
    let mut found: JsMap<bool> = JsMap::new();
    for dir in path_candidates(path_value, platform) {
        if dir.is_empty() || !is_absolute_on(platform, &dir) || found.has(&dir) {
            continue;
        }
        let is_dir = match rt.fs(FsOp::Stat { path: dir.clone() }).await {
            Ok(FsAnswer::Stat(stat)) => stat.kind == FileKind::Dir,
            _ => false,
        };
        found.set(dir, is_dir);
    }
    found
}

/// The model list request of `codexAgentEffort` and the default model
fn model_list_params() -> JsonValue {
    object(vec![
        ("cursor", JsonValue::Null),
        ("limit", number(100.0)),
        ("includeHidden", JsonValue::Bool(false)),
    ])
}

/// `defaultModelOf(result)`
fn default_model_of(result: &JsonValue) -> Result<String, JsError> {
    let data: &[JsonValue] = match record_of(Some(result)).and_then(|r| r.get("data")) {
        Some(JsonValue::Array(data)) => data,
        _ => &[],
    };
    let mut first = String::new();
    for value in data {
        let Some(value) = record_of(Some(value)) else {
            continue;
        };
        if value.get("hidden") == Some(&JsonValue::Bool(true)) {
            continue;
        }
        let id = text_of(value.get("id"))
            .or_else(|| text_of(value.get("model")))
            .unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        if value.get("isDefault") == Some(&JsonValue::Bool(true)) {
            return Ok(id);
        }
        if first.is_empty() {
            first = id;
        }
    }
    if first.is_empty() {
        return Err(program_error(
            AgentProgramProblem::NoModel,
            "Codex listed no model, so there is no default model to run with",
        ));
    }
    Ok(first)
}

/// `codexThreadNetworkAccess(started)`: whether the thread's sandbox lets
/// commands reach the network, as `thread/start` reports it
fn codex_thread_network_access(started: &JsonValue) -> Option<bool> {
    let sandbox = record_of(Some(started)).and_then(|started| record_of(started.get("sandbox")));
    match sandbox.and_then(|sandbox| sandbox.get("networkAccess")) {
        Some(JsonValue::Bool(access)) => Some(*access),
        _ => None,
    }
}

/// `codexAgentEffort(request, model, configured, listed)`: the configured
/// effort when Codex lists it for the model. The list is read only when a
/// level is configured, and one that cannot be read leaves the level out
/// rather than failing the session.
async fn codex_agent_effort(
    core: &Rc<Core>,
    model: &str,
    configured: Option<&str>,
    listed: Option<JsonValue>,
) -> Option<String> {
    let configured = configured.filter(|level| !trim(level).is_empty())?;
    let attempt = async {
        let listed = match listed {
            Some(value) if value != JsonValue::Null => value,
            _ => {
                core.request("model/list", model_list_params(), REQUEST_TIMEOUT_MS)
                    .await?
            }
        };
        Ok::<_, JsError>(codex_listed_effort(&listed, model, Some(&text(configured))))
    };
    attempt.await.ok().flatten().map(str::to_owned)
}

/// The steps of `startCodexAgentSession`'s `try` block: the handshake, the
/// login and MCP checks, and the thread.
async fn open_thread(
    core: &Rc<Core>,
    deps: &CodexAgentDeps,
    readable_dirs: &[String],
) -> Result<(), JsError> {
    let options = &core.options;
    let session = &options.session;
    core.request(
        "initialize",
        object(vec![
            (
                "clientInfo",
                object(vec![
                    ("name", text(CODEX_AGENT_PROFILE)),
                    ("title", text("Agent session")),
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
        ]),
        REQUEST_TIMEOUT_MS,
    )
    .await?;
    core.write_line(&object(vec![("method", text("initialized"))]));

    let account = core
        .request(
            "account/read",
            object(vec![("refreshToken", JsonValue::Bool(false))]),
            REQUEST_TIMEOUT_MS,
        )
        .await?;
    let login_method = match codex_account_info(&account) {
        Some(SubscriptionLogin::SignedIn { login_method, .. }) => login_method,
        _ => {
            return Err(ai_run_error(
                "signed-out",
                "Codex is not signed in",
                Some(PROVIDER),
                None,
            ));
        }
    };
    if login_method != "subscription" && !options.metered_accepted {
        return Err(ai_run_error(
            "metered-not-accepted",
            "Codex is signed in with a login that is billed by usage, which has not been accepted",
            Some(PROVIDER),
            None,
        ));
    }

    let user_mcp_servers: Obj = {
        let attempt = async {
            let config = core
                .request(
                    "config/read",
                    object(vec![
                        ("includeLayers", JsonValue::Bool(false)),
                        ("cwd", text(&session.project_root)),
                    ]),
                    REQUEST_TIMEOUT_MS,
                )
                .await?;
            codex_mcp_server_overrides(&config)
        };
        match attempt.await {
            Ok(servers) => servers,
            Err(_) => {
                return Err(ai_run_error(
                    "unsafe-tools",
                    "Codex could not report its configured MCP servers",
                    None,
                    None,
                ));
            }
        }
    };
    let mut removed: Vec<&str> = vec![APP_MCP_SERVER_NAME];
    removed.extend(core.relays.iter().map(|relay| relay.name.as_str()));
    let user_mcp_servers = without(&user_mcp_servers, &removed);

    // read once when it is needed for the default model, and again only for a level
    let mut listed: Option<JsonValue> = None;
    let given_model = trim(&session.model).to_owned();
    let model = if !given_model.is_empty() {
        given_model
    } else {
        let result = core
            .request("model/list", model_list_params(), REQUEST_TIMEOUT_MS)
            .await?;
        let model = default_model_of(&result)?;
        listed = Some(result);
        model
    };
    let effort = codex_agent_effort(core, &model, session.effort.as_deref(), listed).await;
    core.st.borrow_mut().effort = effort;
    let started = core
        .request(
            "thread/start",
            codex_agent_thread_params(
                session,
                options.network,
                &model,
                &user_mcp_servers,
                readable_dirs,
            ),
            deps.thread_start_timeout_ms
                .unwrap_or(THREAD_START_TIMEOUT_MS),
        )
        .await?;
    if active_permission_profile_id(&started).as_deref() != Some(CODEX_AGENT_PROFILE)
        || record_of(Some(&started)).is_none()
        || as_str(record_of(Some(&started)).and_then(|s| s.get("approvalPolicy")))
            != Some(codex_agent_approval_policy(session.mode))
    {
        return Err(ai_run_error(
            "unsafe-tools",
            "Codex did not apply the session permissions; nothing was run",
            None,
            None,
        ));
    }
    // the network the thread reports, when it does: open while the person left it off is not run
    if !core.network && codex_thread_network_access(&started) == Some(true) {
        return Err(ai_run_error(
            "unsafe-tools",
            "Codex opened the network for commands, which was left off; nothing was run",
            None,
            None,
        ));
    }
    let thread = record_of(Some(&started)).and_then(|started| record_of(started.get("thread")));
    let thread_id = match thread.and_then(|thread| thread.get("id")) {
        Some(JsonValue::String(id)) => id.clone(),
        _ => String::new(),
    };
    core.st.borrow_mut().thread_id = thread_id.clone();
    if thread_id.is_empty() {
        return Err(program_error(
            AgentProgramProblem::Refused {
                step: "thread/start".to_owned(),
                code: None,
            },
            "Codex app-server did not return a thread id",
        ));
    }

    let mut cursor: Option<String> = None;
    let mut attached: Vec<String> = Vec::new();
    let mut extra_tools: Vec<String> = Vec::new();
    for _page in 0..MAX_MCP_STATUS_PAGES {
        let result = core
            .request(
                "mcpServerStatus/list",
                object(vec![
                    ("threadId", text(&thread_id)),
                    ("detail", text("toolsAndAuthOnly")),
                    ("cursor", cursor.as_deref().map_or(JsonValue::Null, text)),
                    ("limit", number(100.0)),
                ]),
                REQUEST_TIMEOUT_MS,
            )
            .await?;
        attached.extend(codex_attached_mcp_servers(&result)?);
        extra_tools.extend(codex_app_mcp_extra_tools(&result, &core.relays));
        let next = record_of(Some(&result)).and_then(|result| result.get("nextCursor"));
        cursor = match next {
            Some(JsonValue::String(next)) if !next.is_empty() => Some(next.clone()),
            _ => None,
        };
        if cursor.is_none() {
            break;
        }
    }
    if cursor.is_some()
        || attached
            .iter()
            .any(|name| !core.given_servers.contains(name))
    {
        return Err(ai_run_error(
            "unsafe-tools",
            "Codex attached an MCP server the app did not give it",
            None,
            None,
        ));
    }
    if !extra_tools.is_empty() {
        return Err(ai_run_error(
            "unsafe-tools",
            format!(
                "Codex listed tools of the app's servers the app did not give it: {}",
                extra_tools.len()
            ),
            None,
            None,
        ));
    }
    core.emit(AgentSessionEvent::Started {
        provider: PROVIDER.to_owned(),
        model: Some(model),
        skills: Vec::new(),
    });
    Ok(())
}

/// `startCodexAgentSession(options, onEvent, deps)`
pub async fn start_codex_agent_session(
    rt: &Rt,
    locate: &LocateState,
    options: &CodexAgentSessionOptions,
    on_event: Rc<dyn Fn(&AgentSessionEvent)>,
    deps: &CodexAgentDeps,
) -> Result<CodexAgentSession, JsError> {
    let session = &options.session;
    let shared = locate.borrow().shared.clone();
    let platform = deps.platform.clone().unwrap_or_else(|| rt.platform());
    let network = options.network == Some(true);
    let relays = agent_usable_relays(session.user_mcp_relays.as_deref());
    let mut given_servers: Vec<String> = vec![APP_MCP_SERVER_NAME.to_owned()];
    given_servers.extend(relays.iter().map(|relay| relay.name.clone()));
    let program = match &deps.resolve_program {
        Some(resolve) => resolve(session.cli_path.clone()).await?,
        None => {
            resolve_subscription_program(
                rt,
                locate,
                PROVIDER,
                &SubscriptionLocateOptions {
                    configured_path: session.cli_path.clone(),
                    ..SubscriptionLocateOptions::default()
                },
            )
            .await?
        }
    };
    let path_value = path_value_of(rt, deps);
    let directories = stat_directories(rt, path_value.as_deref(), &platform).await;
    let readable_dirs = codex_agent_readable_dirs(
        path_value.as_deref(),
        session,
        Some(&platform),
        &|dir: &str| directories.get(dir).copied().unwrap_or(false),
    );
    if !codex_profile_paths_literal(&codex_agent_filesystem(session, &readable_dirs)) {
        return Err(program_error(
            AgentProgramProblem::UnsupportedPath,
            "A path of the session has a character Codex reads as a pattern; nothing was run",
        ));
    }
    if platform == "win32" {
        // the profile as the session uses it, network included: a sandbox that cannot start with
        // the network on does not start the session (it is not run with the network off instead)
        let filesystem = codex_agent_filesystem(session, &readable_dirs);
        let probe_dir = host::join(&[&session.session_dir, "sandbox-probe"]);
        let result = match &deps.probe_sandbox {
            Some(probe) => probe(filesystem, probe_dir, network).await?,
            None => {
                probe_codex_sandbox(
                    rt,
                    &shared,
                    &program,
                    &filesystem,
                    &probe_dir,
                    &CodexSandboxProbeDeps {
                        base_env: deps.base_env.clone(),
                        kill_tree: deps.kill_tree.clone(),
                        timeout_ms: None,
                        network: Some(network),
                    },
                )
                .await?
            }
        };
        if result == CodexSandboxProbeResult::Unavailable {
            return Err(agent_sandbox_unavailable_error());
        }
        if result == CodexSandboxProbeResult::NotContained {
            return Err(ai_run_error(
                "unsafe-tools",
                "Codex sandbox did not keep a denied folder out of reach; nothing was run",
                Some(PROVIDER),
                None,
            ));
        }
    }
    // the session folder as working directory: no project configuration of wherever the app
    // was started applies to the process; the thread's own folder is given per thread
    let child = match spawn_subscription_program(
        rt,
        &shared,
        &program,
        &codex_agent_launch_args(options.web_search.as_deref()),
        &SubscriptionSpawnOptions {
            cwd: Some(session.session_dir.clone()),
            stdio: Some([Stdio::Pipe, Stdio::Pipe, Stdio::Pipe]),
            base_env: deps.base_env.clone(),
            platform: Some(platform.clone()),
            ..SubscriptionSpawnOptions::default()
        },
    )
    .await
    {
        Ok(child) => child,
        Err(error) => {
            return Err(if as_str(error.prop("code")) == Some("ENOENT") {
                ai_run_error(
                    "not-installed",
                    "Codex CLI was not found",
                    Some(PROVIDER),
                    None,
                )
            } else {
                error
            });
        }
    };
    let kill_tree = deps
        .kill_tree
        .clone()
        .unwrap_or_else(|| default_kill_tree(rt));

    let core = Rc::new(Core {
        rt: rt.clone(),
        platform: platform.clone(),
        options: options.clone(),
        network,
        relays,
        given_servers,
        child: child.clone(),
        on_event,
        kill_tree: kill_tree.clone(),
        idle_ms: deps.idle_ms.unwrap_or(DEFAULT_IDLE_MS),
        st: RefCell::new(St {
            open_documents: session.open_documents.clone(),
            ended: false,
            stopping: false,
            thread_id: String::new(),
            turn_id: String::new(),
            effort: None,
            busy: false,
            stderr: String::new(),
            next_id: 1.0,
            idle_timer: None,
            reported_error: None,
            rpc_pending: Vec::new(),
            pending: JsMap::new(),
            file_change_paths: JsMap::new(),
        }),
    });

    {
        let pid = child.pid();
        let on_line = core.clone();
        let overflow = core.clone();
        attach_bounded_rpc_stdout(
            &child,
            move || kill_tree(pid),
            move |line| on_line.on_line(line),
            move |error| overflow.stop_now(Some(error)),
        );
    }
    {
        let core = core.clone();
        let errored = Cell::new(false);
        let closed = Cell::new(false);
        child.on(move |event| match event {
            ChildEvent::Stderr(chunk) => {
                let mut st = core.st.borrow_mut();
                let next = format!("{}{}", st.stderr, text_decoder_decode(chunk));
                st.stderr = if length16(&next) <= DIAGNOSTIC_LIMIT {
                    next
                } else {
                    slice_utf16(&next, -(DIAGNOSTIC_LIMIT as f64), None)
                };
            }
            ChildEvent::Error(error) => {
                if errored.replace(true) {
                    return;
                }
                core.end(Some(if as_str(error.prop("code")) == Some("ENOENT") {
                    ai_run_error(
                        "not-installed",
                        "Codex CLI was not found",
                        Some(PROVIDER),
                        None,
                    )
                } else {
                    error.clone()
                }));
            }
            ChildEvent::Close { code, .. } => {
                if closed.replace(true) {
                    return;
                }
                let (detail, stopping) = {
                    let st = core.st.borrow();
                    (trim(&st.stderr).to_owned(), st.stopping)
                };
                core.end(if stopping {
                    None
                } else {
                    Some(program_error(
                        AgentProgramProblem::Exited { exit_code: *code },
                        format!(
                            "Codex app-server exited ({}){}",
                            code.map_or_else(|| "unknown".to_owned(), number_to_string),
                            if detail.is_empty() {
                                String::new()
                            } else {
                                format!(": {detail}")
                            }
                        ),
                    ))
                });
            }
            ChildEvent::Stdout(_) | ChildEvent::Exit { .. } => {}
        });
    }

    if let Err(error) = open_thread(&core, deps, &readable_dirs).await {
        core.stop_now(None);
        return Err(as_error(error));
    }
    core.arm_idle();
    Ok(CodexAgentSession { core })
}

/// The running session `startCodexAgentSession` answers.
pub struct CodexAgentSession {
    core: Rc<Core>,
}

/// `send(message)`
async fn send_message(core: Rc<Core>, message: String) -> Result<(), JsError> {
    let (thread_id, effort) = {
        let mut st = core.st.borrow_mut();
        if st.ended {
            return Err(JsError::error("The agent session has ended"));
        }
        if st.busy {
            return Err(JsError::error(
                "The agent is still answering the previous message",
            ));
        }
        st.busy = true;
        (st.thread_id.clone(), st.effort.clone())
    };
    let idle_timer = core.st.borrow().idle_timer;
    core.rt.clear_timeout(idle_timer);
    let mut entries = vec![
        ("threadId", text(thread_id)),
        (
            "input",
            JsonValue::Array(vec![object(vec![
                ("type", text("text")),
                ("text", text(message)),
                ("text_elements", JsonValue::Array(Vec::new())),
            ])]),
        ),
    ];
    if let Some(effort) = effort.filter(|effort| !effort.is_empty()) {
        entries.push(("effort", text(effort)));
    }
    match core
        .request("turn/start", object(entries), REQUEST_TIMEOUT_MS)
        .await
    {
        Ok(_) => Ok(()),
        Err(error) => {
            core.st.borrow_mut().busy = false;
            core.arm_idle();
            Err(error)
        }
    }
}

impl AgentSession for CodexAgentSession {
    fn provider(&self) -> &str {
        PROVIDER
    }

    fn send(&self, message: &str) -> LocalBoxFuture<Result<(), JsError>> {
        Box::pin(send_message(self.core.clone(), message.to_owned()))
    }

    fn answer(&self, id: &str, answer: &AgentPermissionAnswer) {
        let waiting = self.core.st.borrow_mut().pending.delete(id);
        let Some(waiting) = waiting else {
            return;
        };
        self.core
            .answer_approval(&waiting.rpc_id, answer.allow(), &waiting.decline_as);
    }

    fn set_open_documents(&self, paths: &[String]) {
        self.core.st.borrow_mut().open_documents = paths.to_vec();
    }

    fn stop(&self) {
        if self.core.st.borrow().ended {
            return;
        }
        let interrupt = {
            let mut st = self.core.st.borrow_mut();
            if !st.thread_id.is_empty() && !st.turn_id.is_empty() {
                let id = st.next_id;
                st.next_id += 1.0;
                Some(object(vec![
                    ("method", text("turn/interrupt")),
                    ("id", number(id)),
                    (
                        "params",
                        object(vec![
                            ("threadId", text(&st.thread_id)),
                            ("turnId", text(&st.turn_id)),
                        ]),
                    ),
                ]))
            } else {
                None
            }
        };
        if let Some(message) = interrupt {
            self.core.write_line(&message);
        }
        self.core.stop_now(None);
    }
}
