//! The functions of group `b6-shell` (tools/main-diff/groups/b6-shell.ts):
//! the modules of `apps/shell/src/main` that call Electron (batch B6 of
//! decision 0030). What they call is a fake the spec describes; each call of
//! a fake is one `logs` line, and the TypeScript writes the same lines. A
//! scenario plays the part of the Electron adapter: it carries out what the
//! Rust decides (the box to show, the timer to set) on the fakes.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::rc::Rc;

use jscompat::node_path::host::join;
use jscompat::{JsObject, JsonValue, json_value_from_serde};
use serde_json::{Map, Value};

use super::fakes::{FakeWindow, fake_parent};
use super::{Answer, Context, arg, str_arg};
use crate::node_fs::code_of;
use crate::packages::electron_utils::message_box::MessageBoxOptions;
use crate::packages::electron_utils::permission_guard::{
    AskingContents, CheckDetails, FrameId, GuardedSession, PermissionApp, PermissionCheckHandler,
    PermissionRequestHandler, ReadyListener, SessionCreatedListener, TornDown,
};
use crate::packages::electron_utils::recovery_contract::RecoveryOpenUntitledRequest;
use crate::packages::electron_utils::recovery_store::{
    RecoveryFileIdentity, RecoveryIdentity, RecoveryStoreOptions, RecoveryUntitledIdentity,
    SharedRecoveryState, create_recovery_store,
};
use crate::packages::i18n::{Lang, OLD_HOME_DIR_NAMES, existing_or_current};
use crate::shell::cli_link::{
    CliLinkHost, InstallOutcome, install_cli_link_best_effort, is_ephemeral_install,
    launcher_file_path, write_launcher_file,
};
use crate::shell::crash_log::Thrown;
use crate::shell::crash_watch::{
    ChildGone, CrashContents, CrashPrompt, CrashStringKey, CrashWatch, CrashWatchError,
    CrashWatchHost, CrashedDocument, HEAP_SHORT_SHARE, LOW_MEMORY_FLOOR_MB, LOW_MEMORY_SHARE,
    LowMemoryHost, LowMemoryWatch, MemoryProbe, MemorySource, RenderGone, crash_log_path,
    is_heap_short, is_low_memory, main_process_figures, memory_figures, probe_memory,
    should_prompt_for_gone_renderer,
};
use crate::shell::error_dialog::{ErrorDialog, ErrorValue};
use crate::shell::launch_recovery::{
    PlannedOpen, PlannedTab, RecoveryChoice, RecoveryListItem, RecoveryListResult,
};
use crate::shell::mac_update::{SpawnOptions, SwapChild};
use crate::shell::permission_guard::{ShellPermissionGuardOptions, install_shell_permission_guard};
use crate::shell::pointer_size::{
    POINTER_SIZE_VAR, PointerSize, apply_pointer_size_to, parse_cursor_base_size, read_pointer_size,
};
use crate::shell::recovery_shell::{
    LaunchDeps, LaunchManager, ListedTab, OpenContext, PendingLaunchList, RecoveryContents,
    RecoveryEditors, RecoveryShell, RestoredTabOpener, RestoredTabOpenerDeps, UnloadedTabSpec,
    discard_editor_recovery, editor_recovery_identity, install_recovery_title_sources,
    push_hwp_recovery_titles, restored_tab_opener, run_launch_recovery,
};
use crate::shell::renderer_disposal::{
    Failure, ReleasableContents, RendererDisposal, destroy_closed_view,
};
use crate::shell::renderer_watchdog::{
    BodyParams, ProcessMetric, RendererWatchdog, ReportAnswer, ReportRun, ReportStep,
    WatchdogContents, WatchdogDocumentInfo, WatchdogHost, WatchdogOptions, WatchdogStringKey,
};
use crate::shell::session_record::{
    SessionRecord, SessionRecordProcess, SessionRecorderEnv, write_record_atomic,
};
use crate::shell::ui_scale::{
    StyleTarget, UI_SCALE_KEY, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEPS, UiScale,
    apply_ui_scale_to, apply_ui_scale_to_all, clamp_ui_scale, read_ui_scale, step_ui_scale,
};
use crate::shell::update_build_channel::BuildUpdateChannel;
use crate::shell::update_restart::reopened_by_installer;
use crate::shell::update_resume::install_resume_download;
use crate::shell::updater::{
    CheckResult, CheckReturn, DownloadReturn, Timer, UpdateAction, UpdateError, UpdateStatePatch,
    UpdateUiState, Updater, UpdaterEnv, UpdaterEvent, UpdaterHost, UpdaterSetting,
};

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

fn log_line(log: &Log, line: Vec<Value>) {
    log.borrow_mut().push(line);
}

fn text(x: &str) -> Value {
    Value::from(x)
}

fn num(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

fn field_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn field_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn field_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn list(value: Option<&Value>) -> &[Value] {
    match value.and_then(Value::as_array) {
        Some(items) => items.as_slice(),
        None => &[],
    }
}

/// `Object.keys` of the spec's `contents` table, in the order written
fn entries(value: Option<&Value>) -> Vec<(&String, &Value)> {
    value
        .and_then(Value::as_object)
        .map(|o| o.iter().collect())
        .unwrap_or_default()
}

/// what `await`ing nothing in particular leaves queued: a function that runs
/// its deferred lines at the end of a step
fn take_logs(log: &Log) -> Vec<Vec<Value>> {
    log.take()
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- error-dialog ----
        "error-dialog.showErrorDialog" => error_dialog_call(args, cx),

        // ---- permission-guard ----
        "permission-guard.installShellPermissionGuard" => shell_guard_call(args, cx),

        // ---- cli-link ----
        "cli-link.installCliLinkBestEffort" => cli_link_call(args, cx),
        "cli-link.isEphemeralInstall" => str_arg(args, 0).map(|resources| {
            let appimage = arg(args, 1)
                .and_then(|env| env.get("APPIMAGE"))
                .and_then(Value::as_str);
            Some(Value::Bool(is_ephemeral_install(resources, appimage)))
        }),
        "cli-link.launcherFilePath" => (|| -> Answer {
            let env = arg(args, 0).cloned().unwrap_or(Value::Null);
            let home = str_arg(args, 1)?;
            Ok(Some(Value::from(launcher_file_path(
                field_str(&env, "SEUOFFICE_AUTH_DIR"),
                home,
                app_home_dir,
            ))))
        })(),
        "cli-link.writeLauncherFile" => (|| -> Answer {
            let written = write_launcher_file(str_arg(args, 0)?, str_arg(args, 1)?)?;
            Ok(Some(Value::Bool(written)))
        })(),

        // ---- pointer-size ----
        "pointer-size.POINTER_SIZE_VAR" => Ok(Some(text(POINTER_SIZE_VAR))),
        "pointer-size.parseCursorBaseSize" => str_arg(args, 0)
            .map(|output| Some(parse_cursor_base_size(output).map_or(Value::Null, Value::from))),
        "pointer-size.readPointerSize" => read_pointer_call(args, cx),
        "pointer-size.applyPointerSizeTo" => {
            let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
            let log: Log = Rc::new(RefCell::new(Vec::new()));
            let target = FakeStyle::new("c0", &spec, &log, false);
            apply_pointer_size_to(&target, field_f64(&spec, "px").unwrap_or(0.0) as u32);
            cx.logs.extend(take_logs(&log));
            Ok(None)
        }
        "pointer-size.installPointerSize" => pointer_scenario_call(args, cx),

        // ---- renderer-disposal ----
        "renderer-disposal.releaseClosedRenderer"
        | "renderer-disposal.wasReleasedRenderer"
        | "renderer-disposal.canEndRendererProcess" => disposal_call(args, cx),

        // ---- ui-scale ----
        "ui-scale.UI_SCALE_KEY" => Ok(Some(text(UI_SCALE_KEY))),
        "ui-scale.UI_SCALE_STEPS" => Ok(Some(Value::Array(
            UI_SCALE_STEPS.iter().map(|s| num(*s)).collect(),
        ))),
        "ui-scale.UI_SCALE_MIN" => Ok(Some(num(UI_SCALE_MIN))),
        "ui-scale.UI_SCALE_MAX" => Ok(Some(num(UI_SCALE_MAX))),
        "ui-scale.readUiScale" => str_arg(args, 0).map(|path| Some(num(read_ui_scale(path)))),
        "ui-scale.clampUiScale" => Ok(Some(num(clamp_ui_scale(
            arg(args, 0).and_then(Value::as_f64).unwrap_or(f64::NAN),
        )))),
        "ui-scale.stepUiScale" => Ok(Some(num(step_ui_scale(
            arg(args, 0).and_then(Value::as_f64).unwrap_or(f64::NAN),
            arg(args, 1).and_then(Value::as_i64).unwrap_or(0) as i32,
        )))),
        "ui-scale.applyUiScaleTo" => {
            let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
            let log: Log = Rc::new(RefCell::new(Vec::new()));
            let target = FakeStyle::new("c0", &spec, &log, true);
            apply_ui_scale_to(&target, field_f64(&spec, "scale").unwrap_or(f64::NAN));
            cx.logs.extend(take_logs(&log));
            Ok(None)
        }
        "ui-scale.applyUiScaleToAll" => {
            let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
            let log: Log = Rc::new(RefCell::new(Vec::new()));
            let all = style_targets(&spec, &log);
            apply_ui_scale_to_all(&all, field_f64(&spec, "scale").unwrap_or(f64::NAN));
            cx.logs.extend(take_logs(&log));
            Ok(None)
        }
        "ui-scale.setUiScale" | "ui-scale.onUiScaleChanged" => ui_scale_call(false, args, cx),
        "ui-scale.changeUiScale" => ui_scale_call(true, args, cx),

        // ---- crash-watch ----
        "crash-watch.shouldPromptForGoneRenderer" => str_arg(args, 0)
            .map(|reason| Some(Value::Bool(should_prompt_for_gone_renderer(reason)))),
        "crash-watch.crashLogPath" => {
            let user_data = arg(args, 0)
                .and_then(|o| field_str(o, "userData"))
                .unwrap_or_default();
            cx.logs.push(vec![text("getPath"), text("userData")]);
            Ok(Some(Value::from(crash_log_path(user_data))))
        }
        "crash-watch.mainProcessFigures" | "crash-watch.memoryFigures" => {
            memory_figures_call(name == "crash-watch.mainProcessFigures", args, cx)
        }
        "crash-watch.isLowMemory" => Ok(Some(Value::Bool(is_low_memory(
            arg(args, 0).and_then(Value::as_f64).unwrap_or(f64::NAN),
            arg(args, 1).and_then(Value::as_f64).unwrap_or(f64::NAN),
        )))),
        "crash-watch.isHeapShort" => Ok(Some(Value::Bool(is_heap_short(
            arg(args, 0).and_then(Value::as_f64).unwrap_or(f64::NAN),
            arg(args, 1).and_then(Value::as_f64).unwrap_or(f64::NAN),
        )))),
        "crash-watch.LOW_MEMORY_FLOOR_MB" => Ok(Some(num(LOW_MEMORY_FLOOR_MB))),
        "crash-watch.LOW_MEMORY_SHARE" => Ok(Some(num(LOW_MEMORY_SHARE))),
        "crash-watch.HEAP_SHORT_SHARE" => Ok(Some(num(HEAP_SHORT_SHARE))),
        "crash-watch.startLowMemoryWatch" => low_memory_call(args, cx),
        "crash-watch.startCrashWatch" => crash_watch_call(args, cx),

        // ---- renderer-watchdog ----
        "renderer-watchdog.startRendererWatchdog" => watchdog_call(args, cx),

        // ---- recovery-shell ----
        "recovery-shell.editorRecoveryIdentity"
        | "recovery-shell.tabUntitledCopy"
        | "recovery-shell.crashedUntitledCopy"
        | "recovery-shell.restoredTabOpener"
        | "recovery-shell.reopenUntitledCopy"
        | "recovery-shell.discardEditorRecovery"
        | "recovery-shell.installRecoveryTitleSources"
        | "recovery-shell.pushHwpRecoveryTitles"
        | "recovery-shell.runLaunchRecovery" => recovery_call(args, cx),

        // ---- updater ----
        "updater.checkForUpdatesNow" | "updater.initAutoUpdater" => updater_call(args, cx),

        _ => return None,
    })
}

