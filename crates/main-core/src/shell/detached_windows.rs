//! `apps/shell/src/main/detached-windows.ts`: a tab's live view reparented
//! into its own window. The registry of detached windows, the dock band and
//! hover, the tear-off drag and the close confirmation decisions are here;
//! the `BrowserWindow` objects stay with the caller behind [`DetachedHost`].
//!
//! The module-level state of the TypeScript (`detached`, `torn`, `dockHost`)
//! is the struct [`DetachedWindows`] the caller owns. Each record of the
//! TypeScript is a slot of an arena named by a [`RecId`], so the closures of
//! one window (its `close`, `closed`, `resize` handlers) become methods that
//! take that id; the caller wires every window event it registered to its
//! method. Timers are steps the caller drives: the dock dwell timer
//! ([`DetachedWindows::dock_timer_fired`]) and the `setImmediate` layouts
//! ([`DetachedWindows::run_deferred_layout`]). A window event handler that
//! calls `event.preventDefault()` answers with a flag instead.

use jscompat::node_path::host::basename;
use jscompat::{JsMap, math_max, math_min, math_round, number_to_string, to_number, truthy};
use serde_json::{Map, Value};

use super::split_layout::Rect;
use super::tab_manager::{
    DetachedTab, EditorCalls, OpenDocumentTab, TabKind, canonical_path, is_settled_rect,
    tab_strip_height,
};

/// `ID_PREFIX`
const ID_PREFIX: &str = "detached:";

/// `DOCK_BAND_SLACK` of `shared/tab-drag-geometry.ts`
pub const DOCK_BAND_SLACK: f64 = 8.0;

/// `DOCK_DWELL_MS` of `shared/tab-drag-geometry.ts`
pub const DOCK_DWELL_MS: f64 = 180.0;

/// `TEAR_GRAB`: where the pointer sits inside a freshly torn-off window's title bar
const TEAR_GRAB_DX: f64 = 120.0;
const TEAR_GRAB_DY: f64 = 14.0;

/// `pointInRect`
pub fn point_in_rect(x: f64, y: f64, rect: &Rect) -> bool {
    x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height
}

/// `dockBand`: the strip of the shell window's content area, grown by `slack`
pub fn dock_band(shell_content_bounds: &Rect, slack: f64, scale: f64) -> Rect {
    Rect {
        x: shell_content_bounds.x,
        y: shell_content_bounds.y - slack,
        width: shell_content_bounds.width,
        height: tab_strip_height(scale) + 2.0 * slack,
    }
}

/// What `dockBandFor` reads of the shell window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShellWindowState {
    pub destroyed: bool,
    pub visible: bool,
    pub minimized: bool,
    pub content_bounds: Rect,
}

/// `dockBandFor`: the screen rect of the shell's dock band (`None` when
/// hidden); `shell` is `None` where the TypeScript has no shell window
pub fn dock_band_for(shell: Option<&ShellWindowState>, scale: f64) -> Option<Rect> {
    let shell = shell?;
    if shell.destroyed || !shell.visible {
        return None;
    }
    if shell.minimized {
        return None;
    }
    Some(dock_band(&shell.content_bounds, DOCK_BAND_SLACK, scale))
}

/// `toInt`: Electron rejects -0 as an int argument, and `Math.round` yields
/// -0 for values in (-0.5, 0)
fn to_int(v: f64) -> f64 {
    let rounded = math_round(v);
    if rounded == 0.0 || rounded.is_nan() {
        0.0
    } else {
        rounded
    }
}

/// `DEFAULT_SIZE[kind] ?? { width: 1360, height: 900 }`
fn default_size(kind: TabKind) -> (f64, f64) {
    match kind {
        TabKind::Docs => (1360.0, 900.0),
        TabKind::Sheets => (1440.0, 900.0),
        TabKind::Slides => (1440.0, 900.0),
        TabKind::Pdf => (1200.0, 900.0),
        TabKind::Markdown => (1200.0, 850.0),
        TabKind::Html => (1200.0, 850.0),
        TabKind::Mindmap => (1200.0, 850.0),
        TabKind::Hwp => (1280.0, 900.0),
        TabKind::Epub => (1200.0, 900.0),
        TabKind::Diagram => (1280.0, 880.0),
        TabKind::Home | TabKind::Help => (1360.0, 900.0),
    }
}

/// `tearOffOrigin`: the frame origin that puts the pointer inside the new
/// window's title bar, kept on the pointer's display
fn tear_off_origin(area: &Rect, at: (f64, f64), size: (f64, f64)) -> (f64, f64) {
    let x = math_min(
        math_max(at.0 - TEAR_GRAB_DX, area.x),
        area.x + area.width - size.0,
    );
    let y = math_min(
        math_max(at.1 - TEAR_GRAB_DY, area.y),
        area.y + area.height - size.1,
    );
    (to_int(x), to_int(y))
}

