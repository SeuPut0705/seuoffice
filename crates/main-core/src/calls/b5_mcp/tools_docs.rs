//! Group `b5-mcp`, slice `tools_docs`: see tools/main-diff/groups/b5-mcp/tools-docs.ts.
//!
//! Each `<file>.call` builds the tools over fakes the case describes (the
//! TypeScript spec lists them): a docs control, a CLI runner, a target
//! resolver, an open-documents control, a PDF text reader, an HWP engine and
//! session drivers. Each call of a fake is one log line, in the order the
//! TypeScript fakes write them; a `Val` of a case is `{ value }`,
//! `{ undef: true }` or `{ throws }`.
//!
//! The PDF text reader and the HWP engine are scripted behind the traits of
//! `pdf_tools` and `hwp_tools`: the scripted PDFium of `calls/b4_pdf` is private
//! to that group, and `hwpToText` has no port.

use std::rc::Rc;

use jscompat::JsonValue;
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg, str_arg};
use super::mcp_pure::{Log, ScriptedCli, flush, jv, new_log, push, sv};
use crate::packages::zod::to_json_schema;
use crate::pdf::pdfium::PdfiumError;
use crate::pdf::read_text::{PdfPageText, PdfTextDoc, ReadPdfTextOptions};
use crate::shell::mcp::cli_runner::CliRunner;
use crate::shell::mcp::mcp_server::{HostCall, McpToolDefinition, Settled, ToolStep};
use crate::shell::mcp::tools::document_tools::{
    DocToolDeps, OutputPathOptions, create_document_tools, document_driver, resolve_output_path,
    resolve_target_path, sanitize_file_base, unique_path_in,
};
use crate::shell::mcp::tools::formats::{
    FORMAT_FAMILIES, FormatFamily, SessionFamily, capability_report, family_label,
    generate_extension, with_save_extension,
};
use crate::shell::mcp::tools::hwp_tools::{
    HWP_MAX_CHARS, HwpReadError, HwpTextReader, create_hwp_tools, hwp_text_window, read_hwp_file,
};
use crate::shell::mcp::tools::open_documents_tools::{
    OpenDocumentsDeps, close_save_path, create_open_document_tools, document_format,
    resolve_open_document, resolve_open_document_of_family,
};
use crate::shell::mcp::tools::pdf_tools::{PdfTextReader, create_pdf_tools, parse_page_list};
use crate::shell::mcp::tools::session_tools::{
    FamilyDriver, ResolveOptions, content_target, create_session_host, create_session_tools,
};
use crate::shell::tab_manager::{OpenDocumentTab, TabKind};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    Some(match name {
        // ---- formats ----
        "formats.FORMAT_FAMILIES" => Ok(Some(Value::Array(
            FORMAT_FAMILIES.iter().map(family_json).collect(),
        ))),
        "formats.formatFamily" => str_arg(args, 0)
            .and_then(|name| find_family(name).map(|family| Some(family_json(family)))),
        "formats.familyLabel" => str_arg(args, 0).and_then(|name| {
            find_family(name).map(|family| Some(Value::from(family_label(family.family))))
        }),
        "formats.generateExtension" => str_arg(args, 0).and_then(|name| {
            let family = SessionFamily::parse(name)
                .ok_or_else(|| CallError::plain(format!("unknown session family \"{name}\"")))?;
            generate_extension(family)
                .map(|ext| Some(Value::from(ext)))
                .map_err(CallError::plain)
        }),
        "formats.withSaveExtension" => (|| {
            let name = str_arg(args, 0)?;
            let family = SessionFamily::parse(name)
                .ok_or_else(|| CallError::plain(format!("unknown session family \"{name}\"")))?;
            with_save_extension(family, str_arg(args, 1)?)
                .map(|path| Some(Value::from(path)))
                .map_err(CallError::plain)
        })(),
        "formats.capabilityReport" => {
            // `options.generating !== false`: only a `false` itself turns it off
            let generating = match arg(args, 0) {
                Some(Value::Object(options))
                    if options.get("generating") == Some(&Value::Bool(false)) =>
                {
                    Some(false)
                }
                _ => None,
            };
            Ok(Some(sv(&capability_report(generating))))
        }

        // ---- session-tools ----
        "session-tools.createSessionHost" => session_host_call(args),
        "session-tools.contentTarget" => content_target_call(args, cx),
        "session-tools.tools" => {
            let families: Vec<&str> = arg(args, 0)
                .and_then(|spec| spec.get("families"))
                .and_then(Value::as_array)
                .map(|list| list.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let log = new_log();
            let drivers: Vec<Rc<dyn FamilyDriver>> = families
                .iter()
                .filter_map(|name| SessionFamily::parse(name))
                .map(|family| {
                    Rc::new(ScriptDriver::bare(family, Rc::clone(&log))) as Rc<dyn FamilyDriver>
                })
                .collect();
            let tools = create_session_tools(&drivers, create_session_host());
            Ok(Some(listed(&tools)))
        }
        "session-tools.call" => session_call(args, cx),

        // ---- document-tools ----
        "document-tools.sanitizeFileBase" => {
            str_arg(args, 0).map(|title| Some(Value::from(sanitize_file_base(title))))
        }
        "document-tools.uniquePathIn" => (|| {
            let dir = str_arg(args, 0)?;
            Ok(Some(Value::from(unique_path_in(dir, str_arg(args, 1)?))))
        })(),
        "document-tools.resolveOutputPath" => {
            let o = arg(args, 0).cloned().unwrap_or(Value::Null);
            let dir = text(&o, "dir");
            let default_dir = move || format!("{dir}/save");
            resolve_output_path(&OutputPathOptions {
                default_save_dir: &default_dir,
                ext: &text(&o, "ext"),
                title: &text(&o, "title"),
                requested_path: o.get("requestedPath").and_then(Value::as_str),
                overwrite: o.get("overwrite").and_then(Value::as_bool).unwrap_or(false),
            })
            .map(|path| Some(Value::from(path)))
            .map_err(CallError::plain)
        }
        "document-tools.resolveTargetPath" => (|| {
            let dir = str_arg(args, 0)?.to_owned();
            let deps = DocToolDeps {
                version: String::new(),
                default_save_dir: Rc::new(move || format!("{dir}/save")),
                background: None,
                open_in_tab: None,
                docs: false,
                extra_formats: None,
                cli: None,
                resolve_target: false,
            };
            let requested = arg(args, 2).and_then(Value::as_str);
            let overwrite = arg(args, 3).and_then(Value::as_bool).unwrap_or(false);
            resolve_target_path(&deps, str_arg(args, 1)?, requested, overwrite)
                .map(|path| Some(Value::from(path)))
                .map_err(CallError::plain)
        })(),
        "document-tools.documentDriver" => driver_call(args, cx),
        "document-tools.tools" => {
            let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
            let log = new_log();
            let mut deps = json!({ "cli": {} });
            if let Some(background) = spec.get("background") {
                deps["background"] = background.clone();
            }
            if on(&spec, "docs") {
                deps["docs"] = json!({});
            }
            let (deps, _) = build_deps(&deps, &log);
            let tools = create_document_tools(deps, create_session_host());
            Ok(Some(listed(&tools)))
        }
        "document-tools.call" => document_call(args, cx),

        // ---- open-documents-tools ----
        "open-documents-tools.resolveOpenDocument" => (|| {
            let documents = tabs_of(arg(args, 0));
            let found = resolve_open_document(&documents, str_arg(args, 1)?);
            Ok(Some(found.map_or(Value::Null, OpenDocumentTab::to_value)))
        })(),
        "open-documents-tools.resolveOpenDocumentOfFamily" => (|| {
            let documents = tabs_of(arg(args, 0));
            let wanted = str_arg(args, 2)?;
            let family = FORMAT_FAMILIES
                .iter()
                .map(|f| f.family)
                .find(|f| f.as_str() == wanted)
                .ok_or_else(|| CallError::plain(format!("unknown format family \"{wanted}\"")))?;
            resolve_open_document_of_family(&documents, str_arg(args, 1)?, family)
                .map(|tab| Some(tab.to_value()))
                .map_err(CallError::plain)
        })(),
        "open-documents-tools.documentFormat" => {
            document_format(&tab_of(arg(args, 0).unwrap_or(&Value::Null)))
                .map(|format| Some(Value::from(format)))
                .map_err(CallError::plain)
        }
        "open-documents-tools.closeSavePath" => (|| {
            let dir = str_arg(args, 1)?.to_owned();
            close_save_path(&tab_of(arg(args, 0).unwrap_or(&Value::Null)), &move || {
                dir.clone()
            })
            .map(|path| Some(Value::from(path)))
            .map_err(CallError::plain)
        })(),
        "open-documents-tools.tools" => {
            let tools = create_open_document_tools(OpenDocumentsDeps {
                control: false,
                default_save_dir: Rc::new(|| "/x".to_owned()),
            });
            Ok(Some(listed(&tools)))
        }
        "open-documents-tools.call" => open_call(args, cx),

        // ---- pdf-tools ----
        "pdf-tools.parsePageList" => (|| {
            let count = arg(args, 1).and_then(Value::as_f64).unwrap_or(f64::NAN);
            parse_page_list(str_arg(args, 0)?, count)
                .map(|pages| Some(Value::Array(pages.into_iter().map(Value::from).collect())))
                .map_err(CallError::plain)
        })(),
        "pdf-tools.tools" => {
            let reader = Rc::new(ScriptPdf::new(&Value::Null, new_log()));
            Ok(Some(listed(&create_pdf_tools(reader))))
        }
        "pdf-tools.call" => pdf_call(args, cx),

        // ---- hwp-tools ----
        "hwp-tools.HWP_MAX_CHARS" => Ok(Some(Value::from(HWP_MAX_CHARS))),
        "hwp-tools.hwpTextWindow" => (|| {
            let offset = match arg(args, 1) {
                Some(Value::String(s)) if s == "NaN" => f64::NAN,
                Some(Value::String(s)) if s == "Infinity" => f64::INFINITY,
                Some(Value::String(s)) if s == "-Infinity" => f64::NEG_INFINITY,
                Some(other) => other.as_f64().unwrap_or(0.0),
                None => f64::NAN,
            };
            Ok(Some(sv(
                &hwp_text_window(str_arg(args, 0)?, offset).to_json()
            )))
        })(),
        "hwp-tools.readHwpFile" => (|| {
            let path = str_arg(args, 0)?;
            let log = new_log();
            let reader = ScriptHwp::new(arg(args, 1).unwrap_or(&Value::Null), Rc::clone(&log));
            let result = read_hwp_file(&reader, path);
            flush(&log, cx);
            match result {
                Ok(text) => Ok(Some(Value::from(text))),
                Err(HwpReadError::File(error)) => Err(CallError::from(error)),
                Err(HwpReadError::Engine(message)) => Err(CallError::plain(message)),
            }
        })(),
        "hwp-tools.tools" => {
            let reader = Rc::new(ScriptHwp::new(&Value::Null, new_log()));
            Ok(Some(listed(&create_hwp_tools(reader))))
        }
        "hwp-tools.call" => hwp_call(args, cx),
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

fn strings(list: &[&str]) -> Value {
    Value::Array(list.iter().map(|s| Value::from(*s)).collect())
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

// ---- formats ----

fn family_json(f: &FormatFamily) -> Value {
    let mut out = Map::new();
    out.insert("family".into(), Value::from(f.family.as_str()));
    out.insert("label".into(), Value::from(f.label));
    out.insert("editorOpen".into(), strings(f.editor_open));
    out.insert("editorSave".into(), strings(f.editor_save));
    out.insert("editorExport".into(), strings(f.editor_export));
    if let Some(mcp) = &f.mcp {
        let mut formats = Map::new();
        if let Some(generate) = mcp.generate {
            formats.insert("generate".into(), Value::from(generate));
        }
        if let Some(save) = mcp.save {
            formats.insert("save".into(), strings(save));
        }
        if let Some(read) = mcp.read {
            formats.insert("read".into(), Value::from(read));
        }
        out.insert("mcp".into(), Value::Object(formats));
    }
    Value::Object(out)
}

/// `formatFamily(name)`: a string the registry does not hold throws
fn find_family(name: &str) -> Result<&'static FormatFamily, CallError> {
    FORMAT_FAMILIES
        .iter()
        .find(|f| f.family.as_str() == name)
        .ok_or_else(|| CallError::plain(format!("unknown format family \"{name}\"")))
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

/// `tools.find(name).handler(args ?? {})`, resumed through every host call
/// the handler awaits: the fakes of the case answer them
fn call_tool(
    tools: Vec<McpToolDefinition<'_>>,
    name: &str,
    args: Option<&Value>,
    fakes: &Fakes,
) -> Answer {
    let Some(mut tool) = tools.into_iter().find(|tool| tool.name == name) else {
        return Err(CallError::plain(format!("no such tool: {name}")));
    };
    let args = match args {
        Some(args) if !args.is_null() => jv(args),
        _ => jv(&json!({})),
    };
    drive((tool.handler)(args), fakes)
        .map(|value| value.map(|value| sv(&value)))
        .map_err(CallError::plain)
}

/// run the steps of a handler to its end: each host call it awaits is
/// answered by the fakes, then the handler goes on
fn drive(mut step: ToolStep<'_>, fakes: &Fakes) -> Settled {
    loop {
        match step {
            ToolStep::Done(settled) => return settled,
            ToolStep::Await { call, then } => step = then(fakes.answer(&call)),
        }
    }
}

fn string_at(args: &[JsonValue], at: usize) -> String {
    match args.get(at) {
        Some(JsonValue::String(text)) => text.clone(),
        _ => String::new(),
    }
}

fn number_at(args: &[JsonValue], at: usize) -> i64 {
    match args.get(at) {
        Some(JsonValue::Number(number)) => *number as i64,
        _ => 0,
    }
}

/// What answers the host calls a case's handler awaits, from the script the
/// case gives; each call is one log line, as the TypeScript's fake writes it.
struct Fakes {
    log: Log,
    /// the session drivers of a case
    drivers: Vec<Rc<ScriptDriver>>,
    /// the docs control: `{ open, run }`
    docs: Option<Value>,
    /// the target resolver: `{ answer }` or `{ throws }`
    resolver: Option<Value>,
    /// the open-documents control: `{ list, read, close, save }`
    open: Option<Value>,
}

impl Fakes {
    fn new(log: Log) -> Self {
        Fakes {
            log,
            drivers: Vec::new(),
            docs: None,
            resolver: None,
            open: None,
        }
    }

    /// the answer to one awaited host call
    fn answer(&self, call: &HostCall) -> Settled {
        match (call.control, call.method) {
            ("FamilyDriver", method) => {
                let Some(driver) = self
                    .drivers
                    .get(number_at(&call.args, call.args.len().saturating_sub(1)) as usize)
                else {
                    return Err("no such driver".to_owned());
                };
                if method == "openBlankTab" {
                    driver.open()
                } else {
                    driver.save_to(&call.args)
                }
            }
            ("DocsControl", "openBlankTab") => {
                push(&self.log, vec![Value::from("docs.open")]);
                match self.docs.as_ref().and_then(|docs| docs.get("open")) {
                    Some(open) if open.is_object() => Err(text(open, "throws")),
                    Some(open) => Ok(Some(JsonValue::Number(open.as_i64().unwrap_or(1) as f64))),
                    None => Ok(Some(JsonValue::Number(1.0))),
                }
            }
            ("DocsControl", "runCommand") => {
                push(
                    &self.log,
                    vec![
                        Value::from("docs.run"),
                        Value::from(number_at(&call.args, 0)),
                        Value::from(string_at(&call.args, 1)),
                        call.args.get(2).map(sv).unwrap_or(Value::Null),
                    ],
                );
                let run = self.docs.as_ref().and_then(|docs| docs.get("run"));
                Ok(scripted(run)?.map(|value| jv(&value)))
            }
            ("TargetResolver", "resolve") => {
                push(
                    &self.log,
                    vec![
                        Value::from("resolveTarget"),
                        Value::from(string_at(&call.args, 0)),
                        Value::from(string_at(&call.args, 1)),
                        call.args.get(2).map(sv).unwrap_or(Value::Null),
                    ],
                );
                let resolver = self.resolver.as_ref();
                if let Some(message) = resolver
                    .and_then(|r| r.get("throws"))
                    .and_then(Value::as_str)
                {
                    return Err(message.to_owned());
                }
                let answer = resolver
                    .and_then(|r| r.get("answer"))
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                Ok(Some(JsonValue::Number(answer as f64)))
            }
            ("OpenDocumentsControl", method) => self.open_documents(method, &call.args),
            (control, method) => Err(format!("no fake answers {control}.{method}")),
        }
    }

    /// the open-documents control of a case
    fn open_documents(&self, method: &str, args: &[JsonValue]) -> Settled {
        let field = |key: &str| self.open.as_ref().and_then(|spec| spec.get(key));
        let tab_id = || match args.first().and_then(|tab| tab.get("id")).as_deref() {
            Some(JsonValue::String(id)) => id.clone(),
            _ => String::new(),
        };
        match method {
            "list" => {
                push(&self.log, vec![Value::from("control.list")]);
                match field("list") {
                    Some(list @ Value::Array(_)) => Ok(Some(jv(list))),
                    other => Err(other.map(|list| text(list, "throws")).unwrap_or_default()),
                }
            }
            "read" => {
                push(
                    &self.log,
                    vec![Value::from("control.read"), Value::from(tab_id())],
                );
                Ok(scripted(field("read"))?.map(|value| jv(&value)))
            }
            "close" => {
                push(
                    &self.log,
                    vec![
                        Value::from("control.close"),
                        Value::from(tab_id()),
                        args.get(1).map(sv).unwrap_or(Value::Null),
                    ],
                );
                Ok(scripted(field("close"))?.map(|value| jv(&value)))
            }
            "save" => {
                push(
                    &self.log,
                    vec![Value::from("control.save"), Value::from(tab_id())],
                );
                Ok(scripted(field("save"))?.map(|value| jv(&value)))
            }
            other => Err(format!("no fake answers OpenDocumentsControl.{other}")),
        }
    }
}

// ---- session-tools ----

/// a driver of a case: `{ family, open, save }`
struct ScriptDriver {
    /// its place among the drivers of the case: the host call names the driver
    /// that made it, so a handler that picks the wrong one of two drivers of a
    /// family is seen
    index: usize,
    family: SessionFamily,
    open: Option<Value>,
    save: Option<Value>,
    log: Log,
}

impl ScriptDriver {
    fn of(spec: &Value, log: Log) -> Option<Self> {
        Some(ScriptDriver {
            index: 0,
            family: SessionFamily::parse(spec.get("family").and_then(Value::as_str)?)?,
            open: spec.get("open").cloned(),
            save: spec.get("save").cloned(),
            log,
        })
    }

    fn bare(family: SessionFamily, log: Log) -> Self {
        ScriptDriver {
            index: 0,
            family,
            open: Some(Value::from(1)),
            save: None,
            log,
        }
    }
}

impl ScriptDriver {
    /// the answer to `driver.openBlankTab()`
    fn open(&self) -> Settled {
        push(
            &self.log,
            vec![
                Value::from("driver.open"),
                Value::from(self.family.as_str()),
            ],
        );
        if let Some(message) = self
            .open
            .as_ref()
            .and_then(|open| open.get("throws"))
            .and_then(Value::as_str)
        {
            return Err(message.to_owned());
        }
        let wc = self.open.as_ref().and_then(Value::as_i64).unwrap_or(0);
        Ok(Some(JsonValue::Number(wc as f64)))
    }

    /// the answer to `driver.save(wcId, path, overwrite)`
    fn save_to(&self, args: &[JsonValue]) -> Settled {
        push(
            &self.log,
            vec![
                Value::from("driver.save"),
                Value::from(self.family.as_str()),
                Value::from(number_at(args, 1)),
                Value::from(string_at(args, 2)),
                Value::Bool(matches!(args.get(3), Some(JsonValue::Bool(true)))),
            ],
        );
        Ok(scripted(self.save.as_ref())?.map(|value| jv(&value)))
    }
}

/// the host calls a driver of a case awaits name the family first, which
/// [`Fakes::answer`] routes by
impl FamilyDriver for ScriptDriver {
    fn family(&self) -> SessionFamily {
        self.family
    }

    fn open_blank_tab(&self) -> HostCall {
        HostCall {
            control: "FamilyDriver",
            method: "openBlankTab",
            args: vec![
                JsonValue::String(self.family.as_str().to_owned()),
                JsonValue::Number(self.index as f64),
            ],
        }
    }

    fn save(&self, wc_id: i64, path: &str, overwrite: bool) -> HostCall {
        HostCall {
            control: "FamilyDriver",
            method: "save",
            args: vec![
                JsonValue::String(self.family.as_str().to_owned()),
                JsonValue::Number(wc_id as f64),
                JsonValue::String(path.to_owned()),
                JsonValue::Bool(overwrite),
                JsonValue::Number(self.index as f64),
            ],
        }
    }
}

fn session_json(session: Option<crate::shell::mcp::tools::session_tools::ActiveSession>) -> Value {
    match session {
        Some(active) => json!({ "family": active.family.as_str(), "wcId": active.wc_id }),
        None => Value::Null,
    }
}

fn session_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let host = create_session_host();
    if let Some(session) = spec.get("session").filter(|s| s.is_object())
        && let Some(family) = SessionFamily::parse(&text(session, "family"))
    {
        let wc = session.get("wcId").and_then(Value::as_i64).unwrap_or(0);
        host.borrow_mut().begin(family, wc);
    }
    let mut fakes = Fakes::new(Rc::clone(&log));
    fakes.drivers = spec
        .get("drivers")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|d| ScriptDriver::of(d, Rc::clone(&log)))
                .enumerate()
                .map(|(index, mut driver)| {
                    driver.index = index;
                    Rc::new(driver)
                })
                .collect()
        })
        .unwrap_or_default();
    let drivers: Vec<Rc<dyn FamilyDriver>> = fakes
        .drivers
        .iter()
        .map(|d| Rc::clone(d) as Rc<dyn FamilyDriver>)
        .collect();
    let tools = create_session_tools(&drivers, Rc::clone(&host));
    let answer = call_tool(tools, &text(&spec, "tool"), spec.get("args"), &fakes);
    push(
        &log,
        vec![
            Value::from("session"),
            session_json(host.borrow().current()),
        ],
    );
    flush(&log, cx);
    answer
}

