//! The functions of group `b3-session` (tools/main-diff/groups/b3-session.ts).
//!
//! Where a TypeScript function takes an Electron object or a callback, the
//! spec hands it a fake that logs each call as one `logs` line; the Rust
//! side logs the same lines from the trait it implements. A number the
//! TypeScript reads and a spec writes as NaN reaches Rust as `null` (that is
//! how `JSON.stringify` writes NaN), which [`f64_arg`] reads as NaN again; a
//! spec never uses an infinity, which would read the same way.

use std::cell::RefCell;
use std::fs;
use std::rc::Rc;

use super::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::NodeError;
use crate::shell::file_targets::{
    FileTargetSources, MoveSourceSources, is_move_source, is_user_visible_file,
};
use crate::shell::open_documents::{
    InvalidTime, OPEN_DOCUMENTS_FILE, ReportedWriteErrors, clear_open_documents,
    publish_open_documents,
};
use crate::shell::result_store_ipc::{
    IpcHandle, IpcHandler, RESULT_STORE_DELETE_ALL_CHANNEL, RESULT_STORE_SIZE_CHANNEL, ResultStore,
    StoreError, register_result_store_ipc,
};
use crate::shell::session_record::{
    CRASH_LOOP_WINDOW_MS, SESSION_RECORD_FILE, SESSION_RECORD_WRITE_DELAY_MS, SessionRecord,
    SessionRecordProcess, SessionRecordReadResult, SessionRecorder, SessionRecorderEnv,
    SessionRecorderOptions, create_session_recorder, judge_previous_exit, parse_session_record,
    read_session_record, record_to_value, session_record_path, session_restore_layout,
    session_snapshot_from, snapshot_to_value, write_record_atomic,
};
use crate::shell::skill_target::is_installable_skill_dir;
use crate::shell::split_layout::{
    DragSplit, DraggedTab, OppositeTab, Pane, Rect, SPLIT_EVEN_RATIO, SplitDragContext,
    SplitDropIntent, SplitOrientation, activation_mode, clamp_split_ratio, decide_split_drop,
    opposite_document_id, pane_rects, split_available_px, split_drop_zone, split_ratio_limits,
    split_survivor,
};
use crate::shell::tab_document_actions::{
    TabDocumentActionDeps, TabDocumentTarget, run_tab_document_action,
};
use crate::shell::tab_duplicate::{DuplicateFileDeps, duplicate_document_file};
use crate::shell::tab_lifecycle::{
    MAX_RECENTLY_CLOSED, TabCloseManager, TabCloseTarget, close_tabs_in_order,
    create_recently_closed_tracker,
};
use crate::shell::tab_menu::{
    MenuClick, MenuItem, TabMenuInput, TabSummary, base_name, is_program_file, path_label,
    tab_menu_template,
};
use crate::shell::tab_shortcuts::{
    TabShortcutHost, TabShortcutInput, handle_tab_shortcut, tab_shortcut_of,
};
use crate::shell::title_bar_overlay::tab_strip_overlay;
use crate::shell::window_background::{
    SHELL_BACKGROUND_DARK, SHELL_BACKGROUND_LIGHT, shell_window_background,
};
use crate::shell::window_close_guard::{
    CloseGuardHost, CloseGuardTab, CloseStep, Family, ShellCloseGuard,
};
use jscompat::node_path::host::{is_absolute, join};
use jscompat::{JsRegex, JsonValue, js_regex, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Number, Value, json};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // session-record
        "session-record.SESSION_RECORD_FILE" => Ok(Some(Value::from(SESSION_RECORD_FILE))),
        "session-record.SESSION_RECORD_WRITE_DELAY_MS" => {
            Ok(Some(num(SESSION_RECORD_WRITE_DELAY_MS)))
        }
        "session-record.CRASH_LOOP_WINDOW_MS" => Ok(Some(num(CRASH_LOOP_WINDOW_MS))),
        "session-record.sessionSnapshotFrom" => snapshot_from_call(args, cx),
        "session-record.parseSessionRecord" => {
            let raw = json_arg(args, 0);
            Ok(Some(
                parse_session_record(&raw).map_or(Value::Null, |r| record_to_value(&r)),
            ))
        }
        "session-record.sessionRecordPath" => {
            str_arg(args, 0).map(|dir| Some(Value::from(session_record_path(dir))))
        }
        "session-record.readSessionRecord" => {
            str_arg(args, 0).map(|path| Some(read_result_to_value(&read_session_record(path))))
        }
        "session-record.judgePreviousExit" => judge_call(args, cx),
        "session-record.sessionRestoreLayout" => restore_layout_call(args),
        "session-record.createSessionRecorder" => session_scenario(args, cx, false),
        "session-record.initSessionRecord"
        | "session-record.sessionRecorder"
        | "session-record.noteSessionChanged"
        | "session-record.markSessionCleanExit"
        | "session-record.holdSessionTabsForUpdateRestart"
        | "session-record.markSessionUpdateRestart"
        | "session-record.markSessionClosedToTray"
        | "session-record.markSessionOsEnd"
        | "session-record.resetSessionRecordForTests" => session_scenario(args, cx, true),
        // tab-lifecycle
        "tab-lifecycle.MAX_RECENTLY_CLOSED" => Ok(Some(num(MAX_RECENTLY_CLOSED))),
        "tab-lifecycle.closeTabsInOrder" => close_tabs_call(args, cx),
        "tab-lifecycle.createRecentlyClosedTracker" => tracker_call(args, cx),
        // tab-duplicate
        "tab-duplicate.duplicateDocumentFile" => duplicate_call(args, cx),
        // tab-document-actions
        "tab-document-actions.runTabDocumentAction" => document_action_call(args, cx),
        // tab-menu
        "tab-menu.isProgramFile" => {
            str_arg(args, 0).map(|path| Some(Value::Bool(is_program_file(path))))
        }
        "tab-menu.baseName" => str_arg(args, 0).map(|path| Some(Value::from(base_name(path)))),
        "tab-menu.pathLabel" => str_arg(args, 0).map(|path| Some(Value::from(path_label(path)))),
        "tab-menu.tabMenuTemplate" => menu_call(args),
        // tab-shortcuts
        "tab-shortcuts.tabShortcutOf" => shortcut_of_call(args),
        "tab-shortcuts.handleTabShortcut" => handle_shortcut_call(args, cx),
        // split-layout
        "split-layout.SPLIT_EVEN_RATIO" => Ok(Some(num(SPLIT_EVEN_RATIO))),
        "split-layout.splitAvailablePx" => split_call(args, |a| {
            Ok(num(split_available_px(
                &rect_arg(a, 0)?,
                orientation_arg(a, 1)?,
            )))
        }),
        "split-layout.splitRatioLimits" => split_call(args, |a| {
            let (min, max) = split_ratio_limits(&rect_arg(a, 0)?, orientation_arg(a, 1)?);
            Ok(json!({ "min": num(min), "max": num(max) }))
        }),
        "split-layout.clampSplitRatio" => split_call(args, |a| {
            Ok(num(clamp_split_ratio(
                f64_arg(arg(a, 0)),
                &rect_arg(a, 1)?,
                orientation_arg(a, 2)?,
            )))
        }),
        "split-layout.paneRects" => split_call(args, |a| {
            let rects = pane_rects(&rect_arg(a, 0)?, orientation_arg(a, 1)?, f64_arg(arg(a, 2)));
            Ok(json!({ "a": rect_value(&rects.a), "b": rect_value(&rects.b) }))
        }),
        "split-layout.splitDropZone" => split_call(args, |a| {
            let zone = split_drop_zone(
                f64_arg(arg(a, 0)),
                f64_arg(arg(a, 1)),
                f64_arg(arg(a, 2)),
                f64_arg(arg(a, 3)),
            );
            Ok(zone.map_or(Value::Null, |z| Value::from(z.as_str())))
        }),
        "split-layout.decideSplitDrop" => split_call(args, |a| decide_drop_value(arg(a, 0))),
        "split-layout.activationMode" => split_call(args, |a| {
            let split = arg(a, 0).filter(|v| !v.is_null());
            let pair = match split {
                Some(s) => Some((text(s, "aTabId")?, text(s, "bTabId")?)),
                None => None,
            };
            let tab = arg(a, 1).ok_or_else(|| bad("tab"))?;
            let present = tab.get("present") == Some(&Value::Bool(true));
            Ok(Value::from(
                activation_mode(pair, text(tab, "id")?, text(tab, "kind")?, present).as_str(),
            ))
        }),
        "split-layout.splitSurvivor" => split_call(args, |a| {
            let split = arg(a, 0).ok_or_else(|| bad("split"))?;
            let removed = a
                .get(1)
                .and_then(Value::as_str)
                .ok_or_else(|| bad("removed"))?;
            Ok(
                match split_survivor(text(split, "aTabId")?, text(split, "bTabId")?, removed) {
                    Some((keep, tab_id)) => json!({ "keep": keep.as_str(), "tabId": tab_id }),
                    None => Value::Null,
                },
            )
        }),
        "split-layout.oppositeDocumentId" => split_call(args, |a| opposite_value(arg(a, 0))),
        // open-documents
        "open-documents.OPEN_DOCUMENTS_FILE" => Ok(Some(Value::from(OPEN_DOCUMENTS_FILE))),
        "open-documents.publishOpenDocuments" => publish_call(args, cx),
        "open-documents.clearOpenDocuments" => str_arg(args, 0).map(|path| {
            clear_open_documents(path);
            None
        }),
        // window-background
        "window-background.SHELL_BACKGROUND_LIGHT" => Ok(Some(Value::from(SHELL_BACKGROUND_LIGHT))),
        "window-background.SHELL_BACKGROUND_DARK" => Ok(Some(Value::from(SHELL_BACKGROUND_DARK))),
        "window-background.shellWindowBackground" => {
            bool_arg(args, 0).map(|dark| Some(Value::from(shell_window_background(dark))))
        }
        // title-bar-overlay
        "title-bar-overlay.tabStripOverlay" => bool_arg(args, 0).map(|dark| {
            // `uiScale = 1`: a left-out argument takes the default
            let scale = match arg(args, 1) {
                None | Some(Value::Null) => 1.0,
                scale => f64_arg(scale),
            };
            Some(serde_json::to_value(tab_strip_overlay(dark, scale)).expect("an overlay prints"))
        }),
        // skill-target
        "skill-target.isInstallableSkillDir" => string_list(args, 1).map(|vouched| {
            let dir = arg(args, 0).and_then(Value::as_str);
            Some(Value::Bool(is_installable_skill_dir(dir, &vouched)))
        }),
        // file-targets
        "file-targets.isUserVisibleFile" => file_target_call(args, cx, false),
        "file-targets.isMoveSource" => file_target_call(args, cx, true),
        // result-store-ipc
        "result-store-ipc.registerResultStoreIpc" => result_store_call(args, cx),
        // window-close-guard
        "window-close-guard.installShellCloseGuard" => close_guard_call(args, cx),
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

