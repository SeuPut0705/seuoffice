//! `apps/shell/src/main/mcp/mcp-server.ts`: the local MCP server of SeuOffice.
//! Speaks the Streamable HTTP transport (`/mcp`) and the legacy SSE transport
//! (`/sse` + `/messages`) on loopback, with the host, origin and token guards,
//! the body limit and the tool wrapper that logs and turns a thrown error into
//! `isError`.
//!
//! The HTTP listener, the sockets, the response streams and the timers stay
//! with the caller; the service is a state machine over them, driven the way
//! `shell::control_server` is driven:
//!
//! - `start(port)` and `stop()` return their commands; `on_listening`,
//!   `on_listen_error` and `on_listener_closed` answer `Listen` and
//!   `CloseListener`; a `start` or a `stop` ends with `StartSettled` or
//!   `StopSettled`.
//! - a connection is `on_connection` and `on_socket_closed`; a request is
//!   `on_request(res, head, body)`, the body as the socket delivered it; a
//!   client that goes away is `on_response_closed(res)` (and a response that
//!   errors `on_response_error(res)`).
//! - a timer started by `SetInterval` or `SetTimeout` is `on_timer(timer)`.
//!
//! Every method returns the [`Command`]s the code issued, in order: the
//! response heads, events and ends, the timers, the sockets, the listener,
//! and the lines of the logger. `crypto.randomUUID()` and `Date.now()` are
//! asked of the [`McpHost`].
//!
//! A tool is a [`ToolHandler`]: a step function in the order of the TypeScript.
//! Each renderer-bound `await` is a [`ToolStep::Await`]: the service issues
//! `Command::ToolCall { session_id, ticket, call }` and the host answers with
//! [`McpServerService::resume_tool`], which runs the rest of the tool. A tool
//! runs to its end even when its request was cancelled or its session closed
//! (the SDK listens to no signal for `McpServer` tools); only the response is
//! not written then. A tool that has no `inputSchema` is called with `{}`
//! where the SDK hands its callback the request's `extra` object.

use std::cell::RefCell;
use std::rc::Rc;

use jscompat::{
    JsMap, JsObject, JsonValue, json_parse, json_stringify, json_stringify_pretty, number_to_string,
};
use url::Url;

use crate::packages::i18n::{OLD_MCP_TOOL_NAMES, PRODUCT_NAME};
use crate::packages::mcp_sdk::server::{
    Aborted, CallStep, Command, HandlerError, Io, McpServer, McpServerOptions, MessageExtra,
    Outgoing, ResponseId, SdkIo, ServerOptions, SessionServer, SocketId, StartError, StartId,
    StopId, Ticket, TimerId, ToolCallback, ToolConfig, ToolReturn,
};
use crate::packages::mcp_sdk::sse_server::SseServerTransport;
use crate::packages::mcp_sdk::streamable_http_server::{
    HttpRequest, StreamableHttpServerTransport, StreamableOptions,
};
use crate::packages::zod::ZodShape;

pub use crate::packages::mcp_sdk::server::{
    ListenerId, SdkHost as McpHost, SessionServer as McpSessionServer,
};

/// what a tool handler asks the host to do and wait for: the TS interface
/// (`"DocsControl"`, `"SlidesControl"`, `"SheetsControl"`, `"OpenDocumentsControl"`,
/// `"DiagramControl"`, `"FamilyDriver"`, `"TargetResolver"`, `"AgentSkillToolHooks"`, ...),
/// its method as the TS names it, and the arguments in TS order as JSON
#[derive(Debug, Clone, PartialEq)]
pub struct HostCall {
    pub control: &'static str,
    pub method: &'static str,
    pub args: Vec<JsonValue>,
}

/// how the awaited call settled: its value (None = undefined) or the message it threw
pub type Settled = Result<Option<JsonValue>, String>;

pub enum ToolStep<'h> {
    Done(Settled),
    Await {
        call: HostCall,
        then: Box<dyn FnOnce(Settled) -> ToolStep<'h> + 'h>,
    },
}

/// a tool handler: the parsed arguments (`args ?? {}`) in, the steps of the tool out
pub type ToolHandler<'h> = Box<dyn FnMut(JsonValue) -> ToolStep<'h> + 'h>;

/// `McpToolDefinition`
pub struct McpToolDefinition<'h> {
    pub name: String,
    pub description: String,
    pub input_schema: Option<ZodShape>,
    pub handler: ToolHandler<'h>,
}

pub const DEFAULT_MCP_PORT: f64 = 3093.0;
const LISTEN_RETRY_DELAY_MS: f64 = 1500.0;
const MAX_BODY_BYTES: f64 = 32.0 * 1024.0 * 1024.0;
const HEARTBEAT_MS: f64 = 15000.0;

/// `McpServerOptions`; the logger is the `Log` commands
pub struct McpServerServiceOptions<'h> {
    pub port: f64,
    /// fixed tool set shared by every client session
    pub tools: Option<Vec<McpToolDefinition<'h>>>,
    /// a fresh tool set per client session
    pub tools_factory: Option<Box<dyn FnMut() -> Vec<McpToolDefinition<'h>> + 'h>>,
    /// the whole MCP server per client session; takes precedence over the tools
    pub server_factory: Option<Box<dyn FnMut() -> Box<dyn SessionServer + 'h> + 'h>>,
    pub version: Option<String>,
    pub max_listen_attempts: Option<f64>,
    pub listen_retry_delay_ms: Option<f64>,
    pub token: Option<String>,
}

