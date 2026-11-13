//! The state of `mindmap-main.ts` and the entries the shell calls: the
//! TypeScript's module-level maps keyed by `webContents.id` live in one
//! [`State`], and every promise that waited for a renderer reply (a menu
//! save, the close prompt, the OS session end, the MCP server's reads) is a
//! stored continuation that the reply, a timer or the view's end resumes.

use std::cell::RefCell;
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::{Arc, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use main_core::mindmap::save_as_formats::MapSaveAsKind;
use main_core::packages::electron_utils::message_box::{
    MessageBox as MessageBoxTrait, MessageBoxOptions, ParentWindow,
};
use main_core::packages::electron_utils::recovery_contract::{
    RecoveryOpenFileRequest, RecoveryOpenUntitledRequest,
};
use main_core::packages::electron_utils::recovery_store::{RecoveryIdentity, SharedRecoveryState};
use main_core::packages::electron_utils::save_conflict::ProbeThrew;
use main_core::packages::electron_utils::save_conflict::{
    SaveConflictAnswer, SaveConflictOptions, SaveDiskState, confirm_overwrite_if_conflicted,
    record_disk_state, should_defer_auto_save,
};
use main_core::packages::i18n::Lang;
use shell_contract::hosts::{Dialogs, MessageBox};
use shell_contract::ipc::RegisterError;
use shell_contract::ipc::Target;
use shell_contract::runtime::{PathName, Services};
use shell_contract::{Batch, ContentsHost, DialogsHost, IpcValue, OsShellHost, ViewId, WindowId};

use super::hosts::*;
use super::recovery::ViewRecovery;
use super::text::main_text;
use crate::host::{LocaleHost, RecoveryStateHost, Shared};
use crate::value::{buffer, string};

/// The one extension a map is saved with
pub const MAP_EXTENSION: &str = ".xmind";
/// How long a save waits for the renderer
pub const SAVE_WAIT: Duration = Duration::from_secs(120);
/// How long the OS session end waits for one view's copy
pub const COPY_NOW_WAIT: Duration = Duration::from_secs(5);
/// How long a tab that stays open after "Don't Save" takes no copy
pub const DONT_SAVE_HOLD: Duration = Duration::from_millis(5_000);
/// How long a read of the map waits for the renderer
pub const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// How often an unanswered read is sent again
pub const RESEND: Duration = Duration::from_millis(250);

pub use shell_contract::editors::SaveMode;

/// `mode` as the renderer's `SaveMode` string
pub fn mode_name(mode: SaveMode) -> &'static str {
    match mode {
        SaveMode::Save => "save",
        SaveMode::SaveAs => "saveAs",
    }
}

/// `MindmapSeed`: what a new, unsaved map starts with
#[derive(Clone, Debug, PartialEq)]
pub enum Seed {
    /// outline text in the form the engine reads
    Outline(String),
    /// a byte copy of a map file
    Copy(Vec<u8>),
}

impl Seed {
    pub(super) fn to_value(&self) -> IpcValue {
        match self {
            Seed::Outline(text) => crate::value::obj([("outline", string(text.clone()))]),
            Seed::Copy(bytes) => crate::value::obj([("bytes", buffer(bytes.clone()))]),
        }
    }
}

/// How a continuation ended
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wait {
    /// the renderer answered (or the view ended: `Answer(false)`)
    Answer(bool),
    /// the 120 s ran out
    Timeout,
}

pub type Waiter = Box<dyn FnOnce(Wait)>;

/// What the renderer answered a read of the map with
#[derive(Clone, Debug, PartialEq)]
pub enum Answer {
    Text(String),
    Bytes(Vec<u8>),
}

pub type AskDone = Box<dyn FnOnce(Result<Answer, String>)>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Ask {
    Outline,
    Bytes,
}

impl Ask {
    pub(super) fn request_channel(self) -> &'static str {
        match self {
            Ask::Outline => "mindmap:outline-request",
            Ask::Bytes => "mindmap:bytes-request",
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) enum TimerJob {
    SaveWait(ViewId, u64),
    CloseWait(ViewId, u64),
    CopyNow(ViewId, u64),
    DropHold(ViewId, u64),
    Resend(Ask, ViewId, u64),
    AskTimeout(Ask, ViewId, u64),
}

/// Waiters by view, the way a `Map<number, resolve>` and their timers behave:
/// a reply takes the current one; a timer clears whatever is current
#[derive(Default)]
pub(super) struct WaitTable {
    current: HashMap<ViewId, u64>,
    pending: HashMap<u64, Waiter>,
}

impl WaitTable {
    pub(super) fn set(&mut self, view: ViewId, gen_id: u64, waiter: Waiter) {
        self.current.insert(view, gen_id);
        self.pending.insert(gen_id, waiter);
    }

