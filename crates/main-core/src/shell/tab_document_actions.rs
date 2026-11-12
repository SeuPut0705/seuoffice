//! `apps/shell/src/main/tab-document-actions.ts`.
//!
//! The WebContents the TypeScript passes around is the associated type
//! `Contents` of the deps: the shell hands over whatever stands for one.

use super::tab_menu::TabSummary;

/// `TabDocumentTarget`
pub struct TabDocumentTarget<C> {
    pub id: String,
    pub web_contents: C,
    pub file_path: Option<String>,
}

/// `TabDocumentActionDeps`. `mode` of the save methods is the TypeScript's
/// `'save' | 'saveAs'` string.
pub trait TabDocumentActionDeps {
    type Contents;

    /// `tabs.list()`
    fn list(&mut self) -> Vec<TabSummary>;
    /// `tabs.activateTab(id)`
    fn activate_tab(&mut self, id: &str);
    /// `tabs.canDetachTab(id)`
    fn can_detach_tab(&mut self, id: &str) -> bool;
    /// `tabs.webContentsForTab(id)`
    fn web_contents_for_tab(&mut self, id: &str) -> Option<Self::Contents>;
    /// `contents.isDestroyed()`
    fn is_destroyed(&mut self, contents: &Self::Contents) -> bool;
    /// `contents.send(channel, command)`
    fn send(&mut self, contents: &Self::Contents, channel: &str, command: &str);

    fn save_pdf(&mut self, contents: &Self::Contents);
    fn save_pdf_as(&mut self, target: TabDocumentTarget<Self::Contents>);
    fn print_pdf(&mut self, contents: &Self::Contents);
    fn save_markdown(&mut self, contents: &Self::Contents, mode: &str);
    fn print_markdown(&mut self, contents: &Self::Contents);
    fn save_html(&mut self, contents: &Self::Contents, mode: &str);
    fn print_html(&mut self, contents: &Self::Contents);
    fn save_mindmap(&mut self, contents: &Self::Contents, mode: &str);
    fn print_mindmap(&mut self, contents: &Self::Contents);
    fn save_hwp(&mut self, contents: &Self::Contents, mode: &str);
    fn print_hwp(&mut self, contents: &Self::Contents);
}

/// `runTabDocumentAction(deps, id, action)`: resolves the clicked tab, then
/// uses its editor's existing save and print workflows. `action` is
/// `'save' | 'saveAs' | 'print'`; any other string takes the `save` path
/// with itself as the command, as the TypeScript does.
pub fn run_tab_document_action<D>(deps: &mut D, id: &str, action: &str)
where
    D: TabDocumentActionDeps,
    D::Contents: Clone,
{
    let tab = deps.list().into_iter().find(|item| item.id == id);
    let contents = deps.web_contents_for_tab(id);
    let Some(tab) = tab else {
        return;
    };
    if tab.kind == "home" || tab.kind == "help" || !deps.can_detach_tab(id) {
        return;
    }
    let Some(contents) = contents else {
        return;
    };
    if deps.is_destroyed(&contents) {
        return;
    }
    deps.activate_tab(id);
    let command = if action == "saveAs" {
        "save-as"
    } else {
        action
    };
    match tab.kind.as_str() {
        "docs" => deps.send(&contents, "menu:command", command),
        "sheets" => deps.send(&contents, "menu:action", command),
        "slides" => deps.send(&contents, "slides:menu", command),
        "pdf" => {
            if action == "print" {
                deps.print_pdf(&contents);
            } else if action == "saveAs" {
                deps.save_pdf_as(TabDocumentTarget {
                    id: id.to_owned(),
                    web_contents: contents.clone(),
                    file_path: tab.file_path.clone(),
                });
            } else {
                deps.save_pdf(&contents);
            }
        }
        "markdown" => {
            if action == "print" {
                deps.print_markdown(&contents);
            } else {
                deps.save_markdown(&contents, action);
            }
        }
        "html" => {
            if action == "print" {
                deps.print_html(&contents);
            } else {
                deps.save_html(&contents, action);
            }
        }
        "mindmap" => {
            if action == "print" {
                deps.print_mindmap(&contents);
            } else {
                deps.save_mindmap(&contents, action);
            }
        }
        "hwp" => {
            if action == "print" {
                deps.print_hwp(&contents);
            } else {
                deps.save_hwp(&contents, action);
            }
        }
        _ => {}
    }
}
