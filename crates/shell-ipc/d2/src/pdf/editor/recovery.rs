//! `apps/pdf/src/main/pdf-recovery.ts`: crash recovery of the PDF editor
//! (spec 1-3, 5.4, 7).
//!
//! A recovery copy is what a save would write, kept in the app data folder
//! through the shared store. Opening a file with a copy asks the per-file
//! question before the renderer reads anything; restoring keeps the copy's
//! bytes for that view, which it reads and saves from until the first save
//! in place. Untitled documents' copies live under an untitled identity.
//!
//! What differs from the TypeScript: the question is a synchronous dialog on
//! the core thread (contract section 3), so `resolveOnOpen` cannot overlap
//! another resolve and the `resolving` promise is gone. `writeCopy` and the
//! untitled branch of `savedInPlace` wait for serialization on a worker:
//! they are split in a start (ticket, checks) and a finish here, and the
//! handler runs the work between.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jscompat::node_path::host::{basename, join};
use jscompat::random_uuid;
use main_core::packages::electron_utils::recovery_labels::unprotectable_notice_text;
use main_core::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, ResolveRecoveryOnOpenOptions, resolve_recovery_on_open,
};
use main_core::packages::electron_utils::recovery_store::{
    RecoveryDeleteReason, RecoveryFileIdentity, RecoveryIdentity, RecoveryOpenPlan, RecoveryStore,
    RecoveryStoreOptions, RecoveryUntitledIdentity, RecoveryWriteOptions, RecoveryWriteResult,
    RecoveryWriteTicket, SharedRecoveryState, create_recovery_store, new_untitled_recovery_id,
};
use shell_contract::hosts::Dialogs;
use shell_contract::{ViewId, WindowId};

use super::dialogs::{Boxes, Parent};
use super::now_ms;

/// `PDF_RECOVERY_WORK_FILE_MAX_AGE_MS`
pub(super) const WORK_FILE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// `PdfRecoveryWriteResult`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CopyResult {
    Written,
    Superseded,
    Skipped,
    Failed,
}

impl CopyResult {
    pub fn as_str(self) -> &'static str {
        match self {
            CopyResult::Written => "written",
            CopyResult::Superseded => "superseded",
            CopyResult::Skipped => "skipped",
            CopyResult::Failed => "failed",
        }
    }
}

/// `pdfLooksEncrypted(bytes)`: an `/Encrypt` name in the bytes. A plain scan,
/// since trailers and cross-reference stream dictionaries are never
/// compressed; a stray match only costs that document its copy.
pub(crate) fn pdf_looks_encrypted(bytes: &[u8]) -> bool {
    const KEY: &[u8] = b"/Encrypt";
    const NAME_END: [u8; 13] = [
        0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20, 0x28, 0x29, 0x2f, 0x3c, 0x3e, 0x5b, 0x5d,
    ];
    bytes.windows(KEY.len()).enumerate().any(|(at, w)| {
        w == KEY
            && bytes
                .get(at + KEY.len())
                .is_none_or(|b| NAME_END.contains(b))
    })
}

pub(super) fn file_identity(path: &str) -> RecoveryIdentity {
    RecoveryIdentity::File(RecoveryFileIdentity {
        kind: "pdf".into(),
        file_path: path.to_owned(),
    })
}

fn same_identity(a: &RecoveryIdentity, b: &RecoveryIdentity) -> bool {
    match (a, b) {
        (RecoveryIdentity::Untitled(a), RecoveryIdentity::Untitled(b)) => {
            a.untitled_id == b.untitled_id
        }
        (RecoveryIdentity::File(a), RecoveryIdentity::File(b)) => a.file_path == b.file_path,
        _ => false,
    }
}

fn is_file_of(identity: &RecoveryIdentity, path: &str) -> bool {
    matches!(identity, RecoveryIdentity::File(f) if f.file_path == path)
}

/// The one store of the process, reachable from any thread: the shared
/// state the shell keeps, and the app data folder
#[derive(Clone)]
pub(super) struct Store {
    pub shared: Arc<Mutex<SharedRecoveryState>>,
    pub user_data: PathBuf,
}

