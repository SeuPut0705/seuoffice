//! `@modelcontextprotocol/sdk` 1.32.1 `client/streamableHttp.js` (the client
//! transport of MCP over HTTP: POST to send, SSE or JSON to answer, an
//! optional GET stream for the server's own messages), with
//! `eventsource-parser`'s parser and the `TextDecoderStream` in front of it.
//!
//! The transport owns no socket: every request is [`FetchHost::fetch`], a
//! plain call that answers once the headers are in, and the body of an SSE
//! answer is a [`Body::Stream`] the host feeds back through
//! [`Transport::on_stream_chunk`], `on_stream_end` and `on_stream_error`
//! (through [`Client`](super::client::Client), which forwards them). A body
//! the host has already read whole ([`Body::Bytes`]) is parsed at once. A
//! reconnect timer is [`ClientHost::set_timeout`]; its firing is
//! [`Transport::on_timeout`]. What the TypeScript reports through its
//! `onmessage`, `onerror` and `onclose` callbacks is queued as
//! [`TransportEvent`]s in the order it happens.
//!
//! The options `remote.ts` passes are `fetch` only; the auth provider, the
//! request init, the redirect policy, the reconnection options and the
//! session id of the constructor are not here, and neither is resumption by
//! `send(message, { resumptionToken })`.

use std::collections::VecDeque;

use jscompat::{JsonValue, Radix, json_parse, math_pow, parse_int};

use super::client::net::{
    Body, FetchError, FetchInit, FetchResponse, Headers, Redirect, cancel_body,
    fetch_within_origin, follow_within_origin, media_type_essence, read_json, read_text,
    unfollowed_redirect,
};
use super::client::{ClientError, ClientHost, StartState, Transport, TransportEvent};
use super::types::schema;

/// `new StreamableHTTPError(code, message)`
pub fn streamable_http_error(code: f64, message: &str) -> ClientError {
    ClientError::StreamableHttp {
        code,
        message: format!("Streamable HTTP error: {message}"),
    }
}

/// An event of an SSE stream as `eventsource-parser` gives it.
#[derive(Debug, Clone, PartialEq)]
pub struct SseEvent {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

/// `createParser({ onEvent, onRetry })` of `eventsource-parser` 3.1.1: feed
/// it text, take the events and `retry` values it found.
#[derive(Debug)]
pub struct EventParser {
    pending: Vec<String>,
    first_chunk: bool,
    id: Option<String>,
    data: String,
    data_lines: usize,
    event_type: Option<String>,
    events: Vec<SseEvent>,
    retries: Vec<f64>,
}

impl Default for EventParser {
    fn default() -> Self {
        EventParser::new()
    }
}

fn nonempty(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.to_owned())
    }
}

/// `value` after a field name's colon: one leading space is dropped
fn field_value(rest: &str) -> &str {
    rest.strip_prefix(' ').unwrap_or(rest)
}

impl EventParser {
    pub fn new() -> EventParser {
        EventParser {
            pending: Vec::new(),
            first_chunk: true,
            id: None,
            data: String::new(),
            data_lines: 0,
            event_type: None,
            events: Vec::new(),
            retries: Vec::new(),
        }
    }

    /// `parser.feed(chunk)`
    pub fn feed(&mut self, chunk: &str) {
        let mut chunk = chunk;
        if self.first_chunk {
            self.first_chunk = false;
            // the three code units 0xEF 0xBB 0xBF: the BOM's bytes read as characters
            if let Some(rest) = chunk.strip_prefix("\u{ef}\u{bb}\u{bf}") {
                chunk = rest;
            }
        }
        if self.pending.is_empty() {
            let trailing = self.process_lines(chunk);
            if !trailing.is_empty() {
                self.pending.push(trailing);
            }
            return;
        }
        if !chunk.contains('\n') && !chunk.contains('\r') {
            self.pending.push(chunk.to_owned());
            return;
        }
        self.pending.push(chunk.to_owned());
        let input = self.pending.concat();
        self.pending.clear();
        let trailing = self.process_lines(&input);
        if !trailing.is_empty() {
            self.pending.push(trailing);
        }
    }

    /// `parser.reset()`
    pub fn reset(&mut self) {
        self.first_chunk = true;
        self.id = None;
        self.data.clear();
        self.data_lines = 0;
        self.event_type = None;
        self.pending.clear();
    }

