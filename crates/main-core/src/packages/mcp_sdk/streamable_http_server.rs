//! `@modelcontextprotocol/sdk` 1.32.1 `server/webStandardStreamableHttp.js`
//! (`WebStandardStreamableHTTPServerTransport`) and the Node wrapper
//! `server/streamableHttp.js`, in the one mode the shell runs it in: stateful
//! (a session id), SSE responses (no `enableJsonResponse`), no event store,
//! no DNS-rebinding options, the default 15 s keep-alive.
//!
//! sans-IO: a request arrives as [`HttpRequest`] and the response is the
//! [`Command`]s pushed on the shared queue, `Respond` (the head), `Write`
//! (an SSE event) and `End`, in the order the TypeScript produces them. The
//! 15 s keep-alive of a stream is a timer: `SetInterval` out, `on_timer` in.
//! A client that goes away is `on_response_closed`.
//!
//! The Node wrapper passes the transport a request whose body the shell has
//! read already; the body then reads as empty, which is what `unread_body`
//! carries (`parsedBody` is the body the shell parsed).
//!
//! Left out: the replay and resumption code (no event store), the JSON
//! response mode, the stateless mode, `onsessionclosed`, and the outer
//! `catch` of `handlePostRequest` (nothing it guards can throw here).

use jscompat::{JsMap, JsObject, JsonValue, json_parse, json_stringify, to_number, trim};

use super::server::{
    Command, Io, MessageExtra, Outgoing, ResponseId, SessionServer, TimerId, in_send_order,
    is_initialize_request,
};
use super::types::{SUPPORTED_PROTOCOL_VERSIONS, schema};

/// `MAX_BATCH_SIZE`
const MAX_BATCH_SIZE: usize = 100;
/// `DEFAULT_MAX_REQUEST_BODY_SIZE`: 4 MiB
const DEFAULT_MAX_REQUEST_BODY_SIZE: f64 = 4.0 * 1024.0 * 1024.0;
/// `DEFAULT_SSE_KEEP_ALIVE_MS`
const DEFAULT_SSE_KEEP_ALIVE_MS: f64 = 15000.0;
/// `MAX_TIMER_DELAY_MS`
const MAX_TIMER_DELAY_MS: f64 = 2147483647.0;

/// What a handler of the transport reads of a request.
#[derive(Debug, Clone, Default)]
pub struct HttpRequest {
    pub method: String,
    /// the request target as the client wrote it (`req.url`)
    pub url: String,
    /// `req.headers`: names in lower case, a repeated header joined with
    /// `, ` as Node joins it
    pub headers: Vec<(String, String)>,
}

impl HttpRequest {
    /// `req.headers[name]`; `name` in lower case
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

fn object(entries: Vec<(&str, JsonValue)>) -> JsonValue {
    let mut out = JsObject::new();
    for (key, value) in entries {
        out.set(key, value);
    }
    JsonValue::Object(out)
}

fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || "!#$%&'*+.^_`|~-".contains(c)
}

/// `TYPE_REGEXP` of `content-type`
fn is_media_type(text: &str) -> bool {
    let mut parts = text.split('/');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(a), Some(b), None) => {
            !a.is_empty()
                && !b.is_empty()
                && a.chars().all(is_token_char)
                && b.chars().all(is_token_char)
        }
        _ => false,
    }
}

/// `contentType.parse(header)` of `content-type` 1.0.5: the media type
/// (lower case), or the message of the `TypeError` it throws.
pub fn content_type_parse(header: &str) -> Result<String, String> {
    if header.is_empty() {
        return Err("argument string is required".to_owned());
    }
    let units: Vec<char> = header.chars().collect();
    let index = units.iter().position(|&c| c == ';');
    let type_text: String = match index {
        Some(at) => trim(&units[..at].iter().collect::<String>()).to_owned(),
        None => trim(header).to_owned(),
    };
    if !is_media_type(&type_text) {
        return Err("invalid media type".to_owned());
    }
    if let Some(mut at) = index {
        // PARAM_REGEXP, matched at `at` (a match further on is as bad as none)
        while at < units.len() {
            match match_parameter(&units, at) {
                Some(end) => at = end,
                None => return Err("invalid parameter format".to_owned()),
            }
        }
    }
    Ok(type_text.to_lowercase())
}