impl Store {
    pub fn with<R>(&self, f: impl FnOnce(&RecoveryStore<'_>) -> R) -> R {
        let shared = self.shared.lock().unwrap_or_else(|e| e.into_inner());
        let dir = self.user_data.to_string_lossy().into_owned();
        let user_data = move || dir.clone();
        let store = create_recovery_store(
            RecoveryStoreOptions {
                user_data_dir: &user_data,
                now_ms: &now_ms,
                random_uuid: &random_uuid,
            },
            &shared,
        );
        f(&store)
    }

    /// `deleteCopy`; a copy left behind is offered again, never lost
    fn delete(&self, identity: &RecoveryIdentity, reason: RecoveryDeleteReason) {
        let _ = self.with(|s| s.delete_copy(identity, reason));
    }

    /// `recoveryStore.writeCopy(identity, bytes, { title, ticket })`, the part
    /// a worker runs
    pub fn write(
        &self,
        identity: &RecoveryIdentity,
        bytes: &[u8],
        title: String,
        ticket: RecoveryWriteTicket,
    ) -> Result<RecoveryWriteResult, String> {
        self.with(|s| {
            s.write_copy(
                identity,
                bytes,
                &RecoveryWriteOptions {
                    title: Some(title),
                    ticket: Some(ticket),
                    ..Default::default()
                },
            )
        })
        .map_err(|e| e.message)
    }
}

#[derive(Clone, Debug)]
struct Untitled {
    path: String,
    identity: RecoveryIdentity,
    title: String,
    save_as_default_path: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Decision {
    Restore,
    Original,
}

#[derive(Default)]
struct ViewRecovery {
    /// the path whose recovery question this view has answered
    resolved_path: Option<String>,
    /// the shell already decided for this path (launch list)
    decision: Option<(String, Decision)>,
    /// restored copy bytes for a path: what the view reads and saves start from
    restored: Option<(String, Arc<Vec<u8>>)>,
    unsaved_from_copy: bool,
    untitled: Option<Untitled>,
    /// the copy this view wrote or loaded ('closedClean' only deletes that one)
    owned_copy: Option<RecoveryIdentity>,
    dropped: bool,
    dropped_copy: Option<RecoveryIdentity>,
    /// the working file this module made for a restored untitled copy
    work_file: Option<String>,
    unprotectable: bool,
    source_encrypted: bool,
    notice_shown: bool,
    consumed: bool,
    crashed: bool,
}

/// A copy write between its start and its finish: the ticket taken before
/// serialization, so a save that deletes the copy meanwhile wins
pub(super) struct PendingCopy {
    pub identity: RecoveryIdentity,
    pub ticket: RecoveryWriteTicket,
    pub title: String,
}

/// `createPdfRecovery(deps)`
pub(super) struct Recovery {
    views: HashMap<ViewId, ViewRecovery>,
    pub store: Store,
    /// `deps.workDir()`
    work_dir: PathBuf,
}

impl Recovery {
    pub fn new(store: Store, work_dir: PathBuf) -> Self {
        Recovery {
            views: HashMap::new(),
            store,
            work_dir,
        }
    }

    fn view(&mut self, id: ViewId) -> &mut ViewRecovery {
        self.views.entry(id).or_default()
    }

    /// the identity this view's copies of `path` are written under;
    /// `untitled_copy` is `deps.isUntitledCopyPath(path)`
    fn identity_for(&mut self, id: ViewId, path: &str, untitled_copy: bool) -> RecoveryIdentity {
        let state = self.view(id);
        if let Some(u) = state.untitled.as_ref().filter(|u| u.path == path) {
            return u.identity.clone();
        }
        if untitled_copy {
            let identity = RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
                kind: "pdf".into(),
                untitled_id: new_untitled_recovery_id(&random_uuid),
                ext: ".pdf".into(),
            });
            state.untitled = Some(Untitled {
                path: path.to_owned(),
                identity: identity.clone(),
                title: basename(path, None),
                save_as_default_path: None,
            });
            return identity;
        }
        file_identity(path)
    }

    /// remove the view's working file once nothing reads it any more
    fn drop_work_file(state: &mut ViewRecovery, path: Option<&str>) {
        let Some(file) = state.work_file.as_deref() else {
            return;
        };
        if path.is_some_and(|p| p != file) {
            return;
        }
        let file = state.work_file.take().unwrap_or_default();
        if let Err(err) = std::fs::remove_file(&file)
            && err.kind() != std::io::ErrorKind::NotFound
        {
            eprintln!("[pdf] recovery working file not removed: {err}");
        }
    }

    fn clear_dropped(state: &mut ViewRecovery) {
        state.dropped = false;
        state.dropped_copy = None;
    }

