//! The diagram hosts as fakes, for [`crate::testkit::Kit`] and `ipc-probe`.
//! They answer from the case's `hosts.d1.diagram` value and, when the probe
//! inserted a case log, push one line per call named after the TypeScript
//! function the call stands for (the TypeScript side of the ipc-diff group
//! logs the same lines):
//!
//! | key | answers | log line |
//! | --- | --- | --- |
//! | `openDiagram` | `{"<file name>": {ok, xml, format, root, anyPageCompressed} or {ok: false, reason, message}}` | `["drawio.openDiagram", name, byteLength]` |
//! | `pictureExt` | `{"<file name>": "drawio.png"}` | `["fileParse.diagramPictureExtOf", path]` |
//! | `parseFileToText` | `{"<file name>": {ok, kind, text, damaged, error}}` | `["fileParse.parseFileToText", path]` |
//! | `recoveryTitle` | a string | `["diagram.recoveryTitle", view]` |
//! | `openFailed` | a bool | `["diagram.openFailed", view, message]` |
//! | `openElsewhere` | the paths open in another pane | `["electronUtils.isPathOpenElsewhere", path]` |
//! | `unsaved` | `{"<file name>": "<refusal message>"}` | `["electronUtils.assertFileSaved", path]` |
//! | `headless` | a bool | none |
//! | `newDocumentDir` | a string or null | `["diagram.newDocumentDir", view]` |
//! | `writeNewDocument` | `{path}` or `{error}`; absent: the hook is unset | `["diagram.writeNewDocument", view, fileName, byteLength]` |
//! | `pdf` | hex of the PDF | `["diagram.renderPdf", printHtml]` |
//!
//! | `open` | `[{view, path?, decision?}]`: the views the shell made (`createDiagramView(path)`), `decision` is `restore` or `original` | none |
//! | `headlessJob` | `{view, path}`: a headless export of `path` runs in that hidden window | none |
//!
//! Save tokens are `00000000000000000000000000000001`, `...02`, and so on.
//!
//! Without a case a file opens when its text has an `mxfile` or
//! `mxGraphModel` root, nothing is open elsewhere or unsaved, and the PDF is
//! `%PDF`.
//! `help` and `file-saved` and `provisional-title` have no answer; they log
//! `["diagram.help", view]`, `["diagram.fileSaved", view, path]` and
//! `["diagram.provisionalTitle", view, title]`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use main_core::diagram::print_document::PrintPage;
use serde_json::{Value, json};
use shell_contract::{Hosts, ViewId};

use super::engine::{DiagramEngine, DiagramEngineHost, DiagramFile, OpenFailure, ParsedText};
use super::formats::{Detected, DiagramFormat, detect_format};
use super::shell::{DiagramShell, DiagramShellHost};
use super::state::Decision;

/// The case's log, as the probe inserts it
type CaseLog = Arc<Mutex<Vec<Value>>>;

/// One view the shell made before the case's first call
pub(super) struct OpenView {
    pub view: ViewId,
    pub path: Option<String>,
    pub decision: Option<Decision>,
    /// `queueDiagramSeedFor`: the draw.io XML queued for the view
    pub seed: Option<String>,
}

/// The views the case says the shell made before its first call, and the
/// headless job it started: [`super::routes`] applies them at registration
pub(super) struct ProbeOpen {
    pub open: Vec<OpenView>,
    pub headless: Option<(ViewId, String)>,
}

