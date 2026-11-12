//! `apps/shell/src/main/crash-heartbeat.ts`.
//!
//! `startHeartbeat` keeps its timer in the TypeScript. Here the caller owns
//! the timer (every `HEARTBEAT_MS`, `unref`ed in the Electron main): it calls
//! [`HeartbeatHandle::tick`], which is the interval's callback.

use jscompat::node_path::host::join;
use jscompat::{JsObject, JsonValue, json_parse, math_max};
use serde::Serialize;

use super::crash_log::{CRASH_LOG_MAX_BYTES, CrashEntry, append_crash_log};
use crate::node_fs::NodeError;
use crate::packages::electron_utils::atomic_write::write_json_atomic;

pub const HEARTBEAT_FILE: &str = "crash-heartbeat.json";
pub const HEARTBEAT_MS: f64 = 30_000.0;

/// how the run ended on purpose: the quit path, or the OS ending the session
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HeartbeatEnd {
    Quit,
    Os,
}

impl HeartbeatEnd {
    pub fn as_str(self) -> &'static str {
        match self {
            HeartbeatEnd::Quit => "quit",
            HeartbeatEnd::Os => "os",
        }
    }
}

/// `Heartbeat`: `version` is always 1 and written first. The keys are in the
/// order `parseHeartbeat` builds them: `ended` comes after `memory`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Heartbeat {
    pub version: u32,
    #[serde(rename = "startedAt")]
    pub started_at: f64,
    pub at: f64,
    pub memory: JsObject<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended: Option<HeartbeatEnd>,
}

pub fn heartbeat_path(user_data_dir: &str) -> String {
    join(&[user_data_dir, HEARTBEAT_FILE])
}

/// `typeof value === 'number' && Number.isFinite(value) && value >= 0`
fn is_time(value: Option<&JsonValue>) -> Option<f64> {
    match value {
        Some(JsonValue::Number(x)) if x.is_finite() && *x >= 0.0 => Some(*x),
        _ => None,
    }
}

pub fn parse_heartbeat(raw: Option<&JsonValue>) -> Option<Heartbeat> {
    // `!raw || typeof raw !== 'object'`: an array is an object, and has no `version`
    let value = match raw {
        Some(value @ (JsonValue::Object(_) | JsonValue::Array(_))) => value,
        _ => return None,
    };
    if !matches!(value.get("version").as_deref(), Some(JsonValue::Number(v)) if *v == 1.0) {
        return None;
    }
    let started_at = is_time(value.get("startedAt").as_deref())?;
    let at = is_time(value.get("at").as_deref())?;
    let mut memory: JsObject<f64> = JsObject::new();
    let figures: Vec<(String, f64)> = match value.get("memory").as_deref() {
        Some(JsonValue::Object(object)) => object
            .entries()
            .into_iter()
            .filter_map(|(key, figure)| match figure {
                JsonValue::Number(x) => Some((key.to_owned(), *x)),
                _ => None,
            })
            .collect(),
        // Object.entries of an array: its indexes as keys
        Some(JsonValue::Array(items)) => items
            .iter()
            .enumerate()
            .filter_map(|(i, figure)| match figure {
                JsonValue::Number(x) => Some((i.to_string(), *x)),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    for (key, figure) in figures {
        // `memory["__proto__"] = n` sets no key (a number is no prototype)
        if figure.is_finite() && figure.fract() == 0.0 && figure >= 0.0 && key != "__proto__" {
            memory.set(key, figure);
        }
    }
    let ended = match value.get("ended").as_deref() {
        Some(JsonValue::String(text)) if text == "quit" => Some(HeartbeatEnd::Quit),
        Some(JsonValue::String(text)) if text == "os" => Some(HeartbeatEnd::Os),
        _ => None,
    };
    Some(Heartbeat {
        version: 1,
        started_at,
        at,
        memory,
        ended,
    })
}

fn read_heartbeat(file_path: &str) -> Option<Heartbeat> {
    let bytes = std::fs::read(file_path).ok()?;
    // readFileSync(path, 'utf8') keeps a byte order mark; decode without stripping it
    let text = String::from_utf8_lossy(&bytes);
    let parsed = json_parse(&text).ok()?;
    parse_heartbeat(Some(&parsed))
}

const MINUTE: f64 = 60_000.0;

/// The `main-gone` line for the previous run's heartbeat, or `None` when that run
/// ended on purpose (or left no readable heartbeat).
pub fn gone_entry_from(previous: Option<&Heartbeat>, now: f64) -> Option<CrashEntry> {
    let previous = previous?;
    if previous.ended.is_some() {
        return None;
    }
    let mut entry: CrashEntry = JsObject::new();
    for (key, figure) in previous.memory.entries() {
        entry.set(key, JsonValue::Number(*figure));
    }
    entry.set("kind", JsonValue::String("main-gone".to_owned()));
    entry.set(
        "upMin",
        JsonValue::Number(math_max(
            0.0,
            ((previous.at - previous.started_at) / MINUTE).floor(),
        )),
    );
    entry.set(
        "beatAgeMin",
        JsonValue::Number(math_max(0.0, ((now - previous.at) / MINUTE).floor())),
    );
    Some(entry)
}

/// `HeartbeatOptions`
pub struct HeartbeatOptions<'a> {
    pub user_data_dir: &'a str,
    /// the crash log the `main-gone` line goes to
    pub log_path: &'a str,
    /// `Err` is a `memory()` that throws
    pub memory: Box<dyn Fn() -> Result<JsonValue, ()> + 'a>,
    /// `Date.now`; the system clock when `None`
    pub now: Option<Box<dyn Fn() -> f64 + 'a>>,
    /// the clock of `new Date()` in the `main-gone` line (`appendCrashLog`'s
    /// default); the system clock when `None`
    pub wall_clock: Option<Box<dyn Fn() -> f64 + 'a>>,
    /// the atomic userData JSON writer when `None`
    #[allow(clippy::type_complexity)]
    pub write_json: Option<Box<dyn Fn(&str, &JsonValue) -> Result<(), NodeError> + 'a>>,
}

fn system_now() -> f64 {
    match std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) {
        Ok(after) => after.as_millis() as f64,
        Err(before) => -(before.duration().as_millis() as f64),
    }
}

pub struct HeartbeatHandle<'a> {
    file_path: String,
    started_at: f64,
    ended: bool,
    options: HeartbeatOptions<'a>,
}

