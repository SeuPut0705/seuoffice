//! Group `b5-mcp`, slice `agent`: see tools/main-diff/groups/b5-mcp/agent.ts.
//!
//! The plain functions build the tool sets and the wrappers over fakes the
//! case describes (each call of a fake is one log line, written as the
//! TypeScript fake writes it). The scenarios drive the sans-IO services of
//! `agent_mcp` and `agent_mcp_relay` with the script the spec describes, and
//! play the world around them as a fake host: the HTTP clients (a response is
//! what the commands made of it), the listeners, the random source (ids and
//! tokens counted, written as `<idN>` and `<tokenN>`), the scripted hub and the
//! scripted card.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use jscompat::JsonValue;
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg, print_js, str_arg};
use super::mcp_pure::{Log, flush, jv, new_log, push, sv};
use crate::packages::mcp_sdk::server::{Aborted, Command, ListenerId, ResponseId, SocketId};
use crate::packages::mcp_sdk::streamable_http_server::HttpRequest;
use crate::packages::zod::to_json_schema;
use crate::pdf::pdfium::PdfiumError;
use crate::pdf::read_text::{PdfPageText, PdfTextDoc, ReadPdfTextOptions};
use crate::shell::agent::agent_mcp::{
    AGENT_MCP_TOOL_NAMES, AgentMcpDeps, AgentMcpHost, AgentMcpServer, SourceRedactor,
    build_agent_mcp_tools, create_agent_skill_tools, start_agent_mcp_server,
    withholding_open_documents, withholding_slides,
};
use crate::shell::agent::agent_mcp_relay::{
    AgentMcpRelays, AgentMcpRelaysDeps, AgentRelayAnswer, AgentRelayAsk, AgentRelayAskRequest,
    AgentRelayHub, AgentRelayScope, RELAY_TEXT, RelayCallId, RelayStep, ServiceCommand,
    agent_relay_plans, relay_result_of,
};
use crate::shell::mcp::mcp_server::{HostCall, McpToolDefinition, Settled, ToolStep};
use crate::shell::mcp::tools::hwp_tools::HwpTextReader;
use crate::shell::mcp::tools::pdf_tools::PdfTextReader;

