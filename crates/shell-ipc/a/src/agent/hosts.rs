//! What the agent window and its sessions reach outside `main-core` and the
//! shared hosts: the window itself (batch W's window host) and the shell's own
//! services (`configureAgentWindow`'s `deps` in `apps/shell/src/main/index.ts`).
//!
//! The port runs on the core thread ([`super::machine`]) and never blocks it,
//! so [`AgentServices`] has two kinds of method, told apart in each doc line:
//!
//! - *core*: called on the core thread, in a handler, and must return at once
//!   (read a value, drive an already synchronous service such as
//!   `SkillsCore::list`); core-thread state is reachable directly;
//! - *worker*: the awaited calls of a session start (`startAppMcp`,
//!   `startRelays`, `buildAgentSkillBundle`, `startClaudeAgentSession`) and a
//!   program taking a message. Called on a worker thread, they may block; one
//!   that needs core-thread state asks the core thread with
//!   `shell_contract::runtime::run_on` and waits, which cannot deadlock
//!   because the core thread is not waiting for it.

use std::sync::Arc;

use jscompat::JsonValue;
use main_core::packages::ai_provider::agent_session_program_problem::AgentProgramProblem;
use main_core::shell::agent::agent_session_folders::ExecRequest;
use main_core::shell::agent::agent_sessions::{
    AgentMcpRelay, AgentSessionOptions, AgentSkillBundle, RelayAnswer, RelayAskRequest,
};
use main_core::shell::agent::agent_skills::{
    AgentOpenTab, AgentSkillListEntry, AgentSkillProposalInput, DeckEntry,
};
use main_core::shell::agent::agent_window::{TemplatePreviewInput, TemplatePreviewOutcome};
use shell_contract::ViewId;

/// The window and the session an agent call belongs to: `AgentMcpSession`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRef {
    /// the `webContents.id` of the agent window's page
    pub owner: ViewId,
    pub session_id: String,
}

/// A thrown `Error`: its `name` and `code`, never its text
#[derive(Debug, Clone, PartialEq)]
pub struct Fault {
    pub name: String,
    pub code: Option<String>,
    pub message: String,
}

impl Fault {
    pub fn new(message: impl Into<String>) -> Self {
        Fault {
            name: "Error".into(),
            code: None,
            message: message.into(),
        }
    }
}

/// What a program's runner throws: an `AgentProgramError` carrying a
/// problem, or any other error (with the `kind` of an `AiRunError`)
#[derive(Debug, Clone, PartialEq)]
pub struct RunnerFault {
    pub problem: Option<AgentProgramProblem>,
    pub kind: Option<String>,
    pub fault: Fault,
}

/// What `startAgentMcpServer` answers: the address and token the program is
/// given, and the way to stop the server
///
/// `stop` is called on the core thread when the session ends: it must return at
/// once (hand a slow shutdown to a worker).
pub struct AppMcpStarted {
    pub url: String,
    pub token: String,
    pub stop: Box<dyn FnOnce() + Send>,
}

/// What `startAgentMcpRelays` answers
///
/// `stop` is called on the core thread: it must return at once.
pub struct RelaysStarted {
    pub relays: Vec<AgentMcpRelay>,
    pub keep_results_inside: Vec<String>,
    pub stop: Box<dyn FnOnce() + Send>,
}

/// `AgentSkillToolHooks` of one session: the two skill tools of the session's
/// app MCP server call these. The call never blocks: `done` is called, on any
/// thread, when the card or the proposal was shown (`Ok`) or could not be
/// (`Err` is the message of the thrown `Error`)
pub trait SkillHooks: Send + Sync {
    /// `proposeSkill(input, context)`; `tabs` is what `await context.openTabs()`
    /// answered (an empty list where it rejected)
    fn propose_skill(
        &self,
        input: AgentSkillProposalInput,
        tabs: Vec<AgentOpenTab>,
        done: Box<dyn FnOnce(Result<(), String>) + Send>,
    );
    /// `proposeInstall(address)`
    fn propose_install(&self, address: String, done: Box<dyn FnOnce(Result<(), String>) + Send>);
}

