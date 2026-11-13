//! `@modelcontextprotocol/sdk` 1.32.1 `server/sse.js` (`SSEServerTransport`,
//! the legacy transport: an SSE stream the server writes to, and POSTs the
//! client sends to the endpoint the first event names), without I/O.
//!
//! The commands are those of [`super::streamable_http_server`]: `Respond`,
//! `Write`, `End`. The SSE response is held by the shell; a client that goes
//! away is `on_response_closed`. The shell reads the POST body before the
//! transport sees it (`parsedBody`); what is left of the stream is empty, so
//! `getRawBody` always answers that the stream is not readable.
//!
//! Left out: the DNS-rebinding options (the shell sets none).

use jscompat::{JsonValue, json_parse, json_stringify, json_value_to_serde, value_to_string};
use url::Url;

use super::server::{
    Command, Io, MessageExtra, Outgoing, ResponseId, SessionServer, in_send_order,
};
use super::streamable_http_server::{HttpRequest, content_type_parse};
use super::types::schema;

/// `SSEServerTransport`
pub struct SseServerTransport {
    io: Io,
    endpoint: String,
    res: ResponseId,
    session_id: String,
    sse_response: Option<ResponseId>,
    /// `onclose` was called and the caller has not been told
    close_pending: bool,
}

impl SseServerTransport {
    /// `new SSEServerTransport(endpoint, res)`: `randomUUID()` is the session id
    pub fn new(io: Io, endpoint: &str, res: ResponseId) -> Self {
        let session_id = io.random_uuid();
        SseServerTransport {
            io,
            endpoint: endpoint.to_owned(),
            res,
            session_id,
            sse_response: None,
            close_pending: false,
        }
    }

    /// `sessionId`
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// whether `onclose` ran since the last call
    pub fn take_closed(&mut self) -> bool {
        std::mem::take(&mut self.close_pending)
    }

    /// `start()`: `writeHead(200, ...)` over the headers already set on the
    /// response (`pre_set`, in the order they were set), then the endpoint
    /// event
    pub fn start(&mut self, pre_set: Vec<(String, String)>) -> Result<(), String> {
        if self.sse_response.is_some() {
            return Err("SSEServerTransport already started! If using Server class, note that connect() calls start() automatically.".to_owned());
        }
        let mut headers = pre_set;
        for (name, value) in [
            ("content-type", "text/event-stream"),
            ("cache-control", "no-cache, no-transform"),
            ("connection", "keep-alive"),
        ] {
            match headers.iter_mut().find(|(key, _)| key == name) {
                Some(slot) => slot.1 = value.to_owned(),
                None => headers.push((name.to_owned(), value.to_owned())),
            }
        }
        self.io.push(Command::Respond {
            res: self.res,
            status: 200,
            headers,
        });
        // a dummy base: the endpoint is relative
        let mut endpoint = Url::parse("http://localhost")
            .and_then(|base| base.join(&self.endpoint))
            .map_err(|_| "Invalid URL".to_owned())?;
        endpoint
            .query_pairs_mut()
            .clear()
            .append_pair("sessionId", &self.session_id);
        let mut relative = endpoint.path().to_owned();
        if let Some(query) = endpoint.query() {
            relative.push('?');
            relative.push_str(query);
        }
        if let Some(fragment) = endpoint.fragment() {
            relative.push('#');
            relative.push_str(fragment);
        }
        self.io.push(Command::Write {
            res: self.res,
            chunk: format!("event: endpoint\ndata: {relative}\n\n"),
        });
        self.sse_response = Some(self.res);
        Ok(())
    }

    /// `res.on('close')` of the SSE response
    pub fn on_response_closed(&mut self) {
        self.sse_response = None;
        self.close_pending = true;
    }

    /// `close()`
    pub fn close(&mut self) {
        if let Some(res) = self.sse_response.take() {
            self.io.push(Command::End { res, chunk: None });
        }
        self.close_pending = true;
    }

    /// the answers of requests that were settled later
    pub fn send_outgoing(&self, outgoing: Vec<Outgoing>) {
        for sent in in_send_order(outgoing) {
            self.send(&sent.message);
        }
    }

    /// `send(message)`
    fn send(&self, message: &JsonValue) {
        if let Some(res) = self.sse_response {
            self.io.push(Command::Write {
                res,
                chunk: format!("event: message\ndata: {}\n\n", json_stringify(message)),
            });
        }
    }

    fn reply(&self, res: ResponseId, status: u16, body: &str) {
        self.io.push(Command::Respond {
            res,
            status,
            headers: Vec::new(),
        });
        self.io.push(Command::End {
            res,
            chunk: Some(body.to_owned()),
        });
    }

    /// `handlePostMessage(req, res, parsedBody)`: `Err` is the message of
    /// the `Error` it throws after it answered
    pub fn handle_post_message(
        &mut self,
        res: ResponseId,
        req: &HttpRequest,
        parsed_body: Option<&JsonValue>,
        server: &mut dyn SessionServer,
    ) -> Result<(), String> {
        if self.sse_response.is_none() {
            let message = "SSE connection not established";
            self.reply(res, 500, message);
            return Err(message.to_owned());
        }
        // `contentType.parse(req.headers['content-type'] ?? '')`, then `parsedBody ??
        // await getRawBody(req, ...)`
        let body: Result<JsonValue, String> =
            match content_type_parse(req.header("content-type").unwrap_or("")) {
                Err(message) => Err(format!("TypeError: {message}")),
                Ok(media_type) if media_type != "application/json" => {
                    Err(format!("Error: Unsupported content-type: {media_type}"))
                }
                Ok(_) => match parsed_body {
                    Some(body) if !matches!(body, JsonValue::Null) => Ok(body.clone()),
                    _ => Err("InternalServerError: stream is not readable".to_owned()),
                },
            };
        let body = match body {
            Ok(body) => body,
            Err(text) => {
                self.reply(res, 400, &text);
                return Ok(());
            }
        };
        match self.handle_message(&body, server) {
            Ok(outgoing) => {
                let (now, later): (Vec<Outgoing>, Vec<Outgoing>) = in_send_order(outgoing)
                    .into_iter()
                    .partition(|sent| sent.ticks == 0);
                for sent in now {
                    self.send(&sent.message);
                }
                self.reply(res, 202, "Accepted");
                for sent in later {
                    self.send(&sent.message);
                }
            }
            Err(()) => {
                let shown = value_to_string(Some(&json_value_to_serde(&body)));
                self.reply(res, 400, &format!("Invalid message: {shown}"));
            }
        }
        Ok(())
    }

    /// `handleMessage(typeof body === 'string' ? JSON.parse(body) : body)`:
    /// `Err` is a throw (bad JSON, not a JSON-RPC message)
    fn handle_message(
        &self,
        body: &JsonValue,
        server: &mut dyn SessionServer,
    ) -> Result<Vec<Outgoing>, ()> {
        let message = match body {
            JsonValue::String(text) => json_parse(text).map_err(|_| ())?,
            other => other.clone(),
        };
        let parsed = schema::safe_parse(&schema::jsonrpc_message(), &message).map_err(|_| ())?;
        let extra = MessageExtra {
            session_id: Some(self.session_id.clone()),
        };
        Ok(server.on_message(&parsed, &extra))
    }
}
