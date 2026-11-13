//! The functions of group `b2-print` (tools/main-diff/groups/b2-print.ts).
//!
//! Processes and Electron windows are fakes the comparison hands to both
//! sides. A command is looked up in a table by its command line (`file` and
//! the arguments joined by a space); a window is driven by a script of
//! outcomes. Both log each call, one `logs` line per call, in the same form as
//! the TypeScript's fakes.
//!
//! The hand-off store is global state in the TypeScript. A call of its
//! functions runs the setup steps given as its first argument on a fresh store
//! (`{ op, args }`, where `op` names a function of the module or one of the
//! comparison's own: `emitDestroyed`, `setPlatform`), then the function itself
//! with the remaining arguments, and answers `{ result?, state }`.

use super::fakes::{FakePrintRenderer, drive_load, drive_print};
use super::{Answer, CallError, Context, arg, str_arg};
use crate::packages::electron_utils::generate_handoff::{
    self, GenerateConvertKind, GenerateConvertTarget, GenerateHandoff, GenerateHandoffTarget,
    HandoffStore, HandoffWebContents, SkillHandoff, handoff_editor_for_file,
};
use crate::packages::electron_utils::handoff_editors::{
    HANDOFF_ATTACH_EDITORS, HANDOFF_EDITORS, HandoffEditor, handoff_editor_takes_attachments,
    is_handoff_editor,
};
use crate::packages::electron_utils::headless_export::{
    self, DIAGRAM_BATCH_MODES, DIAGRAM_FILE_TARGETS, HEADLESS_EXIT_BAD_ARGS,
    HEADLESS_EXIT_CONVERSION_FAILURE, HEADLESS_EXIT_INPUT_ERROR, HEADLESS_EXIT_SUCCESS,
    HEADLESS_EXPORT_FLAG, HEADLESS_SUPPORTED_EXTENSIONS, HeadlessExportOutcome,
    HeadlessWaitOptions, StallMessage, document_fonts_settled, format_headless_envelope,
    headless_exit_code, headless_module_for, headless_sleep, headless_summary, headless_targets,
    is_diagram_file_target, parse_headless_export_argv, poll_until_ready,
    run_headless_renderer_export,
};
use crate::packages::electron_utils::headless_mode::HeadlessMode;
use crate::packages::electron_utils::print_cups::{
    CupsPrintJob, DriverOption, DuplexMode, PrintToPdfRequest, lp_arguments_for,
    print_pdf_via_cups, print_to_pdf_options_for,
};
use crate::packages::electron_utils::print_html_pdf::{
    PrintWindow, build_printable_html, parse_and_serialize, print_html_to_pdf,
    sanitize_printable_body,
};
use crate::packages::electron_utils::print_job::{print_job_options, print_outcome};
use crate::packages::electron_utils::print_window::{
    ExecOutcome, JsError, PRINT_READY_SCRIPT, PrintDialogWindow, PrintDocumentOptions, PrintReport,
    begin_load_print_html, begin_print, rm_recursive_force,
};
use crate::packages::electron_utils::printer_options::{
    CommandOutcome, DRIVER_OPTION_NAMES, is_valid_option_name, is_valid_option_value,
    parse_lp_options, query_printer_options,
};
use jscompat::{js_regex, number_to_string};
use serde::Serialize;
use serde_json::{Map, Number, Value};
use std::cell::{Cell, RefCell};

