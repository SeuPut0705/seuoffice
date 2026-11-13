//! The fakes of [`WindowsHost`] and [`TabHooks`] for `crates/ipc-probe`
//! (tools/ipc-diff), the Rust half of `tools/ipc-diff/groups/w/tabs-lib`.
//! One world answers both traits and the document editors: every call is one
//! line of the case's log, named and shaped as the TypeScript world writes it
//! (`tabs-lib/world.ts`), and every answer comes from the case's `hosts.w`:
//!
//! - `shell`: `{width, height, scale, focused, minimized}` of the shell window
//! - `workArea`, `cursor`: the screen
//! - `views`: `{"<webContents id>": {dirty, pending, memo, destroyed, queryFails}}`
//! - `closeAnswers`: what each editor's close prompt answers, in order (`true`
//!   when it runs out; `"throws"` rejects)
//! - `menus`: for each popup menu the label it picks (`null`: dismissed)
//! - `appMenu`: `[{label, enabled, type, submenu: [...]}]`, the application menu
//! - `homeKinds`: the visible new-document kinds in home's order
//! - `strings`: `tm(key)`; `fail`: names of `create*View` calls that throw
//! - `defaultSaveDir`, `blankXlsx`, `blankPdf` (hex), `refuse` (diagram path to reason)

use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;
use std::sync::{Arc, Mutex, MutexGuard};

use main_core::shell::detached_windows::WindowOptions;
use main_core::shell::split_layout::Rect;
use main_core::shell::tab_manager::{
    DiagramIdentity, HwpUntitledCopy, LoadedTabView, Opener, SplitViewState, TabError, TabKind,
    TabResult, UnloadedTabOpenContext, ViewSpec,
};
use serde_json::{Map, Value, json};
use shell_contract::Hosts;
use shell_contract::editors::{DocumentEditors, SaveMode, Then};
use shell_contract::error::IpcError;
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::provided::Provided;
use shell_contract::runtime::Services;

use super::host::{
    DocAction, HostEvent, HostEvents, MenuEntry, MenuEntryKind, ShellWindow, TabHooks, TabsChanged,
    TimerKey, ViewListen, WindowEvent, WindowState, WindowsHost, WindowsHostRef,
};

/// The call log of the case, the one `ipc-probe` puts in `Hosts`
pub type ProbeLog = Arc<Mutex<Vec<Value>>>;

#[derive(Default)]
struct ViewState {
    dirty: bool,
    pending: f64,
    memo: bool,
    destroyed: bool,
    query_fails: bool,
}

struct WinState {
    destroyed: bool,
    minimized: bool,
    focused: bool,
    bounds: Rect,
    position: (f64, f64),
    title: String,
}

struct World {
    case: Value,
    log: ProbeLog,
    muted: bool,
    events: Option<Arc<dyn HostEvents>>,
    next_view: u32,
    next_window: u32,
    next_uuid: u32,
    views: HashMap<u32, ViewState>,
    kinds: HashMap<u32, TabKind>,
    windows: HashMap<u32, WinState>,
    close_answers: VecDeque<Value>,
    menus: VecDeque<Value>,
    app_labels: Vec<String>,
    suggested: HashSet<String>,
    shell: ShellWindow,
}

fn rect_json(r: &Rect) -> Value {
    json!({ "x": r.x, "y": r.y, "width": r.width, "height": r.height })
}

fn rect_of(v: &Value, default: Rect) -> Rect {
    let f = |key: &str, d: f64| v.get(key).and_then(Value::as_f64).unwrap_or(d);
    Rect {
        x: f("x", default.x),
        y: f("y", default.y),
        width: f("width", default.width),
        height: f("height", default.height),
    }
}

fn opt_str(text: Option<&str>) -> Value {
    text.map_or(Value::Null, Value::from)
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok())
        .collect()
}

