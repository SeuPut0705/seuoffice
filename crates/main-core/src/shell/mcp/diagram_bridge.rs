//! `apps/shell/src/main/mcp/diagram-bridge.ts`: the shell's implementation of
//! the diagram tools' control: the open-document list plus the diagram
//! editor's own questions (`apps/diagram`'s `mcp-queries.ts`), addressed by
//! the tab's webContents. A restored tab that is not loaded yet is loaded
//! first (`webContentsFor`), as for open_documents.
//!
//! Every method answers a [`ToolStep`]: what the TypeScript awaits of a
//! renderer is a [`ToolStep::Await`]: `DiagramBridgeDeps.list []`,
//! `webContentsFor [tabId]` (answers the webContents id, or nothing),
//! `readPage [wc, page]` and `applyOps [wc, ops]`; a tab travels as `{ id,
//! kind, title, filePath?, active, dirty }`. What is sync in the shell stays a
//! method of [`DiagramBridgeSync`]. [`DiagramBridge`] is what answers the
//! `DiagramControl` calls of the diagram tools.

use std::rc::Rc;

use jscompat::JsonValue;

use super::tools::sheets_tools::ask;
use crate::shell::mcp::mcp_server::ToolStep;
use crate::shell::tab_manager::OpenDocumentTab;

/// What the bridge asks of the shell synchronously.
pub trait DiagramBridgeSync {
    /// `contents.isDestroyed()` of the webContents with this id
    fn is_destroyed(&self, wc_id: i64) -> bool;
    /// `isDetached?`: true for a document in a detached window; `None` is a
    /// shell without the dep
    fn is_detached(&self, _tab_id: &str) -> Option<bool> {
        None
    }
    /// `activate?`: switch to the tab, so the user sees the diagram the agent
    /// is about to change. A shell without the dep does nothing.
    fn activate(&self, _tab_id: &str) -> Result<(), String> {
        Ok(())
    }
    /// `revealWindow?`: bring the window hosting the tab forward
    fn reveal_window(&self, _tab_id: &str) -> Result<(), String> {
        Ok(())
    }
    /// `console.warn(message, error)`, `error` being the message of the error
    fn warn(&self, message: &str, error: &str);
}

/// `createDiagramControl(deps)`
pub struct DiagramBridge<'h> {
    sync: Rc<dyn DiagramBridgeSync + 'h>,
}

/// `createDiagramControl(deps)`
pub fn create_diagram_control<'h>(sync: Rc<dyn DiagramBridgeSync + 'h>) -> DiagramBridge<'h> {
    DiagramBridge { sync }
}

impl<'h> DiagramBridge<'h> {
    /// `contentsOf(tab)` as a step: the webContents id
    fn contents_of(
        &self,
        tab: &OpenDocumentTab,
        then: impl FnOnce(i64) -> ToolStep<'h> + 'h,
    ) -> ToolStep<'h> {
        let (sync, title) = (Rc::clone(&self.sync), tab.title.clone());
        ask(
            "DiagramBridgeDeps",
            "webContentsFor",
            vec![JsonValue::String(tab.id.clone())],
            move |settled| match settled {
                Err(message) => ToolStep::Done(Err(message)),
                Ok(Some(JsonValue::Number(wc))) if !sync.is_destroyed(wc as i64) => then(wc as i64),
                Ok(_) => ToolStep::Done(Err(format!("\"{title}\" is no longer open"))),
            },
        )
    }

    /// `list`: every open document
    pub fn list(&self) -> ToolStep<'h> {
        ask("DiagramBridgeDeps", "list", vec![], ToolStep::Done)
    }

    /// `isDetached`
    pub fn is_detached(&self, tab_id: &str) -> Option<bool> {
        self.sync.is_detached(tab_id)
    }

    /// `read(tab, page)`: `{ text, pages?, page? }`
    pub fn read(&self, tab: &OpenDocumentTab, page: Option<&str>) -> ToolStep<'h> {
        let page = page.map_or(JsonValue::Null, |page| JsonValue::String(page.to_owned()));
        self.contents_of(tab, move |wc| {
            ask(
                "DiagramBridgeDeps",
                "readPage",
                vec![JsonValue::Number(wc as f64), page],
                ToolStep::Done,
            )
        })
    }

    /// `apply(tab, ops)`
    pub fn apply(&self, tab: &OpenDocumentTab, ops: Vec<JsonValue>) -> ToolStep<'h> {
        let (sync, shown) = (Rc::clone(&self.sync), tab.clone());
        self.contents_of(tab, move |wc| {
            if !shown.active {
                // Showing the tab is a courtesy, not part of the edit: a UI failure here
                // must not fail the change the caller asked for.
                let result = sync
                    .activate(&shown.id)
                    .and_then(|()| sync.reveal_window(&shown.id));
                if let Err(error) = result {
                    sync.warn("[mcp] could not bring the diagram into view:", &error);
                }
            }
            ask(
                "DiagramBridgeDeps",
                "applyOps",
                vec![JsonValue::Number(wc as f64), JsonValue::Array(ops)],
                ToolStep::Done,
            )
        })
    }
}
