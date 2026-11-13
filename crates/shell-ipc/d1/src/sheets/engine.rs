//! What the sheets handlers need that is not in Rust yet, and what the shell
//! decides for them. Two traits, both inserted into `Hosts` by the shell:
//!
//! - [`WorkbookEngine`]: the xlsx sidecar's request surface and the
//!   `xlsx-gateway` readers the handlers call (`XlsxSidecarClient`,
//!   `xlsx-package-io`, `csv-import`, pivot, slicer, connections, ODS export,
//!   the PDF print pass). Methods block; handlers call them from workers.
//!   Zod parsing of a request or answer the TypeScript does with a deep
//!   schema (`workbookSaveRequestSchema`, the sidecar's result schemas) is
//!   the engine's: it answers a `ZodError` as an `IpcError` with no name.
//! - [`SheetsShell`]: the hooks `sheets-main.ts` exposes to the shell window
//!   (`setSheetsWorkbookOpenedHook` and its kin) and the process facts it
//!   reads from Electron (`app.getVersion()`, the system locale, timers).

use std::sync::Arc;

use shell_contract::{IpcError, IpcValue, ViewId, WindowId};

pub type EngineResult<T> = Result<T, IpcError>;

/// `new Error(message)`
pub fn engine_error(message: impl Into<String>) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: message.into(),
    }
}

/// One sheet of an opened workbook (`worksheetMetadataSchema`, the fields
/// the handlers read)
#[derive(Clone, Debug, PartialEq)]
pub struct OpenedSheet {
    pub id: String,
    pub name: String,
    pub source_xml_bytes: Option<f64>,
}

/// The sidecar's `open` answer after `sidecarOpenResultSchema` (every field
/// of `WorkbookFile` except `sha256` and `readOnly`)
#[derive(Clone, Debug, PartialEq)]
pub struct OpenedWorkbook {
    /// the object as the schema gives it back, keys in schema order
    pub value: IpcValue,
    pub session_id: String,
    pub sheets: Vec<OpenedSheet>,
}

/// One entry of a recalculation's edits
#[derive(Clone, Debug, PartialEq)]
pub struct RecalcEdit {
    pub sheet: String,
    pub row: f64,
    pub column: f64,
    pub input: String,
}

/// One range a recalculation reads back
#[derive(Clone, Debug, PartialEq)]
pub struct RecalcRead {
    pub sheet: String,
    pub range: IpcValue,
}

/// One cell of the sidecar's recalculation answer (`sidecarRecalcResultSchema`)
#[derive(Clone, Debug, PartialEq)]
pub struct RecalcCell {
    pub sheet: String,
    pub row: f64,
    pub column: f64,
    pub formatted: String,
    pub number: Option<f64>,
    pub is_error: bool,
    pub is_formula: bool,
}

/// What `convertToOds` answers (`OdsConversionResult`)
#[derive(Clone, Debug, PartialEq)]
pub struct OdsConversion {
    /// the whole answer, for the export's reply to spread
    pub value: IpcValue,
    pub formulas_dropped: f64,
    /// `dropped.<kind>` in the order macros, charts, images, shapes,
    /// conditionalFormats, validations, pivots, slicers, sparklines, comments
    pub dropped: Vec<(&'static str, f64)>,
}

/// What `convertWorkbook` answers
#[derive(Clone, Debug, PartialEq)]
pub struct Converted {
    pub sheets: f64,
    /// `formulasDropped` when the sidecar reported a count, else 0
    pub formulas_dropped: f64,
}

/// `convertLegacyWorkbook`'s verdict
#[derive(Clone, Debug, PartialEq)]
pub enum LegacyConversion {
    /// a real container, converted by the sidecar
    Workbook {
        formulas_dropped: f64,
    },
    /// an HTML table export, converted here
    Html,
    HtmlNoTable,
    HtmlTooLarge,
}

/// `csvToXlsxBufferForOpen`'s answer
#[derive(Clone, Debug, PartialEq)]
pub struct CsvConverted {
    pub buffer: Vec<u8>,
    pub empty: bool,
}

/// Progress and cancellation of a delimited import
pub struct ImportControl<'a> {
    /// `onProgress`: a `CsvImportProgress` object
    pub on_progress: &'a (dyn Fn(IpcValue) + Sync),
    /// `signal.aborted`
    pub cancelled: &'a (dyn Fn() -> bool + Sync),
}

