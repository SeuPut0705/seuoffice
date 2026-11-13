//! The functions of group `b3-projects`, part `chats`
//! (tools/main-diff/groups/b3-projects-chats.ts): `chat-store.ts` of
//! `apps/shell/src/main/projects/`.
//!
//! `chat-store.scenario` runs the operations of the scenario over one
//! [`ProjectChatStore`] on one project folder, as the spec describes: the guide
//! and the host (trash, clock, new ids, `console.warn`) are fakes that answer
//! from the scenario and log each call as the TypeScript fake of the spec logs
//! it; `appendData` and `updateData` write the file for real.

use std::cell::RefCell;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::rc::Rc;
use std::time::{Duration, UNIX_EPOCH};

use jscompat::node_path::host::{basename, dirname, join};
use jscompat::{json_value_from_serde, to_iso_string};
use serde_json::{Value, json};

use super::super::{Answer, CallError, Context, arg};
use crate::packages::project_store::{
    ProjectChatRef, ProjectSelection, ProjectTrustState, ProjectWriteResult,
};
use crate::shell::projects::chat_store::{
    CHAT_STATE_CACHE_LIMIT, CHAT_TITLE_CHARS, CHAT_TITLE_MAX_CHARS, ChatAppendedEvent,
    ChatAppendedListener, ChatSender, ChatStoreError, ChatStoreGuide, ChatStoreHost,
    ChatStoreOptions, FOREIGN_SCAN_CACHE_LIMIT, ListenerId, MAX_PENDING_OPENING_MESSAGES,
    ProjectChatStore, default_new_id,
};
use crate::shell::projects::folder_files::data_dir_name;
use crate::shell::projects::paths::{canonical_path, relative_inside};
use crate::shell::projects::project_guide::{DataUpdateOutcome, SelectionTarget};
use crate::shell::projects::stand_ins::process_platform;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "chat-store.scenario" => scenario_call(args, cx),
        "chat-store.CHAT_TITLE_CHARS" => Ok(Some(Value::from(CHAT_TITLE_CHARS))),
        "chat-store.CHAT_TITLE_MAX_CHARS" => Ok(Some(Value::from(CHAT_TITLE_MAX_CHARS))),
        "chat-store.MAX_PENDING_OPENING_MESSAGES" => {
            Ok(Some(Value::from(MAX_PENDING_OPENING_MESSAGES)))
        }
        "chat-store.CHAT_STATE_CACHE_LIMIT" => Ok(Some(Value::from(CHAT_STATE_CACHE_LIMIT))),
        "chat-store.FOREIGN_SCAN_CACHE_LIMIT" => Ok(Some(Value::from(FOREIGN_SCAN_CACHE_LIMIT))),
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

type Shared<T> = Rc<RefCell<T>>;

/// the log lines of the case, the guide, the host and the listeners writing to one
type Log = Shared<Vec<Vec<Value>>>;

fn note(log: &Log, line: Vec<Value>) {
    log.borrow_mut().push(line);
}

fn opt(text: Option<&str>) -> Value {
    text.map_or(Value::Null, Value::from)
}

/// what the scenario's operations change and the fakes read
struct World {
    dir: String,
    root: String,
    project_id: String,
    install_id: String,
    trust: ProjectTrustState,
    platform: String,
    unwritable: bool,
    fail_writes: bool,
    trash_fails: bool,
    outside_fails: bool,
    clock_ms: f64,
    /// the new chat ids in order; `None` for the default random ones
    ids: Option<Vec<String>>,
    next_id: usize,
    trashed: u32,
    /// `[docPath, projectId, initialChatId]`
    selections: Vec<(String, Option<String>, Option<String>)>,
}

fn text_of(spec: &Value, key: &str) -> Result<String, CallError> {
    spec.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| bad(key))
}

