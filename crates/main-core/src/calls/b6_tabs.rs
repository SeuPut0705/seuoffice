//! The functions of group `b6-tabs` (tools/main-diff/groups/b6-tabs.ts):
//! `apps/shell/src/main/tab-manager.ts` and `detached-windows.ts` (batch B6
//! of decision 0030). A scenario plays the part of the Electron adapter: it
//! owns one `TabManager` and the `DetachedWindows` of one shell window and
//! carries out each operation on a `World` that implements the host traits.
//! Each call of a fake of the world is one `logs` line, written exactly as
//! the TypeScript fakes of the spec write it, so the logs, the results of the
//! operations and the final state of the tab manager are what the comparison
//! sees.

use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{Map, Value, json};

use super::{Answer, CallError, Context, arg};
use crate::packages::electron_utils::renderer_scheme::RendererUrlError;
use crate::shell::detached_windows::{
    DetachedCloseStep, DetachedHost, DetachedOpenDocumentsRun, DetachedWindowOptions,
    DetachedWindows, RecId, ShellWindowState, WindowOptions, dock_band_for,
};
use crate::shell::split_layout::{Pane, Rect, SplitDropIntent, SplitOrientation};
use crate::shell::tab_manager::{
    Deferred, DetachedTab, DiagramIdentity, EditorCalls, EnsureAfterReady, EnsureStep, HwpCopy,
    HwpUntitledCopy, LiveTab, LoadedTabView, OpenDocsOptions, OpenDocumentsRun, OpenDocumentsStep,
    Opener, Ready, RestoredSession, RestoredSplit, SplitViewState, TabCloseStep, TabHost, TabKind,
    TabLoadResult, TabManager, TabResult, TemplateCopy, UnloadedTabOpenContext, UnloadedTabSpec,
    ViewSpec, canonical_path, create_plain_editor_view, help_topic_param, help_view_url,
    help_window_open,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "tab-manager.canonicalPath" => {
            let path = arg(args, 0).and_then(Value::as_str);
            Ok(Some(canonical_path(path).map_or(Value::Null, Value::from)))
        }
        "tab-manager.helpTopicParam" => {
            let topic = arg(args, 0).and_then(Value::as_str);
            Ok(Some(
                help_topic_param(topic).map_or(Value::Null, Value::from),
            ))
        }
        "tab-manager.helpViewUrl" => {
            let dev_url = arg(args, 0).and_then(Value::as_str);
            let topic = arg(args, 1).and_then(Value::as_str);
            help_view_url(dev_url, topic)
                .map(|url| Some(Value::from(url)))
                .map_err(|RendererUrlError(message)| CallError::plain(message))
        }
        "tab-manager.open"
        | "tab-manager.layout"
        | "tab-manager.activate"
        | "tab-manager.split"
        | "tab-manager.unloaded"
        | "tab-manager.close"
        | "tab-manager.detach"
        | "tab-manager.lookup"
        | "detached-windows.registry"
        | "detached-windows.create"
        | "detached-windows.dock"
        | "detached-windows.close" => scenario_call(args, cx),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// the world
// ---------------------------------------------------------------------------

/// a `WebContentsView`, by its webContents id
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct View(i64);

/// a `BrowserWindow`, by its number (1, 2, ...)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Win(usize);

#[derive(Default)]
struct WcState {
    dirty: bool,
    pending: f64,
    memo: bool,
    destroyed: bool,
    /// `docsQueryDirty` rejects
    query_fails: bool,
    identity: Option<DiagramIdentity>,
}

struct ShellState {
    destroyed: bool,
    minimized: bool,
    focused: bool,
    width: f64,
    height: f64,
}

struct WinState {
    destroyed: bool,
    minimized: bool,
    focused: bool,
    title: String,
    bounds: Rect,
    position: (f64, f64),
}

#[derive(Clone, Copy)]
enum Immediate {
    Tab(Deferred),
    Win(RecId),
}

#[derive(Clone, Copy)]
enum TimerKind {
    Spare,
    Dock(RecId),
}

enum CloseAnswer {
    Answer(bool),
    Throws,
}

/// Where the value of an operation that may wait for an answer goes when it
/// is done: the operation's own result, a slot `join` reads (`bg`), or
/// nowhere (a promise nobody reads).
#[derive(Clone, Copy, PartialEq)]
enum Sink {
    Op,
    Bg(usize),
    Discard,
}

/// A run suspended on an answer the world holds back (`hold`, `release`).
enum Held {
    TabClose {
        id: String,
        sink: Sink,
    },
    OpenDocs {
        run: OpenDocumentsRun<View>,
        sink: Sink,
    },
    DetachedClose {
        rec: RecId,
    },
    DetachedOpenDocs {
        run: DetachedOpenDocumentsRun,
        sink: Sink,
    },
}

#[derive(Clone, PartialEq)]
enum ReadyState {
    Pending,
    Resolved,
    Rejected(String),
}

#[derive(Clone)]
struct OpenerSpec {
    plain: bool,
    fails: bool,
    needs_user: Option<bool>,
    /// `none`, `resolved`, `rejected` or `pending`
    ready: String,
}

/// the readies of a page load are numbered above every opener
const PAGE_READY_BASE: u64 = 10_000;

struct World {
    logs: Vec<Vec<Value>>,
    shell: ShellState,
    scale: f64,
    untitled: Option<Map<String, Value>>,
    split_listener: bool,
    closed_listener: bool,
    no_spare: bool,
    dev_url: Option<String>,
    next_wc: i64,
    next_timer: u64,
    next_opener: u64,
    wcs: HashMap<i64, WcState>,
    /// `(webContents id, event, once)`
    listeners: Vec<(i64, String, bool)>,
    window_open: Vec<i64>,
    windows: Vec<WinState>,
    win_rec: Vec<Option<RecId>>,
    timers: Vec<(u64, TimerKind)>,
    spare_timer: Option<u64>,
    dock_timers: HashMap<usize, u64>,
    immediates: Vec<Immediate>,
    closed_queue: Vec<usize>,
    failures: Vec<String>,
    close_answers: VecDeque<CloseAnswer>,
    readies: HashMap<u64, ReadyState>,
    reported: HashSet<u64>,
    openers: HashMap<u64, OpenerSpec>,
    cursor: (f64, f64),
    work_area: Rect,
    band: Option<Rect>,
    dock_on: bool,
    dock_attach: bool,
    dock_index: Option<f64>,
    pending_docks: Vec<DetachedTab<View>>,
    held: Vec<Option<DetachedTab<View>>>,
    /// `holding`: a `docsQueryDirty` or a close prompt waits for `release`
    hold: bool,
    held_steps: VecDeque<Held>,
    /// the results `join` reads, by `bg` slot
    bgs: Vec<Option<Value>>,
    /// `ensureTabLoaded` runs waiting on a `ready` that has not settled
    ensure_waits: Vec<(u64, EnsureAfterReady<View>, Sink)>,
}

fn rect_json(r: &Rect) -> Value {
    json!({ "x": r.x, "y": r.y, "width": r.width, "height": r.height })
}

fn opt_str(text: Option<&str>) -> Value {
    text.map_or(Value::Null, Value::from)
}

fn rect_of(value: &Value) -> Rect {
    let f = |key: &str| value.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    Rect {
        x: f("x"),
        y: f("y"),
        width: f("width"),
        height: f("height"),
    }
}

impl World {
    fn new(spec: &Value) -> World {
        let shell = spec.get("shell");
        let num = |key: &str, default: f64| {
            shell
                .and_then(|s| s.get(key))
                .and_then(Value::as_f64)
                .unwrap_or(default)
        };
        World {
            logs: Vec::new(),
            shell: ShellState {
                destroyed: false,
                minimized: false,
                focused: shell
                    .and_then(|s| s.get("focused"))
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
                width: num("width", 1200.0),
                height: num("height", 800.0),
            },
            scale: num("scale", 1.0),
            untitled: spec.get("untitled").and_then(Value::as_object).cloned(),
            split_listener: spec.get("splitListener").and_then(Value::as_bool) != Some(false),
            closed_listener: spec.get("closedListener").and_then(Value::as_bool) != Some(false),
            no_spare: spec.get("noSpare").and_then(Value::as_bool) == Some(true),
            dev_url: spec
                .get("devUrl")
                .and_then(Value::as_str)
                .map(str::to_owned),
            next_wc: 100,
            next_timer: 1,
            next_opener: 1,
            wcs: HashMap::new(),
            listeners: Vec::new(),
            window_open: Vec::new(),
            windows: Vec::new(),
            win_rec: Vec::new(),
            timers: Vec::new(),
            spare_timer: None,
            dock_timers: HashMap::new(),
            immediates: Vec::new(),
            closed_queue: Vec::new(),
            failures: Vec::new(),
            close_answers: VecDeque::new(),
            readies: HashMap::new(),
            reported: HashSet::new(),
            openers: HashMap::new(),
            cursor: (0.0, 0.0),
            work_area: Rect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            band: None,
            dock_on: false,
            dock_attach: true,
            dock_index: None,
            pending_docks: Vec::new(),
            held: Vec::new(),
            hold: false,
            held_steps: VecDeque::new(),
            bgs: Vec::new(),
            ensure_waits: Vec::new(),
        }
    }

    fn log(&mut self, line: Vec<Value>) {
        self.logs.push(line);
    }

    fn state(&mut self, wc: i64) -> &mut WcState {
        self.wcs.entry(wc).or_default()
    }

    fn make_view(&mut self) -> View {
        let id = self.next_wc;
        self.next_wc += 1;
        View(id)
    }

    /// a listener `on` or `once` registered for the view
    fn listen(&mut self, wc: i64, event: &str, once: bool) {
        self.listeners.push((wc, event.to_owned(), once));
    }

    /// emit `event` on the view: true when a listener was there (the `once`
    /// ones leave)
    fn fire(&mut self, wc: i64, event: &str) -> bool {
        let found = self
            .listeners
            .iter()
            .any(|(w, e, _)| *w == wc && e == event);
        self.listeners
            .retain(|(w, e, once)| !(*w == wc && e == event && *once));
        found
    }

    fn settle_ready(&mut self, token: u64, state: ReadyState) {
        if self.readies.get(&token) == Some(&ReadyState::Pending) {
            self.readies.insert(token, state);
        }
    }

    /// the answer of a `docsQueryDirty` that is not held
    fn query_answer(&mut self, wc: i64) -> Result<bool, String> {
        let state = self.state(wc);
        if state.query_fails {
            Err("query failed".to_owned())
        } else {
            Ok(state.dirty)
        }
    }

    /// the answer of a close prompt that is not held
    fn prompt_answer(&mut self) -> Result<bool, String> {
        match self
            .close_answers
            .pop_front()
            .unwrap_or(CloseAnswer::Answer(true))
        {
            CloseAnswer::Answer(answer) => Ok(answer),
            CloseAnswer::Throws => Err("prompt failed".to_owned()),
        }
    }

    /// the value of an operation that is done goes to its sink; what the
    /// operation answers is returned
    fn settle(&mut self, sink: Sink, value: Value) -> Value {
        match sink {
            Sink::Op => value,
            Sink::Bg(slot) => {
                self.bgs[slot] = Some(value);
                Value::Null
            }
            Sink::Discard => Value::Null,
        }
    }

    fn start_timer(&mut self, kind: TimerKind, delay_ms: f64) -> u64 {
        let n = self.next_timer;
        self.next_timer += 1;
        self.timers.push((n, kind));
        self.log(vec![
            Value::from("setTimeout"),
            Value::from(delay_ms),
            Value::from(n),
        ]);
        n
    }

    fn stop_timer(&mut self, n: u64) {
        self.log(vec![Value::from("clearTimeout"), Value::from(n)]);
        self.timers.retain(|(t, _)| *t != n);
    }

    fn new_opener(&mut self, spec: &Value) -> Opener {
        let n = self.next_opener;
        self.next_opener += 1;
        self.openers.insert(
            n,
            OpenerSpec {
                plain: spec.get("kind").and_then(Value::as_str) == Some("plain"),
                fails: spec.get("fails").and_then(Value::as_bool) == Some(true),
                needs_user: spec.get("needsUser").and_then(Value::as_bool),
                ready: spec
                    .get("ready")
                    .and_then(Value::as_str)
                    .unwrap_or("none")
                    .to_owned(),
            },
        );
        Opener {
            id: n,
            has_needs_user: spec.get("needsUser").is_some(),
        }
    }

    fn win_state(&mut self, win: &Win) -> &mut WinState {
        &mut self.windows[win.0 - 1]
    }

    /// what the adapter does when an operation returned: the docks the
    /// detached windows asked for, the promises that settled, the `closed`
    /// events of the windows destroyed
    fn after_op(&mut self, tm: &mut TabManager<View>, dw: &mut DetachedWindows<View, Win>) {
        let docks = std::mem::take(&mut self.pending_docks);
        let index = self.dock_index;
        for tab in docks {
            tm.attach_tab(self, tab, index, true);
        }
        let mut settled: Vec<u64> = self
            .readies
            .iter()
            .filter(|(token, state)| {
                **state != ReadyState::Pending && !self.reported.contains(*token)
            })
            .map(|(token, _)| *token)
            .collect();
        settled.sort_unstable();
        for token in settled {
            self.reported.insert(token);
            tm.ready_settled(Ready(token));
        }
        // the `ensureTabLoaded` runs that waited on a ready that settled go on
        let waits = std::mem::take(&mut self.ensure_waits);
        for (token, next, sink) in waits {
            let answer = match self.readies.get(&token) {
                Some(ReadyState::Resolved) => Ok(()),
                Some(ReadyState::Rejected(message)) => Err(message.clone()),
                _ => {
                    self.ensure_waits.push((token, next, sink));
                    continue;
                }
            };
            let step = tm.resume_ensure_ready(self, next, answer);
            drive_ensure(self, tm, step, sink);
        }
        while !self.closed_queue.is_empty() {
            let n = self.closed_queue.remove(0);
            if let Some(Some(rec)) = self.win_rec.get(n - 1).copied() {
                dw.on_closed(self, rec);
            }
        }
    }
}

// ---- the calls both the shell and the detached windows make ----

impl EditorCalls<View> for World {
    fn view_id(&mut self, view: &View) -> i64 {
        view.0
    }

    fn view_destroyed(&mut self, view: &View) -> bool {
        self.state(view.0).destroyed
    }

    fn set_visible(&mut self, view: &View, visible: bool) {
        self.log(vec![
            Value::from("setVisible"),
            Value::from(view.0),
            Value::Bool(visible),
        ]);
    }

    fn set_bounds(&mut self, view: &View, bounds: &Rect) {
        self.log(vec![
            Value::from("setBounds"),
            Value::from(view.0),
            rect_json(bounds),
        ]);
    }

    fn focus_view(&mut self, view: &View) {
        self.log(vec![Value::from("focus"), Value::from(view.0)]);
    }

    fn close_view(&mut self, view: &View) {
        self.log(vec![Value::from("close"), Value::from(view.0)]);
    }

    fn sheets_pending_edit_count(&mut self, wc_id: i64) -> f64 {
        self.log(vec![
            Value::from("sheetsPendingEditCount"),
            Value::from(wc_id),
        ]);
        self.state(wc_id).pending
    }

    fn family_is_dirty(&mut self, kind: TabKind, wc_id: i64) -> bool {
        self.log(vec![
            Value::from("isDirty"),
            Value::from(kind.as_str()),
            Value::from(wc_id),
        ]);
        self.state(wc_id).dirty
    }

    fn hwp_memo_modal_open(&mut self, wc_id: i64) -> bool {
        self.log(vec![Value::from("hwpMemoModalOpen"), Value::from(wc_id)]);
        self.state(wc_id).memo
    }

    fn set_active_docs_resolver(&mut self, view: Option<&View>, null_if_destroyed: bool) {
        let id = match view {
            Some(view) if !(null_if_destroyed && self.state(view.0).destroyed) => {
                Value::from(view.0)
            }
            _ => Value::Null,
        };
        self.log(vec![Value::from("setActiveDocsResolver"), id]);
    }

    fn set_active_sheets_web_contents(&mut self, view: Option<&View>) {
        self.log(vec![
            Value::from("setActiveSheetsWebContents"),
            view.map_or(Value::Null, |v| Value::from(v.0)),
        ]);
    }

    fn set_active_slides_web_contents(&mut self, view: &View) {
        self.log(vec![
            Value::from("setActiveSlidesWebContents"),
            Value::from(view.0),
        ]);
    }

    fn apply_menu_for(&mut self, kind: TabKind) {
        self.log(vec![
            Value::from("applyMenuFor"),
            Value::from(kind.as_str()),
        ]);
    }

    fn teardown_docs_renderer(&mut self, view: &View) {
        self.log(vec![
            Value::from("teardownDocsRenderer"),
            Value::from(view.0),
        ]);
    }

    fn release_closed_renderer(&mut self, view: &View) {
        self.log(vec![
            Value::from("releaseClosedRenderer"),
            Value::from(view.0),
        ]);
    }
}

// ---- the shell window and what the tab manager was given ----

impl TabHost<View> for World {
    fn window_destroyed(&mut self) -> bool {
        self.shell.destroyed
    }

    fn window_minimized(&mut self) -> bool {
        self.shell.minimized
    }

    fn window_focused(&mut self) -> bool {
        self.shell.focused
    }

    fn window_content_size(&mut self) -> (f64, f64) {
        (self.shell.width, self.shell.height)
    }

    fn add_child_view(&mut self, view: &View) {
        self.log(vec![Value::from("addChildView"), Value::from(view.0)]);
    }

    fn remove_child_view(&mut self, view: &View) {
        self.log(vec![Value::from("removeChildView"), Value::from(view.0)]);
    }

    fn focus_shell_contents(&mut self) {
        self.log(vec![Value::from("focusShell")]);
    }

    fn reload_view(&mut self, view: &View) {
        self.log(vec![Value::from("reload"), Value::from(view.0)]);
    }

    fn load_url(&mut self, view: &View, url: &str) {
        self.log(vec![
            Value::from("loadURL"),
            Value::from(view.0),
            Value::from(url),
        ]);
    }

    fn listen_html_full_screen(&mut self, view: &View) {
        for event in ["enter-html-full-screen", "leave-html-full-screen"] {
            self.log(vec![
                Value::from("on"),
                Value::from(view.0),
                Value::from(event),
            ]);
            self.listen(view.0, event, false);
        }
    }

    fn listen_pane_focus(&mut self, view: &View) {
        self.log(vec![
            Value::from("on"),
            Value::from(view.0),
            Value::from("focus"),
        ]);
        self.listen(view.0, "focus", false);
    }

    fn once_render_process_gone(&mut self, view: &View) {
        self.log(vec![
            Value::from("once"),
            Value::from(view.0),
            Value::from("render-process-gone"),
        ]);
        self.listen(view.0, "render-process-gone", true);
    }

    fn page_loaded(&mut self, view: &View) -> Ready {
        for event in ["did-finish-load", "destroyed"] {
            self.log(vec![
                Value::from("once"),
                Value::from(view.0),
                Value::from(event),
            ]);
            self.listen(view.0, event, true);
        }
        let token = PAGE_READY_BASE + view.0 as u64;
        self.readies.insert(token, ReadyState::Pending);
        Ready(token)
    }

    fn on_changed(&mut self) {
        self.log(vec![Value::from("onChanged")]);
    }

    fn on_split_changed(&mut self, state: Option<&SplitViewState>) {
        if self.split_listener {
            self.log(vec![
                Value::from("onSplitChanged"),
                state.map_or(Value::Null, SplitViewState::to_value),
            ]);
        }
    }

    fn on_tab_closed(&mut self, kind: TabKind, file_path: &str) {
        if self.closed_listener {
            self.log(vec![
                Value::from("onTabClosed"),
                Value::from(kind.as_str()),
                Value::from(file_path),
            ]);
        }
    }

    fn untitled_title_for(&mut self, kind: TabKind) -> Option<String> {
        self.untitled
            .as_ref()
            .and_then(|map| map.get(kind.as_str()))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn ui_scale(&mut self) -> f64 {
        self.scale
    }

    fn no_spare_view_env(&mut self) -> bool {
        self.no_spare
    }

    fn renderer_dev_url(&mut self) -> Option<String> {
        self.dev_url.clone()
    }

    fn set_spare_timer(&mut self, delay_ms: f64) {
        let n = self.start_timer(TimerKind::Spare, delay_ms);
        self.spare_timer = Some(n);
    }

    fn clear_spare_timer(&mut self) {
        if let Some(n) = self.spare_timer.take() {
            self.stop_timer(n);
        }
    }

    fn defer(&mut self, step: Deferred) {
        self.log(vec![Value::from("setImmediate")]);
        self.immediates.push(Immediate::Tab(step));
    }

    fn create_view(&mut self, spec: &ViewSpec<'_>) -> TabResult<View> {
        let (name, args): (&str, Vec<Value>) = match spec {
            ViewSpec::Docs { path } => ("createDocsView", vec![opt_str(*path)]),
            ViewSpec::Sheets { opening_workbook } => {
                let mut opts = Map::new();
                opts.insert("includeAiHandlers".into(), Value::Bool(false));
                if let Some(opening) = opening_workbook {
                    opts.insert("openingWorkbook".into(), Value::Bool(*opening));
                }
                ("createSheetsView", vec![Value::Object(opts)])
            }
            ViewSpec::Slides { path } => ("createSlidesView", vec![opt_str(*path)]),
            ViewSpec::Pdf { path } => ("createPdfView", vec![Value::from(*path)]),
            ViewSpec::Markdown { path } => ("createMarkdownView", vec![opt_str(*path)]),
            ViewSpec::Html { path } => ("createHtmlView", vec![opt_str(*path)]),
            ViewSpec::HtmlPresent { owner, title } => (
                "createHtmlPresentView",
                vec![Value::from(*owner), Value::from(*title)],
            ),
            ViewSpec::Mindmap { path } => ("createMindmapView", vec![opt_str(*path)]),
            ViewSpec::Epub { path } => ("createEpubView", vec![Value::from(*path)]),
            ViewSpec::Diagram { path } => ("createDiagramView", vec![opt_str(*path)]),
            ViewSpec::Hwp {
                path,
                untitled_copy,
            } => {
                let copy = match untitled_copy {
                    HwpUntitledCopy::Flag(flag) => Value::Bool(*flag),
                    HwpUntitledCopy::BaseName(name) => json!({ "baseName": name }),
                };
                (
                    "createHwpView",
                    vec![opt_str(*path), json!({ "untitledCopy": copy })],
                )
            }
        };
        let mut line = vec![Value::from(name)];
        line.extend(args);
        self.log(line);
        if self.failures.iter().any(|f| f == name) {
            return Err(crate::shell::tab_manager::TabError(
                "create failed".to_owned(),
            ));
        }
        Ok(self.make_view())
    }

    fn create_help_view(&mut self) -> View {
        let view = self.make_view();
        self.log(vec![
            Value::from("newWebContentsView"),
            Value::from(view.0),
            json!({
                "contextIsolation": true,
                "nodeIntegration": false,
                "sandbox": true,
                "backgroundThrottling": false
            }),
        ]);
        self.log(vec![
            Value::from("setWindowOpenHandler"),
            Value::from(view.0),
        ]);
        self.window_open.push(view.0);
        view
    }

    fn mark_docs_new_blank(&mut self, wc_id: i64) {
        self.log(vec![Value::from("markDocsNewBlank"), Value::from(wc_id)]);
    }

    fn queue_docs_ai_content(&mut self, wc_id: i64, content: &Value) {
        self.log(vec![
            Value::from("queueDocsAiContent"),
            Value::from(wc_id),
            content.clone(),
        ]);
    }

    fn queue_docs_copy(&mut self, wc_id: i64, path: &str, name: &str) {
        self.log(vec![
            Value::from("queueDocsCopy"),
            Value::from(wc_id),
            Value::from(path),
            Value::from(name),
        ]);
    }

    fn set_sheets_new_blank(&mut self) {
        self.log(vec![Value::from("setSheetsNewBlank")]);
    }

    fn queue_workbook_for_view(&mut self, view: &View, path: &str) {
        self.log(vec![
            Value::from("queueWorkbookForView"),
            Value::from(view.0),
            Value::from(path),
        ]);
    }

    fn nudge_queued_workbook(&mut self, view: &View) {
        self.log(vec![
            Value::from("nudgeQueuedWorkbook"),
            Value::from(view.0),
        ]);
    }

    fn mark_pdf_untitled_copy(&mut self, path: &str) {
        self.log(vec![Value::from("markPdfUntitledCopy"), Value::from(path)]);
    }

    fn clear_pdf_dirty(&mut self, wc_id: i64) {
        self.log(vec![Value::from("clearPdfDirty"), Value::from(wc_id)]);
    }

    fn queue_markdown_seed_for(&mut self, view: &View, text: &str) {
        self.log(vec![
            Value::from("queueMarkdownSeedFor"),
            Value::from(view.0),
            Value::from(text),
        ]);
    }

    fn queue_html_seed_for(&mut self, view: &View, text: &str) {
        self.log(vec![
            Value::from("queueHtmlSeedFor"),
            Value::from(view.0),
            Value::from(text),
        ]);
    }

    fn queue_mindmap_seed_for(&mut self, view: &View, bytes: &[u8]) {
        self.log(vec![
            Value::from("queueMindmapSeedFor"),
            Value::from(view.0),
            Value::from(hex(bytes)),
        ]);
    }

    fn queue_slides_seed_for(&mut self, view: &View, bytes: &[u8], suggested_name: &str) {
        self.log(vec![
            Value::from("queueSlidesSeedFor"),
            Value::from(view.0),
            Value::from(hex(bytes)),
            json!({ "askPathOnFirstSave": true, "suggestedName": suggested_name }),
        ]);
    }

    fn queue_generate_handoff_for(&mut self, view: &View, handoff: &Value) {
        self.log(vec![
            Value::from("queueGenerateHandoffFor"),
            Value::from(view.0),
            handoff.clone(),
        ]);
    }

    fn queue_converted_content(&mut self, view: &View, doc: &Value) {
        self.log(vec![
            Value::from("queueConvertedContent"),
            Value::from(view.0),
            doc.clone(),
        ]);
    }

    fn drop_generate_handoff(&mut self, wc_id: i64) {
        self.log(vec![Value::from("dropGenerateHandoff"), Value::from(wc_id)]);
    }

    fn diagram_tab_identity(&mut self, wc_id: i64) -> Option<DiagramIdentity> {
        self.log(vec![Value::from("diagramTabIdentity"), Value::from(wc_id)]);
        self.state(wc_id).identity.clone()
    }

    fn opener_open(
        &mut self,
        opener: &Opener,
        context: &UnloadedTabOpenContext,
    ) -> Result<LoadedTabView<View>, String> {
        let spec = self.openers.get(&opener.id).cloned();
        self.log(vec![
            Value::from("opener.open"),
            Value::from(opener.id),
            context.to_value(),
        ]);
        let Some(spec) = spec else {
            return Err("no such opener".to_owned());
        };
        if spec.plain {
            let view =
                create_plain_editor_view::<View>(self, context.kind, context.file_path.as_deref())
                    .map_err(|e| e.0)?;
            return Ok(LoadedTabView { view, ready: None });
        }
        if spec.fails {
            return Err("opener failed".to_owned());
        }
        let view = self.make_view();
        let state = match spec.ready.as_str() {
            "none" => {
                return Ok(LoadedTabView { view, ready: None });
            }
            "resolved" => ReadyState::Resolved,
            "rejected" => ReadyState::Rejected("document failed".to_owned()),
            _ => ReadyState::Pending,
        };
        self.readies.insert(opener.id, state);
        Ok(LoadedTabView {
            view,
            ready: Some(Ready(opener.id)),
        })
    }

    fn warn(&mut self, message: &str, error: &str) {
        self.log(vec![
            Value::from("warn"),
            Value::from(message),
            Value::from(error),
        ]);
    }
}

// ---- the detached windows ----

impl DetachedHost<View, Win> for World {
    fn create_window(&mut self, options: &WindowOptions) -> Win {
        let mut opts = Map::new();
        opts.insert("width".into(), Value::from(options.width));
        opts.insert("height".into(), Value::from(options.height));
        if let Some((x, y)) = options.origin {
            opts.insert("x".into(), Value::from(x));
            opts.insert("y".into(), Value::from(y));
        }
        opts.insert("minWidth".into(), Value::from(options.min_width));
        opts.insert("minHeight".into(), Value::from(options.min_height));
        opts.insert("title".into(), Value::from(options.title.as_str()));
        opts.insert("show".into(), Value::Bool(options.show));
        opts.insert(
            "autoHideMenuBar".into(),
            Value::Bool(options.auto_hide_menu_bar),
        );
        self.log(vec![Value::from("newBrowserWindow"), Value::Object(opts)]);
        self.windows.push(WinState {
            destroyed: false,
            minimized: false,
            focused: false,
            title: options.title.clone(),
            bounds: Rect {
                x: 0.0,
                y: 0.0,
                width: options.width,
                height: options.height,
            },
            position: options.origin.unwrap_or((0.0, 0.0)),
        });
        self.win_rec.push(None);
        Win(self.windows.len())
    }

    fn win_destroyed(&mut self, win: &Win) -> bool {
        self.win_state(win).destroyed
    }

    fn win_minimized(&mut self, win: &Win) -> bool {
        self.win_state(win).minimized
    }

    fn win_focused(&mut self, win: &Win) -> bool {
        self.win_state(win).focused
    }

    fn win_restore(&mut self, win: &Win) {
        self.log(vec![
            Value::from("win"),
            Value::from(win.0),
            Value::from("restore"),
        ]);
    }

    fn win_show(&mut self, win: &Win) {
        self.log(vec![
            Value::from("win"),
            Value::from(win.0),
            Value::from("show"),
        ]);
    }

    fn win_show_inactive(&mut self, win: &Win) {
        self.log(vec![
            Value::from("win"),
            Value::from(win.0),
            Value::from("showInactive"),
        ]);
    }

    fn win_focus(&mut self, win: &Win) {
        self.log(vec![
            Value::from("win"),
            Value::from(win.0),
            Value::from("focus"),
        ]);
    }

    fn win_destroy(&mut self, win: &Win) {
        self.log(vec![
            Value::from("win"),
            Value::from(win.0),
            Value::from("destroy"),
        ]);
        self.win_state(win).destroyed = true;
        self.closed_queue.push(win.0);
    }

    fn win_title(&mut self, win: &Win) -> String {
        self.win_state(win).title.clone()
    }

    fn win_set_title(&mut self, win: &Win, title: &str) {
        self.log(vec![
            Value::from("win"),
            Value::from(win.0),
            Value::from("setTitle"),
            Value::from(title),
        ]);
        self.win_state(win).title = title.to_owned();
    }

    fn win_content_bounds(&mut self, win: &Win) -> Rect {
        self.win_state(win).bounds
    }

    fn win_position(&mut self, win: &Win) -> (f64, f64) {
        self.win_state(win).position
    }

    fn win_set_position(&mut self, win: &Win, x: f64, y: f64) {
        self.log(vec![
            Value::from("win"),
            Value::from(win.0),
            Value::from("setPosition"),
            Value::from(x),
            Value::from(y),
        ]);
        self.win_state(win).position = (x, y);
    }

    fn content_add_child_view(&mut self, win: &Win, view: &View) {
        self.log(vec![
            Value::from("win"),
            Value::from(win.0),
            Value::from("addChildView"),
            Value::from(view.0),
        ]);
    }

    fn content_remove_child_view(&mut self, win: &Win, view: &View) {
        self.log(vec![
            Value::from("win"),
            Value::from(win.0),
            Value::from("removeChildView"),
            Value::from(view.0),
        ]);
    }

    fn display_work_area(&mut self, _at: (f64, f64)) -> Rect {
        self.work_area
    }

    fn cursor_point(&mut self) -> (f64, f64) {
        self.cursor
    }

    fn dock_band(&mut self) -> Option<Rect> {
        self.band
    }

    fn dock_preview(&mut self, x: Option<f64>) {
        self.log(vec![
            Value::from("preview"),
            x.map_or(Value::Null, Value::from),
        ]);
    }

    fn dock(&mut self, tab: DetachedTab<View>) {
        let mut tab_json = Map::new();
        tab_json.insert("kind".into(), Value::from(tab.kind.as_str()));
        tab_json.insert("title".into(), Value::from(tab.title.as_str()));
        if let Some(path) = &tab.file_path {
            tab_json.insert("filePath".into(), Value::from(path.as_str()));
        }
        tab_json.insert("view".into(), Value::from(tab.view.0));
        self.log(vec![Value::from("dock"), Value::Object(tab_json)]);
        if self.dock_attach {
            self.pending_docks.push(tab);
        }
    }

    fn on_detached_changed(&mut self) {
        self.log(vec![Value::from("detachedChanged")]);
    }

    fn arm_dock_timer(&mut self, rec: RecId, delay_ms: f64) {
        let n = self.start_timer(TimerKind::Dock(rec), delay_ms);
        self.dock_timers.insert(rec.0, n);
    }

    fn clear_dock_timer(&mut self, rec: RecId) {
        if let Some(n) = self.dock_timers.remove(&rec.0) {
            self.stop_timer(n);
        }
    }

    fn defer_layout(&mut self, rec: RecId) {
        self.log(vec![Value::from("setImmediate")]);
        self.immediates.push(Immediate::Win(rec));
    }

    fn reset_sheets_shutting_down(&mut self) {
        self.log(vec![Value::from("resetSheetsShuttingDown")]);
    }

    fn cancel_update_restart(&mut self) {
        self.log(vec![Value::from("cancelUpdateRestart")]);
    }

    fn resume_discarded_copies(&mut self) {
        self.log(vec![Value::from("resumeDiscardedCopies")]);
    }

    fn pdf_close_cancelled(&mut self, view: &View) {
        self.log(vec![Value::from("pdfCloseCancelled"), Value::from(view.0)]);
    }

    fn console_error(&mut self, message: &str, error: &str) {
        self.log(vec![
            Value::from("error"),
            Value::from(message),
            Value::from(error),
        ]);
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok())
        .collect()
}

// ---------------------------------------------------------------------------
// the scenario
// ---------------------------------------------------------------------------

fn str_of<'a>(o: &'a Value, key: &str) -> Option<&'a str> {
    o.get(key).and_then(Value::as_str)
}