/// The constructor options of the `BrowserWindow`, in the order the
/// TypeScript writes them (`...size, ...origin, minWidth, minHeight, title,
/// show, autoHideMenuBar`).
#[derive(Debug, Clone, PartialEq)]
pub struct WindowOptions {
    pub width: f64,
    pub height: f64,
    /// `x` and `y`, present only for a tear-off
    pub origin: Option<(f64, f64)>,
    pub min_width: f64,
    pub min_height: f64,
    pub title: String,
    pub show: bool,
    pub auto_hide_menu_bar: bool,
}

/// `createDetachedEditorWindow`'s options (`applyMenuFor` is the host's)
#[derive(Debug, Clone, PartialEq)]
pub struct DetachedWindowOptions<V> {
    pub view: V,
    pub kind: TabKind,
    pub title: String,
    pub file_path: Option<String>,
    /// tear-off: place the window so the pointer at this screen point sits in
    /// its title bar, and show it without focus
    pub tear_off_at: Option<(f64, f64)>,
}

/// The id of one detached window's record.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecId(pub usize);

struct DetachedRecord<V, W> {
    window: W,
    view: V,
    /// `view.webContents.id` when the window was made: the registry key
    wc_id: i64,
    kind: TabKind,
    file_path: Option<String>,
    /// the view left for the shell strip: the pending destroy must not touch it
    released: bool,
    /// cursor currently inside the shell strip's dock band during a native drag
    hovering: bool,
    /// dwell timer armed
    dock_timer: bool,
    /// `closeConfirmed`
    close_confirmed: bool,
    /// `promptInFlight`
    prompt_in_flight: bool,
}

struct Torn {
    rec: RecId,
    grab_dx: f64,
    grab_dy: f64,
}

/// `SessionDetachedTab`
#[derive(Debug, Clone, PartialEq)]
pub struct SessionDetachedTab {
    pub id: String,
    pub kind: TabKind,
    pub title: String,
    pub file_path: Option<String>,
}

impl SessionDetachedTab {
    /// `{ id, kind, title, filePath? }`
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("id".into(), Value::from(self.id.as_str()));
        map.insert("kind".into(), Value::from(self.kind.as_str()));
        map.insert("title".into(), Value::from(self.title.as_str()));
        if let Some(path) = &self.file_path {
            map.insert("filePath".into(), Value::from(path.as_str()));
        }
        Value::Object(map)
    }
}

/// `findDetachedTabByPath`'s answer, with the view in place of its `webContents`
#[derive(Debug, Clone, PartialEq)]
pub struct DetachedLookup<V> {
    pub id: String,
    pub kind: TabKind,
    pub view: V,
}

/// `detachedDocumentFor`'s answer
#[derive(Debug, Clone, PartialEq)]
pub struct DetachedDocument {
    pub id: String,
    pub kind: TabKind,
    pub title: String,
    pub file_path: Option<String>,
}

/// `focusedDetachedTab`'s answer
#[derive(Debug, Clone, PartialEq)]
pub struct FocusedDetached<V, W> {
    pub id: String,
    pub kind: TabKind,
    pub view: V,
    pub file_path: Option<String>,
    pub window: W,
}

/// What the detached windows call: a `BrowserWindow` `W`, the screen, the
/// shell's `DockHost`, the listeners and the editor modules.
pub trait DetachedHost<V, W>: EditorCalls<V> {
    // ---- a window ----
    /// `new BrowserWindow(options)`
    fn create_window(&mut self, options: &WindowOptions) -> W;
    /// `win.isDestroyed()`
    fn win_destroyed(&mut self, win: &W) -> bool;
    /// `win.isMinimized()`
    fn win_minimized(&mut self, win: &W) -> bool;
    /// `win.isFocused()`
    fn win_focused(&mut self, win: &W) -> bool;
    /// `win.restore()`
    fn win_restore(&mut self, win: &W);
    /// `win.show()`
    fn win_show(&mut self, win: &W);
    /// `win.showInactive()`
    fn win_show_inactive(&mut self, win: &W);
    /// `win.focus()`
    fn win_focus(&mut self, win: &W);
    /// `win.destroy()`
    fn win_destroy(&mut self, win: &W);
    /// `win.getTitle()`
    fn win_title(&mut self, win: &W) -> String;
    /// `win.setTitle(title)`
    fn win_set_title(&mut self, win: &W, title: &str);
    /// `win.getContentBounds()`
    fn win_content_bounds(&mut self, win: &W) -> Rect;
    /// `win.getPosition()`
    fn win_position(&mut self, win: &W) -> (f64, f64);
    /// `win.setPosition(x, y)`
    fn win_set_position(&mut self, win: &W, x: f64, y: f64);
    /// `win.contentView.addChildView(view)`
    fn content_add_child_view(&mut self, win: &W, view: &V);
    /// `win.contentView.removeChildView(view)`
    fn content_remove_child_view(&mut self, win: &W, view: &V);

