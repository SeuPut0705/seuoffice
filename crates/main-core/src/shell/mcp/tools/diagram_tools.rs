//! `apps/shell/src/main/mcp/tools/diagram-tools.ts`: the diagram tools of the
//! in-app MCP server: `read_diagram` (the `read` op) and `apply_diagram_ops` (a
//! list of the ops that change a diagram). They are built from the one
//! definition of the ops ([`DIAGRAM_OPS`]), the same one the editor's AI panel
//! uses, and run through the same executor in the editor: one call is one
//! undo step, and when any op is refused nothing changes.
//!
//! A call addresses an open diagram tab by the id or path `open_documents`
//! returns; without one it takes the diagram in front. Diagrams have no
//! session of their own.
//!
//! Handlers return [`ToolStep`]s. The `DiagramControl` interface has no Rust
//! trait: its awaited methods are `HostCall { control: "DiagramControl",
//! method: "list" [] | "read" [tab, page] | "apply" [tab, ops], .. }`, a tab
//! being `{ id, kind, title, filePath?, active, dirty }`; `list` answers an
//! array of tabs, `read` `{ text, pages?, page? }`. `isDetached` is a sync
//! question of the shell and stays a closure of the deps.

use std::rc::Rc;

use jscompat::{JsObject, JsonValue, trim};

use super::formats::EditorFamily;
use super::open_documents_tools::{resolve_open_document_of_family, tab_json};
use super::session_tools::{ObjectDraft, js_object, string_of};
use super::sheets_tools::ask;
use crate::packages::drawio_model::ops::{
    DIAGRAM_OPS, DiagramOpDefinition, OpPropertySchema, OpPropertyType,
};
use crate::packages::i18n::PRODUCT_NAME;
use crate::packages::zod::{ZodShape, ZodType, z};
use crate::shell::mcp::mcp_server::{McpToolDefinition, Settled, ToolStep};
use crate::shell::tab_manager::{OpenDocumentTab, TabKind};

/// `DiagramToolsDeps`
pub struct DiagramToolsDeps<'h> {
    /// a `DiagramControl` is wired; absent in headless runs, where the two
    /// tools answer that the app is not running
    pub control: bool,
    /// `control.isDetached?`: true for a document in a detached window. An
    /// active one there is its focused window, which is in front of the
    /// shell's active tab. `None` is a control without the method.
    pub is_detached: Option<Rc<dyn Fn(&str) -> bool + 'h>>,
}

/// `DIAGRAM_MCP_TOOL_NAMES.read`
pub const DIAGRAM_MCP_TOOL_READ: &str = "read_diagram";
/// `DIAGRAM_MCP_TOOL_NAMES.apply`
pub const DIAGRAM_MCP_TOOL_APPLY: &str = "apply_diagram_ops";

/// a tab the control answered
pub fn tab_of_json(value: &JsonValue) -> OpenDocumentTab {
    let text = |key: &str| match value.get(key).as_deref() {
        Some(JsonValue::String(text)) => text.clone(),
        _ => String::new(),
    };
    let flag = |key: &str| value.get(key).as_deref() == Some(&JsonValue::Bool(true));
    OpenDocumentTab {
        id: text("id"),
        kind: TabKind::parse(&text("kind")).unwrap_or(TabKind::Home),
        title: text("title"),
        file_path: match value.get("filePath").as_deref() {
            Some(JsonValue::String(path)) => Some(path.clone()),
            _ => None,
        },
        active: flag("active"),
        dirty: flag("dirty"),
    }
}

/// One op property as a zod schema; the planner checks ranges and per-op rules.
fn property_schema(
    prop: &OpPropertySchema,
    description: &str,
    enum_values: Option<&[&str]>,
) -> ZodType {
    let schema = match prop.kind {
        OpPropertyType::Number => z::number(),
        OpPropertyType::Array => z::array(z::string()),
        _ => match enum_values {
            Some(values) if !values.is_empty() => z::enum_(values),
            _ => z::string(),
        },
    };
    schema.optional().describe(description)
}

