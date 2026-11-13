//! The functions of group `b2-recovery` (tools/main-diff/groups/b2-recovery.ts).
//!
//! The recovery store is process-wide state in the TypeScript, so its
//! functions are driven as a scenario: one call carries a folder, a run id, a
//! clock and a list of steps, and answers one entry per step (the step's
//! `op`, then `ok` with its value, or `error`). The same scenario shape
//! serves every export of recovery-store.ts that touches the state. The
//! scenario's random ids are `uuid-1`, `uuid-2`, ... on both sides.

use std::cell::Cell;
use std::collections::HashMap;
use std::fs;
use std::rc::Rc;
use std::time::{Duration, UNIX_EPOCH};

use jscompat::json_value_from_serde;
use jscompat::node_path::host::join;
use serde_json::{Map, Number, Value};

use super::fakes::{FakeDialog, fake_parent};
use super::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::{NodeError, node_error};
use crate::packages::electron_utils::legacy_import_prefs::{
    LEGACY_IMPORT_KINDS, LEGACY_IMPORT_SKIP_KEY, read_legacy_import_prompt,
    read_legacy_import_skip, write_legacy_import_prompt, write_legacy_import_skip,
};
use crate::packages::electron_utils::recovery_contract::{
    RecoveryEditorContract, RecoveryOpenFileRequest, RecoveryOpenUntitledRequest,
    RecoveryRegistration, RecoveryRegistry,
};
use crate::packages::electron_utils::recovery_labels::{
    RECOVERY_PROMPT_STRINGS, recovery_prompt_labels, unprotectable_notice_text,
};
use crate::packages::electron_utils::recovery_prompt::{
    RecoveryOpenResult, RecoveryPromptAnswer, RecoveryPromptOptions, ResolveRecoveryOnOpenOptions,
    prompt_recovery_for_file, resolve_recovery_on_open,
};
use crate::packages::electron_utils::recovery_store::{
    RECOVERY_COPY_MAX_AGE_MS, RECOVERY_EDITOR_KINDS, RecoveryAdoptOptions, RecoveryCopyFilter,
    RecoveryCopyInfo, RecoveryCopyState, RecoveryDeleteReason, RecoveryDeleteResult,
    RecoveryFileIdentity, RecoveryIdentity, RecoveryLaunchDecision, RecoveryOpenPlan,
    RecoveryStore, RecoveryStoreOptions, RecoveryUntitledIdentity, RecoveryWriteOptions,
    RecoveryWriteResult, RecoveryWriteTicket, SharedRecoveryState, create_recovery_store,
    is_app_shutting_down, is_recovery_editor_kind, mark_app_shutting_down,
    new_untitled_recovery_id, recovery_folder_name, recovery_run_id, reset_app_shutting_down,
    resume_discarded_copies,
};
use crate::packages::electron_utils::save_conflict_labels::{
    SAVE_CONFLICT_STRINGS, save_conflict_labels,
};
use crate::packages::electron_utils::unsaved_files::{
    OpenFileState, OpenFilesHolder, OpenFilesSource, OpenFilesSourceFailed,
    UNSAVED_CHANGES_MESSAGE, assert_file_saved, file_has_unsaved_changes, without_unsaved_files,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "recovery-contract.registerRecoveryEditor"
        | "recovery-contract.recoveryEditor"
        | "recovery-contract.recoveryEditors" => registry_call(args),
        "recovery-labels.recoveryPromptLabels" => (|| {
            let labels = recovery_prompt_labels(str_arg(args, 0)?, str_arg(args, 1)?);
            Ok(Some(serde_json::to_value(labels).expect("labels print")))
        })(),
        "recovery-labels.unprotectableNoticeText" => {
            str_arg(args, 0).map(|lang| Some(Value::from(unprotectable_notice_text(lang))))
        }
        "recovery-labels.RECOVERY_PROMPT_STRINGS" => {
            Ok(Some(string_table(RECOVERY_PROMPT_STRINGS)))
        }
        "save-conflict-labels.SAVE_CONFLICT_STRINGS" => {
            Ok(Some(string_table(SAVE_CONFLICT_STRINGS)))
        }
        "save-conflict-labels.saveConflictLabels" => str_arg(args, 0).map(|lang| {
            Some(serde_json::to_value(save_conflict_labels(lang)).expect("labels print"))
        }),
        "recovery-prompt.promptRecoveryForFile" => prompt_call(args, cx),
        "recovery-prompt.resolveRecoveryOnOpen" => resolve_call(args, cx),
        "recovery-store.RECOVERY_EDITOR_KINDS" => Ok(Some(Value::Array(
            RECOVERY_EDITOR_KINDS
                .iter()
                .map(|k| Value::from(*k))
                .collect(),
        ))),
        "recovery-store.RECOVERY_COPY_MAX_AGE_MS" => Ok(Some(num(RECOVERY_COPY_MAX_AGE_MS))),
        "recovery-store.recoveryFolderName" => {
            str_arg(args, 0).map(|kind| Some(Value::from(recovery_folder_name(kind))))
        }
        "recovery-store.isRecoveryEditorKind" => Ok(Some(Value::Bool(
            arg(args, 0)
                .and_then(Value::as_str)
                .is_some_and(is_recovery_editor_kind),
        ))),
        "recovery-store.isUntitledIdentity" => Ok(Some(Value::Bool(
            arg(args, 0)
                .and_then(Value::as_object)
                .is_some_and(|o| o.contains_key("untitledId")),
        ))),
        "recovery-store.createRecoveryStore"
        | "recovery-store.recoveryRunId"
        | "recovery-store.markAppShuttingDown"
        | "recovery-store.resetAppShuttingDown"
        | "recovery-store.isAppShuttingDown"
        | "recovery-store.resumeDiscardedCopies"
        | "recovery-store.newUntitledRecoveryId" => store_call(args, cx),
        "unsaved-files.UNSAVED_CHANGES_MESSAGE" => Ok(Some(Value::from(UNSAVED_CHANGES_MESSAGE))),
        "unsaved-files.setOpenFilesSource" => unsaved_call(args, Unsaved::Set),
        "unsaved-files.fileHasUnsavedChanges" => unsaved_call(args, Unsaved::Has),
        "unsaved-files.assertFileSaved" => unsaved_call(args, Unsaved::Assert),
        "unsaved-files.withoutUnsavedFiles" => unsaved_call(args, Unsaved::Without),
        "legacy-import-prefs.LEGACY_IMPORT_SKIP_KEY" => {
            Ok(Some(Value::from(LEGACY_IMPORT_SKIP_KEY)))
        }
        "legacy-import-prefs.LEGACY_IMPORT_KINDS" => Ok(Some(Value::Array(
            LEGACY_IMPORT_KINDS
                .iter()
                .map(|k| Value::from(*k))
                .collect(),
        ))),
        "legacy-import-prefs.readLegacyImportSkip" => (|| {
            Ok(Some(Value::Bool(read_legacy_import_skip(
                str_arg(args, 0)?,
                str_arg(args, 1)?,
            ))))
        })(),
        "legacy-import-prefs.writeLegacyImportSkip" => (|| {
            let skip = arg(args, 2)
                .and_then(Value::as_bool)
                .ok_or_else(|| bad("a boolean"))?;
            write_legacy_import_skip(str_arg(args, 0)?, str_arg(args, 1)?, skip)
                .map(|()| None)
                .map_err(masked)
        })(),
        "legacy-import-prefs.readLegacyImportPrompt" => {
            str_arg(args, 0).map(|path| Some(Value::Bool(read_legacy_import_prompt(path))))
        }
        "legacy-import-prefs.writeLegacyImportPrompt" => (|| {
            let prompt = arg(args, 1)
                .and_then(Value::as_bool)
                .ok_or_else(|| bad("a boolean"))?;
            write_legacy_import_prompt(str_arg(args, 0)?, prompt)
                .map(|()| None)
                .map_err(masked)
        })(),
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
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

fn masked(mut error: NodeError) -> CallError {
    error.message = mask_tmp(&error.message);
    error.into()
}

/// `{ en: {key: text, ...}, ko: {...} }` of a `(key, en, ko)` table
fn string_table(table: &[(&str, &str, &str)]) -> Value {
    let mut en = Map::new();
    let mut ko = Map::new();
    for (key, en_text, ko_text) in table {
        en.insert((*key).to_owned(), Value::from(*en_text));
        ko.insert((*key).to_owned(), Value::from(*ko_text));
    }
    let mut out = Map::new();
    out.insert("en".into(), Value::Object(en));
    out.insert("ko".into(), Value::Object(ko));
    Value::Object(out)
}

fn field<'a>(object: &'a Value, key: &str) -> Option<&'a Value> {
    object.as_object().and_then(|o| o.get(key))
}

