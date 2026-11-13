//! The functions of group `b3-projects`, part `guide`
//! (tools/main-diff/groups/b3-projects-guide.ts): `project-guide.ts` of
//! `apps/shell/src/main/projects/`.
//!
//! `project-guide.scenario` runs the operations of the scenario over one
//! [`ProjectGuide`] on the folders of the case, as the spec describes: the
//! host (clock, new ids, language, trust prompt, context files, `console.warn`
//! and the timer of `touch`) is a fake that answers from the scenario and logs
//! each call as the TypeScript fake of the spec logs it. Every path of the
//! scenario that starts with the case's folder is written below the real path
//! of that folder, as the TypeScript side does.
//!
//! The `chat*` operations run on one [`ProjectChatStore`] built on the first of
//! them over the same guide (shared, so the install id the store asks for is the
//! guide's own `install_id`, which fails where the settings file cannot take a
//! new id): its host reads the scenario's clock, takes its new chat ids from
//! `chatIds` (`chatN` after the last, each logged as `['chatId', id]`) and
//! only logs `trash`. The error of a chat store call carries its message only,
//! so the `code` of one is the errno name a Node error's message starts with.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use jscompat::node_path::host::extname;
use jscompat::{js_regex, json_value_from_serde, to_iso_string, utc_date_parts};
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg};
use crate::packages::project_store::{
    ApplyMemoryConsolidationArgs, ProjectChatRef, ProjectMemoryOp, ProjectTrustAnswer,
    ProjectTrustDecision, ProjectTrustPrompt, UndoMemoryConsolidationArgs, real_path_native,
};
use crate::shell::projects::chat_store::{
    ChatSender, ChatStoreError, ChatStoreHost, ChatStoreOptions, ProjectChatStore,
};
use crate::shell::projects::memory::LocalDateParts;
use crate::shell::projects::project_guide::{
    ContextFiles, ContextFilesProvider, ContextFilesRequest, EnvLookup, GuideError, GuideStep,
    INSTRUCTIONS_LIMIT_CHARS, MEMORY_BACKUPS_KEPT, MEMORY_SOFT_LIMIT_CHARS, MemoryEditor,
    NewProjectRequest, PROJECT_TOUCH_WRITE_MS, ProjectGuide, ProjectGuideDeps,
    ProjectSettingsPatch, SelectionTarget,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "project-guide.scenario" => scenario_call(args, cx),
        "project-guide.PROJECT_TOUCH_WRITE_MS" => Ok(Some(Value::from(PROJECT_TOUCH_WRITE_MS))),
        "project-guide.MEMORY_BACKUPS_KEPT" => Ok(Some(Value::from(MEMORY_BACKUPS_KEPT))),
        "project-guide.MEMORY_SOFT_LIMIT_CHARS" => Ok(Some(Value::from(MEMORY_SOFT_LIMIT_CHARS))),
        "project-guide.INSTRUCTIONS_LIMIT_CHARS" => Ok(Some(Value::from(INSTRUCTIONS_LIMIT_CHARS))),
        _ => return None,
    })
}

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

/// what an operation fails with: what the guide throws, or a scenario the
/// spec wrote wrongly
enum OpFail {
    Guide(GuideError),
    Spec(CallError),
}

impl From<GuideError> for OpFail {
    fn from(error: GuideError) -> Self {
        OpFail::Guide(error)
    }
}

impl From<CallError> for OpFail {
    fn from(error: CallError) -> Self {
        OpFail::Spec(error)
    }
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn note(log: &Log, line: Vec<Value>) {
    log.borrow_mut().push(line);
}

fn opt(text: Option<&str>) -> Value {
    text.map_or(Value::Null, Value::from)
}

fn to_json<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a result prints")
}

/// a temp name's random part differs on each side: `.[0-9a-f]{12}.tmp` of a
/// guard's temp file and `.<pid>.<uuid>.tmp` of the settings file's
fn mask_tmp(text: &str) -> String {
    let guarded = js_regex!(r"\.[0-9a-f]{12}\.tmp").replace_all(text, |_| ".<hex>.tmp".to_owned());
    js_regex!(r"\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp")
        .replace_all(&guarded, |_| ".<pid>.<uuid>.tmp".to_owned())
}

