//! `packages/electron-utils/src/print-job.ts`.

use jscompat::{JsRegex, js_regex, math_round};
use serde::Serialize;
use serde_json::{Map, Value};

use super::printer_options::{is_valid_option_name, is_valid_option_value};

/// `PrintDuplex`
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum PrintDuplex {
    #[serde(rename = "simplex")]
    Simplex,
    #[serde(rename = "longEdge")]
    LongEdge,
    #[serde(rename = "shortEdge")]
    ShortEdge,
}

/// `{ width, height }`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageSize {
    pub width: f64,
    pub height: f64,
}

/// Electron's print() takes a custom paper in microns (an inch is 25400 of them).
const MICRONS_PER_INCH: f64 = 25_400.0;

/// `DUPLEX_MODES.has(value)`
fn duplex_mode(value: &str) -> Option<PrintDuplex> {
    match value {
        "simplex" => Some(PrintDuplex::Simplex),
        "longEdge" => Some(PrintDuplex::LongEdge),
        "shortEdge" => Some(PrintDuplex::ShortEdge),
        _ => None,
    }
}

/// webContents.print fields for the dialog's job options, the keys in the
/// order the TypeScript sets them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PrintJobOptions {
    pub silent: bool,
    #[serde(rename = "pageSizeIn", skip_serializing_if = "Option::is_none")]
    pub page_size_in: Option<PageSize>,
    #[serde(rename = "pageSize", skip_serializing_if = "Option::is_none")]
    pub page_size: Option<PageSize>,
    #[serde(rename = "deviceName", skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copies: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collate: Option<bool>,
    #[serde(rename = "duplexMode", skip_serializing_if = "Option::is_none")]
    pub duplex_mode: Option<PrintDuplex>,
    /// the option objects as they came, with every key they had
    #[serde(rename = "driverOptions", skip_serializing_if = "Option::is_none")]
    pub driver_options: Option<Vec<Value>>,
}

/// `typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 200`
fn paper_side(value: Option<&Value>) -> Option<f64> {
    let x = value?.as_f64()?;
    (x.is_finite() && x > 0.0 && x <= 200.0).then_some(x)
}

/// A named printer ('' = OS default) prints silently; null/omitted keeps the
/// system dialog, which then owns copies/duplex itself. Out-of-range values
/// are dropped, not clamped.
pub fn print_job_options(raw: Option<&Value>) -> PrintJobOptions {
    let mut out = PrintJobOptions {
        silent: false,
        page_size_in: None,
        page_size: None,
        device_name: None,
        copies: None,
        collate: None,
        duplex_mode: None,
        driver_options: None,
    };
    // `typeof raw !== 'object' || raw === null`; an array is an object with none of these keys
    let empty = Map::new();
    let job = match raw {
        Some(Value::Object(job)) => job,
        Some(Value::Array(_)) => &empty,
        _ => return out,
    };
    let silent = matches!(job.get("deviceName"), Some(Value::String(_)));
    out.silent = silent;
    if let Some(Value::Object(size)) = job.get("pageSizeIn")
        && let (Some(width), Some(height)) = (
            paper_side(size.get("width")),
            paper_side(size.get("height")),
        )
    {
        out.page_size_in = Some(PageSize { width, height });
        out.page_size = Some(PageSize {
            width: math_round(width * MICRONS_PER_INCH),
            height: math_round(height * MICRONS_PER_INCH),
        });
    }
    if !silent {
        return out;
    }
    if let Some(Value::String(name)) = job.get("deviceName")
        && !name.is_empty()
    {
        out.device_name = Some(name.clone());
    }
    if let Some(copies) = job.get("copies").and_then(Value::as_f64)
        && copies.is_finite()
        && copies.fract() == 0.0
        && (1.0..=999.0).contains(&copies)
    {
        out.copies = Some(copies);
    }
    if let Some(Value::Bool(collate)) = job.get("collate") {
        out.collate = Some(*collate);
    }
    if let Some(Value::String(duplex)) = job.get("duplex") {
        out.duplex_mode = duplex_mode(duplex);
    }
    if let Some(Value::Array(driver)) = job.get("driverOptions") {
        let clean: Vec<Value> = driver
            .iter()
            .take(16)
            .filter(|option| match option {
                Value::Object(o) => {
                    matches!(o.get("name"), Some(Value::String(n)) if is_valid_option_name(n))
                        && matches!(o.get("value"), Some(Value::String(v)) if is_valid_option_value(v))
                }
                _ => false,
            })
            .cloned()
            .collect();
        if !clean.is_empty() {
            out.driver_options = Some(clean);
        }
    }
    out
}

fn cancel_re() -> &'static JsRegex {
    js_regex!(r"cancel", "i")
}

/// `{ ok, error? }`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PrintOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The IPC answer for one `webContents.print` callback: success passes, and a
/// cancel the user chose in the interactive dialog is not an error (the
/// caller keeps the dialog open). Anything else the print system reports is an
/// error.
pub fn print_outcome(success: bool, failure_reason: Option<&str>, silent: bool) -> PrintOutcome {
    if success {
        return PrintOutcome {
            ok: true,
            error: None,
        };
    }
    // `failureReason &&`: the empty string is false
    let reason = failure_reason.filter(|reason| !reason.is_empty());
    if !silent && reason.is_some_and(|reason| cancel_re().test(reason)) {
        return PrintOutcome {
            ok: false,
            error: None,
        };
    }
    PrintOutcome {
        ok: false,
        error: reason.map(str::to_owned),
    }
}
