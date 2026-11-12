//! `packages/electron-utils/src/headless-export.ts`.
//!
//! Argv parsing and the stdout envelope for the headless export entry:
//!
//! `<app binary> --headless-export <input-file> --to <format> --out <path> [--json]`
//!
//! plus the renderer-side waiting helpers at the bottom of the TypeScript. A
//! timer or a clock a helper reads is a closure of the caller (`Date.now`,
//! `setTimeout`), so a stalled export is decided by what the caller's clock
//! says.

use jscompat::{
    JsObject, JsRegex, JsonValue, js_regex, json_stringify, json_value_from_serde, to_number,
};
use serde_json::{Map, Number, Value};

/// Conversion targets a diagram job can write (the input's ops applied first).
pub const DIAGRAM_FILE_TARGETS: [&str; 4] = ["drawio", "dio", "drawio.svg", "drawio.png"];

/// How a diagram batch treats a rejected op.
pub const DIAGRAM_BATCH_MODES: [&str; 3] = ["all-or-nothing", "best-effort", "stop-on-error"];

/// Targets each editor module can render without a dialog, in the order of
/// `HEADLESS_TARGETS`.
pub fn headless_targets() -> Vec<(&'static str, Vec<&'static str>)> {
    vec![
        ("docs", vec!["pdf", "html", "md"]),
        ("sheets", vec!["pdf"]),
        ("slides", vec!["pdf"]),
        ("markdown", vec!["pdf"]),
        ("html", vec!["pdf", "docx"]),
        ("hwp", vec!["pdf"]),
        (
            "diagram",
            vec![
                "pdf",
                "png",
                "svg",
                "drawio",
                "dio",
                "drawio.svg",
                "drawio.png",
            ],
        ),
    ]
}

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

/// Whether a target writes a diagram file (ops may run first) rather than a
/// picture or a document.
pub fn is_diagram_file_target(format: &str) -> bool {
    DIAGRAM_FILE_TARGETS.contains(&format)
}

pub const HEADLESS_EXPORT_FLAG: &str = "--headless-export";

/// Process exit codes: 1 bad args / 2 input file error / 3 conversion failure.
pub const HEADLESS_EXIT_SUCCESS: u8 = 0;
pub const HEADLESS_EXIT_BAD_ARGS: u8 = 1;
pub const HEADLESS_EXIT_INPUT_ERROR: u8 = 2;
pub const HEADLESS_EXIT_CONVERSION_FAILURE: u8 = 3;

/// `HeadlessExportRequest`
#[derive(Debug, Clone, PartialEq)]
pub struct HeadlessExportRequest {
    pub input: String,
    pub target_format: &'static str,
    pub out_path: String,
    pub json: bool,
    pub page: Option<f64>,
    pub ops: Option<String>,
    pub batch: Option<&'static str>,
}

impl HeadlessExportRequest {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("input".into(), Value::from(self.input.as_str()));
        map.insert("targetFormat".into(), Value::from(self.target_format));
        map.insert("outPath".into(), Value::from(self.out_path.as_str()));
        map.insert("json".into(), Value::Bool(self.json));
        if let Some(page) = self.page {
            map.insert(
                "page".into(),
                Number::from_f64(page).map_or(Value::Null, Value::Number),
            );
        }
        if let Some(ops) = &self.ops {
            map.insert("ops".into(), Value::from(ops.as_str()));
        }
        if let Some(batch) = self.batch {
            map.insert("batch".into(), Value::from(batch));
        }
        Value::Object(map)
    }
}

/// `HeadlessArgvParse`
#[derive(Debug, Clone, PartialEq)]
pub enum HeadlessArgvParse {
    None,
    Ok(HeadlessExportRequest),
    Error { json: bool, message: String },
}

impl HeadlessArgvParse {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        match self {
            HeadlessArgvParse::None => {
                map.insert("kind".into(), Value::from("none"));
            }
            HeadlessArgvParse::Ok(request) => {
                map.insert("kind".into(), Value::from("ok"));
                map.insert("request".into(), request.to_value());
            }
            HeadlessArgvParse::Error { json, message } => {
                map.insert("kind".into(), Value::from("error"));
                map.insert("json".into(), Value::Bool(*json));
                map.insert("message".into(), Value::from(message.as_str()));
            }
        }
        Value::Object(map)
    }
}

