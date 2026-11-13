//! `apps/shell/src/main/projects/chat-store.ts`: the chats inside a project
//! folder (spec 3, 5.3, 5.7): `.seuoffice/chats/<chatId>.json` holds the chat
//! info and `<chatId>.jsonl` one message per line.
//!
//! The TypeScript awaits `node:fs/promises` and the guide; each call here is
//! the plain synchronous one. The store is a struct the caller owns
//! ([`ProjectChatStore`]); everything it reaches outside the folder is a trait:
//!
//! - [`ChatStoreGuide`]: the calls of `ChatStoreGuide` (a `Pick` of
//!   `ProjectGuide`), so the guide port can implement it;
//! - [`ChatStoreHost`]: `deps.trash`, `deps.now`, `deps.newId` and
//!   `console.warn`;
//! - [`ChatAppendedListener`]: a subscriber of `onAppended`.
//!
//! Where the TypeScript runs one task at a time per chat (`serialize`), every
//! method here takes `&mut self` and so runs to completion before the next
//! begins: no chat but the one being served is ever busy, which is why the
//! `queues` map of the TypeScript has no counterpart (`isIdle` asks only about
//! the states in memory).
//!
//! The records a chat holds are JSON objects whose keys the TypeScript keeps in
//! the order they were read or set (a line of a chat file keeps keys the app
//! does not know, `parseInfo` spreads the raw object), so a message and the
//! info are [`JsObject`] of [`JsonValue`] rather than the fixed structs of
//! `packages::project_store`: the key order of a message written by
//! `buildMessage` is not the order of those structs either. The arguments of
//! `append`, `openChat` and `renameChat` are read as the untyped JSON the
//! renderer sends, since the TypeScript checks each field (`typeof ...`).
//!
//! A string cut with `slice` counts UTF-16 code units; a cut inside a
//! surrogate pair gives U+FFFD where JavaScript keeps the lone half
//! (`jscompat::slice_utf16`), which a Rust string cannot hold.

use std::borrow::Cow;
use std::fs::{File, Metadata};
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::LazyLock;

use icu_collator::options::CollatorOptions;
use icu_collator::{Collator, CollatorBorrowed, CollatorPreferences};
use jscompat::node_path::host::{basename, is_absolute};
use jscompat::{
    JsMap, JsObject, JsonValue, base64, is_js_space, json_parse, json_stringify,
    json_stringify_pretty, math_max, slice_utf16, sort_by_number, trim,
};
use serde::Serialize;

use super::folder_files::{data_dir_name, plain_file_in, plain_folder_entries, read_folder_text};
use super::project_guide::{DataUpdateOutcome, SelectionTarget};
use super::trust::has_foreign_message;
use crate::node_fs::{NodeError, namespaced, node_error, node_error_fd};
use crate::packages::ai_provider::agent_session_policy::process_platform;
use crate::packages::project_store::{
    PROJECT_EDITORS, PROJECT_FORMAT_VERSION, ProjectChatListItem, ProjectChatRef, ProjectEditor,
    ProjectId, ProjectSelection, ProjectTrustState, ProjectWriteResult, is_valid_project_id, nfc,
    project_folder_name,
};

/// Characters of the first user message that become a chat's automatic title (spec 5.3)
pub const CHAT_TITLE_CHARS: usize = 40;

/// Longest title a rename keeps
pub const CHAT_TITLE_MAX_CHARS: usize = 200;

// Same values as project-store (`packages/project-store/src/store.ts`).
const TEXT_MAX_CHARS: usize = 32_000;
const TEXT_TRUNCATED_MARK: &str = "\n\n[truncated]";
const TOOL_FIELD_MAX_CHARS: usize = 16_000;
const MAX_TOOLS_PER_MESSAGE: usize = 64;
const MAX_ATTACHMENTS_PER_MESSAGE: usize = 32;
const TOOL_NAME_MAX_CHARS: usize = 200;
const TOOL_SUMMARY_MAX_CHARS: usize = 2_000;
const ATTACHMENT_FIELD_MAX_CHARS: usize = 1_000;
const SCOPE_TEXT_MAX_CHARS: usize = 400;
const SCOPE_LABEL_MAX_CHARS: usize = 200;
const MAX_SKILLS_PER_MESSAGE: usize = 32;
const SKILL_ID_MAX_CHARS: usize = 512;
const SKILL_FIELD_MAX_CHARS: usize = 200;

/// Opening messages held before the first reply; reaching it writes the file early instead of dropping
pub const MAX_PENDING_OPENING_MESSAGES: usize = 200;

/// Chats whose in-memory state is kept (tunable). A state with nothing unwritten
/// is rebuilt from the folder when needed (its next `seq` from the last message
/// on disk), so past this the least recently used idle ones are dropped; a chat
/// with unwritten messages, a rename or a task running is never dropped.
pub const CHAT_STATE_CACHE_LIMIT: usize = 64;

/// Foreign-message scans remembered (tunable); a dropped one is scanned again
pub const FOREIGN_SCAN_CACHE_LIMIT: usize = 512;
const DEFAULT_OPEN_LIMIT: f64 = 200.0;
const MAX_OPEN_LIMIT: f64 = 10_000.0;
const TAIL_READ_BYTES: u64 = 8 * 1024 * 1024;
const TAIL_HARD_CAP_BYTES: u64 = 64 * 1024 * 1024;

fn chats_dir() -> &'static str {
    project_folder_name("chatsDir")
}

fn chat_info_ext() -> &'static str {
    project_folder_name("chatInfoExt")
}

fn chat_messages_ext() -> &'static str {
    project_folder_name("chatMessagesExt")
}

/// `chatPath(dataDir, name)`: `<data folder>/chats/<name>` as path segments below the project root
fn chat_path(data_dir: &str, name: &str) -> [String; 3] {
    [data_dir.to_owned(), chats_dir().to_owned(), name.to_owned()]
}

/// `${chatId}${ext}` of the chat's info file
fn info_name(chat_id: &str) -> String {
    format!("{chat_id}{}", chat_info_ext())
}

/// `${chatId}${ext}` of the chat's messages file
fn messages_name(chat_id: &str) -> String {
    format!("{chat_id}{}", chat_messages_ext())
}

/// `infoRel(chatId)`
fn info_rel(chat_id: &str) -> String {
    format!("{}/{}", chats_dir(), info_name(chat_id))
}

/// `messagesRel(chatId)`
fn messages_rel(chat_id: &str) -> String {
    format!("{}/{}", chats_dir(), messages_name(chat_id))
}

/// What the TypeScript throws (an `Error` with this message)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatStoreError(pub String);

impl ChatStoreError {
    fn new(message: impl Into<String>) -> Self {
        ChatStoreError(message.into())
    }
}

impl std::fmt::Display for ChatStoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "Error: {}", self.0)
    }
}

impl std::error::Error for ChatStoreError {}

/// The `change` of `ChatStoreGuide::update_data`: the current text and the
/// install id supplier to the text to write (`None`: write nothing)
pub type ChatDataChange<'r> =
    &'r mut dyn FnMut(Option<&str>, &mut dyn FnMut() -> String) -> Option<String>;

/// `ChatStoreGuide`: the guide calls the chat store uses. A path is `None`
/// (`null`) where the guide knows no such project or the path is refused.
pub trait ChatStoreGuide {
    /// `appendData(id, relPath, text, dataDir)`
    fn append_data(
        &mut self,
        id: &str,
        rel_path: &str,
        text: &str,
        data_dir: Option<&str>,
    ) -> ProjectWriteResult;

