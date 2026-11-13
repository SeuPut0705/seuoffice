//! What the TypeScript gets from the shell around the diagram editor: the
//! hooks `diagram-main.ts` lets the shell set (`setDiagram*Hook`, the
//! runtime's project folder functions), what `electron-utils` reads from the
//! process (the other panes' paths, the open-files list, headless mode) and
//! the hidden window that makes a PDF. The shell implements it and inserts it
//! into `Hosts` as a [`DiagramShellHost`].

use std::sync::Arc;

use main_core::diagram::print_document::PrintPage;
use shell_contract::ViewId;

pub trait DiagramShell: Send + Sync {
    /// `runtime.newDocumentDir(webContentsId)`: the project folder an untitled
    /// diagram's save dialog opens in
    fn new_document_dir(&self, view: ViewId) -> Option<String>;

    /// whether `runtime.writeNewDocument` is set (the shell has project folders)
    fn has_new_document_writer(&self) -> bool;

    /// `runtime.writeNewDocument(webContentsId, fileName, bytes)`: the path it
    /// wrote (`Ok(None)`: no project panel) or the error it threw; none when
    /// the hook is unset
    fn write_new_document(
        &self,
        view: ViewId,
        file_name: &str,
        bytes: &[u8],
    ) -> Option<Result<Option<String>, String>>;

    /// `setDiagramFileSavedHook`: a save landed on a new path
    fn file_saved(&self, view: ViewId, path: &str);

    /// `setDiagramRecoveryTitleHook`: the tab title of an untitled diagram
    fn recovery_title(&self, view: ViewId) -> Option<String>;

    /// `setDiagramHelpHook`: draw.io's Help was picked
    fn help(&self, view: ViewId);

    /// `setDiagramOpenFailedHook`: the tab's file did not open after all;
    /// true when the shell closed the tab and shows `message`
    fn open_failed(&self, view: ViewId, message: &str) -> bool;

    /// `setDiagramProvisionalTitleHook`: name an untitled diagram's tab
    fn provisional_title(&self, view: ViewId, title: &str);

    /// `isPathOpenElsewhere(path)` of `electron-utils`
    fn is_path_open_elsewhere(&self, path: &str) -> bool;

    /// `assertFileSaved(path)` of `electron-utils`: `Err` carries the message
    /// of the refusal (the file is open with unsaved changes)
    fn assert_file_saved(&self, path: &str) -> Result<(), String>;

    /// `isHeadlessMode()` of `electron-utils`
    fn is_headless(&self) -> bool;

    /// `randomBytes(16).toString('hex')` of `node:crypto`: a save target's
    /// token, 32 lower-case hex digits
    fn save_token(&self) -> String;

    /// `randomUUID()` of `node:crypto`: the id of a question to the renderer
    fn random_uuid(&self) -> String;

    /// `renderPdf(pages, title)` of `export-main.ts`: the hidden window of
    /// the diagram's session showing the print document, `printToPDF`. Called
    /// on a worker thread.
    fn render_pdf(&self, pages: &[PrintPage], title: &str) -> Result<Vec<u8>, String>;
}

pub type DiagramShellHost = Arc<dyn DiagramShell>;
