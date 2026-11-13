//! The per-view document state the two text editors keep in the same shape:
//! `apps/html/src/main/html-main.ts` and `apps/markdown/src/main/markdown-main.ts`
//! hold the same maps (open path, granted paths, save target, dirty flag,
//! disk states, the save/close/read waiters, the headless export targets) and
//! the same exported flows (`request<App>Close`, `request<App>Save`,
//! `<app>ReadText`, `<app>SaveToPath`, `<app>FileRenamed`,
//! `send<App>ExportRequest`, `<app>DiscardPendingAssets`). The HTML module
//! owns this file; the Markdown module builds its own [`TextDocs`] from it.
//!
//! Every TypeScript `await` on a renderer is a waiter here: the call stores a
//! continuation keyed by view, emits the request, and the renderer's answer
//! (or a timer as the TypeScript's `setTimeout`) runs it on the core thread.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::rc::{Rc, Weak};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use jscompat::{JsObject, JsonValue};
use main_core::packages::electron_utils::default_save_dir::{
    SaveDirState, configured_default_save_dir,
};
use main_core::packages::electron_utils::dialog_memory::{
    DialogMemory, FallbackDir, show_open_dialog_with_memory, show_save_dialog_with_memory,
};
use main_core::packages::electron_utils::message_box::MessageBoxOptions;
use main_core::packages::electron_utils::recovery_store::RecoveryIdentity;
use main_core::packages::electron_utils::save_conflict::{
    SaveConflictAnswer, SaveConflictOptions, SaveDiskState, confirm_overwrite_if_conflicted,
    record_disk_state, should_defer_auto_save,
};
use shell_contract::editors::{SaveMode, Then};
use shell_contract::hosts::{ContentsHost, DialogsHost};
use shell_contract::ipc::{RegisterError, Target};
use shell_contract::runtime::Services;
use shell_contract::{Batch, IpcError, IpcValue, ViewId, WindowId};

use crate::kit::{self, Entry, IntoIpc, Timer, field, obj};
use crate::text_recovery::ui::{AppPathProvider, Boxes, Files, Parent, message_box};
use crate::text_recovery::{RecoveryHosts, TextRecovery, TextRecoveryHost};

/// how long a close or save waits for the renderer (`120_000` in the TypeScript)
pub(crate) const SAVE_WAIT: Duration = Duration::from_millis(120_000);
/// how often a read re-sends its request while the renderer is not listening yet
pub(crate) const READ_RETRY: Duration = Duration::from_millis(250);
/// how long a read waits for the renderer
pub(crate) const READ_WAIT: Duration = Duration::from_millis(30_000);

/// The channels of one editor that this state answers or emits
pub(crate) struct DocChannels {
    /// "html" or "markdown": the app's name in its messages
    pub app: &'static str,
    pub untitled_ext: &'static str,
    pub read_file: &'static str,
    pub dirty_changed: &'static str,
    pub close_save_result: &'static str,
    pub close_save_request: &'static str,
    pub save_request: &'static str,
    pub save_request_ack: &'static str,
    pub read_text_request: &'static str,
    pub read_text_result: &'static str,
    pub file_renamed: &'static str,
    pub export_request: &'static str,
    pub recovery_flush_request: &'static str,
    pub recovery_open: &'static str,
    pub recovery_write: &'static str,
    pub consume_headless_export: &'static str,
    pub headless_export_done: &'static str,
}

/// What the state asks of the app's own hosts
pub(crate) struct DocHooks {
    /// `getUiLang()`
    pub lang: Box<dyn Fn() -> String>,
    /// `isHeadlessMode()`
    pub is_headless: Box<dyn Fn() -> bool>,
    /// `contents.reload()`
    pub reload: Box<dyn Fn(ViewId)>,
    /// `isPathOpenElsewhere(path)`: the shell's split-pane probe
    pub open_elsewhere: Box<dyn Fn(&str) -> bool>,
    /// `discardPendingOwnedAssets(documentPath)`: the errors it reports
    pub discard_pending_assets: fn(&str) -> Vec<String>,
    /// `renameOwnedAssetDocument(oldPath, newPath)`
    pub rename_assets: fn(&str, &str) -> Result<(), String>,
    /// html: the view presents another view's preview; its export requests
    /// are dropped and a save request is answered `true` at once
    pub presenting: Box<dyn Fn(ViewId) -> bool>,
}

/// One view's document (the `*ByWc` maps of the TypeScript, one entry)
#[derive(Default)]
struct DocView {
    /// the view was made for this editor (`grantAndTrack`)
    tracked: bool,
    open: Option<String>,
    allowed: HashSet<String>,
    save: Option<String>,
    dirty: bool,
    disk: HashMap<String, SaveDiskState>,
}

type Waiter = Box<dyn FnOnce(bool)>;

/// one read of the document text in flight, shared by every caller
struct Reading {
    thens: Vec<Then<String>>,
    retry: Timer,
    timeout: Timer,
}

type HeadlessSettle = Box<dyn FnOnce(Result<(), String>)>;

