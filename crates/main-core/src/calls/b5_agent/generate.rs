//! The functions of part `generate` of group `b5-agent`
//! (tools/main-diff/groups/b5-agent-generate.ts): the generate window, its
//! session, the materials, the request checks and the conversions without AI
//! (`apps/shell/src/main/generate`), with the runtime parts of
//! `shared/generate-api.ts` and `generate-default-prompts.ts` and
//! `packages/file-parse/src/attachable.ts`.
//!
//! A function that drives a fake is a scenario: the first argument holds what
//! the fakes answer and a list of `steps`, and the answer has one entry per
//! step. Each call of a fake is one `logs` line, written as the spec's
//! TypeScript fakes write it. The engines of the conversions are one scripted
//! [`Scripted`] value that follows the case's `engine`.

use std::cell::RefCell;
use std::fs;
use std::rc::Rc;
use std::time::{Duration, UNIX_EPOCH};

use jscompat::number_to_string;
use serde_json::{Map, Value, json};

use super::super::{Answer, Context, arg, str_arg};
use crate::packages::electron_utils::generate_handoff::{
    GenerateHandoffTarget, HandoffStore, HandoffWebContents,
};
use crate::packages::electron_utils::unsaved_files::{
    OpenFileState, OpenFilesHolder, OpenFilesSourceFailed, file_has_unsaved_changes,
};
use crate::packages::file_parse::attachable::{
    ATTACHABLE_IMAGE_EXTS, ATTACHABLE_IMAGE_MAX_BYTES, ATTACHABLE_MAX_BYTES, attachable_exts,
    attachable_max_bytes, is_attachable_ext,
};
use crate::packages::i18n::Lang;
use crate::shell::app_routing::DocumentTabKind;
use crate::shell::generate::convert::{
    ConvertEngines, ConvertedContent, ConvertedDocument, NoticeCache, NoticeHost, OpOutcome,
    XmindTopic, build_deck, convert_source, map_outline_to_slides, map_outline_to_slides_markdown,
    markdown_redaction_notice,
};
use crate::shell::generate::converted_tab::{SeedTargets, queue_converted_content};
use crate::shell::generate::generate_api::{
    AI_TARGET_KINDS, AiTargetKind, CONVERT_KINDS, ConvertKind, ConvertProblem, GenerateWindowState,
    MaterialProblem, SaveAction, ai_target_str, channels, convert_kind_str, convert_target,
    convert_target_str, default_generate_prompt, parse_convert_kind,
};
use crate::shell::generate::generate_window::{
    GenerateText, GenerateWindow, GenerateWindowHost, GenerateWindowOptions, IPC_HANDLE_CHANNELS,
    NewDocumentOpener, OpenDialogResult, OpenInit, WindowId,
};
use crate::shell::generate::limits::{
    LONG_MATERIAL_NOTICE_CHARS, MAX_IMAGE_MATERIAL_BYTES, MAX_MATERIAL_BYTES, MAX_MATERIALS,
    MAX_REQUEST_TEXT_CHARS, USAGE_NOTICE_CHARS,
};
use crate::shell::generate::materials::{
    FileParser, FileStat, IMAGE_MATERIAL_EXTS, InspectHost, MaterialLengthCache, MaterialStatus,
    ParsedFile, ext_of, generate_notices, inspect_material, material_key, material_max_bytes,
    summarize_materials, supported_material_exts, untitled_material,
};
use crate::shell::generate::open_materials::{
    MaterialContents, OpenDocumentTab, OpenMaterialsDeps, SaveOutcome, create_open_materials,
};
use crate::shell::generate::request::{
    available_conversions, is_ai_target_kind, is_convert_kind, prepare_generate_request,
    validate_generate_request,
};
use crate::shell::generate::session::{GenerateSession, GenerateSessionHost, MaterialRef};
use crate::shell::generate::title_bar::{GENERATE_TITLE_BAR_HEIGHT, generate_title_bar_overlay};
use crate::shell::renderer_disposal::Failure;
use crate::shell::title_bar_overlay::TitleBarOverlay;

type Log = Rc<RefCell<Vec<Vec<Value>>>>;

fn new_log() -> Log {
    Rc::new(RefCell::new(Vec::new()))
}

fn log_line(log: &Log, line: Vec<Value>) {
    log.borrow_mut().push(line);
}

fn text(x: &str) -> Value {
    Value::from(x)
}

fn num(x: f64) -> Value {
    Value::from(x)
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

fn field_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn field_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn field_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn list(value: Option<&Value>) -> &[Value] {
    match value.and_then(Value::as_array) {
        Some(items) => items.as_slice(),
        None => &[],
    }
}

fn error_value(message: &str) -> Value {
    let mut out = Map::new();
    out.insert("error".to_owned(), Value::from(message));
    Value::Object(out)
}

/// a table entry by the path, or by the file name when the case's folder is not known
fn by_path<'a>(table: Option<&'a Value>, path: &str) -> Option<&'a Value> {
    let table = table?;
    table
        .get(path)
        .or_else(|| table.get(path.rsplit('/').next().unwrap_or(path)))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[i * 2..i * 2 + 2], 16).ok())
        .collect()
}

/// a step's argument: `{"$undefined": true}` is `undefined`
fn step_arg(value: &Value) -> Option<&Value> {
    if value.get("$undefined").is_some() {
        None
    } else {
        Some(value)
    }
}

fn lang_of(scenario: &Value) -> Lang {
    match field_str(scenario, "lang") {
        Some("ko") => Lang::Ko,
        _ => Lang::En,
    }
}

fn kind_of(value: &str) -> Option<ConvertKind> {
    parse_convert_kind(value)
}

fn problem_of(value: &str) -> Option<MaterialProblem> {
    match value {
        "missing" => Some(MaterialProblem::Missing),
        "unsupported" => Some(MaterialProblem::Unsupported),
        "too-large" => Some(MaterialProblem::TooLarge),
        "unreadable" => Some(MaterialProblem::Unreadable),
        "untitled" => Some(MaterialProblem::Untitled),
        _ => None,
    }
}

fn convert_problem_of(value: &str) -> ConvertProblem {
    match value {
        "unreadable" => ConvertProblem::Unreadable,
        "redaction" => ConvertProblem::Redaction,
        "too-many-slides" => ConvertProblem::TooManySlides,
        _ => ConvertProblem::Failed,
    }
}

fn tab_kind_of(value: &str) -> DocumentTabKind {
    match value {
        "docs" => DocumentTabKind::Docs,
        "sheets" => DocumentTabKind::Sheets,
        "slides" => DocumentTabKind::Slides,
        "pdf" => DocumentTabKind::Pdf,
        "markdown" => DocumentTabKind::Markdown,
        "html" => DocumentTabKind::Html,
        "mindmap" => DocumentTabKind::Mindmap,
        "hwp" => DocumentTabKind::Hwp,
        "epub" => DocumentTabKind::Epub,
        _ => DocumentTabKind::Diagram,
    }
}

/// a material status as the spec writes it
fn status_of(value: &Value) -> MaterialStatus {
    MaterialStatus {
        key: field_str(value, "key").unwrap_or_default().to_owned(),
        name: field_str(value, "name").unwrap_or_default().to_owned(),
        path: field_str(value, "path").map(str::to_owned),
        ext: field_str(value, "ext").unwrap_or_default().to_owned(),
        size_bytes: field_f64(value, "sizeBytes"),
        problem: field_str(value, "problem").and_then(problem_of),
        unsaved: field_bool(value, "unsaved"),
        text_length: field_f64(value, "textLength").unwrap_or(0.0),
    }
}

fn ai_kind_of(value: Option<&Value>) -> Option<AiTargetKind> {
    value
        .and_then(Value::as_str)
        .and_then(GenerateHandoffTarget::parse)
}

fn refs_of(value: Option<&Value>) -> Vec<MaterialRef> {
    list(value)
        .iter()
        .map(|r| match r.get("untitled") {
            Some(untitled) => MaterialRef::Untitled {
                web_contents_id: field_f64(untitled, "webContentsId").unwrap_or(f64::NAN),
                title: field_str(untitled, "title").unwrap_or_default().to_owned(),
            },
            None => MaterialRef::Path(field_str(r, "path").unwrap_or_default().to_owned()),
        })
        .collect()
}

fn write_file(path: &str, content: &str, mtime_ms: Option<f64>) {
    if let Some(parent) = std::path::Path::new(path).parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(path, content).expect("the case writes its file");
    if let Some(ms) = mtime_ms {
        let at = UNIX_EPOCH + Duration::from_secs_f64(ms / 1000.0);
        let file = fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("the case opens its file");
        file.set_modified(at).expect("the case sets the mtime");
    }
}

