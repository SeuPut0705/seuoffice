//! `apps/shell/src/main/mcp/tools/sheets-tools.ts`: the sheets (xlsx) tool
//! surface for the MCP server.
//!
//! Two paths, mirroring the docx/slides tools:
//! - headless `create_xlsx`: a row matrix handed to the bundled `seuoffice` CLI
//!   (`create --type xlsx --from`), gated behind the "background generation"
//!   setting;
//! - a visible grid session: the tools drive a real sheets tab the user
//!   watches. The workbook lives in the renderer, so this needs a
//!   request/response bridge into it (`shell::mcp::sheets_bridge`).
//!
//! Handlers return [`ToolStep`]s. What the TypeScript awaits of the renderer
//! (`SheetsControl.runCommand`, `TargetResolver.resolve`) is an
//! [`ToolStep::Await`] named after the TS interface and method ([`ask`]);
//! the CLI, the path checks and the file system stay direct. The two helpers
//! [`ask`] and [`target_step`] are shared by the slides and diagram tools.
//!
//! The `SheetsControl` interface has no Rust trait: its calls are
//! `HostCall { control: "SheetsControl", method: "openBlankTab" | "runCommand",
//! args }`, answered by the shell over `shell::mcp::sheets_bridge`. The
//! session driver of the family ([`sheets_driver`]) names those two calls:
//! `openBlankTab []` and `runCommand [wc, "save_sheet", { path, overwrite }]`.

use std::rc::Rc;

use jscompat::node_path::host::{basename, extname, is_absolute};
use jscompat::{JsObject, JsonValue, json_stringify, trim};

use super::document_tools::{DefaultSaveDir, OutputPathOptions, resolve_output_path};
use super::formats::SessionFamily;
use super::session_tools::{
    FamilyDriver, ObjectDraft, ResolveOptions, SharedSessionHost, await_host, is_true, js_object,
    resolve_target_call, string_arg, string_of, string_or_empty,
};
use crate::packages::zod::{ZodType, z};
use crate::pdf::generated_output::exists_sync;
use crate::shell::mcp::cli_runner::CliRunner;
use crate::shell::mcp::headless_cli::{
    CreateFileOptions, SheetLinksOptions, create_file_via_cli, sheet_links_via_cli,
};
use crate::shell::mcp::mcp_server::{HostCall, McpToolDefinition, Settled, ToolStep};

/// the commands of `SheetsControl.runCommand`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SheetsCommandName {
    ApplyOps,
    ReadSheet,
    SaveSheet,
}

impl SheetsCommandName {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            SheetsCommandName::ApplyOps => "apply_ops",
            SheetsCommandName::ReadSheet => "read_sheet",
            SheetsCommandName::SaveSheet => "save_sheet",
        }
    }
}

/// `sheetsDriver(sheets)`: the session lifecycle of the family as the shared
/// create_session / save_session tools see it. The calls it names are
/// `SheetsControl.openBlankTab []` and `SheetsControl.runCommand [wc,
/// "save_sheet", { path, overwrite }]`.
struct SheetsDriver;

impl FamilyDriver for SheetsDriver {
    fn family(&self) -> SessionFamily {
        SessionFamily::Xlsx
    }

    fn open_blank_tab(&self) -> HostCall {
        HostCall {
            control: "SheetsControl",
            method: "openBlankTab",
            args: Vec::new(),
        }
    }

    fn save(&self, wc_id: i64, path: &str, overwrite: bool) -> HostCall {
        HostCall {
            control: "SheetsControl",
            method: "runCommand",
            args: vec![
                JsonValue::Number(wc_id as f64),
                JsonValue::String(SheetsCommandName::SaveSheet.as_str().to_owned()),
                js_object(vec![
                    ("path", JsonValue::String(path.to_owned())),
                    ("overwrite", JsonValue::Bool(overwrite)),
                ]),
            ],
        }
    }
}

/// `sheetsDriver(sheets)`
pub fn sheets_driver<'h>() -> Rc<dyn FamilyDriver + 'h> {
    Rc::new(SheetsDriver)
}

/// `SheetsToolDeps`
pub struct SheetsToolDeps<'h> {
    /// directory generated files land in when the caller gives no path
    pub default_save_dir: DefaultSaveDir<'h>,
    /// expose the headless create_xlsx tool; default true (`None`): the shell
    /// passes the user's setting
    pub background: Option<bool>,
    /// a visible-grid control is wired (`SheetsControl`: its calls are awaited
    /// steps); absent in headless/unit runs, which drops the session tools
    pub sheets: bool,
    /// the bundled seuoffice CLI, used by the headless tool
    pub cli: Option<Rc<dyn CliRunner + 'h>>,
    /// a `TargetResolver` is wired: a `document` argument resolves to the
    /// webContents of that open tab
    pub resolve_target: bool,
}

