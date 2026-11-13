//! `apps/shell/src/main/mcp/tools/document-tools.ts`: the docx MCP tool
//! surface.
//!
//! Headless generation and reading (`create_docx`, `read_docx`) delegate to the
//! bundled `seuoffice` CLI, the same engines the app ships, instead of
//! reimplementing conversion here (see `headless_cli`, `cli_runner`). The
//! visible document session is the part the CLI cannot do: driving the editor
//! tab the user has open. Dependencies are injected ([`DocToolDeps`]), so the
//! module is free of Electron.
//!
//! Public for the other tool modules and the later waves:
//! [`sanitize_file_base`], [`unique_path_in`], [`resolve_output_path`] (the
//! shared output-path policy of every generating tool), [`resolve_target_path`],
//! [`create_document_tools`], [`document_driver`] and the two host calls of
//! the shell's docs bridge ([`docs_open_blank_call`], [`docs_run_call`]).

use std::rc::Rc;

use jscompat::node_path::host::{basename, extname, is_absolute, join};
use jscompat::{JsonValue, js_regex, slice_utf16, trim};

use super::formats::{SessionFamily, capability_report};
use super::session_tools::{
    FamilyDriver, ObjectDraft, ResolveOptions, SharedSessionHost, content_target, is_true,
    js_object, string_arg, string_or_empty, sync_handler, with_target,
};
use crate::packages::i18n::PRODUCT_NAME;
use crate::packages::zod::{ZodType, z};
use crate::pdf::generated_output::exists_sync;
use crate::shell::mcp::cli_runner::CliRunner;
use crate::shell::mcp::headless_cli::{
    ConvertOptions, CreateFileOptions, MergeOptions, convert_via_cli, create_file_via_cli,
    docs_check_via_cli, merge_template_via_cli, read_docx_properties_via_cli,
    read_docx_text_via_cli,
};
use crate::shell::mcp::mcp_server::{HostCall, McpToolDefinition, ToolStep};

/// `McpEditorCommandName`: editor commands the docs renderer bridge
/// understands (see docs shared/ipc.ts)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpEditorCommandName {
    InsertContent,
    ReplaceBlocks,
    ApplyOps,
    InsertPicture,
    ReadDocument,
    SaveDocument,
}

impl McpEditorCommandName {
    /// the TypeScript's string
    pub fn as_str(self) -> &'static str {
        match self {
            McpEditorCommandName::InsertContent => "insert_content",
            McpEditorCommandName::ReplaceBlocks => "replace_blocks",
            McpEditorCommandName::ApplyOps => "apply_ops",
            McpEditorCommandName::InsertPicture => "insert_picture",
            McpEditorCommandName::ReadDocument => "read_document",
            McpEditorCommandName::SaveDocument => "save_document",
        }
    }
}

/// `DocsControl`: visible-editor control. Opens a docs tab and pushes editor
/// commands into it, so an external agent builds and edits a document the user
/// can watch instead of writing bytes behind the UI. Implemented in the shell
/// main process over `shell::mcp::docs_bridge`. Both calls wait for the docs
/// renderer, so on the one core thread they are steps: the tools suspend on
/// the [`HostCall`]s these two functions name and the host answers them
/// through the bridge (`Err` is the message of what it throws; a command's
/// result is what the renderer answered, `None` being `undefined`).
///
/// `DocsControl.openBlankTab()`: open a fresh blank docs tab; answered with
/// its webContents id as a number.
pub fn docs_open_blank_call() -> HostCall {
    HostCall {
        control: "DocsControl",
        method: "openBlankTab",
        args: Vec::new(),
    }
}

/// `DocsControl.runCommand(wcId, command, payload)`: run one editor command in
/// that tab and answer its result
pub fn docs_run_call(wc_id: i64, command: McpEditorCommandName, payload: JsonValue) -> HostCall {
    HostCall {
        control: "DocsControl",
        method: "runCommand",
        args: vec![
            JsonValue::Number(wc_id as f64),
            JsonValue::String(command.as_str().to_owned()),
            payload,
        ],
    }
}

/// `DocToolDeps.defaultSaveDir`: directory generated files land in when the
/// caller gives no path
pub type DefaultSaveDir<'h> = Rc<dyn Fn() -> String + 'h>;

/// `DocToolDeps.openInTab`: open a file in the SeuOffice UI
pub type OpenInTab<'h> = Rc<dyn Fn(&str) -> Result<(), String> + 'h>;