    pub(super) fn take(&mut self, view: ViewId) -> Option<Waiter> {
        let gen_id = self.current.remove(&view)?;
        self.pending.remove(&gen_id)
    }

    /// the timer of `gen_id` ran out: `saveWaiters.delete(wcId)` and resolve its own.
    /// An answered wait has no timer in the TypeScript (it is cleared on the
    /// answer): nothing happens then.
    fn expire(&mut self, view: ViewId, gen_id: u64) -> Option<Waiter> {
        let waiter = self.pending.remove(&gen_id)?;
        self.current.remove(&view);
        Some(waiter)
    }
}

/// a copy-now wait: the generation of its timer and what finishing it resumes
pub(super) type CopyNowWaiter = (u64, Box<dyn FnOnce()>);

pub(super) struct PendingAsk {
    gen_id: u64,
    callbacks: Vec<AskDone>,
}

#[derive(Default)]
pub(super) struct State {
    /// open path per view, queued at tab creation; kept until the view is destroyed
    pub open_path: HashMap<ViewId, String>,
    /// file paths granted to each view
    pub allowed: HashMap<ViewId, HashSet<String>>,
    /// current save target per view
    pub save_path: HashMap<ViewId, String>,
    /// views made for a file this side has not seen open as ok: `pending` or `failed`
    pub unopened: HashMap<ViewId, Unopened>,
    /// views whose map was imported from a `.mm`: that file and its name
    pub imported: HashMap<ViewId, (String, String)>,
    pub dirty: HashSet<ViewId>,
    /// every live map view
    pub live: HashSet<ViewId>,
    pub close_waiters: WaitTable,
    pub save_waiters: WaitTable,
    /// copies asked for at the OS session end
    pub copy_now: HashMap<ViewId, CopyNowWaiter>,
    /// the disk state of every read and write, per view and path
    pub disk_states: HashMap<ViewId, HashMap<String, SaveDiskState>>,
    /// paths Save As picked for an export, per view
    pub save_as_grants: HashMap<ViewId, (MapSaveAsKind, String)>,
    pub recovery: HashMap<ViewId, ViewRecovery>,
    pub seeds: HashMap<ViewId, Seed>,
    pub taken_handoff: HashMap<ViewId, String>,
    pub asks: HashMap<(Ask, ViewId), PendingAsk>,
    /// text already read, by path, oldest first
    pub text_cache: Vec<(String, (String, String))>,
    pub pasted_seq: u32,
    pub pasted_pruned: bool,
    pub timers: Vec<(Instant, TimerJob)>,
    pub next_gen: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Unopened {
    Pending,
    Failed,
}

pub(super) struct Inner {
    pub services: Services,
    pub dialogs: DialogsHost,
    pub os_shell: OsShellHost,
    pub contents: ContentsHost,
    pub locale: LocaleHost,
    pub shared: Arc<Shared>,
    pub recovery_state: RecoveryStateHost,
    pub engine: XmindEngineHost,
    pub parse: FileParseHost,
    pub net: LinkNetHost,
    pub renderer: PageRendererHost,
    pub shell: MindmapShellHost,
    pub state: RefCell<State>,
    wake: Option<mpsc::Sender<Instant>>,
}

/// The mind map app of the shell: every handler of the batch's mind map
/// channels reads and writes its state, and the shell calls the entries below
/// where the TypeScript main module exported a function.
#[derive(Clone)]
pub struct MindmapApp(pub(super) Rc<Inner>);

/// a clock a probe case fixes (`hosts.d1.mindmap.clock`, ms since the epoch); 0 is the real one
#[cfg(any(test, feature = "probe"))]
pub(super) static FIXED_CLOCK: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// `Date.now()`
pub(super) fn now_ms() -> f64 {
    #[cfg(any(test, feature = "probe"))]
    {
        let fixed = FIXED_CLOCK.load(std::sync::atomic::Ordering::Relaxed);
        if fixed != 0 {
            return fixed as f64;
        }
    }
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// the parent of a message box, as the recovery and conflict prompts take it
pub(super) struct Win(pub WindowId);

impl ParentWindow for Win {
    fn is_destroyed(&self) -> bool {
        false
    }
}

/// Electron's `dialog.showMessageBox` over the shell's host
pub(super) struct HostBox<'a>(pub &'a dyn Dialogs);

fn message_box(options: &MessageBoxOptions) -> MessageBox {
    MessageBox {
        kind: Some(options.kind.to_owned()),
        title: options.title.clone(),
        message: options.message.clone(),
        detail: options.detail.clone(),
        buttons: options.buttons.clone(),
        default_id: Some(options.default_id as usize),
        cancel_id: options.cancel_id.map(|id| id as usize),
        checkbox_label: None,
    }
}

impl MessageBoxTrait<Win> for HostBox<'_> {
    fn show_message_box_over(&self, parent: &Win, options: &MessageBoxOptions) -> f64 {
        self.0
            .message(Some(parent.0), &message_box(options))
            .response as f64
    }