// ---- small readers of a case ----

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn on(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// the scripted answer of a `Val`: `{ value }`, `{ undef: true }` or `{ throws }`
fn scripted(val: Option<&Value>) -> Result<Option<Value>, String> {
    let Some(val) = val else { return Ok(None) };
    if let Some(message) = val.get("throws").and_then(Value::as_str) {
        return Err(message.to_owned());
    }
    if on(val, "undef") {
        return Ok(None);
    }
    Ok(val.get("value").cloned())
}

// ---- fakes ----

/// `{ title, filePath?, dirty }` of a tab, as the hook of the spec logs it
fn tab_json(tab: &Value) -> Value {
    let mut out = Map::new();
    out.insert(
        "title".into(),
        tab.get("title").cloned().unwrap_or(Value::Null),
    );
    if let Some(path) = tab.get("filePath") {
        out.insert("filePath".into(), path.clone());
    }
    if let Some(dirty) = tab.get("dirty") {
        out.insert("dirty".into(), dirty.clone());
    }
    Value::Object(out)
}

/// where `proposeSkill` of the hook reads the open tabs from
enum Tabs {
    /// the default reader: no tabs
    Empty,
    /// the `openTabs` of the case: `{ list }` or `{ throws }`
    Reader(Value),
    /// the open-documents control of the deps, as the agent's tool set reads them
    Control,
}

/// the host of the tools: answers each `HostCall` from the case's script and
/// logs it as the TypeScript fake of that control logs it
struct HostScript {
    /// the deps of the case: `docs`, `slides`, `sheets`, `open`, `resolve`, `skill`
    deps: Value,
    tabs: Tabs,
    log: Log,
}

impl HostScript {
    fn spec(&self, key: &str) -> Value {
        self.deps.get(key).cloned().unwrap_or(Value::Null)
    }

    fn log(&self, line: Vec<Value>) {
        push(&self.log, line);
    }

    /// the open tabs of the hook's context
    fn read_tabs(&self) -> Result<Vec<Value>, String> {
        match &self.tabs {
            Tabs::Empty => Ok(Vec::new()),
            Tabs::Reader(spec) => {
                self.log(vec![Value::from("openTabs")]);
                if let Some(message) = spec.get("throws").and_then(Value::as_str) {
                    return Err(message.to_owned());
                }
                Ok(spec
                    .get("list")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default())
            }
            Tabs::Control => {
                if self.deps.get("open").is_none_or(Value::is_null) {
                    return Ok(Vec::new());
                }
                let listed = self.answer_value(&HostCall {
                    control: "OpenDocumentsControl",
                    method: "list",
                    args: Vec::new(),
                })?;
                Ok(listed
                    .and_then(|list| list.as_array().cloned())
                    .unwrap_or_default())
            }
        }
    }

    fn answer(&self, call: &HostCall) -> Settled {
        self.answer_value(call)
            .map(|value| value.map(|value| jv(&value)))
    }

    fn answer_value(&self, call: &HostCall) -> Result<Option<Value>, String> {
        let arg = |at: usize| call.args.get(at).map(sv).unwrap_or(Value::Null);
        let id = |tab: &Value| tab.get("id").cloned().unwrap_or(Value::Null);
        match (call.control, call.method) {
            ("OpenDocumentsControl", "list") => {
                let open = self.spec("open");
                self.log(vec![Value::from("control.list")]);
                match open.get("list") {
                    Some(Value::Array(_)) => Ok(open.get("list").cloned()),
                    other => Err(other.map(|list| text(list, "throws")).unwrap_or_default()),
                }
            }
            ("OpenDocumentsControl", "read") => {
                self.log(vec![Value::from("control.read"), id(&arg(0))]);
                scripted(self.spec("open").get("read"))
            }
            ("OpenDocumentsControl", "close") => {
                self.log(vec![Value::from("control.close"), id(&arg(0)), arg(1)]);
                Ok(Some(
                    scripted(self.spec("open").get("close"))?.unwrap_or_else(|| json!({})),
                ))
            }
            ("OpenDocumentsControl", "save") => {
                self.log(vec![Value::from("control.save"), id(&arg(0))]);
                Ok(Some(
                    scripted(self.spec("open").get("save"))?
                        .unwrap_or_else(|| json!({ "savedPath": "" })),
                ))
            }
            ("SlidesControl", "openBlankTab") => {
                self.log(vec![Value::from("slides.open")]);
                Ok(Some(
                    scripted(self.spec("slides").get("open"))?.unwrap_or_else(|| Value::from(3)),
                ))
            }
            ("SlidesControl", "runTxn") => {
                self.log(vec![Value::from("slides.txn"), arg(0), arg(1)]);
                scripted(self.spec("slides").get("txn"))
            }
            ("SlidesControl", "readDeck") => {
                self.log(vec![Value::from("slides.read"), arg(0), arg(1)]);
                scripted(self.spec("slides").get("read"))
            }
            ("SlidesControl", "saveDeck") => {
                let slides = self.spec("slides");
                self.log(vec![Value::from("slides.save"), arg(0), arg(1), arg(2)]);
                if let Some(message) = slides.get("saveThrows").and_then(Value::as_str) {
                    return Err(message.to_owned());
                }
                let path = slides.get("savePath").cloned().unwrap_or_else(|| arg(1));
                Ok(Some(json!({ "path": path })))
            }
            ("SlidesControl", "deckWithholds") => {
                self.log(vec![Value::from("slides.withholds"), arg(0)]);
                scripted(self.spec("slides").get("withholds"))
            }
            ("SheetsControl", "openBlankTab") => {
                self.log(vec![Value::from("sheets.open")]);
                Ok(Some(Value::from(5)))
            }
            ("SheetsControl", "runCommand") => {
                self.log(vec![Value::from("sheets.run"), arg(0), arg(1), arg(2)]);
                scripted(self.spec("sheets").get("run"))
            }
            ("DocsControl", "openBlankTab") => {
                self.log(vec![Value::from("docs.open")]);
                Ok(Some(Value::from(1)))
            }
            ("DocsControl", "runCommand") => {
                self.log(vec![Value::from("docs.run"), arg(0), arg(1), arg(2)]);
                scripted(self.spec("docs").get("run"))
            }
            ("TargetResolver", _) => {
                self.log(vec![Value::from("resolve"), arg(0), arg(1)]);
                scripted(Some(&self.spec("resolve")))
            }
            ("AgentSkillToolHooks", "proposeSkill") => {
                let hooks = self.spec("skill");
                self.log(vec![Value::from("hooks.proposeSkill"), arg(0)]);
                if on(&hooks, "readTabs") {
                    match self.read_tabs() {
                        Ok(tabs) => self.log(vec![
                            Value::from("tabs"),
                            Value::Array(tabs.iter().map(tab_json).collect()),
                        ]),
                        Err(message) => {
                            self.log(vec![Value::from("tabs threw"), Value::from(message)])
                        }
                    }
                }
                scripted(hooks.get("propose")).map(|_| None)
            }
            ("AgentSkillToolHooks", "proposeInstall") => {
                self.log(vec![Value::from("hooks.proposeInstall"), arg(0)]);
                scripted(self.spec("skill").get("install")).map(|_| None)
            }
            (control, method) => Err(format!("no fake for {control}.{method}")),
        }
    }
}

/// carries a tool's steps out against the script, to the value or error it ends with
fn run_step(mut step: ToolStep<'_>, script: &HostScript) -> Settled {
    loop {
        match step {
            ToolStep::Done(settled) => return settled,
            ToolStep::Await { call, then } => step = then(script.answer(&call)),
        }
    }
}

/// `redactMarkdownSource` and `redactHtmlSource` of the case: `md<..>` and `html<..>`
struct FakeRedactor {
    log: Log,
}

impl SourceRedactor for FakeRedactor {
    fn redact_markdown_source(&self, source: &str) -> String {
        push(
            &self.log,
            vec![Value::from("redactMarkdownSource"), Value::from(source)],
        );
        format!("md<{source}>")
    }

    fn redact_html_source(&self, source: &str) -> String {
        push(
            &self.log,
            vec![Value::from("redactHtmlSource"), Value::from(source)],
        );
        format!("html<{source}>")
    }
}

fn page_of(value: &Value) -> PdfPageText {
    PdfPageText {
        page: value.get("page").and_then(Value::as_f64).unwrap_or(0.0),
        width_pt: value.get("widthPt").and_then(Value::as_f64).unwrap_or(0.0),
        height_pt: value.get("heightPt").and_then(Value::as_f64).unwrap_or(0.0),
        chars: value.get("chars").and_then(Value::as_i64).unwrap_or(0) as i32,
        text: text(value, "text"),
        has_text_layer: on(value, "hasTextLayer"),
    }
}

/// the PDF reader of a case: `{ pageCount, info, pages }`; a read with a
/// zero budget is the probe
struct FakePdf {
    world: Value,
    log: Log,
}

impl PdfTextReader for FakePdf {
    fn read_pdf_text(
        &self,
        bytes: &[u8],
        options: &ReadPdfTextOptions,
    ) -> Result<PdfTextDoc, PdfiumError> {
        let mut shown = Map::new();
        if let Some(pages) = &options.pages {
            shown.insert(
                "pages".into(),
                Value::Array(pages.iter().copied().map(Value::from).collect()),
            );
        }
        if let Some(budget) = options.char_budget {
            shown.insert("charBudget".into(), Value::from(budget));
        }
        push(
            &self.log,
            vec![
                Value::from("readPdfText"),
                Value::from(String::from_utf8_lossy(bytes).into_owned()),
                Value::Object(shown),
            ],
        );
        let page_count = self
            .world
            .get("pageCount")
            .and_then(Value::as_i64)
            .unwrap_or(1) as i32;
        if options.char_budget == Some(0.0) {
            return Ok(PdfTextDoc {
                page_count,
                title: None,
                author: None,
                pages: Vec::new(),
                truncated: false,
            });
        }
        let info = self.world.get("info");
        Ok(PdfTextDoc {
            page_count,
            title: info
                .and_then(|i| i.get("title"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            author: info
                .and_then(|i| i.get("author"))
                .and_then(Value::as_str)
                .map(str::to_owned),
            pages: self
                .world
                .get("pages")
                .and_then(Value::as_array)
                .map(|list| list.iter().map(page_of).collect())
                .unwrap_or_default(),
            truncated: false,
        })
    }
}

/// the HWP engine of a case: answers `text`
struct FakeHwp {
    text: String,
    log: Log,
}

impl HwpTextReader for FakeHwp {
    fn hwp_to_text(&self, bytes: &[u8]) -> Result<String, String> {
        push(
            &self.log,
            vec![
                Value::from("hwpToText"),
                Value::from(String::from_utf8_lossy(bytes).into_owned()),
            ],
        );
        Ok(self.text.clone())
    }
}

/// `depsOf(spec, log)` of the spec: a control is there when the case has it
fn deps_of(spec: &Value, outer: &Value, log: &Log) -> AgentMcpDeps<'static> {
    let has = |key: &str| spec.get(key).is_some_and(|value| !value.is_null());
    AgentMcpDeps {
        version: spec
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("9.9.9")
            .to_owned(),
        default_save_dir: Rc::new(|| "/save".to_owned()),
        docs_control: has("docs"),
        slides_control: has("slides"),
        slides_deck_withholds: spec
            .get("slides")
            .is_some_and(|slides| slides.get("withholds").is_some()),
        sheets_control: has("sheets"),
        open_documents_control: has("open"),
        resolve_target: has("resolve"),
        skill_tools: has("skill"),
        cli: None,
        hwp_reader: Rc::new(FakeHwp {
            text: outer
                .get("hwp")
                .and_then(Value::as_str)
                .unwrap_or("hwp text")
                .to_owned(),
            log: Rc::clone(log),
        }),
        pdf_reader: Rc::new(FakePdf {
            world: outer.get("pdf").cloned().unwrap_or_else(|| json!({})),
            log: Rc::clone(log),
        }),
        redactor: Rc::new(FakeRedactor {
            log: Rc::clone(log),
        }),
    }
}

// ---- the tool helpers ----

/// what the SDK lists of the tools: `{ name, description, inputSchema }`
fn listed(tools: &[McpToolDefinition<'_>]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|tool| {
                let schema = match &tool.input_schema {
                    Some(shape) => sv(&to_json_schema(shape)),
                    None => json!({ "type": "object", "properties": {} }),
                };
                json!({
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": schema,
                })
            })
            .collect(),
    )
}

