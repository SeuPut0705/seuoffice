//! `apps/sheets/src/main/xlsx-sidecar-client.ts`.

//! The TypeScript class owns a child process, a line reader on its stdout, one
//! timer per request and a promise per request. None of those is here: the
//! process, the timers and the promises are behind [`SidecarHost`], and what
//! happens to them is a step the caller drives:
//!
//! - a request method answers [`Submitted`]: the request is pending (its promise
//!   settles later through [`SidecarHost::settle`]) or was refused at once (the
//!   promise of an `async` method rejects without a pending entry);
//! - an event of the process is [`XlsxSidecarClient::on_line`],
//!   [`XlsxSidecarClient::on_stderr`], [`XlsxSidecarClient::on_exit`],
//!   [`XlsxSidecarClient::on_error`] and [`XlsxSidecarClient::on_stdin_error`]
//!   (the last three name the process, by the number [`SidecarHost::spawn`]
//!   was given);
//! - a timer that fires is [`XlsxSidecarClient::on_timeout`], and the callback
//!   of a stdin write is [`XlsxSidecarClient::on_write_done`].
//!
//! The stderr is kept in UTF-16 code units, as `slice(-N)` counts them.

use jscompat::{
    JsonValue, json_parse, json_stringify, json_value_from_serde, json_value_to_serde,
    number_to_string, slice_utf16, trim, value_to_string,
};
use serde_json::{Map, Value};

const PROTOCOL_VERSION: f64 = 1.0;
pub const REQUEST_TIMEOUT_MS: f64 = 30_000.0;
/// Archive commands stream whole workbooks; large files need more headroom.
pub const ARCHIVE_TIMEOUT_MS: f64 = 180_000.0;
const MAX_STDERR_LENGTH: usize = 8_192;

/// Pure reads a departing consumer can abandon; skipping a queued close (or
/// save) instead would leave its side effects permanently undone.
const CANCELLABLE_READS: [&str; 5] = [
    "read_range",
    "read_formula_cells",
    "read_row_outline",
    "read_media",
    "find_cells",
];

/// How a promise settles: a value (`None` is `undefined`), or the message of
/// the `Error` it rejects with.
pub type Settled = Result<Option<Value>, String>;

/// A subscription made by [`XlsxSidecarClient::on_process_exit`].
pub type ListenerId = u64;

/// What the client does to the world.
pub trait SidecarHost {
    /// `spawn(binaryPath, [], { stdio: pipes, windowsHide: true })`, with a line
    /// reader on its stdout and the listeners of the client on it. `Err` is
    /// what `spawn` throws synchronously: the message of the `Error`, or
    /// `String(value)` of what else was thrown. `process` names the process in
    /// later events.
    fn spawn(&mut self, binary_path: &str, process: u64) -> Result<(), String>;
    /// `child.pid`
    fn pid(&mut self, process: u64) -> Option<f64>;
    /// `child.stdin.write(data, callback)`; `request_id` is the request the
    /// callback belongs to, `None` where the write has no callback
    fn write_stdin(&mut self, process: u64, data: &str, request_id: Option<&str>);
    /// `child.kill()`: whether the signal was sent
    fn kill(&mut self, process: u64) -> bool;
    /// `lines.close()`
    fn close_lines(&mut self, process: u64);
    /// `crypto.randomUUID()`
    fn random_uuid(&mut self) -> String;
    /// `setTimeout(callback, ms)`: the timer's number, given back to
    /// [`XlsxSidecarClient::on_timeout`] when it fires
    fn set_timeout(&mut self, ms: f64) -> u64;
    /// `clearTimeout(timer)`
    fn clear_timeout(&mut self, timer: u64);
    /// the promise of a request settles
    fn settle(&mut self, request_id: &str, outcome: Settled);
    /// `console.warn(...)` of the prewarm failure: the message of its error
    fn warn_prewarm_failed(&mut self, message: &str);
    /// an exit listener runs
    fn exit_notified(&mut self, listener: ListenerId);
}

/// What a request method gives back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Submitted {
    /// the request is pending: its promise settles through the host
    Pending(String),
    /// the promise rejected at once, with this message
    Rejected(String),
}

/// What is done with a reply before the promise of the method resolves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reply {
    /// the reply as it is
    Raw,
    /// `close`: `undefined`
    Nothing,
    /// `convertWorkbook`
    Conversion,
    /// `convertToOds`
    OdsConversion,
}

