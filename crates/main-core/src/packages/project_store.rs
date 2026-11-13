//! `packages/project-store/src/folder-api.ts`: what the main process calls.

use jscompat::{JsNum, JsObject, JsRegex, js_regex};
use serde::{Deserialize, Serialize};

/// `isValidProjectId(value)` of a string: non-empty, `/^[A-Za-z0-9_-]+$/`.
/// (`$` of a pattern without the `m` flag does not match before a final line
/// feed, so "ab\n" is not valid.)
pub fn is_valid_project_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `PROJECT_FOLDER_NAMES`, as (key, name) in the order the object has them.
pub const PROJECT_FOLDER_NAMES: [(&str, &str); 10] = [
    ("dataDir", ".seuoffice"),
    ("projectFile", "project.json"),
    ("instructionsFile", "instructions.md"),
    ("memoryFile", "memory.md"),
    ("ignoreFile", "ignore"),
    ("chatsDir", "chats"),
    ("chatInfoExt", ".json"),
    ("chatMessagesExt", ".jsonl"),
    ("rootAgentsFile", "AGENTS.md"),
    ("rootClaudeFile", "CLAUDE.md"),
];

/// `PROJECT_FOLDER_NAMES[key]`
pub fn project_folder_name(key: &str) -> &'static str {
    PROJECT_FOLDER_NAMES
        .iter()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| *value)
        .expect("a key of PROJECT_FOLDER_NAMES")
}

/// `MEMORY_BACKUP_PATTERN`: `memory.<YYYYMMDD-HHmmss>.bak.md`
pub fn memory_backup_pattern() -> &'static JsRegex {
    js_regex!(r"^memory\.\d{8}-\d{6}\.bak\.md$")
}

/// `PROJECT_NAME_MAX_CHARS`: longest project name kept in `project.json`
pub const PROJECT_NAME_MAX_CHARS: usize = 128;

/// `PROJECT_FORMAT_VERSION`: written in `project.json` and in chat info files
pub const PROJECT_FORMAT_VERSION: u32 = 1;

/// `PROJECT_EDITORS`
pub const PROJECT_EDITORS: [&str; 10] = [
    "docs", "sheets", "slides", "pdf", "markdown", "html", "mindmap", "hwp", "epub", "home",
];

/// `ProjectFolderEventMethod`: the subscribe methods of the renderer's bridge.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum ProjectFolderEventMethod {
    #[serde(rename = "onChatMessageAppended")]
    OnChatMessageAppended,
    #[serde(rename = "onOpenChat")]
    OnOpenChat,
    #[serde(rename = "onOpenProjectScreen")]
    OnOpenProjectScreen,
    #[serde(rename = "onProjectChanged")]
    OnProjectChanged,
}

impl ProjectFolderEventMethod {
    /// the name as the bridge spells it
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OnChatMessageAppended => "onChatMessageAppended",
            Self::OnOpenChat => "onOpenChat",
            Self::OnOpenProjectScreen => "onOpenProjectScreen",
            Self::OnProjectChanged => "onProjectChanged",
        }
    }
}

/// `PROJECT_FOLDER_EVENTS`: event channels keyed by subscribe method.
pub const PROJECT_FOLDER_EVENTS: [(ProjectFolderEventMethod, &str); 4] = [
    (
        ProjectFolderEventMethod::OnChatMessageAppended,
        "projectFolder:event:chatMessageAppended",
    ),
    (
        ProjectFolderEventMethod::OnOpenChat,
        "projectFolder:event:openChat",
    ),
    (
        ProjectFolderEventMethod::OnOpenProjectScreen,
        "projectFolder:event:openProjectScreen",
    ),
    (
        ProjectFolderEventMethod::OnProjectChanged,
        "projectFolder:event:projectChanged",
    ),
];

