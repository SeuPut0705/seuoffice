//! The functions of group `b3-projects`, part `ipc`
//! (tools/main-diff/groups/b3-projects-ipc.ts): `project-ipc.ts` of
//! `apps/shell/src/main/projects/`.
//!
//! `project-ipc.scenario` runs the operations of a world over one
//! [`ProjectIpc`] and the fakes of the world, as the spec describes: each fake
//! answers from the world's `answers` and logs each call as the TypeScript
//! fake of the spec logs it. `project-ipc.<handler>` is one `call` of that
//! handler, then the operations after it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use jscompat::{JsMap, JsObject, JsonValue, json_value_from_serde, json_value_to_serde};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg};
use crate::packages::electron_utils::default_save_dir::Thrown;
use crate::packages::project_store::{
    AddFolderResult, ApplyMemoryConsolidationResult, CreateProjectResult, DecideTrustResult,
    LegacyDocumentChat, PROJECT_FOLDER_CHANNELS, ProjectChatListItem, ProjectChatRef,
    ProjectContextResult, ProjectDetail, ProjectEditor, ProjectId, ProjectListFilesResult,
    ProjectListItem, ProjectMemoryEditResult, ProjectMemoryOp, ProjectReadResult,
    ProjectSearchResult, ProjectSelection, ProjectSettings, ProjectTrustAnswer,
    ProjectTrustDecision, ProjectTrustPrompt, ProjectWriteResult, UndoMemoryConsolidationResult,
};
use crate::shell::projects::chat_store::{ChatAppendedEvent, ChatSender};
use crate::shell::projects::ignore::{IgnoreOptions, compile_ignore};
use crate::shell::projects::project_dialog_text::{ProjectFolderPickPurpose, ProjectTrustChoice};
use crate::shell::projects::project_files::{CloudOnlyResolver, ResolveFailure};
use crate::shell::projects::project_guide::{
    GuideStep, NewProjectRequest, ProjectAiVisibility, SelectionTarget,
};
use crate::shell::projects::project_ipc::{
    AppendedNotice, ChatDocuments, IpcStep, MemoryAuthor, PROJECT_IPC_BAD_REQUEST,
    PROJECT_IPC_UNKNOWN_WINDOW, PageReturnWatch, ProjectIpc, ProjectIpcChats, ProjectIpcDeps,
    ProjectIpcDialogs, ProjectIpcGuide, ProjectIpcHost, ProjectIpcScopes, ProjectIpcTools,
    ProjectSettingsPatch, ProjectWindow, TRUST_RETURN_ARM_MS,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let rest = name.strip_prefix("project-ipc.")?;
    Some(match rest {
        "PROJECT_IPC_BAD_REQUEST" => Ok(Some(Value::from(PROJECT_IPC_BAD_REQUEST))),
        "PROJECT_IPC_UNKNOWN_WINDOW" => Ok(Some(Value::from(PROJECT_IPC_UNKNOWN_WINDOW))),
        "TRUST_RETURN_ARM_MS" => Ok(Some(Value::from(TRUST_RETURN_ARM_MS))),
        "scenario" => scenario_call(args, cx),
        "waitForPageReturn" => page_call(args),
        handler
            if PROJECT_FOLDER_CHANNELS
                .iter()
                .any(|(known, _)| *known == handler) =>
        {
            handler_call(handler, args, cx)
        }
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

// ---------------------------------------------------------------------------
// the world the fakes share
// ---------------------------------------------------------------------------

struct State {
    answers: Map<String, Value>,
    windows: Map<String, Value>,
    gone: Vec<i64>,
    counters: HashMap<String, usize>,
    logs: Vec<Vec<Value>>,
    appended: Vec<AppendedNotice>,
    /// `{ answers?, fail? }` of `resolveCloudOnly`; `None`: the dependency is left out
    cloud: Option<Value>,
}

type Shared = Rc<RefCell<State>>;

fn note(shared: &Shared, line: Vec<Value>) {
    shared.borrow_mut().logs.push(line);
}

/// `String(value)` of a JSON value the spec's `$on` reads
fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(n)) => jscompat::number_to_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(other) => other.to_string(),
    }
}

/// where an entry of `answers` ends: a value, or the trust question it asks
enum Resolved {
    Value(Value),
    /// the `{ $ask: prompt, null, use, without }` entry, whose branch the
    /// answer to the question picks
    Ask(Value),
}

