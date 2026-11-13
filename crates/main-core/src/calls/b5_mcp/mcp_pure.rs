//! Group `b5-mcp`, slice `mcp_pure`: see tools/main-diff/groups/b5-mcp/mcp-pure.ts.
//!
//! The scenarios are plain-call fakes over the traits of `cli_runner`,
//! `headless_cli`, `mcp_logger` and `docs_bridge`; each call of a fake is one
//! log line, written as the TypeScript fake of the spec writes it. A fake that
//! several functions share (`ScriptedCli`, the log) is `pub(super)` for
//! `tools_docs.rs`.

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::rc::Rc;

use jscompat::node_path::host::{basename, dirname};
use jscompat::{
    JsObject, JsonValue, js_regex, json_value_from_serde, json_value_to_serde, replace_first,
    slice_utf16,
};
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg};
use crate::shell::mcp::cli_runner::{
    CliRun, CliRunHost, CliRunOptions, CliRunOutcome, CliRunner, CliRunnerPaths,
    MAX_CLI_OUTPUT_BYTES, SpawnRequest, cli_error_message,
};
use crate::shell::mcp::docs_bridge::{DocsBridge, DocsBridgeHost, Settled, Submitted};
use crate::shell::mcp::headless_cli::{
    CliError, ConvertOptions, CreateFileOptions, CreateResult, MergeOptions, SheetLinksOptions,
    convert_via_cli, create_file_via_cli, create_pptx_via_cli, docs_check_via_cli,
    merge_template_via_cli, read_docx_properties_via_cli, read_docx_text_via_cli,
    sheet_links_via_cli,
};
use crate::shell::mcp::mcp_logger::{LogClock, MCP_LOG_TAIL, McpLogger, local_timestamp};
use crate::shell::mcp::tools::document_tools::McpEditorCommandName;

// ---- shared fakes ----

/// the log lines of one call, in the order the fakes wrote them
pub(super) type Log = Rc<RefCell<Vec<Vec<Value>>>>;

pub(super) fn new_log() -> Log {
    Rc::new(RefCell::new(Vec::new()))
}

pub(super) fn push(log: &Log, line: Vec<Value>) {
    log.borrow_mut().push(line);
}

/// moves the lines into the answer's logs
pub(super) fn flush(log: &Log, cx: &mut Context) {
    cx.logs.extend(log.borrow_mut().drain(..));
}

pub(super) fn jv(value: &Value) -> JsonValue {
    json_value_from_serde(value)
}

pub(super) fn sv(value: &JsonValue) -> Value {
    json_value_to_serde(value)
}

fn text_of(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

/// a flag of a case: `true`
fn on(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// `{ ok, code, json?, stdout, stderr }` of a runner outcome
pub(super) fn outcome_json(o: &CliRunOutcome) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(o.ok));
    out.insert("code".into(), Value::from(o.code));
    if let Some(json) = &o.json {
        out.insert("json".into(), sv(json));
    }
    out.insert("stdout".into(), Value::from(o.stdout.as_str()));
    out.insert("stderr".into(), Value::from(o.stderr.as_str()));
    Value::Object(out)
}

/// the outcome of a runner from a case's JSON, `?? default` for each field
fn outcome_of(spec: &Value) -> CliRunOutcome {
    CliRunOutcome {
        ok: spec.get("ok").and_then(Value::as_bool).unwrap_or(false),
        code: spec.get("code").and_then(Value::as_f64).unwrap_or(1.0),
        json: spec.get("json").map(jv),
        stdout: text_of(spec, "stdout"),
        stderr: text_of(spec, "stderr"),
    }
}

/// the scratch folder of a path, as `<tmp>`
fn hide(text: &str) -> String {
    replace_first(
        js_regex!(r"^.*seuoffice-mcp-[A-Za-z0-9]{6}"),
        0,
        text,
        "<tmp>",
    )
}

