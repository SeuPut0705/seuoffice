//! `apps/docs/src/main/print-args.ts`: validators for the PDF print and export
//! IPC arguments. The values are what the renderer sent, so each parameter is
//! the JSON value read as the TypeScript's `unknown` (`None` = `undefined`).

use jscompat::{JsonValue, math_round};

pub use crate::packages::electron_utils::print_job::print_job_options;

/// `typeof v === 'number'`
fn number(v: Option<&JsonValue>) -> Option<f64> {
    match v {
        Some(JsonValue::Number(x)) => Some(*x),
        _ => None,
    }
}

/// Printable page dimension in twips: 0.1in (Word's floor) .. 50in.
pub fn valid_print_dim(v: Option<&JsonValue>) -> bool {
    number(v).is_some_and(|x| (144.0..=72000.0).contains(&x))
}

/// Print scale factor: 0.1 .. 5 (`undefined` = Chromium default).
pub fn valid_print_scale(scale: Option<&JsonValue>) -> bool {
    scale.is_none() || number(scale).is_some_and(|x| (0.1..=5.0).contains(&x))
}

/// The geometry guard shared by the printToPDF IPC handlers.
pub fn valid_print_geometry(
    page_width_twips: Option<&JsonValue>,
    page_height_twips: Option<&JsonValue>,
    scale: Option<&JsonValue>,
) -> bool {
    valid_print_dim(page_width_twips)
        && valid_print_dim(page_height_twips)
        && valid_print_scale(scale)
}

/// `printScaleOption(scale)`: `Some(scale)` is `{ scale }`, `None` is `{}`.
/// Finite, positive and not 1.
pub fn print_scale_option(scale: Option<&JsonValue>) -> Option<f64> {
    number(scale).filter(|x| x.is_finite() && *x > 0.0 && *x != 1.0)
}

/// The document's own paper size in twips.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrintPaper {
    pub width_twips: f64,
    pub height_twips: f64,
}

/// `validPrintPaper(paper)`: absent or malformed is `None`, never a wrong size.
pub fn valid_print_paper(paper: Option<&JsonValue>) -> Option<PrintPaper> {
    let paper = paper?;
    // `typeof paper !== 'object' || paper === null`: an array is an object
    if !matches!(paper, JsonValue::Object(_) | JsonValue::Array(_)) {
        return None;
    }
    let width = paper.get("widthTwips");
    let height = paper.get("heightTwips");
    let width = width.as_deref();
    let height = height.as_deref();
    if !valid_print_dim(width) || !valid_print_dim(height) {
        return None;
    }
    Some(PrintPaper {
        width_twips: number(width)?,
        height_twips: number(height)?,
    })
}

/// `printPaperOption(paper)`: `Some((width, height))` is
/// `{ pageSize: { width, height } }` in microns, `None` is `{}`.
pub fn print_paper_option(paper: Option<&JsonValue>) -> Option<(f64, f64)> {
    let geometry = valid_print_paper(paper)?;
    // 1440 twips to the inch, 25400 microns to the inch
    Some((
        math_round(geometry.width_twips * 25_400.0 / 1440.0),
        math_round(geometry.height_twips * 25_400.0 / 1440.0),
    ))
}
