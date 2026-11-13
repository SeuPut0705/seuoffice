//! What the PDF tools reach that is not in Rust: one engine trait for the
//! libraries (the structure-job process, the result store, pdf-lib, the
//! office converters, Chromium's picture code) and one trait for the shell
//! (its windows, tabs, settings and strings). Both run what the TypeScript
//! called; the logic around each call stays in the handlers.

use std::path::PathBuf;
use std::sync::Arc;

use shell_contract::app_actions::PdfExport;
use shell_contract::runtime::CancelToken;
use shell_contract::{IpcValue, ViewId, WindowId};

/// A failed job as the runner answers it (`PdfStructureFailure`)
#[derive(Clone, Debug, PartialEq)]
pub struct JobFailure {
    /// `PdfStructureErrorCode`
    pub error: String,
    pub message: Option<String>,
    /// `validRange` of a `page-range` failure: first, last
    pub valid_range: Option<(f64, f64)>,
}

impl JobFailure {
    pub fn new(error: &str, message: Option<&str>) -> Self {
        JobFailure {
            error: error.to_owned(),
            message: message.map(str::to_owned),
            valid_range: None,
        }
    }
}

/// `JobRunOutcome`: the job's `value`, or its failure
pub type JobOutcome = Result<IpcValue, JobFailure>;

/// The `ResultStore` methods the handlers call (packages/pdf-structure/src/store/store.ts)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StoreMethod {
    ListTranslations,
    /// its `blocks` Map comes back as the array of its values
    ReadTranslation,
    UnfinishedJobs,
    /// the Map comes back as the array of its values
    ReadAiReadPages,
    WriteAiReadPage,
    WriteTranslationMeta,
    WriteTranslationBlocks,
    DeleteTranslation,
    WriteJob,
    HeartbeatJob,
    WritePassage,
    DeletePassage,
    WriteHighlightRun,
    WriteHighlightBlocks,
    SetHighlightSuggestionStates,
    DeleteHighlightRun,
    WriteInsights,
    WriteEditedTranslationBlock,
    DeleteTranslationExceptEdited,
    ReadPassages,
    ListHighlightRuns,
    /// the Map comes back as the array of its values
    ReadHighlightBlocks,
    ReadInsights,
    CountEditedTranslationBlocks,
    CountPassages,
    MigrateDocument,
    DeleteDocument,
    ListJobs,
    ReadJob,
}

impl StoreMethod {
    /// The method's TypeScript name
    pub fn name(self) -> &'static str {
        use StoreMethod::*;
        match self {
            ListTranslations => "listTranslations",
            ReadTranslation => "readTranslation",
            UnfinishedJobs => "unfinishedJobs",
            ReadAiReadPages => "readAiReadPages",
            WriteAiReadPage => "writeAiReadPage",
            WriteTranslationMeta => "writeTranslationMeta",
            WriteTranslationBlocks => "writeTranslationBlocks",
            DeleteTranslation => "deleteTranslation",
            WriteJob => "writeJob",
            HeartbeatJob => "heartbeatJob",
            WritePassage => "writePassage",
            DeletePassage => "deletePassage",
            WriteHighlightRun => "writeHighlightRun",
            WriteHighlightBlocks => "writeHighlightBlocks",
            SetHighlightSuggestionStates => "setHighlightSuggestionStates",
            DeleteHighlightRun => "deleteHighlightRun",
            WriteInsights => "writeInsights",
            WriteEditedTranslationBlock => "writeEditedTranslationBlock",
            DeleteTranslationExceptEdited => "deleteTranslationExceptEdited",
            ReadPassages => "readPassages",
            ListHighlightRuns => "listHighlightRuns",
            ReadHighlightBlocks => "readHighlightBlocks",
            ReadInsights => "readInsights",
            CountEditedTranslationBlocks => "countEditedTranslationBlocks",
            CountPassages => "countPassages",
            MigrateDocument => "migrateDocument",
            DeleteDocument => "deleteDocument",
            ListJobs => "listJobs",
            ReadJob => "readJob",
        }
    }
}

/// What a store call threw (`storeFailure` sorts it)
#[derive(Clone, Debug, PartialEq)]
pub enum StoreError {
    /// `StoreWriteError`
    Write(String),
    /// `TypeError`: an argument the store refused
    Type(String),
    /// anything else: its message
    Other(String),
}

/// `inspectPdf` / `inspectImage`: a page count, or why the tools cannot use it
pub type Inspect = Result<f64, String>;