/// `name {required, optional?}: description`, as the tool description lists each op.
fn op_signature(op: &DiagramOpDefinition) -> String {
    let keys: Vec<String> = op
        .input
        .properties
        .iter()
        .map(|(key, _)| {
            if op.input.required.contains(key) {
                (*key).to_owned()
            } else {
                format!("{key}?")
            }
        })
        .collect();
    format!("{} {{{}}}: {}", op.name, keys.join(", "), op.description)
}

/// the merge of one property key over the ops that take it
struct Merged<'a> {
    key: &'static str,
    prop: &'a OpPropertySchema,
    enums: Vec<Option<&'a [&'static str]>>,
    /// description -> the ops using it, in the order the descriptions came
    uses: Vec<(&'a str, Vec<&'static str>)>,
}

fn type_name(kind: OpPropertyType) -> &'static str {
    match kind {
        OpPropertyType::String => "string",
        OpPropertyType::Number => "number",
        OpPropertyType::Array => "array",
    }
}

/// `diagramOpItemSchema(ops)`: the item schema of `ops`: one object whose `op`
/// names the op, with every key any op takes (each optional; a key several ops
/// take says what it means for each). Unknown keys pass through so the planner
/// refuses them per op, inside the all-or-nothing result, instead of being
/// dropped silently. `Err` is the message of what it throws.
pub fn diagram_op_item_schema(ops: &[DiagramOpDefinition]) -> Result<ZodType, String> {
    let mut merged: Vec<Merged<'_>> = Vec::new();
    for op in ops {
        for (key, prop) in &op.input.properties {
            let at = match merged.iter().position(|entry| entry.key == *key) {
                Some(at) => {
                    if merged[at].prop.kind != prop.kind {
                        return Err(format!(
                            "op property {key} has two types ({}, {})",
                            type_name(merged[at].prop.kind),
                            type_name(prop.kind)
                        ));
                    }
                    at
                }
                None => {
                    merged.push(Merged {
                        key,
                        prop,
                        enums: Vec::new(),
                        uses: Vec::new(),
                    });
                    merged.len() - 1
                }
            };
            let entry = &mut merged[at];
            entry.enums.push(prop.enum_values.as_deref());
            match entry
                .uses
                .iter()
                .position(|(text, _)| *text == prop.description)
            {
                Some(found) => entry.uses[found].1.push(op.name),
                None => entry.uses.push((&prop.description, vec![op.name])),
            }
        }
    }
    let names: Vec<&str> = ops.iter().map(|op| op.name).collect();
    let mut shape: ZodShape = vec![("op".to_owned(), z::enum_(&names).describe("The op to run."))];
    for entry in &merged {
        let description = if entry.uses.len() == 1 {
            entry.uses[0].0.to_owned()
        } else {
            entry
                .uses
                .iter()
                .map(|(text, names)| format!("{}: {text}", names.join(", ")))
                .collect::<Vec<_>>()
                .join(" ")
        };
        // an enum is enforced here only when every op taking the key has the same one
        let first = entry.enums[0];
        let shared = first.is_some_and(|first| {
            entry
                .enums
                .iter()
                .all(|values| values.is_some_and(|values| values == first))
        });
        shape.push((
            entry.key.to_owned(),
            property_schema(entry.prop, &description, if shared { first } else { None }),
        ));
    }
    Ok(z::loose_object(shape))
}

/// `DOCUMENT_ARG`
fn document_arg() -> ZodType {
    z::string().optional().describe(
        "Id or path of an open diagram, as open_documents lists it. Default: the diagram in front.",
    )
}

