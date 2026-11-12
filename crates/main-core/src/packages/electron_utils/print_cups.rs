//! `packages/electron-utils/src/print-cups.ts`.
//!
//! The CUPS print route for silent jobs on macOS: the caller renders the pages
//! to PDF and hands the bytes here with the resolved options; `lp` spools a
//! real job whose failures come back with a non-zero exit and a message.

use jscompat::{number_to_string, trim};
use serde::Serialize;
use serde_json::{Number, Value};

use super::printer_options::{
    CommandOutcome, CommandRunner, is_valid_option_name, is_valid_option_value,
};

/// `'simplex' | 'longEdge' | 'shortEdge'`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DuplexMode {
    Simplex,
    LongEdge,
    ShortEdge,
}

impl DuplexMode {
    /// `SIDES[mode]`
    fn sides(self) -> &'static str {
        match self {
            DuplexMode::Simplex => "one-sided",
            DuplexMode::LongEdge => "two-sided-long-edge",
            DuplexMode::ShortEdge => "two-sided-short-edge",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DriverOption {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CupsPrintJob {
    /// CUPS queue name; `None` = the system's default destination
    pub device_name: Option<String>,
    pub copies: Option<f64>,
    pub collate: Option<bool>,
    pub duplex_mode: Option<DuplexMode>,
    pub driver_options: Option<Vec<DriverOption>>,
}

/// The lp argument list for one resolved job. Flags only: lp reads the
/// document from stdin, so no file operand is appended here.
pub fn lp_arguments_for(job: &CupsPrintJob) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();
    // `if (job.deviceName)`: the empty string is false
    if let Some(device) = job.device_name.as_deref().filter(|d| !d.is_empty()) {
        args.push("-d".to_owned());
        args.push(device.to_owned());
    }
    if let Some(copies) = job.copies {
        args.push("-n".to_owned());
        args.push(number_to_string(copies));
    }
    if let Some(collate) = job.collate {
        args.push("-o".to_owned());
        args.push(
            if collate {
                "Collate=True"
            } else {
                "Collate=False"
            }
            .to_owned(),
        );
    }
    if let Some(mode) = job.duplex_mode {
        args.push("-o".to_owned());
        args.push(format!("sides={}", mode.sides()));
    }
    for option in job.driver_options.as_deref().unwrap_or(&[]) {
        // charset re-checked here: these strings become spawn arguments
        if is_valid_option_name(&option.name) && is_valid_option_value(&option.value) {
            args.push("-o".to_owned());
            args.push(format!("{}={}", option.name, option.value));
        }
    }
    args
}

/// `PrintToPdfRequest`: units are the printToPDF ones (inches, scale as a float)
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PrintToPdfRequest {
    pub width_in: Option<f64>,
    pub height_in: Option<f64>,
    pub landscape: Option<bool>,
    /// `{ top, bottom, left, right }`, passed through as it came
    pub margins_in: Option<Value>,
    pub scale: Option<f64>,
    pub print_background: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PageSize {
    pub width: f64,
    pub height: f64,
}

/// What `printToPdfOptionsFor` returns, its keys in the order the TypeScript
/// writes them.
#[derive(Debug, Clone, PartialEq)]
pub struct PrintToPdfOptions {
    pub print_background: bool,
    pub margins: Option<Value>,
    pub page_size: Option<PageSize>,
    pub landscape: Option<bool>,
    pub scale: Option<f64>,
}

impl PrintToPdfOptions {
    pub fn to_value(&self) -> Value {
        let mut map = serde_json::Map::new();
        map.insert("printBackground".into(), Value::Bool(self.print_background));
        if let Some(margins) = &self.margins {
            map.insert("margins".into(), margins.clone());
        }
        if let Some(size) = &self.page_size {
            let mut page = serde_json::Map::new();
            page.insert("width".into(), number(size.width));
            page.insert("height".into(), number(size.height));
            map.insert("pageSize".into(), Value::Object(page));
        }
        if let Some(landscape) = self.landscape {
            map.insert("landscape".into(), Value::Bool(landscape));
        }
        if let Some(scale) = self.scale {
            map.insert("scale".into(), number(scale));
        }
        Value::Object(map)
    }
}

fn number(x: f64) -> Value {
    Number::from_f64(x).map_or(Value::Null, Value::Number)
}

/// printToPDF options assembled from the page geometry the caller resolved.
/// Omitted pieces fall to Chromium's defaults rather than being sent as zeros
/// the caller did not mean.
pub fn print_to_pdf_options_for(request: &PrintToPdfRequest) -> PrintToPdfOptions {
    PrintToPdfOptions {
        print_background: request.print_background.unwrap_or(true),
        margins: request.margins_in.clone(),
        page_size: match (request.width_in, request.height_in) {
            (Some(width), Some(height)) => Some(PageSize { width, height }),
            _ => None,
        },
        // `request.landscape ?`
        landscape: request.landscape.filter(|&on| on).map(|_| true),
        scale: request.scale.filter(|&scale| scale != 1.0),
    }
}

/// `{ ok, error? }`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CupsResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Runs `lp` with the PDF on stdin and settles with the queue's verdict: a
/// zero exit reports the accepted job; anything else surfaces lp's own
/// message (a mangled or missing queue name fails here instead of vanishing).
pub fn print_pdf_via_cups(
    pdf: &[u8],
    job: &CupsPrintJob,
    run: &mut CommandRunner<'_>,
) -> CupsResult {
    match run("/usr/bin/lp", &lp_arguments_for(job), Some(pdf)) {
        CommandOutcome::Failed(message) => CupsResult {
            ok: false,
            error: Some(message),
        },
        CommandOutcome::Exited {
            code,
            stdout,
            stderr,
        } => {
            if code == Some(0) {
                return CupsResult {
                    ok: true,
                    error: None,
                };
            }
            let stderr = String::from_utf8_lossy(&stderr);
            let stdout = String::from_utf8_lossy(&stdout);
            // `stderr.trim() || stdout.trim() || ...`
            let error = [trim(&stderr), trim(&stdout)]
                .into_iter()
                .find(|text| !text.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| match code {
                    Some(code) => format!("lp exited with code {code}"),
                    None => "lp exited with code null".to_owned(),
                });
            CupsResult {
                ok: false,
                error: Some(error),
            }
        }
    }
}