/// `DocToolDeps`
pub struct DocToolDeps<'h> {
    pub version: String,
    pub default_save_dir: DefaultSaveDir<'h>,
    /// expose the headless create_docx tool (generation without opening the UI);
    /// default true (`None`): the shell passes the user's "background
    /// generation" setting
    pub background: Option<bool>,
    /// open a file in the SeuOffice UI (optional in tests)
    pub open_in_tab: Option<OpenInTab<'h>>,
    /// whether the shell wired the visible-editor control (`DocsControl`) for
    /// the MCP-driven document session (optional in tests)
    pub docs: bool,
    /// extra formats other tool families can generate (reported by get_app_info)
    pub extra_formats: Option<Vec<String>>,
    /// the bundled seuoffice CLI, used by the headless tools
    pub cli: Option<Rc<dyn CliRunner + 'h>>,
    /// whether the shell wired a `TargetResolver`, which resolves a
    /// caller-supplied document reference (tab id or path) to the webContents
    /// of that open tab, so the content tools can edit a document the *user*
    /// has open rather than only the session's own blank one. Absent in
    /// headless/unit runs, where a `document` argument is refused. The
    /// resolution is a host call ([`super::session_tools::resolve_target_call`]).
    pub resolve_target: bool,
}

/// `DOCX_EXT`: `.${generateExtension('docx')}`, which the registry says is
/// `.docx`
const DOCX_EXT: &str = ".docx";

/// `READABLE_WORD_EXTS`: read_docx and check_document go through the CLI's
/// `docs read` / `docs check`, which open .odt the same way
const READABLE_WORD_EXTS: [&str; 2] = [DOCX_EXT, ".odt"];

/// `sanitizeFileBase(title)`: sanitize a title into a file base name (mirrors
/// docs' sanitizeAiDocFileBase)
pub fn sanitize_file_base(title: &str) -> String {
    // control characters are rejected on purpose
    let cleaned =
        js_regex!(r#"[/\\:*?"<>|\u0000-\u001f]"#, "g").replace_all(title, |_| "_".to_owned());
    let cleaned = slice_utf16(trim(&cleaned), 0.0, Some(80.0));
    let cleaned = js_regex!(r"^\.+|\.+$", "g").replace_all(trim(&cleaned), |_| String::new());
    let cleaned = trim(&cleaned);
    if !cleaned.is_empty() && cleaned != "." && cleaned != ".." {
        cleaned.to_owned()
    } else {
        "Untitled".to_owned()
    }
}

/// `uniquePathIn(dir, fileName)`: first free path for fileName inside dir:
/// name.docx, name-2.docx, ...
pub fn unique_path_in(dir: &str, file_name: &str) -> String {
    let ext = extname(file_name);
    let base = &file_name[..file_name.len() - ext.len()];
    let mut candidate = join(&[dir, file_name]);
    let mut i = 2;
    while exists_sync(&candidate) {
        candidate = join(&[dir, &format!("{base}-{i}{ext}")]);
        i += 1;
    }
    candidate
}

/// `opts` of `resolveOutputPath`
pub struct OutputPathOptions<'a> {
    pub default_save_dir: &'a dyn Fn() -> String,
    pub ext: &'a str,
    pub title: &'a str,
    pub requested_path: Option<&'a str>,
    pub overwrite: bool,
}

/// `resolveOutputPath(opts)`: the shared output-path policy for every
/// generating tool: sanitize the title into a file base name, land in the
/// default save folder when no path is given, require absolute paths
/// otherwise, append the extension when missing, and refuse to clobber an
/// existing file unless overwrite is set.
///
/// A path that already carries a *different* extension is rejected rather
/// than having the right one appended: `report.pdf` silently becoming
/// `report.pdf.docx` would write a file the caller never asked for (and hide a
/// confused request behind a valid result).
pub fn resolve_output_path(opts: &OutputPathOptions<'_>) -> Result<String, String> {
    let ext = if opts.ext.starts_with('.') {
        opts.ext.to_owned()
    } else {
        format!(".{}", opts.ext)
    };
    let file_name = format!("{}{ext}", sanitize_file_base(opts.title));
    let requested = match opts.requested_path {
        Some(path) if !path.is_empty() => path,
        _ => return Ok(unique_path_in(&(opts.default_save_dir)(), &file_name)),
    };

    if !is_absolute(requested) {
        return Err("path must be absolute".to_owned());
    }
    let requested_ext = extname(requested);
    if !requested_ext.is_empty() && requested_ext.to_lowercase() != ext {
        return Err(format!(
            "path must point to a {ext} file (got \"{requested_ext}\")"
        ));
    }
    let final_path = if requested_ext.is_empty() {
        format!("{requested}{ext}")
    } else {
        requested.to_owned()
    };
    if exists_sync(&final_path) && !opts.overwrite {
        return Err(format!(
            "file already exists: {final_path} (pass overwrite:true to replace it)"
        ));
    }
    Ok(final_path)
}

