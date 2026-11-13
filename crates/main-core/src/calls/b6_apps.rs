//! The functions of group `b6-apps` (tools/main-diff/groups/b6-apps.ts): the
//! modules of the editor apps that call Electron (batch B6 of decision 0030).
//! What they call is a fake the spec describes; each call of a fake is one
//! `logs` line, and the TypeScript writes the same lines. A scenario plays
//! the part of the Electron adapter: it carries out what the Rust decides on
//! the same fakes.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use jscompat::{
    JsMap, JsonValue, js_regex, json_value_from_serde, json_value_to_serde, number_to_string,
    text_decoder_decode,
};
use serde_json::{Map, Value, json};

use super::fakes::FakeWindow;
use super::{Answer, CallError, Context, arg, str_arg};
use crate::diagram::diagram_session::{
    DiagramReply, DiagramSession, DiagramSessionPaths, SessionHost, permission_granted,
    serve_drawio, serve_renderer,
};
use crate::diagram::print_document::PrintDocuments;
use crate::docs::byte_handoff::ByteHandoffs;
use crate::docs::lazy_media::{
    LazyMedia, ZipEntry, ZipFile, ZipLibrary, ZipRead, ZipSourceOf, register_lazy_media_protocol,
};
use crate::docs::lazy_media_inline::LAZY_MEDIA_SCHEME;
use crate::docs::updater::{AutoUpdater, DocsUpdater, Thrown};
use crate::html::preview_document::PREVIEW_SCHEME;
use crate::html::preview_protocol::{
    PREVIEW_DOCUMENT_HEADERS, PreviewAnswer, PreviewEntry, preview_answer, privileged_schemes,
};
use crate::markdown::print_document::{
    MarkdownPageRange, MarkdownPrintOptions, MarkdownPrintWindow, print_markdown_document,
};
use crate::markdown::print_pdf::print_markdown_pdf;
use crate::packages::electron_utils::message_box::{MessageBox, MessageBoxOptions, ParentWindow};
use crate::packages::electron_utils::print_html_pdf::PrintWindow;
use crate::packages::electron_utils::print_window::{JsError, PrintReport};
use crate::packages::i18n::Lang;
use crate::pdf::image_edit::{
    EditKind, ImageEditInput, ImageObj, ImagePdf, PageObj, apply_image_edits, decode_image,
    image_geometry_transforms, image_matrix, list_page_images, match_image, verify_image_edits,
};
use crate::sheets::template_fonts::{
    install_standalone_template_font_protocol, sheets_template_fonts_dir, template_font_face_css,
    with_template_font_faces,
};
use crate::slides::element_clipboard::{
    ClipboardHost, ELEMENT_CLIPBOARD_FORMAT, ElementClipboardIdentity, HostThrew,
    can_write_element_clipboard_image, element_clipboard_marker_matches,
    is_element_clipboard_token, write_element_clipboard_image,
};
use crate::slides::font_store::{font_store_dir, init_font_store, install_local_font_files};
use crate::slides::session_state::{
    Deck, DeckBroadcast, EngineThrew, FontMetrics, MediaRegistry, OpRecord, OpSource, PartPath,
    Scheduled, Session, SessionIds, SlideArchive, SlideChain, SlideRef, SlideUpdate, ThemeEngine,
    WcSessions, dialog_parent, host_window_for, plan_slide_update,
};

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

static NULL: Value = Value::Null;

fn new_log() -> Log {
    Rc::new(RefCell::new(Vec::new()))
}

/// one `logs` line of the items, each as `JSON.stringify` writes it
macro_rules! logl {
    ($log:expr; $($item:expr),+ $(,)?) => {
        $log.borrow_mut().push(vec![$(serde_json::json!($item)),+])
    };
}

fn finish(cx: &mut Context, log: &Log) {
    cx.logs.extend(log.take());
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| text.get(i * 2..i * 2 + 2))
        .filter_map(|pair| u8::from_str_radix(pair, 16).ok())
        .collect()
}

fn text<'a>(spec: &'a Value, key: &str) -> &'a str {
    spec.get(key).and_then(Value::as_str).unwrap_or("")
}

fn flag(spec: &Value, key: &str) -> bool {
    matches!(spec.get(key), Some(Value::Bool(true)))
}

fn num(spec: &Value, key: &str) -> Option<f64> {
    spec.get(key).and_then(Value::as_f64)
}

