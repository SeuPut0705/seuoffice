//! The rest of the functions of group `b4-pdf`: text reading, redaction,
//! the signature store, notes, OCR, system certificates and wasm paths.

use super::{hex_decode, hex_encode, json_arg, num, pdfium_call, pdfium_error, utf8};
use crate::calls::{Answer, CallError, Context, arg, str_arg};
use crate::node_fs::NodeError;
use crate::pdf::font_locate::Platform;
use crate::pdf::note_link::{
    FoundNoteLink, MatchedBy, NOTE_DIALOG_KEYS, NOTE_DIALOG_TEXT, NoteHost, NoteInsertRequest,
    NoteLink, NoteLinkDeps, NoteLinkService, NoteLinkStore, NoteLinks, NoteResult, Thrown,
    default_note_path, note_dialog_text, note_insert_text, parse_note_insert_request,
    parse_note_open_request, pdf_link_from_note,
};
use crate::pdf::ocr::{OcrBridge, OcrEnv};

use crate::pdf::read_text::{ReadPdfTextOptions, read_pdf_text};
use crate::pdf::redaction::{MAX_REDACTION_REGIONS, redact_pdf, validate_redaction_regions};
use crate::pdf::signature_store::{
    MAX_SAVED_SIGNATURES, SavedSignature, add_signature, is_signature_data, load_signatures,
    remove_signature, sanitize_signatures, save_signatures,
};
use crate::pdf::system_certificates::{
    CertSummary, CertificateReader, RunResult, SystemCertificate, SystemCertificateListing,
    SystemCertificateRef, SystemIdentity, SystemStoreEnv, SystemStoreError, Thrown as CertThrown,
    WINDOWS_CHAIN_SCRIPT, WINDOWS_LIST_SCRIPT, WINDOWS_SIGN_SCRIPT, list_system_certificates,
    nss_database_dirs, open_system_signer, parse_nss_key_list, parse_windows_certificates,
    parse_windows_chain, run_command,
};
use crate::pdf::wasm_path::{WasmEnv, hb_subset_wasm_path, pdfium_wasm_path, qpdf_wasm_path};
use jscompat::{JsRegex, JsonValue, js_regex, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value, json};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