    /// `updateData(id, relPath, change, dataDir)`. `change` takes the file's
    /// text (`None` when absent) and answers the text to write (`None`: write
    /// nothing). Its second argument is `() => this.guide.installId()`, for a
    /// change that needs the install id while the guide holds the write: the
    /// TypeScript calls the guide from inside `change`.
    fn update_data(
        &mut self,
        id: &str,
        rel_path: &str,
        change: ChatDataChange<'_>,
        data_dir: Option<&str>,
    ) -> DataUpdateOutcome;

    /// `dataPath(id, relPath, dataDir)`
    fn data_path(&mut self, id: &str, rel_path: &str, data_dir: Option<&str>) -> Option<String>;

    /// `installId()`
    fn install_id(&mut self) -> String;

    /// `trustState(id)`
    fn trust_state(&mut self, id: &str) -> ProjectTrustState;

    /// `isUnwritable(id)`
    fn is_unwritable(&mut self, id: &str) -> bool;

    /// `markUnwritable(id)`
    fn mark_unwritable(&mut self, id: &str);

    /// `projectRoot(id)`
    fn project_root(&mut self, id: &str) -> Option<String>;

    /// `recordOutsideChat(docPath, projectId, chatId)`; `Err` carries the
    /// message of what it throws
    fn record_outside_chat(
        &mut self,
        doc_path: &str,
        project_id: &str,
        chat_id: &str,
    ) -> Result<(), String>;

    /// `documentRelativePath(id, docPath)`
    fn document_relative_path(&mut self, id: &str, doc_path: &str) -> Option<String>;

    /// `getSelection(target)`
    fn get_selection(&mut self, target: &SelectionTarget) -> ProjectSelection;
}

/// What `ProjectChatStoreDeps` and the console give the store
pub trait ChatStoreHost {
    /// `deps.trash(absPath)`: moves one file to the OS trash; `Err` carries
    /// the message of what it throws
    fn trash(&mut self, abs_path: &str) -> Result<(), String>;

    /// `deps.now().toISOString()`
    fn now_iso(&mut self) -> String;

    /// `deps.newId()`: a new chat id; must match `PROJECT_ID_PATTERN`. The
    /// default of the TypeScript is [`default_new_id`] over 12 random bytes.
    fn new_id(&mut self) -> String;

    /// `console.warn(label, error)`, `detail` being the message of the error
    /// (`None` for a call with the label alone)
    fn warn(&mut self, label: &str, detail: Option<&str>);
}

/// `defaultNewId()` of 12 bytes `randomBytes(12)` gave: `toString('base64url')`
pub fn default_new_id(random: &[u8; 12]) -> String {
    base64(random)
        .trim_end_matches('=')
        .replace('+', "-")
        .replace('/', "_")
}

/// Who records a message: the window's editor and its document, as main identified them
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSender {
    /// Checked against `PROJECT_EDITORS` by `append`, as the TypeScript checks it
    pub editor: String,
    /// The window's saved document (absolute path); `None` (`null`) for the home panel and untitled documents
    pub doc_path: Option<String>,
    /// Opaque tag handed back to append listeners (for example the sending window), never stored
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<JsonValue>,
}

/// One message as stored or read: a JSON object whose keys keep their order
pub type ChatRecord = JsObject<JsonValue>;

/// `ProjectChatAppendedEvent`, with the message as stored
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAppendedEvent {
    pub project_id: ProjectId,
    pub chat_id: ProjectId,
    pub message: ChatRecord,
}

/// `ChatAppendedListener`; `Err` carries the message of what it throws (the
/// store warns and goes on)
pub trait ChatAppendedListener {
    fn appended(&mut self, event: &ChatAppendedEvent, sender: &ChatSender) -> Result<(), String>;
}

/// What `onAppended` answered: hand it to [`ProjectChatStore::off_appended`]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListenerId(u64);

/// `ProjectChatStoreDeps` but the guide and the host
#[derive(Debug, Clone, Default)]
pub struct ChatStoreOptions {
    /// default `process.platform`
    pub platform: Option<String>,
    /// default [`CHAT_STATE_CACHE_LIMIT`]
    pub state_cache_limit: Option<f64>,
    /// default [`FOREIGN_SCAN_CACHE_LIMIT`]
    pub foreign_cache_limit: Option<f64>,
}

/// Chat info as read: the object of the file with the fields the app uses
/// made well-formed, any other key kept as it was
#[derive(Debug, Clone, PartialEq)]
pub struct ChatInfo(JsObject<JsonValue>);

impl Serialize for ChatInfo {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.0.serialize(serializer)
    }
}

impl ChatInfo {
    fn text(&self, key: &str) -> &str {
        match self.0.get(key) {
            Some(JsonValue::String(text)) => text,
            _ => "",
        }
    }

    pub fn id(&self) -> &str {
        self.text("id")
    }

    pub fn project_id(&self) -> &str {
        self.text("projectId")
    }

    pub fn title(&self) -> &str {
        self.text("title")
    }

    pub fn updated_at(&self) -> &str {
        self.text("updatedAt")
    }

    pub fn origin(&self) -> &str {
        self.text("origin")
    }

    pub fn last_editor(&self) -> ProjectEditor {
        project_editor(self.text("lastEditor"))
    }

