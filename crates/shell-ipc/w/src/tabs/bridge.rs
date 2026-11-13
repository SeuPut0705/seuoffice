//! The one object `TabManager` and `DetachedWindows` are called with: it
//! answers their host traits ([`TabHost`], [`DetachedHost`], [`EditorCalls`])
//! from the two traits of this area ([`WindowsHost`], [`TabHooks`]).
//!
//! `TabManager` holds `&mut self` while it calls its host, so the host cannot
//! read the manager back. What the TypeScript did there with the manager
//! (`onChanged` sends `manager.list()`, `dock` attaches the tab) becomes an
//! [`Effect`] the bridge queues and the state runs when the manager call has
//! returned, in the order the calls were made.

use std::collections::VecDeque;
use std::rc::Rc;
use std::sync::Arc;

use main_core::shell::detached_windows::{
    DetachedHost, RecId, ShellWindowState, WindowOptions, dock_band_for,
};
use main_core::shell::split_layout::Rect;
use main_core::shell::tab_lifecycle::{RecentlyClosedTracker, create_recently_closed_tracker};
use main_core::shell::tab_manager::{
    Deferred, DetachedTab, DiagramIdentity, EditorCalls, LoadedTabView, Opener, Ready,
    SplitViewState, TabHost, TabKind, TabResult, UnloadedTabOpenContext, ViewSpec,
};
use serde_json::Value;
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::ipc::{EventSink, Target};
use shell_contract::value::IpcValue;

use super::host::{ShellWindow, TabHooks, TimerKey, ViewListen, WindowsHost};

/// Work for after the manager call that asked for it
pub(super) enum Effect {
    /// `onChanged`
    Changed,
    /// `onSplitChanged`
    SplitChanged(Option<SplitViewState>),
    /// `dockHost.dock(tab)`
    Dock(DetachedTab<ViewId>),
}

pub(super) struct Bridge {
    pub windows: Arc<dyn WindowsHost>,
    pub hooks: Rc<dyn TabHooks>,
    pub events: Arc<dyn EventSink>,
    /// the shell window while there is one
    pub shell: Option<ShellWindow>,
    pub effects: VecDeque<Effect>,
    /// `createDetachedEditorWindow` made this window last: the state files it
    /// with the record `create` returns
    pub created: Option<WindowId>,
    /// `recentlyClosed`, fed by the manager's closed listener
    pub recently_closed: RecentlyClosedTracker,
    pub settings_path: String,
    next_ready: u64,
}

impl Bridge {
    pub fn new(
        windows: Arc<dyn WindowsHost>,
        hooks: Rc<dyn TabHooks>,
        events: Arc<dyn EventSink>,
    ) -> Bridge {
        Bridge {
            windows,
            hooks,
            events,
            shell: None,
            effects: VecDeque::new(),
            created: None,
            recently_closed: create_recently_closed_tracker(
                main_core::shell::tab_lifecycle::MAX_RECENTLY_CLOSED,
            ),
            settings_path: String::new(),
            next_ready: 1,
        }
    }

    /// `webContents.send(channel, ...args)` of the shell window's own view
    pub fn send_to_shell(&self, channel: &'static str, args: Vec<IpcValue>) {
        if let Some(shell) = self.shell
            && !self.windows.window_state(shell.window).destroyed
        {
            self.events.emit(Target::View(shell.view), channel, args);
        }
    }

    fn shell_window(&self) -> Option<WindowId> {
        self.shell.map(|s| s.window)
    }

    fn shell_state(&self) -> Option<crate::tabs::host::WindowState> {
        self.shell.map(|s| self.windows.window_state(s.window))
    }
}