// ---------------------------------------------------------------------------
// error-dialog
// ---------------------------------------------------------------------------

fn error_value(spec: Option<&Value>) -> ErrorValue {
    let spec = spec.cloned().unwrap_or(Value::Null);
    if field_bool(&spec, "undefined") {
        return ErrorValue::Undefined;
    }
    if let Some(message) = field_str(&spec, "error") {
        return ErrorValue::Error {
            message: message.to_owned(),
        };
    }
    ErrorValue::Other(spec.get("value").cloned().unwrap_or(Value::Null))
}

fn error_dialog_call(args: &[Value], cx: &mut Context) -> Answer {
    let mut dialog = ErrorDialog::new();
    for step in list(arg(args, 0)) {
        if let Some(request) = step.get("call") {
            let parent = fake_parent(request);
            let shown = dialog.show(
                parent.as_ref(),
                field_str(request, "message").unwrap_or_default(),
                &error_value(request.get("err")),
            );
            if let Some(shown) = shown {
                cx.logs.push(vec![
                    text(if shown.over_parent { "over" } else { "box" }),
                    to_value(&shown.options),
                ]);
            }
        }
        if step.get("settle").is_some() {
            dialog.settled();
        }
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// permission-guard
// ---------------------------------------------------------------------------

struct GuardApp {
    log: Log,
    ready: Option<ReadyListener>,
}

impl PermissionApp for GuardApp {
    fn on_session_created(&mut self, _listener: SessionCreatedListener) {
        log_line(&self.log, vec![text("app.on"), text("session-created")]);
    }

    fn when_ready(&mut self, listener: ReadyListener) {
        log_line(&self.log, vec![text("app.whenReady")]);
        self.ready = Some(listener);
    }
}

struct GuardSession {
    log: Log,
    check: Option<PermissionCheckHandler>,
}

impl GuardedSession for GuardSession {
    fn set_permission_request_handler(&mut self, _handler: PermissionRequestHandler) {
        log_line(
            &self.log,
            vec![text("session.setPermissionRequestHandler"), text("default")],
        );
    }

    fn set_permission_check_handler(&mut self, handler: PermissionCheckHandler) {
        log_line(
            &self.log,
            vec![text("session.setPermissionCheckHandler"), text("default")],
        );
        self.check = Some(handler);
    }
}

/// a webContents that has an id and no frames: the probes ask from a top frame
struct BareContents(i64);

impl AskingContents for BareContents {
    fn id(&self) -> i64 {
        self.0
    }
    fn main_frame(&self) -> Result<Option<FrameId>, TornDown> {
        Ok(None)
    }
    fn frames_in_subtree(&self, _frame: FrameId) -> Result<Vec<FrameId>, TornDown> {
        Ok(Vec::new())
    }
    fn frame_url(&self, _frame: FrameId) -> Result<String, TornDown> {
        Ok(String::new())
    }
    fn frame_origin(&self, _frame: FrameId) -> Result<String, TornDown> {
        Ok(String::new())
    }
    fn frame_parent(&self, _frame: FrameId) -> Result<Option<FrameId>, TornDown> {
        Ok(None)
    }
}

fn shell_guard_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let env = spec.get("env").cloned().unwrap_or(Value::Null);
    let mic_open: Vec<i64> = list(spec.get("micOpen"))
        .iter()
        .filter_map(Value::as_i64)
        .collect();
    let mic_log = Rc::clone(&log);
    let mut app = GuardApp {
        log: Rc::clone(&log),
        ready: None,
    };
    install_shell_permission_guard(
        &mut app,
        ShellPermissionGuardOptions {
            microphone_open: Box::new(move |id| {
                log_line(&mic_log, vec![text("microphoneOpen"), Value::from(id)]);
                mic_open.contains(&id)
            }),
            renderer_dir: field_str(&spec, "rendererDir").unwrap_or_default(),
            env: &|name| field_str(&env, name).map(str::to_owned),
        },
    );
    let mut session = GuardSession {
        log: Rc::clone(&log),
        check: None,
    };
    if let Some(ready) = app.ready.take() {
        ready(&mut session);
    }
    let mut results = Vec::new();
    for probe in list(spec.get("probes")) {
        let contents = BareContents(field_f64(probe, "id").unwrap_or(1.0) as i64);
        let details = CheckDetails {
            is_main_frame: true,
            requesting_url: field_str(probe, "url").map(str::to_owned),
            media_type: field_str(probe, "mediaType").map(str::to_owned),
        };
        let answer = session.check.as_ref().map(|check| {
            check(
                Some(&contents as &dyn AskingContents),
                field_str(probe, "permission").unwrap_or_default(),
                "o",
                &details,
            )
        });
        results.push(answer.map_or(Value::Null, Value::Bool));
    }
    cx.logs.extend(take_logs(&log));
    Ok(Some(Value::Array(results)))
}

// ---------------------------------------------------------------------------
// cli-link
// ---------------------------------------------------------------------------

/// `folderHoldsData(dir, depth)` of ai-provider's sources.ts, which the host
/// supplies to cli-link (`appHomeDir` is not ported)
fn folder_holds_data(dir: &str, depth: u32) -> bool {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => {
            let code = code_of(&e);
            return code != Some("ENOENT") && code != Some("ENOTDIR");
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
        if is_dir {
            if depth > 1 && folder_holds_data(&join(&[dir, &name]), depth - 1) {
                return true;
            }
        } else if name != ".DS_Store" {
            return true;
        }
    }
    false
}

/// `appHomeDir(homeDir)`
fn app_home_dir(home: &str) -> String {
    let name = existing_or_current(
        ".seuoffice",
        &OLD_HOME_DIR_NAMES,
        |candidate| Path::new(&join(&[home, candidate])).exists(),
        Some(&mut |candidate| folder_holds_data(&join(&[home, candidate]), 3)),
    );
    join(&[home, &name])
}

struct FakeCliHost {
    spec: Value,
    log: Log,
}

impl CliLinkHost for FakeCliHost {
    fn is_packaged(&self) -> bool {
        field_bool(&self.spec, "packaged")
    }
    fn resources_path(&self) -> String {
        field_str(&self.spec, "resourcesPath")
            .unwrap_or_default()
            .to_owned()
    }
    fn env(&self, name: &str) -> Option<String> {
        self.spec
            .get("env")
            .and_then(|env| field_str(env, name))
            .map(str::to_owned)
    }
    fn platform(&self) -> String {
        field_str(&self.spec, "platform")
            .unwrap_or_default()
            .to_owned()
    }
    fn version(&self) -> String {
        field_str(&self.spec, "version")
            .unwrap_or_default()
            .to_owned()
    }
    fn home_dir(&self) -> String {
        String::new()
    }
    fn app_home_dir(&self, home_dir: &str) -> String {
        app_home_dir(home_dir)
    }
    fn install_cli_link(&self, launcher: &str) -> Result<InstallOutcome, String> {
        // installCliLink answers `unsupported` where it has no way to link;
        // the specs stop there so nothing reaches the machine
        match self.platform().as_str() {
            // no `powershell.exe` on the machines the cases run on: the registry
            // edit cannot start, and the outcome names the launcher's folder
            "win32" => Ok(InstallOutcome {
                status: "unwritable".to_owned(),
                location: Some(jscompat::node_path::win32::dirname(launcher)),
                ..InstallOutcome::default()
            }),
            "darwin" | "linux" => Err("the case would reach the machine".to_owned()),
            _ => Ok(InstallOutcome {
                status: "unsupported".to_owned(),
                ..InstallOutcome::default()
            }),
        }
    }
    fn log(&self, line: &str) {
        log_line(&self.log, vec![text("console.log"), text(line)]);
    }
    fn warn(&self, prefix: &str, detail: &str) {
        log_line(
            &self.log,
            vec![text("console.warn"), text(prefix), text(detail)],
        );
    }
}

fn cli_link_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let host = FakeCliHost {
        spec: spec.clone(),
        log: Rc::new(RefCell::new(Vec::new())),
    };
    install_cli_link_best_effort(&host, field_str(&spec, "settingsPath").unwrap_or_default());
    cx.logs.extend(take_logs(&host.log));
    Ok(None)
}

// ---------------------------------------------------------------------------
// pointer-size and ui-scale: the webContents the style calls write to
// ---------------------------------------------------------------------------

struct FakeStyle {
    name: String,
    destroyed: bool,
    /// the case's `isDestroyed` is a log line (ui-scale), or not (pointer-size)
    log_destroyed: bool,
    log: Log,
}

impl FakeStyle {
    fn new(name: &str, spec: &Value, log: &Log, log_destroyed: bool) -> FakeStyle {
        FakeStyle {
            name: name.to_owned(),
            destroyed: field_bool(spec, "destroyed"),
            log_destroyed,
            log: Rc::clone(log),
        }
    }
}

impl StyleTarget for FakeStyle {
    fn is_destroyed(&self) -> bool {
        if self.log_destroyed {
            log_line(&self.log, vec![text(&self.name), text("isDestroyed")]);
        }
        self.destroyed
    }

    fn execute_javascript(&self, script: &str) {
        // the spec's `rejects` only changes the promise the TypeScript drops
        log_line(
            &self.log,
            vec![text(&self.name), text("execute"), text(script)],
        );
    }
}

/// `getAllWebContents()` of ui-scale's spec: each call is a log line
fn style_targets(spec: &Value, log: &Log) -> impl Fn() -> Vec<Rc<dyn StyleTarget>> {
    let contents: Vec<Rc<dyn StyleTarget>> = list(spec.get("contents"))
        .iter()
        .enumerate()
        .map(|(i, c)| {
            Rc::new(FakeStyle::new(&format!("c{i}"), c, log, true)) as Rc<dyn StyleTarget>
        })
        .collect();
    let log = Rc::clone(log);
    move || {
        log_line(&log, vec![text("getAllWebContents")]);
        contents.clone()
    }
}

fn ui_scale_call(change: bool, args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let all = style_targets(&spec, &log);
    let mut ui = UiScale::new();
    for i in 0..field_f64(&spec, "listeners").unwrap_or(0.0) as usize {
        let listener_log = Rc::clone(&log);
        ui.on_ui_scale_changed(Box::new(move |scale| {
            log_line(
                &listener_log,
                vec![text("listener"), Value::from(i), num(scale)],
            );
        }));
    }
    let path = field_str(&spec, "path").unwrap_or_default();
    let result = if change {
        ui.change_ui_scale(
            path,
            field_f64(&spec, "direction").unwrap_or(0.0) as i32,
            &all,
        )
    } else {
        ui.set_ui_scale(path, field_f64(&spec, "scale").unwrap_or(f64::NAN), &all)
    };
    cx.logs.extend(take_logs(&log));
    let mut out = Map::new();
    match result {
        Ok(value) => {
            out.insert("value".to_owned(), num(value));
        }
        // the message names the temporary file: only the code is compared
        Err(e) => {
            out.insert("threw".to_owned(), e.code.map_or(Value::Null, Value::from));
        }
    }
    Ok(Some(Value::Object(out)))
}

// ---------------------------------------------------------------------------
// pointer-size
// ---------------------------------------------------------------------------

fn read_pointer_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let platform = field_str(&spec, "platform").unwrap_or_default();
    let run_spec = spec.get("run").filter(|v| !v.is_null()).cloned();
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let run_log = Rc::clone(&log);
    let answer = read_pointer_size(
        &mut |cmd, run_args| match &run_spec {
            None => {
                crate::shell::default_app::exec_file_runner(cmd, run_args).map_err(|e| e.message)
            }
            Some(run) => {
                log_line(
                    &run_log,
                    vec![
                        text("run"),
                        text(cmd),
                        Value::Array(run_args.iter().map(|a| text(a)).collect()),
                    ],
                );
                if run.get("throws").is_some() {
                    Err("no such value".to_owned())
                } else {
                    Ok(field_str(run, "output").unwrap_or_default().to_owned())
                }
            }
        },
        platform,
    );
    cx.logs.extend(take_logs(&log));
    Ok(Some(answer.map_or(Value::Null, Value::from)))
}