fn f64_of(o: &Value, key: &str) -> Option<f64> {
    o.get(key).and_then(Value::as_f64)
}

fn i64_of(o: &Value, key: &str) -> i64 {
    o.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn bool_of(o: &Value, key: &str) -> Option<bool> {
    o.get(key).and_then(Value::as_bool)
}

fn orientation_of(text: Option<&str>) -> SplitOrientation {
    if text == Some("stack") {
        SplitOrientation::Stack
    } else {
        SplitOrientation::Side
    }
}

fn pane_of(text: Option<&str>) -> Pane {
    if text == Some("b") { Pane::B } else { Pane::A }
}

fn kind_of(text: Option<&str>) -> TabKind {
    text.and_then(TabKind::parse).unwrap_or(TabKind::Docs)
}

fn error_value(message: &str) -> Value {
    json!({ "error": message })
}

fn tab_result(result: TabResult<String>) -> Value {
    match result {
        Ok(id) => Value::from(id),
        Err(error) => error_value(&error.0),
    }
}

fn pairs_json(list: Vec<(String, View)>) -> Value {
    Value::Array(
        list.into_iter()
            .map(|(id, view)| json!({ "id": id, "wc": view.0 }))
            .collect(),
    )
}

fn live_json(tab: Option<LiveTab<View>>) -> Value {
    tab.map_or(
        Value::Null,
        |t| json!({ "id": t.id, "kind": t.kind.as_str(), "wc": t.view.0 }),
    )
}

fn active_json(tab: Option<LiveTab<View>>) -> Value {
    tab.map_or(Value::Null, |t| {
        let mut map = Map::new();
        map.insert("id".into(), Value::from(t.id));
        map.insert("wc".into(), Value::from(t.view.0));
        if let Some(path) = t.file_path {
            map.insert("filePath".into(), Value::from(path));
        }
        Value::Object(map)
    })
}

fn detached_tab_json(tab: Option<&DetachedTab<View>>) -> Value {
    tab.map_or(Value::Null, |t| {
        let mut map = Map::new();
        map.insert("kind".into(), Value::from(t.kind.as_str()));
        map.insert("title".into(), Value::from(t.title.as_str()));
        if let Some(path) = &t.file_path {
            map.insert("filePath".into(), Value::from(path.as_str()));
        }
        map.insert("wc".into(), Value::from(t.view.0));
        Value::Object(map)
    })
}

fn intent_of(value: Option<&Value>) -> Option<SplitDropIntent> {
    let value = value.filter(|v| !v.is_null())?;
    let orientation = orientation_of(str_of(value, "orientation"));
    Some(match str_of(value, "kind")? {
        "create" => SplitDropIntent::Create(orientation),
        "replace" => SplitDropIntent::Replace,
        "reorient" => SplitDropIntent::Reorient(orientation),
        "focus" => SplitDropIntent::Focus,
        "flip" => SplitDropIntent::Flip(orientation),
        _ => SplitDropIntent::Noop,
    })
}

fn unloaded_spec(w: &mut World, spec: &Value) -> UnloadedTabSpec {
    let opener = w.new_opener(spec.get("opener").unwrap_or(&Value::Null));
    UnloadedTabSpec {
        kind: kind_of(str_of(spec, "kind")),
        title: str_of(spec, "title").map(str::to_owned),
        file_path: str_of(spec, "filePath").map(str::to_owned),
        opener,
    }
}

fn identity_of(value: &Value) -> DiagramIdentity {
    DiagramIdentity {
        imported: value.get("imported").is_some(),
        title: str_of(value, "title").unwrap_or_default().to_owned(),
        source_path: str_of(value, "sourcePath").map(str::to_owned),
    }
}

// ---------------------------------------------------------------------------
// the steps the managers ask the adapter for
// ---------------------------------------------------------------------------

fn log_docs_query(w: &mut World, view: View) {
    w.log(vec![Value::from("docsQueryDirty"), Value::from(view.0)]);
}

fn log_close_prompt(w: &mut World, kind: TabKind, view: View, window: &str) {
    w.log(vec![
        Value::from("requestClose"),
        Value::from(kind.as_str()),
        Value::from(view.0),
        Value::from(window),
    ]);
}

/// Carry out the steps of a `closeTab` run: each `docsQueryDirty` and prompt
/// is logged as the TypeScript fake logs it, then answered at once or, while
/// the world holds, left waiting for `release`.
fn drive_tab_close(
    w: &mut World,
    tm: &mut TabManager<View>,
    mut step: TabCloseStep<View>,
    sink: Sink,
) -> Value {
    loop {
        match step {
            TabCloseStep::Done => return w.settle(sink, Value::Null),
            TabCloseStep::Rejected(message) => return w.settle(sink, error_value(&message)),
            TabCloseStep::QueryDocsDirty { id, view } => {
                log_docs_query(w, view);
                if w.hold {
                    w.held_steps.push_back(Held::TabClose { id, sink });
                    return Value::Null;
                }
                let answer = w.query_answer(view.0);
                step = tm.resume_close(w, &id, answer);
            }
            TabCloseStep::RequestClose { id, kind, view } => {
                log_close_prompt(w, kind, view, "shell");
                if w.hold {
                    w.held_steps.push_back(Held::TabClose { id, sink });
                    return Value::Null;
                }
                let answer = w.prompt_answer();
                step = tm.resume_close(w, &id, answer);
            }
        }
    }
}

/// the same for `openDocuments`
fn drive_open_docs(
    w: &mut World,
    tm: &mut TabManager<View>,
    mut step: OpenDocumentsStep<View, OpenDocumentsRun<View>>,
    sink: Sink,
) -> Value {
    loop {
        match step {
            OpenDocumentsStep::Done(list) => {
                let list = Value::Array(list.iter().map(|t| t.to_value()).collect());
                return w.settle(sink, list);
            }
            OpenDocumentsStep::Rejected(message) => {
                return w.settle(sink, error_value(&message));
            }
            OpenDocumentsStep::QueryDocsDirty { view, next } => {
                log_docs_query(w, view);
                if w.hold {
                    w.held_steps.push_back(Held::OpenDocs { run: next, sink });
                    return Value::Null;
                }
                let answer = w.query_answer(view.0);
                step = tm.resume_open_documents(w, next, answer);
            }
        }
    }
}

/// the same for `detachedOpenDocuments`
fn drive_detached_open_docs(
    w: &mut World,
    dw: &mut DetachedWindows<View, Win>,
    mut step: OpenDocumentsStep<View, DetachedOpenDocumentsRun>,
    sink: Sink,
) -> Value {
    loop {
        match step {
            OpenDocumentsStep::Done(list) => {
                let list = Value::Array(list.iter().map(|t| t.to_value()).collect());
                return w.settle(sink, list);
            }
            OpenDocumentsStep::Rejected(message) => {
                return w.settle(sink, error_value(&message));
            }
            OpenDocumentsStep::QueryDocsDirty { view, next } => {
                log_docs_query(w, view);
                if w.hold {
                    w.held_steps
                        .push_back(Held::DetachedOpenDocs { run: next, sink });
                    return Value::Null;
                }
                let answer = w.query_answer(view.0);
                step = dw.resume_detached_open_documents(w, next, answer);
            }
        }
    }
}

/// the same for the close prompt of a detached window
fn drive_detached_close(
    w: &mut World,
    dw: &mut DetachedWindows<View, Win>,
    rec: RecId,
    mut step: DetachedCloseStep<View, Win>,
) {
    loop {
        match step {
            DetachedCloseStep::Idle => return,
            DetachedCloseStep::QueryDocsDirty(view) => {
                log_docs_query(w, view);
                if w.hold {
                    w.held_steps.push_back(Held::DetachedClose { rec });
                    return;
                }
                let answer = w.query_answer(view.0);
                step = dw.resume_close(w, rec, answer);
            }
            DetachedCloseStep::RequestClose(kind, view, win) => {
                log_close_prompt(w, kind, view, &format!("window:{}", win.0));
                if w.hold {
                    w.held_steps.push_back(Held::DetachedClose { rec });
                    return;
                }
                let answer = w.prompt_answer();
                step = dw.resume_close(w, rec, answer);
            }
        }
    }
}

/// the same for `ensureTabLoaded`: an opener's `needsUser` is answered from
/// the scenario, and a `ready` that has not settled leaves the run waiting
/// (the operation itself answers `ready pending`, as the TypeScript helper
/// that waits a few turns does)
fn drive_ensure(
    w: &mut World,
    tm: &mut TabManager<View>,
    mut step: EnsureStep<View>,
    sink: Sink,
) -> Value {
    loop {
        match step {
            EnsureStep::Done(result) => {
                let shown = match result {
                    TabLoadResult::Ready(view) => json!({ "status": "ready", "wc": view.0 }),
                    TabLoadResult::NeedsUser => json!({ "status": "needs-user" }),
                    TabLoadResult::Missing => json!({ "status": "missing" }),
                };
                return w.settle(sink, shown);
            }
            EnsureStep::Rejected(message) => return w.settle(sink, error_value(&message)),
            EnsureStep::NeedsUser {
                opener,
                context,
                next,
            } => {
                w.log(vec![
                    Value::from("opener.needsUser"),
                    Value::from(opener.id),
                    context.to_value(),
                ]);
                let answer = w
                    .openers
                    .get(&opener.id)
                    .and_then(|spec| spec.needs_user)
                    .unwrap_or(false);
                step = tm.resume_ensure_needs_user(w, next, Ok(answer));
            }
            EnsureStep::AwaitReady { ready, next } => {
                let answer = match w.readies.get(&ready.0) {
                    Some(ReadyState::Resolved) => Ok(()),
                    Some(ReadyState::Rejected(message)) => Err(message.clone()),
                    _ => {
                        // the run goes on when the ready settles, and then
                        // answers to its sink; an operation that waits for its
                        // own answer gave up on it
                        let waiting = if sink == Sink::Op {
                            Sink::Discard
                        } else {
                            sink
                        };
                        w.ensure_waits.push((ready.0, next, waiting));
                        return if sink == Sink::Op {
                            error_value("ready pending")
                        } else {
                            Value::Null
                        };
                    }
                };
                step = tm.resume_ensure_ready(w, next, answer);
            }
        }
    }
}

/// `release`: answer the oldest run the world holds back
fn release(
    w: &mut World,
    tm: &mut TabManager<View>,
    dw: &mut DetachedWindows<View, Win>,
    answer: Result<bool, String>,
) -> Value {
    let Some(held) = w.held_steps.pop_front() else {
        return Value::Bool(false);
    };
    match held {
        Held::TabClose { id, sink } => {
            let step = tm.resume_close(w, &id, answer);
            drive_tab_close(w, tm, step, sink);
        }
        Held::OpenDocs { run, sink } => {
            let step = tm.resume_open_documents(w, run, answer);
            drive_open_docs(w, tm, step, sink);
        }
        Held::DetachedClose { rec } => {
            let step = dw.resume_close(w, rec, answer);
            drive_detached_close(w, dw, rec, step);
        }
        Held::DetachedOpenDocs { run, sink } => {
            let step = dw.resume_detached_open_documents(w, run, answer);
            drive_detached_open_docs(w, dw, step, sink);
        }
    }
    Value::Bool(true)
}

fn scenario_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| CallError::plain("scenario"))?;
    let mut w = World::new(spec);
    let mut tm: TabManager<View> = TabManager::new();
    let mut dw: DetachedWindows<View, Win> = DetachedWindows::new();
    let platform = str_of(spec, "platform").unwrap_or("").to_owned();
    let mut results: Vec<Value> = Vec::new();
    for op in spec
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = str_of(op, "op").unwrap_or("");
        let value = run_op(name, op, &mut w, &mut tm, &mut dw, &platform, Sink::Op);
        w.after_op(&mut tm, &mut dw);
        results.push(json!([name, value]));
    }
    let list: Vec<Value> = tm.list().iter().map(|t| t.to_value()).collect();
    let split = tm.split_state().map_or(Value::Null, |s| s.to_value());
    let session = tm.session_tabs().to_value();
    let paths = tm.open_file_paths();
    results.push(json!([
        "final",
        { "list": list, "split": split, "session": session, "paths": paths }
    ]));
    cx.logs.extend(w.logs);
    Ok(Some(Value::Array(results)))
}