type Logs = RefCell<Vec<Vec<Value>>>;

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // printer-options.ts
        "printer-options.DRIVER_OPTION_NAMES" => Ok(Some(strings(&DRIVER_OPTION_NAMES))),
        "printer-options.isValidOptionName" => Ok(Some(Value::Bool(
            arg(args, 0)
                .and_then(Value::as_str)
                .is_some_and(is_valid_option_name),
        ))),
        "printer-options.isValidOptionValue" => Ok(Some(Value::Bool(
            arg(args, 0)
                .and_then(Value::as_str)
                .is_some_and(is_valid_option_value),
        ))),
        "printer-options.parseLpOptions" => {
            str_arg(args, 0).map(|raw| Some(to_value(&parse_lp_options(raw))))
        }
        "printer-options.queryPrinterOptions" => query_options_call(args, cx),
        // print-cups.ts
        "print-cups.lpArgumentsFor" => cups_job(arg(args, 0)).map(|job| {
            Some(Value::Array(
                lp_arguments_for(&job)
                    .into_iter()
                    .map(Value::from)
                    .collect(),
            ))
        }),
        "print-cups.printToPdfOptionsFor" => pdf_request(arg(args, 0))
            .map(|request| Some(print_to_pdf_options_for(&request).to_value())),
        "print-cups.printPdfViaCups" => cups_call(args, cx),
        // print-job.ts
        "print-job.printJobOptions" => Ok(Some(to_value(&print_job_options(arg(args, 0))))),
        "print-job.printOutcome" => print_outcome_call(args),
        // print-window.ts
        "print-window.PRINT_READY_SCRIPT" => Ok(Some(Value::from(PRINT_READY_SCRIPT))),
        "print-window.loadPrintHtml" => load_print_html_call(args, cx),
        "print-window.printHtmlDocument" => print_html_document_call(args, cx),
        // print-html-pdf.ts
        "print-html-pdf.sanitizePrintableBody" => {
            str_arg(args, 0).map(|html| Some(Value::from(sanitize_printable_body(html))))
        }
        "print-html-pdf.buildPrintableHtml" => str_arg(args, 0).and_then(|title| {
            let body = str_arg(args, 1)?;
            Ok(Some(Value::from(build_printable_html(title, body))))
        }),
        "print-html-pdf.printHtmlToPdf" => print_html_to_pdf_call(args, cx),
        "print-html-pdf.parseSerialize" => {
            str_arg(args, 0).map(|html| Some(Value::from(parse_and_serialize(html))))
        }
        // headless-mode.ts
        "headless-mode.setHeadlessMode" | "headless-mode.isHeadlessMode" => {
            let mode = HeadlessMode::new();
            match arg(args, 0) {
                Some(Value::Bool(on)) => mode.set_headless_mode(*on),
                // no set: the state a new store starts in
                Some(Value::Null) if name == "headless-mode.isHeadlessMode" => {}
                _ => return Some(Err(bad("a flag"))),
            }
            Ok(Some(Value::Bool(mode.is_headless_mode())))
        }
        // handoff-editors.ts, and its re-export by generate-handoff.ts
        "handoff-editors.HANDOFF_EDITORS" | "generate-handoff.HANDOFF_EDITORS" => {
            Ok(Some(Value::Array(
                HANDOFF_EDITORS
                    .iter()
                    .map(|e| Value::from(e.as_str()))
                    .collect(),
            )))
        }
        "handoff-editors.HANDOFF_ATTACH_EDITORS" => Ok(Some(Value::Array(
            HANDOFF_ATTACH_EDITORS
                .iter()
                .map(|e| Value::from(e.as_str()))
                .collect(),
        ))),
        "handoff-editors.isHandoffEditor" | "generate-handoff.isHandoffEditor" => {
            Ok(Some(Value::Bool(
                arg(args, 0)
                    .and_then(Value::as_str)
                    .is_some_and(is_handoff_editor),
            )))
        }
        "handoff-editors.handoffEditorTakesAttachments"
        | "generate-handoff.handoffEditorTakesAttachments" => Ok(Some(Value::Bool(
            arg(args, 0)
                .and_then(Value::as_str)
                .and_then(HandoffEditor::parse)
                .is_some_and(handoff_editor_takes_attachments),
        ))),
        // headless-export.ts
        "headless-export.DIAGRAM_FILE_TARGETS" => Ok(Some(strings(&DIAGRAM_FILE_TARGETS))),
        "headless-export.DIAGRAM_BATCH_MODES" => Ok(Some(strings(&DIAGRAM_BATCH_MODES))),
        "headless-export.HEADLESS_TARGETS" => Ok(Some(targets_value())),
        "headless-export.isDiagramFileTarget" => Ok(Some(Value::Bool(
            arg(args, 0)
                .and_then(Value::as_str)
                .is_some_and(is_diagram_file_target),
        ))),
        "headless-export.HEADLESS_EXPORT_FLAG" => Ok(Some(Value::from(HEADLESS_EXPORT_FLAG))),
        "headless-export.HEADLESS_EXIT" => Ok(Some(exit_value())),
        "headless-export.headlessModuleFor" => str_arg(args, 0)
            .map(|path| Some(headless_module_for(path).map_or(Value::Null, Value::from))),
        "headless-export.HEADLESS_SUPPORTED_EXTENSIONS" => {
            Ok(Some(Value::from(HEADLESS_SUPPORTED_EXTENSIONS)))
        }
        "headless-export.parseHeadlessExportArgv" => {
            str_list(args, 0).map(|argv| Some(parse_headless_export_argv(&argv).to_value()))
        }
        "headless-export.headlessSummary" => {
            outcome_arg(args, 0).map(|o| Some(Value::from(headless_summary(&o))))
        }
        "headless-export.formatHeadlessEnvelope" => outcome_arg(args, 0).map(|o| {
            let json = matches!(arg(args, 1), Some(Value::Bool(true)));
            Some(Value::from(format_headless_envelope(&o, json)))
        }),
        "headless-export.headlessExitCode" => {
            outcome_arg(args, 0).map(|o| Some(num(headless_exit_code(&o))))
        }
        "headless-export.headlessSleep" => sleep_call(args, cx),
        "headless-export.pollUntilReady" => poll_call(args, cx),
        "headless-export.documentFontsSettled" => fonts_call(args, cx),
        "headless-export.runHeadlessRendererExport" => renderer_export_call(args, cx),
        // generate-handoff.ts
        "generate-handoff.handoffEditorForFile" => str_arg(args, 0)
            .map(|file| handoff_editor_for_file(file).map(|e| Value::from(e.as_str()))),
        "generate-handoff.queueGenerateHandoff"
        | "generate-handoff.queueGenerateHandoffFor"
        | "generate-handoff.takeGenerateHandoff"
        | "generate-handoff.dropGenerateHandoff"
        | "generate-handoff.queueSkillHandoff"
        | "generate-handoff.queueSkillHandoffFor"
        | "generate-handoff.takeSkillHandoff"
        | "generate-handoff.queuedSkillHandoffs"
        | "generate-handoff.queuedGenerateHandoffs"
        | "generate-handoff.setGenerateTabIdResolver"
        | "generate-handoff.reportGenerateRunStarted"
        | "generate-handoff.generateRunStartedEvents"
        | "generate-handoff.recordGenerateConverted"
        | "generate-handoff.generateConvertedEvents"
        | "generate-handoff.resetGenerateHandoffsForTest" => handoff_call(name, args, cx),
        _ => return None,
    })
}

