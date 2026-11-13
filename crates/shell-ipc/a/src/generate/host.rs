//! What the generate window reaches beyond `main-core` and the shared hosts:
//! the Electron window it lives in (`new BrowserWindow`, `nativeTheme`), the
//! shell entry's tabs and settings (`apps/shell/src/main/index.ts` hands them
//! to `configureGenerateWindow` as `GenerateWindowDeps`), and the engines the
//! conversions and the material reader use, which are not in `main-core` on
//! this branch (`parseFileToText` of `@seuoffice/file-parse`, the map
//! engine's outline reader, the deck engine of `@seuoffice/pptx-ops`).
//!
//! Every method runs on the core thread, except where it is said to answer
//! later: then the continuation it was given is called on the core thread (or
//! from any thread; the port posts it to the core thread itself). Nothing
//! here may block on a renderer.
//!
//! Windows are the shell's [`WindowId`]s. The window host (batch W's
//! `WindowsHost`) makes the window and keeps the views; this trait is the
//! slice of it the generate window uses, so the integrator implements it in
//! `crates/shell/src/host/` over `Windows::open_window` and the tab manager.

use std::sync::Arc;

use jscompat::JsonValue;
use main_core::packages::electron_utils::generate_handoff::GenerateHandoff;
use main_core::packages::i18n::Lang;
use main_core::shell::app_routing::DocumentTabKind;
use main_core::shell::generate::convert::{ConvertedDocument, OpOutcome, XmindTopic};
use main_core::shell::generate::generate_window::{
    GenerateText, GenerateWindowOptions, NewDocumentOpener,
};
use main_core::shell::generate::materials::ParsedFile;
use main_core::shell::generate::open_materials::{OpenDocumentTab, SaveAnswer, SaveNeed};
use main_core::shell::title_bar_overlay::TitleBarOverlay;
use shell_contract::{ViewId, WindowId};

use super::GenerateWindowEvents;

/// What `webContentsFor(tabId)` answers: the webContents behind a tab
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TabContents {
    pub view: ViewId,
    /// `webContents.isDestroyed()`
    pub destroyed: bool,
}

/// `GenerateWindowDeps` of generate-window.ts, the Electron calls of the
/// module, and the engines named in the module doc
pub trait GenerateShell: Send + Sync {
    // ---- the window: `new BrowserWindow` and what the module calls on it ----

    /// `new BrowserWindow(options)` with the preload of
    /// `apps/shell/src/preload/generate.ts` added to its web preferences. The
    /// host calls `events` for what the TypeScript listens to on the window:
    /// `ready-to-show` (once), `focus`, `closed`, `nativeTheme`'s `updated`
    /// (while [`GenerateShell::watch_theme`] is on for the window) and the
    /// window open handler.
    fn create_window(
        &self,
        options: &GenerateWindowOptions,
        events: GenerateWindowEvents,
    ) -> WindowId;
    /// `win.webContents.id` of a window this host made (`create_window`); the
    /// shell window's page is the main window host's, asked there. `None` once it is gone
    fn window_view(&self, window: WindowId) -> Option<ViewId>;
    /// `win.isDestroyed()`
    fn window_is_destroyed(&self, window: WindowId) -> bool;
    /// `win.isMinimized()`
    fn window_is_minimized(&self, window: WindowId) -> bool;
    /// `win.restore()`
    fn window_restore(&self, window: WindowId);
    /// `win.show()`
    fn window_show(&self, window: WindowId);
    /// `win.focus()`
    fn window_focus(&self, window: WindowId);
    /// `win.close()`: the window's `closed` follows
    fn window_close(&self, window: WindowId);
    /// `win.removeMenu()`
    fn window_remove_menu(&self, window: WindowId);
    /// `win.setTitleBarOverlay(overlay)`: `Err` when the window was torn down
    fn window_set_title_bar_overlay(
        &self,
        window: WindowId,
        overlay: &TitleBarOverlay,
    ) -> Result<(), String>;
    /// `nativeTheme.on('updated', ...)` for this window
    fn watch_theme(&self, window: WindowId);
    /// `nativeTheme.off('updated', ...)` for this window
    fn unwatch_theme(&self, window: WindowId);
    /// `process.env.ELECTRON_RENDERER_URL`
    fn renderer_url(&self) -> Option<String>;
    /// `win.loadURL(url)`
    fn window_load_url(&self, window: WindowId, url: &str);
    /// `win.loadFile(join(__dirname, '../renderer/generate.html'))`
    fn window_load_generate_page(&self, window: WindowId);
    /// `nativeTheme.shouldUseDarkColors`
    fn should_use_dark_colors(&self) -> bool;