/// `tools.find(name).handler(args ?? {})`, its host calls answered by the script
fn call_tool(
    tools: Vec<McpToolDefinition<'_>>,
    name: &str,
    args: Option<&Value>,
    script: &HostScript,
) -> Answer {
    let Some(mut tool) = tools.into_iter().find(|tool| tool.name == name) else {
        return Err(CallError::plain(format!("no such tool: {name}")));
    };
    let args = match args {
        Some(args) if !args.is_null() => jv(args),
        _ => jv(&json!({})),
    };
    run_step((tool.handler)(args), script)
        .map(|value| value.map(|value| sv(&value)))
        .map_err(CallError::plain)
}

/// a step's answer: its value, or what it threw
fn step_answer(result: Settled) -> Value {
    match result {
        Ok(Some(value)) => json!({ "value": sv(&value) }),
        Ok(None) => json!({ "undef": true }),
        Err(message) => json!({ "error": message }),
    }
}

// ---- the plain functions ----

fn skill_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let hooks = spec.get("hooks").filter(|hooks| !hooks.is_null()).cloned();
    let tabs = match spec.get("tabs").filter(|tabs| !tabs.is_null()) {
        Some(tabs) => Tabs::Reader(tabs.clone()),
        None => Tabs::Empty,
    };
    let script = HostScript {
        deps: json!({ "skill": hooks }),
        tabs,
        log: Rc::clone(&log),
    };
    let tools = create_agent_skill_tools(hooks.is_some());
    let answer = if on(&spec, "list") {
        Ok(Some(listed(&tools)))
    } else {
        call_tool(tools, &text(&spec, "tool"), spec.get("args"), &script)
    };
    flush(&log, cx);
    answer
}

/// a first step awaiting one control call, which comes back as it is
fn first_step<'h>(control: &'static str, method: &'static str, args: Vec<Value>) -> ToolStep<'h> {
    ToolStep::Await {
        call: HostCall {
            control,
            method,
            args: args.iter().map(jv).collect(),
        },
        then: Box::new(ToolStep::Done),
    }
}

fn slides_script(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let control = spec.get("control").cloned().unwrap_or(Value::Null);
    let has_deck_withholds = control.get("withholds").is_some();
    let script = HostScript {
        deps: json!({ "slides": control }),
        tabs: Tabs::Empty,
        log: Rc::clone(&log),
    };
    let mut out = Vec::new();
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let wc = step.get("wc").cloned().unwrap_or(Value::Null);
        let first = match text(&step, "op").as_str() {
            "open" => first_step("SlidesControl", "openBlankTab", Vec::new()),
            "read" => {
                let mut call_args = vec![wc];
                if let Some(options) = step.get("options") {
                    call_args.push(options.clone());
                }
                first_step("SlidesControl", "readDeck", call_args)
            }
            "txn" => first_step(
                "SlidesControl",
                "runTxn",
                vec![wc, step.get("req").cloned().unwrap_or(Value::Null)],
            ),
            "save" => first_step(
                "SlidesControl",
                "saveDeck",
                vec![
                    wc,
                    step.get("path").cloned().unwrap_or(Value::Null),
                    step.get("overwrite").cloned().unwrap_or(Value::Null),
                ],
            ),
            "withholds" if has_deck_withholds => {
                first_step("SlidesControl", "deckWithholds", vec![wc])
            }
            "withholds" => ToolStep::Done(Ok(Some(JsonValue::String("absent".to_owned())))),
            other => return Err(CallError::plain(format!("unknown step {other}"))),
        };
        out.push(step_answer(run_step(
            withholding_slides(first, has_deck_withholds),
            &script,
        )));
    }
    flush(&log, cx);
    Ok(Some(Value::Array(out)))
}

