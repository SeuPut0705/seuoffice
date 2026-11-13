//! `apps/docs/src/main/zotero-ipc.ts`: Zotero's word-processor integration.
//!
//! `zotero:command` opens a connection to Zotero's local integration port and
//! runs one command. Zotero then asks for the document's fields over that
//! connection, one frame per question; each question goes to the renderer as
//! a `zotero:request` event and is answered when the renderer sends
//! `zotero:response` back. The frames, their decoder and the protocol
//! constants are `main-core`'s [`main_core::docs::zotero_wire`]; its
//! `ZoteroWireClient` runs the questions through a handler that has an answer
//! at once, so the round trip to the renderer (which TypeScript awaited) is
//! kept here as a state machine instead: a question waits in the port under
//! its request id until the answer, the view's end, or the timeout settles it.
//!
//! The port's state sits in one mutex and every event that changes it
//! (a socket's, a response's, a view's end) runs on the core thread, one at a
//! time, as `ipcMain` listeners did. Nothing waits for the renderer or the
//! socket: a handler returns after recording what it waits for.
//!
//! A run is one `zotero:command`: it ends when Zotero closes the connection.
//! `ZoteroWireClient.active` is the run's presence in the view's entry.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::time::{Duration, Instant};

use jscompat::{JsObject, JsonValue, json_parse, json_stringify, number_to_string};
use main_core::docs::zotero_wire::{
    ZOTERO_INTEGRATION_HOST, ZOTERO_INTEGRATION_PORT, ZoteroFrameDecoder, ZoteroWireRequest,
    encode_zotero_frame,
};
use shell_contract::ipc::{CallContext, EventSink, Responder, Target};
use shell_contract::runtime::{CancelToken, Thread, Workers};
use shell_contract::{BytesKind, IpcValue, ViewId};

use crate::ports::Zotero;
use crate::value::{from_json, to_json};

/// `ipcMain.handle('zotero:command')`'s pattern
const COMMANDS: [&str; 5] = [
    "addEditCitation",
    "addEditBibliography",
    "refresh",
    "setDocPrefs",
    "removeCodes",
];
const REQUEST_EVENT: &str = "zotero:request";
/// A displayAlert waits on a modal the user may leave open for a while
const REQUEST_TIMEOUT: Duration = Duration::from_millis(600_000);
/// How often an open connection wakes the core thread to expire questions
const IDLE_TICK: Duration = Duration::from_secs(1);

/// One connection to Zotero, written to from the core thread (Node's `Socket`)
pub trait ZoteroSocket: Send + Sync {
    /// `socket.write(frame)`
    fn write(&self, frame: &[u8]);
    /// `socket.end()`
    fn end(&self);
    /// `socket.destroy(error)`: `error` and `close` follow as events
    fn destroy(&self, error: Option<&str>);
    /// `socket.destroyed`
    fn destroyed(&self) -> bool;
}

/// What a connection raises, on whichever thread it runs
pub enum SocketEvent {
    /// `createConnection`'s `connect`
    Connected(Arc<dyn ZoteroSocket>),
    /// `createConnection`'s `error` before it connected: the message of the error
    ConnectFailed(String),
    /// `socket.on('data')`
    Data(Vec<u8>),
    /// `socket.once('error')`
    Error(String),
    /// `socket.once('close')`; the last event of a connection
    Close,
    /// nothing arrived for [`IDLE_TICK`]: the time to expire waiting questions
    Idle,
}

/// Where a connection's events go: the port runs each on the core thread
pub type SocketSink = Arc<dyn Fn(SocketEvent) + Send + Sync>;

/// `net.createConnection({ host, port })`
pub trait ZoteroConnector: Send + Sync {
    /// Connects without waiting and reports every outcome to `sink`
    fn connect(&self, host: &str, port: u16, sink: SocketSink);
}

/// What `ZoteroWireClient.run` holds for one command
struct Run {
    id: u64,
    /// the first frame, which names the command: `JSON.stringify({ command, templateVersion: 1 })`
    hello: String,
    socket: Option<Arc<dyn ZoteroSocket>>,
    decoder: ZoteroFrameDecoder,
    failure: Option<String>,
    /// the pending `zotero:command` invoke
    reply: Option<Responder>,
    /// fires when the view that asked is gone or navigated away
    cancel: CancelToken,
}

/// An entry of `pending`: a question of Zotero the renderer has not answered
struct Waiter {
    view: ViewId,
    run: u64,
    socket: Arc<dyn ZoteroSocket>,
    transaction_id: u32,
    command: String,
    deadline: Instant,
}

#[derive(Default)]
struct State {
    /// `clients`, as far as they matter: the run of each view
    runs: HashMap<ViewId, Run>,
    /// `pending`, by request id
    pending: HashMap<String, Waiter>,
    next_run: u64,
}

struct Inner {
    events: Arc<dyn EventSink>,
    core: Arc<dyn Thread>,
    connector: Arc<dyn ZoteroConnector>,
    host: String,
    port: u16,
    timeout: Duration,
    /// `randomUUID()` of the question ids
    ids: RequestIds,
    state: Mutex<State>,
}

/// Makes the id a question goes to the renderer under
pub type RequestIds = Box<dyn Fn() -> String + Send + Sync>;

/// `{ ok: true }`
fn command_ok() -> IpcValue {
    IpcValue::Object(vec![("ok".into(), IpcValue::Bool(true))])
}

fn command_failed(code: &str, message: &str) -> IpcValue {
    IpcValue::Object(vec![
        ("ok".into(), IpcValue::Bool(false)),
        ("errorCode".into(), IpcValue::String(code.into())),
        ("error".into(), IpcValue::String(message.into())),
    ])
}

/// What `run` rejecting with `message` answers
fn run_failed(message: &str) -> IpcValue {
    let code = if message.contains("ECONNREFUSED") {
        "connection-refused"
    } else {
        "operation-failed"
    };
    command_failed(code, message)
}