/// A runner that logs its argv (the scratch folder as `<tmp>`) and what the
/// files it was pointed at held, and answers the outcomes in turn (the last
/// one again once they run out): `scriptedCli` of mcp-pure.ts.
pub(super) struct ScriptedCli {
    outcomes: Vec<Value>,
    turn: Cell<usize>,
    pub(super) scratch: RefCell<Option<String>>,
    log: Log,
}

impl ScriptedCli {
    /// `outcomes` is one outcome (an object), a list of them, or nothing
    pub(super) fn new(outcomes: Option<&Value>, log: Log) -> Self {
        let list = match outcomes {
            Some(Value::Array(list)) => list.clone(),
            Some(outcome @ Value::Object(_)) => vec![outcome.clone()],
            _ => vec![json!({})],
        };
        ScriptedCli {
            outcomes: list,
            turn: Cell::new(0),
            scratch: RefCell::new(None),
            log,
        }
    }

    /// the line the case ends with: whether the scratch folder is gone
    pub(super) fn log_scratch(&self) {
        let removed = match &*self.scratch.borrow() {
            None => Value::Null,
            Some(dir) => Value::Bool(fs::metadata(dir).is_err()),
        };
        push(
            &self.log,
            vec![Value::from("scratch folder removed"), removed],
        );
    }
}

impl CliRunner for ScriptedCli {
    fn run(&self, args: &[String], _options: &CliRunOptions) -> CliRunOutcome {
        push(
            &self.log,
            vec![
                Value::from("run"),
                Value::Array(args.iter().map(|a| Value::from(hide(a))).collect()),
            ],
        );
        for (i, path) in args.iter().enumerate() {
            let flag = if i > 0 { args[i - 1].as_str() } else { "" };
            if i > 0 && ["--from", "--ops", "--data"].contains(&flag) {
                *self.scratch.borrow_mut() = Some(dirname(path));
                let content = if fs::metadata(path).is_ok() {
                    fs::read(path).map_or(Value::Null, |bytes| {
                        Value::from(String::from_utf8_lossy(&bytes).into_owned())
                    })
                } else {
                    Value::Null
                };
                push(
                    &self.log,
                    vec![
                        Value::from("staged"),
                        Value::from(flag),
                        Value::from(basename(path, None)),
                        content,
                    ],
                );
            }
        }
        let turn = self.turn.get();
        self.turn.set(turn + 1);
        let last = self.outcomes.len().saturating_sub(1);
        outcome_of(self.outcomes.get(turn.min(last)).unwrap_or(&Value::Null))
    }
}