fn bad(what: &str) -> CallError {
    CallError::plain(format!("unsupported argument: {what}"))
}

fn num(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

fn to_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("a value prints")
}

fn strings(items: &[&str]) -> Value {
    Value::Array(items.iter().map(|s| Value::from(*s)).collect())
}

fn str_list(args: &[Value], i: usize) -> Result<Vec<String>, CallError> {
    arg(args, i)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("a list"))?
        .iter()
        .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a string")))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Result<Vec<u8>, CallError> {
    if !text.len().is_multiple_of(2) || !text.is_ascii() {
        return Err(bad("hex"));
    }
    (0..text.len() / 2)
        .map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).map_err(|_| bad("hex")))
        .collect()
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

/// `process.platform`
fn process_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

// ---- processes ----

/// The fake process table: `{ "<command line>": { code?, stdout?, stderr?, error? } }`.
fn table_runner<'a>(
    table: &'a Value,
    logs: &'a Logs,
) -> impl FnMut(&str, &[String], Option<&[u8]>) -> CommandOutcome + 'a {
    move |file, args, stdin| {
        let mut parts = vec![file.to_owned()];
        parts.extend(args.iter().cloned());
        let line = parts.join(" ");
        logs.borrow_mut().push(vec![
            Value::from("run"),
            Value::from(file),
            Value::Array(args.iter().cloned().map(Value::from).collect()),
            stdin.map_or(Value::Null, |bytes| Value::from(hex(bytes))),
        ]);
        let Some(entry) = table.get(&line) else {
            return CommandOutcome::Failed(format!("no such command: {line}"));
        };
        if let Some(message) = entry.get("error").and_then(Value::as_str) {
            return CommandOutcome::Failed(message.to_owned());
        }
        let code = match entry.get("code") {
            None => Some(0),
            Some(Value::Number(n)) => n.as_f64().map(|code| code as i32),
            _ => None,
        };
        let text = |name: &str| {
            entry
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or("")
                .as_bytes()
                .to_vec()
        };
        CommandOutcome::Exited {
            code,
            stdout: text("stdout"),
            stderr: text("stderr"),
        }
    }
}

fn finish(cx: &mut Context, logs: Logs) {
    cx.logs.extend(logs.into_inner());
}

/// `[queue, table]`
fn query_options_call(args: &[Value], cx: &mut Context) -> Answer {
    let queue = str_arg(args, 0)?;
    let table = arg(args, 1).ok_or_else(|| bad("a table"))?;
    let logs: Logs = RefCell::new(Vec::new());
    let options = query_printer_options(queue, &mut table_runner(table, &logs));
    finish(cx, logs);
    Ok(Some(to_value(&options)))
}

fn cups_job(job: Option<&Value>) -> Result<CupsPrintJob, CallError> {
    let job = job.and_then(Value::as_object).ok_or_else(|| bad("a job"))?;
    let mut out = CupsPrintJob::default();
    match job.get("deviceName") {
        None => {}
        Some(Value::String(name)) => out.device_name = Some(name.clone()),
        Some(_) => return Err(bad("deviceName")),
    }
    match job.get("copies") {
        None => {}
        Some(Value::Number(n)) => out.copies = n.as_f64(),
        Some(_) => return Err(bad("copies")),
    }
    match job.get("collate") {
        None => {}
        Some(Value::Bool(on)) => out.collate = Some(*on),
        Some(_) => return Err(bad("collate")),
    }
    match job.get("duplexMode").map(Value::as_str) {
        None => {}
        Some(Some("simplex")) => out.duplex_mode = Some(DuplexMode::Simplex),
        Some(Some("longEdge")) => out.duplex_mode = Some(DuplexMode::LongEdge),
        Some(Some("shortEdge")) => out.duplex_mode = Some(DuplexMode::ShortEdge),
        Some(_) => return Err(bad("duplexMode")),
    }
    match job.get("driverOptions") {
        None => {}
        Some(Value::Array(items)) => {
            let mut options = Vec::new();
            for item in items {
                let name = item.get("name").and_then(Value::as_str);
                let value = item.get("value").and_then(Value::as_str);
                let (Some(name), Some(value)) = (name, value) else {
                    return Err(bad("a driver option"));
                };
                options.push(DriverOption {
                    name: name.to_owned(),
                    value: value.to_owned(),
                });
            }
            out.driver_options = Some(options);
        }
        Some(_) => return Err(bad("driverOptions")),
    }
    Ok(out)
}

fn pdf_request(request: Option<&Value>) -> Result<PrintToPdfRequest, CallError> {
    let request = request
        .and_then(Value::as_object)
        .ok_or_else(|| bad("a request"))?;
    let number = |name: &str| -> Result<Option<f64>, CallError> {
        match request.get(name) {
            None => Ok(None),
            Some(Value::Number(n)) => Ok(n.as_f64()),
            Some(_) => Err(bad(name)),
        }
    };
    let flag = |name: &str| -> Result<Option<bool>, CallError> {
        match request.get(name) {
            None => Ok(None),
            Some(Value::Bool(on)) => Ok(Some(*on)),
            Some(_) => Err(bad(name)),
        }
    };
    Ok(PrintToPdfRequest {
        width_in: number("widthIn")?,
        height_in: number("heightIn")?,
        landscape: flag("landscape")?,
        margins_in: request.get("marginsIn").cloned(),
        scale: number("scale")?,
        print_background: flag("printBackground")?,
    })
}