    // ---- the screen ----
    /// `screen.getDisplayNearestPoint(at).workArea`
    fn display_work_area(&mut self, at: (f64, f64)) -> Rect;
    /// `screen.getCursorScreenPoint()`
    fn cursor_point(&mut self) -> (f64, f64);

    // ---- the shell's DockHost ----
    /// `dockHost.band()`
    fn dock_band(&mut self) -> Option<Rect>;
    /// `dockHost.preview(x)`: show (window-CSS x) or clear (`None`) the indicator
    fn dock_preview(&mut self, x: Option<f64>);
    /// `dockHost.dock(tab)`
    fn dock(&mut self, tab: DetachedTab<V>);

    // ---- listeners and timers ----
    /// `onChanged()` of `setDetachedChangedListener`
    fn on_detached_changed(&mut self);
    /// `rec.dockTimer = setTimeout(..., delay_ms)`
    fn arm_dock_timer(&mut self, rec: RecId, delay_ms: f64);
    /// `clearTimeout(rec.dockTimer)`
    fn clear_dock_timer(&mut self, rec: RecId);
    /// `setImmediate(() => layout())` of the window's record
    fn defer_layout(&mut self, rec: RecId);

    // ---- close prompts ----
    /// `requestSheetsClose(wc, win)`, ... (by `kind`); `Err` is what it throws
    fn request_close_in(&mut self, kind: TabKind, view: &V, win: &W) -> Result<bool, String>;
    /// `resetSheetsShuttingDown()`
    fn reset_sheets_shutting_down(&mut self);
    /// `cancelUpdateRestart()`
    fn cancel_update_restart(&mut self);
    /// `resumeDiscardedCopies()`
    fn resume_discarded_copies(&mut self);
    /// `pdfCloseCancelled(webContents)`
    fn pdf_close_cancelled(&mut self, view: &V);
    /// `console.error(message, error)`
    fn console_error(&mut self, message: &str, error: &str);
}

/// The module-level state of `detached-windows.ts`, owned by the caller.
pub struct DetachedWindows<V, W> {
    records: Vec<Option<DetachedRecord<V, W>>>,
    /// keyed by the view's webContents id, in the order the windows opened
    detached: JsMap<usize>,
    /// `dockHost !== null`
    dock_host: bool,
    /// the one window mid tear-off
    torn: Option<Torn>,
}

impl<V: Clone + PartialEq, W: Clone + PartialEq> DetachedWindows<V, W> {
    pub fn new() -> DetachedWindows<V, W> {
        DetachedWindows {
            records: Vec::new(),
            detached: JsMap::new(),
            dock_host: false,
            torn: None,
        }
    }

    /// `setDockHost`: a shell window to dock into is registered (or gone)
    pub fn set_dock_host(&mut self, present: bool) {
        self.dock_host = present;
    }

    fn rec(&self, id: RecId) -> Option<&DetachedRecord<V, W>> {
        self.records.get(id.0).and_then(|r| r.as_ref())
    }

    fn rec_mut(&mut self, id: RecId) -> Option<&mut DetachedRecord<V, W>> {
        self.records.get_mut(id.0).and_then(|r| r.as_mut())
    }

    fn torn_is(&self, id: RecId) -> bool {
        self.torn.as_ref().is_some_and(|t| t.rec == id)
    }

    /// the records of `detached`, in order
    fn live_ids(&self) -> Vec<RecId> {
        self.detached.values().map(|i| RecId(*i)).collect()
    }

    /// `recordById`: the record of a `detached:<webContents id>` id whose
    /// window is alive
    fn record_by_id(&self, host: &mut dyn DetachedHost<V, W>, id: &str) -> Option<RecId> {
        let rest = id.strip_prefix(ID_PREFIX)?;
        let key = number_to_string(to_number(rest));
        let rec = RecId(*self.detached.get(&key)?);
        let window = self.rec(rec)?.window.clone();
        if host.win_destroyed(&window) {
            None
        } else {
            Some(rec)
        }
    }

    /// `bringToFront`
    fn bring_to_front(host: &mut dyn DetachedHost<V, W>, win: &W) {
        if host.win_minimized(win) {
            host.win_restore(win);
        }
        host.win_show(win);
        host.win_focus(win);
    }

    /// `isDetachedEditorWindow`
    pub fn is_detached_editor_window(&self, win: &W) -> bool {
        self.detached
            .values()
            .any(|i| self.rec(RecId(*i)).is_some_and(|r| r.window == *win))
    }

