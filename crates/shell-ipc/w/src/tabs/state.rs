//! The state of the tabs and windows of the shell: one [`TabsState`] on the
//! core thread owns main-core's `TabManager` and `DetachedWindows` and the
//! bookkeeping `apps/shell/src/main/index.ts` kept in module variables
//! (`lastDockIndex`, `tornSplitDrag`, `lastSplitState`, ...). Every handler of
//! this area is a method of it.
//!
//! Nothing here waits for a renderer or a menu. A close that needs the
//! editor's answer is a [`TabCloseStep`] carried out through
//! `DocumentEditors::request_close` with the rest of the run in the answer's
//! continuation; a popup menu answers later as a [`HostEvent::Menu`].

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::sync::Arc;

use main_core::shell::detached_windows::{
    DetachedCloseStep, DetachedWindowOptions, DetachedWindows, RecId,
};
use main_core::shell::split_layout::{
    DragSplit, DraggedTab, Pane, Rect, SPLIT_EVEN_RATIO, SplitDragContext, SplitDropIntent,
    SplitOrientation, decide_split_drop, pane_rects, split_drop_zone,
};
use main_core::shell::split_memory::{
    SettingsPath, SplitMemoryOptions, SplitMemoryState, write_split_memory,
};
use main_core::shell::tab_lifecycle::{
    CloseInOrder, CloseInOrderStep, TabCloseManager, TabCloseTarget,
};
use main_core::shell::tab_manager::{
    DetachedTab, Ready, SplitViewState, TabCloseStep, TabHost, TabKind, TabManager, canonical_path,
    tab_strip_height,
};
use shell_contract::editors::editor_for;
use shell_contract::error::IpcError;
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::ipc::{EventSink, Target};
use shell_contract::provided::Provided;
use shell_contract::runtime::{PathName, Services};
use shell_contract::value::IpcValue;

use super::bridge::{Bridge, Effect};
use super::host::{
    HostEvent, HostEvents, MenuEntry, TabHooks, TabsChanged, TimerKey, ViewHappened, WindowEvent,
    WindowsHost,
};
use super::wire::to_ipc;

/// What a tear-off drag remembers about the split drop zones: captured
/// before the tab leaves the strip, because tearing a pane tab out drops the
/// split (`TornSplitDrag`)
#[derive(Clone, Debug)]
pub(super) struct TornSplitDrag {
    pub tab_id: String,
    pub file_path: Option<String>,
    pub split_at_start: Option<SplitViewState>,
}

/// A pending menu: what each entry does, and the invoke waiting for the menu
/// to close (the `Menu.popup` call returned only then)
pub(super) struct PendingMenu {
    pub actions: HashMap<u32, super::menus::MenuAction>,
    pub reply: Option<shell_contract::ipc::Responder>,
}

pub(super) struct Inner {
    pub manager: Option<TabManager<ViewId>>,
    pub detached: DetachedWindows<ViewId, WindowId>,
    pub bridge: Bridge,
    /// the record of each detached window
    pub recs: HashMap<WindowId, RecId>,
    /// `lastDockIndex`
    pub last_dock_index: Option<f64>,
    /// `tornSplitDrag`, `tornSplitDrop`, `lastSplitHint`
    pub torn_drag: Option<TornSplitDrag>,
    pub torn_drop: Option<SplitDropIntent>,
    pub last_hint: Option<IpcValue>,
    /// `lastSplitState` and whether `splitMemoryTimer` is armed
    pub last_split_state: Option<SplitViewState>,
    pub split_timer: bool,
    /// `pendingNewFileDir` and `pendingDirByWc` with their `setAt`
    pub pending_new_dir: HashMap<String, (String, f64)>,
    pub pending_dir_by_wc: HashMap<i64, (String, f64)>,
}

pub struct TabsState {
    pub(super) inner: RefCell<Inner>,
    pub(super) windows: Arc<dyn WindowsHost>,
    pub(super) hooks: Rc<dyn TabHooks>,
    pub(super) events: Arc<dyn EventSink>,
    pub(super) provided: Rc<Provided>,
    pub(super) services: Services,
    pub(super) menus: RefCell<HashMap<u64, PendingMenu>>,
    pub(super) next_menu: Cell<u64>,
    pub(super) this: Weak<TabsState>,
}

thread_local! {
    /// The state of this core thread: the host reports its events to it
    static CURRENT: RefCell<Option<Rc<TabsState>>> = const { RefCell::new(None) };
}