/// `[pdfText, job, table]`
fn cups_call(args: &[Value], cx: &mut Context) -> Answer {
    let pdf = str_arg(args, 0)?;
    let job = cups_job(arg(args, 1))?;
    let table = arg(args, 2).ok_or_else(|| bad("a table"))?;
    let logs: Logs = RefCell::new(Vec::new());
    let result = print_pdf_via_cups(pdf.as_bytes(), &job, &mut table_runner(table, &logs));
    finish(cx, logs);
    Ok(Some(to_value(&result)))
}

/// `[success, failureReason | null, silent]`
fn print_outcome_call(args: &[Value]) -> Answer {
    let Some(Value::Bool(success)) = arg(args, 0) else {
        return Err(bad("success"));
    };
    let reason = match arg(args, 1) {
        None | Some(Value::Null) => None,
        Some(Value::String(text)) => Some(text.as_str()),
        Some(_) => return Err(bad("failureReason")),
    };
    let Some(Value::Bool(silent)) = arg(args, 2) else {
        return Err(bad("silent"));
    };
    Ok(Some(to_value(&print_outcome(*success, reason, *silent))))
}

// ---- windows ----

/// A window driven by a script `{ loadFile?, exec?, print?, showThrows?,
/// focusThrows?, destroyed?, isDestroyedThrows?, destroyThrows?, ... }`.
struct FakeWindow<'a> {
    script: &'a Value,
    logs: &'a Logs,
    destroyed: bool,
    /// where the folder of each file loaded is noted
    work_dir: Option<&'a RefCell<Option<String>>>,
}

impl<'a> FakeWindow<'a> {
    fn new(
        script: &'a Value,
        logs: &'a Logs,
        work_dir: Option<&'a RefCell<Option<String>>>,
    ) -> Self {
        FakeWindow {
            script,
            logs,
            destroyed: matches!(script.get("destroyed"), Some(Value::Bool(true))),
            work_dir,
        }
    }

    fn log(&self, line: Vec<Value>) {
        self.logs.borrow_mut().push(line);
    }

    fn throws(&self, name: &str) -> bool {
        matches!(self.script.get(name), Some(Value::Bool(true)))
    }

    fn mode(&self, name: &str) -> Option<&str> {
        self.script.get(name).and_then(Value::as_str)
    }

    fn load(&mut self, path: &str) -> Result<(), JsError> {
        // the folder's random part is cut off, so both sides log the same
        let (dir, base) = path.rsplit_once('/').unwrap_or(("", path));
        let dir_base = dir.rsplit_once('/').map_or(dir, |(_, last)| last);
        let masked = &dir_base[..dir_base.len().saturating_sub(6)];
        let text = std::fs::read_to_string(path).unwrap_or_default();
        self.log(vec![
            Value::from("loadFile"),
            Value::from(masked),
            Value::from(base),
            Value::from(text),
        ]);
        if let Some(cell) = self.work_dir {
            *cell.borrow_mut() = Some(dir.to_owned());
        }
        if self.mode("loadFile") == Some("throws") {
            return Err(JsError::plain("load failed"));
        }
        Ok(())
    }
}

impl FakePrintRenderer for FakeWindow<'_> {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        self.load(path)
    }

    fn execute_javascript(&mut self, script: &str, user_gesture: bool) -> ExecOutcome {
        self.log(vec![
            Value::from("executeJavaScript"),
            Value::from(script),
            Value::Bool(user_gesture),
        ]);
        match self.mode("exec") {
            Some("rejected") => ExecOutcome::Rejected("probe rejected".to_owned()),
            Some("throws") => ExecOutcome::Throws("probe threw".to_owned()),
            Some("pending") => ExecOutcome::Pending,
            _ => ExecOutcome::Settled,
        }
    }

    fn print(&mut self, silent: bool, print_background: bool) -> Result<PrintReport, JsError> {
        let mut options = Map::new();
        options.insert("silent".into(), Value::Bool(silent));
        options.insert("printBackground".into(), Value::Bool(print_background));
        self.log(vec![Value::from("print"), Value::Object(options)]);
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

impl PrintDialogWindow for FakeWindow<'_> {
    fn show(&mut self) -> Result<(), JsError> {
        self.log(vec![Value::from("show")]);
        if self.throws("showThrows") {
            return Err(JsError::plain("show threw"));
        }
        Ok(())
    }

    fn focus(&mut self) -> Result<(), JsError> {
        self.log(vec![Value::from("focus")]);
        if self.throws("focusThrows") {
            return Err(JsError::plain("focus threw"));
        }
        Ok(())
    }

    fn is_destroyed(&mut self) -> Result<bool, JsError> {
        self.log(vec![Value::from("isDestroyed")]);
        if self.throws("isDestroyedThrows") {
            return Err(JsError::plain("isDestroyed threw"));
        }
        Ok(self.destroyed)
    }

    fn destroy(&mut self) -> Result<(), JsError> {
        self.log(vec![Value::from("destroy")]);
        self.destroyed = true;
        if self.throws("destroyThrows") {
            return Err(JsError::plain("destroy threw"));
        }
        Ok(())
    }
}

