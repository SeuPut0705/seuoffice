//! The PDF editor (`apps/pdf/src/main/pdf-main.ts`), its recovery included.
//!
//! One [`Editor`] holds what the TypeScript kept in module-level maps: per
//! view ([`View`]: open path, dirty flag, waiters, disk records, watcher,
//! certificates) and process-wide (the untitled path sets, the writes in
//! flight, the page clipboard). The view's granted files are [`Grants`],
//! shared with the PDF tools. Handlers live by subject in the submodules;
//! what other areas call (`flushPdfSave`, `requestPdfClose`, ...) is
//! [`PdfEditors`](editors::PdfEditors).

mod dialogs;
pub(crate) mod editors;
pub(crate) mod hosts;
mod media;
mod open;
mod pages;
#[cfg(feature = "probe")]
pub(crate) mod probe;
mod recovery;
mod save;
mod sign;
#[cfg(test)]
mod tests;
mod watch;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::{Rc, Weak};
use std::sync::{Arc, Mutex};

use jscompat::node_path::host;
use main_core::packages::electron_utils::default_save_dir::{
    PathProvider, SaveDirState, Thrown, configured_default_save_dir,
};
use main_core::packages::electron_utils::dialog_memory::DialogMemory;
use main_core::packages::electron_utils::recovery_store::SharedRecoveryState;
use main_core::packages::electron_utils::save_conflict::SaveDiskState;
use main_core::pdf::note_link::NoteLinkService;
use main_core::pdf::ocr::OcrBridge;
use shell_contract::hosts::{ContentsHost, DialogsHost, OsShellHost};
use shell_contract::ipc::{RegisterError, Target};
use shell_contract::runtime::{PathName, Services};
use shell_contract::{Batch, IpcValue, Provided, ViewId};

use super::Grants;
use crate::kit::{self, Entry, Timer};

pub(crate) use editors::PdfEditors;
use hosts::{PdfEngineHost, PdfShellHost};
use recovery::{Recovery, Store};

/// A renderer reply the main side waits for, shared between the waiter
/// table and its timeout as the TypeScript's `resolve` was
type Waiting<T> = Rc<RefCell<Option<Box<dyn FnOnce(T)>>>>;

fn resolve<T>(waiting: &Waiting<T>, value: T) {
    let then = waiting.borrow_mut().take();
    if let Some(then) = then {
        then(value)
    }
}

/// `CertEntry`: a certificate the person picked, by opaque id
#[derive(Clone)]
enum CertEntry {
    File(String),
    System {
        reference: main_core::pdf::system_certificates::SystemCertificateRef,
        identity: Option<main_core::pdf::system_certificates::SystemIdentity>,
    },
}

/// Everything the TypeScript kept per `webContents.id`
#[derive(Default)]
struct View {
    /// `openPathByWc`
    open_path: Option<String>,
    /// `dirtyByWc`
    dirty: bool,
    /// `closeSaveWaiters`
    close_save: Option<(Waiting<bool>, Timer)>,
    /// `saveAsWaiters`
    save_as: Option<(Waiting<editors::SaveAsOutcome>, Timer)>,
    /// `saveAsTargetByWc`
    save_as_target: Option<String>,
    /// `imageTargetByWc`
    image_target: Option<String>,
    /// `redactionPathByWc`
    redaction_path: Option<String>,
    /// `redactionFlows`
    redaction_flow: bool,
    /// `docDiskStates`
    disk_states: HashMap<String, SaveDiskState>,
    /// `ownWriteStates`
    own_writes: HashMap<String, SaveDiskState>,
    /// `diskWatchByWc`
    watch: Option<watch::Watch>,
    /// `certEntriesByWc`
    certs: HashMap<String, CertEntry>,
    /// `untitledCopyTargetByWc`: the copy and where it goes
    untitled_copy_target: Option<(String, String)>,
    /// `copyFlushWaiters`
    copy_flush: Option<(Waiting<()>, Timer)>,
}

