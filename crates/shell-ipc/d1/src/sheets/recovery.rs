//! Crash recovery of sheets-main.ts: the per-tab bookkeeping of the copies a
//! tab writes, keeps and drops, over the shared recovery store.

use std::fs;

use jscompat::node_path::host::{basename, join};
use main_core::node_fs::{NodeError, node_error};
use main_core::packages::electron_utils::recovery_labels::unprotectable_notice_text;
use main_core::packages::electron_utils::recovery_store::{
    RecoveryDeleteReason, RecoveryIdentity, RecoveryOpenPlan, RecoveryWriteOptions,
    RecoveryWriteResult, is_app_shutting_down, mark_app_shutting_down, reset_app_shutting_down,
    resume_discarded_copies,
};
use main_core::sheets::temp_files::cleanup_import_temp_directory;
use shell_contract::{IpcError, IpcValue, ViewId};

use super::core::{Core, Env};
use super::recovery_policy::{session_recovery_identity, untitled_workbook_ext};
use super::session::SessionInfo;
use crate::value::string;

pub fn node_err(error: NodeError) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: error.message,
    }
}

pub fn io_err(error: std::io::Error, syscall: &str, path: &str) -> IpcError {
    node_err(node_error(&error, syscall, path))
}

/// `rename(source, target)`, copying when it fails (another volume)
pub fn move_file_into(source: &str, target: &str) -> Result<(), NodeError> {
    if fs::rename(source, target).is_ok() {
        return Ok(());
    }
    fs::copy(source, target)
        .map(|_| ())
        .map_err(|e| node_error(&e, "copyfile", source))
}

impl Env {
    /// `isAppShuttingDown()`
    pub fn app_shutting_down(&self) -> bool {
        let shared = self.recovery.lock().unwrap_or_else(|p| p.into_inner());
        is_app_shutting_down(&shared)
    }

    pub fn set_app_shutting_down(&self, on: bool) {
        let shared = self.recovery.lock().unwrap_or_else(|p| p.into_inner());
        if on {
            mark_app_shutting_down(&shared);
        } else {
            reset_app_shutting_down(&shared);
            resume_discarded_copies(&shared);
        }
    }

    /// the copy's path in the store, `None` when the identity is refused
    pub fn copy_key(&self, identity: &RecoveryIdentity) -> Option<String> {
        self.with_store(|store| store.copy_path(identity).ok())
    }
}

impl Core {
    /// `sessionHasUnsavedCopy`: work that exists only as a recovery copy
    pub fn session_has_unsaved_copy(&self, session: &SessionInfo) -> bool {
        if session.unsaved_restore {
            return true;
        }
        if !session.unsaved_new {
            return false;
        }
        match session_recovery_identity(session) {
            Some(identity) => self
                .env
                .with_store(|store| store.copy_info(&identity).ok().flatten().is_some()),
            None => false,
        }
    }

    pub fn unsaved_copy_sessions(&self, view: ViewId) -> usize {
        let sessions: Vec<SessionInfo> = self
            .state
            .borrow()
            .tab(view)
            .map(|tab| tab.sessions.iter().map(|(_, s)| s.clone()).collect())
            .unwrap_or_default();
        sessions
            .iter()
            .filter(|session| self.session_has_unsaved_copy(session))
            .count()
    }

    /// `sheetsPendingEditCount`
    pub fn pending_edit_count(&self, view: ViewId) -> f64 {
        let reported = self
            .state
            .borrow()
            .pending_edit_counts
            .get(&view)
            .copied()
            .unwrap_or(0.0);
        reported + self.unsaved_copy_sessions(view) as f64
    }

    /// `noteSessionClosed`
    pub fn note_session_closed(&self, view: ViewId, session: &SessionInfo) {
        let Some(identity) = session_recovery_identity(session) else {
            return;
        };
        let reported = self
            .state
            .borrow()
            .pending_edit_counts
            .get(&view)
            .copied()
            .unwrap_or(0.0);
        let unsaved = self.session_has_unsaved_copy(session) || reported > 0.0;
        if unsaved && let Some(key) = self.env.copy_key(&identity) {
            self.state.borrow_mut().recovery_of(view).keep.insert(key);
        }
    }

    /// `deleteCopiesAfterSave`: the saved document's copies are no longer needed
    pub fn delete_copies_after_save(
        &self,
        view: ViewId,
        identities: Vec<Option<RecoveryIdentity>>,
    ) {
        for identity in identities.into_iter().flatten() {
            let Some(key) = self.env.copy_key(&identity) else {
                continue;
            };
            if self
                .state
                .borrow()
                .tab_recovery
                .get(&view)
                .is_some_and(|state| state.held.contains(&key))
            {
                continue;
            }
            let _ = self
                .env
                .with_store(|store| store.delete_copy(&identity, RecoveryDeleteReason::Saved));
            if let Some(state) = self.state.borrow_mut().tab_recovery.get_mut(&view) {
                state.written.retain(|(written, _)| *written != key);
                state.keep.remove(&key);
            }
        }
    }