pub(super) fn rest(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "read-text.readPdfText" => pdfium_call(args, cx, |m| {
            let bytes = str_arg(args, 1)?;
            let options = read_options(arg(args, 2));
            read_pdf_text(m, bytes.as_bytes(), &options)
                .map(|doc| {
                    let mut info = Map::new();
                    if let Some(title) = &doc.title {
                        info.insert("title".into(), Value::String(title.clone()));
                    }
                    if let Some(author) = &doc.author {
                        info.insert("author".into(), Value::String(author.clone()));
                    }
                    let pages: Vec<Value> = doc
                        .pages
                        .iter()
                        .map(|p| {
                            json!({
                                "page": num(p.page),
                                "widthPt": num(p.width_pt),
                                "heightPt": num(p.height_pt),
                                "chars": p.chars,
                                "text": p.text,
                                "hasTextLayer": p.has_text_layer,
                            })
                        })
                        .collect();
                    Some(json!({
                        "pageCount": doc.page_count,
                        "info": Value::Object(info),
                        "pages": pages,
                        "truncated": doc.truncated,
                    }))
                })
                .map_err(pdfium_error)
        }),
        "redaction.MAX_REDACTION_REGIONS" => Ok(Some(Value::from(MAX_REDACTION_REGIONS))),
        "redaction.validateRedactionRegions" => {
            validate_redaction_regions(&json_arg(args, 0))
                .map(|regions| {
                    Some(Value::Array(
                        regions
                            .iter()
                            .map(|r| {
                                json!({
                                    "pageIndex": num(r.page_index),
                                    "rect": r.rect.iter().map(|&x| num(x)).collect::<Vec<_>>(),
                                })
                            })
                            .collect(),
                    ))
                })
                .map_err(pdfium_error)
        }
        "redaction.redactPdf" => pdfium_call(args, cx, |m| {
            let bytes = str_arg(args, 1)?;
            redact_pdf(m, bytes.as_bytes(), &json_arg(args, 2))
                .map(|out| Some(Value::String(utf8(&out))))
                .map_err(pdfium_error)
        }),
        "signature-store.MAX_SAVED_SIGNATURES" => Ok(Some(Value::from(MAX_SAVED_SIGNATURES))),
        "signature-store.isSignatureData" => {
            Ok(Some(Value::Bool(is_signature_data(&json_arg(args, 0)))))
        }
        "signature-store.sanitizeSignatures" => {
            Ok(Some(signatures_json(&sanitize_signatures(&json_arg(args, 0)))))
        }
        "signature-store.addSignature" => {
            let list = signatures_arg(args, 0);
            let now = arg(args, 2).and_then(Value::as_f64).unwrap_or(cx.now_ms);
            let mut out = add_signature(&list, &json_arg(args, 1), now);
            // the id of the new signature is random
            if let Some(first) = out.first_mut() {
                first.id = "<uuid>".to_owned();
            }
            Ok(Some(signatures_json(&out)))
        }
        "signature-store.removeSignature" => str_arg(args, 1).map(|id| {
            Some(signatures_json(&remove_signature(&signatures_arg(args, 0), id)))
        }),
        "signature-store.loadSignatures" => {
            str_arg(args, 0).map(|path| Some(signatures_json(&load_signatures(path))))
        }
        "signature-store.saveSignatures" => str_arg(args, 0).and_then(|path| {
            save_signatures(path, &signatures_arg(args, 1), std::process::id())
                .map(|()| None)
                .map_err(node_call_error)
        }),
        "note-link.pdfLinkFromNote" => str_arg(args, 0).and_then(|note| {
            let pdf = str_arg(args, 1)?;
            Ok(Some(Value::String(pdf_link_from_note(
                note,
                pdf,
                platform_arg(args, 2),
            ))))
        }),
        "note-link.noteInsertText" => str_arg(args, 0).and_then(|note| {
            let pdf = str_arg(args, 1)?;
            let request = insert_request(arg(args, 2));
            Ok(Some(Value::String(note_insert_text(
                note,
                pdf,
                &request,
                platform_arg(args, 3),
            ))))
        }),
        "note-link.parseNoteInsertRequest" => {
            let raw = arg(args, 0).map(json_value_from_serde);
            Ok(Some(match parse_note_insert_request(raw.as_ref()) {
                Some(request) => request_json(&request),
                None => Value::Null,
            }))
        }
        "note-link.parseNoteOpenRequest" => {
            let raw = arg(args, 0).map(json_value_from_serde);
            let request = parse_note_open_request(raw.as_ref());
            let mut out = Map::new();
            if let Some(title) = request.title {
                out.insert("title".into(), Value::String(title));
            }
            Ok(Some(Value::Object(out)))
        }
        "note-link.defaultNotePath" => str_arg(args, 0).and_then(|pdf| {
            let word = str_arg(args, 1)?;
            Ok(Some(Value::String(default_note_path(
                pdf,
                word,
                platform_arg(args, 2),
            ))))
        }),
        "note-link.NOTE_DIALOG_TEXT" => {
            let mut out = Map::new();
            for (lang, words) in NOTE_DIALOG_TEXT {
                let mut row = Map::new();
                for (key, word) in NOTE_DIALOG_KEYS.iter().zip(words) {
                    row.insert((*key).to_owned(), Value::String(word.to_owned()));
                }
                out.insert(lang.to_owned(), Value::Object(row));
            }
            Ok(Some(Value::Object(out)))
        }
        "note-link.noteDialogText" => str_arg(args, 0).and_then(|lang| {
            let key = str_arg(args, 1)?;
            Ok(note_dialog_text(lang, key).map(|text| Value::String(text.to_owned())))
        }),
        "note-link.createNoteLinkService" => note_service(args, cx),
        "ocr.ocrPagePng" => ocr_call(args),
        "system-certificates.SystemStoreError" => str_arg(args, 0).map(|code| {
            let e = SystemStoreError::new(code);
            Some(json!({"code": e.code, "message": e.code}))
        }),
        "system-certificates.runCommand" => str_arg(args, 0).map(|file| {
            let list: Vec<String> = arg(args, 1)
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default();
            let env: Option<Vec<(String, String)>> = arg(args, 2).and_then(Value::as_object).map(|o| {
                o.iter()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                    .collect()
            });
            let r = run_command(file, &list, env.as_deref());
            Some(json!({"code": r.code, "stdout": r.stdout, "stderr": r.stderr, "missing": r.missing}))
        }),
        "system-certificates.nssDatabaseDirs" => str_arg(args, 0).map(|home| {
            Some(Value::Array(
                nss_database_dirs(home).into_iter().map(Value::String).collect(),
            ))
        }),
        "system-certificates.parseNssKeyList" => str_arg(args, 0).and_then(|text| {
            parse_nss_key_list(text)
                .map(|list| Some(Value::Array(list.into_iter().map(Value::String).collect())))
                .map_err(cert_error)
        }),
        "system-certificates.WINDOWS_LIST_SCRIPT" => Ok(Some(Value::from(WINDOWS_LIST_SCRIPT))),
        "system-certificates.WINDOWS_CHAIN_SCRIPT" => Ok(Some(Value::from(WINDOWS_CHAIN_SCRIPT))),
        "system-certificates.WINDOWS_SIGN_SCRIPT" => Ok(Some(Value::from(WINDOWS_SIGN_SCRIPT))),
        "system-certificates.parseWindowsCertificates" => str_arg(args, 0).map(|text| {
            Some(match parse_windows_certificates(text) {
                Ok(rows) => Value::Array(
                    rows.iter()
                        .map(|r| json!({"thumbprint": r.thumbprint, "der": hex_encode(&r.der)}))
                        .collect(),
                ),
                Err(_) => json!({"syntaxError": true}),
            })
        }),
        "system-certificates.parseWindowsChain" => str_arg(args, 0).map(|text| {
            Some(match parse_windows_chain(text) {
                Ok(rows) => Value::Array(rows.iter().map(|r| Value::String(hex_encode(r))).collect()),
                Err(_) => json!({"syntaxError": true}),
            })
        }),
        "system-certificates.listSystemCertificates" => certificates_list(args, cx),
        "system-certificates.openSystemSigner" => certificates_open(args, cx),
        "wasm-path.pdfiumWasmPath" => wasm_call(args, pdfium_wasm_path),
        "wasm-path.qpdfWasmPath" => wasm_call(args, qpdf_wasm_path),
        "wasm-path.hbSubsetWasmPath" => wasm_call(args, hb_subset_wasm_path),
        _ => return None,
    })
}