fn flag_of(spec: &Value, key: &str) -> bool {
    spec.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn trust_of(name: &str) -> Result<ProjectTrustState, CallError> {
    match name {
        "use" => Ok(ProjectTrustState::Use),
        "without" => Ok(ProjectTrustState::Without),
        "unconfirmed" => Ok(ProjectTrustState::Unconfirmed),
        _ => Err(bad("trust")),
    }
}

fn world_of(spec: &Value) -> Result<World, CallError> {
    let ids = match spec.get("ids") {
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .map(|item| item.as_str().map(str::to_owned).ok_or_else(|| bad("ids")))
                .collect::<Result<Vec<_>, _>>()?,
        ),
        _ => None,
    };
    let mut selections = Vec::new();
    for entry in spec
        .get("selections")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let path = entry
            .get(0)
            .and_then(Value::as_str)
            .ok_or_else(|| bad("selections"))?;
        let selection = entry.get(1).ok_or_else(|| bad("selections"))?;
        let id_of = |key: &str| {
            selection
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        selections.push((path.to_owned(), id_of("projectId"), id_of("initialChatId")));
    }
    Ok(World {
        dir: text_of(spec, "dir")?,
        root: text_of(spec, "root")?,
        project_id: text_of(spec, "projectId")?,
        install_id: text_of(spec, "installId")?,
        trust: trust_of(&text_of(spec, "trust")?)?,
        platform: match text_of(spec, "platform")?.as_str() {
            "host" => process_platform().to_owned(),
            platform => platform.to_owned(),
        },
        unwritable: flag_of(spec, "unwritable"),
        fail_writes: flag_of(spec, "failWrites"),
        trash_fails: flag_of(spec, "trashFails"),
        outside_fails: flag_of(spec, "outsideFails"),
        clock_ms: spec
            .get("startMs")
            .and_then(Value::as_f64)
            .ok_or_else(|| bad("startMs"))?,
        ids,
        next_id: 0,
        trashed: 0,
        selections,
    })
}

/// `join(root, dataDir ?? dataDirName(root), rel)` for the known project
fn path_of(world: &World, id: &str, rel: &str, data_dir: Option<&str>) -> Option<String> {
    if id != world.project_id {
        return None;
    }
    let dir = match data_dir {
        Some(dir) => dir.to_owned(),
        None => data_dir_name(&world.root),
    };
    Some(join(&[world.root.as_str(), dir.as_str(), rel]))
}

/// a write the fake guide makes for real; false where it fails
fn write_for(path: &str, append: bool, text: &str) -> bool {
    if fs::create_dir_all(dirname(path)).is_err() {
        return false;
    }
    let mut options = OpenOptions::new();
    if append {
        options.append(true).create(true);
    } else {
        options.write(true).create(true).truncate(true);
    }
    options
        .open(path)
        .and_then(|mut file| file.write_all(text.as_bytes()))
        .is_ok()
}

struct FakeGuide {
    world: Shared<World>,
    log: Log,
}

impl FakeGuide {
    fn note(&self, name: &str, mut rest: Vec<Value>) {
        let mut line = vec![Value::from("guide"), Value::from(name)];
        line.append(&mut rest);
        note(&self.log, line);
    }

    fn mark_unwritable_flag(&self) {
        self.world.borrow_mut().unwritable = true;
    }
}

impl ChatStoreGuide for FakeGuide {
    fn append_data(
        &mut self,
        id: &str,
        rel_path: &str,
        text: &str,
        data_dir: Option<&str>,
    ) -> ProjectWriteResult {
        self.note(
            "appendData",
            vec![
                Value::from(id),
                Value::from(rel_path),
                Value::from(text),
                opt(data_dir),
            ],
        );
        let path = path_of(&self.world.borrow(), id, rel_path, data_dir);
        let fail_writes = self.world.borrow().fail_writes;
        match path {
            Some(path) if !fail_writes && write_for(&path, true, text) => ProjectWriteResult::Ok,
            _ => {
                self.mark_unwritable_flag();
                ProjectWriteResult::Unwritable
            }
        }
    }

    fn update_data(
        &mut self,
        id: &str,
        rel_path: &str,
        change: &mut dyn FnMut(Option<&str>, &mut dyn FnMut() -> String) -> Option<String>,
        data_dir: Option<&str>,
    ) -> DataUpdateOutcome {
        let path = path_of(&self.world.borrow(), id, rel_path, data_dir);
        let current = path
            .as_ref()
            .and_then(|path| fs::read(path).ok())
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
        self.note(
            "updateData",
            vec![
                Value::from(id),
                Value::from(rel_path),
                opt(data_dir),
                opt(current.as_deref()),
            ],
        );
        let Some(path) = path else {
            self.mark_unwritable_flag();
            return DataUpdateOutcome::Unwritable;
        };
        let next = {
            let mut install_id = || self.install_id();
            change(current.as_deref(), &mut install_id)
        };
        let fail_writes = self.world.borrow().fail_writes;
        if let Some(text) = &next
            && (fail_writes || !write_for(&path, false, text))
        {
            self.mark_unwritable_flag();
            return DataUpdateOutcome::Unwritable;
        }
        DataUpdateOutcome::Ok {
            written: next.is_some(),
            text: next,
        }
    }