fn run_op(
    name: &str,
    o: &Value,
    w: &mut World,
    tm: &mut TabManager<View>,
    dw: &mut DetachedWindows<View, Win>,
    platform: &str,
    sink: Sink,
) -> Value {
    let id = str_of(o, "id").unwrap_or("");
    match name {
        // ---- the world ----
        "window" => {
            if let Some(v) = bool_of(o, "destroyed") {
                w.shell.destroyed = v;
            }
            if let Some(v) = bool_of(o, "minimized") {
                w.shell.minimized = v;
            }
            if let Some(v) = bool_of(o, "focused") {
                w.shell.focused = v;
            }
            if let Some(v) = f64_of(o, "width") {
                w.shell.width = v;
            }
            if let Some(v) = f64_of(o, "height") {
                w.shell.height = v;
            }
            Value::Null
        }
        "state" => {
            let wc = i64_of(o, "wc");
            let state = w.state(wc);
            if let Some(v) = bool_of(o, "dirty") {
                state.dirty = v;
            }
            if let Some(v) = f64_of(o, "pending") {
                state.pending = v;
            }
            if let Some(v) = bool_of(o, "memo") {
                state.memo = v;
            }
            if let Some(v) = bool_of(o, "destroyed") {
                state.destroyed = v;
            }
            if let Some(v) = bool_of(o, "queryFails") {
                state.query_fails = v;
            }
            if let Some(identity) = o.get("identity") {
                state.identity = Some(identity_of(identity));
            }
            Value::Null
        }
        "closeAnswers" => {
            for answer in o
                .get("answers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                w.close_answers.push_back(match answer.as_bool() {
                    Some(b) => CloseAnswer::Answer(b),
                    None => CloseAnswer::Throws,
                });
            }
            Value::Null
        }
        "hold" => {
            w.hold = bool_of(o, "on").unwrap_or(false);
            Value::Null
        }
        "release" => {
            let answer = match o.get("answer") {
                Some(Value::String(_)) => Err("released failure".to_owned()),
                other => Ok(other.and_then(Value::as_bool).unwrap_or(false)),
            };
            release(w, tm, dw, answer)
        }
        "bg" => {
            // the operation runs on; its result is read by `join`
            let slot = w.bgs.len();
            w.bgs.push(None);
            let inner = o.get("do").unwrap_or(&Value::Null);
            let inner_name = str_of(inner, "op").unwrap_or("");
            run_op(inner_name, inner, w, tm, dw, platform, Sink::Bg(slot));
            Value::Null
        }
        "join" => Value::Array(
            w.bgs
                .iter()
                .map(|slot| slot.clone().unwrap_or(Value::Null))
                .collect(),
        ),
        "fail" => {
            let create = str_of(o, "create").unwrap_or("").to_owned();
            if bool_of(o, "on") == Some(false) {
                w.failures.retain(|f| *f != create);
            } else {
                w.failures.push(create);
            }
            Value::Null
        }
        "screen" => {
            if let Some(c) = o.get("cursor") {
                w.cursor = (f64_of(c, "x").unwrap_or(0.0), f64_of(c, "y").unwrap_or(0.0));
            }
            if let Some(area) = o.get("workArea") {
                w.work_area = rect_of(area);
            }
            Value::Null
        }
        "band" => {
            w.band = o.get("rect").filter(|r| !r.is_null()).map(rect_of);
            Value::Null
        }
        "dockHost" => {
            w.dock_on = bool_of(o, "on").unwrap_or(false);
            w.dock_attach = bool_of(o, "attach") != Some(false);
            w.dock_index = f64_of(o, "index");
            dw.set_dock_host(w.dock_on);
            Value::Null
        }
        "settle" => {
            let pending = std::mem::take(&mut w.immediates);
            let count = pending.len();
            for step in pending {
                match step {
                    Immediate::Tab(step) => tm.run_deferred(w, step),
                    Immediate::Win(rec) => dw.run_deferred_layout(w, rec),
                }
            }
            Value::from(count)
        }
        "fireTimer" => {
            let n = o.get("n").and_then(Value::as_u64).unwrap_or(0);
            let Some(at) = w.timers.iter().position(|(t, _)| *t == n) else {
                return Value::Bool(false);
            };
            let (_, kind) = w.timers.remove(at);
            match kind {
                TimerKind::Spare => {
                    w.spare_timer = None;
                    if let Err(error) = tm.fire_spare_sheets_timer(w) {
                        return error_value(&error.0);
                    }
                }
                TimerKind::Dock(rec) => {
                    w.dock_timers.remove(&rec.0);
                    dw.dock_timer_fired(w, rec);
                }
            }
            Value::Bool(true)
        }
        "viewEvent" => {
            let wc = i64_of(o, "wc");
            let event = str_of(o, "event").unwrap_or("");
            if w.fire(wc, event) {
                let view = View(wc);
                match event {
                    "enter-html-full-screen" => tm.on_enter_html_full_screen(w, &view),
                    "leave-html-full-screen" => tm.on_leave_html_full_screen(w, &view),
                    "focus" => tm.on_pane_focus(w, &view),
                    "render-process-gone" => tm.on_spare_render_process_gone(w, &view),
                    "did-finish-load" => {
                        w.settle_ready(PAGE_READY_BASE + wc as u64, ReadyState::Resolved)
                    }
                    "destroyed" => w.settle_ready(
                        PAGE_READY_BASE + wc as u64,
                        ReadyState::Rejected("the document tab was closed".to_owned()),
                    ),
                    _ => {}
                }
            }
            Value::Null
        }
        "ready" => {
            let token = o.get("opener").and_then(Value::as_u64).unwrap_or(0);
            let state = if str_of(o, "settle") == Some("reject") {
                ReadyState::Rejected("document failed".to_owned())
            } else {
                ReadyState::Resolved
            };
            w.settle_ready(token, state);
            Value::Null
        }
        "helpOpen" => {
            let wc = i64_of(o, "wc");
            if !w.window_open.contains(&wc) {
                return Value::Null;
            }
            let action = help_window_open(str_of(o, "url").unwrap_or(""), &mut |target| {
                w.log(vec![Value::from("openExternal"), Value::from(target)]);
            });
            json!({ "action": action })
        }
        // ---- opening ----
        "open" => open_tab(o, w, tm),
        "generate" => {
            let target = str_of(o, "target").unwrap_or("");
            let mut handoff = Map::new();
            handoff.insert("target".into(), Value::from(target));
            if let Some(Value::Object(rest)) = o.get("handoff") {
                for (k, v) in rest {
                    handoff.insert(k.clone(), v.clone());
                }
            }
            tab_result(tm.open_generate_target_tab(w, target, &Value::Object(handoff)))
        }
        "convert" => {
            let target = str_of(o, "target").unwrap_or("");
            let mut doc = Map::new();
            doc.insert("content".into(), json!({ "target": target }));
            if let Some(Value::Object(rest)) = o.get("doc") {
                for (k, v) in rest {
                    doc.insert(k.clone(), v.clone());
                }
            }
            tab_result(tm.open_conversion_result(w, target, &Value::Object(doc)))
        }
        "template" => {
            let c = o.get("copy").unwrap_or(&Value::Null);
            let copy = TemplateCopy {
                editor: str_of(c, "editor").unwrap_or("").to_owned(),
                path: str_of(c, "path").unwrap_or("").to_owned(),
                bytes: unhex(str_of(c, "hex").unwrap_or("")),
                file_name: str_of(c, "fileName").unwrap_or("").to_owned(),
                title: str_of(c, "title").unwrap_or("").to_owned(),
            };
            match tm.open_template_copy(w, &copy) {
                Ok(Some((tab_id, view))) => json!({ "tabId": tab_id, "wc": view.0 }),
                Ok(None) => Value::Null,
                Err(error) => error_value(&error.0),
            }
        }
        "plainView" => {
            match create_plain_editor_view::<View>(w, kind_of(str_of(o, "kind")), str_of(o, "path"))
            {
                Ok(view) => Value::from(view.0),
                Err(error) => error_value(&error.0),
            }
        }
        "home" => {
            tm.open_home_tab(w);
            Value::Null
        }
        "activate" => {
            tm.activate_tab(w, id);
            Value::Null
        }
        "cycle" => {
            let dir = o.get("dir").and_then(Value::as_i64).unwrap_or(1);
            tm.cycle_tab(w, dir as i32);
            Value::Null
        }
        "reload" => {
            tm.reload_tab(w, id);
            Value::Null
        }
        "refresh" => {
            tm.refresh_active_targets(w);
            Value::Null
        }
        "focusActive" => {
            tm.focus_active_view(w);
            Value::Null
        }
        "reorder" => {
            tm.reorder_tab(w, id, f64_of(o, "to").unwrap_or(f64::NAN));
            Value::Null
        }
        // ---- layout ----
        "layout" => {
            tm.layout(w);
            Value::Null
        }
        "resize" => {
            tm.on_window_resize(w);
            Value::Null
        }
        "restore" => {
            tm.on_window_restore(w);
            Value::Null
        }
        "reconcile" => {
            tm.reconcile_after_window_restore(w);
            Value::Null
        }
        "bleed" => {
            tm.set_content_bleed(w, i64_of(o, "wc"), bool_of(o, "on").unwrap_or(false));
            Value::Null
        }
        // ---- unloaded tabs ----
        "addUnloaded" => {
            let spec = unloaded_spec(w, o.get("spec").unwrap_or(&Value::Null));
            Value::from(tm.add_unloaded_tab(w, &spec))
        }
        "hydrate" => {
            let s = o.get("session").unwrap_or(&Value::Null);
            let tabs: Vec<UnloadedTabSpec> = s
                .get("tabs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|t| unloaded_spec(w, t))
                .collect();
            let split = s.get("split").map(|p| RestoredSplit {
                a: f64_of(p, "a").unwrap_or(f64::NAN),
                b: f64_of(p, "b").unwrap_or(f64::NAN),
                orientation: orientation_of(str_of(p, "orientation")),
                ratio: f64_of(p, "ratio").unwrap_or(f64::NAN),
                focus: pane_of(str_of(p, "focus")),
            });
            let session = RestoredSession {
                tabs,
                active: f64_of(s, "active"),
                split,
            };
            Value::from(tm.hydrate_session(w, &session))
        }
        "ensure" => {
            let step = tm.ensure_tab_loaded(w, id);
            drive_ensure(w, tm, step, sink)
        }
        "unloaded" => Value::Bool(tm.is_tab_unloaded(id)),
        // ---- the split ----
        "splitWith" => {
            let tab = str_of(o, "tab").unwrap_or("");
            match tm.split_with(w, tab, intent_of(o.get("intent"))) {
                Ok(()) => Value::Null,
                Err(error) => error_value(&error.0),
            }
        }
        "beginSplit" => {
            tm.begin_split(
                w,
                str_of(o, "a").unwrap_or(""),
                str_of(o, "b").unwrap_or(""),
                orientation_of(str_of(o, "orientation")),
                f64_of(o, "ratio").unwrap_or(f64::NAN),
                pane_of(str_of(o, "focus")),
            );
            Value::Null
        }
        "ratio" => {
            tm.set_split_ratio(w, f64_of(o, "value").unwrap_or(f64::NAN));
            Value::Null
        }
        "unsplit" => {
            tm.unsplit(w);
            Value::Null
        }
        "focusPane" => {
            tm.focus_pane_by_web_contents(w, i64_of(o, "wc"));
            Value::Null
        }
        "role" => tm
            .split_role_of(w, i64_of(o, "wc"))
            .map_or(Value::Null, |r| Value::from(r.as_str())),
        "isPane" => Value::Bool(tm.is_pane_tab(str_of(o, "tab").unwrap_or(""))),
        "promptBegin" => {
            tm.begin_exclusive_prompt();
            Value::Null
        }
        "promptEnd" => {
            tm.end_exclusive_prompt(w);
            Value::Null
        }
        "duplicate" => match tm.open_duplicate_pane_tab(w, str_of(o, "tab").unwrap_or("")) {
            Ok(id) => id.map_or(Value::Null, Value::from),
            Err(error) => error_value(&error.0),
        },
        // ---- closing, detaching ----
        "closeTab" => {
            let step = tm.close_tab(w, id);
            drive_tab_close(w, tm, step, sink)
        }
        "closeActive" => {
            // `void closeTab(...)`: nobody reads how it ends
            let step = tm.close_active_tab(w);
            drive_tab_close(w, tm, step, Sink::Discard)
        }
        "closeNoPrompt" => Value::Bool(tm.close_tab_without_prompt(w, id)),
        "detach" => {
            let tab = tm.detach_tab(w, id);
            let shown = detached_tab_json(tab.as_ref());
            w.held.push(tab);
            json!({ "held": w.held.len() - 1, "tab": shown })
        }
        "attach" => {
            let at = o.get("held").and_then(Value::as_u64).unwrap_or(0) as usize;
            let Some(Some(tab)) = w.held.get(at).cloned() else {
                return Value::Null;
            };
            let activate = bool_of(o, "activate").unwrap_or(true);
            Value::from(tm.attach_tab(w, tab, f64_of(o, "index"), activate))
        }
        "canDetach" => Value::Bool(tm.can_detach_tab(id)),
        // ---- queries ----
        "list" => Value::Array(tm.list().iter().map(|t| t.to_value()).collect()),
        "split" => tm.split_state().map_or(Value::Null, |s| s.to_value()),
        "session" => tm.session_tabs().to_value(),
        "paths" => json!(tm.open_file_paths()),
        "openDocuments" => {
            let step = tm.open_documents(w);
            drive_open_docs(w, tm, step, sink)
        }
        "describe" => match tm.describe_web_contents(w, i64_of(o, "wc")) {
            Some((kind, title, file_path)) => {
                let mut map = Map::new();
                map.insert("kind".into(), Value::from(kind.as_str()));
                map.insert("title".into(), Value::from(title));
                if let Some(path) = file_path {
                    map.insert("filePath".into(), Value::from(path));
                }
                Value::Object(map)
            }
            None => Value::Null,
        },
        "tabId" => tm
            .tab_id_for_web_contents(w, i64_of(o, "wc"))
            .map_or(Value::Null, Value::from),
        "setFile" => {
            tm.set_tab_file_for(w, i64_of(o, "wc"), str_of(o, "path").unwrap_or(""));
            Value::Null
        }
        "setTitle" => {
            tm.set_tab_title_for(w, i64_of(o, "wc"), str_of(o, "title").unwrap_or(""));
            Value::Null
        }
        "rename" => Value::Array(
            tm.rename_tab_file(
                w,
                str_of(o, "from").unwrap_or(""),
                str_of(o, "to").unwrap_or(""),
            )
            .into_iter()
            .map(|(kind, view)| json!({ "kind": kind.as_str(), "wc": view.0 }))
            .collect(),
        ),
        "dirty" => pairs_json(tm.dirty_tabs(w, kind_of(str_of(o, "kind")))),
        "dirtyMemo" => pairs_json(tm.dirty_or_memo_hwp_tabs(w)),
        "live" => pairs_json(tm.live_tabs(kind_of(str_of(o, "kind")))),
        "find" => live_json(tm.find_tab_by_path(w, str_of(o, "path"))),
        "findKind" => tm
            .find_tab_of_kind_by_path(kind_of(str_of(o, "kind")), str_of(o, "path"))
            .map_or(Value::Null, Value::from),
        "findDiagram" => tm
            .find_diagram_tab_by_path(w, str_of(o, "path"))
            .map_or(Value::Null, Value::from),
        "findSheets" => tm.find_sheets_tab().map_or(Value::Null, Value::from),
        "active" => active_json(tm.active_tab_of_kind(kind_of(str_of(o, "kind")))),
        "viewFor" => tm
            .web_contents_for_tab(id)
            .map_or(Value::Null, |v| Value::from(v.0)),
        // ---- detached windows ----
        "newWindow" => {
            let Some(tab) = tm.detach_tab(w, str_of(o, "tab").unwrap_or("")) else {
                return Value::Null;
            };
            let tear_off_at = o
                .get("tearOffAt")
                .map(|p| (f64_of(p, "x").unwrap_or(0.0), f64_of(p, "y").unwrap_or(0.0)));
            let rec = dw.create(
                w,
                DetachedWindowOptions {
                    view: tab.view,
                    kind: tab.kind,
                    title: tab.title,
                    file_path: tab.file_path,
                    tear_off_at,
                },
            );
            let n = w.windows.len();
            w.win_rec[n - 1] = Some(rec);
            json!({ "window": n })
        }
        "win" => window_event(o, w, dw, platform),
        "winState" => {
            let n = o.get("window").and_then(Value::as_u64).unwrap_or(1) as usize;
            // a window destroyed from outside closes, as Electron's does
            if bool_of(o, "destroyed") == Some(true)
                && !w.win_state(&Win(n)).destroyed
                && bool_of(o, "silent") != Some(true)
            {
                w.closed_queue.push(n);
            }
            let win = w.win_state(&Win(n));
            if let Some(v) = bool_of(o, "destroyed") {
                win.destroyed = v;
            }
            if let Some(v) = bool_of(o, "minimized") {
                win.minimized = v;
            }
            if let Some(v) = bool_of(o, "focused") {
                win.focused = v;
            }
            if let Some(v) = str_of(o, "title") {
                win.title = v.to_owned();
            }
            if let Some(b) = o.get("bounds") {
                if let Some(v) = f64_of(b, "x") {
                    win.bounds.x = v;
                }
                if let Some(v) = f64_of(b, "y") {
                    win.bounds.y = v;
                }
                if let Some(v) = f64_of(b, "width") {
                    win.bounds.width = v;
                }
                if let Some(v) = f64_of(b, "height") {
                    win.bounds.height = v;
                }
            }
            Value::Null
        }
        "drag" => {
            dw.drag_torn_window(
                w,
                f64_of(o, "x").unwrap_or(0.0),
                f64_of(o, "y").unwrap_or(0.0),
            );
            Value::Null
        }
        "endTear" => {
            dw.end_torn_drag(w);
            Value::Null
        }
        "takeTear" => match dw.take_torn_tab(w) {
            Some(tab) => Value::from(tm.attach_tab(w, tab, f64_of(o, "index"), true)),
            None => Value::Null,
        },
        "isTearing" => Value::Bool(dw.is_tearing_off(w)),
        "closeDetached" => Value::Bool(dw.close_detached_without_prompt(w, id)),
        "activateDetached" => Value::Bool(dw.activate_detached(w, id)),
        "isDetachedId" => Value::Bool(dw.is_detached_tab_id(w, id)),
        "isDetachedWindow" => {
            let n = o.get("window").and_then(Value::as_u64).unwrap_or(1) as usize;
            Value::Bool(dw.is_detached_editor_window(&Win(n)))
        }
        "focusDetachedByPath" => {
            Value::Bool(dw.focus_detached_by_path(w, str_of(o, "path").unwrap_or("")))
        }
        "findDetachedByPath" => dw
            .find_detached_tab_by_path(w, str_of(o, "path").unwrap_or(""))
            .map_or(
                Value::Null,
                |t| json!({ "id": t.id, "kind": t.kind.as_str(), "wc": t.view.0 }),
            ),
        "detachedDoc" => dw
            .detached_document_for(w, i64_of(o, "wc"))
            .map_or(Value::Null, |d| {
                let mut map = Map::new();
                map.insert("id".into(), Value::from(d.id));
                map.insert("kind".into(), Value::from(d.kind.as_str()));
                map.insert("title".into(), Value::from(d.title));
                if let Some(path) = d.file_path {
                    map.insert("filePath".into(), Value::from(path));
                }
                Value::Object(map)
            }),
        "windowForWc" => dw
            .detached_window_for_web_contents(w, i64_of(o, "wc"))
            .map_or(Value::Null, |win| Value::from(win.0)),
        "focusedDetached" => dw.focused_detached_tab(w).map_or(Value::Null, |t| {
            let mut map = Map::new();
            map.insert("id".into(), Value::from(t.id));
            map.insert("kind".into(), Value::from(t.kind.as_str()));
            map.insert("wc".into(), Value::from(t.view.0));
            if let Some(path) = t.file_path {
                map.insert("filePath".into(), Value::from(path));
            }
            map.insert("window".into(), Value::from(t.window.0));
            Value::Object(map)
        }),
        "focusedKind" => dw
            .focused_detached_kind(w)
            .map_or(Value::Null, |k| Value::from(k.as_str())),
        "detachedWc" => dw
            .detached_web_contents_for(w, id)
            .map_or(Value::Null, |v| Value::from(v.0)),
        "detachedOpenDocuments" => {
            let step = dw.detached_open_documents(w);
            drive_detached_open_docs(w, dw, step, sink)
        }
        "detachedSessionTabs" => Value::Array(
            dw.detached_session_tabs(w)
                .iter()
                .map(|t| t.to_value())
                .collect(),
        ),
        "detachedFilePaths" => json!(dw.detached_file_paths(w)),
        "detachedSetFile" => {
            dw.detached_set_file_for(w, i64_of(o, "wc"), str_of(o, "path").unwrap_or(""));
            Value::Null
        }
        "detachedSetTitle" => {
            dw.detached_set_title_for(w, i64_of(o, "wc"), str_of(o, "title").unwrap_or(""));
            Value::Null
        }
        "detachedRename" => dw
            .detached_rename_file(
                w,
                str_of(o, "from").unwrap_or(""),
                str_of(o, "to").unwrap_or(""),
            )
            .map_or(
                Value::Null,
                |(kind, view)| json!({ "kind": kind.as_str(), "wc": view.0 }),
            ),
        "dockBandFor" => {
            let shell = o
                .get("shell")
                .filter(|s| !s.is_null())
                .map(|s| ShellWindowState {
                    destroyed: bool_of(s, "destroyed") == Some(true),
                    visible: bool_of(s, "visible") != Some(false),
                    minimized: bool_of(s, "minimized") == Some(true),
                    content_bounds: s.get("bounds").map(rect_of).unwrap_or(Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 0.0,
                        height: 0.0,
                    }),
                });
            dock_band_for(shell.as_ref(), f64_of(o, "scale").unwrap_or(1.0))
                .map_or(Value::Null, |r| rect_json(&r))
        }
        other => error_value(&format!("unknown operation {other}")),
    }
}

