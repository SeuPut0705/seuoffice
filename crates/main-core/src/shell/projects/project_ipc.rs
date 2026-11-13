//! `apps/shell/src/main/projects/project-ipc.ts`: the shell main process's
//! side of the project folder bridge (decision 0088,
//! `PROJECT_FOLDER_CHANNELS`). Every request is judged by the window that
//! sent it: main finds that window's editor and saved document itself, so a
//! renderer names project and chat ids only, never a path or a list a scope
//! depends on.
//!
//! The layer also keeps which window shows which chat (a message one window
//! records reaches the other windows with the same chat open), tells every
//! listening window when a request wrote a project's memory, instructions,
//! switches or chats, and holds an "open this chat" or "show the project
//! screen" request for a window that is not listening yet.
//!
//! What stays in TypeScript (plumbing, not judgment): `ipcMain.handle` of each
//! channel of `PROJECT_FOLDER_CHANNELS` (and `trackProjectContents` of the
//! sender), which hands `event.sender.id` and the raw argument to
//! [`ProjectIpc::handle`]; `ipcMain.on` of the listen channel, which hands
//! its message to [`ProjectIpc::listen`]; `services()`, the first-use
//! creation of the guide, the chat store and the tools, with the one
//! registration of the chat store's `onAppended` listener (the events it
//! sees are what [`ProjectIpcChats::take_appended`] gives back); the window
//! behind a webContents id (`windowOf`), `webContents.send`, the folder picker
//! and message boxes of `dialogs` (built from `project_dialog_text`, which
//! is ported), `shell.openPath`, the shell's file-open path, the home tab,
//! and the `webContents` events that call [`ProjectIpc::forget`] and
//! [`ProjectIpc::reset`]. All of them reach this file as the traits below.
//!
//! Every handler body is a plain synchronous call here. The one thing an
//! interleaving of two requests could change (the TypeScript awaits between
//! its steps) is not modelled: a request runs to its answer.
//!
//! The renderer's argument is a [`JsonValue`] (`unknown`); `record(raw)` of
//! it is [`field`]. A handler answers `Ok(None)` where the TypeScript
//! answers `undefined`.

use jscompat::node_path::host::{is_absolute, join};
use jscompat::{JsObject, JsonValue, trim, truthy};
use serde::Serialize;
use serde_json::Value;

use super::chat_store::{ChatAppendedEvent, ChatSender};
use super::folder_files::data_dir_name;
use super::paths::relative_inside;
use super::project_dialog_text::{ProjectFolderPickPurpose, ProjectTrustChoice};
use super::project_files::{
    CloudOnlyResolver, list_ignored_files, thrown_limit, to_entry, with_cloud_flags,
};
use super::project_guide::{NewProjectRequest, ProjectAiVisibility, SelectionTarget, TrustAsk};
use super::project_tools::PROJECT_SCOPE_UNKNOWN;
use super::stand_ins::process_platform;
use crate::packages::electron_utils::default_save_dir::Thrown;
use crate::packages::project_store::{
    AddFolderResult, AddFolderStage, ApplyMemoryConsolidationResult, CreateProjectResult,
    DecideTrustResult, FolderRefusalReason, LegacyDocumentChat, OpenProjectScreenEvent,
    PROJECT_FOLDER_EVENTS, ProjectChangedEvent, ProjectChangedPart, ProjectChatListItem,
    ProjectChatListResult, ProjectChatRef, ProjectContextResult, ProjectDetail, ProjectEditor,
    ProjectFileEntry, ProjectFolderEventMethod, ProjectId, ProjectListFilesResult, ProjectListItem,
    ProjectMemoryEditResult, ProjectMemoryOp, ProjectReadResult, ProjectScreenSection,
    ProjectSearchResult, ProjectSelection, ProjectSettings, ProjectTrustDecision,
    ProjectTrustPrompt, ProjectWriteResult, UndoMemoryConsolidationResult, is_valid_project_id,
    project_folder_name,
};

/// a request that names no usable project or chat id
pub const PROJECT_IPC_BAD_REQUEST: &str = "invalid project folder request";

/// the request came from a window that has no AI panel the shell knows
pub const PROJECT_IPC_UNKNOWN_WINDOW: &str = "not an AI window";

/// `TRUST_RETURN_ARM_MS`: how long after [view all] a focus on the asking
/// page still counts as the dialog handing it back
pub const TRUST_RETURN_ARM_MS: f64 = 1_000.0;

/// What a handler answers: the JSON the renderer gets, `None` for
/// `undefined`
pub type Reply = Option<Value>;

/// `ProjectWindow`: the calling window as main identified it
#[derive(Debug, Clone, PartialEq)]
pub enum ProjectWindow {
    Home,
    /// `editor` is never `home` (the plumbing keeps those out)
    Editor {
        editor: ProjectEditor,
        doc_path: Option<String>,
    },
}

/// `MemoryOp` author of `editMemory(id, change, by)`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemoryAuthor {
    /// `'ai'`: the `project_remember` tool
    Ai,
    /// `'person'`
    Person,
}

impl MemoryAuthor {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ai => "ai",
            Self::Person => "person",
        }
    }
}

/// `Partial<ProjectSettings>` of `setSettings`: a key the request did not
/// carry as a boolean is left out
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSettingsPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_agents_files: Option<bool>,
}

/// What `openDocumentChat` reads of a chat's info (`chats.chatInfo(ref)`)
#[derive(Debug, Clone, PartialEq)]
pub struct ChatDocuments {
    /// folder-relative paths, oldest first
    pub documents: Vec<String>,
    pub last_editor: ProjectEditor,
}

/// A message the chat store's `onAppended` listeners saw: the event and the
/// `key` of the sender that recorded it (`None`: the sender carried none)
#[derive(Debug, Clone, PartialEq)]
pub struct AppendedNotice {
    pub event: ChatAppendedEvent,
    pub from: Option<JsonValue>,
}

