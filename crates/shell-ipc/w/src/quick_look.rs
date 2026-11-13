//! Quick Look (`apps/shell/src/main/quick-look/quick-look-window.ts`, wired in
//! `apps/shell/src/main/index.ts` `configureQuickLookWindow`): the home-side
//! preview and settings, and the preview window's own channels.
//!
//! The preview window is the shell's (`QuickLookWindow`); what decides when it
//! opens, which file it shows and when it hides is here ([`QuickLookControl`]).
//! The Windows Explorer hook and the tray are the shell's too
//! (`QuickLookRuntime`): the hook reports a space, a navigation or an escape
//! to the control, from its own thread, and each of those reads the file on a
//! worker, so the state lives behind a mutex rather than on the core thread.
//! Nothing here holds the mutex while it waits for a renderer.

#[cfg(feature = "probe")]
mod probe;

use std::rc::Rc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::time::Duration;

use jscompat::node_path::host::resolve;
use jscompat::{JsObject, JsonValue, trim};
use main_core::packages::i18n::{Lang, product_name};
use main_core::shell::app_settings::{read_app_settings, write_app_setting};
use main_core::shell::quick_look::{
    DocBlock, MindmapSheet, QuickLookCache, QuickLookEngines, QuickLookPayload, Sheet, Slide,
    extract_quick_look, is_quick_look_supported_path,
};
use shell_contract::hosts::{ContentsHost, OsShellHost};
use shell_contract::ids::ViewId;
use shell_contract::ipc::{
    CallContext, ChannelKind, EventSink, Handler, RegisterError, Registry, Responder, Target,
};
use shell_contract::runtime::{PathName, Services, Workers};
use shell_contract::{Batch, IpcValue};

use crate::convert::{field, node_error};
use crate::handle;

/// What the Windows Explorer hook and the tray do (`syncQuickLookRuntime`);
/// there is neither on macOS
pub trait QuickLookRuntime: Send + Sync {
    /// Given once at start: the control the hook reports to
    fn attach(&self, control: QuickLookControl);
    /// Whether the Explorer hook exists here (`process.platform === 'win32'`)
    fn windows_explorer(&self) -> bool;
    /// Enable or disable the hook, create or drop the tray, for these settings
    fn sync(&self, settings: &QuickLookSettings);
    /// The tray's menu follows the language (`syncTrayMenu`)
    fn refresh_tray(&self);
    /// `explorerHook.stop()` and the tray's `destroy()`
    fn stop(&self);
}

pub type QuickLookHost = Arc<dyn QuickLookRuntime>;

/// What `new BrowserWindow(...)` of the preview is given (the shell adds the
/// preload and the sandbox)
#[derive(Clone, Debug, PartialEq)]
pub struct QuickLookWindowOptions {
    pub width: u32,
    pub height: u32,
    pub min_width: u32,
    pub min_height: u32,
    pub show: bool,
    pub center: bool,
    pub frame: bool,
    pub transparent: bool,
    pub background_color: &'static str,
    pub has_shadow: bool,
    pub always_on_top: bool,
    pub minimizable: bool,
    pub maximizable: bool,
    pub fullscreenable: bool,
    pub auto_hide_menu_bar: bool,
    pub title: String,
}

impl QuickLookWindowOptions {
    fn titled(title: String) -> Self {
        QuickLookWindowOptions {
            width: 812,
            height: 652,
            min_width: 500,
            min_height: 400,
            show: false,
            center: true,
            frame: false,
            transparent: true,
            background_color: "#00000000",
            has_shadow: false,
            always_on_top: true,
            minimizable: false,
            maximizable: true,
            fullscreenable: false,
            auto_hide_menu_bar: true,
            title,
        }
    }
}

/// The preview window (a `BrowserWindow` loading `quick-look.html`) and the
/// answers the app gives it (`QuickLookWindowDeps`). Its calls come from any
/// thread; the shell runs them on the UI thread. It reports `ready-to-show`
/// and a closed window to the control it was given.
pub trait QuickLookWindow: Send + Sync {
    /// Given once at start
    fn attach(&self, control: QuickLookControl);
    /// `deps.lang()`
    fn lang(&self) -> Lang;
    /// `deps.theme()`: `light`, `dark` or `system`
    fn theme(&self) -> String;
    /// Creates the window hidden, as `showQuickLookWindowForPath` does, and
    /// loads the page; its view
    fn create(&self, options: &QuickLookWindowOptions) -> ViewId;
    fn is_visible(&self) -> bool;
    fn set_title(&self, title: &str);
    fn show_inactive(&self);
    fn hide(&self);
    fn destroy(&self);
    /// `deps.openInEditor(filePath)`
    fn open_in_editor(&self, path: &str);
}