    /// `focusDetachedByPath`: focus the detached window editing this file
    pub fn focus_detached_by_path(&self, host: &mut dyn DetachedHost<V, W>, path: &str) -> bool {
        let wanted = canonical_path(Some(path));
        for id in self.live_ids() {
            let Some(rec) = self.rec(id) else {
                continue;
            };
            let window = rec.window.clone();
            if truthy(rec.file_path.as_deref()).is_some()
                && canonical_path(rec.file_path.as_deref()) == wanted
                && !host.win_destroyed(&window)
            {
                Self::bring_to_front(host, &window);
                return true;
            }
        }
        false
    }

    /// `findDetachedTabByPath`: a detached editor answers like a tab, with a
    /// `detached:` id
    pub fn find_detached_tab_by_path(
        &self,
        host: &mut dyn DetachedHost<V, W>,
        path: &str,
    ) -> Option<DetachedLookup<V>> {
        let wanted = canonical_path(Some(path));
        for id in self.live_ids() {
            let rec = self.rec(id)?;
            let window = rec.window.clone();
            if truthy(rec.file_path.as_deref()).is_some()
                && canonical_path(rec.file_path.as_deref()) == wanted
                && !host.win_destroyed(&window)
            {
                return Some(DetachedLookup {
                    id: format!("{ID_PREFIX}{}", rec.wc_id),
                    kind: rec.kind,
                    view: rec.view.clone(),
                });
            }
        }
        None
    }

    /// `detachedWindowForWebContents`
    pub fn detached_window_for_web_contents(
        &self,
        host: &mut dyn DetachedHost<V, W>,
        wc_id: i64,
    ) -> Option<W> {
        let rec = self.rec(RecId(*self.detached.get(&wc_id.to_string())?))?;
        let window = rec.window.clone();
        if host.win_destroyed(&window) {
            None
        } else {
            Some(window)
        }
    }

    /// `detachedDocumentFor`: the document a detached window shows
    pub fn detached_document_for(
        &self,
        host: &mut dyn DetachedHost<V, W>,
        wc_id: i64,
    ) -> Option<DetachedDocument> {
        let rec = self.rec(RecId(*self.detached.get(&wc_id.to_string())?))?;
        let window = rec.window.clone();
        if host.win_destroyed(&window) {
            return None;
        }
        Some(DetachedDocument {
            id: format!("{ID_PREFIX}{wc_id}"),
            kind: rec.kind,
            title: host.win_title(&window),
            file_path: rec.file_path.clone().filter(|p| !p.is_empty()),
        })
    }

    /// `focusedDetachedKind`
    pub fn focused_detached_kind(&self, host: &mut dyn DetachedHost<V, W>) -> Option<TabKind> {
        self.focused_detached_tab(host).map(|t| t.kind)
    }

    /// `focusedDetachedTab`: the focused detached window's document
    pub fn focused_detached_tab(
        &self,
        host: &mut dyn DetachedHost<V, W>,
    ) -> Option<FocusedDetached<V, W>> {
        for id in self.live_ids() {
            let rec = self.rec(id)?;
            let window = rec.window.clone();
            if !host.win_destroyed(&window) && host.win_focused(&window) {
                return Some(FocusedDetached {
                    id: format!("{ID_PREFIX}{}", rec.wc_id),
                    kind: rec.kind,
                    view: rec.view.clone(),
                    file_path: rec.file_path.clone().filter(|p| !p.is_empty()),
                    window,
                });
            }
        }
        None
    }

    /// `isDetachedTabId`
    pub fn is_detached_tab_id(&self, host: &mut dyn DetachedHost<V, W>, id: &str) -> bool {
        self.record_by_id(host, id).is_some()
    }

    /// `activateDetached`: bring a detached editor forward; false when the id
    /// is not a detached window
    pub fn activate_detached(&self, host: &mut dyn DetachedHost<V, W>, id: &str) -> bool {
        let Some(rec) = self.record_by_id(host, id) else {
            return false;
        };
        let Some(window) = self.rec(rec).map(|r| r.window.clone()) else {
            return false;
        };
        Self::bring_to_front(host, &window);
        true
    }

    /// `detachedWebContentsFor`
    pub fn detached_web_contents_for(
        &self,
        host: &mut dyn DetachedHost<V, W>,
        id: &str,
    ) -> Option<V> {
        let rec = self.record_by_id(host, id)?;
        self.rec(rec).map(|r| r.view.clone())
    }

    /// `closeDetachedWithoutPrompt`
    pub fn close_detached_without_prompt(
        &mut self,
        host: &mut dyn DetachedHost<V, W>,
        id: &str,
    ) -> bool {
        let Some(rec) = self.record_by_id(host, id) else {
            return false;
        };
        // a memo editor's text is not in the document yet, and a promptless
        // close must not drop it
        let (kind, view) = match self.rec(rec) {
            Some(r) => (r.kind, r.view.clone()),
            None => return false,
        };
        if kind == TabKind::Hwp && !host.view_destroyed(&view) {
            let wc_id = host.view_id(&view);
            if host.hwp_memo_modal_open(wc_id) {
                return false;
            }
        }
        self.tear_down(host, rec);
        true
    }