/// Where the host's events go: onto the core thread, into [`TabsState::host_event`]
struct Reporter {
    core: Arc<dyn shell_contract::runtime::Thread>,
}

impl HostEvents for Reporter {
    fn send(&self, event: HostEvent) {
        self.core.post(Box::new(move || {
            let state = CURRENT.with(|c| c.borrow().clone());
            if let Some(state) = state {
                state.host_event(event);
            }
        }));
    }
}

/// `TabCloseManager` over a snapshot of the strip
struct Strip(Vec<TabCloseTarget>);

impl TabCloseManager for Strip {
    fn list(&mut self) -> Vec<TabCloseTarget> {
        self.0.clone()
    }
}

pub(super) fn app_settings_path(services: &Services) -> String {
    services
        .paths
        .path(PathName::UserData)
        .join("app-settings.json")
        .to_string_lossy()
        .into_owned()
}

fn split_shape(state: &Option<SplitViewState>) -> String {
    match state {
        None => "none".to_owned(),
        Some(s) => format!(
            "{}|{}|{}|{}",
            s.a_tab_id,
            s.b_tab_id,
            s.orientation.as_str(),
            s.focus.as_str()
        ),
    }
}

impl Inner {
    /// Calls `f` on the manager and the host, then runs the effects the call
    /// queued. `None` while there is no shell window.
    pub(super) fn manager_call<R>(
        &mut self,
        f: impl FnOnce(&mut TabManager<ViewId>, &mut Bridge) -> R,
    ) -> Option<R> {
        let out = self.manager.as_mut().map(|m| f(m, &mut self.bridge));
        self.drain();
        out
    }

    /// `ensureTabManager`: the shell window and its manager, made when a
    /// detached editor outlived them
    pub(super) fn ensure_manager(&mut self) -> bool {
        if self.manager.is_none() {
            let shell = self.bridge.windows.create_shell_window();
            self.bridge.shell = Some(shell);
            self.manager = Some(TabManager::new());
            self.detached.set_dock_host(true);
        }
        true
    }

    /// Runs what the host calls queued, in the order they were made
    pub(super) fn drain(&mut self) {
        while let Some(effect) = self.bridge.effects.pop_front() {
            match effect {
                Effect::Changed => self.on_changed(),
                Effect::SplitChanged(state) => self.on_split_changed(state),
                Effect::Dock(tab) => self.dock(tab),
            }
        }
    }

    /// `createShellWindow`'s `onChanged`
    fn on_changed(&mut self) {
        let Some(manager) = &self.manager else {
            return;
        };
        let tabs = manager.list();
        let list = IpcValue::Array(tabs.iter().map(|t| to_ipc(&t.to_value())).collect());
        self.bridge.send_to_shell("tabs:changed", vec![list]);
        let open_paths = manager.open_file_paths();
        let detached_paths = self.detached.detached_file_paths(&mut self.bridge);
        let changed = TabsChanged {
            open_paths,
            detached_paths,
            tabs,
        };
        self.bridge.hooks.tabs_changed(&changed);
    }

    /// `handleSplitChanged`: tell every pane view its role, push the state to
    /// the strip and remember the arrangement. A divider drag changes only the
    /// ratio, so its memory write is debounced.
    fn on_split_changed(&mut self, state: Option<SplitViewState>) {
        let ratio_only = state.is_some()
            && self.last_split_state.is_some()
            && split_shape(&state) == split_shape(&self.last_split_state);
        self.last_split_state = state.clone();
        self.bridge.hooks.split_changed(state.as_ref());
        if !ratio_only {
            self.notify_split_roles();
        }
        let value = state
            .as_ref()
            .map_or(IpcValue::Null, |s| to_ipc(&s.to_value()));
        self.bridge.send_to_shell("tabs:split-changed", vec![value]);
        if self.split_timer {
            self.bridge.windows.clear_timer(TimerKey::SplitMemory);
            self.split_timer = false;
        }
        if ratio_only {
            self.bridge.windows.set_timer(TimerKey::SplitMemory, 400.0);
            self.split_timer = true;
        } else {
            self.persist_split_memory(state.as_ref());
        }
    }