fn open_script(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let script = HostScript {
        deps: json!({ "open": spec.get("control").cloned().unwrap_or(Value::Null) }),
        tabs: Tabs::Empty,
        log: Rc::clone(&log),
    };
    let redactor = Rc::new(FakeRedactor {
        log: Rc::clone(&log),
    });
    let mut out = Vec::new();
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let tab = step.get("tab").cloned().unwrap_or(Value::Null);
        let first = match text(&step, "op").as_str() {
            "list" => first_step("OpenDocumentsControl", "list", Vec::new()),
            "read" => first_step("OpenDocumentsControl", "read", vec![tab]),
            "close" => {
                let unsaved = step
                    .get("unsaved")
                    .and_then(Value::as_str)
                    .unwrap_or("save");
                first_step(
                    "OpenDocumentsControl",
                    "close",
                    vec![tab, json!({ "unsaved": unsaved })],
                )
            }
            "save" => first_step("OpenDocumentsControl", "save", vec![tab]),
            other => return Err(CallError::plain(format!("unknown step {other}"))),
        };
        out.push(step_answer(run_step(
            withholding_open_documents(first, Rc::clone(&redactor) as Rc<dyn SourceRedactor>),
            &script,
        )));
    }
    flush(&log, cx);
    Ok(Some(Value::Array(out)))
}

fn build(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let deps_spec = spec.get("deps").cloned().unwrap_or(Value::Null);
    let deps = deps_of(&deps_spec, &spec, &log);
    let script = HostScript {
        deps: deps_spec,
        tabs: Tabs::Control,
        log: Rc::clone(&log),
    };
    let tools = build_agent_mcp_tools(
        &deps,
        &text(&spec, "root"),
        spec.get("platform").and_then(Value::as_str),
    );
    let answer = match spec.get("tool").and_then(Value::as_str) {
        None => Ok(Some(Value::Array(
            tools
                .iter()
                .map(|tool| Value::from(tool.name.as_str()))
                .collect(),
        ))),
        Some(name) => call_tool(tools, name, spec.get("args"), &script),
    };
    flush(&log, cx);
    answer
}

// ---- the relay's pure functions ----

fn plan_json(plan: &crate::shell::agent::agent_mcp_relay::AgentRelayPlan) -> Value {
    json!({
        "server": plan.server,
        "keepResultsInside": plan.keep_results_inside,
        "instructions": plan.instructions,
        "tools": plan.tools.iter().map(|tool| json!({
            "name": tool.name,
            "relayName": tool.relay_name,
            "description": tool.description,
            "inputSchema": sv(&tool.input_schema),
        })).collect::<Vec<_>>(),
    })
}

fn relay_text(args: &[Value]) -> Answer {
    let name = str_arg(args, 0)?;
    let part = |at: usize| str_arg(args, at);
    Ok(Some(Value::from(match name {
        "needsReview" => RELAY_TEXT.needs_review(part(1)?, part(2)?),
        "unknownTool" => RELAY_TEXT.unknown_tool(part(1)?, part(2)?),
        "declined" => RELAY_TEXT.declined().to_owned(),
        "stopped" => RELAY_TEXT.stopped(part(1)?),
        other => return Err(CallError::plain(format!("unknown text {other}"))),
    })))
}

// ---- the world of the scenarios ----

/// the host of the services: counted ids and tokens
struct FakeHost {
    uuids: Cell<u32>,
    bytes: Cell<u32>,
}

impl AgentMcpHost for FakeHost {
    fn random_bytes(&self, n: usize) -> Vec<u8> {
        let from = self.bytes.get();
        self.bytes.set(from + n as u32);
        (0..n as u32).map(|i| ((from + i) % 251) as u8).collect()
    }

    fn random_uuid(&self) -> String {
        let n = self.uuids.get() + 1;
        self.uuids.set(n);
        format!("00000000-0000-4000-8000-{n:012x}")
    }

    fn now_ms(&self) -> f64 {
        0.0
    }
}

/// the port the system picks for the first service; the next ones follow
const BOUND_PORT: f64 = 49152.0;

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_uuid_at(chars: &[char], at: usize) -> bool {
    if at + 36 > chars.len() {
        return false;
    }
    chars[at..at + 36].iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == '-',
        _ => c.is_ascii_digit() || ('a'..='f').contains(c),
    })
}