/// `ProjectFolderServices.guide`: the `Pick<ProjectGuide, ...>` the handlers
/// call. An `Err` is what the guide throws (`error.message`).
pub trait ProjectIpcGuide {
    fn list_projects(&mut self) -> Result<Vec<ProjectListItem>, Thrown>;
    fn add_folder(
        &mut self,
        folder_path: &str,
        ask: &mut dyn TrustAsk,
    ) -> Result<AddFolderResult, Thrown>;
    fn relocate_project(
        &mut self,
        id: &str,
        folder_path: &str,
        ask: &mut dyn TrustAsk,
    ) -> Result<AddFolderResult, Thrown>;
    fn get_default_parent_folder(&mut self) -> Result<String, Thrown>;
    fn create_project(
        &mut self,
        request: &NewProjectRequest,
        ask: &mut dyn TrustAsk,
    ) -> Result<CreateProjectResult, Thrown>;
    fn remove_from_list(&mut self, id: &str) -> Result<(), Thrown>;
    fn set_pinned(&mut self, id: &str, pinned: bool) -> Result<(), Thrown>;
    fn rename_project(&mut self, id: &str, name: &str) -> Result<ProjectWriteResult, Thrown>;
    fn retry_unwritable(&mut self, id: &str) -> Result<ProjectWriteResult, Thrown>;
    /// `projectRoot(id)`: `None` (`null`) for a project not listed
    fn project_root(&mut self, id: &str) -> Option<String>;
    fn get_selection(&mut self, target: &SelectionTarget) -> Result<ProjectSelection, Thrown>;
    fn set_selection(
        &mut self,
        target: &SelectionTarget,
        project_id: Option<&str>,
    ) -> Result<ProjectSelection, Thrown>;
    fn adopt_folder_hint(
        &mut self,
        doc_path: &str,
        ask: &mut dyn TrustAsk,
    ) -> Result<AddFolderResult, Thrown>;
    fn read_context(&mut self, id: &str) -> Result<ProjectContextResult, Thrown>;
    fn edit_memory(
        &mut self,
        id: &str,
        change: &ProjectMemoryOp,
        by: MemoryAuthor,
    ) -> Result<ProjectMemoryEditResult, Thrown>;
    fn save_memory(&mut self, id: &str, text: &str) -> Result<ProjectWriteResult, Thrown>;
    /// `applyMemoryConsolidation({ projectId, entries })`: `entries` is what
    /// the request carried (an array), not checked to hold strings: the guide
    /// judges that, after it knows the project
    fn apply_memory_consolidation(
        &mut self,
        project_id: &str,
        entries: &[JsonValue],
    ) -> Result<ApplyMemoryConsolidationResult, Thrown>;
    fn undo_memory_consolidation(
        &mut self,
        project_id: &str,
        backup_name: &str,
    ) -> Result<UndoMemoryConsolidationResult, Thrown>;
    fn get_project_detail(&mut self, id: &str) -> Result<ProjectDetail, Thrown>;
    fn get_settings(&mut self, id: &str) -> Result<ProjectSettings, Thrown>;
    fn set_settings(
        &mut self,
        id: &str,
        patch: &ProjectSettingsPatch,
    ) -> Result<ProjectSettings, Thrown>;
    fn decide_trust(
        &mut self,
        id: &str,
        decision: ProjectTrustDecision,
        ask: &mut dyn TrustAsk,
    ) -> Result<DecideTrustResult, Thrown>;
    fn save_instructions(&mut self, id: &str, text: &str) -> Result<ProjectWriteResult, Thrown>;
    fn add_ignore(&mut self, id: &str, rel_path: &str) -> Result<ProjectWriteResult, Thrown>;
    fn remove_ignore(&mut self, id: &str, rel_path: &str) -> Result<ProjectWriteResult, Thrown>;
    /// `aiVisibility(id)`: `None` (`null`) when not listed
    fn ai_visibility(&mut self, id: &str) -> Result<Option<ProjectAiVisibility>, Thrown>;
}

/// `ProjectFolderServices.chats`: the `Pick<ProjectChatStore, ...>` the
/// handlers call. Where the handler reads only the `status` of an answer, it
/// is the JSON the store answers.
pub trait ProjectIpcChats {
    /// `newChat(projectId)`: the new chat's id (the TypeScript answers
    /// `{ chatId }`)
    fn new_chat(&mut self, project_id: &str) -> Result<ProjectId, Thrown>;
    fn list_chats(&mut self, project_id: &str) -> Result<Vec<ProjectChatListItem>, Thrown>;
    /// `openChat(args)`
    fn open_chat(&mut self, args: &JsonValue) -> Result<Value, Thrown>;
    /// `append(args, sender)`; the store's `onAppended` listeners run inside
    /// it (see [`ProjectIpcChats::take_appended`])
    fn append(&mut self, args: &JsonValue, sender: &ChatSender) -> Result<Value, Thrown>;
    fn rename_chat(&mut self, args: &JsonValue) -> Result<ProjectWriteResult, Thrown>;
    fn delete_chat(&mut self, chat_ref: &ProjectChatRef) -> Result<ProjectWriteResult, Thrown>;
    fn attach_document(
        &mut self,
        chat_ref: &ProjectChatRef,
        doc_path: &str,
    ) -> Result<ProjectWriteResult, Thrown>;
    fn chat_for_document(
        &mut self,
        project_id: &str,
        doc_path: &str,
    ) -> Result<Option<ProjectId>, Thrown>;
    /// `chatInfo(ref)`: `None` (`null`) for a chat that is not visible
    fn chat_info(&mut self, chat_ref: &ProjectChatRef) -> Result<Option<ChatDocuments>, Thrown>;
    /// The calls `onAppended(listener)` made to the layer's listener since the
    /// last call, in order. The plumbing registers one listener on the first
    /// use of the services; here the events it saw are taken after each
    /// `append`.
    fn take_appended(&mut self) -> Vec<AppendedNotice>;
}

/// `ProjectFolderServices.tools`: `Pick<ProjectFolderTools, 'openScope' |
/// 'closeScope' | 'listFiles' | 'search' | 'read'>`; the unsaved-files list
/// `search` and `read` read is the implementor's
pub trait ProjectIpcTools {
    fn open_scope(&mut self, owner: i64, raw: &JsonValue) -> Result<String, Thrown>;
    fn close_scope(&mut self, owner: i64, raw: &JsonValue);
    fn list_files(&mut self, owner: i64, raw: &JsonValue)
    -> Result<ProjectListFilesResult, Thrown>;
    fn search(&mut self, owner: i64, raw: &JsonValue) -> Result<ProjectSearchResult, Thrown>;
    fn read(&mut self, owner: i64, raw: &JsonValue) -> Result<ProjectReadResult, Thrown>;
}

/// `ProjectFolderServices.scopes`: `Pick<KbRunScopes, 'projectOf'>`
pub trait ProjectIpcScopes {
    /// `projectOf(owner, raw)`: the project the call's scope also reads, or
    /// `None` (`null`); a scope main does not hold is an `Err`
    fn project_of(&mut self, owner: i64, raw: &JsonValue) -> Result<Option<ProjectId>, Thrown>;
}

/// `ProjectDialogs`. `ask_trust` and `wait_for_return` have no error: the
/// guide's `TrustAsk` has none, and a rejection of either in the TypeScript
/// would abort the guide's call; the plumbing answers a closed dialog (`None`,
/// `false`) instead.
pub trait ProjectIpcDialogs {
    /// OS folder picker parented to `owner`'s window; `None` when closed
    fn pick_folder(
        &mut self,
        owner: i64,
        purpose: ProjectFolderPickPurpose,
    ) -> Result<Option<String>, Thrown>;
    /// "Use this folder as the project?"; `true` only on the person's yes
    fn confirm_use_existing(&mut self, owner: i64, folder_path: &str) -> Result<bool, Thrown>;
    /// The first-time trust prompt (spec 5.10) over `owner`'s window; `None`
    /// when closed
    fn ask_trust(&mut self, owner: i64, prompt: &ProjectTrustPrompt) -> Option<ProjectTrustChoice>;
    /// After [view all] opened the files in the app: `true` when the person
    /// comes back to `owner`'s page (the prompt then shows again), `false`
    /// when that page is gone (the addition is cancelled). See
    /// [`PageReturnWatch`].
    fn wait_for_return(&mut self, owner: i64) -> bool;
}