fn number(x: f64) -> Value {
    serde_json::Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

fn strings(spec: Option<&Value>) -> Vec<String> {
    spec.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn error_of(error: JsError) -> CallError {
    CallError {
        code: error.code,
        message: mask_rand(&error.message),
    }
}

/// `os.tmpdir()` on a POSIX host
fn os_tmpdir() -> String {
    let dir = ["TMPDIR", "TMP", "TEMP"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|v| !v.is_empty()))
        .unwrap_or_else(|| "/tmp".to_owned());
    if dir.len() > 1 && dir.ends_with('/') {
        dir[..dir.len() - 1].to_owned()
    } else {
        dir
    }
}

/// `/<prefix><6 random characters>` written `/<prefix><rand>`: the random
/// part differs on each side
fn mask_rand(text: &str) -> String {
    js_regex!(r"/(seuoffice-md-print-)[A-Za-z0-9]{6}", "g")
        .replace_all(text, |m| format!("/{}<rand>", m.get(1).unwrap_or("")))
}

/// the name of the folder `path` sits in, its 6 random characters cut off
fn masked_dir_name(path: &str) -> String {
    let (dir, _) = path.rsplit_once('/').unwrap_or(("", path));
    let name = dir.rsplit_once('/').map_or(dir, |(_, last)| last);
    name[..name.len().saturating_sub(6)].to_owned()
}

/// a `Response` as the specs write it: `{ status, headers, body }`, the
/// headers as `Headers` lists them (names in lower case, sorted)
fn response_value(status: u16, headers: &[(String, String)], body: Value) -> Value {
    let mut sorted: Vec<(String, String)> = headers
        .iter()
        .map(|(name, value)| (name.to_lowercase(), value.clone()))
        .collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut list = Map::new();
    for (name, value) in sorted {
        list.insert(name, Value::from(value));
    }
    let mut out = Map::new();
    out.insert("status".into(), Value::from(status));
    out.insert("headers".into(), Value::Object(list));
    out.insert("body".into(), body);
    Value::Object(out)
}

/// what `await response.text()` answers for these bytes
fn decoded(bytes: &[u8]) -> Value {
    Value::from(text_decoder_decode(bytes).into_owned())
}

/// `message` of a step that threw, as the specs write it
fn threw(message: &str) -> Value {
    json!({ "threw": message })
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- slides/element-clipboard ----
        "element-clipboard.ELEMENT_CLIPBOARD_FORMAT" => {
            Ok(Some(Value::from(ELEMENT_CLIPBOARD_FORMAT)))
        }
        "element-clipboard.isElementClipboardToken" => Ok(Some(Value::Bool(
            is_element_clipboard_token(arg(args, 0).map(json_value_from_serde).as_ref()),
        ))),
        "element-clipboard.elementClipboardMarkerMatches" => (|| {
            let token = str_arg(args, 0)?;
            let log = new_log();
            let host = ClipFake::new(arg(args, 1).unwrap_or(&NULL), &log);
            let answer = element_clipboard_marker_matches(&host, token);
            finish(cx, &log);
            Ok(Some(Value::Bool(answer)))
        })(),
        "element-clipboard.canWriteElementClipboardImage" => {
            let current =
                arg(args, 0)
                    .filter(|v| v.is_object())
                    .map(|o| ElementClipboardIdentity {
                        token: text(o, "token").to_owned(),
                        sender_id: num(o, "senderId").unwrap_or(f64::NAN),
                    });
            let sender_id = arg(args, 1).and_then(Value::as_f64).unwrap_or(f64::NAN);
            let token = arg(args, 2).map(json_value_from_serde);
            let log = new_log();
            let host = ClipFake::new(arg(args, 3).unwrap_or(&NULL), &log);
            let answer = can_write_element_clipboard_image(
                &host,
                current.as_ref(),
                sender_id,
                token.as_ref(),
            );
            finish(cx, &log);
            Ok(Some(Value::Bool(answer)))
        }
        "element-clipboard.writeElementClipboardImage" => (|| {
            let token = str_arg(args, 0)?;
            let png = arg(args, 1).map(json_value_from_serde);
            let log = new_log();
            let mut host = ClipFake::new(arg(args, 2).unwrap_or(&NULL), &log);
            let answer = write_element_clipboard_image(&mut host, token, png.as_ref());
            finish(cx, &log);
            Ok(Some(Value::Bool(answer)))
        })(),

        // ---- slides/font-store ----
        "slides/font-store.fontStoreDir" => (|| {
            let log = new_log();
            let user_data = str_arg(args, 0)?.to_owned();
            let dir = font_store_dir(&mut || {
                logl!(log; "getPath", "userData");
                user_data.clone()
            });
            finish(cx, &log);
            Ok(Some(Value::from(dir)))
        })(),
        "slides/font-store.initFontStore" => (|| {
            let log = new_log();
            let user_data = str_arg(args, 0)?.to_owned();
            init_font_store(
                &mut || {
                    logl!(log; "getPath", "userData");
                    user_data.clone()
                },
                &mut |dir| logl!(log; "setUserFontDir", dir),
            );
            finish(cx, &log);
            Ok(None)
        })(),
        "slides/font-store.installLocalFontFiles" => (|| {
            let log = new_log();
            let user_data = str_arg(args, 0)?.to_owned();
            let mut table: Vec<(String, Vec<String>)> = Vec::new();
            for entry in arg(args, 1).and_then(Value::as_array).into_iter().flatten() {
                table.push((
                    entry
                        .get(0)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    strings(entry.get(1)),
                ));
            }
            let paths = strings(arg(args, 2));
            let reader = |path: &str| -> Vec<String> {
                logl!(log; "fontFileFamilies", path);
                table
                    .iter()
                    .find(|(p, _)| p == path)
                    .map(|(_, families)| families.clone())
                    .unwrap_or_default()
            };
            let result = install_local_font_files(
                &mut || {
                    logl!(log; "getPath", "userData");
                    user_data.clone()
                },
                &reader,
                &paths,
            );
            finish(cx, &log);
            result
                .map(|installed| Some(json!(installed)))
                .map_err(CallError::from)
        })(),

        // ---- sheets/template-fonts ----
        "sheets/template-fonts.sheetsTemplateFontsDir" => {
            let spec = arg(args, 0).unwrap_or(&NULL);
            let log = new_log();
            let dir = sheets_template_fonts_dir(
                flag(spec, "packaged"),
                &|| {
                    logl!(log; "getAppPath");
                    text(spec, "appPath").to_owned()
                },
                text(spec, "resourcesPath"),
            );
            finish(cx, &log);
            Ok(Some(Value::from(dir)))
        }
        "sheets/template-fonts.installStandaloneTemplateFontProtocol" => {
            let spec = arg(args, 0).unwrap_or(&NULL);
            let log = new_log();
            let dir = sheets_template_fonts_dir(
                flag(spec, "packaged"),
                &|| {
                    logl!(log; "getAppPath");
                    text(spec, "appPath").to_owned()
                },
                text(spec, "resourcesPath"),
            );
            let protocol = install_standalone_template_font_protocol(dir);
            logl!(log; "handle", protocol.scheme);
            let mut answers = Vec::new();
            for url in strings(spec.get("requests")) {
                let response =
                    protocol.answer(&url, &mut |path| std::fs::read(path).map_err(|_| ()));
                answers.push(response_value(
                    response.status,
                    &response.headers,
                    Value::from(hex(&response.body)),
                ));
            }
            finish(cx, &log);
            Ok(Some(Value::Array(answers)))
        }
        "sheets/template-fonts.templateFontFaceCss" => {
            str_arg(args, 0).map(|dir| Some(Value::from(template_font_face_css(dir))))
        }
        "sheets/template-fonts.withTemplateFontFaces" => (|| {
            let html = str_arg(args, 0)?;
            let dir = str_arg(args, 1)?;
            Ok(Some(Value::from(with_template_font_faces(html, dir))))
        })(),

        // ---- html/preview-protocol ----
        "preview-protocol.registerPrivilegedSchemes" => {
            let log = new_log();
            let extra: Vec<Value> = arg(args, 0)
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            logl!(log; "registerSchemesAsPrivileged", to_value(&privileged_schemes(&extra)));
            finish(cx, &log);
            Ok(None)
        }
        "preview-protocol.registerPreviewProtocol" => {
            let spec = arg(args, 0).unwrap_or(&NULL);
            let log = new_log();
            logl!(log; "handle", PREVIEW_SCHEME);
            let mut answers = Vec::new();
            for url in strings(spec.get("urls")) {
                let answer = preview_answer(&url, &mut |id| {
                    logl!(log; "resolve", number(id));
                    spec.get("entries")
                        .and_then(|entries| entries.get(number_to_string(id)))
                        .filter(|entry| entry.is_object())
                        .map(|entry| PreviewEntry {
                            text: text(entry, "text").to_owned(),
                            base_href: entry
                                .get("baseHref")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                        })
                });
                answers.push(match answer {
                    PreviewAnswer::Status(status) => response_value(status, &[], Value::Null),
                    PreviewAnswer::Document { body } => {
                        let headers: Vec<(String, String)> = PREVIEW_DOCUMENT_HEADERS
                            .iter()
                            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                            .collect();
                        response_value(200, &headers, decoded(body.as_bytes()))
                    }
                });
            }
            finish(cx, &log);
            Ok(Some(Value::Array(answers)))
        }

        // ---- markdown print-document / print-pdf ----
        "markdown/print-document.printMarkdownDocument" => print_document_call(args, cx),
        "markdown/print-pdf.printMarkdownPdf" => print_pdf_call(args, cx),

        // ---- docs/updater ----
        "docs/updater.initDocsAutoUpdater" => updater_call(args, cx),

        // ---- diagram-session ----
        "diagram-session.scenario" => diagram_session_call(args, cx),

        // ---- docs/lazy-media ----
        "docs/lazy-media.scenario" => lazy_media_call(args, cx),

        // ---- pdf/image-edit ----
        "image-edit.matchImage" => match_image_call(args),
        "image-edit.imageMatrix" => {
            let rect = rect_of(arg(args, 0));
            let rotate = arg(args, 1).and_then(Value::as_f64).unwrap_or(f64::NAN);
            Ok(Some(Value::Array(
                image_matrix(&rect, rotate)
                    .iter()
                    .map(|x| number(*x))
                    .collect(),
            )))
        }
        "image-edit.applyImageGeometry" => {
            let bounds = rect_of(arg(args, 0));
            let rect = rect_of(arg(args, 1));
            let turns = arg(args, 2).and_then(Value::as_f64);
            let log = new_log();
            let result = image_geometry_transforms(&bounds, &rect, turns);
            let answer = match result {
                Ok(list) => {
                    for m in list {
                        let mut line = vec![json!("transform"), json!(7)];
                        line.extend(m.iter().map(|x| number(*x)));
                        log.borrow_mut().push(line);
                    }
                    Ok(None)
                }
                Err(message) => Err(CallError::plain(message)),
            };
            finish(cx, &log);
            answer
        }
        "image-edit.decodeImage" => {
            let spec = arg(args, 0).unwrap_or(&NULL);
            let log = new_log();
            logl!(log; "createFromBuffer", text(spec, "b64"));
            logl!(log; "isEmpty");
            let result = if flag(spec, "empty") {
                decode_image(true, (0.0, 0.0), Vec::new())
            } else {
                logl!(log; "getSize");
                logl!(log; "toBitmap");
                decode_image(
                    false,
                    (
                        num(spec, "width").unwrap_or(0.0),
                        num(spec, "height").unwrap_or(0.0),
                    ),
                    unhex(text(spec, "bitmap")),
                )
            };
            finish(cx, &log);
            result
                .map(|image| {
                    Some(json!({
                        "width": number(image.width),
                        "height": number(image.height),
                        "bgra": hex(&image.bgra),
                    }))
                })
                .map_err(CallError::plain)
        }
        "image-edit.applyImageEdits"
        | "image-edit.listPageImages"
        | "image-edit.verifyImageEdits" => image_edits_call(name, args, cx),

        // ---- slides/session-state ----
        "slides/session-state.scenario" => session_state_call(args, cx),
        _ => return None,
    })
}

// ---- element-clipboard ----

/// `{ buffer?, bufferThrows?, html?, htmlThrows?, createThrows?, empty?,
/// emptyThrows?, png?, pngThrows?, writeThrows? }`: the clipboard and the
/// image `nativeImage` makes. Each call is a log line:
/// `["readBuffer", format]`, `["readHTML"]`, `["createFromBuffer", hex]`,
/// `["isEmpty"]`, `["toPNG"]`, `["write", { image, html }]`.
struct ClipFake<'a> {
    spec: &'a Value,
    log: &'a Log,
}

impl<'a> ClipFake<'a> {
    fn new(spec: &'a Value, log: &'a Log) -> Self {
        ClipFake { spec, log }
    }
}

impl ClipboardHost for ClipFake<'_> {
    type Image = ();

    fn read_buffer(&self, format: &str) -> Result<Vec<u8>, HostThrew> {
        logl!(self.log; "readBuffer", format);
        if flag(self.spec, "bufferThrows") {
            return Err(HostThrew);
        }
        Ok(unhex(text(self.spec, "buffer")))
    }

    fn read_html(&self) -> Result<String, HostThrew> {
        logl!(self.log; "readHTML");
        if flag(self.spec, "htmlThrows") {
            return Err(HostThrew);
        }
        Ok(text(self.spec, "html").to_owned())
    }

    fn create_image_from_buffer(&self, bytes: &[u8]) -> Result<(), HostThrew> {
        logl!(self.log; "createFromBuffer", hex(bytes));
        if flag(self.spec, "createThrows") {
            return Err(HostThrew);
        }
        Ok(())
    }

    fn image_is_empty(&self, _image: &()) -> Result<bool, HostThrew> {
        logl!(self.log; "isEmpty");
        if flag(self.spec, "emptyThrows") {
            return Err(HostThrew);
        }
        Ok(flag(self.spec, "empty"))
    }

    fn image_to_png(&self, _image: &()) -> Result<Vec<u8>, HostThrew> {
        logl!(self.log; "toPNG");
        if flag(self.spec, "pngThrows") {
            return Err(HostThrew);
        }
        Ok(unhex(text(self.spec, "png")))
    }

    fn write_image_and_html(&mut self, _image: &(), html: &str) -> Result<(), HostThrew> {
        logl!(self.log; "write", json!({ "image": "img", "html": html }));
        if flag(self.spec, "writeThrows") {
            return Err(HostThrew);
        }
        Ok(())
    }
}

