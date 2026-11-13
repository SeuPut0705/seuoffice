//! The generate port over fake hosts: what each channel answers, the events
//! and host calls it causes, and the steps that wait (the editor's save, the
//! recheck timer, the file picker) answering only when their answer arrives.

use std::collections::VecDeque;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use jscompat::JsonValue;
use main_core::packages::electron_utils::generate_handoff::{GenerateHandoff, HandoffStore};
use main_core::packages::i18n::Lang;
use main_core::shell::app_routing::DocumentTabKind;
use main_core::shell::document_links_shell::GenerateWindowRequest;
use main_core::shell::generate::convert::{ConvertedDocument, OpOutcome, XmindTopic};
use main_core::shell::generate::generate_window::{
    GenerateText, GenerateWindowOptions, NewDocumentOpener,
};
use main_core::shell::generate::materials::ParsedFile;
use main_core::shell::generate::open_materials::{OpenDocumentTab, SaveAnswer, SaveNeed};
use main_core::shell::title_bar_overlay::TitleBarOverlay;
use shell_contract::hosts::{
    Dialogs, FileDialog, Hosts, MainWindow, MessageBox, MessageBoxAnswer, OsShell,
};
use shell_contract::ipc::{CallContext, EventSink, Reply, Responder, Sender, Target};
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Services, Thread, Views, Workers};
use shell_contract::{IpcValue, Surface, ViewId, WindowId};

use super::GenerateWindowPort;
use super::host::{GenerateShell, TabContents};
use crate::ports::GenerateWindow as Channels;

type Job = Box<dyn FnOnce() + Send>;

/// the core thread: jobs wait until the test runs them
#[derive(Default)]
struct Core(Mutex<VecDeque<Job>>);

impl Core {
    fn run(&self) {
        loop {
            let job = self.0.lock().unwrap().pop_front();
            match job {
                Some(job) => job(),
                None => break,
            }
        }
    }
}

impl Thread for Core {
    fn post(&self, job: Job) {
        self.0.lock().unwrap().push_back(job);
    }
    fn is_current(&self) -> bool {
        false
    }
}

/// threads that run a job where it is posted (the UI thread, the workers)
struct Inline;

impl Thread for Inline {
    fn post(&self, job: Job) {
        job()
    }
    fn is_current(&self) -> bool {
        false
    }
}

impl Workers for Inline {
    fn spawn(&self, job: Job) {
        job()
    }
}

impl Views for Inline {
    fn sender_of(&self, _: ViewId) -> Option<Sender> {
        None
    }
    fn all(&self) -> Vec<Sender> {
        Vec::new()
    }
    fn on_destroyed(&self, _: Box<dyn Fn(ViewId) + Send + Sync>) {}
}

struct Dir(PathBuf);

impl AppPaths for Dir {
    fn path(&self, _: PathName) -> PathBuf {
        self.0.clone()
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
    /// the states pushed to a view, oldest first
    fn states(&self, view: u32) -> Vec<IpcValue> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .filter(|(t, c, _)| *t == Target::View(ViewId(view)) && *c == "generate:state")
            .map(|(_, _, args)| args[0].clone())
            .collect()
    }
}

#[derive(Default)]
struct FakeDialogs {
    /// the answers of `showOpenDialog`, in order; cancelled when they run out
    opens: Mutex<VecDeque<Vec<PathBuf>>>,
    asked: Mutex<Vec<(Option<WindowId>, FileDialog)>>,
}

