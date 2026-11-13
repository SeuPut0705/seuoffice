//! `@modelcontextprotocol/sdk` 1.32.1 `client/index.js` and the client side
//! of `shared/protocol.js`, without promises, sockets or timers: a [`Client`]
//! is the state of one JSON-RPC session and the caller carries out what it
//! asks for through [`ClientHost`].
//!
//! # Driving a session end to end
//!
//! 1. Make the [`Client`] (`new Client(clientInfo, { capabilities: {} })`),
//!    register what the TypeScript registers on it:
//!    [`Client::set_notification_handler`] for `ToolListChangedNotificationSchema`
//!    and [`Client::set_fallback_request_handler`] for
//!    `client.fallbackRequestHandler = ...` (answered by
//!    [`ClientHost::fallback_request`]). `client.onerror` and `client.onclose`
//!    are [`ClientHost::on_error`] and [`ClientHost::on_close`].
//! 2. Pick the transport. [`ExternalTransport`] is for a caller that moves
//!    the bytes itself (a child's stdin and stdout, `local.ts`):
//!    [`ClientHost::write`] writes one message (see
//!    [`super::stdio::serialize_message`]), and what comes back goes to
//!    [`Client::on_message`] after [`super::stdio::ReadBuffer`] cut it out.
//!    `StreamableHttpTransport` and `SseTransport` do the HTTP themselves
//!    through [`net::FetchHost`] (`remote.ts`).
//! 3. `client.connect(host, op, transport, options)`. Every operation takes
//!    an `op` number of the caller's choosing and settles it, exactly once,
//!    with [`ClientHost::settle`]: `Settled::Connected` for `connect`,
//!    `Settled::Result(value)` for `list_tools` and `call_tool`, or an
//!    [`ClientError`]. The call may settle before it returns. `connect` sends
//!    `initialize`, checks the version, sends `notifications/initialized`.
//! 4. Feed the events the TypeScript has callbacks for:
//!    [`Client::on_message`], [`Client::on_transport_error`] and
//!    [`Client::on_transport_closed`] for an external transport;
//!    [`Client::on_timeout`] when a timer [`ClientHost::set_timeout`] started
//!    fires; [`Client::on_abort`] when an `AbortSignal` handed to an operation
//!    aborts (the SDK never removes its listener, so it also acts after the
//!    operation settled: call [`Client::release`] when the signal is dropped);
//!    [`Client::on_stream_chunk`], [`Client::on_stream_end`] and
//!    [`Client::on_stream_error`] for the body of a fetch the host gave as
//!    [`net::Body::Stream`].
//! 5. `client.close(host)` (`await client.close()`): the transport closes and
//!    the pending requests settle with `MCP error -32000: Connection closed`.
//!
//! What stays out: the experimental tasks API, `onprogress`, resumption
//! tokens, auth providers (`remote.ts` passes none), list-changed
//! auto-refresh and request handlers other than the fallback (the client
//! declares no capabilities). Tool output validation is Ajv in the
//! TypeScript; there is no Rust Ajv, so it is behind
//! [`ClientHost::compile_output_schema`] and [`ClientHost::validate_output`].

use std::collections::VecDeque;

use jscompat::{JsObject, JsonValue, json_stringify};

use super::stdio::StdioError;
use super::types::schema::{self, Issue};
use super::types::{
    self, LATEST_PROTOCOL_VERSION, McpError, SUPPORTED_PROTOCOL_VERSIONS, error_code,
};

/// `DEFAULT_REQUEST_TIMEOUT_MSEC`
pub const DEFAULT_REQUEST_TIMEOUT_MSEC: f64 = 60000.0;

/// What the caller names an operation with: the number given to `connect`,
/// `list_tools`, `call_tool` or `ping`, handed back to [`ClientHost::settle`].
pub type OpId = u64;

pub mod net {
    //! `shared/transport.js` and the parts of `fetch`, `Headers`, `Response`
    //! and `content-type` the transports read.

    use std::collections::BTreeMap;

    use jscompat::{JsRegex, js_regex, json_parse, slice_utf16, text_decoder_decode, trim};
    use url::Url;

    use super::{ClientError, JsonValue};

    /// `new Headers(...)`: names lowercased, equal names joined by `, `,
    /// listed in the order of the names
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct Headers {
        map: BTreeMap<String, String>,
    }

    fn http_trim(value: &str) -> &str {
        value.trim_matches(|c| matches!(c, '\t' | '\n' | '\r' | ' '))
    }

    impl Headers {
        pub fn new() -> Headers {
            Headers::default()
        }

        /// `new Headers({ name: value, ... })`
        pub fn from_pairs(pairs: &[(&str, &str)]) -> Headers {
            let mut headers = Headers::new();
            for (name, value) in pairs {
                headers.append(name, value);
            }
            headers
        }

        /// `headers.append(name, value)`
        pub fn append(&mut self, name: &str, value: &str) {
            let name = name.to_ascii_lowercase();
            let value = http_trim(value);
            match self.map.get_mut(&name) {
                Some(existing) => {
                    existing.push_str(", ");
                    existing.push_str(value);
                }
                None => {
                    self.map.insert(name, value.to_owned());
                }
            }
        }

        /// `headers.set(name, value)`
        pub fn set(&mut self, name: &str, value: &str) {
            self.map
                .insert(name.to_ascii_lowercase(), http_trim(value).to_owned());
        }

        /// `headers.get(name)`
        pub fn get(&self, name: &str) -> Option<&str> {
            self.map.get(&name.to_ascii_lowercase()).map(String::as_str)
        }

        /// `headers.has(name)`
        pub fn has(&self, name: &str) -> bool {
            self.map.contains_key(&name.to_ascii_lowercase())
        }

        /// `[...headers]`
        pub fn entries(&self) -> Vec<(String, String)> {
            self.map
                .iter()
                .map(|(name, value)| (name.clone(), value.clone()))
                .collect()
        }
    }

    /// `RequestInit.redirect`
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Redirect {
        Follow,
        Manual,
        Error,
    }

    /// the `RequestInit` fields the SDK sets (a signal is the host's business)
    #[derive(Debug, Clone, Default, PartialEq)]
    pub struct FetchInit {
        pub method: Option<String>,
        pub headers: Option<Headers>,
        pub body: Option<String>,
        pub redirect: Option<Redirect>,
    }

    /// what `fetch` rejects with
    #[derive(Debug, Clone, PartialEq)]
    pub struct FetchError {
        pub name: String,
        pub message: String,
        /// `error instanceof TypeError` (a network failure is one)
        pub is_type_error: bool,
        /// `error.cause` when it is an `Error`
        pub cause: Option<Box<FetchError>>,
    }

    impl FetchError {
        pub fn type_error(message: &str) -> FetchError {
            FetchError {
                name: "TypeError".to_owned(),
                message: message.to_owned(),
                is_type_error: true,
                cause: None,
            }
        }

        pub fn other(name: &str, message: &str) -> FetchError {
            FetchError {
                name: name.to_owned(),
                message: message.to_owned(),
                is_type_error: false,
                cause: None,
            }
        }

        /// `String(error)`
        pub fn to_js_string(&self) -> String {
            if self.message.is_empty() {
                self.name.clone()
            } else {
                format!("{}: {}", self.name, self.message)
            }
        }
    }