/// `stat` of the disk, as the real `stat` answers it
fn real_stat(path: &str) -> Result<FileStat, Failure> {
    let meta = fs::metadata(path).map_err(|e| Failure(e.to_string()))?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0);
    Ok(FileStat {
        is_file: meta.is_file(),
        size: meta.len() as f64,
        mtime_ms,
    })
}

fn scripted_stat(table: &Value, path: &str, log: &Log) -> Result<FileStat, Failure> {
    log_line(log, vec![text("stat"), text(path)]);
    match by_path(Some(table), path) {
        Some(entry) if entry.get("throws").is_none() => Ok(FileStat {
            is_file: entry.get("isFile").and_then(Value::as_bool).unwrap_or(true),
            size: field_f64(entry, "size").unwrap_or(0.0),
            mtime_ms: field_f64(entry, "mtimeMs"),
        }),
        _ => Err(Failure("stat failed".to_owned())),
    }
}

// ---------------------------------------------------------------------------
// the engines: one value that follows the case's `engine`
// ---------------------------------------------------------------------------

struct Scripted {
    engine: Value,
    log: Log,
}

impl Scripted {
    fn new(engine: Option<&Value>, log: &Log) -> Self {
        Scripted {
            engine: engine.cloned().unwrap_or(Value::Null),
            log: Rc::clone(log),
        }
    }
}

impl FileParser for Scripted {
    fn parse_file_to_text(&mut self, path: &str) -> Result<ParsedFile, Failure> {
        log_line(&self.log, vec![text("parse"), text(path)]);
        match by_path(self.engine.get("parse"), path) {
            Some(spec) if spec.get("throws").is_none() => Ok(ParsedFile {
                ok: field_bool(spec, "ok"),
                error: field_str(spec, "error").map(str::to_owned),
                kind: field_str(spec, "kind").map(str::to_owned),
                text: field_str(spec, "text").map(str::to_owned),
            }),
            _ => Err(Failure("parse failed".to_owned())),
        }
    }
}

fn topic_of(value: &Value) -> XmindTopic {
    XmindTopic {
        title: field_str(value, "title").map(str::to_owned),
        attached: value
            .get("children")
            .and_then(|c| c.get("attached"))
            .and_then(Value::as_array)
            .map(|items| items.iter().map(topic_of).collect())
            .unwrap_or_default(),
    }
}

impl ConvertEngines for Scripted {
    type Slides = usize;
    type Op = String;
    type Deck = usize;

    fn not_topic_marks(&self) -> [String; 2] {
        ["(boundary)".to_owned(), "(relationship)".to_owned()]
    }

    fn first_sheet_root(&mut self, outline: &str, untitled: &str) -> Result<XmindTopic, Failure> {
        log_line(
            &self.log,
            vec![text("outlineToSheets"), text(outline), text(untitled)],
        );
        match self.engine.get("root") {
            Some(root) if root.get("throws").is_some() => Err(Failure("outline failed".to_owned())),
            Some(root) => Ok(topic_of(root)),
            None => Err(Failure(
                "Cannot read properties of undefined (reading 'rootTopic')".to_owned(),
            )),
        }
    }

    fn create_xmind_document_from_outline(
        &mut self,
        text_in: &str,
        untitled: &str,
    ) -> Result<(), Failure> {
        log_line(
            &self.log,
            vec![text("createXmind"), text(text_in), text(untitled)],
        );
        if field_bool(&self.engine, "createThrows") {
            Err(Failure("create failed".to_owned()))
        } else {
            Ok(())
        }
    }

    fn parse_markdown_outline(&mut self, markdown: &str) -> Result<usize, Failure> {
        log_line(&self.log, vec![text("parsePptxOutline"), text(markdown)]);
        let spec = self.engine.get("slides");
        if spec.is_some_and(|s| s.get("throws").is_some_and(|t| t != &Value::Bool(false))) {
            return Err(Failure("outline parse failed".to_owned()));
        }
        Ok(spec.and_then(|s| field_f64(s, "count")).unwrap_or(1.0) as usize)
    }

    fn slide_count(&self, slides: &usize) -> usize {
        *slides
    }

    fn max_outline_slides(&self) -> usize {
        3
    }

    fn outline_to_ops(&mut self, slides: &usize) -> Result<Vec<String>, Failure> {
        log_line(&self.log, vec![text("outlineToOps"), num(*slides as f64)]);
        Ok((0..*slides).map(|i| format!("op{i}")).collect())
    }

    fn open_blank_deck(&mut self) -> Result<usize, Failure> {
        log_line(&self.log, vec![text("openPptx")]);
        if field_bool(&self.engine, "blankThrows") {
            Err(Failure("blank failed".to_owned()))
        } else {
            Ok(0)
        }
    }

    fn apply_op(&mut self, deck: &mut usize, op: &String) -> Result<OpOutcome, Failure> {
        log_line(&self.log, vec![text("runTxn"), text(op)]);
        match self.engine.get("txn").and_then(|t| t.get(op.as_str())) {
            Some(spec) if spec.get("throws").is_some() => Err(Failure("txn failed".to_owned())),
            Some(spec) => Ok(OpOutcome {
                applied: field_bool(spec, "applied"),
                first_failure_error: list(spec.get("failures"))
                    .first()
                    .and_then(|f| field_str(f, "error"))
                    .map(str::to_owned),
            }),
            None => {
                *deck += 1;
                Ok(OpOutcome {
                    applied: true,
                    first_failure_error: None,
                })
            }
        }
    }

    fn op_name(&self, op: &String) -> String {
        op.clone()
    }

    fn save_deck(&mut self, deck: usize) -> Result<Vec<u8>, Failure> {
        Ok(vec![0xde, 0xc0, deck as u8])
    }
}

/// what a conversion's content looks like in the answer
fn content_view(content: &ConvertedContent) -> Value {
    let mut out = Map::new();
    out.insert("kind".to_owned(), text(convert_kind_str(content.kind())));
    out.insert(
        "target".to_owned(),
        text(convert_target_str(content.target())),
    );
    match content {
        ConvertedContent::MindmapToMarkdown { markdown } => {
            out.insert("markdown".to_owned(), text(markdown));
        }
        ConvertedContent::MindmapToSlides { deck, slide_count } => {
            out.insert("deck".to_owned(), Value::from(hex(deck)));
            out.insert("slideCount".to_owned(), num(*slide_count as f64));
        }
        ConvertedContent::MarkdownToMindmap { outline } => {
            out.insert("outline".to_owned(), text(outline));
        }
    }
    Value::Object(out)
}

/// the content of a scenario's `doc`
fn content_of(spec: &Value) -> ConvertedContent {
    let str_of = |key: &str| field_str(spec, key).unwrap_or_default().to_owned();
    match kind_of(field_str(spec, "kind").unwrap_or_default()) {
        Some(ConvertKind::MindmapToSlides) => ConvertedContent::MindmapToSlides {
            deck: unhex(field_str(spec, "deckHex").unwrap_or_default()),
            slide_count: field_f64(spec, "slideCount").unwrap_or(f64::NAN) as usize,
        },
        Some(ConvertKind::MarkdownToMindmap) => ConvertedContent::MarkdownToMindmap {
            outline: str_of("outline"),
        },
        _ => ConvertedContent::MindmapToMarkdown {
            markdown: str_of("markdown"),
        },
    }
}

fn doc_view(doc: &ConvertedDocument) -> Value {
    let mut out = Map::new();
    out.insert("id".to_owned(), text(&doc.id));
    out.insert("content".to_owned(), content_view(&doc.content));
    out.insert("sources".to_owned(), to_value(&doc.sources));
    out.insert("createdAt".to_owned(), num(doc.created_at));
    Value::Object(out)
}

// ---------------------------------------------------------------------------
// inspectMaterial, markdownRedactionNotice
// ---------------------------------------------------------------------------

/// the reads of `inspectMaterial` the scenario describes
struct InspectFake<'a> {
    scenario: &'a Value,
    engine: &'a mut Scripted,
    log: &'a Log,
}

impl InspectHost for InspectFake<'_> {
    fn stat(&mut self, path: &str) -> Result<FileStat, Failure> {
        match self.scenario.get("stat") {
            Some(table) => scripted_stat(table, path, self.log),
            None => real_stat(path),
        }
    }

    fn parse(&mut self, path: &str) -> Result<ParsedFile, Failure> {
        self.engine.parse_file_to_text(path)
    }

    fn injected_parse(&self) -> bool {
        field_bool(self.scenario, "injectParse")
    }

    fn has_unsaved_changes(&mut self, path: &str) -> Result<bool, Failure> {
        log_line(self.log, vec![text("unsaved"), text(path)]);
        match by_path(self.scenario.get("unsaved"), path) {
            Some(Value::String(_)) => Err(Failure("unsaved failed".to_owned())),
            Some(Value::Bool(answer)) => Ok(*answer),
            _ => Ok(false),
        }
    }
}

