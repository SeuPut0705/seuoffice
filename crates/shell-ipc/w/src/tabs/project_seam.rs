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

/// What the shell's other seams ask of the tab strip about one view: document
/// links (`linkedDocumentForWebContents`, `linkMenuKind`) and the crash prompt
/// (`documentOf`, `closeDocument` of `startCrashWatch`). Each mirrors a
/// function of `apps/shell/src/main/index.ts`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewDetails {
    pub kind: TabKind,
    pub title: String,
    pub file_path: Option<String>,
    /// the tab's id in the strip, or the detached window's (`detached-<id>`)
    pub tab_id: Option<String>,
}

impl TabsState {
    /// `tabManager?.describeWebContents(id) ?? detachedDocumentFor(id)`, with
    /// the id each has: what `documentOf` and `untitledCopyOf` read
    pub fn details_of(&self, view: ViewId) -> Option<ViewDetails> {
        let wc = i64::from(view.0);
        let mut g = self.inner.borrow_mut();
        let Inner {
            manager,
            detached,
            bridge,
            ..
        } = &mut *g;
        if let Some(manager) = manager.as_ref() {
            let host = &mut *bridge as &mut dyn TabHost<ViewId>;
            if let Some((kind, title, file_path)) = manager.describe_web_contents(host, wc) {
                let tab_id = manager.tab_id_for_web_contents(host, wc);
                return Some(ViewDetails {
                    kind,
                    title,
                    file_path,
                    tab_id,
                });
            }
        }
        detached
            .detached_document_for(bridge, wc)
            .map(|doc| ViewDetails {
                kind: doc.kind,
                title: doc.title,
                file_path: doc.file_path,
                tab_id: Some(doc.id),
            })
    }

    /// `linkedDocumentForWebContents`: the title and file of the document
    /// `view` renders as a shell tab, or as the focused detached window
    pub fn linked_document(&self, view: ViewId) -> Option<(String, Option<String>)> {
        let wc = i64::from(view.0);
        let mut g = self.inner.borrow_mut();
        let Inner {
            manager,
            detached,
            bridge,
            ..
        } = &mut *g;
        if let Some((_, title, file_path)) = manager
            .as_ref()
            .and_then(|m| m.describe_web_contents(&mut *bridge as &mut dyn TabHost<ViewId>, wc))
        {
            return Some((title, file_path));
        }
        let focused = detached.focused_detached_tab(bridge)?;
        if focused.view != view {
            return None;
        }
        detached
            .detached_document_for(bridge, wc)
            .map(|doc| (doc.title, focused.file_path))
    }

    /// `linkMenuKind`: whose menu is the application menu, the focused
    /// detached window's kind, else the active tab's (a Present tab shows the
    /// Home menu)
    pub fn menu_kind(&self) -> Option<TabKind> {
        let mut g = self.inner.borrow_mut();
        let Inner {
            manager,
            detached,
            bridge,
            ..
        } = &mut *g;
        if let Some(kind) = detached.focused_detached_kind(bridge) {
            return Some(kind);
        }
        let manager = manager.as_ref()?;
        let active = manager.list().into_iter().find(|t| t.active)?;
        if active.kind == TabKind::Html && manager.active_tab_of_kind(TabKind::Html).is_none() {
            return Some(TabKind::Home);
        }
        Some(active.kind)
    }

    /// `tabManager?.tabIdForWebContents(view)`
    pub fn tab_id_for(&self, view: ViewId) -> Option<String> {
        let mut g = self.inner.borrow_mut();
        let Inner {
            manager, bridge, ..
        } = &mut *g;
        manager.as_ref().and_then(|m| {
            m.tab_id_for_web_contents(&mut *bridge as &mut dyn TabHost<ViewId>, i64::from(view.0))
        })
    }

    /// The `closeDocument` of the crash watch: the tab or the detached window
    /// of `view` closes without the unsaved-changes prompt. `false` when
    /// there is none, or a memo editor's text would be lost.
    pub fn close_document_without_prompt(&self, view: ViewId) -> bool {
        let Some(details) = self.details_of(view) else {
            return false;
        };
        let Some(id) = details.tab_id else {
            return false;
        };
        let mut g = self.inner.borrow_mut();
        let Inner {
            detached, bridge, ..
        } = &mut *g;
        if detached.is_detached_tab_id(bridge, &id) {
            let closed = detached.close_detached_without_prompt(bridge, &id);
            g.drain();
            return closed;
        }
        g.manager_call(|m, b| m.close_tab_without_prompt(b, &id))
            .unwrap_or(false)
    }
}