/// A number as `JSON.stringify` prints it: NaN as `null`.
fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// A JavaScript number read from an argument: `null` is NaN (see the module).
fn f64_arg(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

fn bool_arg(args: &[Value], i: usize) -> Result<bool, CallError> {
    arg(args, i)
        .and_then(Value::as_bool)
        .ok_or_else(|| bad("a boolean"))
}

fn json_arg(args: &[Value], i: usize) -> JsonValue {
    arg(args, i).map_or(JsonValue::Null, json_value_from_serde)
}

fn string_list(args: &[Value], i: usize) -> Result<Vec<String>, CallError> {
    strings(arg(args, i).ok_or_else(|| bad("a list"))?)
}

fn strings(value: &Value) -> Result<Vec<String>, CallError> {
    value
        .as_array()
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
        .collect()
}

/// `value[key]` as a string
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, CallError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| bad(key))
}

fn opt_text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key) == Some(&Value::Bool(true))
}

/// the lines of the function's logger
#[derive(Default)]
struct Log(RefCell<Vec<Vec<Value>>>);

impl Log {
    fn add(&self, line: Vec<Value>) {
        self.0.borrow_mut().push(line);
    }

    fn drain_into(self, cx: &mut Context) {
        cx.logs.extend(self.0.into_inner());
    }
}

/// a temp file's random part differs on each side: both write it `<hex>`
fn mask_tmp(text: &str) -> String {
    fn re() -> &'static JsRegex {
        js_regex!(r"\.[0-9a-f]{12}\.tmp", "g")
    }
    re().replace_all(text, |_| ".<hex>.tmp".to_owned())
}

/// the temp name of `publishOpenDocuments`: `.<pid>.<uuid>.tmp`
fn mask_pid_tmp(text: &str) -> String {
    fn re() -> &'static JsRegex {
        js_regex!(
            r"\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp",
            "g"
        )
    }
    re().replace_all(text, |_| ".<pid>.<uuid>.tmp".to_owned())
}

// ---------------------------------------------------------------- session-record

fn tab_list(value: Option<&Value>) -> Vec<JsonValue> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().map(json_value_from_serde).collect())
        .unwrap_or_default()
}

/// `[source]` with `strip`, `detached` and `copies` (an object from tab id
/// to what `untitledCopyFor` answers; absent: the source has no such function)
fn snapshot_from_call(args: &[Value], cx: &mut Context) -> Answer {
    let source = arg(args, 0).ok_or_else(|| bad("source"))?;
    let strip = source
        .get("strip")
        .filter(|v| !v.is_null())
        .map(json_value_from_serde);
    let detached = tab_list(source.get("detached"));
    let copies = source.get("copies").and_then(Value::as_object);
    let log = Log::default();
    let mut copy_for = |tab: &JsonValue| -> Option<JsonValue> {
        let tab = json_value_to_serde(tab);
        log.add(vec![Value::from("untitledCopyFor"), tab.clone()]);
        let id = tab.get("id").and_then(Value::as_str)?;
        copies?.get(id).map(json_value_from_serde)
    };
    let snapshot = session_snapshot_from(
        strip.as_ref(),
        &detached,
        copies.map(|_| &mut copy_for as &mut dyn FnMut(&JsonValue) -> Option<JsonValue>),
    );
    log.drain_into(cx);
    Ok(Some(snapshot_to_value(&snapshot)))
}

fn read_result_to_value(result: &SessionRecordReadResult) -> Value {
    match result {
        SessionRecordReadResult::Missing => json!({ "status": "missing" }),
        SessionRecordReadResult::Corrupt => json!({ "status": "corrupt" }),
        SessionRecordReadResult::Ok(record) => {
            json!({ "status": "ok", "record": record_to_value(record) })
        }
    }
}

