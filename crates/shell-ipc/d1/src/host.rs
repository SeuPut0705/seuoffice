//! What the four apps share beyond the contract's hosts: the UI language,
//! `app.getPath` in the shape `main-core` reads it, Electron's `dialog` as
//! `main-core`'s [`Dialog`] over the shell's [`Dialogs`] host, with the
//! remembered folder of `showOpenDialogWithMemory`, and a view's end for
//! state that lives on the core thread.

use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

use jscompat::{JsObject, JsonValue};
use main_core::packages::electron_utils::default_save_dir::{PathProvider, SaveDirState, Thrown};
use main_core::packages::electron_utils::dialog_memory::{Dialog, DialogMemory};
use main_core::packages::i18n::Lang;
use shell_contract::hosts::{Dialogs, FileDialog, FileFilter};
use shell_contract::ipc::RegisterError;
use shell_contract::runtime::{AppPaths, PathName, Services};
use shell_contract::{Batch, ViewId, WindowId};

type GoneListener = Rc<dyn Fn(ViewId)>;

thread_local! {
    /// the core thread's view-gone listeners; see [`on_view_gone`]
    static GONE: RefCell<Vec<GoneListener>> = const { RefCell::new(Vec::new()) };
}

/// `webContents.once('destroyed', …)` for state that is not `Send` (an
/// `Rc<RefCell<…>>` a handler captured). [`shell_contract::runtime::Views`]
/// takes a `Send` listener and runs it on the core thread; this keeps the
/// real listener in a core-thread slot and hands the shell a `Send` one that
/// looks it up. Call from `register`, which runs on the core thread.
pub fn on_view_gone(services: &Services, listener: impl Fn(ViewId) + 'static) {
    let slot = GONE.with(|gone| {
        let mut gone = gone.borrow_mut();
        gone.push(Rc::new(listener));
        gone.len() - 1
    });
    services.views.on_destroyed(Box::new(move |view| {
        let listener = GONE.with(|gone| gone.borrow().get(slot).cloned());
        if let Some(listener) = listener {
            listener(view)
        }
    }));
}

/// `getUiLang()` of `@seuoffice/i18n`: the app-wide UI language, which batch
/// M keeps. The shell inserts it as a [`LocaleHost`].
pub trait Locale: Send + Sync {
    fn ui_lang(&self) -> Lang;
}

pub type LocaleHost = Arc<dyn Locale>;

/// The one process-wide state of `main-core`'s recovery store (shutdown
/// latch, delete epochs, run id, the Don't-Save block), shared with the
/// batches that also write or read recovery copies (U, W, D2). `Hosts` is
/// keyed by type, so every batch that takes this exact type gets the
/// instance the shell inserted once.
pub type RecoveryStateHost =
    Arc<Mutex<main_core::packages::electron_utils::recovery_store::SharedRecoveryState>>;

/// The two pieces of state the TypeScript kept once per process and every
/// editor and the shell read: the folder the last confirmed file dialog
/// picked (`lastUsedDirectoryByDialog`) and the default save folder's retry
/// state. The shell inserts one of each into `Hosts` for every batch; the
/// four apps take them through this. A `Mutex` because `Hosts` holds `Send`
/// values only; every use is on the core thread.
#[derive(Clone, Debug)]
pub struct Shared {
    pub dialog_memory: Arc<Mutex<DialogMemory>>,
    pub save_dir: Arc<Mutex<SaveDirState>>,
}

impl Shared {
    pub fn need(hosts: &shell_contract::Hosts) -> Result<Arc<Shared>, RegisterError> {
        Ok(Arc::new(Shared {
            dialog_memory: hosts.need::<Arc<Mutex<DialogMemory>>>(Batch::D1)?,
            save_dir: hosts.need::<Arc<Mutex<SaveDirState>>>(Batch::D1)?,
        }))
    }
}

/// `app.getPath(name)` by Electron's names
pub struct Paths<'a>(pub &'a dyn AppPaths);

impl PathProvider for Paths<'_> {
    fn get_path(&self, name: &str) -> Result<String, Thrown> {
        let name = match name {
            "home" => PathName::Home,
            "appData" => PathName::AppData,
            "userData" => PathName::UserData,
            "temp" => PathName::Temp,
            "exe" => PathName::Exe,
            "desktop" => PathName::Desktop,
            "documents" => PathName::Documents,
            "downloads" => PathName::Downloads,
            "logs" => PathName::Logs,
            other => return Err(Thrown(format!("Failed to get '{other}' path"))),
        };
        Ok(path_string(self.0.path(name)))
    }
}

pub fn path_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

/// Electron's `dialog` for `main-core`: the options object it builds
/// becomes the shell's [`FileDialog`], the answer the `{canceled, filePaths}`
/// or `{canceled, filePath}` object Electron resolves with
pub struct HostDialog<'a>(pub &'a dyn Dialogs);

impl Dialog for HostDialog<'_> {
    type Window = WindowId;

    fn show_open_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.0.open(parent.copied(), &file_dialog(options));
        let paths = picked.unwrap_or_default();
        let mut answer = JsObject::new();
        answer.set("canceled", JsonValue::Bool(paths.is_empty()));
        answer.set(
            "filePaths",
            JsonValue::Array(
                paths
                    .into_iter()
                    .map(|p| JsonValue::String(path_string(p)))
                    .collect(),
            ),
        );
        JsonValue::Object(answer)
    }

    fn show_save_dialog(
        &mut self,
        parent: Option<&WindowId>,
        options: &JsObject<JsonValue>,
    ) -> JsonValue {
        let picked = self.0.save(parent.copied(), &file_dialog(options));
        let mut answer = JsObject::new();
        answer.set("canceled", JsonValue::Bool(picked.is_none()));
        if let Some(path) = picked {
            answer.set("filePath", JsonValue::String(path_string(path)));
        }
        JsonValue::Object(answer)
    }
}

fn text(options: &JsObject<JsonValue>, key: &str) -> Option<String> {
    match options.get(key) {
        Some(JsonValue::String(value)) => Some(value.clone()),
        _ => None,
    }
}

fn strings(value: Option<&JsonValue>) -> Vec<String> {
    match value {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsonValue::String(text) => Some(text.clone()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// The fields of Electron's dialog options the shell's dialog reads
pub fn file_dialog(options: &JsObject<JsonValue>) -> FileDialog {
    let filters = match options.get("filters") {
        Some(JsonValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsonValue::Object(filter) => Some(FileFilter {
                    name: text(filter, "name").unwrap_or_default(),
                    extensions: strings(filter.get("extensions")),
                }),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    FileDialog {
        title: text(options, "title"),
        default_path: text(options, "defaultPath").map(PathBuf::from),
        button_label: text(options, "buttonLabel"),
        filters,
        properties: strings(options.get("properties")),
    }
}
