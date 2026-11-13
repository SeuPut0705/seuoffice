//! The functions of group `b3-projects`, part `guard`
//! (tools/main-diff/groups/b3-projects-guard.ts): the context, identity,
//! selection, write-guard and new-documents modules of
//! `apps/shell/src/main/projects/`.
//!
//! A function that touches the disk takes `fsCtx = { dir, links?, platform? }`
//! as its first argument, as the spec does: the links are made first, every
//! path of the other arguments that starts with `dir` is written below the
//! real path of `dir`, and in what comes back (answers, logs, messages) the
//! real path is written as `dir` again and a temp file's random name as
//! `<hex>`. The settings the selection and identity functions change are
//! answered as the part of them the spec compares.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use jscompat::JsObject;
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::NodeError;
use crate::packages::project_store::{
    ProjectFolderFile, ProjectSettings, ProjectTrustRecord, ProjectWriteResult, real_path_native,
};
use crate::shell::app_settings::{OutsideDocumentChoice, ProjectListEntry, StoredProjectsSettings};
use crate::shell::projects::context::{
    INSTRUCTIONS_LIMIT_CHARS, TrustedContext, assemble_trusted_context, cut_at,
};
use crate::shell::projects::identity::{ClassifyInput, classify_folder, rebase_opt_outs};
use crate::shell::projects::memory::MEMORY_SOFT_LIMIT_CHARS;
use crate::shell::projects::new_documents::{
    NEW_DOCUMENT_NAME_ATTEMPTS, NewDocumentOpener, NewDocumentPlacement, NewDocumentPlacer,
    NewDocumentPlacerDeps, NewDocumentsGuide, is_bare_file_name, new_document_folder,
    numbered_file_name,
};
use crate::shell::projects::paths::RefusalContext;
use crate::shell::projects::selection::{
    ResolvedSelectionTarget, container_of, drop_from_list, find_path_key,
    find_unregistered_project, record_outside_chat, record_selection, selection_for,
};
use crate::shell::projects::trust::HashedTexts;
use crate::shell::projects::write_guard::{
    ProjectWriteGuard, ProjectWriteRefusal, ProjectWriteRefused, WriteGuardError,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "context.INSTRUCTIONS_LIMIT_CHARS" => Ok(Some(Value::from(INSTRUCTIONS_LIMIT_CHARS))),
        "context.cutAt" => cut_at_call(args),
        "context.assembleTrustedContext" => assemble_call(args),

        "identity.classifyFolder" => on_disk(args, classify_call),
        "identity.rebaseOptOuts" => rebase_call(args),

        "selection.findPathKey" => find_path_key_call(args),
        "selection.containerOf" => container_call(args),
        "selection.selectionFor" => selection_for_call(args),
        "selection.recordSelection" => record_selection_call(args),
        "selection.recordOutsideChat" => record_outside_chat_call(args),
        "selection.dropFromList" => drop_call(args),
        "selection.findUnregisteredProject" => on_disk(args, unregistered_call),

        "write-guard.ProjectWriteRefused" => on_disk(args, |_, rest| refused_call(rest)),
        "write-guard.dataPath" => on_disk(args, |disk, rest| {
            let guard = disk.guard();
            let path = guard
                .data_path(str_arg(rest, 0)?, str_arg(rest, 1)?, data_dir_in(rest, 2))
                .map_err(|e| disk.fail(&WriteGuardError::Refused(e)))?;
            Ok(Some(Value::from(path)))
        }),
        "write-guard.writeData" => on_disk(args, |disk, rest| {
            let data = bytes_in(arg(rest, 2))?;
            disk.guard()
                .write_data(
                    str_arg(rest, 0)?,
                    str_arg(rest, 1)?,
                    &data,
                    data_dir_in(rest, 3),
                )
                .map_err(|e| disk.fail(&e))?;
            Ok(None)
        }),
        "write-guard.appendData" | "write-guard.appendData.hardLinks" => {
            on_disk(args, |disk, rest| {
                disk.guard()
                    .append_data(
                        str_arg(rest, 0)?,
                        str_arg(rest, 1)?,
                        str_arg(rest, 2)?,
                        data_dir_in(rest, 3),
                    )
                    .map_err(|e| disk.fail(&e))?;
                Ok(None)
            })
        }
        "write-guard.updateData" => on_disk_logged(args, cx, update_call),
        "write-guard.removeData" => on_disk(args, |disk, rest| {
            disk.guard()
                .remove_data(str_arg(rest, 0)?, str_arg(rest, 1)?, data_dir_in(rest, 2))
                .map_err(|e| disk.fail(&e))?;
            Ok(None)
        }),
        "write-guard.writeNewDocument" => on_disk(args, |disk, rest| {
            let data = bytes_in(arg(rest, 2))?;
            disk.guard()
                .write_new_document(str_arg(rest, 0)?, str_arg(rest, 1)?, &data)
                .map_err(|e| disk.fail(&e))?;
            Ok(None)
        }),
        "write-guard.createProjectFolder" => on_disk(args, |disk, rest| {
            disk.guard()
                .create_project_folder(str_arg(rest, 0)?, str_arg(rest, 1)?)
                .map(|path| Some(Value::from(path)))
                .map_err(|e| disk.fail(&e))
        }),

        "new-documents.NEW_DOCUMENT_NAME_ATTEMPTS" => {
            Ok(Some(Value::from(NEW_DOCUMENT_NAME_ATTEMPTS)))
        }
        "new-documents.newDocumentFolder" => {
            let doc = arg(args, 1).and_then(Value::as_str);
            str_arg(args, 0).and_then(|root| {
                Ok(Some(Value::from(new_document_folder(
                    root,
                    doc,
                    str_arg(args, 2)?,
                ))))
            })
        }
        "new-documents.isBareFileName" => {
            str_arg(args, 0).map(|name| Some(Value::from(is_bare_file_name(name))))
        }
        "new-documents.numberedFileName" => str_arg(args, 0).and_then(|name| {
            let n = arg(args, 1)
                .and_then(Value::as_f64)
                .ok_or_else(|| bad("a number"))?;
            Ok(Some(Value::from(numbered_file_name(name, n))))
        }),
        "new-documents.NewDocumentPlacer" => on_disk_logged(args, cx, placer_call),
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a model prints")
}

