//! The `shell-rest` part of group `b3b4-rest` (tools/main-diff/groups/
//! b3b4-rest/shell-rest.ts): dropped files, document links in the shell,
//! headless export, the slides print entry, the transaction core, autofit
//! write-back and the seed deck. What the ports take as a trait (the engine,
//! the session registry, the windows) is a fake the spec describes; each call
//! of a fake is one `logs` line, and the TypeScript stubs write the same
//! lines.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use jscompat::node_path::host::join;
use jscompat::{js_regex, number_to_string, value_truthy};
use serde_json::{Map, Number, Value};

use super::super::fakes::{FakeRenderer, drive_print};
use super::super::{Answer, CallError, Context, arg, print_js, str_arg};
use crate::packages::electron_utils::drop_open::{DropPartition, partition_drop_payload};
use crate::packages::electron_utils::generate_handoff::{
    GenerateConvertKind, GenerateConvertTarget, HandoffStore, HandoffWebContents,
};
use crate::packages::electron_utils::headless_export::{
    HeadlessExportOutcome, HeadlessExportRequest,
};
use crate::packages::electron_utils::print_window::{
    ExecOutcome, JsError, PrintDialogWindow, PrintReport, RendererAnswer, RendererCall,
};
use crate::packages::electron_utils::recovery_store::{
    RecoveryFileIdentity, RecoveryIdentity, RecoveryUntitledIdentity,
};
use crate::shell::document_links::{
    DOCUMENT_LINKS_FILE, FileLinksDeps, StatTimes, document_links_at, handoff_store_events,
    stat_sync, watch_make_events,
};
use crate::shell::document_links_menu::{DocumentLinkMenuLabels, MenuClick};
use crate::shell::document_links_shell::{
    DocumentContents, DocumentLinksShell, DocumentLinksShellHost, GenerateWindowRequest,
    LinkedDocument,
};
use crate::shell::dropped_files::{DroppedFilesDeps, handle_dropped_files};
use crate::shell::headless_export::{
    HeadlessExportProduct, HeadlessFailure, HeadlessFs, HeadlessRun, HeadlessStep, HiddenContent,
    begin_headless_export, finish_headless_export, validate_headless_paths,
};
use crate::shell::tab_manager::TabKind;
use crate::slides::autofit_writeback::{
    AutofitElement, AutofitHost, AutofitRendered, AutofitText, RenderTextLayout, TextInsets,
    TextLine, TextNode, TextRefit, TextRun, apply_autofit_resize, sync_autofit_scale,
};
use crate::slides::print_window::{begin_print_slides_html, finish_print_slides_html};
use crate::slides::seed_deck::{
    DeckChanged, SeedContents, SeedDeckHost, SeedSession, open_slides_seed,
};
use crate::slides::seed_queue::{SeedQueue, SlidesSeedOptions};
use crate::slides::session_txn::{
    Isolation, TxnFailure, TxnHistory, TxnOpRecord, TxnResult, TxnSession, apply_txn_to_session,
};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "drop-open.partitionDropPayload" => partition_call(args),
        "dropped-files.handleDroppedFiles" => dropped_call(args, cx),
        "shell/headless-export.validateHeadlessPaths" => validate_call(args, cx),
        "shell/headless-export.runHeadlessExport" => run_call(args, cx),
        "slides/print-window.printSlidesHtml" => print_slides_call(args, cx),
        "session-txn.applyTxnToSession" => txn_call(args, cx),
        "autofit-writeback.applyAutofitResize" => autofit_call(args, cx, true),
        "autofit-writeback.syncAutofitScale" => autofit_call(args, cx, false),
        "seed-deck.openSlidesSeed" => seed_call(args, cx),
        "document-links-shell.scenario" => shell_call(args, cx),
        _ => return None,
    })
}

// ---- helpers ----

static NULL: Value = Value::Null;

fn bad(what: &str) -> CallError {
    CallError::plain(format!("bad argument: {what}"))
}

fn text(x: &str) -> Value {
    Value::from(x)
}

fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn field_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn field_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn field_bool(value: &Value, key: &str) -> bool {
    matches!(value.get(key), Some(Value::Bool(true)))
}

fn list(value: Option<&Value>) -> &[Value] {
    match value.and_then(Value::as_array) {
        Some(items) => items.as_slice(),
        None => &[],
    }
}

fn strings(value: Option<&Value>) -> Vec<String> {
    list(value)
        .iter()
        .filter_map(|item| item.as_str().map(str::to_owned))
        .collect()
}

fn strings_value(items: &[String]) -> Value {
    Value::Array(items.iter().map(|item| text(item)).collect())
}

fn entries(value: Option<&Value>) -> Vec<(&String, &Value)> {
    match value.and_then(Value::as_object) {
        Some(map) => map.iter().collect(),
        None => Vec::new(),
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

#[derive(Clone, Default)]
struct Log(Rc<RefCell<Vec<Vec<Value>>>>);

impl Log {
    fn push(&self, line: Vec<Value>) {
        self.0.borrow_mut().push(line);
    }

    fn flush_into(&self, cx: &mut Context) {
        cx.logs.append(&mut self.0.borrow_mut());
    }
}

// ---- drop-open, dropped-files ----

fn partition_value(partition: &DropPartition) -> Value {
    let mut map = Map::new();
    map.insert("supported".into(), strings_value(&partition.supported));
    map.insert("skillFiles".into(), strings_value(&partition.skill_files));
    map.insert(
        "unsupportedExts".into(),
        strings_value(&partition.unsupported_exts),
    );
    Value::Object(map)
}

/// `[payload]`
fn partition_call(args: &[Value]) -> Answer {
    let raw = arg(args, 0).unwrap_or(&NULL);
    Ok(Some(partition_value(&partition_drop_payload(raw))))
}

struct DropDeps<'a> {
    world: &'a Value,
    log: Log,
}

impl DropDeps<'_> {
    fn table(&self, table: &str, path: &str) -> Option<&Value> {
        self.world.get(table).and_then(|t| t.get(path))
    }
}

impl DroppedFilesDeps for DropDeps<'_> {
    type SkillSource = String;

    fn open_document_path(&mut self, path: &str) -> bool {
        self.log.push(vec![text("open"), text(path)]);
        self.table("opens", path) == Some(&Value::Bool(true))
    }

    fn reveal_shell_window(&mut self) {
        self.log.push(vec![text("reveal")]);
    }

    fn show_warning(&mut self, message: &str) {
        self.log.push(vec![text("warn"), text(message)]);
    }

    fn unsupported_message(&mut self, exts: &[String]) -> String {
        self.log
            .push(vec![text("unsupportedMessage"), strings_value(exts)]);
        format!("unsupported: {}", exts.join(","))
    }

    fn skill_source_of(&mut self, path: &str) -> Result<Option<String>, String> {
        self.log.push(vec![text("skillSourceOf"), text(path)]);
        match self.table("skills", path).and_then(Value::as_str) {
            Some("reject") => Err("unreadable".to_owned()),
            Some("source") => Ok(Some(format!("skills of {path}"))),
            _ => Ok(None),
        }
    }

    fn import_skills(&mut self, source: String) {
        self.log.push(vec![text("import"), text(&source)]);
    }

    fn no_skills_found(&mut self) {
        self.log.push(vec![text("noSkillsFound")]);
    }
}