fn pointer_scenario_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let platform = field_str(&spec, "platform").unwrap_or_default().to_owned();
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let contents: Vec<(String, Rc<FakeStyle>)> = entries(spec.get("contents"))
        .into_iter()
        .map(|(name, c)| (name.clone(), Rc::new(FakeStyle::new(name, c, &log, false))))
        .collect();
    let mut registered: Vec<String> = Vec::new();
    log_line(&log, vec![text("app.on"), text("web-contents-created")]);
    log_line(&log, vec![text("app.on"), text("browser-window-focus")]);
    let all = {
        let log = Rc::clone(&log);
        let contents = contents.clone();
        move || -> Vec<Rc<dyn StyleTarget>> {
            log_line(&log, vec![text("getAllWebContents")]);
            contents
                .iter()
                .map(|(_, c)| Rc::clone(c) as Rc<dyn StyleTarget>)
                .collect()
        }
    };
    let mut size = PointerSize::new();
    let read = |out: Option<&str>| {
        read_pointer_size(
            &mut |_cmd, _args| match out {
                Some(text) => Ok(text.to_owned()),
                None => Err("cat failed".to_owned()),
            },
            &platform,
        )
    };
    let initial = spec
        .get("initialOut")
        .and_then(Value::as_str)
        .map(str::to_owned);
    size.refresh(read(initial.as_deref()), &all);
    for step in list(spec.get("steps")) {
        if step.get("focus").is_some() {
            let out = step.get("out").and_then(Value::as_str).map(str::to_owned);
            size.refresh(read(out.as_deref()), &all);
        } else if let Some(name) = field_str(step, "created") {
            if contents.iter().any(|(n, _)| n == name) {
                log_line(&log, vec![text(name), text("on"), text("did-finish-load")]);
                registered.push(name.to_owned());
            }
        } else if let Some(name) = field_str(step, "load")
            && let Some((_, c)) = contents
                .iter()
                .find(|(n, _)| n == name && registered.iter().any(|r| r == n))
        {
            size.did_finish_load(c.as_ref());
        }
    }
    cx.logs.extend(take_logs(&log));
    Ok(None)
}

// ---------------------------------------------------------------------------
// renderer-disposal
// ---------------------------------------------------------------------------

struct DisposalWorld {
    log: Log,
    specs: Vec<(String, Value)>,
    /// the `setImmediate`s the TypeScript's patch captured, by webContents
    immediates: RefCell<Vec<String>>,
    /// the contents that were given a `render-process-gone` listener
    once: RefCell<Vec<String>>,
}

#[derive(Clone)]
struct DisposalFake {
    world: Rc<DisposalWorld>,
    name: String,
}

impl DisposalFake {
    fn spec(&self) -> &Value {
        self.world
            .specs
            .iter()
            .find(|(n, _)| *n == self.name)
            .map_or(&Value::Null, |(_, v)| v)
    }

    fn line(&self, method: &str) {
        log_line(&self.world.log, vec![text(&self.name), text(method)]);
    }

    fn throw_if(&self, method: &str) -> Result<(), Failure> {
        let throws = list(self.spec().get("throws"));
        if throws.iter().any(|m| m.as_str() == Some(method)) {
            Err(Failure(format!("{}.{method} failed", self.name)))
        } else {
            Ok(())
        }
    }
}

impl ReleasableContents for DisposalFake {
    fn id(&self) -> i64 {
        field_f64(self.spec(), "id").unwrap_or(0.0) as i64
    }

    fn is_destroyed(&self) -> Result<bool, Failure> {
        self.line("isDestroyed");
        self.throw_if("isDestroyed")?;
        Ok(field_bool(self.spec(), "destroyed"))
    }

    fn get_os_process_id(&self) -> Result<i64, Failure> {
        self.line("getOSProcessId");
        self.throw_if("getOSProcessId")?;
        Ok(field_f64(self.spec(), "pid").unwrap_or(0.0) as i64)
    }

    fn forcefully_crash_renderer(&self) -> Result<(), Failure> {
        self.line("forcefullyCrashRenderer");
        self.throw_if("forcefullyCrashRenderer")
    }

    fn once_render_process_gone_destroy(&self) -> Result<(), Failure> {
        log_line(
            &self.world.log,
            vec![text(&self.name), text("once"), text("render-process-gone")],
        );
        self.throw_if("once")?;
        self.world.once.borrow_mut().push(self.name.clone());
        Ok(())
    }

    fn destroy_soon(&self) -> Result<(), Failure> {
        log_line(&self.world.log, vec![text("setImmediate")]);
        self.world.immediates.borrow_mut().push(self.name.clone());
        Ok(())
    }

    fn close(&self) -> Result<(), Failure> {
        self.line("close");
        self.throw_if("close")
    }
}

fn disposal_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let world = Rc::new(DisposalWorld {
        log: Rc::new(RefCell::new(Vec::new())),
        specs: entries(spec.get("contents"))
            .into_iter()
            .map(|(n, v)| (n.clone(), v.clone()))
            .collect(),
        immediates: RefCell::new(Vec::new()),
        once: RefCell::new(Vec::new()),
    });
    let fake = |name: &str| DisposalFake {
        world: Rc::clone(&world),
        name: name.to_owned(),
    };
    let peers_throw = field_bool(&spec, "peersThrow");
    let mut state = RendererDisposal::new();
    let mut results: Vec<Value> = Vec::new();
    for step in list(spec.get("steps")) {
        if let Some(name) = field_str(step, "release") {
            let target = fake(name);
            let mut all = || -> Result<Vec<Box<dyn ReleasableContents>>, Failure> {
                log_line(&world.log, vec![text("getAllWebContents")]);
                if peers_throw {
                    return Err(Failure("getAllWebContents failed".to_owned()));
                }
                Ok(world
                    .specs
                    .iter()
                    .map(|(n, _)| Box::new(fake(n)) as Box<dyn ReleasableContents>)
                    .collect())
            };
            let released = state.release_closed_renderer(&target, &mut all);
            results.push(Value::Bool(released));
        } else if step.get("flush").is_some() {
            loop {
                let next = {
                    let mut queue = world.immediates.borrow_mut();
                    if queue.is_empty() {
                        None
                    } else {
                        Some(queue.remove(0))
                    }
                };
                let Some(name) = next else { break };
                destroy_closed_view(&fake(&name));
            }
        } else if let Some(name) = field_str(step, "emit") {
            let known = world.once.borrow().iter().any(|n| n == name);
            if known {
                let _ = fake(name).destroy_soon();
            }
        } else if let Some(name) = field_str(step, "was") {
            let id = world
                .specs
                .iter()
                .find(|(n, _)| n == name)
                .map_or(i64::MAX, |_| fake(name).id());
            results.push(Value::Bool(state.was_released_renderer(id)));
        } else if let Some(request) = step.get("can") {
            let target = fake(field_str(request, "target").unwrap_or_default());
            let peers: Vec<DisposalFake> = list(request.get("peers"))
                .iter()
                .map(|n| fake(n.as_str().unwrap_or_default()))
                .collect();
            let refs: Vec<&dyn ReleasableContents> =
                peers.iter().map(|p| p as &dyn ReleasableContents).collect();
            results.push(match state.can_end_renderer_process(&target, &refs) {
                Ok(can) => Value::Bool(can),
                Err(Failure(message)) => {
                    let mut o = Map::new();
                    o.insert("error".to_owned(), Value::from(message));
                    Value::Object(o)
                }
            });
        }
    }
    cx.logs.extend(take_logs(&world.log));
    Ok(Some(Value::Array(results)))
}

// ---------------------------------------------------------------------------
// crash-watch: the memory figures and the low-memory watch
// ---------------------------------------------------------------------------

/// `SRC` of the spec
fn default_sources() -> Value {
    const MB: f64 = 1024.0 * 1024.0;
    let mut o = Map::new();
    o.insert(
        "appKB".to_owned(),
        Value::Array(vec![num(51_200.0), num(102_400.0), num(1_000.0)]),
    );
    o.insert("free".to_owned(), num(3000.4 * MB));
    o.insert("total".to_owned(), num(16_000.5 * MB));
    o.insert("ai".to_owned(), num(2.0));
    o.insert("cli".to_owned(), num(1.0));
    o.insert("heapUsed".to_owned(), num(120.5 * MB));
    o.insert("heapLimit".to_owned(), num(4144.0 * MB));
    o.insert("rss".to_owned(), num(310.49 * MB));
    Value::Object(o)
}

/// the machine the figures read: each read is one log line
struct SourceFake {
    src: Value,
    log: Log,
}

impl SourceFake {
    fn read(&self, key: &str) -> f64 {
        field_f64(&self.src, key).unwrap_or(0.0)
    }
}

impl MemorySource for SourceFake {
    fn app_working_set_sizes(&self) -> Vec<f64> {
        log_line(&self.log, vec![text("getAppMetrics")]);
        list(self.src.get("appKB"))
            .iter()
            .filter_map(Value::as_f64)
            .collect()
    }
    fn freemem(&self) -> f64 {
        log_line(&self.log, vec![text("freemem")]);
        self.read("free")
    }
    fn totalmem(&self) -> f64 {
        log_line(&self.log, vec![text("totalmem")]);
        self.read("total")
    }
    fn ai_streams(&self) -> f64 {
        log_line(&self.log, vec![text("aiStreams")]);
        self.read("ai")
    }
    fn cli_children(&self) -> f64 {
        log_line(&self.log, vec![text("cliChildren")]);
        self.read("cli")
    }
    fn heap_statistics(&self) -> (f64, f64) {
        log_line(&self.log, vec![text("getHeapStatistics")]);
        (self.read("heapUsed"), self.read("heapLimit"))
    }
    fn rss(&self) -> f64 {
        log_line(&self.log, vec![text("rss")]);
        self.read("rss")
    }
}

fn memory_figures_call(main_only: bool, args: &[Value], cx: &mut Context) -> Answer {
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let source = SourceFake {
        src: arg(args, 0).cloned().unwrap_or(Value::Null),
        log: Rc::clone(&log),
    };
    let figures = if main_only {
        main_process_figures(&source)
    } else {
        memory_figures(&source)
    };
    cx.logs.extend(take_logs(&log));
    Ok(Some(to_value(&figures)))
}

fn memory_of(fields: &[(&str, f64)]) -> JsObject<JsonValue> {
    let mut memory = JsObject::new();
    for (key, value) in fields {
        memory.set(*key, JsonValue::Number(*value));
    }
    memory
}

struct LowHost {
    spec: Value,
    log: Log,
    clock: Rc<Cell<f64>>,
    probe: Rc<RefCell<Option<Value>>>,
    source: SourceFake,
    now_ms: f64,
}

impl LowMemoryHost for LowHost {
    fn user_data_dir(&self) -> String {
        log_line(&self.log, vec![text("getPath"), text("userData")]);
        field_str(&self.spec, "userData")
            .unwrap_or_default()
            .to_owned()
    }

    fn memory(&self) -> Result<JsObject<JsonValue>, Failure> {
        log_line(&self.log, vec![text("memory")]);
        if field_str(&self.spec, "memory") == Some("throws") {
            return Err(Failure("memory failed".to_owned()));
        }
        Ok(memory_of(&[("appMB", 100.0), ("aiStreams", 1.0)]))
    }

    fn probe(&self) -> Result<MemoryProbe, Failure> {
        if field_str(&self.spec, "probe") != Some("given") {
            return Ok(probe_memory(&self.source));
        }
        log_line(&self.log, vec![text("probe")]);
        match &*self.probe.borrow() {
            Some(p @ Value::Object(_)) => Ok(MemoryProbe {
                free_mb: field_f64(p, "freeMB").unwrap_or(f64::NAN),
                total_mb: field_f64(p, "totalMB").unwrap_or(f64::NAN),
                heap_mb: field_f64(p, "heapMB").unwrap_or(f64::NAN),
                heap_limit_mb: field_f64(p, "heapLimitMB").unwrap_or(f64::NAN),
            }),
            _ => Err(Failure("probe failed".to_owned())),
        }
    }