    pub fn documents(&self) -> Vec<String> {
        match self.0.get("documents") {
            Some(JsonValue::Array(items)) => items
                .iter()
                .filter_map(|item| match item {
                    JsonValue::String(text) => Some(text.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    /// The info as the JSON object it is
    pub fn to_json(&self) -> JsonValue {
        JsonValue::Object(self.0.clone())
    }
}

/// The editor a `PROJECT_EDITORS` name stands for, `home` for any other
fn project_editor(name: &str) -> ProjectEditor {
    match name {
        "docs" => ProjectEditor::Docs,
        "sheets" => ProjectEditor::Sheets,
        "slides" => ProjectEditor::Slides,
        "pdf" => ProjectEditor::Pdf,
        "markdown" => ProjectEditor::Markdown,
        "html" => ProjectEditor::Html,
        "mindmap" => ProjectEditor::Mindmap,
        "hwp" => ProjectEditor::Hwp,
        "epub" => ProjectEditor::Epub,
        _ => ProjectEditor::Home,
    }
}

/// `OpenProjectChatResult`, with the messages as stored
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum OpenChatOutcome {
    Ok {
        info: ChatInfo,
        messages: Vec<ChatRecord>,
        foreign: bool,
    },
    NotFound,
}

/// `AppendProjectChatResult`, with the message as stored
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum AppendOutcome {
    Saved { message: ChatRecord },
    Pending { message: ChatRecord },
    Unwritable,
}

#[derive(Clone)]
struct PendingEntry {
    message: ChatRecord,
    /// The sender's document relative to the project folder, when inside it
    doc_rel: Option<String>,
    /// The sender's document when it is outside the project folder
    outside_doc: Option<String>,
    sender: ChatSender,
}

struct ChatState {
    /// The data folder name this state was read from; its writes go there too
    data_dir: String,
    next_seq: f64,
    /// The chat has a file (info or messages) in the folder
    materialized: bool,
    /// The info file names another project id (a copied folder's chat)
    other_project: bool,
    /// Messages with a seq that are not on disk yet (before the first reply, or unwritable)
    pending: Vec<PendingEntry>,
    /// Messages on disk whose effect on the info (time, editor, documents, title) is not written yet
    unrecorded: Vec<PendingEntry>,
    /// Documents attached before the info could take them
    attach_docs: Vec<String>,
    /// A rename not written yet
    title: Option<String>,
}

struct ListedChat {
    info: ChatInfo,
    foreign: bool,
}

/// A foreign-message scan, valid while size and mtime stay the same
struct ForeignScan {
    size: u64,
    mtime_ms: f64,
    foreign: bool,
}

/// The chat a task serves: its project, its id and the project's folder
struct Chat<'a> {
    project_id: &'a str,
    chat_id: &'a str,
    root: &'a str,
}

fn assert_valid_id(value: &str, kind: &str) -> Result<(), ChatStoreError> {
    if is_valid_project_id(value) {
        Ok(())
    } else {
        Err(ChatStoreError::new(format!("invalid {kind}")))
    }
}

/// `assertId(value, kind)` of a value the renderer sent
fn assert_id(value: Option<&JsonValue>, kind: &str) -> Result<String, ChatStoreError> {
    match value {
        Some(JsonValue::String(text)) if is_valid_project_id(text) => Ok(text.clone()),
        _ => Err(ChatStoreError::new(format!("invalid {kind}"))),
    }
}

fn is_editor(value: &str) -> bool {
    PROJECT_EDITORS.contains(&value)
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `value[key]` of an object or an array (an array has none of the keys read here)
fn prop<'a>(value: &'a JsonValue, key: &str) -> Option<Cow<'a, JsonValue>> {
    value.get(key)
}

fn str_prop(value: &JsonValue, key: &str) -> Option<String> {
    match prop(value, key).as_deref() {
        Some(JsonValue::String(text)) => Some(text.clone()),
        _ => None,
    }
}

/// `typeof value === 'object' && value` (an array is one)
fn is_object_like(value: &JsonValue) -> bool {
    matches!(value, JsonValue::Object(_) | JsonValue::Array(_))
}

/// `clamp(value, max)`: a string cut to `max` UTF-16 code units, else `''`
fn clamp(value: Option<String>, max: usize) -> String {
    match value {
        Some(text) => slice_utf16(&text, 0.0, Some(max as f64)),
        None => String::new(),
    }
}

/// `toolFieldText(value)`: providers hand tool input/output over as objects as often as text
fn tool_field_text(value: &JsonValue) -> String {
    let text = match value {
        JsonValue::String(text) => text.clone(),
        other => json_stringify(other),
    };
    slice_utf16(&text, 0.0, Some(TOOL_FIELD_MAX_CHARS as f64))
}

fn string_value(text: String) -> JsonValue {
    JsonValue::String(text)
}

/// `toolsOf(value)`
fn tools_of(value: Option<&JsonValue>) -> Vec<JsonValue> {
    let Some(JsonValue::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|tool| is_object_like(tool))
        .take(MAX_TOOLS_PER_MESSAGE)
        .map(|tool| {
            let mut out = JsObject::new();
            out.set(
                "name",
                string_value(clamp(str_prop(tool, "name"), TOOL_NAME_MAX_CHARS)),
            );
            out.set(
                "summary",
                string_value(clamp(str_prop(tool, "summary"), TOOL_SUMMARY_MAX_CHARS)),
            );
            if let Some(JsonValue::Bool(flag)) = prop(tool, "isError").as_deref() {
                out.set("isError", JsonValue::Bool(*flag));
            }
            if let Some(input) = prop(tool, "input") {
                out.set("input", string_value(tool_field_text(&input)));
            }
            if let Some(output) = prop(tool, "output") {
                out.set("output", string_value(tool_field_text(&output)));
            }
            JsonValue::Object(out)
        })
        .collect()
}

/// `attachmentsOf(value)`
fn attachments_of(value: Option<&JsonValue>) -> Vec<JsonValue> {
    let Some(JsonValue::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|item| is_object_like(item))
        .take(MAX_ATTACHMENTS_PER_MESSAGE)
        .map(|item| {
            let mut out = JsObject::new();
            out.set(
                "name",
                string_value(clamp(str_prop(item, "name"), ATTACHMENT_FIELD_MAX_CHARS)),
            );
            if let Some(path) = str_prop(item, "path") {
                out.set(
                    "path",
                    string_value(clamp(Some(path), ATTACHMENT_FIELD_MAX_CHARS)),
                );
            }
            if let Some(ext) = str_prop(item, "ext") {
                out.set(
                    "ext",
                    string_value(clamp(Some(ext), ATTACHMENT_FIELD_MAX_CHARS)),
                );
            }
            if let Some(JsonValue::Number(size)) = prop(item, "sizeBytes").as_deref()
                && size.is_finite()
            {
                out.set("sizeBytes", JsonValue::Number(*size));
            }
            JsonValue::Object(out)
        })
        .collect()
}

/// `skillChipsOf(value)`: skill chips are references (id, source, title); malformed entries are dropped
fn skill_chips_of(value: Option<&JsonValue>) -> Vec<JsonValue> {
    let Some(JsonValue::Array(items)) = value else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in items {
        if out.len() >= MAX_SKILLS_PER_MESSAGE {
            break;
        }
        if !is_object_like(entry) {
            continue;
        }
        let Some(id) = str_prop(entry, "id") else {
            continue;
        };
        if id.is_empty() || utf16_len(&id) > SKILL_ID_MAX_CHARS {
            continue;
        }
        let mut chip = JsObject::new();
        chip.set("id", string_value(id));
        chip.set(
            "source",
            string_value(clamp(str_prop(entry, "source"), SKILL_FIELD_MAX_CHARS)),
        );
        chip.set(
            "title",
            string_value(clamp(str_prop(entry, "title"), SKILL_FIELD_MAX_CHARS)),
        );
        out.push(JsonValue::Object(chip));
    }
    out
}

/// The fields `buildMessage` takes besides the arguments
struct MessageFields {
    seq: f64,
    ts: String,
    editor: String,
    origin: String,
    file_ref: Option<String>,
}

/// `buildMessage(args, fields)`: one message as stored, capped as project-store caps it
fn build_message(args: &JsonValue, fields: MessageFields) -> ChatRecord {
    let args_text = str_prop(args, "text").unwrap_or_default();
    let text = if utf16_len(&args_text) > TEXT_MAX_CHARS {
        slice_utf16(&args_text, 0.0, Some(TEXT_MAX_CHARS as f64)) + TEXT_TRUNCATED_MARK
    } else {
        args_text
    };
    let mut message = JsObject::new();
    message.set("seq", JsonValue::Number(fields.seq));
    message.set("ts", string_value(fields.ts));
    message.set(
        "role",
        string_value(str_prop(args, "role").unwrap_or_default()),
    );
    message.set("text", string_value(text));
    message.set("editor", string_value(fields.editor));
    message.set("origin", string_value(fields.origin));
    if let Some(file_ref) = fields.file_ref {
        message.set("fileRef", string_value(file_ref));
    }
    let tools = tools_of(prop(args, "tools").as_deref());
    if !tools.is_empty() {
        message.set("tools", JsonValue::Array(tools));
    }
    if let Some(attachments) = prop(args, "attachments") {
        message.set(
            "attachments",
            JsonValue::Array(attachments_of(Some(&*attachments))),
        );
    }
    if let Some(scope) = prop(args, "scope")
        && is_object_like(&scope)
    {
        let mut out = JsObject::new();
        out.set(
            "label",
            string_value(clamp(str_prop(&scope, "label"), SCOPE_LABEL_MAX_CHARS)),
        );
        if let Some(text) = str_prop(&scope, "text") {
            out.set(
                "text",
                string_value(slice_utf16(&text, 0.0, Some(SCOPE_TEXT_MAX_CHARS as f64))),
            );
        }
        message.set("scope", JsonValue::Object(out));
    }
    if let Some(skills) = prop(args, "skills") {
        let skills = skill_chips_of(Some(&*skills));
        if !skills.is_empty() {
            message.set("skills", JsonValue::Array(skills));
        }
    }
    message
}

/// `oneLine(text, max)`: one line of text, whitespace collapsed, at most `max` characters
pub fn one_line(text: &str, max: usize) -> String {
    let mut collapsed = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if is_js_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let cut: String = trim(&collapsed).chars().take(max).collect();
    trim(&cut).to_owned()
}

/// `parseRecords(raw)`: lenient; broken lines and records without a finite seq, a role or a text are skipped
fn parse_records(raw: &str) -> Vec<ChatRecord> {
    let mut out = Vec::new();
    for line in raw.split('\n') {
        if trim(line).is_empty() {
            continue;
        }
        let Ok(JsonValue::Object(record)) = json_parse(line) else {
            continue;
        };
        let finite_seq =
            matches!(record.get("seq"), Some(JsonValue::Number(seq)) if seq.is_finite());
        let role = matches!(record.get("role"), Some(JsonValue::String(_)));
        let text = matches!(record.get("text"), Some(JsonValue::String(_)));
        if finite_seq && role && text {
            out.push(record);
        }
    }
    out
}

/// `record.seq` of a record that has a finite one
fn seq_of(record: &ChatRecord) -> f64 {
    match record.get("seq") {
        Some(JsonValue::Number(seq)) => *seq,
        _ => f64::NAN,
    }
}

/// `handle.read(buffer, 0, length, position)`: one read at a position
fn read_at(file: &File, buffer: &mut [u8], position: u64) -> io::Result<usize> {
    let mut file = file;
    file.seek(SeekFrom::Start(position))?;
    file.read(buffer)
}

/// `readTail(path)`: the text of the last 8 MiB of a chat file, starting at a line boundary. A record
/// longer than that widens the window up to 64 MiB; with no boundary even then the
/// chat reads as empty (same as project-store).
fn read_tail<H: ChatStoreHost>(host: &mut H, path: &str) -> Result<String, NodeError> {
    let file = File::open(namespaced(path)).map_err(|error| node_error(&error, "open", path))?;
    let size = file
        .metadata()
        .map_err(|error| node_error_fd(&error, "fstat"))?
        .len();
    if size == 0 {
        return Ok(String::new());
    }
    let mut length = size.min(TAIL_READ_BYTES - 1);
    loop {
        let start = size - length;
        let mut buffer = vec![0u8; length as usize];
        let bytes_read =
            read_at(&file, &mut buffer, start).map_err(|error| node_error_fd(&error, "read"))?;
        let window = &buffer[..bytes_read];
        if start == 0 {
            return Ok(String::from_utf8_lossy(window).into_owned());
        }
        let mut before = [0u8; 1];
        read_at(&file, &mut before, start - 1).map_err(|error| node_error_fd(&error, "read"))?;
        if before[0] == 0x0a {
            return Ok(String::from_utf8_lossy(window).into_owned());
        }
        let newline = window.iter().position(|byte| *byte == 0x0a);
        // A newline only at the very end means the window is one oversized record
        if let Some(newline) = newline
            && (newline as i64) < bytes_read as i64 - 1
        {
            return Ok(String::from_utf8_lossy(&window[newline + 1..]).into_owned());
        }
        if length >= TAIL_HARD_CAP_BYTES {
            host.warn(
                &format!("[projects] no record boundary in the last {length} bytes of {path}"),
                None,
            );
            return Ok(String::new());
        }
        length = size.min(length * 2).min(TAIL_HARD_CAP_BYTES);
    }
}

/// `lacksFinalNewline(path)`: whether a non-empty file does not end with a newline (a cut last line)
fn lacks_final_newline(path: &str) -> io::Result<bool> {
    let file = File::open(namespaced(path))?;
    let size = file.metadata()?.len();
    if size == 0 {
        return Ok(false);
    }
    let mut last = [0u8; 1];
    read_at(&file, &mut last, size - 1)?;
    Ok(last[0] != 0x0a)
}

/// `normalizeLimit(limit)`
fn normalize_limit(limit: Option<&JsonValue>) -> usize {
    let limit = match limit {
        Some(JsonValue::Number(limit)) if limit.is_finite() => {
            MAX_OPEN_LIMIT.min(math_max(1.0, limit.floor()))
        }
        _ => DEFAULT_OPEN_LIMIT,
    };
    limit as usize
}

/// `parseInfo(text, chatId)`: chat info as read (lenient); `None` when absent, broken, or named for another id
fn parse_info(text: Option<&str>, chat_id: &str) -> Option<ChatInfo> {
    let text = text?;
    let Ok(JsonValue::Object(raw)) = json_parse(text) else {
        return None;
    };
    match raw.get("id") {
        Some(JsonValue::String(id)) if id == chat_id => {}
        _ => return None,
    }
    let project_id = match raw.get("projectId") {
        Some(JsonValue::String(project_id)) if is_valid_project_id(project_id) => {
            project_id.clone()
        }
        _ => return None,
    };
    let text_of = |key: &str| match raw.get(key) {
        Some(JsonValue::String(value)) => value.clone(),
        _ => String::new(),
    };
    let last_editor = match raw.get("lastEditor") {
        Some(JsonValue::String(editor)) if is_editor(editor) => editor.clone(),
        _ => "home".to_owned(),
    };
    let documents = match raw.get("documents") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter(|item| matches!(item, JsonValue::String(_)))
            .cloned()
            .collect(),
        _ => Vec::new(),
    };
    let mut info = raw.clone();
    info.set(
        "version",
        JsonValue::Number(f64::from(PROJECT_FORMAT_VERSION)),
    );
    info.set("id", string_value(chat_id.to_owned()));
    info.set("projectId", string_value(project_id));
    info.set("title", string_value(text_of("title")));
    info.set("createdAt", string_value(text_of("createdAt")));
    info.set("updatedAt", string_value(text_of("updatedAt")));
    info.set("origin", string_value(text_of("origin")));
    info.set("lastEditor", string_value(last_editor));
    info.set("documents", JsonValue::Array(documents));
    Some(ChatInfo(info))
}

/// `infoText(info)`
fn info_text(info: &ChatInfo) -> String {
    format!(
        "{}\n",
        json_stringify_pretty(&JsonValue::Object(info.0.clone()), 2)
    )
}

/// `JSON.stringify(message)`
fn record_json(record: &ChatRecord) -> String {
    json_stringify(&JsonValue::Object(record.clone()))
}

/// A string of a record (`""` where it holds none)
fn record_str(record: &ChatRecord, key: &str) -> String {
    match record.get(key) {
        Some(JsonValue::String(text)) => text.clone(),
        _ => String::new(),
    }
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

/// `info.mtimeMs` of `lstat`
fn mtime_ms(meta: &Metadata) -> f64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.mtime() as f64 * 1e3 + meta.mtime_nsec() as f64 / 1e6
    }
    #[cfg(not(unix))]
    {
        meta.modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |since| {
                since.as_secs() as f64 * 1e3 + f64::from(since.subsec_nanos()) / 1e6
            })
    }
}