/// `resolveTargetPath(deps, title, requestedPath, overwrite)` (`__internal` of
/// the TypeScript)
pub fn resolve_target_path(
    deps: &DocToolDeps<'_>,
    title: &str,
    requested_path: Option<&str>,
    overwrite: bool,
) -> Result<String, String> {
    resolve_output_path(&OutputPathOptions {
        default_save_dir: &*deps.default_save_dir,
        ext: DOCX_EXT,
        title,
        requested_path,
        overwrite,
    })
}

const HEADLESS_UNAVAILABLE: &str = "headless generation is not available in this build";

/// `{ path: json.output_path ?? fallback, summary: json.summary, ...detail }`
/// over the `ok` JSON of the CLI; `detail` is `json.detail ?? {}`
fn path_summary_detail(json: &JsonValue, fallback: &str) -> JsonValue {
    let mut out = ObjectDraft::new();
    out.set(
        "path",
        Some(match json.get("output_path").as_deref() {
            None | Some(JsonValue::Null) => JsonValue::String(fallback.to_owned()),
            Some(path) => path.clone(),
        }),
    );
    out.set(
        "summary",
        json.get("summary").map(|summary| summary.into_owned()),
    );
    if let Some(detail) = json.get("detail") {
        out.spread(&detail);
    }
    out.finish()
}

/// the headless tool: markdown/restricted-HTML -> docx, delegated to the bundled CLI
fn create_headless_docx_tool<'h>(deps: Rc<DocToolDeps<'h>>) -> McpToolDefinition<'h> {
    McpToolDefinition {
        name: "create_docx".to_owned(),
        description: concat!(
            "Create a Word .docx file from content and save it to disk without opening the app UI. ",
            "Content is Markdown (headings, lists, bold/italic, links, code blocks, tables) or a ",
            "restricted-HTML fragment (format:\"html\"), converted by the same docx engine the app and ",
            "the seuoffice CLI use. Returns the absolute path of the written file."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![
            ("title", z::string().describe("document title, used as the file name")),
            (
                "content",
                z::string().describe("Markdown source (default) or a restricted-HTML fragment"),
            ),
            (
                "format",
                z::enum_(&["markdown", "html"])
                    .optional()
                    .describe("content format; default markdown"),
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
        handler: sync_handler(move |args: JsonValue| {
            let title = string_or_empty(&args, "title")?;
            let title = trim(&title);
            if title.is_empty() {
                return Err("title must not be empty".to_owned());
            }
            let Some(cli) = &deps.cli else {
                return Err(HEADLESS_UNAVAILABLE.to_owned());
            };

            let html = matches!(args.get("format").as_deref(), Some(JsonValue::String(f)) if f == "html");
            let target_path = resolve_target_path(
                &deps,
                title,
                string_arg(&args, "path").as_deref(),
                is_true(&args, "overwrite"),
            )?;
            let content = string_or_empty(&args, "content")?;
            let created = create_file_via_cli(
                &**cli,
                &CreateFileOptions {
                    file_type: "docx",
                    input_name: if html { "content.html" } else { "content.md" },
                    input_content: &content,
                    out: &target_path,
                    overwrite: is_true(&args, "overwrite"),
                },
            )?;
            let mut out = ObjectDraft::new();
            out.set("path", Some(created.output_path));
            out.set("summary", created.summary);
            Ok(Some(out.finish()))
        }),
    }
}

/// Headless template fill through the bundled CLI's `merge` command: one record
/// of `{{key}}` placeholders into a .docx/.pptx/.xlsx template, written to disk.
/// It writes a file, so it rides the same opt-in as create_docx/create_xlsx.
fn create_fill_template_tool<'h>(deps: Rc<DocToolDeps<'h>>) -> McpToolDefinition<'h> {
    McpToolDefinition {
        name: "fill_template".to_owned(),
        description: concat!(
            "Fill {{key}} placeholders in a .docx, .pptx or .xlsx template with values and write the ",
            "result to disk without opening the app (a one-record mail merge; loop the tool for a ",
            "batch). Nested keys flatten to dotted paths (a.b); arrays are not expanded. Returns the ",
            "fill report: how many placeholders were filled, which had no value, and which data keys ",
            "went unused."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![
            (
                "template",
                z::string().describe("absolute path to the .docx, .pptx or .xlsx template"),
            ),
            (
                "data",
                z::record(z::string(), z::unknown())
                    .describe("the values: an object whose keys are the {{key}} names"),
            ),
            (
                "path",
                z::string().optional().describe(
                    "absolute output path; default is a new file named after the template in the default save folder",
                ),
            ),
            (
                "overwrite",
                z::boolean()
                    .optional()
                    .describe("allow replacing an existing file at `path`; default false"),
            ),
            (
                "strict",
                z::boolean()
                    .optional()
                    .describe("fail instead of writing when a placeholder has no value; default false"),
            ),
        ])),
        handler: sync_handler(move |args: JsonValue| {
            let template_path = string_or_empty(&args, "template")?;
            if !is_absolute(&template_path) {
                return Err("template must be an absolute path".to_owned());
            }
            let template_ext = extname(&template_path).to_lowercase();
            if !([".docx", ".pptx", ".xlsx"].contains(&template_ext.as_str())) {
                return Err("template must point to a .docx, .pptx or .xlsx file".to_owned());
            }
            if !exists_sync(&template_path) {
                return Err(format!("file not found: {template_path}"));
            }
            let Some(cli) = &deps.cli else {
                return Err(HEADLESS_UNAVAILABLE.to_owned());
            };

            let stem = basename(&template_path, Some(extname(&template_path).as_str()));
            let target_path = resolve_output_path(&OutputPathOptions {
                default_save_dir: &*deps.default_save_dir,
                ext: &template_ext,
                title: &stem,
                requested_path: string_arg(&args, "path").as_deref(),
                overwrite: is_true(&args, "overwrite"),
            })?;
            let data = args.get("data");
            let json = merge_template_via_cli(
                &**cli,
                &MergeOptions {
                    template_path: &template_path,
                    data: data.as_deref(),
                    out: &target_path,
                    overwrite: is_true(&args, "overwrite"),
                    strict: is_true(&args, "strict"),
                },
            )?;
            Ok(Some(path_summary_detail(&json, &target_path)))
        }),
    }
}

