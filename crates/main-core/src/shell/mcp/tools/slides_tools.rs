//! `apps/shell/src/main/mcp/tools/slides-tools.ts`: the slides (pptx) tool
//! surface for the MCP server.
//!
//! Two paths, mirroring the docx tools:
//! - headless `create_pptx`: outline -> ops, handed to the bundled `seuoffice`
//!   CLI (`create --type pptx --ops`), gated behind the "background generation"
//!   setting;
//! - a visible deck session: the tools drive a real slides tab the user
//!   watches. Slides sessions live in the slides main process
//!   (`shell::mcp::slides_bridge`).
//!
//! Handlers return [`ToolStep`]s: what the TypeScript awaits of the control
//! is an [`ToolStep::Await`] named after the TS interface and method
//! (`SlidesControl.readDeck [wc]`, `SlidesControl.runTxn [wc, request]`, ...),
//! see `sheets_tools::ask`. The interface has no Rust trait. The session driver of the
//! family (`slidesDriver`) is `openBlankTab []` and `saveDeck [wc, path,
//! overwrite]`; `deckWithholds [wc]` and `readDeck [wc, { withhold }]` are
//! what the agent session's wrapper adds.

use std::rc::Rc;

use jscompat::{JsonValue, trim};

use super::document_tools::{DefaultSaveDir, OutputPathOptions, resolve_output_path};
use super::formats::SessionFamily;
use super::session_tools::{
    FamilyDriver, ObjectDraft, SharedSessionHost, is_true, string_arg, string_of, string_or_empty,
};
use super::sheets_tools::{ask, target_step};
use crate::packages::zod::{ZodType, z};
use crate::shell::mcp::cli_runner::CliRunner;
use crate::shell::mcp::headless_cli::create_pptx_via_cli;
use crate::shell::mcp::mcp_server::{HostCall, McpToolDefinition, ToolStep};
use crate::shell::mcp::pptx_outline::{PptxSourceFormat, outline_to_ops, parse_pptx_outline};

/// `SlidesTxnRequest['isolation']`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Isolation {
    Atomic,
    PerOp,
}

impl Isolation {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            Isolation::Atomic => "atomic",
            Isolation::PerOp => "per_op",
        }
    }
}

/// `SlidesTxnRequest`: transaction request for the visible deck (executor
/// semantics, ops are EMU-space)
#[derive(Debug, Clone, PartialEq)]
pub struct SlidesTxnRequest {
    pub ops: Vec<JsonValue>,
    pub isolation: Option<Isolation>,
    pub dry_run: bool,
}

impl SlidesTxnRequest {
    /// the request as `JSON.stringify` writes it (`isolation` left out when
    /// `undefined`)
    pub fn to_json(&self) -> JsonValue {
        let mut out = ObjectDraft::new();
        out.set("ops", Some(JsonValue::Array(self.ops.clone())));
        out.set(
            "isolation",
            self.isolation
                .map(|isolation| JsonValue::String(isolation.as_str().to_owned())),
        );
        out.set("dryRun", Some(JsonValue::Bool(self.dry_run)));
        out.finish()
    }
}

/// `options` of `SlidesControl.readDeck`: `{ withhold?: boolean }`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ReadDeckOptions {
    pub withhold: Option<bool>,
}

/// `SlidesToolDeps`
pub struct SlidesToolDeps<'h> {
    /// directory generated files land in when the caller gives no path
    pub default_save_dir: DefaultSaveDir<'h>,
    /// expose the headless create_pptx tool; default true (`None`): the shell
    /// passes the user's setting
    pub background: Option<bool>,
    /// a visible-deck control is wired (`SlidesControl`); absent in
    /// headless/unit runs, which drops the session tools
    pub slides: bool,
    /// the bundled seuoffice CLI, used by the headless tool
    pub cli: Option<Rc<dyn CliRunner + 'h>>,
    /// a `TargetResolver` is wired: a `document` argument resolves to the
    /// webContents of that open tab
    pub resolve_target: bool,
}

/// `slidesDriver(slides)`: the session lifecycle of the family as the shared
/// create_session / save_session tools see it: `SlidesControl.openBlankTab []`
/// and `SlidesControl.saveDeck [wc, path, overwrite]` (answers `{ path }`).
struct SlidesDriver;

impl FamilyDriver for SlidesDriver {
    fn family(&self) -> SessionFamily {
        SessionFamily::Pptx
    }

    fn open_blank_tab(&self) -> HostCall {
        HostCall {
            control: "SlidesControl",
            method: "openBlankTab",
            args: Vec::new(),
        }
    }

    fn save(&self, wc_id: i64, path: &str, overwrite: bool) -> HostCall {
        HostCall {
            control: "SlidesControl",
            method: "saveDeck",
            args: vec![
                JsonValue::Number(wc_id as f64),
                JsonValue::String(path.to_owned()),
                JsonValue::Bool(overwrite),
            ],
        }
    }
}

