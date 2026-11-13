//! `recovery-main.ts`: crash-recovery copies of diagrams. The renderer makes
//! a copy's bytes (what a save would write now); they go through the shared
//! recovery store into `<userData>/diagram-autosave`. Each view remembers
//! which copies are its own: those, and only those, go when its diagram is
//! saved, dropped with "Don't Save" or closed without unsaved changes.

use std::time::Duration;

use main_core::node_fs::NodeError;
use main_core::packages::electron_utils::message_box::{
    MessageBox, MessageBoxOptions, ParentWindow,
};
use main_core::packages::electron_utils::recovery_contract::RecoveryOpenUntitledRequest;
use main_core::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, ResolveRecoveryOnOpenOptions, resolve_recovery_on_open,
};
use main_core::packages::electron_utils::recovery_store::{
    RecoveryDeleteReason, RecoveryDeleteResult, RecoveryFileIdentity, RecoveryIdentity,
    RecoveryUntitledIdentity, RecoveryWriteOptions, RecoveryWriteResult, is_recovery_editor_kind,
    is_untitled_identity, new_untitled_recovery_id,
};
use shell_contract::hosts::{Dialogs, MessageBox as HostMessageBox};
use shell_contract::{ViewId, WindowId};

use super::DiagramViews;
use super::state::Decision;

const KIND: &str = "diagram";
const UNTITLED_EXTENSION: &str = ".drawio";

/// After "Don't Save" the tab normally closes at once. After this long the
/// renderer is asked for a copy again (`DONT_SAVE_HOLD_MS`).
pub const DONT_SAVE_HOLD: Duration = Duration::from_millis(5_000);

/// A window a message box sits over (`ParentWindow` for `main-core`)
pub(super) struct Parent(pub WindowId);

impl ParentWindow for Parent {
    fn is_destroyed(&self) -> bool {
        false
    }
}

/// Electron's `dialog.showMessageBox` over the shell's [`Dialogs`] host, as
/// `main-core` asks for it
pub(super) struct BoxDialog<'a>(pub &'a dyn Dialogs);

impl BoxDialog<'_> {
    fn ask(&self, parent: Option<WindowId>, options: &MessageBoxOptions) -> f64 {
        let options = HostMessageBox {
            kind: Some(options.kind.to_owned()),
            title: options.title.clone(),
            message: options.message.clone(),
            detail: options.detail.clone(),
            buttons: options.buttons.clone(),
            default_id: Some(options.default_id as usize),
            cancel_id: options.cancel_id.map(|id| id as usize),
            checkbox_label: None,
        };
        self.0.message(parent, &options).response as f64
    }
}

impl MessageBox<Parent> for BoxDialog<'_> {
    fn show_message_box_over(&self, parent: &Parent, options: &MessageBoxOptions) -> f64 {
        self.ask(Some(parent.0), options)
    }

    fn show_message_box(&self, options: &MessageBoxOptions) -> f64 {
        self.ask(None, options)
    }
}

pub(super) fn file_identity(path: &str) -> RecoveryIdentity {
    RecoveryIdentity::File(RecoveryFileIdentity {
        kind: KIND.to_owned(),
        file_path: path.to_owned(),
    })
}

/// `String(err)` of a store error
pub(super) fn node_message(error: NodeError) -> String {
    error.message
}

impl DiagramViews {
    /// `recoveryAvailable()`
    fn recovery_available(&self) -> bool {
        is_recovery_editor_kind(KIND)
    }

