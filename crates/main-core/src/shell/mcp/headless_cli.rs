//! `apps/shell/src/main/mcp/headless-cli.ts`: thin helpers that turn an MCP
//! tool's arguments into a `seuoffice` CLI invocation. The headless MCP tools
//! are a client of the CLI, not a second implementation of the engines: input
//! that arrives inline (markdown, a row matrix, an ops array) is staged to a
//! temp file, the CLI writes the output, and its `--json` payload is mapped
//! back to a tool result.
//!
//! The runner is a [`CliRunner`] (a script in the comparison, a process in the
//! host); the scratch directory is a real one under `os.tmpdir()`, removed
//! after every call. `Err` is the message of the `Error` the TypeScript
//! throws. What the CLI printed is a [`JsonValue`] read field by field: a
//! `summary` or `output_path` the CLI left out is `None`, one that is not a
//! string is kept as it is, as the TypeScript passes it on.

use jscompat::node_path::host::join;
use jscompat::{JsonValue, json_stringify, to_primitive};

use super::cli_runner::{CliRunOptions, CliRunOutcome, CliRunner, cli_error};
use crate::node_fs::mkdtemp_random;
use crate::pdf::node_io::{rm_recursive_force, tmpdir, write_file_mode};

/// `withTempDir(fn)`: run `f` with a scratch directory that is always removed
/// afterwards. A removal that fails replaces the result, as a `finally` that
/// throws does.
fn with_temp_dir<T>(f: impl FnOnce(&str) -> Result<T, String>) -> Result<T, String> {
    let dir = mkdtemp_random(&join(&[&tmpdir(), "seuoffice-mcp-"])).map_err(|e| e.message)?;
    let result = f(&dir);
    rm_recursive_force(&dir).map_err(|e| e.message)?;
    result
}

/// `stage(dir, name, content)`: stage inline content in the scratch dir and
/// return its path
fn stage(dir: &str, name: &str, content: &str) -> Result<String, String> {
    let path = join(&[dir, name]);
    write_file_mode(&path, content, 0o666).map_err(|e| e.message)?;
    Ok(path)
}

/// `String(value)`
fn js_string(value: &JsonValue) -> Result<String, String> {
    to_primitive(Some(value))
        .map(|primitive| primitive.to_js_string())
        .map_err(|error| error.0)
}

/// `!outcome.ok || !outcome.json || outcome.json.status !== 'ok'` ends in
/// `throw new Error(cliErrorMessage(outcome))`: the CLI's own `ok` JSON, or
/// the error.
fn require_ok(outcome: &CliRunOutcome) -> Result<&JsonValue, String> {
    match &outcome.json {
        Some(json)
            if outcome.ok
                && matches!(json.get("status").as_deref(), Some(JsonValue::String(s)) if s == "ok") =>
        {
            Ok(json)
        }
        _ => Err(cli_error(outcome)),
    }
}

/// `outcome.json.detail?.<key>`: `None` is `undefined`
fn detail_field(json: &JsonValue, key: &str) -> Option<JsonValue> {
    json.get("detail")
        .and_then(|detail| detail.get(key).map(|value| value.into_owned()))
}

/// What [`create_file_via_cli`] and [`create_pptx_via_cli`] answer:
/// `{ outcome, summary, outputPath }`.
#[derive(Debug, Clone, PartialEq)]
pub struct CreateResult {
    pub outcome: CliRunOutcome,
    /// `outcome.json.summary`
    pub summary: Option<JsonValue>,
    /// `outcome.json.output_path ?? out`
    pub output_path: JsonValue,
}

/// `opts` of `createFileViaCli`
#[derive(Debug, Clone, PartialEq)]
pub struct CreateFileOptions<'a> {
    /// `'docx' | 'pptx' | 'xlsx'`
    pub file_type: &'a str,
    /// staged input file name (e.g. `report.md`, a table JSON)
    pub input_name: &'a str,
    /// its contents
    pub input_content: &'a str,
    pub out: &'a str,
    pub overwrite: bool,
}

/// `createFileViaCli(runner, opts)`: `create --type <type> --from <staged
/// input> --out <target>`.
///
/// The caller has already resolved and validated `out`; `overwrite` maps to
/// `--force`, so the CLI's own clobber guard only fires when it should.
pub fn create_file_via_cli(
    runner: &dyn CliRunner,
    opts: &CreateFileOptions<'_>,
) -> Result<CreateResult, String> {
    with_temp_dir(|dir| {
        let input_path = stage(dir, opts.input_name, opts.input_content)?;
        let args = vec![
            "create".to_owned(),
            "--type".to_owned(),
            opts.file_type.to_owned(),
            "--from".to_owned(),
            input_path,
        ];
        run_create(runner, args, opts.out, opts.overwrite)
    })
}

