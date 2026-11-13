//! `@modelcontextprotocol/sdk` 1.32.1 `server/index.js` (`Server`),
//! `shared/protocol.js` (request dispatch) and `server/mcp.js` (`McpServer`:
//! `registerTool`, `tools/list`, `tools/call`), without I/O.
//!
//! The SDK answers a request in a promise chain; here a handler is called
//! at once and the answers come back as [`Outgoing`]: the message the
//! transport is asked to `send`, with the depth of the promise chain it was
//! sent from. A transport that delivers several messages in one HTTP request
//! (a batch) sends them in the order of that depth, which is the order the
//! SDK sends them in (`ping` before a `tools/call` of the same batch).
//!
//! Also here: the surface every server module of the SDK port shares with
//! the caller, since all of it is sans-IO. What the TypeScript does to a
//! socket, a response stream or a timer is a [`Command`] pushed on a queue
//! ([`SdkIo`]) in the order the TypeScript does it; the caller carries the
//! commands out. What it reads (`crypto.randomUUID()`, `Date.now()`) is
//! asked of an [`SdkHost`].
//!
//! Left out because nothing of the shell sets it: task stores, resources,
//! prompts, completions, logging levels, `sendToolListChanged`. A tool is
//! registered before the server connects.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use jscompat::{JsMap, JsObject, JsonValue, inherited_string};

use super::types::{
    LATEST_PROTOCOL_VERSION, McpError, SUPPORTED_PROTOCOL_VERSIONS, error_code, error_response,
    result_response, schema,
};
use crate::packages::zod::{ZodShape, parse_error_message, safe_parse, to_json_schema};
use crate::shell::mcp::mcp_server::{HostCall, Settled};

// ---- the sans-IO surface -------------------------------------------------

/// One HTTP response of the server, as the caller numbers it (the
/// `ServerResponse` object of Node).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ResponseId(pub u64);

/// A timer the code started (`setInterval`, `setTimeout`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TimerId(pub u32);

/// A connection of the HTTP server (`net.Socket`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct SocketId(pub u64);

/// One `http.Server` the service listens with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ListenerId(pub u32);

/// A request whose handler answered later (`HandlerReply::Later`): the
/// caller settles it with the ticket of `RequestExtra`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Ticket(pub u64);

/// One call of `start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StartId(pub u32);

/// One call of `stop`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StopId(pub u32);

/// How a `start` ended: `String(error)` of what the promise rejected with.
#[derive(Debug, Clone, PartialEq)]
pub struct StartError {
    pub text: String,
}

/// Why the `AbortSignal` of a deferred request fired.
#[derive(Debug, Clone, PartialEq)]
pub enum AbortCause {
    /// the client sent `notifications/cancelled` for the request; `reason`
    /// is its `reason` (the signal's `reason` is that string, or the
    /// default `AbortError` when there is none)
    Cancelled { reason: Option<String> },
    /// the transport closed (the session ended, or the service stopped)
    Closed,
}

/// The `signal` of a deferred request fired: `extra.signal.aborted`.
#[derive(Debug, Clone, PartialEq)]
pub struct Aborted {
    /// `transport.sessionId` of the session the request came on
    pub session_id: Option<String>,
    pub ticket: Ticket,
    pub cause: AbortCause,
}

/// What the code did, to be carried out in this order.
#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// `res.writeHead(status, headers)` (or the first `res.write`/`res.end`
    /// of a response whose `statusCode` and headers were set): the head
    Respond {
        res: ResponseId,
        status: u16,
        headers: Vec<(String, String)>,
    },
    /// `res.write(chunk)`
    Write { res: ResponseId, chunk: String },
    /// `res.end(chunk)`
    End {
        res: ResponseId,
        chunk: Option<String>,
    },
    /// `req.destroy()`: the connection of this request goes
    Destroy { res: ResponseId },
    /// `setInterval(tick, ms)`: the caller calls `on_timer` every `ms`
    SetInterval { timer: TimerId, ms: f64 },
    /// `setTimeout(done, ms)`: the caller calls `on_timer` once
    SetTimeout { timer: TimerId, ms: f64 },
    /// `clearInterval(timer)`
    ClearTimer { timer: TimerId },
    /// `createServer(...).listen(port, '127.0.0.1')`: the caller answers with
    /// `on_listening` or `on_listen_error`
    Listen { listener: ListenerId, port: f64 },
    /// `server.close()`: the caller answers with `on_listener_closed`
    CloseListener { listener: ListenerId },
    /// `socket.destroy()`
    DestroySocket { socket: SocketId },
    /// the logger option
    Log(String),
    /// a tool of the session awaits a host call: the caller carries it out and
    /// answers with `McpServerService::resume_tool(session_id, ticket, settled)`
    ToolCall {
        session_id: String,
        ticket: Ticket,
        call: HostCall,
    },
    /// the signal of a deferred request fired; its answer is dropped when settled
    Aborted(Aborted),
    /// the promise of `start` settled
    StartSettled {
        start: StartId,
        outcome: Result<(), StartError>,
    },
    /// the promise of `stop` resolved
    StopSettled { stop: StopId },
}

/// What the code reads from the world.
pub trait SdkHost {
    /// `crypto.randomUUID()`
    fn random_uuid(&self) -> String;
    /// `Date.now()`
    fn now_ms(&self) -> f64;
}

/// The queue of [`Command`]s, shared by the service and the transports.
pub struct SdkIo {
    queue: RefCell<Vec<Command>>,
    next_timer: Cell<u32>,
    host: Box<dyn SdkHost>,
}

/// The handle every module holds.
pub type Io = Rc<SdkIo>;

impl SdkIo {
    pub fn new(host: Box<dyn SdkHost>) -> Io {
        Rc::new(SdkIo {
            queue: RefCell::new(Vec::new()),
            next_timer: Cell::new(1),
            host,
        })
    }

    pub fn push(&self, command: Command) {
        self.queue.borrow_mut().push(command);
    }

    /// the logger option, called with one line
    pub fn log(&self, line: impl Into<String>) {
        self.push(Command::Log(line.into()));
    }

