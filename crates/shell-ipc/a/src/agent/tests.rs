//! Behavior of the agent window port over fake hosts: what each channel
//! answers, what the window is sent, what the program and the services are
//! asked. The core thread is the test's: the posted jobs run when it pumps them, and the awaited calls of a start run on real worker threads.

use std::collections::HashSet;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Condvar;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jscompat::{JsObject, JsonValue};
use main_core::shell::agent::agent_session_folders::ExecRequest;
use main_core::shell::agent::agent_sessions::{AgentSessionOptions, AgentSkillBundle};
use main_core::shell::agent::agent_skills::{
    AgentOpenTab, AgentSkillListEntry, AgentSkillProposalInput, DeckEntry,
};
use main_core::shell::agent::agent_window::{TemplatePreviewInput, TemplatePreviewOutcome};
use shell_contract::hosts::{
    Contents, Dialogs, FileDialog, Hosts, MainWindow, MessageBox, MessageBoxAnswer,
};
use shell_contract::ipc::{CallContext, EventSink, Sender, Target};
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Services, Thread, Views, Workers};
use shell_contract::{IpcError, IpcValue, Surface, ViewId, WindowId};

use super::*;

const HOME_VIEW: u32 = 1;
const WINDOW_VIEW: u32 = 2;
const STRANGER_VIEW: u32 = 3;

type Job = Box<dyn FnOnce() + Send>;

/// the core thread's queue: the test runs what was posted when it pumps
#[derive(Default)]
struct Queue(Mutex<VecDeque<Job>>);

impl Thread for Queue {
    fn post(&self, job: Job) {
        self.0.lock().unwrap().push_back(job);
    }
    fn is_current(&self) -> bool {
        false
    }
}

/// workers on real threads, counted so a test can tell when they are all done
#[derive(Default)]
struct ThreadWorkers(Arc<AtomicUsize>);

impl Workers for ThreadWorkers {
    fn spawn(&self, job: Job) {
        let busy = self.0.clone();
        busy.fetch_add(1, Ordering::SeqCst);
        std::thread::spawn(move || {
            job();
            busy.fetch_sub(1, Ordering::SeqCst);
        });
    }
}

/// holds a call until the test lets it go
#[derive(Default)]
struct Gate(Mutex<bool>, Condvar);

impl Gate {
    fn wait(&self) {
        let mut open = self.0.lock().unwrap();
        while !*open {
            open = self.1.wait(open).unwrap();
        }
    }
    fn release(&self) {
        *self.0.lock().unwrap() = true;
        self.1.notify_all();
    }
}

#[derive(Default)]
struct FakeViews(Mutex<HashSet<u32>>);

impl Views for FakeViews {
    fn sender_of(&self, view: ViewId) -> Option<Sender> {
        self.0.lock().unwrap().contains(&view.0).then_some(Sender {
            view,
            window: WindowId(view.0),
            surface: Surface::ShellAgent,
        })
    }
    fn all(&self) -> Vec<Sender> {
        Vec::new()
    }
    fn on_destroyed(&self, _: Box<dyn Fn(ViewId) + Send + Sync>) {}
}

struct Dir(PathBuf);

impl AppPaths for Dir {
    fn path(&self, name: PathName) -> PathBuf {
        match name {
            PathName::Home => self.0.join("home"),
            PathName::Temp => self.0.join("tmp"),
            PathName::UserData => self.0.join("userData"),
            _ => self.0.clone(),
        }
    }
}

#[derive(Default)]
struct Events(Mutex<Vec<(Target, &'static str, Vec<IpcValue>)>>);

impl EventSink for Events {
    fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
        self.0.lock().unwrap().push((target, channel, args));
    }
}

impl Events {
    fn on(&self, channel: &str) -> Vec<(Target, IpcValue)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, name, _)| *name == channel)
            .map(|(target, _, args)| (*target, args[0].clone()))
            .collect()
    }
}

struct Frame {
    views: Arc<FakeViews>,
    view: Mutex<Option<ViewId>>,
    minimized: AtomicBool,
    log: Mutex<Vec<String>>,
    created: Mutex<Vec<(serde_json::Value, serde_json::Value)>>,
}

impl AgentWindowFrame for Frame {
    fn view(&self) -> Option<ViewId> {
        *self.view.lock().unwrap()
    }
    fn is_minimized(&self) -> bool {
        self.minimized.load(Ordering::SeqCst)
    }
    fn reveal(&self, restore: bool) {
        self.log.lock().unwrap().push(format!("reveal {restore}"));
    }
    fn window_title(&self, lang: &str) -> String {
        format!("Agent {lang}")
    }
    fn preload_path(&self) -> String {
        "/app/preload/agent.js".into()
    }
    fn renderer_url(&self) -> Option<String> {
        None
    }
    fn built_file(&self) -> String {
        "/app/renderer/agent.html".into()
    }
    fn create(&self, options: &serde_json::Value, load: &serde_json::Value) -> ViewId {
        self.created
            .lock()
            .unwrap()
            .push((options.clone(), load.clone()));
        *self.view.lock().unwrap() = Some(ViewId(WINDOW_VIEW));
        self.views.0.lock().unwrap().insert(WINDOW_VIEW);
        ViewId(WINDOW_VIEW)
    }
}