fn opt_text(text: Option<&str>) -> Value {
    text.map_or(Value::Null, Value::from)
}

/// `process.platform`
fn host_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// a value of a case, as the model parses it
fn parse<T: serde::de::DeserializeOwned>(
    value: Option<&Value>,
    what: &str,
) -> Result<T, CallError> {
    serde_json::from_value(value.cloned().unwrap_or(Value::Null))
        .map_err(|e| bad(&format!("{what}: {e}")))
}

// ---------- context ----------

fn cut_at_call(args: &[Value]) -> Answer {
    let limit = arg(args, 1)
        .and_then(Value::as_u64)
        .ok_or_else(|| bad("a limit"))?;
    Ok(Some(Value::from(cut_at(str_arg(args, 0)?, limit))))
}

fn texts_in(value: Option<&Value>) -> Result<HashedTexts, CallError> {
    let value = value.cloned().unwrap_or(Value::Null);
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    Ok(HashedTexts {
        data_dir: text("dataDir").ok_or_else(|| bad("dataDir"))?,
        instructions: text("instructions"),
        memory: text("memory"),
        agents: text("agents"),
        claude: text("claude"),
    })
}

fn context_value(context: &TrustedContext) -> Value {
    let instructions = context.instructions.as_ref().map_or(Value::Null, |part| {
        json!({
            "text": part.text,
            "sources": to_value(&part.sources),
            "dataDir": part.data_dir,
        })
    });
    let memory = context.memory.as_ref().map_or(
        Value::Null,
        |part| json!({ "text": part.text, "chars": part.chars }),
    );
    let mut updates = Map::new();
    for (file, hash) in &context.hash_updates {
        updates.insert(file.as_str().to_owned(), opt_text(hash.as_deref()));
    }
    json!({
        "instructions": instructions,
        "memory": memory,
        "notices": to_value(&context.notices),
        "hashUpdates": Value::Object(updates),
    })
}

