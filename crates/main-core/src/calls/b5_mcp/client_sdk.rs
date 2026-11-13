//! Group `b5-mcp`, slice `client_sdk`: see tools/main-diff/groups/b5-mcp/client-sdk.ts.
//!
//! The names are `mcp-sdk/<file>.<export>`. The scenarios drive the state
//! machines of `packages/mcp_sdk` with the same script the TypeScript runs
//! the real SDK classes with: [`World`] is the host. It answers `fetch` from
//! the case's scripted answers, numbers timers and streams as the TypeScript
//! fakes do, and writes each call it is asked for and each event it is told
//! of in the step they happen in.

use std::collections::{HashMap, VecDeque};

use jscompat::{JsObject, JsonValue, json_stringify, json_value_from_serde, json_value_to_serde};
use serde_json::{Map, Value, json};

use super::super::{Answer, CallError, Context, arg};
use crate::packages::mcp_sdk::auth::{
    self, AuthError, AuthHost, ExchangeAuthorizationOptions, RefreshAuthorizationOptions,
    StartAuthorizationOptions,
};
use crate::packages::mcp_sdk::client::net::{
    self, Body, FetchError, FetchHost, FetchInit, FetchResponse, Headers, Redirect,
};
use crate::packages::mcp_sdk::client::{
    AbortReason, Client, ClientError, ClientHost, ExternalTransport, HandlerError, HandlerOutcome,
    OpId, OutputCheck, RequestOptions, Settled, Signal, Transport,
};
use crate::packages::mcp_sdk::sse_client::SseTransport;
use crate::packages::mcp_sdk::stdio::{
    ReadBuffer, StdioError, deserialize_message, serialize_message,
};
use crate::packages::mcp_sdk::streamable_http_client::{
    EventParser, StreamableHttpTransport, Utf8Stream,
};
use crate::packages::mcp_sdk::types::{McpError, error_code, schema};

pub(super) fn call(name: &str, args: &[Value], cx: &mut Context) -> Option<Answer> {
    let _ = cx;
    let first = arg(args, 0).cloned().unwrap_or(Value::Null);
    let answer = match name {
        "mcp-sdk/stdio.readBuffer" => ok(read_buffer(&first)),
        "mcp-sdk/stdio.serializeMessage" => ok(Value::String(serialize_message(&jv(&first)))),
        "mcp-sdk/stdio.deserializeMessage" => ok(deserialize(&first)),
        "mcp-sdk/types.safeParse" => safe_parse(&first, arg(args, 1)),
        "mcp-sdk/mediaType.mediaTypeEssence" => ok(media_type(&first)),
        "mcp-sdk/event-source-parser.feed" => ok(event_parser(&first)),
        "mcp-sdk/transport.isWithinOrigin" => is_within_origin(&first, arg(args, 1)),
        "mcp-sdk/transport.unfollowedRedirect" => ok(unfollowed(&first, arg(args, 1))),
        "mcp-sdk/transport.fetchWithinOrigin" => ok(fetch_within_origin(&first)),
        "mcp-sdk/auth.extractWWWAuthenticateParams" => ok(www_authenticate(&first)),
        "mcp-sdk/auth-utils.checkResourceAllowed" => ok(resource_allowed(&first, arg(args, 1))),
        "mcp-sdk/auth-utils.resourceUrlFromServerUrl" => ok(resource_url(&first)),
        "mcp-sdk/auth.selectClientAuthMethod" => ok(select_method(&first, arg(args, 1))),
        "mcp-sdk/auth.buildDiscoveryUrls" => ok(discovery_urls(&first)),
        "mcp-sdk/auth.discoverOAuthServerInfo" => ok(auth_server_info(&first)),
        "mcp-sdk/auth.discoverOAuthProtectedResourceMetadata" => ok(auth_resource_metadata(&first)),
        "mcp-sdk/auth.discoverAuthorizationServerMetadata" => ok(auth_server_metadata(&first)),
        "mcp-sdk/auth.registerClient" => ok(auth_register(&first)),
        "mcp-sdk/auth.startAuthorization" => ok(auth_start(&first)),
        "mcp-sdk/auth.exchangeAuthorization" => ok(auth_exchange(&first)),
        "mcp-sdk/auth.refreshAuthorization" => ok(auth_refresh(&first)),
        "mcp-sdk/auth.parseErrorResponse" => ok(auth_parse_error(args)),
        "mcp-sdk/client.scenario" => ok(run_scenario(Kind::External, &first)),
        "mcp-sdk/streamable-http-client.scenario" => ok(run_scenario(Kind::Streamable, &first)),
        "mcp-sdk/sse-client.scenario" => ok(run_scenario(Kind::Sse, &first)),
        _ => return None,
    };
    Some(answer)
}

fn ok(value: Value) -> Answer {
    Ok(Some(value))
}

// ---- JSON helpers ----

fn jv(value: &Value) -> JsonValue {
    json_value_from_serde(value)
}

fn sv(value: &JsonValue) -> Value {
    json_value_to_serde(value)
}

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn name_and_message(name: &str, message: &str) -> Value {
    json!({ "name": name, "message": message })
}