    /// `detachedIsDirty`: unsaved-changes state of one detached document
    fn detached_is_dirty(&self, host: &mut dyn DetachedHost<V, W>, rec: RecId) -> bool {
        let Some(r) = self.rec(rec) else {
            return false;
        };
        let (kind, view) = (r.kind, r.view.clone());
        if host.view_destroyed(&view) {
            return false;
        }
        let wc_id = host.view_id(&view);
        match kind {
            TabKind::Sheets => host.sheets_pending_edit_count(wc_id) > 0.0,
            TabKind::Docs => host.docs_query_dirty(&view),
            TabKind::Slides
            | TabKind::Pdf
            | TabKind::Markdown
            | TabKind::Html
            | TabKind::Mindmap
            | TabKind::Hwp
            | TabKind::Epub
            | TabKind::Diagram => host.family_is_dirty(kind, wc_id),
            TabKind::Home | TabKind::Help => false,
        }
    }

    /// `confirmDetachedClose`: run the family's save/don't-save/cancel prompt
    /// when the document is dirty; true when the window may close
    fn confirm_detached_close(
        &self,
        host: &mut dyn DetachedHost<V, W>,
        rec: RecId,
    ) -> Result<bool, String> {
        let Some(r) = self.rec(rec) else {
            return Ok(true);
        };
        let (kind, view, window) = (r.kind, r.view.clone(), r.window.clone());
        // an open memo editor holds text that is not in the document yet, even
        // when the document is clean
        let memo_open = if kind == TabKind::Hwp {
            let wc_id = host.view_id(&view);
            host.hwp_memo_modal_open(wc_id)
        } else {
            false
        };
        if !memo_open && !self.detached_is_dirty(host, rec) {
            return Ok(true);
        }
        match kind {
            TabKind::Home | TabKind::Help => Ok(true),
            _ => host.request_close_in(kind, &view, &window),
        }
    }

    /// `detachedOpenDocuments`: the detached editors in the same shape as
    /// `TabManager.openDocuments`
    pub fn detached_open_documents(
        &self,
        host: &mut dyn DetachedHost<V, W>,
    ) -> Vec<OpenDocumentTab> {
        let mut out = Vec::new();
        for id in self.live_ids() {
            let Some(rec) = self.rec(id) else {
                continue;
            };
            let window = rec.window.clone();
            if host.win_destroyed(&window) {
                continue;
            }
            let dirty = self.detached_is_dirty(host, id);
            // the dirty query yielded: the window may have closed meanwhile
            if host.win_destroyed(&window) {
                continue;
            }
            let Some(rec) = self.rec(id) else {
                continue;
            };
            out.push(OpenDocumentTab {
                id: format!("{ID_PREFIX}{}", rec.wc_id),
                kind: rec.kind,
                title: host.win_title(&window),
                file_path: rec.file_path.clone().filter(|p| !p.is_empty()),
                active: host.win_focused(&window),
                dirty,
            });
        }
        out
    }

    /// `detachedSetFileFor`: Save As landed on a new path
    pub fn detached_set_file_for(
        &mut self,
        host: &mut dyn DetachedHost<V, W>,
        wc_id: i64,
        file_path: &str,
    ) {
        let Some(id) = self.detached.get(&wc_id.to_string()).map(|i| RecId(*i)) else {
            return;
        };
        let Some(rec) = self.rec_mut(id) else {
            return;
        };
        rec.file_path = Some(file_path.to_owned());
        let window = rec.window.clone();
        if !host.win_destroyed(&window) {
            host.win_set_title(&window, &basename(file_path, None));
        }
        host.on_detached_changed();
    }

    /// `detachedSetTitleFor`: an untitled document named itself before its first save
    pub fn detached_set_title_for(
        &mut self,
        host: &mut dyn DetachedHost<V, W>,
        wc_id: i64,
        title: &str,
    ) {
        let Some(id) = self.detached.get(&wc_id.to_string()).map(|i| RecId(*i)) else {
            return;
        };
        let Some(rec) = self.rec(id) else {
            return;
        };
        let window = rec.window.clone();
        if truthy(rec.file_path.as_deref()).is_some() || host.win_destroyed(&window) {
            return;
        }
        host.win_set_title(&window, title);
    }

    /// `detachedRenameFile`: a rename on disk; returns the affected view
    pub fn detached_rename_file(
        &mut self,
        host: &mut dyn DetachedHost<V, W>,
        old_path: &str,
        new_path: &str,
    ) -> Option<(TabKind, V)> {
        let wanted = canonical_path(Some(old_path));
        for id in self.live_ids() {
            let Some(rec) = self.rec(id) else {
                continue;
            };
            if truthy(rec.file_path.as_deref()).is_some()
                && canonical_path(rec.file_path.as_deref()) == wanted
            {
                let window = rec.window.clone();
                let result = (rec.kind, rec.view.clone());
                if let Some(rec) = self.rec_mut(id) {
                    rec.file_path = Some(new_path.to_owned());
                }
                if !host.win_destroyed(&window) {
                    host.win_set_title(&window, &basename(new_path, None));
                }
                host.on_detached_changed();
                return Some(result);
            }
        }
        None
    }