    fn data_path(&mut self, id: &str, rel_path: &str, data_dir: Option<&str>) -> Option<String> {
        self.note(
            "dataPath",
            vec![Value::from(id), Value::from(rel_path), opt(data_dir)],
        );
        path_of(&self.world.borrow(), id, rel_path, data_dir)
    }

    fn install_id(&mut self) -> String {
        self.note("installId", Vec::new());
        self.world.borrow().install_id.clone()
    }

    fn trust_state(&mut self, id: &str) -> ProjectTrustState {
        self.note("trustState", vec![Value::from(id)]);
        self.world.borrow().trust
    }

    fn is_unwritable(&mut self, id: &str) -> bool {
        self.note("isUnwritable", vec![Value::from(id)]);
        self.world.borrow().unwritable
    }

    fn mark_unwritable(&mut self, id: &str) {
        self.note("markUnwritable", vec![Value::from(id)]);
        self.mark_unwritable_flag();
    }

    fn project_root(&mut self, id: &str) -> Option<String> {
        self.note("projectRoot", vec![Value::from(id)]);
        let world = self.world.borrow();
        (id == world.project_id).then(|| world.root.clone())
    }

    fn record_outside_chat(
        &mut self,
        doc_path: &str,
        project_id: &str,
        chat_id: &str,
    ) -> Result<(), String> {
        self.note(
            "recordOutsideChat",
            vec![
                Value::from(doc_path),
                Value::from(project_id),
                Value::from(chat_id),
            ],
        );
        if self.world.borrow().outside_fails {
            return Err("outside failed".to_owned());
        }
        Ok(())
    }

    fn document_relative_path(&mut self, id: &str, doc_path: &str) -> Option<String> {
        self.note(
            "documentRelativePath",
            vec![Value::from(id), Value::from(doc_path)],
        );
        let world = self.world.borrow();
        if id != world.project_id {
            return None;
        }
        relative_inside(
            &canonical_path(&world.root),
            &canonical_path(doc_path),
            &world.platform,
        )
    }

    fn get_selection(&mut self, target: &SelectionTarget) -> ProjectSelection {
        self.note(
            "getSelection",
            vec![serde_json::to_value(target).expect("a target prints")],
        );
        let world = self.world.borrow();
        let hit = match target {
            SelectionTarget::Document { path } => world
                .selections
                .iter()
                .find(|(candidate, _, _)| candidate == path),
            _ => None,
        };
        ProjectSelection {
            project_id: hit.and_then(|(_, project_id, _)| project_id.clone()),
            initial_chat_id: hit.and_then(|(_, _, chat_id)| chat_id.clone()),
            unregistered_project_hint: None,
        }
    }
}

struct FakeHost {
    world: Shared<World>,
    log: Log,
}

impl ChatStoreHost for FakeHost {
    fn trash(&mut self, abs_path: &str) -> Result<(), String> {
        note(
            &self.log,
            vec![
                Value::from("host"),
                Value::from("trash"),
                Value::from(abs_path),
            ],
        );
        let mut world = self.world.borrow_mut();
        if world.trash_fails {
            return Err("trash failed".to_owned());
        }
        let to = join(&[world.dir.as_str(), "trash"]);
        fs::create_dir_all(&to).map_err(|error| error.to_string())?;
        world.trashed += 1;
        let name = format!("{}-{}", world.trashed, basename(abs_path, None));
        fs::rename(abs_path, join(&[to.as_str(), name.as_str()])).map_err(|error| error.to_string())
    }

    fn now_iso(&mut self) -> String {
        let mut world = self.world.borrow_mut();
        world.clock_ms += 1000.0;
        to_iso_string(world.clock_ms).unwrap_or_default()
    }

