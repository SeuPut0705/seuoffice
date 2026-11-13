//! The Word editor (`apps/docs/src/main/docs-main.ts` and its document recovery).
//!
//! One [`Docs`] holds what `docs-main.ts` kept at module level (the write
//! grants, the open documents, the disk states, the password intents, the
//! recovery book, the first-document queues, the close guard's waiters) and
//! every handler shares it. Where the TypeScript awaited real work (file
//! reads and writes, hashing, an engine) the handler goes to a worker
//! ([`kit::on_worker`]) and finishes back here; dialogs are synchronous host
//! calls; renderer round trips (the close check, the close save, the
//! write-copies-now token) keep their continuation in [`close`].
//!
//! The libraries that are not in Rust are [`hosts::DocsEngine`]; the shell's
//! own hooks are [`hosts::DocsShell`]. The functions other areas called on
//! this module are [`editors::DocsEditors`].

mod adapters;
mod close;
mod editors;
mod export;
pub(crate) mod hosts;
mod misc;
mod open;
mod passwords;
mod recovery;
mod save;
#[cfg(test)]
mod tests;
mod texts;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::{Rc, Weak};
use std::sync::{Arc, Mutex};

use jscompat::{JsObject, JsonValue};
use main_core::docs::external_change::DiskFileState;
use main_core::node_fs::NodeError;
use main_core::packages::electron_utils::default_save_dir::{
    SaveDirState, configured_default_save_dir,
};
use main_core::packages::electron_utils::dialog_memory::{
    DialogMemory, FallbackDir, show_open_dialog_with_memory, show_save_dialog_with_memory,
};
use main_core::packages::electron_utils::recovery_contract::RecoveryOpenDecision;
use main_core::packages::electron_utils::recovery_store::{RecoveryStore, SharedRecoveryState};
use main_core::packages::i18n::Lang;
use shell_contract::hosts::{ContentsHost, DialogsHost, MainWindowHost, MessageBox, OsShellHost};
use shell_contract::ipc::RegisterError;
use shell_contract::runtime::{PathName, Services};
use shell_contract::{Batch, BytesKind, IpcValue, Provided, ViewId, WindowId};

use crate::kit::{self, Entry, IntoIpc, ViewMap};

use self::adapters::{HostDialog, Paths};
use self::close::Close;
use self::hosts::{DocsEngineHost, DocsShellHost};
use self::passwords::Passwords;
use self::recovery::{RecoveryBook, SharedRecovery};

/// Word's own .docx ceiling (`MAX_OPEN_BYTES`)
const MAX_OPEN_BYTES: u64 = 512 * 1024 * 1024;

/// A restored untitled copy waiting for its tab's first-document request:
/// the open result's fields and the bytes it hands off then
pub(crate) type UntitledOpen = (Vec<(String, IpcValue)>, Vec<u8>);

