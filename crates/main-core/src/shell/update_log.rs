//! `apps/shell/src/main/update-log.ts`.

use std::fs::{self, OpenOptions};
use std::io::{self, Write};

use jscompat::{
    JsMap, JsonValue, index_of, js_regex, json_to_string, math_round, number_to_string,
    replace_first, slice_utf16, to_iso_string,
};

pub const UPDATE_LOG_FILE: &str = "update-log.txt";
pub const UPDATE_LOG_MAX_BYTES: f64 = 256.0 * 1024.0;
/// a longer entry (a deep stack) is cut, so trimming never empties the file
const LINE_MAX_CHARS: f64 = 4096.0;

/// What `text(message: unknown)` is handed.
pub enum LogMessage<'a> {
    /// `undefined`
    Undefined,
    /// an `Error`: `stack ?? message`
    Error {
        stack: Option<&'a str>,
        message: &'a str,
    },
    /// any other value, as `JSON.parse` makes it
    Value(&'a JsonValue),
}

/// `text`
fn text(message: &LogMessage) -> String {
    match message {
        LogMessage::Error { stack, message } => stack.unwrap_or(message).to_string(),
        LogMessage::Value(JsonValue::String(s)) => s.clone(),
        // JSON.stringify(undefined) is undefined, so String(undefined)
        LogMessage::Undefined => "undefined".to_string(),
        LogMessage::Value(v) => json_to_string(*v).expect("a parsed JSON value serializes"),
    }
}

/// `trim`
fn trim(file: &str, max_bytes: f64) -> io::Result<()> {
    let Ok(meta) = fs::metadata(file) else {
        return Ok(());
    };
    if (meta.len() as f64) <= max_bytes {
        return Ok(());
    }
    let content = String::from_utf8_lossy(&fs::read(file)?).into_owned();
    let length = content.encode_utf16().count();
    let keep_from = length - length / 2;
    // content.indexOf('\n', keepFrom) on the text from keepFrom on
    let rest = slice_utf16(&content, keep_from as f64, None);
    let kept = match index_of(&rest, "\n", 0) {
        Some(at) => &rest[at + 1..],
        None => "",
    };
    fs::write(file, kept)
}

/// The logger `createUpdateLog` returns; `now` answers `now().getTime()`.
pub struct UpdateLog<N: FnMut() -> f64> {
    file: String,
    max_bytes: f64,
    now: N,
}

/// `createUpdateLog`; pass [`UPDATE_LOG_MAX_BYTES`] for the default size.
pub fn create_update_log<N: FnMut() -> f64>(file: &str, max_bytes: f64, now: N) -> UpdateLog<N> {
    UpdateLog {
        file: file.to_string(),
        max_bytes,
        now,
    }
}

impl<N: FnMut() -> f64> UpdateLog<N> {
    fn write(&mut self, level: &str, message: &LogMessage) {
        // a record that cannot be written never gets in the way of updating
        let _ = self.try_write(level, message);
    }

    fn try_write(&mut self, level: &str, message: &LogMessage) -> Option<()> {
        // one entry per line: a multi-line stack stays one entry
        let joined = js_regex!(r"\r?\n", "g").replace_all(&text(message), |_| " | ".to_string());
        let line = slice_utf16(&joined, 0.0, Some(LINE_MAX_CHARS));
        let stamp = to_iso_string((self.now)())?;
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&self.file)
            .ok()?;
        file.write_all(format!("{stamp} {level} {line}\n").as_bytes())
            .ok()?;
        drop(file);
        trim(&self.file, self.max_bytes).ok()
    }

    pub fn info(&mut self, message: &LogMessage) {
        self.write("info", message);
    }
    pub fn warn(&mut self, message: &LogMessage) {
        self.write("warn", message);
    }
    pub fn error(&mut self, message: &LogMessage) {
        self.write("error", message);
    }
    pub fn debug(&mut self, message: &LogMessage) {
        self.write("debug", message);
    }
}

/// A value of `UpdateStepFields`; `null` and `undefined` are `None` at the
/// field and are left out.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StepField<'a> {
    Str(&'a str),
    Num(f64),
}

/// What `createUpdateSteps` returns: call [`UpdateSteps::step`].
pub struct UpdateSteps<W: FnMut(&str), N: FnMut() -> f64> {
    write: W,
    now: N,
    /// `None` for a start already deleted (jscompat's map has no delete; only
    /// membership is observable here)
    started_at: JsMap<Option<f64>>,
}

/// `createUpdateSteps`; `now` is `performance.now()`.
pub fn create_update_steps<W: FnMut(&str), N: FnMut() -> f64>(
    write: W,
    now: N,
) -> UpdateSteps<W, N> {
    UpdateSteps {
        write,
        now,
        started_at: JsMap::new(),
    }
}

impl<W: FnMut(&str), N: FnMut() -> f64> UpdateSteps<W, N> {
    /// One call of the function `createUpdateSteps` returns; `fields` in the
    /// order of `Object.entries`.
    pub fn step(&mut self, step: &str, fields: &[(&str, Option<StepField>)]) {
        let at = (self.now)();
        let span = replace_first(js_regex!(r"-(start|end)$"), 1, step, "");
        let mut parts = vec![format!("phase {step}")];
        if step.ends_with("-start") {
            self.started_at.set(span.clone(), Some(at));
        }
        if step.ends_with("-end") {
            let start = self.started_at.get(&span).copied().flatten();
            self.started_at.set(span.clone(), None);
            if let Some(start) = start {
                parts.push(format!("ms={}", number_to_string(math_round(at - start))));
            }
        }
        for (key, value) in fields {
            let Some(value) = value else { continue };
            let text = match value {
                StepField::Str(s) => (*s).to_string(),
                StepField::Num(x) => number_to_string(*x),
            };
            let text = js_regex!(r"\s+", "g").replace_all(&text, |_| "_".to_string());
            parts.push(format!("{key}={text}"));
        }
        (self.write)(&parts.join(" "));
    }
}

/// `fileBytes`: `file` is `None` where it is not a string.
pub fn file_bytes(file: Option<&str>) -> Option<u64> {
    fs::metadata(file?).ok().map(|m| m.len())
}