    fn new_id(&mut self) -> String {
        let mut world = self.world.borrow_mut();
        let Some(ids) = &world.ids else {
            let mut random = [0u8; 12];
            getrandom::fill(&mut random).expect("the platform random source");
            return default_new_id(&random);
        };
        let id = ids.get(world.next_id).cloned().unwrap_or_default();
        world.next_id += 1;
        id
    }

    fn warn(&mut self, label: &str, detail: Option<&str>) {
        let mut line = vec![Value::from("console.warn"), Value::from(label)];
        if let Some(detail) = detail {
            line.push(Value::from(detail));
        }
        note(&self.log, line);
    }
}

/// a listener of the scenario: logs each event, and the one named `throws` fails
struct FakeListener {
    name: String,
    log: Log,
}

impl ChatAppendedListener for FakeListener {
    fn appended(&mut self, event: &ChatAppendedEvent, sender: &ChatSender) -> Result<(), String> {
        note(
            &self.log,
            vec![
                Value::from("listener"),
                Value::from(self.name.as_str()),
                serde_json::to_value(event).expect("an event prints"),
                serde_json::to_value(sender).expect("a sender prints"),
            ],
        );
        if self.name == "throws" {
            return Err("boom".to_owned());
        }
        Ok(())
    }
}

type Store = ProjectChatStore<FakeGuide, FakeHost>;

fn scenario_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("scenario"))?;
    let world = Rc::new(RefCell::new(world_of(spec)?));
    let default_ids = world.borrow().ids.is_none();
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let platform = world.borrow().platform.clone();
    let host_platform = spec.get("platform").and_then(Value::as_str) == Some("host");
    let mut store: Store = ProjectChatStore::new(
        FakeGuide {
            world: world.clone(),
            log: log.clone(),
        },
        FakeHost {
            world: world.clone(),
            log: log.clone(),
        },
        ChatStoreOptions {
            platform: (!host_platform).then_some(platform),
            state_cache_limit: spec.get("stateCacheLimit").and_then(Value::as_f64),
            foreign_cache_limit: spec.get("foreignCacheLimit").and_then(Value::as_f64),
        },
    );
    let mut listeners: Vec<ListenerId> = Vec::new();
    for name in spec
        .get("listeners")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = name.as_str().ok_or_else(|| bad("listeners"))?;
        listeners.push(store.on_appended(Box::new(FakeListener {
            name: name.to_owned(),
            log: log.clone(),
        })));
    }
    let mut results: Vec<Value> = Vec::new();
    for op in spec
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = op
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("op"))?;
        let value = run_op(name, op, &mut store, &world, &listeners, default_ids);
        results.push(json!([name, value]));
    }
    results.push(json!([
        "final",
        {
            "states": store.held_state_count(),
            "scans": store.held_foreign_scan_count(),
        }
    ]));
    cx.logs.extend(log.borrow_mut().drain(..));
    Ok(Some(Value::Array(results)))
}

/// what a thrown `Error` is in a result
fn thrown(error: &ChatStoreError) -> Value {
    json!({ "error": error.0 })
}

/// an id the spec gave; anything else is no id, as the TypeScript finds it
fn id_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn chat_ref_of(value: Option<&Value>) -> ProjectChatRef {
    let value = value.unwrap_or(&Value::Null);
    ProjectChatRef {
        project_id: id_of(value, "projectId").to_owned(),
        chat_id: id_of(value, "chatId").to_owned(),
    }
}

/// `{ editor, docPath, key? }` as the TypeScript builds the sender of an operation
fn sender_of(op: &Value) -> ChatSender {
    let sender = op.get("sender").unwrap_or(&Value::Null);
    let editor = match sender.get("editor") {
        Some(Value::String(editor)) => editor.clone(),
        // anything but a string is no editor
        Some(other) => other.to_string(),
        None => String::new(),
    };
    let doc_path = match sender.get("docPath") {
        None | Some(Value::Null) => None,
        Some(Value::String(path)) => Some(path.clone()),
        // anything but a string is no absolute path
        Some(_) => Some(String::new()),
    };
    ChatSender {
        editor,
        doc_path,
        key: sender.get("key").map(json_value_from_serde),
    }
}

fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a result prints")
}