/// `XLSX_EXT`: `.${generateExtension('xlsx')}`, which the registry says is `.xlsx`
const XLSX_EXT: &str = ".xlsx";
/// same ceiling as the built-in AI's read_cells
const MAX_READ_ADDRESSES: usize = 100;

const HEADLESS_UNAVAILABLE: &str = "headless generation is not available in this build";

/// `Array.isArray(value)`, its items
fn items_of(value: Option<JsonValue>) -> Option<Vec<JsonValue>> {
    match value {
        Some(JsonValue::Array(items)) => Some(items),
        _ => None,
    }
}

/// an awaited call of a control, its arguments in the TS order
pub fn ask<'h>(
    control: &'static str,
    method: &'static str,
    args: Vec<JsonValue>,
    then: impl FnOnce(Settled) -> ToolStep<'h> + 'h,
) -> ToolStep<'h> {
    ToolStep::Await {
        call: HostCall {
            control,
            method,
            args,
        },
        then: Box::new(then),
    }
}

/// `contentTarget(host, resolveTarget, family)(document, options)` of the
/// content tools, as steps: where a tool sends its command: the open document
/// the caller named (`TargetResolver.resolve [name, family, options]`, awaited:
/// it may load a restored tab), or the session's own tab when they named none.
/// `focus` is the `{ focus: true }` of a mutating tool.
pub fn target_step<'h>(
    host: &SharedSessionHost,
    resolver: bool,
    family: SessionFamily,
    document: Option<&JsonValue>,
    focus: bool,
    then: impl FnOnce(i64) -> ToolStep<'h> + 'h,
) -> ToolStep<'h> {
    let named = match document {
        Some(JsonValue::String(text)) if !text.is_empty() => text.clone(),
        _ => {
            return match host.borrow().require(family) {
                Ok(wc) => then(wc),
                Err(message) => ToolStep::Done(Err(message)),
            };
        }
    };
    if !resolver {
        return ToolStep::Done(Err(
            "this build cannot target an open document; use create_session and its own tab instead"
                .to_owned(),
        ));
    }
    let options = focus.then_some(ResolveOptions { focus: Some(true) });
    await_host(
        resolve_target_call(&named, family, options),
        move |settled| match settled {
            Ok(Some(JsonValue::Number(wc))) => then(wc as i64),
            Ok(_) => then(0),
            Err(message) => ToolStep::Done(Err(message)),
        },
    )
}

/// the headless tool: a row matrix -> xlsx through the bundled CLI
fn create_headless_xlsx_tool<'h>(deps: Rc<SheetsToolDeps<'h>>) -> McpToolDefinition<'h> {
    McpToolDefinition {
        name: "create_xlsx".to_owned(),
        description: concat!(
            "Create an Excel .xlsx file and save it to disk without opening the app UI. `data` is a 2D ",
            "array of rows; numbers become numeric cells, and a string starting with \"=\" becomes a ",
            "formula (the seuoffice CLI evaluates it and stores the cached value). Returns the absolute ",
            "path of the written file."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![
            ("title", z::string().describe("workbook title, used as the file name")),
            (
                "data",
                z::array(z::array(z::union(vec![
                    z::string(),
                    z::number(),
                    z::boolean(),
                    z::null(),
                ])))
                .describe("rows of cell values; row 0 becomes spreadsheet row 1"),
            ),
            (
                "sheetName",
                z::string().optional().describe("name of the single sheet; default Sheet1"),
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
                let Some(data) = items_of(args.get("data").map(|data| data.into_owned())) else {
                    return Err("data must be a 2D array of rows".to_owned());
                };
                if data.iter().any(|row| !matches!(row, JsonValue::Array(_))) {
                    return Err("data must be a 2D array of rows".to_owned());
                }
                let Some(cli) = &deps.cli else {
                    return Err(HEADLESS_UNAVAILABLE.to_owned());
                };
                let sheet_name = match string_arg(&args, "sheetName") {
                    Some(name) if !trim(&name).is_empty() => trim(&name).to_owned(),
                    _ => "Sheet1".to_owned(),
                };

                let target_path = resolve_output_path(&OutputPathOptions {
                    default_save_dir: &*deps.default_save_dir,
                    ext: XLSX_EXT,
                    title,
                    requested_path: string_arg(&args, "path").as_deref(),
                    overwrite: is_true(&args, "overwrite"),
                })?;

                let mut rows = Vec::new();
                for row in &data {
                    let JsonValue::Array(cells) = row else {
                        continue;
                    };
                    let mut out = Vec::new();
                    for cell in cells {
                        out.push(match cell {
                            JsonValue::Null => JsonValue::String(String::new()),
                            JsonValue::Number(number) if number.is_finite() => {
                                JsonValue::Number(*number)
                            }
                            JsonValue::Number(_) => JsonValue::String(String::new()),
                            other => JsonValue::String(string_of(Some(other))?),
                        });
                    }
                    rows.push(JsonValue::Array(out));
                }
                let table = js_object(vec![(
                    "sheets",
                    JsonValue::Array(vec![js_object(vec![
                        ("name", JsonValue::String(sheet_name)),
                        ("rows", JsonValue::Array(rows)),
                    ])]),
                )]);
                let created = create_file_via_cli(
                    &**cli,
                    &CreateFileOptions {
                        file_type: "xlsx",
                        input_name: "table.json",
                        input_content: &json_stringify(&table),
                        out: &target_path,
                        overwrite: is_true(&args, "overwrite"),
                    },
                )?;
                let mut out = ObjectDraft::new();
                out.set("path", Some(created.output_path));
                out.set("summary", created.summary);
                Ok(Some(out.finish()))
            })())
        }),
    }
}

