//! `packages/project-store/src/folder-api.ts`: what the main process calls.

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
fn real_path_native(path: &str) -> Option<String> {
    let real = std::fs::canonicalize(path).ok()?;
    let real = real.to_string_lossy().into_owned();
    // std adds the verbatim prefix on Windows; realpath does not
    Some(match real.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with(r"UNC\") => rest.to_owned(),
        _ => real,
    })
}

/// `text.normalize('NFC')`
fn nfc(text: &str) -> String {
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