/// Why `runPdfTool` threw
#[derive(Clone, Debug, PartialEq)]
pub enum ToolError {
    /// `PdfToolRefusal(reason)`: `no-text`, `no-annots`, `not-smaller`
    Refusal(String),
    /// any other error, the abort included
    Failed(String),
}

/// What `convertPdfFileTo{Docx,Pptx,Xlsx}Local` answered
#[derive(Clone, Debug, PartialEq)]
pub struct OfficeConversion {
    pub bytes: Vec<u8>,
    pub scanned_document: bool,
    /// `pageResults`: page and status (`ok`, `ocr`, `image`, ...)
    pub page_results: Vec<(f64, String)>,
}

/// What a conversion threw
#[derive(Clone, Debug, PartialEq)]
pub enum ConvertError {
    /// `PdfLoadError` and its `code` (`password-required`, `unsupported`, `corrupt`)
    Load(String),
    /// any other error: its message
    Other(String),
}

/// The file extension of an office format `pdf:convert-office` converts to
pub(crate) fn extension(format: PdfExport) -> &'static str {
    match format {
        PdfExport::Docx => "docx",
        PdfExport::Pptx => "pptx",
        PdfExport::Xlsx => "xlsx",
    }
}

/// The libraries behind the PDF tools. Every method may run on a worker.
pub trait PdfToolsEngine: Send + Sync {
    /// `StructureJobRunner.run`'s process: `utilityProcess.fork(pdf-structure-process)`
    /// with `{ type: 'run', setup: processSetup(), job }` and the child's
    /// answer (`jobs.ts runStructureJob`). `progress` gets the child's
    /// progress messages; `cancel` fires when the runner ended the job (kill
    /// the process then; the answer is not read any more).
    fn run_job(
        &self,
        job: IpcValue,
        progress: &(dyn Fn(f64, f64) + Sync),
        cancel: &CancelToken,
    ) -> JobOutcome;

    /// `new ResultStore(userDataDir)[method](...args)`, the arguments as the
    /// handler passes them (a mode only when it is `easy`, as `modeArgs`).
    /// A Map the store answers comes back as the array of its values.
    fn store(
        &self,
        user_data: PathBuf,
        method: StoreMethod,
        args: Vec<IpcValue>,
    ) -> Result<IpcValue, StoreError>;

    /// tools.ts `inspectPdf(bytes)`: the page count, or `encrypted` / `unreadable`
    fn inspect_pdf(&self, bytes: &[u8]) -> Inspect;

    /// tools.ts `encryptedPageCount(bytes)`: 0 when unknown
    fn encrypted_page_count(&self, bytes: &[u8]) -> f64;

    /// images-to-pdf.ts `readImageInfo(bytes)`: a JPEG or PNG it can place
    fn is_image(&self, bytes: &[u8]) -> bool;

    /// tools.ts `runPdfTool(tool, inputs, options, { recode: recodeWithChromium,
    /// onProgress, signal })` for the tools that run in the main process
    fn run_tool(
        &self,
        tool: &str,
        inputs: Vec<Vec<u8>>,
        options: IpcValue,
        progress: &(dyn Fn(f64, f64) + Sync),
        cancel: &CancelToken,
    ) -> Result<Vec<Vec<u8>>, ToolError>;

    /// `nativeImage.createFromBitmap(bgra, { width, height }).toDataURL()`
    fn png_data_url(&self, width: f64, height: f64, bgra: &[u8]) -> String;

    /// `convertPdfFileTo{Docx,Pptx,Xlsx}Local(pdfPath, onProgress, password)`
    fn convert_to_office(
        &self,
        format: PdfExport,
        pdf_path: &str,
        password: Option<&str>,
        progress: &(dyn Fn(f64, f64) + Sync),
    ) -> Result<OfficeConversion, ConvertError>;
}

pub type PdfToolsEngineHost = Arc<dyn PdfToolsEngine>;

/// The active PDF tab (`activePdfTarget()`)
#[derive(Clone, Debug, PartialEq)]
pub struct PdfTab {
    pub id: String,
    pub view: ViewId,
    pub file_path: Option<String>,
    /// `pdfHostWindow(tab)`
    pub window: Option<WindowId>,
}

/// The tab kinds `findDocsTabByPath`, `findSlidesTabByPath`,
/// `findSheetsTabByPath` and `findMarkdownTabByPath` look in
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TabKind {
    Docs,
    Slides,
    Sheets,
    Markdown,
}