    /// the commands since the last call, in order
    pub fn take(&self) -> Vec<Command> {
        std::mem::take(&mut *self.queue.borrow_mut())
    }

    /// how many commands are queued
    pub fn len(&self) -> usize {
        self.queue.borrow().len()
    }

    pub fn is_empty(&self) -> bool {
        self.queue.borrow().is_empty()
    }

    /// the commands queued since position `from`
    pub fn since(&self, from: usize) -> Vec<Command> {
        self.queue.borrow()[from..].to_vec()
    }

    pub fn new_timer(&self) -> TimerId {
        let id = self.next_timer.get();
        self.next_timer.set(id + 1);
        TimerId(id)
    }

    pub fn random_uuid(&self) -> String {
        self.host.random_uuid()
    }

    pub fn now_ms(&self) -> f64 {
        self.host.now_ms()
    }
}

// ---- messages ------------------------------------------------------------

/// What a transport tells the protocol about the message it delivers.
#[derive(Debug, Clone, Default)]
pub struct MessageExtra {
    /// `transport.sessionId`
    pub session_id: Option<String>,
}

/// One message the protocol asks the transport to `send`.
#[derive(Debug, Clone, PartialEq)]
pub struct Outgoing {
    pub message: JsonValue,
    /// a line the tool wrapper logged on the way to this answer: it is logged
    /// when the answer is sent, so lines and answers keep the order of the SDK
    pub log: Option<String>,
    /// the depth of the promise chain the send came from: messages of one
    /// delivery are sent in the order of this number, then of arrival
    pub ticks: u32,
}

/// Sends of one delivery, in the order the SDK performs them.
pub fn in_send_order(mut outgoing: Vec<Outgoing>) -> Vec<Outgoing> {
    outgoing.sort_by_key(|sent| sent.ticks);
    outgoing
}

/// What a client session is served by: the SDK's high-level or low-level
/// server, or a decoration of one.
pub trait SessionServer {
    /// `server.connect(transport)`; `Err` is the message of what it throws
    fn connect(&mut self) -> Result<(), String>;
    /// `transport.onmessage(message, extra)` of a message the transport
    /// parsed with `JSONRPCMessageSchema`
    fn on_message(&mut self, message: &JsonValue, extra: &MessageExtra) -> Vec<Outgoing>;
    /// `transport.onclose()`
    fn on_close(&mut self);
    /// the promise of a deferred request settled: what the SDK sends then
    /// (nothing when the request was aborted or the ticket is unknown)
    fn settle(&mut self, ticket: Ticket, result: Result<JsonValue, HandlerError>) -> Vec<Outgoing> {
        let _ = (ticket, result);
        Vec::new()
    }
    /// the signals that fired since the last call
    fn take_aborted(&mut self) -> Vec<Aborted> {
        Vec::new()
    }
    /// the lines tools logged after their request was handed over, in order
    fn take_logs(&mut self) -> Vec<String> {
        Vec::new()
    }
    /// the awaits tools started since the last call, in order
    fn take_host_calls(&mut self) -> Vec<(Ticket, HostCall)> {
        Vec::new()
    }
    /// the awaited host call of a tool settled: runs the rest of the tool
    /// and, when it ends, what the SDK sends then
    fn resume_tool(&mut self, ticket: Ticket, settled: Settled) -> Vec<Outgoing> {
        let _ = (ticket, settled);
        Vec::new()
    }
    /// a tool of this server is still running (it runs to the end even when
    /// its request was aborted or the session closed)
    fn has_pending_tools(&self) -> bool {
        false
    }
}

// ---- Server ----------------------------------------------------------------

/// What a request handler throws: `error.code` (used when a safe integer),
/// `error.message` (`'Internal error'` when it has none) and `error.data`.
#[derive(Debug, Clone, PartialEq)]
pub struct HandlerError {
    pub code: Option<f64>,
    pub message: Option<String>,
    pub data: Option<JsonValue>,
}

impl HandlerError {
    /// a plain `Error(message)`
    pub fn error(message: impl Into<String>) -> Self {
        HandlerError {
            code: None,
            message: Some(message.into()),
            data: None,
        }
    }
}

impl From<McpError> for HandlerError {
    fn from(error: McpError) -> Self {
        HandlerError {
            code: Some(error.code),
            message: Some(error.message),
            data: error.data,
        }
    }
}

/// What a handler receives besides the parsed request (`extra`).
#[derive(Debug, Clone)]
pub struct RequestExtra {
    pub session_id: Option<String>,
    pub request_id: JsonValue,
    /// what a handler answering later gives back to `settle`
    pub ticket: Ticket,
}

/// What a handler answers: at once, or later (the SDK's handler returns a
/// promise that settles when `McpServerService::settle` is called with the
/// ticket). A request that answers later is aborted by the client's
/// `notifications/cancelled` or by the transport closing; `Command::Aborted`
/// tells the caller, which then settles or not: an aborted request sends
/// nothing.
#[derive(Debug, Clone, PartialEq)]
pub enum HandlerReply {
    Now(Result<JsonValue, HandlerError>),
    Later(Ticket),
}

/// A request handler that may answer later.
pub type DeferredHandler<'h> = Box<dyn FnMut(&JsonValue, &RequestExtra) -> HandlerReply + 'h>;

/// A request handler: the request as the schema parsed it, the result or
/// what it threw. The SDK calls it from a promise, so a handler may also
/// answer asynchronously; this one answers at once.
pub type RequestHandler<'h> =
    Box<dyn FnMut(&JsonValue, &RequestExtra) -> Result<JsonValue, HandlerError> + 'h>;

/// The request schemas of the SDK a handler is set with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestSchema {
    Initialize,
    Ping,
    ListTools,
    CallTool,
}

impl RequestSchema {
    /// the literal of `method`
    pub fn method(self) -> &'static str {
        match self {
            RequestSchema::Initialize => "initialize",
            RequestSchema::Ping => "ping",
            RequestSchema::ListTools => "tools/list",
            RequestSchema::CallTool => "tools/call",
        }
    }

    fn schema(self) -> schema::Schema {
        match self {
            RequestSchema::Initialize => initialize_request(),
            RequestSchema::Ping => schema::ping_request(),
            RequestSchema::ListTools => list_tools_request(),
            RequestSchema::CallTool => call_tool_request(),
        }
    }
}

