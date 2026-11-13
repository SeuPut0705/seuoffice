//! `apps/shell/src/main/agent/agent-window.ts`: the agent window (decision
//! 0032), a window of its own beside the main one. What stays in TypeScript:
//! `new BrowserWindow`, `dialog`, `shell.openExternal`, `app.getVersion`,
//! `ipcMain.handle` and the window's events, the sessions' manager
//! (`createAgentManager`), the MCP relays (`startAgentMcpRelays`) and the
//! localized window title (`agentText(lang, 'windowTitle')` is the renderer's
//! string table, handed to [`agent_window_options`]). What moves is every
//! decision the handlers and the open/emit paths make.
//!
//! The module state of the TypeScript (`deps`, `win`, `manager`,
//! `shownProposals`) is the caller's: the window, the services and the
//! manager are the caller's [`AgentWindowHost`], the cards shown are an
//! [`AgentWindowShown`] it keeps. A page is told apart by its `webContents`
//! id (two pages never share one). Each `ipcMain.handle` body of
//! `registerIpc` is the function named after its channel here (`agent_send`
//! for `AGENT_CHANNELS.send`), `agent_emit` is the `emit` of
//! `configureAgentWindow` and `agent_window_reuse`, `agent_window_options`
//! and `agent_window_load` are what `openAgentWindow` decides; promises are
//! plain calls and a throw of a service is a [`Failure`]. The clock of the
//! crash log comes from the caller.

use jscompat::node_path::host::{is_absolute, join};
use jscompat::{JsMap, JsObject, JsonValue, json_value_to_serde, math_min, slice_utf16, trim};
use serde::Serialize;
use serde_json::{Value, json};

use crate::packages::ai_provider::agent_session_program_problem::AgentProgramProblem;
use crate::packages::i18n::product_name;
use crate::shell::agent::agent_api::{
    AGENT_BLOCKED_PROVIDERS, AGENT_MODES, AGENT_PROVIDERS, AGENT_WARNING_VERSION, AgentPrefs,
    AgentProjectPrefs, AgentProjectPrefsPatch, AgentProjectSkillsView, AgentStartFailure,
    agent_channel, agent_project_prefs_patch, agent_start_failure_code, normalize_agent_prefs,
    with_recent_folder,
};
use crate::shell::agent::agent_sessions::{agent_protected_paths, openable_project_file};
use crate::shell::agent::agent_skills::{
    AgentOpenTab, AgentSessionSkill, AgentSessionSkillName, AgentSkillListEntry,
    AgentSkillProposalInput, AgentSkillProposalResult, AgentTemplateCandidate, DeckArchive,
    SkillProposal, TemplateCandidateOptions, TemplateReadGuard, TemplateReadRefusal,
    TemplateRedaction, agent_skill_proposal_of, agent_template_candidates, candidate_view,
    read_template_candidate, template_redaction_of,
};
use crate::shell::app_settings::{
    AgentProjectPref, read_agent_project_pref, write_agent_project_pref,
};
use crate::shell::crash_log::{CRASH_LOG_FILE, CRASH_LOG_MAX_BYTES, CrashEntry, append_crash_log};
use crate::shell::renderer_disposal::Failure;

// ---- small decisions ------------------------------------------------------

/// what a Codex session gets from the folder's remembered choices
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStartChoices {
    pub web_search: String,
    pub network: bool,
}

/// `agentCodexStartChoices(provider, prefs)`: its web search and whether
/// commands reach the internet; Claude Code takes neither
pub fn agent_codex_start_choices(
    provider: &str,
    prefs: &AgentProjectPrefs,
) -> Option<CodexStartChoices> {
    (provider == "codex").then(|| CodexStartChoices {
        web_search: prefs.codex_web_search.clone(),
        network: prefs.codex_network,
    })
}

/// `AgentPermissionAnswer`: the person's answer as the session takes it
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionAnswer {
    Deny,
    /// `scope` is `"once"` or `"session"`
    Allow {
        scope: &'static str,
    },
}

impl PermissionAnswer {
    pub fn to_json(self) -> Value {
        match self {
            PermissionAnswer::Deny => json!({ "allow": false }),
            PermissionAnswer::Allow { scope } => json!({ "allow": true, "scope": scope }),
        }
    }
}

/// `agentPermissionAnswer(allow, scope)`: only an allow can last the session
pub fn agent_permission_answer(
    allow: Option<&JsonValue>,
    scope: Option<&JsonValue>,
) -> PermissionAnswer {
    if allow != Some(&JsonValue::Bool(true)) {
        return PermissionAnswer::Deny;
    }
    PermissionAnswer::Allow {
        scope: if scope == Some(&JsonValue::String("session".to_owned())) {
            "session"
        } else {
            "once"
        },
    }
}

/// one own property of an object value, `undefined` as `None`
fn own<'a>(value: Option<&'a JsonValue>, key: &str) -> Option<&'a JsonValue> {
    match value {
        Some(JsonValue::Object(object)) => object.get(key),
        _ => None,
    }
}

/// `typeof value === 'string'`
fn string_of(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(text)) => Some(text),
        _ => None,
    }
}

/// `typeof folder === 'string' && isAbsolute(folder)`
fn absolute_folder(folder: Option<&JsonValue>) -> Option<&str> {
    string_of(folder).filter(|folder| is_absolute(folder))
}