// ---- markdown print ----

/// A window script: `{ createWindow?: "throws", loadFile?: "throws",
/// showThrows?, focusThrows?, print?: "throws" | { success, reason? },
/// printToPDF?: "throws", pdfHex?, destroyThrows? }`. Each call is a log line.
struct MdWindow<'a> {
    script: &'a Value,
    log: &'a Log,
    work_dir: &'a RefCell<Option<String>>,
}

impl MdWindow<'_> {
    fn mode(&self, key: &str) -> Option<&str> {
        self.script.get(key).and_then(Value::as_str)
    }

    fn load(&mut self, path: &str) -> Result<(), JsError> {
        let (dir, base) = path.rsplit_once('/').unwrap_or(("", path));
        let body = std::fs::read_to_string(path).unwrap_or_default();
        logl!(self.log; "loadFile", masked_dir_name(path), base, body);
        *self.work_dir.borrow_mut() = Some(dir.to_owned());
        if self.mode("loadFile") == Some("throws") {
            return Err(JsError::plain("load failed"));
        }
        Ok(())
    }

    fn destroy_window(&mut self) -> Result<(), JsError> {
        logl!(self.log; "destroy");
        if flag(self.script, "destroyThrows") {
            return Err(JsError::plain("destroy threw"));
        }
        Ok(())
    }
}

impl MarkdownPrintWindow for MdWindow<'_> {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        self.load(path)
    }

    fn show(&mut self) -> Result<(), JsError> {
        logl!(self.log; "show");
        if flag(self.script, "showThrows") {
            return Err(JsError::plain("show threw"));
        }
        Ok(())
    }

    fn focus(&mut self) -> Result<(), JsError> {
        logl!(self.log; "focus");
        if flag(self.script, "focusThrows") {
            return Err(JsError::plain("focus threw"));
        }
        Ok(())
    }

    fn print(&mut self, options: &Value) -> Result<PrintReport, JsError> {
        logl!(self.log; "print", options.clone());
        if self.mode("print") == Some("throws") {
            return Err(JsError::plain("print threw"));
        }
        let report = self.script.get("print");
        Ok(PrintReport {
            success: matches!(
                report.and_then(|r| r.get("success")),
                Some(Value::Bool(true))
            ),
            failure_reason: report
                .and_then(|r| r.get("reason"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        })
    }

    fn destroy(&mut self) -> Result<(), JsError> {
        self.destroy_window()
    }
}

impl PrintWindow for MdWindow<'_> {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        self.load(path)
    }

    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, JsError> {
        logl!(self.log; "printToPDF", options.clone());
        if self.mode("printToPDF") == Some("throws") {
            return Err(JsError::plain("printToPDF threw"));
        }
        Ok(unhex(self.mode("pdfHex").unwrap_or("")))
    }

    fn destroy(&mut self) -> Result<(), JsError> {
        self.destroy_window()
    }
}

/// `MarkdownPrintOptions | null`
fn print_options_of(spec: Option<&Value>) -> MarkdownPrintOptions {
    match spec.filter(|v| v.is_object()) {
        None => MarkdownPrintOptions::default(),
        Some(o) => MarkdownPrintOptions {
            page_size: text(o, "pageSize").to_owned(),
            margin_in: num(o, "marginIn").unwrap_or(f64::NAN),
            landscape: flag(o, "landscape"),
            print_background: flag(o, "printBackground"),
        },
    }
}

/// `[html, pages | null, options | null, platform, script]`
fn print_document_call(args: &[Value], cx: &mut Context) -> Answer {
    let html = str_arg(args, 0)?;
    let pages = arg(args, 1)
        .filter(|v| v.is_object())
        .map(|p| MarkdownPageRange {
            from: num(p, "from").unwrap_or(f64::NAN),
            to: num(p, "to").unwrap_or(f64::NAN),
        });
    let options = print_options_of(arg(args, 2));
    let platform = str_arg(args, 3)?;
    let script = arg(args, 4).unwrap_or(&NULL);
    let log = new_log();
    let work_dir: RefCell<Option<String>> = RefCell::new(None);
    let result = print_markdown_document(
        || {
            logl!(log; "createWindow");
            if script.get("createWindow").and_then(Value::as_str) == Some("throws") {
                return Err(JsError::plain("createWindow threw"));
            }
            Ok(MdWindow {
                script,
                log: &log,
                work_dir: &work_dir,
            })
        },
        html,
        pages.as_ref(),
        &options,
        platform,
        &os_tmpdir(),
    );
    if let Some(dir) = work_dir.borrow().as_deref() {
        let _ = crate::packages::electron_utils::print_window::rm_recursive_force(dir);
    }
    finish(cx, &log);
    result
        .map(|outcome| Some(to_value(&outcome)))
        .map_err(error_of)
}

/// `[html, options | null, script]`: the PDF as hex
fn print_pdf_call(args: &[Value], cx: &mut Context) -> Answer {
    let html = str_arg(args, 0)?;
    let options = print_options_of(arg(args, 1));
    let script = arg(args, 2).unwrap_or(&NULL);
    let log = new_log();
    let work_dir: RefCell<Option<String>> = RefCell::new(None);
    let result = print_markdown_pdf(
        || {
            logl!(log; "createWindow");
            if script.get("createWindow").and_then(Value::as_str) == Some("throws") {
                return Err(JsError::plain("createWindow threw"));
            }
            Ok(MdWindow {
                script,
                log: &log,
                work_dir: &work_dir,
            })
        },
        html,
        &options,
        &os_tmpdir(),
    );
    if let Some(dir) = work_dir.borrow().as_deref() {
        let _ = crate::packages::electron_utils::print_window::rm_recursive_force(dir);
    }
    finish(cx, &log);
    result
        .map(|pdf| Some(Value::from(hex(&pdf))))
        .map_err(error_of)
}

// ---- docs/updater ----

/// A dialog that logs `["over", box]` / `["box", box]` into the scenario's log
/// and answers the spec's `response` (a number, or a list taken one per box,
/// NaN once it runs out).
struct LogDialog {
    log: Log,
    queue: RefCell<VecDeque<f64>>,
    last: f64,
}

impl LogDialog {
    fn of(spec: &Value, log: &Log) -> Self {
        let (queue, last) = match spec.get("response") {
            Some(Value::Array(list)) => (
                list.iter()
                    .map(|v| v.as_f64().unwrap_or(f64::NAN))
                    .collect(),
                f64::NAN,
            ),
            other => (
                VecDeque::new(),
                other.and_then(Value::as_f64).unwrap_or(f64::NAN),
            ),
        };
        LogDialog {
            log: Rc::clone(log),
            queue: RefCell::new(queue),
            last,
        }
    }

    fn answer(&self, overload: &str, options: &MessageBoxOptions) -> f64 {
        logl!(self.log; overload, to_value(options));
        self.queue.borrow_mut().pop_front().unwrap_or(self.last)
    }
}

impl MessageBox<FakeWindow> for LogDialog {
    fn show_message_box_over(&self, _parent: &FakeWindow, options: &MessageBoxOptions) -> f64 {
        self.answer("over", options)
    }

    fn show_message_box(&self, options: &MessageBoxOptions) -> f64 {
        self.answer("box", options)
    }
}

/// `autoUpdater` and the timers: every call is a log line (`["set", name,
/// value]`, `["on", event]`, `["setTimeout", ms]`, `["setInterval", ms]`,
/// `["checkForUpdates"]`, `["quitAndInstall", silent, forceRun]`), and what a
/// registration gave is remembered so an event reaches only a listener that
/// was registered.
struct UpdaterFake<'a> {
    spec: &'a Value,
    log: &'a Log,
    error_listener: bool,
    downloaded_listener: bool,
    first_timer: bool,
    interval_timer: bool,
}

impl AutoUpdater for UpdaterFake<'_> {
    fn set_auto_download(&mut self, on: bool) {
        logl!(self.log; "set", "autoDownload", on);
    }

    fn set_auto_install_on_app_quit(&mut self, on: bool) {
        logl!(self.log; "set", "autoInstallOnAppQuit", on);
    }

    fn set_disable_differential_download(&mut self, on: bool) {
        logl!(self.log; "set", "disableDifferentialDownload", on);
    }

    fn on_error(&mut self) {
        logl!(self.log; "on", "error");
        self.error_listener = true;
    }

    fn on_update_downloaded(&mut self) {
        logl!(self.log; "on", "update-downloaded");
        self.downloaded_listener = true;
    }

    fn quit_and_install(&mut self, is_silent: bool, is_force_run_after: bool) {
        logl!(self.log; "quitAndInstall", is_silent, is_force_run_after);
    }

    fn check_for_updates(&mut self) -> Result<(), Thrown> {
        logl!(self.log; "checkForUpdates");
        match text(self.spec, "check") {
            "rejects" => Err(Thrown::Error("offline".to_owned())),
            "rejectsValue" => Err(Thrown::Value(JsonValue::String("boom".to_owned()))),
            _ => Ok(()),
        }
    }

    fn set_timeout(&mut self, ms: f64) {
        logl!(self.log; "setTimeout", number(ms));
        self.first_timer = true;
    }

    fn set_interval(&mut self, ms: f64) {
        logl!(self.log; "setInterval", number(ms));
        self.interval_timer = true;
    }
}