/// `parseRequest(payload)` of zotero-wire.ts (`main-core` keeps it private):
/// the message of what it throws
fn parse_request(payload: &str) -> Result<ZoteroWireRequest, String> {
    let value = json_parse(payload).map_err(|error| error.message().to_owned())?;
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

/// What the TypeScript did after `await handleRequest(request)` settled: the
/// write of the frame, and `socket.end()` after the last one
fn finish_frame(socket: &Arc<dyn ZoteroSocket>, transaction_id: u32, command: &str, payload: &str) {
    if !socket.destroyed() {
        socket.write(&encode_zotero_frame(f64::from(transaction_id), payload));
    }
    if command == "Document_complete" {
        socket.end();
    }
}

/// How a question ended: the value to send, or `error.message`. `Ok(None)`
/// is an answer without a result: `JSON.stringify(undefined)` is not a
/// string, so the TypeScript threw from the frame encoder and nothing was
/// written or ended.
type Settled = Result<Option<JsonValue>, String>;

fn settle(waiter: &Waiter, outcome: Settled) {
    let payload = match outcome {
        Ok(Some(value)) => json_stringify(&value),
        Ok(None) => return,
        Err(message) => format!("ERR:{message}"),
    };
    finish_frame(
        &waiter.socket,
        waiter.transaction_id,
        &waiter.command,
        &payload,
    );
}

/// JavaScript truthiness of what the renderer sent
fn truthy(value: Option<&IpcValue>) -> bool {
    match value {
        None | Some(IpcValue::Undefined | IpcValue::Null) => false,
        Some(IpcValue::Bool(b)) => *b,
        Some(IpcValue::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(IpcValue::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `new Error(error).message` of a truthy `error`: what `ToString` makes of
/// it, which joins an array's elements with commas (`null` and `undefined`
/// as nothing) and calls any other object `[object Object]`
fn error_text(value: &IpcValue) -> String {
    match value {
        IpcValue::String(s) => s.clone(),
        IpcValue::Number(n) => number_to_string(*n),
        IpcValue::Bool(b) => b.to_string(),
        IpcValue::Array(items) => items
            .iter()
            .map(|item| match item {
                IpcValue::Null | IpcValue::Undefined => String::new(),
                item => error_text(item),
            })
            .collect::<Vec<_>>()
            .join(","),
        IpcValue::Bytes(BytesKind::Uint8Array, bytes) => bytes
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(","),
        IpcValue::Bytes(BytesKind::ArrayBuffer, _) => "[object ArrayBuffer]".to_owned(),
        _ => "[object Object]".to_owned(),
    }
}

fn lock(state: &Mutex<State>) -> MutexGuard<'_, State> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `randomUUID()`
fn request_id() -> String {
    let mut bytes = [0u8; 16];
    // a failed read leaves the id to the uniqueness check at the call site
    let _ = getrandom::fill(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: Vec<String> = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        hex[0..4].concat(),
        hex[4..6].concat(),
        hex[6..8].concat(),
        hex[8..10].concat(),
        hex[10..16].concat()
    )
}

/// Under the probe a port's ids are `00000000-0000-4000-8000-000000000001`,
/// `...02`, ...: a comparison can name a question the TypeScript asked under
/// the same count
#[cfg(feature = "probe")]
pub struct NumberedRequestIds;

/// Under the probe, the connector the port talks through is made by this
/// from the shell's workers (tools/ipc-diff: the probe's one waits for the
/// case's Zotero to settle, and keeps its connection off the pool the probe
/// waits on)
#[cfg(feature = "probe")]
pub struct ProbeConnector(pub Arc<MakeConnector>);

/// Makes a connector from the shell's workers
#[cfg(feature = "probe")]
pub type MakeConnector = dyn Fn(Arc<dyn Workers>) -> Arc<dyn ZoteroConnector> + Send + Sync;

#[cfg(feature = "probe")]
fn numbered_request_ids() -> RequestIds {
    let next = std::sync::atomic::AtomicU64::new(1);
    Box::new(move || {
        let n = next.fetch_add(1, Ordering::Relaxed);
        format!("00000000-0000-4000-8000-{n:012}")
    })
}

/// An id no waiting question has
fn fresh_request_id(ids: &RequestIds, pending: &HashMap<String, Waiter>) -> String {
    let mut id = ids();
    let mut salt = 0u64;
    while pending.contains_key(&id) {
        salt += 1;
        id = format!("{}-{salt}", ids());
    }
    id
}

/// `/^(addEditCitation|...)$/.test(command)`: the pattern takes what the
/// renderer sent as a string, and an array stringifies as its elements joined
/// by commas, so `['refresh']` passes it. The command is the text it matched.
fn command_text(value: &IpcValue) -> Option<&str> {
    match value {
        IpcValue::String(text) => Some(text),
        IpcValue::Array(items) if items.len() == 1 => command_text(&items[0]),
        _ => None,
    }
}

/// What one decoded frame leads to, run once the state is released
enum Step {
    /// the frame was answered without the renderer (a request that does not parse)
    Answer {
        transaction_id: u32,
        payload: String,
    },
    /// `contents.send('zotero:request', { requestId, ...request })`
    Ask {
        request_id: String,
        request: ZoteroWireRequest,
    },
}

impl Inner {
    /// `ipcMain.handle('zotero:command')`
    fn command(self: &Arc<Self>, cx: &CallContext, args: &[IpcValue], reply: Responder) {
        let hello = match args.first() {
            Some(value) if command_text(value).is_some_and(|text| COMMANDS.contains(&text)) => {
                let mut object = JsObject::new();
                object.set(
                    "command",
                    to_json(value).expect("a string or arrays of one"),
                );
                object.set("templateVersion", JsonValue::Number(1.0));
                json_stringify(&JsonValue::Object(object))
            }
            _ => {
                return reply.reply(Ok(command_failed(
                    "unsupported-command",
                    "Unsupported Zotero command",
                )));
            }
        };
        let view = cx.sender.view;
        let run_id = {
            let mut state = lock(&self.state);
            if state.runs.contains_key(&view) {
                drop(state);
                return reply.reply(Ok(run_failed("A Zotero operation is already running")));
            }
            state.next_run += 1;
            let id = state.next_run;
            state.runs.insert(
                view,
                Run {
                    id,
                    hello,
                    socket: None,
                    decoder: ZoteroFrameDecoder::new(),
                    failure: None,
                    reply: Some(reply),
                    cancel: cx.cancel.clone(),
                },
            );
            id
        };
        let inner = self.clone();
        let sink: SocketSink = Arc::new(move |event| {
            let inner = inner.clone();
            let core = inner.core.clone();
            core.post(Box::new(move || inner.on_socket(view, run_id, event)));
        });
        self.connector.connect(&self.host, self.port, sink);
    }

    /// An event of the connection of run `run_id`, on the core thread
    fn on_socket(&self, view: ViewId, run_id: u64, event: SocketEvent) {
        let mut guard = lock(&self.state);
        let state = &mut *guard;
        let live = state.runs.get(&view).is_some_and(|run| run.id == run_id);
        if !live {
            // the run was torn down while the connection was still being made
            drop(guard);
            if let SocketEvent::Connected(socket) = event {
                socket.destroy(None);
            }
            return;
        }
        if state.runs[&view].cancel.is_cancelled() {
            // the view the answer was for is gone: as `teardownZoteroIpc`
            drop(guard);
            if let SocketEvent::Connected(socket) = &event {
                socket.destroy(None);
            }
            self.teardown(view);
            return;
        }
        match event {
            SocketEvent::Connected(socket) => {
                let run = state.runs.get_mut(&view).expect("run is live");
                run.socket = Some(socket.clone());
                let hello = run.hello.clone();
                drop(guard);
                socket.write(&encode_zotero_frame(0.0, &hello));
            }
            SocketEvent::ConnectFailed(message) => {
                let run = state.runs.remove(&view).expect("run is live");
                drop(guard);
                if let Some(reply) = run.reply {
                    reply.reply(Ok(run_failed(&message)));
                }
            }
            SocketEvent::Data(chunk) => self.on_data(guard, view, run_id, &chunk),
            SocketEvent::Error(message) => {
                let run = state.runs.get_mut(&view).expect("run is live");
                // `once('error')`: the first error is the failure
                if run.failure.is_none() {
                    run.failure = Some(message);
                }
            }
            SocketEvent::Close => {
                let run = state.runs.remove(&view).expect("run is live");
                // the socket is destroyed: what these were waiting to write
                // goes nowhere
                state.pending.retain(|_, waiter| waiter.run != run_id);
                drop(guard);
                if let Some(reply) = run.reply {
                    reply.reply(Ok(match run.failure {
                        Some(message) => run_failed(&message),
                        None => command_ok(),
                    }));
                }
            }
            SocketEvent::Idle => {
                drop(guard);
                self.expire(Instant::now());
            }
        }
    }

    /// `socket.on('data')`: the frames the chunk completes, each answered or
    /// put to the renderer
    fn on_data(&self, mut guard: MutexGuard<'_, State>, view: ViewId, run_id: u64, chunk: &[u8]) {
        let state = &mut *guard;
        let run = state.runs.get_mut(&view).expect("run is live");
        let Some(socket) = run.socket.clone() else {
            return;
        };
        let frames = match run.decoder.push(chunk) {
            Ok(frames) => frames,
            Err(message) => {
                drop(guard);
                socket.destroy(Some(&message));
                return;
            }
        };
        let mut steps = Vec::new();
        for frame in frames {
            if frame.transaction_id == 0 {
                continue;
            }
            match parse_request(&frame.payload) {
                Err(message) => steps.push(Step::Answer {
                    transaction_id: frame.transaction_id,
                    payload: format!("ERR:{message}"),
                }),
                Ok(request) => {
                    let request_id = fresh_request_id(&self.ids, &state.pending);
                    state.pending.insert(
                        request_id.clone(),
                        Waiter {
                            view,
                            run: run_id,
                            socket: socket.clone(),
                            transaction_id: frame.transaction_id,
                            command: request.command.clone(),
                            deadline: Instant::now() + self.timeout,
                        },
                    );
                    steps.push(Step::Ask {
                        request_id,
                        request,
                    });
                }
            }
        }
        drop(guard);
        for step in steps {
            match step {
                Step::Answer {
                    transaction_id,
                    payload,
                } => finish_frame(&socket, transaction_id, "", &payload),
                Step::Ask {
                    request_id,
                    request,
                } => {
                    let mut object = JsObject::new();
                    object.set("requestId", JsonValue::String(request_id));
                    object.set("command", JsonValue::String(request.command));
                    object.set("args", JsonValue::Array(request.args));
                    self.events.emit(
                        Target::View(view),
                        REQUEST_EVENT,
                        vec![from_json(&JsonValue::Object(object))],
                    );
                }
            }
        }
    }

    /// `ipcMain.on('zotero:response')`
    fn response(&self, cx: &CallContext, args: &[IpcValue]) {
        let Some(IpcValue::Object(entries)) = args.first() else {
            return;
        };
        let field = |name: &str| entries.iter().find(|(k, _)| k == name).map(|(_, v)| v);
        let Some(IpcValue::String(request_id)) = field("requestId") else {
            return;
        };
        let waiter = {
            let mut state = lock(&self.state);
            // a response from another view is not an answer to this question
            if state
                .pending
                .get(request_id)
                .is_none_or(|waiter| waiter.view != cx.sender.view)
            {
                return;
            }
            state.pending.remove(request_id).expect("checked above")
        };
        let outcome = if truthy(field("ok")) {
            Ok(field("result").and_then(to_json))
        } else {
            Err(match field("error").filter(|error| truthy(Some(*error))) {
                Some(error) => error_text(error),
                None => "Zotero document operation failed".to_owned(),
            })
        };
        settle(&waiter, outcome);
    }

    /// The timers of `requestRenderer`: every question whose deadline has
    /// passed is rejected
    fn expire(&self, now: Instant) {
        let expired: Vec<Waiter> = {
            let mut state = lock(&self.state);
            let ids: Vec<String> = state
                .pending
                .iter()
                .filter(|(_, waiter)| waiter.deadline <= now)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter()
                .filter_map(|id| state.pending.remove(id))
                .collect()
        };
        for waiter in expired {
            let message = format!("Timed out handling {}", waiter.command);
            settle(&waiter, Err(message));
        }
    }

    /// `teardownZoteroIpc(contents)`: the connection is closed and every
    /// question the view has not answered is rejected
    fn teardown(&self, view: ViewId) {
        let (run, rejected) = {
            let mut state = lock(&self.state);
            let run = state.runs.remove(&view);
            let ids: Vec<String> = state
                .pending
                .iter()
                .filter(|(_, waiter)| waiter.view == view)
                .map(|(id, _)| id.clone())
                .collect();
            let rejected: Vec<Waiter> = ids
                .iter()
                .filter_map(|id| state.pending.remove(id))
                .collect();
            (run, rejected)
        };
        if let Some(run) = run {
            if let Some(socket) = &run.socket {
                socket.destroy(None);
            }
            // the closed socket resolves `run`: its caller is told it went well
            if let Some(reply) = run.reply {
                reply.reply(Ok(command_ok()));
            }
        }
        for waiter in rejected {
            settle(&waiter, Err("The document was closed".to_owned()));
        }
    }
}

pub struct ZoteroPort {
    inner: Arc<Inner>,
}

impl ZoteroPort {
    pub fn new(
        events: Arc<dyn EventSink>,
        core: Arc<dyn Thread>,
        connector: Arc<dyn ZoteroConnector>,
    ) -> Self {
        Self::with_ids(events, core, connector, Box::new(request_id))
    }

    pub fn with_ids(
        events: Arc<dyn EventSink>,
        core: Arc<dyn Thread>,
        connector: Arc<dyn ZoteroConnector>,
        ids: RequestIds,
    ) -> Self {
        ZoteroPort {
            inner: Arc::new(Inner {
                events,
                core,
                connector,
                host: ZOTERO_INTEGRATION_HOST.to_owned(),
                port: ZOTERO_INTEGRATION_PORT as u16,
                timeout: REQUEST_TIMEOUT,
                ids,
                state: Mutex::new(State::default()),
            }),
        }
    }

    /// `teardownZoteroIpc(contents)`, called when the view is destroyed
    pub fn view_destroyed(&self, view: ViewId) {
        self.inner.teardown(view);
    }
}

impl Zotero for ZoteroPort {
    fn zotero_command(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.inner.command(cx, &args, reply)
    }

    fn zotero_response(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        self.inner.response(cx, &args);
        reply.reply(Ok(IpcValue::Undefined))
    }
}

/// `net.createConnection` over a TCP stream: connecting and reading run on a
/// worker, writes come from the core thread
pub struct TcpConnector {
    workers: Arc<dyn Workers>,
}

impl TcpConnector {
    pub fn new(workers: Arc<dyn Workers>) -> Self {
        TcpConnector { workers }
    }
}

/// What the core thread asks of a socket's writer
enum Outgoing {
    Write(Vec<u8>),
    End,
    /// the socket was destroyed: leave the loop
    Stop,
}

struct TcpSocket {
    /// only for `shutdown`, which never blocks; writes belong to the writer
    control: Mutex<TcpStream>,
    outgoing: mpsc::Sender<Outgoing>,
    destroyed: AtomicBool,
    /// what `destroy(error)` or a failed read raises as `error` before `close`
    error: Mutex<Option<String>>,
}

impl TcpSocket {
    fn fail(&self, message: String) {
        self.error
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get_or_insert(message);
        self.shut();
    }

    /// destroyed, both directions shut: a blocked read or write returns, and
    /// the writer is told to leave
    fn shut(&self) {
        self.destroyed.store(true, Ordering::Release);
        let _ = self
            .control
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .shutdown(Shutdown::Both);
        let _ = self.outgoing.send(Outgoing::Stop);
    }
}

/// The loop that owns the stream's write side: the core thread only enqueues,
/// so a peer that stops reading stalls this worker and nothing else
fn run_writer(socket: Arc<TcpSocket>, mut stream: TcpStream, outgoing: mpsc::Receiver<Outgoing>) {
    for message in outgoing {
        match message {
            Outgoing::Write(bytes) => {
                if socket.destroyed() {
                    break;
                }
                if let Err(error) = stream.write_all(&bytes) {
                    // a write that failed because the socket was destroyed is not news
                    if !socket.destroyed() {
                        socket.fail(error.to_string());
                    }
                    break;
                }
            }
            Outgoing::End => {
                let _ = stream.shutdown(Shutdown::Write);
            }
            Outgoing::Stop => break,
        }
    }
}

impl ZoteroSocket for TcpSocket {
    fn write(&self, frame: &[u8]) {
        if !self.destroyed() {
            let _ = self.outgoing.send(Outgoing::Write(frame.to_vec()));
        }
    }

    fn end(&self) {
        let _ = self.outgoing.send(Outgoing::End);
    }

    fn destroy(&self, error: Option<&str>) {
        match error {
            Some(message) => self.fail(message.to_owned()),
            None => self.shut(),
        }
    }

    fn destroyed(&self) -> bool {
        self.destroyed.load(Ordering::Acquire)
    }
}

/// The message Node gives a refused connection, which `zotero:command`'s
/// error code goes by
fn connect_message(error: &std::io::Error, host: &str, port: u16) -> String {
    if error.kind() == std::io::ErrorKind::ConnectionRefused {
        format!("connect ECONNREFUSED {host}:{port}")
    } else {
        error.to_string()
    }
}

fn run_tcp(workers: Arc<dyn Workers>, host: String, port: u16, sink: SocketSink) {
    let stream = match TcpStream::connect((host.as_str(), port)) {
        Ok(stream) => stream,
        Err(error) => {
            return sink(SocketEvent::ConnectFailed(connect_message(
                &error, &host, port,
            )));
        }
    };
    // one handle each for the reader, the writer and `shutdown`
    let (mut reader, writer, control) = match (stream.try_clone(), stream.try_clone()) {
        (Ok(reader), Ok(writer)) => (reader, writer, stream),
        (Err(error), _) | (_, Err(error)) => {
            return sink(SocketEvent::ConnectFailed(error.to_string()));
        }
    };
    let _ = reader.set_read_timeout(Some(IDLE_TICK));
    let (outgoing, queue) = mpsc::channel();
    let socket = Arc::new(TcpSocket {
        control: Mutex::new(control),
        outgoing,
        destroyed: AtomicBool::new(false),
        error: Mutex::new(None),
    });
    let writing = socket.clone();
    workers.spawn(Box::new(move || run_writer(writing, writer, queue)));
    sink(SocketEvent::Connected(socket.clone()));
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => sink(SocketEvent::Data(buffer[..read].to_vec())),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if socket.destroyed() {
                    break;
                }
                sink(SocketEvent::Idle);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => {
                socket.fail(error.to_string());
                break;
            }
        }
    }
    // the connection is over: the writer leaves with it
    socket.shut();
    let error = socket
        .error
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    if let Some(message) = error {
        sink(SocketEvent::Error(message));
    }
    sink(SocketEvent::Close);
}

impl ZoteroConnector for TcpConnector {
    fn connect(&self, host: &str, port: u16, sink: SocketSink) {
        let host = host.to_owned();
        let workers = self.workers.clone();
        self.workers
            .spawn(Box::new(move || run_tcp(workers, host, port, sink)));
    }
}

/// The host the shell inserts for this port
pub fn factory() -> crate::Factory<dyn Zotero> {
    crate::Factory::new(|services, _| {
        #[cfg(feature = "probe")]
        let ids: RequestIds = if services.hosts.get::<NumberedRequestIds>().is_some() {
            numbered_request_ids()
        } else {
            Box::new(request_id)
        };
        #[cfg(not(feature = "probe"))]
        let ids: RequestIds = Box::new(request_id);
        #[cfg(feature = "probe")]
        let connector: Arc<dyn ZoteroConnector> = match services.hosts.get::<ProbeConnector>() {
            Some(make) => (make.0)(services.workers.clone()),
            None => Arc::new(TcpConnector::new(services.workers.clone())),
        };
        #[cfg(not(feature = "probe"))]
        let connector: Arc<dyn ZoteroConnector> =
            Arc::new(TcpConnector::new(services.workers.clone()));
        let port = ZoteroPort::with_ids(
            services.events.clone(),
            services.core.clone(),
            connector,
            ids,
        );
        let inner = port.inner.clone();
        services
            .views
            .on_destroyed(Box::new(move |view| inner.teardown(view)));
        let port: Rc<dyn Zotero> = Rc::new(port);
        Ok(port)
    })
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::net::TcpListener;

    use shell_contract::ipc::Sender;
    use shell_contract::{IpcError, Surface, WindowId};

    use super::*;

    #[derive(Default)]
    struct Core(Mutex<VecDeque<Box<dyn FnOnce() + Send>>>);
    impl Core {
        /// runs what was posted, in order, as the core thread does
        fn run(&self) {
            loop {
                let job = self.0.lock().unwrap().pop_front();
                match job {
                    Some(job) => job(),
                    None => break,
                }
            }
        }
    }
    impl Thread for Core {
        fn post(&self, job: Box<dyn FnOnce() + Send>) {
            self.0.lock().unwrap().push_back(job);
        }
        fn is_current(&self) -> bool {
            true
        }
    }

    #[derive(Default)]
    struct Events(Mutex<Vec<(Target, &'static str, Vec<IpcValue>)>>);
    impl EventSink for Events {
        fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
            self.0.lock().unwrap().push((target, channel, args));
        }
    }

    #[derive(Default)]
    struct FakeSocket {
        written: Mutex<Vec<u8>>,
        ended: AtomicBool,
        gone: AtomicBool,
        destroyed_with: Mutex<Option<Option<String>>>,
    }
    impl ZoteroSocket for FakeSocket {
        fn write(&self, frame: &[u8]) {
            self.written.lock().unwrap().extend_from_slice(frame);
        }
        fn end(&self) {
            self.ended.store(true, Ordering::SeqCst);
        }
        fn destroy(&self, error: Option<&str>) {
            self.gone.store(true, Ordering::SeqCst);
            *self.destroyed_with.lock().unwrap() = Some(error.map(str::to_owned));
        }
        fn destroyed(&self) -> bool {
            self.gone.load(Ordering::SeqCst)
        }
    }
    impl FakeSocket {
        /// the frames written so far, as `(transaction id, payload)`
        fn frames(&self) -> Vec<(u32, String)> {
            let mut decoder = ZoteroFrameDecoder::new();
            decoder
                .push(&self.written.lock().unwrap())
                .unwrap()
                .into_iter()
                .map(|frame| (frame.transaction_id, frame.payload))
                .collect()
        }
    }

    #[derive(Default)]
    struct Connector(Mutex<Vec<(String, u16, SocketSink)>>);
    impl ZoteroConnector for Connector {
        fn connect(&self, host: &str, port: u16, sink: SocketSink) {
            self.0.lock().unwrap().push((host.to_owned(), port, sink));
        }
    }

    struct Rig {
        core: Arc<Core>,
        events: Arc<Events>,
        connector: Arc<Connector>,
        port: ZoteroPort,
    }

    fn rig() -> Rig {
        let core = Arc::new(Core::default());
        let events = Arc::new(Events::default());
        let connector = Arc::new(Connector::default());
        let port = ZoteroPort::new(events.clone(), core.clone(), connector.clone());
        Rig {
            core,
            events,
            connector,
            port,
        }
    }

    fn cx(view: u32, cancel: &CancelToken) -> CallContext {
        CallContext {
            sender: Sender {
                view: ViewId(view),
                window: WindowId(1),
                surface: Surface::Docs,
            },
            request: None,
            cancel: cancel.clone(),
        }
    }

    type Slot = Arc<Mutex<Option<Result<IpcValue, IpcError>>>>;

    fn responder() -> (Responder, Slot) {
        let slot: Slot = Arc::new(Mutex::new(None));
        let out = slot.clone();
        (
            Responder::new(move |r| *out.lock().unwrap() = Some(r)),
            slot,
        )
    }

    fn obj(entries: &[(&str, IpcValue)]) -> IpcValue {
        IpcValue::Object(
            entries
                .iter()
                .map(|(k, v)| (k.to_string(), v.clone()))
                .collect(),
        )
    }

    fn text(s: &str) -> IpcValue {
        IpcValue::String(s.into())
    }

    /// starts `command` from `view`; the invoke stays open
    fn start(rig: &Rig, view: u32, command: &str) -> Slot {
        let (reply, slot) = responder();
        rig.port.zotero_command(
            &cx(view, &CancelToken::default()),
            vec![text(command)],
            reply,
        );
        slot
    }

    /// the sink of the connection the last `start` opened, and a socket for it
    fn connection(rig: &Rig) -> (SocketSink, Arc<FakeSocket>) {
        let sink = rig.connector.0.lock().unwrap().last().unwrap().2.clone();
        let socket = Arc::new(FakeSocket::default());
        sink(SocketEvent::Connected(socket.clone()));
        rig.core.run();
        (sink, socket)
    }

    fn feed(rig: &Rig, sink: &SocketSink, frames: &[(u32, &str)]) {
        let mut bytes = Vec::new();
        for (id, payload) in frames {
            bytes.extend(encode_zotero_frame(f64::from(*id), payload));
        }
        sink(SocketEvent::Data(bytes));
        rig.core.run();
    }

    fn respond(rig: &Rig, view: u32, response: IpcValue) {
        let (reply, slot) = responder();
        rig.port
            .zotero_response(&cx(view, &CancelToken::default()), vec![response], reply);
        assert_eq!(
            slot.lock().unwrap().take().unwrap().unwrap(),
            IpcValue::Undefined
        );
    }

    /// the `(request id, command)` of every `zotero:request` sent to `view` so far
    fn asked(rig: &Rig, view: u32) -> Vec<(String, String, IpcValue)> {
        rig.events
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|(target, channel, _)| {
                *target == Target::View(ViewId(view)) && *channel == REQUEST_EVENT
            })
            .map(|(_, _, args)| {
                let IpcValue::Object(entries) = &args[0] else {
                    panic!("request is an object")
                };
                let get = |name: &str| entries.iter().find(|(k, _)| k == name).unwrap().1.clone();
                let IpcValue::String(id) = get("requestId") else {
                    panic!("request id")
                };
                let IpcValue::String(command) = get("command") else {
                    panic!("command")
                };
                (id, command, get("args"))
            })
            .collect()
    }

    fn answered(slot: &Slot) -> IpcValue {
        slot.lock().unwrap().take().expect("answered").unwrap()
    }

    #[test]
    fn an_unknown_command_is_refused_without_connecting() {
        let rig = rig();
        let slot = start(&rig, 1, "formatBibliography");
        assert_eq!(
            answered(&slot),
            obj(&[
                ("ok", IpcValue::Bool(false)),
                ("errorCode", text("unsupported-command")),
                ("error", text("Unsupported Zotero command")),
            ])
        );
        assert!(rig.connector.0.lock().unwrap().is_empty());
    }

    #[test]
    fn an_array_that_stringifies_to_a_command_runs_it_as_sent() {
        let rig = rig();
        let (reply, slot) = responder();
        rig.port.zotero_command(
            &cx(1, &CancelToken::default()),
            vec![IpcValue::Array(vec![IpcValue::Array(vec![text(
                "refresh",
            )])])],
            reply,
        );
        assert!(slot.lock().unwrap().is_none());
        let (_sink, socket) = connection(&rig);
        assert_eq!(
            socket.frames(),
            vec![(
                0,
                r#"{"command":[["refresh"]],"templateVersion":1}"#.to_owned()
            )]
        );
        // two elements join as "refresh,refresh": no command
        let (reply, refused) = responder();
        rig.port.zotero_command(
            &cx(2, &CancelToken::default()),
            vec![IpcValue::Array(vec![text("refresh"), text("refresh")])],
            reply,
        );
        assert_eq!(
            answered(&refused),
            obj(&[
                ("ok", IpcValue::Bool(false)),
                ("errorCode", text("unsupported-command")),
                ("error", text("Unsupported Zotero command")),
            ])
        );
    }

    #[test]
    fn a_command_runs_until_zotero_closes_the_connection() {
        let rig = rig();
        let slot = start(&rig, 1, "refresh");
        {
            let connects = rig.connector.0.lock().unwrap();
            assert_eq!(connects.len(), 1);
            assert_eq!(connects[0].0, "127.0.0.1");
            assert_eq!(connects[0].1, 23116);
        }
        assert!(slot.lock().unwrap().is_none());
        let (sink, socket) = connection(&rig);
        assert_eq!(
            socket.frames(),
            vec![(0, r#"{"command":"refresh","templateVersion":1}"#.to_owned())]
        );
        // still running: the invoke stays open and a second command is refused
        assert!(slot.lock().unwrap().is_none());
        let second = start(&rig, 1, "refresh");
        assert_eq!(
            answered(&second),
            obj(&[
                ("ok", IpcValue::Bool(false)),
                ("errorCode", text("operation-failed")),
                ("error", text("A Zotero operation is already running")),
            ])
        );
        sink(SocketEvent::Close);
        rig.core.run();
        assert_eq!(answered(&slot), obj(&[("ok", IpcValue::Bool(true))]));
        // the run is over: the view may start another
        let _ = start(&rig, 1, "refresh");
        assert_eq!(rig.connector.0.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_refused_connection_and_a_failed_socket_are_told_apart() {
        let rig = rig();
        let slot = start(&rig, 1, "refresh");
        let sink = rig.connector.0.lock().unwrap()[0].2.clone();
        sink(SocketEvent::ConnectFailed(
            "connect ECONNREFUSED 127.0.0.1:23116".into(),
        ));
        rig.core.run();
        assert_eq!(
            answered(&slot),
            obj(&[
                ("ok", IpcValue::Bool(false)),
                ("errorCode", text("connection-refused")),
                ("error", text("connect ECONNREFUSED 127.0.0.1:23116")),
            ])
        );

        let slot = start(&rig, 1, "refresh");
        let (sink, _socket) = connection(&rig);
        sink(SocketEvent::Error("read ECONNRESET".into()));
        sink(SocketEvent::Error(
            "a second error is not the failure".into(),
        ));
        sink(SocketEvent::Close);
        rig.core.run();
        assert_eq!(
            answered(&slot),
            obj(&[
                ("ok", IpcValue::Bool(false)),
                ("errorCode", text("operation-failed")),
                ("error", text("read ECONNRESET")),
            ])
        );
    }

    #[test]
    fn a_question_goes_to_the_renderer_and_its_answer_goes_back_on_the_same_transaction() {
        let rig = rig();
        let _slot = start(&rig, 1, "addEditCitation");
        let (sink, socket) = connection(&rig);
        feed(
            &rig,
            &sink,
            &[(7, r#"["Document_getFields",["ZOTERO_ITEM"]]"#)],
        );
        let asks = asked(&rig, 1);
        assert_eq!(asks.len(), 1);
        assert_eq!(asks[0].1, "Document_getFields");
        assert_eq!(asks[0].2, IpcValue::Array(vec![text("ZOTERO_ITEM")]));
        // nothing is written until the renderer answers
        assert_eq!(socket.frames().len(), 1);
        respond(
            &rig,
            1,
            obj(&[
                ("requestId", text(&asks[0].0)),
                ("ok", IpcValue::Bool(true)),
                (
                    "result",
                    IpcValue::Array(vec![IpcValue::Number(1.0), text("x")]),
                ),
            ]),
        );
        assert_eq!(socket.frames()[1], (7, r#"[1,"x"]"#.to_owned()));
        // answered once: a repeat finds nothing waiting
        respond(
            &rig,
            1,
            obj(&[
                ("requestId", text(&asks[0].0)),
                ("ok", IpcValue::Bool(true)),
                ("result", IpcValue::Null),
            ]),
        );
        assert_eq!(socket.frames().len(), 2);
    }

    #[test]
    fn two_questions_at_once_are_answered_each_on_its_own_transaction() {
        let rig = rig();
        let _slot = start(&rig, 1, "refresh");
        let (sink, socket) = connection(&rig);
        feed(
            &rig,
            &sink,
            &[
                (3, r#"["Document_getFields",[]]"#),
                (4, r#"["Document_getDocumentData",[]]"#),
            ],
        );
        let asks = asked(&rig, 1);
        assert_eq!(asks.len(), 2);
        assert_ne!(asks[0].0, asks[1].0);
        // the renderer answers the second question first
        respond(
            &rig,
            1,
            obj(&[
                ("requestId", text(&asks[1].0)),
                ("ok", IpcValue::Bool(true)),
                ("result", text("data")),
            ]),
        );
        respond(
            &rig,
            1,
            obj(&[
                ("requestId", text(&asks[0].0)),
                ("ok", IpcValue::Bool(true)),
                ("result", text("fields")),
            ]),
        );
        let frames = socket.frames();
        assert_eq!(frames[1], (4, r#""data""#.to_owned()));
        assert_eq!(frames[2], (3, r#""fields""#.to_owned()));
    }

    #[test]
    fn a_response_from_another_view_is_ignored() {
        let rig = rig();
        let _slot = start(&rig, 1, "refresh");
        let (sink, socket) = connection(&rig);
        feed(&rig, &sink, &[(5, r#"["Document_getFields",[]]"#)]);
        let id = asked(&rig, 1)[0].0.clone();
        respond(
            &rig,
            2,
            obj(&[
                ("requestId", text(&id)),
                ("ok", IpcValue::Bool(true)),
                ("result", text("not yours")),
            ]),
        );
        assert_eq!(socket.frames().len(), 1);
        // the asking view can still answer it
        respond(
            &rig,
            1,
            obj(&[
                ("requestId", text(&id)),
                ("ok", IpcValue::Bool(true)),
                ("result", text("mine")),
            ]),
        );
        assert_eq!(socket.frames()[1], (5, r#""mine""#.to_owned()));
        // junk is ignored as well
        respond(&rig, 1, IpcValue::Null);
        respond(&rig, 1, obj(&[("requestId", IpcValue::Number(1.0))]));
        assert_eq!(socket.frames().len(), 2);
    }

    #[test]
    fn a_failed_response_becomes_an_error_frame() {
        let rig = rig();
        let _slot = start(&rig, 1, "refresh");
        let (sink, socket) = connection(&rig);
        feed(
            &rig,
            &sink,
            &[(1, r#"["a",[]]"#), (2, r#"["b",[]]"#), (3, r#"["c",[]]"#)],
        );
        let asks = asked(&rig, 1);
        respond(
            &rig,
            1,
            obj(&[
                ("requestId", text(&asks[0].0)),
                ("ok", IpcValue::Bool(false)),
                ("error", text("No field")),
            ]),
        );
        respond(
            &rig,
            1,
            obj(&[
                ("requestId", text(&asks[1].0)),
                ("ok", IpcValue::Bool(false)),
            ]),
        );
        // `ok` is judged as JavaScript does: 0 is a failure, a string a success
        respond(
            &rig,
            1,
            obj(&[
                ("requestId", text(&asks[2].0)),
                ("ok", text("yes")),
                ("result", IpcValue::Bool(false)),
            ]),
        );
        let frames = socket.frames();
        assert_eq!(frames[1], (1, "ERR:No field".to_owned()));
        assert_eq!(
            frames[2],
            (2, "ERR:Zotero document operation failed".to_owned())
        );
        assert_eq!(frames[3], (3, "false".to_owned()));
    }

    #[test]
    fn an_error_that_is_not_text_is_worded_as_new_error_words_it() {
        let rig = rig();
        let _slot = start(&rig, 1, "refresh");
        let (sink, socket) = connection(&rig);
        feed(
            &rig,
            &sink,
            &[(1, r#"["a",[]]"#), (2, r#"["b",[]]"#), (3, r#"["c",[]]"#)],
        );
        let asks = asked(&rig, 1);
        let failed = |at: usize, error: IpcValue| {
            respond(
                &rig,
                1,
                obj(&[
                    ("requestId", text(&asks[at].0)),
                    ("ok", IpcValue::Bool(false)),
                    ("error", error),
                ]),
            )
        };
        // an array joins its elements with commas, null as nothing
        failed(
            0,
            IpcValue::Array(vec![
                text("a"),
                IpcValue::Number(1.0),
                IpcValue::Null,
                IpcValue::Array(vec![text("b")]),
            ]),
        );
        failed(1, obj(&[("message", text("m"))]));
        failed(2, IpcValue::Number(5.0));
        let frames = socket.frames();
        assert_eq!(frames[1], (1, "ERR:a,1,,b".to_owned()));
        assert_eq!(frames[2], (2, "ERR:[object Object]".to_owned()));
        assert_eq!(frames[3], (3, "ERR:5".to_owned()));
    }

    #[test]
    fn a_question_that_does_not_parse_is_answered_at_once() {
        let rig = rig();
        let _slot = start(&rig, 1, "refresh");
        let (sink, socket) = connection(&rig);
        feed(
            &rig,
            &sink,
            &[
                (0, r#"["ignored",[]]"#),
                (9, r#"{"not":"a request"}"#),
                (10, "{"),
            ],
        );
        let frames = socket.frames();
        assert_eq!(frames.len(), 3);
        assert_eq!(
            frames[1],
            (9, "ERR:Invalid Zotero integration request".to_owned())
        );
        assert_eq!(frames[2].0, 10);
        assert!(frames[2].1.starts_with("ERR:"));
        assert!(asked(&rig, 1).is_empty());
    }

    #[test]
    fn a_broken_frame_destroys_the_connection_with_its_error() {
        let rig = rig();
        let _slot = start(&rig, 1, "refresh");
        let (sink, socket) = connection(&rig);
        let mut bytes = 5u32.to_be_bytes().to_vec();
        bytes.extend(u32::MAX.to_be_bytes());
        sink(SocketEvent::Data(bytes));
        rig.core.run();
        assert_eq!(
            *socket.destroyed_with.lock().unwrap(),
            Some(Some("Zotero integration payload is too large".to_owned()))
        );
    }

    #[test]
    fn the_connection_ends_after_the_answer_to_document_complete() {
        let rig = rig();
        let _slot = start(&rig, 1, "refresh");
        let (sink, socket) = connection(&rig);
        feed(&rig, &sink, &[(8, r#"["Document_complete",[]]"#)]);
        assert!(!socket.ended.load(Ordering::SeqCst));
        let id = asked(&rig, 1)[0].0.clone();
        respond(
            &rig,
            1,
            obj(&[
                ("requestId", text(&id)),
                ("ok", IpcValue::Bool(true)),
                ("result", IpcValue::Null),
            ]),
        );
        assert_eq!(socket.frames()[1], (8, "null".to_owned()));
        assert!(socket.ended.load(Ordering::SeqCst));
    }

    #[test]
    fn a_question_the_renderer_never_answers_times_out() {
        let rig = rig();
        let _slot = start(&rig, 1, "refresh");
        let (sink, socket) = connection(&rig);
        feed(&rig, &sink, &[(6, r#"["Document_displayAlert",[]]"#)]);
        let id = asked(&rig, 1)[0].0.clone();
        rig.port.inner.expire(Instant::now());
        // not yet: the deadline is ten minutes away
        assert_eq!(socket.frames().len(), 1);
        rig.port
            .inner
            .expire(Instant::now() + REQUEST_TIMEOUT + Duration::from_secs(1));
        assert_eq!(
            socket.frames()[1],
            (6, "ERR:Timed out handling Document_displayAlert".to_owned())
        );
        // the late answer finds nothing
        respond(
            &rig,
            1,
            obj(&[("requestId", text(&id)), ("ok", IpcValue::Bool(true))]),
        );
        assert_eq!(socket.frames().len(), 2);
    }

    #[test]
    fn a_view_that_goes_away_closes_its_run_and_drops_its_questions() {
        let rig = rig();
        let slot = start(&rig, 1, "refresh");
        let other = start(&rig, 2, "refresh");
        let (sink1, socket1) = {
            let sink = rig.connector.0.lock().unwrap()[0].2.clone();
            let socket = Arc::new(FakeSocket::default());
            sink(SocketEvent::Connected(socket.clone()));
            (sink, socket)
        };
        let (sink2, socket2) = {
            let sink = rig.connector.0.lock().unwrap()[1].2.clone();
            let socket = Arc::new(FakeSocket::default());
            sink(SocketEvent::Connected(socket.clone()));
            (sink, socket)
        };
        rig.core.run();
        feed(&rig, &sink1, &[(1, r#"["a",[]]"#)]);
        feed(&rig, &sink2, &[(1, r#"["a",[]]"#)]);
        let first = asked(&rig, 1)[0].0.clone();
        let second = asked(&rig, 2)[0].0.clone();

        rig.port.view_destroyed(ViewId(1));
        assert!(socket1.destroyed());
        assert_eq!(answered(&slot), obj(&[("ok", IpcValue::Bool(true))]));
        // a response that still arrives finds no question; no frame is written
        respond(
            &rig,
            1,
            obj(&[("requestId", text(&first)), ("ok", IpcValue::Bool(true))]),
        );
        assert_eq!(socket1.frames().len(), 1);
        // the late events of the closed connection change nothing
        sink1(SocketEvent::Close);
        rig.core.run();

        // the other view is untouched
        assert!(!socket2.destroyed());
        assert!(other.lock().unwrap().is_none());
        respond(
            &rig,
            2,
            obj(&[
                ("requestId", text(&second)),
                ("ok", IpcValue::Bool(true)),
                ("result", text("ok")),
            ]),
        );
        assert_eq!(socket2.frames()[1], (1, r#""ok""#.to_owned()));
    }

    #[test]
    fn a_view_that_goes_away_while_connecting_does_not_leave_a_connection_open() {
        let rig = rig();
        let slot = start(&rig, 1, "refresh");
        let sink = rig.connector.0.lock().unwrap()[0].2.clone();
        rig.port.view_destroyed(ViewId(1));
        assert_eq!(answered(&slot), obj(&[("ok", IpcValue::Bool(true))]));
        let socket = Arc::new(FakeSocket::default());
        sink(SocketEvent::Connected(socket.clone()));
        rig.core.run();
        assert!(socket.destroyed());
        assert!(socket.frames().is_empty());
    }

    #[test]
    fn a_cancelled_invoke_tears_the_run_down_at_its_next_event() {
        let rig = rig();
        let cancel = CancelToken::default();
        let (reply, slot) = responder();
        rig.port
            .zotero_command(&cx(1, &cancel), vec![text("refresh")], reply);
        let (sink, socket) = connection(&rig);
        feed(&rig, &sink, &[(2, r#"["a",[]]"#)]);
        let id = asked(&rig, 1)[0].0.clone();
        // the view navigated away: the invoke is cancelled
        cancel.cancel();
        sink(SocketEvent::Idle);
        rig.core.run();
        assert!(socket.destroyed());
        assert_eq!(answered(&slot), obj(&[("ok", IpcValue::Bool(true))]));
        respond(
            &rig,
            1,
            obj(&[("requestId", text(&id)), ("ok", IpcValue::Bool(true))]),
        );
        assert_eq!(socket.frames().len(), 1);
    }

    #[test]
    fn a_question_still_open_when_zotero_closes_is_dropped() {
        let rig = rig();
        let slot = start(&rig, 1, "refresh");
        let (sink, socket) = connection(&rig);
        feed(&rig, &sink, &[(2, r#"["a",[]]"#)]);
        let id = asked(&rig, 1)[0].0.clone();
        // the socket is destroyed by the time `close` is raised
        socket.destroy(None);
        sink(SocketEvent::Close);
        rig.core.run();
        assert_eq!(answered(&slot), obj(&[("ok", IpcValue::Bool(true))]));
        respond(
            &rig,
            1,
            obj(&[("requestId", text(&id)), ("ok", IpcValue::Bool(true))]),
        );
        assert_eq!(socket.frames().len(), 1);
        assert!(rig.port.inner.state.lock().unwrap().pending.is_empty());
    }

    struct Threads;
    impl Workers for Threads {
        fn spawn(&self, job: Box<dyn FnOnce() + Send>) {
            std::thread::spawn(job);
        }
    }

    fn collect(connector: &TcpConnector, port: u16) -> mpsc::Receiver<SocketEvent> {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        connector.connect(
            "127.0.0.1",
            port,
            Arc::new(move |event| {
                let _ = tx.lock().unwrap().send(event);
            }),
        );
        rx
    }

    #[test]
    fn the_tcp_connector_talks_to_a_listening_peer_and_reports_its_close() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let peer = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut hello = [0u8; 8];
            stream.read_exact(&mut hello).unwrap();
            let length = u32::from_be_bytes([hello[4], hello[5], hello[6], hello[7]]) as usize;
            let mut body = vec![0u8; length];
            stream.read_exact(&mut body).unwrap();
            stream
                .write_all(&encode_zotero_frame(3.0, r#"["Document_complete",[]]"#))
                .unwrap();
            // the whole answer frame: unread bytes at close would reset the connection
            let mut answer = [0u8; 12];
            stream.read_exact(&mut answer).unwrap();
            String::from_utf8(body).unwrap()
        });
        let connector = TcpConnector::new(Arc::new(Threads));
        let events = collect(&connector, port);
        let SocketEvent::Connected(socket) = events.recv().unwrap() else {
            panic!("connected first")
        };
        socket.write(&encode_zotero_frame(0.0, "{\"command\":\"refresh\"}"));
        let mut decoder = ZoteroFrameDecoder::new();
        let frame = loop {
            match events.recv().unwrap() {
                SocketEvent::Data(chunk) => {
                    let mut frames = decoder.push(&chunk).unwrap();
                    if let Some(frame) = frames.pop() {
                        break frame;
                    }
                }
                SocketEvent::Idle => {}
                _ => panic!("unexpected event"),
            }
        };
        assert_eq!(frame.transaction_id, 3);
        assert_eq!(frame.payload, r#"["Document_complete",[]]"#);
        socket.write(&encode_zotero_frame(3.0, "null"));
        socket.end();
        assert_eq!(peer.join().unwrap(), "{\"command\":\"refresh\"}");
        // the peer hung up: the last event is the close
        loop {
            match events.recv().unwrap() {
                SocketEvent::Close => break,
                SocketEvent::Idle | SocketEvent::Data(_) => {}
                _ => panic!("a clean close raises no error"),
            }
        }
        assert!(socket.destroyed());
    }

    #[test]
    fn the_tcp_connector_reports_a_refused_connection_as_node_does() {
        // a port nothing listens on: bind, note it, drop
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let connector = TcpConnector::new(Arc::new(Threads));
        let events = collect(&connector, port);
        match events.recv().unwrap() {
            SocketEvent::ConnectFailed(message) => {
                assert_eq!(message, format!("connect ECONNREFUSED 127.0.0.1:{port}"));
                assert_eq!(
                    run_failed(&message),
                    command_failed("connection-refused", &message)
                );
            }
            _ => panic!("expected a refusal"),
        }
    }

    #[derive(Default)]
    struct Tracked(Mutex<Vec<std::thread::JoinHandle<()>>>);
    impl Workers for Tracked {
        fn spawn(&self, job: Box<dyn FnOnce() + Send>) {
            self.0.lock().unwrap().push(std::thread::spawn(job));
        }
    }

    #[test]
    fn a_peer_that_stops_reading_does_not_hold_up_the_core_thread() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (release, held) = mpsc::channel::<()>();
        let peer = std::thread::spawn(move || {
            // accepts and then never reads
            let (stream, _) = listener.accept().unwrap();
            let _ = held.recv();
            drop(stream);
        });
        let workers = Arc::new(Tracked::default());
        let connector = TcpConnector::new(workers.clone());
        let events = collect(&connector, port);
        let SocketEvent::Connected(socket) = events.recv().unwrap() else {
            panic!("connected first")
        };

        // far more than the socket buffers on both sides hold
        let chunk = vec![7u8; 1 << 20];
        let started = Instant::now();
        for _ in 0..32 {
            socket.write(&chunk);
        }
        socket.end();
        assert!(started.elapsed() < Duration::from_secs(1));

        // the core thread still takes jobs
        let core = Core::default();
        let ran = Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        core.post(Box::new(move || flag.store(true, Ordering::SeqCst)));
        core.run();
        assert!(ran.load(Ordering::SeqCst));

        // destroying ends the stalled writer and the reader with it
        socket.destroy(None);
        assert!(socket.destroyed());
        loop {
            match events.recv_timeout(Duration::from_secs(5)).unwrap() {
                SocketEvent::Close => break,
                SocketEvent::Idle | SocketEvent::Data(_) => {}
                _ => panic!("destroying without an error raises none"),
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let handles = workers.0.lock().unwrap();
            if handles.iter().all(|handle| handle.is_finished()) {
                break;
            }
            drop(handles);
            assert!(Instant::now() < deadline, "a worker did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = release.send(());
        peer.join().unwrap();
    }
}
