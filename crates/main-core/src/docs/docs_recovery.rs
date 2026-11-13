//! `apps/docs/src/main/docs-recovery.ts`: crash-recovery bookkeeping of the
//! Word editor on top of the shared recovery store.
//!
//! What moved: every judgment of `createDocsRecovery`, as a [`DocsRecovery`]
//! the caller owns, one method per function the closure returned. The
//! per-tab maps (`pathsByTab`, `untitledByTab`, `outcomes`) are its state.
//!
//! What stays with the caller: the one [`RecoveryStore`] (`createDocsRecovery`
//! took it as an argument and so does [`DocsRecovery::new`]), the process's
//! [`HeadlessMode`] and the random source behind `crypto.randomUUID`; the
//! dialog and the parent window of `resolveOpen`, which are a
//! [`MessageBox`](crate::packages::electron_utils::message_box::MessageBox)
//! and a `ParentWindow` like everywhere else; and what a copy's bytes are
//! (`prepare` and `accept` are the caller's closures; the docx engine that
//! serializes a document is engine-waiting).
//!
//! Promises are plain calls. The write ticket of `write_copy` is taken before
//! `prepare` runs, as in the TypeScript, and every method takes `&self`, so a
//! `prepare` that calls [`DocsRecovery::note_saved`] or
//! [`DocsRecovery::discard`] is the save that lands while the bytes are made.

use std::cell::RefCell;

use jscompat::node_path::host::basename;
use jscompat::{JsMap, truthy};

use crate::node_fs::NodeError;
use crate::packages::electron_utils::headless_mode::HeadlessMode;
use crate::packages::electron_utils::message_box::{MessageBox, ParentWindow};
use crate::packages::electron_utils::recovery_contract::RecoveryOpenDecision;
use crate::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, ResolveRecoveryOnOpenOptions, resolve_recovery_on_open,
};
use crate::packages::electron_utils::recovery_store::{
    RecoveryAdoptOptions, RecoveryCopyInfo, RecoveryCopyState, RecoveryDeleteReason,
    RecoveryDeleteResult, RecoveryFileIdentity, RecoveryIdentity, RecoveryStore,
    RecoveryUntitledIdentity, RecoveryWriteOptions, RecoveryWriteResult, new_untitled_recovery_id,
};

/// how the last close check of a tab ended
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocsCloseOutcome {
    Clean,
    Saved,
    DontSave,
}

/// the format an untitled document's copy is written in
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocsUntitledExt {
    Docx,
    Odt,
}

impl DocsUntitledExt {
    pub fn as_str(self) -> &'static str {
        match self {
            DocsUntitledExt::Docx => ".docx",
            DocsUntitledExt::Odt => ".odt",
        }
    }
}

/// `DocsCopyTarget`: the copy a tab writes, its file's or its untitled document's
#[derive(Debug, Clone, PartialEq)]
pub enum DocsCopyTarget {
    File(String),
    Untitled(DocsUntitledExt),
}

/// `DocsOpenRecovery`: what the opening of a file decided
#[derive(Debug, Clone, PartialEq)]
pub enum DocsOpenRecovery {
    Original,
    Restore {
        bytes: Vec<u8>,
        copy: Option<RecoveryCopyInfo>,
    },
}

/// what `writeCopy` answered
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocsWriteResult {
    Written,
    Skipped,
}

/// `resolveOpen`'s options
pub struct DocsResolveOpenOptions<'a, D, W> {
    pub file_path: &'a str,
    /// a launch-list decision passed by the shell
    pub decision: Option<RecoveryOpenDecision>,
    pub dialog: &'a D,
    pub parent: Option<&'a W>,
    pub lang: &'a str,
}

/// `takeUntitledCopy`'s options
pub struct TakeUntitledOptions<'a> {
    pub title: &'a str,
    pub ext: DocsUntitledExt,
    /// refuses a copy's bytes (an encrypted copy without its file cannot be opened)
    pub accept: &'a dyn Fn(&[u8]) -> bool,
}

/// what `takeUntitledCopy` answers
#[derive(Debug, Clone, PartialEq)]
pub struct TakenCopy {
    pub bytes: Vec<u8>,
    pub identity: RecoveryUntitledIdentity,
}

