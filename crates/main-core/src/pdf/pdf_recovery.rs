//! `apps/pdf/src/main/pdf-recovery.ts`: crash recovery for the PDF editor.
//!
//! What moved: `pdfLooksEncrypted` and every judgment of
//! `createPdfRecovery`, as a [`PdfRecovery`] the caller owns, one method per
//! function the closure returned. The per-view table is its state.
//!
//! What stays with the caller: the shared store ([`PdfRecoveryDeps::store`]),
//! the dialog and the parent window of the per-file question, the language,
//! the working folder and the random source behind `crypto.randomUUID`, all
//! behind [`PdfRecoveryDeps`]; the PDF engine that makes the bytes a copy
//! holds (`serialize` and `written` are the caller's closures, so the
//! pdf-lib work is engine-waiting); and the `ipcMain` handlers that call
//! these methods. A view is named by its `webContents.id` (the TypeScript
//! asks only the id of the contents it is given).
//!
//! Promises are plain calls. `resolving` is the flag of the one question
//! being asked: the TypeScript lets a second `resolveOnOpen` wait for the
//! first, which a plain call cannot, so a call that finds a question running
//! (only a host whose dialog pumps events can make one) returns at once.

use std::cell::RefCell;
use std::fs;
use std::rc::Rc;

use jscompat::node_path::host::{basename, join};
use jscompat::{JsMap, truthy};

use crate::node_fs::{NodeError, node_error};
use crate::packages::electron_utils::message_box::{MessageBox, ParentWindow};
use crate::packages::electron_utils::recovery_contract::RecoveryOpenDecision;
use crate::packages::electron_utils::recovery_labels::unprotectable_notice_text;
use crate::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, ResolveRecoveryOnOpenOptions, resolve_recovery_on_open,
};
use crate::packages::electron_utils::recovery_store::{
    RecoveryDeleteReason, RecoveryFileIdentity, RecoveryIdentity, RecoveryOpenPlan, RecoveryStore,
    RecoveryUntitledIdentity, RecoveryWriteOptions, RecoveryWriteResult, new_untitled_recovery_id,
};
use crate::shell::recent_files::StatInfo;

/// `PdfRecoveryWriteResult`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PdfRecoveryWriteResult {
    Written,
    Superseded,
    Skipped,
    Failed,
}

impl PdfRecoveryWriteResult {
    pub fn as_str(self) -> &'static str {
        match self {
            PdfRecoveryWriteResult::Written => "written",
            PdfRecoveryWriteResult::Superseded => "superseded",
            PdfRecoveryWriteResult::Skipped => "skipped",
            PdfRecoveryWriteResult::Failed => "failed",
        }
    }
}

/// a working file older than this, in the working folder, belongs to no open tab
pub const PDF_RECOVERY_WORK_FILE_MAX_AGE_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;

/// bytes a PDF name token can end with: whitespace and the delimiters
const NAME_END: [u8; 13] = [
    0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x28, 0x29, 0x2f, 0x3c, 0x3e, 0x5b, 0x5d,
];
const ENCRYPT_KEY: &[u8] = b"/Encrypt";

/// `buf.indexOf(ENCRYPT_KEY, from)`
fn index_of_key(buf: &[u8], from: usize) -> Option<usize> {
    let rest = buf.get(from..)?;
    rest.windows(ENCRYPT_KEY.len())
        .position(|window| window == ENCRYPT_KEY)
        .map(|at| at + from)
}

/// Whether the PDF carries an /Encrypt entry (a password or encrypted PDF):
/// its copy would sit unprotected in the app data folder, so it gets none.
/// A plain scan, since trailers and cross-reference stream dictionaries are
/// never compressed; a stray match only costs that document its copy.
pub fn pdf_looks_encrypted(buf: &[u8]) -> bool {
    let mut found = index_of_key(buf, 0);
    while let Some(at) = found {
        let after = at + ENCRYPT_KEY.len();
        if after >= buf.len() || NAME_END.contains(&buf[after]) {
            return true;
        }
        found = index_of_key(buf, at + 1);
    }
    false
}

/// `PdfRecoveryDeps`; a view's contents are named by their id
pub trait PdfRecoveryDeps {
    /// what `parentOf` answers (a `BrowserWindow`)
    type Window: ParentWindow;
    type Dialog: MessageBox<Self::Window>;

