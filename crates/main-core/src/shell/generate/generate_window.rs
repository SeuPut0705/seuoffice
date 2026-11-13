//! `apps/shell/src/main/generate/generate-window.ts`: the generate window
//! ("make a new document from these files"): a small separate window, a child
//! of the shell window (or of whichever window hosts the editor that opened
//! it), so it shows above editor tabs.
//!
//! One window at a time. Opening it again from another entry point starts
//! over with that entry's materials. The window never starts an AI run:
//! "make" opens a new untitled tab of the chosen kind with the request queued
//! for it and closes.
//!
//! What stays with the caller: the `ipcMain.handle` registrations (the
//! handlers call the `handle_*` methods here; [`GenerateWindow::configure`]
//! answers whether to register them), `new BrowserWindow(options)` (the
//! options are [`generate_window_options`]), the listeners on the window
//! (`ready-to-show`, `focus`, `closed`, the theme's `updated`, and the window
//! open handler, which call [`GenerateWindow::on_ready_to_show`],
//! [`GenerateWindow::on_focus`], [`GenerateWindow::on_closed`],
//! [`GenerateWindow::on_theme_updated`] and [`GenerateWindow::window_open`]),
//! the preload path, and the `GenerateHandoff` tab-id resolver
//! (`setGenerateTabIdResolver`, installed on every `configure`). The module
//! state (`deps`, `win`, `session`, `opener`, `ipcRegistered`) is a
//! [`GenerateWindow`] the caller owns, and `deps` is the [`GenerateWindowHost`].
//!
//! Promises are plain calls. A session call the TypeScript leaves floating
//! (`void session.reset(...)`, `void current.refresh()`) runs to its end
//! before the next line, so the window calls and the session's calls are not
//! interleaved as they are there.
//!
//! The shell gathers the open files and open tabs the TypeScript reads from
//! `tabManager.openDocuments()` and hands them to every call that reads them
//! as an [`OpenSnapshot`]. Two awaits wait on a renderer and are steps: an
//! editor's save command and the recheck timer of "save". A save handler
//! answers a [`WindowStep`]; the caller carries out its [`SessionNeed`] and
//! calls [`GenerateWindow::resume_save`] with the answer. The window keeps
//! every session in a table until its last pending save has ended, because
//! the TypeScript session an in-flight call belongs to goes on after the
//! window moved to another one.

use serde::Serialize;
use serde_json::{Value, json};

use super::convert::{ConvertResult, ConvertedDocument};
use super::generate_api::{AiTargetKind, ConvertKind, GenerateWindowState, SaveAction, channels};
use super::materials::{InspectHost, MaterialLengthCache, inspect_material};
use super::materials::{MaterialStatus, supported_material_exts};
use super::open_materials::{
    OpenMaterialsDeps, OpenSnapshot, SaveAnswer, SaveMaterialRun, SaveMaterialStep, SaveOutcome,
    path_of_untitled, save_action_for, save_material_begin, show_untitled,
};
use super::session::{
    GenerateSession, GenerateSessionHost, MaterialRef, SaveRun, SaveStep, SessionAnswer,
    SessionNeed,
};
use super::title_bar::generate_title_bar_overlay;
use crate::packages::electron_utils::generate_handoff::GenerateHandoff;
use crate::packages::electron_utils::safe_external_url::safe_external_url;
use crate::packages::i18n::{Lang, product_name};
use crate::shell::renderer_disposal::Failure;
use crate::shell::title_bar_overlay::TitleBarOverlay;

/// `NewDocumentOpener` of `apps/shell/src/main/projects/new-documents.ts`:
/// where the window was opened from (home or an editor window)
#[derive(Debug, Clone, PartialEq)]
pub enum NewDocumentOpener {
    Home,
    Window { web_contents_id: f64 },
}

/// a window the host made, named by the host
pub type WindowId = i64;

/// the renderer strings (`generateText(lang, key)`) this module asks for
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerateText {
    WindowTitle,
    DialogAddTitle,
    FilterSupported,
    Untitled,
}