impl World {
    fn new(case: &Value, log: ProbeLog) -> World {
        let shell = &case["shell"];
        let window = shell["window"].as_u64().unwrap_or(1) as u32;
        let view = shell["view"].as_u64().unwrap_or(1) as u32;
        let mut windows = HashMap::new();
        windows.insert(
            window,
            WinState {
                destroyed: false,
                minimized: shell["minimized"].as_bool().unwrap_or(false),
                focused: shell["focused"].as_bool().unwrap_or(true),
                bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: shell["width"].as_f64().unwrap_or(1200.0),
                    height: shell["height"].as_f64().unwrap_or(800.0),
                },
                position: (0.0, 0.0),
                title: String::new(),
            },
        );
        let queue = |key: &str| -> VecDeque<Value> {
            case[key]
                .as_array()
                .map(|a| a.iter().cloned().collect())
                .unwrap_or_default()
        };
        let mut views = HashMap::new();
        if let Some(map) = case["views"].as_object() {
            for (id, v) in map {
                if let Ok(id) = id.parse::<u32>() {
                    views.insert(
                        id,
                        ViewState {
                            dirty: v["dirty"].as_bool().unwrap_or(false),
                            pending: v["pending"].as_f64().unwrap_or(0.0),
                            memo: v["memo"].as_bool().unwrap_or(false),
                            destroyed: v["destroyed"].as_bool().unwrap_or(false),
                            query_fails: v["queryFails"].as_bool().unwrap_or(false),
                        },
                    );
                }
            }
        }
        World {
            case: case.clone(),
            log,
            muted: false,
            events: None,
            next_view: 100,
            next_window: case["firstWindow"].as_u64().unwrap_or(2) as u32,
            next_uuid: 1,
            views,
            kinds: HashMap::new(),
            windows,
            close_answers: queue("closeAnswers"),
            menus: queue("menus"),
            app_labels: Vec::new(),
            suggested: HashSet::new(),
            shell: ShellWindow {
                window: WindowId(window),
                view: ViewId(view),
            },
        }
    }

    fn log(&self, line: Vec<Value>) {
        if !self.muted {
            self.log.lock().unwrap().push(Value::Array(line));
        }
    }

    fn view(&mut self, id: u32) -> &mut ViewState {
        self.views.entry(id).or_default()
    }

    fn send(&self, event: HostEvent) {
        if let Some(events) = &self.events {
            events.send(event);
        }
    }

    fn make_view(&mut self) -> ViewId {
        let id = self.next_view;
        self.next_view += 1;
        ViewId(id)
    }

    fn label_of(&self, window: Option<WindowId>) -> Value {
        match window {
            Some(w) if w == self.shell.window => Value::from("shell"),
            Some(w) => Value::from(format!("window:{}", w.0)),
            None => Value::Null,
        }
    }

    fn string(&self, key: &str) -> String {
        self.case["strings"][key].as_str().unwrap_or(key).to_owned()
    }
}

/// The world, behind the traits
#[derive(Clone)]
struct Fake(Arc<Mutex<World>>);

impl Fake {
    fn w(&self) -> MutexGuard<'_, World> {
        self.0.lock().unwrap()
    }
}

/// The log line of a popup entry as `Menu.buildFromTemplate` sees it: absent
/// and default fields left out (world.ts writes it the same way)
fn entry_json(e: &MenuEntry) -> Value {
    let mut map = Map::new();
    match e.kind {
        MenuEntryKind::Separator => {
            map.insert("type".into(), json!("separator"));
        }
        MenuEntryKind::Checkbox => {
            map.insert("label".into(), json!(e.label));
            map.insert("type".into(), json!("checkbox"));
        }
        MenuEntryKind::Header => {
            map.insert("label".into(), json!(e.label));
            map.insert("type".into(), json!("header"));
        }
        MenuEntryKind::Normal => {
            map.insert("label".into(), json!(e.label));
        }
    }
    if !e.enabled {
        map.insert("enabled".into(), json!(false));
    }
    if e.checked {
        map.insert("checked".into(), json!(true));
    }
    if let Some(icon) = e.icon {
        map.insert("icon".into(), json!(icon));
    }
    if !e.submenu.is_empty() {
        map.insert(
            "submenu".into(),
            Value::Array(e.submenu.iter().map(entry_json).collect()),
        );
    }
    Value::Object(map)
}

/// The entry with this label, depth first
fn pick(entries: &[MenuEntry], label: &str) -> Option<u32> {
    for e in entries {
        if e.kind != MenuEntryKind::Separator && e.label == label {
            return Some(e.id);
        }
        if let Some(id) = pick(&e.submenu, label) {
            return Some(id);
        }
    }
    None
}

impl WindowsHost for Fake {
    fn attach(&self, events: Arc<dyn HostEvents>) {
        self.w().events = Some(events);
    }

    fn shell_window(&self) -> Option<ShellWindow> {
        let w = self.w();
        (w.case["noShell"].as_bool() != Some(true)).then_some(w.shell)
    }

    fn create_shell_window(&self) -> ShellWindow {
        self.w().shell
    }