/// `[payload, { opens, skills }]`
fn dropped_call(args: &[Value], cx: &mut Context) -> Answer {
    let raw = arg(args, 0).unwrap_or(&NULL);
    let world = arg(args, 1).ok_or_else(|| bad("world"))?;
    let log = Log::default();
    let mut deps = DropDeps {
        world,
        log: log.clone(),
    };
    handle_dropped_files(raw, &mut deps);
    log.flush_into(cx);
    Ok(None)
}

// ---- headless-export ----

const ALL_TARGETS: [&str; 10] = [
    "pdf",
    "docx",
    "html",
    "md",
    "png",
    "svg",
    "drawio",
    "dio",
    "drawio.svg",
    "drawio.png",
];

const BATCH_MODES: [&str; 3] = ["all-or-nothing", "best-effort", "stop-on-error"];

fn request_of(value: Option<&Value>) -> Result<HeadlessExportRequest, CallError> {
    let value = value.ok_or_else(|| bad("request"))?;
    let target = field_str(value, "targetFormat").ok_or_else(|| bad("targetFormat"))?;
    let target_format = ALL_TARGETS
        .iter()
        .find(|known| **known == target)
        .copied()
        .ok_or_else(|| bad("targetFormat"))?;
    let batch = match field_str(value, "batch") {
        Some(mode) => Some(
            BATCH_MODES
                .iter()
                .find(|known| **known == mode)
                .copied()
                .ok_or_else(|| bad("batch"))?,
        ),
        None => None,
    };
    Ok(HeadlessExportRequest {
        input: field_str(value, "input")
            .ok_or_else(|| bad("input"))?
            .to_owned(),
        target_format,
        out_path: field_str(value, "outPath")
            .ok_or_else(|| bad("outPath"))?
            .to_owned(),
        json: field_bool(value, "json"),
        page: field_f64(value, "page"),
        ops: field_str(value, "ops").map(str::to_owned),
        batch,
    })
}

/// the disk the spec describes, shared by the fs and the fake exporters
struct FsState {
    files: Vec<String>,
    dirs: Vec<String>,
    real: Vec<(String, String)>,
    mtimes: Vec<(String, f64)>,
    texts: Vec<(String, String)>,
    no_mtime: bool,
    no_read: bool,
    now: f64,
}

impl FsState {
    fn of(world: &Value) -> FsState {
        FsState {
            files: strings(world.get("files")),
            dirs: strings(world.get("dirs")),
            real: entries(world.get("real"))
                .into_iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                .collect(),
            mtimes: entries(world.get("mtimes"))
                .into_iter()
                .filter_map(|(k, v)| v.as_f64().map(|v| (k.clone(), v)))
                .collect(),
            texts: entries(world.get("texts"))
                .into_iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
                .collect(),
            no_mtime: field_bool(world, "noMtime"),
            no_read: field_bool(world, "noRead"),
            now: field_f64(world, "now").unwrap_or(1_000_000.0),
        }
    }

    /// what an exporter wrote: `{ writes: [{ path, mtime? }] }`
    fn write(&mut self, spec: &Value) {
        for out in list(spec.get("writes")) {
            let Some(path) = field_str(out, "path") else {
                continue;
            };
            if !self.files.iter().any(|file| file == path) {
                self.files.push(path.to_owned());
            }
            if let Some(mtime) = field_f64(out, "mtime") {
                match self.mtimes.iter_mut().find(|(file, _)| file == path) {
                    Some(slot) => slot.1 = mtime,
                    None => self.mtimes.push((path.to_owned(), mtime)),
                }
            }
        }
    }
}

struct FakeFs {
    state: Rc<RefCell<FsState>>,
    log: Log,
}

impl HeadlessFs for FakeFs {
    fn exists(&mut self, path: &str) -> bool {
        self.log.push(vec![text("exists"), text(path)]);
        let state = self.state.borrow();
        state.files.iter().any(|file| file == path) || state.dirs.iter().any(|dir| dir == path)
    }

    fn is_file(&mut self, path: &str) -> bool {
        self.log.push(vec![text("isFile"), text(path)]);
        self.state.borrow().files.iter().any(|file| file == path)
    }

    fn realpath(&mut self, path: &str) -> String {
        self.log.push(vec![text("realpath"), text(path)]);
        let state = self.state.borrow();
        match state.real.iter().find(|(from, _)| from == path) {
            Some((_, to)) => to.clone(),
            None => path.to_owned(),
        }
    }

    fn has_mtime(&self) -> bool {
        !self.state.borrow().no_mtime
    }

    fn mtime_ms(&mut self, path: &str) -> f64 {
        self.log.push(vec![text("mtimeMs"), text(path)]);
        let state = self.state.borrow();
        match state.mtimes.iter().find(|(file, _)| file == path) {
            Some((_, mtime)) => *mtime,
            None => state.now,
        }
    }

    fn has_read(&self) -> bool {
        !self.state.borrow().no_read
    }

    fn read(&mut self, path: &str) -> Result<Vec<u8>, String> {
        self.log.push(vec![text("read"), text(path)]);
        let state = self.state.borrow();
        match state.texts.iter().find(|(file, _)| file == path) {
            Some((_, body)) => Ok(body.clone().into_bytes()),
            None => Err(format!("cannot read {path}")),
        }
    }
}

/// `exporters[module](input, outPath, format, request)` of the spec: logs, writes
/// what the case says it writes, then throws or answers its product
#[allow(clippy::too_many_arguments)]
fn run_fake_exporter(
    state: &Rc<RefCell<FsState>>,
    log: &Log,
    spec: &Value,
    module: &str,
    input: &str,
    out_path: &str,
    format: &str,
    request: &HeadlessExportRequest,
) -> Result<Option<HeadlessExportProduct>, String> {
    log.push(vec![
        text("export"),
        text(module),
        text(input),
        text(out_path),
        text(format),
        request.to_value(),
    ]);
    state.borrow_mut().write(spec);
    match field_str(spec, "throws") {
        Some("error") => return Err("export failed".to_owned()),
        Some("string") => return Err("export failed as text".to_owned()),
        _ => {}
    }
    Ok(spec
        .get("product")
        .filter(|product| product.is_object())
        .map(|product| HeadlessExportProduct {
            paths: strings(product.get("paths")),
            detail: product.get("detail").cloned(),
        }))
}

/// `placeholders(input, outPath, format)` of the spec
fn run_fake_placeholders(
    state: &Rc<RefCell<FsState>>,
    log: &Log,
    spec: &Value,
    input: &str,
    out_path: &str,
    format: &str,
) -> Result<Option<HeadlessExportProduct>, String> {
    log.push(vec![
        text("placeholders"),
        text(input),
        text(out_path),
        text(format),
    ]);
    state.borrow_mut().write(spec);
    if field_str(spec, "throws") == Some("error") {
        return Err("placeholder failed".to_owned());
    }
    Ok(None)
}

/// `fileHoldsHiddenContent` of the spec's stub: a text holding `HIDDEN` holds
/// hidden content, one holding `THROW` makes the check throw
struct FakeHidden {
    log: Log,
}

impl HiddenContent for FakeHidden {
    fn file_holds_hidden_content(&mut self, bytes: &[u8], ext: &str) -> Result<bool, String> {
        let body = String::from_utf8_lossy(bytes).into_owned();
        self.log
            .push(vec![text("fileHoldsHiddenContent"), text(&body), text(ext)]);
        if body.contains("THROW") {
            return Err("hidden check failed".to_owned());
        }
        Ok(body.contains("HIDDEN"))
    }
}

fn failure_value(failure: &HeadlessFailure) -> Value {
    let mut map = Map::new();
    map.insert("ok".into(), Value::Bool(false));
    map.insert("code".into(), num(failure.code));
    map.insert("message".into(), text(&failure.message));
    Value::Object(map)
}