/// `text.replace(/\b<port>\b/g, '$PORT')`
fn replace_port(text: &str, port: f64) -> String {
    let needle: Vec<char> = jscompat::number_to_string(port).chars().collect();
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let end = i + needle.len();
        let before = i == 0 || !is_word(chars[i - 1]);
        let after = end >= chars.len() || !is_word(chars[end]);
        if end <= chars.len() && chars[i..end] == needle[..] && before && after {
            out.push_str("$PORT");
            i = end;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

#[derive(Default)]
struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    text: String,
    head: bool,
    ended: bool,
    destroyed: bool,
}

/// the clients of one service
#[derive(Default)]
struct Wire {
    responses: Vec<Resp>,
    /// the session ids of the service, in the order they first appeared
    sessions: Vec<String>,
    /// streams kept under a name: the response, the frames taken, `namesOnly`
    open: Vec<(String, ResponseId, usize, bool)>,
}

enum Item {
    Cmd(usize, Command),
    Listening(usize, ListenerId, f64),
    Closed(usize, ListenerId),
    ResponseClosed(usize, ResponseId),
    SocketClosed(usize, SocketId),
}

/// what the scenario drives: the session's app server, or the relays
enum Target {
    Agent(Box<AgentMcpServer<'static>>),
    Relays(AgentMcpRelays<'static>),
}

impl Target {
    fn service(
        &mut self,
        index: usize,
    ) -> &mut crate::shell::mcp::mcp_server::McpServerService<'static> {
        match self {
            Target::Agent(server) => server.service(),
            Target::Relays(relays) => relays.service_mut(index),
        }
    }
}

struct World {
    /// answers the host calls of the tools (the agent's tool server only)
    script: Option<HostScript>,
    wires: Vec<Wire>,
    ids: Vec<String>,
    ports: Vec<f64>,
    tokens: Vec<String>,
    log: Log,
}

impl World {
    fn norm(&mut self, text: &str) -> String {
        let mut out = text.to_owned();
        for (i, token) in self.tokens.iter().enumerate() {
            out = out.replace(token, &format!("<token{}>", i + 1));
        }
        let chars: Vec<char> = out.chars().collect();
        let mut done = String::new();
        let mut i = 0;
        while i < chars.len() {
            if is_uuid_at(&chars, i) {
                let id: String = chars[i..i + 36].iter().collect();
                let at = match self.ids.iter().position(|known| *known == id) {
                    Some(at) => at,
                    None => {
                        self.ids.push(id);
                        self.ids.len() - 1
                    }
                };
                done.push_str(&format!("<id{}>", at + 1));
                i += 36;
            } else {
                done.push(chars[i]);
                i += 1;
            }
        }
        for port in &self.ports {
            done = replace_port(&done, *port);
        }
        done
    }

    /// `JSON.parse(net.norm(JSON.stringify(value)))`
    fn norm_value(&mut self, value: &Value) -> Value {
        let mut printed = String::new();
        print_js(value, &mut printed);
        let normed = self.norm(&printed);
        serde_json::from_str(&normed).unwrap_or(Value::Null)
    }

    /// the log lines since the last step, normalized
    fn take_logs(&mut self) -> Vec<Value> {
        let lines: Vec<Vec<Value>> = self.log.borrow_mut().drain(..).collect();
        lines
            .into_iter()
            .map(|line| Value::Array(line.iter().map(|v| self.norm_value(v)).collect()))
            .collect()
    }

    fn resp(&mut self, index: usize, res: ResponseId) -> &mut Resp {
        let wire = &mut self.wires[index];
        while wire.responses.len() <= res.0 as usize {
            wire.responses.push(Resp::default());
        }
        &mut wire.responses[res.0 as usize]
    }

    fn destroy(&mut self, index: usize, res: ResponseId, queue: &mut VecDeque<Item>) {
        let resp = self.resp(index, res);
        if !resp.destroyed && !resp.ended {
            resp.destroyed = true;
            queue.push_back(Item::ResponseClosed(index, res));
            queue.push_back(Item::SocketClosed(index, SocketId(res.0)));
        }
    }

    /// carries the commands out, and what they make happen
    fn pump(&mut self, target: &mut Target, commands: Vec<ServiceCommand>) {
        let mut queue: VecDeque<Item> = commands
            .into_iter()
            .map(|c| Item::Cmd(c.service, c.command))
            .collect();
        while let Some(item) = queue.pop_front() {
            let more: Vec<(usize, Command)> = match item {
                Item::Cmd(index, command) => {
                    self.apply(target, index, command, &mut queue);
                    Vec::new()
                }
                Item::Listening(index, listener, port) => target
                    .service(index)
                    .on_listening(listener, port)
                    .into_iter()
                    .map(|c| (index, c))
                    .collect(),
                Item::Closed(index, listener) => target
                    .service(index)
                    .on_listener_closed(listener)
                    .into_iter()
                    .map(|c| (index, c))
                    .collect(),
                Item::ResponseClosed(index, res) => target
                    .service(index)
                    .on_response_closed(res)
                    .into_iter()
                    .map(|c| (index, c))
                    .collect(),
                Item::SocketClosed(index, socket) => {
                    target.service(index).on_socket_closed(socket);
                    Vec::new()
                }
            };
            queue.extend(more.into_iter().map(|(i, c)| Item::Cmd(i, c)));
        }
    }

    fn step_commands(&mut self, step: RelayStep, queue: &mut VecDeque<Item>) {
        for c in step.commands {
            queue.push_back(Item::Cmd(c.service, c.command));
        }
        let _ = step.done;
    }

    fn apply(
        &mut self,
        target: &mut Target,
        index: usize,
        command: Command,
        queue: &mut VecDeque<Item>,
    ) {
        match command {
            Command::Respond {
                res,
                status,
                headers,
            } => {
                let resp = self.resp(index, res);
                if !resp.destroyed && !resp.head {
                    resp.status = status;
                    resp.headers = headers;
                    resp.head = true;
                }
            }
            Command::Write { res, chunk } => {
                let resp = self.resp(index, res);
                if !resp.destroyed && !resp.ended {
                    resp.text.push_str(&chunk);
                }
            }
            Command::End { res, chunk } => {
                let resp = self.resp(index, res);
                if !resp.destroyed && !resp.ended {
                    if let Some(chunk) = chunk {
                        resp.text.push_str(&chunk);
                    }
                    resp.ended = true;
                    queue.push_back(Item::ResponseClosed(index, res));
                    queue.push_back(Item::SocketClosed(index, SocketId(res.0)));
                }
            }
            Command::Destroy { res } => self.destroy(index, res, queue),
            Command::DestroySocket { socket } => self.destroy(index, ResponseId(socket.0), queue),
            Command::Listen { listener, .. } => {
                queue.push_back(Item::Listening(index, listener, BOUND_PORT + index as f64));
            }
            Command::CloseListener { listener } => queue.push_back(Item::Closed(index, listener)),
            Command::StartSettled { outcome, .. } => {
                if let Target::Relays(relays) = target {
                    let step = relays.on_started(index, outcome);
                    self.step_commands(step, queue);
                }
            }
            Command::StopSettled { stop } => {
                if let Target::Relays(relays) = target {
                    let step = relays.on_stopped(index, stop);
                    self.step_commands(step, queue);
                }
            }
            Command::Aborted(aborted) => self.aborted(target, index, &aborted, queue),
            Command::ToolCall {
                session_id,
                ticket,
                call,
            } => {
                let settled = match &self.script {
                    Some(script) => script.answer(&call),
                    None => Err("no host".to_owned()),
                };
                for command in target
                    .service(index)
                    .resume_tool(&session_id, ticket, settled)
                {
                    queue.push_back(Item::Cmd(index, command));
                }
            }
            Command::SetInterval { .. }
            | Command::SetTimeout { .. }
            | Command::ClearTimer { .. }
            | Command::Log(_) => {}
        }
    }

    fn aborted(
        &mut self,
        target: &mut Target,
        index: usize,
        aborted: &Aborted,
        queue: &mut VecDeque<Item>,
    ) {
        if let Target::Relays(relays) = target {
            let step = relays.on_aborted(index, aborted);
            self.step_commands(step, queue);
        }
    }

    fn destroy_now(&mut self, target: &mut Target, index: usize, res: ResponseId) {
        let mut queue = VecDeque::new();
        self.destroy(index, res, &mut queue);
        self.drain(target, queue);
    }

    fn drain(&mut self, target: &mut Target, mut queue: VecDeque<Item>) {
        let mut pending = Vec::new();
        while let Some(item) = queue.pop_front() {
            match item {
                Item::ResponseClosed(index, res) => {
                    for c in target.service(index).on_response_closed(res) {
                        pending.push(ServiceCommand {
                            service: index,
                            command: c,
                        });
                    }
                }
                Item::SocketClosed(index, socket) => target.service(index).on_socket_closed(socket),
                _ => {}
            }
        }
        self.pump(target, pending);
    }

    /// the JSON-RPC message of a frame, with `tools/list` shown as names when asked
    fn frame_value(&mut self, frame: &str, names_only: bool) -> Value {
        let line = frame.lines().find_map(|line| line.strip_prefix("data: "));
        let Some(line) = line else {
            return Value::String(self.norm(frame));
        };
        let normed = self.norm(line);
        let mut value: Value = serde_json::from_str(&normed).unwrap_or(Value::Null);
        if names_only
            && let Some(tools) = value
                .get_mut("result")
                .and_then(|result| result.get_mut("tools"))
            && let Some(list) = tools.as_array()
        {
            *tools = Value::Array(
                list.iter()
                    .map(|tool| tool.get("name").cloned().unwrap_or(Value::Null))
                    .collect(),
            );
        }
        value
    }

    /// one `rpc` or `notify` step to service `index`; `None` target is a stopped service
    fn send(
        &mut self,
        target: &mut Target,
        step: &Value,
        index: usize,
        live: bool,
    ) -> Map<String, Value> {
        let mut out = Map::new();
        if !live || !target.service(index).is_running() {
            out.insert("error".into(), Value::from("aborted"));
            return out;
        }
        let port = BOUND_PORT + index as f64;
        let res = ResponseId(self.wires[index].responses.len() as u64);
        self.wires[index].responses.push(Resp::default());
        let mut headers: Vec<(String, String)> = vec![
            (
                "host".into(),
                format!("127.0.0.1:{}", jscompat::number_to_string(port)),
            ),
            ("content-type".into(), "application/json".into()),
            (
                "accept".into(),
                "application/json, text/event-stream".into(),
            ),
        ];
        let token = match &*target {
            Target::Agent(server) => server.token().to_owned(),
            Target::Relays(relays) => relays.token(index).to_owned(),
        };
        match step.get("auth").and_then(Value::as_str) {
            None | Some("good") => {
                headers.push(("authorization".into(), format!("Bearer {token}")))
            }
            Some("bad") => headers.push(("authorization".into(), "Bearer nope".into())),
            _ => {}
        }
        if let Some(n) = step
            .get("session")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0)
        {
            let sid = self.wires[index]
                .sessions
                .get(n as usize - 1)
                .cloned()
                .unwrap_or_else(|| "unknown".to_owned());
            headers.push(("mcp-session-id".into(), sid));
        }
        let op = text(step, "op");
        let mut body = String::new();
        if op == "rpc" || op == "notify" {
            let mut message = Map::new();
            message.insert("jsonrpc".into(), Value::from("2.0"));
            if op == "rpc" {
                message.insert(
                    "id".into(),
                    step.get("id").cloned().unwrap_or(Value::from(1)),
                );
            }
            message.insert("method".into(), Value::from(text(step, "rpc")));
            if let Some(params) = step.get("params") {
                message.insert("params".into(), params.clone());
            }
            print_js(&Value::Object(message), &mut body);
        }
        headers.push(("content-length".into(), body.len().to_string()));
        let request = HttpRequest {
            method: "POST".to_owned(),
            url: "/mcp".to_owned(),
            headers,
        };
        let names_only = on(step, "namesOnly");
        target.service(index).on_connection(SocketId(res.0));
        let commands = target
            .service(index)
            .on_request(res, &request, body.as_bytes());
        self.pump(
            target,
            commands
                .into_iter()
                .map(|command| ServiceCommand {
                    service: index,
                    command,
                })
                .collect(),
        );

        let (status, head, destroyed, ended, text_so_far, resp_headers) = {
            let resp = self.resp(index, res);
            (
                resp.status,
                resp.head,
                resp.destroyed,
                resp.ended,
                resp.text.clone(),
                resp.headers.clone(),
            )
        };
        if destroyed && !head {
            out.insert("error".into(), Value::from("aborted"));
            return out;
        }
        out.insert("status".into(), Value::from(status));
        let header = |name: &str| {
            resp_headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.clone())
        };
        let content_type = header("content-type");
        if let Some(kind) = &content_type {
            out.insert("type".into(), Value::from(kind.as_str()));
        }
        if let Some(sid) = header("mcp-session-id") {
            if !self.wires[index].sessions.contains(&sid) {
                self.wires[index].sessions.push(sid.clone());
            }
            let shown = self.norm(&sid);
            out.insert("session".into(), Value::from(shown));
        }
        let frames = frames_of(&text_so_far);
        if content_type
            .as_deref()
            .is_some_and(|kind| kind.starts_with("text/event-stream"))
        {
            let values: Vec<Value> = frames
                .iter()
                .map(|f| self.frame_value(f, names_only))
                .collect();
            out.insert("frames".into(), Value::Array(values));
        } else if !text_so_far.is_empty() {
            let normed = self.norm(&text_so_far);
            out.insert(
                "json".into(),
                serde_json::from_str(&normed).unwrap_or(Value::Null),
            );
        }
        if !ended {
            out.insert("ended".into(), Value::Bool(false));
        }
        if let Some(name) = step.get("open").and_then(Value::as_str) {
            self.wires[index].open.retain(|(n, _, _, _)| n != name);
            self.wires[index]
                .open
                .push((name.to_owned(), res, frames.len(), names_only));
        } else if !ended {
            self.destroy_now(target, index, res);
        }
        out
    }

    /// `read`: the frames a kept stream got since the last read
    fn read(&mut self, id: &str) -> Map<String, Value> {
        let mut out = Map::new();
        let found = self.wires.iter().enumerate().find_map(|(index, wire)| {
            wire.open
                .iter()
                .position(|(n, _, _, _)| n == id)
                .map(|at| (index, at))
        });
        let Some((index, at)) = found else {
            return out;
        };
        let (_, res, taken, names_only) = self.wires[index].open[at].clone();
        let (text_so_far, closed) = {
            let resp = self.resp(index, res);
            (resp.text.clone(), resp.ended || resp.destroyed)
        };
        let list = frames_of(&text_so_far);
        let shown: Vec<Value> = list
            .iter()
            .skip(taken)
            .map(|f| self.frame_value(f, names_only))
            .collect();
        self.wires[index].open[at].2 = list.len();
        out.insert("frames".into(), Value::Array(shown));
        if closed {
            out.insert("closed".into(), Value::Bool(true));
        }
        out
    }

    /// `close`: the client goes away
    fn close(&mut self, target: &mut Target, id: &str) {
        let found = self.wires.iter().enumerate().find_map(|(index, wire)| {
            wire.open
                .iter()
                .position(|(n, _, _, _)| n == id)
                .map(|at| (index, at))
        });
        if let Some((index, at)) = found {
            let (_, res, _, _) = self.wires[index].open.remove(at);
            self.destroy_now(target, index, res);
        }
    }
}

