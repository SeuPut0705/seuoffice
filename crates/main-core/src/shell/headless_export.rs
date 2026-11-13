//! `apps/shell/src/main/headless-export.ts`: the headless export host, the
//! single entry every dialog-free export path can be driven through.
//!
//! `runHeadlessExport` is two calls around the export: [`begin_headless_export`]
//! decides everything up to the run, [`finish_headless_export`] judges what the
//! run left. The per-module hidden-window exporters and the placeholder export
//! open a hidden window and wait for its renderer, so the caller carries them
//! out ([`HeadlessRun`]) between the two. The check for content hidden from AI
//! (`fileHoldsHiddenContent` of `@seuoffice/file-parse`: JSZip and the xlsx
//! reader, engine-waiting) is the [`HiddenContent`] trait. `HeadlessFs` is the
//! disk-probe interface of the TypeScript. `Date.now()` is a closure of the
//! caller. `realFs` and the exporters' wiring stay with the caller.

use jscompat::node_path::host::{basename, dirname, extname, join, resolve};
use jscompat::value_truthy;
use serde_json::Value;

use crate::packages::electron_utils::headless_export::{
    HEADLESS_EXIT_BAD_ARGS, HEADLESS_EXIT_CONVERSION_FAILURE, HEADLESS_EXIT_INPUT_ERROR,
    HEADLESS_SUPPORTED_EXTENSIONS, HeadlessExportOutcome, HeadlessExportRequest,
    headless_module_for, headless_targets, is_diagram_file_target,
};

/// `HIDDEN_CONTENT_EXTENSIONS` of `@seuoffice/file-parse/hidden-content`: the
/// formats whose files can hold the mark, by extension
pub const HIDDEN_CONTENT_EXTENSIONS: [&str; 8] = [
    "docx", "pptx", "xlsx", "xlsm", "md", "markdown", "html", "htm",
];

/// mtime granularity on FAT/exFAT is 2 s, so a fresh write may stamp slightly before `start`
pub const MTIME_SLACK_MS: f64 = 2_000.0;

/// `HeadlessFailure`: `Extract<HeadlessExportOutcome, { ok: false }>`
#[derive(Debug, Clone, PartialEq)]
pub struct HeadlessFailure {
    /// 1, 2 or 3
    pub code: f64,
    pub message: String,
}

impl HeadlessFailure {
    fn of(code: u8, message: String) -> Self {
        HeadlessFailure {
            code: f64::from(code),
            message,
        }
    }

    pub fn into_outcome(self) -> HeadlessExportOutcome {
        HeadlessExportOutcome::Failed {
            code: self.code,
            message: self.message,
        }
    }
}

/// `HeadlessExportProduct`: an exporter that writes something other than the
/// one file at `outPath` reports the files it wrote.
#[derive(Debug, Clone, PartialEq)]
pub struct HeadlessExportProduct {
    pub paths: Vec<String>,
    /// facts for the caller, a JSON object
    pub detail: Option<Value>,
}

/// `fileHoldsHiddenContent(bytes, ext)`. `Err` is a throw other than the
/// redaction mark's own, which the implementor answers as `Ok(true)`.
pub trait HiddenContent {
    fn file_holds_hidden_content(&mut self, bytes: &[u8], ext: &str) -> Result<bool, String>;
}

/// `HeadlessFs`: disk probes. The optional members of the TypeScript are
/// `has_*`: `realpath` alone has none, an absent one answers the path itself.
pub trait HeadlessFs {
    fn exists(&mut self, path: &str) -> bool;
    fn is_file(&mut self, path: &str) -> bool;
    /// canonical path (symlinks resolved); the input itself when it cannot be resolved
    fn realpath(&mut self, path: &str) -> String;
    /// whether `mtimeMs` is there
    fn has_mtime(&self) -> bool;
    fn mtime_ms(&mut self, path: &str) -> f64;
    /// whether `read` is there
    fn has_read(&self) -> bool;
    /// the file's bytes; `Err` is a read that throws
    fn read(&mut self, path: &str) -> Result<Vec<u8>, String>;
}

/// The output may not exist yet, so only its directory is canonicalised.
fn canonical(path: &str, fs: &mut dyn HeadlessFs) -> String {
    let full = if fs.exists(path) {
        fs.realpath(path)
    } else {
        let dir = fs.realpath(&dirname(path));
        join(&[&dir, &basename(path, None)])
    };
    if cfg!(windows) {
        full.to_lowercase()
    } else {
        full
    }
}

/// What `validateHeadlessPaths` answers when it is ok.
#[derive(Debug, Clone, PartialEq)]
pub struct CheckedPaths {
    pub input: String,
    pub out_path: String,
    pub module: &'static str,
}

