//! What the Word editor reaches that is not in Rust yet ([`DocsEngine`]: the
//! JavaScript libraries and the main-process modules still to port) and what
//! the shell does for it beyond the shared hosts ([`DocsShell`]: shell hooks,
//! menus, Electron calls the shared hosts do not cover). The shell implements
//! both; [`fakes`] answers from a case for the tests and ipc-probe.

use std::sync::Arc;
use std::time::Duration;

use main_core::docs::doc_format::Materialized;
use main_core::docs::hwp_export::{HwpConversion, HwpError, HwpFormat};
use main_core::docs::lazy_media::{LazyMediaBody, OpenedLazyDocx};
use main_core::packages::electron_utils::safe_remote_url::Response;
use main_core::packages::i18n::Lang;
use shell_contract::ViewId;
use shell_contract::runtime::CancelToken;

/// Why `decryptDocx` refused (`DocxDecryptError`): `reason` and `message`
#[derive(Clone, Debug, PartialEq)]
pub struct DecryptError {
    /// `'wrong-password'` or `'unsupported'`
    pub reason: &'static str,
    pub message: String,
}

/// What `docs:analyze-media` hands to `analyzeMediaTool`
#[derive(Clone, Debug, PartialEq)]
pub struct AnalyzeMediaRequest {
    /// `SETTINGS_PATH()`: `<userData>/ai-settings.json`
    pub settings_path: String,
    pub media_urls: Vec<String>,
    pub requirements: String,
    /// `documentMediaRoots(openDocByWc.get(id), <temp>/seuoffice-pasted)`'s two inputs
    pub open_doc: Option<String>,
    pub pasted_dir: String,
}

/// The libraries of the Word editor's main process. Every method runs on a
/// worker: it takes and returns owned data. An `Err(String)` is the message
/// of what the TypeScript threw.
pub trait DocsEngine: Send + Sync {
    /// `openLazyDocx(filePath, wcId)` of `lazy-media.ts`: the slim document
    /// and the file's hash, or `None` when the file is not served lazily
    fn open_lazy_docx(&self, path: &str, view: ViewId) -> Option<OpenedLazyDocx>;
    /// `adoptLazyMediaHashes(bytes, filePath, wcId)` (never throws)
    fn adopt_lazy_media_hashes(&self, bytes: &[u8], path: &str, view: ViewId);
    /// `materializeLazyDocx(bytes)`: the lazily served pictures put back
    fn materialize_lazy_docx(&self, bytes: Vec<u8>) -> Result<Materialized, String>;
    /// `pointLazyMediaAt(hashes, filePath, wcId, plain)`
    fn point_lazy_media_at(
        &self,
        hashes: &[String],
        path: &str,
        view: ViewId,
        plain: Option<Vec<u8>>,
    );
    /// `moveLazyMediaSource(oldPath, newPath)`
    fn move_lazy_media_source(&self, old_path: &str, new_path: &str);
    /// `forgetLazyMediaOwner(wcId)`
    fn forget_lazy_media_owner(&self, view: ViewId);
    /// `readLazyMedia(url)`
    fn read_lazy_media(&self, url: &str) -> Result<Option<LazyMediaBody>, String>;
    /// `handOffBytes(bytes)` of `byte-handoff.ts`: the one-shot URL the media
    /// protocol serves the bytes under
    fn hand_off_bytes(&self, bytes: Vec<u8>) -> String;
    /// `decryptDocx(bytes, password)` of `docx-encryption.ts` (officecrypto-tool)
    fn decrypt_docx(&self, bytes: &[u8], password: &str) -> Result<Vec<u8>, DecryptError>;
    /// `encryptDocx(bytes, password)` (officecrypto-tool, ECMA-376 Agile)
    fn encrypt_docx(&self, bytes: &[u8], password: &str) -> Result<Vec<u8>, String>;
    /// `convertLegacyDocToDocx(bytes).docx` of `packages/doc2docx`
    fn convert_legacy_doc(&self, bytes: Vec<u8>) -> Result<Vec<u8>, String>;
    /// `convertHtmlToDocx({ url }, ElectronBrowserDriver.create(794x1123 @2),
    /// { naturalTableWidth: true }).docx` of `packages/html2docx` for the
    /// page at `html_path`; `Ok(None)` when `timeout` passed first (the
    /// hidden window is destroyed then, as the TypeScript's watchdog does)
    fn html_to_docx(&self, html_path: &str, timeout: Duration) -> Result<Option<Vec<u8>>, String>;
    /// `readMergeDataSource(path)` of `merge-data-source.ts` (xlsx-gateway
    /// readers, `mergeDataFromRows`)
    fn read_merge_data_source(&self, path: &str) -> Result<serde_json::Value, String>;
    /// `withInternalLinks(data, links)` past its empty check: pdf-lib's
    /// `PDFDocument.load`, `addPdfInternalLinks` of `pdf-links.ts`, `save`
    /// (the bytes unchanged when no link was added)
    fn add_pdf_internal_links(
        &self,
        pdf: Vec<u8>,
        links: serde_json::Value,
    ) -> Result<Vec<u8>, String>;
    /// `docs:save-merged-pdf`'s pdf-lib merge: every part's pages in order,
    /// then `addPdfInternalLinks` when `links` is a non-empty array
    fn merge_pdfs(
        &self,
        parts: Vec<Vec<u8>>,
        links: Option<serde_json::Value>,
    ) -> Result<Vec<u8>, String>;
    /// `convertInWorker({ docx, format, wasmPath: rhwpWasmPath() }, ...)` of
    /// `hwp-export.ts` (`@seuoffice/docx2hwp` in a single-use worker)
    fn convert_to_hwp(&self, docx: Vec<u8>, format: HwpFormat) -> Result<HwpConversion, HwpError>;
    /// `analyzeMediaTool(settingsPath, { mediaUrls, requirements }, { mediaRoots,
    /// context: screenToolContext(), signal })` of `@seuoffice/ai-search`;
    /// `cancel` is the signal of `withMediaCallSignal`
    fn analyze_media(
        &self,
        request: AnalyzeMediaRequest,
        cancel: CancelToken,
    ) -> Result<serde_json::Value, String>;
}

