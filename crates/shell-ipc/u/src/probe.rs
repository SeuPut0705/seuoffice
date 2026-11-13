//! Fakes of U's hosts for `crates/ipc-probe`, and the state a case starts
//! from (`tools/ipc-diff/groups/u`). The case's `hosts.u`:
//!
//! - `windowId`: the id the fake gives a new update window (default 900);
//! - `update`: a list of `{ state, inactive }`, each shown as the updater
//!   shows it (`showUpdateWindow`) before the first call; `state` is an
//!   `UpdateUiState` whose `releaseNotes` is what electron-updater reports
//!   (normalized here, as the updater does);
//! - `launchList`: `null` publishes nothing to ask; `{ items, apply }`
//!   publishes the rows, and the launch flow's apply resolves (`"ok"`) or
//!   rejects (`"reject"`). Absent: the launch flow has not answered yet.
//!
//! Log lines: `["updateWindow.create", {width, height, parent, title}]`,
//! `["updateWindow.show", window, inactive]`, `["updateWindow.close",
//! window]`, `["update.action", name]`, `["launchList.apply", result]`.

use std::rc::Rc;
use std::sync::{Arc, Mutex};

use shell_contract::IpcValue;
use shell_contract::editors::Then;
use shell_contract::runtime::Services;

use main_core::shell::launch_recovery::{RecoveryChoice, RecoveryListItem, RecoveryListResult};
use main_core::shell::update_notes::normalize_release_notes;
use main_core::shell::updater::{
    UpdateAction, UpdatePhase, UpdateStatePatch, UpdateUiState, UpdateUiStrings,
};
use serde_json::{Map, Value, json};
use shell_contract::{Hosts, IpcError, WindowId};

use crate::update_window::{UpdateWindowSpec, UpdateWindows, UpdateWindowsHost};
use crate::{launch_list, update_window};

/// The case's log (ipc-probe inserts it before any `probe_hosts`)
type ProbeLog = Arc<Mutex<Vec<Value>>>;

struct FakeWindows {
    id: u32,
    log: ProbeLog,
}

impl FakeWindows {
    fn push(&self, line: Value) {
        self.log.lock().unwrap().push(line);
    }
}

impl UpdateWindows for FakeWindows {
    fn create(&self, spec: &UpdateWindowSpec, inactive: bool) -> WindowId {
        self.push(json!([
            "updateWindow.create",
            {
                "width": spec.width,
                "height": spec.height,
                "parent": spec.parent.map(|w| w.0),
                "title": spec.title,
            }
        ]));
        // shown once ready to show
        self.push(json!(["updateWindow.show", self.id, inactive]));
        WindowId(self.id)
    }
    fn show(&self, window: WindowId, inactive: bool) {
        self.push(json!(["updateWindow.show", window.0, inactive]));
    }
    fn close(&self, window: WindowId) {
        self.push(json!(["updateWindow.close", window.0]));
    }
}

/// The case's `hosts.u`, kept for [`seed`]
#[derive(Clone)]
struct Seed(Arc<Value>);

pub fn hosts(hosts: &mut Hosts, case: &Value) {
    let log = hosts.get::<ProbeLog>().cloned().unwrap_or_default();
    let id = case["windowId"].as_u64().unwrap_or(900) as u32;
    let windows: UpdateWindowsHost = Arc::new(FakeWindows { id, log });
    hosts.insert(windows);
    hosts.insert(Seed(Arc::new(case.clone())));
}

fn action_name(action: UpdateAction) -> &'static str {
    match action {
        UpdateAction::Download => "download",
        UpdateAction::Install => "install",
        UpdateAction::Later => "later",
        UpdateAction::OpenDownload => "openDownload",
    }
}

fn result_value(result: &RecoveryListResult) -> Value {
    match result {
        RecoveryListResult::Dismissed => json!({ "dismissed": true }),
        RecoveryListResult::Decisions(decisions) => {
            let mut out = Map::new();
            for (id, choice) in decisions.entries() {
                let choice = match choice {
                    RecoveryChoice::Restore => "restore",
                    RecoveryChoice::Discard => "discard",
                };
                out.insert(id.to_owned(), json!(choice));
            }
            json!({ "decisions": out })
        }
    }
}

/// the updater's callbacks, logged
fn logged_actions(log: ProbeLog) -> update_window::Actions {
    Rc::new(move |action| {
        log.lock()
            .unwrap()
            .push(json!(["update.action", action_name(action)]))
    })
}

