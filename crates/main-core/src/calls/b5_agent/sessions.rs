//! The functions of part `sessions` of group `b5-agent`
//! (tools/main-diff/groups/b5-agent-sessions.ts): the agent sessions of the
//! shell, their folders and the project skills, the runtime part of
//! `agent-api.ts`, `skill-mcp-refs.ts` and the small agent-session pieces of
//! `packages/ai-provider`.
//!
//! The manager runs against a scenario host: what the TypeScript's `deps`
//! fakes do, this host does, and each call of it is one `logs` line written
//! as the TypeScript fake writes it. The scenario plays the part of the
//! adapter: it drives the manager's steps, the removal of a folder that ends
//! later, the questions of the relays and the program's events.

use std::cell::RefCell;
use std::fs;
use std::rc::Rc;

use jscompat::node_path::host::{dirname, join};
use jscompat::{JsonValue, js_regex, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value};

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::agent_core::skill_mcp_refs::{
    IsUsable, SKILL_SKIPPED_STEPS_SENTENCE, UsableThrew, mcp_server_list_of,
    mcp_server_unusable_line, mcp_servers_in_allowed_tools, mcp_servers_in_text,
    mcp_servers_of_skill, skill_steps_note, unusable_mcp_servers,
};
use crate::packages::ai_provider::agent_session_program_problem::{
    AgentProgramError, AgentProgramProblem,
};
use crate::packages::ai_provider::agent_session_skills::AGENT_SKILL_PLUGIN_NAME;
use crate::shell::agent::agent_api::{
    AGENT_BLOCKED_PROVIDERS, AGENT_CHANNELS, AGENT_CODEX_WEB_SEARCH, AGENT_MODES, AGENT_PROVIDERS,
    AGENT_RECENT_LIMIT, AGENT_RUN_ERROR_KINDS, AGENT_WARNING_VERSION, AgentPrefs, AgentPrepareStep,
    AgentStartFailure, agent_project_prefs_patch, agent_start_failure_code, default_agent_prefs,
    default_agent_project_prefs, normalize_agent_prefs, with_recent_folder,
};
use crate::shell::agent::agent_session_folders::{
    ExecRequest, FolderHost, SweepOptions, make_agent_session_folder, sweep_agent_session_folders,
};
use crate::shell::agent::agent_sessions::{
    AgentHost, AgentManager, AgentMcpRelay, AgentMcpSession, AgentPermissionAnswer, AgentSendStep,
    AgentSessionHandle, AgentSkillBundle, AgentStartAnswer, AgentStartCall, AgentStartJob,
    AgentStartRequest, AgentStartResult, AgentStartStep, AppMcp, CodexChoices, McpRelays,
    RelayAnswer, RelayAsk, RelayAskRequest, RemoveOptions, RunnerError, StartError, Stoppable,
    agent_instructions, agent_instructions_and_cuts, agent_protected_paths, agent_start_failed,
    codex_skill_instructions, openable_project_file, project_folder_problem, relay_input_preview,
};
use crate::shell::agent::agent_skills::AgentSkillEntry;
use crate::shell::agent::project_skills::{
    PROJECT_SKILLS_KEY, ProjectSkillLike, approved_fingerprint, project_skills_allowed,
    project_skills_fingerprint, project_skills_of, project_skills_view, set_project_skills,
    write_project_skills_approval,
};
use crate::shell::crash_log::Thrown;

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

fn text(x: &str) -> Value {
    Value::from(x)
}

fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn strings(items: &[String]) -> Value {
    Value::Array(items.iter().map(|item| text(item)).collect())
}

fn json(value: &JsonValue) -> Value {
    json_value_to_serde(value)
}

fn jsv(value: &Value) -> JsonValue {
    json_value_from_serde(value)
}

fn ok(value: Value) -> Answer {
    Ok(Some(value))
}