    /// `detachedSessionTabs`: the detached documents for the session record
    pub fn detached_session_tabs(
        &self,
        host: &mut dyn DetachedHost<V, W>,
    ) -> Vec<SessionDetachedTab> {
        let mut out = Vec::new();
        for id in self.live_ids() {
            let Some(rec) = self.rec(id) else {
                continue;
            };
            let window = rec.window.clone();
            if host.win_destroyed(&window) || rec.kind == TabKind::Home || rec.kind == TabKind::Help
            {
                continue;
            }
            out.push(SessionDetachedTab {
                id: format!("{ID_PREFIX}{}", rec.wc_id),
                kind: rec.kind,
                title: host.win_title(&window),
                file_path: rec.file_path.clone().filter(|p| !p.is_empty()),
            });
        }
        out
    }

    /// `detachedFilePaths`: every detached window's open file
    pub fn detached_file_paths(&self, host: &mut dyn DetachedHost<V, W>) -> Vec<String> {
        let mut paths = Vec::new();
        for id in self.live_ids() {
            let Some(rec) = self.rec(id) else {
                continue;
            };
            let window = rec.window.clone();
            if truthy(rec.file_path.as_deref()).is_some() && !host.win_destroyed(&window) {
                paths.extend(rec.file_path.clone());
            }
        }
        paths
    }

    fn clear_dock_timer(&mut self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        let Some(r) = self.rec_mut(rec) else {
            return;
        };
        if r.dock_timer {
            host.clear_dock_timer(rec);
        }
        r.dock_timer = false;
    }

    fn clear_dock_hover(&mut self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        self.clear_dock_timer(host, rec);
        let dock_host = self.dock_host;
        let Some(r) = self.rec_mut(rec) else {
            return;
        };
        if !r.hovering {
            return;
        }
        r.hovering = false;
        if dock_host {
            host.dock_preview(None);
        }
    }

    /// `releaseDetached`: lift the document out of its window without
    /// closing the renderer: the view is unparented and the window destroyed
    /// (no close prompt). The caller re-homes the view.
    fn release_detached(
        &mut self,
        host: &mut dyn DetachedHost<V, W>,
        rec: RecId,
    ) -> DetachedTab<V> {
        self.clear_dock_hover(host, rec);
        let (window, view, kind, file_path, wc_id) = {
            let Some(r) = self.rec_mut(rec) else {
                panic!("a released record is in the arena until its window closed");
            };
            r.released = true;
            (
                r.window.clone(),
                r.view.clone(),
                r.kind,
                r.file_path.clone(),
                r.wc_id,
            )
        };
        if self.torn_is(rec) {
            self.torn = None;
        }
        let title = if host.win_destroyed(&window) {
            match truthy(file_path.as_deref()) {
                Some(path) => basename(path, None),
                None => String::new(),
            }
        } else {
            host.win_title(&window)
        };
        self.detached.delete(&wc_id.to_string());
        if !host.win_destroyed(&window) {
            host.content_remove_child_view(&window, &view);
            host.win_destroy(&window);
        }
        host.on_detached_changed();
        DetachedTab {
            view,
            kind,
            title,
            file_path,
        }
    }

    /// `dockDetachedWindow`
    fn dock_detached_window(&mut self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        let Some(r) = self.rec(rec) else {
            return;
        };
        let window = r.window.clone();
        if !self.dock_host || r.released || host.win_destroyed(&window) {
            return;
        }
        let tab = self.release_detached(host, rec);
        host.dock(tab);
    }

    /// `trackDockHover`: sample the cursor against the shell strip's dock
    /// band. Inside: indicator and dwell timer; outside: clear both.
    fn track_dock_hover(&mut self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        let Some(r) = self.rec(rec) else {
            return;
        };
        if r.released || !self.dock_host {
            return;
        }
        let band = host.dock_band();
        let cursor = host.cursor_point();
        let Some(band) = band.filter(|b| point_in_rect(cursor.0, cursor.1, b)) else {
            self.clear_dock_hover(host, rec);
            return;
        };
        if let Some(r) = self.rec_mut(rec) {
            r.hovering = true;
        }
        host.dock_preview(Some(cursor.0 - band.x));
        self.clear_dock_timer(host, rec);
        host.arm_dock_timer(rec, DOCK_DWELL_MS);
        if let Some(r) = self.rec_mut(rec) {
            r.dock_timer = true;
        }
    }