fn frames_of(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(end) = text[at..].find("\n\n") {
        out.push(text[at..at + end + 2].to_owned());
        at += end + 2;
    }
    out
}

/// the steps both scenarios share; `false` when the step is not one of them
fn http_step(
    world: &mut World,
    target: &mut Target,
    step: &Value,
    live: bool,
    out: &mut Map<String, Value>,
) -> bool {
    let index = step
        .get("relay")
        .and_then(Value::as_u64)
        .map_or(0, |n| (n as usize).saturating_sub(1));
    match text(step, "op").as_str() {
        "rpc" | "notify" => {
            if index >= world.wires.len() {
                out.insert("error".into(), Value::from("aborted"));
            } else {
                out.extend(world.send(target, step, index, live));
            }
            true
        }
        "read" => {
            out.extend(world.read(&text(step, "id")));
            true
        }
        "close" => {
            world.close(target, &text(step, "id"));
            true
        }
        _ => false,
    }
}

fn new_world(log: Log) -> World {
    World {
        script: None,
        wires: Vec::new(),
        ids: Vec::new(),
        ports: Vec::new(),
        tokens: Vec::new(),
        log,
    }
}

// ---- agent-mcp.scenario ----

fn agent_scenario(args: &[Value]) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut world = new_world(Rc::clone(&log));
    let deps_spec = spec.get("deps").cloned().unwrap_or(Value::Null);
    let deps = Rc::new(deps_of(&deps_spec, &spec, &log));
    world.script = Some(HostScript {
        deps: deps_spec,
        tabs: Tabs::Control,
        log: Rc::clone(&log),
    });
    let host = Rc::new(FakeHost {
        uuids: Cell::new(0),
        bytes: Cell::new(0),
    });
    let (server, _, commands) = start_agent_mcp_server(deps, &text(&spec, "root"), host);
    let mut target = Target::Agent(Box::new(server));
    world.wires.push(Wire::default());
    world.ports.push(BOUND_PORT);
    if let Target::Agent(server) = &target {
        world.tokens.push(server.token().to_owned());
    }
    world.pump(
        &mut target,
        commands
            .into_iter()
            .map(|command| ServiceCommand {
                service: 0,
                command,
            })
            .collect(),
    );
    let mut results: Vec<Value> = Vec::new();
    if let Target::Agent(server) = &target {
        let url = server.url();
        let token = server.token().to_owned();
        let (url, token) = (world.norm(&url), world.norm(&token));
        results.push(json!({ "op": "init", "url": url, "token": token }));
    }
    let mut live = true;
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let op = text(&step, "op");
        let mut out = Map::new();
        out.insert("op".into(), Value::from(op.as_str()));
        if !http_step(&mut world, &mut target, &step, live, &mut out) {
            if op == "stop" {
                if let Target::Agent(server) = &mut target {
                    let (_, commands) = server.stop();
                    world.pump(
                        &mut target,
                        commands
                            .into_iter()
                            .map(|command| ServiceCommand {
                                service: 0,
                                command,
                            })
                            .collect(),
                    );
                }
                live = false;
            } else {
                return Err(CallError::plain(format!("unknown step {op}")));
            }
        }
        let logs = world.take_logs();
        if !logs.is_empty() {
            out.insert("logs".into(), Value::Array(logs));
        }
        results.push(Value::Object(out));
    }
    Ok(Some(Value::Array(results)))
}

