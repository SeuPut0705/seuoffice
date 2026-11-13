//! What the application menu, the dock and the command line ask of the shell
//! window's tabs (`apps/shell/src/main/index.ts`): the seam batch M's
//! menu and print hosts call. Everything runs on the core thread, where the
//! tab state lives; none of it blocks on a renderer.
//!
//! The implementation is a thin layer over `shell_ipc_w::tabs::TabsState`,
//! which `tabs::register` adds to `Provided`. [`shell_tabs`] finds it there on
//! demand, so it does not matter in which order the batches registered.

use std::rc::Rc;

use main_core::shell::tab_manager::TabKind;
use shell_contract::ids::{ViewId, WindowId};
use shell_contract::provided::Provided;
use shell_ipc_w::tabs::TabsState;

/// The document behind a view, as the crash prompt reads it (`documentOf`,
/// `untitledCopyOf` of `startCrashWatch`): a tab of the strip or a detached window
#[allow(dead_code)] // read by batch U's crash host
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CrashedDocument {
    pub kind: TabKind,
    pub title: String,
    pub file_path: Option<String>,
    /// the tab's id, or the detached window's (`detached-<id>`)
    pub tab_id: Option<String>,
}

#[allow(dead_code)] // called by batch M's menu and print hosts and batch U's crash host
pub(crate) trait ShellTabs {
    /// `activeEditorTarget`: the focused detached window's view when it shows
    /// a document of `kind`, else the active tab's view when that tab is of
    /// `kind` (a Present tab is no html target)
    fn active_editor(&self, kind: TabKind) -> Option<ViewId>;
    /// `tabManager.openHomeTab()`
    fn open_home_tab(&self);
    /// `openFileViaDialog`: the File > Open dialog; each picked file opens
    /// through `open_path`
    fn open_file_via_dialog(&self);
    /// `openDocumentPath(path)`: Drive copies reopen through Drive, else the
    /// extension routes the file; `false` when nothing opened
    fn open_path(&self, path: &str) -> bool;
    /// `closeFocusedEditor`: a focused detached editor window closes (its
    /// unsaved-changes guard runs), otherwise the active tab does
    fn close_focused_editor(&self);
    /// `revealShellWindow`: un-minimize, show and focus the shell window,
    /// making it first when it was closed (macOS keeps running without it)
    fn reveal_shell_window(&self);
    /// `newDocTab`, `newSheetTab`, ... by home kind (`docx`, `xlsx`, `pptx`,
    /// `md`, `html`, `xmind`, `drawio`, `hwp`, `pdf`), as `home:new-*` does
    /// without a remembered folder; `false` for any other name
    fn new_document(&self, home_kind: &str) -> bool;
    /// `visibleHomeKinds(readHomeKinds())` without `pdfTools`, in home's order
    fn new_document_kinds(&self) -> Vec<String>;
    /// "Open in New Window" (Docs' New Window, Slides' Open in New Window): the
    /// shell's active tab of `kind` moves into a window of its own
    fn open_in_new_window(&self, kind: TabKind);
    /// `changeUiScale(APP_SETTINGS_PATH(), direction)`: 1 bigger, -1 smaller,
    /// 0 reset. Saved, stamped on every page, and the tab strip relaid out.
    fn change_ui_scale(&self, direction: i32);

    // ---- document links (batch M) ----
    /// `linkedDocumentForWebContents`: the title and file path of the document
    /// `view` shows as a shell tab, or as the focused detached window
    fn describe_view(&self, view: ViewId) -> Option<(String, Option<String>)>;
    /// `linkMenuKind`: the focused detached window's kind, else the active
    /// tab's (a Present html tab counts as Home)
    fn menu_kind(&self) -> Option<TabKind>;
    /// `tabManager.tabIdForWebContents(view)`
    fn tab_id_for(&self, view: ViewId) -> Option<String>;
    /// `detachedWindowForWebContents(view) ?? shellWindow`
    fn parent_window_for(&self, view: ViewId) -> Option<WindowId>;

    // ---- the crash prompt (batch U); reopening is `open_path` ----
    /// `webContents.reload()`; `false` when the view is gone
    fn reload_view(&self, view: ViewId) -> bool;
    /// `documentOf(wc)`: the document `view` shows, `None` for no document,
    /// Home and Help
    fn crashed_document(&self, view: ViewId) -> Option<CrashedDocument>;
    /// `closeDocument(wc)`: the tab or detached window of `view` closes
    /// without the unsaved-changes prompt; `false` when there is none
    fn close_document(&self, view: ViewId) -> bool;
}

struct OverTabs(Rc<TabsState>);

impl ShellTabs for OverTabs {
    fn active_editor(&self, kind: TabKind) -> Option<ViewId> {
        self.0.active_editor(kind)
    }

    fn open_home_tab(&self) {
        self.0.open_home_tab();
    }

    fn open_file_via_dialog(&self) {
        self.0.open_file_via_dialog();
    }

    fn open_path(&self, path: &str) -> bool {
        self.0.open_document_path(path)
    }

    fn close_focused_editor(&self) {
        self.0.close_focused_editor();
    }

    fn reveal_shell_window(&self) {
        self.0.reveal_shell_window();
    }

    fn new_document(&self, home_kind: &str) -> bool {
        self.0.new_document(home_kind)
    }

    fn new_document_kinds(&self) -> Vec<String> {
        self.0.visible_home_kinds()
    }

    fn open_in_new_window(&self, kind: TabKind) {
        self.0.open_active_in_new_window(kind);
    }

    fn describe_view(&self, view: ViewId) -> Option<(String, Option<String>)> {
        self.0.linked_document(view)
    }

    fn menu_kind(&self) -> Option<TabKind> {
        self.0.menu_kind()
    }

    fn tab_id_for(&self, view: ViewId) -> Option<String> {
        self.0.tab_id_for(view)
    }

    fn parent_window_for(&self, view: ViewId) -> Option<WindowId> {
        self.0.dialog_parent(view)
    }

    fn reload_view(&self, view: ViewId) -> bool {
        super::window::windows().is_some_and(|w| w.reload(view))
    }

    fn crashed_document(&self, view: ViewId) -> Option<CrashedDocument> {
        let d = self.0.details_of(view)?;
        if matches!(d.kind, TabKind::Home | TabKind::Help) {
            return None;
        }
        Some(CrashedDocument {
            kind: d.kind,
            title: d.title,
            file_path: d.file_path,
            tab_id: d.tab_id,
        })
    }

    fn close_document(&self, view: ViewId) -> bool {
        self.0.close_document_without_prompt(view)
    }

    fn change_ui_scale(&self, direction: i32) {
        let tabs = self.0.clone();
        crate::ui_scale::change(&self.0.settings_path(), direction, move |_| {
            // the strip moved, so the views below it move too
            tabs.relayout();
        });
    }
}

/// The shell's tabs, once the W batch has registered; on the core thread
#[allow(dead_code)] // called by batch M's menu and print hosts
pub(crate) fn shell_tabs(provided: &Provided) -> Option<Rc<dyn ShellTabs>> {
    let state = provided.all::<TabsState>().into_iter().next()?;
    Some(Rc::new(OverTabs(state)))
}