fn field_str<'a>(object: &'a Value, key: &str) -> Option<&'a str> {
    field(object, key).and_then(Value::as_str)
}

fn need_str<'a>(object: &'a Value, key: &str) -> Result<&'a str, CallError> {
    field_str(object, key).ok_or_else(|| bad(&format!("`{key}` a string")))
}

// ---- recovery-contract ----

struct FakeEditor {
    label: String,
    kind: String,
}

impl RecoveryEditorContract<()> for FakeEditor {
    fn kind(&self) -> &str {
        &self.kind
    }
    fn write_copies_now(&self) {}
    fn open_file_with_decision(&self, _: &(), _: &RecoveryOpenFileRequest) {}
    fn open_untitled_copy(&self, _: &(), _: &RecoveryOpenUntitledRequest) {}
    fn is_unprotectable(&self, _: &()) -> bool {
        false
    }
}

/// `[steps]`: `register {label, kind, token}`, `registerAgain {label, token}`
/// (the contract last made for the label), `unregister {token}`,
/// `editor {kind}`, `editors {}`. One entry per step.
fn registry_call(args: &[Value]) -> Answer {
    let steps = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?;
    let mut registry: RecoveryRegistry<()> = RecoveryRegistry::new();
    let mut made: HashMap<String, Rc<FakeEditor>> = HashMap::new();
    let mut every: Vec<Rc<FakeEditor>> = Vec::new();
    let mut tokens: HashMap<String, RecoveryRegistration<()>> = HashMap::new();
    let mut out = Vec::new();
    for step in steps {
        let op = need_str(step, "op")?;
        let mut entry = Map::new();
        entry.insert("op".into(), Value::from(op));
        match op {
            "register" | "registerAgain" => {
                let label = need_str(step, "label")?;
                if op == "register" {
                    let fake = Rc::new(FakeEditor {
                        label: label.to_owned(),
                        kind: need_str(step, "kind")?.to_owned(),
                    });
                    every.push(fake.clone());
                    made.insert(label.to_owned(), fake);
                }
                let contract = made.get(label).ok_or_else(|| bad("a made label"))?;
                let token = registry.register_recovery_editor(contract.clone());
                tokens.insert(need_str(step, "token")?.to_owned(), token);
            }
            "unregister" => {
                if let Some(token) = tokens.get(need_str(step, "token")?) {
                    registry.unregister(token);
                }
            }
            "editor" => {
                let found = registry.recovery_editor(need_str(step, "kind")?);
                let label = found.map(|c| label_of(&every, &c));
                entry.insert("ok".into(), label.map_or(Value::Null, Value::from));
            }
            "editors" => {
                let labels: Vec<Value> = registry
                    .recovery_editors()
                    .iter()
                    .map(|c| Value::from(label_of(&every, c)))
                    .collect();
                entry.insert("ok".into(), Value::Array(labels));
            }
            _ => return Err(bad("a registry op")),
        }
        out.push(Value::Object(entry));
    }
    Ok(Some(Value::Array(out)))
}