/// a tool the sessions share
struct SharedTool<'h> {
    name: String,
    description: String,
    input_schema: Option<Rc<ZodShape>>,
    handler: Rc<RefCell<ToolHandler<'h>>>,
}

impl Clone for SharedTool<'_> {
    fn clone(&self) -> Self {
        SharedTool {
            name: self.name.clone(),
            description: self.description.clone(),
            input_schema: self.input_schema.clone(),
            handler: Rc::clone(&self.handler),
        }
    }
}

fn shared(tools: Vec<McpToolDefinition<'_>>) -> Vec<SharedTool<'_>> {
    tools
        .into_iter()
        .map(|tool| SharedTool {
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema.map(Rc::new),
            handler: Rc::new(RefCell::new(tool.handler)),
        })
        .collect()
}

/// a session whose server could not be made: nothing answers
struct NullServer;

impl SessionServer for NullServer {
    fn connect(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn on_message(&mut self, _: &JsonValue, _: &MessageExtra) -> Vec<Outgoing> {
        Vec::new()
    }
    fn on_close(&mut self) {}
}

/// `answeringOldToolNames(server, renamed)`: a call by an old tool name runs
/// the tool under its new name
struct AnsweringOldToolNames<'h> {
    inner: Box<dyn SessionServer + 'h>,
    renamed: Vec<(String, String)>,
}

impl SessionServer for AnsweringOldToolNames<'_> {
    fn connect(&mut self) -> Result<(), String> {
        self.inner.connect()
    }

    fn on_message(&mut self, message: &JsonValue, extra: &MessageExtra) -> Vec<Outgoing> {
        let is_call = matches!(message.get("method").as_deref(), Some(JsonValue::String(m)) if m == "tools/call");
        let params = if is_call {
            message.get("params").map(|v| v.into_owned())
        } else {
            None
        };
        let now = params
            .as_ref()
            .and_then(|params| match params.get("name").as_deref() {
                Some(JsonValue::String(name)) => self
                    .renamed
                    .iter()
                    .find(|(old, _)| old == name)
                    .map(|(_, now)| now.clone()),
                _ => None,
            });
        match (now, message, params) {
            (Some(now), JsonValue::Object(entries), Some(JsonValue::Object(params))) => {
                // `{ ...message, params: { ...params, name: now } }`
                let mut new_params = params.clone();
                new_params.set("name", JsonValue::String(now));
                let mut renamed = entries.clone();
                renamed.set("params", JsonValue::Object(new_params));
                self.inner.on_message(&JsonValue::Object(renamed), extra)
            }
            _ => self.inner.on_message(message, extra),
        }
    }

    fn on_close(&mut self) {
        self.inner.on_close();
    }

    fn settle(&mut self, ticket: Ticket, result: Result<JsonValue, HandlerError>) -> Vec<Outgoing> {
        self.inner.settle(ticket, result)
    }

    fn take_aborted(&mut self) -> Vec<Aborted> {
        self.inner.take_aborted()
    }

    fn take_host_calls(&mut self) -> Vec<(Ticket, HostCall)> {
        self.inner.take_host_calls()
    }

    fn take_logs(&mut self) -> Vec<String> {
        self.inner.take_logs()
    }

    fn resume_tool(&mut self, ticket: Ticket, settled: Settled) -> Vec<Outgoing> {
        self.inner.resume_tool(ticket, settled)
    }

    fn has_pending_tools(&self) -> bool {
        self.inner.has_pending_tools()
    }
}

struct StreamableSession<'h> {
    transport: StreamableHttpServerTransport,
    server: Box<dyn SessionServer + 'h>,
}

struct LegacySession<'h> {
    transport: SseServerTransport,
    server: Box<dyn SessionServer + 'h>,
    res: ResponseId,
}

/// the heartbeat of one SSE response
struct Heartbeat {
    timer: TimerId,
    res: ResponseId,
    /// `res.writableEnded`
    ended: bool,
}

enum Phase {
    Listening(ListenerId),
    Waiting(TimerId),
}

/// one call of `start` under way
struct StartOp {
    id: StartId,
    generation: u32,
    attempt: f64,
    phase: Phase,
}

/// `stringifyResult(result)`: `None` is `undefined`
fn stringify_result(result: Option<&JsonValue>) -> Option<String> {
    match result {
        Some(JsonValue::String(text)) => Some(text.clone()),
        Some(value) => Some(json_stringify_pretty(value, 2)),
        None => None,
    }
}

fn object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut out = JsObject::new();
    for (key, value) in entries {
        out.set(key, value);
    }
    JsonValue::Object(out)
}

/// The callback `createSessionServer` registers for a tool: runs the tool,
/// logs when its promise settles, and turns what it threw into an `isError`
/// result.
fn tool_callback<'h>(
    io: Io,
    name: String,
    handler: Rc<RefCell<ToolHandler<'h>>>,
) -> ToolCallback<'h> {
    Rc::new(RefCell::new(move |args: Option<&JsonValue>| {
        let started = io.now_ms();
        let args = match args {
            Some(args) => args.clone(),
            None => JsonValue::Object(JsObject::new()),
        };
        let step = (handler.borrow_mut())(args);
        wrapped(Rc::clone(&io), name.clone(), started, step)
    }))
}