fn field_str(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn field_opt_str(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn field_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn field_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// the strings of a list; what is not a string is left out
fn str_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn list(value: Option<&Value>) -> &[Value] {
    match value.and_then(Value::as_array) {
        Some(items) => items.as_slice(),
        None => &[],
    }
}

/// `typeof` of a thrown JSON value
fn typeof_of(value: &Value) -> &'static str {
    match value {
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        _ => "object",
    }
}

/// `string | readonly string[] | undefined` of `allowed-tools`: `null` is `undefined`
fn allowed_tools(value: Option<&Value>) -> Option<Vec<String>> {
    match value {
        Some(Value::String(text)) => Some(vec![text.clone()]),
        Some(Value::Array(_)) => Some(str_list(value)),
        _ => None,
    }
}

/// `isUsable` of a case: the names it answers true for, and the names it throws on
type Usable = Box<dyn Fn(&str) -> Result<bool, UsableThrew>>;

fn usable_of(spec: Option<&Value>) -> Option<Usable> {
    let spec = spec.filter(|spec| !spec.is_null())?;
    let usable = str_list(spec.get("usable"));
    let throws = str_list(spec.get("throws"));
    Some(Box::new(move |name| {
        if throws.iter().any(|known| known == name) {
            Err(UsableThrew)
        } else {
            Ok(usable.iter().any(|known| known == name))
        }
    }))
}

fn problem_of(value: Option<&Value>) -> Result<AgentProgramProblem, CallError> {
    let value = value.ok_or_else(|| CallError::plain("no problem"))?;
    let step = field_str(value, "step");
    Ok(match value.get("type").and_then(Value::as_str) {
        Some("unsupported-path") => AgentProgramProblem::UnsupportedPath,
        Some("exited") => AgentProgramProblem::Exited {
            exit_code: field_f64(value, "exitCode"),
        },
        Some("no-answer") => AgentProgramProblem::NoAnswer { step },
        Some("refused") => AgentProgramProblem::Refused {
            step,
            code: field_f64(value, "code"),
        },
        Some("no-model") => AgentProgramProblem::NoModel,
        _ => return Err(CallError::plain("no such problem")),
    })
}

fn prepare_step_of(name: &str) -> Result<AgentPrepareStep, CallError> {
    Ok(match name {
        "session-folder" => AgentPrepareStep::SessionFolder,
        "app-tools" => AgentPrepareStep::AppTools,
        "user-mcp" => AgentPrepareStep::UserMcp,
        "skills" => AgentPrepareStep::Skills,
        "instructions" => AgentPrepareStep::Instructions,
        _ => return Err(CallError::plain("no such step")),
    })
}

fn failure_of(value: Option<&Value>) -> Result<AgentStartFailure, CallError> {
    let value = value.ok_or_else(|| CallError::plain("no failure"))?;
    Ok(match value.get("reason").and_then(Value::as_str) {
        Some("bad-folder") => AgentStartFailure::BadFolder,
        Some("not-connected") => AgentStartFailure::NotConnected,
        Some("not-accepted") => AgentStartFailure::NotAccepted,
        Some("provider-blocked") => AgentStartFailure::ProviderBlocked,
        Some("invalid-request") => AgentStartFailure::InvalidRequest,
        Some("stopped") => AgentStartFailure::Stopped,
        Some("unknown") => AgentStartFailure::Unknown,
        Some("run-error") => AgentStartFailure::RunError {
            kind: field_str(value, "kind"),
        },
        Some("prepare-failed") => AgentStartFailure::PrepareFailed {
            step: prepare_step_of(&field_str(value, "step"))?,
        },
        Some("program-problem") => AgentStartFailure::ProgramProblem {
            problem: problem_of(value.get("problem"))?,
        },
        _ => return Err(CallError::plain("no such failure")),
    })
}

fn prefs_of(value: Option<&Value>) -> AgentPrefs {
    let value = value.cloned().unwrap_or(Value::Null);
    AgentPrefs {
        provider: field_str(&value, "provider"),
        mode: field_str(&value, "mode"),
        recent_folders: str_list(value.get("recentFolders")),
        warning_accepted: field_f64(&value, "warningAccepted").unwrap_or(0.0),
    }
}

fn skill_like_of(value: &Value) -> ProjectSkillLike {
    ProjectSkillLike {
        id: field_str(value, "id"),
        name: field_str(value, "name"),
        title: field_str(value, "title"),
        description: field_str(value, "description"),
        dir: field_str(value, "dir"),
        source: field_str(value, "source"),
    }
}

fn skills_like(value: Option<&Value>) -> Vec<ProjectSkillLike> {
    list(value).iter().map(skill_like_of).collect()
}

fn skill_like_json(skill: &ProjectSkillLike) -> Value {
    let mut object = Map::new();
    object.insert("id".into(), text(&skill.id));
    object.insert("name".into(), text(&skill.name));
    object.insert("title".into(), text(&skill.title));
    object.insert("description".into(), text(&skill.description));
    object.insert("dir".into(), text(&skill.dir));
    object.insert("source".into(), text(&skill.source));
    Value::Object(object)
}

fn skill_entry_of(value: &Value) -> AgentSkillEntry {
    AgentSkillEntry {
        id: field_str(value, "id"),
        name: field_str(value, "name"),
        source: field_str(value, "source"),
        plugin: field_opt_str(value, "plugin"),
        title: field_str(value, "title"),
        description: field_str(value, "description"),
        invoke: field_str(value, "invoke"),
        skill_md: field_str(value, "skillMd"),
    }
}

fn skill_entries(value: Option<&Value>) -> Vec<AgentSkillEntry> {
    list(value).iter().map(skill_entry_of).collect()
}

fn skill_entry_json(entry: &AgentSkillEntry) -> Value {
    let mut object = Map::new();
    object.insert("id".into(), text(&entry.id));
    object.insert("name".into(), text(&entry.name));
    object.insert("source".into(), text(&entry.source));
    if let Some(plugin) = &entry.plugin {
        object.insert("plugin".into(), text(plugin));
    }
    object.insert("title".into(), text(&entry.title));
    object.insert("description".into(), text(&entry.description));
    object.insert("invoke".into(), text(&entry.invoke));
    object.insert("skillMd".into(), text(&entry.skill_md));
    Value::Object(object)
}

/// a session folder's random letters, in a text
fn mask_rand(value: &str) -> String {
    js_regex!(r"ieum-agent-[A-Za-z0-9]{6}", "g")
        .replace_all(value, |_| "ieum-agent-<rand>".to_owned())
}

fn mask_deep(value: &Value) -> Value {
    match value {
        Value::String(value) => Value::String(mask_rand(value)),
        Value::Array(items) => Value::Array(items.iter().map(mask_deep).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .map(|(key, value)| (key.clone(), mask_deep(value)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `process.platform`
fn process_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn random_letters() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    (0..6)
        .map(|_| {
            let at = (jscompat::math_random() * CHARS.len() as f64) as usize;
            char::from(CHARS[at.min(CHARS.len() - 1)])
        })
        .collect()
}

/// `WINDOWS_ROOT_PATTERN` of `subscription/process.ts` as the fake system reads it: a drive, then
/// one or more `\` and a name, and at most one `\` at the end; a name holds none of
/// `/ : * ? " < > | %` or a line break. (The function itself is ported with the MCP part; the
/// scenario's fake machine only needs its answer for the few environments the cases give.)
fn is_windows_root(value: &str) -> bool {
    let mut chars = value.chars();
    let (Some(drive), Some(':')) = (chars.next(), chars.next()) else {
        return false;
    };
    if !drive.is_ascii_alphabetic() {
        return false;
    }
    let rest = chars.as_str();
    let rest = rest.strip_suffix('\\').unwrap_or(rest);
    let Some(names) = rest.strip_prefix('\\') else {
        return false;
    };
    !names.is_empty()
        && names.split('\\').all(|name| {
            !name.is_empty()
                && !name.contains(['/', ':', '*', '?', '"', '<', '>', '|', '%', '\r', '\n'])
        })
}

/// `windowsSystemDir(env)` of the fake machine
fn fake_windows_dir(env: &Value) -> String {
    let root = ["SystemRoot", "SYSTEMROOT", "windir"]
        .iter()
        .filter_map(|name| env.get(*name).and_then(Value::as_str))
        .find(|value| is_windows_root(value))
        .unwrap_or("C:\\Windows");
    jscompat::node_path::win32::join(&[root, "System32"])
}

// ---- the folders ----

/// the machine `makeAgentSessionFolder` and `sweepAgentSessionFolders` run on
struct FolderMachine<'a> {
    log: &'a RefCell<Vec<Vec<Value>>>,
    tmp: String,
    now_ms: f64,
    pid: f64,
    uptime: f64,
    platform: String,
    env: Value,
    kill_alive: Vec<f64>,
    kill_eperm: Vec<f64>,
    exec: Option<String>,
}

impl FolderHost for FolderMachine<'_> {
    fn tmpdir(&self) -> String {
        self.tmp.clone()
    }

    fn now_ms(&self) -> f64 {
        self.now_ms
    }

    fn pid(&self) -> f64 {
        self.pid
    }

    fn uptime_secs(&self) -> f64 {
        self.uptime
    }

    fn platform(&self) -> String {
        self.platform.clone()
    }

    fn windows_system_dir(&self) -> String {
        fake_windows_dir(&self.env)
    }

    fn windows_system_tool(&self, segments: &[&str]) -> String {
        let dir = fake_windows_dir(&self.env);
        let mut parts: Vec<&str> = vec![&dir];
        parts.extend_from_slice(segments);
        jscompat::node_path::win32::join(&parts)
    }

    fn random_suffix(&mut self) -> String {
        random_letters()
    }

    fn process_alive(&mut self, pid: f64) -> bool {
        self.kill_alive.contains(&pid) || self.kill_eperm.contains(&pid)
    }

    fn exec_file(&mut self, request: &ExecRequest) -> String {
        let mut options = Map::new();
        if let Some(cwd) = &request.cwd {
            options.insert("cwd".into(), text(cwd));
        }
        options.insert("timeout".into(), num(f64::from(request.timeout_ms)));
        options.insert("windowsHide".into(), Value::Bool(true));
        options.insert("maxBuffer".into(), num(f64::from(request.max_buffer)));
        self.log.borrow_mut().push(vec![
            text("exec"),
            text(&request.file),
            strings(&request.args),
            Value::Object(options),
        ]);
        self.exec.clone().unwrap_or_default()
    }
}

fn machine<'a>(o: &Value, log: &'a RefCell<Vec<Vec<Value>>>, now_ms: f64) -> FolderMachine<'a> {
    let kill = o.get("kill").cloned().unwrap_or(Value::Null);
    let numbers = |key: &str| -> Vec<f64> {
        list(kill.get(key))
            .iter()
            .filter_map(Value::as_f64)
            .collect()
    };
    FolderMachine {
        log,
        tmp: field_str(o, "tmp"),
        now_ms,
        pid: field_f64(o, "pid").unwrap_or(0.0),
        uptime: field_f64(o, "uptime").unwrap_or(0.0),
        platform: field_str(o, "platform"),
        env: o.get("env").cloned().unwrap_or(Value::Null),
        kill_alive: numbers("alive"),
        kill_eperm: numbers("eperm"),
        exec: field_opt_str(o, "exec"),
    }
}

fn make_folder_call(args: &[Value], cx: &mut Context) -> Answer {
    let o = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = RefCell::new(Vec::new());
    let mut host = machine(&o, &log, cx.now_ms);
    let parent = field_opt_str(&o, "parent");
    let dir = make_agent_session_folder(&mut host, parent.as_deref()).map_err(|error| {
        let mut failed = CallError::from(error);
        // the system names the letters it tried; Node on Linux names the template
        failed.message = mask_rand(&failed.message);
        failed
    })?;
    let owner = fs::read_to_string(join(&[&dir, "owner.json"]))
        .map_err(|error| CallError::plain(format!("the mark is not there: {error}")))?;
    fs::rename(&dir, join(&[&dirname(&dir), "ieum-agent-FIXED1"]))
        .map_err(|error| CallError::plain(format!("rename: {error}")))?;
    let mut out = Map::new();
    out.insert("dir".into(), text(&mask_rand(&dir)));
    out.insert("owner".into(), text(&owner));
    ok(Value::Object(out))
}

fn sweep_call(args: &[Value], cx: &mut Context) -> Answer {
    let o = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = RefCell::new(Vec::new());
    let mut host = machine(&o, &log, cx.now_ms);
    let alive_list: Option<Vec<f64>> = o
        .get("alive")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_f64).collect());
    let times_list: Option<Vec<(f64, f64)>> =
        o.get("startTimes").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(|pair| {
                    let pair = pair.as_array()?;
                    Some((pair.first()?.as_f64()?, pair.get(1)?.as_f64()?))
                })
                .collect()
        });
    let alive_fn = |pid: f64| -> bool {
        log.borrow_mut().push(vec![text("alive"), num(pid)]);
        alive_list
            .as_ref()
            .is_some_and(|known| known.contains(&pid))
    };
    let times_fn = |pids: &[f64]| -> Vec<(f64, f64)> {
        log.borrow_mut().push(vec![
            text("startTimes"),
            Value::Array(pids.iter().map(|pid| num(*pid)).collect()),
        ]);
        times_list.clone().unwrap_or_default()
    };
    let options = SweepOptions {
        parent: field_opt_str(&o, "parent"),
        now: field_f64(&o, "now"),
        alive: alive_list
            .as_ref()
            .map(|_| &alive_fn as &dyn Fn(f64) -> bool),
        start_times: times_list
            .as_ref()
            .map(|_| &times_fn as &dyn Fn(&[f64]) -> Vec<(f64, f64)>),
    };
    sweep_agent_session_folders(&mut host, &options);
    cx.logs.extend(log.take());
    Ok(None)
}

