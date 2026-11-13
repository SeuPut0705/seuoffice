//! `apps/hwp/src/main/recovery.ts`: crash recovery for HWP and HWPX documents.
//!
//! While a tab has unsaved changes the renderer exports the document now and then
//! and this module stores it as the tab's recovery copy in the app data folder,
//! after the corrections a save makes against the opened file (`save_fixes`). The
//! user's file is never written here.
//!
//! What differs from the TypeScript, and why:
//!
//! - The module-level maps and sets are the fields of [`HwpRecovery`], which the
//!   caller owns; `installHwpRecovery` does not register the contract (the caller
//!   registers its implementation of `RecoveryEditorContract` over the methods
//!   `write_copies_now`, `open_file_with_decision`, `open_untitled_copy`,
//!   `is_unprotectable`). `contentsByWc` is the list of tracked view ids; a view is
//!   its `i64` id, and what the TypeScript does to the `WebContents` goes through
//!   [`HwpRecoveryElectron`].
//! - Promises are plain calls. `hwp:recovery-write` is split in two
//!   (`recovery_write_check`, `recovery_write_land`) so the caller can run
//!   `applySaveFixes` on a worker between them; [`RecoveryWriteJob`] carries what
//!   the worker needs (`SaveBase` is `Send`, see the test). The job's title is
//!   taken at check time, not after the fixes: nothing runs between that could
//!   change it.
//! - Timers are the caller's: the module asks for them through `set_timeout` and
//!   `clear_timeout` and the caller calls `dont_save_hold_ended`, `flush_timed_out`
//!   when one fires. `writeCopiesNow` answers the flush tokens it waits for; its
//!   `Promise.all` is done when each token was settled by `recovery_flushed` or
//!   `flush_timed_out`. A flush the view cannot take (`send_recovery_flush` fails)
//!   is settled at once and is not among the tokens.
//! - The store raises `NodeError` where Node throws. Where the TypeScript catches
//!   it (`hwpRecoveryOnRead`, `hwpRecoverySaved`, `hwpRecoveryDontSave`, the
//!   `destroyed` listener, `hwpRecoveryFileRenamed`'s write) the same warning and
//!   fallback are used. Where the exception escapes into an IPC handler or a
//!   caller that has no catch (`copyPath` in `recovery_begin`, the ticket in
//!   `recovery_write_*`, the delete after the move in `hwp_recovery_file_renamed`,
//!   `copyPath` in `open_untitled_copy`, `markCopyLoaded` of an untitled copy in
//!   `hwp_recovery_on_read`) it is warned about and the call takes its refusal
//!   (`Refused`, or nothing done) so the view goes on without a copy rather than
//!   failing; `recovery_write_land` answers `Refused` for a failed copy write.
//! - `HwpRecovery` implements `Default` by hand (`nextFlushToken` starts at 1).
//! - A missing `host` (before `install_hwp_recovery`) behaves as in the TypeScript.

use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use jscompat::node_path::host::{basename, extname};
use jscompat::trim;
use serde_json::Value;

use super::dialog_strings::tm;
use super::ipc::HwpFormat;
use super::save_fixes::{SaveBase, apply_save_fixes};
use super::save_plan::bytes_match_format;
use super::tab_widths::{TabSpot, new_tabs_of};
use crate::node_fs::NodeError;
use crate::packages::electron_utils::default_save_dir::Thrown;
use crate::packages::electron_utils::hwp_default_format::{
    HwpDefaultFormat, SettingsPathProvider, read_hwp_default_format,
};
use crate::packages::electron_utils::message_box::{MessageBox, ParentWindow};
use crate::packages::electron_utils::recovery_contract::{
    RecoveryOpenDecision, RecoveryOpenFileRequest, RecoveryOpenUntitledRequest,
};
use crate::packages::electron_utils::recovery_labels::unprotectable_notice_text;
use crate::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, ResolveRecoveryOnOpenOptions, resolve_recovery_on_open,
};
use crate::packages::electron_utils::recovery_store::{
    RecoveryDeleteReason, RecoveryDeleteResult, RecoveryFileIdentity, RecoveryIdentity,
    RecoveryStore, RecoveryStoreOptions, RecoveryUntitledIdentity, RecoveryWriteOptions,
    RecoveryWriteResult, RecoveryWriteTicket, SharedRecoveryState, create_recovery_store,
    is_untitled_identity, new_untitled_recovery_id,
};
use crate::packages::i18n::normalize_lang;

/// `MAX_HWP_SAVE_BYTES` of `apps/hwp/src/shared/ipc.ts`
pub const MAX_HWP_SAVE_BYTES: usize = 512 * 1024 * 1024;

/// `hwpFormatOfPath(path)` of `apps/hwp/src/shared/ipc.ts`: `/\.(hwpx?)$/i`, lower-cased
pub fn hwp_format_of_path(path: &str) -> Option<HwpFormat> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".hwpx") {
        Some(HwpFormat::Hwpx)
    } else if lower.ends_with(".hwp") {
        Some(HwpFormat::Hwp)
    } else {
        None
    }
}

/// How long the OS-shutdown flush waits for one tab's copy.
pub const FLUSH_TIMEOUT_MS: f64 = 10_000.0;
/// After "Don't Save" the tab normally closes at once. After this long its renderer is
/// taken to stay open and its unsaved changes need a copy again.
pub const DONT_SAVE_HOLD_MS: f64 = 5_000.0;

/// `{ name, format }` of `HwpRecoveryHost.untitledCopyOf`
#[derive(Debug, Clone, PartialEq)]
pub struct UntitledCopy {
    pub name: String,
    pub format: HwpFormat,
}

/// `HwpRecoveryHost`: what this module reads of hwp-main's per-view state
/// (interior mutability is the implementor's)
pub trait HwpRecoveryHost {
    /// the file the view saves to; None while it has none (a new document)
    fn save_path_of(&self, wc_id: i64) -> Option<String>;
    /// the untitled copy the view was opened on (a skill template's, or a recovery copy)
    fn untitled_copy_of(&self, wc_id: i64) -> Option<UntitledCopy>;
    /// the path queued for the view to read
    fn open_path_of(&self, wc_id: i64) -> Option<String>;
    /// what a save of the view corrects against (kept when the view read its file)
    fn save_base_of(&self, wc_id: i64) -> SaveBase;
    /// the view's mirrored unsaved-changes flag
    fn is_dirty(&self, wc_id: i64) -> bool;
    /// the view holds unsaved changes (a restored copy)
    fn mark_dirty(&self, wc_id: i64);
    /// queue `path` as the file the view opens and saves to
    fn queue_file(&self, wc_id: i64, path: &str);
    /// queue `path` as an untitled copy: read like a file, saved like a new document
    fn queue_untitled_copy(&self, wc_id: i64, path: &str, copy: UntitledCopy);
}

/// The timers recovery.ts sets
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RecoveryTimer {
    /// the `DONT_SAVE_HOLD_MS` timer of a view: fires `dont_save_hold_ended`
    DontSave(i64),
    /// the `FLUSH_TIMEOUT_MS` timer of a flush token: fires `flush_timed_out`
    Flush(u64),
}

/// What recovery.ts reaches of Electron and the process
pub trait HwpRecoveryElectron {
    type Window: ParentWindow;
    type Dialog: MessageBox<Self::Window>;
    /// `contents.isDestroyed()`
    fn is_destroyed(&self, wc_id: i64) -> bool;
    /// `contents.send('hwp:recovery-reset')`
    fn send_recovery_reset(&self, wc_id: i64);
    /// `contents.send('hwp:recovery-flush', token)`; Err when it throws
    fn send_recovery_flush(&self, wc_id: i64, token: u64) -> Result<(), String>;
    /// `contents.reload()`
    fn reload(&self, wc_id: i64);
    fn is_headless_mode(&self) -> bool;
    /// `getUiLang()`
    fn ui_lang(&self) -> String;
    /// `app.getPath('userData')`; also what `readHwpDefaultFormat(app)` reads
    fn user_data_dir(&self) -> String;
    /// `Date.now()`
    fn now_ms(&self) -> f64;
    /// `crypto.randomUUID()`
    fn random_uuid(&self) -> String;
    fn dialog(&self) -> &Self::Dialog;
    /// `BrowserWindow.fromWebContents(sender) ?? BrowserWindow.getFocusedWindow()`
    fn parent_of(&self, wc_id: i64) -> Option<Self::Window>;
    fn set_timeout(&self, timer: RecoveryTimer, ms: f64);
    fn clear_timeout(&self, timer: RecoveryTimer);
    /// `console.warn`: the message with the error text
    fn warn(&self, message: &str);
}