struct FakeDialogs {
    picked: Mutex<Option<PathBuf>>,
    asked: Mutex<Vec<(Option<WindowId>, Vec<String>)>>,
}

impl Dialogs for FakeDialogs {
    fn open(&self, parent: Option<WindowId>, options: &FileDialog) -> Option<Vec<PathBuf>> {
        self.asked
            .lock()
            .unwrap()
            .push((parent, options.properties.clone()));
        self.picked.lock().unwrap().clone().map(|path| vec![path])
    }
    fn save(&self, _: Option<WindowId>, _: &FileDialog) -> Option<PathBuf> {
        None
    }
    fn message(&self, _: Option<WindowId>, _: &MessageBox) -> MessageBoxAnswer {
        MessageBoxAnswer {
            response: 0,
            checkbox_checked: false,
        }
    }
    fn error(&self, _: &str, _: &str) {}
}

struct FakeContents;

impl Contents for FakeContents {
    fn window_of(&self, view: ViewId) -> Option<WindowId> {
        Some(WindowId(view.0))
    }
    fn capture_png(&self, _: ViewId) -> Result<Vec<u8>, String> {
        Err("none".into())
    }
    fn print_to_pdf(&self, _: ViewId, _: IpcValue) -> Result<Vec<u8>, String> {
        Err("none".into())
    }
    fn print(&self, _: ViewId, _: IpcValue) -> Result<bool, String> {
        Ok(false)
    }
    fn zoom_factor(&self, _: ViewId) -> f64 {
        1.0
    }
    fn set_zoom_factor(&self, _: ViewId, _: f64) {}
    fn focus(&self, _: ViewId) {}
    fn close_window(&self, _: WindowId) {}
}

struct HomeWindow;

impl MainWindow for HomeWindow {
    fn view(&self) -> Option<ViewId> {
        Some(ViewId(HOME_VIEW))
    }
    fn window(&self) -> Option<WindowId> {
        Some(WindowId(HOME_VIEW))
    }
}

/// a program the fake runner started
struct Program {
    log: Arc<Mutex<Vec<String>>>,
}

impl ClaudeSession for Program {
    fn send(&self, text: &str) -> Result<(), String> {
        self.log.lock().unwrap().push(format!("send {text}"));
        Ok(())
    }
    fn answer(&self, id: &str, allow: bool, scope: Option<&str>, _: Option<&str>) {
        self.log
            .lock()
            .unwrap()
            .push(format!("answer {id} {allow} {}", scope.unwrap_or("-")));
    }
    fn set_open_documents(&self, paths: &[String]) {
        self.log
            .lock()
            .unwrap()
            .push(format!("documents {}", paths.join(",")));
    }
    fn stop(&self) {
        self.log.lock().unwrap().push("stop".into());
    }
}

/// A callback receiving each event the program reports
type EventListener = Arc<dyn Fn(JsonValue) + Send + Sync>;

struct Svc {
    statuses: Mutex<JsonValue>,
    settings: Mutex<JsonValue>,
    app_mcp: AtomicBool,
    enabled: Mutex<Vec<JsonValue>>,
    opened: Mutex<Vec<String>>,
    /// what happened to the program and the servers, in order
    program: Arc<Mutex<Vec<String>>>,
    hooks: Mutex<Vec<Arc<dyn SkillHooks>>>,
    /// the first event the program reports when it starts
    first_event: Mutex<Option<JsonValue>>,
    sink: Mutex<Vec<EventListener>>,
    /// the program's start waits here when set
    gate: Mutex<Option<Arc<Gate>>>,
    uuids: AtomicU64,
}

impl Svc {
    fn new() -> Self {
        Svc {
            statuses: Mutex::new(JsonValue::Null),
            settings: Mutex::new(JsonValue::Null),
            app_mcp: AtomicBool::new(false),
            enabled: Mutex::default(),
            opened: Mutex::default(),
            program: Arc::default(),
            hooks: Mutex::default(),
            first_event: Mutex::new(None),
            sink: Mutex::default(),
            gate: Mutex::new(None),
            uuids: AtomicU64::new(0),
        }
    }
}