    /// `discardTabCopies`: "Don't Save" drops every copy of the tab, and any late write
    pub fn discard_tab_copies(&self, view: ViewId) {
        let sessions: Vec<SessionInfo> = self
            .state
            .borrow()
            .tab(view)
            .map(|tab| tab.sessions.iter().map(|(_, s)| s.clone()).collect())
            .unwrap_or_default();
        let (mut identities, held) = {
            let mut state = self.state.borrow_mut();
            let recovery = state.recovery_of(view);
            recovery.discarded = true;
            (recovery.written.clone(), recovery.held.clone())
        };
        for session in &sessions {
            if let Some(identity) = session_recovery_identity(session)
                && let Some(key) = self.env.copy_key(&identity)
            {
                match identities.iter_mut().find(|(k, _)| *k == key) {
                    Some(entry) => entry.1 = identity,
                    None => identities.push((key, identity)),
                }
            }
        }
        for (key, identity) in &identities {
            if !held.contains(key) {
                let _ = self.env.with_store(|store| {
                    store.delete_copy(identity, RecoveryDeleteReason::DontSave)
                });
            }
        }
        let mut state = self.state.borrow_mut();
        let recovery = state.recovery_of(view);
        recovery.written.clear();
        recovery.keep.clear();
    }

    /// `resumeDiscardedTabCopies`
    pub fn resume_discarded_tab_copies(&self) {
        for recovery in self.state.borrow_mut().tab_recovery.values_mut() {
            recovery.discarded = false;
        }
    }

    /// `settleTabRecoveryOnClose`: the tab is going away
    pub fn settle_tab_recovery_on_close(&self, view: ViewId) {
        self.state.borrow_mut().decided_opens.remove(&view);
        let Some(state) = self
            .state
            .borrow()
            .tab_recovery
            .get(&view)
            .map(|s| (s.crashed, s.discarded, s.written.clone()))
        else {
            return;
        };
        let (crashed, discarded, written) = state;
        if !crashed && !discarded {
            let sessions: Vec<SessionInfo> = self
                .state
                .borrow()
                .tab(view)
                .map(|tab| tab.sessions.iter().map(|(_, s)| s.clone()).collect())
                .unwrap_or_default();
            for session in &sessions {
                self.note_session_closed(view, session);
            }
            let reported = self
                .state
                .borrow()
                .pending_edit_counts
                .get(&view)
                .copied()
                .unwrap_or(0.0);
            if reported == 0.0 {
                let keep = self
                    .state
                    .borrow()
                    .tab_recovery
                    .get(&view)
                    .map(|s| s.keep.clone())
                    .unwrap_or_default();
                for (key, identity) in &written {
                    if !keep.contains(key) {
                        let _ = self.env.with_store(|store| {
                            store.delete_copy(identity, RecoveryDeleteReason::ClosedClean)
                        });
                    }
                }
            }
        }
        self.state.borrow_mut().tab_recovery.remove(&view);
    }

    /// `showUnprotectableNotice`: once per tab
    pub fn show_unprotectable_notice(&self, view: ViewId) {
        if !self.env.alive(view) {
            return;
        }
        {
            let mut state = self.state.borrow_mut();
            let recovery = state.recovery_of(view);
            if recovery.notice_shown {
                return;
            }
            recovery.notice_shown = true;
        }
        self.send(
            view,
            "workbook:recovery-notice",
            vec![string(unprotectable_notice_text(
                self.env.tm.lang().as_str(),
            ))],
        );
    }

    /// `copyOwnedByAnotherView`
    pub fn copy_owned_by_another_view(&self, view: ViewId, identity: &RecoveryIdentity) -> bool {
        let planned = self
            .env
            .with_store(|store| matches!(store.open_plan(identity), Ok(RecoveryOpenPlan::None)));
        if planned {
            return false;
        }
        let Some(key) = self.env.copy_key(identity) else {
            return false;
        };
        let tabs: Vec<(ViewId, Vec<SessionInfo>)> = self
            .state
            .borrow()
            .tabs
            .iter()
            .map(|(id, tab)| (*id, tab.sessions.iter().map(|(_, s)| s.clone()).collect()))
            .collect();
        for (id, sessions) in tabs {
            if id == view || !self.env.alive(id) {
                continue;
            }
            let (held, wrote) = {
                let state = self.state.borrow();
                let recovery = state.tab_recovery.get(&id);
                (
                    recovery.is_some_and(|r| r.held.contains(&key)),
                    recovery.is_some_and(|r| r.written.iter().any(|(k, _)| *k == key)),
                )
            };
            if held {
                continue;
            }
            for session in &sessions {
                let Some(own) = session_recovery_identity(session) else {
                    continue;
                };
                if self.env.copy_key(&own).as_deref() != Some(key.as_str()) {
                    continue;
                }
                if session.unsaved_restore || wrote {
                    return true;
                }
            }
        }
        false
    }
}

