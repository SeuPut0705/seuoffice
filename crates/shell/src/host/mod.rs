//! The hosts (the stage 3 shell contract, section 5): what a handler reaches
//! beyond `Services`, implemented here on Tauri and the operating system.
//!
//! Batch W owns the shared hosts (dialogs, the OS shell, the clipboard, web
//! contents, the shell window) and its own. Every other batch implements its
//! hosts in a file of its own, named by the contract's file table, and
//! inserts them from that file's `install`; this module calls each `install`
//! before the batches register, so a batch adds a host without touching it.

use std::sync::{Arc, Mutex};

use main_core::packages::electron_utils::recovery_store::SharedRecoveryState;
use shell_contract::Hosts;
use shell_contract::runtime::Thread;
use tauri::{AppHandle, RunEvent};

use crate::views::ViewTable;

pub mod clipboard;
pub mod contents;
pub mod dialog;
pub mod message_box;
pub mod os_shell;
pub(crate) mod shell_tabs;
pub mod unbuilt;
pub mod w;
pub mod window;
pub(crate) mod window_open;

// one file per other batch's hosts; each is `install` and nothing else until its batch fills it
pub mod crash; // U
pub mod d1; // D1
pub mod d2; // D2
pub mod menu; // M
pub mod net; // A
pub mod os; // U
pub mod print; // M
pub mod secrets; // A
pub mod update; // U

/// What the hosts are built from
#[derive(Clone)]
pub struct HostContext {
    pub app: AppHandle,
    pub ui: Arc<dyn Thread>,
    pub views: Arc<ViewTable>,
    pub windows: Arc<window::Windows>,
}

/// The state TypeScript kept once per process, one instance each, shared by
/// every batch (ipc-probe's fakes insert the same): the recovery state (U, D1,
/// D2), the dialog memory and the default-save-folder state
pub fn install_process_state(hosts: &mut Hosts) {
    hosts.insert(Arc::new(Mutex::new(
        SharedRecoveryState::with_random_run_id(),
    )));
    let memory: shell_ipc_w::SharedDialogMemory = Arc::default();
    hosts.insert(memory);
    let save_dir: shell_ipc_w::SharedSaveDirState = Arc::default();
    hosts.insert(save_dir);
}

/// Every host the shell has; the batches' `register` read them with `Hosts::need`
pub fn install(hosts: &mut Hosts, cx: &HostContext) {
    dialog::install(hosts, cx);
    os_shell::install(hosts, cx);
    clipboard::install(hosts, cx);
    contents::install(hosts, cx);
    window::install(hosts, cx);
    install_process_state(hosts);
    w::install(hosts, cx);

    crash::install(hosts, cx);
    d1::install(hosts, cx);
    d2::install(hosts, cx);
    menu::install(hosts, cx);
    net::install(hosts, cx);
    os::install(hosts, cx);
    print::install(hosts, cx);
    secrets::install(hosts, cx);
    update::install(hosts, cx);
}

/// Every event of the event loop, for the batches that answer one (U: files
/// opened from the OS, the updater's quit)
pub fn on_run_event(app: &AppHandle, event: &RunEvent) {
    os::on_run_event(app, event);
    update::on_run_event(app, event);
}

/// Runs `job` on the UI thread and waits for it. A host is called from the
/// core thread, where this blocks it, as the contract's section 3 says; from
/// the UI thread itself (`run_on` would deadlock) it runs at once.
pub fn on_ui<R: Send + 'static>(
    ui: &Arc<dyn Thread>,
    job: impl FnOnce() -> R + Send + 'static,
) -> R {
    if ui.is_current() {
        job()
    } else {
        shell_contract::runtime::run_on(ui.as_ref(), job)
    }
}