/// `[{ lang, packaged, platform, window, response, check, steps }]`: a step is
/// `{ init }`, `{ error: { message } | { value } }`, `{ downloaded: version }`
/// or `{ fire: "first" | "interval" }`. The module logs
/// `["log", "[docs-updater]", ...]`, `getWindow` logs `["getWindow"]`.
fn updater_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).unwrap_or(&NULL);
    let log = new_log();
    let lang = if text(spec, "lang") == "ko" {
        Lang::Ko
    } else {
        Lang::En
    };
    let dialog = LogDialog::of(spec, &log);
    let mut updater = UpdaterFake {
        spec,
        log: &log,
        error_listener: false,
        downloaded_listener: false,
        first_timer: false,
        interval_timer: false,
    };
    let mut state = DocsUpdater::new();
    let mut logger = |items: Vec<JsonValue>| {
        let mut line = vec![json!("log")];
        line.extend(items.iter().map(json_value_to_serde));
        log.borrow_mut().push(line);
    };
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if flag(step, "init") {
            state.init(flag(spec, "packaged"), text(spec, "platform"), &mut updater);
        } else if let Some(error) = step.get("error") {
            if updater.error_listener {
                let thrown = match error.get("message").and_then(Value::as_str) {
                    Some(message) => Thrown::Error(message.to_owned()),
                    None => {
                        Thrown::Value(json_value_from_serde(error.get("value").unwrap_or(&NULL)))
                    }
                };
                state.on_error(&thrown, &mut logger);
            }
        } else if let Some(version) = step.get("downloaded").and_then(Value::as_str) {
            if updater.downloaded_listener {
                state.on_update_downloaded(
                    version,
                    lang,
                    &mut || {
                        logl!(log; "getWindow");
                        match text(spec, "window") {
                            "live" => Some(FakeWindow { destroyed: false }),
                            "destroyed" => Some(FakeWindow { destroyed: true }),
                            _ => None,
                        }
                    },
                    &dialog,
                    &mut updater,
                    &mut logger,
                );
            }
        } else if let Some(which) = step.get("fire").and_then(Value::as_str) {
            let armed = if which == "first" {
                updater.first_timer
            } else {
                updater.interval_timer
            };
            if armed {
                DocsUpdater::check(&mut updater, &mut logger);
            }
        }
    }
    finish(cx, &log);
    Ok(None)
}

// ---- diagram-session ----

/// the host of `diagramSession`: each call a log line
struct SessionFake<'a> {
    log: &'a Log,
}

impl SessionHost for SessionFake<'_> {
    fn session_from_partition(&mut self, partition: &str) {
        logl!(self.log; "fromPartition", partition);
    }

    fn handle_protocol(&mut self, scheme: &str) {
        logl!(self.log; "handle", scheme);
    }

    fn on_before_request(&mut self) {
        logl!(self.log; "onBeforeRequest");
    }

    fn set_spell_checker_enabled(&mut self, enabled: bool) {
        logl!(self.log; "setSpellCheckerEnabled", enabled);
    }

    fn set_permission_request_handler(&mut self) {
        logl!(self.log; "setPermissionRequestHandler");
    }

    fn set_permission_check_handler(&mut self) {
        logl!(self.log; "setPermissionCheckHandler");
    }
}

/// the `Response` of a reply, as `{ status, headers, body }` with the body as
/// text (`null` for none)
fn describe_reply(reply: &DiagramReply) -> Value {
    match reply {
        DiagramReply::Status(status) => response_value(*status, &[], Value::Null),
        DiagramReply::File {
            path,
            headers,
            head,
        } => {
            let body = if *head {
                Value::Null
            } else {
                decoded(&std::fs::read(path).unwrap_or_default())
            };
            response_value(200, headers, body)
        }
        DiagramReply::Page { body, headers } => response_value(
            200,
            headers,
            body.as_ref()
                .map_or(Value::Null, |text| decoded(text.as_bytes())),
        ),
    }
}

/// `[{ paths, steps }]`: a step is `{ install }`, `{ hold: html }` (the token
/// is what `$PRINT` stands for in the next addresses), `{ drawio: { method,
/// url } }`, `{ renderer: { method, url } }`, `{ before: url }`, `{ permission:
/// name }` or `{ log }`; each answers one entry of the result (`null` where a
/// handler is not installed yet).
fn diagram_session_call(args: &[Value], cx: &mut Context) -> Answer {
    const TOKEN: &str = "0123456789abcdef0123456789abcdef";
    let spec = arg(args, 0).unwrap_or(&NULL);
    let paths = spec.get("paths").unwrap_or(&NULL);
    let paths = DiagramSessionPaths {
        renderer_dir: text(paths, "rendererDir").to_owned(),
        drawio_dir: text(paths, "drawioDir").to_owned(),
        bridge_file: text(paths, "bridgeFile").to_owned(),
        dev_origins: strings(paths.get("devOrigins")),
    };
    let log = new_log();
    let mut session = DiagramSession::new();
    let mut documents = PrintDocuments::new();
    let mut installed = false;
    let mut token = String::new();
    let mut results = Vec::new();
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let result = if flag(step, "install") {
            session.install(&paths, &mut SessionFake { log: &log });
            installed = true;
            Value::Null
        } else if let Some(html) = step.get("hold").and_then(Value::as_str) {
            token = documents.hold_print_document(html, TOKEN.to_owned());
            Value::Null
        } else if let Some(request) = step.get("drawio").filter(|_| installed) {
            describe_reply(&serve_drawio(
                text(request, "method"),
                &text(request, "url").replace("$PRINT", &token),
                &paths,
                &mut documents,
            ))
        } else if let Some(request) = step.get("renderer").filter(|_| installed) {
            describe_reply(&serve_renderer(
                text(request, "method"),
                &text(request, "url").replace("$PRINT", &token),
                &paths.renderer_dir,
            ))
        } else if let Some(url) = step.get("before").and_then(Value::as_str) {
            if installed {
                Value::Bool(session.cancels_request(url))
            } else {
                Value::Null
            }
        } else if let Some(name) = step.get("permission").and_then(Value::as_str) {
            if installed {
                let granted = permission_granted(name);
                json!({ "request": granted, "check": granted })
            } else {
                Value::Null
            }
        } else if flag(step, "log") {
            to_value(&session.diagram_request_log())
        } else {
            Value::Null
        };
        results.push(result);
    }
    finish(cx, &log);
    Ok(Some(Value::Array(results)))
}

// ---- docs/lazy-media ----

fn zip_entry_of(spec: &Value) -> ZipEntry {
    ZipEntry {
        name: text(spec, "name").to_owned(),
        method: num(spec, "method").unwrap_or(0.0) as u16,
        csize: num(spec, "csize").unwrap_or(0.0) as u64,
        uncompressed_size: num(spec, "usize").unwrap_or(0.0) as u64,
        data_offset: num(spec, "dataOffset").unwrap_or(0.0) as u64,
    }
}

fn zip_entries_of(list: Option<&Value>) -> Vec<ZipEntry> {
    list.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(zip_entry_of)
        .collect()
}

struct NoRead;

impl ZipRead for NoRead {
    fn read(&mut self, _offset: u64, _length: u64) -> Result<Vec<u8>, JsError> {
        Err(JsError::plain("unused"))
    }
}

/// the zip library, answering from `lib` of the scenario: `{ zips: [{ path,
/// size?, entries }], openThrows: [path], slim: { [hash]: hex | null |
/// "throws" }, hashes: { [hex of bytes]: [hash] | "throws" }, mem: { [hex of
/// bytes]: [entry] | "throws" } }`. Each call is a log line.
struct ScenarioLib<'a> {
    lib: &'a Value,
    log: &'a Log,
}

