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
//!
//! In ipc-probe each call also writes one line to the case's host log, named
//! after the TypeScript function the method stands for; the group
//! `tools/ipc-diff/groups/d2/pdf-editor.ts` logs the same lines.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use main_core::pdf::font_locate::Platform;
use main_core::pdf::note_link::{FoundNoteLink, NoteLink, NoteLinks};
use main_core::pdf::ocr::OcrEnv;
use main_core::pdf::system_certificates::CertSummary;
use serde_json::{Value, json};
use shell_contract::runtime::CancelToken;
use shell_contract::{IpcValue, ViewId};

use super::hosts::*;
use crate::kit::from_json;

/// The case's host log (ipc-probe inserts it; absent in unit tests)
type Log = Arc<Mutex<Vec<Value>>>;

#[derive(Default)]
struct Answers {
    case: Value,
    used: Mutex<HashMap<String, usize>>,
    log: Option<Log>,
}

impl Answers {
    fn line(&self, line: Value) {
        if let Some(log) = &self.log {
            log.lock().unwrap().push(line)
        }
    }

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

fn js(v: &IpcValue) -> Value {
    crate::kit::to_json(v).unwrap_or(Value::Null)
}

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
    fn line(&self, line: Value) {
        self.0.line(line)
    }
}

fn write(target: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::write(target, bytes).map_err(|e| e.to_string())
}

fn read(path: &str) -> Result<Vec<u8>, String> {
    std::fs::read(path).map_err(|e| e.to_string())
}

