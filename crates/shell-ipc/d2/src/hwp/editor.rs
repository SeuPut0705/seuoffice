//! `apps/hwp/src/main/hwp-main.ts`: the Hangul views' state, the channels
//! of open, save and close, and what other areas call ([`HwpEditors`]).
//!
//! The module-level maps keyed by `webContents.id` are one [`View`] per view,
//! dropped when the view is destroyed (`grantAndTrack`'s `destroyed` hook,
//! after recovery has settled the view's copy, as `trackHwpRecovery` ran
//! first there). The promises that waited for the renderer (`saveWaiters`,
//! `closeSaveWaiters`, `readBytesWaiters`, `headlessWaiters`) are
//! continuations kept by view and settled by the renderer's answer, a timer
//! or the view's end. File work and the engine run on a worker.
//!
//! What differs from the TypeScript, and why:
//! - A view's state is made when a channel first touches it and dropped with
//!   the view, for every view, where the TypeScript kept the entries of a
//!   view it never tracked forever.
//! - A save or read that finishes after its view is gone answers but leaves
//!   no state behind (the TypeScript wrote it into maps nothing cleared).
//! - `requestHwpClose` asked again while the first is still waiting: the
//!   first is declined at once (the TypeScript left it to its own timer,
//!   which then dropped the second's resolver).
//! - The dialog folder memory and the default-save-folder state were one per
//!   process in Electron; here they are this editor's.
//! - `console.warn` of a save that dropped master pages is not written: the
//!   reply's `tailsLost` says it.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jscompat::node_path::host::{basename, dirname, join, resolve};
use jscompat::{JsObject, JsonValue};
use main_core::hwp::field_kinds::field_kinds_of;
use main_core::hwp::ipc::HwpFormat;
use main_core::hwp::recovery::{
    HwpRecovery, HwpRecoveryHost, MAX_HWP_SAVE_BYTES, RecoveryTimer, UntitledCopy,
    hwp_format_of_path,
};
use main_core::hwp::save_as_formats::{
    HwpSaveAsKind, save_as_default_path, save_as_filters, save_as_target,
};
use main_core::hwp::save_fixes::{SaveBase, apply_save_fixes};
use main_core::hwp::save_plan::{backup_path_for, bytes_match_format, needs_backup};
use main_core::hwp::section_tails::section_tails_of;
use main_core::hwp::tab_widths::new_tabs_of;
use main_core::packages::electron_utils::atomic_write::atomic_write_file;
use main_core::packages::electron_utils::default_save_dir::{
    SaveDirState, configured_default_save_dir,
};
use main_core::packages::electron_utils::dialog_memory::{
    DialogMemory, show_save_dialog_with_memory,
};
use main_core::packages::electron_utils::hwp_default_format::{
    HwpDefaultFormat, read_hwp_default_format,
};
use main_core::packages::electron_utils::recovery_contract::{
    RecoveryEditorContract, RecoveryOpenFileRequest, RecoveryOpenUntitledRequest,
};
use main_core::packages::electron_utils::recovery_store::{RecoveryIdentity, SharedRecoveryState};
use main_core::packages::electron_utils::safe_external_url::{
    SafeExternalUrlOptions, safe_external_url,
};
use main_core::packages::electron_utils::save_conflict::{
    SaveConflictAnswer, SaveConflictOptions, SaveDiskState, confirm_overwrite_if_conflicted,
    record_disk_state, should_defer_auto_save,
};
use main_core::packages::i18n::{Lang, normalize_lang};
use main_core::shell::rename_validation::is_same_file;
use shell_contract::editors::Then;
use shell_contract::hosts::{ContentsHost, DialogsHost, MessageBox, OsShellHost};
use shell_contract::ipc::{CallContext, RegisterError, Target};
use shell_contract::runtime::Services;
use shell_contract::{
    Batch, BytesKind, DocumentEditors, IpcError, IpcValue, SaveMode, ViewId, WindowId,
};

use super::memos::{Memos, commit_options_of, lost_memo_count_of};
use super::recovery::Electron;
use super::{
    AppPaths, Boxes, FileDialogs, HwpEngineHost, HwpShellHost, KeyInput, Parent, TrackedChanges,
};
use crate::kit::{
    self, Args, Entry, IntoIpc, Timer, as_str, error, field, from_json, obj, on_worker, to_json,
    u8_array,
};

/// How long a save or a close waits for the renderer
const SAVE_WAIT: Duration = Duration::from_millis(120_000);
/// `READ_TEXT_TIMEOUT_MS`: how long a live read may take
const READ_TEXT_TIMEOUT: Duration = Duration::from_millis(30_000);
/// `READ_TEXT_RETRY_MS`: how often the request is sent again unanswered
const READ_TEXT_RETRY: Duration = Duration::from_millis(250);
/// `exportHwpPdfHeadless`'s default `timeoutMs`
pub const HEADLESS_TIMEOUT_MS: u64 = 180_000;
/// Why a save stood down: the file moved on disk after this copy read or wrote it
const EXTERNAL_MODIFIED: &str = "hwp: external-modified";

/// One view's entries of hwp-main.ts's maps and sets
#[derive(Default)]
pub(super) struct View {
    /// `hwpViews`: set up by `grantAndTrack`
    pub granted: bool,
    /// `openPathByWc`
    pub open_path: Option<String>,
    /// `allowedByWc`
    pub allowed: HashSet<String>,
    /// `savePathByWc`
    pub save_path: Option<String>,
    /// `untitledCopyByWc`
    pub untitled_copy: Option<UntitledCopy>,
    /// `dirtyByWc`
    pub dirty: bool,
    /// `memoModalByWc`
    pub memo_modal: bool,
    /// `pendingSaveByWc`
    pub pending_save: Option<(String, HwpFormat)>,
    /// `pdfSaveAsByWc`
    pub pdf_save_as: Option<String>,
    /// `headlessTargetByWc`
    pub headless_target: Option<String>,
    /// `headlessPdfByWc`
    pub headless_pdf: Option<String>,
    /// `writtenByWc`
    pub written: HashSet<String>,
    /// `tailsByWc` and `fieldKindsByWc`
    pub base: SaveBase,
    /// `trackedByWc`
    pub tracked: bool,
    /// `trackingDroppedByWc`
    pub tracking_dropped: bool,
    /// `unverifiedByWc`
    pub unverified: Option<String>,
    /// `diskStatesByWc`
    pub disk_states: HashMap<String, SaveDiskState>,
}

/// A promise waiting for the renderer: its resolver and its timer
struct Waiter {
    id: u64,
    timer: Option<Timer>,
    then: Box<dyn FnOnce(bool)>,
}

/// `hwpReadText`'s request in flight: every caller shares its answer
struct ReadText {
    id: u64,
    answered: bool,
    retry: Timer,
    timeout: Timer,
    thens: Vec<Then<String>>,
}

/// `exportHwpPdfHeadless`'s promise
struct Headless {
    timer: Timer,
    then: Then<()>,
}

/// `HwpViewOptions.untitledCopy`
#[derive(Clone, Debug, PartialEq)]
pub enum UntitledOption {
    No,
    /// `true`: a skill template's copy, named as its file
    Copy,
    /// `{ baseName }`: a PDF the editor imports
    Pdf {
        base_name: String,
    },
}

/// hwp-main.ts's module state and the hosts its handlers use
pub(crate) struct Hwp {
    pub(super) services: Services,
    pub(super) engine: HwpEngineHost,
    pub(super) shell: HwpShellHost,
    dialogs: DialogsHost,
    contents: ContentsHost,
    os: OsShellHost,
    pub(super) boxes: Boxes,
    pub(super) views: RefCell<HashMap<ViewId, View>>,
    save_waiters: RefCell<HashMap<ViewId, Waiter>>,
    close_waiters: RefCell<HashMap<ViewId, Waiter>>,
    reads: RefCell<HashMap<ViewId, ReadText>>,
    headless: RefCell<HashMap<ViewId, Headless>>,
    /// `installFileShortcuts`' `resending`, per view
    resending: RefCell<HashSet<ViewId>>,
    pub(super) recovery: RefCell<HwpRecovery>,
    pub(super) recovery_state: Arc<Mutex<SharedRecoveryState>>,
    pub(super) recovery_timers: RefCell<HashMap<RecoveryTimer, Timer>>,
    /// the shell's one folder memory of Electron's `dialog`
    dialog_memory: Arc<Mutex<DialogMemory>>,
    save_dir: Arc<Mutex<SaveDirState>>,
    _destroyed: Rc<dyn Fn(ViewId)>,
}

