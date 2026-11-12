//! `apps/shell/src/main/tab-menu.ts`: the right-click menu of a document tab.
//!
//! The TypeScript's `click` closures become [`MenuClick`], the call the entry
//! makes on `TabMenuActions`; the Electron side runs it.

use jscompat::node_path::host::extname;
use jscompat::slice_utf16;

/// `TabSummary` of `shared/tabs-api.ts`
#[derive(Debug, Clone, PartialEq)]
pub struct TabSummary {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub closable: bool,
    pub active: bool,
    /// absolute path behind the tab; `None` while the document is untitled
    pub file_path: Option<String>,
}

/// The call a menu entry makes on `TabMenuActions` when it is clicked.
#[derive(Debug, Clone, PartialEq)]
pub enum MenuClick {
    Save(String),
    SaveAs(String),
    Print(String),
    OpenInNewWindow(String),
    SplitBeside(String),
    Rename(String),
    Duplicate(String),
    CopyText(String),
    Reveal(String),
    OpenDefault(String),
    Move(String, i64),
    CloseTabs(Vec<String>),
    ReopenClosed,
}

/// One `MenuItemConstructorOptions` the template holds.
#[derive(Debug, Clone, PartialEq)]
pub struct MenuItem {
    pub id: Option<&'static str>,
    pub label: Option<String>,
    pub enabled: Option<bool>,
    /// `type`: only `"separator"` is used
    pub item_type: Option<&'static str>,
    pub click: Option<MenuClick>,
}

impl MenuItem {
    fn separator() -> MenuItem {
        MenuItem {
            id: None,
            label: None,
            enabled: None,
            item_type: Some("separator"),
            click: None,
        }
    }

    fn entry(id: &'static str, label: String, enabled: bool, click: MenuClick) -> MenuItem {
        MenuItem {
            id: Some(id),
            label: Some(label),
            enabled: Some(enabled),
            item_type: None,
            click: Some(click),
        }
    }
}

/// `TabMenuInput`
pub struct TabMenuInput<'a> {
    pub tab: &'a TabSummary,
    /// every tab in strip order, Home first
    pub tabs: &'a [TabSummary],
    pub can_detach: bool,
    /// the file behind the tab is still on disk
    pub file_exists: bool,
    /// something was closed that can be opened again
    pub can_reopen: bool,
    /// `tm(key)`: the translation of a `TabMenuStringKey`
    pub tm: &'a dyn Fn(&str) -> String,
}

/// `PROGRAM_EXTENSIONS`: executable, script, shortcut, and launcher
/// extensions that should not be launched via the default app.
const PROGRAM_EXTENSIONS: &[&str] = &[
    // Windows executables, scripts, shortcuts, and installers
    ".exe",
    ".com",
    ".scr",
    ".msi",
    ".bat",
    ".cmd",
    ".ps1",
    ".vbs",
    ".vbe",
    ".js",
    ".jse",
    ".wsf",
    ".hta",
    ".lnk",
    ".url",
    ".reg",
    ".cpl",
    ".pif",
    ".gadget",
    ".msc",
    ".inf",
    ".ins",
    ".isp",
    // macOS applications, scripts, workflows, and packages
    ".app",
    ".command",
    ".action",
    ".workflow",
    ".scpt",
    ".applescript",
    ".terminal",
    ".pkg",
    ".mpkg",
    // Linux launchers, binaries, and shell scripts
    ".desktop",
    ".sh",
    ".bash",
    ".zsh",
    ".csh",
    ".ksh",
    ".bin",
    ".run",
    ".out",
    // Java archives
    ".jar",
];

/// `isProgramFile`
pub fn is_program_file(path: &str) -> bool {
    let ext = extname(path).to_lowercase();
    PROGRAM_EXTENSIONS.contains(&ext.as_str())
}

/// `baseName`: `path.split(/[\\/]/).pop() ?? path`
pub fn base_name(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).to_owned()
}

const PATH_LABEL_MAX: usize = 80;

/// `pathLabel`: a path short enough for a menu line; a long one keeps its
/// start and its end with an ellipsis between. Lengths count UTF-16 code units.
pub fn path_label(path: &str) -> String {
    let length = path.encode_utf16().count();
    if length <= PATH_LABEL_MAX {
        return path.to_owned();
    }
    let keep_end = ((PATH_LABEL_MAX - 1) as f64 * 0.65).floor() as usize;
    let keep_start = PATH_LABEL_MAX - 1 - keep_end;
    format!(
        "{}\u{2026}{}",
        slice_utf16(path, 0.0, Some(keep_start as f64)),
        slice_utf16(path, (length - keep_end) as f64, None)
    )
}

