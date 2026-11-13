//! Group `b5-mcp`, slice `client_proc`: see tools/main-diff/groups/b5-mcp/client-proc.ts.
//!
//! `local.scenario` drives a [`LocalMcpConnection`] through the case's steps
//! with a host that mirrors the fakes of the spec: a scripted child (the case's
//! steps are what it writes and how it ends), fake timers numbered in the order
//! they are made, a fake working folder, a fake process-group kill and
//! taskkill. Every call of a fake is one `logs` line as the TypeScript writes
//! it. `runtimes.scenario` runs the runtime kit over the case's folder.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::node_path::host;
use jscompat::{JsObject, JsonValue, json_stringify, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value, json};

use super::super::{Answer, Context, arg, str_arg};
use crate::node_fs::NodeError;
use crate::packages::ai_provider::jsval::{as_record, as_str, object, prop, text};
use crate::packages::ai_provider::subscription_process::{
    KillHost, KillerSpawn, Signal as KillSignal, on_kill_timeout,
};
use crate::packages::mcp_sdk::client::OutputCheck;
use crate::packages::mcp_sdk::types::LATEST_PROTOCOL_VERSION;
use crate::shell::mcp_client::local::{
    CallFailure, CallId, CallKind, CallOutcome, CallSignal, ChildId, LocalMcpConnection,
    LocalMcpHost, LocalMcpOptions, MCP_LOCAL_IDLE_MS, MCP_LOCAL_MAX_START_FAILURES,
    MCP_LOCAL_START_TIMEOUT_MS, MCP_STDERR_TAIL_LINES, SpawnRequest,
};
use crate::shell::mcp_client::local_launch::{
    LaunchSource, McpRuntimeId, McpRuntimeKit, ResolveOptions, ResolvedLaunch, RuntimeDownloadItem,
    RuntimeMissing, RuntimeMissingDetail, RuntimeResolution,
};
use crate::shell::mcp_client::runtime_archive::{RuntimeFetch, RuntimeResponse};
use crate::shell::mcp_client::runtime_pins::{
    ArchiveFormat, McpRuntimePins, PinnedArchive, PinnedPython, PinnedRuntime, PlatformTable,
};
use crate::shell::mcp_client::runtimes::{
    InstallId, MCP_RUNTIMES_DIR_NAME, McpRuntimeKitOptions, PcLookupOptions, ProgramSearch,
    RuntimeDownloadQuestion, RuntimeKit, RuntimeKitHost, UvRunResult, find_pc_node, find_pc_python,
    find_pc_uv, find_program_on_path, mcp_runtimes_root, rename_path, runtime_for_command,
    runtime_install_dir, uv_data_env,
};
use crate::shell::mcp_client::store::{McpServerConfig, normalize_mcp_servers_file};

fn out(value: JsonValue) -> Answer {
    Ok(Some(json_value_to_serde(&value)))
}

