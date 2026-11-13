//! The recovery part of group `b3b4-rest`
//! (tools/main-diff/groups/b3b4-rest/recovery.ts): the editors' crash-recovery
//! modules, `html/recovery` and `markdown/recovery` (one Rust module, compared
//! against both TypeScript files), `docs-recovery`, `pdf-recovery` and
//! `recovery-policy`.
//!
//! A scenario is one call: a world and a list of steps, answering one entry
//! per step (`op`, then `ok` with the value, or `error` with `code` and
//! `message`). The recovery store is the real one over the case's `userData`
//! folder, with the run id, the clock and the random ids the group
//! `b2-recovery` uses (`uuid-1`, `uuid-2`, ...). The Electron objects are the
//! fakes of the spec, and every call a fake receives is one log line, written
//! as the TypeScript fake writes it. The dialog is the shared `FakeDialog`
//! behind a wrapper that moves its lines into the scenario's log as the box is
//! shown, so they sit between the host's lines where they happened.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::rc::Rc;
use std::time::{Duration, UNIX_EPOCH};

use jscompat::node_path::host::{dirname, join};
use serde_json::{Map, Number, Value};

use super::super::fakes::{FakeDialog, FakeWindow, fake_parent};
use super::super::{Answer, CallError, Context, arg, str_arg};
use crate::docs::docs_recovery::{
    DocsCopyTarget, DocsOpenRecovery, DocsRecovery, DocsResolveOpenOptions, DocsUntitledExt,
    TakeUntitledOptions,
};
use crate::html::recovery::{
    RECOVERY_FLUSH_TIMEOUT_MS, RecoveredText, RenderGoneListener, TextRecovery,
    TextRecoveryContents, TextRecoveryHost, TitleSource,
};
use crate::node_fs::{NodeError, node_error};
use crate::packages::electron_utils::headless_mode::HeadlessMode;
use crate::packages::electron_utils::message_box::{MessageBox, MessageBoxOptions};
use crate::packages::electron_utils::recovery_contract::{
    RecoveryOpenDecision, RecoveryOpenFileRequest, RecoveryOpenUntitledRequest,
};
use crate::packages::electron_utils::recovery_store::{
    RecoveryCopyInfo, RecoveryCopyState, RecoveryDeleteReason, RecoveryDeleteResult,
    RecoveryFileIdentity, RecoveryIdentity, RecoveryStore, RecoveryStoreOptions,
    RecoveryUntitledIdentity, RecoveryWriteOptions, RecoveryWriteResult, SharedRecoveryState,
    create_recovery_store, mark_app_shutting_down, reset_app_shutting_down,
};
use crate::pdf::pdf_recovery::{
    PDF_RECOVERY_WORK_FILE_MAX_AGE_MS, PdfOpenUntitledRequest, PdfRecovery, PdfRecoveryDeps,
    pdf_looks_encrypted,
};
use crate::sheets::recovery_policy::{
    ConvertedOpenShape, LEGACY_UNSAVED_NEW_INDEX, MAX_AUTOMATIC_RECOVERY_WORKSHEET_XML_BYTES,
    RecoverySessionShape, allows_automatic_workbook_recovery, converted_session_recovery,
    legacy_copy_name, migrate_legacy_unsaved_new, save_as_default_for, session_recovery_identity,
    untitled_workbook_ext,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "html/recovery.RECOVERY_FLUSH_TIMEOUT_MS"
        | "markdown/recovery.RECOVERY_FLUSH_TIMEOUT_MS" => Ok(Some(num(RECOVERY_FLUSH_TIMEOUT_MS))),
        "html/recovery.createTextRecovery" | "markdown/recovery.createTextRecovery" => {
            text_call(args, cx)
        }
        "docs-recovery.createDocsRecovery" => docs_call(args, cx),
        "pdf-recovery.PDF_RECOVERY_WORK_FILE_MAX_AGE_MS" => {
            Ok(Some(num(PDF_RECOVERY_WORK_FILE_MAX_AGE_MS)))
        }
        "pdf-recovery.pdfLooksEncrypted" => encrypted_call(args),
        "pdf-recovery.createPdfRecovery" => pdf_call(args, cx),
        "recovery-policy.MAX_AUTOMATIC_RECOVERY_WORKSHEET_XML_BYTES" => {
            Ok(Some(num(MAX_AUTOMATIC_RECOVERY_WORKSHEET_XML_BYTES)))
        }
        "recovery-policy.allowsAutomaticWorkbookRecovery" => allows_call(args),
        "recovery-policy.sessionRecoveryIdentity" => session_call(args),
        "recovery-policy.convertedSessionRecovery" => converted_call(args),
        "recovery-policy.saveAsDefaultFor" => {
            str_arg(args, 0).map(|path| Some(Value::from(save_as_default_for(path))))
        }
        "recovery-policy.untitledWorkbookExt" => {
            str_arg(args, 0).map(|path| Some(Value::from(untitled_workbook_ext(path))))
        }
        "recovery-policy.LEGACY_UNSAVED_NEW_INDEX" => {
            Ok(Some(Value::from(LEGACY_UNSAVED_NEW_INDEX)))
        }
        "recovery-policy.legacyCopyName" => {
            str_arg(args, 0).map(|path| Some(Value::from(legacy_copy_name(path))))
        }
        "recovery-policy.migrateLegacyUnsavedNew" => migrate_call(args, cx),
        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// the shared scenario machinery
// ---------------------------------------------------------------------------

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

fn log_line(log: &Log, items: Vec<Value>) {
    log.borrow_mut().push(items);
}

fn text(x: &str) -> Value {
    Value::from(x)
}

fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn thrown(message: &str) -> NodeError {
    NodeError {
        code: None,
        message: message.to_owned(),
    }
}

fn field<'a>(object: &'a Value, key: &str) -> Option<&'a Value> {
    object.get(key)
}