impl PrintWindow for FakeWindow<'_> {
    fn load_file(&mut self, path: &str) -> Result<(), JsError> {
        self.load(path)
    }

    fn print_to_pdf(&mut self, options: &Value) -> Result<Vec<u8>, JsError> {
        self.log(vec![Value::from("printToPDF"), options.clone()]);
        if self.mode("printToPDF") == Some("throws") {
            return Err(JsError::plain("printToPDF threw"));
        }
        let pdf = self.mode("pdfHex").unwrap_or("");
        unhex(pdf).map_err(|e| JsError::plain(e.message))
    }

    fn destroy(&mut self) -> Result<(), JsError> {
        PrintDialogWindow::destroy(self)
    }
}

/// `/<prefix><6 random characters>` written `/<prefix><rand>`: the random
/// part differs on each side
fn mask_rand(text: &str) -> String {
    js_regex!(
        r"/(seuoffice-print-|seuoffice-ai-doc-|zz-)[A-Za-z0-9]{6}",
        "g"
    )
    .replace_all(text, |m| format!("/{}<rand>", m.get(1).unwrap_or("")))
}

fn mask_value(value: &mut Value) {
    match value {
        Value::String(text) => *text = mask_rand(text),
        Value::Array(items) => items.iter_mut().for_each(mask_value),
        Value::Object(map) => map.values_mut().for_each(mask_value),
        _ => {}
    }
}

fn error_of(error: JsError) -> CallError {
    CallError {
        code: error.code,
        message: mask_rand(&error.message),
    }
}

fn optional_str(args: &[Value], i: usize) -> Result<Option<&str>, CallError> {
    match arg(args, i) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.as_str())),
        Some(_) => Err(bad("a string")),
    }
}

/// `[html, fileName | null, dirPrefix | null, script]`: answers the folder the
/// load made, with its random part cut off, and what it holds; the folder is
/// removed.
fn load_print_html_call(args: &[Value], cx: &mut Context) -> Answer {
    let html = str_arg(args, 0)?;
    let file_name = optional_str(args, 1)?;
    let dir_prefix = optional_str(args, 2)?;
    let script = arg(args, 3).ok_or_else(|| bad("a script"))?;
    let logs: Logs = RefCell::new(Vec::new());
    let mut window = FakeWindow::new(script, &logs, None);
    let tmp = os_tmpdir();
    let loaded = drive_load(
        begin_load_print_html(html, file_name, dir_prefix, &tmp),
        &mut window,
        &mut |message| {
            logs.borrow_mut().push(vec![
                Value::from("console.error"),
                Value::from("[print] readiness probe failed:"),
                Value::from(message),
            ]);
        },
    );
    finish(cx, logs);
    let temp_dir = loaded.map_err(error_of)?;
    let mut entries: Vec<(String, String)> = std::fs::read_dir(&temp_dir)
        .map_err(|_| bad("the folder"))?
        .filter_map(Result::ok)
        .map(|entry| {
            let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
            (entry.file_name().to_string_lossy().into_owned(), text)
        })
        .collect();
    entries.sort();
    let base = temp_dir.rsplit('/').next().unwrap_or("");
    let masked = &base[..base.len().saturating_sub(6)];
    let parent = temp_dir.rsplit_once('/').map_or("", |(parent, _)| parent);
    let mut out = Map::new();
    out.insert("tempDir".into(), Value::from(masked));
    out.insert("inTmpdir".into(), Value::Bool(parent == tmp));
    out.insert(
        "files".into(),
        Value::Array(
            entries
                .into_iter()
                .map(|(name, text)| Value::Array(vec![Value::from(name), Value::from(text)]))
                .collect(),
        ),
    );
    let _ = rm_recursive_force(&temp_dir);
    Ok(Some(Value::Object(out)))
}

/// `[html, fileName | null, dirPrefix | null, platform | null, script]`
fn print_html_document_call(args: &[Value], cx: &mut Context) -> Answer {
    let html = str_arg(args, 0)?;
    let file_name = optional_str(args, 1)?;
    let dir_prefix = optional_str(args, 2)?;
    let platform = optional_str(args, 3)?.unwrap_or(process_platform());
    let script = arg(args, 4).ok_or_else(|| bad("a script"))?;
    let logs: Logs = RefCell::new(Vec::new());
    let mut window = FakeWindow::new(script, &logs, None);
    let tmp = os_tmpdir();
    let options = PrintDocumentOptions {
        html,
        file_name,
        dir_prefix,
        platform,
        tmp_dir: &tmp,
    };
    let step = begin_print(&mut window, &options);
    let outcome = drive_print(step, &mut window, &mut |message| {
        logs.borrow_mut().push(vec![
            Value::from("console.error"),
            Value::from("[print] readiness probe failed:"),
            Value::from(message),
        ]);
    });
    finish(cx, logs);
    outcome
        .map(|outcome| {
            let mut value = to_value(&outcome);
            mask_value(&mut value);
            Some(value)
        })
        .map_err(error_of)
}

