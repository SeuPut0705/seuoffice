//! `--measure-dialog <out.json>` (the stage 3 shell contract, section 3,
//! "known difference", and section 9): the measurement W owes. A modal
//! dialog keeps the core thread waiting in `run_on(ui, …)`, so the IPC
//! replies of other windows wait too. This mode opens a test page
//! (`frontend/measure.html`) in a view with the real bridge; the page keeps
//! calling a cheap registered channel (`quick-look:get-settings`) at a
//! steady pace, and asks the shell to block the core thread for 2 s:
//!
//! - `ui`: the core thread waits in `run_on(ui, …)` and the UI-thread job
//!   holds the UI thread the whole time (what a modal dialog does to the core
//!   thread, and in the worst case to the UI thread too: a real dialog pumps
//!   the UI thread's events, this job does not);
//! - `core`: the core thread alone is held, the UI thread runs on.
//!
//! The page also times the echo of 1 KB and 10 MB through the real frames
//! (`measure:echo`, handled on the core thread, in no table), then reports
//! everything in one message; the shell writes the JSON and exits.
//!
//! The three channels exist only in this mode, ahead of the dispatch.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use shell_contract::ids::{RequestId, ViewId};
use shell_contract::runtime::{Thread, run_on};
use shell_contract::value::IpcValue;
use shell_core::outlet::{Outlet, reply_frame};
use tauri::AppHandle;

use crate::ipc::Ipc;

/// How long the core thread is held, as a modal dialog would hold it
pub const HOLD: Duration = Duration::from_secs(2);

/// The run is over when the page reports, or after this long
const DEADLINE: Duration = Duration::from_secs(180);

pub struct Measure {
    out: PathBuf,
    ui: Arc<dyn Thread>,
    app: AppHandle,
    reported: AtomicBool,
}

impl Measure {
    pub fn new(out: PathBuf, ui: Arc<dyn Thread>, app: AppHandle) -> Arc<Self> {
        let measure = Arc::new(Measure {
            out,
            ui,
            app,
            reported: AtomicBool::new(false),
        });
        // a page that never loads must not hang the runner
        let watchdog = measure.clone();
        std::thread::spawn(move || {
            std::thread::sleep(DEADLINE);
            if !watchdog.reported.load(Ordering::Acquire) {
                watchdog.finish(
                    json!({ "error": format!("no report within {} s", DEADLINE.as_secs()) }),
                    3,
                );
            }
        });
        measure
    }

    pub fn handles(&self, channel: &str) -> bool {
        channel.starts_with("measure:")
    }

    /// The facts the page cannot know
    fn environment() -> Value {
        json!({
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "shell": env!("CARGO_PKG_VERSION"),
            "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        })
    }

    fn finish(&self, mut report: Value, code: i32) {
        self.reported.store(true, Ordering::Release);
        if let Value::Object(map) = &mut report {
            map.insert("environment".into(), Self::environment());
        }
        let text = serde_json::to_string_pretty(&report).unwrap_or_default();
        if let Err(error) = std::fs::write(&self.out, format!("{text}\n")) {
            eprintln!("shell: measure: writing {}: {error}", self.out.display());
        } else {
            eprintln!("shell: measure: wrote {}", self.out.display());
        }
        self.app.exit(code);
    }

    /// One message of the test page; answers it as the dispatch would
    pub fn invoke(
        &self,
        ipc: &Ipc,
        view: ViewId,
        id: RequestId,
        channel: &str,
        args: Vec<IpcValue>,
    ) {
        let first = args.into_iter().next().unwrap_or(IpcValue::Undefined);
        match channel {
            // through the core thread, as every handler's answer
            "measure:echo" => {
                let outlet = ipc.outlet.clone();
                let channel = channel.to_owned();
                ipc.core.post(Box::new(move || {
                    outlet.deliver(view, reply_frame(id, &channel, &Ok(first)));
                }));
            }
            "measure:block" => {
                // answered first: the page times from the answer
                ipc.outlet
                    .deliver(view, reply_frame(id, channel, &Ok(IpcValue::Undefined)));
                let on_ui = matches!(&first, IpcValue::String(kind) if kind == "ui");
                let ui = self.ui.clone();
                ipc.core.post(Box::new(move || {
                    if on_ui {
                        run_on(ui.as_ref(), || std::thread::sleep(HOLD));
                    } else {
                        std::thread::sleep(HOLD);
                    }
                }));
            }
            "measure:report" => {
                let report = match &first {
                    IpcValue::String(text) => serde_json::from_str(text).unwrap_or_else(
                        |e| json!({ "error": format!("the report is not JSON: {e}") }),
                    ),
                    _ => json!({ "error": "the report is not a string" }),
                };
                ipc.outlet
                    .deliver(view, reply_frame(id, channel, &Ok(IpcValue::Undefined)));
                self.finish(report, 0);
            }
            other => ipc.outlet.deliver(
                view,
                reply_frame(
                    id,
                    other,
                    &Err(shell_contract::error::IpcError::no_handler(other)),
                ),
            ),
        }
    }
}