/// a read result as a spec writes it; its record is one `parseSessionRecord`
/// keeps as it is
fn read_result_arg(value: &Value) -> Result<SessionRecordReadResult, CallError> {
    match text(value, "status")? {
        "missing" => Ok(SessionRecordReadResult::Missing),
        "corrupt" => Ok(SessionRecordReadResult::Corrupt),
        "ok" => {
            let record = value.get("record").ok_or_else(|| bad("record"))?;
            parse_session_record(&json_value_from_serde(record))
                .map(SessionRecordReadResult::Ok)
                .ok_or_else(|| bad("a valid record"))
        }
        _ => Err(bad("status")),
    }
}

/// `[previous, hasUnresolvedCopies, options]`
fn judge_call(args: &[Value], cx: &mut Context) -> Answer {
    let previous = read_result_arg(arg(args, 0).ok_or_else(|| bad("previous"))?)?;
    let unresolved = bool_arg(args, 1)?;
    let reopened = arg(args, 2).is_some_and(|options| flag(options, "reopenedByInstaller"));
    let log = Log::default();
    let judgment = judge_previous_exit(
        &previous,
        &mut || {
            log.add(vec![Value::from("hasUnresolvedCopies")]);
            unresolved
        },
        reopened,
    );
    log.drain_into(cx);
    Ok(Some(json!({
        "abnormal": judgment.abnormal,
        "reason": judgment.reason.as_str(),
        "crashLoop": judgment.crash_loop,
    })))
}

/// `[record, { crashLoop }]`
fn restore_layout_call(args: &[Value]) -> Answer {
    let record = parse_session_record(&json_arg(args, 0)).ok_or_else(|| bad("a valid record"))?;
    let crash_loop = arg(args, 1).is_some_and(|options| flag(options, "crashLoop"));
    Ok(Some(snapshot_to_value(&session_restore_layout(
        &record, crash_loop,
    ))))
}

/// How the scenario's recorder writes: `fake` logs `writeJson` lines (and
/// fails while the spec says so); `real` is `writeJsonAtomic`.
struct ScenarioEnv<'a> {
    log: &'a Log,
    now: f64,
    real: bool,
    failing: bool,
}

impl SessionRecorderEnv for ScenarioEnv<'_> {
    fn now(&mut self) -> f64 {
        self.now
    }

    fn write_json(&mut self, file_path: &str, record: &SessionRecord) -> Result<(), String> {
        if self.real {
            return write_record_atomic(file_path, record)
                .map_err(|e: NodeError| format!("Error: {}", e.message));
        }
        self.log.add(vec![
            Value::from("writeJson"),
            Value::from(file_path),
            record_to_value(record),
        ]);
        if self.failing {
            return Err("Error: disk full".to_owned());
        }
        Ok(())
    }

    fn warn(&mut self, label: &str, error: &str) {
        self.log.add(vec![
            Value::from("console.warn"),
            Value::from(label),
            Value::from(error),
        ]);
    }
}

fn timers_of(recorder: Option<&SessionRecorder>) -> Value {
    let mut timers = Vec::new();
    if let Some(r) = recorder {
        if r.startup_timer() {
            timers.push(num(r.crash_loop_window_ms()));
        }
        if r.write_timer() {
            timers.push(num(r.write_delay_ms()));
        }
    }
    Value::Array(timers)
}

/// The scenario of `createSessionRecorder` (`global` false) and of the
/// functions that reach the process-wide recorder (`global` true). `args[0]`:
/// `userDataDir`, `writeDelayMs?`, `crashLoopWindowMs?` (always unlike each
/// other: the TypeScript's fake timers tell the two apart by their delay),
/// `write` (`"fake"`, the default, or `"real"`), `clock` (`"fixed"`, the
/// default, or `"default"`: the options leave `now` out) and `steps`.
fn session_scenario(args: &[Value], cx: &mut Context, global: bool) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("scenario"))?;
    let options = SessionRecorderOptions {
        user_data_dir: text(spec, "userDataDir")?.to_owned(),
        write_delay_ms: spec.get("writeDelayMs").and_then(Value::as_f64),
        crash_loop_window_ms: spec.get("crashLoopWindowMs").and_then(Value::as_f64),
    };
    let steps = spec
        .get("steps")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?;
    let log = Log::default();
    let mut env = ScenarioEnv {
        log: &log,
        now: if opt_text(spec, "clock") == Some("default") {
            cx.now_ms
        } else {
            cx.now_ms + 7.0
        },
        real: opt_text(spec, "write") == Some("real"),
        failing: false,
    };
    let mut process = SessionRecordProcess::new();
    let mut direct: Option<SessionRecorder> = None;
    if !global {
        direct = Some(create_session_recorder(&options));
    }
    let previous = direct.as_ref().map(|r| read_result_to_value(&r.previous));
    let mut results: Vec<Value> = Vec::new();

    for step in steps {
        let op = text(step, "op")?;
        let mut result = Map::new();
        result.insert("op".into(), Value::from(op));
        let mut extra = Map::new();
        // the recorder an op reaches: the direct one, or the process-wide one
        macro_rules! recorder {
            () => {
                if global {
                    process.session_recorder()
                } else {
                    direct.as_mut()
                }
            };
        }
        match op {
            "startRun" => {
                if let Some(r) = recorder!() {
                    r.start_run(&mut env, flag(step, "restoreRun"));
                }
            }
            "update" => {
                let snapshot = step.get("snapshot").ok_or_else(|| bad("snapshot"))?;
                let field = |key: &str| snapshot.get(key).map(json_value_from_serde);
                let (tabs, active, split) = (field("tabs"), field("active"), field("split"));
                if let Some(r) = recorder!() {
                    r.update(&mut env, tabs.as_ref(), active.as_ref(), split.as_ref());
                }
            }
            "flush" => {
                if let Some(r) = recorder!() {
                    r.flush(&mut env);
                }
            }
            "markCleanExit" => {
                if let Some(r) = recorder!() {
                    r.mark_clean_exit(&mut env);
                }
            }
            "hold" => {
                if let Some(r) = recorder!() {
                    r.hold_tabs_for_update_restart();
                }
            }
            "markUpdateRestart" => {
                if let Some(r) = recorder!() {
                    r.mark_update_restart(&mut env);
                }
            }
            "markClosedToTray" => {
                if let Some(r) = recorder!() {
                    r.mark_closed_to_tray(&mut env);
                }
            }
            "markOsSessionEnd" => {
                if let Some(r) = recorder!() {
                    r.mark_os_session_end(&mut env);
                }
            }
            "dispose" => {
                if let Some(r) = recorder!() {
                    r.dispose();
                }
            }
            "fireWrite" => {
                if let Some(r) = recorder!() {
                    r.fire_write_timer(&mut env);
                }
            }
            "fireStartup" => {
                if let Some(r) = recorder!() {
                    r.fire_startup_timer(&mut env);
                }
            }
            "failWrites" => env.failing = flag(step, "on"),
            // the functions of the process-wide recorder
            "init" => {
                extra.insert(
                    "same".into(),
                    Value::Bool(process.session_recorder().is_some()),
                );
                process.init_session_record(&options);
            }
            "recorder" => {
                let present = process.session_recorder();
                extra.insert("present".into(), Value::Bool(present.is_some()));
                if let Some(r) = present {
                    extra.insert("previous".into(), read_result_to_value(&r.previous));
                }
            }
            "note" => {
                let source = step.get("source").ok_or_else(|| bad("source"))?;
                let strip = source
                    .get("strip")
                    .filter(|v| !v.is_null())
                    .map(json_value_from_serde);
                let detached = tab_list(source.get("detached"));
                let copies = source.get("copies").and_then(Value::as_object);
                let mut copy_for = |tab: &JsonValue| -> Option<JsonValue> {
                    let tab = json_value_to_serde(tab);
                    log.add(vec![Value::from("untitledCopyFor"), tab.clone()]);
                    let id = tab.get("id").and_then(Value::as_str)?;
                    copies?.get(id).map(json_value_from_serde)
                };
                process.note_session_changed(
                    &mut env,
                    strip.as_ref(),
                    &detached,
                    copies
                        .map(|_| &mut copy_for as &mut dyn FnMut(&JsonValue) -> Option<JsonValue>),
                );
            }
            "cleanExit" => process.mark_session_clean_exit(&mut env),
            "holdTabs" => process.hold_session_tabs_for_update_restart(),
            "updateRestart" => process.mark_session_update_restart(&mut env),
            "closedToTray" => process.mark_session_closed_to_tray(&mut env),
            "osEnd" => process.mark_session_os_end(&mut env),
            "reset" => process.reset_session_record_for_tests(),
            _ => return Err(bad("op")),
        }
        let timers = if global {
            timers_of(process.session_recorder().map(|r| &*r))
        } else {
            timers_of(direct.as_ref())
        };
        result.insert("timers".into(), timers);
        result.extend(extra);
        results.push(Value::Object(result));
    }
    log.drain_into(cx);
    let mut out = Map::new();
    if let Some(previous) = previous {
        out.insert("previous".into(), previous);
    }
    out.insert("steps".into(), Value::Array(results));
    Ok(Some(Value::Object(out)))
}