/// `[html, script]`: the PDF as hex. The folder of the load is removed
/// afterwards: it stays where `destroy` threw, as in the TypeScript.
fn print_html_to_pdf_call(args: &[Value], cx: &mut Context) -> Answer {
    let html = str_arg(args, 0)?;
    let script = arg(args, 1).ok_or_else(|| bad("a script"))?;
    let logs: Logs = RefCell::new(Vec::new());
    let work_dir: RefCell<Option<String>> = RefCell::new(None);
    let tmp = os_tmpdir();
    let create = || -> Result<FakeWindow<'_>, JsError> {
        logs.borrow_mut().push(vec![Value::from("createWindow")]);
        if matches!(script.get("createWindow"), Some(Value::String(mode)) if mode == "throws") {
            return Err(JsError::plain("createWindow threw"));
        }
        Ok(FakeWindow::new(script, &logs, Some(&work_dir)))
    };
    let result = print_html_to_pdf(html, create, &tmp);
    if let Some(dir) = work_dir.borrow().as_deref() {
        let _ = rm_recursive_force(dir);
    }
    finish(cx, logs);
    result
        .map(|pdf| Some(Value::from(hex(&pdf))))
        .map_err(error_of)
}

// ---- headless-export ----

fn targets_value() -> Value {
    let mut map = Map::new();
    for (module, formats) in headless_targets() {
        map.insert(module.into(), strings(&formats));
    }
    Value::Object(map)
}

fn exit_value() -> Value {
    let mut map = Map::new();
    map.insert("success".into(), Value::from(HEADLESS_EXIT_SUCCESS));
    map.insert("badArgs".into(), Value::from(HEADLESS_EXIT_BAD_ARGS));
    map.insert("inputError".into(), Value::from(HEADLESS_EXIT_INPUT_ERROR));
    map.insert(
        "conversionFailure".into(),
        Value::from(HEADLESS_EXIT_CONVERSION_FAILURE),
    );
    Value::Object(map)
}

fn outcome_arg(args: &[Value], i: usize) -> Result<HeadlessExportOutcome, CallError> {
    let outcome = arg(args, i).ok_or_else(|| bad("an outcome"))?;
    let text = |name: &str| -> Result<String, CallError> {
        outcome
            .get(name)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| bad(name))
    };
    if matches!(outcome.get("ok"), Some(Value::Bool(true))) {
        let out_paths = match outcome.get("outPaths") {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .map(|v| v.as_str().map(str::to_owned).ok_or_else(|| bad("a path")))
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            Some(_) => return Err(bad("outPaths")),
        };
        let detail = match outcome.get("detail") {
            None | Some(Value::Null) => None,
            Some(detail @ Value::Object(_)) => Some(detail.clone()),
            Some(_) => return Err(bad("detail")),
        };
        Ok(HeadlessExportOutcome::Ok {
            input: text("input")?,
            out_path: text("outPath")?,
            out_paths,
            detail,
        })
    } else {
        Ok(HeadlessExportOutcome::Failed {
            code: outcome
                .get("code")
                .and_then(Value::as_f64)
                .ok_or_else(|| bad("code"))?,
            message: text("message")?,
        })
    }
}

fn log_line(cx: &mut Context, line: Vec<Value>) {
    cx.logs.push(line);
}

/// `[ms]`: the timer logs `["setTimeout", ms]`
fn sleep_call(args: &[Value], cx: &mut Context) -> Answer {
    let ms = arg(args, 0)
        .and_then(Value::as_f64)
        .ok_or_else(|| bad("ms"))?;
    headless_sleep(ms, &mut |ms| {
        log_line(cx, vec![Value::from("setTimeout"), num(ms)]);
    });
    Ok(None)
}

/// `[{ readyAfter, stall, timeoutMs?, pollMs?, options? }]`: `ready` is true
/// from its call number `readyAfter` + 1 on (never when negative); the clock
/// starts at the call's `now` and moves only when the timer sleeps.
fn poll_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("a spec"))?;
    let ready_after = spec
        .get("readyAfter")
        .and_then(Value::as_f64)
        .ok_or_else(|| bad("readyAfter"))?;
    let given = |name: &str| match spec.get(name) {
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    };
    let options = if matches!(spec.get("options"), Some(Value::Bool(false))) {
        HeadlessWaitOptions::default()
    } else {
        HeadlessWaitOptions {
            timeout_ms: given("timeoutMs"),
            poll_ms: given("pollMs"),
        }
    };
    let logs: Logs = RefCell::new(Vec::new());
    let clock = Cell::new(cx.now_ms);
    let calls = Cell::new(0.0_f64);
    let mut ready = || {
        logs.borrow_mut().push(vec![Value::from("ready")]);
        let n = calls.get();
        calls.set(n + 1.0);
        ready_after >= 0.0 && n >= ready_after
    };
    let mut now = || clock.get();
    let mut sleep = |ms: f64| {
        logs.borrow_mut()
            .push(vec![Value::from("setTimeout"), num(ms)]);
        clock.set(clock.get() + ms);
    };
    let text = spec
        .get("stall")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("stall"))?
        .to_owned();
    let mut lazy = || {
        logs.borrow_mut().push(vec![Value::from("stall")]);
        text.clone()
    };
    let stall = if matches!(spec.get("lazy"), Some(Value::Bool(true))) {
        StallMessage::Lazy(&mut lazy)
    } else {
        StallMessage::Text(&text)
    };
    let result = poll_until_ready(&mut ready, stall, options, &mut now, &mut sleep);
    finish(cx, logs);
    result.map(|()| None).map_err(CallError::plain)
}