fn hex_bytes(text: &str) -> Vec<u8> {
    let digits: Vec<u8> = text.bytes().collect();
    digits
        .chunks(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16).unwrap_or(0) as u8;
            let low = pair
                .get(1)
                .map_or(0, |b| (*b as char).to_digit(16).unwrap_or(0) as u8);
            high << 4 | low
        })
        .collect()
}

/// a string is UTF-8, `{ hex }` raw bytes
fn bytes_of(value: &Value) -> Vec<u8> {
    match value {
        Value::String(text) => text.as_bytes().to_vec(),
        Value::Object(_) => str_field(value, "hex").map(hex_bytes).unwrap_or_default(),
        _ => Vec::new(),
    }
}

fn stdio_error(error: &StdioError) -> Value {
    name_and_message(error.name(), &error.message())
}

// ---- stdio ----

fn read_buffer(cfg: &Value) -> Value {
    let mut buffer = match cfg.get("max").and_then(Value::as_u64) {
        Some(max) => ReadBuffer::with_max_buffer_size(max as usize),
        None => ReadBuffer::new(),
    };
    let mut out: Vec<Value> = Vec::new();
    let ops = cfg
        .get("ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for op in &ops {
        if let Some(chunk) = op.get("append") {
            match buffer.append(&bytes_of(chunk)) {
                Ok(()) => out.push(Value::String("ok".into())),
                Err(error) => out.push(json!({ "error": stdio_error(&error) })),
            }
        } else if op.get("read").is_some() {
            match buffer.read_message() {
                Ok(message) => {
                    out.push(json!({ "message": message.map_or(Value::Null, |m| sv(&m)) }))
                }
                Err(error) => out.push(json!({ "error": stdio_error(&error) })),
            }
        } else if op.get("readAll").is_some() {
            let mut got: Vec<Value> = Vec::new();
            loop {
                match buffer.read_message() {
                    Ok(Some(message)) => got.push(sv(&message)),
                    Ok(None) => break,
                    Err(error) => got.push(json!({ "error": stdio_error(&error) })),
                }
            }
            out.push(Value::Array(got));
        } else {
            buffer.clear();
            out.push(Value::String("cleared".into()));
        }
    }
    Value::Array(out)
}

fn deserialize(line: &Value) -> Value {
    match deserialize_message(line.as_str().unwrap_or("")) {
        Ok(message) => json!({ "ok": sv(&message) }),
        Err(error) => json!({ "error": stdio_error(&error) }),
    }
}

// ---- schemas ----

fn schema_named(name: &str) -> Option<schema::Schema> {
    Some(match name {
        "JSONRPCMessage" => schema::jsonrpc_message(),
        "JSONRPCRequest" => schema::jsonrpc_request(),
        "JSONRPCNotification" => schema::jsonrpc_notification(),
        "JSONRPCResultResponse" => schema::jsonrpc_result_response(),
        "JSONRPCErrorResponse" => schema::jsonrpc_error_response(),
        "InitializeResult" => schema::initialize_result(),
        "ListToolsResult" => schema::list_tools_result(),
        "CallToolResult" => schema::call_tool_result(),
        "EmptyResult" => schema::empty_result(),
        "ToolListChangedNotification" => schema::tool_list_changed_notification(),
        "InitializedNotification" => schema::initialized_notification(),
        "CancelledNotification" => schema::cancelled_notification(),
        "ProgressNotification" => schema::progress_notification(),
        "PingRequest" => schema::ping_request(),
        "OAuthProtectedResourceMetadata" => auth::oauth_protected_resource_metadata_schema(),
        "OAuthMetadata" => auth::oauth_metadata_schema(),
        "OpenIdProviderDiscoveryMetadata" => auth::openid_provider_discovery_metadata_schema(),
        "TokenResponse" => auth::token_response_schema(),
        "RegistrationResponse" => auth::registration_response_schema(),
        "OAuthErrorResponse" => auth::oauth_error_response_schema(),
        _ => return None,
    })
}

fn safe_parse(name: &Value, value: Option<&Value>) -> Answer {
    let name = name.as_str().unwrap_or("");
    let Some(parsing) = schema_named(name) else {
        return Err(CallError::plain(format!("no schema {name}")));
    };
    let input = value.map_or(JsonValue::Null, jv);
    Ok(Some(match schema::safe_parse(&parsing, &input) {
        Ok(parsed) => json!({ "ok": sv(&parsed) }),
        Err(issues) => {
            let list: Vec<Value> = issues.iter().map(|i| sv(&i.to_json())).collect();
            json!({ "issues": list })
        }
    }))
}

fn media_type(header: &Value) -> Value {
    net::media_type_essence(header.as_str()).map_or(Value::Null, Value::String)
}

fn event_parser(ops: &Value) -> Value {
    let mut decoder = Utf8Stream::new();
    let mut parser = EventParser::new();
    let mut out: Vec<Value> = Vec::new();
    for op in ops.as_array().cloned().unwrap_or_default() {
        if let Some(chunk) = op.get("chunk") {
            let text = decoder.decode(&bytes_of(chunk), false);
            parser.feed(&text);
        } else if op.get("end").is_some() {
            let rest = decoder.decode(&[], true);
            if !rest.is_empty() {
                parser.feed(&rest);
            }
        } else {
            parser.reset();
        }
        let events: Vec<Value> = parser
            .take_events()
            .into_iter()
            .map(|event| {
                let mut entry = Map::new();
                if let Some(id) = event.id {
                    entry.insert("id".into(), Value::String(id));
                }
                if let Some(kind) = event.event {
                    entry.insert("event".into(), Value::String(kind));
                }
                entry.insert("data".into(), Value::String(event.data));
                Value::Object(entry)
            })
            .collect();
        let retries: Vec<Value> = parser.take_retries().into_iter().map(Value::from).collect();
        out.push(json!({ "events": events, "retries": retries }));
    }
    Value::Array(out)
}

