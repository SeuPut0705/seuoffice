//! `apps/shell/src/main/projects/project-guide.ts`: the project guide
//! (decision 0088): the one place in the shell main process that knows the
//! project list, reads a project folder's instructions and memory, decides
//! identity and trust, and writes into the folder (through the write guard).
//! It holds no Electron objects: dialogs arrive as callbacks (`TrustAsk`) and
//! the IPC layer passes the calling window's document path.
//!
//! This section holds the exported types and constants of the file; the
//! `ProjectGuide` class follows it.
//!
//! What the TypeScript awaits is a plain synchronous call here, and the
//! optional callbacks of `ProjectGuideDeps` are optional boxed closures.

use jscompat::RegexLimit;
use serde::{Deserialize, Serialize};

use super::ignore::IgnoreMatcher;
use super::visibility::is_ai_visible_path;
use crate::packages::project_store::{
    ProjectFileEntry, ProjectId, ProjectTrustAnswer, ProjectTrustPrompt,
};

pub use super::context::INSTRUCTIONS_LIMIT_CHARS;
pub use super::memory::MEMORY_SOFT_LIMIT_CHARS;

/// `TrustAsk`: shows the first-time trust prompt; answers the person's
/// choice, or `None` (`null`) when it was closed
pub trait TrustAsk {
    fn ask(&mut self, prompt: &ProjectTrustPrompt) -> ProjectTrustAnswer;
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
    /// A new project id; must match `PROJECT_ID_PATTERN`
    pub new_id: Option<Box<dyn FnMut() -> String>>,
    /// The screen language, for the header of a new `memory.md`
    pub language: Option<Box<dyn FnMut() -> String>>,
    /// The file names of a project for the context (spec 5.4 item 4); absent
    /// sends none
    pub context_files: Option<ContextFilesProvider>,
    /// At most one write of a project's use time per this long; default
    /// `PROJECT_TOUCH_WRITE_MS`
    pub touch_write_ms: Option<f64>,
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
