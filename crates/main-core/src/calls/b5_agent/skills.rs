//! The functions of part `skills` of group `b5-agent`
//! (tools/main-diff/groups/b5-agent-skills.ts): the agent skills, the agent
//! window's decisions and the names of the redaction label.
//!
//! The window's handlers read the module state of the TypeScript from a
//! scenario in the arguments: the window, the services, the manager, the
//! dialog and the cards shown, as JSON. [`Scenario`] is the host the Rust
//! functions drive, and each impure call of a service is one `logs` line
//! (`[name, ...args]`), as the TypeScript's fakes write them. The deck behind
//! the redaction check is the archive the case lists.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::node_path::host::join;
use jscompat::{JsObject, JsonValue, json_value_from_serde};
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::agent_core::redact_range::{
    OLD_REDACT_NS, OWN_REDACT_NS, REDACT_EL, REDACT_NAMESPACES, REDACT_NS_WRITTEN, REDACT_PREFIX,
};
use crate::packages::ai_provider::agent_session_program_problem::AgentProgramProblem;
use crate::packages::electron_utils::safe_external_url::safe_external_url;
use crate::shell::agent::agent_api::{
    AgentPrefs, AgentPrepareStep, AgentProjectPrefs, AgentProjectPrefsPatch, AgentProjectSkillView,
    AgentProjectSkillsView, AgentStartFailure,
};
use crate::shell::agent::agent_session_folders::{
    ExecRequest, FolderHost, make_agent_session_folder,
};
use crate::shell::agent::agent_sessions::{
    AgentHost, AgentManager, AgentMcpSession as ManagerSession, AgentPermissionAnswer,
    AgentSessionHandle, AgentSessionOptions, AgentStartAnswer, AgentStartCall, AgentStartRequest,
    AgentStartResult, AppMcp, CodexRunOptions, RelayAnswer, RemoveOptions, Stoppable,
};
use crate::shell::agent::agent_skills::{
    AgentOpenTab, AgentSessionSkill, AgentSessionSkillName, AgentSkillEntry, AgentSkillListEntry,
    AgentSkillProposalInput, AgentSkillProposalResult, AgentTemplateCandidate, DeckArchive,
    DeckEntry, MAX_PROJECT_TEMPLATE_DEPTH, MAX_PROJECT_TEMPLATE_FILES, ManageWindows,
    ProjectTemplateLimits, TemplateCandidateOptions, TemplateReadGuard, agent_session_skills_of,
    agent_skill_proposal_of, agent_template_candidates, agent_window_manage_channels,
    candidate_view, project_template_files, read_template_candidate, template_redaction_of,
    user_skills_manage_gate,
};
use crate::shell::agent::agent_window::{
    AgentMcpSession, AgentSkillTools, AgentSkillToolsDeps, AgentWindowHost, AgentWindowSendStep,
    AgentWindowShown, AgentWindowStartJob, AgentWindowStartStep, ShownProposal, SubscriptionStatus,
    TemplateAsIs, TemplateBlank, TemplateCheck, TemplatePreviewInput, TemplatePreviewOutcome,
    WindowState, agent_answer, agent_codex_start_choices, agent_connections, agent_emit,
    agent_event_view, agent_get_init, agent_get_project_prefs, agent_get_project_skills,
    agent_get_theme, agent_home_may_open, agent_is_window_contents, agent_live_owner,
    agent_open_file, agent_permission_answer, agent_pick_folder, agent_send, agent_set_prefs,
    agent_set_project_prefs, agent_set_project_skills, agent_start, agent_stop,
    agent_template_as_is, agent_template_blank, agent_template_check, agent_window_load,
    agent_window_options, agent_window_reuse, plan_agent_start,
};
use crate::shell::renderer_disposal::Failure;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- redact-range, old-names ----
        "redact-range.OWN_REDACT_NS" => Ok(Some(json!(OWN_REDACT_NS))),
        "old-names.OLD_REDACT_NS" => Ok(Some(json!(OLD_REDACT_NS))),
        "redact-range.REDACT_PREFIX" => Ok(Some(json!(REDACT_PREFIX))),
        "redact-range.REDACT_EL" => Ok(Some(json!(REDACT_EL))),
        "redact-range.REDACT_NAMESPACES" => Ok(Some(json!(REDACT_NAMESPACES))),
        "redact-range.REDACT_NS_WRITTEN" => Ok(Some(json!(REDACT_NS_WRITTEN))),

        // ---- agent-skills ----
        "agent-skills.AGENT_WINDOW_MANAGE_CHANNELS" => {
            Ok(Some(json!(agent_window_manage_channels())))
        }
        "agent-skills.MAX_PROJECT_TEMPLATE_FILES" => Ok(Some(json!(MAX_PROJECT_TEMPLATE_FILES))),
        "agent-skills.MAX_PROJECT_TEMPLATE_DEPTH" => Ok(Some(json!(MAX_PROJECT_TEMPLATE_DEPTH))),
        "agent-skills.userSkillsManageGate" => manage_gate(args, cx),
        "agent-skills.agentSessionSkillsOf" => session_skills_call(args),
        "agent-skills.agentSkillProposalOf" => proposal_call(args),
        "agent-skills.projectTemplateFiles" => template_files_call(args),
        "agent-skills.agentTemplateCandidates" => template_candidates_call(args),
        "agent-skills.candidateView" => (|| {
            let candidate = candidate_of(need(args, 0)?);
            Ok(Some(to_value(&candidate_view(&candidate))))
        })(),
        "agent-skills.templateRedactionOf" => redaction_call(args),
        "agent-skills.readTemplateCandidate" => read_candidate_call(args),

        // ---- agent-window ----
        "agent-window.agentCodexStartChoices" => (|| {
            let prefs = project_prefs_of(need(args, 1)?);
            let choices = agent_codex_start_choices(str_arg(args, 0)?, &prefs);
            Ok(choices.map(|choices| to_value(&choices)))
        })(),
        "agent-window.agentPermissionAnswer" => {
            let allow = arg(args, 0).map(json_value_from_serde);
            let scope = arg(args, 1).map(json_value_from_serde);
            Ok(Some(
                agent_permission_answer(allow.as_ref(), scope.as_ref()).to_json(),
            ))
        }
        "agent-window.agentEventView" => (|| {
            let event = json_value_from_serde(need(args, 0)?);
            Ok(Some(agent_event_view(&event)))
        })(),
        "agent-window.agentConnections" => connections_call(args),
        "agent-window.agentSkillToolsFor.proposeSkill" => tools_call(args, cx, true),
        "agent-window.agentSkillToolsFor.proposeInstall" => tools_call(args, cx, false),
        _ => return window_call(name, args, cx),
    })
}

// ---- helpers -----------------------------------------------------------------