/// Headless external-link maintenance through the bundled CLI (`sheet links`):
/// list is a read and stays available with background generation off; refresh
/// and break write the workbook, so they demand the same opt-in as create_xlsx.
///
/// The sources are paths the workbook chose, and an agent runs this on files it
/// was handed: a source on another computer is never contacted, so the CLI's
/// `--remote-sources` is deliberately not offered here.
fn create_sheet_links_tool<'h>(deps: Rc<SheetsToolDeps<'h>>) -> McpToolDefinition<'h> {
    McpToolDefinition {
        name: "sheet_links".to_owned(),
        description: concat!(
            "Inspect and maintain an Excel workbook's external links (formulas referencing another ",
            ".xlsx file) without opening the app. Default action lists every link with its index, ",
            "resolved source path and reachability. `update: true` re-reads reachable sources and ",
            "writes the computed values as the formulas' cached values (formulas untouched). A ",
            "source on another computer (\\\\host\\share, file://host) is never contacted: it lists ",
            "as `reachable: null` and keeps its cached values. `break` severs the chosen 1-based ",
            "links \u{2014} their formulas keep their current cached values as literals and the surviving ",
            "links renumber."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![
            ("path", z::string().describe("absolute path to the .xlsx file")),
            (
                "update",
                z::boolean()
                    .optional()
                    .describe("refresh the formulas\u{2019} cached values from the reachable sources"),
            ),
            (
                "break",
                z::array(z::number().int().min(1.0)).optional().describe(
                    "1-based link indices (from this tool\u{2019}s list) to break; formulas become literals",
                ),
            ),
            (
                "out",
                z::string()
                    .optional()
                    .describe("absolute .xlsx path to write the refreshed/broken copy to instead of in place"),
            ),
            (
                "overwrite",
                z::boolean()
                    .optional()
                    .describe("allow replacing an existing file at `out`"),
            ),
        ])),
        handler: Box::new(move |args: JsonValue| {
            ToolStep::Done((|| -> Result<Option<JsonValue>, String> {
                let file_path = string_or_empty(&args, "path")?;
                if !is_absolute(&file_path) {
                    return Err("path must be absolute".to_owned());
                }
                if extname(&file_path).to_lowercase() != XLSX_EXT {
                    return Err("path must point to an .xlsx file".to_owned());
                }
                if !exists_sync(&file_path) {
                    return Err(format!("file not found: {file_path}"));
                }
                let Some(cli) = &deps.cli else {
                    return Err("external-link tools are not available in this build".to_owned());
                };
                let break_items = items_of(args.get("break").map(|items| items.into_owned()));
                // `as number[]`: an item that is no number has no place in the
                // `&[f64]` of the headless CLI port, and reads as NaN
                let break_indices: Option<Vec<f64>> = break_items.map(|items| {
                    items
                        .iter()
                        .map(|item| match item {
                            JsonValue::Number(number) => *number,
                            _ => f64::NAN,
                        })
                        .collect()
                });
                let update = is_true(&args, "update");
                if update && break_indices.is_some() {
                    return Err(
                        "update and break cannot combine: an update re-reads the sources, a break severs them"
                            .to_owned(),
                    );
                }
                let writes = update || break_indices.is_some();
                // writing the workbook headlessly is opt-in, same rule as create_xlsx
                if writes && deps.background == Some(false) {
                    return Err(
                        "refreshing or breaking links is disabled: headless file writes are off in MCP settings"
                            .to_owned(),
                    );
                }
                // `out` is a file this tool creates, so it obeys the rules of the other
                // generating tools: absolute, a workbook, no silent replacement
                let out = match string_arg(&args, "out") {
                    Some(requested) if writes && !requested.is_empty() => {
                        let ext = extname(&file_path);
                        Some(resolve_output_path(&OutputPathOptions {
                            default_save_dir: &*deps.default_save_dir,
                            ext: XLSX_EXT,
                            title: &basename(&file_path, Some(&ext)),
                            requested_path: Some(&requested),
                            overwrite: is_true(&args, "overwrite"),
                        })?)
                    }
                    _ => None,
                };
                let json = sheet_links_via_cli(
                    &**cli,
                    &SheetLinksOptions {
                        path: &file_path,
                        update,
                        break_indices: break_indices.as_deref(),
                        out: out.as_deref(),
                        overwrite: is_true(&args, "overwrite"),
                    },
                )?;
                let mut result = ObjectDraft::new();
                result.set("path", Some(JsonValue::String(file_path.clone())));
                result.set("name", Some(JsonValue::String(basename(&file_path, None))));
                result.set(
                    "summary",
                    json.get("summary").map(|summary| summary.into_owned()),
                );
                if let Some(detail) = json.get("detail") {
                    result.spread(&detail);
                }
                Ok(Some(result.finish()))
            })())
        }),
    }
}