    /// `deps.store()`: `Ok(None)` is null (the app data folder is unavailable),
    /// an `Err` is a throw, which the module answers as null too
    fn store(&self) -> Result<Option<&RecoveryStore<'_>>, NodeError>;
    fn dialog(&self) -> &Self::Dialog;
    /// the window the per-file question sits over
    fn parent_of(&self, contents_id: i64) -> Option<Self::Window>;
    fn lang(&self) -> String;
    /// a skill template's untitled copy (a temp file, not the user's document)
    fn is_untitled_copy_path(&self, path: &str) -> bool;
    /// where a restored untitled copy's working file goes (never a user folder)
    fn work_dir(&self) -> String;
    /// `crypto.randomUUID()`
    fn random_uuid(&self) -> String;
    /// `Date.now()`
    fn now_ms(&self) -> f64;
    /// `console.warn(message, detail)`
    fn warn(&self, message: &str, detail: &str);
}

/// `openUntitled`'s request
#[derive(Debug, Clone, PartialEq)]
pub struct PdfOpenUntitledRequest {
    pub copy: RecoveryIdentity,
    pub title: String,
    pub save_as_default_path: Option<String>,
}

#[derive(Clone)]
struct Restored {
    path: String,
    bytes: Rc<Vec<u8>>,
}

struct UntitledDoc {
    path: String,
    identity: RecoveryIdentity,
    title: String,
    save_as_default_path: Option<String>,
}

struct ViewRecovery {
    /// the path whose recovery question this view has answered
    resolved_path: Option<String>,
    resolving: bool,
    /// the shell already decided for this path (launch list)
    decision: Option<(String, RecoveryOpenDecision)>,
    /// restored copy bytes for `path`: what the view reads and saves start from
    restored: Option<Restored>,
    /// opened from a copy and not saved since: the tab starts with unsaved changes
    unsaved_from_copy: bool,
    /// untitled document: its working path, identity and tab title
    untitled: Option<UntitledDoc>,
    /// the copy this view wrote or loaded ('closedClean' only deletes that one)
    owned_copy: Option<RecoveryIdentity>,
    /// "Don't Save" was chosen and the close has not been cancelled: no copy is
    /// written, and the one of `dropped_copy` goes with the view even if dirty
    dropped: bool,
    dropped_copy: Option<RecoveryIdentity>,
    /// the working file this module made for a restored untitled copy
    work_file: Option<String>,
    unprotectable: bool,
    /// the main process found the document encrypted (whatever the renderer says)
    source_encrypted: bool,
    notice_shown: bool,
    /// the renderer asked for its open path at least once
    consumed: bool,
    crashed: bool,
}

type View = Rc<RefCell<ViewRecovery>>;

fn same_identity(a: &RecoveryIdentity, b: &RecoveryIdentity) -> bool {
    match (a, b) {
        (RecoveryIdentity::Untitled(a), RecoveryIdentity::Untitled(b)) => {
            a.untitled_id == b.untitled_id
        }
        (RecoveryIdentity::File(a), RecoveryIdentity::File(b)) => a.file_path == b.file_path,
        _ => false,
    }
}

fn file_identity(path: &str) -> RecoveryIdentity {
    RecoveryIdentity::File(RecoveryFileIdentity {
        kind: "pdf".to_owned(),
        file_path: path.to_owned(),
    })
}

/// `rm(path, { force: true })`: a missing path is fine, a folder is refused
fn rm_force(path: &str) -> Result<(), NodeError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(node_error(&error, "lstat", path)),
        Ok(meta) if meta.is_dir() => Err(NodeError {
            code: Some("ERR_FS_EISDIR"),
            message: format!("Path is a directory: rm returned EISDIR (is a directory) {path}"),
        }),
        Ok(_) => fs::remove_file(path).map_err(|error| node_error(&error, "unlink", path)),
    }
}

/// `createPdfRecovery(deps)`
pub struct PdfRecovery<D: PdfRecoveryDeps> {
    deps: D,
    views: RefCell<JsMap<View>>,
}

impl<D: PdfRecoveryDeps> PdfRecovery<D> {
    pub fn new(deps: D) -> Self {
        PdfRecovery {
            deps,
            views: RefCell::new(JsMap::new()),
        }
    }

    pub fn deps(&self) -> &D {
        &self.deps
    }