fn inspect_call(args: &[Value], cx: &mut Context) -> Answer {
    let scenario = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut engine = Scripted::new(scenario.get("engine"), &log);
    let mut cache = MaterialLengthCache::new();
    let mut results: Vec<Value> = Vec::new();
    for step in list(scenario.get("steps")) {
        if let Some(write) = step.get("write") {
            write_file(
                field_str(write, "path").unwrap_or_default(),
                field_str(write, "text").unwrap_or_default(),
                field_f64(write, "mtimeMs"),
            );
            continue;
        }
        let path = field_str(step, "inspect").unwrap_or_default();
        let mut host = InspectFake {
            scenario: &scenario,
            engine: &mut engine,
            log: &log,
        };
        results.push(match inspect_material(&mut host, &mut cache, path) {
            Ok(status) => status.to_value(),
            Err(Failure(message)) => error_value(&message),
        });
    }
    cx.logs.extend(log.take());
    Ok(Some(Value::Array(results)))
}

/// the reads of `markdownRedactionNotice` the scenario describes
struct NoticeFake<'a> {
    scenario: &'a Value,
    engine: &'a mut Scripted,
    log: &'a Log,
}

impl FileParser for NoticeFake<'_> {
    fn parse_file_to_text(&mut self, path: &str) -> Result<ParsedFile, Failure> {
        self.engine.parse_file_to_text(path)
    }
}

impl NoticeHost for NoticeFake<'_> {
    fn stat(&mut self, path: &str) -> Result<FileStat, Failure> {
        match self.scenario.get("stat") {
            Some(table) => scripted_stat(table, path, self.log),
            None => real_stat(path),
        }
    }

    fn read_bytes(&mut self, path: &str) -> Result<Vec<u8>, Failure> {
        match self.scenario.get("readBytes") {
            Some(table) => {
                log_line(self.log, vec![text("readBytes"), text(path)]);
                match by_path(Some(table), path).and_then(Value::as_str) {
                    Some(bytes) => Ok(unhex(bytes)),
                    None => Err(Failure("read failed".to_owned())),
                }
            }
            None => fs::read(path).map_err(|e| Failure(e.to_string())),
        }
    }

    fn injected_reader(&self) -> bool {
        field_bool(self.scenario, "injectParse") || self.scenario.get("readBytes").is_some()
    }
}

fn notice_call(args: &[Value], cx: &mut Context) -> Answer {
    let scenario = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut engine = Scripted::new(scenario.get("engine"), &log);
    let mut cache = NoticeCache::new();
    let mut results: Vec<Value> = Vec::new();
    for step in list(scenario.get("steps")) {
        if let Some(write) = step.get("write") {
            write_file(
                field_str(write, "path").unwrap_or_default(),
                field_str(write, "text").unwrap_or_default(),
                field_f64(write, "mtimeMs"),
            );
            continue;
        }
        let mut host = NoticeFake {
            scenario: &scenario,
            engine: &mut engine,
            log: &log,
        };
        let path = field_str(step, "notice").unwrap_or_default();
        results.push(Value::Bool(markdown_redaction_notice(
            &mut host, &mut cache, path,
        )));
    }
    cx.logs.extend(log.take());
    Ok(Some(Value::Array(results)))
}

// ---------------------------------------------------------------------------
// prepareGenerateRequest
// ---------------------------------------------------------------------------