fn outcome_value(outcome: &HeadlessExportOutcome) -> Value {
    let mut map = Map::new();
    match outcome {
        HeadlessExportOutcome::Ok {
            input,
            out_path,
            out_paths,
            detail,
        } => {
            map.insert("ok".into(), Value::Bool(true));
            map.insert("input".into(), text(input));
            map.insert("outPath".into(), text(out_path));
            if let Some(paths) = out_paths {
                map.insert("outPaths".into(), strings_value(paths));
            }
            if let Some(detail) = detail {
                map.insert("detail".into(), detail.clone());
            }
        }
        HeadlessExportOutcome::Failed { code, message } => {
            map.insert("ok".into(), Value::Bool(false));
            map.insert("code".into(), num(*code));
            map.insert("message".into(), text(message));
        }
    }
    Value::Object(map)
}

/// `[request, fsWorld]`
fn validate_call(args: &[Value], cx: &mut Context) -> Answer {
    let request = request_of(arg(args, 0))?;
    let world = arg(args, 1).ok_or_else(|| bad("world"))?;
    let log = Log::default();
    let mut fs = FakeFs {
        state: Rc::new(RefCell::new(FsState::of(world))),
        log: log.clone(),
    };
    let checked = validate_headless_paths(&request, &mut fs);
    log.flush_into(cx);
    Ok(Some(match checked {
        Ok(checked) => {
            let mut map = Map::new();
            map.insert("ok".into(), Value::Bool(true));
            map.insert("input".into(), text(&checked.input));
            map.insert("outPath".into(), text(&checked.out_path));
            map.insert("module".into(), text(checked.module));
            Value::Object(map)
        }
        Err(failure) => failure_value(&failure),
    }))
}

/// `[request, runWorld]`
fn run_call(args: &[Value], cx: &mut Context) -> Answer {
    let request = request_of(arg(args, 0))?;
    let world = arg(args, 1).ok_or_else(|| bad("world"))?;
    let log = Log::default();
    let state = Rc::new(RefCell::new(FsState::of(world)));
    let now = state.borrow().now;
    let mut fs = FakeFs {
        state: state.clone(),
        log: log.clone(),
    };
    let mut hidden = FakeHidden { log: log.clone() };
    let has_placeholders = world
        .get("placeholders")
        .is_some_and(|spec| !spec.is_null());
    let begun = begin_headless_export(
        &request,
        &mut fs,
        &mut hidden,
        has_placeholders,
        &mut move || now,
    );
    let outcome = match begun {
        Err(message) => Err(message),
        Ok(HeadlessStep::Done(outcome)) => Ok(outcome),
        Ok(HeadlessStep::Export(pending)) => {
            // the caller's part: run the hidden-window export and report back
            let product = match &pending.run {
                HeadlessRun::Exporter {
                    module,
                    input,
                    out_path,
                    format,
                } => run_fake_exporter(
                    &state,
                    &log,
                    world.get("exporter").unwrap_or(&NULL),
                    module,
                    input,
                    out_path,
                    format,
                    &pending.request,
                ),
                HeadlessRun::Placeholders {
                    input,
                    out_path,
                    format,
                } => run_fake_placeholders(
                    &state,
                    &log,
                    world.get("placeholders").unwrap_or(&NULL),
                    input,
                    out_path,
                    format,
                ),
            };
            Ok(finish_headless_export(pending, product, &mut fs))
        }
    };
    log.flush_into(cx);
    match outcome {
        Ok(outcome) => Ok(Some(outcome_value(&outcome))),
        Err(message) => Err(CallError::plain(message)),
    }
}

// ---- slides/print-window ----

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

/// `process.platform`
fn process_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// `/seuoffice-slides-print-<6 random characters>` written `/...<rand>`
fn mask_rand(text: &str) -> String {
    js_regex!(r"/(seuoffice-slides-print-)[A-Za-z0-9]{6}", "g")
        .replace_all(text, |m| format!("/{}<rand>", m.get(1).unwrap_or("")))
}

fn mask_value(value: &mut Value) {
    match value {
        Value::String(body) => *body = mask_rand(body),
        Value::Array(items) => items.iter_mut().for_each(mask_value),
        Value::Object(map) => map.values_mut().for_each(mask_value),
        _ => {}
    }
}

/// A window driven by a script `{ loadFile?, exec?, print?, showThrows?,
/// focusThrows?, destroyed?, isDestroyedThrows?, destroyThrows? }`.
struct PrintWin<'a> {
    script: &'a Value,
    log: Log,
    destroyed: bool,
}

impl PrintWin<'_> {
    fn throws(&self, name: &str) -> bool {
        field_bool(self.script, name)
    }

    fn mode(&self, name: &str) -> Option<&str> {
        field_str(self.script, name)
    }
}

impl FakeRenderer for PrintWin<'_> {
    fn answer(&mut self, call: &RendererCall) -> RendererAnswer {
        match call {
            RendererCall::LoadFile { path } => RendererAnswer::Loaded(self.load_file(path)),
            RendererCall::ExecuteJavaScript {
                script,
                user_gesture,
                ..
            } => RendererAnswer::Executed(self.execute_javascript(script, *user_gesture)),
            RendererCall::Print { options } => RendererAnswer::Printed(self.print(options)),
            RendererCall::PrintToPdf { .. } => {
                RendererAnswer::Pdf(Err(JsError::plain("the slides print window prints no PDF")))
            }
        }
    }
}

impl PrintWin<'_> {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        // the folder's random part is cut off, so both sides log the same
        let (dir, base) = path.rsplit_once('/').unwrap_or(("", path));
        let dir_base = dir.rsplit_once('/').map_or(dir, |(_, last)| last);
        let masked = &dir_base[..dir_base.len().saturating_sub(6)];
        let body = std::fs::read_to_string(path).unwrap_or_default();
        self.log.push(vec![
            text("loadFile"),
            text(masked),
            text(base),
            text(&body),
        ]);
        if self.mode("loadFile") == Some("throws") {
            return Err(JsError::plain("load failed"));
        }
        Ok(())
    }

    fn execute_javascript(&mut self, script: &str, user_gesture: bool) -> ExecOutcome {
        self.log.push(vec![
            text("executeJavaScript"),
            text(script),
            Value::Bool(user_gesture),
        ]);
        match self.mode("exec") {
            Some("rejected") => ExecOutcome::Rejected("probe rejected".to_owned()),
            Some("throws") => ExecOutcome::Throws("probe threw".to_owned()),
            Some("pending") => ExecOutcome::Pending,
            _ => ExecOutcome::Settled,
        }
    }

    fn print(&mut self, options: &Value) -> Result<PrintReport, JsError> {
        self.log.push(vec![text("print"), options.clone()]);
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
}

impl PrintDialogWindow for PrintWin<'_> {
    fn show(&mut self) -> Result<(), JsError> {
        self.log.push(vec![text("show")]);
        if self.throws("showThrows") {
            return Err(JsError::plain("show threw"));
        }
        Ok(())
    }

    fn focus(&mut self) -> Result<(), JsError> {
        self.log.push(vec![text("focus")]);
        if self.throws("focusThrows") {
            return Err(JsError::plain("focus threw"));
        }
        Ok(())
    }

    fn is_destroyed(&mut self) -> Result<bool, JsError> {
        self.log.push(vec![text("isDestroyed")]);
        if self.throws("isDestroyedThrows") {
            return Err(JsError::plain("isDestroyed threw"));
        }
        Ok(self.destroyed)
    }

    fn destroy(&mut self) -> Result<(), JsError> {
        self.log.push(vec![text("destroy")]);
        self.destroyed = true;
        if self.throws("destroyThrows") {
            return Err(JsError::plain("destroy threw"));
        }
        Ok(())
    }
}