pub type QuickLookWindowHost = Arc<dyn QuickLookWindow>;

/// What the preview reads a file with (`parseFileToText`, the zip gate)
pub type QuickLookEnginesHost = Arc<dyn QuickLookEngines + Send + Sync>;

/// `notifyQuickLookLangOrThemeChanged`: what the language and theme setters
/// call (the home settings' `home:set-language`, `home:set-theme`). Found with
/// `registry.provided().all::<dyn QuickLookNotify>()`.
pub trait QuickLookNotify {
    fn lang_or_theme_changed(&self);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuickLookSettings {
    pub explorer_space_preview: bool,
    pub keep_in_tray: bool,
}

/// `DEFAULT_QUICK_LOOK_SETTINGS`
const DEFAULT: QuickLookSettings = QuickLookSettings {
    explorer_space_preview: true,
    keep_in_tray: false,
};

impl QuickLookSettings {
    fn to_ipc(self) -> IpcValue {
        IpcValue::Object(vec![
            (
                "explorerSpacePreview".into(),
                IpcValue::Bool(self.explorer_space_preview),
            ),
            ("keepInTray".into(), IpcValue::Bool(self.keep_in_tray)),
        ])
    }

    fn to_json(self) -> JsonValue {
        let mut o = JsObject::default();
        o.set(
            "explorerSpacePreview",
            JsonValue::Bool(self.explorer_space_preview),
        );
        o.set("keepInTray", JsonValue::Bool(self.keep_in_tray));
        JsonValue::Object(o)
    }
}

/// `normalizeQuickLookSettings(raw)` of the saved value
fn normalize(raw: Option<&JsonValue>) -> QuickLookSettings {
    let Some(JsonValue::Object(o)) = raw else {
        return DEFAULT;
    };
    let flag = |key: &str, default: bool| match o.get(key) {
        Some(JsonValue::Bool(b)) => *b,
        _ => default,
    };
    QuickLookSettings {
        explorer_space_preview: flag("explorerSpacePreview", DEFAULT.explorer_space_preview),
        keep_in_tray: flag("keepInTray", DEFAULT.keep_in_tray),
    }
}

/// `EXIT_ANIMATION_MS`
const EXIT_ANIMATION: Duration = Duration::from_millis(155);

/// `quickLookText(lang, 'windowTitle')` (renderer/src/i18n/quick-look)
fn window_title(lang: Lang) -> &'static str {
    match lang {
        Lang::En => "Quick Look",
        Lang::Ko => "빠른 미리보기",
    }
}

#[derive(Default)]
struct State {
    /// the preview window's view; none while there is no window
    view: Option<ViewId>,
    current_path: Option<String>,
    current_payload: Option<QuickLookPayload>,
    /// the exit animation's timer is set (`hideTimer !== null`)
    hide_pending: bool,
    /// a timer that finds another generation was cleared
    hide_generation: u64,
}

/// Counts the jobs the control has handed to workers
#[derive(Default)]
struct Pending {
    jobs: Mutex<usize>,
    idle: Condvar,
}

struct Inner {
    state: Mutex<State>,
    window: QuickLookWindowHost,
    runtime: QuickLookHost,
    engines: QuickLookEnginesHost,
    os_shell: OsShellHost,
    cache: Mutex<QuickLookCache>,
    events: Arc<dyn EventSink>,
    workers: Arc<dyn Workers>,
    pending: Pending,
}

/// The preview window's state and what drives it: the Explorer hook's
/// reports, the language switch, the window's own channels. Cheap to clone;
/// callable from any thread, but not from inside a call of [`QuickLookWindow`]
/// (it holds the control's state then). Reports from the window host that
/// come from the UI thread are posted to the core thread first.
#[derive(Clone)]
pub struct QuickLookControl(Arc<Inner>);