    /// `notifySplitRoles`: the pane role of every tab view (null: not in a split)
    pub(super) fn notify_split_roles(&mut self) {
        let Some(manager) = &self.manager else {
            return;
        };
        for tab in manager.list() {
            let Some(view) = manager.web_contents_for_tab(&tab.id) else {
                continue;
            };
            if self.bridge.windows.view_destroyed(view) {
                continue;
            }
            let role = manager.split_role_of(&mut self.bridge, view.0 as i64);
            self.bridge.events.emit(
                Target::View(view),
                "app:split-role-changed",
                vec![role.map_or(IpcValue::Null, |r| IpcValue::String(r.as_str().into()))],
            );
        }
    }

    /// `persistSplitMemory`: best-effort, a failed write never disturbs the split
    pub(super) fn persist_split_memory(&mut self, state: Option<&SplitViewState>) {
        let Some(manager) = &self.manager else {
            return;
        };
        let path = self.bridge.settings_path.clone();
        let options = SplitMemoryOptions {
            settings_path: SettingsPath::Fixed(path),
            read_settings: None,
            write_setting: None,
        };
        let memory = state.map(|s| {
            let tabs = manager.list();
            let path_of = |id: &str| {
                tabs.iter()
                    .find(|t| t.id == id)
                    .and_then(|t| t.file_path.clone())
            };
            SplitMemoryState {
                a_tab_id_path: path_of(&s.a_tab_id),
                b_tab_id_path: path_of(&s.b_tab_id),
                orientation: Some(s.orientation.as_str().to_owned()),
                ratio: Some(s.ratio),
                focus: Some(s.focus.as_str().to_owned()),
            }
        });
        let _ = write_split_memory(memory.as_ref(), &options);
    }

    /// `dockHost.dock`: a detached window dragged over the strip hands its
    /// document back
    fn dock(&mut self, tab: DetachedTab<ViewId>) {
        let index = self.last_dock_index.take();
        self.bridge
            .send_to_shell("tabs:dock-preview", vec![IpcValue::Null]);
        self.manager_call(|m, b| m.attach_tab(b, tab, index, true));
        let Some(shell) = self.bridge.shell else {
            return;
        };
        let windows = self.bridge.windows.clone();
        if windows.window_state(shell.window).minimized {
            windows.window_restore(shell.window);
        }
        windows.window_show(shell.window);
        windows.window_focus(shell.window);
    }

    /// `splitPaneOfDocument`: the pane whose document is the one a menu or a
    /// drag is about: the same tab id, or a copy of the same canonical file
    pub(super) fn split_pane_of_document(
        &self,
        split: Option<&SplitViewState>,
        tab_id: &str,
        file_path: Option<&str>,
    ) -> Option<Pane> {
        let split = split?;
        let tabs = self.manager.as_ref()?.list();
        let wanted = canonical_path(file_path);
        for side in [Pane::A, Pane::B] {
            let pane_id = if side == Pane::A {
                &split.a_tab_id
            } else {
                &split.b_tab_id
            };
            if pane_id == tab_id {
                return Some(side);
            }
            let pane = tabs.iter().find(|t| &t.id == pane_id);
            if let (Some(wanted), Some(path)) = (&wanted, pane.and_then(|p| p.file_path.as_deref()))
                && canonical_path(Some(path)).as_ref() == Some(wanted)
            {
                return Some(side);
            }
        }
        None
    }

    /// `decideSplitDrop` for a document tab dropped on an edge
    pub(super) fn decide_drop(
        &self,
        split: Option<&SplitViewState>,
        is_pane_tab: bool,
        doc_pane: Option<Pane>,
        dropped: SplitOrientation,
    ) -> Option<SplitDropIntent> {
        decide_split_drop(&SplitDragContext {
            split: split.map(|s| DragSplit {
                a_tab_id: s.a_tab_id.clone(),
                b_tab_id: s.b_tab_id.clone(),
                orientation: s.orientation,
                focus: s.focus,
            }),
            dragged: DraggedTab {
                is_document: true,
                is_pane_tab,
                doc_pane,
            },
            dropped,
        })
    }

    /// `tearOffSplitContext`
    pub(super) fn tear_off_split_context(&mut self, id: &str) -> Option<TornSplitDrag> {
        let manager = self.manager.as_ref()?;
        if !manager.can_detach_tab(id) {
            return None;
        }
        let tab = manager.list().into_iter().find(|t| t.id == id)?;
        if matches!(
            tab.kind,
            main_core::shell::tab_manager::TabKind::Home
                | main_core::shell::tab_manager::TabKind::Help
        ) {
            return None;
        }
        Some(TornSplitDrag {
            tab_id: id.to_owned(),
            file_path: tab.file_path,
            split_at_start: manager.split_state(),
        })
    }