pub(super) fn wc(view: ViewId) -> i64 {
    i64::from(view.0)
}

pub(super) fn view_of(wc_id: i64) -> ViewId {
    ViewId(wc_id as u32)
}

/// `data instanceof Uint8Array`
pub(super) fn uint8(v: &IpcValue) -> Option<&[u8]> {
    match v {
        IpcValue::Bytes(BytesKind::Uint8Array, b) => Some(b),
        _ => None,
    }
}

/// `{ name, format }`
fn untitled_copy_ipc(copy: &UntitledCopy) -> IpcValue {
    obj([
        ("name", copy.name.as_str().into_ipc()),
        ("format", copy.format.as_str().into_ipc()),
    ])
}

/// What crash recovery (recovery.ts) reads and sets of the views' state
struct RecoveryHost(Weak<Hwp>);

impl RecoveryHost {
    fn with<R: Default>(&self, wc_id: i64, f: impl FnOnce(&View) -> R) -> R {
        let Some(hwp) = self.0.upgrade() else {
            return R::default();
        };
        let views = hwp.views.borrow();
        views.get(&view_of(wc_id)).map(f).unwrap_or_default()
    }

    fn change(&self, wc_id: i64, f: impl FnOnce(&mut View)) {
        if let Some(hwp) = self.0.upgrade() {
            hwp.change(view_of(wc_id), f)
        }
    }
}

impl HwpRecoveryHost for RecoveryHost {
    fn save_path_of(&self, wc_id: i64) -> Option<String> {
        self.with(wc_id, |v| v.save_path.clone())
    }
    fn untitled_copy_of(&self, wc_id: i64) -> Option<UntitledCopy> {
        self.with(wc_id, |v| v.untitled_copy.clone())
    }
    fn open_path_of(&self, wc_id: i64) -> Option<String> {
        self.with(wc_id, |v| v.open_path.clone())
    }
    fn save_base_of(&self, wc_id: i64) -> SaveBase {
        self.with(wc_id, |v| v.base.clone())
    }
    fn is_dirty(&self, wc_id: i64) -> bool {
        self.with(wc_id, |v| v.dirty)
    }
    fn mark_dirty(&self, wc_id: i64) {
        self.change(wc_id, |v| v.dirty = true)
    }
    fn queue_file(&self, wc_id: i64, path: &str) {
        self.change(wc_id, |v| {
            v.open_path = Some(path.to_owned());
            v.allowed.insert(path.to_owned());
            v.save_path = Some(path.to_owned());
            v.untitled_copy = None;
        })
    }
    fn queue_untitled_copy(&self, wc_id: i64, path: &str, copy: UntitledCopy) {
        self.change(wc_id, |v| {
            v.open_path = Some(path.to_owned());
            v.allowed.insert(path.to_owned());
            v.save_path = None;
            v.untitled_copy = Some(copy);
        })
    }
}

impl Hwp {
    pub(super) fn new(services: &Services) -> Result<Rc<Hwp>, RegisterError> {
        let hosts = &services.hosts;
        let engine = hosts.need::<HwpEngineHost>(Batch::D2)?;
        let shell = hosts.need::<HwpShellHost>(Batch::D2)?;
        let dialogs = hosts.need::<DialogsHost>(Batch::D2)?;
        let contents = hosts.need::<ContentsHost>(Batch::D2)?;
        let os = hosts.need::<OsShellHost>(Batch::D2)?;
        let recovery_state = hosts.need::<Arc<Mutex<SharedRecoveryState>>>(Batch::D2)?;
        let dialog_memory = hosts.need::<Arc<Mutex<DialogMemory>>>(Batch::D2)?;
        let save_dir = hosts.need::<Arc<Mutex<SaveDirState>>>(Batch::D2)?;
        let hwp = Rc::new_cyclic(|weak: &Weak<Hwp>| {
            let gone = weak.clone();
            let destroyed = kit::on_view_destroyed(services, move |view| {
                if let Some(hwp) = gone.upgrade() {
                    hwp.destroyed(view)
                }
            });
            let mut recovery = HwpRecovery::new();
            recovery.install_hwp_recovery(Rc::new(RecoveryHost(weak.clone())));
            Hwp {
                services: services.clone(),
                engine,
                shell,
                boxes: Boxes(dialogs.clone()),
                dialogs,
                contents,
                os,
                views: RefCell::default(),
                save_waiters: RefCell::default(),
                close_waiters: RefCell::default(),
                reads: RefCell::default(),
                headless: RefCell::default(),
                resending: RefCell::default(),
                recovery: RefCell::new(recovery),
                recovery_state,
                recovery_timers: RefCell::default(),
                dialog_memory,
                save_dir,
                _destroyed: destroyed,
            }
        });
        Ok(hwp)
    }

    /// reads a view's state (the defaults when it has none)
    pub(super) fn get<R>(&self, view: ViewId, f: impl FnOnce(&View) -> R) -> R {
        let views = self.views.borrow();
        match views.get(&view) {
            Some(v) => f(v),
            None => f(&View::default()),
        }
    }

    /// changes a view's state, making it when it has none
    pub(super) fn change<R>(&self, view: ViewId, f: impl FnOnce(&mut View) -> R) -> R {
        f(self.views.borrow_mut().entry(view).or_default())
    }

    /// `contents.isDestroyed()`
    pub(super) fn is_destroyed(&self, view: ViewId) -> bool {
        self.services.views.sender_of(view).is_none()
    }

    pub(super) fn emit(&self, view: ViewId, channel: &'static str, args: Vec<IpcValue>) {
        self.services.events.emit(Target::View(view), channel, args)
    }

    pub(super) fn lang(&self) -> Lang {
        normalize_lang(Some(&self.shell.ui_lang()))
    }

    fn tm(&self, key: &str) -> String {
        main_core::hwp::dialog_strings::tm(self.lang(), key, None)
    }

    /// `BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getFocusedWindow()`
    fn window_of(&self, view: ViewId) -> Option<WindowId> {
        self.contents
            .window_of(view)
            .or_else(|| self.shell.focused_window())
    }

    /// `readHwpDefaultFormat(app)`
    fn default_format(&self) -> HwpFormat {
        match read_hwp_default_format(&AppPaths(self.services.paths.clone())) {
            HwpDefaultFormat::Hwp => HwpFormat::Hwp,
            HwpDefaultFormat::Hwpx => HwpFormat::Hwpx,
        }
    }

