//! `packages/electron-utils/src/recovery-store.ts`: crash-recovery copies
//! shared by the editors and the shell.
//!
//! Layout under `<userData>`: `<kind>-autosave/<sha1(filePath)[0..16]><ext>`
//! (file copy), `<kind>-autosave/untitled/<id><ext>` (untitled copy), each
//! with a `.meta.json` beside it. See the TypeScript for the full rules.
//!
//! What differs from the TypeScript, and why it changes nothing a caller can
//! see:
//! - The process-wide state (`Symbol.for` on `globalThis`) is an explicit
//!   [`SharedRecoveryState`] the caller owns and passes to
//!   [`create_recovery_store`] and to the shutdown functions.
//! - Promises are plain calls. The per-document write queue of the
//!   TypeScript only orders asynchronous tasks; a sequence of plain calls is
//!   that order already. What interleaves in the TypeScript (a delete during
//!   the serialization of a streamed copy) is reached through the writer
//!   callback of [`RecoveryStore::write_copy_streamed`], which may call
//!   [`RecoveryStore::delete_copy`] on the same store, and through tickets
//!   taken earlier with [`RecoveryStore::begin_write`].
//! - `Date.now()`, `crypto.randomUUID()` and `userDataDir` come in through
//!   [`RecoveryStoreOptions`].

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::fs;

use jscompat::node_path::host::{basename, dirname, extname, is_absolute, join, relative, resolve};
use jscompat::{JsObject, JsonValue, js_regex, json_parse, random_uuid, sha1_hex};

use super::atomic_write::{
    atomic_move_file, atomic_write_file, temp_path_beside, write_json_atomic,
};
use crate::node_fs::{NodeError, node_error};

/// The editors that keep recovery copies, in folder order.
pub const RECOVERY_EDITOR_KINDS: [&str; 9] = [
    "docs", "sheets", "slides", "hwp", "pdf", "markdown", "html", "mindmap", "diagram",
];

/// `RecoveryEditorKind`. Not checked by the type: the TypeScript checks it at
/// run time (`assertKind`) because a kind may come from outside.
pub type RecoveryEditorKind = String;

/// copies whose file was untouched this long are removed at launch (tunable)
pub const RECOVERY_COPY_MAX_AGE_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// `RecoveryCopyState`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryCopyState {
    /// written since the user last chose anything
    Undecided,
    /// the user closed the launch list without choosing
    Later,
    /// "restore" was chosen in the launch list, the tab is not loaded yet
    RestoreChosen,
}

impl RecoveryCopyState {
    pub fn as_str(self) -> &'static str {
        match self {
            RecoveryCopyState::Undecided => "undecided",
            RecoveryCopyState::Later => "later",
            RecoveryCopyState::RestoreChosen => "restoreChosen",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "undecided" => Some(RecoveryCopyState::Undecided),
            "later" => Some(RecoveryCopyState::Later),
            "restoreChosen" => Some(RecoveryCopyState::RestoreChosen),
            _ => None,
        }
    }
}

/// a document with a file on disk
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryFileIdentity {
    pub kind: RecoveryEditorKind,
    pub file_path: String,
}

/// a document that was never saved; `ext` is the format its copy is written in
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryUntitledIdentity {
    pub kind: RecoveryEditorKind,
    pub untitled_id: String,
    /// lower-case, with the dot: '.docx', '.hwpx', '.md'
    pub ext: String,
}

/// `RecoveryIdentity`
#[derive(Debug, Clone, PartialEq)]
pub enum RecoveryIdentity {
    File(RecoveryFileIdentity),
    Untitled(RecoveryUntitledIdentity),
}

impl RecoveryIdentity {
    pub fn kind(&self) -> &str {
        match self {
            RecoveryIdentity::File(f) => &f.kind,
            RecoveryIdentity::Untitled(u) => &u.kind,
        }
    }
}

/// `RecoveryDeleteReason`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryDeleteReason {
    Saved,
    DontSave,
    Discarded,
    ClosedClean,
}

impl RecoveryDeleteReason {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "saved" => Some(RecoveryDeleteReason::Saved),
            "dontSave" => Some(RecoveryDeleteReason::DontSave),
            "discarded" => Some(RecoveryDeleteReason::Discarded),
            "closedClean" => Some(RecoveryDeleteReason::ClosedClean),
            _ => None,
        }
    }
}

/// `RecoveryLaunchDecision`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryLaunchDecision {
    Restore,
    Discard,
    Later,
}

impl RecoveryLaunchDecision {
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "restore" => Some(RecoveryLaunchDecision::Restore),
            "discard" => Some(RecoveryLaunchDecision::Discard),
            "later" => Some(RecoveryLaunchDecision::Later),
            _ => None,
        }
    }
}