fn map_strings(value: &Value, map: &dyn Fn(&str) -> String) -> Value {
    match value {
        Value::String(text) => Value::String(map(text)),
        Value::Array(items) => {
            Value::Array(items.iter().map(|item| map_strings(item, map)).collect())
        }
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (map(key), map_strings(item, map)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn text_of<'a>(spec: &'a Value, key: &str) -> Result<&'a str, CallError> {
    spec.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad(key))
}

/// a string of an operation, or `None` where it is null or absent
fn opt_text<'a>(op: &'a Value, key: &str) -> Option<&'a str> {
    op.get(key).and_then(Value::as_str)
}

fn flag_of(op: &Value, key: &str) -> Result<bool, CallError> {
    op.get(key).and_then(Value::as_bool).ok_or_else(|| bad(key))
}

/// a failure as the spec reports it
fn fail_value(error: &GuideError) -> Value {
    json!({
        "error": mask_tmp(&error.message()),
        "code": error.code(),
        "refused": match error {
            GuideError::Refused(refused) => Some(refused.reason.as_str()),
            _ => None,
        },
    })
}

/// the host's local time zone of the case is UTC
fn utc_parts(ms: f64) -> LocalDateParts {
    let (year, month, date) = utc_date_parts(ms).unwrap_or((f64::NAN, f64::NAN, f64::NAN));
    let in_day = (ms.trunc() as i64).rem_euclid(86_400_000);
    LocalDateParts {
        full_year: year as i64,
        month: month as i64,
        date: date as i64,
        hours: in_day / 3_600_000,
        minutes: in_day / 60_000 % 60,
        seconds: in_day / 1000 % 60,
    }
}

/// the trust prompt: answers from the scenario's queue (an empty queue is
/// "closed") and logs each prompt
struct FakeAsk {
    answers: Rc<RefCell<VecDeque<ProjectTrustAnswer>>>,
    log: Log,
}

impl FakeAsk {
    fn ask(&mut self, prompt: &ProjectTrustPrompt) -> ProjectTrustAnswer {
        note(&self.log, vec![Value::from("trust"), to_json(prompt)]);
        self.answers.borrow_mut().pop_front().flatten()
    }

    /// a guide call as the host drives it: the answer, or the prompt shown and
    /// the call resumed with what the person answers
    fn drive<T, P>(
        &mut self,
        step: GuideStep<T, P>,
        resume: impl FnOnce(P, ProjectTrustAnswer) -> Result<T, GuideError>,
    ) -> Result<T, GuideError> {
        match step {
            GuideStep::Done(result) => Ok(result),
            GuideStep::AskTrust { prompt, pending } => {
                let answer = self.ask(&prompt);
                resume(pending, answer)
            }
        }
    }
}

fn answer_of(value: &Value) -> Result<ProjectTrustAnswer, CallError> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) if text == "use" => Ok(Some(ProjectTrustDecision::Use)),
        Value::String(text) if text == "without" => Ok(Some(ProjectTrustDecision::Without)),
        _ => Err(bad("trust answer")),
    }
}

/// the scenario's own folder and the host the guide and the chat store run on
struct Case {
    real: String,
    log: Log,
    answers: Rc<RefCell<VecDeque<ProjectTrustAnswer>>>,
    clock: Rc<Cell<f64>>,
    /// what each read of the clock moves it on
    tick: f64,
    platform: String,
    chat_ids: Rc<RefCell<VecDeque<String>>>,
    settings_path: String,
}

impl Case {
    fn chat_host(&self) -> ChatHost {
        ChatHost {
            clock: self.clock.clone(),
            tick: self.tick,
            ids: self.chat_ids.clone(),
            extra: 0,
            log: self.log.clone(),
        }
    }
}