/// one `; name=value` of `PARAM_REGEXP` at `at`: where the match ends
fn match_parameter(units: &[char], at: usize) -> Option<usize> {
    let mut i = at;
    if units.get(i) != Some(&';') {
        return None;
    }
    i += 1;
    while units.get(i) == Some(&' ') {
        i += 1;
    }
    let key_start = i;
    while units.get(i).is_some_and(|&c| is_token_char(c)) {
        i += 1;
    }
    if i == key_start {
        return None;
    }
    while units.get(i) == Some(&' ') {
        i += 1;
    }
    if units.get(i) != Some(&'=') {
        return None;
    }
    i += 1;
    while units.get(i) == Some(&' ') {
        i += 1;
    }
    if units.get(i) == Some(&'"') {
        // a quoted string; the token alternative cannot start at `"` either
        let mut j = i + 1;
        loop {
            let c = *units.get(j)?;
            let code = c as u32;
            if c == '\\' {
                let next = *units.get(j + 1)? as u32;
                if next == 0x0b || (0x20..=0xff).contains(&next) {
                    j += 2;
                    continue;
                }
                return None;
            }
            if c == '"' {
                i = j + 1;
                break;
            }
            if code == 0x0b
                || code == 0x20
                || code == 0x21
                || (0x23..=0x5b).contains(&code)
                || (0x5d..=0x7e).contains(&code)
                || (0x80..=0xff).contains(&code)
            {
                j += 1;
                continue;
            }
            return None;
        }
    } else {
        let value_start = i;
        while units.get(i).is_some_and(|&c| is_token_char(c)) {
            i += 1;
        }
        if i == value_start {
            return None;
        }
    }
    while units.get(i) == Some(&' ') {
        i += 1;
    }
    Some(i)
}

/// `mediaTypeEssence(header)`
fn media_type_essence(header: Option<&str>) -> Option<String> {
    let header = header.filter(|h| !h.is_empty())?;
    match content_type_parse(header) {
        Ok(essence) => Some(essence),
        Err(_) => {
            let first = header.split(';').next().unwrap_or("");
            let essence = trim(first).to_lowercase();
            let rest: String = header.chars().skip(essence.chars().count()).collect();
            if essence.is_empty() || rest.contains(',') {
                None
            } else {
                Some(essence)
            }
        }
    }
}

/// `isJsonContentType(header)`
pub fn is_json_content_type(header: Option<&str>) -> bool {
    if header == Some("application/json") {
        return true;
    }
    media_type_essence(header).as_deref() == Some("application/json")
}

/// `onsessioninitialized`: called with the session id
pub type SessionInitialized = Box<dyn FnMut(&str)>;

/// the options the shell gives `new StreamableHTTPServerTransport(...)`
pub struct StreamableOptions {
    /// `sessionIdGenerator: () => id`
    pub session_id: String,
    /// `onsessioninitialized`
    pub on_session_initialized: Option<SessionInitialized>,
}

struct Stream {
    res: ResponseId,
    keep_alive: Option<TimerId>,
}

/// `JsMap` keys of the request ids: a string and a number stay apart
fn id_key(id: &JsonValue) -> String {
    match id {
        JsonValue::String(text) => format!("s{text}"),
        other => format!("n{}", json_stringify(other)),
    }
}

const STANDALONE_SSE_STREAM_ID: &str = "_GET_stream";

/// `StreamableHTTPServerTransport` in stateful SSE mode.
pub struct StreamableHttpServerTransport {
    io: Io,
    session_id: Option<String>,
    id_to_set: String,
    on_session_initialized: Option<SessionInitialized>,
    started: bool,
    initialized: bool,
    closed: bool,
    /// `onclose` was called and the caller has not been told
    close_pending: bool,
    stream_mapping: JsMap<Stream>,
    request_to_stream: JsMap<String>,
    request_response_map: JsMap<JsonValue>,
    /// ids in the order they were set, for `relatedIds`
    request_ids: Vec<(String, JsonValue)>,
    max_request_body_size: f64,
}