/// the label of the fake a registry handed back (found by identity)
fn label_of(every: &[Rc<FakeEditor>], found: &Rc<dyn RecoveryEditorContract<()>>) -> String {
    every
        .iter()
        .find(|fake| {
            let as_dyn: Rc<dyn RecoveryEditorContract<()>> = Rc::<FakeEditor>::clone(fake);
            Rc::ptr_eq(&as_dyn, found)
        })
        .map_or_else(String::new, |fake| fake.label.clone())
}

// ---- recovery-prompt ----

/// `[{ lang, documentName, fileChangedAfterCopy, response, parent }]`
fn prompt_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("options"))?;
    let dialog = FakeDialog::of(spec);
    let parent = fake_parent(spec);
    let answer = prompt_recovery_for_file(&RecoveryPromptOptions {
        dialog: &dialog,
        parent: parent.as_ref(),
        document_name: need_str(spec, "documentName")?,
        file_changed_after_copy: field(spec, "fileChangedAfterCopy")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        lang: need_str(spec, "lang")?,
    });
    cx.logs.extend(dialog.log.into_inner());
    Ok(Some(Value::from(match answer {
        RecoveryPromptAnswer::Restore => "restore",
        RecoveryPromptAnswer::Discard => "discard",
    })))
}

/// `[{ userData, identity, lang, documentName, response, parent }]`
fn resolve_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("options"))?;
    let user_data = need_str(spec, "userData")?.to_owned();
    let identity = identity_of(field(spec, "identity").ok_or_else(|| bad("identity"))?)?;
    let dialog = FakeDialog::of(spec);
    let parent = fake_parent(spec);
    let shared = SharedRecoveryState::new("0123456789abcdef");
    let user_dir = || user_data.clone();
    let now_ms = cx.now_ms;
    let now = || now_ms;
    let uuid = || "uuid".to_owned();
    let store = create_recovery_store(
        RecoveryStoreOptions {
            user_data_dir: &user_dir,
            now_ms: &now,
            random_uuid: &uuid,
        },
        &shared,
    );
    let result = resolve_recovery_on_open(&ResolveRecoveryOnOpenOptions {
        store: &store,
        identity: &identity,
        dialog: &dialog,
        parent: parent.as_ref(),
        lang: need_str(spec, "lang")?,
        document_name: field_str(spec, "documentName"),
    });
    cx.logs.extend(dialog.log.into_inner());
    let result = result.map_err(masked)?;
    let mut out = Map::new();
    match result {
        RecoveryOpenResult::Original => {
            out.insert("action".into(), Value::from("original"));
        }
        RecoveryOpenResult::Restore { bytes, copy } => {
            out.insert("action".into(), Value::from("restore"));
            out.insert("bytes".into(), Value::from(hex(&bytes)));
            out.insert("copy".into(), info_json(&copy));
        }
    }
    Ok(Some(Value::Object(out)))
}