fn build_guide(spec: &Value, case: &Case) -> Result<ProjectGuide, CallError> {
    let real = &case.real;
    let path_of = |key: &str, default: &str| {
        spec.get(key)
            .and_then(Value::as_str)
            .map_or_else(|| format!("{real}/{default}"), str::to_owned)
    };
    let home_dir = path_of("home", "home");
    let user_data = path_of("userData", "userData");
    let default_parent = path_of("defaultParent", "parent");
    let tick = case.tick;
    let ids: Rc<RefCell<VecDeque<String>>> = Rc::new(RefCell::new(
        spec.get("ids")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|id| id.as_str().map(str::to_owned).ok_or_else(|| bad("ids")))
            .collect::<Result<_, _>>()?,
    ));
    let extra = Rc::new(Cell::new(0u32));
    let language = spec
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("en")
        .to_owned();
    let env: Map<String, Value> = spec
        .get("env")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let context_files: Option<ContextFilesProvider> = match spec.get("contextFiles") {
        Some(files @ Value::Object(_)) => {
            let probes: Vec<String> = files
                .get("probes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|probe| {
                    probe
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| bad("probes"))
                })
                .collect::<Result<_, _>>()?;
            let omitted = files.get("omitted").and_then(Value::as_u64).unwrap_or(0);
            let log = case.log.clone();
            Some(Box::new(move |request: &ContextFilesRequest| {
                let visible: Vec<&String> = probes
                    .iter()
                    .filter(|probe| request.visibility.is_visible(probe, false).unwrap_or(false))
                    .collect();
                note(
                    &log,
                    vec![
                        Value::from("contextFiles"),
                        Value::from(request.id.as_str()),
                        Value::from(request.root.as_str()),
                        json!(visible),
                    ],
                );
                ContextFiles {
                    files: visible
                        .iter()
                        .map(|rel| crate::packages::project_store::ProjectFileEntry {
                            rel_path: (*rel).clone(),
                            ext: extname(rel),
                            size_bytes: 1,
                            mtime_ms: jscompat::JsNum(1.0),
                            cloud_only: false,
                        })
                        .collect(),
                    omitted,
                }
            }))
        }
        _ => None,
    };
    let clock = case.clock.clone();
    let ids_log = case.log.clone();
    let warn_log = case.log.clone();
    let lookup: EnvLookup =
        Box::new(move |key: &str| env.get(key).and_then(Value::as_str).map(str::to_owned));
    Ok(ProjectGuide::new(ProjectGuideDeps {
        settings_path: case.settings_path.clone(),
        home_dir,
        user_data,
        default_parent_dir: Box::new(move || default_parent.clone()),
        platform: Some(case.platform.clone()),
        env: Some(lookup),
        now: Some(Box::new(move || {
            let at = clock.get();
            clock.set(at + tick);
            at
        })),
        new_id: Some(Box::new(move || {
            let id = ids.borrow_mut().pop_front().unwrap_or_else(|| {
                extra.set(extra.get() + 1);
                format!("extra{}", extra.get())
            });
            note(
                &ids_log,
                vec![Value::from("newId"), Value::from(id.as_str())],
            );
            id
        })),
        language: Some(Box::new(move || language.clone())),
        context_files,
        touch_write_ms: spec.get("touchWriteMs").and_then(Value::as_f64),
        local_date: Box::new(utc_parts),
        warn: Some(Box::new(move |label: &str, detail: &str| {
            note(
                &warn_log,
                vec![
                    Value::from("warn"),
                    Value::from(label),
                    Value::from(mask_tmp(detail)),
                ],
            );
        })),
    }))
}