fn need(args: &[Value], i: usize) -> Result<&Value, CallError> {
    arg(args, i).ok_or_else(|| CallError::plain(format!("argument {i} is missing")))
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn opt_text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn flag(v: &Value, key: &str) -> bool {
    v.get(key) == Some(&Value::Bool(true))
}

fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn texts(v: &Value, key: &str) -> Vec<String> {
    list(v, key)
        .iter()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect()
}

fn int_arg(args: &[Value], i: usize) -> Result<i64, CallError> {
    need(args, i)?
        .as_i64()
        .ok_or_else(|| CallError::plain(format!("argument {i} is not an integer")))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `process.platform` of this machine, as Node names it
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// `os.homedir()`
fn os_home_dir() -> String {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var(key).unwrap_or_default()
}

#[cfg(unix)]
fn symlink(target: &str, link: &str) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(windows)]
fn symlink(target: &str, link: &str) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(target, link)
}

/// the `[link, target]` pairs of a case, made before the call
fn make_links(links: Option<&Value>) -> Result<(), CallError> {
    for pair in links.and_then(Value::as_array).into_iter().flatten() {
        let (Some(link), Some(target)) = (
            pair.get(0).and_then(Value::as_str),
            pair.get(1).and_then(Value::as_str),
        ) else {
            continue;
        };
        symlink(target, link).map_err(|e| CallError::plain(format!("symlink: {e}")))?;
    }
    Ok(())
}

// ---- agent-skills ----------------------------------------------------------

struct Gate<'a> {
    main: Vec<i64>,
    agent: Vec<i64>,
    log: &'a RefCell<Vec<Vec<Value>>>,
}

impl ManageWindows<i64> for Gate<'_> {
    fn is_main_window(&self, sender: &i64) -> bool {
        self.log
            .borrow_mut()
            .push(vec![json!("isMainWindow"), json!(sender)]);
        self.main.contains(sender)
    }

    fn is_agent_window(&self, sender: &i64) -> bool {
        self.log
            .borrow_mut()
            .push(vec![json!("isAgentWindow"), json!(sender)]);
        self.agent.contains(sender)
    }
}

fn ids(v: &Value, key: &str) -> Vec<i64> {
    list(v, key).iter().filter_map(Value::as_i64).collect()
}

fn manage_gate(args: &[Value], cx: &mut Context) -> Answer {
    let windows = need(args, 0)?;
    let log = RefCell::new(Vec::new());
    let gate = Gate {
        main: ids(windows, "main"),
        agent: ids(windows, "agent"),
        log: &log,
    };
    let allowed = user_skills_manage_gate::<i64, _>(&gate)(&int_arg(args, 1)?, str_arg(args, 2)?);
    cx.logs.extend(log.into_inner());
    Ok(Some(Value::Bool(allowed)))
}

fn session_skills_call(args: &[Value]) -> Answer {
    let entries: Vec<AgentSkillEntry> = need(args, 0)?
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|entry| AgentSkillEntry {
            id: text(entry, "id"),
            name: text(entry, "name"),
            source: text(entry, "source"),
            plugin: opt_text(entry, "plugin"),
            title: text(entry, "title"),
            description: text(entry, "description"),
            invoke: text(entry, "invoke"),
            skill_md: text(entry, "skillMd"),
        })
        .collect();
    Ok(Some(to_value(&agent_session_skills_of(&entries))))
}

fn list_entry_of(entry: &Value) -> AgentSkillListEntry {
    AgentSkillListEntry {
        id: text(entry, "id"),
        source: text(entry, "source"),
        name: text(entry, "name"),
        title: text(entry, "title"),
        owned: flag(entry, "owned"),
        unreadable: entry.get("unreadable").map(json_value_from_serde),
        editors: entry.get("editors").map(json_value_from_serde),
    }
}

fn proposal_input_of(input: &Value) -> AgentSkillProposalInput {
    AgentSkillProposalInput {
        title: text(input, "title"),
        name: text(input, "name"),
        description: text(input, "description"),
        body: text(input, "body"),
        wants_template: flag(input, "wantsTemplate"),
        target_id: text(input, "targetId"),
        suggested_template_path: text(input, "suggestedTemplatePath"),
    }
}

fn proposal_call(args: &[Value]) -> Answer {
    let input = proposal_input_of(need(args, 0)?);
    let skills: Vec<AgentSkillListEntry> = need(args, 1)?
        .as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(list_entry_of)
        .collect();
    let session: Vec<AgentSessionSkillName> = arg(args, 3)
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|skill| AgentSessionSkillName {
            id: text(skill, "id"),
            name: text(skill, "name"),
        })
        .collect();
    Ok(Some(
        match agent_skill_proposal_of(&input, &skills, str_arg(args, 2)?, &session) {
            AgentSkillProposalResult::Ok(proposal) => {
                json!({ "ok": true, "proposal": to_value(&proposal) })
            }
            AgentSkillProposalResult::Refused(message) => {
                json!({ "ok": false, "message": message })
            }
        },
    ))
}

fn template_files_call(args: &[Value]) -> Answer {
    make_links(arg(args, 2))?;
    let limits = match arg(args, 1) {
        Some(limits @ Value::Object(_)) => ProjectTemplateLimits {
            files: limits.get("files").and_then(Value::as_f64),
            depth: limits.get("depth").and_then(Value::as_f64),
        },
        _ => ProjectTemplateLimits::default(),
    };
    Ok(Some(json!(project_template_files(
        str_arg(args, 0)?,
        &limits
    ))))
}

fn tab_of(tab: &Value) -> AgentOpenTab {
    AgentOpenTab {
        title: text(tab, "title"),
        file_path: opt_text(tab, "filePath"),
        dirty: flag(tab, "dirty"),
    }
}

fn template_candidates_call(args: &[Value]) -> Answer {
    make_links(arg(args, 1))?;
    let options = need(args, 0)?;
    let tabs: Vec<AgentOpenTab> = list(options, "tabs").iter().map(tab_of).collect();
    let project_files: Option<Vec<String>> = options
        .get("projectFiles")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|f| f.as_str().map(str::to_owned))
                .collect()
        });
    let platform = opt_text(options, "platform").unwrap_or_else(|| node_platform().to_owned());
    let project_root = text(options, "projectRoot");
    let suggested = text(options, "suggested");
    let (candidates, selected) = agent_template_candidates(&TemplateCandidateOptions {
        project_root: &project_root,
        tabs: &tabs,
        suggested: &suggested,
        platform: &platform,
        project_files: project_files.as_deref(),
    });
    let mut out = Map::new();
    out.insert("candidates".into(), to_value(&candidates));
    if let Some(selected) = selected {
        out.insert("selected".into(), json!(selected));
    }
    Ok(Some(Value::Object(out)))
}