// ---------------------------------------------------------------- tab-lifecycle

/// `[{ tabs, behavior }, ids]`: `behavior` maps a tab id to `"cancel"` (the
/// tab stays) or the list of ids its close removes (default: itself)
struct FakeCloseManager<'a> {
    tabs: Vec<TabCloseTarget>,
    behavior: &'a Map<String, Value>,
    log: &'a Log,
}

impl TabCloseManager for FakeCloseManager<'_> {
    fn list(&mut self) -> Vec<TabCloseTarget> {
        self.tabs.clone()
    }

    fn close_tab(&mut self, id: &str) {
        self.log.add(vec![Value::from("closeTab"), Value::from(id)]);
        let removed: Vec<String> = match self.behavior.get(id) {
            Some(Value::String(_)) => Vec::new(),
            Some(Value::Array(ids)) => ids
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect(),
            _ => vec![id.to_owned()],
        };
        self.tabs.retain(|tab| !removed.contains(&tab.id));
    }
}

fn close_tabs_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("manager"))?;
    let ids = string_list(args, 1)?;
    let empty = Map::new();
    let log = Log::default();
    let tabs = spec
        .get("tabs")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("tabs"))?
        .iter()
        .map(|tab| {
            Ok(TabCloseTarget {
                id: text(tab, "id")?.to_owned(),
                kind: opt_text(tab, "kind").map(str::to_owned),
                closable: tab.get("closable").and_then(Value::as_bool),
            })
        })
        .collect::<Result<Vec<_>, CallError>>()?;
    let mut manager = FakeCloseManager {
        tabs,
        behavior: spec
            .get("behavior")
            .and_then(Value::as_object)
            .unwrap_or(&empty),
        log: &log,
    };
    close_tabs_in_order(&mut manager, &ids);
    log.drain_into(cx);
    Ok(None)
}

/// `[maxEntries, steps]`: `maxEntries` is a number, `null` (left out) or the
/// string `"NaN"`; each step is `{ op: "push", closed }`, `{ op:
/// "reopenNext", open, exists }` (`open`: path to what `openDocument`
/// answers, `exists`: the paths `fileExists` knows, or `null` for none),
/// `{ op: "getEntries" }` or `{ op: "clear" }`
fn tracker_call(args: &[Value], cx: &mut Context) -> Answer {
    let max = match arg(args, 0) {
        None | Some(Value::Null) => MAX_RECENTLY_CLOSED,
        Some(Value::String(s)) if s == "NaN" => f64::NAN,
        Some(other) => f64_arg(Some(other)),
    };
    let steps = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?;
    let log = Log::default();
    let mut tracker = create_recently_closed_tracker(max);
    let mut results = Vec::new();
    for step in steps {
        results.push(match text(step, "op")? {
            "push" => {
                let closed = step.get("closed").ok_or_else(|| bad("closed"))?;
                tracker.push(opt_text(closed, "kind"), opt_text(closed, "filePath"));
                Value::Null
            }
            "reopenNext" => {
                let open = step.get("open").and_then(Value::as_object);
                let exists = match step.get("exists") {
                    Some(list @ Value::Array(_)) => Some(strings(list)?),
                    _ => None,
                };
                let mut open_document = |path: &str| {
                    log.add(vec![Value::from("open"), Value::from(path)]);
                    open.and_then(|o| o.get(path)) == Some(&Value::Bool(true))
                };
                let mut file_exists = |path: &str| {
                    log.add(vec![Value::from("exists"), Value::from(path)]);
                    exists
                        .as_ref()
                        .is_some_and(|list| list.iter().any(|p| p == path))
                };
                let exists_arg: Option<&mut dyn FnMut(&str) -> bool> =
                    exists_some(&exists, &mut file_exists);
                Value::Bool(tracker.reopen_next(&mut open_document, exists_arg))
            }
            "getEntries" => Value::Array(
                tracker
                    .get_entries()
                    .iter()
                    .map(|e| json!({ "kind": e.kind, "filePath": e.file_path }))
                    .collect(),
            ),
            "clear" => {
                tracker.clear();
                Value::Null
            }
            _ => return Err(bad("op")),
        });
    }
    log.drain_into(cx);
    Ok(Some(Value::Array(results)))
}

/// `fileExists` when the spec gave one
fn exists_some<'a>(
    exists: &Option<Vec<String>>,
    file_exists: &'a mut dyn FnMut(&str) -> bool,
) -> Option<&'a mut dyn FnMut(&str) -> bool> {
    exists.as_ref().map(|_| file_exists)
}

// ---------------------------------------------------------------- tab-duplicate

/// `[path, copySuffix]`
fn duplicate_call(args: &[Value], cx: &mut Context) -> Answer {
    let path = str_arg(args, 0)?;
    let suffix = str_arg(args, 1)?;
    let log = Log::default();
    let mut record = |target: &str| {
        log.add(vec![Value::from("recordRecentFile"), Value::from(target)]);
    };
    let mut on_error = |error: &NodeError| {
        log.add(vec![
            Value::from("onError"),
            json!({
                "code": error.code.map_or(Value::Null, Value::from),
                "message": mask_tmp(&error.message),
            }),
        ]);
    };
    let target = duplicate_document_file(
        path,
        DuplicateFileDeps {
            copy_suffix: suffix,
            record_recent_file: &mut record,
            on_error: &mut on_error,
        },
    );
    log.drain_into(cx);
    Ok(target.map(Value::from))
}