fn field_str<'a>(object: &'a Value, key: &str) -> Option<&'a str> {
    field(object, key).and_then(Value::as_str)
}

fn field_bool(object: &Value, key: &str) -> bool {
    field(object, key).and_then(Value::as_bool).unwrap_or(false)
}

fn need_str<'a>(object: &'a Value, key: &str) -> Result<&'a str, CallError> {
    field_str(object, key).ok_or_else(|| bad(&format!("`{key}` a string")))
}

fn need_i64(object: &Value, key: &str) -> Result<i64, CallError> {
    field(object, key)
        .and_then(Value::as_i64)
        .ok_or_else(|| bad(&format!("`{key}` an integer")))
}

fn need_usize(object: &Value, key: &str) -> Result<usize, CallError> {
    field(object, key)
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .ok_or_else(|| bad(&format!("`{key}` an index")))
}

fn list(value: Option<&Value>) -> &[Value] {
    match value.and_then(Value::as_array) {
        Some(items) => items.as_slice(),
        None => &[],
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
            out.insert("kind".into(), text(&f.kind));
            out.insert("filePath".into(), text(&f.file_path));
        }
        RecoveryIdentity::Untitled(u) => {
            out.insert("kind".into(), text(&u.kind));
            out.insert("untitledId".into(), text(&u.untitled_id));
            out.insert("ext".into(), text(&u.ext));
        }
    }
    Value::Object(out)
}

fn untitled_json(identity: &RecoveryUntitledIdentity) -> Value {
    identity_json(&RecoveryIdentity::Untitled(identity.clone()))
}

fn optional_text(value: &Option<String>) -> Value {
    value.as_deref().map_or(Value::Null, Value::from)
}

/// the copy's description as the scenarios print it
fn info_out(info: Option<&RecoveryCopyInfo>) -> Value {
    let Some(info) = info else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert("state".into(), text(info.state.as_str()));
    out.insert("title".into(), text(&info.title));
    out.insert("legacy".into(), Value::Bool(info.legacy));
    out.insert("originalMissing".into(), Value::Bool(info.original_missing));
    out.insert(
        "fileChangedAfterCopy".into(),
        Value::Bool(info.file_changed_after_copy),
    );
    out.insert("originalPath".into(), optional_text(&info.original_path));
    Value::Object(out)
}

fn write_result(result: RecoveryWriteResult) -> Value {
    text(match result {
        RecoveryWriteResult::Written => "written",
        RecoveryWriteResult::Superseded => "superseded",
    })
}

fn delete_result(result: RecoveryDeleteResult) -> Value {
    text(match result {
        RecoveryDeleteResult::Deleted => "deleted",
        RecoveryDeleteResult::Refused => "refused",
    })
}

/// `none` is what `step.decision ?? undefined` is, `Some` a decision the shell made
fn decision_of(value: Option<&Value>) -> Option<RecoveryOpenDecision> {
    match value.and_then(Value::as_str) {
        Some("restore") => Some(RecoveryOpenDecision::Restore),
        Some("original") => Some(RecoveryOpenDecision::Original),
        _ => None,
    }
}

/// what a step raised: a step the spec got wrong, or what the TypeScript throws
enum Raised {
    Bad(CallError),
    Node(NodeError),
}

impl From<CallError> for Raised {
    fn from(error: CallError) -> Self {
        Raised::Bad(error)
    }
}

impl From<NodeError> for Raised {
    fn from(error: NodeError) -> Self {
        Raised::Node(error)
    }
}

type StepResult = Result<Option<Value>, Raised>;

/// the world of a scenario: the store, its state, the clock, the random ids
struct Env<'e> {
    store: &'e RecoveryStore<'e>,
    shared: &'e SharedRecoveryState,
    headless: &'e HeadlessMode,
    uuid: &'e dyn Fn() -> String,
    clock: &'e Cell<f64>,
    orig: Option<&'e str>,
    log: &'e Log,
}

fn clean_orig(orig: Option<&str>) {
    if let Some(dir) = orig {
        let _ = fs::remove_dir_all(dir);
    }
}

/// Runs `run` in the world `spec` describes (`userData`, `orig`, `runId`,
/// `now`, `headless`) and moves the log of the scenario into `cx`.
fn with_env(
    spec: &Value,
    cx: &mut Context,
    run: impl FnOnce(&Env<'_>) -> Result<Value, CallError>,
) -> Answer {
    let user_data = need_str(spec, "userData")?.to_owned();
    let clock = Cell::new(
        field(spec, "now")
            .and_then(Value::as_f64)
            .unwrap_or(cx.now_ms),
    );
    let counter = Cell::new(0u32);
    let shared = SharedRecoveryState::new(field_str(spec, "runId").unwrap_or("0123456789abcdef"));
    let headless = HeadlessMode::new();
    headless.set_headless_mode(field_bool(spec, "headless"));
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
    let orig = field_str(spec, "orig");
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let env = Env {
        store: &store,
        shared: &shared,
        headless: &headless,
        uuid: &uuid,
        clock: &clock,
        orig,
        log: &log,
    };
    clean_orig(orig);
    let result = run(&env);
    clean_orig(orig);
    cx.logs.extend(log.borrow_mut().drain(..));
    result.map(Some)
}

/// `seed {name, text, mtimeMs}`: an original file under the scenario's `orig`
fn seed_step(orig: Option<&str>, step: &Value) -> StepResult {
    let dir = orig.ok_or_else(|| bad("orig"))?;
    let path = join(&[dir, need_str(step, "name")?]);
    let body = need_str(step, "text")?;
    let ms = field(step, "mtimeMs")
        .and_then(Value::as_f64)
        .ok_or_else(|| bad("mtimeMs"))?;
    let parent = dirname(&path);
    fs::create_dir_all(&parent).map_err(|e| node_error(&e, "mkdir", &parent))?;
    fs::write(&path, body).map_err(|e| node_error(&e, "open", &path))?;
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|e| node_error(&e, "open", &path))?;
    file.set_modified(UNIX_EPOCH + Duration::from_millis(ms as u64))
        .map_err(|e| node_error(&e, "utime", &path))?;
    Ok(None)
}

