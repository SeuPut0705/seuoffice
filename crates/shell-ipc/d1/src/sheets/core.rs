//! The module-level state of sheets-main.ts, and the two ways handlers reach it.
//!
//! The TypeScript keeps `sheetsTabs`, `pendingEditCounts` and the rest as
//! module-level `Map`s the `ipcMain` listeners share. Here that is one
//! [`AppState`] in an `Rc<RefCell<…>>` on the core thread, wrapped in a
//! [`Core`] together with the hosts. A handler that answers at once works on
//! a `&Core`. A handler that awaits in TypeScript (a dialog, the sidecar, a
//! file copy) runs as straight-line code on a worker through an [`Env`], the
//! `Send` half of the same, and hops to the core thread with [`Env::core`]
//! wherever it reads or changes state, as the TypeScript's awaits resume on
//! Electron's main thread. The core thread itself never waits for the
//! engine, a worker or a renderer.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

use main_core::packages::electron_utils::recovery_contract::RecoveryOpenDecision;
use main_core::packages::electron_utils::recovery_store::{
    RecoveryIdentity, RecoveryStoreOptions, SharedRecoveryState, create_recovery_store,
};
use main_core::sheets::close_guard::ShutdownLatch;
use main_core::sheets::import_registry::ImportRegistry;
use main_core::sheets::save_as_formats::SaveAsExportTargets;
use main_core::sheets::save_edits_transfer::{SaveEditsTransferStore, SweepTimers};
use shell_contract::ipc::Target;
use shell_contract::runtime::{PathName, Services};
use shell_contract::{ClipboardHost, DialogsHost, IpcValue, ViewId, WindowId};

use super::engine::{ScreenCaptureHost, SheetsShellHost, WorkbookEngineHost};
use super::i18n::Tm;
use super::session::SessionInfo;
use crate::host::{RecoveryStateHost, Shared};

/// The store's sweep interval is left to the next call: every `begin` and
/// `addChunk` sweeps expired uploads first, so only the early release of an
/// abandoned upload's memory is lost
pub struct NoTimers;

impl SweepTimers for NoTimers {
    fn set_interval(&mut self, _ms: f64) {}
    fn clear_interval(&mut self) {}
}

/// `SheetsTabSession`
pub struct TabState {
    /// sessions by id, in the order they opened (a `Map`)
    pub sessions: Vec<(String, SessionInfo)>,
    pub save_transfers: SaveEditsTransferStore<NoTimers>,
    /// the file this tab shows (merge sources excluded); `null` until the first open lands
    pub current_path: Option<String>,
}

impl TabState {
    fn new() -> TabState {
        TabState {
            sessions: Vec::new(),
            save_transfers: SaveEditsTransferStore::new(NoTimers),
            current_path: None,
        }
    }

    pub fn session(&self, id: &str) -> Option<&SessionInfo> {
        self.sessions
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, session)| session)
    }

    /// `sessions.set(id, session)`: a key that is there keeps its place
    pub fn set_session(&mut self, id: &str, session: SessionInfo) {
        match self.sessions.iter_mut().find(|(key, _)| key == id) {
            Some(entry) => entry.1 = session,
            None => self.sessions.push((id.to_owned(), session)),
        }
    }

    pub fn remove_session(&mut self, id: &str) -> Option<SessionInfo> {
        let at = self.sessions.iter().position(|(key, _)| key == id)?;
        Some(self.sessions.remove(at).1)
    }
}

/// `TabRecoveryState`
#[derive(Default)]
pub struct TabRecovery {
    /// copies this tab wrote, by copy path: a clean close removes only these
    pub written: Vec<(String, RecoveryIdentity)>,
    /// copies whose session closed while still unsaved
    pub keep: HashSet<String>,
    /// copies this tab must neither write nor delete
    pub held: HashSet<String>,
    /// "Don't Save" was answered: late copy writes are dropped
    pub discarded: bool,
    /// the renderer died
    pub crashed: bool,
    /// the password notice was shown in this tab
    pub notice_shown: bool,
}

/// `UnsavedNewWorkbook`
#[derive(Clone, Debug, PartialEq)]
pub struct UnsavedNew {
    pub suggest_save_as: String,
    pub temp_dir: String,
    pub recovery: RecoveryIdentity,
    pub restored: bool,
    pub original_path: Option<String>,
    pub ods_converted: bool,
    pub formulas_dropped: Option<f64>,
    pub ods_source_path: Option<String>,
}

pub struct PendingPick {
    pub pick_id: String,
    pub source: ViewId,
    pub target: ViewId,
}