    /// Runs `f` with recovery, its Electron side and the process's recovery
    /// state. `f` must not reach this editor's views borrowed elsewhere.
    pub(super) fn with_recovery<R>(
        self: &Rc<Self>,
        f: impl FnOnce(&mut HwpRecovery, &Electron<'_>, &SharedRecoveryState) -> R,
    ) -> R {
        let state = Arc::clone(&self.recovery_state);
        let shared = state.lock().unwrap_or_else(|e| e.into_inner());
        let mut recovery = self.recovery.borrow_mut();
        f(&mut recovery, &Electron(self), &shared)
    }

    /// `settleSave(wcId, ok)`
    fn settle_save(&self, view: ViewId, ok: bool) {
        let waiter = self.save_waiters.borrow_mut().remove(&view);
        if let Some(waiter) = waiter {
            if let Some(timer) = waiter.timer {
                kit::clear(timer)
            }
            (waiter.then)(ok)
        }
    }

    /// A waiter in `table` that a timer settles with `false`, unless it was
    /// settled first
    fn wait(
        self: &Rc<Self>,
        table: fn(&Hwp) -> &RefCell<HashMap<ViewId, Waiter>>,
        view: ViewId,
        then: Box<dyn FnOnce(bool)>,
    ) {
        let id = kit::unique();
        let weak = Rc::downgrade(self);
        let timer = kit::after(&self.services, SAVE_WAIT, move || {
            let Some(hwp) = weak.upgrade() else { return };
            let mine = {
                let mut map = table(&hwp).borrow_mut();
                match map.get(&view) {
                    Some(w) if w.id == id => map.remove(&view),
                    _ => None,
                }
            };
            if let Some(w) = mine {
                (w.then)(false)
            }
        });
        let old = table(self).borrow_mut().insert(
            view,
            Waiter {
                id,
                timer: Some(timer),
                then,
            },
        );
        // a close asked again while the first waits: the first ends now, declined
        if let Some(old) = old {
            if let Some(t) = old.timer {
                kit::clear(t)
            }
            (old.then)(false)
        }
    }

    /// `requestHwpSave(contents, mode)`: ask the renderer to export and save;
    /// `then(true)` only when bytes were written
    pub(crate) fn request_save(
        self: &Rc<Self>,
        view: ViewId,
        mode: &str,
        then: Box<dyn FnOnce(bool)>,
    ) {
        if self.is_destroyed(view) {
            return then(false);
        }
        // a memo editor is open: its text is not in the document yet
        if self.get(view, |v| v.memo_modal) {
            self.emit(view, "hwp:memo-blocked", vec![]);
            return then(false);
        }
        // one save at a time per view
        if self.save_waiters.borrow().contains_key(&view) {
            return then(false);
        }
        self.wait(|h| &h.save_waiters, view, then);
        self.emit(view, "hwp:save-request", vec![mode.into_ipc()]);
    }

    /// `requestHwpPrint(contents, mode)`: the File menu's PDF export
    pub(crate) fn request_print(&self, view: ViewId, mode: &str) {
        if !self.is_destroyed(view) {
            self.emit(view, "hwp:print-request", vec![mode.into_ipc()])
        }
    }

    /// `requestHwpPreview(contents, action)`
    pub(crate) fn request_preview(&self, view: ViewId, action: &str) {
        if !self.is_destroyed(view) {
            self.emit(view, "hwp:preview-request", vec![action.into_ipc()])
        }
    }

    fn ask(
        &self,
        parent: Option<WindowId>,
        message: &str,
        detail: &str,
        buttons: &[&str],
        default_id: usize,
        cancel_id: usize,
    ) -> usize {
        self.dialogs
            .message(
                parent,
                &MessageBox {
                    kind: Some("warning".into()),
                    title: None,
                    message: self.tm(message),
                    detail: Some(self.tm(detail)),
                    buttons: buttons.iter().map(|b| self.tm(b)).collect(),
                    default_id: Some(default_id),
                    cancel_id: Some(cancel_id),
                    checkbox_label: None,
                },
            )
            .response
    }

    /// `requestHwpClose(contents, parent)`: true means the view may close
    pub(crate) fn request_close(
        self: &Rc<Self>,
        view: ViewId,
        parent: Option<WindowId>,
        then: Box<dyn FnOnce(bool)>,
    ) {
        if self.is_destroyed(view) {
            return then(true);
        }
        // a clean tab can still hold memo text that has not reached the document
        if self.get(view, |v| v.memo_modal) {
            let response = self.ask(
                parent,
                "closeMemoMsg",
                "closeMemoDetail",
                &["btnDiscardClose", "btnCancel"],
                1,
                1,
            );
            if response != 0 {
                return then(false);
            }
            // the memo text and any unsaved changes are given up: so is their copy
            if !self.is_destroyed(view) && self.get(view, |v| v.dirty) {
                self.discard_recovery_copy(view)
            }
            return then(true);
        }
        if !self.get(view, |v| v.dirty) {
            return then(true);
        }
        let response = self.ask(
            parent,
            "closeUnsavedMsg",
            "closeUnsavedDetail",
            &["btnSave", "btnDontSave", "btnCancel"],
            0,
            2,
        );
        if response == 2 {
            return then(false);
        }
        if response == 1 {
            self.discard_recovery_copy(view);
            return then(true);
        }
        self.wait(|h| &h.close_waiters, view, then);
        self.emit(view, "hwp:close-save-request", vec![]);
    }

    /// `hwpDiscardRecoveryCopy` (`hwpRecoveryDontSave`)
    pub(crate) fn discard_recovery_copy(self: &Rc<Self>, view: ViewId) {
        self.with_recovery(|r, e, s| r.hwp_recovery_dont_save(e, s, wc(view)))
    }

    /// `hwpReadText(contents)`: the document's text as the editor holds it
    pub(crate) fn read_text(self: &Rc<Self>, view: ViewId, then: Then<String>) {
        if self.is_destroyed(view) {
            return then(Err(error("the document is no longer open")));
        }
        if let Some(read) = self.reads.borrow_mut().get_mut(&view) {
            read.thens.push(then);
            return;
        }
        let id = kit::unique();
        let weak = Rc::downgrade(self);
        let timeout = kit::after(&self.services, READ_TEXT_TIMEOUT, move || {
            if let Some(hwp) = weak.upgrade() {
                hwp.settle_read(view, id, Err(error("timed out reading the document")))
            }
        });
        let retry = self.arm_retry(view, id);
        self.reads.borrow_mut().insert(
            view,
            ReadText {
                id,
                answered: false,
                retry,
                timeout,
                thens: vec![then],
            },
        );
        self.emit(view, "hwp:read-bytes-request", vec![]);
    }

    /// the `setInterval` that sends the request again until it is answered
    fn arm_retry(self: &Rc<Self>, view: ViewId, id: u64) -> Timer {
        let weak = Rc::downgrade(self);
        kit::after(&self.services, READ_TEXT_RETRY, move || {
            let Some(hwp) = weak.upgrade() else { return };
            let answered = match hwp.reads.borrow().get(&view) {
                Some(read) if read.id == id => read.answered,
                _ => return,
            };
            if hwp.is_destroyed(view) {
                return hwp.settle_read(view, id, Err(error("the document is no longer open")));
            }
            if !answered {
                hwp.emit(view, "hwp:read-bytes-request", vec![]);
            }
            let next = hwp.arm_retry(view, id);
            if let Some(read) = hwp.reads.borrow_mut().get_mut(&view) {
                read.retry = next;
            }
        })
    }

    fn settle_read(&self, view: ViewId, id: u64, result: Result<String, IpcError>) {
        let read = {
            let mut reads = self.reads.borrow_mut();
            match reads.get(&view) {
                Some(read) if read.id == id => reads.remove(&view),
                _ => None,
            }
        };
        if let Some(read) = read {
            kit::clear(read.retry);
            kit::clear(read.timeout);
            for then in read.thens {
                then(result.clone())
            }
        }
    }

    /// the renderer's `hwp:read-bytes-result`: the first answer counts
    fn read_bytes_result(self: &Rc<Self>, view: ViewId, result: &IpcValue) {
        let id = match self.reads.borrow_mut().get_mut(&view) {
            Some(read) if !read.answered => {
                read.answered = true;
                read.id
            }
            _ => return,
        };
        let bytes = match (field(result, "ok"), uint8(field(result, "bytes"))) {
            (IpcValue::Bool(true), Some(bytes)) => bytes.to_vec(),
            _ => {
                let message = as_str(field(result, "error"))
                    .unwrap_or("the editor returned no document")
                    .to_owned();
                return self.settle_read(view, id, Err(error(message)));
            }
        };
        let engine = Arc::clone(&self.engine);
        let weak = Rc::downgrade(self);
        on_worker(
            &self.services,
            move || engine.hwp_to_text(&bytes),
            move |text| {
                if let Some(hwp) = weak.upgrade() {
                    hwp.settle_read(view, id, text.map_err(error))
                }
            },
        );
    }

    /// `hwpFileRenamed(contents, oldPath, newPath)`
    pub(crate) fn file_renamed(self: &Rc<Self>, view: ViewId, old_path: &str, new_path: &str) {
        self.change(view, |v| {
            if v.save_path.as_deref() == Some(old_path) {
                v.save_path = Some(new_path.to_owned());
            }
            if v.open_path.as_deref() == Some(old_path) {
                v.open_path = Some(new_path.to_owned());
            }
            if v.allowed.contains(old_path) {
                v.allowed.insert(new_path.to_owned());
            }
            // the renamed file is the same bytes: the recorded state follows the path
            if let Some(recorded) = v.disk_states.remove(old_path) {
                v.disk_states.insert(new_path.to_owned(), recorded);
            }
        });
        self.with_recovery(|r, e, s| {
            r.hwp_recovery_file_renamed(e, s, wc(view), old_path, new_path)
        })
    }

    /// `grantAndTrack(wc, openPath, options)`: the shell made a Hangul view
    /// (`createHwpView`) for `open_path`
    pub(crate) fn grant_and_track(
        self: &Rc<Self>,
        view: ViewId,
        open_path: Option<&str>,
        untitled: UntitledOption,
    ) {
        self.change(view, |v| v.granted = true);
        // first: its close settles the recovery copy while the view's state is here
        self.recovery.borrow_mut().track_hwp_recovery(wc(view));
        let Some(path) = open_path.filter(|p| !p.is_empty() && Path::new(p).exists()) else {
            return;
        };
        let copy = match &untitled {
            UntitledOption::No => None,
            UntitledOption::Copy => Some(basename(path, None)),
            // a PDF opened to be imported is named as the document it becomes
            UntitledOption::Pdf { base_name } => {
                Some(format!("{base_name}.{}", self.default_format().as_str()))
            }
        };
        self.change(view, |v| {
            v.open_path = Some(path.to_owned());
            v.allowed = HashSet::from([path.to_owned()]);
            match copy {
                Some(name) => {
                    let format = hwp_format_of_path(&name).unwrap_or(HwpFormat::Hwp);
                    v.untitled_copy = Some(UntitledCopy { name, format });
                }
                None => v.save_path = Some(path.to_owned()),
            }
        });
    }

    /// `setWindowOpenHandler`: a link the page opens goes to the browser
    pub(crate) fn window_open(&self, url: &str) {
        let options = SafeExternalUrlOptions {
            allowed_protocols: Some(vec!["http:".into(), "https:".into(), "mailto:".into()]),
        };
        if let Some(target) = safe_external_url(Some(url), Some(&options)) {
            let _ = self.os.open_external(&target);
        }
    }

    /// the view's `render-process-gone`
    pub(crate) fn render_process_gone(self: &Rc<Self>, view: ViewId, reason: &str) {
        self.recovery.borrow_mut().render_process_gone(wc(view));
        // a dead renderer cannot close its memo editor
        if self.views.borrow().contains_key(&view) {
            self.change(view, |v| v.memo_modal = false);
        }
        self.settle_headless(view, Err(format!("hwp renderer stopped ({reason})")));
    }

    /// the view's `did-start-navigation`: a page that reloads starts
    /// without a memo editor
    pub(crate) fn did_start_navigation(
        &self,
        view: ViewId,
        is_main_frame: bool,
        is_same_document: bool,
    ) {
        if is_main_frame && !is_same_document && self.views.borrow().contains_key(&view) {
            self.change(view, |v| v.memo_modal = false)
        }
    }

    /// `exportHwpPdfHeadless(input, outPath, timeoutMs)`: a hidden view opens
    /// the file and runs the PDF export to `out_path`
    pub(crate) fn export_hwp_pdf_headless(
        self: &Rc<Self>,
        input: &str,
        out_path: &str,
        timeout_ms: u64,
        then: Then<()>,
    ) {
        let view = match self.shell.create_headless_view() {
            Ok(view) => view,
            Err(e) => return then(Err(error(e))),
        };
        self.grant_and_track(view, Some(input), UntitledOption::No);
        self.change(view, |v| {
            v.headless_target = Some(out_path.to_owned());
            v.headless_pdf = Some(out_path.to_owned());
        });
        let weak = Rc::downgrade(self);
        let timer = kit::after(
            &self.services,
            Duration::from_millis(timeout_ms),
            move || {
                if let Some(hwp) = weak.upgrade() {
                    // a document with an open password waits for one, and no one is there
                    hwp.settle_headless(view, Err(format!("hwp export timed out after {timeout_ms}ms (a password-protected document cannot be exported this way)")))
                }
            },
        );
        self.headless
            .borrow_mut()
            .insert(view, Headless { timer, then });
        self.shell.load_headless_view(view);
    }

    fn settle_headless(&self, view: ViewId, report: Result<(), String>) {
        let waiter = self.headless.borrow_mut().remove(&view);
        if let Some(waiter) = waiter {
            kit::clear(waiter.timer);
            self.shell.destroy_headless_view(view);
            (waiter.then)(report.map_err(error))
        }
    }

    /// `hwpIsDirty(webContentsId)`
    pub(crate) fn is_dirty(&self, view: ViewId) -> bool {
        self.get(view, |v| v.dirty)
    }

    /// `hwpMemoModalOpen(webContentsId)`
    pub(crate) fn memo_modal_open(&self, view: ViewId) -> bool {
        self.get(view, |v| v.memo_modal)
    }

    /// the `destroyed` hooks of `trackHwpRecovery` and `grantAndTrack`, in that order
    fn destroyed(self: &Rc<Self>, view: ViewId) {
        if self.get(view, |v| v.granted) {
            self.with_recovery(|r, e, s| r.destroyed(e, s, wc(view)));
        }
        let gone = self.views.borrow_mut().remove(&view);
        drop(gone);
        self.resending.borrow_mut().remove(&view);
        let close = self.close_waiters.borrow_mut().remove(&view);
        if let Some(close) = close {
            if let Some(t) = close.timer {
                kit::clear(t)
            }
            (close.then)(false)
        }
        self.settle_save(view, false);
    }

    /// `installFileShortcuts`' `before-input-event`: true when the key is
    /// taken (`event.preventDefault()`)
    pub(crate) fn before_input(self: &Rc<Self>, view: ViewId, input: &KeyInput) -> bool {
        if self.resending.borrow_mut().remove(&view) {
            return false;
        }
        if input.kind != "keyDown" || input.is_auto_repeat {
            return false;
        }
        if input.alt {
            return self.hancom_file_key(view, input);
        }
        let mac = cfg!(target_os = "macos");
        let modifier = if mac { input.meta } else { input.control };
        if !modifier {
            return false;
        }
        let code = input.code.as_str();
        if matches!(code, "KeyE" | "KeyC" | "KeyX") && !input.shift {
            let key = match code {
                "KeyE" => "ctrl-e",
                "KeyC" => "ctrl-c",
                _ => "ctrl-x",
            };
            // macOS turns Cmd+C/X into copy/cut only through the menu's roles,
            // which never see a resent key
            let mac_clip = mac && key != "ctrl-e";
            let asked = match (mac_clip, key) {
                (true, "ctrl-c") => "cmd-c",
                (true, _) => "cmd-x",
                _ => key,
            };
            let mut modifiers = Vec::new();
            if input.control {
                modifiers.push("control");
            }
            if input.meta {
                modifiers.push("meta");
            }
            if input.shift {
                modifiers.push("shift");
            }
            let key_code = input.key.clone();
            self.editor_takes(view, asked, move |hwp, taken| {
                if taken {
                    return;
                }
                if mac_clip {
                    if key == "ctrl-c" {
                        hwp.shell.copy(view)
                    } else {
                        hwp.shell.cut(view)
                    }
                    return;
                }
                hwp.resending.borrow_mut().insert(view);
                hwp.shell.send_key(view, &key_code, &modifiers);
            });
            return true;
        }
        if code == "KeyO" && !input.shift {
            return self.shell.open_file_dialog();
        }
        if code == "KeyH" && input.shift {
            // in a table cell it is Hangul's horizontal sum
            self.editor_takes(view, "ctrl-shift-h", |hwp, taken| {
                if !taken {
                    hwp.shell.go_home();
                }
            });
            return true;
        }
        if code == "KeyP" && !input.shift {
            self.request_preview(view, "print");
            return true;
        }
        if code != "KeyS" {
            return false;
        }
        if !input.shift {
            self.request_save(view, "save", Box::new(|_| {}));
            return true;
        }
        // in a block of cells it is Hangul's block sum, elsewhere "save as"
        self.editor_takes(view, "ctrl-shift-s", move |hwp, taken| {
            if !taken {
                hwp.request_save(view, "saveAs", Box::new(|_| {}))
            }
        });
        true
    }

    /// `hancomFileKey(wc, input)`: Hangul's Alt+N/O/S/V/P, not on a Mac
    pub(crate) fn hancom_file_key(self: &Rc<Self>, view: ViewId, input: &KeyInput) -> bool {
        if cfg!(target_os = "macos") || input.shift || input.control || input.meta {
            return false;
        }
        match input.code.as_str() {
            "KeyN" => self.shell.new_document(),
            "KeyO" => self.shell.open_file_dialog(),
            "KeyS" => {
                self.request_save(view, "save", Box::new(|_| {}));
                true
            }
            "KeyV" => {
                self.request_save(view, "saveAs", Box::new(|_| {}));
                true
            }
            "KeyP" => {
                self.request_preview(view, "print");
                true
            }
            _ => false,
        }
    }

    /// `editorTakes(wc, key).then(then)`: the frame answers on a worker
    fn editor_takes(
        self: &Rc<Self>,
        view: ViewId,
        key: &'static str,
        then: impl FnOnce(&Rc<Hwp>, bool) + 'static,
    ) {
        if self.is_destroyed(view) {
            return then(self, false);
        }
        let shell = Arc::clone(&self.shell);
        let weak = Rc::downgrade(self);
        on_worker(
            &self.services,
            move || shell.editor_takes(view, key),
            move |taken| {
                if let Some(hwp) = weak.upgrade() {
                    then(&hwp, taken)
                }
            },
        );
    }
}

/// `sameFile(a, b)`: by their text, or by what the file system says of them
fn same_file(a: &str, b: &str) -> bool {
    resolve(&[a]) == resolve(&[b]) || is_same_file(a, b)
}

/// What `hwp:read-file` read on a worker
struct Read {
    bytes: Vec<u8>,
    disk: Option<SaveDiskState>,
    tracked: bool,
    dropped: bool,
    unverified: bool,
    base: SaveBase,
}

fn read_hwp(engine: &HwpEngineHost, path: &str) -> Result<Read, IpcError> {
    let node = |e: std::io::Error, syscall: &str| {
        error(main_core::node_fs::node_error(&e, syscall, path).message)
    };
    let info = std::fs::metadata(path).map_err(|e| node(e, "stat"))?;
    if info.len() > MAX_HWP_SAVE_BYTES as u64 {
        return Err(error("hwp: file is too large to open"));
    }
    let mut bytes = std::fs::read(path).map_err(|e| node(e, "open"))?;
    let disk = record_disk_state(path);
    let tracking = if bytes_match_format(&bytes, HwpFormat::Hwp) {
        engine.tracked_changes_of(&bytes)
    } else {
        TrackedChanges::None
    };
    let (mut tracked, mut dropped, mut unverified) = (false, false, false);
    match tracking {
        // it still goes to the editor, which reads it by its own means; it is not saved over
        TrackedChanges::Unreadable => unverified = true,
        TrackedChanges::Tracked => match engine.without_tracked_changes(&bytes) {
            Some(current) => {
                bytes = current;
                dropped = true;
            }
            None => tracked = true,
        },
        TrackedChanges::None => {}
    }
    let is_hwp = bytes_match_format(&bytes, HwpFormat::Hwp);
    let base = SaveBase {
        tails: if is_hwp {
            section_tails_of(&bytes)
        } else {
            None
        },
        kinds: if is_hwp { field_kinds_of(&bytes) } else { None },
    };
    Ok(Read {
        bytes,
        disk,
        tracked,
        dropped,
        unverified,
        base,
    })
}

/// What `hwp:commit-save` wrote on a worker
struct Landed {
    backup_path: Option<String>,
    tails_lost: bool,
    memos_lost: usize,
    disk: Option<SaveDiskState>,
}

/// The part of a commit that runs on a worker: the corrections, the memo
/// check, the backup and the write
struct Commit {
    data: Vec<u8>,
    format: HwpFormat,
    target: String,
    tabs: Option<Vec<serde_json::Value>>,
    base: SaveBase,
    /// `Some` when the memo check runs: the editor's list (`None` when it
    /// could not be listed) and the opened HWPX file
    memos: Option<(Option<Vec<super::memos::MemoSnapshot>>, Option<String>)>,
    written: HashSet<String>,
}

fn commit(engine: &HwpEngineHost, job: Commit) -> Result<Landed, String> {
    let fixed = apply_save_fixes(&job.data, job.format, job.tabs.as_deref(), &job.base);
    let tails_lost = fixed.tails_skipped.is_some();
    let bytes = fixed.bytes;
    let mut memos_lost = 0;
    if let Some((memos, opened)) = &job.memos {
        let original = opened
            .as_deref()
            .filter(|p| hwp_format_of_path(p) == Some(HwpFormat::Hwpx))
            .and_then(|p| std::fs::read(p).ok());
        memos_lost = lost_memo_count_of(&**engine, &bytes, original.as_deref(), memos.as_deref());
    }
    let mut backup_path = None;
    if needs_backup(&job.target, Path::new(&job.target).exists(), &job.written) {
        let backup = backup_path_for(&job.target);
        main_core::node_fs::copy_file(&job.target, &backup, false).map_err(|e| e.message)?;
        backup_path = Some(backup);
    }
    atomic_write_file(&job.target, &bytes).map_err(|e| e.message)?;
    Ok(Landed {
        backup_path,
        tails_lost,
        memos_lost,
        disk: record_disk_state(&job.target),
    })
}

fn failed(message: impl Into<String>) -> IpcValue {
    obj([
        ("ok", false.into_ipc()),
        ("error", message.into().into_ipc()),
    ])
}

impl Hwp {
    /// `hwp:begin-save`
    fn begin_save(self: &Rc<Self>, view: ViewId, mode: &IpcValue) -> IpcValue {
        self.change(view, |v| {
            v.pending_save = None;
            v.pdf_save_as = None;
        });
        // a memo editor's text is not in the document yet: no dialog, no save
        if self.get(view, |v| v.memo_modal) {
            self.emit(view, "hwp:memo-blocked", vec![]);
            self.settle_save(view, false);
            return obj([
                ("ok", false.into_ipc()),
                ("error", "hwp: a memo editor is open".into_ipc()),
                ("reason", "memo".into_ipc()),
            ]);
        }
        // before any dialog: under no name and in no format
        if self.get(view, |v| v.tracked) {
            self.settle_save(view, false);
            return obj([
                ("ok", false.into_ipc()),
                ("error", "hwp: the document has tracked changes".into_ipc()),
                ("reason", "tracked".into_ipc()),
            ]);
        }
        match self.begin_save_target(view, as_str(mode) == Some("saveAs")) {
            Ok(Ok(answer)) => answer,
            Ok(Err(early)) => {
                self.settle_save(view, false);
                early
            }
            Err(message) => {
                self.settle_save(view, false);
                failed(message)
            }
        }
    }