/// What the shell does for the PDF tools beyond the shared hosts. Runs on
/// the core thread unless a method says otherwise.
pub trait PdfToolsShell: Send + Sync {
    /// `crypto.randomUUID()`: the ids the tools window hands out
    fn random_uuid(&self) -> String;
    /// `currentLang()`
    fn lang(&self) -> String;
    /// `currentTheme()` as the tools window takes it: `light`, `dark`, `system`
    fn theme(&self) -> String;
    /// `tm(key, params)`: the shell main process's strings
    fn text(&self, key: &str, params: &[(&str, String)]) -> String;

    /// `openPdfToolsWindow()` when no window is open: a new tools window
    /// over `parent` titled `title` (its `setWindowOpenHandler` hands safe
    /// URLs to `shell.openExternal`); its view, `None` when it could not be made
    fn open_tools_window(&self, parent: Option<WindowId>, title: &str) -> Option<ViewId>;
    /// `win.restore()` when minimized, `win.show()`, `win.focus()`
    fn show_window(&self, view: ViewId);
    /// the password prompt window of `promptPdfPassword`, modal to `parent`; its view
    fn open_password_window(&self, parent: Option<WindowId>, title: &str) -> Option<ViewId>;

    /// `deps.openResult(path)` (index.ts: reload an open text tab, else
    /// `openGeneratedDocument`)
    fn open_result(&self, path: &str) -> bool;
    /// `deps.openForEditing(path)`: `revealShellWindow()` + `openDocumentPath`
    fn open_for_editing(&self, path: &str) -> bool;
    /// `fileHasUnsavedChanges(path)`: the open documents' dirty state is
    /// gathered from their renderers, so `then` answers later, on the core thread
    fn file_has_unsaved_changes(&self, path: &str, then: Box<dyn FnOnce(bool)>);
    /// `openDocumentPath(path)`
    fn open_document_path(&self, path: &str) -> bool;

    /// `activePdfTarget()`
    fn active_pdf_tab(&self) -> Option<PdfTab>;
    /// `flushPdfSave(contents, true)`: `then(true)` once the PDF on disk is current
    fn flush_pdf_save(&self, view: ViewId, then: Box<dyn FnOnce(bool)>);
    /// `tabManager.find{Docs,Slides,Sheets,Markdown}TabByPath(path)`
    fn find_tab(&self, kind: TabKind, path: &str) -> Option<String>;
    /// `tabManager.closeTab(tabId)`: its unsaved-changes guard may keep the
    /// tab; `then` runs on the core thread when it is done (`Err` = rejected)
    fn close_tab(&self, tab: &str, then: Box<dyn FnOnce(Result<(), String>)>);
    /// `tabManager.activateTab(tabId)`
    fn activate_tab(&self, tab: &str);
    /// `activateTab(tabIdForWebContents(view))`
    fn activate_view(&self, view: ViewId);
    /// `win.setProgressBar(progress)`; any thread
    fn set_progress_bar(&self, window: WindowId, progress: f64);
    /// `tabManager` is set: the shell window and its tabs exist (false
    /// before the app is ready)
    fn has_tab_manager(&self) -> bool;
    /// `tabManager.openHwpTab(copy, { untitledCopy: { title, importedPdf: true } })`
    /// and `webContentsForTab` of it: the new tab's view, if it has one
    fn open_hwp_copy(&self, copy: &str, title: &str) -> Result<Option<ViewId>, String>;
}

pub type PdfToolsShellHost = Arc<dyn PdfToolsShell>;