/// Headless document conversion through the bundled CLI's `convert` command:
/// one file, one target format, written to disk. Rides the same opt-in as the
/// other file-writing tools (create_docx, fill_template). The route table lives
/// in the CLI: an unsupported pair errors with `detail.supported` naming every
/// target the source format can reach, so the tool does not duplicate it.
fn create_convert_document_tool<'h>(deps: Rc<DocToolDeps<'h>>) -> McpToolDefinition<'h> {
    McpToolDefinition {
        name: "convert_document".to_owned(),
        description: concat!(
            "Convert a document to another format with the SeuOffice engines and write the result to ",
            "disk: pdf → docx/pptx/xlsx/md/epub, legacy .doc/.ppt → Open XML, odt ↔ docx (odt → ",
            "pdf/md/html too), xlsx ↔ ods, hwp/hwpx ↔ docx, md → docx/html, docx → md, xlsx → csv, ",
            "draw.io diagram → png/svg/pdf. ",
            "An unsupported pair is refused with the list of targets the source format supports. ",
            "Returns the absolute path of the written file and which engine ran."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![
            ("path", z::string().describe("absolute path to the source document")),
            (
                "to",
                z::string().describe(
                    "target format extension, e.g. \"docx\", \"pptx\", \"xlsx\", \"md\", \"html\", \"csv\", \"odt\", \"hwpx\" or \"pdf\"",
                ),
            ),
            (
                "out",
                z::string().optional().describe(
                    "absolute output path; default is a new file named after the source in the default save folder",
                ),
            ),
            (
                "overwrite",
                z::boolean()
                    .optional()
                    .describe("allow replacing an existing file; default false"),
            ),
            (
                "password",
                z::string()
                    .optional()
                    .describe("password when the source is an encrypted PDF"),
            ),
            (
                "sheet",
                z::string()
                    .optional()
                    .describe("xlsx → csv: the worksheet to export (default: the active one)"),
            ),
        ])),
        handler: sync_handler(move |args: JsonValue| {
            let source_path = string_or_empty(&args, "path")?;
            if !is_absolute(&source_path) {
                return Err("path must be absolute".to_owned());
            }
            let to = string_or_empty(&args, "to")?;
            let to = trim(&to).to_lowercase();
            if !js_regex!(r"^[a-z0-9]+$").test(&to) {
                return Err("to must be a format extension like \"docx\"".to_owned());
            }
            if !exists_sync(&source_path) {
                return Err(format!("file not found: {source_path}"));
            }
            let Some(cli) = &deps.cli else {
                return Err(HEADLESS_UNAVAILABLE.to_owned());
            };

            // default output: the source's stem in the save folder, target extension
            let stem = basename(&source_path, Some(extname(&source_path).as_str()));
            let out = string_arg(&args, "out").filter(|out| !trim(out).is_empty());
            let target_path = resolve_output_path(&OutputPathOptions {
                default_save_dir: &*deps.default_save_dir,
                ext: &format!(".{to}"),
                title: &stem,
                requested_path: out.as_deref(),
                overwrite: is_true(&args, "overwrite"),
            })?;
            let password = string_arg(&args, "password").filter(|text| !text.is_empty());
            let sheet = string_arg(&args, "sheet").filter(|text| !text.is_empty());
            let json = convert_via_cli(
                &**cli,
                &ConvertOptions {
                    path: &source_path,
                    to: &to,
                    out: Some(&target_path),
                    overwrite: is_true(&args, "overwrite"),
                    password: password.as_deref(),
                    sheet: sheet.as_deref(),
                },
            )?;
            Ok(Some(path_summary_detail(&json, &target_path)))
        }),
    }
}

