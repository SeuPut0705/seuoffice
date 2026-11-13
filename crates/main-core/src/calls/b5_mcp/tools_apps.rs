//! Group `b5-mcp`, slice `tools_apps`: see tools/main-diff/groups/b5-mcp/tools-apps.ts.
//!
//! Each `<file>.call` builds the tools and drives what they ask: a handler
//! answers a [`ToolStep`], and every `Await` of it (a `HostCall` on a control)
//! is answered from the case's scripts, the call logged exactly as the
//! TypeScript fake of that control logs it. The bridges and `app-mcp` run as
//! scenarios: a script of steps over a scripted host, every call the host
//! gets a log line.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::rc::Rc;

use jscompat::{JsonValue, js_regex};
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg, str_arg};
use super::mcp_pure::{Log, ScriptedCli, flush, jv, new_log, push, sv};
use crate::packages::drawio_model::ops::{
    DIAGRAM_OPS, DiagramOpDefinition, OpInputSchema, OpItems, OpPropertySchema, OpPropertyType,
};
use crate::packages::mcp_sdk::server::Command;
use crate::packages::zod::to_json_schema;
use crate::pdf::pdfium::PdfiumError;
use crate::pdf::read_text::{PdfTextDoc, ReadPdfTextOptions};
use crate::shell::mcp::app_mcp::{
    McpResolved, McpRuntime, McpRuntimeDeps, McpRuntimeHost, McpSettled, McpStep, OpId,
};
use crate::shell::mcp::cli_runner::CliRunner;
use crate::shell::mcp::diagram_bridge::{DiagramBridgeSync, create_diagram_control};
use crate::shell::mcp::docs_bridge::{Settled as BridgeSettled, Submitted};
use crate::shell::mcp::mcp_logger::LogClock;
use crate::shell::mcp::mcp_server::{HostCall, McpHost, McpToolDefinition, Settled, ToolStep};
use crate::shell::mcp::open_documents_bridge::{
    Dep, OpenBridgeSync, create_open_documents_control, resolve_target,
};
use crate::shell::mcp::pptx_outline::{
    MAX_OUTLINE_SLIDES, OutlineBullet, OutlineParagraph, OutlineSlide, PptxSourceFormat,
    outline_to_ops, parse_pptx_outline,
};
use crate::shell::mcp::sheets_bridge::{SheetsBridge, SheetsBridgeHost};
use crate::shell::mcp::slides_bridge::{SlidesBridge, SlidesBridgeHost, element_withholds};
use crate::shell::mcp::tools::diagram_tools::{
    DIAGRAM_MCP_TOOL_APPLY, DIAGRAM_MCP_TOOL_READ, DetachedCheck, DiagramToolsDeps,
    create_diagram_tools, diagram_op_item_schema, front_diagram,
};
use crate::shell::mcp::tools::formats::{EditorFamily, FORMAT_FAMILIES, SessionFamily};
use crate::shell::mcp::tools::hwp_tools::HwpTextReader;
use crate::shell::mcp::tools::open_documents_tools::Unsaved;
use crate::shell::mcp::tools::pdf_tools::PdfTextReader;
use crate::shell::mcp::tools::session_tools::{FamilyDriver, create_session_host, js_object};
use crate::shell::mcp::tools::sheets_tools::{
    SheetsCommandName, SheetsToolDeps, create_sheets_tools, sheets_driver,
};
use crate::shell::mcp::tools::slides_tools::{
    ReadDeckOptions, SlidesToolDeps, create_slides_tools, slides_driver,
};
use crate::shell::tab_manager::{OpenDocumentTab, TabKind};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- pptx-outline ----
        "pptx-outline.MAX_OUTLINE_SLIDES" => Ok(Some(Value::from(MAX_OUTLINE_SLIDES as f64))),
        "pptx-outline.parsePptxOutline" => (|| {
            let format = match str_arg(args, 0)? {
                "json" => PptxSourceFormat::Json,
                _ => PptxSourceFormat::Markdown,
            };
            parse_pptx_outline(format, str_arg(args, 1)?)
                .map(|slides| Some(Value::Array(slides.iter().map(slide_json).collect())))
                .map_err(CallError::plain)
        })(),
        "pptx-outline.outlineToOps" => {
            let slides: Vec<OutlineSlide> = arg(args, 0)
                .and_then(Value::as_array)
                .map(|list| list.iter().map(outline_slide_of).collect())
                .unwrap_or_default();
            outline_to_ops(&slides)
                .map(|ops| Some(Value::Array(ops.iter().map(sv).collect())))
                .map_err(CallError::plain)
        }

        // ---- slides-tools, sheets-tools ----
        "slides-tools.slidesDriver" => driver_call(Control::Slides, args, cx),
        "sheets-tools.sheetsDriver" => driver_call(Control::Sheets, args, cx),
        "slides-tools.tools" => tools_list(Control::Slides, args),
        "slides-tools.call" => tool_call(Control::Slides, args, cx),
        "sheets-tools.tools" => tools_list(Control::Sheets, args),
        "sheets-tools.call" => tool_call(Control::Sheets, args, cx),

        // ---- diagram-tools ----
        "diagram-tools.DIAGRAM_MCP_TOOL_NAMES" => Ok(Some(json!({
            "read": DIAGRAM_MCP_TOOL_READ,
            "apply": DIAGRAM_MCP_TOOL_APPLY,
        }))),
        "diagram-tools.diagramOpItemSchema" => schema_call(args),
        "diagram-tools.frontDiagram" => {
            let documents = tabs_of(arg(args, 0));
            let detached: Option<Vec<String>> =
                arg(args, 1).and_then(Value::as_array).map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                });
            let is_detached = |id: &str| {
                detached
                    .as_ref()
                    .is_some_and(|list| list.iter().any(|d| d == id))
            };
            let front = match &detached {
                Some(_) => front_diagram(&documents, Some(&is_detached)),
                None => front_diagram(&documents, None),
            };
            Ok(Some(front.map_or(Value::Null, OpenDocumentTab::to_value)))
        }
        "diagram-tools.tools" => create_diagram_tools(DiagramToolsDeps {
            control: true,
            is_detached: None,
        })
        .map(|tools| Some(listed(&tools)))
        .map_err(CallError::plain),
        "diagram-tools.call" => diagram_call(args, cx),

        // ---- the bridges ----
        "sheets-bridge.scenario" => sheets_bridge_call(args, cx),
        "diagram-bridge.scenario" => diagram_bridge_call(args, cx),
        "open-documents-bridge.scenario" => open_bridge_call(args, cx),
        "slides-bridge.elementWithholds" => Ok(Some(Value::Bool(element_withholds(&jv(arg(
            args, 0,
        )
        .unwrap_or(&Value::Null)))))),
        "slides-bridge.scenario" => slides_bridge_call(args, cx),
        "app-mcp.scenario" => app_call(args, cx),
        _ => return None,
    })
}

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

/// a scripted answer as a settled call
fn settled_of(val: Option<&Value>) -> Settled {
    scripted(val).map(|value| value.map(|value| jv(&value)))
}

/// `{ ok: value }` / `{}` / `{ error }`, as a step answers
fn step_answer(result: Result<Option<Value>, String>) -> Value {
    match result {
        Ok(Some(value)) => json!({ "ok": value }),
        Ok(None) => json!({}),
        Err(message) => json!({ "error": message }),
    }
}