fn assemble_call(args: &[Value]) -> Answer {
    let texts = texts_in(arg(args, 0))?;
    let record: ProjectTrustRecord = parse(arg(args, 1), "record")?;
    let switches: ProjectSettings = parse(arg(args, 2), "switches")?;
    let limit = arg(args, 3)
        .and_then(Value::as_u64)
        .unwrap_or(INSTRUCTIONS_LIMIT_CHARS);
    let memory_limit = arg(args, 4)
        .and_then(Value::as_u64)
        .unwrap_or(MEMORY_SOFT_LIMIT_CHARS);
    Ok(Some(context_value(&assemble_trusted_context(
        &texts,
        &record,
        &switches,
        limit,
        memory_limit,
    ))))
}

// ---------- the settings of identity and selection ----------

fn text_of(value: &Value, key: &str) -> Result<String, CallError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| bad(key))
}

fn settings_in(value: Option<&Value>) -> Result<StoredProjectsSettings, CallError> {
    let value = value.cloned().unwrap_or(Value::Null);
    let mut list = Vec::new();
    for item in value
        .get("list")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        list.push(ProjectListEntry {
            id: text_of(item, "id")?,
            path: text_of(item, "path")?,
            pinned: item.get("pinned").and_then(Value::as_bool).unwrap_or(false),
            last_used_at: text_of(item, "lastUsedAt")?,
        });
    }
    let mut outside = JsObject::new();
    for (doc, choice) in value
        .get("outsideDocuments")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        outside.set(
            doc.clone(),
            OutsideDocumentChoice {
                project_id: choice
                    .get("projectId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                last_chat_id: choice
                    .get("lastChatId")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            },
        );
    }
    let mut opted_out = JsObject::new();
    for (doc, record) in value
        .get("optedOutDocuments")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        opted_out.set(doc.clone(), text_of(record, "projectId")?);
    }
    let home_project_id = match value.get("homeProjectId") {
        None => None,
        Some(Value::String(id)) => Some(Some(id.clone())),
        Some(_) => Some(None),
    };
    Ok(StoredProjectsSettings {
        install_id: String::new(),
        list,
        trust: JsObject::new(),
        outside_documents: outside,
        opted_out_documents: opted_out,
        settings: JsObject::new(),
        sync_notice_shown: Vec::new(),
        home_project_id,
    })
}

fn entry_value(entry: &ProjectListEntry) -> Value {
    json!({
        "id": entry.id,
        "path": entry.path,
        "pinned": entry.pinned,
        "lastUsedAt": entry.last_used_at,
    })
}

/// `{ list, outsideDocuments, optedOutDocuments, homeProjectId }` of the
/// settings
fn touched(settings: &StoredProjectsSettings) -> Value {
    let mut outside = Map::new();
    for (doc, choice) in settings.outside_documents.entries() {
        let mut item = Map::new();
        item.insert(
            "projectId".to_owned(),
            opt_text(choice.project_id.as_deref()),
        );
        if let Some(chat) = &choice.last_chat_id {
            item.insert("lastChatId".to_owned(), Value::from(chat.as_str()));
        }
        outside.insert(doc.to_owned(), Value::Object(item));
    }
    let mut opted_out = Map::new();
    for (doc, project_id) in settings.opted_out_documents.entries() {
        opted_out.insert(doc.to_owned(), json!({ "projectId": project_id }));
    }
    let mut out = Map::new();
    out.insert(
        "list".to_owned(),
        Value::Array(settings.list.iter().map(entry_value).collect()),
    );
    out.insert("outsideDocuments".to_owned(), Value::Object(outside));
    out.insert("optedOutDocuments".to_owned(), Value::Object(opted_out));
    if let Some(home) = &settings.home_project_id {
        out.insert("homeProjectId".to_owned(), opt_text(home.as_deref()));
    }
    Value::Object(out)
}

fn project_id_in(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str)
}

// ---------- identity ----------

