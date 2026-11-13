//! A [`Net`] that answers from a table, for tests and for the probes of the
//! ports that run on the [`Driver`](super::Driver).
//!
//! The table is plain JSON (a case's `hosts.a.<port>.net`):
//!
//! ```json
//! { "fetch": [
//!     { "via": "net", "method": "POST", "url": "https://x/y", "urlIncludes": "/y",
//!       "status": 200, "statusText": "OK", "headers": { "content-type": "text/event-stream" },
//!       "body": ["data: 1\n\n", { "hex": "0a0a" }, { "error": "terminated" }],
//!       "finalUrl": "https://x/z", "redirected": true, "times": 2 },
//!     { "url": "https://x/slow", "error": { "message": "fetch failed", "code": "ECONNRESET" } }
//!   ],
//!   "listen": { "port": 43111,
//!     "requests": [{ "method": "GET", "url": "/cb?code=abc", "headers": { "host": "127.0.0.1" } }] } }
//! ```
//!
//! A fetch takes the first rule whose given conditions (`via`: `node`, `net`
//! or `embed`; `method`, default `GET`; `url` exactly; `urlIncludes`) hold and
//! that has uses left (`times`, default 1; `"always"` never runs out). No rule
//! left: `TypeError: fetch failed`. `error` rejects the fetch; otherwise the
//! headers answer with `status` (200), `statusText`, `headers` (an object or a
//! list of pairs). `body` is a text, or a list of chunks (a text, `{hex}`, or
//! `{error}` which fails the read); absent or null: no body. A rule never
//! answers a cancelled stream's reads. `listen` answers the port asked for
//! (or `listen.port`, 40000 for 0) and then passes each scripted request in.
//!
//! The log gets one line per call: `["fetch", n, via, method, url, headers,
//! body]` (`n` counts the fetches from 0), `["cancel", n]` for a fetch's
//! stream or operation, `["listen", host, port]`, `["respond", status,
//! headers, text]`, `["closeServer"]`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use jscompat::json_value_from_serde;
use main_core::packages::ai_provider::task::{
    Answer, Fetcher, HttpRequest, Id, JsError, Request, RequestBody, ResponseHead,
};
use serde_json::{Value, json};

use super::{Net, Sink};

/// The host log of a case (the same type as `probe::Log`)
pub type Log = Arc<Mutex<Vec<Value>>>;

type Chunks = VecDeque<Result<Vec<u8>, String>>;

#[derive(Default)]
struct State {
    /// per rule of `fetch`, the uses so far
    used: Vec<u64>,
    fetches: usize,
    /// the number of a fetch, by the ids of its operation and its body
    number_of: HashMap<Id, usize>,
    bodies: HashMap<Id, Chunks>,
    /// the fetch a body (or a clone) belongs to
    stream_of: HashMap<Id, Id>,
    cancelled: HashSet<Id>,
    requests: u64,
}

pub struct FakeNet {
    table: Value,
    log: Option<Log>,
    state: Mutex<State>,
}

impl FakeNet {
    pub fn new(table: &Value, log: Option<Log>) -> Arc<FakeNet> {
        let rules = table["fetch"].as_array().map_or(0, Vec::len);
        Arc::new(FakeNet {
            table: table.clone(),
            log,
            state: Mutex::new(State {
                used: vec![0; rules],
                ..State::default()
            }),
        })
    }

    fn note(&self, line: Value) {
        if let Some(log) = &self.log {
            log.lock().unwrap().push(line);
        }
    }
}

fn via_name(via: Fetcher) -> &'static str {
    match via {
        Fetcher::Node => "node",
        Fetcher::Net => "net",
        Fetcher::Embed => "embed",
    }
}

fn pairs_json(pairs: &[(String, String)]) -> Value {
    Value::Array(pairs.iter().map(|(k, v)| json!([k, v])).collect())
}

fn hex_of(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok())
        .collect()
}

fn body_json(body: &Option<RequestBody>) -> Value {
    match body {
        None => Value::Null,
        Some(RequestBody::Text(text)) => json!(text),
        Some(RequestBody::Bytes(bytes)) => json!({ "hex": hex_of(bytes) }),
        Some(RequestBody::Form(parts)) => json!({
            "form": parts.iter().map(|p| json!(p.name)).collect::<Vec<_>>()
        }),
    }
}