    /// `response.body`
    #[derive(Debug, Clone, PartialEq)]
    pub enum Body {
        /// `null`
        None,
        /// a body the host has read: nothing arrives later
        Bytes(Vec<u8>),
        /// a stream the host keeps open: its chunks reach the transport as
        /// `on_stream_chunk`, `on_stream_end` and `on_stream_error`
        Stream(u64),
    }

    /// a `Response`
    #[derive(Debug, Clone, PartialEq)]
    pub struct FetchResponse {
        pub status: u16,
        pub status_text: String,
        pub headers: Headers,
        /// `response.url`, `""` when there is none
        pub url: String,
        /// `response.redirected`
        pub redirected: bool,
        /// `response.type === 'opaqueredirect'`
        pub opaque_redirect: bool,
        pub body: Body,
    }

    impl FetchResponse {
        /// `response.ok`
        pub fn ok(&self) -> bool {
            (200..300).contains(&self.status)
        }
    }

    /// The network, as a plain call. The defaults are a host without one.
    pub trait FetchHost {
        /// `await fetch(url, init)`: the answer once the headers are in
        fn fetch(&mut self, _url: &str, _init: &FetchInit) -> Result<FetchResponse, FetchError> {
            Err(FetchError::type_error("fetch is not available"))
        }

        /// the whole body of a [`Body::Stream`] (`await response.text()`),
        /// waiting for its end
        fn read_body(&mut self, _stream: u64) -> Result<Vec<u8>, FetchError> {
            Err(FetchError::type_error("fetch is not available"))
        }

        /// `response.body.cancel()` of a [`Body::Stream`]
        fn cancel_body(&mut self, _stream: u64) {}

        /// the signal the request was made with aborted: the stream delivers
        /// nothing more
        fn abort_body(&mut self, _stream: u64) {}
    }

    /// `response.body?.cancel()`
    pub fn cancel_body(host: &mut dyn FetchHost, body: &Body) {
        if let Body::Stream(stream) = body {
            host.cancel_body(*stream);
        }
    }

    /// `await response.text()`
    pub fn read_text(host: &mut dyn FetchHost, body: &Body) -> Result<String, FetchError> {
        match body {
            Body::None => Ok(String::new()),
            Body::Bytes(bytes) => Ok(text_decoder_decode(bytes).into_owned()),
            Body::Stream(stream) => {
                let bytes = host.read_body(*stream)?;
                Ok(text_decoder_decode(&bytes).into_owned())
            }
        }
    }

    /// What `await response.json()` rejects with.
    #[derive(Debug, Clone, PartialEq)]
    pub enum JsonReadError {
        Fetch(FetchError),
        /// a `SyntaxError` and its message
        Syntax(String),
    }

    impl From<JsonReadError> for ClientError {
        fn from(error: JsonReadError) -> ClientError {
            match error {
                JsonReadError::Fetch(error) => ClientError::Fetch(error),
                JsonReadError::Syntax(message) => ClientError::Syntax(message),
            }
        }
    }

    /// `await response.json()`
    pub fn read_json(host: &mut dyn FetchHost, body: &Body) -> Result<JsonValue, JsonReadError> {
        let text = read_text(host, body).map_err(JsonReadError::Fetch)?;
        json_parse(&text).map_err(|error| JsonReadError::Syntax(error.message().to_owned()))
    }

    const REDIRECT_STATUSES: [u16; 5] = [301, 302, 303, 307, 308];
    const MAX_REDIRECTS: u32 = 5;

    /// `redirectTarget(response, requestUrl)`
    pub fn redirect_target(response: &FetchResponse, request_url: &str) -> Option<Url> {
        if !REDIRECT_STATUSES.contains(&response.status) {
            return None;
        }
        let location = response.headers.get("location")?;
        if location.is_empty() {
            return None;
        }
        let base = Url::parse(request_url).ok()?;
        base.join(location).ok()
    }

    /// `isWithinOrigin(from, to)`
    pub fn is_within_origin(from: &Url, to: &Url) -> bool {
        if from.scheme() == to.scheme()
            && from.host_str() == to.host_str()
            && from.port() == to.port()
        {
            return true;
        }
        from.host_str() == to.host_str()
            && from.scheme() == "http"
            && from.port().is_none()
            && to.scheme() == "https"
            && to.port().is_none()
    }

    /// `followWithinOrigin(baseFetch, url, init, response, followed)`: the
    /// response after the redirects followed, the one given when none is
    pub fn follow_within_origin(
        host: &mut dyn FetchHost,
        url: &str,
        init: &FetchInit,
        response: FetchResponse,
        followed: u32,
    ) -> Result<FetchResponse, FetchError> {
        let Some(target) = redirect_target(&response, url) else {
            return Ok(response);
        };
        let keeps_method = response.status == 307
            || response.status == 308
            || init
                .method
                .as_deref()
                .unwrap_or("GET")
                .eq_ignore_ascii_case("GET");
        if followed == MAX_REDIRECTS || !keeps_method {
            return Ok(response);
        }
        let Ok(from) = Url::parse(url) else {
            return Ok(response);
        };
        let target_user = target.username();
        let target_password = target.password().unwrap_or("");
        let adds_userinfo = (!target_user.is_empty() || !target_password.is_empty())
            && (target_user != from.username() || target_password != from.password().unwrap_or(""));
        if adds_userinfo || !is_within_origin(&from, &target) {
            return Ok(response);
        }
        cancel_body(host, &response.body);
        let mut next_init = init.clone();
        next_init.redirect = Some(Redirect::Manual);
        let next = host.fetch(target.as_str(), &next_init)?;
        follow_within_origin(host, target.as_str(), init, next, followed + 1)
    }

    /// `fetchWithinOrigin(fetch)(url, init)`
    pub fn fetch_within_origin(
        host: &mut dyn FetchHost,
        url: &str,
        init: &FetchInit,
    ) -> Result<FetchResponse, FetchError> {
        if matches!(init.redirect, Some(Redirect::Error | Redirect::Manual)) {
            return host.fetch(url, init);
        }
        let mut manual = init.clone();
        manual.redirect = Some(Redirect::Manual);
        let response = host.fetch(url, &manual)?;
        follow_within_origin(host, url, init, response, 0)
    }

    /// `unfollowedRedirect(response, requestUrl)`
    pub fn unfollowed_redirect(response: &FetchResponse, request_url: &str) -> Option<String> {
        if response.opaque_redirect {
            return Some(
                "Redirect not followed: this runtime does not expose the redirect target"
                    .to_owned(),
            );
        }
        let from = if response.url.is_empty() {
            request_url
        } else {
            response.url.as_str()
        };
        let mut target = redirect_target(response, from)?;
        let _ = target.set_username("");
        let _ = target.set_password(None);
        target.set_query(None);
        target.set_fragment(None);
        let from_https = Url::parse(from).is_ok_and(|url| url.scheme() == "https");
        if target.scheme() == "http" && from_https {
            let _ = target.set_scheme("https");
            return Some(format!(
                "Redirect to plain http not followed; try {} instead",
                target.as_str()
            ));
        }
        Some(format!("Redirect to {} not followed", target.as_str()))
    }

    fn type_regex() -> &'static JsRegex {
        js_regex!(r"^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
    }

