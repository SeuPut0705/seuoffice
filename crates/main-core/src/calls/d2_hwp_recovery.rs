//! The functions of group `d2-hwp-recovery`
//! (tools/main-diff/groups/d2-hwp-recovery.ts): `hwp/recovery.rs` against
//! `apps/hwp/src/main/recovery.ts`.
//!
//! The module holds the state of every view, so its functions are driven as a
//! scenario: `[world, steps]` over one `HwpRecovery`, answering one entry per
//! recorded step (`{ op, value, flushes? }`), with every call of a fake one
//! `logs` line, as the TypeScript writes them. The scenario plays the part of
//! the Electron adapter: it owns the fake views, the host state, the timer
//! table (a timer fires when a `fire` step says so) and the pending
//! `writeCopiesNow` calls, and carries out what `HwpRecovery` decides.
//!
//! The names and the world and step shapes are described in the TypeScript
//! group. Where the TypeScript lets a store error escape (`openUntitledCopy` of
//! an id the store refuses) the Rust warns and does nothing, as recovery.rs
//! says; the TypeScript's thrown error is the entry's `error`.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::rc::Rc;
use std::time::{Duration, UNIX_EPOCH};

use serde_json::{Map, Value};

use super::fakes::{FakeDialog, FakeWindow};
use super::{Answer, CallError, Context, arg, str_arg};
use crate::hwp::ipc::HwpFormat;
use crate::hwp::recovery::{
    HwpRecovery, HwpRecoveryElectron, HwpRecoveryHost, RecoveryBeginResult, RecoveryTimer,
    UntitledCopy, hwp_format_of_path,
};
use crate::hwp::save_fixes::SaveBase;
use crate::packages::electron_utils::message_box::{MessageBox, MessageBoxOptions};
use crate::packages::electron_utils::recovery_contract::{
    RecoveryOpenDecision, RecoveryOpenFileRequest, RecoveryOpenUntitledRequest,
};
use crate::packages::electron_utils::recovery_store::{
    RecoveryFileIdentity, RecoveryIdentity, RecoveryUntitledIdentity, SharedRecoveryState,
    mark_app_shutting_down,
};

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

static NULL: Value = Value::Null;

const RUN: &str = "0123456789abcdef";

/// every name of the scenario, as the TypeScript group lists them
const SCENARIO: &[&str] = &[
    "recovery.installHwpRecovery",
    "recovery.hwpRecoveryIdentityOf",
    "recovery.hwpRecoveryIdentity",
    "recovery.setHwpRecoveryTitle",
    "recovery.hwpRecoverySaveAsDefault",
    "recovery.noteHwpPathConsumed",
    "recovery.hwpRecoveryOnRead",
    "recovery.hwpRecoveryFileRenamed",
    "recovery.hwpRecoveryBeforeSave",
    "recovery.hwpRecoverySaved",
    "recovery.hwpRecoveryDontSave",
    "recovery.timer.dontSaveHoldEnded",
    "recovery.timer.flushTimedOut",
    "recovery.trackHwpRecovery",
    "recovery.listener.renderProcessGone",
    "recovery.listener.destroyed",
    "recovery.ipc.recoveryBegin",
    "recovery.ipc.recoveryNewTabs",
    "recovery.ipc.recoveryWrite",
    "recovery.ipc.recoveryOpened",
    "recovery.ipc.recoveryFlushed",
    "recovery.contract.writeCopiesNow",
    "recovery.contract.openFileWithDecision",
    "recovery.contract.openUntitledCopy",
    "recovery.contract.isUnprotectable",
];

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    if name == "ipc.hwpFormatOfPath" {
        return Some(str_arg(args, 0).map(|path| {
            Some(
                hwp_format_of_path(path).map_or(Value::Null, |format| Value::from(format.as_str())),
            )
        }));
    }
    SCENARIO.contains(&name).then(|| scenario(args, cx))
}

/// one `logs` line of the items, each as `JSON.stringify` writes it
macro_rules! logl {
    ($log:expr; $($item:expr),+ $(,)?) => {
        $log.borrow_mut().push(vec![$(serde_json::json!($item)),+])
    };
}

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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| text.get(i * 2..i * 2 + 2))
        .filter_map(|pair| u8::from_str_radix(pair, 16).ok())
        .collect()
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("bad scenario: {what}"))
}

fn text<'a>(spec: &'a Value, key: &str) -> Option<&'a str> {
    spec.get(key).and_then(Value::as_str)
}