// ---- recovery-store ----

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `{ kind, filePath }` or `{ kind, untitledId, ext }` (a key `untitledId`
/// makes it an untitled identity, as `'untitledId' in identity` does)
fn identity_of(value: &Value) -> Result<RecoveryIdentity, CallError> {
    let kind = need_str(value, "kind")?.to_owned();
    if value
        .as_object()
        .is_some_and(|o| o.contains_key("untitledId"))
    {
        return Ok(RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
            kind,
            untitled_id: need_str(value, "untitledId")?.to_owned(),
            ext: need_str(value, "ext")?.to_owned(),
        }));
    }
    Ok(RecoveryIdentity::File(RecoveryFileIdentity {
        kind,
        file_path: need_str(value, "filePath")?.to_owned(),
    }))
}

fn identity_json(identity: &RecoveryIdentity) -> Value {
    let mut out = Map::new();
    match identity {
        RecoveryIdentity::File(f) => {
            out.insert("kind".into(), Value::from(f.kind.as_str()));
            out.insert("filePath".into(), Value::from(f.file_path.as_str()));
        }
        RecoveryIdentity::Untitled(u) => {
            out.insert("kind".into(), Value::from(u.kind.as_str()));
            out.insert("untitledId".into(), Value::from(u.untitled_id.as_str()));
            out.insert("ext".into(), Value::from(u.ext.as_str()));
        }
    }
    Value::Object(out)
}

/// A modification time the case set is a whole number of seconds; one the
/// store's own write gave is the real time of the run and differs on each
/// side, so it is written `<real>`.
fn mtime_json(x: f64) -> Value {
    if x % 1000.0 == 0.0 {
        num(x)
    } else {
        Value::from("<real>")
    }
}