    fn param_regex() -> &'static JsRegex {
        js_regex!(
            r##"^; *([!#$%&'*+.^_`|~0-9A-Za-z-]+) *= *("(?:[\u000b\u0020\u0021\u0023-\u005b\u005d-\u007e\u0080-\u00ff]|\\[\u000b\u0020-\u00ff])*"|[!#$%&'*+.^_`|~0-9A-Za-z-]+) *"##
        )
    }

    /// `contentType.parse(header).type`; `Err` is the `TypeError` it throws
    fn content_type(header: &str) -> Result<String, ()> {
        if header.is_empty() {
            return Err(());
        }
        let semicolon = header.find(';');
        let kind = match semicolon {
            Some(index) => trim(&header[..index]),
            None => trim(header),
        };
        if !type_regex().test(kind) {
            return Err(());
        }
        let kind = kind.to_lowercase();
        if let Some(mut index) = semicolon {
            while let Some(found) = param_regex().exec(&header[index..]) {
                index += found.as_str().len();
            }
            if index != header.len() {
                return Err(());
            }
        }
        Ok(kind)
    }

    /// `mediaTypeEssence(header)` of `shared/mediaType.js`
    pub fn media_type_essence(header: Option<&str>) -> Option<String> {
        let header = header.filter(|h| !h.is_empty())?;
        if let Ok(kind) = content_type(header) {
            return Some(kind);
        }
        let first = header.split(';').next().unwrap_or("");
        let essence = trim(first).to_lowercase();
        let units = essence.encode_utf16().count() as f64;
        if essence.is_empty() || slice_utf16(header, units, None).contains(',') {
            return None;
        }
        Some(essence)
    }
}

use net::FetchHost;

/// What a request, a notification or a transport can throw. The variants are
/// the classes the TypeScript tells apart; [`ClientError::name`] and
/// [`ClientError::message`] are `error.name` and `error.message`.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientError {
    Mcp(McpError),
    /// `StreamableHTTPError`: the HTTP status (or `-1`) and the message, its
    /// `Streamable HTTP error: ` prefix included
    StreamableHttp {
        code: f64,
        message: String,
    },
    /// `SseError`: the HTTP status where there is one, the message with its
    /// `SSE error: ` prefix
    Sse {
        code: Option<f64>,
        message: String,
    },
    /// `UnauthorizedError`
    Unauthorized(String),
    /// the `ZodError` that `.parse()` throws
    Zod(Vec<Issue>),
    /// the `$ZodError` of a failed `.safeParse()` that was rejected with
    ZodResult(Vec<Issue>),
    /// `SyntaxError` of `JSON.parse`
    Syntax(String),
    /// what the host's `fetch` rejected with
    Fetch(net::FetchError),
    /// an `Error` (or `DOMException`) by name and message
    Error {
        name: String,
        message: String,
    },
    /// a value that is not an error, thrown
    Thrown(String),
}

impl ClientError {
    /// `new Error(message)`
    pub fn plain(message: &str) -> ClientError {
        ClientError::Error {
            name: "Error".to_owned(),
            message: message.to_owned(),
        }
    }

    /// `error.name`
    pub fn name(&self) -> String {
        match self {
            ClientError::Mcp(_) => "McpError".to_owned(),
            ClientError::StreamableHttp { .. }
            | ClientError::Sse { .. }
            | ClientError::Unauthorized(_) => "Error".to_owned(),
            ClientError::Zod(_) => "ZodError".to_owned(),
            ClientError::ZodResult(_) => "$ZodError".to_owned(),
            ClientError::Syntax(_) => "SyntaxError".to_owned(),
            ClientError::Fetch(error) => error.name.clone(),
            ClientError::Error { name, .. } => name.clone(),
            ClientError::Thrown(_) => String::new(),
        }
    }

    /// `error.message`
    pub fn message(&self) -> String {
        match self {
            ClientError::Mcp(error) => error.message.clone(),
            ClientError::StreamableHttp { message, .. } | ClientError::Sse { message, .. } => {
                message.clone()
            }
            ClientError::Unauthorized(message) | ClientError::Syntax(message) => message.clone(),
            ClientError::Zod(issues) | ClientError::ZodResult(issues) => {
                schema::error_message(issues)
            }
            ClientError::Fetch(error) => error.message.clone(),
            ClientError::Error { message, .. } => message.clone(),
            ClientError::Thrown(text) => text.clone(),
        }
    }

    /// `String(error)`
    pub fn to_js_string(&self) -> String {
        // `String(zodError)` is its message
        match self {
            ClientError::Thrown(text) => return text.clone(),
            ClientError::Zod(_) | ClientError::ZodResult(_) => return self.message(),
            _ => {}
        }
        let name = self.name();
        let message = self.message();
        if name.is_empty() {
            message
        } else if message.is_empty() {
            name
        } else {
            format!("{name}: {message}")
        }
    }
}

impl From<StdioError> for ClientError {
    fn from(error: StdioError) -> ClientError {
        match error {
            StdioError::Overflow { max } => {
                ClientError::plain(&format!("ReadBuffer exceeded maximum size of {max} bytes"))
            }
            StdioError::Json(error) => ClientError::Syntax(error.message().to_owned()),
            StdioError::Schema(issues) => ClientError::Zod(issues),
        }
    }
}

/// `signal.reason` of an aborted `AbortSignal`
#[derive(Debug, Clone, PartialEq)]
pub enum AbortReason {
    /// an `Error`: `new DOMException('This operation was aborted', 'AbortError')`
    /// unless `abort(reason)` was given another
    Error { name: String, message: String },
    /// an `McpError`
    Mcp(McpError),
    /// any other value, as `String(value)`
    Value(String),
}

impl AbortReason {
    /// the reason of `controller.abort()` without an argument
    pub fn default_abort() -> AbortReason {
        AbortReason::Error {
            name: "AbortError".to_owned(),
            message: "This operation was aborted".to_owned(),
        }
    }

    /// `String(reason)`
    pub fn to_js_string(&self) -> String {
        match self {
            AbortReason::Error { name, message } => ClientError::Error {
                name: name.clone(),
                message: message.clone(),
            }
            .to_js_string(),
            AbortReason::Mcp(error) => format!("McpError: {}", error.message),
            AbortReason::Value(text) => text.clone(),
        }
    }

    /// what `throwIfAborted()` throws
    fn into_error(self) -> ClientError {
        match self {
            AbortReason::Error { name, message } => ClientError::Error { name, message },
            AbortReason::Mcp(error) => ClientError::Mcp(error),
            AbortReason::Value(text) => ClientError::Thrown(text),
        }
    }
}

/// An `AbortSignal` handed to an operation: `aborted` is its reason when it
/// is already aborted. A later abort is [`Client::on_abort`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Signal {
    pub aborted: Option<AbortReason>,
}

/// `RequestOptions`: `timeout` (ms, 60 000 when `None`) and `signal`
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RequestOptions {
    pub timeout: Option<f64>,
    pub signal: Option<Signal>,
}

/// How an operation settled.
#[derive(Debug, Clone, PartialEq)]
pub enum Settled {
    /// `connect`
    Connected,
    /// a request: the result as its schema parsed it
    Result(JsonValue),
}

/// What a request handler of the TypeScript throws.
#[derive(Debug, Clone, PartialEq)]
pub struct HandlerError {
    /// `error.code`; used when it is a safe integer, `-32603` otherwise
    pub code: Option<f64>,
    /// `error.message`; `Internal error` when it is `undefined`
    pub message: Option<String>,
    pub data: Option<JsonValue>,
}