// ---- urls ----

fn is_within_origin(from: &Value, to: Option<&Value>) -> Answer {
    let parse = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .and_then(|t| url::Url::parse(t).ok())
    };
    match (parse(Some(from)), parse(to)) {
        (Some(from), Some(to)) => Ok(Some(Value::Bool(net::is_within_origin(&from, &to)))),
        _ => Err(CallError::plain("Invalid URL")),
    }
}

fn response_of(desc: &Value) -> FetchResponse {
    let mut headers = Headers::new();
    if let Some(Value::Object(map)) = desc.get("headers") {
        for (key, value) in map {
            headers.append(key, value.as_str().unwrap_or(""));
        }
    }
    FetchResponse {
        status: desc.get("status").and_then(Value::as_u64).unwrap_or(200) as u16,
        status_text: String::new(),
        headers,
        url: str_field(desc, "url").unwrap_or("").to_owned(),
        redirected: false,
        opaque_redirect: desc.get("opaque").and_then(Value::as_bool).unwrap_or(false),
        body: Body::None,
    }
}

fn unfollowed(desc: &Value, url: Option<&Value>) -> Value {
    let url = url.and_then(Value::as_str).unwrap_or("");
    net::unfollowed_redirect(&response_of(desc), url).map_or(Value::Null, Value::String)
}

fn www_authenticate(headers: &Value) -> Value {
    let mut parsed = Headers::new();
    if let Value::Object(map) = headers {
        for (key, value) in map {
            parsed.append(key, value.as_str().unwrap_or(""));
        }
    }
    let found = auth::extract_www_authenticate_params(&parsed);
    let mut out = Map::new();
    if let Some(url) = found.resource_metadata_url {
        out.insert("resourceMetadataUrl".into(), Value::String(url));
    }
    if let Some(scope) = found.scope {
        out.insert("scope".into(), Value::String(scope));
    }
    if let Some(error) = found.error {
        out.insert("error".into(), Value::String(error));
    }
    Value::Object(out)
}

fn auth_error_info(error: &AuthError) -> Value {
    if let AuthError::Thrown(_) = error {
        return name_and_message("undefined", "undefined");
    }
    let mut out = Map::new();
    out.insert("name".into(), Value::String(error.name()));
    out.insert("message".into(), Value::String(error.message()));
    if let AuthError::OAuth(oauth) = error {
        out.insert(
            "errorCode".into(),
            Value::String(oauth.error_code.to_owned()),
        );
        out.insert(
            "errorUri".into(),
            oauth.error_uri.clone().map_or(Value::Null, Value::String),
        );
        out.insert("response".into(), sv(&oauth.to_response_object()));
    }
    Value::Object(out)
}

fn plain_error(error: &AuthError) -> Value {
    name_and_message(&error.name(), &error.message())
}

fn resource_allowed(requested: &Value, configured: Option<&Value>) -> Value {
    let configured = configured.and_then(Value::as_str).unwrap_or("");
    match auth::check_resource_allowed(requested.as_str().unwrap_or(""), configured) {
        Ok(allowed) => json!({ "ok": allowed }),
        Err(error) => json!({ "error": plain_error(&error) }),
    }
}

fn resource_url(url: &Value) -> Value {
    match auth::resource_url_from_server_url(url.as_str().unwrap_or("")) {
        Ok(href) => json!({ "ok": href }),
        Err(error) => json!({ "error": plain_error(&error) }),
    }
}

fn select_method(client: &Value, supported: Option<&Value>) -> Value {
    let methods: Vec<String> = supported
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|m| m.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    Value::String(auth::select_client_auth_method(&jv(client), &methods).to_owned())
}

fn discovery_urls(url: &Value) -> Value {
    match auth::build_discovery_urls(url.as_str().unwrap_or("")) {
        Ok(urls) => {
            let list: Vec<Value> = urls
                .into_iter()
                .map(|(href, kind)| {
                    let kind = if kind == auth::MetadataKind::Oauth {
                        "oauth"
                    } else {
                        "oidc"
                    };
                    json!([href, kind])
                })
                .collect();
            json!({ "ok": list })
        }
        Err(error) => json!({ "error": plain_error(&error) }),
    }
}

// ---- the world: a scripted fetch, fake timers and streams ----

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    External,
    Streamable,
    Sse,
}

struct World {
    calls: Vec<Value>,
    events: Vec<Value>,
    specs: VecDeque<Value>,
    next_stream: u64,
    /// stream number to `closed`
    streams: HashMap<u64, bool>,
    /// per timer: whether it is live
    timers: Vec<bool>,
    ops: Vec<String>,
    writes: usize,
    fail_sends: Vec<usize>,
    closed: bool,
    fallback: String,
    validators: u64,
    validator_schemas: HashMap<u64, Value>,
    random_state: u32,
}