    /// the events found since the last call
    pub fn take_events(&mut self) -> Vec<SseEvent> {
        std::mem::take(&mut self.events)
    }

    /// the `retry` values found since the last call, in order
    pub fn take_retries(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.retries)
    }

    fn process_lines(&mut self, chunk: &str) -> String {
        let bytes = chunk.as_bytes();
        let mut search = 0usize;
        while search < bytes.len() {
            let cr = bytes[search..]
                .iter()
                .position(|b| *b == b'\r')
                .map(|i| i + search);
            let lf = bytes[search..]
                .iter()
                .position(|b| *b == b'\n')
                .map(|i| i + search);
            let line_end = match (cr, lf) {
                (Some(c), Some(l)) => Some(c.min(l)),
                (Some(c), None) => {
                    if c == bytes.len() - 1 {
                        None
                    } else {
                        Some(c)
                    }
                }
                (None, Some(l)) => Some(l),
                (None, None) => None,
            };
            let Some(end) = line_end else {
                break;
            };
            self.parse_line(chunk, search, end);
            search = end + 1;
            if bytes[search - 1] == b'\r' && bytes.get(search) == Some(&b'\n') {
                search += 1;
            }
        }
        chunk[search..].to_owned()
    }

    fn parse_line(&mut self, chunk: &str, start: usize, end: usize) {
        if start == end {
            self.dispatch();
            return;
        }
        let line = &chunk[start..end];
        if let Some(rest) = line.strip_prefix("data:") {
            self.add_data(field_value(rest));
            return;
        }
        if let Some(rest) = line.strip_prefix("event:") {
            self.event_type = nonempty(field_value(rest));
            return;
        }
        if let Some(rest) = line.strip_prefix("id:") {
            let value = field_value(rest);
            if !value.contains('\0') {
                self.id = Some(value.to_owned());
            }
            return;
        }
        if line.starts_with(':') {
            return;
        }
        match line.find(':') {
            None => self.process_field(line, ""),
            Some(index) => {
                let field = &line[..index];
                let value = field_value(&line[index + 1..]);
                self.process_field(field, value);
            }
        }
    }

    fn add_data(&mut self, value: &str) {
        if self.data_lines == 0 {
            self.data = value.to_owned();
        } else {
            self.data.push('\n');
            self.data.push_str(value);
        }
        self.data_lines += 1;
    }

    fn process_field(&mut self, field: &str, value: &str) {
        match field {
            "event" => self.event_type = nonempty(value),
            "data" => self.add_data(value),
            "id" if !value.contains('\0') => self.id = Some(value.to_owned()),
            "retry" if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) => {
                self.retries.push(parse_int(value, Radix::Ten));
            }
            _ => {}
        }
    }

    fn dispatch(&mut self) {
        if self.data_lines > 0 {
            self.events.push(SseEvent {
                id: self.id.clone(),
                event: self.event_type.clone(),
                data: self.data.clone(),
            });
        }
        self.id = None;
        self.data.clear();
        self.data_lines = 0;
        self.event_type = None;
    }
}

/// `TextDecoderStream` / `new TextDecoder().decode(chunk, { stream })`: UTF-8,
/// a byte order mark at the start dropped, a sequence cut between chunks
/// finished by the next one
pub struct Utf8Stream {
    decoder: encoding_rs::Decoder,
}

impl Default for Utf8Stream {
    fn default() -> Self {
        Utf8Stream::new()
    }
}

impl Utf8Stream {
    pub fn new() -> Utf8Stream {
        Utf8Stream {
            decoder: encoding_rs::UTF_8.new_decoder(),
        }
    }

    /// the text of `bytes`; `last` is the end of the stream (`stream: false`)
    pub fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        let mut out = String::with_capacity(bytes.len() + 8);
        let mut input = bytes;
        loop {
            let (result, read, _) = self.decoder.decode_to_string(input, &mut out, last);
            input = &input[read..];
            match result {
                encoding_rs::CoderResult::InputEmpty => break,
                encoding_rs::CoderResult::OutputFull => out.reserve(input.len() * 3 + 16),
            }
        }
        out
    }
}

