//! `apps/shell/src/main/projects/project-guide.ts`: the project guide
//! (decision 0088): the one place in the shell main process that knows the
//! project list, reads a project folder's instructions and memory, decides
//! identity and trust, and writes into the folder (through the write guard).
//! It holds no Electron objects: the first-time trust prompt is a step the
//! caller shows (see below), and the IPC layer passes the calling window's
//! document path.
//!
//! This file holds the exported types and constants of the TypeScript file,
//! then the `ProjectGuide` class.
//!
//! What the TypeScript awaits is a plain synchronous call here, and the
//! optional callbacks of `ProjectGuideDeps` are optional boxed closures, with
//! one exception: the `await askTrust(prompt)` of `addFolder`,
//! `relocateProject`, `createProject`, `adoptFolderHint` and `decideTrust`.
//! Showing that prompt can wait for a window's events (the person comes back
//! to the page after [view all]), and those arrive on the thread the guide
//! runs on. So a method that may ask returns a [`GuideStep`]: `Done(result)`,
//! or `AskTrust { prompt, pending }`, where the caller shows the prompt and
//! calls the `resume_*` method of that operation with `pending` and the
//! [`ProjectTrustAnswer`] (`None`: closed). The resume continues exactly where
//! the `await` returned: what the TypeScript reads after the await (the
//! settings, the clock) is read at the resume. A call asks at most once, so a
//! resume answers a final result, never another step.
//!
//! The guide is a struct the caller owns. Its state (the unwritable projects,
//! the pending use times, the install id) and the callbacks of the host sit
//! behind `RefCell`s, so every method takes `&self`: one guide is shared (an
//! `Rc`) between the chat store, the tools, the file index and the new
//! document placer, as the one object of the TypeScript is, and a write the
//! guide runs may call the guide again (the chat store asks for the install
//! id while its change holds the write).
//!
//! The use-time timer of `touch` is explicit: the guide records when it
//! would have armed `setTimeout` ([`ProjectGuide::touch_timer`]) and the
//! caller calls [`ProjectGuide::flush_touches`] when that time comes (and at
//! quit).
//!
//! Two defaults of the TypeScript have no counterpart: the screen's local time
//! zone (`localDate`, `memoryBackupName` read the `Date` in local time), which
//! the host answers (`ProjectGuideDeps::local_date`), and `console.warn`, which
//! is `ProjectGuideDeps::warn` (absent: nothing is printed).

use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use jscompat::node_path::host::{basename, is_absolute, join};
use jscompat::{
    JsMap, JsObject, JsonValue, RegexLimit, RegexSyntaxError, base64, js_regex, json_parse,
    math_max, math_random, sort_by_number, to_iso_string, trim, truthy,
};
use serde::{Deserialize, Serialize};

use super::chat_store::{ChatDataChange, ChatStoreGuide};
use super::cloud_files::{SyncFolderOptions, is_under_known_sync_folder};
use super::context::assemble_trusted_context;
use super::folder_files::{
    clean_project_name, data_dir_name, hash_text, plain_folder_entries, project_file_text,
    read_data_text, read_project_file,
};
use super::identity::{ClassifyInput, FolderClassification, classify_folder, rebase_opt_outs};
use super::ignore::{
    IgnoreMatcher, IgnoreOptions, add_ignore_line, compile_ignore, ignore_folds_case,
    remove_ignore_line,
};
use super::memory::{
    LocalDateParts, MemoryOpContext, MemoryOpRefusal, MemoryOpResult, apply_memory_op,
    build_memory_text, local_date, memory_backup_name, memory_entries, memory_header,
};
use super::new_documents::NewDocumentsGuide;
use super::paths::{
    RefusalContext, canonical_path, folder_refusal, is_inside_folder, location_refusal,
    relative_inside, same_path,
};
use super::project_index::ProjectIndexGuide;
use super::project_tools::ProjectToolsGuide;
use super::selection::{
    ResolvedSelectionTarget, delete_key, drop_from_list, find_unregistered_project,
    record_outside_chat, record_selection, selection_for,
};
use super::stand_ins::process_platform;
use super::trust::{TrustScanInput, read_hashed_texts, scan_for_trust};
use super::visibility::is_ai_visible_path;
use super::write_guard::{
    DataChange, DataUpdateResult, ProjectWriteGuard, ProjectWriteRefusal, ProjectWriteRefused,
    WriteGuardError,
};
use crate::node_fs::{NodeError, namespaced};
use crate::packages::electron_utils::default_save_dir::Thrown;
use crate::packages::project_store::{
    AddFolderResult, AddFolderStage, ApplyMemoryConsolidationArgs, ApplyMemoryConsolidationResult,
    CreateProjectResult, DecideTrustResult, FolderIdentity, FolderRefusalReason,
    PROJECT_FORMAT_VERSION, PROJECT_NAME_MAX_CHARS, ProjectContextBundle,
    ProjectContextInstructions, ProjectContextMemory, ProjectContextResult, ProjectDetail,
    ProjectFileEntry, ProjectFolderFile, ProjectHashedFile, ProjectId, ProjectListItem,
    ProjectMemoryEditResult, ProjectMemoryOp, ProjectMemoryRefusal, ProjectNotice,
    ProjectSelection, ProjectSettings, ProjectTrustAnswer, ProjectTrustDecision,
    ProjectTrustPrompt, ProjectTrustRecord, ProjectTrustState, ProjectWriteResult,
    SyncFolderService, UndoMemoryConsolidationArgs, UndoMemoryConsolidationResult,
    is_valid_project_id, memory_backup_pattern, project_folder_name,
};
use crate::shell::app_settings::{
    ProjectListEntry as ListEntry, ProjectSwitches, ProjectTrustRecord as StoredTrustRecord,
    StoredProjectsSettings, read_projects_settings, update_projects_settings,
};
use crate::shell::rename_validation::is_valid_rename_name;

pub use super::context::INSTRUCTIONS_LIMIT_CHARS;
pub use super::memory::MEMORY_SOFT_LIMIT_CHARS;

/// What a guide method that may show the first-time trust prompt (spec 5.10)
/// answers: the result, or the prompt to show and the state to resume with
#[derive(Debug, Clone, PartialEq)]
pub enum GuideStep<T, P> {
    Done(T),
    /// `await askTrust(prompt)`: the caller shows `prompt`, then calls the
    /// `resume_*` method of the operation with `pending` and the person's
    /// answer (`None` when the prompt was closed). The prompt is boxed to keep
    /// the two variants of a step near in size.
    AskTrust {
        prompt: Box<ProjectTrustPrompt>,
        pending: P,
    },
}

/// What `adopt` has settled before it asks: the folder and its identity
#[derive(Debug, Clone, PartialEq)]
struct Adoption {
    root: String,
    id: ProjectId,
    name: String,
    identity: FolderIdentity,
    previous: Option<crate::packages::project_store::ProjectListEntry>,
    copied_from: Option<ProjectId>,
    stale_at_path: Option<ProjectId>,
}

/// `addFolder`, `relocateProject` or `createProject` waiting for the trust
/// answer: [`ProjectGuide::resume_add_folder`] or
/// [`ProjectGuide::resume_create_project`]
#[derive(Debug, Clone, PartialEq)]
pub struct PendingAdopt {
    adoption: Box<Adoption>,
    /// the hashes of the texts the prompt shows, recorded with the answer
    hashes: JsObject<String>,
}

/// `adoptFolderHint` waiting for the trust answer:
/// [`ProjectGuide::resume_adopt_folder_hint`]
#[derive(Debug, Clone, PartialEq)]
pub struct PendingAdoptFolderHint {
    doc_path: String,
    adopt: PendingAdopt,
}

/// `decideTrust` waiting for the trust answer:
/// [`ProjectGuide::resume_decide_trust`]
#[derive(Debug, Clone, PartialEq)]
pub struct PendingDecideTrust {
    id: ProjectId,
    hashes: JsObject<String>,
}

/// `NewProjectRequest`: "New project" as main decides it (spec 5.1).
/// `parentDir` is a folder main itself chose (the default save folder, or the
/// person's pick in main's own folder picker); it never comes from a renderer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProjectRequest {
    pub name: String,
    /// Absent: the default save folder
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_dir: Option<String>,
    /// After a `status: 'exists'` answer the person confirmed: use that folder
    /// as the project
    #[serde(skip_serializing_if = "Option::is_none")]
    pub use_existing: Option<bool>,
}

/// `SelectionTarget`: whose AI panel asks for a selection
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SelectionTarget {
    /// A saved document (absolute path, canonicalized here)
    Document { path: String },
    /// A never-saved document; `projectId` is the project a create flow opened
    /// it in (spec 5.2, 6)
    #[serde(rename_all = "camelCase")]
    Untitled {
        #[serde(skip_serializing_if = "Option::is_none")]
        project_id: Option<ProjectId>,
    },
    /// The home ask panel
    Home,
}

/// `ProjectAiVisibility`: what the AI may see in one project, used by the
/// tools and the file list
#[derive(Debug)]
pub struct ProjectAiVisibility {
    pub root: String,
    pub matcher: IgnoreMatcher,
    /// Same for the same rule (`ignore` text and case folding); a file list
    /// cache keys on it
    pub rule_key: Option<String>,
}

impl ProjectAiVisibility {
    /// `isVisible(relPath, isDir)`: folder-relative path (either separator) is
    /// visible: inside, not hidden, not in the data folder, not ignored.
    /// `isDir` is `false` where the TypeScript leaves it out.
    pub fn is_visible(&self, rel_path: &str, is_dir: bool) -> Result<bool, RegexLimit> {
        is_ai_visible_path(&self.root, rel_path, &self.matcher, is_dir)
    }
}

/// `ContextFilesRequest`
#[derive(Debug)]
pub struct ContextFilesRequest {
    pub id: ProjectId,
    pub root: String,
    pub visibility: ProjectAiVisibility,
}

/// `ContextFiles`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextFiles {
    pub files: Vec<ProjectFileEntry>,
    pub omitted: u64,
}

/// `ProjectGuideDeps.env`: a read of `process.env`
pub type EnvLookup = Box<dyn Fn(&str) -> Option<String>>;

/// `ProjectGuideDeps.contextFiles`: the file names of a project for the
/// context (spec 5.4 item 4)
pub type ContextFilesProvider = Box<dyn FnMut(&ContextFilesRequest) -> ContextFiles>;

/// `console.warn(label, error)` of `ProjectGuideDeps.warn`
pub type WarnFn = Box<dyn FnMut(&str, &str)>;