    /// `resolvedNow(contents, path)`: true when `path` needs no question for
    /// this view (already answered, untitled, or no copy), which is recorded
    pub fn resolved_now(&mut self, id: ViewId, path: &str, untitled_copy: bool) -> bool {
        let store = self.store.clone();
        let state = self.view(id);
        if state.resolved_path.as_deref() == Some(path) {
            return true;
        }
        if state.decision.as_ref().is_some_and(|(p, _)| p == path) {
            return false;
        }
        let mut none = true;
        if state.untitled.as_ref().is_none_or(|u| u.path != path) && !untitled_copy {
            none = store
                .with(|s| s.open_plan(&file_identity(path)))
                .map_or(true, |plan| plan == RecoveryOpenPlan::None);
        }
        if none {
            state.resolved_path = Some(path.to_owned());
        }
        none
    }

    /// `resolveOnOpen(contents, path)`: the per-file question (or the shell's
    /// decision), answered before the renderer reads `path`
    pub fn resolve_on_open(
        &mut self,
        id: ViewId,
        path: &str,
        untitled_copy: bool,
        dialogs: &dyn Dialogs,
        parent: Option<WindowId>,
        lang: &str,
    ) {
        let store = self.store.clone();
        let state = self.view(id);
        state.consumed = true;
        if state.resolved_path.as_deref() == Some(path) {
            return;
        }
        if state.untitled.as_ref().is_some_and(|u| u.path == path) || untitled_copy {
            state.resolved_path = Some(path.to_owned());
            return;
        }
        let identity = file_identity(path);
        let decided = state
            .decision
            .take()
            .and_then(|(p, d)| (p == path).then_some(d));
        let bytes = store.with(|s| -> Result<Option<Vec<u8>>, String> {
            match decided {
                Some(Decision::Restore) => {
                    if s.open_plan(&identity).map_err(|e| e.message)? != RecoveryOpenPlan::None {
                        let bytes = s.read_copy(&identity);
                        if bytes.is_some() {
                            s.mark_copy_loaded(&identity).map_err(|e| e.message)?;
                        }
                        return Ok(bytes);
                    }
                    Ok(None)
                }
                Some(Decision::Original) => Ok(None),
                None => {
                    let parent = parent.map(Parent);
                    let answer = resolve_recovery_on_open(&ResolveRecoveryOnOpenOptions {
                        store: s,
                        identity: &identity,
                        dialog: &Boxes(dialogs),
                        parent: parent.as_ref(),
                        lang,
                        document_name: None,
                    })
                    .map_err(|e| e.message)?;
                    Ok(match answer {
                        RecoveryOpenResult::Restore { bytes, .. } => Some(bytes),
                        RecoveryOpenResult::Original => None,
                    })
                }
            }
        });
        let bytes = bytes.unwrap_or_else(|err| {
            // an unreadable copy is kept; the file opens as saved
            eprintln!("[pdf] recovery open failed: {err}");
            None
        });
        if let Some(bytes) = bytes {
            state.restored = Some((path.to_owned(), Arc::new(bytes)));
            state.unsaved_from_copy = true;
            state.owned_copy = Some(identity);
        }
        state.resolved_path = Some(path.to_owned());
    }

    pub fn mark_consumed(&mut self, id: ViewId) {
        self.view(id).consumed = true;
    }

    pub fn has_consumed(&self, id: ViewId) -> bool {
        self.views.get(&id).is_some_and(|s| s.consumed)
    }

    /// `setDecision(id, path, decision)`: the shell decided before the view reads
    pub fn set_decision(&mut self, id: ViewId, path: &str, decision: Decision) {
        let state = self.view(id);
        Self::clear_dropped(state);
        state.source_encrypted = false;
        state.decision = Some((path.to_owned(), decision));
        if state.resolved_path.as_deref() == Some(path) {
            state.resolved_path = None;
        }
        state.restored = None;
        state.unsaved_from_copy = false;
    }

    /// `viewBytes(id, path)`
    pub fn view_bytes(&self, id: ViewId, path: &str) -> Option<Arc<Vec<u8>>> {
        self.views
            .get(&id)?
            .restored
            .as_ref()
            .filter(|(p, _)| p == path)
            .map(|(_, b)| Arc::clone(b))
    }

    pub fn unsaved_from_copy(&self, id: ViewId, path: &str) -> bool {
        let Some(state) = self.views.get(&id) else {
            return false;
        };
        state.unsaved_from_copy
            && (state.restored.as_ref().is_some_and(|(p, _)| p == path)
                || state.untitled.as_ref().is_some_and(|u| u.path == path))
    }