impl World {
    fn new(specs: &Value) -> World {
        World {
            calls: Vec::new(),
            events: Vec::new(),
            specs: specs.as_array().cloned().unwrap_or_default().into(),
            next_stream: 0,
            streams: HashMap::new(),
            timers: Vec::new(),
            ops: Vec::new(),
            writes: 0,
            fail_sends: Vec::new(),
            closed: false,
            fallback: String::new(),
            validators: 0,
            validator_schemas: HashMap::new(),
            random_state: 1,
        }
    }

    fn take_step(&mut self) -> Value {
        let calls = std::mem::take(&mut self.calls);
        let events = std::mem::take(&mut self.events);
        json!({ "calls": calls, "events": events })
    }

    fn new_op(&mut self, name: &str) -> OpId {
        self.ops.push(name.to_owned());
        (self.ops.len() - 1) as OpId
    }
}

fn headers_json(headers: Option<&Headers>) -> Value {
    let mut out = Map::new();
    if let Some(headers) = headers {
        for (name, value) in headers.entries() {
            out.insert(name, Value::String(value));
        }
    }
    Value::Object(out)
}

impl FetchHost for World {
    fn fetch(&mut self, url: &str, init: &FetchInit) -> Result<FetchResponse, FetchError> {
        let redirect = match init.redirect {
            Some(Redirect::Follow) => json!("follow"),
            Some(Redirect::Manual) => json!("manual"),
            Some(Redirect::Error) => json!("error"),
            None => Value::Null,
        };
        self.calls.push(json!([
            "fetch",
            url,
            init.method.clone().unwrap_or_else(|| "GET".to_owned()),
            headers_json(init.headers.as_ref()),
            init.body.clone().map_or(Value::Null, Value::String),
            redirect,
        ]));
        let Some(spec) = self.specs.pop_front() else {
            return Err(FetchError::type_error("no scripted response"));
        };
        if let Some(reject) = spec.get("reject") {
            let type_error = reject
                .get("typeError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let message = str_field(reject, "message").unwrap_or("");
            let mut error = if type_error {
                FetchError::type_error(message)
            } else {
                FetchError::other(str_field(reject, "name").unwrap_or("Error"), message)
            };
            if let Some(cause) = reject.get("cause") {
                error.cause = Some(Box::new(FetchError::other(
                    str_field(cause, "name").unwrap_or("Error"),
                    str_field(cause, "message").unwrap_or(""),
                )));
            }
            return Err(error);
        }
        let status = spec.get("status").and_then(Value::as_u64).unwrap_or(200) as u16;
        let null_body = matches!(status, 204 | 205 | 304);
        let body = if spec.get("stream").and_then(Value::as_bool).unwrap_or(false) {
            self.next_stream += 1;
            self.streams.insert(self.next_stream, false);
            Body::Stream(self.next_stream)
        } else if null_body {
            Body::None
        } else if let Some(hex) = str_field(&spec, "hex") {
            Body::Bytes(hex_bytes(hex))
        } else if let Some(text) = str_field(&spec, "body") {
            Body::Bytes(text.as_bytes().to_vec())
        } else {
            Body::None
        };
        let mut headers = Headers::new();
        if let Some(Value::Object(map)) = spec.get("headers") {
            for (key, value) in map {
                headers.append(key, value.as_str().unwrap_or(""));
            }
        }
        // a string body makes `Response` add its own content type
        let text_body = !null_body
            && spec.get("stream").and_then(Value::as_bool) != Some(true)
            && str_field(&spec, "hex").is_none()
            && str_field(&spec, "body").is_some();
        if text_body && headers.get("content-type").is_none() {
            headers.append("content-type", "text/plain;charset=UTF-8");
        }
        let opaque = spec.get("opaque").and_then(Value::as_bool).unwrap_or(false);
        Ok(FetchResponse {
            status: if opaque { 0 } else { status },
            status_text: str_field(&spec, "statusText").unwrap_or("").to_owned(),
            headers,
            url: str_field(&spec, "url").unwrap_or("").to_owned(),
            redirected: spec
                .get("redirected")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            opaque_redirect: opaque,
            body,
        })
    }

    fn cancel_body(&mut self, stream: u64) {
        if let Some(closed) = self.streams.get_mut(&stream) {
            *closed = true;
        }
        self.calls.push(json!(["cancel", stream]));
    }

    fn abort_body(&mut self, stream: u64) {
        if let Some(closed) = self.streams.get_mut(&stream) {
            if *closed {
                return;
            }
            *closed = true;
        }
        self.calls.push(json!(["abort", stream]));
    }
}

impl AuthHost for World {
    fn random_bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len)
            .map(|_| {
                self.random_state = (self.random_state * 73 + 41) % 256;
                self.random_state as u8
            })
            .collect()
    }
}

fn client_error_info(error: &ClientError) -> Value {
    if let ClientError::Thrown(text) = error {
        return json!({ "thrown": text });
    }
    let mut out = Map::new();
    out.insert("name".into(), Value::String(error.name()));
    out.insert("message".into(), Value::String(error.message()));
    match error {
        ClientError::Mcp(mcp) => {
            out.insert("code".into(), Value::from(mcp.code));
            if let Some(data) = &mcp.data {
                out.insert("data".into(), sv(data));
            }
        }
        ClientError::StreamableHttp { code, .. } => {
            out.insert("code".into(), Value::from(*code));
        }
        ClientError::Sse {
            code: Some(code), ..
        } => {
            out.insert("code".into(), Value::from(*code));
        }
        _ => {}
    }
    Value::Object(out)
}