/// The rest of `ProjectIpcDeps`
pub trait ProjectIpcHost {
    /// `windowOf(sender)`: the window behind a webContents id; `None` for
    /// anything that is not an AI window
    fn window_of(&mut self, sender: i64) -> Option<ProjectWindow>;
    /// `send(target, channel, payload)`: `false` when the window is gone
    fn send(&mut self, target: i64, channel: &str, payload: &Value) -> bool;
    /// `legacyChatFor(docPath)`: this document's earlier per-document chat
    fn legacy_chat_for(&mut self, doc_path: &str) -> Result<Option<LegacyDocumentChat>, Thrown>;
    /// `openFolder(path)`: in Explorer / Finder
    fn open_folder(&mut self, path: &str) -> Result<(), Thrown>;
    /// `openDocument(path)`: opens (or focuses) a document through the shell's
    /// file-open path; its webContents id, or `None`
    fn open_document(&mut self, path: &str) -> Option<i64>;
    /// `showHome()`: switches to the home tab; its webContents id, or `None`
    fn show_home(&mut self) -> Option<i64>;
    /// `projectsChanged()`: the list, a folder or a project's place changed
    fn projects_changed(&mut self);
    /// `resolveCloudOnly`: "not on this PC" for the ignored-files list; `None`
    /// where the shell passes none
    fn cloud_only(&mut self) -> Option<&mut dyn CloudOnlyResolver>;
    /// `presetProjectOf(sender)`: the project a create flow opened this
    /// untitled window in; `Ok(None)` also where the shell passes none
    fn preset_project_of(&mut self, sender: i64) -> Result<Option<ProjectId>, Thrown>;
}

/// What a request is served with: `services()`, `dialogs` and the rest of
/// `deps`
pub struct ProjectIpcDeps<'a> {
    pub guide: &'a mut dyn ProjectIpcGuide,
    pub chats: &'a mut dyn ProjectIpcChats,
    pub tools: &'a mut dyn ProjectIpcTools,
    pub scopes: &'a mut dyn ProjectIpcScopes,
    pub dialogs: &'a mut dyn ProjectIpcDialogs,
    pub host: &'a mut dyn ProjectIpcHost,
}

// ── the request ──

/// `record(raw)[key]`: `record` of anything but an object is `{}`
fn field<'a>(raw: Option<&'a JsonValue>, key: &str) -> Option<&'a JsonValue> {
    match raw {
        Some(JsonValue::Object(object)) => object.get(key),
        _ => None,
    }
}

fn bad_request() -> Thrown {
    Thrown(PROJECT_IPC_BAD_REQUEST.to_owned())
}

/// `projectIdOf(raw)`
fn project_id_of(raw: Option<&JsonValue>) -> Result<ProjectId, Thrown> {
    match field(raw, "projectId") {
        Some(JsonValue::String(id)) if is_valid_project_id(id) => Ok(id.clone()),
        _ => Err(bad_request()),
    }
}

/// `chatRefOf(raw)`
fn chat_ref_of(raw: Option<&JsonValue>) -> Result<ProjectChatRef, Thrown> {
    match (field(raw, "projectId"), field(raw, "chatId")) {
        (Some(JsonValue::String(project_id)), Some(JsonValue::String(chat_id)))
            if is_valid_project_id(project_id) && is_valid_project_id(chat_id) =>
        {
            Ok(ProjectChatRef {
                project_id: project_id.clone(),
                chat_id: chat_id.clone(),
            })
        }
        _ => Err(bad_request()),
    }
}

/// `textOf(raw, key)`
fn text_of<'a>(raw: Option<&'a JsonValue>, key: &str) -> Result<&'a str, Thrown> {
    match field(raw, key) {
        Some(JsonValue::String(text)) => Ok(text),
        _ => Err(bad_request()),
    }
}

/// `memoryOpOf(value)`
fn memory_op_of(value: Option<&JsonValue>) -> Result<ProjectMemoryOp, Thrown> {
    let op = field(value, "op");
    let text = |key: &str| match field(value, key) {
        Some(JsonValue::String(text)) => Some(text.clone()),
        _ => None,
    };
    match op {
        Some(JsonValue::String(op)) if op == "add" => {
            if let Some(text) = text("text") {
                return Ok(ProjectMemoryOp::Add { text });
            }
        }
        Some(JsonValue::String(op)) if op == "remove" => {
            if let Some(text) = text("text") {
                return Ok(ProjectMemoryOp::Remove { text });
            }
        }
        Some(JsonValue::String(op)) if op == "replace" => {
            if let (Some(old), Some(new)) = (text("old"), text("new")) {
                return Ok(ProjectMemoryOp::Replace { old, new });
            }
        }
        _ => {}
    }
    Err(bad_request())
}

/// `sectionOf(value)`
fn section_of(value: Option<&JsonValue>) -> Option<ProjectScreenSection> {
    match value {
        Some(JsonValue::String(text)) if text == "instructions" => {
            Some(ProjectScreenSection::Instructions)
        }
        Some(JsonValue::String(text)) if text == "memory" => Some(ProjectScreenSection::Memory),
        _ => None,
    }
}

/// `documentPathIn(root, rel, platform)`: a folder-relative path from a
/// chat's `documents`, made absolute only when it stays inside
fn document_path_in(root: &str, rel: &str, platform: &str) -> Option<String> {
    let mut letter_colon = rel.chars();
    let drive = matches!(
        (letter_colon.next(), letter_colon.next()),
        (Some(letter), Some(':')) if letter.is_ascii_alphabetic()
    );
    if rel.is_empty() || is_absolute(rel) || drive {
        return None;
    }
    let segments: Vec<&str> = rel
        .split(['\\', '/'])
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.is_empty() || segments.iter().any(|s| *s == ".." || *s == ".") {
        return None;
    }
    let mut parts = vec![root];
    parts.extend(segments);
    let path = join(&parts);
    relative_inside(root, &path, platform).map(|_| path)
}

/// `keyOf(ref)`: `projectId/chatId`
fn key_of(project_id: &str, chat_id: &str) -> String {
    format!("{project_id}/{chat_id}")
}

/// `PROJECT_FOLDER_EVENTS[method]`
fn event_channel(method: ProjectFolderEventMethod) -> &'static str {
    PROJECT_FOLDER_EVENTS
        .iter()
        .find(|(known, _)| *known == method)
        .map(|(_, channel)| *channel)
        .expect("a channel of every event method")
}

/// `EVENT_METHODS.includes(name)`
fn event_method_of(name: &str) -> Option<ProjectFolderEventMethod> {
    PROJECT_FOLDER_EVENTS
        .iter()
        .map(|(method, _)| *method)
        .find(|method| method.as_str() == name)
}

fn reply<T: Serialize>(value: &T) -> Result<Reply, Thrown> {
    serde_json::to_value(value)
        .map(Some)
        .map_err(|error| Thrown(error.to_string()))
}

/// `result.status === 'ok'`: whether a write went through
trait Wrote {
    fn wrote(&self) -> bool;
}

impl Wrote for ProjectWriteResult {
    fn wrote(&self) -> bool {
        *self == ProjectWriteResult::Ok
    }
}

impl Wrote for ProjectMemoryEditResult {
    fn wrote(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }
}

impl Wrote for DecideTrustResult {
    fn wrote(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }
}

impl Wrote for ApplyMemoryConsolidationResult {
    fn wrote(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }
}

impl Wrote for UndoMemoryConsolidationResult {
    fn wrote(&self) -> bool {
        matches!(self, Self::Ok { .. })
    }
}

/// An insertion-ordered table (`Map`, `Set`): a key set again keeps its place
struct Ordered<K, V> {
    entries: Vec<(K, V)>,
}