impl ZipLibrary for ScenarioLib<'_> {
    fn open_zip_file(&mut self, path: &str) -> Result<ZipFile, JsError> {
        logl!(self.log; "openZipFile", path);
        let zip = self
            .lib
            .get("zips")
            .and_then(Value::as_array)
            .and_then(|zips| zips.iter().find(|z| text(z, "path") == path));
        let Some(zip) = zip else {
            return Err(JsError::plain("zip: cannot open"));
        };
        if strings(self.lib.get("openThrows"))
            .iter()
            .any(|p| p == path)
        {
            return Err(JsError::plain("zip: cannot open"));
        }
        let mut entries = JsMap::new();
        for entry in zip_entries_of(zip.get("entries")) {
            entries.set(entry.name.clone(), entry);
        }
        Ok(ZipFile {
            size: num(zip, "size").unwrap_or(0.0) as u64,
            entries: Rc::new(entries),
            reader: Box::new(NoRead),
        })
    }

    fn close_zip_file(&mut self, _zip: ZipFile) {
        logl!(self.log; "close");
    }

    fn read_zip_entries(&mut self, bytes: &[u8]) -> Result<Vec<ZipEntry>, JsError> {
        let key = hex(bytes);
        logl!(self.log; "readZipEntries", key.clone());
        match self.lib.get("mem").and_then(|mem| mem.get(&key)) {
            Some(Value::Array(_)) => Ok(zip_entries_of(
                self.lib.get("mem").and_then(|m| m.get(&key)),
            )),
            _ => Err(JsError::plain("zip: not a zip")),
        }
    }

    fn slim_docx(
        &mut self,
        _zip: &ZipFile,
        hash: &str,
        min_bytes: u64,
    ) -> Result<Option<Vec<u8>>, JsError> {
        logl!(self.log; "slimDocx", hash, min_bytes);
        match self.lib.get("slim").and_then(|slim| slim.get(hash)) {
            Some(Value::String(s)) if s == "throws" => Err(JsError::plain("slim failed")),
            Some(Value::String(s)) => Ok(Some(unhex(s))),
            _ => Ok(None),
        }
    }

    fn lazy_media_hashes_in(&mut self, bytes: &[u8]) -> Result<Vec<String>, JsError> {
        let key = hex(bytes);
        logl!(self.log; "lazyMediaHashesIn", key.clone());
        match self.lib.get("hashes").and_then(|hashes| hashes.get(&key)) {
            Some(list @ Value::Array(_)) => Ok(strings(Some(list))),
            _ => Err(JsError::plain("not a zip")),
        }
    }

    fn materialize_docx(
        &mut self,
        bytes: &[u8],
        get_zip: &mut ZipSourceOf<'_>,
    ) -> Result<Vec<u8>, JsError> {
        let key = hex(bytes);
        logl!(self.log; "materializeDocx", key.clone());
        let hashes = strings(self.lib.get("hashes").and_then(|hashes| hashes.get(&key)));
        let mut out = bytes.to_vec();
        for hash in hashes {
            let zip = get_zip(self, &hash)?;
            match &zip {
                Some(zip) => logl!(self.log; "getZip", hash.clone(), zip.borrow().size),
                None => logl!(self.log; "getZip", hash.clone(), Value::Null),
            }
            if let Some(zip) = zip {
                let first = zip.borrow().entries.values().next().cloned();
                if let Some(entry) = first {
                    let part = zip
                        .borrow_mut()
                        .reader
                        .read(entry.data_offset, entry.csize.min(4))?;
                    out.extend(part);
                }
            }
        }
        Ok(out)
    }
}

/// `[{ lib, fontsDir, steps }]`: a step is `{ open: { path, wc } }`, `{ adopt:
/// { bytes, path, wc } }`, `{ move: [old, new] }`, `{ forget: wc }`, `{
/// materialize: hex }`, `{ point: { hashes, path, wc, plain? } }`, `{ read:
/// url }`, `{ handoff: hex }` (`$HANDOFF` in an address is its URL), `{
/// register: { handled } }` or `{ request: url }`; each answers one entry of
/// the result, `{ threw: message }` where the step threw.
fn lazy_media_call(args: &[Value], cx: &mut Context) -> Answer {
    const TOKEN: &str = "00000000-0000-4000-8000-000000000001";
    let spec = arg(args, 0).unwrap_or(&NULL);
    let lib_spec = spec.get("lib").unwrap_or(&NULL);
    let log = new_log();
    let mut lib = ScenarioLib {
        lib: lib_spec,
        log: &log,
    };
    let mut media = LazyMedia::new();
    let mut handoffs: ByteHandoffs<Vec<u8>> = ByteHandoffs::new();
    let mut handoff_url = String::new();
    let mut registered = false;
    let fonts_dir = text(spec, "fontsDir");
    let mut results = Vec::new();
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let result: Value = if let Some(open) = step.get("open") {
            match media.open_lazy_docx(
                &mut lib,
                text(open, "path"),
                num(open, "wc").unwrap_or(f64::NAN),
            ) {
                Some(opened) => json!({ "bytes": hex(&opened.bytes), "hash": opened.hash }),
                None => Value::Null,
            }
        } else if let Some(adopt) = step.get("adopt") {
            media.adopt_lazy_media_hashes(
                &mut lib,
                &unhex(text(adopt, "bytes")),
                text(adopt, "path"),
                num(adopt, "wc").unwrap_or(f64::NAN),
            );
            Value::Null
        } else if let Some(pair) = step.get("move").and_then(Value::as_array) {
            media.move_lazy_media_source(
                pair.first().and_then(Value::as_str).unwrap_or(""),
                pair.get(1).and_then(Value::as_str).unwrap_or(""),
            );
            Value::Null
        } else if let Some(wc) = step.get("forget").and_then(Value::as_f64) {
            media.forget_lazy_media_owner(wc);
            Value::Null
        } else if let Some(bytes) = step.get("materialize").and_then(Value::as_str) {
            match media.materialize_lazy_docx(&mut lib, &unhex(bytes)) {
                Ok(done) => json!({ "bytes": hex(&done.bytes), "hashes": done.hashes }),
                Err(error) => threw(&error.message),
            }
        } else if let Some(point) = step.get("point") {
            let plain = point.get("plain").and_then(Value::as_str).map(unhex);
            media.point_lazy_media_at(
                &strings(point.get("hashes")),
                text(point, "path"),
                num(point, "wc").unwrap_or(f64::NAN),
                plain.as_deref(),
            );
            Value::Null
        } else if let Some(url) = step.get("read").and_then(Value::as_str) {
            match media.read_lazy_media(&mut lib, &url.replace("$HANDOFF", &handoff_url)) {
                Ok(Some(found)) => json!({ "body": hex(&found.body), "mime": found.mime }),
                Ok(None) => Value::Null,
                Err(error) => threw(&error.message),
            }
        } else if let Some(bytes) = step.get("handoff").and_then(Value::as_str) {
            handoff_url = handoffs.hand_off_bytes(unhex(bytes), TOKEN.to_owned(), cx.now_ms);
            Value::Null
        } else if let Some(register) = step.get("register") {
            let handled = flag(register, "handled");
            let decided = register_lazy_media_protocol(&mut || {
                logl!(log; "isProtocolHandled", LAZY_MEDIA_SCHEME);
                handled
            });
            match decided {
                Ok(true) => {
                    logl!(log; "handle", LAZY_MEDIA_SCHEME);
                    registered = true;
                    Value::Bool(true)
                }
                Ok(false) => Value::Bool(false),
                Err(error) => threw(&error.message),
            }
        } else if let Some(url) = step.get("request").and_then(Value::as_str) {
            if registered {
                match media.answer(
                    &mut lib,
                    &mut handoffs,
                    &url.replace("$HANDOFF", &handoff_url),
                    fonts_dir,
                ) {
                    Ok(answer) => response_value(
                        answer.status,
                        &answer.headers,
                        Value::from(hex(&answer.body)),
                    ),
                    Err(error) => threw(&error.message),
                }
            } else {
                Value::Null
            }
        } else {
            Value::Null
        };
        results.push(result);
    }
    finish(cx, &log);
    Ok(Some(Value::Array(results)))
}

// ---- pdf/image-edit ----

fn rect_of(spec: Option<&Value>) -> [f64; 4] {
    let at = |i: usize| {
        spec.and_then(|v| v.get(i))
            .and_then(Value::as_f64)
            .unwrap_or(f64::NAN)
    };
    [at(0), at(1), at(2), at(3)]
}

/// `[objects: [{ bounds }], rect]`: the position of the match among the
/// objects, or `null`
fn match_image_call(args: &[Value]) -> Answer {
    let objects: Vec<ImageObj> = arg(args, 0)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .map(|(at, o)| ImageObj {
            obj: at as u32,
            index: 0,
            bounds: rect_of(o.get("bounds")),
            in_form: false,
        })
        .collect();
    let rect = rect_of(arg(args, 1));
    Ok(Some(
        match_image(&objects, &rect).map_or(Value::Null, |at| Value::from(at as u64)),
    ))
}

fn edit_of(spec: &Value) -> ImageEditInput {
    ImageEditInput {
        kind: match text(spec, "kind") {
            "insertImage" => EditKind::InsertImage,
            "transformImage" => EditKind::TransformImage,
            "replaceImage" => EditKind::ReplaceImage,
            _ => EditKind::DeleteImage,
        },
        page_index: num(spec, "pageIndex").unwrap_or(f64::NAN),
        old_rect: rect_of(spec.get("oldRect")),
        rect: rect_of(spec.get("rect")),
        layer: spec.get("layer").and_then(Value::as_str).map(str::to_owned),
        quarter_turns: num(spec, "quarterTurns"),
        rotate: num(spec, "rotate"),
    }
}

/// The PDFium of the spec: `{ pages: [{ objects: [{ type, index }], images:
/// [{ obj, index, bounds, inForm? }] }], loadFails: [page], generateFails:
/// [page], removeFails: [obj], exclusive: [obj], noInsertAt?, insertAtFails?,
/// image?: { empty?, width?, height?, bitmapFails?, noObj?, setBitmapFails? } }`.
/// A page handle is its index plus 100. Each call is a log line.
struct PdfFake<'a> {
    spec: &'a Value,
    log: &'a Log,
}