impl ClientHost for World {
    fn set_timeout(&mut self, ms: f64) -> u64 {
        self.timers.push(true);
        let n = self.timers.len() as u64;
        self.calls.push(json!(["setTimeout", n, ms]));
        n
    }

    fn clear_timeout(&mut self, timer: u64) {
        if let Some(live) = self.timers.get_mut((timer as usize).wrapping_sub(1)) {
            *live = false;
        }
        self.calls.push(json!(["clearTimeout", timer]));
    }

    fn settle(&mut self, op: OpId, outcome: Result<Settled, ClientError>) {
        let name = self.ops.get(op as usize).cloned().unwrap_or_default();
        self.events.push(match outcome {
            Ok(Settled::Connected) => json!(["settle", name, "ok", Value::Null]),
            Ok(Settled::Result(value)) => json!(["settle", name, "ok", sv(&value)]),
            Err(error) => json!(["settle", name, "error", client_error_info(&error)]),
        });
    }

    fn on_error(&mut self, error: &ClientError) {
        self.events
            .push(json!(["onerror", client_error_info(error)]));
    }

    fn on_close(&mut self) {
        self.events.push(json!(["onclose"]));
    }

    fn on_notification(&mut self, notification: &JsonValue) {
        self.events.push(json!(["notification", sv(notification)]));
    }

    fn fallback_request(&mut self, request: &JsonValue) -> Option<HandlerOutcome> {
        self.events.push(json!(["fallback", sv(request)]));
        match self.fallback.as_str() {
            "methodNotFound" => {
                let method = match request.get("method").as_deref() {
                    Some(JsonValue::String(method)) => method.clone(),
                    _ => String::new(),
                };
                Some(HandlerOutcome::Error(HandlerError::mcp(
                    error_code::METHOD_NOT_FOUND,
                    &format!("Method not found: {method}"),
                )))
            }
            "result" => {
                let mut result = JsObject::new();
                result.set("ok", JsonValue::Bool(true));
                Some(HandlerOutcome::Result(Some(JsonValue::Object(result))))
            }
            "undefined" => Some(HandlerOutcome::Result(None)),
            "throwPlain" => Some(HandlerOutcome::Error(HandlerError {
                code: None,
                message: Some("boom".to_owned()),
                data: None,
            })),
            "throwCode" => {
                let mut data = JsObject::new();
                data.set("a", JsonValue::Number(1.0));
                Some(HandlerOutcome::Error(HandlerError {
                    code: Some(5.0),
                    message: Some("bad".to_owned()),
                    data: Some(JsonValue::Object(data)),
                }))
            }
            "throwBadCode" => Some(HandlerOutcome::Error(HandlerError {
                code: Some(1.5),
                message: Some("x".to_owned()),
                data: None,
            })),
            "throwString" => Some(HandlerOutcome::Error(HandlerError {
                code: None,
                message: None,
                data: None,
            })),
            _ => None,
        }
    }

    fn write(&mut self, message: &JsonValue) -> Result<(), ClientError> {
        let index = self.writes;
        self.writes += 1;
        self.calls.push(json!(["send", json_stringify(message)]));
        if self.closed {
            return Err(ClientError::Mcp(McpError::new(
                error_code::CONNECTION_CLOSED,
                "The server is not running",
                None,
            )));
        }
        if self.fail_sends.contains(&index) {
            return Err(ClientError::plain("write failed"));
        }
        Ok(())
    }

    fn close_transport(&mut self) -> bool {
        self.calls.push(json!(["close"]));
        if self.closed {
            false
        } else {
            self.closed = true;
            true
        }
    }

    fn compile_output_schema(&mut self, schema: &JsonValue) -> Result<u64, String> {
        let plain = sv(schema);
        self.calls.push(json!(["compile", plain.clone()]));
        if plain.get("bad").and_then(Value::as_bool) == Some(true) {
            return Err("bad schema".to_owned());
        }
        self.validators += 1;
        self.validator_schemas.insert(self.validators, plain);
        Ok(self.validators)
    }

    fn validate_output(&mut self, validator: u64, structured_content: &JsonValue) -> OutputCheck {
        let input = sv(structured_content);
        self.calls
            .push(json!(["validate", validator, input.clone()]));
        let schema = self
            .validator_schemas
            .get(&validator)
            .cloned()
            .unwrap_or(Value::Null);
        if schema.get("throws").and_then(Value::as_bool) == Some(true) {
            return OutputCheck::Threw("validator crashed".to_owned());
        }
        let required = schema
            .get("required")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for key in required {
            let key = key.as_str().unwrap_or("");
            if input.get(key).is_none() {
                return OutputCheck::Invalid(format!("must have required property '{key}'"));
            }
        }
        OutputCheck::Valid
    }
}

// ---- fetch within origin and the auth helpers over the scripted fetch ----