/// What `docs-main.ts` kept at module level, and the hosts it reached
pub(crate) struct Docs {
    services: Services,
    dialogs: DialogsHost,
    os: OsShellHost,
    contents: ContentsHost,
    main: MainWindowHost,
    engine: DocsEngineHost,
    shell: DocsShellHost,
    recovery_shared: SharedRecovery,
    /// `SEUOFFICE_TEST_EXPORT_DIR`
    test_export_dir: Option<String>,
    /// `lastUsedDirectoryByDialog` of the dialog memory
    memory: Arc<Mutex<DialogMemory>>,
    save_dir: RefCell<SaveDirState>,
    /// `docWritablePaths`
    doc_writable: ViewMap<HashSet<String>>,
    /// `pdfWritablePaths`
    pdf_writable: ViewMap<HashSet<String>>,
    /// `tornDownWcIds`: never shrinks (view ids are not reused)
    torn_down: RefCell<HashSet<ViewId>>,
    /// `openDocByWc`
    open_doc: ViewMap<String>,
    /// `imageExportTemps` (removed from disk when the view goes)
    image_temps: RefCell<HashMap<ViewId, HashSet<String>>>,
    /// `imageExportDirs`
    image_dirs: ViewMap<HashSet<String>>,
    /// `docDiskStates`
    disk_states: ViewMap<HashMap<String, DiskFileState>>,
    /// `saveAsPicks`
    save_as_picks: ViewMap<String>,
    /// `docx-encryption.ts`'s maps
    passwords: RefCell<Passwords>,
    /// `docsRecovery`
    book: RefCell<RecoveryBook>,
    /// `pendingOpenDecisions`
    open_decisions: ViewMap<(String, RecoveryOpenDecision)>,
    /// `bootedDocsRenderers`
    booted: RefCell<HashSet<ViewId>>,
    /// `pendingUntitledRecoveries`
    pending_untitled: ViewMap<Option<UntitledOpen>>,
    /// `pendingWindowOpens`
    window_opens: ViewMap<String>,
    /// `pendingNewBlankIds`
    new_blank: RefCell<HashSet<ViewId>>,
    /// `pendingDocCopies`: the copy's file and the name it shows
    doc_copies: ViewMap<(String, String)>,
    /// `headlessExportTargets`: out path and format
    headless_targets: ViewMap<(String, String)>,
    /// `headlessExportWaiters`
    headless_waiters: RefCell<HashMap<ViewId, HeadlessThen>>,
    /// the close guard and the other renderer round trips
    close: Close,
    /// `viewMenuStateByWebContents`: aiSidebar, darkCanvas, odt
    view_menu: ViewMap<[bool; 3]>,
    /// keeps the view-destroyed listener registered for as long as this lives
    _destroyed: RefCell<Option<DestroyedHook>>,
}

/// What a headless export's caller gets: done, or the renderer's reason
pub(crate) type HeadlessThen = Box<dyn FnOnce(Result<(), String>)>;

type DestroyedHook = Rc<dyn Fn(ViewId)>;

pub(crate) fn entries(
    services: &Services,
    provided: &Rc<Provided>,
) -> Result<Vec<Entry>, RegisterError> {
    let docs = Rc::new(Docs {
        services: services.clone(),
        dialogs: services.hosts.need::<DialogsHost>(Batch::D2)?,
        os: services.hosts.need::<OsShellHost>(Batch::D2)?,
        contents: services.hosts.need::<ContentsHost>(Batch::D2)?,
        main: services.hosts.need::<MainWindowHost>(Batch::D2)?,
        engine: services.hosts.need::<DocsEngineHost>(Batch::D2)?,
        shell: services.hosts.need::<DocsShellHost>(Batch::D2)?,
        recovery_shared: services
            .hosts
            .need::<Arc<Mutex<SharedRecoveryState>>>(Batch::D2)?,
        test_export_dir: std::env::var("SEUOFFICE_TEST_EXPORT_DIR")
            .ok()
            .filter(|d| !d.is_empty()),
        memory: Arc::default(),
        save_dir: RefCell::new(SaveDirState::new()),
        doc_writable: ViewMap::new(services),
        pdf_writable: ViewMap::new(services),
        torn_down: RefCell::default(),
        open_doc: ViewMap::new(services),
        image_temps: RefCell::default(),
        image_dirs: ViewMap::new(services),
        disk_states: ViewMap::new(services),
        save_as_picks: ViewMap::new(services),
        passwords: RefCell::default(),
        book: RefCell::default(),
        open_decisions: ViewMap::new(services),
        booted: RefCell::default(),
        pending_untitled: ViewMap::new(services),
        window_opens: ViewMap::new(services),
        new_blank: RefCell::default(),
        doc_copies: ViewMap::new(services),
        headless_targets: ViewMap::new(services),
        headless_waiters: RefCell::default(),
        close: Close::default(),
        view_menu: ViewMap::new(services),
        _destroyed: RefCell::default(),
    });
    let weak: Weak<Docs> = Rc::downgrade(&docs);
    let hook = kit::on_view_destroyed(services, move |view| {
        if let Some(docs) = weak.upgrade() {
            docs.view_destroyed(view)
        }
    });
    *docs._destroyed.borrow_mut() = Some(hook);
    // the trait for every area; the concrete editor for the shell's docs-only
    // calls (teardown, the first-document queues, crash recovery)
    let editor = Rc::new(editors::DocsEditors(docs.clone()));
    provided.add::<dyn shell_contract::editors::DocumentEditors>(editor.clone());
    provided.add::<editors::DocsEditors>(editor);

    let mut all = open::entries(&docs);
    all.extend(save::entries(&docs));
    all.extend(export::entries(&docs));
    all.extend(misc::entries(&docs));
    all.extend(close::entries(&docs));
    Ok(all)
}