    fn show_message_box(&self, options: &MessageBoxOptions) -> f64 {
        self.0.message(None, &message_box(options)).response as f64
    }
}

impl MindmapApp {
    pub(super) fn new(services: &Services) -> Result<MindmapApp, RegisterError> {
        let hosts = &services.hosts;
        let wake = spawn_wake(services.core.clone());
        Ok(MindmapApp(Rc::new(Inner {
            services: services.clone(),
            dialogs: hosts.need(Batch::D1)?,
            os_shell: hosts.need(Batch::D1)?,
            contents: hosts.need(Batch::D1)?,
            locale: hosts.need(Batch::D1)?,
            shared: hosts.need(Batch::D1)?,
            recovery_state: hosts.need(Batch::D1)?,
            engine: hosts.need(Batch::D1)?,
            parse: hosts.need(Batch::D1)?,
            net: hosts.need(Batch::D1)?,
            renderer: hosts.need(Batch::D1)?,
            shell: hosts.need(Batch::D1)?,
            state: RefCell::new(State::default()),
            wake,
        })))
    }

    pub(super) fn lang(&self) -> Lang {
        self.0.locale.ui_lang()
    }

    /// `tm(key)` of `i18n-main.ts`
    pub(super) fn tm(&self, key: &str) -> String {
        main_text(self.lang(), key)
    }

    pub(super) fn emit(&self, view: ViewId, channel: &'static str, args: Vec<IpcValue>) {
        self.0
            .services
            .events
            .emit(Target::View(view), channel, args);
    }

    /// `!contents.isDestroyed()`
    pub(super) fn is_alive(&self, view: ViewId) -> bool {
        self.0.services.views.sender_of(view).is_some()
    }

    /// `BrowserWindow.fromWebContents(contents)`
    pub(super) fn window_of(&self, view: ViewId) -> Option<WindowId> {
        self.0.contents.window_of(view)
    }

    pub(super) fn recovery_state(&self) -> MutexGuard<'_, SharedRecoveryState> {
        self.0
            .recovery_state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn user_data_dir(&self) -> String {
        crate::host::path_string(self.0.services.paths.path(PathName::UserData))
    }

    // ---- timers ----

    pub(super) fn new_gen(&self) -> u64 {
        let mut state = self.0.state.borrow_mut();
        state.next_gen += 1;
        state.next_gen
    }

    pub(super) fn schedule(&self, delay: Duration, job: TimerJob) {
        let deadline = Instant::now() + delay;
        self.0.state.borrow_mut().timers.push((deadline, job));
        if let Some(wake) = &self.0.wake {
            let _ = wake.send(deadline);
        }
    }

    /// Runs the timers due at `now`. The wake-up thread posts this to the
    /// core thread; a test calls it with a later `now`.
    pub fn run_due(&self, now: Instant) {
        let due: Vec<TimerJob> = {
            let mut state = self.0.state.borrow_mut();
            let (mut due, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut state.timers)
                .into_iter()
                .partition(|(deadline, _)| *deadline <= now);
            state.timers = rest;
            // in the order their time came, as timers fire
            due.sort_by_key(|(deadline, _)| *deadline);
            due.into_iter().map(|(_, job)| job).collect()
        };
        for job in due {
            match job {
                TimerJob::SaveWait(view, gen_id) => {
                    let waiter = self.0.state.borrow_mut().save_waiters.expire(view, gen_id);
                    if let Some(waiter) = waiter {
                        waiter(Wait::Timeout);
                    }
                }
                TimerJob::CloseWait(view, gen_id) => {
                    let waiter = self.0.state.borrow_mut().close_waiters.expire(view, gen_id);
                    if let Some(waiter) = waiter {
                        waiter(Wait::Timeout);
                    }
                }
                TimerJob::CopyNow(view, gen_id) => self.finish_copy_now(view, Some(gen_id)),
                TimerJob::DropHold(view, gen_id) => self.drop_hold_ended(view, gen_id),
                TimerJob::Resend(kind, view, gen_id) => self.resend(kind, view, gen_id),
                TimerJob::AskTimeout(kind, view, gen_id) => self.settle_ask(
                    kind,
                    view,
                    Some(gen_id),
                    Err("timed out reading the map".into()),
                ),
            }
        }
    }