/// `isPreviewableRegularFile(filePath)`
fn is_previewable_regular_file(file_path: &str) -> bool {
    !file_path.is_empty()
        && is_quick_look_supported_path(file_path)
        && std::fs::metadata(file_path).is_ok_and(|m| m.is_file())
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("the quick look state")
    }

    fn emit(&self, view: ViewId, channel: &'static str, args: Vec<IpcValue>) {
        self.events.emit(Target::View(view), channel, args);
    }

    fn extract(&self, path: &str) -> QuickLookPayload {
        let mut cache = self.cache.lock().expect("the quick look cache");
        extract_quick_look(self.engines.as_ref(), path, Some(&mut cache))
    }

    /// `` `${payload.name} — ${windowTitle}` ``
    fn title_of(&self, payload: &QuickLookPayload) -> String {
        format!("{} — {}", payload.name, window_title(self.window.lang()))
    }

    /// `clearHideTimer()`
    fn clear_hide_timer(state: &mut State) {
        state.hide_pending = false;
        state.hide_generation += 1;
    }

    /// `destroyQuickLookWindow()`
    fn destroy_window(&self) {
        let mut state = self.lock();
        Self::clear_hide_timer(&mut state);
        state.current_path = None;
        state.current_payload = None;
        if state.view.take().is_some() {
            self.window.destroy();
        }
    }
}

impl QuickLookControl {
    fn spawn(&self, job: impl FnOnce(&Inner) + Send + 'static) {
        struct Done(Arc<Inner>);
        impl Drop for Done {
            fn drop(&mut self) {
                *self.0.pending.jobs.lock().expect("the pending jobs") -= 1;
                self.0.pending.idle.notify_all();
            }
        }
        *self.0.pending.jobs.lock().expect("the pending jobs") += 1;
        let inner = self.0.clone();
        self.0.workers.spawn(Box::new(move || {
            let done = Done(inner);
            job(&done.0);
        }));
    }

    /// Waits until no job of the control is running (what a probe waits for
    /// before the first call)
    #[cfg(feature = "probe")]
    pub fn wait_idle(&self) {
        let mut jobs = self.0.pending.jobs.lock().expect("the pending jobs");
        while *jobs > 0 {
            jobs = self.0.pending.idle.wait(jobs).expect("the pending jobs");
        }
    }

    /// `closeQuickLookWindow()`
    fn close_window(&self) {
        let inner = &self.0;
        let mut state = inner.lock();
        Inner::clear_hide_timer(&mut state);
        state.current_path = None;
        state.current_payload = None;
        let Some(view) = state.view else {
            return;
        };
        if !inner.window.is_visible() {
            return;
        }
        inner.emit(view, "quick-look:will-hide", vec![]);
        state.hide_pending = true;
        let generation = state.hide_generation;
        drop(state);
        self.spawn(move |inner| {
            std::thread::sleep(EXIT_ANIMATION);
            let mut state = inner.lock();
            if state.hide_generation != generation || !state.hide_pending {
                return;
            }
            state.hide_pending = false;
            if state.current_path.is_none() && state.view.is_some() {
                inner.window.hide();
            }
        });
    }

    /// `showQuickLookWindowForPath(filePath)`: reads the file, then shows it
    fn show_for_path(&self, file_path: &str) {
        let resolved = resolve(&[file_path]);
        {
            let mut state = self.0.lock();
            Inner::clear_hide_timer(&mut state);
            state.current_path = Some(resolved.clone());
        }
        let payload = self.0.extract(&resolved);
        let inner = &self.0;
        let mut state = inner.lock();
        if state.current_path.as_deref() != Some(resolved.as_str()) {
            return;
        }
        state.current_payload = Some(payload.clone());
        let lang = inner.window.lang();
        if let Some(view) = state.view {
            inner.window.set_title(&inner.title_of(&payload));
            inner.emit(view, "quick-look:will-show", vec![]);
            inner.emit(view, "quick-look:payload", vec![payload_ipc(&payload)]);
            if !inner.window.is_visible() {
                inner.window.show_inactive();
            }
            return;
        }
        let title = format!(
            "{} — {} - {}",
            payload.name,
            window_title(lang),
            product_name(Some(lang.as_str()))
        );
        state.view = Some(inner.window.create(&QuickLookWindowOptions::titled(title)));
    }

