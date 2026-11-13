//! `dialog.*` (the shared host `Dialogs`): native dialogs through `rfd`, on
//! the UI thread. A handler calls them from the core thread, which waits
//! until the dialog is closed (the contract, section 3, "known difference").

use std::path::PathBuf;
use std::sync::Arc;

use rfd::{MessageButtons, MessageDialog, MessageLevel};
use shell_contract::hosts::{Dialogs, FileDialog, MessageBox, MessageBoxAnswer};
use shell_contract::ids::WindowId;
use shell_contract::runtime::Thread;
use shell_contract::{DialogsHost, Hosts};
use tauri::{AppHandle, Manager, Window};

use super::{HostContext, message_box, on_ui};
use crate::views::ViewTable;

pub struct ShellDialogs {
    app: AppHandle,
    ui: Arc<dyn Thread>,
    views: Arc<ViewTable>,
}

pub fn install(hosts: &mut Hosts, cx: &HostContext) {
    let dialogs: DialogsHost = Arc::new(ShellDialogs {
        app: cx.app.clone(),
        ui: cx.ui.clone(),
        views: cx.views.clone(),
    });
    hosts.insert(dialogs);
}

/// The window a dialog is modal to
fn parent_window(app: &AppHandle, views: &ViewTable, parent: Option<WindowId>) -> Option<Window> {
    let label = views.label_of_window(parent?)?;
    app.get_window(&label)
}

fn has(properties: &[String], name: &str) -> bool {
    properties.iter().any(|p| p == name)
}

/// An Electron filter, `extensions: ['*']` meaning all files, which `rfd` takes as no filter
fn file_dialog(options: &FileDialog, parent: Option<&Window>) -> rfd::FileDialog {
    let mut dialog = rfd::FileDialog::new();
    if let Some(parent) = parent {
        dialog = dialog.set_parent(parent);
    }
    if let Some(title) = &options.title {
        dialog = dialog.set_title(title);
    }
    for filter in &options.filters {
        if filter.extensions.iter().any(|e| e == "*") || filter.extensions.is_empty() {
            continue;
        }
        dialog = dialog.add_filter(&filter.name, &filter.extensions);
    }
    if has(&options.properties, "createDirectory") {
        dialog = dialog.set_can_create_directories(true);
    }
    if let Some(path) = &options.default_path {
        // a folder is where the dialog opens; a file name is also what the save dialog proposes
        if path.is_dir() {
            dialog = dialog.set_directory(path);
        } else {
            if let Some(dir) = path.parent().filter(|d| d.is_dir()) {
                dialog = dialog.set_directory(dir);
            }
            if let Some(name) = path.file_name() {
                dialog = dialog.set_file_name(name.to_string_lossy());
            }
        }
    }
    dialog
}

impl Dialogs for ShellDialogs {
    fn open(&self, parent: Option<WindowId>, options: &FileDialog) -> Option<Vec<PathBuf>> {
        let (app, views, options) = (self.app.clone(), self.views.clone(), options.clone());
        on_ui(&self.ui, move || {
            let window = parent_window(&app, &views, parent);
            let dialog = file_dialog(&options, window.as_ref());
            let directory = has(&options.properties, "openDirectory");
            let multiple = has(&options.properties, "multiSelections");
            // both given: Windows' Electron dialog is a folder dialog, as is this
            match (directory, multiple) {
                (true, true) => dialog.pick_folders(),
                (true, false) => dialog.pick_folder().map(|p| vec![p]),
                (false, true) => dialog.pick_files(),
                (false, false) => dialog.pick_file().map(|p| vec![p]),
            }
        })
    }

    fn save(&self, parent: Option<WindowId>, options: &FileDialog) -> Option<PathBuf> {
        let (app, views, options) = (self.app.clone(), self.views.clone(), options.clone());
        on_ui(&self.ui, move || {
            let window = parent_window(&app, &views, parent);
            file_dialog(&options, window.as_ref()).save_file()
        })
    }

    fn message(&self, parent: Option<WindowId>, options: &MessageBox) -> MessageBoxAnswer {
        let (app, views, options) = (self.app.clone(), self.views.clone(), options.clone());
        on_ui(&self.ui, move || {
            let window = parent_window(&app, &views, parent);
            message_box::show(&options, window.as_ref())
        })
    }

    fn error(&self, title: &str, content: &str) {
        let (title, content) = (title.to_owned(), content.to_owned());
        on_ui(&self.ui, move || {
            MessageDialog::new()
                .set_level(MessageLevel::Error)
                .set_buttons(MessageButtons::Ok)
                .set_title(title)
                .set_description(content)
                .show();
        });
    }
}