fn session_host_call(args: &[Value]) -> Answer {
    let host = create_session_host();
    let steps = arg(args, 0)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut answers = Vec::new();
    for step in &steps {
        let family_of = |value: &Value| SessionFamily::parse(value.as_str().unwrap_or(""));
        answers.push(if let Some(begin) = step.get("begin") {
            if let Some(family) = begin.get(0).and_then(family_of) {
                host.borrow_mut()
                    .begin(family, begin.get(1).and_then(Value::as_i64).unwrap_or(0));
            }
            Value::Null
        } else if step.get("current").is_some() {
            session_json(host.borrow().current())
        } else if let Some(wanted) = step.get("require") {
            match family_of(wanted).map(|family| host.borrow().require(family)) {
                Some(Ok(wc)) => json!({ "wcId": wc }),
                Some(Err(message)) => json!({ "error": message }),
                None => json!({ "error": "unknown family" }),
            }
        } else {
            host.borrow_mut().end();
            Value::Null
        });
    }
    Ok(Some(Value::Array(answers)))
}

fn content_target_call(args: &[Value], cx: &mut Context) -> Answer {
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
    // a resolver of a case: `{ answer }` or `{ throws }`
    let mut fakes = Fakes::new(Rc::clone(&log));
    fakes.resolver = spec.get("resolver").filter(|r| r.is_object()).cloned();
    let family = SessionFamily::parse(&text(&spec, "family")).unwrap_or(SessionFamily::Docx);
    let target = content_target(Rc::clone(&host), fakes.resolver.is_some(), family);
    let mut answers = Vec::new();
    for call in spec
        .get("calls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let document = call.get("document").map(jv);
        let options = call.get("options").map(|o| ResolveOptions {
            focus: o.get("focus").and_then(Value::as_bool),
        });
        let step = target(
            document.as_ref(),
            options,
            Box::new(|found: Result<i64, String>| {
                ToolStep::Done(found.map(|wc| Some(JsonValue::Number(wc as f64))))
            }),
        );
        answers.push(match drive(step, &fakes) {
            Ok(Some(JsonValue::Number(wc))) => json!({ "ok": wc as i64 }),
            Ok(_) => Value::Null,
            Err(message) => json!({ "error": message }),
        });
    }
    flush(&log, cx);
    Ok(Some(Value::Array(answers)))
}