fn node_call_error(e: NodeError) -> CallError {
    CallError::from(e)
}

fn read_options(v: Option<&Value>) -> ReadPdfTextOptions {
    let v = v.cloned().unwrap_or(Value::Null);
    ReadPdfTextOptions {
        from_page: v.get("fromPage").and_then(Value::as_f64),
        to_page: v.get("toPage").and_then(Value::as_f64),
        pages: v
            .get("pages")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_f64).collect()),
        char_budget: v.get("charBudget").and_then(Value::as_f64),
        password: v.get("password").and_then(Value::as_str).map(str::to_owned),
    }
}

// ---- signature store ------------------------------------------------------------

fn signatures_arg(args: &[Value], i: usize) -> Vec<SavedSignature> {
    arg(args, i)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|s| SavedSignature {
                    id: s
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    created_at: s.get("createdAt").and_then(Value::as_f64).unwrap_or(0.0),
                    data: s.get("data").map_or(JsonValue::Null, json_value_from_serde),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn signatures_json(list: &[SavedSignature]) -> Value {
    Value::Array(
        list.iter()
            .map(|s| {
                let mut o = Map::new();
                o.insert("id".into(), Value::String(s.id.clone()));
                o.insert("createdAt".into(), num(s.created_at));
                o.insert("data".into(), json_value_to_serde(&s.data));
                Value::Object(o)
            })
            .collect(),
    )
}

// ---- notes --------------------------------------------------------------------------

fn platform_of(name: &str) -> Platform {
    match name {
        "win32" => Platform::Win32,
        "darwin" => Platform::Darwin,
        _ => Platform::Other,
    }
}

/// the `platform` argument; the host's when left out
fn platform_arg(args: &[Value], i: usize) -> Platform {
    match arg(args, i).and_then(Value::as_str) {
        Some(name) => platform_of(name),
        None => host_platform(),
    }
}

fn host_platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::Darwin
    } else if cfg!(windows) {
        Platform::Win32
    } else {
        Platform::Other
    }
}

fn insert_request(v: Option<&Value>) -> NoteInsertRequest {
    let v = v.cloned().unwrap_or(Value::Null);
    let text = |key: &str| v.get(key).and_then(Value::as_str).map(str::to_owned);
    if v.get("kind").and_then(Value::as_str) == Some("overview") {
        NoteInsertRequest::Overview {
            heading: text("heading").unwrap_or_default(),
            body: text("body").unwrap_or_default(),
            title: text("title"),
        }
    } else {
        NoteInsertRequest::Quote {
            excerpt: text("excerpt").unwrap_or_default(),
            page: v.get("page").and_then(Value::as_f64).unwrap_or(f64::NAN),
            body: text("body"),
            title: text("title"),
        }
    }
}

fn request_json(request: &NoteInsertRequest) -> Value {
    let mut o = Map::new();
    match request {
        NoteInsertRequest::Quote {
            excerpt,
            page,
            body,
            title,
        } => {
            o.insert("kind".into(), Value::from("quote"));
            o.insert("excerpt".into(), Value::String(excerpt.clone()));
            o.insert("page".into(), num(*page));
            if let Some(body) = body {
                o.insert("body".into(), Value::String(body.clone()));
            }
            if let Some(title) = title {
                o.insert("title".into(), Value::String(title.clone()));
            }
        }
        NoteInsertRequest::Overview {
            heading,
            body,
            title,
        } => {
            o.insert("kind".into(), Value::from("overview"));
            o.insert("heading".into(), Value::String(heading.clone()));
            o.insert("body".into(), Value::String(body.clone()));
            if let Some(title) = title {
                o.insert("title".into(), Value::String(title.clone()));
            }
        }
    }
    Value::Object(o)
}