/// `docs check`, read-only: the document-quality report an agent wants before
/// handing a file over: fields without results, broken references, a stale
/// TOC, missing images, empty charts or headings, level skips, leftover
/// placeholder text, pending tracked changes and open comments. No file is
/// written, so like read_docx it is always registered.
fn create_check_document_tool<'h>(deps: Rc<DocToolDeps<'h>>) -> McpToolDefinition<'h> {
    McpToolDefinition {
        name: "check_document".to_owned(),
        description: concat!(
            "Run the document-quality checks on a .docx or .odt without changing it: fields without results, ",
            "references to missing bookmarks, a TOC that no longer matches the headings, missing ",
            "images, empty charts, empty headings, list level skips, leftover placeholder text, ",
            "pending tracked changes and open comments. Each finding carries its severity and ",
            "location; an issue-free document says so explicitly."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![(
            "path",
            z::string().describe("absolute path to a .docx or .odt file"),
        )])),
        handler: sync_handler(move |args: JsonValue| {
            let file_path = string_or_empty(&args, "path")?;
            if !is_absolute(&file_path) {
                return Err("path must be absolute".to_owned());
            }
            if !READABLE_WORD_EXTS.contains(&extname(&file_path).to_lowercase().as_str()) {
                return Err("path must point to a .docx or .odt file".to_owned());
            }
            if !exists_sync(&file_path) {
                return Err(format!("file not found: {file_path}"));
            }
            let Some(cli) = &deps.cli else {
                return Err(HEADLESS_UNAVAILABLE.to_owned());
            };
            let json = docs_check_via_cli(&**cli, &file_path)?;
            let mut out = ObjectDraft::new();
            out.set("summary", json.get("summary").map(|summary| summary.into_owned()));
            if let Some(detail) = json.get("detail") {
                out.spread(&detail);
            }
            Ok(Some(out.finish()))
        }),
    }
}

fn read_docx_tool<'h>(deps: Rc<DocToolDeps<'h>>) -> McpToolDefinition<'h> {
    McpToolDefinition {
        name: "read_docx".to_owned(),
        description:
            "Read a Word .docx or OpenDocument .odt file and return its visible text (one paragraph per line)."
                .to_owned(),
        input_schema: Some(z::shape(vec![(
            "path",
            z::string().describe("absolute path to a .docx or .odt file"),
        )])),
        handler: sync_handler(move |args: JsonValue| {
            let file_path = string_or_empty(&args, "path")?;
            if !is_absolute(&file_path) {
                return Err("path must be absolute".to_owned());
            }
            if !READABLE_WORD_EXTS.contains(&extname(&file_path).to_lowercase().as_str()) {
                return Err("path must point to a .docx or .odt file".to_owned());
            }
            if !exists_sync(&file_path) {
                return Err(format!("file not found: {file_path}"));
            }
            let Some(cli) = &deps.cli else {
                return Err("reading .docx is not available in this build".to_owned());
            };
            let text = read_docx_text_via_cli(&**cli, &file_path)?;
            Ok(Some(js_object(vec![
                ("path", JsonValue::String(file_path.clone())),
                ("name", JsonValue::String(basename(&file_path, None))),
                ("text", JsonValue::String(text)),
            ])))
        }),
    }
}