    /// The `try` block of `hwp:begin-save`: `Ok(Ok)` an answer that leaves
    /// the save pending, `Ok(Err)` one that settles it, `Err` what it threw
    fn begin_save_target(
        self: &Rc<Self>,
        view: ViewId,
        save_as: bool,
    ) -> Result<Result<IpcValue, IpcValue>, String> {
        let current = self.get(view, |v| v.save_path.clone());
        let current_format = current.as_deref().and_then(hwp_format_of_path);
        let target = match (&current, current_format) {
            (Some(current), Some(_)) if !save_as => current.clone(),
            _ => {
                let win = self.window_of(view);
                let copy = self.get(view, |v| v.untitled_copy.clone());
                // a brand-new document takes the format chosen in Settings
                let preferred = self.default_format();
                // a new document whose panel has a project is offered in that folder
                let new_dir = match current {
                    Some(_) => None,
                    None => self.shell.new_document_dir(view),
                };
                let offered = match &current {
                    Some(current) => join(&[&dirname(current), &basename(current, None)]),
                    None => match self
                        .recovery
                        .borrow()
                        .hwp_recovery_save_as_default(wc(view))
                    {
                        // a copy restored without its file is offered where that file was
                        Some(path) => path,
                        None => {
                            let dir = match new_dir {
                                Some(dir) => dir,
                                None => configured_default_save_dir(
                                    &AppPaths(self.services.paths.clone()),
                                    &mut self.save_dir.lock().unwrap_or_else(|e| e.into_inner()),
                                    self.shell.now_ms(),
                                )
                                .map_err(|e| e.0)?,
                            };
                            let name = match &copy {
                                Some(copy) => copy.name.clone(),
                                None => {
                                    format!("{}.{}", self.tm("untitledFile"), preferred.as_str())
                                }
                            };
                            join(&[&dir, &name])
                        }
                    },
                };
                let fallback = current_format
                    .or(copy.map(|c| c.format))
                    .or(hwp_format_of_path(&offered))
                    .unwrap_or(preferred);
                // Save As also lists PDF, a copy written by the PDF export
                let offer_exports = save_as;
                let lang = self.lang();
                let filters = save_as_filters(fallback, offer_exports, &mut |key| {
                    main_core::hwp::dialog_strings::tm(lang, key.as_str(), None)
                });
                let mut options = JsObject::new();
                options.set("title", JsonValue::String(self.tm("dlgSaveTitle")));
                options.set(
                    "defaultPath",
                    JsonValue::String(save_as_default_path(&offered, offer_exports)),
                );
                options.set(
                    "filters",
                    JsonValue::Array(
                        filters
                            .into_iter()
                            .map(|f| {
                                let mut o = JsObject::new();
                                o.set("name", JsonValue::String(f.name));
                                o.set(
                                    "extensions",
                                    JsonValue::Array(
                                        f.extensions.into_iter().map(JsonValue::String).collect(),
                                    ),
                                );
                                JsonValue::Object(o)
                            })
                            .collect(),
                    ),
                );
                let picked = show_save_dialog_with_memory(
                    &mut self.dialog_memory.lock().unwrap_or_else(|e| e.into_inner()),
                    &mut FileDialogs(self.dialogs.clone()),
                    win.as_ref(),
                    &options,
                    None,
                );
                let file_path = match &picked {
                    JsonValue::Object(o) if !o.get("canceled").is_some_and(JsonValue::truthy) => {
                        match o.get("filePath") {
                            Some(JsonValue::String(p)) if !p.is_empty() => Some(p.clone()),
                            _ => None,
                        }
                    }
                    _ => None,
                };
                let Some(file_path) = file_path else {
                    return Ok(Err(obj([
                        ("ok", true.into_ipc()),
                        ("canceled", true.into_ipc()),
                    ])));
                };
                let (path, kind) = save_as_target(&file_path, fallback, offer_exports);
                if kind == HwpSaveAsKind::Pdf {
                    // no save: the PDF export writes this path. The document keeps
                    // its file, unsaved state and recovery copy.
                    self.change(view, |v| v.pdf_save_as = Some(path.clone()));
                    return Ok(Err(obj([
                        ("ok", true.into_ipc()),
                        ("path", path.into_ipc()),
                        ("export", "pdf".into_ipc()),
                    ])));
                }
                path
            }
        };
        let Some(format) = hwp_format_of_path(&target) else {
            return Err("hwp: no save format for this file name".into());
        };
        // under Save and under a Save As that picks the file itself
        if let Some(unverified) = self.get(view, |v| v.unverified.clone())
            && same_file(&target, &unverified)
        {
            return Ok(Err(obj([
                ("ok", false.into_ipc()),
                (
                    "error",
                    "hwp: the structure of the opened file could not be checked".into_ipc(),
                ),
                ("reason", "unverified".into_ipc()),
            ])));
        }
        self.change(view, |v| v.pending_save = Some((target.clone(), format)));
        Ok(Ok(obj([
            ("ok", true.into_ipc()),
            ("path", target.into_ipc()),
            ("format", format.as_str().into_ipc()),
        ])))
    }