/// what `_handleSseStream` and `_startOrAuthSse` carry from one stream to its reconnection
#[derive(Debug, Clone, Default, PartialEq)]
struct SseOptions {
    resumption_token: Option<String>,
    replay_message_id: Option<JsonValue>,
}

struct Stream {
    id: u64,
    options: SseOptions,
    reconnectable: bool,
    last_event_id: Option<String>,
    has_priming_event: bool,
    received_response: bool,
    parser: EventParser,
    decoder: Utf8Stream,
    /// the end or an error came: nothing more is read
    over: bool,
}

struct Reconnection {
    timer: u64,
    options: SseOptions,
    attempt: u32,
}

const INITIAL_RECONNECTION_DELAY: f64 = 1000.0;
const MAX_RECONNECTION_DELAY: f64 = 30000.0;
const RECONNECTION_DELAY_GROW_FACTOR: f64 = 1.5;
const MAX_RETRIES: u32 = 2;

/// `StreamableHTTPClientTransport`
pub struct StreamableHttpTransport {
    url: String,
    session_id: Option<String>,
    protocol_version: Option<String>,
    /// `this._abortController !== undefined`
    started: bool,
    /// `this._abortController.signal.aborted`
    aborted: bool,
    server_retry_ms: Option<f64>,
    reconnection_timeout: Option<u64>,
    reconnections: Vec<Reconnection>,
    streams: Vec<Stream>,
    synthetic_streams: u64,
    events: VecDeque<TransportEvent>,
    late_send: bool,
}

impl StreamableHttpTransport {
    /// `new StreamableHTTPClientTransport(url, { fetch })`; `url` is `URL.href`
    pub fn new(url: &str) -> StreamableHttpTransport {
        StreamableHttpTransport {
            url: url.to_owned(),
            session_id: None,
            protocol_version: None,
            started: false,
            aborted: false,
            server_retry_ms: None,
            reconnection_timeout: None,
            reconnections: Vec::new(),
            streams: Vec::new(),
            synthetic_streams: 0,
            events: VecDeque::new(),
            late_send: false,
        }
    }

    /// `transport.protocolVersion`
    pub fn protocol_version(&self) -> Option<&str> {
        self.protocol_version.as_deref()
    }

    /// whether the `fetch` the transport is given reaches the network a few
    /// ticks after the transport calls it (an async wrapper): a send then
    /// lands after the synchronous work that follows it. The default is a
    /// `fetch` that logs at once.
    pub fn set_late_send(&mut self, late: bool) {
        self.late_send = late;
    }

    fn emit_error(&mut self, error: ClientError) {
        self.events.push_back(TransportEvent::Error(error));
    }

    /// `_commonHeaders()`
    fn common_headers(&self) -> Headers {
        let mut pairs: Vec<(&str, &str)> = Vec::new();
        if let Some(id) = self.session_id.as_deref().filter(|id| !id.is_empty()) {
            pairs.push(("mcp-session-id", id));
        }
        if let Some(version) = self
            .protocol_version
            .as_deref()
            .filter(|version| !version.is_empty())
        {
            pairs.push(("mcp-protocol-version", version));
        }
        Headers::from_pairs(&pairs)
    }

    /// `this._unfollowedRedirect(response, this._url)`
    fn unfollowed(&self, response: &FetchResponse) -> Option<String> {
        unfollowed_redirect(response, &self.url)
            .map(|text| format!("{text} (redirectPolicy: 'same-origin')"))
    }