impl HandlerError {
    /// `throw new McpError(code, message)`
    pub fn mcp(code: f64, message: &str) -> HandlerError {
        HandlerError {
            code: Some(code),
            message: Some(McpError::new(code, message, None).message),
            data: None,
        }
    }
}

/// What a request handler answers.
#[derive(Debug, Clone, PartialEq)]
pub enum HandlerOutcome {
    /// the value it resolves with (`None` is `undefined`)
    Result(Option<JsonValue>),
    Error(HandlerError),
}

/// What the output validator says of a tool's `structuredContent`.
#[derive(Debug, Clone, PartialEq)]
pub enum OutputCheck {
    Valid,
    /// `{ valid: false, errorMessage }`
    Invalid(String),
    /// the validator threw: the message of the error
    Threw(String),
}

/// What the session does to the world.
pub trait ClientHost: FetchHost {
    /// `setTimeout(callback, ms)`: the timer's number, given back to
    /// [`Client::on_timeout`] when it fires
    fn set_timeout(&mut self, ms: f64) -> u64;
    /// `clearTimeout(timer)`
    fn clear_timeout(&mut self, timer: u64);
    /// the promise of an operation settles
    fn settle(&mut self, op: OpId, outcome: Result<Settled, ClientError>);
    /// `client.onerror(error)`
    fn on_error(&mut self, _error: &ClientError) {}
    /// `client.onclose()`
    fn on_close(&mut self) {}
    /// the handler set with [`Client::set_notification_handler`] runs, with
    /// the notification as its schema parsed it
    fn on_notification(&mut self, _notification: &JsonValue) {}
    /// `client.fallbackRequestHandler(request)`, called only after
    /// [`Client::set_fallback_request_handler`]; `None` is no handler
    fn fallback_request(&mut self, _request: &JsonValue) -> Option<HandlerOutcome> {
        None
    }
    /// [`ExternalTransport`]: `transport.send(message)`
    fn write(&mut self, _message: &JsonValue) -> Result<(), ClientError> {
        Err(ClientError::plain("The transport is not writable"))
    }
    /// [`ExternalTransport`]: `transport.close()`; whether the transport
    /// reported itself closed now (its `onclose` ran: false when it had
    /// closed before)
    fn close_transport(&mut self) -> bool {
        false
    }
    /// `ajv.compile(schema)` of a tool's `outputSchema`: the validator's
    /// number, or the message of the error compiling threw. Engine-waiting.
    fn compile_output_schema(&mut self, schema: &JsonValue) -> Result<u64, String>;
    /// `validator(structuredContent)`. Engine-waiting.
    fn validate_output(&mut self, validator: u64, structured_content: &JsonValue) -> OutputCheck;
}

/// What a transport tells the session, in the order it happened.
#[derive(Debug, Clone, PartialEq)]
pub enum TransportEvent {
    /// `onmessage(message)`, the message already checked by `JSONRPCMessageSchema`
    Message(JsonValue),
    /// `onerror(error)`
    Error(ClientError),
    /// `onerror(error)` raised by the abort of a stream, a few ticks after the
    /// `close()` that aborted it
    LateError(ClientError),
    /// `onclose()`
    Closed,
    /// the settling of the promise `start()` returned [`StartState::Pending`] for
    Started(Result<(), ClientError>),
}

/// What `transport.start()` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartState {
    /// the promise resolved
    Ready,
    /// the promise is pending: [`TransportEvent::Started`] settles it
    Pending,
}

/// The `Transport` interface of `shared/transport.js`, as events. Events are
/// queued and read by the session after each call.
pub trait Transport {
    fn start(&mut self, host: &mut dyn ClientHost) -> Result<StartState, ClientError>;
    fn send(&mut self, host: &mut dyn ClientHost, message: &JsonValue) -> Result<(), ClientError>;
    fn close(&mut self, host: &mut dyn ClientHost);
    /// `transport.sessionId`
    fn session_id(&self) -> Option<String>;
    /// `transport.setProtocolVersion(version)`
    fn set_protocol_version(&mut self, version: &str);
    /// the next event, in the order of the TypeScript's callbacks
    fn pop_event(&mut self) -> Option<TransportEvent>;
    /// whether `send` reaches the network only after the current synchronous
    /// work (the transport awaits its headers first)
    fn defers_send(&self) -> bool {
        false
    }
    /// a timer the transport started fires: whether it was the transport's
    fn on_timeout(&mut self, _host: &mut dyn ClientHost, _timer: u64) -> bool {
        false
    }
    fn on_stream_chunk(&mut self, _host: &mut dyn ClientHost, _stream: u64, _bytes: &[u8]) {}
    fn on_stream_end(&mut self, _host: &mut dyn ClientHost, _stream: u64) {}
    fn on_stream_error(
        &mut self,
        _host: &mut dyn ClientHost,
        _stream: u64,
        _error: &net::FetchError,
    ) {
    }
    /// `transport.terminateSession()` of a Streamable HTTP transport: `None`
    /// for any other
    fn terminate_session(&mut self, _host: &mut dyn ClientHost) -> Option<Result<(), ClientError>> {
        None
    }
}

/// A transport whose bytes the caller moves: [`ClientHost::write`] sends,
/// and the events of the pipe come in through [`Client::on_message`] and its
/// siblings.
#[derive(Debug, Default)]
pub struct ExternalTransport {
    events: VecDeque<TransportEvent>,
}

impl ExternalTransport {
    pub fn new() -> ExternalTransport {
        ExternalTransport::default()
    }
}

impl Transport for ExternalTransport {
    fn start(&mut self, _host: &mut dyn ClientHost) -> Result<StartState, ClientError> {
        Ok(StartState::Ready)
    }

    fn send(&mut self, host: &mut dyn ClientHost, message: &JsonValue) -> Result<(), ClientError> {
        host.write(message)
    }

    fn close(&mut self, host: &mut dyn ClientHost) {
        if host.close_transport() {
            self.events.push_back(TransportEvent::Closed);
        }
    }

    fn session_id(&self) -> Option<String> {
        None
    }

    fn set_protocol_version(&mut self, _version: &str) {}

    fn pop_event(&mut self) -> Option<TransportEvent> {
        self.events.pop_front()
    }
}

/// which result schema a request answers, and what follows the result
#[derive(Debug, Clone, PartialEq)]
enum Kind {
    Initialize,
    ListTools,
    /// the tool's name when `params.name` is a string
    CallTool(Option<String>),
    Empty,
}

struct Pending {
    id: u64,
    op: OpId,
    kind: Kind,
    timer: Option<u64>,
    timeout: f64,
    /// the promise is settled but the handler stayed in the map (the send failed)
    orphan: bool,
}

struct ConnectCtx {
    op: OpId,
    options: RequestOptions,
}

/// why a request is cancelled
enum CancelReason {
    Timeout(f64),
    Abort(AbortReason),
}

