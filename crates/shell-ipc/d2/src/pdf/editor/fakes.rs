//! Fakes of [`PdfEngine`] and [`PdfShell`] for the tests and ipc-probe.
//!
//! Both answer from `case` (the case's `hosts.d2.pdf`): `case[<method name in
//! camelCase>]` is the answer, an array of answers is consumed one per call
//! (the last one repeats), and `{ "error": "..." }` makes the call fail with
//! that message. Without an answer each method does the neutral thing:
//! byte operations hand back their input (a save writes the source bytes to
//! the target, so the folder shows the write), reads answer `[]` or `null`,
//! and the shell hooks are absent (`createDocument`, `openPdfTools`, notes)
//! or succeed (`redactionSaved`, `renamed`). Bytes in answers are strings,
//! taken as their UTF-8 bytes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use main_core::pdf::font_locate::Platform;
use main_core::pdf::note_link::{FoundNoteLink, NoteLink, NoteLinks};
use main_core::pdf::ocr::OcrEnv;
use main_core::pdf::system_certificates::CertSummary;
use serde_json::Value;
use shell_contract::runtime::CancelToken;
use shell_contract::{IpcValue, ViewId};

use super::hosts::*;
use crate::kit::from_json;

#[derive(Default)]
struct Answers {
    case: Value,
    used: Mutex<HashMap<String, usize>>,
}

impl Answers {
    fn take(&self, name: &str) -> Option<Value> {
        match self.case.get(name)? {
            Value::Array(items) if !items.is_empty() && name_takes_turns(name) => {
                let mut used = self.used.lock().unwrap();
                let n = used.entry(name.to_owned()).or_insert(0);
                let item = items[(*n).min(items.len() - 1)].clone();
                *n += 1;
                Some(item)
            }
            v => Some(v.clone()),
        }
    }

    /// The answer, or the error it asks for
    fn get(&self, name: &str) -> Result<Option<Value>, String> {
        match self.take(name) {
            Some(Value::Object(o)) if o.get("error").is_some_and(Value::is_string) => {
                Err(o["error"].as_str().unwrap_or_default().to_owned())
            }
            v => Ok(v),
        }
    }
}

/// Methods whose single answer is itself an array take turns only when the
/// case gives an array of arrays; the others take turns over any array
fn name_takes_turns(name: &str) -> bool {
    !matches!(
        name,
        "readStaticFormFills"
            | "readAnnotSubjects"
            | "listPageImages"
            | "validateTextEdits"
            | "readPdfSignatures"
            | "openCertificate"
    )
}

fn bytes(v: &Value) -> Vec<u8> {
    v.as_str().unwrap_or_default().as_bytes().to_vec()
}

fn num(v: Option<&Value>, default: f64) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(default)
}

/// `PdfEngine` answering from the case
pub struct FakeEngine(Answers);

impl FakeEngine {
    fn ipc(&self, name: &str, default: IpcValue) -> Result<IpcValue, String> {
        Ok(self.0.get(name)?.as_ref().map_or(default, from_json))
    }
    fn bytes_or(&self, name: &str, input: &[u8]) -> Result<Vec<u8>, String> {
        Ok(self
            .0
            .get(name)?
            .as_ref()
            .map_or_else(|| input.to_vec(), bytes))
    }
    fn skips(&self, name: &str) -> Result<SaveSkips, String> {
        let v = self.0.get(name)?.unwrap_or(Value::Null);
        let list = |k: &str| match v.get(k) {
            Some(Value::Array(items)) => items.iter().map(from_json).collect(),
            _ => Vec::new(),
        };
        Ok(SaveSkips {
            text_edits: list("skippedTextEdits"),
            text_inserts: list("skippedTextInserts"),
            image_edits: list("skippedImageEdits"),
        })
    }
}

fn write(target: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(target, bytes).map_err(|e| e.to_string())
}