/// `createPptxViaCli(runner, opts)`: `create --type pptx --ops <staged file>
/// --out <target>` (the CLI's pptx creation path: a JSON array applied one by
/// one to a blank deck). Ops are staged to a file rather than piped on stdin
/// so the invocation is uniform with the other families and trivially
/// inspectable.
pub fn create_pptx_via_cli(
    runner: &dyn CliRunner,
    ops: &[JsonValue],
    out: &str,
    overwrite: bool,
) -> Result<CreateResult, String> {
    with_temp_dir(|dir| {
        let ops_path = stage(
            dir,
            "ops.json",
            &json_stringify(&JsonValue::Array(ops.to_vec())),
        )?;
        let args = vec![
            "create".to_owned(),
            "--type".to_owned(),
            "pptx".to_owned(),
            "--ops".to_owned(),
            ops_path,
        ];
        run_create(runner, args, out, overwrite)
    })
}

/// `runCreate(runner, baseArgs, out, overwrite)`; its `runOptions` is never
/// passed by a caller
fn run_create(
    runner: &dyn CliRunner,
    mut args: Vec<String>,
    out: &str,
    overwrite: bool,
) -> Result<CreateResult, String> {
    args.push("--out".to_owned());
    args.push(out.to_owned());
    if overwrite {
        args.push("--force".to_owned());
    }
    let outcome = runner.run(&args, &CliRunOptions::default());
    let json = require_ok(&outcome)?;
    let summary = json.get("summary").map(|value| value.into_owned());
    let output_path = match json.get("output_path").as_deref() {
        None | Some(JsonValue::Null) => JsonValue::String(out.to_owned()),
        Some(path) => path.clone(),
    };
    Ok(CreateResult {
        outcome,
        summary,
        output_path,
    })
}

/// `readDocxTextViaCli(runner, path)`: read a .docx's visible text through
/// `docs read`. Returns one paragraph per line, matching the tool's documented
/// shape.
///
/// `--full` is required: without it the CLI clips each block to a
/// 200-character preview, so long paragraphs would come back silently
/// truncated.
pub fn read_docx_text_via_cli(runner: &dyn CliRunner, path: &str) -> Result<String, String> {
    let args = vec![
        "docs".to_owned(),
        "read".to_owned(),
        path.to_owned(),
        "--full".to_owned(),
    ];
    let outcome = runner.run(&args, &CliRunOptions::default());
    let json = require_ok(&outcome)?;
    // `(json.detail?.items ?? []) as Array<{ text?: string }>`
    let items = match detail_field(json, "items") {
        None | Some(JsonValue::Null) => Vec::new(),
        Some(JsonValue::Array(items)) => items,
        Some(_) => return Err("items.map is not a function".to_owned()),
    };
    let mut lines = Vec::with_capacity(items.len());
    for item in &items {
        // `String(item.text ?? '')`
        lines.push(match item {
            JsonValue::Null => {
                return Err("Cannot read properties of null (reading 'text')".to_owned());
            }
            JsonValue::Object(object) => match object.get("text") {
                None | Some(JsonValue::Null) => String::new(),
                Some(text) => js_string(text)?,
            },
            _ => String::new(),
        });
    }
    // `.replace(/\n+$/, '')`
    Ok(lines.join("\n").trim_end_matches('\n').to_owned())
}

/// `readDocxPropertiesViaCli(runner, path)`: `docs read <path> --properties`:
/// the document's core, app and custom properties as the CLI reports them.
/// Read-only, so no output resolution.
pub fn read_docx_properties_via_cli(
    runner: &dyn CliRunner,
    path: &str,
) -> Result<JsonValue, String> {
    let args = vec![
        "docs".to_owned(),
        "read".to_owned(),
        path.to_owned(),
        "--properties".to_owned(),
    ];
    let outcome = runner.run(&args, &CliRunOptions::default());
    let json = require_ok(&outcome)?;
    match detail_field(json, "properties") {
        Some(properties @ (JsonValue::Object(_) | JsonValue::Array(_))) => Ok(properties),
        _ => Err("docs read returned no properties detail".to_owned()),
    }
}

/// `opts` of `mergeTemplateViaCli`
#[derive(Debug, Clone, PartialEq)]
pub struct MergeOptions<'a> {
    pub template_path: &'a str,
    /// the values: an object whose keys are the `{{key}}` names; `None` is
    /// `undefined`, which `JSON.stringify` cannot stage
    pub data: Option<&'a JsonValue>,
    pub out: &'a str,
    pub overwrite: bool,
    pub strict: bool,
}