/// `HeadlessSheetsReport`
#[derive(Clone, Debug, PartialEq)]
pub struct HeadlessReport {
    pub ok: bool,
    pub error: Option<String>,
}

pub struct CloseWaiter {
    pub token: u64,
    pub resume: Box<dyn FnOnce(bool)>,
}

/// Every module-level `Map`, `Set` and variable of the TypeScript, per app
pub struct AppState {
    pub tabs: Vec<(ViewId, TabState)>,
    pub active_view: Option<ViewId>,
    pub pending_imports: ImportRegistry,
    pub pending_pick: Option<PendingPick>,
    /// running delimited imports by token: the controller the registry holds
    pub import_controllers: HashMap<u64, main_core::sheets::import_registry::AbortController>,
    pub save_as_export_targets: SaveAsExportTargets,
    pub untitled_workbook_paths: HashSet<String>,
    pub unsaved_new_workbooks: HashMap<String, UnsavedNew>,
    pub mcp_writable: HashMap<ViewId, HashSet<String>>,
    pub queued_workbooks: HashMap<ViewId, String>,
    pub pending_new_blank: bool,
    pub headless_targets: HashMap<ViewId, String>,
    pub headless_waiters: HashMap<ViewId, Box<dyn FnOnce(HeadlessReport)>>,
    pub pending_edit_counts: HashMap<ViewId, f64>,
    pub tracked_edit_senders: HashSet<ViewId>,
    pub close_waiters: HashMap<ViewId, CloseWaiter>,
    pub next_token: u64,
    pub shutdown: ShutdownLatch,
    pub tab_recovery: HashMap<ViewId, TabRecovery>,
    pub decided_opens: HashMap<ViewId, (String, RecoveryOpenDecision)>,
    pub write_now_waiters: HashMap<String, Box<dyn FnOnce()>>,
    pub attachment_text_cache: Vec<(String, (String, String))>,
    pub pasted_image_seq: u64,
    pub pasted_cleanup_started: bool,
}

impl AppState {
    fn new() -> AppState {
        AppState {
            tabs: Vec::new(),
            active_view: None,
            pending_imports: ImportRegistry::new(),
            pending_pick: None,
            import_controllers: HashMap::new(),
            save_as_export_targets: SaveAsExportTargets::new(),
            untitled_workbook_paths: HashSet::new(),
            unsaved_new_workbooks: HashMap::new(),
            mcp_writable: HashMap::new(),
            queued_workbooks: HashMap::new(),
            pending_new_blank: false,
            headless_targets: HashMap::new(),
            headless_waiters: HashMap::new(),
            pending_edit_counts: HashMap::new(),
            tracked_edit_senders: HashSet::new(),
            close_waiters: HashMap::new(),
            next_token: 0,
            shutdown: ShutdownLatch::new(),
            tab_recovery: HashMap::new(),
            decided_opens: HashMap::new(),
            write_now_waiters: HashMap::new(),
            attachment_text_cache: Vec::new(),
            pasted_image_seq: 0,
            pasted_cleanup_started: false,
        }
    }

    pub fn tab(&self, view: ViewId) -> Option<&TabState> {
        self.tabs
            .iter()
            .find(|(id, _)| *id == view)
            .map(|(_, tab)| tab)
    }

    pub fn tab_mut(&mut self, view: ViewId) -> Option<&mut TabState> {
        self.tabs
            .iter_mut()
            .find(|(id, _)| *id == view)
            .map(|(_, tab)| tab)
    }

    pub fn recovery_of(&mut self, view: ViewId) -> &mut TabRecovery {
        self.tab_recovery.entry(view).or_default()
    }
}

/// What a worker may hold: every host and the way back to the core thread
#[derive(Clone)]
pub struct Env {
    pub services: Services,
    pub slot: usize,
    pub engine: WorkbookEngineHost,
    pub shell: SheetsShellHost,
    pub screen: ScreenCaptureHost,
    pub dialogs: DialogsHost,
    pub os_shell: shell_contract::OsShellHost,
    pub clipboard: ClipboardHost,
    pub main_window: shell_contract::MainWindowHost,
    pub shared: Arc<Shared>,
    pub recovery: RecoveryStateHost,
    pub tm: Tm,
}

/// What a core-thread closure works on
#[derive(Clone)]
pub struct Core {
    pub env: Env,
    pub state: Rc<RefCell<AppState>>,
}

thread_local! {
    /// the core thread's [`Core`]s, one per `routes` call; a worker names one by slot
    static CORES: RefCell<Vec<Core>> = const { RefCell::new(Vec::new()) };
}

