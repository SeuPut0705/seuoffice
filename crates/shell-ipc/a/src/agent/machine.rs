//! The agent window, its manager and the services they call, on the core
//! thread.
//!
//! `main-core` ported the window's handlers and the sessions' manager as
//! resumable steps: a start hands out each call the TypeScript awaited
//! (`AgentStartCall`), a send hands out the program's acceptance, and between a
//! step and its answer every other handler (`stop`, `answer`, a session event)
//! runs, as in the TypeScript. This module is the caller that drives them:
//!
//! - the manager and the window's state ([`World`]) live in an [`Inner`] on the
//!   core thread (`Rc`, `RefCell`); a handler borrows the state for its
//!   synchronous work and never across a step;
//! - an awaited call runs off the core thread: on a worker (the app's MCP
//!   server, the relays, the skills copy, the session folder, Claude Code,
//!   a Claude message), or on the shared runtime driver (Codex, whose runner is
//!   an `async` function over it). Its answer is posted back to the core
//!   thread, where the pending start (kept by id with the invoke's `Responder`)
//!   is resumed;
//! - what the runtime or a callback reports from inside a handler (a Codex
//!   event, a finished Codex message) goes through [`later`], so it is never
//!   handled while the state is borrowed.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use jscompat::node_path::host::join;
use jscompat::{JsObject, JsonValue, json_value_from_serde};
use main_core::node_fs::NodeError;
use main_core::packages::ai_provider::agent_session_policy::process_platform;
use main_core::packages::ai_provider::subscription_process::{
    windows_system_dir, windows_system_tool,
};
use main_core::shell::agent::agent_api::{
    AgentPrefs, AgentProjectPrefs, AgentProjectPrefsPatch, AgentProjectSkillsView, agent_channel,
    normalize_agent_prefs,
};
use main_core::shell::agent::agent_session_folders::{
    ExecRequest, FolderHost, make_agent_session_folder,
};
use main_core::shell::agent::agent_sessions::{
    AgentHost, AgentManager, AgentMcpSession, AgentPermissionAnswer, AgentSessionHandle,
    AgentSkillBundle, AgentStartAnswer, AgentStartCall, AppMcp, McpRelays, RelayAnswer, RelayAsk,
    RelayAskRequest, RemoveOptions, RunnerError, Stoppable,
};
use main_core::shell::agent::agent_skills::{
    AgentOpenTab, AgentSessionSkillName, AgentSkillListEntry, AgentSkillProposalInput, DeckArchive,
    DeckEntry,
};
use main_core::shell::agent::agent_window::{
    AgentMcpSession as SkillSession, AgentSkillTools, AgentSkillToolsDeps, AgentWindowHost,
    AgentWindowSendJob, AgentWindowSendStep, AgentWindowShown, AgentWindowStartJob,
    AgentWindowStartStep, ShownProposal, SubscriptionStatus, TemplateAsIs, TemplateBlank,
    TemplateCheck, TemplatePreviewInput, TemplatePreviewOutcome, WindowState, agent_answer,
    agent_event_view, agent_get_init, agent_get_project_prefs, agent_get_project_skills,
    agent_get_theme, agent_home_may_open, agent_live_owner, agent_open_file, agent_pick_folder,
    agent_send, agent_set_prefs, agent_set_project_prefs, agent_set_project_skills, agent_start,
    agent_stop, agent_template_as_is, agent_template_blank, agent_template_check,
    agent_window_load, agent_window_options, agent_window_reuse,
};
use main_core::shell::agent::project_skills::{
    ProjectSkillLike, project_skills_allowed, project_skills_view, set_project_skills,
};
use main_core::shell::app_settings::{read_app_settings, write_agent_prefs};
use main_core::shell::crash_log::Thrown;
use main_core::shell::renderer_disposal::Failure;
use shell_contract::hosts::{ContentsHost, DialogsHost, FileDialog, MainWindowHost};
use shell_contract::ipc::{Responder, Target};
use shell_contract::runtime::{PathName, Services};
use shell_contract::{IpcValue, ViewId};

use super::codex;
use super::hosts::{
    AgentServicesHost, AgentWindowFrameHost, AppMcpStarted, ClaudeSession, Fault, RelayAsker,
    RelaysStarted, RunnerFault, SessionRef, SkillHooks,
};
use crate::runtime::Driver;
use crate::secrets::PLATFORM;
use crate::value::{arg, from_json};

/// The channels the window calls, one per `ipcMain.handle`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Op {
    Answer,
    GetInit,
    GetProjectPrefs,
    GetProjectSkills,
    GetTheme,
    OpenFile,
    PickFolder,
    Send,
    SetPrefs,
    SetProjectPrefs,
    SetProjectSkills,
    Start,
    Stop,
    TemplateAsIs,
    TemplateBlank,
    TemplateCheck,
}

// ---- the core thread's registry ---------------------------------------------------

thread_local! {
    static CORES: RefCell<HashMap<u64, Rc<Inner>>> = RefCell::new(HashMap::new());
}

static NEXT_PORT: AtomicU64 = AtomicU64::new(1);

/// Runs `run` on the port `port`'s state (this thread's), if the port is still there
pub(super) fn with_core(port: u64, run: impl FnOnce(&Rc<Inner>)) {
    let inner = CORES.with(|cores| cores.borrow().get(&port).cloned());
    if let Some(inner) = inner {
        run(&inner);
    }
}

/// Runs `run` on the core thread soon, after the call that is on the stack has returned: a
/// callback of the runtime or of the manager's own handle may fire while a handler holds the
/// state, and the state is not reentrant
pub(super) fn later(port: u64, run: impl FnOnce(&Rc<Inner>) + 'static) {
    with_core(port, |inner| {
        inner.local.borrow_mut().push_back(Box::new(run));
        inner.post_drain();
    });
}

pub(super) fn forget(port: u64) {
    CORES.with(|cores| cores.borrow_mut().remove(&port));
}

// ---- what the services and the manager need of Node -------------------------------