/// The process-wide part
#[derive(Default)]
struct State {
    views: HashMap<ViewId, View>,
    /// `untitledPdfPaths`
    untitled: HashSet<String>,
    /// `unsavedBlankPdfPaths`
    unsaved_blank: HashSet<String>,
    /// `untitledCopyPdfPaths`
    untitled_copy: HashSet<String>,
    /// `unsavedUntitledCopyPaths`
    unsaved_untitled_copy: HashSet<String>,
    /// `ownWritesInFlight`
    in_flight: HashMap<String, u32>,
    /// page-clipboard.ts `held`: the copied pages' PDF and their count
    held: Option<(Arc<Vec<u8>>, f64)>,
    /// `lastUsedDirectoryByDialog` of `showOpenDialogWithMemory`
    memory: DialogMemory,
    /// `configuredDefaultSaveDir`'s cache of unusable folders
    save_dir: SaveDirState,
}

type DestroyedHook = Rc<dyn Fn(ViewId)>;

pub(super) struct Editor {
    me: Weak<Editor>,
    services: Services,
    grants: Grants,
    dialogs: DialogsHost,
    os: OsShellHost,
    contents: ContentsHost,
    engine: PdfEngineHost,
    shell: PdfShellHost,
    st: RefCell<State>,
    rec: RefCell<Recovery>,
    /// `noteLinks`
    notes: NoteLinkService,
    /// ocr.ts `engine`, found once; used on workers
    ocr: Arc<Mutex<OcrBridge>>,
    /// keeps the `destroyed` listener alive
    _destroyed: RefCell<Option<DestroyedHook>>,
}

/// `app.getPath` as `configuredDefaultSaveDir` reads it
struct AppPaths<'a>(&'a Services);

impl PathProvider for AppPaths<'_> {
    fn get_path(&self, name: &str) -> Result<String, Thrown> {
        let name = match name {
            "userData" => PathName::UserData,
            "documents" => PathName::Documents,
            "home" => PathName::Home,
            "temp" => PathName::Temp,
            other => return Err(Thrown(format!("Failed to get '{other}' path"))),
        };
        Ok(self.0.paths.path(name).to_string_lossy().into_owned())
    }
}

/// `{ ok: false, error }`
fn failed(error: impl Into<String>) -> IpcValue {
    kit::obj([("ok", false.into_ipc()), ("error", error.into().into_ipc())])
}

/// `{ ok: false, reason }`
fn refused(reason: impl Into<String>) -> IpcValue {
    kit::obj([
        ("ok", false.into_ipc()),
        ("reason", reason.into().into_ipc()),
    ])
}

const NOT_GRANTED: &str = "pdf: path not granted to this view";

use kit::IntoIpc;

/// `Date.now()`
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

/// `fs.readFile(path)` as Node reports its failure
fn read_file(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| main_core::node_fs::node_error(&e, "open", path).message)
}

/// `fs.writeFile(path, bytes)`
fn write_file(path: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(path, bytes)
        .map_err(|e| main_core::node_fs::node_error(&e, "open", path).message)
}

impl Editor {
    fn new(services: &Services, grants: &Grants) -> Result<Rc<Editor>, RegisterError> {
        let hosts = &services.hosts;
        let dialogs = hosts.need::<DialogsHost>(Batch::D2)?;
        let os = hosts.need::<OsShellHost>(Batch::D2)?;
        let contents = hosts.need::<ContentsHost>(Batch::D2)?;
        let engine = hosts.need::<PdfEngineHost>(Batch::D2)?;
        let shell = hosts.need::<PdfShellHost>(Batch::D2)?;
        let shared = hosts.need::<Arc<Mutex<SharedRecoveryState>>>(Batch::D2)?;
        let store = Store {
            shared,
            user_data: services.paths.path(PathName::UserData),
        };
        let work_dir = services
            .paths
            .path(PathName::Temp)
            .join("seuoffice-pdf-recovery");
        let platform = shell.platform();
        let editor = Rc::new_cyclic(|me: &Weak<Editor>| Editor {
            me: me.clone(),
            services: services.clone(),
            grants: grants.clone(),
            dialogs,
            os,
            contents,
            engine,
            shell,
            st: RefCell::default(),
            rec: RefCell::new(Recovery::new(store, work_dir)),
            notes: NoteLinkService::new(platform),
            ocr: Arc::new(Mutex::new(OcrBridge::new())),
            _destroyed: RefCell::new(None),
        });
        let me = Rc::downgrade(&editor);
        let hook = kit::on_view_destroyed(services, move |view| {
            if let Some(ed) = me.upgrade() {
                ed.destroyed(view)
            }
        });
        *editor._destroyed.borrow_mut() = Some(hook);
        Ok(editor)
    }