/// the answer an entry gives for a call of `key`, its markers taken apart
/// (`$seq`, `$throw`, `$on`, `$events`), up to an `$ask`; `first` is the entry
/// the walk starts at
fn resolve_from(
    shared: &Shared,
    key: &str,
    args: &[Value],
    first: Value,
) -> Result<Resolved, Thrown> {
    let mut entry = first;
    loop {
        let Value::Object(object) = &entry else {
            return Ok(Resolved::Value(entry));
        };
        if let Some(list) = object.get("$seq") {
            let list = list.as_array().cloned().unwrap_or_default();
            let mut state = shared.borrow_mut();
            let counter = state.counters.entry(key.to_owned()).or_insert(0);
            let at = (*counter).min(list.len().saturating_sub(1));
            *counter += 1;
            drop(state);
            entry = list.get(at).cloned().unwrap_or(Value::Null);
            continue;
        }
        if let Some(message) = object.get("$throw") {
            return Err(Thrown(message.as_str().unwrap_or_default().to_owned()));
        }
        if let Some(on) = object.get("$on") {
            let on = on.as_str().unwrap_or_default();
            let text = match on.strip_prefix('#') {
                Some(index) => {
                    let at: usize = index.parse().unwrap_or(0);
                    match args.get(at) {
                        None => "null".to_owned(),
                        some => js_string(some),
                    }
                }
                None => js_string(args.first().and_then(|first| first.get(on))),
            };
            let map = object.get("map").and_then(Value::as_object);
            let next = map
                .and_then(|map| map.get(&text))
                .or_else(|| object.get("default"));
            let Some(next) = next else {
                return Err(Thrown(format!("no branch for {text} of {key}")));
            };
            entry = next.clone();
            continue;
        }
        if let Some(events) = object.get("$events") {
            let sender = args.get(1).cloned().unwrap_or(Value::Null);
            for item in events.as_array().into_iter().flatten() {
                let event = item.get("event").cloned().unwrap_or(Value::Null);
                let message = match event.get("message") {
                    Some(message) => match json_value_from_serde(message) {
                        JsonValue::Object(object) => object,
                        _ => JsObject::new(),
                    },
                    None => JsObject::new(),
                };
                let text = |name: &str| {
                    event
                        .get(name)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned()
                };
                let from = match item.get("key") {
                    Some(key) => Some(json_value_from_serde(key)),
                    None => sender.get("key").map(json_value_from_serde),
                };
                shared.borrow_mut().appended.push(AppendedNotice {
                    event: ChatAppendedEvent {
                        project_id: text("projectId"),
                        chat_id: text("chatId"),
                        message,
                    },
                    from,
                });
            }
            entry = object.get("then").cloned().unwrap_or(Value::Null);
            continue;
        }
        if object.contains_key("$ask") {
            return Ok(Resolved::Ask(entry));
        }
        return Ok(Resolved::Value(entry));
    }
}

/// the answer an entry of `answers` gives for a call of `key` that cannot ask;
/// `Ok(None)` where the world has no entry
fn resolve(shared: &Shared, key: &str, args: &[Value]) -> Result<Option<Value>, Thrown> {
    let Some(first) = shared.borrow().answers.get(key).cloned() else {
        return Ok(None);
    };
    match resolve_from(shared, key, args, first)? {
        Resolved::Value(value) => Ok(Some(value)),
        Resolved::Ask(_) => Err(Thrown(format!("{key} cannot ask"))),
    }
}

/// an answer of the world as the `T` a method returns
fn from_answer<T: DeserializeOwned>(key: &str, value: Value) -> Result<T, Thrown> {
    serde_json::from_value(value).map_err(|error| Thrown(format!("bad answer for {key}: {error}")))
}

/// One of the fakes: its kind (`guide`, `chats`, ...) and the world
#[derive(Clone)]
struct Fake {
    shared: Shared,
    kind: &'static str,
}

impl Fake {
    fn log(&self, name: &str, mut rest: Vec<Value>) {
        let mut line = vec![Value::from(self.kind), Value::from(name)];
        line.append(&mut rest);
        note(&self.shared, line);
    }

    /// the entry as a `T`; a world with no entry is an error
    fn answer<T: DeserializeOwned>(&self, name: &str, args: &[Value]) -> Result<T, Thrown> {
        let key = format!("{}.{name}", self.kind);
        let Some(value) = resolve(&self.shared, &key, args)? else {
            return Err(Thrown(format!("no answer for {key}")));
        };
        from_answer(&key, value)
    }

    /// a method that answers nothing; an entry is read only to throw
    fn void(&self, name: &str, args: &[Value]) -> Result<(), Thrown> {
        resolve(&self.shared, &format!("{}.{name}", self.kind), args).map(|_| ())
    }

    /// a method that may ask the trust question: its answer, or the question
    /// and the entry the call goes on at
    fn asking<T: DeserializeOwned>(
        &self,
        name: &str,
        args: &[Value],
    ) -> Result<GuideStep<T, FakePending>, Thrown> {
        let key = format!("{}.{name}", self.kind);
        let Some(first) = self.shared.borrow().answers.get(&key).cloned() else {
            return Err(Thrown(format!("no answer for {key}")));
        };
        match resolve_from(&self.shared, &key, args, first)? {
            Resolved::Value(value) => Ok(GuideStep::Done(from_answer(&key, value)?)),
            Resolved::Ask(entry) => {
                let prompt: ProjectTrustPrompt =
                    serde_json::from_value(entry.get("$ask").cloned().unwrap_or(Value::Null))
                        .map_err(|error| Thrown(format!("bad prompt of {key}: {error}")))?;
                Ok(GuideStep::AskTrust {
                    prompt: Box::new(prompt),
                    pending: FakePending {
                        key,
                        args: args.to_vec(),
                        entry,
                    },
                })
            }
        }
    }