// ---- the manager ----

/// `Stoppable` that logs its stop
struct LogStop {
    log: Log,
    label: &'static str,
}

impl Stoppable for LogStop {
    fn stop(&mut self) {
        self.log.borrow_mut().push(vec![text(self.label)]);
    }
}

/// the program a scenario's runner gives
struct FakeSession {
    provider: String,
    log: Log,
}

impl AgentSessionHandle for FakeSession {
    fn send(&mut self, message: &str) {
        self.log.borrow_mut().push(vec![
            text("session.send"),
            text(&self.provider),
            text(message),
        ]);
    }

    fn answer(&mut self, id: &str, answer: &AgentPermissionAnswer) {
        self.log.borrow_mut().push(vec![
            text("session.answer"),
            text(&self.provider),
            text(id),
            json(&answer.to_json()),
        ]);
    }

    fn set_open_documents(&mut self, paths: &[String]) {
        self.log.borrow_mut().push(vec![
            text("session.setOpenDocuments"),
            text(&self.provider),
            strings(paths),
        ]);
    }

    fn stop(&mut self) {
        self.log
            .borrow_mut()
            .push(vec![text("session.stop"), text(&self.provider)]);
    }
}

/// a question of a relay a step asked
struct AskInfo {
    session: String,
    id: Option<String>,
}