/// a settled call as a step answers it
fn settled_answer(settled: Settled) -> Value {
    step_answer(settled.map(|value| value.map(|value| sv(&value))))
}

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

/// the steps of a tool run to their end, every awaited call answered by `answer`
fn run_steps(mut step: ToolStep<'_>, answer: &mut dyn FnMut(&HostCall) -> Settled) -> Settled {
    loop {
        match step {
            ToolStep::Done(settled) => return settled,
            ToolStep::Await { call, then } => step = then(answer(&call)),
        }
    }
}

/// `tools.find(name).handler(args ?? {})`, its awaited calls answered by `answer`
fn call_tool(
    tools: Vec<McpToolDefinition<'_>>,
    name: &str,
    args: Option<&Value>,
    answer: &mut dyn FnMut(&HostCall) -> Settled,
) -> Answer {
    let Some(mut tool) = tools.into_iter().find(|tool| tool.name == name) else {
        return Err(CallError::plain(format!("no such tool: {name}")));
    };
    let args = match args {
        Some(args) if !args.is_null() => jv(args),
        _ => jv(&json!({})),
    };
    run_steps((tool.handler)(args), answer)
        .map(|value| value.map(|value| sv(&value)))
        .map_err(CallError::plain)
}

fn tab_of(value: &Value) -> OpenDocumentTab {
    OpenDocumentTab {
        id: text(value, "id"),
        kind: TabKind::parse(&text(value, "kind")).unwrap_or(TabKind::Home),
        title: text(value, "title"),
        file_path: value
            .get("filePath")
            .and_then(Value::as_str)
            .map(str::to_owned),
        active: on(value, "active"),
        dirty: on(value, "dirty"),
    }
}

fn tabs_of(value: Option<&Value>) -> Vec<OpenDocumentTab> {
    value
        .and_then(Value::as_array)
        .map(|list| list.iter().map(tab_of).collect())
        .unwrap_or_default()
}

/// `tab(id)` of the spec: a diagram tab with its defaults
fn default_tab(id: &str) -> OpenDocumentTab {
    OpenDocumentTab {
        id: id.to_owned(),
        kind: TabKind::Diagram,
        title: format!("Title {id}"),
        file_path: Some(format!("/work/{id}.drawio")),
        active: false,
        dirty: false,
    }
}

/// a promise of `app-mcp` begins: its label is pending until a step settles it
fn begin(
    runtime: &mut McpRuntime<'static>,
    label: &str,
    started: (OpId, McpStep),
    log: &Log,
    labels: &mut HashMap<u32, String>,
    outcomes: &mut Map<String, Value>,
) {
    labels.insert(started.0.0, label.to_owned());
    outcomes.insert(label.to_owned(), Value::from("pending"));
    drive(runtime, started.1, log, labels, outcomes);
}

// ---- pptx-outline ----

fn slide_json(slide: &OutlineSlide) -> Value {
    let mut out = Map::new();
    if let Some(title) = &slide.title {
        out.insert("title".into(), Value::from(title.as_str()));
    }
    out.insert(
        "paragraphs".into(),
        Value::Array(slide.paragraphs.iter().map(paragraph_json).collect()),
    );
    Value::Object(out)
}

fn paragraph_json(p: &OutlineParagraph) -> Value {
    let mut out = Map::new();
    out.insert("text".into(), Value::from(p.text.as_str()));
    match p.bullet {
        Some(OutlineBullet::Char) => out.insert("bullet".into(), Value::from("char")),
        Some(OutlineBullet::Number) => out.insert("bullet".into(), Value::from("number")),
        None => None,
    };
    if let Some(level) = p.level {
        out.insert("level".into(), Value::from(level));
    }
    if let Some(bold) = p.bold {
        out.insert("bold".into(), Value::Bool(bold));
    }
    Value::Object(out)
}