// ---- the table ----

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "cli-runner.MAX_CLI_OUTPUT_BYTES" => Ok(Some(Value::from(MAX_CLI_OUTPUT_BYTES as f64))),
        "cli-runner.cliErrorMessage" => {
            let outcome = outcome_of(arg(args, 0).unwrap_or(&Value::Null));
            // an outcome without `ok` or `code` is not defaulted here: the case names them
            Ok(cli_error_message(&outcome).map(|message| sv(&message)))
        }
        "cli-runner.createCliRunner" => cli_run_call(args, cx),

        "headless-cli.createFileViaCli" => headless(args, cx, |cli, spec| {
            let opts = spec.get("opts").unwrap_or(&Value::Null);
            let input = opts.get("input").unwrap_or(&Value::Null);
            let created = create_file_via_cli(
                cli,
                &CreateFileOptions {
                    file_type: &text_of(opts, "type"),
                    input_name: &text_of(input, "name"),
                    input_content: &text_of(input, "content"),
                    out: &text_of(opts, "out"),
                    overwrite: on(opts, "overwrite"),
                },
            )?;
            Ok(created_json(&created))
        }),
        "headless-cli.createPptxViaCli" => headless(args, cx, |cli, spec| {
            let opts = spec.get("opts").unwrap_or(&Value::Null);
            let ops: Vec<JsonValue> = opts
                .get("ops")
                .and_then(Value::as_array)
                .map(|list| list.iter().map(jv).collect())
                .unwrap_or_default();
            let created =
                create_pptx_via_cli(cli, &ops, &text_of(opts, "out"), on(opts, "overwrite"))?;
            Ok(created_json(&created))
        }),
        "headless-cli.readDocxTextViaCli" => headless(args, cx, |cli, spec| {
            Ok(Value::from(read_docx_text_via_cli(
                cli,
                &text_of(spec, "path"),
            )?))
        }),
        "headless-cli.readDocxPropertiesViaCli" => headless(args, cx, |cli, spec| {
            Ok(sv(&read_docx_properties_via_cli(
                cli,
                &text_of(spec, "path"),
            )?))
        }),
        "headless-cli.mergeTemplateViaCli" => headless(args, cx, |cli, spec| {
            let opts = spec.get("opts").unwrap_or(&Value::Null);
            let data = opts.get("data").map(jv);
            Ok(sv(&merge_template_via_cli(
                cli,
                &MergeOptions {
                    template_path: &text_of(opts, "templatePath"),
                    data: data.as_ref(),
                    out: &text_of(opts, "out"),
                    overwrite: on(opts, "overwrite"),
                    strict: on(opts, "strict"),
                },
            )?))
        }),
        "headless-cli.sheetLinksViaCli" => headless(args, cx, |cli, spec| {
            let opts = spec.get("opts").unwrap_or(&Value::Null);
            let indices: Option<Vec<f64>> =
                opts.get("break").and_then(Value::as_array).map(|list| {
                    list.iter()
                        .map(|n| n.as_f64().unwrap_or(f64::NAN))
                        .collect()
                });
            let path = text_of(opts, "path");
            let out = opts.get("out").and_then(Value::as_str);
            Ok(sv(&sheet_links_via_cli(
                cli,
                &SheetLinksOptions {
                    path: &path,
                    update: on(opts, "update"),
                    break_indices: indices.as_deref(),
                    out,
                    overwrite: on(opts, "overwrite"),
                },
            )?))
        }),
        "headless-cli.convertViaCli" => headless(args, cx, |cli, spec| {
            let opts = spec.get("opts").unwrap_or(&Value::Null);
            let path = text_of(opts, "path");
            let to = text_of(opts, "to");
            Ok(sv(&convert_via_cli(
                cli,
                &ConvertOptions {
                    path: &path,
                    to: &to,
                    out: opts.get("out").and_then(Value::as_str),
                    overwrite: on(opts, "overwrite"),
                    password: opts.get("password").and_then(Value::as_str),
                    sheet: opts.get("sheet").and_then(Value::as_str),
                },
            )?))
        }),
        "headless-cli.docsCheckViaCli" => headless(args, cx, |cli, spec| {
            Ok(sv(&docs_check_via_cli(cli, &text_of(spec, "path"))?))
        }),

        "mcp-logger.MCP_LOG_TAIL" => Ok(Some(Value::from(MCP_LOG_TAIL))),
        "mcp-logger.localTimestamp" => {
            let at = match arg(args, 0) {
                Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
                _ => f64::NAN,
            };
            let offset = arg(args, 2).and_then(Value::as_f64).unwrap_or(0.0);
            Ok(Some(Value::from(local_timestamp(at, offset))))
        }
        "mcp-logger.scenario" => logger_call(args, cx),

        "docs-bridge.scenario" => bridge_call(args, cx),
        _ => return None,
    })
}

/// `{ outcome, summary, outputPath }`
fn created_json(created: &CreateResult) -> Value {
    let mut out = Map::new();
    out.insert("outcome".into(), outcome_json(&created.outcome));
    if let Some(summary) = &created.summary {
        out.insert("summary".into(), sv(summary));
    }
    out.insert("outputPath".into(), sv(&created.output_path));
    Value::Object(out)
}

/// a headless function over the case's scripted runner: its answer, then the
/// line that says whether the scratch folder is gone
fn headless(
    args: &[Value],
    cx: &mut Context,
    call: impl FnOnce(&ScriptedCli, &Value) -> Result<Value, CliError>,
) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let cli = ScriptedCli::new(spec.get("outcome"), Rc::clone(&log));
    let result = call(&cli, &spec);
    cli.log_scratch();
    flush(&log, cx);
    result.map(Some).map_err(|error| CallError {
        code: error.code,
        message: error.message,
    })
}