/// the fakes of one scenario
struct Scenario<'a> {
    o: &'a Value,
    log: Log,
    now_ms: f64,
    settings: JsonValue,
    statuses: JsonValue,
    open_documents: Vec<String>,
    uuids: u32,
    /// the owner and the session of each runner call, in order
    runner_calls: Vec<(i64, String)>,
    /// what each program's `send` answers, by session: the message of the rejection, if any
    send_errors: Vec<(String, Option<String>)>,
    /// a start whose program is still starting: its job and the answer the runner will give
    held: Option<(AgentStartJob, AgentStartAnswer)>,
    asks: Vec<AskInfo>,
    /// what the promises settled in a step log once the step is over
    deferred: Vec<Vec<Value>>,
    /// removals that wait for `finishRm`
    slow: Vec<String>,
    /// removals done at once whose end the manager is told when the step is over
    fast: Vec<String>,
}

impl Scenario<'_> {
    fn line(&self, line: Vec<Value>) {
        self.log
            .borrow_mut()
            .push(line.iter().map(mask_deep).collect());
    }

    /// the throwable a descriptor says
    fn thrown(descriptor: &Value) -> Box<Thrown> {
        Box::new(match descriptor.get("class").and_then(Value::as_str) {
            Some("program") => Thrown::Error {
                name: Some(JsonValue::String(AgentProgramError::NAME.to_owned())),
                code: None,
            },
            Some("value") => {
                Thrown::Other(typeof_of(descriptor.get("value").unwrap_or(&Value::Null)))
            }
            _ => Thrown::Error {
                name: Some(JsonValue::String(
                    field_opt_str(descriptor, "name").unwrap_or_else(|| "Error".to_owned()),
                )),
                code: field_opt_str(descriptor, "code").map(JsonValue::String),
            },
        })
    }

    fn runner_error(descriptor: &Value) -> RunnerError {
        match descriptor.get("class").and_then(Value::as_str) {
            Some("program") => RunnerError::Program(AgentProgramError::new(
                problem_of(descriptor.get("problem")).unwrap_or(AgentProgramProblem::NoModel),
                field_str(descriptor, "message"),
            )),
            Some("value") => RunnerError::Other {
                kind: descriptor
                    .get("value")
                    .and_then(|value| value.get("kind"))
                    .map(jsv),
                thrown: Self::thrown(descriptor),
            },
            _ => RunnerError::Other {
                kind: descriptor.get("kind").map(jsv),
                thrown: Self::thrown(descriptor),
            },
        }
    }

    /// the `removeOptions` object the TypeScript passes
    fn remove_options_json(options: &RemoveOptions) -> Value {
        let mut object = Map::new();
        object.insert("recursive".into(), Value::Bool(true));
        object.insert("force".into(), Value::Bool(true));
        object.insert("maxRetries".into(), num(f64::from(options.max_retries)));
        object.insert("retryDelay".into(), num(f64::from(options.retry_delay_ms)));
        Value::Object(object)
    }

    /// the removal itself, which the fake `rm` and `rmSync` carry out for real
    fn really_remove(dir: &str) {
        let _ = crate::markdown::fs_util::rm_recursive_force(dir);
    }

    fn mode(&self, key: &str) -> String {
        field_str(self.o, key)
    }

    /// What happens while an awaited call runs: the case's `during` table for `step`, run
    /// against the manager as the TypeScript's fakes do from inside the call. `event` is the
    /// program the call is starting, which only the runner's `onEvent` reaches
    fn during(&mut self, manager: &mut AgentManager, step: &str, event: Option<&(i64, String)>) {
        let o = self.o;
        for op in list(o.get("during").and_then(|during| during.get(step))) {
            match field_str(op, "op").as_str() {
                "stop" => manager.stop(
                    self,
                    field_f64(op, "owner").unwrap_or(0.0) as i64,
                    &field_str(op, "session"),
                ),
                "stopOwner" => {
                    manager.stop_owner(self, field_f64(op, "owner").unwrap_or(0.0) as i64);
                }
                "stopAll" => manager.stop_all(self),
                "event" => {
                    if let Some((owner_id, session_id)) = event {
                        let event = jsv(op.get("event").unwrap_or(&Value::Null));
                        manager.on_event(self, *owner_id, session_id, &event);
                    }
                }
                "setSettings" => self.settings = jsv(op.get("settings").unwrap_or(&Value::Null)),
                "setStatuses" => self.statuses = jsv(op.get("statuses").unwrap_or(&Value::Null)),
                _ => {}
            }
        }
    }

    /// a runner call: logged, then its program or its failure; whether the case holds the
    /// program back (`hold`) until a `release` step
    fn run(
        &mut self,
        manager: &mut AgentManager,
        key: &str,
        provider: &str,
        logged: Value,
        session: &AgentMcpSession,
    ) -> (AgentStartAnswer, bool) {
        self.line(vec![text(key), logged]);
        let target = (session.owner_id, session.session_id.clone());
        self.runner_calls.push(target.clone());
        self.during(manager, "runner", Some(&target));
        let spec = self
            .o
            .get("runner")
            .and_then(|runner| runner.get(key))
            .cloned()
            .unwrap_or(Value::Null);
        if let Some(settings) = spec.get("setSettings") {
            self.settings = jsv(settings);
        }
        let hold = field_bool(&spec, "hold");
        let ran: Result<Box<dyn AgentSessionHandle>, RunnerError> = match spec.get("throw") {
            Some(descriptor) => Err(Self::runner_error(descriptor)),
            None => {
                self.send_errors.push((
                    session.session_id.clone(),
                    field_opt_str(&spec, "sendError"),
                ));
                Ok(Box::new(FakeSession {
                    provider: provider.to_owned(),
                    log: self.log.clone(),
                }))
            }
        };
        (AgentStartAnswer::Run(ran), hold)
    }

    /// Carries out an awaited call of a start the way the TypeScript's fakes do, and gives the
    /// answer (with whether the program is held back)
    fn perform(
        &mut self,
        manager: &mut AgentManager,
        call: AgentStartCall,
    ) -> (AgentStartAnswer, bool) {
        match call {
            AgentStartCall::SessionFolder => (
                AgentStartAnswer::SessionFolder(make_agent_session_folder(self, None)),
                false,
            ),
            AgentStartCall::AppMcp {
                project_root,
                session,
            } => {
                let spec = self.o.get("appMcp").cloned().unwrap_or(Value::Null);
                self.line(vec![
                    text("startAppMcp"),
                    text(&project_root),
                    session_json(&session),
                ]);
                self.during(manager, "app-tools", None);
                let started = match spec.get("throw") {
                    Some(descriptor) => Err(Self::thrown(descriptor)),
                    None => Ok(AppMcp {
                        url: field_str(&spec, "url"),
                        token: field_str(&spec, "token"),
                        server: Box::new(LogStop {
                            log: self.log.clone(),
                            label: "appMcp.stop",
                        }),
                    }),
                };
                (AgentStartAnswer::AppMcp(started), false)
            }
            AgentStartCall::Relays { session } => {
                let spec = self.o.get("relays").cloned().unwrap_or(Value::Null);
                self.line(vec![text("startRelays"), session_json(&session)]);
                self.during(manager, "user-mcp", None);
                let started = match spec.get("throw") {
                    Some(descriptor) => Err(Self::thrown(descriptor)),
                    None => Ok(McpRelays {
                        relays: list(spec.get("relays"))
                            .iter()
                            .map(|relay| AgentMcpRelay {
                                name: field_str(relay, "name"),
                                url: field_str(relay, "url"),
                                token: field_str(relay, "token"),
                                tools: str_list(relay.get("tools")),
                            })
                            .collect(),
                        keep_results_inside: str_list(spec.get("keepResultsInside")),
                        handle: Box::new(LogStop {
                            log: self.log.clone(),
                            label: "relays.stop",
                        }),
                    }),
                };
                (AgentStartAnswer::Relays(started), false)
            }
            AgentStartCall::BuildSkills { project_root } => {
                let spec = self.o.get("buildSkills").cloned().unwrap_or(Value::Null);
                self.line(vec![text("buildSkills"), text(&project_root)]);
                self.during(manager, "skills", None);
                let built = match spec.get("throw") {
                    Some(descriptor) => Err(Self::thrown(descriptor)),
                    None => Ok(match spec.get("bundle") {
                        Some(bundle) if bundle.is_object() => Some(AgentSkillBundle {
                            dir: field_str(bundle, "dir"),
                            skills: skill_entries(bundle.get("skills")),
                        }),
                        _ => None,
                    }),
                };
                (AgentStartAnswer::BuildSkills(built), false)
            }
            AgentStartCall::RunClaude { options, session } => self.run(
                manager,
                "claude",
                "claude-code",
                json(&options.to_json()),
                &session,
            ),
            AgentStartCall::RunCodex {
                options,
                codex,
                session,
            } => self.run(
                manager,
                "codex",
                "codex",
                json(&codex.merged_json(&options)),
                &session,
            ),
        }
    }

    /// what the program of `session` answers to the message it was just given
    fn send_answer(&self, session: &str) -> Result<(), String> {
        match self
            .send_errors
            .iter()
            .rev()
            .find(|(known, _)| known == session)
            .and_then(|(_, error)| error.clone())
        {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

fn session_json(session: &AgentMcpSession) -> Value {
    let mut object = Map::new();
    object.insert("ownerId".into(), num(session.owner_id as f64));
    object.insert("sessionId".into(), text(&session.session_id));
    Value::Object(object)
}

impl FolderHost for Scenario<'_> {
    fn tmpdir(&self) -> String {
        field_str(self.o, "tmp")
    }

    fn now_ms(&self) -> f64 {
        self.now_ms
    }

    fn pid(&self) -> f64 {
        4242.0
    }

    fn uptime_secs(&self) -> f64 {
        0.0
    }

    fn platform(&self) -> String {
        process_platform().to_owned()
    }

    fn windows_system_dir(&self) -> String {
        String::new()
    }

    fn windows_system_tool(&self, _segments: &[&str]) -> String {
        String::new()
    }

    fn random_suffix(&mut self) -> String {
        random_letters()
    }

    fn process_alive(&mut self, _pid: f64) -> bool {
        false
    }

    fn exec_file(&mut self, _request: &ExecRequest) -> String {
        String::new()
    }
}

impl AgentHost for Scenario<'_> {
    fn statuses(&mut self) -> JsonValue {
        self.statuses.clone()
    }

    fn ai_settings(&mut self) -> JsonValue {
        self.settings.clone()
    }

    fn open_documents(&mut self) -> Vec<String> {
        self.open_documents.clone()
    }

    fn language(&mut self) -> String {
        field_str(self.o, "language")
    }

    fn random_uuid(&mut self) -> String {
        self.uuids += 1;
        format!("uuid-{}", self.uuids)
    }

    fn emit(&mut self, owner_id: i64, session_id: &str, event: &JsonValue) {
        self.line(vec![
            text("emit"),
            num(owner_id as f64),
            text(session_id),
            json(event),
        ]);
    }

    fn has_app_mcp(&self) -> bool {
        matches!(self.o.get("appMcp"), Some(spec) if !spec.is_null())
    }

    fn has_relays(&self) -> bool {
        matches!(self.o.get("relays"), Some(spec) if !spec.is_null())
    }

    fn has_build_skills(&self) -> bool {
        matches!(self.o.get("buildSkills"), Some(spec) if !spec.is_null())
    }

    fn remove_folder(&mut self, dir: &str, options: &RemoveOptions) {
        self.line(vec![
            text("rm"),
            text(dir),
            Self::remove_options_json(options),
        ]);
        match self.mode("rm").as_str() {
            "slow" => self.slow.push(dir.to_owned()),
            "fail" => {}
            _ => {
                Self::really_remove(dir);
                self.fast.push(dir.to_owned());
            }
        }
    }

    fn remove_folder_sync(&mut self, dir: &str, options: &RemoveOptions) -> bool {
        self.line(vec![
            text("rmSync"),
            text(dir),
            Self::remove_options_json(options),
        ]);
        if self.mode("rmSync") == "fail" {
            return false;
        }
        Self::really_remove(dir);
        true
    }

    fn relay_settled(&mut self, ask_id: &str, answer: &RelayAnswer) {
        if let Some(index) = self
            .asks
            .iter()
            .position(|ask| ask.id.as_deref() == Some(ask_id))
        {
            self.deferred.push(vec![
                text("relay.answer"),
                num(index as f64),
                json(&answer.to_json()),
            ]);
        }
    }
}

