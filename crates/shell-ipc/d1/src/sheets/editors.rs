//! What the shell and the other batches call into sheets: the exported
//! functions of sheets-main.ts (`requestSheetsClose`, `sheetsFileRenamed`,
//! `sendSheetsMenuAction`, `writeSheetsCopiesNow`, …) as [`DocumentEditors`],
//! and the end of a view.

use std::path::{Path, PathBuf};

use jscompat::JsonValue;
use jscompat::node_path::host::{basename, dirname, join};
use main_core::sheets::close_guard::{CloseGuardDecision, close_guard_decision};
use main_core::sheets::session_rename::session_after_rename;
use main_core::sheets::temp_files::cleanup_expired_pasted_files;
use shell_contract::editors::{DocumentEditors, SaveMode, Then};
use shell_contract::{IpcError, IpcValue, Surface, ViewId, WindowId};

use super::core::{CloseWaiter, Core};
use super::dialogs::message_box;
use super::open::cleanup_session;
use super::session::SessionInfo;
use crate::value::{string, thrown};

/// how long a close waits for the renderer's save to finish
const CLOSE_SAVE_TIMEOUT_MS: u64 = 120_000;
/// how long an OS shutdown waits for one tab's renderer to write its copy
const RECOVERY_WRITE_NOW_TIMEOUT_MS: u64 = 8_000;

/// `shuttingDown()`
fn shutting_down(core: &Core) -> bool {
    core.state.borrow().shutdown.active() || core.env.app_shutting_down()
}

impl Core {
    /// `markSheetsShuttingDown`
    pub fn mark_shutting_down(&self) {
        self.state.borrow_mut().shutdown.mark();
        self.env.set_app_shutting_down(true);
    }

    /// `resetSheetsShuttingDown`: the quit was vetoed
    pub fn reset_shutting_down(&self) {
        self.state.borrow_mut().shutdown.reset();
        self.env.set_app_shutting_down(false);
        self.resume_discarded_tab_copies();
    }

    /// `queueWorkbookForView`: the path this tab's first select opens without a dialog
    pub fn queue_workbook(&self, view: ViewId, path: &str) {
        self.state
            .borrow_mut()
            .queued_workbooks
            .insert(view, path.to_owned());
    }

    /// `setSheetsNewBlank`
    pub fn set_new_blank(&self) {
        self.state.borrow_mut().pending_new_blank = true;
    }

    /// `markSheetsUntitledPath`
    pub fn mark_untitled_path(&self, path: &str) {
        self.state
            .borrow_mut()
            .untitled_workbook_paths
            .insert(path.to_owned());
    }

    /// `authorizeMcpSheetWrite`
    pub fn authorize_mcp_write(&self, view: ViewId, path: &str) {
        self.state
            .borrow_mut()
            .mcp_writable
            .entry(view)
            .or_default()
            .insert(path.to_owned());
    }

    /// `registerSheetsSession`'s tab: known to pick, rename and close before its first call
    pub fn register_tab(&self, view: ViewId) {
        self.ensure_tab(view);
    }

    /// `discardSheetsRecovery`: the same as answering "Don't Save"
    pub fn discard_recovery(&self, view: ViewId) {
        if !self.env.alive(view) {
            return;
        }
        self.discard_tab_copies(view);
    }

    /// `requestSheetsClose`: true means proceed with the close
    pub fn request_close(&self, view: ViewId, parent: Option<WindowId>, then: Then<bool>) {
        let count = self.pending_edit_count(view);
        let decision = close_guard_decision(count, !self.env.alive(view), shutting_down(self));
        if decision == CloseGuardDecision::Proceed {
            return then(Ok(true));
        }
        let tm = &self.env.tm;
        let options = message_box(
            "warning",
            tm.with("closeUnsavedMsg", &[("count", JsonValue::Number(count))]),
            Some(tm.t("closeUnsavedDetail")),
            vec![tm.t("menuSave"), tm.t("btnDontSave"), tm.t("btnCancel")],
            0,
            Some(2),
        );
        let response = self.env.dialogs.message(parent, &options).response;
        if response == 2 {
            return then(Ok(false));
        }
        if response == 1 {
            self.discard_tab_copies(view);
            return then(Ok(true));
        }
        // The window went away (or a quit started) while the prompt was up: don't save
        if shutting_down(self) || !self.env.alive(view) {
            return then(Ok(true));
        }
        self.await_save(view, then);
    }