    fn view(&self, id: i64) -> View {
        let key = id.to_string();
        let mut views = self.views.borrow_mut();
        if let Some(state) = views.get(&key) {
            return Rc::clone(state);
        }
        let state = Rc::new(RefCell::new(ViewRecovery {
            resolved_path: None,
            resolving: false,
            decision: None,
            restored: None,
            unsaved_from_copy: false,
            untitled: None,
            owned_copy: None,
            dropped: false,
            dropped_copy: None,
            work_file: None,
            unprotectable: false,
            source_encrypted: false,
            notice_shown: false,
            consumed: false,
            crashed: false,
        }));
        views.set(key, Rc::clone(&state));
        state
    }

    fn view_if_any(&self, id: i64) -> Option<View> {
        self.views.borrow().get(&id.to_string()).cloned()
    }

    fn store(&self) -> Option<&RecoveryStore<'_>> {
        self.deps.store().ok().flatten()
    }

    /// the identity this view's copies of `path` are written under
    fn identity_for(&self, id: i64, path: &str) -> RecoveryIdentity {
        let state = self.view(id);
        if let Some(untitled) = &state.borrow().untitled
            && untitled.path == path
        {
            return untitled.identity.clone();
        }
        if self.deps.is_untitled_copy_path(path) {
            // a skill template's copy: an untitled document whose copy has its own slot
            let identity = RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
                kind: "pdf".to_owned(),
                untitled_id: new_untitled_recovery_id(&|| self.deps.random_uuid()),
                ext: ".pdf".to_owned(),
            });
            state.borrow_mut().untitled = Some(UntitledDoc {
                path: path.to_owned(),
                identity: identity.clone(),
                title: basename(path, None),
                save_as_default_path: None,
            });
            return identity;
        }
        file_identity(path)
    }

    fn delete_copy(&self, identity: &RecoveryIdentity, reason: RecoveryDeleteReason) {
        // a copy left behind is offered again, never lost
        if let Some(store) = self.store() {
            let _ = store.delete_copy(identity, reason);
        }
    }

    /// remove the view's working file once nothing reads it any more
    fn drop_work_file(&self, state: &View, path: Option<&str>) {
        let file = state.borrow().work_file.clone();
        let Some(file) = file else {
            return;
        };
        if let Some(path) = path
            && file != path
        {
            return;
        }
        state.borrow_mut().work_file = None;
        if let Err(error) = rm_force(&file) {
            self.deps
                .warn("[pdf] recovery working file not removed:", &error.message);
        }
    }

    /// the view now shows another document: stop dropping the old one's copies
    fn clear_dropped(&self, state: &View) {
        let mut state = state.borrow_mut();
        state.dropped = false;
        state.dropped_copy = None;
    }

    fn resolve(&self, contents_id: i64, path: &str) {
        let state = self.view(contents_id);
        let untitled_here = state
            .borrow()
            .untitled
            .as_ref()
            .is_some_and(|untitled| untitled.path == path);
        if untitled_here || self.deps.is_untitled_copy_path(path) {
            state.borrow_mut().resolved_path = Some(path.to_owned());
            return;
        }
        let Some(store) = self.store() else {
            state.borrow_mut().resolved_path = Some(path.to_owned());
            return;
        };
        let identity = file_identity(path);
        let decided = {
            let mut state = state.borrow_mut();
            let decided = match &state.decision {
                Some((decided_path, decision)) if decided_path == path => Some(*decision),
                _ => None,
            };
            state.decision = None;
            decided
        };
        let attempt = self.read_for_open(store, contents_id, &identity, decided);
        let bytes = match attempt {
            Ok(bytes) => bytes,
            Err(error) => {
                // an unreadable copy is kept; the file opens as saved
                self.deps
                    .warn("[pdf] recovery open failed:", &error.message);
                None
            }
        };
        let mut state = state.borrow_mut();
        if let Some(bytes) = bytes {
            // held, not copied again
            state.restored = Some(Restored {
                path: path.to_owned(),
                bytes: Rc::new(bytes),
            });
            state.unsaved_from_copy = true;
            state.owned_copy = Some(identity);
        }
        state.resolved_path = Some(path.to_owned());
    }

    fn read_for_open(
        &self,
        store: &RecoveryStore<'_>,
        contents_id: i64,
        identity: &RecoveryIdentity,
        decided: Option<RecoveryOpenDecision>,
    ) -> Result<Option<Vec<u8>>, NodeError> {
        let mut bytes: Option<Vec<u8>> = None;
        match decided {
            Some(RecoveryOpenDecision::Restore) => {
                if !matches!(store.open_plan(identity)?, RecoveryOpenPlan::None) {
                    bytes = store.read_copy(identity);
                    if bytes.is_some() {
                        store.mark_copy_loaded(identity)?;
                    }
                }
            }
            Some(RecoveryOpenDecision::Original) => {}
            None => {
                let parent = self.deps.parent_of(contents_id);
                let lang = self.deps.lang();
                let answer = resolve_recovery_on_open(&ResolveRecoveryOnOpenOptions {
                    store,
                    identity,
                    dialog: self.deps.dialog(),
                    parent: parent.as_ref(),
                    lang: &lang,
                    document_name: None,
                })?;
                if let RecoveryOpenResult::Restore {
                    bytes: restored, ..
                } = answer
                {
                    bytes = Some(restored);
                }
            }
        }
        Ok(bytes)
    }

    /// The common case without waiting: true when `path` needs no question for
    /// this view (already answered, untitled, or no copy), which is then
    /// recorded; false when `resolve_on_open` has to run.
    pub fn resolved_now(&self, contents_id: i64, path: &str) -> bool {
        let state = self.view(contents_id);
        {
            let state = state.borrow();
            if state.resolving {
                return false;
            }
            if state.resolved_path.as_deref() == Some(path) {
                return true;
            }
            if let Some((decided_path, _)) = &state.decision
                && decided_path == path
            {
                return false;
            }
        }
        let mut none = true;
        let untitled_here = state
            .borrow()
            .untitled
            .as_ref()
            .is_some_and(|untitled| untitled.path == path);
        if !untitled_here && !self.deps.is_untitled_copy_path(path) {
            // no readable store: the file opens as saved
            none = match self.store() {
                None => true,
                Some(store) => match store.open_plan(&file_identity(path)) {
                    Ok(plan) => matches!(plan, RecoveryOpenPlan::None),
                    Err(_) => true,
                },
            };
        }
        if none {
            state.borrow_mut().resolved_path = Some(path.to_owned());
        }
        none
    }

    /// Before the renderer reads `path`: answer the recovery question once per
    /// view and path (the per-file prompt, or the shell's decision). Nothing
    /// of the document is loaded before this returns.
    pub fn resolve_on_open(&self, contents_id: i64, path: &str) {
        let state = self.view(contents_id);
        state.borrow_mut().consumed = true;
        if state.borrow().resolving {
            return;
        }
        if state.borrow().resolved_path.as_deref() == Some(path) {
            return;
        }
        state.borrow_mut().resolving = true;
        self.resolve(contents_id, path);
        state.borrow_mut().resolving = false;
    }

    /// the renderer asked for its file (with or without one to open)
    pub fn mark_consumed(&self, id: i64) {
        self.view(id).borrow_mut().consumed = true;
    }

    /// the renderer asked for its file already: a later open has to reload the view
    pub fn has_consumed(&self, id: i64) -> bool {
        self.view_if_any(id)
            .is_some_and(|state| state.borrow().consumed)
    }

    /// the shell decided for `path` (launch list) before the view reads it
    pub fn set_decision(&self, id: i64, path: &str, decision: RecoveryOpenDecision) {
        let state = self.view(id);
        self.clear_dropped(&state);
        let mut state = state.borrow_mut();
        state.source_encrypted = false;
        state.decision = Some((path.to_owned(), decision));
        if state.resolved_path.as_deref() == Some(path) {
            state.resolved_path = None;
        }
        state.restored = None;
        state.unsaved_from_copy = false;
    }

    /// the restored copy's bytes when this view shows `path` from a copy
    pub fn view_bytes(&self, id: i64, path: &str) -> Option<Rc<Vec<u8>>> {
        let state = self.view_if_any(id)?;
        let state = state.borrow();
        match &state.restored {
            Some(restored) if restored.path == path => Some(Rc::clone(&restored.bytes)),
            _ => None,
        }
    }

    /// whether the view's document came from a copy and has not been saved since
    pub fn unsaved_from_copy(&self, id: i64, path: &str) -> bool {
        let Some(state) = self.view_if_any(id) else {
            return false;
        };
        let state = state.borrow();
        if !state.unsaved_from_copy {
            return false;
        }
        state
            .restored
            .as_ref()
            .is_some_and(|restored| restored.path == path)
            || state
                .untitled
                .as_ref()
                .is_some_and(|untitled| untitled.path == path)
    }

    /// Write the copy of `path` for this view. `serialize` produces the bytes
    /// a save would write, or `None` when the document turns out to be
    /// encrypted (no copy then, and none later); an `Err` is what it threw.
    /// The write ticket is taken before it runs, so a save (which deletes the
    /// copy) landing meanwhile wins. After "Don't Save" nothing is written
    /// until the close is cancelled.
    pub fn write_copy(
        &self,
        id: i64,
        path: &str,
        serialize: &mut dyn FnMut() -> Result<Option<Vec<u8>>, NodeError>,
    ) -> PdfRecoveryWriteResult {
        let state = self.view(id);
        {
            let state = state.borrow();
            if state.dropped {
                return PdfRecoveryWriteResult::Superseded;
            }
            if state.unprotectable || state.source_encrypted {
                return PdfRecoveryWriteResult::Skipped;
            }
            if state.resolved_path.as_deref() != Some(path) || state.resolving {
                return PdfRecoveryWriteResult::Skipped;
            }
        }
        let Some(store) = self.store() else {
            return PdfRecoveryWriteResult::Skipped;
        };
        match self.write_copy_of(store, id, path, &state, serialize) {
            Ok(result) => result,
            Err(error) => {
                self.deps
                    .warn("[pdf] recovery copy failed:", &error.message);
                PdfRecoveryWriteResult::Failed
            }
        }
    }

    fn write_copy_of(
        &self,
        store: &RecoveryStore<'_>,
        id: i64,
        path: &str,
        state: &View,
        serialize: &mut dyn FnMut() -> Result<Option<Vec<u8>>, NodeError>,
    ) -> Result<PdfRecoveryWriteResult, NodeError> {
        let identity = self.identity_for(id, path);
        let ticket = store.begin_write(&identity)?;
        let Some(bytes) = serialize()? else {
            state.borrow_mut().source_encrypted = true;
            return Ok(PdfRecoveryWriteResult::Skipped);
        };
        if state.borrow().dropped {
            return Ok(PdfRecoveryWriteResult::Superseded);
        }
        let title = match &state.borrow().untitled {
            Some(untitled) if untitled.path == path => untitled.title.clone(),
            _ => basename(path, None),
        };
        let result = store.write_copy(
            &identity,
            &bytes,
            &RecoveryWriteOptions {
                title: Some(title),
                ticket: Some(ticket),
                ..RecoveryWriteOptions::default()
            },
        )?;
        if result == RecoveryWriteResult::Written {
            state.borrow_mut().owned_copy = Some(identity);
            return Ok(PdfRecoveryWriteResult::Written);
        }
        Ok(PdfRecoveryWriteResult::Superseded)
    }

    /// A save in place of `path` succeeded. A file document's copy is deleted
    /// and the restore ends (the disk now holds the bytes). An untitled
    /// document only saved into its working file, not to a place the user
    /// chose: its copy is refreshed from what was written instead.
    pub fn saved_in_place(
        &self,
        id: i64,
        path: &str,
        written: &mut dyn FnMut() -> Result<Vec<u8>, NodeError>,
    ) {
        let state = self.view(id);
        {
            let mut state = state.borrow_mut();
            if state
                .restored
                .as_ref()
                .is_some_and(|restored| restored.path == path)
            {
                state.restored = None;
            }
            // the renderer's pending state is in the written file now, as for any save
            state.unsaved_from_copy = false;
        }
        let untitled = state.borrow().untitled.as_ref().and_then(|untitled| {
            (untitled.path == path).then(|| (untitled.identity.clone(), untitled.title.clone()))
        });
        if let Some((identity, title)) = untitled {
            if state.borrow().unprotectable {
                return;
            }
            let Some(store) = self.store() else {
                return;
            };
            let attempt = (|| -> Result<(), NodeError> {
                let ticket = store.begin_write(&identity)?;
                let bytes = written()?;
                // the save wrote a password-protected file: no copy of it is kept
                if pdf_looks_encrypted(&bytes) {
                    return Ok(());
                }
                let result = store.write_copy(
                    &identity,
                    &bytes,
                    &RecoveryWriteOptions {
                        title: Some(title.clone()),
                        ticket: Some(ticket),
                        ..RecoveryWriteOptions::default()
                    },
                )?;
                if result == RecoveryWriteResult::Written {
                    state.borrow_mut().owned_copy = Some(identity.clone());
                }
                Ok(())
            })();
            if let Err(error) = attempt {
                self.deps
                    .warn("[pdf] recovery copy failed:", &error.message);
            }
            return;
        }
        let identity = file_identity(path);
        // the save succeeded; a copy left behind is offered again, never lost
        self.delete_copy(&identity, RecoveryDeleteReason::Saved);
        let mut state = state.borrow_mut();
        if state
            .owned_copy
            .as_ref()
            .is_some_and(|owned| same_identity(owned, &identity))
        {
            state.owned_copy = None;
        }
    }

    /// an untitled document was saved to `target`, which is now the tab's file
    pub fn adopted(&self, id: i64, old_path: &str, target: &str) {
        let state = self.view(id);
        let untitled_identity =
            state.borrow().untitled.as_ref().and_then(|untitled| {
                (untitled.path == old_path).then(|| untitled.identity.clone())
            });
        if let Some(identity) = untitled_identity {
            self.delete_copy(&identity, RecoveryDeleteReason::Saved);
            let mut state = state.borrow_mut();
            if state
                .owned_copy
                .as_ref()
                .is_some_and(|owned| same_identity(owned, &identity))
            {
                state.owned_copy = None;
            }
            state.untitled = None;
        }
        // the document lives in `target` now: its working file has done its job
        self.drop_work_file(&state, Some(old_path));
        let mut state = state.borrow_mut();
        state.unsaved_from_copy = false;
        state.restored = None;
        state.resolved_path = Some(target.to_owned());
    }

    /// A clean view wrote its document into a new file (a redaction or signed
    /// copy) and now shows that file. The old document's copy is never moved
    /// onto the new file, where restoring it would undo the redaction: it is
    /// deleted (an untitled document's as saved, a file's like a clean close).
    pub fn moved_to_new_file(&self, id: i64, old_path: &str, target: &str) {
        let Some(state) = self.view_if_any(id) else {
            return;
        };
        let owned = state.borrow().owned_copy.clone();
        let untitled_identity =
            state.borrow().untitled.as_ref().and_then(|untitled| {
                (untitled.path == old_path).then(|| untitled.identity.clone())
            });
        if let Some(owned) = owned {
            if let Some(identity) = &untitled_identity
                && same_identity(&owned, identity)
            {
                self.delete_copy(&owned, RecoveryDeleteReason::Saved);
                state.borrow_mut().owned_copy = None;
            } else if let RecoveryIdentity::File(file) = &owned
                && file.file_path == old_path
            {
                self.delete_copy(&owned, RecoveryDeleteReason::ClosedClean);
                state.borrow_mut().owned_copy = None;
            }
        }
        if untitled_identity.is_some() {
            state.borrow_mut().untitled = None;
        }
        self.drop_work_file(&state, Some(old_path));
        let mut state = state.borrow_mut();
        if state
            .restored
            .as_ref()
            .is_some_and(|restored| restored.path == old_path)
        {
            state.restored = None;
        }
        state.unsaved_from_copy = false;
        state.resolved_path = Some(target.to_owned());
    }

    /// The person reloads `path` from disk after another program changed it,
    /// giving up the view's unsaved edits: a restored copy no longer stands in
    /// for the file, and the copy of the dropped edits goes like a clean
    /// close. Untitled documents are not watched and keep their copy.
    pub fn discarded_for_disk(&self, id: i64, path: &str) {
        let Some(state) = self.view_if_any(id) else {
            return;
        };
        if state
            .borrow()
            .untitled
            .as_ref()
            .is_some_and(|untitled| untitled.path == path)
        {
            return;
        }
        {
            let mut state = state.borrow_mut();
            if state
                .restored
                .as_ref()
                .is_some_and(|restored| restored.path == path)
            {
                state.restored = None;
            }
            state.unsaved_from_copy = false;
        }
        let owned = state.borrow().owned_copy.clone();
        if let Some(owned) = owned
            && let RecoveryIdentity::File(file) = &owned
            && file.file_path == path
        {
            self.delete_copy(&owned, RecoveryDeleteReason::ClosedClean);
            state.borrow_mut().owned_copy = None;
        }
    }

    /// "Save As" default for an untitled document whose original went missing
    pub fn save_as_default_path(&self, id: i64, path: &str) -> Option<String> {
        let state = self.view_if_any(id)?;
        let state = state.borrow();
        let untitled = state.untitled.as_ref()?;
        if untitled.path == path {
            untitled.save_as_default_path.clone()
        } else {
            None
        }
    }

    /// The user chose "Don't Save" for the view's document. Its copy goes
    /// now, and until the close is cancelled ([`Self::close_cancelled`]) no
    /// copy is written and the view deletes a late one when it goes, dirty or
    /// not: other tabs' prompts may keep this one open for a while.
    pub fn dont_save(&self, id: i64, path: Option<&str>) {
        let state = self.view(id);
        let identity = truthy(path).map(|path| self.identity_for(id, path));
        let dropped_copy = identity.or_else(|| state.borrow().owned_copy.clone());
        {
            let mut state = state.borrow_mut();
            state.dropped = true;
            state.dropped_copy = dropped_copy.clone();
        }
        if let Some(copy) = &dropped_copy {
            self.delete_copy(copy, RecoveryDeleteReason::DontSave);
        }
        state.borrow_mut().owned_copy = None;
    }

    /// the close after "Don't Save" was cancelled: copies resume; true when it had been dropped
    pub fn close_cancelled(&self, id: i64) -> bool {
        let Some(state) = self.view_if_any(id) else {
            return false;
        };
        if !state.borrow().dropped {
            return false;
        }
        // the view is still open with its edits: the store's "Don't Save"
        // block on its copy lifts too (an edit can tell before the shell does)
        let dropped = state.borrow().dropped_copy.clone();
        if let Some(dropped) = dropped
            && let Some(store) = self.store()
        {
            // no readable store: nothing is written either
            let _ = store.clear_discarded(&dropped);
        }
        self.clear_dropped(&state);
        true
    }

    /// The view's file moved (the shell renamed it): the copy and the restore
    /// follow the new path.
    pub fn renamed(&self, id: i64, old_path: &str, new_path: &str) {
        let Some(state) = self.view_if_any(id) else {
            return;
        };
        {
            let mut state = state.borrow_mut();
            if state.resolved_path.as_deref() == Some(old_path) {
                state.resolved_path = Some(new_path.to_owned());
            }
            if let Some(restored) = &mut state.restored
                && restored.path == old_path
            {
                restored.path = new_path.to_owned();
            }
        }
        let owned = state.borrow().owned_copy.clone();
        let Some(owned) = owned else {
            return;
        };
        let RecoveryIdentity::File(owned_file) = &owned else {
            return;
        };
        if owned_file.file_path != old_path {
            return;
        }
        let Some(store) = self.store() else {
            return;
        };
        let next = file_identity(new_path);
        let attempt = (|| -> Result<(), NodeError> {
            let Some(bytes) = store.read_copy(&owned) else {
                return Ok(());
            };
            let result = store.write_copy(
                &next,
                &bytes,
                &RecoveryWriteOptions {
                    title: Some(basename(new_path, None)),
                    ..RecoveryWriteOptions::default()
                },
            )?;
            if result == RecoveryWriteResult::Written {
                state.borrow_mut().owned_copy = Some(next.clone());
                store.delete_copy(&owned, RecoveryDeleteReason::Discarded)?;
            }
            Ok(())
        })();
        if let Err(error) = attempt {
            self.deps
                .warn("[pdf] recovery copy move failed:", &error.message);
        }
    }

    /// Load an untitled copy (or a copy whose original is missing) into a
    /// view: its bytes become a working file outside the user's folders, which
    /// the view opens as an untitled document with unsaved changes. Answers
    /// the working path, or `None` when the copy cannot be read.
    pub fn open_untitled(
        &self,
        id: i64,
        request: &PdfOpenUntitledRequest,
    ) -> Result<Option<String>, NodeError> {
        let Some(store) = self.store() else {
            return Ok(None);
        };
        if request.copy.kind() != "pdf" {
            return Ok(None);
        }
        let Some(bytes) = store.read_copy(&request.copy) else {
            return Ok(None);
        };
        let dir = self.deps.work_dir();
        fs::create_dir_all(&dir).map_err(|error| node_error(&error, "mkdir", &dir))?;
        let path = join(&[&dir, &format!("{}.pdf", self.deps.random_uuid())]);
        fs::write(&path, &bytes).map_err(|error| node_error(&error, "open", &path))?;
        store.mark_copy_loaded(&request.copy)?;
        let state = self.view(id);
        self.clear_dropped(&state);
        state.borrow_mut().source_encrypted = false;
        // a working file this view made earlier is replaced by this one
        self.drop_work_file(&state, None);
        let mut state = state.borrow_mut();
        state.work_file = Some(path.clone());
        state.untitled = Some(UntitledDoc {
            path: path.clone(),
            identity: request.copy.clone(),
            title: request.title.clone(),
            save_as_default_path: truthy(request.save_as_default_path.as_deref())
                .map(str::to_owned),
        });
        state.restored = None;
        state.unsaved_from_copy = true;
        state.owned_copy = Some(request.copy.clone());
        state.resolved_path = Some(path.clone());
        Ok(Some(path))
    }

    /// The renderer reports whether the open document cannot get a safe copy
    /// (a password or encrypted PDF). Answers the one-time notice for this
    /// tab, or `None` when there is nothing (more) to say.
    pub fn report_unprotectable(&self, id: i64, unprotectable: bool) -> Option<String> {
        let state = self.view(id);
        let mut state = state.borrow_mut();
        state.unprotectable = unprotectable;
        if !(unprotectable || state.source_encrypted) || state.notice_shown {
            return None;
        }
        state.notice_shown = true;
        Some(unprotectable_notice_text(&self.deps.lang()))
    }

    pub fn is_unprotectable(&self, id: i64) -> bool {
        match self.view_if_any(id) {
            Some(state) => {
                let state = state.borrow();
                state.unprotectable || state.source_encrypted
            }
            None => false,
        }
    }

    /// the untitled document's copy identity this view shows, if it shows one
    pub fn untitled_identity(&self, id: i64) -> Option<RecoveryIdentity> {
        let state = self.view_if_any(id)?;
        let state = state.borrow();
        state
            .untitled
            .as_ref()
            .map(|untitled| untitled.identity.clone())
    }

    pub fn mark_crashed(&self, id: i64) {
        self.view(id).borrow_mut().crashed = true;
    }

    /// The view is gone. After "Don't Save" its copy is deleted whatever it
    /// wrote since (allowed while the app is ending too). Otherwise a tab
    /// that closed with no unsaved changes deletes the copy it wrote; a
    /// crashed or still-dirty view keeps it, and the store refuses this delete
    /// while the app is ending. A working file goes either way: the copy in
    /// the store is what a reopened tab reads.
    pub fn destroyed(&self, id: i64, dirty: bool) {
        let removed = self.views.borrow_mut().delete(&id.to_string());
        let Some(state) = removed else {
            return;
        };
        self.drop_work_file(&state, None);
        let (dropped, dropped_copy, owned_copy, crashed) = {
            let state = state.borrow();
            (
                state.dropped,
                state.dropped_copy.clone(),
                state.owned_copy.clone(),
                state.crashed,
            )
        };
        if dropped {
            if let Some(copy) = dropped_copy {
                self.delete_copy(&copy, RecoveryDeleteReason::DontSave);
            }
            return;
        }
        let Some(owned) = owned_copy else {
            return;
        };
        if dirty || crashed {
            return;
        }
        self.delete_copy(&owned, RecoveryDeleteReason::ClosedClean);
    }

    /// Remove working files a crash left behind: only files in the working
    /// folder, only older than `max_age_ms` (default
    /// [`PDF_RECOVERY_WORK_FILE_MAX_AGE_MS`]), never one an open view uses.
    pub fn sweep_work_files(&self, max_age_ms: Option<f64>) {
        let max_age_ms = max_age_ms.unwrap_or(PDF_RECOVERY_WORK_FILE_MAX_AGE_MS);
        let dir = self.deps.work_dir();
        let Ok(read) = fs::read_dir(&dir) else {
            return;
        };
        // `readdir` lists the names sorted by bytes
        let mut names: Vec<String> = read
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let in_use: Vec<String> = self
            .views
            .borrow()
            .values()
            .filter_map(|state| state.borrow().work_file.clone())
            .collect();
        let cutoff = self.deps.now_ms() - max_age_ms;
        for name in names {
            let file = join(&[&dir, &name]);
            if in_use.contains(&file) {
                continue;
            }
            // still in use or already gone: the next start looks again
            let Ok(info) = fs::symlink_metadata(&file) else {
                continue;
            };
            if !info.is_file() || StatInfo::of(&info).mtime_ms > cutoff {
                continue;
            }
            let _ = rm_force(&file);
        }
    }
}