/// `HeadlessExportOutcome`
#[derive(Debug, Clone, PartialEq)]
pub enum HeadlessExportOutcome {
    Ok {
        input: String,
        out_path: String,
        /// the files written, when an exporter reported them
        out_paths: Option<Vec<String>>,
        /// facts for the caller, a JSON object
        detail: Option<Value>,
    },
    Failed {
        /// 1, 2 or 3
        code: f64,
        message: String,
    },
}

fn module_table() -> [(&'static JsRegex, &'static str); 7] {
    [
        (js_regex!(r"\.docx$", "i"), "docs"),
        (js_regex!(r"\.(xlsx|xlsm|xls|csv|tsv)$", "i"), "sheets"),
        (js_regex!(r"\.pptx$", "i"), "slides"),
        (js_regex!(r"\.(md|markdown)$", "i"), "markdown"),
        (js_regex!(r"\.(html|htm)$", "i"), "html"),
        (js_regex!(r"\.(hwp|hwpx)$", "i"), "hwp"),
        (
            js_regex!(r"\.(drawio|dio|drawio\.svg|drawio\.png)$", "i"),
            "diagram",
        ),
    ]
}

/// Which editor module can render this input, or `None` when the extension is unsupported.
pub fn headless_module_for(input_path: &str) -> Option<&'static str> {
    module_table()
        .into_iter()
        .find(|(pattern, _)| pattern.test(input_path))
        .map(|(_, module)| module)
}

/// Extensions the headless entry accepts, for error messages.
pub const HEADLESS_SUPPORTED_EXTENSIONS: &str = ".docx, .xlsx, .xlsm, .xls, .csv, .pptx, .md, .markdown, .html, .htm, .hwp, .hwpx, .drawio, .dio, .drawio.svg, .drawio.png";

/// `--flag value` and `--flag=value` both read the same.
fn read_option(argv: &[String], index: usize, flag: &str) -> Option<String> {
    let arg = argv.get(index).map_or("", String::as_str);
    if let Some(value) = arg
        .strip_prefix(flag)
        .and_then(|rest| rest.strip_prefix('='))
    {
        return Some(value.to_owned());
    }
    // a following switch is never this flag's value (`--out --json` is a missing value)
    match argv.get(index + 1) {
        Some(next) if !next.starts_with("--") => Some(next.clone()),
        _ => None,
    }
}

fn consumes_next(argv: &[String], index: usize, flag: &str) -> bool {
    !argv
        .get(index)
        .map_or("", String::as_str)
        .strip_prefix(flag)
        .is_some_and(|rest| rest.starts_with('='))
}

/// `arg === flag || arg.startsWith(`${flag}=`)`
fn is_flag(arg: &str, flag: &str) -> bool {
    arg == flag
        || arg
            .strip_prefix(flag)
            .is_some_and(|rest| rest.starts_with('='))
}

/// `Number.isSafeInteger`
fn is_safe_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0
}