/// The `ask` of `startAgentMcpRelays`: a card in the agent window asks the
/// person about a call of an `ask` tool. Never blocks: `done` is called, on
/// any thread, with the person's answer. The answer is the token of
/// [`RelayAsker::abort`]
pub trait RelayAsker: Send + Sync {
    fn ask(&self, request: RelayAskRequest, done: Box<dyn FnOnce(RelayAnswer) + Send>) -> u64;
    /// the call's `signal` aborted: a refusal follows through `done`
    fn abort(&self, token: u64);
}

/// A running Claude Code session (`AgentSession` of `claude.ts`)
///
/// `send` is called on a worker and may block until the program accepts the
/// message; every other method is called on the core thread and must return at
/// once.
pub trait ClaudeSession: Send + Sync {
    /// `send(text)`; `Err` is the message of the rejection
    fn send(&self, text: &str) -> Result<(), String>;
    /// `answer(id, { allow, scope? | message? })`
    fn answer(&self, id: &str, allow: bool, scope: Option<&str>, message: Option<&str>);
    fn set_open_documents(&self, paths: &[String]);
    fn stop(&self);
}

/// The services the agent window's `deps` give. TypeScript function each
/// method stands for in its doc line; *core* or *worker* says on which thread
/// it is called (see the module doc).
pub trait AgentServices: Send + Sync {
    /// core: `currentLang()`
    fn lang(&self) -> String;
    /// core: `currentTheme()`: `light`, `dark` or `system`. Batch M answers the theme
    /// channels of the other apps from the same value; `agent-window:get-theme`
    /// is a channel of this port, so this is where M's theme reaches it
    fn theme(&self) -> String;
    /// core: `sharedSubscriptionStatuses()`
    fn statuses(&self) -> JsonValue;
    /// core: `readStoredAiSettings()`
    fn ai_settings(&self) -> JsonValue;
    /// core: `[...tabManager.openFilePaths(), ...detachedFilePaths()]`
    fn open_documents(&self) -> Vec<String>;
    /// core: `routeDocumentPath(path)`: false when nothing could open it
    fn open_path(&self, path: &str) -> bool;
    /// core: `userSkills.list()`
    fn list_skills(&self) -> Result<Vec<AgentSkillListEntry>, String>;
    /// core: `userSkills.enabledForAgent(folder)`: the skills as the skills service
    /// lists them (`id`, `name`, `title`, `description`, `dir`, `source`, ...)
    fn enabled_for_agent(&self, folder: &str) -> Result<Vec<JsonValue>, String>;
    /// worker: `buildAgentSkillBundle(skills, dir)` of `packages/ai-provider/src/agent-session/skills.ts`
    fn build_skill_bundle(
        &self,
        skills: &[JsonValue],
        dir: &str,
    ) -> Result<Option<AgentSkillBundle>, Fault>;
    /// core: `templateTabs.openPreview(owner, input)`; `owner` is the agent window's page
    fn open_template_preview(
        &self,
        owner: ViewId,
        input: &TemplatePreviewInput,
    ) -> Result<TemplatePreviewOutcome, String>;
    /// core: `startAgentMcpServer({ ...mcp, skillTools }, projectRoot)` is given: whether the app has editors to offer
    fn has_app_mcp(&self) -> bool;
    /// worker: `startAgentMcpServer(...)`; `hooks` are the `skillTools` of the session
    fn start_app_mcp(
        &self,
        project_root: &str,
        session: &SessionRef,
        hooks: Arc<dyn SkillHooks>,
    ) -> Result<AppMcpStarted, Fault>;
    /// core: whether `userMcp` is given (the hub of the person's MCP servers)
    fn has_user_mcp(&self) -> bool;
    /// worker: `startAgentMcpRelays({ hub, ask, caller: 'agent:<sessionId>', version })`; an
    /// absent hub answers no relays
    fn start_relays(
        &self,
        session: &SessionRef,
        ask: Arc<dyn RelayAsker>,
    ) -> Result<RelaysStarted, Fault>;
    /// worker: `startClaudeAgentSession(options, onEvent)`; `on_event` takes an
    /// `AgentSessionEvent` as its JSON
    fn run_claude(
        &self,
        options: &AgentSessionOptions,
        on_event: Arc<dyn Fn(JsonValue) + Send + Sync>,
    ) -> Result<Arc<dyn ClaudeSession>, RunnerFault>;
    /// core: `assertZipInflatesWithinLimits(bytes, PPTX_ZIP_LIMITS)` then
    /// `JSZip.loadAsync(bytes)`: the entries of the archive
    fn deck_open(&self, bytes: &[u8]) -> Result<Vec<DeckEntry>, String>;
    /// core: `entry.async('string')` of the entry at `index` of the archive last opened
    fn deck_text(&self, index: usize) -> Result<String, String>;
    /// core: `randomUUID()`: the ids of sessions, relay questions and skill cards
    fn random_uuid(&self) -> String {
        super::machine::uuid_v4()
    }
    /// core: `process.kill(pid, 0)` did not throw, or threw `EPERM`
    fn process_alive(&self, pid: f64) -> bool;
    /// core: `execFile(file, args, { cwd, timeout, windowsHide: true, maxBuffer })` to its end:
    /// what the program wrote to stdout, empty where it failed
    fn exec_file(&self, request: &ExecRequest) -> String;
}