/// the wrapper around `await tool.handler(args ?? {})`, from one step on
fn wrapped<'h>(io: Io, name: String, started: f64, step: ToolStep<'h>) -> CallStep<'h> {
    match step {
        ToolStep::Await { call, then } => CallStep::Await {
            call,
            then: Box::new(move |settled| {
                let next = then(settled);
                wrapped(io, name, started, next)
            }),
        },
        ToolStep::Done(outcome) => {
            let elapsed = number_to_string(io.now_ms() - started);
            CallStep::Done(match outcome {
                Ok(result) => {
                    let line = format!("[mcp] tool {name} ok ({elapsed}ms)");
                    let mut block = vec![("type", JsonValue::String("text".into()))];
                    if let Some(text) = stringify_result(result.as_ref()) {
                        block.push(("text", JsonValue::String(text)));
                    }
                    ToolReturn {
                        result: object(vec![("content", JsonValue::Array(vec![object(block)]))]),
                        log: Some(line),
                        rejected: false,
                    }
                }
                Err(message) => {
                    let line = format!("[mcp] tool {name} error ({elapsed}ms): {message}");
                    ToolReturn {
                        result: object(vec![
                            (
                                "content",
                                JsonValue::Array(vec![object(vec![
                                    ("type", JsonValue::String("text".into())),
                                    ("text", JsonValue::String(message)),
                                ])]),
                            ),
                            ("isError", JsonValue::Bool(true)),
                        ]),
                        log: Some(line),
                        rejected: true,
                    }
                }
            })
        }
    }
}

/// `headerValue(req.headers[name])` of a header Node keeps as one string
fn header_value<'a>(req: &'a HttpRequest, name: &str) -> Option<&'a str> {
    req.header(name)
}

/// `isInitializeRequest(body)` of the shell: the method says so
fn is_initialize_request_by_method(body: Option<&JsonValue>) -> bool {
    let named = |message: &JsonValue| matches!(message.get("method").as_deref(), Some(JsonValue::String(m)) if m == "initialize");
    match body {
        Some(JsonValue::Array(items)) => items.iter().any(named),
        Some(other) => named(other),
        None => false,
    }
}

/// `new URL(text, base)` as the service uses it
fn parse_url(text: &str, base: &str) -> Result<Url, ()> {
    let base = Url::parse(base).map_err(|_| ())?;
    Url::options()
        .base_url(Some(&base))
        .parse(text)
        .map_err(|_| ())
}

/// what a session's server left for the caller: the awaits its tools started
/// and the signals that fired, as commands
fn drain_server(io: &Io, session_id: &str, server: &mut dyn SessionServer) {
    for line in server.take_logs() {
        io.log(line);
    }
    for (ticket, call) in server.take_host_calls() {
        io.push(Command::ToolCall {
            session_id: session_id.to_owned(),
            ticket,
            call,
        });
    }
    for aborted in server.take_aborted() {
        io.push(Command::Aborted(aborted));
    }
}