    /// `writeCopy` up to the serialization: `Err` is the answer without
    /// serializing
    pub fn begin_copy(
        &mut self,
        id: ViewId,
        path: &str,
        untitled_copy: bool,
    ) -> Result<PendingCopy, CopyResult> {
        let state = self.view(id);
        if state.dropped {
            return Err(CopyResult::Superseded);
        }
        if state.unprotectable || state.source_encrypted {
            return Err(CopyResult::Skipped);
        }
        if state.resolved_path.as_deref() != Some(path) {
            return Err(CopyResult::Skipped);
        }
        let identity = self.identity_for(id, path, untitled_copy);
        let ticket = self
            .store
            .with(|s| s.begin_write(&identity))
            .map_err(|err| {
                eprintln!("[pdf] recovery copy failed: {}", err.message);
                CopyResult::Failed
            })?;
        let state = self.view(id);
        let title = match &state.untitled {
            Some(u) if u.path == path => u.title.clone(),
            _ => basename(path, None),
        };
        Ok(PendingCopy {
            identity,
            ticket,
            title,
        })
    }

    /// `writeCopy` after serialization: `None` bytes = the document turned
    /// out encrypted. `Ok(pending)` hands the copy to write to a worker.
    pub fn serialized(&mut self, id: ViewId, bytes_ok: bool) -> Result<(), CopyResult> {
        let state = self.view(id);
        if !bytes_ok {
            state.source_encrypted = true;
            return Err(CopyResult::Skipped);
        }
        if state.dropped {
            return Err(CopyResult::Superseded);
        }
        Ok(())
    }

    /// what the store answered for a copy this view wrote
    pub fn copy_landed(
        &mut self,
        id: ViewId,
        identity: RecoveryIdentity,
        result: Result<RecoveryWriteResult, String>,
    ) -> CopyResult {
        match result {
            Ok(RecoveryWriteResult::Written) => {
                self.view(id).owned_copy = Some(identity);
                CopyResult::Written
            }
            Ok(RecoveryWriteResult::Superseded) => CopyResult::Superseded,
            Err(err) => {
                eprintln!("[pdf] recovery copy failed: {err}");
                CopyResult::Failed
            }
        }
    }

    /// `savedInPlace` of a file document, or the start of an untitled one's
    /// refresh: `Some` is the copy to write from the bytes now on disk
    pub fn saved_in_place(&mut self, id: ViewId, path: &str) -> Option<PendingCopy> {
        let store = self.store.clone();
        let state = self.view(id);
        if state.restored.as_ref().is_some_and(|(p, _)| p == path) {
            state.restored = None;
        }
        state.unsaved_from_copy = false;
        if let Some(u) = state.untitled.as_ref().filter(|u| u.path == path) {
            if state.unprotectable {
                return None;
            }
            let identity = u.identity.clone();
            let title = u.title.clone();
            return match store.with(|s| s.begin_write(&identity)) {
                Ok(ticket) => Some(PendingCopy {
                    identity,
                    ticket,
                    title,
                }),
                Err(err) => {
                    eprintln!("[pdf] recovery copy failed: {}", err.message);
                    None
                }
            };
        }
        let identity = file_identity(path);
        store.delete(&identity, RecoveryDeleteReason::Saved);
        if state
            .owned_copy
            .as_ref()
            .is_some_and(|o| same_identity(o, &identity))
        {
            state.owned_copy = None;
        }
        None
    }

    /// `adopted(id, oldPath, target)`: an untitled document went to `target`
    pub fn adopted(&mut self, id: ViewId, old_path: &str, target: &str) {
        let store = self.store.clone();
        let state = self.view(id);
        if let Some(u) = state.untitled.take_if(|u| u.path == old_path) {
            store.delete(&u.identity, RecoveryDeleteReason::Saved);
            if state
                .owned_copy
                .as_ref()
                .is_some_and(|o| same_identity(o, &u.identity))
            {
                state.owned_copy = None;
            }
        }
        Self::drop_work_file(state, Some(old_path));
        state.unsaved_from_copy = false;
        state.restored = None;
        state.resolved_path = Some(target.to_owned());
    }

