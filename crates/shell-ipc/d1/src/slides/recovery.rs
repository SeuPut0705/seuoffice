//! The recovery-copy side of `slides-main.ts` that the channels touch
//! (what an open offers, what a save or a discarded close deletes) and the
//! recent files list. The 30 second copy writer (`runSlidesRecoveryPass`)
//! needs a timer and belongs to the shell.

use std::path::Path;

use jscompat::{JsonValue, json_parse};
use main_core::node_fs::NodeError;
use main_core::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, ResolveRecoveryOnOpenOptions, resolve_recovery_on_open,
};
use main_core::packages::electron_utils::recovery_store::{
    RecoveryCopyState, RecoveryDeleteReason, RecoveryDeleteResult, RecoveryFileIdentity,
    RecoveryIdentity, RecoveryStore, RecoveryStoreOptions, RecoveryUntitledIdentity,
    RecoveryWriteOptions, RecoveryWriteResult, create_recovery_store, new_untitled_recovery_id,
};
use shell_contract::ViewId;
use shell_contract::runtime::PathName;

use super::dialog::{BoxOver, Parent};
use super::state::{App, CopyMark, SlideSession};
use crate::host::path_string;

/// `fileRecoveryId(filePath)`
pub fn file_recovery_id(path: &str) -> RecoveryIdentity {
    RecoveryIdentity::File(RecoveryFileIdentity {
        kind: "slides".to_owned(),
        file_path: path.to_owned(),
    })
}

