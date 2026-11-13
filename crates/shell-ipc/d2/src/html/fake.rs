//! The fakes of the HTML editor's hosts, for unit tests and ipc-probe.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use main_core::packages::electron_utils::safe_remote_url::{
    FetchError, FetchInit, Fetcher, GlobalDispatcher, LookupAddress, Resolver, Response,
};
use serde_json::Value;
use shell_contract::{ViewId, WindowId};

use super::odt_export::{OdtConversion, ReportItem};
use super::{Handoff, HtmlEngine, HtmlShell, ParsedFile};

/// Answers by method name from a case object: `case[<method>]` is the
/// answer; an array is consumed one item per call (its last item repeats).
/// Every call is recorded as `"<method> <argument>"`.
pub(crate) struct Answers {
    queued: Mutex<HashMap<String, VecDeque<Value>>>,
    pub calls: Mutex<Vec<String>>,
}

impl Answers {
    pub(crate) fn new(case: &Value) -> Self {
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
            queued: Mutex::new(queued),
            calls: Mutex::new(Vec::new()),
        }
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

/// The HTML editor's engine and shell hooks in one fake. Answers (case
/// keys, defaults in brackets): `print_pdf` [`"%PDF"`], `html_to_docx`
/// [`"DOCX"`], `docx_to_odt` [`{ "odt": "ODT", "report": [] }`],
/// `parse_file_to_text` [`{ "ok": true, "kind": "text", "text": "" }`],
/// `diagram_picture_ext_of` [null], `is_headless` [false], `ui_lang`
/// [`"en"`], `is_path_open_elsewhere` [false], `assert_file_saved` [null; a
/// string is the error], `open_generated_path` [false], `new_document_dir`
/// [null], `write_new_document` [null; a folder the file is written into],
/// `docx_exported` [false], `docx_export_prepare` [true],
/// `take_generate_handoff` [null; `{ id, text, materials: [{ path, name }] }`],
/// `report_generate_run_started` [false], `present_open_tab` [false],
/// `present_host_window` [null], `open_present_window` [null; a view number],
/// `is_window_destroyed` [false]. The network always fails.
pub(crate) struct FakeHtml {
    pub answers: Answers,
}

impl FakeHtml {
    pub(crate) fn new(case: &Value) -> Self {
        FakeHtml {
            answers: Answers::new(case),
        }
    }
}

impl HtmlEngine for FakeHtml {
    fn print_pdf(&self, html_file: &Path) -> Result<Vec<u8>, String> {
        self.answers
            .bytes("print_pdf", html_file.display(), b"%PDF")
    }
    fn html_to_docx(&self, html_file: &Path) -> Result<Vec<u8>, String> {
        self.answers
            .bytes("html_to_docx", html_file.display(), b"DOCX")
    }
    fn docx_to_odt(&self, docx: Vec<u8>) -> Result<OdtConversion, String> {
        let answer = self
            .answers
            .answer("docx_to_odt", String::from_utf8_lossy(&docx));
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
    fn parse_file_to_text(&self, path: &Path) -> ParsedFile {
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

fn view_of(v: Value) -> Option<ViewId> {
    v.as_u64().map(|n| ViewId(n as u32))
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
    fn reload(&self, view: ViewId) {
        self.answers.answer("reload", view.0);
    }
    fn is_path_open_elsewhere(&self, path: &str) -> bool {
        self.answers.bool("is_path_open_elsewhere", path, false)
    }
    fn assert_file_saved(&self, path: &str) -> Result<(), String> {
        match self.answers.string("assert_file_saved", path) {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
    fn open_generated_path(&self, path: &Path) -> bool {
        self.answers
            .bool("open_generated_path", path.display(), false)
    }
    fn new_document_dir(&self, view: ViewId) -> Option<PathBuf> {
        self.answers
            .string("new_document_dir", view.0)
            .map(Into::into)
    }
    fn write_new_document(&self, view: ViewId, file_name: &str, bytes: &[u8]) -> Option<PathBuf> {
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
    }
    fn provisional_title(&self, view: ViewId, title: &str) {
        self.answers
            .answer("provisional_title", format!("{} {title}", view.0));
    }
    fn docx_exported(&self, path: &Path) -> bool {
        self.answers.bool("docx_exported", path.display(), false)
    }
    fn docx_export_prepare(&self, path: &Path, then: Box<dyn FnOnce(bool)>) {
        then(
            self.answers
                .bool("docx_export_prepare", path.display(), true),
        )
    }
    fn take_generate_handoff(&self, view: ViewId) -> Option<Handoff> {
        let v = self.answers.answer("take_generate_handoff", view.0)?;
        let o = v.as_object()?;
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
        self.answers.bool(
            "report_generate_run_started",
            format!("{} {}", view.0, paths.join(",")),
            false,
        )
    }
    fn present_open_tab(&self, owner: ViewId, title: &str) -> bool {
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
    }
    fn present_enter_full_screen(&self, window: WindowId) {
        self.answers.answer("present_enter_full_screen", window.0);
    }
    fn present_leave_full_screen(&self, window: WindowId) {
        self.answers.answer("present_leave_full_screen", window.0);
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
        self.answers
            .answer("open_present_window", format!("{} {title}", owner.0))
            .and_then(view_of)
    }
    fn close_present_view(&self, view: ViewId) {
        self.answers.answer("close_present_view", view.0);
    }
}