// ---------------------------------------------------------------- tab-document-actions

/// the fake `deps` of `runTabDocumentAction`: a `webContents` is its tab id
struct FakeActionDeps<'a> {
    tabs: Vec<TabSummary>,
    can_detach: Vec<String>,
    no_contents: Vec<String>,
    destroyed: Vec<String>,
    log: &'a Log,
}

impl FakeActionDeps<'_> {
    fn note(&self, name: &str, rest: Vec<Value>) {
        let mut line = vec![Value::from(name)];
        line.extend(rest);
        self.log.add(line);
    }
}

impl TabDocumentActionDeps for FakeActionDeps<'_> {
    type Contents = String;

    fn list(&mut self) -> Vec<TabSummary> {
        self.tabs.clone()
    }

    fn activate_tab(&mut self, id: &str) {
        self.note("activateTab", vec![Value::from(id)]);
    }

    fn can_detach_tab(&mut self, id: &str) -> bool {
        self.note("canDetachTab", vec![Value::from(id)]);
        self.can_detach.iter().any(|d| d == id)
    }

    fn web_contents_for_tab(&mut self, id: &str) -> Option<String> {
        self.note("webContentsForTab", vec![Value::from(id)]);
        (!self.no_contents.iter().any(|d| d == id)).then(|| id.to_owned())
    }

    fn is_destroyed(&mut self, contents: &String) -> bool {
        self.note("isDestroyed", vec![Value::from(contents.as_str())]);
        self.destroyed.contains(contents)
    }

    fn send(&mut self, contents: &String, channel: &str, command: &str) {
        self.note(
            "send",
            vec![
                Value::from(contents.as_str()),
                Value::from(channel),
                Value::from(command),
            ],
        );
    }

    fn save_pdf(&mut self, contents: &String) {
        self.note("savePdf", vec![Value::from(contents.as_str())]);
    }

    fn save_pdf_as(&mut self, target: TabDocumentTarget<String>) {
        let mut entry = Map::new();
        entry.insert("id".into(), Value::from(target.id));
        entry.insert("contentsId".into(), Value::from(target.web_contents));
        if let Some(path) = target.file_path {
            entry.insert("filePath".into(), Value::from(path));
        }
        self.note("savePdfAs", vec![Value::Object(entry)]);
    }

    fn print_pdf(&mut self, contents: &String) {
        self.note("printPdf", vec![Value::from(contents.as_str())]);
    }

    fn save_markdown(&mut self, contents: &String, mode: &str) {
        self.note(
            "saveMarkdown",
            vec![Value::from(contents.as_str()), Value::from(mode)],
        );
    }

    fn print_markdown(&mut self, contents: &String) {
        self.note("printMarkdown", vec![Value::from(contents.as_str())]);
    }

    fn save_html(&mut self, contents: &String, mode: &str) {
        self.note(
            "saveHtml",
            vec![Value::from(contents.as_str()), Value::from(mode)],
        );
    }

    fn print_html(&mut self, contents: &String) {
        self.note("printHtml", vec![Value::from(contents.as_str())]);
    }

    fn save_mindmap(&mut self, contents: &String, mode: &str) {
        self.note(
            "saveMindmap",
            vec![Value::from(contents.as_str()), Value::from(mode)],
        );
    }

    fn print_mindmap(&mut self, contents: &String) {
        self.note("printMindmap", vec![Value::from(contents.as_str())]);
    }

    fn save_hwp(&mut self, contents: &String, mode: &str) {
        self.note(
            "saveHwp",
            vec![Value::from(contents.as_str()), Value::from(mode)],
        );
    }

    fn print_hwp(&mut self, contents: &String) {
        self.note("printHwp", vec![Value::from(contents.as_str())]);
    }
}

fn tab_summaries(value: Option<&Value>) -> Result<Vec<TabSummary>, CallError> {
    value
        .and_then(Value::as_array)
        .ok_or_else(|| bad("tabs"))?
        .iter()
        .map(|tab| {
            Ok(TabSummary {
                id: text(tab, "id")?.to_owned(),
                kind: text(tab, "kind")?.to_owned(),
                title: opt_text(tab, "title").unwrap_or_default().to_owned(),
                closable: flag(tab, "closable"),
                active: flag(tab, "active"),
                file_path: opt_text(tab, "filePath").map(str::to_owned),
            })
        })
        .collect()
}

/// `[{ tabs, canDetach, noContents, destroyed }, id, action]`
fn document_action_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("deps"))?;
    let id = str_arg(args, 1)?;
    let action = str_arg(args, 2)?;
    let list = |key: &str| {
        spec.get(key)
            .map(strings)
            .transpose()
            .map(Option::unwrap_or_default)
    };
    let log = Log::default();
    let mut deps = FakeActionDeps {
        tabs: tab_summaries(spec.get("tabs"))?,
        can_detach: list("canDetach")?,
        no_contents: list("noContents")?,
        destroyed: list("destroyed")?,
        log: &log,
    };
    run_tab_document_action(&mut deps, id, action);
    log.drain_into(cx);
    Ok(None)
}

// ---------------------------------------------------------------- tab-menu

fn click_value(click: &MenuClick) -> Value {
    match click {
        MenuClick::Save(id) => json!(["save", id]),
        MenuClick::SaveAs(id) => json!(["saveAs", id]),
        MenuClick::Print(id) => json!(["print", id]),
        MenuClick::OpenInNewWindow(id) => json!(["openInNewWindow", id]),
        MenuClick::SplitBeside(id) => json!(["splitBeside", id]),
        MenuClick::Rename(id) => json!(["rename", id]),
        MenuClick::Duplicate(path) => json!(["duplicate", path]),
        MenuClick::CopyText(text) => json!(["copyText", text]),
        MenuClick::Reveal(path) => json!(["reveal", path]),
        MenuClick::OpenDefault(path) => json!(["openDefault", path]),
        MenuClick::Move(id, to) => json!(["move", id, num(*to as f64)]),
        MenuClick::CloseTabs(ids) => json!(["closeTabs", ids]),
        MenuClick::ReopenClosed => json!(["reopenClosed"]),
    }
}

/// An entry as the spec shows it: its keys in the order of the TypeScript
/// literal, `click` being the call the click makes (`"(off)"` for an entry
/// that is off: its click is not run).
fn menu_item_value(item: &MenuItem) -> Value {
    let mut map = Map::new();
    if let Some(id) = item.id {
        map.insert("id".into(), Value::from(id));
    }
    if let Some(label) = &item.label {
        map.insert("label".into(), Value::from(label.as_str()));
    }
    if let Some(enabled) = item.enabled {
        map.insert("enabled".into(), Value::Bool(enabled));
    }
    if let Some(kind) = item.item_type {
        map.insert("type".into(), Value::from(kind));
    }
    if let Some(click) = &item.click {
        map.insert(
            "click".into(),
            if item.enabled == Some(false) {
                Value::from("(off)")
            } else {
                click_value(click)
            },
        );
    }
    Value::Object(map)
}