impl Dialogs for FakeDialogs {
    fn open(&self, parent: Option<WindowId>, options: &FileDialog) -> Option<Vec<PathBuf>> {
        self.asked.lock().unwrap().push((parent, options.clone()));
        self.opens.lock().unwrap().pop_front()
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

#[derive(Default)]
struct FakeOs(Mutex<Vec<String>>);

impl OsShell for FakeOs {
    fn open_external(&self, url: &str) -> Result<(), String> {
        self.0.lock().unwrap().push(url.to_owned());
        Ok(())
    }
    fn open_path(&self, _: &std::path::Path) -> String {
        String::new()
    }
    fn show_item_in_folder(&self, _: &std::path::Path) {}
    fn trash_item(&self, _: &std::path::Path) -> Result<(), String> {
        Ok(())
    }
}

struct Main;

impl MainWindow for Main {
    fn view(&self) -> Option<ViewId> {
        Some(ViewId(1))
    }
    fn window(&self) -> Option<WindowId> {
        Some(WindowId(1))
    }
}

/// the window the generate window opens as, and its page
const GEN_WINDOW: WindowId = WindowId(7);
const GEN_VIEW: u32 = 70;

/// A callback receiving the user's answer to a save prompt
type SaveReply = Box<dyn FnOnce(SaveAnswer) + Send>;

#[derive(Default)]
struct World {
    log: Vec<String>,
    tabs: Vec<OpenDocumentTab>,
    contents: Vec<(String, TabContents)>,
    saves_for: Vec<DocumentTabKind>,
    starred: Vec<(String, Vec<String>)>,
    open_target: Option<String>,
    window_open: bool,
    events: Option<super::GenerateWindowEvents>,
    saves: Vec<(SaveNeed, SaveReply)>,
    timers: Vec<(f64, Job)>,
    handoffs: Vec<GenerateHandoff>,
}

#[derive(Default)]
struct FakeShell(Mutex<World>);

impl FakeShell {
    fn note(&self, line: impl Into<String>) {
        self.0.lock().unwrap().log.push(line.into());
    }

    fn log(&self) -> Vec<String> {
        self.0.lock().unwrap().log.clone()
    }
}

impl GenerateShell for FakeShell {
    fn create_window(
        &self,
        options: &GenerateWindowOptions,
        events: super::GenerateWindowEvents,
    ) -> WindowId {
        let mut w = self.0.lock().unwrap();
        w.window_open = true;
        w.events = Some(events);
        w.log.push(format!(
            "new BrowserWindow {} parent={:?}",
            options.title, options.parent
        ));
        GEN_WINDOW
    }
    fn window_view(&self, window: WindowId) -> Option<ViewId> {
        (window == GEN_WINDOW).then_some(ViewId(GEN_VIEW))
    }
    fn window_is_destroyed(&self, window: WindowId) -> bool {
        window == GEN_WINDOW && !self.0.lock().unwrap().window_open
    }
    fn window_is_minimized(&self, _: WindowId) -> bool {
        false
    }
    fn window_restore(&self, _: WindowId) {
        self.note("restore");
    }
    fn window_show(&self, _: WindowId) {
        self.note("show");
    }
    fn window_focus(&self, _: WindowId) {
        self.note("focus");
    }
    fn window_close(&self, window: WindowId) {
        let events = {
            let mut w = self.0.lock().unwrap();
            w.window_open = false;
            w.log.push("close".to_owned());
            w.events.clone()
        };
        if let Some(events) = events {
            events.closed(window);
        }
    }
    fn window_remove_menu(&self, _: WindowId) {}
    fn window_set_title_bar_overlay(&self, _: WindowId, o: &TitleBarOverlay) -> Result<(), String> {
        self.note(format!("overlay {}", o.color));
        Ok(())
    }
    fn watch_theme(&self, _: WindowId) {
        self.note("watch");
    }
    fn unwatch_theme(&self, _: WindowId) {
        self.note("unwatch");
    }
    fn renderer_url(&self) -> Option<String> {
        None
    }
    fn window_load_url(&self, _: WindowId, url: &str) {
        self.note(format!("loadURL {url}"));
    }
    fn window_load_generate_page(&self, _: WindowId) {
        self.note("loadFile");
    }
    fn should_use_dark_colors(&self) -> bool {
        false
    }
    fn lang(&self) -> Lang {
        Lang::En
    }
    fn theme(&self) -> String {
        "dark".to_owned()
    }
    fn generate_text(&self, _: Lang, key: GenerateText) -> String {
        format!("{key:?}")
    }
    fn starred_group_paths(&self, group: &str) -> Vec<String> {
        let w = self.0.lock().unwrap();
        w.starred
            .iter()
            .find(|(g, _)| g == group)
            .map(|(_, paths)| paths.clone())
            .unwrap_or_default()
    }
    fn tab_id_for(&self, web_contents_id: f64) -> Option<String> {
        Some(format!("tab-of-{web_contents_id}"))
    }
    fn open_target_tab(
        &self,
        handoff: &GenerateHandoff,
        opener: Option<&NewDocumentOpener>,
    ) -> Result<(), String> {
        let mut w = self.0.lock().unwrap();
        w.handoffs.push(handoff.clone());
        w.log.push(format!("openTargetTab {opener:?}"));
        match &w.open_target {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
    fn can_open_converted(&self) -> bool {
        false
    }
    fn open_converted_tab(
        &self,
        _: &ConvertedDocument,
        _: Option<&NewDocumentOpener>,
    ) -> Result<(), String> {
        Err("no conversions here".to_owned())
    }
    fn open_documents(&self, then: Box<dyn FnOnce(Vec<OpenDocumentTab>) + Send>) {
        let tabs = self.0.lock().unwrap().tabs.clone();
        then(tabs)
    }
    fn tab_contents(&self, tab_id: &str) -> Option<TabContents> {
        let w = self.0.lock().unwrap();
        w.contents.iter().find(|(id, _)| id == tab_id).map(|c| c.1)
    }
    fn reveal_tab(&self, tab_id: &str) {
        self.note(format!("reveal {tab_id}"));
    }
    fn has_save(&self, kind: DocumentTabKind) -> bool {
        self.0.lock().unwrap().saves_for.contains(&kind)
    }
    fn save(&self, need: SaveNeed, then: Box<dyn FnOnce(SaveAnswer) + Send>) {
        self.0.lock().unwrap().saves.push((need, then));
    }
    fn set_timeout(&self, ms: f64, then: Job) {
        self.0.lock().unwrap().timers.push((ms, then));
    }
    fn new_id(&self) -> String {
        "ID".to_owned()
    }
    fn now_ms(&self) -> f64 {
        1000.0
    }
    fn parse_file_to_text(&self, path: &str) -> Result<ParsedFile, String> {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        Ok(ParsedFile {
            ok: true,
            error: None,
            kind: Some("text".to_owned()),
            text: Some(text),
        })
    }
    fn not_topic_marks(&self) -> [String; 2] {
        ["(boundary)".to_owned(), "(relationship)".to_owned()]
    }
    fn first_sheet_root(&self, _: &str, _: &str) -> Result<XmindTopic, String> {
        Err("no engine".to_owned())
    }
    fn create_xmind_document_from_outline(&self, _: &str, _: &str) -> Result<(), String> {
        Err("no engine".to_owned())
    }
    fn open_blank_deck(&self) -> Result<u64, String> {
        Err("no engine".to_owned())
    }
    fn apply_deck_op(&self, _: u64, _: &JsonValue) -> Result<OpOutcome, String> {
        Err("no engine".to_owned())
    }
    fn save_deck(&self, _: u64) -> Result<Vec<u8>, String> {
        Err("no engine".to_owned())
    }
}

struct Rig {
    core: Arc<Core>,
    events: Arc<Events>,
    shell: Arc<FakeShell>,
    dialogs: Arc<FakeDialogs>,
    os: Arc<FakeOs>,
    port: GenerateWindowPort,
    dir: PathBuf,
}

fn rig(name: &str) -> Rig {
    let dir = std::env::temp_dir().join(format!("generate-port-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let core = Arc::new(Core::default());
    let events = Arc::new(Events::default());
    let shell = Arc::new(FakeShell::default());
    let dialogs = Arc::new(FakeDialogs::default());
    let os = Arc::new(FakeOs::default());
    let inline = Arc::new(Inline);
    let services = Services {
        ui: inline.clone(),
        core: core.clone(),
        workers: inline.clone(),
        events: events.clone(),
        views: inline,
        paths: Arc::new(Dir(dir.clone())),
        hosts: Arc::new(Hosts::default()),
    };
    let port = GenerateWindowPort::new(
        &services,
        shell.clone(),
        dialogs.clone(),
        os.clone(),
        Arc::new(Main),
        Rc::new(std::cell::RefCell::new(HandoffStore::new(false))),
    );
    Rig {
        core,
        events,
        shell,
        dialogs,
        os,
        port,
        dir,
    }
}

type Slot = Arc<Mutex<Option<Reply>>>;

impl Rig {
    /// a text file in the case's folder
    fn file(&self, name: &str, text: &str) -> String {
        let path = self.dir.join(name);
        fs::write(&path, text).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn call(
        &self,
        view: u32,
        f: impl FnOnce(&GenerateWindowPort, &CallContext, Responder),
    ) -> Slot {
        let slot: Slot = Arc::default();
        let out = slot.clone();
        let cx = CallContext {
            sender: Sender {
                view: ViewId(view),
                window: WindowId(view),
                surface: Surface::Shell,
            },
            request: None,
            cancel: CancelToken::default(),
        };
        f(
            &self.port,
            &cx,
            Responder::new(move |r| *out.lock().unwrap() = Some(r)),
        );
        self.core.run();
        slot
    }

    /// Home asks for the window with these files
    fn open(&self, paths: &[&str]) {
        let list = IpcValue::Array(paths.iter().map(|p| s(p)).collect());
        let slot = self.call(1, |p, cx, re| {
            p.generate_open_with_paths(cx, vec![list], re)
        });
        assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    }

    fn state(&self) -> IpcValue {
        answer(&self.call(GEN_VIEW, |p, cx, re| p.generate_get_state(cx, vec![], re))).unwrap()
    }
}

fn s(text: &str) -> IpcValue {
    IpcValue::String(text.to_owned())
}

fn answer(slot: &Slot) -> Reply {
    slot.lock().unwrap().clone().expect("answered")
}

fn field(value: &IpcValue, key: &str) -> IpcValue {
    match value {
        IpcValue::Object(entries) => entries
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .unwrap_or_else(|| panic!("no {key} in {value:?}")),
        other => panic!("{other:?} is not an object"),
    }
}

fn items(value: IpcValue) -> Vec<IpcValue> {
    match value {
        IpcValue::Array(items) => items,
        other => panic!("{other:?} is not a list"),
    }
}

fn tab(id: &str, kind: DocumentTabKind, path: Option<&str>, dirty: bool) -> OpenDocumentTab {
    OpenDocumentTab {
        id: id.to_owned(),
        kind,
        title: id.to_owned(),
        file_path: path.map(str::to_owned),
        active: false,
        dirty,
    }
}

// ---- the way in: Home, and the window's own page ----

#[test]
fn home_opens_the_window_over_the_shell_window_and_the_page_gets_its_state() {
    let r = rig("open");
    let a = r.file("a.txt", "hello");
    r.open(&[&a]);

    let log = r.shell.log();
    assert!(
        log[0].starts_with("new BrowserWindow ") && log[0].ends_with("parent=Some(1)"),
        "{log:?}"
    );
    assert!(log.contains(&"loadFile".to_owned()));
    // the state is pushed to the window's page, ending with the rows read
    let states = r.events.states(GEN_VIEW);
    let last = states.last().expect("a state was pushed");
    assert_eq!(field(last, "readyCount"), IpcValue::Number(1.0));
    assert_eq!(field(last, "canMake"), IpcValue::Bool(true));
    assert_eq!(field(last, "checking"), IpcValue::Bool(false));
    let rows = items(field(last, "materials"));
    assert_eq!(field(&rows[0], "state"), s("ready"));
    assert_eq!(field(&rows[0], "name"), s("a.txt"));
}

#[test]
fn only_the_shell_windows_own_page_may_open_it() {
    let r = rig("home-only");
    let a = r.file("a.txt", "hello");
    let list = IpcValue::Array(vec![s(&a)]);
    let slot = r.call(9, |p, cx, re| {
        p.generate_open_with_paths(cx, vec![list], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert!(r.shell.log().is_empty());
    // a page that is not a string list opens an empty window
    let slot = r.call(1, |p, cx, re| {
        p.generate_open_with_paths(cx, vec![s("x")], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert_eq!(field(&r.state(), "materials"), IpcValue::Array(Vec::new()));
}

#[test]
fn a_starred_group_opens_with_its_files_and_a_second_open_starts_over() {
    let r = rig("group");
    let a = r.file("a.txt", "one");
    let b = r.file("b.txt", "two");
    r.shell
        .0
        .lock()
        .unwrap()
        .starred
        .push(("g1".to_owned(), vec![a.clone(), b.clone()]));
    let slot = r.call(1, |p, cx, re| {
        p.generate_open_with_group(cx, vec![s("g1")], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert_eq!(items(field(&r.state(), "materials")).len(), 2);

    // an empty group name does nothing
    let before = r.shell.log().len();
    let slot = r.call(1, |p, cx, re| {
        p.generate_open_with_group(cx, vec![s("")], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert_eq!(r.shell.log().len(), before);

    // opened again: the same window starts over with the new files
    r.open(&[&b]);
    let log = r.shell.log();
    assert_eq!(
        log.iter()
            .filter(|l| l.starts_with("new BrowserWindow"))
            .count(),
        1
    );
    assert!(
        log.ends_with(&["show".to_owned(), "focus".to_owned()]),
        "{log:?}"
    );
    assert_eq!(items(field(&r.state(), "materials")).len(), 1);
}

#[test]
fn the_pages_questions_are_answered_only_for_the_window_itself() {
    let r = rig("sender");
    let a = r.file("a.txt", "hello");
    r.open(&[&a]);
    let theme = |view| answer(&r.call(view, |p, cx, re| p.generate_get_theme(cx, vec![], re)));
    assert_eq!(theme(GEN_VIEW), Ok(s("dark")));
    assert_eq!(theme(1), Ok(s("system")));
    let state = |view| answer(&r.call(view, |p, cx, re| p.generate_get_state(cx, vec![], re)));
    assert_eq!(state(1), Ok(IpcValue::Null));
    assert_ne!(state(GEN_VIEW), Ok(IpcValue::Null));
    // an outsider changes nothing
    let pushed = r.events.states(GEN_VIEW).len();
    let slot = r.call(1, |p, cx, re| p.generate_set_kind(cx, vec![s("html")], re));
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert_eq!(r.events.states(GEN_VIEW).len(), pushed);
}

// ---- the window's own channels ----

#[test]
fn kind_and_removal_change_the_state_and_push_it() {
    let r = rig("kind");
    let a = r.file("a.txt", "hello");
    let b = r.file("b.txt", "world");
    r.open(&[&a, &b]);
    assert_eq!(field(&r.state(), "kind"), s("slides"));

    let slot = r.call(GEN_VIEW, |p, cx, re| {
        p.generate_set_kind(cx, vec![s("html")], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert_eq!(field(&r.state(), "kind"), s("html"));
    assert_eq!(
        field(r.events.states(GEN_VIEW).last().unwrap(), "kind"),
        s("html")
    );

    // a kind that is not one is ignored
    let pushed = r.events.states(GEN_VIEW).len();
    r.call(GEN_VIEW, |p, cx, re| {
        p.generate_set_kind(cx, vec![s("nope")], re)
    });
    assert_eq!(r.events.states(GEN_VIEW).len(), pushed);

    let key = field(&items(field(&r.state(), "materials"))[0], "key");
    r.call(GEN_VIEW, |p, cx, re| {
        p.generate_remove_material(cx, vec![key], re)
    });
    assert_eq!(items(field(&r.state(), "materials")).len(), 1);

    // no conversions are offered while the shell cannot open their result
    r.call(GEN_VIEW, |p, cx, re| {
        p.generate_set_convert(cx, vec![s("mindmap-to-markdown")], re)
    });
    assert_eq!(field(&r.state(), "mode"), s("ai"));
}

#[test]
fn make_hands_the_request_to_a_new_tab_and_closes_the_window() {
    let r = rig("make");
    let a = r.file("a.txt", "hello");
    r.open(&[&a]);
    let slot = r.call(GEN_VIEW, |p, cx, re| {
        p.generate_make(cx, vec![s("  a deck  ")], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Bool(true)));

    let handoffs = r.shell.0.lock().unwrap().handoffs.clone();
    assert_eq!(handoffs.len(), 1);
    assert_eq!(handoffs[0].text, "a deck");
    assert!(!handoffs[0].default_text);
    assert_eq!(handoffs[0].materials[0].path, a);
    assert_eq!(handoffs[0].id, "ID");
    assert_eq!(handoffs[0].created_at, 1000.0);
    let log = r.shell.log();
    assert!(
        log.contains(&"openTargetTab Some(Home)".to_owned()),
        "{log:?}"
    );
    // the window closed, and its page is no longer answered
    assert!(log.contains(&"close".to_owned()));
    assert!(log.contains(&"unwatch".to_owned()));
    assert_eq!(
        answer(&r.call(GEN_VIEW, |p, cx, re| p.generate_get_state(cx, vec![], re))),
        Ok(IpcValue::Null)
    );
}

#[test]
fn make_with_nothing_readable_does_not_open_a_tab_and_a_tab_that_fails_is_an_error() {
    let r = rig("make-fail");
    r.open(&[]);
    let slot = r.call(GEN_VIEW, |p, cx, re| p.generate_make(cx, vec![s("x")], re));
    assert_eq!(answer(&slot), Ok(IpcValue::Bool(false)));
    assert!(r.shell.0.lock().unwrap().handoffs.is_empty());
    // a request that is not text is refused
    let slot = r.call(GEN_VIEW, |p, cx, re| {
        p.generate_make(cx, vec![IpcValue::Number(3.0)], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Bool(false)));
    // from another sender: no
    let slot = r.call(1, |p, cx, re| p.generate_make(cx, vec![s("x")], re));
    assert_eq!(answer(&slot), Ok(IpcValue::Bool(false)));

    let a = r.file("a.txt", "hello");
    r.call(GEN_VIEW, |p, cx, re| p.generate_cancel(cx, vec![], re));
    r.open(&[&a]);
    r.shell.0.lock().unwrap().open_target = Some("no tab could open".to_owned());
    let slot = r.call(GEN_VIEW, |p, cx, re| p.generate_make(cx, vec![s("x")], re));
    assert_eq!(answer(&slot), Ok(IpcValue::Bool(false)));
    assert_eq!(field(&r.state(), "failure"), s("make"));
}

#[test]
fn cancel_closes_the_window_and_the_closed_event_forgets_it() {
    let r = rig("cancel");
    let a = r.file("a.txt", "hello");
    r.open(&[&a]);
    let slot = r.call(GEN_VIEW, |p, cx, re| p.generate_cancel(cx, vec![], re));
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert!(r.shell.log().contains(&"close".to_owned()));
    // opening again makes a window of its own
    r.open(&[&a]);
    let made = r
        .shell
        .log()
        .iter()
        .filter(|l| l.starts_with("new BrowserWindow"))
        .count();
    assert_eq!(made, 2);
}

#[test]
fn the_picker_runs_off_the_core_thread_and_its_files_join_the_list() {
    let r = rig("picker");
    let a = r.file("a.txt", "hello");
    let b = r.file("b.txt", "world");
    r.open(&[&a]);
    r.dialogs
        .opens
        .lock()
        .unwrap()
        .push_back(vec![PathBuf::from(&b)]);
    let slot = r.call(GEN_VIEW, |p, cx, re| {
        p.generate_add_materials(cx, vec![], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert_eq!(items(field(&r.state(), "materials")).len(), 2);
    let asked = r.dialogs.asked.lock().unwrap().clone();
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].0, Some(GEN_WINDOW));
    assert_eq!(asked[0].1.properties, vec!["openFile", "multiSelections"]);
    assert_eq!(asked[0].1.filters.len(), 1);
    assert!(
        asked[0].1.filters[0]
            .extensions
            .contains(&"docx".to_owned())
    );

    // the person cancels: nothing joins
    let slot = r.call(GEN_VIEW, |p, cx, re| {
        p.generate_add_materials(cx, vec![], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert_eq!(items(field(&r.state(), "materials")).len(), 2);

    // another sender never reaches the picker
    r.call(1, |p, cx, re| p.generate_add_materials(cx, vec![], re));
    assert_eq!(r.dialogs.asked.lock().unwrap().len(), 2);
}

// ---- steps that wait ----

fn setup_dirty_docx(r: &Rig) -> String {
    let path = r.file("deck.docx", "unreadable as text but present");
    let mut w = r.shell.0.lock().unwrap();
    w.tabs = vec![tab("t1", DocumentTabKind::Docs, Some(&path), true)];
    w.contents = vec![(
        "t1".to_owned(),
        TabContents {
            view: ViewId(40),
            destroyed: false,
        },
    )];
    w.saves_for = vec![DocumentTabKind::Docs];
    path
}

#[test]
fn save_waits_for_the_editor_then_reads_the_row_again() {
    let r = rig("save");
    let path = setup_dirty_docx(&r);
    r.open(&[&path]);
    let rows = items(field(&r.state(), "materials"));
    assert_eq!(field(&rows[0], "state"), s("unsaved"));
    assert_eq!(field(&rows[0], "saveAction"), s("save"));
    let key = field(&rows[0], "key");

    let slot = r.call(GEN_VIEW, |p, cx, re| {
        p.generate_save_material(cx, vec![key], re)
    });
    // the editor was asked and nothing has answered yet
    assert!(slot.lock().unwrap().is_none());
    let (need, then) = r
        .shell
        .0
        .lock()
        .unwrap()
        .saves
        .pop()
        .expect("a save command");
    assert_eq!(
        need,
        SaveNeed::ToPath {
            kind: DocumentTabKind::Docs,
            web_contents_id: 40.0,
            path: path.clone(),
        }
    );
    assert_eq!(
        field(r.events.states(GEN_VIEW).last().unwrap(), "saving"),
        IpcValue::Array(vec![s(&path)])
    );
    // other calls are answered while the save waits
    assert_eq!(field(&r.state(), "kind"), s("slides"));

    // the editor saved: its tab is clean, and the call answers
    r.shell.0.lock().unwrap().tabs[0].dirty = false;
    then(SaveAnswer::ToPath(Ok(())));
    r.core.run();
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    let state = r.state();
    assert_eq!(field(&state, "saving"), IpcValue::Array(Vec::new()));
    assert_eq!(
        field(&items(field(&state, "materials"))[0], "state"),
        IpcValue::String("ready".into())
    );
}

#[test]
fn a_save_that_fails_is_reported_in_the_state() {
    let r = rig("save-failed");
    let path = setup_dirty_docx(&r);
    r.open(&[&path]);
    let key = field(&items(field(&r.state(), "materials"))[0], "key");
    let slot = r.call(GEN_VIEW, |p, cx, re| {
        p.generate_save_material(cx, vec![key], re)
    });
    let (_, then) = r.shell.0.lock().unwrap().saves.pop().unwrap();
    then(SaveAnswer::ToPath(Err(
        main_core::shell::renderer_disposal::Failure("disk full".to_owned()),
    )));
    r.core.run();
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert_eq!(field(&r.state(), "failure"), s("save"));
}

#[test]
fn a_tab_shown_instead_of_saved_and_an_untitled_one_are_revealed() {
    let r = rig("show");
    // markdown has no save command here: its tab is brought forward
    let md = r.file("n.md", "# n");
    {
        let mut w = r.shell.0.lock().unwrap();
        w.tabs = vec![tab("m1", DocumentTabKind::Markdown, Some(&md), true)];
        w.contents = vec![(
            "m1".to_owned(),
            TabContents {
                view: ViewId(41),
                destroyed: false,
            },
        )];
    }
    r.open(&[&md]);
    let key = field(&items(field(&r.state(), "materials"))[0], "key");
    let slot = r.call(GEN_VIEW, |p, cx, re| {
        p.generate_save_material(cx, vec![key], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert!(r.shell.log().contains(&"reveal m1".to_owned()));

    // a key that names no row does nothing; a sender that is not the window neither
    let slot = r.call(GEN_VIEW, |p, cx, re| {
        p.generate_save_material(cx, vec![s("nope")], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    let slot = r.call(1, |p, cx, re| {
        p.generate_save_material(cx, vec![s("nope")], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
}

#[test]
fn refresh_reads_every_row_again() {
    let r = rig("refresh");
    let a = r.file("a.txt", "hello");
    r.open(&[&a]);
    assert_eq!(field(&r.state(), "readyCount"), IpcValue::Number(1.0));
    fs::remove_file(&a).unwrap();
    let slot = r.call(GEN_VIEW, |p, cx, re| p.generate_refresh(cx, vec![], re));
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    let state = r.state();
    assert_eq!(field(&state, "readyCount"), IpcValue::Number(0.0));
    assert_eq!(
        field(&items(field(&state, "materials"))[0], "problem"),
        s("missing")
    );
}

// ---- the window's listeners, the make window entry and the store ----

#[test]
fn focus_rereads_and_closed_unwatches_through_the_listeners() {
    let r = rig("listeners");
    let a = r.file("a.txt", "hello");
    r.open(&[&a]);
    let events = r.shell.0.lock().unwrap().events.clone().unwrap();
    fs::remove_file(&a).unwrap();
    events.focus(GEN_WINDOW);
    r.core.run();
    assert_eq!(field(&r.state(), "readyCount"), IpcValue::Number(0.0));

    events.theme_updated(GEN_WINDOW);
    r.core.run();
    // macOS draws the native frame itself: only the other platforms set the overlay
    let set = r.shell.log().iter().any(|l| l.starts_with("overlay "));
    assert_eq!(set, crate::secrets::PLATFORM != "darwin");

    events.open_link("https://example.com/a".to_owned());
    events.open_link("javascript:alert(1)".to_owned());
    r.core.run();
    assert_eq!(
        *r.os.0.lock().unwrap(),
        vec!["https://example.com/a".to_owned()]
    );

    events.closed(GEN_WINDOW);
    r.core.run();
    assert!(r.shell.log().contains(&"unwatch".to_owned()));
    assert_eq!(
        answer(&r.call(GEN_VIEW, |p, cx, re| p.generate_get_state(cx, vec![], re))),
        Ok(IpcValue::Null)
    );
}

#[test]
fn an_editors_menu_opens_the_window_with_its_document_and_the_new_tab_follows_it() {
    let r = rig("document");
    let open = r.port.make_window_opener();
    open(GenerateWindowRequest {
        web_contents_id: 40.0,
        file_path: None,
        title: "Draft".to_owned(),
        parent: Some(WindowId(3)),
    });
    r.core.run();
    let log = r.shell.log();
    assert!(log[0].ends_with("parent=Some(3)"), "{log:?}");
    let state = r.state();
    let rows = items(field(&state, "materials"));
    assert_eq!(field(&rows[0], "key"), s("untitled:40"));
    assert_eq!(field(&rows[0], "state"), s("excluded"));
    assert_eq!(field(&rows[0], "problem"), s("untitled"));

    // an untitled document is brought forward when the person asks to save it
    r.shell.0.lock().unwrap().tabs = vec![tab("t9", DocumentTabKind::Docs, None, true)];
    r.shell.0.lock().unwrap().contents = vec![(
        "t9".to_owned(),
        TabContents {
            view: ViewId(40),
            destroyed: false,
        },
    )];
    let slot = r.call(GEN_VIEW, |p, cx, re| {
        p.generate_save_material(cx, vec![s("untitled:40")], re)
    });
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    assert!(r.shell.log().contains(&"reveal t9".to_owned()));
}

#[test]
fn the_hand_off_store_names_tabs_through_the_shell() {
    let r = rig("store");
    let store = r.port.handoff_store();
    // the store is the port's one: the same store every time
    assert!(Rc::ptr_eq(&store, &r.port.handoff_store()));
    let a = r.file("a.txt", "hello");
    r.open(&[&a]);
    let slot = r.call(GEN_VIEW, |p, cx, re| p.generate_make(cx, vec![s("go")], re));
    assert_eq!(answer(&slot), Ok(IpcValue::Bool(true)));
    // the tab manager queues the hand-off for the tab it opened; its editor takes it once
    let handoff = r.shell.0.lock().unwrap().handoffs[0].clone();
    store
        .borrow_mut()
        .queue_generate_handoff(55.0, handoff.clone());
    assert_eq!(
        store
            .borrow_mut()
            .take_generate_handoff(handoff.target, 55.0),
        Some(handoff)
    );
}

use std::rc::Rc;

#[test]
fn a_tab_still_dirty_after_its_save_is_looked_at_again_when_the_timer_fires() {
    let r = rig("recheck");
    let path = setup_dirty_docx(&r);
    r.open(&[&path]);
    let key = field(&items(field(&r.state(), "materials"))[0], "key");
    let slot = r.call(GEN_VIEW, |p, cx, re| {
        p.generate_save_material(cx, vec![key], re)
    });
    let (_, then) = r
        .shell
        .0
        .lock()
        .unwrap()
        .saves
        .pop()
        .expect("a save command");
    // the editor answered, but its tab still reports the changes
    then(SaveAnswer::ToPath(Ok(())));
    r.core.run();
    assert!(slot.lock().unwrap().is_none());
    let (ms, timer) = r.shell.0.lock().unwrap().timers.pop().expect("a timer");
    assert_eq!(ms, 600.0);

    r.shell.0.lock().unwrap().tabs[0].dirty = false;
    timer();
    r.core.run();
    assert_eq!(answer(&slot), Ok(IpcValue::Undefined));
    let rows = items(field(&r.state(), "materials"));
    assert_eq!(field(&rows[0], "state"), s("ready"));
    assert_eq!(field(&r.state(), "saving"), IpcValue::Array(Vec::new()));
}

#[test]
fn the_factory_needs_its_hosts_and_provides_the_one_store() {
    use shell_contract::hosts::{DialogsHost, MainWindowHost, OsShellHost};
    use shell_contract::provided::Provided;

    use super::host::GenerateShellHost;

    let make = |hosts: Hosts| Services {
        ui: Arc::new(Inline),
        core: Arc::new(Core::default()),
        workers: Arc::new(Inline),
        events: Arc::new(Events::default()),
        views: Arc::new(Inline),
        paths: Arc::new(Dir(std::env::temp_dir())),
        hosts: Arc::new(hosts),
    };
    let provided = Rc::new(Provided::default());
    let factory = super::factory();
    // a shell built without the make window's host refuses to start
    assert!(
        (factory.0)(&make(Hosts::default()), &provided).is_err(),
        "the host is missing"
    );

    let mut hosts = Hosts::default();
    hosts.insert::<GenerateShellHost>(Arc::new(FakeShell::default()));
    hosts.insert::<DialogsHost>(Arc::new(FakeDialogs::default()));
    hosts.insert::<OsShellHost>(Arc::new(FakeOs::default()));
    hosts.insert::<MainWindowHost>(Arc::new(Main));
    assert!((factory.0)(&make(hosts), &provided).is_ok());
    // the store and the make window entry are for the other batches to find
    assert_eq!(
        provided
            .all::<std::cell::RefCell<main_core::packages::electron_utils::generate_handoff::HandoffStore>>()
            .len(),
        1
    );
    assert_eq!(provided.all::<GenerateWindowPort>().len(), 1);
}