    fn rc(&self) -> Rc<Editor> {
        self.me.upgrade().expect("the editor outlives its handlers")
    }

    fn lang(&self) -> String {
        self.shell.ui_lang()
    }

    fn path(&self, name: PathName) -> String {
        self.services
            .paths
            .path(name)
            .to_string_lossy()
            .into_owned()
    }

    /// `allowedByWc.has(wc)`: the view is a PDF view
    fn registered(&self, view: ViewId) -> bool {
        self.grants.0.contains(view)
    }

    /// `pdfPathGranted(wc, path)`
    fn granted(&self, view: ViewId, path: &IpcValue) -> Option<String> {
        let path = kit::as_str(path)?;
        self.grants.granted(view, path).then(|| path.to_owned())
    }

    /// `allowedByWc.set(wc, new Set([path]))`
    fn grant_only(&self, view: ViewId, path: &str) {
        self.grants.0.insert(view, HashSet::from([path.to_owned()]));
    }

    fn with_view<R>(&self, view: ViewId, f: impl FnOnce(&mut View) -> R) -> R {
        f(self.st.borrow_mut().views.entry(view).or_default())
    }

    fn open_path(&self, view: ViewId) -> Option<String> {
        self.st.borrow().views.get(&view)?.open_path.clone()
    }

    /// `pdfIsDirty(wcId)`
    fn is_dirty(&self, view: ViewId) -> bool {
        let st = self.st.borrow();
        let Some(v) = st.views.get(&view) else {
            return false;
        };
        v.dirty
            || v.open_path
                .as_ref()
                .is_some_and(|p| st.unsaved_untitled_copy.contains(p))
    }

    fn is_untitled_copy(&self, path: &str) -> bool {
        self.st.borrow().untitled_copy.contains(path)
    }

    /// `contents.send(channel, ...args)` unless the view is gone
    fn emit(&self, view: ViewId, channel: &'static str, args: Vec<IpcValue>) {
        if self.services.views.sender_of(view).is_some() {
            self.services.events.emit(Target::View(view), channel, args)
        }
    }

    fn view_bytes(&self, view: ViewId, path: &str) -> Option<Arc<Vec<u8>>> {
        self.rec.borrow().view_bytes(view, path)
    }

    /// `configuredDefaultSaveDir(app)`
    fn default_save_dir(&self) -> Result<String, String> {
        let now = now_ms();
        let mut st = self.st.borrow_mut();
        configured_default_save_dir(&AppPaths(&self.services), &mut st.save_dir, now)
            .map_err(|e| e.0)
    }

    /// `openGeneratedPdf(path)`: a new tab, else the file in its folder
    fn open_generated_pdf(&self, path: &str) {
        match self.shell.open_generated_path(path) {
            Ok(true) => return,
            Ok(false) => {}
            Err(err) => eprintln!("[pdf] Failed to open generated PDF: {err}"),
        }
        self.os.show_item_in_folder(std::path::Path::new(path));
    }

    /// `rememberDiskState(wcId, path)` with the state a worker recorded
    fn remember_disk_state(&self, view: ViewId, path: &str, state: Option<SaveDiskState>) {
        if let Some(state) = state {
            self.with_view(view, |v| v.disk_states.insert(path.to_owned(), state));
        }
    }

    /// `forgetDiskState(wcId, path)`
    fn forget_disk_state(&self, view: ViewId, path: &str) {
        self.with_view(view, |v| {
            v.own_writes.remove(path);
            v.disk_states.remove(path);
        });
    }

    /// `moveDiskState(wcId, oldPath, newPath)`
    fn move_disk_state(&self, view: ViewId, old: &str, new: &str) {
        self.with_view(view, |v| {
            for states in [&mut v.disk_states, &mut v.own_writes] {
                if let Some(recorded) = states.remove(old) {
                    states.insert(new.to_owned(), recorded);
                }
            }
        });
    }