impl StreamableHttpServerTransport {
    pub fn new(io: Io, options: StreamableOptions) -> Self {
        StreamableHttpServerTransport {
            io,
            session_id: None,
            id_to_set: options.session_id,
            on_session_initialized: options.on_session_initialized,
            started: false,
            initialized: false,
            closed: false,
            close_pending: false,
            stream_mapping: JsMap::new(),
            request_to_stream: JsMap::new(),
            request_response_map: JsMap::new(),
            request_ids: Vec::new(),
            max_request_body_size: DEFAULT_MAX_REQUEST_BODY_SIZE,
        }
    }

    /// `sessionId`
    pub fn session_id(&self) -> Option<&str> {
        self.session_id.as_deref()
    }

    /// `start()`
    pub fn start(&mut self) -> Result<(), String> {
        if self.started {
            return Err("Transport already started".to_owned());
        }
        self.started = true;
        Ok(())
    }

    /// whether `onclose` ran since the last call; the caller then forgets
    /// the session
    pub fn take_closed(&mut self) -> bool {
        std::mem::take(&mut self.close_pending)
    }

    /// `createJsonErrorResponse(status, code, message)`
    fn json_error(&self, res: ResponseId, status: u16, code: f64, message: &str) {
        let body = object(vec![
            ("jsonrpc", JsonValue::String("2.0".into())),
            (
                "error",
                object(vec![
                    ("code", JsonValue::Number(code)),
                    ("message", JsonValue::String(message.to_owned())),
                ]),
            ),
            ("id", JsonValue::Null),
        ]);
        self.io.push(Command::Respond {
            res,
            status,
            headers: vec![("content-type".into(), "application/json".into())],
        });
        self.io.push(Command::End {
            res,
            chunk: Some(json_stringify(&body)),
        });
    }

    /// `startKeepAlive`: `armSseKeepAlive(15000, tick)`
    fn start_keep_alive(&self) -> Option<TimerId> {
        if self.closed {
            return None;
        }
        let ms = DEFAULT_SSE_KEEP_ALIVE_MS;
        if !ms.is_finite() || ms < 1.0 {
            return None;
        }
        let timer = self.io.new_timer();
        self.io.push(Command::SetInterval {
            timer,
            ms: ms.min(MAX_TIMER_DELAY_MS),
        });
        Some(timer)
    }

    /// the interval of a stream fired: the keep-alive comment
    pub fn on_timer(&mut self, timer: TimerId) -> bool {
        let mut target = None;
        for (_, stream) in self.stream_mapping.iter() {
            if stream.keep_alive == Some(timer) {
                target = Some(stream.res);
            }
        }
        match target {
            Some(res) => {
                self.io.push(Command::Write {
                    res,
                    chunk: ": keepalive\n\n".to_owned(),
                });
                true
            }
            None => false,
        }
    }

    /// the stream's `cleanup`: the interval goes, the mapping goes, the
    /// controller closes
    fn cleanup_stream(&mut self, stream_id: &str) {
        if let Some(stream) = self.stream_mapping.delete(stream_id) {
            if let Some(timer) = stream.keep_alive {
                self.io.push(Command::ClearTimer { timer });
            }
            self.io.push(Command::End {
                res: stream.res,
                chunk: None,
            });
        }
    }

    /// `ReadableStream.cancel` of a stream whose client went away
    pub fn on_response_closed(&mut self, res: ResponseId) -> bool {
        let mut found = None;
        for (key, stream) in self.stream_mapping.iter() {
            if stream.res == res {
                found = Some(key.to_owned());
            }
        }
        match found {
            Some(key) => {
                if let Some(stream) = self.stream_mapping.delete(&key)
                    && let Some(timer) = stream.keep_alive
                {
                    self.io.push(Command::ClearTimer { timer });
                }
                true
            }
            None => false,
        }
    }

    /// `handleRequest(req, options)`
    pub fn handle_request(
        &mut self,
        res: ResponseId,
        req: &HttpRequest,
        parsed_body: Option<&JsonValue>,
        unread_body: &[u8],
        server: &mut dyn SessionServer,
    ) {
        if self.closed {
            self.json_error(res, 404, -32001.0, "Session not found");
            return;
        }
        match req.method.as_str() {
            "POST" => self.handle_post_request(res, req, parsed_body, unread_body, server),
            "GET" => self.handle_get_request(res, req),
            "DELETE" => self.handle_delete_request(res, req),
            _ => self.handle_unsupported_request(res),
        }
    }