/// `agentEventView(event)`: what the window shows of an event, no program
/// output beyond the model's own words
pub fn agent_event_view(event: &JsonValue) -> Value {
    let get = |key: &str| own(Some(event), key);
    let mut view = serde_json::Map::new();
    match string_of(get("type")) {
        Some("started") => {
            view.insert("type".into(), json!("started"));
            if let Some(provider) = get("provider") {
                view.insert("provider".into(), json_value_to_serde(provider));
            }
            if let Some(model) = get("model") {
                view.insert("model".into(), json_value_to_serde(model));
            }
            if let Some(skills) = get("skills")
                && let Some(length) = skills.get("length")
            {
                view.insert("skills".into(), json_value_to_serde(&length));
            }
        }
        Some("permission") => {
            view.insert("type".into(), json!("permission"));
            let request = get("request");
            if let Some(id) = own(request, "id") {
                view.insert("id".into(), json_value_to_serde(id));
            }
            let mut action = serde_json::Map::new();
            if let Some(JsonValue::Object(request)) = request {
                for (key, value) in request.entries() {
                    if key != "id" && key != "provider" {
                        action.insert(key.to_owned(), json_value_to_serde(value));
                    }
                }
            }
            view.insert("action".into(), Value::Object(action));
        }
        Some("error") => {
            // the message can carry program output (paths, diagnostics); the window shows the kind
            view.insert("type".into(), json!("error"));
            if let Some(kind) = get("kind") {
                view.insert("kind".into(), json_value_to_serde(kind));
            }
        }
        Some("documents-unprotected") => {
            view.insert("type".into(), json!("documents-unprotected"));
            if let Some(paths) = get("paths")
                && let Some(length) = paths.get("length")
            {
                view.insert("count".into(), json_value_to_serde(&length));
            }
        }
        _ => return json_value_to_serde(event),
    }
    Value::Object(view)
}

/// one program's entry of `statuses` (`AiSubscriptionStatus`): its `state`
/// and whether it says `meteredAccepted: true`
#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionStatus {
    pub state: String,
    pub metered_accepted: bool,
}

/// `agentConnections(statuses, meteredAccepted, blocked)`: whether each program
/// can start a session now, as the window offers it, in `AGENT_PROVIDERS` order
pub fn agent_connections(
    statuses: &JsObject<SubscriptionStatus>,
    metered_accepted: Option<&JsObject<bool>>,
    blocked: &[&str],
) -> Vec<(&'static str, &'static str)> {
    let mut out = Vec::new();
    for provider in AGENT_PROVIDERS {
        let status = statuses.get(provider);
        let connection = if blocked.contains(&provider) {
            "blocked"
        } else {
            match status {
                None => "checking",
                Some(status) => match status.state.as_str() {
                    "checking" => "checking",
                    "off" => "off",
                    "ready" => "ready",
                    "metered"
                        if status.metered_accepted
                            && metered_accepted.and_then(|m| m.get(provider)) == Some(&true) =>
                    {
                        "metered-accepted"
                    }
                    _ => "unavailable",
                },
            }
        };
        out.push((provider, connection));
    }
    out
}

/// the connections as the object of `AgentInit`
fn connections_json(connections: &[(&'static str, &'static str)]) -> Value {
    let mut object = serde_json::Map::new();
    for (provider, connection) in connections {
        object.insert((*provider).to_owned(), json!(connection));
    }
    Value::Object(object)
}

// ---- the window and its services ---------------------------------------

/// a window as the handlers read it: `isDestroyed()` and its page's id
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowState {
    pub destroyed: bool,
    pub contents_id: i64,
}

/// A card shown in the window: its session and the template candidates it offered
#[derive(Debug, Clone, PartialEq)]
pub struct ShownProposal {
    pub owner_id: i64,
    pub session_id: String,
    pub proposal: SkillProposal,
    pub candidates: Vec<AgentTemplateCandidate>,
}

/// Cards kept for their template buttons; the oldest go first
const MAX_SHOWN_PROPOSALS: usize = 20;

/// `shownProposals`
#[derive(Debug, Default)]
pub struct AgentWindowShown {
    cards: JsMap<ShownProposal>,
}

impl AgentWindowShown {
    pub fn new() -> Self {
        Self::default()
    }

    /// `keepProposal(shown)`
    pub fn keep(&mut self, shown: ShownProposal) {
        self.cards.set(shown.proposal.key.clone(), shown);
        while self.cards.len() > MAX_SHOWN_PROPOSALS {
            let Some(oldest) = self.cards.keys().next().map(str::to_owned) else {
                break;
            };
            self.cards.delete(&oldest);
        }
    }

    /// `shownProposals.get(key)`
    pub fn get(&self, key: &str) -> Option<&ShownProposal> {
        self.cards.get(key)
    }

    pub fn len(&self) -> usize {
        self.cards.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cards.is_empty()
    }
}

/// `AgentTemplatePreviewOpener`'s input
#[derive(Debug, Clone, PartialEq)]
pub struct TemplatePreviewInput {
    pub bytes: Vec<u8>,
    pub file_name: String,
    pub title: String,
    pub tab_title: String,
    pub text: String,
    pub original_redacted: bool,
    pub proposal: SkillProposal,
    pub draft: Option<JsonValue>,
}

/// `UserSkillsResult<{ tabId, previewId }>`
#[derive(Debug, Clone, PartialEq)]
pub enum TemplatePreviewOutcome {
    Opened { tab_id: String, preview_id: String },
    Refused { reason: String },
}