fn result_json(result: &NoteResult) -> Value {
    match result {
        NoteResult::Ok => json!({"ok": true}),
        NoteResult::Refused { reason, message } => {
            let mut o = Map::new();
            o.insert("ok".into(), Value::Bool(false));
            o.insert("reason".into(), Value::from(*reason));
            if let Some(message) = message {
                o.insert("message".into(), Value::String(message.clone()));
            }
            Value::Object(o)
        }
    }
}

type Log = Rc<RefCell<Vec<String>>>;

fn quote(text: &str) -> String {
    serde_json::to_string(text).expect("a string prints")
}

struct StoreFake {
    cfg: Value,
    log: Log,
}

impl NoteLinkStore for StoreFake {
    fn read_note_links(&self) -> Result<NoteLinks, Thrown> {
        self.log
            .borrow_mut()
            .push("store.readNoteLinks()".to_owned());
        if let Some(message) = self.cfg.get("readThrows").and_then(Value::as_str) {
            return Err(Thrown(message.to_owned()));
        }
        let mut links = jscompat::JsMap::new();
        for key in self
            .cfg
            .get("links")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            links.set(
                key,
                NoteLink {
                    note_path: String::new(),
                    doc_hash: String::new(),
                },
            );
        }
        Ok(NoteLinks { links })
    }

    fn find_note_link(
        &self,
        pdf_path: &str,
        doc_hash: &str,
    ) -> Result<Option<FoundNoteLink>, Thrown> {
        self.log.borrow_mut().push(format!(
            "store.findNoteLink({},{})",
            quote(pdf_path),
            quote(doc_hash)
        ));
        if let Some(message) = self.cfg.get("findThrows").and_then(Value::as_str) {
            return Err(Thrown(message.to_owned()));
        }
        Ok(self
            .cfg
            .get("found")
            .filter(|f| !f.is_null())
            .map(|f| FoundNoteLink {
                note_path: f
                    .get("notePath")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                matched_by: if f.get("matchedBy").and_then(Value::as_str) == Some("docHash") {
                    MatchedBy::DocHash
                } else {
                    MatchedBy::Path
                },
            }))
    }

    fn set_note_link(&self, pdf_path: &str, link: &NoteLink) -> Result<(), Thrown> {
        self.log.borrow_mut().push(format!(
            "store.setNoteLink({},{},{})",
            quote(pdf_path),
            quote(&link.note_path),
            quote(&link.doc_hash)
        ));
        if let Some(message) = self.cfg.get("setThrows").and_then(Value::as_str) {
            return Err(Thrown(message.to_owned()));
        }
        Ok(())
    }

    fn update_note_link_doc_hash(&self, pdf_path: &str, doc_hash: &str) -> Result<bool, Thrown> {
        self.log.borrow_mut().push(format!(
            "store.updateNoteLinkDocHash({},{})",
            quote(pdf_path),
            quote(doc_hash)
        ));
        if let Some(message) = self.cfg.get("updateThrows").and_then(Value::as_str) {
            return Err(Thrown(message.to_owned()));
        }
        Ok(true)
    }
}

struct HostFake {
    cfg: Value,
    log: Log,
}

impl HostFake {
    fn mode(&self, key: &str) -> Value {
        self.cfg.get(key).cloned().unwrap_or(Value::Bool(true))
    }

    fn answer(&self, mode: &Value) -> Result<bool, Thrown> {
        match mode {
            Value::Bool(b) => Ok(*b),
            Value::Object(o) => Err(Thrown(
                o.get("throws")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            )),
            _ => Ok(true),
        }
    }
}

impl NoteHost for HostFake {
    fn has_open_note(&self) -> bool {
        self.mode("open") != "missing"
    }

    fn has_insert_into_note(&self) -> bool {
        self.mode("insert") != "missing"
    }

    fn open_note(&self, path: &str) -> Result<bool, Thrown> {
        self.log
            .borrow_mut()
            .push(format!("host.openNote({})", quote(path)));
        self.answer(&self.mode("open"))
    }

    fn insert_into_note(&self, path: &str, text: &str) -> Result<bool, Thrown> {
        self.log.borrow_mut().push(format!(
            "host.insertIntoNote({},{})",
            quote(path),
            quote(text)
        ));
        self.answer(&self.mode("insert"))
    }
}

struct NoteDepsFake<'a> {
    cfg: Value,
    log: Log,
    store: StoreFake,
    host: HostFake,
    service: &'a NoteLinkService,
    picks: Cell<usize>,
}