fn thrown(fault: &Fault) -> Box<Thrown> {
    Box::new(Thrown::Error {
        name: Some(JsonValue::String(fault.name.clone())),
        code: fault.code.clone().map(JsonValue::String),
    })
}

fn runner_error(fault: RunnerFault) -> RunnerError {
    match fault.problem {
        Some(problem) => RunnerError::Program(
            main_core::packages::ai_provider::agent_session_program_problem::AgentProgramError::new(
                *problem,
                fault.fault.message,
            ),
        ),
        None => RunnerError::Other {
            kind: fault.kind.map(JsonValue::String),
            thrown: thrown(&fault.fault),
        },
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0)
}

/// `randomUUID()`
pub(super) fn uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).expect("the system has random bytes");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// The object `owner.send(skillProposal, {...})` builds has `selected`, the proposal's `target`
/// and the target's `editors` as keys whose value is `undefined` when not set; JSON leaves them
/// out, so they are put back here (last in their object, as the literals order them)
fn with_unset_card_keys(payload: &mut IpcValue) {
    fn add_unset(entries: &mut Vec<(String, IpcValue)>, key: &str) {
        if !entries.iter().any(|(name, _)| name == key) {
            entries.push((key.to_owned(), IpcValue::Undefined));
        }
    }
    let IpcValue::Object(card) = payload else {
        return;
    };
    add_unset(card, "selected");
    let Some((_, IpcValue::Object(proposal))) =
        card.iter_mut().find(|(name, _)| name == "proposal")
    else {
        return;
    };
    add_unset(proposal, "target");
    if let Some((_, IpcValue::Object(target))) =
        proposal.iter_mut().find(|(name, _)| name == "target")
    {
        add_unset(target, "editors");
    }
}

/// `agentSessionSkillsOf` builds each skill as `{id, name, source, plugin, title, description,
/// invoke, skillMd, template}`, `plugin` and `template` being `undefined` when there is none;
/// JSON leaves them out, so they are put back in their places in the start's `skills`
fn with_unset_skill_keys(answer: &mut IpcValue) {
    let IpcValue::Object(entries) = answer else {
        return;
    };
    let Some((_, IpcValue::Array(skills))) = entries.iter_mut().find(|(name, _)| name == "skills")
    else {
        return;
    };
    for skill in skills {
        let IpcValue::Object(fields) = skill else {
            continue;
        };
        if !fields.iter().any(|(name, _)| name == "plugin") {
            let at = fields
                .iter()
                .position(|(name, _)| name == "source")
                .map_or(fields.len(), |source| source + 1);
            fields.insert(at, ("plugin".to_owned(), IpcValue::Undefined));
        }
        if !fields.iter().any(|(name, _)| name == "template") {
            fields.push(("template".to_owned(), IpcValue::Undefined));
        }
    }
}

/// `rm(dir, { recursive, force, maxRetries, retryDelay })`: whether it succeeded
fn remove_with_retries(dir: &str, options: &RemoveOptions) -> bool {
    for attempt in 0..=options.max_retries {
        match main_core::markdown::fs_util::rm_recursive_force(dir) {
            Ok(()) => return true,
            Err(_) if attempt < options.max_retries => std::thread::sleep(
                std::time::Duration::from_millis(u64::from(options.retry_delay_ms)),
            ),
            Err(_) => {}
        }
    }
    false
}

/// the stored skills as the project skills see them
fn project_like(skills: &[JsonValue]) -> Vec<ProjectSkillLike> {
    let text = |skill: &JsonValue, key: &str| match skill {
        JsonValue::Object(object) => match object.get(key) {
            Some(JsonValue::String(value)) => value.clone(),
            _ => String::new(),
        },
        _ => String::new(),
    };
    skills
        .iter()
        .map(|skill| ProjectSkillLike {
            id: text(skill, "id"),
            name: text(skill, "name"),
            title: text(skill, "title"),
            description: text(skill, "description"),
            dir: text(skill, "dir"),
            source: text(skill, "source"),
        })
        .collect()
}

/// `os.tmpdir()`, the clock and the process: what the session folders take of Node. `Send`: the
/// session folder is made on a worker
#[derive(Clone)]
pub(super) struct Env {
    svc: AgentServicesHost,
    tmp: String,
    started: Instant,
}

impl FolderHost for Env {
    fn tmpdir(&self) -> String {
        self.tmp.clone()
    }

    fn now_ms(&self) -> f64 {
        now_ms()
    }

    fn pid(&self) -> f64 {
        f64::from(std::process::id())
    }

    fn uptime_secs(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }

    fn platform(&self) -> String {
        PLATFORM.to_owned()
    }

    fn windows_system_dir(&self) -> String {
        windows_system_dir(&|key| std::env::var(key).ok())
    }

    fn windows_system_tool(&self, segments: &[&str]) -> String {
        windows_system_tool(&|key| std::env::var(key).ok(), segments)
    }

    fn random_suffix(&mut self) -> String {
        const LETTERS: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let mut bytes = [0u8; 6];
        getrandom::fill(&mut bytes).expect("the system has random bytes");
        bytes
            .iter()
            .map(|b| char::from(LETTERS[usize::from(*b) % LETTERS.len()]))
            .collect()
    }

    fn process_alive(&mut self, pid: f64) -> bool {
        self.svc.process_alive(pid)
    }

    fn exec_file(&mut self, request: &ExecRequest) -> String {
        self.svc.exec_file(request)
    }
}

/// `stop()` of what a session started, once
struct StopOnce(Option<Box<dyn FnOnce() + Send>>);

impl Stoppable for StopOnce {
    fn stop(&mut self) {
        if let Some(stop) = self.0.take() {
            stop();
        }
    }
}

/// A running Claude Code program as the manager holds it: its message is sent on a worker, and
/// what it came to is posted back
struct ClaudeHandle {
    session: Arc<dyn ClaudeSession>,
    sh: Rc<Shared>,
    session_id: String,
}