    fn now(&self) -> f64 {
        log_line(&self.log, vec![text("now")]);
        self.clock.get()
    }

    fn clock_ms(&self) -> f64 {
        self.now_ms
    }
}

fn low_memory_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let src = spec.get("src").cloned().unwrap_or_else(default_sources);
    let host = LowHost {
        spec: spec.clone(),
        log: Rc::clone(&log),
        clock: Rc::new(Cell::new(0.0)),
        probe: Rc::new(RefCell::new(None)),
        source: SourceFake {
            src,
            log: Rc::clone(&log),
        },
        now_ms: cx.now_ms,
    };
    let mut watch =
        LowMemoryWatch::new(field_f64(&spec, "sampleMs"), field_f64(&spec, "cooldownMs"));
    log_line(&log, vec![text("setInterval"), num(watch.sample_ms())]);
    log_line(&log, vec![text("unref")]);
    for step in list(spec.get("steps")) {
        if let Some(clock) = field_f64(step, "clock") {
            host.clock.set(clock);
        }
        *host.probe.borrow_mut() = step.get("probe").cloned();
        if step.get("stop").is_some() {
            log_line(&log, vec![text("clearInterval")]);
        } else {
            watch.sample(&host);
        }
    }
    cx.logs.extend(take_logs(&log));
    Ok(None)
}

// ---------------------------------------------------------------------------
// crash-watch
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct CrashWc {
    name: String,
    id: i64,
    spec: Value,
    /// `spec.destroyed`, which a `destroy` event sets while a box is up
    destroyed: Rc<Cell<bool>>,
    log: Log,
}

impl CrashContents for CrashWc {
    fn id(&self) -> i64 {
        self.id
    }
    fn is_destroyed(&self) -> bool {
        self.destroyed.get()
    }
    fn reload(&self) -> Result<(), Failure> {
        log_line(&self.log, vec![text("reload"), text(&self.name)]);
        if field_bool(&self.spec, "reloadThrows") {
            Err(Failure("reload failed".to_owned()))
        } else {
            Ok(())
        }
    }
}

struct CrashHost {
    spec: Value,
    log: Log,
    now_ms: f64,
}

impl CrashHost {
    fn line(&self, method: &str, wc: &CrashWc) {
        log_line(&self.log, vec![text(method), text(&wc.name)]);
    }
}

impl CrashWatchHost for CrashHost {
    type Contents = CrashWc;
    type Window = FakeWindow;
    type Copy = Value;

    fn user_data_dir(&self) -> String {
        log_line(&self.log, vec![text("getPath"), text("userData")]);
        field_str(&self.spec, "userData")
            .unwrap_or_default()
            .to_owned()
    }

    fn now_ms(&self) -> f64 {
        self.now_ms
    }

    fn editor_of(&self, wc: &CrashWc) -> Result<String, Failure> {
        self.line("editorOf", wc);
        match field_str(&wc.spec, "editor") {
            Some("throws") => Err(Failure("editorOf failed".to_owned())),
            Some(editor) => Ok(editor.to_owned()),
            None => Ok("docs".to_owned()),
        }
    }

    fn document_of(&self, wc: &CrashWc) -> Result<Option<CrashedDocument>, Failure> {
        self.line("documentOf", wc);
        Ok(wc
            .spec
            .get("doc")
            .filter(|doc| doc.is_object())
            .map(|doc| CrashedDocument {
                kind: field_str(doc, "kind").unwrap_or_default().to_owned(),
                title: field_str(doc, "title").unwrap_or_default().to_owned(),
                file_path: field_str(doc, "filePath").map(str::to_owned),
            }))
    }

    fn parent_window(&self, wc: &CrashWc) -> Result<Option<FakeWindow>, Failure> {
        self.line("parentWindow", wc);
        if field_str(&wc.spec, "parent") == Some("throws") {
            return Err(Failure("parentWindow failed".to_owned()));
        }
        Ok(fake_parent(&wc.spec))
    }

    fn close_document(&self, wc: &CrashWc) -> Result<bool, Failure> {
        self.line("closeDocument", wc);
        match wc.spec.get("close") {
            Some(Value::String(s)) if s == "throws" => {
                Err(Failure("closeDocument failed".to_owned()))
            }
            Some(Value::Bool(close)) => Ok(*close),
            _ => Ok(true),
        }
    }

    fn reopen(&self, file_path: &str) -> Result<(), Failure> {
        log_line(&self.log, vec![text("reopen"), text(file_path)]);
        Ok(())
    }

    fn untitled_copy_of(&self, wc: &CrashWc) -> Result<Option<Value>, Failure> {
        if !field_bool(&self.spec, "untitledCopyOf") {
            return Ok(None);
        }
        self.line("untitledCopyOf", wc);
        match field_str(&wc.spec, "untitled") {
            Some("throws") => Err(Failure("untitledCopyOf failed".to_owned())),
            Some("copy") => {
                let mut copy = Map::new();
                copy.insert("copyOf".to_owned(), text(&wc.name));
                Ok(Some(Value::Object(copy)))
            }
            _ => Ok(None),
        }
    }

    fn can_reopen_untitled(&self) -> bool {
        field_bool(&self.spec, "reopenUntitled")
    }

    fn reopen_untitled(&self, doc: &CrashedDocument, copy: &Value) -> Result<(), Failure> {
        let mut shown = Map::new();
        shown.insert("kind".to_owned(), text(&doc.kind));
        shown.insert("title".to_owned(), text(&doc.title));
        if let Some(path) = &doc.file_path {
            shown.insert("filePath".to_owned(), text(path));
        }
        log_line(
            &self.log,
            vec![text("reopenUntitled"), Value::Object(shown), copy.clone()],
        );
        Ok(())
    }

    fn t(&self, key: CrashStringKey, title: Option<&str>) -> String {
        log_line(
            &self.log,
            vec![
                text("t"),
                text(key.as_str()),
                title.map_or(Value::Null, text),
            ],
        );
        match title {
            Some(title) => format!("<{}:{title}>", key.as_str()),
            None => format!("<{}>", key.as_str()),
        }
    }

    fn prompt(&self) -> bool {
        field_bool(&self.spec, "prompt")
    }

    fn memory(&self) -> Option<Result<JsObject<JsonValue>, Failure>> {
        match field_str(&self.spec, "memory") {
            Some("none") => None,
            Some("throws") => {
                log_line(&self.log, vec![text("memory")]);
                Some(Err(Failure("memory failed".to_owned())))
            }
            _ => {
                log_line(&self.log, vec![text("memory")]);
                Some(Ok(memory_of(&[("appMB", 100.0), ("freeMB", 2000.0)])))
            }
        }
    }

    fn warn_unhandled_rejection(&self, error: &str) {
        log_line(
            &self.log,
            vec![
                text("warn"),
                text("[main] unhandled rejection:"),
                text(error),
            ],
        );
    }
}

/// a view the shell closed on purpose: `isDestroyed` is all `releaseClosedRenderer` asks
struct ReleasedContents(i64);

impl ReleasableContents for ReleasedContents {
    fn id(&self) -> i64 {
        self.0
    }
    fn is_destroyed(&self) -> Result<bool, Failure> {
        Ok(true)
    }
    fn get_os_process_id(&self) -> Result<i64, Failure> {
        Err(Failure("not asked".to_owned()))
    }
    fn forcefully_crash_renderer(&self) -> Result<(), Failure> {
        Err(Failure("not asked".to_owned()))
    }
    fn once_render_process_gone_destroy(&self) -> Result<(), Failure> {
        Err(Failure("not asked".to_owned()))
    }
    fn destroy_soon(&self) -> Result<(), Failure> {
        Err(Failure("not asked".to_owned()))
    }
    fn close(&self) -> Result<(), Failure> {
        Err(Failure("not asked".to_owned()))
    }
}

/// `errorReason`'s argument and what the console prints for it
fn thrown_of(spec: &Value) -> (Thrown, String) {
    if let Some(value) = spec.get("value") {
        let typeof_value = match value {
            Value::String(_) => "string",
            Value::Number(_) => "number",
            Value::Bool(_) => "boolean",
            _ => "object",
        };
        let shown = jscompat::value_to_string(Some(value));
        return (Thrown::Other(typeof_value), shown);
    }
    let error = spec.get("error").cloned().unwrap_or(Value::Null);
    let json = |key: &str| error.get(key).map(json_value_from_serde);
    (
        Thrown::Error {
            name: json("name"),
            code: json("code"),
        },
        field_str(&error, "message").unwrap_or("x").to_owned(),
    )
}

fn crash_watch_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let wcs: Vec<CrashWc> = entries(spec.get("wcs"))
        .into_iter()
        .map(|(name, wc)| CrashWc {
            name: name.clone(),
            id: field_f64(wc, "id").unwrap_or(0.0) as i64,
            spec: wc.clone(),
            destroyed: Rc::new(Cell::new(field_bool(wc, "destroyed"))),
            log: Rc::clone(&log),
        })
        .collect();
    let find = |name: &str| wcs.iter().find(|w| w.name == name).cloned();
    let mut disposal = RendererDisposal::new();
    log_line(
        &log,
        vec![text("process.on"), text("uncaughtExceptionMonitor")],
    );
    log_line(&log, vec![text("process.on"), text("unhandledRejection")]);
    log_line(&log, vec![text("app.on"), text("child-process-gone")]);
    log_line(&log, vec![text("app.on"), text("render-process-gone")]);
    for name in list(spec.get("released")) {
        if let Some(wc) = name.as_str().and_then(find) {
            disposal.release_closed_renderer(&ReleasedContents(wc.id), &mut || Ok(Vec::new()));
        }
    }
    let mut watch = CrashWatch::start(CrashHost {
        spec: spec.clone(),
        log: Rc::clone(&log),
        now_ms: cx.now_ms,
    });
    let mut pending: Vec<(CrashWc, CrashPrompt<Value>)> = Vec::new();
    for event in list(spec.get("events")) {
        if let Some(error) = event.get("exception") {
            let (thrown, _) = thrown_of(error);
            let _ = watch.on_uncaught_exception_monitor(&thrown);
        } else if let Some(error) = event.get("rejection") {
            let (thrown, shown) = thrown_of(error);
            let _ = watch.on_unhandled_rejection(&thrown, &shown);
        } else if let Some(details) = event.get("child") {
            let _ = watch.on_child_process_gone(&ChildGone {
                reason: field_str(details, "reason").unwrap_or_default().to_owned(),
                exit_code: field_f64(details, "exitCode").unwrap_or(f64::NAN),
                kind: field_str(details, "type").unwrap_or_default().to_owned(),
            });
        } else if let Some(render) = event.get("render") {
            let Some(wc) = field_str(render, "wc").and_then(find) else {
                continue;
            };
            let details = RenderGone {
                reason: field_str(render, "reason").unwrap_or_default().to_owned(),
                exit_code: field_f64(render, "exitCode").unwrap_or(f64::NAN),
            };
            match watch.on_render_process_gone(&disposal, &wc, &details) {
                Ok(Some(prompt)) => {
                    log_line(
                        &log,
                        vec![
                            text(if prompt.over_parent { "over" } else { "box" }),
                            to_value(&prompt.options),
                        ],
                    );
                    pending.push((wc, prompt));
                }
                Ok(None) => {}
                Err(CrashWatchError::InvalidTime(_) | CrashWatchError::Rejected(_)) => {}
            }
        } else if let Some(name) = event.get("destroy").and_then(Value::as_str) {
            if let Some(wc) = find(name) {
                wc.destroyed.set(true);
            }
        } else if let Some(answer) = event.get("answer") {
            if pending.is_empty() {
                continue;
            }
            let (wc, prompt) = pending.remove(0);
            let response = match answer.as_f64() {
                Some(response) => Ok(response),
                None => Err(Failure("dialog failed".to_owned())),
            };
            watch.finish_prompt(&wc, prompt, response);
        }
    }
    cx.logs.extend(take_logs(&log));
    Ok(None)
}