/// `RecoveryBeginResult`
#[derive(Debug, Clone, PartialEq)]
pub enum RecoveryBeginResult {
    /// `{ ok: false }`
    Refused,
    /// `{ ok: true, format }`
    Began(HwpFormat),
}

/// `RecoveryWriteOutcome`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryWriteOutcome {
    Written,
    Superseded,
    Refused,
}

impl RecoveryWriteOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            RecoveryWriteOutcome::Written => "written",
            RecoveryWriteOutcome::Superseded => "superseded",
            RecoveryWriteOutcome::Refused => "refused",
        }
    }
}

/// `RecoveryOpenedResult`; `notice` None is the TypeScript's `null`
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryOpenedResult {
    pub restored: bool,
    pub notice: Option<String>,
}

/// What `hwp:recovery-write` hands to a worker between its checks and its write.
pub struct RecoveryWriteJob {
    pub format: HwpFormat,
    pub base: SaveBase,
    identity: RecoveryIdentity,
    ticket: RecoveryWriteTicket,
    title: String,
}

/// `SettingsPathProvider` over the one folder `readHwpDefaultFormat` asks for
struct UserDataOnly(String);

impl SettingsPathProvider for UserDataOnly {
    fn get_path(&self, name: &str) -> Result<String, Thrown> {
        if name == "userData" {
            Ok(self.0.clone())
        } else {
            Err(Thrown(format!("Failed to get '{name}' path")))
        }
    }
}

/// `recoveryStore()`: the store is built per call over the caller's clock and folders
fn with_store<E, R>(
    e: &E,
    shared: &SharedRecoveryState,
    f: impl FnOnce(&RecoveryStore<'_>) -> R,
) -> R
where
    E: HwpRecoveryElectron,
{
    let user_data_dir = || e.user_data_dir();
    let now_ms = || e.now_ms();
    let random_uuid = || e.random_uuid();
    let store = create_recovery_store(
        RecoveryStoreOptions {
            user_data_dir: &user_data_dir,
            now_ms: &now_ms,
            random_uuid: &random_uuid,
        },
        shared,
    );
    f(&store)
}

fn format_of_ext(ext: &str) -> HwpFormat {
    if ext.to_lowercase() == ".hwpx" {
        HwpFormat::Hwpx
    } else {
        HwpFormat::Hwp
    }
}

fn file_identity(path: &str) -> RecoveryIdentity {
    RecoveryIdentity::File(RecoveryFileIdentity {
        kind: "hwp".to_owned(),
        file_path: path.to_owned(),
    })
}

/// `data instanceof Uint8Array && ...`: the bytes and format when they are a whole
/// document of that format
fn valid_bytes<'a>(data: Option<&'a [u8]>, format: Option<&str>) -> Option<(&'a [u8], HwpFormat)> {
    let data = data?;
    let format = HwpFormat::parse(format?)?;
    (!data.is_empty() && data.len() <= MAX_HWP_SAVE_BYTES && bytes_match_format(data, format))
        .then_some((data, format))
}

/// `name.replace(/\.hwpx?$/i, '')`
fn strip_hwp_ext(name: &str) -> &str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".hwpx") {
        &name[..name.len() - 5]
    } else if lower.ends_with(".hwp") {
        &name[..name.len() - 4]
    } else {
        name
    }
}

/// the module-level state of recovery.ts
pub struct HwpRecovery {
    host: Option<Rc<dyn HwpRecoveryHost>>,
    /// live views, in the order they were tracked (a `Map` keeps its first place)
    contents: Vec<i64>,
    /// the copy identity of a view without a file (and of a copy restored without its original)
    untitled_identity: HashMap<i64, RecoveryIdentity>,
    /// the title an untitled document's copy is listed under
    title: HashMap<i64, String>,
    /// the first Save As suggestion of a copy restored without its original
    save_as_default: HashMap<i64, String>,
    /// the launch list's answer for the file a view opens
    decision: HashMap<i64, (String, RecoveryOpenDecision)>,
    /// views whose renderer has taken its queued path: a later change of it needs a reload
    consumed: HashSet<i64>,
    /// views that will read an untitled recovery copy
    untitled_restore: HashSet<i64>,
    /// views whose editor holds a recovery copy's content
    restored: HashSet<i64>,
    /// views that wrote or loaded the document's copy: a clean close removes it
    owns_copy: HashSet<i64>,
    /// the copy a view is exporting: its write ticket and format
    turn: HashMap<i64, (RecoveryWriteTicket, HwpFormat)>,
    /// views whose document has a password a copy cannot keep
    unprotectable: HashSet<i64>,
    notice_shown: HashSet<i64>,
    /// views whose copy was dropped with "Don't Save", while their tab closes
    dont_save: HashSet<i64>,
    /// views whose renderer is gone: their copies stay for the reopened tab
    crashed: HashSet<i64>,
    /// views whose old copy could not be resolved: no copy may replace it
    blocked: HashSet<i64>,
    /// the file each view has read
    loaded_path: HashMap<i64, String>,
    flush_waiters: HashSet<u64>,
    next_flush_token: u64,
}

impl Default for HwpRecovery {
    fn default() -> Self {
        Self::new()
    }
}

impl HwpRecovery {
    pub fn new() -> Self {
        HwpRecovery {
            host: None,
            contents: Vec::new(),
            untitled_identity: HashMap::new(),
            title: HashMap::new(),
            save_as_default: HashMap::new(),
            decision: HashMap::new(),
            consumed: HashSet::new(),
            untitled_restore: HashSet::new(),
            restored: HashSet::new(),
            owns_copy: HashSet::new(),
            turn: HashMap::new(),
            unprotectable: HashSet::new(),
            notice_shown: HashSet::new(),
            dont_save: HashSet::new(),
            crashed: HashSet::new(),
            blocked: HashSet::new(),
            loaded_path: HashMap::new(),
            flush_waiters: HashSet::new(),
            next_flush_token: 1,
        }
    }

    /// `installHwpRecovery(host)` without the registry (the caller registers its contract)
    pub fn install_hwp_recovery(&mut self, host: Rc<dyn HwpRecoveryHost>) {
        self.host = Some(host);
    }

    /// `host.savePathOf(wcId)` with the truthiness the TypeScript tests it by
    fn save_path(&self, wc_id: i64) -> Option<String> {
        self.host
            .as_ref()?
            .save_path_of(wc_id)
            .filter(|path| !path.is_empty())
    }

