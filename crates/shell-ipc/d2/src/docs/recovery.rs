//! `apps/docs/src/main/docs-recovery.ts`: which crash-recovery copy each tab
//! writes and when a copy goes, over the shared store of `main-core`. The
//! store is made per use from the process's one `SharedRecoveryState`
//! ([`with_store`]); the TypeScript's per-tab maps are [`RecoveryBook`].
//!
//! `writeCopy` is split where the TypeScript awaits: [`RecoveryBook::begin_copy`]
//! takes the ticket on the core thread, the bytes are prepared and written on
//! a worker ([`write_copy`]), and [`RecoveryBook::copy_written`] does the
//! bookkeeping back on the core thread.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use main_core::node_fs::NodeError;
use main_core::packages::electron_utils::recovery_store::{
    RecoveryAdoptOptions, RecoveryCopyState, RecoveryDeleteReason, RecoveryDeleteResult,
    RecoveryFileIdentity, RecoveryIdentity, RecoveryStore, RecoveryStoreOptions,
    RecoveryUntitledIdentity, RecoveryWriteOptions, RecoveryWriteResult, RecoveryWriteTicket,
    SharedRecoveryState, create_recovery_store, new_untitled_recovery_id,
};
use shell_contract::ViewId;

pub(crate) type SharedRecovery = Arc<Mutex<SharedRecoveryState>>;

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0)
}

/// `createRecoveryStore({ userDataDir })` for one use
pub(crate) fn with_store<R>(
    shared: &SharedRecovery,
    user_data: &str,
    f: impl FnOnce(&RecoveryStore) -> R,
) -> R {
    let state = shared.lock().unwrap_or_else(|e| e.into_inner());
    let dir = || user_data.to_owned();
    let uuid = jscompat::random_uuid;
    let store = create_recovery_store(
        RecoveryStoreOptions {
            user_data_dir: &dir,
            now_ms: &now_ms,
            random_uuid: &uuid,
        },
        &state,
    );
    f(&store)
}

/// `DocsCloseOutcome`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Clean,
    Saved,
    DontSave,
}

pub(crate) fn file_identity(path: &str) -> RecoveryIdentity {
    RecoveryIdentity::File(RecoveryFileIdentity {
        kind: "docs".into(),
        file_path: path.to_owned(),
    })
}

