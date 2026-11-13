//! The fakes of the HTML editor's hosts, for unit tests and ipc-probe. The
//! TypeScript side of tools/ipc-diff (groups/d2/html-fakes.ts) answers the
//! same case keys and writes the same log lines.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use main_core::packages::electron_utils::safe_remote_url::{
    FetchError, FetchInit, Fetcher, GlobalDispatcher, LookupAddress, Resolver, Response,
};
use main_core::packages::electron_utils::unsaved_files::UNSAVED_CHANGES_MESSAGE;
use serde_json::{Value, json};
use shell_contract::{ViewId, WindowId};

use super::odt_export::{OdtConversion, ReportItem};
use super::{Handoff, HtmlEngine, HtmlShell, ParsedFile};

/// ipc-probe's call log (tools/ipc-diff/README.md, "Batch hosts")
pub(crate) type ProbeLog = Arc<Mutex<Vec<Value>>>;

/// Answers by method name from a case object: `case[<method>]` is the
/// answer; an array is consumed one item per call (its last item repeats).
/// Every call is recorded as `"<method> <argument>"` for the unit tests; the
/// probe's log gets the lines a fake writes with [`Answers::log`].
pub(crate) struct Answers {
    case: Value,
    queued: Mutex<HashMap<String, VecDeque<Value>>>,
    pub calls: Mutex<Vec<String>>,
    probe: Option<ProbeLog>,
}

impl Answers {
    pub(crate) fn new(case: &Value, probe: Option<ProbeLog>) -> Self {
        let mut queued = HashMap::new();
        if let Value::Object(map) = case {
            for (k, v) in map {
                let q: VecDeque<Value> = match v {
                    Value::Array(items) => items.iter().cloned().collect(),
                    other => VecDeque::from([other.clone()]),
                };
                queued.insert(k.clone(), q);
            }
        }
        Answers {
            case: case.clone(),
            queued: Mutex::new(queued),
            calls: Mutex::new(Vec::new()),
            probe,
        }
    }

    /// one line of the probe's log
    pub(crate) fn log(&self, line: Value) {
        if let Some(probe) = &self.probe {
            probe.lock().unwrap().push(line)
        }
    }

    /// the case's key as written
    pub(crate) fn raw(&self, key: &str) -> Option<&Value> {
        self.case.get(key)
    }

    pub(crate) fn has(&self, key: &str) -> bool {
        self.raw(key).is_some()
    }

    /// whether `path` is in the case's list under `key`
    pub(crate) fn listed(&self, key: &str, path: &str) -> bool {
        self.raw(key)
            .and_then(Value::as_array)
            .is_some_and(|items| items.iter().any(|i| i.as_str() == Some(path)))
    }

    /// the answer for `method`, recording the call
    pub(crate) fn answer(&self, method: &str, arg: impl std::fmt::Display) -> Option<Value> {
        self.calls.lock().unwrap().push(format!("{method} {arg}"));
        let mut queued = self.queued.lock().unwrap();
        let q = queued.get_mut(method)?;
        if q.len() > 1 {
            q.pop_front()
        } else {
            q.front().cloned()
        }
    }

    pub(crate) fn bool(&self, method: &str, arg: impl std::fmt::Display, default: bool) -> bool {
        self.answer(method, arg)
            .and_then(|v| v.as_bool())
            .unwrap_or(default)
    }

    pub(crate) fn string(&self, method: &str, arg: impl std::fmt::Display) -> Option<String> {
        self.answer(method, arg)
            .and_then(|v| v.as_str().map(str::to_owned))
    }

    /// a byte answer: a string's UTF-8 bytes; `{ "error": text }` fails
    pub(crate) fn bytes(
        &self,
        method: &str,
        arg: impl std::fmt::Display,
        default: &[u8],
    ) -> Result<Vec<u8>, String> {
        match self.answer(method, arg) {
            Some(Value::String(s)) => Ok(s.into_bytes()),
            Some(Value::Object(o)) => Err(o
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("failed")
                .to_owned()),
            _ => Ok(default.to_vec()),
        }
    }

    /// `Date.now()`: the case's `now`, else the clock
    pub(crate) fn now_ms(&self) -> f64 {
        self.raw("now")
            .and_then(Value::as_f64)
            .unwrap_or_else(crate::text_recovery::ui::now_ms)
    }