    /// Asks the renderer to run its journal save and resumes `then` with the
    /// outcome, or `false` after two minutes
    pub fn await_save(&self, view: ViewId, then: Then<bool>) {
        let token = {
            let mut state = self.state.borrow_mut();
            state.next_token += 1;
            let token = state.next_token;
            state.close_waiters.insert(
                view,
                CloseWaiter {
                    token,
                    resume: Box::new(move |ok| then(Ok(ok))),
                },
            );
            token
        };
        let env = self.env.clone();
        self.env.shell.after(
            CLOSE_SAVE_TIMEOUT_MS,
            Box::new(move || {
                env.post(move |core| {
                    let expired = {
                        let mut state = core.state.borrow_mut();
                        match state.close_waiters.get(&view) {
                            Some(waiter) if waiter.token == token => {
                                state.close_waiters.remove(&view)
                            }
                            _ => None,
                        }
                    };
                    if let Some(waiter) = expired {
                        (waiter.resume)(false);
                    }
                })
            }),
        );
        self.send(view, "workbook:close-save-request", Vec::new());
    }

    /// `writeSheetsCopiesNow`: every live tab's renderer writes its copy now;
    /// `done` runs once all answered or timed out
    pub fn write_copies_now(&self, done: Box<dyn FnOnce()>) {
        let views: Vec<ViewId> = self
            .tab_views()
            .into_iter()
            .filter(|view| self.env.alive(*view))
            .filter(|view| {
                !self
                    .state
                    .borrow()
                    .tab_recovery
                    .get(view)
                    .is_some_and(|r| r.crashed)
            })
            .collect();
        if views.is_empty() {
            return done();
        }
        let remaining = std::rc::Rc::new(std::cell::Cell::new(views.len()));
        let done = std::rc::Rc::new(std::cell::RefCell::new(Some(done)));
        for view in views {
            let nonce = self.env.uuid();
            let settle = {
                let (remaining, done) = (remaining.clone(), done.clone());
                move || {
                    remaining.set(remaining.get() - 1);
                    if remaining.get() == 0
                        && let Some(done) = done.borrow_mut().take()
                    {
                        done();
                    }
                }
            };
            let once = std::rc::Rc::new(std::cell::RefCell::new(Some(settle)));
            let on_answer = {
                let once = once.clone();
                move || {
                    if let Some(settle) = once.borrow_mut().take() {
                        settle();
                    }
                }
            };
            self.state
                .borrow_mut()
                .write_now_waiters
                .insert(nonce.clone(), Box::new(on_answer));
            let (env, key) = (self.env.clone(), nonce.clone());
            self.env.shell.after(
                RECOVERY_WRITE_NOW_TIMEOUT_MS,
                Box::new(move || {
                    env.post(move |core| {
                        let waiter = core.state.borrow_mut().write_now_waiters.remove(&key);
                        if let Some(answer) = waiter {
                            answer();
                        }
                    })
                }),
            );
            self.send(view, "workbook:recovery-write-now", vec![string(nonce)]);
        }
    }