fn json_arg(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

fn strings_of(v: Option<&JsonValue>) -> Vec<String> {
    match v {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|x| as_str(Some(x)).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

fn string_map(v: Option<&JsonValue>) -> JsObject<String> {
    let mut out = JsObject::new();
    if let Some(record) = v.and_then(as_record) {
        for (key, value) in record.entries() {
            if let Some(s) = as_str(Some(value)) {
                out.set(key, s.to_owned());
            }
        }
    }
    out
}

fn number_of(v: Option<&JsonValue>) -> Option<f64> {
    match v {
        Some(JsonValue::Number(n)) => Some(*n),
        _ => None,
    }
}

fn is_true(v: Option<&JsonValue>) -> bool {
    matches!(v, Some(JsonValue::Bool(true)))
}

fn string_map_json(record: &JsObject<String>) -> JsonValue {
    let mut out = JsObject::new();
    for (key, value) in record.entries() {
        out.set(key, text(value.as_str()));
    }
    JsonValue::Object(out)
}

fn str_list(items: &[String]) -> JsonValue {
    JsonValue::Array(items.iter().map(|s| text(s.as_str())).collect())
}

// ---- the fake kit ----

fn runtime_id(v: Option<&JsonValue>) -> Option<McpRuntimeId> {
    match as_str(v) {
        Some("node") => Some(McpRuntimeId::Node),
        Some("uv") => Some(McpRuntimeId::Uv),
        Some("python") => Some(McpRuntimeId::Python),
        _ => None,
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

fn resolution_of(v: &JsonValue) -> RuntimeResolution {
    if is_true(prop(v, "ok")) {
        return RuntimeResolution::Resolved(ResolvedLaunch {
            command: as_str(prop(v, "command")).unwrap_or_default().to_owned(),
            prefix_args: strings_of(prop(v, "prefixArgs")),
            env: string_map(prop(v, "env")),
            path_prepend: strings_of(prop(v, "pathPrepend")),
            source: if as_str(prop(v, "source")) == Some("app") {
                LaunchSource::App
            } else {
                LaunchSource::Pc
            },
            runtime: runtime_id(prop(v, "runtime")),
        });
    }
    let downloads = match prop(v, "downloads") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|item| RuntimeDownloadItem {
                runtime: runtime_id(prop(item, "runtime")).unwrap_or(McpRuntimeId::Node),
                version: as_str(prop(item, "version")).unwrap_or_default().to_owned(),
                bytes: number_of(prop(item, "bytes")).unwrap_or(0.0),
            })
            .collect(),
        _ => Vec::new(),
    };
    RuntimeResolution::Missing(RuntimeMissing {
        detail: missing_detail(as_str(prop(v, "detail")).unwrap_or_default()),
        runtime: runtime_id(prop(v, "runtime")),
        downloads,
        message: as_str(prop(v, "message")).unwrap_or_default().to_owned(),
    })
}

type Logs = Rc<RefCell<Vec<Vec<Value>>>>;

fn log(logs: &Logs, line: Vec<Value>) {
    logs.borrow_mut().push(line);
}

/// `kit` of the spec: answers the case's resolutions in order (the last one
/// repeats), logs `resolve`, and throws where the case says
struct FakeKit {
    resolutions: Vec<RuntimeResolution>,
    throws: Vec<usize>,
    calls: Cell<usize>,
    failed: Cell<bool>,
    logs: Logs,
}

impl McpRuntimeKit for FakeKit {
    fn resolve_command(&self, command: &str, options: &ResolveOptions) -> RuntimeResolution {
        log(
            &self.logs,
            vec![
                Value::from("resolve"),
                Value::from(command),
                json!({ "offerDownload": options.offer_download }),
            ],
        );
        let index = self.calls.get();
        self.calls.set(index + 1);
        if self.throws.contains(&index) {
            self.failed.set(true);
            return RuntimeResolution::Missing(RuntimeMissing {
                detail: RuntimeMissingDetail::Offline,
                runtime: None,
                downloads: Vec::new(),
                message: String::new(),
            });
        }
        self.resolutions[index.min(self.resolutions.len() - 1)].clone()
    }
}

// ---- the fake world of a local scenario ----

#[derive(Clone, Copy)]
enum TimerKind {
    Plain,
    Kill(f64),
}

struct Timer {
    active: bool,
    kind: TimerKind,
}

struct FakeChild {
    id: ChildId,
    pid: Option<f64>,
    destroyed: bool,
}

struct LocalWorld {
    logs: Logs,
    kit: FakeKit,
    timers: Vec<Timer>,
    children: Vec<FakeChild>,
    spawn_failures: Vec<Option<String>>,
    spawns: usize,
    work_dir_fails: usize,
    work_dirs: usize,
    made_dirs: usize,
    no_pid: bool,
    kill_group_throws: bool,
    taskkill_throws: bool,
    labels: Vec<String>,
    outcomes: Vec<(String, JsonValue)>,
}

impl LocalWorld {
    fn index_of(&self, child: ChildId) -> usize {
        self.children
            .iter()
            .position(|c| c.id == child)
            .unwrap_or(0)
    }

    fn set_outcome(&mut self, label: &str, value: JsonValue) {
        match self.outcomes.iter_mut().find(|(l, _)| l == label) {
            Some(entry) => entry.1 = value,
            None => self.outcomes.push((label.to_owned(), value)),
        }
    }

    fn make_timer(&mut self, ms: f64, kind: TimerKind) -> u64 {
        log(&self.logs, vec![Value::from("setTimeout"), json_number(ms)]);
        self.timers.push(Timer { active: true, kind });
        self.timers.len() as u64
    }
}

fn json_number(n: f64) -> Value {
    json_value_to_serde(&JsonValue::Number(n))
}

impl KillHost for LocalWorld {
    fn process_platform(&self) -> String {
        "linux".to_owned()
    }

    fn env_var(&self, _key: &str) -> Option<String> {
        None
    }

    fn kill(&mut self, pid: f64, signal: Option<KillSignal>) -> Result<(), String> {
        log(
            &self.logs,
            vec![
                Value::from("kill"),
                json_number(pid),
                signal.map_or(Value::Null, |s| Value::from(s.as_str())),
            ],
        );
        if self.kill_group_throws && pid < 0.0 {
            return Err("ESRCH".to_owned());
        }
        Ok(())
    }

    fn spawn_killer(
        &mut self,
        _pid: f64,
        command: &str,
        args: &[String],
        options: &KillerSpawn,
    ) -> Result<u64, String> {
        log(
            &self.logs,
            vec![
                Value::from("taskkill"),
                Value::from(command),
                Value::from(args.to_vec()),
                json!({ "cwd": options.cwd, "stdio": options.stdio, "windowsHide": options.windows_hide }),
            ],
        );
        if self.taskkill_throws {
            return Err("no taskkill".to_owned());
        }
        Ok(0)
    }

    fn unref_killer(&mut self, _killer: u64) -> Result<(), String> {
        Ok(())
    }

    fn set_kill_timeout(&mut self, ms: f64, pid: f64) -> u64 {
        self.make_timer(ms, TimerKind::Kill(pid))
    }

    fn unref_timer(&mut self, _timer: u64) {}
}

fn listing_json(listing: &crate::shell::mcp_client::listing::McpListing) -> JsonValue {
    let tools = listing
        .tools
        .iter()
        .map(|tool| {
            let mut entries = vec![("name", text(tool.name.as_str()))];
            if let Some(description) = &tool.description {
                entries.push(("description", text(description.as_str())));
            }
            if let Some(schema) = &tool.input_schema {
                entries.push(("inputSchema", schema.clone()));
            }
            if let Some(annotations) = &tool.annotations {
                entries.push(("annotations", annotations.clone()));
            }
            object(entries)
        })
        .collect();
    object(vec![
        ("tools", JsonValue::Array(tools)),
        (
            "instructions",
            listing
                .instructions
                .as_deref()
                .map_or(JsonValue::Null, text),
        ),
    ])
}

impl LocalMcpHost for LocalWorld {
    fn kit(&self) -> &dyn McpRuntimeKit {
        &self.kit
    }

    fn take_lookup_failure(&mut self) -> bool {
        self.kit.failed.replace(false)
    }

    fn tmp_dir(&mut self) -> String {
        "/tmp".to_owned()
    }

    fn make_work_dir(&mut self, root: &str) -> Result<String, String> {
        log(&self.logs, vec![Value::from("mkdir"), Value::from(root)]);
        if self.work_dirs < self.work_dir_fails {
            self.work_dirs += 1;
            return Err("EACCES".to_owned());
        }
        let prefix = host::join(&[root, "ieum-mcp-"]);
        log(
            &self.logs,
            vec![Value::from("mkdtemp"), Value::from(prefix.as_str())],
        );
        self.made_dirs += 1;
        Ok(format!("{prefix}{:06}", self.made_dirs))
    }

    fn remove_work_dir(&mut self, path: &str) {
        log(&self.logs, vec![Value::from("rm"), Value::from(path)]);
    }

    fn spawn(&mut self, child: ChildId, request: &SpawnRequest<'_>) -> Result<(), String> {
        let mut env = Map::new();
        for (key, value) in request.env.entries() {
            env.insert(key.to_owned(), Value::from(value.as_str()));
        }
        let mut options = Map::new();
        options.insert("cwd".into(), Value::from(request.cwd));
        options.insert("env".into(), Value::Object(env));
        options.insert("stdio".into(), json!(["pipe", "pipe", "pipe"]));
        options.insert("shell".into(), Value::Bool(false));
        options.insert("windowsHide".into(), Value::Bool(request.windows_hide));
        options.insert("detached".into(), Value::Bool(request.detached));
        log(
            &self.logs,
            vec![
                Value::from("spawn"),
                Value::from(request.command),
                Value::from(request.args.to_vec()),
                Value::Object(options),
            ],
        );
        let failure = self.spawn_failures.get(self.spawns).cloned().flatten();
        self.spawns += 1;
        if let Some(message) = failure {
            return Err(message);
        }
        let index = self.children.len();
        self.children.push(FakeChild {
            id: child,
            pid: if self.no_pid {
                None
            } else {
                Some(4000.0 + index as f64)
            },
            destroyed: false,
        });
        Ok(())
    }

    fn child_pid(&mut self, child: ChildId) -> Option<f64> {
        self.children.iter().find(|c| c.id == child)?.pid
    }

    fn track_child(&mut self, child: ChildId, command: &str) {
        let pid = self.child_pid(child);
        log(
            &self.logs,
            vec![
                Value::from("track"),
                pid.map_or(Value::Null, json_number),
                json!({ "provider": "user-mcp", "command": command }),
            ],
        );
    }

    fn write_stdin(&mut self, child: ChildId, data: &str) {
        let index = self.index_of(child);
        log(
            &self.logs,
            vec![Value::from("write"), Value::from(index), Value::from(data)],
        );
    }

    fn stdin_destroyed(&mut self, child: ChildId) -> bool {
        self.children
            .iter()
            .find(|c| c.id == child)
            .is_some_and(|c| c.destroyed)
    }

    fn kill_host(&mut self) -> &mut dyn KillHost {
        self
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        self.make_timer(ms, TimerKind::Plain)
    }

    fn set_idle_timeout(&mut self, ms: f64) -> u64 {
        self.make_timer(ms, TimerKind::Plain)
    }

    fn clear_timeout(&mut self, timer: u64) {
        log(
            &self.logs,
            vec![Value::from("clearTimeout"), Value::from(timer)],
        );
        if let Some(entry) = self.timers.get_mut(timer as usize - 1) {
            entry.active = false;
        }
    }

    fn state_changed(
        &mut self,
        listener: u64,
        state: &crate::shell::mcp_client::local::LocalMcpState,
    ) {
        log(
            &self.logs,
            vec![
                Value::from("state"),
                Value::from(listener),
                json_value_to_serde(&state.to_json()),
            ],
        );
    }

    fn tools_changed(&mut self, listener: u64) {
        log(
            &self.logs,
            vec![Value::from("tools"), Value::from(listener)],
        );
    }

    fn settle(&mut self, call: CallId, kind: CallKind, outcome: Result<CallOutcome, CallFailure>) {
        let _ = kind;
        let value = match outcome {
            Ok(CallOutcome::Ensured | CallOutcome::Stopped) => {
                object(vec![("ok", JsonValue::Bool(true))])
            }
            Ok(CallOutcome::Listing(listing)) => object(vec![("ok", listing_json(&listing))]),
            Ok(CallOutcome::Result(shaped)) => object(vec![(
                "ok",
                object(vec![
                    ("output", text(shaped.output.as_str())),
                    ("isError", JsonValue::Bool(shaped.is_error)),
                ]),
            )]),
            Err(CallFailure::Aborted) => object(vec![
                ("error", text("AbortError")),
                ("message", text("The call was cancelled")),
            ]),
            Err(CallFailure::Local(error)) => error.to_json(),
        };
        let label = self.labels.get(call as usize).cloned().unwrap_or_default();
        self.set_outcome(&label, value);
    }

    fn compile_output_schema(&mut self, _schema: &JsonValue) -> Result<u64, String> {
        Err("no output validation in this scenario".to_owned())
    }

    fn validate_output(&mut self, _validator: u64, _structured_content: &JsonValue) -> OutputCheck {
        OutputCheck::Valid
    }
}

fn init_result(instructions: Option<&str>) -> JsonValue {
    let mut entries = vec![
        ("protocolVersion", text(LATEST_PROTOCOL_VERSION)),
        ("capabilities", object(vec![("tools", object(vec![]))])),
        (
            "serverInfo",
            object(vec![("name", text("fake")), ("version", text("1.0.0"))]),
        ),
    ];
    if let Some(instructions) = instructions {
        entries.push(("instructions", text(instructions)));
    }
    object(entries)
}

fn reply_line(id: JsonValue, result: JsonValue) -> String {
    let mut line = json_stringify(&object(vec![
        ("jsonrpc", text("2.0")),
        ("id", id),
        ("result", result),
    ]));
    line.push('\n');
    line
}

fn server_of(stored: &JsonValue) -> McpServerConfig {
    let wrapped = object(vec![("servers", JsonValue::Array(vec![stored.clone()]))]);
    normalize_mcp_servers_file(&wrapped)
        .servers
        .into_iter()
        .next()
        .expect("a server of the case")
}

fn signal_of(step: &JsonValue) -> CallSignal {
    match as_str(prop(step, "signal")) {
        Some("live") => CallSignal::Live,
        Some("aborted") => CallSignal::Aborted,
        _ => CallSignal::None,
    }
}

fn local_scenario(args: &[Value]) -> (Answer, Vec<Vec<Value>>) {
    let stored = json_arg(args, 0);
    let o = json_arg(args, 1);
    let steps = match json_arg(args, 2) {
        JsonValue::Array(steps) => steps,
        _ => Vec::new(),
    };
    let logs: Logs = Rc::new(RefCell::new(Vec::new()));
    let resolutions: Vec<RuntimeResolution> = match prop(&o, "kit") {
        Some(JsonValue::Array(items)) => items.iter().map(resolution_of).collect(),
        Some(other) => vec![resolution_of(other)],
        None => vec![resolution_of(&JsonValue::Null)],
    };
    let throws: Vec<usize> = match prop(&o, "lookupThrows") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|v| number_of(Some(v)).map(|n| n as usize))
            .collect(),
        _ => Vec::new(),
    };
    let spawn_failures: Vec<Option<String>> = match prop(&o, "spawnFailures") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .map(|v| as_str(Some(v)).map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    };
    let mut world = LocalWorld {
        logs: logs.clone(),
        kit: FakeKit {
            resolutions,
            throws,
            calls: Cell::new(0),
            failed: Cell::new(false),
            logs: logs.clone(),
        },
        timers: Vec::new(),
        children: Vec::new(),
        spawn_failures,
        spawns: 0,
        work_dir_fails: number_of(prop(&o, "workDirFails")).unwrap_or(0.0) as usize,
        work_dirs: 0,
        made_dirs: 0,
        no_pid: is_true(prop(&o, "noPid")),
        kill_group_throws: is_true(prop(&o, "killGroupThrows")),
        taskkill_throws: is_true(prop(&o, "taskkillThrows")),
        labels: Vec::new(),
        outcomes: Vec::new(),
    };
    let app_signal = as_str(prop(&o, "appSignal"));
    let options = LocalMcpOptions {
        client_name: "seuoffice".to_owned(),
        client_version: "1.2.3".to_owned(),
        registry: !matches!(prop(&o, "registry"), Some(JsonValue::Bool(false))),
        base_env: prop(&o, "baseEnv").map(|e| string_map(Some(e))),
        system_env: prop(&o, "systemEnv").map(|e| strings_of(Some(e))),
        platform: as_str(prop(&o, "platform")).map(str::to_owned),
        work_root: as_str(prop(&o, "workRoot")).map(str::to_owned),
        idle_ms: number_of(prop(&o, "idleMs")),
        call_timeout_ms: number_of(prop(&o, "callTimeoutMs")),
        start_timeout_ms: number_of(prop(&o, "startTimeoutMs")),
        max_start_failures: number_of(prop(&o, "maxStartFailures")),
        result_max_chars: number_of(prop(&o, "resultMaxChars")),
        app_aborted: app_signal == Some("aborted"),
    };
    let mut conn = LocalMcpConnection::new(server_of(&stored), options);
    let mut results: Vec<JsonValue> = Vec::new();
    let mut controllers: Vec<(String, CallId)> = Vec::new();

    for step in &steps {
        let op = as_str(prop(step, "op")).unwrap_or_default();
        let label = as_str(prop(step, "label")).unwrap_or_default().to_owned();
        let child_of = |world: &LocalWorld| -> Option<ChildId> {
            let index = number_of(prop(step, "child")).map(|n| n as usize);
            match index {
                Some(i) => world.children.get(i).map(|c| c.id),
                None => world.children.last().map(|c| c.id),
            }
        };
        let mut result = JsonValue::Null;
        match op {
            "ensure" | "list" | "call" | "stop" => {
                let id = world.labels.len() as CallId;
                world.labels.push(label.clone());
                world.set_outcome(&label, text("pending"));
                let signal = signal_of(step);
                if signal == CallSignal::Live {
                    controllers.retain(|(l, _)| *l != label);
                    controllers.push((label.clone(), id));
                }
                match op {
                    "ensure" => conn.ensure(&mut world, id, signal),
                    "list" => conn.list_tools(&mut world, id, signal),
                    "call" => {
                        let tool = as_str(prop(step, "tool")).unwrap_or_default().to_owned();
                        let call_args = prop(step, "args")
                            .cloned()
                            .unwrap_or_else(|| JsonValue::Object(JsObject::new()));
                        conn.call_tool(&mut world, id, &tool, call_args, signal);
                    }
                    _ => conn.stop(&mut world, id),
                }
            }
            "abort" => {
                if let Some((_, id)) = controllers.iter().find(|(l, _)| *l == label) {
                    let id = *id;
                    conn.abort(&mut world, id);
                }
            }
            "stdout" => {
                if let Some(child) = child_of(&world) {
                    let data = as_str(prop(step, "text")).unwrap_or_default().to_owned();
                    conn.on_stdout(&mut world, child, data.as_bytes());
                }
            }
            "stderr" => {
                if let Some(child) = child_of(&world) {
                    let data = as_str(prop(step, "text")).unwrap_or_default().to_owned();
                    conn.on_stderr(&mut world, child, data.as_bytes());
                }
            }
            "reply" | "init" => {
                if let Some(child) = child_of(&world) {
                    let line = if op == "reply" {
                        reply_line(
                            prop(step, "id").cloned().unwrap_or(JsonValue::Null),
                            prop(step, "result").cloned().unwrap_or(JsonValue::Null),
                        )
                    } else {
                        reply_line(
                            JsonValue::Number(number_of(prop(step, "id")).unwrap_or(0.0)),
                            init_result(as_str(prop(step, "instructions"))),
                        )
                    };
                    conn.on_stdout(&mut world, child, line.as_bytes());
                }
            }
            "exit" => {
                if let Some(child) = child_of(&world) {
                    conn.on_child_exit(&mut world, child);
                }
            }
            "close" => {
                if let Some(child) = child_of(&world) {
                    conn.on_child_close(&mut world, child);
                }
            }
            "childError" => {
                if let Some(child) = child_of(&world) {
                    conn.on_child_error(&mut world, child);
                }
            }
            "stdinError" => {
                if let Some(child) = child_of(&world) {
                    conn.on_stdin_error(&mut world, child);
                }
            }
            "destroyStdin" => {
                if let Some(child) = child_of(&world)
                    && let Some(entry) = world.children.iter_mut().find(|c| c.id == child)
                {
                    entry.destroyed = true;
                }
            }
            "timer" => {
                let n = number_of(prop(step, "n")).unwrap_or(0.0) as usize;
                let fired = n
                    .checked_sub(1)
                    .and_then(|i| world.timers.get_mut(i))
                    .filter(|t| t.active)
                    .map(|t| {
                        t.active = false;
                        t.kind
                    });
                match fired {
                    Some(TimerKind::Plain) => {
                        conn.on_timeout(&mut world, n as u64);
                    }
                    Some(TimerKind::Kill(pid)) => on_kill_timeout(pid, &mut world),
                    None => {}
                }
            }
            "setServer" => {
                let next = server_of(prop(step, "server").unwrap_or(&JsonValue::Null));
                conn.set_server(&mut world, next);
            }
            "retry" => conn.retry(&mut world),
            "status" => result = conn.status().to_json(),
            "tail" => result = str_list(&conn.stderr_tail()),
            "planned" => result = conn.planned_launch(&world).to_json(),
            "appAbort" => {
                if app_signal.is_some() {
                    conn.app_abort(&mut world);
                }
            }
            "listen" | "unlisten" => {
                let id = number_of(prop(step, "id")).unwrap_or(0.0) as u64;
                let state = as_str(prop(step, "kind")) == Some("state");
                match (op, state) {
                    ("listen", true) => conn.add_state_listener(id),
                    ("listen", false) => conn.add_tools_listener(id),
                    (_, true) => conn.remove_state_listener(id),
                    (_, false) => conn.remove_tools_listener(id),
                }
            }
            _ => {}
        }
        results.push(result);
    }

    let mut outcomes = JsObject::new();
    for (label, value) in &world.outcomes {
        outcomes.set(label.as_str(), value.clone());
    }
    let answer = object(vec![
        ("results", JsonValue::Array(results)),
        ("outcomes", JsonValue::Object(outcomes)),
        ("status", conn.status().to_json()),
        ("tail", str_list(&conn.stderr_tail())),
    ]);
    let lines = logs.borrow().clone();
    (out(answer), lines)
}

// ---- runtimes: the lookups ----

fn lookup_options(o: &JsonValue) -> PcLookupOptions {
    PcLookupOptions {
        env: prop(o, "env").map(|e| string_map(Some(e))),
        platform: as_str(prop(o, "platform")).map(str::to_owned),
        fallback_dirs: prop(o, "fallbackDirs").map(|d| strings_of(Some(d))),
    }
}

fn opt_text(value: Option<String>) -> JsonValue {
    value.map_or(JsonValue::Null, |s| text(s.as_str()))
}

// ---- runtimes: the kit ----

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len() / 2)
        .filter_map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