impl<K, V> Default for Ordered<K, V> {
    fn default() -> Self {
        Ordered {
            entries: Vec::new(),
        }
    }
}

impl<K: PartialEq, V> Ordered<K, V> {
    fn get(&self, key: &K) -> Option<&V> {
        self.entries
            .iter()
            .find(|(known, _)| known == key)
            .map(|(_, value)| value)
    }

    fn get_mut(&mut self, key: &K) -> Option<&mut V> {
        self.entries
            .iter_mut()
            .find(|(known, _)| known == key)
            .map(|(_, value)| value)
    }

    fn set(&mut self, key: K, value: V) {
        match self.get_mut(&key) {
            Some(slot) => *slot = value,
            None => self.entries.push((key, value)),
        }
    }

    fn remove(&mut self, key: &K) -> Option<V> {
        let at = self.entries.iter().position(|(known, _)| known == key)?;
        Some(self.entries.remove(at).1)
    }
}

/// `askTrustFor(sender)`: the trust prompt over the asking window, again after
/// each [view all], until an answer
struct ShellTrustAsk<'a> {
    sender: i64,
    dialogs: &'a mut dyn ProjectIpcDialogs,
    host: &'a mut dyn ProjectIpcHost,
}

impl ShellTrustAsk<'_> {
    /// `showTrustFiles(prompt)`: [view all] in the trust prompt: the quoted
    /// files open in the app and the chats folder in the file manager. The
    /// paths are built here from the prompt main made, never from a request.
    /// `true` when something opened in the app, so the prompt waits for the
    /// person.
    fn show_trust_files(&mut self, prompt: &ProjectTrustPrompt) -> bool {
        let root = prompt.folder_path.as_str();
        let data_dir = join(&[root, data_dir_name(root).as_str()]);
        let data_dir = data_dir.as_str();
        let files: [(&Option<String>, String); 4] = [
            (
                &prompt.instructions,
                join(&[data_dir, project_folder_name("instructionsFile")]),
            ),
            (
                &prompt.memory,
                join(&[data_dir, project_folder_name("memoryFile")]),
            ),
            (
                &prompt.agents,
                join(&[root, project_folder_name("rootAgentsFile")]),
            ),
            (
                &prompt.claude,
                join(&[root, project_folder_name("rootClaudeFile")]),
            ),
        ];
        let mut opened = false;
        for (text, path) in files {
            if text.is_none() {
                continue;
            }
            if self.host.open_document(&path).is_some() {
                opened = true;
            }
        }
        if !prompt.foreign_chats.is_empty() {
            // The prompt still lists the chats by title.
            let _ = self
                .host
                .open_folder(&join(&[data_dir, project_folder_name("chatsDir")]));
        }
        opened
    }
}

impl TrustAsk for ShellTrustAsk<'_> {
    fn ask(&mut self, prompt: &ProjectTrustPrompt) -> Option<ProjectTrustDecision> {
        loop {
            match self.dialogs.ask_trust(self.sender, prompt)? {
                ProjectTrustChoice::Answer(decision) => return Some(decision),
                ProjectTrustChoice::View => {
                    if self.show_trust_files(prompt) && !self.dialogs.wait_for_return(self.sender) {
                        return None;
                    }
                }
            }
        }
    }
}

/// `registerProjectFolderIpc`'s state: which window shows which chat, which
/// events each window listens to, and what is held for a window not listening
/// yet. The caller owns it and calls [`ProjectIpc::handle`] for each request.
pub struct ProjectIpc {
    platform: String,
    /// chat key (`projectId/chatId`) -> windows showing that chat
    watchers: Ordered<String, Vec<i64>>,
    /// window -> the chat it shows
    watching: Ordered<i64, String>,
    /// window -> events its bridge listens to
    listening: Ordered<i64, Vec<ProjectFolderEventMethod>>,
    /// window -> the latest event per kind it was sent before it listened
    held: Ordered<i64, Ordered<ProjectFolderEventMethod, Value>>,
    /// window of an untitled document -> the project its panel chose
    untitled: Ordered<i64, Option<ProjectId>>,
    /// window -> the selection its panel was last given
    chosen: Ordered<i64, Option<ProjectId>>,
}

impl ProjectIpc {
    /// `platform`: `deps.platform`, default the host's
    pub fn new(platform: Option<String>) -> Self {
        ProjectIpc {
            platform: platform.unwrap_or_else(|| process_platform().to_owned()),
            watchers: Ordered::default(),
            watching: Ordered::default(),
            listening: Ordered::default(),
            held: Ordered::default(),
            untitled: Ordered::default(),
            chosen: Ordered::default(),
        }
    }

    fn unwatch(&mut self, sender: i64) {
        let Some(key) = self.watching.get(&sender).cloned() else {
            return;
        };
        self.watching.remove(&sender);
        if let Some(set) = self.watchers.get_mut(&key) {
            set.retain(|window| *window != sender);
            if set.is_empty() {
                self.watchers.remove(&key);
            }
        }
    }

    fn watch(&mut self, sender: i64, chat_ref: &ProjectChatRef) {
        let key = key_of(&chat_ref.project_id, &chat_ref.chat_id);
        if self.watching.get(&sender) == Some(&key) {
            return;
        }
        self.unwatch(sender);
        self.watching.set(sender, key.clone());
        match self.watchers.get_mut(&key) {
            Some(set) => {
                if !set.contains(&sender) {
                    set.push(sender);
                }
            }
            None => self.watchers.set(key, vec![sender]),
        }
    }

    /// `reset(sender)`: a window started loading a page (a reload): its
    /// listeners and its chat are gone, but what is held for it stays until
    /// the new page listens
    pub fn reset(&mut self, sender: i64) {
        self.unwatch(sender);
        self.listening.remove(&sender);
        self.untitled.remove(&sender);
        self.chosen.remove(&sender);
    }

    /// `forget(sender)`: a window closed: forget everything about it
    pub fn forget(&mut self, sender: i64) {
        self.reset(sender);
        self.held.remove(&sender);
    }

    /// `forward(event, from)`: a recorded message goes to every other window
    /// showing the same chat
    pub fn forward(
        &mut self,
        host: &mut dyn ProjectIpcHost,
        event: &ChatAppendedEvent,
        from: Option<&JsonValue>,
    ) {
        let key = key_of(&event.project_id, &event.chat_id);
        let Some(set) = self.watchers.get(&key) else {
            return;
        };
        let targets = set.clone();
        let payload = serde_json::to_value(event).unwrap_or(Value::Null);
        let channel = event_channel(ProjectFolderEventMethod::OnChatMessageAppended);
        for target in targets {
            if matches!(from, Some(JsonValue::Number(n)) if *n == target as f64) {
                continue;
            }
            if !host.send(target, channel, &payload) {
                self.forget(target);
            }
        }
    }

    /// the events the chat store's listener saw during the call that just
    /// ended
    fn forward_appended(&mut self, deps: &mut ProjectIpcDeps<'_>) {
        for notice in deps.chats.take_appended() {
            self.forward(&mut *deps.host, &notice.event, notice.from.as_ref());
        }
    }