/// `ProjectGuideDeps`
pub struct ProjectGuideDeps {
    /// `<userData>/app-settings.json`
    pub settings_path: String,
    pub home_dir: String,
    /// The app data folder (protected, never a project)
    pub user_data: String,
    /// The default save folder (`configuredDefaultSaveDir`), parent of a new
    /// project
    pub default_parent_dir: Box<dyn FnMut() -> String>,
    /// `NodeJS.Platform`; absent: the host's
    pub platform: Option<String>,
    /// For the sync-folder rule (`OneDrive*` variables); absent: the process
    /// environment
    pub env: Option<EnvLookup>,
    /// `now()`: the clock in milliseconds since the epoch, where the
    /// TypeScript returns a `Date`; absent: the host's clock
    pub now: Option<Box<dyn FnMut() -> f64>>,
    /// A new project id; must match `PROJECT_ID_PATTERN`; absent: 16 random
    /// bytes in base64url
    pub new_id: Option<Box<dyn FnMut() -> String>>,
    /// The screen language, for the header of a new `memory.md`; absent:
    /// `en`
    pub language: Option<Box<dyn FnMut() -> String>>,
    /// The file names of a project for the context (spec 5.4 item 4); absent
    /// sends none
    pub context_files: Option<ContextFilesProvider>,
    /// At most one write of a project's use time per this long; default
    /// `PROJECT_TOUCH_WRITE_MS`
    pub touch_write_ms: Option<f64>,
    /// The local calendar date and time of a time value, as `getFullYear()`
    /// and the other local getters of a `Date` answer them. The TypeScript
    /// reads the process's time zone; this is the host's.
    pub local_date: Box<dyn FnMut(f64) -> LocalDateParts>,
    /// `console.warn(label, error)`, `error` being its message; absent:
    /// nothing is printed
    pub warn: Option<WarnFn>,
}

/// `PROJECT_TOUCH_WRITE_MS`: a project's "last used" time is written to
/// `app-settings.json` at most once per this long (tunable); newer times are
/// kept in memory meanwhile and flushed at quit.
pub const PROJECT_TOUCH_WRITE_MS: f64 = 60_000.0;

/// `DataUpdateOutcome`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum DataUpdateOutcome {
    Ok { written: bool, text: Option<String> },
    Unwritable,
}

/// `MEMORY_BACKUPS_KEPT`: memory backups kept after a consolidation (spec 3)
pub const MEMORY_BACKUPS_KEPT: usize = 3;

/// `Partial<ProjectSettings>`: what `setSettings` takes; a field that is not
/// a boolean is left alone
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_agents_files: Option<bool>,
}

/// The `by` of `editMemory`: `ai` is the `project_remember` tool, `person` a
/// "[remove]" on a memory line or the screen's per-entry delete
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryEditor {
    Ai,
    Person,
}

/// What a method of the guide throws: an `Error` with a message, a refusal of
/// the write guard, the error of a file system call, or the error of a regular
/// expression
#[derive(Debug, Clone, PartialEq)]
pub enum GuideError {
    Plain(String),
    Refused(ProjectWriteRefused),
    Node(NodeError),
    Syntax(RegexSyntaxError),
    Limit(RegexLimit),
}

impl GuideError {
    fn plain(message: impl Into<String>) -> Self {
        Self::Plain(message.into())
    }

    /// `error.message`
    pub fn message(&self) -> String {
        match self {
            Self::Plain(message) => message.clone(),
            Self::Refused(refused) => refused.message(),
            Self::Node(error) => error.message.clone(),
            Self::Syntax(error) => error.to_string(),
            Self::Limit(error) => error.to_string(),
        }
    }

    /// `error.code`; `None` unless a Node file error has one
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::Node(error) => error.code,
            _ => None,
        }
    }
}

impl std::fmt::Display for GuideError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for GuideError {}

impl From<WriteGuardError> for GuideError {
    fn from(error: WriteGuardError) -> Self {
        match error {
            WriteGuardError::Refused(refused) => Self::Refused(refused),
            WriteGuardError::Fs(error) => Self::Node(error),
        }
    }
}

impl From<ProjectWriteRefused> for GuideError {
    fn from(error: ProjectWriteRefused) -> Self {
        Self::Refused(error)
    }
}

impl From<NodeError> for GuideError {
    fn from(error: NodeError) -> Self {
        Self::Node(error)
    }
}

impl From<RegexSyntaxError> for GuideError {
    fn from(error: RegexSyntaxError) -> Self {
        Self::Syntax(error)
    }
}

impl From<RegexLimit> for GuideError {
    fn from(error: RegexLimit) -> Self {
        Self::Limit(error)
    }
}

/// When `touch` armed its timer and how long it asked to wait: the caller
/// calls `flush_touches` at `armed_at + delay`
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TouchTimer {
    /// the guide's clock when the timer was set (ms)
    pub armed_at: f64,
    /// `setTimeout`'s delay (ms)
    pub delay: f64,
}

impl TouchTimer {
    /// the time on the guide's clock the timer fires
    pub fn due(&self) -> f64 {
        self.armed_at + self.delay
    }
}

const DEFAULT_SETTINGS: ProjectSettings = ProjectSettings {
    memory_enabled: true,
    read_agents_files: true,
};

/// The environment variables the sync-folder rule reads
const SYNC_ENV_KEYS: [&str; 5] = [
    "OneDrive",
    "OneDriveConsumer",
    "OneDriveCommercial",
    "USERPROFILE",
    "HOME",
];

/// `defaultNewId()`: `randomBytes(16).toString('base64url')`
fn default_new_id() -> String {
    let mut bytes = [0u8; 16];
    for byte in &mut bytes {
        *byte = (math_random() * 256.0) as u8;
    }
    base64(&bytes)
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_")
}

/// `new Date()` as milliseconds since the epoch
fn system_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |elapsed| elapsed.as_millis() as f64)
}

/// `isFolder(path)`: `stat` follows links
fn is_folder(path: &str) -> bool {
    std::fs::metadata(namespaced(path)).is_ok_and(|info| info.is_dir())
}

/// `exists(path)`: `lstat` answers
fn exists(path: &str) -> bool {
    std::fs::symlink_metadata(namespaced(path)).is_ok()
}

/// `cloneTrust(record)`
fn clone_trust(record: &StoredTrustRecord) -> StoredTrustRecord {
    StoredTrustRecord {
        decision: record.decision.clone(),
        hashes: record.hashes.clone(),
    }
}

/// `a > b` of two strings: by UTF-16 code units
fn js_greater(a: &str, b: &str) -> bool {
    a.encode_utf16().cmp(b.encode_utf16()) == std::cmp::Ordering::Greater
}

/// `names.sort()`: by UTF-16 code units
fn sort_utf16(names: &mut [String]) {
    names.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `a.localeCompare(b)`, in the root collation
fn locale_compare(a: &str, b: &str) -> f64 {
    static COLLATOR: LazyLock<CollatorBorrowed<'static>> = LazyLock::new(|| {
        Collator::try_new(CollatorPreferences::default(), CollatorOptions::default())
            .expect("the compiled root collation")
    });
    match COLLATOR.compare(a, b) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}

/// `new Error(`unknown project ${id}`)`
fn unknown_project(id: &str) -> GuideError {
    GuideError::plain(format!("unknown project {id}"))
}

/// the decision a stored trust record holds (`use` or `without`)
fn decision_of(text: &str) -> ProjectTrustDecision {
    if text == "use" {
        ProjectTrustDecision::Use
    } else {
        ProjectTrustDecision::Without
    }
}

/// `{ ...DEFAULT_SETTINGS, ...settings.settings[id] }`
fn settings_of(id: &str, settings: &StoredProjectsSettings) -> ProjectSettings {
    match settings.settings.get(id) {
        Some(switches) => ProjectSettings {
            memory_enabled: switches.memory_enabled,
            read_agents_files: switches.read_agents_files,
        },
        None => DEFAULT_SETTINGS,
    }
}

/// `settings.list.find((item) => item.id === id)`
fn entry_in(settings: &StoredProjectsSettings, id: &str) -> Option<ListEntry> {
    settings.list.iter().find(|item| item.id == id).cloned()
}

/// `parseCreatedAt(text)`
fn parse_created_at(text: &str) -> Option<String> {
    match json_parse(text) {
        Ok(JsonValue::Object(raw)) => match raw.get("createdAt") {
            Some(JsonValue::String(created_at)) => Some(created_at.clone()),
            _ => None,
        },
        _ => None,
    }
}

/// `assertFolderRelative(relPath)`
fn assert_folder_relative(rel_path: &str) -> Result<(), GuideError> {
    if trim(rel_path).is_empty()
        || js_regex!(r"^[\\/]").test(rel_path)
        || js_regex!(r"^[A-Za-z]:").test(rel_path)
        || js_regex!(r"[\\/]").split(rel_path).contains(&"..")
    {
        return Err(GuideError::plain(
            "expected a path relative to the project folder",
        ));
    }
    Ok(())
}

/// `project.json` belongs to the guide (identity, rename); other modules never write it
fn assert_not_project_file(rel_path: &str) -> Result<(), GuideError> {
    if rel_path.replace('\\', "/").to_lowercase() == project_folder_name("projectFile") {
        return Err(GuideError::plain(
            "project.json is written by the project guide only",
        ));
    }
    Ok(())
}

/// Writes into one project's data folder, each through the write guard
/// (`DataWriter`)
struct DataWriter<'a> {
    guide: &'a ProjectGuide,
    id: &'a str,
    root: String,
    /// The data folder name every write of this operation goes to (`dataDirName`, resolved once)
    data_dir: String,
    /// `project.json` text written by the first write of the operation
    fresh: String,
    identified: Cell<bool>,
}

impl DataWriter<'_> {
    /// `identify()`: the first file actually written also writes `project.json`
    /// when the folder has none (or names another id)
    fn identify(&self) -> Result<(), GuideError> {
        if self.identified.get() {
            return Ok(());
        }
        self.identified.set(true);
        self.guide.guard.update_data::<GuideError>(
            &self.root,
            project_folder_name("projectFile"),
            &mut |current: Option<&str>| -> Result<Option<String>, GuideError> {
                Ok(match current {
                    None => Some(self.fresh.clone()),
                    Some(text) if self.guide.id_needs_fix(self.id, &self.root, text) => {
                        Some(self.fresh.clone())
                    }
                    Some(_) => None,
                })
            },
            Some(&self.data_dir),
        )?;
        self.guide
            .pending_id_fix
            .borrow_mut()
            .retain(|pending| pending != self.id);
        Ok(())
    }

    /// `write(relPath, text)`
    fn write(&self, rel_path: &str, text: &str) -> Result<(), GuideError> {
        self.identify()?;
        self.guide
            .guard
            .write_data(&self.root, rel_path, text.as_bytes(), Some(&self.data_dir))?;
        Ok(())
    }

    /// `append(relPath, text)`
    fn append(&self, rel_path: &str, text: &str) -> Result<(), GuideError> {
        self.identify()?;
        self.guide
            .guard
            .append_data(&self.root, rel_path, text, Some(&self.data_dir))?;
        Ok(())
    }

    /// `update(relPath, change)`: `identify` runs when the change gives text
    fn update(
        &self,
        rel_path: &str,
        change: DataChange<'_, GuideError>,
    ) -> Result<DataUpdateResult, GuideError> {
        self.guide.guard.update_data::<GuideError>(
            &self.root,
            rel_path,
            &mut |current: Option<&str>| -> Result<Option<String>, GuideError> {
                let next = change(current)?;
                if next.is_some() {
                    self.identify()?;
                }
                Ok(next)
            },
            Some(&self.data_dir),
        )
    }

    /// `remove(relPath)`
    fn remove(&self, rel_path: &str) -> Result<(), GuideError> {
        self.guide
            .guard
            .remove_data(&self.root, rel_path, Some(&self.data_dir))?;
        Ok(())
    }
}