fn request_of(value: &Value) -> AgentStartRequest {
    AgentStartRequest {
        provider: field_str(value, "provider"),
        project_root: field_str(value, "projectRoot"),
        mode: field_str(value, "mode"),
        codex: value.get("codex").map(|codex| CodexChoices {
            web_search: field_str(codex, "webSearch"),
            network: field_bool(codex, "network"),
        }),
    }
}

fn answer_of(value: Option<&Value>) -> AgentPermissionAnswer {
    let value = value.cloned().unwrap_or(Value::Null);
    AgentPermissionAnswer {
        allow: field_bool(&value, "allow"),
        scope: field_opt_str(&value, "scope"),
        message: field_opt_str(&value, "message"),
    }
}

/// Runs the steps of a start: the scenario carries out each awaited call and answers it. With
/// `detach`, a program the case holds back ends the run: its job waits in the scenario for
/// `release`, and there is no result yet.
fn drive_start(
    manager: &mut AgentManager,
    fake: &mut Scenario<'_>,
    mut step: AgentStartStep,
    detach: bool,
) -> Option<AgentStartResult> {
    loop {
        match step {
            AgentStartStep::Done(result) => return Some(result),
            AgentStartStep::Await { call, job } => {
                let (answer, hold) = fake.perform(manager, call);
                if hold && detach {
                    fake.held = Some((job, answer));
                    return None;
                }
                step = job.resume(manager, fake, answer);
            }
        }
    }
}