/// `createDocsRecovery(store)`
pub struct DocsRecovery<'s> {
    store: &'s RecoveryStore<'s>,
    headless: &'s HeadlessMode,
    /// `crypto.randomUUID()`, for an untitled document's copy id
    random_uuid: &'s dyn Fn() -> String,
    /// file copies each tab wrote, by path
    paths_by_tab: RefCell<JsMap<Vec<String>>>,
    /// each tab's untitled document copy
    untitled_by_tab: RefCell<JsMap<RecoveryUntitledIdentity>>,
    outcomes: RefCell<JsMap<DocsCloseOutcome>>,
}

fn key(tab_id: i64) -> String {
    tab_id.to_string()
}

impl<'s> DocsRecovery<'s> {
    pub fn new(
        store: &'s RecoveryStore<'s>,
        headless: &'s HeadlessMode,
        random_uuid: &'s dyn Fn() -> String,
    ) -> Self {
        DocsRecovery {
            store,
            headless,
            random_uuid,
            paths_by_tab: RefCell::new(JsMap::new()),
            untitled_by_tab: RefCell::new(JsMap::new()),
            outcomes: RefCell::new(JsMap::new()),
        }
    }

    /// `recovery.store`
    pub fn store(&self) -> &'s RecoveryStore<'s> {
        self.store
    }

    pub fn file_identity(&self, file_path: &str) -> RecoveryFileIdentity {
        RecoveryFileIdentity {
            kind: "docs".to_owned(),
            file_path: file_path.to_owned(),
        }
    }

    fn file_copy(&self, file_path: &str) -> RecoveryIdentity {
        RecoveryIdentity::File(self.file_identity(file_path))
    }

    fn untitled_for(
        &self,
        tab_id: i64,
        ext: DocsUntitledExt,
    ) -> Result<RecoveryUntitledIdentity, NodeError> {
        let current = self.untitled_by_tab.borrow().get(&key(tab_id)).cloned();
        if let Some(current) = &current
            && current.ext == ext.as_str()
        {
            return Ok(current.clone());
        }
        // another untitled document took this tab (its close was settled by the
        // replace prompt): the earlier slot holds nothing this tab still shows
        if let Some(current) = current {
            self.store.delete_copy(
                &RecoveryIdentity::Untitled(current),
                RecoveryDeleteReason::ClosedClean,
            )?;
        }
        let next = RecoveryUntitledIdentity {
            kind: "docs".to_owned(),
            untitled_id: new_untitled_recovery_id(self.random_uuid),
            ext: ext.as_str().to_owned(),
        };
        self.untitled_by_tab
            .borrow_mut()
            .set(key(tab_id), next.clone());
        Ok(next)
    }

    fn drop_untitled(&self, tab_id: i64, reason: RecoveryDeleteReason) -> Result<(), NodeError> {
        let untitled = self.untitled_by_tab.borrow().get(&key(tab_id)).cloned();
        let Some(untitled) = untitled else {
            return Ok(());
        };
        // "Don't Save" keeps the slot: the store blocks it until the close is
        // cancelled, and a fresh slot would let the dropped edits back in
        let result = self
            .store
            .delete_copy(&RecoveryIdentity::Untitled(untitled), reason)?;
        if result == RecoveryDeleteResult::Deleted && reason != RecoveryDeleteReason::DontSave {
            self.untitled_by_tab.borrow_mut().delete(&key(tab_id));
        }
        Ok(())
    }

    fn forget_path(&self, tab_id: i64, file_path: &str) {
        if let Some(paths) = self.paths_by_tab.borrow_mut().get_mut(&key(tab_id)) {
            paths.retain(|path| path != file_path);
        }
    }

    fn drop_tab_copies(&self, tab_id: i64, reason: RecoveryDeleteReason) -> Result<(), NodeError> {
        let paths = self
            .paths_by_tab
            .borrow()
            .get(&key(tab_id))
            .cloned()
            .unwrap_or_default();
        for file_path in paths {
            let result = self
                .store
                .delete_copy(&self.file_copy(&file_path), reason)?;
            if result == RecoveryDeleteResult::Deleted {
                self.forget_path(tab_id, &file_path);
            }
        }
        self.drop_untitled(tab_id, reason)
    }