/// `Client`
pub struct Client {
    client_info: JsonValue,
    capabilities: JsonValue,
    transport: Option<Box<dyn Transport>>,
    /// `this._transport !== undefined`
    connected: bool,
    pumping: bool,
    /// events taken off the transport's queue that wait for their turn
    backlog: VecDeque<TransportEvent>,
    /// [`TransportEvent::LateError`]s wait for the end of a rejection
    hold_late: bool,
    late: Vec<ClientError>,
    next_message_id: u64,
    pending: Vec<Pending>,
    /// the abort listeners the SDK never removes: (operation, message id)
    listeners: Vec<(OpId, u64)>,
    connecting: Option<ConnectCtx>,
    tools_changed_handler: bool,
    fallback_request_handler: bool,
    server_capabilities: Option<JsonValue>,
    server_version: Option<JsonValue>,
    instructions: Option<String>,
    output_validators: Vec<(String, u64)>,
    known_task_tools: Vec<String>,
    required_task_tools: Vec<String>,
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

/// `JSON.stringify(value)`
fn stringify(value: &JsonValue) -> String {
    json_stringify(value)
}

impl Client {
    /// `new Client(clientInfo, { capabilities: {} })`
    pub fn new(client_info: JsonValue) -> Client {
        Client {
            client_info,
            capabilities: JsonValue::Object(JsObject::new()),
            transport: None,
            connected: false,
            pumping: false,
            backlog: VecDeque::new(),
            hold_late: false,
            late: Vec::new(),
            next_message_id: 0,
            pending: Vec::new(),
            listeners: Vec::new(),
            connecting: None,
            tools_changed_handler: false,
            fallback_request_handler: false,
            server_capabilities: None,
            server_version: None,
            instructions: None,
            output_validators: Vec::new(),
            known_task_tools: Vec::new(),
            required_task_tools: Vec::new(),
        }
    }

    /// `client.setNotificationHandler(ToolListChangedNotificationSchema, ...)`
    pub fn set_notification_handler(&mut self) {
        self.tools_changed_handler = true;
    }

    /// `client.fallbackRequestHandler = ...`
    pub fn set_fallback_request_handler(&mut self) {
        self.fallback_request_handler = true;
    }

    /// `client.getInstructions()`
    pub fn get_instructions(&self) -> Option<&str> {
        self.instructions.as_deref()
    }

    /// `client.getServerCapabilities()`
    pub fn get_server_capabilities(&self) -> Option<&JsonValue> {
        self.server_capabilities.as_ref()
    }

    /// `client.getServerVersion()`
    pub fn get_server_version(&self) -> Option<&JsonValue> {
        self.server_version.as_ref()
    }

    /// `client.transport !== undefined`
    pub fn is_connected(&self) -> bool {
        self.connected
    }

    /// `client.transport?.sessionId`: whatever the transport holds, also
    /// after the client closed
    pub fn session_id(&self) -> Option<String> {
        self.transport.as_ref().and_then(|t| t.session_id())
    }

    // ---- sending ----

    fn send(&mut self, host: &mut dyn ClientHost, message: &JsonValue) -> Result<(), ClientError> {
        self.park_queued();
        let result = match self.transport.as_mut() {
            Some(transport) => transport.send(host, message),
            None => Err(ClientError::plain("Not connected")),
        };
        self.flush(host);
        result
    }

    /// `this.notification({ method })`
    fn notification(
        &mut self,
        host: &mut dyn ClientHost,
        method: &str,
        params: Option<JsonValue>,
    ) -> Result<(), ClientError> {
        if !self.connected {
            return Err(ClientError::plain("Not connected"));
        }
        let message = types::notification(method, params);
        self.send(host, &message)
    }

    /// `_cleanupTimeout(messageId)`
    fn cleanup_timeout(&mut self, host: &mut dyn ClientHost, id: u64) {
        if let Some(entry) = self.pending.iter_mut().find(|p| p.id == id)
            && let Some(timer) = entry.timer.take()
        {
            host.clear_timeout(timer);
        }
    }

    /// the promise of an operation rejects: a failed `connect` closes first
    fn reject(&mut self, host: &mut dyn ClientHost, op: OpId, kind: &Kind, error: ClientError) {
        if *kind != Kind::Initialize {
            host.settle(op, Err(error));
            return;
        }
        // the errors of the streams the close aborts surface after the
        // rejection reached its caller
        self.hold_late = true;
        self.close(host);
        self.hold_late = false;
        let late = std::mem::take(&mut self.late);
        host.settle(op, Err(error));
        for error in late {
            host.on_error(&error);
        }
    }

    /// `request(request, resultSchema, options)`
    fn request(
        &mut self,
        host: &mut dyn ClientHost,
        op: OpId,
        method: &str,
        params: Option<JsonValue>,
        kind: Kind,
        options: &RequestOptions,
    ) {
        if !self.connected {
            host.settle(op, Err(ClientError::plain("Not connected")));
            return;
        }
        if let Some(Signal {
            aborted: Some(reason),
        }) = &options.signal
        {
            let error = reason.clone().into_error();
            self.reject(host, op, &kind, error);
            return;
        }
        let id = self.next_message_id;
        self.next_message_id += 1;
        let message = types::request(method, params, id as f64);
        let timeout = options.timeout.unwrap_or(DEFAULT_REQUEST_TIMEOUT_MSEC);
        self.pending.push(Pending {
            id,
            op,
            kind: kind.clone(),
            timer: None,
            timeout,
            orphan: false,
        });
        if options.signal.is_some() {
            self.listeners.push((op, id));
        }
        let timer = host.set_timeout(timeout);
        if let Some(entry) = self.pending.iter_mut().find(|p| p.id == id) {
            entry.timer = Some(timer);
        }
        if let Err(error) = self.send(host, &message) {
            self.cleanup_timeout(host, id);
            if let Some(entry) = self.pending.iter_mut().find(|p| p.id == id) {
                entry.orphan = true;
            }
            self.reject(host, op, &kind, error);
        }
    }

    /// `client.connect(transport, options)`: settles `op` with
    /// [`Settled::Connected`]
    pub fn connect(
        &mut self,
        host: &mut dyn ClientHost,
        op: OpId,
        transport: Box<dyn Transport>,
        options: RequestOptions,
    ) {
        if self.connected {
            host.settle(
                op,
                Err(ClientError::plain(
                    "Already connected to a transport. Call close() before connecting to a new transport, or use a separate Protocol instance per connection.",
                )),
            );
            return;
        }
        self.transport = Some(transport);
        self.connected = true;
        self.connecting = Some(ConnectCtx { op, options });
        let started = match self.transport.as_mut() {
            Some(transport) => transport.start(host),
            None => Err(ClientError::plain("Not connected")),
        };
        match started {
            Err(error) => {
                self.connecting = None;
                self.pump(host);
                host.settle(op, Err(error));
            }
            Ok(StartState::Ready) => {
                self.pump(host);
                if let Some(ctx) = self.connecting.take() {
                    self.after_start(host, ctx.op, ctx.options);
                }
            }
            Ok(StartState::Pending) => self.pump(host),
        }
    }

    /// what follows `await super.connect(transport)`
    fn after_start(&mut self, host: &mut dyn ClientHost, op: OpId, options: RequestOptions) {
        if self
            .transport
            .as_ref()
            .and_then(|t| t.session_id())
            .is_some()
        {
            host.settle(op, Ok(Settled::Connected));
            return;
        }
        let params = object(vec![
            ("protocolVersion", text(LATEST_PROTOCOL_VERSION)),
            ("capabilities", self.capabilities.clone()),
            ("clientInfo", self.client_info.clone()),
        ]);
        self.request(
            host,
            op,
            "initialize",
            Some(params),
            Kind::Initialize,
            &options,
        );
    }