fn manager_call(args: &[Value], cx: &mut Context) -> Answer {
    let o = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let mut fake = Scenario {
        o: &o,
        log: log.clone(),
        now_ms: cx.now_ms,
        settings: jsv(o.get("settings").unwrap_or(&Value::Null)),
        statuses: jsv(o.get("statuses").unwrap_or(&Value::Null)),
        open_documents: str_list(o.get("openDocuments")),
        uuids: 0,
        runner_calls: Vec::new(),
        send_errors: Vec::new(),
        held: None,
        asks: Vec::new(),
        deferred: Vec::new(),
        slow: Vec::new(),
        fast: Vec::new(),
    };
    let mut manager = AgentManager::new(
        &field_str(&o, "userData"),
        &field_str(&o, "homeDir"),
        &field_str(&o, "platform"),
    );
    let mut out: Vec<Value> = Vec::new();
    for step in list(o.get("steps")) {
        let op = field_str(step, "op");
        let owner = field_f64(step, "owner").unwrap_or(0.0) as i64;
        let session = field_str(step, "session");
        let mut entry = Map::new();
        entry.insert("op".into(), text(&op));
        match op.as_str() {
            "start" => {
                let request = request_of(step.get("request").unwrap_or(&Value::Null));
                let first = manager.start_begin(&mut fake, owner, &request);
                let detach = field_bool(step, "detach");
                if let Some(result) = drive_start(&mut manager, &mut fake, first, detach) {
                    entry.insert("result".into(), json(&result.to_json()));
                }
            }
            "release" => {
                if let Some((job, answer)) = fake.held.take() {
                    let next = job.resume(&mut manager, &mut fake, answer);
                    if let Some(result) = drive_start(&mut manager, &mut fake, next, false) {
                        entry.insert("result".into(), json(&result.to_json()));
                    }
                }
            }
            "send" => {
                let message = field_str(step, "text");
                let sent = match manager.send_begin(&mut fake, owner, &session, &message) {
                    AgentSendStep::Done(done) => done,
                    AgentSendStep::Await { call, job } => {
                        job.resume(fake.send_answer(&call.session_id))
                    }
                };
                if let Err(error) = sent {
                    entry.insert("error".into(), text(&error));
                }
            }
            "answer" => {
                let answer = answer_of(step.get("answer"));
                manager.answer(
                    &mut fake,
                    owner,
                    &session,
                    &field_str(step, "request"),
                    &answer,
                );
            }
            "stop" => manager.stop(&mut fake, owner, &session),
            "stopOwner" => manager.stop_owner(&mut fake, owner),
            "stopAll" => manager.stop_all(&mut fake),
            "projectRootOf" => {
                if let Some(root) = manager.project_root_of(owner, &session) {
                    entry.insert("value".into(), text(&root));
                }
            }
            "skillsOf" => {
                let skills = manager.skills_of(owner, &session);
                entry.insert(
                    "value".into(),
                    Value::Array(skills.iter().map(skill_entry_json).collect()),
                );
            }
            "event" => {
                let index = field_f64(step, "runner").unwrap_or(0.0) as usize;
                let Some((runner_owner, runner_session)) = fake.runner_calls.get(index).cloned()
                else {
                    return Err(CallError::plain("no such runner call"));
                };
                let event = jsv(step.get("event").unwrap_or(&Value::Null));
                manager.on_event(&mut fake, runner_owner, &runner_session, &event);
            }
            "relayAsk" => {
                let request = step.get("request").unwrap_or(&Value::Null);
                let request = RelayAskRequest {
                    exposed_name: field_str(request, "exposedName"),
                    server: field_str(request, "server"),
                    input: jsv(request.get("input").unwrap_or(&Value::Null)),
                };
                let index = fake.asks.len();
                match manager.relay_ask(&mut fake, &session, &request, field_bool(step, "aborted"))
                {
                    RelayAsk::Settled(answer) => {
                        fake.asks.push(AskInfo { session, id: None });
                        fake.deferred.push(vec![
                            text("relay.answer"),
                            num(index as f64),
                            json(&answer.to_json()),
                        ]);
                    }
                    RelayAsk::Pending(id) => fake.asks.push(AskInfo {
                        session,
                        id: Some(id),
                    }),
                }
                entry.insert("ask".into(), num(index as f64));
            }
            "abortAsk" => {
                let index = field_f64(step, "ask").unwrap_or(0.0) as usize;
                let pending = fake
                    .asks
                    .get(index)
                    .and_then(|ask| ask.id.clone().map(|id| (ask.session.clone(), id)));
                if let Some((ask_session, id)) = pending {
                    manager.relay_ask_aborted(&mut fake, &ask_session, &id);
                }
            }
            "finishRm" => {
                for dir in std::mem::take(&mut fake.slow) {
                    Scenario::really_remove(&dir);
                    manager.folder_removed(&dir);
                }
            }
            "setOpenDocuments" => fake.open_documents = str_list(step.get("paths")),
            "setSettings" => fake.settings = jsv(step.get("settings").unwrap_or(&Value::Null)),
            "setStatuses" => fake.statuses = jsv(step.get("statuses").unwrap_or(&Value::Null)),
            other => return Err(CallError::plain(format!("no such step: {other}"))),
        }
        // the step is over: the removals that ended, and what the promises settled
        for dir in std::mem::take(&mut fake.fast) {
            manager.folder_removed(&dir);
        }
        for line in std::mem::take(&mut fake.deferred) {
            fake.line(line);
        }
        out.push(Value::Object(entry));
    }
    let tmp = field_str(&o, "tmp");
    let mut left: Vec<String> = fs::read_dir(&tmp)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| mask_rand(&entry.file_name().to_string_lossy()))
                .collect()
        })
        .unwrap_or_default();
    left.sort();
    let _ = fs::remove_dir_all(&tmp);
    cx.logs.extend(log.borrow_mut().drain(..));
    let mut result = Map::new();
    result.insert("steps".into(), mask_deep(&Value::Array(out)));
    result.insert("left".into(), strings(&left));
    ok(Value::Object(result))
}