/// the steps every scenario shares: they arrange and read the store itself
fn store_step(op: &str, step: &Value, env: &Env<'_>) -> Option<StepResult> {
    let ours = matches!(
        op,
        "now"
            | "seed"
            | "storeWrite"
            | "storeRead"
            | "storeInfo"
            | "storeState"
            | "storeDelete"
            | "storeIsDiscarded"
            | "shutdown"
            | "ls"
    );
    ours.then(|| store_step_of(op, step, env))
}

fn store_step_of(op: &str, step: &Value, env: &Env<'_>) -> StepResult {
    let identity = || identity_of(field(step, "id").ok_or_else(|| bad("id"))?);
    Ok(match op {
        "now" => {
            env.clock.set(
                field(step, "ms")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| bad("ms"))?,
            );
            None
        }
        "seed" => return seed_step(env.orig, step),
        "storeWrite" => {
            let options = RecoveryWriteOptions {
                title: field_str(step, "title").map(str::to_owned),
                original_path: field_str(step, "originalPath").map(str::to_owned),
                ..RecoveryWriteOptions::default()
            };
            let body = need_str(step, "text")?;
            Some(write_result(env.store.write_copy(
                &identity()?,
                body.as_bytes(),
                &options,
            )?))
        }
        "storeRead" => Some(
            env.store
                .read_copy(&identity()?)
                .map_or(Value::Null, |bytes| {
                    Value::from(String::from_utf8_lossy(&bytes).into_owned())
                }),
        ),
        "storeInfo" => Some(info_out(env.store.copy_info(&identity()?)?.as_ref())),
        "storeState" => {
            let state = RecoveryCopyState::parse(need_str(step, "state")?)
                .ok_or_else(|| bad("a copy state"))?;
            Some(Value::Bool(env.store.set_copy_state(&identity()?, state)?))
        }
        "storeDelete" => {
            let reason = RecoveryDeleteReason::parse(need_str(step, "reason")?)
                .ok_or_else(|| bad("a delete reason"))?;
            Some(delete_result(env.store.delete_copy(&identity()?, reason)?))
        }
        "storeIsDiscarded" => Some(Value::Bool(env.store.is_discarded(&identity()?)?)),
        "shutdown" => {
            if field_bool(step, "on") {
                mark_app_shutting_down(env.shared);
            } else {
                reset_app_shutting_down(env.shared);
            }
            None
        }
        "ls" => Some(match fs::read_dir(need_str(step, "dir")?) {
            Ok(read) => {
                let mut names: Vec<String> = read
                    .filter_map(Result::ok)
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .collect();
                names.sort();
                Value::Array(names.into_iter().map(Value::from).collect())
            }
            Err(_) => Value::Null,
        }),
        _ => return Err(Raised::Bad(bad("a step"))),
    })
}

/// every step in order, one entry each
fn play(
    steps: &[Value],
    env: &Env<'_>,
    handle: &mut dyn FnMut(&str, &Value) -> StepResult,
) -> Result<Value, CallError> {
    let mut out = Vec::new();
    for step in steps {
        let op = need_str(step, "op")?;
        let mut entry = Map::new();
        entry.insert("op".into(), text(op));
        let result = match store_step(op, step, env) {
            Some(result) => result,
            None => handle(op, step),
        };
        match result {
            Ok(Some(value)) => {
                entry.insert("ok".into(), value);
            }
            Ok(None) => {}
            Err(Raised::Bad(error)) => return Err(error),
            Err(Raised::Node(error)) => {
                let mut raised = Map::new();
                raised.insert("code".into(), error.code.map_or(Value::Null, Value::from));
                raised.insert("message".into(), Value::from(mask_tmp(&error.message)));
                entry.insert("error".into(), Value::Object(raised));
            }
        }
        out.push(Value::Object(entry));
    }
    Ok(Value::Array(out))
}

/// the shared `FakeDialog`, its lines moved into the scenario's log as each box is shown
struct LoggedDialog {
    inner: FakeDialog,
    log: Log,
}

impl LoggedDialog {
    fn of(spec: &Value, log: &Log) -> LoggedDialog {
        LoggedDialog {
            inner: FakeDialog::of(spec),
            log: Rc::clone(log),
        }
    }

    fn flush(&self) {
        for line in self.inner.log.borrow_mut().drain(..) {
            self.log.borrow_mut().push(line);
        }
    }
}

impl MessageBox<FakeWindow> for LoggedDialog {
    fn show_message_box_over(&self, parent: &FakeWindow, options: &MessageBoxOptions) -> f64 {
        let answer = self.inner.show_message_box_over(parent, options);
        self.flush();
        answer
    }

    fn show_message_box(&self, options: &MessageBoxOptions) -> f64 {
        let answer = self.inner.show_message_box(options);
        self.flush();
        answer
    }
}

fn warn_line(log: &Log, message: &str, detail: &str) {
    log_line(
        log,
        vec![text("warn"), text(message), Value::from(mask_tmp(detail))],
    );
}

// ---------------------------------------------------------------------------
// html/recovery and markdown/recovery
// ---------------------------------------------------------------------------

/// a view of the scenario's world: what the editor's host answers about it
struct ViewFake {
    id: i64,
    save_path: Option<String>,
    open_path: Option<String>,
    dirty: bool,
    destroyed: bool,
    send_throws: bool,
    /// the view's spec, whose `parent` is `null`, "live" or "destroyed"
    spec: Value,
}

type View = Rc<RefCell<ViewFake>>;

/// a `WebContents`: the view's id, and the calls it receives
#[derive(Clone)]
struct Wc {
    name: String,
    view: View,
    log: Log,
}