    /// `sendSplitHint`: the drop-hint rectangle (or its removal) to the strip,
    /// unless it is the one sent last
    fn send_split_hint(&mut self, hint: Option<IpcValue>) {
        // `lastSplitHint` starts as null: a null hint is not re-sent
        if hint == self.last_hint {
            return;
        }
        self.last_hint = hint.clone();
        self.bridge
            .send_to_shell("tabs:split-hint", vec![hint.unwrap_or(IpcValue::Null)]);
    }

    /// `updateSplitHint`: while the pointer is held, decide the zone under it
    /// from the drag start's arrangement and push the hint
    pub(super) fn update_split_hint(&mut self, screen_x: f64, screen_y: f64) {
        let Some(drag) = self.torn_drag.clone() else {
            return;
        };
        let Some(shell) = self.bridge.shell else {
            return;
        };
        let state = self.bridge.windows.window_state(shell.window);
        if state.destroyed || self.manager.is_none() {
            return;
        }
        let bounds = state.content_bounds;
        let zone = split_drop_zone(
            screen_x - bounds.x,
            screen_y - bounds.y,
            bounds.width,
            bounds.height,
        );
        let Some(zone) = zone else {
            self.torn_drop = None;
            self.send_split_hint(None);
            return;
        };
        let pane_at_start = drag
            .split_at_start
            .as_ref()
            .is_some_and(|s| s.a_tab_id == drag.tab_id || s.b_tab_id == drag.tab_id);
        let live = self.manager.as_ref().and_then(|m| m.split_state());
        let split = if pane_at_start {
            drag.split_at_start.clone()
        } else {
            live
        };
        let doc_pane =
            self.split_pane_of_document(split.as_ref(), &drag.tab_id, drag.file_path.as_deref());
        self.torn_drop = self.decide_drop(split.as_ref(), pane_at_start, doc_pane, zone);
        let strip = tab_strip_height(1.0);
        let rects = pane_rects(
            &Rect {
                x: 0.0,
                y: strip,
                width: bounds.width,
                height: (bounds.height - strip).max(0.0),
            },
            zone,
            split.as_ref().map_or(SPLIT_EVEN_RATIO, |s| s.ratio),
        );
        let b = rects.b;
        self.send_split_hint(Some(IpcValue::Object(vec![
            ("left".into(), IpcValue::Number(b.x)),
            ("top".into(), IpcValue::Number(b.y)),
            ("width".into(), IpcValue::Number(b.width)),
            ("height".into(), IpcValue::Number(b.height)),
            ("orientation".into(), IpcValue::String(zone.as_str().into())),
        ])));
    }

    /// `applyTornSplitDrop`: a released tear-off whose last pointer position
    /// was over a split edge takes the torn tab back, re-attaches it without
    /// activating and realizes the decided intent. `false` leaves everything
    /// to the normal dock / detached-window flow.
    pub(super) fn apply_torn_split_drop(&mut self) -> bool {
        let drag = self.torn_drag.take();
        let intent = self.torn_drop.take();
        let (Some(drag), Some(intent)) = (drag, intent) else {
            self.send_split_hint(None);
            return false;
        };
        let record = self.detached.take_torn_tab(&mut self.bridge);
        self.drain();
        self.send_split_hint(None);
        let Some(record) = record else {
            return false;
        };
        self.ensure_manager();
        let Some(new_tab_id) = self.manager_call(|m, b| m.attach_tab(b, record, None, false))
        else {
            return true;
        };
        self.apply_torn_intent(&new_tab_id, intent, &drag);
        true
    }

    /// `applyTornIntent`: splitWith covers create/replace/reorient/focus; a
    /// pane tab flips the orientation or restores the split it was torn out of
    fn apply_torn_intent(
        &mut self,
        new_tab_id: &str,
        intent: SplitDropIntent,
        drag: &TornSplitDrag,
    ) {
        if matches!(intent, SplitDropIntent::Flip(_) | SplitDropIntent::Noop) {
            let Some(start) = &drag.split_at_start else {
                self.manager_call(|m, b| m.activate_tab(b, new_tab_id));
                return;
            };
            let a = if start.a_tab_id == drag.tab_id {
                new_tab_id
            } else {
                &start.a_tab_id
            };
            let b = if start.b_tab_id == drag.tab_id {
                new_tab_id
            } else {
                &start.b_tab_id
            };
            let orientation = match intent {
                SplitDropIntent::Flip(o) => o,
                _ => start.orientation,
            };
            self.manager_call(|m, bridge| {
                m.begin_split(bridge, a, b, orientation, start.ratio, start.focus)
            });
            return;
        }
        self.manager_call(|m, b| m.split_with(b, new_tab_id, Some(intent)));
    }