    /// `viewRecoveryIdentity(wcId, savePath)`: the copy a view writes now: its
    /// file's, or (untitled) its own id's, made on first use
    pub(super) fn view_recovery_identity(
        &self,
        view: ViewId,
        save_path: Option<&str>,
    ) -> RecoveryIdentity {
        if let Some(path) = save_path.filter(|p| !p.is_empty()) {
            return file_identity(path);
        }
        self.with_state(|state| {
            state
                .recovery_of(view)
                .untitled_copy
                .get_or_insert_with(|| {
                    RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
                        kind: KIND.to_owned(),
                        untitled_id: new_untitled_recovery_id(&jscompat::random_uuid),
                        ext: UNTITLED_EXTENSION.to_owned(),
                    })
                })
                .clone()
        })
    }

    /// `own(wcId, identity)`
    fn own(&self, view: ViewId, identity: &RecoveryIdentity) {
        let key = self.with_store(|store| store.copy_path(identity).unwrap_or_default());
        self.with_state(|state| {
            state.recovery_of(view).owned.insert(key, identity.clone());
        });
    }

    /// `adoptUntitledCopy(wcId, identity)`: an untitled view keeps writing to
    /// the copy it was restored from
    fn adopt_untitled_copy(&self, view: ViewId, identity: &RecoveryIdentity) {
        self.with_state(|state| state.recovery_of(view).untitled_copy = Some(identity.clone()));
        self.own(view, identity);
    }

    /// `ownedElsewhere(wcId, identity)`: another live view holds this copy
    fn owned_elsewhere(&self, view: ViewId, identity: &RecoveryIdentity) -> bool {
        let key = self.with_store(|store| store.copy_path(identity).unwrap_or_default());
        self.with_state(|state| {
            state
                .recovery
                .iter()
                .any(|(other, v)| *other != view && !v.crashed && v.owned.contains_key(&key))
        })
    }

    /// `writeViewCopy(wcId, savePath, bytes, untitledTitle)`: keep `bytes` as
    /// the view's copy. The copy counts as the view's own before it is
    /// written. `Superseded` while "Don't Save" holds, or when the copy left
    /// for the file could not be settled. `Err` on a disk error.
    pub(super) fn write_view_copy(
        &self,
        view: ViewId,
        save_path: Option<&str>,
        bytes: &[u8],
        untitled_title: impl FnOnce() -> String,
    ) -> Result<RecoveryWriteResult, NodeError> {
        let barred = self.with_state(|state| {
            state
                .recovery
                .get(&view)
                .is_some_and(|v| v.dropped.is_some() || v.blocked)
        });
        // a headless export's hidden view converts the file and goes; it keeps no copy
        if self.0.shell.is_headless() || !self.recovery_available() || barred {
            return Ok(RecoveryWriteResult::Superseded);
        }
        let identity = self.view_recovery_identity(view, save_path);
        self.own(view, &identity);
        let title = if is_untitled_identity(&identity) {
            Some(
                match self.with_state(|state| state.recovery_of(view).title.clone()) {
                    Some(title) => title,
                    None => untitled_title(),
                },
            )
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

    /// `deleteOwned(wcId, reason, forget)`: delete the view's copies. `forget`
    /// false keeps them listed as the view's own.
    fn delete_owned(&self, view: ViewId, reason: RecoveryDeleteReason, forget: bool) {
        let owned: Vec<(String, RecoveryIdentity)> = self.with_state(|state| {
            state.recovery.get(&view).map_or_else(Vec::new, |v| {
                v.owned
                    .iter()
                    .map(|(k, i)| (k.clone(), i.clone()))
                    .collect()
            })
        });
        for (key, identity) in owned {
            let deleted = self.with_store(|store| store.delete_copy(&identity, reason));
            if matches!(deleted, Ok(RecoveryDeleteResult::Deleted)) && forget {
                self.with_state(|state| {
                    if let Some(v) = state.recovery.get_mut(&view) {
                        v.owned.remove(&key);
                    }
                });
            }
        }
    }

    /// `viewSaved(wcId)`: the diagram reached the disk; its copies go, and it
    /// is no longer untitled
    pub(super) fn view_saved(&self, view: ViewId) {
        self.delete_owned(view, RecoveryDeleteReason::Saved, true);
        self.with_state(|state| {
            if let Some(v) = state.recovery.get_mut(&view) {
                v.untitled_copy = None;
                v.save_as_default = None;
                v.title = None;
            }
        });
    }

    /// `viewDropped(wcId, copyAgain)`: "Don't Save" (the close prompt, or a
    /// tool closing the diagram without saving): the copies go, and no new one
    /// is taken while the tab closes. When the tab is still there after the
    /// hold, its renderer is asked for a fresh copy.
    pub(super) fn view_dropped(&self, view: ViewId) {
        self.delete_owned(view, RecoveryDeleteReason::DontSave, false);
        let generation = self.with_state(|state| {
            let generation = state.next_generation();
            state.recovery_of(view).dropped = Some(generation);
            generation
        });
        self.after(DONT_SAVE_HOLD, move |views| {
            let held = views.with_state(|state| match state.recovery.get_mut(&view) {
                Some(v) if v.dropped == Some(generation) => {
                    v.dropped = None;
                    true
                }
                _ => false,
            });
            // the tab stayed open: its unsaved changes need a copy again
            if held && views.alive(view) {
                views.emit(view, "diagram:recovery-reset", vec![]);
            }
        });
    }

    /// `viewCrashed(wcId)`: the renderer crashed; its copies outlive the view
    pub fn view_crashed(&self, view: ViewId) {
        self.with_state(|state| state.recovery_of(view).crashed = true);
    }

    /// `viewGone(wcId, dirty)`. Closed after "Don't Save", the view takes
    /// along any copy that landed meanwhile; closed without unsaved changes,
    /// it takes its copies with it; with unsaved changes, after a crash or
    /// while the app is ending, they stay.
    pub(super) fn recovery_view_gone(&self, view: ViewId, dirty: bool) {
        let (dropped, crashed) = self.with_state(|state| {
            state
                .recovery
                .get(&view)
                .map_or((false, false), |v| (v.dropped.is_some(), v.crashed))
        });
        let known = self.with_state(|state| state.recovery.contains_key(&view));
        if dropped {
            self.delete_owned(view, RecoveryDeleteReason::DontSave, true);
        } else if known && !crashed && !dirty {
            self.delete_owned(view, RecoveryDeleteReason::ClosedClean, true);
        }
        self.with_state(|state| state.recovery.remove(&view));
    }

    /// `viewSaveAsDefault(wcId)`: first Save As suggestion of a restored
    /// diagram whose file is gone
    pub(super) fn view_save_as_default(&self, view: ViewId) -> Option<String> {
        self.with_state(|state| {
            state
                .recovery
                .get(&view)
                .and_then(|v| v.save_as_default.clone())
        })
    }

    /// `setViewOpenDecision(wcId, decision)`: the shell decided the recovery
    /// question for the file this view opens next
    pub(super) fn set_view_open_decision(&self, view: ViewId, decision: Decision) {
        self.with_state(|state| state.recovery_of(view).decision = Some(decision));
    }

    /// `resolveViewOpen(wcId, filePath, parent)`: before a file's content is
    /// loaded: the copy's bytes when the diagram is to be restored, none to
    /// open the file as saved. When the copy cannot be settled the file opens
    /// as saved and the view writes no copy over the old one.
    pub(super) fn resolve_view_open(
        &self,
        view: ViewId,
        file_path: &str,
        parent: Option<WindowId>,
    ) -> Option<Vec<u8>> {
        let decision = self.with_state(|state| {
            let v = state.recovery_of(view);
            v.blocked = false;
            v.decision.take()
        });
        // a headless export converts the file on disk: no one is there to answer the prompt
        if self.0.shell.is_headless() {
            return None;
        }
        if decision == Some(Decision::Original) || !self.recovery_available() {
            return None;
        }
        let identity = file_identity(file_path);
        if self.owned_elsewhere(view, &identity) {
            return None;
        }
        let lang = self.lang();
        let dialog = BoxDialog(&*self.0.dialogs);
        let parent = parent.map(Parent);
        let result = self.with_store(|store| {
            if decision == Some(Decision::Restore)
                && store.copy_info(&identity).ok().flatten().is_some()
            {
                store
                    .set_copy_state(
                        &identity,
                        main_core::packages::electron_utils::recovery_store::RecoveryCopyState::RestoreChosen,
                    )
                    .map_err(node_message)?;
            }
            resolve_recovery_on_open(&ResolveRecoveryOnOpenOptions {
                store,
                identity: &identity,
                dialog: &dialog,
                parent: parent.as_ref(),
                lang: lang.as_str(),
                document_name: None,
            })
            .map_err(node_message)
        });
        match result {
            Ok(RecoveryOpenResult::Restore { bytes, .. }) => {
                self.own(view, &identity);
                Some(bytes)
            }
            Ok(RecoveryOpenResult::Original) => None,
            Err(_) => {
                // the old copy stays as it is; this view writes none over it
                self.with_state(|state| state.recovery_of(view).blocked = true);
                None
            }
        }
    }

    /// `viewRestoredUntitled(wcId, filePath)`: a copy of `file_path` was
    /// restored, but the file is gone or no longer opens: the diagram is
    /// untitled now, its first Save As offers the old place
    pub(super) fn view_restored_untitled(&self, view: ViewId, file_path: &str) {
        self.adopt_untitled_copy(view, &file_identity(file_path));
        self.with_state(|state| {
            state.recovery_of(view).save_as_default = Some(file_path.to_owned());
        });
    }

    /// `takeUntitledCopy(wcId, request)`: a copy to open in this (untitled)
    /// view: its bytes, read now so they can be queued before the renderer
    /// asks
    pub(super) fn take_untitled_copy(
        &self,
        view: ViewId,
        request: &RecoveryOpenUntitledRequest,
    ) -> Option<Vec<u8>> {
        let bytes = self.with_store(|store| {
            let path = store.copy_path(&request.copy).ok()?;
            let bytes = std::fs::read(path).ok()?;
            let _ = store.mark_copy_loaded(&request.copy);
            Some(bytes)
        })?;
        self.adopt_untitled_copy(view, &request.copy);
        self.with_state(|state| {
            let v = state.recovery_of(view);
            v.title = Some(request.title.clone());
            if let Some(path) = request
                .save_as_default_path
                .as_ref()
                .filter(|p| !p.is_empty())
            {
                v.save_as_default = Some(path.clone());
            }
        });
        Some(bytes)
    }

    /// `viewFileRenamed(wcId, oldPath, newPath)`: the view's file was renamed
    /// on disk; its copy follows the new path
    pub(super) fn recovery_view_file_renamed(&self, view: ViewId, old_path: &str, new_path: &str) {
        if !self.recovery_available() {
            return;
        }
        let from = file_identity(old_path);
        let key = self.with_store(|store| store.copy_path(&from).unwrap_or_default());
        let owns = self.with_state(|state| {
            state
                .recovery
                .get(&view)
                .is_some_and(|v| v.owned.contains_key(&key))
        });
        if !owns {
            return;
        }
        let to = file_identity(new_path);
        let moved = self.with_store(|store| -> Result<(), NodeError> {
            if let Some(bytes) = store.read_copy(&from) {
                // the copy counts as the view's own at its new place
                let key = store.copy_path(&to)?;
                self.with_state(|state| {
                    state.recovery_of(view).owned.insert(key, to.clone());
                });
                store.write_copy(&to, &bytes, &RecoveryWriteOptions::default())?;
            }
            Ok(())
        });
        if moved.is_err() {
            return;
        }
        // the content now lives under the new path; the old entry would only offer it twice
        let deleted =
            self.with_store(|store| store.delete_copy(&from, RecoveryDeleteReason::Discarded));
        if matches!(deleted, Ok(RecoveryDeleteResult::Deleted)) {
            self.with_state(|state| {
                if let Some(v) = state.recovery.get_mut(&view) {
                    v.owned.remove(&key);
                }
            });
        }
    }
}