    fn window_state(&self, window: WindowId) -> WindowState {
        let w = self.w();
        match w.windows.get(&window.0) {
            Some(s) => WindowState {
                destroyed: s.destroyed,
                minimized: s.minimized,
                focused: s.focused,
                visible: true,
                content_bounds: s.bounds,
                position: s.position,
                title: s.title.clone(),
            },
            None => WindowState {
                destroyed: true,
                minimized: false,
                focused: false,
                visible: false,
                content_bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0,
                },
                position: (0.0, 0.0),
                title: String::new(),
            },
        }
    }

    fn create_window(&self, options: &WindowOptions) -> WindowId {
        let mut w = self.w();
        let id = w.next_window;
        w.next_window += 1;
        let mut opts = Map::new();
        opts.insert("width".into(), json!(options.width));
        opts.insert("height".into(), json!(options.height));
        if let Some((x, y)) = options.origin {
            opts.insert("x".into(), json!(x));
            opts.insert("y".into(), json!(y));
        }
        opts.insert("minWidth".into(), json!(options.min_width));
        opts.insert("minHeight".into(), json!(options.min_height));
        opts.insert("title".into(), json!(options.title));
        opts.insert("show".into(), json!(options.show));
        opts.insert("autoHideMenuBar".into(), json!(options.auto_hide_menu_bar));
        w.log(vec![json!("newBrowserWindow"), Value::Object(opts)]);
        w.windows.insert(
            id,
            WinState {
                destroyed: false,
                minimized: false,
                focused: false,
                bounds: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: options.width,
                    height: options.height,
                },
                position: options.origin.unwrap_or((0.0, 0.0)),
                title: options.title.clone(),
            },
        );
        WindowId(id)
    }

    fn window_restore(&self, window: WindowId) {
        self.w()
            .log(vec![json!("win"), json!(window.0), json!("restore")]);
    }
    fn window_show(&self, window: WindowId) {
        self.w()
            .log(vec![json!("win"), json!(window.0), json!("show")]);
    }
    fn window_show_inactive(&self, window: WindowId) {
        self.w()
            .log(vec![json!("win"), json!(window.0), json!("showInactive")]);
    }
    fn window_focus(&self, window: WindowId) {
        self.w()
            .log(vec![json!("win"), json!(window.0), json!("focus")]);
    }
    fn window_destroy(&self, window: WindowId) {
        let mut w = self.w();
        w.log(vec![json!("win"), json!(window.0), json!("destroy")]);
        if let Some(s) = w.windows.get_mut(&window.0) {
            s.destroyed = true;
        }
        w.send(HostEvent::Window(window, WindowEvent::Closed));
    }
    fn window_set_title(&self, window: WindowId, title: &str) {
        let mut w = self.w();
        w.log(vec![
            json!("win"),
            json!(window.0),
            json!("setTitle"),
            json!(title),
        ]);
        if let Some(s) = w.windows.get_mut(&window.0) {
            s.title = title.to_owned();
        }
    }
    fn window_set_position(&self, window: WindowId, x: f64, y: f64) {
        let mut w = self.w();
        w.log(vec![
            json!("win"),
            json!(window.0),
            json!("setPosition"),
            json!(x),
            json!(y),
        ]);
        if let Some(s) = w.windows.get_mut(&window.0) {
            s.position = (x, y);
        }
        w.send(HostEvent::Window(window, WindowEvent::Move));
    }
    fn window_set_frame(&self, window: WindowId, frame: &Rect) {
        let w = self.w();
        w.log(vec![
            json!("win"),
            json!(window.0),
            json!("setBounds"),
            rect_json(frame),
        ]);
        if window != w.shell.window {
            w.send(HostEvent::Window(window, WindowEvent::Move));
            w.send(HostEvent::Window(window, WindowEvent::Resize));
        }
    }
    fn window_work_area(&self, _window: WindowId) -> Rect {
        let w = self.w();
        rect_of(
            &w.case["workArea"],
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
        )
    }
    fn add_child_view(&self, window: WindowId, view: ViewId) {
        self.w().log(vec![
            json!("win"),
            json!(window.0),
            json!("addChildView"),
            json!(view.0),
        ]);
    }
    fn remove_child_view(&self, window: WindowId, view: ViewId) {
        self.w().log(vec![
            json!("win"),
            json!(window.0),
            json!("removeChildView"),
            json!(view.0),
        ]);
    }

    fn view_destroyed(&self, view: ViewId) -> bool {
        self.w().view(view.0).destroyed
    }
    fn view_set_visible(&self, view: ViewId, visible: bool) {
        self.w()
            .log(vec![json!("setVisible"), json!(view.0), json!(visible)]);
    }
    fn view_set_bounds(&self, view: ViewId, bounds: &Rect) {
        self.w()
            .log(vec![json!("setBounds"), json!(view.0), rect_json(bounds)]);
    }
    fn view_focus(&self, view: ViewId) {
        self.w()
            .log(vec![json!("webContents.focus"), json!(view.0)]);
    }
    fn view_close(&self, view: ViewId) {
        self.w().log(vec![json!("close"), json!(view.0)]);
    }
    fn view_reload(&self, view: ViewId) {
        self.w().log(vec![json!("reload"), json!(view.0)]);
    }
    fn view_load_url(&self, view: ViewId, url: &str) {
        self.w()
            .log(vec![json!("loadURL"), json!(view.0), json!(url)]);
    }
    fn view_listen(&self, view: ViewId, listen: ViewListen) {
        let w = self.w();
        let (how, events): (&str, &[&str]) = match listen {
            ViewListen::HtmlFullScreen => {
                ("on", &["enter-html-full-screen", "leave-html-full-screen"])
            }
            ViewListen::PaneFocus => ("on", &["focus"]),
            ViewListen::RenderProcessGone => ("once", &["render-process-gone"]),
        };
        for event in events {
            w.log(vec![json!(how), json!(view.0), json!(event)]);
        }
    }
    fn watch_page_load(&self, view: ViewId, _token: u64) {
        let w = self.w();
        for event in ["did-finish-load", "destroyed"] {
            w.log(vec![json!("once"), json!(view.0), json!(event)]);
        }
    }
    fn create_help_view(&self) -> ViewId {
        let mut w = self.w();
        let view = w.make_view();
        w.log(vec![
            json!("newWebContentsView"),
            json!(view.0),
            json!({
                "contextIsolation": true,
                "nodeIntegration": false,
                "sandbox": true,
                "backgroundThrottling": false
            }),
        ]);
        w.log(vec![json!("setWindowOpenHandler"), json!(view.0)]);
        view
    }

    fn cursor_point(&self) -> (f64, f64) {
        let w = self.w();
        (
            w.case["cursor"]["x"].as_f64().unwrap_or(0.0),
            w.case["cursor"]["y"].as_f64().unwrap_or(0.0),
        )
    }
    fn display_work_area(&self, _at: (f64, f64)) -> Rect {
        self.window_work_area(WindowId(0))
    }

    fn set_timer(&self, _key: TimerKey, delay_ms: f64) {
        let w = self.w();
        if delay_ms == 0.0 {
            w.log(vec![json!("setImmediate")]);
        } else {
            w.log(vec![json!("setTimeout"), json!(delay_ms)]);
        }
    }
    fn clear_timer(&self, _key: TimerKey) {
        self.w().log(vec![json!("clearTimeout")]);
    }

    fn popup_menu(
        &self,
        window: WindowId,
        entries: &[MenuEntry],
        at: Option<(f64, f64)>,
        token: u64,
    ) {
        let mut w = self.w();
        let mut opts = Map::new();
        opts.insert("window".into(), json!(window.0));
        if let Some((x, y)) = at {
            opts.insert("x".into(), json!(x));
            opts.insert("y".into(), json!(y));
        }
        w.log(vec![
            json!("menu.popup"),
            Value::Object(opts),
            Value::Array(entries.iter().map(entry_json).collect()),
        ]);
        let chosen = w
            .menus
            .pop_front()
            .and_then(|label| label.as_str().and_then(|l| pick(entries, l)));
        w.send(HostEvent::Menu { token, chosen });
    }
}