    // ---- `GenerateWindowDeps` ----

    /// `deps.lang()`
    fn lang(&self) -> Lang;
    /// `deps.theme()`: `light`, `dark` or `system`
    fn theme(&self) -> String;
    /// `generateText(lang, key)` of `renderer/src/i18n/strings-generate.ts`
    fn generate_text(&self, lang: Lang, key: GenerateText) -> String;
    /// `deps.starredGroupPaths(group)`
    fn starred_group_paths(&self, group: &str) -> Vec<String>;
    /// `deps.tabIdFor(webContentsId)`: the shell tab id behind a webContents,
    /// for the hand-off store's run-started records
    fn tab_id_for(&self, web_contents_id: f64) -> Option<String>;
    /// `deps.openTargetTab(handoff, opener)` (`TabManager.openGenerateTargetTab`,
    /// then the new tab follows the opener's project): `Err` when no tab could open
    fn open_target_tab(
        &self,
        handoff: &GenerateHandoff,
        opener: Option<&NewDocumentOpener>,
    ) -> Result<(), String>;
    /// `deps.openConvertedTab` was given: the window offers conversions
    fn can_open_converted(&self) -> bool;
    /// `deps.openConvertedTab(doc, opener)` (`TabManager.openConversionResult`):
    /// `Err` when no tab could open
    fn open_converted_tab(
        &self,
        doc: &ConvertedDocument,
        opener: Option<&NewDocumentOpener>,
    ) -> Result<(), String>;

    // ---- `deps.openMaterials` ----

    /// `deps.list()`: the open tabs (`tabManager.openDocuments()` and the
    /// detached windows' documents). `then` runs once the list is known; the
    /// open files of the TypeScript's `OpenFilesSource` are the same list.
    fn open_documents(&self, then: Box<dyn FnOnce(Vec<OpenDocumentTab>) + Send>);
    /// `deps.webContentsFor(tabId)`
    fn tab_contents(&self, tab_id: &str) -> Option<TabContents>;
    /// `deps.reveal(tabId)`: bring the tab (and its window) forward
    fn reveal_tab(&self, tab_id: &str);
    /// `!!deps.save[kind]`
    fn has_save(&self, kind: DocumentTabKind) -> bool;
    /// `deps.save[kind](...)`: the editor's save command (`mcpDocsControl.runCommand(wcId,
    /// 'save_document', { path, overwrite: true })`, `requestMarkdownSave(wc, 'save')`, ...).
    /// `then` is told when the editor answered; a rejection is `Err`.
    fn save(&self, need: SaveNeed, then: Box<dyn FnOnce(SaveAnswer) + Send>);
    /// `setTimeout(then, ms)`: the recheck of "save" waits on it
    fn set_timeout(&self, ms: f64, then: Box<dyn FnOnce() + Send>);

    // ---- `randomUUID()` and `Date.now()` of session.ts ----

    fn new_id(&self) -> String;
    fn now_ms(&self) -> f64;

    // ---- engines not in `main-core` ----

    /// `parseFileToText(path)` of `@seuoffice/file-parse`; `Err` is a throw
    fn parse_file_to_text(&self, path: &str) -> Result<ParsedFile, String>;
    /// `OUTLINE_KIND_MARKS.boundary` and `OUTLINE_KIND_MARKS.relationship` of the map editor
    fn not_topic_marks(&self) -> [String; 2];
    /// `outlineToSheets(outline, { untitled })[0].rootTopic`
    fn first_sheet_root(&self, outline: &str, untitled: &str) -> Result<XmindTopic, String>;
    /// `createXmindDocumentFromOutline(text, { untitled })`
    fn create_xmind_document_from_outline(&self, text: &str, untitled: &str) -> Result<(), String>;
    /// `openPptx(await createBlankPptx())`: the host keeps the deck and names it
    fn open_blank_deck(&self) -> Result<u64, String>;
    /// `runTxn(opened, { ops: [op], isolation: 'atomic' })`
    fn apply_deck_op(&self, deck: u64, op: &JsonValue) -> Result<OpOutcome, String>;
    /// `savePptx(opened)`: the deck is gone after it
    fn save_deck(&self, deck: u64) -> Result<Vec<u8>, String>;
}

pub type GenerateShellHost = Arc<dyn GenerateShell>;