/// an `OutlineSlide` of a case: any `bullet` string but `''` and `'number'` is a character bullet
fn outline_slide_of(value: &Value) -> OutlineSlide {
    OutlineSlide {
        title: value
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_owned),
        paragraphs: value
            .get("paragraphs")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|p| OutlineParagraph {
                        text: text(p, "text"),
                        bullet: match p.get("bullet").and_then(Value::as_str) {
                            None | Some("") => None,
                            Some("number") => Some(OutlineBullet::Number),
                            Some(_) => Some(OutlineBullet::Char),
                        },
                        level: p.get("level").and_then(Value::as_f64),
                        bold: p.get("bold").and_then(Value::as_bool),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

// ---- the controls of a tool case ----

/// what the tool cases' controls answer: slides `{ open, txn, read, save }`,
/// sheets `{ open, run }`, the resolver `{ answer }` / `{ throws }`, the
/// diagram control `{ list, detached, read, apply }`. Each call is a log line.
fn answer_call(deps: &Value, log: &Log, call: &HostCall) -> Settled {
    let arg_of = |at: usize| call.args.get(at).cloned().unwrap_or(JsonValue::Null);
    match (call.control, call.method) {
        ("SlidesControl", "openBlankTab") | ("SheetsControl", "openBlankTab") => {
            let key = if call.control == "SlidesControl" {
                "slides"
            } else {
                "sheets"
            };
            push(log, vec![Value::from(format!("{key}.open"))]);
            match deps.get(key).and_then(|c| c.get("open")) {
                Some(open) if open.is_object() => Err(text(open, "throws")),
                Some(open) => Ok(Some(JsonValue::Number(open.as_f64().unwrap_or(1.0)))),
                None => Ok(Some(JsonValue::Number(1.0))),
            }
        }
        ("SlidesControl", "saveDeck") => {
            push(
                log,
                vec![
                    Value::from("slides.save"),
                    sv(&arg_of(0)),
                    sv(&arg_of(1)),
                    sv(&arg_of(2)),
                ],
            );
            let save = deps.get("slides").and_then(|s| s.get("save"));
            if let Some(message) = save.and_then(|s| s.get("throws")).and_then(Value::as_str) {
                return Err(message.to_owned());
            }
            let path = match save.and_then(|s| s.get("path")).and_then(Value::as_str) {
                Some(path) => JsonValue::String(path.to_owned()),
                None => arg_of(1),
            };
            Ok(Some(js_object(vec![("path", path)])))
        }
        ("SlidesControl", "runTxn") => {
            push(
                log,
                vec![Value::from("slides.txn"), sv(&arg_of(0)), sv(&arg_of(1))],
            );
            settled_of(deps.get("slides").and_then(|s| s.get("txn")))
        }
        ("SlidesControl", "readDeck") => {
            let options = call.args.get(1).map_or(Value::Null, sv);
            push(
                log,
                vec![Value::from("slides.read"), sv(&arg_of(0)), options],
            );
            settled_of(deps.get("slides").and_then(|s| s.get("read")))
        }
        ("SheetsControl", "runCommand") => {
            push(
                log,
                vec![
                    Value::from("sheets.run"),
                    sv(&arg_of(0)),
                    sv(&arg_of(1)),
                    sv(&arg_of(2)),
                ],
            );
            settled_of(deps.get("sheets").and_then(|s| s.get("run")))
        }
        ("TargetResolver", "resolve") => {
            push(
                log,
                vec![
                    Value::from("resolveTarget"),
                    sv(&arg_of(0)),
                    sv(&arg_of(1)),
                    sv(&arg_of(2)),
                ],
            );
            let resolve = deps.get("resolve").cloned().unwrap_or(Value::Null);
            if let Some(message) = resolve.get("throws").and_then(Value::as_str) {
                return Err(message.to_owned());
            }
            Ok(Some(JsonValue::Number(
                resolve.get("answer").and_then(Value::as_f64).unwrap_or(0.0),
            )))
        }
        ("DiagramControl", "list") => {
            push(log, vec![Value::from("diagram.list")]);
            let control = deps.get("control").cloned().unwrap_or(Value::Null);
            match control.get("list") {
                Some(list) if list.is_array() => Ok(Some(jv(list))),
                Some(list) if list.get("throws").is_some() => Err(text(list, "throws")),
                _ => Ok(Some(JsonValue::Array(Vec::new()))),
            }
        }
        ("DiagramControl", "read") => {
            let id = arg_of(0).get("id").map_or(Value::Null, |id| sv(&id));
            let page = call.args.get(1).map_or(Value::Null, sv);
            push(log, vec![Value::from("diagram.read"), id, page]);
            settled_of(deps.get("control").and_then(|c| c.get("read")))
        }
        ("DiagramControl", "apply") => {
            let id = arg_of(0).get("id").map_or(Value::Null, |id| sv(&id));
            push(log, vec![Value::from("diagram.apply"), id, sv(&arg_of(1))]);
            settled_of(deps.get("control").and_then(|c| c.get("apply")))
        }
        _ => Err(format!("no fake for {}.{}", call.control, call.method)),
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Control {
    Slides,
    Sheets,
}

impl Control {
    fn key(self) -> &'static str {
        match self {
            Control::Slides => "slides",
            Control::Sheets => "sheets",
        }
    }
}

/// the tools of a factory over the deps of a case
fn build_tools_of<'h>(
    control: Control,
    d: &Value,
    cli: Option<Rc<ScriptedCli>>,
    host: crate::shell::mcp::tools::session_tools::SharedSessionHost,
) -> Vec<McpToolDefinition<'h>> {
    let save_dir = d
        .get("saveDir")
        .and_then(Value::as_str)
        .unwrap_or("/save")
        .to_owned();
    let background = d.get("background").and_then(Value::as_bool);
    let resolve_target = d.get("resolve").is_some();
    let cli = cli.map(|cli| cli as Rc<dyn CliRunner>);
    match control {
        Control::Slides => create_slides_tools(
            Rc::new(SlidesToolDeps {
                default_save_dir: Rc::new(move || save_dir.clone()),
                background,
                slides: d.get("slides").is_some(),
                cli,
                resolve_target,
            }),
            host,
        ),
        Control::Sheets => create_sheets_tools(
            Rc::new(SheetsToolDeps {
                default_save_dir: Rc::new(move || save_dir.clone()),
                background,
                sheets: d.get("sheets").is_some(),
                cli,
                resolve_target,
            }),
            host,
        ),
    }
}

/// `driver.openBlankTab()` / `driver.save(..)` of a family: the call the
/// driver names, answered like the TypeScript fake of that control
fn driver_call(control: Control, args: &[Value], cx: &mut Context) -> Answer {
    let world = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let deps = json!({ control.key(): world });
    let driver: Rc<dyn FamilyDriver> = match control {
        Control::Slides => slides_driver(),
        Control::Sheets => sheets_driver(),
    };
    let answer = (|| {
        let mut out = Map::new();
        out.insert("family".into(), Value::from(driver.family().as_str()));
        if str_arg(args, 1).is_ok_and(|op| op == "open") {
            let wc =
                answer_call(&deps, &log, &driver.open_blank_tab()).map_err(CallError::plain)?;
            if let Some(wc) = wc {
                out.insert("wcId".into(), sv(&wc));
            }
        } else {
            let wc = arg(args, 2).and_then(Value::as_i64).unwrap_or(0);
            let overwrite = arg(args, 3 + 1).and_then(Value::as_bool).unwrap_or(false);
            let saved = answer_call(&deps, &log, &driver.save(wc, str_arg(args, 3)?, overwrite))
                .map_err(CallError::plain)?;
            if let Some(saved) = saved {
                out.insert("saved".into(), sv(&saved));
            }
        }
        Ok(Some(Value::Object(out)))
    })();
    flush(&log, cx);
    answer
}
fn tools_list(control: Control, args: &[Value]) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut deps = json!({});
    if let Some(background) = spec.get("background") {
        deps["background"] = background.clone();
    }
    if spec.get("control").is_some_and(|c| !c.is_null()) {
        deps[control.key()] = json!({});
    }
    let cli = Rc::new(ScriptedCli::new(
        Some(&json!({ "ok": true, "code": 0 })),
        Rc::clone(&log),
    ));
    let tools = build_tools_of(control, &deps, Some(cli), create_session_host());
    Ok(Some(listed(&tools)))
}

fn tool_call(control: Control, args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let host = create_session_host();
    if let Some(session) = spec.get("session").filter(|s| s.is_object())
        && let Some(family) = SessionFamily::parse(&text(session, "family"))
    {
        host.borrow_mut().begin(
            family,
            session.get("wcId").and_then(Value::as_i64).unwrap_or(0),
        );
    }
    let deps = spec.get("deps").cloned().unwrap_or(Value::Null);
    let cli = deps
        .get("cli")
        .map(|outcomes| Rc::new(ScriptedCli::new(Some(outcomes), Rc::clone(&log))));
    let tools = build_tools_of(control, &deps, cli.clone(), host);
    let answer = call_tool(tools, &text(&spec, "tool"), spec.get("args"), &mut |call| {
        answer_call(&deps, &log, call)
    });
    if let Some(dir) = cli.and_then(|cli| cli.scratch.borrow().clone()) {
        push(
            &log,
            vec![
                Value::from("scratch folder removed"),
                Value::Bool(fs::metadata(dir).is_err()),
            ],
        );
    }
    flush(&log, cx);
    answer
}

// ---- diagram-tools ----

fn diagram_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let control = spec.get("control").filter(|control| control.is_object());
    let is_detached: Option<DetachedCheck> = control
        .and_then(|control| control.get("detached"))
        .and_then(Value::as_array)
        .map(|list| {
            let (ids, log) = (list.clone(), Rc::clone(&log));
            Rc::new(move |id: &str| {
                push(
                    &log,
                    vec![Value::from("diagram.isDetached"), Value::from(id)],
                );
                ids.iter().any(|d| d.as_str() == Some(id))
            }) as DetachedCheck
        });
    let answer = match create_diagram_tools(DiagramToolsDeps {
        control: control.is_some(),
        is_detached,
    }) {
        Ok(tools) => call_tool(tools, &text(&spec, "tool"), spec.get("args"), &mut |call| {
            answer_call(&spec, &log, call)
        }),
        Err(message) => Err(CallError::plain(message)),
    };
    flush(&log, cx);
    answer
}

