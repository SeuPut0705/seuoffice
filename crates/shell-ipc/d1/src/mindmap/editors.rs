//! `DocumentEditors` of the mind map app: what tabs, menus and the MCP
//! server ask of a map view, each the exported function of `mindmap-main.ts`
//! and `mcp-queries.ts` it stands for.

use std::path::{Path, PathBuf};

use shell_contract::editors::{DocumentEditors, SaveMode, Then};
use shell_contract::{ViewId, WindowId};

use super::app::MindmapApp;
use crate::value::thrown;

pub(super) struct MindmapEditors(pub MindmapApp);

impl DocumentEditors for MindmapEditors {
    fn owns(&self, view: ViewId) -> bool {
        self.0.0.state.borrow().live.contains(&view)
    }

    /// `requestMindmapSave`
    fn request_save(&self, view: ViewId, mode: SaveMode, then: Then<bool>) {
        self.0
            .request_save(view, mode, Box::new(move |saved| then(Ok(saved))));
    }

    /// `requestMindmapClose`
    fn request_close(&self, view: ViewId, parent: Option<WindowId>, then: Then<bool>) {
        self.0
            .request_close(view, parent, Box::new(move |proceed| then(Ok(proceed))));
    }

    /// `mindmapReadOutline`: the map as outline text, unsaved edits included
    fn read_text(&self, view: ViewId, then: Then<String>) {
        self.0
            .read_outline(view, Box::new(move |outline| then(outline.map_err(thrown))));
    }

    /// `mindmapSaveToPath`
    fn save_to_path(&self, view: ViewId, path: PathBuf, then: Then<()>) {
        self.0.save_to_path(
            view,
            &path.to_string_lossy(),
            Box::new(move |saved| then(saved.map_err(thrown))),
        );
    }

    /// `mindmapFileRenamed`
    fn file_renamed(&self, view: ViewId, old_path: &Path, new_path: &Path) {
        self.0.file_renamed(
            view,
            &old_path.to_string_lossy(),
            &new_path.to_string_lossy(),
        );
    }

    /// `sendMindmapExportRequest`; `format` is png, svg, pdf or markdown
    fn export_request(&self, view: ViewId, format: &str) {
        self.0.send_export_request(view, format);
    }

    /// `mindmapFilePath`
    fn document_path(&self, view: ViewId) -> Option<PathBuf> {
        self.0.file_path(view).map(PathBuf::from)
    }
}