    /// `clearPaneRole`: a view leaving the strip is out of any split; its last
    /// role is withdrawn so its AI panel does not stay rail-collapsed
    pub(super) fn clear_pane_role(&mut self, view: ViewId) {
        if !self.bridge.windows.view_destroyed(view) {
            self.bridge.events.emit(
                Target::View(view),
                "app:split-role-changed",
                vec![IpcValue::Null],
            );
        }
    }

    /// `createDetachedEditorWindow`; the window it made
    pub(super) fn create_detached(
        &mut self,
        record: DetachedTab<ViewId>,
        tear_off_at: Option<(f64, f64)>,
    ) -> Option<WindowId> {
        let rec = self.detached.create(
            &mut self.bridge,
            DetachedWindowOptions {
                view: record.view,
                kind: record.kind,
                title: record.title,
                file_path: record.file_path,
                tear_off_at,
            },
        );
        let window = self.bridge.created.take();
        if let Some(window) = window {
            self.recs.insert(window, rec);
        }
        self.drain();
        window
    }
}

impl TabsState {
    pub(super) fn new(
        services: &Services,
        windows: Arc<dyn WindowsHost>,
        hooks: Rc<dyn TabHooks>,
        provided: Rc<Provided>,
    ) -> Rc<TabsState> {
        let mut bridge = Bridge::new(windows.clone(), hooks.clone(), services.events.clone());
        bridge.settings_path = app_settings_path(services);
        let mut inner = Inner {
            manager: None,
            detached: DetachedWindows::new(),
            bridge,
            recs: HashMap::new(),
            last_dock_index: None,
            torn_drag: None,
            torn_drop: None,
            last_hint: None,
            last_split_state: None,
            split_timer: false,
            pending_new_dir: HashMap::new(),
            pending_dir_by_wc: HashMap::new(),
        };
        // a shell window that exists already gets its manager now
        if let Some(shell) = windows.shell_window() {
            inner.bridge.shell = Some(shell);
            inner.manager = Some(TabManager::new());
            inner.detached.set_dock_host(true);
        }
        let state = Rc::new_cyclic(|this| TabsState {
            inner: RefCell::new(inner),
            windows: windows.clone(),
            hooks,
            events: services.events.clone(),
            provided,
            services: services.clone(),
            menus: RefCell::default(),
            next_menu: Cell::new(1),
            this: this.clone(),
        });
        CURRENT.with(|c| *c.borrow_mut() = Some(state.clone()));
        windows.attach(Arc::new(Reporter {
            core: services.core.clone(),
        }));
        state
    }

    pub(super) fn rc(&self) -> Rc<TabsState> {
        self.this
            .upgrade()
            .expect("the state is alive while it runs")
    }

    /// The shell window closed (macOS keeps running): the manager goes with it
    pub fn shell_window_closed(&self) {
        let mut g = self.inner.borrow_mut();
        g.manager = None;
        g.bridge.shell = None;
        g.detached.set_dock_host(false);
        g.last_split_state = None;
        if g.split_timer {
            g.bridge.windows.clear_timer(TimerKey::SplitMemory);
            g.split_timer = false;
        }
    }

    /// The shell window was made (at launch, or again after it closed on
    /// macOS): its tab manager starts with the Home tab only
    pub fn shell_window_opened(&self, shell: super::host::ShellWindow) {
        let mut g = self.inner.borrow_mut();
        g.bridge.shell = Some(shell);
        g.manager = Some(TabManager::new());
        g.detached.set_dock_host(true);
    }

    /// Calls `f` on the tab manager and its host, then runs the effects: the
    /// way other batches and the shell reach `TabManager` (open a tab, set a
    /// title). `None` while there is no shell window.
    pub fn with_manager<R>(
        &self,
        f: impl FnOnce(&mut TabManager<ViewId>, &mut dyn TabHost<ViewId>) -> R,
    ) -> Option<R> {
        self.inner
            .borrow_mut()
            .manager_call(|m, b| f(m, b as &mut dyn TabHost<ViewId>))
    }