/// The two text editors' per-view state and their exported flows
pub(crate) struct TextDocs {
    ch: DocChannels,
    hooks: DocHooks,
    services: Services,
    dialogs: DialogsHost,
    contents: ContentsHost,
    recovery: Rc<TextRecovery>,
    views: RefCell<HashMap<ViewId, DocView>>,
    close_waiters: RefCell<HashMap<ViewId, Waiter>>,
    save_waiters: RefCell<HashMap<ViewId, Waiter>>,
    reads: RefCell<HashMap<ViewId, Reading>>,
    headless_targets: RefCell<HashMap<ViewId, IpcValue>>,
    headless_waiters: RefCell<HashMap<ViewId, (HeadlessSettle, Timer)>>,
    /// the app's own cleanups, run first when a view is destroyed
    cleanups: RefCell<Vec<ViewHook>>,
    /// keeps the `destroyed` listener alive as long as this state
    destroyed_hook: RefCell<Option<Guard>>,
    /// `showOpenDialogWithMemory`/`showSaveDialogWithMemory`'s last folder;
    /// a worker that shows a dialog (`saveImageFromUrl`) takes it along
    memory: Arc<Mutex<DialogMemory>>,
    /// `configuredDefaultSaveDir`'s fallback state
    save_dir: RefCell<SaveDirState>,
}

/// what runs when a view is destroyed
type ViewHook = Box<dyn Fn(ViewId)>;
/// the guard [`kit::on_view_destroyed`] returns
type Guard = Rc<dyn Fn(ViewId)>;

fn is_ko(lang: &str) -> bool {
    lang == "ko" || lang.starts_with("ko-")
}

/// `tDlg(lang, key)` of the editors' tables: English unless Korean
pub(crate) fn tr(lang: &str, en: &str, ko: &str) -> String {
    if is_ko(lang) { ko } else { en }.to_owned()
}