fn candidate_of(v: &Value) -> AgentTemplateCandidate {
    AgentTemplateCandidate {
        id: text(v, "id"),
        path: text(v, "path"),
        title: text(v, "title"),
        file_name: text(v, "fileName"),
        from: if v.get("from").and_then(Value::as_str) == Some("tab") {
            "tab"
        } else {
            "project"
        },
        unsaved: flag(v, "unsaved"),
    }
}

/// the archive a case lists: `entries` of `{ name, text, dir? }`; none is a file that is no zip
struct Deck {
    entries: Option<Vec<(DeckEntry, String)>>,
}

impl Deck {
    fn of(entries: Option<&Value>) -> Deck {
        Deck {
            entries: entries.and_then(Value::as_array).map(|entries| {
                entries
                    .iter()
                    .map(|entry| {
                        (
                            DeckEntry {
                                name: text(entry, "name"),
                                dir: flag(entry, "dir"),
                            },
                            text(entry, "text"),
                        )
                    })
                    .collect()
            }),
        }
    }
}

impl DeckArchive for Deck {
    fn open(&mut self, _bytes: &[u8]) -> Result<Vec<DeckEntry>, String> {
        match &self.entries {
            Some(entries) => Ok(entries.iter().map(|(entry, _)| entry.clone()).collect()),
            None => Err("Can't find end of central directory : is this a zip file ?".to_owned()),
        }
    }

    fn text(&mut self, index: usize) -> Result<String, String> {
        match self.entries.as_ref().and_then(|entries| entries.get(index)) {
            Some((_, text)) => Ok(text.clone()),
            None => Err("no such entry".to_owned()),
        }
    }
}

fn redaction_call(args: &[Value]) -> Answer {
    let body = need(args, 1)?;
    let bytes: Vec<u8> = match body.get("hex").and_then(Value::as_str) {
        Some(hex) => (0..hex.len() / 2)
            .filter_map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok())
            .collect(),
        None => text(body, "text").into_bytes(),
    };
    let mut deck = Deck::of(body.get("entries"));
    let open_in_tab = arg(args, 2) == Some(&Value::Bool(true));
    let redaction = template_redaction_of(str_arg(args, 0)?, &bytes, open_in_tab, &mut deck);
    Ok(Some(json!(redaction.as_str())))
}

fn guard_of(v: &Value) -> TemplateReadGuard {
    TemplateReadGuard {
        home_dir: text(v, "homeDir"),
        protected_paths: texts(v, "protectedPaths"),
    }
}

fn read_candidate_call(args: &[Value]) -> Answer {
    make_links(arg(args, 2))?;
    let guard = guard_of(need(args, 1)?);
    Ok(Some(
        match read_template_candidate(str_arg(args, 0)?, &guard, node_platform()) {
            Ok(bytes) => json!({ "ok": true, "hex": hex(&bytes) }),
            Err(refusal) => json!({ "ok": false, "reason": refusal.as_str() }),
        },
    ))
}

// ---- agent-window: values --------------------------------------------------

fn project_prefs_of(v: &Value) -> AgentProjectPrefs {
    AgentProjectPrefs {
        codex_web_search: text(v, "codexWebSearch"),
        codex_network: flag(v, "codexNetwork"),
    }
}

