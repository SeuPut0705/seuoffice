//! Batch U's hosts (host/update.rs, the updater and the installer): not implemented yet. `install` is the one
//! entry point of the file; the batch inserts its hosts here
//! (`hosts.insert::<Arc<dyn ...>>`), and nothing outside this file changes.

use shell_contract::Hosts;
use tauri::{AppHandle, RunEvent};

use super::HostContext;

pub fn install(_hosts: &mut Hosts, _cx: &HostContext) {}

/// The event loop's events the updater answers (quit to install). U fills it.
pub fn on_run_event(_app: &AppHandle, _event: &RunEvent) {}