impl PdfEngine for FakeEngine {
    fn save_pdf_to_path(
        &self,
        source: &str,
        target: &str,
        _r: &IpcValue,
    ) -> Result<SaveSkips, String> {
        self.line(json!(["savePdfToPath", source, target]));
        let skips = self.skips("savePdfToPath")?;
        write(target, &read(source)?)?;
        Ok(skips)
    }
    fn save_pdf_bytes_to_path(
        &self,
        source: &[u8],
        target: &str,
        _r: &IpcValue,
    ) -> Result<SaveSkips, String> {
        self.line(json!(["savePdfBytesToPath", target]));
        let skips = self.skips("savePdfBytesToPath")?;
        write(target, source)?;
        Ok(skips)
    }
    fn copy_pdf_to_path(&self, source: &str, target: &str) -> Result<(), String> {
        self.line(json!(["copyPdfToPath", source, target]));
        self.0.get("copyPdfToPath")?;
        write(target, &read(source)?)
    }
    fn pdf_bytes_with_edits(&self, source: &str, _r: &IpcValue) -> Result<Vec<u8>, String> {
        self.line(json!(["pdfBytesWithEdits", source]));
        let input = read(source)?;
        self.bytes_or("pdfBytesWithEdits", &input)
    }
    fn pdf_bytes_with_edits_of(&self, file: &[u8], _r: &IpcValue) -> Result<Vec<u8>, String> {
        self.line(json!(["pdfBytesWithEditsOf"]));
        self.bytes_or("pdfBytesWithEditsOf", file)
    }
    fn pdf_bytes_with_edits_from(&self, source: &[u8], _r: &IpcValue) -> Result<Vec<u8>, String> {
        self.line(json!(["pdfBytesWithEditsFrom"]));
        self.bytes_or("pdfBytesWithEditsFrom", source)
    }
    fn read_static_form_fills(&self, _b: &[u8]) -> Result<IpcValue, String> {
        self.line(json!(["readStaticFormFills"]));
        self.ipc("readStaticFormFills", IpcValue::Array(Vec::new()))
    }
    fn extract_pages(&self, b: &[u8], pages: &IpcValue) -> Result<Vec<u8>, String> {
        self.line(json!(["extractPagesBytes", js(pages)]));
        self.bytes_or("extractPages", b)
    }
    fn insert_pdf(
        &self,
        target: &[u8],
        other: &[u8],
        after: f64,
    ) -> Result<(Vec<u8>, f64), String> {
        self.line(json!(["insertPdfBytes", after]));
        let count = num(self.0.get("insertPdf")?.as_ref(), 1.0);
        Ok(([target, other].concat(), count))
    }
    fn insert_blank_page(&self, b: &[u8], after: f64) -> Result<Vec<u8>, String> {
        self.line(json!(["insertBlankPageBytes", after]));
        self.bytes_or("insertBlankPage", b)
    }
    fn split_pdf(&self, b: &[u8], chunk: f64) -> Result<Vec<Vec<u8>>, String> {
        self.line(json!(["splitPdfBytes", chunk]));
        Ok(match self.0.get("splitPdf")? {
            Some(Value::Array(parts)) => parts.iter().map(bytes).collect(),
            _ => vec![b.to_vec()],
        })
    }
    fn merge_pages(
        &self,
        b: &[u8],
        per_sheet: f64,
        horizontal: bool,
        separator: bool,
    ) -> Result<Vec<u8>, String> {
        let direction = if horizontal { "horizontal" } else { "vertical" };
        self.line(json!(["mergePagesBytes", per_sheet, direction, separator]));
        self.bytes_or("mergePages", b)
    }
    fn merge_pdf(&self, base: &[u8], others: &[Vec<u8>]) -> Result<(Vec<u8>, f64), String> {
        self.line(json!(["mergePdfBytes", others.len()]));
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
        self.line(json!(["replacePagesBytes", js(pages)]));
        self.0.get("replacePages")?;
        Ok((
            [target, other].concat(),
            pages.clone(),
            IpcValue::Number(1.0),
        ))
    }
    fn set_page_size(&self, b: &[u8], width: f64, height: f64) -> Result<Vec<u8>, String> {
        self.line(json!(["setPageSizeBytes", width, height]));
        self.bytes_or("setPageSize", b)
    }
    fn split_pages(&self, b: &[u8], per_page: f64) -> Result<Vec<u8>, String> {
        self.line(json!(["splitPagesBytes", per_page]));
        self.bytes_or("splitPages", b)
    }
    fn crop_pages(&self, b: &[u8], pages: &IpcValue, rect: &IpcValue) -> Result<Vec<u8>, String> {
        self.line(json!(["cropPagesBytes", js(pages), js(rect)]));
        self.bytes_or("cropPages", b)
    }
    fn copied_pages_of(
        &self,
        source: &[u8],
        _r: &IpcValue,
        positions: &IpcValue,
    ) -> Result<Option<(Vec<u8>, f64)>, String> {
        self.line(json!(["copiedPagesOf", js(positions)]));
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
        self.line(json!(["shrinkDocument"]));
        let v = self.0.get("shrink")?.unwrap_or(Value::Null);
        Ok(Shrunk {
            bytes: v.get("bytes").map_or_else(|| source.to_vec(), bytes),
            streams_recompressed: num(v.get("streamsRecompressed"), 0.0),
            images_downsampled: num(v.get("imagesDownsampled"), 0.0),
        })
    }
    fn decrypt_document(&self, b: &[u8], password: &str) -> Result<Decrypted, DecryptError> {
        self.line(json!(["decryptDocument", password]));
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
        self.line(json!(["readAnnotSubjects"]));
        self.ipc("readAnnotSubjects", IpcValue::Array(Vec::new()))
    }
    fn list_page_images(&self, _b: &[u8]) -> Result<IpcValue, String> {
        self.line(json!(["listPageImages"]));
        self.ipc("listPageImages", IpcValue::Array(Vec::new()))
    }
    fn render_image_png(
        &self,
        _b: &[u8],
        page_index: f64,
        rect: &IpcValue,
        scale: f64,
    ) -> Result<IpcValue, String> {
        self.line(json!(["renderImagePng", page_index, js(rect), scale]));
        self.ipc("renderImagePng", IpcValue::Null)
    }
    fn render_page_preview_png(&self, _b: &[u8], request: &IpcValue) -> Result<IpcValue, String> {
        self.line(json!(["renderPagePreviewPng", js(request)]));
        self.ipc("renderPagePreviewPng", IpcValue::Null)
    }
    fn validate_text_edits(&self, _b: &[u8], edits: &IpcValue) -> Result<IpcValue, String> {
        self.line(json!(["validateTextEdits", js(edits)]));
        self.ipc("validateTextEdits", IpcValue::Array(Vec::new()))
    }
    fn can_draw_text(
        &self,
        text: &str,
        font: Option<&str>,
        bold: bool,
        italic: bool,
    ) -> Result<bool, String> {
        self.line(json!(["canDrawText", text, font, bold, italic]));
        Ok(self
            .0
            .get("canDrawText")?
            .and_then(|v| v.as_bool())
            .unwrap_or(true))
    }
    fn read_pdf_text(&self, b: &[u8], password: Option<&str>) -> Result<PdfText, String> {
        self.line(json!(["readPdfText", password]));
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
        self.line(json!(["readPdfSignatures"]));
        self.ipc("readPdfSignatures", IpcValue::Array(Vec::new()))
    }
    fn describe_certificate(&self, _input: &[u8]) -> Option<CertSummary> {
        None
    }
    fn open_certificate(&self, material: &CertMaterial) -> Result<Vec<IpcValue>, String> {
        match material {
            CertMaterial::P12 { password, .. } => self.line(json!(["openCertificate", password])),
            CertMaterial::InPlace(_) => self.line(json!(["openExternalCertificate"])),
        }
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
        o: &SignOptions,
    ) -> Result<Vec<u8>, SignFailure> {
        self.line(json!(["signPdf", o.reason, o.certify_level]));
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
        prompt: &str,
        aspect: Option<&str>,
        open: Option<&str>,
        _d: &str,
        _c: &CancelToken,
    ) -> Result<IpcValue, String> {
        self.line(json!(["generateImageTool", prompt, aspect, open]));
        self.ipc("generateImage", IpcValue::Null)
    }
    fn read_note_links(&self, _u: &str) -> Result<NoteLinks, String> {
        self.line(json!(["ResultStore.readNoteLinks"]));
        self.0.get("readNoteLinks")?;
        Ok(NoteLinks {
            links: jscompat::JsMap::new(),
        })
    }
    fn find_note_link(
        &self,
        _u: &str,
        pdf_path: &str,
        hash: &str,
    ) -> Result<Option<FoundNoteLink>, String> {
        self.line(json!(["ResultStore.findNoteLink", pdf_path, hash]));
        self.0.get("findNoteLink")?;
        Ok(None)
    }
    fn set_note_link(&self, _u: &str, pdf_path: &str, link: &NoteLink) -> Result<(), String> {
        self.line(json!([
            "ResultStore.setNoteLink",
            pdf_path,
            link.note_path,
            link.doc_hash
        ]));
        self.0.get("setNoteLink").map(|_| ())
    }
    fn update_note_link_doc_hash(
        &self,
        _u: &str,
        pdf_path: &str,
        hash: &str,
    ) -> Result<bool, String> {
        self.line(json!(["ResultStore.updateNoteLinkDocHash", pdf_path, hash]));
        self.0.get("updateNoteLinkDocHash").map(|_| true)
    }
    fn document_hash_of_file(&self, path: &str) -> Result<String, String> {
        self.line(json!(["documentHashOfFile", path]));
        read(path).map(|b| main_core::markdown::fs_util::sha256_hex(&b))
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
    uuids: Mutex<u64>,
}

impl FakeShell {
    fn log(&self, call: String, line: Value) {
        self.calls.lock().unwrap().push(call);
        self.answers.line(line);
    }
    fn flag(&self, name: &str) -> bool {
        self.answers
            .take(name)
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    }
    fn configured(&self, name: &str) -> bool {
        self.answers.case.get(name).is_some()
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
    /// the host's, as the TypeScript's `process.platform`
    fn platform(&self) -> Platform {
        if cfg!(target_os = "macos") {
            Platform::Darwin
        } else if cfg!(windows) {
            Platform::Win32
        } else {
            Platform::Other
        }
    }
    fn is_path_open_elsewhere(&self, _path: &str) -> bool {
        self.flag("isPathOpenElsewhere")
    }
    fn open_generated_path(&self, path: &str) -> Result<bool, String> {
        self.log(
            format!("openGeneratedPath {path}"),
            json!(["openGeneratedPath", path]),
        );
        Ok(self.flag("openGeneratedPath"))
    }
    fn create_document(
        &self,
        request: &IpcValue,
        owner: ViewId,
    ) -> Option<Result<IpcValue, String>> {
        if !self.configured("createDocument") {
            return None;
        }
        self.log(
            format!("createDocument {} {request:?}", owner.0),
            json!(["createDocument", js(request), owner.0]),
        );
        self.answers
            .get("createDocument")
            .map(|v| v.map(|v| from_json(&v)))
            .transpose()
    }
    fn open_pdf_tools(&self, path: &str, tool: &str) -> Option<bool> {
        if !self.configured("openPdfTools") {
            return None;
        }
        self.log(
            format!("openPdfTools {path} {tool}"),
            json!(["openPdfTools", path, tool]),
        );
        self.answers.take("openPdfTools").and_then(|v| v.as_bool())
    }
    fn has_note_hooks(&self) -> bool {
        self.flag("noteHooks")
    }
    fn open_note(&self, path: &str) -> Result<bool, String> {
        self.log(format!("openNote {path}"), json!(["openNote", path]));
        Ok(true)
    }
    fn insert_into_note(&self, path: &str, text: &str) -> Result<bool, String> {
        self.log(
            format!("insertIntoNote {path}"),
            json!(["insertIntoNote", path, text]),
        );
        Ok(true)
    }
    fn new_document_dir(&self, _view: ViewId) -> Option<String> {
        self.answers
            .take("newDocumentDir")
            .and_then(|v| v.as_str().map(str::to_owned))
    }
    fn redaction_saved(&self, view: ViewId, path: &str) -> Result<(), String> {
        self.log(
            format!("redactionSaved {} {path}", view.0),
            json!(["pdfRedactionSavedHook", view.0, path]),
        );
        Ok(())
    }
    fn renamed(&self, view: ViewId, old_path: &str, new_path: &str) -> Result<(), String> {
        self.log(
            format!("renamed {} {old_path} {new_path}", view.0),
            json!(["pdfRenamedHook", view.0, old_path, new_path]),
        );
        Ok(())
    }
    fn reload(&self, view: ViewId) {
        self.log(
            format!("reload {}", view.0),
            json!(["webContents.reload", view.0]),
        );
    }
    fn watch_dir(&self, dir: &str, on_event: WatchListener) -> Option<u64> {
        let mut w = self.watchers.lock().unwrap();
        let id = w.len() as u64 + 1;
        w.push((id, dir.to_owned(), on_event));
        Some(id)
    }
    fn close_watch(&self, handle: u64) {
        self.calls
            .lock()
            .unwrap()
            .push(format!("closeWatch {handle}"));
        self.watchers
            .lock()
            .unwrap()
            .retain(|(id, _, _)| *id != handle);
    }
    /// numbered from 1 in each case, as the group's `randomUUID`
    fn random_uuid(&self) -> String {
        let mut n = self.uuids.lock().unwrap();
        *n += 1;
        format!("00000000-0000-4000-8000-{:012}", *n)
    }
    fn ocr_env(&self) -> OcrEnv {
        OcrEnv {
            platform: Platform::Other,
            here: String::new(),
            resources_path: None,
        }
    }
}

fn answers(case: &Value, key: &str, log: Option<Log>) -> Answers {
    Answers {
        case: case.get(key).cloned().unwrap_or(Value::Null),
        used: Mutex::default(),
        log,
    }
}

#[cfg(test)]
pub fn engine(case: &Value) -> Arc<FakeEngine> {
    Arc::new(FakeEngine(answers(case, "engine", None)))
}

#[cfg(test)]
pub fn shell(case: &Value) -> Arc<FakeShell> {
    Arc::new(FakeShell {
        answers: answers(case, "shell", None),
        ..Default::default()
    })
}

/// The engine answers from `case.engine`, the shell from `case.shell`; both
/// log to the case's host log when there is one
pub(super) fn insert(hosts: &mut shell_contract::Hosts, case: &Value) {
    let log = hosts.get::<Log>().cloned();
    hosts.insert::<PdfEngineHost>(Arc::new(FakeEngine(answers(case, "engine", log.clone()))));
    hosts.insert::<PdfShellHost>(Arc::new(FakeShell {
        answers: answers(case, "shell", log),
        ..Default::default()
    }));
}
