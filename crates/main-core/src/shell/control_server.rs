//! `apps/shell/src/main/control-server.ts`: the local request/reply channel
//! for the seuoffice CLI (`open --slide`, `selection`).
//!
//! Security model: the socket lives in userData (per-user directory, 0600 on
//! POSIX; a per-user named pipe on Windows), every request must carry the
//! random token from userData/control.json (0600), one request per
//! connection, 64 KB cap, and the only commands are "show this spot" and
//! "read the selection".
//!
//! The socket stays behind [`ControlListener`]. A connection is a
//! [`ControlSession`]: the caller feeds it what `socket.on('data')`, the
//! 30 s `setTimeout` and `socket.on('error')` deliver and does what the
//! returned [`SessionStep`] says. The handler answers later in the TypeScript
//! (it returns a promise): `SessionStep::Handle` asks the caller to run it and
//! to report with [`ControlSession::settled`].

use std::fs::{self, OpenOptions};
use std::io::Write;

use jscompat::node_path::host::join;
use jscompat::{JsObject, JsonValue, json_parse, json_stringify, sha1_hex};

use crate::node_fs::{NodeError, node_error};
use crate::packages::cli::{
    CONTROL_FILE, CONTROL_MAX_REQUEST_BYTES, CONTROL_PROTOCOL, ControlEndpoint,
};

/// `controlEndpointPath(userData)`; `win32` is `process.platform === 'win32'`
pub fn control_endpoint_path(user_data: &str, win32: bool) -> String {
    if win32 {
        let hash = sha1_hex(user_data.as_bytes());
        return format!("\\\\.\\pipe\\seuoffice-control-{}", &hash[..16]);
    }
    join(&[user_data, "control.sock"])
}

/// `ControlEnvelope` as `parseEnvelope` returns it: the object it parsed,
/// with the two members it checked
#[derive(Debug, Clone, PartialEq)]
pub struct ControlEnvelope {
    /// the whole parsed object (it keeps members `parseEnvelope` does not read)
    pub raw: JsonValue,
    pub token: String,
    pub request: JsonValue,
}

/// `parseEnvelope(line)`
pub fn parse_envelope(line: &str) -> Option<ControlEnvelope> {
    let raw = json_parse(line).ok()?;
    // `!raw || typeof raw !== 'object'`
    if !matches!(raw, JsonValue::Object(_) | JsonValue::Array(_)) {
        return None;
    }
    let field = |value: &JsonValue, key: &str| value.get(key).map(std::borrow::Cow::into_owned);
    let Some(JsonValue::String(token)) = field(&raw, "token") else {
        return None;
    };
    let request = field(&raw, "request")?;
    if !matches!(request, JsonValue::Object(_) | JsonValue::Array(_)) {
        return None;
    }
    let cmd_ok = matches!(field(&request, "cmd"), Some(JsonValue::String(cmd)) if cmd == "open" || cmd == "selection");
    if !cmd_ok || !matches!(field(&request, "path"), Some(JsonValue::String(_))) {
        return None;
    }
    Some(ControlEnvelope {
        raw,
        token,
        request,
    })
}