/// `ProjectGuide`
#[allow(clippy::type_complexity)]
pub struct ProjectGuide {
    settings_path: String,
    home_dir: String,
    user_data: String,
    platform: String,
    env: Option<EnvLookup>,
    default_parent_dir: RefCell<Box<dyn FnMut() -> String>>,
    now: RefCell<Box<dyn FnMut() -> f64>>,
    new_id: RefCell<Box<dyn FnMut() -> String>>,
    language: RefCell<Box<dyn FnMut() -> String>>,
    context_files: Option<RefCell<ContextFilesProvider>>,
    local_date: RefCell<Box<dyn FnMut(f64) -> LocalDateParts>>,
    warn: RefCell<Option<WarnFn>>,
    guard: ProjectWriteGuard,
    /// Projects whose `.seuoffice/` could not be written during this app run
    unwritable: RefCell<Vec<ProjectId>>,
    /// Copied folders listed under a new id whose `project.json` still names the original
    pending_id_fix: RefCell<Vec<ProjectId>>,
    cached_install_id: RefCell<Option<String>>,
    /// use times not written to the settings file yet (see `touch`)
    pending_touches: RefCell<JsMap<String>>,
    /// when each project's use time was last written (ms)
    touch_written_at: RefCell<JsMap<f64>>,
    touch_timer: Cell<Option<TouchTimer>>,
    touch_write_ms: f64,
}

impl ProjectGuide {
    /// `new ProjectGuide(deps)`
    pub fn new(deps: ProjectGuideDeps) -> Self {
        let platform = deps
            .platform
            .unwrap_or_else(|| process_platform().to_owned());
        let guard = ProjectWriteGuard::new(&platform);
        Self {
            settings_path: deps.settings_path,
            home_dir: deps.home_dir,
            user_data: deps.user_data,
            platform,
            env: deps.env,
            default_parent_dir: RefCell::new(deps.default_parent_dir),
            now: RefCell::new(deps.now.unwrap_or_else(|| Box::new(system_now))),
            new_id: RefCell::new(deps.new_id.unwrap_or_else(|| Box::new(default_new_id))),
            language: RefCell::new(
                deps.language
                    .unwrap_or_else(|| Box::new(|| "en".to_owned())),
            ),
            context_files: deps.context_files.map(RefCell::new),
            local_date: RefCell::new(deps.local_date),
            warn: RefCell::new(deps.warn),
            guard,
            unwritable: RefCell::new(Vec::new()),
            pending_id_fix: RefCell::new(Vec::new()),
            cached_install_id: RefCell::new(None),
            pending_touches: RefCell::new(JsMap::new()),
            touch_written_at: RefCell::new(JsMap::new()),
            touch_timer: Cell::new(None),
            touch_write_ms: deps.touch_write_ms.unwrap_or(PROJECT_TOUCH_WRITE_MS),
        }
    }

    // ────────────────────────── host ──────────────────────────

    /// `this.now().getTime()`: one read of the clock
    fn clock(&self) -> f64 {
        let mut now = self.now.borrow_mut();
        now()
    }

    /// `this.now().toISOString()`; an invalid time throws `RangeError`
    fn now_iso(&self) -> Result<String, GuideError> {
        to_iso_string(self.clock()).ok_or_else(|| GuideError::plain("Invalid time value"))
    }

    fn new_id(&self) -> String {
        let mut new_id = self.new_id.borrow_mut();
        new_id()
    }

    fn env_var(&self, key: &str) -> Option<String> {
        match &self.env {
            Some(lookup) => lookup(key),
            None => std::env::var(key).ok(),
        }
    }

    /// `process.env` as the sync-folder rule reads it
    fn env_object(&self) -> JsObject<String> {
        let mut env = JsObject::new();
        for key in SYNC_ENV_KEYS {
            if let Some(value) = self.env_var(key) {
                env.set(key, value);
            }
        }
        env
    }

    fn warn(&self, label: &str, detail: &str) {
        if let Some(warn) = self.warn.borrow_mut().as_mut() {
            warn(label, detail);
        }
    }

    // ────────────────────────── settings ──────────────────────────

    fn read(&self) -> StoredProjectsSettings {
        read_projects_settings(&self.settings_path)
    }

    fn update(
        &self,
        change: impl FnOnce(&mut StoredProjectsSettings),
    ) -> Result<StoredProjectsSettings, GuideError> {
        Ok(update_projects_settings(&self.settings_path, change)?)
    }

    fn refusal_context(&self) -> RefusalContext {
        RefusalContext {
            home_dir: self.home_dir.clone(),
            user_data: self.user_data.clone(),
            platform: self.platform.clone(),
        }
    }

    /// This install's random id, made and stored once
    pub fn install_id(&self) -> Result<String, GuideError> {
        if let Some(id) = self.cached_install_id.borrow().as_ref()
            && !id.is_empty()
        {
            return Ok(id.clone());
        }
        let mut id = self.read().install_id;
        if id.is_empty() {
            let fresh = self.new_id();
            id = self
                .update(|settings| {
                    if settings.install_id.is_empty() {
                        settings.install_id = fresh;
                    }
                })?
                .install_id;
        }
        *self.cached_install_id.borrow_mut() = Some(id.clone());
        Ok(id)
    }

    fn entry(&self, id: &str) -> Option<ListEntry> {
        entry_in(&self.read(), id)
    }

    /// The canonical folder of a listed project, or `None` (`null`)
    pub fn project_root(&self, id: &str) -> Option<String> {
        self.entry(id).map(|entry| entry.path)
    }

    pub fn trust_state(&self, id: &str) -> ProjectTrustState {
        match self.read().trust.get(id) {
            Some(record) => match decision_of(&record.decision) {
                ProjectTrustDecision::Use => ProjectTrustState::Use,
                ProjectTrustDecision::Without => ProjectTrustState::Without,
            },
            None => ProjectTrustState::Unconfirmed,
        }
    }

    pub fn is_unwritable(&self, id: &str) -> bool {
        self.unwritable.borrow().iter().any(|item| item == id)
    }

    /// Marks a project "unwritable" for this app run (a write into `.seuoffice/` failed)
    pub fn mark_unwritable(&self, id: &str) {
        let mut unwritable = self.unwritable.borrow_mut();
        if !unwritable.iter().any(|item| item == id) {
            unwritable.push(id.to_owned());
        }
    }

    fn is_sync_folder(&self, path: &str) -> bool {
        is_under_known_sync_folder(
            path,
            &self.env_object(),
            &SyncFolderOptions {
                platform: &self.platform,
                home_dir: Some(&self.home_dir),
                os_home_dir: &self.home_dir,
                extra_roots: &[],
            },
        )
    }