/// `[{ tab, tabs, canDetach, fileExists, canReopen }]`; `tm(key)` is `T:key`
fn menu_call(args: &[Value]) -> Answer {
    let input = arg(args, 0).ok_or_else(|| bad("input"))?;
    let tab = tab_summaries(Some(&json!([input
        .get("tab")
        .cloned()
        .unwrap_or(Value::Null)])))?
    .remove(0);
    let tabs = tab_summaries(input.get("tabs"))?;
    let tm = |key: &str| format!("T:{key}");
    let template = tab_menu_template(&TabMenuInput {
        tab: &tab,
        tabs: &tabs,
        can_detach: flag(input, "canDetach"),
        file_exists: flag(input, "fileExists"),
        can_reopen: flag(input, "canReopen"),
        tm: &tm,
    });
    Ok(Some(Value::Array(
        template.iter().map(menu_item_value).collect(),
    )))
}

// ---------------------------------------------------------------- tab-shortcuts

/// `process.platform`
fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}

fn shortcut_input(value: &Value) -> Result<TabShortcutInput, CallError> {
    Ok(TabShortcutInput {
        input_type: text(value, "type")?.to_owned(),
        key: text(value, "key")?.to_owned(),
        control: flag(value, "control"),
        meta: flag(value, "meta"),
        alt: flag(value, "alt"),
        shift: flag(value, "shift"),
    })
}

/// `[input, platform]`; a `null` platform is the one left out (the host's)
fn shortcut_of_call(args: &[Value]) -> Answer {
    let input = shortcut_input(arg(args, 0).ok_or_else(|| bad("input"))?)?;
    let platform_name = match arg(args, 1) {
        Some(Value::String(p)) => p.as_str(),
        _ => platform(),
    };
    Ok(Some(
        tab_shortcut_of(&input, platform_name).map_or(Value::Null, |s| Value::from(s.as_str())),
    ))
}

struct FakeShortcutHost<'a> {
    shell: Vec<f64>,
    tabs: Vec<f64>,
    active_kind: Option<String>,
    log: &'a Log,
}

impl TabShortcutHost for FakeShortcutHost<'_> {
    fn is_shell_contents(&mut self, id: f64) -> bool {
        self.log.add(vec![Value::from("isShellContents"), num(id)]);
        self.shell.contains(&id)
    }

    fn has_tab(&mut self, id: f64) -> bool {
        self.log.add(vec![Value::from("hasTab"), num(id)]);
        self.tabs.contains(&id)
    }

    fn active_kind(&mut self) -> Option<String> {
        self.log.add(vec![Value::from("activeKind")]);
        self.active_kind.clone()
    }

    fn cycle(&mut self, direction: i32) {
        self.log
            .add(vec![Value::from("cycle"), Value::from(direction)]);
    }

    fn close_active(&mut self) {
        self.log.add(vec![Value::from("closeActive")]);
    }
}

/// `[input, webContentsId, { shell, tabs, activeKind }]`
fn handle_shortcut_call(args: &[Value], cx: &mut Context) -> Answer {
    let input = shortcut_input(arg(args, 0).ok_or_else(|| bad("input"))?)?;
    let id = f64_arg(arg(args, 1));
    let spec = arg(args, 2).ok_or_else(|| bad("host"))?;
    let ids = |key: &str| -> Vec<f64> {
        spec.get(key)
            .and_then(Value::as_array)
            .map(|list| list.iter().map(|v| f64_arg(Some(v))).collect())
            .unwrap_or_default()
    };
    let log = Log::default();
    let mut host = FakeShortcutHost {
        shell: ids("shell"),
        tabs: ids("tabs"),
        active_kind: opt_text(spec, "activeKind").map(str::to_owned),
        log: &log,
    };
    let acted = handle_tab_shortcut(&input, id, &mut host, platform());
    log.drain_into(cx);
    Ok(Some(Value::Bool(acted)))
}

// ---------------------------------------------------------------- split-layout

fn split_call(args: &[Value], run: impl FnOnce(&[Value]) -> Result<Value, CallError>) -> Answer {
    run(args).map(Some)
}

fn rect_arg(args: &[Value], i: usize) -> Result<Rect, CallError> {
    let rect = arg(args, i).ok_or_else(|| bad("rect"))?;
    Ok(Rect {
        x: f64_arg(rect.get("x")),
        y: f64_arg(rect.get("y")),
        width: f64_arg(rect.get("width")),
        height: f64_arg(rect.get("height")),
    })
}

fn rect_value(rect: &Rect) -> Value {
    json!({
        "x": num(rect.x),
        "y": num(rect.y),
        "width": num(rect.width),
        "height": num(rect.height),
    })
}

fn orientation_of(value: Option<&Value>) -> Result<SplitOrientation, CallError> {
    match value.and_then(Value::as_str) {
        Some("side") => Ok(SplitOrientation::Side),
        Some("stack") => Ok(SplitOrientation::Stack),
        _ => Err(bad("orientation")),
    }
}

fn orientation_arg(args: &[Value], i: usize) -> Result<SplitOrientation, CallError> {
    orientation_of(arg(args, i))
}

fn pane_of(value: Option<&Value>) -> Result<Pane, CallError> {
    match value.and_then(Value::as_str) {
        Some("a") => Ok(Pane::A),
        Some("b") => Ok(Pane::B),
        _ => Err(bad("pane")),
    }
}

/// `{ split, dragged: { isDocument, isPaneTab, docPane }, dropped }`
fn decide_drop_value(ctx: Option<&Value>) -> Result<Value, CallError> {
    let ctx = ctx.ok_or_else(|| bad("ctx"))?;
    let split = match ctx.get("split") {
        None | Some(Value::Null) => None,
        Some(s) => Some(DragSplit {
            a_tab_id: text(s, "aTabId")?.to_owned(),
            b_tab_id: text(s, "bTabId")?.to_owned(),
            orientation: orientation_of(s.get("orientation"))?,
            focus: pane_of(s.get("focus"))?,
        }),
    };
    let dragged = ctx.get("dragged").ok_or_else(|| bad("dragged"))?;
    let doc_pane = match dragged.get("docPane") {
        None | Some(Value::Null) => None,
        pane => Some(pane_of(pane)?),
    };
    let intent = decide_split_drop(&SplitDragContext {
        split,
        dragged: DraggedTab {
            is_document: flag(dragged, "isDocument"),
            is_pane_tab: flag(dragged, "isPaneTab"),
            doc_pane,
        },
        dropped: orientation_of(ctx.get("dropped"))?,
    });
    Ok(match intent {
        None => Value::Null,
        Some(SplitDropIntent::Create(o)) => json!({ "kind": "create", "orientation": o.as_str() }),
        Some(SplitDropIntent::Replace) => json!({ "kind": "replace" }),
        Some(SplitDropIntent::Reorient(o)) => {
            json!({ "kind": "reorient", "orientation": o.as_str() })
        }
        Some(SplitDropIntent::Focus) => json!({ "kind": "focus" }),
        Some(SplitDropIntent::Flip(o)) => json!({ "kind": "flip", "orientation": o.as_str() }),
        Some(SplitDropIntent::Noop) => json!({ "kind": "noop" }),
    })
}