fn read_docx_properties_tool<'h>(deps: Rc<DocToolDeps<'h>>) -> McpToolDefinition<'h> {
    McpToolDefinition {
        name: "read_docx_properties".to_owned(),
        description: concat!(
            "Read a Word .docx file's document properties: core (title, author, dates), app and ",
            "custom properties, as stored in the file."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![(
            "path",
            z::string().describe("absolute path to a .docx file"),
        )])),
        handler: sync_handler(move |args: JsonValue| {
            let file_path = string_or_empty(&args, "path")?;
            if !is_absolute(&file_path) {
                return Err("path must be absolute".to_owned());
            }
            if extname(&file_path).to_lowercase() != DOCX_EXT {
                return Err("path must point to a .docx file".to_owned());
            }
            if !exists_sync(&file_path) {
                return Err(format!("file not found: {file_path}"));
            }
            let Some(cli) = &deps.cli else {
                return Err("reading .docx is not available in this build".to_owned());
            };
            let properties = read_docx_properties_via_cli(&**cli, &file_path)?;
            Ok(Some(js_object(vec![
                ("path", JsonValue::String(file_path.clone())),
                ("name", JsonValue::String(basename(&file_path, None))),
                ("properties", properties),
            ])))
        }),
    }
}

fn open_in_seuoffice_tool<'h>(deps: Rc<DocToolDeps<'h>>) -> McpToolDefinition<'h> {
    McpToolDefinition {
        name: "open_in_seuoffice".to_owned(),
        description: "Open an existing file in the running SeuOffice app, focusing its tab."
            .to_owned(),
        input_schema: Some(z::shape(vec![(
            "path",
            z::string().describe("absolute path to the file to open"),
        )])),
        handler: sync_handler(move |args: JsonValue| {
            let file_path = string_or_empty(&args, "path")?;
            if !is_absolute(&file_path) {
                return Err("path must be absolute".to_owned());
            }
            if !exists_sync(&file_path) {
                return Err(format!("file not found: {file_path}"));
            }
            let Some(open_in_tab) = &deps.open_in_tab else {
                return Err("opening files is not available in this build".to_owned());
            };
            open_in_tab(&file_path)?;
            Ok(Some(js_object(vec![
                ("ok", JsonValue::Bool(true)),
                ("path", JsonValue::String(file_path)),
            ])))
        }),
    }
}

fn get_app_info_tool<'h>(deps: Rc<DocToolDeps<'h>>) -> McpToolDefinition<'h> {
    McpToolDefinition {
        name: "get_app_info".to_owned(),
        description: concat!(
            "Report SeuOffice version, the default save folder, the document formats this server can ",
            "generate, and the editor's full open/save/export format matrix per family."
        )
        .to_owned(),
        input_schema: Some(z::shape(vec![])),
        handler: sync_handler(move |_args: JsonValue| {
            // Every format listed here is written by a headless create/read tool, and
            // all of them are opt-in: with background generation off there is no
            // generate tool at all, so advertising docx/pptx/xlsx would describe
            // capabilities this client cannot reach.
            let formats = if deps.background == Some(false) {
                Vec::new()
            } else {
                let mut formats = vec![JsonValue::String("docx".to_owned())];
                formats.extend(
                    deps.extra_formats
                        .iter()
                        .flatten()
                        .map(|format| JsonValue::String(format.clone())),
                );
                formats
            };
            Ok(Some(js_object(vec![
                ("name", JsonValue::String(PRODUCT_NAME.to_owned())),
                ("version", JsonValue::String(deps.version.clone())),
                ("defaultSaveDir", JsonValue::String((deps.default_save_dir)())),
                ("formats", JsonValue::Array(formats)),
                // editor truth vs. what this server exposes, see tools/formats.ts
                (
                    "families",
                    capability_report(Some(deps.background != Some(false))),
                ),
            ])))
        }),
    }
}

/// `createDocumentTools(deps, host)`: the docx tools. Headless generation is
/// opt-in: when background is off (the default), clients only see the visible
/// document session.
pub fn create_document_tools<'h>(
    deps: Rc<DocToolDeps<'h>>,
    host: SharedSessionHost,
) -> Vec<McpToolDefinition<'h>> {
    let mut tools = Vec::new();
    if deps.background != Some(false) {
        tools.push(create_headless_docx_tool(Rc::clone(&deps)));
        tools.push(create_fill_template_tool(Rc::clone(&deps)));
        tools.push(create_convert_document_tool(Rc::clone(&deps)));
    }
    tools.push(create_check_document_tool(Rc::clone(&deps)));
    tools.push(read_docx_tool(Rc::clone(&deps)));
    tools.push(read_docx_properties_tool(Rc::clone(&deps)));
    tools.push(open_in_seuoffice_tool(Rc::clone(&deps)));
    tools.push(get_app_info_tool(Rc::clone(&deps)));
    tools.extend(create_docx_content_tools(&deps, host));
    tools
}

