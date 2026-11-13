//! The runtime part of `apps/shell/src/shared/agent-api.ts`: the channel
//! names, the constants, the preferences and what the window shows of a
//! failed start. Its types (`AgentWindowApi`, the event views) are TypeScript
//! only and are not here.

use jscompat::{JsObject, JsonValue, number_to_string};

use crate::packages::ai_provider::agent_session_program_problem::AgentProgramProblem;

/// `AGENT_CHANNELS`: the key and the channel of each, in the order of the literal
pub const AGENT_CHANNELS: [(&str, &str); 20] = [
    ("getInit", "agent-window:get-init"),
    ("pickFolder", "agent-window:pick-folder"),
    ("setPrefs", "agent-window:set-prefs"),
    ("start", "agent-window:start"),
    ("send", "agent-window:send"),
    ("answer", "agent-window:answer"),
    ("stop", "agent-window:stop"),
    ("openFile", "agent-window:open-file"),
    ("getTheme", "agent-window:get-theme"),
    ("getProjectPrefs", "agent-window:get-project-prefs"),
    ("setProjectPrefs", "agent-window:set-project-prefs"),
    ("getProjectSkills", "agent-window:get-project-skills"),
    ("setProjectSkills", "agent-window:set-project-skills"),
    ("event", "agent-window:event"),
    ("skillProposal", "agent-window:skill-proposal"),
    ("installProposal", "agent-window:install-proposal"),
    ("templateCheck", "agent-window:template-check"),
    ("templateAsIs", "agent-window:template-as-is"),
    ("templateBlank", "agent-window:template-blank"),
    ("statusesChanged", "ai:subscription-changed"),
];

/// the channel `AGENT_CHANNELS[key]` names
pub fn agent_channel(key: &str) -> Option<&'static str> {
    AGENT_CHANNELS
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, channel)| *channel)
}

pub const AGENT_PROVIDERS: [&str; 2] = ["claude-code", "codex"];
pub const AGENT_MODES: [&str; 3] = ["ask-commands", "ask-writes", "trust-project"];

/// Programs agent mode does not start, whatever their connection. Empty now.
pub const AGENT_BLOCKED_PROVIDERS: [&str; 0] = [];

/// Bump when the first-use warning says something new: an older consent no longer counts
pub const AGENT_WARNING_VERSION: f64 = 1.0;

pub const AGENT_RECENT_LIMIT: usize = 8;

/// `AgentPrefs`
#[derive(Debug, Clone, PartialEq)]
pub struct AgentPrefs {
    pub provider: String,
    pub mode: String,
    /// most recent first, at most `AGENT_RECENT_LIMIT`
    pub recent_folders: Vec<String>,
    /// the warning version the person accepted; 0 for none
    pub warning_accepted: f64,
}

impl AgentPrefs {
    /// the preferences as the object the TypeScript holds, keys in the order of its literal
    pub fn to_json(&self) -> JsonValue {
        let mut object: JsObject<JsonValue> = JsObject::new();
        object.set("provider", JsonValue::String(self.provider.clone()));
        object.set("mode", JsonValue::String(self.mode.clone()));
        object.set(
            "recentFolders",
            JsonValue::Array(
                self.recent_folders
                    .iter()
                    .cloned()
                    .map(JsonValue::String)
                    .collect(),
            ),
        );
        object.set("warningAccepted", JsonValue::Number(self.warning_accepted));
        JsonValue::Object(object)
    }
}

/// `DEFAULT_AGENT_PREFS`
pub fn default_agent_prefs() -> AgentPrefs {
    AgentPrefs {
        provider: "claude-code".to_owned(),
        mode: "ask-commands".to_owned(),
        recent_folders: Vec::new(),
        warning_accepted: 0.0,
    }
}

pub const AGENT_CODEX_WEB_SEARCH: [&str; 3] = ["cached", "live", "disabled"];

/// `AgentProjectPrefs`: what a project folder remembers for Codex sessions
#[derive(Debug, Clone, PartialEq)]
pub struct AgentProjectPrefs {
    pub codex_web_search: String,
    /// commands may reach the internet
    pub codex_network: bool,
}

impl AgentProjectPrefs {
    pub fn to_json(&self) -> JsonValue {
        let mut object: JsObject<JsonValue> = JsObject::new();
        object.set(
            "codexWebSearch",
            JsonValue::String(self.codex_web_search.clone()),
        );
        object.set("codexNetwork", JsonValue::Bool(self.codex_network));
        JsonValue::Object(object)
    }
}