/// `new Server(serverInfo, options)`'s options
#[derive(Debug, Clone, Default)]
pub struct ServerOptions {
    /// `capabilities` (`{}` when none)
    pub capabilities: Option<JsonValue>,
    pub instructions: Option<String>,
}

/// the depth of a promise chain whose handler answers at once
const TICKS_ANSWERED: u32 = 5;
/// the depth when the handler (or the parse) throws before any await
const TICKS_THREW: u32 = 3;
/// the depth of an answer sent from `_onrequest` itself
const TICKS_AT_ONCE: u32 = 0;

enum Reply {
    Done(Result<JsonValue, HandlerError>),
    Later(Ticket),
    /// a tool of `McpServer` awaits: the SDK listens to no signal there, so
    /// no `Aborted` is reported for it
    ToolLater(Ticket),
}

struct HandlerOutcome {
    reply: Reply,
    /// the line the tool wrapper logged
    log: Option<String>,
    /// the depth when it is not the default of the result
    ticks: Option<u32>,
}

impl HandlerOutcome {
    fn done(result: Result<JsonValue, HandlerError>) -> Self {
        HandlerOutcome {
            reply: Reply::Done(result),
            log: None,
            ticks: None,
        }
    }
}

/// a request whose answer is awaited
struct Pending {
    ticket: Ticket,
    id: JsonValue,
    session_id: Option<String>,
    /// `request.params.task` was truthy
    task_requested: bool,
    kind: RequestSchema,
    /// `signal.aborted`
    aborted: bool,
    /// the abort is reported to the caller (`HandlerReply::Later`)
    reports_abort: bool,
}

type TickedHandler<'h> = Box<dyn FnMut(&JsonValue, &RequestExtra) -> HandlerOutcome + 'h>;

enum Handler<'h> {
    /// `_oninitialize`
    Initialize,
    /// the automatic pong
    Ping,
    Custom(RequestSchema, TickedHandler<'h>),
}

fn object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut out = JsObject::new();
    for (key, value) in entries {
        out.set(key, value);
    }
    JsonValue::Object(out)
}

fn text(value: &str) -> JsonValue {
    JsonValue::String(value.to_owned())
}

/// `mergeCapabilities(base, additional)`
fn merge_capabilities(base: &JsonValue, additional: &JsonValue) -> JsonValue {
    let mut result = match base {
        JsonValue::Object(entries) => entries.clone(),
        _ => JsObject::new(),
    };
    if let JsonValue::Object(extra) = additional {
        for (key, add) in extra.entries() {
            let merged = match (result.get(key), add) {
                (Some(JsonValue::Object(have)), JsonValue::Object(more)) => {
                    let mut both = have.clone();
                    for (k, v) in more.entries() {
                        both.set(k, v.clone());
                    }
                    JsonValue::Object(both)
                }
                _ => add.clone(),
            };
            result.set(key, merged);
        }
    }
    JsonValue::Object(result)
}

/// `Number.isSafeInteger`
fn is_safe_integer(x: f64) -> bool {
    x.is_finite() && x.fract() == 0.0 && x.abs() <= 9_007_199_254_740_991.0
}

/// `new Server(serverInfo, options)`: a protocol endpoint with the handlers
/// of `initialize` and `ping`; `connect` is the transport's `start`.
pub struct Server<'h> {
    server_info: JsonValue,
    capabilities: JsonValue,
    instructions: Option<String>,
    handlers: JsMap<Handler<'h>>,
    connected: bool,
    client_capabilities: Option<JsonValue>,
    client_version: Option<JsonValue>,
    next_ticket: u64,
    pending: Vec<Pending>,
    aborted: Vec<Aborted>,
}

impl<'h> Server<'h> {
    pub fn new(server_info: JsonValue, options: ServerOptions) -> Self {
        let mut handlers = JsMap::new();
        handlers.set("ping", Handler::Ping);
        handlers.set("initialize", Handler::Initialize);
        Server {
            server_info,
            capabilities: options
                .capabilities
                .unwrap_or_else(|| JsonValue::Object(JsObject::new())),
            instructions: options.instructions,
            handlers,
            connected: false,
            client_capabilities: None,
            client_version: None,
            next_ticket: 1,
            pending: Vec::new(),
            aborted: Vec::new(),
        }
    }

    /// `registerCapabilities(capabilities)`: before `connect` only
    pub fn register_capabilities(&mut self, capabilities: &JsonValue) -> Result<(), String> {
        if self.connected {
            return Err("Cannot register capabilities after connecting to transport".to_owned());
        }
        self.capabilities = merge_capabilities(&self.capabilities, capabilities);
        Ok(())
    }

    /// `getCapabilities()`
    pub fn capabilities(&self) -> &JsonValue {
        &self.capabilities
    }

    /// `getClientCapabilities()`
    pub fn client_capabilities(&self) -> Option<&JsonValue> {
        self.client_capabilities.as_ref()
    }

    /// `getClientVersion()`
    pub fn client_version(&self) -> Option<&JsonValue> {
        self.client_version.as_ref()
    }

    /// `assertRequestHandlerCapability(method)`
    fn assert_request_handler_capability(&self, method: &str) -> Result<(), String> {
        let has = |key: &str| {
            self.capabilities
                .get(key)
                .is_some_and(|value| value.truthy())
        };
        match method {
            "tools/call" | "tools/list" if !has("tools") => Err(format!(
                "Server does not support tools (required for {method})"
            )),
            _ => Ok(()),
        }
    }

