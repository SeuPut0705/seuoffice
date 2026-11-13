//! Hosts: what a handler reaches beyond [`crate::runtime::Services`].
//!
//! Two kinds, both carried in one typed map ([`Hosts`]):
//!
//! - shared hosts, defined here because several batches call them (dialogs,
//!   the OS shell, the clipboard, a view's web contents). Batch W implements
//!   them in the shell; ipc-probe inserts fakes.
//! - batch hosts, defined in the batch's own crate (M's menus and theme, U's
//!   updater, A's secrets, D2's engines that are not in Rust yet). The batch
//!   that owns the area implements them in its host file in `crates/shell`.
//!
//! The shell inserts every host before it registers the batches. A batch's
//! `register` takes what it needs with [`Hosts::need`], so a shell built
//! without a host refuses to start (`RegisterError::MissingHost`), the same
//! way it refuses an unregistered channel.

use std::any::{Any, TypeId, type_name};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::channels::Batch;
use crate::ids::{ViewId, WindowId};
use crate::ipc::RegisterError;
use crate::value::IpcValue;

/// Hosts by type. Insert `Arc<dyn Trait>`; read it back by the same type.
#[derive(Default)]
pub struct Hosts(HashMap<TypeId, Box<dyn Any + Send + Sync>>);

impl Hosts {
    pub fn insert<T: Any + Send + Sync>(&mut self, host: T) {
        self.0.insert(TypeId::of::<T>(), Box::new(host));
    }

    pub fn get<T: Any + Send + Sync>(&self) -> Option<&T> {
        self.0
            .get(&TypeId::of::<T>())
            .and_then(|h| h.downcast_ref())
    }

    /// The host batch `by` needs, or the error that stops the shell
    pub fn need<T: Any + Send + Sync + Clone>(&self, by: Batch) -> Result<T, RegisterError> {
        self.get::<T>().cloned().ok_or(RegisterError::MissingHost {
            batch: by,
            host: type_name::<T>(),
        })
    }
}

/// Electron's `dialog` filter
#[derive(Clone, Debug, PartialEq)]
pub struct FileFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

/// Electron's open and save dialog options, the fields the handlers pass
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FileDialog {
    pub title: Option<String>,
    pub default_path: Option<PathBuf>,
    pub button_label: Option<String>,
    pub filters: Vec<FileFilter>,
    /// `properties` as Electron spells them (openFile, multiSelections, …)
    pub properties: Vec<String>,
}

/// Electron's message box options and answer
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MessageBox {
    pub kind: Option<String>,
    pub title: Option<String>,
    pub message: String,
    pub detail: Option<String>,
    pub buttons: Vec<String>,
    pub default_id: Option<usize>,
    pub cancel_id: Option<usize>,
    pub checkbox_label: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MessageBoxAnswer {
    pub response: usize,
    pub checkbox_checked: bool,
}

/// `dialog.*`. Runs on the UI thread through `run_on`; `parent` makes it
/// modal to that window as Electron's `BrowserWindow` argument did.
pub trait Dialogs: Send + Sync {
    /// `None` when cancelled
    fn open(&self, parent: Option<WindowId>, options: &FileDialog) -> Option<Vec<PathBuf>>;
    fn save(&self, parent: Option<WindowId>, options: &FileDialog) -> Option<PathBuf>;
    fn message(&self, parent: Option<WindowId>, options: &MessageBox) -> MessageBoxAnswer;
    fn error(&self, title: &str, content: &str);
}

/// `shell.*`: hand a path or URL to the OS
pub trait OsShell: Send + Sync {
    fn open_external(&self, url: &str) -> Result<(), String>;
    /// `""` on success, else the OS's message, as Electron's `openPath`
    fn open_path(&self, path: &std::path::Path) -> String;
    fn show_item_in_folder(&self, path: &std::path::Path);
    fn trash_item(&self, path: &std::path::Path) -> Result<(), String>;
}

/// `clipboard.*`, the formats the handlers use
pub trait Clipboard: Send + Sync {
    fn read_text(&self) -> String;
    fn write_text(&self, text: &str);
    fn read_html(&self) -> String;
    fn write_html(&self, html: &str, text: Option<&str>);
    /// PNG bytes, empty when there is no image
    fn read_image_png(&self) -> Vec<u8>;
    fn write_image_png(&self, png: &[u8]);
    fn available_formats(&self) -> Vec<String>;
}

/// `webContents` of a view, the operations handlers ask of the sender or
/// of another view
pub trait Contents: Send + Sync {
    fn window_of(&self, view: ViewId) -> Option<WindowId>;
    /// PNG of the visible page (`capturePage`)
    fn capture_png(&self, view: ViewId) -> Result<Vec<u8>, String>;
    /// `printToPDF` with Electron's options as passed
    fn print_to_pdf(&self, view: ViewId, options: IpcValue) -> Result<Vec<u8>, String>;
    fn print(&self, view: ViewId, options: IpcValue) -> Result<bool, String>;
    fn zoom_factor(&self, view: ViewId) -> f64;
    fn set_zoom_factor(&self, view: ViewId, factor: f64);
    fn focus(&self, view: ViewId);
    fn close_window(&self, window: WindowId);
}

/// The shared hosts as they sit in [`Hosts`]
pub type DialogsHost = Arc<dyn Dialogs>;
pub type OsShellHost = Arc<dyn OsShell>;
pub type ClipboardHost = Arc<dyn Clipboard>;
pub type ContentsHost = Arc<dyn Contents>;
