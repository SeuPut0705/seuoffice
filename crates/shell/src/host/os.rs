//! Batch U's hosts (host/os.rs, the file associations, the single instance and the command line): not implemented yet. `install` is the one
//! entry point of the file; the batch inserts its hosts here
//! (`hosts.insert::<Arc<dyn ...>>`), and nothing outside this file changes.

use shell_contract::Hosts;
use tauri::{AppHandle, RunEvent};

use super::HostContext;

pub fn install(_hosts: &mut Hosts, _cx: &HostContext) {}

/// The first thing `main` does: true when another instance holds the single
/// instance lock and took this launch's arguments, so this process ends
/// (Electron's `requestSingleInstanceLock`). U fills it.
pub fn hand_over_to_running_instance() -> bool {
    false
}

/// The event loop's events U answers (files opened from the OS, reopen). U fills it.
pub fn on_run_event(_app: &AppHandle, _event: &RunEvent) {}