fn connections_call(args: &[Value]) -> Answer {
    let mut statuses: JsObject<SubscriptionStatus> = JsObject::new();
    if let Some(Value::Object(map)) = arg(args, 0) {
        for (provider, status) in map {
            statuses.set(
                provider.clone(),
                SubscriptionStatus {
                    state: text(status, "state"),
                    metered_accepted: flag(status, "meteredAccepted"),
                },
            );
        }
    }
    let metered: Option<JsObject<bool>> = match arg(args, 1) {
        Some(Value::Object(map)) => {
            let mut accepted = JsObject::new();
            for (provider, value) in map {
                accepted.set(provider.clone(), *value == Value::Bool(true));
            }
            Some(accepted)
        }
        _ => None,
    };
    let blocked: Vec<String> = arg(args, 2)
        .and_then(Value::as_array)
        .map(|b| {
            b.iter()
                .filter_map(|p| p.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let blocked: Vec<&str> = blocked.iter().map(String::as_str).collect();
    let mut out = Map::new();
    for (provider, connection) in agent_connections(&statuses, metered.as_ref(), &blocked) {
        out.insert(provider.to_owned(), json!(connection));
    }
    Ok(Some(Value::Object(out)))
}

// ---- agent-window: the scenario host -----------------------------------------

fn prefs_of(v: &Value) -> AgentPrefs {
    AgentPrefs {
        provider: text(v, "provider"),
        mode: text(v, "mode"),
        recent_folders: texts(v, "recentFolders"),
        warning_accepted: v
            .get("warningAccepted")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
    }
}

fn skills_view_of(v: &Value) -> AgentProjectSkillsView {
    AgentProjectSkillsView {
        skills: list(v, "skills")
            .iter()
            .map(|skill| AgentProjectSkillView {
                name: text(skill, "name"),
                title: text(skill, "title"),
                description: text(skill, "description"),
            })
            .collect(),
        allowed: flag(v, "allowed"),
        changed: flag(v, "changed"),
    }
}

fn session_skill_of(v: &Value) -> AgentSessionSkill {
    AgentSessionSkill {
        id: text(v, "id"),
        name: text(v, "name"),
        source: text(v, "source"),
        plugin: opt_text(v, "plugin"),
        title: text(v, "title"),
        description: text(v, "description"),
        invoke: text(v, "invoke"),
        skill_md: text(v, "skillMd"),
        template: opt_text(v, "template"),
    }
}

fn step_of(step: &str) -> AgentPrepareStep {
    match step {
        "session-folder" => AgentPrepareStep::SessionFolder,
        "app-tools" => AgentPrepareStep::AppTools,
        "user-mcp" => AgentPrepareStep::UserMcp,
        "skills" => AgentPrepareStep::Skills,
        _ => AgentPrepareStep::Instructions,
    }
}

fn problem_of(v: &Value) -> AgentProgramProblem {
    match v.get("type").and_then(Value::as_str) {
        Some("unsupported-path") => AgentProgramProblem::UnsupportedPath,
        Some("exited") => AgentProgramProblem::Exited {
            exit_code: v.get("exitCode").and_then(Value::as_f64),
        },
        Some("no-answer") => AgentProgramProblem::NoAnswer {
            step: text(v, "step"),
        },
        Some("refused") => AgentProgramProblem::Refused {
            step: text(v, "step"),
            code: v.get("code").and_then(Value::as_f64),
        },
        _ => AgentProgramProblem::NoModel,
    }
}

fn failure_of(v: &Value) -> AgentStartFailure {
    match v.get("reason").and_then(Value::as_str) {
        Some("bad-folder") => AgentStartFailure::BadFolder,
        Some("not-connected") => AgentStartFailure::NotConnected,
        Some("not-accepted") => AgentStartFailure::NotAccepted,
        Some("provider-blocked") => AgentStartFailure::ProviderBlocked,
        Some("invalid-request") => AgentStartFailure::InvalidRequest,
        Some("run-error") => AgentStartFailure::RunError {
            kind: text(v, "kind"),
        },
        Some("program-problem") => AgentStartFailure::ProgramProblem {
            problem: problem_of(v.get("problem").unwrap_or(&Value::Null)),
        },
        Some("prepare-failed") => AgentStartFailure::PrepareFailed {
            step: step_of(&text(v, "step")),
        },
        Some("stopped") => AgentStartFailure::Stopped,
        _ => AgentStartFailure::Unknown,
    }
}

fn outcome_of(v: &Value) -> AgentStartResult {
    if flag(v, "ok") {
        AgentStartResult::Started {
            session_id: text(v, "sessionId"),
            skills: list(v, "skills").iter().map(session_skill_of).collect(),
            mcp_keep_inside: v.get("mcpKeepInside").map(|_| texts(v, "mcpKeepInside")),
            instructions_truncated: v
                .get("instructionsTruncated")
                .map(|_| texts(v, "instructionsTruncated")),
        }
    } else {
        AgentStartResult::Failed {
            failure: failure_of(v.get("failure").unwrap_or(&Value::Null)),
            cause: opt_text(v, "cause"),
        }
    }
}

/// A service that answers a value, or throws where the case says `"throws"`
fn failing(what: Option<&Value>) -> Result<&Value, Failure> {
    match what {
        Some(Value::String(s)) if s == "throws" => Err(Failure("throws".to_owned())),
        Some(value) => Ok(value),
        None => Ok(&Value::Null),
    }
}

/// where the scenario's calls are logged: shared with the programs and servers the manager owns
#[derive(Clone)]
struct Logger {
    lines: Rc<RefCell<Vec<Vec<Value>>>>,
    /// the sessions end with the app at the end of a case: nothing of that is logged
    quiet: Rc<Cell<bool>>,
}

impl Logger {
    fn put(&self, line: Vec<Value>) {
        if !self.quiet.get() {
            self.lines.borrow_mut().push(line);
        }
    }
}

/// the program of a session, as the TypeScript's fake runner gives it
struct WorldSession {
    log: Logger,
}

impl AgentSessionHandle for WorldSession {
    fn send(&mut self, text: &str) {
        self.log.put(vec![json!("session.send"), json!(text)]);
    }

    fn answer(&mut self, id: &str, answer: &AgentPermissionAnswer) {
        self.log.put(vec![
            json!("session.answer"),
            json!(id),
            jscompat::json_value_to_serde(&answer.to_json()),
        ]);
    }

    fn set_open_documents(&mut self, paths: &[String]) {
        self.log.put(vec![json!("setOpenDocuments"), json!(paths)]);
    }

    fn stop(&mut self) {
        self.log.put(vec![json!("session.stop")]);
    }
}

/// the app's MCP server of a session
struct WorldAppMcp {
    log: Logger,
}

impl Stoppable for WorldAppMcp {
    fn stop(&mut self) {
        self.log.put(vec![json!("appMcp.stop")]);
    }
}

/// `Math.random()` letters of a session folder's name
fn random_letters() -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    (0..6)
        .map(|_| {
            let at = (jscompat::math_random() * CHARS.len() as f64) as usize;
            char::from(CHARS[at.min(CHARS.len() - 1)])
        })
        .collect()
}

/// the window of the module state: `win`
struct Win {
    id: i64,
    destroyed: bool,
    minimized: bool,
}

/// What the window's services do, as the case describes them. The manager is the real one
/// (the caller owns it) with a fake runner: this scenario is its host and carries out the calls
/// of its start steps, the way the TypeScript's fake `startAppMcp` and runner do.
struct World<'a> {
    v: &'a Value,
    deps: &'a Value,
    log: Logger,
    deck: Deck,
    win: Option<Win>,
    /// the id the next window gets
    next_window: i64,
    /// the page `win` stands for in a step: the last window made, or 5 before
    page: i64,
    uuids: usize,
    /// the clock of the case
    now_ms: f64,
    /// every app MCP server started, in order: `(owner, session, project root)`; the tools of a
    /// session are named by it
    hooks: Vec<(i64, String, String)>,
    /// the owner and the session of every program started, in order: its events are named by it
    programs: Vec<(i64, String)>,
    /// a start that answers as the case says (`startAgentForWindow` on its own)
    scripted_start: Option<&'a Value>,
    /// a start whose program the case holds back: its job and the answer the runner will give
    held: Option<(AgentWindowStartJob, AgentStartAnswer)>,
}

impl<'a> World<'a> {
    fn new(v: &'a Value, now_ms: f64) -> World<'a> {
        World {
            v,
            deps: v.get("deps").unwrap_or(&Value::Null),
            log: Logger {
                lines: Rc::new(RefCell::new(Vec::new())),
                quiet: Rc::new(Cell::new(false)),
            },
            deck: Deck::of(v.get("deck").and_then(|d| d.get("entries"))),
            win: None,
            next_window: 5,
            page: 5,
            uuids: 0,
            now_ms,
            hooks: Vec::new(),
            programs: Vec::new(),
            scripted_start: v.get("start"),
            held: None,
        }
    }

    fn put(&self, line: Vec<Value>) {
        self.log.put(line);
    }

    fn dep(&self, key: &str) -> &'a Value {
        self.deps.get(key).unwrap_or(&Value::Null)
    }

    /// `crypto.randomUUID`
    fn uuid(&mut self) -> String {
        self.uuids += 1;
        format!("uuid-{}", self.uuids)
    }

    /// the manager, over this scenario: `createAgentManager(deps)` of `configureAgentWindow`
    fn manager(&self) -> AgentManager {
        let home_dir = opt_text(self.deps, "homeDir").unwrap_or_else(os_home_dir);
        AgentManager::new(&text(self.deps, "userData"), &home_dir, node_platform())
    }

    /// the `m.start(owner, request)` of a case that scripts the manager: logged, the outcome
    /// the case says
    fn scripted_outcome(&mut self, owner_id: i64, request: &AgentStartRequest) -> AgentStartResult {
        let mut logged = Map::new();
        logged.insert("provider".into(), json!(request.provider));
        logged.insert("mode".into(), json!(request.mode));
        logged.insert("projectRoot".into(), json!(request.project_root));
        if let Some(codex) = &request.codex {
            logged.insert(
                "codex".into(),
                json!({ "webSearch": codex.web_search, "network": codex.network }),
            );
        }
        self.put(vec![json!("start"), json!(owner_id), Value::Object(logged)]);
        outcome_of(self.scripted_start.unwrap_or(&Value::Null))
    }

    /// `openAgentWindow()`; `renderer_url` is `ELECTRON_RENDERER_URL`
    fn open(&mut self, renderer_url: Option<&str>) {
        let existing = self.win.as_ref().map(|w| (w.destroyed, w.minimized));
        if let Some(restore) = agent_window_reuse(existing) {
            if restore {
                self.put(vec![json!("restore")]);
                if let Some(win) = self.win.as_mut() {
                    win.minimized = false;
                }
            }
            self.put(vec![json!("show")]);
            self.put(vec![json!("focus")]);
            return;
        }
        let lang = text(self.deps, "lang");
        let title = self
            .dep("titles")
            .get(&lang)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let preload = join(&["/app/main", "../preload/agent.js"]);
        self.put(vec![
            json!("BrowserWindow"),
            agent_window_options(&lang, &title, &preload),
        ]);
        let id = self.next_window;
        self.next_window += 1;
        self.page = id;
        self.win = Some(Win {
            id,
            destroyed: false,
            minimized: false,
        });
        self.put(vec![json!("removeMenu")]);
        self.put(vec![json!("setWindowOpenHandler")]);
        self.put(vec![json!("once"), json!("ready-to-show")]);
        self.put(vec![json!("on"), json!("closed")]);
        let built = join(&["/app/main", "../renderer/agent.html"]);
        let load = agent_window_load(renderer_url, &built);
        match load.get("url").and_then(Value::as_str) {
            Some(url) => self.put(vec![json!("loadURL"), json!(url)]),
            None => self.put(vec![json!("loadFile"), load["file"].clone()]),
        }
    }

    /// the page that sends in a step
    fn sender(&self, who: &str) -> i64 {
        match who {
            "home" => 1,
            "other" => 77,
            _ => self.page,
        }
    }

    /// An awaited call of a start, carried out as the TypeScript's fakes do, and what it came to
    /// (with whether the case holds the program back)
    fn perform(&mut self, call: AgentStartCall) -> (AgentStartAnswer, bool) {
        match call {
            AgentStartCall::SessionFolder => (
                AgentStartAnswer::SessionFolder(make_agent_session_folder(self, None)),
                false,
            ),
            AgentStartCall::AppMcp {
                project_root,
                session,
            } => {
                self.put(vec![json!("startAppMcp"), json!(project_root)]);
                self.hooks
                    .push((session.owner_id, session.session_id, project_root));
                let started = AppMcp {
                    url: "http://localhost:1".to_owned(),
                    token: "t".to_owned(),
                    server: Box::new(WorldAppMcp {
                        log: self.log.clone(),
                    }),
                };
                (AgentStartAnswer::AppMcp(Ok(started)), false)
            }
            AgentStartCall::Relays { .. } | AgentStartCall::BuildSkills { .. } => {
                unreachable!("the window's host gives no relays and no skills copy")
            }
            AgentStartCall::RunClaude { options, session } => self.run(&options, None, session),
            AgentStartCall::RunCodex {
                options,
                codex,
                session,
            } => self.run(&options, Some(&codex), session),
        }
    }

    /// a runner call: logged, then its program; the case holds it back with `hold`
    fn run(
        &mut self,
        options: &AgentSessionOptions,
        codex: Option<&CodexRunOptions>,
        session: ManagerSession,
    ) -> (AgentStartAnswer, bool) {
        let mut logged = Map::new();
        logged.insert("projectRoot".into(), json!(options.project_root));
        logged.insert("mode".into(), json!(options.mode));
        if let Some(codex) = codex {
            logged.insert("webSearch".into(), json!(codex.web_search));
            logged.insert("network".into(), json!(codex.network));
        }
        let kind = if codex.is_some() { "codex" } else { "claude" };
        self.put(vec![json!("runner"), json!(kind), Value::Object(logged)]);
        self.programs.push((session.owner_id, session.session_id));
        let program = WorldSession {
            log: self.log.clone(),
        };
        (
            AgentStartAnswer::Run(Ok(Box::new(program))),
            flag(self.v, "hold"),
        )
    }
}

/// Runs the steps of a window's start: the scenario carries out each awaited call and answers
/// it. With `detach`, a program the case holds back ends the run (its job waits in the scenario
/// for `release`) and there is no response yet.
fn drive_window_start(
    world: &mut World<'_>,
    manager: &mut AgentManager,
    mut step: AgentWindowStartStep,
    detach: bool,
    now_ms: f64,
) -> Option<Value> {
    loop {
        match step {
            AgentWindowStartStep::Done(response) => return Some(response),
            AgentWindowStartStep::Await { call, job } => {
                let (answer, hold) = world.perform(call);
                if hold && detach {
                    world.held = Some((job, answer));
                    return None;
                }
                step = job.resume(world, manager, answer, now_ms);
            }
        }
    }
}

impl AgentWindowHost for World<'_> {
    fn window(&self) -> Option<WindowState> {
        self.win.as_ref().map(|win| WindowState {
            destroyed: win.destroyed,
            contents_id: win.id,
        })
    }

    fn has_deps(&self) -> bool {
        true
    }

    fn has_manager(&self) -> bool {
        true
    }

    fn platform(&self) -> String {
        node_platform().to_owned()
    }

    fn os_home_dir(&self) -> String {
        os_home_dir()
    }

    fn lang(&self) -> String {
        text(self.deps, "lang")
    }

    fn theme(&self) -> String {
        text(self.deps, "theme")
    }

    fn statuses(&self) -> JsObject<SubscriptionStatus> {
        let mut statuses = JsObject::new();
        if let Value::Object(map) = self.dep("statuses") {
            for (provider, status) in map {
                statuses.set(
                    provider.clone(),
                    SubscriptionStatus {
                        state: text(status, "state"),
                        metered_accepted: flag(status, "meteredAccepted"),
                    },
                );
            }
        }
        statuses
    }

    fn metered_accepted(&self) -> Option<JsObject<bool>> {
        match self.dep("metered") {
            Value::Object(map) => {
                let mut accepted = JsObject::new();
                for (provider, value) in map {
                    accepted.set(provider.clone(), *value == Value::Bool(true));
                }
                Some(accepted)
            }
            _ => None,
        }
    }

    fn read_prefs(&self) -> AgentPrefs {
        prefs_of(self.dep("prefs"))
    }

    fn write_prefs(&mut self, prefs: &AgentPrefs) {
        self.put(vec![
            json!("writePrefs"),
            jscompat::json_value_to_serde(&prefs.to_json()),
        ]);
    }

    fn parent_window(&self) -> Option<WindowState> {
        let parent = self.dep("parent");
        if parent.is_null() {
            return None;
        }
        Some(WindowState {
            destroyed: flag(parent, "destroyed"),
            contents_id: 1,
        })
    }

    fn user_data(&self) -> String {
        text(self.deps, "userData")
    }

    fn deps_home_dir(&self) -> Option<String> {
        opt_text(self.deps, "homeDir")
    }

    fn open_documents(&self) -> Vec<String> {
        texts(self.deps, "openDocuments")
    }

    fn open_path(&mut self, path: &str) -> bool {
        self.put(vec![json!("openPath"), json!(path)]);
        flag(self.deps, "openPath")
    }

    fn read_project_prefs_override(
        &mut self,
        folder: &str,
    ) -> Option<Result<AgentProjectPrefs, Failure>> {
        let prefs = self.dep("projectPrefs").as_object()?;
        self.put(vec![json!("readProjectPrefs"), json!(folder)]);
        Some(failing(prefs.get("read")).map(project_prefs_of))
    }

    fn write_project_prefs_override(
        &mut self,
        folder: &str,
        patch: &AgentProjectPrefsPatch,
    ) -> Option<Result<AgentProjectPrefs, Failure>> {
        let prefs = self.dep("projectPrefs").as_object()?;
        self.put(vec![
            json!("writeProjectPrefs"),
            json!(folder),
            jscompat::json_value_to_serde(&patch.to_json()),
        ]);
        Some(failing(prefs.get("write")).map(project_prefs_of))
    }

    fn has_project_skills(&self) -> bool {
        self.dep("projectSkills").is_object()
    }

    fn project_skills_view(&mut self, folder: &str) -> Result<AgentProjectSkillsView, Failure> {
        self.put(vec![json!("projectSkills.view"), json!(folder)]);
        failing(self.dep("projectSkills").get("view")).map(skills_view_of)
    }

    fn project_skills_set(
        &mut self,
        folder: &str,
        on: bool,
    ) -> Result<AgentProjectSkillsView, Failure> {
        self.put(vec![json!("projectSkills.set"), json!(folder), json!(on)]);
        failing(self.dep("projectSkills").get("set")).map(skills_view_of)
    }

    fn has_open_template_preview(&self) -> bool {
        self.deps.get("preview").is_some()
    }

    fn open_template_preview(
        &mut self,
        owner_id: i64,
        input: &TemplatePreviewInput,
    ) -> Result<TemplatePreviewOutcome, Failure> {
        let mut logged = Map::new();
        logged.insert("bytes".into(), json!(hex(&input.bytes)));
        logged.insert("fileName".into(), json!(input.file_name));
        logged.insert("title".into(), json!(input.title));
        logged.insert("tabTitle".into(), json!(input.tab_title));
        logged.insert("text".into(), json!(input.text));
        logged.insert("originalRedacted".into(), json!(input.original_redacted));
        logged.insert("proposal".into(), to_value(&input.proposal));
        if let Some(draft) = &input.draft {
            logged.insert("draft".into(), jscompat::json_value_to_serde(draft));
        }
        self.put(vec![
            json!("preview"),
            json!(owner_id),
            Value::Object(logged),
        ]);
        let answer = failing(Some(self.dep("preview")))?;
        Ok(if flag(answer, "ok") {
            TemplatePreviewOutcome::Opened {
                tab_id: text(answer, "tabId"),
                preview_id: text(answer, "previewId"),
            }
        } else {
            TemplatePreviewOutcome::Refused {
                reason: text(answer, "reason"),
            }
        })
    }

    fn show_open_dialog(&mut self, options: &JsObject<JsonValue>) -> JsonValue {
        self.put(vec![
            json!("showOpenDialog"),
            jscompat::json_value_to_serde(&JsonValue::Object(options.clone())),
        ]);
        json_value_from_serde(self.v.get("dialog").unwrap_or(&Value::Null))
    }

    fn deck(&mut self) -> &mut dyn DeckArchive {
        &mut self.deck
    }

    fn agent(&mut self) -> &mut dyn AgentHost {
        self
    }
}