fn init_of(cfg: Option<&Value>) -> FetchInit {
    let mut init = FetchInit::default();
    let Some(cfg) = cfg else {
        return init;
    };
    init.method = str_field(cfg, "method").map(str::to_owned);
    if let Some(Value::Object(map)) = cfg.get("headers") {
        let mut headers = Headers::new();
        for (key, value) in map {
            headers.append(key, value.as_str().unwrap_or(""));
        }
        init.headers = Some(headers);
    }
    init.body = str_field(cfg, "body").map(str::to_owned);
    init.redirect = match str_field(cfg, "redirect") {
        Some("manual") => Some(Redirect::Manual),
        Some("error") => Some(Redirect::Error),
        Some("follow") => Some(Redirect::Follow),
        _ => None,
    };
    init
}

fn fetch_within_origin(cfg: &Value) -> Value {
    let mut world = World::new(cfg.get("fetches").unwrap_or(&Value::Null));
    let url = str_field(cfg, "url")
        .unwrap_or("https://a.example/mcp")
        .to_owned();
    let init = init_of(cfg.get("init"));
    let outcome = net::fetch_within_origin(&mut world, &url, &init);
    let calls = std::mem::take(&mut world.calls);
    match outcome {
        Ok(response) => {
            let text = net::read_text(&mut world, &response.body).unwrap_or_default();
            json!({ "calls": calls, "status": response.status, "text": text })
        }
        Err(error) => {
            json!({ "calls": calls, "error": name_and_message(&error.name, &error.message) })
        }
    }
}

/// `runAuth`: the answer is the calls and the result or the error
fn run_auth(cfg: &Value, body: impl FnOnce(&mut World) -> Result<Value, AuthError>) -> Value {
    let mut world = World::new(cfg.get("fetches").unwrap_or(&Value::Null));
    world.random_state = cfg.get("seed").and_then(Value::as_u64).unwrap_or(1) as u32;
    let outcome = body(&mut world);
    let calls = std::mem::take(&mut world.calls);
    match outcome {
        Ok(result) => json!({ "calls": calls, "result": result }),
        Err(error) => json!({ "calls": calls, "error": auth_error_info(&error) }),
    }
}

fn opt<'a>(cfg: &'a Value, key: &str) -> Option<&'a str> {
    str_field(cfg, key)
}

fn auth_server_info(cfg: &Value) -> Value {
    run_auth(cfg, |world| {
        let info = auth::discover_oauth_server_info(
            world,
            opt(cfg, "serverUrl").unwrap_or(""),
            opt(cfg, "resourceMetadataUrl"),
        )?;
        let mut out = Map::new();
        out.insert(
            "authorizationServerUrl".into(),
            Value::String(info.authorization_server_url),
        );
        if let Some(metadata) = info.authorization_server_metadata {
            out.insert("authorizationServerMetadata".into(), sv(&metadata));
        }
        if let Some(metadata) = info.resource_metadata {
            out.insert("resourceMetadata".into(), sv(&metadata));
        }
        Ok(Value::Object(out))
    })
}

fn auth_resource_metadata(cfg: &Value) -> Value {
    run_auth(cfg, |world| {
        let found = auth::discover_oauth_protected_resource_metadata(
            world,
            opt(cfg, "serverUrl").unwrap_or(""),
            opt(cfg, "resourceMetadataUrl"),
        )?;
        Ok(sv(&found))
    })
}

fn auth_server_metadata(cfg: &Value) -> Value {
    run_auth(cfg, |world| {
        let found =
            auth::discover_authorization_server_metadata(world, opt(cfg, "url").unwrap_or(""))?;
        Ok(found.map_or(Value::Null, |metadata| sv(&metadata)))
    })
}

fn auth_register(cfg: &Value) -> Value {
    run_auth(cfg, |world| {
        let metadata = cfg.get("metadata").filter(|m| !m.is_null()).map(jv);
        let client_metadata = jv(cfg.get("clientMetadata").unwrap_or(&Value::Null));
        let registered = auth::register_client(
            world,
            opt(cfg, "url").unwrap_or(""),
            metadata.as_ref(),
            &client_metadata,
            opt(cfg, "scope"),
        )?;
        Ok(sv(&registered))
    })
}

fn auth_start(cfg: &Value) -> Value {
    run_auth(cfg, |world| {
        let metadata = cfg.get("metadata").filter(|m| !m.is_null()).map(jv);
        let options = StartAuthorizationOptions {
            metadata: metadata.as_ref(),
            client_id: opt(cfg, "clientId").unwrap_or("cid"),
            redirect_url: opt(cfg, "redirectUrl").unwrap_or("http://127.0.0.1:5555/callback"),
            scope: opt(cfg, "scope"),
            state: opt(cfg, "state"),
            resource: opt(cfg, "resource"),
        };
        let started = auth::start_authorization(world, opt(cfg, "url").unwrap_or(""), &options)?;
        Ok(json!({
            "authorizationUrl": started.authorization_url,
            "codeVerifier": started.code_verifier,
        }))
    })
}