// ---- document-tools ----

/// the dependencies of a case (`DepsSpec` of the spec) and its scripted CLI
fn build_deps<'h>(d: &Value, log: &Log) -> (Rc<DocToolDeps<'h>>, Option<Rc<ScriptedCli>>) {
    let save_dir = d
        .get("saveDir")
        .and_then(Value::as_str)
        .unwrap_or("/save")
        .to_owned();
    let cli = d
        .get("cli")
        .map(|outcomes| Rc::new(ScriptedCli::new(Some(outcomes), Rc::clone(log))));
    let open_in_tab = d
        .get("openInTab")
        .and_then(Value::as_str)
        .filter(|mode| *mode != "none")
        .map(|mode| {
            let (log, throws) = (Rc::clone(log), mode == "throws");
            Rc::new(move |path: &str| {
                push(&log, vec![Value::from("openInTab"), Value::from(path)]);
                if throws {
                    Err("cannot open".to_owned())
                } else {
                    Ok(())
                }
            }) as Rc<dyn Fn(&str) -> Result<(), String>>
        });
    let deps = DocToolDeps {
        version: d
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or("9.9.9")
            .to_owned(),
        default_save_dir: Rc::new(move || save_dir.clone()),
        background: d.get("background").and_then(Value::as_bool),
        open_in_tab,
        docs: d.get("docs").is_some(),
        extra_formats: d.get("extraFormats").and_then(Value::as_array).map(|list| {
            list.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        }),
        cli: cli.clone().map(|cli| cli as Rc<dyn CliRunner>),
        resolve_target: d.get("resolve").is_some(),
    };
    (Rc::new(deps), cli)
}