    /// the document's copy identity: its file, or the untitled slot of this view
    pub fn hwp_recovery_identity_of<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        wc_id: i64,
    ) -> Option<RecoveryIdentity> {
        let host = self.host.as_ref()?;
        if let Some(path) = self.save_path(wc_id) {
            return Some(file_identity(&path));
        }
        if let Some(identity) = self.untitled_identity.get(&wc_id) {
            return Some(identity.clone());
        }
        // a new document's copy follows the format its first save would offer
        let format = match host.untitled_copy_of(wc_id) {
            Some(copy) => copy.format,
            None => match read_hwp_default_format(&UserDataOnly(e.user_data_dir())) {
                HwpDefaultFormat::Hwp => HwpFormat::Hwp,
                HwpDefaultFormat::Hwpx => HwpFormat::Hwpx,
            },
        };
        let identity = RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
            kind: "hwp".to_owned(),
            untitled_id: new_untitled_recovery_id(&|| e.random_uuid()),
            ext: format!(".{}", format.as_str()),
        });
        self.untitled_identity.insert(wc_id, identity.clone());
        Some(identity)
    }

    /// The recovery copy slot of the document in this tab; None for a view this editor
    /// does not track.
    pub fn hwp_recovery_identity<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        wc_id: i64,
    ) -> Option<RecoveryIdentity> {
        if self.contents.contains(&wc_id) {
            self.hwp_recovery_identity_of(e, wc_id)
        } else {
            None
        }
    }

    /// the format a save of this view writes
    fn format_of(&self, wc_id: i64, identity: &RecoveryIdentity) -> HwpFormat {
        match identity {
            RecoveryIdentity::Untitled(untitled) => format_of_ext(&untitled.ext),
            RecoveryIdentity::File(file) => hwp_format_of_path(&file.file_path)
                .or_else(|| {
                    self.host
                        .as_ref()
                        .and_then(|host| host.untitled_copy_of(wc_id))
                        .map(|copy| copy.format)
                })
                .unwrap_or(HwpFormat::Hwp),
        }
    }

    fn title_of<E: HwpRecoveryElectron>(
        &self,
        e: &E,
        wc_id: i64,
        identity: &RecoveryIdentity,
    ) -> String {
        if let RecoveryIdentity::File(file) = identity {
            return basename(&file.file_path, None);
        }
        if let Some(named) = self.title.get(&wc_id).filter(|title| !title.is_empty()) {
            return named.clone();
        }
        match self
            .host
            .as_ref()
            .and_then(|host| host.untitled_copy_of(wc_id))
        {
            Some(copy) => {
                let stripped = strip_hwp_ext(&copy.name);
                if stripped.is_empty() {
                    copy.name.clone()
                } else {
                    stripped.to_owned()
                }
            }
            None => tm(normalize_lang(Some(&e.ui_lang())), "untitledFile", None),
        }
    }

    /// the title a new document's copy is listed under: the tab's (the shell knows it)
    pub fn set_hwp_recovery_title(&mut self, wc_id: i64, title: &str) {
        if !trim(title).is_empty() {
            self.title.insert(wc_id, title.to_owned());
        }
    }

    /// the first Save As suggestion for this view, when it differs from the usual one
    pub fn hwp_recovery_save_as_default(&self, wc_id: i64) -> Option<String> {
        self.save_as_default.get(&wc_id).cloned()
    }

    /// the renderer took its queued path
    pub fn note_hwp_path_consumed(&mut self, wc_id: i64) {
        self.consumed.insert(wc_id);
    }

    fn reload_if_started<E: HwpRecoveryElectron>(&self, e: &E, wc_id: i64) {
        if self.consumed.contains(&wc_id) && !e.is_destroyed(wc_id) {
            e.reload(wc_id);
        }
    }

    /// Before a view reads `path`: settle a recovery copy left for that file. Answers the
    /// copy's bytes when the view is to show them instead of the file, None for the file.
    /// The caller still reads the original to keep what saves correct against.
    pub fn hwp_recovery_on_read<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        shared: &SharedRecoveryState,
        wc_id: i64,
        path: &str,
    ) -> Option<Vec<u8>> {
        let host = self.host.clone()?;
        // a headless export converts the file on disk; it neither asks about a copy left for
        // that file (there is no one to answer) nor uses or settles it
        if e.is_headless_mode() {
            return None;
        }
        // an untitled copy (a template's, or a recovery copy opened as a new document)
        if self.save_path(wc_id).is_none() {
            if self.untitled_restore.contains(&wc_id)
                && let Some(identity) = self.untitled_identity.get(&wc_id)
            {
                self.restored.insert(wc_id);
                self.owns_copy.insert(wc_id);
                // the TypeScript does not catch a failure here: the copy then stays as it is
                if let Err(err) = with_store(e, shared, |store| store.mark_copy_loaded(identity)) {
                    e.warn(&format!(
                        "[hwp] could not mark the recovery copy loaded: {}",
                        err.message
                    ));
                }
                host.mark_dirty(wc_id);
            }
            return None;
        }
        self.loaded_path.insert(wc_id, path.to_owned());
        self.blocked.remove(&wc_id);
        let identity = file_identity(path);
        let settled: Result<Option<Vec<u8>>, NodeError> = (|| {
            let wanted = self.decision.get(&wc_id);
            let decision = match wanted {
                Some((wanted_path, decision)) if wanted_path == path => Some(*decision),
                _ => None,
            };
            if decision == Some(RecoveryOpenDecision::Original) {
                return Ok(None);
            }
            // the other pane of a split shows the file as it is on disk, as it always did
            if decision.is_none()
                && self
                    .loaded_path
                    .iter()
                    .any(|(id, other)| *id != wc_id && other == path)
            {
                return Ok(None);
            }
            let mut bytes: Option<Vec<u8>> = None;
            if decision == Some(RecoveryOpenDecision::Restore) {
                bytes = with_store(e, shared, |store| store.read_copy(&identity));
                if bytes.is_some() {
                    with_store(e, shared, |store| store.mark_copy_loaded(&identity))?;
                }
            } else {
                let parent = e.parent_of(wc_id);
                let lang = e.ui_lang();
                let result = with_store(e, shared, |store| {
                    resolve_recovery_on_open(&ResolveRecoveryOnOpenOptions {
                        store,
                        identity: &identity,
                        dialog: e.dialog(),
                        parent: parent.as_ref(),
                        lang: &lang,
                        document_name: None,
                    })
                })?;
                let action = match result {
                    RecoveryOpenResult::Restore { bytes: copy, .. } => {
                        bytes = Some(copy);
                        RecoveryOpenDecision::Restore
                    }
                    RecoveryOpenResult::Original => RecoveryOpenDecision::Original,
                };
                // asked once: a reload of this view does not ask again
                self.decision.insert(wc_id, (path.to_owned(), action));
            }
            Ok(bytes)
        })();
        match settled {
            Ok(None) => None,
            Ok(Some(bytes)) => {
                self.restored.insert(wc_id);
                self.owns_copy.insert(wc_id);
                host.mark_dirty(wc_id);
                Some(bytes)
            }
            Err(err) => {
                // the old copy stays as it is; this view writes none over it
                self.blocked.insert(wc_id);
                e.warn(&format!(
                    "[hwp] could not settle the recovery copy: {}",
                    err.message
                ));
                None
            }
        }
    }

    /// The copy of `identity` was removed: other views on the same file (the other pane of
    /// a split) may hold unsaved changes it was keeping, so their next turn writes it again.
    /// True when there was such a view.
    fn reset_others_on<E: HwpRecoveryElectron>(
        &self,
        e: &E,
        store: &RecoveryStore<'_>,
        identity: &RecoveryIdentity,
        wc_id: i64,
    ) -> Result<bool, NodeError> {
        if is_untitled_identity(identity) {
            return Ok(false);
        }
        let slot = store.copy_path(identity)?;
        let mut shared = false;
        for &other_id in &self.contents {
            if other_id == wc_id || e.is_destroyed(other_id) {
                continue;
            }
            if let Some(other) = self.saved_identity(other_id)
                && store.copy_path(&other)? == slot
            {
                e.send_recovery_reset(other_id);
                shared = true;
            }
        }
        Ok(shared)
    }

    /// delete the copy of `identity` for this view, and tell the views that shared it
    fn drop_copy<E: HwpRecoveryElectron>(
        &self,
        e: &E,
        store: &RecoveryStore<'_>,
        wc_id: i64,
        identity: &RecoveryIdentity,
        reason: RecoveryDeleteReason,
    ) -> Result<(), NodeError> {
        if store.delete_copy(identity, reason)? != RecoveryDeleteResult::Deleted {
            return Ok(());
        }
        // "Don't Save" blocks the copy until the window's close is cancelled; the other
        // pane's edits were not thrown away, so its copies go on
        if self.reset_others_on(e, store, identity, wc_id)?
            && reason == RecoveryDeleteReason::DontSave
        {
            store.clear_discarded(identity)?;
        }
        Ok(())
    }

    /// The view's file was renamed on disk (hwp-main has moved its save path already): the
    /// copy it wrote or loaded moves to the new name's slot, so a save or a clean close
    /// removes it and the old name's copy does not come back at the next launch.
    pub fn hwp_recovery_file_renamed<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        shared: &SharedRecoveryState,
        wc_id: i64,
        old_path: &str,
        new_path: &str,
    ) {
        if self.loaded_path.get(&wc_id).map(String::as_str) == Some(old_path) {
            self.loaded_path.insert(wc_id, new_path.to_owned());
        }
        if let Some((path, _)) = self.decision.get_mut(&wc_id)
            && path == old_path
        {
            *path = new_path.to_owned();
        }
        let saved_here = self
            .host
            .as_ref()
            .and_then(|host| host.save_path_of(wc_id))
            .as_deref()
            == Some(new_path);
        if !self.owns_copy.contains(&wc_id) || !saved_here {
            return;
        }
        let from = file_identity(old_path);
        let to = file_identity(new_path);
        let moved = with_store(e, shared, |store| -> Result<(), NodeError> {
            if let Some(bytes) = store.read_copy(&from) {
                store.write_copy(
                    &to,
                    &bytes,
                    &RecoveryWriteOptions {
                        title: Some(basename(new_path, None)),
                        ..RecoveryWriteOptions::default()
                    },
                )?;
            }
            Ok(())
        });
        if let Err(err) = moved {
            e.warn(&format!(
                "[hwp] the recovery copy could not follow the renamed file: {}",
                err.message
            ));
            return;
        }
        // the content lives under the new name now; the old entry would only offer it twice
        if let Err(err) = with_store(e, shared, |store| {
            store.delete_copy(&from, RecoveryDeleteReason::Discarded)
        }) {
            e.warn(&format!(
                "[hwp] could not remove the old recovery copy: {}",
                err.message
            ));
        }
        // a turn that landed under the new name while the copy moved is older than what the
        // editor holds: the next turn writes the copy again
        if !e.is_destroyed(wc_id) {
            e.send_recovery_reset(wc_id);
        }
    }

    /// the identity a save starts from: its copy is removed once the save has landed
    pub fn hwp_recovery_before_save<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        wc_id: i64,
    ) -> Option<RecoveryIdentity> {
        self.hwp_recovery_identity_of(e, wc_id)
    }

    /// a save landed: the document's copy goes, and the document is the saved file from now on
    pub fn hwp_recovery_saved<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        shared: &SharedRecoveryState,
        wc_id: i64,
        before: Option<RecoveryIdentity>,
    ) {
        self.turn.remove(&wc_id);
        self.restored.remove(&wc_id);
        self.untitled_restore.remove(&wc_id);
        self.save_as_default.remove(&wc_id);
        // the copy is gone with the save: a clean close of this view has nothing of its own to remove
        self.owns_copy.remove(&wc_id);
        if let Some(before) = before
            && let Err(err) = with_store(e, shared, |store| {
                self.drop_copy(e, store, wc_id, &before, RecoveryDeleteReason::Saved)
            })
        {
            e.warn(&format!(
                "[hwp] could not remove the recovery copy: {}",
                err.message
            ));
        }
        self.untitled_identity.remove(&wc_id);
        self.title.remove(&wc_id);
    }

    /// The user chose "Don't Save" (or a tool closed the document without saving): the
    /// copy goes. No new copy is taken while the tab closes.
    pub fn hwp_recovery_dont_save<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        shared: &SharedRecoveryState,
        wc_id: i64,
    ) {
        let identity = self.hwp_recovery_identity_of(e, wc_id);
        self.turn.remove(&wc_id);
        if let Some(identity) = identity
            && let Err(err) = with_store(e, shared, |store| {
                self.drop_copy(e, store, wc_id, &identity, RecoveryDeleteReason::DontSave)
            })
        {
            e.warn(&format!(
                "[hwp] could not remove the recovery copy: {}",
                err.message
            ));
        }
        if self.dont_save.contains(&wc_id) {
            e.clear_timeout(RecoveryTimer::DontSave(wc_id));
        }
        self.dont_save.insert(wc_id);
        e.set_timeout(RecoveryTimer::DontSave(wc_id), DONT_SAVE_HOLD_MS);
    }

    /// the `DONT_SAVE_HOLD_MS` timer of `hwp_recovery_dont_save` fired
    pub fn dont_save_hold_ended<E: HwpRecoveryElectron>(&mut self, e: &E, wc_id: i64) {
        // a view that was destroyed cleared its timer: nothing to do then
        if !self.dont_save.remove(&wc_id) {
            return;
        }
        // the tab may stay open: its unsaved changes need a copy again once the store
        // takes it (the window's close was cancelled)
        if !e.is_destroyed(wc_id) {
            e.send_recovery_reset(wc_id);
        }
    }

    /// `trackHwpRecovery(wc)`: follow a view's lifetime; called before hwp-main's own
    /// teardown is registered.
    pub fn track_hwp_recovery(&mut self, wc_id: i64) {
        if !self.contents.contains(&wc_id) {
            self.contents.push(wc_id);
        }
    }

    /// the view's `render-process-gone` listener
    pub fn render_process_gone(&mut self, wc_id: i64) {
        self.crashed.insert(wc_id);
    }

    /// the view's `once('destroyed')` listener
    pub fn destroyed<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        shared: &SharedRecoveryState,
        wc_id: i64,
    ) {
        let identity = self
            .saved_identity(wc_id)
            .or_else(|| self.untitled_identity.get(&wc_id).cloned());
        let settled = identity.map(|identity| {
            let reason = if self.dont_save.contains(&wc_id) {
                // a copy that landed while the tab was closing goes too
                Some(RecoveryDeleteReason::DontSave)
            } else if self.owns_copy.contains(&wc_id)
                && !self.crashed.contains(&wc_id)
                && self.host.as_ref().is_none_or(|host| !host.is_dirty(wc_id))
            {
                // closed with nothing unsaved; the store keeps it while the app is ending
                Some(RecoveryDeleteReason::ClosedClean)
            } else {
                None
            };
            match reason {
                Some(reason) => with_store(e, shared, |store| {
                    self.drop_copy(e, store, wc_id, &identity, reason)
                }),
                None => Ok(()),
            }
        });
        if let Some(Err(err)) = settled {
            e.warn(&format!(
                "[hwp] could not settle the recovery copy on close: {}",
                err.message
            ));
        }
        if self.dont_save.remove(&wc_id) {
            e.clear_timeout(RecoveryTimer::DontSave(wc_id));
        }
        self.contents.retain(|id| *id != wc_id);
        self.untitled_identity.remove(&wc_id);
        self.title.remove(&wc_id);
        self.save_as_default.remove(&wc_id);
        self.decision.remove(&wc_id);
        self.turn.remove(&wc_id);
        self.loaded_path.remove(&wc_id);
        self.consumed.remove(&wc_id);
        self.untitled_restore.remove(&wc_id);
        self.restored.remove(&wc_id);
        self.owns_copy.remove(&wc_id);
        self.unprotectable.remove(&wc_id);
        self.notice_shown.remove(&wc_id);
        self.crashed.remove(&wc_id);
        self.blocked.remove(&wc_id);
    }

    fn saved_identity(&self, wc_id: i64) -> Option<RecoveryIdentity> {
        self.save_path(wc_id).map(|path| file_identity(&path))
    }

    /// why this view may not take a copy now
    fn copy_barred<E: HwpRecoveryElectron>(&self, e: &E, wc_id: i64) -> bool {
        // a headless export's hidden view converts the file and goes; it keeps no copy
        if e.is_headless_mode() {
            return true;
        }
        self.unprotectable.contains(&wc_id)
            || self.dont_save.contains(&wc_id)
            || self.blocked.contains(&wc_id)
    }

    /// `hwp:recovery-begin`
    pub fn recovery_begin<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        shared: &SharedRecoveryState,
        wc_id: i64,
    ) -> RecoveryBeginResult {
        self.turn.remove(&wc_id);
        if self.copy_barred(e, wc_id) {
            return RecoveryBeginResult::Refused;
        }
        let Some(identity) = self.hwp_recovery_identity_of(e, wc_id) else {
            return RecoveryBeginResult::Refused;
        };
        // the ticket is taken before the export: a save that lands meanwhile wins
        let ticket = match with_store(e, shared, |store| store.begin_write(&identity)) {
            Ok(ticket) => ticket,
            Err(err) => {
                e.warn(&format!(
                    "[hwp] could not begin the recovery copy: {}",
                    err.message
                ));
                return RecoveryBeginResult::Refused;
            }
        };
        let format = self.format_of(wc_id, &identity);
        self.turn.insert(wc_id, (ticket, format));
        RecoveryBeginResult::Began(format)
    }

    /// `turnByWc.has(wcId)`: the view began a turn it has not written. The
    /// check `hwp:recovery-new-tabs` makes before it reads the bytes, for a
    /// caller that reads them off this thread.
    pub fn has_turn(&self, wc_id: i64) -> bool {
        self.turn.contains_key(&wc_id)
    }

    /// `hwp:recovery-new-tabs`. `data`: Some only for a Uint8Array argument (the caller
    /// checks instanceof); `format`: Some only for a string
    pub fn recovery_new_tabs(
        &self,
        wc_id: i64,
        data: Option<&[u8]>,
        format: Option<&str>,
    ) -> Vec<TabSpot> {
        if !self.turn.contains_key(&wc_id) {
            return Vec::new();
        }
        match valid_bytes(data, format) {
            Some((data, format)) => new_tabs_of(data, format),
            None => Vec::new(),
        }
    }

    /// `hwp:recovery-write` up to `applySaveFixes`: takes the turn, runs every check; Err
    /// is the answer
    pub fn recovery_write_check<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        shared: &SharedRecoveryState,
        wc_id: i64,
        data: Option<&[u8]>,
        format: Option<&str>,
    ) -> Result<RecoveryWriteJob, RecoveryWriteOutcome> {
        let turn = self.turn.remove(&wc_id);
        let (Some((ticket, turn_format)), Some(host)) = (turn, self.host.clone()) else {
            return Err(RecoveryWriteOutcome::Superseded);
        };
        if self.copy_barred(e, wc_id) || e.is_destroyed(wc_id) {
            return Err(RecoveryWriteOutcome::Refused);
        }
        match valid_bytes(data, format) {
            Some((_, format)) if format == turn_format => {}
            _ => return Err(RecoveryWriteOutcome::Refused),
        }
        let Some(identity) = self.hwp_recovery_identity_of(e, wc_id) else {
            return Err(RecoveryWriteOutcome::Refused);
        };
        // the document moved to another identity (Save As) since the turn began
        let current = with_store(e, shared, |store| store.begin_write(&identity));
        match current {
            Ok(current) if current.key != ticket.key => {
                return Err(RecoveryWriteOutcome::Superseded);
            }
            Ok(_) => {}
            Err(err) => {
                e.warn(&format!(
                    "[hwp] could not write the recovery copy: {}",
                    err.message
                ));
                return Err(RecoveryWriteOutcome::Refused);
            }
        }
        let title = self.title_of(e, wc_id, &identity);
        Ok(RecoveryWriteJob {
            format: turn_format,
            base: host.save_base_of(wc_id),
            identity,
            ticket,
            title,
        })
    }

    /// the rest of `hwp:recovery-write`, with `applySaveFixes(...).bytes` the caller
    /// computed (on a worker) from the job
    pub fn recovery_write_land<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        shared: &SharedRecoveryState,
        wc_id: i64,
        job: RecoveryWriteJob,
        fixed: &[u8],
    ) -> RecoveryWriteOutcome {
        let result = with_store(e, shared, |store| {
            store.write_copy(
                &job.identity,
                fixed,
                &RecoveryWriteOptions {
                    title: Some(job.title.clone()),
                    ticket: Some(job.ticket.clone()),
                    ..RecoveryWriteOptions::default()
                },
            )
        });
        match result {
            Ok(RecoveryWriteResult::Written) => {
                self.owns_copy.insert(wc_id);
                RecoveryWriteOutcome::Written
            }
            Ok(RecoveryWriteResult::Superseded) => RecoveryWriteOutcome::Superseded,
            Err(err) => {
                e.warn(&format!(
                    "[hwp] could not write the recovery copy: {}",
                    err.message
                ));
                RecoveryWriteOutcome::Refused
            }
        }
    }

    /// check, `applySaveFixes`, land: for tests and callers that stay on one thread
    pub fn recovery_write<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        shared: &SharedRecoveryState,
        wc_id: i64,
        data: Option<&[u8]>,
        format: Option<&str>,
        tabs: Option<&[Value]>,
    ) -> RecoveryWriteOutcome {
        let job = match self.recovery_write_check(e, shared, wc_id, data, format) {
            Ok(job) => job,
            Err(outcome) => return outcome,
        };
        // the check succeeded, so `data` is a whole document
        let data = data.unwrap_or_default();
        let fixed = apply_save_fixes(data, job.format, tabs, &job.base).bytes;
        self.recovery_write_land(e, shared, wc_id, job, &fixed)
    }

    /// `hwp:recovery-opened`; `password_protected`: the argument `=== true`
    pub fn recovery_opened<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        wc_id: i64,
        password_protected: bool,
    ) -> RecoveryOpenedResult {
        let mut notice = None;
        if password_protected {
            self.unprotectable.insert(wc_id);
            if self.notice_shown.insert(wc_id) {
                notice = Some(unprotectable_notice_text(&e.ui_lang()));
            }
        }
        RecoveryOpenedResult {
            restored: self.restored.contains(&wc_id),
            notice,
        }
    }

    /// `hwp:recovery-flushed` with a number token; true when it settled a waiter
    pub fn recovery_flushed<E: HwpRecoveryElectron>(&mut self, e: &E, token: f64) -> bool {
        // a Map keyed by number finds only the integers it was given
        if !(token.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&token)) {
            return false;
        }
        let token = token as u64;
        if !self.flush_waiters.remove(&token) {
            return false;
        }
        e.clear_timeout(RecoveryTimer::Flush(token));
        true
    }

    /// the `FLUSH_TIMEOUT_MS` timer of a flush fired; true when it settled a waiter
    pub fn flush_timed_out(&mut self, token: u64) -> bool {
        self.flush_waiters.remove(&token)
    }

    /// `flushOne`: the token waited for, or None when the view could not take the flush
    fn flush_one<E: HwpRecoveryElectron>(&mut self, e: &E, wc_id: i64) -> Option<u64> {
        let token = self.next_flush_token;
        self.next_flush_token += 1;
        e.set_timeout(RecoveryTimer::Flush(token), FLUSH_TIMEOUT_MS);
        self.flush_waiters.insert(token);
        match e.send_recovery_flush(wc_id, token) {
            Ok(()) => Some(token),
            Err(_) => {
                self.flush_waiters.remove(&token);
                e.clear_timeout(RecoveryTimer::Flush(token));
                None
            }
        }
    }

    /// `writeCopiesNow`: sends a flush to every due view; answers the tokens now waited
    /// for (the caller's `Promise.all` is done when each was settled by `recovery_flushed`
    /// or `flush_timed_out`)
    pub fn write_copies_now<E: HwpRecoveryElectron>(&mut self, e: &E) -> Vec<u64> {
        let due: Vec<i64> = self
            .contents
            .iter()
            .copied()
            .filter(|&id| {
                !e.is_destroyed(id)
                    && self.host.as_ref().is_some_and(|host| host.is_dirty(id))
                    && !self.copy_barred(e, id)
            })
            .collect();
        due.into_iter()
            .filter_map(|id| self.flush_one(e, id))
            .collect()
    }

    /// `openFileWithDecision`
    pub fn open_file_with_decision<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        wc_id: i64,
        request: &RecoveryOpenFileRequest,
    ) {
        let Some(host) = self.host.clone() else {
            return;
        };
        if e.is_destroyed(wc_id) {
            return;
        }
        self.decision
            .insert(wc_id, (request.file_path.clone(), request.decision));
        if host.open_path_of(wc_id).as_deref() != Some(request.file_path.as_str()) {
            host.queue_file(wc_id, &request.file_path);
        }
        self.reload_if_started(e, wc_id);
    }

    /// `openUntitledCopy`
    pub fn open_untitled_copy<E: HwpRecoveryElectron>(
        &mut self,
        e: &E,
        shared: &SharedRecoveryState,
        wc_id: i64,
        request: &RecoveryOpenUntitledRequest,
    ) {
        let Some(host) = self.host.clone() else {
            return;
        };
        if e.is_destroyed(wc_id) {
            return;
        }
        let path = match with_store(e, shared, |store| store.copy_path(&request.copy)) {
            Ok(path) => path,
            Err(err) => {
                e.warn(&format!(
                    "[hwp] could not open the recovery copy: {}",
                    err.message
                ));
                return;
            }
        };
        let ext = extname(&path).to_lowercase();
        self.untitled_identity.insert(wc_id, request.copy.clone());
        self.title.insert(wc_id, request.title.clone());
        match request
            .save_as_default_path
            .as_ref()
            .filter(|path| !path.is_empty())
        {
            Some(default) => {
                self.save_as_default.insert(wc_id, default.clone());
            }
            None => {
                self.save_as_default.remove(&wc_id);
            }
        }
        self.untitled_restore.insert(wc_id);
        host.queue_untitled_copy(
            wc_id,
            &path,
            UntitledCopy {
                name: format!("{}{ext}", request.title),
                format: format_of_ext(&ext),
            },
        );
        self.reload_if_started(e, wc_id);
    }

    /// `isUnprotectable`
    pub fn is_unprotectable(&self, wc_id: i64) -> bool {
        self.unprotectable.contains(&wc_id)
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;
    use crate::packages::electron_utils::message_box::MessageBoxOptions;

    const PK: [u8; 4] = [0x50, 0x4b, 0x03, 0x04];

    fn zip_bytes(tag: u8) -> Vec<u8> {
        let mut bytes = PK.to_vec();
        bytes.extend_from_slice(&[tag; 12]);
        bytes
    }

    struct FakeWindow;
    impl ParentWindow for FakeWindow {
        fn is_destroyed(&self) -> bool {
            false
        }
    }

    struct FakeDialog {
        answer: Cell<f64>,
        asked: Cell<u32>,
    }
    impl MessageBox<FakeWindow> for FakeDialog {
        fn show_message_box_over(&self, _: &FakeWindow, options: &MessageBoxOptions) -> f64 {
            self.show_message_box(options)
        }
        fn show_message_box(&self, _: &MessageBoxOptions) -> f64 {
            self.asked.set(self.asked.get() + 1);
            self.answer.get()
        }
    }

    struct FakeElectron {
        dir: PathBuf,
        headless: Cell<bool>,
        destroyed: RefCell<HashSet<i64>>,
        resets: RefCell<Vec<i64>>,
        flushes: RefCell<Vec<(i64, u64)>>,
        reloads: RefCell<Vec<i64>>,
        timers: RefCell<Vec<(RecoveryTimer, bool)>>,
        warns: RefCell<Vec<String>>,
        uuid: Cell<u32>,
        dialog: FakeDialog,
    }

    impl FakeElectron {
        fn new() -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "seuoffice-hwp-recovery-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            FakeElectron {
                dir,
                headless: Cell::new(false),
                destroyed: RefCell::new(HashSet::new()),
                resets: RefCell::new(Vec::new()),
                flushes: RefCell::new(Vec::new()),
                reloads: RefCell::new(Vec::new()),
                timers: RefCell::new(Vec::new()),
                warns: RefCell::new(Vec::new()),
                uuid: Cell::new(0),
                dialog: FakeDialog {
                    answer: Cell::new(0.0),
                    asked: Cell::new(0),
                },
            }
        }

        fn path(&self, name: &str) -> String {
            self.dir.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for FakeElectron {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl HwpRecoveryElectron for FakeElectron {
        type Window = FakeWindow;
        type Dialog = FakeDialog;
        fn is_destroyed(&self, wc_id: i64) -> bool {
            self.destroyed.borrow().contains(&wc_id)
        }
        fn send_recovery_reset(&self, wc_id: i64) {
            self.resets.borrow_mut().push(wc_id);
        }
        fn send_recovery_flush(&self, wc_id: i64, token: u64) -> Result<(), String> {
            self.flushes.borrow_mut().push((wc_id, token));
            Ok(())
        }
        fn reload(&self, wc_id: i64) {
            self.reloads.borrow_mut().push(wc_id);
        }
        fn is_headless_mode(&self) -> bool {
            self.headless.get()
        }
        fn ui_lang(&self) -> String {
            "en".to_owned()
        }
        fn user_data_dir(&self) -> String {
            self.dir.join("userData").to_string_lossy().into_owned()
        }
        fn now_ms(&self) -> f64 {
            1_700_000_000_000.0
        }
        fn random_uuid(&self) -> String {
            self.uuid.set(self.uuid.get() + 1);
            format!("00000000-0000-4000-8000-{:012}", self.uuid.get())
        }
        fn dialog(&self) -> &FakeDialog {
            &self.dialog
        }
        fn parent_of(&self, _: i64) -> Option<FakeWindow> {
            Some(FakeWindow)
        }
        fn set_timeout(&self, timer: RecoveryTimer, _: f64) {
            self.timers.borrow_mut().push((timer, true));
        }
        fn clear_timeout(&self, timer: RecoveryTimer) {
            self.timers.borrow_mut().push((timer, false));
        }
        fn warn(&self, message: &str) {
            self.warns.borrow_mut().push(message.to_owned());
        }
    }

    #[derive(Default)]
    struct FakeHost {
        save_paths: RefCell<BTreeMap<i64, String>>,
        untitled: RefCell<BTreeMap<i64, UntitledCopy>>,
        open_paths: RefCell<BTreeMap<i64, String>>,
        dirty: RefCell<HashSet<i64>>,
        queued: RefCell<Vec<(i64, String, Option<UntitledCopy>)>>,
    }

    impl HwpRecoveryHost for FakeHost {
        fn save_path_of(&self, wc_id: i64) -> Option<String> {
            self.save_paths.borrow().get(&wc_id).cloned()
        }
        fn untitled_copy_of(&self, wc_id: i64) -> Option<UntitledCopy> {
            self.untitled.borrow().get(&wc_id).cloned()
        }
        fn open_path_of(&self, wc_id: i64) -> Option<String> {
            self.open_paths.borrow().get(&wc_id).cloned()
        }
        fn save_base_of(&self, _: i64) -> SaveBase {
            SaveBase::default()
        }
        fn is_dirty(&self, wc_id: i64) -> bool {
            self.dirty.borrow().contains(&wc_id)
        }
        fn mark_dirty(&self, wc_id: i64) {
            self.dirty.borrow_mut().insert(wc_id);
        }
        fn queue_file(&self, wc_id: i64, path: &str) {
            self.open_paths.borrow_mut().insert(wc_id, path.to_owned());
            self.queued
                .borrow_mut()
                .push((wc_id, path.to_owned(), None));
        }
        fn queue_untitled_copy(&self, wc_id: i64, path: &str, copy: UntitledCopy) {
            self.queued
                .borrow_mut()
                .push((wc_id, path.to_owned(), Some(copy)));
        }
    }

    struct Rig {
        e: FakeElectron,
        host: Rc<FakeHost>,
        shared: SharedRecoveryState,
        rec: HwpRecovery,
    }

    fn rig() -> Rig {
        let host = Rc::new(FakeHost::default());
        let mut rec = HwpRecovery::new();
        rec.install_hwp_recovery(host.clone());
        Rig {
            e: FakeElectron::new(),
            host,
            shared: SharedRecoveryState::new("test-run"),
            rec,
        }
    }

    impl Rig {
        /// a tracked view saving to a file under the temp dir
        fn file_view(&mut self, wc_id: i64, name: &str) -> String {
            let path = self.e.path(name);
            self.host
                .save_paths
                .borrow_mut()
                .insert(wc_id, path.clone());
            self.rec.track_hwp_recovery(wc_id);
            path
        }

        fn copy_exists(&self, path: &str) -> bool {
            with_store(&self.e, &self.shared, |store| {
                store.read_copy(&file_identity(path)).is_some()
            })
        }

        fn begin_write(&mut self, wc_id: i64, bytes: &[u8]) -> RecoveryWriteOutcome {
            let began = self.rec.recovery_begin(&self.e, &self.shared, wc_id);
            let RecoveryBeginResult::Began(format) = began else {
                panic!("begin refused: {began:?}");
            };
            self.rec.recovery_write(
                &self.e,
                &self.shared,
                wc_id,
                Some(bytes),
                Some(format.as_str()),
                None,
            )
        }
    }

    #[test]
    fn job_is_send() {
        fn needs_send<T: Send>() {}
        needs_send::<RecoveryWriteJob>();
    }

    #[test]
    fn format_of_path_is_case_insensitive() {
        assert_eq!(hwp_format_of_path("/a/B.HWPX"), Some(HwpFormat::Hwpx));
        assert_eq!(hwp_format_of_path("a.Hwp"), Some(HwpFormat::Hwp));
        assert_eq!(hwp_format_of_path("a.hwpx.txt"), None);
    }

    #[test]
    fn begin_is_refused_when_barred() {
        let mut r = rig();
        r.file_view(1, "a.hwpx");
        r.e.headless.set(true);
        assert_eq!(
            r.rec.recovery_begin(&r.e, &r.shared, 1),
            RecoveryBeginResult::Refused
        );
        r.e.headless.set(false);
        assert_eq!(
            r.rec.recovery_begin(&r.e, &r.shared, 1),
            RecoveryBeginResult::Began(HwpFormat::Hwpx)
        );
        r.rec.recovery_opened(&r.e, 1, true);
        assert_eq!(
            r.rec.recovery_begin(&r.e, &r.shared, 1),
            RecoveryBeginResult::Refused
        );
        r.file_view(2, "b.hwp");
        r.rec.hwp_recovery_dont_save(&r.e, &r.shared, 2);
        assert_eq!(
            r.rec.recovery_begin(&r.e, &r.shared, 2),
            RecoveryBeginResult::Refused
        );
        r.file_view(3, "c.hwp");
        r.rec.blocked.insert(3);
        assert_eq!(
            r.rec.recovery_begin(&r.e, &r.shared, 3),
            RecoveryBeginResult::Refused
        );
    }

    #[test]
    fn write_then_save_removes_the_copy_and_resets_the_other_pane() {
        let mut r = rig();
        let path = r.file_view(1, "doc.hwpx");
        r.file_view(2, "doc.hwpx");
        assert_eq!(
            r.begin_write(1, &zip_bytes(1)),
            RecoveryWriteOutcome::Written
        );
        assert!(r.copy_exists(&path));
        let before = r.rec.hwp_recovery_before_save(&r.e, 1);
        r.rec.hwp_recovery_saved(&r.e, &r.shared, 1, before);
        assert!(!r.copy_exists(&path));
        assert_eq!(*r.e.resets.borrow(), vec![2]);
        assert!(r.e.warns.borrow().is_empty());
    }

    #[test]
    fn write_is_superseded_after_save_as() {
        let mut r = rig();
        r.rec.track_hwp_recovery(1);
        let began = r.rec.recovery_begin(&r.e, &r.shared, 1);
        assert_eq!(began, RecoveryBeginResult::Began(HwpFormat::Hwp));
        // Save As gave the untitled document a file
        r.host
            .save_paths
            .borrow_mut()
            .insert(1, r.e.path("saved.hwp"));
        let outcome = r.rec.recovery_write(
            &r.e,
            &r.shared,
            1,
            Some(&[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]),
            Some("hwp"),
            None,
        );
        assert_eq!(outcome, RecoveryWriteOutcome::Superseded);
        // a write without a turn is superseded too
        let again =
            r.rec
                .recovery_write(&r.e, &r.shared, 1, Some(&zip_bytes(1)), Some("hwpx"), None);
        assert_eq!(again, RecoveryWriteOutcome::Superseded);
    }

    #[test]
    fn write_is_refused_for_wrong_format_or_bytes() {
        let mut r = rig();
        r.file_view(1, "doc.hwpx");
        let write = |r: &mut Rig, data: Option<&[u8]>, format: Option<&str>| {
            assert!(matches!(
                r.rec.recovery_begin(&r.e, &r.shared, 1),
                RecoveryBeginResult::Began(_)
            ));
            r.rec.recovery_write(&r.e, &r.shared, 1, data, format, None)
        };
        let good = zip_bytes(2);
        assert_eq!(
            write(&mut r, Some(&good), Some("hwp")),
            RecoveryWriteOutcome::Refused
        );
        assert_eq!(
            write(&mut r, Some(b"not a zip"), Some("hwpx")),
            RecoveryWriteOutcome::Refused
        );
        assert_eq!(
            write(&mut r, Some(&[]), Some("hwpx")),
            RecoveryWriteOutcome::Refused
        );
        assert_eq!(
            write(&mut r, None, Some("hwpx")),
            RecoveryWriteOutcome::Refused
        );
        assert_eq!(
            write(&mut r, Some(&good), None),
            RecoveryWriteOutcome::Refused
        );
        assert_eq!(
            write(&mut r, Some(&good), Some("hwpx")),
            RecoveryWriteOutcome::Written
        );
        assert_eq!(RecoveryWriteOutcome::Written.as_str(), "written");
    }

    #[test]
    fn new_tabs_needs_a_turn() {
        let mut r = rig();
        r.file_view(1, "doc.hwpx");
        let good = zip_bytes(3);
        assert!(
            r.rec
                .recovery_new_tabs(1, Some(&good), Some("hwpx"))
                .is_empty()
        );
        r.rec.recovery_begin(&r.e, &r.shared, 1);
        // minimal bytes hold no tabs; the check is that it answers without a panic
        assert!(
            r.rec
                .recovery_new_tabs(1, Some(&good), Some("hwpx"))
                .is_empty()
        );
        assert!(r.rec.recovery_new_tabs(1, None, Some("hwpx")).is_empty());
    }

    /// `has_turn` and the check/land split a caller runs `applySaveFixes`
    /// between (off the core thread): what lands in that gap wins
    #[test]
    fn a_split_write_lands_unless_a_save_or_dont_save_came_between() {
        let mut r = rig();
        let path = r.file_view(1, "doc.hwpx");
        let bytes = zip_bytes(4);
        let check = |r: &mut Rig| {
            r.rec.recovery_begin(&r.e, &r.shared, 1);
            assert!(r.rec.has_turn(1));
            let job = r
                .rec
                .recovery_write_check(&r.e, &r.shared, 1, Some(&bytes), Some("hwpx"))
                .unwrap_or_else(|outcome| panic!("check refused: {outcome:?}"));
            // the check takes the turn, as the TypeScript's handler does first
            assert!(!r.rec.has_turn(1));
            job
        };
        assert!(!r.rec.has_turn(1));

        // nothing between: the copy lands with the bytes the caller fixed
        let job = check(&mut r);
        assert_eq!(job.format, HwpFormat::Hwpx);
        let fixed = zip_bytes(5);
        assert_eq!(
            r.rec.recovery_write_land(&r.e, &r.shared, 1, job, &fixed),
            RecoveryWriteOutcome::Written
        );
        let copy = with_store(&r.e, &r.shared, |s| s.read_copy(&file_identity(&path)));
        assert_eq!(copy, Some(fixed));

        // a save landed between: the older bytes do not come back
        let job = check(&mut r);
        let before = r.rec.hwp_recovery_before_save(&r.e, 1);
        r.rec.hwp_recovery_saved(&r.e, &r.shared, 1, before);
        assert_eq!(
            r.rec
                .recovery_write_land(&r.e, &r.shared, 1, job, &zip_bytes(6)),
            RecoveryWriteOutcome::Superseded
        );
        assert!(!r.copy_exists(&path));

        // "Don't Save" between: neither
        let job = check(&mut r);
        r.rec.hwp_recovery_dont_save(&r.e, &r.shared, 1);
        assert_eq!(
            r.rec
                .recovery_write_land(&r.e, &r.shared, 1, job, &zip_bytes(7)),
            RecoveryWriteOutcome::Superseded
        );
        assert!(!r.copy_exists(&path));

        // a check without a turn answers what the handler answers
        assert!(matches!(
            r.rec
                .recovery_write_check(&r.e, &r.shared, 1, Some(&bytes), Some("hwpx")),
            Err(RecoveryWriteOutcome::Superseded)
        ));
    }

    fn leave_copy(r: &Rig, path: &str, bytes: &[u8]) {
        with_store(&r.e, &r.shared, |store| {
            store
                .write_copy(
                    &file_identity(path),
                    bytes,
                    &RecoveryWriteOptions::default(),
                )
                .unwrap();
        });
    }

    #[test]
    fn on_read_asks_once_and_a_reload_does_not_ask_again() {
        let mut r = rig();
        let path = r.file_view(1, "doc.hwpx");
        let copy = zip_bytes(9);
        leave_copy(&r, &path, &copy);
        r.e.dialog.answer.set(0.0);
        let first = r.rec.hwp_recovery_on_read(&r.e, &r.shared, 1, &path);
        assert_eq!(first, Some(copy.clone()));
        assert_eq!(r.e.dialog.asked.get(), 1);
        assert!(r.host.is_dirty(1));
        let reloaded = r.rec.hwp_recovery_on_read(&r.e, &r.shared, 1, &path);
        assert_eq!(reloaded, Some(copy));
        assert_eq!(r.e.dialog.asked.get(), 1);
        assert!(r.rec.recovery_opened(&r.e, 1, false).restored);
    }

    #[test]
    fn on_read_discard_answers_the_file_and_deletes_the_copy() {
        let mut r = rig();
        let path = r.file_view(1, "doc.hwp");
        leave_copy(&r, &path, &zip_bytes(1));
        r.e.dialog.answer.set(1.0);
        assert_eq!(r.rec.hwp_recovery_on_read(&r.e, &r.shared, 1, &path), None);
        assert!(!r.copy_exists(&path));
        assert!(!r.host.is_dirty(1));
        // headless asks nothing
        r.e.headless.set(true);
        assert_eq!(r.rec.hwp_recovery_on_read(&r.e, &r.shared, 1, &path), None);
    }

    #[test]
    fn the_other_pane_reads_the_file_without_asking() {
        let mut r = rig();
        let path = r.file_view(1, "doc.hwpx");
        r.file_view(2, "doc.hwpx");
        leave_copy(&r, &path, &zip_bytes(4));
        assert!(
            r.rec
                .hwp_recovery_on_read(&r.e, &r.shared, 1, &path)
                .is_some()
        );
        assert_eq!(r.rec.hwp_recovery_on_read(&r.e, &r.shared, 2, &path), None);
        assert_eq!(r.e.dialog.asked.get(), 1);
    }

    #[test]
    fn restore_decision_returns_the_copy_and_marks_dirty() {
        let mut r = rig();
        let path = r.file_view(1, "doc.hwpx");
        let copy = zip_bytes(7);
        leave_copy(&r, &path, &copy);
        r.rec.note_hwp_path_consumed(1);
        r.rec.open_file_with_decision(
            &r.e,
            1,
            &RecoveryOpenFileRequest {
                file_path: path.clone(),
                decision: RecoveryOpenDecision::Restore,
            },
        );
        // the host had no queued path, so it was queued; the consumed view reloads
        assert_eq!(r.host.queued.borrow().len(), 1);
        assert_eq!(*r.e.reloads.borrow(), vec![1]);
        assert_eq!(
            r.rec.hwp_recovery_on_read(&r.e, &r.shared, 1, &path),
            Some(copy)
        );
        assert_eq!(r.e.dialog.asked.get(), 0);
        assert!(r.host.is_dirty(1));
        // an original decision loads the file
        r.rec.open_file_with_decision(
            &r.e,
            1,
            &RecoveryOpenFileRequest {
                file_path: path.clone(),
                decision: RecoveryOpenDecision::Original,
            },
        );
        assert_eq!(r.host.queued.borrow().len(), 1);
        assert_eq!(r.rec.hwp_recovery_on_read(&r.e, &r.shared, 1, &path), None);
    }

    #[test]
    fn dont_save_drops_the_copy_and_the_hold_timer_resets_only_while_alive() {
        let mut r = rig();
        let path = r.file_view(1, "doc.hwpx");
        assert_eq!(
            r.begin_write(1, &zip_bytes(1)),
            RecoveryWriteOutcome::Written
        );
        r.rec.hwp_recovery_dont_save(&r.e, &r.shared, 1);
        assert!(!r.copy_exists(&path));
        assert!(
            r.e.timers
                .borrow()
                .contains(&(RecoveryTimer::DontSave(1), true))
        );
        r.rec.dont_save_hold_ended(&r.e, 1);
        assert_eq!(*r.e.resets.borrow(), vec![1]);
        // the timer was spent
        r.rec.dont_save_hold_ended(&r.e, 1);
        assert_eq!(*r.e.resets.borrow(), vec![1]);
        // a destroyed view clears its timer: nothing is sent
        r.rec.hwp_recovery_dont_save(&r.e, &r.shared, 1);
        r.e.destroyed.borrow_mut().insert(1);
        r.rec.dont_save_hold_ended(&r.e, 1);
        assert_eq!(*r.e.resets.borrow(), vec![1]);
    }

    #[test]
    fn destroyed_drops_a_clean_owned_copy_but_keeps_a_crashed_one() {
        let mut r = rig();
        let clean = r.file_view(1, "clean.hwpx");
        let crashed = r.file_view(2, "crashed.hwpx");
        let dirty = r.file_view(3, "dirty.hwpx");
        for id in [1, 2, 3] {
            assert_eq!(
                r.begin_write(id, &zip_bytes(id as u8)),
                RecoveryWriteOutcome::Written
            );
        }
        r.host.mark_dirty(3);
        r.rec.render_process_gone(2);
        for id in [1, 2, 3] {
            r.rec.destroyed(&r.e, &r.shared, id);
        }
        assert!(!r.copy_exists(&clean));
        assert!(r.copy_exists(&crashed));
        assert!(r.copy_exists(&dirty));
        assert!(!r.rec.contents.contains(&1));
    }

    #[test]
    fn file_renamed_moves_the_copy() {
        let mut r = rig();
        let old = r.file_view(1, "old.hwpx");
        assert_eq!(
            r.begin_write(1, &zip_bytes(5)),
            RecoveryWriteOutcome::Written
        );
        let new = r.e.path("new.hwpx");
        r.host.save_paths.borrow_mut().insert(1, new.clone());
        r.rec
            .hwp_recovery_file_renamed(&r.e, &r.shared, 1, &old, &new);
        assert!(!r.copy_exists(&old));
        assert!(r.copy_exists(&new));
        assert_eq!(*r.e.resets.borrow(), vec![1]);
        assert!(r.e.warns.borrow().is_empty());
    }

    #[test]
    fn write_copies_now_flushes_dirty_views_and_tokens_settle() {
        let mut r = rig();
        for id in [1, 2, 3, 4] {
            r.file_view(id, &format!("{id}.hwpx"));
        }
        for id in [1, 2, 3] {
            r.host.mark_dirty(id);
        }
        r.rec.recovery_opened(&r.e, 3, true);
        let tokens = r.rec.write_copies_now(&r.e);
        assert_eq!(tokens, vec![1, 2]);
        assert_eq!(*r.e.flushes.borrow(), vec![(1, 1), (2, 2)]);
        assert!(r.rec.recovery_flushed(&r.e, 1.0));
        assert!(
            r.e.timers
                .borrow()
                .contains(&(RecoveryTimer::Flush(1), false))
        );
        // settled once
        assert!(!r.rec.recovery_flushed(&r.e, 1.0));
        assert!(!r.rec.recovery_flushed(&r.e, 1.5));
        assert!(r.rec.flush_timed_out(2));
        assert!(!r.rec.flush_timed_out(2));
    }

    #[test]
    fn opened_gives_the_notice_once() {
        let mut r = rig();
        r.rec.track_hwp_recovery(1);
        assert_eq!(
            r.rec.recovery_opened(&r.e, 1, false),
            RecoveryOpenedResult {
                restored: false,
                notice: None
            }
        );
        let first = r.rec.recovery_opened(&r.e, 1, true);
        assert!(first.notice.is_some());
        assert!(r.rec.is_unprotectable(1));
        assert_eq!(r.rec.recovery_opened(&r.e, 1, true).notice, None);
    }

    #[test]
    fn untitled_identity_follows_the_default_format_and_titles() {
        let mut r = rig();
        r.rec.track_hwp_recovery(1);
        std::fs::create_dir_all(r.e.user_data_dir()).unwrap();
        std::fs::write(
            r.e.dir.join("userData").join("app-settings.json"),
            r#"{"hwpDefaultFormat":"hwpx"}"#,
        )
        .unwrap();
        assert_eq!(
            r.rec.recovery_begin(&r.e, &r.shared, 1),
            RecoveryBeginResult::Began(HwpFormat::Hwpx)
        );
        // the slot is kept for the view
        let first = r.rec.hwp_recovery_identity(&r.e, 1);
        assert_eq!(first, r.rec.hwp_recovery_identity(&r.e, 1));
        assert_eq!(r.rec.hwp_recovery_identity(&r.e, 9), None);
        assert_eq!(r.rec.title_of(&r.e, 1, first.as_ref().unwrap()), "Untitled");
        r.host.untitled.borrow_mut().insert(
            1,
            UntitledCopy {
                name: "Memo.HWPX".into(),
                format: HwpFormat::Hwpx,
            },
        );
        assert_eq!(r.rec.title_of(&r.e, 1, first.as_ref().unwrap()), "Memo");
        r.rec.set_hwp_recovery_title(1, "   ");
        r.rec.set_hwp_recovery_title(1, "Tab");
        assert_eq!(r.rec.title_of(&r.e, 1, first.as_ref().unwrap()), "Tab");
    }

    #[test]
    fn open_untitled_copy_queues_the_copy_for_the_view() {
        let mut r = rig();
        r.rec.track_hwp_recovery(1);
        let copy = RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
            kind: "hwp".into(),
            untitled_id: "abc".into(),
            ext: ".hwpx".into(),
        });
        r.rec.open_untitled_copy(
            &r.e,
            &r.shared,
            1,
            &RecoveryOpenUntitledRequest {
                copy: copy.clone(),
                title: "Lost".into(),
                save_as_default_path: Some("/x/Lost.hwpx".into()),
            },
        );
        let queued = r.host.queued.borrow();
        let (_, path, untitled) = &queued[0];
        assert!(path.ends_with(".hwpx"));
        assert_eq!(
            untitled.as_ref().unwrap(),
            &UntitledCopy {
                name: "Lost.hwpx".into(),
                format: HwpFormat::Hwpx
            }
        );
        assert_eq!(
            r.rec.hwp_recovery_save_as_default(1).as_deref(),
            Some("/x/Lost.hwpx")
        );
        assert_eq!(r.rec.hwp_recovery_identity(&r.e, 1), Some(copy));
    }
}