/// This app's host fakes, answering from `case` (`hosts.d2.docs`)
#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    hosts::fakes(hosts, case)
}

/// An object literal built key by key, `undefined` members kept as the
/// structured clone keeps them
#[derive(Default)]
pub(crate) struct Obj(Vec<(String, IpcValue)>);

impl Obj {
    pub fn new() -> Self {
        Obj::default()
    }
    pub fn set(mut self, key: &str, value: impl IntoIpc) -> Self {
        self.0.push((key.to_owned(), value.into_ipc()));
        self
    }
    pub fn done(self) -> IpcValue {
        IpcValue::Object(self.0)
    }
}

/// `{ ok: false }`
pub(crate) fn not_ok() -> IpcValue {
    Obj::new().set("ok", false).done()
}

/// `{ ok: false, error }`
pub(crate) fn failed(error: impl Into<String>) -> IpcValue {
    Obj::new()
        .set("ok", false)
        .set("error", error.into())
        .done()
}

/// `String(err)` of a Node file error
pub(crate) fn node_text(e: &NodeError) -> String {
    format!("Error: {}", e.message)
}

/// `String(err)` of an `Error` whose message an engine answered
pub(crate) fn error_text(message: &str) -> String {
    format!("Error: {message}")
}

/// A Node file error as `fs` throws it, from a Rust one
pub(crate) fn fs_error(e: &std::io::Error, syscall: &str, path: &str) -> NodeError {
    main_core::node_fs::node_error(e, syscall, path)
}

/// `data instanceof ArrayBuffer`
pub(crate) fn array_buffer(v: &IpcValue) -> Option<&[u8]> {
    match v {
        IpcValue::Bytes(BytesKind::ArrayBuffer, b) => Some(b),
        _ => None,
    }
}

/// `fs.stat(path)`: mtimeMs and size
pub(crate) fn stat(path: &str) -> Result<(f64, f64), NodeError> {
    let meta = std::fs::metadata(path).map_err(|e| fs_error(&e, "stat", path))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    Ok((mtime, meta.len() as f64))
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    main_core::markdown::fs_util::sha256_hex(bytes)
}

/// `JSON.parse(readFileSync(path))`, `None` where `readJson` falls back
pub(crate) fn read_json(path: &str) -> Option<JsonValue> {
    let text = std::fs::read_to_string(path).ok()?;
    jscompat::json_parse(&text).ok()
}

/// A JavaScript object literal for an Electron option bag
pub(crate) fn js_obj(entries: Vec<(&str, JsonValue)>) -> JsObject<JsonValue> {
    let mut o = JsObject::new();
    for (k, v) in entries {
        o.set(k, v);
    }
    o
}

pub(crate) fn js_str(s: impl Into<String>) -> JsonValue {
    JsonValue::String(s.into())
}

/// `[{ name, extensions }]`
pub(crate) fn js_filters(filters: &[(String, Vec<&str>)]) -> JsonValue {
    JsonValue::Array(
        filters
            .iter()
            .map(|(name, exts)| {
                JsonValue::Object(js_obj(vec![
                    ("name", js_str(name.clone())),
                    (
                        "extensions",
                        JsonValue::Array(exts.iter().map(|e| js_str(*e)).collect()),
                    ),
                ]))
            })
            .collect(),
    )
}

impl Docs {
    fn lang(&self) -> Lang {
        self.shell.ui_lang()
    }

    fn tm(&self, key: &str) -> String {
        texts::tm(self.lang(), key, &[])
    }