    /// `sheetsFileRenamed`: an open view's file was renamed outside the editor
    pub fn file_renamed(&self, view: ViewId, old_path: &str, new_path: &str) {
        // A user-chosen name always wins: the file no longer qualifies for auto-rename
        let stem = |p: &str| {
            let name = basename(p, None);
            match name.rfind('.') {
                Some(at) if at + 1 < name.len() => {
                    let head = &name[..at];
                    let stripped = head
                        .strip_suffix(')')
                        .and_then(|rest| rest.rfind(" ("))
                        .filter(|open| {
                            head[open + 2..head.len() - 1]
                                .chars()
                                .all(|c| c.is_ascii_digit())
                                && head.len() - 1 > open + 2
                        })
                        .map_or(head, |open| &head[..open]);
                    format!("{stripped}{}", &name[at..])
                }
                _ => name,
            }
        };
        {
            let mut state = self.state.borrow_mut();
            if state.untitled_workbook_paths.remove(old_path) && stem(new_path) == stem(old_path) {
                state.untitled_workbook_paths.insert(new_path.to_owned());
            }
        }
        let sessions: Vec<(String, SessionInfo)> = match self.state.borrow().tab(view) {
            Some(tab) => tab.sessions.clone(),
            None => return,
        };
        let mut matched = false;
        for (id, session) in sessions {
            let Some(map) = session_after_rename(&session.to_map(), old_path, new_path) else {
                continue;
            };
            let mut renamed = session.with_renamed_fields(&map);
            // An unsaved new workbook's tab renames its hidden backing file
            if session.unsaved_new
                && session.path == old_path
                && let Some(suggest) = &session.suggest_save_as
            {
                let suggested = join(&[&dirname(suggest), &basename(new_path, None)]);
                if &suggested != suggest
                    && !Path::new(&suggested).exists()
                    && !self.suggested_path_taken(&suggested)
                {
                    renamed.suggest_save_as = Some(suggested);
                }
            }
            // A rename moves the same bytes: the split-view disk snapshot follows the path
            if let Some((path, state)) = &renamed.disk_state
                && path == old_path
            {
                renamed.disk_state = Some((new_path.to_owned(), state.clone()));
            }
            if let Some(tab) = self.state.borrow_mut().tab_mut(view) {
                tab.set_session(&id, renamed);
            }
            matched = true;
        }
        if matched {
            self.send(
                view,
                "workbook:renamed",
                vec![string(basename(new_path, None))],
            );
        }
    }

    /// The end of a view: the tab's sessions close, its copies settle, and
    /// what waited on it stops waiting
    pub fn view_gone(&self, view: ViewId) {
        // registerSheetsSession's 'destroyed'
        let has_tab = self.state.borrow().tab(view).is_some();
        if has_tab {
            self.state
                .borrow_mut()
                .save_as_export_targets
                .forget(f64::from(view.0));
            self.settle_tab_recovery_on_close(view);
            let tab = {
                let mut state = self.state.borrow_mut();
                let at = state.tabs.iter().position(|(id, _)| *id == view);
                at.map(|at| state.tabs.remove(at).1)
            };
            if let Some(mut tab) = tab {
                // Free pending chunked-save uploads with the tab
                tab.save_transfers.dispose();
                let sessions = std::mem::take(&mut tab.sessions);
                let env = self.env.clone();
                self.env.spawn(move || {
                    for (id, session) in sessions {
                        cleanup_session(&env, &id, &session, session.import_temp_dir.as_deref());
                    }
                });
            }
        } else {
            self.state.borrow_mut().tab_recovery.remove(&view);
            self.state
                .borrow_mut()
                .save_as_export_targets
                .forget(f64::from(view.0));
        }
        {
            let mut state = self.state.borrow_mut();
            if state.active_view == Some(view) {
                state.active_view = None;
            }
            state.queued_workbooks.remove(&view);
        }
        // the pending-edits tracker's 'destroyed'
        let tracked = self.state.borrow_mut().tracked_edit_senders.remove(&view);
        if tracked {
            self.state.borrow_mut().pending_edit_counts.remove(&view);
            let waiter = self.state.borrow_mut().close_waiters.remove(&view);
            if let Some(waiter) = waiter {
                (waiter.resume)(false);
            }
        }
    }

    /// The first tab of a process starts the sweep of old pasted images
    pub fn start_pasted_temp_cleanup(&self) {
        if std::mem::replace(&mut self.state.borrow_mut().pasted_cleanup_started, true) {
            return;
        }
        cleanup_expired_pasted_files(&self.env.temp_dir(), self.env.shell.now_ms());
    }
}

/// The sheets editors of every view, as other batches see them
pub struct SheetsEditors {
    pub core: Core,
}

fn unsupported(what: &str) -> IpcError {
    thrown(format!("The sheets editor has no {what}."))
}

impl DocumentEditors for SheetsEditors {
    fn owns(&self, view: ViewId) -> bool {
        self.core.state.borrow().tab(view).is_some()
            || self
                .core
                .env
                .services
                .views
                .sender_of(view)
                .is_some_and(|sender| sender.surface == Surface::Sheets)
    }

    /// The renderer runs its journal save and answers on `workbook:close-save-result`
    /// (the save half of `requestSheetsClose`, without the prompt)
    fn request_save(&self, view: ViewId, _mode: SaveMode, then: Then<bool>) {
        if !self.core.env.alive(view) {
            return then(Ok(false));
        }
        self.core.await_save(view, then);
    }