struct FakeFetcher {
    routes: JsonValue,
    logs: Logs,
}

impl RuntimeFetch for FakeFetcher {
    fn fetch(&self, url: &str) -> Result<RuntimeResponse, String> {
        log(&self.logs, vec![Value::from("fetch"), Value::from(url)]);
        let Some(spec) = prop(&self.routes, url) else {
            return Err("no route".to_owned());
        };
        if let Some(reason) = as_str(prop(spec, "reject")) {
            return Err(reason.to_owned());
        }
        let status = number_of(prop(spec, "status")).map_or(200, |n| n as u16);
        let body = if is_true(prop(spec, "noBody")) {
            None
        } else {
            let mut chunks: Vec<Result<Vec<u8>, String>> = strings_of(prop(spec, "chunks"))
                .iter()
                .map(|h| Ok(hex_bytes(h)))
                .collect();
            if let Some(message) = as_str(prop(spec, "midError")) {
                chunks.push(Err(message.to_owned()));
            }
            let body: Box<dyn Iterator<Item = Result<Vec<u8>, String>>> =
                Box::new(chunks.into_iter());
            Some(body)
        };
        Ok(RuntimeResponse {
            ok: (200..300).contains(&status),
            status,
            body,
        })
    }
}

struct KitWorld {
    logs: Logs,
    allowed: RefCell<Vec<String>>,
    allowed_throws: bool,
    record_throws: bool,
    /// `Some(answer)`, `None` is a question that throws
    ask: Vec<Option<bool>>,
    asks: Cell<usize>,
    uv_throws: bool,
    uv_find: Vec<(f64, String)>,
    uv_install: Vec<(f64, String)>,
    finds: Cell<usize>,
    installs: Cell<usize>,
    rename_failures: Vec<Option<String>>,
    renames: Cell<usize>,
    fetcher: FakeFetcher,
}