impl TextRecoveryContents for Wc {
    fn id(&self) -> i64 {
        self.view.borrow().id
    }

    fn is_destroyed(&self) -> bool {
        self.view.borrow().destroyed
    }

    fn reload(&self) {
        log_line(&self.log, vec![text("reload"), text(&self.name)]);
    }

    fn send(&self, channel: &str) -> Result<(), NodeError> {
        log_line(
            &self.log,
            vec![text("send"), text(&self.name), text(channel)],
        );
        if self.view.borrow().send_throws {
            return Err(thrown("send failed"));
        }
        Ok(())
    }
}

struct TextHost {
    kind: String,
    untitled_ext: String,
    lang: String,
    fallback: String,
    restored_file: bool,
    views: Vec<View>,
    log: Log,
    dialog: LoggedDialog,
}

impl TextHost {
    fn by_id(&self, id: i64) -> Option<View> {
        self.views
            .iter()
            .find(|view| view.borrow().id == id)
            .cloned()
    }
}

impl TextRecoveryHost for TextHost {
    type Contents = Wc;
    type Window = FakeWindow;
    type Dialog = LoggedDialog;

    fn kind(&self) -> &str {
        &self.kind
    }

    fn untitled_ext(&self) -> String {
        self.untitled_ext.clone()
    }

    fn dialog(&self) -> &LoggedDialog {
        &self.dialog
    }

    fn parent_of(&self, contents: &Wc) -> Option<FakeWindow> {
        let view = contents.view.borrow();
        fake_parent(&view.spec)
    }

    fn lang(&self) -> String {
        self.lang.clone()
    }

    fn save_path(&self, wc_id: i64) -> Option<String> {
        let view = self.by_id(wc_id)?;
        let view = view.borrow();
        view.save_path.clone()
    }

    fn open_path(&self, wc_id: i64) -> Option<String> {
        let view = self.by_id(wc_id)?;
        let view = view.borrow();
        view.open_path.clone()
    }

    fn is_dirty(&self, wc_id: i64) -> bool {
        match self.by_id(wc_id) {
            Some(view) => view.borrow().dirty,
            None => false,
        }
    }

    fn adopt_file(&self, contents: &Wc, file_path: &str) {
        log_line(
            &self.log,
            vec![text("adoptFile"), text(&contents.name), text(file_path)],
        );
        let mut view = contents.view.borrow_mut();
        view.open_path = Some(file_path.to_owned());
        view.save_path = Some(file_path.to_owned());
    }

    fn restored_file(&self, wc_id: i64, file_path: &str) {
        if self.restored_file {
            log_line(
                &self.log,
                vec![text("restoredFile"), Value::from(wc_id), text(file_path)],
            );
        }
    }

    fn untitled_fallback_title(&self) -> String {
        self.fallback.clone()
    }

    fn flush_channel(&self) -> String {
        "flush-recovery".to_owned()
    }

    fn warn(&self, message: &str, detail: &str) {
        warn_line(&self.log, message, detail);
    }
}

fn recovered_json(recovered: Option<RecoveredText>) -> Value {
    let Some(recovered) = recovered else {
        return Value::Null;
    };
    let mut out = Map::new();
    out.insert("text".into(), Value::from(recovered.text));
    if let Some(path) = recovered.original_path {
        out.insert("originalPath".into(), Value::from(path));
    }
    Value::Object(out)
}

fn text_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("a scenario"))?;
    with_env(spec, cx, |env| run_text(spec, env))
}