/// `unlockOfficeFile`'s answer
#[derive(Clone, Debug, PartialEq)]
pub struct Unlocked {
    pub bytes: Vec<u8>,
    pub password: String,
    /// false when Excel's built-in default password opened it
    pub asked: bool,
}

/// Why `unlockOfficeFile` threw
#[derive(Clone, Debug, PartialEq)]
pub enum UnlockFailure {
    /// an `OfficeDecryptError`
    Decrypt,
    Other(IpcError),
}

/// `parseFileToText(filePath)`, the fields the handlers read
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParsedText {
    pub ok: bool,
    /// `kind === 'text'`
    pub is_text: bool,
    pub text: Option<String>,
    pub damaged: bool,
    pub error: Option<String>,
}

pub trait WorkbookEngine: Send + Sync {
    // ---- sessions ----

    /// `client.open(path, documentLocale(), systemShortDate(), { timeoutMs })`
    /// through `sidecarOpenResultSchema`
    fn open(
        &self,
        path: &str,
        locale: &str,
        short_date: &str,
        timeout_ms: Option<f64>,
    ) -> EngineResult<OpenedWorkbook>;
    /// `client.close(sessionId)`
    fn close(&self, session_id: &str) -> EngineResult<()>;
    /// `client.onProcessExit(listener)`: `listener` runs when the sidecar
    /// process dies, on any thread
    fn on_process_exit(&self, listener: Box<dyn Fn() + Send + Sync>);

    // ---- reads (request already shape-checked; the answer through its result schema) ----

    fn read_range(&self, request: &IpcValue) -> EngineResult<IpcValue>;
    fn read_formula_cells(&self, request: &IpcValue) -> EngineResult<IpcValue>;
    fn find_cells(&self, request: &IpcValue) -> EngineResult<IpcValue>;
    fn read_row_outline(&self, request: &IpcValue) -> EngineResult<IpcValue>;
    fn read_media(&self, request: &IpcValue) -> EngineResult<IpcValue>;
    fn list_external_links(&self, path: &str, base_dir: &str) -> EngineResult<IpcValue>;
    /// `allowRemoteSources` is always true: the panel's Update button is the person asking
    fn update_external_links(&self, path: &str, base_dir: &str) -> EngineResult<IpcValue>;
    fn read_external_link_usage(&self, path: &str) -> EngineResult<IpcValue>;
    /// `client.recalcCells` through `sidecarRecalcResultSchema`
    fn recalc_cells(
        &self,
        path: &str,
        edits: &[RecalcEdit],
        reads: &[RecalcRead],
    ) -> EngineResult<Vec<RecalcCell>>;

    // ---- gateway readers over a session snapshot (answer through the result schema) ----

    /// `parsePivotDefinition` of the two parts
    fn read_pivot_definition(
        &self,
        snapshot: &str,
        pivot_path: &str,
        cache_path: &str,
    ) -> EngineResult<IpcValue>;
    fn read_slicer_state(&self, snapshot: &str) -> EngineResult<IpcValue>;
    /// `{ connections: refreshableQueriesOf(read) }`
    fn list_connections(&self, snapshot: &str) -> EngineResult<IpcValue>;
    /// `connectionSourceOf` then `fetchRemoteTable`; an unknown id throws
    /// `This workbook has no refreshable web query with that id.`
    fn refresh_connection(&self, snapshot: &str, connection_id: &str) -> EngineResult<IpcValue>;
    fn read_queries(&self, snapshot: &str) -> EngineResult<IpcValue>;
    /// `readWorkbookRedactionPart`: `{ status: 'absent' | 'unreadable' | 'ok', states? }`
    fn read_redactions(&self, snapshot: &str) -> EngineResult<IpcValue>;