/// `lstat(path).catch(() => null)`
fn lstat_or_null(path: &str) -> Option<Metadata> {
    std::fs::symlink_metadata(namespaced(path)).ok()
}

/// `!root` of a path the guide answered: `null` and `''` both
fn non_empty(path: Option<String>) -> Option<String> {
    path.filter(|path| !path.is_empty())
}

/// `sameRel(a, b)`
fn same_rel(platform: &str, a: &str, b: &str) -> bool {
    let norm = |value: &str| {
        let plain = nfc(&value.replace('\\', "/"));
        if platform == "win32" || platform == "darwin" {
            plain.to_lowercase()
        } else {
            plain
        }
    };
    norm(a) == norm(b)
}

/// `moveToEnd(documents, rel)`: `documents` with `rel` moved (or added) to the end
fn move_to_end(platform: &str, documents: &[String], rel: &str) -> Vec<String> {
    let mut out: Vec<String> = documents
        .iter()
        .filter(|item| !same_rel(platform, item, rel))
        .cloned()
        .collect();
    out.push(rel.to_owned());
    out
}

fn string_array(items: &[String]) -> JsonValue {
    JsonValue::Array(items.iter().cloned().map(JsonValue::String).collect())
}

/// `ProjectChatStore`: the chats of the project folders, their state and caches
pub struct ProjectChatStore<G, H> {
    guide: G,
    host: H,
    platform: String,
    /// Chat states by `<projectId>/<chatId>`, the most recently used last
    states: JsMap<ChatState>,
    listeners: Vec<(u64, Box<dyn ChatAppendedListener>)>,
    next_listener: u64,
    /// Foreign-message scans by file, the most recently used last
    foreign_cache: JsMap<ForeignScan>,
    /// Outside documents already recorded this run (document + project -> chat)
    outside_recorded: JsMap<ProjectId>,
    state_limit: f64,
    foreign_limit: f64,
}

