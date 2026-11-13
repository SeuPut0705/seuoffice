//! `main-core`'s Electron-shaped traits over the shell's hosts: the `Dialog`
//! the dialog memory calls, the `MessageBox` the recovery prompt calls, and
//! the `app.getPath` the default save folder reads.

use std::path::PathBuf;

use jscompat::{JsObject, JsonValue};
use main_core::packages::electron_utils::default_save_dir::{PathProvider, Thrown};
use main_core::packages::electron_utils::dialog_memory::Dialog;
use main_core::packages::electron_utils::message_box::{
    MessageBox, MessageBoxOptions, ParentWindow,
};
use shell_contract::WindowId;
use shell_contract::hosts::{self, DialogsHost, FileDialog, FileFilter};
use shell_contract::runtime::{AppPaths, PathName};

fn str_of(v: Option<&JsonValue>) -> Option<String> {
    match v {
        Some(JsonValue::String(s)) => Some(s.clone()),
        _ => None,
    }
}

fn strings(v: Option<&JsonValue>) -> Vec<String> {
    match v {
        Some(JsonValue::Array(items)) => items.iter().filter_map(|i| str_of(Some(i))).collect(),
        _ => Vec::new(),
    }
}

/// Electron's dialog options as the shared host takes them
pub(crate) fn file_dialog(options: &JsObject<JsonValue>) -> FileDialog {
    FileDialog {
        title: str_of(options.get("title")),
        default_path: str_of(options.get("defaultPath")).map(PathBuf::from),
        button_label: str_of(options.get("buttonLabel")),
        filters: match options.get("filters") {
            Some(JsonValue::Array(filters)) => filters
                .iter()
                .map(|f| FileFilter {
                    name: str_of(f.get("name").as_deref()).unwrap_or_default(),
                    extensions: strings(f.get("extensions").as_deref()),
                })
                .collect(),
            _ => Vec::new(),
        },
        properties: strings(options.get("properties")),
    }
}

/// Electron's `dialog` over the shared host
pub(crate) struct HostDialog<'a>(pub &'a DialogsHost);

impl Dialog for HostDialog<'_> {
    type Window = WindowId;

    fn show_open_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.0.open(parent.copied(), &file_dialog(options));
        let mut result = JsObject::new();
        result.set("canceled", JsonValue::Bool(picked.is_none()));
        result.set(
            "filePaths",
            JsonValue::Array(
                picked
                    .unwrap_or_default()
                    .iter()
                    .map(|p| JsonValue::String(p.to_string_lossy().into_owned()))
                    .collect(),
            ),
        );
        JsonValue::Object(result)
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.0.save(parent.copied(), &file_dialog(options));
        let mut result = JsObject::new();
        result.set("canceled", JsonValue::Bool(picked.is_none()));
        if let Some(p) = picked {
            result.set(
                "filePath",
                JsonValue::String(p.to_string_lossy().into_owned()),
            );
        }
        JsonValue::Object(result)
    }
}

/// What a dialog answered: `filePaths[0]` of an open dialog, `filePath` of
/// a save dialog; `None` when it was cancelled or empty
pub(crate) fn picked_path(result: &JsonValue, key: &str) -> Option<String> {
    if result.get("canceled").is_some_and(|c| c.truthy()) {
        return None;
    }
    let value = result.get(key)?;
    let path = match &*value {
        JsonValue::Array(items) => items.first().and_then(|p| str_of(Some(p))),
        JsonValue::String(s) => Some(s.clone()),
        _ => None,
    }?;
    (!path.is_empty()).then_some(path)
}

/// A dialog's parent: a window the shell still has
pub(crate) struct Parent(pub WindowId);

impl ParentWindow for Parent {
    fn is_destroyed(&self) -> bool {
        false
    }
}

/// `dialog.showMessageBox` over the shared host
pub(crate) struct HostMessageBox<'a>(pub &'a DialogsHost);

pub(crate) fn message_box(options: &MessageBoxOptions) -> hosts::MessageBox {
    hosts::MessageBox {
        kind: Some(options.kind.to_owned()),
        title: options.title.clone(),
        message: options.message.clone(),
        detail: options.detail.clone(),
        buttons: options.buttons.clone(),
        default_id: Some(options.default_id as usize),
        cancel_id: options.cancel_id.map(|c| c as usize),
        checkbox_label: None,
    }
}

impl MessageBox<Parent> for HostMessageBox<'_> {
    fn show_message_box_over(&self, parent: &Parent, options: &MessageBoxOptions) -> f64 {
        self.0
            .message(Some(parent.0), &message_box(options))
            .response as f64
    }
    fn show_message_box(&self, options: &MessageBoxOptions) -> f64 {
        self.0.message(None, &message_box(options)).response as f64
    }
}

/// `app.getPath(name)` over the shell's paths
pub(crate) struct Paths<'a>(pub &'a dyn AppPaths);

impl PathProvider for Paths<'_> {
    fn get_path(&self, name: &str) -> Result<String, Thrown> {
        let name = match name {
            "userData" => PathName::UserData,
            "documents" => PathName::Documents,
            "home" => PathName::Home,
            "temp" => PathName::Temp,
            "appData" => PathName::AppData,
            "desktop" => PathName::Desktop,
            "downloads" => PathName::Downloads,
            other => return Err(Thrown(format!("Failed to get '{other}' path"))),
        };
        Ok(self.0.path(name).to_string_lossy().into_owned())
    }
}