    /// `movedToNewFile`: a clean view wrote a redacted or signed copy and shows it
    pub fn moved_to_new_file(&mut self, id: ViewId, old_path: &str, target: &str) {
        let store = self.store.clone();
        let Some(state) = self.views.get_mut(&id) else {
            return;
        };
        let untitled_identity = state
            .untitled
            .as_ref()
            .filter(|u| u.path == old_path)
            .map(|u| u.identity.clone());
        if let Some(owned) = state.owned_copy.clone() {
            if untitled_identity
                .as_ref()
                .is_some_and(|u| same_identity(&owned, u))
            {
                store.delete(&owned, RecoveryDeleteReason::Saved);
                state.owned_copy = None;
            } else if is_file_of(&owned, old_path) {
                store.delete(&owned, RecoveryDeleteReason::ClosedClean);
                state.owned_copy = None;
            }
        }
        if untitled_identity.is_some() {
            state.untitled = None;
        }
        Self::drop_work_file(state, Some(old_path));
        if state.restored.as_ref().is_some_and(|(p, _)| p == old_path) {
            state.restored = None;
        }
        state.unsaved_from_copy = false;
        state.resolved_path = Some(target.to_owned());
    }

    /// `discardedForDisk`: the person reloads `path` from disk
    pub fn discarded_for_disk(&mut self, id: ViewId, path: &str) {
        let store = self.store.clone();
        let Some(state) = self.views.get_mut(&id) else {
            return;
        };
        if state.untitled.as_ref().is_some_and(|u| u.path == path) {
            return;
        }
        if state.restored.as_ref().is_some_and(|(p, _)| p == path) {
            state.restored = None;
        }
        state.unsaved_from_copy = false;
        if let Some(owned) = state.owned_copy.clone().filter(|o| is_file_of(o, path)) {
            store.delete(&owned, RecoveryDeleteReason::ClosedClean);
            state.owned_copy = None;
        }
    }

    pub fn save_as_default_path(&self, id: ViewId, path: &str) -> Option<String> {
        let u = self.views.get(&id)?.untitled.as_ref()?;
        if u.path == path {
            u.save_as_default_path.clone()
        } else {
            None
        }
    }

    /// `dontSave(id, path)`
    pub fn dont_save(&mut self, id: ViewId, path: Option<&str>, untitled_copy: bool) {
        let identity = path.map(|p| self.identity_for(id, p, untitled_copy));
        let store = self.store.clone();
        let state = self.view(id);
        state.dropped = true;
        state.dropped_copy = identity.or_else(|| state.owned_copy.clone());
        if let Some(copy) = &state.dropped_copy {
            store.delete(copy, RecoveryDeleteReason::DontSave);
        }
        state.owned_copy = None;
    }

    /// `closeCancelled(id)`: true when the view had been dropped
    pub fn close_cancelled(&mut self, id: ViewId) -> bool {
        let store = self.store.clone();
        let Some(state) = self.views.get_mut(&id).filter(|s| s.dropped) else {
            return false;
        };
        if let Some(dropped) = &state.dropped_copy {
            let _ = store.with(|s| s.clear_discarded(dropped));
        }
        Self::clear_dropped(state);
        true
    }

    /// `renamed(id, oldPath, newPath)`: the copy and the restore follow
    pub fn renamed(&mut self, id: ViewId, old_path: &str, new_path: &str) {
        let store = self.store.clone();
        let Some(state) = self.views.get_mut(&id) else {
            return;
        };
        if state.resolved_path.as_deref() == Some(old_path) {
            state.resolved_path = Some(new_path.to_owned());
        }
        if let Some((p, _)) = state.restored.as_mut().filter(|(p, _)| p == old_path) {
            *p = new_path.to_owned();
        }
        let Some(owned) = state.owned_copy.clone().filter(|o| is_file_of(o, old_path)) else {
            return;
        };
        let next = file_identity(new_path);
        let moved = store.with(|s| -> Result<bool, String> {
            let Some(bytes) = s.read_copy(&owned) else {
                return Ok(false);
            };
            let written = s
                .write_copy(
                    &next,
                    &bytes,
                    &RecoveryWriteOptions {
                        title: Some(basename(new_path, None)),
                        ..Default::default()
                    },
                )
                .map_err(|e| e.message)?;
            if written == RecoveryWriteResult::Written {
                s.delete_copy(&owned, RecoveryDeleteReason::Discarded)
                    .map_err(|e| e.message)?;
                return Ok(true);
            }
            Ok(false)
        });
        match moved {
            Ok(true) => state.owned_copy = Some(next),
            Ok(false) => {}
            Err(err) => eprintln!("[pdf] recovery copy move failed: {err}"),
        }
    }