    /// Write the tab's copy. The write ticket is taken before `prepare` runs,
    /// so a save (or "Don't Save") that lands meanwhile wins and nothing is
    /// left on disk. Answering `None` skips this tick. `original_path`: an
    /// untitled copy's file of origin (a marked ODT tab's docx copy), offered
    /// as its first Save As. An `Err` is a rejection (a disk error, or what
    /// `prepare` threw): the caller backs off.
    pub fn write_copy(
        &self,
        tab_id: i64,
        target: &DocsCopyTarget,
        prepare: &mut dyn FnMut() -> Result<Option<Vec<u8>>, NodeError>,
        title: &str,
        original_path: Option<&str>,
    ) -> Result<DocsWriteResult, NodeError> {
        // a headless export's hidden window converts the file and goes; it keeps no copy
        if self.headless.is_headless_mode() {
            return Ok(DocsWriteResult::Skipped);
        }
        let identity = match target {
            DocsCopyTarget::File(file_path) => self.file_copy(file_path),
            DocsCopyTarget::Untitled(ext) => {
                RecoveryIdentity::Untitled(self.untitled_for(tab_id, *ext)?)
            }
        };
        let ticket = self.store.begin_write(&identity)?;
        let Some(bytes) = prepare()? else {
            return Ok(DocsWriteResult::Skipped);
        };
        let options = RecoveryWriteOptions {
            title: Some(title.to_owned()),
            ticket: Some(ticket),
            original_path: truthy(original_path).map(str::to_owned),
            ..RecoveryWriteOptions::default()
        };
        let result = self.store.write_copy(&identity, &bytes, &options)?;
        if result != RecoveryWriteResult::Written {
            return Ok(DocsWriteResult::Skipped);
        }
        match &identity {
            RecoveryIdentity::Untitled(_) => {
                // a docx copy of an ODT tab (marked content) is newer than any ODT copy
                // the tab wrote before its content was marked: that one must not be
                // offered again beside it
                if let Some(original) = truthy(original_path) {
                    let deleted = self
                        .store
                        .delete_copy(&self.file_copy(original), RecoveryDeleteReason::Saved)?;
                    if deleted == RecoveryDeleteResult::Deleted {
                        self.forget_path(tab_id, original);
                    }
                }
            }
            RecoveryIdentity::File(file) => {
                {
                    let mut by_tab = self.paths_by_tab.borrow_mut();
                    match by_tab.get_mut(&key(tab_id)) {
                        Some(paths) => {
                            if !paths.contains(&file.file_path) {
                                paths.push(file.file_path.clone());
                            }
                        }
                        None => by_tab.set(key(tab_id), vec![file.file_path.clone()]),
                    }
                }
                // the tab writes its file's copy again (its marks are gone): the docx
                // copy it wrote while marked is stale
                let slot = self.untitled_by_tab.borrow().get(&key(tab_id)).cloned();
                if let Some(slot) = slot {
                    let info = self.store.copy_info(&RecoveryIdentity::Untitled(slot))?;
                    if info.and_then(|info| info.original_path).as_deref()
                        == Some(file.file_path.as_str())
                    {
                        self.drop_untitled(tab_id, RecoveryDeleteReason::Saved)?;
                    }
                }
            }
        }
        // a copy means unsaved changes: an earlier "clean" answer no longer holds
        let clean =
            self.outcomes.borrow().get(&key(tab_id)).copied() == Some(DocsCloseOutcome::Clean);
        if clean {
            self.outcomes.borrow_mut().delete(&key(tab_id));
        }
        Ok(DocsWriteResult::Written)
    }

    /// A save of this tab landed. `paths`: the file copies it makes stale (the
    /// saved path, and the path the tab's document had before, when the save
    /// moved it). The tab's untitled copy always goes too: after any save the
    /// document has a file, and an untitled write that crossed the first save
    /// would otherwise stay behind as an orphan.
    pub fn note_saved(&self, tab_id: i64, paths: &[String]) -> Result<(), NodeError> {
        for file_path in paths {
            self.store
                .delete_copy(&self.file_copy(file_path), RecoveryDeleteReason::Saved)?;
        }
        self.drop_untitled(tab_id, RecoveryDeleteReason::Saved)
    }

    /// the close check answered: a clean tab may drop its own copies when it closes
    pub fn note_close_check(&self, tab_id: i64, dirty: bool) {
        if dirty {
            self.outcomes.borrow_mut().delete(&key(tab_id));
        } else {
            self.outcomes
                .borrow_mut()
                .set(key(tab_id), DocsCloseOutcome::Clean);
        }
    }