fn document_call(args: &[Value], cx: &mut Context) -> Answer {
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
    let deps_spec = spec.get("deps").cloned().unwrap_or(Value::Null);
    let (deps, cli) = build_deps(&deps_spec, &log);
    let mut fakes = Fakes::new(Rc::clone(&log));
    fakes.docs = deps_spec.get("docs").cloned();
    fakes.resolver = deps_spec.get("resolve").cloned();
    let tools = create_document_tools(deps, host);
    let answer = call_tool(tools, &text(&spec, "tool"), spec.get("args"), &fakes);
    if let Some(dir) = cli.and_then(|cli| cli.scratch.borrow().clone()) {
        push(
            &log,
            vec![
                Value::from("scratch folder removed"),
                Value::Bool(std::fs::metadata(dir).is_err()),
            ],
        );
    }
    flush(&log, cx);
    answer
}

fn driver_call(args: &[Value], cx: &mut Context) -> Answer {
    let world = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let mut fakes = Fakes::new(Rc::clone(&log));
    fakes.docs = Some(world);
    let driver = document_driver();
    let answer = (|| {
        let mut out = Map::new();
        out.insert("family".into(), Value::from(driver.family().as_str()));
        if str_arg(args, 1).is_ok_and(|op| op == "open") {
            match fakes.answer(&driver.open_blank_tab()) {
                Ok(Some(JsonValue::Number(wc))) => {
                    out.insert("wcId".into(), Value::from(wc as i64));
                }
                Ok(_) => {}
                Err(message) => return Err(CallError::plain(message)),
            }
        } else {
            let wc = arg(args, 2).and_then(Value::as_i64).unwrap_or(0);
            let overwrite = arg(args, 4).and_then(Value::as_bool).unwrap_or(false);
            let saved = fakes
                .answer(&driver.save(wc, str_arg(args, 3)?, overwrite))
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

// ---- open-documents-tools ----

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

fn open_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    // the open-documents control of a case: `{ list, read, close, save }`
    let control = spec.get("control").filter(|c| c.is_object()).cloned();
    let mut fakes = Fakes::new(Rc::clone(&log));
    fakes.open = control.clone();
    let tools = create_open_document_tools(OpenDocumentsDeps {
        control: control.is_some(),
        default_save_dir: Rc::new(|| "/unused".to_owned()),
    });
    let answer = call_tool(tools, "open_documents", spec.get("args"), &fakes);
    flush(&log, cx);
    answer
}

// ---- pdf-tools ----

/// the PDF text reader of a case: `{ pageCount, info, pages, truncated,
/// failProbe, failRead }`. A read with a zero budget is the probe.
struct ScriptPdf {
    world: Value,
    log: Log,
}

impl ScriptPdf {
    fn new(world: &Value, log: Log) -> Self {
        ScriptPdf {
            world: world.clone(),
            log,
        }
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

impl PdfTextReader for ScriptPdf {
    fn read_pdf_text(
        &self,
        bytes: &[u8],
        options: &ReadPdfTextOptions,
    ) -> Result<PdfTextDoc, PdfiumError> {
        // the options as the TypeScript passes them: `pages`, then `charBudget`
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
            .unwrap_or(0) as i32;
        if options.char_budget == Some(0.0) {
            if let Some(message) = self.world.get("failProbe").and_then(Value::as_str) {
                return Err(PdfiumError::new(message));
            }
            return Ok(PdfTextDoc {
                page_count,
                title: None,
                author: None,
                pages: Vec::new(),
                truncated: false,
            });
        }
        if let Some(message) = self.world.get("failRead").and_then(Value::as_str) {
            return Err(PdfiumError::new(message));
        }
        let info = self.world.get("info");
        let pages: Vec<PdfPageText> = self
            .world
            .get("pages")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(page_of)
                    .filter(|page| {
                        options
                            .pages
                            .as_ref()
                            .is_none_or(|wanted| wanted.contains(&page.page))
                    })
                    .collect()
            })
            .unwrap_or_default();
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
            pages,
            truncated: on(&self.world, "truncated"),
        })
    }
}

fn pdf_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let reader = Rc::new(ScriptPdf::new(
        spec.get("reader").unwrap_or(&Value::Null),
        Rc::clone(&log),
    ));
    let answer = call_tool(
        create_pdf_tools(reader),
        "read_pdf",
        spec.get("args"),
        &Fakes::new(Rc::clone(&log)),
    );
    flush(&log, cx);
    answer
}