    /// The shell window's id and its own view
    pub fn shell_window(&self) -> Option<super::host::ShellWindow> {
        self.inner.borrow().bridge.shell
    }

    /// Everything the host reports
    pub fn host_event(&self, event: HostEvent) {
        match event {
            HostEvent::View(view, what) => {
                self.inner.borrow_mut().manager_call(|m, b| match what {
                    ViewHappened::EnterHtmlFullScreen => m.on_enter_html_full_screen(b, &view),
                    ViewHappened::LeaveHtmlFullScreen => m.on_leave_html_full_screen(b, &view),
                    ViewHappened::Focus => m.on_pane_focus(b, &view),
                    ViewHappened::RenderProcessGone => m.on_spare_render_process_gone(b, &view),
                });
            }
            HostEvent::PageLoad { token, .. } => {
                self.inner.borrow_mut().manager_call(|m, _| {
                    m.ready_settled(Ready(super::bridge::PAGE_READY_BASE + token))
                });
            }
            HostEvent::Window(window, what) => self.window_event(window, what),
            HostEvent::Timer(key) => self.timer(key),
            HostEvent::Menu { token, chosen } => self.menu_closed(token, chosen),
        }
    }

    fn window_event(&self, window: WindowId, what: WindowEvent) {
        let mut g = self.inner.borrow_mut();
        if g.bridge.shell.map(|s| s.window) == Some(window) {
            match what {
                WindowEvent::Resize => {
                    g.manager_call(|m, b| m.on_window_resize(b));
                }
                WindowEvent::Restore => {
                    g.manager_call(|m, b| m.on_window_restore(b));
                }
                WindowEvent::Focus => {
                    g.manager_call(|m, b| {
                        m.refresh_active_targets(b);
                        m.focus_active_view(b);
                    });
                }
                WindowEvent::Closed => {
                    drop(g);
                    self.shell_window_closed();
                }
                _ => {}
            }
            return;
        }
        let Some(rec) = g.recs.get(&window).copied() else {
            return;
        };
        let Inner {
            detached, bridge, ..
        } = &mut *g;
        match what {
            WindowEvent::Resize => detached.on_resize(bridge, rec),
            WindowEvent::Restore => detached.on_restore(bridge, rec),
            WindowEvent::Focus => detached.on_focus(bridge, rec),
            WindowEvent::Move => detached.on_move(bridge, rec),
            WindowEvent::Moved => detached.on_moved(bridge, rec),
            WindowEvent::Close => {
                let event = detached.on_close(bridge, rec);
                g.drain();
                drop(g);
                if !event.prevent_default {
                    self.windows.window_destroy(window);
                }
                self.drive_detached_close(rec, event.step);
                return;
            }
            WindowEvent::Closed => {
                detached.on_closed(bridge, rec);
                g.recs.remove(&window);
            }
        }
        g.drain();
    }

    fn timer(&self, key: TimerKey) {
        let mut g = self.inner.borrow_mut();
        match key {
            TimerKey::SpareSheets => {
                g.manager_call(|m, b| {
                    let _ = m.fire_spare_sheets_timer(b);
                });
            }
            TimerKey::Tab(step) => {
                g.manager_call(|m, b| m.run_deferred(b, step));
            }
            TimerKey::Dock(rec) => {
                let Inner {
                    detached, bridge, ..
                } = &mut *g;
                detached.dock_timer_fired(bridge, rec);
                g.drain();
            }
            TimerKey::DetachedLayout(rec) => {
                let Inner {
                    detached, bridge, ..
                } = &mut *g;
                detached.run_deferred_layout(bridge, rec);
            }
            TimerKey::SplitMemory => {
                g.split_timer = false;
                let state = g.last_split_state.clone();
                g.persist_split_memory(state.as_ref());
            }
        }
    }

    // ---- closes: steps carried out through the editors ----

    /// `closeTab(id)`; `done` runs once the close has ended (closed, cancelled
    /// or failed), as the promise it replaces settled
    pub(super) fn close_tab(&self, id: &str, done: Box<dyn FnOnce(Result<(), String>)>) {
        let step = self
            .inner
            .borrow_mut()
            .manager_call(|m, b| m.close_tab(b, id));
        match step {
            None => done(Ok(())),
            Some(step) => self.drive_close(step, done),
        }
    }