    /// `hwp:commit-save`
    fn commit_save(
        self: &Rc<Self>,
        cx: &CallContext,
        args: &Args,
        reply: shell_contract::ipc::Responder,
    ) {
        let view = cx.sender.view;
        let (auto, memos) = commit_options_of(args.get(2));
        let pending = self.change(view, |v| v.pending_save.take());
        let hwp = Rc::clone(self);
        let done = move |result: IpcValue| {
            let ok = matches!(field(&result, "ok"), IpcValue::Bool(true));
            hwp.settle_save(view, ok);
            reply.reply(Ok(result));
        };
        let Some((target, format)) = pending else {
            return done(failed("hwp: no save in progress"));
        };
        let data = match uint8(args.get(0)) {
            Some(d) if !d.is_empty() && d.len() <= MAX_HWP_SAVE_BYTES => d,
            _ => return done(failed("hwp: bad save request")),
        };
        if !bytes_match_format(data, format) {
            return done(failed(format!(
                "hwp: exported bytes are not a {} file",
                format.as_str()
            )));
        }
        // a sibling copy changed the file after this copy read or wrote it: a
        // manual save asks, an automatic one stands down quietly (decision 0036)
        let recorded = self.get(view, |v| v.disk_states.get(&target).cloned());
        let probe = |path: &str| Ok(self.shell.is_path_open_elsewhere(path));
        if auto {
            if should_defer_auto_save(Some(&probe), &target, recorded.as_ref()) {
                return done(failed(EXTERNAL_MODIFIED));
            }
        } else {
            let parent = self.window_of(view).map(Parent);
            let lang = self.shell.ui_lang();
            let verdict = confirm_overwrite_if_conflicted(&SaveConflictOptions {
                probe: Some(&probe),
                dialog: &self.boxes,
                parent: parent.as_ref(),
                path: &target,
                recorded: recorded.as_ref(),
                lang: &lang,
            });
            if verdict == SaveConflictAnswer::Cancel {
                return done(failed(EXTERNAL_MODIFIED));
            }
        }
        let tabs = match args.get(1) {
            IpcValue::Array(items) => Some(
                items
                    .iter()
                    .map(|t| to_json(t).unwrap_or(serde_json::Value::Null))
                    .collect(),
            ),
            _ => None,
        };
        let (base, opened, written) = self.get(view, |v| {
            (v.base.clone(), v.save_path.clone(), v.written.clone())
        });
        // HWPX has no section-tail repair: a memo the engine cannot write would vanish
        let memos = match (format, memos) {
            (HwpFormat::Hwpx, Memos::Null) => Some((None, opened)),
            (HwpFormat::Hwpx, Memos::List(list)) => Some((list, opened)),
            _ => None,
        };
        let before = self.with_recovery(|r, e, _| r.hwp_recovery_before_save(e, wc(view)));
        let job = Commit {
            data: data.to_vec(),
            format,
            target: target.clone(),
            tabs,
            base,
            memos,
            written,
        };
        let engine = Arc::clone(&self.engine);
        let hwp = Rc::clone(self);
        on_worker(
            &self.services,
            move || commit(&engine, job),
            move |landed| {
                let landed = match landed {
                    Ok(landed) => landed,
                    Err(message) => return done(failed(message)),
                };
                let mut is_new = false;
                if !hwp.is_destroyed(view) {
                    is_new = hwp.change(view, |v| {
                        if let Some(disk) = landed.disk {
                            v.disk_states.insert(target.clone(), disk);
                        }
                        v.written.insert(target.clone());
                        let is_new = v.save_path.as_deref() != Some(target.as_str());
                        v.save_path = Some(target.clone());
                        // an untitled copy is a document with a file from now on
                        v.untitled_copy = None;
                        // a stale open path would reload the OLD file and save it over the new one
                        v.open_path = Some(target.clone());
                        v.allowed.insert(target.clone());
                        v.dirty = false;
                        is_new
                    });
                    hwp.with_recovery(|r, e, s| r.hwp_recovery_saved(e, s, wc(view), before));
                }
                if is_new {
                    hwp.shell.file_saved(view, &target);
                }
                let mut answer = vec![
                    ("ok".to_owned(), true.into_ipc()),
                    ("path".to_owned(), target.as_str().into_ipc()),
                ];
                if let Some(backup) = landed.backup_path {
                    answer.push(("backupPath".into(), backup.into_ipc()));
                }
                if landed.tails_lost {
                    answer.push(("tailsLost".into(), true.into_ipc()));
                }
                if landed.memos_lost > 0 {
                    answer.push(("memosLost".into(), (landed.memos_lost as f64).into_ipc()));
                }
                done(IpcValue::Object(answer))
            },
        );
    }

