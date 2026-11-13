//! `apps/slides/src/main/print-window.ts`: the slides editor's print entry over
//! `printHtmlDocument` of electron-utils. The print runs as the steps of a
//! [`PrintStep`]: [`begin_print_slides_html`] starts it, the caller carries
//! out each step on the throwaway [`PrintWindow`] and answers it, and
//! [`finish_print_slides_html`] turns what [`PrintStep::Done`] holds into the
//! answer. `process.platform` and `os.tmpdir()` come from the caller.

use serde::Serialize;

pub use crate::packages::electron_utils::print_window::PrintDialogWindow as PrintWindow;
use crate::packages::electron_utils::print_window::{
    JsError, PrintDialogOutcome, PrintDocumentOptions, PrintStep, begin_print,
};

/// What `printSlidesHtml` answers: `{ ok, error? }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SlidesPrintResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// `printSlidesHtml(html, win, platform)` up to its first await.
pub fn begin_print_slides_html(
    html: &str,
    win: &mut dyn PrintWindow,
    platform: &str,
    tmp_dir: &str,
) -> PrintStep {
    let options = PrintDocumentOptions {
        html,
        file_name: Some("slides.html"),
        dir_prefix: Some("seuoffice-slides-print-"),
        platform,
        tmp_dir,
    };
    begin_print(win, &options)
}

/// The rest of `printSlidesHtml` once the print is [`PrintStep::Done`]. Cancel
/// comes back as a bare `{ ok: false }` so the renderer keeps its print dialog
/// open. `Err` is what `printHtmlDocument` throws (a `finally` that fails).
pub fn finish_print_slides_html(
    printed: Result<PrintDialogOutcome, JsError>,
) -> Result<SlidesPrintResult, JsError> {
    Ok(match printed? {
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