    /// `announce(projectId, part)`: a request wrote part of a project: every
    /// window listening hears it, the sender included. Sent before the request
    /// answers, so a window reading the answer already knows. Nothing is held
    /// for a window not listening yet: it reads the project when it starts.
    fn announce(
        &mut self,
        host: &mut dyn ProjectIpcHost,
        project_id: &str,
        part: ProjectChangedPart,
    ) {
        let payload = serde_json::to_value(ProjectChangedEvent {
            project_id: project_id.to_owned(),
            part,
        })
        .unwrap_or(Value::Null);
        let channel = event_channel(ProjectFolderEventMethod::OnProjectChanged);
        let targets: Vec<i64> = self
            .listening
            .entries
            .iter()
            .filter(|(_, methods)| methods.contains(&ProjectFolderEventMethod::OnProjectChanged))
            .map(|(target, _)| *target)
            .collect();
        for target in targets {
            if !host.send(target, channel, &payload) {
                self.forget(target);
            }
        }
    }

    /// `announced(projectId, part, write)`: a write is announced when its
    /// answer says it went through
    fn announced<T: Wrote>(
        &mut self,
        host: &mut dyn ProjectIpcHost,
        project_id: &str,
        part: ProjectChangedPart,
        write: Result<T, Thrown>,
    ) -> Result<T, Thrown> {
        let result = write?;
        if result.wrote() {
            self.announce(host, project_id, part);
        }
        Ok(result)
    }

    /// `deliver(target, method, payload)`: sends now when the window listens,
    /// else holds the latest of its kind until it does
    fn deliver(
        &mut self,
        host: &mut dyn ProjectIpcHost,
        target: i64,
        method: ProjectFolderEventMethod,
        payload: Value,
    ) {
        if self
            .listening
            .get(&target)
            .is_some_and(|methods| methods.contains(&method))
        {
            if host.send(target, event_channel(method), &payload) {
                return;
            }
            self.forget(target);
            return;
        }
        match self.held.get_mut(&target) {
            Some(waiting) => waiting.set(method, payload),
            None => {
                let mut waiting = Ordered::default();
                waiting.set(method, payload);
                self.held.set(target, waiting);
            }
        }
    }

    /// `targetOf(sender, win)`
    fn target_of(
        &self,
        host: &mut dyn ProjectIpcHost,
        sender: i64,
        win: &ProjectWindow,
    ) -> Result<SelectionTarget, Thrown> {
        let ProjectWindow::Editor { doc_path, .. } = win else {
            return Ok(SelectionTarget::Home);
        };
        if let Some(path) = truthy(doc_path.as_deref()) {
            return Ok(SelectionTarget::Document {
                path: path.to_owned(),
            });
        }
        if let Some(project_id) = self.untitled.get(&sender) {
            return Ok(SelectionTarget::Untitled {
                project_id: project_id.clone(),
            });
        }
        // a tab a create flow opened in a project starts in it (spec 5.2)
        let preset = host.preset_project_of(sender)?;
        Ok(SelectionTarget::Untitled { project_id: preset })
    }

    /// `controller.listen(sender, method, on)`: a window's bridge started or
    /// stopped listening to one event
    pub fn listen(
        &mut self,
        host: &mut dyn ProjectIpcHost,
        sender: i64,
        method: Option<&JsonValue>,
        on: Option<&JsonValue>,
    ) {
        let Some(JsonValue::String(name)) = method else {
            return;
        };
        let Some(event) = event_method_of(name) else {
            return;
        };
        if !matches!(on, Some(JsonValue::Bool(true))) {
            if let Some(set) = self.listening.get_mut(&sender) {
                set.retain(|known| *known != event);
            }
            return;
        }
        match self.listening.get_mut(&sender) {
            Some(set) => {
                if !set.contains(&event) {
                    set.push(event);
                }
            }
            None => self.listening.set(sender, vec![event]),
        }
        let Some(waiting) = self.held.get_mut(&sender) else {
            return;
        };
        let Some(payload) = waiting.remove(&event) else {
            return;
        };
        if waiting.entries.is_empty() {
            self.held.remove(&sender);
        }
        self.deliver(host, sender, event, payload);
    }

    /// `controller.untitledProject(sender)`: the project an untitled
    /// document's panel chose (for saving new documents later)
    pub fn untitled_project(&self, sender: i64) -> Option<ProjectId> {
        self.untitled.get(&sender).cloned().flatten()
    }

    /// `controller.windowProject(sender)`: the project this window's AI panel
    /// has chosen now (spec 6): the panel's last answer when it has asked,
    /// else the starting selection main would give it. `None` for "no project"
    /// and for anything that is not an AI window.
    pub fn window_project(
        &mut self,
        deps: &mut ProjectIpcDeps<'_>,
        sender: i64,
    ) -> Option<ProjectId> {
        let win = deps.host.window_of(sender)?;
        if let Some(chosen) = self.chosen.get(&sender) {
            return chosen.clone();
        }
        let target = self.target_of(&mut *deps.host, sender, &win).ok()?;
        deps.guide.get_selection(&target).ok()?.project_id
    }

    /// `windowOf(sender)` of the handlers: an `Err` for a window that is not
    /// an AI window
    fn window_of(host: &mut dyn ProjectIpcHost, sender: i64) -> Result<ProjectWindow, Thrown> {
        host.window_of(sender)
            .ok_or_else(|| Thrown(PROJECT_IPC_UNKNOWN_WINDOW.to_owned()))
    }

    /// `withInitialChat(win, selection)`: the chat a document opens with (spec
    /// 5.3.1), checked against the list in both cases
    fn with_initial_chat(
        chats: &mut dyn ProjectIpcChats,
        win: &ProjectWindow,
        mut selection: ProjectSelection,
    ) -> Result<ProjectSelection, Thrown> {
        let project_id = truthy(selection.project_id.as_deref()).map(str::to_owned);
        let doc_path = truthy(doc_path_of(win)).map(str::to_owned);
        selection.initial_chat_id = match (project_id, doc_path) {
            (Some(project_id), Some(doc_path)) => {
                chats.chat_for_document(&project_id, &doc_path)?
            }
            _ => None,
        };
        Ok(selection)
    }

