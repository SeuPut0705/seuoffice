//! The probe fakes of the `agent` port's hosts: the agent window's frame
//! ([`AgentWindowFrame`]) and the shell services behind `configureAgentWindow`
//! ([`AgentServices`]), scripted by the case's `hosts.a.agent` (the TypeScript
//! half is tools/ipc-diff/groups/a/agent-window.ts, which reads the same value
//! and logs the same lines). Only Claude Code sessions are scripted: Codex
//! runs on the ai-provider runtime, which the diff drives in its own group.
//!
//! - `window`: the view of the open agent window (none open when absent)
//! - `theme` (`system`), `statuses` (`sharedSubscriptionStatuses()`), `settings`
//!   (`readStoredAiSettings()`), `documents` (the paths tabs show), `openPath`
//!   (`false` when a tab cannot open the file; true by default)
//! - `skills`: `userSkills.list()`; `enabled`: `userSkills.enabledForAgent(folder)`
//! - `bundle`: what `buildAgentSkillBundle` answers: `{dir, skills: [entry]}`, null for none
//! - `preview`: what `templateTabs.openPreview` answers: `{ok, tabId, previewId}`,
//!   `{ok: false, reason}` or `{throws}`
//! - `mcpRuntime: false`: the app has no MCP runtime to start a session's server on
//! - `runner`: `{events: [...], sendThrows: message}`: the events the program reports
//!   at its start (an `AgentSessionEvent` each); the message a send is refused with
//!
//! `hosts.a.lang` is the UI language (`ko` by default). `randomUUID()` counts:
//! the n-th is `00000000-0000-4000-8000-<n, 12 digits>`.
//!
//! Two triggers reach the events a session's MCP tools show in the window
//! (`agent-window:skill-proposal`, `agent-window:install-proposal`), which no
//! call of a renderer makes: `a/agent-propose-skill` `[sessionId, projectRoot,
//! input]` and `a/agent-propose-install` `[sessionId, projectRoot, address]`
//! call the session's skill hooks as `propose_skill` / `propose_skill_install`
//! do. The answer is undefined, or the message the hook refused with.
//!
//! The host log gets one line per call, named after the TypeScript call it
//! stands for: `["routeDocumentPath", path]`, `["userSkills.list"]`,
//! `["userSkills.enabledForAgent", folder]`, `["buildAgentSkillBundle", [name]]`,
//! `["startAgentMcpServer", projectRoot]`, `["appMcp.stop"]`,
//! `["claude.start", {projectRoot, mode, model, openDocuments, appMcp}]`,
//! `["session.send", text]`, `["session.answer", id, allow, scope]`,
//! `["session.setOpenDocuments", paths]`, `["session.stop"]`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use jscompat::{JsonValue, json_value_from_serde};
use main_core::shell::agent::agent_session_folders::ExecRequest;
use main_core::shell::agent::agent_sessions::{AgentSessionOptions, AgentSkillBundle};
use main_core::shell::agent::agent_skills::{
    AgentSkillEntry, AgentSkillListEntry, AgentSkillProposalInput, DeckEntry,
};
use main_core::shell::agent::agent_window::{TemplatePreviewInput, TemplatePreviewOutcome};
use serde_json::{Value, json};
use shell_contract::editors::Then;
use shell_contract::runtime::Services;
use shell_contract::{IpcError, IpcValue, ViewId};

use super::{Log, push};
use crate::agent::{
    AgentServices, AgentServicesHost, AgentWindowFrame, AgentWindowFrameHost, AppMcpStarted,
    ClaudeSession, Fault, RelayAsker, RelaysStarted, RunnerFault, SessionRef, SkillHooks,
};