/// Report the previous run if it died, then beat once for this one. Never fails:
/// a diagnostic must not make anything worse.
pub fn start_heartbeat(options: HeartbeatOptions<'_>) -> HeartbeatHandle<'_> {
    let file_path = heartbeat_path(options.user_data_dir);
    let started_at = options.now.as_ref().map_or_else(system_now, |now| now());
    // best effort (a `toISOString` that throws is caught here too)
    if let Some(gone) = gone_entry_from(read_heartbeat(&file_path).as_ref(), started_at) {
        let wall = options
            .wall_clock
            .as_ref()
            .map_or_else(system_now, |clock| clock());
        let _ = append_crash_log(options.log_path, &gone, CRASH_LOG_MAX_BYTES, wall);
    }
    let mut handle = HeartbeatHandle {
        file_path,
        started_at,
        ended: false,
        options,
    };
    handle.beat(None);
    handle
}

impl HeartbeatHandle<'_> {
    fn beat(&mut self, end: Option<HeartbeatEnd>) {
        // a `memory()` that throws: the beat goes out without figures
        let memory =
            (self.options.memory)().unwrap_or_else(|()| JsonValue::Object(JsObject::new()));
        let at = self
            .options
            .now
            .as_ref()
            .map_or_else(system_now, |now| now());
        let mut value: JsObject<JsonValue> = JsObject::new();
        value.set("version", JsonValue::Number(1.0));
        value.set("startedAt", JsonValue::Number(self.started_at));
        value.set("at", JsonValue::Number(at));
        value.set("memory", memory);
        if let Some(end) = end {
            value.set("ended", JsonValue::String(end.as_str().to_owned()));
        }
        let value = JsonValue::Object(value);
        // best effort
        let _ = match &self.options.write_json {
            Some(write_json) => write_json(&self.file_path, &value),
            None => write_json_atomic(&self.file_path, &value),
        };
    }

    /// The interval's callback: a beat unless the run has ended.
    pub fn tick(&mut self) {
        if !self.ended {
            self.beat(None);
        }
    }

    /// the run is ending on purpose: write the mark now and stop beating
    pub fn mark_ended(&mut self, how: HeartbeatEnd) {
        if self.ended {
            return;
        }
        self.ended = true;
        self.beat(Some(how));
    }

    pub fn stop(&mut self) {
        self.ended = true;
    }
}
