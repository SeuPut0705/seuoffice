//! `apps/sheets/src/main/save-failure-log.ts`.

use std::fs::{self, OpenOptions};
use std::io::Write;

use jscompat::{
    js_regex, json_quote, number_to_string, slice_utf16, to_iso_string, trim, value_to_string,
};
use serde_json::Value;

pub const SAVE_FAILURE_LOG_FILE: &str = "sheets-save-failures.jsonl";
pub const SAVE_FAILURE_LOG_MAX_BYTES: f64 = 64.0 * 1024.0;
const DETAIL_MAX_CHARS: usize = 240;
const SCHEMA_ISSUES_SHOWN: usize = 4;

/// `ReopenFailureKind`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReopenFailureKind {
    /// the sidecar read the file and refused it
    Unreadable,
    /// the sidecar answered, but the reply did not match what the app expects
    ReplyShape,
    /// no answer within the request limit
    Timeout,
    /// the sidecar process ended or could not be reached
    SidecarEnded,
}

impl ReopenFailureKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ReopenFailureKind::Unreadable => "unreadable",
            ReopenFailureKind::ReplyShape => "reply-shape",
            ReopenFailureKind::Timeout => "timeout",
            ReopenFailureKind::SidecarEnded => "sidecar-ended",
        }
    }
}

/// `ReopenFailure`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReopenFailure {
    pub kind: ReopenFailureKind,
    pub detail: String,
}