    fn tm_with(&self, key: &str, params: &[(&str, &str)]) -> String {
        texts::tm(self.lang(), key, params)
    }

    /// `!contents.isDestroyed()`
    fn alive(&self, view: ViewId) -> bool {
        self.services.views.sender_of(view).is_some()
    }

    fn is_torn_down(&self, view: ViewId) -> bool {
        self.torn_down.borrow().contains(&view)
    }

    /// `hostWindowFor(sender)`: the view's window, else the shell window
    fn parent(&self, view: ViewId) -> Option<WindowId> {
        self.contents.window_of(view).or_else(|| self.main.window())
    }

    fn user_data(&self, parts: &[&str]) -> String {
        let root = self
            .services
            .paths
            .path(PathName::UserData)
            .to_string_lossy()
            .into_owned();
        let mut all = vec![root.as_str()];
        all.extend_from_slice(parts);
        jscompat::node_path::host::join(&all)
    }

    fn temp_dir(&self) -> String {
        self.services
            .paths
            .path(PathName::Temp)
            .to_string_lossy()
            .into_owned()
    }

    fn allow_doc_write(&self, view: ViewId, path: &str) {
        let mut set = self.doc_writable.get(view).unwrap_or_default();
        set.insert(path.to_owned());
        self.doc_writable.insert(view, set);
    }

    fn can_doc_write(&self, view: ViewId, path: &str) -> bool {
        self.doc_writable
            .with(view, |s| s.is_some_and(|s| s.contains(path)))
    }

    fn allow_pdf_write(&self, view: ViewId, path: &str) {
        let mut set = self.pdf_writable.get(view).unwrap_or_default();
        set.insert(path.to_owned());
        self.pdf_writable.insert(view, set);
    }

    fn can_pdf_write(&self, view: ViewId, path: &str) -> bool {
        if let Some(dir) = &self.test_export_dir
            && path.starts_with(&format!("{dir}/"))
        {
            return true;
        }
        self.pdf_writable
            .with(view, |s| s.is_some_and(|s| s.contains(path)))
    }

    fn is_image_temp(&self, view: ViewId, path: &str) -> bool {
        self.image_temps
            .borrow()
            .get(&view)
            .is_some_and(|s| s.contains(path))
    }

    fn add_image_export(&self, view: ViewId, pdf_path: &str, dir: &str) {
        self.allow_pdf_write(view, pdf_path);
        self.image_temps
            .borrow_mut()
            .entry(view)
            .or_default()
            .insert(pdf_path.to_owned());
        let mut dirs = self.image_dirs.get(view).unwrap_or_default();
        dirs.insert(dir.to_owned());
        self.image_dirs.insert(view, dirs);
    }

    /// `defaultSaveDir()`
    fn default_save_dir(&self) -> Result<String, String> {
        configured_default_save_dir(
            &Paths(self.services.paths.as_ref()),
            &mut self.save_dir.borrow_mut(),
            recovery_now_ms(),
        )
        .map_err(|e| e.0)
    }

    /// `openDialog(event, options)`: `showOpenDialogWithMemory`
    fn open_dialog(&self, view: ViewId, options: JsObject<JsonValue>) -> JsonValue {
        let parent = self.parent(view);
        let mut memory = self.memory.lock().unwrap_or_else(|e| e.into_inner());
        show_open_dialog_with_memory(
            &mut memory,
            &mut HostDialog(&self.dialogs),
            parent.as_ref(),
            &options,
            None,
        )
    }

    /// `saveDialog(event, options)`: bare names anchor in the default save folder
    fn save_dialog(&self, view: ViewId, options: JsObject<JsonValue>) -> JsonValue {
        let parent = self.parent(view);
        let resolve = || {
            self.default_save_dir()
                .map(Some)
                .map_err(main_core::packages::electron_utils::default_save_dir::Thrown)
        };
        let fallback = FallbackDir::Resolve(&resolve);
        let mut memory = self.memory.lock().unwrap_or_else(|e| e.into_inner());
        show_save_dialog_with_memory(
            &mut memory,
            &mut HostDialog(&self.dialogs),
            parent.as_ref(),
            &options,
            Some(&fallback),
        )
    }