// ---- cli-runner ----

struct CliHost {
    log: Log,
    armed: HashSet<u64>,
    next_timer: u64,
}

impl CliRunHost for CliHost {
    fn spawn(&mut self, request: &SpawnRequest) {
        // `pick(env)` of the spec: the variables the runner laid over its own
        let mut env: JsObject<Option<String>> = JsObject::new();
        for (key, value) in &request.env {
            env.set(key.as_str(), value.clone());
        }
        let mut picked = Map::new();
        for (key, value) in env.entries() {
            if let Some(value) = value {
                picked.insert(key.to_owned(), Value::from(value.as_str()));
            }
        }
        push(
            &self.log,
            vec![
                Value::from("spawn"),
                Value::from(request.executable.as_str()),
                Value::Array(
                    request
                        .args
                        .iter()
                        .map(|a| Value::from(a.as_str()))
                        .collect(),
                ),
                Value::Object(picked),
                Value::Bool(true),
            ],
        );
    }

    fn kill(&mut self) {
        push(&self.log, vec![Value::from("kill")]);
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        let id = self.next_timer;
        self.next_timer += 1;
        self.armed.insert(id);
        push(&self.log, vec![Value::from("setTimeout"), Value::from(ms)]);
        id
    }

    fn clear_timeout(&mut self, timer: u64) {
        push(
            &self.log,
            vec![Value::from("clearTimeout"), Value::from(timer)],
        );
        self.armed.remove(&timer);
    }

    fn end_stdin(&mut self, input: Option<&str>) {
        let mut line = vec![Value::from("stdin.end")];
        if let Some(input) = input {
            line.push(Value::from(input));
        }
        push(&self.log, line);
    }
}

fn hex_bytes(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok())
        .collect()
}

/// a long text as its length and ends
fn clip(text: &str) -> Value {
    let units = text.encode_utf16().count();
    if units > 300 {
        json!({
            "length": units,
            "head": slice_utf16(text, 0.0, Some(40.0)),
            "tail": slice_utf16(text, -40.0, None),
        })
    } else {
        Value::from(text)
    }
}

fn summarize(o: &CliRunOutcome) -> Value {
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(o.ok));
    out.insert("code".into(), Value::from(o.code));
    if let Some(json) = &o.json {
        out.insert("json".into(), sv(json));
    }
    out.insert("stdout".into(), clip(&o.stdout));
    out.insert("stderr".into(), clip(&o.stderr));
    Value::Object(out)
}