/// What `createAgentManager` answers to a start
#[derive(Debug, Clone, PartialEq)]
pub enum AgentStartOutcome {
    Started {
        session_id: String,
        skills: Vec<AgentSessionSkill>,
        mcp_keep_inside: Option<Vec<String>>,
        instructions_truncated: Option<Vec<String>>,
    },
    Failed {
        failure: AgentStartFailure,
        cause: Option<String>,
    },
}

/// `AgentStartRequest`
#[derive(Debug, Clone, PartialEq)]
pub struct AgentStartRequest {
    pub provider: String,
    pub project_root: String,
    pub mode: String,
    pub codex: Option<CodexStartChoices>,
}

/// The window's services and its manager, as the handlers call them (the
/// `deps` and the `manager` of the TypeScript, and the Electron objects they
/// reach). A method that may throw gives a [`Failure`].
pub trait AgentWindowHost {
    /// `win`, `None` when null
    fn window(&self) -> Option<WindowState>;
    /// `deps` is set
    fn has_deps(&self) -> bool;
    /// `manager` is set
    fn has_manager(&self) -> bool;
    /// `process.platform`
    fn platform(&self) -> String;
    /// `os.homedir()`
    fn os_home_dir(&self) -> String;

    // deps
    fn lang(&self) -> String;
    fn theme(&self) -> String;
    fn statuses(&self) -> JsObject<SubscriptionStatus>;
    /// `deps.aiSettings().meteredAccepted`
    fn metered_accepted(&self) -> Option<JsObject<bool>>;
    fn read_prefs(&self) -> AgentPrefs;
    fn write_prefs(&mut self, prefs: &AgentPrefs);
    /// `deps.parentWindow()`
    fn parent_window(&self) -> Option<WindowState>;
    fn user_data(&self) -> String;
    /// `deps.homeDir`
    fn deps_home_dir(&self) -> Option<String>;
    fn open_documents(&self) -> Vec<String>;
    fn open_path(&mut self, path: &str) -> bool;
    /// `deps.readProjectPrefs?.(folder)`; `None` when the app gave none
    fn read_project_prefs_override(
        &mut self,
        folder: &str,
    ) -> Option<Result<AgentProjectPrefs, Failure>>;
    /// `deps.writeProjectPrefs?.(folder, patch)`; `None` when the app gave none
    fn write_project_prefs_override(
        &mut self,
        folder: &str,
        patch: &AgentProjectPrefsPatch,
    ) -> Option<Result<AgentProjectPrefs, Failure>>;
    /// `deps.projectSkills` is set
    fn has_project_skills(&self) -> bool;
    fn project_skills_view(&mut self, folder: &str) -> Result<AgentProjectSkillsView, Failure>;
    fn project_skills_set(
        &mut self,
        folder: &str,
        on: bool,
    ) -> Result<AgentProjectSkillsView, Failure>;
    /// `deps.openTemplatePreview` is set
    fn has_open_template_preview(&self) -> bool;
    /// `deps.openTemplatePreview(owner, input)`, `owner` the page with this id
    fn open_template_preview(
        &mut self,
        owner_id: i64,
        input: &TemplatePreviewInput,
    ) -> Result<TemplatePreviewOutcome, Failure>;

    /// `dialog.showOpenDialog(win, options)`: the result object
    fn show_open_dialog(&mut self, options: &JsObject<JsonValue>) -> JsonValue;
    /// the JSZip behind the deck check (engine-waiting)
    fn deck(&mut self) -> &mut dyn DeckArchive;

    // the manager
    fn start(&mut self, owner_id: i64, request: &AgentStartRequest) -> AgentStartOutcome;
    fn send(&mut self, owner_id: i64, session_id: &str, text: &str) -> Result<(), Failure>;
    fn answer(
        &mut self,
        owner_id: i64,
        session_id: &str,
        request_id: &str,
        answer: PermissionAnswer,
    );
    fn stop(&mut self, owner_id: i64, session_id: &str);
    fn project_root_of(&self, owner_id: i64, session_id: &str) -> Option<String>;
}

/// `ownerOf(event)`: the sender's id when it is the page of the open window
pub fn agent_owner_of(host: &dyn AgentWindowHost, sender: i64) -> Option<i64> {
    match host.window() {
        Some(win) if !win.destroyed && sender == win.contents_id => Some(sender),
        _ => None,
    }
}

/// `isAgentWindowContents(sender)`: whether the sender is the page of the open window
pub fn agent_is_window_contents(host: &dyn AgentWindowHost, sender: i64) -> bool {
    agent_owner_of(host, sender).is_some()
}

/// `liveOwner(ownerId)`: whether the window is open and still the owner of the session
pub fn agent_live_owner(host: &dyn AgentWindowHost, owner_id: i64) -> bool {
    match host.window() {
        Some(win) => !win.destroyed && win.contents_id == owner_id,
        None => false,
    }
}

/// `shownCandidate(event, proposalKey, candidateId)`: a card's candidate, asked for by the window that
/// was shown the card
pub fn agent_shown_candidate<'a>(
    host: &dyn AgentWindowHost,
    shown_cards: &'a AgentWindowShown,
    sender: i64,
    proposal_key: Option<&JsonValue>,
    candidate_id: Option<&JsonValue>,
) -> Option<(&'a ShownProposal, &'a AgentTemplateCandidate)> {
    let owner = agent_owner_of(host, sender);
    let (Some(owner), Some(key), Some(id)) =
        (owner, string_of(proposal_key), string_of(candidate_id))
    else {
        return None;
    };
    let shown = shown_cards.get(key)?;
    if shown.owner_id != owner {
        return None;
    }
    let candidate = shown.candidates.iter().find(|c| c.id == id)?;
    Some((shown, candidate))
}