/// `PROJECT_FOLDER_CHANNELS`: request channels, one per bridge method, as
/// (method, channel) in the order the object has them.
pub const PROJECT_FOLDER_CHANNELS: [(&str, &str); 41] = [
    ("listProjects", "projectFolder:listProjects"),
    ("addFolder", "projectFolder:addFolder"),
    (
        "getDefaultParentFolder",
        "projectFolder:getDefaultParentFolder",
    ),
    ("createProject", "projectFolder:createProject"),
    ("removeFromList", "projectFolder:removeFromList"),
    ("setPinned", "projectFolder:setPinned"),
    ("renameProject", "projectFolder:renameProject"),
    ("relocateProject", "projectFolder:relocateProject"),
    ("openInFileManager", "projectFolder:openInFileManager"),
    ("retryUnwritable", "projectFolder:retryUnwritable"),
    ("getSelection", "projectFolder:getSelection"),
    ("setSelection", "projectFolder:setSelection"),
    ("adoptFolderHint", "projectFolder:adoptFolderHint"),
    ("readContext", "projectFolder:readContext"),
    ("openScope", "projectFolder:openScope"),
    ("closeScope", "projectFolder:closeScope"),
    ("listFiles", "projectFolder:listFiles"),
    ("search", "projectFolder:search"),
    ("read", "projectFolder:read"),
    ("remember", "projectFolder:remember"),
    ("editMemory", "projectFolder:editMemory"),
    ("saveMemory", "projectFolder:saveMemory"),
    (
        "applyMemoryConsolidation",
        "projectFolder:applyMemoryConsolidation",
    ),
    (
        "undoMemoryConsolidation",
        "projectFolder:undoMemoryConsolidation",
    ),
    ("listChats", "projectFolder:listChats"),
    ("newChat", "projectFolder:newChat"),
    ("openChat", "projectFolder:openChat"),
    ("appendChat", "projectFolder:appendChat"),
    ("renameChat", "projectFolder:renameChat"),
    ("deleteChat", "projectFolder:deleteChat"),
    ("attachDocument", "projectFolder:attachDocument"),
    ("openDocumentChat", "projectFolder:openDocumentChat"),
    ("getProjectDetail", "projectFolder:getProjectDetail"),
    ("getSettings", "projectFolder:getSettings"),
    ("setSettings", "projectFolder:setSettings"),
    ("decideTrust", "projectFolder:decideTrust"),
    ("saveInstructions", "projectFolder:saveInstructions"),
    ("addIgnore", "projectFolder:addIgnore"),
    ("removeIgnore", "projectFolder:removeIgnore"),
    ("listIgnoredFiles", "projectFolder:listIgnoredFiles"),
    ("openProjectScreen", "projectFolder:openProjectScreen"),
];

/// `PROJECT_FOLDER_LISTEN_CHANNEL`
pub const PROJECT_FOLDER_LISTEN_CHANNEL: &str = "projectFolder:listen";

/// `PROJECT_FOLDER_BRIDGE_KEY`
pub const PROJECT_FOLDER_BRIDGE_KEY: &str = "projectFolderApi";

/// `realpathSync.native(path)`, `None` where it throws
pub fn real_path_native(path: &str) -> Option<String> {
    let real = std::fs::canonicalize(path).ok()?;
    let real = real.to_string_lossy().into_owned();
    // std adds the verbatim prefix on Windows; realpath does not
    Some(match real.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with(r"UNC\") => rest.to_owned(),
        _ => real,
    })
}

/// `text.normalize('NFC')`
pub fn nfc(text: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfc()
        .normalize(text)
        .into_owned()
}

/// `canonicalPathKey(filePath)` of `packages/project-store/src/store.ts`: the
/// one key a file path is stored and hashed under. The path with its links
/// resolved (a leaf that is not there is keyed under its resolved folder; a
/// path whose folder does not resolve either is used as given), in Unicode
/// normalization form C.
pub fn canonical_path_key(file_path: &str) -> String {
    use jscompat::node_path::host::{basename, dirname, join};
    if let Some(real) = real_path_native(file_path) {
        return nfc(&real);
    }
    // The leaf may be gone (renamed or deleted) while its directory still resolves
    if let Some(real) = real_path_native(&dirname(file_path)) {
        return nfc(&join(&[&real, &basename(file_path, None)]));
    }
    nfc(file_path)
}

// ---- `packages/project-store/src/types.ts` ----

/// `ToolActivity`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolActivity {
    pub name: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
}

/// `ChatAttachment`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAttachment {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<JsNum>,
}

/// The `'user' | 'assistant'` of a chat message's `role`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

/// `ChatSkillChip`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatSkillChip {
    pub id: String,
    pub source: String,
    pub title: String,
}

/// `ChatScope`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatScope {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// `ChatMessage`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub seq: JsNum,
    pub ts: String,
    pub role: ChatRole,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolActivity>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<ChatAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<ChatScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<ChatSkillChip>>,
}

/// `ChatMeta`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub chat_id: String,
    pub updated_at: String,
    pub approx_count: JsNum,
}

// ---- `packages/project-store/src/folder-api.ts`: ids, names, editors ----

/// `ProjectId`: a project id or a chat id; always matches `PROJECT_ID_PATTERN`.
pub type ProjectId = String;

/// `ProjectEditor`: one of `PROJECT_EDITORS`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectEditor {
    Docs,
    Sheets,
    Slides,
    Pdf,
    Markdown,
    Html,
    Mindmap,
    Hwp,
    Epub,
    Home,
}