impl EditorCalls<ViewId> for Bridge {
    fn view_id(&mut self, view: &ViewId) -> i64 {
        view.0 as i64
    }
    fn view_destroyed(&mut self, view: &ViewId) -> bool {
        self.windows.view_destroyed(*view)
    }
    fn set_visible(&mut self, view: &ViewId, visible: bool) {
        self.windows.view_set_visible(*view, visible)
    }
    fn set_bounds(&mut self, view: &ViewId, bounds: &Rect) {
        self.windows.view_set_bounds(*view, bounds)
    }
    fn focus_view(&mut self, view: &ViewId) {
        self.windows.view_focus(*view)
    }
    fn close_view(&mut self, view: &ViewId) {
        self.windows.view_close(*view)
    }
    fn sheets_pending_edit_count(&mut self, wc_id: i64) -> f64 {
        self.hooks.sheets_pending_edit_count(wc_id)
    }
    fn family_is_dirty(&mut self, kind: TabKind, wc_id: i64) -> bool {
        self.hooks.family_is_dirty(kind, wc_id)
    }
    fn hwp_memo_modal_open(&mut self, wc_id: i64) -> bool {
        self.hooks.hwp_memo_modal_open(wc_id)
    }
    fn set_active_docs_resolver(&mut self, view: Option<&ViewId>, null_if_destroyed: bool) {
        self.hooks
            .set_active_docs_resolver(view.copied(), null_if_destroyed)
    }
    fn set_active_sheets_web_contents(&mut self, view: Option<&ViewId>) {
        self.hooks.set_active_sheets_web_contents(view.copied())
    }
    fn set_active_slides_web_contents(&mut self, view: &ViewId) {
        self.hooks.set_active_slides_web_contents(*view)
    }
    fn apply_menu_for(&mut self, kind: TabKind) {
        self.hooks.apply_menu_for(kind)
    }
    fn teardown_docs_renderer(&mut self, view: &ViewId) {
        self.hooks.teardown_docs_renderer(*view)
    }
    fn release_closed_renderer(&mut self, view: &ViewId) {
        self.hooks.release_closed_renderer(*view)
    }
}