/// `tokenMatches(given, expected)`: equal lengths in bytes, then every byte
fn token_matches(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// What the caller does with a connection after an event.
#[derive(Debug, Clone, PartialEq)]
pub enum SessionStep {
    /// nothing yet: the request line is not complete, or the connection is finished
    Wait,
    /// `socket.destroy()`
    Destroy,
    /// `socket.end(line)`: the reply and its newline
    Reply(String),
    /// run the handler with this request and call `settled` when it answers
    Handle(JsonValue),
}

/// One connection: the state of `serve(socket, token, handler)`.
#[derive(Debug, Default)]
pub struct ControlSession {
    buffer: String,
    /// `buffer.length`: UTF-16 code units
    buffer_units: usize,
    done: bool,
}

impl ControlSession {
    pub fn new() -> Self {
        Self::default()
    }

    /// `finish(reply)`: `null` (or any other falsy reply) destroys the socket
    fn finish(&mut self, reply: Option<&JsonValue>) -> SessionStep {
        if self.done {
            return SessionStep::Wait;
        }
        self.done = true;
        match reply {
            Some(reply) if reply.truthy() => {
                SessionStep::Reply(format!("{}\n", json_stringify(reply)))
            }
            _ => SessionStep::Destroy,
        }
    }

    /// `socket.on('data', chunk)` of a text the socket decoded as UTF-8. A
    /// handler that has not answered yet is called again by every chunk that
    /// follows the request line, as in the TypeScript.
    pub fn on_data(&mut self, token: &str, chunk: &str) -> SessionStep {
        if self.done {
            return SessionStep::Wait;
        }
        self.buffer.push_str(chunk);
        self.buffer_units += chunk.encode_utf16().count();
        if self.buffer_units > CONTROL_MAX_REQUEST_BYTES {
            return self.finish(None);
        }
        let Some(nl) = self.buffer.find('\n') else {
            return SessionStep::Wait;
        };
        let envelope = parse_envelope(&self.buffer[..nl]);
        match envelope {
            Some(envelope) if token_matches(&envelope.token, token) => {
                SessionStep::Handle(envelope.request)
            }
            _ => self.finish(None),
        }
    }

    /// The handler settled: `Ok` is what its promise resolved to, `Err` the
    /// text of what it rejected with (`err instanceof Error ? err.message :
    /// String(err)`).
    pub fn settled(&mut self, outcome: Result<JsonValue, String>) -> SessionStep {
        match outcome {
            Ok(reply) => self.finish(Some(&reply)),
            Err(message) => {
                let mut error = JsObject::new();
                error.set("reason", JsonValue::String("app_unavailable".to_string()));
                error.set("message", JsonValue::String(message));
                let mut reply = JsObject::new();
                reply.set("ok", JsonValue::Bool(false));
                reply.set("error", JsonValue::Object(error));
                self.finish(Some(&JsonValue::Object(reply)))
            }
        }
    }

    /// the 30 s idle timeout, and `socket.on('error')`: `finish(null)`
    pub fn on_timeout_or_error(&mut self) -> SessionStep {
        self.finish(None)
    }
}

/// the `net.Server` the control server listens with
pub trait ControlListener {
    /// `server.listen(endpoint)`: `Err` carries the error code of the
    /// `'error'` event (`EADDRINUSE`, `ENOENT`, ...)
    fn listen(&mut self, endpoint: &str) -> Result<(), String>;
    /// `server.close()`
    fn close(&mut self);
}

/// Why `startControlServer` did not answer with a server.
#[derive(Debug, Clone, PartialEq)]
pub enum ControlStartError {
    /// the promise rejected with the `'error'` event of the server (its code)
    Listen(String),
    /// `writeFileSync` threw inside the `listen` callback: an uncaught
    /// exception in the TypeScript, which never settles the promise
    WriteFile(NodeError),
}

/// `ControlServer`
pub struct ControlServer<'a, L: ControlListener> {
    pub endpoint: ControlEndpoint,
    listener: &'a mut L,
    file: String,
    win32: bool,
}

/// `startControlServer(userData, handler)`: `token` is `randomBytes(24)` as
/// hex and `pid` is `process.pid`; the handler runs per connection, through
/// [`ControlSession`].
pub fn start_control_server<'a, L: ControlListener>(
    user_data: &str,
    win32: bool,
    pid: u32,
    token: &str,
    listener: &'a mut L,
) -> Result<ControlServer<'a, L>, ControlStartError> {
    let endpoint = control_endpoint_path(user_data, win32);
    let file = join(&[user_data, CONTROL_FILE]);
    if !win32 {
        let _ = fs::remove_file(&endpoint);
    }
    listener
        .listen(&endpoint)
        .map_err(ControlStartError::Listen)?;
    if !win32 {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&endpoint, fs::Permissions::from_mode(0o600));
        }
    }
    let info = ControlEndpoint {
        protocol: CONTROL_PROTOCOL,
        pid,
        endpoint,
        token: token.to_string(),
    };
    write_control_file(&file, &info).map_err(ControlStartError::WriteFile)?;
    Ok(ControlServer {
        endpoint: info,
        listener,
        file,
        win32,
    })
}

/// `writeFileSync(file, JSON.stringify(info), { mode: 0o600 })`
fn write_control_file(file: &str, info: &ControlEndpoint) -> Result<(), NodeError> {
    let mut object = JsObject::new();
    object.set("protocol", JsonValue::Number(f64::from(info.protocol)));
    object.set("pid", JsonValue::Number(f64::from(info.pid)));
    object.set("endpoint", JsonValue::String(info.endpoint.clone()));
    object.set("token", JsonValue::String(info.token.clone()));
    let text = json_stringify(&JsonValue::Object(object));
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut handle = options
        .open(file)
        .map_err(|e| node_error(&e, "open", file))?;
    handle
        .write_all(text.as_bytes())
        .map_err(|e| node_error(&e, "write", file))
}

impl<L: ControlListener> ControlServer<'_, L> {
    /// `close()`
    pub fn close(&mut self) {
        self.listener.close();
        let _ = fs::remove_file(&self.file);
        if !self.win32 {
            let _ = fs::remove_file(&self.endpoint.endpoint);
        }
    }
}