/// `tabMenuTemplate`
pub fn tab_menu_template(input: &TabMenuInput) -> Vec<MenuItem> {
    let TabMenuInput {
        tab,
        tabs,
        tm,
        can_detach,
        can_reopen,
        ..
    } = input;
    // `findIndex`: -1 when the tab is not in the list
    let index: i64 = tabs
        .iter()
        .position(|other| other.id == tab.id)
        .map_or(-1, |at| at as i64);
    // `!!file`: an empty path is no file
    let file = tab.file_path.as_deref().filter(|path| !path.is_empty());
    let on_disk = file.is_some() && input.file_exists;
    let closable = |other: &TabSummary| other.id != "home" && other.closable;
    let others: Vec<String> = tabs
        .iter()
        .filter(|other| other.id != tab.id && closable(other))
        .map(|other| other.id.clone())
        .collect();
    // `tabs.slice(index + 1)`
    let right: Vec<String> = tabs
        .iter()
        .skip((index + 1) as usize)
        .filter(|other| closable(other))
        .map(|other| other.id.clone())
        .collect();
    let everything: Vec<String> = tabs
        .iter()
        .filter(|other| closable(other))
        .map(|other| other.id.clone())
        .collect();
    let document = *can_detach && tab.kind != "home" && tab.kind != "help";
    let id = || tab.id.clone();
    let file_text = || file.unwrap_or_default().to_owned();

    let mut template = Vec::new();
    // where the file is, at a glance
    if let Some(file) = file {
        template.push(MenuItem {
            id: None,
            label: Some(path_label(file)),
            enabled: Some(false),
            item_type: None,
            click: None,
        });
        template.push(MenuItem::separator());
    }
    template.push(MenuItem::entry(
        "save",
        tm("menuTabSave"),
        document,
        MenuClick::Save(id()),
    ));
    template.push(MenuItem::entry(
        "saveAs",
        tm("menuTabSaveAs"),
        document,
        MenuClick::SaveAs(id()),
    ));
    template.push(MenuItem::entry(
        "print",
        tm("menuTabPrint"),
        document,
        MenuClick::Print(id()),
    ));
    template.push(MenuItem::separator());
    template.push(MenuItem::entry(
        "rename",
        tm("menuTabRename"),
        file.is_some(),
        MenuClick::Rename(id()),
    ));
    template.push(MenuItem::entry(
        "duplicate",
        tm("menuTabDuplicate"),
        on_disk,
        MenuClick::Duplicate(file_text()),
    ));
    template.push(MenuItem::separator());
    template.push(MenuItem::entry(
        "splitBeside",
        tm("menuTabSplitBeside"),
        *can_detach,
        MenuClick::SplitBeside(id()),
    ));
    template.push(MenuItem::entry(
        "openInNewWindow",
        tm("menuOpenInNewWindow"),
        *can_detach,
        MenuClick::OpenInNewWindow(id()),
    ));
    template.push(MenuItem::separator());
    template.push(MenuItem::entry(
        "copyPath",
        tm("menuTabCopyPath"),
        file.is_some(),
        MenuClick::CopyText(file_text()),
    ));
    template.push(MenuItem::entry(
        "copyName",
        tm("menuTabCopyName"),
        file.is_some(),
        MenuClick::CopyText(base_name(&file_text())),
    ));
    template.push(MenuItem::entry(
        "reveal",
        tm("menuTabReveal"),
        on_disk,
        MenuClick::Reveal(file_text()),
    ));
    template.push(MenuItem::entry(
        "openDefault",
        tm("menuTabOpenDefault"),
        on_disk && !is_program_file(&file_text()),
        MenuClick::OpenDefault(file_text()),
    ));
    template.push(MenuItem::separator());
    template.push(MenuItem::entry(
        "moveLeft",
        tm("menuTabMoveLeft"),
        index > 1,
        MenuClick::Move(id(), index - 1),
    ));
    template.push(MenuItem::entry(
        "moveRight",
        tm("menuTabMoveRight"),
        index >= 1 && index < tabs.len() as i64 - 1,
        MenuClick::Move(id(), index + 1),
    ));
    template.push(MenuItem::separator());
    template.push(MenuItem::entry(
        "close",
        tm("menuClose"),
        closable(tab),
        MenuClick::CloseTabs(vec![id()]),
    ));
    template.push(MenuItem::entry(
        "closeOthers",
        tm("menuTabCloseOthers"),
        !others.is_empty(),
        MenuClick::CloseTabs(others),
    ));
    template.push(MenuItem::entry(
        "closeRight",
        tm("menuTabCloseRight"),
        !right.is_empty(),
        MenuClick::CloseTabs(right),
    ));
    template.push(MenuItem::entry(
        "closeAll",
        tm("menuTabCloseAll"),
        !everything.is_empty(),
        MenuClick::CloseTabs(everything),
    ));
    template.push(MenuItem::separator());
    template.push(MenuItem::entry(
        "reopen",
        tm("menuTabReopen"),
        *can_reopen,
        MenuClick::ReopenClosed,
    ));
    template
}