    // ---- reads of mayWrite and friends ----

    /// `mayWrite(wcId)`
    pub(super) fn may_write(&self, view: ViewId) -> bool {
        !self.0.state.borrow().unopened.contains_key(&view)
    }

    pub fn is_dirty(&self, view: ViewId) -> bool {
        self.0.state.borrow().dirty.contains(&view)
    }

    /// `mindmapFilePath(webContentsId)`
    pub fn file_path(&self, view: ViewId) -> Option<String> {
        self.0.state.borrow().save_path.get(&view).cloned()
    }

    /// whether the view was made for a file (such a view is not a new map)
    pub(super) fn opens_file(&self, view: ViewId) -> bool {
        self.0.state.borrow().open_path.contains_key(&view)
    }

    // ---- disk states (split-copy save guard, decision 0036) ----

    pub(super) fn remember_disk_state(&self, view: ViewId, path: &str) {
        let Some(state) = record_disk_state(path) else {
            return;
        };
        self.0
            .state
            .borrow_mut()
            .disk_states
            .entry(view)
            .or_default()
            .insert(path.to_owned(), state);
    }

    pub(super) fn forget_disk_state(&self, view: ViewId, path: &str) {
        let mut state = self.0.state.borrow_mut();
        let Some(states) = state.disk_states.get_mut(&view) else {
            return;
        };
        states.remove(path);
        if states.is_empty() {
            state.disk_states.remove(&view);
        }
    }

    /// `conflictStopsSave`: this save must stop instead of writing
    pub(super) fn conflict_stops_save(&self, view: ViewId, path: &str, auto: bool) -> bool {
        let shell = &self.0.shell;
        if !shell.is_path_open_elsewhere(path) {
            return false;
        }
        let recorded = self
            .0
            .state
            .borrow()
            .disk_states
            .get(&view)
            .and_then(|states| states.get(path))
            .cloned();
        let probe = |p: &str| -> Result<bool, ProbeThrew> { Ok(shell.is_path_open_elsewhere(p)) };
        if auto {
            return should_defer_auto_save(Some(&probe), path, recorded.as_ref());
        }
        let parent = self.window_of(view).map(Win);
        let lang = self.lang();
        let dialog = HostBox(&*self.0.dialogs);
        confirm_overwrite_if_conflicted(&SaveConflictOptions {
            probe: Some(&probe),
            dialog: &dialog,
            parent: parent.as_ref(),
            path,
            recorded: recorded.as_ref(),
            lang: lang.as_str(),
        }) == SaveConflictAnswer::Cancel
    }

    /// `adoptWrittenPath`: the view's map now lives at `target` (just written)
    pub(super) fn adopt_written_path(
        &self,
        view: ViewId,
        target: &str,
        previous_path: Option<&str>,
    ) {
        {
            let mut state = self.0.state.borrow_mut();
            state.save_path.insert(view, target.to_owned());
            // a stale open path would make a reloaded renderer load the OLD file
            state.open_path.insert(view, target.to_owned());
            state
                .allowed
                .entry(view)
                .or_default()
                .insert(target.to_owned());
            state.dirty.remove(&view);
        }
        // the map is on disk: its recovery copies have done their part
        self.view_saved(view);
        self.remember_disk_state(view, target);
        if let Some(previous) = previous_path
            && previous != target
        {
            self.forget_disk_state(view, previous);
        }
        if previous_path != Some(target) {
            self.0.shell.file_saved(view, target);
        }
    }

    /// `refuseWrites`: the view's file did not open; it has no save target and gets none
    pub(super) fn refuse_writes(&self, view: ViewId) {
        let mut state = self.0.state.borrow_mut();
        state.unopened.insert(view, Unopened::Failed);
        state.save_path.remove(&view);
        state.dirty.remove(&view);
    }

    // ---- entries for the shell ----

    /// `grantAndTrack(wc, openPath)`, the part that is state: call it when the
    /// shell creates a map view, before the renderer can ask. The path is
    /// granted only when the file exists. The shell itself denies window
    /// opens and navigation away, and calls [`MindmapApp::view_crashed`] when
    /// the renderer process dies.
    pub fn create_view(&self, view: ViewId, open_path: Option<&str>) {
        let mut state = self.0.state.borrow_mut();
        state.live.insert(view);
        if let Some(path) = open_path.filter(|p| !p.is_empty() && PathBuf::from(p).exists()) {
            state.open_path.insert(view, path.to_owned());
            state.allowed.insert(view, HashSet::from([path.to_owned()]));
            // not a save target yet: it becomes one when the open handler has seen the file open
            state.unopened.insert(view, Unopened::Pending);
        }
    }