    /// One request of the bridge: `handlers[name](sender, raw)`. `name` is a
    /// key of `PROJECT_FOLDER_CHANNELS`, `sender` the calling webContents id,
    /// `raw` the argument as the renderer sent it (`None` for none). An `Err`
    /// is what the handler throws.
    pub fn handle(
        &mut self,
        deps: &mut ProjectIpcDeps<'_>,
        name: &str,
        sender: i64,
        raw: Option<&JsonValue>,
    ) -> Result<Reply, Thrown> {
        match name {
            // ---- list ----
            "listProjects" => reply(&deps.guide.list_projects()?),
            "addFolder" => self.add_folder(deps, sender),
            "getDefaultParentFolder" => reply(&deps.guide.get_default_parent_folder()?),
            "createProject" => self.create_project(deps, sender, raw),
            "removeFromList" => {
                let project_id = project_id_of(raw)?;
                deps.guide.remove_from_list(&project_id)?;
                deps.host.projects_changed();
                self.announce(&mut *deps.host, &project_id, ProjectChangedPart::Settings);
                Ok(None)
            }
            "setPinned" => {
                let Some(JsonValue::Bool(pinned)) = field(raw, "pinned") else {
                    return Err(bad_request());
                };
                let project_id = project_id_of(raw)?;
                deps.guide.set_pinned(&project_id, *pinned)?;
                self.announce(&mut *deps.host, &project_id, ProjectChangedPart::Settings);
                Ok(None)
            }
            "renameProject" => {
                let project_id = project_id_of(raw)?;
                let write = text_of(raw, "name")
                    .and_then(|name| deps.guide.rename_project(&project_id, name));
                let result = self.announced(
                    &mut *deps.host,
                    &project_id,
                    ProjectChangedPart::Settings,
                    write,
                )?;
                reply(&result)
            }
            "relocateProject" => {
                let project_id = project_id_of(raw)?;
                let folder = deps
                    .dialogs
                    .pick_folder(sender, ProjectFolderPickPurpose::Relocate)?;
                let Some(folder) = truthy(folder.as_deref()) else {
                    return reply(&cancelled_add());
                };
                let mut ask = ShellTrustAsk {
                    sender,
                    dialogs: &mut *deps.dialogs,
                    host: &mut *deps.host,
                };
                let result = deps.guide.relocate_project(&project_id, folder, &mut ask)?;
                reply(&after_add_folder(&mut *deps.host, result))
            }
            "openInFileManager" => {
                let root = deps.guide.project_root(&project_id_of(raw)?);
                if let Some(root) = truthy(root.as_deref()) {
                    deps.host.open_folder(root)?;
                }
                Ok(None)
            }
            "retryUnwritable" => reply(&deps.guide.retry_unwritable(&project_id_of(raw)?)?),

            // ---- selection for this window's document ----
            "getSelection" => {
                let win = Self::window_of(&mut *deps.host, sender)?;
                let target = self.target_of(&mut *deps.host, sender, &win)?;
                let selection = deps.guide.get_selection(&target)?;
                self.chosen.set(sender, selection.project_id.clone());
                reply(&Self::with_initial_chat(&mut *deps.chats, &win, selection)?)
            }
            "setSelection" => {
                let win = Self::window_of(&mut *deps.host, sender)?;
                let project_id = match field(raw, "projectId") {
                    Some(JsonValue::Null) => None,
                    Some(JsonValue::String(id)) if is_valid_project_id(id) => Some(id.clone()),
                    _ => return Err(bad_request()),
                };
                let target = self.target_of(&mut *deps.host, sender, &win)?;
                let selection = deps.guide.set_selection(&target, project_id.as_deref())?;
                if matches!(target, SelectionTarget::Untitled { .. }) {
                    self.untitled.set(sender, project_id.clone());
                }
                self.chosen.set(sender, selection.project_id.clone());
                if project_id.is_none() {
                    self.unwatch(sender);
                }
                reply(&Self::with_initial_chat(&mut *deps.chats, &win, selection)?)
            }
            "adoptFolderHint" => {
                let win = Self::window_of(&mut *deps.host, sender)?;
                let Some(doc_path) = truthy(doc_path_of(&win)) else {
                    return reply(&AddFolderResult::Refused {
                        reason: FolderRefusalReason::NotAFolder,
                    });
                };
                let mut ask = ShellTrustAsk {
                    sender,
                    dialogs: &mut *deps.dialogs,
                    host: &mut *deps.host,
                };
                let result = deps.guide.adopt_folder_hint(doc_path, &mut ask)?;
                reply(&after_add_folder(&mut *deps.host, result))
            }

            // ---- one send ----
            "readContext" => reply(&deps.guide.read_context(&project_id_of(raw)?)?),
            "openScope" => reply(
                &deps
                    .tools
                    .open_scope(sender, raw.unwrap_or(&JsonValue::Null))?,
            ),
            "closeScope" => {
                deps.tools
                    .close_scope(sender, raw.unwrap_or(&JsonValue::Null));
                Ok(None)
            }

            // ---- tools ----
            "listFiles" => reply(
                &deps
                    .tools
                    .list_files(sender, raw.unwrap_or(&JsonValue::Null))?,
            ),
            "search" => reply(&deps.tools.search(sender, raw.unwrap_or(&JsonValue::Null))?),
            "read" => reply(&deps.tools.read(sender, raw.unwrap_or(&JsonValue::Null))?),
            "remember" => self.remember(deps, sender, raw),

            // ---- memory ----
            "editMemory" => {
                let project_id = project_id_of(raw)?;
                let change = memory_op_of(field(raw, "change"))?;
                let write = deps
                    .guide
                    .edit_memory(&project_id, &change, MemoryAuthor::Person);
                let result = self.announced(
                    &mut *deps.host,
                    &project_id,
                    ProjectChangedPart::Memory,
                    write,
                )?;
                reply(&result)
            }
            "saveMemory" => {
                let project_id = project_id_of(raw)?;
                let write =
                    text_of(raw, "text").and_then(|text| deps.guide.save_memory(&project_id, text));
                let result = self.announced(
                    &mut *deps.host,
                    &project_id,
                    ProjectChangedPart::Memory,
                    write,
                )?;
                reply(&result)
            }
            "applyMemoryConsolidation" => {
                let Some(JsonValue::Array(entries)) = field(raw, "entries") else {
                    return Err(bad_request());
                };
                let project_id = project_id_of(raw)?;
                let write = deps.guide.apply_memory_consolidation(&project_id, entries);
                let result = self.announced(
                    &mut *deps.host,
                    &project_id,
                    ProjectChangedPart::Memory,
                    write,
                )?;
                reply(&result)
            }
            "undoMemoryConsolidation" => {
                let project_id = project_id_of(raw)?;
                let write = text_of(raw, "backupName").and_then(|backup_name| {
                    deps.guide
                        .undo_memory_consolidation(&project_id, backup_name)
                });
                let result = self.announced(
                    &mut *deps.host,
                    &project_id,
                    ProjectChangedPart::Memory,
                    write,
                )?;
                reply(&result)
            }

            // ---- chats ----
            "listChats" => {
                let project_id = project_id_of(raw)?;
                let win = Self::window_of(&mut *deps.host, sender)?;
                let chats = deps.chats.list_chats(&project_id)?;
                let mut legacy = None;
                if let Some(doc_path) = truthy(doc_path_of(&win)) {
                    legacy = deps.host.legacy_chat_for(doc_path).ok().flatten();
                }
                reply(&ProjectChatListResult { chats, legacy })
            }
            "newChat" => {
                let project_id = project_id_of(raw)?;
                let chat_id = deps.chats.new_chat(&project_id)?;
                self.watch(
                    sender,
                    &ProjectChatRef {
                        project_id,
                        chat_id: chat_id.clone(),
                    },
                );
                Ok(Some(serde_json::json!({ "chatId": chat_id })))
            }
            "openChat" => {
                let chat_ref = chat_ref_of(raw)?;
                let mut args = JsObject::new();
                args.set("projectId", JsonValue::String(chat_ref.project_id.clone()));
                args.set("chatId", JsonValue::String(chat_ref.chat_id.clone()));
                if let Some(JsonValue::Number(limit)) = field(raw, "limit") {
                    args.set("limit", JsonValue::Number(*limit));
                }
                let opened = deps.chats.open_chat(&JsonValue::Object(args))?;
                if status_of(&opened) == Some("ok") {
                    self.watch(sender, &chat_ref);
                }
                Ok(Some(opened))
            }
            "appendChat" => self.append_chat(deps, sender, raw),
            "renameChat" => {
                let chat_ref = chat_ref_of(raw)?;
                let write = text_of(raw, "title").and_then(|title| {
                    let mut args = JsObject::new();
                    args.set("projectId", JsonValue::String(chat_ref.project_id.clone()));
                    args.set("chatId", JsonValue::String(chat_ref.chat_id.clone()));
                    args.set("title", JsonValue::String(title.to_owned()));
                    deps.chats.rename_chat(&JsonValue::Object(args))
                });
                let result = self.announced(
                    &mut *deps.host,
                    &chat_ref.project_id,
                    ProjectChangedPart::Chats,
                    write,
                )?;
                reply(&result)
            }
            "deleteChat" => {
                let chat_ref = chat_ref_of(raw)?;
                let result = deps.chats.delete_chat(&chat_ref)?;
                let key = key_of(&chat_ref.project_id, &chat_ref.chat_id);
                if result == ProjectWriteResult::Ok && self.watching.get(&sender) == Some(&key) {
                    self.unwatch(sender);
                }
                if result == ProjectWriteResult::Ok {
                    self.announce(
                        &mut *deps.host,
                        &chat_ref.project_id,
                        ProjectChangedPart::Chats,
                    );
                }
                reply(&result)
            }
            "attachDocument" => {
                let chat_ref = chat_ref_of(raw)?;
                // the path is this window's saved document, as the shell knows it
                let win = Self::window_of(&mut *deps.host, sender)?;
                let Some(doc_path) = truthy(doc_path_of(&win)) else {
                    return reply(&ProjectWriteResult::Ok);
                };
                reply(&deps.chats.attach_document(&chat_ref, doc_path)?)
            }
            "openDocumentChat" => self.open_document_chat(deps, raw),

            // ---- project screen ----
            "getProjectDetail" => reply(&deps.guide.get_project_detail(&project_id_of(raw)?)?),
            "getSettings" => reply(&deps.guide.get_settings(&project_id_of(raw)?)?),
            "setSettings" => {
                let patch = field(raw, "settings");
                let settings = ProjectSettingsPatch {
                    memory_enabled: match field(patch, "memoryEnabled") {
                        Some(JsonValue::Bool(flag)) => Some(*flag),
                        _ => None,
                    },
                    read_agents_files: match field(patch, "readAgentsFiles") {
                        Some(JsonValue::Bool(flag)) => Some(*flag),
                        _ => None,
                    },
                };
                let project_id = project_id_of(raw)?;
                let result = deps.guide.set_settings(&project_id, &settings)?;
                self.announce(&mut *deps.host, &project_id, ProjectChangedPart::Settings);
                reply(&result)
            }
            "decideTrust" => {
                let decision = match field(raw, "decision") {
                    Some(JsonValue::String(text)) if text == "use" => ProjectTrustDecision::Use,
                    Some(JsonValue::String(text)) if text == "without" => {
                        ProjectTrustDecision::Without
                    }
                    _ => return Err(bad_request()),
                };
                let project_id = project_id_of(raw)?;
                let mut ask = ShellTrustAsk {
                    sender,
                    dialogs: &mut *deps.dialogs,
                    host: &mut *deps.host,
                };
                let write = deps.guide.decide_trust(&project_id, decision, &mut ask);
                let result = self.announced(
                    &mut *deps.host,
                    &project_id,
                    ProjectChangedPart::Settings,
                    write,
                )?;
                reply(&result)
            }
            "saveInstructions" => {
                let project_id = project_id_of(raw)?;
                let write = text_of(raw, "text")
                    .and_then(|text| deps.guide.save_instructions(&project_id, text));
                let result = self.announced(
                    &mut *deps.host,
                    &project_id,
                    ProjectChangedPart::Instructions,
                    write,
                )?;
                reply(&result)
            }
            "addIgnore" => {
                let project_id = project_id_of(raw)?;
                let write = text_of(raw, "relPath")
                    .and_then(|rel_path| deps.guide.add_ignore(&project_id, rel_path));
                let result = self.announced(
                    &mut *deps.host,
                    &project_id,
                    ProjectChangedPart::Settings,
                    write,
                )?;
                reply(&result)
            }
            "removeIgnore" => {
                let project_id = project_id_of(raw)?;
                let write = text_of(raw, "relPath")
                    .and_then(|rel_path| deps.guide.remove_ignore(&project_id, rel_path));
                let result = self.announced(
                    &mut *deps.host,
                    &project_id,
                    ProjectChangedPart::Settings,
                    write,
                )?;
                reply(&result)
            }
            "listIgnoredFiles" => {
                let visibility = deps.guide.ai_visibility(&project_id_of(raw)?)?;
                let Some(visibility) = visibility else {
                    return reply(&Vec::<ProjectFileEntry>::new());
                };
                let files = list_ignored_files(&visibility).map_err(thrown_limit)?;
                let flagged = match deps.host.cloud_only() {
                    Some(resolver) => with_cloud_flags(&files, resolver),
                    None => files,
                };
                reply(&flagged.iter().map(to_entry).collect::<Vec<_>>())
            }
            "openProjectScreen" => {
                let project_id = project_id_of(raw)?;
                let section = section_of(field(raw, "section"));
                let event = OpenProjectScreenEvent {
                    project_id,
                    section,
                };
                if let Some(home) = deps.host.show_home() {
                    let payload = serde_json::to_value(&event).unwrap_or(Value::Null);
                    self.deliver(
                        &mut *deps.host,
                        home,
                        ProjectFolderEventMethod::OnOpenProjectScreen,
                        payload,
                    );
                }
                Ok(None)
            }
            other => Err(Thrown(format!("no request named {other}"))),
        }
    }