    /// the `initialize` result arrived and parsed
    fn after_initialize(&mut self, host: &mut dyn ClientHost, op: OpId, result: JsonValue) {
        let version = match result.get("protocolVersion").as_deref() {
            Some(JsonValue::String(version)) => version.clone(),
            _ => String::new(),
        };
        if !SUPPORTED_PROTOCOL_VERSIONS.contains(&version.as_str()) {
            let error = ClientError::plain(&format!(
                "Server's protocol version is not supported: {version}"
            ));
            self.reject(host, op, &Kind::Initialize, error);
            return;
        }
        self.server_capabilities = result.get("capabilities").map(|c| c.into_owned());
        self.server_version = result.get("serverInfo").map(|c| c.into_owned());
        if let Some(transport) = self.transport.as_mut() {
            transport.set_protocol_version(&version);
        }
        self.instructions = match result.get("instructions").as_deref() {
            Some(JsonValue::String(text)) => Some(text.clone()),
            _ => None,
        };
        match self.notification(host, "notifications/initialized", None) {
            Ok(()) => host.settle(op, Ok(Settled::Connected)),
            Err(error) => self.reject(host, op, &Kind::Initialize, error),
        }
    }

    /// `client.listTools(params, options)`
    pub fn list_tools(
        &mut self,
        host: &mut dyn ClientHost,
        op: OpId,
        params: Option<JsonValue>,
        options: &RequestOptions,
    ) {
        self.request(host, op, "tools/list", params, Kind::ListTools, options);
    }

    /// `client.callTool(params, undefined, options)`
    pub fn call_tool(
        &mut self,
        host: &mut dyn ClientHost,
        op: OpId,
        params: JsonValue,
        options: &RequestOptions,
    ) {
        let name = match params.get("name").as_deref() {
            Some(JsonValue::String(name)) => Some(name.clone()),
            _ => None,
        };
        if let Some(name) = &name
            && self.required_task_tools.contains(name)
        {
            let error = McpError::new(
                error_code::INVALID_REQUEST,
                &format!(
                    "Tool \"{name}\" requires task-based execution. Use client.experimental.tasks.callToolStream() instead."
                ),
                None,
            );
            host.settle(op, Err(ClientError::Mcp(error)));
            return;
        }
        self.request(
            host,
            op,
            "tools/call",
            Some(params),
            Kind::CallTool(name),
            options,
        );
    }

    /// `client.ping(options)`
    pub fn ping(&mut self, host: &mut dyn ClientHost, op: OpId, options: &RequestOptions) {
        self.request(host, op, "ping", None, Kind::Empty, options);
    }

    /// `cacheToolMetadata(tools)`
    fn cache_tool_metadata(
        &mut self,
        host: &mut dyn ClientHost,
        result: &JsonValue,
    ) -> Result<(), ClientError> {
        self.output_validators.clear();
        self.known_task_tools.clear();
        self.required_task_tools.clear();
        let tools = match result.get("tools").as_deref() {
            Some(JsonValue::Array(tools)) => tools.clone(),
            _ => Vec::new(),
        };
        for tool in &tools {
            let name = match tool.get("name").as_deref() {
                Some(JsonValue::String(name)) => name.clone(),
                _ => String::new(),
            };
            if let Some(schema) = tool.get("outputSchema")
                && schema.truthy()
            {
                match host.compile_output_schema(&schema) {
                    Ok(validator) => {
                        match self.output_validators.iter_mut().find(|(n, _)| *n == name) {
                            Some(slot) => slot.1 = validator,
                            None => self.output_validators.push((name.clone(), validator)),
                        }
                    }
                    Err(message) => return Err(ClientError::plain(&message)),
                }
            }
            let support = tool
                .get("execution")
                .and_then(|execution| execution.get("taskSupport").map(|s| s.into_owned()));
            if let Some(JsonValue::String(support)) = support {
                if support == "required" || support == "optional" {
                    self.known_task_tools.push(name.clone());
                }
                if support == "required" {
                    self.required_task_tools.push(name.clone());
                }
            }
        }
        Ok(())
    }

    /// what `callTool` does with the result of `tools/call`
    fn check_tool_result(
        &mut self,
        host: &mut dyn ClientHost,
        name: &Option<String>,
        result: &JsonValue,
    ) -> Result<(), ClientError> {
        let Some(name) = name else {
            return Ok(());
        };
        let Some(validator) = self
            .output_validators
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| *v)
        else {
            return Ok(());
        };
        let structured = result.get("structuredContent").map(|c| c.into_owned());
        let is_error = result.get("isError").is_some_and(|flag| flag.truthy());
        if structured.is_none() && !is_error {
            return Err(ClientError::Mcp(McpError::new(
                error_code::INVALID_REQUEST,
                &format!("Tool {name} has an output schema but did not return structured content"),
                None,
            )));
        }
        if let Some(structured) = structured {
            match host.validate_output(validator, &structured) {
                OutputCheck::Valid => {}
                OutputCheck::Invalid(message) => {
                    return Err(ClientError::Mcp(McpError::new(
                        error_code::INVALID_PARAMS,
                        &format!(
                            "Structured content does not match the tool's output schema: {message}"
                        ),
                        None,
                    )));
                }
                OutputCheck::Threw(message) => {
                    return Err(ClientError::Mcp(McpError::new(
                        error_code::INVALID_PARAMS,
                        &format!("Failed to validate structured content: {message}"),
                        None,
                    )));
                }
            }
        }
        Ok(())
    }

    /// the result of a request parsed: what follows it
    fn complete(&mut self, host: &mut dyn ClientHost, entry: &Pending, result: JsonValue) {
        match &entry.kind {
            Kind::Initialize => self.after_initialize(host, entry.op, result),
            Kind::ListTools => match self.cache_tool_metadata(host, &result) {
                Ok(()) => host.settle(entry.op, Ok(Settled::Result(result))),
                Err(error) => host.settle(entry.op, Err(error)),
            },
            Kind::CallTool(name) => match self.check_tool_result(host, name, &result) {
                Ok(()) => host.settle(entry.op, Ok(Settled::Result(result))),
                Err(error) => host.settle(entry.op, Err(error)),
            },
            Kind::Empty => host.settle(entry.op, Ok(Settled::Result(result))),
        }
    }

    // ---- what the transport tells ----

    /// `onmessage(message)` of an [`ExternalTransport`]: `message` is what
    /// `JSONRPCMessageSchema` parsed
    pub fn on_message(&mut self, host: &mut dyn ClientHost, message: JsonValue) {
        self.handle_event(host, TransportEvent::Message(message));
        self.pump(host);
    }

    /// `onerror(error)` of an [`ExternalTransport`]
    pub fn on_transport_error(&mut self, host: &mut dyn ClientHost, error: ClientError) {
        self.handle_event(host, TransportEvent::Error(error));
        self.pump(host);
    }

    /// `onclose()` of an [`ExternalTransport`]
    pub fn on_transport_closed(&mut self, host: &mut dyn ClientHost) {
        self.handle_event(host, TransportEvent::Closed);
        self.pump(host);
    }

    /// the events the transport queued, handled in order
    fn pump(&mut self, host: &mut dyn ClientHost) {
        if self.pumping {
            return;
        }
        self.pumping = true;
        loop {
            let event = match self.backlog.pop_front() {
                Some(event) => Some(event),
                None => self.transport.as_mut().and_then(|t| t.pop_event()),
            };
            match event {
                Some(event) => self.handle_event(host, event),
                None => break,
            }
        }
        self.pumping = false;
    }