/// what `dialog.showOpenDialog` answers
#[derive(Debug, Clone, PartialEq)]
pub struct OpenDialogResult {
    pub canceled: bool,
    pub file_paths: Vec<Value>,
}

/// `GenerateWindowDeps` and the Electron objects the module calls. Every
/// window is a [`WindowId`] the host made.
pub trait GenerateWindowHost: OpenMaterialsDeps + InspectHost {
    // ---- deps ----
    /// the window the generate window sits above when the caller names none
    fn parent_window(&mut self) -> Option<WindowId>;
    fn lang(&self) -> Lang;
    fn theme(&self) -> String;
    /// `TabManager.openGenerateTargetTab`: fails when no tab could open
    fn open_target_tab(
        &mut self,
        handoff: &GenerateHandoff,
        opener: Option<&NewDocumentOpener>,
    ) -> Result<(), Failure>;
    /// `deps.openConvertedTab` was given: the window offers conversions
    fn can_open_converted(&self) -> bool;
    /// `TabManager.openConversionResult`: fails when no tab could open
    fn open_converted_tab(
        &mut self,
        doc: &ConvertedDocument,
        opener: Option<&NewDocumentOpener>,
    ) -> Result<(), Failure>;
    /// every starred file in a Starred-view group
    fn starred_group_paths(&mut self, group: &str) -> Vec<String>;
    // ---- what the session's deps are made of ----
    /// `convertSource(kind, path, { untitled })`; it never rejects
    fn convert_source(&mut self, kind: ConvertKind, path: &str, untitled: &str) -> ConvertResult;
    /// `markdownRedactionNotice(path)`
    fn markdown_redaction_notice(&mut self, path: &str) -> bool;
    fn new_id(&mut self) -> String;
    fn now(&mut self) -> f64;
    /// `MAX_OUTLINE_SLIDES`
    fn max_convert_slides(&self) -> usize;
    // ---- electron ----
    /// `generateText(lang, key)` of the renderer's strings
    fn generate_text(&self, lang: Lang, key: GenerateText) -> String;
    /// `nativeTheme.shouldUseDarkColors`
    fn should_use_dark_colors(&self) -> bool;
    /// `process.platform === 'darwin'`
    fn is_darwin(&self) -> bool;
    /// `process.env.ELECTRON_RENDERER_URL`
    fn renderer_url(&self) -> Option<String>;
    /// `new BrowserWindow(options)`
    fn create_window(&mut self, options: &GenerateWindowOptions) -> WindowId;
    fn window_is_destroyed(&self, window: WindowId) -> bool;
    fn window_is_minimized(&self, window: WindowId) -> bool;
    fn window_restore(&mut self, window: WindowId);
    fn window_show(&mut self, window: WindowId);
    fn window_focus(&mut self, window: WindowId);
    fn window_close(&mut self, window: WindowId);
    fn window_remove_menu(&mut self, window: WindowId);
    /// `win.webContents.id`
    fn window_web_contents_id(&self, window: WindowId) -> f64;
    /// `win.webContents.send(GENERATE_CHANNELS.state, state)`
    fn window_send_state(&mut self, window: WindowId, state: &GenerateWindowState);
    /// `win.setTitleBarOverlay(overlay)`: fails when the window was torn down
    fn window_set_title_bar_overlay(
        &mut self,
        window: WindowId,
        overlay: &TitleBarOverlay,
    ) -> Result<(), Failure>;
    /// `nativeTheme.on('updated', ...)` for this window
    fn watch_theme(&mut self, window: WindowId);
    /// `nativeTheme.off('updated', ...)` for this window
    fn unwatch_theme(&mut self, window: WindowId);
    /// `win.loadURL(url)`
    fn window_load_url(&mut self, window: WindowId, url: &str);
    /// `win.loadFile(join(__dirname, '../renderer/generate.html'))`
    fn window_load_generate_page(&mut self, window: WindowId);
    /// `shell.openExternal(url)`
    fn open_external(&mut self, url: &str);
    /// `dialog.showOpenDialog(win, options)`
    fn show_open_dialog(&mut self, window: WindowId, options: &Value) -> OpenDialogResult;
}

