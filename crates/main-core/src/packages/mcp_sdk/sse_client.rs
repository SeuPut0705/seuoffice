//! `@modelcontextprotocol/sdk` 1.32.1 `client/sse.js`: the legacy client
//! transport, an event stream to listen on and a POST endpoint the server
//! names in its first `endpoint` event, together with the `EventSource` of the
//! `eventsource` package 3.0.7 it stands on (connect, `Non-200`, content type
//! and body checks, reconnecting after 3 s or the server's `retry`).
//!
//! Driven like [`StreamableHttpTransport`](super::streamable_http_client::StreamableHttpTransport):
//! the requests are [`FetchHost::fetch`], the body of the event stream is a
//! [`Body::Stream`] the host feeds through `on_stream_chunk`, `on_stream_end`
//! and `on_stream_error`, the reconnect timer is [`ClientHost::set_timeout`].
//! `start()` answers [`StartState::Pending`]: the connect settles when the
//! `endpoint` event arrives or the stream fails ([`TransportEvent::Started`]).
//!
//! The SDK replaces the headers `EventSource` builds with its own, so a
//! reconnect sends no `Last-Event-ID`.

use std::collections::VecDeque;

use jscompat::JsonValue;
use url::Url;

use super::client::net::{
    Body, FetchError, FetchInit, FetchResponse, Headers, Redirect, cancel_body,
    fetch_within_origin, read_text, unfollowed_redirect,
};
use super::client::{ClientError, ClientHost, StartState, Transport, TransportEvent};
use super::streamable_http_client::{EventParser, SseEvent, Utf8Stream};
use super::types::schema;

/// `new SseError(code, message, event)`
pub fn sse_error(code: Option<f64>, message: &str) -> ClientError {
    ClientError::Sse {
        code,
        message: format!("SSE error: {message}"),
    }
}