fn cli_run_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let null = Value::Null;
    let paths_spec = spec.get("paths").unwrap_or(&null);
    let env: Vec<(String, Option<String>)> = paths_spec
        .get("env")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|pair| {
                    let key = pair.get(0).and_then(Value::as_str).unwrap_or_default();
                    (
                        key.to_owned(),
                        pair.get(1).and_then(Value::as_str).map(str::to_owned),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let paths = CliRunnerPaths {
        executable: text_of(paths_spec, "executable"),
        entry: text_of(paths_spec, "entry"),
        env,
    };
    let run_args: Vec<String> = spec
        .get("args")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .map(|a| a.as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default();
    let options_spec = spec.get("options").unwrap_or(&null);
    let options = CliRunOptions {
        input: options_spec
            .get("input")
            .and_then(Value::as_str)
            .map(str::to_owned),
        timeout_ms: options_spec.get("timeoutMs").and_then(Value::as_f64),
    };

    let log = new_log();
    let host = CliHost {
        log: Rc::clone(&log),
        armed: HashSet::new(),
        next_timer: 1,
    };
    let mut run = CliRun::start(host, &paths, &run_args, &options);
    let mut settled: Option<CliRunOutcome> = None;
    let steps = spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for step in &steps {
        let size = |key: &str| step.get(key).and_then(Value::as_f64).unwrap_or(0.0) as usize;
        let settles = if let Some(out) = step.get("out").and_then(Value::as_str) {
            run.on_stdout(out.as_bytes())
        } else if let Some(hex) = step.get("outHex").and_then(Value::as_str) {
            run.on_stdout(&hex_bytes(hex))
        } else if step.get("outFill").is_some() {
            run.on_stdout(&vec![0x61; size("outFill")])
        } else if let Some(err) = step.get("err").and_then(Value::as_str) {
            run.on_stderr(err.as_bytes())
        } else if let Some(hex) = step.get("errHex").and_then(Value::as_str) {
            run.on_stderr(&hex_bytes(hex))
        } else if step.get("errFill").is_some() {
            run.on_stderr(&vec![0x62; size("errFill")])
        } else if on(step, "timer") {
            // a timer that was cleared cannot fire
            if run.host_mut().armed.remove(&1) {
                run.on_timeout(1)
            } else {
                None
            }
        } else if let Some(message) = step.get("error").and_then(Value::as_str) {
            run.on_error(&format!("Error: {message}"))
        } else if let Some(code) = step.get("close") {
            run.on_close(code.as_f64())
        } else {
            None
        };
        if let Some(outcome) = settles {
            settled.get_or_insert(outcome);
        }
    }
    flush(&log, cx);
    Ok(Some(match settled {
        Some(outcome) => summarize(&outcome),
        None => Value::from("pending"),
    }))
}

// ---- mcp-logger ----

struct ScriptClock {
    ms: Rc<Cell<f64>>,
    offset: f64,
}

impl LogClock for ScriptClock {
    fn now_ms(&self) -> f64 {
        self.ms.get()
    }

    fn utc_offset_ms(&self, _at_ms: f64) -> f64 {
        self.offset
    }
}

/// a number the JSON cannot carry: the strings `NaN`, `Infinity`, `-Infinity`
fn num(value: &Value) -> f64 {
    match value {
        Value::String(s) if s == "NaN" => f64::NAN,
        Value::String(s) if s == "Infinity" => f64::INFINITY,
        Value::String(s) if s == "-Infinity" => f64::NEG_INFINITY,
        other => other.as_f64().unwrap_or(f64::NAN),
    }
}

fn logger_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let file = text_of(&spec, "file");
    let ms = Rc::new(Cell::new(
        spec.get("start")
            .and_then(Value::as_f64)
            .unwrap_or(cx.now_ms),
    ));
    let clock = ScriptClock {
        ms: Rc::clone(&ms),
        offset: spec.get("offsetMs").and_then(Value::as_f64).unwrap_or(0.0),
    };
    let mut logger = McpLogger::new(&file, Box::new(clock));
    let mut answers: Vec<Value> = Vec::new();
    let steps = spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for step in &steps {
        if let Some(at) = step.get("at") {
            ms.set(at.as_f64().unwrap_or(f64::NAN));
        } else if let Some(message) = step.get("append") {
            logger.append(message.as_str().unwrap_or_default());
        } else if let Some(recent) = step.get("recent") {
            let limit = recent.get("limit").map(num);
            let lines = logger.recent(limit);
            answers.push(json!(["recent", lines]));
        } else if on(step, "clear") {
            logger.clear();
        } else if on(step, "ensure") {
            logger.ensure_file();
        } else if let Some(text) = step.get("write") {
            let _ = fs::write(&file, text.as_str().unwrap_or_default());
        } else if let Some(lines) = step.get("writeLines") {
            let count = lines.get("count").and_then(Value::as_u64).unwrap_or(0);
            let width = lines.get("width").and_then(Value::as_u64).unwrap_or(0) as usize;
            let prefix = text_of(lines, "prefix");
            let mut text = String::new();
            for i in 0..count {
                text.push_str(&format!("{prefix}{i} {}\n", "x".repeat(width)));
            }
            let _ = fs::write(&file, text);
        } else if on(step, "remove") {
            let _ = fs::remove_file(&file);
        } else if on(step, "readLog") {
            let text = if fs::metadata(&file).is_ok() {
                fs::read(&file).map_or(Value::Null, |bytes| {
                    Value::from(String::from_utf8_lossy(&bytes).into_owned())
                })
            } else {
                Value::Null
            };
            answers.push(json!(["file", text]));
        }
    }
    answers.push(json!(["path", logger.file_path == file]));
    Ok(Some(Value::Array(answers)))
}

// ---- docs-bridge ----

struct Wc {
    destroyed: bool,
    /// a `once('destroyed')` listener is attached
    listening: bool,
}

struct BridgeHost {
    log: Log,
    wcs: HashMap<i64, Wc>,
    blank: VecDeque<i64>,
    abandon: bool,
    armed: HashSet<u64>,
    next_timer: u64,
    settled: Vec<(u64, Settled)>,
}

impl DocsBridgeHost for BridgeHost {
    fn web_contents_alive(&mut self, wc_id: i64) -> bool {
        self.wcs.get(&wc_id).is_some_and(|wc| !wc.destroyed)
    }

    fn watch_destroyed(&mut self, wc_id: i64) {
        push(
            &self.log,
            vec![
                Value::from("wc.once"),
                Value::from(wc_id),
                Value::from("destroyed"),
            ],
        );
        if let Some(wc) = self.wcs.get_mut(&wc_id) {
            wc.listening = true;
        }
    }

    fn send_command(
        &mut self,
        wc_id: i64,
        request_id: &str,
        command: McpEditorCommandName,
        payload: Option<&JsonValue>,
    ) {
        let mut message = Map::new();
        message.insert("requestId".into(), Value::from(request_id));
        message.insert("command".into(), Value::from(command.as_str()));
        if let Some(payload) = payload {
            message.insert("payload".into(), sv(payload));
        }
        push(
            &self.log,
            vec![
                Value::from("wc.send"),
                Value::from(wc_id),
                Value::from("docs:mcp-command"),
                Value::Object(message),
            ],
        );
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        let id = self.next_timer;
        self.next_timer += 1;
        self.armed.insert(id);
        push(&self.log, vec![Value::from("setTimeout"), Value::from(ms)]);
        id
    }

    fn clear_timeout(&mut self, timer: u64) {
        push(
            &self.log,
            vec![Value::from("clearTimeout"), Value::from(timer)],
        );
        self.armed.remove(&timer);
    }

    fn settle(&mut self, op: u64, outcome: Settled) {
        self.settled.push((op, outcome));
    }

    fn exists_sync(&mut self, path: &str) -> bool {
        fs::metadata(path).is_ok()
    }

    fn open_blank_tab(&mut self) -> i64 {
        let id = self.blank.pop_front().unwrap_or(0);
        push(
            &self.log,
            vec![Value::from("deps.openBlankTab"), Value::from(id)],
        );
        id
    }

    fn authorize_save(&mut self, wc_id: i64, file_path: &str) {
        push(
            &self.log,
            vec![
                Value::from("deps.authorizeSave"),
                Value::from(wc_id),
                Value::from(file_path),
            ],
        );
    }

    fn abandon_blank_tab(&mut self, wc_id: i64) {
        if self.abandon {
            push(
                &self.log,
                vec![Value::from("deps.abandonBlankTab"), Value::from(wc_id)],
            );
        }
    }
}

fn command_of(name: &str) -> McpEditorCommandName {
    match name {
        "insert_content" => McpEditorCommandName::InsertContent,
        "replace_blocks" => McpEditorCommandName::ReplaceBlocks,
        "apply_ops" => McpEditorCommandName::ApplyOps,
        "insert_picture" => McpEditorCommandName::InsertPicture,
        "read_document" => McpEditorCommandName::ReadDocument,
        _ => McpEditorCommandName::SaveDocument,
    }
}

/// `{ ok: value }` or `{ error: message }` as the case records a promise
fn recorded(outcome: &Settled) -> Value {
    match outcome {
        Ok(Some(value)) => json!({ "ok": sv(value) }),
        Ok(None) => json!({}),
        Err(message) => json!({ "error": message }),
    }
}

fn bridge_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut wcs = HashMap::new();
    if let Some(list) = spec.get("wcs").and_then(Value::as_object) {
        for (id, state) in list {
            wcs.insert(
                id.parse::<i64>().unwrap_or(0),
                Wc {
                    destroyed: state.as_str() == Some("destroyed"),
                    listening: false,
                },
            );
        }
    }
    let host = BridgeHost {
        log: Rc::clone(&log),
        wcs,
        blank: spec
            .get("blank")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(Value::as_i64).collect())
            .unwrap_or_default(),
        abandon: on(&spec, "abandon"),
        armed: HashSet::new(),
        next_timer: 1,
        settled: Vec::new(),
    };
    let mut bridge = DocsBridge::new(host);
    let mut registered = false;
    let mut labels: HashMap<u64, String> = HashMap::new();
    let mut outcomes = Map::new();
    let steps = spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for step in &steps {
        let id_of = |key: &str| step.get(key).and_then(Value::as_i64).unwrap_or(0);
        let mut started: Option<(String, Submitted)> = None;
        if on(step, "install") {
            if bridge.install() {
                registered = true;
                for channel in ["docs:mcp-ready", "docs:mcp-result"] {
                    push(&log, vec![Value::from("ipcMain.on"), Value::from(channel)]);
                }
            }
        } else if let Some(label) = step.get("open").and_then(Value::as_str) {
            started = Some((label.to_owned(), bridge.open_blank_tab()));
        } else if let Some(label) = step.get("run").and_then(Value::as_str) {
            let command = command_of(step.get("command").and_then(Value::as_str).unwrap_or(""));
            let payload = step.get("payload").map(jv);
            started = Some((
                label.to_owned(),
                bridge.run_command(id_of("wc"), command, payload.as_ref()),
            ));
        } else if step.get("ready").is_some() {
            if registered {
                bridge.on_ready(id_of("ready"));
            } else {
                push(
                    &log,
                    vec![Value::from("no listener"), Value::from("docs:mcp-ready")],
                );
            }
        } else if step.get("result").is_some() {
            if registered {
                let payload = step.get("payload").map(jv);
                bridge.on_result(id_of("result"), payload.as_ref());
            } else {
                push(
                    &log,
                    vec![Value::from("no listener"), Value::from("docs:mcp-result")],
                );
            }
        } else if step.get("destroy").is_some() {
            let id = id_of("destroy");
            let listening = match bridge.host_mut().wcs.get_mut(&id) {
                Some(wc) => {
                    wc.destroyed = true;
                    std::mem::take(&mut wc.listening)
                }
                None => false,
            };
            if listening {
                bridge.on_destroyed(id);
            }
        } else if step.get("vanish").is_some() {
            bridge.host_mut().wcs.remove(&id_of("vanish"));
        } else if step.get("fire").is_some() {
            let id = id_of("fire") as u64;
            if bridge.host_mut().armed.remove(&id) {
                bridge.on_timeout(id);
            }
        }
        if let Some((label, submitted)) = started {
            outcomes.insert(label.clone(), Value::from("pending"));
            match submitted {
                Submitted::Resolved(value) => {
                    outcomes.insert(label, recorded(&Ok(value)));
                }
                Submitted::Rejected(message) => {
                    outcomes.insert(label, recorded(&Err(message)));
                }
                Submitted::Pending(op) => {
                    labels.insert(op, label);
                }
            }
        }
        for (op, outcome) in std::mem::take(&mut bridge.host_mut().settled) {
            if let Some(label) = labels.get(&op) {
                outcomes.insert(label.clone(), recorded(&outcome));
            }
        }
    }
    flush(&log, cx);
    Ok(Some(json!({ "outcomes": Value::Object(outcomes) })))
}