// ---- agent-mcp-relay.scenario ----

/// the scripted hub of a case
struct FakeHub {
    list: Rc<RefCell<Vec<Value>>>,
    calls: Rc<RefCell<Vec<String>>>,
    log: Log,
}

impl AgentRelayHub for FakeHub {
    fn editor_list(&self) -> Vec<JsonValue> {
        push(&self.log, vec![Value::from("hub.editorList")]);
        self.list.borrow().iter().map(jv).collect()
    }

    fn call(&self, caller: &str, server: &str, tool: &str, input: &JsonValue, call_id: &str) {
        push(
            &self.log,
            vec![
                Value::from("hub.call"),
                Value::from(caller),
                Value::from(server),
                Value::from(tool),
                sv(input),
                Value::from(call_id),
            ],
        );
        self.calls.borrow_mut().push(call_id.to_owned());
    }

    fn cancel(&self, caller: &str, call_id: &str) {
        push(
            &self.log,
            vec![
                Value::from("hub.cancel"),
                Value::from(caller),
                Value::from(call_id),
            ],
        );
    }
}

/// the scripted card of a case
struct FakeAsk {
    asks: Rc<RefCell<Vec<RelayCallId>>>,
    log: Log,
}

impl AgentRelayAsk for FakeAsk {
    fn ask(&self, call: RelayCallId, request: &AgentRelayAskRequest) {
        self.asks.borrow_mut().push(call);
        let n = self.asks.borrow().len();
        push(
            &self.log,
            vec![
                Value::from("ask"),
                Value::from(n),
                json!({
                    "server": request.server,
                    "exposedName": request.exposed_name,
                    "input": sv(&request.input),
                }),
            ],
        );
    }

    fn abort(&self, call: RelayCallId) {
        let n = self
            .asks
            .borrow()
            .iter()
            .position(|c| *c == call)
            .map_or(0, |at| at + 1);
        push(&self.log, vec![Value::from("ask.abort"), Value::from(n)]);
    }
}