fn auth_exchange(cfg: &Value) -> Value {
    run_auth(cfg, |world| {
        let metadata = cfg.get("metadata").filter(|m| !m.is_null()).map(jv);
        let client = jv(cfg.get("client").unwrap_or(&Value::Null));
        let options = ExchangeAuthorizationOptions {
            metadata: metadata.as_ref(),
            client_information: &client,
            authorization_code: opt(cfg, "code").unwrap_or("code1"),
            code_verifier: opt(cfg, "verifier").unwrap_or("ver"),
            redirect_uri: opt(cfg, "redirectUri").unwrap_or("http://127.0.0.1:5555/callback"),
            resource: opt(cfg, "resource"),
        };
        let tokens = auth::exchange_authorization(world, opt(cfg, "url").unwrap_or(""), &options)?;
        Ok(sv(&tokens))
    })
}

fn auth_refresh(cfg: &Value) -> Value {
    run_auth(cfg, |world| {
        let metadata = cfg.get("metadata").filter(|m| !m.is_null()).map(jv);
        let client = jv(cfg.get("client").unwrap_or(&Value::Null));
        let options = RefreshAuthorizationOptions {
            metadata: metadata.as_ref(),
            client_information: &client,
            refresh_token: opt(cfg, "refreshToken").unwrap_or("rt0"),
            resource: opt(cfg, "resource"),
        };
        let tokens = auth::refresh_authorization(world, opt(cfg, "url").unwrap_or(""), &options)?;
        Ok(sv(&tokens))
    })
}

fn auth_parse_error(args: &[Value]) -> Value {
    let status = arg(args, 0).and_then(Value::as_u64).unwrap_or(0) as u16;
    let body = arg(args, 1).and_then(Value::as_str).unwrap_or("");
    let as_text = arg(args, 3).and_then(Value::as_bool).unwrap_or(false);
    let error = if as_text {
        auth::parse_error_response_text(body)
    } else {
        let mut world = World::new(&Value::Null);
        let response = FetchResponse {
            status,
            status_text: String::new(),
            headers: response_of(
                &json!({ "headers": arg(args, 2).cloned().unwrap_or(Value::Null) }),
            )
            .headers,
            url: String::new(),
            redirected: false,
            opaque_redirect: false,
            body: Body::Bytes(body.as_bytes().to_vec()),
        };
        auth::parse_error_response(&mut world, &response)
    };
    auth_error_info(&error)
}

// ---- the client over a scripted transport ----

fn reason_of(spec: Option<&Value>) -> AbortReason {
    match spec {
        None | Some(Value::Null) | Some(Value::Bool(true)) => AbortReason::default_abort(),
        Some(value) => {
            if let Some(error) = value.get("error") {
                AbortReason::Error {
                    name: str_field(error, "name").unwrap_or("Error").to_owned(),
                    message: str_field(error, "message").unwrap_or("").to_owned(),
                }
            } else if let Some(mcp) = value.get("mcp") {
                AbortReason::Mcp(McpError::new(
                    mcp.get("code").and_then(Value::as_f64).unwrap_or(0.0),
                    str_field(mcp, "message").unwrap_or(""),
                    None,
                ))
            } else {
                AbortReason::Value(value.as_str().unwrap_or("").to_owned())
            }
        }
    }
}

/// a new operation named by the step's `id`, with the options of the step:
/// `timeout`, and `signal` as the name of a signal that is made on first use
/// (aborted at once when the step says `aborted`)
fn start_op(
    world: &mut World,
    controllers: &mut HashMap<String, Option<AbortReason>>,
    signal_ops: &mut Vec<(OpId, String)>,
    step: &Value,
    default_name: &str,
) -> (OpId, RequestOptions) {
    let op = world.new_op(str_field(step, "id").unwrap_or(default_name));
    let mut options = RequestOptions {
        timeout: step.get("timeout").and_then(Value::as_f64),
        signal: None,
    };
    if let Some(name) = str_field(step, "signal") {
        let state = controllers
            .entry(name.to_owned())
            .or_insert_with(|| step.get("aborted").map(|aborted| reason_of(Some(aborted))));
        options.signal = Some(Signal {
            aborted: state.clone(),
        });
        signal_ops.push((op, name.to_owned()));
    }
    (op, options)
}