/// `[html, script, platform | null]`
fn print_slides_call(args: &[Value], cx: &mut Context) -> Answer {
    let html = str_arg(args, 0)?;
    let script = arg(args, 1).ok_or_else(|| bad("script"))?;
    let platform = match arg(args, 2) {
        None | Some(Value::Null) => process_platform(),
        Some(Value::String(platform)) => platform.as_str(),
        Some(_) => return Err(bad("platform")),
    };
    let log = Log::default();
    let mut window = PrintWin {
        script,
        log: log.clone(),
        destroyed: field_bool(script, "destroyed"),
    };
    let tmp = os_tmpdir();
    let probe_log = log.clone();
    let step = begin_print_slides_html(html, &mut window, platform, &tmp);
    let printed = drive_print(step, &mut window, &mut |message| {
        probe_log.push(vec![
            text("console.error"),
            text("[print] readiness probe failed:"),
            text(message),
        ]);
    });
    let result = finish_print_slides_html(printed);
    log.flush_into(cx);
    match result {
        Ok(result) => {
            let mut value = to_value(&result);
            mask_value(&mut value);
            Ok(Some(value))
        }
        Err(error) => Err(CallError {
            code: error.code,
            message: mask_rand(&error.message),
        }),
    }
}

// ---- session-txn ----

fn txn_result(value: &Value) -> TxnResult {
    let failures = value
        .get("failures")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| TxnFailure {
                    index: field_f64(item, "index").unwrap_or(f64::NAN),
                    error: field_str(item, "error").unwrap_or("").to_owned(),
                })
                .collect()
        });
    let records = value.get("records").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .map(|item| TxnOpRecord {
                op: item.get("op").cloned().unwrap_or(Value::Null),
                slide_id: field_str(item, "slideId").map(str::to_owned),
                created: item
                    .get("created")
                    .and_then(Value::as_array)
                    .map(|_| strings(item.get("created"))),
                after: item.get("after").cloned(),
            })
            .collect()
    });
    TxnResult {
        applied: value_truthy(value.get("applied")),
        plan: value.get("plan").and_then(Value::as_array).cloned(),
        failures,
        records,
    }
}

struct TxnFake {
    slides: Vec<String>,
    plans: VecDeque<Value>,
    rev: u64,
    log: Log,
}

impl TxnSession for TxnFake {
    type Rendered = Value;

    fn run_dry(&mut self, ops: &[Value], isolation: Isolation) -> TxnResult {
        let mut request = Map::new();
        request.insert("ops".into(), Value::Array(ops.to_vec()));
        request.insert("isolation".into(), text(isolation.as_str()));
        request.insert("dryRun".into(), Value::Bool(true));
        self.log.push(vec![text("runTxn"), Value::Object(request)]);
        match self.plans.pop_front() {
            Some(plan) => txn_result(&plan),
            None => TxnResult {
                applied: true,
                ..TxnResult::default()
            },
        }
    }

    fn mark_meta_dirty(&mut self) {
        self.log.push(vec![text("markMetaDirty")]);
    }

    fn slide_index_of_durable_id(&mut self, id: &str) -> Option<usize> {
        self.slides.iter().position(|slide| slide == id)
    }

    fn rebuild_slide_with_reparse(&mut self, index: usize) {
        self.log
            .push(vec![text("rebuildSlideWithReparse"), num(index as f64)]);
    }

    fn materialize_slide(&mut self, index: usize) {
        self.log
            .push(vec![text("materializeSlide"), num(index as f64)]);
    }

    fn rebuild_slide(&mut self, index: usize) -> Option<Value> {
        self.log.push(vec![text("rebuildSlide"), num(index as f64)]);
        self.rev += 1;
        let mut slide = Map::new();
        slide.insert("slide".into(), num(index as f64));
        slide.insert("rev".into(), num(self.rev as f64));
        Some(Value::Object(slide))
    }

    fn apply_autofit_resize(
        &mut self,
        index: usize,
        source_id: &str,
        rendered: Option<Value>,
    ) -> Option<Value> {
        let rendered = rendered.unwrap_or(Value::Null);
        self.log.push(vec![
            text("applyAutofitResize"),
            num(index as f64),
            text(source_id),
            rendered.clone(),
        ]);
        let mut wrapped = Map::new();
        wrapped.insert("resized".into(), rendered);
        Some(Value::Object(wrapped))
    }

    fn sync_autofit_scale(
        &mut self,
        index: usize,
        source_id: &str,
        rendered: Option<Value>,
    ) -> Option<Value> {
        let rendered = rendered.unwrap_or(Value::Null);
        self.log.push(vec![
            text("syncAutofitScale"),
            num(index as f64),
            text(source_id),
            rendered.clone(),
        ]);
        let mut wrapped = Map::new();
        wrapped.insert("synced".into(), rendered);
        Some(Value::Object(wrapped))
    }

    fn build_all_render_slides(&mut self) -> Vec<Value> {
        self.log
            .push(vec![text("buildAllRenderSlides"), num(960.0)]);
        let mut all = Map::new();
        all.insert("all".into(), num(960.0));
        vec![Value::Object(all)]
    }
}

struct TxnHist {
    run: Value,
    log: Log,
}

impl TxnHistory<TxnFake> for TxnHist {
    fn push(&mut self, _session: &mut TxnFake) {
        self.log.push(vec![text("history.push")]);
    }

    fn drop_step(&mut self, _session: &mut TxnFake) {
        self.log.push(vec![text("history.drop")]);
    }

    fn run(&mut self, _session: &mut TxnFake, ops: &[Value], isolation: Isolation) -> TxnResult {
        let mut request = Map::new();
        request.insert("ops".into(), Value::Array(ops.to_vec()));
        request.insert("isolation".into(), text(isolation.as_str()));
        self.log
            .push(vec![text("history.run"), Value::Object(request)]);
        txn_result(&self.run)
    }
}

/// `[{ req, slides, plans, run }]`
fn txn_call(args: &[Value], cx: &mut Context) -> Answer {
    let world = arg(args, 0).ok_or_else(|| bad("world"))?;
    let log = Log::default();
    let mut session = TxnFake {
        slides: strings(world.get("slides")),
        plans: list(world.get("plans")).iter().cloned().collect(),
        rev: 0,
        log: log.clone(),
    };
    let mut default_run = Map::new();
    default_run.insert("applied".into(), Value::Bool(true));
    let mut history = TxnHist {
        run: world
            .get("run")
            .cloned()
            .unwrap_or(Value::Object(default_run)),
        log: log.clone(),
    };
    let req = world.get("req").unwrap_or(&NULL);
    let result = apply_txn_to_session(&mut session, req, &mut history);
    log.flush_into(cx);
    Ok(Some(result.to_value()))
}

// ---- autofit-writeback ----

fn layout_of(layout: &Value) -> RenderTextLayout {
    let inset = |key: &str| {
        layout
            .get("insets")
            .and_then(|insets| field_f64(insets, key))
            .unwrap_or(0.0)
    };
    RenderTextLayout {
        lines: list(layout.get("lines"))
            .iter()
            .map(|line| TextLine {
                align: field_str(line, "align").map(str::to_owned),
                runs: list(line.get("runs"))
                    .iter()
                    .map(|run| TextRun {
                        x: field_f64(run, "x").unwrap_or(f64::NAN),
                        width_px: field_f64(run, "widthPx").unwrap_or(f64::NAN),
                    })
                    .collect(),
            })
            .collect(),
        insets: TextInsets {
            l: inset("l"),
            t: inset("t"),
            r: inset("r"),
            b: inset("b"),
        },
        content_height: field_f64(layout, "contentHeight").unwrap_or(0.0),
        wrap: value_truthy(layout.get("wrap")),
        vert: field_str(layout, "vert").map(str::to_owned),
    }
}