pub type DocsEngineHost = Arc<dyn DocsEngine>;

/// What the shell does for the Word editor that the shared hosts do not:
/// the hooks `setDocsShellHooks` and friends injected, the app menu, and the
/// Electron calls of `docs-main.ts` no shared host has.
pub trait DocsShell: Send + Sync {
    /// `getUiLang()`
    fn ui_lang(&self) -> Lang;
    /// `isHeadlessMode()`
    fn is_headless(&self) -> bool;
    /// `crypto.randomUUID()` (recovery slots, temp names, write-copies-now tokens)
    fn random_uuid(&self) -> String;
    /// `Date.now()` (the recovery copies' metadata)
    fn now_ms(&self) -> f64;
    /// `fileSavedHook(wc, path)`: the path the shell filed the new file under
    fn file_saved(&self, view: ViewId, path: &str) -> Option<String>;
    /// `fileOpenedHook(wcId, path)`
    fn file_opened(&self, view: ViewId, path: &str);
    /// `shellHooks.newDocumentDir(wcId)`: a project folder for a new document
    fn new_document_dir(&self, view: ViewId) -> Option<String>;
    /// `shellHooks.writeNewDocument`: `None` when there is no such hook
    /// (`write` undefined in the TypeScript); `Some(Ok(None))` when the panel
    /// has no project. Runs on a worker.
    fn write_new_document(
        &self,
        view: ViewId,
        file_name: &str,
        bytes: Vec<u8>,
    ) -> Option<Result<Option<String>, String>>;
    /// `shellHooks.openAiDocTabFor(content, owner)` (else `openAiDocTab`)
    fn open_ai_doc_tab(&self, content: serde_json::Value, owner: ViewId);
    /// `shellHooks.openGeneratedPath(path)`: `false` when no tab took it
    fn open_generated_path(&self, path: &str) -> Result<bool, String>;
    /// `activeDocsWebContents()`
    fn active_docs_view(&self) -> Option<ViewId>;
    /// `Menu.getApplicationMenu()?.getMenuItemById(id).checked = checked`
    fn set_menu_item_checked(&self, id: &str, checked: bool);
    /// `...getMenuItemById(id).enabled = enabled`
    fn set_menu_item_enabled(&self, id: &str, enabled: bool);
    /// `buildDocsMenu()` (File > Open Recent follows recent.json)
    fn rebuild_docs_menu(&self);
    /// `webContents.capturePage(rect)` then `isEmpty() ? null : toPNG()`
    fn capture_rect(
        &self,
        view: ViewId,
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    ) -> Result<Option<Vec<u8>>, String>;
    /// `nativeImage.createFromBuffer(bytes)`: its `getSize()`, `None` when `isEmpty()`
    fn image_size(&self, bytes: &[u8]) -> Option<(f64, f64)>;
    /// `clipboard.write({ image: nativeImage.createFromBuffer(bytes), html })`
    fn write_clipboard_image(&self, bytes: &[u8], html: &str);
    /// `printHtmlToPdf(html, () => new BrowserWindow({ show: false, sandbox, javascript: false }))`
    fn print_html_to_pdf(&self, html: String) -> Result<Vec<u8>, String>;
    /// `net.fetch(url)` (it must reach the app's media schemes too); `Err`
    /// is `String(err)` of the rejection. Runs on a worker.
    fn net_fetch(&self, url: &str) -> Result<Box<dyn Response + Send>, String>;
}