impl FolderHost for World<'_> {
    fn tmpdir(&self) -> String {
        std::env::temp_dir().to_string_lossy().into_owned()
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
        node_platform().to_owned()
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

/// the manager's host: the `deps` of the window as `createAgentManager` gets them
impl AgentHost for World<'_> {
    fn statuses(&mut self) -> JsonValue {
        json_value_from_serde(self.dep("statuses"))
    }

    fn ai_settings(&mut self) -> JsonValue {
        let mut settings = Map::new();
        settings.insert("providers".into(), json!({}));
        if let Some(metered) = self.dep("metered").as_object() {
            settings.insert("meteredAccepted".into(), Value::Object(metered.clone()));
        }
        json_value_from_serde(&Value::Object(settings))
    }

    fn open_documents(&mut self) -> Vec<String> {
        texts(self.deps, "openDocuments")
    }

    fn language(&mut self) -> String {
        text(self.deps, "lang")
    }

    fn random_uuid(&mut self) -> String {
        self.uuid()
    }

    /// the `emit` of `configureAgentWindow`: the event reaches the window's page while it is
    /// open and still the session's owner
    fn emit(&mut self, owner_id: i64, session_id: &str, event: &JsonValue) {
        if let Some(payload) = agent_emit(&*self, owner_id, session_id, event) {
            let page = self.window().map_or(0, |win| win.contents_id);
            self.put(vec![
                json!("send"),
                json!(page),
                json!("agent-window:event"),
                payload,
            ]);
        }
    }

    fn has_app_mcp(&self) -> bool {
        true
    }

    fn has_relays(&self) -> bool {
        false
    }

    fn has_build_skills(&self) -> bool {
        false
    }

    /// the folder goes at once; nothing of it is logged here
    fn remove_folder(&mut self, dir: &str, _options: &RemoveOptions) {
        let _ = crate::markdown::fs_util::rm_recursive_force(dir);
    }

    fn remove_folder_sync(&mut self, dir: &str, _options: &RemoveOptions) -> bool {
        crate::markdown::fs_util::rm_recursive_force(dir).is_ok()
    }

    fn relay_settled(&mut self, _ask_id: &str, _answer: &RelayAnswer) {}
}