    /// the call of `asking` goes on with the person's answer: it is logged and
    /// picks the branch of the entry
    fn resumed<T: DeserializeOwned>(
        &self,
        pending: FakePending,
        answer: ProjectTrustAnswer,
    ) -> Result<T, Thrown> {
        let FakePending { key, args, entry } = pending;
        let name = match answer {
            None => "null",
            Some(ProjectTrustDecision::Use) => "use",
            Some(ProjectTrustDecision::Without) => "without",
        };
        note(
            &self.shared,
            vec![
                Value::from("ask"),
                Value::from(key.as_str()),
                Value::from(name),
            ],
        );
        let Some(next) = entry.get(name) else {
            return Err(Thrown(format!("no branch {name} of {key}")));
        };
        match resolve_from(&self.shared, &key, &args, next.clone())? {
            Resolved::Value(value) => from_answer(&key, value),
            Resolved::Ask(_) => Err(Thrown(format!("{key} asked twice"))),
        }
    }
}

fn text(value: &str) -> Value {
    Value::from(value)
}

fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

fn target_json(target: &SelectionTarget) -> Value {
    match target {
        SelectionTarget::Home => json!({ "kind": "home" }),
        SelectionTarget::Document { path } => json!({ "kind": "document", "path": path }),
        SelectionTarget::Untitled { project_id } => {
            json!({ "kind": "untitled", "projectId": project_id })
        }
    }
}

// ---------------------------------------------------------------------------
// the fakes
// ---------------------------------------------------------------------------

/// a guide call that asked the trust question, and the entry it goes on at
struct FakePending {
    key: String,
    args: Vec<Value>,
    entry: Value,
}

struct FakeGuide(Fake);

impl ProjectIpcGuide for FakeGuide {
    type Pending = FakePending;

    fn list_projects(&mut self) -> Result<Vec<ProjectListItem>, Thrown> {
        self.0.log("listProjects", vec![]);
        self.0.answer("listProjects", &[])
    }

    fn add_folder(
        &mut self,
        folder_path: &str,
    ) -> Result<GuideStep<AddFolderResult, FakePending>, Thrown> {
        self.0.log("addFolder", vec![text(folder_path)]);
        self.0.asking("addFolder", &[text(folder_path)])
    }

    fn relocate_project(
        &mut self,
        id: &str,
        folder_path: &str,
    ) -> Result<GuideStep<AddFolderResult, FakePending>, Thrown> {
        let args = [text(id), text(folder_path)];
        self.0.log("relocateProject", args.to_vec());
        self.0.asking("relocateProject", &args)
    }

    fn get_default_parent_folder(&mut self) -> Result<String, Thrown> {
        self.0.log("getDefaultParentFolder", vec![]);
        self.0.answer("getDefaultParentFolder", &[])
    }

    fn create_project(
        &mut self,
        request: &NewProjectRequest,
    ) -> Result<GuideStep<CreateProjectResult, FakePending>, Thrown> {
        let args = [to_json(request)];
        self.0.log("createProject", args.to_vec());
        self.0.asking("createProject", &args)
    }

    fn remove_from_list(&mut self, id: &str) -> Result<(), Thrown> {
        self.0.log("removeFromList", vec![text(id)]);
        self.0.void("removeFromList", &[text(id)])
    }

    fn set_pinned(&mut self, id: &str, pinned: bool) -> Result<(), Thrown> {
        let args = [text(id), Value::from(pinned)];
        self.0.log("setPinned", args.to_vec());
        self.0.void("setPinned", &args)
    }

    fn rename_project(&mut self, id: &str, name: &str) -> Result<ProjectWriteResult, Thrown> {
        let args = [text(id), text(name)];
        self.0.log("renameProject", args.to_vec());
        self.0.answer("renameProject", &args)
    }

    fn retry_unwritable(&mut self, id: &str) -> Result<ProjectWriteResult, Thrown> {
        self.0.log("retryUnwritable", vec![text(id)]);
        self.0.answer("retryUnwritable", &[text(id)])
    }

    /// no case makes the lookup throw: the trait has no error to carry
    fn project_root(&mut self, id: &str) -> Option<String> {
        self.0.log("projectRoot", vec![text(id)]);
        self.0
            .answer::<Option<String>>("projectRoot", &[text(id)])
            .ok()
            .flatten()
    }

    fn get_selection(&mut self, target: &SelectionTarget) -> Result<ProjectSelection, Thrown> {
        let args = [target_json(target)];
        self.0.log("getSelection", args.to_vec());
        self.0.answer("getSelection", &args)
    }