fn uv_answers(v: Option<&JsonValue>, default: (f64, &str)) -> Vec<(f64, String)> {
    match v {
        Some(JsonValue::Array(items)) if !items.is_empty() => items
            .iter()
            .map(|item| {
                (
                    number_of(prop(item, "code")).unwrap_or(0.0),
                    as_str(prop(item, "stdout")).unwrap_or_default().to_owned(),
                )
            })
            .collect(),
        _ => vec![(default.0, default.1.to_owned())],
    }
}

impl RuntimeKitHost for KitWorld {
    fn is_runtime_allowed(&self, id: McpRuntimeId) -> Result<bool, String> {
        log(
            &self.logs,
            vec![Value::from("allowed?"), Value::from(id.as_str())],
        );
        if self.allowed_throws {
            return Err("store".to_owned());
        }
        Ok(self.allowed.borrow().iter().any(|a| a == id.as_str()))
    }

    fn record_runtime_allowed(&self, id: McpRuntimeId) -> Result<(), String> {
        log(
            &self.logs,
            vec![Value::from("record"), Value::from(id.as_str())],
        );
        if self.record_throws {
            return Err("write".to_owned());
        }
        self.allowed.borrow_mut().push(id.as_str().to_owned());
        Ok(())
    }

    fn ask_download(&self, question: &RuntimeDownloadQuestion) -> Result<bool, String> {
        let json = object(vec![
            ("command", text(question.command.as_str())),
            ("runtime", text(question.runtime.as_str())),
            (
                "downloads",
                JsonValue::Array(
                    question
                        .downloads
                        .iter()
                        .map(RuntimeDownloadItem::to_json)
                        .collect(),
                ),
            ),
            ("totalBytes", JsonValue::Number(question.total_bytes)),
        ]);
        log(
            &self.logs,
            vec![Value::from("ask"), json_value_to_serde(&json)],
        );
        let index = self.asks.get().min(self.ask.len() - 1);
        self.asks.set(self.asks.get() + 1);
        match self.ask[index] {
            Some(answer) => Ok(answer),
            None => Err("ui".to_owned()),
        }
    }