// ---- the pure functions ----

fn agent_error_call(args: &[Value]) -> Answer {
    let descriptor = arg(args, 0).cloned().unwrap_or(Value::Null);
    let error = match descriptor.get("class").and_then(Value::as_str) {
        Some("program") => StartError::Program(AgentProgramError::new(
            problem_of(descriptor.get("problem"))?,
            field_str(&descriptor, "message"),
        )),
        Some("value") => {
            let value = descriptor.get("value").unwrap_or(&Value::Null);
            StartError::Other {
                kind: value.get("kind").map(jsv),
                thrown: Box::new(Thrown::Other(typeof_of(value))),
            }
        }
        _ => StartError::Other {
            kind: descriptor.get("kind").map(jsv),
            thrown: Scenario::thrown(&descriptor),
        },
    };
    ok(json(&agent_start_failed(&error).to_json()))
}

/// the links a case asks for before the call, as `[path, target]` pairs
fn make_links(value: Option<&Value>) {
    for pair in list(value) {
        let (Some(path), Some(target)) = (
            pair.get(0).and_then(Value::as_str),
            pair.get(1).and_then(Value::as_str),
        ) else {
            continue;
        };
        #[cfg(unix)]
        let _ = std::os::unix::fs::symlink(target, path);
        #[cfg(windows)]
        let _ = std::os::windows::fs::symlink_file(target, path);
    }
}

fn instructions_call(args: &[Value], with_cuts: bool) -> Answer {
    make_links(arg(args, 7));
    let provider = str_arg(args, 0)?;
    let root = str_arg(args, 1)?;
    let language = str_arg(args, 2)?;
    let with_app_tools = arg(args, 3).and_then(Value::as_bool).unwrap_or(false);
    let skills = skill_entries(arg(args, 4));
    let relay_servers = str_list(arg(args, 5));
    let platform = str_arg(args, 6)?;
    if with_cuts {
        let result = agent_instructions_and_cuts(
            provider,
            root,
            language,
            with_app_tools,
            &skills,
            &relay_servers,
            platform,
        );
        let mut object = Map::new();
        object.insert("text".into(), text(&result.text));
        object.insert("truncated".into(), strings(&result.truncated));
        ok(Value::Object(object))
    } else {
        ok(text(&agent_instructions(
            provider,
            root,
            language,
            with_app_tools,
            &skills,
            &relay_servers,
            platform,
        )))
    }
}