impl NoteLinkDeps for NoteDepsFake<'_> {
    fn store(&self) -> Result<&dyn NoteLinkStore, Thrown> {
        self.log.borrow_mut().push("deps.store()".to_owned());
        if let Some(message) = self.cfg.get("storeThrows").and_then(Value::as_str) {
            return Err(Thrown(message.to_owned()));
        }
        Ok(&self.store)
    }

    fn hash_file(&self, path: &str) -> Result<String, Thrown> {
        self.log
            .borrow_mut()
            .push(format!("deps.hashFile({})", quote(path)));
        if let Some(message) = self.cfg.get("hashThrows").and_then(Value::as_str) {
            return Err(Thrown(message.to_owned()));
        }
        Ok(self
            .cfg
            .get("hash")
            .and_then(Value::as_str)
            .unwrap_or("h0")
            .to_owned())
    }

    fn is_untitled(&self, pdf_path: &str) -> Result<bool, Thrown> {
        self.log
            .borrow_mut()
            .push(format!("deps.isUntitled({})", quote(pdf_path)));
        if let Some(message) = self.cfg.get("untitledThrows").and_then(Value::as_str) {
            return Err(Thrown(message.to_owned()));
        }
        Ok(self
            .cfg
            .get("untitled")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|v| v.as_str() == Some(pdf_path))))
    }

    fn pick_note_path(&self, owner: f64, default_path: &str) -> Result<Option<String>, Thrown> {
        self.log.borrow_mut().push(format!(
            "deps.pickNotePath({},{})",
            jscompat::number_to_string(owner),
            quote(default_path)
        ));
        if let Some(message) = self.cfg.get("pickThrows").and_then(Value::as_str) {
            return Err(Thrown(message.to_owned()));
        }
        if let Some(again) = self.cfg.get("pickReenter").filter(|v| !v.is_null()) {
            // a second request of the same view while the dialog is open
            let pdf = again.get("pdfPath").and_then(Value::as_str);
            let result = self.service.open(
                self,
                again.get("owner").and_then(Value::as_f64).unwrap_or(owner),
                pdf,
                &parse_note_open_request(None),
            );
            let shown = match result {
                Ok(result) => result_json(&result).to_string(),
                Err(Thrown(message)) => format!("threw {message}"),
            };
            self.log
                .borrow_mut()
                .push(format!("reentrant open: {shown}"));
        }
        let at = self.picks.get();
        self.picks.set(at + 1);
        let answer = self
            .cfg
            .get("pick")
            .and_then(Value::as_array)
            .and_then(|a| a.get(at))
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok(answer)
    }

    fn note_word(&self) -> Result<String, Thrown> {
        self.log.borrow_mut().push("deps.noteWord()".to_owned());
        if let Some(message) = self.cfg.get("noteWordThrows").and_then(Value::as_str) {
            return Err(Thrown(message.to_owned()));
        }
        Ok(self
            .cfg
            .get("noteWord")
            .and_then(Value::as_str)
            .unwrap_or("Note")
            .to_owned())
    }

    fn host(&self) -> Result<&dyn NoteHost, Thrown> {
        self.log.borrow_mut().push("deps.host()".to_owned());
        if let Some(message) = self.cfg.get("hostThrows").and_then(Value::as_str) {
            return Err(Thrown(message.to_owned()));
        }
        Ok(&self.host)
    }

    fn create_note_file(&self, path: &str, text: &str) -> Option<Result<bool, Thrown>> {
        let mode = self
            .cfg
            .get("createFile")
            .filter(|v| v.as_str() != Some("default"))?;
        self.log.borrow_mut().push(format!(
            "deps.createNoteFile({},{})",
            quote(path),
            quote(text)
        ));
        Some(match mode {
            Value::Bool(b) => Ok(*b),
            Value::Object(o) => Err(Thrown(
                o.get("throws")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            )),
            _ => Ok(true),
        })
    }

    fn file_exists(&self, path: &str) -> Option<Result<bool, Thrown>> {
        let mode = self
            .cfg
            .get("fileExists")
            .filter(|v| v.as_str() != Some("default"))?;
        self.log
            .borrow_mut()
            .push(format!("deps.fileExists({})", quote(path)));
        Some(match mode {
            Value::Bool(b) => Ok(*b),
            Value::Object(o) => Err(Thrown(
                o.get("throws")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
            )),
            _ => Ok(true),
        })
    }
}

