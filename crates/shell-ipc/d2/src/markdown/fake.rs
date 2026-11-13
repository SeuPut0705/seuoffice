//! The fakes of the Markdown editor's hosts, for unit tests and ipc-probe.

use std::path::{Path, PathBuf};

use main_core::markdown::image_host::{FetchFailure, FetchInit, FetchResponse, ResponseHeaders};
use main_core::packages::electron_utils::print_html_pdf::PrintWindow;
use main_core::packages::electron_utils::print_window::JsError;
use main_core::packages::electron_utils::safe_remote_url::{Fetcher, Resolver, Response};
use serde_json::Value;
use shell_contract::ViewId;

use super::{MarkdownEngine, MarkdownShell};
use crate::html::fake::{Answers, NoNetwork};
use crate::html::odt_export::{OdtConversion, ReportItem};

/// A hidden print window that answers `print_pdf`'s bytes
struct FakeWindow(Result<Vec<u8>, String>);

impl PrintWindow for FakeWindow {
    fn load_file(&mut self, _path: &str) -> Result<(), JsError> {
        Ok(())
    }
    fn print_to_pdf(&mut self, _options: &serde_json::Value) -> Result<Vec<u8>, JsError> {
        self.0.clone().map_err(|message| JsError {
            code: None,
            message,
        })
    }
    fn destroy(&mut self) -> Result<(), JsError> {
        Ok(())
    }
}

/// The Markdown editor's engine and shell hooks in one fake. Answers (case
/// keys, defaults in brackets): `print_pdf` [`"%PDF"`; `{ "error": text }`
/// fails], `docx_to_odt` [`{ "odt": "ODT", "report": [] }`], `upload_fetch`
/// [a failed request; `{ "status": n, "text": body }` answers], `is_headless`
/// [false], `ui_lang` [`"en"`], `is_path_open_elsewhere` [false],
/// `open_generated_path` [false], `new_document_dir` [null],
/// `write_new_document` [null; a folder the file is written into]. The
/// network and `net.fetch` always fail.
pub(crate) struct FakeMarkdown {
    pub answers: Answers,
}

impl FakeMarkdown {
    pub(crate) fn new(case: &Value) -> Self {
        FakeMarkdown {
            answers: Answers::new(case),
        }
    }
}

impl MarkdownEngine for FakeMarkdown {
    fn print_window(&self) -> Box<dyn PrintWindow + Send> {
        Box::new(FakeWindow(self.answers.bytes("print_pdf", "", b"%PDF")))
    }
    fn docx_to_odt(&self, docx: Vec<u8>) -> Result<OdtConversion, String> {
        match self
            .answers
            .answer("docx_to_odt", String::from_utf8_lossy(&docx))
        {
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
    fn resolver(&self) -> Box<dyn Resolver + Send> {
        Box::new(NoNetwork)
    }
    fn fetcher(&self) -> Box<dyn Fetcher + Send> {
        Box::new(NoNetwork)
    }
    fn net_fetch(&self, url: &str) -> Result<Box<dyn Response>, String> {
        self.answers.answer("net_fetch", url);
        Err("TypeError: Failed to fetch".into())
    }
    fn upload_fetch(
        &self,
        url: &str,
        _init: &FetchInit<'_>,
    ) -> Result<FetchResponse, FetchFailure> {
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
    fn reload(&self, view: ViewId) {
        self.answers.answer("reload", view.0);
    }
    fn is_path_open_elsewhere(&self, path: &str) -> bool {
        self.answers.bool("is_path_open_elsewhere", path, false)
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
    fn docx_exported(&self, path: &Path) {
        self.answers.answer("docx_exported", path.display());
    }
}