pub type AgentServicesHost = Arc<dyn AgentServices>;

/// What the agent window's frame is, as batch W's window host makes it
/// (`openAgentWindow` of `agent-window.ts`)
pub trait AgentWindowFrame: Send + Sync {
    /// The page of the open agent window; `None` when there is none (`win` is null,
    /// the TypeScript's `closed` listener ran)
    fn view(&self) -> Option<ViewId>;
    /// `win.isMinimized()`
    fn is_minimized(&self) -> bool;
    /// `win.restore()` when `restore`, then `win.show()` and `win.focus()`
    fn reveal(&self, restore: bool);
    /// `agentText(lang, 'windowTitle')`: the renderer's string table
    fn window_title(&self, lang: &str) -> String;
    /// `join(__dirname, '../preload/agent.js')`
    fn preload_path(&self) -> String;
    /// `process.env.ELECTRON_RENDERER_URL`
    fn renderer_url(&self) -> Option<String>;
    /// `join(__dirname, '../renderer/agent.html')`
    fn built_file(&self) -> String;
    /// `new BrowserWindow(options)`, `removeMenu()`, the window-open handler that
    /// hands a safe URL to the OS and denies the window, show on `ready-to-show`,
    /// then the load (`{ url }` or `{ file }`). `options` and `load` are what
    /// `agent_window_options` and `agent_window_load` answered. The window ending
    /// is the view's destruction (`Views::on_destroyed`)
    fn create(&self, options: &serde_json::Value, load: &serde_json::Value) -> ViewId;
}

pub type AgentWindowFrameHost = Arc<dyn AgentWindowFrame>;

/// What other batches call on the agent window, through `Provided` on the
/// core thread (`Rc`: the port's state lives there). Every method returns at
/// once.
pub trait AgentWindowControl {
    /// the handler of `AGENT_HOME_OPEN_CHANNEL` (`home:open-agent-window`): Home
    /// opens the window, nothing else may
    fn open_from_home(&self, sender: ViewId);
    /// `openAgentWindow()`
    fn open(&self);
    /// `isAgentWindowContents(sender)`
    fn is_window_contents(&self, view: ViewId) -> bool;
    /// `stopAgentSessions()`: the app is quitting
    fn stop_sessions(&self);
}