/// `webPreferences` of the window, without the `preload` path the host adds
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GenerateWebPreferences {
    #[serde(rename = "contextIsolation")]
    pub context_isolation: bool,
    #[serde(rename = "nodeIntegration")]
    pub node_integration: bool,
    pub sandbox: bool,
}

/// the options of `new BrowserWindow({...})`, in the order of the literal,
/// without the `preload` path of `webPreferences` (the host adds it)
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GenerateWindowOptions {
    pub width: f64,
    pub height: f64,
    #[serde(rename = "minWidth")]
    pub min_width: f64,
    #[serde(rename = "minHeight")]
    pub min_height: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<WindowId>,
    pub show: bool,
    pub center: bool,
    pub minimizable: bool,
    pub maximizable: bool,
    pub fullscreenable: bool,
    #[serde(rename = "autoHideMenuBar")]
    pub auto_hide_menu_bar: bool,
    #[serde(rename = "backgroundColor")]
    pub background_color: &'static str,
    pub title: String,
    #[serde(rename = "titleBarStyle", skip_serializing_if = "Option::is_none")]
    pub title_bar_style: Option<&'static str>,
    #[serde(rename = "titleBarOverlay", skip_serializing_if = "Option::is_none")]
    pub title_bar_overlay: Option<TitleBarOverlay>,
    #[serde(rename = "webPreferences")]
    pub web_preferences: GenerateWebPreferences,
}

/// The options of the window: windows other than macOS draw the title band
/// themselves, and a live `parent` is passed on.
pub fn generate_window_options(
    lang: Lang,
    parent: Option<WindowId>,
    parent_destroyed: bool,
    dark: bool,
    darwin: bool,
    window_title: &str,
) -> GenerateWindowOptions {
    GenerateWindowOptions {
        width: 560.0,
        height: 720.0,
        min_width: 460.0,
        min_height: 520.0,
        parent: parent.filter(|_| !parent_destroyed),
        show: false,
        center: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        auto_hide_menu_bar: true,
        background_color: generate_title_bar_overlay(dark).color,
        title: format!("{} - {}", window_title, product_name(Some(lang.as_str()))),
        // Windows paints a native frame light even under a dark app theme; draw the
        // title band ourselves and let Electron theme only its caption buttons.
        title_bar_style: if darwin { None } else { Some("hidden") },
        title_bar_overlay: if darwin {
            None
        } else {
            Some(generate_title_bar_overlay(dark))
        },
        web_preferences: GenerateWebPreferences {
            context_isolation: true,
            node_integration: false,
            sandbox: true,
        },
    }
}

/// `stringList(raw)`: the strings of a list that are not empty and at most 4096 long
pub fn string_list(raw: Option<&Value>) -> Vec<String> {
    match raw.and_then(Value::as_array) {
        Some(list) => list
            .iter()
            .filter_map(Value::as_str)
            .filter(|p| !p.is_empty() && p.encode_utf16().count() <= 4096)
            .map(str::to_owned)
            .collect(),
        None => Vec::new(),
    }
}

/// the channels `registerIpc` handles, in the order it registers them
pub const IPC_HANDLE_CHANNELS: [&str; 12] = [
    channels::GET_STATE,
    channels::GET_THEME,
    channels::SET_KIND,
    channels::SET_CONVERT,
    channels::ADD_MATERIALS,
    channels::REMOVE_MATERIAL,
    channels::SAVE_MATERIAL,
    channels::REFRESH,
    channels::MAKE,
    channels::CANCEL,
    channels::HOME_OPEN_WITH_PATHS,
    channels::HOME_OPEN_WITH_GROUP,
];

/// The continuation of a save handler while the caller carries out a
/// [`SessionNeed`]; the caller keeps it and hands it to
/// [`GenerateWindow::resume_save`].
#[derive(Debug)]
pub struct WindowRun {
    session_id: u64,
    run: SaveRun,
}