// ---- the hooks ----

/// `createDocsView`, ... the TypeScript name and arguments of a view spec
fn create_call(spec: &ViewSpec<'_>) -> (&'static str, Vec<Value>, TabKind) {
    match spec {
        ViewSpec::Docs { path } => ("createDocsView", vec![opt_str(*path)], TabKind::Docs),
        ViewSpec::Sheets { opening_workbook } => {
            let mut opts = Map::new();
            opts.insert("includeAiHandlers".into(), Value::Bool(false));
            if let Some(opening) = opening_workbook {
                opts.insert("openingWorkbook".into(), Value::Bool(*opening));
            }
            (
                "createSheetsView",
                vec![Value::Object(opts)],
                TabKind::Sheets,
            )
        }
        ViewSpec::Slides { path } => ("createSlidesView", vec![opt_str(*path)], TabKind::Slides),
        ViewSpec::Pdf { path } => ("createPdfView", vec![Value::from(*path)], TabKind::Pdf),
        ViewSpec::Markdown { path } => (
            "createMarkdownView",
            vec![opt_str(*path)],
            TabKind::Markdown,
        ),
        ViewSpec::Html { path } => ("createHtmlView", vec![opt_str(*path)], TabKind::Html),
        ViewSpec::HtmlPresent { owner, title } => (
            "createHtmlPresentView",
            vec![Value::from(*owner), Value::from(*title)],
            TabKind::Html,
        ),
        ViewSpec::Mindmap { path } => ("createMindmapView", vec![opt_str(*path)], TabKind::Mindmap),
        ViewSpec::Epub { path } => ("createEpubView", vec![Value::from(*path)], TabKind::Epub),
        ViewSpec::Diagram { path } => ("createDiagramView", vec![opt_str(*path)], TabKind::Diagram),
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
                TabKind::Hwp,
            )
        }
    }
}