fn info_json(info: &RecoveryCopyInfo) -> Value {
    let text = |s: &Option<String>| s.as_deref().map_or(Value::Null, Value::from);
    let mut out = Map::new();
    out.insert("identity".into(), identity_json(&info.identity));
    out.insert("kind".into(), Value::from(info.kind.as_str()));
    out.insert("filePath".into(), text(&info.file_path));
    out.insert("untitledId".into(), text(&info.untitled_id));
    out.insert("title".into(), Value::from(info.title.as_str()));
    out.insert(
        "writtenAt".into(),
        if info.legacy {
            mtime_json(info.written_at)
        } else {
            num(info.written_at)
        },
    );
    out.insert("runId".into(), Value::from(info.run_id.as_str()));
    out.insert("state".into(), Value::from(info.state.as_str()));
    out.insert("legacy".into(), Value::Bool(info.legacy));
    out.insert("copyPath".into(), Value::from(info.copy_path.as_str()));
    out.insert("copyMtimeMs".into(), mtime_json(info.copy_mtime_ms));
    out.insert(
        "fileChangedAfterCopy".into(),
        Value::Bool(info.file_changed_after_copy),
    );
    out.insert("originalMissing".into(), Value::Bool(info.original_missing));
    out.insert("originalPath".into(), text(&info.original_path));
    out.insert(
        "formulasDropped".into(),
        info.formulas_dropped.map_or(Value::Null, num),
    );
    Value::Object(out)
}

enum StepFail {
    /// a step the specs wrote wrongly: the whole call fails
    Bad(CallError),
    /// what the TypeScript throws or rejects with: the step answers it
    Node(NodeError),
}

impl From<NodeError> for StepFail {
    fn from(e: NodeError) -> Self {
        StepFail::Node(e)
    }
}

impl From<CallError> for StepFail {
    fn from(e: CallError) -> Self {
        StepFail::Bad(e)
    }
}

type Step = Result<Option<Value>, StepFail>;

fn write_result(result: RecoveryWriteResult) -> Value {
    Value::from(match result {
        RecoveryWriteResult::Written => "written",
        RecoveryWriteResult::Superseded => "superseded",
    })
}

fn ticket_json(ticket: &RecoveryWriteTicket) -> Value {
    let mut out = Map::new();
    out.insert("key".into(), Value::from(ticket.key.as_str()));
    out.insert("epoch".into(), Value::from(ticket.epoch));
    Value::Object(out)
}

/// `title`, `ticket` (a name from `beginWrite`, or `{key, epoch}`),
/// `originalPath`, `formulasDropped` of a write step
fn write_options(
    step: &Value,
    tickets: &HashMap<String, RecoveryWriteTicket>,
) -> Result<RecoveryWriteOptions, CallError> {
    let ticket = match field(step, "ticket") {
        Some(Value::String(name)) => Some(
            tickets
                .get(name)
                .cloned()
                .ok_or_else(|| bad("a ticket taken earlier"))?,
        ),
        Some(raw @ Value::Object(_)) => Some(RecoveryWriteTicket {
            key: need_str(raw, "key")?.to_owned(),
            epoch: field(raw, "epoch")
                .and_then(Value::as_u64)
                .ok_or_else(|| bad("epoch"))?,
        }),
        _ => None,
    };
    Ok(RecoveryWriteOptions {
        title: field_str(step, "title").map(str::to_owned),
        ticket,
        original_path: field_str(step, "originalPath").map(str::to_owned),
        formulas_dropped: field(step, "formulasDropped").and_then(Value::as_f64),
    })
}

fn state_of(text: &str) -> Result<RecoveryCopyState, CallError> {
    RecoveryCopyState::parse(text).ok_or_else(|| bad("a copy state"))
}

fn filter_of(spec: Option<&Value>) -> Result<RecoveryCopyFilter, CallError> {
    let Some(spec) = spec else {
        return Ok(RecoveryCopyFilter::default());
    };
    let strings = |key: &str| -> Option<Vec<String>> {
        field(spec, key).and_then(Value::as_array).map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
    };
    Ok(RecoveryCopyFilter {
        // a name that is no state matches no copy: it is left out of the list
        states: strings("states").map(|names| {
            names
                .iter()
                .filter_map(|n| RecoveryCopyState::parse(n))
                .collect()
        }),
        kinds: strings("kinds"),
        untitled: field(spec, "untitled").and_then(Value::as_bool),
    })
}