/// `DEFAULT_AGENT_PROJECT_PREFS`
pub fn default_agent_project_prefs() -> AgentProjectPrefs {
    AgentProjectPrefs {
        codex_web_search: "cached".to_owned(),
        codex_network: false,
    }
}

/// `Partial<AgentProjectPrefs>`: a field left out is `None`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AgentProjectPrefsPatch {
    pub codex_web_search: Option<String>,
    pub codex_network: Option<bool>,
}

impl AgentProjectPrefsPatch {
    pub fn to_json(&self) -> JsonValue {
        let mut object: JsObject<JsonValue> = JsObject::new();
        if let Some(search) = &self.codex_web_search {
            object.set("codexWebSearch", JsonValue::String(search.clone()));
        }
        if let Some(network) = self.codex_network {
            object.set("codexNetwork", JsonValue::Bool(network));
        }
        JsonValue::Object(object)
    }
}

/// An own property of an object value; anything else holds none
fn own<'a>(value: Option<&'a JsonValue>, key: &str) -> Option<&'a JsonValue> {
    match value {
        Some(JsonValue::Object(object)) => object.get(key),
        _ => None,
    }
}

/// The known values of a change the window asks for; anything else is dropped
pub fn agent_project_prefs_patch(raw: Option<&JsonValue>) -> AgentProjectPrefsPatch {
    let mut patch = AgentProjectPrefsPatch::default();
    if let Some(JsonValue::String(search)) = own(raw, "codexWebSearch")
        && AGENT_CODEX_WEB_SEARCH.contains(&search.as_str())
    {
        patch.codex_web_search = Some(search.clone());
    }
    if let Some(JsonValue::Bool(network)) = own(raw, "codexNetwork") {
        patch.codex_network = Some(*network);
    }
    patch
}

/// `AgentProjectSkillsView`: a project folder's own skills as the start screen lists them
#[derive(Debug, Clone, PartialEq)]
pub struct AgentProjectSkillsView {
    pub skills: Vec<AgentProjectSkillView>,
    pub allowed: bool,
    pub changed: bool,
}

/// one of the `skills` of the view
#[derive(Debug, Clone, PartialEq)]
pub struct AgentProjectSkillView {
    pub name: String,
    pub title: String,
    pub description: String,
}

impl AgentProjectSkillsView {
    pub fn to_json(&self) -> JsonValue {
        let skills = self
            .skills
            .iter()
            .map(|skill| {
                let mut object: JsObject<JsonValue> = JsObject::new();
                object.set("name", JsonValue::String(skill.name.clone()));
                object.set("title", JsonValue::String(skill.title.clone()));
                object.set("description", JsonValue::String(skill.description.clone()));
                JsonValue::Object(object)
            })
            .collect();
        let mut object: JsObject<JsonValue> = JsObject::new();
        object.set("skills", JsonValue::Array(skills));
        object.set("allowed", JsonValue::Bool(self.allowed));
        object.set("changed", JsonValue::Bool(self.changed));
        JsonValue::Object(object)
    }
}

/// `AGENT_RUN_ERROR_KINDS`: the run errors of a start that the window has a message for
pub const AGENT_RUN_ERROR_KINDS: [&str; 8] = [
    "unsafe-tools",
    "sandbox-unavailable",
    "rate-limit",
    "signed-out",
    "metered-not-accepted",
    "needs-update",
    "not-installed",
    "off-in-app",
];

/// `AgentPrepareStep`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentPrepareStep {
    SessionFolder,
    AppTools,
    UserMcp,
    Skills,
    Instructions,
}

impl AgentPrepareStep {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentPrepareStep::SessionFolder => "session-folder",
            AgentPrepareStep::AppTools => "app-tools",
            AgentPrepareStep::UserMcp => "user-mcp",
            AgentPrepareStep::Skills => "skills",
            AgentPrepareStep::Instructions => "instructions",
        }
    }
}

/// `AgentStartFailure`
#[derive(Debug, Clone, PartialEq)]
pub enum AgentStartFailure {
    BadFolder,
    NotConnected,
    NotAccepted,
    ProviderBlocked,
    InvalidRequest,
    RunError {
        kind: String,
    },
    ProgramProblem {
        problem: AgentProgramProblem,
    },
    PrepareFailed {
        step: AgentPrepareStep,
    },
    /// the window closed, or the app quit, before the session was running
    Stopped,
    Unknown,
}