/// Creates the state and registers it on this (the core) thread; `env.slot` is set here
pub fn create_core(mut env: Env) -> Core {
    CORES.with(|cores| {
        let mut cores = cores.borrow_mut();
        env.slot = cores.len();
        let core = Core {
            env,
            state: Rc::new(RefCell::new(AppState::new())),
        };
        cores.push(core.clone());
        core
    })
}

/// The core registered under `slot`; call on the core thread only
pub fn core_at(slot: usize) -> Core {
    CORES.with(|cores| cores.borrow()[slot].clone())
}

impl Env {
    /// Runs `job` on the core thread and waits for its answer. Call from a
    /// worker (or, in tests, where the core thread runs jobs inline); never
    /// from a core-thread job in the shell, which would wait for itself.
    pub fn core<R: Send + 'static>(&self, job: impl FnOnce(&Core) -> R + Send + 'static) -> R {
        let (tx, rx) = mpsc::sync_channel(1);
        let slot = self.slot;
        self.services.core.post(Box::new(move || {
            let answer = job(&core_at(slot));
            let _ = tx.send(answer);
        }));
        rx.recv().expect("the core thread dropped a job")
    }

    /// `job` on the core thread, without waiting
    pub fn post(&self, job: impl FnOnce(&Core) + Send + 'static) {
        let slot = self.slot;
        self.services
            .core
            .post(Box::new(move || job(&core_at(slot))));
    }

    /// `job` on a worker
    pub fn spawn(&self, job: impl FnOnce() + Send + 'static) {
        self.services.workers.spawn(Box::new(job));
    }

    pub fn window_of(&self, view: ViewId) -> Option<WindowId> {
        self.services.views.sender_of(view).map(|s| s.window)
    }

    /// `!webContents.isDestroyed()`
    pub fn alive(&self, view: ViewId) -> bool {
        self.services.views.sender_of(view).is_some()
    }

    /// `webContents.send(channel, ...args)`
    pub fn send(&self, view: ViewId, channel: &'static str, args: Vec<IpcValue>) {
        self.services.events.emit(Target::View(view), channel, args);
    }

    /// `app.getPath('temp')`
    /// `randomUUID()`
    pub fn uuid(&self) -> String {
        self.shell.random_uuid()
    }

    pub fn temp_dir(&self) -> String {
        crate::host::path_string(self.services.paths.path(PathName::Temp))
    }

    pub fn user_data_dir(&self) -> String {
        crate::host::path_string(self.services.paths.path(PathName::UserData))
    }

    /// Runs `f` with the recovery store over the one shared state. The store
    /// is only ever used from short blocking calls, so the lock is brief.
    pub fn with_store<R>(
        &self,
        f: impl FnOnce(&main_core::packages::electron_utils::recovery_store::RecoveryStore<'_>) -> R,
    ) -> R {
        let shared: std::sync::MutexGuard<'_, SharedRecoveryState> = lock(&self.recovery);
        let user_data = self.user_data_dir();
        let user_data_dir = move || user_data.clone();
        let shell = self.shell.clone();
        let now = move || shell.now_ms();
        let uuid = jscompat::random_uuid;
        let store = create_recovery_store(
            RecoveryStoreOptions {
                user_data_dir: &user_data_dir,
                now_ms: &now,
                random_uuid: &uuid,
            },
            &shared,
        );
        f(&store)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Core {
    /// Makes sure `view` is a known tab (`sessionFor`): the surface check of
    /// the shell has already refused senders that are not sheets views, so
    /// the TypeScript's `Untrusted IPC sender.` cannot happen here
    pub fn ensure_tab(&self, view: ViewId) {
        let added = {
            let mut state = self.state.borrow_mut();
            let added = state.tab(view).is_none();
            if added {
                state.tabs.push((view, TabState::new()));
                state.active_view = Some(view);
            }
            added
        };
        if added {
            self.start_pasted_temp_cleanup();
        }
    }

    pub fn session_of(&self, view: ViewId, id: &str) -> Option<SessionInfo> {
        self.state
            .borrow()
            .tab(view)
            .and_then(|tab| tab.session(id).cloned())
    }

    pub fn tab_views(&self) -> Vec<ViewId> {
        self.state.borrow().tabs.iter().map(|(id, _)| *id).collect()
    }

    pub fn send(&self, view: ViewId, channel: &'static str, args: Vec<IpcValue>) {
        self.env.send(view, channel, args);
    }
}