fn id_of(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_f64).map_or(0, |x| x as i64)
}

fn format_of(text: &str) -> HwpFormat {
    HwpFormat::parse(text).unwrap_or(HwpFormat::Hwp)
}

// ---- the fakes ----

#[derive(Default, Clone)]
struct ViewSpec {
    destroyed: bool,
    parent: Option<String>,
    flush_throws: bool,
}

/// `{ destroyed, parent, flushThrows }` set from a `view` edit; null removes a key
fn edit_view(view: &mut ViewSpec, changes: &Value) {
    let Some(changes) = changes.as_object() else {
        return;
    };
    for (key, value) in changes {
        match key.as_str() {
            "destroyed" => view.destroyed = value.as_bool().unwrap_or(false),
            "flushThrows" => view.flush_throws = value.as_bool().unwrap_or(false),
            "parent" => view.parent = value.as_str().map(str::to_owned),
            _ => {}
        }
    }
}

#[derive(Default, Clone)]
struct HostView {
    save_path: Option<String>,
    untitled_copy: Option<UntitledCopy>,
    open_path: Option<String>,
    dirty: bool,
}

/// `{ savePath, untitledCopy, openPath, dirty }` set from a `host` edit; null removes a key
fn edit_host(view: &mut HostView, changes: &Value) {
    let Some(changes) = changes.as_object() else {
        return;
    };
    for (key, value) in changes {
        match key.as_str() {
            "savePath" => view.save_path = value.as_str().map(str::to_owned),
            "openPath" => view.open_path = value.as_str().map(str::to_owned),
            "dirty" => view.dirty = value.as_bool().unwrap_or(false),
            "untitledCopy" => {
                view.untitled_copy = value.as_object().map(|copy| UntitledCopy {
                    name: copy
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    format: format_of(copy.get("format").and_then(Value::as_str).unwrap_or("")),
                })
            }
            _ => {}
        }
    }
}

struct Host {
    state: Rc<RefCell<HashMap<i64, HostView>>>,
    log: Log,
}

impl HwpRecoveryHost for Host {
    fn save_path_of(&self, wc_id: i64) -> Option<String> {
        self.state.borrow().get(&wc_id)?.save_path.clone()
    }
    fn untitled_copy_of(&self, wc_id: i64) -> Option<UntitledCopy> {
        self.state.borrow().get(&wc_id)?.untitled_copy.clone()
    }
    fn open_path_of(&self, wc_id: i64) -> Option<String> {
        self.state.borrow().get(&wc_id)?.open_path.clone()
    }
    fn save_base_of(&self, wc_id: i64) -> SaveBase {
        logl!(self.log; "saveBaseOf", wc_id);
        SaveBase::default()
    }
    fn is_dirty(&self, wc_id: i64) -> bool {
        self.state.borrow().get(&wc_id).is_some_and(|v| v.dirty)
    }
    fn mark_dirty(&self, wc_id: i64) {
        logl!(self.log; "markDirty", wc_id);
        self.state.borrow_mut().entry(wc_id).or_default().dirty = true;
    }
    fn queue_file(&self, wc_id: i64, path: &str) {
        logl!(self.log; "queueFile", wc_id, path);
        let mut state = self.state.borrow_mut();
        let view = state.entry(wc_id).or_default();
        view.open_path = Some(path.to_owned());
        view.save_path = Some(path.to_owned());
    }
    fn queue_untitled_copy(&self, wc_id: i64, path: &str, copy: UntitledCopy) {
        let shown = serde_json::json!({
            "name": copy.name.as_str(),
            "format": copy.format.as_str(),
        });
        logl!(self.log; "queueUntitledCopy", wc_id, path, shown);
        let mut state = self.state.borrow_mut();
        let view = state.entry(wc_id).or_default();
        view.open_path = Some(path.to_owned());
        view.save_path = None;
        view.untitled_copy = Some(copy);
    }
}

/// the dialog of the spec, its boxes written to the scenario's log in call order
struct LoggedDialog {
    inner: FakeDialog,
    log: Log,
}

impl MessageBox<FakeWindow> for LoggedDialog {
    fn show_message_box_over(&self, parent: &FakeWindow, options: &MessageBoxOptions) -> f64 {
        let answer = self.inner.show_message_box_over(parent, options);
        self.log
            .borrow_mut()
            .extend(self.inner.log.borrow_mut().drain(..));
        answer
    }

    fn show_message_box(&self, options: &MessageBoxOptions) -> f64 {
        let answer = self.inner.show_message_box(options);
        self.log
            .borrow_mut()
            .extend(self.inner.log.borrow_mut().drain(..));
        answer
    }
}