/// `[{ dom, fontsWin, timeoutMs? }]`: `dom` is `"none"`, `"nofonts"` or `"fonts"`
fn fonts_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).ok_or_else(|| bad("a spec"))?;
    let fonts_win = matches!(spec.get("fontsWin"), Some(Value::Bool(true)));
    let timeout = match spec.get("timeoutMs") {
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    };
    let logs: Logs = RefCell::new(Vec::new());
    let mut race = |ms: f64| {
        logs.borrow_mut()
            .push(vec![Value::from("setTimeout"), num(ms)]);
        fonts_win
    };
    let settled = match spec.get("dom").and_then(Value::as_str) {
        Some("fonts") => document_fonts_settled(Some(&mut race), timeout),
        Some("none" | "nofonts") => document_fonts_settled(None, timeout),
        _ => return Err(bad("dom")),
    };
    finish(cx, logs);
    Ok(Some(Value::from(match settled {
        headless_export::FontsSettled::Immediate => "immediate",
        headless_export::FontsSettled::FontsReady => "fonts",
        headless_export::FontsSettled::TimedOut => "timeout",
    })))
}

/// `[outPath, { wait, export }]`: `wait` is `"ok"` or `{ throws }`, `export`
/// is a boolean or `{ throws }`
fn renderer_export_call(args: &[Value], cx: &mut Context) -> Answer {
    let out_path = str_arg(args, 0)?;
    let spec = arg(args, 1).ok_or_else(|| bad("a spec"))?;
    let logs: Logs = RefCell::new(Vec::new());
    let thrown = |value: Option<&Value>| -> Option<String> {
        value
            .and_then(|v| v.get("throws").or_else(|| v.get("throwsString")))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let mut wait = || {
        logs.borrow_mut().push(vec![Value::from("wait")]);
        match thrown(spec.get("wait")) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    };
    let mut export = |path: &str| {
        logs.borrow_mut()
            .push(vec![Value::from("export"), Value::from(path)]);
        match (thrown(spec.get("export")), spec.get("export")) {
            (Some(message), _) => Err(message),
            (None, Some(Value::Bool(on))) => Ok(*on),
            _ => Ok(false),
        }
    };
    let report = run_headless_renderer_export(out_path, &mut wait, &mut export);
    finish(cx, logs);
    Ok(Some(report.to_value()))
}

// ---- generate-handoff ----

/// The fake webContents of a `*For` call.
struct FakeContents<'a> {
    id: f64,
    destroyed: bool,
    listeners: &'a mut Vec<f64>,
}

impl HandoffWebContents for FakeContents<'_> {
    fn id(&self) -> f64 {
        self.id
    }

    fn is_destroyed(&self) -> bool {
        self.destroyed
    }

    fn once_destroyed(&mut self) {
        self.listeners.push(self.id);
    }
}

struct Scenario {
    store: HandoffStore,
    /// the ids of the contents that registered a `destroyed` listener, in order
    listeners: Vec<f64>,
}

fn from_json<T: serde::de::DeserializeOwned>(
    value: Option<&Value>,
    what: &str,
) -> Result<T, CallError> {
    serde_json::from_value(value.cloned().ok_or_else(|| bad(what))?).map_err(|_| bad(what))
}

fn id_arg(args: &[Value], i: usize) -> Result<f64, CallError> {
    arg(args, i)
        .and_then(Value::as_f64)
        .ok_or_else(|| bad("an id"))
}

