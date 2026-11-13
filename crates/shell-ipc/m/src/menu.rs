//! The menu items that emit batch M's event channels, as values: which
//! label path of an editor's menu sends which event to the editor's view,
//! and what a click on a right-click menu entry does through IPC.
//!
//! `host/menu.rs` of the shell builds the real menus. For the items below it
//! asks [`app_menu_items`] what a click sends and [`click_app_menu`] does the
//! send. The item the user clicked is found by its label, so the labels
//! here are the ones the TypeScript menus show (the editors' own `tm`
//! dictionaries, and `appMenuLabels` for "Name with AI") in the language the
//! process holds.
//!
//! Ported (the clicks that send an M event, `Target::View` of the active
//! editor of the kind, which the shell resolves):
//!
//! - `docs`: every static item of `buildDocsMenu` that calls `sendCommand`
//!   (`menu:command`, `[command, payload]`, the payload `undefined` unless
//!   the item has one: the nine zoom percentages).
//! - `sheets`: the nine `sendMenuAction` items of `installApplicationMenu`
//!   (`menu:action`).
//! - `pdf`, `markdown`, `html`, `diagram`, `mindmap`: File > Print of the
//!   shell's menu (`<app>:print-request`, no arguments); `hwp`: File >
//!   Export as PDF (`hwp:print-request`, `'pdf'`).
//!
//! Left to `host/menu.rs`, because the click does something else than send an
//! M event: Open, Open Recent (`open-path` carries a path), New, New Window,
//! Close, Back to Home, Save and Save As of the shell-built menus, the
//! exports and conversions, Import PDF, hwp's Print and Print Preview
//! (`hwp:preview-request`), markdown's and html's export requests, the
//! settings item (`preferences` is on macOS the application menu's, on
//! other systems the Tools menu's), the roles (cut, copy, paste, window,
//! help) and the checkbox state of the View menu. `html:print-request` is
//! not sent for a tab that owns a presentation view (`presentOwnerByWc`):
//! the shell checks that before it asks for the click.
//!
//! A right-click menu entry is clicked with [`click_context_menu`]; the
//! commands that need the shell (copy image, save image, cut, copy, paste,
//! select all) are the host's.

use main_core::packages::electron_utils::app_menu::app_menu_labels;
use main_core::packages::electron_utils::context_menu::{
    ContextMenuParams, MenuEntry, context_menu_labels, context_menu_template,
};
use main_core::packages::i18n::Lang;
use shell_contract::ipc::Target;
use shell_contract::provided::Provided;
use shell_contract::runtime::{PathName, Services};
use shell_contract::{IpcValue, ViewId};

use crate::hosts::MHostRef;
use crate::spell::{context_menu_command, intercept_context_menu};
use crate::state::MStateRef;

/// What a menu item does through IPC
#[derive(Clone, Debug, PartialEq)]
pub enum MenuAction {
    /// `contents.send(channel, ...args)` on the active editor's view
    Event {
        channel: &'static str,
        args: Vec<IpcValue>,
    },
}

/// `(label path, action)` of every item of an editor's menu that sends an M event
pub type AppMenuItems = Vec<(Vec<String>, MenuAction)>;

const MENU_COMMAND: &str = "menu:command";
const MENU_ACTION: &str = "menu:action";