/// `noDiagramInFront(documents)`: a guided "which diagram?" error listing the
/// diagrams that are open
fn no_diagram_in_front(documents: &[OpenDocumentTab]) -> String {
    let diagrams: Vec<&OpenDocumentTab> = documents
        .iter()
        .filter(|doc| doc.kind == TabKind::Diagram)
        .collect();
    if diagrams.is_empty() {
        return format!("no diagram is open in {PRODUCT_NAME}");
    }
    let listing = diagrams
        .iter()
        .map(|doc| {
            format!(
                "  {}  {}  \u{2014} {}",
                doc.id,
                doc.file_path.as_deref().unwrap_or("(never saved)"),
                doc.title
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("no diagram is in front; pass `document` with one of the open diagrams:\n{listing}")
}

/// `frontDiagram(documents, isDetached)`: the diagram in front: an active
/// diagram tab, the one in a focused detached window first (the shell's
/// active tab sits behind it).
pub fn front_diagram<'a>(
    documents: &'a [OpenDocumentTab],
    is_detached: Option<&dyn Fn(&str) -> bool>,
) -> Option<&'a OpenDocumentTab> {
    let active: Vec<&OpenDocumentTab> = documents
        .iter()
        .filter(|doc| doc.kind == TabKind::Diagram && doc.active)
        .collect();
    if active.len() <= 1 {
        return active.first().copied();
    }
    active
        .iter()
        .find(|doc| is_detached.is_some_and(|detached| detached(&doc.id)))
        .or(active.first())
        .copied()
}

/// `targetDiagram(control, document)` as steps: `DiagramControl.list []` is awaited
fn target_diagram<'h>(
    is_detached: Option<Rc<dyn Fn(&str) -> bool + 'h>>,
    document: Option<JsonValue>,
    then: impl FnOnce(OpenDocumentTab) -> ToolStep<'h> + 'h,
) -> ToolStep<'h> {
    ask("DiagramControl", "list", vec![], move |settled| {
        let documents: Vec<OpenDocumentTab> = match settled {
            Ok(Some(JsonValue::Array(items))) => items.iter().map(tab_of_json).collect(),
            Ok(_) => Vec::new(),
            Err(message) => return ToolStep::Done(Err(message)),
        };
        let wanted = match &document {
            Some(JsonValue::String(text)) => trim(text),
            _ => "",
        };
        if !wanted.is_empty() {
            return match resolve_open_document_of_family(&documents, wanted, EditorFamily::Drawio) {
                Ok(doc) => then(doc.clone()),
                Err(message) => ToolStep::Done(Err(message)),
            };
        }
        let detached = |id: &str| is_detached.as_ref().is_some_and(|f| f(id));
        match front_diagram(&documents, Some(&detached)) {
            Some(front) => then(front.clone()),
            None => ToolStep::Done(Err(no_diagram_in_front(&documents))),
        }
    })
}

/// `r.created?.length` is truthy
fn has_length(value: Option<&JsonValue>) -> bool {
    match value {
        None | Some(JsonValue::Null) => false,
        Some(value) => value.get("length").is_some_and(|length| length.truthy()),
    }
}

/// `value.key`, `None` being `undefined`
fn field(value: &JsonValue, key: &str) -> Option<JsonValue> {
    value.get(key).map(|found| found.into_owned())
}

/// what a call reports: `{ status, changed, results, created }`
struct ApplyReport {
    status: String,
    changed: bool,
    results: Vec<JsonValue>,
    created: Vec<JsonValue>,
}

impl ApplyReport {
    fn to_json(&self) -> Vec<(&'static str, JsonValue)> {
        vec![
            ("status", JsonValue::String(self.status.clone())),
            ("changed", JsonValue::Bool(self.changed)),
            ("results", JsonValue::Array(self.results.clone())),
            ("created", JsonValue::Array(self.created.clone())),
        ]
    }
}

/// `applyReport(raw)`: what a call reports: the outcome of every op and the
/// ids made; the plan's internals stay home.
fn apply_report(raw: Option<&JsonValue>) -> Result<ApplyReport, String> {
    let result = match raw {
        None | Some(JsonValue::Null) => JsonValue::Object(JsObject::new()),
        Some(raw) => raw.clone(),
    };
    let results = match field(&result, "results") {
        Some(JsonValue::Array(items)) => {
            let mut out = Vec::new();
            for r in &items {
                if matches!(r, JsonValue::Null) {
                    return Err("Cannot read properties of null (reading 'index')".to_owned());
                }
                let mut entry = ObjectDraft::new();
                entry.set("index", field(r, "index"));
                entry.set("op", field(r, "op"));
                entry.set("status", field(r, "status"));
                let created = field(r, "created");
                if has_length(created.as_ref()) {
                    entry.set("created", created);
                }
                if let Some(error) = field(r, "error").filter(JsonValue::truthy) {
                    let mut inner = ObjectDraft::new();
                    inner.set("code", field(&error, "code"));
                    inner.set("message", field(&error, "message"));
                    entry.set("error", Some(inner.finish()));
                }
                if let Some(read) = field(r, "read").filter(JsonValue::truthy) {
                    entry.set("read", Some(read));
                }
                out.push(entry.finish());
            }
            out
        }
        _ => Vec::new(),
    };
    Ok(ApplyReport {
        status: match field(&result, "status") {
            Some(JsonValue::String(status)) => status,
            _ => "rejected".to_owned(),
        },
        changed: field(&result, "changed") == Some(JsonValue::Bool(true)),
        results,
        created: match field(&result, "created") {
            Some(JsonValue::Array(items)) => items,
            _ => Vec::new(),
        },
    })
}