    fn set_selection(
        &mut self,
        target: &SelectionTarget,
        project_id: Option<&str>,
    ) -> Result<ProjectSelection, Thrown> {
        let args = [target_json(target), json!(project_id)];
        self.0.log("setSelection", args.to_vec());
        self.0.answer("setSelection", &args)
    }

    fn adopt_folder_hint(
        &mut self,
        doc_path: &str,
    ) -> Result<GuideStep<AddFolderResult, FakePending>, Thrown> {
        self.0.log("adoptFolderHint", vec![text(doc_path)]);
        self.0.asking("adoptFolderHint", &[text(doc_path)])
    }

    fn read_context(&mut self, id: &str) -> Result<ProjectContextResult, Thrown> {
        self.0.log("readContext", vec![text(id)]);
        self.0.answer("readContext", &[text(id)])
    }

    fn edit_memory(
        &mut self,
        id: &str,
        change: &ProjectMemoryOp,
        by: MemoryAuthor,
    ) -> Result<ProjectMemoryEditResult, Thrown> {
        let args = [text(id), to_json(change), text(by.as_str())];
        self.0.log("editMemory", args.to_vec());
        self.0.answer("editMemory", &args)
    }

    fn save_memory(&mut self, id: &str, text_: &str) -> Result<ProjectWriteResult, Thrown> {
        let args = [text(id), text(text_)];
        self.0.log("saveMemory", args.to_vec());
        self.0.answer("saveMemory", &args)
    }

    fn apply_memory_consolidation(
        &mut self,
        project_id: &str,
        entries: &[JsonValue],
    ) -> Result<ApplyMemoryConsolidationResult, Thrown> {
        let entries: Vec<Value> = entries.iter().map(json_value_to_serde).collect();
        let args = [json!({ "projectId": project_id, "entries": entries })];
        self.0.log("applyMemoryConsolidation", args.to_vec());
        self.0.answer("applyMemoryConsolidation", &args)
    }

    fn undo_memory_consolidation(
        &mut self,
        project_id: &str,
        backup_name: &str,
    ) -> Result<UndoMemoryConsolidationResult, Thrown> {
        let args = [json!({ "projectId": project_id, "backupName": backup_name })];
        self.0.log("undoMemoryConsolidation", args.to_vec());
        self.0.answer("undoMemoryConsolidation", &args)
    }

    fn get_project_detail(&mut self, id: &str) -> Result<ProjectDetail, Thrown> {
        self.0.log("getProjectDetail", vec![text(id)]);
        self.0.answer("getProjectDetail", &[text(id)])
    }

    fn get_settings(&mut self, id: &str) -> Result<ProjectSettings, Thrown> {
        self.0.log("getSettings", vec![text(id)]);
        self.0.answer("getSettings", &[text(id)])
    }

    fn set_settings(
        &mut self,
        id: &str,
        patch: &ProjectSettingsPatch,
    ) -> Result<ProjectSettings, Thrown> {
        let args = [text(id), to_json(patch)];
        self.0.log("setSettings", args.to_vec());
        self.0.answer("setSettings", &args)
    }

    fn decide_trust(
        &mut self,
        id: &str,
        decision: ProjectTrustDecision,
    ) -> Result<GuideStep<DecideTrustResult, FakePending>, Thrown> {
        let args = [text(id), text(decision.as_str())];
        self.0.log("decideTrust", args.to_vec());
        self.0.asking("decideTrust", &args)
    }

    fn save_instructions(&mut self, id: &str, text_: &str) -> Result<ProjectWriteResult, Thrown> {
        let args = [text(id), text(text_)];
        self.0.log("saveInstructions", args.to_vec());
        self.0.answer("saveInstructions", &args)
    }

    fn add_ignore(&mut self, id: &str, rel_path: &str) -> Result<ProjectWriteResult, Thrown> {
        let args = [text(id), text(rel_path)];
        self.0.log("addIgnore", args.to_vec());
        self.0.answer("addIgnore", &args)
    }

    fn remove_ignore(&mut self, id: &str, rel_path: &str) -> Result<ProjectWriteResult, Thrown> {
        let args = [text(id), text(rel_path)];
        self.0.log("removeIgnore", args.to_vec());
        self.0.answer("removeIgnore", &args)
    }

    fn ai_visibility(&mut self, id: &str) -> Result<Option<ProjectAiVisibility>, Thrown> {
        self.0.log("aiVisibility", vec![text(id)]);
        let cfg: Option<Value> = self.0.answer("aiVisibility", &[text(id)])?;
        let Some(cfg) = cfg else {
            return Ok(None);
        };
        let root = cfg
            .get("root")
            .and_then(Value::as_str)
            .ok_or_else(|| Thrown("a visibility needs a root".to_owned()))?;
        let matcher = compile_ignore(
            cfg.get("ignore").and_then(Value::as_str).unwrap_or(""),
            IgnoreOptions {
                case_insensitive: cfg.get("fold").and_then(Value::as_bool).unwrap_or(false),
            },
        )
        .map_err(|error| Thrown(error.to_string()))?;
        Ok(Some(ProjectAiVisibility {
            root: root.to_owned(),
            matcher,
            rule_key: None,
        }))
    }

