//! `packages/electron-utils/src/printer-options.ts`.
//!
//! Driver option groups as CUPS reports them: `lpoptions -p <queue> -l` lines
//! read `Name/Translation: value1 value2 *default`. Names and values come back
//! as spawn arguments, so both are charset-guarded here and in every consumer.
//!
//! A child process is run by the caller's [`CommandRunner`] (the TypeScript's
//! `execFile` and `spawn`), so the comparison can hand both sides the same
//! fake.

use jscompat::{JsRegex, js_regex, trim};
use serde::Serialize;

/// What running a command came to, as the TypeScript's callbacks see it.
#[derive(Debug, Clone, PartialEq)]
pub enum CommandOutcome {
    /// the process did not start (`error` event, `err.message`)
    Failed(String),
    /// the process ended: `code` is `None` where a signal ended it
    Exited {
        code: Option<i32>,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
}

/// Runs `file` with `args` and, when given, the bytes on its standard input.
pub type CommandRunner<'a> = dyn FnMut(&str, &[String], Option<&[u8]>) -> CommandOutcome + 'a;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PrinterOption {
    pub name: String,
    /// the driver's own display name (locale data, not a UI string)
    pub translation: String,
    pub values: Vec<String>,
    #[serde(rename = "defaultValue", skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}

fn option_name_re() -> &'static JsRegex {
    js_regex!(r"^[A-Za-z0-9_.+-]{1,64}$")
}

fn option_value_re() -> &'static JsRegex {
    js_regex!(r"^[A-Za-z0-9_.+-]{1,64}$")
}

/// the groups the print dialog knows how to present, in presentation order
pub const DRIVER_OPTION_NAMES: [&str; 3] = ["cupsPrintQuality", "ColorModel", "MediaType"];

/// `isValidOptionName` of a string
pub fn is_valid_option_name(value: &str) -> bool {
    option_name_re().test(value)
}

/// `isValidOptionValue` of a string
pub fn is_valid_option_value(value: &str) -> bool {
    option_value_re().test(value)
}

fn line_re() -> &'static JsRegex {
    js_regex!(r"^([A-Za-z0-9_.+-]+)\/([^:\n]{1,128}):\s*(.+)$")
}

fn white_space_re() -> &'static JsRegex {
    js_regex!(r"\s+")
}

pub fn parse_lp_options(raw: &str) -> Vec<PrinterOption> {
    let mut out = Vec::new();
    for line in raw.split('\n') {
        let Some(m) = line_re().exec(trim(line)) else {
            continue;
        };
        let (Some(name), Some(translation), Some(rest)) = (m.get(1), m.get(2), m.get(3)) else {
            continue;
        };
        let mut values: Vec<String> = Vec::new();
        let mut default_value: Option<String> = None;
        for token in white_space_re().split(rest) {
            let is_default = token.starts_with('*');
            let value = if is_default { &token[1..] } else { token };
            if !option_value_re().test(value) {
                continue;
            }
            if is_default {
                default_value = Some(value.to_owned());
            }
            if !values.iter().any(|v| v == value) {
                values.push(value.to_owned());
            }
        }
        if !option_name_re().test(name) || values.is_empty() {
            continue;
        }
        out.push(PrinterOption {
            name: name.to_owned(),
            translation: trim(translation).to_owned(),
            values,
            default_value,
        });
    }
    out
}

/// Queries one queue's option groups; any failure (unknown queue, no
/// lpoptions) is an empty list: the dialog then simply shows nothing extra.
pub fn query_printer_options(queue: &str, run: &mut CommandRunner<'_>) -> Vec<PrinterOption> {
    let args = ["-p".to_owned(), queue.to_owned(), "-l".to_owned()];
    match run("/usr/bin/lpoptions", &args, None) {
        CommandOutcome::Exited {
            code: Some(0),
            stdout,
            ..
        } => parse_lp_options(&String::from_utf8_lossy(&stdout)),
        _ => Vec::new(),
    }
}
