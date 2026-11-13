//! What batch M's handlers reach beyond `shell_contract::Services` and the
//! shared hosts. Three traits, by who implements them in `crates/shell`:
//!
//! - [`MHost`]: M's own area (the app's locale, the native theme, menus, the
//!   spellchecker, printers and print windows); M's host files
//!   (`host/menu.rs`, `host/print.rs`).
//! - [`Peers`]: state other batches own that some M channels read (the tab
//!   manager's split panes, the sheets sessions, a document's path, the
//!   slides sessions, the PDF structure jobs). Each method names its owner.
//! - [`FontQueries`]: `main-core` gaps, the font-metrics package and the PDF
//!   editor's fonts; implemented once stage 2 ports them.
//!
//! Every method runs on the thread that calls it and returns when done; an
//! implementation that needs the UI thread uses `run_on`. Methods whose
//! TypeScript awaited are called from a worker, never from the core thread.

use std::sync::Arc;

use main_core::packages::electron_utils::print_window::{ExecOutcome, PrintReport};
use main_core::packages::electron_utils::printer_options::CommandOutcome;
use serde_json::Value;
use shell_contract::ipc::Responder;
use shell_contract::{ViewId, WindowId};

/// `{ name, displayName }` of `webContents.getPrintersAsync()`
#[derive(Clone, Debug, PartialEq)]
pub struct Printer {
    pub name: String,
    pub display_name: String,
}

/// Which `webPreferences` a throwaway print window gets: each app kept its own
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrintProfile {
    /// sandboxed, scripts on (the readiness probe runs): html, slides
    Scripted,
    /// sandboxed, scripts off: hwp, markdown, html preview, workbook
    Static,
    /// diagram's partition, its bridge protocol and navigation guard
    Diagram,
    /// mindmap's export session, which refuses every request but `data:`
    /// URLs and the one page file loaded
    MindmapExport,
}

/// `new BrowserWindow({ show: false, ... })` for printing
#[derive(Clone, Debug, PartialEq)]
pub struct PrintWindowSpec {
    pub profile: PrintProfile,
    pub width: Option<f64>,
    pub height: Option<f64>,
    /// `parent`, when the owner window is alive
    pub parent: Option<WindowId>,
    /// win32 only: the size and chrome of a window that shows the system
    /// print dialog (900x700, no menu bar, not closable, not in the taskbar)
    pub dialog_chrome: bool,
}

/// A hidden window to print from: what the TypeScript called on its
/// `BrowserWindow` and `webContents`. `Send`: a print runs on a worker.
pub trait PrintSurface: Send {
    fn load_file(&mut self, path: &str) -> Result<(), String>;
    fn load_url(&mut self, url: &str) -> Result<(), String>;
    /// `executeJavaScript(script, userGesture)` raced against a 5 s timer
    fn execute_javascript(&mut self, script: &str, user_gesture: bool) -> ExecOutcome;
    /// `webContents.print(options, (success, failureReason) => ...)`
    fn print(&mut self, options: &Value) -> PrintReport;
    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, String>;
    fn show(&mut self);
    fn focus(&mut self);
    fn is_destroyed(&self) -> bool;
    fn destroy(&mut self);
}

/// A key event of `webContents.sendInputEvent`
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyInput {
    KeyDown,
    Char,
    KeyUp,
}

pub trait MHost: Send + Sync {
    /// `Date.now()`
    fn now_ms(&self) -> f64;
    /// `app.getLocale()`
    fn app_locale(&self) -> String;
    /// `app.getSystemLocale()`
    fn system_locale(&self) -> String;
    /// `process.env.SEUOFFICE_LANG`
    fn env_lang(&self) -> Option<String>;
    /// `os.userInfo().username`; `None` when it throws
    fn username(&self) -> Option<String>;

    /// `nativeTheme.themeSource = theme`
    fn set_native_theme(&self, theme: &str);
    /// `refreshTitleBarOverlay()`: the shell window's overlay colours follow
    /// `nativeTheme.shouldUseDarkColors`
    fn refresh_title_bar_overlay(&self);
    /// after a language change, in this order: the home menu, the dock menu
    /// (macOS), the editors' "back to home" items
    fn rebuild_menus_for_language(&self);
    /// `syncTrayMenu()` of the quick-look window
    fn sync_tray_menu(&self);
    /// `slides:open-font-settings`: restore, show and focus the shell window,
    /// then open the home tab; false when there is no shell window
    fn reveal_home(&self) -> bool;
    /// `shell.openPath` of the template fonts folder; `""` on success
    fn open_template_fonts_folder(&self) -> String;