/// `createSheetsTools(deps, host)`: headless generation is opt-in, same rule as
/// create_docx/create_pptx
pub fn create_sheets_tools<'h>(
    deps: Rc<SheetsToolDeps<'h>>,
    host: SharedSessionHost,
) -> Vec<McpToolDefinition<'h>> {
    let mut tools = Vec::new();
    if deps.background != Some(false) {
        tools.push(create_headless_xlsx_tool(Rc::clone(&deps)));
    }
    tools.push(create_sheet_links_tool(Rc::clone(&deps)));
    tools.extend(create_grid_content_tools(&deps, host));
    tools
}

/// the `document` field of every content tool
fn document_field() -> ZodType {
    z::string().optional().describe(concat!(
        "tab id or path of an open spreadsheet to edit instead of the session's own tab ",
        "(from open_documents {action:\"list\"}); the edit lands in that live document, and a ",
        "mutating tool switches the UI to that tab first so the user sees it happen"
    ))
}

/// `SheetsControl.runCommand(wc, command, payload)` as the awaited call
fn run_command<'h>(
    wc: i64,
    command: SheetsCommandName,
    payload: JsonValue,
    then: impl FnOnce(Settled) -> ToolStep<'h> + 'h,
) -> ToolStep<'h> {
    ask(
        "SheetsControl",
        "runCommand",
        vec![
            JsonValue::Number(wc as f64),
            JsonValue::String(command.as_str().to_owned()),
            payload,
        ],
        then,
    )
}