struct Hooks(Fake);

impl Hooks {
    fn log(&self, name: &str, args: Vec<Value>) {
        let mut line = vec![Value::from(name)];
        line.extend(args);
        self.0.w().log(line);
    }
}

impl TabHooks for Hooks {
    fn create_view(&self, spec: &ViewSpec<'_>) -> TabResult<ViewId> {
        let (name, args, kind) = create_call(spec);
        let mut w = self.0.w();
        let mut line = vec![Value::from(name)];
        line.extend(args);
        w.log(line);
        let fails = w.case["fail"]
            .as_array()
            .is_some_and(|f| f.iter().any(|n| n.as_str() == Some(name)));
        if fails {
            return Err(TabError("create failed".to_owned()));
        }
        let view = w.make_view();
        w.kinds.insert(view.0, kind);
        Ok(view)
    }
    fn sheets_pending_edit_count(&self, wc_id: i64) -> f64 {
        self.log("sheetsPendingEditCount", vec![json!(wc_id)]);
        self.0.w().view(wc_id as u32).pending
    }
    fn family_is_dirty(&self, kind: TabKind, wc_id: i64) -> bool {
        self.log("isDirty", vec![json!(kind.as_str()), json!(wc_id)]);
        self.0.w().view(wc_id as u32).dirty
    }
    fn hwp_memo_modal_open(&self, wc_id: i64) -> bool {
        self.log("hwpMemoModalOpen", vec![json!(wc_id)]);
        self.0.w().view(wc_id as u32).memo
    }
    fn docs_query_dirty(&self, view: ViewId, then: Then<bool>) {
        self.log("docsQueryDirty", vec![json!(view.0)]);
        let answer = {
            let mut w = self.0.w();
            let state = w.view(view.0);
            if state.query_fails {
                Err(IpcError {
                    name: Some("Error".into()),
                    message: "query failed".into(),
                })
            } else {
                Ok(state.dirty)
            }
        };
        then(answer);
    }
    fn set_active_docs_resolver(&self, view: Option<ViewId>, null_if_destroyed: bool) {
        let id = match view {
            Some(v) if !(null_if_destroyed && self.0.w().view(v.0).destroyed) => json!(v.0),
            _ => Value::Null,
        };
        self.log("setActiveDocsResolver", vec![id]);
    }
    fn set_active_sheets_web_contents(&self, view: Option<ViewId>) {
        self.log(
            "setActiveSheetsWebContents",
            vec![view.map_or(Value::Null, |v| json!(v.0))],
        );
    }
    fn set_active_slides_web_contents(&self, view: ViewId) {
        self.log("setActiveSlidesWebContents", vec![json!(view.0)]);
    }
    fn apply_menu_for(&self, _kind: TabKind) {}
    fn teardown_docs_renderer(&self, view: ViewId) {
        self.log("teardownDocsRenderer", vec![json!(view.0)]);
    }
    fn release_closed_renderer(&self, view: ViewId) {
        self.log("releaseClosedRenderer", vec![json!(view.0)]);
    }
    fn mark_docs_new_blank(&self, wc_id: i64) {
        self.log("markDocsNewBlank", vec![json!(wc_id)]);
    }
    fn queue_docs_ai_content(&self, wc_id: i64, content: &Value) {
        self.log("queueDocsAiContent", vec![json!(wc_id), content.clone()]);
    }
    fn queue_docs_copy(&self, wc_id: i64, path: &str, name: &str) {
        self.log(
            "queueDocsCopy",
            vec![json!(wc_id), json!(path), json!(name)],
        );
    }
    fn set_sheets_new_blank(&self) {
        self.log("setSheetsNewBlank", vec![]);
    }
    fn queue_workbook_for_view(&self, view: ViewId, path: &str) {
        self.log("queueWorkbookForView", vec![json!(view.0), json!(path)]);
    }
    fn nudge_queued_workbook(&self, view: ViewId) {
        self.log("nudgeQueuedWorkbook", vec![json!(view.0)]);
    }
    fn mark_pdf_untitled_copy(&self, path: &str) {
        self.log("markPdfUntitledCopy", vec![json!(path)]);
    }
    fn clear_pdf_dirty(&self, wc_id: i64) {
        self.log("clearPdfDirty", vec![json!(wc_id)]);
    }
    fn queue_markdown_seed_for(&self, view: ViewId, text: &str) {
        self.log("queueMarkdownSeedFor", vec![json!(view.0), json!(text)]);
    }
    fn queue_html_seed_for(&self, view: ViewId, text: &str) {
        self.log("queueHtmlSeedFor", vec![json!(view.0), json!(text)]);
    }
    fn queue_mindmap_seed_for(&self, view: ViewId, bytes: &[u8]) {
        self.log(
            "queueMindmapSeedFor",
            vec![json!(view.0), json!(hex(bytes))],
        );
    }
    fn queue_slides_seed_for(&self, view: ViewId, bytes: &[u8], suggested_name: &str) {
        self.log(
            "queueSlidesSeedFor",
            vec![
                json!(view.0),
                json!(hex(bytes)),
                json!({ "askPathOnFirstSave": true, "suggestedName": suggested_name }),
            ],
        );
    }
    fn queue_generate_handoff_for(&self, view: ViewId, handoff: &Value) {
        self.log(
            "queueGenerateHandoffFor",
            vec![json!(view.0), handoff.clone()],
        );
    }
    fn queue_converted_content(&self, view: ViewId, doc: &Value) {
        self.log("queueConvertedContent", vec![json!(view.0), doc.clone()]);
    }
    fn drop_generate_handoff(&self, wc_id: i64) {
        self.log("dropGenerateHandoff", vec![json!(wc_id)]);
    }
    fn diagram_tab_identity(&self, wc_id: i64) -> Option<DiagramIdentity> {
        self.log("diagramTabIdentity", vec![json!(wc_id)]);
        None
    }
    fn opener_open(
        &self,
        _opener: &Opener,
        _context: &UnloadedTabOpenContext,
    ) -> Result<LoadedTabView<ViewId>, String> {
        Err("no opener in the probe".to_owned())
    }
    fn reset_sheets_shutting_down(&self) {
        self.log("resetSheetsShuttingDown", vec![]);
    }
    fn cancel_update_restart(&self) {
        self.log("cancelUpdateRestart", vec![]);
    }
    fn resume_discarded_copies(&self) {
        self.log("resumeDiscardedCopies", vec![]);
    }
    fn pdf_close_cancelled(&self, view: ViewId) {
        self.log("pdfCloseCancelled", vec![json!(view.0)]);
    }