#[cfg(any(test, feature = "probe"))]
pub(crate) mod fake {
    //! The fakes of [`PdfToolsEngine`] and [`PdfToolsShell`]. Each answers
    //! from the case (`hosts.d2.pdf.tools`): `case[<method>]` is the answer to
    //! every call, or, when it is an array, the answers in order (so an
    //! array answer is written inside one), then the neutral default. Store
    //! calls read `case["store.<method>"]`. In answers, `{"$u8": [..]}` is a
    //! `Uint8Array`. A call with an effect writes one line to the probe's
    //! log, named after the TypeScript function the method stands for
    //! (tools/ipc-diff/groups/d2/pdf-tools-fakes.ts writes the same lines).
    //! `random_uuid` counts: `00000000-0000-4000-8000-000000000001`, ...
    //!
    //! Shapes: `run_job` `{"value": v, "progress": [[done, total]]}` or
    //! `{"error": code, "message": m}` (default `not-available`);
    //! `run_tool` `{"outputs": [bytes]}`, `{"refusal": r}`, `{"error": m}`
    //! (default: the first input); `inspect_pdf` `{"pages": n}` or
    //! `{"problem": p}` (default 1 page); `convert_to_office` `{"bytes": b,
    //! "scannedDocument": bool, "pageResults": [[page, status]]}` or
    //! `{"load": code}` / `{"error": m}`; store errors `{"$error": "write"|"type"|"other", "message": m}`;
    //! `unsavedFiles`: the paths open with unsaved changes; `strings`: the
    //! shell's text by key; `tabManager: false`: the shell has no tab manager
    //! yet (the shell entry before the app is ready).

    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::{Value, json};
    use shell_contract::runtime::CancelToken;
    use shell_contract::{BytesKind, IpcValue, ViewId, WindowId};

    use super::*;

    /// ipc-probe's case log (its `ProbeLog`)
    pub type ProbeLog = Arc<Mutex<Vec<Value>>>;

    /// Answers queued per method, and the calls made
    pub struct Fake {
        answers: Mutex<HashMap<String, Value>>,
        #[cfg(test)]
        pub calls: Mutex<Vec<(String, Value)>>,
        /// what `flush_pdf_save` answers; tests may change it
        pub flush_ok: Mutex<bool>,
        log: Option<ProbeLog>,
        uuids: AtomicU64,
    }

    impl Fake {
        pub fn new(case: &Value, log: Option<ProbeLog>) -> Self {
            let answers = match case {
                Value::Object(map) => map.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
                _ => HashMap::new(),
            };
            Fake {
                answers: Mutex::new(answers),
                #[cfg(test)]
                calls: Mutex::default(),
                flush_ok: Mutex::new(true),
                log,
                uuids: AtomicU64::new(0),
            }
        }

        fn answer(&self, method: &str, args: Value) -> Option<Value> {
            #[cfg(test)]
            self.calls.lock().unwrap().push((method.to_owned(), args));
            #[cfg(not(test))]
            let _ = args;
            let mut answers = self.answers.lock().unwrap();
            match answers.get_mut(method)? {
                Value::Array(queue) if queue.is_empty() => None,
                Value::Array(queue) => Some(queue.remove(0)),
                answer => Some(answer.clone()),
            }
        }

        /// one line of the probe's log
        fn log(&self, line: Value) {
            if let Some(log) = &self.log {
                log.lock().unwrap().push(line)
            }
        }

        /// answers `method` from now on as the case's `value` would
        #[cfg(test)]
        pub fn set(&self, method: &str, value: Value) {
            self.answers
                .lock()
                .unwrap()
                .insert(method.to_owned(), value);
        }

