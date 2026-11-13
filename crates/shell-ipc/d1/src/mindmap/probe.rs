//! What the shell does before a case's first call, for `tools/ipc-diff`:
//! the views it made and the calls it made into the editor (the ones other
//! batches make through `DocumentEditors`), so that the events only those
//! calls emit are compared too. The case's `hosts.d1.mindmap`:
//!
//! - `open`: `[{view, path?, decision?, seed?}]`, the views the shell made
//!   (`createMindmapView(path)`, then `openMindmapFileWithDecision` for a
//!   `decision` of `restore` or `original`, then `queueMindmapSeedFor` for a
//!   `seed` of `{outline}` or `{copy}`); absent: no view at all
//! - `startup`: `[{call, view, ...}]` run in order after the views are made:
//!   `dirty`, `requestSave {mode}`, `requestClose`, `fileRenamed {from, to}`,
//!   `menuCommand {command}`, `exportRequest {format}`, `readOutline`,
//!   `readBytes`, `copiesNow`

use main_core::packages::electron_utils::recovery_contract::{
    RecoveryOpenDecision, RecoveryOpenFileRequest,
};
use serde_json::Value;
use shell_contract::ViewId;

use super::app::{MindmapApp, SaveMode, Seed};

pub struct OpenView {
    view: ViewId,
    path: Option<String>,
    decision: Option<RecoveryOpenDecision>,
    seed: Option<Seed>,
}

enum Startup {
    Dirty(ViewId),
    RequestSave(ViewId, SaveMode),
    RequestClose(ViewId),
    FileRenamed(ViewId, String, String),
    MenuCommand(ViewId, String),
    ExportRequest(ViewId, String),
    ReadOutline(ViewId),
    ReadBytes(ViewId),
    CopiesNow,
}

/// The views and the first calls of a case, applied when the routes are built
pub struct ProbeOpen {
    open: Vec<OpenView>,
    startup: Vec<Startup>,
}

pub fn probe_open(case: &Value) -> ProbeOpen {
    let script = case.get("mindmap").unwrap_or(&Value::Null);
    let text = |entry: &Value, key: &str| entry.get(key).and_then(Value::as_str).map(str::to_owned);
    let view_of = |entry: &Value| {
        entry
            .get("view")
            .and_then(Value::as_u64)
            .map(|v| ViewId(v as u32))
    };
    let open = match script.get("open").and_then(Value::as_array) {
        Some(entries) => entries
            .iter()
            .filter_map(|entry| {
                let seed = entry.get("seed").and_then(|seed| {
                    match (text(seed, "outline"), text(seed, "copy")) {
                        (Some(outline), _) => Some(Seed::Outline(outline)),
                        (None, Some(copy)) => Some(Seed::Copy(copy.into_bytes())),
                        _ => None,
                    }
                });
                Some(OpenView {
                    view: view_of(entry)?,
                    path: text(entry, "path"),
                    decision: match entry.get("decision").and_then(Value::as_str) {
                        Some("restore") => Some(RecoveryOpenDecision::Restore),
                        Some("original") => Some(RecoveryOpenDecision::Original),
                        _ => None,
                    },
                    seed,
                })
            })
            .collect(),
        None => Vec::new(),
    };
    let startup = script
        .get("startup")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|entry| {
                    let call = entry.get("call").and_then(Value::as_str)?;
                    let view = view_of(entry).unwrap_or(ViewId(1));
                    let arg = |key: &str| text(entry, key).unwrap_or_default();
                    Some(match call {
                        "dirty" => Startup::Dirty(view),
                        "requestSave" => Startup::RequestSave(
                            view,
                            if arg("mode") == "saveAs" {
                                SaveMode::SaveAs
                            } else {
                                SaveMode::Save
                            },
                        ),
                        "requestClose" => Startup::RequestClose(view),
                        "fileRenamed" => Startup::FileRenamed(view, arg("from"), arg("to")),
                        "menuCommand" => Startup::MenuCommand(view, arg("command")),
                        "exportRequest" => Startup::ExportRequest(view, arg("format")),
                        "readOutline" => Startup::ReadOutline(view),
                        "readBytes" => Startup::ReadBytes(view),
                        "copiesNow" => Startup::CopiesNow,
                        _ => return None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    ProbeOpen { open, startup }
}

impl ProbeOpen {
    pub(super) fn apply(&self, app: &MindmapApp) {
        for entry in &self.open {
            app.create_view(entry.view, entry.path.as_deref());
            if let (Some(decision), Some(path)) = (entry.decision, &entry.path) {
                app.open_file_with_decision(
                    entry.view,
                    &RecoveryOpenFileRequest {
                        file_path: path.clone(),
                        decision,
                    },
                );
            }
            if let Some(seed) = &entry.seed {
                app.queue_seed(entry.view, seed.clone());
            }
        }
        for step in &self.startup {
            match step {
                Startup::Dirty(view) => {
                    // what the renderer's dirty-changed does
                    let mut state = app.0.state.borrow_mut();
                    if state.unopened.contains_key(view) {
                        state.dirty.remove(view);
                    } else {
                        state.dirty.insert(*view);
                    }
                }
                Startup::RequestSave(view, mode) => {
                    app.request_save(*view, *mode, Box::new(|_| {}))
                }
                Startup::RequestClose(view) => {
                    app.request_close(*view, app.window_of(*view), Box::new(|_| {}))
                }
                Startup::FileRenamed(view, from, to) => app.file_renamed(*view, from, to),
                Startup::MenuCommand(view, command) => app.send_menu_command(*view, command),
                Startup::ExportRequest(view, format) => app.send_export_request(*view, format),
                Startup::ReadOutline(view) => app.read_outline(*view, Box::new(|_| {})),
                Startup::ReadBytes(view) => app.read_bytes(*view, Box::new(|_| {})),
                Startup::CopiesNow => {
                    app.write_copies_now(super::app::COPY_NOW_WAIT, Box::new(|| {}))
                }
            }
        }
    }
}