fn prepare_call(args: &[Value], cx: &mut Context) -> Answer {
    let raw = arg(args, 0).cloned().unwrap_or(Value::Null);
    let scenario = arg(args, 1).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut inspect = |path: &str| -> Result<MaterialStatus, Failure> {
        log_line(&log, vec![text("inspect"), text(path)]);
        match scenario.get("inspect").and_then(|t| t.get(path)) {
            Some(status) if status.get("throws").is_none() => Ok(status_of(status)),
            _ => Err(Failure(format!("inspect failed: {path}"))),
        }
    };
    let answer = match prepare_generate_request(&raw, &mut inspect) {
        Ok(prepared) => prepared.to_value(),
        Err(Failure(message)) => error_value(&message),
    };
    cx.logs.extend(log.take());
    Ok(Some(answer))
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

fn convert_call(args: &[Value], cx: &mut Context) -> Answer {
    let scenario = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut engine = Scripted::new(scenario.get("engine"), &log);
    let mut results: Vec<Value> = Vec::new();
    for step in list(scenario.get("steps")) {
        if let Some(request) = step.get("convert") {
            let kind = kind_of(field_str(request, "kind").unwrap_or_default())
                .unwrap_or(ConvertKind::MindmapToMarkdown);
            let path = field_str(request, "path").unwrap_or_default();
            let untitled = field_str(request, "untitled").unwrap_or_default();
            results.push(match convert_source(&mut engine, kind, path, untitled) {
                Ok(content) => json!({"ok": true, "content": content_view(&content)}),
                Err(problem) => json!({"ok": false, "problem": to_value(&problem)}),
            });
        } else if let Some(request) = step.get("markdown") {
            let outline = field_str(request, "outline").unwrap_or_default();
            let untitled = field_str(request, "untitled").unwrap_or_default();
            results.push(
                match map_outline_to_slides_markdown(&mut engine, outline, untitled) {
                    Ok(markdown) => Value::from(markdown),
                    Err(Failure(message)) => error_value(&message),
                },
            );
        } else if let Some(request) = step.get("slides") {
            let outline = field_str(request, "outline").unwrap_or_default();
            let untitled = field_str(request, "untitled").unwrap_or_default();
            results.push(
                match map_outline_to_slides(&mut engine, outline, untitled) {
                    Ok(count) => {
                        Value::Array((0..count).map(|i| Value::from(format!("s{i}"))).collect())
                    }
                    Err(Failure(message)) => error_value(&message),
                },
            );
        } else {
            let ops: Vec<String> = list(step.get("build"))
                .iter()
                .filter_map(|op| op.as_str().map(str::to_owned))
                .collect();
            results.push(match build_deck(&mut engine, &ops) {
                Ok(deck) => Value::from(hex(&deck)),
                Err(Failure(message)) => error_value(&message),
            });
        }
    }
    cx.logs.extend(log.take());
    Ok(Some(Value::Array(results)))
}

// ---------------------------------------------------------------------------
// queueConvertedContent
// ---------------------------------------------------------------------------

struct TabContents {
    id: f64,
    destroyed: bool,
    log: Log,
}

impl HandoffWebContents for TabContents {
    fn id(&self) -> f64 {
        self.id
    }

    fn is_destroyed(&self) -> bool {
        self.destroyed
    }

    fn once_destroyed(&mut self) {
        log_line(&self.log, vec![text("once"), text("destroyed")]);
    }
}

/// the markdown and mind map queues, which the module of those editors holds
#[derive(Default)]
struct Seeds {
    markdown: Vec<(f64, String)>,
    mindmap: Vec<(f64, String)>,
}

impl SeedTargets for Seeds {
    fn queue_markdown_seed_for(&mut self, contents: &mut dyn HandoffWebContents, seed: &str) {
        if contents.is_destroyed() {
            return;
        }
        let id = contents.id();
        self.markdown.retain(|(k, _)| *k != id);
        self.markdown.push((id, seed.to_owned()));
        contents.once_destroyed();
    }

    fn queue_mindmap_seed_for(&mut self, contents: &mut dyn HandoffWebContents, outline: &str) {
        if contents.is_destroyed() {
            return;
        }
        let id = contents.id();
        self.mindmap.retain(|(k, _)| *k != id);
        self.mindmap.push((id, outline.to_owned()));
        contents.once_destroyed();
    }
}

fn converted_tab_call(args: &[Value], cx: &mut Context) -> Answer {
    let scenario = arg(args, 0).cloned().unwrap_or(Value::Null);
    let id = field_f64(&scenario, "webContentsId").unwrap_or(f64::NAN);
    let spec = scenario.get("doc").cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut contents = TabContents {
        id,
        destroyed: field_bool(&scenario, "destroyed"),
        log: Rc::clone(&log),
    };
    let mut store = HandoffStore::new(cfg!(windows));
    let resolver = field_str(&scenario, "resolver")
        .unwrap_or("none")
        .to_owned();
    if resolver != "none" {
        store.set_generate_tab_id_resolver(Some(Box::new(move |wc| match resolver.as_str() {
            "throws" => Err("no tab".to_owned()),
            "empty" => Ok(Some(String::new())),
            _ => Ok(Some(format!("tab-{}", number_to_string(wc)))),
        })));
    }
    let doc = ConvertedDocument {
        id: field_str(&spec, "id").unwrap_or_default().to_owned(),
        content: content_of(&spec),
        sources: list(spec.get("sources"))
            .iter()
            .filter_map(|s| s.as_str().map(str::to_owned))
            .collect(),
        created_at: field_f64(&spec, "createdAt").unwrap_or(f64::NAN),
    };
    let mut seeds = Seeds::default();
    let mut slides = crate::slides::seed_queue::SeedQueue::new();
    let mut answer = Map::new();
    if let Err(message) = queue_converted_content(
        &mut contents,
        &doc,
        &mut seeds,
        &mut slides,
        &mut store,
        cx.now_ms,
    ) {
        answer.insert("error".to_owned(), Value::from(message));
    }
    answer.insert(
        "markdown".to_owned(),
        seeds
            .markdown
            .iter()
            .find(|(k, _)| *k == id)
            .map_or(Value::Null, |(_, t)| Value::from(t.as_str())),
    );
    answer.insert(
        "mindmap".to_owned(),
        seeds
            .mindmap
            .iter()
            .find(|(k, _)| *k == id)
            .map_or(Value::Null, |(_, t)| json!({"outline": t})),
    );
    answer.insert(
        "slides".to_owned(),
        slides
            .take_slides_seed(id)
            .map_or(Value::Null, |deck| Value::from(hex(&deck))),
    );
    let events: Vec<Value> = store
        .generate_converted_events()
        .iter()
        .filter(|e| e.web_contents_id == id)
        .map(to_value)
        .collect();
    answer.insert("events".to_owned(), Value::Array(events));
    cx.logs.extend(log.take());
    Ok(Some(Value::Object(answer)))
}

// ---------------------------------------------------------------------------
// open-materials
// ---------------------------------------------------------------------------

struct FakeContents {
    id: f64,
    destroyed: bool,
}

impl MaterialContents for FakeContents {
    fn id(&self) -> f64 {
        self.id
    }

    fn is_destroyed(&self) -> bool {
        self.destroyed
    }
}

/// the tabs of a scenario
struct OpenFake {
    scenario: Value,
    log: Log,
}

impl OpenMaterialsDeps for OpenFake {
    type Contents = FakeContents;

    fn list(&mut self) -> Result<Vec<OpenDocumentTab>, Failure> {
        log_line(&self.log, vec![text("list")]);
        if field_bool(&self.scenario, "listThrows") {
            return Err(Failure("list failed".to_owned()));
        }
        Ok(list(self.scenario.get("tabs"))
            .iter()
            .map(|t| OpenDocumentTab {
                id: field_str(t, "id").unwrap_or_default().to_owned(),
                kind: tab_kind_of(field_str(t, "kind").unwrap_or_default()),
                title: field_str(t, "title").unwrap_or_default().to_owned(),
                file_path: field_str(t, "filePath").map(str::to_owned),
                active: field_bool(t, "active"),
                dirty: field_bool(t, "dirty"),
            })
            .collect())
    }

    fn web_contents_for(&mut self, tab_id: &str) -> Option<FakeContents> {
        log_line(&self.log, vec![text("webContentsFor"), text(tab_id)]);
        let spec = self.scenario.get("contents")?.get(tab_id)?;
        Some(FakeContents {
            id: field_f64(spec, "id").unwrap_or(f64::NAN),
            destroyed: field_bool(spec, "destroyed"),
        })
    }

    fn reveal(&mut self, tab_id: &str) {
        log_line(&self.log, vec![text("reveal"), text(tab_id)]);
    }

    fn has_save(&self, kind: DocumentTabKind) -> bool {
        list(self.scenario.get("save"))
            .iter()
            .any(|k| k.as_str() == Some(kind.as_str()))
    }

    fn save_to_path(
        &mut self,
        kind: DocumentTabKind,
        web_contents_id: f64,
        path: &str,
    ) -> Result<(), Failure> {
        log_line(
            &self.log,
            vec![
                text("save"),
                text(kind.as_str()),
                num(web_contents_id),
                text(path),
            ],
        );
        self.save_result(kind).map(|_| ())
    }

    fn save_editor(
        &mut self,
        kind: DocumentTabKind,
        _contents: &FakeContents,
    ) -> Result<bool, Failure> {
        log_line(
            &self.log,
            vec![text("save"), text(kind.as_str()), text("contents")],
        );
        self.save_result(kind)
    }

    fn warn_save_failed(&mut self, error: &Failure) {
        log_line(
            &self.log,
            vec![
                text("warn"),
                text("[generate] saving a material failed:"),
                text(&error.0),
            ],
        );
    }
}

impl OpenFake {
    /// `saveResult[kind]`: false, 'throws', or true by default
    fn save_result(&self, kind: DocumentTabKind) -> Result<bool, Failure> {
        match self
            .scenario
            .get("saveResult")
            .and_then(|t| t.get(kind.as_str()))
        {
            Some(Value::String(_)) => Err(Failure(format!("{} save failed", kind.as_str()))),
            Some(Value::Bool(false)) => Ok(false),
            _ => Ok(true),
        }
    }
}

fn open_call(args: &[Value], cx: &mut Context) -> Answer {
    let scenario = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut deps = OpenFake {
        scenario: scenario.clone(),
        log: Rc::clone(&log),
    };
    let mut results: Vec<Value> = Vec::new();
    for step in list(scenario.get("steps")) {
        let mut open = create_open_materials(&mut deps);
        results.push(if let Some(path) = field_str(step, "saveActionFor") {
            match open.save_action_for(path) {
                Ok(SaveAction::Save) => text("save"),
                Ok(SaveAction::Show) => text("show"),
                Err(Failure(message)) => error_value(&message),
            }
        } else if let Some(path) = field_str(step, "saveMaterial") {
            match open.save_material(path) {
                Ok(outcome) => text(outcome.as_str()),
                Err(Failure(message)) => error_value(&message),
            }
        } else if let Some(id) = field_f64(step, "pathOfUntitled") {
            match open.path_of_untitled(id) {
                Ok(path) => path.map_or(Value::Null, Value::from),
                Err(Failure(message)) => error_value(&message),
            }
        } else {
            let id = field_f64(step, "showUntitled").unwrap_or(f64::NAN);
            match open.show_untitled(id) {
                Ok(()) => Value::Null,
                Err(Failure(message)) => error_value(&message),
            }
        });
    }
    cx.logs.extend(log.take());
    Ok(Some(Value::Array(results)))
}

// ---------------------------------------------------------------------------
// GenerateSession
// ---------------------------------------------------------------------------

struct SessionFake {
    scenario: Value,
    log: Log,
    counts: Vec<(String, usize)>,
    ids: Vec<String>,
}

impl SessionFake {
    /// the answer of the next call for `key`: the last one repeats
    fn nth(&mut self, table: &str, name: &str, key: &str) -> Option<Value> {
        let items = self.scenario.get(table)?.get(key)?.as_array()?.clone();
        if items.is_empty() {
            return None;
        }
        let at = format!("{name}:{key}");
        let seen = match self.counts.iter_mut().find(|(k, _)| *k == at) {
            Some(entry) => {
                entry.1 += 1;
                entry.1 - 1
            }
            None => {
                self.counts.push((at, 1));
                0
            }
        };
        Some(items[seen.min(items.len() - 1)].clone())
    }
}

impl GenerateSessionHost for SessionFake {
    fn lang(&self) -> Lang {
        lang_of(&self.scenario)
    }

    fn inspect(&mut self, path: &str) -> Result<MaterialStatus, Failure> {
        log_line(&self.log, vec![text("inspect"), text(path)]);
        match self.nth("inspect", "inspect", path) {
            Some(status) if status.get("throws").is_none() => Ok(status_of(&status)),
            _ => Err(Failure(format!("inspect failed: {path}"))),
        }
    }

    fn path_of_untitled(&mut self, web_contents_id: f64) -> Result<Option<String>, Failure> {
        log_line(
            &self.log,
            vec![text("pathOfUntitled"), num(web_contents_id)],
        );
        let key = number_to_string(web_contents_id);
        match self.nth("pathOfUntitled", "untitled", &key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(path)) => Ok(Some(path)),
            Some(_) => Err(Failure("pathOfUntitled failed".to_owned())),
        }
    }

    fn save_action_for(&mut self, path: &str) -> Result<SaveAction, Failure> {
        log_line(&self.log, vec![text("saveActionFor"), text(path)]);
        match self
            .scenario
            .get("saveActionFor")
            .and_then(|t| t.get(path))
            .and_then(Value::as_str)
        {
            Some("throws") => Err(Failure("saveActionFor failed".to_owned())),
            Some("save") => Ok(SaveAction::Save),
            _ => Ok(SaveAction::Show),
        }
    }

    fn save_material(&mut self, path: &str) -> Result<SaveOutcome, Failure> {
        log_line(&self.log, vec![text("saveMaterial"), text(path)]);
        match self
            .scenario
            .get("saveMaterial")
            .and_then(|t| t.get(path))
            .and_then(Value::as_str)
        {
            Some("throws") => Err(Failure("saveMaterial failed".to_owned())),
            Some("shown") => Ok(SaveOutcome::Shown),
            Some("failed") => Ok(SaveOutcome::Failed),
            _ => Ok(SaveOutcome::Saved),
        }
    }

    fn show_untitled(&mut self, web_contents_id: f64) -> Result<(), Failure> {
        log_line(&self.log, vec![text("showUntitled"), num(web_contents_id)]);
        if field_bool(&self.scenario, "showUntitledThrows") {
            Err(Failure("showUntitled failed".to_owned()))
        } else {
            Ok(())
        }
    }

    fn open_target_tab(
        &mut self,
        handoff: &crate::packages::electron_utils::generate_handoff::GenerateHandoff,
    ) -> Result<(), Failure> {
        log_line(&self.log, vec![text("openTargetTab"), to_value(handoff)]);
        if field_str(&self.scenario, "openTarget") == Some("throws") {
            Err(Failure("no tab could open".to_owned()))
        } else {
            Ok(())
        }
    }

    fn can_convert(&self) -> bool {
        field_bool(&self.scenario, "canConvert")
    }

    fn convert(
        &mut self,
        kind: ConvertKind,
        path: &str,
    ) -> Result<crate::shell::generate::convert::ConvertResult, Failure> {
        log_line(
            &self.log,
            vec![text("convert"), text(convert_kind_str(kind)), text(path)],
        );
        let Some(answer) = self.scenario.get("convert").and_then(|t| t.get(path)) else {
            return Err(Failure("convert failed".to_owned()));
        };
        if answer.get("throws").is_some() {
            return Err(Failure("convert failed".to_owned()));
        }
        if field_bool(answer, "ok") {
            let doc = answer.get("content").cloned().unwrap_or(Value::Null);
            Ok(Ok(content_of(&doc)))
        } else {
            Ok(Err(convert_problem_of(
                field_str(answer, "problem").unwrap_or_default(),
            )))
        }
    }

    fn open_converted_tab(&mut self, doc: &ConvertedDocument) -> Result<(), Failure> {
        log_line(&self.log, vec![text("openConvertedTab"), doc_view(doc)]);
        if field_str(&self.scenario, "openConverted") == Some("throws") {
            Err(Failure("no tab could open".to_owned()))
        } else {
            Ok(())
        }
    }

    fn has_redaction_notice(&self) -> bool {
        field_bool(&self.scenario, "hasNotice")
    }

    fn redaction_notice(&mut self, path: &str) -> Result<bool, Failure> {
        log_line(&self.log, vec![text("redactionNotice"), text(path)]);
        match self.scenario.get("notice").and_then(|t| t.get(path)) {
            Some(Value::String(_)) => Err(Failure("notice failed".to_owned())),
            Some(Value::Bool(answer)) => Ok(*answer),
            _ => Ok(false),
        }
    }

    fn push(&mut self, state: &GenerateWindowState) {
        log_line(&self.log, vec![text("push"), to_value(state)]);
    }

    fn close(&mut self) {
        log_line(&self.log, vec![text("close")]);
    }

    fn new_id(&mut self) -> String {
        if self.ids.is_empty() {
            "id".to_owned()
        } else {
            self.ids.remove(0)
        }
    }

    fn now(&mut self) -> f64 {
        field_f64(&self.scenario, "now").unwrap_or(0.0)
    }

    fn recheck_delay_ms(&self) -> Option<f64> {
        field_f64(&self.scenario, "recheckDelayMs")
    }

    fn sleep(&mut self, ms: f64) {
        log_line(&self.log, vec![text("sleep"), num(ms)]);
    }

    fn max_convert_slides(&self) -> usize {
        3
    }
}