    /// `assertTaskHandlerCapability(method)`: `assertToolsCallTaskCapability`
    fn assert_task_handler_capability(&self, method: &str) -> Result<(), String> {
        let requests = self
            .capabilities
            .get("tasks")
            .and_then(|tasks| tasks.get("requests").map(|r| r.into_owned()))
            .filter(JsonValue::truthy);
        let Some(requests) = requests else {
            return Err(format!(
                "Server does not support task creation (required for {method})"
            ));
        };
        let has_call = requests
            .get("tools")
            .and_then(|tools| tools.get("call").map(|c| c.truthy()))
            .unwrap_or(false);
        if method == "tools/call" && !has_call {
            return Err(format!(
                "Server does not support task creation for tools/call (required for {method})"
            ));
        }
        Ok(())
    }

    /// `assertCanSetRequestHandler(method)`
    pub fn assert_can_set_request_handler(&self, method: &str) -> Result<(), String> {
        if self.handlers.has(method) {
            Err(format!(
                "A request handler for {method} already exists, which would be overridden"
            ))
        } else {
            Ok(())
        }
    }

    /// `setRequestHandler(schema, handler)`: replaces the handler of the
    /// method; `Err` is the message of what it throws (the server lacks the
    /// capability). A `tools/call` handler gets the checks of
    /// `Server.setRequestHandler`: its result is parsed with
    /// `CallToolResultSchema` (a task-augmented call with
    /// `CreateTaskResultSchema`).
    pub fn set_request_handler(
        &mut self,
        schema: RequestSchema,
        mut handler: RequestHandler<'h>,
    ) -> Result<(), String> {
        self.set_ticked_handler(
            schema,
            Box::new(move |request, extra| HandlerOutcome::done(handler(request, extra))),
        )
    }

    /// `setRequestHandler(schema, handler)` for a handler whose promise
    /// settles later: it answers `HandlerReply::Later(extra.ticket)` and the
    /// caller settles the ticket
    pub fn set_deferred_request_handler(
        &mut self,
        schema: RequestSchema,
        mut handler: DeferredHandler<'h>,
    ) -> Result<(), String> {
        self.set_ticked_handler(
            schema,
            Box::new(move |request, extra| HandlerOutcome {
                reply: match handler(request, extra) {
                    HandlerReply::Now(result) => Reply::Done(result),
                    HandlerReply::Later(ticket) => Reply::Later(ticket),
                },
                log: None,
                ticks: None,
            }),
        )
    }

    fn set_ticked_handler(
        &mut self,
        schema: RequestSchema,
        mut handler: TickedHandler<'h>,
    ) -> Result<(), String> {
        self.assert_request_handler_capability(schema.method())?;
        let run: TickedHandler<'h> = if schema == RequestSchema::CallTool {
            Box::new(move |request, extra| {
                let mut outcome = handler(request, extra);
                if let Reply::Done(result) = outcome.reply {
                    outcome.reply = Reply::Done(result.and_then(|result| {
                        validated_call_result(task_requested_of(request), result)
                    }));
                }
                outcome
            })
        } else {
            handler
        };
        self.handlers
            .set(schema.method(), Handler::Custom(schema, run));
        Ok(())
    }

    /// `_oninitialize(request)`
    fn on_initialize(&mut self, request: &JsonValue) -> JsonValue {
        let null = JsonValue::Null;
        let params = request.get("params");
        let params = params.as_deref().unwrap_or(&null);
        let requested = params.get("protocolVersion");
        self.client_capabilities = params.get("capabilities").map(|v| v.into_owned());
        self.client_version = params.get("clientInfo").map(|v| v.into_owned());
        let protocol_version = match requested.as_deref() {
            Some(JsonValue::String(version))
                if SUPPORTED_PROTOCOL_VERSIONS.contains(&version.as_str()) =>
            {
                version.as_str()
            }
            _ => LATEST_PROTOCOL_VERSION,
        };
        let mut entries = vec![
            ("protocolVersion", text(protocol_version)),
            ("capabilities", self.capabilities.clone()),
            ("serverInfo", self.server_info.clone()),
        ];
        if let Some(instructions) = &self.instructions
            && !instructions.is_empty()
        {
            entries.push(("instructions", text(instructions)));
        }
        object(entries)
    }

    /// `Protocol._onrequest(request, extra)`
    fn on_request(&mut self, request: &JsonValue, extra: &MessageExtra) -> Vec<Outgoing> {
        let id = request
            .get("id")
            .map(|v| v.into_owned())
            .unwrap_or(JsonValue::Null);
        let method = match request.get("method").as_deref() {
            Some(JsonValue::String(method)) => method.clone(),
            _ => String::new(),
        };
        let kind = match self.handlers.get(&method) {
            None => {
                return vec![Outgoing {
                    message: error_response(
                        id,
                        error_code::METHOD_NOT_FOUND,
                        "Method not found",
                        None,
                    ),
                    log: None,
                    ticks: TICKS_AT_ONCE,
                }];
            }
            Some(Handler::Initialize) => RequestSchema::Initialize,
            Some(Handler::Ping) => RequestSchema::Ping,
            Some(Handler::Custom(schema, _)) => *schema,
        };
        let ticket = Ticket(self.next_ticket);
        self.next_ticket += 1;
        let handler_extra = RequestExtra {
            session_id: extra.session_id.clone(),
            request_id: id.clone(),
            ticket,
        };
        // a task-augmented request needs the server to support tasks
        if request
            .get("params")
            .is_some_and(|params| task_creation_requested(&params))
            && let Err(message) = self.assert_task_handler_capability(&method)
        {
            return vec![reply(id, Err(HandlerError::error(message)), TICKS_THREW)];
        }
        // `parseWithCompat(requestSchema, request)`: a ZodError is thrown
        let parsed = match schema::safe_parse(&kind.schema(), request) {
            Ok(parsed) => parsed,
            Err(issues) => {
                let error = HandlerError::error(schema::error_message(&issues));
                return vec![reply(id, Err(error), TICKS_THREW)];
            }
        };
        let outcome = match kind {
            RequestSchema::Initialize => HandlerOutcome::done(Ok(self.on_initialize(&parsed))),
            RequestSchema::Ping => HandlerOutcome::done(Ok(JsonValue::Object(JsObject::new()))),
            _ => match self.handlers.get_mut(&method) {
                Some(Handler::Custom(_, run)) => run(&parsed, &handler_extra),
                _ => return Vec::new(),
            },
        };
        let result = match outcome.reply {
            Reply::Done(result) => result,
            Reply::Later(ticket) | Reply::ToolLater(ticket) => {
                let reports_abort = matches!(outcome.reply, Reply::Later(_));
                // the handler's promise is pending: its abort controller is
                // in the map until it settles
                self.pending.push(Pending {
                    ticket,
                    id,
                    session_id: extra.session_id.clone(),
                    task_requested: task_requested_of(&parsed),
                    kind,
                    aborted: false,
                    reports_abort,
                });
                return Vec::new();
            }
        };
        let ticks = outcome.ticks.unwrap_or(match result {
            Ok(_) => TICKS_ANSWERED,
            Err(_) => TICKS_THREW,
        });
        let mut sent = reply(id, result, ticks);
        sent.log = outcome.log;
        vec![sent]
    }

    /// `controller.abort(reason)` of a pending request
    fn abort(&mut self, at: usize, cause: AbortCause) {
        if self.pending[at].aborted {
            return;
        }
        self.pending[at].aborted = true;
        if self.pending[at].reports_abort {
            self.aborted.push(Aborted {
                session_id: self.pending[at].session_id.clone(),
                ticket: self.pending[at].ticket,
                cause,
            });
        }
    }

    /// `_onnotification`: only `notifications/cancelled` does anything the
    /// caller sees (`_oncancel`); the others reach no handler
    fn on_notification(&mut self, notification: &JsonValue) {
        let Ok(parsed) = schema::safe_parse(&schema::cancelled_notification(), notification) else {
            return;
        };
        let params = parsed.get("params");
        let Some(params) = params.as_deref() else {
            return;
        };
        let request_id = params.get("requestId").map(|v| v.into_owned());
        // `if (!notification.params.requestId) return`
        let Some(request_id) = request_id.filter(JsonValue::truthy) else {
            return;
        };
        let reason = match params.get("reason").as_deref() {
            Some(JsonValue::String(reason)) => Some(reason.clone()),
            _ => None,
        };
        if let Some(at) = self.pending.iter().rposition(|p| p.id == request_id) {
            self.abort(at, AbortCause::Cancelled { reason });
        }
    }
}