/// `parent` of a spec: "live" or "destroyed", else no window
fn window_of(spec: Option<&str>) -> Option<FakeWindow> {
    match spec {
        Some("live") => Some(FakeWindow { destroyed: false }),
        Some("destroyed") => Some(FakeWindow { destroyed: true }),
        _ => None,
    }
}

fn label(timer: RecoveryTimer) -> String {
    match timer {
        RecoveryTimer::DontSave(id) => format!("dontSave:{id}"),
        RecoveryTimer::Flush(token) => format!("flush:{token}"),
    }
}

struct Electron {
    headless: Cell<bool>,
    lang: RefCell<String>,
    user_data: String,
    now_ms: f64,
    uuid: Cell<u64>,
    views: RefCell<HashMap<i64, ViewSpec>>,
    focused: Option<String>,
    dialog: LoggedDialog,
    timers: RefCell<HashSet<RecoveryTimer>>,
    log: Log,
}

impl HwpRecoveryElectron for Electron {
    type Window = FakeWindow;
    type Dialog = LoggedDialog;

    fn is_destroyed(&self, wc_id: i64) -> bool {
        self.views.borrow().get(&wc_id).is_some_and(|v| v.destroyed)
    }
    fn send_recovery_reset(&self, wc_id: i64) {
        logl!(self.log; "send", wc_id, "hwp:recovery-reset");
    }
    fn send_recovery_flush(&self, wc_id: i64, token: u64) -> Result<(), String> {
        logl!(self.log; "send", wc_id, "hwp:recovery-flush", token);
        if self
            .views
            .borrow()
            .get(&wc_id)
            .is_some_and(|v| v.flush_throws)
        {
            return Err("send failed".to_owned());
        }
        Ok(())
    }
    fn reload(&self, wc_id: i64) {
        logl!(self.log; "reload", wc_id);
    }
    fn is_headless_mode(&self) -> bool {
        self.headless.get()
    }
    fn ui_lang(&self) -> String {
        self.lang.borrow().clone()
    }
    fn user_data_dir(&self) -> String {
        self.user_data.clone()
    }
    fn now_ms(&self) -> f64 {
        self.now_ms
    }
    fn random_uuid(&self) -> String {
        self.uuid.set(self.uuid.get() + 1);
        format!("uuid-{}", self.uuid.get())
    }
    fn dialog(&self) -> &LoggedDialog {
        &self.dialog
    }
    fn parent_of(&self, wc_id: i64) -> Option<FakeWindow> {
        let own = self
            .views
            .borrow()
            .get(&wc_id)
            .and_then(|v| v.parent.clone());
        window_of(own.as_deref()).or_else(|| window_of(self.focused.as_deref()))
    }
    fn set_timeout(&self, timer: RecoveryTimer, ms: f64) {
        logl!(self.log; "setTimeout", label(timer), ms);
        self.timers.borrow_mut().insert(timer);
    }
    fn clear_timeout(&self, timer: RecoveryTimer) {
        logl!(self.log; "clearTimeout", label(timer));
        self.timers.borrow_mut().remove(&timer);
    }
    fn warn(&self, message: &str) {
        logl!(self.log; "warn", mask_tmp(message));
    }
}

// ---- identities as JSON ----

fn identity_of(value: &Value) -> Option<RecoveryIdentity> {
    let object = value.as_object()?;
    let kind = object.get("kind")?.as_str()?.to_owned();
    if object.contains_key("untitledId") {
        return Some(RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
            kind,
            untitled_id: object.get("untitledId")?.as_str()?.to_owned(),
            ext: object.get("ext")?.as_str()?.to_owned(),
        }));
    }
    Some(RecoveryIdentity::File(RecoveryFileIdentity {
        kind,
        file_path: object.get("filePath")?.as_str()?.to_owned(),
    }))
}

fn identity_json(identity: Option<&RecoveryIdentity>) -> Value {
    let mut out = Map::new();
    match identity {
        None => return Value::Null,
        Some(RecoveryIdentity::File(f)) => {
            out.insert("kind".into(), Value::from(f.kind.as_str()));
            out.insert("filePath".into(), Value::from(f.file_path.as_str()));
        }
        Some(RecoveryIdentity::Untitled(u)) => {
            out.insert("kind".into(), Value::from(u.kind.as_str()));
            out.insert("untitledId".into(), Value::from(u.untitled_id.as_str()));
            out.insert("ext".into(), Value::from(u.ext.as_str()));
        }
    }
    Value::Object(out)
}