pub type DocsShellHost = Arc<dyn DocsShell>;

#[cfg(test)]
pub(crate) use fake::Fake;
#[cfg(any(test, feature = "probe"))]
pub(crate) use fake::fakes;

#[cfg(any(test, feature = "probe"))]
mod fake {
    use std::sync::Mutex;

    use main_core::packages::electron_utils::safe_remote_url::FetchError;
    use serde_json::{Value, json};

    use super::*;

    /// The case's host log (tools/ipc-diff/README.md, "Batch hosts")
    type ProbeLog = Arc<Mutex<Vec<Value>>>;

    /// The fake of both hosts, mirrored by tools/ipc-diff/groups/d2/docs-fakes.ts.
    /// `case` is `hosts.d2.docs`: `case[<method name>]` is the answer, an
    /// array is consumed one element per call; absent, a neutral answer.
    /// Bytes are written as a string (its UTF-8 bytes). Shapes per method:
    /// - `open_lazy_docx`: `{bytes, hash}` or null (default: null)
    /// - `materialize_lazy_docx`: `{bytes, hashes}` or `{error}` (default:
    ///   the input, no hashes)
    /// - `read_lazy_media`: `{body, mime}` or null (default: null)
    /// - `hand_off_bytes`: a string (default: `handoff:<the bytes in hex>`)
    /// - `decrypt_docx`: a string (the plain bytes) or `{error}`; an error
    ///   naming "password is incorrect" is a wrong password (default:
    ///   `no engine`)
    /// - `encrypt_docx`: a string (default: `ENC:` + the input)
    /// - `convert_legacy_doc`, `html_to_docx`, `print_html_to_pdf`,
    ///   `add_pdf_internal_links`, `merge_pdfs`: a string or `{error}`
    ///   (defaults: the input; `docx`; `%PDF`; the parts joined)
    /// - `read_merge_data_source`, `analyze_media`: a value or `{error}`
    ///   (defaults: `{path}`, `{ok:true}`)
    /// - `convert_to_hwp`: `{bytes, losses:[{feature,kind,count}]}` or
    ///   `{code, error}` (default: `hwp:` + the input, no losses)
    /// - `now` (the clock, 1700000000000), `ui_lang` (`"en"`), `is_headless`
    ///   (false), `file_saved` (null), `new_document_dir` (null),
    ///   `write_new_document` (null; `"none"` for no hook),
    ///   `open_generated_path` (false), `active_docs_view` (null),
    ///   `capture_rect` (null), `image_size` (`[w, h]`, default `[1, 1]` for
    ///   non-empty bytes), `net_fetch` (`{status, body, type}` or `{error}`,
    ///   default `TypeError: fetch failed`)
    ///
    /// Each call is one JSON line named after the TypeScript function it
    /// stands for, in `calls` and in the case's log when there is one.
    #[derive(Clone)]
    pub(crate) struct Fake {
        case: Arc<Mutex<Value>>,
        pub calls: Arc<Mutex<Vec<Value>>>,
        probe: Option<ProbeLog>,
        uuids: Arc<Mutex<u64>>,
    }