// ---------------------------------------------------------------------------
// renderer-watchdog
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct DogWc {
    name: String,
    spec: Value,
    /// how many times `isDestroyed` was asked: `destroyedAfter` counts them
    destroyed_calls: Rc<Cell<f64>>,
    log: Log,
}

impl WatchdogContents for DogWc {
    fn id(&self) -> i64 {
        field_f64(&self.spec, "id").unwrap_or(0.0) as i64
    }
    fn is_destroyed(&self) -> bool {
        let calls = self.destroyed_calls.get() + 1.0;
        self.destroyed_calls.set(calls);
        field_bool(&self.spec, "destroyed")
            || field_f64(&self.spec, "destroyedAfter").is_some_and(|after| calls > after)
    }
    fn get_os_process_id(&self) -> i64 {
        field_f64(&self.spec, "pid").unwrap_or(0.0) as i64
    }
    fn get_url(&self) -> String {
        field_str(&self.spec, "url").unwrap_or_default().to_owned()
    }
    fn debugger_is_attached(&self) -> bool {
        field_bool(&self.spec, "attached")
    }
    fn debugger_attach(&self, protocol: &str) -> Result<(), Failure> {
        log_line(
            &self.log,
            vec![text(&self.name), text("attach"), text(protocol)],
        );
        Ok(())
    }
    fn debugger_detach(&self) -> Result<(), Failure> {
        log_line(&self.log, vec![text(&self.name), text("detach")]);
        Ok(())
    }
}

/// `metricJson` of the spec
fn metric_json(m: &Value) -> Value {
    let mut memory = Map::new();
    memory.insert(
        "workingSetSize".to_owned(),
        num(field_f64(m, "memKB").unwrap_or(f64::NAN)),
    );
    let mut cpu = Map::new();
    cpu.insert("percentCPUUsage".to_owned(), Value::from(0));
    if let Some(cumulative) = field_f64(m, "cpu") {
        cpu.insert("cumulativeCPUUsage".to_owned(), num(cumulative));
    }
    let mut out = Map::new();
    out.insert(
        "pid".to_owned(),
        num(field_f64(m, "pid").unwrap_or(f64::NAN)),
    );
    out.insert(
        "type".to_owned(),
        text(field_str(m, "type").unwrap_or_default()),
    );
    out.insert("memory".to_owned(), Value::Object(memory));
    out.insert("cpu".to_owned(), Value::Object(cpu));
    Value::Object(out)
}

struct DogHost {
    spec: Value,
    log: Log,
    wcs: Vec<DogWc>,
    clock: Rc<Cell<f64>>,
    metrics: Rc<RefCell<Value>>,
}

impl WatchdogHost for DogHost {
    type Contents = DogWc;
    type Window = FakeWindow;

    fn user_data_dir(&self) -> String {
        log_line(&self.log, vec![text("getPath"), text("userData")]);
        field_str(&self.spec, "userData")
            .unwrap_or_default()
            .to_owned()
    }

    fn now_ms(&self) -> f64 {
        self.clock.get()
    }

    fn app_metrics(&self) -> Result<Vec<ProcessMetric>, Failure> {
        log_line(&self.log, vec![text("getAppMetrics")]);
        let metrics = self.metrics.borrow();
        if metrics.as_str() == Some("throws") {
            return Err(Failure("getAppMetrics failed".to_owned()));
        }
        Ok(list(Some(&*metrics))
            .iter()
            .map(|m| ProcessMetric {
                pid: field_f64(m, "pid").unwrap_or(0.0) as i64,
                kind: field_str(m, "type").unwrap_or_default().to_owned(),
                working_set_size: field_f64(m, "memKB").unwrap_or(f64::NAN),
                cumulative_cpu_usage: field_f64(m, "cpu"),
                json: metric_json(m),
            })
            .collect())
    }

    fn all_web_contents(&self) -> Vec<DogWc> {
        log_line(&self.log, vec![text("getAllWebContents")]);
        self.wcs.clone()
    }

    fn describe(&self, wc: &DogWc) -> Result<Option<WatchdogDocumentInfo>, Failure> {
        log_line(&self.log, vec![text("describe"), text(&wc.name)]);
        Ok(wc
            .spec
            .get("doc")
            .filter(|doc| doc.is_object())
            .map(|doc| WatchdogDocumentInfo {
                kind: field_str(doc, "kind").unwrap_or_default().to_owned(),
                title: field_str(doc, "title").unwrap_or_default().to_owned(),
                file_path: field_str(doc, "filePath").map(str::to_owned),
            }))
    }

    fn parent_window(&self, wc: &DogWc) -> Result<Option<FakeWindow>, Failure> {
        log_line(&self.log, vec![text("parentWindow"), text(&wc.name)]);
        if field_str(&wc.spec, "parent") == Some("throws") {
            return Err(Failure("parentWindow failed".to_owned()));
        }
        Ok(fake_parent(&wc.spec))
    }

    fn t(&self, key: WatchdogStringKey, params: Option<&BodyParams>) -> String {
        let shown = params.map_or(Value::Null, |p| {
            let mut o = Map::new();
            o.insert("title".to_owned(), text(&p.title));
            o.insert("memory".to_owned(), num(p.memory));
            o.insert("cpu".to_owned(), num(p.cpu));
            Value::Object(o)
        });
        log_line(&self.log, vec![text("t"), text(key.as_str()), shown]);
        format!("<{}>", key.as_str())
    }
}

/// `await wc.debugger.sendCommand(method, params)` as the spec's fake answers it
fn dog_command(
    wc: &DogWc,
    log: &Log,
    method: &str,
    params: Option<Value>,
) -> Result<Value, Failure> {
    log_line(
        log,
        vec![
            text(&wc.name),
            text("send"),
            text(method),
            params.unwrap_or(Value::Null),
        ],
    );
    if field_str(&wc.spec, "failOn") == Some(method) {
        return Err(Failure(format!("{method} failed")));
    }
    if method == "Profiler.stop" {
        let mut node = Map::new();
        node.insert("id".to_owned(), Value::from(1));
        let mut profile = Map::new();
        profile.insert("nodes".to_owned(), Value::Array(vec![Value::Object(node)]));
        profile.insert("name".to_owned(), text(&wc.name));
        let mut out = Map::new();
        out.insert("profile".to_owned(), Value::Object(profile));
        return Ok(Value::Object(out));
    }
    Ok(Value::Object(Map::new()))
}

/// Carries out the steps of a report until it ends or its box is up: `true`
/// when the box is up (the report waits for its answer).
fn drive_report(
    dog: &RendererWatchdog,
    host: &DogHost,
    log: &Log,
    run: &mut ReportRun<DogWc>,
    mut step: ReportStep<DogWc>,
) -> bool {
    loop {
        let answer = match step {
            ReportStep::Command { wc, method, params } => {
                ReportAnswer::Command(dog_command(&wc, log, method, params))
            }
            ReportStep::Sleep(_) => ReportAnswer::Slept,
            ReportStep::Prompt {
                options,
                over_parent,
            } => {
                log_line(
                    log,
                    vec![
                        text(if over_parent { "over" } else { "box" }),
                        to_value(&options),
                    ],
                );
                return true;
            }
            ReportStep::CloseDocument(wc) => {
                log_line(log, vec![text("closeDocument"), text(&wc.name)]);
                ReportAnswer::Closed(if field_str(&wc.spec, "close") == Some("throws") {
                    Err(Failure("closeDocument failed".to_owned()))
                } else {
                    Ok(())
                })
            }
            ReportStep::Done => return false,
        };
        step = run.resume(dog, host, answer);
    }
}

fn watchdog_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let wcs: Vec<DogWc> = entries(spec.get("wcs"))
        .into_iter()
        .map(|(name, wc)| DogWc {
            name: name.clone(),
            spec: wc.clone(),
            destroyed_calls: Rc::new(Cell::new(0.0)),
            log: Rc::clone(&log),
        })
        .collect();
    let host = DogHost {
        spec: spec.clone(),
        log: Rc::clone(&log),
        wcs,
        clock: Rc::new(Cell::new(cx.now_ms)),
        metrics: Rc::new(RefCell::new(Value::Array(Vec::new()))),
    };
    let options = spec.get("options").cloned().unwrap_or(Value::Null);
    // startRendererWatchdog reads the machine's memory first
    log_line(&log, vec![text("totalmem")]);
    let mut dog = RendererWatchdog::new(
        WatchdogOptions {
            sample_ms: field_f64(&options, "sampleMs"),
            memory_limit_mb: field_f64(&options, "memoryLimitMB"),
            cpu_limit_percent: field_f64(&options, "cpuLimitPercent"),
            hot_samples_before_report: field_f64(&options, "hotSamplesBeforeReport"),
            report_cooldown_ms: field_f64(&options, "reportCooldownMs"),
            profile_ms: field_f64(&options, "profileMs"),
        },
        field_f64(&spec, "totalMem").unwrap_or(f64::NAN),
    );
    log_line(&log, vec![text("setInterval"), num(dog.sample_ms())]);
    log_line(&log, vec![text("unref")]);
    let mut pending: Vec<ReportRun<DogWc>> = Vec::new();
    for step in list(spec.get("steps")) {
        if let Some(clock) = field_f64(step, "clock") {
            host.clock.set(clock);
        }
        if let Some(metrics) = step.get("metrics") {
            *host.metrics.borrow_mut() = metrics.clone();
            for report in dog.sample(&host) {
                // a report that cannot name its document is rejected: not reached by the cases
                let Ok((mut run, first)) = dog.start_report(&host, report) else {
                    continue;
                };
                if drive_report(&dog, &host, &log, &mut run, first) {
                    pending.push(run);
                }
            }
        }
        if let Some(answer) = step.get("answer")
            && !pending.is_empty()
        {
            let mut run = pending.remove(0);
            let response = match answer.as_f64() {
                Some(response) => Ok(response),
                None => Err(Failure("dialog failed".to_owned())),
            };
            let next = run.resume(&dog, &host, ReportAnswer::Dialog(response));
            if drive_report(&dog, &host, &log, &mut run, next) {
                pending.push(run);
            }
        }
    }
    cx.logs.extend(take_logs(&log));
    Ok(None)
}

// ---------------------------------------------------------------------------
// recovery-shell
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct RecWc {
    name: String,
    id: i64,
    destroyed: bool,
}

impl RecoveryContents for RecWc {
    fn id(&self) -> i64 {
        self.id
    }
    fn is_destroyed(&self) -> bool {
        self.destroyed
    }
}

fn identity_of(v: &Value) -> RecoveryIdentity {
    let kind = field_str(v, "kind").unwrap_or_default().to_owned();
    match field_str(v, "untitledId") {
        Some(untitled_id) => RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
            kind,
            untitled_id: untitled_id.to_owned(),
            ext: field_str(v, "ext").unwrap_or_default().to_owned(),
        }),
        None => RecoveryIdentity::File(RecoveryFileIdentity {
            kind,
            file_path: field_str(v, "filePath").unwrap_or_default().to_owned(),
        }),
    }
}

fn untitled_of(v: &Value) -> RecoveryUntitledIdentity {
    match identity_of(v) {
        RecoveryIdentity::Untitled(u) => u,
        RecoveryIdentity::File(f) => RecoveryUntitledIdentity {
            kind: f.kind,
            untitled_id: String::new(),
            ext: String::new(),
        },
    }
}

/// an identity as the TypeScript's literal writes it
fn identity_json(identity: &RecoveryIdentity) -> Value {
    let mut o = Map::new();
    match identity {
        RecoveryIdentity::File(f) => {
            o.insert("kind".to_owned(), text(&f.kind));
            o.insert("filePath".to_owned(), text(&f.file_path));
        }
        RecoveryIdentity::Untitled(u) => {
            o.insert("kind".to_owned(), text(&u.kind));
            o.insert("untitledId".to_owned(), text(&u.untitled_id));
            o.insert("ext".to_owned(), text(&u.ext));
        }
    }
    Value::Object(o)
}