impl AgentSessionHandle for ClaudeHandle {
    fn send(&mut self, text: &str) {
        let (session, text) = (self.session.clone(), text.to_owned());
        let (core, port, session_id) = (
            self.sh.services.core.clone(),
            self.sh.port,
            self.session_id.clone(),
        );
        self.sh.services.workers.spawn(Box::new(move || {
            let answer = session.send(&text);
            core.post(Box::new(move || {
                with_core(port, |inner| inner.send_finished(&session_id, answer));
            }));
        }));
    }

    fn answer(&mut self, id: &str, answer: &AgentPermissionAnswer) {
        self.session.answer(
            id,
            answer.allow,
            answer.scope.as_deref(),
            answer.message.as_deref(),
        );
    }

    fn set_open_documents(&mut self, paths: &[String]) {
        self.session.set_open_documents(paths);
    }

    fn stop(&mut self) {
        self.session.stop();
    }
}

/// `AgentSkillToolHooks` of one session: a skill tool's call is posted to the core thread
struct Hooks {
    sh: Arc<Threads>,
    session: SessionRef,
    project_root: String,
}

fn closed() -> String {
    "The agent window is closed; the card cannot be shown.".to_owned()
}

impl SkillHooks for Hooks {
    fn propose_skill(
        &self,
        input: AgentSkillProposalInput,
        tabs: Vec<AgentOpenTab>,
        done: Box<dyn FnOnce(Result<(), String>) + Send>,
    ) {
        let (session, project_root, port) = (
            self.session.clone(),
            self.project_root.clone(),
            self.sh.port,
        );
        self.sh.core.post(Box::new(move || {
            let mut done = Some(done);
            with_core(port, |inner| {
                let result = inner.propose_skill(&session, &project_root, &input, &tabs);
                if let Some(done) = done.take() {
                    done(result);
                }
            });
            if let Some(done) = done {
                done(Err(closed()));
            }
        }));
    }

    fn propose_install(&self, address: String, done: Box<dyn FnOnce(Result<(), String>) + Send>) {
        let (session, project_root, port) = (
            self.session.clone(),
            self.project_root.clone(),
            self.sh.port,
        );
        self.sh.core.post(Box::new(move || {
            let mut done = Some(done);
            with_core(port, |inner| {
                let result = inner.propose_install(&session, &project_root, &address);
                if let Some(done) = done.take() {
                    done(result);
                }
            });
            if let Some(done) = done {
                done(Err(closed()));
            }
        }));
    }
}

/// The `ask` of the relays of one session: a question is posted to the core thread
struct Asker {
    sh: Arc<Threads>,
    session_id: String,
    next: AtomicU64,
}

impl RelayAsker for Asker {
    fn ask(&self, request: RelayAskRequest, done: Box<dyn FnOnce(RelayAnswer) + Send>) -> u64 {
        let token = self.next.fetch_add(1, Ordering::Relaxed);
        let (session_id, port) = (self.session_id.clone(), self.sh.port);
        self.sh.core.post(Box::new(move || {
            let mut done = Some(done);
            with_core(port, |inner| {
                if let Some(done) = done.take() {
                    inner.relay_ask(&session_id, token, &request, done);
                }
            });
            if let Some(done) = done {
                done(RelayAnswer::Deny);
            }
        }));
        token
    }

    fn abort(&self, token: u64) {
        let (session_id, port) = (self.session_id.clone(), self.sh.port);
        self.sh.core.post(Box::new(move || {
            with_core(port, |inner| inner.relay_ask_aborted(&session_id, token));
        }));
    }
}

/// What a worker or a callback needs to reach the core thread
pub(super) struct Threads {
    core: Arc<dyn shell_contract::runtime::Thread>,
    port: u64,
}

// ---- the shared parts --------------------------------------------------------------

/// What the state and the callbacks share: the shell's services and hosts. Not borrowed
pub(super) struct Shared {
    pub(super) services: Services,
    pub(super) svc: AgentServicesHost,
    pub(super) frame: AgentWindowFrameHost,
    pub(super) main_window: MainWindowHost,
    pub(super) dialogs: DialogsHost,
    pub(super) contents: ContentsHost,
    pub(super) driver: Driver,
    pub(super) port: u64,
    pub(super) env: Env,
}

impl Shared {
    fn path(&self, name: PathName) -> String {
        self.services
            .paths
            .path(name)
            .to_string_lossy()
            .into_owned()
    }

    fn app_settings(&self) -> String {
        join(&[&self.path(PathName::UserData), "app-settings.json"])
    }

    fn state_of(&self, view: ViewId) -> WindowState {
        WindowState {
            destroyed: self.services.views.sender_of(view).is_none(),
            contents_id: i64::from(view.0),
        }
    }

    fn session_ref(session: &AgentMcpSession) -> SessionRef {
        SessionRef {
            owner: ViewId(session.owner_id as u32),
            session_id: session.session_id.clone(),
        }
    }

    fn threads(&self) -> Arc<Threads> {
        Arc::new(Threads {
            core: self.services.core.clone(),
            port: self.port,
        })
    }
}

/// The manager's host (`AgentManagerDeps`): what a session reaches
pub(super) struct Io {
    sh: Rc<Shared>,
    env: Env,
    /// relay questions waiting for the person, by the card's id
    waiters: HashMap<String, Box<dyn FnOnce(RelayAnswer) + Send>>,
    /// a relay's ask token (per session) and the card's id
    tokens: HashMap<(String, u64), String>,
}

impl FolderHost for Io {
    fn tmpdir(&self) -> String {
        self.env.tmpdir()
    }

    fn now_ms(&self) -> f64 {
        self.env.now_ms()
    }

    fn pid(&self) -> f64 {
        self.env.pid()
    }

    fn uptime_secs(&self) -> f64 {
        self.env.uptime_secs()
    }

    fn platform(&self) -> String {
        self.env.platform()
    }

    fn windows_system_dir(&self) -> String {
        self.env.windows_system_dir()
    }

    fn windows_system_tool(&self, segments: &[&str]) -> String {
        self.env.windows_system_tool(segments)
    }

    fn random_suffix(&mut self) -> String {
        self.env.random_suffix()
    }

    fn process_alive(&mut self, pid: f64) -> bool {
        self.env.process_alive(pid)
    }