fn answer<T: serde::Serialize>(result: Result<T, ChatStoreError>) -> Value {
    match result {
        Ok(value) => to_json(&value),
        Err(error) => thrown(&error),
    }
}

fn run_op(
    name: &str,
    op: &Value,
    store: &mut Store,
    world: &Shared<World>,
    listeners: &[ListenerId],
    default_ids: bool,
) -> Value {
    match name {
        "newChat" => match store.new_chat(id_of(op, "projectId")) {
            Ok(chat_id) if default_ids => {
                let length = chat_id.encode_utf16().count();
                let valid = length == 16
                    && chat_id
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
                json!({ "length": length, "valid": valid })
            }
            Ok(chat_id) => json!({ "chatId": chat_id }),
            Err(error) => thrown(&error),
        },
        "list" => answer(store.list_chats(id_of(op, "projectId"))),
        "chatInfo" => answer(store.chat_info(&chat_ref_of(op.get("ref")))),
        "open" => {
            let args = json_value_from_serde(op.get("args").unwrap_or(&Value::Null));
            answer(store.open_chat(&args))
        }
        "append" => {
            let args = json_value_from_serde(op.get("args").unwrap_or(&Value::Null));
            let sender = sender_of(op);
            match op.get("times").and_then(Value::as_f64) {
                None => answer(store.append(&args, &sender)),
                Some(times) => {
                    let mut out = Vec::new();
                    let mut i = 0.0;
                    while i < times {
                        out.push(answer(store.append(&args, &sender)));
                        i += 1.0;
                    }
                    Value::Array(out)
                }
            }
        }
        "rename" => {
            let args = json_value_from_serde(op.get("args").unwrap_or(&Value::Null));
            answer(store.rename_chat(&args))
        }
        "attach" => {
            answer(store.attach_document(&chat_ref_of(op.get("ref")), id_of(op, "docPath")))
        }
        "delete" => answer(store.delete_chat(&chat_ref_of(op.get("ref")))),
        "chatForDocument" => {
            answer(store.chat_for_document(id_of(op, "projectId"), id_of(op, "docPath")))
        }
        "counts" => json!({
            "states": store.held_state_count(),
            "scans": store.held_foreign_scan_count(),
        }),
        "unsubscribe" => {
            let index = op.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if let Some(id) = listeners.get(index) {
                store.off_appended(*id);
            }
            Value::Null
        }
        "world" => {
            let set = op.get("set").unwrap_or(&Value::Null);
            let mut world = world.borrow_mut();
            if let Some(value) = set.get("unwritable").and_then(Value::as_bool) {
                world.unwritable = value;
            }
            if let Some(value) = set.get("failWrites").and_then(Value::as_bool) {
                world.fail_writes = value;
            }
            if let Some(value) = set.get("trashFails").and_then(Value::as_bool) {
                world.trash_fails = value;
            }
            if let Some(value) = set.get("outsideFails").and_then(Value::as_bool) {
                world.outside_fails = value;
            }
            if let Some(trust) = set.get("trust").and_then(Value::as_str)
                && let Ok(trust) = trust_of(trust)
            {
                world.trust = trust;
            }
            Value::Null
        }
        "plant" => {
            let path = id_of(op, "path");
            let _ = fs::create_dir_all(dirname(path));
            let _ = fs::write(path, id_of(op, "text"));
            Value::Null
        }
        "remove" => {
            let path = id_of(op, "path");
            if fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()) {
                let _ = fs::remove_dir_all(path);
            } else {
                let _ = fs::remove_file(path);
            }
            Value::Null
        }
        "chmod" => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = op.get("mode").and_then(Value::as_u64).unwrap_or(0) as u32;
                let _ = fs::set_permissions(id_of(op, "path"), fs::Permissions::from_mode(mode));
            }
            Value::Null
        }
        "touch" => {
            let ms = op.get("mtimeMs").and_then(Value::as_f64).unwrap_or(0.0);
            if let Ok(file) = OpenOptions::new().write(true).open(id_of(op, "path")) {
                let _ = file.set_modified(UNIX_EPOCH + Duration::from_millis(ms as u64));
            }
            Value::Null
        }
        other => json!({ "error": format!("unknown operation {other}") }),
    }
}