    pub(super) fn drive_close(
        &self,
        step: TabCloseStep<ViewId>,
        done: Box<dyn FnOnce(Result<(), String>)>,
    ) {
        match step {
            TabCloseStep::Done => done(Ok(())),
            TabCloseStep::Rejected(message) => done(Err(message)),
            TabCloseStep::QueryDocsDirty { id, view } => {
                let this = self.rc();
                self.hooks.docs_query_dirty(
                    view,
                    Box::new(move |answer| this.resume_close(id, answer, done)),
                );
            }
            TabCloseStep::RequestClose { id, view, .. } => {
                let this = self.rc();
                let parent = self.inner.borrow().bridge.shell.map(|s| s.window);
                let then: shell_contract::editors::Then<bool> =
                    Box::new(move |answer| this.resume_close(id, answer, done));
                match editor_for(&self.provided, view) {
                    Some(editor) => editor.request_close(view, parent, then),
                    None => then(Err(IpcError {
                        name: Some("Error".into()),
                        message: format!("no editor owns view {}", view.0),
                    })),
                }
            }
        }
    }

    fn resume_close(
        &self,
        id: String,
        answer: Result<bool, IpcError>,
        done: Box<dyn FnOnce(Result<(), String>)>,
    ) {
        let answer = answer.map_err(|e| e.message);
        let step = self
            .inner
            .borrow_mut()
            .manager_call(|m, b| m.resume_close(b, &id, answer))
            .unwrap_or(TabCloseStep::Done);
        self.drive_close(step, done);
    }

    /// `closeTabsInOrder(tabs, ids)`
    pub(super) fn close_tabs_in_order(&self, ids: Vec<String>) {
        let mut strip = self.strip();
        let (run, step) = CloseInOrder::start(&mut strip, &ids);
        self.drive_in_order(run, step);
    }