/// the keys of the shell's own menus (`tMain` in apps/shell/src/main/index.ts):
/// key, English, Korean
const SHELL_LABELS: &[(&str, &str, &str)] = &[
    ("menuFile", "File", "\u{D30C}\u{C77C}"),
    ("menuPrint", "Print\u{2026}", "\u{C778}\u{C1C4}\u{2026}"),
    (
        "menuExportPdf",
        "Export as PDF\u{2026}",
        "PDF\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    ("menuOpen", "Open\u{2026}", "\u{C5F4}\u{AE30}\u{2026}"),
    ("menuClose", "Close", "\u{B2EB}\u{AE30}"),
    ("menuView", "View", "\u{BCF4}\u{AE30}"),
    ("menuHelp", "Help", "\u{B3C4}\u{C6C0}\u{B9D0}"),
    (
        "menuUserGuide",
        "User Guide",
        "\u{C0AC}\u{C6A9}\u{C790} \u{AC00}\u{C774}\u{B4DC}",
    ),
    (
        "thirdPartyNotices",
        "Third-Party Notices",
        "\u{D0C0}\u{C0AC} \u{C18C}\u{D504}\u{D2B8}\u{C6E8}\u{C5B4} \u{ACE0}\u{C9C0}",
    ),
    (
        "backToHome",
        "Back to Home",
        "\u{D648}\u{C73C}\u{B85C} \u{B3CC}\u{C544}\u{AC00}\u{AE30}",
    ),
    ("menuSave", "Save", "\u{C800}\u{C7A5}"),
    (
        "menuSaveAs",
        "Save As\u{2026}",
        "\u{B2E4}\u{B978} \u{C774}\u{B984}\u{C73C}\u{B85C} \u{C800}\u{C7A5}\u{2026}",
    ),
    (
        "menuExportDocx",
        "Export as Word\u{2026}",
        "Word\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportOdt",
        "Export as ODT\u{2026}",
        "ODT\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportImages",
        "Export as Images\u{2026}",
        "\u{C774}\u{BBF8}\u{C9C0}\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportHtml",
        "Export as Single-File HTML\u{2026}",
        "\u{B2E8}\u{C77C} \u{D30C}\u{C77C} HTML\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuOpenInDocs",
        "Convert and Open in Docs",
        "Docs \u{BB38}\u{C11C}\u{B85C} \u{BCC0}\u{D658}\u{D558}\u{C5EC} \u{C5F4}\u{AE30}",
    ),
    (
        "menuExportMd",
        "Export as Markdown\u{2026}",
        "Markdown\u{C73C}\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportEpub",
        "Export as EPUB\u{2026}",
        "EPUB\u{C73C}\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuPreview",
        "Print Preview\u{2026}",
        "\u{BBF8}\u{B9AC} \u{BCF4}\u{AE30}\u{2026}",
    ),
    (
        "menuTranslateBook",
        "Translate Book\u{2026}",
        "\u{CC45} \u{BC88}\u{C5ED}\u{2026}",
    ),
    ("menuFind", "Find\u{2026}", "\u{CC3E}\u{AE30}\u{2026}"),
    (
        "menuReplace",
        "Replace\u{2026}",
        "\u{BC14}\u{AFB8}\u{AE30}\u{2026}",
    ),
    (
        "menuZoomFit",
        "Fit to Window",
        "\u{CC3D}\u{C5D0} \u{B9DE}\u{CD94}\u{AE30}",
    ),
    (
        "menuExportMapImage",
        "Export as Image (PNG)\u{2026}",
        "\u{C774}\u{BBF8}\u{C9C0}(PNG)\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportSvg",
        "Export as SVG\u{2026}",
        "SVG\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportMapSvg",
        "Export as Image (SVG)\u{2026}",
        "\u{C774}\u{BBF8}\u{C9C0}(SVG)\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportMapOutline",
        "Export as Markdown Outline\u{2026}",
        "\u{B9C8}\u{D06C}\u{B2E4}\u{C6B4} \u{AC1C}\u{C694}\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    ("menuHome", "Home", "\u{D648}"),
    // The titles AppKit gives the macOS application and Window menus' roles
    // (Electron's `role: 'services'` and the like were localized by the OS;
    // Tauri's predefined items are English unless given a title). `{app}` is
    // the application's name. These are not `tm` keys.
    ("roleServices", "Services", "\u{C11C}\u{BE44}\u{C2A4}"),
    ("roleHide", "Hide {app}", "{app} \u{AC00}\u{B9AC}\u{AE30}"),
    (
        "roleHideOthers",
        "Hide Others",
        "\u{B2E4}\u{B978} \u{D56D}\u{BAA9} \u{AC00}\u{B9AC}\u{AE30}",
    ),
    (
        "roleUnhide",
        "Show All",
        "\u{BAA8}\u{B450} \u{BCF4}\u{AE30}",
    ),
    ("roleQuit", "Quit {app}", "{app} \u{C885}\u{B8CC}"),
    ("roleZoom", "Zoom", "\u{D655}\u{B300}/\u{CD95}\u{C18C}"),
    (
        "roleFront",
        "Bring All to Front",
        "\u{BAA8}\u{B450} \u{C55E}\u{C73C}\u{B85C} \u{AC00}\u{C838}\u{C624}\u{AE30}",
    ),
    (
        "menuSectionNew",
        "New",
        "\u{C0C8}\u{B85C} \u{B9CC}\u{B4E4}\u{AE30}",
    ),
    (
        "menuMakeFromDocument",
        "Make Another Document from This",
        "\u{C774} \u{BB38}\u{C11C}\u{B85C} \u{B2E4}\u{B978} \u{BB38}\u{C11C} \u{B9CC}\u{B4E4}\u{AE30}",
    ),
    (
        "menuDocumentSources",
        "View Sources",
        "\u{C790}\u{B8CC} \u{BCF4}\u{AE30}",
    ),
    (
        "menuDerivedDocuments",
        "Documents Made from This",
        "\u{C774} \u{BB38}\u{C11C}\u{B85C} \u{B9CC}\u{B4E0} \u{BB38}\u{C11C}",
    ),
    ("menuNewDoc", "AI Docs", "AI Docs"),
    ("menuNewSheet", "AI Sheets", "AI Sheets"),
    ("menuNewSlide", "AI Slides", "AI Slides"),
    ("menuNewMarkdown", "AI Markdown", "AI Markdown"),
    ("menuNewHtml", "AI HTML", "AI HTML"),
    (
        "menuNewMindmap",
        "Mind Map",
        "\u{B9C8}\u{C778}\u{B4DC}\u{B9F5}",
    ),
    (
        "menuNewDiagram",
        "Diagram",
        "\u{B2E4}\u{C774}\u{C5B4}\u{ADF8}\u{B7A8}",
    ),
    ("menuNewHwp", "AI HWP", "AI \u{D55C}\u{AE00}"),
    ("menuNewPdf", "AI PDF", "AI PDF"),
    (
        "menuExportPptx",
        "Export as PowerPoint\u{2026}",
        "PowerPoint\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportXlsx",
        "Export as Excel\u{2026}",
        "Excel\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuImportPdf",
        "Import PDF\u{2026}",
        "PDF \u{AC00}\u{C838}\u{C624}\u{AE30}\u{2026}",
    ),
    ("menuUiZoomIn", "Interface Zoom In", "UI \u{D655}\u{B300}"),
    ("menuUiZoomOut", "Interface Zoom Out", "UI \u{CD95}\u{C18C}"),
    (
        "menuUiZoomReset",
        "Reset Interface Zoom",
        "UI \u{BC30}\u{C728}\u{C744} 100%\u{B85C} \u{B2E4}\u{C2DC} \u{C124}\u{C815}",
    ),
];

/// the keys `DOCS_COMMANDS` names, from `docs-main.ts`'s dictionary: key, English, Korean
const DOCS_LABELS: &[(&str, &str, &str)] = &[
    ("menuFile", "File", "\u{D30C}\u{C77C}"),
    ("menuNewDoc", "New Document", "\u{C0C8} \u{BB38}\u{C11C}"),
    ("menuOpen", "Open\u{2026}", "\u{C5F4}\u{AE30}\u{2026}"),
    ("menuSave", "Save", "\u{C800}\u{C7A5}"),
    (
        "menuSaveAs",
        "Save As\u{2026}",
        "\u{B2E4}\u{B978} \u{C774}\u{B984}\u{C73C}\u{B85C} \u{C800}\u{C7A5}\u{2026}",
    ),
    (
        "menuPageSetup",
        "Page Setup\u{2026}",
        "\u{D398}\u{C774}\u{C9C0} \u{C124}\u{C815}\u{2026}",
    ),
    (
        "menuExportPdf",
        "Export as PDF\u{2026}",
        "PDF\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportHwp",
        "Export as HWP Document\u{2026}",
        "\u{D55C}\u{AE00} \u{BB38}\u{C11C}\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportHtml",
        "Export as HTML\u{2026}",
        "HTML\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportMarkdown",
        "Export as Markdown\u{2026}",
        "Markdown\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportImages",
        "Export as Images\u{2026}",
        "\u{C774}\u{BBF8}\u{C9C0}\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    ("menuPrint", "Print\u{2026}", "\u{C778}\u{C1C4}\u{2026}"),
    ("menuEdit", "Edit", "\u{D3B8}\u{C9D1}"),
    ("menuUndo", "Undo", "\u{C2E4}\u{D589} \u{CDE8}\u{C18C}"),
    ("menuRedo", "Redo", "\u{B2E4}\u{C2DC} \u{C2E4}\u{D589}"),
    (
        "menuFindReplace",
        "Find and Replace\u{2026}",
        "\u{CC3E}\u{AE30} \u{BC0F} \u{BC14}\u{AFB8}\u{AE30}\u{2026}",
    ),
    ("menuGoTo", "Go To\u{2026}", "\u{C774}\u{B3D9}\u{2026}"),
    ("menuView", "View", "\u{BCF4}\u{AE30}"),
    ("menuZoomIn", "Zoom In", "\u{D655}\u{B300}"),
    ("menuZoomOut", "Zoom Out", "\u{CD95}\u{C18C}"),
    (
        "menuZoom100",
        "Actual Size (100%)",
        "\u{C2E4}\u{C81C} \u{D06C}\u{AE30}(100%)",
    ),
    ("menuZoom", "Zoom", "\u{D655}\u{B300}/\u{CD95}\u{C18C}"),
    (
        "menuPageWidth",
        "Page Width",
        "\u{D398}\u{C774}\u{C9C0} \u{B108}\u{BE44}",
    ),
    (
        "menuWholePage",
        "Whole Page",
        "\u{C804}\u{CCB4} \u{D398}\u{C774}\u{C9C0}",
    ),
    (
        "menuMultiPage",
        "Multiple Pages",
        "\u{C5EC}\u{B7EC} \u{D398}\u{C774}\u{C9C0}",
    ),
    ("menuAiSidebar", "AI Sidebar", "AI \u{CC3D}"),
    (
        "menuDarkMode",
        "Dark Mode",
        "\u{B2E4}\u{D06C} \u{BAA8}\u{B4DC}",
    ),
    ("menuInsert", "Insert", "\u{C0BD}\u{C785}"),
    ("menuInsertTable", "Table\u{2026}", "\u{D45C}\u{2026}"),
    (
        "menuInsertImage",
        "Image\u{2026}",
        "\u{ADF8}\u{B9BC}\u{2026}",
    ),
    (
        "menuInsertPageBreak",
        "Page Break",
        "\u{D398}\u{C774}\u{C9C0} \u{B098}\u{B204}\u{AE30}",
    ),
    (
        "menuInsertLink",
        "Hyperlink\u{2026}",
        "\u{D558}\u{C774}\u{D37C}\u{B9C1}\u{D06C}\u{2026}",
    ),
    (
        "menuInsertEquation",
        "Equation\u{2026}",
        "\u{C218}\u{C2DD}\u{2026}",
    ),
    ("menuComment", "Comment", "\u{BA54}\u{BAA8}"),
    ("menuFormat", "Format", "\u{C11C}\u{C2DD}"),
    ("menuBold", "Bold", "\u{AD75}\u{AC8C}"),
    ("menuItalic", "Italic", "\u{AE30}\u{C6B8}\u{C784}\u{AF34}"),
    ("menuUnderline", "Underline", "\u{BC11}\u{C904}"),
    ("menuAlign", "Align", "\u{B9DE}\u{CDA4}"),
    (
        "menuAlignLeft",
        "Align Left",
        "\u{C67C}\u{CABD} \u{B9DE}\u{CDA4}",
    ),
    (
        "menuAlignCenter",
        "Center",
        "\u{AC00}\u{C6B4}\u{B370} \u{B9DE}\u{CDA4}",
    ),
    (
        "menuAlignRight",
        "Align Right",
        "\u{C624}\u{B978}\u{CABD} \u{B9DE}\u{CDA4}",
    ),
    (
        "menuAlignJustify",
        "Justify",
        "\u{C591}\u{CABD} \u{B9DE}\u{CDA4}",
    ),
    ("menuFont", "Font\u{2026}", "\u{AE00}\u{AF34}\u{2026}"),
    (
        "menuParagraph",
        "Paragraph\u{2026}",
        "\u{B2E8}\u{B77D}\u{2026}",
    ),
    ("menuTable", "Table", "\u{D45C}"),
    ("menuTableInsert", "Insert", "\u{C0BD}\u{C785}"),
    ("menuTableInsertTable", "Table\u{2026}", "\u{D45C}\u{2026}"),
    (
        "menuTableColsLeft",
        "Columns to the Left",
        "\u{C67C}\u{CABD}\u{C5D0} \u{C5F4}",
    ),
    (
        "menuTableColsRight",
        "Columns to the Right",
        "\u{C624}\u{B978}\u{CABD}\u{C5D0} \u{C5F4}",
    ),
    (
        "menuTableRowsAbove",
        "Rows Above",
        "\u{C704}\u{C5D0} \u{D589}",
    ),
    (
        "menuTableRowsBelow",
        "Rows Below",
        "\u{C544}\u{B798}\u{C5D0} \u{D589}",
    ),
    ("menuTableCells", "Cells\u{2026}", "\u{C140}\u{2026}"),
    ("menuTableDelete", "Delete", "\u{C0AD}\u{C81C}"),
    ("menuTableDeleteTable", "Table", "\u{D45C}"),
    ("menuTableDeleteColumns", "Columns", "\u{C5F4}"),
    ("menuTableDeleteRows", "Rows", "\u{D589}"),
    ("menuTableSelect", "Select", "\u{C120}\u{D0DD}"),
    ("menuTableSelectTable", "Table", "\u{D45C}"),
    ("menuTableSelectColumn", "Column", "\u{C5F4}"),
    ("menuTableSelectRow", "Row", "\u{D589}"),
    ("menuTableSelectCell", "Cell", "\u{C140}"),
    (
        "menuTableMergeCells",
        "Merge Cells",
        "\u{C140} \u{BCD1}\u{D569}",
    ),
    (
        "menuTableSplitCells",
        "Split Cells\u{2026}",
        "\u{C140} \u{BD84}\u{D560}\u{2026}",
    ),
    (
        "menuTableSplitTable",
        "Split Table",
        "\u{D45C} \u{BD84}\u{D560}",
    ),
    (
        "menuTableAutoFit",
        "AutoFit and Distribute",
        "\u{C790}\u{B3D9} \u{B9DE}\u{CDA4} \u{BC0F} \u{BD84}\u{BC30}",
    ),
    (
        "menuTableAutoFitContents",
        "AutoFit to Contents",
        "\u{B0B4}\u{C6A9}\u{C5D0} \u{C790}\u{B3D9} \u{B9DE}\u{CDA4}",
    ),
    (
        "menuTableAutoFitWindow",
        "AutoFit to Window",
        "\u{CC3D}\u{C5D0} \u{C790}\u{B3D9} \u{B9DE}\u{CDA4}",
    ),
    (
        "menuTableFixedWidth",
        "Fixed Column Width",
        "\u{C5F4} \u{B108}\u{BE44} \u{ACE0}\u{C815}",
    ),
    (
        "menuTableDistributeRows",
        "Distribute Rows Evenly",
        "\u{D589} \u{ADE0}\u{B4F1} \u{BD84}\u{BC30}",
    ),
    (
        "menuTableDistributeColumns",
        "Distribute Columns Evenly",
        "\u{C5F4} \u{ADE0}\u{B4F1} \u{BD84}\u{BC30}",
    ),
    (
        "menuTableRepeatHeader",
        "Repeat Header Rows",
        "\u{BA38}\u{B9AC}\u{AE00} \u{D589} \u{BC18}\u{BCF5}",
    ),
    (
        "menuTableGridlines",
        "View Gridlines",
        "\u{B208}\u{AE08}\u{C120} \u{BCF4}\u{AE30}",
    ),
    (
        "menuTableProperties",
        "Table Properties\u{2026}",
        "\u{D45C} \u{C18D}\u{C131}\u{2026}",
    ),
    ("menuTools", "Tools", "\u{B3C4}\u{AD6C}"),
    (
        "menuWordCount",
        "Word Count\u{2026}",
        "\u{B2E8}\u{C5B4} \u{AC1C}\u{C218}\u{2026}",
    ),
    (
        "menuAutoCorrect",
        "AutoCorrect Options\u{2026}",
        "\u{C790}\u{B3D9} \u{ACE0}\u{CE68} \u{C635}\u{C158}\u{2026}",
    ),
    ("menuAiProofread", "AI Proofread", "AI \u{AD50}\u{C815}"),
    ("menuHelp", "Help", "\u{B3C4}\u{C6C0}\u{B9D0}"),
    (
        "menuShortcuts",
        "Keyboard Shortcuts",
        "\u{D0A4}\u{BCF4}\u{B4DC} \u{BC14}\u{B85C} \u{AC00}\u{AE30}",
    ),
    (
        "menuOpenRecent",
        "Open Recent",
        "\u{CD5C}\u{ADFC} \u{BB38}\u{C11C} \u{C5F4}\u{AE30}",
    ),
    (
        "menuNoRecent",
        "No Recent Documents",
        "\u{CD5C}\u{ADFC} \u{BB38}\u{C11C} \u{C5C6}\u{C74C}",
    ),
    ("menuClose", "Close", "\u{B2EB}\u{AE30}"),
    ("menuCut", "Cut", "\u{C798}\u{B77C}\u{B0B4}\u{AE30}"),
    ("menuCopy", "Copy", "\u{BCF5}\u{C0AC}"),
    ("menuPaste", "Paste", "\u{BD99}\u{C5EC}\u{B123}\u{AE30}"),
    (
        "menuPasteMatch",
        "Paste and Match Style",
        "\u{C11C}\u{C2DD} \u{B9DE}\u{CDB0} \u{BD99}\u{C5EC}\u{B123}\u{AE30}",
    ),
    (
        "menuSelectAll",
        "Select All",
        "\u{BAA8}\u{B450} \u{C120}\u{D0DD}",
    ),
    (
        "menuFullscreen",
        "Enter Full Screen",
        "\u{C804}\u{CCB4} \u{D654}\u{BA74} \u{C2DC}\u{C791}",
    ),
    ("menuNewWindow", "New Window", "\u{C0C8} \u{CC3D}"),
];

/// the keys `SHEETS_ACTIONS` names, from `sheets-main.ts`'s dictionary: key, English, Korean
const SHEETS_LABELS: &[(&str, &str, &str)] = &[
    ("menuFile", "File", "\u{D30C}\u{C77C}"),
    (
        "menuOpenWorkbook",
        "Open Workbook\u{2026}",
        "\u{D1B5}\u{D569} \u{BB38}\u{C11C} \u{C5F4}\u{AE30}\u{2026}",
    ),
    ("menuSave", "Save", "\u{C800}\u{C7A5}"),
    (
        "menuSaveAs",
        "Save As\u{2026}",
        "\u{B2E4}\u{B978} \u{C774}\u{B984}\u{C73C}\u{B85C} \u{C800}\u{C7A5}\u{2026}",
    ),
    ("menuPrint", "Print\u{2026}", "\u{C778}\u{C1C4}\u{2026}"),
    (
        "menuExportPdf",
        "Export PDF\u{2026}",
        "PDF \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportCsv",
        "Export CSV\u{2026}",
        "CSV \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportOds",
        "Export as ODS\u{2026}",
        "ODS\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    ("menuEdit", "Edit", "\u{D3B8}\u{C9D1}"),
    ("menuUndo", "Undo", "\u{C2E4}\u{D589} \u{CDE8}\u{C18C}"),
    ("menuRedo", "Redo", "\u{B2E4}\u{C2DC} \u{C2E4}\u{D589}"),
    ("menuClose", "Close", "\u{B2EB}\u{AE30}"),
];

/// the keys of `buildSlidesMenu` (`apps/slides/src/main/i18n-main.ts`): key,
/// English, Korean
const SLIDES_LABELS: &[(&str, &str, &str)] = &[
    ("menuFile", "File", "\u{D30C}\u{C77C}"),
    ("menuOpen", "Open\u{2026}", "\u{C5F4}\u{AE30}\u{2026}"),
    ("menuSave", "Save", "\u{C800}\u{C7A5}"),
    (
        "menuSaveAs",
        "Save As\u{2026}",
        "\u{B2E4}\u{B978} \u{C774}\u{B984}\u{C73C}\u{B85C} \u{C800}\u{C7A5}\u{2026}",
    ),
    (
        "menuExportPdf",
        "Export as PDF\u{2026}",
        "PDF\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportImages",
        "Export as PNG\u{2026}",
        "PNG\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    (
        "menuExportImagesJpg",
        "Export as JPG\u{2026}",
        "JPG\u{B85C} \u{B0B4}\u{BCF4}\u{B0B4}\u{AE30}\u{2026}",
    ),
    ("menuPrint", "Print\u{2026}", "\u{C778}\u{C1C4}\u{2026}"),
    ("menuClose", "Close", "\u{B2EB}\u{AE30}"),
    ("menuEdit", "Edit", "\u{D3B8}\u{C9D1}"),
    ("menuUndo", "Undo", "\u{C2E4}\u{D589} \u{CDE8}\u{C18C}"),
    ("menuRedo", "Redo", "\u{B2E4}\u{C2DC} \u{C2E4}\u{D589}"),
    ("menuCut", "Cut", "\u{C798}\u{B77C}\u{B0B4}\u{AE30}"),
    ("menuCopy", "Copy", "\u{BCF5}\u{C0AC}"),
    ("menuPaste", "Paste", "\u{BD99}\u{C5EC}\u{B123}\u{AE30}"),
    ("menuView", "View", "\u{BCF4}\u{AE30}"),
    ("menuZoomIn", "Zoom In", "\u{D655}\u{B300}"),
    ("menuZoomOut", "Zoom Out", "\u{CD95}\u{C18C}"),
    (
        "menuActualSize",
        "Actual Size",
        "\u{C2E4}\u{C81C} \u{D06C}\u{AE30}",
    ),
    (
        "menuOpenNewWindow",
        "Open in New Window",
        "\u{C0C8} \u{CC3D}\u{C5D0}\u{C11C} \u{C5F4}\u{AE30}",
    ),
];

/// `docs-main.ts`'s `tm` keys of every static `sendCommand` item of
/// `buildDocsMenu`, from the menu's label down to the item, and its command
const DOCS_COMMANDS: &[(&[&str], &str)] = &[
    (&["menuFile", "menuNewDoc"], "new"),
    (&["menuFile", "menuOpen"], "open"),
    (&["menuFile", "menuSave"], "save"),
    (&["menuFile", "menuSaveAs"], "save-as"),
    (&["menuFile", "nameWithAi"], "name-with-ai"),
    (&["menuFile", "menuPageSetup"], "page-setup"),
    (&["menuFile", "menuExportPdf"], "export-pdf"),
    (&["menuFile", "menuExportHwp"], "export-hwp"),
    (&["menuFile", "menuExportHtml"], "export-html"),
    (&["menuFile", "menuExportMarkdown"], "export-markdown"),
    (&["menuFile", "menuExportImages"], "export-images"),
    (&["menuFile", "menuPrint"], "print"),
    (&["menuEdit", "menuUndo"], "undo"),
    (&["menuEdit", "menuRedo"], "redo"),
    (&["menuEdit", "menuFindReplace"], "find"),
    (&["menuEdit", "menuGoTo"], "goto"),
    (&["menuView", "menuZoomIn"], "zoom-in"),
    (&["menuView", "menuZoomOut"], "zoom-out"),
    (&["menuView", "menuZoom100"], "zoom-100"),
    (
        &["menuView", "menuZoom", "menuPageWidth"],
        "zoom-page-width",
    ),
    (
        &["menuView", "menuZoom", "menuWholePage"],
        "zoom-whole-page",
    ),
    (
        &["menuView", "menuZoom", "menuMultiPage"],
        "zoom-multi-page",
    ),
    (&["menuView", "menuAiSidebar"], "toggle-ai"),
    (&["menuView", "menuDarkMode"], "toggle-dark"),
    (&["menuInsert", "menuInsertTable"], "insert-table"),
    (&["menuInsert", "menuInsertImage"], "insert-image"),
    (&["menuInsert", "menuInsertPageBreak"], "insert-page-break"),
    (&["menuInsert", "menuInsertLink"], "insert-link"),
    (&["menuInsert", "menuInsertEquation"], "insert-equation"),
    (&["menuInsert", "menuComment"], "insert-comment"),
    (&["menuFormat", "menuBold"], "bold"),
    (&["menuFormat", "menuItalic"], "italic"),
    (&["menuFormat", "menuUnderline"], "underline"),
    (&["menuFormat", "menuAlign", "menuAlignLeft"], "align-left"),
    (
        &["menuFormat", "menuAlign", "menuAlignCenter"],
        "align-center",
    ),
    (
        &["menuFormat", "menuAlign", "menuAlignRight"],
        "align-right",
    ),
    (
        &["menuFormat", "menuAlign", "menuAlignJustify"],
        "align-justify",
    ),
    (&["menuFormat", "menuFont"], "font-dialog"),
    (&["menuFormat", "menuParagraph"], "paragraph-dialog"),
    (
        &["menuTable", "menuTableInsert", "menuTableInsertTable"],
        "insert-table",
    ),
    (
        &["menuTable", "menuTableInsert", "menuTableColsLeft"],
        "table-insert-cols-left",
    ),
    (
        &["menuTable", "menuTableInsert", "menuTableColsRight"],
        "table-insert-cols-right",
    ),
    (
        &["menuTable", "menuTableInsert", "menuTableRowsAbove"],
        "table-insert-rows-above",
    ),
    (
        &["menuTable", "menuTableInsert", "menuTableRowsBelow"],
        "table-insert-rows-below",
    ),
    (
        &["menuTable", "menuTableInsert", "menuTableCells"],
        "table-insert-cells",
    ),
    (
        &["menuTable", "menuTableDelete", "menuTableDeleteTable"],
        "table-delete-table",
    ),
    (
        &["menuTable", "menuTableDelete", "menuTableDeleteColumns"],
        "table-delete-columns",
    ),
    (
        &["menuTable", "menuTableDelete", "menuTableDeleteRows"],
        "table-delete-rows",
    ),
    (
        &["menuTable", "menuTableDelete", "menuTableCells"],
        "table-delete-cells",
    ),
    (
        &["menuTable", "menuTableSelect", "menuTableSelectTable"],
        "table-select-table",
    ),
    (
        &["menuTable", "menuTableSelect", "menuTableSelectColumn"],
        "table-select-column",
    ),
    (
        &["menuTable", "menuTableSelect", "menuTableSelectRow"],
        "table-select-row",
    ),
    (
        &["menuTable", "menuTableSelect", "menuTableSelectCell"],
        "table-select-cell",
    ),
    (&["menuTable", "menuTableMergeCells"], "table-merge-cells"),
    (&["menuTable", "menuTableSplitCells"], "table-split-cells"),
    (&["menuTable", "menuTableSplitTable"], "table-split-table"),
    (
        &["menuTable", "menuTableAutoFit", "menuTableAutoFitContents"],
        "table-autofit-contents",
    ),
    (
        &["menuTable", "menuTableAutoFit", "menuTableAutoFitWindow"],
        "table-autofit-window",
    ),
    (
        &["menuTable", "menuTableAutoFit", "menuTableFixedWidth"],
        "table-autofit-fixed",
    ),
    (
        &["menuTable", "menuTableAutoFit", "menuTableDistributeRows"],
        "table-distribute-rows",
    ),
    (
        &[
            "menuTable",
            "menuTableAutoFit",
            "menuTableDistributeColumns",
        ],
        "table-distribute-columns",
    ),
    (
        &["menuTable", "menuTableRepeatHeader"],
        "table-repeat-header",
    ),
    (&["menuTable", "menuTableGridlines"], "table-gridlines"),
    (&["menuTable", "menuTableProperties"], "table-properties"),
    (&["menuTools", "menuWordCount"], "word-count"),
    (&["menuTools", "menuAutoCorrect"], "autocorrect-options"),
    (&["menuTools", "menuAiProofread"], "ai-proofread"),
    (&["menuHelp", "menuShortcuts"], "shortcuts"),
];

/// `[500, 200, 150, 125, 100, 75, 50, 25, 10]` of the View > Zoom submenu:
/// each item is labelled `<pct>%` and sends `zoom-set` with `String(pct)`
const ZOOM_PERCENTS: [u32; 9] = [500, 200, 150, 125, 100, 75, 50, 25, 10];

/// `sheets-main.ts`'s `tm` keys of the `sendMenuAction` items of
/// `installApplicationMenu`, and their actions
const SHEETS_ACTIONS: &[(&[&str], &str)] = &[
    (&["menuFile", "menuOpenWorkbook"], "open"),
    (&["menuFile", "menuSave"], "save"),
    (&["menuFile", "menuSaveAs"], "save-as"),
    (&["menuFile", "menuPrint"], "print"),
    (&["menuFile", "menuExportPdf"], "export-pdf"),
    (&["menuFile", "menuExportCsv"], "export-csv"),
    (&["menuFile", "menuExportOds"], "export-ods"),
    (&["menuEdit", "menuUndo"], "undo"),
    (&["menuEdit", "menuRedo"], "redo"),
];

/// File > Print of the shell-built menus, by editor kind
/// (`send<App>PrintRequest`: `webContents.send(channel)`)
const PRINT_REQUESTS: &[(&str, &str)] = &[
    ("pdf", "pdf:print-request"),
    ("markdown", "markdown:print-request"),
    ("html", "html:print-request"),
    ("diagram", "diagram:print-request"),
    ("mindmap", "mindmap:print-request"),
];

/// `createI18n`'s lookup: the language's text, the key itself when the
/// dictionary has none
fn translate(table: &[(&str, &str, &str)], lang: Lang, key: &str) -> String {
    table
        .iter()
        .find(|(k, _, _)| *k == key)
        .map(|(_, en, ko)| if lang == Lang::Ko { *ko } else { *en })
        .unwrap_or(key)
        .to_owned()
}

/// The dictionaries the menus' own labels come from: the shell's `tm` and
/// each editor's
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuDict {
    Shell,
    Docs,
    Sheets,
    Slides,
}

/// `tm(key)` of the dictionary in `lang`: the key itself when it has none
pub fn menu_label(dict: MenuDict, lang: Lang, key: &str) -> String {
    let table = match dict {
        MenuDict::Shell => SHELL_LABELS,
        MenuDict::Docs => DOCS_LABELS,
        MenuDict::Sheets => SHEETS_LABELS,
        MenuDict::Slides => SLIDES_LABELS,
    };
    translate(table, lang, key)
}

fn event(channel: &'static str, args: Vec<IpcValue>) -> MenuAction {
    MenuAction::Event { channel, args }
}

fn text(value: &str) -> IpcValue {
    IpcValue::String(value.to_owned())
}

fn labelled(
    table: &[(&str, &str, &str)],
    lang: Lang,
    keys: &[&str],
    labels: impl Fn(&str) -> Option<String>,
) -> Vec<String> {
    keys.iter()
        .map(|key| labels(key).unwrap_or_else(|| translate(table, lang, key)))
        .collect()
}

/// The items of `kind`'s menu that send an event of batch M, for `lang`:
/// `docs`, `sheets`, `pdf`, `markdown`, `hwp`, `html`, `diagram`, `mindmap`.
/// An unknown kind has none.
pub fn app_menu_items(kind: &str, lang: Lang) -> AppMenuItems {
    let shell = |keys: &[&str]| labelled(SHELL_LABELS, lang, keys, |_| None);
    match kind {
        "docs" => {
            // `labels.nameWithAi` of `appMenuLabels` is not a `tm` key
            let name_with_ai = |key: &str| {
                (key == "nameWithAi")
                    .then(|| app_menu_labels(lang.as_str()).name_with_ai().to_owned())
            };
            let mut items: AppMenuItems = DOCS_COMMANDS
                .iter()
                .map(|(keys, command)| {
                    (
                        labelled(DOCS_LABELS, lang, keys, name_with_ai),
                        event(MENU_COMMAND, vec![text(command), IpcValue::Undefined]),
                    )
                })
                .collect();
            let zoom = labelled(DOCS_LABELS, lang, &["menuView", "menuZoom"], |_| None);
            items.extend(ZOOM_PERCENTS.iter().map(|pct| {
                let mut path = zoom.clone();
                path.push(format!("{pct}%"));
                (
                    path,
                    event(
                        MENU_COMMAND,
                        vec![text("zoom-set"), IpcValue::String(pct.to_string())],
                    ),
                )
            }));
            items
        }
        "sheets" => SHEETS_ACTIONS
            .iter()
            .map(|(keys, action)| {
                (
                    labelled(SHEETS_LABELS, lang, keys, |_| None),
                    event(MENU_ACTION, vec![text(action)]),
                )
            })
            .collect(),
        "hwp" => vec![(
            shell(&["menuFile", "menuExportPdf"]),
            event("hwp:print-request", vec![text("pdf")]),
        )],
        other => PRINT_REQUESTS
            .iter()
            .filter(|(app, _)| *app == other)
            .map(|(_, channel)| {
                (
                    shell(&["menuFile", "menuPrint"]),
                    event(channel, Vec::new()),
                )
            })
            .collect(),
    }
}

/// The language the process holds, as the TypeScript menus' `tm` read it
pub fn current_lang(services: &Services) -> Result<Lang, String> {
    let (Some(state), Some(host)) = (
        services.hosts.get::<MStateRef>(),
        services.hosts.get::<MHostRef>(),
    ) else {
        return Err("batch M's hosts are not installed".to_owned());
    };
    let settings = services
        .paths
        .path(PathName::UserData)
        .join("app-settings.json");
    Ok(state.language(&**host, &settings.to_string_lossy()).lang)
}

/// Clicks the item of `kind`'s menu at `path`: its event goes to `target`,
/// the active editor of that kind. Err when the menu has no such item.
pub fn click_app_menu(
    services: &Services,
    kind: &str,
    path: &[String],
    target: ViewId,
) -> Result<(), String> {
    let lang = current_lang(services)?;
    let (_, MenuAction::Event { channel, args }) = app_menu_items(kind, lang)
        .into_iter()
        .find(|(item, _)| item == path)
        .ok_or_else(|| format!("no menu item {path:?} in the {kind} menu"))?;
    services.events.emit(Target::View(target), channel, args);
    Ok(())
}

/// A right-click on `view`: what `installContextMenu`'s listener does, then
/// the click on the entry at `path` of the native menu. True when the view's
/// interceptor took the click (`docs:context-menu` was sent, no native menu,
/// `path` unused); false when the native menu popped and the entry was
/// clicked. Err when the menu has no such entry.
pub fn click_context_menu(
    services: &Services,
    provided: &Provided,
    view: ViewId,
    params: &ContextMenuParams,
    path: &[String],
) -> Result<bool, String> {
    if intercept_context_menu(services, provided, view, params) {
        return Ok(true);
    }
    let lang = current_lang(services)?;
    let template = context_menu_template(params, &context_menu_labels(lang.as_str()));
    // no entries: `popupMenu` pops nothing
    if template.is_empty() {
        return Ok(false);
    }
    let command = template
        .into_iter()
        .find_map(|entry| match entry {
            MenuEntry::Item { label, click, .. } if matches!(path, [only] if *only == label) => {
                Some(click)
            }
            _ => None,
        })
        .ok_or_else(|| format!("no context menu entry {path:?}"))?;
    // what is left needs the shell's webContents (copy image, save image,
    // cut, copy, paste, select all): the host carries it out
    let _ = context_menu_command(services, view, command);
    Ok(false)
}

/// The `trigger` calls of tools/ipc-diff that batch M answers (README.md);
/// false for any other name. `m/menu:<app>:<labels joined by " > ">` (args
/// `[]`) clicks an item of an editor's menu, `m/context-menu` (args
/// `[params, path]`) right-clicks the view and clicks an entry of the native
/// menu; `params` are Electron's `ContextMenuParams`, the fields the menu
/// reads. The outcome is `undefined`, or the error of a missing item.
#[cfg(feature = "probe")]
pub fn probe_trigger(
    name: &str,
    view: ViewId,
    args: &serde_json::Value,
    services: &Services,
    provided: &std::rc::Rc<Provided>,
    then: shell_contract::editors::Then<IpcValue>,
) -> bool {
    use crate::handler::error;
    use main_core::packages::electron_utils::context_menu::EditFlags;
    use serde_json::Value;

    let outcome = if let Some(item) = name.strip_prefix("m/menu:") {
        let Some((app, labels)) = item.split_once(':') else {
            return false;
        };
        let path: Vec<String> = labels.split(" > ").map(str::to_owned).collect();
        click_app_menu(services, app, &path, view)
    } else if name == "m/context-menu" {
        let given = &args[0];
        let string = |key: &str| given[key].as_str().map(str::to_owned);
        let flag = |key: &str| given["editFlags"][key].as_bool().unwrap_or(false);
        let params = ContextMenuParams {
            is_editable: given["isEditable"].as_bool().unwrap_or(false),
            selection_text: string("selectionText").unwrap_or_default(),
            misspelled_word: string("misspelledWord").unwrap_or_default(),
            dictionary_suggestions: given["dictionarySuggestions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            edit_flags: EditFlags {
                can_cut: flag("canCut"),
                can_copy: flag("canCopy"),
                can_paste: flag("canPaste"),
                can_select_all: flag("canSelectAll"),
            },
            media_type: string("mediaType"),
            src_url: string("srcURL"),
            x: given["x"].as_f64().unwrap_or(0.0),
            y: given["y"].as_f64().unwrap_or(0.0),
        };
        let path: Vec<String> = args[1]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        click_context_menu(services, provided, view, &params, &path).map(|_| ())
    } else {
        return false;
    };
    then(outcome.map(|()| IpcValue::Undefined).map_err(error));
    true
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use serde_json::json;
    use shell_contract::channels::Surface;

    use super::*;
    use crate::testkit::{Probe, sender};

    const KINDS: [&str; 8] = [
        "docs", "sheets", "pdf", "markdown", "hwp", "html", "diagram", "mindmap",
    ];

    fn probe(config: serde_json::Value) -> Probe {
        Probe::new(
            config,
            vec![sender(1, Surface::Docs), sender(2, Surface::Docs)],
        )
    }

    fn path(labels: &[&str]) -> Vec<String> {
        labels.iter().map(|l| (*l).to_owned()).collect()
    }

    fn action_of(items: &AppMenuItems, labels: &[&str]) -> MenuAction {
        items
            .iter()
            .find(|(p, _)| *p == path(labels))
            .unwrap_or_else(|| panic!("no item {labels:?}"))
            .1
            .clone()
    }

    fn sent(channel: &'static str, args: Vec<IpcValue>) -> MenuAction {
        MenuAction::Event { channel, args }
    }

    #[test]
    fn no_item_path_is_listed_twice_and_every_event_is_one_of_the_batch() {
        for kind in KINDS {
            for lang in [Lang::En, Lang::Ko] {
                let items = app_menu_items(kind, lang);
                assert!(!items.is_empty(), "{kind} has items");
                let paths: HashSet<_> = items.iter().map(|(p, _)| p.clone()).collect();
                assert_eq!(
                    paths.len(),
                    items.len(),
                    "{kind} {lang:?} lists a path twice"
                );
                for (p, MenuAction::Event { channel, .. }) in &items {
                    assert!(
                        ["menu:command", "menu:action"].contains(channel)
                            || channel.ends_with(":print-request"),
                        "{p:?} sends {channel}"
                    );
                }
            }
        }
        assert!(app_menu_items("slides", Lang::En).is_empty());
    }

    #[test]
    fn docs_commands_pass_the_command_and_an_undefined_payload() {
        let items = app_menu_items("docs", Lang::En);
        assert_eq!(
            action_of(&items, &["File", "Save"]),
            sent("menu:command", vec![text("save"), IpcValue::Undefined])
        );
        assert_eq!(
            action_of(&items, &["Table", "Insert", "Cells\u{2026}"]),
            sent(
                "menu:command",
                vec![text("table-insert-cells"), IpcValue::Undefined]
            )
        );
        assert_eq!(
            action_of(&items, &["File", "Name with AI\u{2026}"]),
            sent(
                "menu:command",
                vec![text("name-with-ai"), IpcValue::Undefined]
            )
        );
        assert_eq!(
            action_of(&items, &["View", "Zoom", "75%"]),
            sent("menu:command", vec![text("zoom-set"), text("75")])
        );
        let zoom_set = items
            .iter()
            .filter(|(_, MenuAction::Event { args, .. })| args[0] == text("zoom-set"))
            .count();
        assert_eq!(zoom_set, ZOOM_PERCENTS.len());
    }

    #[test]
    fn sheets_sends_its_nine_actions() {
        let items = app_menu_items("sheets", Lang::En);
        assert_eq!(items.len(), 9);
        assert_eq!(
            action_of(&items, &["File", "Print\u{2026}"]),
            sent("menu:action", vec![text("print")])
        );
        assert_eq!(
            action_of(&items, &["Edit", "Redo"]),
            sent("menu:action", vec![text("redo")])
        );
    }

    #[test]
    fn the_shell_built_menus_send_their_print_request() {
        for (kind, channel) in PRINT_REQUESTS {
            assert_eq!(
                app_menu_items(kind, Lang::En),
                vec![(path(&["File", "Print\u{2026}"]), sent(channel, vec![]))],
                "{kind}"
            );
        }
        assert_eq!(
            app_menu_items("hwp", Lang::En),
            vec![(
                path(&["File", "Export as PDF\u{2026}"]),
                sent("hwp:print-request", vec![text("pdf")])
            )]
        );
    }

    #[test]
    fn labels_follow_the_language() {
        let ko = app_menu_items("markdown", Lang::Ko);
        assert_eq!(
            ko[0].0,
            path(&["\u{D30C}\u{C77C}", "\u{C778}\u{C1C4}\u{2026}"])
        );
        let docs = app_menu_items("docs", Lang::Ko);
        assert_eq!(
            action_of(
                &docs,
                &[
                    "\u{D30C}\u{C77C}",
                    "AI\u{B85C} \u{C774}\u{B984} \u{C9C0}\u{C815}\u{2026}"
                ]
            ),
            sent(
                "menu:command",
                vec![text("name-with-ai"), IpcValue::Undefined]
            )
        );
    }

    #[test]
    fn the_menus_own_labels_come_from_their_dictionary_in_the_language() {
        assert_eq!(
            menu_label(MenuDict::Shell, Lang::En, "backToHome"),
            "Back to Home"
        );
        assert_eq!(
            menu_label(MenuDict::Shell, Lang::Ko, "menuHelp"),
            "\u{B3C4}\u{C6C0}\u{B9D0}"
        );
        assert_eq!(
            menu_label(MenuDict::Slides, Lang::En, "menuExportImages"),
            "Export as PNG\u{2026}"
        );
        assert_eq!(
            menu_label(MenuDict::Docs, Lang::En, "menuNoRecent"),
            "No Recent Documents"
        );
        assert_eq!(
            menu_label(MenuDict::Sheets, Lang::Ko, "menuClose"),
            "\u{B2EB}\u{AE30}"
        );
        // a key the dictionary has none of is the key, as `createI18n` answers
        assert_eq!(
            menu_label(MenuDict::Slides, Lang::En, "menuNothing"),
            "menuNothing"
        );
    }

    #[test]
    fn a_click_sends_the_event_to_the_target_view() {
        let p = probe(json!({}));
        click_app_menu(
            &p.services,
            "docs",
            &path(&["File", "Print\u{2026}"]),
            ViewId(2),
        )
        .unwrap();
        click_app_menu(
            &p.services,
            "hwp",
            &path(&["File", "Export as PDF\u{2026}"]),
            ViewId(1),
        )
        .unwrap();
        assert_eq!(
            p.take_events(),
            vec![
                (
                    Target::View(ViewId(2)),
                    "menu:command",
                    vec![text("print"), IpcValue::Undefined]
                ),
                (
                    Target::View(ViewId(1)),
                    "hwp:print-request",
                    vec![text("pdf")]
                ),
            ]
        );
    }

    #[test]
    fn a_click_reads_the_language_of_the_process() {
        let p = probe(json!({ "envLang": "ko" }));
        let ko = path(&["\u{D30C}\u{C77C}", "\u{C778}\u{C1C4}\u{2026}"]);
        click_app_menu(&p.services, "pdf", &ko, ViewId(1)).unwrap();
        assert_eq!(p.take_events().len(), 1);
        assert!(
            click_app_menu(
                &p.services,
                "pdf",
                &path(&["File", "Print\u{2026}"]),
                ViewId(1)
            )
            .is_err()
        );
    }

    #[test]
    fn a_missing_item_is_an_error_and_sends_nothing() {
        let p = probe(json!({}));
        for (kind, labels) in [
            ("docs", path(&["File", "Nope"])),
            ("docs", path(&["Save"])),
            ("sheets", path(&["File", "Print"])),
            ("slides", path(&["File", "Print\u{2026}"])),
        ] {
            assert!(click_app_menu(&p.services, kind, &labels, ViewId(1)).is_err());
        }
        assert!(p.take_events().is_empty());
    }

    fn params(media: Option<&str>, src: Option<&str>) -> ContextMenuParams {
        ContextMenuParams {
            misspelled_word: "teh".to_owned(),
            dictionary_suggestions: vec!["the".to_owned()],
            media_type: media.map(str::to_owned),
            src_url: src.map(str::to_owned),
            ..Default::default()
        }
    }

    #[test]
    fn a_claimed_right_click_of_an_armed_view_is_intercepted() {
        let p = probe(json!({}));
        p.call(sender(1, Surface::Docs), "docs:context-menu-arm", vec![])
            .unwrap();
        p.call(
            sender(1, Surface::Docs),
            "docs:context-menu-claim",
            vec![IpcValue::Number(4.0)],
        )
        .unwrap();
        let taken = click_context_menu(
            &p.services,
            &p.registry.provided,
            ViewId(1),
            &params(None, None),
            &[],
        );
        assert_eq!(taken, Ok(true));
        let events = p.take_events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1, "docs:context-menu");
    }

    #[test]
    fn an_unclaimed_right_click_on_an_image_views_it_by_its_label() {
        let p = probe(json!({}));
        let image = params(Some("image"), Some("data:image/png;base64,AA=="));
        let clicked = click_context_menu(
            &p.services,
            &p.registry.provided,
            ViewId(2),
            &image,
            &path(&["View Image"]),
        );
        assert_eq!(clicked, Ok(false));
        assert_eq!(
            p.take_events(),
            vec![(
                Target::View(ViewId(2)),
                "seuoffice:view-image",
                vec![text("data:image/png;base64,AA==")]
            )]
        );
    }

    #[test]
    fn the_context_menu_follows_the_language_and_refuses_a_missing_entry() {
        let p = probe(json!({ "envLang": "ko" }));
        let image = params(Some("image"), Some("x://i"));
        let ko = path(&["\u{C774}\u{BBF8}\u{C9C0} \u{BCF4}\u{AE30}"]);
        assert_eq!(
            click_context_menu(&p.services, &p.registry.provided, ViewId(1), &image, &ko),
            Ok(false)
        );
        assert_eq!(p.take_events().len(), 1);
        for labels in [
            path(&["View Image"]),
            path(&["File", "Print\u{2026}"]),
            vec![],
        ] {
            assert!(
                click_context_menu(
                    &p.services,
                    &p.registry.provided,
                    ViewId(1),
                    &image,
                    &labels
                )
                .is_err()
            );
        }
        // a copy image click is the host's: nothing is sent, no error
        let copy = path(&["\u{C774}\u{BBF8}\u{C9C0} \u{BCF5}\u{C0AC}"]);
        assert_eq!(
            click_context_menu(&p.services, &p.registry.provided, ViewId(1), &image, &copy),
            Ok(false)
        );
        assert!(p.take_events().is_empty());
    }

    #[test]
    fn a_suggestion_replaces_the_misspelling_on_the_host() {
        let p = probe(json!({}));
        let typo = ContextMenuParams {
            is_editable: true,
            ..params(None, None)
        };
        assert_eq!(
            click_context_menu(
                &p.services,
                &p.registry.provided,
                ViewId(1),
                &typo,
                &path(&["the"])
            ),
            Ok(false)
        );
        assert_eq!(p.take_calls(), vec!["webContents.replaceMisspelling 1 the"]);
    }
}
