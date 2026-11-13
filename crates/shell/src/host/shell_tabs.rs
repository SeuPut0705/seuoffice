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
use shell_contract::ids::ViewId;
use shell_contract::provided::Provided;
use shell_ipc_w::tabs::TabsState;

#[allow(dead_code)] // called by batch M's menu and print hosts
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