    /// before a call into the transport made while events are being handled:
    /// what the transport queued so far is older than what the call queues
    fn park_queued(&mut self) {
        if !self.pumping {
            return;
        }
        while let Some(event) = self.transport.as_mut().and_then(|t| t.pop_event()) {
            self.backlog.push_back(event);
        }
    }

    /// after a call into the transport: its callbacks ran inside the call, so
    /// what it queued is handled at once, also while events are being handled
    fn flush(&mut self, host: &mut dyn ClientHost) {
        if !self.pumping {
            self.pump(host);
            return;
        }
        while let Some(event) = self.transport.as_mut().and_then(|t| t.pop_event()) {
            self.handle_event(host, event);
        }
    }

    fn handle_event(&mut self, host: &mut dyn ClientHost, event: TransportEvent) {
        match event {
            TransportEvent::Message(message) => self.handle_message(host, message),
            TransportEvent::Error(error) => host.on_error(&error),
            TransportEvent::LateError(error) => {
                if self.hold_late {
                    self.late.push(error);
                } else {
                    host.on_error(&error);
                }
            }
            TransportEvent::Closed => self.on_closed(host),
            TransportEvent::Started(outcome) => {
                if let Some(ctx) = self.connecting.take() {
                    match outcome {
                        Ok(()) => self.after_start(host, ctx.op, ctx.options),
                        Err(error) => host.settle(ctx.op, Err(error)),
                    }
                }
            }
        }
    }

    fn handle_message(&mut self, host: &mut dyn ClientHost, message: JsonValue) {
        if schema::is_jsonrpc_result_response(&message)
            || schema::is_jsonrpc_error_response(&message)
        {
            self.on_response(host, message);
        } else if schema::is_jsonrpc_request(&message) {
            self.on_request(host, message);
        } else if schema::is_jsonrpc_notification(&message) {
            self.on_notification(host, message);
        } else {
            host.on_error(&ClientError::plain(&format!(
                "Unknown message type: {}",
                stringify(&message)
            )));
        }
    }

    /// `_onresponse(response)`
    fn on_response(&mut self, host: &mut dyn ClientHost, response: JsonValue) {
        let message_id = jscompat::to_primitive(response.get("id").as_deref())
            .map_or(f64::NAN, |id| id.to_number());
        let Some(index) = self
            .pending
            .iter()
            .position(|entry| entry.id as f64 == message_id)
        else {
            host.on_error(&ClientError::plain(&format!(
                "Received a response for an unknown message ID: {}",
                stringify(&response)
            )));
            return;
        };
        let mut entry = self.pending.remove(index);
        if let Some(timer) = entry.timer.take() {
            host.clear_timeout(timer);
        }
        if entry.orphan {
            return;
        }
        if let Some(error) = response.get("error") {
            let code = jscompat::to_primitive(error.get("code").as_deref())
                .map_or(f64::NAN, |code| code.to_number());
            let message = match error.get("message").as_deref() {
                Some(JsonValue::String(message)) => message.clone(),
                _ => String::new(),
            };
            let data = error.get("data").map(|data| data.into_owned());
            let failure = ClientError::Mcp(mcp_error_from(code, &message, data));
            self.reject(host, entry.op, &entry.kind, failure);
            return;
        }
        let result = response
            .get("result")
            .map(|result| result.into_owned())
            .unwrap_or(JsonValue::Null);
        let parsed = match entry.kind {
            Kind::Initialize => schema::safe_parse(&schema::initialize_result(), &result),
            Kind::ListTools => schema::safe_parse(&schema::list_tools_result(), &result),
            Kind::CallTool(_) => schema::safe_parse(&schema::call_tool_result(), &result),
            Kind::Empty => schema::safe_parse(&schema::empty_result(), &result),
        };
        match parsed {
            Ok(data) => self.complete(host, &entry, data),
            Err(issues) => self.reject(host, entry.op, &entry.kind, ClientError::ZodResult(issues)),
        }
    }

    /// `_onrequest(request)`: a request of the server
    fn on_request(&mut self, host: &mut dyn ClientHost, request: JsonValue) {
        let id = request.get("id").map(|id| id.into_owned());
        let id = id.unwrap_or(JsonValue::Null);
        let method = match request.get("method").as_deref() {
            Some(JsonValue::String(method)) => method.clone(),
            _ => String::new(),
        };
        let outcome = if method == "ping" {
            match schema::safe_parse(&schema::ping_request(), &request) {
                Ok(_) => HandlerOutcome::Result(Some(JsonValue::Object(JsObject::new()))),
                Err(issues) => HandlerOutcome::Error(HandlerError {
                    code: None,
                    message: Some(schema::error_message(&issues)),
                    data: None,
                }),
            }
        } else if self.fallback_request_handler {
            match host.fallback_request(&request) {
                Some(outcome) => outcome,
                None => {
                    self.send_response(
                        host,
                        types::error_response(
                            id,
                            error_code::METHOD_NOT_FOUND,
                            "Method not found",
                            None,
                        ),
                        true,
                    );
                    return;
                }
            }
        } else {
            self.send_response(
                host,
                types::error_response(id, error_code::METHOD_NOT_FOUND, "Method not found", None),
                true,
            );
            return;
        };
        let response = match outcome {
            HandlerOutcome::Result(result) => match result {
                Some(result) => types::result_response(id, result),
                None => object(vec![("jsonrpc", text("2.0")), ("id", id)]),
            },
            HandlerOutcome::Error(error) => {
                let code = match error.code {
                    Some(code) if code.fract() == 0.0 && code.abs() <= 9_007_199_254_740_991.0 => {
                        code
                    }
                    _ => error_code::INTERNAL_ERROR,
                };
                let message = error.message.unwrap_or_else(|| "Internal error".to_owned());
                types::error_response(id, code, &message, error.data)
            }
        };
        self.send_response(host, response, false);
    }

    /// `capturedTransport?.send(response)` of `_onrequest`; `no_handler` is the
    /// branch whose failure reads "Failed to send an error response"
    fn send_response(&mut self, host: &mut dyn ClientHost, response: JsonValue, no_handler: bool) {
        if !self.connected {
            return;
        }
        if let Err(error) = self.send(host, &response) {
            let what = if no_handler {
                "an error response"
            } else {
                "response"
            };
            host.on_error(&ClientError::plain(&format!(
                "Failed to send {what}: {}",
                error.to_js_string()
            )));
        }
    }

    /// `_onnotification(notification)`
    fn on_notification(&mut self, host: &mut dyn ClientHost, notification: JsonValue) {
        let method = match notification.get("method").as_deref() {
            Some(JsonValue::String(method)) => method.clone(),
            _ => String::new(),
        };
        let handler = match method.as_str() {
            "notifications/cancelled" => Some(schema::cancelled_notification()),
            "notifications/progress" => Some(schema::progress_notification()),
            "notifications/tools/list_changed" if self.tools_changed_handler => {
                Some(schema::tool_list_changed_notification())
            }
            _ => None,
        };
        let Some(handler) = handler else {
            return;
        };
        let parsed = match schema::safe_parse(&handler, &notification) {
            Ok(parsed) => parsed,
            Err(issues) => {
                host.on_error(&ClientError::plain(&format!(
                    "Uncaught error in notification handler: {}",
                    schema::error_message(&issues)
                )));
                return;
            }
        };
        match method.as_str() {
            "notifications/cancelled" => {}
            "notifications/progress" => host.on_error(&ClientError::plain(&format!(
                "Received a progress notification for an unknown token: {}",
                stringify(&parsed)
            ))),
            _ => host.on_notification(&parsed),
        }
    }