    fn resume_add_folder(
        &mut self,
        pending: FakePending,
        answer: ProjectTrustAnswer,
    ) -> Result<AddFolderResult, Thrown> {
        self.0.resumed(pending, answer)
    }

    fn resume_create_project(
        &mut self,
        pending: FakePending,
        answer: ProjectTrustAnswer,
    ) -> Result<CreateProjectResult, Thrown> {
        self.0.resumed(pending, answer)
    }

    fn resume_adopt_folder_hint(
        &mut self,
        pending: FakePending,
        answer: ProjectTrustAnswer,
    ) -> Result<AddFolderResult, Thrown> {
        self.0.resumed(pending, answer)
    }

    fn resume_decide_trust(
        &mut self,
        pending: FakePending,
        answer: ProjectTrustAnswer,
    ) -> Result<DecideTrustResult, Thrown> {
        self.0.resumed(pending, answer)
    }
}

struct FakeChats(Fake);

impl ProjectIpcChats for FakeChats {
    fn new_chat(&mut self, project_id: &str) -> Result<ProjectId, Thrown> {
        self.0.log("newChat", vec![text(project_id)]);
        let made: Value = self.0.answer("newChat", &[text(project_id)])?;
        made.get("chatId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| Thrown("newChat answered no chatId".to_owned()))
    }

    fn list_chats(&mut self, project_id: &str) -> Result<Vec<ProjectChatListItem>, Thrown> {
        self.0.log("listChats", vec![text(project_id)]);
        self.0.answer("listChats", &[text(project_id)])
    }

    fn open_chat(&mut self, args: &JsonValue) -> Result<Value, Thrown> {
        let args = [json_value_to_serde(args)];
        self.0.log("openChat", args.to_vec());
        self.0.answer("openChat", &args)
    }

    fn append(&mut self, args: &JsonValue, sender: &ChatSender) -> Result<Value, Thrown> {
        let args = [json_value_to_serde(args), to_json(sender)];
        self.0.log("append", args.to_vec());
        self.0.answer("append", &args)
    }

    fn rename_chat(&mut self, args: &JsonValue) -> Result<ProjectWriteResult, Thrown> {
        let args = [json_value_to_serde(args)];
        self.0.log("renameChat", args.to_vec());
        self.0.answer("renameChat", &args)
    }

    fn delete_chat(&mut self, chat_ref: &ProjectChatRef) -> Result<ProjectWriteResult, Thrown> {
        let args = [to_json(chat_ref)];
        self.0.log("deleteChat", args.to_vec());
        self.0.answer("deleteChat", &args)
    }

    fn attach_document(
        &mut self,
        chat_ref: &ProjectChatRef,
        doc_path: &str,
    ) -> Result<ProjectWriteResult, Thrown> {
        let args = [to_json(chat_ref), text(doc_path)];
        self.0.log("attachDocument", args.to_vec());
        self.0.answer("attachDocument", &args)
    }

    fn chat_for_document(
        &mut self,
        project_id: &str,
        doc_path: &str,
    ) -> Result<Option<ProjectId>, Thrown> {
        let args = [text(project_id), text(doc_path)];
        self.0.log("chatForDocument", args.to_vec());
        self.0.answer("chatForDocument", &args)
    }

    fn chat_info(&mut self, chat_ref: &ProjectChatRef) -> Result<Option<ChatDocuments>, Thrown> {
        let args = [to_json(chat_ref)];
        self.0.log("chatInfo", args.to_vec());
        let info: Option<Value> = self.0.answer("chatInfo", &args)?;
        let Some(info) = info else {
            return Ok(None);
        };
        let documents = info
            .get("documents")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect();
        let last_editor: ProjectEditor =
            serde_json::from_value(info.get("lastEditor").cloned().unwrap_or(Value::Null))
                .map_err(|error| Thrown(format!("bad lastEditor: {error}")))?;
        Ok(Some(ChatDocuments {
            documents,
            last_editor,
        }))
    }

    fn take_appended(&mut self) -> Vec<AppendedNotice> {
        std::mem::take(&mut self.0.shared.borrow_mut().appended)
    }
}

struct FakeTools(Fake);

impl ProjectIpcTools for FakeTools {
    fn open_scope(&mut self, owner: i64, raw: &JsonValue) -> Result<String, Thrown> {
        let args = [Value::from(owner), json_value_to_serde(raw)];
        self.0.log("openScope", args.to_vec());
        self.0.answer("openScope", &args)
    }

    fn close_scope(&mut self, owner: i64, raw: &JsonValue) {
        let args = [Value::from(owner), json_value_to_serde(raw)];
        self.0.log("closeScope", args.to_vec());
    }

