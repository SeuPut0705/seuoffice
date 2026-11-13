//! Fakes of U's hosts for `crates/ipc-probe`, and the state a case starts
//! from. The case's `hosts.u`:
//!
//! - `windowId`: the id the fake gives a new update window (default 900);
//! - `update`: `{ state, inactive }`, shown as the updater shows it before
//!   the call (`showUpdateWindow`); `state` is an `UpdateUiState` whose
//!   `releaseNotes` is what electron-updater reports (normalized here, as
//!   the updater does);
//! - `launchList`: `null` publishes nothing to ask; `{ items, apply }`
//!   publishes the rows, and the launch flow's apply resolves (`"ok"`) or
//!   rejects (`"reject"`). Absent: the launch flow has not answered yet.

use std::rc::Rc;
use std::sync::Arc;

use main_core::shell::launch_recovery::RecoveryListItem;
use main_core::shell::update_notes::normalize_release_notes;
use main_core::shell::updater::{UpdatePhase, UpdateUiState, UpdateUiStrings};
use serde_json::Value;
use shell_contract::{Hosts, IpcError, WindowId};

use crate::update_window::{UpdateWindowSpec, UpdateWindows, UpdateWindowsHost};
use crate::{launch_list, update_window};

struct FakeWindows(u32);

impl UpdateWindows for FakeWindows {
    fn create(&self, _: &UpdateWindowSpec, _: bool) -> WindowId {
        WindowId(self.0)
    }
    fn show(&self, _: WindowId, _: bool) {}
    fn close(&self, _: WindowId) {}
}

/// The case's `hosts.u`, kept for [`seed`]
#[derive(Clone)]
struct Seed(Arc<Value>);

pub fn hosts(hosts: &mut Hosts, case: &Value) {
    let id = case["windowId"].as_u64().unwrap_or(900) as u32;
    let windows: UpdateWindowsHost = Arc::new(FakeWindows(id));
    hosts.insert(windows);
    hosts.insert(Seed(Arc::new(case.clone())));
}

pub fn seed(hosts: &Hosts) {
    let Some(Seed(case)) = hosts.get::<Seed>() else {
        return;
    };
    if let Some(update) = case.get("update") {
        let window = update_window::current().expect("registered");
        let inactive = update["inactive"].as_bool().unwrap_or(false);
        window.show(ui_state(&update["state"]), Rc::new(|_| {}), inactive);
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
                Rc::new(move |_, done| {
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

fn ui_state(state: &Value) -> UpdateUiState {
    let phase = match state["phase"].as_str() {
        Some("downloading") => UpdatePhase::Downloading,
        Some("downloaded") => UpdatePhase::Downloaded,
        Some("error") => UpdatePhase::Error,
        Some("manual") => UpdatePhase::Manual,
        Some("install-failed") => UpdatePhase::InstallFailed,
        _ => UpdatePhase::Available,
    };
    let s = &state["strings"];
    UpdateUiState {
        phase,
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