/// One step of `generate:save-material`.
#[derive(Debug)]
pub enum WindowStep {
    Done(Result<(), Failure>),
    Need(SessionNeed, WindowRun),
}

/// the `init` of `openGenerateWindow`
#[derive(Debug, Clone, PartialEq)]
pub struct OpenInit {
    pub refs: Vec<MaterialRef>,
    pub kind: Option<AiTargetKind>,
    pub parent: Option<WindowId>,
    pub opener: Option<NewDocumentOpener>,
}

/// the module state of generate-window.ts
#[derive(Default)]
pub struct GenerateWindow {
    configured: bool,
    win: Option<WindowId>,
    /// every session a call may still be running on, by id
    sessions: Vec<SessionEntry>,
    /// the session of each window made, by the window's id
    window_sessions: Vec<(WindowId, u64)>,
    /// `session`: the current one
    session_id: Option<u64>,
    /// `lengthCache` of materials.ts
    length_cache: MaterialLengthCache,
    next_session_id: u64,
    /// where the open window was opened from (home or an editor window)
    opener: Option<NewDocumentOpener>,
    ipc_registered: bool,
}

struct SessionEntry {
    id: u64,
    session: GenerateSession,
    /// saves in flight on this session
    pending: usize,
}

/// the deps of a session, over the host and the window state
struct SessionBridge<'a, H: GenerateWindowHost> {
    host: &'a mut H,
    win: &'a mut Option<WindowId>,
    opener: &'a mut Option<NewDocumentOpener>,
    length_cache: &'a mut MaterialLengthCache,
    /// `closeGenerateWindow` ran: no session is current any more
    window_closed: bool,
}

/// `closeGenerateWindow`'s window part
fn close_window_state<H: GenerateWindowHost>(
    host: &mut H,
    win: &mut Option<WindowId>,
    opener: &mut Option<NewDocumentOpener>,
) {
    let current = win.take();
    *opener = None;
    if let Some(current) = current
        && !host.window_is_destroyed(current)
    {
        host.window_close(current);
    }
}

impl<H: GenerateWindowHost> GenerateSessionHost for SessionBridge<'_, H> {
    fn lang(&self) -> Lang {
        self.host.lang()
    }

    fn inspect(&mut self, snap: &OpenSnapshot<'_>, path: &str) -> Result<MaterialStatus, Failure> {
        inspect_material(&mut *self.host, self.length_cache, snap.files, path)
    }

    fn path_of_untitled(
        &mut self,
        snap: &OpenSnapshot<'_>,
        web_contents_id: f64,
    ) -> Option<String> {
        path_of_untitled(&mut *self.host, snap.tabs, web_contents_id)
    }

    fn save_action_for(&mut self, snap: &OpenSnapshot<'_>, path: &str) -> SaveAction {
        save_action_for(&*self.host, snap.tabs, path)
    }

    fn save_material_begin(&mut self, snap: &OpenSnapshot<'_>, path: &str) -> SaveMaterialStep {
        save_material_begin(&mut *self.host, snap.tabs, path)
    }

    fn save_material_resume(&mut self, run: SaveMaterialRun, answer: SaveAnswer) -> SaveOutcome {
        run.resume(&mut *self.host, answer)
    }

    fn show_untitled(
        &mut self,
        snap: &OpenSnapshot<'_>,
        web_contents_id: f64,
    ) -> Result<(), Failure> {
        show_untitled(&mut *self.host, snap.tabs, web_contents_id);
        Ok(())
    }

    fn open_target_tab(&mut self, handoff: &GenerateHandoff) -> Result<(), Failure> {
        self.host.open_target_tab(handoff, self.opener.as_ref())
    }

    fn can_convert(&self) -> bool {
        self.host.can_open_converted()
    }

    fn convert(&mut self, kind: ConvertKind, path: &str) -> Result<ConvertResult, Failure> {
        let lang = self.host.lang();
        let untitled = self.host.generate_text(lang, GenerateText::Untitled);
        Ok(self.host.convert_source(kind, path, &untitled))
    }

    fn open_converted_tab(&mut self, doc: &ConvertedDocument) -> Result<(), Failure> {
        self.host.open_converted_tab(doc, self.opener.as_ref())
    }

    fn has_redaction_notice(&self) -> bool {
        self.host.can_open_converted()
    }

    fn redaction_notice(&mut self, path: &str) -> Result<bool, Failure> {
        Ok(self.host.markdown_redaction_notice(path))
    }

    fn push(&mut self, state: &GenerateWindowState) {
        if let Some(win) = *self.win
            && !self.host.window_is_destroyed(win)
        {
            self.host.window_send_state(win, state);
        }
    }

    fn close(&mut self) {
        self.window_closed = true;
        close_window_state(&mut *self.host, &mut *self.win, &mut *self.opener);
    }

    fn new_id(&mut self) -> String {
        self.host.new_id()
    }

    fn now(&mut self) -> f64 {
        self.host.now()
    }

    fn recheck_delay_ms(&self) -> Option<f64> {
        None
    }

    fn max_convert_slides(&self) -> usize {
        self.host.max_convert_slides()
    }
}