fn relay_scenario(args: &[Value]) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut world = new_world(Rc::clone(&log));
    let list = Rc::new(RefCell::new(
        spec.get("list")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    ));
    let calls = Rc::new(RefCell::new(Vec::<String>::new()));
    let asks = Rc::new(RefCell::new(Vec::<RelayCallId>::new()));
    let (relays, step) = AgentMcpRelays::start(AgentMcpRelaysDeps {
        hub: Rc::new(FakeHub {
            list: Rc::clone(&list),
            calls: Rc::clone(&calls),
            log: Rc::clone(&log),
        }),
        ask: Rc::new(FakeAsk {
            asks: Rc::clone(&asks),
            log: Rc::clone(&log),
        }),
        caller: spec
            .get("caller")
            .and_then(Value::as_str)
            .unwrap_or("win1")
            .to_owned(),
        version: spec
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("1.0.0")
            .to_owned(),
        host: Rc::new(FakeHost {
            uuids: Cell::new(0),
            bytes: Cell::new(0),
        }),
    });
    let mut target = Target::Relays(relays);
    world.pump(&mut target, step.commands);
    // a wire, a port and a token for each service made
    if let Target::Relays(relays) = &target {
        for index in 0..relays.len() {
            world.wires.push(Wire::default());
            world.ports.push(BOUND_PORT + index as f64);
            world.tokens.push(relays.token(index).to_owned());
        }
    }
    let mut results: Vec<Value> = Vec::new();
    if let Target::Relays(relays) = &target {
        let shown: Vec<Value> = relays
            .relays()
            .iter()
            .map(|r| {
                json!({
                    "name": r.name,
                    "url": world.norm(&r.url),
                    "token": world.norm(&r.token),
                    "tools": r.tools,
                })
            })
            .collect();
        let mut init = Map::new();
        init.insert("op".into(), Value::from("init"));
        init.insert("relays".into(), Value::Array(shown));
        init.insert(
            "keepResultsInside".into(),
            json!(relays.keep_results_inside()),
        );
        let logs = world.take_logs();
        if !logs.is_empty() {
            init.insert("logs".into(), Value::Array(logs));
        }
        results.push(Value::Object(init));
    }
    let mut live = true;
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let op = text(&step, "op");
        let mut out = Map::new();
        out.insert("op".into(), Value::from(op.as_str()));
        if !http_step(&mut world, &mut target, &step, live, &mut out) {
            match op.as_str() {
                "editorList" => {
                    *list.borrow_mut() = step
                        .get("list")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                }
                "askAnswer" => {
                    let n = step.get("n").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let Some(call) = n
                        .checked_sub(1)
                        .and_then(|at| asks.borrow().get(at).copied())
                    else {
                        out.insert("error".into(), Value::from("no such card"));
                        let logs = world.take_logs();
                        if !logs.is_empty() {
                            out.insert("logs".into(), Value::Array(logs));
                        }
                        results.push(Value::Object(out));
                        continue;
                    };
                    let answer = if on(&step, "reject") {
                        Err(())
                    } else {
                        let given = step.get("answer").cloned().unwrap_or(Value::Null);
                        Ok(if given.get("allow") == Some(&Value::Bool(true)) {
                            AgentRelayAnswer::Allow(
                                if given.get("scope").and_then(Value::as_str) == Some("session") {
                                    AgentRelayScope::Session
                                } else {
                                    AgentRelayScope::Once
                                },
                            )
                        } else {
                            AgentRelayAnswer::Deny
                        })
                    };
                    if let Target::Relays(relays) = &mut target {
                        let step = relays.on_ask_answer(call, answer);
                        world.pump(&mut target, step.commands);
                    }
                }
                "hubAnswer" => {
                    let n = step.get("n").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let Some(call_id) = n
                        .checked_sub(1)
                        .and_then(|at| calls.borrow().get(at).cloned())
                    else {
                        out.insert("error".into(), Value::from("no such hub call"));
                        let logs = world.take_logs();
                        if !logs.is_empty() {
                            out.insert("logs".into(), Value::Array(logs));
                        }
                        results.push(Value::Object(out));
                        continue;
                    };
                    let answer = if on(&step, "reject") {
                        Err(())
                    } else {
                        Ok(step.get("answer").map(jv))
                    };
                    if let Target::Relays(relays) = &mut target {
                        let step = relays.on_hub_answer(&call_id, answer);
                        world.pump(&mut target, step.commands);
                    }
                }
                "stop" => {
                    if let Target::Relays(relays) = &mut target {
                        let step = relays.stop();
                        world.pump(&mut target, step.commands);
                    }
                    live = false;
                }
                other => return Err(CallError::plain(format!("unknown step {other}"))),
            }
        }
        let logs = world.take_logs();
        if !logs.is_empty() {
            out.insert("logs".into(), Value::Array(logs));
        }
        results.push(Value::Object(out));
    }
    Ok(Some(Value::Array(results)))
}

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        "agent-mcp.AGENT_MCP_TOOL_NAMES" => Ok(Some(Value::Array(
            AGENT_MCP_TOOL_NAMES
                .iter()
                .map(|n| Value::from(*n))
                .collect(),
        ))),
        "agent-mcp.skillCall" => skill_call(args, cx),
        "agent-mcp.withholdingSlides" => slides_script(args, cx),
        "agent-mcp.withholdingOpenDocuments" => open_script(args, cx),
        "agent-mcp.build" => build(args, cx),
        "agent-mcp.scenario" => agent_scenario(args),
        "agent-mcp-relay.agentRelayPlans" => match arg(args, 0).and_then(Value::as_array) {
            Some(list) => {
                let list: Vec<JsonValue> = list.iter().map(jv).collect();
                Ok(Some(Value::Array(
                    agent_relay_plans(&list).iter().map(plan_json).collect(),
                )))
            }
            None => Err(CallError::plain("argument 0 is not a list")),
        },
        "agent-mcp-relay.relayResultOf" => {
            let answer = arg(args, 0).map(jv);
            Ok(Some(sv(&relay_result_of(answer.as_ref()))))
        }
        "agent-mcp-relay.RELAY_TEXT" => relay_text(args),
        "agent-mcp-relay.scenario" => relay_scenario(args),
        _ => return None,
    })
}
