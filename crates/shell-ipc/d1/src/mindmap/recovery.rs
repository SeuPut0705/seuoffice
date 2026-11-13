//! `recovery-main.ts`: the crash-recovery copies of mind maps, per view.
//! The renderer hands over the bytes a save would write; they go through the
//! shared recovery store into `<userData>/mindmap-autosave`. Each view
//! remembers which copies are its own, and only those go when its map is
//! saved, dropped with "Don't Save" or closed without unsaved changes.

use std::cell::RefMut;
use std::fs;

use main_core::node_fs::NodeError;
use main_core::packages::electron_utils::recovery_contract::{
    RecoveryOpenDecision, RecoveryOpenUntitledRequest,
};
use main_core::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, ResolveRecoveryOnOpenOptions, resolve_recovery_on_open,
};
use main_core::packages::electron_utils::recovery_store::{
    RecoveryCopyState, RecoveryDeleteReason, RecoveryDeleteResult, RecoveryFileIdentity,
    RecoveryIdentity, RecoveryStore, RecoveryStoreOptions, RecoveryUntitledIdentity,
    RecoveryWriteOptions, RecoveryWriteResult, create_recovery_store, is_untitled_identity,
    new_untitled_recovery_id,
};
use shell_contract::{ViewId, WindowId};

use super::app::{DONT_SAVE_HOLD, HostBox, MAP_EXTENSION, MindmapApp, TimerJob, Win, now_ms};

const KIND: &str = "mindmap";

/// What the TypeScript's `ViewRecovery` keeps for one view
#[derive(Default)]
pub(super) struct ViewRecovery {
    /// the copy an untitled view writes: its own untitled id's, made at its
    /// first copy, or the copy it was restored from
    pub untitled_copy: Option<RecoveryIdentity>,
    /// this view's copies, by copy path, in the order they became its own
    pub owned: Vec<(String, RecoveryIdentity)>,
    /// the first Save As suggestion of a restored map whose file is gone
    pub save_as_default: Option<String>,
    /// the tab title a restored untitled copy came with
    pub title: Option<String>,
    /// what the shell already decided for the file this view opens next
    pub decision: Option<RecoveryOpenDecision>,
    /// the renderer crashed: its copies outlive the view
    pub crashed: bool,
    /// "Don't Save" dropped the copies: none is taken until this hold ends
    /// (the generation of the hold's timer)
    pub dropped: Option<u64>,
    /// the copy left for the file could not be settled: no copy may replace it
    pub blocked: bool,
}

pub(super) fn file_identity(path: &str) -> RecoveryIdentity {
    RecoveryIdentity::File(RecoveryFileIdentity {
        kind: KIND.to_owned(),
        file_path: path.to_owned(),
    })
}