impl GenerateWindow {
    pub fn new() -> Self {
        Self::default()
    }

    /// Runs `run` on session `id` with its deps. `None` when there is no
    /// such session. When the session closed the window, no session is
    /// current afterwards; a session nothing runs on any more is dropped.
    fn with_session_id<H: GenerateWindowHost, R>(
        &mut self,
        host: &mut H,
        id: u64,
        run: impl FnOnce(&mut GenerateSession, &mut SessionBridge<'_, H>) -> R,
    ) -> Option<R> {
        let at = self.sessions.iter().position(|e| e.id == id)?;
        let mut entry = self.sessions.remove(at);
        let mut bridge = SessionBridge {
            host,
            win: &mut self.win,
            opener: &mut self.opener,
            length_cache: &mut self.length_cache,
            window_closed: false,
        };
        let result = run(&mut entry.session, &mut bridge);
        if bridge.window_closed {
            self.session_id = None;
        }
        self.sessions.insert(at, entry);
        Some(result)
    }

    /// Runs `run` on the current session (`session?.x`).
    fn with_session<H: GenerateWindowHost, R>(
        &mut self,
        host: &mut H,
        run: impl FnOnce(&mut GenerateSession, &mut SessionBridge<'_, H>) -> R,
    ) -> Option<R> {
        let id = self.session_id?;
        let result = self.with_session_id(host, id, run);
        self.prune_sessions();
        result
    }

    /// a session that is not current and has no save in flight is gone
    fn prune_sessions(&mut self) {
        let current = self.session_id;
        self.sessions
            .retain(|e| Some(e.id) == current || e.pending > 0);
    }

    fn current_session(&self) -> Option<&GenerateSession> {
        let id = self.session_id?;
        self.sessions
            .iter()
            .find(|e| e.id == id)
            .map(|e| &e.session)
    }

    fn has_session(&self) -> bool {
        self.session_id
            .is_some_and(|id| self.sessions.iter().any(|e| e.id == id))
    }

    /// `configureGenerateWindow(next)`: `deps = next`, and the tab id
    /// resolver follows `next.tabIdFor`. Answers whether the caller registers
    /// its IPC handlers now (`IPC_HANDLE_CHANNELS`): only the first time.
    pub fn configure(&mut self) -> bool {
        self.configured = true;
        if self.ipc_registered {
            return false;
        }
        self.ipc_registered = true;
        true
    }

    /// `fromWindow(event)`: the sender is the generate window's page
    pub fn from_window<H: GenerateWindowHost>(&self, host: &H, sender_id: f64) -> bool {
        match self.win {
            Some(win) => {
                !host.window_is_destroyed(win) && host.window_web_contents_id(win) == sender_id
            }
            None => false,
        }
    }

    /// `fromHome(event)`: only the shell window's own page (Home) may ask
    fn from_home<H: GenerateWindowHost>(&self, host: &mut H, sender_id: f64) -> bool {
        if !self.configured {
            return false;
        }
        match host.parent_window() {
            Some(parent) => {
                !host.window_is_destroyed(parent)
                    && host.window_web_contents_id(parent) == sender_id
            }
            None => false,
        }
    }

    /// `generate:get-state`
    pub fn handle_get_state<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        sender_id: f64,
    ) -> Option<GenerateWindowState> {
        if !self.from_window(&*host, sender_id) {
            return None;
        }
        self.with_session(host, |session, bridge| session.state(&*bridge))
    }

    /// `generate:get-theme`
    pub fn handle_get_theme<H: GenerateWindowHost>(&self, host: &H, sender_id: f64) -> String {
        if self.from_window(host, sender_id) && self.configured {
            host.theme()
        } else {
            "system".to_owned()
        }
    }

    /// `generate:set-kind`
    pub fn handle_set_kind<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        sender_id: f64,
        kind: Option<&Value>,
    ) {
        if self.from_window(&*host, sender_id) {
            self.with_session(host, |session, bridge| session.set_kind(bridge, kind));
        }
    }

