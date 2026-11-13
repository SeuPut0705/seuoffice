//! The recovery-copy side of `slides-main.ts` that the channels touch
//! (what an open offers, what a save or a discarded close deletes) and the
//! recent files list. The 30 second copy writer (`runSlidesRecoveryPass`)
//! needs a timer and belongs to the shell.

use std::path::Path;

use jscompat::{JsonValue, json_parse, random_uuid};
use main_core::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, ResolveRecoveryOnOpenOptions, resolve_recovery_on_open,
};
use main_core::packages::electron_utils::recovery_store::{
    RecoveryCopyState, RecoveryDeleteReason, RecoveryFileIdentity, RecoveryIdentity, RecoveryStore,
    RecoveryStoreOptions, create_recovery_store,
};
use shell_contract::ViewId;
use shell_contract::runtime::PathName;

use super::dialog::{BoxOver, Parent};
use super::state::{App, SlideSession};
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
        let store = create_recovery_store(
            RecoveryStoreOptions {
                user_data_dir: &user_data_dir,
                now_ms: &now_ms,
                random_uuid: &random_uuid,
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
        self.with_recovery_store(|store| {
            if !s.path().is_empty() {
                let _ = store.delete_copy(&file_recovery_id(s.path()), reason);
            }
            if let Some(identity) = &s.recovery_id {
                let _ = store.delete_copy(identity, reason);
            }
        });
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
