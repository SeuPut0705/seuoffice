//! What the shell entry (`apps/shell/src/main/index.ts`) hands
//! `registerDriveIpc` as `DriveIpcDeps`: the tabs, the document parser, the
//! stored AI settings and the language. The entry is shared and nobody ports
//! it whole, so the module reaches these through [`DriveShell`].

use std::path::Path;
use std::sync::Arc;

use jscompat::JsonValue;
use main_core::packages::i18n::Lang;

/// What `ParseToText` answers: `{ ok, kind?, text? }`
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParsedText {
    pub ok: bool,
    pub kind: Option<String>,
    pub text: Option<String>,
}

/// Stops a folder watch
pub type StopWatch = Box<dyn FnOnce() + Send>;

/// `DriveIpcDeps` of drive-ipc.ts, and the folder watch of drive-files.ts
pub trait DriveShell: Send + Sync {
    /// `deps.lang()`. Runs on the core thread.
    fn lang(&self) -> Lang;
    /// `deps.openPath(path)`: a Drive copy opens like any local file
    /// (`routeDocumentPath`). Runs on the core thread.
    fn open_path(&self, path: &str) -> bool;
    /// `deps.isOpen(path)`: a tab shows this file. Runs on the core thread.
    fn is_open(&self, path: &str) -> bool;
    /// `readStoredAiSettings()`, from which `deps.freeAi()` is decided.
    /// Runs on the core thread.
    fn stored_ai_settings(&self) -> JsonValue;
    /// `deps.documentOf(webContentsId)`: the file of the document tab a
    /// webContents shows, if any. Runs on the core thread.
    fn document_of(&self, web_contents_id: f64) -> Option<String>;
    /// `deps.parse(path)` (`parseFileToText`). Runs on a worker.
    fn parse_file_to_text(&self, path: &Path) -> ParsedText;
    /// `watch(dir, { recursive: true }, ...)` of `node:fs`: `on_change` gets
    /// the path of each changed file, from any thread. Runs on the core
    /// thread. The returned function closes the watch.
    fn watch(&self, dir: &Path, on_change: Arc<dyn Fn(&Path) + Send + Sync>) -> StopWatch;
}

pub type DriveShellHost = Arc<dyn DriveShell>;