    fn fetcher(&self) -> &dyn RuntimeFetch {
        &self.fetcher
    }

    fn run_uv(
        &self,
        uv: &str,
        args: &[String],
        env: &JsObject<String>,
        cwd: &str,
    ) -> Result<UvRunResult, String> {
        log(
            &self.logs,
            vec![
                Value::from("runUv"),
                Value::from(uv),
                Value::from(args.to_vec()),
                json_value_to_serde(&string_map_json(env)),
                Value::from(cwd),
            ],
        );
        if self.uv_throws {
            return Err("uv".to_owned());
        }
        let (list, counter) = if args.get(1).map(String::as_str) == Some("find") {
            (&self.uv_find, &self.finds)
        } else {
            (&self.uv_install, &self.installs)
        };
        let index = counter.get().min(list.len() - 1);
        counter.set(counter.get() + 1);
        let (code, stdout) = list[index].clone();
        Ok(UvRunResult { code, stdout })
    }

    fn sleep(&self, ms: f64) {
        log(&self.logs, vec![Value::from("sleep"), json_number(ms)]);
    }

    fn rename(&self, from: &str, to: &str) -> Result<(), NodeError> {
        log(
            &self.logs,
            vec![Value::from("rename"), Value::from(from), Value::from(to)],
        );
        let failure = self
            .rename_failures
            .get(self.renames.get())
            .cloned()
            .flatten();
        self.renames.set(self.renames.get() + 1);
        match failure {
            Some(code) => Err(NodeError {
                code: Some(match code.as_str() {
                    "EBUSY" => "EBUSY",
                    "EPERM" => "EPERM",
                    "EACCES" => "EACCES",
                    "ENOENT" => "ENOENT",
                    _ => "EIO",
                }),
                message: format!("{code}: rename failed"),
            }),
            None => rename_path(from, to),
        }
    }