    /// `dialog.showMessageBox(parent?, options)`: the button pressed
    fn message(&self, parent: Option<WindowId>, options: MessageBox) -> usize {
        self.dialogs.message(parent, &options).response
    }

    /// `showOpenErrorIn(parent, detail)`
    fn show_open_error(&self, parent: Option<WindowId>, detail: String) {
        self.message(
            parent,
            MessageBox {
                kind: Some("error".into()),
                message: self.tm("dlgOpenDoc"),
                detail: Some(detail),
                ..Default::default()
            },
        );
    }

    fn with_store<R>(&self, f: impl FnOnce(&RecoveryStore) -> R) -> R {
        recovery::with_store(&self.recovery_shared, &self.user_data(&[]), f)
    }

    fn recent_path(&self) -> String {
        self.user_data(&["recent.json"])
    }

    /// `pushRecent(filePath)`
    fn push_recent(&self, path: &str) {
        if self.shell.is_headless() {
            return;
        }
        let recent: Vec<JsonValue> = match read_json(&self.recent_path()) {
            Some(JsonValue::Array(items)) => items,
            _ => Vec::new(),
        };
        if recent.first() == Some(&js_str(path)) {
            return;
        }
        let mut next = vec![js_str(path)];
        next.extend(recent.into_iter().filter(|p| *p != js_str(path)));
        next.truncate(100);
        // the document is saved already: a lost recents entry must not fail it
        let _ = main_core::packages::electron_utils::atomic_write::write_json_atomic(
            &self.recent_path(),
            &JsonValue::Array(next),
        );
        self.shell.rebuild_docs_menu();
    }

    /// `rememberDiskState` with the stat a worker took (`None`: unstatable)
    fn remember_disk(&self, view: ViewId, path: &str, hash: String, stat: Option<(f64, f64)>) {
        let Some((mtime_ms, size)) = stat else {
            return;
        };
        let mut states = self.disk_states.get(view).unwrap_or_default();
        states.insert(
            path.to_owned(),
            DiskFileState {
                mtime_ms,
                size,
                hash,
            },
        );
        self.disk_states.insert(view, states);
    }

    /// `rememberOpenDoc(wcId, filePath)`
    fn remember_open_doc(&self, view: ViewId, path: &str) {
        self.open_doc.insert(view, path.to_owned());
    }

    /// `openGeneratedFile(path)`
    fn open_generated_file(&self, path: &str) {
        if self.shell.is_headless() {
            return;
        }
        if let Ok(true) = self.shell.open_generated_path(path) {
            return;
        }
        self.os.show_item_in_folder(std::path::Path::new(path));
    }

    /// `notifyFileSaved(wc, filePath)`
    fn notify_file_saved(&self, view: ViewId, path: &str) -> String {
        self.shell
            .file_saved(view, path)
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| path.to_owned())
    }

    /// `discardTabCopies(contents, filePath)`
    fn discard_tab_copies(&self, view: ViewId, path: Option<&str>) {
        self.with_store(|store| self.book.borrow_mut().discard(store, view, path));
        if self.alive(view) {
            self.services.events.emit(
                shell_contract::ipc::Target::View(view),
                "docs:recovery-copy-dropped",
                Vec::new(),
            );
        }
    }

    /// `dropDocWriter` and the `destroyed` listeners of `createDocsView`:
    /// the per-view state the view maps do not drop themselves
    fn view_destroyed(&self, view: ViewId) {
        if let Some(temps) = self.image_temps.borrow_mut().remove(&view) {
            for p in temps {
                let _ = std::fs::remove_file(p);
            }
        }
        self.engine.forget_lazy_media_owner(view);
        self.booted.borrow_mut().remove(&view);
        self.torn_down.borrow_mut().insert(view);
        let waiter = self.headless_waiters.borrow_mut().remove(&view);
        if let Some(settle) = waiter {
            settle(Err("docs renderer stopped (destroyed)".into()));
        }
        close::view_destroyed(self, view);
    }
}

pub(crate) fn recovery_now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}