/// `{ hex }` is bytes; any other value is not
fn bytes_of(value: Option<&Value>) -> Option<Vec<u8>> {
    text(value?, "hex").map(unhex)
}

fn substitute(value: &Value, vars: &HashMap<String, Value>) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|v| substitute(v, vars)).collect()),
        Value::Object(map) => match map.get("$var").and_then(Value::as_str) {
            Some(name) => vars.get(name).cloned().unwrap_or(Value::Null),
            None => Value::Object(
                map.iter()
                    .map(|(k, v)| (k.clone(), substitute(v, vars)))
                    .collect(),
            ),
        },
        other => other.clone(),
    }
}

fn entry(op: &str, value: Option<Value>) -> Map<String, Value> {
    let mut out = Map::new();
    out.insert("op".into(), Value::from(op));
    if let Some(value) = value {
        out.insert("value".into(), value);
    }
    out
}

// ---- the scenario ----

fn scenario(args: &[Value], cx: &mut Context) -> Answer {
    let world = arg(args, 0).unwrap_or(&NULL);
    let steps = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?;
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let orig_dir = text(world, "origDir")
        .ok_or_else(|| bad("origDir"))?
        .to_owned();
    let user_data = text(world, "userData")
        .ok_or_else(|| bad("userData"))?
        .to_owned();
    let lang = text(world, "lang").unwrap_or("en").to_owned();

    let mut views = HashMap::new();
    for (key, spec) in world
        .get("views")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let mut view = ViewSpec::default();
        edit_view(&mut view, spec);
        views.insert(key.parse::<i64>().map_err(|_| bad("view id"))?, view);
    }
    let mut host_views = HashMap::new();
    for (key, spec) in world
        .get("host")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let mut view = HostView::default();
        edit_host(&mut view, spec);
        host_views.insert(key.parse::<i64>().map_err(|_| bad("host id"))?, view);
    }
    let host_state = Rc::new(RefCell::new(host_views));

    let _ = fs::remove_dir_all(&orig_dir);
    for (name, file) in world
        .get("orig")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
    {
        let path = std::path::Path::new(&orig_dir).join(name);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| CallError::plain(e.to_string()))?;
        }
        fs::write(&path, text(file, "text").unwrap_or(""))
            .map_err(|e| CallError::plain(e.to_string()))?;
        let ms = file.get("mtimeMs").and_then(Value::as_f64).unwrap_or(0.0);
        let handle = fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .map_err(|e| CallError::plain(e.to_string()))?;
        handle
            .set_modified(UNIX_EPOCH + Duration::from_millis(ms as u64))
            .map_err(|e| CallError::plain(e.to_string()))?;
    }

    let e = Electron {
        headless: Cell::new(world.get("headless").and_then(Value::as_bool) == Some(true)),
        lang: RefCell::new(lang),
        user_data,
        now_ms: cx.now_ms,
        uuid: Cell::new(0),
        views: RefCell::new(views),
        focused: text(world, "focused").map(str::to_owned),
        dialog: LoggedDialog {
            inner: FakeDialog::of(world),
            log: log.clone(),
        },
        timers: RefCell::new(HashSet::new()),
        log: log.clone(),
    };
    let host = Rc::new(Host {
        state: host_state.clone(),
        log: log.clone(),
    });
    let shared = SharedRecoveryState::new(RUN);
    if world.get("shuttingDown").and_then(Value::as_bool) == Some(true) {
        mark_app_shutting_down(&shared);
    }
    let mut rec = HwpRecovery::new();
    if world.get("install").and_then(Value::as_bool) != Some(false) {
        rec.install_hwp_recovery(host.clone());
    }

    let out = play(steps, &mut rec, &e, &shared, &host, &host_state);
    let _ = fs::remove_dir_all(&orig_dir);
    cx.logs.extend(log.take());
    out.map(|entries| Some(Value::Array(entries)))
}