/// `timingSafeEqual` of two buffers of one length
fn timing_safe_equal(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `McpServerService`
pub struct McpServerService<'h> {
    io: Io,
    tools: Vec<SharedTool<'h>>,
    tools_factory: Option<Box<dyn FnMut() -> Vec<McpToolDefinition<'h>> + 'h>>,
    server_factory: Option<Box<dyn FnMut() -> Box<dyn SessionServer + 'h> + 'h>>,
    version: String,
    max_listen_attempts: f64,
    listen_retry_delay_ms: f64,
    token: Option<String>,
    http_server: Option<ListenerId>,
    port: f64,
    running: bool,
    streamable: JsMap<StreamableSession<'h>>,
    legacy: JsMap<LegacySession<'h>>,
    heartbeats: Vec<Heartbeat>,
    sockets: Vec<SocketId>,
    /// bumps on stop so an in-flight start cannot bind after cancellation
    lifecycle_generation: u32,
    starts: Vec<StartOp>,
    /// every `http.Server` made, with whether its promise settled
    listeners: Vec<(ListenerId, bool)>,
    pending_stops: Vec<(ListenerId, StopId)>,
    /// servers of sessions that ended while a tool of theirs still runs
    orphans: Vec<(String, Box<dyn SessionServer + 'h>)>,
    next_start: u32,
    next_stop: u32,
    next_listener: u32,
}

impl<'h> McpServerService<'h> {
    pub fn new(options: McpServerServiceOptions<'h>, host: Box<dyn McpHost>) -> Self {
        McpServerService {
            io: SdkIo::new(host),
            tools: shared(options.tools.unwrap_or_default()),
            tools_factory: options.tools_factory,
            server_factory: options.server_factory,
            version: options.version.unwrap_or_else(|| "0.1.0".to_owned()),
            max_listen_attempts: options.max_listen_attempts.unwrap_or(5.0),
            listen_retry_delay_ms: options
                .listen_retry_delay_ms
                .unwrap_or(LISTEN_RETRY_DELAY_MS),
            token: options.token,
            http_server: None,
            port: options.port,
            running: false,
            streamable: JsMap::new(),
            legacy: JsMap::new(),
            heartbeats: Vec::new(),
            sockets: Vec::new(),
            lifecycle_generation: 0,
            starts: Vec::new(),
            listeners: Vec::new(),
            pending_stops: Vec::new(),
            orphans: Vec::new(),
            next_start: 1,
            next_stop: 1,
            next_listener: 1,
        }
    }

    /// `isRunning()`
    pub fn is_running(&self) -> bool {
        self.running
    }

    /// `getPort()`
    pub fn get_port(&self) -> f64 {
        self.port
    }

    /// `getUrl()`
    pub fn get_url(&self) -> String {
        format!("http://127.0.0.1:{}", number_to_string(self.port))
    }

    // ---- tool registration -------------------------------------------------

    /// `createSessionServer()`: `Err` is the message of what it throws
    fn create_session_server(&mut self) -> Result<Box<dyn SessionServer + 'h>, String> {
        if let Some(factory) = self.server_factory.as_mut() {
            return Ok(factory());
        }
        let mut server = McpServer::new(
            object(vec![
                ("name", JsonValue::String(PRODUCT_NAME.into())),
                ("version", JsonValue::String(self.version.clone())),
            ]),
            McpServerOptions {
                server: ServerOptions::default(),
                max_tool_input_elements: None,
            },
        );
        // a factory gives each connected client its own tool instances
        let tools: Vec<SharedTool<'h>> = match self.tools_factory.as_mut() {
            Some(factory) => shared(factory()),
            None => self.tools.clone(),
        };
        for tool in &tools {
            server.register_tool(
                &tool.name,
                ToolConfig {
                    description: Some(tool.description.clone()),
                    input_schema: tool.input_schema.clone(),
                },
                tool_callback(
                    Rc::clone(&self.io),
                    tool.name.clone(),
                    Rc::clone(&tool.handler),
                ),
            )?;
        }
        let renamed: Vec<(String, String)> = OLD_MCP_TOOL_NAMES
            .iter()
            .filter(|(old, now)| {
                tools.iter().any(|t| t.name == *now) && !tools.iter().any(|t| t.name == *old)
            })
            .map(|(old, now)| ((*old).to_owned(), (*now).to_owned()))
            .collect();
        if renamed.is_empty() {
            Ok(Box::new(server))
        } else {
            Ok(Box::new(AnsweringOldToolNames {
                inner: Box::new(server),
                renamed,
            }))
        }
    }

    // ---- request handling --------------------------------------------------

    fn json(&self, res: ResponseId, status: u16, body: &JsonValue) {
        self.io.push(Command::Respond {
            res,
            status,
            headers: vec![("content-type".into(), "application/json".into())],
        });
        self.io.push(Command::End {
            res,
            chunk: Some(json_stringify(body)),
        });
    }

    /// `handleRequest(req, res)`: one request, its body as the socket
    /// delivered it
    pub fn on_request(&mut self, res: ResponseId, req: &HttpRequest, body: &[u8]) -> Vec<Command> {
        let from = self.io.len();
        if let Err(error) = self.route(res, req, body) {
            self.io
                .log(format!("[mcp] unhandled request error: {error}"));
            let sent = self.io.since(from).into_iter().any(|command| {
                matches!(
                    command,
                    Command::Respond { res: r, .. }
                        | Command::Write { res: r, .. }
                        | Command::End { res: r, .. } if r == res
                )
            });
            if !sent {
                self.json(
                    res,
                    500,
                    &object(vec![("error", JsonValue::String("internal error".into()))]),
                );
            }
        }
        self.io.take()
    }

    fn route(&mut self, res: ResponseId, req: &HttpRequest, body: &[u8]) -> Result<(), String> {
        let url = parse_url(
            &req.url,
            &format!("http://127.0.0.1:{}", number_to_string(self.port)),
        )
        .map_err(|()| "TypeError: Invalid URL".to_owned())?;
        // DNS-rebinding defense: only loopback host headers are accepted
        if !self.check_host(res, req) || !self.check_origin(res, req) {
            return Ok(());
        }
        if !self.check_token(res, req) {
            return Ok(());
        }
        let path = url.path();
        if path == "/health" && req.method == "GET" {
            self.json(
                res,
                200,
                &object(vec![
                    ("status", JsonValue::String("ok".into())),
                    ("server", JsonValue::String(PRODUCT_NAME.into())),
                    (
                        "transport",
                        JsonValue::String("StreamableHTTP + SSE".into()),
                    ),
                    ("port", JsonValue::Number(self.port)),
                ]),
            );
            return Ok(());
        }
        if path == "/mcp" {
            return self.handle_streamable(res, req, body);
        }
        if path == "/sse" && req.method == "GET" {
            return self.handle_legacy_sse(res);
        }
        if path == "/messages" && req.method == "POST" {
            return self.handle_legacy_message(res, req, body, &url);
        }
        self.json(
            res,
            404,
            &object(vec![("error", JsonValue::String("not found".into()))]),
        );
        Ok(())
    }

    fn handle_streamable(
        &mut self,
        res: ResponseId,
        req: &HttpRequest,
        body: &[u8],
    ) -> Result<(), String> {
        let method = req.method.as_str();
        if method != "POST" && method != "GET" && method != "DELETE" {
            self.io.push(Command::Respond {
                res,
                status: 405,
                headers: vec![("allow".into(), "GET, POST, DELETE".into())],
            });
            self.io.push(Command::End { res, chunk: None });
            return Ok(());
        }
        let session_id: Option<String> = header_value(req, "mcp-session-id").map(str::to_owned);

        // GET/DELETE must belong to a live session
        if method == "GET" || method == "DELETE" {
            let live = session_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .filter(|id| self.streamable.has(id))
                .map(str::to_owned);
            let Some(live) = live else {
                let given = session_id.as_deref().is_some_and(|id| !id.is_empty());
                self.json(
                    res,
                    if given { 404 } else { 400 },
                    &object(vec![
                        ("jsonrpc", JsonValue::String("2.0".into())),
                        (
                            "error",
                            object(vec![
                                (
                                    "code",
                                    JsonValue::Number(if given { -32001.0 } else { -32000.0 }),
                                ),
                                (
                                    "message",
                                    JsonValue::String(
                                        if given {
                                            "Session not found"
                                        } else {
                                            "Mcp-Session-Id header is required"
                                        }
                                        .into(),
                                    ),
                                ),
                            ]),
                        ),
                        ("id", JsonValue::Null),
                    ]),
                );
                return Ok(());
            };
            self.deliver_streamable(&live, res, req, None);
            return Ok(());
        }

        // POST
        let Some(parsed) = self.read_body_or_reject(res, body) else {
            return Ok(());
        };
        let existing = session_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .filter(|id| self.streamable.has(id))
            .map(str::to_owned);
        if session_id.as_deref().is_some_and(|id| !id.is_empty()) && existing.is_none() {
            let id = session_id.as_deref().unwrap_or("");
            self.json(
                res,
                404,
                &object(vec![
                    ("jsonrpc", JsonValue::String("2.0".into())),
                    (
                        "error",
                        object(vec![
                            ("code", JsonValue::Number(-32001.0)),
                            (
                                "message",
                                JsonValue::String(format!("Session not found: {id}")),
                            ),
                        ]),
                    ),
                    ("id", JsonValue::Null),
                ]),
            );
            return Ok(());
        }
        if existing.is_none() && !is_initialize_request_by_method(parsed.as_ref()) {
            self.json(
                res,
                400,
                &object(vec![
                    ("jsonrpc", JsonValue::String("2.0".into())),
                    (
                        "error",
                        object(vec![
                            ("code", JsonValue::Number(-32000.0)),
                            (
                                "message",
                                JsonValue::String(
                                    "Initialize the session before sending MCP messages".into(),
                                ),
                            ),
                        ]),
                    ),
                    ("id", JsonValue::Null),
                ]),
            );
            return Ok(());
        }

        let key = match existing {
            Some(key) => key,
            None => {
                // `sessionId ?? randomUUID()`: an empty header is kept
                let new_session_id = match session_id {
                    Some(id) => id,
                    None => self.io.random_uuid(),
                };
                let log_io = Rc::clone(&self.io);
                let created = StreamableHttpServerTransport::new(
                    Rc::clone(&self.io),
                    StreamableOptions {
                        session_id: new_session_id.clone(),
                        on_session_initialized: Some(Box::new(move |sid| {
                            log_io.log(format!("[mcp] session initialized: {sid}"));
                        })),
                    },
                );
                self.streamable.set(
                    new_session_id.clone(),
                    StreamableSession {
                        transport: created,
                        server: Box::new(NullServer),
                    },
                );
                let mut server = self
                    .create_session_server()
                    .map_err(|message| format!("Error: {message}"))?;
                let connected = server.connect().and_then(|()| {
                    self.streamable
                        .get_mut(&new_session_id)
                        .map(|session| session.transport.start())
                        .unwrap_or(Ok(()))
                });
                if let Err(message) = connected {
                    self.streamable.delete(&new_session_id);
                    return Err(format!("Error: {message}"));
                }
                if let Some(session) = self.streamable.get_mut(&new_session_id) {
                    session.server = server;
                }
                new_session_id
            }
        };
        self.deliver_streamable(&key, res, req, parsed.as_ref());
        Ok(())
    }

    /// `await transport.handleRequest(req, res, body)`; a transport that
    /// closed ends its session
    fn deliver_streamable(
        &mut self,
        key: &str,
        res: ResponseId,
        req: &HttpRequest,
        parsed_body: Option<&JsonValue>,
    ) {
        let Some(session) = self.streamable.get_mut(key) else {
            return;
        };
        session
            .transport
            .handle_request(res, req, parsed_body, &[], &mut *session.server);
        if session.transport.take_closed() {
            session.server.on_close();
            drain_server(&self.io, key, &mut *session.server);
            self.retire_streamable(key);
        } else {
            drain_server(&self.io, key, &mut *session.server);
        }
    }

    /// a streamable session ended: it is forgotten, but its tools run on
    fn retire_streamable(&mut self, key: &str) {
        if let Some(session) = self.streamable.delete(key)
            && session.server.has_pending_tools()
        {
            self.orphans.push((key.to_owned(), session.server));
        }
    }

    /// a legacy session ended: it is forgotten, but its tools run on
    fn retire_legacy(&mut self, key: &str) {
        if let Some(session) = self.legacy.delete(key)
            && session.server.has_pending_tools()
        {
            self.orphans.push((key.to_owned(), session.server));
        }
    }

    fn handle_legacy_sse(&mut self, res: ResponseId) -> Result<(), String> {
        let pre_set: Vec<(String, String)> = vec![
            ("content-type".into(), "text/event-stream".into()),
            ("cache-control".into(), "no-cache".into()),
            ("connection".into(), "keep-alive".into()),
            ("x-accel-buffering".into(), "no".into()),
        ];
        let mut transport = SseServerTransport::new(Rc::clone(&self.io), "/messages", res);
        let session_id = transport.session_id().to_owned();
        let timer = self.io.new_timer();
        self.io.push(Command::SetInterval {
            timer,
            ms: HEARTBEAT_MS,
        });
        self.heartbeats.push(Heartbeat {
            timer,
            res,
            ended: false,
        });
        let mut server = self
            .create_session_server()
            .map_err(|message| format!("Error: {message}"))?;
        let connected = server.connect().and_then(|()| transport.start(pre_set));
        match connected {
            Ok(()) => {
                self.legacy.set(
                    session_id,
                    LegacySession {
                        transport,
                        server,
                        res,
                    },
                );
            }
            Err(message) => {
                self.cleanup_legacy(res);
                self.io
                    .log(format!("[mcp] legacy SSE connect failed: Error: {message}"));
                self.io.push(Command::Respond {
                    res,
                    status: 500,
                    headers: Vec::new(),
                });
                self.io.push(Command::End { res, chunk: None });
            }
        }
        Ok(())
    }

    /// `cleanup()` of a legacy SSE response: the heartbeat goes, the session goes
    fn cleanup_legacy(&mut self, res: ResponseId) {
        if let Some(at) = self.heartbeats.iter().position(|h| h.res == res) {
            let heartbeat = self.heartbeats.remove(at);
            self.io.push(Command::ClearTimer {
                timer: heartbeat.timer,
            });
        }
        let ids: Vec<String> = self
            .legacy
            .iter()
            .filter(|(_, session)| session.res == res)
            .map(|(id, _)| id.to_owned())
            .collect();
        for id in ids {
            // the transport's own `res.on('close')` runs with the shell's
            if let Some(session) = self.legacy.get_mut(&id) {
                session.transport.on_response_closed();
                session.server.on_close();
                drain_server(&self.io, &id, &mut *session.server);
            }
            self.retire_legacy(&id);
        }
    }

    fn handle_legacy_message(
        &mut self,
        res: ResponseId,
        req: &HttpRequest,
        body: &[u8],
        url: &Url,
    ) -> Result<(), String> {
        let session_id = url
            .query_pairs()
            .find(|(key, _)| key == "sessionId")
            .map(|(_, value)| value.into_owned())
            // `if (!sessionId)`: an empty one is missing too
            .filter(|id| !id.is_empty());
        let Some(session_id) = session_id else {
            self.json(
                res,
                400,
                &object(vec![(
                    "error",
                    JsonValue::String("Missing sessionId parameter".into()),
                )]),
            );
            return Ok(());
        };
        if !self.legacy.has(&session_id) {
            self.json(
                res,
                400,
                &object(vec![(
                    "error",
                    JsonValue::String(format!("No transport found for sessionId {session_id}")),
                )]),
            );
            return Ok(());
        }
        let Some(parsed) = self.read_body_or_reject(res, body) else {
            return Ok(());
        };
        let Some(session) = self.legacy.get_mut(&session_id) else {
            return Ok(());
        };
        let outcome =
            session
                .transport
                .handle_post_message(res, req, parsed.as_ref(), &mut *session.server);
        if session.transport.take_closed() {
            session.server.on_close();
        }
        drain_server(&self.io, &session_id, &mut *session.server);
        outcome.map_err(|message| format!("Error: {message}"))
    }

    /// `readBodyOrReject(req, res)`: the parsed body (`None` inside is
    /// `undefined`), or `None` after answering with the parse error
    fn read_body_or_reject(&mut self, res: ResponseId, body: &[u8]) -> Option<Option<JsonValue>> {
        let outcome: Result<Option<JsonValue>, (bool, String)> =
            if body.len() as f64 > MAX_BODY_BYTES {
                // `reject(new Error('request body too large')); req.destroy()`
                self.io.push(Command::Destroy { res });
                Err((true, "request body too large".to_owned()))
            } else {
                let raw = String::from_utf8_lossy(body);
                if raw.is_empty() {
                    Ok(None)
                } else {
                    json_parse(&raw)
                        .map(Some)
                        .map_err(|error| (false, error.message().to_owned()))
                }
            };
        match outcome {
            Ok(parsed) => Some(parsed),
            Err((too_large, message)) => {
                self.json(
                    res,
                    if too_large { 413 } else { 400 },
                    &object(vec![
                        ("jsonrpc", JsonValue::String("2.0".into())),
                        (
                            "error",
                            object(vec![
                                ("code", JsonValue::Number(-32700.0)),
                                (
                                    "message",
                                    JsonValue::String(format!("Parse error: {message}")),
                                ),
                            ]),
                        ),
                        ("id", JsonValue::Null),
                    ]),
                );
                None
            }
        }
    }

    // ---- guards ------------------------------------------------------------

    fn check_host(&self, res: ResponseId, req: &HttpRequest) -> bool {
        let host = req.header("host");
        let port = number_to_string(self.port);
        if let Ok(parsed) = Url::parse(&format!("http://{}", host.unwrap_or("")))
            && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"))
            && parsed.port().map(|p| p.to_string()).unwrap_or_default() == port
        {
            return true;
        }
        self.io.log(format!(
            "[mcp] rejected invalid Host header: {}",
            host.unwrap_or("(missing)")
        ));
        self.json(
            res,
            403,
            &object(vec![("error", JsonValue::String("Invalid host".into()))]),
        );
        false
    }

    fn check_token(&self, res: ResponseId, req: &HttpRequest) -> bool {
        let Some(token) = &self.token else {
            return true;
        };
        let header = header_value(req, "authorization").unwrap_or("");
        let expected = format!("Bearer {token}");
        if timing_safe_equal(header.as_bytes(), expected.as_bytes()) {
            return true;
        }
        self.io
            .log("[mcp] rejected a request without the session token");
        self.json(
            res,
            401,
            &object(vec![("error", JsonValue::String("Unauthorized".into()))]),
        );
        false
    }

    fn check_origin(&self, res: ResponseId, req: &HttpRequest) -> bool {
        let origin = req.header("origin");
        let Some(origin) = origin.filter(|o| !o.is_empty()) else {
            return true;
        };
        let port = number_to_string(self.port);
        if let Ok(parsed) = Url::parse(origin)
            && matches!(parsed.scheme(), "http" | "https")
            && matches!(parsed.host_str(), Some("127.0.0.1" | "localhost"))
            && parsed.port().map(|p| p.to_string()).unwrap_or_default() == port
        {
            return true;
        }
        self.io
            .log(format!("[mcp] rejected invalid Origin header: {origin}"));
        self.json(
            res,
            403,
            &object(vec![("error", JsonValue::String("Invalid origin".into()))]),
        );
        false
    }

    // ---- events ------------------------------------------------------------

    /// `server.on('connection', ...)`
    pub fn on_connection(&mut self, socket: SocketId) {
        self.sockets.push(socket);
    }

    /// `socket.on('close', ...)`
    pub fn on_socket_closed(&mut self, socket: SocketId) {
        self.sockets.retain(|s| *s != socket);
    }

    /// `res.on('close')`: the client went away
    pub fn on_response_closed(&mut self, res: ResponseId) -> Vec<Command> {
        self.cleanup_legacy(res);
        let keys: Vec<String> = self.streamable.keys().map(str::to_owned).collect();
        for key in keys {
            if let Some(session) = self.streamable.get_mut(&key) {
                session.transport.on_response_closed(res);
            }
        }
        self.io.take()
    }

    /// `res.on('error')`
    pub fn on_response_error(&mut self, res: ResponseId) -> Vec<Command> {
        self.cleanup_legacy(res);
        self.io.take()
    }

    /// a timer fired
    pub fn on_timer(&mut self, timer: TimerId) -> Vec<Command> {
        // the retry delay of a start
        if let Some(op) = self
            .starts
            .iter_mut()
            .find(|op| matches!(op.phase, Phase::Waiting(t) if t == timer))
        {
            op.attempt += 1.0;
            let id = op.id;
            self.begin_attempt(id);
            return self.io.take();
        }
        // the heartbeat of a legacy SSE response
        if let Some(heartbeat) = self.heartbeats.iter().find(|h| h.timer == timer) {
            if !heartbeat.ended {
                self.io.push(Command::Write {
                    res: heartbeat.res,
                    chunk: ": heartbeat\n\n".to_owned(),
                });
            }
            return self.io.take();
        }
        // the keep-alive of a streamable stream
        let keys: Vec<String> = self.streamable.keys().map(str::to_owned).collect();
        for key in keys {
            if let Some(session) = self.streamable.get_mut(&key)
                && session.transport.on_timer(timer)
            {
                break;
            }
        }
        self.io.take()
    }

    // ---- lifecycle ---------------------------------------------------------

    fn settle_start(&mut self, id: StartId, outcome: Result<(), StartError>) {
        self.starts.retain(|op| op.id != id);
        self.io.push(Command::StartSettled { start: id, outcome });
    }

    fn begin_attempt(&mut self, id: StartId) {
        let listener = ListenerId(self.next_listener);
        self.next_listener += 1;
        self.listeners.push((listener, false));
        if let Some(op) = self.starts.iter_mut().find(|op| op.id == id) {
            op.phase = Phase::Listening(listener);
        }
        self.io.push(Command::Listen {
            listener,
            port: self.port,
        });
    }

    /// `start(port = this.port)`
    pub fn start(&mut self, port: Option<f64>) -> (StartId, Vec<Command>) {
        let id = StartId(self.next_start);
        self.next_start += 1;
        if self.running {
            self.io.push(Command::StartSettled {
                start: id,
                outcome: Ok(()),
            });
            return (id, self.io.take());
        }
        if let Some(port) = port {
            self.port = port;
        }
        self.lifecycle_generation += 1;
        self.starts.push(StartOp {
            id,
            generation: self.lifecycle_generation,
            attempt: 1.0,
            phase: Phase::Waiting(TimerId(0)),
        });
        if self.max_listen_attempts < 1.0 {
            // the loop does not run and `throw lastError` throws `undefined`
            self.settle_start(
                id,
                Err(StartError {
                    text: "undefined".to_owned(),
                }),
            );
        } else {
            self.begin_attempt(id);
        }
        (id, self.io.take())
    }

    /// `server.listen(...)`'s callback: bound to `port`
    pub fn on_listening(&mut self, listener: ListenerId, port: f64) -> Vec<Command> {
        if let Some(entry) = self.listeners.iter_mut().find(|(l, _)| *l == listener) {
            entry.1 = true;
        }
        let Some(op) = self
            .starts
            .iter()
            .find(|op| matches!(op.phase, Phase::Listening(l) if l == listener))
        else {
            return self.io.take();
        };
        let (id, generation) = (op.id, op.generation);
        if generation != self.lifecycle_generation {
            self.io.push(Command::CloseListener { listener });
            self.settle_start(
                id,
                Err(StartError {
                    text: "Error: MCP server start cancelled".to_owned(),
                }),
            );
            return self.io.take();
        }
        self.http_server = Some(listener);
        // port 0 asks the system for a free port; the Host check needs the real one
        self.port = port;
        self.running = true;
        self.io.log(format!(
            "[mcp] listening on {} (streamable /mcp, legacy /sse)",
            self.get_url()
        ));
        self.settle_start(id, Ok(()));
        self.io.take()
    }

    /// the `'error'` event of a server: `code` is `error.code`, `text` is
    /// `String(error)`
    pub fn on_listen_error(
        &mut self,
        listener: ListenerId,
        code: Option<&str>,
        text: &str,
    ) -> Vec<Command> {
        let settled = self
            .listeners
            .iter()
            .find(|(l, _)| *l == listener)
            .is_some_and(|(_, settled)| *settled);
        if settled {
            self.io
                .log(format!("[mcp] server error after listen: {text}"));
            return self.io.take();
        }
        if let Some(entry) = self.listeners.iter_mut().find(|(l, _)| *l == listener) {
            entry.1 = true;
        }
        let Some(op) = self
            .starts
            .iter()
            .find(|op| matches!(op.phase, Phase::Listening(l) if l == listener))
        else {
            return self.io.take();
        };
        let (id, generation, attempt) = (op.id, op.generation, op.attempt);
        if generation != self.lifecycle_generation {
            self.settle_start(
                id,
                Err(StartError {
                    text: "Error: MCP server start cancelled".to_owned(),
                }),
            );
            return self.io.take();
        }
        if code != Some("EADDRINUSE") {
            self.settle_start(
                id,
                Err(StartError {
                    text: text.to_owned(),
                }),
            );
            return self.io.take();
        }
        self.io.log(format!(
            "[mcp] port {} in use, retry {}/{}",
            number_to_string(self.port),
            number_to_string(attempt),
            number_to_string(self.max_listen_attempts)
        ));
        if attempt < self.max_listen_attempts {
            let timer = self.io.new_timer();
            self.io.push(Command::SetTimeout {
                timer,
                ms: self.listen_retry_delay_ms,
            });
            if let Some(op) = self.starts.iter_mut().find(|op| op.id == id) {
                op.phase = Phase::Waiting(timer);
            }
        } else {
            self.settle_start(
                id,
                Err(StartError {
                    text: text.to_owned(),
                }),
            );
        }
        self.io.take()
    }

    /// `stopSync()` and `stop()`
    pub fn stop(&mut self) -> (StopId, Vec<Command>) {
        let id = StopId(self.next_stop);
        self.next_stop += 1;
        self.lifecycle_generation += 1;
        let Some(server) = self.http_server.take() else {
            self.running = false;
            self.io.push(Command::StopSettled { stop: id });
            return (id, self.io.take());
        };
        let legacy_keys: Vec<String> = self.legacy.keys().map(str::to_owned).collect();
        for key in legacy_keys {
            if let Some(session) = self.legacy.get_mut(&key) {
                session.transport.close();
                session.server.on_close();
                drain_server(&self.io, &key, &mut *session.server);
                let res = session.res;
                if let Some(heartbeat) = self.heartbeats.iter_mut().find(|h| h.res == res) {
                    heartbeat.ended = true;
                }
            }
        }
        for key in self.legacy.keys().map(str::to_owned).collect::<Vec<_>>() {
            self.retire_legacy(&key);
        }
        let keys: Vec<String> = self.streamable.keys().map(str::to_owned).collect();
        for key in keys {
            if let Some(session) = self.streamable.get_mut(&key) {
                session.transport.close();
                session.server.on_close();
                drain_server(&self.io, &key, &mut *session.server);
            }
        }
        for key in self
            .streamable
            .keys()
            .map(str::to_owned)
            .collect::<Vec<_>>()
        {
            self.retire_streamable(&key);
        }
        for socket in std::mem::take(&mut self.sockets) {
            self.io.push(Command::DestroySocket { socket });
        }
        self.running = false;
        self.io.push(Command::CloseListener { listener: server });
        self.pending_stops.push((server, id));
        (id, self.io.take())
    }

    /// the promise of a request a handler answered later settled: `session_id`
    /// and `ticket` are those the handler was given (`RequestExtra`). The
    /// response goes where the SDK writes it, the SSE stream of the POST that
    /// carried the request or the legacy SSE stream; nothing goes when the
    /// request was aborted (`Command::Aborted`) or the session is gone.
    pub fn settle(
        &mut self,
        session_id: &str,
        ticket: Ticket,
        result: Result<JsonValue, HandlerError>,
    ) -> Vec<Command> {
        if let Some(session) = self.streamable.get_mut(session_id) {
            let outgoing = session.server.settle(ticket, result);
            session.transport.send_outgoing(outgoing);
            drain_server(&self.io, session_id, &mut *session.server);
        } else if let Some(session) = self.legacy.get_mut(session_id) {
            let outgoing = session.server.settle(ticket, result);
            session.transport.send_outgoing(outgoing);
            drain_server(&self.io, session_id, &mut *session.server);
        }
        self.io.take()
    }

    /// the host call a tool awaited (`Command::ToolCall`) settled: the rest of
    /// the tool runs, and at its end the response is written where the SDK
    /// writes it (the SSE stream of the POST that carried the call, or the
    /// legacy SSE stream), with the `[mcp] tool ... ok|error` line logged.
    /// A call whose request was cancelled, or whose session ended, still runs
    /// (and logs) to its end; its response is not written.
    pub fn resume_tool(
        &mut self,
        session_id: &str,
        ticket: Ticket,
        answer: Settled,
    ) -> Vec<Command> {
        if let Some(session) = self.streamable.get_mut(session_id) {
            let outgoing = session.server.resume_tool(ticket, answer);
            session.transport.send_outgoing(outgoing);
            drain_server(&self.io, session_id, &mut *session.server);
        } else if let Some(session) = self.legacy.get_mut(session_id) {
            let outgoing = session.server.resume_tool(ticket, answer);
            session.transport.send_outgoing(outgoing);
            drain_server(&self.io, session_id, &mut *session.server);
        } else if let Some(at) = self.orphans.iter().position(|(id, _)| id == session_id) {
            let server = &mut self.orphans[at].1;
            server.resume_tool(ticket, answer);
            drain_server(&self.io, session_id, &mut **server);
            if !server.has_pending_tools() {
                self.orphans.remove(at);
            }
        }
        self.io.take()
    }

    /// `server.close(callback)`'s callback
    pub fn on_listener_closed(&mut self, listener: ListenerId) -> Vec<Command> {
        if let Some(at) = self.pending_stops.iter().position(|(l, _)| *l == listener) {
            let (_, stop) = self.pending_stops.remove(at);
            self.io.log("[mcp] stopped");
            self.io.push(Command::StopSettled { stop });
        }
        self.io.take()
    }
}