fn note_service(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).cloned().unwrap_or(Value::Null);
    let platform = platform_of(
        cfg.get("platform")
            .and_then(Value::as_str)
            .unwrap_or("linux"),
    );
    let service = NoteLinkService::new(platform);
    let log: Log = Rc::new(RefCell::new(Vec::new()));
    let deps = NoteDepsFake {
        cfg: cfg.clone(),
        log: Rc::clone(&log),
        store: StoreFake {
            cfg: cfg.get("store").cloned().unwrap_or(Value::Null),
            log: Rc::clone(&log),
        },
        host: HostFake {
            cfg: cfg.get("host").cloned().unwrap_or(Value::Null),
            log: Rc::clone(&log),
        },
        service: &service,
        picks: Cell::new(0),
    };
    let mut results: Vec<Value> = Vec::new();
    for call in cfg
        .get("calls")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let op = call.get("op").and_then(Value::as_str).unwrap_or_default();
        let owner = call.get("owner").and_then(Value::as_f64).unwrap_or(1.0);
        let pdf = call.get("pdfPath").and_then(Value::as_str);
        let shown = match op {
            "open" => {
                let request = parse_note_open_request(
                    call.get("request").map(json_value_from_serde).as_ref(),
                );
                service
                    .open(&deps, owner, pdf, &request)
                    .map(|r| result_json(&r))
            }
            "insert" => {
                let request = insert_request(call.get("request"));
                service
                    .insert(&deps, owner, pdf, &request)
                    .map(|r| result_json(&r))
            }
            _ => {
                let mut warnings: Vec<String> = Vec::new();
                service.after_save(&deps, pdf.unwrap_or_default(), &mut |label, thrown| {
                    warnings.push(format!("warn {label} {}", thrown.0));
                });
                log.borrow_mut().extend(warnings);
                Ok(Value::Null)
            }
        };
        results.push(match shown {
            Ok(v) => v,
            Err(Thrown(message)) => json!({"threw": message}),
        });
    }
    for line in log.borrow().iter() {
        cx.logs.push(vec![Value::String(line.clone())]);
    }
    Ok(Some(Value::Array(results)))
}

// ---- ocr -------------------------------------------------------------------------------

fn ocr_call(args: &[Value]) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let env = OcrEnv {
        platform: host_platform(),
        here: spec
            .get("here")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        resources_path: spec
            .get("resources")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    let png = spec.get("png").and_then(Value::as_str).unwrap_or_default();
    let mut bridge = OcrBridge::new();
    match bridge.ocr_page_png(&env, png) {
        Ok(Some(lines)) => Ok(Some(Value::Array(
            lines.iter().map(json_value_to_serde).collect(),
        ))),
        Ok(None) => Ok(Some(Value::Null)),
        Err(e) => Err(CallError::plain(e.0)),
    }
}

// ---- wasm paths ------------------------------------------------------------------------

/// `require.resolve` of `<dir>/node_modules`, as far as the cases need it:
/// a package folder with a `package.json`, its `exports` (a string, or an
/// object with `"."` or the listed subpaths) and its `main`
fn resolve_in(dir: &str, specifier: &str) -> Option<String> {
    let parts: Vec<&str> = specifier.split('/').collect();
    let (pkg, sub) = if specifier.starts_with('@') {
        (parts.get(..2)?.join("/"), parts[2..].join("/"))
    } else {
        (parts[0].to_owned(), parts[1..].join("/"))
    };
    let root = format!("{dir}/node_modules/{pkg}");
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{root}/package.json")).ok()?)
            .ok()?;
    let exists = |p: &str| std::fs::metadata(p).is_ok();
    let norm = |p: &str| jscompat::node_path::host::join(&[&root, p]);
    let exports = manifest.get("exports");
    if sub.is_empty() {
        let entry = match exports {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Object(o)) => match o.get(".") {
                Some(Value::String(s)) => Some(s.clone()),
                Some(Value::Object(inner)) => inner
                    .get("default")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                _ => None,
            },
            _ => manifest
                .get("main")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| Some("index.js".to_owned())),
        }?;
        let path = norm(&entry);
        return exists(&path).then_some(path);
    }
    if let Some(exports) = exports {
        // exports seal the subpaths: only a listed one resolves
        let target = exports.get(format!("./{sub}"))?.as_str()?;
        let path = norm(target);
        return exists(&path).then_some(path);
    }
    let path = norm(&sub);
    exists(&path).then_some(path)
}

fn wasm_call(args: &[Value], f: impl FnOnce(&WasmEnv<'_>) -> Result<String, NodeError>) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let dir = spec
        .get("dir")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let resources = spec
        .get("resources")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let resolve = |specifier: &str| resolve_in(&dir, specifier);
    let exists = |path: &str| std::fs::metadata(path).is_ok();
    let env = WasmEnv {
        resolve: &resolve,
        exists: &exists,
        resources_path: resources.as_deref(),
    };
    f(&env)
        .map(|path| Some(Value::String(path)))
        .map_err(CallError::from)
}

// ---- system certificates -----------------------------------------------------------------

fn cert_error(e: CertThrown) -> CallError {
    match e {
        CertThrown::Store(e) => CallError {
            code: Some(e.code.clone()),
            message: e.code,
        },
        CertThrown::Node(e) => masked_scratch(CallError::from(e)),
        CertThrown::JsonSyntax => CallError::plain("SyntaxError"),
        CertThrown::RegexLimit => CallError::plain("RangeError"),
    }
}

fn scratch_re() -> &'static JsRegex {
    js_regex!(r"\S*seuoffice-cert-[A-Za-z0-9]{6}", "g")
}