/// the ops of a `diagramOpItemSchema` case, as definitions (the strings leak:
/// a definition names its ops and enum values as `'static`; the comparison
/// process is short-lived)
fn op_definitions_of(list: &[Value]) -> Vec<DiagramOpDefinition> {
    fn leak(text: &str) -> &'static str {
        Box::leak(text.to_owned().into_boxed_str())
    }
    list.iter()
        .map(|d| {
            let name = leak(&text(d, "name"));
            let mut properties = Vec::new();
            if let Some(props) = d.get("props").and_then(Value::as_object) {
                for (key, prop) in props {
                    let kind = match text(prop, "type").as_str() {
                        "number" => OpPropertyType::Number,
                        "array" => OpPropertyType::Array,
                        _ => OpPropertyType::String,
                    };
                    properties.push((
                        leak(key),
                        OpPropertySchema {
                            kind,
                            enum_values: prop.get("enum").and_then(Value::as_array).map(|list| {
                                list.iter().filter_map(Value::as_str).map(leak).collect()
                            }),
                            items: (kind == OpPropertyType::Array)
                                .then_some(OpItems { kind: "string" }),
                            exclusive_minimum: None,
                            min_length: None,
                            min_items: None,
                            default: None,
                            description: text(prop, "description"),
                        },
                    ));
                }
            }
            let required = d
                .get("required")
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).map(leak).collect())
                .unwrap_or_default();
            DiagramOpDefinition {
                name,
                description: d
                    .get("description")
                    .and_then(Value::as_str)
                    .map_or_else(|| format!("does {name}"), str::to_owned),
                changes: true,
                needs_app: None,
                input: OpInputSchema {
                    properties,
                    required,
                },
            }
        })
        .collect()
}

fn schema_call(args: &[Value]) -> Answer {
    let ops: Vec<DiagramOpDefinition> = match arg(args, 0).and_then(Value::as_array) {
        Some(list) => op_definitions_of(list),
        None => DIAGRAM_OPS
            .iter()
            .filter(|op| op.changes)
            .cloned()
            .collect(),
    };
    let item = diagram_op_item_schema(&ops).map_err(CallError::plain)?;
    let tool = McpToolDefinition {
        name: "item".to_owned(),
        description: "one op".to_owned(),
        input_schema: Some(vec![("item".to_owned(), item)]),
        handler: Box::new(|_| ToolStep::Done(Ok(None))),
    };
    Ok(Some(listed(&[tool])))
}

// ---- the bridges' shared scripts ----

/// the `Wc` of a bridge scenario
struct Wc {
    destroyed: bool,
    /// a `once('destroyed')` listener is attached
    listening: bool,
}

/// `{ ok: value }` or `{ error: message }` as the case records a promise
fn recorded(outcome: &BridgeSettled) -> Value {
    step_answer(outcome.clone().map(|value| value.map(|v| sv(&v))))
}

fn wcs_of(spec: &Value) -> HashMap<i64, Wc> {
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
    wcs
}

/// what `deps.openBlankTab` answers, in turn: an id or `{ throws }`
fn blank_of(spec: &Value) -> VecDeque<Value> {
    spec.get("blank")
        .and_then(Value::as_array)
        .map(|list| list.iter().cloned().collect())
        .unwrap_or_default()
}

fn next_blank(blank: &mut VecDeque<Value>, log: &Log) -> Result<i64, String> {
    let next = blank.pop_front().unwrap_or(Value::Null);
    if next.is_object() {
        push(
            log,
            vec![Value::from("deps.openBlankTab"), Value::from("rejects")],
        );
        return Err(text(&next, "throws"));
    }
    let id = next.as_i64().unwrap_or(0);
    push(log, vec![Value::from("deps.openBlankTab"), Value::from(id)]);
    Ok(id)
}

// ---- sheets-bridge ----

struct SheetsHost {
    log: Log,
    wcs: HashMap<i64, Wc>,
    blank: VecDeque<Value>,
    abandon: bool,
    armed: HashSet<u64>,
    next_timer: u64,
    settled: Vec<(u64, BridgeSettled)>,
}

impl SheetsBridgeHost for SheetsHost {
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
        command: SheetsCommandName,
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
                Value::from("sheets:mcp-command"),
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

    fn settle(&mut self, op: u64, outcome: BridgeSettled) {
        self.settled.push((op, outcome));
    }

    fn exists_sync(&mut self, path: &str) -> bool {
        fs::metadata(path).is_ok()
    }