/// What the updater does outside a channel call, by name:
///
/// - `u/show-update-window` `{state, inactive}`: `showUpdateWindow`;
/// - `u/push-update-state` `{phase, percent?, visibleInstall?}`: `pushUpdateState`;
/// - `u/close-update-window`: `closeUpdateWindow` (install, quit);
/// - `u/update-window-closed`: the window's `closed` event (the user closed it).
pub fn trigger(name: &str, args: &Value, services: &Services, then: Then<IpcValue>) -> bool {
    let log = services
        .hosts
        .get::<ProbeLog>()
        .cloned()
        .unwrap_or_default();
    let window = update_window::current().expect("registered");
    match name {
        "u/show-update-window" => window.show(
            ui_state(&args["state"]),
            logged_actions(log),
            args["inactive"].as_bool().unwrap_or(false),
        ),
        "u/push-update-state" => window.push(&UpdateStatePatch {
            phase: phase(&args["phase"]),
            percent: args["percent"].as_f64(),
            visible_install: args["visibleInstall"].as_bool(),
        }),
        "u/close-update-window" => window.close(),
        "u/update-window-closed" => window.closed(WindowId(window_id(services))),
        _ => return false,
    }
    then(Ok(IpcValue::Undefined));
    true
}

/// the id the fake gave the window (`hosts.u.windowId`)
fn window_id(services: &Services) -> u32 {
    services
        .hosts
        .get::<Seed>()
        .and_then(|Seed(case)| case["windowId"].as_u64())
        .unwrap_or(900) as u32
}

pub fn seed(hosts: &Hosts) {
    let Some(Seed(case)) = hosts.get::<Seed>() else {
        return;
    };
    let log = hosts.get::<ProbeLog>().cloned().unwrap_or_default();
    let window = update_window::current().expect("registered");
    for shown in case["update"].as_array().into_iter().flatten() {
        let inactive = shown["inactive"].as_bool().unwrap_or(false);
        window.show(
            ui_state(&shown["state"]),
            logged_actions(log.clone()),
            inactive,
        );
    }
    match case.get("launchList") {
        None => {}
        Some(Value::Null) => launch_list::current().expect("registered").publish_none(),
        Some(list) => {
            let items = list["items"]
                .as_array()
                .map(|items| items.iter().map(item).collect())
                .unwrap_or_default();
            let ok = list["apply"] != "reject";
            launch_list::current().expect("registered").publish(
                items,
                Rc::new(move |result, done| {
                    log.lock()
                        .unwrap()
                        .push(json!(["launchList.apply", result_value(&result)]));
                    done.settle(if ok {
                        Ok(())
                    } else {
                        Err(IpcError {
                            name: Some("Error".into()),
                            message: "apply failed".into(),
                        })
                    })
                }),
            );
        }
    }
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

fn phase(value: &Value) -> UpdatePhase {
    match value.as_str() {
        Some("downloading") => UpdatePhase::Downloading,
        Some("downloaded") => UpdatePhase::Downloaded,
        Some("error") => UpdatePhase::Error,
        Some("manual") => UpdatePhase::Manual,
        Some("install-failed") => UpdatePhase::InstallFailed,
        _ => UpdatePhase::Available,
    }
}

fn ui_state(state: &Value) -> UpdateUiState {
    let s = &state["strings"];
    UpdateUiState {
        phase: phase(&state["phase"]),
        version: text(state, "version"),
        current_version: text(state, "currentVersion"),
        percent: state["percent"].as_f64().unwrap_or(0.0),
        lang: text(state, "lang"),
        strings: UpdateUiStrings {
            title: text(s, "title"),
            headline: text(s, "headline"),
            desc: text(s, "desc"),
            download: text(s, "download"),
            later: text(s, "later"),
            install: text(s, "install"),
            downloading: text(s, "downloading"),
            failed: text(s, "failed"),
            retry: text(s, "retry"),
            manual_desc: text(s, "manualDesc"),
            install_failed_desc: text(s, "installFailedDesc"),
            visible_install_desc: text(s, "visibleInstallDesc"),
            restart_desc: text(s, "restartDesc"),
            open_download: text(s, "openDownload"),
            notes_label: text(s, "notesLabel"),
            notes_on_git_hub: text(s, "notesOnGitHub"),
            notes_truncated: text(s, "notesTruncated"),
        },
        release_notes: normalize_release_notes(&state["releaseNotes"]),
        visible_install: state["visibleInstall"].as_bool().unwrap_or(false),
    }
}

fn item(row: &Value) -> RecoveryListItem {
    RecoveryListItem {
        id: text(row, "id"),
        editor_kind: text(row, "editorKind"),
        name: text(row, "name"),
        folder: row["folder"].as_str().map(str::to_owned),
        last_copy_time: row["lastCopyTime"].as_f64().unwrap_or(0.0),
        untitled: row["untitled"].as_bool().unwrap_or(false),
        file_changed_after_copy: row["fileChangedAfterCopy"].as_bool().unwrap_or(false),
        original_missing: row["originalMissing"].as_bool().unwrap_or(false),
    }
}