    /// `openUntitled(id, request)`: the copy's bytes become a working file
    /// the view opens as an untitled document; `None` when unreadable
    pub fn open_untitled(
        &mut self,
        id: ViewId,
        copy: &RecoveryIdentity,
        title: &str,
        save_as_default_path: Option<&str>,
    ) -> Result<Option<String>, String> {
        if copy.kind() != "pdf" {
            return Ok(None);
        }
        let Some(bytes) = self.store.with(|s| s.read_copy(copy)) else {
            return Ok(None);
        };
        std::fs::create_dir_all(&self.work_dir).map_err(|e| e.to_string())?;
        let dir = self.work_dir.to_string_lossy().into_owned();
        let path = join(&[&dir, &format!("{}.pdf", random_uuid())]);
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        self.store
            .with(|s| s.mark_copy_loaded(copy))
            .map_err(|e| e.message)?;
        let state = self.view(id);
        Self::clear_dropped(state);
        state.source_encrypted = false;
        Self::drop_work_file(state, None);
        state.work_file = Some(path.clone());
        state.untitled = Some(Untitled {
            path: path.clone(),
            identity: copy.clone(),
            title: title.to_owned(),
            save_as_default_path: save_as_default_path
                .filter(|p| !p.is_empty())
                .map(str::to_owned),
        });
        state.restored = None;
        state.unsaved_from_copy = true;
        state.owned_copy = Some(copy.clone());
        state.resolved_path = Some(path.clone());
        Ok(Some(path))
    }

    /// `reportUnprotectable(id, unprotectable)`: the one-time notice, or none
    pub fn report_unprotectable(
        &mut self,
        id: ViewId,
        unprotectable: bool,
        lang: &str,
    ) -> Option<String> {
        let state = self.view(id);
        state.unprotectable = unprotectable;
        if !(unprotectable || state.source_encrypted) || state.notice_shown {
            return None;
        }
        state.notice_shown = true;
        Some(unprotectable_notice_text(lang))
    }

    pub fn is_unprotectable(&self, id: ViewId) -> bool {
        self.views
            .get(&id)
            .is_some_and(|s| s.unprotectable || s.source_encrypted)
    }

    pub fn untitled_identity(&self, id: ViewId) -> Option<RecoveryIdentity> {
        Some(self.views.get(&id)?.untitled.as_ref()?.identity.clone())
    }

    pub fn mark_crashed(&mut self, id: ViewId) {
        self.view(id).crashed = true;
    }

    /// `destroyed(id, dirty)`: the view is gone
    pub fn destroyed(&mut self, id: ViewId, dirty: bool) {
        let Some(mut state) = self.views.remove(&id) else {
            return;
        };
        Self::drop_work_file(&mut state, None);
        if state.dropped {
            if let Some(copy) = &state.dropped_copy {
                self.store.delete(copy, RecoveryDeleteReason::DontSave);
            }
            return;
        }
        if let Some(owned) = state
            .owned_copy
            .as_ref()
            .filter(|_| !dirty && !state.crashed)
        {
            self.store.delete(owned, RecoveryDeleteReason::ClosedClean);
        }
    }

    /// `sweepWorkFiles(maxAge)`: working files a crash left behind, only in
    /// the working folder, only older than `max_age`, never one in use
    pub fn sweep_work_files(&self, max_age: Duration) {
        let Ok(entries) = std::fs::read_dir(&self.work_dir) else {
            return;
        };
        let in_use: Vec<&str> = self
            .views
            .values()
            .filter_map(|s| s.work_file.as_deref())
            .collect();
        let cutoff = SystemTime::now().checked_sub(max_age).unwrap_or(UNIX_EPOCH);
        for entry in entries.flatten() {
            let file = entry.path();
            if in_use.iter().any(|u| Path::new(u) == file) {
                continue;
            }
            let Ok(info) = std::fs::symlink_metadata(&file) else {
                continue;
            };
            if !info.is_file() || info.modified().is_ok_and(|m| m > cutoff) {
                continue;
            }
            let _ = std::fs::remove_file(&file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::pdf_looks_encrypted;

    #[test]
    fn encrypt_name_counts_only_as_a_whole_token() {
        assert!(pdf_looks_encrypted(b"trailer << /Encrypt 5 0 R >>"));
        assert!(pdf_looks_encrypted(b"<</Encrypt/x>>"));
        assert!(pdf_looks_encrypted(b"/Encrypt"));
        assert!(!pdf_looks_encrypted(b"/EncryptMetadata false"));
        assert!(!pdf_looks_encrypted(b"plain"));
    }
}
