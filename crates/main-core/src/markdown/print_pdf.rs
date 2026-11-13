//! `apps/markdown/src/main/print-pdf.ts`: shared pagination for PDF and PNG
//! export, with document scripts disabled.
//!
//! The window comes from the caller's `createWindow` as a [`PrintWindow`] (the
//! `new BrowserWindow(...)` and its `webPreferences` stay with it); its
//! renderer calls are the steps of a [`PdfJob`]. `os.tmpdir()` is a parameter.

use serde_json::{Map, Number, Value};

use super::print_document::MarkdownPrintOptions;
use crate::packages::electron_utils::print_html_pdf::{PdfStep, PrintWindow, begin_pdf_job};
use crate::packages::electron_utils::print_window::JsError;

fn number(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// The options of `webContents.printToPDF`, its keys in the order the literal
/// writes them.
pub fn pdf_options(options: &MarkdownPrintOptions) -> Value {
    let margin = options.margin_in;
    let mut margins = Map::new();
    for side in ["top", "bottom", "left", "right"] {
        margins.insert(side.into(), number(margin));
    }
    let mut map = Map::new();
    map.insert("pageSize".into(), Value::from(options.page_size.as_str()));
    map.insert(
        "printBackground".into(),
        Value::Bool(options.print_background),
    );
    map.insert("landscape".into(), Value::Bool(options.landscape));
    map.insert("margins".into(), Value::Object(margins));
    Value::Object(map)
}

/// `printMarkdownPdf(html, options)` up to its first await; its
/// [`WindowStep::Done`](crate::packages::electron_utils::print_window::WindowStep)
/// holds the PDF bytes. Whatever the steps throw goes out, after the window is
/// destroyed and the folder removed; a window that cannot be destroyed leaves
/// the folder, as in the TypeScript.
pub fn begin_print_markdown_pdf<W: PrintWindow>(
    create_window: impl FnOnce() -> Result<W, JsError>,
    html: &str,
    options: &MarkdownPrintOptions,
    tmp_dir: &str,
) -> PdfStep<W> {
    begin_pdf_job(
        create_window,
        html,
        tmp_dir,
        "seuoffice-md-print-",
        pdf_options(options),
    )
}