fn mask_scratch(text: &str) -> String {
    scratch_re().replace_all(text, |_| "<scratch>".to_owned())
}

fn masked_scratch(e: CallError) -> CallError {
    CallError {
        code: e.code,
        message: mask_scratch(&e.message),
    }
}

/// `CertificateReader` over the certificates of the case: the summary the
/// TypeScript reads from the same certificate is written beside it
struct TableReader {
    table: Vec<(Vec<u8>, CertSummary)>,
}

fn der_of(input: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(input);
    if text.trim_start().starts_with("-----BEGIN") {
        let body: String = text
            .lines()
            .filter(|l| !l.starts_with("-----"))
            .collect::<Vec<_>>()
            .join("");
        jscompat::buffer_from_base64(&body)
    } else {
        input.to_vec()
    }
}

impl CertificateReader for TableReader {
    fn read(&self, input: &[u8]) -> Option<CertSummary> {
        let der = der_of(input);
        self.table
            .iter()
            .find(|(d, _)| *d == der)
            .map(|(_, s)| s.clone())
    }
}

fn reader_of(cfg: &Value) -> TableReader {
    let table = cfg
        .get("certs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|c| {
            let summary = c.get("summary").cloned().unwrap_or(Value::Null);
            (
                der_of(
                    c.get("pem")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .as_bytes(),
                ),
                CertSummary {
                    common_name: summary
                        .get("commonName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    issuer_common_name: summary
                        .get("issuerCommonName")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    valid_to: summary
                        .get("validTo")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned(),
                    is_rsa: summary
                        .get("isRsa")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                },
            )
        })
        .collect();
    TableReader { table }
}

/// The scripted runner: a rule is `{ file, args, env?, code, stdout, stderr,
/// missing?, writeOut? }`, matched on the file and the arguments with the
/// scratch folder written `<scratch>`.
struct Runner {
    cfg: Value,
    log: RefCell<Vec<String>>,
    export_pw: RefCell<Option<String>>,
}

impl Runner {
    fn run(&self, file: &str, args: &[String], env: Option<&[(String, String)]>) -> RunResult {
        let masked: Vec<String> = args.iter().map(|a| mask_scratch(a)).collect();
        let env_json = match env {
            Some(pairs) => {
                let mut o = Map::new();
                for (k, v) in pairs {
                    o.insert(k.clone(), Value::String(v.clone()));
                }
                Value::Object(o)
            }
            None => Value::Null,
        };
        self.log.borrow_mut().push(format!(
            "run {file} {} {}",
            serde_json::to_string(&masked).expect("args print"),
            jscompat_print(&env_json)
        ));
        // the files named by the options: each is logged as the tool would read it
        for (i, a) in args.iter().enumerate() {
            if matches!(a.as_str(), "-f" | "-w" | "-k")
                && let Some(path) = args.get(i + 1)
            {
                let content = std::fs::read_to_string(path).unwrap_or_default();
                let shown = if a == "-w" {
                    *self.export_pw.borrow_mut() = Some(content.trim_end().to_owned());
                    let ok = js_regex!(r"^[A-Za-z0-9_-]{24}\n$").test(&content);
                    format!("export-pw {ok}")
                } else {
                    serde_json::to_string(&content).expect("a string prints")
                };
                self.log.borrow_mut().push(format!("file {a} {shown}"));
            }
        }
        let rule = self
            .cfg
            .get("rules")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|r| {
                r.get("file").and_then(Value::as_str) == Some(file)
                    && r.get("args").and_then(Value::as_array).is_some_and(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .eq(masked.iter().map(String::as_str))
                    })
            });
        let Some(rule) = rule else {
            self.log.borrow_mut().push("no rule".to_owned());
            return RunResult {
                code: 127,
                stdout: String::new(),
                stderr: "no rule".to_owned(),
                missing: false,
            };
        };
        if let Some(hex) = rule.get("writeOut").and_then(Value::as_str)
            && let Some(at) = args.iter().position(|a| a == "-o")
            && let Some(path) = args.get(at + 1)
        {
            let _ = std::fs::write(path, hex_decode(hex));
        }
        RunResult {
            code: rule.get("code").and_then(Value::as_i64).unwrap_or(0) as i32,
            stdout: rule
                .get("stdout")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            stderr: rule
                .get("stderr")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            missing: rule
                .get("missing")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }
}

fn jscompat_print(v: &Value) -> String {
    json_value_stringify(v)
}

fn json_value_stringify(v: &Value) -> String {
    jscompat::json_stringify(&json_value_from_serde(v))
}