struct Pending {
    request_id: String,
    timer: u64,
    /// `String(command.command)`
    command: String,
    /// `command.command === 'close'`
    is_close: bool,
    session_id: Option<String>,
    reply: Reply,
}

struct Child {
    process: u64,
    killed: bool,
}

pub struct XlsxSidecarClient<H: SidecarHost> {
    host: H,
    binary_path: String,
    process: Option<Child>,
    lines_open: bool,
    pending: Vec<Pending>,
    stderr: Vec<u16>,
    exit_listeners: Vec<ListenerId>,
    next_listener: ListenerId,
    next_process: u64,
}

fn is_number(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| v.is_number())
}

/// `typeof value === 'number' ? value : 0`
fn count(value: Option<&Value>) -> Value {
    is_number(value).cloned().unwrap_or_else(|| Value::from(0))
}

/// the answer of `convertWorkbook` for a reply: `(reply ?? {})` read field by field
fn conversion_of(result: Option<&Value>) -> Value {
    let mut out = Map::new();
    out.insert("sheets".into(), count(result.and_then(|r| r.get("sheets"))));
    out.insert("cells".into(), count(result.and_then(|r| r.get("cells"))));
    // an older sidecar does not report formulas it could not translate
    out.insert(
        "formulasDropped".into(),
        count(result.and_then(|r| r.get("formulasDropped"))),
    );
    Value::Object(out)
}

/// the answer of `convertToOds` for a reply
fn ods_conversion_of(result: Option<&Value>) -> Value {
    let dropped = result
        .and_then(|r| r.get("dropped"))
        .filter(|v| !v.is_null());
    let dropped_count = |key: &str| count(dropped.and_then(|d| d.get(key)));
    let mut counts = Map::new();
    for key in [
        "charts",
        "images",
        "conditionalFormats",
        "validations",
        "pivots",
        "comments",
        // absent from a sidecar built before these were counted
        "macros",
        "shapes",
        "slicers",
        "sparklines",
    ] {
        counts.insert(key.into(), dropped_count(key));
    }
    let mut out = Map::new();
    out.insert("sheets".into(), count(result.and_then(|r| r.get("sheets"))));
    out.insert("cells".into(), count(result.and_then(|r| r.get("cells"))));
    out.insert(
        "formulasDropped".into(),
        count(result.and_then(|r| r.get("formulasDropped"))),
    );
    out.insert("dropped".into(), Value::Object(counts));
    Value::Object(out)
}

/// `{ command: name, ...input }`
fn command_with(name: &str, input: &Map<String, Value>) -> Map<String, Value> {
    let mut command = Map::new();
    command.insert("command".into(), Value::from(name));
    for (key, value) in input {
        command.insert(key.clone(), value.clone());
    }
    command
}

impl<H: SidecarHost> XlsxSidecarClient<H> {
    pub fn new(host: H, binary_path: &str) -> Self {
        XlsxSidecarClient {
            host,
            binary_path: binary_path.to_owned(),
            process: None,
            lines_open: false,
            pending: Vec::new(),
            stderr: Vec::new(),
            exit_listeners: Vec::new(),
            next_listener: 0,
            next_process: 0,
        }
    }