impl PdfFake<'_> {
    fn pages(&self) -> &[Value] {
        self.spec
            .get("pages")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[])
    }

    fn list(&self, key: &str) -> Vec<f64> {
        self.spec
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_f64)
            .collect()
    }

    fn page_spec(&self, page: u32) -> Option<&Value> {
        self.pages().get((page as usize).saturating_sub(100))
    }

    fn image(&self, key: &str) -> bool {
        self.spec.get("image").is_some_and(|image| flag(image, key))
    }

    /// `decodeImage` over the fake `nativeImage`: `Err` is its message
    fn decode(&self) -> Result<(), String> {
        logl!(self.log; "createFromBuffer");
        logl!(self.log; "isEmpty");
        let width = self
            .spec
            .get("image")
            .and_then(|i| num(i, "width"))
            .unwrap_or(1.0);
        let height = self
            .spec
            .get("image")
            .and_then(|i| num(i, "height"))
            .unwrap_or(1.0);
        let result = decode_image(self.image("empty"), (width, height), vec![1, 2, 3, 255]);
        if result.is_ok() {
            logl!(self.log; "getSize");
            logl!(self.log; "toBitmap");
        }
        result.map(|_| ())
    }

    fn bitmap_dims(&self) -> (f64, f64) {
        let get = |key: &str| {
            self.spec
                .get("image")
                .and_then(|i| num(i, key))
                .unwrap_or(1.0)
        };
        (get("width"), get("height"))
    }
}

impl ImagePdf for PdfFake<'_> {
    fn page_count(&mut self) -> i32 {
        self.pages().len() as i32
    }

    fn load_page(&mut self, page_index: f64) -> u32 {
        let index = jscompat::to_int32(page_index);
        logl!(self.log; "loadPage", index);
        let exists = index >= 0
            && (index as usize) < self.pages().len()
            && !self.list("loadFails").contains(&f64::from(index));
        if exists { 100 + index as u32 } else { 0 }
    }

    fn close_page(&mut self, page: u32) {
        logl!(self.log; "closePage", page - 100);
    }

    fn generate_content(&mut self, page: u32) -> bool {
        logl!(self.log; "generateContent", page - 100);
        !self.list("generateFails").contains(&f64::from(page - 100))
    }

    fn collect_objects(&mut self, page: u32) -> Vec<PageObj> {
        self.page_spec(page)
            .and_then(|p| p.get("objects"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|o| PageObj {
                index: num(o, "index").unwrap_or(0.0) as i32,
                kind: num(o, "type").unwrap_or(0.0) as i32,
            })
            .collect()
    }

    fn collect_images(&mut self, page: u32) -> Vec<ImageObj> {
        self.page_spec(page)
            .and_then(|p| p.get("images"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|o| ImageObj {
                obj: num(o, "obj").unwrap_or(0.0) as u32,
                index: num(o, "index").unwrap_or(0.0) as i32,
                bounds: rect_of(o.get("bounds")),
                in_form: flag(o, "inForm"),
            })
            .collect()
    }

    fn form_draw_tree(&mut self) {
        logl!(self.log; "formDrawTree");
    }

    fn chain_is_exclusive(&mut self, page_index: f64, img: &ImageObj) -> bool {
        logl!(self.log; "chainIsExclusive", number(page_index), img.obj);
        self.list("exclusive").contains(&f64::from(img.obj))
    }

    fn lift_out_of_forms(&mut self, page: u32, img: &ImageObj) {
        logl!(self.log; "lift", page - 100, img.obj);
    }

    fn remove_object(&mut self, page: u32, obj: u32) -> bool {
        logl!(self.log; "removeObject", page - 100, obj);
        !self.list("removeFails").contains(&f64::from(obj))
    }

    fn destroy_object(&mut self, obj: u32) {
        logl!(self.log; "destroyObject", obj);
    }

    fn insert_object(&mut self, page: u32, obj: u32) {
        logl!(self.log; "insertObject", page - 100, obj);
    }

    fn has_insert_object_at_index(&self) -> bool {
        !flag(self.spec, "noInsertAt")
    }

    fn insert_object_at_index(&mut self, page: u32, obj: u32, index: i32) -> bool {
        logl!(self.log; "insertObjectAt", page - 100, obj, index);
        !flag(self.spec, "insertAtFails")
    }

    fn transform(&mut self, obj: u32, matrix: [f64; 6]) {
        let mut line = vec![json!("transform"), json!(obj)];
        line.extend(matrix.iter().map(|x| number(*x)));
        self.log.borrow_mut().push(line);
    }

    fn new_image_object(&mut self, edit: &ImageEditInput) -> Result<u32, String> {
        self.decode()?;
        let (width, height) = self.bitmap_dims();
        logl!(self.log; "bitmapCreateEx", number(width), number(height));
        if self.image("bitmapFails") {
            return Err("FPDFBitmap_CreateEx failed".to_owned());
        }
        logl!(self.log; "newImageObj");
        let obj = if self.image("noObj") { 0 } else { 900 };
        let mut ok = obj != 0;
        if ok {
            logl!(self.log; "setBitmap", 0, obj);
            ok = !self.image("setBitmapFails");
        }
        logl!(self.log; "bitmapDestroy");
        if !ok {
            if obj != 0 {
                logl!(self.log; "destroyObject", obj);
            }
            return Err("FPDFImageObj_SetBitmap failed".to_owned());
        }
        let mut line = vec![json!("setMatrix"), json!(obj)];
        line.extend(
            image_matrix(&edit.rect, edit.rotate.unwrap_or(0.0))
                .iter()
                .map(|x| number(f64::from(*x as f32))),
        );
        self.log.borrow_mut().push(line);
        Ok(obj)
    }

    fn replace_bitmap(
        &mut self,
        page: u32,
        obj: u32,
        _edit: &ImageEditInput,
    ) -> Result<(), String> {
        self.decode()?;
        let (width, height) = self.bitmap_dims();
        logl!(self.log; "bitmapCreateEx", number(width), number(height));
        if self.image("bitmapFails") {
            return Err("FPDFBitmap_CreateEx failed".to_owned());
        }
        logl!(self.log; "setBitmap", page - 100, obj);
        let ok = !self.image("setBitmapFails");
        logl!(self.log; "bitmapDestroy");
        if !ok {
            return Err("FPDFImageObj_SetBitmap failed".to_owned());
        }
        Ok(())
    }
}

/// `[world]`: `applyImageEdits` answers `{ saved, skipped }` for `world.edits`,
/// `listPageImages` the list of refs, `verifyImageEdits` the failures of
/// `world.checks: [{ pageIndex, rect }]`
fn image_edits_call(name: &str, args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).unwrap_or(&NULL);
    let log = new_log();
    let mut pdf = PdfFake { spec, log: &log };
    let answer: Answer = match name {
        "image-edit.applyImageEdits" => {
            let edits: Vec<ImageEditInput> = spec
                .get("edits")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(edit_of)
                .collect();
            apply_image_edits(&mut pdf, &edits)
                .map(|outcome| {
                    let skipped: Vec<Value> = outcome
                        .skipped
                        .iter()
                        .map(|s| {
                            json!({
                                "editIndex": s.edit_index,
                                "pageIndex": number(s.page_index),
                                "reason": s.reason,
                            })
                        })
                        .collect();
                    Some(json!({ "saved": outcome.changed, "skipped": skipped }))
                })
                .map_err(CallError::plain)
        }
        "image-edit.listPageImages" => Ok(Some(Value::Array(
            list_page_images(&mut pdf)
                .iter()
                .map(|r| {
                    json!({
                        "pageIndex": r.page_index,
                        "rect": r.rect.iter().map(|x| number(*x)).collect::<Vec<_>>(),
                        "aboveText": r.above_text,
                    })
                })
                .collect(),
        ))),
        _ => {
            let checks: Vec<(f64, [f64; 4])> = spec
                .get("checks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|c| {
                    (
                        num(c, "pageIndex").unwrap_or(f64::NAN),
                        rect_of(c.get("rect")),
                    )
                })
                .collect();
            Ok(Some(Value::Array(
                verify_image_edits(&mut pdf, &checks)
                    .iter()
                    .map(|(page_index, reason)| {
                        json!({ "pageIndex": number(*page_index), "reason": reason })
                    })
                    .collect(),
            )))
        }
    };
    finish(cx, &log);
    answer
}

// ---- slides/session-state ----

#[derive(Clone)]
struct Snap {
    slides: Value,
    entries: Vec<(String, Rc<Vec<u8>>)>,
    size: Value,
    meta_dirty: bool,
}

struct FakeDeck {
    slides: Value,
    size: Value,
    entries: Vec<(String, Rc<Vec<u8>>)>,
}

impl Deck<Snap> for FakeDeck {
    fn take_snapshot(&self, meta_dirty: bool) -> Snap {
        Snap {
            slides: self.slides.clone(),
            entries: self.entries.clone(),
            size: self.size.clone(),
            meta_dirty,
        }
    }

    fn restore_snapshot(&mut self, fresh: Snap) -> bool {
        self.slides = fresh.slides;
        self.size = fresh.size;
        self.entries = fresh.entries;
        fresh.meta_dirty
    }
}

impl PartPath for Value {
    fn part_path(&self) -> Option<&str> {
        self.get("partPath").and_then(Value::as_str)
    }
}

type Sess = Session<FakeDeck, Snap, Value, Value>;

fn snap_json(snap: &Snap) -> Value {
    json!({
        "slides": snap.slides.clone(),
        "entries": snap
            .entries
            .iter()
            .map(|(name, bytes)| json!([name, hex(bytes)]))
            .collect::<Vec<_>>(),
        "size": snap.size.clone(),
        "metaDirty": snap.meta_dirty,
    })
}

fn update_json(update: &SlideUpdate<Value>) -> Value {
    json!({ "order": update.order.clone(), "slides": update.slides.clone() })
}