pub(super) fn insert(hosts: &mut Hosts, case: &Value) {
    let case_diagram = case.get("diagram").unwrap_or(&Value::Null);
    let view_of = |entry: &Value| {
        entry
            .get("view")
            .and_then(Value::as_u64)
            .map(|v| ViewId(v as u32))
    };
    // `open` absent: a new, untitled diagram in view 1
    let open = match case_diagram.get("open").and_then(Value::as_array) {
        Some(entries) => entries
            .iter()
            .filter_map(|entry| {
                let decision = match entry.get("decision").and_then(Value::as_str) {
                    Some("restore") => Some(Decision::Restore),
                    Some("original") => Some(Decision::Original),
                    _ => None,
                };
                let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_owned);
                Some(OpenView {
                    view: view_of(entry)?,
                    path: text("path"),
                    decision,
                    seed: text("seed"),
                })
            })
            .collect(),
        None => vec![OpenView {
            view: ViewId(1),
            path: None,
            decision: None,
            seed: None,
        }],
    };
    let headless = case_diagram.get("headlessJob").and_then(|entry| {
        let path = entry.get("path")?.as_str()?.to_owned();
        Some((view_of(entry)?, path))
    });
    hosts.insert(ProbeOpen { open, headless });
    let fake = Fake {
        case: case.get("diagram").cloned().unwrap_or(Value::Null),
        log: hosts.get::<CaseLog>().cloned(),
        tokens: AtomicU64::new(0),
    };
    hosts.insert::<DiagramEngineHost>(Arc::new(Fake {
        case: fake.case.clone(),
        log: fake.log.clone(),
        tokens: AtomicU64::new(0),
    }));
    hosts.insert::<DiagramShellHost>(Arc::new(fake));
}

struct Fake {
    case: Value,
    log: Option<CaseLog>,
    /// the save tokens handed out so far: they count up, 1, 2, ...
    tokens: AtomicU64,
}

impl Fake {
    fn log(&self, line: Value) {
        if let Some(log) = &self.log {
            log.lock().unwrap().push(line);
        }
    }

    fn answer(&self, key: &str) -> &Value {
        self.case.get(key).unwrap_or(&Value::Null)
    }

    fn text(&self, key: &str, field: &str) -> Option<&str> {
        self.answer(key).get(field).and_then(Value::as_str)
    }
}

/// the file name a case keys a scripted answer by (`$DIR` is not replaced in keys)
fn name_of(path: &str) -> String {
    jscompat::node_path::host::basename(path, None)
}

fn format_named(name: &str) -> DiagramFormat {
    match name {
        "dio" => DiagramFormat::Dio,
        "drawio.svg" => DiagramFormat::DrawioSvg,
        "drawio.png" => DiagramFormat::DrawioPng,
        _ => DiagramFormat::Drawio,
    }
}