/// `{ activeId, previousActiveId, excludeId, tabs }`
fn opposite_value(input: Option<&Value>) -> Result<Value, CallError> {
    let input = input.ok_or_else(|| bad("input"))?;
    let tabs: Vec<OppositeTab> = input
        .get("tabs")
        .and_then(Value::as_array)
        .ok_or_else(|| bad("tabs"))?
        .iter()
        .map(|tab| {
            Ok(OppositeTab {
                id: text(tab, "id")?.to_owned(),
                kind: text(tab, "kind")?.to_owned(),
                present: flag(tab, "present"),
                has_view: flag(tab, "hasView"),
            })
        })
        .collect::<Result<_, CallError>>()?;
    let found = opposite_document_id(
        text(input, "activeId")?,
        opt_text(input, "previousActiveId"),
        text(input, "excludeId")?,
        &tabs,
    );
    Ok(found.map_or(Value::Null, Value::from))
}

// ---------------------------------------------------------------- open-documents

/// `[path, paths]`; `console.warn` is the log line `["console.warn", label,
/// message]`
fn publish_call(args: &[Value], cx: &mut Context) -> Answer {
    // the TypeScript keeps the errors it reported for the process
    thread_local! {
        static REPORTED: RefCell<ReportedWriteErrors> = RefCell::new(ReportedWriteErrors::new());
    }
    let path = str_arg(args, 0)?;
    let paths = string_list(args, 1)?;
    let log = Log::default();
    let published = REPORTED.with(|reported| {
        publish_open_documents(
            path,
            &paths,
            std::process::id(),
            cx.now_ms,
            &mut reported.borrow_mut(),
            &mut |message| {
                log.add(vec![
                    Value::from("console.warn"),
                    Value::from("[shell] open-documents registry write failed:"),
                    Value::from(mask_pid_tmp(message)),
                ]);
            },
        )
    });
    log.drain_into(cx);
    match published {
        Ok(done) => Ok(Some(Value::Bool(done))),
        Err(InvalidTime) => Err(CallError::plain("Invalid time value")),
    }
}

// ---------------------------------------------------------------- file-targets

struct FakeSources<'a> {
    roots: Vec<String>,
    tracked: Vec<String>,
    dirs: Vec<String>,
    log: &'a Log,
}

impl FileTargetSources for FakeSources<'_> {
    fn inside_any_root(&mut self, path: &str) -> bool {
        self.log
            .add(vec![Value::from("insideAnyRoot"), Value::from(path)]);
        self.roots
            .iter()
            .any(|root| path == root || path.starts_with(&format!("{root}/")))
    }

    fn tracked_paths(&self) -> &[String] {
        &self.tracked
    }
}

impl MoveSourceSources for FakeSources<'_> {
    fn is_directory(&mut self, path: &str) -> bool {
        self.log
            .add(vec![Value::from("isDirectory"), Value::from(path)]);
        self.dirs.iter().any(|d| d == path)
    }

    fn is_any_root(&mut self, path: &str) -> bool {
        self.log
            .add(vec![Value::from("isAnyRoot"), Value::from(path)]);
        self.roots.iter().any(|r| r == path)
    }
}

/// `[path, { roots, tracked, dirs }]`; `path` of another type than a string
/// is the one the TypeScript refuses
fn file_target_call(args: &[Value], cx: &mut Context, moving: bool) -> Answer {
    let path = arg(args, 0).and_then(Value::as_str);
    let spec = arg(args, 1).ok_or_else(|| bad("sources"))?;
    let list = |key: &str| -> Result<Vec<String>, CallError> {
        spec.get(key)
            .map(strings)
            .transpose()
            .map(Option::unwrap_or_default)
    };
    let log = Log::default();
    let mut sources = FakeSources {
        roots: list("roots")?,
        tracked: list("tracked")?,
        dirs: list("dirs")?,
        log: &log,
    };
    let answer = if moving {
        is_move_source(path, &mut sources)
    } else {
        is_user_visible_file(path, &mut sources)
    };
    log.drain_into(cx);
    Ok(Some(Value::Bool(answer)))
}

// ---------------------------------------------------------------- result-store-ipc

/// What `ResultStore` of packages/pdf-structure does for the two methods the
/// module calls (that package is not ported): `size` is `folderSize` of the
/// store folder, `deleteAll` is `removeFolder`.
struct FolderStore {
    dir: String,
}

fn folder_size(dir: &str) -> f64 {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0.0;
    };
    let mut total = 0.0;
    for entry in entries.flatten() {
        let path = join(&[dir, &entry.file_name().to_string_lossy()]);
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_dir() {
            total += folder_size(&path);
        } else if kind.is_file() {
            total += fs::metadata(&path).map_or(0.0, |m| m.len() as f64);
        }
    }
    total
}

impl ResultStore for FolderStore {
    fn size(&self) -> f64 {
        folder_size(&self.dir)
    }

    fn delete_all(&self) -> Result<(), StoreError> {
        // rm(dir, { recursive: true, force: true })
        let removed = match fs::symlink_metadata(&self.dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
            Ok(meta) if meta.is_dir() => fs::remove_dir_all(&self.dir),
            Ok(_) => fs::remove_file(&self.dir),
        };
        removed.map_err(|e| StoreError {
            message: e.to_string(),
        })
    }
}

/// `new ResultStore(userDataDir)`
fn make_folder_store(user_data_dir: &str) -> Result<Box<dyn ResultStore>, StoreError> {
    if !is_absolute(user_data_dir) {
        return Err(StoreError {
            message: format!(
                "result store: the user-data folder must be absolute: {user_data_dir}"
            ),
        });
    }
    if user_data_dir
        .split(['/', '\\'])
        .any(|part| part.to_lowercase() == ".genoffice")
    {
        return Err(StoreError {
            message: "result store: ~/.genoffice belongs to the upstream program".to_owned(),
        });
    }
    Ok(Box::new(FolderStore {
        dir: join(&[user_data_dir, "pdf-store"]),
    }))
}

struct FakeIpc<'a> {
    handlers: Vec<(String, IpcHandler)>,
    log: &'a Log,
}

impl IpcHandle for FakeIpc<'_> {
    fn handle(&mut self, channel: &str, handler: IpcHandler) {
        self.log
            .add(vec![Value::from("handle"), Value::from(channel)]);
        self.handlers.push((channel.to_owned(), handler));
    }
}

/// `[userDataDir, steps]`; a step is `"size"` or `"deleteAll"`: the handler
/// of that channel runs and its answer, or the message it threw, is the
/// step's result
fn result_store_call(args: &[Value], cx: &mut Context) -> Answer {
    let dir = str_arg(args, 0)?.to_owned();
    let steps = string_list(args, 1)?;
    let log = Log::default();
    let mut ipc = FakeIpc {
        handlers: Vec::new(),
        log: &log,
    };
    // the lines of `userDataDir()` are written from inside the handlers
    let shared = Rc::new(Log::default());
    let user_data_dir = {
        let (shared, dir) = (shared.clone(), dir.clone());
        Rc::new(move || {
            shared.add(vec![Value::from("userDataDir")]);
            dir.clone()
        })
    };
    register_result_store_ipc(&mut ipc, user_data_dir, Rc::new(make_folder_store));
    let mut results = Vec::new();
    for step in steps {
        let channel = match step.as_str() {
            "size" => RESULT_STORE_SIZE_CHANNEL,
            "deleteAll" => RESULT_STORE_DELETE_ALL_CHANNEL,
            _ => return Err(bad("step")),
        };
        let Some((_, handler)) = ipc.handlers.iter().find(|(c, _)| c == channel) else {
            return Err(bad("channel"));
        };
        results.push(match handler() {
            Ok(Some(value)) => json!({ "value": value }),
            Ok(None) => json!({}),
            Err(e) => json!({ "error": e.message }),
        });
        for line in shared.0.take() {
            log.add(line);
        }
    }
    log.drain_into(cx);
    Ok(Some(Value::Array(results)))
}