/// `validateHeadlessPaths(request, fs)`: checks a caller-supplied path pair
/// before any window is created.
pub fn validate_headless_paths(
    request: &HeadlessExportRequest,
    fs: &mut dyn HeadlessFs,
) -> Result<CheckedPaths, HeadlessFailure> {
    let input = resolve(&[&request.input]);
    if !fs.exists(&input) {
        return Err(HeadlessFailure::of(
            HEADLESS_EXIT_INPUT_ERROR,
            format!("input file not found: {input}"),
        ));
    }
    if !fs.is_file(&input) {
        return Err(HeadlessFailure::of(
            HEADLESS_EXIT_INPUT_ERROR,
            format!("input is not a file: {input}"),
        ));
    }
    let Some(module) = headless_module_for(&input) else {
        return Err(HeadlessFailure::of(
            HEADLESS_EXIT_INPUT_ERROR,
            format!("cannot export {input} (supported inputs: {HEADLESS_SUPPORTED_EXTENSIONS})"),
        ));
    };
    let targets = headless_targets()
        .into_iter()
        .find(|(name, _)| *name == module)
        .map(|(_, targets)| targets)
        .unwrap_or_default();
    if !targets.contains(&request.target_format) {
        return Err(HeadlessFailure::of(
            HEADLESS_EXIT_BAD_ARGS,
            format!(
                "cannot export {input} to {} (this input supports: {})",
                request.target_format,
                targets.join(", ")
            ),
        ));
    }
    if let Some(switches) = diagram_switch_problem(request, module) {
        return Err(HeadlessFailure::of(HEADLESS_EXIT_BAD_ARGS, switches));
    }
    let out_path = resolve(&[&request.out_path]);
    if !fs.exists(&dirname(&out_path)) {
        return Err(HeadlessFailure::of(
            HEADLESS_EXIT_BAD_ARGS,
            format!("output directory does not exist: {}", dirname(&out_path)),
        ));
    }
    if fs.exists(&out_path) && !fs.is_file(&out_path) {
        return Err(HeadlessFailure::of(
            HEADLESS_EXIT_BAD_ARGS,
            format!("output path is a directory: {out_path}"),
        ));
    }
    let canonical_input = canonical(&input, fs);
    let canonical_out = canonical(&out_path, fs);
    if canonical_input == canonical_out {
        return Err(HeadlessFailure::of(
            HEADLESS_EXIT_BAD_ARGS,
            format!("output path must differ from the input: {out_path}"),
        ));
    }
    Ok(CheckedPaths {
        input,
        out_path,
        module,
    })
}

/// `--page`, `--ops` and `--batch` belong to diagrams; ops and batch only
/// where a diagram file is written.
fn diagram_switch_problem(request: &HeadlessExportRequest, module: &str) -> Option<String> {
    let mut given: Vec<&str> = Vec::new();
    if request.page.is_some() {
        given.push("page");
    }
    if request.ops.is_some() {
        given.push("ops");
    }
    if request.batch.is_some() {
        given.push("batch");
    }
    if given.is_empty() {
        return None;
    }
    if module != "diagram" {
        return Some(format!("--{} is for diagram inputs only", given[0]));
    }
    if is_diagram_file_target(request.target_format) {
        if !request
            .out_path
            .to_lowercase()
            .ends_with(&format!(".{}", request.target_format))
        {
            return Some(format!(
                "--out must end in .{} for --to {}",
                request.target_format, request.target_format
            ));
        }
        return None;
    }
    given
        .iter()
        .find(|key| **key != "page")
        .map(|wrong| format!("--{wrong} goes with --to drawio, dio, drawio.svg or drawio.png"))
}

/// what `hiddenContentRoute` answers besides `null`
enum HiddenRoute {
    Clear,
    Placeholders,
    Refused(HeadlessFailure),
}

/// A copy this host writes carries the words a person hid from AI with no
/// mark left on them, and nobody is here to agree to that: such an input is
/// refused before any window opens. A Word document's HTML or Markdown is
/// written as the AI readers' view instead. `Err` is what `fs.read` or the
/// check throws.
fn hidden_content_route(
    input: &str,
    module: &str,
    format: &str,
    fs: &mut dyn HeadlessFs,
    hidden: &mut dyn HiddenContent,
) -> Result<HiddenRoute, String> {
    let ext_with_dot = extname(input);
    let ext = ext_with_dot.get(1..).unwrap_or("").to_lowercase();
    if !fs.has_read() || !HIDDEN_CONTENT_EXTENSIONS.contains(&ext.as_str()) {
        return Ok(HiddenRoute::Clear);
    }
    let bytes = fs.read(input)?;
    if !hidden.file_holds_hidden_content(&bytes, &ext)? {
        return Ok(HiddenRoute::Clear);
    }
    if module == "docs" && (format == "html" || format == "md") {
        return Ok(HiddenRoute::Placeholders);
    }
    Ok(HiddenRoute::Refused(HeadlessFailure::of(
        HEADLESS_EXIT_INPUT_ERROR,
        format!(
            "cannot export {input} to {format}: it holds content hidden from AI, and the copy would show it unmarked; read or convert it with the seuoffice command line, which gives a placeholder for the hidden content where the format allows, or clear the marks in the app first"
        ),
    )))
}