    fn list_files(
        &mut self,
        owner: i64,
        raw: &JsonValue,
    ) -> Result<ProjectListFilesResult, Thrown> {
        let args = [Value::from(owner), json_value_to_serde(raw)];
        self.0.log("listFiles", args.to_vec());
        self.0.answer("listFiles", &args)
    }

    fn search(&mut self, owner: i64, raw: &JsonValue) -> Result<ProjectSearchResult, Thrown> {
        let args = [Value::from(owner), json_value_to_serde(raw)];
        self.0.log("search", args.to_vec());
        self.0.answer("search", &args)
    }

    fn read(&mut self, owner: i64, raw: &JsonValue) -> Result<ProjectReadResult, Thrown> {
        let args = [Value::from(owner), json_value_to_serde(raw)];
        self.0.log("read", args.to_vec());
        self.0.answer("read", &args)
    }
}

struct FakeScopes(Fake);

impl ProjectIpcScopes for FakeScopes {
    fn project_of(&mut self, owner: i64, raw: &JsonValue) -> Result<Option<ProjectId>, Thrown> {
        let args = [Value::from(owner), json_value_to_serde(raw)];
        self.0.log("projectOf", args.to_vec());
        self.0.answer("projectOf", &args)
    }
}

struct FakeDialogs(Fake);

impl ProjectIpcDialogs for FakeDialogs {
    fn pick_folder(
        &mut self,
        owner: i64,
        purpose: ProjectFolderPickPurpose,
    ) -> Result<Option<String>, Thrown> {
        let purpose = match purpose {
            ProjectFolderPickPurpose::Add => "add",
            ProjectFolderPickPurpose::Relocate => "relocate",
            ProjectFolderPickPurpose::Parent => "parent",
        };
        let args = [Value::from(owner), text(purpose)];
        self.0.log("pickFolder", args.to_vec());
        self.0.answer("pickFolder", &args)
    }

    fn confirm_use_existing(&mut self, owner: i64, folder_path: &str) -> Result<bool, Thrown> {
        let args = [Value::from(owner), text(folder_path)];
        self.0.log("confirmUseExisting", args.to_vec());
        self.0.answer("confirmUseExisting", &args)
    }
}

/// the person at the trust prompt: what the world's dialogs answer. The
/// caller of the layer asks them at the steps, as the shell would.
struct FakePerson(Fake);

impl FakePerson {
    /// no case makes the question throw: the person's answer has no error
    fn ask_trust(&self, owner: i64, prompt: &ProjectTrustPrompt) -> Option<ProjectTrustChoice> {
        let args = [Value::from(owner), to_json(prompt)];
        self.0.log("askTrust", args.to_vec());
        let choice: Option<String> = self.0.answer("askTrust", &args).ok().flatten();
        match choice.as_deref() {
            Some("use") => Some(ProjectTrustChoice::Answer(ProjectTrustDecision::Use)),
            Some("without") => Some(ProjectTrustChoice::Answer(ProjectTrustDecision::Without)),
            Some("view") => Some(ProjectTrustChoice::View),
            _ => None,
        }
    }

    /// no case makes the wait throw: the person's answer has no error
    fn wait_for_return(&self, owner: i64) -> bool {
        let args = [Value::from(owner)];
        self.0.log("waitForReturn", args.to_vec());
        self.0.answer("waitForReturn", &args).unwrap_or(false)
    }
}

/// `resolveCloudOnly` of the world: `{ answers?, fail? }`
struct FakeResolver(Shared);

impl CloudOnlyResolver for FakeResolver {
    fn resolve(&mut self, paths: &[String]) -> Result<JsMap<bool>, ResolveFailure> {
        let paths: Vec<Value> = paths.iter().map(|path| text(path)).collect();
        note(
            &self.0,
            vec![
                Value::from("host"),
                Value::from("resolve"),
                Value::Array(paths),
            ],
        );
        let cfg = self.0.borrow().cloud.clone().unwrap_or(Value::Null);
        if let Some(message) = cfg.get("fail").and_then(Value::as_str) {
            return Err(ResolveFailure(message.to_owned()));
        }
        let mut answers = JsMap::new();
        for (path, verdict) in cfg
            .get("answers")
            .and_then(Value::as_object)
            .into_iter()
            .flatten()
        {
            answers.set(path.clone(), verdict.as_bool().unwrap_or(false));
        }
        Ok(answers)
    }
}

struct FakeHost {
    fake: Fake,
    resolver: Option<FakeResolver>,
    /// `deps.presetProjectOf` is given when the world has an entry for it
    has_preset: bool,
}

/// the window an entry of `windows` stands for
fn window_of_spec(spec: &Value) -> Option<ProjectWindow> {
    match spec.get("kind").and_then(Value::as_str)? {
        "home" => Some(ProjectWindow::Home),
        "editor" => {
            let editor: ProjectEditor =
                serde_json::from_value(spec.get("editor").cloned()?).ok()?;
            let doc_path = spec
                .get("docPath")
                .and_then(Value::as_str)
                .map(str::to_owned);
            Some(ProjectWindow::Editor { editor, doc_path })
        }
        _ => None,
    }
}

impl ProjectIpcHost for FakeHost {
    fn window_of(&mut self, sender: i64) -> Option<ProjectWindow> {
        window_of_spec(self.fake.shared.borrow().windows.get(&sender.to_string())?)
    }

