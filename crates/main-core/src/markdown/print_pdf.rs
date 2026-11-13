//! `apps/markdown/src/main/print-pdf.ts`: shared pagination for PDF and PNG
//! export, with document scripts disabled.
//!
//! The window comes from the caller as a [`PrintWindow`] (the
//! `new BrowserWindow(...)` and its `webPreferences` stay with it);
//! `os.tmpdir()` is a parameter.

use jscompat::node_path::host::join;
use serde_json::{Map, Number, Value};

use super::print_document::MarkdownPrintOptions;
use crate::node_fs::{mkdtemp_random, node_error};
use crate::packages::electron_utils::print_html_pdf::PrintWindow;
use crate::packages::electron_utils::print_window::{JsError, rm_recursive_force};

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

/// `printMarkdownPdf(html, options)`: the PDF bytes. Whatever the steps throw
/// goes out, after the window is destroyed and the folder removed; a window
/// that cannot be destroyed leaves the folder, as in the TypeScript.
pub fn print_markdown_pdf<W: PrintWindow>(
    create_window: impl FnOnce() -> Result<W, JsError>,
    html: &str,
    options: &MarkdownPrintOptions,
    tmp_dir: &str,
) -> Result<Vec<u8>, JsError> {
    let work_dir = mkdtemp_random(&join(&[tmp_dir, "seuoffice-md-print-"]))?;
    let mut print_win: Option<W> = None;
    let printed = (|| -> Result<Vec<u8>, JsError> {
        let window = print_win.insert(create_window()?);
        let html_path = join(&[&work_dir, "print.html"]);
        std::fs::write(&html_path, html).map_err(|e| node_error(&e, "open", &html_path))?;
        window.load_file(&html_path)?;
        window.print_to_pdf(&pdf_options(options))
    })();
    if let Some(window) = print_win.as_mut() {
        window.destroy()?;
    }
    rm_recursive_force(&work_dir)?;
    printed
}