/// `Ok(())` as the TypeScript answers it: nothing, which JSON writes as null
fn unit(result: Result<(), Failure>) -> Value {
    match result {
        Ok(()) => Value::Null,
        Err(Failure(message)) => error_value(&message),
    }
}

fn session_call(args: &[Value], cx: &mut Context) -> Answer {
    let scenario = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut host = SessionFake {
        ids: list(scenario.get("ids"))
            .iter()
            .filter_map(|s| s.as_str().map(str::to_owned))
            .collect(),
        scenario: scenario.clone(),
        log: Rc::clone(&log),
        counts: Vec::new(),
    };
    let mut session = GenerateSession::new(
        &refs_of(scenario.get("refs")),
        ai_kind_of(scenario.get("kind")),
    );
    let mut results: Vec<Value> = Vec::new();
    for step in list(scenario.get("steps")) {
        results.push(if step.get("state").is_some() {
            to_value(&session.state(&host))
        } else if let Some(reset) = step.get("reset") {
            unit(session.reset(
                &mut host,
                &refs_of(reset.get("refs")),
                ai_kind_of(reset.get("kind")),
            ))
        } else if step.get("refresh").is_some() {
            unit(session.refresh(&mut host))
        } else if let Some(kind) = step.get("setKind") {
            session.set_kind(&mut host, step_arg(kind));
            Value::Null
        } else if let Some(kind) = step.get("setConvert") {
            session.set_convert(&mut host, step_arg(kind));
            Value::Null
        } else if let Some(paths) = step.get("addPaths") {
            unit(session.add_paths(&mut host, paths.as_array().map_or(&[][..], Vec::as_slice)))
        } else if let Some(key) = step.get("remove") {
            session.remove(&mut host, step_arg(key));
            Value::Null
        } else if let Some(key) = step.get("save") {
            unit(session.save(&mut host, step_arg(key)))
        } else if let Some(body) = step.get("make") {
            Value::Bool(session.make(&mut host, step_arg(body)))
        } else {
            Value::Bool(session.is_closed())
        });
    }
    cx.logs.extend(log.take());
    Ok(Some(Value::Array(results)))
}

// ---------------------------------------------------------------------------
// the generate window
// ---------------------------------------------------------------------------

/// the ids of the windows the scenario makes known: the shell's (0), the
/// caller's live (50) and torn down (51) parents
const SHELL_WINDOW: WindowId = 0;
const EXPLICIT_LIVE: WindowId = 50;
const EXPLICIT_DESTROYED: WindowId = 51;

struct WinState {
    id: WindowId,
    destroyed: bool,
    minimized: bool,
}

struct WindowFake {
    scenario: Value,
    log: Log,
    now_ms: f64,
    open: OpenFake,
    engine: Scripted,
    holder: OpenFilesHolder,
    length_cache: MaterialLengthCache,
    notice_cache: NoticeCache,
    windows: Vec<WinState>,
    /// `nativeTheme.on` listeners, one slot per registration
    watchers: Vec<Option<WindowId>>,
    sends: Vec<Value>,
}

impl WindowFake {
    fn win(&self, id: WindowId) -> Option<&WinState> {
        self.windows.iter().find(|w| w.id == id)
    }

    fn win_mut(&mut self, id: WindowId) -> Option<&mut WinState> {
        self.windows.iter_mut().find(|w| w.id == id)
    }

    fn line(&self, id: WindowId, what: &str) {
        log_line(&self.log, vec![text("win"), num(id as f64), text(what)]);
    }
}

fn opener_value(opener: Option<&NewDocumentOpener>) -> Value {
    match opener {
        None => Value::Null,
        Some(NewDocumentOpener::Home) => json!({"kind": "home"}),
        Some(NewDocumentOpener::Window { web_contents_id }) => {
            json!({"kind": "window", "webContentsId": web_contents_id})
        }
    }
}

/// a value with its `id` written as `ID`: the TypeScript draws a random one
fn with_fixed_id(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.insert("id".to_owned(), Value::from("ID"));
    }
    value
}

impl OpenMaterialsDeps for WindowFake {
    type Contents = FakeContents;

    fn list(&mut self) -> Result<Vec<OpenDocumentTab>, Failure> {
        self.open.list()
    }

