//! `dialog.*` (the shared host `Dialogs`): native dialogs through `rfd`, on
//! the UI thread. A handler calls them from the core thread, which waits
//! until the dialog is closed (the contract, section 3, "known difference").

use std::path::PathBuf;
use std::sync::Arc;

use rfd::{MessageButtons, MessageDialog, MessageDialogResult, MessageLevel};
use shell_contract::hosts::{Dialogs, FileDialog, MessageBox, MessageBoxAnswer};
use shell_contract::ids::WindowId;
use shell_contract::runtime::Thread;
use shell_contract::{DialogsHost, Hosts};
use tauri::{AppHandle, Manager, Window};

use super::{HostContext, on_ui};
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

fn level_of(kind: Option<&str>) -> MessageLevel {
    match kind {
        Some("error") => MessageLevel::Error,
        Some("warning") => MessageLevel::Warning,
        _ => MessageLevel::Info,
    }
}

/// `rfd` shows one to three buttons and no checkbox. A box outside that is
/// answered as its cancel button (the last one when it names none) and logged:
/// an in-page dialog for them is the batches' to build when a handler needs it.
fn answer(options: &MessageBox, parent: Option<&Window>) -> MessageBoxAnswer {
    let buttons = &options.buttons;
    let cancelled = |why: &str| {
        let index = options.cancel_id.unwrap_or(buttons.len().saturating_sub(1));
        eprintln!(
            "shell: dialog.showMessageBox: {why}; answered as button {index}: '{}'",
            options.message
        );
        MessageBoxAnswer {
            response: index,
            checkbox_checked: false,
        }
    };
    if options.checkbox_label.is_some() {
        return cancelled("a checkbox is not supported by the native dialog");
    }
    let custom = match buttons.as_slice() {
        [] => MessageButtons::Ok,
        [a] => MessageButtons::OkCustom(a.clone()),
        [a, b] => MessageButtons::OkCancelCustom(a.clone(), b.clone()),
        [a, b, c] => MessageButtons::YesNoCancelCustom(a.clone(), b.clone(), c.clone()),
        _ => return cancelled("more than three buttons are not supported by the native dialog"),
    };
    let mut dialog = MessageDialog::new()
        .set_level(level_of(options.kind.as_deref()))
        .set_buttons(custom)
        .set_description(match &options.detail {
            Some(detail) if !options.message.is_empty() => {
                format!("{}\n\n{detail}", options.message)
            }
            Some(detail) => detail.clone(),
            None => options.message.clone(),
        });
    if let Some(title) = &options.title {
        dialog = dialog.set_title(title);
    }
    if let Some(parent) = parent {
        dialog = dialog.set_parent(parent);
    }
    let response = match dialog.show() {
        MessageDialogResult::Custom(label) => buttons.iter().position(|b| *b == label),
        MessageDialogResult::Ok | MessageDialogResult::Yes => Some(0),
        MessageDialogResult::Cancel | MessageDialogResult::No => {
            Some(options.cancel_id.unwrap_or(buttons.len().saturating_sub(1)))
        }
    };
    MessageBoxAnswer {
        // a closed dialog (Escape, the close box) is the cancel button
        response: response
            .unwrap_or_else(|| options.cancel_id.unwrap_or(buttons.len().saturating_sub(1))),
        checkbox_checked: false,
    }
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
            answer(&options, window.as_ref())
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
