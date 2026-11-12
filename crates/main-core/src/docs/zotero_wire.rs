//! `apps/docs/src/main/zotero-wire.ts`: the frames of Zotero's integration
//! protocol, and the client that runs one command over a socket.
//!
//! The socket belongs to the caller ([`ZoteroNet`], the sockets by id) and so
//! do the events it raises: the caller feeds them to [`ZoteroWireClient`] one
//! at a time (`connected`, `on_data`, `on_error`, `on_close`) and runs
//! [`ZoteroWireClient::drain`] where the microtasks of the TypeScript would
//! run, after each event. `run`'s promise is what [`ZoteroWireClient::on_close`]
//! settles.
//!
//! Not reproduced: the `SyntaxError` text of a request that is not JSON. V8
//! words it (`Unexpected token ...`); here the answer carries
//! [`jscompat::JsonSyntaxError`]'s text. A handler that answers `undefined`
//! is not representable (the TypeScript throws a `TypeError` from the frame
//! encoder after its `try`).

use std::collections::{HashMap, VecDeque};

use jscompat::{JsonValue, json_parse, json_quote, json_stringify, to_int32};

pub const ZOTERO_INTEGRATION_HOST: &str = "127.0.0.1";
pub const ZOTERO_INTEGRATION_PORT: f64 = 23116.0;
const MAX_PAYLOAD_BYTES: u64 = 16 * 1024 * 1024;

/// `ZoteroWireFrame`
#[derive(Debug, Clone, PartialEq)]
pub struct ZoteroWireFrame {
    pub transaction_id: u32,
    pub payload: String,
}

/// `ZoteroWireRequest`
#[derive(Debug, Clone, PartialEq)]
pub struct ZoteroWireRequest {
    pub command: String,
    pub args: Vec<JsonValue>,
}

/// `encodeZoteroFrame(transactionId, payload)`: `transactionId >>> 0`, the
/// length of the UTF-8 body, the body.
pub fn encode_zotero_frame(transaction_id: f64, payload: &str) -> Vec<u8> {
    let body = payload.as_bytes();
    let mut frame = Vec::with_capacity(8 + body.len());
    frame.extend_from_slice(&(to_int32(transaction_id) as u32).to_be_bytes());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(body);
    frame
}

/// `ZoteroFrameDecoder`
#[derive(Debug, Default)]
pub struct ZoteroFrameDecoder {
    buffered: Vec<u8>,
}

impl ZoteroFrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// The frames the chunk completes. `Err` carries the message of the
    /// `Error` thrown; the chunk stays buffered then, as in the TypeScript.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<ZoteroWireFrame>, String> {
        self.buffered.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut at = 0;
        let outcome = loop {
            let rest = &self.buffered[at..];
            if rest.len() < 8 {
                break Ok(());
            }
            let transaction_id = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]);
            let length = u32::from_be_bytes([rest[4], rest[5], rest[6], rest[7]]);
            if u64::from(length) > MAX_PAYLOAD_BYTES {
                break Err("Zotero integration payload is too large".to_owned());
            }
            let length = length as usize;
            if rest.len() < 8 + length {
                break Ok(());
            }
            frames.push(ZoteroWireFrame {
                transaction_id,
                // Buffer.toString('utf8') keeps a byte order mark
                payload: String::from_utf8_lossy(&rest[8..8 + length]).into_owned(),
            });
            at += 8 + length;
        };
        // `this.buffered = this.buffered.subarray(8 + length)` per frame: the
        // frames before a refusal are consumed, the refused one stays
        self.buffered.drain(..at);
        outcome.map(|()| frames)
    }
}

/// `parseRequest(payload)`: the message of what it throws.
fn parse_request(payload: &str) -> Result<ZoteroWireRequest, String> {
    let value = json_parse(payload).map_err(|error| error.to_string())?;
    if let JsonValue::Array(items) = &value
        && let (Some(JsonValue::String(command)), Some(JsonValue::Array(args))) =
            (items.first(), items.get(1))
    {
        return Ok(ZoteroWireRequest {
            command: command.clone(),
            args: args.clone(),
        });
    }
    Err("Invalid Zotero integration request".to_owned())
}

fn error_payload(message: &str) -> String {
    format!("ERR:{message}")
}

/// The sockets of the caller, by id.
pub trait ZoteroNet {
    fn write(&mut self, socket: u32, frame: &[u8]);
    fn end(&mut self, socket: u32);
    /// `socket.destroy(error)`: the caller raises `error` and `close` on it later
    fn destroy(&mut self, socket: u32, error: Option<&str>);
    fn destroyed(&self, socket: u32) -> bool;
}

/// What `handleRequest(request)` settles with: the value to send, or the text
/// of what it rejected with (`error.message`, or `String(error)`).
pub type Handled = Result<JsonValue, String>;

/// A frame whose `handleRequest` has not settled yet: the continuation of
/// `respondToFrame` after its `await`.
struct Pending {
    socket: u32,
    transaction_id: u32,
    command: String,
    handled: Handled,
}

