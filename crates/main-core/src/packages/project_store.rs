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

/// `ProjectFolderEventMethod`: the bridge's subscribe methods.
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

    /// `ProjectFolderEventMethod` of a name
    pub fn from_name(name: &str) -> Option<Self> {
        PROJECT_FOLDER_EVENTS
            .iter()
            .find(|(method, _)| method.as_str() == name)
            .map(|(method, _)| *method)
    }

    /// `PROJECT_FOLDER_EVENTS[method]`
    pub fn channel(self) -> &'static str {
        PROJECT_FOLDER_EVENTS
            .iter()
            .find(|(method, _)| *method == self)
            .map_or("", |(_, channel)| channel)
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

/// `ProjectFolderListenMessage`: `{ method, listening }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub struct ProjectFolderListenMessage {
    pub method: ProjectFolderEventMethod,
    pub listening: bool,
}
