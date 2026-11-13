//! What the PDF editor reaches that is not in Rust: the engines it calls
//! ([`PdfEngine`]: pdf-lib, pdfium, node-forge, `pdf-crypt`, `pdf-shrink`,
//! ai-search, the structure result store) and what the shell does for it
//! ([`PdfShell`]: the `RuntimePaths` hooks of `configurePdfRuntime`, the
//! split-pane probe, the UI language, folder watching, view reloads).
//!
//! Every method takes and returns owned data, so a handler can run it on a
//! worker. The TypeScript around each call (argument checks, state, the reply
//! shape) stays in the handlers.

use std::sync::Arc;

use main_core::pdf::font_locate::Platform;
use main_core::pdf::note_link::{FoundNoteLink, NoteLink, NoteLinks};
use main_core::pdf::ocr::OcrEnv;
use main_core::pdf::system_certificates::{CertSummary, InPlaceSigner};
use shell_contract::IpcValue;
use shell_contract::ViewId;
use shell_contract::runtime::CancelToken;

/// What a save wrote around: the edits it could not apply (`SavePdfSkips`),
/// each list as the renderer receives it
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SaveSkips {
    pub text_edits: Vec<IpcValue>,
    pub text_inserts: Vec<IpcValue>,
    pub image_edits: Vec<IpcValue>,
}

/// `decryptDocument`'s answer, the fields `pdf:decrypt` passes on
#[derive(Clone, Debug, PartialEq)]
pub struct Decrypted {
    pub bytes: Vec<u8>,
    pub permissions: IpcValue,
    pub needed_password: bool,
    /// `'user' | 'owner'`
    pub unlocked_as: String,
}

/// What `decryptDocument` throws
#[derive(Clone, Debug, PartialEq)]
pub enum DecryptError {
    /// `WrongPasswordError`
    WrongPassword,
    /// `CertificateEncryptionError`
    CertificateEncryption,
    /// any other error, its message
    Other(String),
}

/// `PDFDocument.load` + `shrinkDocument` + `doc.save({ useObjectStreams: true })`
#[derive(Clone, Debug, PartialEq)]
pub struct Shrunk {
    pub bytes: Vec<u8>,
    pub streams_recompressed: f64,
    pub images_downsampled: f64,
}

/// `readPdfText`'s answer as compare uses it
#[derive(Clone, Debug, PartialEq)]
pub struct PdfText {
    pub page_count: f64,
    pub pages: Vec<String>,
}

/// What signs: PKCS#12 bytes with their password, or an OS store that signs
/// in place (`CertMaterial`)
#[derive(Clone, Debug, PartialEq)]
pub enum CertMaterial {
    P12 { p12: Vec<u8>, password: String },
    InPlace(InPlaceSigner),
}