/// the tools of a session, over the world: its window, its skills list and its cards
struct WorldTools<'r, 'a> {
    world: &'r mut World<'a>,
    shown: &'r mut AgentWindowShown,
    owner: i64,
    /// the calls of `window()` so far
    window_calls: usize,
}

impl AgentSkillToolsDeps for WorldTools<'_, '_> {
    fn window_open(&mut self) -> bool {
        self.window_calls += 1;
        // the TypeScript's `context.openTabs()` sits between the first and the
        // second call of `window()`: the snapshot's call, logged where it was made
        if self.window_calls == 2 {
            self.world.put(vec![json!("openTabs")]);
        }
        agent_live_owner(&*self.world, self.owner)
    }

    fn send_to_window(&mut self, channel: &str, payload: &Value) {
        let id = self.world.window().map_or(0, |win| win.contents_id);
        self.world.put(vec![
            json!("send"),
            json!(id),
            json!(channel),
            payload.clone(),
        ]);
    }

    fn list_skills(&mut self) -> Option<Result<Vec<AgentSkillListEntry>, Failure>> {
        let skills = self.world.deps.get("listSkills")?;
        self.world.put(vec![json!("listSkills")]);
        Some(match skills {
            Value::String(_) => Err(Failure("list".to_owned())),
            other => Ok(other
                .as_array()
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .map(list_entry_of)
                .collect()),
        })
    }