impl AgentServices for Svc {
    fn random_uuid(&self) -> String {
        let n = self.uuids.fetch_add(1, Ordering::SeqCst) + 1;
        format!("00000000-0000-4000-8000-{n:012}")
    }
    fn lang(&self) -> String {
        "ko".into()
    }
    fn theme(&self) -> String {
        "dark".into()
    }
    fn statuses(&self) -> JsonValue {
        self.statuses.lock().unwrap().clone()
    }
    fn ai_settings(&self) -> JsonValue {
        self.settings.lock().unwrap().clone()
    }
    fn open_documents(&self) -> Vec<String> {
        Vec::new()
    }
    fn open_path(&self, path: &str) -> bool {
        self.opened.lock().unwrap().push(path.to_owned());
        true
    }
    fn list_skills(&self) -> Result<Vec<AgentSkillListEntry>, String> {
        Ok(Vec::new())
    }
    fn enabled_for_agent(&self, _: &str) -> Result<Vec<JsonValue>, String> {
        Ok(self.enabled.lock().unwrap().clone())
    }
    fn build_skill_bundle(
        &self,
        _: &[JsonValue],
        _: &str,
    ) -> Result<Option<AgentSkillBundle>, Fault> {
        Ok(None)
    }
    fn open_template_preview(
        &self,
        _: ViewId,
        _: &TemplatePreviewInput,
    ) -> Result<TemplatePreviewOutcome, String> {
        Ok(TemplatePreviewOutcome::Refused {
            reason: "none".into(),
        })
    }
    fn has_app_mcp(&self) -> bool {
        self.app_mcp.load(Ordering::SeqCst)
    }
    fn start_app_mcp(
        &self,
        _: &str,
        _: &SessionRef,
        hooks: Arc<dyn SkillHooks>,
    ) -> Result<AppMcpStarted, Fault> {
        self.hooks.lock().unwrap().push(hooks);
        let log = self.program.clone();
        Ok(AppMcpStarted {
            url: "http://127.0.0.1:1/mcp".into(),
            token: "token".into(),
            stop: Box::new(move || log.lock().unwrap().push("app-mcp stopped".into())),
        })
    }
    fn has_user_mcp(&self) -> bool {
        false
    }
    fn start_relays(&self, _: &SessionRef, _: Arc<dyn RelayAsker>) -> Result<RelaysStarted, Fault> {
        Err(Fault::new("no relays"))
    }
    fn run_claude(
        &self,
        options: &AgentSessionOptions,
        on_event: Arc<dyn Fn(JsonValue) + Send + Sync>,
    ) -> Result<Arc<dyn ClaudeSession>, RunnerFault> {
        self.program
            .lock()
            .unwrap()
            .push(format!("run {} {}", options.project_root, options.mode));
        let gate = self.gate.lock().unwrap().clone();
        if let Some(gate) = gate {
            gate.wait();
        }
        if let Some(event) = self.first_event.lock().unwrap().clone() {
            on_event(event);
        }
        self.sink.lock().unwrap().push(on_event);
        Ok(Arc::new(Program {
            log: self.program.clone(),
        }))
    }
    fn deck_open(&self, _: &[u8]) -> Result<Vec<DeckEntry>, String> {
        Err("no archive".into())
    }
    fn deck_text(&self, _: usize) -> Result<String, String> {
        Err("no archive".into())
    }
    fn process_alive(&self, _: f64) -> bool {
        false
    }
    fn exec_file(&self, _: &ExecRequest) -> String {
        String::new()
    }
}

type Invoke = fn(&AgentWindowPort, &CallContext, Vec<IpcValue>, shell_contract::ipc::Responder);

struct World {
    dir: PathBuf,
    port: AgentWindowPort,
    queue: Arc<Queue>,
    busy: Arc<AtomicUsize>,
    svc: Arc<Svc>,
    frame: Arc<Frame>,
    events: Arc<Events>,
    dialogs: Arc<FakeDialogs>,
}

fn obj(pairs: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut o = JsObject::new();
    for (k, v) in pairs {
        o.set(k, v);
    }
    JsonValue::Object(o)
}

fn string(s: &str) -> JsonValue {
    JsonValue::String(s.into())
}

fn ipc(value: &JsonValue) -> IpcValue {
    crate::value::from_json(value)
}

fn text(s: impl Into<String>) -> IpcValue {
    IpcValue::String(s.into())
}

fn field(value: &IpcValue, key: &str) -> Option<IpcValue> {
    match value {
        IpcValue::Object(entries) => entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, v)| v.clone()),
        _ => None,
    }
}