/// `refusalLine(r)`: one op of a refused call: `index op: FAILED code:
/// reason`, or how it would have gone.
fn refusal_line(r: &JsonValue) -> Result<String, String> {
    let index = string_of(r.get("index").as_deref())?;
    let op = match r.get("op").as_deref() {
        Some(op) if op.truthy() => string_of(Some(op))?,
        _ => "(no op)".to_owned(),
    };
    let head = format!("{index} {op}:");
    let status = field(r, "status");
    if status == Some(JsonValue::String("failed".to_owned())) {
        let error = field(r, "error");
        let nullish = |value: Option<JsonValue>| match value {
            None | Some(JsonValue::Null) => None,
            value => value,
        };
        let code = match nullish(error.as_ref().and_then(|e| field(e, "code"))) {
            Some(code) => string_of(Some(&code))?,
            None => "error".to_owned(),
        };
        let message = match nullish(error.as_ref().and_then(|e| field(e, "message"))) {
            Some(message) => string_of(Some(&message))?,
            None => String::new(),
        };
        return Ok(format!("{head} FAILED {code}: {message}"));
    }
    Ok(if status == Some(JsonValue::String("skipped".to_owned())) {
        format!("{head} skipped")
    } else {
        format!("{head} ok (not applied)")
    })
}

/// `describeTarget(doc)`: `{ id, title, path }`
fn describe_target(doc: &OpenDocumentTab) -> Vec<(&'static str, JsonValue)> {
    vec![
        ("id", JsonValue::String(doc.id.clone())),
        ("title", JsonValue::String(doc.title.clone())),
        (
            "path",
            match &doc.file_path {
                Some(path) => JsonValue::String(path.clone()),
                None => JsonValue::Null,
            },
        ),
    ]
}

/// what `read_diagram` answers of the control's `{ text, pages?, page? }`
fn read_result(doc: &OpenDocumentTab, settled: Settled) -> Settled {
    let answer = match settled? {
        Some(answer) => answer,
        None => {
            return Err("Cannot read properties of undefined (reading 'text')".to_owned());
        }
    };
    let mut out = ObjectDraft::new();
    for (key, value) in describe_target(doc) {
        out.set(key, Some(value));
    }
    out.set("dirty", Some(JsonValue::Bool(doc.dirty)));
    out.set("content", field(&answer, "text"));
    let pages = field(&answer, "pages");
    let page = field(&answer, "page");
    if let (Some(pages), Some(page)) = (pages, page)
        && pages.truthy()
        && page.truthy()
    {
        out.set("pages", Some(pages));
        out.set("page", Some(page));
    }
    Ok(Some(out.finish()))
}