/// Reads the headless-export switches out of an Electron `process.argv`.
/// Returns `None` when the flag is absent, so the normal GUI startup path
/// stays untouched.
pub fn parse_headless_export_argv(argv: &[String]) -> HeadlessArgvParse {
    if !argv.iter().any(|arg| is_flag(arg, HEADLESS_EXPORT_FLAG)) {
        return HeadlessArgvParse::None;
    }
    let json = argv.iter().any(|arg| arg == "--json");
    let fail = |message: String| HeadlessArgvParse::Error { json, message };

    let mut input: Option<String> = None;
    let mut to: Option<String> = None;
    let mut out_path: Option<String> = None;
    let mut page: Option<String> = None;
    let mut ops: Option<String> = None;
    let mut batch: Option<String> = None;

    let mut i = 0;
    while i < argv.len() {
        let arg = argv[i].as_str();
        if is_flag(arg, HEADLESS_EXPORT_FLAG) {
            input = read_option(argv, i, HEADLESS_EXPORT_FLAG);
            if input.is_none() {
                return fail(format!("{HEADLESS_EXPORT_FLAG} needs an input file"));
            }
            if consumes_next(argv, i, HEADLESS_EXPORT_FLAG) {
                i += 1;
            }
        } else if is_flag(arg, "--to") {
            to = read_option(argv, i, "--to");
            if to.is_none() {
                return fail("--to needs a target format".to_owned());
            }
            if consumes_next(argv, i, "--to") {
                i += 1;
            }
        } else if is_flag(arg, "--out") {
            out_path = read_option(argv, i, "--out");
            if out_path.is_none() {
                return fail("--out needs an output path".to_owned());
            }
            if consumes_next(argv, i, "--out") {
                i += 1;
            }
        } else if is_flag(arg, "--page") {
            page = read_option(argv, i, "--page");
            if page.is_none() {
                return fail("--page needs a page number".to_owned());
            }
            if consumes_next(argv, i, "--page") {
                i += 1;
            }
        } else if is_flag(arg, "--ops") {
            ops = read_option(argv, i, "--ops");
            if ops.is_none() {
                return fail("--ops needs a file".to_owned());
            }
            if consumes_next(argv, i, "--ops") {
                i += 1;
            }
        } else if is_flag(arg, "--batch") {
            batch = read_option(argv, i, "--batch");
            if batch.is_none() {
                return fail("--batch needs a mode".to_owned());
            }
            if consumes_next(argv, i, "--batch") {
                i += 1;
            }
        }
        i += 1;
    }

    let Some(input) = input.filter(|input| !input.is_empty()) else {
        return fail(format!("{HEADLESS_EXPORT_FLAG} needs an input file"));
    };
    let Some(to) = to.filter(|to| !to.is_empty()) else {
        return fail(format!("--to is required ({})", ALL_TARGETS.join(", ")));
    };
    let lowered = to.to_lowercase();
    let Some(target_format) = ALL_TARGETS.iter().find(|f| **f == lowered).copied() else {
        return fail(format!(
            "unsupported target format \"{to}\" ({})",
            ALL_TARGETS.join(", ")
        ));
    };
    let Some(out_path) = out_path.filter(|path| !path.is_empty()) else {
        return fail("--out is required".to_owned());
    };
    let page_number = page.as_deref().map(to_number);
    if let (Some(n), Some(text)) = (page_number, page.as_deref())
        && (!is_safe_integer(n) || n < 1.0)
    {
        return fail(format!(
            "--page must be a page number from 1 (got \"{text}\")"
        ));
    }
    let batch_mode = DIAGRAM_BATCH_MODES
        .iter()
        .find(|mode| Some(**mode) == batch.as_deref())
        .copied();
    if let (Some(text), None) = (batch.as_deref(), batch_mode) {
        return fail(format!(
            "unsupported batch mode \"{text}\" ({})",
            DIAGRAM_BATCH_MODES.join(", ")
        ));
    }

    HeadlessArgvParse::Ok(HeadlessExportRequest {
        input,
        target_format,
        out_path,
        json,
        page: page_number,
        ops,
        batch: batch_mode,
    })
}

/// One-sentence description of an outcome, shared by the plain and JSON forms.
pub fn headless_summary(outcome: &HeadlessExportOutcome) -> String {
    match outcome {
        HeadlessExportOutcome::Failed { message, .. } => format!("Export failed: {message}"),
        HeadlessExportOutcome::Ok {
            input,
            out_path,
            out_paths,
            ..
        } => {
            let single = [out_path.clone()];
            let paths: &[String] = out_paths.as_deref().unwrap_or(&single);
            match paths.len() {
                0 => format!("Ran {input}; nothing was written"),
                1 => format!("Exported {input} to {}", paths[0]),
                n => format!("Exported {input} to {n} files"),
            }
        }
    }
}

fn line_breaks() -> &'static JsRegex {
    js_regex!(r"\s*[\r\n]+\s*")
}

/// The single stdout line. With `json` it is exactly one JSON object;
/// otherwise a human-readable sentence. Newlines inside the message would
/// break the one-line contract, so they are folded to spaces.
pub fn format_headless_envelope(outcome: &HeadlessExportOutcome, json: bool) -> String {
    let summary = line_breaks().replace_all(&headless_summary(outcome), |_| " ".to_owned());
    if !json {
        return summary;
    }
    let mut object: JsObject<JsonValue> = JsObject::new();
    match outcome {
        HeadlessExportOutcome::Ok {
            out_path,
            out_paths,
            detail,
            ..
        } => {
            object.set("status", JsonValue::String("ok".to_owned()));
            object.set("summary", JsonValue::String(summary));
            object.set("output_path", JsonValue::String(out_path.clone()));
            if let Some(paths) = out_paths {
                object.set(
                    "output_paths",
                    JsonValue::Array(paths.iter().cloned().map(JsonValue::String).collect()),
                );
            }
            if let Some(detail) = detail {
                object.set("detail", json_value_from_serde(detail));
            }
        }
        HeadlessExportOutcome::Failed { message, .. } => {
            object.set("status", JsonValue::String("error".to_owned()));
            object.set("summary", JsonValue::String(summary));
            object.set(
                "error",
                JsonValue::String(line_breaks().replace_all(message, |_| " ".to_owned())),
            );
        }
    }
    json_stringify(&JsonValue::Object(object))
}