fn state_json(s: &Sess) -> Value {
    let opt_u64 = |v: Option<u64>| v.map_or(Value::Null, Value::from);
    json!({
        "path": s.path.clone(),
        "undo": s.undo_stack.iter().map(snap_json).collect::<Vec<_>>(),
        "redo": s.redo_stack.iter().map(snap_json).collect::<Vec<_>>(),
        "batch": s.history_batch.as_ref().map_or(Value::Null, |b| json!({
            "depth": b.depth,
            "undoStart": b.undo_start,
            "before": snap_json(&b.before),
        })),
        "aiSnapshots": s.ai_snapshots.as_ref().map_or(Value::Null, |map| Value::Array(
            map.iter().map(|(id, snap)| json!([id, snap_json(snap)])).collect()
        )),
        "aiRun": s.ai_run,
        "metaDirty": s.meta_dirty,
        "metaRev": opt_u64(s.meta_rev),
        "opSeq": opt_u64(s.op_seq),
        "opLog": s.op_log.as_ref().map_or(Value::Null, |log| Value::Array(
            log.iter().map(|entry| json!({
                "seq": entry.seq,
                "source": entry.source.as_str(),
                "ops": entry.ops.iter().map(|op| {
                    let mut one = Map::new();
                    one.insert("op".into(), op.op.clone());
                    if let Some(id) = &op.slide_id {
                        one.insert("slideId".into(), Value::from(id.as_str()));
                    }
                    if let Some(created) = &op.created {
                        one.insert("created".into(), json!(created));
                    }
                    Value::Object(one)
                }).collect::<Vec<_>>(),
            })).collect()
        )),
        "notify": s.history_notify_scheduled,
        "broadcast": s.deck_broadcast_scheduled,
        "updates": s.deck_broadcast_updates.as_ref().map_or(Value::Null, |updates| Value::Array(
            updates.iter().map(|u| u.as_ref().map_or(Value::Null, update_json)).collect()
        )),
    })
}

fn entries_of(spec: Option<&Value>) -> Vec<(String, Rc<Vec<u8>>)> {
    spec.and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .map(|(name, bytes)| (name.clone(), Rc::new(unhex(bytes.as_str().unwrap_or("")))))
                .collect()
        })
        .unwrap_or_default()
}

/// `hasNumber(el)` of `buildSlideUpdate`: a slide-number field in a text
/// element, or in a group's children
fn has_number(element: &Value) -> bool {
    if text(element, "type") == "group" {
        return element
            .get("children")
            .and_then(Value::as_array)
            .is_some_and(|children| children.iter().any(has_number));
    }
    element
        .get("text")
        .and_then(|t| t.get("paragraphs"))
        .and_then(Value::as_array)
        .is_some_and(|paragraphs| {
            paragraphs.iter().any(|p| {
                p.get("runs")
                    .and_then(Value::as_array)
                    .is_some_and(|runs| runs.iter().any(|r| text(r, "field") == "slidenum"))
            })
        })
}

fn slide_refs(slides: &Value) -> Vec<SlideRef> {
    slides
        .as_array()
        .into_iter()
        .flatten()
        .map(|slide| {
            let list = |key: &str| {
                slide
                    .get(key)
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or(&[])
            };
            SlideRef {
                path: text(slide, "path").to_owned(),
                has_number: list("elements")
                    .iter()
                    .chain(list("decorations").iter())
                    .any(has_number),
            }
        })
        .collect()
}

/// `buildRenderSlide` of the spec's stub: `{ partPath, slideNo, fitWidthPx }`;
/// the metrics are asked for first, as the options literal does
fn render_slide(
    log: &Log,
    fonts: &mut FontMetrics<u64>,
    created: &mut u64,
    slide: &Value,
    index: usize,
    fit: f64,
) -> Value {
    fonts.get(|| {
        logl!(log; "createSystemFontMetrics");
        *created += 1;
        *created
    });
    let mut out = Map::new();
    if let Some(path) = slide.get("path") {
        out.insert("partPath".into(), path.clone());
    }
    out.insert("slideNo".into(), Value::from(index as u64 + 1));
    out.insert("fitWidthPx".into(), number(fit));
    Value::Object(out)
}

/// A window of a spec: `{ destroyed }`, named; `isDestroyed` is a log line.
struct FakeWin {
    name: String,
    destroyed: bool,
    log: Log,
}

impl ParentWindow for FakeWin {
    fn is_destroyed(&self) -> bool {
        logl!(self.log; "isDestroyed", self.name.clone());
        self.destroyed
    }
}

struct SceneArchive<'a> {
    entries: &'a [(String, Rc<Vec<u8>>)],
    chains: &'a Value,
    slides: &'a Value,
    log: &'a Log,
}

impl SlideArchive for SceneArchive<'_> {
    fn read_bytes(&self, path: &str) -> Option<Rc<Vec<u8>>> {
        self.entries
            .iter()
            .find(|(name, _)| name == path)
            .map(|(_, bytes)| Rc::clone(bytes))
    }

    fn read_text(&self, path: &str) -> Option<String> {
        self.read_bytes(path)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
    }

    fn resolve_slide_chain(&self, path: &str) -> SlideChain {
        logl!(self.log; "resolveSlideChain", path);
        let chain = self.chains.get(path);
        let field = |key: &str| {
            chain
                .and_then(|c| c.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        SlideChain {
            layout_path: field("layoutPath"),
            master_path: field("masterPath"),
            theme_path: field("themePath"),
        }
    }

    fn first_slide_path(&self) -> Option<String> {
        self.slides
            .get(0)
            .and_then(|s| s.get("path"))
            .and_then(Value::as_str)
            .map(str::to_owned)
    }
}

/// `parseTheme`: `"k=v,k=v"` into colors (the word THROWTHEME throws);
/// `parseClrMap` logs its three texts (a layout holding THROWMAP throws);
/// `resolveSchemeColor` is the color of an own key.
struct ThemeFake<'a> {
    log: &'a Log,
}

impl ThemeEngine for ThemeFake<'_> {
    type Theme = Vec<(String, String)>;

    fn parse_theme(&mut self, xml: &str) -> Result<Self::Theme, EngineThrew> {
        if xml.contains("THROWTHEME") {
            return Err(EngineThrew);
        }
        Ok(xml
            .split(',')
            .filter_map(|pair| pair.split_once('='))
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect())
    }

    fn set_clr_map(
        &mut self,
        _theme: &mut Self::Theme,
        master_xml: Option<&str>,
        layout_xml: Option<&str>,
        slide_xml: Option<&str>,
    ) -> Result<(), EngineThrew> {
        logl!(self.log; "parseClrMap", master_xml, layout_xml, slide_xml);
        if layout_xml.is_some_and(|layout| layout.contains("THROWMAP")) {
            return Err(EngineThrew);
        }
        Ok(())
    }

    fn resolve_scheme_color(&mut self, scheme: &str, theme: &Self::Theme) -> Option<String> {
        theme
            .iter()
            .rev()
            .find(|(k, _)| k == scheme)
            .map(|(_, v)| v.clone())
    }
}

/// Every bytes handle the deck and the session's snapshots hold
fn retained_of(session: &Sess) -> Vec<Rc<Vec<u8>>> {
    let mut out: Vec<Rc<Vec<u8>>> = session
        .deck
        .entries
        .iter()
        .map(|(_, b)| Rc::clone(b))
        .collect();
    let mut add = |snap: &Snap| out.extend(snap.entries.iter().map(|(_, b)| Rc::clone(b)));
    session.undo_stack.iter().for_each(&mut add);
    session.redo_stack.iter().for_each(&mut add);
    if let Some(batch) = &session.history_batch {
        add(&batch.before);
    }
    for (_, snap) in session.ai_snapshots.iter().flatten() {
        add(snap);
    }
    out
}