impl MindmapApp {
    /// `stateOf(wcId)`
    pub(super) fn recovery_of(&self, view: ViewId) -> RefMut<'_, ViewRecovery> {
        RefMut::map(self.0.state.borrow_mut(), |state| {
            state.recovery.entry(view).or_default()
        })
    }

    /// Runs `f` over the shared store; never call this inside `f`
    fn with_store<R>(&self, f: impl FnOnce(&RecoveryStore<'_>) -> R) -> R {
        let shared = self.recovery_state();
        let user_data = || self.user_data_dir();
        let now = now_ms;
        let uuid = jscompat::random_uuid;
        let store = create_recovery_store(
            RecoveryStoreOptions {
                user_data_dir: &user_data,
                now_ms: &now,
                random_uuid: &uuid,
            },
            &shared,
        );
        f(&store)
    }

    /// `viewRecoveryIdentity`: the copy a view writes now: its file's, or
    /// (untitled) its own id's, made on first use
    pub(super) fn view_recovery_identity(
        &self,
        view: ViewId,
        save_path: Option<&str>,
    ) -> RecoveryIdentity {
        if let Some(path) = save_path.filter(|p| !p.is_empty()) {
            return file_identity(path);
        }
        self.recovery_of(view)
            .untitled_copy
            .get_or_insert_with(|| {
                RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
                    kind: KIND.to_owned(),
                    untitled_id: new_untitled_recovery_id(&jscompat::random_uuid),
                    ext: MAP_EXTENSION.to_owned(),
                })
            })
            .clone()
    }

    fn own_key(&self, view: ViewId, key: String, identity: RecoveryIdentity) {
        let mut recovery = self.recovery_of(view);
        match recovery.owned.iter_mut().find(|(k, _)| *k == key) {
            Some(entry) => entry.1 = identity,
            None => recovery.owned.push((key, identity)),
        }
    }

    fn own(&self, view: ViewId, identity: &RecoveryIdentity) {
        if let Ok(key) = self.with_store(|store| store.copy_path(identity)) {
            self.own_key(view, key, identity.clone());
        }
    }

    /// An untitled view keeps writing to the copy it was restored from
    fn adopt_untitled_copy(&self, view: ViewId, identity: &RecoveryIdentity) {
        self.recovery_of(view).untitled_copy = Some(identity.clone());
        self.own(view, identity);
    }

    /// Whether another live view holds this copy (the same map open in two panes)
    fn owned_elsewhere(&self, view: ViewId, identity: &RecoveryIdentity) -> bool {
        let Ok(key) = self.with_store(|store| store.copy_path(identity)) else {
            return false;
        };
        self.0.state.borrow().recovery.iter().any(|(other, state)| {
            *other != view && !state.crashed && state.owned.iter().any(|(k, _)| *k == key)
        })
    }

    /// `writeViewCopy`: keep `bytes` as the view's copy. The copy counts as
    /// the view's own before it is written. `Superseded` while "Don't Save"
    /// holds, or when the copy left for the file could not be settled. An
    /// `Err` is a disk error (the renderer backs off).
    pub(super) fn write_view_copy(
        &self,
        view: ViewId,
        save_path: Option<&str>,
        bytes: &[u8],
        untitled_title: impl FnOnce() -> String,
    ) -> Result<RecoveryWriteResult, NodeError> {
        {
            let state = self.0.state.borrow();
            if let Some(barred) = state.recovery.get(&view)
                && (barred.dropped.is_some() || barred.blocked)
            {
                return Ok(RecoveryWriteResult::Superseded);
            }
        }
        let identity = self.view_recovery_identity(view, save_path);
        self.own(view, &identity);
        let title = if is_untitled_identity(&identity) {
            let existing = self.recovery_of(view).title.clone();
            Some(existing.unwrap_or_else(untitled_title))
        } else {
            None
        };
        self.with_store(|store| {
            store.write_copy(
                &identity,
                bytes,
                &RecoveryWriteOptions {
                    title,
                    ..RecoveryWriteOptions::default()
                },
            )
        })
    }

    /// `deleteOwned`: delete the view's copies. `forget` false keeps them
    /// listed as the view's own, so a copy landing at the same place later
    /// is still taken along.
    fn delete_owned(&self, view: ViewId, reason: RecoveryDeleteReason, forget: bool) {
        let owned = match self.0.state.borrow().recovery.get(&view) {
            Some(recovery) => recovery.owned.clone(),
            None => return,
        };
        let deleted: Vec<String> = self.with_store(|store| {
            owned
                .iter()
                .filter(|(_, identity)| {
                    matches!(
                        store.delete_copy(identity, reason),
                        Ok(RecoveryDeleteResult::Deleted)
                    )
                })
                .map(|(key, _)| key.clone())
                .collect()
        });
        if forget && let Some(recovery) = self.0.state.borrow_mut().recovery.get_mut(&view) {
            recovery.owned.retain(|(key, _)| !deleted.contains(key));
        }
    }

    /// `viewSaved`: the view's map reached the disk: its copies go, and it is no longer untitled
    pub(super) fn view_saved(&self, view: ViewId) {
        self.delete_owned(view, RecoveryDeleteReason::Saved, true);
        if let Some(recovery) = self.0.state.borrow_mut().recovery.get_mut(&view) {
            recovery.untitled_copy = None;
            recovery.save_as_default = None;
            recovery.title = None;
        }
    }

    /// `viewDropped`: "Don't Save" (the close prompt, or a tool closing the
    /// map without saving): the copies go, and no new one is taken while the
    /// tab closes. When the tab is still there after the hold, its renderer
    /// is asked for a fresh copy (`copyAgain`).
    pub(super) fn view_dropped(&self, view: ViewId) {
        self.delete_owned(view, RecoveryDeleteReason::DontSave, false);
        let gen_id = self.new_gen();
        self.recovery_of(view).dropped = Some(gen_id);
        self.schedule(DONT_SAVE_HOLD, TimerJob::DropHold(view, gen_id));
    }

    /// the hold of `view_dropped` ended
    pub(super) fn drop_hold_ended(&self, view: ViewId, gen_id: u64) {
        {
            let mut state = self.0.state.borrow_mut();
            match state.recovery.get_mut(&view) {
                Some(recovery) if recovery.dropped == Some(gen_id) => recovery.dropped = None,
                _ => return,
            }
        }
        // the tab stayed open: its unsaved changes need a copy again
        if self.is_alive(view) {
            self.emit(view, "mindmap:recovery-reset", vec![]);
        }
    }

    /// `viewGone(wcId, dirty)`: closed after "Don't Save", the view takes
    /// along any copy that landed meanwhile; closed without unsaved changes,
    /// it takes its copies with it; with unsaved changes, after a crash or
    /// while the app is ending, they stay
    pub(super) fn recovery_view_gone(&self, view: ViewId, dirty: bool) {
        let (dropped, crashed, known) = match self.0.state.borrow().recovery.get(&view) {
            Some(recovery) => (recovery.dropped.is_some(), recovery.crashed, true),
            None => (false, false, false),
        };
        if dropped {
            self.delete_owned(view, RecoveryDeleteReason::DontSave, true);
        } else if known && !crashed && !dirty {
            self.delete_owned(view, RecoveryDeleteReason::ClosedClean, true);
        }
        self.0.state.borrow_mut().recovery.remove(&view);
    }

    /// `viewSaveAsDefault`: first Save As suggestion of a restored map whose file is gone
    pub(super) fn view_save_as_default(&self, view: ViewId) -> Option<String> {
        self.0
            .state
            .borrow()
            .recovery
            .get(&view)
            .and_then(|recovery| recovery.save_as_default.clone())
    }

    /// `setViewOpenDecision`: the shell decided the recovery question for the
    /// file this view opens next
    pub(super) fn set_view_open_decision(&self, view: ViewId, decision: RecoveryOpenDecision) {
        self.recovery_of(view).decision = Some(decision);
    }

    /// `resolveViewOpen`: before a file's content is loaded, the copy's
    /// bytes when the map is to be restored, `None` to open the file as
    /// saved. The shell's decision is taken as it is; otherwise "restore"
    /// chosen in the launch list restores without asking, and an undecided
    /// or "later" copy asks first. A copy another pane is working on is not
    /// asked about. When the copy cannot be settled the file opens as saved
    /// and the view writes no copy over the old one.
    pub(super) fn resolve_view_open(
        &self,
        view: ViewId,
        path: &str,
        parent: Option<WindowId>,
    ) -> Option<Vec<u8>> {
        let decision = {
            let mut recovery = self.recovery_of(view);
            let decision = recovery.decision.take();
            recovery.blocked = false;
            decision
        };
        if decision == Some(RecoveryOpenDecision::Original) {
            return None;
        }
        let identity = file_identity(path);
        if self.owned_elsewhere(view, &identity) {
            return None;
        }
        let lang = self.lang();
        let dialog = HostBox(&*self.0.dialogs);
        let parent = parent.map(Win);
        let settled = self.with_store(|store| -> Result<Option<Vec<u8>>, NodeError> {
            if decision == Some(RecoveryOpenDecision::Restore)
                && store.copy_info(&identity)?.is_some()
            {
                store.set_copy_state(&identity, RecoveryCopyState::RestoreChosen)?;
            }
            let result = resolve_recovery_on_open(&ResolveRecoveryOnOpenOptions {
                store,
                identity: &identity,
                dialog: &dialog,
                parent: parent.as_ref(),
                lang: lang.as_str(),
                document_name: None,
            })?;
            Ok(match result {
                RecoveryOpenResult::Restore { bytes, .. } => Some(bytes),
                RecoveryOpenResult::Original => None,
            })
        });
        match settled {
            Ok(Some(bytes)) => {
                self.own(view, &identity);
                Some(bytes)
            }
            Ok(None) => None,
            Err(_) => {
                // the old copy stays as it is; this view writes none over it
                self.recovery_of(view).blocked = true;
                None
            }
        }
    }

    /// `viewRestoredUntitled`: a copy of `path` was restored, but the file is
    /// gone or no longer opens: the map is untitled now, its first Save As
    /// offers the old place, and its later copies replace the restored one
    pub(super) fn view_restored_untitled(&self, view: ViewId, path: &str) {
        self.adopt_untitled_copy(view, &file_identity(path));
        self.recovery_of(view).save_as_default = Some(path.to_owned());
    }

    /// `takeUntitledCopy`: a copy to open in this (untitled) view: its bytes,
    /// read now so they can be queued before the renderer asks
    pub(super) fn take_untitled_copy(
        &self,
        view: ViewId,
        request: &RecoveryOpenUntitledRequest,
    ) -> Option<Vec<u8>> {
        let bytes = self.with_store(|store| {
            let bytes = fs::read(store.copy_path(&request.copy).ok()?).ok()?;
            let _ = store.mark_copy_loaded(&request.copy);
            Some(bytes)
        })?;
        self.adopt_untitled_copy(view, &request.copy);
        let mut recovery = self.recovery_of(view);
        recovery.title = Some(request.title.clone());
        if let Some(path) = request
            .save_as_default_path
            .as_ref()
            .filter(|p| !p.is_empty())
        {
            recovery.save_as_default = Some(path.clone());
        }
        Some(bytes)
    }

    /// `viewFileRenamed`: the view's file was renamed on disk: its copy follows the new path
    pub(super) fn view_file_renamed(&self, view: ViewId, old_path: &str, new_path: &str) {
        let from = file_identity(old_path);
        let Ok(from_key) = self.with_store(|store| store.copy_path(&from)) else {
            return;
        };
        let held = self
            .0
            .state
            .borrow()
            .recovery
            .get(&view)
            .is_some_and(|recovery| recovery.owned.iter().any(|(key, _)| *key == from_key));
        if !held {
            return;
        }
        if let Some(bytes) = self.with_store(|store| store.read_copy(&from)) {
            let to = file_identity(new_path);
            if let Ok(to_key) = self.with_store(|store| store.copy_path(&to)) {
                self.own_key(view, to_key, to.clone());
            }
            let written = self.with_store(|store| {
                store.write_copy(&to, &bytes, &RecoveryWriteOptions::default())
            });
            if written.is_err() {
                return;
            }
        }
        // the content now lives under the new path; the old entry would only offer it twice
        let deleted = self.with_store(|store| {
            matches!(
                store.delete_copy(&from, RecoveryDeleteReason::Discarded),
                Ok(RecoveryDeleteResult::Deleted)
            )
        });
        if deleted && let Some(recovery) = self.0.state.borrow_mut().recovery.get_mut(&view) {
            recovery.owned.retain(|(key, _)| *key != from_key);
        }
    }
}