/// `String(value)` for the values a renderer answers with
pub(crate) fn js_string(v: &IpcValue) -> String {
    match v {
        IpcValue::Undefined => "undefined".into(),
        IpcValue::Null => "null".into(),
        IpcValue::Bool(b) => b.to_string(),
        IpcValue::Number(n) => jscompat::number_to_string(*n),
        IpcValue::String(s) => s.clone(),
        IpcValue::Array(items) => items
            .iter()
            .map(|i| match i {
                IpcValue::Undefined | IpcValue::Null => String::new(),
                other => js_string(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        IpcValue::Date(_) | IpcValue::Bytes(..) | IpcValue::Object(_) => "[object Object]".into(),
    }
}

fn file_exists(path: &str) -> bool {
    Path::new(path).exists()
}

impl TextDocs {
    pub(crate) fn new(
        services: &Services,
        ch: DocChannels,
        hooks: DocHooks,
        untitled_title: (&'static str, &'static str),
    ) -> Result<Rc<Self>, RegisterError> {
        let dialogs = services.hosts.need::<DialogsHost>(Batch::D2)?;
        let contents = services.hosts.need::<ContentsHost>(Batch::D2)?;
        let recovery_hosts = RecoveryHosts::need(services)?;
        let docs = Rc::new_cyclic(|me: &Weak<TextDocs>| {
            let read = |f: fn(&TextDocs, ViewId) -> Option<String>| {
                let me = me.clone();
                Box::new(move |v| me.upgrade().and_then(|d| f(&d, v)))
            };
            let (dirty, adopt, restored, lang, headless, reload, title_lang) = (
                me.clone(),
                me.clone(),
                me.clone(),
                me.clone(),
                me.clone(),
                me.clone(),
                me.clone(),
            );
            let host = TextRecoveryHost {
                kind: ch.app,
                untitled_ext: ch.untitled_ext,
                flush_channel: ch.recovery_flush_request,
                lang: Box::new(move || lang.upgrade().map_or_else(String::new, |d| d.lang())),
                is_headless: Box::new(move || {
                    headless.upgrade().is_some_and(|d| (d.hooks.is_headless)())
                }),
                save_path: read(|d, v| d.save_path(v)),
                open_path: read(|d, v| d.open_path(v)),
                is_dirty: Box::new(move |v| dirty.upgrade().is_some_and(|d| d.is_dirty(v))),
                adopt_file: Box::new(move |v, path| {
                    if let Some(d) = adopt.upgrade() {
                        d.with_view(v, |s| {
                            s.open = Some(path.to_owned());
                            s.save = Some(path.to_owned());
                            s.allowed.insert(path.to_owned());
                        })
                    }
                }),
                restored_file: Box::new(move |v, path| {
                    // the save guard compares with the file as it was when the tab opened
                    if let Some(d) = restored.upgrade() {
                        d.remember_disk_state(v, path)
                    }
                }),
                untitled_fallback_title: Box::new(move || {
                    let lang = title_lang.upgrade().map_or_else(String::new, |d| d.lang());
                    tr(&lang, untitled_title.0, untitled_title.1)
                }),
                reload: Box::new(move |v| {
                    if let Some(d) = reload.upgrade() {
                        (d.hooks.reload)(v)
                    }
                }),
            };
            let recovery = TextRecovery::new(services, host, recovery_hosts);
            TextDocs {
                ch,
                hooks,
                services: services.clone(),
                dialogs,
                contents,
                recovery,
                views: RefCell::default(),
                close_waiters: RefCell::default(),
                save_waiters: RefCell::default(),
                reads: RefCell::default(),
                headless_targets: RefCell::default(),
                headless_waiters: RefCell::default(),
                cleanups: RefCell::default(),
                destroyed_hook: RefCell::default(),
                memory: Arc::default(),
                save_dir: RefCell::default(),
            }
        });
        let me = Rc::downgrade(&docs);
        let hook = kit::on_view_destroyed(services, move |view| {
            if let Some(d) = me.upgrade() {
                d.destroyed(view)
            }
        });
        *docs.destroyed_hook.borrow_mut() = Some(hook);
        Ok(docs)
    }

    pub(crate) fn recovery(&self) -> &Rc<TextRecovery> {
        &self.recovery
    }

    pub(crate) fn lang(&self) -> String {
        (self.hooks.lang)()
    }

    pub(crate) fn is_headless(&self) -> bool {
        (self.hooks.is_headless)()
    }

    /// `BrowserWindow.fromWebContents(sender) ?? getFocusedWindow()`: the
    /// shell knows the window of every live view
    pub(crate) fn window_of(&self, view: ViewId) -> Option<WindowId> {
        self.contents.window_of(view)
    }

    /// `configuredDefaultSaveDir(app)`; what it throws rejects the handler
    pub(crate) fn default_save_dir(&self) -> Result<String, IpcError> {
        configured_default_save_dir(
            &AppPathProvider(self.services.paths.as_ref()),
            &mut self.save_dir.borrow_mut(),
            crate::text_recovery::ui::now_ms(),
        )
        .map_err(|e| kit::error(e.0))
    }

    /// the dialog memory, for a dialog shown from a worker
    pub(crate) fn memory(&self) -> Arc<Mutex<DialogMemory>> {
        Arc::clone(&self.memory)
    }

    fn remembered(&self) -> std::sync::MutexGuard<'_, DialogMemory> {
        self.memory.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// `showSaveDialogWithMemory(dialog, win, options, fallbackDir)`: the
    /// chosen path, None when cancelled
    pub(crate) fn save_dialog(
        &self,
        view: ViewId,
        options: JsObject<JsonValue>,
        fallback_dir: Option<&str>,
    ) -> Option<String> {
        let parent = self.window_of(view).map(Parent);
        let fallback = fallback_dir.map(FallbackDir::Dir);
        let result = show_save_dialog_with_memory(
            &mut self.remembered(),
            &mut Files(self.dialogs.clone()),
            parent.as_ref(),
            &options,
            fallback.as_ref(),
        );
        let JsonValue::Object(result) = result else {
            return None;
        };
        if matches!(result.get("canceled"), Some(JsonValue::Bool(true))) {
            return None;
        }
        match result.get("filePath") {
            Some(JsonValue::String(p)) if !p.is_empty() => Some(p.clone()),
            _ => None,
        }
    }

    /// `showOpenDialogWithMemory(dialog, win, options, fallbackDir)`: the
    /// chosen paths, None when cancelled
    pub(crate) fn open_dialog(
        &self,
        view: ViewId,
        options: JsObject<JsonValue>,
        fallback_dir: Option<&str>,
    ) -> Option<Vec<String>> {
        let parent = self.window_of(view).map(Parent);
        let result = show_open_dialog_with_memory(
            &mut self.remembered(),
            &mut Files(self.dialogs.clone()),
            parent.as_ref(),
            &options,
            fallback_dir,
        );
        let JsonValue::Object(result) = result else {
            return None;
        };
        if matches!(result.get("canceled"), Some(JsonValue::Bool(true))) {
            return None;
        }
        match result.get("filePaths") {
            Some(JsonValue::Array(paths)) => Some(
                paths
                    .iter()
                    .filter_map(|p| match p {
                        JsonValue::String(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect(),
            ),
            _ => Some(Vec::new()),
        }
    }

    /// `dialog.showMessageBox(win?, options)`: the pressed button
    pub(crate) fn message(
        &self,
        view: ViewId,
        options: &shell_contract::hosts::MessageBox,
    ) -> usize {
        self.dialogs.message(self.window_of(view), options).response
    }

    /// the dialogs host, for a dialog shown from a worker
    pub(crate) fn dialogs(&self) -> DialogsHost {
        self.dialogs.clone()
    }

    pub(crate) fn is_destroyed(&self, view: ViewId) -> bool {
        self.services.views.sender_of(view).is_none()
    }

    /// Adds a cleanup the app runs when a view is destroyed, before the
    /// document state goes (the TypeScript's first lines of its `destroyed` hook)
    pub(crate) fn on_destroyed(&self, f: impl Fn(ViewId) + 'static) {
        self.cleanups.borrow_mut().push(Box::new(f));
    }

    fn with_view<R>(&self, view: ViewId, f: impl FnOnce(&mut DocView) -> R) -> R {
        f(self.views.borrow_mut().entry(view).or_default())
    }

    fn read_view<R>(&self, view: ViewId, f: impl FnOnce(&DocView) -> R) -> Option<R> {
        self.views.borrow().get(&view).map(f)
    }

    /// `grantAndTrack(wc, openPath)`: the view is this editor's; an existing
    /// file becomes its open path, save target and only grant
    pub(crate) fn track(&self, view: ViewId, open_path: Option<&str>) {
        self.with_view(view, |s| {
            s.tracked = true;
            if let Some(path) = open_path.filter(|p| !p.is_empty() && file_exists(p)) {
                s.open = Some(path.to_owned());
                s.save = Some(path.to_owned());
                s.allowed = HashSet::from([path.to_owned()]);
            }
        });
        self.recovery.track(view);
    }

    /// the `destroyed` hook of `grantAndTrack`
    fn destroyed(&self, view: ViewId) {
        let cleanups = std::mem::take(&mut *self.cleanups.borrow_mut());
        for cleanup in &cleanups {
            cleanup(view)
        }
        {
            let mut kept = self.cleanups.borrow_mut();
            let added = std::mem::replace(&mut *kept, cleanups);
            kept.extend(added);
        }
        // before the dirty flag goes: a clean close drops the copy, an unsaved or crashed one keeps it
        self.recovery.forget(view);
        let gone = self.views.borrow_mut().remove(&view);
        drop(gone);
        let close = self.close_waiters.borrow_mut().remove(&view);
        if let Some(waiter) = close {
            waiter(false)
        }
        let save = self.save_waiters.borrow_mut().remove(&view);
        if let Some(waiter) = save {
            waiter(false)
        }
    }

    pub(crate) fn owns(&self, view: ViewId) -> bool {
        self.read_view(view, |s| s.tracked).unwrap_or(false)
    }

    pub(crate) fn open_path(&self, view: ViewId) -> Option<String> {
        self.read_view(view, |s| s.open.clone()).flatten()
    }

    pub(crate) fn save_path(&self, view: ViewId) -> Option<String> {
        self.read_view(view, |s| s.save.clone()).flatten()
    }

    pub(crate) fn is_dirty(&self, view: ViewId) -> bool {
        self.read_view(view, |s| s.dirty).unwrap_or(false)
    }

    pub(crate) fn is_granted(&self, view: ViewId, path: &str) -> bool {
        self.read_view(view, |s| s.allowed.contains(path))
            .unwrap_or(false)
    }

    /// `rememberDiskState(wcId, path)`
    pub(crate) fn remember_disk_state(&self, view: ViewId, path: &str) {
        if let Some(state) = record_disk_state(path) {
            self.set_disk_state(view, path, state)
        }
    }

    fn set_disk_state(&self, view: ViewId, path: &str, state: SaveDiskState) {
        self.with_view(view, |s| s.disk.insert(path.to_owned(), state));
    }

    /// `conflictStopsSave(contents, path, auto)`: the sibling pane changed the
    /// disk since this view's last read or write, and either the automatic
    /// save defers or the user chose to keep the disk copy
    pub(crate) fn conflict_stops_save(&self, view: ViewId, path: &str, auto: bool) -> bool {
        if !(self.hooks.open_elsewhere)(path) {
            return false;
        }
        let recorded = self
            .read_view(view, |s| s.disk.get(path).cloned())
            .flatten();
        // the probe already answered yes above
        let probe: &dyn Fn(&str) -> Result<bool, _> = &|_| Ok(true);
        if auto {
            return should_defer_auto_save(Some(probe), path, recorded.as_ref());
        }
        let parent = self.window_of(view).map(Parent);
        let lang = self.lang();
        let boxes = Boxes(self.dialogs.clone());
        confirm_overwrite_if_conflicted(&SaveConflictOptions {
            probe: Some(probe),
            dialog: &boxes,
            parent: parent.as_ref(),
            path,
            recorded: recorded.as_ref(),
            lang: &lang,
        }) == SaveConflictAnswer::Cancel
    }

    /// the menu save waiting on this view's save handler, popped at its start
    pub(crate) fn take_save_waiter(&self, view: ViewId) -> Option<Box<dyn FnOnce(bool)>> {
        self.save_waiters.borrow_mut().remove(&view)
    }

    /// The bookkeeping after the text landed at `target`: the view points at
    /// it, is clean, its copy goes, and the save guard records the new bytes
    pub(crate) fn saved_to(
        &self,
        view: ViewId,
        current: Option<&str>,
        target: &str,
        recovery_before: Option<&RecoveryIdentity>,
    ) {
        self.with_view(view, |s| {
            s.save = Some(target.to_owned());
            // keep the reload path in sync: a stale open path would make a
            // reloaded renderer load the OLD file and then save it over the new one
            s.open = Some(target.to_owned());
            s.allowed.insert(target.to_owned());
            s.dirty = false;
        });
        // the document is saved: its recovery copy goes ('saved' passes even while quitting)
        self.recovery.saved(view, recovery_before);
        // refresh the record for the written bytes; the view no longer edits a moved-away path
        self.remember_disk_state(view, target);
        if let Some(current) = current.filter(|c| *c != target) {
            self.with_view(view, |s| s.disk.remove(current));
        }
    }

    // ---- the exported flows other areas call ----

    /// `request<App>Close(contents, parent)`
    pub(crate) fn request_close(
        self: &Rc<Self>,
        view: ViewId,
        parent: Option<WindowId>,
        then: Then<bool>,
    ) {
        if !self.is_dirty(view) || self.is_destroyed(view) {
            return then(Ok(true));
        }
        let lang = self.lang();
        let options = MessageBoxOptions {
            kind: "warning",
            title: None,
            message: tr(
                &lang,
                "This document has unsaved changes.",
                "이 문서에 저장하지 않은 변경 사항이 있습니다.",
            ),
            detail: Some(tr(
                &lang,
                "Do you want to save them before closing?",
                "닫기 전에 저장하시겠습니까?",
            )),
            buttons: vec![
                tr(&lang, "Save", "저장"),
                tr(&lang, "Don't Save", "저장 안 함"),
                tr(&lang, "Cancel", "취소"),
            ],
            default_id: 0,
            cancel_id: Some(2),
            no_link: Some(true),
        };
        let response = self
            .dialogs
            .message(parent, &message_box(&options))
            .response;
        if response == 2 {
            return then(Ok(false));
        }
        if response == 1 {
            self.discard_pending_assets(view);
            return then(Ok(true));
        }
        self.arm(&self.close_waiters, view, then);
        self.services
            .events
            .emit(Target::View(view), self.ch.close_save_request, Vec::new());
    }

    /// `<app>DiscardPendingAssets(contents)`; also "Don't Save" in the close prompt
    pub(crate) fn discard_pending_assets(&self, view: ViewId) {
        // closing without saving: the recovery copy goes as with "Don't Save"
        self.recovery.dont_save(view);
        if let Some(path) = self.save_path(view) {
            let errors = (self.hooks.discard_pending_assets)(&path);
            if !errors.is_empty() {
                eprintln!(
                    "[{}] pending asset discard incomplete: {errors:?}",
                    self.ch.app
                );
            }
        }
    }

    /// A one-shot waiter: answered by the renderer, by the view's end
    /// (`false`) or by its timer (`false`); the timer clears whatever waits
    /// under the view then, as the TypeScript's `delete` does
    fn arm(
        self: &Rc<Self>,
        map: &RefCell<HashMap<ViewId, Waiter>>,
        view: ViewId,
        then: Then<bool>,
    ) {
        let slot = Rc::new(RefCell::new(Some(then)));
        let on_time = Rc::clone(&slot);
        let me = Rc::downgrade(self);
        let close = std::ptr::eq(map, &self.close_waiters);
        let timer = kit::after(&self.services, SAVE_WAIT, move || {
            if let Some(d) = me.upgrade() {
                let map = if close {
                    &d.close_waiters
                } else {
                    &d.save_waiters
                };
                let gone = map.borrow_mut().remove(&view);
                drop(gone);
            }
            let then = on_time.borrow_mut().take();
            if let Some(then) = then {
                then(Ok(false))
            }
        });
        map.borrow_mut().insert(
            view,
            Box::new(move |ok| {
                kit::clear(timer);
                let then = slot.borrow_mut().take();
                if let Some(then) = then {
                    then(Ok(ok))
                }
            }),
        );
    }

    /// `request<App>Save(contents, mode)`
    pub(crate) fn request_save(self: &Rc<Self>, view: ViewId, mode: SaveMode, then: Then<bool>) {
        if self.is_destroyed(view) {
            return then(Ok(false));
        }
        if (self.hooks.presenting)(view) {
            return then(Ok(true));
        }
        if mode == SaveMode::Save && !self.is_dirty(view) && self.save_path(view).is_some() {
            return then(Ok(true));
        }
        self.arm(&self.save_waiters, view, then);
        let mode = match mode {
            SaveMode::Save => "save",
            SaveMode::SaveAs => "saveAs",
        };
        self.services.events.emit(
            Target::View(view),
            self.ch.save_request,
            vec![mode.into_ipc()],
        );
    }

    /// `<app>ReadText(contents)`: concurrent reads of one view share one request
    pub(crate) fn read_text(self: &Rc<Self>, view: ViewId, then: Then<String>) {
        if self.is_destroyed(view) {
            return then(Err(kit::error("the document is no longer open")));
        }
        if let Some(reading) = self.reads.borrow_mut().get_mut(&view) {
            reading.thens.push(then);
            return;
        }
        let me = Rc::downgrade(self);
        let timeout = kit::after(&self.services, READ_WAIT, move || {
            if let Some(d) = me.upgrade() {
                d.settle_read(view, Err(kit::error("timed out reading the document")))
            }
        });
        let retry = self.read_retry(view);
        self.reads.borrow_mut().insert(
            view,
            Reading {
                thens: vec![then],
                retry,
                timeout,
            },
        );
        self.services
            .events
            .emit(Target::View(view), self.ch.read_text_request, Vec::new());
    }

    /// the `setInterval` of a read: re-sends until the renderer answers
    fn read_retry(self: &Rc<Self>, view: ViewId) -> Timer {
        let me = Rc::downgrade(self);
        kit::after(&self.services, READ_RETRY, move || {
            let Some(d) = me.upgrade() else { return };
            if !d.reads.borrow().contains_key(&view) {
                return;
            }
            if d.is_destroyed(view) {
                return d.settle_read(view, Err(kit::error("the document is no longer open")));
            }
            d.services
                .events
                .emit(Target::View(view), d.ch.read_text_request, Vec::new());
            let next = d.read_retry(view);
            if let Some(reading) = d.reads.borrow_mut().get_mut(&view) {
                reading.retry = next;
            }
        })
    }

    fn settle_read(&self, view: ViewId, result: Result<String, IpcError>) {
        let Some(reading) = self.reads.borrow_mut().remove(&view) else {
            return;
        };
        kit::clear(reading.retry);
        kit::clear(reading.timeout);
        for then in reading.thens {
            then(result.clone())
        }
    }

    /// `<app>SaveToPath(contents, filePath)`: the renderer's own save, pointed
    /// at `path` first so it opens no dialog
    pub(crate) fn save_to_path(self: &Rc<Self>, view: ViewId, path: PathBuf, then: Then<()>) {
        if self.is_destroyed(view) {
            return then(Err(kit::error("the document is no longer open")));
        }
        let file_path = path.to_string_lossy().into_owned();
        let (previous, previous_open) = self.with_view(view, |s| {
            let before = (s.save.clone(), s.open.clone());
            s.save = Some(file_path.clone());
            s.allowed.insert(file_path.clone());
            before
        });
        // the copy belongs to the document as it was (an untitled one included),
        // not to the path the save is pointed at
        let recovery_before = self.recovery.identity_of(view);
        let restore: Rc<dyn Fn()> = {
            let me = Rc::downgrade(self);
            Rc::new(move || {
                let Some(d) = me.upgrade() else { return };
                d.with_view(view, |s| {
                    s.save = previous.clone();
                    s.open = previous_open.clone();
                });
                // a copy written under the target while the save ran must not outlive it
                d.recovery.save_to_path_failed(view, &file_path);
            })
        };
        let slot = Rc::new(RefCell::new(Some(then)));
        let (on_time, on_time_restore) = (Rc::clone(&slot), Rc::clone(&restore));
        let me = Rc::downgrade(self);
        let timer = kit::after(&self.services, SAVE_WAIT, move || {
            if let Some(d) = me.upgrade() {
                let gone = d.save_waiters.borrow_mut().remove(&view);
                drop(gone);
            }
            on_time_restore();
            let then = on_time.borrow_mut().take();
            if let Some(then) = then {
                then(Err(kit::error("timed out saving the document")))
            }
        });
        let me = Rc::downgrade(self);
        self.save_waiters.borrow_mut().insert(
            view,
            Box::new(move |ok| {
                kit::clear(timer);
                if ok {
                    if let Some(d) = me.upgrade() {
                        d.recovery.saved(view, recovery_before.as_ref());
                    }
                } else {
                    restore();
                }
                let then = slot.borrow_mut().take();
                if let Some(then) = then {
                    then(if ok {
                        Ok(())
                    } else {
                        Err(kit::error("could not save the document"))
                    })
                }
            }),
        );
        self.services.events.emit(
            Target::View(view),
            self.ch.save_request,
            vec!["save".into_ipc()],
        );
    }

    /// `<app>FileRenamed(contents, oldPath, newPath)`
    pub(crate) fn file_renamed(&self, view: ViewId, old_path: &Path, new_path: &Path) {
        let (old, new) = (
            old_path.to_string_lossy().into_owned(),
            new_path.to_string_lossy().into_owned(),
        );
        self.with_view(view, |s| {
            if s.save.as_deref() == Some(old.as_str()) {
                s.save = Some(new.clone());
            }
            if s.open.as_deref() == Some(old.as_str()) {
                s.open = Some(new.clone());
            }
            if s.allowed.contains(&old) {
                s.allowed.insert(new.clone());
            }
            if let Some(recorded) = s.disk.remove(&old) {
                s.disk.insert(new.clone(), recorded);
            }
        });
        // fire and forget, as the TypeScript's `void ... .catch`
        let rename = self.hooks.rename_assets;
        let app = self.ch.app;
        let (o, n) = (old.clone(), new.clone());
        kit::on_worker(
            &self.services,
            move || rename(&o, &n),
            move |result| {
                if let Err(error) = result {
                    eprintln!("[{app}] asset manifest rename sync failed: {error}");
                }
            },
        );
        if self.save_path(view).as_deref() == Some(new.as_str()) {
            self.recovery.renamed(view, &old);
        }
        if !self.is_destroyed(view) {
            self.services.events.emit(
                Target::View(view),
                self.ch.file_renamed,
                vec![new.into_ipc()],
            );
        }
    }

    /// `send<App>ExportRequest(contents, format)`
    pub(crate) fn export_request(&self, view: ViewId, format: &str) {
        if self.is_destroyed(view) || (self.hooks.presenting)(view) {
            return;
        }
        self.services.events.emit(
            Target::View(view),
            self.ch.export_request,
            vec![format.into_ipc()],
        );
    }

    /// The hidden view of `export<App>Headless`, made by the shell: it opens
    /// `input`, takes `target` with `consume-headless-export` and reports with
    /// `headless-export-done`; `then` gets the report, or the timeout's error.
    /// The shell destroys the hidden window afterwards.
    #[cfg_attr(
        not(test),
        allow(dead_code, reason = "the shell's headless entry calls it")
    )]
    pub(crate) fn headless_export(
        self: &Rc<Self>,
        view: ViewId,
        input: &str,
        target: IpcValue,
        timeout: Duration,
        then: HeadlessSettle,
    ) {
        self.track(view, Some(input));
        self.headless_targets.borrow_mut().insert(view, target);
        let me = Rc::downgrade(self);
        let app = self.ch.app;
        let ms = timeout.as_millis();
        let timer = kit::after(&self.services, timeout, move || {
            if let Some(d) = me.upgrade() {
                d.settle_headless(
                    view,
                    false,
                    Some(format!("{app} export timed out after {ms}ms")),
                )
            }
        });
        self.headless_waiters
            .borrow_mut()
            .insert(view, (then, timer));
    }

    fn settle_headless(&self, view: ViewId, ok: bool, error: Option<String>) {
        let Some((then, timer)) = self.headless_waiters.borrow_mut().remove(&view) else {
            return;
        };
        kit::clear(timer);
        self.headless_targets.borrow_mut().remove(&view);
        then(if ok {
            Ok(())
        } else {
            Err(error.unwrap_or_else(|| format!("{} export failed", self.ch.app)))
        })
    }

    /// The view's renderer process died (`render-process-gone`): its copy
    /// outlives it, and a headless export waiting on it fails
    #[cfg_attr(not(test), allow(dead_code, reason = "the shell reports it"))]
    pub(crate) fn renderer_gone(&self, view: ViewId, reason: &str) {
        self.recovery.view_crashed(view);
        self.settle_headless(
            view,
            false,
            Some(format!("{} renderer stopped ({reason})", self.ch.app)),
        );
    }

    // ---- the channels every text editor answers ----

    pub(crate) fn entries(self: &Rc<Self>) -> Vec<Entry> {
        let ch = &self.ch;
        let mut out = Vec::new();
        let d = Rc::clone(self);
        out.push(kit::invoke_later(
            ch.read_file,
            move |cx, args, responder| {
                let view = cx.sender.view;
                let Some(path) = args.str(0).filter(|p| d.is_granted(view, p)) else {
                    return responder.reply(Err(kit::error(format!(
                        "{}: path not granted to this view",
                        d.ch.app
                    ))));
                };
                let path = path.to_owned();
                let me = Rc::downgrade(&d);
                kit::on_worker(
                    &d.services,
                    move || {
                        let text = main_core::markdown::fs_util::read_file_utf8(&path);
                        let state = text.as_ref().ok().and_then(|_| record_disk_state(&path));
                        (path, text, state)
                    },
                    move |(path, text, state)| {
                        let reply = match text {
                            Ok(text) => {
                                // the reader's copy: this view's save guard compares against this state
                                if let (Some(d), Some(state)) = (me.upgrade(), state) {
                                    d.set_disk_state(view, &path, state);
                                }
                                Ok(text.into_ipc())
                            }
                            Err(e) => Err(kit::error(e.message)),
                        };
                        responder.reply(reply)
                    },
                );
            },
        ));
        let d = Rc::clone(self);
        out.push(kit::send(ch.dirty_changed, move |cx, args| {
            let dirty = args.bool(0) == Some(true);
            d.with_view(cx.sender.view, |s| s.dirty = dirty);
            Ok(())
        }));
        let d = Rc::clone(self);
        out.push(kit::send(ch.close_save_result, move |cx, args| {
            let waiter = d.close_waiters.borrow_mut().remove(&cx.sender.view);
            if let Some(waiter) = waiter {
                waiter(args.bool(0) == Some(true))
            }
            Ok(())
        }));
        let d = Rc::clone(self);
        out.push(kit::send(ch.read_text_result, move |cx, args| {
            let view = cx.sender.view;
            if !d.reads.borrow().contains_key(&view) {
                return Ok(());
            }
            let result = args.get(0);
            let has_text = matches!(result, IpcValue::Object(entries) if entries.iter().any(|(k, _)| k == "text"));
            d.settle_read(
                view,
                if has_text {
                    Ok(js_string(field(result, "text")))
                } else {
                    Err(kit::error("the document could not be read"))
                },
            );
            Ok(())
        }));
        // safety net for menu saves the renderer declined without invoking
        // save() (busy, still loading); the save handler resolves the normal path
        let d = Rc::clone(self);
        out.push(kit::send(ch.save_request_ack, move |cx, args| {
            let waiter = d.save_waiters.borrow_mut().remove(&cx.sender.view);
            if let Some(waiter) = waiter {
                waiter(args.bool(0) == Some(true))
            }
            Ok(())
        }));
        let d = Rc::clone(self);
        out.push(kit::invoke(ch.consume_headless_export, move |cx, _| {
            let target = d.headless_targets.borrow_mut().remove(&cx.sender.view);
            Ok(target.unwrap_or(IpcValue::Null))
        }));
        let d = Rc::clone(self);
        out.push(kit::send(ch.headless_export_done, move |cx, args| {
            let state = args.get(0);
            let error = match field(state, "error") {
                IpcValue::String(s) => Some(s.clone()),
                _ => None,
            };
            let ok = matches!(field(state, "ok"), IpcValue::Bool(true));
            d.settle_headless(cx.sender.view, ok, error);
            Ok(())
        }));
        out.extend(self.recovery.entries(ch.recovery_open, ch.recovery_write));
        out
    }
}

/// `{ ok: false, error }`
pub(crate) fn failure(error: impl Into<String>) -> IpcValue {
    obj([("ok", false.into_ipc()), ("error", error.into().into_ipc())])
}

/// `{ ok: true, canceled: true }`
pub(crate) fn canceled() -> IpcValue {
    obj([("ok", true.into_ipc()), ("canceled", true.into_ipc())])
}

/// `{ ok: true, path }`
pub(crate) fn saved_at(path: &str) -> IpcValue {
    obj([("ok", true.into_ipc()), ("path", path.into_ipc())])
}

/// whether a result object says `ok` and is not a cancel (the save waiter's answer)
pub(crate) fn saved_ok(result: &IpcValue) -> bool {
    matches!(field(result, "ok"), IpcValue::Bool(true))
        && !matches!(result, IpcValue::Object(e) if e.iter().any(|(k, _)| k == "canceled"))
}

/// `name.replace(/[/\\:*?"<>|]/g, '_').slice(0, 80).trim()`
pub(crate) fn file_name_base(name: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cut = jscompat::slice_utf16(&replaced, 0.0, Some(80.0));
    jscompat::trim(&cut).to_owned()
}

/// Implements [`shell_contract::DocumentEditors`] for an app's editors
/// struct that holds its [`TextDocs`] in a field named `docs`
macro_rules! text_document_editors {
    ($editors:ty) => {
        impl shell_contract::DocumentEditors for $editors {
            fn owns(&self, view: shell_contract::ViewId) -> bool {
                self.docs.owns(view)
            }
            fn request_save(
                &self,
                view: shell_contract::ViewId,
                mode: shell_contract::SaveMode,
                then: shell_contract::editors::Then<bool>,
            ) {
                self.docs.request_save(view, mode, then)
            }
            fn request_close(
                &self,
                view: shell_contract::ViewId,
                parent: Option<shell_contract::WindowId>,
                then: shell_contract::editors::Then<bool>,
            ) {
                self.docs.request_close(view, parent, then)
            }
            fn read_text(
                &self,
                view: shell_contract::ViewId,
                then: shell_contract::editors::Then<String>,
            ) {
                self.docs.read_text(view, then)
            }
            fn save_to_path(
                &self,
                view: shell_contract::ViewId,
                path: std::path::PathBuf,
                then: shell_contract::editors::Then<()>,
            ) {
                self.docs.save_to_path(view, path, then)
            }
            fn file_renamed(
                &self,
                view: shell_contract::ViewId,
                old_path: &std::path::Path,
                new_path: &std::path::Path,
            ) {
                self.docs.file_renamed(view, old_path, new_path)
            }
            fn export_request(&self, view: shell_contract::ViewId, format: &str) {
                self.docs.export_request(view, format)
            }
            fn document_path(&self, view: shell_contract::ViewId) -> Option<std::path::PathBuf> {
                self.docs.save_path(view).map(Into::into)
            }
        }
    };
}
pub(crate) use text_document_editors;

/// Electron's dialog options object, keys in the order the TypeScript's literals write them
pub(crate) fn dialog_options(
    title: Option<String>,
    default_path: Option<String>,
    filters: &[(String, Vec<&str>)],
    properties: &[&str],
) -> JsObject<JsonValue> {
    let mut options = JsObject::new();
    if let Some(title) = title {
        options.set("title", JsonValue::String(title));
    }
    if let Some(path) = default_path {
        options.set("defaultPath", JsonValue::String(path));
    }
    if !filters.is_empty() {
        options.set(
            "filters",
            JsonValue::Array(
                filters
                    .iter()
                    .map(|(name, exts)| {
                        let mut f = JsObject::new();
                        f.set("name", JsonValue::String(name.clone()));
                        f.set(
                            "extensions",
                            JsonValue::Array(
                                exts.iter()
                                    .map(|e| JsonValue::String((*e).to_owned()))
                                    .collect(),
                            ),
                        );
                        JsonValue::Object(f)
                    })
                    .collect(),
            ),
        );
    }
    if !properties.is_empty() {
        options.set(
            "properties",
            JsonValue::Array(
                properties
                    .iter()
                    .map(|p| JsonValue::String((*p).to_owned()))
                    .collect(),
            ),
        );
    }
    options
}

/// `exportFileName(suggested)` / the Markdown exports' `safeName`:
/// `String(suggested || untitled)` as a file name stem, `untitled` when empty
pub(crate) fn export_name(suggested: &IpcValue, untitled: &str) -> String {
    let raw = if crate::kit::truthy(suggested) {
        js_string(suggested)
    } else {
        untitled.to_owned()
    };
    let base = file_name_base(&raw);
    if base.is_empty() {
        untitled.to_owned()
    } else {
        base
    }
}