/// `mergeTemplateViaCli(runner, opts)`: `merge <template> --data <staged json>
/// --out <target> [--force] [--strict]`: fill one record of `{{key}}`
/// placeholders and write the result. The data object is staged to a temp
/// file: inline JSON on argv would run into Windows' command-line length
/// limit for real merge payloads. Answers the CLI's `ok` JSON.
pub fn merge_template_via_cli(
    runner: &dyn CliRunner,
    opts: &MergeOptions<'_>,
) -> Result<JsonValue, String> {
    with_temp_dir(|dir| {
        // `writeFile(path, JSON.stringify(undefined))` is refused by Node
        let Some(data) = opts.data else {
            return Err(
                "The \"data\" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined"
                    .to_owned(),
            );
        };
        let data_path = stage(dir, "data.json", &json_stringify(data))?;
        let mut args = vec![
            "merge".to_owned(),
            opts.template_path.to_owned(),
            "--data".to_owned(),
            data_path,
            "--out".to_owned(),
            opts.out.to_owned(),
        ];
        if opts.overwrite {
            args.push("--force".to_owned());
        }
        if opts.strict {
            args.push("--strict".to_owned());
        }
        let outcome = runner.run(&args, &CliRunOptions::default());
        Ok(require_ok(&outcome)?.clone())
    })
}

/// `opts` of `sheetLinksViaCli`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SheetLinksOptions<'a> {
    pub path: &'a str,
    pub update: bool,
    /// 1-based indices to break
    pub break_indices: Option<&'a [f64]>,
    pub out: Option<&'a str>,
    pub overwrite: bool,
}

/// `sheetLinksViaCli(runner, opts)`: `sheet links <path>`: list, refresh
/// (`--update`) or break (`--break`, 1-based indices) a workbook's external
/// links. Mutations default to writing in place and honour `--out`/`--force`:
/// the CLI routes them through the same output/allow-list/open-in-SeuOffice
/// guards `sheet apply` uses. Answers the CLI's `ok` JSON.
pub fn sheet_links_via_cli(
    runner: &dyn CliRunner,
    opts: &SheetLinksOptions<'_>,
) -> Result<JsonValue, String> {
    let mut args = vec!["sheet".to_owned(), "links".to_owned(), opts.path.to_owned()];
    if let Some(indices) = opts.break_indices {
        args.push("--break".to_owned());
        args.push(
            indices
                .iter()
                .map(|index| jscompat::number_to_string(*index))
                .collect::<Vec<_>>()
                .join(","),
        );
    } else if opts.update {
        args.push("--update".to_owned());
    }
    if let Some(out) = opts.out {
        args.push("--out".to_owned());
        args.push(out.to_owned());
        if opts.overwrite {
            args.push("--force".to_owned());
        }
    }
    let outcome = runner.run(&args, &CliRunOptions::default());
    Ok(require_ok(&outcome)?.clone())
}

/// `opts` of `convertViaCli`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ConvertOptions<'a> {
    pub path: &'a str,
    pub to: &'a str,
    pub out: Option<&'a str>,
    pub overwrite: bool,
    pub password: Option<&'a str>,
    pub sheet: Option<&'a str>,
}

/// `convertViaCli(runner, opts)`: `convert <path> --to <format> [--out
/// <target>] [--force] [--password <pw>] [--sheet <name>]`: one document
/// through the CLI's conversion matrix (pdf to docx/pptx/xlsx/md, legacy
/// .doc/.ppt to modern Open XML, odt/ods/hwp to their modern counterparts, md
/// to docx/html, xlsx to csv, ...). The CLI owns the route table: an
/// unsupported pair comes back as a usage error whose `detail` names every
/// supported target for the source format. Answers the CLI's `ok` JSON.
pub fn convert_via_cli(
    runner: &dyn CliRunner,
    opts: &ConvertOptions<'_>,
) -> Result<JsonValue, String> {
    let mut args = vec![
        "convert".to_owned(),
        opts.path.to_owned(),
        "--to".to_owned(),
        opts.to.to_owned(),
    ];
    if let Some(out) = opts.out {
        args.push("--out".to_owned());
        args.push(out.to_owned());
    }
    if opts.overwrite {
        args.push("--force".to_owned());
    }
    if let Some(password) = opts.password {
        args.push("--password".to_owned());
        args.push(password.to_owned());
    }
    if let Some(sheet) = opts.sheet {
        args.push("--sheet".to_owned());
        args.push(sheet.to_owned());
    }
    args.push("--json".to_owned());
    let outcome = runner.run(&args, &CliRunOptions::default());
    Ok(require_ok(&outcome)?.clone())
}

/// `docsCheckViaCli(runner, path)`: `docs check <path>`: the document-quality
/// read (fields without results, broken references, a stale TOC, missing
/// images, empty charts/headings, level skips, leftover placeholder text,
/// pending tracked changes, open comments). Read-only, so no output
/// resolution and always registered, the same tier as `read_docx`. Answers
/// the CLI's `ok` JSON.
pub fn docs_check_via_cli(runner: &dyn CliRunner, path: &str) -> Result<JsonValue, String> {
    let args = vec![
        "docs".to_owned(),
        "check".to_owned(),
        path.to_owned(),
        "--json".to_owned(),
    ];
    let outcome = runner.run(&args, &CliRunOptions::default());
    Ok(require_ok(&outcome)?.clone())
}