/// `RecoveryCopyInfo`
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryCopyInfo {
    pub identity: RecoveryIdentity,
    pub kind: RecoveryEditorKind,
    /// `None` for an untitled document
    pub file_path: Option<String>,
    pub untitled_id: Option<String>,
    /// tab title at the last write; the file name for a legacy file copy
    pub title: String,
    /// last write in ms since the epoch (the copy's mtime for a legacy copy)
    pub written_at: f64,
    /// the run that wrote the copy; '' for a legacy copy
    pub run_id: String,
    pub state: RecoveryCopyState,
    /// true when the copy has no metadata (left by an earlier version)
    pub legacy: bool,
    pub copy_path: String,
    pub copy_mtime_ms: f64,
    /// the file on disk was modified after the copy was written
    pub file_changed_after_copy: bool,
    /// a path is known but no file is there
    pub original_missing: bool,
    /// an untitled copy's original file
    pub original_path: Option<String>,
    /// an untitled copy's ODS formula loss
    pub formulas_dropped: Option<f64>,
}

/// `RecoveryOpenPlan`
#[derive(Debug, Clone, PartialEq)]
pub enum RecoveryOpenPlan {
    None,
    Restore(RecoveryCopyInfo),
    Ask(RecoveryCopyInfo),
}

/// `RecoveryWriteTicket`: a snapshot of a document's delete epoch.
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryWriteTicket {
    pub key: String,
    pub epoch: u64,
}

/// `RecoveryWriteResult`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryWriteResult {
    Written,
    Superseded,
}

/// `deleteCopy`'s answer
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryDeleteResult {
    Deleted,
    Refused,
}

/// `RecoveryWriteOptions`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RecoveryWriteOptions {
    pub title: Option<String>,
    pub ticket: Option<RecoveryWriteTicket>,
    /// an untitled copy's original file; ignored for a file copy
    pub original_path: Option<String>,
    /// an untitled copy's ODS formula loss; ignored for a file copy
    pub formulas_dropped: Option<f64>,
}

/// `RecoveryCopyFilter`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RecoveryCopyFilter {
    pub states: Option<Vec<RecoveryCopyState>>,
    pub kinds: Option<Vec<RecoveryEditorKind>>,
    /// true: untitled copies only; false: file copies only
    pub untitled: Option<bool>,
}

/// `adoptUntitledCopy`'s options
#[derive(Debug, Clone, PartialEq)]
pub struct RecoveryAdoptOptions {
    pub title: String,
    pub ext: String,
    pub state: Option<RecoveryCopyState>,
    pub original_path: Option<String>,
}

// ---- process-wide state ----

/// `SharedRecoveryState`: the shutdown latch, delete epochs, the run id and
/// the "Don't Save" block. (The write queues of the TypeScript are not
/// needed: see the module comment.)
pub struct SharedRecoveryState {
    shutting_down: Cell<bool>,
    epochs: RefCell<HashMap<String, u64>>,
    run_id: String,
    /// documents (by write queue key) discarded with "Don't Save", see `delete_copy`
    discarded: RefCell<HashSet<String>>,
}

impl SharedRecoveryState {
    /// a state with the given run id (`randomBytes(8).toString('hex')` in the TypeScript)
    pub fn new(run_id: impl Into<String>) -> Self {
        SharedRecoveryState {
            shutting_down: Cell::new(false),
            epochs: RefCell::new(HashMap::new()),
            run_id: run_id.into(),
            discarded: RefCell::new(HashSet::new()),
        }
    }

    /// a state with a random run id: 16 hex digits
    pub fn with_random_run_id() -> Self {
        let hex: String = random_uuid()
            .chars()
            .filter(|c| *c != '-')
            .take(16)
            .collect();
        Self::new(hex)
    }
}

/// this process's run id, recorded in every copy it writes
pub fn recovery_run_id(shared: &SharedRecoveryState) -> &str {
    &shared.run_id
}

/// The app is ending: from now on the store refuses deletions except a
/// successful save and an explicit "Don't Save".
pub fn mark_app_shutting_down(shared: &SharedRecoveryState) {
    shared.shutting_down.set(true);
}

/// the quit was vetoed: deletions work normally again
pub fn reset_app_shutting_down(shared: &SharedRecoveryState) {
    shared.shutting_down.set(false);
}

pub fn is_app_shutting_down(shared: &SharedRecoveryState) -> bool {
    shared.shutting_down.get()
}

/// A close was cancelled: every document discarded with "Don't Save" while it
/// was being answered is still open with its edits, so its copies resume.
pub fn resume_discarded_copies(shared: &SharedRecoveryState) {
    shared.discarded.borrow_mut().clear();
}

// ---- addressing ----

const META_SUFFIX: &str = ".meta.json";
const UNTITLED_DIR: &str = "untitled";

fn ext_matches(text: &str) -> bool {
    js_regex!(r"^\.[a-z0-9]{1,10}$").test(text)
}

fn untitled_id_matches(text: &str) -> bool {
    js_regex!(r"^[A-Za-z0-9_-]{1,64}$").test(text)
}

fn file_copy_matches(name: &str) -> bool {
    js_regex!(r"^[0-9a-f]{16}\.[a-z0-9]{1,10}$").test(name)
}