    fn session_skills(&mut self) -> Vec<AgentSessionSkillName> {
        Vec::new()
    }

    fn keep(&mut self, shown: ShownProposal) {
        self.shown.keep(shown);
    }

    fn new_key(&mut self) -> String {
        self.world.uuid()
    }
}

fn optional(v: Option<String>) -> Value {
    v.map_or(Value::Null, Value::String)
}

/// the project preferences or skills a handler answers, null for none
fn view_json(view: Option<JsonValue>) -> Value {
    view.map_or(Value::Null, |view| jscompat::json_value_to_serde(&view))
}

/// One step of a case: its result, the calls it made being in `world.log`
fn step(
    world: &mut World<'_>,
    manager: &mut AgentManager,
    shown: &mut AgentWindowShown,
    step: &Value,
    now_ms: f64,
) -> Value {
    if let Some(open) = step.get("open") {
        world.open(open.get("rendererUrl").and_then(Value::as_str));
    } else if let Some(minimize) = step.get("minimize") {
        if let Some(win) = world.win.as_mut() {
            win.minimized = *minimize == Value::Bool(true);
        }
    } else if step.get("destroy").is_some() {
        if let Some(win) = world.win.as_mut() {
            win.destroyed = true;
        }
    } else if let Some(event) = step.get("fire").and_then(Value::as_str) {
        if event == "ready-to-show" {
            world.put(vec![json!("show")]);
        } else if let Some(id) = world.win.as_ref().map(|win| win.id) {
            manager.stop_owner(world, id);
            world.win = None;
        }
    } else if let Some(url) = step.get("openUrl").and_then(Value::as_str) {
        if let Some(target) = safe_external_url(Some(url), None) {
            world.put(vec![json!("openExternal"), json!(target)]);
        }
        return json!({ "action": "deny" });
    } else if let Some(key) = step.get("invoke").and_then(Value::as_str) {
        return invoke(world, manager, shown, key, step, now_ms);
    } else if let Some(who) = step.get("isWindowContents").and_then(Value::as_str) {
        let sender = world.sender(who);
        return Value::Bool(agent_is_window_contents(&*world, sender));
    } else if let Some(n) = step.get("sessionEvent").and_then(Value::as_u64) {
        let Some((owner, id)) = world.programs.get(n as usize).cloned() else {
            return Value::Null;
        };
        let event = json_value_from_serde(step.get("event").unwrap_or(&Value::Null));
        manager.on_event(world, owner, &id, &event);
    } else if step.get("release").is_some() {
        let Some((job, answer)) = world.held.take() else {
            return Value::Null;
        };
        let next = job.resume(world, manager, answer, now_ms);
        return drive_window_start(world, manager, next, false, now_ms).unwrap_or(Value::Null);
    } else if let Some(tool) = step.get("tool").and_then(Value::as_str) {
        let n = step.get("session").and_then(Value::as_u64).unwrap_or(0) as usize;
        let Some((owner, id, root)) = world.hooks.get(n).cloned() else {
            return Value::Null;
        };
        let tools = AgentSkillTools {
            session: AgentMcpSession {
                owner_id: owner,
                session_id: &id,
            },
            project_root: &root,
            platform: node_platform(),
        };
        let mut deps = WorldTools {
            world,
            shown,
            owner,
            window_calls: 0,
        };
        let done = if tool == "proposeSkill" {
            // the snapshot the shell gathers first (`context.openTabs()`); a
            // rejection of it is an empty list
            let tabs: Vec<AgentOpenTab> = match step.get("tabs") {
                Some(Value::Array(tabs)) => tabs.iter().map(tab_of).collect(),
                _ => Vec::new(),
            };
            let input = proposal_input_of(step.get("input").unwrap_or(&Value::Null));
            tools.propose_skill(&input, &tabs, &mut deps)
        } else {
            tools.propose_install(&text(step, "address"), &mut deps)
        };
        return match done {
            Ok(()) => json!("shown"),
            Err(message) => json!({ "threw": message }),
        };
    }
    Value::Null
}

/// a handler of the window, called by the key of its channel
fn invoke(
    world: &mut World<'_>,
    manager: &mut AgentManager,
    shown: &mut AgentWindowShown,
    key: &str,
    step: &Value,
    now_ms: f64,
) -> Value {
    let sender = world.sender(&text(step, "sender"));
    let args: Vec<Option<JsonValue>> = (0..6)
        .map(|i| {
            step.get("args")
                .and_then(|a| a.get(i))
                .map(json_value_from_serde)
        })
        .collect();
    let arg = |i: usize| args[i].as_ref();
    match key {
        "getInit" => agent_get_init(&*world, sender).unwrap_or(Value::Null),
        "getTheme" => json!(agent_get_theme(&*world)),
        "homeOpen" => {
            if agent_home_may_open(&*world, sender) {
                world.open(None);
            }
            Value::Null
        }
        "pickFolder" => optional(agent_pick_folder(world, sender)),
        "setPrefs" => agent_set_prefs(world, sender, arg(0)).map_or(Value::Null, |prefs| {
            jscompat::json_value_to_serde(&prefs.to_json())
        }),
        "getProjectPrefs" => agent_get_project_prefs(world, sender, arg(0))
            .map_or(Value::Null, |prefs| {
                jscompat::json_value_to_serde(&prefs.to_json())
            }),
        "setProjectPrefs" => agent_set_project_prefs(world, sender, arg(0), arg(1))
            .map_or(Value::Null, |prefs| {
                jscompat::json_value_to_serde(&prefs.to_json())
            }),
        "getProjectSkills" => {
            view_json(agent_get_project_skills(world, sender, arg(0)).map(|view| view.to_json()))
        }
        "setProjectSkills" => view_json(
            agent_set_project_skills(world, sender, arg(0), arg(1)).map(|view| view.to_json()),
        ),
        "start" => {
            let first = agent_start(world, manager, sender, arg(0), now_ms);
            let detach = step.get("detach") == Some(&Value::Bool(true));
            drive_window_start(world, manager, first, detach, now_ms).unwrap_or(Value::Null)
        }
        "send" => Value::Bool(match agent_send(world, manager, sender, arg(0), arg(1)) {
            AgentWindowSendStep::Done(done) => done,
            // the fake program takes every message
            AgentWindowSendStep::Await { job, .. } => job.resume(Ok(())),
        }),
        "answer" => {
            agent_answer(world, manager, sender, arg(0), arg(1), arg(2), arg(3));
            Value::Null
        }
        "stop" => {
            agent_stop(world, manager, sender, arg(0));
            Value::Null
        }
        "openFile" => Value::Bool(agent_open_file(world, manager, sender, arg(0), arg(1))),
        "templateCheck" => match agent_template_check(world, shown, sender, arg(0), arg(1)) {
            TemplateCheck::Ok { redaction } => {
                json!({ "ok": true, "redaction": redaction.as_str() })
            }
            TemplateCheck::Refused(reason) => json!({ "ok": false, "reason": reason.as_str() }),
        },
        "templateAsIs" => match agent_template_as_is(world, shown, sender, arg(0), arg(1)) {
            TemplateAsIs::Ok { bytes, file_name } => {
                json!({ "ok": true, "bytes": hex(&bytes), "fileName": file_name })
            }
            TemplateAsIs::Refused(reason) => json!({ "ok": false, "reason": reason.as_str() }),
        },
        "templateBlank" => {
            match agent_template_blank(world, shown, sender, arg(0), arg(1), arg(2)) {
                TemplateBlank::Ok { tab_id, preview_id } => {
                    json!({ "ok": true, "tabId": tab_id, "previewId": preview_id })
                }
                TemplateBlank::Refused(reason) => {
                    json!({ "ok": false, "reason": reason.as_str() })
                }
            }
        }
        _ => Value::Null,
    }
}