    fn web_contents_for(&mut self, tab_id: &str) -> Option<FakeContents> {
        self.open.web_contents_for(tab_id)
    }

    fn reveal(&mut self, tab_id: &str) {
        self.open.reveal(tab_id);
    }

    fn has_save(&self, kind: DocumentTabKind) -> bool {
        self.open.has_save(kind)
    }

    fn save_to_path(
        &mut self,
        kind: DocumentTabKind,
        web_contents_id: f64,
        path: &str,
    ) -> Result<(), Failure> {
        self.open.save_to_path(kind, web_contents_id, path)
    }

    fn save_editor(
        &mut self,
        kind: DocumentTabKind,
        contents: &FakeContents,
    ) -> Result<bool, Failure> {
        self.open.save_editor(kind, contents)
    }

    fn warn_save_failed(&mut self, error: &Failure) {
        self.open.warn_save_failed(error);
    }
}

/// the reads of the default `inspectMaterial(path)`: the disk, the reader, the open documents
struct RealInspect<'a> {
    engine: &'a mut Scripted,
    holder: &'a OpenFilesHolder,
}

impl InspectHost for RealInspect<'_> {
    fn stat(&mut self, path: &str) -> Result<FileStat, Failure> {
        real_stat(path)
    }

    fn parse(&mut self, path: &str) -> Result<ParsedFile, Failure> {
        self.engine.parse_file_to_text(path)
    }

    fn injected_parse(&self) -> bool {
        false
    }

    fn has_unsaved_changes(&mut self, path: &str) -> Result<bool, Failure> {
        Ok(file_has_unsaved_changes(self.holder, path))
    }
}

/// the reads of the default `markdownRedactionNotice(path)`
struct RealNotice<'a> {
    engine: &'a mut Scripted,
}

impl FileParser for RealNotice<'_> {
    fn parse_file_to_text(&mut self, path: &str) -> Result<ParsedFile, Failure> {
        self.engine.parse_file_to_text(path)
    }
}

impl NoticeHost for RealNotice<'_> {
    fn stat(&mut self, path: &str) -> Result<FileStat, Failure> {
        real_stat(path)
    }

    fn read_bytes(&mut self, path: &str) -> Result<Vec<u8>, Failure> {
        fs::read(path).map_err(|e| Failure(e.to_string()))
    }

    fn injected_reader(&self) -> bool {
        false
    }
}

impl GenerateWindowHost for WindowFake {
    fn parent_window(&mut self) -> Option<WindowId> {
        field_str(&self.scenario, "parent").map(|_| SHELL_WINDOW)
    }

    fn lang(&self) -> Lang {
        lang_of(&self.scenario)
    }

    fn theme(&self) -> String {
        field_str(&self.scenario, "theme")
            .unwrap_or("dark")
            .to_owned()
    }

    fn open_target_tab(
        &mut self,
        handoff: &crate::packages::electron_utils::generate_handoff::GenerateHandoff,
        opener: Option<&NewDocumentOpener>,
    ) -> Result<(), Failure> {
        log_line(
            &self.log,
            vec![
                text("openTargetTab"),
                with_fixed_id(to_value(handoff)),
                opener_value(opener),
            ],
        );
        if field_str(&self.scenario, "openTarget") == Some("throws") {
            Err(Failure("no tab could open".to_owned()))
        } else {
            Ok(())
        }
    }

    fn can_open_converted(&self) -> bool {
        field_bool(&self.scenario, "canConvert")
    }

    fn open_converted_tab(
        &mut self,
        doc: &ConvertedDocument,
        opener: Option<&NewDocumentOpener>,
    ) -> Result<(), Failure> {
        log_line(
            &self.log,
            vec![
                text("openConvertedTab"),
                with_fixed_id(doc_view(doc)),
                opener_value(opener),
            ],
        );
        if field_str(&self.scenario, "openConverted") == Some("throws") {
            Err(Failure("no tab could open".to_owned()))
        } else {
            Ok(())
        }
    }

    fn starred_group_paths(&mut self, group: &str) -> Vec<String> {
        log_line(&self.log, vec![text("starredGroupPaths"), text(group)]);
        list(self.scenario.get("starred").and_then(|s| s.get(group)))
            .iter()
            .filter_map(|p| p.as_str().map(str::to_owned))
            .collect()
    }

    fn inspect_material(&mut self, path: &str) -> Result<MaterialStatus, Failure> {
        let mut host = RealInspect {
            engine: &mut self.engine,
            holder: &self.holder,
        };
        inspect_material(&mut host, &mut self.length_cache, path)
    }

    fn convert_source(
        &mut self,
        kind: ConvertKind,
        path: &str,
        untitled: &str,
    ) -> crate::shell::generate::convert::ConvertResult {
        convert_source(&mut self.engine, kind, path, untitled)
    }

    fn markdown_redaction_notice(&mut self, path: &str) -> bool {
        let mut host = RealNotice {
            engine: &mut self.engine,
        };
        markdown_redaction_notice(&mut host, &mut self.notice_cache, path)
    }

    fn new_id(&mut self) -> String {
        "ID".to_owned()
    }

    fn now(&mut self) -> f64 {
        self.now_ms
    }

    fn sleep(&mut self, _ms: f64) {}

    fn max_convert_slides(&self) -> usize {
        3
    }

    fn generate_text(&self, lang: Lang, key: GenerateText) -> String {
        let name = match key {
            GenerateText::WindowTitle => "windowTitle",
            GenerateText::DialogAddTitle => "dialogAddTitle",
            GenerateText::FilterSupported => "filterSupported",
            GenerateText::Untitled => "untitled",
        };
        self.scenario
            .get("texts")
            .and_then(|t| t.get(lang.as_str()))
            .and_then(|t| t.get(name))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    }

    fn should_use_dark_colors(&self) -> bool {
        field_bool(&self.scenario, "dark")
    }

    fn is_darwin(&self) -> bool {
        field_bool(&self.scenario, "darwin")
    }

    fn renderer_url(&self) -> Option<String> {
        field_str(&self.scenario, "rendererUrl").map(str::to_owned)
    }

    fn create_window(&mut self, options: &GenerateWindowOptions) -> WindowId {
        let n = self
            .windows
            .iter()
            .filter(|w| w.id > 0 && w.id < EXPLICIT_LIVE)
            .count() as WindowId
            + 1;
        self.windows.push(WinState {
            id: n,
            destroyed: false,
            minimized: false,
        });
        log_line(
            &self.log,
            vec![text("new BrowserWindow"), num(n as f64), to_value(options)],
        );
        n
    }

    fn window_is_destroyed(&self, window: WindowId) -> bool {
        self.win(window).is_some_and(|w| w.destroyed)
    }

    fn window_is_minimized(&self, window: WindowId) -> bool {
        self.win(window).is_some_and(|w| w.minimized)
    }

    fn window_restore(&mut self, window: WindowId) {
        self.line(window, "restore");
    }

    fn window_show(&mut self, window: WindowId) {
        self.line(window, "show");
    }

    fn window_focus(&mut self, window: WindowId) {
        self.line(window, "focus");
    }

    fn window_close(&mut self, window: WindowId) {
        self.line(window, "close");
    }

    fn window_remove_menu(&mut self, window: WindowId) {
        self.line(window, "removeMenu");
    }

    fn window_web_contents_id(&self, window: WindowId) -> f64 {
        match window {
            SHELL_WINDOW => 100.0,
            EXPLICIT_LIVE => 150.0,
            EXPLICIT_DESTROYED => 151.0,
            n => 200.0 + n as f64,
        }
    }

    fn window_send_state(&mut self, _window: WindowId, state: &GenerateWindowState) {
        self.sends.push(to_value(state));
    }

    fn window_set_title_bar_overlay(
        &mut self,
        window: WindowId,
        overlay: &TitleBarOverlay,
    ) -> Result<(), Failure> {
        log_line(
            &self.log,
            vec![
                text("win"),
                num(window as f64),
                text("setTitleBarOverlay"),
                to_value(overlay),
            ],
        );
        if field_bool(&self.scenario, "overlayThrows") {
            Err(Failure("window is gone".to_owned()))
        } else {
            Ok(())
        }
    }

    fn watch_theme(&mut self, window: WindowId) {
        self.watchers.push(Some(window));
        log_line(
            &self.log,
            vec![text("nativeTheme.on"), num(self.watchers.len() as f64)],
        );
    }

    fn unwatch_theme(&mut self, window: WindowId) {
        if let Some(at) = self.watchers.iter().position(|w| *w == Some(window)) {
            self.watchers[at] = None;
            log_line(
                &self.log,
                vec![text("nativeTheme.off"), num((at + 1) as f64)],
            );
        }
    }

