//! `apps/markdown/src/main/print-document.ts`: print the same self-contained
//! HTML the preview drew, in a throwaway window with scripts off.
//!
//! The window (`new BrowserWindow(...)` with its `webPreferences`) and
//! `process.platform` come from the caller: the window as a
//! [`MarkdownPrintWindow`], the platform as a string. `os.tmpdir()` is a
//! parameter.

use jscompat::js_regex;
use jscompat::node_path::host::join;
use serde_json::{Map, Number, Value};

use crate::node_fs::{mkdtemp_random, node_error};
use crate::packages::electron_utils::print_window::{
    JsError, PrintDialogOutcome, PrintReport, rm_recursive_force,
};

/// `MarkdownPrintOptions` of `apps/markdown/src/shared/print-options.ts`,
/// which this module and `print-pdf.ts` take; `MARKDOWN_PRINT_OPTIONS` is
/// [`MarkdownPrintOptions::default`].
#[derive(Debug, Clone, PartialEq)]
pub struct MarkdownPrintOptions {
    pub page_size: String,
    pub margin_in: f64,
    pub landscape: bool,
    pub print_background: bool,
}

impl Default for MarkdownPrintOptions {
    fn default() -> Self {
        MarkdownPrintOptions {
            page_size: "A4".to_owned(),
            margin_in: 0.6,
            landscape: false,
            print_background: true,
        }
    }
}

/// `MarkdownPageRange`: a 1-based, inclusive page range.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MarkdownPageRange {
    pub from: f64,
    pub to: f64,
}

/// The methods of the throwaway `BrowserWindow` the module calls.
pub trait MarkdownPrintWindow {
    fn load_file(&mut self, path: &str) -> Result<(), JsError>;
    fn show(&mut self) -> Result<(), JsError>;
    fn focus(&mut self) -> Result<(), JsError>;
    /// `webContents.print(options, callback)`: what the callback got; `Err` is
    /// a `print` that throws
    fn print(&mut self, options: &Value) -> Result<PrintReport, JsError>;
    fn destroy(&mut self) -> Result<(), JsError>;
}

fn number(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// The options of `webContents.print`, its keys in the order the literal
/// writes them.
pub fn print_options(pages: Option<&MarkdownPageRange>, options: &MarkdownPrintOptions) -> Value {
    let margin = options.margin_in;
    let mut margins = Map::new();
    margins.insert("marginType".into(), Value::from("custom"));
    for side in ["top", "bottom", "left", "right"] {
        margins.insert(side.into(), number(margin));
    }
    let mut map = Map::new();
    map.insert("silent".into(), Value::Bool(false));
    map.insert(
        "printBackground".into(),
        Value::Bool(options.print_background),
    );
    map.insert("pageSize".into(), Value::from(options.page_size.as_str()));
    map.insert("landscape".into(), Value::Bool(options.landscape));
    map.insert("margins".into(), Value::Object(margins));
    map.insert("header".into(), Value::from(""));
    map.insert("footer".into(), Value::from(""));
    if let Some(range) = pages {
        let mut one = Map::new();
        one.insert("from".into(), number(range.from));
        one.insert("to".into(), number(range.to));
        map.insert("pageRanges".into(), Value::Array(vec![Value::Object(one)]));
    }
    Value::Object(map)
}

/// What the print callback came to: printed, canceled in the system dialog
/// (not a failure), or failed with the reason.
pub fn print_result(report: &PrintReport) -> PrintDialogOutcome {
    if report.success {
        PrintDialogOutcome::Ok
    } else if js_regex!(r"cancel", "i").test(&report.failure_reason) {
        PrintDialogOutcome::Canceled
    } else if report.failure_reason.is_empty() {
        PrintDialogOutcome::Failed("print failed".to_owned())
    } else {
        PrintDialogOutcome::Failed(report.failure_reason.clone())
    }
}

/// `printMarkdownDocument(html, pages, options)`. An `Err` is what the
/// TypeScript lets through: the folder that cannot be made, a window that
/// cannot be destroyed, a folder that cannot be removed.
pub fn print_markdown_document<W: MarkdownPrintWindow>(
    create_window: impl FnOnce() -> Result<W, JsError>,
    html: &str,
    pages: Option<&MarkdownPageRange>,
    options: &MarkdownPrintOptions,
    platform: &str,
    tmp_dir: &str,
) -> Result<PrintDialogOutcome, JsError> {
    let work_dir = mkdtemp_random(&join(&[tmp_dir, "seuoffice-md-print-"]))?;
    let mut win: Option<W> = None;
    let printed = (|| -> Result<PrintDialogOutcome, JsError> {
        let target = win.insert(create_window()?);
        let html_path = join(&[&work_dir, "print.html"]);
        std::fs::write(&html_path, html).map_err(|e| node_error(&e, "open", &html_path))?;
        target.load_file(&html_path)?;
        // Windows attaches the native dialog to the printed window, so it must be visible.
        if platform == "win32" {
            target.show()?;
            target.focus()?;
        }
        let report = target.print(&print_options(pages, options))?;
        Ok(print_result(&report))
    })();
    let outcome = match printed {
        Ok(outcome) => outcome,
        Err(error) => PrintDialogOutcome::Failed(error.message),
    };
    if let Some(window) = win.as_mut() {
        window.destroy()?;
    }
    rm_recursive_force(&work_dir)?;
    Ok(outcome)
}