    /// The user (or an MCP/AI close) dropped the tab's unsaved changes: delete
    /// the copy of `file_path` and the tab's untitled copy now, and again at
    /// teardown (a write may still be in flight).
    pub fn discard(&self, tab_id: i64, file_path: Option<&str>) -> Result<(), NodeError> {
        self.outcomes
            .borrow_mut()
            .set(key(tab_id), DocsCloseOutcome::DontSave);
        if let Some(file_path) = truthy(file_path) {
            self.store
                .delete_copy(&self.file_copy(file_path), RecoveryDeleteReason::DontSave)?;
        }
        self.drop_untitled(tab_id, RecoveryDeleteReason::DontSave)
    }

    /// the close prompt's Save went through
    pub fn note_closed_saved(&self, tab_id: i64) {
        self.outcomes
            .borrow_mut()
            .set(key(tab_id), DocsCloseOutcome::Saved);
    }

    /// The tab closes without its renderer's answer ("Close Anyway" on a hung
    /// tab): its copies are the only record of its edits, so they stay, set
    /// aside as "later" instead of being dropped like "Don't Save".
    /// `file_path`: the tab's file, whose copy it may have loaded without
    /// rewriting it.
    pub fn abandon(&self, tab_id: i64, file_path: Option<&str>) -> Result<(), NodeError> {
        // no outcome: the teardown keeps every copy, like a crashed tab's
        self.outcomes.borrow_mut().delete(&key(tab_id));
        let mut paths = self
            .paths_by_tab
            .borrow()
            .get(&key(tab_id))
            .cloned()
            .unwrap_or_default();
        if let Some(file_path) = truthy(file_path)
            && !paths.iter().any(|path| path == file_path)
        {
            paths.push(file_path.to_owned());
        }
        for path in &paths {
            self.store
                .set_copy_state(&self.file_copy(path), RecoveryCopyState::Later)?;
        }
        let untitled = self.untitled_by_tab.borrow().get(&key(tab_id)).cloned();
        if let Some(untitled) = untitled {
            self.store.set_copy_state(
                &RecoveryIdentity::Untitled(untitled),
                RecoveryCopyState::Later,
            )?;
        }
        Ok(())
    }

    /// The tab is still open (the OS is ending the session and asked it for a
    /// copy): a "Don't Save" answered before a cancelled quit no longer holds,
    /// so its teardown keeps the copies.
    pub fn note_still_open(&self, tab_id: i64) {
        let dont_save =
            self.outcomes.borrow().get(&key(tab_id)).copied() == Some(DocsCloseOutcome::DontSave);
        if dont_save {
            self.outcomes.borrow_mut().delete(&key(tab_id));
        }
    }

    /// The restored copy of `file_path` could not be loaded and the file
    /// opened instead: no tab holds the copy, so it waits as "later" for the
    /// next open of the file rather than staying undecided.
    pub fn restore_failed(&self, file_path: &str) -> Result<(), NodeError> {
        self.store
            .set_copy_state(&self.file_copy(file_path), RecoveryCopyState::Later)?;
        Ok(())
    }

    /// The tab's document is closed (the tab torn down, or another document
    /// replaced it after the close prompt): settle the copies the tab wrote by
    /// how that close was decided, then forget them.
    pub fn settle_closed_document(&self, tab_id: i64, crashed: bool) -> Result<(), NodeError> {
        let outcome = self.outcomes.borrow().get(&key(tab_id)).copied();
        // crashed: its last copies are what the shell reopens. Undecided (the tab
        // closed without a close check, e.g. a quit): keep them, nothing is lost.
        if !crashed && let Some(outcome) = outcome {
            let reason = match outcome {
                DocsCloseOutcome::Clean => RecoveryDeleteReason::ClosedClean,
                DocsCloseOutcome::Saved => RecoveryDeleteReason::Saved,
                DocsCloseOutcome::DontSave => RecoveryDeleteReason::DontSave,
            };
            self.drop_tab_copies(tab_id, reason)?;
        }
        self.paths_by_tab.borrow_mut().delete(&key(tab_id));
        self.untitled_by_tab.borrow_mut().delete(&key(tab_id));
        self.outcomes.borrow_mut().delete(&key(tab_id));
        Ok(())
    }