    fn send(&mut self, target: i64, channel: &str, payload: &Value) -> bool {
        self.fake.log(
            "send",
            vec![Value::from(target), text(channel), payload.clone()],
        );
        !self.fake.shared.borrow().gone.contains(&target)
    }

    fn legacy_chat_for(&mut self, doc_path: &str) -> Result<Option<LegacyDocumentChat>, Thrown> {
        self.fake.log("legacyChatFor", vec![text(doc_path)]);
        self.fake.answer("legacyChatFor", &[text(doc_path)])
    }

    fn open_folder(&mut self, path: &str) -> Result<(), Thrown> {
        self.fake.log("openFolder", vec![text(path)]);
        self.fake.void("openFolder", &[text(path)])
    }

    /// no case makes the open throw: the trait has no error to carry
    fn open_document(&mut self, path: &str) -> Option<i64> {
        self.fake.log("openDocument", vec![text(path)]);
        self.fake
            .answer::<Option<i64>>("openDocument", &[text(path)])
            .ok()
            .flatten()
    }

    /// no case makes the switch throw: the trait has no error to carry
    fn show_home(&mut self) -> Option<i64> {
        self.fake.log("showHome", vec![]);
        self.fake
            .answer::<Option<i64>>("showHome", &[])
            .ok()
            .flatten()
    }

    fn projects_changed(&mut self) {
        self.fake.log("projectsChanged", vec![]);
    }

    fn cloud_only(&mut self) -> Option<&mut dyn CloudOnlyResolver> {
        self.resolver
            .as_mut()
            .map(|resolver| resolver as &mut dyn CloudOnlyResolver)
    }

    fn preset_project_of(&mut self, sender: i64) -> Result<Option<ProjectId>, Thrown> {
        if !self.has_preset {
            return Ok(None);
        }
        self.fake.log("presetProjectOf", vec![Value::from(sender)]);
        self.fake.answer("presetProjectOf", &[Value::from(sender)])
    }
}

// ---------------------------------------------------------------------------
// the scenario
// ---------------------------------------------------------------------------

fn object_of(spec: &Value, key: &str) -> Map<String, Value> {
    spec.get(key)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn gone_of(value: Option<&Value>) -> Result<Vec<i64>, CallError> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|item| item.as_i64().ok_or_else(|| bad("gone")))
        .collect()
}

/// what a handler or a controller method answered, as the spec prints it
fn settled(result: Result<Option<Value>, Thrown>) -> Value {
    match result {
        Ok(Some(value)) => value,
        Ok(None) => json!({ "undefined": true }),
        Err(Thrown(message)) => json!({ "error": message }),
    }
}

fn scenario_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("scenario"))?;
    let ops = spec
        .get("ops")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("ops"))?;
    run_scenario(spec, ops, cx)
}

/// `project-ipc.<handler>`: `[world, sender, raw?, after?, lead?]`: the
/// operations of `lead`, the call, the operations of `after`
fn handler_call(handler: &str, args: &[Value], cx: &mut Context) -> Answer {
    let world = arg(args, 0).ok_or_else(|| bad("world"))?;
    let sender = arg(args, 1).ok_or_else(|| bad("sender"))?;
    let mut first = json!({ "op": "call", "name": handler, "sender": sender });
    if let Some(raw) = arg(args, 2) {
        first["raw"] = raw.clone();
    }
    let list = |at: usize| match arg(args, at) {
        Some(Value::Array(ops)) => ops.clone(),
        _ => Vec::new(),
    };
    let mut ops = list(4);
    ops.push(first);
    ops.extend(list(3));
    run_scenario(world, &ops, cx)
}