    /// the callback of the dwell timer: docks once the cursor has rested over
    /// the strip
    pub fn dock_timer_fired(&mut self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        if let Some(r) = self.rec_mut(rec) {
            r.dock_timer = false;
        }
        let now_band = if self.dock_host {
            host.dock_band()
        } else {
            None
        };
        let now = host.cursor_point();
        if now_band.is_some_and(|b| point_in_rect(now.0, now.1, &b)) {
            self.dock_detached_window(host, rec);
        } else {
            self.clear_dock_hover(host, rec);
        }
    }

    /// `layout` of one window: fit its view to the window's content
    fn layout_window(&self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        let Some(r) = self.rec(rec) else {
            return;
        };
        let (window, view) = (r.window.clone(), r.view.clone());
        if host.win_destroyed(&window) {
            return;
        }
        let bounds = host.win_content_bounds(&window);
        // a minimized or mid-restore window can report a degenerate client rect
        if !is_settled_rect(&bounds) {
            return;
        }
        host.set_bounds(
            &view,
            &Rect {
                x: 0.0,
                y: 0.0,
                width: bounds.width,
                height: bounds.height,
            },
        );
    }

    /// the window's `resize`: a layout now and one on the next tick
    pub fn on_resize(&self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        self.layout_window(host, rec);
        host.defer_layout(rec);
    }

    /// the window's `restore`: the same as `resize`
    pub fn on_restore(&self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        self.layout_window(host, rec);
        host.defer_layout(rec);
    }

    /// the `setImmediate` callback of `on_resize` and `on_restore`
    pub fn run_deferred_layout(&self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        self.layout_window(host, rec);
    }

    /// the window's `focus`: it claims the process-global menu and
    /// active-editor targets
    pub fn on_focus(&self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        let Some(r) = self.rec(rec) else {
            return;
        };
        let (kind, view) = (r.kind, r.view.clone());
        if kind == TabKind::Docs {
            host.set_active_docs_resolver(Some(&view), true);
        }
        if kind == TabKind::Sheets {
            host.set_active_sheets_web_contents(Some(&view));
        }
        if kind == TabKind::Slides {
            host.set_active_slides_web_contents(&view);
        }
        host.apply_menu_for(kind);
    }

    /// the window's `move`: dragging the title bar over the shell's tab strip
    /// docks the document back; a torn-off window is steered by the pointer
    pub fn on_move(&mut self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        if self.torn_is(rec) {
            return;
        }
        self.track_dock_hover(host, rec);
    }

    /// the window's `moved`, registered only on Windows (it reports the end
    /// of a native drag there): commit right away instead of waiting out the
    /// dwell
    pub fn on_moved(&mut self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        let hovering = self.rec(rec).is_some_and(|r| r.hovering);
        if self.torn_is(rec) || !hovering {
            return;
        }
        self.track_dock_hover(host, rec);
        if self.rec(rec).is_some_and(|r| r.hovering) {
            self.dock_detached_window(host, rec);
        }
    }

    /// the window's `close`: the unsaved-changes guard. True when the
    /// handler called `event.preventDefault()`.
    pub fn on_close(&mut self, host: &mut dyn DetachedHost<V, W>, rec: RecId) -> bool {
        let Some(r) = self.rec_mut(rec) else {
            return false;
        };
        if r.close_confirmed || r.released {
            return false;
        }
        // a second close event while the prompt is open must not re-enter the
        // prompt
        if r.prompt_in_flight {
            return true;
        }
        r.prompt_in_flight = true;
        let (kind, view) = (r.kind, r.view.clone());
        match self.confirm_detached_close(host, rec) {
            Ok(true) => self.tear_down(host, rec),
            Ok(false) => {
                // a denied close vetoes any quit that was in flight
                host.reset_sheets_shutting_down();
                // so is a "Restart & Install" waiting on that quit
                host.cancel_update_restart();
                // a "Don't Save" answered before the denial no longer holds
                host.resume_discarded_copies();
                if kind == TabKind::Pdf {
                    host.pdf_close_cancelled(&view);
                }
            }
            Err(error) => {
                host.console_error("[shell] detached window close prompt failed:", &error);
                host.reset_sheets_shutting_down();
                host.cancel_update_restart();
                host.resume_discarded_copies();
            }
        }
        if let Some(r) = self.rec_mut(rec) {
            r.prompt_in_flight = false;
        }
        true
    }

    /// the window's `closed`
    pub fn on_closed(&mut self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        let Some(wc_id) = self.rec(rec).map(|r| r.wc_id) else {
            return;
        };
        self.clear_dock_hover(host, rec);
        if self.torn_is(rec) {
            self.torn = None;
        }
        self.detached.delete(&wc_id.to_string());
        host.on_detached_changed();
        // nothing reaches the record after its window closed
        self.records[rec.0] = None;
    }