/// What `writeSessionCopy` decided on the core thread before the file is produced
struct WritePlan {
    identity: RecoveryIdentity,
    ticket: main_core::packages::electron_utils::recovery_store::RecoveryWriteTicket,
}

/// `writeSessionCopy`: writes one session's copy through the store; false
/// when it has none, this tab holds it, or it was superseded. `produce`
/// writes the workbook to the path it is given (the save pipeline).
pub fn write_session_copy(
    env: &Env,
    view: ViewId,
    session: &SessionInfo,
    produce: impl FnOnce(&str) -> Result<(), IpcError>,
    ignore_size_limit: bool,
) -> Result<bool, IpcError> {
    // a headless export's hidden view converts the file and goes; it keeps no copy
    if env.shell.is_headless() {
        return Ok(false);
    }
    let Some(identity) = session_recovery_identity(session) else {
        return Ok(false);
    };
    if session.automatic_recovery_disabled && !ignore_size_limit {
        return Ok(false);
    }
    let plan = env.core({
        let identity = identity.clone();
        move |core| {
            let key = core.env.copy_key(&identity)?;
            let state = core.state.borrow();
            let recovery = state.tab_recovery.get(&view);
            if recovery.is_some_and(|r| r.discarded || r.held.contains(&key)) {
                return None;
            }
            drop(state);
            // taken before serializing: a save or "Don't Save" that lands meanwhile wins
            let ticket = core
                .env
                .with_store(|store| store.begin_write(&identity).ok())?;
            Some(WritePlan { identity, ticket })
        }
    });
    let Some(plan) = plan else {
        return Ok(false);
    };
    let title = recovery_title_for(session);
    let temp = env.temp_dir();
    let directory = join(&[&temp, "seuoffice-imports", &jscompat::random_uuid()]);
    let produced = (|| {
        fs::create_dir_all(&directory).map_err(|e| io_err(e, "mkdir", &directory))?;
        let target = join(&[
            &directory,
            &format!("recovery{}", untitled_workbook_ext(&session.path)),
        ]);
        produce(&target)?;
        Ok::<String, IpcError>(target)
    })();
    let target = match produced {
        Ok(target) => target,
        Err(error) => {
            cleanup_import_temp_directory(&temp, &directory);
            return Err(error);
        }
    };
    let options = RecoveryWriteOptions {
        title,
        ticket: Some(plan.ticket.clone()),
        original_path: session.recovery_original_path.clone(),
        formulas_dropped: (session.ods_converted
            && session.formulas_dropped.is_some_and(|n| n > 0.0))
        .then(|| session.formulas_dropped.unwrap_or(0.0)),
    };
    let identity = plan.identity.clone();
    let written = env.core({
        let target = target.clone();
        move |core| {
            let result = core.env.with_store(|store| {
                store.write_copy_streamed(
                    &identity,
                    &mut |store_temp| move_file_into(&target, store_temp),
                    &options,
                )
            });
            match result {
                Ok(RecoveryWriteResult::Written) => {
                    if let Some(key) = core.env.copy_key(&identity) {
                        let mut state = core.state.borrow_mut();
                        let written = &mut state.recovery_of(view).written;
                        match written.iter_mut().find(|(k, _)| *k == key) {
                            Some(entry) => entry.1 = identity,
                            None => written.push((key, identity)),
                        }
                    }
                    Ok(true)
                }
                Ok(RecoveryWriteResult::Superseded) => Ok(false),
                Err(error) => Err(node_err(error)),
            }
        }
    });
    cleanup_import_temp_directory(&temp, &directory);
    written
}

/// `recoveryTitleFor`: a CSV or converted workbook shows the file it came
/// from, an untitled workbook its tab title
pub fn recovery_title_for(session: &SessionInfo) -> Option<String> {
    if let Some(original) = &session.recovery_original_path {
        return Some(basename(original, None));
    }
    match (&session.suggest_save_as, session.unsaved_new) {
        (Some(suggested), true) => Some(basename(suggested, None)),
        _ => None,
    }
}

/// `{ ok }` of the recovery handler
pub fn ok_answer(ok: bool) -> IpcValue {
    crate::value::obj([("ok", IpcValue::Bool(ok))])
}