fn classify_call(disk: &Disk, rest: &[Value]) -> Answer {
    let input = arg(rest, 0).cloned().unwrap_or(Value::Null);
    let settings = settings_in(input.get("settings"))?;
    let file: Option<ProjectFolderFile> = parse(input.get("file"), "file")?;
    let root = text_of(&input, "root")?;
    let platform = input
        .get("platform")
        .and_then(Value::as_str)
        .unwrap_or("linux");
    let relocate_id = input.get("relocateId").and_then(Value::as_str);
    let result = classify_folder(&ClassifyInput {
        root: &root,
        file: file.as_ref(),
        settings: &settings,
        platform,
        relocate_id,
    });
    Ok(Some(disk.to_dir(&to_value(&result))))
}

fn rebase_call(args: &[Value]) -> Answer {
    let mut settings = settings_in(arg(args, 0))?;
    rebase_opt_outs(
        &mut settings,
        str_arg(args, 1)?,
        str_arg(args, 2)?,
        str_arg(args, 3)?,
        str_arg(args, 4)?,
    );
    Ok(Some(touched(&settings)))
}

// ---------- selection ----------

fn find_path_key_call(args: &[Value]) -> Answer {
    let mut record: JsObject<Value> = JsObject::new();
    for (key, value) in arg(args, 0)
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        record.set(key.clone(), value.clone());
    }
    Ok(find_path_key(&record, str_arg(args, 1)?, str_arg(args, 2)?).map(Value::from))
}

fn container_call(args: &[Value]) -> Answer {
    let settings = settings_in(arg(args, 1))?;
    Ok(container_of(str_arg(args, 0)?, &settings, str_arg(args, 2)?).map(entry_value))
}

fn selection_for_call(args: &[Value]) -> Answer {
    let settings = settings_in(arg(args, 0))?;
    let target: ResolvedSelectionTarget = parse(arg(args, 1), "target")?;
    Ok(Some(to_value(&selection_for(
        &settings,
        &target,
        str_arg(args, 2)?,
    ))))
}

fn record_selection_call(args: &[Value]) -> Answer {
    let mut settings = settings_in(arg(args, 0))?;
    let target: ResolvedSelectionTarget = parse(arg(args, 1), "target")?;
    record_selection(
        &mut settings,
        &target,
        project_id_in(arg(args, 2)),
        str_arg(args, 3)?,
    );
    Ok(Some(touched(&settings)))
}

fn record_outside_chat_call(args: &[Value]) -> Answer {
    let mut settings = settings_in(arg(args, 0))?;
    record_outside_chat(
        &mut settings,
        str_arg(args, 1)?,
        str_arg(args, 2)?,
        str_arg(args, 3)?,
        str_arg(args, 4)?,
    );
    Ok(Some(touched(&settings)))
}

fn drop_call(args: &[Value]) -> Answer {
    let mut settings = settings_in(arg(args, 0))?;
    drop_from_list(&mut settings, str_arg(args, 1)?);
    Ok(Some(touched(&settings)))
}

fn unregistered_call(disk: &Disk, rest: &[Value]) -> Answer {
    let settings = settings_in(arg(rest, 1))?;
    let ctx_value = arg(rest, 2).cloned().unwrap_or(Value::Null);
    let ctx = RefusalContext {
        home_dir: text_of(&ctx_value, "homeDir")?,
        user_data: text_of(&ctx_value, "userData")?,
        platform: text_of(&ctx_value, "platform")?,
    };
    let hint = find_unregistered_project(str_arg(rest, 0)?, &settings, &ctx);
    Ok(hint.map(|hint| disk.to_dir(&to_value(&hint))))
}

// ---------- the disk ----------

/// the real folder of a case as `dir`
#[derive(Clone)]
struct Mask {
    dir: String,
    real: String,
}

impl Mask {
    /// a message or answer text: the real folder written as `dir`, a temp
    /// file's random name written `<hex>`
    fn text(&self, text: &str) -> String {
        let shown = if self.real == self.dir {
            text.to_owned()
        } else {
            text.replace(&self.real, &self.dir)
        };
        mask_tmp(&shown)
    }