    /// `tearDown` (the record's `closeWithoutPrompt`): detach the view before
    /// destroying the window so the docs teardown path stays in control of
    /// the renderer's lifetime
    pub fn tear_down(&mut self, host: &mut dyn DetachedHost<V, W>, rec: RecId) {
        let Some(r) = self.rec(rec) else {
            return;
        };
        let (window, view, kind, wc_id) = (r.window.clone(), r.view.clone(), r.kind, r.wc_id);
        if host.win_destroyed(&window) || r.released {
            return;
        }
        if let Some(r) = self.rec_mut(rec) {
            r.close_confirmed = true;
        }
        self.clear_dock_hover(host, rec);
        if self.torn_is(rec) {
            self.torn = None;
        }
        host.content_remove_child_view(&window, &view);
        self.detached.delete(&wc_id.to_string());
        if kind == TabKind::Docs {
            host.teardown_docs_renderer(&view);
            host.release_closed_renderer(&view);
        } else {
            host.close_view(&view);
        }
        host.win_destroy(&window);
    }

    /// `createDetachedEditorWindow`: the registry entry and the window's
    /// first layout, focus or tear-off placement; the caller wires the
    /// window's events to the `on_*` methods with the returned id
    pub fn create(
        &mut self,
        host: &mut dyn DetachedHost<V, W>,
        options: DetachedWindowOptions<V>,
    ) -> RecId {
        let DetachedWindowOptions {
            view,
            kind,
            title,
            file_path,
            tear_off_at,
        } = options;
        let size = default_size(kind);
        let origin = tear_off_at.map(|at| {
            let area = host.display_work_area(at);
            tear_off_origin(&area, at, size)
        });
        let window = host.create_window(&WindowOptions {
            width: size.0,
            height: size.1,
            origin,
            min_width: 720.0,
            min_height: 550.0,
            title,
            show: tear_off_at.is_none(),
            auto_hide_menu_bar: true,
        });
        let wc_id = host.view_id(&view);
        let rec = RecId(self.records.len());
        self.records.push(Some(DetachedRecord {
            window: window.clone(),
            view: view.clone(),
            wc_id,
            kind,
            file_path,
            released: false,
            hovering: false,
            dock_timer: false,
            close_confirmed: false,
            prompt_in_flight: false,
        }));
        self.detached.set(wc_id.to_string(), rec.0);
        host.on_detached_changed();

        host.content_add_child_view(&window, &view);
        self.layout_window(host, rec);
        host.set_visible(&view, true);
        if let Some(at) = tear_off_at {
            let pos = host.win_position(&window);
            self.torn = Some(Torn {
                rec,
                grab_dx: at.0 - pos.0,
                grab_dy: at.1 - pos.1,
            });
            host.win_show_inactive(&window);
        } else {
            host.focus_view(&view);
        }
        rec
    }

    /// `dragTornWindow`: steer the torn-off window after the held pointer
    /// (screen coordinates)
    pub fn drag_torn_window(&self, host: &mut dyn DetachedHost<V, W>, x: f64, y: f64) {
        let Some(torn) = &self.torn else {
            return;
        };
        let Some(r) = self.rec(torn.rec) else {
            return;
        };
        let window = r.window.clone();
        if host.win_destroyed(&window) {
            return;
        }
        host.win_set_position(&window, to_int(x - torn.grab_dx), to_int(y - torn.grab_dy));
    }

    /// `endTornDrag`: the pointer was released; the torn-off window is an
    /// ordinary detached window now
    pub fn end_torn_drag(&mut self, host: &mut dyn DetachedHost<V, W>) {
        let rec = self.torn.take().map(|t| t.rec);
        let Some(rec) = rec else {
            return;
        };
        let Some(r) = self.rec(rec) else {
            return;
        };
        let (window, view) = (r.window.clone(), r.view.clone());
        if host.win_destroyed(&window) {
            return;
        }
        host.win_focus(&window);
        host.focus_view(&view);
    }

    /// `takeTornTab`: the held pointer came back over the strip; take the
    /// document out of the torn-off window (destroying it)
    pub fn take_torn_tab(&mut self, host: &mut dyn DetachedHost<V, W>) -> Option<DetachedTab<V>> {
        let rec = self.torn.take().map(|t| t.rec)?;
        let r = self.rec(rec)?;
        let window = r.window.clone();
        if r.released || host.win_destroyed(&window) {
            return None;
        }
        Some(self.release_detached(host, rec))
    }

    /// `isTearingOff`: a torn-off window is following the shell's held pointer
    pub fn is_tearing_off(&self, host: &mut dyn DetachedHost<V, W>) -> bool {
        let Some(torn) = &self.torn else {
            return false;
        };
        let Some(r) = self.rec(torn.rec) else {
            return false;
        };
        let window = r.window.clone();
        !host.win_destroyed(&window)
    }
}

impl<V: Clone + PartialEq, W: Clone + PartialEq> Default for DetachedWindows<V, W> {
    fn default() -> Self {
        DetachedWindows::new()
    }
}