fn untitled_copy_matches(name: &str) -> bool {
    js_regex!(r"^[A-Za-z0-9_-]{1,64}\.[a-z0-9]{1,10}$").test(name)
}

fn temp_matches(name: &str) -> bool {
    js_regex!(r"^.+\.[0-9a-f]{12}\.tmp$").test(name)
}

fn kind_default_ext(kind: &str) -> &'static str {
    match kind {
        "docs" => ".docx",
        "sheets" => ".xlsx",
        "slides" => ".pptx",
        "hwp" => ".hwp",
        "pdf" => ".pdf",
        "markdown" => ".md",
        "html" => ".html",
        "mindmap" => ".xmind",
        _ => ".drawio",
    }
}

pub fn recovery_folder_name(kind: &str) -> String {
    format!("{kind}-autosave")
}

/// a fresh id for an untitled document's copy; `random_uuid` is `crypto.randomUUID`
pub fn new_untitled_recovery_id(random_uuid: &dyn Fn() -> String) -> String {
    random_uuid()
}

pub fn is_untitled_identity(identity: &RecoveryIdentity) -> bool {
    matches!(identity, RecoveryIdentity::Untitled(_))
}

/// whether a kind is one of the editors that keep recovery copies
pub fn is_recovery_editor_kind(value: &str) -> bool {
    RECOVERY_EDITOR_KINDS.contains(&value)
}

fn path_hash(file_path: &str) -> String {
    sha1_hex(file_path.as_bytes())[..16].to_owned()
}

/// the copy's extension for a file document
fn file_copy_ext(kind: &str, file_path: &str) -> String {
    match kind {
        "docs" => {
            if js_regex!(r"\.odt$", "i").test(file_path) {
                ".odt".to_owned()
            } else {
                ".docx".to_owned()
            }
        }
        "sheets" => ".xlsx".to_owned(),
        "slides" => ".pptx".to_owned(),
        _ => {
            let ext = extname(file_path).to_lowercase();
            if ext_matches(&ext) {
                ext
            } else {
                kind_default_ext(kind).to_owned()
            }
        }
    }
}

fn plain(message: impl Into<String>) -> NodeError {
    NodeError {
        code: None,
        message: message.into(),
    }
}

fn assert_kind(kind: &str) -> Result<(), NodeError> {
    if !is_recovery_editor_kind(kind) {
        return Err(plain(format!("unknown recovery editor kind: {kind}")));
    }
    Ok(())
}

fn assert_untitled(untitled_id: &str, ext: &str) -> Result<(), NodeError> {
    if !untitled_id_matches(untitled_id) {
        return Err(plain("invalid untitled recovery id"));
    }
    if !ext_matches(ext) {
        return Err(plain("invalid recovery copy extension"));
    }
    Ok(())
}

/// copy file name inside the kind folder (untitled ones under `untitled/`)
fn copy_relative_path(identity: &RecoveryIdentity) -> Result<String, NodeError> {
    assert_kind(identity.kind())?;
    match identity {
        RecoveryIdentity::Untitled(u) => {
            assert_untitled(&u.untitled_id, &u.ext)?;
            Ok(join(&[
                UNTITLED_DIR,
                &format!("{}{}", u.untitled_id, u.ext),
            ]))
        }
        RecoveryIdentity::File(f) => {
            if f.file_path.is_empty() {
                return Err(plain("recovery identity needs a file path"));
            }
            Ok(format!(
                "{}{}",
                path_hash(&f.file_path),
                file_copy_ext(&f.kind, &f.file_path)
            ))
        }
    }
}

fn queue_key(copy_path: &str) -> String {
    if cfg!(windows) {
        copy_path.to_lowercase()
    } else {
        copy_path.to_owned()
    }
}

// ---- metadata ----

/// `RecoveryCopyMeta`
struct RecoveryCopyMeta {
    kind: RecoveryEditorKind,
    file_path: Option<String>,
    untitled_id: Option<String>,
    title: String,
    written_at: f64,
    run_id: String,
    state: RecoveryCopyState,
    original_path: Option<String>,
    formulas_dropped: Option<f64>,
}

impl RecoveryCopyMeta {
    /// the object as `JSON.stringify` writes it: the keys in the order of the literal
    fn to_json(&self) -> JsonValue {
        let text = |s: &Option<String>| s.clone().map_or(JsonValue::Null, JsonValue::String);
        let mut meta = JsObject::new();
        meta.set("version", JsonValue::Number(1.0));
        meta.set("kind", JsonValue::String(self.kind.clone()));
        meta.set("filePath", text(&self.file_path));
        meta.set("untitledId", text(&self.untitled_id));
        meta.set("title", JsonValue::String(self.title.clone()));
        meta.set("writtenAt", JsonValue::Number(self.written_at));
        meta.set("runId", JsonValue::String(self.run_id.clone()));
        meta.set("state", JsonValue::String(self.state.as_str().to_owned()));
        if let Some(path) = &self.original_path {
            meta.set("originalPath", JsonValue::String(path.clone()));
        }
        if let Some(count) = self.formulas_dropped {
            meta.set("formulasDropped", JsonValue::Number(count));
        }
        JsonValue::Object(meta)
    }
}