fn run_text(spec: &Value, env: &Env<'_>) -> Result<Value, CallError> {
    let mut views: Vec<(String, View)> = Vec::new();
    if let Some(table) = field(spec, "views").and_then(Value::as_object) {
        for (name, view) in table {
            views.push((
                name.clone(),
                Rc::new(RefCell::new(ViewFake {
                    id: need_i64(view, "id")?,
                    save_path: field_str(view, "savePath").map(str::to_owned),
                    open_path: field_str(view, "openPath").map(str::to_owned),
                    dirty: field_bool(view, "dirty"),
                    destroyed: field_bool(view, "destroyed"),
                    send_throws: field_bool(view, "sendThrows"),
                    spec: view.clone(),
                })),
            ));
        }
    }
    let contents: Vec<(String, Wc)> = views
        .iter()
        .map(|(name, view)| {
            (
                name.clone(),
                Wc {
                    name: name.clone(),
                    view: Rc::clone(view),
                    log: Rc::clone(env.log),
                },
            )
        })
        .collect();
    let host = TextHost {
        kind: need_str(spec, "kind")?.to_owned(),
        untitled_ext: need_str(spec, "untitledExt")?.to_owned(),
        lang: field_str(spec, "lang").unwrap_or("en").to_owned(),
        fallback: field_str(spec, "fallbackTitle")
            .unwrap_or("Untitled")
            .to_owned(),
        restored_file: !field_bool(spec, "noRestoredFile"),
        views: views.iter().map(|(_, view)| Rc::clone(view)).collect(),
        log: Rc::clone(env.log),
        dialog: LoggedDialog::of(spec, env.log),
    };
    let recovery = TextRecovery::new(host, env.store, env.headless, env.uuid);
    let wc_of = |step: &Value| -> Result<Wc, CallError> {
        let name = need_str(step, "view")?;
        contents
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, wc)| wc.clone())
            .ok_or_else(|| bad("a view"))
    };
    let listeners: RefCell<Vec<(String, RenderGoneListener<Wc>)>> = RefCell::new(Vec::new());
    let kept: RefCell<HashMap<String, Option<RecoveryIdentity>>> = RefCell::new(HashMap::new());
    let rounds: RefCell<Vec<crate::html::recovery::FlushRound>> = RefCell::new(Vec::new());
    let waiters: RefCell<Vec<crate::html::recovery::FlushWaiter>> = RefCell::new(Vec::new());
    let fired: RefCell<HashSet<u64>> = RefCell::new(HashSet::new());
    let steps = list(field(spec, "steps"));
    let mut handle = |op: &str, step: &Value| -> StepResult {
        Ok(match op {
            "track" => {
                let wc = wc_of(step)?;
                let listener = recovery.track(&wc);
                listeners.borrow_mut().push((wc.name.clone(), listener));
                None
            }
            "crash" => {
                let name = need_str(step, "view")?;
                for (view, listener) in listeners.borrow().iter() {
                    if view == name {
                        recovery.render_process_gone(listener);
                    }
                }
                None
            }
            "write" => {
                let wc = wc_of(step)?;
                let body = field_str(step, "text");
                Some(text(recovery.write_copy(&wc, body)?.as_str()))
            }
            "forget" => {
                recovery.forget(wc_of(step)?.id());
                None
            }
            "identity" => {
                let identity = recovery.identity_of(wc_of(step)?.id());
                if let Some(name) = field_str(step, "as") {
                    kept.borrow_mut().insert(name.to_owned(), identity.clone());
                }
                Some(identity.as_ref().map_or(Value::Null, identity_json))
            }
            "saved" => {
                let before = match field(step, "before") {
                    Some(Value::String(name)) => kept.borrow().get(name).cloned().flatten(),
                    Some(Value::Object(_)) => Some(identity_of(&step["before"])?),
                    _ => None,
                };
                recovery.saved(wc_of(step)?.id(), before.as_ref());
                None
            }
            "dontSave" => {
                recovery.dont_save(wc_of(step)?.id());
                None
            }
            "renamed" => {
                recovery.renamed(wc_of(step)?.id(), need_str(step, "old")?)?;
                None
            }
            "saveToPathFailed" => {
                recovery.save_to_path_failed(wc_of(step)?.id(), need_str(step, "path")?);
                None
            }
            "resolve" => Some(recovered_json(recovery.resolve_open(&wc_of(step)?))),
            "saveAsDefault" => recovery
                .save_as_default_path(wc_of(step)?.id())
                .map(Value::from),
            "setTitle" => {
                recovery.set_title(wc_of(step)?.id(), need_str(step, "title")?);
                None
            }
            "titleSource" => {
                let source: Option<TitleSource<Wc>> = match field_str(step, "mode") {
                    None => None,
                    Some(mode) => {
                        let mode = mode.to_owned();
                        let body = field_str(step, "text").map(str::to_owned);
                        let log = Rc::clone(env.log);
                        Some(Rc::new(move |c: &Wc| {
                            log_line(&log, vec![text("titleOf"), text(&c.name)]);
                            if mode == "throws" {
                                return Err(thrown("title failed"));
                            }
                            if mode == "undefined" {
                                return Ok(None);
                            }
                            Ok(body.clone())
                        }))
                    }
                };
                recovery.set_title_source(source);
                None
            }
            "flush" => {
                let round = recovery.write_copies_now();
                let started: Vec<Value> = round
                    .waiters
                    .iter()
                    .map(|_| num(RECOVERY_FLUSH_TIMEOUT_MS))
                    .collect();
                waiters.borrow_mut().extend(round.waiters.iter().cloned());
                rounds.borrow_mut().push(round);
                Some(Value::Array(started))
            }
            "timeout" => {
                let at = need_usize(step, "n")?;
                let token = waiters
                    .borrow()
                    .get(at)
                    .map(|waiter| waiter.token)
                    .ok_or_else(|| bad("a timer"))?;
                fired.borrow_mut().insert(token);
                recovery.flush_timeout(token);
                None
            }
            "timers" => Some(Value::Array(
                waiters
                    .borrow()
                    .iter()
                    .map(|waiter| {
                        text(if fired.borrow().contains(&waiter.token) {
                            "fired"
                        } else if recovery.waiter_settled(waiter.token) {
                            "cleared"
                        } else {
                            "pending"
                        })
                    })
                    .collect(),
            )),
            "flushDone" => {
                let at = need_usize(step, "n")?;
                let rounds = rounds.borrow();
                let round = rounds.get(at).ok_or_else(|| bad("a round"))?;
                Some(Value::Bool(recovery.flush_settled(round)))
            }
            "openFile" => {
                let decision =
                    decision_of(field(step, "decision")).ok_or_else(|| bad("a decision"))?;
                recovery.open_file_with_decision(
                    &wc_of(step)?,
                    &RecoveryOpenFileRequest {
                        file_path: need_str(step, "filePath")?.to_owned(),
                        decision,
                    },
                );
                None
            }
            "openUntitled" => {
                recovery.open_untitled_copy(
                    &wc_of(step)?,
                    &RecoveryOpenUntitledRequest {
                        copy: identity_of(field(step, "copy").ok_or_else(|| bad("copy"))?)?,
                        title: need_str(step, "title")?.to_owned(),
                        save_as_default_path: field_str(step, "saveAsDefaultPath")
                            .map(str::to_owned),
                    },
                );
                None
            }
            "unprotectable" => Some(Value::Bool(recovery.is_unprotectable(&wc_of(step)?))),
            "kind" => Some(text(recovery.kind())),
            "set" => {
                let wc = wc_of(step)?;
                let mut view = wc.view.borrow_mut();
                for key in ["dirty", "destroyed", "sendThrows"] {
                    if let Some(value) = field(step, key) {
                        let value = value.as_bool().unwrap_or(false);
                        match key {
                            "dirty" => view.dirty = value,
                            "destroyed" => view.destroyed = value,
                            _ => view.send_throws = value,
                        }
                    }
                }
                for key in ["savePath", "openPath"] {
                    if let Some(value) = field(step, key) {
                        let value = value.as_str().map(str::to_owned);
                        if key == "savePath" {
                            view.save_path = value;
                        } else {
                            view.open_path = value;
                        }
                    }
                }
                None
            }
            _ => return Err(Raised::Bad(bad("a step"))),
        })
    };
    play(steps, env, &mut handle)
}