/// a render slide of the spec: `{ nodes: [{ sourceId, type, box, text? }] }`
impl AutofitRendered for Value {
    fn node_of(&self, source_id: &str) -> Option<TextNode> {
        let node = list(self.get("nodes"))
            .iter()
            .find(|node| field_str(node, "sourceId") == Some(source_id))?;
        let side = |key: &str| {
            node.get("box")
                .and_then(|b| field_f64(b, key))
                .unwrap_or(f64::NAN)
        };
        Some(TextNode {
            node_type: field_str(node, "type").unwrap_or("").to_owned(),
            box_w: side("w"),
            box_h: side("h"),
            text: node
                .get("text")
                .filter(|layout| value_truthy(Some(*layout)))
                .map(layout_of),
        })
    }
}

/// `matchesElementRef` of the spec's stub: the element's id or its `refId`
fn is_element(element: &Value, source_id: &str) -> bool {
    field_str(element, "id") == Some(source_id) || field_str(element, "refId") == Some(source_id)
}

struct AutofitFake {
    slides: Value,
    size: Value,
    fit: f64,
    rebuilt: VecDeque<Value>,
    refit: Value,
    log: Log,
}

impl AutofitFake {
    fn element(&self, slide_index: usize, source_id: &str) -> Option<&Value> {
        self.slides
            .get(slide_index)?
            .get("elements")?
            .as_array()?
            .iter()
            .find(|element| is_element(element, source_id))
    }

    fn element_mut(&mut self, slide_index: usize, source_id: &str) -> Option<&mut Value> {
        self.slides
            .get_mut(slide_index)?
            .get_mut("elements")?
            .as_array_mut()?
            .iter_mut()
            .find(|element| is_element(element, source_id))
    }

    fn text_mut(&mut self, slide_index: usize, source_id: &str) -> Option<&mut Map<String, Value>> {
        self.element_mut(slide_index, source_id)?
            .get_mut("text")?
            .as_object_mut()
    }
}

impl AutofitHost for AutofitFake {
    type Rendered = Value;

    fn find_element(&mut self, slide_index: usize, source_id: &str) -> Option<AutofitElement> {
        let element = self.element(slide_index, source_id)?;
        let body = element.get("text").filter(|t| value_truthy(Some(*t)));
        Some(AutofitElement {
            id: field_str(element, "id").unwrap_or("").to_owned(),
            el_type: field_str(element, "type").unwrap_or("").to_owned(),
            text: body.map(|body| AutofitText {
                autofit: field_str(body, "autofit").map(str::to_owned),
                font_scale: field_f64(body, "fontScale"),
                ln_spc_reduction: field_f64(body, "lnSpcReduction"),
            }),
            offset_x: element
                .get("transform")
                .and_then(|t| t.get("offset"))
                .and_then(|o| field_f64(o, "x"))
                .unwrap_or(f64::NAN),
        })
    }

    fn deck_width_emu(&mut self) -> f64 {
        field_f64(&self.size, "cx").unwrap_or(f64::NAN)
    }

    fn fit_width_px(&mut self) -> f64 {
        self.fit
    }

    fn rebuild_slide(&mut self, slide_index: usize) -> Option<Value> {
        self.log
            .push(vec![text("rebuildSlide"), num(slide_index as f64)]);
        self.rebuilt.pop_front()
    }

    fn write_resized_transform(
        &mut self,
        slide_index: usize,
        source_id: &str,
        x: f64,
        cx: f64,
        cy: f64,
    ) {
        let Some(element) = self.element_mut(slide_index, source_id) else {
            return;
        };
        if let Some(offset) = element
            .get_mut("transform")
            .and_then(|transform| transform.get_mut("offset"))
            .and_then(Value::as_object_mut)
        {
            offset.insert("x".into(), num(x));
            offset.insert("cx".into(), num(cx));
            offset.insert("cy".into(), num(cy));
        }
        if let Some(element) = element.as_object_mut() {
            element.insert("dirtyTransform".into(), Value::Bool(true));
        }
    }

    fn refit_layout(
        &mut self,
        slide_index: usize,
        source_id: &str,
        box_width_px: f64,
        box_height_px: f64,
    ) -> TextRefit {
        let body = self
            .element(slide_index, source_id)
            .and_then(|element| element.get("text"))
            .cloned()
            .unwrap_or(Value::Null);
        let mut viewport = Map::new();
        viewport.insert("size".into(), self.size.clone());
        viewport.insert("fit".into(), num(self.fit));
        let mut options = Map::new();
        options.insert("body".into(), body);
        options.insert("boxWidthPx".into(), num(box_width_px));
        options.insert("boxHeightPx".into(), num(box_height_px));
        options.insert("metrics".into(), text("metrics"));
        options.insert("vp".into(), Value::Object(viewport));
        options.insert("refitAutofit".into(), Value::Bool(true));
        self.log
            .push(vec![text("layoutText"), Value::Object(options)]);
        TextRefit {
            font_scale: field_f64(&self.refit, "fontScale").unwrap_or(f64::NAN),
            ln_spc_reduction: field_f64(&self.refit, "lnSpcReduction"),
        }
    }

    fn set_font_scale(&mut self, slide_index: usize, source_id: &str, value: f64) {
        if let Some(body) = self.text_mut(slide_index, source_id) {
            body.insert("fontScale".into(), num(value));
        }
    }

    fn set_ln_spc_reduction(&mut self, slide_index: usize, source_id: &str, value: Option<f64>) {
        if let Some(body) = self.text_mut(slide_index, source_id) {
            match value {
                Some(value) => {
                    body.insert("lnSpcReduction".into(), num(value));
                }
                None => {
                    body.shift_remove("lnSpcReduction");
                }
            }
        }
    }

    fn patch_body_pr_autofit(
        &mut self,
        slide_index: usize,
        source_id: &str,
        font_scale: f64,
        ln_spc_reduction: f64,
    ) {
        let xml = self
            .element(slide_index, source_id)
            .and_then(|element| element.get("anchor"))
            .and_then(|anchor| field_str(anchor, "originalXml"))
            .unwrap_or("")
            .to_owned();
        self.log.push(vec![
            text("patchBodyPrAutofit"),
            text(&xml),
            num(font_scale),
            num(ln_spc_reduction),
        ]);
        let patched = format!(
            "PATCH({xml}|{}|{})",
            number_to_string(font_scale),
            number_to_string(ln_spc_reduction)
        );
        if let Some(anchor) = self
            .element_mut(slide_index, source_id)
            .and_then(|element| element.get_mut("anchor"))
            .and_then(Value::as_object_mut)
        {
            anchor.insert("originalXml".into(), text(&patched));
        }
    }

    fn mark_structure_dirty(&mut self, slide_index: usize) {
        if let Some(slide) = self
            .slides
            .get_mut(slide_index)
            .and_then(Value::as_object_mut)
        {
            slide.insert("structureDirty".into(), Value::Bool(true));
        }
    }
}