    /// `handleGetRequest(req)`
    fn handle_get_request(&mut self, res: ResponseId, req: &HttpRequest) {
        let accept = req.header("accept");
        if !accept.is_some_and(|a| a.contains("text/event-stream")) {
            self.json_error(
                res,
                406,
                -32000.0,
                "Not Acceptable: Client must accept text/event-stream",
            );
            return;
        }
        if self.validate_session(res, req) || self.validate_protocol_version(res, req) {
            return;
        }
        if self.stream_mapping.get(STANDALONE_SSE_STREAM_ID).is_some() {
            self.json_error(
                res,
                409,
                -32000.0,
                "Conflict: Only one SSE stream is allowed per session",
            );
            return;
        }
        self.io.push(Command::Respond {
            res,
            status: 200,
            headers: self.sse_headers(),
        });
        self.stream_mapping.set(
            STANDALONE_SSE_STREAM_ID,
            Stream {
                res,
                keep_alive: None,
            },
        );
        let timer = self.start_keep_alive();
        if let Some(stream) = self.stream_mapping.get_mut(STANDALONE_SSE_STREAM_ID) {
            stream.keep_alive = timer;
        }
    }

    /// the headers of an SSE response
    fn sse_headers(&self) -> Vec<(String, String)> {
        let mut headers = vec![
            ("content-type".to_owned(), "text/event-stream".to_owned()),
            (
                "cache-control".to_owned(),
                "no-cache, no-transform".to_owned(),
            ),
            ("connection".to_owned(), "keep-alive".to_owned()),
            ("x-accel-buffering".to_owned(), "no".to_owned()),
        ];
        if let Some(session_id) = &self.session_id {
            headers.push(("mcp-session-id".to_owned(), session_id.clone()));
        }
        headers
    }

    /// `handleUnsupportedRequest()`
    fn handle_unsupported_request(&self, res: ResponseId) {
        let body = object(vec![
            ("jsonrpc", JsonValue::String("2.0".into())),
            (
                "error",
                object(vec![
                    ("code", JsonValue::Number(-32000.0)),
                    ("message", JsonValue::String("Method not allowed.".into())),
                ]),
            ),
            ("id", JsonValue::Null),
        ]);
        self.io.push(Command::Respond {
            res,
            status: 405,
            headers: vec![
                ("allow".into(), "GET, POST, DELETE".into()),
                ("content-type".into(), "application/json".into()),
            ],
        });
        self.io.push(Command::End {
            res,
            chunk: Some(json_stringify(&body)),
        });
    }