    /// The document as the view shows it, read on a worker: the restored
    /// copy, else the file (`viewDocumentBytes`)
    fn document_bytes(
        &self,
        view: ViewId,
        path: &str,
    ) -> impl FnOnce() -> Result<Arc<Vec<u8>>, String> + Send + 'static {
        let restored = self.view_bytes(view, path);
        let path = path.to_owned();
        move || match restored {
            Some(bytes) => Ok(bytes),
            None => read_file(&path).map(Arc::new),
        }
    }

    /// `writeOwnFile(wcId, path, write)`: other views' watchers wait while
    /// `path` is written (on a worker), and on success this view's records
    /// and watcher move to the written bytes
    fn write_own_file<T: Send + 'static>(
        &self,
        view: ViewId,
        path: &str,
        write: impl FnOnce() -> Result<T, String> + Send + 'static,
        then: impl FnOnce(Result<T, String>) + 'static,
    ) {
        *self
            .st
            .borrow_mut()
            .in_flight
            .entry(path.to_owned())
            .or_insert(0) += 1;
        let ed = self.rc();
        let target = path.to_owned();
        let written_path = target.clone();
        kit::on_worker(
            &self.services,
            move || {
                let result = write();
                let written = result
                    .is_ok()
                    .then(|| {
                        main_core::packages::electron_utils::save_conflict::record_disk_state(
                            &written_path,
                        )
                    })
                    .flatten();
                (result, written)
            },
            move |(result, written)| {
                if result.is_ok() {
                    {
                        let mut st = ed.st.borrow_mut();
                        // a write into an untitled copy is not a save of the document
                        if st.untitled_copy.contains(&target) {
                            st.unsaved_untitled_copy.insert(target.clone());
                        }
                    }
                    ed.remember_disk_state(view, &target, written.clone());
                    ed.with_view(view, |v| match written {
                        Some(w) => v.own_writes.insert(target.clone(), w),
                        None => v.own_writes.remove(&target),
                    });
                    ed.rebase_watch(view, &target);
                }
                {
                    let mut st = ed.st.borrow_mut();
                    let left = st
                        .in_flight
                        .get(&target)
                        .copied()
                        .unwrap_or(1)
                        .saturating_sub(1);
                    if left > 0 {
                        st.in_flight.insert(target.clone(), left);
                    } else {
                        st.in_flight.remove(&target);
                    }
                }
                then(result)
            },
        );
    }

    /// The view is gone: the TypeScript's `destroyed` listener of `grantAndTrack`
    fn destroyed(&self, view: ViewId) {
        // before the dirty flag goes: a tab closed clean drops its copy
        let dirty = self.is_dirty(view);
        self.rec.borrow_mut().destroyed(view, dirty);
        let gone = {
            let mut st = self.st.borrow_mut();
            let gone = st.views.remove(&view);
            if let Some(open) = gone.as_ref().and_then(|v| v.open_path.as_ref()) {
                st.unsaved_untitled_copy.remove(open);
            }
            gone
        };
        let Some(mut gone) = gone else { return };
        if let Some((waiting, timer)) = gone.copy_flush.take() {
            kit::clear(timer);
            resolve(&waiting, ());
        }
        if let Some(watch) = gone.watch.take() {
            watch.close(self, view);
        }
        if let Some((waiting, timer)) = gone.close_save.take() {
            kit::clear(timer);
            resolve(&waiting, false);
        }
        if let Some((waiting, timer)) = gone.save_as.take() {
            kit::clear(timer);
            resolve(&waiting, editors::SaveAsOutcome::Failed);
        }
    }
}

/// `user_data` folder joined with `name`
fn user_data_file(ed: &Editor, name: &str) -> String {
    host::join(&[&ed.path(PathName::UserData), name])
}

pub(crate) fn entries(
    services: &Services,
    provided: &Rc<Provided>,
    grants: &Grants,
) -> Result<Vec<Entry>, RegisterError> {
    let ed = Editor::new(services, grants)?;
    let editors = Rc::new(PdfEditors(ed.clone()));
    provided.add::<dyn shell_contract::editors::DocumentEditors>(editors.clone());
    // the PDF-only calls (flushPdfSave, requestPdfSaveAs, ...) by their own type
    provided.add::<PdfEditors>(editors);
    let mut all = open::entries(&ed);
    all.extend(save::entries(&ed));
    all.extend(pages::entries(&ed));
    all.extend(media::entries(&ed));
    all.extend(sign::entries(&ed));
    Ok(all)
}

#[cfg(any(test, feature = "probe"))]
mod fakes;

/// The fakes of this part's hosts, answering from `case` (`hosts.d2.pdf`)
#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    fakes::insert(hosts, case)
}