impl<G: ChatStoreGuide, H: ChatStoreHost> ProjectChatStore<G, H> {
    /// `new ProjectChatStore(deps)`
    pub fn new(guide: G, host: H, options: ChatStoreOptions) -> Self {
        ProjectChatStore {
            guide,
            host,
            platform: options
                .platform
                .unwrap_or_else(|| process_platform().to_owned()),
            states: JsMap::new(),
            listeners: Vec::new(),
            next_listener: 0,
            foreign_cache: JsMap::new(),
            outside_recorded: JsMap::new(),
            state_limit: math_max(
                1.0,
                options
                    .state_cache_limit
                    .unwrap_or(CHAT_STATE_CACHE_LIMIT as f64),
            ),
            foreign_limit: math_max(
                1.0,
                options
                    .foreign_cache_limit
                    .unwrap_or(FOREIGN_SCAN_CACHE_LIMIT as f64),
            ),
        }
    }

    /// `heldStateCount()`: how many chat states are held now (for tests)
    pub fn held_state_count(&self) -> usize {
        self.states.len()
    }

    /// `heldForeignScanCount()`: how many foreign-message scans are remembered now (for tests)
    pub fn held_foreign_scan_count(&self) -> usize {
        self.foreign_cache.len()
    }

    /// nothing of this chat waits in memory (no task for it is running or
    /// queued either: see the module)
    fn is_idle(state: &ChatState) -> bool {
        state.pending.is_empty()
            && state.unrecorded.is_empty()
            && state.attach_docs.is_empty()
            && state.title.is_none()
    }

    /// `trimStates(keep)`: drops the least recently used idle states past the
    /// limit. The state being served (`keep`) is held by the caller, outside
    /// the map, and counts as one of the states held.
    fn trim_states(&mut self) {
        if (self.states.len() + 1) as f64 <= self.state_limit {
            return;
        }
        let keys: Vec<String> = self.states.keys().map(str::to_owned).collect();
        for key in keys {
            if (self.states.len() + 1) as f64 <= self.state_limit {
                break;
            }
            if self.states.get(&key).is_some_and(Self::is_idle) {
                self.states.delete(&key);
            }
        }
    }

    // ────────────────────────── events ──────────────────────────

    /// `onAppended(listener)`: called once per message after it was written to the folder
    pub fn on_appended(&mut self, listener: Box<dyn ChatAppendedListener>) -> ListenerId {
        self.next_listener += 1;
        self.listeners.push((self.next_listener, listener));
        ListenerId(self.next_listener)
    }

    /// The unsubscribe `onAppended` returns
    pub fn off_appended(&mut self, id: ListenerId) {
        self.listeners.retain(|(listener, _)| *listener != id.0);
    }

    fn emit(&mut self, project_id: &str, chat_id: &str, entries: &[PendingEntry]) {
        for entry in entries {
            let event = ChatAppendedEvent {
                project_id: project_id.to_owned(),
                chat_id: chat_id.to_owned(),
                message: entry.message.clone(),
            };
            for (_, listener) in &mut self.listeners {
                if let Err(error) = listener.appended(&event, &entry.sender) {
                    self.host
                        .warn("[projects] chat append listener failed:", Some(&error));
                }
            }
        }
    }

    // ────────────────────────── helpers ──────────────────────────

    fn root_of(&mut self, project_id: &str) -> Result<String, ChatStoreError> {
        non_empty(self.guide.project_root(project_id))
            .ok_or_else(|| ChatStoreError::new(format!("unknown project {project_id}")))
    }

    /// The chat's state, read from the data folder in use now. A state read from the
    /// other folder (an older version made the old-named one meanwhile) is dropped and
    /// the chat read again, so its numbering never runs on across two folders; nothing
    /// is copied or moved. A chat with nothing on disk yet keeps its unsaved opening
    /// messages: there is nothing to split.
    ///
    /// The state is handed to the caller, out of the map, for the task it serves;
    /// [`Self::check_in`] puts it back as the most recently used.
    fn state(&mut self, chat: &Chat<'_>) -> ChatState {
        let key = format!("{}/{}", chat.project_id, chat.chat_id);
        let data_dir = data_dir_name(chat.root);
        let known = self.states.delete(&key);
        let (state, moved) = match known {
            Some(known) if known.data_dir == data_dir => (known, false),
            known => {
                let read = self.read_state(chat, &data_dir);
                match known {
                    Some(mut known) if !known.materialized && !read.materialized => {
                        known.data_dir = data_dir;
                        (known, true)
                    }
                    _ => (read, true),
                }
            }
        };
        if moved {
            self.trim_states();
        }
        state
    }

    /// Puts the state a task served back, most recently used last
    fn check_in(&mut self, chat: &Chat<'_>, state: ChatState) {
        let key = format!("{}/{}", chat.project_id, chat.chat_id);
        self.states.set(key, state);
    }

    fn read_state(&mut self, chat: &Chat<'_>, data_dir: &str) -> ChatState {
        let messages_path = plain_file_in(
            chat.root,
            &chat_path(data_dir, &messages_name(chat.chat_id)),
        );
        let raw_info = read_folder_text(chat.root, &chat_path(data_dir, &info_name(chat.chat_id)));
        let info = parse_info(raw_info.as_deref(), chat.chat_id);
        let mut max_seq = -1.0;
        if let Some(path) = &messages_path {
            match read_tail(&mut self.host, path) {
                Ok(text) => {
                    for record in parse_records(&text) {
                        max_seq = math_max(max_seq, seq_of(&record));
                    }
                }
                Err(error) => self.host.warn(
                    &format!("[projects] cannot read chat {}:", chat.chat_id),
                    Some(&error.message),
                ),
            }
        }
        ChatState {
            data_dir: data_dir.to_owned(),
            next_seq: max_seq + 1.0,
            materialized: messages_path.is_some() || raw_info.is_some(),
            other_project: info
                .as_ref()
                .is_some_and(|info| info.project_id() != chat.project_id),
            pending: Vec::new(),
            unrecorded: Vec::new(),
            attach_docs: Vec::new(),
            title: None,
        }
    }