    impl Fake {
        pub fn new(case: &Value) -> Self {
            Fake {
                case: Arc::new(Mutex::new(case.clone())),
                calls: Arc::default(),
                probe: None,
                uuids: Arc::default(),
            }
        }

        fn log(&self, line: Value) {
            if let Some(probe) = &self.probe {
                probe.lock().unwrap().push(line.clone());
            }
            self.calls.lock().unwrap().push(line)
        }

        /// the answer for `method`, if the case has one
        fn answer(&self, method: &str) -> Option<Value> {
            let mut case = self.case.lock().unwrap();
            let slot = case.get_mut(method)?;
            match slot {
                Value::Array(items) if method != "image_size" => {
                    (!items.is_empty()).then(|| items.remove(0))
                }
                other => Some(other.clone()),
            }
        }
    }

    fn bytes(v: &Value) -> Vec<u8> {
        match v {
            Value::String(s) => s.as_bytes().to_vec(),
            Value::Array(items) => items
                .iter()
                .filter_map(|n| n.as_u64())
                .map(|n| n as u8)
                .collect(),
            _ => Vec::new(),
        }
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// a number as JavaScript prints it (an integer has no fraction)
    fn num(n: f64) -> Value {
        if n.fract() == 0.0 && n.abs() < 9e15 {
            json!(n as i64)
        } else {
            json!(n)
        }
    }

    fn error_of(v: &Value) -> Option<String> {
        v.get("error").and_then(Value::as_str).map(str::to_owned)
    }

    fn bytes_or_error(v: Option<Value>, default: Vec<u8>) -> Result<Vec<u8>, String> {
        match v {
            None => Ok(default),
            Some(v) => match error_of(&v) {
                Some(e) => Err(e),
                None => Ok(bytes(&v)),
            },
        }
    }

    impl DocsEngine for Fake {
        fn open_lazy_docx(&self, path: &str, view: ViewId) -> Option<OpenedLazyDocx> {
            self.log(json!(["openLazyDocx", path, view.0]));
            let v = self.answer("open_lazy_docx")?;
            Some(OpenedLazyDocx {
                bytes: bytes(v.get("bytes")?),
                hash: v.get("hash")?.as_str()?.to_owned(),
            })
        }
        fn adopt_lazy_media_hashes(&self, _bytes: &[u8], path: &str, view: ViewId) {
            self.log(json!(["adoptLazyMediaHashes", path, view.0]))
        }
        fn materialize_lazy_docx(&self, input: Vec<u8>) -> Result<Materialized, String> {
            self.log(json!(["materializeLazyDocx", hex(&input)]));
            match self.answer("materialize_lazy_docx") {
                None => Ok(Materialized {
                    bytes: input,
                    hashes: Vec::new(),
                }),
                Some(v) => match error_of(&v) {
                    Some(e) => Err(e),
                    None => Ok(Materialized {
                        bytes: v.get("bytes").map(bytes).unwrap_or(input),
                        hashes: v
                            .get("hashes")
                            .and_then(Value::as_array)
                            .map(|h| {
                                h.iter()
                                    .filter_map(Value::as_str)
                                    .map(str::to_owned)
                                    .collect()
                            })
                            .unwrap_or_default(),
                    }),
                },
            }
        }
        fn point_lazy_media_at(
            &self,
            hashes: &[String],
            path: &str,
            view: ViewId,
            plain: Option<Vec<u8>>,
        ) {
            self.log(json!([
                "pointLazyMediaAt",
                hashes,
                path,
                view.0,
                plain.is_some()
            ]))
        }
        fn move_lazy_media_source(&self, old_path: &str, new_path: &str) {
            self.log(json!(["moveLazyMediaSource", old_path, new_path]))
        }
        fn forget_lazy_media_owner(&self, view: ViewId) {
            self.log(json!(["forgetLazyMediaOwner", view.0]))
        }
        fn read_lazy_media(&self, url: &str) -> Result<Option<LazyMediaBody>, String> {
            self.log(json!(["readLazyMedia", url]));
            match self.answer("read_lazy_media") {
                None | Some(Value::Null) => Ok(None),
                Some(v) => match error_of(&v) {
                    Some(e) => Err(e),
                    None => Ok(Some(LazyMediaBody {
                        body: v.get("body").map(bytes).unwrap_or_default(),
                        mime: v
                            .get("mime")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_owned(),
                    })),
                },
            }
        }
        fn hand_off_bytes(&self, input: Vec<u8>) -> String {
            match self.answer("hand_off_bytes") {
                Some(Value::String(s)) => s,
                _ => format!("handoff:{}", hex(&input)),
            }
        }
        fn decrypt_docx(&self, _bytes: &[u8], password: &str) -> Result<Vec<u8>, DecryptError> {
            self.log(json!(["officeCrypto.decrypt", password]));
            match self.answer("decrypt_docx") {
                Some(Value::String(s)) => Ok(s.into_bytes()),
                v => {
                    let message = v.as_ref().and_then(error_of).unwrap_or("no engine".into());
                    Err(DecryptError {
                        reason: if message.contains("password is incorrect") {
                            "wrong-password"
                        } else {
                            "unsupported"
                        },
                        message,
                    })
                }
            }
        }
        fn encrypt_docx(&self, input: &[u8], password: &str) -> Result<Vec<u8>, String> {
            self.log(json!(["officeCrypto.encrypt", password]));
            let mut out = b"ENC:".to_vec();
            out.extend_from_slice(input);
            bytes_or_error(self.answer("encrypt_docx"), out)
        }
        fn convert_legacy_doc(&self, input: Vec<u8>) -> Result<Vec<u8>, String> {
            self.log(json!(["convertLegacyDocToDocx", hex(&input)]));
            bytes_or_error(self.answer("convert_legacy_doc"), input)
        }
        fn html_to_docx(
            &self,
            _html_path: &str,
            _timeout: Duration,
        ) -> Result<Option<Vec<u8>>, String> {
            self.log(json!(["convertHtmlToDocx"]));
            match self.answer("html_to_docx") {
                Some(Value::Null) => Ok(None),
                v => bytes_or_error(v, b"docx".to_vec()).map(Some),
            }
        }
        fn read_merge_data_source(&self, path: &str) -> Result<Value, String> {
            self.log(json!(["readMergeDataSource", path]));
            match self.answer("read_merge_data_source") {
                None => Ok(json!({ "path": path })),
                Some(v) => error_of(&v).map_or(Ok(v), Err),
            }
        }
        fn add_pdf_internal_links(&self, pdf: Vec<u8>, links: Value) -> Result<Vec<u8>, String> {
            self.log(json!(["addPdfInternalLinks", links]));
            bytes_or_error(self.answer("add_pdf_internal_links"), pdf)
        }
        fn merge_pdfs(&self, parts: Vec<Vec<u8>>, links: Option<Value>) -> Result<Vec<u8>, String> {
            if let Some(links) = links {
                self.log(json!(["addPdfInternalLinks", links]));
                // the links land in the merged document, whose pages are the answer
                if let Some(e) = self
                    .answer("add_pdf_internal_links")
                    .as_ref()
                    .and_then(error_of)
                {
                    return Err(e);
                }
            }
            bytes_or_error(self.answer("merge_pdfs"), parts.concat())
        }
        fn convert_to_hwp(
            &self,
            docx: Vec<u8>,
            format: HwpFormat,
        ) -> Result<HwpConversion, HwpError> {
            self.log(json!(["convertInWorker", format.as_str()]));
            let mut out = b"hwp:".to_vec();
            out.extend_from_slice(&docx);
            match self.answer("convert_to_hwp") {
                None => Ok(HwpConversion {
                    bytes: out,
                    losses: Vec::new(),
                }),
                Some(v) => match v.get("code").and_then(Value::as_str) {
                    Some(code) => Err(HwpError::Failure {
                        code: code.to_owned(),
                        message: error_of(&v).unwrap_or_default(),
                    }),
                    None => Ok(HwpConversion {
                        bytes: v.get("bytes").map(bytes).unwrap_or(out),
                        losses: v
                            .get("losses")
                            .and_then(Value::as_array)
                            .map(|l| {
                                l.iter()
                                    .map(|l| main_core::docs::hwp_export::Loss {
                                        feature: l["feature"].as_str().unwrap_or("").to_owned(),
                                        kind: l["kind"].as_str().unwrap_or("").to_owned(),
                                        count: l["count"].as_f64().unwrap_or(1.0),
                                    })
                                    .collect()
                            })
                            .unwrap_or_default(),
                    }),
                },
            }
        }
        fn analyze_media(
            &self,
            request: AnalyzeMediaRequest,
            _cancel: CancelToken,
        ) -> Result<Value, String> {
            // documentMediaRoots(openDoc, pasted): the document's folder first
            let roots: Vec<String> = match &request.open_doc {
                Some(open) => vec![
                    jscompat::node_path::host::dirname(open),
                    request.pasted_dir.clone(),
                ],
                None => vec![request.pasted_dir.clone()],
            };
            self.log(json!([
                "analyzeMediaTool",
                request.settings_path,
                request.media_urls,
                request.requirements,
                roots
            ]));
            match self.answer("analyze_media") {
                None => Ok(json!({ "ok": true })),
                Some(v) => error_of(&v).map_or(Ok(v), Err),
            }
        }
    }

    /// One `net.fetch` answer: all of the body in one chunk
    struct FakeResponse {
        status: u16,
        mime: Option<String>,
        body: Option<Vec<u8>>,
    }

    impl Response for FakeResponse {
        fn status(&self) -> u16 {
            self.status
        }
        fn header(&self, name: &str) -> Option<String> {
            (name.eq_ignore_ascii_case("content-type"))
                .then(|| self.mime.clone())
                .flatten()
        }
        fn has_body(&self) -> bool {
            true
        }
        fn cancel_body(&mut self) {}
        fn read_chunk(&mut self) -> Result<Option<Vec<u8>>, FetchError> {
            Ok(self.body.take())
        }
        fn array_buffer(&mut self) -> Result<Vec<u8>, FetchError> {
            Ok(self.body.take().unwrap_or_default())
        }
    }

    impl DocsShell for Fake {
        fn ui_lang(&self) -> Lang {
            match self.case.lock().unwrap()["ui_lang"].as_str() {
                Some("ko") => Lang::Ko,
                _ => Lang::En,
            }
        }
        fn is_headless(&self) -> bool {
            self.case.lock().unwrap()["is_headless"] == Value::Bool(true)
        }
        /// `00000000-0000-4000-8000-<n>`: the n-th id of the case
        fn random_uuid(&self) -> String {
            let mut n = self.uuids.lock().unwrap();
            *n += 1;
            format!("00000000-0000-4000-8000-{:012x}", *n)
        }
        /// the case's `now` (default 1700000000000)
        fn now_ms(&self) -> f64 {
            self.case.lock().unwrap()["now"]
                .as_f64()
                .unwrap_or(1_700_000_000_000.0)
        }
        fn file_saved(&self, view: ViewId, path: &str) -> Option<String> {
            self.log(json!(["fileSavedHook", view.0, path]));
            self.answer("file_saved")
                .and_then(|v| v.as_str().map(str::to_owned))
        }
        fn file_opened(&self, view: ViewId, path: &str) {
            self.log(json!(["fileOpenedHook", view.0, path]))
        }
        fn new_document_dir(&self, view: ViewId) -> Option<String> {
            self.log(json!(["newDocumentDir", view.0]));
            self.answer("new_document_dir")
                .and_then(|v| v.as_str().map(str::to_owned))
        }
        fn write_new_document(
            &self,
            view: ViewId,
            file_name: &str,
            bytes: Vec<u8>,
        ) -> Option<Result<Option<String>, String>> {
            if self.case.lock().unwrap()["write_new_document"] == "none" {
                return None;
            }
            self.log(json!(["writeNewDocument", view.0, file_name, hex(&bytes)]));
            match self.answer("write_new_document") {
                Some(Value::String(s)) => {
                    // the shell writes the file into the project folder
                    std::fs::write(&s, &bytes).ok()?;
                    Some(Ok(Some(s)))
                }
                Some(v) if error_of(&v).is_some() => Some(Err(error_of(&v).unwrap())),
                _ => Some(Ok(None)),
            }
        }
        fn open_ai_doc_tab(&self, content: Value, owner: ViewId) {
            self.log(json!(["openAiDocTabFor", content, owner.0]))
        }
        fn open_generated_path(&self, path: &str) -> Result<bool, String> {
            self.log(json!(["openGeneratedPath", path]));
            Ok(self.answer("open_generated_path") == Some(Value::Bool(true)))
        }
        fn active_docs_view(&self) -> Option<ViewId> {
            self.case.lock().unwrap()["active_docs_view"]
                .as_u64()
                .map(|n| ViewId(n as u32))
        }
        fn set_menu_item_checked(&self, id: &str, checked: bool) {
            self.log(json!(["MenuItem.checked", id, checked]))
        }
        fn set_menu_item_enabled(&self, id: &str, enabled: bool) {
            self.log(json!(["MenuItem.enabled", id, enabled]))
        }
        /// the menu is rebuilt without a trace (Electron's `Menu` is inert in the comparison)
        fn rebuild_docs_menu(&self) {}
        fn capture_rect(
            &self,
            view: ViewId,
            x: f64,
            y: f64,
            width: f64,
            height: f64,
        ) -> Result<Option<Vec<u8>>, String> {
            self.log(json!([
                "webContents.capturePage",
                view.0,
                { "x": num(x), "y": num(y), "width": num(width), "height": num(height) }
            ]));
            match self.answer("capture_rect") {
                None | Some(Value::Null) => Ok(None),
                v => bytes_or_error(v, Vec::new()).map(|b| (!b.is_empty()).then_some(b)),
            }
        }
        fn image_size(&self, input: &[u8]) -> Option<(f64, f64)> {
            match self.answer("image_size") {
                Some(Value::Array(wh)) if wh.len() == 2 => Some((wh[0].as_f64()?, wh[1].as_f64()?)),
                Some(Value::Null) => None,
                _ => (!input.is_empty()).then_some((1.0, 1.0)),
            }
        }
        fn write_clipboard_image(&self, _input: &[u8], html: &str) {
            self.log(json!(["clipboard.write", { "html": html, "text": null }]))
        }
        fn print_html_to_pdf(&self, _html: String) -> Result<Vec<u8>, String> {
            self.log(json!(["printHtmlToPdf"]));
            bytes_or_error(self.answer("print_html_to_pdf"), b"%PDF".to_vec())
        }
        fn net_fetch(&self, url: &str) -> Result<Box<dyn Response + Send>, String> {
            self.log(json!(["net.fetch", url]));
            match self.answer("net_fetch") {
                Some(v) if error_of(&v).is_none() => Ok(Box::new(FakeResponse {
                    status: v.get("status").and_then(Value::as_u64).unwrap_or(200) as u16,
                    mime: v.get("type").and_then(Value::as_str).map(str::to_owned),
                    body: Some(v.get("body").map(bytes).unwrap_or_default()),
                })),
                Some(v) => Err(format!("Error: {}", error_of(&v).unwrap())),
                None => Err("TypeError: fetch failed".into()),
            }
        }
    }

    /// Inserts one [`Fake`] as both hosts, logging to the case's log
    pub(crate) fn fakes(hosts: &mut shell_contract::Hosts, case: &Value) {
        let mut fake = Fake::new(case);
        fake.probe = hosts.get::<ProbeLog>().cloned();
        hosts.insert::<DocsEngineHost>(Arc::new(fake.clone()));
        hosts.insert::<DocsShellHost>(Arc::new(fake));
    }
}

/// `basename(path)` as Node's posix/win32 path module gives it on this host
pub(crate) fn basename(path: &str) -> String {
    jscompat::node_path::host::basename(path, None)
}