/// `openInTab`: whether the candidate is open in a tab now (a PDF's marks are then the editor's)
fn open_in_tab(host: &dyn AgentWindowHost, candidate: &AgentTemplateCandidate) -> bool {
    let key = candidate.path.to_lowercase();
    candidate.from == "tab"
        || (if host.has_deps() {
            host.open_documents()
        } else {
            Vec::new()
        })
        .iter()
        .any(|path| path.to_lowercase() == key)
}

/// what `readCandidate` answers
#[derive(Debug, Clone, PartialEq)]
pub enum CandidateRead {
    Read {
        bytes: Vec<u8>,
        redaction: TemplateRedaction,
    },
    Refused(TemplateReadRefusal),
}

/// `readCandidate(candidate)`: read a candidate and tell whether it can hold a redaction mark
pub fn agent_read_candidate(
    host: &mut dyn AgentWindowHost,
    candidate: &AgentTemplateCandidate,
) -> CandidateRead {
    let deps_home = if host.has_deps() {
        host.deps_home_dir()
    } else {
        None
    };
    let home_dir = deps_home.unwrap_or_else(|| host.os_home_dir());
    let protected_paths = if host.has_deps() {
        agent_protected_paths(&home_dir, &host.user_data())
    } else {
        Vec::new()
    };
    let platform = host.platform();
    let guard = TemplateReadGuard {
        home_dir,
        protected_paths,
    };
    let bytes = match read_template_candidate(&candidate.path, &guard, &platform) {
        Ok(bytes) => bytes,
        Err(refusal) => return CandidateRead::Refused(refusal),
    };
    let in_tab = open_in_tab(host, candidate);
    let redaction = template_redaction_of(&candidate.file_name, &bytes, in_tab, host.deck());
    CandidateRead::Read { bytes, redaction }
}

// ---- the skill tools ----------------------------------------------------

/// `AgentMcpSession`: the window and the session a session's tools answer to
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentMcpSession<'a> {
    pub owner_id: i64,
    pub session_id: &'a str,
}

/// `AgentSkillToolsDeps`, and the `context.openTabs` of `proposeSkill`
pub trait AgentSkillToolsDeps {
    /// `d.window()` is not null (each call is one call of the TypeScript's)
    fn window_open(&mut self) -> bool;
    /// `owner.send(channel, payload)` on the window `d.window()` answered last
    fn send_to_window(&mut self, channel: &str, payload: &Value);
    /// `d.listSkills`: `None` when the app gave none; `Err` is a rejection
    fn list_skills(&mut self) -> Option<Result<Vec<AgentSkillListEntry>, Failure>>;
    /// `d.sessionSkills?.() ?? []`
    fn session_skills(&mut self) -> Vec<AgentSessionSkillName>;
    /// `d.keep(shown)`
    fn keep(&mut self, shown: ShownProposal);
    /// `d.newKey()`
    fn new_key(&mut self) -> String;
    /// `context.openTabs()`; `Err` is a rejection
    fn open_tabs(&mut self) -> Result<Vec<AgentOpenTab>, Failure>;
}

/// `agentSkillToolsFor(session, projectRoot, d)`: the two skill tools of one
/// session (spec 6.3, 6.4): a card or an install proposal in the session's
/// window. Nothing is written or installed here.
pub struct AgentSkillTools<'a> {
    pub session: AgentMcpSession<'a>,
    pub project_root: &'a str,
    /// `process.platform`
    pub platform: &'a str,
}

impl AgentSkillTools<'_> {
    /// `proposeSkill(input, context)`; `Err` is the message of the thrown `Error`
    pub fn propose_skill(
        &self,
        input: &AgentSkillProposalInput,
        d: &mut dyn AgentSkillToolsDeps,
    ) -> Result<(), String> {
        if !d.window_open() {
            return Err("The agent window is closed; the card cannot be shown.".to_owned());
        }
        let list = match d.list_skills() {
            Some(Ok(list)) => list,
            Some(Err(_)) | None => Vec::new(),
        };
        // the arguments of `agentSkillProposalOf` are read in order: the key before the session's skills
        let key = d.new_key();
        let session_skills = d.session_skills();
        let made = agent_skill_proposal_of(input, &list, &key, &session_skills);
        let proposal = match made {
            AgentSkillProposalResult::Ok(proposal) => proposal,
            AgentSkillProposalResult::Refused(message) => return Err(message),
        };
        // the project folder's files are still offered when the tabs cannot be read
        let tabs = d.open_tabs().unwrap_or_default();
        let (candidates, selected) = agent_template_candidates(&TemplateCandidateOptions {
            project_root: self.project_root,
            tabs: &tabs,
            suggested: &input.suggested_template_path,
            platform: self.platform,
            project_files: None,
        });
        if !d.window_open() {
            return Err("The agent window is closed; the card cannot be shown.".to_owned());
        }
        d.keep(ShownProposal {
            owner_id: self.session.owner_id,
            session_id: self.session.session_id.to_owned(),
            proposal: proposal.clone(),
            candidates: candidates.clone(),
        });
        let mut payload = serde_json::Map::new();
        payload.insert("sessionId".into(), json!(self.session.session_id));
        payload.insert(
            "proposal".into(),
            serde_json::to_value(&proposal).expect("a proposal prints"),
        );
        payload.insert(
            "candidates".into(),
            serde_json::to_value(candidates.iter().map(candidate_view).collect::<Vec<_>>())
                .expect("candidates print"),
        );
        if let Some(selected) = selected {
            payload.insert("selected".into(), json!(selected));
        }
        d.send_to_window(
            agent_channel("skillProposal").expect("a channel of AGENT_CHANNELS"),
            &Value::Object(payload),
        );
        Ok(())
    }

    /// `proposeInstall(address)`; `Err` is the message of the thrown `Error`
    pub fn propose_install(
        &self,
        address: &str,
        d: &mut dyn AgentSkillToolsDeps,
    ) -> Result<(), String> {
        if !d.window_open() {
            return Err("The agent window is closed; the proposal cannot be shown.".to_owned());
        }
        let key = d.new_key();
        d.send_to_window(
            agent_channel("installProposal").expect("a channel of AGENT_CHANNELS"),
            &json!({ "sessionId": self.session.session_id, "key": key, "address": address }),
        );
        Ok(())
    }
}