    fn is_foreign(&mut self, root: &str, data_dir: &str, info: &ChatInfo) -> bool {
        let install_id = self.guide.install_id();
        if info.origin() != install_id {
            return true;
        }
        let Some(path) = plain_file_in(root, &chat_path(data_dir, &messages_name(info.id())))
        else {
            return false;
        };
        let Some(stats) = lstat_or_null(&path) else {
            return false;
        };
        let size = stats.len();
        let mtime = mtime_ms(&stats);
        if let Some(cached) = self.foreign_cache.delete(&path)
            && cached.size == size
            && cached.mtime_ms == mtime
        {
            let foreign = cached.foreign;
            self.foreign_cache.set(path, cached);
            return foreign;
        }
        let foreign = has_foreign_message(root, info.id(), &install_id, Some(data_dir));
        self.foreign_cache.delete(&path);
        self.foreign_cache.set(
            path,
            ForeignScan {
                size,
                mtime_ms: mtime,
                foreign,
            },
        );
        let oldest: Vec<String> = self.foreign_cache.keys().map(str::to_owned).collect();
        for key in oldest {
            if self.foreign_cache.len() as f64 <= self.foreign_limit {
                break;
            }
            self.foreign_cache.delete(&key);
        }
        foreign
    }

    /// `visible(projectId, root, dataDir, chatId)`: the info of a chat the list shows (this project id; not foreign under "without"), else `None`
    fn visible(
        &mut self,
        project_id: &str,
        root: &str,
        data_dir: &str,
        chat_id: &str,
    ) -> Option<ListedChat> {
        let info = parse_info(
            read_folder_text(root, &chat_path(data_dir, &info_name(chat_id))).as_deref(),
            chat_id,
        )?;
        if info.project_id() != project_id {
            return None;
        }
        let foreign = self.is_foreign(root, data_dir, &info);
        if foreign && self.guide.trust_state(project_id) != ProjectTrustState::Use {
            return None;
        }
        Some(ListedChat { info, foreign })
    }

    /// `visibleChats(projectId)`: visible chats, newest `updatedAt` first
    fn visible_chats(&mut self, project_id: &str) -> Vec<ListedChat> {
        let Some(root) = non_empty(self.guide.project_root(project_id)) else {
            return Vec::new();
        };
        let data_dir = data_dir_name(&root);
        let mut out = Vec::new();
        for name in plain_folder_entries(&root, &[data_dir.as_str(), chats_dir()]) {
            let Some(chat_id) = name.strip_suffix(chat_info_ext()) else {
                continue;
            };
            if !is_valid_project_id(chat_id) {
                continue;
            }
            if let Some(chat) = self.visible(project_id, &root, &data_dir, chat_id) {
                out.push(chat);
            }
        }
        sort_by_number(&mut out, |a, b| {
            let newest = locale_compare(b.info.updated_at(), a.info.updated_at());
            if newest != 0.0 {
                newest
            } else {
                locale_compare(a.info.id(), b.info.id())
            }
        });
        out
    }

    /// `writeInfo(projectId, chatId, state)`: writes the info's share of `state`:
    /// time, editor and documents of the messages on disk, documents attached
    /// meanwhile, and a pending rename or automatic title.
    fn write_info(&mut self, chat: &Chat<'_>, state: &mut ChatState) -> ProjectWriteResult {
        let entries = &state.unrecorded;
        let attached = &state.attach_docs;
        let rename = state.title.clone();
        if entries.is_empty() && attached.is_empty() && rename.is_none() {
            return ProjectWriteResult::Ok;
        }
        let entries_len = entries.len();
        let attached_len = attached.len();
        let platform = self.platform.as_str();
        let host = &mut self.host;
        let project_id = chat.project_id;
        let chat_id = chat.chat_id;
        let mut change =
            |current: Option<&str>, install_id: &mut dyn FnMut() -> String| -> Option<String> {
                let parsed = parse_info(current, chat_id);
                if let Some(parsed) = &parsed
                    && parsed.project_id() != project_id
                {
                    return None;
                }
                let at = match entries.first() {
                    Some(entry) => record_str(&entry.message, "ts"),
                    None => host.now_iso(),
                };
                let mut info = match parsed {
                    Some(parsed) => parsed,
                    None => {
                        let mut fresh = JsObject::new();
                        fresh.set(
                            "version",
                            JsonValue::Number(f64::from(PROJECT_FORMAT_VERSION)),
                        );
                        fresh.set("id", string_value(chat_id.to_owned()));
                        fresh.set("projectId", string_value(project_id.to_owned()));
                        fresh.set("title", string_value(String::new()));
                        fresh.set("createdAt", string_value(at.clone()));
                        fresh.set("updatedAt", string_value(at));
                        fresh.set("origin", string_value(install_id()));
                        fresh.set(
                            "lastEditor",
                            string_value(match entries.first() {
                                Some(entry) => record_str(&entry.message, "editor"),
                                None => "home".to_owned(),
                            }),
                        );
                        fresh.set("documents", JsonValue::Array(Vec::new()));
                        ChatInfo(fresh)
                    }
                };
                for entry in entries {
                    info.0
                        .set("updatedAt", string_value(record_str(&entry.message, "ts")));
                    info.0.set(
                        "lastEditor",
                        string_value(record_str(&entry.message, "editor")),
                    );
                    if let Some(doc_rel) = &entry.doc_rel {
                        let documents = move_to_end(platform, &info.documents(), doc_rel);
                        info.0.set("documents", string_array(&documents));
                    }
                }
                for rel in attached {
                    let documents = move_to_end(platform, &info.documents(), rel);
                    info.0.set("documents", string_array(&documents));
                }
                if let Some(rename) = &rename {
                    info.0.set("title", string_value(rename.clone()));
                } else if info.title().is_empty()
                    && let Some(first) = entries
                        .iter()
                        .find(|entry| record_str(&entry.message, "role") == "user")
                {
                    info.0.set(
                        "title",
                        string_value(one_line(
                            &record_str(&first.message, "text"),
                            CHAT_TITLE_CHARS,
                        )),
                    );
                }
                Some(info_text(&info))
            };
        let outcome = self.guide.update_data(
            project_id,
            &info_rel(chat_id),
            &mut change,
            Some(&state.data_dir),
        );
        if matches!(outcome, DataUpdateOutcome::Unwritable) {
            return ProjectWriteResult::Unwritable;
        }
        state.unrecorded = state.unrecorded.split_off(entries_len);
        state.attach_docs = state.attach_docs.split_off(attached_len);
        if state.title == rename {
            state.title = None;
        }
        ProjectWriteResult::Ok
    }

    /// `flush(projectId, chatId, root, state)`: writes every pending message, then the info; emits the written messages
    fn flush(&mut self, chat: &Chat<'_>, state: &mut ChatState) -> ProjectWriteResult {
        let batch_len = state.pending.len();
        if batch_len > 0 {
            let existing = plain_file_in(
                chat.root,
                &chat_path(&state.data_dir, &messages_name(chat.chat_id)),
            );
            let mut prefix = "";
            if let Some(existing) = existing {
                // Unreadable here means the append fails too and reports it.
                if let Ok(true) = lacks_final_newline(&existing) {
                    prefix = "\n";
                }
            }
            let lines: String = state
                .pending
                .iter()
                .map(|entry| format!("{}\n", record_json(&entry.message)))
                .collect();
            let appended = self.guide.append_data(
                chat.project_id,
                &messages_rel(chat.chat_id),
                &format!("{prefix}{lines}"),
                Some(&state.data_dir),
            );
            if appended != ProjectWriteResult::Ok {
                return appended;
            }
            let batch: Vec<PendingEntry> = state.pending.drain(..batch_len).collect();
            state.unrecorded.extend(batch.iter().cloned());
            state.materialized = true;
            self.emit(chat.project_id, chat.chat_id, &batch);
            self.record_outside(chat.project_id, chat.chat_id, &batch);
        }
        self.write_info(chat, state)
    }