    /// `handlePostRequest(req, options)`
    fn handle_post_request(
        &mut self,
        res: ResponseId,
        req: &HttpRequest,
        parsed_body: Option<&JsonValue>,
        unread_body: &[u8],
        server: &mut dyn SessionServer,
    ) {
        let accept = req.header("accept");
        if !accept.is_some_and(|a| a.contains("application/json"))
            || !accept.is_some_and(|a| a.contains("text/event-stream"))
        {
            self.json_error(
                res,
                406,
                -32000.0,
                "Not Acceptable: Client must accept both application/json and text/event-stream",
            );
            return;
        }
        if !is_json_content_type(req.header("content-type")) {
            self.json_error(
                res,
                415,
                -32000.0,
                "Unsupported Media Type: Content-Type must be application/json",
            );
            return;
        }
        let raw_message = match parsed_body {
            Some(body) => body.clone(),
            None => {
                // `readRequestBody(req, max)`
                let declared = to_number(req.header("content-length").unwrap_or(""));
                if declared > self.max_request_body_size
                    || unread_body.len() as f64 > self.max_request_body_size
                {
                    let message = format!(
                        "Payload Too Large: Request body must not exceed {} bytes",
                        jscompat::number_to_string(self.max_request_body_size)
                    );
                    self.json_error(res, 413, -32000.0, &message);
                    return;
                }
                let body = jscompat::text_decoder_decode(unread_body);
                match json_parse(&body) {
                    Ok(value) => value,
                    Err(_) => {
                        self.json_error(res, 400, -32700.0, "Parse error: Invalid JSON");
                        return;
                    }
                }
            }
        };
        if let JsonValue::Array(items) = &raw_message
            && items.len() > MAX_BATCH_SIZE
        {
            let message =
                format!("Invalid Request: Batch must not exceed {MAX_BATCH_SIZE} messages");
            self.json_error(res, 400, -32600.0, &message);
            return;
        }
        let parsed: Result<Vec<JsonValue>, ()> = match &raw_message {
            JsonValue::Array(items) => items
                .iter()
                .map(|msg| schema::safe_parse(&schema::jsonrpc_message(), msg).map_err(|_| ()))
                .collect(),
            other => schema::safe_parse(&schema::jsonrpc_message(), other)
                .map(|message| vec![message])
                .map_err(|_| ()),
        };
        let Ok(messages) = parsed else {
            self.json_error(res, 400, -32700.0, "Parse error: Invalid JSON-RPC message");
            return;
        };
        if self.closed {
            self.json_error(res, 404, -32001.0, "Session not found");
            return;
        }
        let is_initialization_request = messages.iter().any(is_initialize_request);
        if is_initialization_request {
            if self.initialized && self.session_id.is_some() {
                self.json_error(
                    res,
                    400,
                    -32600.0,
                    "Invalid Request: Server already initialized",
                );
                return;
            }
            if messages.len() > 1 {
                self.json_error(
                    res,
                    400,
                    -32600.0,
                    "Invalid Request: Only one initialization request is allowed",
                );
                return;
            }
            self.session_id = Some(self.id_to_set.clone());
            self.initialized = true;
            if let Some(session_id) = self.session_id.clone()
                && !session_id.is_empty()
                && let Some(callback) = self.on_session_initialized.as_mut()
            {
                callback(&session_id);
            }
        }
        if !is_initialization_request
            && (self.validate_session(res, req) || self.validate_protocol_version(res, req))
        {
            return;
        }
        if self.closed {
            self.json_error(res, 404, -32001.0, "Session not found");
            return;
        }
        let has_requests = messages.iter().any(schema::is_jsonrpc_request);
        let extra = MessageExtra {
            session_id: self.session_id.clone(),
        };
        if !has_requests {
            // only notifications and responses: 202
            let mut deferred = Vec::new();
            for message in &messages {
                deferred.extend(server.on_message(message, &extra));
            }
            self.io.push(Command::Respond {
                res,
                status: 202,
                headers: Vec::new(),
            });
            self.io.push(Command::End { res, chunk: None });
            // nothing of a notification is sent
            let _ = deferred;
            return;
        }
        let stream_id = self.io.random_uuid();
        self.io.push(Command::Respond {
            res,
            status: 200,
            headers: self.sse_headers(),
        });
        for message in &messages {
            if schema::is_jsonrpc_request(message) {
                self.stream_mapping.set(
                    stream_id.clone(),
                    Stream {
                        res,
                        keep_alive: None,
                    },
                );
                let id = message
                    .get("id")
                    .map(|v| v.into_owned())
                    .unwrap_or(JsonValue::Null);
                let key = id_key(&id);
                self.request_to_stream.set(key.clone(), stream_id.clone());
                if !self.request_ids.iter().any(|(k, _)| *k == key) {
                    self.request_ids.push((key, id));
                }
            }
        }
        // the messages are handed over; what they answer is sent after the
        // keep-alive of the stream is armed, as the promise chains run later
        let mut outgoing = Vec::new();
        for message in &messages {
            outgoing.extend(server.on_message(message, &extra));
        }
        if self
            .stream_mapping
            .get(&stream_id)
            .is_some_and(|s| s.res == res)
        {
            let timer = self.start_keep_alive();
            if let Some(stream) = self.stream_mapping.get_mut(&stream_id) {
                stream.keep_alive = timer;
            }
        }
        self.send_outgoing(outgoing);
    }

    /// `handleDeleteRequest(req)`
    fn handle_delete_request(&mut self, res: ResponseId, req: &HttpRequest) {
        if self.validate_session(res, req) || self.validate_protocol_version(res, req) {
            return;
        }
        // `finally { await this.close() }` runs before the response goes out
        self.close();
        self.io.push(Command::Respond {
            res,
            status: 200,
            headers: Vec::new(),
        });
        self.io.push(Command::End { res, chunk: None });
    }