    /// `_startOrAuthSse(options)`
    fn start_or_auth_sse(
        &mut self,
        host: &mut dyn ClientHost,
        options: SseOptions,
    ) -> Result<(), ClientError> {
        match self.open_sse(host, options) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.emit_error(error.clone());
                Err(error)
            }
        }
    }

    fn open_sse(
        &mut self,
        host: &mut dyn ClientHost,
        options: SseOptions,
    ) -> Result<(), ClientError> {
        let mut headers = self.common_headers();
        headers.set("Accept", "text/event-stream");
        if let Some(token) = options
            .resumption_token
            .as_deref()
            .filter(|t| !t.is_empty())
        {
            headers.set("last-event-id", token);
        }
        let init = FetchInit {
            method: Some("GET".to_owned()),
            headers: Some(headers),
            body: None,
            redirect: None,
        };
        let mut manual = init.clone();
        manual.redirect = Some(Redirect::Manual);
        let url = self.url.clone();
        let first = host.fetch(&url, &manual).map_err(ClientError::Fetch)?;
        let response =
            follow_within_origin(host, &url, &init, first, 0).map_err(ClientError::Fetch)?;
        if !response.ok() {
            cancel_body(host, &response.body);
            if response.status == 405 {
                return Ok(());
            }
            let detail = self
                .unfollowed(&response)
                .unwrap_or_else(|| response.status_text.clone());
            return Err(streamable_http_error(
                f64::from(response.status),
                &format!("Failed to open SSE stream: {detail}"),
            ));
        }
        self.handle_sse_stream(host, response.body, options, true);
        Ok(())
    }

    /// `_getNextReconnectionDelay(attempt)`
    fn next_reconnection_delay(&self, attempt: u32) -> f64 {
        if let Some(retry) = self.server_retry_ms {
            return retry;
        }
        let grown = INITIAL_RECONNECTION_DELAY
            * math_pow(RECONNECTION_DELAY_GROW_FACTOR, f64::from(attempt));
        grown.min(MAX_RECONNECTION_DELAY)
    }

    /// `_scheduleReconnection(options, attemptCount)`
    fn schedule_reconnection(
        &mut self,
        host: &mut dyn ClientHost,
        options: SseOptions,
        attempt: u32,
    ) {
        if attempt >= MAX_RETRIES {
            self.emit_error(ClientError::plain(&format!(
                "Maximum reconnection attempts ({MAX_RETRIES}) exceeded."
            )));
            return;
        }
        let delay = self.next_reconnection_delay(attempt);
        let timer = host.set_timeout(delay);
        self.reconnection_timeout = Some(timer);
        self.reconnections.push(Reconnection {
            timer,
            options,
            attempt,
        });
    }

    /// `_handleSseStream(stream, options, isReconnectable)`
    fn handle_sse_stream(
        &mut self,
        host: &mut dyn ClientHost,
        body: Body,
        options: SseOptions,
        reconnectable: bool,
    ) {
        let (id, whole) = match body {
            Body::None => return,
            Body::Stream(id) => (id, None),
            Body::Bytes(bytes) => {
                self.synthetic_streams += 1;
                ((1u64 << 63) | self.synthetic_streams, Some(bytes))
            }
        };
        self.streams.push(Stream {
            id,
            options,
            reconnectable,
            last_event_id: None,
            has_priming_event: false,
            received_response: false,
            parser: EventParser::new(),
            decoder: Utf8Stream::new(),
            over: false,
        });
        if let Some(bytes) = whole {
            self.on_stream_chunk(host, id, &bytes);
            self.on_stream_end(host, id);
        }
    }

    fn stream_index(&self, id: u64) -> Option<usize> {
        self.streams
            .iter()
            .position(|stream| stream.id == id && !stream.over)
    }

    /// the events the parser found, handled as the read loop of `processStream` handles them
    fn process_events(&mut self, id: u64) {
        let Some(index) = self.stream_index(id) else {
            return;
        };
        for retry in self.streams[index].parser.take_retries() {
            self.server_retry_ms = Some(retry);
        }
        for event in self.streams[index].parser.take_events() {
            if let Some(event_id) = event.id.as_deref().filter(|e| !e.is_empty()) {
                self.streams[index].last_event_id = Some(event_id.to_owned());
                self.streams[index].has_priming_event = true;
            }
            if event.data.is_empty() {
                continue;
            }
            if event
                .event
                .as_deref()
                .is_none_or(|e| e.is_empty() || e == "message")
            {
                match parse_message(&event.data) {
                    Ok(mut message) => {
                        if schema::is_jsonrpc_result_response(&message) {
                            self.streams[index].received_response = true;
                            if let Some(replay) =
                                self.streams[index].options.replay_message_id.clone()
                                && let JsonValue::Object(object) = &mut message
                            {
                                object.set("id", replay);
                            }
                        }
                        self.events.push_back(TransportEvent::Message(message));
                    }
                    Err(error) => self.emit_error(error),
                }
            }
        }
    }

    /// what follows a stream that ended or failed
    fn after_stream(&mut self, host: &mut dyn ClientHost, id: u64) {
        let Some(index) = self.streams.iter().position(|stream| stream.id == id) else {
            return;
        };
        let stream = &self.streams[index];
        let can_resume = stream.reconnectable || stream.has_priming_event;
        let needs_reconnect = can_resume && !stream.received_response;
        let options = SseOptions {
            resumption_token: stream.last_event_id.clone(),
            replay_message_id: stream.options.replay_message_id.clone(),
        };
        if needs_reconnect && self.started && !self.aborted {
            self.schedule_reconnection(host, options, 0);
        }
    }

    /// `send(message)`
    fn post(&mut self, host: &mut dyn ClientHost, message: &JsonValue) -> Result<(), ClientError> {
        let mut headers = self.common_headers();
        headers.set("content-type", "application/json");
        headers.set("accept", "application/json, text/event-stream");
        let init = FetchInit {
            method: Some("POST".to_owned()),
            headers: Some(headers),
            body: Some(jscompat::json_stringify(message)),
            redirect: None,
        };
        let url = self.url.clone();
        let response = fetch_within_origin(host, &url, &init).map_err(ClientError::Fetch)?;
        if let Some(session) = response
            .headers
            .get("mcp-session-id")
            .filter(|s| !s.is_empty())
        {
            self.session_id = Some(session.to_owned());
        }
        if !response.ok() {
            let text = read_text(host, &response.body).ok();
            let detail = self
                .unfollowed(&response)
                .unwrap_or_else(|| text.unwrap_or_else(|| "null".to_owned()));
            return Err(streamable_http_error(
                f64::from(response.status),
                &format!("Error POSTing to endpoint: {detail}"),
            ));
        }
        if response.status == 202 {
            cancel_body(host, &response.body);
            if schema::is_initialized_notification(message) {
                // not awaited: its failure is reported by onerror, twice
                if let Err(error) = self.start_or_auth_sse(host, SseOptions::default()) {
                    self.emit_error(error);
                }
            }
            return Ok(());
        }
        let has_requests = message.get("method").is_some() && message.get("id").is_some();
        let content_type = response.headers.get("content-type").map(str::to_owned);
        let media_type = media_type_essence(content_type.as_deref());
        if !has_requests {
            cancel_body(host, &response.body);
            return Ok(());
        }
        match media_type.as_deref() {
            Some("text/event-stream") => {
                self.handle_sse_stream(host, response.body, SseOptions::default(), false);
                Ok(())
            }
            Some("application/json") => {
                let data = read_json(host, &response.body).map_err(ClientError::from)?;
                let mut parsed: Vec<JsonValue> = Vec::new();
                match &data {
                    JsonValue::Array(items) => {
                        for item in items {
                            parsed.push(parse_message_value(item)?);
                        }
                    }
                    other => parsed.push(parse_message_value(other)?),
                }
                for message in parsed {
                    self.events.push_back(TransportEvent::Message(message));
                }
                Ok(())
            }
            _ => {
                cancel_body(host, &response.body);
                Err(streamable_http_error(
                    -1.0,
                    &format!(
                        "Unexpected content type: {}",
                        content_type.as_deref().unwrap_or("null")
                    ),
                ))
            }
        }
    }

    /// `terminateSession()`: `Ok` also when there is no session to end
    pub fn terminate(&mut self, host: &mut dyn ClientHost) -> Result<(), ClientError> {
        if self.session_id.is_none() {
            return Ok(());
        }
        let result = self.delete_session(host);
        if let Err(error) = &result {
            self.emit_error(error.clone());
        }
        result
    }

    fn delete_session(&mut self, host: &mut dyn ClientHost) -> Result<(), ClientError> {
        let init = FetchInit {
            method: Some("DELETE".to_owned()),
            headers: Some(self.common_headers()),
            body: None,
            redirect: None,
        };
        let url = self.url.clone();
        let response = fetch_within_origin(host, &url, &init).map_err(ClientError::Fetch)?;
        cancel_body(host, &response.body);
        if !response.ok() && response.status != 405 {
            let detail = self
                .unfollowed(&response)
                .unwrap_or_else(|| response.status_text.clone());
            return Err(streamable_http_error(
                f64::from(response.status),
                &format!("Failed to terminate session: {detail}"),
            ));
        }
        self.session_id = None;
        Ok(())
    }
}