/// `[{ userData, runId, now, steps }]`: see the module comment.
fn store_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("options"))?;
    let user_data = need_str(spec, "userData")?.to_owned();
    let run_id = field_str(spec, "runId").unwrap_or("0123456789abcdef");
    let clock = Cell::new(
        field(spec, "now")
            .and_then(Value::as_f64)
            .unwrap_or(cx.now_ms),
    );
    let counter = Cell::new(0u32);
    let shared = SharedRecoveryState::new(run_id);
    let user_dir = || user_data.clone();
    let now = || clock.get();
    let uuid = || {
        counter.set(counter.get() + 1);
        format!("uuid-{}", counter.get())
    };
    let store = create_recovery_store(
        RecoveryStoreOptions {
            user_data_dir: &user_dir,
            now_ms: &now,
            random_uuid: &uuid,
        },
        &shared,
    );
    let steps = field(spec, "steps")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?;
    // the folder of the case's original files, outside the case's folder (see the harness)
    let orig = field_str(spec, "orig");
    let clean_orig = || {
        if let Some(dir) = orig {
            let _ = fs::remove_dir_all(dir);
        }
    };
    clean_orig();
    let mut tickets: HashMap<String, RecoveryWriteTicket> = HashMap::new();
    let mut out = Vec::new();
    for step in steps {
        let op = need_str(step, "op")?;
        let mut entry = Map::new();
        entry.insert("op".into(), Value::from(op));
        let stepped = if op == "seed" {
            seed_step(orig, step)
        } else {
            run_step(op, step, &store, &shared, &clock, &counter, &mut tickets)
        };
        match stepped {
            Ok(Some(value)) => {
                entry.insert("ok".into(), value);
            }
            Ok(None) => {}
            Err(StepFail::Bad(e)) => return Err(e),
            Err(StepFail::Node(e)) => {
                let mut error = Map::new();
                error.insert("code".into(), e.code.map_or(Value::Null, Value::from));
                error.insert("message".into(), Value::from(mask_tmp(&e.message)));
                entry.insert("error".into(), Value::Object(error));
            }
        }
        out.push(Value::Object(entry));
    }
    clean_orig();
    Ok(Some(Value::Array(out)))
}

/// `seed {name, text, mtimeMs}`: an original file under the scenario's `orig`
fn seed_step(orig: Option<&str>, step: &Value) -> Step {
    let dir = orig.ok_or_else(|| bad("orig"))?;
    let path = join(&[dir, need_str(step, "name")?]);
    let text = need_str(step, "text")?;
    let ms = field(step, "mtimeMs")
        .and_then(Value::as_f64)
        .ok_or_else(|| bad("mtimeMs"))?;
    let parent = jscompat::node_path::host::dirname(&path);
    fs::create_dir_all(&parent).map_err(|e| node_error(&e, "mkdir", &parent))?;
    fs::write(&path, text).map_err(|e| node_error(&e, "open", &path))?;
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|e| node_error(&e, "open", &path))?;
    file.set_modified(UNIX_EPOCH + Duration::from_millis(ms as u64))
        .map_err(|e| node_error(&e, "utime", &path))?;
    Ok(None)
}