/// The docx session driver behind the shared create_session / save_session
/// tools (`documentDriver(docs)`). The content tools below address the tab
/// this driver opened.
struct DocumentDriver;

impl FamilyDriver for DocumentDriver {
    fn family(&self) -> SessionFamily {
        SessionFamily::Docx
    }

    fn open_blank_tab(&self) -> HostCall {
        docs_open_blank_call()
    }

    fn save(&self, wc_id: i64, path: &str, overwrite: bool) -> HostCall {
        docs_run_call(
            wc_id,
            McpEditorCommandName::SaveDocument,
            js_object(vec![
                ("path", JsonValue::String(path.to_owned())),
                ("overwrite", JsonValue::Bool(overwrite)),
            ]),
        )
    }
}

/// `documentDriver(docs)`: the driver awaits the docs control through its host
/// calls, so it holds none
pub fn document_driver<'h>() -> Rc<dyn FamilyDriver + 'h> {
    Rc::new(DocumentDriver)
}

/// `await docs.runCommand(wcId, command, payload)` as the last step of a
/// handler: the tool answers what the renderer answered
fn run_command<'h>(wc_id: i64, command: McpEditorCommandName, payload: JsonValue) -> ToolStep<'h> {
    ToolStep::Await {
        call: docs_run_call(wc_id, command, payload),
        then: Box::new(ToolStep::Done),
    }
}

/// the `document` field of every content tool
fn document_field() -> ZodType {
    z::string().optional().describe(concat!(
        "tab id or path of an open Word document to edit instead of the session's own tab ",
        "(from open_documents {action:\"list\"}); the edit lands in that live document, and a ",
        "mutating tool switches the UI to that tab first so the user sees it happen"
    ))
}