    fn random_hex4(&self) -> String {
        "abcd1234".to_owned()
    }
}

fn pinned_archive(v: &JsonValue) -> PinnedArchive {
    PinnedArchive {
        url: as_str(prop(v, "url")).unwrap_or_default().to_owned(),
        sha256: as_str(prop(v, "sha256")).unwrap_or_default().to_owned(),
        bytes: number_of(prop(v, "bytes")).unwrap_or(0.0) as u64,
        format: if as_str(prop(v, "format")) == Some("zip") {
            ArchiveFormat::Zip
        } else {
            ArchiveFormat::TarGz
        },
        root: as_str(prop(v, "root")).unwrap_or_default().to_owned(),
    }
}

fn platform_table<T>(v: Option<&JsonValue>, make: impl Fn(&JsonValue) -> T) -> PlatformTable<T> {
    let cell = |key: &str| make(v.and_then(|t| prop(t, key)).unwrap_or(&JsonValue::Null));
    PlatformTable {
        win32_x64: cell("win32-x64"),
        darwin_arm64: cell("darwin-arm64"),
        darwin_x64: cell("darwin-x64"),
        linux_x64: cell("linux-x64"),
    }
}

fn pins_of(v: &JsonValue) -> McpRuntimePins {
    let runtime = |key: &str| {
        let r = prop(v, key).unwrap_or(&JsonValue::Null);
        PinnedRuntime {
            version: as_str(prop(r, "version")).unwrap_or_default().to_owned(),
            archives: platform_table(prop(r, "archives"), pinned_archive),
        }
    };
    let python = prop(v, "python").unwrap_or(&JsonValue::Null);
    McpRuntimePins {
        node: runtime("node"),
        uv: runtime("uv"),
        python: PinnedPython {
            version: as_str(prop(python, "version"))
                .unwrap_or_default()
                .to_owned(),
            bytes: platform_table(prop(python, "bytes"), |n| match n {
                JsonValue::Number(n) => *n as u64,
                _ => 0,
            }),
        },
    }
}