    fn exec_file(&mut self, request: &ExecRequest) -> String {
        self.env.exec_file(request)
    }
}

impl AgentHost for Io {
    fn statuses(&mut self) -> JsonValue {
        self.sh.svc.statuses()
    }

    fn ai_settings(&mut self) -> JsonValue {
        self.sh.svc.ai_settings()
    }

    fn open_documents(&mut self) -> Vec<String> {
        self.sh.svc.open_documents()
    }

    fn language(&mut self) -> String {
        self.sh.svc.lang()
    }

    fn random_uuid(&mut self) -> String {
        self.sh.svc.random_uuid()
    }

    /// `emit` of `configureAgentWindow`: while the window is open and still the session's owner
    fn emit(&mut self, owner_id: i64, session_id: &str, event: &JsonValue) {
        let Some(view) = self.sh.frame.view() else {
            return;
        };
        if i64::from(view.0) != owner_id || self.sh.services.views.sender_of(view).is_none() {
            return;
        }
        let payload =
            serde_json::json!({ "sessionId": session_id, "event": agent_event_view(event) });
        self.sh.services.events.emit(
            Target::View(view),
            agent_channel("event").expect("a channel of AGENT_CHANNELS"),
            vec![from_json(&json_value_from_serde(&payload))],
        );
    }

    fn has_app_mcp(&self) -> bool {
        self.sh.svc.has_app_mcp()
    }

    fn has_relays(&self) -> bool {
        self.sh.svc.has_user_mcp()
    }

    fn has_build_skills(&self) -> bool {
        true
    }

    fn remove_folder(&mut self, dir: &str, options: &RemoveOptions) {
        let (core, port) = (self.sh.services.core.clone(), self.sh.port);
        let (dir, options) = (dir.to_owned(), *options);
        self.sh.services.workers.spawn(Box::new(move || {
            if remove_with_retries(&dir, &options) {
                core.post(Box::new(move || {
                    with_core(port, |inner| {
                        inner.world.borrow_mut().manager.folder_removed(&dir);
                    });
                }));
            }
        }));
    }

    fn remove_folder_sync(&mut self, dir: &str, options: &RemoveOptions) -> bool {
        remove_with_retries(dir, options)
    }

    fn relay_settled(&mut self, ask_id: &str, answer: &RelayAnswer) {
        self.tokens.retain(|_, id| id != ask_id);
        if let Some(done) = self.waiters.remove(ask_id) {
            done(*answer);
        }
    }
}

/// the JSZip behind the deck check
struct Deck(AgentServicesHost);

impl DeckArchive for Deck {
    fn open(&mut self, bytes: &[u8]) -> Result<Vec<DeckEntry>, String> {
        self.0.deck_open(bytes)
    }

    fn text(&mut self, index: usize) -> Result<String, String> {
        self.0.deck_text(index)
    }
}

/// The window's host (`AgentWindowDeps`)
pub(super) struct Host {
    sh: Rc<Shared>,
    io: Io,
    deck: Deck,
}

impl AgentWindowHost for Host {
    fn window(&self) -> Option<WindowState> {
        self.sh.frame.view().map(|view| self.sh.state_of(view))
    }

    fn has_deps(&self) -> bool {
        true
    }

    fn has_manager(&self) -> bool {
        true
    }

    fn platform(&self) -> String {
        PLATFORM.to_owned()
    }

    fn os_home_dir(&self) -> String {
        self.sh.path(PathName::Home)
    }

    fn lang(&self) -> String {
        self.sh.svc.lang()
    }

    fn theme(&self) -> String {
        self.sh.svc.theme()
    }

    fn statuses(&self) -> JsObject<SubscriptionStatus> {
        let mut statuses = JsObject::new();
        if let JsonValue::Object(map) = self.sh.svc.statuses() {
            for (provider, status) in map.entries() {
                let field = |key: &str| match status {
                    JsonValue::Object(object) => object.get(key).cloned(),
                    _ => None,
                };
                statuses.set(
                    provider,
                    SubscriptionStatus {
                        state: match field("state") {
                            Some(JsonValue::String(state)) => state,
                            _ => String::new(),
                        },
                        metered_accepted: field("meteredAccepted") == Some(JsonValue::Bool(true)),
                    },
                );
            }
        }
        statuses
    }

    fn metered_accepted(&self) -> Option<JsObject<bool>> {
        let JsonValue::Object(settings) = self.sh.svc.ai_settings() else {
            return None;
        };
        let Some(JsonValue::Object(accepted)) = settings.get("meteredAccepted") else {
            return None;
        };
        let mut out = JsObject::new();
        for (provider, value) in accepted.entries() {
            out.set(provider, *value == JsonValue::Bool(true));
        }
        Some(out)
    }

    fn read_prefs(&self) -> AgentPrefs {
        normalize_agent_prefs(read_app_settings(&self.sh.app_settings()).get("agent"))
    }

    fn write_prefs(&mut self, prefs: &AgentPrefs) {
        // a file that cannot be written leaves the old choices; the handlers answer the
        // new ones either way, as a throw here would not reach the person
        let _ = write_agent_prefs(&self.sh.app_settings(), &prefs.to_json());
    }

    fn parent_window(&self) -> Option<WindowState> {
        self.sh
            .main_window
            .view()
            .map(|view| self.sh.state_of(view))
    }

    fn user_data(&self) -> String {
        self.sh.path(PathName::UserData)
    }

    fn deps_home_dir(&self) -> Option<String> {
        None
    }

    fn open_documents(&self) -> Vec<String> {
        self.sh.svc.open_documents()
    }

    fn open_path(&mut self, path: &str) -> bool {
        self.sh.svc.open_path(path)
    }

    fn read_project_prefs_override(
        &mut self,
        _folder: &str,
    ) -> Option<Result<AgentProjectPrefs, Failure>> {
        None
    }

    fn write_project_prefs_override(
        &mut self,
        _folder: &str,
        _patch: &AgentProjectPrefsPatch,
    ) -> Option<Result<AgentProjectPrefs, Failure>> {
        None
    }