fn run_scenario(spec: &Value, ops: &[Value], cx: &mut Context) -> Answer {
    let answers = object_of(spec, "answers");
    let has_preset = answers.contains_key("host.presetProjectOf");
    let cloud = match spec.get("cloud") {
        None | Some(Value::Null) => None,
        Some(cloud) => Some(cloud.clone()),
    };
    let shared: Shared = Rc::new(RefCell::new(State {
        answers,
        windows: object_of(spec, "windows"),
        gone: gone_of(spec.get("gone"))?,
        counters: HashMap::new(),
        logs: Vec::new(),
        appended: Vec::new(),
        cloud: cloud.clone(),
    }));
    let fake = |kind: &'static str| Fake {
        shared: shared.clone(),
        kind,
    };
    let mut guide = FakeGuide(fake("guide"));
    let mut chats = FakeChats(fake("chats"));
    let mut tools = FakeTools(fake("tools"));
    let mut scopes = FakeScopes(fake("scopes"));
    let mut dialogs = FakeDialogs(fake("dialogs"));
    let person = FakePerson(fake("dialogs"));
    let mut host = FakeHost {
        fake: fake("host"),
        resolver: cloud.map(|_| FakeResolver(shared.clone())),
        has_preset,
    };
    let platform = spec
        .get("platform")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut ipc = ProjectIpc::new(platform);
    let mut rows: Vec<Value> = Vec::new();
    for op in ops {
        let name = op
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("op"))?;
        let sender = op.get("sender").and_then(Value::as_i64);
        let sender_of = || sender.ok_or_else(|| bad("sender"));
        let mut deps = ProjectIpcDeps {
            guide: &mut guide,
            chats: &mut chats,
            tools: &mut tools,
            scopes: &mut scopes,
            dialogs: &mut dialogs,
            host: &mut host,
        };
        let (label, value) = match name {
            "call" => {
                let handler = op
                    .get("name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| bad("name"))?;
                let raw = op.get("raw").map(json_value_from_serde);
                let result = if PROJECT_FOLDER_CHANNELS
                    .iter()
                    .any(|(known, _)| *known == handler)
                {
                    let sender = sender_of()?;
                    let mut step = ipc.handle(&mut deps, handler, sender, raw.as_ref());
                    loop {
                        match step {
                            Ok(IpcStep::Done(reply)) => break Ok(reply),
                            Ok(IpcStep::AskTrust {
                                owner,
                                prompt,
                                pending,
                            }) => {
                                let choice = person.ask_trust(owner, &prompt);
                                step = ipc.resume_trust(&mut deps, pending, choice);
                            }
                            Ok(IpcStep::WaitForReturn { owner, pending }) => {
                                let back = person.wait_for_return(owner);
                                step = ipc.resume_return(&mut deps, pending, back);
                            }
                            Err(error) => break Err(error),
                        }
                    }
                } else {
                    Err(Thrown(format!("no handler {handler}")))
                };
                (handler.to_owned(), settled(result))
            }
            "listen" => {
                let method = op.get("method").map(json_value_from_serde);
                let on = op.get("on").map(json_value_from_serde);
                ipc.listen(&mut *deps.host, sender_of()?, method.as_ref(), on.as_ref());
                (name.to_owned(), Value::Null)
            }
            "forget" => {
                ipc.forget(sender_of()?);
                (name.to_owned(), Value::Null)
            }
            "reset" => {
                ipc.reset(sender_of()?);
                (name.to_owned(), Value::Null)
            }
            "untitledProject" => (name.to_owned(), json!(ipc.untitled_project(sender_of()?))),
            "windowProject" => (
                name.to_owned(),
                json!(ipc.window_project(&mut deps, sender_of()?)),
            ),
            "set" => {
                let mut state = shared.borrow_mut();
                for (key, value) in object_of(op, "answers") {
                    state.answers.insert(key, value);
                }
                for (key, value) in object_of(op, "windows") {
                    state.windows.insert(key, value);
                }
                if let Some(list) = op.get("gone").filter(|gone| gone.is_array()) {
                    state.gone = gone_of(Some(list))?;
                }
                (name.to_owned(), Value::Null)
            }
            other => (
                name.to_owned(),
                json!({ "error": format!("unknown operation {other}") }),
            ),
        };
        rows.push(json!([label, value]));
    }
    cx.logs.append(&mut shared.borrow_mut().logs);
    Ok(Some(Value::Array(rows)))
}

// ---------------------------------------------------------------------------
// waitForPageReturn
// ---------------------------------------------------------------------------

/// `project-ipc.waitForPageReturn`: `[{ destroyed, events }]`
fn page_call(args: &[Value]) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("page"))?;
    let destroyed = spec
        .get("destroyed")
        .and_then(Value::as_bool)
        .ok_or_else(|| bad("destroyed"))?;
    let outcome = |watch: &PageReturnWatch| match watch.outcome() {
        Some(back) => Value::from(back),
        None => Value::from("pending"),
    };
    let mut watch = PageReturnWatch::new(destroyed);
    let mut rows = vec![json!(["start", outcome(&watch)])];
    for event in spec
        .get("events")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let event = event.as_str().ok_or_else(|| bad("events"))?;
        match event {
            "arm" => watch.arm(),
            "focus" => watch.focus(),
            "blur" => watch.blur(),
            "destroyed" => watch.destroyed(),
            _ => {}
        }
        rows.push(json!([event, outcome(&watch)]));
    }
    // the page keeps the three listeners until the promise settles
    let listeners = if watch.outcome().is_some() { 0 } else { 3 };
    rows.push(json!(["listeners", listeners]));
    Ok(Some(Value::Array(rows)))
}