    fn open_blank_tab(&mut self) -> Result<i64, String> {
        next_blank(&mut self.blank, &self.log)
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

fn sheets_command_of(name: &str) -> SheetsCommandName {
    match name {
        "apply_ops" => SheetsCommandName::ApplyOps,
        "read_sheet" => SheetsCommandName::ReadSheet,
        _ => SheetsCommandName::SaveSheet,
    }
}

fn sheets_bridge_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let host = SheetsHost {
        log: Rc::clone(&log),
        wcs: wcs_of(&spec),
        blank: blank_of(&spec),
        abandon: on(&spec, "abandon"),
        armed: HashSet::new(),
        next_timer: 1,
        settled: Vec::new(),
    };
    let mut bridge = SheetsBridge::new(host);
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
                for channel in ["sheets:mcp-ready", "sheets:mcp-result"] {
                    push(&log, vec![Value::from("ipcMain.on"), Value::from(channel)]);
                }
            }
        } else if let Some(label) = step.get("open").and_then(Value::as_str) {
            started = Some((label.to_owned(), bridge.open_blank_tab()));
        } else if let Some(label) = step.get("run").and_then(Value::as_str) {
            let command =
                sheets_command_of(step.get("command").and_then(Value::as_str).unwrap_or(""));
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
                    vec![Value::from("no listener"), Value::from("sheets:mcp-ready")],
                );
            }
        } else if step.get("result").is_some() {
            if registered {
                let payload = step.get("payload").map(jv);
                bridge.on_result(id_of("result"), payload.as_ref());
            } else {
                push(
                    &log,
                    vec![Value::from("no listener"), Value::from("sheets:mcp-result")],
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

// ---- diagram-bridge and open-documents-bridge ----

/// the tabs of a scenario: the sync deps both bridges share, and the awaited
/// deps `list`, `webContentsFor` they ask for
struct TabsData {
    spec: Value,
    log: Log,
}

impl TabsData {
    fn list(&self) -> Settled {
        push(&self.log, vec![Value::from("deps.list")]);
        Ok(Some(
            self.spec
                .get("tabs")
                .map_or(JsonValue::Array(Vec::new()), jv),
        ))
    }

    fn contents(&self, tab_id: &str) -> Settled {
        push(
            &self.log,
            vec![Value::from("deps.webContentsFor"), Value::from(tab_id)],
        );
        let entry = self.spec.get("contents").and_then(|c| c.get(tab_id));
        if let Some(message) = entry.and_then(|e| e.get("throws")).and_then(Value::as_str) {
            return Err(message.to_owned());
        }
        Ok(entry
            .and_then(|e| e.get("id"))
            .and_then(Value::as_f64)
            .map(JsonValue::Number))
    }

    fn destroyed(&self, wc_id: i64) -> bool {
        self.spec
            .get("contents")
            .and_then(Value::as_object)
            .is_some_and(|contents| {
                contents.values().any(|entry| {
                    entry.get("id").and_then(Value::as_i64) == Some(wc_id)
                        && entry.get("destroyed").and_then(Value::as_bool) == Some(true)
                })
            })
    }

    fn switch(&self, key: &str, log_name: &str, failure: &str, tab_id: &str) -> Result<(), String> {
        let Some(mode) = self.spec.get(key).and_then(Value::as_str) else {
            return Ok(());
        };
        push(&self.log, vec![Value::from(log_name), Value::from(tab_id)]);
        if mode == "throws" {
            return Err(failure.to_owned());
        }
        Ok(())
    }

    fn warn(&self, message: &str, error: &str) {
        push(
            &self.log,
            vec![
                Value::from("console.warn"),
                Value::from(message),
                Value::from(error),
            ],
        );
    }

    /// the calls both bridges make of `deps`
    fn answer(&self, call: &HostCall) -> Option<Settled> {
        let id_of = |at: usize| match call.args.get(at) {
            Some(JsonValue::String(id)) => id.clone(),
            _ => String::new(),
        };
        match call.method {
            "list" => Some(self.list()),
            "webContentsFor" => Some(self.contents(&id_of(0))),
            _ => None,
        }
    }
}

struct DiagramSync(TabsData);

impl DiagramBridgeSync for DiagramSync {
    fn is_destroyed(&self, wc_id: i64) -> bool {
        self.0.destroyed(wc_id)
    }

    fn is_detached(&self, tab_id: &str) -> Option<bool> {
        let detached = self.0.spec.get("detached").and_then(Value::as_array)?;
        push(
            &self.0.log,
            vec![Value::from("deps.isDetached"), Value::from(tab_id)],
        );
        Some(detached.iter().any(|id| id.as_str() == Some(tab_id)))
    }

    fn activate(&self, tab_id: &str) -> Result<(), String> {
        self.0
            .switch("activate", "deps.activate", "no switch", tab_id)
    }

    fn reveal_window(&self, tab_id: &str) -> Result<(), String> {
        self.0
            .switch("reveal", "deps.revealWindow", "no window", tab_id)
    }

    fn warn(&self, message: &str, error: &str) {
        self.0.warn(message, error);
    }
}

fn diagram_bridge_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let data = TabsData {
        spec: spec.clone(),
        log: Rc::clone(&log),
    };
    let control = create_diagram_control(Rc::new(DiagramSync(TabsData {
        spec: spec.clone(),
        log: Rc::clone(&log),
    })));
    let tabs = tabs_of(spec.get("tabs"));
    let tab_for = |step: &Value, key: &str| -> OpenDocumentTab {
        match step.get("tab") {
            Some(tab) if tab.is_object() => tab_of(tab),
            _ => {
                let id = text(step, key);
                tabs.iter()
                    .find(|t| t.id == id)
                    .cloned()
                    .unwrap_or_else(|| default_tab(&id))
            }
        }
    };
    let mut answer = |call: &HostCall| -> Settled {
        if let Some(settled) = data.answer(call) {
            return settled;
        }
        match call.method {
            "readPage" => {
                let page = call.args.get(1).map_or(Value::Null, sv);
                push(
                    &log,
                    vec![
                        Value::from("deps.readPage"),
                        call.args.first().map_or(Value::Null, sv),
                        page,
                    ],
                );
                settled_of(spec.get("read"))
            }
            _ => {
                push(
                    &log,
                    vec![
                        Value::from("deps.applyOps"),
                        call.args.first().map_or(Value::Null, sv),
                        call.args.get(1).map_or(Value::Null, sv),
                    ],
                );
                settled_of(spec.get("apply"))
            }
        }
    };
    let mut answers = Vec::new();
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if on(&step, "list") {
            answers.push(settled_answer(run_steps(control.list(), &mut answer)));
        } else if let Some(id) = step.get("isDetached").and_then(Value::as_str) {
            answers.push(json!({
                "ok": control.is_detached(id).map_or(Value::Null, Value::Bool)
            }));
        } else if step.get("read").is_some() {
            let page = step.get("page").and_then(Value::as_str);
            answers.push(settled_answer(run_steps(
                control.read(&tab_for(&step, "read"), page),
                &mut answer,
            )));
        } else if step.get("apply").is_some() {
            let ops: Vec<JsonValue> = step
                .get("ops")
                .and_then(Value::as_array)
                .map(|list| list.iter().map(jv).collect())
                .unwrap_or_default();
            answers.push(settled_answer(run_steps(
                control.apply(&tab_for(&step, "apply"), ops),
                &mut answer,
            )));
        }
    }
    flush(&log, cx);
    Ok(Some(Value::Array(answers)))
}

struct OpenSync(TabsData);

impl OpenBridgeSync for OpenSync {
    fn wired(&self, dep: Dep) -> bool {
        let key = match dep {
            Dep::Docs => "docs",
            Dep::Sheets => "sheets",
            Dep::Slides => "slides",
            Dep::SlidesDiscard => "slidesDiscard",
            Dep::RecoveryDiscard => "recoveryDiscard",
            Dep::Markdown => "markdown",
            Dep::Html => "html",
            Dep::Mindmap => "mindmap",
            Dep::Hwp => "hwp",
            Dep::Epub => "epub",
            Dep::Diagram => "diagram",
        };
        self.0.spec.get(key).is_some()
    }

    fn is_destroyed(&self, wc_id: i64) -> bool {
        self.0.destroyed(wc_id)
    }

    fn close_tab(&self, tab_id: &str) -> bool {
        push(
            &self.0.log,
            vec![Value::from("deps.closeTab"), Value::from(tab_id)],
        );
        !self
            .0
            .spec
            .get("closeFails")
            .and_then(Value::as_array)
            .is_some_and(|list| list.iter().any(|id| id.as_str() == Some(tab_id)))
    }

    fn is_unloaded(&self, tab_id: &str) -> Option<bool> {
        let unloaded = self.0.spec.get("unloaded").and_then(Value::as_array)?;
        push(
            &self.0.log,
            vec![Value::from("deps.isUnloaded"), Value::from(tab_id)],
        );
        Some(unloaded.iter().any(|id| id.as_str() == Some(tab_id)))
    }

    fn default_save_dir(&self) -> String {
        push(&self.0.log, vec![Value::from("deps.defaultSaveDir")]);
        text(&self.0.spec, "saveDir")
    }

    fn activate(&self, tab_id: &str) -> Result<(), String> {
        self.0
            .switch("activate", "deps.activate", "no switch", tab_id)
    }

    fn reveal_window(&self, tab_id: &str) -> Result<(), String> {
        self.0
            .switch("reveal", "deps.revealWindow", "no window", tab_id)
    }

    fn warn(&self, message: &str, error: &str) {
        self.0.warn(message, error);
    }
}

/// the log name of a family's editor control
fn editor_name(control: &str) -> &'static str {
    match control {
        "MarkdownBridge" => "markdown",
        "HtmlBridge" => "html",
        "MindmapBridge" => "mindmap",
        "HwpBridge" => "hwp",
        "EpubBridge" => "epub",
        _ => "diagram",
    }
}