/// What one `run` holds in local variables.
struct Run {
    decoder: ZoteroFrameDecoder,
    failure: Option<String>,
    error_seen: bool,
    closed: bool,
}

/// `ZoteroWireClient`
pub struct ZoteroWireClient {
    pub host: String,
    pub port: f64,
    socket: Option<u32>,
    active: bool,
    runs: HashMap<u32, Run>,
    pending: VecDeque<Pending>,
}

impl ZoteroWireClient {
    pub fn new(host: Option<&str>, port: Option<f64>) -> Self {
        ZoteroWireClient {
            host: host.unwrap_or(ZOTERO_INTEGRATION_HOST).to_owned(),
            port: port.unwrap_or(ZOTERO_INTEGRATION_PORT),
            socket: None,
            active: false,
            runs: HashMap::new(),
            pending: VecDeque::new(),
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// The start of `run`: refuses a second run, then the caller connects.
    pub fn begin_run(&mut self) -> Result<(), String> {
        if self.active {
            return Err("A Zotero operation is already running".to_owned());
        }
        self.active = true;
        Ok(())
    }

    /// The connection was refused: `run` throws the error.
    pub fn connect_failed(&mut self) {
        self.active = false;
        self.socket = None;
    }

    /// The connection is made: the command goes out as the first frame.
    pub fn connected(&mut self, socket: u32, command: &str, net: &mut dyn ZoteroNet) {
        self.socket = Some(socket);
        self.runs.insert(
            socket,
            Run {
                decoder: ZoteroFrameDecoder::new(),
                failure: None,
                error_seen: false,
                closed: false,
            },
        );
        let hello = format!(
            "{{\"command\":{},\"templateVersion\":1}}",
            json_quote(command)
        );
        net.write(socket, &encode_zotero_frame(0.0, &hello));
    }

    /// `socket.on('data')`
    pub fn on_data(
        &mut self,
        socket: u32,
        chunk: &[u8],
        handle: &mut dyn FnMut(&ZoteroWireRequest) -> Handled,
        net: &mut dyn ZoteroNet,
    ) {
        let Some(run) = self.runs.get_mut(&socket) else {
            return;
        };
        let frames = match run.decoder.push(chunk) {
            Ok(frames) => frames,
            Err(message) => {
                net.destroy(socket, Some(&message));
                return;
            }
        };
        for frame in frames {
            self.respond_to_frame(socket, frame, handle, net);
        }
    }

    /// `void this.respondToFrame(...)`: runs up to its first `await`.
    fn respond_to_frame(
        &mut self,
        socket: u32,
        frame: ZoteroWireFrame,
        handle: &mut dyn FnMut(&ZoteroWireRequest) -> Handled,
        net: &mut dyn ZoteroNet,
    ) {
        if frame.transaction_id == 0 {
            return;
        }
        match parse_request(&frame.payload) {
            // no `await` was reached: the rest runs now
            Err(message) => Self::finish(
                socket,
                frame.transaction_id,
                "",
                &error_payload(&message),
                net,
            ),
            Ok(request) => {
                let handled = handle(&request);
                self.pending.push_back(Pending {
                    socket,
                    transaction_id: frame.transaction_id,
                    command: request.command,
                    handled,
                });
            }
        }
    }

    /// the write and the end of `respondToFrame`
    fn finish(
        socket: u32,
        transaction_id: u32,
        command: &str,
        payload: &str,
        net: &mut dyn ZoteroNet,
    ) {
        if !net.destroyed(socket) {
            net.write(
                socket,
                &encode_zotero_frame(f64::from(transaction_id), payload),
            );
        }
        if command == "Document_complete" {
            net.end(socket);
        }
    }

    /// The microtasks: every frame waiting on its handler goes on, in order.
    pub fn drain(&mut self, net: &mut dyn ZoteroNet) {
        while let Some(done) = self.pending.pop_front() {
            let payload = match &done.handled {
                Ok(value) => json_stringify(value),
                Err(message) => error_payload(message),
            };
            Self::finish(
                done.socket,
                done.transaction_id,
                &done.command,
                &payload,
                net,
            );
        }
    }

    /// `socket.once('error')`: the first error is the failure `run` rejects with.
    pub fn on_error(&mut self, socket: u32, message: &str) {
        if let Some(run) = self.runs.get_mut(&socket)
            && !run.error_seen
        {
            run.error_seen = true;
            run.failure = Some(message.to_owned());
        }
    }

    /// `socket.once('close')`: settles `run`. `None` = already settled.
    pub fn on_close(&mut self, socket: u32) -> Option<Result<(), String>> {
        let run = self.runs.get_mut(&socket)?;
        if run.closed {
            return None;
        }
        run.closed = true;
        if self.socket == Some(socket) {
            self.socket = None;
        }
        self.active = false;
        Some(match &run.failure {
            Some(failure) => Err(failure.clone()),
            None => Ok(()),
        })
    }

    pub fn close(&mut self, net: &mut dyn ZoteroNet) {
        if let Some(socket) = self.socket {
            net.destroy(socket, None);
        }
        self.socket = None;
        self.active = false;
    }
}