    /// Opening `file_path`: decide between the copy and the file. A
    /// launch-list decision passed by the shell wins; a "restore" already
    /// chosen restores without asking; otherwise the named per-file prompt
    /// asks (Esc/close = restore, "the file changed after" line when the file
    /// is newer).
    pub fn resolve_open<D, W>(
        &self,
        options: &DocsResolveOpenOptions<'_, D, W>,
    ) -> Result<DocsOpenRecovery, NodeError>
    where
        D: MessageBox<W>,
        W: ParentWindow,
    {
        // a headless export converts the file on disk: no one is there to answer the
        // prompt (whose Esc restores), and a copy it neither uses nor settles stays as it was
        if self.headless.is_headless_mode() {
            return Ok(DocsOpenRecovery::Original);
        }
        let identity = self.file_copy(options.file_path);
        // the file is being opened: what it shows from now on was not thrown
        // away by an earlier "Don't Save", so its copies are written again
        self.store.clear_discarded(&identity)?;
        match options.decision {
            Some(RecoveryOpenDecision::Original) => return Ok(DocsOpenRecovery::Original),
            Some(RecoveryOpenDecision::Restore) => {
                let Some(bytes) = self.store.read_copy(&identity) else {
                    return Ok(DocsOpenRecovery::Original);
                };
                let copy = self.store.copy_info(&identity)?;
                self.store.mark_copy_loaded(&identity)?;
                return Ok(DocsOpenRecovery::Restore { bytes, copy });
            }
            None => {}
        }
        let document_name = basename(options.file_path, None);
        let result = resolve_recovery_on_open(&ResolveRecoveryOnOpenOptions {
            store: self.store,
            identity: &identity,
            dialog: options.dialog,
            parent: options.parent,
            lang: options.lang,
            document_name: Some(document_name.as_str()),
        })?;
        Ok(match result {
            RecoveryOpenResult::Restore { bytes, copy } => DocsOpenRecovery::Restore {
                bytes,
                copy: Some(*copy),
            },
            RecoveryOpenResult::Original => DocsOpenRecovery::Original,
        })
    }

    /// Load a copy into an untitled tab: an untitled copy keeps its slot (the
    /// tab goes on writing to it), a file copy whose original is missing moves
    /// into a new untitled slot. `None` when the copy is gone, unreadable, or
    /// `accept` refuses its bytes.
    pub fn take_untitled_copy(
        &self,
        tab_id: i64,
        copy: &RecoveryIdentity,
        options: &TakeUntitledOptions<'_>,
    ) -> Result<Option<TakenCopy>, NodeError> {
        let Some(bytes) = self.store.read_copy(copy) else {
            return Ok(None);
        };
        if !(options.accept)(&bytes) {
            return Ok(None);
        }
        let identity = match copy {
            RecoveryIdentity::Untitled(untitled) => untitled.clone(),
            RecoveryIdentity::File(_) => {
                // the original is gone: the copy becomes this untitled tab's own
                let source = self.store.copy_path(copy)?;
                let adopted = self.store.adopt_untitled_copy(
                    "docs",
                    &source,
                    &RecoveryAdoptOptions {
                        title: options.title.to_owned(),
                        ext: options.ext.as_str().to_owned(),
                        state: Some(RecoveryCopyState::Undecided),
                        original_path: None,
                    },
                )?;
                match adopted {
                    Some(identity) => identity,
                    None => return Ok(None),
                }
            }
        };
        let previous = self.untitled_by_tab.borrow().get(&key(tab_id)).cloned();
        if let Some(previous) = previous
            && previous.untitled_id != identity.untitled_id
        {
            self.store.delete_copy(
                &RecoveryIdentity::Untitled(previous),
                RecoveryDeleteReason::ClosedClean,
            )?;
        }
        self.untitled_by_tab
            .borrow_mut()
            .set(key(tab_id), identity.clone());
        self.store
            .mark_copy_loaded(&RecoveryIdentity::Untitled(identity.clone()))?;
        Ok(Some(TakenCopy { bytes, identity }))
    }

    /// the untitled copy this tab writes to, if any
    pub fn untitled_of(&self, tab_id: i64) -> Option<RecoveryUntitledIdentity> {
        self.untitled_by_tab.borrow().get(&key(tab_id)).cloned()
    }
}
