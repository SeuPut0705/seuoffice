//! `apps/slides/src/main/print-window.ts`: the slides editor's print entry over
//! `printHtmlDocument` of electron-utils. The throwaway window is the caller's
//! [`PrintWindow`]; `process.platform` and `os.tmpdir()` come from the caller.

use serde::Serialize;

pub use crate::packages::electron_utils::print_window::PrintDialogWindow as PrintWindow;
use crate::packages::electron_utils::print_window::{
    JsError, PrintDialogOutcome, PrintDocumentOptions, print_html_document,
};

/// What `printSlidesHtml` answers: `{ ok, error? }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlidesPrintResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `printSlidesHtml(html, win, platform)`. Cancel comes back as a bare
/// `{ ok: false }` so the renderer keeps its print dialog open. `Err` is what
/// `printHtmlDocument` throws (a `finally` that fails).
pub fn print_slides_html(
    html: &str,
    win: &mut dyn PrintWindow,
    platform: &str,
    tmp_dir: &str,
    log_probe_error: &mut dyn FnMut(&str),
) -> Result<SlidesPrintResult, JsError> {
    let options = PrintDocumentOptions {
        html,
        file_name: Some("slides.html"),
        dir_prefix: Some("seuoffice-slides-print-"),
        platform,
        tmp_dir,
    };
    let outcome = print_html_document(win, &options, log_probe_error)?;
    Ok(match outcome {
        PrintDialogOutcome::Failed(error) => SlidesPrintResult {
            ok: false,
            error: Some(error),
        },
        PrintDialogOutcome::Canceled => SlidesPrintResult {
            ok: false,
            error: None,
        },
        PrintDialogOutcome::Ok => SlidesPrintResult {
            ok: true,
            error: None,
        },
    })
}