    /// `queueMindmapSeedFor`: queue content for a new tab, dropped when the
    /// tab goes away before taking it
    pub fn queue_seed(&self, view: ViewId, seed: Seed) {
        if !self.is_alive(view) {
            return;
        }
        self.0.state.borrow_mut().seeds.insert(view, seed);
    }

    /// `takeMindmapSeed`: the content queued for this view, once
    pub fn take_seed(&self, view: ViewId) -> Option<Seed> {
        self.0.state.borrow_mut().seeds.remove(&view)
    }

    /// `mindmapFileRenamed`: re-grant the new path and tell the renderer
    pub fn file_renamed(&self, view: ViewId, old_path: &str, new_path: &str) {
        {
            let mut state = self.0.state.borrow_mut();
            if state.save_path.get(&view).map(String::as_str) == Some(old_path) {
                state.save_path.insert(view, new_path.to_owned());
            }
            if state.open_path.get(&view).map(String::as_str) == Some(old_path) {
                state.open_path.insert(view, new_path.to_owned());
            }
            if let Some(allowed) = state.allowed.get_mut(&view)
                && allowed.contains(old_path)
            {
                allowed.insert(new_path.to_owned());
            }
            if let Some(states) = state.disk_states.get_mut(&view)
                && let Some(recorded) = states.remove(old_path)
            {
                states.insert(new_path.to_owned(), recorded);
            }
        }
        self.view_file_renamed(view, old_path, new_path);
        if self.is_alive(view) {
            self.emit(view, "mindmap:file-renamed", vec![string(new_path)]);
        }
    }

    /// `requestMindmapClose`: the close guard. `done(true)` means proceed
    /// with closing. A clean view is true at once; a dirty one asks Save /
    /// Don't Save / Cancel, and Save waits for the renderer's close-save-result.
    pub fn request_close(
        &self,
        view: ViewId,
        parent: Option<WindowId>,
        done: Box<dyn FnOnce(bool)>,
    ) {
        // no map, nothing to save: a view whose file did not open closes without a question
        if !self.may_write(view) {
            return done(true);
        }
        if !self.is_dirty(view) || !self.is_alive(view) {
            return done(true);
        }
        let options = MessageBox {
            kind: Some("warning".into()),
            title: None,
            message: self.tm("closeUnsavedMsg"),
            detail: Some(self.tm("closeUnsavedDetail")),
            buttons: vec![
                self.tm("btnSave"),
                self.tm("btnDontSave"),
                self.tm("btnCancel"),
            ],
            default_id: Some(0),
            cancel_id: Some(2),
            checkbox_label: None,
        };
        let response = self.0.dialogs.message(parent, &options).response;
        if response == 2 {
            return done(false);
        }
        if response == 1 {
            // "Don't Save": the unsaved work is dropped, its recovery copy with it
            self.view_dropped(view);
            return done(true);
        }
        let gen_id = self.new_gen();
        self.0.state.borrow_mut().close_waiters.set(
            view,
            gen_id,
            Box::new(move |wait| done(matches!(wait, Wait::Answer(true)))),
        );
        self.schedule(SAVE_WAIT, TimerJob::CloseWait(view, gen_id));
        self.emit(view, "mindmap:close-save-request", vec![]);
    }

    /// `requestMindmapSave`: menu Save / Save As. A clean view with a file
    /// answers true at once on a plain save; otherwise the renderer is asked
    /// and the save call or its ack answers.
    pub fn request_save(&self, view: ViewId, mode: SaveMode, done: Box<dyn FnOnce(bool)>) {
        if !self.is_alive(view) || !self.may_write(view) {
            return done(false);
        }
        if mode == SaveMode::Save && !self.is_dirty(view) && self.file_path(view).is_some() {
            return done(true);
        }
        let gen_id = self.new_gen();
        self.0.state.borrow_mut().save_waiters.set(
            view,
            gen_id,
            Box::new(move |wait| done(matches!(wait, Wait::Answer(true)))),
        );
        self.schedule(SAVE_WAIT, TimerJob::SaveWait(view, gen_id));
        self.emit(view, "mindmap:save-request", vec![string(mode_name(mode))]);
    }