fn headers_of(value: Option<&Value>) -> Vec<(String, String)> {
    match value {
        Some(Value::Object(map)) => map
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
            .collect(),
        Some(Value::Array(list)) => list
            .iter()
            .filter_map(|pair| {
                Some((
                    pair.get(0)?.as_str()?.to_owned(),
                    pair.get(1)?.as_str()?.to_owned(),
                ))
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn chunk_of(value: &Value) -> Result<Vec<u8>, String> {
    match value {
        Value::String(text) => Ok(text.as_bytes().to_vec()),
        Value::Object(map) if map.contains_key("error") => {
            Err(map["error"].as_str().unwrap_or("terminated").to_owned())
        }
        Value::Object(map) => Ok(unhex(map.get("hex").and_then(Value::as_str).unwrap_or(""))),
        other => Ok(other.to_string().into_bytes()),
    }
}

fn chunks_of(body: &Value) -> Chunks {
    let all: Vec<Result<Vec<u8>, String>> = match body {
        Value::Array(list) => list.iter().map(chunk_of).collect(),
        single => vec![chunk_of(single)],
    };
    all.into_iter()
        .filter(|chunk| !matches!(chunk, Ok(bytes) if bytes.is_empty()))
        .collect()
}

fn status_text(status: u64) -> &'static str {
    match status {
        200 => "OK",
        201 => "Created",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        _ => "",
    }
}

fn rule_matches(rule: &Value, via: Fetcher, method: &str, url: &str) -> bool {
    let is = |key: &str, actual: &str| rule[key].as_str().is_none_or(|want| want == actual);
    is("via", via_name(via))
        && rule["method"]
            .as_str()
            .unwrap_or("GET")
            .eq_ignore_ascii_case(method)
        && is("url", url)
        && rule["urlIncludes"]
            .as_str()
            .is_none_or(|part| url.contains(part))
}

fn rejection(spec: &Value) -> JsError {
    let message = spec["message"].as_str().unwrap_or("fetch failed");
    let mut error = JsError::type_error(message);
    if let Some(code) = spec["code"].as_str() {
        error = error.with(
            "cause",
            json_value_from_serde(&json!({ "$class": "Error", "message": message, "code": code })),
        );
    }
    error
}

impl Net for FakeNet {
    fn fetch(&self, id: Id, via: Fetcher, url: String, request: Request, sink: Sink) {
        let method = request.method.clone().unwrap_or_else(|| "GET".into());
        let mut state = self.state.lock().unwrap();
        let n = state.fetches;
        state.fetches += 1;
        state.number_of.insert(id, n);
        self.note(json!([
            "fetch",
            n,
            via_name(via),
            method,
            url,
            pairs_json(&request.headers),
            body_json(&request.body)
        ]));
        let rules = self.table["fetch"].as_array().cloned().unwrap_or_default();
        let found = rules.iter().enumerate().find(|(i, rule)| {
            let times = match &rule["times"] {
                Value::Number(count) => count.as_u64().unwrap_or(1),
                Value::String(_) => u64::MAX,
                Value::Bool(true) => u64::MAX,
                _ => 1,
            };
            state.used[*i] < times && rule_matches(rule, via, &method, &url)
        });
        let Some((i, rule)) = found else {
            drop(state);
            let mut error = JsError::type_error("fetch failed");
            error = error.with(
                "cause",
                json_value_from_serde(&json!({
                    "$class": "Error",
                    "message": format!("no scripted response for {method} {url}")
                })),
            );
            sink.failed(id, error);
            return;
        };
        state.used[i] += 1;
        if rule["error"].is_object() {
            drop(state);
            sink.failed(id, rejection(&rule["error"]));
            return;
        }
        let has_body = !rule["body"].is_null();
        if has_body {
            state.bodies.insert(id, chunks_of(&rule["body"]));
            state.stream_of.insert(id, id);
        }
        drop(state);
        let status = rule["status"].as_u64().unwrap_or(200);
        sink.done(
            id,
            Answer::Response(ResponseHead {
                status: status as f64,
                status_text: rule["statusText"]
                    .as_str()
                    .unwrap_or_else(|| status_text(status))
                    .to_owned(),
                headers: headers_of(rule.get("headers")),
                url: rule["finalUrl"].as_str().unwrap_or(&url).to_owned(),
                redirected: rule["redirected"].as_bool().unwrap_or(false),
                kind: "basic".into(),
                has_body,
            }),
        );
    }

    fn read(&self, id: Id, body: Id, sink: Sink) {
        let mut state = self.state.lock().unwrap();
        let source = state.stream_of.get(&body).copied();
        if source.is_none_or(|s| state.cancelled.contains(&s)) {
            return;
        }
        let next = state.bodies.get_mut(&body).and_then(VecDeque::pop_front);
        drop(state);
        match next {
            Some(Ok(bytes)) => sink.done(id, Answer::Chunk(bytes)),
            Some(Err(message)) => sink.failed(id, JsError::type_error(message)),
            None => sink.done(id, Answer::End),
        }
    }

    fn clone_body(&self, from: Id, to: Id) {
        let mut state = self.state.lock().unwrap();
        let rest = state.bodies.get(&from).cloned().unwrap_or_default();
        let source = state.stream_of.get(&from).copied().unwrap_or(from);
        state.bodies.insert(to, rest);
        state.stream_of.insert(to, source);
    }

    fn cancel(&self, id: Id) {
        let mut state = self.state.lock().unwrap();
        if let Some(n) = state.number_of.get(&id).copied() {
            state.cancelled.insert(id);
            drop(state);
            self.note(json!(["cancel", n]));
        }
    }

    fn listen(&self, id: Id, host: String, port: f64, sink: Sink) {
        let spec = &self.table["listen"];
        let scripted = spec["port"].as_f64().unwrap_or(40000.0);
        let bound = if port == 0.0 { scripted } else { port };
        self.note(json!(["listen", host, bound]));
        sink.done(id, Answer::Listening { port: bound });
        for request in spec["requests"].as_array().into_iter().flatten() {
            let mut state = self.state.lock().unwrap();
            state.requests += 1;
            let request_id = state.requests;
            drop(state);
            sink.request(
                id,
                HttpRequest {
                    id: request_id,
                    method: request["method"].as_str().unwrap_or("GET").to_owned(),
                    url: request["url"].as_str().unwrap_or("/").to_owned(),
                    headers: headers_of(request.get("headers")),
                },
            );
        }
    }

    fn respond(&self, _request: Id, status: f64, headers: Vec<(String, String)>, body: Vec<u8>) {
        self.note(json!([
            "respond",
            status,
            pairs_json(&headers),
            String::from_utf8_lossy(&body)
        ]));
    }

    fn close_server(&self, _server: Id) {
        self.note(json!(["closeServer"]));
    }
}