    /// The Explorer hook saw a space on `raw_path` (`handleExplorerSpace`)
    pub fn explorer_space(&self, raw_path: &str) {
        let raw_path = raw_path.to_owned();
        self.spawn({
            let control = self.clone();
            move |inner| {
                let resolved = resolve(&[&raw_path]);
                if !is_previewable_regular_file(&resolved) {
                    return;
                }
                {
                    let state = inner.lock();
                    if state.view.is_some()
                        && inner.window.is_visible()
                        && !state.hide_pending
                        && state.current_path.as_deref() == Some(resolved.as_str())
                    {
                        drop(state);
                        control.close_window();
                        return;
                    }
                }
                control.show_for_path(&resolved);
            }
        });
    }

    /// The Explorer hook saw the selection move to `raw_path`
    /// (`handleExplorerNavigate`)
    pub fn explorer_navigate(&self, raw_path: &str) {
        let raw_path = raw_path.to_owned();
        self.spawn(move |inner| {
            let resolved = resolve(&[&raw_path]);
            {
                let mut state = inner.lock();
                if state.view.is_none() || !inner.window.is_visible() || state.hide_pending {
                    return;
                }
                if state.current_path.as_deref() == Some(resolved.as_str())
                    || !is_previewable_regular_file(&resolved)
                {
                    return;
                }
                state.current_path = Some(resolved.clone());
            }
            let payload = inner.extract(&resolved);
            let mut state = inner.lock();
            if state.current_path.as_deref() != Some(resolved.as_str()) {
                return;
            }
            state.current_payload = Some(payload.clone());
            if let Some(view) = state.view {
                inner.window.set_title(&inner.title_of(&payload));
                inner.emit(view, "quick-look:payload", vec![payload_ipc(&payload)]);
            }
        });
    }

    /// The Explorer hook saw an escape
    pub fn explorer_escape(&self) {
        self.spawn({
            let control = self.clone();
            move |_| control.close_window()
        });
    }

    /// The preview window's page is ready to show (`ready-to-show`)
    pub fn window_ready(&self, view: ViewId) {
        self.spawn(move |inner| {
            let state = inner.lock();
            if state.view == Some(view) && state.current_path.is_some() {
                inner.window.show_inactive();
            }
        });
    }

    /// The preview window was closed (`closed`)
    pub fn window_closed(&self, view: ViewId) {
        let mut state = self.0.lock();
        if state.view == Some(view) {
            Inner::clear_hide_timer(&mut state);
            state.view = None;
            state.current_path = None;
            state.current_payload = None;
        }
    }

    /// `syncQuickLookRuntime()` for the settings read now
    fn sync_runtime(&self, settings: &QuickLookSettings) {
        self.0.runtime.sync(settings);
        if self.0.runtime.windows_explorer() && !settings.explorer_space_preview {
            self.0.destroy_window();
        }
    }

    /// `stopQuickLookRuntime()`
    pub fn stop(&self) {
        self.0.runtime.stop();
        self.0.destroy_window();
        self.0.cache.lock().expect("the quick look cache").clear();
    }

    /// `fromQuickLookWindow(event)`
    fn is_window_view(&self, view: ViewId) -> bool {
        self.0.lock().view == Some(view)
    }
}

impl QuickLookNotify for QuickLookControl {
    fn lang_or_theme_changed(&self) {
        let inner = &self.0;
        inner.runtime.refresh_tray();
        let state = inner.lock();
        let Some(view) = state.view else {
            return;
        };
        inner.emit(
            view,
            "quick-look:lang-changed",
            vec![IpcValue::String(inner.window.lang().as_str().into())],
        );
        inner.emit(
            view,
            "quick-look:theme-changed",
            vec![IpcValue::String(inner.window.theme())],
        );
    }
}

fn text(value: &str) -> IpcValue {
    IpcValue::String(value.to_owned())
}

fn texts(values: &[String]) -> IpcValue {
    IpcValue::Array(values.iter().map(|v| text(v)).collect())
}

fn rows(values: &[Vec<String>]) -> IpcValue {
    IpcValue::Array(values.iter().map(|row| texts(row)).collect())
}

fn object(entries: Vec<(&str, IpcValue)>) -> IpcValue {
    IpcValue::Object(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    )
}

fn block_ipc(block: &DocBlock) -> IpcValue {
    let mut entries = vec![("kind", text(block.kind.as_str()))];
    if let Some(level) = block.level {
        entries.push(("level", IpcValue::Number(f64::from(level))));
    }
    if let Some(value) = &block.text {
        entries.push(("text", text(value)));
    }
    if let Some(value) = &block.rows {
        entries.push(("rows", rows(value)));
    }
    object(entries)
}