    fn add_folder(&mut self, deps: &mut ProjectIpcDeps<'_>, sender: i64) -> Result<Reply, Thrown> {
        let folder = deps
            .dialogs
            .pick_folder(sender, ProjectFolderPickPurpose::Add)?;
        let Some(folder) = truthy(folder.as_deref()) else {
            return reply(&cancelled_add());
        };
        let mut ask = ShellTrustAsk {
            sender,
            dialogs: &mut *deps.dialogs,
            host: &mut *deps.host,
        };
        let result = deps.guide.add_folder(folder, &mut ask)?;
        reply(&after_add_folder(&mut *deps.host, result))
    }

    fn create_project(
        &mut self,
        deps: &mut ProjectIpcDeps<'_>,
        sender: i64,
        raw: Option<&JsonValue>,
    ) -> Result<Reply, Thrown> {
        let name = match field(raw, "name") {
            Some(JsonValue::String(name)) => trim(name).to_owned(),
            _ => String::new(),
        };
        if name.is_empty() {
            return reply(&CreateProjectResult::InvalidName);
        }
        // The place is main's to decide (spec 5.1): the default save folder, or a
        // parent the person picks in main's own folder picker. A path in the
        // request is never read.
        let mut request = NewProjectRequest {
            name,
            parent_dir: None,
            use_existing: None,
        };
        if matches!(field(raw, "otherPlace"), Some(JsonValue::Bool(true))) {
            let parent = deps
                .dialogs
                .pick_folder(sender, ProjectFolderPickPurpose::Parent)?;
            let Some(parent) = truthy(parent.as_deref()) else {
                return reply(&cancelled_create());
            };
            request.parent_dir = Some(parent.to_owned());
        }
        let mut ask = ShellTrustAsk {
            sender,
            dialogs: &mut *deps.dialogs,
            host: &mut *deps.host,
        };
        let created = deps.guide.create_project(&request, &mut ask)?;
        let CreateProjectResult::Exists { folder_path } = created else {
            return reply(&after_add_created(&mut *deps.host, created));
        };
        if !deps.dialogs.confirm_use_existing(sender, &folder_path)? {
            return reply(&cancelled_create());
        }
        request.use_existing = Some(true);
        let mut ask = ShellTrustAsk {
            sender,
            dialogs: &mut *deps.dialogs,
            host: &mut *deps.host,
        };
        let created = deps.guide.create_project(&request, &mut ask)?;
        reply(&after_add_created(&mut *deps.host, created))
    }