    /// `mindmapSaveToPath`: save the live map to `path` with no dialog (the
    /// MCP server's "save before closing"); the view's save target points at
    /// `path` first so the renderer's normal save runs unattended.
    pub fn save_to_path(
        &self,
        view: ViewId,
        path: &str,
        done: Box<dyn FnOnce(Result<(), String>)>,
    ) {
        if !self.is_alive(view) {
            return done(Err("the map is no longer open".into()));
        }
        if !self.may_write(view) {
            return done(Err(
                "the file did not open, so there is no map to save".into()
            ));
        }
        let (previous_path, previous_open) = {
            let mut state = self.0.state.borrow_mut();
            let previous = (
                state.save_path.get(&view).cloned(),
                state.open_path.get(&view).cloned(),
            );
            state.save_path.insert(view, path.to_owned());
            state
                .allowed
                .entry(view)
                .or_default()
                .insert(path.to_owned());
            previous
        };
        let app = self.clone();
        let restore = move || {
            let mut state = app.0.state.borrow_mut();
            match previous_path {
                None => state.save_path.remove(&view),
                Some(p) => state.save_path.insert(view, p),
            };
            match previous_open {
                None => state.open_path.remove(&view),
                Some(p) => state.open_path.insert(view, p),
            };
        };
        let gen_id = self.new_gen();
        self.0.state.borrow_mut().save_waiters.set(
            view,
            gen_id,
            Box::new(move |wait| match wait {
                Wait::Timeout => {
                    restore();
                    done(Err("timed out saving the map".into()))
                }
                Wait::Answer(true) => done(Ok(())),
                Wait::Answer(false) => {
                    restore();
                    done(Err("could not save the map".into()))
                }
            }),
        );
        self.schedule(SAVE_WAIT, TimerJob::SaveWait(view, gen_id));
        self.emit(view, "mindmap:save-request", vec![string("save")]);
    }

    /// `discardMindmapRecovery`: a tool closes the map without saving
    pub fn discard_recovery(&self, view: ViewId) {
        self.view_dropped(view);
    }

    /// `mindmapRecoveryIdentity`: the copy this view writes, for the shell's
    /// session record; `None` for a view that is not a live map view
    pub fn recovery_identity(&self, view: ViewId) -> Option<RecoveryIdentity> {
        if !self.0.state.borrow().live.contains(&view) {
            return None;
        }
        let save_path = self.file_path(view);
        Some(self.view_recovery_identity(view, save_path.as_deref()))
    }

    /// `writeMindmapCopiesNow`: the OS is ending the session, every map view
    /// with unsaved changes writes a copy now. `done` runs when each has
    /// answered or `timeout` ran out.
    pub fn write_copies_now(&self, timeout: Duration, done: Box<dyn FnOnce()>) {
        let views: Vec<ViewId> = {
            let state = self.0.state.borrow();
            let mut views: Vec<ViewId> = state.live.iter().copied().collect();
            views.sort();
            views
        };
        let views: Vec<ViewId> = views
            .into_iter()
            .filter(|view| self.is_alive(*view) && self.is_dirty(*view) && self.may_write(*view))
            .collect();
        if views.is_empty() {
            return done();
        }
        let left = Rc::new(std::cell::Cell::new(views.len()));
        let done = Rc::new(RefCell::new(Some(done)));
        for view in views {
            // the earlier waiter of this view is finished first
            self.finish_copy_now(view, None);
            let gen_id = self.new_gen();
            let left = left.clone();
            let done = done.clone();
            self.0.state.borrow_mut().copy_now.insert(
                view,
                (
                    gen_id,
                    Box::new(move || {
                        left.set(left.get() - 1);
                        if left.get() == 0
                            && let Some(done) = done.borrow_mut().take()
                        {
                            done()
                        }
                    }),
                ),
            );
            self.schedule(timeout, TimerJob::CopyNow(view, gen_id));
            self.emit(view, "mindmap:recovery-copy-now", vec![]);
        }
    }

    /// resolves the view's copy-now waiter: the renderer reported, the view
    /// ended or its time ran out (`only` the waiter of that timer)
    pub(super) fn finish_copy_now(&self, view: ViewId, only: Option<u64>) {
        let finish = {
            let mut state = self.0.state.borrow_mut();
            match state.copy_now.get(&view) {
                Some((gen_id, _)) if only.is_none_or(|g| g == *gen_id) => {
                    state.copy_now.remove(&view).map(|(_, finish)| finish)
                }
                _ => None,
            }
        };
        if let Some(finish) = finish {
            finish();
        }
    }

    /// `openMindmapFileWithDecision`: open `request.file_path` in a map view
    /// the shell made, the recovery question already answered. Returns true
    /// when the view was pointed at another file and the shell must reload
    /// it (`contents.reload()`); call it in the tick the view is made with
    /// `create_view(view, Some(path))`.
    pub fn open_file_with_decision(&self, view: ViewId, request: &RecoveryOpenFileRequest) -> bool {
        self.set_view_open_decision(view, request.decision);
        let mut state = self.0.state.borrow_mut();
        if state.open_path.get(&view) == Some(&request.file_path) {
            return false;
        }
        state.open_path.insert(view, request.file_path.clone());
        state
            .allowed
            .insert(view, HashSet::from([request.file_path.clone()]));
        state.unopened.insert(view, Unopened::Pending);
        state.save_path.remove(&view);
        state.dirty.remove(&view);
        drop(state);
        self.is_alive(view)
    }