/// UTF-16 code units of a text (`text.length`)
fn length_utf16(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Windows (`C:\…`, `\\server\…`) and POSIX absolute paths, to the next space,
/// quote or closing bracket. A slash after `<` is an XML end tag (`</fonts>`),
/// which names the broken part and stays.
const PATH_PATTERN: &str = r#"(?:[A-Za-z]:[\\/]|\\\\|(?<![\w.<])\/(?=[^\s/]))[^\s'"`<>|)\]]*"#;

pub fn scrub_detail(text: &str) -> String {
    let collapsed = js_regex!(r"\s+", "g").replace_all(text, |_| " ".to_owned());
    // punctuation closing the sentence stays outside the path
    let one_line = js_regex!(PATH_PATTERN, "g").replace_all(trim(&collapsed), |found| {
        let tail = js_regex!(r"[.,;:]+$")
            .exec(found.as_str())
            .map_or("", |m| m.as_str());
        format!("<path>{tail}")
    });
    if length_utf16(&one_line) > DETAIL_MAX_CHARS {
        format!(
            "{}…",
            slice_utf16(&one_line, 0.0, Some((DETAIL_MAX_CHARS - 1) as f64))
        )
    } else {
        one_line
    }
}

/// One `issue` of a `ZodError`: its path (a string or a number each) and code.
#[derive(Debug, Clone, PartialEq)]
pub struct ZodIssue {
    pub path: Vec<Value>,
    pub code: String,
}

/// What `describeReopenFailure` is given.
#[derive(Debug, Clone, PartialEq)]
pub enum ReopenError {
    /// a `ZodError`: its `issues`
    Zod(Vec<ZodIssue>),
    /// an `Error`: its `message`
    Error(String),
    /// another value, read as `String(value)` (`None` is `undefined`)
    Other(Option<Value>),
}

pub fn describe_reopen_failure(error: &ReopenError) -> ReopenFailure {
    if let ReopenError::Zod(issues) = error {
        let shown: Vec<String> = issues
            .iter()
            .take(SCHEMA_ISSUES_SHOWN)
            .map(|issue| {
                let path = issue
                    .path
                    .iter()
                    .map(|segment| value_to_string(Some(segment)))
                    .collect::<Vec<_>>()
                    .join(".");
                let path = if path.is_empty() { "(root)" } else { &path };
                format!("{path} {}", issue.code)
            })
            .collect();
        let more = issues.len() - shown.len();
        let tail = if more > 0 {
            format!("; +{more}")
        } else {
            String::new()
        };
        return ReopenFailure {
            kind: ReopenFailureKind::ReplyShape,
            detail: scrub_detail(&format!("{}{tail}", shown.join("; "))),
        };
    }
    let message = match error {
        ReopenError::Error(message) => message.clone(),
        ReopenError::Other(value) => value_to_string(value.as_ref()),
        ReopenError::Zod(_) => unreachable!("answered above"),
    };
    if message == "XLSX sidecar request timed out." {
        return ReopenFailure {
            kind: ReopenFailureKind::Timeout,
            detail: String::new(),
        };
    }
    if js_regex!(r"^XLSX sidecar (?:exited|stopped|stdin failed|failed to start)").test(&message) {
        return ReopenFailure {
            kind: ReopenFailureKind::SidecarEnded,
            detail: scrub_detail(&message),
        };
    }
    ReopenFailure {
        kind: ReopenFailureKind::Unreadable,
        detail: scrub_detail(&message),
    }
}

/// The bracketed tail shown after the localized message.
pub fn reopen_failure_note(failure: &ReopenFailure) -> String {
    if failure.detail.is_empty() {
        format!("[{}]", failure.kind.as_str())
    } else {
        format!("[{}: {}]", failure.kind.as_str(), failure.detail)
    }
}

/// `SessionSource`: the parts of a sheets session that tell what it was
/// opened from, read from a JSON object (a key left out is `undefined`).
pub fn session_source_format(session: &Value) -> String {
    let defined = |key: &str| session.get(key).is_some();
    let is_true = |key: &str| session.get(key) == Some(&Value::Bool(true));
    let base = if defined("csvSourcePath") || is_true("csvImport") {
        "csv".to_owned()
    } else if is_true("unsavedNew") {
        "new".to_owned()
    } else if defined("suggestSaveAs") && defined("importTempDir") {
        "converted".to_owned()
    } else {
        let path = value_to_string(session.get("path"));
        js_regex!(r"\.([A-Za-z0-9]{1,5})$")
            .exec(&path)
            .and_then(|m| m.get(1))
            .map_or_else(|| "unknown".to_owned(), str::to_lowercase)
    };
    if defined("password") {
        format!("{base}+encrypted")
    } else {
        base
    }
}

/// `SaveFailureEntry`
#[derive(Debug, Clone, PartialEq)]
pub struct SaveFailureEntry {
    pub failure: ReopenFailure,
    /// lower-case extension of the file the session was opened from
    pub source_format: String,
    /// the size of the staged output (`None` is `null`)
    pub staged_bytes: Option<f64>,
    pub app_version: String,
}

fn trim_file(file: &str, max_bytes: f64) {
    let Ok(meta) = fs::metadata(file) else {
        return;
    };
    if meta.len() as f64 <= max_bytes {
        return;
    }
    let Ok(bytes) = fs::read(file) else { return };
    let text = String::from_utf8_lossy(&bytes);
    let units: Vec<u16> = text.encode_utf16().collect();
    let half = &units[units.len() / 2..];
    let rest = match half.iter().position(|&unit| unit == u16::from(b'\n')) {
        None => String::new(),
        Some(first_break) => String::from_utf16_lossy(&half[first_break + 1..]),
    };
    let _ = fs::write(file, rest);
}

/// Best effort: a record that cannot be written never turns into a second
/// error. `now_ms` is the `Date` of the record; one that is not a time makes
/// `toISOString` throw, which nothing is written for.
pub fn append_save_failure(file: &str, entry: &SaveFailureEntry, now_ms: f64, max_bytes: f64) {
    let Some(time) = to_iso_string(now_ms) else {
        return;
    };
    let bytes = match entry.staged_bytes {
        None => "null".to_owned(),
        Some(x) if x.is_finite() => number_to_string(x),
        Some(_) => "null".to_owned(),
    };
    let line = format!(
        "{{\"time\":{},\"app\":{},\"source\":{},\"bytes\":{},\"kind\":{},\"detail\":{}}}",
        json_quote(&time),
        json_quote(&entry.app_version),
        json_quote(&entry.source_format),
        bytes,
        json_quote(entry.failure.kind.as_str()),
        json_quote(&entry.failure.detail),
    );
    let appended = OpenOptions::new()
        .append(true)
        .create(true)
        .open(file)
        .and_then(|mut handle| handle.write_all(format!("{line}\n").as_bytes()));
    if appended.is_ok() {
        trim_file(file, max_bytes);
    }
}