    /// `recordOutside(projectId, chatId, entries)`: the last chat of documents outside the folder lives in this PC's settings (spec 4)
    fn record_outside(&mut self, project_id: &str, chat_id: &str, entries: &[PendingEntry]) {
        let mut docs: Vec<&str> = Vec::new();
        for entry in entries {
            if let Some(doc) = &entry.outside_doc
                && !docs.contains(&doc.as_str())
            {
                docs.push(doc);
            }
        }
        for doc in docs {
            let key = format!("{doc}\n{project_id}");
            if self.outside_recorded.get(&key).map(String::as_str) == Some(chat_id) {
                continue;
            }
            match self.guide.record_outside_chat(doc, project_id, chat_id) {
                Ok(()) => self.outside_recorded.set(key, chat_id.to_owned()),
                Err(error) => self.host.warn(
                    "[projects] cannot record the chat of an outside document:",
                    Some(&error),
                ),
            }
        }
    }

    // ────────────────────────── public ──────────────────────────

    /// `newChat(projectId)`: a new chat id for the project; nothing is written until the first assistant reply
    pub fn new_chat(&mut self, project_id: &str) -> Result<ProjectId, ChatStoreError> {
        assert_valid_id(project_id, "project id")?;
        let root = self.root_of(project_id)?;
        let data_dir = data_dir_name(&root);
        loop {
            let chat_id = self.host.new_id();
            if !is_valid_project_id(&chat_id) {
                return Err(ChatStoreError::new("newId produced an invalid chat id"));
            }
            if self.states.has(&format!("{project_id}/{chat_id}")) {
                continue;
            }
            let mut taken = false;
            for rel in [info_rel(&chat_id), messages_rel(&chat_id)] {
                let path = self.guide.data_path(project_id, &rel, Some(&data_dir));
                if let Some(path) = path
                    && lstat_or_null(&path).is_some()
                {
                    taken = true;
                }
            }
            if !taken {
                return Ok(chat_id);
            }
        }
    }

    /// `listChats(projectId)`: the project's chats for the [chat] list: this project id only, newest first, "other PC" marked
    pub fn list_chats(
        &mut self,
        project_id: &str,
    ) -> Result<Vec<ProjectChatListItem>, ChatStoreError> {
        assert_valid_id(project_id, "project id")?;
        Ok(self
            .visible_chats(project_id)
            .into_iter()
            .map(|ListedChat { info, foreign }| ProjectChatListItem {
                id: info.id().to_owned(),
                title: info.title().to_owned(),
                updated_at: info.updated_at().to_owned(),
                last_editor: info.last_editor(),
                foreign,
            })
            .collect())
    }

    /// `chatInfo(ref)`: a visible chat's info (for "open the chat's latest document"), or `None`
    pub fn chat_info(
        &mut self,
        chat_ref: &ProjectChatRef,
    ) -> Result<Option<ChatInfo>, ChatStoreError> {
        assert_valid_id(&chat_ref.project_id, "project id")?;
        assert_valid_id(&chat_ref.chat_id, "chat id")?;
        let Some(root) = non_empty(self.guide.project_root(&chat_ref.project_id)) else {
            return Ok(None);
        };
        let data_dir = data_dir_name(&root);
        Ok(self
            .visible(&chat_ref.project_id, &root, &data_dir, &chat_ref.chat_id)
            .map(|chat| chat.info))
    }

    /// `openChat(args)`: the most recent messages of a visible chat (lenient tail read, unsaved messages of this run included)
    pub fn open_chat(&mut self, args: &JsonValue) -> Result<OpenChatOutcome, ChatStoreError> {
        let project_id = assert_id(prop(args, "projectId").as_deref(), "project id")?;
        let chat_id = assert_id(prop(args, "chatId").as_deref(), "chat id")?;
        let Some(root) = non_empty(self.guide.project_root(&project_id)) else {
            return Ok(OpenChatOutcome::NotFound);
        };
        let limit = normalize_limit(prop(args, "limit").as_deref());
        let data_dir = data_dir_name(&root);
        let Some(chat) = self.visible(&project_id, &root, &data_dir, &chat_id) else {
            return Ok(OpenChatOutcome::NotFound);
        };
        let path = plain_file_in(&root, &chat_path(&data_dir, &messages_name(&chat_id)));
        let mut records: Vec<ChatRecord> = Vec::new();
        if let Some(path) = path {
            match read_tail(&mut self.host, &path) {
                Ok(text) => records = parse_records(&text),
                Err(error) => self.host.warn(
                    &format!("[projects] cannot read chat {chat_id}:"),
                    Some(&error.message),
                ),
            }
        }
        let key = format!("{project_id}/{chat_id}");
        if let Some(held) = self.states.get(&key)
            && held.data_dir == data_dir
        {
            records.extend(held.pending.iter().map(|entry| entry.message.clone()));
        }
        let last_editor = chat.info.text("lastEditor").to_owned();
        let mut messages: Vec<ChatRecord> = records
            .into_iter()
            .map(|mut record| {
                let editor = match record.get("editor") {
                    Some(JsonValue::String(editor)) if is_editor(editor) => editor.clone(),
                    _ => last_editor.clone(),
                };
                let origin = match record.get("origin") {
                    Some(JsonValue::String(origin)) => origin.clone(),
                    _ => String::new(),
                };
                record.set("editor", string_value(editor));
                record.set("origin", string_value(origin));
                record
            })
            .collect();
        sort_by_number(&mut messages, |a, b| seq_of(a) - seq_of(b));
        let start = messages.len().saturating_sub(limit);
        let messages = messages.split_off(start);
        Ok(OpenChatOutcome::Ok {
            info: chat.info,
            messages,
            foreign: chat.foreign,
        })
    }

    /// `append(args, sender)`: record one message. Main fills `seq`, time, `editor`, `origin` and `fileRef` from
    /// the sender and updates the info (`updatedAt`, `lastEditor`, `documents`, title).
    /// Before the first assistant reply the message is held in memory (`pending`). When
    /// the folder cannot be written the message is kept for this run and `unwritable`
    /// is returned; a later append writes it once the folder can be written again.
    pub fn append(
        &mut self,
        args: &JsonValue,
        sender: &ChatSender,
    ) -> Result<AppendOutcome, ChatStoreError> {
        let project_id = assert_id(prop(args, "projectId").as_deref(), "project id")?;
        let chat_id = assert_id(prop(args, "chatId").as_deref(), "chat id")?;
        let role = str_prop(args, "role");
        if role.as_deref() != Some("user") && role.as_deref() != Some("assistant") {
            return Err(ChatStoreError::new("invalid role"));
        }
        if str_prop(args, "text").is_none() {
            return Err(ChatStoreError::new("invalid text"));
        }
        if !is_editor(&sender.editor) {
            return Err(ChatStoreError::new("invalid editor"));
        }
        let doc_path = sender.doc_path.as_deref();
        if let Some(doc_path) = doc_path
            && !is_absolute(doc_path)
        {
            return Err(ChatStoreError::new("expected an absolute document path"));
        }
        let root = self.root_of(&project_id)?;
        let chat = Chat {
            project_id: &project_id,
            chat_id: &chat_id,
            root: &root,
        };
        let mut state = self.state(&chat);
        let result = self.append_task(&chat, args, sender, &mut state);
        self.check_in(&chat, state);
        result
    }