// ---------------------------------------------------------------------------
// docs-recovery
// ---------------------------------------------------------------------------

fn docs_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("a scenario"))?;
    with_env(spec, cx, |env| run_docs(spec, env))
}

fn docs_ext(value: &str) -> Result<DocsUntitledExt, CallError> {
    match value {
        ".docx" => Ok(DocsUntitledExt::Docx),
        ".odt" => Ok(DocsUntitledExt::Odt),
        _ => Err(bad("an untitled extension")),
    }
}

fn run_docs(spec: &Value, env: &Env<'_>) -> Result<Value, CallError> {
    let recovery = DocsRecovery::new(env.store, env.headless, env.uuid);
    let dialog = LoggedDialog::of(spec, env.log);
    let parent = fake_parent(spec);
    let lang = field_str(spec, "lang").unwrap_or("en").to_owned();
    let steps = list(field(spec, "steps"));
    let mut handle = |op: &str, step: &Value| -> StepResult {
        let tab = || need_i64(step, "tab");
        Ok(match op {
            "write" => {
                let target_spec = field(step, "target").ok_or_else(|| bad("target"))?;
                let target = match field_str(target_spec, "filePath") {
                    Some(path) => DocsCopyTarget::File(path.to_owned()),
                    None => {
                        DocsCopyTarget::Untitled(docs_ext(need_str(target_spec, "untitledExt")?)?)
                    }
                };
                let made = field(step, "prepare").ok_or_else(|| bad("prepare"))?;
                let mode = need_str(made, "mode")?;
                let tab = tab()?;
                let mut prepare = || -> Result<Option<Vec<u8>>, NodeError> {
                    log_line(env.log, vec![text("prepare"), text(mode)]);
                    if mode == "throws" {
                        return Err(thrown("prepare failed"));
                    }
                    if mode == "null" {
                        return Ok(None);
                    }
                    if let Some(during) = field(made, "during") {
                        let during_tab = field(during, "tab").and_then(Value::as_i64).unwrap_or(0);
                        match field_str(during, "op") {
                            Some("discard") => {
                                recovery.discard(during_tab, field_str(during, "filePath"))?
                            }
                            Some("noteSaved") => {
                                let paths: Vec<String> = list(field(during, "paths"))
                                    .iter()
                                    .filter_map(|path| path.as_str().map(str::to_owned))
                                    .collect();
                                recovery.note_saved(during_tab, &paths)?
                            }
                            _ => {}
                        }
                    }
                    Ok(Some(
                        field_str(made, "text").unwrap_or("").as_bytes().to_vec(),
                    ))
                };
                let result = recovery.write_copy(
                    tab,
                    &target,
                    &mut prepare,
                    need_str(step, "title")?,
                    field_str(step, "originalPath"),
                )?;
                Some(text(match result {
                    crate::docs::docs_recovery::DocsWriteResult::Written => "written",
                    crate::docs::docs_recovery::DocsWriteResult::Skipped => "skipped",
                }))
            }
            "noteSaved" => {
                let paths: Vec<String> = list(field(step, "paths"))
                    .iter()
                    .filter_map(|path| path.as_str().map(str::to_owned))
                    .collect();
                recovery.note_saved(tab()?, &paths)?;
                None
            }
            "noteCloseCheck" => {
                recovery.note_close_check(tab()?, field_bool(step, "dirty"));
                None
            }
            "discard" => {
                recovery.discard(tab()?, field_str(step, "filePath"))?;
                None
            }
            "noteClosedSaved" => {
                recovery.note_closed_saved(tab()?);
                None
            }
            "abandon" => {
                recovery.abandon(tab()?, field_str(step, "filePath"))?;
                None
            }
            "noteStillOpen" => {
                recovery.note_still_open(tab()?);
                None
            }
            "restoreFailed" => {
                recovery.restore_failed(need_str(step, "filePath")?)?;
                None
            }
            "settle" => {
                recovery.settle_closed_document(tab()?, field_bool(step, "crashed"))?;
                None
            }
            "resolve" => {
                let result = recovery.resolve_open(&DocsResolveOpenOptions {
                    file_path: need_str(step, "filePath")?,
                    decision: decision_of(field(step, "decision")),
                    dialog: &dialog,
                    parent: parent.as_ref(),
                    lang: &lang,
                })?;
                let mut out = Map::new();
                match result {
                    DocsOpenRecovery::Restore { bytes, copy } => {
                        out.insert("action".into(), text("restore"));
                        out.insert(
                            "text".into(),
                            Value::from(String::from_utf8_lossy(&bytes).into_owned()),
                        );
                        out.insert("copy".into(), info_out(copy.as_deref()));
                    }
                    DocsOpenRecovery::Original => {
                        out.insert("action".into(), text("original"));
                    }
                }
                Some(Value::Object(out))
            }
            "take" => {
                let copy = identity_of(field(step, "copy").ok_or_else(|| bad("copy"))?)?;
                let accept = need_str(step, "accept")?;
                let accept_all = |_: &[u8]| true;
                let accept_none = |_: &[u8]| false;
                let accept_non_empty = |bytes: &[u8]| !bytes.is_empty();
                let accept: &dyn Fn(&[u8]) -> bool = match accept {
                    "all" => &accept_all,
                    "none" => &accept_none,
                    _ => &accept_non_empty,
                };
                let taken = recovery.take_untitled_copy(
                    tab()?,
                    &copy,
                    &TakeUntitledOptions {
                        title: need_str(step, "title")?,
                        ext: docs_ext(need_str(step, "ext")?)?,
                        accept,
                    },
                )?;
                Some(match taken {
                    Some(taken) => {
                        let mut out = Map::new();
                        out.insert(
                            "text".into(),
                            Value::from(String::from_utf8_lossy(&taken.bytes).into_owned()),
                        );
                        out.insert("identity".into(), untitled_json(&taken.identity));
                        Value::Object(out)
                    }
                    None => Value::Null,
                })
            }
            "untitledOf" => Some(
                recovery
                    .untitled_of(tab()?)
                    .as_ref()
                    .map_or(Value::Null, untitled_json),
            ),
            "fileIdentity" => Some(identity_json(&RecoveryIdentity::File(
                recovery.file_identity(need_str(step, "filePath")?),
            ))),
            _ => return Err(Raised::Bad(bad("a step"))),
        })
    };
    play(steps, env, &mut handle)
}