    fn window_load_url(&mut self, window: WindowId, url: &str) {
        log_line(
            &self.log,
            vec![text("win"), num(window as f64), text("loadURL"), text(url)],
        );
    }

    fn window_load_generate_page(&mut self, window: WindowId) {
        self.line(window, "loadFile");
    }

    fn open_external(&mut self, url: &str) {
        log_line(&self.log, vec![text("openExternal"), text(url)]);
    }

    fn show_open_dialog(&mut self, window: WindowId, options: &Value) -> OpenDialogResult {
        log_line(
            &self.log,
            vec![text("dialog"), num(window as f64), options.clone()],
        );
        let dialog = self.scenario.get("dialog");
        OpenDialogResult {
            canceled: dialog
                .is_none_or(|d| d.get("canceled").and_then(Value::as_bool).unwrap_or(true)),
            file_paths: dialog
                .map(|d| list(d.get("filePaths")).to_vec())
                .unwrap_or_default(),
        }
    }
}

fn opener_of(value: Option<&Value>) -> Option<NewDocumentOpener> {
    let value = value?;
    match field_str(value, "kind") {
        Some("home") => Some(NewDocumentOpener::Home),
        Some("window") => Some(NewDocumentOpener::Window {
            web_contents_id: field_f64(value, "webContentsId").unwrap_or(f64::NAN),
        }),
        _ => None,
    }
}

fn explicit_parent(value: Option<&Value>) -> Option<WindowId> {
    match value.and_then(Value::as_str) {
        Some("explicit") => Some(EXPLICIT_LIVE),
        Some("explicit-destroyed") => Some(EXPLICIT_DESTROYED),
        _ => None,
    }
}

fn window_call(args: &[Value], cx: &mut Context) -> Answer {
    let scenario = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut holder = OpenFilesHolder::new();
    if let Some(files) = scenario.get("openFiles").and_then(Value::as_array) {
        let files: Vec<OpenFileState> = files
            .iter()
            .map(|f| OpenFileState {
                file_path: field_str(f, "filePath").map(str::to_owned),
                dirty: field_bool(f, "dirty"),
            })
            .collect();
        holder.set_open_files_source(Some(Box::new(
            move || -> Result<Vec<OpenFileState>, OpenFilesSourceFailed> { Ok(files.clone()) },
        )));
    }
    let mut host = WindowFake {
        open: OpenFake {
            scenario: scenario.clone(),
            log: Rc::clone(&log),
        },
        engine: Scripted::new(scenario.get("engine"), &log),
        holder,
        length_cache: MaterialLengthCache::new(),
        notice_cache: NoticeCache::new(),
        windows: vec![
            WinState {
                id: SHELL_WINDOW,
                destroyed: field_str(&scenario, "parent") == Some("destroyed"),
                minimized: false,
            },
            WinState {
                id: EXPLICIT_LIVE,
                destroyed: false,
                minimized: false,
            },
            WinState {
                id: EXPLICIT_DESTROYED,
                destroyed: true,
                minimized: false,
            },
        ],
        watchers: Vec::new(),
        sends: Vec::new(),
        scenario: scenario.clone(),
        log: Rc::clone(&log),
        now_ms: cx.now_ms,
    };
    let mut window = GenerateWindow::new();
    let mut registered = false;
    let mut results: Vec<Value> = Vec::new();
    for step in list(scenario.get("steps")) {
        host.sends.clear();
        let result = if step.get("configure").is_some() {
            let first = window.configure();
            if first {
                registered = true;
                for channel in IPC_HANDLE_CHANNELS {
                    log_line(&log, vec![text("ipc.handle"), text(channel)]);
                }
            }
            num(if first {
                IPC_HANDLE_CHANNELS.len() as f64
            } else {
                0.0
            })
        } else if let Some(open) = step.get("open") {
            unit(window.open_generate_window(
                &mut host,
                OpenInit {
                    refs: refs_of(open.get("refs")),
                    kind: ai_kind_of(open.get("kind")),
                    parent: explicit_parent(open.get("parent")),
                    opener: opener_of(open.get("opener")),
                },
            ))
        } else if let Some(open) = step.get("openPaths") {
            let paths = list(open.get("paths"))
                .iter()
                .filter_map(|p| p.as_str().map(str::to_owned))
                .collect();
            unit(window.open_generate_window_with_paths(
                &mut host,
                paths,
                explicit_parent(open.get("parent")),
            ))
        } else if let Some(open) = step.get("openDocument") {
            unit(window.open_generate_window_for_document(
                &mut host,
                field_f64(open, "webContentsId").unwrap_or(f64::NAN),
                field_str(open, "filePath"),
                field_str(open, "title").unwrap_or_default(),
                explicit_parent(open.get("parent")),
            ))
        } else if step.get("close").is_some() {
            window.close_generate_window(&mut host);
            Value::Null
        } else if step.get("contents").is_some() {
            window
                .generate_window_contents(&host)
                .map_or(Value::Null, num)
        } else if let Some(ipc) = step.get("ipc") {
            ipc_step(&mut window, &mut host, registered, ipc)
        } else if let Some(event) = step.get("event") {
            event_step(&mut window, &mut host, event)
        } else if let Some(n) = field_f64(step, "destroy") {
            if let Some(w) = host.win_mut(n as WindowId) {
                w.destroyed = true;
            }
            Value::Null
        } else {
            let n = field_f64(step, "minimize").unwrap_or(f64::NAN);
            if let Some(w) = host.win_mut(n as WindowId) {
                w.minimized = true;
            }
            Value::Null
        };
        let sends = std::mem::take(&mut host.sends);
        results.push(json!({"result": result, "sends": sends}));
    }
    cx.logs.extend(log.take());
    Ok(Some(Value::Array(results)))
}

fn ipc_step(
    window: &mut GenerateWindow,
    host: &mut WindowFake,
    registered: bool,
    ipc: &Value,
) -> Value {
    let channel = field_str(ipc, "channel").unwrap_or_default();
    if !registered || !IPC_HANDLE_CHANNELS.contains(&channel) {
        return error_value("no handler");
    }
    let from = field_str(ipc, "from").unwrap_or_default();
    let sender = if from == "home" {
        100.0
    } else if let Some(n) = from.strip_prefix("window:") {
        let n: WindowId = n.parse().unwrap_or(0);
        if host.win(n).is_some() && n > 0 && n < EXPLICIT_LIVE {
            200.0 + n as f64
        } else {
            998.0
        }
    } else {
        999.0
    };
    let call_args = list(ipc.get("args"));
    let first = call_args.first().and_then(step_arg);
    match channel {
        channels::GET_STATE => window
            .handle_get_state(host, sender)
            .map_or(Value::Null, |state| to_value(&state)),
        channels::GET_THEME => Value::from(window.handle_get_theme(&*host, sender)),
        channels::SET_KIND => {
            window.handle_set_kind(host, sender, first);
            Value::Null
        }
        channels::SET_CONVERT => {
            window.handle_set_convert(host, sender, first);
            Value::Null
        }
        channels::ADD_MATERIALS => unit(window.handle_add_materials(host, sender)),
        channels::REMOVE_MATERIAL => {
            window.handle_remove_material(host, sender, first);
            Value::Null
        }
        channels::SAVE_MATERIAL => unit(window.handle_save_material(host, sender, first)),
        channels::REFRESH => unit(window.handle_refresh(host, sender)),
        channels::MAKE => Value::Bool(window.handle_make(host, sender, first)),
        channels::CANCEL => {
            window.handle_cancel(host, sender);
            Value::Null
        }
        channels::HOME_OPEN_WITH_PATHS => unit(window.handle_open_with_paths(host, sender, first)),
        _ => unit(window.handle_open_with_group(host, sender, first)),
    }
}

fn event_step(window: &mut GenerateWindow, host: &mut WindowFake, event: &Value) -> Value {
    let name = field_str(event, "name").unwrap_or_default();
    if name == "theme" {
        let watching: Vec<WindowId> = host.watchers.iter().flatten().copied().collect();
        for id in watching {
            window.on_theme_updated(host, id);
        }
        return Value::Null;
    }
    let n = field_f64(event, "window").unwrap_or(1.0) as WindowId;
    if n < 1 || host.win(n).is_none() || n >= EXPLICIT_LIVE {
        return error_value("no window");
    }
    match name {
        "ready-to-show" => window.on_ready_to_show(host, n),
        "focus" => window.on_focus(host, n),
        "closed" => window.on_closed(host, n),
        "open" => {
            window.window_open(host, field_str(event, "url").unwrap_or_default());
            return json!({"action": "deny"});
        }
        _ => {}
    }
    Value::Null
}