/// What `recoveredOpenBytes` answers
pub struct RecoveredOpen {
    pub bytes: Vec<u8>,
    pub recovered: bool,
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

impl App {
    /// The shared recovery store over the process-wide state
    pub fn with_recovery_store<R>(&self, f: impl FnOnce(&RecoveryStore<'_>) -> R) -> R {
        let shared = self.recovery_state.lock().unwrap();
        let user_data = path_string(self.services.paths.path(PathName::UserData));
        let user_data_dir = move || user_data.clone();
        let uuid = || self.shell.random_uuid();
        let store = create_recovery_store(
            RecoveryStoreOptions {
                user_data_dir: &user_data_dir,
                now_ms: &now_ms,
                random_uuid: &uuid,
            },
            &shared,
        );
        f(&store)
    }

    /// `copyNotOpened(identity, result)`: the copy waits for the next launch
    /// list or open as "later"
    fn copy_not_opened(&self, identity: &RecoveryIdentity) {
        self.with_recovery_store(|store| {
            let _ = store.set_copy_state(identity, RecoveryCopyState::Later);
        });
    }

    /// `recoveredOpenBytes(wcId, path, original, password)`: the bytes to
    /// open for `path`, the original or its recovery copy
    pub fn recovered_open_bytes(
        &self,
        path: &str,
        original: Vec<u8>,
        password: Option<&str>,
    ) -> RecoveredOpen {
        if self.shell.is_headless() {
            return RecoveredOpen {
                bytes: original,
                recovered: false,
            };
        }
        let identity = file_recovery_id(path);
        let parent = self.shell.dialog_parent().map(Parent);
        let lang = self.lang();
        let answer = self.with_recovery_store(|store| {
            resolve_recovery_on_open(&ResolveRecoveryOnOpenOptions {
                store,
                identity: &identity,
                dialog: &BoxOver(&*self.dialogs),
                parent: parent.as_ref(),
                lang: lang.as_str(),
                document_name: None,
            })
        });
        let copy = match answer {
            Ok(RecoveryOpenResult::Restore { bytes, .. }) => bytes,
            _ => {
                return RecoveredOpen {
                    bytes: original,
                    recovered: false,
                };
            }
        };
        // an encrypted deck's copy is encrypted with the same password (a
        // copy the current password cannot open is left alone, not opened)
        if self.engine.is_encrypted_ooxml(&copy) {
            let Some(password) = password else {
                self.copy_not_opened(&identity);
                return RecoveredOpen {
                    bytes: original,
                    recovered: false,
                };
            };
            return match self.engine.decrypt_office_file(&copy, password) {
                Ok(bytes) => RecoveredOpen {
                    bytes,
                    recovered: true,
                },
                Err(_) => {
                    self.copy_not_opened(&identity);
                    RecoveredOpen {
                        bytes: original,
                        recovered: false,
                    }
                }
            };
        }
        RecoveredOpen {
            bytes: copy,
            recovered: true,
        }
    }

    /// `deleteSessionCopies(session, reason)`: every copy the session's
    /// document has (its file slot and its untitled slot)
    pub fn delete_session_copies(&self, s: &SlideSession, reason: RecoveryDeleteReason) {
        let mut refused = false;
        self.with_recovery_store(|store| {
            let mut delete = |identity: &RecoveryIdentity| {
                refused |= matches!(
                    store.delete_copy(identity, reason),
                    Ok(RecoveryDeleteResult::Refused)
                );
                if let Ok(key) = store.copy_path(identity) {
                    self.backoff.borrow_mut().remove(&key);
                }
            };
            if !s.path().is_empty() {
                delete(&file_recovery_id(s.path()));
            }
            if let Some(identity) = &s.recovery_id {
                delete(identity);
            }
        });
        if !refused {
            s.copy_mark.set(None);
        }
    }

    /// `recoveryCopiesSaved(session, previousPath)`: a save of the session
    /// succeeded (to `session.path`)
    pub fn recovery_copies_saved(&self, s: &mut SlideSession, previous_path: &str) {
        if !previous_path.is_empty() && previous_path != s.path() {
            self.with_recovery_store(|store| {
                let _ = store.delete_copy(
                    &file_recovery_id(previous_path),
                    RecoveryDeleteReason::Saved,
                );
            });
        }
        self.delete_session_copies(s, RecoveryDeleteReason::Saved);
        if !s.path().is_empty() {
            s.recovery_id = None;
        }
    }

    /// `releaseSlidesRecovery(webContentsId)`: a view is going away; a deck
    /// no other view shows that closes clean drops the copy it wrote
    pub fn release_recovery(&self, view: ViewId) {
        let state = self.state.borrow();
        let Some(slot) = state.slot_of(view) else {
            return;
        };
        let Some(session) = state.slot(slot) else {
            return;
        };
        if self.session_dirty(session) {
            return;
        }
        if state.attached_ids(slot).iter().any(|other| *other != view) {
            return;
        }
        if session.recovery_id.is_none() {
            return;
        }
        self.delete_session_copies(session, RecoveryDeleteReason::ClosedClean);
    }

    // ---- the recent list ----

    fn recent_path(&self) -> String {
        path_string(
            self.services
                .paths
                .path(PathName::UserData)
                .join("slides-recent.json"),
        )
    }

    /// `readRecent()`: the stored list without the files that are gone
    pub fn read_recent(&self) -> Vec<String> {
        let Ok(raw) = std::fs::read_to_string(self.recent_path()) else {
            return Vec::new();
        };
        let Ok(JsonValue::Array(items)) = json_parse(&raw) else {
            return Vec::new();
        };
        let mut paths = Vec::new();
        for item in &items {
            // `existsSync` of a non-string throws, and the catch answers []
            let JsonValue::String(path) = item else {
                return Vec::new();
            };
            paths.push(path.clone());
        }
        paths.retain(|p| Path::new(p).exists());
        paths
    }

    /// `pushRecent(path)`: a headless export is not a document the user opened
    pub fn push_recent(&self, path: &str) {
        if self.shell.is_headless() {
            return;
        }
        let current = self.read_recent();
        let mut next = vec![path.to_owned()];
        next.extend(current.into_iter().filter(|p| p != path));
        next.truncate(10);
        if let Ok(text) = serde_json::to_string(&next) {
            // best-effort
            let _ = std::fs::write(self.recent_path(), text);
        }
    }
}

// ---- the 30 second recovery copy pass ----

/// `setInterval(runSlidesRecoveryPass, 30_000)`
const RECOVERY_TICK: std::time::Duration = std::time::Duration::from_secs(30);
/// `AUTOSAVE_BACKOFF_TICKS`
const AUTOSAVE_BACKOFF_TICKS: u32 = 10;

/// `runSlidesRecoveryPass(ignoreBackoff)`: one pass over every open deck;
/// with `ignore_backoff` (the OS is ending the session) decks in backoff
/// are tried too. Called by the shell on the core thread.
pub fn run_recovery_pass(ignore_backoff: bool) {
    let app = super::APPS.with(|apps| apps.borrow().last().cloned());
    if let Some(app) = app {
        app.run_recovery_pass(ignore_backoff);
    }
}

impl App {
    /// `setTimeout(job, delay)`: a thread that only sleeps and posts; `job`
    /// finds the app again on the core thread
    pub fn after(&self, delay: std::time::Duration, job: impl FnOnce(&App) + Send + 'static) {
        let index = self.registry_index;
        let services = self.services.clone();
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            super::post_to(&services, index, job);
        });
    }

    /// Starts the recovery interval
    pub fn schedule_recovery_tick(&self) {
        self.after(RECOVERY_TICK, |app| {
            app.run_recovery_pass(false);
            app.schedule_recovery_tick();
        });
    }