/// The signature options `parseSignOptions` let through
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SignOptions {
    pub reason: Option<String>,
    pub location: Option<String>,
    pub contact_info: Option<String>,
    pub certify_level: Option<u8>,
    pub visible: Option<VisibleSignature>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VisibleSignature {
    pub page_index: f64,
    /// one of `SIGNATURE_POSITIONS`
    pub position: String,
    pub width: f64,
    pub height: f64,
    pub png: Vec<u8>,
}

/// What `signPdf` throws: a `SignError`'s code, or another error's message
#[derive(Clone, Debug, PartialEq)]
pub enum SignFailure {
    Code(String),
    Message(String),
}

/// The libraries the editor calls that Rust does not have yet. `Err(String)`
/// is the message of what the TypeScript function throws.
pub trait PdfEngine: Send + Sync {
    /// `savePdfToPath(sourcePath, targetPath, request)` (save-pdf.ts)
    fn save_pdf_to_path(
        &self,
        source: &str,
        target: &str,
        request: &IpcValue,
    ) -> Result<SaveSkips, String>;
    /// `savePdfBytesToPath(source, targetPath, request)`
    fn save_pdf_bytes_to_path(
        &self,
        source: &[u8],
        target: &str,
        request: &IpcValue,
    ) -> Result<SaveSkips, String>;
    /// `copyPdfToPath(sourcePath, targetPath)`
    fn copy_pdf_to_path(&self, source: &str, target: &str) -> Result<(), String>;
    /// `pdfBytesWithEdits(sourcePath, request)`
    fn pdf_bytes_with_edits(&self, source: &str, request: &IpcValue) -> Result<Vec<u8>, String>;
    /// `pdfBytesWithEditsOf(fileBytes, request)`
    fn pdf_bytes_with_edits_of(&self, file: &[u8], request: &IpcValue) -> Result<Vec<u8>, String>;
    /// `pdfBytesWithEditsFrom(source, request)`
    fn pdf_bytes_with_edits_from(
        &self,
        source: &[u8],
        request: &IpcValue,
    ) -> Result<Vec<u8>, String>;
    /// `readStaticFormFills(bytes)`: `StaticFormFillRecord[]`
    fn read_static_form_fills(&self, bytes: &[u8]) -> Result<IpcValue, String>;
    /// `extractPagesBytes(bytes, pages)`
    fn extract_pages(&self, bytes: &[u8], pages: &IpcValue) -> Result<Vec<u8>, String>;
    /// `insertPdfBytes(target, other, afterPageIndex)`: `{ merged, count }`
    fn insert_pdf(&self, target: &[u8], other: &[u8], after: f64)
    -> Result<(Vec<u8>, f64), String>;
    /// `insertBlankPageBytes(bytes, afterPageIndex)`
    fn insert_blank_page(&self, bytes: &[u8], after: f64) -> Result<Vec<u8>, String>;
    /// `splitPdfBytes(bytes, chunkSize)`
    fn split_pdf(&self, bytes: &[u8], chunk_size: f64) -> Result<Vec<Vec<u8>>, String>;
    /// `mergePagesBytes(bytes, { perSheet, direction, separator })`
    fn merge_pages(
        &self,
        bytes: &[u8],
        per_sheet: f64,
        horizontal: bool,
        separator: bool,
    ) -> Result<Vec<u8>, String>;
    /// `mergePdfBytes(base, others)`: `{ merged, appended }`
    fn merge_pdf(&self, base: &[u8], others: &[Vec<u8>]) -> Result<(Vec<u8>, f64), String>;
    /// `replacePagesBytes(target, other, pages)`: `{ merged, removed, inserted }`
    fn replace_pages(
        &self,
        target: &[u8],
        other: &[u8],
        pages: &IpcValue,
    ) -> Result<(Vec<u8>, IpcValue, IpcValue), String>;
    /// `setPageSizeBytes(bytes, width, height)`
    fn set_page_size(&self, bytes: &[u8], width: f64, height: f64) -> Result<Vec<u8>, String>;
    /// `splitPagesBytes(bytes, perPage)`
    fn split_pages(&self, bytes: &[u8], per_page: f64) -> Result<Vec<u8>, String>;
    /// `cropPagesBytes(bytes, pages, rect)`
    fn crop_pages(
        &self,
        bytes: &[u8],
        pages: &IpcValue,
        rect: &IpcValue,
    ) -> Result<Vec<u8>, String>;
    /// `copiedPagesOf(source, request, positions)` (page-clipboard.ts): the
    /// copied pages' PDF and their count, `None` when no position is a page
    fn copied_pages_of(
        &self,
        source: &[u8],
        request: &IpcValue,
        positions: &IpcValue,
    ) -> Result<Option<(Vec<u8>, f64)>, String>;
    /// `PDFDocument.load(source)` + `shrinkDocument(doc)` + `doc.save` (pdf-shrink.ts)
    fn shrink(&self, source: &[u8]) -> Result<Shrunk, String>;
    /// `decryptDocument(bytes, password)` (pdf-crypt.ts)
    fn decrypt_document(&self, bytes: &[u8], password: &str) -> Result<Decrypted, DecryptError>;
    /// `readAnnotSubjects(bytes)` (annot-subjects.ts): `PdfAnnotSubject[]`
    fn read_annot_subjects(&self, bytes: &[u8]) -> Result<IpcValue, String>;
    /// `listPageImages(bytes)` (image-edit.ts): `PageImageRef[]`
    fn list_page_images(&self, bytes: &[u8]) -> Result<IpcValue, String>;
    /// `renderImagePng(bytes, pageIndex, rect, scale)`: base64 PNG or null
    fn render_image_png(
        &self,
        bytes: &[u8],
        page_index: f64,
        rect: &IpcValue,
        scale: f64,
    ) -> Result<IpcValue, String>;
    /// `renderPagePreviewPng(bytes, request)`: `PagePreviewResult | null`
    fn render_page_preview_png(&self, bytes: &[u8], request: &IpcValue)
    -> Result<IpcValue, String>;
    /// `validateTextEdits(bytes, edits)` (text-edit.ts): `TextEditValidation[]`
    fn validate_text_edits(&self, bytes: &[u8], edits: &IpcValue) -> Result<IpcValue, String>;
    /// `canDrawText(text, font, bold, italic)` (text-edit.ts)
    fn can_draw_text(
        &self,
        text: &str,
        font: Option<&str>,
        bold: bool,
        italic: bool,
    ) -> Result<bool, String>;
    /// `readPdfText(bytes, { password })` (read-text.ts over the pdfium wasm)
    fn read_pdf_text(&self, bytes: &[u8], password: Option<&str>) -> Result<PdfText, String>;
    /// `readPdfSignatures(bytes)` (pdf-signatures.ts): `PdfSignatureInfo[]`
    fn read_pdf_signatures(&self, bytes: &[u8]) -> Result<IpcValue, String>;
    /// `describeCertificate(new X509Certificate(input))` (pdf-signatures.ts),
    /// the reader `listSystemCertificates` and `openSystemSigner` take
    fn describe_certificate(&self, input: &[u8]) -> Option<CertSummary>;
    /// `openCertificate(p12, password)` or `openExternalCertificate(signer)`
    /// (pdf-sign.ts): the chain's `CertificateInfo[]`, or the
    /// `CertificateErrorCode`
    fn open_certificate(&self, material: &CertMaterial) -> Result<Vec<IpcValue>, String>;
    /// `signPdf(bytes, { ...openMaterial(material).sign, ...options })`
    fn sign_pdf(
        &self,
        bytes: &[u8],
        material: &CertMaterial,
        options: &SignOptions,
    ) -> Result<Vec<u8>, SignFailure>;
    /// `generateImageTool(settingsPath, { prompt, aspectRatio }, { mediaRoots:
    /// documentMediaRoots(openPath, pastedDir), context: { path: 'screen',
    /// statuses: sharedSubscriptionStatuses() }, signal })` (ai-search); the
    /// call ends when `cancel` fires
    fn generate_image(
        &self,
        settings_path: &str,
        prompt: &str,
        aspect_ratio: Option<&str>,
        open_path: Option<&str>,
        pasted_dir: &str,
        cancel: &CancelToken,
    ) -> Result<IpcValue, String>;
    /// `ResultStore.readNoteLinks()` (packages/pdf-structure/src/store) of
    /// the store under `user_data`
    fn read_note_links(&self, user_data: &str) -> Result<NoteLinks, String>;
    /// `ResultStore.findNoteLink(pdfPath, docHash)`
    fn find_note_link(
        &self,
        user_data: &str,
        pdf_path: &str,
        doc_hash: &str,
    ) -> Result<Option<FoundNoteLink>, String>;
    /// `ResultStore.setNoteLink(pdfPath, link)`
    fn set_note_link(&self, user_data: &str, pdf_path: &str, link: &NoteLink)
    -> Result<(), String>;
    /// `ResultStore.updateNoteLinkDocHash(pdfPath, docHash)`
    fn update_note_link_doc_hash(
        &self,
        user_data: &str,
        pdf_path: &str,
        doc_hash: &str,
    ) -> Result<bool, String>;
    /// `documentHashOfFile(path)`
    fn document_hash_of_file(&self, path: &str) -> Result<String, String>;
}

pub type PdfEngineHost = Arc<dyn PdfEngine>;

/// What the shell does for the editor: `configurePdfRuntime`'s hooks, the
/// hooks set with `setPdfRedactionSavedHook`/`setPdfRenamedHook`, and the
/// process facts the TypeScript read from Electron and Node.
pub trait PdfShell: Send + Sync {
    /// `getUiLang()`
    fn ui_lang(&self) -> String;
    /// `os.userInfo().username` (what `configuredAuthorName` falls back to)
    fn username(&self) -> Option<String>;
    /// `process.platform`, as the main-core modules distinguish it
    fn platform(&self) -> Platform;
    /// the probe of `isPathOpenElsewhere`: another pane shows `path`
    fn is_path_open_elsewhere(&self, path: &str) -> bool;
    /// `runtime.openGeneratedPath(path)`: a new SeuOffice tab on `path`;
    /// `Err` is what the hook threw
    fn open_generated_path(&self, path: &str) -> Result<bool, String>;
    /// `runtime.createDocument(request, ownerWebContentsId)`; `None` when the
    /// host has no creator (`CreateDocumentResult` otherwise, `Err` = thrown)
    fn create_document(
        &self,
        request: &IpcValue,
        owner: ViewId,
    ) -> Option<Result<IpcValue, String>>;
    /// `runtime.openPdfTools(path, tool)`; `None` when not configured
    fn open_pdf_tools(&self, path: &str, tool: &str) -> Option<bool>;
    /// whether both `runtime.openNote` and `runtime.insertIntoNote` are configured
    fn has_note_hooks(&self) -> bool;
    /// `runtime.openNote(path)`; `Err` is what it threw
    fn open_note(&self, path: &str) -> Result<bool, String>;
    /// `runtime.insertIntoNote(path, text)`; `Err` is what it threw
    fn insert_into_note(&self, path: &str, text: &str) -> Result<bool, String>;
    /// `runtime.newDocumentDir(webContentsId)`: the view's project folder
    fn new_document_dir(&self, view: ViewId) -> Option<String>;
    /// `pdfRedactionSavedHook(wc, path)`: a derived copy became the tab's document
    fn redaction_saved(&self, view: ViewId, path: &str) -> Result<(), String>;
    /// `pdfRenamedHook(wc, oldPath, newPath)`: tab title, recents, projects follow
    fn renamed(&self, view: ViewId, old_path: &str, new_path: &str) -> Result<(), String>;
    /// `contents.reload()`
    fn reload(&self, view: ViewId);
    /// `fs.watch(dir, { persistent: false }, listener)`: `on_event` gets the
    /// changed name (`null` when the platform gives none) on any thread; the
    /// handle closes with [`PdfShell::close_watch`]. `None` when watching failed.
    fn watch_dir(
        &self,
        dir: &str,
        on_event: Box<dyn Fn(Option<String>) + Send + Sync>,
    ) -> Option<u64>;
    /// `watcher.close()`
    fn close_watch(&self, handle: u64);
    /// `crypto.randomUUID()` (the opaque certificate ids a view gets)
    fn random_uuid(&self) -> String;
    /// what `ocr.ts` reads from the process and its own location
    fn ocr_env(&self) -> OcrEnv;
}

pub type PdfShellHost = Arc<dyn PdfShell>;