fn string_list(items: &[&str]) -> Value {
    Value::Array(items.iter().map(|item| text(item)).collect())
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- packages/ai-provider/src/agent-session ----
        "ai-provider/agent-session/skills.AGENT_SKILL_PLUGIN_NAME" => {
            ok(text(AGENT_SKILL_PLUGIN_NAME))
        }
        "ai-provider/agent-session/program-problem.AgentProgramError" => (|| -> Answer {
            let error = AgentProgramError::new(problem_of(arg(args, 0))?, str_arg(args, 1)?);
            let mut object = Map::new();
            object.insert("name".into(), text(AgentProgramError::NAME));
            object.insert("message".into(), text(&error.message));
            object.insert("problem".into(), json(&error.problem.to_json()));
            object.insert("isError".into(), Value::Bool(true));
            ok(Value::Object(object))
        })(),

        // ---- packages/agent-core/src/skill-mcp-refs ----
        "agent-core/skill-mcp-refs.SKILL_SKIPPED_STEPS_SENTENCE" => {
            ok(text(SKILL_SKIPPED_STEPS_SENTENCE))
        }
        "agent-core/skill-mcp-refs.mcpServerUnusableLine" => {
            str_arg(args, 0).map(|server| Some(text(&mcp_server_unusable_line(server))))
        }
        "agent-core/skill-mcp-refs.mcpServersInText" => {
            str_arg(args, 0).map(|body| Some(strings(&mcp_servers_in_text(body))))
        }
        "agent-core/skill-mcp-refs.mcpServersInAllowedTools" => {
            let tools = allowed_tools(arg(args, 0));
            ok(strings(&mcp_servers_in_allowed_tools(tools.as_deref())))
        }
        "agent-core/skill-mcp-refs.mcpServersOfSkill" => str_arg(args, 0).map(|body| {
            let tools = allowed_tools(arg(args, 1));
            Some(strings(&mcp_servers_of_skill(body, tools.as_deref())))
        }),
        "agent-core/skill-mcp-refs.unusableMcpServers" => {
            let servers = str_list(arg(args, 0));
            let usable = usable_of(arg(args, 1));
            let usable: Option<IsUsable<'_>> = usable.as_deref();
            ok(strings(&unusable_mcp_servers(&servers, usable)))
        }
        "agent-core/skill-mcp-refs.skillStepsNote" => {
            let servers = str_list(arg(args, 0));
            let usable = usable_of(arg(args, 1));
            let usable: Option<IsUsable<'_>> = usable.as_deref();
            ok(text(&skill_steps_note(&servers, usable)))
        }
        "agent-core/skill-mcp-refs.mcpServerListOf" => {
            let value = arg(args, 0).map(jsv);
            ok(strings(&mcp_server_list_of(value.as_ref())))
        }

        // ---- apps/shell/src/shared/agent-api ----
        "agent-api.AGENT_CHANNELS" => {
            let mut object = Map::new();
            for (key, channel) in AGENT_CHANNELS {
                object.insert(key.to_owned(), text(channel));
            }
            ok(Value::Object(object))
        }
        "agent-api.AGENT_PROVIDERS" => ok(string_list(&AGENT_PROVIDERS)),
        "agent-api.AGENT_MODES" => ok(string_list(&AGENT_MODES)),
        "agent-api.AGENT_BLOCKED_PROVIDERS" => ok(string_list(&AGENT_BLOCKED_PROVIDERS)),
        "agent-api.AGENT_WARNING_VERSION" => ok(num(AGENT_WARNING_VERSION)),
        "agent-api.AGENT_RECENT_LIMIT" => ok(num(AGENT_RECENT_LIMIT as f64)),
        "agent-api.DEFAULT_AGENT_PREFS" => ok(json(&default_agent_prefs().to_json())),
        "agent-api.AGENT_CODEX_WEB_SEARCH" => ok(string_list(&AGENT_CODEX_WEB_SEARCH)),
        "agent-api.DEFAULT_AGENT_PROJECT_PREFS" => {
            ok(json(&default_agent_project_prefs().to_json()))
        }
        "agent-api.AGENT_RUN_ERROR_KINDS" => ok(string_list(&AGENT_RUN_ERROR_KINDS)),
        "agent-api.agentProjectPrefsPatch" => {
            let raw = arg(args, 0).map(jsv);
            ok(json(&agent_project_prefs_patch(raw.as_ref()).to_json()))
        }
        "agent-api.agentStartFailureCode" => {
            failure_of(arg(args, 0)).map(|failure| Some(text(&agent_start_failure_code(&failure))))
        }
        "agent-api.normalizeAgentPrefs" => {
            let raw = arg(args, 0).map(jsv);
            ok(json(&normalize_agent_prefs(raw.as_ref()).to_json()))
        }
        "agent-api.withRecentFolder" => str_arg(args, 1).map(|folder| {
            Some(json(
                &with_recent_folder(&prefs_of(arg(args, 0)), folder).to_json(),
            ))
        }),

        // ---- apps/shell/src/main/agent/project-skills ----
        "project-skills.PROJECT_SKILLS_KEY" => ok(text(PROJECT_SKILLS_KEY)),
        "project-skills.projectSkillsOf" => ok(Value::Array(
            project_skills_of(&skills_like(arg(args, 0)))
                .iter()
                .map(skill_like_json)
                .collect(),
        )),
        "project-skills.projectSkillsFingerprint" => {
            ok(project_skills_fingerprint(&skills_like(arg(args, 0)))
                .map_or(Value::Null, Value::String))
        }
        "project-skills.approvedFingerprint" => (|| -> Answer {
            let found =
                approved_fingerprint(str_arg(args, 0)?, str_arg(args, 1)?, str_arg(args, 2)?);
            Ok(found.map(Value::String))
        })(),
        "project-skills.writeProjectSkillsApproval" => (|| -> Answer {
            let fingerprint = arg(args, 2).and_then(Value::as_str);
            write_project_skills_approval(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
                fingerprint,
                str_arg(args, 3)?,
            )?;
            Ok(None)
        })(),
        "project-skills.projectSkillsAllowed" => (|| -> Answer {
            ok(Value::Bool(project_skills_allowed(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
                &skills_like(arg(args, 2)),
                str_arg(args, 3)?,
            )))
        })(),
        "project-skills.projectSkillsView" => (|| -> Answer {
            ok(json(
                &project_skills_view(
                    str_arg(args, 0)?,
                    str_arg(args, 1)?,
                    &skills_like(arg(args, 2)),
                    str_arg(args, 3)?,
                )
                .to_json(),
            ))
        })(),
        "project-skills.setProjectSkills" => (|| -> Answer {
            let view = set_project_skills(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
                &skills_like(arg(args, 2)),
                arg(args, 3).and_then(Value::as_bool).unwrap_or(false),
                str_arg(args, 4)?,
            )?;
            ok(json(&view.to_json()))
        })(),

        // ---- apps/shell/src/main/agent/agent-session-folders ----
        "agent-session-folders.makeAgentSessionFolder" => make_folder_call(args, cx),
        "agent-session-folders.sweepAgentSessionFolders" => sweep_call(args, cx),

        // ---- apps/shell/src/main/agent/agent-sessions ----
        "agent-sessions.agentStartFailed" => agent_error_call(args),
        "agent-sessions.agentProtectedPaths" => (|| -> Answer {
            ok(strings(&agent_protected_paths(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
            )))
        })(),
        "agent-sessions.projectFolderProblem" => (|| -> Answer {
            let protected = str_list(arg(args, 2));
            let problem = project_folder_problem(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
                &protected,
                str_arg(args, 3)?,
            );
            Ok(problem.map(text))
        })(),
        "agent-sessions.relayInputPreview" => {
            let input = arg(args, 0).map(jsv).unwrap_or(JsonValue::Null);
            ok(text(&relay_input_preview(&input)))
        }
        "agent-sessions.codexSkillInstructions" => ok(strings(&codex_skill_instructions(
            &skill_entries(arg(args, 0)),
        ))),
        "agent-sessions.agentInstructions" => instructions_call(args, false),
        "agent-sessions.agentInstructionsAndCuts" => instructions_call(args, true),
        "agent-sessions.openableProjectFile" => (|| -> Answer {
            let found =
                openable_project_file(str_arg(args, 0)?, str_arg(args, 1)?, str_arg(args, 2)?);
            Ok(found.map(Value::String))
        })(),
        "agent-sessions.createAgentManager" => manager_call(args, cx),
        _ => return None,
    })
}