    fn remember(
        &mut self,
        deps: &mut ProjectIpcDeps<'_>,
        sender: i64,
        raw: Option<&JsonValue>,
    ) -> Result<Reply, Thrown> {
        // the project comes from the run scope this window holds, never from the request
        let project_id = if field(raw, "scope").is_none() {
            None
        } else {
            deps.scopes
                .project_of(sender, raw.unwrap_or(&JsonValue::Null))
                .ok()
                .flatten()
        };
        let Some(project_id) = truthy(project_id.as_deref()) else {
            return Err(Thrown(PROJECT_SCOPE_UNKNOWN.to_owned()));
        };
        let change = memory_op_of(field(raw, "change"))?;
        let write = deps
            .guide
            .edit_memory(project_id, &change, MemoryAuthor::Ai);
        let result = self.announced(
            &mut *deps.host,
            project_id,
            ProjectChangedPart::Memory,
            write,
        )?;
        reply(&result)
    }

    fn append_chat(
        &mut self,
        deps: &mut ProjectIpcDeps<'_>,
        sender: i64,
        raw: Option<&JsonValue>,
    ) -> Result<Reply, Thrown> {
        let chat_ref = chat_ref_of(raw)?;
        let win = Self::window_of(&mut *deps.host, sender)?;
        let mut args = match raw {
            Some(JsonValue::Object(object)) => object.clone(),
            _ => JsObject::new(),
        };
        args.set("projectId", JsonValue::String(chat_ref.project_id.clone()));
        args.set("chatId", JsonValue::String(chat_ref.chat_id.clone()));
        let poster = ChatSender {
            editor: match &win {
                ProjectWindow::Home => "home".to_owned(),
                ProjectWindow::Editor { editor, .. } => editor.as_str().to_owned(),
            },
            doc_path: doc_path_of(&win).map(str::to_owned),
            key: Some(JsonValue::Number(sender as f64)),
        };
        let result = deps.chats.append(&JsonValue::Object(args), &poster);
        // the store's listener ran inside the call, thrown or not
        self.forward_appended(deps);
        let result = result?;
        self.watch(sender, &chat_ref);
        // a saved message moves the chat in the lists (title, time, last editor)
        if status_of(&result) == Some("saved") {
            self.announce(
                &mut *deps.host,
                &chat_ref.project_id,
                ProjectChangedPart::Chats,
            );
        }
        Ok(Some(result))
    }

    fn open_document_chat(
        &mut self,
        deps: &mut ProjectIpcDeps<'_>,
        raw: Option<&JsonValue>,
    ) -> Result<Reply, Thrown> {
        let chat_ref = chat_ref_of(raw)?;
        let Some(info) = deps.chats.chat_info(&chat_ref)? else {
            return Ok(None);
        };
        let mut target: Option<i64> = None;
        let latest = info.documents.last().map(String::as_str);
        let root = deps.guide.project_root(&chat_ref.project_id);
        if let (Some(latest), Some(root)) = (truthy(latest), truthy(root.as_deref()))
            && info.last_editor != ProjectEditor::Home
            && let Some(path) = document_path_in(root, latest, &self.platform)
        {
            target = deps.host.open_document(&path);
        }
        // no document (or one that cannot be opened), or a chat last used at home
        if target.is_none() {
            target = deps.host.show_home();
        }
        if let Some(target) = target {
            let payload = serde_json::to_value(&chat_ref).unwrap_or(Value::Null);
            self.deliver(
                &mut *deps.host,
                target,
                ProjectFolderEventMethod::OnOpenChat,
                payload,
            );
        }
        Ok(None)
    }
}

/// `docPathOf(win)`
fn doc_path_of(win: &ProjectWindow) -> Option<&str> {
    match win {
        ProjectWindow::Home => None,
        ProjectWindow::Editor { doc_path, .. } => doc_path.as_deref(),
    }
}

/// `result.status` of an answer kept as JSON
fn status_of(result: &Value) -> Option<&str> {
    result.get("status").and_then(Value::as_str)
}

fn cancelled_add() -> AddFolderResult {
    AddFolderResult::Cancelled {
        stage: AddFolderStage::Dialog,
    }
}

fn cancelled_create() -> CreateProjectResult {
    CreateProjectResult::Cancelled {
        stage: AddFolderStage::Dialog,
    }
}

/// `afterAdd(result)` of a folder result: the list changed when one was added
fn after_add_folder(host: &mut dyn ProjectIpcHost, result: AddFolderResult) -> AddFolderResult {
    if matches!(result, AddFolderResult::Added { .. }) {
        host.projects_changed();
    }
    result
}

/// `afterAdd(result)` of a create result: the list changed when one was added
/// or created
fn after_add_created(
    host: &mut dyn ProjectIpcHost,
    result: CreateProjectResult,
) -> CreateProjectResult {
    if matches!(
        result,
        CreateProjectResult::Added { .. } | CreateProjectResult::Created { .. }
    ) {
        host.projects_changed();
    }
    result
}

/// `waitForPageReturn(page, armAfterMs)`: resolves `true` when the person
/// comes back to the page (it takes the focus again) after [view all] opened
/// the files elsewhere, `false` when the page is gone first. The focus a
/// closing dialog hands straight back to its window is not a return: a focus
/// counts once the page lost it, or after `armAfterMs`.
///
/// The page's events and the timer are the caller's to drive: it calls
/// [`PageReturnWatch::arm`] when `armAfterMs` has passed (the `setTimeout`),
/// [`PageReturnWatch::blur`], [`PageReturnWatch::focus`] and
/// [`PageReturnWatch::destroyed`] as the page emits them, and stops when
/// [`PageReturnWatch::outcome`] answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageReturnWatch {
    armed: bool,
    outcome: Option<bool>,
}

impl PageReturnWatch {
    /// `page.isDestroyed()` is `page_destroyed`: the watch is over already
    pub fn new(page_destroyed: bool) -> Self {
        PageReturnWatch {
            armed: false,
            outcome: page_destroyed.then_some(false),
        }
    }

    /// the timer of `armAfterMs` fired
    pub fn arm(&mut self) {
        if self.outcome.is_none() {
            self.armed = true;
        }
    }

    /// the page's `blur`
    pub fn blur(&mut self) {
        self.arm();
    }

    /// the page's `focus`
    pub fn focus(&mut self) {
        if self.outcome.is_none() && self.armed {
            self.outcome = Some(true);
        }
    }

    /// the page's `destroyed`
    pub fn destroyed(&mut self) {
        if self.outcome.is_none() {
            self.outcome = Some(false);
        }
    }

    /// what the promise resolved with; `None` while it is pending
    pub fn outcome(&self) -> Option<bool> {
        self.outcome
    }
}