/// a window event, delivered to the listener the Rust method stands for; the
/// `moved` listener exists on Windows only
fn window_event(
    o: &Value,
    w: &mut World,
    dw: &mut DetachedWindows<View, Win>,
    platform: &str,
) -> Value {
    let n = o.get("window").and_then(Value::as_u64).unwrap_or(1) as usize;
    let Some(Some(rec)) = w.win_rec.get(n - 1).copied() else {
        return Value::Null;
    };
    match str_of(o, "event").unwrap_or("") {
        "close" => {
            let event = dw.on_close(w, rec);
            drive_detached_close(w, dw, rec, event.step);
            if !event.prevent_default && !w.win_state(&Win(n)).destroyed {
                w.win_state(&Win(n)).destroyed = true;
                w.closed_queue.push(n);
            }
            json!({ "prevented": event.prevent_default })
        }
        "closed" => {
            dw.on_closed(w, rec);
            Value::Null
        }
        "resize" => {
            dw.on_resize(w, rec);
            Value::Null
        }
        "restore" => {
            dw.on_restore(w, rec);
            Value::Null
        }
        "focus" => {
            dw.on_focus(w, rec);
            Value::Null
        }
        "move" => {
            dw.on_move(w, rec);
            Value::Null
        }
        "moved" => {
            if platform == "win32" {
                dw.on_moved(w, rec);
            }
            Value::Null
        }
        _ => Value::Null,
    }
}