    fn sync_service(&self, path: &str) -> Option<SyncFolderService> {
        for key in ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"] {
            let env = self.env_var(key);
            if let Some(root) = truthy(env.as_deref())
                && is_inside_folder(path, root, &self.platform)
            {
                return Some(SyncFolderService::Onedrive);
            }
        }
        if js_regex!(r"onedrive", "i").test(path) {
            return Some(SyncFolderService::Onedrive);
        }
        if self.is_sync_folder(path) {
            Some(SyncFolderService::GoogleDrive)
        } else {
            None
        }
    }

    /// The one-time sync-folder notice, when due; marks it shown
    fn take_sync_notice(&self, id: &str, path: &str) -> Result<Vec<ProjectNotice>, GuideError> {
        if !self.is_sync_folder(path) {
            return Ok(Vec::new());
        }
        if self
            .read()
            .sync_notice_shown
            .iter()
            .any(|shown| shown == id)
        {
            return Ok(Vec::new());
        }
        self.update(|settings| {
            if !settings.sync_notice_shown.iter().any(|shown| shown == id) {
                settings.sync_notice_shown.push(id.to_owned());
            }
        })?;
        Ok(vec![ProjectNotice::SyncFolder {
            service: self.sync_service(path),
        }])
    }

    fn to_item(&self, entry: &ListEntry) -> ProjectListItem {
        let missing = !is_folder(&entry.path);
        let file = if missing {
            None
        } else {
            read_project_file(&entry.path, None)
        };
        ProjectListItem {
            id: entry.id.clone(),
            name: match file {
                Some(file) => file.name,
                None => basename(&entry.path, None),
            },
            path: entry.path.clone(),
            pinned: entry.pinned,
            last_used_at: self.last_used_of(entry),
            missing,
            unwritable: self.is_unwritable(&entry.id),
            sync_folder: self.is_sync_folder(&entry.path),
        }
    }

    /// Marks a project used now. Every send uses its project, so writing
    /// `app-settings.json` each time would rewrite the whole file per message: one
    /// project's time is written at most once per `touchWriteMs`; later times wait
    /// in memory (the list order already follows them) and are written when that
    /// interval is over or at `flushTouches` (app quit).
    fn touch(&self, id: &str) -> Result<(), GuideError> {
        let at = self.now_iso()?;
        let now_ms = self.clock();
        let last = self.touch_written_at.borrow().get(id).copied();
        let due = last.is_none_or(|last| now_ms - last >= self.touch_write_ms);
        self.pending_touches.borrow_mut().set(id, at);
        if due {
            return self.flush_touches();
        }
        if self.touch_timer.get().is_none() {
            self.touch_timer.set(Some(TouchTimer {
                armed_at: now_ms,
                delay: math_max(0.0, last.unwrap_or_default() + self.touch_write_ms - now_ms),
            }));
        }
        Ok(())
    }

    /// The timer `touch` set, if one is armed: the caller calls
    /// `flush_touches` at its `due()` (the TypeScript's `setTimeout`)
    pub fn touch_timer(&self) -> Option<TouchTimer> {
        self.touch_timer.get()
    }

    /// Writes the use times still held in memory (call at app quit, and when
    /// the timer of `touch_timer` is due)
    pub fn flush_touches(&self) -> Result<(), GuideError> {
        self.touch_timer.set(None);
        if self.pending_touches.borrow().is_empty() {
            return Ok(());
        }
        let pending: Vec<(String, String)> = self
            .pending_touches
            .borrow()
            .iter()
            .map(|(id, at)| (id.to_owned(), at.clone()))
            .collect();
        self.pending_touches.borrow_mut().clear();
        let now_ms = self.clock();
        self.update(|settings| {
            for (id, at) in &pending {
                if let Some(entry) = settings.list.iter_mut().find(|item| item.id == *id)
                    && js_greater(at, &entry.last_used_at)
                {
                    entry.last_used_at = at.clone();
                }
            }
        })?;
        for (id, _) in &pending {
            self.touch_written_at.borrow_mut().set(id.as_str(), now_ms);
        }
        Ok(())
    }

    /// `lastUsedAt` with a use time not written yet
    fn last_used_of(&self, entry: &ListEntry) -> String {
        match self.pending_touches.borrow().get(&entry.id) {
            Some(pending) if js_greater(pending, &entry.last_used_at) => pending.clone(),
            _ => entry.last_used_at.clone(),
        }
    }

    // ────────────────────────── list ──────────────────────────

    /// Pinned projects first, then the rest; each group newest `lastUsedAt` first
    pub fn list_projects(&self) -> Vec<ProjectListItem> {
        let mut entries: Vec<ListEntry> = self
            .read()
            .list
            .iter()
            .map(|entry| ListEntry {
                last_used_at: self.last_used_of(entry),
                ..entry.clone()
            })
            .collect();
        sort_by_number(&mut entries, |a, b| {
            if a.pinned != b.pinned {
                return if a.pinned { -1.0 } else { 1.0 };
            }
            locale_compare(&b.last_used_at, &a.last_used_at)
        });
        entries.iter().map(|entry| self.to_item(entry)).collect()
    }

    /// The list row of one project, or `None` (`null`) when it is not listed
    pub fn get_project(&self, id: &str) -> Option<ProjectListItem> {
        self.entry(id).map(|entry| self.to_item(&entry))
    }

    pub fn get_default_parent_folder(&self) -> String {
        let mut default_parent_dir = self.default_parent_dir.borrow_mut();
        default_parent_dir()
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<(), GuideError> {
        self.update(|settings| {
            if let Some(entry) = settings.list.iter_mut().find(|item| item.id == id) {
                entry.pinned = pinned;
            }
        })?;
        Ok(())
    }

    /// "Remove from list": drops the list entry (with its pin) and the project's
    /// per-document records. The folder, the trust record and its hashes stay, so
    /// adding the folder again does not ask again.
    pub fn remove_from_list(&self, id: &str) -> Result<(), GuideError> {
        self.update(|settings| drop_from_list(settings, id))?;
        self.unwritable.borrow_mut().retain(|item| item != id);
        self.pending_id_fix.borrow_mut().retain(|item| item != id);
        Ok(())
    }

    /// "Add folder" (spec 5.1): refusal rules, identity (5.11), trust (5.10).
    /// A folder with something to confirm asks first: resume with
    /// [`ProjectGuide::resume_add_folder`].
    pub fn add_folder(
        &self,
        folder_path: &str,
    ) -> Result<GuideStep<AddFolderResult, PendingAdopt>, GuideError> {
        self.adopt(folder_path, None)
    }

    /// Re-pick a "folder missing" project (spec 5.11); resumes like
    /// [`ProjectGuide::add_folder`]
    pub fn relocate_project(
        &self,
        id: &str,
        folder_path: &str,
    ) -> Result<GuideStep<AddFolderResult, PendingAdopt>, GuideError> {
        if self.entry(id).is_none() {
            return Err(unknown_project(id));
        }
        self.adopt(folder_path, Some(id))
    }

    /// The answer of the trust prompt `add_folder` or `relocate_project` asked
    pub fn resume_add_folder(
        &self,
        pending: PendingAdopt,
        answer: ProjectTrustAnswer,
    ) -> Result<AddFolderResult, GuideError> {
        let PendingAdopt { adoption, hashes } = pending;
        let Some(decision) = answer else {
            return Ok(AddFolderResult::Cancelled {
                stage: AddFolderStage::Trust,
            });
        };
        self.finish_adopt(
            *adoption,
            Some(StoredTrustRecord {
                decision: decision.as_str().to_owned(),
                hashes,
            }),
        )
    }

    fn adopt(
        &self,
        folder_path: &str,
        relocate_id: Option<&str>,
    ) -> Result<GuideStep<AddFolderResult, PendingAdopt>, GuideError> {
        let platform = self.platform.as_str();
        if !is_absolute(folder_path) {
            return Ok(GuideStep::Done(AddFolderResult::Refused {
                reason: FolderRefusalReason::NotAFolder,
            }));
        }
        let root = canonical_path(folder_path);
        if let Some(reason) = folder_refusal(&root, &self.refusal_context()) {
            return Ok(GuideStep::Done(AddFolderResult::Refused { reason }));
        }

        let file = read_project_file(&root, None);
        let settings = self.read();
        let verdict = classify_folder(&ClassifyInput {
            root: &root,
            file: file.as_ref(),
            settings: &settings,
            platform,
            relocate_id,
        });
        let FolderClassification::Ok {
            identity,
            id,
            previous,
            copied_from,
            stale_at_path,
        } = verdict
        else {
            return Ok(GuideStep::Done(AddFolderResult::Refused {
                reason: FolderRefusalReason::DifferentProject,
            }));
        };
        let id = match id {
            Some(id) => id,
            None => self.unique_new_id(&settings)?,
        };

        let name = match &file {
            Some(file) => file.name.clone(),
            None => basename(&root, None),
        };
        let mut trust_to_record: Option<StoredTrustRecord> = None;
        let inherited = copied_from
            .as_deref()
            .and_then(|source| settings.trust.get(source))
            .is_some();
        if settings.trust.get(&id).is_none() && !inherited {
            let scan = scan_for_trust(&TrustScanInput {
                root: root.clone(),
                project_id: id.clone(),
                name: name.clone(),
                install_id: self.install_id()?,
            });
            if scan.foreign {
                // `await askTrust(scan.prompt)`: the rest runs at the resume
                return Ok(GuideStep::AskTrust {
                    prompt: Box::new(scan.prompt),
                    pending: PendingAdopt {
                        adoption: Box::new(Adoption {
                            root,
                            id,
                            name,
                            identity,
                            previous,
                            copied_from,
                            stale_at_path,
                        }),
                        hashes: scan.hashes,
                    },
                });
            }
            trust_to_record = Some(StoredTrustRecord {
                decision: ProjectTrustDecision::Use.as_str().to_owned(),
                hashes: scan.hashes,
            });
        }

        let adoption = Adoption {
            root,
            id,
            name,
            identity,
            previous,
            copied_from,
            stale_at_path,
        };
        Ok(GuideStep::Done(
            self.finish_adopt(adoption, trust_to_record)?,
        ))
    }

    /// What `adopt` does after the trust decision: the copy's `project.json`,
    /// the list entry, the trust record
    fn finish_adopt(
        &self,
        adoption: Adoption,
        mut trust_to_record: Option<StoredTrustRecord>,
    ) -> Result<AddFolderResult, GuideError> {
        let platform = self.platform.as_str();
        let Adoption {
            root,
            id,
            name,
            identity,
            previous,
            copied_from,
            stale_at_path,
        } = adoption;

        if identity == FolderIdentity::Copied {
            let copy_file = ProjectFolderFile {
                version: PROJECT_FORMAT_VERSION,
                id: id.clone(),
                name: name.clone(),
                created_at: self.now_iso()?,
            };
            let wrote = self.try_write(&id, || {
                self.guard.write_data(
                    &root,
                    project_folder_name("projectFile"),
                    project_file_text(&copy_file).as_bytes(),
                    None,
                )?;
                Ok(())
            });
            // the folder still names the original's id: the next write that succeeds fixes it
            if wrote != ProjectWriteResult::Ok {
                let mut pending = self.pending_id_fix.borrow_mut();
                if !pending.contains(&id) {
                    pending.push(id.clone());
                }
            }
        }

        let at = self.now_iso()?;
        let mut final_id = id.clone();
        let mut final_identity = identity;
        self.update(|next| {
            if let Some(stale) = &stale_at_path {
                next.list.retain(|item| item.id != *stale);
            }
            // Another window may have listed this folder while the trust prompt was open.
            if let Some(taken) = next
                .list
                .iter()
                .find(|item| item.id != id && same_path(&item.path, &root, platform))
            {
                final_id = taken.id.clone();
                final_identity = FolderIdentity::Existing;
                return;
            }
            if next.list.iter().any(|item| item.id == id) {
                if let Some(previous) = &previous
                    && !same_path(&previous.path, &root, platform)
                {
                    rebase_opt_outs(next, &id, &previous.path, &root, platform);
                }
                if let Some(listed) = next.list.iter_mut().find(|item| item.id == id) {
                    listed.path = root.clone();
                    listed.last_used_at = at.clone();
                }
            } else {
                next.list.push(ListEntry {
                    id: id.clone(),
                    path: root.clone(),
                    pinned: false,
                    last_used_at: at.clone(),
                });
            }
            if let Some(record) = trust_to_record.take() {
                next.trust.set(id.as_str(), record);
            }
            if let Some(source_id) = &copied_from {
                if let Some(source) = next.trust.get(source_id).map(clone_trust)
                    && next.trust.get(&id).is_none()
                {
                    next.trust.set(id.as_str(), source);
                }
                if let Some(switches) = next.settings.get(source_id).cloned()
                    && next.settings.get(&id).is_none()
                {
                    next.settings.set(id.as_str(), switches);
                }
            }
        })?;

        if final_id != id {
            self.pending_id_fix.borrow_mut().retain(|item| *item != id);
        }
        let notices = self.take_sync_notice(&final_id, &root)?;
        let Some(entry) = self.entry(&final_id) else {
            return Err(GuideError::plain(format!(
                "project {final_id} was not listed"
            )));
        };
        Ok(AddFolderResult::Added {
            project: self.to_item(&entry),
            identity: final_identity,
            notices,
        })
    }

    fn unique_new_id(&self, settings: &StoredProjectsSettings) -> Result<ProjectId, GuideError> {
        loop {
            let id = self.new_id();
            if !is_valid_project_id(&id) {
                return Err(GuideError::plain("newId produced an invalid project id"));
            }
            if settings.trust.get(&id).is_none() && !settings.list.iter().any(|item| item.id == id)
            {
                return Ok(id);
            }
        }
    }

    /// "New project" (spec 5.1): a new folder named `name` under the default save
    /// folder (or `parentDir`) with `.seuoffice/project.json`, trusted without asking.
    /// An existing folder of that name is never written to unless `useExisting` asks
    /// to add it as a project (identity and trust as for "add folder"; that path can
    /// ask, and resumes with [`ProjectGuide::resume_create_project`]).
    pub fn create_project(
        &self,
        args: &NewProjectRequest,
    ) -> Result<GuideStep<CreateProjectResult, PendingAdopt>, GuideError> {
        let name = trim(&args.name);
        if !is_valid_rename_name(name) || name.chars().count() > PROJECT_NAME_MAX_CHARS {
            return Ok(GuideStep::Done(CreateProjectResult::InvalidName));
        }
        let chosen = match &args.parent_dir {
            Some(parent_dir) => parent_dir.clone(),
            None => self.get_default_parent_folder(),
        };
        if !is_absolute(&chosen) {
            return Ok(GuideStep::Done(CreateProjectResult::Unwritable));
        }
        let parent = canonical_path(&chosen);
        let target = join(&[&parent, name]);
        if let Some(reason) = location_refusal(&target, &self.refusal_context()) {
            return Ok(GuideStep::Done(CreateProjectResult::Refused { reason }));
        }
        if exists(&target) {
            // A folder of that name that is already a listed project just opens:
            // there is nothing to ask (the result says `existing`).
            let listed = self
                .read()
                .list
                .iter()
                .any(|item| same_path(&item.path, &target, &self.platform));
            return if args.use_existing == Some(true) || listed {
                Ok(match self.adopt(&target, None)? {
                    GuideStep::Done(result) => GuideStep::Done(result.into()),
                    GuideStep::AskTrust { prompt, pending } => {
                        GuideStep::AskTrust { prompt, pending }
                    }
                })
            } else {
                Ok(GuideStep::Done(CreateProjectResult::Exists {
                    folder_path: target,
                }))
            };
        }

        let root = match self.guard.create_project_folder(&parent, name) {
            Ok(root) => root,
            Err(WriteGuardError::Refused(refused))
                if refused.reason == ProjectWriteRefusal::Exists =>
            {
                return Ok(GuideStep::Done(CreateProjectResult::Exists {
                    folder_path: target,
                }));
            }
            Err(_) => return Ok(GuideStep::Done(CreateProjectResult::Unwritable)),
        };
        let id = self.unique_new_id(&self.read())?;
        let file = ProjectFolderFile {
            version: PROJECT_FORMAT_VERSION,
            id: id.clone(),
            name: clean_project_name(name),
            created_at: self.now_iso()?,
        };
        if self
            .guard
            .write_data(
                &root,
                project_folder_name("projectFile"),
                project_file_text(&file).as_bytes(),
                None,
            )
            .is_err()
        {
            self.remove_empty_new_folder(&root);
            return Ok(GuideStep::Done(CreateProjectResult::Unwritable));
        }
        let at = self.now_iso()?;
        self.update(|settings| {
            settings.list.push(ListEntry {
                id: id.clone(),
                path: root.clone(),
                pinned: false,
                last_used_at: at.clone(),
            });
            settings.trust.set(
                id.as_str(),
                StoredTrustRecord {
                    decision: "use".to_owned(),
                    hashes: JsObject::new(),
                },
            );
        })?;
        let Some(entry) = self.entry(&id) else {
            return Err(GuideError::plain(format!("project {id} was not listed")));
        };
        Ok(GuideStep::Done(CreateProjectResult::Created {
            project: self.to_item(&entry),
        }))
    }

    /// The answer of the trust prompt `create_project` asked
    pub fn resume_create_project(
        &self,
        pending: PendingAdopt,
        answer: ProjectTrustAnswer,
    ) -> Result<CreateProjectResult, GuideError> {
        Ok(self.resume_add_folder(pending, answer)?.into())
    }

    /// Undo a just-made project folder whose `project.json` could not be written
    fn remove_empty_new_folder(&self, root: &str) {
        let data_dir = join(&[root, &data_dir_name(root)]);
        for dir in [data_dir.as_str(), root] {
            // Not empty or already gone: leave whatever is there.
            let _ = std::fs::remove_dir(namespaced(dir));
        }
    }

    /// Renames in `project.json` only; the folder keeps its name
    pub fn rename_project(&self, id: &str, name: &str) -> Result<ProjectWriteResult, GuideError> {
        let clean = clean_project_name(name);
        if clean.is_empty() {
            return Err(GuideError::plain("a project name cannot be empty"));
        }
        let Some(entry) = self.entry(id) else {
            return Err(unknown_project(id));
        };
        if self.is_unwritable(id) {
            return Ok(ProjectWriteResult::Unwritable);
        }
        Ok(self.try_write(id, || {
            self.guard.update_data::<GuideError>(
                &entry.path,
                project_folder_name("projectFile"),
                &mut |current: Option<&str>| -> Result<Option<String>, GuideError> {
                    let existing = current.and_then(parse_created_at);
                    let created_at = match existing {
                        Some(created_at) => created_at,
                        None => self.now_iso()?,
                    };
                    Ok(Some(project_file_text(&ProjectFolderFile {
                        version: PROJECT_FORMAT_VERSION,
                        id: id.to_owned(),
                        name: clean.clone(),
                        created_at,
                    })))
                },
                None,
            )?;
            Ok(())
        }))
    }

    /// Clears "unwritable" and writes `project.json` again (creating it when absent)
    pub fn retry_unwritable(&self, id: &str) -> Result<ProjectWriteResult, GuideError> {
        self.unwritable.borrow_mut().retain(|item| item != id);
        let Some(entry) = self.entry(id) else {
            return Err(unknown_project(id));
        };
        let data_dir = data_dir_name(&entry.path);
        let fresh = project_file_text(&self.project_file_for(id, &entry.path, &data_dir)?);
        let result = self.try_write(id, || {
            self.guard.update_data::<GuideError>(
                &entry.path,
                project_folder_name("projectFile"),
                &mut |current: Option<&str>| -> Result<Option<String>, GuideError> {
                    Ok(Some(match current {
                        Some(text) if !self.id_needs_fix(id, &entry.path, text) => text.to_owned(),
                        _ => fresh.clone(),
                    }))
                },
                Some(&data_dir),
            )?;
            Ok(())
        });
        if result == ProjectWriteResult::Ok {
            self.pending_id_fix.borrow_mut().retain(|item| item != id);
        }
        Ok(result)
    }

    /// `project.json` text at a listed project's folder names another id that must be
    /// replaced: a copy whose new id could not be written when it was added (this run),
    /// or, after a restart, a folder whose file still names a project listed at another
    /// folder (the original of the copy). Any other id is left alone.
    fn id_needs_fix(&self, id: &str, root: &str, current: &str) -> bool {
        let file_id = match json_parse(current) {
            Ok(JsonValue::Object(raw)) => match raw.get("id") {
                Some(JsonValue::String(file_id)) => Some(file_id.clone()),
                _ => None,
            },
            Ok(_) => None,
            Err(_) => return false,
        };
        let Some(file_id) = file_id else {
            return false;
        };
        if file_id == id || !is_valid_project_id(&file_id) {
            return false;
        }
        if self.pending_id_fix.borrow().iter().any(|item| item == id) {
            return true;
        }
        match self.entry(&file_id) {
            Some(original) => !same_path(&original.path, root, &self.platform),
            None => false,
        }
    }

    fn project_file_for(
        &self,
        id: &str,
        root: &str,
        data_dir: &str,
    ) -> Result<ProjectFolderFile, GuideError> {
        let file = read_project_file(root, Some(data_dir));
        let (name, created_at) = match file {
            Some(file) => (file.name, file.created_at),
            None => (basename(root, None), self.now_iso()?),
        };
        Ok(ProjectFolderFile {
            version: PROJECT_FORMAT_VERSION,
            id: id.to_owned(),
            name,
            created_at,
        })
    }

    // ────────────────────────── writes ──────────────────────────

    /// Runs one write; a failure marks the project unwritable for this run and is reported, not thrown
    fn try_write(
        &self,
        id: &str,
        write: impl FnOnce() -> Result<(), GuideError>,
    ) -> ProjectWriteResult {
        match write() {
            Ok(()) => ProjectWriteResult::Ok,
            Err(error) => {
                self.mark_unwritable(id);
                self.warn(
                    &format!("[projects] cannot write into project {id}:"),
                    &error.message(),
                );
                ProjectWriteResult::Unwritable
            }
        }
    }

    /// A write into a listed project's data folder. Refused without trying while the
    /// project is marked unwritable. The first file actually written also writes
    /// `project.json` when the folder has none, so the folder carries its identity; an
    /// operation that ends up writing nothing creates nothing. The data folder is
    /// resolved once (or given by a caller that already read from it), so an older
    /// version making the other folder meanwhile cannot split one operation across two.
    fn write_with_identity<F>(
        &self,
        id: &str,
        write: F,
        known_data_dir: Option<&str>,
    ) -> Result<ProjectWriteResult, GuideError>
    where
        F: FnOnce(&DataWriter<'_>) -> Result<(), GuideError>,
    {
        let Some(entry) = self.entry(id) else {
            return Err(unknown_project(id));
        };
        if self.is_unwritable(id) {
            return Ok(ProjectWriteResult::Unwritable);
        }
        let root = entry.path;
        let data_dir = match known_data_dir {
            Some(data_dir) => data_dir.to_owned(),
            None => data_dir_name(&root),
        };
        let fresh = project_file_text(&self.project_file_for(id, &root, &data_dir)?);
        let data = DataWriter {
            guide: self,
            id,
            root,
            data_dir,
            fresh,
            identified: Cell::new(false),
        };
        Ok(self.try_write(id, || write(&data)))
    }

    /// Replace a file in the data folder (for the chat store). `dataDir` pins the
    /// folder a caller already read from; absent, it is resolved now.
    pub fn write_data(
        &self,
        id: &str,
        rel_path: &str,
        text: &str,
        data_dir: Option<&str>,
    ) -> Result<ProjectWriteResult, GuideError> {
        assert_not_project_file(rel_path)?;
        self.write_with_identity(id, |data| data.write(rel_path, text), data_dir)
    }

    /// Append to a file in the data folder (chat message lines); `dataDir` as for `writeData`
    pub fn append_data(
        &self,
        id: &str,
        rel_path: &str,
        text: &str,
        data_dir: Option<&str>,
    ) -> Result<ProjectWriteResult, GuideError> {
        assert_not_project_file(rel_path)?;
        self.write_with_identity(id, |data| data.append(rel_path, text), data_dir)
    }

    /// Read-change-write one file in the data folder, serialized with every other
    /// write to it. `change` gets the file's text (`None` when absent) and answers
    /// the text to write, or `None` to write nothing; what it fails with is
    /// reported as an unwritable project, as the TypeScript's `tryWrite` does.
    pub fn update_data(
        &self,
        id: &str,
        rel_path: &str,
        change: DataChange<'_, GuideError>,
        data_dir: Option<&str>,
    ) -> Result<DataUpdateOutcome, GuideError> {
        assert_not_project_file(rel_path)?;
        let mut outcome = DataUpdateResult {
            written: false,
            text: None,
        };
        let result = self.write_with_identity(
            id,
            |data| {
                outcome = data.update(rel_path, change)?;
                Ok(())
            },
            data_dir,
        )?;
        Ok(match result {
            ProjectWriteResult::Ok => DataUpdateOutcome::Ok {
                written: outcome.written,
                text: outcome.text,
            },
            ProjectWriteResult::Unwritable => DataUpdateOutcome::Unwritable,
        })
    }

    /// Delete one file in the data folder
    pub fn remove_data(
        &self,
        id: &str,
        rel_path: &str,
        data_dir: Option<&str>,
    ) -> Result<ProjectWriteResult, GuideError> {
        assert_not_project_file(rel_path)?;
        self.write_with_identity(id, |data| data.remove(rel_path), data_dir)
    }

    /// The checked absolute path of a file in a listed project's data folder
    /// (nothing is touched); `None` (`null`) when the project is not listed
    pub fn data_path(
        &self,
        id: &str,
        rel_path: &str,
        data_dir: Option<&str>,
    ) -> Result<Option<String>, ProjectWriteRefused> {
        match self.entry(id) {
            Some(entry) => self
                .guard
                .data_path(&entry.path, rel_path, data_dir)
                .map(Some),
            None => Ok(None),
        }
    }

    /// Write a new document the AI made (spec 6) at `target`: inside the project folder,
    /// not under `.seuoffice/`, in an existing folder, never over an existing entry.
    /// Throws `ProjectWriteRefused` (or the file system error); callers pick a free name.
    pub fn write_new_document(
        &self,
        id: &str,
        target: &str,
        data: &[u8],
    ) -> Result<ProjectWriteResult, WriteGuardError> {
        let Some(entry) = self.entry(id) else {
            return Err(WriteGuardError::Fs(NodeError {
                code: None,
                message: format!("unknown project {id}"),
            }));
        };
        self.guard.write_new_document(&entry.path, target, data)?;
        Ok(ProjectWriteResult::Ok)
    }

    /// A document's path relative to a project folder (`/`-separated), or `None` (`null`) when outside
    pub fn document_relative_path(&self, id: &str, doc_path: &str) -> Option<String> {
        let entry = self.entry(id)?;
        relative_inside(&entry.path, &canonical_path(doc_path), &self.platform)
    }

    fn record_hashes(
        &self,
        id: &str,
        hashes: &[(ProjectHashedFile, Option<String>)],
    ) -> Result<(), GuideError> {
        self.update(|settings| {
            let Some(record) = settings.trust.get_mut(id) else {
                return;
            };
            for (file, hash) in hashes {
                match hash {
                    None => delete_key(&mut record.hashes, file.as_str()),
                    Some(hash) => record.hashes.set(file.as_str(), hash.clone()),
                }
            }
        })?;
        Ok(())
    }

    // ────────────────────────── context ──────────────────────────

    /// The visibility rule of one project (reads its `ignore` now); `None` when not listed
    pub fn ai_visibility(&self, id: &str) -> Result<Option<ProjectAiVisibility>, GuideError> {
        let Some(entry) = self.entry(id) else {
            return Ok(None);
        };
        let root = entry.path;
        let text =
            read_data_text(&root, project_folder_name("ignoreFile"), None).unwrap_or_default();
        let folds = ignore_folds_case(&self.platform);
        let matcher = compile_ignore(
            &text,
            IgnoreOptions {
                case_insensitive: folds,
            },
        )?;
        Ok(Some(ProjectAiVisibility {
            root,
            matcher,
            rule_key: Some(hash_text(&format!(
                "{}:{text}",
                if folds { "i" } else { "s" }
            ))),
        }))
    }

    /// What the next request carries (spec 5.4): name, instructions (cut at the limit),
    /// memory (whole), file names, notices. Under `without` the instructions, memory and
    /// root agent files are left out. A file changed outside the app gives one
    /// "changed" notice, then its new hash is recorded.
    pub fn read_context(&self, id: &str) -> Result<ProjectContextResult, GuideError> {
        let settings = self.read();
        let Some(entry) = entry_in(&settings, id) else {
            return Ok(ProjectContextResult::Unknown);
        };
        let root = entry.path;
        if !is_folder(&root) {
            return Ok(ProjectContextResult::Missing);
        }
        let record = settings.trust.get(id);
        // A listed project without a trust record was never confirmed: send nothing foreign.
        let trust = match record {
            Some(record) => decision_of(&record.decision),
            None => ProjectTrustDecision::Without,
        };
        let switches = settings_of(id, &settings);
        let mut notices: Vec<ProjectNotice> = Vec::new();
        let mut instructions: Option<ProjectContextInstructions> = None;
        let mut memory: Option<ProjectContextMemory> = None;
        if trust == ProjectTrustDecision::Use
            && let Some(record) = record
        {
            let assembled = assemble_trusted_context(
                &read_hashed_texts(&root),
                &ProjectTrustRecord {
                    decision: trust,
                    hashes: record.hashes.clone(),
                },
                &switches,
                INSTRUCTIONS_LIMIT_CHARS,
                MEMORY_SOFT_LIMIT_CHARS,
            );
            instructions = assembled
                .instructions
                .map(|instructions| ProjectContextInstructions {
                    text: instructions.text,
                    sources: instructions.sources,
                    data_dir: Some(instructions.data_dir),
                });
            memory = assembled.memory.map(|memory| ProjectContextMemory {
                text: memory.text,
                chars: memory.chars,
            });
            notices.extend(assembled.notices);
            if !assembled.hash_updates.is_empty() {
                self.record_hashes(id, &assembled.hash_updates)?;
            }
        }

        let unwritable = self.is_unwritable(id);
        if unwritable {
            notices.push(ProjectNotice::Unwritable);
        }
        notices.extend(self.take_sync_notice(id, &root)?);

        let mut files = ContextFiles {
            files: Vec::new(),
            omitted: 0,
        };
        if let Some(provider) = &self.context_files
            && let Some(visibility) = self.ai_visibility(id)?
        {
            let mut provider = provider.borrow_mut();
            files = provider(&ContextFilesRequest {
                id: id.to_owned(),
                root: root.clone(),
                visibility,
            });
        }
        self.touch(id)?;
        let file = read_project_file(&root, None);
        Ok(ProjectContextResult::Ok {
            context: Box::new(ProjectContextBundle {
                project_id: id.to_owned(),
                name: match file {
                    Some(file) => file.name,
                    None => basename(&root, None),
                },
                trust,
                instructions,
                memory,
                files: files.files,
                files_omitted: files.omitted,
                can_remember: switches.memory_enabled
                    && trust == ProjectTrustDecision::Use
                    && !unwritable,
                notices,
            }),
        })
    }

    // ────────────────────────── project screen ──────────────────────────

    /// Everything the project screen shows, read as it is (trust does not hide it)
    pub fn get_project_detail(&self, id: &str) -> Result<ProjectDetail, GuideError> {
        let Some(entry) = self.entry(id) else {
            return Err(unknown_project(id));
        };
        let root = entry.path.clone();
        let texts = read_hashed_texts(&root);
        let memory = texts.memory.clone().unwrap_or_default();
        let names = plain_folder_entries(&root, &[texts.data_dir.as_str()]);
        let mut conflicts: Vec<String> = names
            .into_iter()
            .filter(|name| {
                js_regex!(r"^memory.*\.md$", "i").test(name)
                    && name.to_lowercase() != project_folder_name("memoryFile")
                    && !memory_backup_pattern().test(name)
            })
            .collect();
        sort_utf16(&mut conflicts);
        Ok(ProjectDetail {
            project: self.to_item(&entry),
            trust: self.trust_state(id),
            settings: settings_of(id, &self.read()),
            instructions: texts.instructions.unwrap_or_default(),
            agents: texts.agents,
            claude: texts.claude,
            memory_entries: memory_entries(&memory),
            memory_chars: memory.encode_utf16().count() as u64,
            memory,
            memory_conflict_copies: conflicts,
        })
    }

    pub fn get_settings(&self, id: &str) -> ProjectSettings {
        settings_of(id, &self.read())
    }

    pub fn set_settings(
        &self,
        id: &str,
        patch: &ProjectSettingsPatch,
    ) -> Result<ProjectSettings, GuideError> {
        let next = self.update(|settings| {
            let mut current = match settings.settings.get(id) {
                Some(switches) => switches.clone(),
                None => ProjectSwitches {
                    memory_enabled: DEFAULT_SETTINGS.memory_enabled,
                    read_agents_files: DEFAULT_SETTINGS.read_agents_files,
                },
            };
            if let Some(memory_enabled) = patch.memory_enabled {
                current.memory_enabled = memory_enabled;
            }
            if let Some(read_agents_files) = patch.read_agents_files {
                current.read_agents_files = read_agents_files;
            }
            settings.settings.set(id, current);
        })?;
        Ok(settings_of(id, &next))
    }

    /// Change trust from the project screen. `without` applies at once; `use` shows the
    /// trust prompt again when the folder holds anything to confirm (resume with
    /// [`ProjectGuide::resume_decide_trust`]), and a closed prompt leaves the project
    /// as it was.
    pub fn decide_trust(
        &self,
        id: &str,
        decision: ProjectTrustDecision,
    ) -> Result<GuideStep<DecideTrustResult, PendingDecideTrust>, GuideError> {
        let Some(entry) = self.entry(id) else {
            return Err(unknown_project(id));
        };
        if decision == ProjectTrustDecision::Without {
            self.update(|settings| {
                let hashes = settings
                    .trust
                    .get(id)
                    .map(|record| record.hashes.clone())
                    .unwrap_or_default();
                settings.trust.set(
                    id,
                    StoredTrustRecord {
                        decision: "without".to_owned(),
                        hashes,
                    },
                );
            })?;
            return Ok(GuideStep::Done(DecideTrustResult::Ok {
                trust: ProjectTrustDecision::Without,
            }));
        }
        if self.trust_state(id) == ProjectTrustState::Use {
            return Ok(GuideStep::Done(DecideTrustResult::Ok {
                trust: ProjectTrustDecision::Use,
            }));
        }
        let file = read_project_file(&entry.path, None);
        let scan = scan_for_trust(&TrustScanInput {
            root: entry.path.clone(),
            project_id: id.to_owned(),
            name: match file {
                Some(file) => file.name,
                None => basename(&entry.path, None),
            },
            install_id: self.install_id()?,
        });
        if scan.foreign {
            // `await askTrust(scan.prompt)`: the rest runs at the resume
            return Ok(GuideStep::AskTrust {
                prompt: Box::new(scan.prompt),
                pending: PendingDecideTrust {
                    id: id.to_owned(),
                    hashes: scan.hashes,
                },
            });
        }
        Ok(GuideStep::Done(self.finish_decide_trust(
            id,
            Some(ProjectTrustDecision::Use),
            scan.hashes,
        )?))
    }

    /// The answer of the trust prompt `decide_trust` asked
    pub fn resume_decide_trust(
        &self,
        pending: PendingDecideTrust,
        answer: ProjectTrustAnswer,
    ) -> Result<DecideTrustResult, GuideError> {
        let PendingDecideTrust { id, hashes } = pending;
        self.finish_decide_trust(&id, answer, hashes)
    }

    /// What `decideTrust` does with the answer
    fn finish_decide_trust(
        &self,
        id: &str,
        answer: ProjectTrustAnswer,
        hashes: JsObject<String>,
    ) -> Result<DecideTrustResult, GuideError> {
        match answer {
            None => return Ok(DecideTrustResult::Cancelled),
            Some(ProjectTrustDecision::Without) => {
                return Ok(DecideTrustResult::Ok {
                    trust: ProjectTrustDecision::Without,
                });
            }
            Some(ProjectTrustDecision::Use) => {}
        }
        self.update(|settings| {
            settings.trust.set(
                id,
                StoredTrustRecord {
                    decision: "use".to_owned(),
                    hashes,
                },
            );
        })?;
        Ok(DecideTrustResult::Ok {
            trust: ProjectTrustDecision::Use,
        })
    }

    pub fn save_instructions(
        &self,
        id: &str,
        text: &str,
    ) -> Result<ProjectWriteResult, GuideError> {
        let result = self.write_with_identity(
            id,
            |data| data.write(project_folder_name("instructionsFile"), text),
            None,
        )?;
        if result == ProjectWriteResult::Ok {
            self.record_hashes(
                id,
                &[(ProjectHashedFile::Instructions, Some(hash_text(text)))],
            )?;
        }
        Ok(result)
    }

    pub fn add_ignore(&self, id: &str, rel_path: &str) -> Result<ProjectWriteResult, GuideError> {
        assert_folder_relative(rel_path)?;
        self.write_with_identity(
            id,
            |data| {
                data.update(project_folder_name("ignoreFile"), &mut |current: Option<
                    &str,
                >| {
                    let next = add_ignore_line(current.unwrap_or(""), rel_path);
                    Ok(if current == Some(next.as_str()) {
                        None
                    } else {
                        Some(next)
                    })
                })?;
                Ok(())
            },
            None,
        )
    }

    pub fn remove_ignore(
        &self,
        id: &str,
        rel_path: &str,
    ) -> Result<ProjectWriteResult, GuideError> {
        assert_folder_relative(rel_path)?;
        self.write_with_identity(
            id,
            |data| {
                data.update(project_folder_name("ignoreFile"), &mut |current: Option<
                    &str,
                >| {
                    let Some(current) = current else {
                        return Ok(None);
                    };
                    let next = remove_ignore_line(current, rel_path);
                    Ok(if next == current { None } else { Some(next) })
                })?;
                Ok(())
            },
            None,
        )
    }

    // ────────────────────────── memory ──────────────────────────

    fn memory_context(&self) -> MemoryOpContext {
        let parts = {
            let at = self.clock();
            let mut local = self.local_date.borrow_mut();
            local(at)
        };
        let language = {
            let mut language = self.language.borrow_mut();
            language()
        };
        MemoryOpContext {
            today: local_date(&parts),
            header: memory_header(&language),
        }
    }

    /// One memory change (spec 5.6), applied to the file as it is right now. `ai` is the
    /// `project_remember` tool: refused while memory is off or trust is `without`. `person`
    /// is a "[remove]" on a memory line or the screen's per-entry delete.
    pub fn edit_memory(
        &self,
        id: &str,
        change: &ProjectMemoryOp,
        by: MemoryEditor,
    ) -> Result<ProjectMemoryEditResult, GuideError> {
        if self.entry(id).is_none() {
            return Err(unknown_project(id));
        }
        let refused =
            |reason: ProjectMemoryRefusal| -> Result<ProjectMemoryEditResult, GuideError> {
                Ok(ProjectMemoryEditResult::Refused { reason })
            };
        if by == MemoryEditor::Ai {
            if !settings_of(id, &self.read()).memory_enabled {
                return refused(ProjectMemoryRefusal::Disabled);
            }
            if self.trust_state(id) != ProjectTrustState::Use {
                return refused(ProjectMemoryRefusal::Without);
            }
        }
        if self.is_unwritable(id) {
            return refused(ProjectMemoryRefusal::Unwritable);
        }
        let mut applied: Option<MemoryOpResult> = None;
        let mut written: Option<String> = None;
        let result = self.write_with_identity(
            id,
            |data| {
                let outcome = data.update(
                    project_folder_name("memoryFile"),
                    &mut |current: Option<&str>| {
                        let result = apply_memory_op(current, change, &self.memory_context());
                        let next = match &result {
                            MemoryOpResult::Ok { text, .. } if current != Some(text.as_str()) => {
                                Some(text.clone())
                            }
                            _ => None,
                        };
                        applied = Some(result);
                        Ok(next)
                    },
                )?;
                if outcome.written {
                    written = outcome.text;
                }
                Ok(())
            },
            None,
        )?;
        if result != ProjectWriteResult::Ok {
            return refused(ProjectMemoryRefusal::Unwritable);
        }
        let Some(done) = applied else {
            return refused(ProjectMemoryRefusal::Invalid);
        };
        let change = match done {
            MemoryOpResult::Refused { reason } => {
                return refused(match reason {
                    MemoryOpRefusal::NotFound => ProjectMemoryRefusal::NotFound,
                    MemoryOpRefusal::Invalid => ProjectMemoryRefusal::Invalid,
                });
            }
            MemoryOpResult::Ok { change, .. } => change,
        };
        if let Some(written) = written {
            self.record_hashes(
                id,
                &[(ProjectHashedFile::Memory, Some(hash_text(&written)))],
            )?;
        }
        Ok(ProjectMemoryEditResult::Ok { change })
    }

    /// The screen's "edit all": replaces `memory.md` with the person's text
    pub fn save_memory(&self, id: &str, text: &str) -> Result<ProjectWriteResult, GuideError> {
        let result = self.write_with_identity(
            id,
            |data| data.write(project_folder_name("memoryFile"), text),
            None,
        )?;
        if result == ProjectWriteResult::Ok {
            self.record_hashes(id, &[(ProjectHashedFile::Memory, Some(hash_text(text)))])?;
        }
        Ok(result)
    }

    /// Replace the memory with a consolidated list (person-triggered only). The current
    /// `memory.md` is first kept as `memory.<YYYYMMDD-HHmmss>.bak.md`; only the newest
    /// three backups stay.
    pub fn apply_memory_consolidation(
        &self,
        args: &ApplyMemoryConsolidationArgs,
    ) -> Result<ApplyMemoryConsolidationResult, GuideError> {
        let id = args.project_id.as_str();
        if self.entry(id).is_none() {
            return Err(unknown_project(id));
        }
        let MemoryOpContext { today, header } = self.memory_context();
        let mut before = 0u64;
        let mut after = 0u64;
        let mut backup_name = String::new();
        let mut written = String::new();
        let result = self.write_with_identity(
            id,
            |data| {
                data.update(project_folder_name("memoryFile"), &mut |current: Option<
                    &str,
                >| {
                    backup_name = self.free_backup_name(data);
                    data.write(&backup_name, current.unwrap_or(""))?;
                    written = build_memory_text(&args.entries, &header, &today);
                    before = memory_entries(current.unwrap_or("")).len() as u64;
                    after = memory_entries(&written).len() as u64;
                    Ok(Some(written.clone()))
                })?;
                self.prune_backups(data)
            },
            None,
        )?;
        if result != ProjectWriteResult::Ok {
            return Ok(ApplyMemoryConsolidationResult::Unwritable);
        }
        self.record_hashes(
            id,
            &[(ProjectHashedFile::Memory, Some(hash_text(&written)))],
        )?;
        Ok(ApplyMemoryConsolidationResult::Ok {
            before,
            after,
            backup_name,
        })
    }

    /// Restore the newest backup (the one the "[undo]" line names)
    pub fn undo_memory_consolidation(
        &self,
        args: &UndoMemoryConsolidationArgs,
    ) -> Result<UndoMemoryConsolidationResult, GuideError> {
        let id = args.project_id.as_str();
        let Some(entry) = self.entry(id) else {
            return Err(unknown_project(id));
        };
        if !memory_backup_pattern().test(&args.backup_name) {
            return Ok(UndoMemoryConsolidationResult::NoBackup);
        }
        let data_dir = data_dir_name(&entry.path);
        let names = self.backup_names(&entry.path, &data_dir);
        let Some(newest) = names.first() else {
            return Ok(UndoMemoryConsolidationResult::NoBackup);
        };
        if *newest != args.backup_name {
            return Ok(UndoMemoryConsolidationResult::NoBackup);
        }
        let Some(text) = read_data_text(&entry.path, newest, Some(&data_dir)) else {
            return Ok(UndoMemoryConsolidationResult::NoBackup);
        };
        let result = self.write_with_identity(
            id,
            |data| data.write(project_folder_name("memoryFile"), &text),
            Some(&data_dir),
        )?;
        if result != ProjectWriteResult::Ok {
            return Ok(UndoMemoryConsolidationResult::Unwritable);
        }
        self.record_hashes(id, &[(ProjectHashedFile::Memory, Some(hash_text(&text)))])?;
        Ok(UndoMemoryConsolidationResult::Ok {
            entries: memory_entries(&text).len() as u64,
        })
    }

    /// Backup names in `dataDir`, newest first
    fn backup_names(&self, root: &str, data_dir: &str) -> Vec<String> {
        let mut names: Vec<String> = plain_folder_entries(root, &[data_dir])
            .into_iter()
            .filter(|name| memory_backup_pattern().test(name))
            .collect();
        sort_utf16(&mut names);
        names.reverse();
        names
    }

    fn free_backup_name(&self, data: &DataWriter<'_>) -> String {
        let taken = self.backup_names(&data.root, &data.data_dir);
        let mut at = self.clock();
        loop {
            let name = {
                let mut local = self.local_date.borrow_mut();
                memory_backup_name(&local(at))
            };
            if !taken.contains(&name) {
                return name;
            }
            at += 1000.0;
        }
    }

    fn prune_backups(&self, data: &DataWriter<'_>) -> Result<(), GuideError> {
        let names = self.backup_names(&data.root, &data.data_dir);
        for name in names.iter().skip(MEMORY_BACKUPS_KEPT) {
            data.remove(name)?;
        }
        Ok(())
    }

    // ────────────────────────── selection ──────────────────────────

    fn resolve_target(
        &self,
        target: &SelectionTarget,
    ) -> Result<ResolvedSelectionTarget, GuideError> {
        Ok(match target {
            SelectionTarget::Document { path } => {
                if !is_absolute(path) {
                    return Err(GuideError::plain("expected an absolute document path"));
                }
                ResolvedSelectionTarget::Document {
                    doc_key: canonical_path(path),
                }
            }
            SelectionTarget::Untitled { project_id } => ResolvedSelectionTarget::Untitled {
                project_id: project_id.clone(),
            },
            SelectionTarget::Home => ResolvedSelectionTarget::Home,
        })
    }

    /// The project a window's AI panel starts with (spec 5.2). `initialChatId` is set
    /// only for a document outside every project (its remembered last chat); the chat
    /// store picks the chat of a document inside a project (spec 5.3.1).
    pub fn get_selection(&self, target: &SelectionTarget) -> Result<ProjectSelection, GuideError> {
        let settings = self.read();
        let resolved = self.resolve_target(target)?;
        let selection = selection_for(&settings, &resolved, &self.platform);
        let ResolvedSelectionTarget::Document { doc_key } = &resolved else {
            return Ok(selection);
        };
        let hint = find_unregistered_project(doc_key, &settings, &self.refusal_context());
        Ok(match hint {
            Some(hint) => ProjectSelection {
                unregistered_project_hint: Some(hint),
                ..selection
            },
            None => selection,
        })
    }

    /// Record a choice made in a window's AI panel (see `recordSelection`); returns the selection now
    pub fn set_selection(
        &self,
        target: &SelectionTarget,
        project_id: Option<&str>,
    ) -> Result<ProjectSelection, GuideError> {
        if let Some(project_id) = project_id
            && self.entry(project_id).is_none()
        {
            return Err(unknown_project(project_id));
        }
        let resolved = self.resolve_target(target)?;
        self.update(|settings| record_selection(settings, &resolved, project_id, &self.platform))?;
        if let Some(project_id) = project_id {
            self.touch(project_id)?;
        }
        let selection = self.get_selection(target)?;
        Ok(if selection.project_id.as_deref() == project_id {
            selection
        } else {
            ProjectSelection {
                project_id: project_id.map(str::to_owned),
                initial_chat_id: None,
                ..selection
            }
        })
    }

    /// A document outside every project used `chatId` of `projectId` last (spec 3, 5.3.1)
    pub fn record_outside_chat(
        &self,
        doc_path: &str,
        project_id: &str,
        chat_id: &str,
    ) -> Result<(), GuideError> {
        if !is_valid_project_id(chat_id) {
            return Err(GuideError::plain("invalid chat id"));
        }
        if !is_absolute(doc_path) {
            return Err(GuideError::plain("expected an absolute document path"));
        }
        let doc_key = canonical_path(doc_path);
        self.update(|settings| {
            record_outside_chat(settings, &doc_key, project_id, chat_id, &self.platform);
        })?;
        Ok(())
    }

    /// "[use]" on the hint: the add-folder path for the hinted folder, then the document
    /// uses it. The add-folder path can ask: resume with
    /// [`ProjectGuide::resume_adopt_folder_hint`].
    pub fn adopt_folder_hint(
        &self,
        doc_path: &str,
    ) -> Result<GuideStep<AddFolderResult, PendingAdoptFolderHint>, GuideError> {
        let target = SelectionTarget::Document {
            path: doc_path.to_owned(),
        };
        let selection = self.get_selection(&target)?;
        let Some(hint) = selection.unregistered_project_hint else {
            return Ok(GuideStep::Done(AddFolderResult::Refused {
                reason: FolderRefusalReason::NotAFolder,
            }));
        };
        Ok(match self.adopt(&hint.folder_path, None)? {
            GuideStep::Done(result) => GuideStep::Done(self.use_hinted_folder(doc_path, result)?),
            GuideStep::AskTrust { prompt, pending } => GuideStep::AskTrust {
                prompt,
                pending: PendingAdoptFolderHint {
                    doc_path: doc_path.to_owned(),
                    adopt: pending,
                },
            },
        })
    }

    /// The answer of the trust prompt `adopt_folder_hint` asked
    pub fn resume_adopt_folder_hint(
        &self,
        pending: PendingAdoptFolderHint,
        answer: ProjectTrustAnswer,
    ) -> Result<AddFolderResult, GuideError> {
        let PendingAdoptFolderHint { doc_path, adopt } = pending;
        let result = self.resume_add_folder(adopt, answer)?;
        self.use_hinted_folder(&doc_path, result)
    }

    /// What `adoptFolderHint` does with the result of the add-folder path: the
    /// document uses the folder that was added
    fn use_hinted_folder(
        &self,
        doc_path: &str,
        result: AddFolderResult,
    ) -> Result<AddFolderResult, GuideError> {
        let target = SelectionTarget::Document {
            path: doc_path.to_owned(),
        };
        if let AddFolderResult::Added { project, .. } = &result {
            self.set_selection(&target, Some(&project.id))?;
        }
        Ok(result)
    }
}

// ────────────────────────── the traits other modules take ──────────────────────────

/// The guide an owner of it hands out: the guide itself, or a shared one
trait AsGuide {
    fn guide(&self) -> &ProjectGuide;
}

impl AsGuide for ProjectGuide {
    fn guide(&self) -> &ProjectGuide {
        self
    }
}

impl AsGuide for Rc<ProjectGuide> {
    fn guide(&self) -> &ProjectGuide {
        self
    }
}

/// The calls of `ProjectToolsGuide`, `ProjectIndexGuide`, `NewDocumentsGuide`
/// and `ChatStoreGuide` over a guide
macro_rules! guide_traits {
    ($owner:ty) => {
        impl ProjectToolsGuide for $owner {
            fn ai_visibility(&mut self, id: &str) -> Result<Option<ProjectAiVisibility>, Thrown> {
                ProjectGuide::ai_visibility(self.guide(), id)
                    .map_err(|error| Thrown(error.message()))
            }
        }

        impl ProjectIndexGuide for $owner {
            fn list_projects(&mut self) -> Result<Vec<ProjectListItem>, Thrown> {
                Ok(ProjectGuide::list_projects(self.guide()))
            }

            fn ai_visibility(&mut self, id: &str) -> Result<Option<ProjectAiVisibility>, Thrown> {
                ProjectGuide::ai_visibility(self.guide(), id)
                    .map_err(|error| Thrown(error.message()))
            }
        }

        impl NewDocumentsGuide for $owner {
            fn project_root(&mut self, id: &str) -> Option<String> {
                ProjectGuide::project_root(self.guide(), id)
            }

            fn write_new_document(
                &mut self,
                id: &str,
                target: &str,
                data: &[u8],
            ) -> Result<ProjectWriteResult, WriteGuardError> {
                ProjectGuide::write_new_document(self.guide(), id, target, data)
            }
        }

        /// A call the TypeScript's guide would reject (an unlisted project,
        /// `project.json`) is `unwritable` here: the trait has no error to give.
        impl ChatStoreGuide for $owner {
            fn append_data(
                &mut self,
                id: &str,
                rel_path: &str,
                text: &str,
                data_dir: Option<&str>,
            ) -> ProjectWriteResult {
                ProjectGuide::append_data(self.guide(), id, rel_path, text, data_dir)
                    .unwrap_or(ProjectWriteResult::Unwritable)
            }

            fn update_data(
                &mut self,
                id: &str,
                rel_path: &str,
                change: ChatDataChange<'_>,
                data_dir: Option<&str>,
            ) -> DataUpdateOutcome {
                let guide = self.guide();
                // an install id the guide could not store fails the change, as the
                // TypeScript's thrown error would
                let mut failed: Option<GuideError> = None;
                ProjectGuide::update_data(
                    guide,
                    id,
                    rel_path,
                    &mut |current: Option<&str>| -> Result<Option<String>, GuideError> {
                        let next = change(current, &mut || match guide.install_id() {
                            Ok(install_id) => install_id,
                            Err(error) => {
                                failed.get_or_insert(error);
                                String::new()
                            }
                        });
                        match failed.take() {
                            Some(error) => Err(error),
                            None => Ok(next),
                        }
                    },
                    data_dir,
                )
                .unwrap_or(DataUpdateOutcome::Unwritable)
            }

            fn data_path(
                &mut self,
                id: &str,
                rel_path: &str,
                data_dir: Option<&str>,
            ) -> Option<String> {
                ProjectGuide::data_path(self.guide(), id, rel_path, data_dir)
                    .ok()
                    .flatten()
            }

            fn install_id(&mut self) -> String {
                let guide = self.guide();
                // the id is made even when the settings file refuses it
                // (the TypeScript throws): a message still has an author
                ProjectGuide::install_id(guide).unwrap_or_else(|_| guide.new_id())
            }

            fn trust_state(&mut self, id: &str) -> ProjectTrustState {
                ProjectGuide::trust_state(self.guide(), id)
            }

            fn is_unwritable(&mut self, id: &str) -> bool {
                ProjectGuide::is_unwritable(self.guide(), id)
            }

            fn mark_unwritable(&mut self, id: &str) {
                ProjectGuide::mark_unwritable(self.guide(), id);
            }

            fn project_root(&mut self, id: &str) -> Option<String> {
                ProjectGuide::project_root(self.guide(), id)
            }

            fn record_outside_chat(
                &mut self,
                doc_path: &str,
                project_id: &str,
                chat_id: &str,
            ) -> Result<(), String> {
                ProjectGuide::record_outside_chat(self.guide(), doc_path, project_id, chat_id)
                    .map_err(|error| error.message())
            }

            fn document_relative_path(&mut self, id: &str, doc_path: &str) -> Option<String> {
                ProjectGuide::document_relative_path(self.guide(), id, doc_path)
            }

            fn get_selection(&mut self, target: &SelectionTarget) -> ProjectSelection {
                ProjectGuide::get_selection(self.guide(), target).unwrap_or(ProjectSelection {
                    project_id: None,
                    initial_chat_id: None,
                    unregistered_project_hint: None,
                })
            }
        }
    };
}

guide_traits!(ProjectGuide);
guide_traits!(Rc<ProjectGuide>);