fn scenario_call(args: &[Value], cx: &mut Context) -> Answer {
    let raw = arg(args, 0).ok_or_else(|| bad("scenario"))?;
    let dir = text_of(raw, "dir")?.to_owned();
    let real = real_path_native(&dir).ok_or_else(|| bad("the folder of the case"))?;
    // the keys of the stored records are paths too, and the case writes them with the literal `$DIR`
    let spec = map_strings(raw, &|text| match text
        .strip_prefix(&dir)
        .or_else(|| text.strip_prefix("$DIR"))
    {
        Some(rest) => format!("{real}{rest}"),
        None => text.to_owned(),
    });
    let user_data = spec
        .get("userData")
        .and_then(Value::as_str)
        .map_or_else(|| format!("{real}/userData"), str::to_owned);
    let home = spec
        .get("home")
        .and_then(Value::as_str)
        .map_or_else(|| format!("{real}/home"), str::to_owned);
    let parent = spec
        .get("defaultParent")
        .and_then(Value::as_str)
        .map_or_else(|| format!("{real}/parent"), str::to_owned);
    for folder in [&user_data, &home, &parent] {
        std::fs::create_dir_all(folder).map_err(|e| bad(&e.to_string()))?;
    }
    let settings_path = format!("{user_data}/app-settings.json");
    if let Some(projects) = spec.get("settings").filter(|value| !value.is_null()) {
        std::fs::write(&settings_path, json!({ "projects": projects }).to_string())
            .map_err(|e| bad(&e.to_string()))?;
    }

    let case = Case {
        real: real.clone(),
        log: Rc::new(RefCell::new(Vec::new())),
        answers: Rc::new(RefCell::new(
            spec.get("trust")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(answer_of)
                .collect::<Result<_, _>>()?,
        )),
        clock: Rc::new(Cell::new(
            spec.get("startMs").and_then(Value::as_f64).unwrap_or(0.0),
        )),
        tick: spec.get("tickMs").and_then(Value::as_f64).unwrap_or(0.0),
        platform: spec
            .get("platform")
            .and_then(Value::as_str)
            .unwrap_or("linux")
            .to_owned(),
        chat_ids: Rc::new(RefCell::new(
            spec.get("chatIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|id| id.as_str().map(str::to_owned).ok_or_else(|| bad("chatIds")))
                .collect::<Result<_, _>>()?,
        )),
        settings_path,
    };
    let guide = Rc::new(build_guide(&spec, &case)?);
    let mut chats: Option<ChatStore> = None;
    let mut ask = FakeAsk {
        answers: case.answers.clone(),
        log: case.log.clone(),
    };
    let mut results: Vec<Value> = Vec::new();
    for op in spec
        .get("ops")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let label = text_of(op, "op")?;
        let value = match run_op(&guide, op, &mut ask, &case, &mut chats) {
            Ok(value) => value,
            Err(OpFail::Guide(error)) => fail_value(&error),
            Err(OpFail::Spec(error)) => return Err(error),
        };
        results.push(json!([label, value]));
    }
    cx.logs.append(&mut case.log.borrow_mut());
    Ok(Some(Value::Array(results)))
}

/// the host of the scenario's chat store: its clock, its new chat ids, and a
/// `trash` that only logs
struct ChatHost {
    clock: Rc<Cell<f64>>,
    tick: f64,
    ids: Rc<RefCell<VecDeque<String>>>,
    extra: u32,
    log: Log,
}

impl ChatStoreHost for ChatHost {
    fn trash(&mut self, abs_path: &str) -> Result<(), String> {
        note(&self.log, vec![Value::from("trash"), Value::from(abs_path)]);
        Ok(())
    }

    fn now_iso(&mut self) -> String {
        let at = self.clock.get();
        self.clock.set(at + self.tick);
        to_iso_string(at).unwrap_or_default()
    }

    fn new_id(&mut self) -> String {
        let queued = self.ids.borrow_mut().pop_front();
        let id = queued.unwrap_or_else(|| {
            self.extra += 1;
            format!("chat{}", self.extra)
        });
        note(
            &self.log,
            vec![Value::from("chatId"), Value::from(id.as_str())],
        );
        id
    }

    /// the TypeScript fake's `String(error)` of a call with the label alone
    fn warn(&mut self, label: &str, detail: Option<&str>) {
        note(
            &self.log,
            vec![
                Value::from("warn"),
                Value::from(label),
                Value::from(mask_tmp(detail.unwrap_or("undefined"))),
            ],
        );
    }
}

type ChatStore = ProjectChatStore<Rc<ProjectGuide>, ChatHost>;

/// a chat store call as the spec reports it: its answer, or `{ error, code,
/// refused }` where it threw
fn chat_answer<T: serde::Serialize>(result: Result<T, ChatStoreError>) -> Value {
    match result {
        Ok(answer) => to_json(&answer),
        Err(error) => json!({
            "error": mask_tmp(&error.message),
            "code": error.code,
            "refused": null,
        }),
    }
}

fn chat_op(name: &str, op: &Value, store: &mut ChatStore) -> Result<Value, CallError> {
    let project_id = text_of(op, "projectId")?;
    Ok(match name {
        "chatNew" => chat_answer(
            store
                .new_chat(project_id)
                .map(|chat_id| json!({ "chatId": chat_id })),
        ),
        "chatList" => chat_answer(store.list_chats(project_id)),
        _ => {
            let chat_id = text_of(op, "chatId")?;
            let mut args = json!({ "projectId": project_id, "chatId": chat_id });
            match name {
                "chatAppend" => {
                    args["role"] = Value::from(text_of(op, "role")?);
                    args["text"] = Value::from(text_of(op, "text")?);
                    let sender = ChatSender {
                        editor: text_of(op, "editor")?.to_owned(),
                        doc_path: opt_text(op, "docPath").map(str::to_owned),
                        key: None,
                    };
                    chat_answer(store.append(&json_value_from_serde(&args), &sender))
                }
                "chatOpen" => chat_answer(store.open_chat(&json_value_from_serde(&args))),
                "chatRename" => {
                    args["title"] = Value::from(text_of(op, "title")?);
                    chat_answer(store.rename_chat(&json_value_from_serde(&args)))
                }
                _ => chat_answer(store.chat_info(&ProjectChatRef {
                    project_id: project_id.to_owned(),
                    chat_id: chat_id.to_owned(),
                })),
            }
        }
    })
}