        /// the calls of one method, their arguments
        #[cfg(test)]
        pub fn called(&self, method: &str) -> Vec<Value> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|(m, _)| m == method)
                .map(|(_, a)| a.clone())
                .collect()
        }
    }

    /// a case value as the renderer would get it, `{"$u8": [..]}` as bytes
    pub fn ipc(v: &Value) -> IpcValue {
        match v {
            Value::Object(map) if map.len() == 1 && map.contains_key("$u8") => {
                IpcValue::Bytes(BytesKind::Uint8Array, bytes(&map["$u8"]))
            }
            Value::Object(map) => {
                IpcValue::Object(map.iter().map(|(k, v)| (k.clone(), ipc(v))).collect())
            }
            Value::Array(items) => IpcValue::Array(items.iter().map(ipc).collect()),
            other => crate::kit::from_json(other),
        }
    }

    fn bytes(v: &Value) -> Vec<u8> {
        let v = v.get("$u8").unwrap_or(v);
        v.as_array()
            .map(|a| a.iter().map(|b| b.as_u64().unwrap_or(0) as u8).collect())
            .unwrap_or_default()
    }

    /// what a test reads of an argument
    fn json_of(v: &IpcValue) -> Value {
        crate::kit::to_json(v).unwrap_or(Value::Null)
    }

    fn text(v: &Value) -> String {
        v.as_str().unwrap_or_default().to_owned()
    }

    impl PdfToolsEngine for Fake {
        fn run_job(
            &self,
            job: IpcValue,
            progress: &(dyn Fn(f64, f64) + Sync),
            _cancel: &CancelToken,
        ) -> JobOutcome {
            let args = json_of(&job);
            self.log(json!(["runStructureJob", args]));
            let Some(answer) = self.answer("run_job", args) else {
                return Err(JobFailure::new("not-available", Some("no job process")));
            };
            for step in answer["progress"].as_array().into_iter().flatten() {
                progress(
                    step[0].as_f64().unwrap_or(0.0),
                    step[1].as_f64().unwrap_or(0.0),
                );
            }
            match answer.get("error") {
                Some(error) => Err(JobFailure {
                    error: text(error),
                    message: answer.get("message").map(text),
                    valid_range: None,
                }),
                None => Ok(ipc(&answer["value"])),
            }
        }

        fn store(
            &self,
            user_data: PathBuf,
            method: StoreMethod,
            args: Vec<IpcValue>,
        ) -> Result<IpcValue, StoreError> {
            let key = format!("store.{}", method.name());
            let args: Vec<Value> = args.iter().map(json_of).collect();
            let mut line = vec![json!(format!("ResultStore.{}", method.name()))];
            line.extend(args.iter().cloned());
            self.log(Value::Array(line));
            let record = json!({ "dir": user_data.to_string_lossy(), "args": args });
            let Some(answer) = self.answer(&key, record) else {
                use StoreMethod::*;
                return Ok(match method {
                    ListTranslations | UnfinishedJobs | ReadAiReadPages | ReadPassages
                    | ListHighlightRuns | ReadHighlightBlocks | ListJobs => {
                        IpcValue::Array(Vec::new())
                    }
                    ReadTranslation | ReadInsights => IpcValue::Null,
                    HeartbeatJob | SetHighlightSuggestionStates => IpcValue::Bool(true),
                    DeleteTranslationExceptEdited
                    | CountEditedTranslationBlocks
                    | CountPassages => IpcValue::Number(0.0),
                    MigrateDocument => ipc(&json!({
                        "aiReadPages": 0, "translationBlocks": 0, "languages": []
                    })),
                    ReadJob => ipc(&json!({ "state": "idle" })),
                    _ => IpcValue::Undefined,
                });
            };
            match answer.get("$error").and_then(Value::as_str) {
                Some(kind) => {
                    let message = text(&answer["message"]);
                    Err(match kind {
                        "write" => StoreError::Write(message),
                        "type" => StoreError::Type(message),
                        _ => StoreError::Other(message),
                    })
                }
                None => Ok(ipc(&answer)),
            }
        }

        fn inspect_pdf(&self, bytes: &[u8]) -> Inspect {
            match self.answer("inspect_pdf", json!(bytes.len())) {
                Some(a) if a.get("problem").is_some() => Err(text(&a["problem"])),
                Some(a) => Ok(a["pages"].as_f64().unwrap_or(1.0)),
                None => Ok(1.0),
            }
        }

        fn encrypted_page_count(&self, bytes: &[u8]) -> f64 {
            self.answer("encrypted_page_count", json!(bytes.len()))
                .and_then(|a| a.as_f64())
                .unwrap_or(0.0)
        }

        fn is_image(&self, bytes: &[u8]) -> bool {
            self.answer("is_image", json!(bytes.len()))
                .and_then(|a| a.as_bool())
                .unwrap_or(true)
        }

        fn run_tool(
            &self,
            tool: &str,
            inputs: Vec<Vec<u8>>,
            options: IpcValue,
            progress: &(dyn Fn(f64, f64) + Sync),
            cancel: &CancelToken,
        ) -> Result<Vec<Vec<u8>>, ToolError> {
            let options = json_of(&options);
            self.log(json!(["runPdfTool", tool, inputs.len(), options]));
            let answer = self.answer(
                "run_tool",
                json!({ "tool": tool, "inputs": inputs.len(), "options": options }),
            );
            let Some(answer) = answer else {
                return Ok(inputs.into_iter().take(1).collect());
            };
            for step in answer["progress"].as_array().into_iter().flatten() {
                progress(
                    step[0].as_f64().unwrap_or(0.0),
                    step[1].as_f64().unwrap_or(0.0),
                );
            }
            if cancel.is_cancelled() {
                return Err(ToolError::Failed("aborted".into()));
            }
            if let Some(r) = answer.get("refusal") {
                return Err(ToolError::Refusal(text(r)));
            }
            if let Some(e) = answer.get("error") {
                return Err(ToolError::Failed(text(e)));
            }
            Ok(answer["outputs"]
                .as_array()
                .into_iter()
                .flatten()
                .map(bytes)
                .collect())
        }

        fn png_data_url(&self, width: f64, height: f64, bgra: &[u8]) -> String {
            self.answer("png_data_url", json!([width, height, bgra.len()]));
            format!("data:image/png;base64,{width}x{height}")
        }

        fn convert_to_office(
            &self,
            format: PdfExport,
            pdf_path: &str,
            password: Option<&str>,
            progress: &(dyn Fn(f64, f64) + Sync),
        ) -> Result<OfficeConversion, ConvertError> {
            let args = json!([extension(format), pdf_path, password]);
            self.log(json!(["convertPdfFileToOfficeLocal", args]));
            let answer = self.answer(
                "convert_to_office",
                json!({ "format": extension(format), "path": pdf_path, "password": password }),
            );
            let answer = answer.unwrap_or_else(|| json!({}));
            progress(1.0, 1.0);
            if let Some(code) = answer.get("load") {
                return Err(ConvertError::Load(text(code)));
            }
            if let Some(e) = answer.get("error") {
                return Err(ConvertError::Other(text(e)));
            }
            Ok(OfficeConversion {
                bytes: bytes(&answer["bytes"]),
                scanned_document: answer["scannedDocument"].as_bool().unwrap_or(false),
                page_results: answer["pageResults"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|r| (r[0].as_f64().unwrap_or(0.0), text(&r[1])))
                    .collect(),
            })
        }
    }

    impl PdfToolsShell for Fake {
        fn random_uuid(&self) -> String {
            let n = self.uuids.fetch_add(1, Ordering::Relaxed) + 1;
            format!("00000000-0000-4000-8000-{n:012}")
        }
        fn lang(&self) -> String {
            self.answer("lang", Value::Null)
                .map(|a| text(&a))
                .unwrap_or_else(|| "en".into())
        }
        fn theme(&self) -> String {
            self.answer("theme", Value::Null)
                .map(|a| text(&a))
                .unwrap_or_else(|| "system".into())
        }
        /// `strings[key]` of the case, else the key; then `name=value` of each parameter
        fn text(&self, key: &str, params: &[(&str, String)]) -> String {
            let strings = self.answers.lock().unwrap().get("strings").cloned();
            let text = strings
                .as_ref()
                .and_then(|s| s.get(key))
                .and_then(Value::as_str)
                .unwrap_or(key)
                .to_owned();
            std::iter::once(text)
                .chain(params.iter().map(|(k, v)| format!("{k}={v}")))
                .collect::<Vec<_>>()
                .join(" ")
        }
        /// view 900 unless the case says
        fn open_tools_window(&self, parent: Option<WindowId>, title: &str) -> Option<ViewId> {
            let args = json!([parent.map(|w| w.0), title]);
            self.log(json!(["openPdfToolsWindow", args[0], title]));
            let a = self.answer("open_tools_window", args);
            Some(ViewId(a.and_then(|a| a.as_u64()).unwrap_or(900) as u32))
        }
        fn show_window(&self, view: ViewId) {
            self.log(json!(["pdfToolsWindow.show", view.0]));
            self.answer("show_window", json!(view.0));
        }
        /// view 901 unless the case says
        fn open_password_window(&self, parent: Option<WindowId>, title: &str) -> Option<ViewId> {
            let args = json!([parent.map(|w| w.0), title]);
            self.log(json!(["promptPdfPassword.window", args[0], title]));
            let a = self.answer("open_password_window", args);
            Some(ViewId(a.and_then(|a| a.as_u64()).unwrap_or(901) as u32))
        }
        fn open_result(&self, path: &str) -> bool {
            self.log(json!(["openResult", path]));
            self.answer("open_result", json!(path))
                .and_then(|a| a.as_bool())
                .unwrap_or(true)
        }
        fn open_for_editing(&self, path: &str) -> bool {
            self.log(json!(["openForEditing", path]));
            self.answer("open_for_editing", json!(path))
                .and_then(|a| a.as_bool())
                .unwrap_or(true)
        }
        /// the answer `"hold"` keeps the question open until [`resume_unsaved`] (tests)
        fn file_has_unsaved_changes(&self, path: &str, then: Box<dyn FnOnce(bool)>) {
            let unsaved = self.answers.lock().unwrap().get("unsavedFiles").cloned();
            let answer = self.answer("file_has_unsaved_changes", json!(path));
            #[cfg(test)]
            if answer.as_ref().and_then(Value::as_str) == Some("hold") {
                HELD.with(|h| *h.borrow_mut() = Some(then));
                return;
            }
            let answer = answer.and_then(|a| a.as_bool()).unwrap_or_else(|| {
                unsaved
                    .and_then(|u| u.as_array().cloned())
                    .is_some_and(|u| u.iter().any(|p| p.as_str() == Some(path)))
            });
            then(answer)
        }
        /// with `tabManager: false` (the shell entry before it is ready) a
        /// file opens nowhere: false, without a line
        fn open_document_path(&self, path: &str) -> bool {
            if !self.has_tab_manager() {
                return false;
            }
            self.log(json!(["openDocumentPath", path]));
            self.answer("open_document_path", json!(path))
                .and_then(|a| a.as_bool())
                .unwrap_or(true)
        }
        /// `{"id", "view", "filePath", "window"}`; none unless the case says
        fn active_pdf_tab(&self) -> Option<PdfTab> {
            let a = self.answer("active_pdf_tab", Value::Null)?;
            Some(PdfTab {
                id: text(&a["id"]),
                view: ViewId(a["view"].as_u64()? as u32),
                file_path: a["filePath"].as_str().map(str::to_owned),
                window: a["window"].as_u64().map(|w| WindowId(w as u32)),
            })
        }
        /// a view without unsaved edits answers at once (`pdfIsDirty` false)
        fn flush_pdf_save(&self, view: ViewId, then: Box<dyn FnOnce(bool)>) {
            let ok = self
                .answer("flush_pdf_save", json!(view.0))
                .and_then(|a| a.as_bool())
                .unwrap_or(*self.flush_ok.lock().unwrap());
            then(ok)
        }
        /// with `tabManager: false` no tab shows anything, without a line
        fn find_tab(&self, kind: TabKind, path: &str) -> Option<String> {
            if !self.has_tab_manager() {
                return None;
            }
            self.log(json!([format!("tabManager.find{kind:?}TabByPath"), path]));
            self.answer("find_tab", json!([format!("{kind:?}"), path]))
                .and_then(|a| a.as_str().map(str::to_owned))
        }
        /// an answer that is a string is the rejection's message
        fn close_tab(&self, tab: &str, then: Box<dyn FnOnce(Result<(), String>)>) {
            self.log(json!(["tabManager.closeTab", tab]));
            match self.answer("close_tab", json!(tab)) {
                Some(Value::String(e)) => then(Err(e)),
                _ => then(Ok(())),
            }
        }
        fn activate_tab(&self, tab: &str) {
            self.log(json!(["tabManager.activateTab", tab]));
            self.answer("activate_tab", json!(tab));
        }
        fn activate_view(&self, view: ViewId) {
            self.log(json!(["activateView", view.0]));
            self.answer("activate_view", json!(view.0));
        }
        /// unless the case says `tabManager: false`
        fn has_tab_manager(&self) -> bool {
            self.answers.lock().unwrap().get("tabManager") != Some(&Value::Bool(false))
        }
        fn set_progress_bar(&self, window: WindowId, progress: f64) {
            self.log(json!(["setProgressBar", window.0, progress]));
            self.answer("set_progress_bar", json!([window.0, progress]));
        }
        fn open_hwp_copy(&self, copy: &str, title: &str) -> Result<Option<ViewId>, String> {
            self.log(json!(["tabManager.openHwpTab", copy, title]));
            match self.answer("open_hwp_copy", json!([copy, title])) {
                Some(Value::String(e)) => Err(e),
                Some(a) => Ok(a.as_u64().map(|v| ViewId(v as u32))),
                None => Ok(None),
            }
        }
    }

    #[cfg(test)]
    type Held = Option<Box<dyn FnOnce(bool)>>;

    #[cfg(test)]
    thread_local! {
        /// an unsaved-file question the fake was told to hold
        static HELD: std::cell::RefCell<Held> = const { std::cell::RefCell::new(None) };
    }

    /// answers the held unsaved-file question; false when none was held
    #[cfg(test)]
    pub fn resume_unsaved(unsaved: bool) -> bool {
        match HELD.with(|h| h.borrow_mut().take()) {
            Some(then) => {
                then(unsaved);
                true
            }
            None => false,
        }
    }
}