/// `readFileSync(path, 'utf8')`, or `None` where it throws
fn read_text(path: &str) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// the metadata when it is readable and belongs to this identity, else None (legacy)
fn read_meta(meta_path: &str, identity: &RecoveryIdentity) -> Option<RecoveryCopyMeta> {
    let raw = json_parse(&read_text(meta_path)?).ok()?;
    // an array has none of the keys below: every comparison fails
    let JsonValue::Object(meta) = raw else {
        return None;
    };
    let string = |key: &str| match meta.get(key) {
        Some(JsonValue::String(s)) => Some(s.clone()),
        _ => None,
    };
    if string("kind")? != identity.kind() {
        return None;
    }
    let state = RecoveryCopyState::parse(&string("state")?)?;
    let title = string("title")?;
    let run_id = string("runId")?;
    let written_at = match meta.get("writtenAt") {
        Some(JsonValue::Number(x)) if x.is_finite() => *x,
        _ => return None,
    };
    match identity {
        RecoveryIdentity::Untitled(u) => {
            if string("untitledId").as_deref() != Some(u.untitled_id.as_str())
                || meta.get("filePath") != Some(&JsonValue::Null)
            {
                return None;
            }
        }
        RecoveryIdentity::File(f) => {
            if string("filePath").as_deref() != Some(f.file_path.as_str())
                || meta.get("untitledId") != Some(&JsonValue::Null)
            {
                return None;
            }
        }
    }
    let original = string("originalPath");
    let dropped = match meta.get("formulasDropped") {
        Some(JsonValue::Number(x)) => Some(*x),
        _ => None,
    };
    Some(RecoveryCopyMeta {
        kind: identity.kind().to_owned(),
        file_path: string("filePath"),
        untitled_id: string("untitledId"),
        title,
        written_at,
        run_id,
        state,
        original_path: original_path_field(identity, original.as_deref()),
        formulas_dropped: formulas_dropped_field(identity, dropped),
    })
}

/// the metadata field for an untitled copy's original path (nothing otherwise)
fn original_path_field(identity: &RecoveryIdentity, original_path: Option<&str>) -> Option<String> {
    if !is_untitled_identity(identity) {
        return None;
    }
    original_path
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
}

/// the metadata field for an untitled copy's ODS formula loss (nothing otherwise)
fn formulas_dropped_field(
    identity: &RecoveryIdentity,
    formulas_dropped: Option<f64>,
) -> Option<f64> {
    if !is_untitled_identity(identity) {
        return None;
    }
    formulas_dropped.filter(|n| n.is_finite() && n.fract() == 0.0 && *n > 0.0)
}

/// the identity a metadata file next to `copy_name` describes, or None
fn identity_from_meta(
    kind: &str,
    meta_path: &str,
    copy_name: &str,
    untitled: bool,
) -> Result<Option<RecoveryIdentity>, NodeError> {
    let Some(text) = read_text(meta_path) else {
        return Ok(None);
    };
    let Ok(JsonValue::Object(meta)) = json_parse(&text) else {
        return Ok(None);
    };
    let ext = extname(copy_name);
    if untitled {
        let id = &copy_name[..copy_name.len() - ext.len()];
        return Ok(match meta.get("untitledId") {
            Some(JsonValue::String(s)) if s == id => {
                Some(RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
                    kind: kind.to_owned(),
                    untitled_id: id.to_owned(),
                    ext,
                }))
            }
            _ => None,
        });
    }
    let file_path = match meta.get("filePath") {
        Some(JsonValue::String(s)) if !s.is_empty() => s.clone(),
        _ => return Ok(None),
    };
    let identity = RecoveryIdentity::File(RecoveryFileIdentity {
        kind: kind.to_owned(),
        file_path,
    });
    // the name must be the one this path hashes to, or the metadata is not this copy's
    Ok((copy_relative_path(&identity)? == copy_name).then_some(identity))
}

/// `statSync(path).mtimeMs`, or None where it throws
fn stat_mtime(path: &str) -> Option<f64> {
    let meta = fs::metadata(path).ok()?;
    Some(crate::shell::recent_files::StatInfo::of(&meta).mtime_ms)
}

fn remove_quietly(path: &str) -> bool {
    fs::remove_file(path).is_ok()
}

/// `readdirSync(dir)`: libuv sorts the names by bytes; None where it throws
fn read_dir_names(dir: &str) -> Option<Vec<String>> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    Some(names)
}

// ---- the store ----

/// `RecoveryStoreOptions`, with the clock and the random source the
/// TypeScript reads from `Date.now()` and `crypto.randomUUID()`.
pub struct RecoveryStoreOptions<'a> {
    /// the app data folder, read on every call
    pub user_data_dir: &'a dyn Fn() -> String,
    /// `Date.now()`
    pub now_ms: &'a dyn Fn() -> f64,
    /// `crypto.randomUUID()`
    pub random_uuid: &'a dyn Fn() -> String,
}