#[allow(clippy::too_many_arguments)]
fn run_step(
    op: &str,
    step: &Value,
    store: &RecoveryStore<'_>,
    shared: &SharedRecoveryState,
    clock: &Cell<f64>,
    counter: &Cell<u32>,
    tickets: &mut HashMap<String, RecoveryWriteTicket>,
) -> Step {
    let identity = || identity_of(field(step, "id").ok_or_else(|| bad("id"))?);
    Ok(match op {
        "now" => {
            clock.set(
                field(step, "ms")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| bad("ms"))?,
            );
            None
        }
        "touch" => {
            // a missing path is no step failure: both sides ignore it
            let ms = field(step, "mtimeMs")
                .and_then(Value::as_f64)
                .ok_or_else(|| bad("mtimeMs"))?;
            let time = UNIX_EPOCH + Duration::from_millis(ms as u64);
            if let Ok(file) = fs::OpenOptions::new()
                .write(true)
                .open(need_str(step, "path")?)
            {
                let _ = file.set_modified(time);
            }
            None
        }
        "copyPath" => Some(Value::from(store.copy_path(&identity()?)?)),
        "beginWrite" => {
            let ticket = store.begin_write(&identity()?)?;
            let json = ticket_json(&ticket);
            if let Some(name) = field_str(step, "name") {
                tickets.insert(name.to_owned(), ticket);
            }
            Some(json)
        }
        "writeCopy" => {
            let options = write_options(step, tickets)?;
            let text = need_str(step, "text")?;
            Some(write_result(store.write_copy(
                &identity()?,
                text.as_bytes(),
                &options,
            )?))
        }
        "writeStreamed" => {
            let options = write_options(step, tickets)?;
            let id = identity()?;
            let writer = field(step, "writer").ok_or_else(|| bad("writer"))?;
            let mode = need_str(writer, "mode")?;
            let text = field_str(writer, "text").unwrap_or("");
            let reason =
                RecoveryDeleteReason::parse(field_str(writer, "reason").unwrap_or("saved"))
                    .ok_or_else(|| bad("a delete reason"))?;
            let mut write = |temp: &str| -> Result<(), NodeError> {
                if mode == "nothing" {
                    return Ok(());
                }
                fs::write(temp, text).map_err(|e| node_error(&e, "open", temp))?;
                match mode {
                    "throw" => Err(NodeError {
                        code: None,
                        message: "writer failed".to_owned(),
                    }),
                    "deleteDuring" => {
                        store.delete_copy(&id, reason)?;
                        Ok(())
                    }
                    _ => Ok(()),
                }
            };
            Some(write_result(
                store.write_copy_streamed(&id, &mut write, &options)?,
            ))
        }
        "deleteCopy" => {
            let reason = RecoveryDeleteReason::parse(need_str(step, "reason")?)
                .ok_or_else(|| bad("a delete reason"))?;
            Some(Value::from(
                match store.delete_copy(&identity()?, reason)? {
                    RecoveryDeleteResult::Deleted => "deleted",
                    RecoveryDeleteResult::Refused => "refused",
                },
            ))
        }
        "isDiscarded" => Some(Value::Bool(store.is_discarded(&identity()?)?)),
        "clearDiscarded" => {
            store.clear_discarded(&identity()?)?;
            None
        }
        "copyInfo" => Some(
            store
                .copy_info(&identity()?)?
                .map_or(Value::Null, |i| info_json(&i)),
        ),
        "readCopy" => Some(
            store
                .read_copy(&identity()?)
                .map_or(Value::Null, |bytes| Value::from(hex(&bytes))),
        ),
        "openPlan" => {
            let mut plan = Map::new();
            match store.open_plan(&identity()?)? {
                RecoveryOpenPlan::None => {
                    plan.insert("action".into(), Value::from("none"));
                }
                RecoveryOpenPlan::Restore(copy) => {
                    plan.insert("action".into(), Value::from("restore"));
                    plan.insert("copy".into(), info_json(&copy));
                }
                RecoveryOpenPlan::Ask(copy) => {
                    plan.insert("action".into(), Value::from("ask"));
                    plan.insert("copy".into(), info_json(&copy));
                }
            }
            Some(Value::Object(plan))
        }
        "setCopyState" => Some(Value::Bool(
            store.set_copy_state(&identity()?, state_of(need_str(step, "state")?)?)?,
        )),
        "applyLaunchDecision" => {
            let decision = RecoveryLaunchDecision::parse(need_str(step, "decision")?)
                .ok_or_else(|| bad("a launch decision"))?;
            Some(Value::Bool(
                store.apply_launch_decision(&identity()?, decision)?,
            ))
        }
        "markCopyLoaded" => Some(Value::Bool(store.mark_copy_loaded(&identity()?)?)),
        "listCopies" => {
            let filter = filter_of(field(step, "filter"))?;
            Some(Value::Array(
                store.list_copies(&filter)?.iter().map(info_json).collect(),
            ))
        }
        "hasUnresolvedCopies" => Some(Value::Bool(store.has_unresolved_copies()?)),
        "pruneStaleCopies" => Some(Value::from(
            store.prune_stale_copies(field(step, "maxAgeMs").and_then(Value::as_f64)) as u64,
        )),
        "adoptUntitledCopy" => {
            let options = RecoveryAdoptOptions {
                title: need_str(step, "title")?.to_owned(),
                ext: need_str(step, "ext")?.to_owned(),
                state: field_str(step, "state").map(state_of).transpose()?,
                original_path: field_str(step, "originalPath").map(str::to_owned),
            };
            Some(
                store
                    .adopt_untitled_copy(
                        need_str(step, "kind")?,
                        need_str(step, "source")?,
                        &options,
                    )?
                    .map_or(Value::Null, |id| {
                        identity_json(&RecoveryIdentity::Untitled(id))
                    }),
            )
        }
        "recoveryRunId" => Some(Value::from(recovery_run_id(shared))),
        "markAppShuttingDown" => {
            mark_app_shutting_down(shared);
            None
        }
        "resetAppShuttingDown" => {
            reset_app_shutting_down(shared);
            None
        }
        "isAppShuttingDown" => Some(Value::Bool(is_app_shutting_down(shared))),
        "resumeDiscardedCopies" => {
            resume_discarded_copies(shared);
            None
        }
        "newUntitledRecoveryId" => {
            let id = new_untitled_recovery_id(&|| {
                counter.set(counter.get() + 1);
                format!("uuid-{}", counter.get())
            });
            Some(Value::from(id))
        }
        _ => return Err(StepFail::Bad(bad("a store op"))),
    })
}