/// `flattenError(err)` of the `eventsource` package
fn flatten_error(error: &FetchError) -> String {
    match &error.cause {
        Some(cause) => format!("{}: {}", error.to_js_string(), flatten_error(cause)),
        None => error.message.clone(),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadyState {
    Connecting,
    Open,
    Closed,
}

/// the `EventSource` of `_startOrAuth`
struct EventSource {
    ready_state: ReadyState,
    reconnect_interval: f64,
    reconnect_timer: Option<u64>,
    parser: EventParser,
    decoder: Utf8Stream,
    /// the body being read
    stream: Option<u64>,
}

/// `SSEClientTransport`
pub struct SseTransport {
    url: String,
    endpoint: Option<String>,
    protocol_version: Option<String>,
    event_source: Option<EventSource>,
    /// `redirect` of `_startOrAuth`: the text for the last response that was not followed
    redirect: Option<String>,
    start_settled: bool,
    /// the outcome of `start()`'s promise, queued after the events of the call that settled it
    deferred_started: Option<Result<(), ClientError>>,
    events: VecDeque<TransportEvent>,
    late_send: bool,
}

impl SseTransport {
    /// `new SSEClientTransport(url, { fetch })`; `url` is `URL.href`
    pub fn new(url: &str) -> SseTransport {
        SseTransport {
            url: url.to_owned(),
            endpoint: None,
            protocol_version: None,
            event_source: None,
            redirect: None,
            start_settled: false,
            deferred_started: None,
            events: VecDeque::new(),
            late_send: false,
        }
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

    /// `resolve()` / `reject(error)` of the promise `_startOrAuth` returns: only the first counts
    fn settle_start(&mut self, outcome: Result<(), ClientError>) {
        if !self.start_settled {
            self.start_settled = true;
            self.deferred_started = Some(outcome);
        }
    }

    /// a continuation of the promise runs after the callbacks that settled it
    fn flush_started(&mut self) {
        if let Some(outcome) = self.deferred_started.take() {
            self.events.push_back(TransportEvent::Started(outcome));
        }
    }

    /// `_commonHeaders()`
    fn common_headers(&self) -> Headers {
        let mut pairs: Vec<(&str, &str)> = Vec::new();
        if let Some(version) = self
            .protocol_version
            .as_deref()
            .filter(|version| !version.is_empty())
        {
            pairs.push(("mcp-protocol-version", version));
        }
        Headers::from_pairs(&pairs)
    }

    /// `this._unfollowedRedirect(response, url)`
    fn unfollowed(&self, response: &FetchResponse, url: &str) -> Option<String> {
        unfollowed_redirect(response, url)
            .map(|text| format!("{text} (redirectPolicy: 'same-origin')"))
    }

    // ---- EventSource ----

    /// `connect_fn`: the fetch of the stream, with the SDK's wrapper
    fn es_connect(&mut self, host: &mut dyn ClientHost) {
        if let Some(es) = self.event_source.as_mut() {
            es.ready_state = ReadyState::Connecting;
            es.stream = None;
        }
        let mut headers = self.common_headers();
        headers.set("Accept", "text/event-stream");
        let init = FetchInit {
            method: None,
            headers: Some(headers),
            body: None,
            redirect: Some(Redirect::Follow),
        };
        let url = self.url.clone();
        match fetch_within_origin(host, &url, &init) {
            Ok(response) => {
                self.redirect = self.unfollowed(&response, &url);
                self.es_on_response(host, response);
            }
            Err(error) => self.es_on_fetch_error(host, &error),
        }
    }

    /// `#onFetchError`
    fn es_on_fetch_error(&mut self, host: &mut dyn ClientHost, error: &FetchError) {
        if let Some(es) = self.event_source.as_mut() {
            es.stream = None;
        }
        if error.name == "AbortError" {
            return;
        }
        self.es_schedule_reconnect(host, Some(flatten_error(error)));
    }

    /// the error handler `_startOrAuth` sets on the `EventSource`
    fn es_error_event(&mut self, code: Option<f64>, message: Option<String>) {
        let shown = self
            .redirect
            .clone()
            .or(message)
            .unwrap_or_else(|| "undefined".to_owned());
        let error = sse_error(code, &shown);
        self.settle_start(Err(error.clone()));
        self.emit_error(error);
    }

    /// `failConnection(message, code)`
    fn es_fail_connection(&mut self, message: &str, code: f64) {
        if let Some(es) = self.event_source.as_mut()
            && es.ready_state != ReadyState::Closed
        {
            es.ready_state = ReadyState::Closed;
        }
        self.es_error_event(Some(code), Some(message.to_owned()));
    }

    /// `scheduleReconnect(message, code)`
    fn es_schedule_reconnect(&mut self, host: &mut dyn ClientHost, message: Option<String>) {
        let Some(es) = self.event_source.as_mut() else {
            return;
        };
        if es.ready_state == ReadyState::Closed {
            return;
        }
        es.ready_state = ReadyState::Connecting;
        let interval = es.reconnect_interval;
        self.es_error_event(None, message);
        let timer = host.set_timeout(interval);
        if let Some(es) = self.event_source.as_mut() {
            es.reconnect_timer = Some(timer);
        }
    }

    /// `EventSource.close()`
    fn es_close(&mut self, host: &mut dyn ClientHost) {
        let Some(es) = self.event_source.as_mut() else {
            return;
        };
        if let Some(timer) = es.reconnect_timer.take() {
            host.clear_timeout(timer);
        }
        if es.ready_state != ReadyState::Closed {
            if let Some(stream) = es.stream.take() {
                host.abort_body(stream);
            }
            es.ready_state = ReadyState::Closed;
        }
    }

    /// `#onFetchResponse(response)`
    fn es_on_response(&mut self, host: &mut dyn ClientHost, response: FetchResponse) {
        if let Some(es) = self.event_source.as_mut() {
            es.parser.reset();
        }
        if response.status == 204 {
            self.es_fail_connection("Server sent HTTP 204, not reconnecting", 204.0);
            self.es_close(host);
            return;
        }
        if response.status != 200 {
            self.es_fail_connection(
                &format!("Non-200 status code ({})", response.status),
                f64::from(response.status),
            );
            return;
        }
        let content_type = response.headers.get("content-type").unwrap_or("");
        if !content_type.starts_with("text/event-stream") {
            self.es_fail_connection(
                "Invalid content type, expected \"text/event-stream\"",
                f64::from(response.status),
            );
            return;
        }
        if self
            .event_source
            .as_ref()
            .is_none_or(|es| es.ready_state == ReadyState::Closed)
        {
            return;
        }
        if let Some(es) = self.event_source.as_mut() {
            es.ready_state = ReadyState::Open;
        }
        match response.body {
            Body::None => {
                self.es_fail_connection(
                    "Invalid response body, expected a web ReadableStream",
                    f64::from(response.status),
                );
                self.es_close(host);
            }
            Body::Stream(stream) => {
                if let Some(es) = self.event_source.as_mut() {
                    es.stream = Some(stream);
                }
            }
            Body::Bytes(bytes) => {
                self.es_feed(host, &bytes);
                if let Some(es) = self.event_source.as_mut() {
                    es.parser.reset();
                }
                self.es_schedule_reconnect(host, None);
            }
        }
    }

    /// the read loop's `parser.feed(decoder.decode(value, { stream: true }))`
    fn es_feed(&mut self, host: &mut dyn ClientHost, bytes: &[u8]) {
        let (events, retries) = match self.event_source.as_mut() {
            Some(es) => {
                let text = es.decoder.decode(bytes, false);
                es.parser.feed(&text);
                (es.parser.take_events(), es.parser.take_retries())
            }
            None => return,
        };
        if let Some(retry) = retries.last().copied()
            && let Some(es) = self.event_source.as_mut()
        {
            es.reconnect_interval = retry;
        }
        for event in events {
            self.es_on_event(host, event);
        }
    }

    /// `#onEvent` and the listeners of `_startOrAuth`
    fn es_on_event(&mut self, host: &mut dyn ClientHost, event: SseEvent) {
        let kind = event.event.clone().unwrap_or_else(|| "message".to_owned());
        match kind.as_str() {
            "endpoint" => self.on_endpoint(host, &event.data),
            "message" => self.on_message_event(&event.data),
            _ => {}
        }
    }

    /// the `endpoint` listener
    fn on_endpoint(&mut self, host: &mut dyn ClientHost, data: &str) {
        let resolved = Url::parse(&self.url)
            .ok()
            .and_then(|base| base.join(data).ok());
        let failure = match resolved {
            None => Some(ClientError::Error {
                name: "TypeError".to_owned(),
                message: "Invalid URL".to_owned(),
            }),
            Some(endpoint) => {
                let origin = endpoint.origin().ascii_serialization();
                let own = Url::parse(&self.url)
                    .map(|url| url.origin().ascii_serialization())
                    .unwrap_or_default();
                self.endpoint = Some(endpoint.as_str().to_owned());
                if origin != own {
                    Some(ClientError::plain(&format!(
                        "Endpoint origin does not match connection origin: {origin}"
                    )))
                } else {
                    None
                }
            }
        };
        match failure {
            Some(error) => {
                self.settle_start(Err(error.clone()));
                self.emit_error(error);
                self.close(host);
            }
            None => self.settle_start(Ok(())),
        }
    }

    /// `onmessage` of the `EventSource`
    fn on_message_event(&mut self, data: &str) {
        let parsed = jscompat::json_parse(data)
            .map_err(|error| ClientError::Syntax(error.message().to_owned()))
            .and_then(|value| {
                schema::safe_parse(&schema::jsonrpc_message(), &value).map_err(ClientError::Zod)
            });
        match parsed {
            Ok(message) => self.events.push_back(TransportEvent::Message(message)),
            Err(error) => self.emit_error(error),
        }
    }

    fn post(&mut self, host: &mut dyn ClientHost, message: &JsonValue) -> Result<(), ClientError> {
        let endpoint = self.endpoint.clone().unwrap_or_default();
        let mut headers = self.common_headers();
        headers.set("content-type", "application/json");
        let init = FetchInit {
            method: Some("POST".to_owned()),
            headers: Some(headers),
            body: Some(jscompat::json_stringify(message)),
            redirect: None,
        };
        let response = fetch_within_origin(host, &endpoint, &init).map_err(ClientError::Fetch)?;
        if !response.ok() {
            let text = read_text(host, &response.body).ok();
            let detail = self
                .unfollowed(&response, &endpoint)
                .unwrap_or_else(|| text.unwrap_or_else(|| "null".to_owned()));
            return Err(ClientError::plain(&format!(
                "Error POSTing to endpoint (HTTP {}): {detail}",
                response.status
            )));
        }
        cancel_body(host, &response.body);
        Ok(())
    }
}

impl Transport for SseTransport {
    fn start(&mut self, host: &mut dyn ClientHost) -> Result<StartState, ClientError> {
        if self.event_source.is_some() {
            return Err(ClientError::plain(
                "SSEClientTransport already started! If using Client class, note that connect() calls start() automatically.",
            ));
        }
        self.event_source = Some(EventSource {
            ready_state: ReadyState::Connecting,
            reconnect_interval: 3000.0,
            reconnect_timer: None,
            parser: EventParser::new(),
            decoder: Utf8Stream::new(),
            stream: None,
        });
        self.es_connect(host);
        self.flush_started();
        Ok(StartState::Pending)
    }

    fn send(&mut self, host: &mut dyn ClientHost, message: &JsonValue) -> Result<(), ClientError> {
        if self.endpoint.is_none() {
            return Err(ClientError::plain("Not connected"));
        }
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
        self.es_close(host);
        self.events.push_back(TransportEvent::Closed);
        self.flush_started();
    }

    fn session_id(&self) -> Option<String> {
        None
    }

    fn set_protocol_version(&mut self, version: &str) {
        self.protocol_version = Some(version.to_owned());
    }

    fn pop_event(&mut self) -> Option<TransportEvent> {
        self.events.pop_front()
    }

    fn on_timeout(&mut self, host: &mut dyn ClientHost, timer: u64) -> bool {
        let owned = self
            .event_source
            .as_ref()
            .is_some_and(|es| es.reconnect_timer == Some(timer));
        if !owned {
            return false;
        }
        let mut connecting = false;
        if let Some(es) = self.event_source.as_mut() {
            es.reconnect_timer = None;
            connecting = es.ready_state == ReadyState::Connecting;
        }
        if connecting {
            self.es_connect(host);
        }
        self.flush_started();
        true
    }

    fn on_stream_chunk(&mut self, host: &mut dyn ClientHost, stream: u64, bytes: &[u8]) {
        if self.event_source.as_ref().and_then(|es| es.stream) != Some(stream) {
            return;
        }
        self.es_feed(host, bytes);
        self.flush_started();
    }

    fn on_stream_end(&mut self, host: &mut dyn ClientHost, stream: u64) {
        if self.event_source.as_ref().and_then(|es| es.stream) != Some(stream) {
            return;
        }
        if let Some(es) = self.event_source.as_mut() {
            es.parser.reset();
        }
        self.es_schedule_reconnect(host, None);
        self.flush_started();
    }

    fn on_stream_error(&mut self, host: &mut dyn ClientHost, stream: u64, error: &FetchError) {
        if self.event_source.as_ref().and_then(|es| es.stream) != Some(stream) {
            return;
        }
        self.es_on_fetch_error(host, error);
        self.flush_started();
    }
}