fn paths_arg(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn optional<T: Serialize>(value: Option<T>) -> Value {
    value.map_or(Value::Null, |v| to_value(&v))
}

/// One function of the module, or one of the comparison's own, on the scenario.
fn handoff_op(
    sc: &mut Scenario,
    op: &str,
    args: &[Value],
    now_ms: f64,
) -> Result<Option<Value>, CallError> {
    let op = op.strip_prefix("generate-handoff.").unwrap_or(op);
    Ok(match op {
        "queueGenerateHandoff" => {
            let handoff: GenerateHandoff = from_json(arg(args, 1), "a hand-off")?;
            sc.store.queue_generate_handoff(id_arg(args, 0)?, handoff);
            None
        }
        "queueGenerateHandoffFor" => {
            let spec = arg(args, 0).ok_or_else(|| bad("contents"))?;
            let mut contents = FakeContents {
                id: spec
                    .get("id")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| bad("id"))?,
                destroyed: matches!(spec.get("destroyed"), Some(Value::Bool(true))),
                listeners: &mut sc.listeners,
            };
            let handoff: GenerateHandoff = from_json(arg(args, 1), "a hand-off")?;
            sc.store.queue_generate_handoff_for(&mut contents, handoff);
            None
        }
        "takeGenerateHandoff" => {
            let target = arg(args, 0)
                .and_then(Value::as_str)
                .and_then(GenerateHandoffTarget::parse);
            let id = id_arg(args, 1)?;
            Some(optional(
                target.and_then(|t| sc.store.take_generate_handoff(t, id)),
            ))
        }
        "dropGenerateHandoff" => {
            sc.store.drop_generate_handoff(id_arg(args, 0)?);
            None
        }
        "queueSkillHandoff" => {
            let handoff: SkillHandoff = from_json(arg(args, 1), "a hand-off")?;
            sc.store.queue_skill_handoff(id_arg(args, 0)?, handoff);
            None
        }
        "queueSkillHandoffFor" => {
            let spec = arg(args, 0).ok_or_else(|| bad("contents"))?;
            let mut contents = FakeContents {
                id: spec
                    .get("id")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| bad("id"))?,
                destroyed: matches!(spec.get("destroyed"), Some(Value::Bool(true))),
                listeners: &mut sc.listeners,
            };
            let handoff: SkillHandoff = from_json(arg(args, 1), "a hand-off")?;
            sc.store.queue_skill_handoff_for(&mut contents, handoff);
            None
        }
        "takeSkillHandoff" => {
            let target = arg(args, 0)
                .and_then(Value::as_str)
                .and_then(HandoffEditor::parse);
            let id = id_arg(args, 1)?;
            Some(optional(
                target.and_then(|t| sc.store.take_skill_handoff(t, id)),
            ))
        }
        "queuedSkillHandoffs" => Some(to_value(&sc.store.queued_skill_handoffs())),
        "queuedGenerateHandoffs" => Some(to_value(&sc.store.queued_generate_handoffs())),
        "setGenerateTabIdResolver" => {
            let resolver = match arg(args, 0) {
                None | Some(Value::Null) => None,
                Some(spec) => {
                    let table = spec.get("table").cloned().unwrap_or(Value::Null);
                    let throws_for: Vec<f64> = spec
                        .get("throwsFor")
                        .and_then(Value::as_array)
                        .map(|ids| ids.iter().filter_map(Value::as_f64).collect())
                        .unwrap_or_default();
                    let resolver: Box<generate_handoff::TabIdResolver> = Box::new(move |id| {
                        if throws_for.contains(&id) {
                            return Err("resolver boom".to_owned());
                        }
                        Ok(table
                            .get(number_to_string(id))
                            .and_then(Value::as_str)
                            .map(str::to_owned))
                    });
                    Some(resolver)
                }
            };
            sc.store.set_generate_tab_id_resolver(resolver);
            None
        }
        "reportGenerateRunStarted" => {
            let target = arg(args, 0)
                .and_then(Value::as_str)
                .and_then(GenerateHandoffTarget::parse);
            let id = id_arg(args, 1)?;
            let paths = paths_arg(arg(args, 2));
            let event = match target {
                Some(target) => sc
                    .store
                    .report_generate_run_started(target, id, &paths, now_ms)
                    .map_err(CallError::plain)?,
                None => None,
            };
            Some(optional(event))
        }
        "generateRunStartedEvents" => Some(to_value(&sc.store.generate_run_started_events())),
        "recordGenerateConverted" => {
            let input = arg(args, 0).ok_or_else(|| bad("an input"))?;
            let target: GenerateConvertTarget = from_json(input.get("target"), "a target")?;
            let kind: GenerateConvertKind = from_json(input.get("kind"), "a kind")?;
            let id = input
                .get("webContentsId")
                .and_then(Value::as_f64)
                .ok_or_else(|| bad("webContentsId"))?;
            let conversion_id = input
                .get("conversionId")
                .and_then(Value::as_str)
                .ok_or_else(|| bad("conversionId"))?;
            let sources = paths_arg(input.get("sources"));
            let event = sc
                .store
                .record_generate_converted(id, target, kind, &sources, conversion_id, now_ms)
                .map_err(CallError::plain)?;
            Some(to_value(&event))
        }
        "generateConvertedEvents" => Some(to_value(&sc.store.generate_converted_events())),
        "resetGenerateHandoffsForTest" => {
            sc.store.reset_generate_handoffs_for_test();
            None
        }
        // the comparison's own steps
        "emitDestroyed" => {
            let id = id_arg(args, 0)?;
            while let Some(at) = sc.listeners.iter().position(|l| *l == id) {
                sc.listeners.remove(at);
                sc.store.drop_generate_handoff(id);
            }
            None
        }
        "setPlatform" => {
            sc.store.win32 = arg(args, 0).and_then(Value::as_str) == Some("win32");
            None
        }
        _ => return Err(bad("an op")),
    })
}

/// `[setupSteps, ...args]`
fn handoff_call(name: &str, args: &[Value], cx: &mut Context) -> Answer {
    let setup = arg(args, 0)
        .and_then(Value::as_array)
        .ok_or_else(|| bad("setup steps"))?;
    let mut sc = Scenario {
        store: HandoffStore::new(false),
        listeners: Vec::new(),
    };
    for step in setup {
        let op = step
            .get("op")
            .and_then(Value::as_str)
            .ok_or_else(|| bad("an op"))?;
        let step_args = step
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        handoff_op(&mut sc, op, &step_args, cx.now_ms)?;
    }
    let result = handoff_op(&mut sc, name, &args[1..], cx.now_ms)?;
    let mut state = Map::new();
    state.insert(
        "queued".into(),
        to_value(&sc.store.queued_generate_handoffs()),
    );
    state.insert("skill".into(), to_value(&sc.store.queued_skill_handoffs()));
    state.insert(
        "runs".into(),
        to_value(&sc.store.generate_run_started_events()),
    );
    state.insert(
        "converted".into(),
        to_value(&sc.store.generate_converted_events()),
    );
    let mut out = Map::new();
    if let Some(result) = result {
        out.insert("result".into(), result);
    }
    out.insert("state".into(), Value::Object(state));
    Ok(Some(Value::Object(out)))
}