/// `JSONRPCMessageSchema.parse(JSON.parse(data))`
fn parse_message(data: &str) -> Result<JsonValue, ClientError> {
    let value =
        json_parse(data).map_err(|error| ClientError::Syntax(error.message().to_owned()))?;
    parse_message_value(&value)
}

/// `JSONRPCMessageSchema.parse(value)`
fn parse_message_value(value: &JsonValue) -> Result<JsonValue, ClientError> {
    schema::safe_parse(&schema::jsonrpc_message(), value).map_err(ClientError::Zod)
}

impl Transport for StreamableHttpTransport {
    fn start(&mut self, _host: &mut dyn ClientHost) -> Result<StartState, ClientError> {
        if self.started {
            return Err(ClientError::plain(
                "StreamableHTTPClientTransport already started! If using Client class, note that connect() calls start() automatically.",
            ));
        }
        self.started = true;
        Ok(StartState::Ready)
    }

    fn send(&mut self, host: &mut dyn ClientHost, message: &JsonValue) -> Result<(), ClientError> {
        match self.post(host, message) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.emit_error(error.clone());
                Err(error)
            }
        }
    }

    fn defers_send(&self) -> bool {
        self.late_send
    }

    fn close(&mut self, host: &mut dyn ClientHost) {
        if let Some(timer) = self.reconnection_timeout.take() {
            host.clear_timeout(timer);
        }
        if self.started {
            self.aborted = true;
        }
        let open: Vec<u64> = self
            .streams
            .iter()
            .filter(|stream| !stream.over)
            .map(|stream| stream.id)
            .collect();
        for id in &open {
            if *id >> 63 == 0 {
                host.abort_body(*id);
            }
        }
        self.events.push_back(TransportEvent::Closed);
        if self.started {
            for id in open {
                if let Some(stream) = self.streams.iter_mut().find(|s| s.id == id) {
                    stream.over = true;
                }
                self.events
                    .push_back(TransportEvent::LateError(ClientError::plain(
                        "SSE stream disconnected: AbortError: This operation was aborted",
                    )));
            }
        }
    }

    fn session_id(&self) -> Option<String> {
        self.session_id.clone().filter(|id| !id.is_empty())
    }

    fn set_protocol_version(&mut self, version: &str) {
        self.protocol_version = Some(version.to_owned());
    }

    fn pop_event(&mut self) -> Option<TransportEvent> {
        self.events.pop_front()
    }

    fn on_timeout(&mut self, host: &mut dyn ClientHost, timer: u64) -> bool {
        let Some(index) = self.reconnections.iter().position(|r| r.timer == timer) else {
            return false;
        };
        let Reconnection {
            options, attempt, ..
        } = self.reconnections.remove(index);
        if let Err(error) = self.start_or_auth_sse(host, options.clone()) {
            self.emit_error(ClientError::plain(&format!(
                "Failed to reconnect SSE stream: {}",
                error.message()
            )));
            self.schedule_reconnection(host, options, attempt + 1);
        }
        true
    }

    fn on_stream_chunk(&mut self, _host: &mut dyn ClientHost, stream: u64, bytes: &[u8]) {
        let Some(index) = self.stream_index(stream) else {
            return;
        };
        let state = &mut self.streams[index];
        let text = state.decoder.decode(bytes, false);
        state.parser.feed(&text);
        self.process_events(stream);
    }

    fn on_stream_end(&mut self, host: &mut dyn ClientHost, stream: u64) {
        let Some(index) = self.stream_index(stream) else {
            return;
        };
        let state = &mut self.streams[index];
        let rest = state.decoder.decode(&[], true);
        if !rest.is_empty() {
            state.parser.feed(&rest);
            self.process_events(stream);
        }
        if let Some(index) = self.streams.iter().position(|s| s.id == stream) {
            self.streams[index].over = true;
        }
        self.after_stream(host, stream);
    }

    fn on_stream_error(&mut self, host: &mut dyn ClientHost, stream: u64, error: &FetchError) {
        let Some(index) = self.stream_index(stream) else {
            return;
        };
        self.streams[index].over = true;
        self.emit_error(ClientError::plain(&format!(
            "SSE stream disconnected: {}",
            error.to_js_string()
        )));
        self.after_stream(host, stream);
    }

    fn terminate_session(&mut self, host: &mut dyn ClientHost) -> Option<Result<(), ClientError>> {
        Some(self.terminate(host))
    }
}