// ---- starting a session ----------------------------------------------------

/// the app settings file, as the shell keeps it in the data folder
fn app_settings_path(user_data: &str) -> String {
    join(&[user_data, "app-settings.json"])
}

/// the stored choices of the app settings as the window's type
fn prefs_of(stored: AgentProjectPref) -> AgentProjectPrefs {
    AgentProjectPrefs {
        codex_web_search: stored.codex_web_search,
        codex_network: stored.codex_network,
    }
}

/// `readProjectPrefsOf(d, folder)`: the app's own reader, or the app settings file
fn read_project_prefs_of(
    host: &mut dyn AgentWindowHost,
    folder: &str,
) -> Result<AgentProjectPrefs, Failure> {
    if let Some(read) = host.read_project_prefs_override(folder) {
        return read;
    }
    Ok(prefs_of(read_agent_project_pref(
        &app_settings_path(&host.user_data()),
        folder,
    )))
}

/// `writeProjectPrefsOf(d, folder, patch)`
fn write_project_prefs_of(
    host: &mut dyn AgentWindowHost,
    folder: &str,
    patch: &AgentProjectPrefsPatch,
) -> Result<AgentProjectPrefs, Failure> {
    if let Some(write) = host.write_project_prefs_override(folder, patch) {
        return write;
    }
    write_agent_project_pref(
        &app_settings_path(&host.user_data()),
        folder,
        &patch.to_json(),
    )
    .map(prefs_of)
    .map_err(|error| Failure(format!("{error:?}")))
}

fn failed(failure: &AgentStartFailure) -> Value {
    json!({ "ok": false, "failure": json_value_to_serde(&failure.to_json()) })
}

/// `startAgentForWindow(d, m, owner, request)`: the response of the `start`
/// channel; `now_ms` is the clock of the crash log
pub fn start_agent_for_window(
    host: &mut dyn AgentWindowHost,
    owner: i64,
    request: Option<&JsonValue>,
    now_ms: f64,
) -> Value {
    let provider = string_of(own(request, "provider"));
    let mode = string_of(own(request, "mode"));
    let folder = string_of(own(request, "folder")).unwrap_or("");
    let (Some(provider), Some(mode)) = (provider, mode) else {
        return failed(&AgentStartFailure::InvalidRequest);
    };
    if !AGENT_PROVIDERS.contains(&provider) || !AGENT_MODES.contains(&mode) {
        return failed(&AgentStartFailure::InvalidRequest);
    }
    if AGENT_BLOCKED_PROVIDERS.contains(&provider) {
        return failed(&AgentStartFailure::ProviderBlocked);
    }
    let prefs = host.read_prefs();
    // the warning is a precondition the main process checks, not only the window
    if prefs.warning_accepted < AGENT_WARNING_VERSION {
        return failed(&AgentStartFailure::NotAccepted);
    }
    // the folder's remembered Codex choices, read here rather than taken from the window
    let codex = match read_project_prefs_of(host, folder) {
        Ok(project_prefs) => agent_codex_start_choices(provider, &project_prefs),
        Err(_) => return failed(&AgentStartFailure::BadFolder),
    };
    let result = host.start(
        owner,
        &AgentStartRequest {
            provider: provider.to_owned(),
            project_root: folder.to_owned(),
            mode: mode.to_owned(),
            codex,
        },
    );
    let (session_id, skills, mcp_keep_inside, instructions_truncated) = match result {
        AgentStartOutcome::Failed { failure, cause } => {
            if let Some(cause) = cause {
                let mut entry: CrashEntry = JsObject::new();
                entry.set("kind", JsonValue::String("agent-start".to_owned()));
                entry.set("program", JsonValue::String(provider.to_owned()));
                entry.set(
                    "reason",
                    JsonValue::String(agent_start_failure_code(&failure)),
                );
                entry.set("cause", JsonValue::String(cause));
                if let AgentStartFailure::ProgramProblem {
                    problem:
                        AgentProgramProblem::Exited {
                            exit_code: Some(exit_code),
                        },
                } = &failure
                {
                    entry.set("exitCode", JsonValue::Number(*exit_code));
                }
                let log = join(&[&host.user_data(), CRASH_LOG_FILE]);
                let _ = append_crash_log(&log, &entry, CRASH_LOG_MAX_BYTES, now_ms);
            }
            return failed(&failure);
        }
        AgentStartOutcome::Started {
            session_id,
            skills,
            mcp_keep_inside,
            instructions_truncated,
        } => (session_id, skills, mcp_keep_inside, instructions_truncated),
    };
    let mut next = prefs;
    next.provider = provider.to_owned();
    next.mode = mode.to_owned();
    host.write_prefs(&with_recent_folder(&next, folder));
    let mut response = serde_json::Map::new();
    response.insert("ok".into(), json!(true));
    response.insert("sessionId".into(), json!(session_id));
    response.insert(
        "skills".into(),
        serde_json::to_value(&skills).expect("skills print"),
    );
    // an empty list is still a list: the TypeScript tests the array, not its length
    if let Some(inside) = mcp_keep_inside {
        response.insert("mcpKeepInside".into(), json!(inside));
    }
    if let Some(truncated) = instructions_truncated {
        response.insert("instructionsTruncated".into(), json!(truncated));
    }
    Value::Object(response)
}

