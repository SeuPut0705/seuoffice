//! `packages/electron-utils/src/recovery-contract.ts`: what every editor main
//! promises the shell about crash recovery, and the table the shell looks
//! editors up in.
//!
//! The TypeScript keeps the table on `globalThis` behind a `Symbol.for` key
//! so bundled copies share it; here the table is an explicit
//! [`RecoveryRegistry`] the caller owns. `C` stands for Electron's
//! `WebContents`: the contract's methods take a reference to one. The
//! promises of `writeCopiesNow` and the open methods are plain calls.

use std::rc::Rc;

use super::recovery_store::{RecoveryEditorKind, RecoveryIdentity};

/// `RecoveryOpenFileRequest.decision`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryOpenDecision {
    /// load the copy's bytes; the original path stays the tab's path
    Restore,
    /// load the file as saved, without asking
    Original,
}

/// open a file tab whose recovery question is already answered
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryOpenFileRequest {
    pub file_path: String,
    pub decision: RecoveryOpenDecision,
}

/// open a copy as an untitled tab
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryOpenUntitledRequest {
    /// the copy to load: an untitled copy, or a file copy whose original is missing
    pub copy: RecoveryIdentity,
    /// tab title to show
    pub title: String,
    /// first Save As suggestion, set when the original file could not be found
    pub save_as_default_path: Option<String>,
}

/// `RecoveryEditorContract`
pub trait RecoveryEditorContract<C> {
    fn kind(&self) -> &str;
    /// The OS is ending the session: write a copy for every document with
    /// unsaved changes right now, without any prompt. Never fails.
    fn write_copies_now(&self);
    /// load `request.file_path` into `contents` (a tab the shell created)
    fn open_file_with_decision(&self, contents: &C, request: &RecoveryOpenFileRequest);
    /// Load a copy into `contents` as an untitled tab.
    fn open_untitled_copy(&self, contents: &C, request: &RecoveryOpenUntitledRequest);
    /// Whether the document in this tab cannot get a safe copy.
    fn is_unprotectable(&self, contents: &C) -> bool;
}

/// `registry()`: a `Map` from kind to contract, in the order of first registration.
pub struct RecoveryRegistry<C> {
    table: Vec<(RecoveryEditorKind, Rc<dyn RecoveryEditorContract<C>>)>,
}

impl<C> Default for RecoveryRegistry<C> {
    fn default() -> Self {
        RecoveryRegistry { table: Vec::new() }
    }
}

/// The function `registerRecoveryEditor` returns: hand it to
/// [`RecoveryRegistry::unregister`].
pub struct RecoveryRegistration<C> {
    contract: Rc<dyn RecoveryEditorContract<C>>,
}

impl<C> RecoveryRegistry<C> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register an editor's contract (a later registration of the same kind
    /// replaces the earlier one and keeps its place in the order).
    pub fn register_recovery_editor(
        &mut self,
        contract: Rc<dyn RecoveryEditorContract<C>>,
    ) -> RecoveryRegistration<C> {
        let kind = contract.kind().to_owned();
        match self.table.iter_mut().find(|(k, _)| *k == kind) {
            Some(entry) => entry.1 = Rc::clone(&contract),
            None => self.table.push((kind, Rc::clone(&contract))),
        }
        RecoveryRegistration { contract }
    }

    /// The unregister function: removes the contract unless a newer
    /// registration has replaced it meanwhile.
    pub fn unregister(&mut self, registration: &RecoveryRegistration<C>) {
        let kind = registration.contract.kind();
        let current = self.table.iter().position(|(k, _)| k == kind);
        if let Some(at) = current
            && Rc::ptr_eq(&self.table[at].1, &registration.contract)
        {
            self.table.remove(at);
        }
    }

    pub fn recovery_editor(&self, kind: &str) -> Option<Rc<dyn RecoveryEditorContract<C>>> {
        self.table
            .iter()
            .find(|(k, _)| k == kind)
            .map(|(_, contract)| Rc::clone(contract))
    }

    pub fn recovery_editors(&self) -> Vec<Rc<dyn RecoveryEditorContract<C>>> {
        self.table
            .iter()
            .map(|(_, contract)| Rc::clone(contract))
            .collect()
    }
}
