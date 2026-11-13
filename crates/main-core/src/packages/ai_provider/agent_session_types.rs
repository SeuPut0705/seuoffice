//! `packages/ai-provider/src/agent-session/types.ts`: the shapes the agent
//! session runners and the app share. The runtime parts (the mode list, the
//! default mode, `isAgentPermissionMode`, the Codex web search list) are
//! ported as they are; the TypeScript types the port needs become Rust types.
//!
//! `AgentAction` and its parts live in `agent_session_policy.rs` (the policy
//! reads them) and are re-exported here. `AgentSession` is a trait: a started
//! session is a handle whose `send` awaits the program (`LocalBoxFuture`).

use jscompat::{JsObject, JsonValue};

use super::jsval::{Obj, object, text};
use super::task::{JsError, LocalBoxFuture};

pub use super::agent_session_policy::{
    AgentAction, AgentActionKind, AgentDenyReason, AgentPermissionMode, AgentPolicyVerdict,
    AgentSessionAllowances,
};

/// `AGENT_PERMISSION_MODES`
pub const AGENT_PERMISSION_MODES: [&str; 3] = ["ask-commands", "ask-writes", "trust-project"];

/// `DEFAULT_AGENT_PERMISSION_MODE`
pub const DEFAULT_AGENT_PERMISSION_MODE: &str = "ask-commands";

/// `isAgentPermissionMode(value)`
pub fn is_agent_permission_mode(value: Option<&JsonValue>) -> bool {
    match value {
        Some(JsonValue::String(value)) => AGENT_PERMISSION_MODES.contains(&value.as_str()),
        _ => false,
    }
}

/// The word of an `AgentPermissionMode`.
pub fn agent_permission_mode_name(mode: AgentPermissionMode) -> &'static str {
    match mode {
        AgentPermissionMode::AskCommands => "ask-commands",
        AgentPermissionMode::AskWrites => "ask-writes",
        AgentPermissionMode::TrustProject => "trust-project",
    }
}

/// The `AgentPermissionMode` of a word of [`AGENT_PERMISSION_MODES`].
pub fn agent_permission_mode_of(value: &str) -> Option<AgentPermissionMode> {
    match value {
        "ask-commands" => Some(AgentPermissionMode::AskCommands),
        "ask-writes" => Some(AgentPermissionMode::AskWrites),
        "trust-project" => Some(AgentPermissionMode::TrustProject),
        _ => None,
    }
}

/// The word of an `AgentActionKind`.
pub fn agent_action_kind_name(kind: AgentActionKind) -> &'static str {
    match kind {
        AgentActionKind::Read => "read",
        AgentActionKind::Write => "write",
        AgentActionKind::Command => "command",
        AgentActionKind::AppTool => "app-tool",
        AgentActionKind::McpTool => "mcp-tool",
        AgentActionKind::Skill => "skill",
        AgentActionKind::WebSearch => "web-search",
        AgentActionKind::WebFetch => "web-fetch",
        AgentActionKind::Other => "other",
    }
}

/// `AgentCodexWebSearch`: Codex's own web search for an agent session
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentCodexWebSearch {
    Cached,
    Live,
    Disabled,
}

impl AgentCodexWebSearch {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentCodexWebSearch::Cached => "cached",
            AgentCodexWebSearch::Live => "live",
            AgentCodexWebSearch::Disabled => "disabled",
        }
    }
}

/// `AGENT_CODEX_WEB_SEARCH`
pub const AGENT_CODEX_WEB_SEARCH: [&str; 3] = ["cached", "live", "disabled"];

/// A new action of `kind` for the program's tool `tool` that names `paths`;
/// every other field is left out (`undefined`).
pub fn new_agent_action(kind: AgentActionKind, tool: &str, paths: Vec<String>) -> AgentAction {
    AgentAction {
        kind,
        tool: tool.to_owned(),
        command: None,
        summary: None,
        paths,
        cwd: None,
        reason: None,
        target: None,
        host: None,
        server: None,
    }
}

/// An `AgentAction` as the object the TypeScript holds. The keys come in one
/// order for every action: `kind`, `tool`, `command`, `summary`, `cwd`,
/// `target`, `paths`, `reason`, `host`, `server`, which is the order of every
/// literal the Codex runner builds (an `undefined` field leaves no key).
pub fn agent_action_to_json(action: &AgentAction) -> JsonValue {
    JsonValue::Object(agent_action_object(action))
}

fn agent_action_object(action: &AgentAction) -> Obj {
    let mut out = Obj::new();
    out.set("kind", text(agent_action_kind_name(action.kind)));
    out.set("tool", text(&action.tool));
    let mut optional = |key: &str, value: &Option<String>| {
        if let Some(value) = value {
            out.set(key, text(value));
        }
    };
    optional("command", &action.command);
    optional("summary", &action.summary);
    optional("cwd", &action.cwd);
    optional("target", &action.target);
    out.set(
        "paths",
        JsonValue::Array(action.paths.iter().map(text).collect()),
    );
    let mut optional = |key: &str, value: &Option<String>| {
        if let Some(value) = value {
            out.set(key, text(value));
        }
    };
    optional("reason", &action.reason);
    optional("host", &action.host);
    optional("server", &action.server);
    out
}

/// `AgentPermissionRequest`: an action shown to the person; `id` is answered
/// with an [`AgentPermissionAnswer`]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentPermissionRequest {
    pub action: AgentAction,
    pub id: String,
    pub provider: String,
}