// ---------------------------------------------------------------------------
// pdf-recovery
// ---------------------------------------------------------------------------

/// `hex` as the bytes it spells
fn hex_bytes(hex: &str) -> Result<Vec<u8>, CallError> {
    if !hex.len().is_multiple_of(2) {
        return Err(bad("an even hex string"));
    }
    (0..hex.len())
        .step_by(2)
        .map(|at| {
            hex.get(at..at + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| bad("a hex string"))
        })
        .collect()
}

fn encrypted_call(args: &[Value]) -> Answer {
    let bytes = hex_bytes(str_arg(args, 0)?)?;
    Ok(Some(Value::Bool(pdf_looks_encrypted(&bytes))))
}

#[derive(Clone, Copy, PartialEq)]
enum StoreMode {
    Ok,
    None,
    Throws,
}

struct PdfWorld<'e> {
    store: &'e RecoveryStore<'e>,
    mode: StoreMode,
    dialog: LoggedDialog,
    parent_spec: Value,
    lang: String,
    prefix: String,
    work_dir: String,
    uuid: &'e dyn Fn() -> String,
    clock: &'e Cell<f64>,
    log: Log,
}

impl<'e> PdfRecoveryDeps for PdfWorld<'e> {
    type Window = FakeWindow;
    type Dialog = LoggedDialog;

    fn store(&self) -> Result<Option<&RecoveryStore<'_>>, NodeError> {
        match self.mode {
            StoreMode::Throws => Err(thrown("no store")),
            StoreMode::None => Ok(None),
            StoreMode::Ok => Ok(Some(self.store)),
        }
    }

    fn dialog(&self) -> &LoggedDialog {
        &self.dialog
    }

    fn parent_of(&self, _contents_id: i64) -> Option<FakeWindow> {
        fake_parent(&self.parent_spec)
    }

    fn lang(&self) -> String {
        self.lang.clone()
    }

    fn is_untitled_copy_path(&self, path: &str) -> bool {
        path.starts_with(&self.prefix)
    }

    fn work_dir(&self) -> String {
        self.work_dir.clone()
    }

    fn random_uuid(&self) -> String {
        (self.uuid)()
    }

    fn now_ms(&self) -> f64 {
        self.clock.get()
    }

    fn warn(&self, message: &str, detail: &str) {
        warn_line(&self.log, message, detail);
    }
}

fn pdf_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("a scenario"))?;
    with_env(spec, cx, |env| run_pdf(spec, env))
}

fn run_pdf(spec: &Value, env: &Env<'_>) -> Result<Value, CallError> {
    let mode = match field_str(spec, "storeMode") {
        Some("none") => StoreMode::None,
        Some("throws") => StoreMode::Throws,
        _ => StoreMode::Ok,
    };
    let recovery = PdfRecovery::new(PdfWorld {
        store: env.store,
        mode,
        dialog: LoggedDialog::of(spec, env.log),
        parent_spec: spec.clone(),
        lang: field_str(spec, "lang").unwrap_or("en").to_owned(),
        prefix: field_str(spec, "untitledPrefix")
            .unwrap_or("/skill-tmp/")
            .to_owned(),
        work_dir: need_str(spec, "workDir")?.to_owned(),
        uuid: env.uuid,
        clock: env.clock,
        log: Rc::clone(env.log),
    });
    let steps = list(field(spec, "steps"));
    let mut handle = |op: &str, step: &Value| -> StepResult {
        let id = || need_i64(step, "id");
        let path = || need_str(step, "path");
        Ok(match op {
            "resolvedNow" => Some(Value::Bool(recovery.resolved_now(id()?, path()?))),
            "resolveOnOpen" => {
                recovery.resolve_on_open(id()?, path()?);
                None
            }
            "markConsumed" => {
                recovery.mark_consumed(id()?);
                None
            }
            "hasConsumed" => Some(Value::Bool(recovery.has_consumed(id()?))),
            "setDecision" => {
                let decision =
                    decision_of(field(step, "decision")).ok_or_else(|| bad("a decision"))?;
                recovery.set_decision(id()?, path()?, decision);
                None
            }
            "viewBytes" => Some(
                recovery
                    .view_bytes(id()?, path()?)
                    .map_or(Value::Null, |bytes| {
                        Value::from(String::from_utf8_lossy(&bytes).into_owned())
                    }),
            ),
            "unsavedFromCopy" => Some(Value::Bool(recovery.unsaved_from_copy(id()?, path()?))),
            "write" => {
                let made = field(step, "make").ok_or_else(|| bad("make"))?;
                let mode = need_str(made, "mode")?;
                let mut serialize = || -> Result<Option<Vec<u8>>, NodeError> {
                    log_line(env.log, vec![text("make"), text(mode)]);
                    if mode == "throws" {
                        return Err(thrown("make failed"));
                    }
                    if mode == "null" {
                        return Ok(None);
                    }
                    if let Some(during) = field(made, "during")
                        && field_str(during, "op") == Some("dontSave")
                    {
                        recovery.dont_save(
                            field(during, "id").and_then(Value::as_i64).unwrap_or(0),
                            field_str(during, "path"),
                        );
                    }
                    Ok(Some(
                        field_str(made, "text").unwrap_or("").as_bytes().to_vec(),
                    ))
                };
                Some(text(
                    recovery.write_copy(id()?, path()?, &mut serialize).as_str(),
                ))
            }
            "savedInPlace" => {
                let written = field(step, "written").ok_or_else(|| bad("written"))?;
                let mode = need_str(written, "mode")?;
                let mut read_back = || -> Result<Vec<u8>, NodeError> {
                    log_line(env.log, vec![text("written"), text(mode)]);
                    if mode == "throws" {
                        return Err(thrown("read back failed"));
                    }
                    Ok(field_str(written, "text").unwrap_or("").as_bytes().to_vec())
                };
                recovery.saved_in_place(id()?, path()?, &mut read_back);
                None
            }
            "adopted" => {
                recovery.adopted(id()?, need_str(step, "old")?, need_str(step, "target")?);
                None
            }
            "movedToNewFile" => {
                recovery.moved_to_new_file(
                    id()?,
                    need_str(step, "old")?,
                    need_str(step, "target")?,
                );
                None
            }
            "discardedForDisk" => {
                recovery.discarded_for_disk(id()?, path()?);
                None
            }
            "saveAsDefaultPath" => recovery
                .save_as_default_path(id()?, path()?)
                .map(Value::from),
            "dontSave" => {
                recovery.dont_save(id()?, field_str(step, "path"));
                None
            }
            "closeCancelled" => Some(Value::Bool(recovery.close_cancelled(id()?))),
            "renamed" => {
                recovery.renamed(id()?, need_str(step, "old")?, need_str(step, "new")?);
                None
            }
            "openUntitled" => {
                let request = PdfOpenUntitledRequest {
                    copy: identity_of(field(step, "copy").ok_or_else(|| bad("copy"))?)?,
                    title: need_str(step, "title")?.to_owned(),
                    save_as_default_path: field_str(step, "saveAsDefaultPath").map(str::to_owned),
                };
                Some(
                    recovery
                        .open_untitled(id()?, &request)?
                        .map_or(Value::Null, Value::from),
                )
            }
            "reportUnprotectable" => Some(
                recovery
                    .report_unprotectable(id()?, field_bool(step, "value"))
                    .map_or(Value::Null, Value::from),
            ),
            "isUnprotectable" => Some(Value::Bool(recovery.is_unprotectable(id()?))),
            "untitledIdentity" => Some(
                recovery
                    .untitled_identity(id()?)
                    .as_ref()
                    .map_or(Value::Null, identity_json),
            ),
            "markCrashed" => {
                recovery.mark_crashed(id()?);
                None
            }
            "destroyed" => {
                recovery.destroyed(id()?, field_bool(step, "dirty"));
                None
            }
            "sweep" => {
                recovery.sweep_work_files(field(step, "maxAgeMs").and_then(Value::as_f64));
                None
            }
            _ => return Err(Raised::Bad(bad("a step"))),
        })
    };
    play(steps, env, &mut handle)
}