    fn has_project_skills(&self) -> bool {
        true
    }

    fn project_skills_view(&mut self, folder: &str) -> Result<AgentProjectSkillsView, Failure> {
        let enabled = self.sh.svc.enabled_for_agent(folder).map_err(Failure)?;
        Ok(project_skills_view(
            &self.sh.app_settings(),
            folder,
            &project_like(&enabled),
            PLATFORM,
        ))
    }

    fn project_skills_set(
        &mut self,
        folder: &str,
        on: bool,
    ) -> Result<AgentProjectSkillsView, Failure> {
        let enabled = self.sh.svc.enabled_for_agent(folder).map_err(Failure)?;
        set_project_skills(
            &self.sh.app_settings(),
            folder,
            &project_like(&enabled),
            on,
            PLATFORM,
        )
        .map_err(|error| Failure(format!("{error:?}")))
    }

    fn has_open_template_preview(&self) -> bool {
        true
    }

    fn open_template_preview(
        &mut self,
        owner_id: i64,
        input: &TemplatePreviewInput,
    ) -> Result<TemplatePreviewOutcome, Failure> {
        self.sh
            .svc
            .open_template_preview(ViewId(owner_id as u32), input)
            .map_err(Failure)
    }

    fn show_open_dialog(&mut self, options: &JsObject<JsonValue>) -> JsonValue {
        let properties = match options.get("properties") {
            Some(JsonValue::Array(items)) => items
                .iter()
                .filter_map(|item| match item {
                    JsonValue::String(property) => Some(property.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        let parent = self
            .sh
            .frame
            .view()
            .and_then(|view| self.sh.contents.window_of(view));
        let picked = self.sh.dialogs.open(
            parent,
            &FileDialog {
                properties,
                ..FileDialog::default()
            },
        );
        let mut out = JsObject::new();
        out.set("canceled", JsonValue::Bool(picked.is_none()));
        out.set(
            "filePaths",
            JsonValue::Array(
                picked
                    .unwrap_or_default()
                    .iter()
                    .map(|path| JsonValue::String(path.to_string_lossy().into_owned()))
                    .collect(),
            ),
        );
        JsonValue::Object(out)
    }

    fn deck(&mut self) -> &mut dyn DeckArchive {
        &mut self.deck
    }

    fn agent(&mut self) -> &mut dyn AgentHost {
        &mut self.io
    }
}

// ---- the state --------------------------------------------------------------------

/// What a worker's awaited call came to, in a form that crosses threads
enum Fin {
    Folder(Result<String, NodeError>),
    AppMcp(Result<AppMcpStarted, Fault>),
    Relays(Result<RelaysStarted, Fault>),
    Skills(Result<Option<AgentSkillBundle>, Fault>),
    /// the session's id and what the runner came to
    Claude(String, Result<Arc<dyn ClaudeSession>, RunnerFault>),
}

/// a message waiting for its program's acceptance
type WaitingSend = (AgentWindowSendJob, Responder);

pub(super) struct World {
    host: Host,
    manager: AgentManager,
    shown: AgentWindowShown,
    /// starts waiting for an awaited call, with the invoke to answer
    starts: HashMap<u64, (AgentWindowStartJob, Responder)>,
    /// messages waiting for their program, by session, in order
    sends: HashMap<String, VecDeque<WaitingSend>>,
    next: u64,
}

/// One agent window port's state, on the core thread
pub(super) struct Inner {
    sh: Rc<Shared>,
    world: RefCell<World>,
    local: RefCell<VecDeque<LocalJob>>,
}

/// work queued for the port's state, run once no handler holds it
type LocalJob = Box<dyn FnOnce(&Rc<Inner>)>;

/// What [`Inner::new`] needs from the shell
pub(super) struct Wiring {
    pub(super) services: Services,
    pub(super) svc: AgentServicesHost,
    pub(super) frame: AgentWindowFrameHost,
    pub(super) main_window: MainWindowHost,
    pub(super) dialogs: DialogsHost,
    pub(super) contents: ContentsHost,
    pub(super) driver: Driver,
}

impl Inner {
    /// Makes the state and registers it for the callbacks of this thread; answers its port number
    pub(super) fn register(wiring: Wiring) -> (Rc<Inner>, u64) {
        let port = NEXT_PORT.fetch_add(1, Ordering::Relaxed);
        let Wiring {
            services,
            svc,
            frame,
            main_window,
            dialogs,
            contents,
            driver,
        } = wiring;
        let path = |name| services.paths.path(name).to_string_lossy().into_owned();
        let manager = AgentManager::new(
            &path(PathName::UserData),
            &path(PathName::Home),
            process_platform(),
        );
        let env = Env {
            svc: svc.clone(),
            tmp: path(PathName::Temp),
            started: Instant::now(),
        };
        let sh = Rc::new(Shared {
            services,
            svc: svc.clone(),
            frame,
            main_window,
            dialogs,
            contents,
            driver,
            port,
            env,
        });
        let host = Host {
            sh: sh.clone(),
            io: Io {
                sh: sh.clone(),
                env: sh.env.clone(),
                waiters: HashMap::new(),
                tokens: HashMap::new(),
            },
            deck: Deck(svc),
        };
        let inner = Rc::new(Inner {
            sh,
            world: RefCell::new(World {
                host,
                manager,
                shown: AgentWindowShown::new(),
                starts: HashMap::new(),
                sends: HashMap::new(),
                next: 1,
            }),
            local: RefCell::default(),
        });
        CORES.with(|cores| cores.borrow_mut().insert(port, inner.clone()));
        (inner, port)
    }

    fn post_drain(&self) {
        let port = self.sh.port;
        self.sh.services.core.post(Box::new(move || {
            with_core(port, |inner| {
                let next = inner.local.borrow_mut().pop_front();
                if let Some(next) = next {
                    next(inner);
                }
            });
        }));
    }

    // ---- the handlers ------------------------------------------------------------

    /// One `ipcMain.handle`
    pub(super) fn invoke(
        self: &Rc<Self>,
        op: Op,
        sender: ViewId,
        args: &[IpcValue],
        reply: Responder,
    ) {
        let sender = i64::from(sender.0);
        let given: Vec<Option<JsonValue>> = (0..6).map(|i| arg(args, i)).collect();
        let a = |i: usize| given[i].as_ref();
        match op {
            Op::Start => {
                let step = {
                    let w = &mut *self.world.borrow_mut();
                    agent_start(&mut w.host, &mut w.manager, sender, a(0), now_ms())
                };
                return self.start_step(step, reply);
            }
            Op::Send => {
                let step = {
                    let w = &mut *self.world.borrow_mut();
                    agent_send(&mut w.host, &mut w.manager, sender, a(0), a(1))
                };
                return match step {
                    AgentWindowSendStep::Done(done) => reply.reply(Ok(IpcValue::Bool(done))),
                    AgentWindowSendStep::Await { call, job } => {
                        self.world
                            .borrow_mut()
                            .sends
                            .entry(call.session_id)
                            .or_default()
                            .push_back((job, reply));
                    }
                };
            }
            _ => {}
        }
        let answer = {
            let w = &mut *self.world.borrow_mut();
            let host = &mut w.host;
            let manager = &mut w.manager;
            let json = |value: serde_json::Value| from_json(&json_value_from_serde(&value));
            let null_or =
                |value: Option<JsonValue>| value.map_or(IpcValue::Null, |v| from_json(&v));
            match op {
                Op::GetInit => agent_get_init(&*host, sender).map_or(IpcValue::Null, json),
                Op::GetTheme => IpcValue::String(agent_get_theme(&*host)),
                Op::PickFolder => {
                    agent_pick_folder(host, sender).map_or(IpcValue::Null, IpcValue::String)
                }
                Op::SetPrefs => null_or(agent_set_prefs(host, sender, a(0)).map(|p| p.to_json())),
                Op::GetProjectPrefs => {
                    null_or(agent_get_project_prefs(host, sender, a(0)).map(|p| p.to_json()))
                }
                Op::SetProjectPrefs => {
                    null_or(agent_set_project_prefs(host, sender, a(0), a(1)).map(|p| p.to_json()))
                }
                Op::GetProjectSkills => {
                    null_or(agent_get_project_skills(host, sender, a(0)).map(|v| v.to_json()))
                }
                Op::SetProjectSkills => {
                    null_or(agent_set_project_skills(host, sender, a(0), a(1)).map(|v| v.to_json()))
                }
                Op::Answer => {
                    agent_answer(host, manager, sender, a(0), a(1), a(2), a(3));
                    IpcValue::Undefined
                }
                Op::Stop => {
                    agent_stop(host, manager, sender, a(0));
                    IpcValue::Undefined
                }
                Op::OpenFile => IpcValue::Bool(agent_open_file(host, manager, sender, a(0), a(1))),
                Op::TemplateCheck => {
                    match agent_template_check(host, &w.shown, sender, a(0), a(1)) {
                        TemplateCheck::Ok { redaction } => {
                            json(serde_json::json!({ "ok": true, "redaction": redaction.as_str() }))
                        }
                        TemplateCheck::Refused(reason) => {
                            json(serde_json::json!({ "ok": false, "reason": reason.as_str() }))
                        }
                    }
                }
                Op::TemplateAsIs => {
                    match agent_template_as_is(host, &w.shown, sender, a(0), a(1)) {
                        TemplateAsIs::Ok { bytes, file_name } => IpcValue::Object(vec![
                            ("ok".into(), IpcValue::Bool(true)),
                            (
                                "bytes".into(),
                                IpcValue::Bytes(shell_contract::BytesKind::Uint8Array, bytes),
                            ),
                            ("fileName".into(), IpcValue::String(file_name)),
                        ]),
                        TemplateAsIs::Refused(reason) => {
                            json(serde_json::json!({ "ok": false, "reason": reason.as_str() }))
                        }
                    }
                }
                Op::TemplateBlank => {
                    match agent_template_blank(host, &w.shown, sender, a(0), a(1), a(2)) {
                        TemplateBlank::Ok { tab_id, preview_id } => json(
                            serde_json::json!({ "ok": true, "tabId": tab_id, "previewId": preview_id }),
                        ),
                        TemplateBlank::Refused(reason) => {
                            json(serde_json::json!({ "ok": false, "reason": reason.as_str() }))
                        }
                    }
                }
                Op::Start | Op::Send => unreachable!("handled above"),
            }
        };
        reply.reply(Ok(answer));
    }

    /// The `home:open-agent-window` handler: Home opens the window, nothing else may
    pub(super) fn open_from_home(&self, sender: ViewId) {
        let may = agent_home_may_open(&self.world.borrow().host, i64::from(sender.0));
        if may {
            self.open_window();
        }
    }

    /// `openAgentWindow()`
    pub(super) fn open_window(&self) {
        let frame = &self.sh.frame;
        let existing = frame
            .view()
            .map(|view| (self.sh.state_of(view).destroyed, frame.is_minimized()));
        if let Some(restore) = agent_window_reuse(existing) {
            frame.reveal(restore);
            return;
        }
        let lang = self.sh.svc.lang();
        let title = frame.window_title(&lang);
        let options = agent_window_options(&lang, &title, &frame.preload_path());
        let load = agent_window_load(frame.renderer_url().as_deref(), &frame.built_file());
        frame.create(&options, &load);
    }

    /// `isAgentWindowContents(sender)`
    pub(super) fn is_window_contents(&self, view: ViewId) -> bool {
        self.sh.frame.view() == Some(view) && self.sh.services.views.sender_of(view).is_some()
    }

    /// The agent window's page went away: its sessions end with it
    pub(super) fn view_closed(&self, view: ViewId) {
        let w = &mut *self.world.borrow_mut();
        w.manager.stop_owner(&mut w.host.io, i64::from(view.0));
    }

    /// `stopAgentSessions()`
    pub(super) fn stop_all(&self) {
        let w = &mut *self.world.borrow_mut();
        w.manager.stop_all(&mut w.host.io);
    }

    // ---- starts and sends -------------------------------------------------------------

    fn start_step(self: &Rc<Self>, step: AgentWindowStartStep, reply: Responder) {
        match step {
            AgentWindowStartStep::Done(response) => {
                let mut answer = from_json(&json_value_from_serde(&response));
                with_unset_skill_keys(&mut answer);
                reply.reply(Ok(answer))
            }
            AgentWindowStartStep::Await { call, job } => {
                let id = {
                    let mut w = self.world.borrow_mut();
                    let id = w.next;
                    w.next += 1;
                    w.starts.insert(id, (job, reply));
                    id
                };
                self.carry(id, call);
            }
        }
    }

    /// What a start's awaited call came to: the start goes on, outside any other handler
    fn finish_start(self: &Rc<Self>, id: u64, answer: AgentStartAnswer) {
        let pending = self.world.borrow_mut().starts.remove(&id);
        let Some((job, reply)) = pending else {
            return;
        };
        let step = {
            let w = &mut *self.world.borrow_mut();
            job.resume(&mut w.host, &mut w.manager, answer, now_ms())
        };
        self.start_step(step, reply);
    }

    /// The program took the message (or refused it): the handler of the `send` answers
    pub(super) fn send_finished(&self, session_id: &str, answer: Result<(), String>) {
        let waiting = {
            let mut w = self.world.borrow_mut();
            let queue = w.sends.get_mut(session_id);
            let waiting = queue.and_then(VecDeque::pop_front);
            if w.sends.get(session_id).is_some_and(VecDeque::is_empty) {
                w.sends.remove(session_id);
            }
            waiting
        };
        if let Some((job, reply)) = waiting {
            reply.reply(Ok(IpcValue::Bool(job.resume(answer))));
        }
    }

    /// An event of a session's program (the `onEvent` the runner was given)
    pub(super) fn on_event(&self, owner_id: i64, session_id: &str, event: &JsonValue) {
        let w = &mut *self.world.borrow_mut();
        w.manager
            .on_event(&mut w.host.io, owner_id, session_id, event);
    }

    /// Carries a start's awaited call out, off the core thread (Codex on the runtime driver);
    /// what it came to resumes the start `id`
    fn carry(self: &Rc<Self>, id: u64, call: AgentStartCall) {
        let sh = self.sh.clone();
        let (port, threads) = (sh.port, sh.threads());
        let svc = sh.svc.clone();
        match call {
            AgentStartCall::SessionFolder => {
                let mut env = sh.env.clone();
                self.work(id, move || {
                    Fin::Folder(make_agent_session_folder(&mut env, None))
                });
            }
            AgentStartCall::AppMcp {
                project_root,
                session,
            } => {
                let session = Shared::session_ref(&session);
                let hooks = Arc::new(Hooks {
                    sh: threads,
                    session: session.clone(),
                    project_root: project_root.clone(),
                });
                self.work(id, move || {
                    Fin::AppMcp(svc.start_app_mcp(&project_root, &session, hooks))
                });
            }
            AgentStartCall::Relays { session } => {
                let ask = Arc::new(Asker {
                    sh: threads,
                    session_id: session.session_id.clone(),
                    next: AtomicU64::new(1),
                });
                let session = Shared::session_ref(&session);
                self.work(id, move || Fin::Relays(svc.start_relays(&session, ask)));
            }
            AgentStartCall::BuildSkills { project_root } => {
                // `userSkills.enabledForAgent` is the skills service's, on this thread
                let enabled = match svc.enabled_for_agent(&project_root) {
                    Ok(enabled) => enabled,
                    Err(message) => {
                        let answer =
                            AgentStartAnswer::BuildSkills(Err(thrown(&Fault::new(message))));
                        return later(port, move |inner| inner.finish_start(id, answer));
                    }
                };
                let settings = sh.app_settings();
                // not under userData: that folder is protected from sessions, and the copied
                // skills' scripts must be readable to run
                let base = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| sh.env.tmp.clone());
                let dir = join(&[&base, "seuoffice", "agent-skills"]);
                self.work(id, move || {
                    // the project's own skills only while the person has turned them on as they
                    // are now (decision 0064), read again at the start
                    let allowed = project_skills_allowed(
                        &settings,
                        &project_root,
                        &project_like(&enabled),
                        PLATFORM,
                    );
                    let chosen: Vec<JsonValue> = if allowed {
                        enabled
                    } else {
                        enabled
                            .into_iter()
                            .filter(|skill| match skill {
                                JsonValue::Object(object) => {
                                    object.get("source")
                                        != Some(&JsonValue::String("project".into()))
                                }
                                _ => true,
                            })
                            .collect()
                    };
                    Fin::Skills(svc.build_skill_bundle(&chosen, &dir))
                });
            }
            AgentStartCall::RunClaude { options, session } => {
                let (core, owner_id, session_id) = (
                    sh.services.core.clone(),
                    session.owner_id,
                    session.session_id.clone(),
                );
                let started_as = session_id.clone();
                let on_event = Arc::new(move |event: JsonValue| {
                    let session_id = session_id.clone();
                    core.post(Box::new(move || {
                        with_core(port, |inner| inner.on_event(owner_id, &session_id, &event));
                    }));
                });
                self.work(id, move || {
                    Fin::Claude(started_as, svc.run_claude(&options, on_event))
                });
            }
            AgentStartCall::RunCodex {
                options,
                codex: choices,
                session,
            } => {
                codex::start(
                    &sh.driver,
                    port,
                    codex::codex_options(&options, &choices),
                    session.owner_id,
                    session.session_id.clone(),
                    move |ran| {
                        let answer = AgentStartAnswer::Run(
                            ran.map_err(|error| runner_error(codex::fault_of(&error))),
                        );
                        later(port, move |inner| inner.finish_start(id, answer));
                    },
                );
            }
        }
    }

    /// Runs `work` on a worker; its answer resumes the start `id` on the core thread
    fn work(self: &Rc<Self>, id: u64, work: impl FnOnce() -> Fin + Send + 'static) {
        let (core, port) = (self.sh.services.core.clone(), self.sh.port);
        self.sh.services.workers.spawn(Box::new(move || {
            let fin = work();
            core.post(Box::new(move || {
                with_core(port, |inner| {
                    let answer = inner.answer_of(fin);
                    inner.finish_start(id, answer);
                });
            }));
        }));
    }

    /// A worker's answer in the types of the manager
    fn answer_of(&self, fin: Fin) -> AgentStartAnswer {
        match fin {
            Fin::Folder(made) => AgentStartAnswer::SessionFolder(made),
            Fin::AppMcp(started) => AgentStartAnswer::AppMcp(match started {
                Ok(started) => Ok(AppMcp {
                    url: started.url,
                    token: started.token,
                    server: Box::new(StopOnce(Some(started.stop))),
                }),
                Err(fault) => Err(thrown(&fault)),
            }),
            Fin::Relays(started) => AgentStartAnswer::Relays(match started {
                Ok(started) => Ok(McpRelays {
                    relays: started.relays,
                    keep_results_inside: started.keep_results_inside,
                    handle: Box::new(StopOnce(Some(started.stop))),
                }),
                Err(fault) => Err(thrown(&fault)),
            }),
            Fin::Skills(built) => {
                AgentStartAnswer::BuildSkills(built.map_err(|fault| thrown(&fault)))
            }
            Fin::Claude(session_id, ran) => AgentStartAnswer::Run(match ran {
                Ok(session) => Ok(Box::new(ClaudeHandle {
                    session,
                    sh: self.sh.clone(),
                    session_id,
                })),
                Err(fault) => Err(runner_error(fault)),
            }),
        }
    }
}

// ---- the skill tools and the relays ---------------------------------------------------

/// `AgentSkillToolsDeps` of one session's skill tools
struct SkillDeps<'a> {
    host: &'a mut Host,
    manager: &'a AgentManager,
    shown: &'a mut AgentWindowShown,
    owner: ViewId,
    session_id: &'a str,
}

impl AgentSkillToolsDeps for SkillDeps<'_> {
    fn window_open(&mut self) -> bool {
        agent_live_owner(&*self.host, i64::from(self.owner.0))
    }

    fn send_to_window(&mut self, channel: &str, payload: &serde_json::Value) {
        let Some(channel) = main_core::shell::agent::agent_api::AGENT_CHANNELS
            .iter()
            .find(|(_, name)| *name == channel)
            .map(|(_, name)| *name)
        else {
            return;
        };
        let mut payload = from_json(&json_value_from_serde(payload));
        if Some(channel) == main_core::shell::agent::agent_api::agent_channel("skillProposal") {
            with_unset_card_keys(&mut payload);
        }
        self.host
            .sh
            .services
            .events
            .emit(Target::View(self.owner), channel, vec![payload]);
    }

    fn list_skills(&mut self) -> Option<Result<Vec<AgentSkillListEntry>, Failure>> {
        Some(self.host.sh.svc.list_skills().map_err(Failure))
    }

    fn session_skills(&mut self) -> Vec<AgentSessionSkillName> {
        // `manager?.skillsOf(session.ownerId, session.sessionId) ?? []`
        self.manager
            .skills_of(i64::from(self.owner.0), self.session_id)
            .iter()
            .map(|skill| AgentSessionSkillName {
                id: skill.id.clone(),
                name: skill.name.clone(),
            })
            .collect()
    }

    fn keep(&mut self, shown: ShownProposal) {
        self.shown.keep(shown);
    }

    fn new_key(&mut self) -> String {
        self.host.sh.svc.random_uuid()
    }
}

impl Inner {
    /// `proposeSkill` of a session's skill tools
    fn propose_skill(
        &self,
        session: &SessionRef,
        project_root: &str,
        input: &AgentSkillProposalInput,
        tabs: &[AgentOpenTab],
    ) -> Result<(), String> {
        let World {
            host,
            manager,
            shown,
            ..
        } = &mut *self.world.borrow_mut();
        let tools = AgentSkillTools {
            session: SkillSession {
                owner_id: i64::from(session.owner.0),
                session_id: &session.session_id,
            },
            project_root,
            platform: PLATFORM,
        };
        let mut deps = SkillDeps {
            host,
            manager,
            shown,
            owner: session.owner,
            session_id: &session.session_id,
        };
        tools.propose_skill(input, tabs, &mut deps)
    }