/// `createRecoveryStore(options)`
pub fn create_recovery_store<'a>(
    options: RecoveryStoreOptions<'a>,
    shared: &'a SharedRecoveryState,
) -> RecoveryStore<'a> {
    RecoveryStore { options, shared }
}

pub struct RecoveryStore<'a> {
    options: RecoveryStoreOptions<'a>,
    shared: &'a SharedRecoveryState,
}

type Land<'l> = &'l mut dyn FnMut(
    &str,
    &dyn Fn() -> Result<(), NodeError>,
    &dyn Fn() -> bool,
) -> Result<bool, NodeError>;

impl RecoveryStore<'_> {
    fn root_dir(&self) -> String {
        (self.options.user_data_dir)()
    }

    fn kind_dir(&self, kind: &str) -> String {
        join(&[&self.root_dir(), &recovery_folder_name(kind)])
    }

    fn meta_path_of(copy: &str) -> String {
        format!("{copy}{META_SUFFIX}")
    }

    fn epoch_of(&self, key: &str) -> u64 {
        self.shared.epochs.borrow().get(key).copied().unwrap_or(0)
    }

    fn bump_epoch(&self, key: &str) {
        let next = self.epoch_of(key) + 1;
        self.shared.epochs.borrow_mut().insert(key.to_owned(), next);
    }

    /// where this document's copy lives (whether or not it exists)
    pub fn copy_path(&self, identity: &RecoveryIdentity) -> Result<String, NodeError> {
        let dir = self.kind_dir(identity.kind());
        Ok(join(&[&dir, &copy_relative_path(identity)?]))
    }

    /// take a write ticket now
    pub fn begin_write(
        &self,
        identity: &RecoveryIdentity,
    ) -> Result<RecoveryWriteTicket, NodeError> {
        let key = queue_key(&self.copy_path(identity)?);
        let epoch = self.epoch_of(&key);
        Ok(RecoveryWriteTicket { key, epoch })
    }

    fn remove_copy_files(copy: &str) {
        remove_quietly(copy);
        remove_quietly(&Self::meta_path_of(copy));
    }

    /// The common shape of writeCopy and writeCopyStreamed: check the ticket,
    /// run `land` inside the document's turn, and undo the result when a
    /// delete got in meanwhile. `land` gets the metadata writer.
    fn queue_copy_write(
        &self,
        identity: &RecoveryIdentity,
        write_options: &RecoveryWriteOptions,
        land: Land<'_>,
    ) -> Result<RecoveryWriteResult, NodeError> {
        let copy = self.copy_path(identity)?;
        let key = queue_key(&copy);
        let ticket = write_options
            .ticket
            .clone()
            .unwrap_or_else(|| RecoveryWriteTicket {
                key: key.clone(),
                epoch: self.epoch_of(&key),
            });
        if ticket.key != key {
            return Err(plain("recovery write ticket belongs to another document"));
        }
        let title = match (&write_options.title, identity) {
            (Some(title), _) => title.clone(),
            (None, RecoveryIdentity::Untitled(_)) => String::new(),
            (None, RecoveryIdentity::File(f)) => basename(&f.file_path, None),
        };
        let superseded = || self.epoch_of(&key) != ticket.epoch;
        let write_meta = || -> Result<(), NodeError> {
            let meta = RecoveryCopyMeta {
                kind: identity.kind().to_owned(),
                file_path: match identity {
                    RecoveryIdentity::File(f) => Some(f.file_path.clone()),
                    RecoveryIdentity::Untitled(_) => None,
                },
                untitled_id: match identity {
                    RecoveryIdentity::Untitled(u) => Some(u.untitled_id.clone()),
                    RecoveryIdentity::File(_) => None,
                },
                title: title.clone(),
                written_at: (self.options.now_ms)(),
                run_id: recovery_run_id(self.shared).to_owned(),
                state: RecoveryCopyState::Undecided,
                original_path: original_path_field(
                    identity,
                    write_options.original_path.as_deref(),
                ),
                formulas_dropped: formulas_dropped_field(identity, write_options.formulas_dropped),
            };
            write_json_atomic(&Self::meta_path_of(&copy), &meta.to_json())
        };
        // "Don't Save" holds until the close is cancelled or the document reopens
        if superseded() || self.shared.discarded.borrow().contains(&key) {
            return Ok(RecoveryWriteResult::Superseded);
        }
        let dir = dirname(&copy);
        fs::create_dir_all(&dir).map_err(|e| node_error(&e, "mkdir", &dir))?;
        if !land(&copy, &write_meta, &superseded)? {
            return Ok(RecoveryWriteResult::Superseded);
        }
        // a delete that ran while the bytes were landing must still win: undo this write
        if superseded() {
            Self::remove_copy_files(&copy);
            return Ok(RecoveryWriteResult::Superseded);
        }
        Ok(RecoveryWriteResult::Written)
    }

    /// Write (or replace) the copy atomically and mark it undecided.
    pub fn write_copy(
        &self,
        identity: &RecoveryIdentity,
        bytes: &[u8],
        write_options: &RecoveryWriteOptions,
    ) -> Result<RecoveryWriteResult, NodeError> {
        self.queue_copy_write(
            identity,
            write_options,
            &mut |copy, write_meta, _superseded| {
                // metadata first: a crash between the two leaves an orphan metadata file
                // (ignored), never an untitled copy without its title
                write_meta()?;
                atomic_write_file(copy, bytes)?;
                Ok(true)
            },
        )
    }

    /// writeCopy for content too large to hold in memory: `write` streams the
    /// copy to the temp path it is given, and the store moves it into place.
    pub fn write_copy_streamed(
        &self,
        identity: &RecoveryIdentity,
        write: &mut dyn FnMut(&str) -> Result<(), NodeError>,
        write_options: &RecoveryWriteOptions,
    ) -> Result<RecoveryWriteResult, NodeError> {
        self.queue_copy_write(
            identity,
            write_options,
            &mut |copy, write_meta, superseded| {
                let temp = temp_path_beside(copy);
                let landed = (|| -> Result<bool, NodeError> {
                    write(&temp)?;
                    // a delete during the (long) serialization: the temp never becomes the copy
                    if superseded() {
                        remove_quietly(&temp);
                        return Ok(false);
                    }
                    // metadata first, as in writeCopy
                    write_meta()?;
                    atomic_move_file(&temp, copy)?;
                    Ok(true)
                })();
                if landed.is_err() {
                    remove_quietly(&temp);
                }
                landed
            },
        )
    }

    /// Delete the copy and its metadata now. While the app is ending, only
    /// `Saved` and `DontSave` are carried out.
    pub fn delete_copy(
        &self,
        identity: &RecoveryIdentity,
        reason: RecoveryDeleteReason,
    ) -> Result<RecoveryDeleteResult, NodeError> {
        if is_app_shutting_down(self.shared)
            && reason != RecoveryDeleteReason::Saved
            && reason != RecoveryDeleteReason::DontSave
        {
            return Ok(RecoveryDeleteResult::Refused);
        }
        let copy = self.copy_path(identity)?;
        let key = queue_key(&copy);
        self.bump_epoch(&key);
        if reason == RecoveryDeleteReason::DontSave {
            self.shared.discarded.borrow_mut().insert(key);
        }
        Self::remove_copy_files(&copy);
        Ok(RecoveryDeleteResult::Deleted)
    }

    /// the document was discarded with "Don't Save" and takes no copy for now
    pub fn is_discarded(&self, identity: &RecoveryIdentity) -> Result<bool, NodeError> {
        let key = queue_key(&self.copy_path(identity)?);
        Ok(self.shared.discarded.borrow().contains(&key))
    }

    /// The document is open (again) with edits that are not the discarded ones.
    pub fn clear_discarded(&self, identity: &RecoveryIdentity) -> Result<(), NodeError> {
        let key = queue_key(&self.copy_path(identity)?);
        self.shared.discarded.borrow_mut().remove(&key);
        Ok(())
    }

    fn info_for(&self, identity: &RecoveryIdentity, copy: &str) -> Option<RecoveryCopyInfo> {
        let copy_mtime_ms = stat_mtime(copy)?;
        let meta = read_meta(&Self::meta_path_of(copy), identity);
        let file_path = match identity {
            RecoveryIdentity::File(f) => Some(f.file_path.clone()),
            RecoveryIdentity::Untitled(_) => None,
        };
        let mut file_changed_after_copy = false;
        let mut original_missing = false;
        if let Some(path) = &file_path {
            match stat_mtime(path) {
                None => original_missing = true,
                Some(file_mtime) => file_changed_after_copy = file_mtime > copy_mtime_ms,
            }
        }
        Some(RecoveryCopyInfo {
            identity: identity.clone(),
            kind: identity.kind().to_owned(),
            title: match &meta {
                Some(m) => m.title.clone(),
                None => file_path
                    .as_deref()
                    .map_or_else(String::new, |p| basename(p, None)),
            },
            file_path,
            untitled_id: match identity {
                RecoveryIdentity::Untitled(u) => Some(u.untitled_id.clone()),
                RecoveryIdentity::File(_) => None,
            },
            written_at: meta.as_ref().map_or(copy_mtime_ms, |m| m.written_at),
            run_id: meta.as_ref().map_or_else(String::new, |m| m.run_id.clone()),
            state: meta.as_ref().map_or(RecoveryCopyState::Later, |m| m.state),
            legacy: meta.is_none(),
            copy_path: copy.to_owned(),
            copy_mtime_ms,
            file_changed_after_copy,
            original_missing,
            original_path: meta.as_ref().and_then(|m| m.original_path.clone()),
            formulas_dropped: meta.as_ref().and_then(|m| m.formulas_dropped),
        })
    }

    /// the copy's description, or None when there is none
    pub fn copy_info(
        &self,
        identity: &RecoveryIdentity,
    ) -> Result<Option<RecoveryCopyInfo>, NodeError> {
        Ok(self.info_for(identity, &self.copy_path(identity)?))
    }

    /// the copy's bytes, or None when it cannot be read (`copyPath` throwing included)
    pub fn read_copy(&self, identity: &RecoveryIdentity) -> Option<Vec<u8>> {
        fs::read(self.copy_path(identity).ok()?).ok()
    }

    /// what opening the document does; the document is being opened, so a
    /// "Don't Save" block lifts
    pub fn open_plan(&self, identity: &RecoveryIdentity) -> Result<RecoveryOpenPlan, NodeError> {
        self.clear_discarded(identity)?;
        Ok(match self.copy_info(identity)? {
            None => RecoveryOpenPlan::None,
            Some(copy) if copy.state == RecoveryCopyState::RestoreChosen => {
                RecoveryOpenPlan::Restore(copy)
            }
            Some(copy) => RecoveryOpenPlan::Ask(copy),
        })
    }

    /// false when there is no copy
    pub fn set_copy_state(
        &self,
        identity: &RecoveryIdentity,
        state: RecoveryCopyState,
    ) -> Result<bool, NodeError> {
        let copy = self.copy_path(identity)?;
        let Some(info) = self.info_for(identity, &copy) else {
            return Ok(false);
        };
        let meta = RecoveryCopyMeta {
            kind: identity.kind().to_owned(),
            file_path: info.file_path.clone(),
            untitled_id: match identity {
                RecoveryIdentity::Untitled(u) => Some(u.untitled_id.clone()),
                RecoveryIdentity::File(_) => None,
            },
            title: info.title.clone(),
            written_at: info.written_at,
            run_id: info.run_id.clone(),
            state,
            original_path: original_path_field(identity, info.original_path.as_deref()),
            formulas_dropped: formulas_dropped_field(identity, info.formulas_dropped),
        };
        Ok(write_json_atomic(&Self::meta_path_of(&copy), &meta.to_json()).is_ok())
    }

    /// Record a launch-list choice: restore -> restoreChosen, later -> later,
    /// discard -> delete. False when nothing changed.
    pub fn apply_launch_decision(
        &self,
        identity: &RecoveryIdentity,
        decision: RecoveryLaunchDecision,
    ) -> Result<bool, NodeError> {
        if decision == RecoveryLaunchDecision::Discard {
            if self.copy_info(identity)?.is_none() {
                return Ok(false);
            }
            return Ok(self.delete_copy(identity, RecoveryDeleteReason::Discarded)?
                == RecoveryDeleteResult::Deleted);
        }
        self.set_copy_state(
            identity,
            if decision == RecoveryLaunchDecision::Restore {
                RecoveryCopyState::RestoreChosen
            } else {
                RecoveryCopyState::Later
            },
        )
    }

    /// The editor loaded the copy's content into a tab: the copy is
    /// undecided again (and a "Don't Save" block lifts).
    pub fn mark_copy_loaded(&self, identity: &RecoveryIdentity) -> Result<bool, NodeError> {
        self.clear_discarded(identity)?;
        self.set_copy_state(identity, RecoveryCopyState::Undecided)
    }

    /// Copies with metadata, oldest first.
    pub fn list_copies(
        &self,
        filter: &RecoveryCopyFilter,
    ) -> Result<Vec<RecoveryCopyInfo>, NodeError> {
        let default_kinds: Vec<String> = RECOVERY_EDITOR_KINDS
            .iter()
            .map(|k| (*k).to_owned())
            .collect();
        let kinds = filter.kinds.as_ref().unwrap_or(&default_kinds);
        let mut found: Vec<RecoveryCopyInfo> = Vec::new();
        for kind in kinds {
            let mut places: Vec<(String, bool)> = Vec::new();
            if filter.untitled != Some(true) {
                places.push((self.kind_dir(kind), false));
            }
            if filter.untitled != Some(false) {
                places.push((join(&[&self.kind_dir(kind), UNTITLED_DIR]), true));
            }
            for (dir, untitled) in places {
                let Some(names) = read_dir_names(&dir) else {
                    continue;
                };
                for name in names {
                    let is_copy = if untitled {
                        untitled_copy_matches(&name)
                    } else {
                        file_copy_matches(&name)
                    };
                    if !is_copy {
                        continue;
                    }
                    let copy = join(&[&dir, &name]);
                    let Some(identity) =
                        identity_from_meta(kind, &Self::meta_path_of(&copy), &name, untitled)?
                    else {
                        continue;
                    };
                    let Some(info) = self.info_for(&identity, &copy) else {
                        continue;
                    };
                    if info.legacy {
                        continue;
                    }
                    if let Some(states) = &filter.states
                        && !states.contains(&info.state)
                    {
                        continue;
                    }
                    found.push(info);
                }
            }
        }
        // a stable sort, as Array.prototype.sort is
        found.sort_by(|a, b| {
            a.written_at
                .partial_cmp(&b.written_at)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(found)
    }

    /// any undecided or restoreChosen copy left (the normal-exit judgment)
    pub fn has_unresolved_copies(&self) -> Result<bool, NodeError> {
        let filter = RecoveryCopyFilter {
            states: Some(vec![
                RecoveryCopyState::Undecided,
                RecoveryCopyState::RestoreChosen,
            ]),
            ..RecoveryCopyFilter::default()
        };
        Ok(!self.list_copies(&filter)?.is_empty())
    }

    /// Remove copies (legacy ones and leftover temp files included) whose file
    /// was untouched for longer than `max_age_ms`. Answers how many were
    /// removed; does nothing while the app is ending.
    pub fn prune_stale_copies(&self, max_age_ms: Option<f64>) -> usize {
        if is_app_shutting_down(self.shared) {
            return 0;
        }
        let cutoff = (self.options.now_ms)() - max_age_ms.unwrap_or(RECOVERY_COPY_MAX_AGE_MS);
        let mut removed = 0;
        for kind in RECOVERY_EDITOR_KINDS {
            let kind_dir = self.kind_dir(kind);
            for (dir, untitled) in [
                (kind_dir.clone(), false),
                (join(&[&kind_dir, UNTITLED_DIR]), true),
            ] {
                let Some(names) = read_dir_names(&dir) else {
                    continue;
                };
                for name in names {
                    let path = join(&[&dir, &name]);
                    let is_copy = if untitled {
                        untitled_copy_matches(&name)
                    } else {
                        file_copy_matches(&name)
                    };
                    let is_temp = temp_matches(&name);
                    let is_meta = name.ends_with(META_SUFFIX);
                    if !is_copy && !is_temp && !is_meta {
                        continue;
                    }
                    let Some(mtime) = stat_mtime(&path) else {
                        continue;
                    };
                    if mtime >= cutoff {
                        continue;
                    }
                    if is_meta {
                        // an orphan (its copy already gone); a live copy's metadata goes with it
                        if !std::path::Path::new(&path[..path.len() - META_SUFFIX.len()]).exists() {
                            remove_quietly(&path);
                        }
                        continue;
                    }
                    if is_copy {
                        self.bump_epoch(&queue_key(&path));
                        remove_quietly(&Self::meta_path_of(&path));
                    }
                    if remove_quietly(&path) {
                        removed += 1;
                    }
                }
            }
        }
        removed
    }

    /// Move a copy that sits in the editor's own recovery folder into a new
    /// untitled slot. None, with the source left alone, when it is outside
    /// that folder or the move fails.
    pub fn adopt_untitled_copy(
        &self,
        kind: &str,
        source_path: &str,
        adopt_options: &RecoveryAdoptOptions,
    ) -> Result<Option<RecoveryUntitledIdentity>, NodeError> {
        assert_kind(kind)?;
        let folder = resolve(&[&self.kind_dir(kind)]);
        let source = resolve(&[source_path]);
        let inside = relative(&folder, &source);
        let sep = std::path::MAIN_SEPARATOR;
        // only a whole `..` step leads out: a copy named `..x` is inside
        let up = inside == ".."
            || inside.starts_with(&format!("..{sep}"))
            || (sep == '\\' && inside.starts_with("../"));
        if inside.is_empty() || up || is_absolute(&inside) {
            return Ok(None);
        }
        if !std::path::Path::new(&source).exists() {
            return Ok(None);
        }
        let identity = RecoveryUntitledIdentity {
            kind: kind.to_owned(),
            untitled_id: new_untitled_recovery_id(self.options.random_uuid),
            ext: adopt_options.ext.clone(),
        };
        let as_identity = RecoveryIdentity::Untitled(identity.clone());
        let target = self.copy_path(&as_identity)?;
        let meta = RecoveryCopyMeta {
            kind: kind.to_owned(),
            file_path: None,
            untitled_id: Some(identity.untitled_id.clone()),
            title: adopt_options.title.clone(),
            written_at: stat_mtime(&source).unwrap_or_else(|| (self.options.now_ms)()),
            run_id: String::new(),
            state: adopt_options.state.unwrap_or(RecoveryCopyState::Later),
            original_path: original_path_field(
                &as_identity,
                adopt_options.original_path.as_deref(),
            ),
            formulas_dropped: None,
        };
        let moved = (|| -> Result<(), NodeError> {
            let dir = dirname(&target);
            fs::create_dir_all(&dir).map_err(|e| node_error(&e, "mkdir", &dir))?;
            write_json_atomic(&Self::meta_path_of(&target), &meta.to_json())?;
            fs::rename(&source, &target)
                .map_err(|e| crate::node_fs::node_error2(&e, "rename", &source, &target))
        })();
        match moved {
            Ok(()) => Ok(Some(identity)),
            Err(_) => {
                remove_quietly(&Self::meta_path_of(&target));
                Ok(None)
            }
        }
    }
}
