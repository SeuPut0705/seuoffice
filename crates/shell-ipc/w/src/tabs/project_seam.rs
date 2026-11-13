//! What the project folder handlers (`crate::projects`) ask of the tab strip:
//! the document a view shows, the view of an open file and the window a dialog
//! about a view sits over. Each is a line or two of `index.ts`
//! (`projectWindowOf`, `openDocument`, `projectDialogParent`) over
//! main-core's `TabManager` and `DetachedWindows`.

use main_core::shell::tab_manager::{TabHost, TabKind};
use shell_contract::ids::{ViewId, WindowId};

use super::state::{Inner, TabsState};

/// The document a tab or a detached window shows
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewDocument {
    pub kind: TabKind,
    /// `None` for a document that was never saved
    pub file_path: Option<String>,
}

impl TabsState {
    /// `tabManager?.describeWebContents(id) ?? detachedDocumentFor(id)`: the
    /// document `view` renders, or `None` when it renders none
    pub fn document_of(&self, view: ViewId) -> Option<ViewDocument> {
        let wc = i64::from(view.0);
        let mut g = self.inner.borrow_mut();
        let Inner {
            manager,
            detached,
            bridge,
            ..
        } = &mut *g;
        if let Some((kind, _, file_path)) = manager
            .as_ref()
            .and_then(|m| m.describe_web_contents(&mut *bridge as &mut dyn TabHost<ViewId>, wc))
        {
            return Some(ViewDocument { kind, file_path });
        }
        detached
            .detached_document_for(bridge, wc)
            .map(|doc| ViewDocument {
                kind: doc.kind,
                file_path: doc.file_path,
            })
    }

    /// `tabManager?.findTabByPath(path) ?? findDetachedTabByPath(path)`: the
    /// view of the editor that shows this file (an unloaded tab for it is
    /// loaded first)
    pub fn view_of_file(&self, path: &str) -> Option<ViewId> {
        let mut g = self.inner.borrow_mut();
        if let Some(found) = g.manager_call(|m, b| {
            m.find_tab_by_path(b as &mut dyn TabHost<ViewId>, Some(path))
                .map(|tab| tab.view)
        }) && found.is_some()
        {
            return found;
        }
        let Inner {
            detached, bridge, ..
        } = &mut *g;
        detached
            .find_detached_tab_by_path(bridge, path)
            .map(|found| found.view)
    }

    /// `detachedWindowForWebContents(owner) ?? shellWindow`: the window a
    /// dialog about `view` sits over, `None` while there is no shell window
    pub fn dialog_parent(&self, view: ViewId) -> Option<WindowId> {
        let mut g = self.inner.borrow_mut();
        let Inner {
            detached, bridge, ..
        } = &mut *g;
        detached
            .detached_window_for_web_contents(bridge, i64::from(view.0))
            .or_else(|| bridge.shell.map(|shell| shell.window))
    }
}