fn run_scenario(kind: Kind, scenario: &Value) -> Value {
    let mut world = World::new(scenario.get("fetches").unwrap_or(&Value::Null));
    world.fail_sends = scenario
        .get("failSends")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|n| n.as_u64().map(|n| n as usize))
                .collect()
        })
        .unwrap_or_default();
    world.fallback = str_field(scenario, "fallback").unwrap_or("").to_owned();
    let info = scenario
        .get("clientInfo")
        .map(jv)
        .unwrap_or_else(|| jv(&json!({ "name": "seuoffice", "version": "1.0.0" })));
    let mut client = Client::new(info);
    if matches!(
        world.fallback.as_str(),
        "methodNotFound"
            | "result"
            | "undefined"
            | "throwPlain"
            | "throwCode"
            | "throwBadCode"
            | "throwString"
    ) {
        client.set_fallback_request_handler();
    }
    if scenario.get("toolsChanged").and_then(Value::as_bool) == Some(true) {
        client.set_notification_handler();
    }
    let url = url::Url::parse(str_field(scenario, "url").unwrap_or("https://example.com/mcp"))
        .map(|u| u.as_str().to_owned())
        .unwrap_or_default();
    // signal name to its reason once aborted
    let mut controllers: HashMap<String, Option<AbortReason>> = HashMap::new();
    let mut signal_ops: Vec<(OpId, String)> = Vec::new();
    let mut steps: Vec<Value> = Vec::new();
    for step in scenario
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let op_name = str_field(&step, "op").unwrap_or("");
        match op_name {
            "connect" => {
                let (op, options) = start_op(
                    &mut world,
                    &mut controllers,
                    &mut signal_ops,
                    &step,
                    "connect",
                );
                let transport: Box<dyn Transport> = match kind {
                    Kind::External => Box::new(ExternalTransport::new()),
                    Kind::Streamable => Box::new(StreamableHttpTransport::new(&url)),
                    Kind::Sse => Box::new(SseTransport::new(&url)),
                };
                client.connect(&mut world, op, transport, options);
            }
            "listTools" => {
                let (op, options) =
                    start_op(&mut world, &mut controllers, &mut signal_ops, &step, "list");
                let params = step.get("params").map(jv);
                client.list_tools(&mut world, op, params, &options);
            }
            "callTool" => {
                let (op, options) =
                    start_op(&mut world, &mut controllers, &mut signal_ops, &step, "call");
                let params = jv(step.get("params").unwrap_or(&Value::Null));
                client.call_tool(&mut world, op, params, &options);
            }
            "ping" => {
                let (op, options) =
                    start_op(&mut world, &mut controllers, &mut signal_ops, &step, "ping");
                client.ping(&mut world, op, &options);
            }
            "message" => {
                if kind == Kind::External {
                    let message = jv(step.get("message").unwrap_or(&Value::Null));
                    match schema::safe_parse(&schema::jsonrpc_message(), &message) {
                        Ok(parsed) => client.on_message(&mut world, parsed),
                        Err(issues) => world.events.push(json!([
                            "parseError",
                            name_and_message("ZodError", &schema::error_message(&issues))
                        ])),
                    }
                }
            }
            "raw" => {
                if kind == Kind::External {
                    client.on_message(&mut world, jv(step.get("message").unwrap_or(&Value::Null)));
                }
            }
            "timer" => {
                let n = step.get("n").and_then(Value::as_u64).unwrap_or(1);
                let live = world
                    .timers
                    .get((n as usize).wrapping_sub(1))
                    .copied()
                    .unwrap_or(false);
                if live {
                    world.timers[(n - 1) as usize] = false;
                    client.on_timeout(&mut world, n);
                }
            }
            "abort" => {
                let name = str_field(&step, "signal").unwrap_or("").to_owned();
                if let Some(state) = controllers.get_mut(&name)
                    && state.is_none()
                {
                    let reason = reason_of(step.get("reason"));
                    *state = Some(reason.clone());
                    let ops: Vec<OpId> = signal_ops
                        .iter()
                        .filter(|(_, signal)| *signal == name)
                        .map(|(op, _)| *op)
                        .collect();
                    for op in ops {
                        client.on_abort(&mut world, op, reason.clone());
                    }
                }
            }
            "close" => client.close(&mut world),
            "transportClose" => {
                if kind == Kind::External && !world.closed {
                    world.closed = true;
                    client.on_transport_closed(&mut world);
                }
            }
            "transportError" => {
                if kind == Kind::External {
                    let text = step.get("text").and_then(Value::as_str).unwrap_or("");
                    client.on_transport_error(&mut world, ClientError::plain(text));
                }
            }
            "chunk" => {
                let stream = step.get("stream").and_then(Value::as_u64).unwrap_or(1);
                if world.streams.get(&stream) == Some(&false) {
                    let bytes = step.get("text").map(bytes_of).unwrap_or_default();
                    client.on_stream_chunk(&mut world, stream, &bytes);
                }
            }
            "end" => {
                let stream = step.get("stream").and_then(Value::as_u64).unwrap_or(1);
                if world.streams.get(&stream) == Some(&false) {
                    world.streams.insert(stream, true);
                    client.on_stream_end(&mut world, stream);
                }
            }
            "streamError" => {
                let stream = step.get("stream").and_then(Value::as_u64).unwrap_or(1);
                if world.streams.get(&stream) == Some(&false) {
                    world.streams.insert(stream, true);
                    let text = str_field(&step, "text").unwrap_or("");
                    let error = if step.get("typeError").and_then(Value::as_bool) == Some(true) {
                        FetchError::type_error(text)
                    } else {
                        FetchError::other(str_field(&step, "name").unwrap_or("Error"), text)
                    };
                    client.on_stream_error(&mut world, stream, &error);
                }
            }
            "terminate" => {
                if kind == Kind::Streamable {
                    let outcome = client.terminate_session(&mut world);
                    if let Some(outcome) = outcome {
                        world.events.push(match outcome {
                            Ok(()) => json!(["settle", "terminate", "ok", Value::Null]),
                            Err(error) => {
                                json!(["settle", "terminate", "error", client_error_info(&error)])
                            }
                        });
                    }
                }
            }
            "session" => {
                let session = if kind == Kind::Streamable {
                    client.session_id()
                } else {
                    None
                };
                world.events.push(json!([
                    "session",
                    session.map_or(Value::Null, Value::String)
                ]));
            }
            other => {
                steps.push(json!({ "error": format!("no such step: {other}") }));
                continue;
            }
        }
        steps.push(world.take_step());
    }
    Value::Array(steps)
}