/// The answer to a request: `{ result, jsonrpc, id }`, or the error response
/// built from what the handler threw.
fn reply(id: JsonValue, result: Result<JsonValue, HandlerError>, ticks: u32) -> Outgoing {
    let message = match result {
        Ok(result) => result_response(id, result),
        Err(error) => {
            let code = match error.code {
                Some(code) if is_safe_integer(code) => code,
                _ => error_code::INTERNAL_ERROR,
            };
            let message = error.message.unwrap_or_else(|| "Internal error".to_owned());
            error_response(id, code, &message, error.data)
        }
    };
    Outgoing {
        message,
        log: None,
        ticks,
    }
}

/// `request.params.task` is truthy
fn task_requested_of(request: &JsonValue) -> bool {
    request
        .get("params")
        .and_then(|params| params.get("task").map(|task| task.truthy()))
        .unwrap_or(false)
}

/// The wrapper `Server.setRequestHandler` puts around `tools/call`: the
/// result is parsed, and what the parse makes of it is the result.
fn validated_call_result(
    task_requested: bool,
    result: JsonValue,
) -> Result<JsonValue, HandlerError> {
    if task_requested {
        let created =
            schema::result().extend(schema::shape(vec![("task", schema::object(Vec::new()))]));
        return match schema::safe_parse(&created, &result) {
            Ok(parsed) => Ok(parsed),
            Err(issues) => Err(McpError::new(
                error_code::INVALID_PARAMS,
                &format!(
                    "Invalid task creation result: {}",
                    schema::error_message(&issues)
                ),
                None,
            )
            .into()),
        };
    }
    match schema::safe_parse(&schema::call_tool_result(), &result) {
        Ok(parsed) => Ok(parsed),
        Err(issues) => Err(McpError::new(
            error_code::INVALID_PARAMS,
            &format!(
                "Invalid tools/call result: {}",
                schema::error_message(&issues)
            ),
            None,
        )
        .into()),
    }
}

impl SessionServer for Server<'_> {
    /// `Protocol.connect(transport)`
    fn connect(&mut self) -> Result<(), String> {
        if self.connected {
            return Err("Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.".to_owned());
        }
        self.connected = true;
        Ok(())
    }

    /// `transport.onmessage`: a response or a notification changes nothing
    /// the caller sees (the SDK reports an unknown response id and an
    /// unknown message to `onerror`, which nothing sets).
    fn on_message(&mut self, message: &JsonValue, extra: &MessageExtra) -> Vec<Outgoing> {
        if !self.connected {
            return Vec::new();
        }
        if schema::is_jsonrpc_result_response(message) || schema::is_jsonrpc_error_response(message)
        {
            Vec::new()
        } else if schema::is_jsonrpc_request(message) {
            self.on_request(message, extra)
        } else {
            if schema::is_jsonrpc_notification(message) {
                self.on_notification(message);
            }
            Vec::new()
        }
    }

    /// `Protocol._onclose()`: every pending request is aborted
    fn on_close(&mut self) {
        self.connected = false;
        for at in 0..self.pending.len() {
            self.abort(at, AbortCause::Closed);
        }
        self.pending.clear();
    }

    /// what the handler's promise settling does: the response, unless the
    /// request was aborted (the SDK returns before sending)
    fn settle(&mut self, ticket: Ticket, result: Result<JsonValue, HandlerError>) -> Vec<Outgoing> {
        let Some(at) = self.pending.iter().position(|p| p.ticket == ticket) else {
            return Vec::new();
        };
        let pending = self.pending.remove(at);
        if pending.aborted || !self.connected {
            return Vec::new();
        }
        let result = if pending.kind == RequestSchema::CallTool {
            result.and_then(|result| validated_call_result(pending.task_requested, result))
        } else {
            result
        };
        // answered in the order of settling
        vec![reply(pending.id, result, 0)]
    }

    fn take_aborted(&mut self) -> Vec<Aborted> {
        std::mem::take(&mut self.aborted)
    }
}