// ---------------------------------------------------------------------------
// recovery-policy
// ---------------------------------------------------------------------------

fn allows_call(args: &[Value]) -> Answer {
    let sheets: Vec<Option<f64>> = list(arg(args, 0))
        .iter()
        .map(|sheet| field(sheet, "sourceXmlBytes").and_then(Value::as_f64))
        .collect();
    Ok(Some(Value::Bool(allows_automatic_workbook_recovery(
        &sheets,
    ))))
}

fn owned_str(value: &Value, key: &str) -> Option<String> {
    field_str(value, key).map(str::to_owned)
}

fn session_call(args: &[Value]) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("a session"))?;
    let session = RecoverySessionShape {
        path: need_str(spec, "path")?.to_owned(),
        suggest_save_as: owned_str(spec, "suggestSaveAs"),
        unsaved_new: field(spec, "unsavedNew").and_then(Value::as_bool),
        csv_source_path: owned_str(spec, "csvSourcePath"),
        restore_target: owned_str(spec, "restoreTarget"),
        password: owned_str(spec, "password"),
        recovery_identity: match field(spec, "recoveryIdentity") {
            Some(identity) => Some(identity_of(identity)?),
            None => None,
        },
    };
    Ok(Some(
        session_recovery_identity(&session)
            .as_ref()
            .map_or(Value::Null, identity_json),
    ))
}

fn converted_call(args: &[Value]) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("a prepared open"))?;
    let prepared = ConvertedOpenShape {
        csv_source_path: owned_str(spec, "csvSourcePath"),
        suggest_save_as: owned_str(spec, "suggestSaveAs"),
        unsaved_new: field(spec, "unsavedNew").and_then(Value::as_bool),
        password: owned_str(spec, "password"),
        recovery_identity: match field(spec, "recoveryIdentity") {
            Some(identity) => Some(identity_of(identity)?),
            None => None,
        },
    };
    let counter = Cell::new(0u32);
    let uuid = || {
        counter.set(counter.get() + 1);
        format!("uuid-{}", counter.get())
    };
    Ok(Some(
        match converted_session_recovery(&prepared, str_arg(args, 1)?, &uuid) {
            Some(converted) => {
                let mut out = Map::new();
                out.insert(
                    "recoveryIdentity".into(),
                    untitled_json(&converted.recovery_identity),
                );
                out.insert(
                    "recoveryOriginalPath".into(),
                    Value::from(converted.recovery_original_path),
                );
                Value::Object(out)
            }
            None => Value::Null,
        },
    ))
}

fn migrate_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("a scenario"))?;
    with_env(spec, cx, |env| {
        let dir = need_str(spec, "dir")?;
        let calls = field(spec, "calls").and_then(Value::as_u64).unwrap_or(1);
        let warn = |message: &str, detail: &str| warn_line(env.log, message, detail);
        let mut out = Vec::new();
        for _ in 0..calls {
            let adopted = migrate_legacy_unsaved_new(env.store, dir, &warn)?;
            out.push(Value::Array(adopted.iter().map(untitled_json).collect()));
        }
        Ok(Value::Array(out))
    })
}