impl DiagramEngine for Fake {
    fn open_diagram(&self, name: &str, bytes: &[u8]) -> Result<DiagramFile, OpenFailure> {
        self.log(json!(["drawio.openDiagram", name, bytes.len()]));
        if let Some(scripted) = self.answer("openDiagram").get(name) {
            let text = |key: &str| scripted.get(key).and_then(Value::as_str).unwrap_or("");
            if scripted.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(OpenFailure {
                    reason: text("reason").to_owned(),
                    message: text("message").to_owned(),
                });
            }
            return Ok(DiagramFile {
                xml: text("xml").to_owned(),
                format: format_named(text("format")),
                root: text("root").to_owned(),
                any_page_compressed: scripted
                    .get("anyPageCompressed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            });
        }
        let fail = |reason: &str| OpenFailure {
            reason: reason.to_owned(),
            message: reason.to_owned(),
        };
        let format = match detect_format(name) {
            Some(Detected::Format(format)) => format,
            _ => return Err(fail("unsupported")),
        };
        if matches!(format, DiagramFormat::DrawioSvg | DiagramFormat::DrawioPng) {
            return Err(fail("no_original"));
        }
        let xml = String::from_utf8(bytes.to_vec()).map_err(|_| fail("not_xml"))?;
        let root = if xml.contains("<mxfile") {
            "mxfile"
        } else if xml.contains("<mxGraphModel") {
            "mxGraphModel"
        } else {
            return Err(fail("no_diagram"));
        };
        Ok(DiagramFile {
            any_page_compressed: false,
            root: root.to_owned(),
            xml,
            format,
        })
    }

    fn diagram_picture_ext_of(&self, path: &str) -> Option<DiagramFormat> {
        self.log(json!(["fileParse.diagramPictureExtOf", path]));
        self.text("pictureExt", &name_of(path)).map(format_named)
    }

    fn parse_file_to_text(&self, path: &str) -> ParsedText {
        self.log(json!(["fileParse.parseFileToText", path]));
        if let Some(scripted) = self.answer("parseFileToText").get(name_of(path)) {
            let flag = |key: &str| scripted.get(key).and_then(Value::as_bool).unwrap_or(false);
            let text = |key: &str| scripted.get(key).and_then(Value::as_str).map(str::to_owned);
            return ParsedText {
                ok: flag("ok"),
                is_text: scripted.get("kind").and_then(Value::as_str) == Some("text"),
                text: text("text"),
                damaged: flag("damaged"),
                error: text("error"),
            };
        }
        match std::fs::read_to_string(path) {
            Ok(text) => ParsedText {
                ok: true,
                is_text: true,
                text: Some(text),
                ..ParsedText::default()
            },
            Err(err) => ParsedText {
                error: Some(err.to_string()),
                ..ParsedText::default()
            },
        }
    }
}

impl DiagramShell for Fake {
    fn new_document_dir(&self, view: ViewId) -> Option<String> {
        self.log(json!(["diagram.newDocumentDir", view.0]));
        self.answer("newDocumentDir").as_str().map(str::to_owned)
    }

    fn has_new_document_writer(&self) -> bool {
        !self.answer("writeNewDocument").is_null()
    }

    fn write_new_document(
        &self,
        view: ViewId,
        file_name: &str,
        bytes: &[u8],
    ) -> Option<Result<Option<String>, String>> {
        self.log(json!([
            "diagram.writeNewDocument",
            view.0,
            file_name,
            bytes.len()
        ]));
        let scripted = self.answer("writeNewDocument");
        if scripted.is_null() {
            return None;
        }
        if let Some(error) = scripted.get("error").and_then(Value::as_str) {
            return Some(Err(error.to_owned()));
        }
        Some(Ok(scripted
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_owned)))
    }

    fn file_saved(&self, view: ViewId, path: &str) {
        self.log(json!(["diagram.fileSaved", view.0, path]));
    }

    fn recovery_title(&self, view: ViewId) -> Option<String> {
        self.log(json!(["diagram.recoveryTitle", view.0]));
        self.answer("recoveryTitle").as_str().map(str::to_owned)
    }

    fn help(&self, view: ViewId) {
        self.log(json!(["diagram.help", view.0]));
    }

    fn open_failed(&self, view: ViewId, message: &str) -> bool {
        self.log(json!(["diagram.openFailed", view.0, message]));
        self.answer("openFailed").as_bool().unwrap_or(false)
    }

    fn provisional_title(&self, view: ViewId, title: &str) {
        self.log(json!(["diagram.provisionalTitle", view.0, title]));
    }

    fn is_path_open_elsewhere(&self, path: &str) -> bool {
        self.log(json!(["electronUtils.isPathOpenElsewhere", path]));
        self.answer("openElsewhere")
            .as_array()
            .is_some_and(|paths| paths.iter().any(|p| p.as_str() == Some(path)))
    }

    fn assert_file_saved(&self, path: &str) -> Result<(), String> {
        self.log(json!(["electronUtils.assertFileSaved", path]));
        match self.text("unsaved", &name_of(path)) {
            Some(message) => Err(message.to_owned()),
            None => Ok(()),
        }
    }

    fn is_headless(&self) -> bool {
        self.answer("headless").as_bool().unwrap_or(false)
    }

    fn save_token(&self) -> String {
        format!("{:032x}", self.tokens.fetch_add(1, Ordering::Relaxed) + 1)
    }

    fn render_pdf(&self, pages: &[PrintPage], title: &str) -> Result<Vec<u8>, String> {
        self.log(json!([
            "diagram.renderPdf",
            main_core::diagram::print_document::build_print_html(pages, title)
        ]));
        Ok(match self.answer("pdf").as_str() {
            Some(hex) => (0..hex.len() / 2)
                .filter_map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok())
                .collect(),
            None => b"%PDF-fake".to_vec(),
        })
    }
}