    /// every string of a value, by [`Mask::text`]
    fn value(&self, value: &Value) -> Value {
        map_strings(value, &|text| self.text(text))
    }

    /// `startsWith(dir) ? real + rest : text`
    fn to_real(&self, value: &Value) -> Value {
        map_strings(value, &|text| match text.strip_prefix(&self.dir) {
            Some(rest) => format!("{}{rest}", self.real),
            None => text.to_owned(),
        })
    }
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
                .map(|(key, item)| (key.clone(), map_strings(item, map)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `.replace(/\.[0-9a-f]{12}\.tmp/g, '.<hex>.tmp')`: a temp name's random part
/// differs on each side, so both sides write it as `<hex>`.
fn mask_tmp(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::new();
    let mut at = 0;
    let mut copied = 0;
    while at + 17 <= bytes.len() {
        let window = &bytes[at..at + 17];
        if window[0] == b'.'
            && window[1..13]
                .iter()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            && &window[13..] == b".tmp"
        {
            out.push_str(&text[copied..at]);
            out.push_str(".<hex>.tmp");
            at += 17;
            copied = at;
        } else {
            at += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// the `fsCtx` of a call and what it made of the call's folder
struct Disk {
    mask: Mask,
    platform: String,
}

impl Disk {
    /// a failure as the spec reports it: `code` and the masked `message`
    fn fail(&self, error: &WriteGuardError) -> CallError {
        CallError {
            code: error.code().map(str::to_owned),
            message: self.mask.text(&error.message()),
        }
    }

    fn to_dir(&self, value: &Value) -> Value {
        self.mask.value(value)
    }

    /// `new ProjectWriteGuard(ctx.platform ?? process.platform)`
    fn guard(&self) -> ProjectWriteGuard {
        ProjectWriteGuard::new(&self.platform)
    }
}

/// makes the links of a case: `[[linkPath, target], ...]`
fn make_links(links: Option<&Value>) -> Result<(), CallError> {
    for pair in links.and_then(Value::as_array).into_iter().flatten() {
        let pair = pair.as_array().map_or(&[][..], Vec::as_slice);
        let link = str_arg(pair, 0)?;
        let target = str_arg(pair, 1)?;
        if let Some(parent) = std::path::Path::new(link).parent() {
            std::fs::create_dir_all(parent).map_err(|e| bad(&e.to_string()))?;
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).map_err(|e| bad(&e.to_string()))?;
        #[cfg(not(unix))]
        let _ = target;
    }
    Ok(())
}

/// reads `fsCtx`, makes its links and gives the rest of the arguments with
/// the case's folder written as its real path
fn open_disk(args: &[Value]) -> Result<(Disk, Vec<Value>), CallError> {
    let ctx = arg(args, 0).cloned().unwrap_or(Value::Null);
    make_links(ctx.get("links"))?;
    let dir = text_of(&ctx, "dir")?;
    let real = real_path_native(&dir).ok_or_else(|| bad("the folder of the case"))?;
    let platform = ctx
        .get("platform")
        .and_then(Value::as_str)
        .unwrap_or(host_platform())
        .to_owned();
    let mask = Mask { dir, real };
    let rest = args
        .get(1..)
        .unwrap_or(&[])
        .iter()
        .map(|value| mask.to_real(value))
        .collect();
    Ok((Disk { mask, platform }, rest))
}

/// a function that touches the disk: `[fsCtx, ...args]`
fn on_disk(args: &[Value], run: impl FnOnce(&Disk, &[Value]) -> Answer) -> Answer {
    let (disk, rest) = open_disk(args)?;
    run(&disk, &rest).map(|answer| answer.map(|value| disk.to_dir(&value)))
}

/// [`on_disk`] for a function that logs: its lines are written with the
/// folder masked, in the order they were made
fn on_disk_logged(
    args: &[Value],
    cx: &mut Context,
    run: impl FnOnce(&Disk, &[Value], &Rc<RefCell<Vec<Vec<Value>>>>) -> Answer,
) -> Answer {
    let (disk, rest) = open_disk(args)?;
    let log = Rc::new(RefCell::new(Vec::new()));
    let answer = run(&disk, &rest, &log);
    cx.logs.append(&mut log.borrow_mut());
    answer.map(|answer| answer.map(|value| disk.to_dir(&value)))
}

/// the `dataDir` argument at `at`: null and absent are left out
fn data_dir_in(args: &[Value], at: usize) -> Option<&str> {
    arg(args, at).and_then(Value::as_str)
}

/// `string | Uint8Array` of a case: a string (UTF-8) or `{ hex }`
fn bytes_in(value: Option<&Value>) -> Result<Vec<u8>, CallError> {
    match value {
        Some(Value::String(text)) => Ok(text.as_bytes().to_vec()),
        Some(Value::Object(fields)) => {
            let hex = fields
                .get("hex")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("hex"))?;
            (0..hex.len() / 2)
                .map(|at| {
                    hex.get(at * 2..at * 2 + 2)
                        .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                        .ok_or_else(|| bad("hex"))
                })
                .collect()
        }
        _ => Err(bad("data")),
    }
}

// ---------- write-guard ----------

fn refused_call(rest: &[Value]) -> Answer {
    let reason: ProjectWriteRefusal = parse(arg(rest, 0), "reason")?;
    let refused = ProjectWriteRefused::new(reason, str_arg(rest, 1)?);
    Ok(Some(json!({
        "name": ProjectWriteRefused::NAME,
        "reason": reason.as_str(),
        "message": refused.message(),
        "isError": true,
    })))
}

/// What a `change` of a case, or the guard, fails with
enum Failure {
    Guard(WriteGuardError),
    /// the `Error` a change throws
    Thrown(String),
}

impl From<WriteGuardError> for Failure {
    fn from(error: WriteGuardError) -> Self {
        Self::Guard(error)
    }
}

fn update_call(disk: &Disk, rest: &[Value], log: &Rc<RefCell<Vec<Vec<Value>>>>) -> Answer {
    let change = arg(rest, 2).cloned().unwrap_or(Value::Null);
    let kind = change.get("kind").and_then(Value::as_str).unwrap_or("");
    let text = change.get("text").and_then(Value::as_str).unwrap_or("");
    let message = change.get("message").and_then(Value::as_str).unwrap_or("");
    let mut change = |current: Option<&str>| -> Result<Option<String>, Failure> {
        log.borrow_mut()
            .push(vec![Value::from("change"), disk.to_dir(&opt_text(current))]);
        match kind {
            "set" | "late" => Ok(Some(text.to_owned())),
            "null" | "undefined" => Ok(None),
            "append" => Ok(Some(format!("{}{text}", current.unwrap_or("")))),
            "throw" => Err(Failure::Thrown(message.to_owned())),
            _ => Err(Failure::Thrown(format!("no such change {kind}"))),
        }
    };
    let result = disk.guard().update_data(
        str_arg(rest, 0)?,
        str_arg(rest, 1)?,
        &mut change,
        data_dir_in(rest, 3),
    );
    match result {
        Ok(done) => Ok(Some(
            json!({ "written": done.written, "text": opt_text(done.text.as_deref()) }),
        )),
        Err(Failure::Guard(error)) => Err(disk.fail(&error)),
        Err(Failure::Thrown(message)) => Err(CallError::plain(disk.mask.text(&message))),
    }
}

// ---------- new-documents ----------

/// a window of `cfg.windows`
struct WindowCfg {
    project: Option<String>,
    doc: Option<String>,
    fail: Option<String>,
}

/// the guide of the scenario: it logs, refuses the targets `cfg.refuse`
/// names, and writes through a real write guard otherwise
struct ScenarioGuide {
    projects: HashMap<String, String>,
    refuse: Vec<(String, String)>,
    guard: ProjectWriteGuard,
    log: Rc<RefCell<Vec<Vec<Value>>>>,
    mask: Mask,
}

impl NewDocumentsGuide for ScenarioGuide {
    fn project_root(&mut self, id: &str) -> Option<String> {
        self.log
            .borrow_mut()
            .push(vec![Value::from("projectRoot"), Value::from(id)]);
        self.projects.get(id).cloned()
    }

    fn write_new_document(
        &mut self,
        id: &str,
        target: &str,
        data: &[u8],
    ) -> Result<ProjectWriteResult, WriteGuardError> {
        self.log.borrow_mut().push(vec![
            Value::from("write"),
            Value::from(id),
            self.mask.value(&Value::from(target)),
            Value::from(data.len()),
        ]);
        let kind = self
            .refuse
            .iter()
            .find(|(path, _)| path == target)
            .map(|(_, kind)| kind.as_str());
        match kind {
            Some("exists") => {
                return Err(ProjectWriteRefused::new(ProjectWriteRefusal::Exists, target).into());
            }
            Some("bad-path") => {
                return Err(ProjectWriteRefused::new(ProjectWriteRefusal::BadPath, target).into());
            }
            Some("plain") => {
                return Err(NodeError {
                    code: None,
                    message: "the guide failed".to_owned(),
                }
                .into());
            }
            _ => {}
        }
        let Some(root) = self.projects.get(id) else {
            return Err(NodeError {
                code: None,
                message: format!("unknown project {id}"),
            }
            .into());
        };
        self.guard.write_new_document(root, target, data)?;
        Ok(ProjectWriteResult::Ok)
    }
}

fn windows_in(value: Option<&Value>) -> HashMap<String, WindowCfg> {
    let text =
        |window: &Value, key: &str| window.get(key).and_then(Value::as_str).map(str::to_owned);
    value
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(id, window)| {
            (
                id.clone(),
                WindowCfg {
                    project: text(window, "project"),
                    doc: text(window, "doc"),
                    fail: text(window, "fail"),
                },
            )
        })
        .collect()
}

fn placement_value(placement: Option<NewDocumentPlacement>) -> Value {
    placement.map_or(Value::Null, |placement| to_value(&placement))
}

/// the `error` of an op: `{ code, message, refused, reason }`
fn op_error(mask: &Mask, code: Option<&str>, message: &str, reason: Option<&str>) -> Value {
    json!({
        "code": opt_text(code),
        "message": mask.text(message),
        "refused": reason.is_some(),
        "reason": opt_text(reason),
    })
}

fn guard_error(mask: &Mask, error: &WriteGuardError) -> Value {
    let reason = match error {
        WriteGuardError::Refused(refused) => Some(refused.reason.as_str()),
        WriteGuardError::Fs(_) => None,
    };
    op_error(mask, error.code(), &error.message(), reason)
}

fn node_error_value(mask: &Mask, error: &NodeError) -> Value {
    op_error(mask, error.code, &error.message, None)
}

/// one op over the placer: its value (`None` for `undefined`), or its error
fn run_op(
    placer: &mut NewDocumentPlacer<ScenarioGuide>,
    mask: &Mask,
    op: &Value,
) -> Result<Option<Value>, Value> {
    let node = |error: NodeError| node_error_value(mask, &error);
    let guard = |error: WriteGuardError| guard_error(mask, &error);
    let id = op.get("id").and_then(Value::as_i64).unwrap_or(0);
    let text = |key: &str| op.get(key).and_then(Value::as_str).unwrap_or("");
    let opener = || -> Result<Option<NewDocumentOpener>, Value> {
        match op.get("opener") {
            None | Some(Value::Null) => Ok(None),
            Some(value) => serde_json::from_value(value.clone())
                .map(Some)
                .map_err(|e| json!({ "message": e.to_string() })),
        }
    };
    let home_id = op.get("homeId").and_then(Value::as_i64);
    let placement_in = |value: Option<&Value>| -> Result<NewDocumentPlacement, Value> {
        serde_json::from_value(value.cloned().unwrap_or(Value::Null))
            .map_err(|e| json!({ "message": e.to_string() }))
    };
    Ok(match op.get("op").and_then(Value::as_str).unwrap_or("") {
        "placementFor" => Some(placement_value(placer.placement_for(id).map_err(node)?)),
        "placementOfOpener" => {
            let opener = opener()?;
            Some(placement_value(
                placer
                    .placement_of_opener(opener.as_ref(), home_id)
                    .map_err(node)?,
            ))
        }
        "preset" => {
            let placement = if let Some(message) = op.get("reject").and_then(Value::as_str) {
                Err(NodeError {
                    code: None,
                    message: message.to_owned(),
                })
            } else if op.get("opener").is_some() {
                let opener = opener()?;
                placer.placement_of_opener(opener.as_ref(), home_id)
            } else {
                match op.get("placement") {
                    None | Some(Value::Null) => Ok(None),
                    Some(value) => serde_json::from_value(value.clone())
                        .map(Some)
                        .map_err(|e| NodeError {
                            code: None,
                            message: e.to_string(),
                        }),
                }
            };
            placer.preset(id, placement);
            None
        }
        "presetProjectOf" => Some(opt_text(placer.preset_project_of(id).as_deref())),
        "forget" => {
            placer.forget(id);
            None
        }
        "saveDialogFolder" => Some(opt_text(
            placer.save_dialog_folder(id).map_err(node)?.as_deref(),
        )),
        "writeFor" => Some(opt_text(
            placer
                .write_for(id, text("fileName"), text("text").as_bytes())
                .map_err(guard)?
                .as_deref(),
        )),
        "write" => {
            let placement = placement_in(op.get("placement"))?;
            Some(Value::from(
                placer
                    .write(&placement, text("fileName"), text("text").as_bytes())
                    .map_err(guard)?,
            ))
        }
        other => {
            return Err(json!({ "message": format!("no such op {other}") }));
        }
    })
}

fn placer_call(disk: &Disk, rest: &[Value], log: &Rc<RefCell<Vec<Vec<Value>>>>) -> Answer {
    let cfg = arg(rest, 0).cloned().unwrap_or(Value::Null);
    let projects: HashMap<String, String> = cfg
        .get("projects")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, root)| root.as_str().map(|root| (id.clone(), root.to_owned())))
        .collect();
    let windows = Rc::new(windows_in(cfg.get("windows")));
    let refuse: Vec<(String, String)> = cfg
        .get("refuse")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|pair| {
            let pair = pair.as_array()?;
            Some((
                pair.first()?.as_str()?.to_owned(),
                pair.get(1)?.as_str()?.to_owned(),
            ))
        })
        .collect();
    let mask = disk.mask.clone();
    let guide = ScenarioGuide {
        projects,
        refuse,
        guard: disk.guard(),
        log: Rc::clone(log),
        mask: mask.clone(),
    };
    let window_log = Rc::clone(log);
    let window_windows = Rc::clone(&windows);
    let document_log = Rc::clone(log);
    let document_windows = Rc::clone(&windows);
    let mut placer = NewDocumentPlacer::new(NewDocumentPlacerDeps {
        guide,
        window_project: Box::new(move |id| {
            window_log
                .borrow_mut()
                .push(vec![Value::from("windowProject"), Value::from(id)]);
            let window = window_windows.get(&id.to_string());
            if let Some(message) = window.and_then(|window| window.fail.as_ref()) {
                return Err(NodeError {
                    code: None,
                    message: message.clone(),
                });
            }
            Ok(window.and_then(|window| window.project.clone()))
        }),
        document_of: Box::new(move |id| {
            document_log
                .borrow_mut()
                .push(vec![Value::from("documentOf"), Value::from(id)]);
            document_windows
                .get(&id.to_string())
                .and_then(|window| window.doc.clone())
        }),
        platform: disk.platform.clone(),
    });
    let mut out = Vec::new();
    for op in arg(rest, 1).and_then(Value::as_array).into_iter().flatten() {
        let mut entry = Map::new();
        entry.insert(
            "op".to_owned(),
            op.get("op").cloned().unwrap_or(Value::Null),
        );
        match run_op(&mut placer, &mask, op) {
            Ok(Some(value)) => {
                entry.insert("value".to_owned(), value);
            }
            Ok(None) => {}
            Err(error) => {
                entry.insert("error".to_owned(), error);
            }
        }
        out.push(Value::Object(entry));
    }
    Ok(Some(Value::Array(out)))
}