impl TabHost<ViewId> for Bridge {
    fn window_destroyed(&mut self) -> bool {
        self.shell_state().is_none_or(|s| s.destroyed)
    }
    fn window_minimized(&mut self) -> bool {
        self.shell_state().is_some_and(|s| s.minimized)
    }
    fn window_focused(&mut self) -> bool {
        self.shell_state().is_some_and(|s| s.focused)
    }
    fn window_content_size(&mut self) -> (f64, f64) {
        self.shell_state().map_or((0.0, 0.0), |s| {
            (s.content_bounds.width, s.content_bounds.height)
        })
    }
    fn add_child_view(&mut self, view: &ViewId) {
        if let Some(window) = self.shell_window() {
            self.windows.add_child_view(window, *view)
        }
    }
    fn remove_child_view(&mut self, view: &ViewId) {
        if let Some(window) = self.shell_window() {
            self.windows.remove_child_view(window, *view)
        }
    }
    fn focus_shell_contents(&mut self) {
        if let Some(shell) = self.shell {
            self.windows.view_focus(shell.view)
        }
    }
    fn reload_view(&mut self, view: &ViewId) {
        self.windows.view_reload(*view)
    }
    fn load_url(&mut self, view: &ViewId, url: &str) {
        self.windows.view_load_url(*view, url)
    }
    fn listen_html_full_screen(&mut self, view: &ViewId) {
        self.windows.view_listen(*view, ViewListen::HtmlFullScreen)
    }
    fn listen_pane_focus(&mut self, view: &ViewId) {
        self.windows.view_listen(*view, ViewListen::PaneFocus)
    }
    fn once_render_process_gone(&mut self, view: &ViewId) {
        self.windows
            .view_listen(*view, ViewListen::RenderProcessGone)
    }
    fn page_loaded(&mut self, view: &ViewId) -> Ready {
        let token = self.next_ready;
        self.next_ready += 1;
        self.windows.watch_page_load(*view, token);
        Ready(PAGE_READY_BASE + token)
    }
    fn on_changed(&mut self) {
        self.effects.push_back(Effect::Changed);
    }
    fn on_split_changed(&mut self, state: Option<&SplitViewState>) {
        self.effects.push_back(Effect::SplitChanged(state.cloned()));
    }
    fn on_tab_closed(&mut self, kind: TabKind, file_path: &str) {
        self.recently_closed
            .push(Some(kind.as_str()), Some(file_path));
    }
    fn untitled_title_for(&mut self, kind: TabKind) -> Option<String> {
        // no file yet: the title becomes the real filename once the first save lands
        let key = match kind {
            TabKind::Help => "menuUserGuide",
            TabKind::Docs => "untitledDoc",
            TabKind::Slides => "untitledDeck",
            TabKind::Markdown => "untitledMarkdown",
            TabKind::Html => "untitledHtml",
            TabKind::Mindmap => "untitledMindmap",
            TabKind::Hwp => "untitledHwp",
            TabKind::Diagram => "untitledDiagram",
            _ => "untitledSheet",
        };
        Some(self.hooks.tm(key))
    }
    fn ui_scale(&mut self) -> f64 {
        self.hooks.ui_scale()
    }
    fn no_spare_view_env(&mut self) -> bool {
        self.hooks.no_spare_view_env()
    }
    fn renderer_dev_url(&mut self) -> Option<String> {
        self.hooks.renderer_dev_url()
    }
    fn set_spare_timer(&mut self, delay_ms: f64) {
        self.windows.set_timer(TimerKey::SpareSheets, delay_ms)
    }
    fn clear_spare_timer(&mut self) {
        self.windows.clear_timer(TimerKey::SpareSheets)
    }
    fn defer(&mut self, step: Deferred) {
        self.windows.set_timer(TimerKey::Tab(step), 0.0)
    }
    fn create_view(&mut self, spec: &ViewSpec<'_>) -> TabResult<ViewId> {
        self.hooks.create_view(spec)
    }
    fn create_help_view(&mut self) -> ViewId {
        self.windows.create_help_view()
    }
    fn mark_docs_new_blank(&mut self, wc_id: i64) {
        self.hooks.mark_docs_new_blank(wc_id)
    }
    fn queue_docs_ai_content(&mut self, wc_id: i64, content: &Value) {
        self.hooks.queue_docs_ai_content(wc_id, content)
    }
    fn queue_docs_copy(&mut self, wc_id: i64, path: &str, name: &str) {
        self.hooks.queue_docs_copy(wc_id, path, name)
    }
    fn set_sheets_new_blank(&mut self) {
        self.hooks.set_sheets_new_blank()
    }
    fn queue_workbook_for_view(&mut self, view: &ViewId, path: &str) {
        self.hooks.queue_workbook_for_view(*view, path)
    }
    fn nudge_queued_workbook(&mut self, view: &ViewId) {
        self.hooks.nudge_queued_workbook(*view)
    }
    fn mark_pdf_untitled_copy(&mut self, path: &str) {
        self.hooks.mark_pdf_untitled_copy(path)
    }
    fn clear_pdf_dirty(&mut self, wc_id: i64) {
        self.hooks.clear_pdf_dirty(wc_id)
    }
    fn queue_markdown_seed_for(&mut self, view: &ViewId, text: &str) {
        self.hooks.queue_markdown_seed_for(*view, text)
    }
    fn queue_html_seed_for(&mut self, view: &ViewId, text: &str) {
        self.hooks.queue_html_seed_for(*view, text)
    }
    fn queue_mindmap_seed_for(&mut self, view: &ViewId, bytes: &[u8]) {
        self.hooks.queue_mindmap_seed_for(*view, bytes)
    }
    fn queue_slides_seed_for(&mut self, view: &ViewId, bytes: &[u8], suggested_name: &str) {
        self.hooks
            .queue_slides_seed_for(*view, bytes, suggested_name)
    }
    fn queue_generate_handoff_for(&mut self, view: &ViewId, handoff: &Value) {
        self.hooks.queue_generate_handoff_for(*view, handoff)
    }
    fn queue_converted_content(&mut self, view: &ViewId, doc: &Value) {
        self.hooks.queue_converted_content(*view, doc)
    }
    fn drop_generate_handoff(&mut self, wc_id: i64) {
        self.hooks.drop_generate_handoff(wc_id)
    }
    fn diagram_tab_identity(&mut self, wc_id: i64) -> Option<DiagramIdentity> {
        self.hooks.diagram_tab_identity(wc_id)
    }
    fn opener_open(
        &mut self,
        opener: &Opener,
        context: &UnloadedTabOpenContext,
    ) -> Result<LoadedTabView<ViewId>, String> {
        self.hooks.opener_open(opener, context)
    }
    fn warn(&mut self, message: &str, error: &str) {
        self.hooks.warn(message, error)
    }
}

