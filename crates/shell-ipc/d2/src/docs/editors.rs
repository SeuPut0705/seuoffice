//! What other areas call on the Word editor: [`DocumentEditors`] for the
//! tabs, menus and MCP, and the functions `docs-main.ts` exported to the
//! shell (the first-document queues, teardown, crash recovery's contract,
//! the MCP write grant, the headless export), public for the shell.

use std::path::{Path, PathBuf};
use std::rc::Rc;

use main_core::packages::electron_utils::recovery_contract::RecoveryOpenDecision;
use main_core::packages::electron_utils::recovery_store::{
    RecoveryIdentity, RecoveryUntitledIdentity,
};
use shell_contract::editors::{DocumentEditors, SaveMode, Then};
use shell_contract::ipc::Target;
use shell_contract::{IpcValue, Surface, ViewId, WindowId};

use super::Docs;
use crate::kit;

/// The Word editor of every docs view
pub struct DocsEditors(pub(super) Rc<Docs>);

impl DocumentEditors for DocsEditors {
    fn owns(&self, view: ViewId) -> bool {
        self.0
            .services
            .views
            .sender_of(view)
            .is_some_and(|s| s.surface == Surface::Docs)
    }

    /// The shell's tab menu saved a Word tab with `menu:command 'save'` or
    /// `'save-as'` (tab-document-actions.ts): the renderer runs its own save
    /// flow and reports nothing back, so the answer is that the request went out.
    fn request_save(&self, view: ViewId, mode: SaveMode, then: Then<bool>) {
        let command = match mode {
            SaveMode::Save => "save",
            SaveMode::SaveAs => "save-as",
        };
        self.0.services.events.emit(
            Target::View(view),
            "menu:command",
            vec![IpcValue::String(command.into())],
        );
        then(Ok(true))
    }

    fn request_close(&self, view: ViewId, parent: Option<WindowId>, then: Then<bool>) {
        self.0
            .request_close(view, parent, Box::new(move |proceed| then(Ok(proceed))))
    }

    /// The Word editor had no `docsReadText`: MCP reads its text through
    /// the renderer bridge (`docs:mcp-command`, batch A)
    fn read_text(&self, _view: ViewId, then: Then<String>) {
        then(Err(kit::error(
            "the Word editor's text is read through its MCP bridge",
        )))
    }

    /// `authorizeMcpDocWrite(wcId, path)`: the write grant MCP's
    /// `save_session` gives before its bridge command makes the renderer
    /// call `docs:save-to`. The save itself is that command (batch A), so
    /// this answers that it was not saved here.
    fn save_to_path(&self, view: ViewId, path: PathBuf, then: Then<()>) {
        self.0.allow_doc_write(view, &path.to_string_lossy());
        then(Err(kit::error(
            "the Word editor saves through its MCP bridge",
        )))
    }

    fn file_renamed(&self, view: ViewId, old_path: &Path, new_path: &Path) {
        self.0.file_renamed(
            view,
            &old_path.to_string_lossy(),
            &new_path.to_string_lossy(),
        )
    }

    /// The File > Export menu: `sendCommand('export-<format>')`
    fn export_request(&self, view: ViewId, format: &str) {
        self.0.services.events.emit(
            Target::View(view),
            "menu:command",
            vec![IpcValue::String(format!("export-{format}"))],
        )
    }

    /// `openDocByWc.get(id)`
    fn document_path(&self, view: ViewId) -> Option<PathBuf> {
        self.0.open_doc.get(view).map(PathBuf::from)
    }

    /// `tornDownWcIds.has(id)`
    fn torn_down(&self, view: ViewId) -> bool {
        self.0.is_torn_down(view)
    }
}

impl DocsEditors {
    /// `markDocsNewBlank(wcId)`
    pub fn mark_new_blank(&self, view: ViewId) {
        self.0.new_blank.borrow_mut().insert(view);
    }

    /// `queueDocsCopy(wcId, { path, name })`
    pub fn queue_copy(&self, view: ViewId, path: String, name: String) {
        self.0.doc_copies.insert(view, (path, name));
    }

    /// `createDocsView(openPath)`'s queue: the tab's first document
    pub fn queue_open(&self, view: ViewId, path: String) {
        self.0.window_opens.insert(view, path);
    }

    /// `authorizeMcpDocWrite(wcId, filePath)`
    pub fn authorize_mcp_doc_write(&self, view: ViewId, path: &str) {
        self.0.allow_doc_write(view, path)
    }

    /// `teardownDocsRenderer(contents)`; `crashed` is `contents.isCrashed()`
    pub fn teardown(&self, view: ViewId, crashed: bool) {
        self.0.teardown(view, crashed)
    }

    /// `discardDocsRecovery(contents)`
    pub fn discard_recovery(&self, view: ViewId) {
        let open = self.0.open_doc.get(view);
        self.0.discard_tab_copies(view, open.as_deref())
    }

    /// `docsRecoveryIdentity(webContentsId)`
    pub fn recovery_identity(&self, view: ViewId) -> Option<RecoveryUntitledIdentity> {
        self.0.book.borrow().untitled_of(view)
    }

    /// `docsRecoveryEditor.writeCopiesNow`
    pub fn write_copies_now(&self, then: Box<dyn FnOnce()>) {
        self.0.write_copies_now(then)
    }

    /// `docsRecoveryEditor.openFileWithDecision`
    pub fn open_file_with_decision(
        &self,
        view: ViewId,
        path: String,
        decision: RecoveryOpenDecision,
    ) {
        self.0.open_file_with_decision(view, path, decision)
    }

    /// `docsRecoveryEditor.openUntitledCopy`
    pub fn open_untitled_copy(
        &self,
        view: ViewId,
        copy: RecoveryIdentity,
        title: String,
        save_as_default_path: Option<String>,
    ) {
        self.0
            .open_untitled_copy(view, copy, title, save_as_default_path)
    }

    /// `createAiDocument(request, ownerWebContentsId)` as other apps call it
    pub fn create_ai_document(
        &self,
        request: &IpcValue,
        owner: ViewId,
        then: Box<dyn FnOnce(IpcValue)>,
    ) {
        self.0.create_ai_document(request, owner, then)
    }

    /// `exportDocsHeadless` past its hidden window
    pub fn begin_headless_export(
        &self,
        view: ViewId,
        input: String,
        out_path: String,
        format: &str,
        timeout: std::time::Duration,
        then: Box<dyn FnOnce(Result<(), String>)>,
    ) {
        self.0
            .begin_headless_export(view, input, out_path, format, timeout, then)
    }
}