fn sheet_ipc(sheet: &Sheet) -> IpcValue {
    object(vec![
        ("name", text(&sheet.name)),
        ("rows", rows(&sheet.rows)),
        ("truncatedRows", IpcValue::Bool(sheet.truncated_rows)),
        ("truncatedCols", IpcValue::Bool(sheet.truncated_cols)),
    ])
}

fn slide_ipc(slide: &Slide) -> IpcValue {
    object(vec![
        ("number", IpcValue::Number(slide.number)),
        ("title", text(&slide.title)),
        ("bullets", texts(&slide.bullets)),
        ("notes", texts(&slide.notes)),
    ])
}

fn mindmap_ipc(sheet: &MindmapSheet) -> IpcValue {
    let nodes = sheet
        .nodes
        .iter()
        .map(|node| {
            object(vec![
                ("depth", IpcValue::Number(f64::from(node.depth))),
                ("text", text(&node.text)),
            ])
        })
        .collect();
    object(vec![
        ("title", text(&sheet.title)),
        ("nodes", IpcValue::Array(nodes)),
    ])
}

/// A `QuickLookPayload` as the renderer receives it, keys in the order
/// `extractQuickLook`'s spreads leave them
fn payload_ipc(p: &QuickLookPayload) -> IpcValue {
    let mut entries = vec![
        ("ok", IpcValue::Bool(p.ok)),
        ("path", text(&p.path)),
        ("name", text(&p.name)),
        ("ext", text(&p.ext)),
        ("family", text(p.family.as_str())),
        ("sizeBytes", IpcValue::Number(p.size_bytes)),
        ("mtimeMs", IpcValue::Number(p.mtime_ms)),
    ];
    if let Some(url) = &p.thumbnail_data_url {
        entries.push(("thumbnailDataUrl", text(url)));
    }
    if let Some(blocks) = &p.doc_blocks {
        entries.push((
            "docBlocks",
            IpcValue::Array(blocks.iter().map(block_ipc).collect()),
        ));
    }
    if let Some(sheets) = &p.sheets {
        entries.push((
            "sheets",
            IpcValue::Array(sheets.iter().map(sheet_ipc).collect()),
        ));
    }
    if let Some(slides) = &p.slides {
        entries.push((
            "slides",
            IpcValue::Array(slides.iter().map(slide_ipc).collect()),
        ));
    }
    if let Some(mindmap) = &p.mindmap {
        entries.push((
            "mindmap",
            IpcValue::Array(mindmap.iter().map(mindmap_ipc).collect()),
        ));
    }
    if let Some(value) = &p.plain_text {
        entries.push(("plainText", text(value)));
    }
    if let Some(truncated) = p.truncated {
        entries.push(("truncated", IpcValue::Bool(truncated)));
    }
    if let Some(error) = p.error {
        entries.push(("error", text(error.as_str())));
    }
    if let Some(message) = &p.error_message {
        // the key stays, undefined, where the reader gave no reason
        entries.push((
            "errorMessage",
            message.as_deref().map_or(IpcValue::Undefined, text),
        ));
    }
    object(entries)
}

/// `quick-look:home-inspect`: the file is read on a worker, the answer is
/// sent from there
struct HomeInspect {
    contents: ContentsHost,
    control: QuickLookControl,
}