/// `[{ path, deck: { slides, size }, entries: { name: hex }, fit, live: [id],
/// windows: { name: { destroyed } }, fromWc: { id: name }, hookMap: { id:
/// name }, chains: { path: { layoutPath, masterPath, themePath } }, steps }]`
/// over the session-state module. A step answers one entry of `steps`; the
/// answer is `{ steps, state }`. `webContents.fromId(id).send` of a live id is
/// `["send", id, channel, payload]`.
fn session_state_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).unwrap_or(&NULL);
    let log = new_log();
    let deck_spec = spec.get("deck").unwrap_or(&NULL);
    let new_deck = |entries: Vec<(String, Rc<Vec<u8>>)>, deck: &Value| FakeDeck {
        slides: deck.get("slides").cloned().unwrap_or(Value::Null),
        size: deck.get("size").cloned().unwrap_or(Value::Null),
        entries,
    };
    let mut session: Sess = Session::new(
        text(spec, "path"),
        new_deck(entries_of(spec.get("entries")), deck_spec),
    );
    let fit = num(spec, "fit").unwrap_or(1000.0);
    let live: Vec<f64> = spec
        .get("live")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_f64)
        .collect();
    let chains = spec.get("chains").unwrap_or(&NULL);
    let windows: Vec<FakeWin> = spec
        .get("windows")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, w)| FakeWin {
            name: name.clone(),
            destroyed: flag(w, "destroyed"),
            log: Rc::clone(&log),
        })
        .collect();
    let window = |name: Option<&str>| name.and_then(|n| windows.iter().find(|w| w.name == n));
    let mut ids = SessionIds::new();
    let mut wc = WcSessions::new();
    let mut media = MediaRegistry::new();
    let mut fonts: FontMetrics<u64> = FontMetrics::new();
    let mut created = 0u64;
    let mut uuid = 0u64;
    let mut shell: Option<String> = None;
    let mut hook_on = false;
    let mut results: Vec<Value> = Vec::new();
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let op = text(step, "op");
        let result: Value = match op {
            "push" => {
                session.push_history();
                Value::Null
            }
            "begin" => {
                session.begin_history_batch();
                Value::Null
            }
            "end" => session
                .end_history_batch()
                .map_or(Value::Null, |snap| snap_json(&snap)),
            "edit" => {
                if let Some(slides) = step.get("slides") {
                    session.deck.slides = slides.clone();
                }
                if let Some(size) = step.get("size") {
                    session.deck.size = size.clone();
                }
                for (name, bytes) in entries_of(step.get("set")) {
                    match session.deck.entries.iter_mut().find(|(k, _)| *k == name) {
                        Some(entry) => entry.1 = bytes,
                        None => session.deck.entries.push((name, bytes)),
                    }
                }
                let gone = strings(step.get("delete"));
                session
                    .deck
                    .entries
                    .retain(|(name, _)| !gone.contains(name));
                Value::Null
            }
            "restore" => {
                let from_undo = text(step, "from") != "redo";
                let popped = if from_undo {
                    session.undo_stack.pop()
                } else {
                    session.redo_stack.pop()
                };
                match popped {
                    Some(snap) => {
                        session.restore_snapshot(&snap);
                        Value::Bool(true)
                    }
                    None => Value::Bool(false),
                }
            }
            "registerAi" => {
                let snap = session.take_snapshot();
                Value::from(session.register_ai_snapshot(&mut ids, &snap))
            }
            "registerBefore" => match session.history_batch.as_ref().map(|b| b.before.clone()) {
                Some(snap) => Value::from(session.register_ai_snapshot(&mut ids, &snap)),
                None => Value::Null,
            },
            "restoreAi" => {
                Value::Bool(session.restore_ai_snapshot(num(step, "id").unwrap_or(f64::NAN)))
            }
            "settle" => {
                session.settle_stale_history_batch(&mut ids);
                Value::Null
            }
            "setAiRun" => {
                session.ai_run = flag(step, "on");
                Value::Null
            }
            "meta" => {
                session.mark_meta_dirty();
                Value::Null
            }
            "journal" => {
                let source = match text(step, "source") {
                    "batch" => OpSource::Batch,
                    "script" => OpSource::Script,
                    "generate" => OpSource::Generate,
                    _ => OpSource::Edit,
                };
                let records: Vec<OpRecord<Value>> = step
                    .get("records")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|record| OpRecord {
                        op: record.get("op").cloned().unwrap_or(Value::Null),
                        slide_id: record
                            .get("slideId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        created: record
                            .get("created")
                            .and_then(Value::as_array)
                            .map(|_| strings(record.get("created"))),
                    })
                    .collect();
                session.journal_ops(source, records);
                Value::Null
            }
            "replace" => {
                let deck = new_deck(
                    session.deck.entries.clone(),
                    &json!({ "slides": session.deck.slides.clone(), "size": session.deck.size.clone() }),
                );
                let mut replacement: Sess = Session::new(text(step, "path"), deck);
                Sess::carry_history_for_replacement(Some(&mut session), &mut replacement);
                session = replacement;
                Value::Null
            }
            "broadcast" => {
                session.schedule_deck_broadcast();
                Value::Null
            }
            "slideUpdate" => {
                let before = strings(step.get("before"));
                let changed: Vec<f64> = step
                    .get("changed")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_f64)
                    .collect();
                let refs = slide_refs(&session.deck.slides);
                let (order, rebuild) = plan_slide_update(&refs, &before, &changed);
                let slides: Vec<Value> = rebuild
                    .iter()
                    .map(|&i| {
                        let slide = session.deck.slides.get(i).cloned().unwrap_or(Value::Null);
                        render_slide(&log, &mut fonts, &mut created, &slide, i, fit)
                    })
                    .collect();
                let update = SlideUpdate { order, slides };
                let shown = update_json(&update);
                session.note_slide_update(update);
                shown
            }
            "flush" => {
                for task in session.take_scheduled() {
                    match task {
                        Scheduled::HistoryNotify => {
                            let changed = session.flush_history_notify();
                            let retained = retained_of(&session);
                            media.prune(1, &retained);
                            for id in wc.attached_ids(0) {
                                if live.contains(&id) {
                                    logl!(log; "send", number(id), "slides:history-changed", to_value(&changed));
                                }
                            }
                        }
                        Scheduled::DeckBroadcast => {
                            let ids = wc.attached_ids(0);
                            let plan = session.flush_deck_broadcast(ids.len());
                            let (order, slides) = match plan {
                                DeckBroadcast::Nothing => continue,
                                DeckBroadcast::Partial { order, slides } => (Some(order), slides),
                                DeckBroadcast::Full => {
                                    let all: Vec<Value> = session
                                        .deck
                                        .slides
                                        .as_array()
                                        .into_iter()
                                        .flatten()
                                        .enumerate()
                                        .map(|(i, slide)| {
                                            render_slide(
                                                &log,
                                                &mut fonts,
                                                &mut created,
                                                slide,
                                                i,
                                                fit,
                                            )
                                        })
                                        .collect();
                                    (None, all)
                                }
                            };
                            let size = &session.deck.size;
                            let mut payload = Map::new();
                            if let Some(order) = order {
                                payload.insert("order".into(), json!(order));
                            }
                            payload.insert("slides".into(), Value::Array(slides));
                            payload.insert(
                                "size".into(),
                                json!({ "cx": size.get("cx").cloned(), "cy": size.get("cy").cloned() }),
                            );
                            let payload = Value::Object(payload);
                            for id in ids {
                                if live.contains(&id) {
                                    logl!(log; "send", number(id), "slides:deck-changed", payload.clone());
                                }
                            }
                        }
                    }
                }
                Value::Null
            }
            "attach" => {
                let id = num(step, "wc").unwrap_or(f64::NAN);
                wc.set(id, 0);
                if flag(step, "viewer") {
                    wc.add_viewer(id);
                }
                Value::Null
            }
            "attached" => json!({
                "attached": wc.attached_ids(0).iter().map(|id| number(*id)).collect::<Vec<_>>(),
                "editors": wc.editor_attached_ids(0).iter().map(|id| number(*id)).collect::<Vec<_>>(),
            }),
            "shell" => {
                shell = step
                    .get("window")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                Value::Null
            }
            "hook" => {
                hook_on = flag(step, "on");
                Value::Null
            }
            "host" => {
                let id = number_to_string(num(step, "wc").unwrap_or(f64::NAN));
                let from_wc = window(
                    spec.get("fromWc")
                        .and_then(|m| m.get(&id))
                        .and_then(Value::as_str),
                );
                let hooked = || {
                    if hook_on {
                        window(
                            spec.get("hookMap")
                                .and_then(|m| m.get(&id))
                                .and_then(Value::as_str),
                        )
                    } else {
                        None
                    }
                };
                let found = host_window_for(|| from_wc, Some(hooked), window(shell.as_deref()));
                found.map_or(Value::Null, |w| Value::from(w.name.as_str()))
            }
            "dialogParent" => {
                let found = dialog_parent(
                    window(step.get("focused").and_then(Value::as_str)),
                    window(shell.as_deref()),
                );
                found.map_or(Value::Null, |w| Value::from(w.name.as_str()))
            }
            "fontMetrics" => {
                if text(step, "do") == "reset" {
                    fonts.reset(|| logl!(log; "resetFontRegistry"));
                    Value::Null
                } else {
                    let id = *fonts.get(|| {
                        logl!(log; "createSystemFontMetrics");
                        created += 1;
                        created
                    });
                    Value::from(id)
                }
            }
            "resolve" => {
                let archive = SceneArchive {
                    entries: &session.deck.entries,
                    chains,
                    slides: &session.deck.slides,
                    log: &log,
                };
                let slide_path = step.get("slidePath").and_then(Value::as_str);
                media
                    .resolve_media(1, &archive, slide_path, text(step, "ref"), || {
                        uuid += 1;
                        format!("uuid-{uuid}")
                    })
                    .map_or(Value::Null, Value::from)
            }
            "read" => {
                let archive = SceneArchive {
                    entries: &session.deck.entries,
                    chains,
                    slides: &session.deck.slides,
                    log: &log,
                };
                let mut engine = ThemeFake { log: &log };
                let found = media.read_slide_media(
                    text(step, "url"),
                    &archive,
                    &mut engine,
                    &mut |bytes| {
                        if bytes.len() > 4 && bytes[4] != 0 {
                            Some(vec![0x89, 0x50, 0x4e, 0x47])
                        } else {
                            None
                        }
                    },
                );
                found.map_or(
                    Value::Null,
                    |m| json!({ "body": hex(&m.body), "mime": m.mime }),
                )
            }
            "prune" => {
                let retained = retained_of(&session);
                media.prune(1, &retained);
                Value::Null
            }
            _ => Value::Null,
        };
        results.push(result);
    }
    finish(cx, &log);
    Ok(Some(
        json!({ "steps": results, "state": state_json(&session) }),
    ))
}
