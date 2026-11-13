//! Dialogs, the default save folder, the recent list and message boxes, as
//! `slides-main.ts` and `session-state.ts` use them.

use jscompat::{JsObject, JsonValue};
use main_core::packages::electron_utils::default_save_dir::configured_default_save_dir;
use main_core::packages::electron_utils::dialog_memory::{
    FallbackDir, show_open_dialog_with_memory, show_save_dialog_with_memory,
};
use main_core::packages::electron_utils::message_box::{
    MessageBox as CoreMessageBox, MessageBoxOptions, ParentWindow,
};
use shell_contract::hosts::{MessageBox, MessageBoxAnswer};
use shell_contract::{IpcError, WindowId};

use super::state::App;
use crate::host::{HostDialog, Paths};
use crate::value::thrown;

/// A `BrowserWindow` a box sits over; the shell closes a window's boxes with
/// it, so it never reads as destroyed here
#[derive(Clone, Copy)]
pub struct Parent(pub WindowId);

impl ParentWindow for Parent {
    fn is_destroyed(&self) -> bool {
        false
    }
}

/// `dialog.showMessageBox` of Electron over the shell's dialogs, for the
/// `main-core` modules that ask questions
pub struct BoxOver<'a>(pub &'a dyn shell_contract::hosts::Dialogs);

fn host_box(options: &MessageBoxOptions) -> MessageBox {
    MessageBox {
        kind: Some(options.kind.to_owned()),
        title: options.title.clone(),
        message: options.message.clone(),
        detail: options.detail.clone(),
        buttons: options.buttons.clone(),
        default_id: Some(options.default_id as usize),
        cancel_id: options.cancel_id.map(|id| id as usize),
        checkbox_label: None,
    }
}

impl CoreMessageBox<Parent> for BoxOver<'_> {
    fn show_message_box_over(&self, parent: &Parent, options: &MessageBoxOptions) -> f64 {
        let answer: MessageBoxAnswer = self.0.message(Some(parent.0), &host_box(options));
        answer.response as f64
    }

    fn show_message_box(&self, options: &MessageBoxOptions) -> f64 {
        let answer: MessageBoxAnswer = self.0.message(None, &host_box(options));
        answer.response as f64
    }
}

pub fn jstr(text: impl Into<String>) -> JsonValue {
    JsonValue::String(text.into())
}

pub fn jstrs(items: &[&str]) -> JsonValue {
    JsonValue::Array(items.iter().map(|item| jstr(*item)).collect())
}

/// An options object, keys in the order written
pub fn options<const N: usize>(entries: [(&str, JsonValue); N]) -> JsObject<JsonValue> {
    let mut object = JsObject::new();
    for (key, value) in entries {
        object.set(key, value);
    }
    object
}

/// `{ name, extensions }`
pub fn filter(name: impl Into<String>, extensions: &[&str]) -> JsonValue {
    JsonValue::Object(options([
        ("name", jstr(name)),
        ("extensions", jstrs(extensions)),
    ]))
}

/// `{ name, extensions }` of a computed list
pub fn filter_of(name: impl Into<String>, extensions: Vec<String>) -> JsonValue {
    JsonValue::Object(options([
        ("name", jstr(name)),
        (
            "extensions",
            JsonValue::Array(extensions.into_iter().map(JsonValue::String).collect()),
        ),
    ]))
}

fn canceled(answer: &JsonValue) -> bool {
    match answer {
        JsonValue::Object(object) => object.get("canceled").is_some_and(JsonValue::truthy),
        _ => false,
    }
}

impl App {
    /// `showOpenDialogWithMemory(dialog, dialogParent(), options)`: the file
    /// paths picked, none when cancelled
    pub fn pick_open(&self, options: &JsObject<JsonValue>) -> Vec<String> {
        let parent = self.shell.dialog_parent();
        let mut dialog = HostDialog(&*self.dialogs);
        let mut memory = self.shared.dialog_memory.lock().unwrap();
        let answer =
            show_open_dialog_with_memory(&mut memory, &mut dialog, parent.as_ref(), options, None);
        if canceled(&answer) {
            return Vec::new();
        }
        match &answer {
            JsonValue::Object(object) => match object.get("filePaths") {
                Some(JsonValue::Array(paths)) => paths
                    .iter()
                    .filter_map(|p| match p {
                        JsonValue::String(text) => Some(text.clone()),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            },
            _ => Vec::new(),
        }
    }

    /// The first path an open dialog picked, `None` for a cancel or an
    /// empty first path (`r.canceled || !r.filePaths[0]`)
    pub fn pick_open_first(&self, options: &JsObject<JsonValue>) -> Option<String> {
        self.pick_open(options)
            .into_iter()
            .next()
            .filter(|p| !p.is_empty())
    }

    /// `showSaveDialogWithMemory(dialog, parent, options, getDraftsDir())`:
    /// the path picked, `None` for a cancel or an empty path
    pub fn pick_save(&self, options: &JsObject<JsonValue>) -> Result<Option<String>, IpcError> {
        let fallback = self.drafts_dir()?;
        let parent = self.shell.dialog_parent();
        let mut dialog = HostDialog(&*self.dialogs);
        let mut memory = self.shared.dialog_memory.lock().unwrap();
        let answer = show_save_dialog_with_memory(
            &mut memory,
            &mut dialog,
            parent.as_ref(),
            options,
            Some(&FallbackDir::Dir(&fallback)),
        );
        if canceled(&answer) {
            return Ok(None);
        }
        Ok(match &answer {
            JsonValue::Object(object) => match object.get("filePath") {
                Some(JsonValue::String(path)) if !path.is_empty() => Some(path.clone()),
                _ => None,
            },
            _ => None,
        })
    }

    /// `getDraftsDir()` = `configuredDefaultSaveDir(app)`
    pub fn drafts_dir(&self) -> Result<String, IpcError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0.0, |d| d.as_millis() as f64);
        let mut state = self.shared.save_dir.lock().unwrap();
        configured_default_save_dir(&Paths(&*self.services.paths), &mut state, now)
            .map_err(|e| thrown(e.0))
    }

    /// `dialog.showMessageBox([parent,] options)`: the pressed button
    pub fn message_box(&self, parent: Option<WindowId>, options: &MessageBox) -> usize {
        self.dialogs.message(parent, options).response
    }
}