// ---- hwp-tools ----

/// the HWP engine of a case: `{ text }` or `{ throws }`
struct ScriptHwp {
    world: Value,
    log: Log,
}

impl ScriptHwp {
    fn new(world: &Value, log: Log) -> Self {
        ScriptHwp {
            world: world.clone(),
            log,
        }
    }
}

impl HwpTextReader for ScriptHwp {
    fn hwp_to_text(&self, bytes: &[u8]) -> Result<String, String> {
        push(
            &self.log,
            vec![
                Value::from("hwpToText"),
                Value::from(String::from_utf8_lossy(bytes).into_owned()),
            ],
        );
        if let Some(message) = self.world.get("throws").and_then(Value::as_str) {
            return Err(message.to_owned());
        }
        Ok(text(&self.world, "text"))
    }
}

fn hwp_call(args: &[Value], cx: &mut Context) -> Answer {
    let spec = arg(args, 0).cloned().unwrap_or(Value::Null);
    let log = new_log();
    let reader = Rc::new(ScriptHwp::new(
        spec.get("world").unwrap_or(&Value::Null),
        Rc::clone(&log),
    ));
    let answer = call_tool(
        create_hwp_tools(reader),
        "read_hwp",
        spec.get("args"),
        &Fakes::new(Rc::clone(&log)),
    );
    flush(&log, cx);
    answer
}