/// `slidesDriver(slides)`
pub fn slides_driver<'h>() -> Rc<dyn FamilyDriver + 'h> {
    Rc::new(SlidesDriver)
}
/// `PPTX_EXT`: `.${generateExtension('pptx')}`, which the registry says is `.pptx`
const PPTX_EXT: &str = ".pptx";

/// the headless tool: outline -> ops -> pptx bytes written straight to disk
fn create_headless_pptx_tool<'h>(deps: Rc<SlidesToolDeps<'h>>) -> McpToolDefinition<'h> {
    McpToolDefinition {
        name: "create_pptx".to_owned(),
        description: concat!(
            "Create a PowerPoint .pptx file from an outline and save it to disk without opening the app UI. ",
            "By default `outline` is Markdown where `# Title` starts each slide, `## text` adds a bold line, ",
            "`- text` a bullet (indent two spaces per level) and `1. text` a numbered bullet. Use ",
            "format:\"json\" to pass {\"slides\":[{\"title\":\"...\",\"bullets\":[\"...\",\"...\",{\"text\":\"...\",\"level\":1}]}]} instead. ",
            "Returns the absolute path of the written file."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![
            ("title", z::string().describe("presentation title, used as the file name")),
            (
                "outline",
                z::string().describe(
                    "Markdown outline (default) or a JSON string of {\"slides\":[...]} when format is \"json\"",
                ),
            ),
            (
                "format",
                z::enum_(&["markdown", "json"])
                    .optional()
                    .describe("outline format; default markdown"),
            ),
            (
                "path",
                z::string()
                    .optional()
                    .describe("absolute output path; default is a new file in the default save folder"),
            ),
            (
                "overwrite",
                z::boolean()
                    .optional()
                    .describe("allow replacing an existing file at `path`; default false"),
            ),
        ])),
        handler: Box::new(move |args: JsonValue| {
            ToolStep::Done((|| -> Result<Option<JsonValue>, String> {
                let title = string_or_empty(&args, "title")?;
                let title = trim(&title);
                if title.is_empty() {
                    return Err("title must not be empty".to_owned());
                }
                let Some(outline) = string_arg(&args, "outline") else {
                    return Err(
                        "outline must be a string (markdown by default, JSON with format:\"json\")"
                            .to_owned(),
                    );
                };
                let Some(cli) = &deps.cli else {
                    return Err("headless generation is not available in this build".to_owned());
                };
                let format = if matches!(args.get("format").as_deref(), Some(JsonValue::String(f)) if f == "json")
                {
                    PptxSourceFormat::Json
                } else {
                    PptxSourceFormat::Markdown
                };
                let ops = outline_to_ops(&parse_pptx_outline(format, &outline)?)?;

                let target_path = resolve_output_path(&OutputPathOptions {
                    default_save_dir: &*deps.default_save_dir,
                    ext: PPTX_EXT,
                    title,
                    requested_path: string_arg(&args, "path").as_deref(),
                    overwrite: is_true(&args, "overwrite"),
                })?;

                let created =
                    create_pptx_via_cli(&**cli, &ops, &target_path, is_true(&args, "overwrite"))?;
                let mut out = ObjectDraft::new();
                out.set("path", Some(created.output_path));
                out.set("summary", created.summary);
                Ok(Some(out.finish()))
            })())
        }),
    }
}

/// `createSlidesTools(deps, host)`: headless generation is opt-in, same rule
/// as create_docx
pub fn create_slides_tools<'h>(
    deps: Rc<SlidesToolDeps<'h>>,
    host: SharedSessionHost,
) -> Vec<McpToolDefinition<'h>> {
    let mut tools = Vec::new();
    if deps.background != Some(false) {
        tools.push(create_headless_pptx_tool(Rc::clone(&deps)));
    }
    tools.extend(create_deck_content_tools(&deps, host));
    tools
}

/// the `document` field of every content tool
fn document_field() -> ZodType {
    z::string().optional().describe(concat!(
        "tab id or path of an open presentation to edit instead of the session's own tab ",
        "(from open_documents {action:\"list\"}); the edit lands in that live deck, and a ",
        "mutating tool switches the UI to that tab first so the user sees it happen"
    ))
}

/// What the TypeError of reading `key` of `null` says
fn read_of_null(key: &str) -> String {
    format!("Cannot read properties of null (reading '{key}')")
}