/// Visible-editing content tools: edit the document the shared session opened,
/// so the user watches it take shape. These reuse the built-in agent's editor
/// pipeline (the same restricted-HTML parser, ops executor and save path), so
/// the result matches what the in-app AI produces.
///
/// Only registered when the shell wired a DocsControl: headless/unit runs keep
/// the phase-1 file-only surface.
fn create_docx_content_tools<'h>(
    deps: &Rc<DocToolDeps<'h>>,
    host: SharedSessionHost,
) -> Vec<McpToolDefinition<'h>> {
    if !deps.docs {
        return Vec::new();
    }

    let target = content_target(host, deps.resolve_target, SessionFamily::Docx);
    let focus = || Some(ResolveOptions { focus: Some(true) });

    let insert_content = {
        let target = Rc::clone(&target);
        McpToolDefinition {
            name: "insert_content".to_owned(),
            description: concat!(
                "Insert content into the visible document as HTML (headings, paragraphs, bold/italic, lists, ",
                "tables, links). Appends at the end unless afterBlockIndex is given."
            )
            .to_owned(),
            input_schema: Some(z::shape(vec![
                ("html", z::string().describe("restricted HTML fragment to insert")),
                (
                    "afterBlockIndex",
                    z::number()
                        .int()
                        .optional()
                        .describe("insert after this block index; default appends at the end"),
                ),
                ("document", document_field()),
            ])),
            handler: Box::new(move |args: JsonValue| {
                with_target(&target, args, focus(), |wc, args| {
                    run_command(wc, McpEditorCommandName::InsertContent, args)
                })
            }),
        }
    };

    let replace_blocks = {
        let target = Rc::clone(&target);
        McpToolDefinition {
            name: "replace_blocks".to_owned(),
            description: concat!(
                "Replace a range of blocks in the visible document with new HTML content. ",
                "Use read_document to learn block indexes."
            )
            .to_owned(),
            input_schema: Some(z::shape(vec![
                (
                    "startBlockIndex",
                    z::number()
                        .int()
                        .describe("first block index to replace (inclusive)"),
                ),
                (
                    "endBlockIndex",
                    z::number()
                        .int()
                        .describe("last block index to replace (inclusive)"),
                ),
                (
                    "html",
                    z::string().describe("restricted HTML fragment the range is replaced with"),
                ),
                ("document", document_field()),
            ])),
            handler: Box::new(move |args: JsonValue| {
                with_target(&target, args, focus(), |wc, args| {
                    run_command(wc, McpEditorCommandName::ReplaceBlocks, args)
                })
            }),
        }
    };

    let apply_ops = {
        let target = Rc::clone(&target);
        McpToolDefinition {
            name: "apply_ops".to_owned(),
            description: concat!(
                "Apply formatting commands to the visible document (font, paragraph format, heading level, ",
                "find/replace, list/indent, etc.). `ops` is the same batch format the built-in AI editor accepts; ",
                "the whole batch is atomic. Use read_document for block indexes."
            )
            .to_owned(),
            input_schema: Some(z::shape(vec![
                ("ops", z::array(z::any()).describe("array of op objects")),
                (
                    "dryRun",
                    z::boolean()
                        .optional()
                        .describe("validate and plan the batch without changing the document"),
                ),
                ("document", document_field()),
            ])),
            handler: Box::new(move |args: JsonValue| {
                with_target(&target, args, focus(), |wc, args| {
                    let mut payload = ObjectDraft::new();
                    payload.set("ops", args.get("ops").map(|ops| ops.into_owned()));
                    payload.set("dryRun", Some(JsonValue::Bool(is_true(&args, "dryRun"))));
                    run_command(wc, McpEditorCommandName::ApplyOps, payload.finish())
                })
            }),
        }
    };

    let insert_picture = {
        let target = Rc::clone(&target);
        let length = || z::union(vec![z::number(), z::string()]);
        McpToolDefinition {
            name: "insert_picture".to_owned(),
            description: concat!(
                "Insert a picture into the visible document from a direct image link (png/jpg/gif), ",
                "at a given size, inline after a block or floating at a position with text wrap. ",
                "Use read_document for block indexes."
            )
            .to_owned(),
            input_schema: Some(z::shape(vec![
                ("url", z::string().describe("direct image link (png/jpg/gif)")),
                (
                    "afterBlockIndex",
                    z::number().int().optional().describe(
                        "insert after this block (-1 = start of document); default: end of document",
                    ),
                ),
                (
                    "width",
                    length().optional().describe(concat!(
                        "display width, \"2.54cm\", \"1in\", \"72pt\", \"96px\" or a bare number of points; ",
                        "default natural size capped at 480px"
                    )),
                ),
                (
                    "height",
                    length()
                        .optional()
                        .describe("display height; omit to keep the aspect ratio"),
                ),
                (
                    "float",
                    z::object(z::shape(vec![
                        (
                            "anchor",
                            z::enum_(&["paragraph", "page", "margin"])
                                .optional()
                                .describe(concat!(
                                    "what x/y measure from: the anchor paragraph (default), the page corner, ",
                                    "or the margin box corner"
                                )),
                        ),
                        (
                            "x",
                            length().optional().describe(
                                "horizontal offset, \"2.54cm\", \"1in\", \"72pt\", \"96px\" or a bare number of points",
                            ),
                        ),
                        (
                            "y",
                            length().optional().describe(
                                "vertical offset, \"2.54cm\", \"1in\", \"72pt\", \"96px\" or a bare number of points",
                            ),
                        ),
                        (
                            "wrap",
                            z::enum_(&["square", "tight", "topAndBottom", "behind", "inFront"])
                                .optional()
                                .describe("how text wraps around the floating picture (default square)"),
                        ),
                    ]))
                    .optional()
                    .describe(concat!(
                        "omit for an inline picture in its own paragraph; give it to float the picture ",
                        "at a position"
                    )),
                ),
                (
                    "altText",
                    z::string().optional().describe("alternative text (accessibility)"),
                ),
                ("document", document_field()),
            ])),
            handler: Box::new(move |args: JsonValue| {
                with_target(&target, args, focus(), |wc, args| {
                    run_command(wc, McpEditorCommandName::InsertPicture, args)
                })
            }),
        }
    };

    let read_document = {
        let target = Rc::clone(&target);
        McpToolDefinition {
            name: "read_document".to_owned(),
            description: concat!(
                "Read the visible document as a block list: one \"index|type|text\" line per block, where the ",
                "index is what apply_ops and insert_content address. Long blocks are clipped for reading; ",
                "the list is an overview, not a lossless copy (use read_docx for full text)."
            )
            .to_owned(),
            input_schema: Some(z::shape(vec![("document", document_field())])),
            handler: Box::new(move |args: JsonValue| {
                with_target(&target, args, None, |wc, _args| {
                    run_command(wc, McpEditorCommandName::ReadDocument, js_object(vec![]))
                })
            }),
        }
    };

    vec![
        insert_content,
        replace_blocks,
        apply_ops,
        insert_picture,
        read_document,
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::mcp::tools::formats::generate_extension;

    #[test]
    fn docx_ext_is_what_the_registry_generates() {
        let ext = generate_extension(SessionFamily::Docx).expect("docx generates");
        assert_eq!(format!(".{ext}"), DOCX_EXT);
    }
}
