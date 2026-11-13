//! `apps/markdown/src/main/print-document.ts`: print the same self-contained
//! HTML the preview drew, in a throwaway window with scripts off.
//!
//! The window (`new BrowserWindow(...)` with its `webPreferences`) and
//! `process.platform` come from the caller: the window as a
//! [`MarkdownPrintWindow`], the platform as a string. Its renderer calls
//! (`loadFile`, `print`) are the steps of a [`MarkdownPrintJob`] the caller
//! carries out. `os.tmpdir()` is a parameter.

use jscompat::js_regex;
use jscompat::node_path::host::join;
use serde_json::{Map, Number, Value};

use crate::node_fs::{mkdtemp_random, node_error};
use crate::packages::electron_utils::print_html_pdf::PrintWindow;
use crate::packages::electron_utils::print_window::{
    JsError, PrintDialogOutcome, PrintReport, RendererAnswer, RendererCall, WindowStep, load_call,
    release_job,
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

/// What the module calls on its throwaway `BrowserWindow` without waiting for
/// the renderer, besides `destroy`.
pub trait MarkdownPrintWindow: PrintWindow {
    fn show(&mut self) -> Result<(), JsError>;
    fn focus(&mut self) -> Result<(), JsError>;
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

/// `printMarkdownDocument` between its awaits.
#[derive(Debug)]
pub struct MarkdownPrintJob<W> {
    win: W,
    work_dir: String,
    win32: bool,
    /// the options of `print`, `Some` while the load is awaited
    print_options: Option<Value>,
}

/// A step of `printMarkdownDocument`; [`WindowStep::Done`] holds the outcome
/// once the window is destroyed and the folder removed. An `Err` there is what
/// the TypeScript lets through: the folder that cannot be made, a window that
/// cannot be destroyed, a folder that cannot be removed.
pub type MarkdownPrintStep<W> =
    WindowStep<MarkdownPrintJob<W>, Result<PrintDialogOutcome, JsError>>;

/// `printMarkdownDocument(html, pages, options)` up to its first await.
pub fn begin_print_markdown_document<W: MarkdownPrintWindow>(
    create_window: impl FnOnce() -> Result<W, JsError>,
    html: &str,
    pages: Option<&MarkdownPageRange>,
    options: &MarkdownPrintOptions,
    platform: &str,
    tmp_dir: &str,
) -> MarkdownPrintStep<W> {
    let work_dir = match mkdtemp_random(&join(&[tmp_dir, "seuoffice-md-print-"])) {
        Ok(dir) => dir,
        Err(error) => return WindowStep::Done(Err(error.into())),
    };
    let mut win = match create_window() {
        Ok(win) => win,
        Err(error) => return end::<W>(None, &work_dir, Err(error)),
    };
    let html_path = join(&[&work_dir, "print.html"]);
    if let Err(e) = std::fs::write(&html_path, html) {
        let error = node_error(&e, "open", &html_path).into();
        return end(Some(&mut win), &work_dir, Err(error));
    }
    WindowStep::Await {
        call: load_call(&html_path),
        job: MarkdownPrintJob {
            win,
            work_dir,
            win32: platform == "win32",
            print_options: Some(print_options(pages, options)),
        },
    }
}

impl<W: MarkdownPrintWindow> MarkdownPrintJob<W> {
    /// The window the awaited call is carried out on.
    pub fn window(&mut self) -> &mut W {
        &mut self.win
    }

    /// The answer to the call this print waits for.
    pub fn resume(mut self, answer: RendererAnswer) -> MarkdownPrintStep<W> {
        match self.print_options.take() {
            Some(options) => {
                if let Err(error) = answer.into_loaded() {
                    return end(Some(&mut self.win), &self.work_dir, Err(error));
                }
                // Windows attaches the native dialog to the printed window, so it must be visible.
                if self.win32
                    && let Err(error) = self.win.show().and_then(|()| self.win.focus())
                {
                    return end(Some(&mut self.win), &self.work_dir, Err(error));
                }
                WindowStep::Await {
                    call: RendererCall::Print { options },
                    job: self,
                }
            }
            None => {
                let printed = answer.into_printed().map(|report| print_result(&report));
                end(Some(&mut self.win), &self.work_dir, printed)
            }
        }
    }
}

/// the `catch` and `finally`: an error becomes a failed outcome, then the
/// window is destroyed and the folder removed; what those throw goes out
fn end<W: PrintWindow>(
    win: Option<&mut W>,
    work_dir: &str,
    printed: Result<PrintDialogOutcome, JsError>,
) -> MarkdownPrintStep<W> {
    let outcome = printed.unwrap_or_else(|error| PrintDialogOutcome::Failed(error.message));
    let released = release_job(win, work_dir, |win| win.destroy());
    WindowStep::Done(released.map(|()| outcome))
}