impl AgentStartFailure {
    /// the `reason`
    pub fn reason(&self) -> &'static str {
        match self {
            AgentStartFailure::BadFolder => "bad-folder",
            AgentStartFailure::NotConnected => "not-connected",
            AgentStartFailure::NotAccepted => "not-accepted",
            AgentStartFailure::ProviderBlocked => "provider-blocked",
            AgentStartFailure::InvalidRequest => "invalid-request",
            AgentStartFailure::RunError { .. } => "run-error",
            AgentStartFailure::ProgramProblem { .. } => "program-problem",
            AgentStartFailure::PrepareFailed { .. } => "prepare-failed",
            AgentStartFailure::Stopped => "stopped",
            AgentStartFailure::Unknown => "unknown",
        }
    }

    pub fn to_json(&self) -> JsonValue {
        let mut object: JsObject<JsonValue> = JsObject::new();
        object.set("reason", JsonValue::String(self.reason().to_owned()));
        match self {
            AgentStartFailure::RunError { kind } => {
                object.set("kind", JsonValue::String(kind.clone()));
            }
            AgentStartFailure::ProgramProblem { problem } => {
                object.set("problem", problem.to_json());
            }
            AgentStartFailure::PrepareFailed { step } => {
                object.set("step", JsonValue::String(step.as_str().to_owned()));
            }
            _ => {}
        }
        JsonValue::Object(object)
    }
}

/// `step.replace(/\//g, '.')`
fn dotted(step: &str) -> String {
    step.replace('/', ".")
}

/// A short code for a failure the person may report: identifier-like words
/// only, so the diagnostic record can keep it as it is.
pub fn agent_start_failure_code(failure: &AgentStartFailure) -> String {
    match failure {
        AgentStartFailure::RunError { kind } => kind.clone(),
        AgentStartFailure::PrepareFailed { step } => format!("prepare {}", step.as_str()),
        AgentStartFailure::ProgramProblem { problem } => match problem {
            AgentProgramProblem::Exited { exit_code } => match exit_code {
                None => "exited".to_owned(),
                Some(code) => format!("exited {}", number_to_string(*code)),
            },
            AgentProgramProblem::NoAnswer { step } => format!("no-answer {}", dotted(step)),
            AgentProgramProblem::Refused { step, code } => {
                let code = match code {
                    None => String::new(),
                    Some(code) => format!(" {}", number_to_string(*code)),
                };
                format!("refused {}{code}", dotted(step))
            }
            other => other.type_name().to_owned(),
        },
        other => other.reason().to_owned(),
    }
}

/// `normalizeAgentPrefs(raw)`
pub fn normalize_agent_prefs(raw: Option<&JsonValue>) -> AgentPrefs {
    let defaults = default_agent_prefs();
    let provider = match own(raw, "provider") {
        Some(JsonValue::String(provider)) if AGENT_PROVIDERS.contains(&provider.as_str()) => {
            provider.clone()
        }
        _ => defaults.provider,
    };
    let mode = match own(raw, "mode") {
        Some(JsonValue::String(mode)) if AGENT_MODES.contains(&mode.as_str()) => mode.clone(),
        _ => defaults.mode,
    };
    let recent_folders = match own(raw, "recentFolders") {
        Some(JsonValue::Array(folders)) => {
            let mut unique: Vec<String> = Vec::new();
            for folder in folders {
                if let JsonValue::String(folder) = folder
                    && !folder.is_empty()
                    && !unique.contains(folder)
                {
                    unique.push(folder.clone());
                }
            }
            unique.truncate(AGENT_RECENT_LIMIT);
            unique
        }
        _ => Vec::new(),
    };
    let warning_accepted = match own(raw, "warningAccepted") {
        Some(JsonValue::Number(accepted)) if accepted.is_finite() && accepted.fract() == 0.0 => {
            *accepted
        }
        _ => 0.0,
    };
    AgentPrefs {
        provider,
        mode,
        recent_folders,
        warning_accepted,
    }
}

/// `folder` first, without its older copy
pub fn with_recent_folder(prefs: &AgentPrefs, folder: &str) -> AgentPrefs {
    let lower = folder.to_lowercase();
    let mut recent_folders: Vec<String> = vec![folder.to_owned()];
    recent_folders.extend(
        prefs
            .recent_folders
            .iter()
            .filter(|known| known.to_lowercase() != lower)
            .cloned(),
    );
    recent_folders.truncate(AGENT_RECENT_LIMIT);
    AgentPrefs {
        recent_folders,
        ..prefs.clone()
    }
}