/// `[{ slides, size?, fitWidthPx?, index?, sourceId, rendered, rebuilt?, refit? }]`;
/// `resize` picks `applyAutofitResize`, else `syncAutofitScale`
fn autofit_call(args: &[Value], cx: &mut Context, resize: bool) -> Answer {
    let world = arg(args, 0).ok_or_else(|| bad("world"))?;
    let log = Log::default();
    let mut default_size = Map::new();
    default_size.insert("cx".into(), num(9525.0 * 960.0));
    let mut session = AutofitFake {
        slides: world.get("slides").cloned().unwrap_or(Value::Null),
        size: world
            .get("size")
            .cloned()
            .unwrap_or(Value::Object(default_size)),
        fit: field_f64(world, "fitWidthPx").unwrap_or(960.0),
        rebuilt: list(world.get("rebuilt")).iter().cloned().collect(),
        refit: world.get("refit").cloned().unwrap_or(Value::Null),
        log: log.clone(),
    };
    let index = field_f64(world, "index").unwrap_or(0.0);
    let source_id = field_str(world, "sourceId").ok_or_else(|| bad("sourceId"))?;
    let rendered = world
        .get("rendered")
        .filter(|value| !value.is_null())
        .cloned();
    // an index no slide has finds none: a number that is no index
    let index = if index >= 0.0 && index.fract() == 0.0 {
        index as usize
    } else {
        usize::MAX
    };
    let result = if resize {
        apply_autofit_resize(&mut session, index, source_id, rendered)
    } else {
        sync_autofit_scale(&mut session, index, source_id, rendered)
    };
    log.flush_into(cx);
    let mut out = Map::new();
    out.insert("result".into(), result.unwrap_or(Value::Null));
    out.insert("slides".into(), session.slides);
    Ok(Some(Value::Object(out)))
}

// ---- seed-deck ----

fn identity_in(value: &Value) -> RecoveryIdentity {
    let kind = field_str(value, "kind").unwrap_or_default().to_owned();
    // `'filePath' in identity`
    if value.get("filePath").is_some() {
        RecoveryIdentity::File(RecoveryFileIdentity {
            kind,
            file_path: field_str(value, "filePath").unwrap_or_default().to_owned(),
        })
    } else {
        RecoveryIdentity::Untitled(RecoveryUntitledIdentity {
            kind,
            untitled_id: field_str(value, "untitledId")
                .unwrap_or_default()
                .to_owned(),
            ext: field_str(value, "ext").unwrap_or_default().to_owned(),
        })
    }
}

fn identity_value(identity: &RecoveryIdentity) -> Value {
    let mut map = Map::new();
    match identity {
        RecoveryIdentity::File(file) => {
            map.insert("kind".into(), text(&file.kind));
            map.insert("filePath".into(), text(&file.file_path));
        }
        RecoveryIdentity::Untitled(untitled) => {
            map.insert("kind".into(), text(&untitled.kind));
            map.insert("untitledId".into(), text(&untitled.untitled_id));
            map.insert("ext".into(), text(&untitled.ext));
        }
    }
    Value::Object(map)
}

/// a webContents of the spec: `once` and `send` are log lines
struct SeedWc {
    id: f64,
    destroyed: Cell<bool>,
    log: Log,
}

impl HandoffWebContents for SeedWc {
    fn id(&self) -> f64 {
        self.id
    }

    fn is_destroyed(&self) -> bool {
        self.destroyed.get()
    }

    fn once_destroyed(&mut self) {
        self.log
            .push(vec![text("once"), num(self.id), text("destroyed")]);
    }
}

impl SeedContents for SeedWc {
    fn is_destroyed(&self) -> bool {
        self.destroyed.get()
    }

    fn send(&mut self, channel: &str, payload: &Value) {
        self.log.push(vec![
            text("send"),
            num(self.id),
            text(channel),
            payload.clone(),
        ]);
    }
}

struct SeedFake {
    log: Log,
    opened: Value,
    slides: Vec<Value>,
    open_throws: bool,
    default_font: Option<String>,
    sessions: Vec<(f64, Value)>,
}

impl SeedFake {
    fn session_of(&self, wc_id: f64) -> Value {
        self.sessions
            .iter()
            .find(|(id, _)| *id == wc_id)
            .map(|(_, session)| session.clone())
            .unwrap_or(Value::Null)
    }

    fn opened_of(&self, wc_id: f64) -> Value {
        self.session_of(wc_id)
            .get("opened")
            .cloned()
            .unwrap_or(Value::Null)
    }
}

impl SeedDeckHost for SeedFake {
    type Opened = Value;
    type Session = Value;

    fn shaped_metrics_ready(&mut self) {
        self.log.push(vec![text("shapedMetricsReady")]);
    }

    fn open_pptx(&mut self, bytes: &[u8]) -> Result<Value, String> {
        self.log.push(vec![text("openPptx"), text(&hex(bytes))]);
        if self.open_throws {
            return Err("not a deck".to_owned());
        }
        Ok(self.opened.clone())
    }

    fn new_session(&mut self, fields: SeedSession, opened: Value) -> Value {
        let mut map = Map::new();
        map.insert("path".into(), text(&fields.path));
        map.insert("opened".into(), opened);
        map.insert("fitWidthPx".into(), num(fields.fit_width_px));
        map.insert("undoStack".into(), Value::Array(Vec::new()));
        map.insert("redoStack".into(), Value::Array(Vec::new()));
        if fields.ask_path_on_first_save {
            map.insert("askPathOnFirstSave".into(), Value::Bool(true));
        }
        // the TypeScript sets both keys together; the port decides when the name is kept
        if let Some(name) = &fields.first_save_name {
            map.insert("firstSaveName".into(), text(name));
        }
        if let Some(identity) = &fields.recovery_id {
            map.insert("recoveryId".into(), identity_value(identity));
        }
        if let Some(password) = &fields.password {
            map.insert("password".into(), text(password));
        }
        Value::Object(map)
    }

    fn mark_meta_dirty(&mut self, session: &mut Value) {
        self.log.push(vec![text("markMetaDirty"), session.clone()]);
    }

    fn set_session(&mut self, wc_id: f64, session: Value) {
        self.log
            .push(vec![text("sessions.set"), num(wc_id), session.clone()]);
        self.sessions.push((wc_id, session));
    }

    fn schedule_history_notify(&mut self, wc_id: f64) {
        let session = self.session_of(wc_id);
        self.log.push(vec![text("scheduleHistoryNotify"), session]);
    }

    fn build_all_render_slides(&mut self, wc_id: f64, fit_width_px: f64) -> Vec<Value> {
        let opened = self.opened_of(wc_id);
        self.log.push(vec![
            text("buildAllRenderSlides"),
            opened,
            num(fit_width_px),
        ]);
        self.slides.clone()
    }

    fn deck_size(&mut self, wc_id: f64) -> (f64, f64) {
        let size = self
            .opened_of(wc_id)
            .get("deck")
            .and_then(|deck| deck.get("size"))
            .cloned()
            .unwrap_or(Value::Null);
        (
            field_f64(&size, "cx").unwrap_or(f64::NAN),
            field_f64(&size, "cy").unwrap_or(f64::NAN),
        )
    }

    fn default_font_of(&mut self, wc_id: f64) -> Option<String> {
        let opened = self.opened_of(wc_id);
        self.log.push(vec![text("defaultFontOf"), opened]);
        self.default_font.clone()
    }
}