/// the readies of a page load are numbered above every opener's
pub(super) const PAGE_READY_BASE: u64 = 1 << 32;

impl DetachedHost<ViewId, WindowId> for Bridge {
    fn create_window(&mut self, options: &WindowOptions) -> WindowId {
        let window = self.windows.create_window(options);
        self.created = Some(window);
        window
    }
    fn win_destroyed(&mut self, win: &WindowId) -> bool {
        self.windows.window_state(*win).destroyed
    }
    fn win_minimized(&mut self, win: &WindowId) -> bool {
        self.windows.window_state(*win).minimized
    }
    fn win_focused(&mut self, win: &WindowId) -> bool {
        self.windows.window_state(*win).focused
    }
    fn win_restore(&mut self, win: &WindowId) {
        self.windows.window_restore(*win)
    }
    fn win_show(&mut self, win: &WindowId) {
        self.windows.window_show(*win)
    }
    fn win_show_inactive(&mut self, win: &WindowId) {
        self.windows.window_show_inactive(*win)
    }
    fn win_focus(&mut self, win: &WindowId) {
        self.windows.window_focus(*win)
    }
    fn win_destroy(&mut self, win: &WindowId) {
        self.windows.window_destroy(*win)
    }
    fn win_title(&mut self, win: &WindowId) -> String {
        self.windows.window_state(*win).title
    }
    fn win_set_title(&mut self, win: &WindowId, title: &str) {
        self.windows.window_set_title(*win, title)
    }
    fn win_content_bounds(&mut self, win: &WindowId) -> Rect {
        self.windows.window_state(*win).content_bounds
    }
    fn win_position(&mut self, win: &WindowId) -> (f64, f64) {
        self.windows.window_state(*win).position
    }
    fn win_set_position(&mut self, win: &WindowId, x: f64, y: f64) {
        self.windows.window_set_position(*win, x, y)
    }
    fn content_add_child_view(&mut self, win: &WindowId, view: &ViewId) {
        self.windows.add_child_view(*win, *view)
    }
    fn content_remove_child_view(&mut self, win: &WindowId, view: &ViewId) {
        self.windows.remove_child_view(*win, *view)
    }
    fn display_work_area(&mut self, at: (f64, f64)) -> Rect {
        self.windows.display_work_area(at)
    }
    fn cursor_point(&mut self) -> (f64, f64) {
        self.windows.cursor_point()
    }
    fn dock_band(&mut self) -> Option<Rect> {
        let shell = self.shell_state().map(|s| ShellWindowState {
            destroyed: s.destroyed,
            visible: s.visible,
            minimized: s.minimized,
            content_bounds: s.content_bounds,
        });
        dock_band_for(shell.as_ref(), self.hooks.ui_scale())
    }
    fn dock_preview(&mut self, x: Option<f64>) {
        let value = match x {
            Some(x) => IpcValue::Object(vec![("x".into(), IpcValue::Number(x))]),
            None => IpcValue::Null,
        };
        self.send_to_shell("tabs:dock-preview", vec![value]);
    }
    fn dock(&mut self, tab: DetachedTab<ViewId>) {
        self.effects.push_back(Effect::Dock(tab));
    }
    fn on_detached_changed(&mut self) {
        self.hooks.detached_changed()
    }
    fn arm_dock_timer(&mut self, rec: RecId, delay_ms: f64) {
        self.windows.set_timer(TimerKey::Dock(rec), delay_ms)
    }
    fn clear_dock_timer(&mut self, rec: RecId) {
        self.windows.clear_timer(TimerKey::Dock(rec))
    }
    fn defer_layout(&mut self, rec: RecId) {
        self.windows.set_timer(TimerKey::DetachedLayout(rec), 0.0)
    }
    fn reset_sheets_shutting_down(&mut self) {
        self.hooks.reset_sheets_shutting_down()
    }
    fn cancel_update_restart(&mut self) {
        self.hooks.cancel_update_restart()
    }
    fn resume_discarded_copies(&mut self) {
        self.hooks.resume_discarded_copies()
    }
    fn pdf_close_cancelled(&mut self, view: &ViewId) {
        self.hooks.pdf_close_cancelled(*view)
    }
    fn console_error(&mut self, message: &str, error: &str) {
        self.hooks.warn(message, error)
    }
}