    /// `session.addWordToSpellCheckerDictionary` of the view's session
    fn spell_add_word(&self, view: ViewId, word: &str) -> bool;
    /// `session.defaultSession.removeWordFromSpellCheckerDictionary`
    fn spell_remove_word(&self, word: &str);
    /// `session.getSpellCheckerLanguages()`
    fn spell_languages(&self, view: ViewId) -> Vec<String>;
    /// `session.availableSpellCheckerLanguages`
    fn spell_available_languages(&self, view: ViewId) -> Vec<String>;
    fn spell_set_languages(&self, view: ViewId, languages: &[String]);
    /// `webContents.replaceMisspelling(word)`
    fn replace_misspelling(&self, view: ViewId, word: &str);
    /// `webContents.sendInputEvent` of a Space key
    fn send_space(&self, view: ViewId, input: KeyInput);

    /// `webContents.getPrintersAsync()`
    fn printers(&self, view: ViewId) -> Vec<Printer>;
    fn print_window(&self, spec: &PrintWindowSpec) -> Box<dyn PrintSurface>;
    /// `execFile`/`spawn` of a printing tool (`/usr/bin/lp`, `lpoptions`)
    fn run_command(&self, file: &str, args: &[String], stdin: Option<&[u8]>) -> CommandOutcome;
}

/// Which pane of a split a view is
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SplitRole {
    Focus,
    Secondary,
}

impl SplitRole {
    pub fn as_str(self) -> &'static str {
        match self {
            SplitRole::Focus => "focus",
            SplitRole::Secondary => "secondary",
        }
    }
}

pub trait Peers: Send + Sync {
    /// W, the tab manager: `splitRoleOf(view)`
    fn split_role_of(&self, view: ViewId) -> Option<SplitRole>;
    /// W, the tab manager: `focusPaneByWebContents(view)`
    fn focus_pane_of(&self, view: ViewId);
    /// W: `handleDroppedFiles(raw, droppedFilesDeps())` (opens documents,
    /// imports skills, warns); main-core gap: `partitionDropPayload`,
    /// `handleDroppedFiles`
    fn open_dropped_files(&self, raw: &Value);

    /// D1: the view is a sheets tab (`sheetsTabs.get(view)` of `sessionFor`)
    fn sheets_session(&self, view: ViewId) -> bool;
    /// D2: `savePathByWc.get(view)` of the html app
    fn html_document_path(&self, view: ViewId) -> Option<String>;
    /// D2: `savePathByWc.get(view)` of the hwp app
    fn hwp_document_path(&self, view: ViewId) -> Option<String>;
    /// D2: the PDF path the view picked in Save As or was handed headless
    /// (`pdfSaveAsByWc ?? headlessPdfByWc`), taken once
    fn hwp_take_pdf_grant(&self, view: ViewId) -> Option<String>;
    /// D2: the view's document writer was dropped (`tornDownWcIds`)
    fn docs_torn_down(&self, view: ViewId) -> bool;
    /// `isHeadlessMode()`
    fn headless(&self) -> bool;
    /// `runtime.openGeneratedPath?.(path)`: false when the runtime has none
    /// or did not open it
    fn open_generated_path(&self, path: &str) -> bool;
    /// `configuredDefaultSaveDir(app)`
    fn default_save_dir(&self) -> String;

    /// D2, shell/pdf-structure: `storePageFingerprints(context(view), req)`;
    /// answers when the job ends
    fn store_page_fingerprints(&self, view: ViewId, request: Value, reply: Responder);
    /// D1, slides sessions: `listPrivateFontFaces()`
    fn slides_private_font_faces(&self) -> Value;
    /// D1: `getPrivateFontData(id)`; `None` is `null`
    fn slides_private_font_data(&self, id: &Value) -> Option<Vec<u8>>;
    /// D1: the `slides:set-element-font` body over the view's session
    fn slides_set_element_font(&self, view: ViewId, op: &Value) -> Value;
    /// D1: the `slides:apply-theme` body over the view's session
    fn slides_apply_theme(&self, view: ViewId, op: &Value) -> Value;
}

/// main-core gaps: packages/font-metrics and apps/pdf/src/main/text-edit.ts
pub trait FontQueries: Send + Sync {
    /// `familyInfoFor(families)`
    fn family_info_for(&self, families: &Value) -> Value;
    /// `familyVerticalMetrics(family)`; `None` is `null`
    fn family_vertical_metrics(&self, family: &str) -> Option<Value>;
    /// `familyAliases(name)`
    fn family_aliases(&self, name: &str) -> Vec<String>;
    /// `listEditFonts()`
    fn list_edit_fonts(&self) -> Vec<String>;
}

pub type MHostRef = Arc<dyn MHost>;
pub type PeersRef = Arc<dyn Peers>;
pub type FontQueriesRef = Arc<dyn FontQueries>;