// ---- the handlers ------------------------------------------------------------

/// the `getInit` handler: what the window starts from, `None` for null
pub fn agent_get_init(host: &dyn AgentWindowHost, sender: i64) -> Option<Value> {
    if agent_owner_of(host, sender).is_none() || !host.has_deps() {
        return None;
    }
    let lang = host.lang();
    let prefs = json_value_to_serde(&host.read_prefs().to_json());
    let connections = agent_connections(
        &host.statuses(),
        host.metered_accepted().as_ref(),
        &AGENT_BLOCKED_PROVIDERS,
    );
    Some(json!({
        "lang": lang,
        "prefs": prefs,
        "connections": connections_json(&connections),
    }))
}

/// the `getTheme` handler
pub fn agent_get_theme(host: &dyn AgentWindowHost) -> String {
    if host.has_deps() {
        host.theme()
    } else {
        "system".to_owned()
    }
}

/// the Home-open handler: Home opens the window; nothing else may
pub fn agent_home_may_open(host: &dyn AgentWindowHost, sender: i64) -> bool {
    if !host.has_deps() {
        return false;
    }
    match host.parent_window() {
        Some(home) => !home.destroyed && sender == home.contents_id,
        None => false,
    }
}

/// the `pickFolder` handler: the folder the person picked, `None` for null
pub fn agent_pick_folder(host: &mut dyn AgentWindowHost, sender: i64) -> Option<String> {
    agent_owner_of(host, sender)?;
    let mut options: JsObject<JsonValue> = JsObject::new();
    options.set(
        "properties",
        JsonValue::Array(vec![JsonValue::String("openDirectory".to_owned())]),
    );
    let picked = host.show_open_dialog(&options);
    let canceled = picked.get("canceled").is_some_and(|c| c.truthy());
    let first = picked.get("filePaths").and_then(|paths| {
        paths.get("0").and_then(|first| match first.as_ref() {
            JsonValue::String(path) if !path.is_empty() => Some(path.clone()),
            _ => None,
        })
    });
    if canceled { None } else { first }
}

/// the `setPrefs` handler: the preferences as stored, `None` for null
pub fn agent_set_prefs(
    host: &mut dyn AgentWindowHost,
    sender: i64,
    update: Option<&JsonValue>,
) -> Option<AgentPrefs> {
    if agent_owner_of(host, sender).is_none() || !host.has_deps() {
        return None;
    }
    let current = host.read_prefs();
    let JsonValue::Object(mut merged) = current.to_json() else {
        return None;
    };
    if let Some(JsonValue::Object(update)) = update {
        merged.assign(update);
    }
    let patch = normalize_agent_prefs(Some(&JsonValue::Object(merged)));
    // the window cannot add folders to the list or claim a newer warning than it showed
    let next = AgentPrefs {
        provider: patch.provider.clone(),
        mode: patch.mode.clone(),
        recent_folders: current
            .recent_folders
            .iter()
            .filter(|folder| patch.recent_folders.contains(folder))
            .cloned()
            .collect(),
        warning_accepted: math_min(patch.warning_accepted, AGENT_WARNING_VERSION),
    };
    host.write_prefs(&next);
    Some(next)
}

/// the `getProjectPrefs` handler
pub fn agent_get_project_prefs(
    host: &mut dyn AgentWindowHost,
    sender: i64,
    folder: Option<&JsonValue>,
) -> Option<AgentProjectPrefs> {
    if agent_owner_of(host, sender).is_none() || !host.has_deps() {
        return None;
    }
    let folder = absolute_folder(folder)?;
    read_project_prefs_of(host, folder).ok()
}

/// the `setProjectPrefs` handler
pub fn agent_set_project_prefs(
    host: &mut dyn AgentWindowHost,
    sender: i64,
    folder: Option<&JsonValue>,
    patch: Option<&JsonValue>,
) -> Option<AgentProjectPrefs> {
    if agent_owner_of(host, sender).is_none() || !host.has_deps() {
        return None;
    }
    let folder = absolute_folder(folder)?;
    write_project_prefs_of(host, folder, &agent_project_prefs_patch(patch)).ok()
}

/// the `getProjectSkills` handler
pub fn agent_get_project_skills(
    host: &mut dyn AgentWindowHost,
    sender: i64,
    folder: Option<&JsonValue>,
) -> Option<AgentProjectSkillsView> {
    if agent_owner_of(host, sender).is_none() || !host.has_project_skills() {
        return None;
    }
    let folder = absolute_folder(folder)?;
    host.project_skills_view(folder).ok()
}