fn window_call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let now_ms = cx.now_ms;
    Some(match name {
        "agent-window.window" => (|| {
            let spec = need(args, 0)?;
            let mut world = World::new(spec, now_ms);
            let mut manager = world.manager();
            let mut shown = AgentWindowShown::new();
            let results: Vec<Value> = list(spec, "steps")
                .iter()
                .map(|s| step(&mut world, &mut manager, &mut shown, s, now_ms))
                .collect();
            // the sessions end with the app: nothing of that is logged
            world.log.quiet.set(true);
            manager.stop_all(&mut world);
            cx.logs.extend(world.log.lines.borrow_mut().drain(..));
            Ok(Some(Value::Array(results)))
        })(),
        "agent-window.startAgentForWindow" => (|| {
            let spec = need(args, 0)?;
            let mut world = World::new(spec, now_ms);
            let request = arg(args, 1).map(json_value_from_serde);
            let answer = match plan_agent_start(&mut world, request.as_ref()) {
                Ok(plan) => {
                    let result = world.scripted_outcome(5, plan.request());
                    plan.finish(&mut world, result, now_ms)
                }
                Err(response) => response,
            };
            cx.logs.extend(world.log.lines.borrow_mut().drain(..));
            Ok(Some(answer))
        })(),
        _ => return None,
    })
}

// ---- agent-window: the skill tools ---------------------------------------------

/// the `d` of `agentSkillToolsFor` the scenario scripts: each call of a
/// service is one log line, as the TypeScript's fake writes it
struct ToolsDeps<'a> {
    v: &'a Value,
    calls: usize,
    keys: usize,
    log: Vec<Vec<Value>>,
}

impl AgentSkillToolsDeps for ToolsDeps<'_> {
    fn window_open(&mut self) -> bool {
        let script = list(self.v, "window");
        let at = self.calls.min(script.len().saturating_sub(1));
        self.calls += 1;
        // the TypeScript's `context.openTabs()` sits between the first and
        // the second call of `window()`: the snapshot's call, logged where it
        // was made
        if self.calls == 2 {
            self.log.push(vec![json!("openTabs")]);
        }
        let open = script.get(at) == Some(&Value::Bool(true));
        self.log.push(vec![json!("window"), json!(open)]);
        open
    }

    fn send_to_window(&mut self, channel: &str, payload: &Value) {
        self.log
            .push(vec![json!("send"), json!(channel), payload.clone()]);
    }

    fn list_skills(&mut self) -> Option<Result<Vec<AgentSkillListEntry>, Failure>> {
        let skills = self.v.get("list")?;
        self.log.push(vec![json!("listSkills")]);
        Some(match skills {
            Value::String(_) => Err(Failure("list".to_owned())),
            other => Ok(other
                .as_array()
                .map_or(&[][..], Vec::as_slice)
                .iter()
                .map(list_entry_of)
                .collect()),
        })
    }

    fn session_skills(&mut self) -> Vec<AgentSessionSkillName> {
        let Some(skills) = self.v.get("sessionSkills") else {
            return Vec::new();
        };
        self.log.push(vec![json!("sessionSkills")]);
        skills
            .as_array()
            .map_or(&[][..], Vec::as_slice)
            .iter()
            .map(|skill| AgentSessionSkillName {
                id: text(skill, "id"),
                name: text(skill, "name"),
            })
            .collect()
    }

    fn keep(&mut self, shown: ShownProposal) {
        self.log.push(vec![
            json!("keep"),
            json!({
                "ownerId": shown.owner_id,
                "sessionId": shown.session_id,
                "proposal": to_value(&shown.proposal),
                "candidates": to_value(&shown.candidates),
            }),
        ]);
    }

    fn new_key(&mut self) -> String {
        self.log.push(vec![json!("newKey")]);
        let key = texts(self.v, "keys").get(self.keys).cloned();
        self.keys += 1;
        key.unwrap_or_default()
    }
}

/// `agent-window.agentSkillToolsFor.proposeSkill` / `.proposeInstall`: the
/// tool of the scenario in argument 0, over the services it scripts. The open
/// tabs are the snapshot the shell gathers first (`context.openTabs()`): the
/// case's `tabs`, an empty list where the case makes the query throw.
fn tools_call(args: &[Value], cx: &mut Context, propose_skill: bool) -> Answer {
    let scenario = need(args, 0)?;
    let mut deps = ToolsDeps {
        v: scenario,
        calls: 0,
        keys: 0,
        log: Vec::new(),
    };
    let project_root = text(scenario, "projectRoot");
    let tools = AgentSkillTools {
        session: AgentMcpSession {
            owner_id: 5,
            session_id: "s1",
        },
        project_root: &project_root,
        platform: node_platform(),
    };
    let done = if propose_skill {
        let tabs: Vec<AgentOpenTab> = match scenario.get("tabs") {
            Some(Value::Array(tabs)) => tabs.iter().map(tab_of).collect(),
            _ => Vec::new(),
        };
        tools.propose_skill(&proposal_input_of(need(args, 1)?), &tabs, &mut deps)
    } else {
        tools.propose_install(str_arg(args, 1)?, &mut deps)
    };
    cx.logs.extend(deps.log);
    Ok(Some(match done {
        Ok(()) => json!("shown"),
        Err(message) => json!({ "threw": message }),
    }))
}