fn resolution_json(resolution: &RuntimeResolution) -> JsonValue {
    match resolution {
        RuntimeResolution::Missing(missing) => missing.to_json(),
        RuntimeResolution::Resolved(r) => object(vec![
            ("ok", JsonValue::Bool(true)),
            ("command", text(r.command.as_str())),
            ("prefixArgs", str_list(&r.prefix_args)),
            ("env", string_map_json(&r.env)),
            ("pathPrepend", str_list(&r.path_prepend)),
            ("source", text(r.source.as_str())),
            (
                "runtime",
                r.runtime.map_or(JsonValue::Null, |id| text(id.as_str())),
            ),
        ]),
    }
}

fn kit_scenario(args: &[Value]) -> (Answer, Vec<Vec<Value>>) {
    let o = json_arg(args, 0);
    let steps = match json_arg(args, 1) {
        JsonValue::Array(steps) => steps,
        _ => Vec::new(),
    };
    let logs: Logs = Rc::new(RefCell::new(Vec::new()));
    let ask: Vec<Option<bool>> = match prop(&o, "ask") {
        Some(JsonValue::Array(items)) if !items.is_empty() => items
            .iter()
            .map(|v| match v {
                JsonValue::Bool(b) => Some(*b),
                _ => None,
            })
            .collect(),
        _ => vec![Some(false)],
    };
    let world = KitWorld {
        logs: logs.clone(),
        allowed: RefCell::new(strings_of(prop(&o, "allowed"))),
        allowed_throws: is_true(prop(&o, "allowedThrows")),
        record_throws: is_true(prop(&o, "recordThrows")),
        ask,
        asks: Cell::new(0),
        uv_throws: is_true(prop(&o, "uvThrows")),
        uv_find: uv_answers(prop(&o, "uvFind"), (1.0, "")),
        uv_install: uv_answers(prop(&o, "uvInstall"), (0.0, "")),
        finds: Cell::new(0),
        installs: Cell::new(0),
        rename_failures: match prop(&o, "renameFailures") {
            Some(JsonValue::Array(items)) => items
                .iter()
                .map(|v| as_str(Some(v)).map(str::to_owned))
                .collect(),
            _ => Vec::new(),
        },
        renames: Cell::new(0),
        fetcher: FakeFetcher {
            routes: prop(&o, "fetch")
                .cloned()
                .unwrap_or_else(|| JsonValue::Object(JsObject::new())),
            logs: logs.clone(),
        },
    };
    let options = McpRuntimeKitOptions {
        runtimes_root: as_str(prop(&o, "root")).unwrap_or_default().to_owned(),
        env: prop(&o, "env").map(|e| string_map(Some(e))),
        platform: as_str(prop(&o, "platform")).map(str::to_owned),
        arch: as_str(prop(&o, "arch")).map(str::to_owned),
        fallback_dirs: prop(&o, "fallbackDirs").map(|d| strings_of(Some(d))),
        pins: prop(&o, "pins").map(pins_of),
    };
    let kit = RuntimeKit::new(options, &world);
    let one = |command: &str, offer: bool| -> JsonValue {
        let resolution = kit.resolve_command(
            command,
            &ResolveOptions {
                offer_download: offer,
            },
        );
        if kit.take_lookup_failure() {
            object(vec![("rejected", JsonValue::Bool(true))])
        } else {
            resolution_json(&resolution)
        }
    };
    let mut results: Vec<JsonValue> = Vec::new();
    for step in &steps {
        match as_str(prop(step, "op")) {
            Some("resolve") => {
                let command = as_str(prop(step, "command")).unwrap_or_default();
                let offer = !matches!(prop(step, "offerDownload"), Some(JsonValue::Bool(false)));
                results.push(one(command, offer));
            }
            Some("resolveAll") => {
                let all = strings_of(prop(step, "commands"))
                    .iter()
                    .map(|command| one(command, true))
                    .collect();
                results.push(JsonValue::Array(all));
            }
            _ => {}
        }
    }
    let answer = object(vec![("results", JsonValue::Array(results))]);
    let lines = logs.borrow().clone();
    (out(answer), lines)
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "local.MCP_LOCAL_IDLE_MS" => out(JsonValue::Number(MCP_LOCAL_IDLE_MS)),
        "local.MCP_LOCAL_START_TIMEOUT_MS" => out(JsonValue::Number(MCP_LOCAL_START_TIMEOUT_MS)),
        "local.MCP_LOCAL_MAX_START_FAILURES" => {
            out(JsonValue::Number(MCP_LOCAL_MAX_START_FAILURES))
        }
        "local.MCP_STDERR_TAIL_LINES" => out(JsonValue::Number(MCP_STDERR_TAIL_LINES as f64)),
        "runtimes.MCP_RUNTIMES_DIR_NAME" => out(text(MCP_RUNTIMES_DIR_NAME)),
        "local.scenario" => {
            let (answer, lines) = local_scenario(args);
            cx.logs.extend(lines);
            answer
        }
        "runtimes.scenario" => {
            let (answer, lines) = kit_scenario(args);
            cx.logs.extend(lines);
            answer
        }
        "runtimes.mcpRuntimesRoot" => (|| out(text(mcp_runtimes_root(str_arg(args, 0)?))))(),
        "runtimes.runtimeInstallDir" => (|| {
            let root = str_arg(args, 0)?;
            let id = if str_arg(args, 1)? == "uv" {
                InstallId::Uv
            } else {
                InstallId::Node
            };
            out(text(runtime_install_dir(root, id, str_arg(args, 2)?)))
        })(),
        "runtimes.uvDataEnv" => (|| {
            let env = uv_data_env(str_arg(args, 0)?);
            out(object(vec![
                (
                    "UV_PYTHON_INSTALL_DIR",
                    text(env.uv_python_install_dir.as_str()),
                ),
                ("UV_CACHE_DIR", text(env.uv_cache_dir.as_str())),
            ]))
        })(),
        "runtimes.runtimeForCommand" => (|| {
            let found = runtime_for_command(str_arg(args, 0)?, str_arg(args, 1)?);
            out(found.map_or(JsonValue::Null, |id| text(id.as_str())))
        })(),
        "runtimes.findProgramOnPath" => (|| {
            let name = str_arg(args, 0)?;
            let o = json_arg(args, 1);
            let skip = |dir: &str| dir.to_lowercase().contains("windowsapps");
            let search = ProgramSearch {
                extensions: prop(&o, "extensions").map(|e| strings_of(Some(e))),
                skip_dir: if is_true(prop(&o, "skip")) {
                    Some(&skip)
                } else {
                    None
                },
                extra_dirs: strings_of(prop(&o, "extraDirs")),
            };
            out(opt_text(find_program_on_path(
                name,
                &lookup_options(&o),
                &search,
            )))
        })(),
        "runtimes.findPcNode" => {
            let found = find_pc_node(&lookup_options(&json_arg(args, 0)));
            out(found.map_or(JsonValue::Null, |n| {
                object(vec![
                    ("node", text(n.node.as_str())),
                    ("npmCli", opt_text(n.npm_cli)),
                    ("npxCli", opt_text(n.npx_cli)),
                ])
            }))
        }
        "runtimes.findPcUv" => {
            let found = find_pc_uv(&lookup_options(&json_arg(args, 0)));
            out(found.map_or(JsonValue::Null, |u| {
                object(vec![("uv", text(u.uv.as_str())), ("uvx", opt_text(u.uvx))])
            }))
        }
        "runtimes.findPcPython" => (|| {
            let command = str_arg(args, 0)?;
            out(opt_text(find_pc_python(
                command,
                &lookup_options(&json_arg(args, 1)),
            )))
        })(),
        _ => return None,
    })
}