    pub fn host(&self) -> &H {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut H {
        &mut self.host
    }

    /// Subscribe to unexpected sidecar process death; the id unsubscribes.
    pub fn on_process_exit(&mut self) -> ListenerId {
        let id = self.next_listener;
        self.next_listener += 1;
        self.exit_listeners.push(id);
        id
    }

    /// the unsubscribe function: `Set.delete`'s answer
    pub fn off_process_exit(&mut self, id: ListenerId) -> bool {
        match self.exit_listeners.iter().position(|&l| l == id) {
            Some(at) => {
                self.exit_listeners.remove(at);
                true
            }
            None => false,
        }
    }

    fn notify_exit(&mut self) {
        // a listener removed meanwhile is not called
        for id in self.exit_listeners.clone() {
            if self.exit_listeners.contains(&id) {
                self.host.exit_notified(id);
            }
        }
    }

    // ---- the requests ----

    /// `open(path, locale = 'zh', shortDateFormat?, options?)`
    pub fn open(
        &mut self,
        path: &str,
        locale: Option<&str>,
        short_date_format: Option<&str>,
        timeout_ms: Option<f64>,
    ) -> Submitted {
        let mut command = Map::new();
        command.insert("command".into(), Value::from("open"));
        command.insert("path".into(), Value::from(path));
        command.insert("locale".into(), Value::from(locale.unwrap_or("zh")));
        if let Some(format) = short_date_format {
            command.insert("shortDateFormat".into(), Value::from(format));
        }
        self.request(
            command,
            timeout_ms.unwrap_or(REQUEST_TIMEOUT_MS),
            Reply::Raw,
        )
    }

    /// `readRange`, `readFormulaCells`, `findCells`, `readRowOutline` and
    /// `readMedia`: `{ command, ...input }` with the default timeout
    pub fn read(&mut self, command: &str, input: &Map<String, Value>) -> Submitted {
        self.request(command_with(command, input), REQUEST_TIMEOUT_MS, Reply::Raw)
    }

    /// `close(sessionId)`
    pub fn close(&mut self, session_id: &str) -> Submitted {
        // Skip the session's queued reads so close does not wait behind them;
        // each settles with the sidecar's authoritative "cancelled" failure.
        let targets: Vec<String> = self
            .pending
            .iter()
            .filter(|pending| {
                pending.session_id.as_deref() == Some(session_id)
                    && CANCELLABLE_READS.contains(&pending.command.as_str())
            })
            .map(|pending| pending.request_id.clone())
            .collect();
        for request_id in targets {
            self.send_cancel(&request_id);
        }
        let mut command = Map::new();
        command.insert("command".into(), Value::from("close"));
        command.insert("sessionId".into(), Value::from(session_id));
        self.request(command, REQUEST_TIMEOUT_MS, Reply::Nothing)
    }

    /// `convertWorkbook(input)`
    pub fn convert_workbook(&mut self, input: &Map<String, Value>) -> Submitted {
        self.request(
            command_with("convert_workbook", input),
            ARCHIVE_TIMEOUT_MS,
            Reply::Conversion,
        )
    }

    /// `convertToOds(input)`
    pub fn convert_to_ods(&mut self, input: &Map<String, Value>) -> Submitted {
        self.request(
            command_with("convert_to_ods", input),
            ARCHIVE_TIMEOUT_MS,
            Reply::OdsConversion,
        )
    }

    /// `archiveManifest(path)`
    pub fn archive_manifest(&mut self, path: &str) -> Submitted {
        let mut command = Map::new();
        command.insert("command".into(), Value::from("archive_manifest"));
        command.insert("path".into(), Value::from(path));
        self.request(command, ARCHIVE_TIMEOUT_MS, Reply::Raw)
    }

    /// `readEntries`, `scanEntries`, `saveArchive`, `recalcCells`,
    /// `updateExternalLinks`, `readExternalLinks`, `readExternalLinkUsage` and
    /// `listExternalLinks`: `{ command, ...input }` with the archive timeout
    pub fn archive_command(&mut self, command: &str, input: &Map<String, Value>) -> Submitted {
        self.request(command_with(command, input), ARCHIVE_TIMEOUT_MS, Reply::Raw)
    }

    // ---- the process ----

    /// Spawn the sidecar ahead of the first request to hide process cold-start.
    /// Best-effort: a spawn that throws is warned about, not raised.
    pub fn start(&mut self) {
        if let Err(message) = self.ensure_started() {
            self.host.warn_prewarm_failed(&message);
        }
    }

    /// `getProcessId()`
    pub fn get_process_id(&mut self) -> Option<f64> {
        let process = self.process.as_ref()?.process;
        self.host.pid(process)
    }

    pub fn stop(&mut self) {
        if self.lines_open
            && let Some(child) = &self.process
        {
            self.host.close_lines(child.process);
        }
        self.lines_open = false;
        if let Some(child) = &mut self.process {
            child.killed = self.host.kill(child.process);
        }
        self.process = None;
        self.reject_pending("XLSX sidecar stopped.");
    }

    /// Fire-and-forget: handled out of band by the sidecar's reader thread, so
    /// it takes effect while earlier requests still wait in the queue.
    fn send_cancel(&mut self, target_request_id: &str) {
        let Some(child) = &self.process else { return };
        if child.killed {
            return;
        }
        let process = child.process;
        let mut command = Map::new();
        command.insert("version".into(), Value::from(1));
        command.insert("requestId".into(), Value::from(self.host.random_uuid()));
        command.insert("command".into(), Value::from("cancel"));
        command.insert("targetRequestId".into(), Value::from(target_request_id));
        let line = format!("{}\n", stringify(&command));
        self.host.write_stdin(process, &line, None);
    }

    fn request(&mut self, command: Map<String, Value>, timeout_ms: f64, reply: Reply) -> Submitted {
        let process = match self.ensure_started() {
            Ok(process) => process,
            Err(message) => return Submitted::Rejected(message),
        };
        let request_id = self.host.random_uuid();
        // `{ version, requestId, ...command }`
        let mut payload = Map::new();
        payload.insert("version".into(), Value::from(1));
        payload.insert("requestId".into(), Value::from(request_id.as_str()));
        for (key, value) in &command {
            payload.insert(key.clone(), value.clone());
        }
        let payload = stringify(&payload);
        let command_name = command.get("command");
        let session_id = match command.get("sessionId") {
            Some(Value::String(id)) => Some(id.clone()),
            _ => None,
        };
        let timer = self.host.set_timeout(timeout_ms);
        self.pending.push(Pending {
            request_id: request_id.clone(),
            timer,
            command: value_to_string(command_name),
            is_close: command_name == Some(&Value::from("close")),
            session_id,
            reply,
        });
        self.host
            .write_stdin(process, &format!("{payload}\n"), Some(&request_id));
        Submitted::Pending(request_id)
    }

    /// the process of the client, spawned when there is none
    fn ensure_started(&mut self) -> Result<u64, String> {
        if let Some(child) = &self.process
            && !child.killed
        {
            return Ok(child.process);
        }
        let process = self.next_process;
        if let Err(message) = self.host.spawn(&self.binary_path, process) {
            // Synchronous spawn failures ("spawn UNKNOWN") carry no path in the
            // message — rethrow with enough context to diagnose from a screenshot.
            return Err(format!(
                "XLSX sidecar failed to start ({}): {message}",
                self.binary_path
            ));
        }
        self.next_process += 1;
        self.process = Some(Child {
            process,
            killed: false,
        });
        self.stderr = Vec::new();
        self.lines_open = true;
        Ok(process)
    }

    fn stderr_text(&self) -> String {
        String::from_utf16_lossy(&self.stderr)
    }

    /// `this.stderr = (this.stderr + text).slice(-MAX_STDERR_LENGTH)`
    fn append_stderr(&mut self, text: &str) {
        self.stderr.extend(text.encode_utf16());
        if self.stderr.len() > MAX_STDERR_LENGTH {
            let drop = self.stderr.len() - MAX_STDERR_LENGTH;
            self.stderr.drain(..drop);
        }
    }

    /// a chunk of the child's stderr
    pub fn on_stderr(&mut self, chunk: &str) {
        self.append_stderr(chunk);
    }

    fn teardown(&mut self, process: u64, reason: &str) {
        if self.process.as_ref().map(|child| child.process) != Some(process) {
            return;
        }
        self.process = None;
        if self.lines_open {
            self.host.close_lines(process);
        }
        self.lines_open = false;
        self.reject_pending(reason);
        // The process is gone, so every session id we hold is now unknown to
        // the next spawn.
        self.notify_exit();
    }

    /// the child's `error` event
    pub fn on_error(&mut self, process: u64, message: &str) {
        self.teardown(process, message);
    }

    /// the `error` event of the child's stdin
    pub fn on_stdin_error(&mut self, process: u64) {
        let stderr = self.stderr_text();
        let detail = trim(&stderr);
        let detail = if detail.is_empty() {
            "broken pipe"
        } else {
            detail
        };
        let message = format!("XLSX sidecar stdin failed ({detail}).");
        self.teardown(process, &slice_utf16(&message, 0.0, Some(200.0)));
    }

    /// the child's `exit` event: its code and signal (`None` is `null`)
    pub fn on_exit(&mut self, process: u64, code: Option<f64>, signal: Option<&str>) {
        let stderr = self.stderr_text();
        let detail = trim(&stderr);
        let reason = if detail.is_empty() {
            format!(
                "XLSX sidecar exited with code {} and signal {}.",
                code.map_or_else(|| "null".to_owned(), number_to_string),
                signal.unwrap_or("null")
            )
        } else {
            format!("XLSX sidecar exited: {detail}")
        };
        self.teardown(process, &reason);
    }

    /// the callback of the stdin write of a request, with its error (the
    /// message) when the write failed
    pub fn on_write_done(&mut self, request_id: &str, error: Option<&str>) {
        let Some(error) = error else { return };
        let Some(at) = self.pending.iter().position(|p| p.request_id == request_id) else {
            return;
        };
        let pending = self.pending.remove(at);
        self.host.clear_timeout(pending.timer);
        self.host.settle(&pending.request_id, Err(error.to_owned()));
    }

    /// the timer of a request fires
    pub fn on_timeout(&mut self, timer: u64) {
        let Some(at) = self.pending.iter().position(|p| p.timer == timer) else {
            return;
        };
        let pending = self.pending.remove(at);
        // Still queued sidecar-side, the request would execute for a reply
        // nobody consumes. A close is the exception: its side effect IS the
        // cleanup, and no caller retries a timed-out close.
        if !pending.is_close {
            self.send_cancel(&pending.request_id);
        }
        self.host.settle(
            &pending.request_id,
            Err("XLSX sidecar request timed out.".to_owned()),
        );
    }

    /// One line of the child's stdout. `Err` is the `TypeError` JavaScript
    /// throws out of the listener for a line that is the JSON `null`.
    pub fn on_line(&mut self, line: &str) -> Result<(), String> {
        let response = match json_parse(line) {
            Ok(response) => response,
            Err(_) => {
                // Library code inside the sidecar can print diagnostics to
                // stdout; such lines are noise. A genuinely garbled response
                // surfaces as that one request's timeout instead.
                self.append_stderr(&format!("[stdout] {line}\n"));
                return Ok(());
            }
        };
        if response == JsonValue::Null {
            return Err("Cannot read properties of null (reading 'version')".to_owned());
        }
        let read = |key: &str| response.get(key).map(std::borrow::Cow::into_owned);
        let version_ok =
            matches!(read("version"), Some(JsonValue::Number(v)) if v == PROTOCOL_VERSION);
        let request_id = match read("requestId") {
            Some(JsonValue::String(id)) => Some(id),
            _ => None,
        };
        let ok = match read("ok") {
            Some(JsonValue::Bool(flag)) => Some(flag),
            _ => None,
        };
        let (true, Some(request_id), Some(ok)) = (version_ok, request_id, ok) else {
            self.append_stderr(&format!("[stdout] {line}\n"));
            return Ok(());
        };
        let Some(at) = self.pending.iter().position(|p| p.request_id == request_id) else {
            return Ok(());
        };
        let pending = self.pending.remove(at);
        self.host.clear_timeout(pending.timer);
        if ok {
            let result = read("result").map(|value| json_value_to_serde(&value));
            let outcome = match pending.reply {
                Reply::Raw => result,
                Reply::Nothing => None,
                Reply::Conversion => Some(conversion_of(result.as_ref().filter(|v| !v.is_null()))),
                Reply::OdsConversion => {
                    Some(ods_conversion_of(result.as_ref().filter(|v| !v.is_null())))
                }
            };
            self.host.settle(&pending.request_id, Ok(outcome));
            return Ok(());
        }
        // `response.error?.message ?? 'XLSX sidecar request failed.'`
        let message = read("error")
            .and_then(|error| error.get("message").map(std::borrow::Cow::into_owned))
            .filter(|message| *message != JsonValue::Null)
            .map_or_else(
                || "XLSX sidecar request failed.".to_owned(),
                |message| value_to_string(Some(&json_value_to_serde(&message))),
            );
        self.host.settle(&pending.request_id, Err(message));
        Ok(())
    }

    fn reject_pending(&mut self, message: &str) {
        let pending = std::mem::take(&mut self.pending);
        for entry in pending {
            self.host.clear_timeout(entry.timer);
            self.host.settle(&entry.request_id, Err(message.to_owned()));
        }
    }
}

/// `JSON.stringify(command)`
fn stringify(command: &Map<String, Value>) -> String {
    json_stringify(&json_value_from_serde(&Value::Object(command.clone())))
}