    /// `validateSession(req)`: whether it answered
    fn validate_session(&self, res: ResponseId, req: &HttpRequest) -> bool {
        if !self.initialized {
            self.json_error(res, 400, -32000.0, "Bad Request: Server not initialized");
            return true;
        }
        let session_id = req.header("mcp-session-id");
        match session_id {
            None | Some("") => {
                self.json_error(
                    res,
                    400,
                    -32000.0,
                    "Bad Request: Mcp-Session-Id header is required",
                );
                true
            }
            Some(given) if self.session_id.as_deref() != Some(given) => {
                self.json_error(res, 404, -32001.0, "Session not found");
                true
            }
            Some(_) => false,
        }
    }

    /// `validateProtocolVersion(req)`: whether it answered
    fn validate_protocol_version(&self, res: ResponseId, req: &HttpRequest) -> bool {
        if let Some(version) = req.header("mcp-protocol-version")
            && !SUPPORTED_PROTOCOL_VERSIONS.contains(&version)
        {
            let message = format!(
                "Bad Request: Unsupported protocol version: {version} (supported versions: {})",
                SUPPORTED_PROTOCOL_VERSIONS.join(", ")
            );
            self.json_error(res, 400, -32000.0, &message);
            return true;
        }
        false
    }

    /// `close()`
    pub fn close(&mut self) {
        if self.closed {
            return;
        }
        self.closed = true;
        let keys: Vec<String> = self.stream_mapping.keys().map(str::to_owned).collect();
        for key in keys {
            self.cleanup_stream(&key);
        }
        self.stream_mapping.clear();
        self.request_response_map.clear();
        self.close_pending = true;
    }

    /// the answers of requests that were settled later, sent as they come
    pub fn send_outgoing(&mut self, outgoing: Vec<Outgoing>) {
        for sent in in_send_order(outgoing) {
            if let Some(line) = &sent.log {
                self.io.log(line.clone());
            }
            self.send(sent);
        }
    }

    /// `send(message)` of a response (a notification of a request is not
    /// sent by anything here)
    fn send(&mut self, sent: Outgoing) {
        let message = sent.message;
        let is_response = schema::is_jsonrpc_result_response(&message)
            || schema::is_jsonrpc_error_response(&message);
        let request_id = if is_response {
            message.get("id").map(|v| v.into_owned())
        } else {
            None
        };
        let Some(request_id) = request_id else {
            // the standalone stream: requests and notifications only
            if is_response {
                return;
            }
            if let Some(stream) = self.stream_mapping.get(STANDALONE_SSE_STREAM_ID) {
                self.io.push(Command::Write {
                    res: stream.res,
                    chunk: sse_event(&message),
                });
            }
            return;
        };
        let key = id_key(&request_id);
        let Some(stream_id) = self.request_to_stream.get(&key).cloned() else {
            // `No connection established for request ID`: onerror, which nothing sets
            return;
        };
        if let Some(stream) = self.stream_mapping.get(&stream_id) {
            self.io.push(Command::Write {
                res: stream.res,
                chunk: sse_event(&message),
            });
        }
        self.request_response_map.set(key.clone(), message);
        let related: Vec<String> = self
            .request_ids
            .iter()
            .filter(|(k, _)| self.request_to_stream.get(k) == Some(&stream_id))
            .map(|(k, _)| k.clone())
            .collect();
        let all_ready = related.iter().all(|k| self.request_response_map.has(k));
        if all_ready {
            if self.stream_mapping.get(&stream_id).is_none() {
                for k in &related {
                    self.request_response_map.delete(k);
                    self.request_to_stream.delete(k);
                    self.request_ids.retain(|(id, _)| id != k);
                }
                return;
            }
            self.cleanup_stream(&stream_id);
            for k in &related {
                self.request_response_map.delete(k);
                self.request_to_stream.delete(k);
                self.request_ids.retain(|(id, _)| id != k);
            }
        }
    }
}

/// `writeSSEEvent`: `event: message\ndata: ${JSON.stringify(message)}\n\n`
fn sse_event(message: &JsonValue) -> String {
    format!("event: message\ndata: {}\n\n", json_stringify(message))
}