    /// `hwp:read-file`
    fn read_file(
        self: &Rc<Self>,
        cx: &CallContext,
        args: &Args,
        reply: shell_contract::ipc::Responder,
    ) {
        let view = cx.sender.view;
        let path = match args.str(0) {
            Some(path) if self.get(view, |v| v.allowed.contains(path)) => path.to_owned(),
            _ => return reply.reply(Err(error("hwp: path not granted to this view"))),
        };
        // a recovery copy left for this file is settled before any content reaches the editor
        let restored = self.with_recovery(|r, e, s| r.hwp_recovery_on_read(e, s, wc(view), &path));
        let engine = Arc::clone(&self.engine);
        let hwp = Rc::clone(self);
        let worker_path = path.clone();
        on_worker(
            &self.services,
            move || read_hwp(&engine, &worker_path),
            move |read| {
                let read = match read {
                    Ok(read) => read,
                    Err(e) => return reply.reply(Err(e)),
                };
                if !hwp.is_destroyed(view) {
                    hwp.change(view, |v| {
                        if let Some(disk) = read.disk {
                            v.disk_states.insert(path.clone(), disk);
                        }
                        v.tracked = read.tracked;
                        v.tracking_dropped = read.dropped;
                        v.unverified = read.unverified.then(|| path.clone());
                        v.base = read.base;
                    });
                }
                reply.reply(Ok(u8_array(restored.unwrap_or(read.bytes))))
            },
        );
    }
}

/// hwp-main.ts's channels (`registerHwpIpc`)
pub(super) fn entries(hwp: &Rc<Hwp>) -> Vec<Entry> {
    let h = Rc::clone;
    let mut all = Vec::new();

    // ---- headless export mode (--headless-export) ----
    let hwp1 = h(hwp);
    all.push(kit::invoke("hwp:consume-headless-export", move |cx, _| {
        let target = hwp1.change(cx.sender.view, |v| v.headless_target.take());
        Ok(target.into_ipc())
    }));
    let hwp1 = h(hwp);
    all.push(kit::send("hwp:headless-export-done", move |cx, args| {
        let state = args.get(0);
        let report = if matches!(field(state, "ok"), IpcValue::Bool(true)) {
            Ok(())
        } else {
            Err(as_str(field(state, "error"))
                .unwrap_or("hwp export failed")
                .to_owned())
        };
        hwp1.settle_headless(cx.sender.view, report);
        Ok(())
    }));

    // the memo editor is renderer state; main keeps only whether a view has one open
    let hwp1 = h(hwp);
    all.push(kit::send("hwp:memo-modal-open", move |cx, args| {
        let view = cx.sender.view;
        // only an HWP view may hold the lock: its own teardown clears it again
        if hwp1.get(view, |v| v.granted) {
            let open = matches!(args.get(0), IpcValue::Bool(true));
            hwp1.change(view, |v| v.memo_modal = open);
        }
        Ok(())
    }));
    let hwp1 = h(hwp);
    all.push(kit::invoke("hwp:memo-modal-state", move |_, _| {
        Ok(hwp1
            .views
            .borrow()
            .values()
            .any(|v| v.memo_modal)
            .into_ipc())
    }));

    let hwp1 = h(hwp);
    all.push(kit::invoke("hwp:consume-pending", move |cx, _| {
        let view = cx.sender.view;
        hwp1.recovery.borrow_mut().note_hwp_path_consumed(wc(view));
        Ok(hwp1.get(view, |v| v.open_path.clone()).into_ipc())
    }));
    let hwp1 = h(hwp);
    all.push(kit::invoke("hwp:untitled-copy", move |cx, _| {
        Ok(hwp1.get(cx.sender.view, |v| {
            v.untitled_copy
                .as_ref()
                .map_or(IpcValue::Null, untitled_copy_ipc)
        }))
    }));

    let hwp1 = h(hwp);
    all.push(kit::invoke_later(
        "hwp:read-file",
        move |cx, args, reply| hwp1.read_file(cx, &args, reply),
    ));
    let hwp1 = h(hwp);
    all.push(kit::invoke("hwp:tracking-dropped", move |cx, _| {
        Ok(hwp1.get(cx.sender.view, |v| v.tracking_dropped).into_ipc())
    }));
    let hwp1 = h(hwp);
    all.push(kit::invoke("hwp:structure-unverified", move |cx, _| {
        Ok(hwp1
            .get(cx.sender.view, |v| v.unverified.is_some())
            .into_ipc())
    }));

    let hwp1 = h(hwp);
    all.push(kit::invoke("hwp:begin-save", move |cx, args| {
        Ok(hwp1.begin_save(cx.sender.view, args.get(0)))
    }));

    let hwp1 = h(hwp);
    all.push(kit::invoke_later("hwp:new-tabs", move |cx, args, reply| {
        let empty = || reply_now(IpcValue::Array(Vec::new()));
        if hwp1.get(cx.sender.view, |v| v.pending_save.is_none()) {
            return reply.reply(empty());
        }
        let data = match uint8(args.get(0)) {
            Some(d) if !d.is_empty() && d.len() <= MAX_HWP_SAVE_BYTES => d,
            _ => return reply.reply(empty()),
        };
        let format = match as_str(args.get(1)).and_then(HwpFormat::parse) {
            Some(format) if bytes_match_format(data, format) => format,
            _ => return reply.reply(empty()),
        };
        let data = data.to_vec();
        on_worker(
            &hwp1.services,
            move || tab_spots(&new_tabs_of(&data, format)),
            move |spots| reply.reply(Ok(spots)),
        );
    }));

    let hwp1 = h(hwp);
    all.push(kit::invoke_later(
        "hwp:commit-save",
        move |cx, args, reply| hwp1.commit_save(cx, &args, reply),
    ));

    // the editor's File menu: the same requests as Ctrl+S and Ctrl+P
    let hwp1 = h(hwp);
    all.push(kit::send("hwp:file-command", move |cx, args| {
        let view = cx.sender.view;
        match as_str(args.get(0)) {
            Some(mode @ ("save" | "saveAs")) => hwp1.request_save(view, mode, Box::new(|_| {})),
            Some("pdf") => hwp1.request_print(view, "pdf"),
            Some("preview") => hwp1.request_preview(view, "open"),
            Some("print") => hwp1.request_preview(view, "print"),
            Some("importPdf") if hwp1.get(view, |v| v.granted) => hwp1.shell.import_pdf(),
            _ => {}
        }
        Ok(())
    }));

    let hwp1 = h(hwp);
    all.push(kit::send("hwp:abort-save", move |cx, _| {
        let view = cx.sender.view;
        hwp1.change(view, |v| v.pending_save = None);
        hwp1.settle_save(view, false);
        Ok(())
    }));

    let hwp1 = h(hwp);
    all.push(kit::send("hwp:dirty-changed", move |cx, args| {
        let dirty = matches!(args.get(0), IpcValue::Bool(true));
        hwp1.change(cx.sender.view, |v| v.dirty = dirty);
        Ok(())
    }));

    let hwp1 = h(hwp);
    all.push(kit::send("hwp:close-save-result", move |cx, args| {
        let waiter = hwp1.close_waiters.borrow_mut().remove(&cx.sender.view);
        if let Some(waiter) = waiter {
            if let Some(t) = waiter.timer {
                kit::clear(t)
            }
            (waiter.then)(matches!(args.get(0), IpcValue::Bool(true)))
        }
        Ok(())
    }));

    let hwp1 = h(hwp);
    all.push(kit::send("hwp:read-bytes-result", move |cx, args| {
        hwp1.read_bytes_result(cx.sender.view, args.get(0));
        Ok(())
    }));
    all
}

fn reply_now(v: IpcValue) -> shell_contract::ipc::Reply {
    Ok(v)
}

/// `TabSpot[]` as the renderer receives it
pub(super) fn tab_spots(spots: &[main_core::hwp::tab_widths::TabSpot]) -> IpcValue {
    from_json(&serde_json::to_value(spots).unwrap_or(serde_json::Value::Array(Vec::new())))
}

/// The Hangul editor as other areas call it (the functions hwp-main.ts
/// exported), and its recovery contract
pub struct HwpEditors(pub(super) Rc<Hwp>);

impl DocumentEditors for HwpEditors {
    fn owns(&self, view: ViewId) -> bool {
        self.0.get(view, |v| v.granted)
    }