    #[cfg(test)]
    pub(crate) fn called(&self, prefix: &str) -> Vec<String> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.starts_with(prefix))
            .cloned()
            .collect()
    }
}

/// `docxToOdt`'s answer from a case value: `{ odt, report }` or `{ error }`
pub(crate) fn odt_answer(answer: Option<Value>) -> Result<OdtConversion, String> {
    match answer {
        Some(Value::Object(o)) if o.contains_key("error") => {
            Err(o["error"].as_str().unwrap_or("failed").to_owned())
        }
        Some(Value::Object(o)) => Ok(OdtConversion {
            odt: o
                .get("odt")
                .and_then(Value::as_str)
                .unwrap_or("ODT")
                .as_bytes()
                .to_vec(),
            report: o
                .get("report")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|i| ReportItem {
                            kind: i["kind"].as_str().unwrap_or_default().to_owned(),
                            feature: i["feature"].as_str().unwrap_or_default().to_owned(),
                            count: i["count"].as_f64().unwrap_or(1.0),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        }),
        _ => Ok(OdtConversion {
            odt: b"ODT".to_vec(),
            report: Vec::new(),
        }),
    }
}

/// the hex of bytes, as the log writes them
pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// the text of a file the engine is handed, as the log writes it
pub(crate) fn file_text(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// A resolver and fetcher with no network: every lookup fails
pub(crate) struct NoNetwork;

impl Resolver for NoNetwork {
    fn lookup_all(&mut self, host: &str) -> Result<Vec<LookupAddress>, FetchError> {
        Err(FetchError(format!("getaddrinfo ENOTFOUND {host}")))
    }
}

impl Fetcher for NoNetwork {
    fn global_dispatcher(&mut self) -> GlobalDispatcher {
        GlobalDispatcher::NotAnObject
    }
    fn fetch(&mut self, url: &str, _init: &FetchInit<'_>) -> Result<Box<dyn Response>, FetchError> {
        Err(FetchError(format!("fetch failed: {url}")))
    }
    fn close_dispatcher(&mut self) {}
    fn sleep(&mut self, _ms: f64) {}
}

/// The HTML editor's engine and shell hooks in one fake. Case keys, the
/// default in brackets; log lines in parentheses:
/// - engines: `print_pdf` [`"%PDF"`; `{ "error": text }` fails]
///   (`["printToPDF", text of the page]`), `html_to_docx` [`"DOCX"`]
///   (`["convertHtmlToDocx", text of the page]`), `docx_to_odt`
///   [`{ "odt": "ODT", "report": [] }`] (`["docxToOdt", hex]`),
///   `parse_file_to_text` [`{ "ok": true, "kind": "text", "text": "" }`]
///   (`["parseFileToText", path]`), `diagram_picture_ext_of` [null]; the
///   network always fails.
/// - process state: `is_headless` [false], `ui_lang` [`"en"`], `now`
///   [the clock], `open_elsewhere` [paths open in another pane: none],
///   `unsaved_files` [paths open with unsaved changes: none].
/// - hooks the shell may not set (absent: not called): `open_generated_path`
///   (`["openGeneratedPath", path]`), `new_document_dir` [a folder or null]
///   (`["newDocumentDir", view]`), `write_new_document` [a folder the file
///   is written into, or null] (`["writeNewDocument", view, name]`),
///   `docx_exported` [true sets the hook] (`["docxExportedHook", path]`),
///   `docx_export_prepare` [its answer] (`["docxExportPrepareHook", path]`),
///   `present_open_tab` (`["presentHooks.openTab", owner, title]`),
///   `present_host_window` [a window number].
/// - always called: `["fileSavedHook", view, path]`,
///   `["provisionalTitleHook", view, title]`,
///   `["presentHooks.setBleed", view, on]`, `["webContents.reload", view]`,
///   `["reportGenerateRunStarted", view, paths]` (`report_generate_run_started`
///   [false]), `["openPresentWindow"]` (`open_present_window` [the new
///   view's number, or null]).
/// - `take_generate_handoff`: `{ "<view>": { id, text, materials } }`, each taken once.
/// - macOS full screen: `["BrowserWindow.setFullScreenable", window, false]`
///   and `["BrowserWindow.setSimpleFullScreen", window, true]` to enter,
///   `["BrowserWindow.setFullScreenable", window, true]` to leave.
pub(crate) struct FakeHtml {
    pub answers: Answers,
    taken: Mutex<Vec<u32>>,
}

impl FakeHtml {
    pub(crate) fn new(case: &Value, probe: Option<ProbeLog>) -> Self {
        FakeHtml {
            answers: Answers::new(case, probe),
            taken: Mutex::default(),
        }
    }
}

impl HtmlEngine for FakeHtml {
    fn print_pdf(&self, html_file: &Path) -> Result<Vec<u8>, String> {
        self.answers
            .log(json!(["printToPDF", file_text(html_file)]));
        self.answers
            .bytes("print_pdf", html_file.display(), b"%PDF")
    }
    fn html_to_docx(&self, html_file: &Path) -> Result<Vec<u8>, String> {
        self.answers
            .log(json!(["convertHtmlToDocx", file_text(html_file)]));
        self.answers
            .bytes("html_to_docx", html_file.display(), b"DOCX")
    }
    fn docx_to_odt(&self, docx: Vec<u8>) -> Result<OdtConversion, String> {
        self.answers.log(json!(["docxToOdt", hex(&docx)]));
        odt_answer(
            self.answers
                .answer("docx_to_odt", String::from_utf8_lossy(&docx)),
        )
    }
    fn parse_file_to_text(&self, path: &Path) -> ParsedFile {
        self.answers
            .log(json!(["parseFileToText", path.to_string_lossy()]));
        match self.answers.answer("parse_file_to_text", path.display()) {
            Some(Value::Object(o)) => ParsedFile {
                ok: o.get("ok").and_then(Value::as_bool).unwrap_or(false),
                kind: o.get("kind").and_then(Value::as_str).map(str::to_owned),
                text: o.get("text").and_then(Value::as_str).map(str::to_owned),
                damaged: o.get("damaged").and_then(Value::as_bool).unwrap_or(false),
                error: o.get("error").and_then(Value::as_str).map(str::to_owned),
            },
            _ => ParsedFile {
                ok: true,
                kind: Some("text".into()),
                text: Some(String::new()),
                damaged: false,
                error: None,
            },
        }
    }
    fn diagram_picture_ext_of(&self, path: &Path) -> Option<String> {
        self.answers
            .string("diagram_picture_ext_of", path.display())
    }
    fn resolver(&self) -> Box<dyn Resolver + Send> {
        Box::new(NoNetwork)
    }
    fn fetcher(&self) -> Box<dyn Fetcher + Send> {
        Box::new(NoNetwork)
    }
}

impl HtmlShell for FakeHtml {
    fn is_headless(&self) -> bool {
        self.answers.bool("is_headless", "", false)
    }
    fn ui_lang(&self) -> String {
        self.answers
            .string("ui_lang", "")
            .unwrap_or_else(|| "en".into())
    }
    fn now_ms(&self) -> f64 {
        self.answers.now_ms()
    }
    fn reload(&self, view: ViewId) {
        self.answers.answer("reload", view.0);
        self.answers.log(json!(["webContents.reload", view.0]));
    }
    fn is_path_open_elsewhere(&self, path: &str) -> bool {
        self.answers.listed("open_elsewhere", path)
    }
    fn assert_file_saved(&self, path: &str) -> Result<(), String> {
        if self.answers.listed("unsaved_files", path) {
            return Err(UNSAVED_CHANGES_MESSAGE.to_owned());
        }
        Ok(())
    }
    fn open_generated_path(&self, path: &Path) -> bool {
        if !self.answers.has("open_generated_path") {
            return false;
        }
        self.answers
            .log(json!(["openGeneratedPath", path.to_string_lossy()]));
        self.answers
            .bool("open_generated_path", path.display(), false)
    }
    fn new_document_dir(&self, view: ViewId) -> Option<PathBuf> {
        if !self.answers.has("new_document_dir") {
            return None;
        }
        self.answers.log(json!(["newDocumentDir", view.0]));
        self.answers
            .string("new_document_dir", view.0)
            .map(Into::into)
    }
    fn write_new_document(&self, view: ViewId, file_name: &str, bytes: &[u8]) -> Option<PathBuf> {
        if !self.answers.has("write_new_document") {
            return None;
        }
        self.answers
            .log(json!(["writeNewDocument", view.0, file_name]));
        let dir: PathBuf = self
            .answers
            .string("write_new_document", format!("{} {file_name}", view.0))?
            .into();
        let path = dir.join(file_name);
        std::fs::write(&path, bytes).ok()?;
        Some(path)
    }
    fn file_saved(&self, view: ViewId, path: &Path) {
        self.answers
            .answer("file_saved", format!("{} {}", view.0, path.display()));
        self.answers
            .log(json!(["fileSavedHook", view.0, path.to_string_lossy()]));
    }
    fn provisional_title(&self, view: ViewId, title: &str) {
        self.answers
            .answer("provisional_title", format!("{} {title}", view.0));
        self.answers
            .log(json!(["provisionalTitleHook", view.0, title]));
    }
    fn docx_exported(&self, path: &Path) -> bool {
        if !self.answers.bool("docx_exported", path.display(), false) {
            return false;
        }
        self.answers
            .log(json!(["docxExportedHook", path.to_string_lossy()]));
        true
    }
    fn docx_export_prepare(&self, path: &Path, then: Box<dyn FnOnce(bool)>) {
        if !self.answers.has("docx_export_prepare") {
            return then(true);
        }
        self.answers
            .log(json!(["docxExportPrepareHook", path.to_string_lossy()]));
        then(
            self.answers
                .bool("docx_export_prepare", path.display(), true),
        )
    }
    fn take_generate_handoff(&self, view: ViewId) -> Option<Handoff> {
        let o = self
            .answers
            .raw("take_generate_handoff")?
            .get(view.0.to_string())?
            .as_object()?
            .clone();
        let mut taken = self.taken.lock().unwrap();
        if taken.contains(&view.0) {
            return None;
        }
        taken.push(view.0);
        Some(Handoff {
            id: o.get("id")?.as_str()?.to_owned(),
            text: o.get("text")?.as_str()?.to_owned(),
            materials: o
                .get("materials")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|m| {
                            (
                                m["path"].as_str().unwrap_or_default().to_owned(),
                                m["name"].as_str().unwrap_or_default().to_owned(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
    fn report_generate_run_started(&self, view: ViewId, paths: &[String]) -> bool {
        self.answers
            .log(json!(["reportGenerateRunStarted", view.0, paths]));
        self.answers.bool(
            "report_generate_run_started",
            format!("{} {}", view.0, paths.join(",")),
            false,
        )
    }
    fn present_open_tab(&self, owner: ViewId, title: &str) -> bool {
        if !self.answers.has("present_open_tab") {
            return false;
        }
        self.answers
            .log(json!(["presentHooks.openTab", owner.0, title]));
        self.answers
            .bool("present_open_tab", format!("{} {title}", owner.0), false)
    }
    fn present_host_window(&self, view: ViewId) -> Option<WindowId> {
        self.answers
            .answer("present_host_window", view.0)
            .and_then(|v| v.as_u64())
            .map(|n| WindowId(n as u32))
    }
    fn present_set_bleed(&self, view: ViewId, on: bool) {
        self.answers
            .answer("present_set_bleed", format!("{} {on}", view.0));
        self.answers
            .log(json!(["presentHooks.setBleed", view.0, on]));
    }
    fn present_enter_full_screen(&self, window: WindowId) {
        self.answers.answer("present_enter_full_screen", window.0);
        if cfg!(target_os = "macos") {
            self.answers
                .log(json!(["BrowserWindow.setFullScreenable", window.0, false]));
            self.answers
                .log(json!(["BrowserWindow.setSimpleFullScreen", window.0, true]));
        }
    }
    fn present_leave_full_screen(&self, window: WindowId) {
        self.answers.answer("present_leave_full_screen", window.0);
        if cfg!(target_os = "macos") {
            self.answers
                .log(json!(["BrowserWindow.setFullScreenable", window.0, true]));
        }
    }
    fn is_window_destroyed(&self, window: WindowId) -> bool {
        self.answers.bool("is_window_destroyed", window.0, false)
    }
    fn open_present_window(
        &self,
        owner: ViewId,
        title: &str,
        _parent: Option<WindowId>,
    ) -> Option<ViewId> {
        self.answers.log(json!(["openPresentWindow"]));
        self.answers
            .answer("open_present_window", format!("{} {title}", owner.0))
            .and_then(|v| v.as_u64())
            .map(|n| ViewId(n as u32))
    }
    fn close_present_view(&self, view: ViewId) {
        self.answers.answer("close_present_view", view.0);
        self.answers.log(json!(["closePresentView", view.0]));
    }
}