// ---------------------------------------------------------------- window-close-guard

/// the families by the key the spec writes them under
const GUARD_FAMILIES: [(&str, Family, &str); 10] = [
    ("sheets", Family::Sheets, "dirtySheetsTabs"),
    ("pdf", Family::Pdf, "dirtyPdfTabs"),
    ("markdown", Family::Markdown, "dirtyMarkdownTabs"),
    ("html", Family::Html, "dirtyHtmlTabs"),
    ("mindmap", Family::Mindmap, "dirtyMindmapTabs"),
    ("hwp", Family::Hwp, "dirtyOrMemoHwpTabs"),
    ("epub", Family::Epub, "dirtyEpubTabs"),
    ("diagram", Family::Diagram, "dirtyDiagramTabs"),
    ("slides", Family::Slides, "dirtySlidesTabs"),
    ("docs", Family::Docs, "docsTabs"),
];

struct GuardHost<'a> {
    spec: &'a Value,
    log: &'a Log,
}

impl CloseGuardHost for GuardHost<'_> {
    type Contents = String;

    fn tabs(&mut self, family: Family) -> Vec<CloseGuardTab<String>> {
        let (key, _, method) = GUARD_FAMILIES
            .iter()
            .find(|(_, f, _)| *f == family)
            .expect("every family is listed");
        self.log.add(vec![Value::from(*method)]);
        self.spec
            .get("tabs")
            .and_then(|tabs| tabs.get(key))
            .and_then(Value::as_array)
            .map(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(|id| CloseGuardTab {
                        id: id.to_owned(),
                        web_contents: id.to_owned(),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn activate_tab(&mut self, id: &str) -> Result<(), String> {
        self.log
            .add(vec![Value::from("activateTab"), Value::from(id)]);
        let throws = self
            .spec
            .get("activateThrows")
            .and_then(Value::as_array)
            .is_some_and(|ids| ids.iter().any(|v| v.as_str() == Some(id)));
        if throws {
            Err(format!("boom activateTab:{id}"))
        } else {
            Ok(())
        }
    }

    fn begin_exclusive_prompt(&mut self) {
        self.log.add(vec![Value::from("beginExclusivePrompt")]);
    }

    fn end_exclusive_prompt(&mut self) {
        self.log.add(vec![Value::from("endExclusivePrompt")]);
    }

    fn reset_sheets_shutting_down(&mut self) {
        self.log.add(vec![Value::from("resetSheetsShuttingDown")]);
    }

    fn on_vetoed(&mut self) -> Option<Result<(), String>> {
        match opt_text(self.spec, "onVetoed") {
            Some("ok") => {
                self.log.add(vec![Value::from("onVetoed")]);
                Some(Ok(()))
            }
            Some("throw") => {
                self.log.add(vec![Value::from("onVetoed")]);
                Some(Err("boom onVetoed".to_owned()))
            }
            _ => None,
        }
    }

    fn is_destroyed(&mut self) -> bool {
        self.log.add(vec![Value::from("isDestroyed")]);
        flag(self.spec, "destroyed")
    }

    fn console_error(&mut self, label: &str, err: &str) {
        self.log.add(vec![
            Value::from("console.error"),
            Value::from(label),
            Value::from(err),
        ]);
    }
}

/// How the spec answers an `await`: `answers["<family>:<id>"]` (the close
/// request) or `answers["docs:<id>:query"]` is `true`, `false` or `"throw"`;
/// the default is `true`.
fn guard_answer(spec: &Value, key: &str) -> Result<bool, String> {
    match spec.get("answers").and_then(|a| a.get(key)) {
        Some(Value::Bool(b)) => Ok(*b),
        Some(Value::String(s)) if s == "throw" => Err(format!("boom {key}")),
        _ => Ok(true),
    }
}

fn family_key(family: Family) -> &'static str {
    GUARD_FAMILIES
        .iter()
        .find(|(_, f, _)| *f == family)
        .map(|(key, _, _)| *key)
        .expect("every family is listed")
}

/// `[{ tabs, answers, activateThrows, onVetoed, destroyed, events }]`:
/// `events` are `"close"` (the window emits `close`) and `"settle"` (every
/// pending prompt gets its answer, the window's own `close()` included)
fn close_guard_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("scenario"))?;
    let events = string_list(&[spec.get("events").cloned().unwrap_or(Value::Null)], 0)?;
    let log = Log::default();
    let mut host = GuardHost { spec, log: &log };
    let mut guard: ShellCloseGuard<String> = ShellCloseGuard::new();
    let mut pending: CloseStep<String> = CloseStep::Idle;

    // `await docsQueryDirty(...)` and `await requestXClose(...)` are called
    // (and log) at the moment the guard asks for them
    let announce = |step: &CloseStep<String>| match step {
        CloseStep::QueryDocsDirty(id) => {
            log.add(vec![
                Value::from("docsQueryDirty"),
                Value::from(id.as_str()),
            ]);
        }
        CloseStep::RequestClose(family, id) => {
            log.add(vec![
                Value::from("requestClose"),
                Value::from(family_key(*family)),
                Value::from(id.as_str()),
                Value::Bool(true),
            ]);
        }
        _ => {}
    };
    // the `close` event of the window; `win.close()` emits it too
    let emit = |guard: &mut ShellCloseGuard<String>,
                host: &mut GuardHost<'_>,
                pending: &mut CloseStep<String>| {
        let event = guard.on_close(host);
        announce(&event.step);
        log.add(vec![
            Value::from("event"),
            Value::from("close"),
            Value::Bool(event.prevent_default),
        ]);
        if event.step != CloseStep::Idle {
            *pending = event.step;
        }
    };
    let settle = |guard: &mut ShellCloseGuard<String>,
                  host: &mut GuardHost<'_>,
                  pending: &mut CloseStep<String>| {
        loop {
            let step = std::mem::replace(pending, CloseStep::Idle);
            let next = match step {
                CloseStep::Idle | CloseStep::Done => return,
                CloseStep::QueryDocsDirty(id) => {
                    guard.resume(host, guard_answer(spec, &format!("docs:{id}:query")))
                }
                CloseStep::RequestClose(family, id) => guard.resume(
                    host,
                    guard_answer(spec, &format!("{}:{id}", family_key(family))),
                ),
                CloseStep::CloseWindow => {
                    log.add(vec![Value::from("win.close")]);
                    let event = guard.on_close(host);
                    log.add(vec![
                        Value::from("event"),
                        Value::from("close"),
                        Value::Bool(event.prevent_default),
                    ]);
                    guard.after_close(host)
                }
            };
            announce(&next);
            *pending = next;
        }
    };
    for event in events.iter().map(String::as_str).chain(["settle"]) {
        match event {
            "close" => emit(&mut guard, &mut host, &mut pending),
            "settle" => settle(&mut guard, &mut host, &mut pending),
            _ => return Err(bad("event")),
        }
    }
    log.drain_into(cx);
    Ok(None)
}
