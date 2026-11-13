//! The diagram editor as the other areas call it ([`DocumentEditors`]): tabs
//! ask it to save before a close, menus to save or export, MCP to read or
//! save. Each call is the exported function of `diagram-main.ts` /
//! `mcp-queries.ts` of the same job.

use std::path::{Path, PathBuf};

use shell_contract::editors::{DocumentEditors, SaveMode, Then};
use shell_contract::{IpcError, ViewId, WindowId};

use super::DiagramViews;
use crate::host::path_string;
use crate::value::thrown;

pub(super) struct DiagramEditors(pub DiagramViews);

fn rejected(message: String) -> IpcError {
    thrown(message)
}

impl DocumentEditors for DiagramEditors {
    fn owns(&self, view: ViewId) -> bool {
        self.0
            .with_state(|state| state.views.get(&view).is_some_and(|v| v.tracked))
    }

    /// `requestDiagramSave(contents, mode)`
    fn request_save(&self, view: ViewId, mode: SaveMode, then: Then<bool>) {
        self.0
            .request_save(view, mode, Box::new(move |saved| then(Ok(saved))));
    }

    /// `requestDiagramClose(contents, parent)`
    fn request_close(&self, view: ViewId, parent: Option<WindowId>, then: Then<bool>) {
        self.0
            .request_close(view, parent, Box::new(move |close| then(Ok(close))));
    }

    /// `diagramReadText(contents)`: every page as the read table text
    fn read_text(&self, view: ViewId, then: Then<String>) {
        self.0
            .read_text(view, Box::new(move |text| then(text.map_err(rejected))));
    }

    /// `diagramSaveToPath(contents, filePath)`
    fn save_to_path(&self, view: ViewId, path: PathBuf, then: Then<()>) {
        self.0.save_to_path(
            view,
            &path_string(path),
            Box::new(move |saved| then(saved.map_err(rejected))),
        );
    }

    /// `diagramFileRenamed(contents, oldPath, newPath)`
    fn file_renamed(&self, view: ViewId, old_path: &Path, new_path: &Path) {
        self.0.file_renamed(
            view,
            &old_path.to_string_lossy(),
            &new_path.to_string_lossy(),
        );
    }

    /// `sendDiagramExportRequest(contents, format)`: `png`, `svg` or `pdf`
    fn export_request(&self, view: ViewId, format: &str) {
        self.0.send_export_request(view, format);
    }

    /// `diagramFilePath(webContentsId)`
    fn document_path(&self, view: ViewId) -> Option<PathBuf> {
        self.0.file_path(view).map(PathBuf::from)
    }
}