fn play(
    steps: &[Value],
    rec: &mut HwpRecovery,
    e: &Electron,
    shared: &SharedRecoveryState,
    host: &Rc<Host>,
    host_state: &Rc<RefCell<HashMap<i64, HostView>>>,
) -> Result<Vec<Value>, CallError> {
    let mut vars: HashMap<String, Value> = HashMap::new();
    let mut listening: HashSet<i64> = HashSet::new();
    let mut destroy_pending: HashSet<i64> = HashSet::new();
    let mut pending: Vec<Vec<u64>> = Vec::new();
    let mut out = Vec::new();

    for step in steps {
        let mut recorded: Option<Map<String, Value>> = None;
        if let Some(changes) = step.get("host") {
            let id = id_of(changes.get("id"));
            edit_host(host_state.borrow_mut().entry(id).or_default(), changes);
        } else if let Some(changes) = step.get("view") {
            let id = id_of(changes.get("id"));
            edit_view(e.views.borrow_mut().entry(id).or_default(), changes);
        } else if let Some(changes) = step.get("world") {
            if let Some(lang) = text(changes, "lang") {
                *e.lang.borrow_mut() = lang.to_owned();
            }
            if let Some(headless) = changes.get("headless") {
                e.headless.set(headless.as_bool() == Some(true));
            }
        } else if step.get("install").is_some() {
            rec.install_hwp_recovery(host.clone());
            recorded = Some(entry("recovery.installHwpRecovery", None));
        } else if let Some(id) = step.get("gone") {
            let id = id_of(Some(id));
            if listening.contains(&id) {
                rec.render_process_gone(id);
            }
            recorded = Some(entry("recovery.listener.renderProcessGone", None));
        } else if let Some(id) = step.get("destroy") {
            let id = id_of(Some(id));
            e.views.borrow_mut().entry(id).or_default().destroyed = true;
            if destroy_pending.remove(&id) {
                rec.destroyed(e, shared, id);
            }
            recorded = Some(entry("recovery.listener.destroyed", None));
        } else if let Some(name) = step.get("fire").and_then(Value::as_str) {
            let (op, timer) = if let Some(id) = name.strip_prefix("dontSave:") {
                (
                    "recovery.timer.dontSaveHoldEnded",
                    RecoveryTimer::DontSave(id.parse().map_err(|_| bad("timer"))?),
                )
            } else {
                (
                    "recovery.timer.flushTimedOut",
                    RecoveryTimer::Flush(
                        name.strip_prefix("flush:")
                            .and_then(|t| t.parse().ok())
                            .ok_or_else(|| bad("timer"))?,
                    ),
                )
            };
            let fired = e.timers.borrow_mut().remove(&timer);
            if fired {
                match timer {
                    RecoveryTimer::DontSave(id) => rec.dont_save_hold_ended(e, id),
                    RecoveryTimer::Flush(token) => {
                        if rec.flush_timed_out(token) {
                            settle_token(&mut pending, token);
                        }
                    }
                }
            }
            recorded = Some(entry(op, Some(Value::Bool(fired))));
        } else {
            let name = step
                .get("call")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("call"))?;
            let given: Vec<Value> = step
                .get("args")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|v| substitute(v, &vars)).collect())
                .unwrap_or_default();
            let value = run_call(
                name,
                &given,
                rec,
                e,
                shared,
                &mut listening,
                &mut destroy_pending,
                &mut pending,
            )?;
            if let Some(var) = step.get("as").and_then(Value::as_str) {
                vars.insert(var.to_owned(), value.clone().unwrap_or(Value::Null));
            }
            recorded = Some(entry(name, value));
        }
        if let Some(mut done) = recorded {
            if !pending.is_empty() {
                done.insert(
                    "flushes".into(),
                    Value::Array(pending.iter().map(|t| Value::Bool(t.is_empty())).collect()),
                );
            }
            out.push(Value::Object(done));
        }
    }
    Ok(out)
}

fn settle_token(pending: &mut [Vec<u64>], token: u64) {
    for tokens in pending {
        tokens.retain(|t| *t != token);
    }
}