    // ---- writes ----

    /// `saveWorkbookViaSidecar({ client, sourcePath, targetPath, ...resolved })`:
    /// patches the snapshot `source` into `target`; `resolved` is
    /// `resolveWorkbookSave(sheetNames, request)`. Answers the mutation's
    /// `touchedEntries`.
    fn write_workbook(
        &self,
        source: &str,
        target: &str,
        resolved: &serde_json::Value,
    ) -> EngineResult<IpcValue>;
    fn convert_to_ods(&self, source: &str, target: &str) -> EngineResult<OdsConversion>;
    fn convert_workbook(&self, path: &str, target: &str) -> EngineResult<Converted>;
    fn convert_legacy_workbook(
        &self,
        path: &str,
        target: &str,
        preferred_charset: Option<&str>,
    ) -> EngineResult<LegacyConversion>;
    /// `decodeCsvBuffer` then `csvToXlsxBufferForOpen`
    fn csv_to_xlsx_for_open(
        &self,
        csv: &[u8],
        charset: Option<&str>,
        sheet_name: &str,
        delimiter: Option<char>,
        control: Option<&ImportControl<'_>>,
    ) -> EngineResult<CsvConverted>;
    /// `csvToXlsxBufferForOpen('', 'Sheet1')`: the blank archive of an empty file
    fn blank_xlsx(&self) -> EngineResult<Vec<u8>>;
    /// `sheetCsvToXlsxBuffer(content, sheetName)`
    fn sheet_csv_to_xlsx(&self, content: &str, sheet_name: &str) -> EngineResult<Vec<u8>>;
    /// `promoteFileAtomically(from, to)`
    fn promote_file_atomically(&self, from: &str, to: &str) -> EngineResult<()>;

    // ---- Office encryption (`@seuoffice/electron-utils/office-encryption`) ----

    fn is_cfb_header(&self, head: &[u8]) -> bool;
    fn is_encrypted_office_file(&self, bytes: &[u8]) -> bool;
    fn encrypt_ooxml(&self, bytes: &[u8], password: &str) -> EngineResult<Vec<u8>>;
    /// Excel's default password first, then `ask(retry)` until a password
    /// opens the file (`None` answers a cancelled prompt)
    fn unlock_office_file(
        &self,
        bytes: &[u8],
        ask: &mut dyn FnMut(bool) -> Result<Option<String>, UnlockFailure>,
    ) -> Result<Option<Unlocked>, UnlockFailure>;

    // ---- PDF ----

    /// `exportPdf`'s hidden window: `html` (template faces already added) is
    /// loaded with scripting off and `renderPdf` prints it, with the
    /// first/even header variants stitched
    fn render_pdf(&self, html: &str, request: &IpcValue) -> EngineResult<Vec<u8>>;

    // ---- schemas (the deep zod parses) ----

    /// `workbookSaveRequestSchema.parse(input)`: the request as the schema returns it
    fn parse_save_request(&self, input: &IpcValue) -> EngineResult<IpcValue>;
    /// `workbookExportPdfRequestSchema.parse(input)`
    fn parse_export_pdf_request(&self, input: &IpcValue) -> EngineResult<IpcValue>;
    /// `saveEditsChunkArraySchema.parse(JSON.parse(editsJson))`: the edits
    fn parse_edits_chunk(&self, edits_json: &str) -> EngineResult<Vec<serde_json::Value>>;

    // ---- attachments ----

    /// `parseFileToText(filePath)`
    fn parse_file_to_text(&self, path: &str) -> ParsedText;
    /// `diagramPictureExtOf(filePath)`: `drawio.svg` or `drawio.png` when the
    /// file is named so and holds its diagram
    fn diagram_picture_ext_of(&self, path: &str) -> Option<&'static str>;
}

pub type WorkbookEngineHost = Arc<dyn WorkbookEngine>;

/// The prompt window for one encrypted file (`SheetsPasswordPrompt`)
pub trait PasswordPrompt: Send + Sync {
    /// one attempt: the typed password, or `None` when the person cancels;
    /// `retry` marks a second attempt after a wrong password
    fn ask(&self, retry: bool) -> Option<String>;
    fn close(&self);
}