/// `DocsCopyTarget`
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum CopyTarget {
    File(String),
    Untitled(&'static str),
}

/// A copy write between its ticket and its bytes
pub(crate) struct PendingCopy {
    pub identity: RecoveryIdentity,
    pub ticket: RecoveryWriteTicket,
}

/// `pathsByTab`, `untitledByTab`, `outcomes` of `createDocsRecovery`
#[derive(Default)]
pub(crate) struct RecoveryBook {
    paths_by_tab: HashMap<ViewId, HashSet<String>>,
    untitled_by_tab: HashMap<ViewId, RecoveryUntitledIdentity>,
    outcomes: HashMap<ViewId, Outcome>,
}

fn deleted(r: Result<RecoveryDeleteResult, NodeError>) -> bool {
    matches!(r, Ok(RecoveryDeleteResult::Deleted))
}

impl RecoveryBook {
    fn untitled_for(
        &mut self,
        store: &RecoveryStore,
        tab: ViewId,
        ext: &str,
    ) -> RecoveryUntitledIdentity {
        if let Some(current) = self.untitled_by_tab.get(&tab) {
            if current.ext == ext {
                return current.clone();
            }
            // another untitled document took this tab: its slot holds nothing it shows
            let _ = store.delete_copy(
                &RecoveryIdentity::Untitled(current.clone()),
                RecoveryDeleteReason::ClosedClean,
            );
        }
        let next = RecoveryUntitledIdentity {
            kind: "docs".into(),
            untitled_id: new_untitled_recovery_id(&jscompat::random_uuid),
            ext: ext.to_owned(),
        };
        self.untitled_by_tab.insert(tab, next.clone());
        next
    }

    fn drop_untitled(&mut self, store: &RecoveryStore, tab: ViewId, reason: RecoveryDeleteReason) {
        let Some(untitled) = self.untitled_by_tab.get(&tab).cloned() else {
            return;
        };
        // "Don't Save" keeps the slot: the store blocks it until the close is cancelled
        if deleted(store.delete_copy(&RecoveryIdentity::Untitled(untitled), reason))
            && reason != RecoveryDeleteReason::DontSave
        {
            self.untitled_by_tab.remove(&tab);
        }
    }

    fn drop_tab_copies(
        &mut self,
        store: &RecoveryStore,
        tab: ViewId,
        reason: RecoveryDeleteReason,
    ) {
        if let Some(paths) = self.paths_by_tab.get_mut(&tab) {
            paths.retain(|p| !deleted(store.delete_copy(&file_identity(p), reason)));
        }
        self.drop_untitled(store, tab, reason);
    }

    /// `writeCopy` up to the ticket
    pub fn begin_copy(
        &mut self,
        store: &RecoveryStore,
        tab: ViewId,
        target: &CopyTarget,
    ) -> Result<PendingCopy, NodeError> {
        let identity = match target {
            CopyTarget::File(path) => file_identity(path),
            CopyTarget::Untitled(ext) => {
                RecoveryIdentity::Untitled(self.untitled_for(store, tab, ext))
            }
        };
        let ticket = store.begin_write(&identity)?;
        Ok(PendingCopy { identity, ticket })
    }

    /// `writeCopy` after the copy was written
    pub fn copy_written(
        &mut self,
        store: &RecoveryStore,
        tab: ViewId,
        identity: &RecoveryIdentity,
        original_path: Option<&str>,
    ) {
        match identity {
            RecoveryIdentity::Untitled(_) => {
                // a docx copy of an ODT tab is newer than the ODT copy it wrote before
                if let Some(original) = original_path
                    && deleted(
                        store.delete_copy(&file_identity(original), RecoveryDeleteReason::Saved),
                    )
                    && let Some(paths) = self.paths_by_tab.get_mut(&tab)
                {
                    paths.remove(original);
                }
            }
            RecoveryIdentity::File(file) => {
                self.paths_by_tab
                    .entry(tab)
                    .or_default()
                    .insert(file.file_path.clone());
                // the tab writes its file's copy again: the docx copy it wrote while marked is stale
                if let Some(slot) = self.untitled_by_tab.get(&tab).cloned()
                    && store
                        .copy_info(&RecoveryIdentity::Untitled(slot))
                        .ok()
                        .flatten()
                        .and_then(|i| i.original_path)
                        .as_deref()
                        == Some(file.file_path.as_str())
                {
                    self.drop_untitled(store, tab, RecoveryDeleteReason::Saved);
                }
            }
        }
        // a copy means unsaved changes: an earlier "clean" answer no longer holds
        if self.outcomes.get(&tab) == Some(&Outcome::Clean) {
            self.outcomes.remove(&tab);
        }
    }

    /// `noteSaved(tabId, paths)`
    pub fn note_saved(&mut self, store: &RecoveryStore, tab: ViewId, paths: &[&str]) {
        for p in paths {
            let _ = store.delete_copy(&file_identity(p), RecoveryDeleteReason::Saved);
        }
        self.drop_untitled(store, tab, RecoveryDeleteReason::Saved);
    }

    /// `noteCloseCheck(tabId, dirty)`
    pub fn note_close_check(&mut self, tab: ViewId, dirty: bool) {
        if dirty {
            self.outcomes.remove(&tab);
        } else {
            self.outcomes.insert(tab, Outcome::Clean);
        }
    }

    /// `discard(tabId, filePath)`
    pub fn discard(&mut self, store: &RecoveryStore, tab: ViewId, path: Option<&str>) {
        self.outcomes.insert(tab, Outcome::DontSave);
        if let Some(p) = path.filter(|p| !p.is_empty()) {
            let _ = store.delete_copy(&file_identity(p), RecoveryDeleteReason::DontSave);
        }
        self.drop_untitled(store, tab, RecoveryDeleteReason::DontSave);
    }

    /// `noteClosedSaved(tabId)`
    pub fn note_closed_saved(&mut self, tab: ViewId) {
        self.outcomes.insert(tab, Outcome::Saved);
    }

    /// `abandon(tabId, filePath)`: the copies stay, set aside as "later"
    pub fn abandon(&mut self, store: &RecoveryStore, tab: ViewId, path: Option<&str>) {
        self.outcomes.remove(&tab);
        let mut paths: Vec<String> = self
            .paths_by_tab
            .get(&tab)
            .into_iter()
            .flatten()
            .cloned()
            .collect();
        if let Some(p) = path.filter(|p| !p.is_empty())
            && !paths.iter().any(|q| q == p)
        {
            paths.push(p.to_owned());
        }
        for p in paths {
            let _ = store.set_copy_state(&file_identity(&p), RecoveryCopyState::Later);
        }
        if let Some(u) = self.untitled_by_tab.get(&tab) {
            let _ = store.set_copy_state(
                &RecoveryIdentity::Untitled(u.clone()),
                RecoveryCopyState::Later,
            );
        }
    }

    /// `noteStillOpen(tabId)`
    pub fn note_still_open(&mut self, tab: ViewId) {
        if self.outcomes.get(&tab) == Some(&Outcome::DontSave) {
            self.outcomes.remove(&tab);
        }
    }

    /// `settleClosedDocument(tabId, crashed)`
    pub fn settle_closed(&mut self, store: &RecoveryStore, tab: ViewId, crashed: bool) {
        if !crashed && let Some(outcome) = self.outcomes.get(&tab).copied() {
            let reason = match outcome {
                Outcome::Clean => RecoveryDeleteReason::ClosedClean,
                Outcome::Saved => RecoveryDeleteReason::Saved,
                Outcome::DontSave => RecoveryDeleteReason::DontSave,
            };
            self.drop_tab_copies(store, tab, reason);
        }
        self.paths_by_tab.remove(&tab);
        self.untitled_by_tab.remove(&tab);
        self.outcomes.remove(&tab);
    }

    /// `takeUntitledCopy(tabId, copy, { title, ext, accept })`
    pub fn take_untitled_copy(
        &mut self,
        store: &RecoveryStore,
        tab: ViewId,
        copy: &RecoveryIdentity,
        title: &str,
        ext: &str,
        accept: impl FnOnce(&[u8]) -> bool,
    ) -> Option<(Vec<u8>, RecoveryUntitledIdentity)> {
        let bytes = store.read_copy(copy)?;
        if !accept(&bytes) {
            return None;
        }
        let identity = match copy {
            RecoveryIdentity::Untitled(u) => u.clone(),
            RecoveryIdentity::File(_) => store
                .adopt_untitled_copy(
                    "docs",
                    &store.copy_path(copy).ok()?,
                    &RecoveryAdoptOptions {
                        title: title.to_owned(),
                        ext: ext.to_owned(),
                        state: Some(RecoveryCopyState::Undecided),
                        original_path: None,
                    },
                )
                .ok()
                .flatten()?,
        };
        if let Some(previous) = self.untitled_by_tab.get(&tab)
            && previous.untitled_id != identity.untitled_id
        {
            let _ = store.delete_copy(
                &RecoveryIdentity::Untitled(previous.clone()),
                RecoveryDeleteReason::ClosedClean,
            );
        }
        self.untitled_by_tab.insert(tab, identity.clone());
        let _ = store.mark_copy_loaded(&RecoveryIdentity::Untitled(identity.clone()));
        Some((bytes, identity))
    }

    /// `untitledOf(tabId)`
    pub fn untitled_of(&self, tab: ViewId) -> Option<RecoveryUntitledIdentity> {
        self.untitled_by_tab.get(&tab).cloned()
    }
}

/// What a copy write came to
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CopyResult {
    Written,
    Skipped,
}

/// The worker half of `writeCopy`: the bytes, then the store's write with
/// the ticket taken before. `Err` is a disk error (the renderer backs off).
pub(crate) fn write_copy(
    shared: &SharedRecovery,
    user_data: &str,
    pending: &PendingCopy,
    bytes: Option<Vec<u8>>,
    title: String,
    original_path: Option<String>,
) -> Result<CopyResult, NodeError> {
    let Some(bytes) = bytes else {
        return Ok(CopyResult::Skipped);
    };
    let result = with_store(shared, user_data, |store| {
        store.write_copy(
            &pending.identity,
            &bytes,
            &RecoveryWriteOptions {
                title: Some(title),
                ticket: Some(pending.ticket.clone()),
                original_path,
                formulas_dropped: None,
            },
        )
    })?;
    Ok(if result == RecoveryWriteResult::Written {
        CopyResult::Written
    } else {
        CopyResult::Skipped
    })
}