    fn strip(&self) -> Strip {
        let g = self.inner.borrow();
        Strip(
            g.manager
                .as_ref()
                .map(|m| {
                    m.list()
                        .into_iter()
                        .map(|t| TabCloseTarget {
                            id: t.id,
                            kind: Some(t.kind.as_str().to_owned()),
                            closable: Some(t.closable),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        )
    }

    fn drive_in_order(&self, run: CloseInOrder, step: CloseInOrderStep) {
        let CloseInOrderStep::CloseTab(id) = step else {
            return;
        };
        let this = self.rc();
        self.close_tab(
            &id,
            Box::new(move |_| {
                let mut run = run;
                let mut strip = this.strip();
                let step = run.resume(&mut strip);
                this.drive_in_order(run, step);
            }),
        );
    }

    /// The prompts of a detached window's close: the same steps, answered by the editors
    pub(super) fn drive_detached_close(
        &self,
        rec: RecId,
        step: DetachedCloseStep<ViewId, WindowId>,
    ) {
        let this = self.rc();
        let resume = move |answer: Result<bool, IpcError>| {
            let answer = answer.map_err(|e| e.message);
            let step = {
                let mut g = this.inner.borrow_mut();
                let Inner {
                    detached, bridge, ..
                } = &mut *g;
                let step = detached.resume_close(bridge, rec, answer);
                g.drain();
                step
            };
            this.drive_detached_close(rec, step);
        };
        match step {
            DetachedCloseStep::Idle => {}
            DetachedCloseStep::QueryDocsDirty(view) => {
                self.hooks.docs_query_dirty(view, Box::new(resume))
            }
            DetachedCloseStep::RequestClose(_, view, window) => {
                let then: shell_contract::editors::Then<bool> = Box::new(resume);
                match editor_for(&self.provided, view) {
                    Some(editor) => editor.request_close(view, Some(window), then),
                    None => then(Err(IpcError {
                        name: Some("Error".into()),
                        message: format!("no editor owns view {}", view.0),
                    })),
                }
            }
        }
    }

    /// Pops up `entries` on the shell window; the invoke is answered when the
    /// menu closes
    pub(super) fn popup(
        &self,
        entries: Vec<MenuEntry>,
        actions: HashMap<u32, super::menus::MenuAction>,
        at: Option<(f64, f64)>,
        reply: shell_contract::ipc::Responder,
    ) {
        let Some(shell) = self.inner.borrow().bridge.shell else {
            reply.reply(Ok(IpcValue::Undefined));
            return;
        };
        let token = self.next_menu.get();
        self.next_menu.set(token + 1);
        self.menus.borrow_mut().insert(
            token,
            PendingMenu {
                actions,
                reply: Some(reply),
            },
        );
        self.windows.popup_menu(shell.window, &entries, at, token);
    }

    fn menu_closed(&self, token: u64, chosen: Option<u32>) {
        let Some(mut pending) = self.menus.borrow_mut().remove(&token) else {
            return;
        };
        if let Some(action) = chosen.and_then(|id| pending.actions.remove(&id)) {
            self.run_menu_action(action);
        }
        if let Some(reply) = pending.reply.take() {
            reply.reply(Ok(IpcValue::Undefined));
        }
    }
}

/// What `apps/shell/src/main/index.ts` does for the shell's own entries (the
/// application menu, the dock, a command line): thin wrappers over the logic
/// above, for the shell crate's `ShellTabs`. Called on the core thread.
impl TabsState {
    /// `activeEditorTarget(kind, ...)`: the focused detached window's view when
    /// it shows a document of `kind`, else the shell's active tab of that kind
    /// (a Present tab is no html target)
    pub fn active_editor(&self, kind: TabKind) -> Option<ViewId> {
        let mut g = self.inner.borrow_mut();
        let Inner {
            detached,
            bridge,
            manager,
            ..
        } = &mut *g;
        if let Some(focused) = detached.focused_detached_tab(bridge)
            && focused.kind == kind
        {
            return Some(focused.view);
        }
        manager
            .as_ref()
            .and_then(|m| m.active_tab_of_kind(kind))
            .map(|tab| tab.view)
    }

    /// `tabManager.openHomeTab()`
    pub fn open_home_tab(&self) {
        self.inner
            .borrow_mut()
            .manager_call(|m, b| m.open_home_tab(b));
    }

    /// `newDocTab`, `newSheetTab`, ...: one new tab for a home kind (`docx`,
    /// `xlsx`, `pptx`, `md`, `html`, `xmind`, `drawio`, `hwp`, `pdf`), as
    /// `home:new-*` does without a remembered folder; `false` for any other name
    pub fn new_document(&self, home_kind: &str) -> bool {
        let Some((_, _, kind)) = super::menus::new_kind_entry(home_kind) else {
            return false;
        };
        self.new_tab(kind);
        true
    }

    /// `visibleHomeKinds(readHomeKinds())` without `pdfTools`, in home's order
    pub fn visible_home_kinds(&self) -> Vec<String> {
        crate::home_settings::visible_home_kinds(&app_settings_path(&self.services))
    }

    /// "Open in New Window" for the shell's active tab of `kind`: its view
    /// moves into a window of its own, unsaved edits included. Nothing when
    /// the active tab is of another kind or cannot detach.
    pub fn open_active_in_new_window(&self, kind: TabKind) {
        let id = self
            .inner
            .borrow()
            .manager
            .as_ref()
            .and_then(|m| m.active_tab_of_kind(kind))
            .map(|tab| tab.id);
        if let Some(id) = id
            && self
                .inner
                .borrow()
                .manager
                .as_ref()
                .is_some_and(|m| m.can_detach_tab(&id))
        {
            self.detach_tab_to_window(&id);
        }
    }

    /// `app-settings.json`, where the interface scale is kept
    pub fn settings_path(&self) -> String {
        app_settings_path(&self.services)
    }

    /// `tabManager?.layout()`: the strip moved (the interface scale changed),
    /// so the views below it move too
    pub fn relayout(&self) {
        self.inner.borrow_mut().manager_call(|m, b| m.layout(b));
    }

    /// `openFileViaDialog`: File > Open, through the shell's hook
    pub fn open_file_via_dialog(&self) {
        self.hooks.open_file_via_dialog();
    }

    /// `closeFocusedEditor`: a focused detached editor window closes itself
    /// (its own unsaved-changes guard runs, as for the window's close box),
    /// otherwise the shell's active tab closes
    pub fn close_focused_editor(&self) {
        let detached = {
            let mut g = self.inner.borrow_mut();
            let Inner {
                detached, bridge, ..
            } = &mut *g;
            detached.focused_detached_tab(bridge).map(|f| f.window)
        };
        if let Some(window) = detached {
            self.window_event(window, WindowEvent::Close);
            return;
        }
        let step = self
            .inner
            .borrow_mut()
            .manager_call(|m, b| m.close_active_tab(b));
        if let Some(step) = step {
            let hooks = self.hooks.clone();
            self.drive_close(
                step,
                Box::new(move |done| {
                    if let Err(error) = done {
                        hooks.warn("[shell] close failed:", &error);
                    }
                }),
            );
        }
    }
}