fn planned_of(v: &Value) -> PlannedTab {
    let open = v.get("open").cloned().unwrap_or(Value::Null);
    PlannedTab {
        key: field_str(v, "key").unwrap_or_default().to_owned(),
        kind: field_str(v, "kind").unwrap_or_default().to_owned(),
        title: field_str(v, "title").unwrap_or_default().to_owned(),
        file_path: field_str(v, "filePath").map(str::to_owned),
        open: if field_str(&open, "type") == Some("untitledCopy") {
            PlannedOpen::UntitledCopy {
                copy: identity_of(open.get("copy").unwrap_or(&Value::Null)),
                save_as_default_path: field_str(&open, "saveAsDefaultPath").map(str::to_owned),
            }
        } else {
            PlannedOpen::File
        },
    }
}

struct RecEditors {
    spec: Value,
    log: Log,
    wcs: Vec<RecWc>,
    views: Cell<i64>,
    /// what `setImmediate` leaves for the end of a step
    deferred: RefCell<Vec<Vec<Value>>>,
}

impl RecEditors {
    fn name_of_id(&self, id: i64) -> String {
        self.wcs
            .iter()
            .find(|w| w.id == id)
            .map_or_else(|| format!("#{id}"), |w| w.name.clone())
    }

    fn identity(&self, editor: &str, who: String) -> Result<Option<RecoveryIdentity>, Failure> {
        log_line(
            &self.log,
            vec![text(&format!("{editor}RecoveryIdentity")), text(&who)],
        );
        match self.spec.get("identities").and_then(|i| i.get(editor)) {
            Some(Value::String(s)) if s == "throws" => {
                Err(Failure(format!("{editor} identity failed")))
            }
            Some(v) if v.is_object() => Ok(Some(identity_of(v))),
            _ => Ok(None),
        }
    }

    fn view(&self) -> i64 {
        self.views.set(self.views.get() + 1);
        900 + self.views.get()
    }

    fn discard(&self, label: &str, contents: &RecWc) {
        log_line(&self.log, vec![text(label), text(&contents.name)]);
    }
}

impl RecoveryEditors for RecEditors {
    type Contents = RecWc;
    type View = i64;

    fn docs_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure> {
        self.identity("docs", self.name_of_id(id))
    }
    fn sheets_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure> {
        self.identity("sheets", self.name_of_id(id))
    }
    fn pdf_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure> {
        self.identity("pdf", self.name_of_id(id))
    }
    fn markdown_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure> {
        self.identity("markdown", self.name_of_id(id))
    }
    fn html_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure> {
        self.identity("html", self.name_of_id(id))
    }
    fn mindmap_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure> {
        self.identity("mindmap", self.name_of_id(id))
    }
    fn hwp_recovery_identity(&self, contents: &RecWc) -> Result<Option<RecoveryIdentity>, Failure> {
        self.identity("hwp", contents.name.clone())
    }
    fn slides_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure> {
        self.identity("slides", self.name_of_id(id))
    }
    fn diagram_recovery_identity(&self, id: i64) -> Result<Option<RecoveryIdentity>, Failure> {
        self.identity("diagram", self.name_of_id(id))
    }

    fn discard_docs_recovery(&self, contents: &RecWc) {
        self.discard("discardDocsRecovery", contents);
    }
    fn discard_sheets_recovery(&self, contents: &RecWc) {
        self.discard("discardSheetsRecovery", contents);
    }
    fn discard_pdf_recovery(&self, contents: &RecWc) {
        self.discard("discardPdfRecovery", contents);
    }
    fn discard_mindmap_recovery(&self, contents: &RecWc) {
        self.discard("discardMindmapRecovery", contents);
    }
    fn hwp_discard_recovery_copy(&self, contents: &RecWc) {
        self.discard("hwpDiscardRecoveryCopy", contents);
    }
    fn discard_diagram_recovery(&self, contents: &RecWc) {
        self.discard("discardDiagramRecovery", contents);
    }

    fn create_pdf_view(&self) -> Result<i64, Failure> {
        log_line(&self.log, vec![text("createPdfView")]);
        Ok(self.view())
    }
    fn create_sheets_view(
        &self,
        include_ai_handlers: bool,
        opening_workbook: bool,
    ) -> Result<i64, Failure> {
        let mut options = Map::new();
        options.insert(
            "includeAiHandlers".to_owned(),
            Value::Bool(include_ai_handlers),
        );
        options.insert("openingWorkbook".to_owned(), Value::Bool(opening_workbook));
        log_line(
            &self.log,
            vec![text("createSheetsView"), Value::Object(options)],
        );
        Ok(self.view())
    }
    fn create_plain_editor_view(
        &self,
        kind: &str,
        file_path: Option<&str>,
    ) -> Result<i64, Failure> {
        log_line(
            &self.log,
            vec![
                text("createPlainEditorView"),
                text(kind),
                file_path.map_or(Value::Null, text),
            ],
        );
        Ok(self.view())
    }

    fn has_recovery_editor(&self, kind: &str) -> bool {
        list(self.spec.get("contracts"))
            .iter()
            .any(|k| k.as_str() == Some(kind))
    }
    fn open_untitled_copy(
        &self,
        kind: &str,
        view: &i64,
        request: &RecoveryOpenUntitledRequest,
    ) -> Result<(), Failure> {
        let mut shown = Map::new();
        shown.insert("copy".to_owned(), identity_json(&request.copy));
        shown.insert("title".to_owned(), text(&request.title));
        if let Some(path) = &request.save_as_default_path {
            shown.insert("saveAsDefaultPath".to_owned(), text(path));
        }
        log_line(
            &self.log,
            vec![
                text("openUntitledCopy"),
                text(kind),
                Value::from(*view),
                Value::Object(shown),
            ],
        );
        match field_str(&self.spec, "contractOpens") {
            Some("throws") => Err(Failure("open threw".to_owned())),
            Some("rejects") => Err(Failure("open rejected".to_owned())),
            _ => Ok(()),
        }
    }

    fn warn(&self, prefix: &str, detail: &str) {
        log_line(&self.log, vec![text("warn"), text(prefix), text(detail)]);
    }
    fn migrate_sheets_legacy_recovery(&self) {
        log_line(&self.log, vec![text("migrateSheetsLegacyRecovery")]);
    }
    fn after_sheets_open_soon(&self) {
        self.deferred
            .borrow_mut()
            .push(vec![text("afterSheetsOpen")]);
    }
    fn set_recovery_title_source(&self, editor: &str) {
        let name = match editor {
            "markdown" => "setMarkdownRecoveryTitleSource",
            "html" => "setHtmlRecoveryTitleSource",
            "mindmap" => "setMindmapRecoveryTitleHook",
            _ => "setDiagramRecoveryTitleHook",
        };
        log_line(&self.log, vec![text(name), text("function")]);
    }
    fn set_hwp_recovery_title(&self, contents: &RecWc, title: &str) {
        log_line(
            &self.log,
            vec![
                text("setHwpRecoveryTitle"),
                text(&contents.name),
                text(title),
            ],
        );
    }
}

fn tab_summary(spec: &UnloadedTabSpec) -> Value {
    let mut o = Map::new();
    o.insert("kind".to_owned(), text(&spec.kind));
    o.insert("title".to_owned(), text(&spec.title));
    if let Some(path) = &spec.file_path {
        o.insert("filePath".to_owned(), text(path));
    }
    Value::Object(o)
}

struct RecManager {
    log: Log,
    throws: Vec<String>,
    strip: Vec<ListedTab>,
    specs: HashMap<String, UnloadedTabSpec>,
    next_tab: usize,
    split: bool,
    /// the spec's strip: which webContents a tab shows
    contents: Vec<(String, RecWc)>,
}

impl RecManager {
    fn throw_if(&self, method: &str) -> Result<(), Failure> {
        if self.throws.iter().any(|m| m == method) {
            Err(Failure(format!("{method} failed")))
        } else {
            Ok(())
        }
    }

    fn next_id(&mut self) -> String {
        self.next_tab += 1;
        format!("t{}", self.next_tab)
    }

    fn adopt(&mut self, spec: UnloadedTabSpec) -> String {
        let id = self.next_id();
        self.strip.push(ListedTab {
            id: id.clone(),
            kind: spec.kind.clone(),
            title: spec.title.clone(),
            file_path: spec.file_path.clone(),
        });
        self.specs.insert(id.clone(), spec);
        id
    }
}

impl LaunchManager for RecManager {
    type Contents = RecWc;

    fn add_unloaded_tab(&mut self, spec: UnloadedTabSpec) -> Result<String, Failure> {
        self.throw_if("addUnloadedTab")?;
        log_line(&self.log, vec![text("addUnloadedTab"), tab_summary(&spec)]);
        Ok(self.adopt(spec))
    }
    fn activate_tab(&mut self, id: &str) -> Result<(), Failure> {
        self.throw_if("activateTab")?;
        log_line(&self.log, vec![text("activateTab"), text(id)]);
        Ok(())
    }
    fn hydrate_session(&mut self, tabs: Vec<UnloadedTabSpec>) -> Result<Vec<String>, Failure> {
        self.throw_if("hydrateSession")?;
        log_line(
            &self.log,
            vec![
                text("hydrateSession"),
                Value::Array(tabs.iter().map(tab_summary).collect()),
            ],
        );
        Ok(tabs.into_iter().map(|spec| self.adopt(spec)).collect())
    }
    fn close_tab_without_prompt(&mut self, id: &str) -> Result<(), Failure> {
        self.throw_if("closeTabWithoutPrompt")?;
        log_line(&self.log, vec![text("closeTabWithoutPrompt"), text(id)]);
        if let Some(at) = self.strip.iter().position(|t| t.id == id) {
            self.strip.remove(at);
        }
        Ok(())
    }
    fn list(&self) -> Vec<ListedTab> {
        self.strip.clone()
    }
    fn reorder_tab(&mut self, id: &str, slot: usize) -> Result<(), Failure> {
        self.throw_if("reorderTab")?;
        log_line(
            &self.log,
            vec![text("reorderTab"), text(id), Value::from(slot)],
        );
        if let Some(at) = self.strip.iter().position(|t| t.id == id) {
            let tab = self.strip.remove(at);
            self.strip.insert(slot.min(self.strip.len()), tab);
        }
        Ok(())
    }
    fn begin_split(
        &mut self,
        a: &str,
        b: &str,
        orientation: &str,
        ratio: f64,
        focus: &str,
    ) -> Result<(), Failure> {
        self.throw_if("beginSplit")?;
        log_line(
            &self.log,
            vec![
                text("beginSplit"),
                text(a),
                text(b),
                text(orientation),
                num(ratio),
                text(focus),
            ],
        );
        self.split = true;
        Ok(())
    }
    fn split_state(&self) -> bool {
        self.split
    }
    fn open_home_tab(&mut self) -> Result<(), Failure> {
        self.throw_if("openHomeTab")?;
        log_line(&self.log, vec![text("openHomeTab")]);
        Ok(())
    }
    fn web_contents_for_tab(&self, id: &str) -> Option<RecWc> {
        self.contents
            .iter()
            .find(|(tab, _)| tab == id)
            .map(|(_, wc)| wc.clone())
    }
}

struct RecDeps {
    spec: Value,
    log: Log,
    manager: RecManager,
    throws: Vec<String>,
}

impl RecDeps {
    fn throw_if(&self, method: &str) -> Result<(), Failure> {
        if self.throws.iter().any(|m| m == method) {
            Err(Failure(format!("{method} failed")))
        } else {
            Ok(())
        }
    }
}

impl RestoredTabOpenerDeps for RecDeps {
    fn blocked(&self) -> bool {
        self.gate_blocking()
    }
}

impl LaunchDeps for RecDeps {
    type Manager = RecManager;