fn open_tab(o: &Value, w: &mut World, tm: &mut TabManager<View>) -> Value {
    let path = str_of(o, "path");
    let result = match str_of(o, "kind").unwrap_or("") {
        "docs" => {
            let options = if o.get("newBlank").is_some() || o.get("aiContent").is_some() {
                Some(OpenDocsOptions {
                    new_blank: bool_of(o, "newBlank").unwrap_or(false),
                    ai_content: o.get("aiContent").cloned(),
                })
            } else {
                None
            };
            tm.open_docs_tab(w, path, options.as_ref())
        }
        "sheets" => tm.open_sheets_tab(w, path, bool_of(o, "newBlank").unwrap_or(false)),
        "slides" => tm.open_slides_tab(w, path),
        "pdf" => tm.open_pdf_tab(w, path.unwrap_or("")),
        "markdown" => tm.open_markdown_tab(w, path),
        "html" => tm.open_html_tab(w, path),
        "mindmap" => tm.open_mindmap_tab(w, path),
        "epub" => tm.open_epub_tab(w, path.unwrap_or("")),
        "diagram" => tm.open_diagram_tab(w, path),
        "hwp" => {
            let copy = o.get("copy").map(|c| HwpCopy {
                title: str_of(c, "title").unwrap_or("").to_owned(),
                imported_pdf: bool_of(c, "importedPdf") == Some(true),
            });
            tm.open_hwp_tab(w, path, copy.as_ref())
        }
        "help" => tm.open_help_tab(w, str_of(o, "topic")),
        "present" => {
            tm.open_html_present_tab(w, i64_of(o, "owner"), str_of(o, "title").unwrap_or(""))
        }
        other => {
            return error_value(&format!("unknown kind {other}"));
        }
    };
    tab_result(result)
}