    /// `proposeInstall` of a session's skill tools
    fn propose_install(
        &self,
        session: &SessionRef,
        project_root: &str,
        address: &str,
    ) -> Result<(), String> {
        let World {
            host,
            manager,
            shown,
            ..
        } = &mut *self.world.borrow_mut();
        let tools = AgentSkillTools {
            session: SkillSession {
                owner_id: i64::from(session.owner.0),
                session_id: &session.session_id,
            },
            project_root,
            platform: PLATFORM,
        };
        let mut deps = SkillDeps {
            host,
            manager,
            shown,
            owner: session.owner,
            session_id: &session.session_id,
        };
        tools.propose_install(address, &mut deps)
    }

    /// A relay's question about a call of an `ask` tool: a card in the session's window
    fn relay_ask(
        &self,
        session_id: &str,
        token: u64,
        request: &RelayAskRequest,
        done: Box<dyn FnOnce(RelayAnswer) + Send>,
    ) {
        let w = &mut *self.world.borrow_mut();
        match w
            .manager
            .relay_ask(&mut w.host.io, session_id, request, false)
        {
            RelayAsk::Settled(answer) => done(answer),
            RelayAsk::Pending(id) => {
                w.host
                    .io
                    .tokens
                    .insert((session_id.to_owned(), token), id.clone());
                w.host.io.waiters.insert(id, done);
            }
        }
    }

    /// The signal of a pending question aborted
    fn relay_ask_aborted(&self, session_id: &str, token: u64) {
        let w = &mut *self.world.borrow_mut();
        if let Some(id) = w.host.io.tokens.remove(&(session_id.to_owned(), token)) {
            w.manager.relay_ask_aborted(&mut w.host.io, session_id, &id);
        }
    }
}