    fn request_save(&self, view: ViewId, mode: SaveMode, then: Then<bool>) {
        let mode = match mode {
            SaveMode::Save => "save",
            SaveMode::SaveAs => "saveAs",
        };
        self.0
            .request_save(view, mode, Box::new(move |ok| then(Ok(ok))))
    }

    fn request_close(&self, view: ViewId, parent: Option<WindowId>, then: Then<bool>) {
        self.0
            .request_close(view, parent, Box::new(move |ok| then(Ok(ok))))
    }

    fn read_text(&self, view: ViewId, then: Then<String>) {
        self.0.read_text(view, then)
    }

    /// hwp-main.ts exports no `hwpSaveToPath`: a Hangul document is saved
    /// through its editor's own export
    fn save_to_path(&self, _view: ViewId, _path: PathBuf, then: Then<()>) {
        then(Err(error("hwp: saving to a given path is not supported")))
    }

    fn file_renamed(&self, view: ViewId, old_path: &Path, new_path: &Path) {
        self.0.file_renamed(
            view,
            &old_path.to_string_lossy(),
            &new_path.to_string_lossy(),
        )
    }

    /// the File menu's export: `requestHwpPrint(contents, 'pdf')`
    fn export_request(&self, view: ViewId, format: &str) {
        if format == "pdf" {
            self.0.request_print(view, "pdf")
        }
    }