    /// `generate:set-convert`
    pub fn handle_set_convert<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        sender_id: f64,
        kind: Option<&Value>,
    ) {
        if self.from_window(&*host, sender_id) {
            self.with_session(host, |session, bridge| session.set_convert(bridge, kind));
        }
    }

    /// `generate:add-materials`: the file picker, and the picked files join the list
    pub fn handle_add_materials<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        sender_id: f64,
    ) -> Result<(), Failure> {
        if !self.from_window(&*host, sender_id) || !self.has_session() || !self.configured {
            return Ok(());
        }
        let Some(win) = self.win else {
            return Ok(());
        };
        let lang = host.lang();
        let options = json!({
            "title": host.generate_text(lang, GenerateText::DialogAddTitle),
            "filters": [
                {
                    "name": host.generate_text(lang, GenerateText::FilterSupported),
                    "extensions": supported_material_exts(),
                },
            ],
            "properties": ["openFile", "multiSelections"],
        });
        let result = host.show_open_dialog(win, &options);
        if !result.canceled {
            // `session?.addPaths(...)`: the session may be gone by now
            self.with_session(host, |session, bridge| {
                session.add_paths(bridge, snap, &result.file_paths)
            })
            .unwrap_or(Ok(()))?;
        }
        Ok(())
    }

    /// `generate:remove-material`
    pub fn handle_remove_material<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        sender_id: f64,
        key: Option<&Value>,
    ) {
        if self.from_window(&*host, sender_id) {
            self.with_session(host, |session, bridge| session.remove(bridge, key));
        }
    }

    /// `generate:save-material`
    pub fn handle_save_material<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        sender_id: f64,
        key: Option<&Value>,
    ) -> WindowStep {
        if !self.from_window(&*host, sender_id) {
            return WindowStep::Done(Ok(()));
        }
        let Some(id) = self.session_id else {
            return WindowStep::Done(Ok(()));
        };
        let step = self.with_session_id(host, id, |session, bridge| {
            session.save_begin(bridge, snap, key)
        });
        self.save_step(id, step)
    }

    /// the caller carried out the [`SessionNeed`] of a [`WindowStep`]
    pub fn resume_save<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        run: WindowRun,
        answer: SessionAnswer,
    ) -> WindowStep {
        let id = run.session_id;
        let step = self.with_session_id(host, id, |session, bridge| {
            session.save_resume(bridge, snap, run.run, answer)
        });
        if let Some(entry) = self.sessions.iter_mut().find(|e| e.id == id) {
            entry.pending -= 1;
        }
        self.save_step(id, step)
    }

    /// what a step of `save` means for the window: a pending save keeps its
    /// session in the table
    fn save_step(&mut self, id: u64, step: Option<SaveStep>) -> WindowStep {
        let out = match step {
            None | Some(SaveStep::Done(Ok(()))) => WindowStep::Done(Ok(())),
            Some(SaveStep::Done(Err(error))) => WindowStep::Done(Err(error)),
            Some(SaveStep::Need(need, run)) => {
                if let Some(entry) = self.sessions.iter_mut().find(|e| e.id == id) {
                    entry.pending += 1;
                }
                WindowStep::Need(
                    need,
                    WindowRun {
                        session_id: id,
                        run,
                    },
                )
            }
        };
        self.prune_sessions();
        out
    }

    /// `generate:refresh`
    pub fn handle_refresh<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        sender_id: f64,
    ) -> Result<(), Failure> {
        if self.from_window(&*host, sender_id) {
            self.with_session(host, |session, bridge| session.refresh(bridge, snap))
                .unwrap_or(Ok(()))?;
        }
        Ok(())
    }

    /// `generate:make`
    pub fn handle_make<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        sender_id: f64,
        text: Option<&Value>,
    ) -> bool {
        if !self.from_window(&*host, sender_id) {
            return false;
        }
        self.with_session(host, |session, bridge| session.make(bridge, snap, text))
            .unwrap_or(false)
    }

    /// `generate:cancel`
    pub fn handle_cancel<H: GenerateWindowHost>(&mut self, host: &mut H, sender_id: f64) {
        if self.from_window(&*host, sender_id) {
            self.close_generate_window(host);
        }
    }

    /// `generate:open-with-paths`
    pub fn handle_open_with_paths<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        sender_id: f64,
        paths: Option<&Value>,
    ) -> Result<(), Failure> {
        if !self.from_home(host, sender_id) {
            return Ok(());
        }
        self.open_generate_window_with_paths(host, snap, string_list(paths), None)
    }

    /// `generate:open-with-group`
    pub fn handle_open_with_group<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        sender_id: f64,
        group: Option<&Value>,
    ) -> Result<(), Failure> {
        if !self.from_home(host, sender_id) {
            return Ok(());
        }
        let Some(group) = group.and_then(Value::as_str).filter(|g| !g.is_empty()) else {
            return Ok(());
        };
        let paths = host.starred_group_paths(group);
        self.open_generate_window_with_paths(host, snap, paths, None)
    }

    /// `openGenerateWindow(init)`: open the window (or start the open one
    /// over) with these materials
    pub fn open_generate_window<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        init: OpenInit,
    ) -> Result<(), Failure> {
        if !self.configured {
            return Err(Failure("the generate window is not configured".to_owned()));
        }
        self.opener = init.opener.clone();
        if let Some(win) = self.win
            && !host.window_is_destroyed(win)
            && self.current_session().is_some_and(|s| !s.is_closed())
        {
            // `void session.reset(...)`
            let refs = init.refs.clone();
            let kind = init.kind;
            let _ = self.with_session(host, |session, bridge| {
                session.reset(bridge, snap, &refs, kind)
            });
            if host.window_is_minimized(win) {
                host.window_restore(win);
            }
            host.window_show(win);
            host.window_focus(win);
            return Ok(());
        }

        let id = self.next_session_id;
        self.next_session_id += 1;
        self.sessions.push(SessionEntry {
            id,
            session: GenerateSession::new(&init.refs, init.kind),
            pending: 0,
        });
        self.session_id = Some(id);
        self.prune_sessions();
        let lang = host.lang();
        let parent = match init.parent {
            Some(parent) => Some(parent),
            None => host.parent_window(),
        };
        let parent_destroyed = parent.is_some_and(|p| host.window_is_destroyed(p));
        let window_title = host.generate_text(lang, GenerateText::WindowTitle);
        let options = generate_window_options(
            lang,
            parent,
            parent_destroyed,
            host.should_use_dark_colors(),
            host.is_darwin(),
            &window_title,
        );
        let next = host.create_window(&options);
        self.win = Some(next);
        self.window_sessions.push((next, id));
        host.window_remove_menu(next);
        // follow a theme switch while the window is open (nativeTheme fires 'updated')
        host.watch_theme(next);

        match host.renderer_url() {
            Some(url) if !url.is_empty() => {
                host.window_load_url(next, &format!("{url}/generate.html"));
            }
            _ => host.window_load_generate_page(next),
        }
        // `void current.refresh()`
        let _ = self.with_session(host, |session, bridge| session.refresh(bridge, snap));
        Ok(())
    }

    /// `next.once('ready-to-show', () => next.show())`
    pub fn on_ready_to_show<H: GenerateWindowHost>(&self, host: &mut H, window: WindowId) {
        host.window_show(window);
    }

    /// `next.on('focus', ...)`: coming back from another window is when a
    /// material may have been saved there
    pub fn on_focus<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        window: WindowId,
    ) {
        if self.session_of(window).is_some() && self.session_of(window) == self.session_id {
            let _ = self.with_session(host, |session, bridge| session.refresh(bridge, snap));
        }
    }

    /// `next.on('closed', ...)`
    pub fn on_closed<H: GenerateWindowHost>(&mut self, host: &mut H, window: WindowId) {
        host.unwatch_theme(window);
        let owned = self.session_of(window);
        self.window_sessions.retain(|(w, _)| *w != window);
        if self.win == Some(window) {
            self.win = None;
            self.opener = None;
        }
        if owned.is_some() && owned == self.session_id {
            self.session_id = None;
            self.prune_sessions();
        }
    }

    /// `refreshTitleBar`: the theme switched while the window is open
    pub fn on_theme_updated<H: GenerateWindowHost>(&self, host: &mut H, window: WindowId) {
        if host.window_is_destroyed(window) || host.is_darwin() {
            return;
        }
        let overlay = generate_title_bar_overlay(host.should_use_dark_colors());
        // the window was torn down between the check and the call
        let _ = host.window_set_title_bar_overlay(window, &overlay);
    }

    /// `setWindowOpenHandler`: a link opens in the browser when it is safe; the window itself never opens one
    pub fn window_open<H: GenerateWindowHost>(&self, host: &mut H, url: &str) {
        if let Some(target) = safe_external_url(Some(url), None) {
            host.open_external(&target);
        }
    }

    fn session_of(&self, window: WindowId) -> Option<u64> {
        self.window_sessions
            .iter()
            .find(|(w, _)| *w == window)
            .map(|(_, id)| *id)
    }

    /// `openGenerateWindowWithPaths(paths, parent)`: Home: these files as the starting materials
    pub fn open_generate_window_with_paths<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        paths: Vec<String>,
        parent: Option<WindowId>,
    ) -> Result<(), Failure> {
        self.open_generate_window(
            host,
            snap,
            OpenInit {
                refs: paths.into_iter().map(MaterialRef::Path).collect(),
                kind: None,
                parent,
                opener: Some(NewDocumentOpener::Home),
            },
        )
    }

    /// `openGenerateWindowForDocument(doc)`: an editor's File menu, "make
    /// another document from this one". A document never saved has no
    /// `filePath`; it is listed as "save it first".
    pub fn open_generate_window_for_document<H: GenerateWindowHost>(
        &mut self,
        host: &mut H,
        snap: &OpenSnapshot<'_>,
        web_contents_id: f64,
        file_path: Option<&str>,
        title: &str,
        parent: Option<WindowId>,
    ) -> Result<(), Failure> {
        let mref = match file_path.filter(|p| !p.is_empty()) {
            Some(path) => MaterialRef::Path(path.to_owned()),
            None => MaterialRef::Untitled {
                web_contents_id,
                title: title.to_owned(),
            },
        };
        self.open_generate_window(
            host,
            snap,
            OpenInit {
                refs: vec![mref],
                kind: None,
                parent,
                opener: Some(NewDocumentOpener::Window { web_contents_id }),
            },
        )
    }

    /// `closeGenerateWindow()`
    pub fn close_generate_window<H: GenerateWindowHost>(&mut self, host: &mut H) {
        self.session_id = None;
        self.prune_sessions();
        close_window_state(host, &mut self.win, &mut self.opener);
    }

    /// `generateWindowContents()`: the window's webContents id, when it is open
    pub fn generate_window_contents<H: GenerateWindowHost>(&self, host: &H) -> Option<f64> {
        self.win
            .filter(|win| !host.window_is_destroyed(*win))
            .map(|win| host.window_web_contents_id(win))
    }
}