impl ProjectEditor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Docs => "docs",
            Self::Sheets => "sheets",
            Self::Slides => "slides",
            Self::Pdf => "pdf",
            Self::Markdown => "markdown",
            Self::Html => "html",
            Self::Mindmap => "mindmap",
            Self::Hwp => "hwp",
            Self::Epub => "epub",
            Self::Home => "home",
        }
    }
}

// ---- on-disk formats inside the folder ----

/// `ProjectFolderFile`: `.seuoffice/project.json`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolderFile {
    /// `PROJECT_FORMAT_VERSION`
    pub version: u32,
    pub id: ProjectId,
    pub name: String,
    pub created_at: String,
}

/// `ProjectChatInfo`: `.seuoffice/chats/<chatId>.json`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChatInfo {
    /// `PROJECT_FORMAT_VERSION`
    pub version: u32,
    pub id: ProjectId,
    pub project_id: ProjectId,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub origin: String,
    pub last_editor: ProjectEditor,
    pub documents: Vec<String>,
}

/// `ProjectChatMessage`: one line of `.seuoffice/chats/<chatId>.jsonl`, the
/// fields of `ChatMessage` and then `editor` and `origin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectChatMessage {
    #[serde(flatten)]
    pub message: ChatMessage,
    pub editor: ProjectEditor,
    pub origin: String,
}

// ---- this PC's records ----

/// `ProjectTrustDecision`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectTrustDecision {
    Use,
    Without,
}

impl ProjectTrustDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Use => "use",
            Self::Without => "without",
        }
    }
}

/// `ProjectTrustState`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectTrustState {
    Use,
    Without,
    Unconfirmed,
}

/// `ProjectHashedFile`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectHashedFile {
    Instructions,
    Memory,
    Agents,
    Claude,
}

impl ProjectHashedFile {
    /// the four files in the order `hashesOf` walks them
    pub const ALL: [ProjectHashedFile; 4] =
        [Self::Instructions, Self::Memory, Self::Agents, Self::Claude];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Instructions => "instructions",
            Self::Memory => "memory",
            Self::Agents => "agents",
            Self::Claude => "claude",
        }
    }
}

/// `Partial<Record<ProjectHashedFile, string>>`: an object holding the keys
/// that have a hash, in the order they were set.
pub type ProjectHashes = JsObject<String>;

/// `ProjectListEntry`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListEntry {
    pub id: ProjectId,
    pub path: String,
    pub pinned: bool,
    pub last_used_at: String,
}

/// `ProjectTrustRecord`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectTrustRecord {
    pub decision: ProjectTrustDecision,
    pub hashes: ProjectHashes,
}

/// `ProjectSettings`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettings {
    pub memory_enabled: bool,
    pub read_agents_files: bool,
}

// ---- project list and selection ----

/// `ProjectListItem`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListItem {
    pub id: ProjectId,
    pub name: String,
    pub path: String,
    pub pinned: bool,
    pub last_used_at: String,
    pub missing: bool,
    pub unwritable: bool,
    pub sync_folder: bool,
}

/// `UnregisteredProjectHint`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnregisteredProjectHint {
    pub name: String,
    pub folder_path: String,
}

/// `ProjectSelection`; `project_id` and `initial_chat_id` are `null` for
/// "no project" and for a new chat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSelection {
    pub project_id: Option<ProjectId>,
    pub initial_chat_id: Option<ProjectId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unregistered_project_hint: Option<UnregisteredProjectHint>,
}

/// `FolderRefusalReason`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FolderRefusalReason {
    DriveRoot,
    UserHome,
    Protected,
    ContainsProtected,
    NotAFolder,
    DifferentProject,
}

impl FolderRefusalReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DriveRoot => "drive-root",
            Self::UserHome => "user-home",
            Self::Protected => "protected",
            Self::ContainsProtected => "contains-protected",
            Self::NotAFolder => "not-a-folder",
            Self::DifferentProject => "different-project",
        }
    }
}

/// `FolderIdentity`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderIdentity {
    New,
    Existing,
    Moved,
    Copied,
}

/// The `'dialog' | 'trust'` of a cancelled `AddFolderResult`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AddFolderStage {
    Dialog,
    Trust,
}

/// `AddFolderResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum AddFolderResult {
    Added {
        project: ProjectListItem,
        identity: FolderIdentity,
        notices: Vec<ProjectNotice>,
    },
    Cancelled {
        stage: AddFolderStage,
    },
    Refused {
        reason: FolderRefusalReason,
    },
}