fn listing_json(listing: &SystemCertificateListing) -> Value {
    let certs: Vec<Value> = listing.certs.iter().map(cert_json).collect();
    let issues: Vec<Value> = listing
        .issues
        .iter()
        .map(|i| Value::from(i.as_str()))
        .collect();
    json!({"certs": certs, "issues": issues})
}

fn cert_json(c: &SystemCertificate) -> Value {
    let reference = match &c.reference {
        SystemCertificateRef::Nss { dir, nickname } => {
            json!({"source": "nss", "dir": dir, "nickname": nickname})
        }
        SystemCertificateRef::Windows { thumbprint } => {
            json!({"source": "windows", "thumbprint": thumbprint})
        }
    };
    json!({
        "ref": reference,
        "label": c.label,
        "commonName": c.common_name,
        "issuerCommonName": c.issuer_common_name,
        "validTo": c.valid_to,
        "expired": c.expired,
    })
}

fn certificates_list(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).cloned().unwrap_or(Value::Null);
    let platform = platform_of(
        cfg.get("platform")
            .and_then(Value::as_str)
            .unwrap_or("linux"),
    );
    let home = cfg
        .get("home")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let store_password = cfg
        .get("storePassword")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let now = cfg.get("now").and_then(Value::as_f64).unwrap_or(cx.now_ms);
    let runner = Runner {
        cfg: cfg.clone(),
        log: RefCell::new(Vec::new()),
        export_pw: RefCell::new(None),
    };
    let reader = reader_of(&cfg);
    let run =
        |file: &str, args: &[String], env: Option<&[(String, String)]>| runner.run(file, args, env);
    let clock = move || now;
    let env = SystemStoreEnv {
        platform,
        home: &home,
        run: &run,
        now: &clock,
        certificates: &reader,
    };
    let answer = list_system_certificates(store_password.as_deref(), &env);
    for line in runner.log.borrow().iter() {
        cx.logs.push(vec![Value::String(line.clone())]);
    }
    answer
        .map(|listing| Some(listing_json(&listing)))
        .map_err(cert_error)
}

fn certificates_open(args: &[Value], cx: &mut Context) -> Answer {
    let cfg = arg(args, 0).cloned().unwrap_or(Value::Null);
    let platform = platform_of(
        cfg.get("platform")
            .and_then(Value::as_str)
            .unwrap_or("linux"),
    );
    let home = cfg
        .get("home")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let store_password = cfg
        .get("storePassword")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let now = cfg.get("now").and_then(Value::as_f64).unwrap_or(cx.now_ms);
    let reference = {
        let r = cfg.get("ref").cloned().unwrap_or(Value::Null);
        let text = |k: &str| {
            r.get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        if r.get("source").and_then(Value::as_str) == Some("windows") {
            SystemCertificateRef::Windows {
                thumbprint: text("thumbprint"),
            }
        } else {
            SystemCertificateRef::Nss {
                dir: text("dir"),
                nickname: text("nickname"),
            }
        }
    };
    let runner = Runner {
        cfg: cfg.clone(),
        log: RefCell::new(Vec::new()),
        export_pw: RefCell::new(None),
    };
    let reader = reader_of(&cfg);
    let run =
        |file: &str, args: &[String], env: Option<&[(String, String)]>| runner.run(file, args, env);
    let clock = move || now;
    let env = SystemStoreEnv {
        platform,
        home: &home,
        run: &run,
        now: &clock,
        certificates: &reader,
    };
    let answer = open_system_signer(&reference, store_password.as_deref(), &env);
    let shown = match answer {
        Ok(SystemIdentity::P12(exported)) => {
            let ok = js_regex!(r"^[A-Za-z0-9_-]{24}$").test(&exported.password)
                && runner.export_pw.borrow().as_deref() == Some(exported.password.as_str());
            Ok(json!({"kind": "p12", "p12": hex_encode(&exported.p12), "passwordOk": ok}))
        }
        Ok(SystemIdentity::InPlace(signer)) => {
            let mut out = Map::new();
            out.insert("kind".into(), Value::from("in-place"));
            out.insert(
                "chainDer".into(),
                Value::Array(
                    signer
                        .chain_der
                        .iter()
                        .map(|d| Value::String(hex_encode(d)))
                        .collect(),
                ),
            );
            if let Some(digest) = cfg.get("digest").and_then(Value::as_str) {
                match signer.sign_digest(&env, &hex_decode(digest)) {
                    Ok(signature) => {
                        out.insert("signature".into(), Value::String(hex_encode(&signature)));
                    }
                    Err(e) => {
                        out.insert("signError".into(), Value::String(e.code));
                    }
                }
            }
            Ok(Value::Object(out))
        }
        Err(e) => Err(cert_error(e)),
    };
    for line in runner.log.borrow().iter() {
        cx.logs.push(vec![Value::String(line.clone())]);
    }
    shown.map(Some)
}