// ---- the request schemas of the server -------------------------------------

/// `isTaskAugmentedRequestParams(params) ? params.task : undefined`, truthy
fn task_creation_requested(params: &JsonValue) -> bool {
    use schema::{number, object, shape};
    let augmented = base_request_params().extend(shape(vec![(
        "task",
        object(shape(vec![("ttl", number().optional())])).optional(),
    )]));
    schema::is_valid(&augmented, params) && params.get("task").is_some_and(|task| task.truthy())
}

/// `BaseRequestParamsSchema`, read off `PingRequestSchema`
fn base_request_params() -> schema::Schema {
    match schema::ping_request()
        .shape()
        .into_iter()
        .find(|(key, _)| key == "params")
    {
        Some((_, schema::Schema::Optional(inner))) => *inner,
        _ => schema::object(Vec::new()),
    }
}

fn implementation() -> schema::Schema {
    use schema::{array, enum_of, object, shape, string};
    object(shape(vec![
        ("name", string()),
        ("title", string().optional()),
        (
            "icons",
            array(object(shape(vec![
                ("src", string()),
                ("mimeType", string().optional()),
                ("sizes", array(string()).optional()),
                ("theme", enum_of(&["light", "dark"]).optional()),
            ])))
            .optional(),
        ),
        ("version", string()),
        ("websiteUrl", string().optional()),
        ("description", string().optional()),
    ]))
}

/// `ClientCapabilitiesSchema`; `elicitation` is read as a loose object (its
/// intersection with a record makes one more issue for a value that is not
/// an object)
fn client_capabilities() -> schema::Schema {
    use schema::{boolean, loose_object, object, object_like, record, shape};
    object(shape(vec![
        ("experimental", record(object_like()).optional()),
        (
            "sampling",
            object(shape(vec![
                ("context", object_like().optional()),
                ("tools", object_like().optional()),
            ]))
            .optional(),
        ),
        (
            "elicitation",
            loose_object(shape(vec![
                (
                    "form",
                    loose_object(shape(vec![("applyDefaults", boolean().optional())])).optional(),
                ),
                ("url", object_like().optional()),
            ]))
            .optional(),
        ),
        (
            "roots",
            object(shape(vec![("listChanged", boolean().optional())])).optional(),
        ),
        (
            "tasks",
            loose_object(shape(vec![
                ("list", object_like().optional()),
                ("cancel", object_like().optional()),
                (
                    "requests",
                    loose_object(shape(vec![
                        (
                            "sampling",
                            loose_object(shape(vec![("createMessage", object_like().optional())]))
                                .optional(),
                        ),
                        (
                            "elicitation",
                            loose_object(shape(vec![("create", object_like().optional())]))
                                .optional(),
                        ),
                    ]))
                    .optional(),
                ),
            ]))
            .optional(),
        ),
        ("extensions", record(object_like()).optional()),
    ]))
}

/// `InitializeRequestSchema`
pub fn initialize_request() -> schema::Schema {
    use schema::{literal, shape, string};
    schema::ping_request().extend(shape(vec![
        ("method", literal("initialize")),
        (
            "params",
            base_request_params().extend(shape(vec![
                ("protocolVersion", string()),
                ("capabilities", client_capabilities()),
                ("clientInfo", implementation()),
            ])),
        ),
    ]))
}

/// `isInitializeRequest(value)`
pub fn is_initialize_request(value: &JsonValue) -> bool {
    schema::is_valid(&initialize_request(), value)
}

/// `ListToolsRequestSchema`
pub fn list_tools_request() -> schema::Schema {
    use schema::{literal, shape, string};
    schema::ping_request().extend(shape(vec![
        ("method", literal("tools/list")),
        (
            "params",
            base_request_params()
                .extend(shape(vec![("cursor", string().optional())]))
                .optional(),
        ),
    ]))
}

/// `CallToolRequestSchema`
pub fn call_tool_request() -> schema::Schema {
    use schema::{literal, number, object, record, shape, string, unknown};
    schema::ping_request().extend(shape(vec![
        ("method", literal("tools/call")),
        (
            "params",
            base_request_params().extend(shape(vec![
                (
                    "task",
                    object(shape(vec![("ttl", number().optional())])).optional(),
                ),
                ("name", string()),
                ("arguments", record(unknown()).optional()),
            ])),
        ),
    ]))
}

// ---- McpServer -------------------------------------------------------------

/// What `registerTool` takes besides the name and the callback.
pub struct ToolConfig {
    pub description: Option<String>,
    /// the raw shape; `None` when the tool has no `inputSchema`
    pub input_schema: Option<Rc<ZodShape>>,
}

/// What a tool callback answers: the `CallToolResult` it returned (the
/// shell's wrapper never rejects: a throw is a result with `isError`).
pub struct ToolReturn {
    pub result: JsonValue,
    /// the `[mcp] tool ...` line logged when the wrapper settled
    pub log: Option<String>,
    /// the work behind the callback rejected, which ends its promise chain
    /// one step sooner (it moves the order of the answers of a batch)
    pub rejected: bool,
}

/// A step of a tool callback: done, or awaiting a host call (the promise of
/// the callback stays pending until `McpServer::resume_tool`).
pub enum CallStep<'h> {
    Done(ToolReturn),
    Await {
        call: HostCall,
        then: Box<dyn FnOnce(Settled) -> CallStep<'h> + 'h>,
    },
}

/// The callback of a tool, called with the parsed arguments, `None` where
/// the tool has no schema (the SDK hands such a callback its `extra`).
pub type ToolCallback<'h> = Rc<RefCell<dyn FnMut(Option<&JsonValue>) -> CallStep<'h> + 'h>>;

struct RegisteredTool<'h> {
    description: Option<String>,
    input_schema: Option<Rc<ZodShape>>,
    callback: ToolCallback<'h>,
}

type Continuation<'h> = Box<dyn FnOnce(Settled) -> CallStep<'h> + 'h>;