/// `CreateProjectResult`: its own four statuses and the three of
/// `AddFolderResult`, in one tagged union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum CreateProjectResult {
    Created {
        project: ProjectListItem,
    },
    #[serde(rename_all = "camelCase")]
    Exists {
        folder_path: String,
    },
    InvalidName,
    Unwritable,
    Added {
        project: ProjectListItem,
        identity: FolderIdentity,
        notices: Vec<ProjectNotice>,
    },
    Cancelled {
        stage: AddFolderStage,
    },
    Refused {
        reason: FolderRefusalReason,
    },
}

impl From<AddFolderResult> for CreateProjectResult {
    fn from(result: AddFolderResult) -> Self {
        match result {
            AddFolderResult::Added {
                project,
                identity,
                notices,
            } => Self::Added {
                project,
                identity,
                notices,
            },
            AddFolderResult::Cancelled { stage } => Self::Cancelled { stage },
            AddFolderResult::Refused { reason } => Self::Refused { reason },
        }
    }
}

// ---- context for one send ----

/// `ProjectFileEntry`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFileEntry {
    pub rel_path: String,
    pub ext: String,
    pub size_bytes: u64,
    pub mtime_ms: JsNum,
    pub cloud_only: bool,
}

/// `ProjectInstructionsSource`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectInstructionsSource {
    Instructions,
    Agents,
    Claude,
}

/// The `'onedrive' | 'google-drive'` of a `sync-folder` notice
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyncFolderService {
    Onedrive,
    GoogleDrive,
}

/// `ProjectNotice`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ProjectNotice {
    InstructionsChanged {
        files: Vec<ProjectInstructionsSource>,
    },
    MemoryChanged,
    MemoryLong {
        chars: u64,
        limit: u64,
    },
    InstructionsTruncated {
        chars: u64,
        limit: u64,
    },
    Unwritable,
    SyncFolder {
        #[serde(skip_serializing_if = "Option::is_none")]
        service: Option<SyncFolderService>,
    },
}

/// The `instructions` object of `ProjectContextBundle`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContextInstructions {
    pub text: String,
    pub sources: Vec<ProjectInstructionsSource>,
    /// absent means the current data folder name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<String>,
}

/// The `memory` object of `ProjectContextBundle`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectContextMemory {
    pub text: String,
    pub chars: u64,
}

/// `ProjectContextBundle`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectContextBundle {
    pub project_id: ProjectId,
    pub name: String,
    pub trust: ProjectTrustDecision,
    pub instructions: Option<ProjectContextInstructions>,
    pub memory: Option<ProjectContextMemory>,
    pub files: Vec<ProjectFileEntry>,
    pub files_omitted: u64,
    pub can_remember: bool,
    pub notices: Vec<ProjectNotice>,
}

/// `ProjectContextResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ProjectContextResult {
    Ok { context: Box<ProjectContextBundle> },
    Missing,
    Unknown,
}

// ---- tools ----

/// `ProjectListFilesResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectListFilesResult {
    pub files: Vec<ProjectFileEntry>,
    pub total: u64,
}

/// `ProjectSearchHit`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSearchHit {
    pub rel_path: String,
    pub name: String,
    pub ext: String,
    pub mtime_ms: JsNum,
    pub cloud_only: bool,
    pub snippet: String,
}

/// `ProjectSearchResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectSearchResult {
    pub hits: Vec<ProjectSearchHit>,
    pub total: u64,
}

/// `ProjectReadRefusal`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectReadRefusal {
    Outside,
    Hidden,
    Ignored,
    NotFound,
    Unsaved,
    TooLarge,
    Unreadable,
}

/// `ProjectReadResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ProjectReadResult {
    #[serde(rename_all = "camelCase")]
    Ok {
        text: String,
        total_chars: u64,
        offset: JsNum,
    },
    Declined,
    Refused {
        reason: ProjectReadRefusal,
    },
}

/// `ProjectMemoryOp`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum ProjectMemoryOp {
    Add { text: String },
    Replace { old: String, new: String },
    Remove { text: String },
}

/// `ProjectMemoryRefusal`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectMemoryRefusal {
    Disabled,
    Without,
    Unwritable,
    NotFound,
    Invalid,
}

/// `ProjectMemoryEditResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ProjectMemoryEditResult {
    Ok { change: ProjectMemoryOp },
    Refused { reason: ProjectMemoryRefusal },
}

// ---- memory consolidation ----

/// `ApplyMemoryConsolidationArgs`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyMemoryConsolidationArgs {
    pub project_id: ProjectId,
    pub entries: Vec<String>,
}

/// `ApplyMemoryConsolidationResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ApplyMemoryConsolidationResult {
    #[serde(rename_all = "camelCase")]
    Ok {
        before: u64,
        after: u64,
        backup_name: String,
    },
    Unwritable,
}

/// `UndoMemoryConsolidationArgs`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoMemoryConsolidationArgs {
    pub project_id: ProjectId,
    pub backup_name: String,
}

/// `UndoMemoryConsolidationResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum UndoMemoryConsolidationResult {
    Ok { entries: u64 },
    NoBackup,
    Unwritable,
}

// ---- trust prompt ----

/// `ProjectForeignChat`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectForeignChat {
    pub id: ProjectId,
    pub title: String,
    pub updated_at: String,
}

/// `ProjectTrustPrompt`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectTrustPrompt {
    pub project_id: ProjectId,
    pub name: String,
    pub folder_path: String,
    pub instructions: Option<String>,
    pub memory: Option<String>,
    pub agents: Option<String>,
    pub claude: Option<String>,
    pub foreign_chats: Vec<ProjectForeignChat>,
}

/// `ProjectTrustAnswer`: `None` when the prompt was closed.
pub type ProjectTrustAnswer = Option<ProjectTrustDecision>;

/// `DecideTrustResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum DecideTrustResult {
    Ok { trust: ProjectTrustDecision },
    Cancelled,
}

// ---- project screen ----

/// `ProjectScreenSection`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectScreenSection {
    Instructions,
    Memory,
}

/// `ProjectDetail`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    pub project: ProjectListItem,
    pub trust: ProjectTrustState,
    pub settings: ProjectSettings,
    pub instructions: String,
    pub agents: Option<String>,
    pub claude: Option<String>,
    pub memory: String,
    pub memory_entries: Vec<String>,
    pub memory_chars: u64,
    pub memory_conflict_copies: Vec<String>,
}

/// `ProjectWriteResult`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ProjectWriteResult {
    Ok,
    Unwritable,
}

// ---- chats ----

/// `ProjectChatListItem`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChatListItem {
    pub id: ProjectId,
    pub title: String,
    pub updated_at: String,
    pub last_editor: ProjectEditor,
    pub foreign: bool,
}

/// `LegacyDocumentChat`: the fields of `ChatMeta`, then `projectId`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyDocumentChat {
    #[serde(flatten)]
    pub meta: ChatMeta,
    pub project_id: String,
}

/// `ProjectChatListResult`; `legacy` is `null` when the window's document has
/// no earlier chat.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectChatListResult {
    pub chats: Vec<ProjectChatListItem>,
    pub legacy: Option<LegacyDocumentChat>,
}

/// `ProjectChatRef`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChatRef {
    pub project_id: ProjectId,
    pub chat_id: ProjectId,
}

/// `OpenProjectChatArgs`: a `ProjectChatRef` and `limit`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OpenProjectChatArgs {
    #[serde(flatten)]
    pub chat_ref: ProjectChatRef,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<JsNum>,
}

/// `OpenProjectChatResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum OpenProjectChatResult {
    Ok {
        info: ProjectChatInfo,
        messages: Vec<ProjectChatMessage>,
        foreign: bool,
    },
    NotFound,
}

/// `AppendProjectChatArgs`: a `ProjectChatRef` and the message to record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppendProjectChatArgs {
    #[serde(flatten)]
    pub chat_ref: ProjectChatRef,
    pub role: ChatRole,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolActivity>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<ChatAttachment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<ChatScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<ChatSkillChip>>,
}

/// `AppendProjectChatResult`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum AppendProjectChatResult {
    Saved { message: ProjectChatMessage },
    Pending { message: ProjectChatMessage },
    Unwritable,
}

/// `RenameProjectChatArgs`: a `ProjectChatRef` and `title`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenameProjectChatArgs {
    #[serde(flatten)]
    pub chat_ref: ProjectChatRef,
    pub title: String,
}

/// `ProjectChatAppendedEvent`: a `ProjectChatRef` and `message`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectChatAppendedEvent {
    #[serde(flatten)]
    pub chat_ref: ProjectChatRef,
    pub message: ProjectChatMessage,
}

/// `OpenProjectChatEvent`
pub type OpenProjectChatEvent = ProjectChatRef;

/// `OpenProjectScreenEvent`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenProjectScreenEvent {
    pub project_id: ProjectId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section: Option<ProjectScreenSection>,
}

/// `ProjectChangedPart`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectChangedPart {
    Memory,
    Instructions,
    Settings,
    Chats,
}

/// `ProjectChangedEvent`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectChangedEvent {
    pub project_id: ProjectId,
    pub part: ProjectChangedPart,
}