/// `createDiagramTools(deps)`: `Err` is the message of what building the
/// schemas throws (a property two ops give two types).
pub fn create_diagram_tools<'h>(
    deps: DiagramToolsDeps<'h>,
) -> Result<Vec<McpToolDefinition<'h>>, String> {
    let ops = &*DIAGRAM_OPS;
    let read_op = ops
        .iter()
        .find(|op| op.name == "read")
        .expect("DIAGRAM_OPS has a read op");
    // The ops `apply_diagram_ops` takes: every op that changes the diagram.
    let apply_ops: Vec<DiagramOpDefinition> = ops.iter().filter(|op| op.changes).cloned().collect();
    let control = deps.control;
    let is_detached = deps.is_detached;
    // `need()`
    let need = move || -> Result<(), String> {
        if control {
            Ok(())
        } else {
            Err(format!(
                "{PRODUCT_NAME} is not running, so its open diagrams are unreachable"
            ))
        }
    };

    let page_prop = read_op
        .input
        .property("page")
        .expect("the read op has a page property");
    let read_tool = {
        let is_detached = is_detached.clone();
        McpToolDefinition {
            name: DIAGRAM_MCP_TOOL_READ.to_owned(),
            description: format!(
                "Read an open diagram. {} {}",
                read_op.description,
                concat!(
                    "Without page: the page on screen, with the ids the user has selected there. ",
                    "Unsaved edits are included. Without document: the diagram in front. ",
                    "The result has the table as text (content) and as values: pages [{id, name, current?}] and ",
                    "page {id, name, shapes [{id, label, shape, x, y, width, height, parent?, fill?, stroke?}], ",
                    "edges [{id, label, source, target, parent?}], selected?}."
                )
            ),
            input_schema: Some(vec![
                ("document".to_owned(), document_arg()),
                (
                    "page".to_owned(),
                    property_schema(page_prop, &page_prop.description, None),
                ),
            ]),
            handler: Box::new(move |args: JsonValue| {
                if let Err(message) = need() {
                    return ToolStep::Done(Err(message));
                }
                let page = match args.get("page").as_deref() {
                    Some(JsonValue::String(page)) if !trim(page).is_empty() => {
                        JsonValue::String(trim(page).to_owned())
                    }
                    _ => JsonValue::Null,
                };
                target_diagram(
                    is_detached.clone(),
                    args.get("document").map(|d| d.into_owned()),
                    move |doc| {
                        ask(
                            "DiagramControl",
                            "read",
                            vec![tab_json(&doc), page],
                            move |settled| ToolStep::Done(read_result(&doc, settled)),
                        )
                    },
                )
            }),
        }
    };

    let description = [
        "Change an open diagram with a list of ops, applied in order as ONE undo step. Later ops see the results of earlier ones (give a new shape an id and connect it in the same call). All or nothing: if any op is refused, nothing changes and the error lists every op with its outcome; fix the refused ones and send the whole list again. The diagram is not saved: save it with open_documents. Without document: the diagram in front.".to_owned(),
        "Ops:".to_owned(),
    ]
    .into_iter()
    .chain(apply_ops.iter().map(|op| format!("- {}", op_signature(op))))
    .collect::<Vec<_>>()
    .join("\n");
    let apply_tool = McpToolDefinition {
        name: DIAGRAM_MCP_TOOL_APPLY.to_owned(),
        description,
        input_schema: Some(vec![
            ("document".to_owned(), document_arg()),
            (
                "ops".to_owned(),
                z::array(diagram_op_item_schema(&apply_ops)?)
                    .min(1.0)
                    .describe("The ops, applied in order."),
            ),
        ]),
        handler: Box::new(move |args: JsonValue| {
            if let Err(message) = need() {
                return ToolStep::Done(Err(message));
            }
            let ops = match args.get("ops").as_deref() {
                Some(JsonValue::Array(ops)) if !ops.is_empty() => ops.clone(),
                _ => {
                    return ToolStep::Done(Err("ops must be a non-empty list of ops".to_owned()));
                }
            };
            target_diagram(
                is_detached.clone(),
                args.get("document").map(|d| d.into_owned()),
                move |doc| {
                    ask(
                        "DiagramControl",
                        "apply",
                        vec![tab_json(&doc), JsonValue::Array(ops)],
                        move |settled| ToolStep::Done(apply_result(&doc, settled)),
                    )
                },
            )
        }),
    };
    Ok(vec![read_tool, apply_tool])
}

/// what `apply_diagram_ops` answers of the editor's result
fn apply_result(doc: &OpenDocumentTab, settled: Settled) -> Settled {
    let report = apply_report(settled?.as_ref())?;
    if report.status != "ok" {
        let refused = report
            .results
            .iter()
            .filter(|r| field(r, "status") == Some(JsonValue::String("failed".to_owned())))
            .count();
        let mut lines = vec![format!(
            "Nothing was changed: {refused} op(s) were refused, so the whole call was rejected. Fix them and send the whole list again."
        )];
        for r in &report.results {
            lines.push(refusal_line(r)?);
        }
        return Err(lines.join("\n"));
    }
    let mut out = describe_target(doc);
    out.extend(report.to_json());
    Ok(Some(js_object(out)))
}