struct Registry<'h> {
    tools: JsObject<RegisteredTool<'h>>,
    max_tool_input_elements: Option<f64>,
    /// tool calls awaiting a host call, by the ticket of their request
    inflight: Vec<(Ticket, Continuation<'h>)>,
    /// the awaits not yet taken by the caller
    host_calls: Vec<(Ticket, HostCall)>,
    /// lines logged after the request was handed over (`resume_tool`)
    logs: Vec<String>,
}

/// `new McpServer(serverInfo, options)`'s options
#[derive(Debug, Clone, Default)]
pub struct McpServerOptions {
    pub server: ServerOptions,
    /// `maxToolInputElements`: `None` (or Infinity) is no limit
    pub max_tool_input_elements: Option<f64>,
}

/// `McpServer`: tools by `registerTool`, served through a [`Server`].
pub struct McpServer<'h> {
    server: Server<'h>,
    registry: Rc<RefCell<Registry<'h>>>,
    tool_handlers_initialized: bool,
}

/// the depths of `tools/call` for the callback the shell registers (an async
/// function that awaits the tool once)
const TICKS_CALL_NOT_FOUND: u32 = 5;
const TICKS_CALL_INVALID: u32 = 8;
const TICKS_CALL_PLAIN: u32 = 10;
const TICKS_CALL_PLAIN_REJECTED: u32 = 9;
const TICKS_CALL_SCHEMA: u32 = 12;
const TICKS_CALL_SCHEMA_REJECTED: u32 = 11;

/// `toolInputElementCount(value, max)`
fn tool_input_element_count(value: &JsonValue, max: f64) -> f64 {
    let mut count = 0.0;
    let mut stack = vec![value];
    while let Some(node) = stack.pop() {
        match node {
            JsonValue::Array(items) => {
                for child in items {
                    count += 1.0;
                    if count > max {
                        return count;
                    }
                    if matches!(child, JsonValue::Array(_) | JsonValue::Object(_)) {
                        stack.push(child);
                    }
                }
            }
            JsonValue::Object(entries) => {
                for (_, child) in entries.entries() {
                    count += 1.0;
                    if count > max {
                        return count;
                    }
                    if matches!(child, JsonValue::Array(_) | JsonValue::Object(_)) {
                        stack.push(child);
                    }
                }
            }
            _ => {}
        }
    }
    count
}

/// `createToolError(message)`
fn create_tool_error(message: &str) -> JsonValue {
    object(vec![
        (
            "content",
            JsonValue::Array(vec![object(vec![
                ("type", text("text")),
                ("text", text(message)),
            ])]),
        ),
        ("isError", JsonValue::Bool(true)),
    ])
}

impl<'h> McpServer<'h> {
    pub fn new(server_info: JsonValue, options: McpServerOptions) -> Self {
        McpServer {
            server: Server::new(server_info, options.server),
            registry: Rc::new(RefCell::new(Registry {
                tools: JsObject::new(),
                max_tool_input_elements: options.max_tool_input_elements.filter(|n| n.is_finite()),
                inflight: Vec::new(),
                host_calls: Vec::new(),
                logs: Vec::new(),
            })),
            tool_handlers_initialized: false,
        }
    }

    /// `server`: the low-level server
    pub fn server(&mut self) -> &mut Server<'h> {
        &mut self.server
    }

    /// `registerTool(name, { description, inputSchema }, cb)`
    pub fn register_tool(
        &mut self,
        name: &str,
        config: ToolConfig,
        callback: ToolCallback<'h>,
    ) -> Result<(), String> {
        if self.registry.borrow().tools.get(name).is_some() {
            return Err(format!("Tool {name} is already registered"));
        }
        self.registry.borrow_mut().tools.set(
            name,
            RegisteredTool {
                description: config.description,
                input_schema: config.input_schema,
                callback,
            },
        );
        self.set_tool_request_handlers()
    }

    /// `setToolRequestHandlers()`
    fn set_tool_request_handlers(&mut self) -> Result<(), String> {
        if self.tool_handlers_initialized {
            return Ok(());
        }
        self.server
            .assert_can_set_request_handler(RequestSchema::ListTools.method())?;
        self.server
            .assert_can_set_request_handler(RequestSchema::CallTool.method())?;
        self.server.register_capabilities(&object(vec![(
            "tools",
            object(vec![("listChanged", JsonValue::Bool(true))]),
        )]))?;
        let registry = Rc::clone(&self.registry);
        self.server.set_ticked_handler(
            RequestSchema::ListTools,
            Box::new(move |_, _| HandlerOutcome::done(Ok(list_tools(&registry.borrow())))),
        )?;
        let registry = Rc::clone(&self.registry);
        self.server.set_ticked_handler(
            RequestSchema::CallTool,
            Box::new(move |request, extra| call_tool(&registry, request, extra.ticket)),
        )?;
        self.tool_handlers_initialized = true;
        Ok(())
    }
}

/// the `tools/list` handler
fn list_tools(registry: &Registry<'_>) -> JsonValue {
    let mut tools = Vec::new();
    for (name, tool) in registry.tools.entries() {
        let input_schema = match &tool.input_schema {
            Some(shape) => to_json_schema(shape),
            None => object(vec![
                ("type", text("object")),
                ("properties", JsonValue::Object(JsObject::new())),
            ]),
        };
        let mut entries = vec![("name", text(name))];
        if let Some(description) = &tool.description {
            entries.push(("description", text(description)));
        }
        entries.push(("inputSchema", input_schema));
        entries.push((
            "execution",
            object(vec![("taskSupport", text("forbidden"))]),
        ));
        tools.push(object(entries));
    }
    object(vec![("tools", JsonValue::Array(tools))])
}