    fn request_close(&self, view: ViewId, parent: Option<WindowId>, then: Then<bool>) {
        self.core.request_close(view, parent, then);
    }

    fn read_text(&self, _view: ViewId, then: Then<String>) {
        then(Err(unsupported("text export")));
    }

    /// sheets-main saves to an explicit path through the renderer's save
    /// request (`workbook:save` with `targetPath`, authorized by
    /// `authorizeMcpSheetWrite`); it has no main-side function that does it
    fn save_to_path(&self, _view: ViewId, _path: PathBuf, then: Then<()>) {
        then(Err(unsupported("main-side save to a path")));
    }

    fn file_renamed(&self, view: ViewId, old_path: &Path, new_path: &Path) {
        self.core.file_renamed(
            view,
            &old_path.to_string_lossy(),
            &new_path.to_string_lossy(),
        );
    }

    /// `sendSheetsMenuAction`: `menu:action` with `export-<format>`
    fn export_request(&self, view: ViewId, format: &str) {
        self.core.send(
            view,
            "menu:action",
            vec![IpcValue::String(format!("export-{format}"))],
        );
    }

    /// the file this tab shows (`SheetsTabSession.currentPath`)
    fn document_path(&self, view: ViewId) -> Option<PathBuf> {
        self.core
            .state
            .borrow()
            .tab(view)
            .and_then(|tab| tab.current_path.clone())
            .map(PathBuf::from)
    }
}

thread_local! {
    static VIEWS: std::cell::RefCell<Option<SheetsViews>> = const { std::cell::RefCell::new(None) };
}

/// What the shell asks of the sheets tabs besides the renderer's own
/// channels: the exported functions of sheets-main.ts that no contract trait
/// names (`registerSheetsSession`, `queueWorkbookForView`, `setSheetsNewBlank`,
/// `markSheetsUntitledPath`, `authorizeMcpSheetWrite`, `writeSheetsCopiesNow`,
/// `markSheetsShuttingDown`, `resetSheetsShuttingDown`, `discardSheetsRecovery`).
/// Core thread only.
#[derive(Clone)]
pub struct SheetsViews(Core);

/// The sheets tabs of the module registered on this thread
pub fn views() -> Option<SheetsViews> {
    VIEWS.with(|views| views.borrow().clone())
}

pub(super) fn install_views(core: &Core) {
    VIEWS.with(|views| *views.borrow_mut() = Some(SheetsViews(core.clone())));
}

impl SheetsViews {
    /// a tab the shell created: known to the picker and the close path before its first call
    pub fn register_tab(&self, view: ViewId) {
        self.0.register_tab(view);
    }

    pub fn queue_workbook(&self, view: ViewId, path: &str) {
        self.0.queue_workbook(view, path);
    }

    pub fn set_new_blank(&self) {
        self.0.set_new_blank();
    }

    pub fn mark_untitled_path(&self, path: &str) {
        self.0.mark_untitled_path(path);
    }

    pub fn authorize_mcp_write(&self, view: ViewId, path: &str) {
        self.0.authorize_mcp_write(view, path);
    }

    /// the OS is ending the session: every live tab writes its copy now
    pub fn write_copies_now(&self, done: Box<dyn FnOnce()>) {
        self.0.write_copies_now(done);
    }

    pub fn mark_shutting_down(&self) {
        self.0.mark_shutting_down();
    }

    pub fn reset_shutting_down(&self) {
        self.0.reset_shutting_down();
    }

    pub fn discard_recovery(&self, view: ViewId) {
        self.0.discard_recovery(view);
    }

    /// `webContents.on('render-process-gone')`: its copies are what the shell reopens from
    pub fn render_process_gone(&self, view: ViewId) {
        self.0.state.borrow_mut().recovery_of(view).crashed = true;
    }

    /// `exportSheetsPdfHeadless`: the hidden view's target, and what settles the run
    pub fn register_headless_export(
        &self,
        view: ViewId,
        out_path: &str,
        settle: Box<dyn FnOnce(super::core::HeadlessReport)>,
    ) {
        let mut state = self.0.state.borrow_mut();
        state.headless_targets.insert(view, out_path.to_owned());
        state.headless_waiters.insert(view, settle);
    }
}