    fn document_path(&self, view: ViewId) -> Option<PathBuf> {
        self.0.get(view, |v| v.save_path.clone().map(PathBuf::from))
    }

    /// `pdfSaveAsByWc.get(wcId) ?? headlessPdfByWc.get(wcId)`, both taken:
    /// what `hwp:print-pages` lets a PDF write once
    fn take_pdf_grant(&self, view: ViewId) -> Option<PathBuf> {
        self.0.change(view, |v| {
            let save_as = v.pdf_save_as.take();
            let headless = v.headless_pdf.take();
            save_as.or(headless).map(PathBuf::from)
        })
    }
}

impl RecoveryEditorContract<ViewId> for HwpEditors {
    fn kind(&self) -> &str {
        "hwp"
    }

    /// The renderers answer each flush with `hwp:recovery-flushed`, or the
    /// flush times out; nothing here waits.
    fn write_copies_now(&self) {
        let _ = self.0.with_recovery(|r, e, _| r.write_copies_now(e));
    }

    fn open_file_with_decision(&self, contents: &ViewId, request: &RecoveryOpenFileRequest) {
        self.0
            .with_recovery(|r, e, _| r.open_file_with_decision(e, wc(*contents), request))
    }

    fn open_untitled_copy(&self, contents: &ViewId, request: &RecoveryOpenUntitledRequest) {
        self.0
            .with_recovery(|r, e, s| r.open_untitled_copy(e, s, wc(*contents), request))
    }

    fn is_unprotectable(&self, contents: &ViewId) -> bool {
        self.0.recovery.borrow().is_unprotectable(wc(*contents))
    }
}

/// What the shell calls that the contract's traits do not carry
impl HwpEditors {
    /// `createHwpView(openPath, options)`'s `grantAndTrack`
    pub fn grant_and_track(&self, view: ViewId, open_path: Option<&str>, untitled: UntitledOption) {
        self.0.grant_and_track(view, open_path, untitled)
    }
    /// `hwpIsDirty(webContentsId)`
    pub fn is_dirty(&self, view: ViewId) -> bool {
        self.0.is_dirty(view)
    }
    /// `hwpMemoModalOpen(webContentsId)`
    pub fn memo_modal_open(&self, view: ViewId) -> bool {
        self.0.memo_modal_open(view)
    }
    /// `requestHwpPreview(contents, action)`: `"open"` or `"print"`
    pub fn request_preview(&self, view: ViewId, action: &str) {
        self.0.request_preview(view, action)
    }
    /// `exportHwpPdfHeadless(input, outPath, timeoutMs)`; the default
    /// timeout is [`HEADLESS_TIMEOUT_MS`]
    pub fn export_hwp_pdf_headless(
        &self,
        input: &str,
        out_path: &str,
        timeout_ms: u64,
        then: Then<()>,
    ) {
        self.0
            .export_hwp_pdf_headless(input, out_path, timeout_ms, then)
    }
    /// the view's `render-process-gone`
    pub fn render_process_gone(&self, view: ViewId, reason: &str) {
        self.0.render_process_gone(view, reason)
    }
    /// the view's `did-start-navigation`
    pub fn did_start_navigation(&self, view: ViewId, main_frame: bool, same_document: bool) {
        self.0.did_start_navigation(view, main_frame, same_document)
    }
    /// the view's `before-input-event`: true when the key is taken
    /// (`event.preventDefault()`)
    pub fn before_input(&self, view: ViewId, input: &KeyInput) -> bool {
        self.0.before_input(view, input)
    }
    /// the view's `setWindowOpenHandler`
    pub fn window_open(&self, url: &str) {
        self.0.window_open(url)
    }
    /// `hwpRecoveryIdentity(contents)`
    pub fn recovery_identity(&self, view: ViewId) -> Option<RecoveryIdentity> {
        self.0
            .with_recovery(|r, e, _| r.hwp_recovery_identity(e, wc(view)))
    }
    /// `setHwpRecoveryTitle(contents, title)`
    pub fn set_recovery_title(&self, view: ViewId, title: &str) {
        self.0
            .recovery
            .borrow_mut()
            .set_hwp_recovery_title(wc(view), title)
    }
    /// `hwpDiscardRecoveryCopy(contents)`
    pub fn discard_recovery_copy(&self, view: ViewId) {
        self.0.discard_recovery_copy(view)
    }
}

#[cfg(test)]
pub(super) mod tests;