// ---------------------------------------------------------------------------
// the table
// ---------------------------------------------------------------------------

fn kind_values<T: Copy>(kinds: &[T], name: fn(T) -> &'static str) -> Value {
    Value::Array(kinds.iter().map(|k| text(name(*k))).collect())
}

fn strings(items: impl IntoIterator<Item = &'static str>) -> Value {
    Value::Array(items.into_iter().map(text).collect())
}

fn ok(value: Value) -> Answer {
    Ok(Some(value))
}

fn strs_arg(args: &[Value], i: usize) -> Vec<String> {
    list(arg(args, i))
        .iter()
        .filter_map(|s| s.as_str().map(str::to_owned))
        .collect()
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- limits ----
        "limits.LONG_MATERIAL_NOTICE_CHARS" => ok(num(LONG_MATERIAL_NOTICE_CHARS)),
        "limits.USAGE_NOTICE_CHARS" => ok(num(USAGE_NOTICE_CHARS)),
        "limits.MAX_MATERIALS" => ok(num(MAX_MATERIALS as f64)),
        "limits.MAX_MATERIAL_BYTES" => ok(num(MAX_MATERIAL_BYTES)),
        "limits.MAX_IMAGE_MATERIAL_BYTES" => ok(num(MAX_IMAGE_MATERIAL_BYTES)),
        "limits.MAX_REQUEST_TEXT_CHARS" => ok(num(MAX_REQUEST_TEXT_CHARS as f64)),

        // ---- title-bar ----
        "title-bar.GENERATE_TITLE_BAR_HEIGHT" => ok(num(GENERATE_TITLE_BAR_HEIGHT)),
        "title-bar.generateTitleBarOverlay" => {
            let dark = arg(args, 0).and_then(Value::as_bool).unwrap_or(false);
            ok(to_value(&generate_title_bar_overlay(dark)))
        }

        // ---- shared/generate-api, generate-default-prompts ----
        "generate-api.AI_TARGET_KINDS" => ok(kind_values(&AI_TARGET_KINDS, ai_target_str)),
        "generate-api.CONVERT_KINDS" => ok(kind_values(&CONVERT_KINDS, convert_kind_str)),
        "generate-api.GENERATE_CHANNELS" => {
            let mut out = Map::new();
            for (key, channel) in [
                ("getState", channels::GET_STATE),
                ("getTheme", channels::GET_THEME),
                ("setKind", channels::SET_KIND),
                ("setConvert", channels::SET_CONVERT),
                ("addMaterials", channels::ADD_MATERIALS),
                ("removeMaterial", channels::REMOVE_MATERIAL),
                ("saveMaterial", channels::SAVE_MATERIAL),
                ("refresh", channels::REFRESH),
                ("make", channels::MAKE),
                ("cancel", channels::CANCEL),
                ("state", channels::STATE),
            ] {
                out.insert(key.to_owned(), text(channel));
            }
            ok(Value::Object(out))
        }
        "generate-home-channels.GENERATE_HOME_CHANNELS" => ok(json!({
            "openWithPaths": channels::HOME_OPEN_WITH_PATHS,
            "openWithGroup": channels::HOME_OPEN_WITH_GROUP,
        })),
        "generate-api.CONVERT_TARGETS" => {
            let mut out = Map::new();
            for kind in CONVERT_KINDS {
                out.insert(
                    convert_kind_str(kind).to_owned(),
                    text(convert_target_str(convert_target(kind))),
                );
            }
            ok(Value::Object(out))
        }
        "generate-default-prompts.DEFAULT_GENERATE_PROMPTS" => {
            let mut out = Map::new();
            for lang in [Lang::En, Lang::Ko] {
                let mut prompts = Map::new();
                for kind in AI_TARGET_KINDS {
                    prompts.insert(
                        ai_target_str(kind).to_owned(),
                        text(default_generate_prompt(lang, kind)),
                    );
                }
                out.insert(lang.as_str().to_owned(), Value::Object(prompts));
            }
            ok(Value::Object(out))
        }
        "generate-default-prompts.defaultGeneratePrompt" => {
            let lang = match arg(args, 0).and_then(Value::as_str) {
                Some("ko") => Lang::Ko,
                _ => Lang::En,
            };
            match ai_kind_of(arg(args, 1)) {
                Some(kind) => ok(text(default_generate_prompt(lang, kind))),
                None => Ok(None),
            }
        }

        // ---- file-parse/attachable ----
        "file-parse/attachable.ATTACHABLE_EXTS" => ok(strings(attachable_exts())),
        "file-parse/attachable.ATTACHABLE_IMAGE_EXTS" => ok(strings(ATTACHABLE_IMAGE_EXTS)),
        "file-parse/attachable.ATTACHABLE_MAX_BYTES" => ok(num(ATTACHABLE_MAX_BYTES)),
        "file-parse/attachable.ATTACHABLE_IMAGE_MAX_BYTES" => ok(num(ATTACHABLE_IMAGE_MAX_BYTES)),
        "file-parse/attachable.attachableMaxBytes" => {
            str_arg(args, 0).map(|ext| Some(num(attachable_max_bytes(ext))))
        }
        "file-parse/attachable.isAttachableExt" => {
            str_arg(args, 0).map(|ext| Some(Value::Bool(is_attachable_ext(ext))))
        }

        // ---- materials ----
        "materials.IMAGE_MATERIAL_EXTS" => ok(strings(IMAGE_MATERIAL_EXTS)),
        "materials.SUPPORTED_MATERIAL_EXTS" => ok(strings(supported_material_exts())),
        "materials.materialMaxBytes" => {
            str_arg(args, 0).map(|ext| Some(num(material_max_bytes(ext))))
        }
        "materials.extOf" => str_arg(args, 0).map(|path| Some(Value::from(ext_of(path)))),
        "materials.materialKey" => {
            str_arg(args, 0).map(|path| Some(Value::from(material_key(path))))
        }
        "materials.untitledMaterial" => str_arg(args, 1).map(|title| {
            let id = arg(args, 0).and_then(Value::as_f64).unwrap_or(f64::NAN);
            Some(untitled_material(id, title).to_value())
        }),
        "materials.inspectMaterial" => inspect_call(args, cx),
        "materials.generateNotices" => {
            let total = arg(args, 1).and_then(Value::as_f64).unwrap_or(f64::NAN);
            match ai_kind_of(arg(args, 0)) {
                Some(kind) => ok(to_value(&generate_notices(kind, total))),
                None => Ok(None),
            }
        }
        "materials.summarizeMaterials" => {
            let statuses: Vec<MaterialStatus> = list(arg(args, 0)).iter().map(status_of).collect();
            match ai_kind_of(arg(args, 1)) {
                Some(kind) => ok(summarize_materials(&statuses, kind).to_value()),
                None => Ok(None),
            }
        }

        // ---- request ----
        "request.isAiTargetKind" => ok(Value::Bool(is_ai_target_kind(arg(args, 0)))),
        "request.isConvertKind" => ok(Value::Bool(is_convert_kind(arg(args, 0)))),
        "request.availableConversions" => ok(Value::Array(
            available_conversions(&strs_arg(args, 0))
                .into_iter()
                .map(|kind| text(convert_kind_str(kind)))
                .collect(),
        )),
        "request.validateGenerateRequest" => {
            let raw = arg(args, 0).cloned().unwrap_or(Value::Null);
            ok(match validate_generate_request(&raw) {
                Ok(request) => json!({"ok": true, "request": to_value(&request)}),
                Err(error) => json!({"ok": false, "error": error.as_str()}),
            })
        }
        "request.prepareGenerateRequest" => prepare_call(args, cx),

        // ---- open-materials ----
        "open-materials.createOpenMaterials" => open_call(args, cx),

        // ---- convert ----
        "convert.convertSource"
        | "convert.mapOutlineToSlidesMarkdown"
        | "convert.mapOutlineToSlides"
        | "convert.buildDeck" => convert_call(args, cx),
        "convert.markdownRedactionNotice" => notice_call(args, cx),

        // ---- converted-tab ----
        "converted-tab.queueConvertedContent" => converted_tab_call(args, cx),

        // ---- session ----
        "session.GenerateSession" => session_call(args, cx),

        // ---- generate-window ----
        "generate-window.configureGenerateWindow"
        | "generate-window.openGenerateWindow"
        | "generate-window.openGenerateWindowWithPaths"
        | "generate-window.openGenerateWindowForDocument"
        | "generate-window.closeGenerateWindow"
        | "generate-window.generateWindowContents" => window_call(args, cx),

        _ => return None,
    })
}