    fn ui_scale(&self) -> f64 {
        self.0.w().case["shell"]["scale"].as_f64().unwrap_or(1.0)
    }
    fn no_spare_view_env(&self) -> bool {
        false
    }
    fn renderer_dev_url(&self) -> Option<String> {
        None
    }
    fn tm(&self, key: &str) -> String {
        self.0.w().string(key)
    }
    fn tm_params(&self, key: &str, params: &[(&str, &str)]) -> String {
        let mut text = self.0.w().string(key);
        for (name, value) in params {
            text = text.replace(&format!("{{{name}}}"), value);
        }
        text
    }
    fn random_uuid(&self) -> String {
        let mut w = self.0.w();
        let n = w.next_uuid;
        w.next_uuid += 1;
        format!("00000000-0000-4000-8000-{n:012}")
    }
    fn warn(&self, message: &str, error: &str) {
        self.log("console", vec![json!(message), json!(error)]);
    }

    fn tabs_changed(&self, _changed: &TabsChanged) {}
    fn split_changed(&self, _state: Option<&SplitViewState>) {}
    fn detached_changed(&self) {}

    fn app_menu_popup(&self) -> Option<Vec<MenuEntry>> {
        let mut w = self.0.w();
        let menu = w.case["appMenu"].as_array()?.clone();
        w.app_labels.clear();
        let mut labels = Vec::new();
        fn build(items: &[Value], top: bool, labels: &mut Vec<String>) -> Vec<MenuEntry> {
            items
                .iter()
                .map(|item| {
                    let id = labels.len() as u32;
                    let label = item["label"].as_str().unwrap_or("").to_owned();
                    labels.push(label.clone());
                    let separator = item["type"].as_str() == Some("separator");
                    let sub = item["submenu"].as_array();
                    let submenu = sub.map(|s| build(s, false, labels)).unwrap_or_default();
                    MenuEntry {
                        id,
                        kind: if separator {
                            MenuEntryKind::Separator
                        } else {
                            MenuEntryKind::Normal
                        },
                        label,
                        // a menu that has a submenu is listed by its label alone
                        enabled: if top && sub.is_some() {
                            true
                        } else {
                            item["enabled"].as_bool().unwrap_or(true)
                        },
                        checked: false,
                        icon: None,
                        submenu,
                    }
                })
                .collect()
        }
        let mut entries = build(&menu, true, &mut labels);
        let id = labels.len() as u32;
        labels.push(String::new());
        entries.push(MenuEntry {
            id,
            kind: MenuEntryKind::Separator,
            label: String::new(),
            enabled: true,
            checked: false,
            icon: None,
            submenu: Vec::new(),
        });
        let id = labels.len() as u32;
        let check = w.string("menuCheckUpdates");
        labels.push(check.clone());
        entries.push(MenuEntry {
            id,
            kind: MenuEntryKind::Normal,
            label: check,
            enabled: true,
            checked: false,
            icon: None,
            submenu: Vec::new(),
        });
        w.app_labels = labels;
        Some(entries)
    }
    fn app_menu_activate(&self, id: u32) {
        let label = self.0.w().app_labels.get(id as usize).cloned();
        if let Some(label) = label {
            self.log("appMenu.click", vec![json!(label)]);
        }
    }
    fn visible_home_kinds(&self) -> Vec<String> {
        self.0.w().case["homeKinds"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|k| k.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn drive_reopen(&self, _path: &str) -> bool {
        false
    }
    fn record_recent_file(&self, path: &str) {
        self.log("recordRecentFile", vec![json!(path)]);
    }
    fn notify_unsupported_file(&self, path: &str) {
        let ext = std::path::Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let ext = if ext.is_empty() {
            path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned()
        } else {
            ext
        };
        let message = self.tm_params("errUnsupportedExt", &[("ext", &ext)]);
        self.show_app_warning(&message, None);
    }
    fn show_app_warning(&self, message: &str, detail: Option<&str>) {
        let w = self.0.w();
        let shell = w.shell.window.0;
        let mut options = Map::new();
        options.insert("type".into(), json!("warning"));
        options.insert("message".into(), json!(message));
        if let Some(detail) = detail.filter(|d| !d.is_empty()) {
            options.insert("detail".into(), json!(detail));
        }
        w.log(vec![json!("win"), json!(shell), json!("show")]);
        w.log(vec![json!("win"), json!(shell), json!("focus")]);
        w.log(vec![
            json!("dialog.showMessageBox"),
            json!(shell),
            Value::Object(options),
        ]);
    }
    fn diagram_open_refusal(&self, path: &str) -> Option<String> {
        let w = self.0.w();
        let refused = w.case["refuse"].as_array()?;
        let hit = refused.iter().find(|r| r["path"].as_str() == Some(path))?;
        hit["reason"].as_str().map(str::to_owned)
    }
    fn start_queued_workbook_nudge(&self) {}
    fn default_save_dir(&self) -> String {
        self.0.w().case["defaultSaveDir"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    }
    fn blank_xlsx(&self) -> Vec<u8> {
        unhex(self.0.w().case["blankXlsx"].as_str().unwrap_or(""))
    }
    fn blank_pdf(&self) -> Vec<u8> {
        unhex(self.0.w().case["blankPdf"].as_str().unwrap_or(""))
    }
    fn unique_path_in(&self, dir: &str, name: &str) -> String {
        // docs-main's `uniquePathIn`
        let dot = name.rfind('.').filter(|i| *i > 0);
        let (base, ext) = match dot {
            Some(i) => (&name[..i], &name[i..]),
            None => (name, ""),
        };
        let mut candidate = format!("{dir}/{name}");
        let mut i = 2;
        while std::path::Path::new(&candidate).exists() {
            candidate = format!("{dir}/{base}-{i}{ext}");
            i += 1;
        }
        candidate
    }
    fn sheets_suggested_path_taken(&self, path: &str) -> bool {
        self.0.w().suggested.contains(path)
    }
    fn mark_sheets_unsaved_new(&self, _backing: &str, suggested: &str, _temp_dir: &str) {
        self.0.w().suggested.insert(suggested.to_owned());
    }
    fn unmark_sheets_unsaved_new(&self, _backing: &str) {}
    fn mark_sheets_untitled_path(&self, _path: &str) {}
    fn mark_pdf_untitled_path(&self, _path: &str) {}
    fn show_error_dialog(&self, title: &str, error: &str) {
        self.log("showErrorDialog", vec![json!(title), json!(error)]);
    }
    fn open_agent_window(&self) {
        self.log("openAgentWindow", vec![]);
    }
    fn drop_skill_file(&self, _path: &str) -> bool {
        false
    }
    fn drop_no_skills_found(&self) {}
    fn is_inside_root(&self, root: &str, path: &str) -> bool {
        path == root || path.starts_with(&format!("{root}/"))
    }
    fn open_file_via_dialog(&self) {
        self.log("openFileViaDialog", vec![]);
    }
    fn tab_document_action(
        &self,
        kind: TabKind,
        view: ViewId,
        tab_id: &str,
        file_path: Option<&str>,
        action: DocAction,
    ) {
        self.log(
            "tabDocumentAction",
            vec![
                json!(kind.as_str()),
                json!(view.0),
                json!(tab_id),
                opt_str(file_path),
                json!(format!("{action:?}")),
            ],
        );
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The editors of the world: every view made by a `create*View` call
struct Editors(Fake);

impl DocumentEditors for Editors {
    fn owns(&self, view: ViewId) -> bool {
        self.0.w().kinds.contains_key(&view.0)
    }
    fn request_save(&self, _view: ViewId, _mode: SaveMode, then: Then<bool>) {
        then(Ok(true))
    }
    fn request_close(&self, view: ViewId, parent: Option<WindowId>, then: Then<bool>) {
        let answer = {
            let mut w = self.0.w();
            let kind = w.kinds.get(&view.0).map_or("docs", |k| k.as_str());
            let label = w.label_of(parent);
            w.log(vec![
                json!("requestClose"),
                json!(kind),
                json!(view.0),
                label,
            ]);
            w.close_answers.pop_front()
        };
        match answer {
            Some(Value::String(s)) if s == "throws" => then(Err(IpcError {
                name: Some("Error".into()),
                message: "prompt failed".into(),
            })),
            Some(Value::Bool(b)) => then(Ok(b)),
            _ => then(Ok(true)),
        }
    }
    fn read_text(&self, _view: ViewId, then: Then<String>) {
        then(Ok(String::new()))
    }
    fn save_to_path(&self, _view: ViewId, _path: std::path::PathBuf, then: Then<()>) {
        then(Ok(()))
    }
    fn file_renamed(&self, _view: ViewId, _old: &std::path::Path, _new: &std::path::Path) {}
    fn export_request(&self, _view: ViewId, _format: &str) {}
    fn document_path(&self, _view: ViewId) -> Option<std::path::PathBuf> {
        None
    }
}

/// What `probe_hosts` leaves for `register`: the world of this case
struct WorldBox(Fake);

/// Inserts the world as the batch's [`WindowsHost`], answering from `case`
pub fn probe_hosts(hosts: &mut Hosts, case: &Value) {
    let log = hosts.get::<ProbeLog>().cloned().unwrap_or_default();
    let fake = Fake(Arc::new(Mutex::new(World::new(case, log))));
    let windows: WindowsHostRef = Arc::new(fake.clone());
    hosts.insert(windows);
    hosts.insert(Arc::new(WorldBox(fake)));
}

/// What `register` adds for the shell: the hooks and the editors of the world
pub(super) fn provide_hooks(provided: &Rc<Provided>, services: &Services) {
    if !provided.all::<dyn TabHooks>().is_empty() {
        return;
    }
    let Some(world) = services.hosts.get::<Arc<WorldBox>>() else {
        return;
    };
    provided.add::<dyn TabHooks>(Rc::new(Hooks(world.0.clone())));
    provided.add::<dyn DocumentEditors>(Rc::new(Editors(world.0.clone())));
}