impl Handler for HomeInspect {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        // `fromParentOrAnyShellWindow(event)`: the sender is in a window
        let in_window = self.contents.window_of(cx.sender.view).is_some();
        let path = match args.first() {
            Some(IpcValue::String(path)) if in_window && !trim(path).is_empty() => path.clone(),
            _ => return reply.reply(Ok(IpcValue::Null)),
        };
        self.control.spawn(move |inner| {
            reply.reply(Ok(payload_ipc(&inner.extract(&path))));
        });
    }
}

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let runtime: QuickLookHost = services.hosts.need(Batch::W)?;
    let window: QuickLookWindowHost = services.hosts.need(Batch::W)?;
    let engines: QuickLookEnginesHost = services.hosts.need(Batch::W)?;
    let os_shell: OsShellHost = services.hosts.need(Batch::W)?;
    let contents: ContentsHost = services.hosts.need(Batch::W)?;
    let settings_path = services
        .paths
        .path(PathName::UserData)
        .join("app-settings.json")
        .to_string_lossy()
        .into_owned();

    let control = QuickLookControl(Arc::new(Inner {
        state: Mutex::default(),
        window: window.clone(),
        runtime: runtime.clone(),
        engines,
        os_shell,
        cache: Mutex::default(),
        events: services.events.clone(),
        workers: services.workers.clone(),
        pending: Pending::default(),
    }));
    window.attach(control.clone());
    runtime.attach(control.clone());
    registry
        .provided()
        .add::<dyn QuickLookNotify>(Rc::new(control.clone()));
    {
        let control = control.clone();
        services
            .views
            .on_destroyed(Box::new(move |view| control.window_closed(view)));
    }

    let path = settings_path.clone();
    let read = move || normalize(read_app_settings(&path).get("quickLook"));

    registry.register(
        Batch::W,
        "quick-look:home-inspect",
        ChannelKind::Invoke,
        Rc::new(HomeInspect {
            contents,
            control: control.clone(),
        }),
    )?;

    let get = read.clone();
    handle(
        registry,
        "quick-look:get-settings",
        ChannelKind::Invoke,
        move |_, _| Ok(get().to_ipc()),
    )?;

    let sync = control.clone();
    let after = read.clone();
    handle(
        registry,
        "quick-look:set-settings",
        ChannelKind::Invoke,
        move |_, args| {
            let current = read();
            // `partial && typeof partial === 'object'`: an array passes, null does not
            let partial = args.first().filter(|p| {
                matches!(
                    p,
                    IpcValue::Object(_)
                        | IpcValue::Array(_)
                        | IpcValue::Bytes(..)
                        | IpcValue::Date(_)
                )
            });
            let flag = |key: &str, current: bool| match partial.and_then(|p| field(p, key)) {
                Some(IpcValue::Bool(b)) => *b,
                _ => current,
            };
            let next = QuickLookSettings {
                explorer_space_preview: flag(
                    "explorerSpacePreview",
                    current.explorer_space_preview,
                ),
                keep_in_tray: flag("keepInTray", current.keep_in_tray),
            };
            write_app_setting(&settings_path, "quickLook", Some(next.to_json()))
                .map_err(node_error)?;
            sync.sync_runtime(&next);
            Ok(next.to_ipc())
        },
    )?;

    let c = control.clone();
    handle(
        registry,
        "quick-look:get-init",
        ChannelKind::Invoke,
        move |cx, _| {
            if !c.is_window_view(cx.sender.view) {
                return Ok(IpcValue::Null);
            }
            let payload = c.0.lock().current_payload.as_ref().map(payload_ipc);
            Ok(object(vec![
                ("lang", text(c.0.window.lang().as_str())),
                ("theme", IpcValue::String(c.0.window.theme())),
                ("payload", payload.unwrap_or(IpcValue::Null)),
            ]))
        },
    )?;

    let c = control.clone();
    handle(
        registry,
        "quick-look:open-in-editor",
        ChannelKind::Invoke,
        move |cx, _| {
            if !c.is_window_view(cx.sender.view) {
                return Ok(IpcValue::Undefined);
            }
            let target = c.0.lock().current_path.clone();
            c.close_window();
            if let Some(target) = target.filter(|t| std::path::Path::new(t).exists()) {
                c.0.window.open_in_editor(&target);
            }
            Ok(IpcValue::Undefined)
        },
    )?;

    let c = control.clone();
    handle(
        registry,
        "quick-look:reveal-in-folder",
        ChannelKind::Invoke,
        move |cx, _| {
            if c.is_window_view(cx.sender.view) {
                let target = c.0.lock().current_path.clone();
                if let Some(target) = target.filter(|t| std::path::Path::new(t).exists()) {
                    c.0.os_shell
                        .show_item_in_folder(std::path::Path::new(&target));
                }
            }
            Ok(IpcValue::Undefined)
        },
    )?;

    let c = control.clone();
    handle(
        registry,
        "quick-look:close",
        ChannelKind::Invoke,
        move |cx, _| {
            if c.is_window_view(cx.sender.view) {
                c.close_window();
            }
            Ok(IpcValue::Undefined)
        },
    )?;

    // `configureQuickLookWindow` syncs the runtime once the handlers are in
    control.sync_runtime(&after());
    Ok(())
}

#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    probe::insert(hosts, case);
}