fn world(name: &str) -> World {
    let dir = std::env::temp_dir().join(format!("seuoffice-agent-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    for sub in ["home", "tmp", "userData", "project"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    let views = Arc::new(FakeViews::default());
    views.0.lock().unwrap().insert(HOME_VIEW);
    views.0.lock().unwrap().insert(STRANGER_VIEW);
    let events = Arc::new(Events::default());
    let queue = Arc::new(Queue::default());
    let workers = Arc::new(ThreadWorkers::default());
    let busy = workers.0.clone();
    let services = Services {
        ui: queue.clone(),
        core: queue.clone(),
        workers,
        events: events.clone(),
        views: views.clone(),
        paths: Arc::new(Dir(dir.clone())),
        hosts: Arc::new(Hosts::default()),
    };
    let svc = Arc::new(Svc::new());
    *svc.statuses.lock().unwrap() = obj(vec![(
        "claude-code",
        obj(vec![
            ("provider", string("claude-code")),
            ("state", string("ready")),
        ]),
    )]);
    *svc.settings.lock().unwrap() = obj(vec![]);
    let frame = Arc::new(Frame {
        views,
        view: Mutex::new(None),
        minimized: AtomicBool::new(false),
        log: Mutex::default(),
        created: Mutex::default(),
    });
    let dialogs = Arc::new(FakeDialogs {
        picked: Mutex::new(None),
        asked: Mutex::default(),
    });
    let driver = Driver::new(
        &services,
        crate::runtime::testing::FakeNet::new(&serde_json::json!({}), None),
    );
    let port = AgentWindowPort::new(Wiring {
        services,
        svc: svc.clone(),
        frame: frame.clone(),
        main_window: Arc::new(HomeWindow),
        dialogs: dialogs.clone(),
        contents: Arc::new(FakeContents),
        driver,
    });
    World {
        dir,
        port,
        queue,
        busy,
        svc,
        frame,
        events,
        dialogs,
    }
}

impl World {
    /// the window is open (as W's `create` leaves it)
    fn open_window(&self) {
        self.frame
            .create(&serde_json::json!({}), &serde_json::json!({}));
        self.frame.created.lock().unwrap().clear();
    }

    fn project(&self) -> String {
        self.dir.join("project").to_string_lossy().into_owned()
    }

    fn write_settings(&self, json: &str) {
        std::fs::write(self.dir.join("userData").join("app-settings.json"), json).unwrap();
    }

    fn settings(&self) -> String {
        std::fs::read_to_string(self.dir.join("userData").join("app-settings.json"))
            .unwrap_or_default()
    }

    /// the person accepted the warning
    fn accept_warning(&self) {
        self.write_settings(r#"{"agent":{"warningAccepted":1,"provider":"claude-code","mode":"ask-commands","recentFolders":[]}}"#);
    }

    /// runs what was posted to the core thread, until nothing is left
    fn pump(&self) {
        loop {
            let job = self.queue.0.lock().unwrap().pop_front();
            match job {
                Some(job) => job(),
                None => break,
            }
        }
    }

    /// pumps until every posted job ran and every worker is done
    fn settle(&self) {
        let until = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            self.pump();
            if self.busy.load(Ordering::SeqCst) == 0 && self.queue.0.lock().unwrap().is_empty() {
                return;
            }
            assert!(
                std::time::Instant::now() < until,
                "the workers did not finish"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// pumps until `done` holds
    fn until(&self, done: impl Fn() -> bool) {
        let until = std::time::Instant::now() + Duration::from_secs(20);
        while !done() {
            self.pump();
            assert!(
                std::time::Instant::now() < until,
                "the condition never held"
            );
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    /// makes a call and answers its `Receiver`, without waiting for the answer
    fn begin(
        &self,
        view: u32,
        invoke: Invoke,
        args: Vec<IpcValue>,
    ) -> Receiver<Result<IpcValue, IpcError>> {
        let (tx, rx) = channel();
        let cx = CallContext {
            sender: Sender {
                view: ViewId(view),
                window: WindowId(view),
                surface: Surface::ShellAgent,
            },
            request: None,
            cancel: CancelToken::default(),
        };
        invoke(
            &self.port,
            &cx,
            args,
            shell_contract::ipc::Responder::new(move |reply| {
                let _ = tx.send(reply);
            }),
        );
        rx
    }

    /// pumps until the call's answer is there
    fn finish<T>(&self, rx: &Receiver<T>) -> T {
        let until = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            self.pump();
            if let Ok(answer) = rx.try_recv() {
                return answer;
            }
            assert!(std::time::Instant::now() < until, "no answer");
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    fn call_as(
        &self,
        view: u32,
        invoke: Invoke,
        args: Vec<IpcValue>,
    ) -> Result<IpcValue, IpcError> {
        let rx = self.begin(view, invoke, args);
        self.finish(&rx)
    }

    fn call(&self, invoke: Invoke, args: Vec<IpcValue>) -> IpcValue {
        self.call_as(WINDOW_VIEW, invoke, args)
            .expect("not rejected")
    }

    fn start(&self) -> IpcValue {
        self.call(
            AgentWindowPort::agent_window_start,
            vec![ipc(&obj(vec![
                ("provider", string("claude-code")),
                ("mode", string("ask-commands")),
                ("folder", string(&self.project())),
            ]))],
        )
    }

    fn started_session(&self) -> String {
        self.accept_warning();
        self.open_window();
        let started = self.start();
        assert_eq!(
            field(&started, "ok"),
            Some(IpcValue::Bool(true)),
            "{started:?}"
        );
        match field(&started, "sessionId") {
            Some(IpcValue::String(id)) => id,
            other => panic!("no session id: {other:?}"),
        }
    }

    fn program(&self) -> Vec<String> {
        self.svc.program.lock().unwrap().clone()
    }
}

impl Drop for World {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// ---- the window and its preferences -------------------------------------------

#[test]
fn only_the_agent_windows_own_page_is_answered() {
    let w = world("owner");
    w.open_window();
    let from_other = w
        .call_as(
            STRANGER_VIEW,
            AgentWindowPort::agent_window_get_init,
            vec![],
        )
        .unwrap();
    assert_eq!(from_other, IpcValue::Null);
    let init = w.call(AgentWindowPort::agent_window_get_init, vec![]);
    assert_eq!(field(&init, "lang"), Some(text("ko")));
    let connections = field(&init, "connections").expect("connections");
    assert_eq!(field(&connections, "claude-code"), Some(text("ready")));
}

#[test]
fn nothing_is_answered_while_no_window_is_open() {
    let w = world("closed");
    assert_eq!(
        w.call(AgentWindowPort::agent_window_get_init, vec![]),
        IpcValue::Null
    );
    assert_eq!(
        w.call(AgentWindowPort::agent_window_pick_folder, vec![]),
        IpcValue::Null
    );
}

#[test]
fn the_theme_is_the_shells_current_theme() {
    let w = world("theme");
    assert_eq!(
        w.call(AgentWindowPort::agent_window_get_theme, vec![]),
        text("dark")
    );
}

#[test]
fn set_prefs_cannot_add_folders_or_claim_a_newer_warning() {
    let w = world("prefs");
    w.open_window();
    w.write_settings(r#"{"agent":{"warningAccepted":1,"provider":"claude-code","mode":"ask-commands","recentFolders":["/a","/b"]}}"#);
    let update = obj(vec![
        ("provider", string("codex")),
        ("warningAccepted", JsonValue::Number(9.0)),
        (
            "recentFolders",
            JsonValue::Array(vec![string("/b"), string("/evil")]),
        ),
    ]);
    let next = w.call(AgentWindowPort::agent_window_set_prefs, vec![ipc(&update)]);
    assert_eq!(field(&next, "provider"), Some(text("codex")));
    assert_eq!(field(&next, "warningAccepted"), Some(IpcValue::Number(1.0)));
    assert_eq!(
        field(&next, "recentFolders"),
        Some(IpcValue::Array(vec![text("/b")]))
    );
    assert!(w.settings().contains("codex"));
    assert!(!w.settings().contains("/evil"));
}

#[test]
fn pick_folder_answers_the_chosen_folder_or_null() {
    let w = world("pick");
    w.open_window();
    *w.dialogs.picked.lock().unwrap() = Some(PathBuf::from("/chosen/folder"));
    assert_eq!(
        w.call(AgentWindowPort::agent_window_pick_folder, vec![]),
        text("/chosen/folder")
    );
    *w.dialogs.picked.lock().unwrap() = None;
    assert_eq!(
        w.call(AgentWindowPort::agent_window_pick_folder, vec![]),
        IpcValue::Null
    );
    // the dialog is the agent window's, asking for a folder
    let asked = w.dialogs.asked.lock().unwrap().clone();
    assert_eq!(
        asked[0],
        (
            Some(WindowId(WINDOW_VIEW)),
            vec!["openDirectory".to_owned()]
        )
    );
}

#[test]
fn project_prefs_need_an_absolute_folder_and_are_remembered() {
    let w = world("project-prefs");
    w.open_window();
    let folder = w.project();
    assert_eq!(
        w.call(
            AgentWindowPort::agent_window_get_project_prefs,
            vec![text("relative/folder")]
        ),
        IpcValue::Null
    );
    let patch = obj(vec![("codexNetwork", JsonValue::Bool(true))]);
    let set = w.call(
        AgentWindowPort::agent_window_set_project_prefs,
        vec![text(&folder), ipc(&patch)],
    );
    assert_eq!(field(&set, "codexNetwork"), Some(IpcValue::Bool(true)));
    let read = w.call(
        AgentWindowPort::agent_window_get_project_prefs,
        vec![text(&folder)],
    );
    assert_eq!(field(&read, "codexNetwork"), Some(IpcValue::Bool(true)));
}

#[test]
fn project_skills_are_turned_on_as_they_are_now() {
    let w = world("project-skills");
    w.open_window();
    *w.svc.enabled.lock().unwrap() = vec![obj(vec![
        ("id", string("project:review")),
        ("name", string("review")),
        ("title", string("Review")),
        ("description", string("Reviews")),
        ("dir", string(&w.project())),
        ("source", string("project")),
    ])];
    let folder = text(w.project());
    let view = w.call(
        AgentWindowPort::agent_window_get_project_skills,
        vec![folder.clone()],
    );
    assert_eq!(field(&view, "allowed"), Some(IpcValue::Bool(false)));
    match field(&view, "skills") {
        Some(IpcValue::Array(skills)) => assert_eq!(skills.len(), 1),
        other => panic!("{other:?}"),
    }
    let on = w.call(
        AgentWindowPort::agent_window_set_project_skills,
        vec![folder.clone(), IpcValue::Bool(true)],
    );
    assert_eq!(field(&on, "allowed"), Some(IpcValue::Bool(true)));
    // anything but `true` turns them off
    let off = w.call(
        AgentWindowPort::agent_window_set_project_skills,
        vec![folder, text("yes")],
    );
    assert_eq!(field(&off, "allowed"), Some(IpcValue::Bool(false)));
}

// ---- sessions -------------------------------------------------------------------

#[test]
fn a_start_needs_the_accepted_warning_and_the_windows_own_page() {
    let w = world("start-refused");
    w.open_window();
    let refused = w.start();
    assert_eq!(field(&refused, "ok"), Some(IpcValue::Bool(false)));
    assert_eq!(
        field(&field(&refused, "failure").unwrap(), "reason"),
        Some(text("not-accepted"))
    );
    w.accept_warning();
    let stranger = w
        .call_as(
            STRANGER_VIEW,
            AgentWindowPort::agent_window_start,
            vec![ipc(&obj(vec![
                ("provider", string("claude-code")),
                ("mode", string("ask-commands")),
                ("folder", string(&w.project())),
            ]))],
        )
        .unwrap();
    assert_eq!(
        field(&field(&stranger, "failure").unwrap(), "reason"),
        Some(text("invalid-request"))
    );
    assert!(w.program().is_empty());
}

#[test]
fn a_start_runs_the_program_and_forwards_its_events_to_the_window() {
    let w = world("start");
    *w.svc.first_event.lock().unwrap() = Some(obj(vec![
        ("type", string("text")),
        ("text", string("hello")),
    ]));
    let id = w.started_session();
    assert_eq!(
        w.program(),
        vec![format!("run {} ask-commands", w.project())]
    );
    // the event the program reported while it started reaches the window, under the session's id
    let events = w.events.on("agent-window:event");
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].0, Target::View(ViewId(WINDOW_VIEW)));
    assert_eq!(field(&events[0].1, "sessionId"), Some(text(&id)));
    assert_eq!(
        field(&field(&events[0].1, "event").unwrap(), "text"),
        Some(text("hello"))
    );
    // the folder is remembered
    assert!(w.settings().contains("project"));
    // events of the program after the start follow through the same path
    let report = w.svc.sink.lock().unwrap()[0].clone();
    report(obj(vec![
        ("type", string("turn-done")),
        ("ok", JsonValue::Bool(true)),
    ]));
    w.settle();
    assert_eq!(w.events.on("agent-window:event").len(), 2);
}

#[test]
fn messages_and_answers_reach_the_program_of_their_own_session_only() {
    let w = world("session");
    let id = w.started_session();
    let sent = w.call(
        AgentWindowPort::agent_window_send,
        vec![text(&id), text("do it")],
    );
    assert_eq!(sent, IpcValue::Bool(true));
    for (session, message) in [(id.as_str(), "  \n"), ("no-such-session", "x")] {
        assert_eq!(
            w.call(
                AgentWindowPort::agent_window_send,
                vec![text(session), text(message)]
            ),
            IpcValue::Bool(false)
        );
    }
    let answered = w.call(
        AgentWindowPort::agent_window_answer,
        vec![
            text(&id),
            text("req-1"),
            IpcValue::Bool(true),
            text("session"),
        ],
    );
    assert_eq!(answered, IpcValue::Undefined);
    // only an allow can last the session
    w.call(
        AgentWindowPort::agent_window_answer,
        vec![
            text(&id),
            text("req-2"),
            IpcValue::Bool(false),
            text("session"),
        ],
    );
    let log = w.program();
    assert!(log.contains(&"send do it".to_owned()), "{log:?}");
    assert!(
        log.contains(&"answer req-1 true session".to_owned()),
        "{log:?}"
    );
    assert!(log.contains(&"answer req-2 false -".to_owned()), "{log:?}");
    assert!(!log.iter().any(|line| line.contains("no-such-session")));
}

#[test]
fn stop_ends_the_session_and_its_servers() {
    let w = world("stop");
    w.svc.app_mcp.store(true, Ordering::SeqCst);
    let id = w.started_session();
    w.call(AgentWindowPort::agent_window_stop, vec![text(&id)]);
    let log = w.program();
    assert!(log.contains(&"stop".to_owned()), "{log:?}");
    assert!(log.contains(&"app-mcp stopped".to_owned()), "{log:?}");
    // a stopped session takes no more messages
    assert_eq!(
        w.call(
            AgentWindowPort::agent_window_send,
            vec![text(&id), text("again")]
        ),
        IpcValue::Bool(false)
    );
}

#[test]
fn stop_and_answer_land_while_a_start_waits_and_the_late_start_does_not_resurrect_the_session() {
    let w = world("stop-during-start");
    w.svc.app_mcp.store(true, Ordering::SeqCst);
    let gate = Arc::new(Gate::default());
    *w.svc.gate.lock().unwrap() = Some(gate.clone());
    w.accept_warning();
    w.open_window();
    let session = "00000000-0000-4000-8000-000000000001";
    let started = w.begin(
        WINDOW_VIEW,
        AgentWindowPort::agent_window_start,
        vec![ipc(&obj(vec![
            ("provider", string("claude-code")),
            ("mode", string("ask-commands")),
            ("folder", string(&w.project())),
        ]))],
    );
    // the program's start is under way on a worker, held at the gate: the core thread is free
    w.until(|| w.program().iter().any(|line| line.starts_with("run ")));
    assert!(started.try_recv().is_err());

    let stopped = w.call(AgentWindowPort::agent_window_stop, vec![text(session)]);
    assert_eq!(stopped, IpcValue::Undefined);
    let answered = w.call(
        AgentWindowPort::agent_window_answer,
        vec![text(session), text("req-1"), IpcValue::Bool(true)],
    );
    assert_eq!(answered, IpcValue::Undefined);
    // the stop took effect before the start's call was let go: its server is stopped, the
    // start has not answered, and the session takes no message
    assert!(
        w.program().contains(&"app-mcp stopped".to_owned()),
        "{:?}",
        w.program()
    );
    assert!(started.try_recv().is_err());
    assert_eq!(
        w.call(
            AgentWindowPort::agent_window_send,
            vec![text(session), text("too early")]
        ),
        IpcValue::Bool(false)
    );

    gate.release();
    let result = w.finish(&started).expect("not rejected");
    assert_eq!(field(&result, "ok"), Some(IpcValue::Bool(false)));
    assert_eq!(
        field(&field(&result, "failure").unwrap(), "reason"),
        Some(text("stopped"))
    );
    w.settle();
    // the program that came up late is stopped, never answered or sent to, and the window
    // is not told the session started
    let log = w.program();
    assert!(log.contains(&"stop".to_owned()), "{log:?}");
    assert!(
        !log.iter()
            .any(|line| line.starts_with("answer") || line.starts_with("send")),
        "{log:?}"
    );
    assert_eq!(
        w.call(
            AgentWindowPort::agent_window_send,
            vec![text(session), text("too late")]
        ),
        IpcValue::Bool(false)
    );
    assert!(
        !w.settings().contains("project"),
        "the folder is remembered only for a session that started"
    );
}

#[test]
fn a_session_ends_with_its_window() {
    let w = world("window-closed");
    let _ = w.started_session();
    w.port.inner.view_closed(ViewId(WINDOW_VIEW));
    w.settle();
    assert!(
        w.program().contains(&"stop".to_owned()),
        "{:?}",
        w.program()
    );
}

#[test]
fn open_file_opens_only_files_inside_the_project() {
    let w = world("open-file");
    let id = w.started_session();
    let inside = Path::new(&w.project()).join("notes.docx");
    std::fs::write(&inside, b"x").unwrap();
    let opened = w.call(
        AgentWindowPort::agent_window_open_file,
        vec![text(&id), text("notes.docx")],
    );
    assert_eq!(opened, IpcValue::Bool(true));
    assert_eq!(
        w.svc.opened.lock().unwrap().clone(),
        vec![inside.to_string_lossy().into_owned()]
    );
    for refused in ["../outside.docx", "missing.docx"] {
        assert_eq!(
            w.call(
                AgentWindowPort::agent_window_open_file,
                vec![text(&id), text(refused)]
            ),
            IpcValue::Bool(false)
        );
    }
    assert_eq!(w.svc.opened.lock().unwrap().len(), 1);
}

// ---- skill cards ------------------------------------------------------------------

#[test]
fn the_skill_tools_show_a_card_and_an_install_proposal_in_the_window() {
    let w = world("cards");
    w.svc.app_mcp.store(true, Ordering::SeqCst);
    let id = w.started_session();
    let hooks = w.svc.hooks.lock().unwrap()[0].clone();

    let (done, rx) = channel();
    hooks.propose_install(
        "https://example.com/skills/review".into(),
        Box::new(move |result| {
            let _ = done.send(result);
        }),
    );
    assert_eq!(w.finish(&rx), Ok(()));
    let proposals = w.events.on("agent-window:install-proposal");
    assert_eq!(proposals.len(), 1);
    assert_eq!(proposals[0].0, Target::View(ViewId(WINDOW_VIEW)));
    assert_eq!(field(&proposals[0].1, "sessionId"), Some(text(&id)));
    assert_eq!(
        field(&proposals[0].1, "address"),
        Some(text("https://example.com/skills/review"))
    );

    let (done, rx) = channel();
    hooks.propose_skill(
        AgentSkillProposalInput {
            title: "Review".into(),
            name: "review".into(),
            description: "Reviews a document".into(),
            body: "Read it and comment.".into(),
            wants_template: false,
            target_id: String::new(),
            suggested_template_path: String::new(),
        },
        Vec::<AgentOpenTab>::new(),
        Box::new(move |result| {
            let _ = done.send(result);
        }),
    );
    assert_eq!(w.finish(&rx), Ok(()));
    let cards = w.events.on("agent-window:skill-proposal");
    assert_eq!(cards.len(), 1);
    assert_eq!(field(&cards[0].1, "sessionId"), Some(text(&id)));
    assert_eq!(
        field(&field(&cards[0].1, "proposal").unwrap(), "name"),
        Some(text("review"))
    );
}

#[test]
fn a_skill_card_cannot_be_shown_once_the_window_is_gone() {
    let w = world("cards-closed");
    w.svc.app_mcp.store(true, Ordering::SeqCst);
    let _ = w.started_session();
    let hooks = w.svc.hooks.lock().unwrap()[0].clone();
    // the window's page is destroyed
    w.frame.views.0.lock().unwrap().remove(&WINDOW_VIEW);
    let (done, rx) = channel();
    hooks.propose_install(
        "x".into(),
        Box::new(move |result| {
            let _ = done.send(result);
        }),
    );
    let refused = w.finish(&rx).unwrap_err();
    assert!(refused.contains("closed"), "{refused}");
    assert!(w.events.on("agent-window:install-proposal").is_empty());
}

#[test]
fn template_buttons_of_a_card_the_window_was_not_shown_are_not_found() {
    let w = world("templates");
    w.open_window();
    let args = || vec![text("no-such-card"), text("no-such-candidate")];
    let invokes: [Invoke; 3] = [
        AgentWindowPort::agent_window_template_check,
        AgentWindowPort::agent_window_template_as_is,
        AgentWindowPort::agent_window_template_blank,
    ];
    for invoke in invokes {
        let answer = w.call(invoke, args());
        assert_eq!(field(&answer, "ok"), Some(IpcValue::Bool(false)));
        assert_eq!(field(&answer, "reason"), Some(text("not-found")));
    }
}

// ---- opening the window ---------------------------------------------------------------

#[test]
fn home_opens_the_window_and_nobody_else_does() {
    let w = world("home-open");
    w.port.inner.open_from_home(ViewId(STRANGER_VIEW));
    w.settle();
    assert!(w.frame.created.lock().unwrap().is_empty());

    w.port.inner.open_from_home(ViewId(HOME_VIEW));
    w.settle();
    let created = w.frame.created.lock().unwrap().clone();
    assert_eq!(created.len(), 1);
    assert_eq!(created[0].0["width"], 560);
    assert!(
        created[0].0["title"]
            .as_str()
            .unwrap()
            .starts_with("Agent ko - "),
        "{}",
        created[0].0["title"]
    );
    assert_eq!(
        created[0].0["webPreferences"]["preload"],
        "/app/preload/agent.js"
    );
    assert_eq!(created[0].1["file"], "/app/renderer/agent.html");
}

#[test]
fn an_open_window_is_brought_forward_not_made_again() {
    let w = world("reopen");
    w.open_window();
    w.frame.minimized.store(true, Ordering::SeqCst);
    w.port.inner.open_window();
    w.settle();
    assert!(w.frame.created.lock().unwrap().is_empty());
    assert_eq!(
        w.frame.log.lock().unwrap().clone(),
        vec!["reveal true".to_owned()]
    );
    w.frame.minimized.store(false, Ordering::SeqCst);
    w.port.inner.open_window();
    w.settle();
    assert_eq!(
        w.frame.log.lock().unwrap().clone(),
        vec!["reveal true".to_owned(), "reveal false".to_owned()]
    );
}

#[test]
fn quitting_stops_every_session() {
    let w = world("quit");
    let _ = w.started_session();
    w.port.inner.stop_all();
    w.settle();
    assert!(
        w.program().contains(&"stop".to_owned()),
        "{:?}",
        w.program()
    );
}