    // ---- timers, aborts, closing ----

    /// a timer the session or its transport started fires: whether it was theirs
    pub fn on_timeout(&mut self, host: &mut dyn ClientHost, timer: u64) -> bool {
        if let Some(entry) = self.pending.iter().find(|p| p.timer == Some(timer)) {
            let (id, timeout) = (entry.id, entry.timeout);
            self.cancel(host, id, CancelReason::Timeout(timeout));
            return true;
        }
        let owned = match self.transport.as_mut() {
            Some(transport) => transport.on_timeout(host, timer),
            None => false,
        };
        if owned {
            self.pump(host);
        }
        owned
    }

    /// the `AbortSignal` handed to operation `op` aborted with `reason`
    pub fn on_abort(&mut self, host: &mut dyn ClientHost, op: OpId, reason: AbortReason) {
        let ids: Vec<u64> = self
            .listeners
            .iter()
            .filter(|(listener_op, _)| *listener_op == op)
            .map(|(_, id)| *id)
            .collect();
        for id in ids {
            self.cancel(host, id, CancelReason::Abort(reason.clone()));
        }
    }

    /// the signal of operation `op` is gone: its listener goes with it
    pub fn release(&mut self, op: OpId) {
        self.listeners.retain(|(listener_op, _)| *listener_op != op);
    }

    /// `cancel(reason)` of `request()`
    fn cancel(&mut self, host: &mut dyn ClientHost, id: u64, reason: CancelReason) {
        self.cleanup_timeout(host, id);
        let entry = self
            .pending
            .iter()
            .position(|p| p.id == id)
            .map(|index| self.pending.remove(index));
        let (error, reason_text) = match reason {
            CancelReason::Timeout(timeout) => {
                let data = object(vec![("timeout", JsonValue::Number(timeout))]);
                let error =
                    McpError::new(error_code::REQUEST_TIMEOUT, "Request timed out", Some(data));
                let reason_text = format!("McpError: {}", error.message);
                (error, reason_text)
            }
            CancelReason::Abort(AbortReason::Mcp(error)) => {
                let reason_text = format!("McpError: {}", error.message);
                (error, reason_text)
            }
            CancelReason::Abort(other) => {
                let reason_text = other.to_js_string();
                (
                    McpError::new(error_code::REQUEST_TIMEOUT, &reason_text, None),
                    reason_text,
                )
            }
        };
        let send_cancel = self.connected;
        // a transport that awaits its headers sends after the synchronous
        // rejection (and the close and abort that follow it)
        let deferred = send_cancel && self.transport.as_ref().is_some_and(|t| t.defers_send());
        let cancelled = send_cancel.then(|| {
            let params = object(vec![
                ("requestId", JsonValue::Number(id as f64)),
                ("reason", JsonValue::String(reason_text)),
            ]);
            object(vec![
                ("jsonrpc", text("2.0")),
                ("method", text("notifications/cancelled")),
                ("params", params),
            ])
        });
        let mut sent = None;
        if let Some(cancelled) = &cancelled
            && !deferred
        {
            sent = Some(self.send_held(host, cancelled));
        }
        if let Some(entry) = entry
            && !entry.orphan
        {
            self.reject(host, entry.op, &entry.kind, ClientError::Mcp(error));
        }
        if let Some(cancelled) = &cancelled
            && deferred
        {
            sent = Some(self.send_held(host, cancelled));
        }
        // `send(cancel).catch(...)`: what the send answers comes after the
        // rejection above
        if let Some((result, held)) = sent {
            for event in held {
                self.handle_event(host, event);
            }
            if let Err(failure) = result {
                host.on_error(&ClientError::plain(&format!(
                    "Failed to send cancellation: {}",
                    failure.to_js_string()
                )));
            }
            self.pump(host);
        }
    }

    /// a send whose events wait for the caller
    fn send_held(
        &mut self,
        host: &mut dyn ClientHost,
        message: &JsonValue,
    ) -> (Result<(), ClientError>, Vec<TransportEvent>) {
        self.park_queued();
        let Some(transport) = self.transport.as_mut() else {
            return (Err(ClientError::plain("Not connected")), Vec::new());
        };
        let result = transport.send(host, message);
        let mut held = Vec::new();
        while let Some(event) = transport.pop_event() {
            held.push(event);
        }
        (result, held)
    }

    /// `await client.close()`
    pub fn close(&mut self, host: &mut dyn ClientHost) {
        if !self.connected {
            return;
        }
        self.park_queued();
        if let Some(transport) = self.transport.as_mut() {
            transport.close(host);
        }
        self.flush(host);
    }

    /// `_onclose()`
    fn on_closed(&mut self, host: &mut dyn ClientHost) {
        let handlers = std::mem::take(&mut self.pending);
        for entry in &handlers {
            if let Some(timer) = entry.timer {
                host.clear_timeout(timer);
            }
        }
        self.connected = false;
        host.on_close();
        let closed = McpError::new(error_code::CONNECTION_CLOSED, "Connection closed", None);
        for entry in handlers {
            if !entry.orphan {
                self.reject(
                    host,
                    entry.op,
                    &entry.kind,
                    ClientError::Mcp(closed.clone()),
                );
            }
        }
    }

    // ---- bodies of fetches ----

    /// a chunk of the body of a [`net::Body::Stream`] arrived
    pub fn on_stream_chunk(&mut self, host: &mut dyn ClientHost, stream: u64, bytes: &[u8]) {
        if let Some(transport) = self.transport.as_mut() {
            transport.on_stream_chunk(host, stream, bytes);
        }
        self.pump(host);
    }

    /// the body of a [`net::Body::Stream`] ended
    pub fn on_stream_end(&mut self, host: &mut dyn ClientHost, stream: u64) {
        if let Some(transport) = self.transport.as_mut() {
            transport.on_stream_end(host, stream);
        }
        self.pump(host);
    }

    /// the body of a [`net::Body::Stream`] failed: what `read()` rejected with
    pub fn on_stream_error(
        &mut self,
        host: &mut dyn ClientHost,
        stream: u64,
        error: &net::FetchError,
    ) {
        if let Some(transport) = self.transport.as_mut() {
            transport.on_stream_error(host, stream, error);
        }
        self.pump(host);
    }

    /// `transport.terminateSession()` when the transport is a Streamable HTTP
    /// one holding a session id (`remote.ts` ends the session before it
    /// closes); `None` for any other transport. A session ends with the
    /// DELETE request answered.
    pub fn terminate_session(
        &mut self,
        host: &mut dyn ClientHost,
    ) -> Option<Result<(), ClientError>> {
        let result = match self.transport.as_mut() {
            Some(transport) => transport.terminate_session(host),
            None => None,
        };
        self.pump(host);
        result
    }
}

/// `McpError.fromError(code, message, data)`
fn mcp_error_from(code: f64, message: &str, data: Option<JsonValue>) -> McpError {
    if code == error_code::URL_ELICITATION_REQUIRED
        && let Some(data) = &data
        && data.truthy()
        && let Some(elicitations) = data.get("elicitations")
        && elicitations.truthy()
    {
        let only = object(vec![("elicitations", elicitations.into_owned())]);
        return McpError::new(code, message, Some(only));
    }
    McpError::new(code, message, data)
}