    fn gate_blocking(&self) -> bool {
        log_line(&self.log, vec![text("gate.blocking")]);
        field_bool(&self.spec, "blocked")
    }
    fn gate_publish_none(&mut self) {
        log_line(&self.log, vec![text("gate.publishNone")]);
    }
    fn gate_publish(&mut self, items: &[RecoveryListItem]) {
        log_line(
            &self.log,
            vec![
                text("gate.publish"),
                Value::Array(items.iter().map(super::b3_shell::list_item_value).collect()),
            ],
        );
    }
    fn manager(&mut self) -> &mut RecManager {
        &mut self.manager
    }
    fn user_data_dir(&self) -> String {
        field_str(&self.spec, "userData")
            .unwrap_or_default()
            .to_owned()
    }
    fn launch_paths(&self) -> Vec<String> {
        list(self.spec.get("launchPaths"))
            .iter()
            .filter_map(|p| p.as_str().map(str::to_owned))
            .collect()
    }
    fn open_launch_paths(&mut self, paths: &[String]) -> Result<(), Failure> {
        log_line(
            &self.log,
            vec![
                text("openLaunchPaths"),
                Value::Array(paths.iter().map(|p| text(p)).collect()),
            ],
        );
        self.throw_if("openLaunchPaths")
    }
    fn restore_split_memory_or_home(&mut self) -> Result<(), Failure> {
        log_line(&self.log, vec![text("restoreSplitMemoryOrHome")]);
        self.throw_if("restoreSplitMemoryOrHome")
    }
    fn settled(&mut self) -> Result<(), Failure> {
        log_line(&self.log, vec![text("settled")]);
        self.throw_if("settled")
    }
    fn session_changed(&mut self) -> Result<(), Failure> {
        log_line(&self.log, vec![text("sessionChanged")]);
        self.throw_if("sessionChanged")
    }
    fn reopened_by_installer(&self) -> bool {
        field_bool(&self.spec, "reopenedByInstaller")
    }
}

struct SessionEnv {
    now: f64,
    log: Log,
}

impl SessionRecorderEnv for SessionEnv {
    fn now(&mut self) -> f64 {
        self.now
    }
    fn write_json(&mut self, file_path: &str, record: &SessionRecord) -> Result<(), String> {
        write_record_atomic(file_path, record).map_err(|e| e.message)
    }
    fn warn(&mut self, label: &str, error: &str) {
        log_line(&self.log, vec![text("warn"), text(label), text(error)]);
    }
}

fn error_entry(message: String) -> Value {
    let mut o = Map::new();
    o.insert("error".to_owned(), Value::from(message));
    Value::Object(o)
}

fn opened(result: Result<i64, Failure>) -> Value {
    let mut o = Map::new();
    match result {
        Ok(id) => o.insert("opened".to_owned(), Value::from(id)),
        Err(Failure(message)) => o.insert("threw".to_owned(), Value::from(message)),
    };
    Value::Object(o)
}

fn needs_user(answer: bool) -> Value {
    let mut o = Map::new();
    o.insert("needsUser".to_owned(), Value::Bool(answer));
    Value::Object(o)
}

/// the launch list's answer as the gate hands it to `apply`
fn list_result_of(answer: &Value) -> RecoveryListResult {
    if answer.get("dismissed").is_some() {
        return RecoveryListResult::Dismissed;
    }
    let mut decisions: JsObject<RecoveryChoice> = JsObject::new();
    for (id, choice) in entries(answer.get("decisions")) {
        decisions.set(
            id.clone(),
            if choice.as_str() == Some("restore") {
                RecoveryChoice::Restore
            } else {
                RecoveryChoice::Discard
            },
        );
    }
    RecoveryListResult::Decisions(decisions)
}

fn recovery_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let wcs: Vec<RecWc> = entries(spec.get("contents"))
        .into_iter()
        .map(|(name, c)| RecWc {
            name: name.clone(),
            id: field_f64(c, "id").unwrap_or(0.0) as i64,
            destroyed: field_bool(c, "destroyed"),
        })
        .collect();
    let contents_of = |name: Option<&str>| name.and_then(|n| wcs.iter().find(|w| w.name == n));
    let editors = RecEditors {
        spec: spec.clone(),
        log: Rc::clone(&log),
        wcs: wcs.clone(),
        views: Cell::new(0),
        deferred: RefCell::new(Vec::new()),
    };
    let strip_spec = list(spec.get("strip"));
    let mut manager = RecManager {
        log: Rc::clone(&log),
        throws: list(spec.get("managerThrows"))
            .iter()
            .filter_map(|m| m.as_str().map(str::to_owned))
            .collect(),
        strip: Vec::new(),
        specs: HashMap::new(),
        next_tab: 0,
        split: false,
        contents: Vec::new(),
    };
    for tab in strip_spec {
        let id = field_str(tab, "id").unwrap_or_default().to_owned();
        manager.strip.push(ListedTab {
            id: id.clone(),
            kind: field_str(tab, "kind").unwrap_or_default().to_owned(),
            title: field_str(tab, "title").unwrap_or_default().to_owned(),
            file_path: field_str(tab, "filePath")
                .filter(|p| !p.is_empty())
                .map(str::to_owned),
        });
        if let Some(wc) = contents_of(field_str(tab, "contents")) {
            manager.contents.push((id, wc.clone()));
        }
    }
    let mut deps = RecDeps {
        spec: spec.clone(),
        log: Rc::clone(&log),
        manager,
        throws: list(spec.get("depsThrow"))
            .iter()
            .filter_map(|m| m.as_str().map(str::to_owned))
            .collect(),
    };
    let dir = field_str(&spec, "userData").unwrap_or_default().to_owned();
    let now = cx.now_ms;
    let shared = SharedRecoveryState::new("run");
    let user_data_dir = || dir.clone();
    let now_ms = || now;
    let random_uuid = || "00000000-0000-4000-8000-000000000000".to_owned();
    let store = create_recovery_store(
        RecoveryStoreOptions {
            user_data_dir: &user_data_dir,
            now_ms: &now_ms,
            random_uuid: &random_uuid,
        },
        &shared,
    );
    let mut shell = RecoveryShell::new();
    let mut session = SessionRecordProcess::new();
    let mut session_env = SessionEnv {
        now,
        log: Rc::clone(&log),
    };
    let mut pending: Option<PendingLaunchList> = None;
    let mut results: Vec<Value> = Vec::new();
    for step in list(spec.get("steps")) {
        if let Some(s) = step.get("identity") {
            let found = contents_of(field_str(s, "contents")).and_then(|c| {
                editor_recovery_identity(&editors, field_str(s, "kind").unwrap_or_default(), c)
            });
            results.push(found.as_ref().map_or(Value::Null, identity_json));
        } else if let Some(s) = step.get("tabCopy") {
            let tab = s.get("tab").cloned().unwrap_or(Value::Null);
            let copy = shell.tab_untitled_copy(
                &editors,
                field_str(&tab, "id").unwrap_or_default(),
                field_str(&tab, "filePath"),
                field_str(s, "kind").unwrap_or_default(),
                contents_of(field_str(s, "contents")),
            );
            results.push(copy.map_or(Value::Null, |c| {
                let mut o = Map::new();
                o.insert("untitledId".to_owned(), text(&c.untitled_id));
                o.insert("ext".to_owned(), text(&c.ext));
                Value::Object(o)
            }));
        } else if let Some(s) = step.get("crashedCopy") {
            let tab = s.get("tab").cloned().unwrap_or(Value::Null);
            let Some(contents) = contents_of(field_str(s, "contents")) else {
                results.push(Value::Null);
                continue;
            };
            results.push(
                match shell.crashed_untitled_copy(
                    &store,
                    &editors,
                    field_str(&tab, "id"),
                    field_str(&tab, "kind").unwrap_or_default(),
                    field_str(&tab, "filePath"),
                    contents,
                ) {
                    Ok(Some(identity)) => identity_json(&RecoveryIdentity::Untitled(identity)),
                    Ok(None) => Value::Null,
                    Err(e) => error_entry(e.message),
                },
            );
        } else if let Some(s) = step.get("opener") {
            let planned = planned_of(s.get("planned").unwrap_or(&Value::Null));
            let opener: RestoredTabOpener = restored_tab_opener(&planned);
            let context = OpenContext {
                kind: field_str(s, "kind").unwrap_or_default().to_owned(),
                title: field_str(s, "title").unwrap_or_default().to_owned(),
                file_path: field_str(s, "filePath")
                    .filter(|p| !p.is_empty())
                    .map(str::to_owned),
            };
            results.push(if field_str(s, "call") == Some("open") {
                opened(opener.open(&editors, &deps, &context))
            } else {
                needs_user(opener.needs_user(&store, &deps, &context))
            });
        } else if let Some(s) = step.get("reopen") {
            let copy = untitled_of(s.get("copy").unwrap_or(&Value::Null));
            results.push(
                match shell.reopen_untitled_copy(
                    &mut deps.manager,
                    field_str(s, "kind").unwrap_or_default(),
                    field_str(s, "title").unwrap_or_default(),
                    &copy,
                ) {
                    Ok(()) => Value::Null,
                    Err(Failure(message)) => error_entry(message),
                },
            );
        } else if let Some(s) = step.get("discard") {
            if let Some(contents) = contents_of(field_str(s, "contents")) {
                discard_editor_recovery(
                    &editors,
                    field_str(s, "kind").unwrap_or_default(),
                    contents,
                );
            }
            results.push(Value::Null);
        } else if step.get("titles").is_some() {
            install_recovery_title_sources(&editors);
            results.push(Value::Null);
        } else if step.get("pushHwp").is_some() {
            push_hwp_recovery_titles(&editors, &deps.manager);
            results.push(Value::Null);
        } else if step.get("launch").is_some() {
            match run_launch_recovery(
                &mut shell,
                &editors,
                &store,
                &mut session,
                &mut session_env,
                &mut deps,
            ) {
                Ok(waiting) => {
                    pending = waiting;
                    results.push(Value::Null);
                }
                Err(Failure(message)) => results.push(error_entry(message)),
            }
        } else if let Some(answer) = step.get("answer") {
            if let Some(waiting) = pending.take() {
                waiting.answer(
                    &mut shell,
                    &editors,
                    &store,
                    &mut deps,
                    &list_result_of(answer),
                );
            }
            results.push(Value::Null);
        } else if let Some(id) = field_str(step, "openTab") {
            if let Some(tab) = deps.manager.specs.get(id).cloned() {
                let context = OpenContext {
                    kind: tab.kind.clone(),
                    title: tab.title.clone(),
                    file_path: tab.file_path.clone(),
                };
                results.push(opened(tab.opener.open(&editors, &deps, &context)));
            }
        } else if let Some(id) = field_str(step, "needsUserTab")
            && let Some(tab) = deps.manager.specs.get(id).cloned()
        {
            let context = OpenContext {
                kind: tab.kind.clone(),
                title: tab.title.clone(),
                file_path: tab.file_path.clone(),
            };
            results.push(needs_user(tab.opener.needs_user(&store, &deps, &context)));
        }
        // what `setImmediate` left runs before the next step
        let deferred: Vec<Vec<Value>> = editors.deferred.borrow_mut().drain(..).collect();
        for line in deferred {
            log_line(&log, line);
        }
    }
    cx.logs.extend(take_logs(&log));
    Ok(Some(Value::Array(results)))
}

// ---------------------------------------------------------------------------
// updater
// ---------------------------------------------------------------------------

struct UpEnv {
    log: Log,
    now: f64,
    perf: Cell<f64>,
}

impl UpdaterEnv for UpEnv {
    fn console_log(&self, args: &[String]) {
        let mut line = vec![text("console.log")];
        line.extend(args.iter().map(|a| text(a)));
        log_line(&self.log, line);
    }
    fn now_ms(&self) -> f64 {
        self.now
    }
    fn perf_now(&self) -> f64 {
        let next = self.perf.get() + 10.0;
        self.perf.set(next);
        next
    }
}

struct TimerSlot {
    timer: Timer,
    cleared: bool,
}

struct UpHost {
    spec: Value,
    log: Log,
    windows_open: bool,
    /// a window has been shown: only then do the window's actions exist
    window_shown: bool,
    timers: Vec<TimerSlot>,
    immediates: usize,
    dialogs: Vec<f64>,
    check_at: usize,
    download_at: usize,
    resume_wrapped: bool,
}

impl UpHost {
    fn updater_spec(&self) -> Value {
        self.spec.get("updater").cloned().unwrap_or(Value::Null)
    }
}