fn open_bridge_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let data = TabsData {
        spec: spec.clone(),
        log: Rc::clone(&log),
    };
    let sync = Rc::new(OpenSync(TabsData {
        spec: spec.clone(),
        log: Rc::clone(&log),
    }));
    let control = create_open_documents_control(Rc::clone(&sync) as Rc<dyn OpenBridgeSync>);
    let tabs = tabs_of(spec.get("tabs"));
    let tab_for = |step: &Value, key: &str| -> OpenDocumentTab {
        match step.get("as") {
            Some(tab) if tab.is_object() => tab_of(tab),
            _ => {
                let id = text(step, key);
                tabs.iter()
                    .find(|t| t.id == id)
                    .cloned()
                    .unwrap_or_else(|| default_tab(&id))
            }
        }
    };
    let mut answer = |call: &HostCall| -> Settled {
        let arg_of = |at: usize| call.args.get(at).cloned().unwrap_or(JsonValue::Null);
        match (call.control, call.method) {
            ("OpenDocumentsBridgeDeps", "list" | "webContentsFor") => {
                data.answer(call).unwrap_or(Ok(None))
            }
            ("OpenDocumentsBridgeDeps", "slidesDiscard") => {
                push(
                    &log,
                    vec![Value::from("deps.slidesDiscard"), sv(&arg_of(0))],
                );
                if spec.get("slidesDiscard").and_then(Value::as_str) == Some("throws") {
                    Err("slides locked".to_owned())
                } else {
                    Ok(None)
                }
            }
            ("OpenDocumentsBridgeDeps", "recoveryDiscard") => {
                push(
                    &log,
                    vec![
                        Value::from("deps.recoveryDiscard"),
                        arg_of(0).get("id").map_or(Value::Null, |id| sv(&id)),
                        sv(&arg_of(1)),
                    ],
                );
                if spec.get("recoveryDiscard").and_then(Value::as_str) == Some("throws") {
                    Err("recovery locked".to_owned())
                } else {
                    Ok(None)
                }
            }
            ("DocsControl", _) => {
                push(
                    &log,
                    vec![
                        Value::from("docs.run"),
                        sv(&arg_of(0)),
                        sv(&arg_of(1)),
                        sv(&arg_of(2)),
                    ],
                );
                settled_of(spec.get("docs").and_then(|d| d.get("run")))
            }
            ("SheetsControl", _) => {
                push(
                    &log,
                    vec![
                        Value::from("sheets.run"),
                        sv(&arg_of(0)),
                        sv(&arg_of(1)),
                        sv(&arg_of(2)),
                    ],
                );
                settled_of(spec.get("sheets").and_then(|d| d.get("run")))
            }
            ("SlidesControl", "readDeck") => {
                push(
                    &log,
                    vec![Value::from("slides.read"), sv(&arg_of(0)), Value::Null],
                );
                settled_of(spec.get("slides").and_then(|d| d.get("read")))
            }
            ("SlidesControl", _) => {
                push(
                    &log,
                    vec![
                        Value::from("slides.save"),
                        sv(&arg_of(0)),
                        sv(&arg_of(1)),
                        sv(&arg_of(2)),
                    ],
                );
                match spec
                    .get("slides")
                    .and_then(|d| d.get("save"))
                    .and_then(|s| s.get("throws"))
                    .and_then(Value::as_str)
                {
                    Some(message) => Err(message.to_owned()),
                    None => Ok(Some(JsonValue::Null)),
                }
            }
            (editor, method) => {
                let name = editor_name(editor);
                let mut line = vec![Value::from(format!("{name}.{method}")), sv(&arg_of(0))];
                if method == "save" {
                    line.push(sv(&arg_of(1)));
                }
                push(&log, line);
                settled_of(spec.get(name).and_then(|e| e.get(method)))
            }
        }
    };
    let mut answers = Vec::new();
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if let Some(r) = step.get("resolve") {
            let wanted = text(r, "family");
            let family: Option<EditorFamily> = FORMAT_FAMILIES
                .iter()
                .map(|f| f.family)
                .find(|f| f.as_str() == wanted);
            let focus = r
                .get("options")
                .and_then(|o| o.get("focus"))
                .and_then(Value::as_bool)
                == Some(true);
            answers.push(match family {
                Some(family) => settled_answer(run_steps(
                    resolve_target(
                        Rc::clone(&sync) as Rc<dyn OpenBridgeSync>,
                        text(r, "target"),
                        family,
                        focus,
                    ),
                    &mut answer,
                )),
                None => json!({ "error": format!("unknown format family \"{wanted}\"") }),
            });
        } else if on(&step, "list") {
            answers.push(settled_answer(run_steps(control.list(), &mut answer)));
        } else if step.get("read").is_some() {
            answers.push(settled_answer(run_steps(
                control.read(&tab_for(&step, "read")),
                &mut answer,
            )));
        } else if step.get("save").is_some() {
            answers.push(settled_answer(run_steps(
                control.save(&tab_for(&step, "save")),
                &mut answer,
            )));
        } else if step.get("close").is_some() {
            let unsaved = match step.get("unsaved").and_then(Value::as_str) {
                Some("discard") => Unsaved::Discard,
                _ => Unsaved::Save,
            };
            answers.push(settled_answer(run_steps(
                control.close(&tab_for(&step, "close"), unsaved),
                &mut answer,
            )));
        }
    }
    flush(&log, cx);
    Ok(Some(Value::Array(answers)))
}

// ---- slides-bridge ----

/// a session of a case: `{ deck, comments, attached, txn, saveThrows }`
struct SessionSpec {
    deck: Value,
    comments: Value,
    attached: Option<Vec<i64>>,
    txn: Option<Value>,
    save_throws: Option<String>,
}

struct SlidesHost {
    log: Log,
    wcs: HashMap<i64, Wc>,
    blank: VecDeque<Value>,
    abandon: bool,
    armed: HashSet<u64>,
    next_timer: u64,
    settled: Vec<(u64, BridgeSettled)>,
    clock: f64,
    sessions: HashMap<i64, SessionSpec>,
}

impl SlidesBridgeHost for SlidesHost {
    fn web_contents_alive(&mut self, wc_id: i64) -> bool {
        self.wcs.get(&wc_id).is_some_and(|wc| !wc.destroyed)
    }

    fn send_deck_changed(&mut self, wc_id: i64, payload: &JsonValue) {
        if self.wcs.contains_key(&wc_id) {
            push(
                &self.log,
                vec![
                    Value::from("wc.send"),
                    Value::from(wc_id),
                    Value::from("slides:deck-changed"),
                    sv(payload),
                ],
            );
        }
    }

    fn now_ms(&mut self) -> f64 {
        self.clock
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        let id = self.next_timer;
        self.next_timer += 1;
        self.armed.insert(id);
        push(&self.log, vec![Value::from("setTimeout"), Value::from(ms)]);
        id
    }

    fn settle(&mut self, op: u64, outcome: BridgeSettled) {
        self.settled.push((op, outcome));
    }

    fn open_blank_tab(&mut self) -> Result<i64, String> {
        next_blank(&mut self.blank, &self.log)
    }

    fn abandon_blank_tab(&mut self, wc_id: i64) {
        if self.abandon {
            push(
                &self.log,
                vec![Value::from("deps.abandonBlankTab"), Value::from(wc_id)],
            );
        }
    }

    fn exists_sync(&mut self, path: &str) -> bool {
        fs::metadata(path).is_ok()
    }

    fn has_session(&mut self, wc_id: i64) -> bool {
        self.sessions.contains_key(&wc_id)
    }

    fn deck(&mut self, wc_id: i64) -> JsonValue {
        self.sessions
            .get(&wc_id)
            .map_or(JsonValue::Null, |session| jv(&session.deck))
    }

