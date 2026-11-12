//! `apps/shell/src/main/crash-log.ts`.
//!
//! A `CrashEntry` is an object whose fields the caller may fill with anything:
//! `crash_line` reads each by its type, as the TypeScript does, so it is a
//! `JsObject<JsonValue>`. The `Date` parameter is `now_ms`.

use std::io::Write;

use jscompat::{JsObject, JsonValue, js_regex, json_stringify, to_iso_string};

pub const CRASH_LOG_FILE: &str = "crash-log.jsonl";
/// past this size the oldest lines are dropped, keeping about half
pub const CRASH_LOG_MAX_BYTES: f64 = 64.0 * 1024.0;

/// `CrashEntry` (and `CrashMemory`): `kind`, `reason`, `exitCode`, `editor`,
/// `process`, `program`, `cause`, `upMin`, `beatAgeMin` and the memory figures.
pub type CrashEntry = JsObject<JsonValue>;

/// `RangeError: Invalid time value`, of `toISOString` on an invalid `Date`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidTimeValue;

impl std::fmt::Display for InvalidTimeValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Invalid time value")
    }
}

// short identifier-like words only: anything else (a message, a path) is dropped
fn safe_word(value: Option<&JsonValue>) -> Option<&str> {
    match value {
        Some(JsonValue::String(text))
            if js_regex!(r"^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,47}$").test(text) =>
        {
            Some(text)
        }
        _ => None,
    }
}

const COUNT_FIELDS: [&str; 10] = [
    "appMB",
    "freeMB",
    "totalMB",
    "aiStreams",
    "cliChildren",
    "mainMB",
    "heapMB",
    "heapLimitMB",
    "upMin",
    "beatAgeMin",
];

/// `Number.isInteger(value)` of a number
fn is_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0
}

/// one log line, holding only the allowed fields
pub fn crash_line(entry: &CrashEntry, now_ms: f64) -> Result<String, InvalidTimeValue> {
    let at = to_iso_string(now_ms).ok_or(InvalidTimeValue)?;
    let mut line: JsObject<JsonValue> = JsObject::new();
    line.set("at", JsonValue::String(at));
    // `kind: entry.kind`: undefined leaves no key in the written line
    if let Some(kind) = entry.get("kind") {
        line.set("kind", kind.clone());
    }
    if let Some(word) = safe_word(entry.get("reason")) {
        line.set("reason", JsonValue::String(word.to_owned()));
    }
    if let Some(JsonValue::Number(code)) = entry.get("exitCode")
        && is_integer(*code)
    {
        line.set("exitCode", JsonValue::Number(*code));
    }
    for key in ["editor", "process", "program", "cause"] {
        if let Some(word) = safe_word(entry.get(key)) {
            line.set(key, JsonValue::String(word.to_owned()));
        }
    }
    for key in COUNT_FIELDS {
        if let Some(JsonValue::Number(value)) = entry.get(key)
            && is_integer(*value)
            && *value >= 0.0
        {
            line.set(key, JsonValue::Number(*value));
        }
    }
    Ok(format!("{}\n", json_stringify(&JsonValue::Object(line))))
}

/// What `errorReason` is given: an `Error` with the `name` and `code` it
/// holds (`None` is `undefined`), or another value, by its `typeof`.
#[derive(Debug, Clone, PartialEq)]
pub enum Thrown {
    Error {
        name: Option<JsonValue>,
        code: Option<JsonValue>,
    },
    Other(&'static str),
}

/// the error's class name and code (`TypeError`, `Error:ENOENT`), never its message
pub fn error_reason(error: &Thrown) -> String {
    match error {
        Thrown::Other(kind) => (*kind).to_owned(),
        Thrown::Error { name, code } => {
            let name = safe_word(name.as_ref()).unwrap_or("Error");
            match safe_word(code.as_ref()) {
                Some(code) => format!("{name}:{code}"),
                None => name.to_owned(),
            }
        }
    }
}

/// the newest lines of `text` that fit in `budget` bytes
fn tail_lines(text: &str, budget: f64) -> String {
    let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut size = 0.0;
    for line in lines.iter().rev() {
        let bytes = (line.len() + 1) as f64;
        if size + bytes > budget {
            break;
        }
        kept.push(line);
        size += bytes;
    }
    kept.iter().rev().map(|l| format!("{l}\n")).collect()
}

/// append one entry, trimming the oldest lines once the file passes the cap;
/// never fails on the file (a crash record must not make things worse). The
/// one error is `toISOString`'s, which `crash_line` raises before the file is touched.
pub fn append_crash_log(
    file_path: &str,
    entry: &CrashEntry,
    max_bytes: f64,
    now_ms: f64,
) -> Result<(), InvalidTimeValue> {
    let line = crash_line(entry, now_ms)?;
    // no log yet: size 0
    let size = std::fs::metadata(file_path).map_or(0, |meta| meta.len());
    let write = || -> std::io::Result<()> {
        if size as f64 + line.len() as f64 > max_bytes {
            let kept = match std::fs::read(file_path) {
                Ok(bytes) => {
                    tail_lines(&String::from_utf8_lossy(&bytes), (max_bytes / 2.0).floor())
                }
                // unreadable: start over
                Err(_) => String::new(),
            };
            std::fs::write(file_path, format!("{kept}{line}"))
        } else {
            std::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(file_path)?
                .write_all(line.as_bytes())
        }
    };
    // best effort
    let _ = write();
    Ok(())
}