/// What `createDocument` of the runtime answers (`WorkbookCreateDocumentResult`)
pub type CreateDocumentAnswer = IpcValue;

pub trait SheetsShell: Send + Sync {
    /// `workbookOpenedHook(wc, path)`: the tab title and recent files
    fn workbook_opened(&self, view: ViewId, path: &str);
    /// `activateTabHook(wcId)`
    fn activate_tab(&self, view: ViewId);
    /// `passwordPromptFactory(parent, fileName)`; `None` in a standalone run
    fn password_prompt(
        &self,
        parent: Option<WindowId>,
        file_name: &str,
    ) -> Option<Box<dyn PasswordPrompt>>;
    /// `isHeadlessMode()`
    fn is_headless(&self) -> bool;
    /// `runtime.newDocumentDir(wcId)`: the project folder of the view's panel
    fn new_document_dir(&self, view: ViewId) -> Option<String>;
    /// `runtime.writeNewDocument(wcId, fileName, bytes)`: the path written, or
    /// `None` when the panel has no project
    fn write_new_document(
        &self,
        view: ViewId,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<Option<String>, String>;
    /// `runtime.createDocument(request, wcId)`; `None` when the host has none
    fn create_document(&self, request: &IpcValue, view: ViewId) -> Option<CreateDocumentAnswer>;
    /// `runtime.openGeneratedPath(path)`: opened in a tab (true) or not
    fn open_generated_path(&self, path: &str) -> bool;
    /// `assertFileSaved(path)`: an error message when the file is open with unsaved changes
    fn assert_file_saved(&self, path: &str) -> Result<(), String>;
    /// `isPathOpenElsewhere(path)`: the split-view probe
    fn is_path_open_elsewhere(&self, path: &str) -> bool;
    /// `shortDatePatternForSystemLocale(app.getSystemLocale())`
    fn short_date_pattern(&self) -> String;
    /// the process-wide requested locale `documentLocale()` reads (`getRequestedLocale()`)
    fn requested_locale(&self) -> String;
    /// `delimitedImportLimit()`: the ceiling of a .csv/.tsv import, in bytes (the shell owns the setting)
    fn delimited_import_limit(&self) -> f64;
    /// `app.getVersion()`
    fn app_version(&self) -> String;
    /// `setTimeout(job, ms)` on the core thread
    fn after(&self, ms: u64, job: Box<dyn FnOnce() + Send>);
    /// `sheetsTemplateFontsDir()`: the bundled template faces' folder
    fn template_fonts_dir(&self) -> String;
}

pub type SheetsShellHost = Arc<dyn SheetsShell>;

/// A screen source the capturer lists (`desktopCapturer.getSources`)
#[derive(Clone, Debug, PartialEq)]
pub struct ScreenSource {
    pub id: String,
    pub name: String,
    /// data URL, empty when the OS returned none
    pub thumbnail: String,
}

/// A full-size capture
#[derive(Clone, Debug, PartialEq)]
pub struct ScreenImage {
    pub png: Vec<u8>,
    pub width: f64,
    pub height: f64,
}

/// `desktopCapturer`, `screen` and `systemPreferences` for the chat's screen attachments
pub trait ScreenCapture: Send + Sync {
    /// macOS only: `systemPreferences.getMediaAccessStatus('screen')`; every other platform answers `granted`
    fn media_access_status(&self) -> String;
    /// `getSources({ types: ['screen', 'window'], thumbnailSize: 320x200 })`
    /// without the window of `exclude` (the asking view's own window)
    fn list_sources(&self, exclude: Option<WindowId>) -> Vec<ScreenSource>;
    /// the source `id` at the largest display's physical size (at most
    /// 4096 per side), `None` when it is gone or its thumbnail is empty. A PNG
    /// over 20 MiB comes back halved in width.
    fn capture(&self, id: &str) -> Option<ScreenImage>;
}

pub type ScreenCaptureHost = Arc<dyn ScreenCapture>;