/// `[{ queueId?, takeId, deck?, options?, opened?, slides?, defaultFont?,
/// openThrows?, destroyedBefore?, again?, fit?, destroyedAtQueue? }]`
fn seed_call(args: &[Value], cx: &mut Context) -> Answer {
    let world = arg(args, 0).ok_or_else(|| bad("world"))?;
    let log = Log::default();
    let take_id = field_f64(world, "takeId").ok_or_else(|| bad("takeId"))?;
    let mut queue = SeedQueue::new();
    if let Some(queue_id) = field_f64(world, "queueId") {
        let options = world.get("options").unwrap_or(&NULL);
        let deck = field_str(world, "deck").unwrap_or("504b0304");
        let bytes = (0..deck.len() / 2)
            .map(|i| u8::from_str_radix(&deck[2 * i..2 * i + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
            .map_err(|_| bad("deck"))?;
        let mut queued = SeedWc {
            id: queue_id,
            destroyed: Cell::new(field_bool(world, "destroyedAtQueue")),
            log: log.clone(),
        };
        queue.queue_slides_seed_for(
            &mut queued,
            bytes,
            SlidesSeedOptions {
                ask_path_on_first_save: options.get("askPathOnFirstSave").and_then(Value::as_bool),
                suggested_name: field_str(options, "suggestedName").map(str::to_owned),
                recovery_id: options.get("recoveryId").map(identity_in),
                password: field_str(options, "password").map(str::to_owned),
            },
        );
    }
    let default_font = match world.get("defaultFont") {
        Some(Value::Null) => None,
        Some(Value::String(font)) => Some(font.clone()),
        _ => Some("Calibri".to_owned()),
    };
    let mut host = SeedFake {
        log: log.clone(),
        opened: world.get("opened").cloned().unwrap_or_else(|| {
            let mut size = Map::new();
            size.insert("cx".into(), num(9_144_000.0));
            size.insert("cy".into(), num(5_143_500.0));
            let mut deck = Map::new();
            deck.insert("size".into(), Value::Object(size));
            let mut opened = Map::new();
            opened.insert("deck".into(), Value::Object(deck));
            Value::Object(opened)
        }),
        slides: match world.get("slides") {
            Some(Value::Array(slides)) => slides.clone(),
            _ => {
                let mut slide = Map::new();
                slide.insert("id".into(), text("r1"));
                vec![Value::Object(slide)]
            }
        },
        open_throws: field_bool(world, "openThrows"),
        default_font,
        sessions: Vec::new(),
    };
    let fit = field_f64(world, "fit").unwrap_or(960.0);
    let mut wc = SeedWc {
        id: take_id,
        destroyed: Cell::new(false),
        log: log.clone(),
    };
    let mut results: Vec<Value> = Vec::new();
    let mut deferred: Vec<DeckChanged> = Vec::new();
    let mut take = |host: &mut SeedFake, queue: &mut SeedQueue| match open_slides_seed(
        host, queue, take_id, fit,
    ) {
        Ok(Some(open)) => {
            results.push(open.result.to_value());
            deferred.push(open.deck_changed);
        }
        Ok(None) => results.push(Value::Null),
        Err(message) => {
            let mut threw = Map::new();
            threw.insert("threw".into(), text(&message));
            results.push(Value::Object(threw));
        }
    };
    take(&mut host, &mut queue);
    if field_bool(world, "destroyedBefore") {
        wc.destroyed.set(true);
    }
    if field_bool(world, "again") {
        take(&mut host, &mut queue);
    }
    // the `setImmediate` callbacks
    for message in &deferred {
        message.deliver(&mut wc);
    }
    log.flush_into(cx);
    Ok(Some(Value::Array(results)))
}

// ---- document-links-shell ----

type Shared = Rc<RefCell<Value>>;

/// what the fakes of the scenario share
#[derive(Clone)]
struct ShellEnv {
    world: Shared,
    log: Log,
    /// the webContents ids `once('destroyed')` was given a listener for
    onces: Rc<RefCell<Vec<f64>>>,
    user_data: String,
}

impl ShellEnv {
    fn wc(&self, id: f64) -> FakeWc {
        FakeWc {
            id,
            env: self.clone(),
        }
    }

    fn doc_of(&self, spec: Option<&Value>) -> Option<LinkedDocument<FakeWc>> {
        let spec = spec.filter(|spec| spec.is_object())?;
        Some(LinkedDocument {
            web_contents: self.wc(field_f64(spec, "wc")?),
            file_path: field_str(spec, "filePath").map(str::to_owned),
            title: field_str(spec, "title").unwrap_or("").to_owned(),
        })
    }

    fn now(&self) -> f64 {
        field_f64(&self.world.borrow(), "now").unwrap_or(0.0)
    }
}

struct FakeWc {
    id: f64,
    env: ShellEnv,
}

impl crate::shell::document_links::LinkedWebContents for FakeWc {
    fn id(&self) -> f64 {
        self.id
    }

    fn once_destroyed(&mut self) {
        self.env
            .log
            .push(vec![text("once"), num(self.id), text("destroyed")]);
        self.env.onces.borrow_mut().push(self.id);
    }
}

impl DocumentContents for FakeWc {
    fn is_destroyed(&self) -> bool {
        list(self.env.world.borrow().get("destroyed"))
            .iter()
            .any(|id| id.as_f64() == Some(self.id))
    }
}

struct FakeHost {
    env: ShellEnv,
}

impl FakeHost {
    /// `world[table][key]`, cloned
    fn lookup(&self, table: &str, key: &str) -> Option<Value> {
        self.env
            .world
            .borrow()
            .get(table)
            .and_then(|t| t.get(key))
            .cloned()
    }
}

impl DocumentLinksShellHost for FakeHost {
    type Contents = FakeWc;
    type Window = f64;

    fn user_data_path(&mut self) -> String {
        self.env.log.push(vec![text("userDataPath")]);
        self.env.user_data.clone()
    }

    fn active_document(&mut self, kind: TabKind) -> Option<LinkedDocument<FakeWc>> {
        self.env
            .log
            .push(vec![text("activeDocument"), text(kind.as_str())]);
        let spec = self.lookup("active", kind.as_str());
        self.env.doc_of(spec.as_ref())
    }

    fn document_for(&mut self, contents: &FakeWc) -> Option<LinkedDocument<FakeWc>> {
        self.env
            .log
            .push(vec![text("documentFor"), num(contents.id)]);
        let spec = self.lookup("docs", &number_to_string(contents.id));
        self.env.doc_of(spec.as_ref())
    }

    fn parent_for(&mut self, contents: &FakeWc) -> Option<f64> {
        self.env.log.push(vec![text("parentFor"), num(contents.id)]);
        let parent = self.lookup("parents", &number_to_string(contents.id));
        if value_truthy(parent.as_ref()) {
            Some(contents.id)
        } else {
            None
        }
    }

    fn open_path(&mut self, path: &str) {
        self.env.log.push(vec![text("openPath"), text(path)]);
    }

    fn labels(&mut self) -> DocumentLinkMenuLabels {
        self.env.log.push(vec![text("labels")]);
        DocumentLinkMenuLabels {
            make: "Make".to_owned(),
            sources: "View Sources".to_owned(),
            derived: "Made from This".to_owned(),
        }
    }

    fn menu_kind(&mut self) -> Option<TabKind> {
        self.env.log.push(vec![text("menuKind")]);
        self.env
            .world
            .borrow()
            .get("menuKind")
            .and_then(Value::as_str)
            .and_then(TabKind::parse)
    }

    fn apply_menu(&mut self, kind: TabKind) {
        self.env
            .log
            .push(vec![text("applyMenu"), text(kind.as_str())]);
    }

    fn open_generate_window_for_document(&mut self, request: GenerateWindowRequest<f64>) {
        let mut map = Map::new();
        map.insert("webContentsId".into(), num(request.web_contents_id));
        if let Some(path) = &request.file_path {
            map.insert("filePath".into(), text(path));
        }
        map.insert("title".into(), text(&request.title));
        map.insert(
            "parent".into(),
            if request.parent.is_some() {
                text("window")
            } else {
                Value::Null
            },
        );
        self.env
            .log
            .push(vec![text("openGenerateWindow"), Value::Object(map)]);
    }

    fn path_exists(&mut self, path: &str) -> bool {
        std::path::Path::new(path).exists()
    }

    fn stat(&mut self, path: &str) -> Result<StatTimes, String> {
        stat_sync(path)
    }

    fn now_ms(&mut self) -> f64 {
        self.env.now()
    }

    fn is_mac(&self) -> bool {
        cfg!(target_os = "macos")
    }
}

/// the item of a menu a click names: `"make"`, or `[group, index]` of a submenu
fn click_of(
    items: &[crate::shell::document_links_menu::MenuItem],
    click: &Value,
) -> Option<MenuClick> {
    match click {
        Value::String(name) if name.as_str() == "make" => items
            .iter()
            .find(|item| item.id == Some("document-links-make"))?
            .click
            .clone(),
        Value::Array(pair) => {
            let group = format!("document-links-{}", pair.first()?.as_str()?);
            let at = pair.get(1)?.as_f64()?;
            let group = items.iter().find(|item| item.id == Some(group.as_str()))?;
            group.submenu.as_ref()?.get(at as usize)?.click.clone()
        }
        _ => None,
    }
}

/// `[world, steps, userData, linksFile | null]`
fn shell_call(args: &[Value], cx: &mut Context) -> Answer {
    let world = arg(args, 0).ok_or_else(|| bad("world"))?.clone();
    let steps = arg(args, 1)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("steps"))?;
    let user_data = str_arg(args, 2)?.to_owned();
    if let Some(links_file) = arg(args, 3).filter(|file| !file.is_null()) {
        let mut body = String::new();
        print_js(links_file, &mut body);
        std::fs::write(join(&[&user_data, DOCUMENT_LINKS_FILE]), body)
            .map_err(|_| bad("links file"))?;
    }
    let log = Log::default();
    let env = ShellEnv {
        world: Rc::new(RefCell::new(world)),
        log: log.clone(),
        onces: Rc::new(RefCell::new(Vec::new())),
        user_data,
    };
    let store = Rc::new(RefCell::new(HandoffStore::new(cfg!(windows))));
    let mut shell: DocumentLinksShell<FakeHost, FileLinksDeps<'static>> = DocumentLinksShell::new();
    let mut results: Vec<Value> = Vec::new();
    let outcome = (|| -> Result<(), CallError> {
        for step in steps {
            let name = step
                .get(0)
                .and_then(Value::as_str)
                .ok_or_else(|| bad("step"))?;
            let at = |i: usize| step.get(i);
            let before = results.len();
            match name {
                "configure" => {
                    let host = FakeHost { env: env.clone() };
                    let now = env.now();
                    let events = store.clone();
                    let watched = store.clone();
                    let tabs_env = env.clone();
                    shell.configure(
                        host,
                        move |file: &str| {
                            document_links_at(
                                file,
                                Box::new(move || handoff_store_events(&events.borrow())),
                                Box::new(move || now),
                                Box::new(|_: &str, _: &str| {}),
                            )
                        },
                        move |on_event| {
                            watch_make_events(
                                &mut watched.borrow_mut(),
                                Box::new(move |id| {
                                    tabs_env.log.push(vec![text("tabIdFor"), num(id)]);
                                    tabs_env
                                        .world
                                        .borrow()
                                        .get("tabs")
                                        .and_then(|tabs| tabs.get(number_to_string(id)))
                                        .and_then(Value::as_str)
                                        .map(str::to_owned)
                                }),
                                on_event,
                            )
                        },
                    );
                }
                "set" => {
                    if let Some(Value::Object(patch)) = at(1) {
                        let mut world = env.world.borrow_mut();
                        if let Some(map) = world.as_object_mut() {
                            for (key, value) in patch {
                                map.insert(key.clone(), value.clone());
                            }
                        }
                    }
                }
                "note" => {
                    let id = at(1).and_then(Value::as_f64).ok_or_else(|| bad("wc"))?;
                    let path = at(2).and_then(Value::as_str).ok_or_else(|| bad("path"))?;
                    let may_be_open = at(3).and_then(Value::as_bool);
                    let mut wc = env.wc(id);
                    shell
                        .note_document_saved(&mut wc, path, may_be_open)
                        .map_err(|_| CallError::plain("Invalid time value"))?;
                }
                "converted" => {
                    let id = at(1).and_then(Value::as_f64).ok_or_else(|| bad("wc"))?;
                    let sources = strings(at(2));
                    store
                        .borrow_mut()
                        .record_generate_converted(
                            id,
                            GenerateConvertTarget::Markdown,
                            GenerateConvertKind::MindmapToMarkdown,
                            &sources,
                            "c",
                            env.now(),
                        )
                        .map_err(CallError::plain)?;
                }
                "destroy" => {
                    let id = at(1).and_then(Value::as_f64).ok_or_else(|| bad("wc"))?;
                    {
                        let mut world = env.world.borrow_mut();
                        if let Some(destroyed) =
                            world.get_mut("destroyed").and_then(Value::as_array_mut)
                        {
                            destroyed.push(num(id));
                        }
                    }
                    let held = env
                        .onces
                        .borrow()
                        .iter()
                        .filter(|held| **held == id)
                        .count();
                    env.onces.borrow_mut().retain(|held| *held != id);
                    for _ in 0..held {
                        if let Some(links) = shell.document_links() {
                            links.tab_destroyed(id);
                        }
                    }
                }
                "moved" => {
                    let old = at(1).and_then(Value::as_str).ok_or_else(|| bad("old"))?;
                    let new = at(2).and_then(Value::as_str).ok_or_else(|| bad("new"))?;
                    shell.document_link_file_moved(old, new);
                }
                "paths" => results.push(strings_value(&shell.document_link_paths())),
                "sync" => shell
                    .sync_document_links()
                    .map_err(|_| CallError::plain("Invalid time value"))?,
                "make" => {
                    let id = at(1).and_then(Value::as_f64).ok_or_else(|| bad("wc"))?;
                    shell.make_from_document(&env.wc(id));
                }
                "refresh" => shell.refresh_document_link_menu(),
                "links" => results.push(match shell.document_links() {
                    Some(links) => Value::Array(links.links().iter().map(to_value).collect()),
                    None => Value::Null,
                }),
                "menu" => {
                    let kind = at(1)
                        .and_then(Value::as_str)
                        .and_then(TabKind::parse)
                        .ok_or_else(|| bad("kind"))?;
                    let menu = shell.document_link_file_menu_items(kind);
                    results.push(to_value(&menu.items));
                    if let Some(contents) = &menu.contents {
                        for click in list(at(2)) {
                            if let Some(click) = click_of(&menu.items, click) {
                                shell.run_menu_click(&click, contents);
                            }
                        }
                    }
                }
                _ => return Err(bad("step")),
            }
            shell
                .flush_make_events()
                .map_err(|_| CallError::plain("Invalid time value"))?;
            if results.len() == before {
                results.push(Value::Null);
            }
        }
        Ok(())
    })();
    log.flush_into(cx);
    outcome?;
    Ok(Some(Value::Array(results)))
}