fn updater_event(spec: &Value) -> UpdaterEvent {
    match field_str(spec, "type").unwrap_or_default() {
        "update-available" => UpdaterEvent::UpdateAvailable {
            version: field_str(spec, "version").unwrap_or_default().to_owned(),
            release_notes: spec.get("notes").cloned().unwrap_or(Value::Null),
        },
        "download-progress" => UpdaterEvent::DownloadProgress {
            transferred: field_f64(spec, "transferred").unwrap_or(f64::NAN),
            percent: field_f64(spec, "percent").unwrap_or(f64::NAN),
        },
        "error" => UpdaterEvent::Error(field_str(spec, "message").unwrap_or_default().to_owned()),
        _ => UpdaterEvent::UpdateDownloaded {
            version: field_str(spec, "version").unwrap_or_default().to_owned(),
            downloaded_file: field_str(spec, "file").map(str::to_owned),
        },
    }
}

impl UpdaterHost for UpHost {
    fn platform(&self) -> String {
        field_str(&self.spec, "platform")
            .unwrap_or_default()
            .to_owned()
    }
    fn env(&self, name: &str) -> Option<String> {
        self.spec
            .get("env")
            .and_then(|env| field_str(env, name))
            .map(str::to_owned)
    }
    fn is_packaged(&self) -> bool {
        field_bool(&self.spec, "packaged")
    }
    fn version(&self) -> String {
        field_str(&self.spec, "version")
            .unwrap_or_default()
            .to_owned()
    }
    fn user_data_dir(&self) -> String {
        field_str(&self.spec, "userData")
            .unwrap_or_default()
            .to_owned()
    }
    fn exec_path(&self) -> String {
        field_str(&self.spec, "execPath")
            .unwrap_or_default()
            .to_owned()
    }
    fn pid(&self) -> f64 {
        f64::from(std::process::id())
    }
    fn uptime_seconds(&self) -> f64 {
        field_f64(&self.spec, "uptime").unwrap_or(f64::NAN)
    }
    fn reopened_by_installer(&self) -> bool {
        let argv: Vec<&str> = list(self.spec.get("argv"))
            .iter()
            .filter_map(Value::as_str)
            .collect();
        reopened_by_installer(&argv)
    }
    fn ui_lang(&self) -> Lang {
        if field_str(&self.spec, "lang") == Some("ko") {
            Lang::Ko
        } else {
            Lang::En
        }
    }
    fn auto_check_enabled(&self) -> bool {
        field_bool(&self.spec, "autoCheck")
    }
    fn quit_soon(&mut self) {
        log_line(&self.log, vec![text("setImmediate")]);
        self.immediates += 1;
    }

    fn show_message_box(&mut self, options: &MessageBoxOptions) -> f64 {
        log_line(&self.log, vec![text("box"), to_value(options)]);
        if self.dialogs.is_empty() {
            0.0
        } else {
            self.dialogs.remove(0)
        }
    }
    fn open_external(&mut self, url: &str) {
        log_line(&self.log, vec![text("openExternal"), text(url)]);
    }

    fn set_update_parent_window(&mut self) {
        log_line(&self.log, vec![text("setUpdateParentWindow")]);
    }
    fn show_update_window(&mut self, state: &UpdateUiState, inactive: bool) {
        let options = if inactive {
            let mut o = Map::new();
            o.insert("inactive".to_owned(), Value::Bool(true));
            Value::Object(o)
        } else {
            Value::Null
        };
        log_line(
            &self.log,
            vec![text("showUpdateWindow"), to_value(state), options],
        );
        self.windows_open = true;
        self.window_shown = true;
    }
    fn is_update_window_open(&self) -> bool {
        self.windows_open
    }
    fn push_update_state(&mut self, patch: &UpdateStatePatch) {
        log_line(&self.log, vec![text("pushUpdateState"), to_value(patch)]);
    }
    fn close_update_window(&mut self) {
        log_line(&self.log, vec![text("closeUpdateWindow")]);
        self.windows_open = false;
    }

    fn set_timeout(&mut self, timer: Timer, ms: f64) {
        log_line(&self.log, vec![text("setTimeout"), num(ms)]);
        self.timers.push(TimerSlot {
            timer,
            cleared: false,
        });
    }
    fn set_interval(&mut self, timer: Timer, ms: f64) -> u32 {
        log_line(&self.log, vec![text("setInterval"), num(ms)]);
        self.timers.push(TimerSlot {
            timer,
            cleared: false,
        });
        self.timers.len() as u32
    }
    fn clear_interval(&mut self, id: u32) {
        log_line(&self.log, vec![text("clearInterval"), Value::from(id)]);
        if let Some(slot) = self.timers.get_mut(id as usize - 1) {
            slot.cleared = true;
        }
    }

    fn configure(&mut self, setting: UpdaterSetting) {
        let (name, value) = match setting {
            UpdaterSetting::Logger => ("logger", text("<logger>")),
            UpdaterSetting::Channel(channel) => ("channel", text(channel)),
            UpdaterSetting::AllowDowngrade(on) => ("allowDowngrade", Value::Bool(on)),
            UpdaterSetting::AllowPrerelease(on) => ("allowPrerelease", Value::Bool(on)),
            UpdaterSetting::AutoDownload(on) => ("autoDownload", Value::Bool(on)),
            UpdaterSetting::FullChangelog(on) => ("fullChangelog", Value::Bool(on)),
            UpdaterSetting::AutoInstallOnAppQuit(on) => ("autoInstallOnAppQuit", Value::Bool(on)),
            UpdaterSetting::DisableDifferentialDownload(on) => {
                ("disableDifferentialDownload", Value::Bool(on))
            }
        };
        log_line(&self.log, vec![text("autoUpdater.set"), text(name), value]);
    }
    fn install_resume_download(&mut self) {
        let has_download = field_bool(&self.updater_spec(), "httpDownload");
        self.resume_wrapped = install_resume_download(has_download);
    }
    fn has_mac_staging_methods(&self) -> (bool, bool) {
        let both = field_bool(&self.updater_spec(), "macMethods");
        (both, both)
    }
    fn check_for_updates(&mut self) -> CheckReturn {
        log_line(&self.log, vec![text("autoUpdater.checkForUpdates")]);
        let checks = self
            .updater_spec()
            .get("checks")
            .cloned()
            .unwrap_or(Value::Null);
        let scripts = list(Some(&checks));
        let script = &scripts[self.check_at.min(scripts.len() - 1)];
        self.check_at += 1;
        let events = list(script.get("events"))
            .iter()
            .map(updater_event)
            .collect();
        let result = match script.get("result") {
            Some(Value::String(s)) if s == "none" => Ok(Some(CheckResult {
                is_update_available: false,
                update_version: Some("0.0.0".to_owned()),
            })),
            Some(Value::String(s)) if s == "null" => Ok(None),
            Some(result) if result.get("throws").is_some() => {
                let thrown = result.get("throws").cloned().unwrap_or(Value::Null);
                Err(UpdateError {
                    code: field_str(&thrown, "code").map(str::to_owned),
                    message: field_str(&thrown, "message").unwrap_or_default().to_owned(),
                })
            }
            Some(result) => Ok(Some(CheckResult {
                is_update_available: field_bool(result, "available"),
                update_version: field_str(result, "version").map(str::to_owned),
            })),
            None => Ok(None),
        };
        CheckReturn { events, result }
    }
    fn download_update(&mut self) -> DownloadReturn {
        log_line(&self.log, vec![text("autoUpdater.downloadUpdate")]);
        let downloads = self
            .updater_spec()
            .get("downloads")
            .cloned()
            .unwrap_or(Value::Null);
        let scripts = list(Some(&downloads));
        let script = scripts
            .get(self.download_at.min(scripts.len().saturating_sub(1)))
            .cloned()
            .unwrap_or(Value::Null);
        self.download_at += 1;
        DownloadReturn {
            events: list(script.get("events"))
                .iter()
                .map(updater_event)
                .collect(),
            rejection: field_str(&script, "rejects")
                .filter(|m| !m.is_empty())
                .map(|message| UpdateError {
                    code: None,
                    message: message.to_owned(),
                }),
        }
    }
    fn install(&mut self, silent: bool, force_run_after: bool) -> Option<bool> {
        let mode = field_str(&self.updater_spec(), "install").map(str::to_owned);
        if mode.as_deref() == Some("none") {
            return None;
        }
        log_line(
            &self.log,
            vec![
                text("autoUpdater.install"),
                Value::Bool(silent),
                Value::Bool(force_run_after),
            ],
        );
        Some(mode.as_deref() == Some("true"))
    }
    fn download_cache_dir(&mut self) -> Result<Option<String>, String> {
        let dir = field_str(&self.updater_spec(), "cacheDir")
            .unwrap_or("none")
            .to_owned();
        if dir == "none" {
            return Ok(None);
        }
        log_line(
            &self.log,
            vec![text("autoUpdater.getOrCreateDownloadHelper")],
        );
        match dir.as_str() {
            "throws" => Err("no helper".to_owned()),
            "nodir" => Ok(None),
            _ => Ok(Some(dir)),
        }
    }

    fn run_program(&mut self, file: &str, args: &[String]) -> Result<String, String> {
        crate::shell::mac_update::run_program(file, args)
    }
    fn spawn_program(
        &mut self,
        _file: &str,
        _args: &[String],
        _options: &SpawnOptions,
    ) -> Result<Box<dyn SwapChild>, String> {
        Err("the swap is not started by the cases".to_owned())
    }
}

fn updater_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let env = Rc::new(UpEnv {
        log: Rc::clone(&log),
        now: cx.now_ms,
        perf: Cell::new(0.0),
    });
    let mut host = UpHost {
        spec: spec.clone(),
        log: Rc::clone(&log),
        windows_open: false,
        window_shown: false,
        timers: Vec::new(),
        immediates: 0,
        dialogs: list(spec.get("dialogs"))
            .iter()
            .filter_map(Value::as_f64)
            .collect(),
        check_at: 0,
        download_at: 0,
        resume_wrapped: false,
    };
    let channel = if field_str(&spec, "channel") == Some("stable") {
        BuildUpdateChannel::Stable
    } else {
        BuildUpdateChannel::Latest
    };
    let mut updater = Updater::new(env);
    for step in list(spec.get("steps")) {
        if step.get("init").is_some() {
            updater.init_auto_updater(&mut host, channel);
        } else if step.get("manual").is_some() {
            updater.check_for_updates_now(&mut host);
        } else if let Some(event) = step.get("event") {
            updater.on_event(&mut host, updater_event(event));
        } else if let Some(action) = field_str(step, "action") {
            if !host.window_shown {
                continue;
            }
            updater.on_action(
                &mut host,
                match action {
                    "download" => UpdateAction::Download,
                    "install" => UpdateAction::Install,
                    "later" => UpdateAction::Later,
                    _ => UpdateAction::OpenDownload,
                },
            );
        } else if let Some(n) = field_f64(step, "timer") {
            let id = n as usize;
            let slot = host
                .timers
                .get(id.wrapping_sub(1))
                .filter(|slot| !slot.cleared)
                .map(|slot| slot.timer);
            match slot {
                Some(Timer::Check) => updater.check(&mut host),
                Some(Timer::ClearCache(tries)) => updater.clear_installed_cache(&mut host, tries),
                Some(Timer::FakeShow) => updater.fake_show_again(&mut host),
                Some(Timer::FakeProgress) => updater.fake_progress(&mut host, id as u32),
                None => {}
            }
        } else if let Some(n) = field_f64(step, "immediate") {
            if (n as usize) >= 1 && (n as usize) <= host.immediates {
                log_line(&log, vec![text("app.quit")]);
            }
        } else if step.get("willQuit").is_some() {
            updater.on_will_quit(&mut host);
        }
    }
    let mut answer = Map::new();
    answer.insert(
        "restartRequested".to_owned(),
        Value::Bool(updater.restart().update_restart_requested()),
    );
    answer.insert("resumeWrapped".to_owned(), Value::Bool(host.resume_wrapped));
    cx.logs.extend(take_logs(&log));
    Ok(Some(Value::Object(answer)))
}