fn data_dir_of(op: &Value) -> Option<&str> {
    opt_text(op, "dataDir")
}

fn target_of(op: &Value) -> Result<SelectionTarget, CallError> {
    serde_json::from_value(op.get("target").cloned().unwrap_or(Value::Null))
        .map_err(|_| bad("target"))
}

fn run_op(
    guide: &Rc<ProjectGuide>,
    op: &Value,
    ask: &mut FakeAsk,
    case: &Case,
    chats: &mut Option<ChatStore>,
) -> Result<Value, OpFail> {
    let id = || text_of(op, "id");
    let rel = || text_of(op, "rel");
    let value = match text_of(op, "op")? {
        "listProjects" => to_json(&guide.list_projects()),
        "getProject" => to_json(&guide.get_project(id()?)),
        "defaultParent" => Value::from(guide.get_default_parent_folder()),
        "setPinned" => {
            guide.set_pinned(id()?, flag_of(op, "pinned")?)?;
            Value::Null
        }
        "removeFromList" => {
            guide.remove_from_list(id()?)?;
            Value::Null
        }
        "addFolder" => match op.get("path") {
            Some(Value::String(path)) => {
                to_json(&ask.drive(guide.add_folder(path)?, |pending, answer| {
                    guide.resume_add_folder(pending, answer)
                })?)
            }
            // `typeof folderPath !== 'string'`
            _ => json!({ "status": "refused", "reason": "not-a-folder" }),
        },
        "relocate" => {
            let id = id()?;
            match op.get("path") {
                Some(Value::String(path)) => to_json(
                    &ask.drive(guide.relocate_project(id, path)?, |pending, answer| {
                        guide.resume_add_folder(pending, answer)
                    })?,
                ),
                _ => {
                    // the project is looked up before the path is read
                    if guide.project_root(id).is_none() {
                        return Err(GuideError::Plain(format!("unknown project {id}")).into());
                    }
                    json!({ "status": "refused", "reason": "not-a-folder" })
                }
            }
        }
        "createProject" => {
            let args = op.get("args").ok_or_else(|| bad("args"))?;
            let request = NewProjectRequest {
                name: args
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                parent_dir: args
                    .get("parentDir")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                use_existing: args.get("useExisting").and_then(Value::as_bool),
            };
            to_json(
                &ask.drive(guide.create_project(&request)?, |pending, answer| {
                    guide.resume_create_project(pending, answer)
                })?,
            )
        }
        "renameProject" => to_json(&guide.rename_project(id()?, text_of(op, "name")?)?),
        "retryUnwritable" => to_json(&guide.retry_unwritable(id()?)?),
        "installId" => Value::from(guide.install_id()?),
        "chatNew" | "chatAppend" | "chatList" | "chatOpen" | "chatRename" | "chatInfo" => {
            let store = chats.get_or_insert_with(|| {
                ProjectChatStore::new(
                    guide.clone(),
                    case.chat_host(),
                    ChatStoreOptions {
                        platform: Some(case.platform.clone()),
                        ..ChatStoreOptions::default()
                    },
                )
            });
            chat_op(text_of(op, "op")?, op, store)?
        }
        "projectRoot" => opt(guide.project_root(id()?).as_deref()),
        "trustState" => to_json(&guide.trust_state(id()?)),
        "isUnwritable" => Value::from(guide.is_unwritable(id()?)),
        "markUnwritable" => {
            guide.mark_unwritable(id()?);
            Value::Null
        }
        "writeData" => {
            to_json(&guide.write_data(id()?, rel()?, text_of(op, "text")?, data_dir_of(op))?)
        }
        "appendData" => {
            to_json(&guide.append_data(id()?, rel()?, text_of(op, "text")?, data_dir_of(op))?)
        }
        "updateData" => {
            let mode = text_of(op, "mode")?;
            if !["set", "append", "keep", "throw"].contains(&mode) {
                return Err(bad("mode").into());
            }
            let payload = opt_text(op, "text").unwrap_or("").to_owned();
            let outcome = guide.update_data(
                id()?,
                rel()?,
                &mut |current: Option<&str>| {
                    note(&case.log, vec![Value::from("change"), opt(current)]);
                    match mode {
                        "set" => Ok(Some(payload.clone())),
                        "append" => Ok(Some(format!("{}{payload}", current.unwrap_or("")))),
                        "keep" => Ok(None),
                        _ => Err(GuideError::Plain("boom".to_owned())),
                    }
                },
                data_dir_of(op),
            )?;
            to_json(&outcome)
        }
        "removeData" => to_json(&guide.remove_data(id()?, rel()?, data_dir_of(op))?),
        "dataPath" => match guide.data_path(id()?, rel()?, data_dir_of(op)) {
            Ok(path) => opt(path.as_deref()),
            Err(refused) => return Err(GuideError::Refused(refused).into()),
        },
        "writeNewDocument" => {
            let result = guide
                .write_new_document(
                    id()?,
                    text_of(op, "target")?,
                    text_of(op, "text")?.as_bytes(),
                )
                .map_err(GuideError::from)?;
            to_json(&result)
        }
        "documentRelativePath" => opt(guide
            .document_relative_path(id()?, text_of(op, "doc")?)
            .as_deref()),
        "aiVisibility" => match guide.ai_visibility(id()?)? {
            None => Value::Null,
            Some(visibility) => {
                let mut visible = Vec::new();
                for probe in op
                    .get("probes")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let probe = probe.as_array().map_or(&[][..], Vec::as_slice);
                    let rel = probe
                        .first()
                        .and_then(Value::as_str)
                        .ok_or_else(|| bad("probe"))?;
                    let is_dir = probe.get(1).and_then(Value::as_bool).unwrap_or(false);
                    visible.push(Value::from(
                        visibility
                            .is_visible(rel, is_dir)
                            .map_err(GuideError::from)?,
                    ));
                }
                json!({
                    "root": visibility.root,
                    "ruleKey": visibility.rule_key,
                    "patterns": visibility.matcher.patterns,
                    "visible": visible,
                })
            }
        },
        "readContext" => to_json(&guide.read_context(id()?)?),
        "detail" => to_json(&guide.get_project_detail(id()?)?),
        "getSettings" => to_json(&guide.get_settings(id()?)),
        "setSettings" => {
            let patch = op.get("patch").unwrap_or(&Value::Null);
            let patch = ProjectSettingsPatch {
                memory_enabled: patch.get("memoryEnabled").and_then(Value::as_bool),
                read_agents_files: patch.get("readAgentsFiles").and_then(Value::as_bool),
            };
            to_json(&guide.set_settings(id()?, &patch)?)
        }
        "decideTrust" => {
            let decision = match text_of(op, "decision")? {
                "use" => ProjectTrustDecision::Use,
                "without" => ProjectTrustDecision::Without,
                _ => return Err(bad("decision").into()),
            };
            to_json(
                &ask.drive(guide.decide_trust(id()?, decision)?, |pending, answer| {
                    guide.resume_decide_trust(pending, answer)
                })?,
            )
        }
        "saveInstructions" => to_json(&guide.save_instructions(id()?, text_of(op, "text")?)?),
        "addIgnore" => to_json(&guide.add_ignore(id()?, rel()?)?),
        "removeIgnore" => to_json(&guide.remove_ignore(id()?, rel()?)?),
        "editMemory" => {
            let change: ProjectMemoryOp =
                serde_json::from_value(op.get("change").cloned().unwrap_or(Value::Null))
                    .map_err(|_| bad("change"))?;
            let by = match text_of(op, "by")? {
                "ai" => MemoryEditor::Ai,
                "person" => MemoryEditor::Person,
                _ => return Err(bad("by").into()),
            };
            to_json(&guide.edit_memory(id()?, &change, by)?)
        }
        "saveMemory" => to_json(&guide.save_memory(id()?, text_of(op, "text")?)?),
        "consolidate" => {
            let id = id()?;
            let entries: Option<Vec<String>> = op
                .get("entries")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .map(|item| item.as_str().map(str::to_owned))
                        .collect()
                });
            match entries {
                Some(entries) => to_json(&guide.apply_memory_consolidation(
                    &ApplyMemoryConsolidationArgs {
                        project_id: id.to_owned(),
                        entries,
                    },
                )?),
                None => {
                    // the project is looked up before the entries are checked
                    if guide.project_root(id).is_none() {
                        return Err(GuideError::Plain(format!("unknown project {id}")).into());
                    }
                    return Err(
                        GuideError::Plain("entries must be a list of strings".to_owned()).into(),
                    );
                }
            }
        }
        "undo" => to_json(
            &guide.undo_memory_consolidation(&UndoMemoryConsolidationArgs {
                project_id: id()?.to_owned(),
                // `typeof args.backupName !== 'string'` answers like a name that does not match
                backup_name: opt_text(op, "backupName").unwrap_or("").to_owned(),
            })?,
        ),
        "selection" => to_json(&guide.get_selection(&target_of(op)?)?),
        "setSelection" => {
            to_json(&guide.set_selection(&target_of(op)?, opt_text(op, "projectId"))?)
        }
        "recordOutsideChat" => {
            guide.record_outside_chat(
                text_of(op, "doc")?,
                text_of(op, "projectId")?,
                text_of(op, "chatId")?,
            )?;
            Value::Null
        }
        "adoptHint" => to_json(&ask.drive(
            guide.adopt_folder_hint(text_of(op, "doc")?)?,
            |pending, answer| guide.resume_adopt_folder_hint(pending, answer),
        )?),
        "flushTouches" => {
            guide.flush_touches()?;
            Value::Null
        }
        "touchTimer" => guide.touch_timer().map_or(
            Value::Null,
            |timer| json!({ "armed": true, "delay": timer.delay }),
        ),
        "fireTimer" => {
            if guide.touch_timer().is_some() {
                guide.flush_touches()?;
            }
            Value::Null
        }
        "queueTrust" => {
            for answer in op
                .get("answers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                case.answers.borrow_mut().push_back(answer_of(answer)?);
            }
            Value::Null
        }
        "clock" => {
            case.clock.set(
                op.get("ms")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| bad("ms"))?,
            );
            Value::Null
        }
        "fsWrite" => {
            let path = text_of(op, "path")?;
            if let Some(parent) = std::path::Path::new(path).parent() {
                std::fs::create_dir_all(parent).map_err(|e| bad(&e.to_string()))?;
            }
            std::fs::write(path, text_of(op, "text")?).map_err(|e| bad(&e.to_string()))?;
            Value::Null
        }
        "fsMkdir" => {
            std::fs::create_dir_all(text_of(op, "path")?).map_err(|e| bad(&e.to_string()))?;
            Value::Null
        }
        "fsRemove" => {
            let path = text_of(op, "path")?;
            // `rmSync(path, { recursive: true, force: true })`
            if std::fs::symlink_metadata(path).is_ok_and(|info| info.is_dir()) {
                std::fs::remove_dir_all(path).map_err(|e| bad(&e.to_string()))?;
            } else if std::fs::symlink_metadata(path).is_ok() {
                std::fs::remove_file(path).map_err(|e| bad(&e.to_string()))?;
            }
            Value::Null
        }
        "fsLink" => {
            #[cfg(unix)]
            std::os::unix::fs::symlink(text_of(op, "target")?, text_of(op, "path")?)
                .map_err(|e| bad(&e.to_string()))?;
            Value::Null
        }
        "fsChmod" => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = op
                    .get("mode")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| bad("mode"))?;
                std::fs::set_permissions(
                    text_of(op, "path")?,
                    std::fs::Permissions::from_mode(mode as u32),
                )
                .map_err(|e| bad(&e.to_string()))?;
            }
            Value::Null
        }
        "settingsFile" => {
            let text =
                std::fs::read_to_string(&case.settings_path).map_err(|e| bad(&e.to_string()))?;
            let parsed: Value = serde_json::from_str(&text).map_err(|e| bad(&e.to_string()))?;
            parsed.get("projects").cloned().unwrap_or(Value::Null)
        }
        other => return Err(bad(other).into()),
    };
    Ok(value)
}