/// What the caller must run for an export: the hidden-window export of a
/// module's format, or the placeholder export of a Word document. Both open a
/// hidden window and wait for its renderer, so the caller carries them out and
/// hands the answer to [`finish_headless_export`].
#[derive(Debug, Clone, PartialEq)]
pub enum HeadlessRun {
    /// `exporters[module](input, outPath, format, request)`; the request is
    /// [`HeadlessExportPending::request`]
    Exporter {
        module: &'static str,
        input: String,
        out_path: String,
        format: &'static str,
    },
    /// `placeholders(input, outPath, format)`; its answer carries no product
    Placeholders {
        input: String,
        out_path: String,
        format: &'static str,
    },
}

/// An export that has passed its checks and waits for the caller's run.
#[derive(Debug, Clone, PartialEq)]
pub struct HeadlessExportPending {
    pub run: HeadlessRun,
    /// the request, the exporter's fourth argument
    pub request: HeadlessExportRequest,
    /// `Date.now()` read right before the run started
    pub started_at: f64,
    input: String,
    out_path: String,
}

/// What [`begin_headless_export`] decides.
#[derive(Debug, Clone, PartialEq)]
pub enum HeadlessStep {
    /// the outcome needs no export: a validation, hidden-content or
    /// placeholder failure
    Done(HeadlessExportOutcome),
    /// run this, then call [`finish_headless_export`]
    Export(HeadlessExportPending),
}

/// `runHeadlessExport(request, exporters, fs, placeholders)`, up to the run
/// of the export. The outcome is returned instead of thrown so the caller can
/// render the envelope and pick the exit code in one place; `Err` is a throw
/// the TypeScript does not catch (the file read, the hidden-content check).
/// `has_placeholders` is whether the `placeholders` argument was given.
pub fn begin_headless_export(
    request: &HeadlessExportRequest,
    fs: &mut dyn HeadlessFs,
    hidden: &mut dyn HiddenContent,
    has_placeholders: bool,
    now_ms: &mut dyn FnMut() -> f64,
) -> Result<HeadlessStep, String> {
    let checked = match validate_headless_paths(request, fs) {
        Ok(checked) => checked,
        Err(failure) => return Ok(HeadlessStep::Done(failure.into_outcome())),
    };
    let route = hidden_content_route(
        &checked.input,
        checked.module,
        request.target_format,
        fs,
        hidden,
    )?;
    let use_placeholders = match route {
        HiddenRoute::Refused(failure) => return Ok(HeadlessStep::Done(failure.into_outcome())),
        HiddenRoute::Placeholders => true,
        HiddenRoute::Clear => false,
    };
    if use_placeholders && !has_placeholders {
        return Ok(HeadlessStep::Done(
            HeadlessFailure::of(
                HEADLESS_EXIT_CONVERSION_FAILURE,
                format!(
                    "cannot export {}: it holds content hidden from AI, and no placeholder export is available",
                    checked.input
                ),
            )
            .into_outcome(),
        ));
    }
    let started_at = now_ms();
    let run = if use_placeholders {
        HeadlessRun::Placeholders {
            input: checked.input.clone(),
            out_path: checked.out_path.clone(),
            format: request.target_format,
        }
    } else {
        HeadlessRun::Exporter {
            module: checked.module,
            input: checked.input.clone(),
            out_path: checked.out_path.clone(),
            format: request.target_format,
        }
    };
    Ok(HeadlessStep::Export(HeadlessExportPending {
        run,
        request: request.clone(),
        started_at,
        input: checked.input,
        out_path: checked.out_path,
    }))
}

/// `runHeadlessExport` after the run: `product` is what the exporter answered
/// (`None` for no product, and for the placeholder export), `Err` the message
/// of what it threw (`err instanceof Error ? err.message : String(err)` is the
/// caller's).
pub fn finish_headless_export(
    pending: HeadlessExportPending,
    product: Result<Option<HeadlessExportProduct>, String>,
    fs: &mut dyn HeadlessFs,
) -> HeadlessExportOutcome {
    let product = match product {
        Ok(product) => product,
        Err(message) => {
            return HeadlessFailure::of(HEADLESS_EXIT_CONVERSION_FAILURE, message).into_outcome();
        }
    };
    let HeadlessExportPending {
        started_at,
        input,
        out_path,
        ..
    } = pending;
    let written: Vec<String> = match &product {
        Some(product) => product.paths.iter().map(|path| resolve(&[path])).collect(),
        None => vec![out_path.clone()],
    };
    for path in &written {
        if !fs.exists(path) || !fs.is_file(path) {
            return HeadlessFailure::of(
                HEADLESS_EXIT_CONVERSION_FAILURE,
                format!("export reported success but wrote no file at {path}"),
            )
            .into_outcome();
        }
        if fs.has_mtime() && fs.mtime_ms(path) < started_at - MTIME_SLACK_MS {
            return HeadlessFailure::of(
                HEADLESS_EXIT_CONVERSION_FAILURE,
                format!("export reported success but left a stale file at {path}"),
            )
            .into_outcome();
        }
    }
    let Some(product) = product else {
        return HeadlessExportOutcome::Ok {
            input,
            out_path,
            out_paths: None,
            detail: None,
        };
    };
    HeadlessExportOutcome::Ok {
        input,
        out_path,
        out_paths: Some(written),
        detail: product.detail.filter(|detail| value_truthy(Some(detail))),
    }
}