    fn content_mark(&self, s: &SlideSession) -> CopyMark {
        let top = |stack: &[super::engine::Snapshot]| {
            stack
                .last()
                .map_or(0, |snap| std::rc::Rc::as_ptr(&snap.0) as *const () as usize)
        };
        CopyMark {
            op_seq: s.core.op_seq.unwrap_or(0),
            meta_rev: s.core.meta_rev.unwrap_or(0),
            meta_dirty: s.core.meta_dirty,
            undo_len: s.core.undo_stack.len(),
            undo_top: top(&s.core.undo_stack),
            redo_len: s.core.redo_stack.len(),
            redo_top: top(&s.core.redo_stack),
            slide_count: self.engine.slide_paths(s.deck()).len(),
        }
    }

    /// `recoveryIdentityOf(session)`: its file's slot, else its own
    /// untitled slot (made on first use)
    fn recovery_identity_of(&self, s: &mut SlideSession) -> RecoveryIdentity {
        if !s.path().is_empty() {
            return file_recovery_id(s.path());
        }
        s.recovery_id
            .get_or_insert_with(|| {
                RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
                    kind: "slides".to_owned(),
                    untitled_id: new_untitled_recovery_id(&|| self.shell.random_uuid()),
                    ext: ".pptx".to_owned(),
                })
            })
            .clone()
    }

    /// `untitledRecoveryTitle(session)`: the launch list's name for an
    /// untitled deck
    fn untitled_recovery_title(&self, s: &SlideSession) -> String {
        let named = s
            .first_save_name
            .as_deref()
            .filter(|n| !n.is_empty())
            .map(|n| {
                let base = jscompat::node_path::host::basename(n, None);
                match base.to_lowercase().strip_suffix(".pptx") {
                    Some(stem) => base[..stem.len()].to_owned(),
                    None => base,
                }
            })
            .unwrap_or_default();
        if named.is_empty() {
            self.tm("untitledDeck", &[])
        } else {
            named
        }
    }

    /// `writeSessionCopy(session, ignoreBackoff)`
    pub fn write_session_copy(&self, slot: usize, ignore_backoff: bool) {
        let mut state = self.state.borrow_mut();
        let Some(s) = state.slot_mut(slot) else {
            return;
        };
        let mark = self.content_mark(s);
        // the deck holds an AI run's unaccepted edits: no copy until it is reverted or accepted
        if s.core.ai_run {
            return;
        }
        let identity = self.recovery_identity_of(s);
        let title = matches!(identity, RecoveryIdentity::Untitled(_))
            .then(|| self.untitled_recovery_title(s));
        let deck = s.deck();
        let engine = self.engine.clone();
        let password = s.password.clone();
        self.with_recovery_store(|store| {
            if store.is_discarded(&identity).unwrap_or(false) {
                return;
            }
            let Ok(key) = store.copy_path(&identity) else {
                return;
            };
            let skip = self.backoff.borrow().get(&key).copied().unwrap_or(0);
            if skip > 0 && !ignore_backoff {
                self.backoff.borrow_mut().insert(key, skip - 1);
                return;
            }
            if s.copy_mark.get() == Some(mark) && matches!(store.copy_info(&identity), Ok(Some(_)))
            {
                return;
            }
            // the ticket comes before serializing: a save or Don't Save that
            // lands meanwhile wins
            let Ok(ticket) = store.begin_write(&identity) else {
                return;
            };
            let options = RecoveryWriteOptions {
                ticket: Some(ticket),
                title,
                ..RecoveryWriteOptions::default()
            };
            let node_error = |message: String| NodeError {
                code: None,
                message,
            };
            let result = match &password {
                None => store.write_copy_streamed(
                    &identity,
                    &mut |tmp| engine.save_to_file(deck, tmp).map_err(|e| node_error(e.0)),
                    &options,
                ),
                Some(password) => engine
                    .save_bytes(deck)
                    .and_then(|bytes| engine.encrypt_ooxml(&bytes, password))
                    .map_err(|e| node_error(e.0))
                    .and_then(|bytes| store.write_copy(&identity, &bytes, &options)),
            };
            match result {
                Ok(written) => {
                    self.backoff.borrow_mut().remove(&key);
                    if written == RecoveryWriteResult::Written {
                        s.copy_mark.set(Some(mark));
                    }
                }
                Err(_) => {
                    // a run that began while the copy was starting is not a failing slot
                    if !s.core.ai_run {
                        self.backoff
                            .borrow_mut()
                            .insert(key, AUTOSAVE_BACKOFF_TICKS);
                    }
                }
            }
        });
    }

    /// `writeDirtyCopies(ignoreBackoff)`
    pub fn run_recovery_pass(&self, ignore_backoff: bool) {
        let slots = self.state.borrow().live_slots();
        for slot in slots {
            let skip = {
                let state = self.state.borrow();
                state
                    .slot(slot)
                    .is_none_or(|s| s.master_edit.is_some() || !self.session_dirty(s))
            };
            if !skip {
                self.write_session_copy(slot, ignore_backoff);
            }
        }
    }
}
