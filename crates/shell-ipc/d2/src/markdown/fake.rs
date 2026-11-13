//! The fakes of the Markdown editor's hosts, for unit tests and ipc-probe.
//! The TypeScript side of tools/ipc-diff (groups/d2/markdown-fakes.ts)
//! answers the same case keys and writes the same log lines.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use main_core::markdown::image_host::{FetchFailure, FetchInit, FetchResponse, ResponseHeaders};
use main_core::packages::electron_utils::print_html_pdf::PrintWindow;
use main_core::packages::electron_utils::print_window::JsError;
use main_core::packages::electron_utils::safe_remote_url::{Fetcher, Resolver, Response};
use serde_json::{Value, json};
use shell_contract::ViewId;

use super::{MarkdownEngine, MarkdownShell};
use crate::html::fake::{Answers, NoNetwork, ProbeLog, file_text, hex, odt_answer};
use crate::html::odt_export::OdtConversion;

/// A hidden print window that answers `print_pdf`'s bytes and logs the page
struct FakeWindow {
    fake: Arc<Answers>,
    page: Option<PathBuf>,
}

impl PrintWindow for FakeWindow {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        self.page = Some(path.into());
        Ok(())
    }
    fn print_to_pdf(&mut self, _options: &serde_json::Value) -> Result<Vec<u8>, JsError> {
        let page = self.page.as_deref().map(file_text).unwrap_or_default();
        self.fake.log(json!(["printToPDF", page]));
        self.fake
            .bytes("print_pdf", "", b"%PDF")
            .map_err(|message| JsError {
                code: None,
                message,
            })
    }
    fn destroy(&mut self) -> Result<(), JsError> {
        Ok(())
    }
}

/// The Markdown editor's engine and shell hooks in one fake. Case keys, the
/// default in brackets; log lines in parentheses:
/// - engines: `print_pdf` [`"%PDF"`; `{ "error": text }` fails]
///   (`["printToPDF", text of the page]`), `docx_to_odt`
///   [`{ "odt": "ODT", "report": [] }`] (`["docxToOdt", hex]`),
///   `upload_fetch` [a failed request; `{ "status": n, "text": body }`
///   answers] (`["fetch", method]`), `net.fetch` always fails
///   (`["net.fetch", url]`); the network always fails.
/// - process state: `is_headless` [false], `ui_lang` [`"en"`], `now` [the
///   clock], `open_elsewhere` [paths open in another pane: none].
/// - hooks the shell may not set (absent: not called): `open_generated_path`
///   (`["openGeneratedPath", path]`), `new_document_dir`
///   (`["newDocumentDir", view]`), `write_new_document`
///   (`["writeNewDocument", view, name]`).
/// - always called: `["fileSavedHook", view, path]`,
///   `["docxExportedHook", path]`, `["webContents.reload", view]`.
/// - `randomUUID()` of the image exports counts: the n-th id starts with n in
///   six digits (`000001aa-0000-4000-8000-000000000000`), which `mkdtemp`'s
///   suffix takes.
pub(crate) struct FakeMarkdown {
    pub answers: Arc<Answers>,
    ids: AtomicU32,
}

impl FakeMarkdown {
    pub(crate) fn new(case: &Value, probe: Option<ProbeLog>) -> Self {
        FakeMarkdown {
            answers: Arc::new(Answers::new(case, probe)),
            ids: AtomicU32::new(0),
        }
    }
}

impl MarkdownEngine for FakeMarkdown {
    fn print_window(&self) -> Box<dyn PrintWindow + Send> {
        Box::new(FakeWindow {
            fake: Arc::clone(&self.answers),
            page: None,
        })
    }
    fn docx_to_odt(&self, docx: Vec<u8>) -> Result<OdtConversion, String> {
        self.answers.log(json!(["docxToOdt", hex(&docx)]));
        odt_answer(
            self.answers
                .answer("docx_to_odt", String::from_utf8_lossy(&docx)),
        )
    }
    fn resolver(&self) -> Box<dyn Resolver + Send> {
        Box::new(NoNetwork)
    }
    fn fetcher(&self) -> Box<dyn Fetcher + Send> {
        Box::new(NoNetwork)
    }
    fn net_fetch(&self, url: &str) -> Result<Box<dyn Response>, String> {
        self.answers.answer("net_fetch", url);
        self.answers.log(json!(["net.fetch", url]));
        Err("TypeError: Failed to fetch".into())
    }
    fn upload_fetch(&self, url: &str, init: &FetchInit<'_>) -> Result<FetchResponse, FetchFailure> {
        self.answers.log(json!(["fetch", init.method]));
        match self.answers.answer("upload_fetch", url) {
            Some(Value::Object(o)) => {
                let status = o.get("status").and_then(Value::as_f64).unwrap_or(200.0);
                Ok(FetchResponse {
                    ok: (200.0..300.0).contains(&status),
                    status,
                    opaque_redirect: false,
                    headers: ResponseHeaders::Get {
                        location: None,
                        content_length: None,
                    },
                    text: Some(Ok(o
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned())),
                })
            }
            _ => Err(FetchFailure::Error("fetch failed".into())),
        }
    }
}

impl MarkdownShell for FakeMarkdown {
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
    fn docx_exported(&self, path: &Path) {
        self.answers.answer("docx_exported", path.display());
        self.answers
            .log(json!(["docxExportedHook", path.to_string_lossy()]));
    }
    fn random_uuid(&self) -> String {
        let n = self.ids.fetch_add(1, Ordering::Relaxed) + 1;
        format!("{n:06}aa-0000-4000-8000-000000000000")
    }
}