#[allow(clippy::too_many_arguments)]
fn run_call(
    name: &str,
    a: &[Value],
    rec: &mut HwpRecovery,
    e: &Electron,
    shared: &SharedRecoveryState,
    listening: &mut HashSet<i64>,
    destroy_pending: &mut HashSet<i64>,
    pending: &mut Vec<Vec<u64>>,
) -> Result<Option<Value>, CallError> {
    let id = id_of(a.first());
    let s = |i: usize| a.get(i).and_then(Value::as_str).unwrap_or("");
    Ok(match name {
        "recovery.hwpRecoveryIdentityOf" => {
            Some(identity_json(rec.hwp_recovery_identity_of(e, id).as_ref()))
        }
        "recovery.hwpRecoveryIdentity" => {
            Some(identity_json(rec.hwp_recovery_identity(e, id).as_ref()))
        }
        "recovery.setHwpRecoveryTitle" => {
            rec.set_hwp_recovery_title(id, s(1));
            None
        }
        "recovery.hwpRecoverySaveAsDefault" => {
            rec.hwp_recovery_save_as_default(id).map(Value::from)
        }
        "recovery.noteHwpPathConsumed" => {
            rec.note_hwp_path_consumed(id);
            None
        }
        "recovery.hwpRecoveryOnRead" => Some(
            rec.hwp_recovery_on_read(e, shared, id, s(1))
                .map_or(Value::Null, |bytes| Value::from(hex(&bytes))),
        ),
        "recovery.hwpRecoveryFileRenamed" => {
            rec.hwp_recovery_file_renamed(e, shared, id, s(1), s(2));
            None
        }
        "recovery.hwpRecoveryBeforeSave" => {
            Some(identity_json(rec.hwp_recovery_before_save(e, id).as_ref()))
        }
        "recovery.hwpRecoverySaved" => {
            let before = a.get(1).and_then(identity_of);
            rec.hwp_recovery_saved(e, shared, id, before);
            None
        }
        "recovery.hwpRecoveryDontSave" => {
            rec.hwp_recovery_dont_save(e, shared, id);
            None
        }
        "recovery.trackHwpRecovery" => {
            rec.track_hwp_recovery(id);
            listening.insert(id);
            destroy_pending.insert(id);
            None
        }
        "recovery.ipc.recoveryBegin" => {
            let mut out = Map::new();
            match rec.recovery_begin(e, shared, id) {
                RecoveryBeginResult::Refused => {
                    out.insert("ok".into(), Value::Bool(false));
                }
                RecoveryBeginResult::Began(format) => {
                    out.insert("ok".into(), Value::Bool(true));
                    out.insert("format".into(), Value::from(format.as_str()));
                }
            }
            Some(Value::Object(out))
        }
        "recovery.ipc.recoveryNewTabs" => {
            let data = bytes_of(a.get(1));
            let spots =
                rec.recovery_new_tabs(id, data.as_deref(), a.get(2).and_then(Value::as_str));
            Some(serde_json::to_value(&spots).expect("tab spots print"))
        }
        "recovery.ipc.recoveryWrite" => {
            let data = bytes_of(a.get(1));
            let tabs = a.get(3).and_then(Value::as_array);
            let outcome = rec.recovery_write(
                e,
                shared,
                id,
                data.as_deref(),
                a.get(2).and_then(Value::as_str),
                tabs.map(Vec::as_slice),
            );
            Some(Value::from(outcome.as_str()))
        }
        "recovery.ipc.recoveryOpened" => {
            let protected = a.get(1) == Some(&Value::Bool(true));
            let result = rec.recovery_opened(e, id, protected);
            let mut out = Map::new();
            out.insert("restored".into(), Value::Bool(result.restored));
            out.insert(
                "notice".into(),
                result.notice.map_or(Value::Null, Value::from),
            );
            Some(Value::Object(out))
        }
        "recovery.ipc.recoveryFlushed" => {
            if let Some(token) = a.get(1).and_then(Value::as_f64)
                && rec.recovery_flushed(e, token)
            {
                settle_token(pending, token as u64);
            }
            None
        }
        "recovery.contract.writeCopiesNow" => {
            pending.push(rec.write_copies_now(e));
            None
        }
        "recovery.contract.openFileWithDecision" => {
            let request = a.get(1).unwrap_or(&NULL);
            let decision = match text(request, "decision") {
                Some("restore") => RecoveryOpenDecision::Restore,
                _ => RecoveryOpenDecision::Original,
            };
            rec.open_file_with_decision(
                e,
                id,
                &RecoveryOpenFileRequest {
                    file_path: text(request, "filePath").unwrap_or("").to_owned(),
                    decision,
                },
            );
            None
        }
        "recovery.contract.openUntitledCopy" => {
            let request = a.get(1).unwrap_or(&NULL);
            let copy = request
                .get("copy")
                .and_then(identity_of)
                .ok_or_else(|| bad("copy"))?;
            rec.open_untitled_copy(
                e,
                shared,
                id,
                &RecoveryOpenUntitledRequest {
                    copy,
                    title: text(request, "title").unwrap_or("").to_owned(),
                    save_as_default_path: text(request, "saveAsDefaultPath").map(str::to_owned),
                },
            );
            None
        }
        "recovery.contract.isUnprotectable" => Some(Value::Bool(rec.is_unprotectable(id))),
        other => return Err(bad(&format!("no such call {other}"))),
    })
}