impl PdfEngine for FakeEngine {
    fn save_pdf_to_path(
        &self,
        source: &str,
        target: &str,
        _r: &IpcValue,
    ) -> Result<SaveSkips, String> {
        let skips = self.skips("savePdfToPath")?;
        write(target, &std::fs::read(source).map_err(|e| e.to_string())?)?;
        Ok(skips)
    }
    fn save_pdf_bytes_to_path(
        &self,
        source: &[u8],
        target: &str,
        _r: &IpcValue,
    ) -> Result<SaveSkips, String> {
        let skips = self.skips("savePdfBytesToPath")?;
        write(target, source)?;
        Ok(skips)
    }
    fn copy_pdf_to_path(&self, source: &str, target: &str) -> Result<(), String> {
        self.0.get("copyPdfToPath")?;
        std::fs::copy(source, target)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    fn pdf_bytes_with_edits(&self, source: &str, _r: &IpcValue) -> Result<Vec<u8>, String> {
        let input = std::fs::read(source).map_err(|e| e.to_string())?;
        self.bytes_or("pdfBytesWithEdits", &input)
    }
    fn pdf_bytes_with_edits_of(&self, file: &[u8], _r: &IpcValue) -> Result<Vec<u8>, String> {
        self.bytes_or("pdfBytesWithEditsOf", file)
    }
    fn pdf_bytes_with_edits_from(&self, source: &[u8], _r: &IpcValue) -> Result<Vec<u8>, String> {
        self.bytes_or("pdfBytesWithEditsFrom", source)
    }
    fn read_static_form_fills(&self, _b: &[u8]) -> Result<IpcValue, String> {
        self.ipc("readStaticFormFills", IpcValue::Array(Vec::new()))
    }
    fn extract_pages(&self, b: &[u8], _p: &IpcValue) -> Result<Vec<u8>, String> {
        self.bytes_or("extractPages", b)
    }
    fn insert_pdf(
        &self,
        target: &[u8],
        other: &[u8],
        _after: f64,
    ) -> Result<(Vec<u8>, f64), String> {
        let count = num(self.0.get("insertPdf")?.as_ref(), 1.0);
        Ok(([target, other].concat(), count))
    }
    fn insert_blank_page(&self, b: &[u8], _after: f64) -> Result<Vec<u8>, String> {
        self.bytes_or("insertBlankPage", b)
    }
    fn split_pdf(&self, b: &[u8], _chunk: f64) -> Result<Vec<Vec<u8>>, String> {
        Ok(match self.0.get("splitPdf")? {
            Some(Value::Array(parts)) => parts.iter().map(bytes).collect(),
            _ => vec![b.to_vec()],
        })
    }
    fn merge_pages(&self, b: &[u8], _n: f64, _h: bool, _s: bool) -> Result<Vec<u8>, String> {
        self.bytes_or("mergePages", b)
    }
    fn merge_pdf(&self, base: &[u8], others: &[Vec<u8>]) -> Result<(Vec<u8>, f64), String> {
        self.0.get("mergePdf")?;
        Ok((
            [base.to_vec(), others.concat()].concat(),
            others.len() as f64,
        ))
    }
    fn replace_pages(
        &self,
        target: &[u8],
        other: &[u8],
        pages: &IpcValue,
    ) -> Result<(Vec<u8>, IpcValue, IpcValue), String> {
        self.0.get("replacePages")?;
        Ok((
            [target, other].concat(),
            pages.clone(),
            IpcValue::Number(1.0),
        ))
    }
    fn set_page_size(&self, b: &[u8], _w: f64, _h: f64) -> Result<Vec<u8>, String> {
        self.bytes_or("setPageSize", b)
    }
    fn split_pages(&self, b: &[u8], _n: f64) -> Result<Vec<u8>, String> {
        self.bytes_or("splitPages", b)
    }
    fn crop_pages(&self, b: &[u8], _p: &IpcValue, _r: &IpcValue) -> Result<Vec<u8>, String> {
        self.bytes_or("cropPages", b)
    }
    fn copied_pages_of(
        &self,
        source: &[u8],
        _r: &IpcValue,
        positions: &IpcValue,
    ) -> Result<Option<(Vec<u8>, f64)>, String> {
        match self.0.get("copiedPagesOf")? {
            Some(Value::Null) => Ok(None),
            Some(v) => Ok(Some((bytes(&v), 1.0))),
            None => {
                let n = match positions {
                    IpcValue::Array(p) => p.len() as f64,
                    _ => 0.0,
                };
                Ok((n > 0.0).then(|| (source.to_vec(), n)))
            }
        }
    }
    fn shrink(&self, source: &[u8]) -> Result<Shrunk, String> {
        let v = self.0.get("shrink")?.unwrap_or(Value::Null);
        Ok(Shrunk {
            bytes: v.get("bytes").map_or_else(|| source.to_vec(), bytes),
            streams_recompressed: num(v.get("streamsRecompressed"), 0.0),
            images_downsampled: num(v.get("imagesDownsampled"), 0.0),
        })
    }
    fn decrypt_document(&self, b: &[u8], password: &str) -> Result<Decrypted, DecryptError> {
        match self.0.get("decryptDocument") {
            Err(e) if e == "wrong-password" => Err(DecryptError::WrongPassword),
            Err(e) if e == "certificate-encryption" => Err(DecryptError::CertificateEncryption),
            Err(e) => Err(DecryptError::Other(e)),
            Ok(_) => Ok(Decrypted {
                bytes: b.to_vec(),
                permissions: IpcValue::Object(Vec::new()),
                needed_password: !password.is_empty(),
                unlocked_as: "user".into(),
            }),
        }
    }
    fn read_annot_subjects(&self, _b: &[u8]) -> Result<IpcValue, String> {
        self.ipc("readAnnotSubjects", IpcValue::Array(Vec::new()))
    }
    fn list_page_images(&self, _b: &[u8]) -> Result<IpcValue, String> {
        self.ipc("listPageImages", IpcValue::Array(Vec::new()))
    }
    fn render_image_png(
        &self,
        _b: &[u8],
        _i: f64,
        _r: &IpcValue,
        _s: f64,
    ) -> Result<IpcValue, String> {
        self.ipc("renderImagePng", IpcValue::Null)
    }
    fn render_page_preview_png(&self, _b: &[u8], _r: &IpcValue) -> Result<IpcValue, String> {
        self.ipc("renderPagePreviewPng", IpcValue::Null)
    }
    fn validate_text_edits(&self, _b: &[u8], _e: &IpcValue) -> Result<IpcValue, String> {
        self.ipc("validateTextEdits", IpcValue::Array(Vec::new()))
    }
    fn can_draw_text(
        &self,
        _t: &str,
        _f: Option<&str>,
        _b: bool,
        _i: bool,
    ) -> Result<bool, String> {
        Ok(self
            .0
            .get("canDrawText")?
            .and_then(|v| v.as_bool())
            .unwrap_or(true))
    }
    fn read_pdf_text(&self, b: &[u8], _p: Option<&str>) -> Result<PdfText, String> {
        let v = self.0.get("readPdfText")?;
        let pages: Vec<String> = match v.as_ref().and_then(|v| v.get("pages")) {
            Some(Value::Array(p)) => p
                .iter()
                .map(|s| s.as_str().unwrap_or_default().to_owned())
                .collect(),
            _ => vec![String::from_utf8_lossy(b).into_owned()],
        };
        Ok(PdfText {
            page_count: pages.len() as f64,
            pages,
        })
    }
    fn read_pdf_signatures(&self, _b: &[u8]) -> Result<IpcValue, String> {
        self.ipc("readPdfSignatures", IpcValue::Array(Vec::new()))
    }
    fn describe_certificate(&self, _input: &[u8]) -> Option<CertSummary> {
        None
    }
    fn open_certificate(&self, _m: &CertMaterial) -> Result<Vec<IpcValue>, String> {
        match self.0.get("openCertificate")? {
            Some(Value::Array(info)) => Ok(info.iter().map(from_json).collect()),
            _ => Ok(vec![crate::kit::obj([(
                "commonName",
                IpcValue::String("Fake".into()),
            )])]),
        }
    }
    fn sign_pdf(
        &self,
        b: &[u8],
        _m: &CertMaterial,
        _o: &SignOptions,
    ) -> Result<Vec<u8>, SignFailure> {
        match self.0.take("signPdf") {
            Some(v) if v.get("code").is_some() => Err(SignFailure::Code(
                v["code"].as_str().unwrap_or_default().into(),
            )),
            Some(v) if v.get("error").is_some() => Err(SignFailure::Message(
                v["error"].as_str().unwrap_or_default().into(),
            )),
            _ => Ok([b, b"%signed"].concat()),
        }
    }
    fn generate_image(
        &self,
        _s: &str,
        _p: &str,
        _a: Option<&str>,
        _o: Option<&str>,
        _d: &str,
        _c: &CancelToken,
    ) -> Result<IpcValue, String> {
        self.ipc("generateImage", IpcValue::Null)
    }
    fn read_note_links(&self, _u: &str) -> Result<NoteLinks, String> {
        self.0.get("readNoteLinks")?;
        Ok(NoteLinks {
            links: jscompat::JsMap::new(),
        })
    }
    fn find_note_link(
        &self,
        _u: &str,
        _p: &str,
        _h: &str,
    ) -> Result<Option<FoundNoteLink>, String> {
        self.0.get("findNoteLink")?;
        Ok(None)
    }
    fn set_note_link(&self, _u: &str, _p: &str, _l: &NoteLink) -> Result<(), String> {
        self.0.get("setNoteLink").map(|_| ())
    }
    fn update_note_link_doc_hash(&self, _u: &str, _p: &str, _h: &str) -> Result<bool, String> {
        self.0.get("updateNoteLinkDocHash").map(|_| true)
    }
    fn document_hash_of_file(&self, path: &str) -> Result<String, String> {
        std::fs::read(path)
            .map(|b| main_core::markdown::fs_util::sha256_hex(&b))
            .map_err(|e| e.to_string())
    }
}

type WatchListener = Box<dyn Fn(Option<String>) + Send + Sync>;

/// `PdfShell` answering from the case; it records the hooks it was called
/// with and keeps folder-watch listeners so a test can fire them
#[derive(Default)]
pub struct FakeShell {
    answers: Answers,
    pub calls: Mutex<Vec<String>>,
    pub watchers: Mutex<Vec<(u64, String, WatchListener)>>,
}

impl FakeShell {
    fn log(&self, call: String) {
        self.calls.lock().unwrap().push(call)
    }
    fn flag(&self, name: &str) -> bool {
        self.answers
            .take(name)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
}

impl PdfShell for FakeShell {
    fn ui_lang(&self) -> String {
        self.answers
            .take("uiLang")
            .and_then(|v| v.as_str().map(str::to_owned))
            .unwrap_or_else(|| "en".into())
    }
    fn username(&self) -> Option<String> {
        self.answers
            .take("username")
            .and_then(|v| v.as_str().map(str::to_owned))
    }
    fn platform(&self) -> Platform {
        Platform::Other
    }
    fn is_path_open_elsewhere(&self, _path: &str) -> bool {
        self.flag("isPathOpenElsewhere")
    }
    fn open_generated_path(&self, path: &str) -> Result<bool, String> {
        self.log(format!("openGeneratedPath {path}"));
        Ok(self.flag("openGeneratedPath"))
    }
    fn create_document(
        &self,
        request: &IpcValue,
        owner: ViewId,
    ) -> Option<Result<IpcValue, String>> {
        self.log(format!("createDocument {} {request:?}", owner.0));
        self.answers
            .get("createDocument")
            .map(|v| v.map(|v| from_json(&v)))
            .transpose()
    }
    fn open_pdf_tools(&self, path: &str, tool: &str) -> Option<bool> {
        self.log(format!("openPdfTools {path} {tool}"));
        self.answers.take("openPdfTools").and_then(|v| v.as_bool())
    }
    fn has_note_hooks(&self) -> bool {
        self.flag("noteHooks")
    }
    fn open_note(&self, path: &str) -> Result<bool, String> {
        self.log(format!("openNote {path}"));
        Ok(true)
    }
    fn insert_into_note(&self, path: &str, _text: &str) -> Result<bool, String> {
        self.log(format!("insertIntoNote {path}"));
        Ok(true)
    }
    fn new_document_dir(&self, _view: ViewId) -> Option<String> {
        self.answers
            .take("newDocumentDir")
            .and_then(|v| v.as_str().map(str::to_owned))
    }
    fn redaction_saved(&self, view: ViewId, path: &str) -> Result<(), String> {
        self.log(format!("redactionSaved {} {path}", view.0));
        Ok(())
    }
    fn renamed(&self, view: ViewId, old_path: &str, new_path: &str) -> Result<(), String> {
        self.log(format!("renamed {} {old_path} {new_path}", view.0));
        Ok(())
    }
    fn reload(&self, view: ViewId) {
        self.log(format!("reload {}", view.0));
    }
    fn watch_dir(&self, dir: &str, on_event: WatchListener) -> Option<u64> {
        let mut w = self.watchers.lock().unwrap();
        let id = w.len() as u64 + 1;
        w.push((id, dir.to_owned(), on_event));
        Some(id)
    }
    fn close_watch(&self, handle: u64) {
        self.log(format!("closeWatch {handle}"));
        self.watchers
            .lock()
            .unwrap()
            .retain(|(id, _, _)| *id != handle);
    }
    fn ocr_env(&self) -> OcrEnv {
        OcrEnv {
            platform: Platform::Other,
            here: String::new(),
            resources_path: None,
        }
    }
}

pub fn engine(case: &Value) -> Arc<FakeEngine> {
    Arc::new(FakeEngine(Answers {
        case: case.get("engine").cloned().unwrap_or(Value::Null),
        used: Mutex::default(),
    }))
}

pub fn shell(case: &Value) -> Arc<FakeShell> {
    Arc::new(FakeShell {
        answers: Answers {
            case: case.get("shell").cloned().unwrap_or(Value::Null),
            used: Mutex::default(),
        },
        ..Default::default()
    })
}

/// The engine answers from `case.engine`, the shell from `case.shell`
pub(super) fn insert(hosts: &mut shell_contract::Hosts, case: &Value) {
    hosts.insert::<PdfEngineHost>(engine(case));
    hosts.insert::<PdfShellHost>(shell(case));
}