/// the `setProjectSkills` handler
pub fn agent_set_project_skills(
    host: &mut dyn AgentWindowHost,
    sender: i64,
    folder: Option<&JsonValue>,
    on: Option<&JsonValue>,
) -> Option<AgentProjectSkillsView> {
    if agent_owner_of(host, sender).is_none() || !host.has_project_skills() {
        return None;
    }
    let folder = absolute_folder(folder)?;
    host.project_skills_set(folder, on == Some(&JsonValue::Bool(true)))
        .ok()
}

/// the `start` handler
pub fn agent_start(
    host: &mut dyn AgentWindowHost,
    sender: i64,
    request: Option<&JsonValue>,
    now_ms: f64,
) -> Value {
    let owner = agent_owner_of(host, sender);
    let Some(owner) = owner.filter(|_| host.has_deps() && host.has_manager()) else {
        return failed(&AgentStartFailure::InvalidRequest);
    };
    start_agent_for_window(host, owner, request, now_ms)
}

/// the `send` handler
pub fn agent_send(
    host: &mut dyn AgentWindowHost,
    sender: i64,
    session_id: Option<&JsonValue>,
    text: Option<&JsonValue>,
) -> bool {
    let owner = agent_owner_of(host, sender);
    let (Some(owner), true, Some(session_id), Some(text)) = (
        owner,
        host.has_manager(),
        string_of(session_id),
        string_of(text),
    ) else {
        return false;
    };
    if trim(text).is_empty() {
        return false;
    }
    host.send(owner, session_id, text).is_ok()
}

/// the `answer` handler
pub fn agent_answer(
    host: &mut dyn AgentWindowHost,
    sender: i64,
    session_id: Option<&JsonValue>,
    request_id: Option<&JsonValue>,
    allow: Option<&JsonValue>,
    scope: Option<&JsonValue>,
) {
    let owner = agent_owner_of(host, sender);
    let (Some(owner), true, Some(session_id), Some(request_id)) = (
        owner,
        host.has_manager(),
        string_of(session_id),
        string_of(request_id),
    ) else {
        return;
    };
    host.answer(
        owner,
        session_id,
        request_id,
        agent_permission_answer(allow, scope),
    );
}

/// the `stop` handler
pub fn agent_stop(host: &mut dyn AgentWindowHost, sender: i64, session_id: Option<&JsonValue>) {
    let owner = agent_owner_of(host, sender);
    let (Some(owner), true, Some(session_id)) = (owner, host.has_manager(), string_of(session_id))
    else {
        return;
    };
    host.stop(owner, session_id);
}

/// what the template channels answer when they refuse
#[derive(Debug, Clone, PartialEq)]
pub enum TemplateRefusal {
    NotFound,
    Unreadable,
    TooLarge,
    Redacted,
    Unknown,
    Invalid,
    Failed,
    /// the `reason` of a preview the opener refused
    Other(String),
}

impl TemplateRefusal {
    pub fn as_str(&self) -> &str {
        match self {
            TemplateRefusal::NotFound => "not-found",
            TemplateRefusal::Unreadable => "unreadable",
            TemplateRefusal::TooLarge => "too-large",
            TemplateRefusal::Redacted => "redacted",
            TemplateRefusal::Unknown => "unknown",
            TemplateRefusal::Invalid => "invalid",
            TemplateRefusal::Failed => "failed",
            TemplateRefusal::Other(reason) => reason,
        }
    }
}

fn refusal_of(refusal: TemplateReadRefusal) -> TemplateRefusal {
    match refusal {
        TemplateReadRefusal::Unreadable => TemplateRefusal::Unreadable,
        TemplateReadRefusal::TooLarge => TemplateRefusal::TooLarge,
    }
}

/// `AgentTemplateCheck`
#[derive(Debug, Clone, PartialEq)]
pub enum TemplateCheck {
    Ok { redaction: TemplateRedaction },
    Refused(TemplateRefusal),
}

/// the `templateCheck` handler
pub fn agent_template_check(
    host: &mut dyn AgentWindowHost,
    shown: &AgentWindowShown,
    sender: i64,
    proposal_key: Option<&JsonValue>,
    candidate_id: Option<&JsonValue>,
) -> TemplateCheck {
    let Some((_, candidate)) =
        agent_shown_candidate(host, shown, sender, proposal_key, candidate_id)
    else {
        return TemplateCheck::Refused(TemplateRefusal::NotFound);
    };
    match agent_read_candidate(host, candidate) {
        CandidateRead::Read { redaction, .. } => TemplateCheck::Ok { redaction },
        CandidateRead::Refused(refusal) => TemplateCheck::Refused(refusal_of(refusal)),
    }
}

/// `AgentTemplateAsIs`
#[derive(Debug, Clone, PartialEq)]
pub enum TemplateAsIs {
    Ok { bytes: Vec<u8>, file_name: String },
    Refused(TemplateRefusal),
}

/// the `templateAsIs` handler: "save the
/// document as it is": the bytes go to the card's Save only when no mark can
/// be in them
pub fn agent_template_as_is(
    host: &mut dyn AgentWindowHost,
    shown: &AgentWindowShown,
    sender: i64,
    proposal_key: Option<&JsonValue>,
    candidate_id: Option<&JsonValue>,
) -> TemplateAsIs {
    let Some((_, candidate)) =
        agent_shown_candidate(host, shown, sender, proposal_key, candidate_id)
    else {
        return TemplateAsIs::Refused(TemplateRefusal::NotFound);
    };
    match agent_read_candidate(host, candidate) {
        CandidateRead::Refused(refusal) => TemplateAsIs::Refused(refusal_of(refusal)),
        CandidateRead::Read { redaction, .. } if redaction != TemplateRedaction::None => {
            TemplateAsIs::Refused(match redaction {
                TemplateRedaction::Redacted => TemplateRefusal::Redacted,
                _ => TemplateRefusal::Unknown,
            })
        }
        CandidateRead::Read { bytes, .. } => TemplateAsIs::Ok {
            bytes,
            file_name: candidate.file_name.clone(),
        },
    }
}