impl AgentPermissionRequest {
    /// `{ ...action, id, provider }`
    pub fn to_json(&self) -> JsonValue {
        let mut out = agent_action_object(&self.action);
        out.set("id", text(&self.id));
        out.set("provider", text(&self.provider));
        JsonValue::Object(out)
    }
}

/// `AgentPermissionAnswer`
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentPermissionAnswer {
    Allow {
        /// `'once'` or `'session'`
        scope: Option<String>,
    },
    Deny {
        message: Option<String>,
    },
}

impl AgentPermissionAnswer {
    /// the `allow` flag
    pub fn allow(&self) -> bool {
        matches!(self, AgentPermissionAnswer::Allow { .. })
    }
}

/// `AgentSessionEvent`
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentSessionEvent {
    /// the program reported what it runs with; the session checked it
    Started {
        provider: String,
        model: Option<String>,
        skills: Vec<String>,
    },
    /// a complete piece of the program's answer
    Text { text: String },
    /// the program used a tool; `status` is `running`, `done`, `failed` or `denied`
    Tool {
        action: AgentAction,
        status: &'static str,
    },
    /// the program wants an answer before it goes on
    Permission { request: AgentPermissionRequest },
    /// the program finished answering one message
    TurnDone { ok: bool },
    /// documents were opened after the session started
    DocumentsUnprotected { paths: Vec<String> },
    /// the session ended with a failure; `kind` follows the app's run errors
    Error {
        kind: Option<String>,
        message: String,
    },
    /// the program is gone
    Ended,
}

impl AgentSessionEvent {
    /// the event as the object the TypeScript holds, keys in the order of its literal
    pub fn to_json(&self) -> JsonValue {
        match self {
            AgentSessionEvent::Started {
                provider,
                model,
                skills,
            } => {
                let mut entries = vec![("type", text("started")), ("provider", text(provider))];
                if let Some(model) = model {
                    entries.push(("model", text(model)));
                }
                entries.push((
                    "skills",
                    JsonValue::Array(skills.iter().map(text).collect()),
                ));
                object(entries)
            }
            AgentSessionEvent::Text { text: value } => {
                object(vec![("type", text("text")), ("text", text(value))])
            }
            AgentSessionEvent::Tool { action, status } => object(vec![
                ("type", text("tool")),
                ("action", agent_action_to_json(action)),
                ("status", text(*status)),
            ]),
            AgentSessionEvent::Permission { request } => object(vec![
                ("type", text("permission")),
                ("request", request.to_json()),
            ]),
            AgentSessionEvent::TurnDone { ok } => object(vec![
                ("type", text("turn-done")),
                ("ok", JsonValue::Bool(*ok)),
            ]),
            AgentSessionEvent::DocumentsUnprotected { paths } => object(vec![
                ("type", text("documents-unprotected")),
                ("paths", JsonValue::Array(paths.iter().map(text).collect())),
            ]),
            AgentSessionEvent::Error { kind, message } => {
                let mut entries = vec![("type", text("error"))];
                if let Some(kind) = kind {
                    entries.push(("kind", text(kind)));
                }
                entries.push(("message", text(message)));
                object(entries)
            }
            AgentSessionEvent::Ended => object(vec![("type", text("ended"))]),
        }
    }
}

/// `AgentMcpRelay`: one relay of a person's MCP server for a session
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentMcpRelay {
    /// the person's server name; the program's tool names are `mcp__<name>__<tool>`
    pub name: String,
    pub url: String,
    pub token: String,
    /// the tools the relay lists at the start, as the program names them after `mcp__<name>__`
    pub tools: Vec<String>,
}

/// `AgentSessionOptions['appMcp']`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentAppMcp {
    pub url: String,
    pub token: String,
}

/// `AgentSessionOptions`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionOptions {
    /// absolute path of the project folder; the program's working directory
    pub project_root: String,
    pub mode: AgentPermissionMode,
    /// model id as the program takes it; empty for the program's default
    pub model: String,
    /// how hard the model thinks; absent for the program's default
    pub effort: Option<String>,
    /// the user's own path to the CLI (settings), if any
    pub cli_path: Option<String>,
    /// text the app adds to the program's own instructions
    pub instructions: String,
    /// absolute paths of documents open in tabs, at the start
    pub open_documents: Vec<String>,
    /// absolute paths the program must not read or write
    pub protected_paths: Vec<String>,
    /// a folder of skill copies made for this session, if any
    pub skill_bundle_dir: Option<String>,
    /// the app's own MCP server for open documents, if the session may use it
    pub app_mcp: Option<AgentAppMcp>,
    /// the relays of the person's MCP servers that were on when the session started
    pub user_mcp_relays: Option<Vec<AgentMcpRelay>>,
    /// a folder the session may write its own files into
    pub session_dir: String,
}

/// `AgentSession`: a started session. `send` resolves when the program
/// accepted the message.
pub trait AgentSession {
    /// the program: `claude-code` or `codex`
    fn provider(&self) -> &str;
    /// send the person's next message
    fn send(&self, text: &str) -> LocalBoxFuture<Result<(), JsError>>;
    /// answer a pending permission request
    fn answer(&self, id: &str, answer: &AgentPermissionAnswer);
    /// the documents open in tabs changed
    fn set_open_documents(&self, paths: &[String]);
    /// stop now: the program and everything it started are ended
    fn stop(&self);
}

/// A table by path as the sandbox profile holds it: `Record<string, string>`.
pub type StringTable = JsObject<String>;