/// Visible-grid content tools: fill the spreadsheet the shared session opened,
/// so the user watches the grid take shape. The ops are the same zod-validated
/// workbook DSL the built-in AI uses, executed by the tab's renderer.
///
/// Only registered when the shell wired a SheetsControl: headless/unit runs
/// keep the file-only surface.
fn create_grid_content_tools<'h>(
    deps: &Rc<SheetsToolDeps<'h>>,
    host: SharedSessionHost,
) -> Vec<McpToolDefinition<'h>> {
    if !deps.sheets {
        return Vec::new();
    }
    let resolver = deps.resolve_target;

    let read_sheet = {
        let host = Rc::clone(&host);
        McpToolDefinition {
            name: "read_sheet".to_owned(),
            description: concat!(
                "Read the visible workbook: sheet names with data extents, and optionally the current ",
                "values/formulas of specific cells. Address a worksheet by NAME (the CLI convention, and ",
                "stable across sessions) or by the sheetId the overview reports."
            )
            .to_owned(),
            input_schema: Some(z::shape(vec![
                (
                    "addresses",
                    z::array(z::string()).optional().describe(
                        "A1 addresses to read (values + formulas, at most 100 per call); omit to get the workbook overview only",
                    ),
                ),
                (
                    "sheet",
                    z::string()
                        .optional()
                        .describe("worksheet name to read from; default is the active sheet"),
                ),
                (
                    "sheetId",
                    z::string().optional().describe(
                        "worksheet id (from a previous overview) as an alternative to `sheet`; a name is preferred",
                    ),
                ),
                ("document", document_field()),
            ])),
            handler: Box::new(move |args: JsonValue| {
                let document = args.get("document").map(|d| d.into_owned());
                target_step(
                    &host,
                    resolver,
                    SessionFamily::Xlsx,
                    document.as_ref(),
                    false,
                    move |wc| {
                        let addresses =
                            items_of(args.get("addresses").map(|items| items.into_owned()));
                        if let Some(addresses) = &addresses
                            && addresses.len() > MAX_READ_ADDRESSES
                        {
                            return ToolStep::Done(Err(format!(
                                "read at most {MAX_READ_ADDRESSES} addresses per call"
                            )));
                        }
                        let mut payload = JsObject::new();
                        if let Some(addresses) = &addresses {
                            let mut strings = Vec::new();
                            for address in addresses {
                                match string_of(Some(address)) {
                                    Ok(text) => strings.push(JsonValue::String(text)),
                                    Err(message) => return ToolStep::Done(Err(message)),
                                }
                            }
                            payload.set("addresses", JsonValue::Array(strings));
                        }
                        if let Some(sheet) = string_arg(&args, "sheet") {
                            payload.set("sheet", JsonValue::String(sheet));
                        }
                        if let Some(sheet_id) = string_arg(&args, "sheetId") {
                            payload.set("sheetId", JsonValue::String(sheet_id));
                        }
                        run_command(
                            wc,
                            SheetsCommandName::ReadSheet,
                            JsonValue::Object(payload),
                            ToolStep::Done,
                        )
                    },
                )
            }),
        }
    };

    let apply_sheet_ops = {
        let host = Rc::clone(&host);
        McpToolDefinition {
            name: "apply_sheet_ops".to_owned(),
            description: concat!(
                "Apply workbook DSL operations to the visible spreadsheet (the same vocabulary the CLI ",
                "and the built-in AI use). Common ops: set_cell, set_formula, clear_cell, set_range, ",
                "clear_range, fill_range, copy_range, move_range, convert_to_values, insert_rows, delete_rows, ",
                "insert_cols, delete_cols, add_sheet, delete_sheet, add_chart, add_table, set_filter, ",
                "set_hyperlink, add_conditional_format, set_data_validation, set_note. Address a worksheet ",
                "by NAME with `sheet` (also `sourceSheet`/`targetSheet`) \u{2014} the CLI's stable vocabulary \u{2014} ",
                "or with `sheetId` from read_sheet; a name that is not in the workbook is rejected before ",
                "anything applies. The target sheet is brought into view so the user sees the edit. ",
                "Addresses are A1. One batch applies as one undo step; a failed batch changes nothing."
            )
            .to_owned(),
            input_schema: Some(z::shape(vec![
                (
                    "ops",
                    z::array(z::any()).describe(
                        "array of workbook DSL op objects; each op addresses its worksheet with sheet (a name) or sheetId",
                    ),
                ),
                (
                    "dryRun",
                    z::boolean()
                        .optional()
                        .describe("plan the batch and report what would change, without modifying the grid"),
                ),
                ("document", document_field()),
            ])),
            handler: Box::new(move |args: JsonValue| {
                let document = args.get("document").map(|d| d.into_owned());
                target_step(
                    &host,
                    resolver,
                    SessionFamily::Xlsx,
                    document.as_ref(),
                    true,
                    move |wc| {
                        let Some(ops) = items_of(args.get("ops").map(|ops| ops.into_owned()))
                        else {
                            return ToolStep::Done(Err("ops must be an array".to_owned()));
                        };
                        let payload = js_object(vec![
                            ("ops", JsonValue::Array(ops)),
                            ("dryRun", JsonValue::Bool(is_true(&args, "dryRun"))),
                        ]);
                        run_command(wc, SheetsCommandName::ApplyOps, payload, |settled| {
                            let result = match settled {
                                Ok(result) => result,
                                Err(message) => return ToolStep::Done(Err(message)),
                            };
                            // a rejected batch is a tool-level error so the caller reacts to it
                            if let Some(result) = &result
                                && result.get("ok").as_deref() == Some(&JsonValue::Bool(false))
                            {
                                return ToolStep::Done(match result.get("reason").as_deref() {
                                    None | Some(JsonValue::Null) => {
                                        Err("the batch could not be applied".to_owned())
                                    }
                                    reason => string_of(reason).and_then(Err),
                                });
                            }
                            ToolStep::Done(Ok(result))
                        })
                    },
                )
            }),
        }
    };

    vec![read_sheet, apply_sheet_ops]
}