/// Visible-deck content tools: edit the deck the shared session opened, so the
/// user watches each page take shape. The control mutates the main-process
/// session (the same one the app's own editing and built-in AI use), so every
/// step lands in the app's undo history and the tab re-renders live.
///
/// Only registered when the shell wired a SlidesControl: headless/unit runs
/// keep the file-only surface.
fn create_deck_content_tools<'h>(
    deps: &Rc<SlidesToolDeps<'h>>,
    host: SharedSessionHost,
) -> Vec<McpToolDefinition<'h>> {
    if !deps.slides {
        return Vec::new();
    }
    let resolver = deps.resolve_target;

    let read_deck = {
        let host = Rc::clone(&host);
        McpToolDefinition {
            name: "read_deck".to_owned(),
            description: concat!(
                "Read the visible presentation: every slide with its elements (ids, types, text, geometry) ",
                "so you can target follow-up edits. Element ids and slide indexes are what apply_slide_ops ",
                "addresses; geometry is document-space EMU (1 px = 9525 EMU on a standard 16:9 deck). ",
                "Slides skipped in slideshows carry hidden:true; slide comments (author, date, text) appear ",
                "under comments when present."
            )
            .to_owned(),
            input_schema: Some(z::shape(vec![("document", document_field())])),
            handler: Box::new(move |args: JsonValue| {
                let document = args.get("document").map(|d| d.into_owned());
                target_step(
                    &host,
                    resolver,
                    SessionFamily::Pptx,
                    document.as_ref(),
                    false,
                    |wc| {
                        ask(
                            "SlidesControl",
                            "readDeck",
                            vec![JsonValue::Number(wc as f64)],
                            ToolStep::Done,
                        )
                    },
                )
            }),
        }
    };

    let apply_slide_ops = {
        let host = Rc::clone(&host);
        McpToolDefinition {
            name: "apply_slide_ops".to_owned(),
            description: concat!(
                "Apply slide editing ops to the visible presentation as one transaction (atomic by default, ",
                "plan-validated with snapshot rollback; per_op isolation skips failures instead). Ops address ",
                "{slide, el} and use document-space EMU. Common ops: setText, setFont, setParagraphFormat, ",
                "addElement (textbox/shapes/lines), addTable, addChart, addBlankSlide, deleteSlide, moveSlide, ",
                "duplicateSlide, deleteElement, setFill, setStroke, setTransform, setBackground, applyTheme, ",
                "findReplace, setTableCell, tableStructure, setTransition, setNotes. A failing atomic batch ",
                "changes nothing \u{2014} fix the op named in the error and resend the whole batch. ",
                "Use read_deck for ids and geometry first."
            )
            .to_owned(),
            input_schema: Some(z::shape(vec![
                (
                    "ops",
                    z::array(z::any())
                        .describe("array of op objects (at most 50 per transaction)")
                        .max(50.0),
                ),
                (
                    "isolation",
                    z::enum_(&["atomic", "per_op"])
                        .optional()
                        .describe("atomic (default) applies all-or-nothing; per_op applies independently"),
                ),
                (
                    "dryRun",
                    z::boolean()
                        .optional()
                        .describe("validate and plan the batch without changing the deck"),
                ),
                ("document", document_field()),
            ])),
            handler: Box::new(move |args: JsonValue| {
                let document = args.get("document").map(|d| d.into_owned());
                target_step(
                    &host,
                    resolver,
                    SessionFamily::Pptx,
                    document.as_ref(),
                    true,
                    move |wc| {
                        let ops = match args.get("ops").as_deref() {
                            Some(JsonValue::Array(ops)) => ops.clone(),
                            _ => Vec::new(),
                        };
                        let isolation = match args.get("isolation").as_deref() {
                            Some(JsonValue::String(text)) if text == "per_op" => {
                                Some(Isolation::PerOp)
                            }
                            Some(JsonValue::String(text)) if text == "atomic" => {
                                Some(Isolation::Atomic)
                            }
                            _ => None,
                        };
                        let dry_run = is_true(&args, "dryRun");
                        let request = SlidesTxnRequest {
                            ops,
                            isolation,
                            dry_run,
                        };
                        ask(
                            "SlidesControl",
                            "runTxn",
                            vec![JsonValue::Number(wc as f64), request.to_json()],
                            move |settled| ToolStep::Done(rejected_or_result(settled, dry_run)),
                        )
                    },
                )
            }),
        }
    };

    vec![read_deck, apply_slide_ops]
}

/// a rejected transaction is a tool-level error so the caller reacts to it;
/// dry-run results (plan + failures) stay a normal response
fn rejected_or_result(
    settled: Result<Option<JsonValue>, String>,
    dry_run: bool,
) -> Result<Option<JsonValue>, String> {
    let result = settled?;
    if let Some(value) = &result
        && value.get("applied").as_deref() == Some(&JsonValue::Bool(false))
        && !dry_run
    {
        let failures = match value.get("failures").as_deref() {
            None | Some(JsonValue::Null) => Vec::new(),
            Some(JsonValue::Array(items)) => items.clone(),
            Some(_) => return Err("(result.failures ?? []).map is not a function".to_owned()),
        };
        let mut lines = Vec::new();
        for failure in &failures {
            if matches!(failure, JsonValue::Null) {
                return Err(read_of_null("index"));
            }
            let index = string_of(failure.get("index").as_deref())?;
            let error = string_of(failure.get("error").as_deref())?;
            lines.push(format!("[{index}] {error}"));
        }
        let details = lines.join("\n");
        return Err(if details.is_empty() {
            "the transaction could not be applied".to_owned()
        } else {
            details
        });
    }
    Ok(result)
}