/// `AgentTemplateBlank`
#[derive(Debug, Clone, PartialEq)]
pub enum TemplateBlank {
    Ok { tab_id: String, preview_id: String },
    Refused(TemplateRefusal),
}

/// the `templateBlank` handler: "make
/// a blank template": the copy opens in a preview tab whose AI clears it
pub fn agent_template_blank(
    host: &mut dyn AgentWindowHost,
    shown: &AgentWindowShown,
    sender: i64,
    proposal_key: Option<&JsonValue>,
    candidate_id: Option<&JsonValue>,
    request: Option<&JsonValue>,
) -> TemplateBlank {
    let found = agent_shown_candidate(host, shown, sender, proposal_key, candidate_id);
    let (Some((shown_card, candidate)), true) = (found, host.has_open_template_preview()) else {
        return TemplateBlank::Refused(TemplateRefusal::NotFound);
    };
    let tab_title = string_of(own(request, "tabTitle"))
        .map(|title| slice_utf16(title, 0.0, Some(300.0)))
        .unwrap_or_default();
    let text = string_of(own(request, "text"))
        .map(|text| slice_utf16(text, 0.0, Some(10_000.0)))
        .unwrap_or_default();
    if tab_title.is_empty() || text.is_empty() {
        return TemplateBlank::Refused(TemplateRefusal::Invalid);
    }
    let (bytes, redaction) = match agent_read_candidate(host, candidate) {
        CandidateRead::Read { bytes, redaction } => (bytes, redaction),
        CandidateRead::Refused(refusal) => return TemplateBlank::Refused(refusal_of(refusal)),
    };
    let input = TemplatePreviewInput {
        bytes,
        file_name: candidate.file_name.clone(),
        title: candidate.title.clone(),
        tab_title,
        text,
        // the preview's "save as it is" stays blocked unless the original surely has no mark
        original_redacted: redaction != TemplateRedaction::None,
        proposal: shown_card.proposal.clone(),
        draft: own(request, "draft").cloned(),
    };
    match host.open_template_preview(sender, &input) {
        Ok(TemplatePreviewOutcome::Opened { tab_id, preview_id }) => {
            TemplateBlank::Ok { tab_id, preview_id }
        }
        Ok(TemplatePreviewOutcome::Refused { reason }) => {
            TemplateBlank::Refused(TemplateRefusal::Other(reason))
        }
        Err(_) => TemplateBlank::Refused(TemplateRefusal::Failed),
    }
}

/// the `openFile` handler
pub fn agent_open_file(
    host: &mut dyn AgentWindowHost,
    sender: i64,
    session_id: Option<&JsonValue>,
    path: Option<&JsonValue>,
) -> bool {
    let owner = agent_owner_of(host, sender);
    let (Some(owner), true, true, Some(session_id), Some(path)) = (
        owner,
        host.has_manager(),
        host.has_deps(),
        string_of(session_id),
        string_of(path),
    ) else {
        return false;
    };
    let file = host
        .project_root_of(owner, session_id)
        .filter(|root| !root.is_empty())
        .and_then(|root| openable_project_file(&root, path, &host.platform()));
    match file {
        Some(file) => host.open_path(&file),
        None => false,
    }
}

// ---- events, opening ---------------------------------------------------------

/// the `emit` of `configureAgentWindow`: the payload of the `event`
/// channel, while the window is open and still the session's owner
pub fn agent_emit(
    host: &dyn AgentWindowHost,
    owner_id: i64,
    session_id: &str,
    event: &JsonValue,
) -> Option<Value> {
    if !agent_live_owner(host, owner_id) {
        return None;
    }
    Some(json!({ "sessionId": session_id, "event": agent_event_view(event) }))
}

/// `openAgentWindow`'s reuse: whether an open window is brought forward,
/// and whether it is restored first; `None` when a new one is made
pub fn agent_window_reuse(existing: Option<(bool, bool)>) -> Option<bool> {
    // `(isDestroyed, isMinimized)`
    match existing {
        Some((false, minimized)) => Some(minimized),
        _ => None,
    }
}

/// `openAgentWindow`'s options for `new BrowserWindow`: the options of the
/// window; `window_title` is the strings' `windowTitle` in `lang`
pub fn agent_window_options(lang: &str, window_title: &str, preload: &str) -> Value {
    json!({
        "width": 560,
        "height": 760,
        "minWidth": 440,
        "minHeight": 520,
        "show": false,
        "center": true,
        "fullscreenable": false,
        "autoHideMenuBar": true,
        "title": format!("{window_title} - {}", product_name(Some(lang))),
        "webPreferences": {
            "preload": preload,
            "contextIsolation": true,
            "nodeIntegration": false,
            "sandbox": true,
        },
    })
}

/// `openAgentWindow`'s load: the page the window loads
pub fn agent_window_load(renderer_url: Option<&str>, built_file: &str) -> Value {
    match renderer_url.filter(|url| !url.is_empty()) {
        Some(url) => json!({ "url": format!("{url}/agent.html") }),
        None => json!({ "file": built_file }),
    }
}