/// the `tools/call` handler
fn call_tool<'h>(
    registry: &Rc<RefCell<Registry<'h>>>,
    request: &JsonValue,
    ticket: Ticket,
) -> HandlerOutcome {
    let null = JsonValue::Null;
    let params = request.get("params");
    let params = params.as_deref().unwrap_or(&null);
    let name = match params.get("name").as_deref() {
        Some(JsonValue::String(name)) => name.clone(),
        _ => String::new(),
    };
    let arguments = params.get("arguments").map(|v| v.into_owned());
    let (result, ticks, log) = match run_tool(registry, &name, arguments.as_ref()) {
        Ok(ToolRun::Done(done)) => done,
        Ok(ToolRun::Await { call, then }) => {
            let mut registry = registry.borrow_mut();
            registry.inflight.push((ticket, then));
            registry.host_calls.push((ticket, call));
            return HandlerOutcome {
                reply: Reply::ToolLater(ticket),
                log: None,
                ticks: None,
            };
        }
        // `error instanceof Error ? error.message : String(error)`
        Err((message, ticks)) => (create_tool_error(&message), ticks, None),
    };
    HandlerOutcome {
        reply: Reply::Done(Ok(result)),
        log,
        ticks: Some(ticks),
    }
}

/// how far the `try` of the `tools/call` handler got
enum ToolRun<'h> {
    Done((JsonValue, u32, Option<String>)),
    Await {
        call: HostCall,
        then: Continuation<'h>,
    },
}

/// the body of the `try` of the `tools/call` handler; `Err` is the message
/// of what it threw
fn run_tool<'h>(
    registry: &Rc<RefCell<Registry<'h>>>,
    name: &str,
    arguments: Option<&JsonValue>,
) -> Result<ToolRun<'h>, (String, u32)> {
    let (tool_callback, input_schema, max_elements) = {
        let registry = registry.borrow();
        match registry.tools.get(name) {
            Some(tool) => (
                Rc::clone(&tool.callback),
                tool.input_schema.clone(),
                registry.max_tool_input_elements,
            ),
            // a plain object answers `constructor`, `toString`, ... too: a
            // function with no `enabled`
            None if inherited_string(name).is_some() => {
                return Err((
                    McpError::new(
                        error_code::INVALID_PARAMS,
                        &format!("Tool {name} disabled"),
                        None,
                    )
                    .message,
                    TICKS_CALL_NOT_FOUND,
                ));
            }
            None => {
                return Err((
                    McpError::new(
                        error_code::INVALID_PARAMS,
                        &format!("Tool {name} not found"),
                        None,
                    )
                    .message,
                    TICKS_CALL_NOT_FOUND,
                ));
            }
        }
    };
    // `validateToolInput`
    if let (Some(max), Some(arguments)) = (max_elements, arguments)
        && tool_input_element_count(arguments, max) > max
    {
        return Err((
            McpError::new(
                error_code::INVALID_PARAMS,
                &format!(
                    "Invalid arguments for tool {name}: arguments contain more than the maximum of {} elements",
                    jscompat::number_to_string(max)
                ),
                None,
            )
            .message,
            TICKS_CALL_INVALID,
        ));
    }
    let args = match &input_schema {
        None => None,
        Some(shape) => {
            let empty = JsonValue::Object(JsObject::new());
            match safe_parse(shape, arguments.unwrap_or(&empty)) {
                Ok(parsed) => Some(parsed),
                Err(issues) => {
                    return Err((
                        McpError::new(
                            error_code::INVALID_PARAMS,
                            &format!(
                                "Input validation error: Invalid arguments for tool {name}: {}",
                                parse_error_message(&issues)
                            ),
                            None,
                        )
                        .message,
                        TICKS_CALL_INVALID,
                    ));
                }
            }
        }
    };
    let has_schema = input_schema.is_some();
    // `executeToolHandler`
    let answer = (tool_callback.borrow_mut())(args.as_ref());
    match answer {
        CallStep::Done(returned) => {
            let ticks = match (has_schema, returned.rejected) {
                (true, false) => TICKS_CALL_SCHEMA,
                (true, true) => TICKS_CALL_SCHEMA_REJECTED,
                (false, false) => TICKS_CALL_PLAIN,
                (false, true) => TICKS_CALL_PLAIN_REJECTED,
            };
            Ok(ToolRun::Done((returned.result, ticks, returned.log)))
        }
        CallStep::Await { call, then } => Ok(ToolRun::Await { call, then }),
    }
}

impl SessionServer for McpServer<'_> {
    fn connect(&mut self) -> Result<(), String> {
        self.server.connect()
    }

    fn on_message(&mut self, message: &JsonValue, extra: &MessageExtra) -> Vec<Outgoing> {
        self.server.on_message(message, extra)
    }

    fn on_close(&mut self) {
        self.server.on_close();
    }

    fn settle(&mut self, ticket: Ticket, result: Result<JsonValue, HandlerError>) -> Vec<Outgoing> {
        self.server.settle(ticket, result)
    }

    fn take_aborted(&mut self) -> Vec<Aborted> {
        self.server.take_aborted()
    }

    fn take_host_calls(&mut self) -> Vec<(Ticket, HostCall)> {
        std::mem::take(&mut self.registry.borrow_mut().host_calls)
    }

    fn take_logs(&mut self) -> Vec<String> {
        std::mem::take(&mut self.registry.borrow_mut().logs)
    }

    /// the promise of the tool callback settles after its awaited call did:
    /// the rest runs, and at the end the response is written as for any
    /// request that answered later (nothing when its request was aborted)
    fn resume_tool(&mut self, ticket: Ticket, settled: Settled) -> Vec<Outgoing> {
        let continuation = {
            let mut registry = self.registry.borrow_mut();
            let Some(at) = registry.inflight.iter().position(|(t, _)| *t == ticket) else {
                return Vec::new();
            };
            registry.inflight.remove(at).1
        };
        match continuation(settled) {
            CallStep::Done(returned) => {
                // the wrapper logs when the awaited promise settles, whatever
                // became of the request
                if let Some(line) = returned.log {
                    self.registry.borrow_mut().logs.push(line);
                }
                self.server.settle(ticket, Ok(returned.result))
            }
            CallStep::Await { call, then } => {
                let mut registry = self.registry.borrow_mut();
                registry.inflight.push((ticket, then));
                registry.host_calls.push((ticket, call));
                Vec::new()
            }
        }
    }

    fn has_pending_tools(&self) -> bool {
        !self.registry.borrow().inflight.is_empty()
    }
}