/// the value, `{}` where the case gives none
fn object_or_empty(value: &Value) -> JsonValue {
    if value.is_null() {
        json_value_from_serde(&json!({}))
    } else {
        json_value_from_serde(value)
    }
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

/// the window's frame: the view the case says is open; making one logs and opens `window`'s view
struct Frame {
    view: Mutex<Option<ViewId>>,
    log: Option<Log>,
}

impl AgentWindowFrame for Frame {
    fn view(&self) -> Option<ViewId> {
        *self.view.lock().expect("the view")
    }

    fn is_minimized(&self) -> bool {
        false
    }

    fn reveal(&self, restore: bool) {
        push(&self.log, json!(["BrowserWindow.reveal", restore]));
    }

    fn window_title(&self, lang: &str) -> String {
        format!("agent:{lang}")
    }

    fn preload_path(&self) -> String {
        "/probe/preload/agent.js".into()
    }

    fn renderer_url(&self) -> Option<String> {
        None
    }

    fn built_file(&self) -> String {
        "/probe/renderer/agent.html".into()
    }

    fn create(&self, options: &Value, load: &Value) -> ViewId {
        push(
            &self.log,
            json!(["BrowserWindow.new", options["width"], options["height"]]),
        );
        push(&self.log, json!(["BrowserWindow.load", load]));
        let view = ViewId(2);
        *self.view.lock().expect("the view") = Some(view);
        view
    }
}

/// a running program
struct Program {
    log: Option<Log>,
    send_throws: Option<String>,
}

impl ClaudeSession for Program {
    fn send(&self, text: &str) -> Result<(), String> {
        push(&self.log, json!(["session.send", text]));
        match &self.send_throws {
            Some(message) => Err(message.clone()),
            None => Ok(()),
        }
    }

    fn answer(&self, id: &str, allow: bool, scope: Option<&str>, _message: Option<&str>) {
        push(&self.log, json!(["session.answer", id, allow, scope]));
    }

    fn set_open_documents(&self, paths: &[String]) {
        push(&self.log, json!(["session.setOpenDocuments", paths]));
    }

    fn stop(&self) {
        push(&self.log, json!(["session.stop"]));
    }
}

fn skill_entry(value: &Value) -> AgentSkillEntry {
    AgentSkillEntry {
        id: text(value, "id"),
        name: text(value, "name"),
        source: text(value, "source"),
        plugin: value["plugin"].as_str().map(str::to_owned),
        title: text(value, "title"),
        description: text(value, "description"),
        invoke: text(value, "invoke"),
        skill_md: text(value, "skillMd"),
    }
}

/// the skill hooks of each session started in the case, by session id: what a trigger calls
#[derive(Clone, Default)]
pub struct SessionHooks(Arc<Mutex<Vec<StartedHooks>>>);

/// a session's id and its hooks
type StartedHooks = (String, Arc<dyn SkillHooks>);

struct Svc {
    hooks: SessionHooks,
    world: Value,
    lang: String,
    log: Option<Log>,
    uuids: AtomicU64,
}

impl AgentServices for Svc {
    fn lang(&self) -> String {
        self.lang.clone()
    }

    fn theme(&self) -> String {
        self.world["theme"].as_str().unwrap_or("system").to_owned()
    }

    fn statuses(&self) -> JsonValue {
        object_or_empty(&self.world["statuses"])
    }

    fn ai_settings(&self) -> JsonValue {
        object_or_empty(&self.world["settings"])
    }

    fn open_documents(&self) -> Vec<String> {
        self.world["documents"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn open_path(&self, path: &str) -> bool {
        push(&self.log, json!(["routeDocumentPath", path]));
        self.world["openPath"] != json!(false)
    }

    fn list_skills(&self) -> Result<Vec<AgentSkillListEntry>, String> {
        push(&self.log, json!(["userSkills.list"]));
        Ok(self.world["skills"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .map(|item| AgentSkillListEntry {
                        id: text(item, "id"),
                        source: text(item, "source"),
                        name: text(item, "name"),
                        title: text(item, "title"),
                        owned: item["owned"] == json!(true),
                        unreadable: None,
                        editors: None,
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    fn enabled_for_agent(&self, folder: &str) -> Result<Vec<JsonValue>, String> {
        push(&self.log, json!(["userSkills.enabledForAgent", folder]));
        Ok(self.world["enabled"]
            .as_array()
            .map(|items| items.iter().map(json_value_from_serde).collect())
            .unwrap_or_default())
    }

    fn build_skill_bundle(
        &self,
        skills: &[JsonValue],
        _dir: &str,
    ) -> Result<Option<AgentSkillBundle>, Fault> {
        let names: Vec<Value> = skills
            .iter()
            .map(|skill| match skill {
                JsonValue::Object(object) => match object.get("name") {
                    Some(JsonValue::String(name)) => json!(name),
                    _ => Value::Null,
                },
                _ => Value::Null,
            })
            .collect();
        push(&self.log, json!(["buildAgentSkillBundle", names]));
        let bundle = &self.world["bundle"];
        if bundle.is_null() {
            return Ok(None);
        }
        Ok(Some(AgentSkillBundle {
            dir: text(bundle, "dir"),
            skills: bundle["skills"]
                .as_array()
                .map(|items| items.iter().map(skill_entry).collect())
                .unwrap_or_default(),
        }))
    }

    fn open_template_preview(
        &self,
        owner: ViewId,
        input: &TemplatePreviewInput,
    ) -> Result<TemplatePreviewOutcome, String> {
        push(
            &self.log,
            json!([
                "templateTabs.openPreview",
                owner.0,
                { "fileName": input.file_name, "tabTitle": input.tab_title }
            ]),
        );
        let preview = &self.world["preview"];
        if let Some(message) = preview["throws"].as_str() {
            return Err(message.to_owned());
        }
        Ok(if preview["ok"] == json!(true) {
            TemplatePreviewOutcome::Opened {
                tab_id: text(preview, "tabId"),
                preview_id: text(preview, "previewId"),
            }
        } else {
            TemplatePreviewOutcome::Refused {
                reason: text(preview, "reason"),
            }
        })
    }

    fn has_app_mcp(&self) -> bool {
        true
    }

    fn start_app_mcp(
        &self,
        project_root: &str,
        session: &SessionRef,
        hooks: Arc<dyn SkillHooks>,
    ) -> Result<AppMcpStarted, Fault> {
        if self.world["mcpRuntime"] == json!(false) {
            return Err(Fault::new("the MCP runtime is not configured"));
        }
        push(&self.log, json!(["startAgentMcpServer", project_root]));
        self.hooks
            .0
            .lock()
            .expect("the hooks")
            .push((session.session_id.clone(), hooks));
        let log = self.log.clone();
        Ok(AppMcpStarted {
            url: "http://127.0.0.1:1/mcp".into(),
            token: "token".into(),
            stop: Box::new(move || push(&log, json!(["appMcp.stop"]))),
        })
    }

    fn has_user_mcp(&self) -> bool {
        true
    }

    fn start_relays(
        &self,
        _session: &SessionRef,
        _ask: Arc<dyn RelayAsker>,
    ) -> Result<RelaysStarted, Fault> {
        // `userMcp()` answers no hub: no relays
        Ok(RelaysStarted {
            relays: Vec::new(),
            keep_results_inside: Vec::new(),
            stop: Box::new(|| {}),
        })
    }

    fn run_claude(
        &self,
        options: &AgentSessionOptions,
        on_event: Arc<dyn Fn(JsonValue) + Send + Sync>,
    ) -> Result<Arc<dyn ClaudeSession>, RunnerFault> {
        push(
            &self.log,
            json!([
                "claude.start",
                {
                    "projectRoot": options.project_root,
                    "mode": options.mode,
                    "model": options.model,
                    "openDocuments": options.open_documents,
                    "appMcp": options.app_mcp.is_some(),
                }
            ]),
        );
        let runner = &self.world["runner"];
        if let Some(events) = runner["events"].as_array() {
            for event in events {
                on_event(json_value_from_serde(event));
            }
        }
        Ok(Arc::new(Program {
            log: self.log.clone(),
            send_throws: runner["sendThrows"].as_str().map(str::to_owned),
        }))
    }

    fn deck_open(&self, _bytes: &[u8]) -> Result<Vec<DeckEntry>, String> {
        Err("no archive".into())
    }

    fn deck_text(&self, _index: usize) -> Result<String, String> {
        Err("no archive".into())
    }

    fn random_uuid(&self) -> String {
        let n = self.uuids.fetch_add(1, Ordering::SeqCst) + 1;
        format!("00000000-0000-4000-8000-{n:012}")
    }

    fn process_alive(&self, _pid: f64) -> bool {
        false
    }

    fn exec_file(&self, _request: &ExecRequest) -> String {
        String::new()
    }
}

/// Inserts this port's factory and the fakes of its hosts, answering from
/// the case's `hosts.a` value; `log` is the case's host log
pub fn insert(hosts: &mut shell_contract::Hosts, case: &Value, log: Option<Log>) {
    let world = &case["agent"];
    hosts.insert(crate::agent::factory());
    let hooks = SessionHooks::default();
    hosts.insert(hooks.clone());
    hosts.insert::<AgentWindowFrameHost>(Arc::new(Frame {
        view: Mutex::new(world["window"].as_u64().map(|view| ViewId(view as u32))),
        log: log.clone(),
    }));
    hosts.insert::<AgentServicesHost>(Arc::new(Svc {
        hooks,
        world: world.clone(),
        lang: case["lang"].as_str().unwrap_or("ko").to_owned(),
        log,
        uuids: AtomicU64::new(0),
    }));
}

thread_local! {
    /// the triggers waiting for their hook, by key (the core thread's)
    static WAITING: RefCell<HashMap<u64, Then<IpcValue>>> = RefCell::new(HashMap::new());
}

static NEXT_WAIT: AtomicU64 = AtomicU64::new(1);

fn text_of(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

/// Runs the named trigger: `a/agent-propose-skill` `[sessionId, projectRoot, input]` and
/// `a/agent-propose-install` `[sessionId, projectRoot, address]`; `false` for another name.
/// The session is one started in the case; the answer is what the hook resolves to
pub fn trigger(
    name: &str,
    _view: ViewId,
    args: &Value,
    services: &Services,
    _provided: &std::rc::Rc<shell_contract::Provided>,
    then: Then<IpcValue>,
) -> bool {
    if !matches!(name, "a/agent-propose-skill" | "a/agent-propose-install") {
        return false;
    }
    let Some(store) = services.hosts.get::<SessionHooks>() else {
        return false;
    };
    let session = args[0].as_str().unwrap_or_default();
    let hooks = store
        .0
        .lock()
        .expect("the hooks")
        .iter()
        .rev()
        .find(|(id, _)| id == session)
        .map(|(_, hooks)| hooks.clone());
    let Some(hooks) = hooks else {
        then(Err(IpcError {
            name: Some("Error".into()),
            message: format!("no session {session} was started"),
        }));
        return true;
    };
    let key = NEXT_WAIT.fetch_add(1, Ordering::Relaxed);
    WAITING.with(|waiting| waiting.borrow_mut().insert(key, then));
    let core = services.core.clone();
    let done: Box<dyn FnOnce(Result<(), String>) + Send> = Box::new(move |result| {
        core.post(Box::new(move || {
            let then = WAITING.with(|waiting| waiting.borrow_mut().remove(&key));
            if let Some(then) = then {
                then(match result {
                    Ok(()) => Ok(IpcValue::Undefined),
                    Err(message) => Err(IpcError {
                        name: Some("Error".into()),
                        message,
                    }),
                });
            }
        }));
    });
    if name == "a/agent-propose-skill" {
        let input = &args[2];
        hooks.propose_skill(
            AgentSkillProposalInput {
                title: text_of(input, "title"),
                name: text_of(input, "name"),
                description: text_of(input, "description"),
                body: text_of(input, "body"),
                wants_template: input["wantsTemplate"] == json!(true),
                target_id: text_of(input, "targetId"),
                suggested_template_path: text_of(input, "suggestedTemplatePath"),
            },
            Vec::new(),
            done,
        );
    } else {
        hooks.propose_install(args[2].as_str().unwrap_or_default().to_owned(), done);
    }
    true
}