    /// `openMindmapUntitledCopy`: load a recovery copy into an untitled map
    /// view the shell made (call it in the tick the view is made with
    /// `create_view(view, None)`): the map opens unsaved
    pub fn open_untitled_copy(&self, view: ViewId, request: &RecoveryOpenUntitledRequest) {
        if let Some(bytes) = self.take_untitled_copy(view, request) {
            self.queue_seed(view, Seed::Copy(bytes));
        }
    }

    /// `sendMindmapMenuCommand`
    pub fn send_menu_command(&self, view: ViewId, command: &str) {
        if self.is_alive(view) {
            self.emit(view, "mindmap:menu-command", vec![string(command)]);
        }
    }

    /// `sendMindmapExportRequest`; `format` is png, svg, pdf or markdown
    pub fn send_export_request(&self, view: ViewId, format: &str) {
        if self.is_alive(view) {
            self.emit(view, "mindmap:export-request", vec![string(format)]);
        }
    }

    /// `render-process-gone`: a crashed view's recovery copies outlive it
    pub fn view_crashed(&self, view: ViewId) {
        self.recovery_of(view).crashed = true;
    }

    /// `mindmapReadOutline`: the map as outline text, unsaved edits included
    pub fn read_outline(&self, view: ViewId, done: Box<dyn FnOnce(Result<String, String>)>) {
        self.ask(
            Ask::Outline,
            view,
            Box::new(move |answer| {
                done(answer.map(|a| match a {
                    Answer::Text(text) => text,
                    Answer::Bytes(_) => String::new(),
                }))
            }),
        );
    }

    /// `mindmapReadBytes`: the `.xmind` bytes a save would write; nothing is written
    pub fn read_bytes(&self, view: ViewId, done: Box<dyn FnOnce(Result<Vec<u8>, String>)>) {
        self.ask(
            Ask::Bytes,
            view,
            Box::new(move |answer| {
                done(answer.map(|a| match a {
                    Answer::Bytes(bytes) => bytes,
                    Answer::Text(_) => Vec::new(),
                }))
            }),
        );
    }

    // ---- the reads of mcp-queries.ts ----

    fn ask(&self, kind: Ask, view: ViewId, done: AskDone) {
        if !self.is_alive(view) {
            return done(Err("the map is no longer open".into()));
        }
        {
            // one question per view at a time: concurrent callers share the answer
            let mut state = self.0.state.borrow_mut();
            if let Some(pending) = state.asks.get_mut(&(kind, view)) {
                pending.callbacks.push(done);
                return;
            }
        }
        let gen_id = self.new_gen();
        self.0.state.borrow_mut().asks.insert(
            (kind, view),
            PendingAsk {
                gen_id,
                callbacks: vec![done],
            },
        );
        self.schedule(RESEND, TimerJob::Resend(kind, view, gen_id));
        self.schedule(READ_TIMEOUT, TimerJob::AskTimeout(kind, view, gen_id));
        self.emit(view, kind.request_channel(), vec![]);
    }

    fn resend(&self, kind: Ask, view: ViewId, gen_id: u64) {
        let current = self
            .0
            .state
            .borrow()
            .asks
            .get(&(kind, view))
            .is_some_and(|pending| pending.gen_id == gen_id);
        if !current {
            return;
        }
        if !self.is_alive(view) {
            return self.settle_ask(
                kind,
                view,
                Some(gen_id),
                Err("the map is no longer open".into()),
            );
        }
        self.emit(view, kind.request_channel(), vec![]);
        self.schedule(RESEND, TimerJob::Resend(kind, view, gen_id));
    }

    /// resolves every caller of the view's pending question (`only` that one question)
    pub(super) fn settle_ask(
        &self,
        kind: Ask,
        view: ViewId,
        only: Option<u64>,
        result: Result<Answer, String>,
    ) {
        let callbacks = {
            let mut state = self.0.state.borrow_mut();
            match state.asks.get(&(kind, view)) {
                Some(pending) if only.is_none_or(|g| g == pending.gen_id) => state
                    .asks
                    .remove(&(kind, view))
                    .map(|pending| pending.callbacks),
                _ => None,
            }
        };
        for callback in callbacks.unwrap_or_default() {
            callback(result.clone());
        }
    }

