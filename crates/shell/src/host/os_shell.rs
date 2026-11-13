//! `shell.*` (the shared host `OsShell`): a path or URL handed to the
//! operating system. None of it touches a window, so it runs on whichever
//! thread the handler is on.

use std::path::Path;
use std::process::Command;
use std::sync::Arc;

use shell_contract::hosts::OsShell;
use shell_contract::{Hosts, OsShellHost};

use super::HostContext;

struct ShellOs;

pub fn install(hosts: &mut Hosts, _cx: &HostContext) {
    let os: OsShellHost = Arc::new(ShellOs);
    hosts.insert(os);
}

/// `shell.openExternal(url)`: the host's call and a page's `window.open` share it
pub(crate) fn open_external(url: &str) -> Result<(), String> {
    open::that_detached(url).map_err(|e| e.to_string())
}

impl OsShell for ShellOs {
    fn open_external(&self, url: &str) -> Result<(), String> {
        open_external(url)
    }

    /// Electron's `openPath` resolves with an error message, or `""` when it opened
    fn open_path(&self, path: &Path) -> String {
        if !path.exists() {
            return "Failed to open path".to_owned();
        }
        match open::that_detached(path) {
            Ok(()) => String::new(),
            Err(error) => error.to_string(),
        }
    }

    fn show_item_in_folder(&self, path: &Path) {
        let started = if cfg!(target_os = "macos") {
            Command::new("open").arg("-R").arg(path).spawn()
        } else if cfg!(windows) {
            // `explorer` takes `/select,` and the path as one argument
            Command::new("explorer.exe")
                .arg(format!("/select,{}", path.display()))
                .spawn()
        } else {
            let folder = path.parent().unwrap_or(path);
            Command::new("xdg-open").arg(folder).spawn()
        };
        if let Err(error) = started {
            eprintln!("shell: showItemInFolder {}: {error}", path.display());
        }
    }

    fn trash_item(&self, path: &Path) -> Result<(), String> {
        trash::delete(path).map_err(|e| e.to_string())
    }
}