    fn attached_ids(&mut self, wc_id: i64) -> Vec<i64> {
        match self.sessions.get(&wc_id).and_then(|s| s.attached.clone()) {
            Some(ids) => ids,
            None => vec![wc_id],
        }
    }

    fn apply_session_txn(&mut self, wc_id: i64, req: &JsonValue) -> Option<JsonValue> {
        push(
            &self.log,
            vec![Value::from("applySessionTxn"), Value::from(wc_id), sv(req)],
        );
        let result = jv(self.sessions.get(&wc_id)?.txn.as_ref()?);
        result.truthy().then_some(result)
    }

    fn save_session_deck_to(&mut self, wc_id: i64, path: &str) -> Result<(), String> {
        push(
            &self.log,
            vec![
                Value::from("saveSessionDeckTo"),
                Value::from(wc_id),
                Value::from(path),
            ],
        );
        match self
            .sessions
            .get(&wc_id)
            .and_then(|s| s.save_throws.clone())
        {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    fn element_durable_id(&mut self, element: &JsonValue) -> Option<String> {
        match element.get("durable").as_deref() {
            Some(JsonValue::String(id)) => Some(id.clone()),
            _ => None,
        }
    }

    fn slide_durable_id(&mut self, slide: &JsonValue) -> String {
        let path = match slide.get("path").as_deref() {
            Some(JsonValue::String(path)) => path.clone(),
            _ => String::new(),
        };
        match js_regex!(r"slide(\d+)\.xml$").exec(&path) {
            Some(found) => format!("s_{}", found.get(1).unwrap_or("")),
            None => format!(
                "s_{}",
                js_regex!(r"[^a-zA-Z0-9]", "g").replace_all(&path, |_| "_".to_owned())
            ),
        }
    }

    fn slide_comments(&mut self, wc_id: i64, slide_path: &str) -> Vec<JsonValue> {
        self.sessions
            .get(&wc_id)
            .and_then(|s| s.comments.get(slide_path))
            .and_then(Value::as_array)
            .map(|list| list.iter().map(jv).collect())
            .unwrap_or_default()
    }

    fn slide_hidden(&mut self, slide: &JsonValue) -> bool {
        slide.get("hidden").as_deref() == Some(&JsonValue::Bool(true))
    }
}

fn slides_bridge_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let host = SlidesHost {
        log: Rc::clone(&log),
        wcs: wcs_of(&spec),
        blank: blank_of(&spec),
        abandon: on(&spec, "abandon"),
        armed: HashSet::new(),
        next_timer: 1,
        settled: Vec::new(),
        clock: 0.0,
        sessions: HashMap::new(),
    };
    let mut bridge = SlidesBridge::new(host);
    let mut labels: HashMap<u64, String> = HashMap::new();
    let mut outcomes = Map::new();
    let mut answers = Vec::new();
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let id_of = |key: &str| step.get(key).and_then(Value::as_i64).unwrap_or(0);
        let mut started: Option<(String, Submitted)> = None;
        if let Some(label) = step.get("open").and_then(Value::as_str) {
            started = Some((label.to_owned(), bridge.open_blank_tab()));
        } else if step.get("session").is_some() {
            let id = id_of("session");
            if on(&step, "gone") {
                bridge.host_mut().sessions.remove(&id);
            } else {
                bridge.host_mut().sessions.insert(
                    id,
                    SessionSpec {
                        deck: step.get("deck").cloned().unwrap_or_else(
                            || json!({ "size": { "cx": 0, "cy": 0 }, "slides": [] }),
                        ),
                        comments: step.get("comments").cloned().unwrap_or_else(|| json!({})),
                        attached: step
                            .get("attached")
                            .and_then(Value::as_array)
                            .map(|list| list.iter().filter_map(Value::as_i64).collect()),
                        txn: step.get("txn").cloned(),
                        save_throws: step
                            .get("saveThrows")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                    },
                );
            }
        } else if step.get("fire").is_some() {
            let id = id_of("fire") as u64;
            if bridge.host_mut().armed.remove(&id) {
                bridge.on_timeout(id);
            }
        } else if let Some(at) = step.get("at").and_then(Value::as_f64) {
            bridge.host_mut().clock = at;
        } else if step.get("destroy").is_some() {
            if let Some(wc) = bridge.host_mut().wcs.get_mut(&id_of("destroy")) {
                wc.destroyed = true;
            }
        } else if step.get("vanish").is_some() {
            bridge.host_mut().wcs.remove(&id_of("vanish"));
        } else if step.get("txn").is_some() {
            let req = step.get("req").map_or(JsonValue::Null, jv);
            answers.push(step_answer(
                bridge
                    .run_txn(id_of("txn"), &req)
                    .map(|value| value.map(|value| sv(&value))),
            ));
        } else if step.get("read").is_some() {
            let options = step
                .get("options")
                .filter(|o| o.is_object())
                .map(|o| ReadDeckOptions {
                    withhold: o.get("withhold").and_then(Value::as_bool),
                });
            answers.push(step_answer(
                bridge
                    .read_deck(id_of("read"), options.as_ref())
                    .map(|value| value.map(|value| sv(&value))),
            ));
        } else if step.get("withholds").is_some() {
            answers.push(step_answer(
                bridge
                    .deck_withholds(id_of("withholds"))
                    .map(|value| Some(Value::Bool(value))),
            ));
        } else if step.get("save").is_some() {
            let overwrite = on(&step, "overwrite");
            answers.push(step_answer(
                bridge
                    .save_deck(id_of("save"), &text(&step, "path"), overwrite)
                    .map(|path| Some(json!({ "path": path }))),
            ));
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
    Ok(Some(json!({
        "outcomes": Value::Object(outcomes),
        "answers": Value::Array(answers),
    })))
}

// ---- app-mcp ----

/// the clock of the case, in UTC
struct CaseClock(f64);

impl LogClock for CaseClock {
    fn now_ms(&self) -> f64 {
        self.0
    }

    fn utc_offset_ms(&self, _at_ms: f64) -> f64 {
        0.0
    }
}

struct IdleHost;

impl McpHost for IdleHost {
    fn random_uuid(&self) -> String {
        "00000000-0000-4000-8000-000000000000".to_owned()
    }

    fn now_ms(&self) -> f64 {
        0.0
    }
}

struct AppHost {
    log: Log,
    now_ms: f64,
}

impl McpRuntimeHost for AppHost {
    fn new_service_host(&self) -> Box<dyn McpHost> {
        push(&self.log, vec![Value::from("new service")]);
        Box::new(IdleHost)
    }

    fn new_log_clock(&self) -> Box<dyn LogClock> {
        Box::new(CaseClock(self.now_ms))
    }
}

/// the engines of `app-mcp` that no step calls into
struct Unwired;

impl CliRunner for Unwired {
    fn run(
        &self,
        _args: &[String],
        _options: &crate::shell::mcp::cli_runner::CliRunOptions,
    ) -> crate::shell::mcp::cli_runner::CliRunOutcome {
        crate::shell::mcp::cli_runner::CliRunOutcome {
            ok: false,
            code: 1.0,
            json: None,
            stdout: String::new(),
            stderr: String::new(),
        }
    }
}

impl PdfTextReader for Unwired {
    fn read_pdf_text(
        &self,
        _bytes: &[u8],
        _options: &ReadPdfTextOptions,
    ) -> Result<PdfTextDoc, PdfiumError> {
        Err(PdfiumError::new("not wired"))
    }
}

impl HwpTextReader for Unwired {
    fn hwp_to_text(&self, _bytes: &[u8]) -> Result<String, String> {
        Err("not wired".to_owned())
    }
}

/// the settings of a step: `'undefined'` is no settings
fn settings_of(value: Option<&Value>) -> Option<JsonValue> {
    match value {
        Some(Value::String(text)) if text == "undefined" => None,
        other => other.map(jv),
    }
}

fn deps_of(c: &Value, log: &Log) -> McpRuntimeDeps<'static> {
    let save_dir = c
        .get("saveDir")
        .and_then(Value::as_str)
        .unwrap_or("/save")
        .to_owned();
    let (open_log, open_ok) = (
        Rc::clone(log),
        c.get("openPath").and_then(Value::as_bool) != Some(false),
    );
    let wired = |key: &str| on(c, key);
    McpRuntimeDeps {
        version: c
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("1.2.3")
            .to_owned(),
        default_save_dir: Rc::new(move || save_dir.clone()),
        open_path: Rc::new(move |path: &str| {
            push(&open_log, vec![Value::from("openPath"), Value::from(path)]);
            open_ok
        }),
        docs_control: wired("docs"),
        slides_control: wired("slides"),
        sheets_control: wired("sheets"),
        cli_runner: wired("cli").then(|| Rc::new(Unwired) as Rc<dyn CliRunner>),
        open_documents_control: wired("openDocs"),
        resolve_target: wired("resolve"),
        diagram_control: wired("diagram"),
        diagram_is_detached: None,
        log_file_path: c.get("logFile").and_then(Value::as_str).map(str::to_owned),
        pdf_reader: Rc::new(Unwired),
        hwp_reader: Rc::new(Unwired),
    }
}

/// what the controls of the TypeScript's fake deps answer: the list of open
/// documents and diagrams is empty, nothing else is called
fn app_answer(call: &HostCall) -> Settled {
    match (call.control, call.method) {
        ("OpenDocumentsControl" | "DiagramControl", "list") => {
            Ok(Some(JsonValue::Array(Vec::new())))
        }
        _ => Err("not wired".to_owned()),
    }
}

/// the commands of a step, carried out the way the TypeScript's fake service
/// does: a listener that binds at once and closes at once
fn drive(
    runtime: &mut McpRuntime<'static>,
    first: McpStep,
    log: &Log,
    labels: &HashMap<u32, String>,
    outcomes: &mut Map<String, Value>,
) {
    let mut queue = vec![first];
    while let Some(step) = queue.pop() {
        for (op, settled) in step.settled {
            if let Some(label) = labels.get(&op.0) {
                outcomes.insert(label.clone(), settled_json(&settled));
            }
        }
        for command in step.commands {
            match command {
                Command::Listen { listener, port } => {
                    push(log, vec![Value::from("listen"), Value::from(port)]);
                    let commands = runtime
                        .service_mut()
                        .map(|service| service.on_listening(listener, port))
                        .unwrap_or_default();
                    queue.push(runtime.route(commands));
                }
                Command::CloseListener { listener } => {
                    push(log, vec![Value::from("close")]);
                    let commands = runtime
                        .service_mut()
                        .map(|service| service.on_listener_closed(listener))
                        .unwrap_or_default();
                    queue.push(runtime.route(commands));
                }
                _ => {}
            }
        }
    }
}

fn settled_json(settled: &McpSettled) -> Value {
    match settled {
        Ok(McpResolved::Undefined) => json!({}),
        Ok(McpResolved::Status(status)) => json!({ "ok": sv(&status.to_json()) }),
        Err(message) => json!({ "error": message }),
    }
}

/// each line without its time stamp
fn untimed(lines: Vec<String>) -> Value {
    Value::Array(
        lines
            .into_iter()
            .map(|line| {
                Value::from(js_regex!(r"^\[[^\]]*\] ").replace_all(&line, |_| String::new()))
            })
            .collect(),
    )
}

fn app_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut runtime = McpRuntime::new(Box::new(AppHost {
        log: Rc::clone(&log),
        now_ms: cx.now_ms,
    }));
    let mut labels: HashMap<u32, String> = HashMap::new();
    let mut outcomes = Map::new();
    let mut answers = Vec::new();
    for step in spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if let Some(c) = step.get("configure") {
            runtime.configure_mcp_runtime(deps_of(c, &log));
        } else if step.get("start").is_some() {
            let started = runtime.start_mcp_from_settings(settings_of(step.get("start")).as_ref());
            begin(
                &mut runtime,
                &text(&step, "label"),
                started,
                &log,
                &mut labels,
                &mut outcomes,
            );
        } else if step.get("apply").is_some() {
            let started = runtime.apply_mcp_settings(settings_of(step.get("apply")).as_ref());
            begin(
                &mut runtime,
                &text(&step, "label"),
                started,
                &log,
                &mut labels,
                &mut outcomes,
            );
        } else if let Some(label) = step.get("stop").and_then(Value::as_str) {
            let started = runtime.stop_mcp();
            begin(
                &mut runtime,
                label,
                started,
                &log,
                &mut labels,
                &mut outcomes,
            );
        } else if on(&step, "stopSync") {
            let stepped = runtime.stop_mcp_sync();
            drive(&mut runtime, stepped, &log, &labels, &mut outcomes);
        } else if on(&step, "status") {
            answers.push(sv(&runtime.mcp_status().to_json()));
        } else if on(&step, "tools") {
            answers.push(if runtime.service_mut().is_none() {
                Value::from("no service")
            } else {
                match runtime.build_tools() {
                    Ok(tools) => {
                        Value::Array(tools.iter().map(|t| Value::from(t.name.as_str())).collect())
                    }
                    Err(message) => json!({ "error": message }),
                }
            });
        } else if let Some(name) = step.get("call").and_then(Value::as_str) {
            answers.push(if runtime.service_mut().is_none() {
                Value::from("no service")
            } else {
                match runtime.build_tools() {
                    Ok(tools) => step_answer(
                        call_tool(tools, name, step.get("args"), &mut |call| app_answer(call))
                            .map_err(|error| error.message),
                    ),
                    Err(message) => json!({ "error": message }),
                }
            });
        } else if let Some(message) = step.get("log").and_then(Value::as_str) {
            if runtime.service_mut().is_some() {
                let stepped = runtime.route(vec![Command::Log(message.to_owned())]);
                drive(&mut runtime, stepped, &log, &labels, &mut outcomes);
            }
        } else if on(&step, "logs") {
            answers.push(untimed(runtime.get_mcp_recent_logs()));
        } else if on(&step, "clearLogs") {
            runtime.clear_mcp_logs();
        } else if on(&step, "reveal") {
            runtime.reveal_mcp_log_file();
        } else if on(&step, "logPath") {
            answers.push(runtime.mcp_log_file_path().map_or(Value::Null, Value::from));
        } else if on(&step, "deps") {
            answers.push(
                runtime
                    .current_mcp_runtime_deps()
                    .map_or(Value::Null, |deps| Value::from(deps.version.as_str())),
            );
        }
    }
    flush(&log, cx);
    Ok(Some(json!({
        "outcomes": Value::Object(outcomes),
        "answers": Value::Array(answers),
    })))
}