// ---- unsaved-files ----

enum Unsaved {
    Set,
    Has,
    Assert,
    Without,
}

/// The source a spec describes: null (none), `{ throws: true }`, or
/// `{ returns: <what the source gives> }`.
fn source_of(spec: Option<&Value>) -> Option<OpenFilesSource> {
    let spec = spec.filter(|v| !v.is_null())?;
    let answer: Result<Vec<OpenFileState>, OpenFilesSourceFailed> =
        if field(spec, "throws").and_then(Value::as_bool) == Some(true) {
            Err(OpenFilesSourceFailed)
        } else {
            list_of(field(spec, "returns"))
        };
    Some(Box::new(move || answer.clone()))
}

/// `for (const doc of list) if (doc.dirty && doc.filePath) pathKey(doc.filePath)`
/// as the list of what the loop reads, or the failure it ends in.
fn list_of(returns: Option<&Value>) -> Result<Vec<OpenFileState>, OpenFilesSourceFailed> {
    let items = match returns {
        Some(Value::Array(items)) => items,
        // a string iterates its characters, none of which has a `dirty`
        Some(Value::String(_)) => return Ok(Vec::new()),
        _ => return Err(OpenFilesSourceFailed),
    };
    let truthy = |v: Option<&Value>| v.is_some_and(|v| json_value_from_serde(v).truthy());
    let mut out = Vec::new();
    for item in items {
        match item {
            // `null.dirty` throws
            Value::Null => return Err(OpenFilesSourceFailed),
            Value::Object(o) => {
                let dirty = truthy(o.get("dirty"));
                let file_path = o.get("filePath");
                if dirty && truthy(file_path) {
                    // `resolve` refuses what is not a string
                    let Some(Value::String(path)) = file_path else {
                        return Err(OpenFilesSourceFailed);
                    };
                    out.push(OpenFileState {
                        file_path: Some(path.clone()),
                        dirty: true,
                    });
                } else {
                    out.push(OpenFileState {
                        file_path: None,
                        dirty,
                    });
                }
            }
            _ => out.push(OpenFileState {
                file_path: None,
                dirty: false,
            }),
        }
    }
    Ok(out)
}

/// `Has`/`Assert`: `[source, path]`; `Without`: `[source, [paths]]`;
/// `Set`: `[first, second, path]` (set both in turn, then ask about `path`)
fn unsaved_call(args: &[Value], which: Unsaved) -> Answer {
    let mut holder = OpenFilesHolder::new();
    holder.set_open_files_source(source_of(arg(args, 0)));
    match which {
        Unsaved::Set => {
            holder.set_open_files_source(source_of(arg(args, 1)));
            Ok(Some(Value::Bool(file_has_unsaved_changes(
                &holder,
                str_arg(args, 2)?,
            ))))
        }
        Unsaved::Has => Ok(Some(Value::Bool(file_has_unsaved_changes(
            &holder,
            str_arg(args, 1)?,
        )))),
        Unsaved::Assert => assert_file_saved(&holder, str_arg(args, 1)?)
            .map(|()| None)
            .map_err(CallError::plain),
        Unsaved::Without => {
            let items = arg(args, 1)
                .and_then(Value::as_array)
                .ok_or_else(|| bad("items"))?;
            let paths: Vec<String> = items
                .iter()
                .map(|v| {
                    v.as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| bad("a string item"))
                })
                .collect::<Result<_, _>>()?;
            let kept = without_unsaved_files(&holder, &paths, |p| p.clone());
            Ok(Some(Value::Array(
                kept.into_iter().map(Value::from).collect(),
            )))
        }
    }
}