/// Exit code for an outcome.
pub fn headless_exit_code(outcome: &HeadlessExportOutcome) -> f64 {
    match outcome {
        HeadlessExportOutcome::Ok { .. } => f64::from(HEADLESS_EXIT_SUCCESS),
        HeadlessExportOutcome::Failed { code, .. } => *code,
    }
}

// ---- renderer side ----

/// What a hidden renderer sends back when its export settles.
#[derive(Debug, Clone, PartialEq)]
pub struct HeadlessExportReport {
    pub ok: bool,
    pub error: Option<String>,
}

impl HeadlessExportReport {
    pub fn to_value(&self) -> Value {
        let mut map = Map::new();
        map.insert("ok".into(), Value::Bool(self.ok));
        if let Some(error) = &self.error {
            map.insert("error".into(), Value::from(error.as_str()));
        }
        Value::Object(map)
    }
}

/// `HeadlessWaitOptions`: `None` takes the default
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct HeadlessWaitOptions {
    /// overall budget before the wait gives up (default 180000)
    pub timeout_ms: Option<f64>,
    /// default 250
    pub poll_ms: Option<f64>,
}

/// `headlessSleep(ms)`: the caller's timer sleeps `ms`.
pub fn headless_sleep(ms: f64, sleep: &mut dyn FnMut(f64)) {
    sleep(ms);
}

/// `stallMessage: string | (() => string)`
pub enum StallMessage<'a> {
    Text(&'a str),
    /// evaluated at give-up time, so it can describe the state the wait died in
    Lazy(&'a mut dyn FnMut() -> String),
}

/// Polls `ready` until it returns true. There is no user to notice a document
/// that never opens, so a stalled export fails (`Err` is the message of the
/// error thrown) rather than hanging forever.
pub fn poll_until_ready(
    ready: &mut dyn FnMut() -> bool,
    mut stall_message: StallMessage<'_>,
    options: HeadlessWaitOptions,
    now: &mut dyn FnMut() -> f64,
    sleep: &mut dyn FnMut(f64),
) -> Result<(), String> {
    let timeout_ms = options.timeout_ms.unwrap_or(180_000.0);
    let poll_ms = options.poll_ms.unwrap_or(250.0);
    let deadline = now() + timeout_ms;
    while !ready() {
        if now() > deadline {
            return Err(match &mut stall_message {
                StallMessage::Text(text) => (*text).to_owned(),
                StallMessage::Lazy(message) => message(),
            });
        }
        headless_sleep(poll_ms, sleep);
    }
    Ok(())
}

/// Which side of `Promise.race([document.fonts.ready, headlessSleep(timeoutMs)])` won.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontsSettled {
    /// no `document.fonts` (jsdom in unit tests): resolves at once
    Immediate,
    FontsReady,
    TimedOut,
}

/// Resolves when the document's @font-face loads have settled, giving up after
/// `timeout_ms` (default 30000) rather than stranding the export. `race` is
/// the DOM's side: `None` is a DOM without FontFaceSet; otherwise it is given
/// the timeout the timer was set with and answers whether the fonts settled
/// first.
pub fn document_fonts_settled(
    race: Option<&mut dyn FnMut(f64) -> bool>,
    timeout_ms: Option<f64>,
) -> FontsSettled {
    let Some(race) = race else {
        return FontsSettled::Immediate;
    };
    if race(timeout_ms.unwrap_or(30_000.0)) {
        FontsSettled::FontsReady
    } else {
        FontsSettled::TimedOut
    }
}

/// The renderer half of a headless export: wait for the document, run the very
/// same export the File menu runs, and turn any failure into a report. Never
/// fails: the main process owns the process exit code.
pub fn run_headless_renderer_export(
    out_path: &str,
    wait_until_ready: &mut dyn FnMut() -> Result<(), String>,
    export_file: &mut dyn FnMut(&str) -> Result<bool, String>,
) -> HeadlessExportReport {
    let result = wait_until_ready().and_then(|()| export_file(out_path));
    match result {
        Ok(true) => HeadlessExportReport {
            ok: true,
            error: None,
        },
        Ok(false) => HeadlessExportReport {
            ok: false,
            error: Some("export did not produce a file".to_owned()),
        },
        Err(message) => HeadlessExportReport {
            ok: false,
            error: Some(message),
        },
    }
}
