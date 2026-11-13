//! `packages/electron-utils/src/dialog-memory.ts`: file dialogs that remember
//! the directory of the last confirmed pick.
//!
//! The memory the TypeScript keys by the `Dialog` object is a
//! [`DialogMemory`] the caller keeps beside its dialog. The dialog options
//! and results are plain values: only `defaultPath`, `properties`,
//! `canceled`, `filePaths` and `filePath` are read. The `await`s are plain
//! calls.

use jscompat::node_path::host::{basename, dirname, join};
use jscompat::{JsObject, JsonValue};

use super::default_save_dir::Thrown;

/// `lastUsedDirectoryByDialog.get(dialog)`
#[derive(Debug, Default, Clone, PartialEq)]
pub struct DialogMemory {
    last_used: Option<String>,
}

impl DialogMemory {
    pub fn new() -> Self {
        Self::default()
    }
}

/// `Dialog`: `showOpenDialog` and `showSaveDialog`, with or without a parent
/// window. A call with a parent is the two-argument form.
pub trait Dialog {
    /// the `BrowserWindow` the caller passes
    type Window;
    fn show_open_dialog(
        &mut self,
        parent: Option<&Self::Window>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue;
    fn show_save_dialog(
        &mut self,
        parent: Option<&Self::Window>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue;
}

/// `fallbackDir`: a folder, or a function that answers one (and may throw or
/// answer nothing).
pub enum FallbackDir<'a> {
    Dir(&'a str),
    Resolve(&'a dyn Fn() -> Result<Option<String>, Thrown>),
}

/// `withRememberedDirectory(dialog, options, fallbackDir)`
fn with_remembered_directory(
    memory: &DialogMemory,
    options: &JsObject<JsonValue>,
    fallback_dir: Option<&FallbackDir<'_>>,
) -> JsObject<JsonValue> {
    let default_path = match options.get("defaultPath") {
        Some(JsonValue::String(path)) => Some(path.as_str()),
        _ => None,
    };
    // No pick confirmed yet this session: anchor in the caller's fallback (the
    // configurable default save folder) instead of Electron's Downloads pin.
    if let Some(path) = default_path
        && basename(path, None) != path
    {
        return options.clone();
    }
    let mut last_dir = memory.last_used.clone().filter(|dir| !dir.is_empty());
    if last_dir.is_none() {
        // This is only a dialog suggestion. An unavailable default folder must
        // not prevent the user from picking another location explicitly.
        last_dir = match fallback_dir {
            Some(FallbackDir::Dir(dir)) => Some((*dir).to_owned()),
            Some(FallbackDir::Resolve(resolve)) => resolve().unwrap_or(None),
            None => None,
        };
    }
    let Some(last_dir) = last_dir.filter(|dir| !dir.is_empty()) else {
        return options.clone();
    };
    let mut with_dir = options.clone();
    match default_path {
        None => with_dir.set("defaultPath", JsonValue::String(last_dir)),
        // A bare file name is a Save As suggestion: anchor it in the remembered
        // directory instead of letting Electron relocate it to Downloads.
        Some(path) => with_dir.set("defaultPath", JsonValue::String(join(&[&last_dir, path]))),
    }
    with_dir
}

/// `result[key]` of a result object
fn field<'a>(result: &'a JsonValue, key: &str) -> Option<&'a JsonValue> {
    match result {
        JsonValue::Object(object) => object.get(key),
        _ => None,
    }
}

fn first_file_path(result: &JsonValue) -> Option<&str> {
    match field(result, "filePaths") {
        Some(JsonValue::Array(paths)) => match paths.first() {
            Some(JsonValue::String(path)) => Some(path),
            _ => None,
        },
        _ => None,
    }
}

fn canceled(result: &JsonValue) -> bool {
    field(result, "canceled").is_some_and(JsonValue::truthy)
}

/// `options.properties?.includes('openDirectory')`
fn picks_directory(options: &JsObject<JsonValue>) -> bool {
    match options.get("properties") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .any(|item| matches!(item, JsonValue::String(s) if s == "openDirectory")),
        Some(JsonValue::String(text)) => text.contains("openDirectory"),
        _ => false,
    }
}

/// `showOpenDialogWithMemory(dialog, parent, options, fallbackDir)`
pub fn show_open_dialog_with_memory<D: Dialog>(
    memory: &mut DialogMemory,
    dialog: &mut D,
    parent: Option<&D::Window>,
    options: &JsObject<JsonValue>,
    fallback_dir: Option<&str>,
) -> JsonValue {
    let fallback = fallback_dir.map(FallbackDir::Dir);
    let with_dir = with_remembered_directory(memory, options, fallback.as_ref());
    let result = dialog.show_open_dialog(parent, &with_dir);
    if let Some(picked) = first_file_path(&result).filter(|p| !p.is_empty())
        && !canceled(&result)
    {
        memory.last_used = Some(if picks_directory(options) {
            picked.to_owned()
        } else {
            dirname(picked)
        });
    }
    result
}

/// `saveAsSuggestion(sourcePath, defaultName)`
pub fn save_as_suggestion(source_path: Option<&str>, default_name: &str) -> String {
    match source_path.filter(|path| !path.is_empty()) {
        Some(path) => join(&[&dirname(path), default_name]),
        None => default_name.to_owned(),
    }
}

/// `showSaveDialogWithMemory(dialog, parent, options, fallbackDir)`
pub fn show_save_dialog_with_memory<D: Dialog>(
    memory: &mut DialogMemory,
    dialog: &mut D,
    parent: Option<&D::Window>,
    options: &JsObject<JsonValue>,
    fallback_dir: Option<&FallbackDir<'_>>,
) -> JsonValue {
    let with_dir = with_remembered_directory(memory, options, fallback_dir);
    let result = dialog.show_save_dialog(parent, &with_dir);
    if !canceled(&result)
        && let Some(JsonValue::String(file_path)) = field(&result, "filePath")
        && !file_path.is_empty()
    {
        memory.last_used = Some(dirname(file_path));
    }
    result
}