    fn append_task(
        &mut self,
        chat: &Chat<'_>,
        args: &JsonValue,
        sender: &ChatSender,
        state: &mut ChatState,
    ) -> Result<AppendOutcome, ChatStoreError> {
        if state.other_project {
            return Err(ChatStoreError::new(format!(
                "chat {} belongs to another project",
                chat.chat_id
            )));
        }
        let doc_path = sender.doc_path.as_deref().filter(|path| !path.is_empty());
        let doc_rel = match doc_path {
            Some(doc_path) => self.guide.document_relative_path(chat.project_id, doc_path),
            None => None,
        };
        let outside_doc = match (doc_path, &doc_rel) {
            (Some(doc_path), None) => Some(doc_path.to_owned()),
            _ => None,
        };
        let file_ref = doc_rel
            .clone()
            .or_else(|| outside_doc.as_deref().map(|doc| basename(doc, None)));
        let seq = state.next_seq;
        state.next_seq += 1.0;
        let ts = self.host.now_iso();
        let origin = self.guide.install_id();
        let message = build_message(
            args,
            MessageFields {
                seq,
                ts,
                editor: sender.editor.clone(),
                origin,
                file_ref,
            },
        );
        state.pending.push(PendingEntry {
            message: message.clone(),
            doc_rel,
            outside_doc,
            sender: sender.clone(),
        });
        let unwritable = self.guide.is_unwritable(chat.project_id);
        let is_assistant = str_prop(args, "role").as_deref() == Some("assistant");
        if !state.materialized
            && !is_assistant
            && state.pending.len() < MAX_PENDING_OPENING_MESSAGES
        {
            return Ok(if unwritable {
                AppendOutcome::Unwritable
            } else {
                AppendOutcome::Pending { message }
            });
        }
        if unwritable {
            return Ok(AppendOutcome::Unwritable);
        }
        Ok(match self.flush(chat, state) {
            ProjectWriteResult::Ok => AppendOutcome::Saved { message },
            ProjectWriteResult::Unwritable => AppendOutcome::Unwritable,
        })
    }

    /// `renameChat(args)`: rename a chat; the automatic title never replaces it afterwards
    pub fn rename_chat(&mut self, args: &JsonValue) -> Result<ProjectWriteResult, ChatStoreError> {
        let project_id = assert_id(prop(args, "projectId").as_deref(), "project id")?;
        let chat_id = assert_id(prop(args, "chatId").as_deref(), "chat id")?;
        let title = match str_prop(args, "title") {
            Some(title) => one_line(&title, CHAT_TITLE_MAX_CHARS),
            None => String::new(),
        };
        if title.is_empty() {
            return Err(ChatStoreError::new("a chat title cannot be empty"));
        }
        let root = self.root_of(&project_id)?;
        let chat = Chat {
            project_id: &project_id,
            chat_id: &chat_id,
            root: &root,
        };
        let mut state = self.state(&chat);
        let result = if state.other_project {
            ProjectWriteResult::Ok
        } else {
            state.title = Some(title);
            if !state.materialized {
                ProjectWriteResult::Ok
            } else if self.guide.is_unwritable(&project_id) {
                ProjectWriteResult::Unwritable
            } else {
                self.write_info(&chat, &mut state)
            }
        };
        self.check_in(&chat, state);
        Ok(result)
    }

    /// `attachDocument(ref, docPath)`: spec 5.3.6: an untitled document of this project was first saved at `docPath`.
    /// When that is inside the project folder its relative path joins the chat's
    /// `documents` now (or with the chat's first write); elsewhere nothing changes.
    pub fn attach_document(
        &mut self,
        chat_ref: &ProjectChatRef,
        doc_path: &str,
    ) -> Result<ProjectWriteResult, ChatStoreError> {
        let project_id = chat_ref.project_id.as_str();
        let chat_id = chat_ref.chat_id.as_str();
        assert_valid_id(project_id, "project id")?;
        assert_valid_id(chat_id, "chat id")?;
        if !is_absolute(doc_path) {
            return Err(ChatStoreError::new("expected an absolute document path"));
        }
        let root = self.root_of(project_id)?;
        let Some(rel) = self.guide.document_relative_path(project_id, doc_path) else {
            return Ok(ProjectWriteResult::Ok);
        };
        let chat = Chat {
            project_id,
            chat_id,
            root: &root,
        };
        let mut state = self.state(&chat);
        let result = if state.other_project {
            ProjectWriteResult::Ok
        } else {
            state.attach_docs = move_to_end(&self.platform, &state.attach_docs, &rel);
            if !state.materialized {
                ProjectWriteResult::Ok
            } else if self.guide.is_unwritable(project_id) {
                ProjectWriteResult::Unwritable
            } else {
                self.write_info(&chat, &mut state)
            }
        };
        self.check_in(&chat, state);
        Ok(result)
    }

    /// `deleteChat(ref)`: moves both chat files to the OS trash (never deletes them); unsaved messages of the chat go too
    pub fn delete_chat(
        &mut self,
        chat_ref: &ProjectChatRef,
    ) -> Result<ProjectWriteResult, ChatStoreError> {
        let project_id = chat_ref.project_id.as_str();
        let chat_id = chat_ref.chat_id.as_str();
        assert_valid_id(project_id, "project id")?;
        assert_valid_id(chat_id, "chat id")?;
        let root = self.root_of(project_id)?;
        let chat = Chat {
            project_id,
            chat_id,
            root: &root,
        };
        let state = self.state(&chat);
        if state.other_project {
            self.check_in(&chat, state);
            return Ok(ProjectWriteResult::Ok);
        }
        if self.guide.is_unwritable(project_id) {
            self.check_in(&chat, state);
            return Ok(ProjectWriteResult::Unwritable);
        }
        for rel in [info_rel(chat_id), messages_rel(chat_id)] {
            let Some(path) = self
                .guide
                .data_path(project_id, &rel, Some(&state.data_dir))
            else {
                continue;
            };
            let Some(stats) = lstat_or_null(&path) else {
                continue;
            };
            if stats.is_dir() {
                continue;
            }
            if let Err(error) = self.host.trash(&path) {
                self.host.warn(
                    &format!("[projects] cannot move chat {chat_id} to the trash:"),
                    Some(&error),
                );
                self.guide.mark_unwritable(project_id);
                self.check_in(&chat, state);
                return Ok(ProjectWriteResult::Unwritable);
            }
            self.foreign_cache.delete(&path);
        }
        // the state is dropped: it is not put back
        Ok(ProjectWriteResult::Ok)
    }

    /// `chatForDocument(projectId, docPath)`: the chat a document opens with (spec 5.3.1), or `None` for an empty new chat.
    /// Inside the folder: the visible chat with the latest `updatedAt` whose `documents`
    /// holds the document. Outside: the last chat recorded for the document in this
    /// project, while it is still visible. Chats the list hides are never picked.
    pub fn chat_for_document(
        &mut self,
        project_id: &str,
        doc_path: &str,
    ) -> Result<Option<ProjectId>, ChatStoreError> {
        assert_valid_id(project_id, "project id")?;
        if !is_absolute(doc_path) {
            return Err(ChatStoreError::new("expected an absolute document path"));
        }
        let Some(root) = non_empty(self.guide.project_root(project_id)) else {
            return Ok(None);
        };
        let rel = self.guide.document_relative_path(project_id, doc_path);
        if let Some(rel) = rel {
            let chats = self.visible_chats(project_id);
            let platform = self.platform.as_str();
            return Ok(chats
                .iter()
                .find(|chat| {
                    chat.info
                        .documents()
                        .iter()
                        .any(|item| same_rel(platform, item, &rel))
                })
                .map(|chat| chat.info.id().to_owned()));
        }
        let selection = self.guide.get_selection(&SelectionTarget::Document {
            path: doc_path.to_owned(),
        });
        let chat_id = if selection.project_id.as_deref() == Some(project_id) {
            selection.initial_chat_id
        } else {
            None
        };
        let Some(chat_id) = chat_id.filter(|chat_id| is_valid_project_id(chat_id)) else {
            return Ok(None);
        };
        let data_dir = data_dir_name(&root);
        Ok(self
            .visible(project_id, &root, &data_dir, &chat_id)
            .map(|_| chat_id))
    }
}