    pub(super) fn has_pending_ask(&self, kind: Ask, view: ViewId) -> bool {
        self.0.state.borrow().asks.contains_key(&(kind, view))
    }

    /// the view's end (`wc.once('destroyed')`)
    pub(super) fn view_gone(&self, view: ViewId) {
        let dirty = self.is_dirty(view);
        self.recovery_view_gone(view, dirty);
        self.0.state.borrow_mut().live.remove(&view);
        self.finish_copy_now(view, None);
        {
            let mut state = self.0.state.borrow_mut();
            state.open_path.remove(&view);
            state.allowed.remove(&view);
            state.save_path.remove(&view);
            state.unopened.remove(&view);
            state.imported.remove(&view);
            state.dirty.remove(&view);
            state.disk_states.remove(&view);
            state.save_as_grants.remove(&view);
            state.seeds.remove(&view);
        }
        let close = self.0.state.borrow_mut().close_waiters.take(view);
        if let Some(waiter) = close {
            waiter(Wait::Answer(false));
        }
        let save = self.0.state.borrow_mut().save_waiters.take(view);
        if let Some(waiter) = save {
            waiter(Wait::Answer(false));
        }
        // a read of this map that is still waiting can never be answered
        for kind in [Ask::Outline, Ask::Bytes] {
            if self.has_pending_ask(kind, view) {
                self.settle_ask(kind, view, None, Err("the map is no longer open".into()));
            }
        }
    }

    /// the folder for an untitled map's save dialog: the project folder or
    /// the configured default; `Err` is what `configuredDefaultSaveDir` threw
    pub(super) fn default_save_dir(&self) -> Result<String, String> {
        use main_core::packages::electron_utils::default_save_dir::configured_default_save_dir;
        let paths = crate::host::Paths(&*self.0.services.paths);
        let mut state = self
            .0
            .shared
            .save_dir
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        configured_default_save_dir(&paths, &mut state, now_ms()).map_err(|thrown| thrown.0)
    }

    /// Runs `work` on a worker and then `done` on the core thread with its
    /// result: for what TypeScript awaited that is not a dialog or a small file
    pub(super) fn offload<R: Send + 'static>(
        &self,
        work: impl FnOnce() -> R + Send + 'static,
        done: impl FnOnce(&MindmapApp, R) + Send + 'static,
    ) {
        let core = self.0.services.core.clone();
        self.0.services.workers.spawn(Box::new(move || {
            let result = work();
            core.post(Box::new(move || {
                super::with_app(|app| done(app, result));
            }));
        }));
    }
}

fn spawn_wake(core: Arc<dyn shell_contract::runtime::Thread>) -> Option<mpsc::Sender<Instant>> {
    let (tx, rx) = mpsc::channel::<Instant>();
    std::thread::Builder::new()
        .name("mindmap-timers".into())
        .spawn(move || {
            let mut deadlines: BinaryHeap<Reverse<Instant>> = BinaryHeap::new();
            loop {
                let next = deadlines.peek().map(|Reverse(at)| *at);
                match next {
                    Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now()))
                    {
                        Ok(deadline) => deadlines.push(Reverse(deadline)),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    },
                    None => match rx.recv() {
                        Ok(deadline) => deadlines.push(Reverse(deadline)),
                        Err(_) => return,
                    },
                }
                let now = Instant::now();
                let mut fire = false;
                while deadlines.peek().is_some_and(|Reverse(at)| *at <= now) {
                    deadlines.pop();
                    fire = true;
                }
                if fire {
                    core.post(Box::new(|| {
                        super::with_app(|app| app.run_due(Instant::now()))
                    }));
                }
            }
        })
        .ok()
        .map(|_| tx)
}

#[cfg(test)]
mod wait_table_tests {
    use std::cell::Cell;
    use std::rc::Rc;

    use super::*;

    /// TypeScript clears a save's timer when the renderer answers: the timer
    /// of an answered save leaves the view's next save waiting for its reply
    #[test]
    fn an_answered_waits_timer_leaves_the_next_wait() {
        let mut table = WaitTable::default();
        let view = ViewId(1);
        let answered = Rc::new(Cell::new(0));
        let count = |n: u32| {
            let answered = answered.clone();
            Box::new(move |_: Wait| answered.set(answered.get() + n)) as Waiter
        };
        table.set(view, 1, count(1));
        table.take(view).expect("the first wait")(Wait::Timeout);
        table.set(view, 2, count(10));
        assert!(table.expire(view, 1).is_none());
        table.take(view).expect("the next wait")(Wait::Timeout);
        assert_eq!(answered.get(), 11);
    }
}
