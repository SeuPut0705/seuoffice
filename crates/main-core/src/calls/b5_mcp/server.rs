//! Group `b5-mcp`, slice `server`: see tools/main-diff/groups/b5-mcp/server.ts.
//!
//! `mcp-server.scenario` drives the sans-IO `McpServerService` with the script
//! the spec describes, and plays the world around it as a fake host: the
//! HTTP clients (a response is what the commands made of it), the listener
//! (`EADDRINUSE` while the fixed port is blocked), the sockets, the mock
//! clock (`tick`) and the random source (ids counted, written as `<sidN>`).

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

use jscompat::{JsonValue, json_stringify, json_value_from_serde};
use serde_json::{Map, Value};

use super::super::{Answer, CallError, Context, arg, print_js};
use super::zod::shape_of;
use crate::packages::mcp_sdk::server::{
    AbortCause, Command, HandlerError, HandlerReply, ListenerId, RequestSchema, ResponseId, Server,
    ServerOptions, SessionServer, SocketId, StartId, StopId, Ticket, TimerId,
};
use crate::packages::mcp_sdk::streamable_http_server::HttpRequest;
use crate::shell::mcp::mcp_server::{
    HostCall, McpHost, McpServerService, McpServerServiceOptions, McpToolDefinition, Settled,
    ToolHandler, ToolStep,
};

/// the port the system picks for port 0
const BOUND_PORT: f64 = 49152.0;
/// the port another program may hold
const FIXED_PORT: f64 = 49153.0;

struct FakeHost {
    uuids: Cell<u32>,
}

impl McpHost for FakeHost {
    fn random_uuid(&self) -> String {
        let n = self.uuids.get() + 1;
        self.uuids.set(n);
        format!("00000000-0000-4000-8000-{n:012x}")
    }

    fn now_ms(&self) -> f64 {
        0.0
    }
}

fn object(entries: Vec<(&str, Value)>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in entries {
        out.insert(key.to_owned(), value);
    }
    out
}

fn text(value: &str) -> Value {
    Value::String(value.to_owned())
}

/// what a tool does after its awaits
enum Then {
    Returns(JsonValue),
    Throws(String),
    Echo,
    Answers,
    Counter(Rc<Cell<f64>>),
    Nothing,
}

struct AwaitSpec {
    control: &'static str,
    method: &'static str,
    args: Vec<Value>,
}

fn finish(then: &Then, args: &JsonValue, answers: Vec<JsonValue>) -> Settled {
    match then {
        Then::Returns(value) => Ok(Some(value.clone())),
        Then::Throws(message) => Err(message.clone()),
        Then::Echo => Ok(Some(args.clone())),
        Then::Answers => Ok(Some(JsonValue::Array(answers))),
        Then::Counter(n) => {
            n.set(n.get() + 1.0);
            Ok(Some(JsonValue::Number(n.get())))
        }
        Then::Nothing => Ok(None),
    }
}

/// the tool from its `idx`-th await on
fn tool_step(
    awaits: Rc<Vec<AwaitSpec>>,
    idx: usize,
    args: JsonValue,
    answers: Vec<JsonValue>,
    then: Rc<Then>,
) -> ToolStep<'static> {
    let Some(a) = awaits.get(idx) else {
        return ToolStep::Done(finish(&then, &args, answers));
    };
    let call = HostCall {
        control: a.control,
        method: a.method,
        args: a
            .args
            .iter()
            .map(|v| {
                if v == "$args" {
                    args.clone()
                } else {
                    json_value_from_serde(v)
                }
            })
            .collect(),
    };
    ToolStep::Await {
        call,
        then: Box::new(move |settled| match settled {
            Err(message) => ToolStep::Done(Err(message)),
            Ok(value) => {
                let mut answers = answers;
                answers.push(value.unwrap_or(JsonValue::Null));
                tool_step(awaits, idx + 1, args, answers, then)
            }
        }),
    }
}

/// a tool's handler from its descriptor
fn handler_of(spec: &Value) -> ToolHandler<'static> {
    let body = spec.get("then").unwrap_or(spec);
    let then = Rc::new(if let Some(value) = body.get("returns") {
        Then::Returns(json_value_from_serde(value))
    } else if let Some(message) = body.get("throws") {
        Then::Throws(message.as_str().unwrap_or("").to_owned())
    } else if body.get("echo") == Some(&Value::Bool(true)) {
        Then::Echo
    } else if body.get("answers") == Some(&Value::Bool(true)) {
        Then::Answers
    } else if body.get("counter") == Some(&Value::Bool(true)) {
        Then::Counter(Rc::new(Cell::new(0.0)))
    } else {
        Then::Nothing
    });
    let awaits: Rc<Vec<AwaitSpec>> = Rc::new(
        spec.get("awaits")
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .map(|a| AwaitSpec {
                        control: Box::leak(
                            a["control"]
                                .as_str()
                                .unwrap_or("")
                                .to_owned()
                                .into_boxed_str(),
                        ),
                        method: Box::leak(
                            a["method"]
                                .as_str()
                                .unwrap_or("")
                                .to_owned()
                                .into_boxed_str(),
                        ),
                        args: a
                            .get("args")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
    );
    Box::new(move |args| tool_step(Rc::clone(&awaits), 0, args, Vec::new(), Rc::clone(&then)))
}

/// the tools a descriptor list names
fn tools_of(specs: &[Value]) -> Vec<McpToolDefinition<'static>> {
    specs
        .iter()
        .map(|spec| McpToolDefinition {
            name: spec["name"].as_str().unwrap_or("").to_owned(),
            description: spec["description"].as_str().unwrap_or("").to_owned(),
            input_schema: spec.get("schema").map(shape_of),
            handler: handler_of(spec.get("handler").unwrap_or(&Value::Null)),
        })
        .collect()
}

/// the calls a deferring server was handed: the session and the ticket, in call order
type Calls = Rc<RefCell<Vec<(Option<String>, Ticket)>>>;

/// the low-level `Server` of the `server` mode
fn session_server_of(spec: &Value, calls: Calls) -> Box<dyn SessionServer> {
    let info = json_value_from_serde(&Value::Object(object(vec![
        ("name", spec["name"].clone()),
        ("version", spec["version"].clone()),
    ])));
    let capabilities = match spec.get("capabilities") {
        Some(c) => json_value_from_serde(c),
        None => json_value_from_serde(&serde_json::json!({ "tools": {} })),
    };
    let instructions = spec
        .get("instructions")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut server = Server::new(
        info,
        ServerOptions {
            capabilities: Some(capabilities),
            instructions,
        },
    );
    let tools = json_value_from_serde(&spec["tools"]);
    server
        .set_request_handler(
            RequestSchema::ListTools,
            Box::new(move |_, _| {
                let mut out = jscompat::JsObject::new();
                out.set("tools", tools.clone());
                Ok(JsonValue::Object(out))
            }),
        )
        .expect("tools/list handler");
    let results = spec["results"].clone();
    let defer: Vec<String> = spec
        .get("defer")
        .and_then(Value::as_array)
        .map(|names| {
            names
                .iter()
                .filter_map(|n| n.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    server
        .set_deferred_request_handler(
            RequestSchema::CallTool,
            Box::new(move |request, extra| {
                let name = match request
                    .get("params")
                    .and_then(|p| p.get("name").map(|n| n.into_owned()))
                {
                    Some(JsonValue::String(name)) => name,
                    _ => String::new(),
                };
                if defer.contains(&name) {
                    calls
                        .borrow_mut()
                        .push((extra.session_id.clone(), extra.ticket));
                    return HandlerReply::Later(extra.ticket);
                }
                HandlerReply::Now(Ok(match results.get(&name) {
                    Some(result) => json_value_from_serde(result),
                    None => json_value_from_serde(&serde_json::json!({
                        "content": [{ "type": "text", "text": format!("no tool {name}") }],
                        "isError": true
                    })),
                }))
            }),
        )
        .expect("tools/call handler");
    Box::new(server)
}

// ---- normalization ---------------------------------------------------------

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn is_uuid_at(chars: &[char], at: usize) -> bool {
    if at + 36 > chars.len() {
        return false;
    }
    chars[at..at + 36].iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == '-',
        _ => c.is_ascii_digit() || ('a'..='f').contains(c),
    })
}

/// `text.replace(/\b<port>\b/g, '$PORT')`
fn replace_port(text: &str, port: f64) -> String {
    let needle = jscompat::number_to_string(port);
    let chars: Vec<char> = text.chars().collect();
    let needle_chars: Vec<char> = needle.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let end = i + needle_chars.len();
        let boundary_before = i == 0 || !is_word(chars[i - 1]);
        let boundary_after = end >= chars.len() || !is_word(chars[end]);
        if end <= chars.len()
            && chars[i..end] == needle_chars[..]
            && boundary_before
            && boundary_after
        {
            out.push_str("$PORT");
            i = end;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out
}

/// `text.replace(/\((\d+)ms\)/g, '(<n>ms)')`
fn replace_ms(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '(' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_ascii_digit() {
                j += 1;
            }
            if j > i + 1 && chars[j..].starts_with(&['m', 's', ')']) {
                out.push_str("(<n>ms)");
                i = j + 3;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

// ---- the world -------------------------------------------------------------

#[derive(Default)]
struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    text: String,
    head: bool,
    ended: bool,
    destroyed: bool,
}

struct Timer {
    id: TimerId,
    due: f64,
    every: Option<f64>,
}

enum Item {
    Cmd(Command),
    Listening(ListenerId, f64),
    ListenError(ListenerId, String),
    Closed(ListenerId),
    ResponseClosed(ResponseId),
    SocketClosed(SocketId),
}

struct World {
    service: McpServerService<'static>,
    ids: Vec<String>,
    logs: Vec<String>,
    responses: Vec<Resp>,
    timers: Vec<Timer>,
    clock: f64,
    blocked: bool,
    /// the ports servers of the service hold
    bound: Vec<(ListenerId, f64)>,
    port: f64,
    started: Vec<(StartId, Option<String>)>,
    stopped: Vec<(StopId, bool)>,
    open: Vec<(String, ResponseId, usize)>,
    calls: Calls,
    aborts: Vec<String>,
    /// the host calls tools awaited: session and ticket, in order of issue
    tool_calls: Vec<(String, Ticket)>,
    call_lines: Vec<String>,
}

fn frames_of(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut at = 0;
    while let Some(end) = text[at..].find("\n\n") {
        out.push(text[at..at + end + 2].to_owned());
        at += end + 2;
    }
    out
}

impl World {
    fn norm(&mut self, text: &str) -> String {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < chars.len() {
            if is_uuid_at(&chars, i) {
                let id: String = chars[i..i + 36].iter().collect();
                let at = match self.ids.iter().position(|known| *known == id) {
                    Some(at) => at,
                    None => {
                        self.ids.push(id);
                        self.ids.len() - 1
                    }
                };
                out.push_str(&format!("<sid{}>", at + 1));
                i += 36;
            } else {
                out.push(chars[i]);
                i += 1;
            }
        }
        let out = replace_port(&out, BOUND_PORT);
        let out = replace_port(&out, FIXED_PORT);
        replace_ms(&out)
    }

    /// `$PORT` and `$SID<n>` of a header or a path
    fn sub(&self, text: &str) -> String {
        let mut out = text.replace("$PORT", &jscompat::number_to_string(self.port));
        while let Some(at) = out.find("$SID") {
            let digits: String = out[at + 4..]
                .chars()
                .take_while(char::is_ascii_digit)
                .collect();
            let known = digits
                .parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1))
                .and_then(|n| self.ids.get(n))
                .cloned()
                .unwrap_or_else(|| "unknown".to_owned());
            out.replace_range(at..at + 4 + digits.len(), &known);
        }
        out
    }

    /// carries the commands out, and what they make happen
    fn run(&mut self, commands: Vec<Command>) {
        let queue: VecDeque<Item> = commands.into_iter().map(Item::Cmd).collect();
        self.drain(queue);
    }

    /// carries out the items, and the items they lead to
    fn drain(&mut self, mut queue: VecDeque<Item>) {
        while let Some(item) = queue.pop_front() {
            let more = match item {
                Item::Cmd(command) => self.apply(command, &mut queue),
                Item::Listening(listener, port) => self.service.on_listening(listener, port),
                Item::ListenError(listener, message) => {
                    self.service
                        .on_listen_error(listener, Some("EADDRINUSE"), &message)
                }
                Item::Closed(listener) => self.service.on_listener_closed(listener),
                Item::ResponseClosed(res) => self.service.on_response_closed(res),
                Item::SocketClosed(socket) => {
                    self.service.on_socket_closed(socket);
                    Vec::new()
                }
            };
            queue.extend(more.into_iter().map(Item::Cmd));
        }
    }

    fn resp(&mut self, res: ResponseId) -> &mut Resp {
        while self.responses.len() <= res.0 as usize {
            self.responses.push(Resp::default());
        }
        &mut self.responses[res.0 as usize]
    }

    fn apply(&mut self, command: Command, queue: &mut VecDeque<Item>) -> Vec<Command> {
        match command {
            Command::Respond {
                res,
                status,
                headers,
            } => {
                let resp = self.resp(res);
                if !resp.destroyed && !resp.head {
                    resp.status = status;
                    resp.headers = headers;
                    resp.head = true;
                }
            }
            Command::Write { res, chunk } => {
                let resp = self.resp(res);
                if !resp.destroyed && !resp.ended {
                    resp.text.push_str(&chunk);
                }
            }
            Command::End { res, chunk } => {
                let resp = self.resp(res);
                if !resp.destroyed && !resp.ended {
                    if let Some(chunk) = chunk {
                        resp.text.push_str(&chunk);
                    }
                    resp.ended = true;
                    queue.push_back(Item::ResponseClosed(res));
                    queue.push_back(Item::SocketClosed(SocketId(res.0)));
                }
            }
            Command::Destroy { res } => self.destroy(res, queue),
            Command::DestroySocket { socket } => self.destroy(ResponseId(socket.0), queue),
            Command::SetInterval { timer, ms } => self.timers.push(Timer {
                id: timer,
                due: self.clock + ms,
                every: Some(ms),
            }),
            Command::SetTimeout { timer, ms } => self.timers.push(Timer {
                id: timer,
                due: self.clock + ms,
                every: None,
            }),
            Command::ClearTimer { timer } => self.timers.retain(|t| t.id != timer),
            Command::Listen { listener, port } => {
                let bound = if port == 0.0 { BOUND_PORT } else { port };
                let taken = self.bound.iter().any(|(_, held)| *held == bound);
                if (self.blocked && port == FIXED_PORT) || taken {
                    queue.push_back(Item::ListenError(
                        listener,
                        format!(
                            "Error: listen EADDRINUSE: address already in use 127.0.0.1:{}",
                            jscompat::number_to_string(port)
                        ),
                    ));
                } else {
                    self.bound.push((listener, bound));
                    queue.push_back(Item::Listening(listener, bound));
                }
            }
            Command::CloseListener { listener } => {
                self.bound.retain(|(held, _)| *held != listener);
                queue.push_back(Item::Closed(listener));
            }
            Command::ToolCall {
                session_id,
                ticket,
                call,
            } => {
                self.tool_calls.push((session_id, ticket));
                self.call_lines.push(format!(
                    "call {}: {}.{} {}",
                    self.tool_calls.len(),
                    call.control,
                    call.method,
                    json_stringify(&JsonValue::Array(call.args))
                ));
            }
            Command::Aborted(aborted) => {
                let n = self
                    .calls
                    .borrow()
                    .iter()
                    .position(|(sid, ticket)| {
                        *sid == aborted.session_id && *ticket == aborted.ticket
                    })
                    .map_or(0, |at| at + 1);
                let why = match aborted.cause {
                    AbortCause::Cancelled {
                        reason: Some(reason),
                    } => format!(" {reason}"),
                    _ => String::new(),
                };
                self.aborts.push(format!("call {n}: aborted{why}"));
            }
            Command::Log(line) => {
                let line = self.norm(&line);
                self.logs.push(line);
            }
            Command::StartSettled { start, outcome } => {
                let shown = match outcome {
                    Ok(()) => "resolved".to_owned(),
                    Err(error) => format!("rejected {}", error.text),
                };
                if let Some(entry) = self.started.iter_mut().find(|(id, _)| *id == start) {
                    entry.1 = Some(shown);
                }
            }
            Command::StopSettled { stop } => {
                if let Some(entry) = self.stopped.iter_mut().find(|(id, _)| *id == stop) {
                    entry.1 = true;
                }
            }
        }
        Vec::new()
    }

    fn destroy(&mut self, res: ResponseId, queue: &mut VecDeque<Item>) {
        let resp = self.resp(res);
        if !resp.destroyed && !resp.ended {
            resp.destroyed = true;
            queue.push_back(Item::ResponseClosed(res));
            queue.push_back(Item::SocketClosed(SocketId(res.0)));
        }
    }

    /// `mock.timers.tick(ms)`
    fn tick(&mut self, ms: f64) {
        let target = self.clock + ms;
        let mut deferred: VecDeque<Item> = VecDeque::new();
        loop {
            let next = self
                .timers
                .iter()
                .filter(|t| t.due <= target)
                .min_by(|a, b| {
                    a.due
                        .partial_cmp(&b.due)
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .map(|t| (t.id, t.due, t.every));
            let Some((id, due, every)) = next else {
                break;
            };
            self.clock = due;
            match every {
                Some(every) => {
                    if let Some(t) = self.timers.iter_mut().find(|t| t.id == id) {
                        t.due = due + every;
                    }
                }
                None => self.timers.retain(|t| t.id != id),
            }
            // every timer that is due fires before the sockets answer
            for command in self.service.on_timer(id) {
                self.apply(command, &mut deferred);
            }
        }
        self.clock = target;
        self.drain(deferred);
    }

    fn headers_of(&mut self, headers: &[(String, String)]) -> Value {
        let sse = headers
            .iter()
            .any(|(k, v)| k == "content-type" && v.starts_with("text/event-stream"));
        let mut sorted: Vec<&(String, String)> = headers.iter().collect();
        sorted.sort_by(|a, b| a.0.cmp(&b.0));
        let mut out = Map::new();
        for (key, value) in sorted {
            if ["date", "content-length", "transfer-encoding", "keep-alive"].contains(&key.as_str())
            {
                continue;
            }
            if key == "connection" && !sse {
                continue;
            }
            let shown = self.norm(value);
            out.insert(key.clone(), Value::String(shown));
        }
        Value::Object(out)
    }

    fn http(&mut self, step: &Value) -> Vec<(&'static str, Value)> {
        // nothing listens: the connection is refused
        if !self.service.is_running() {
            return vec![("error", text("aborted"))];
        }
        let res = ResponseId(self.responses.len() as u64);
        self.responses.push(Resp::default());
        let mut headers: Vec<(String, String)> = Vec::new();
        if let Some(Value::Object(given)) = step.get("headers") {
            for (key, value) in given {
                let shown = self.sub(value.as_str().unwrap_or(""));
                headers.push((key.to_lowercase(), shown));
            }
        }
        let body: Option<String> = if let Some(json) = step.get("json") {
            let mut out = String::new();
            print_js(json, &mut out);
            Some(out)
        } else if let Some(Value::String(raw)) = step.get("text") {
            Some(raw.clone())
        } else if let Some(Value::Array(pair)) = step.get("repeat") {
            let chunk = pair.first().and_then(Value::as_str).unwrap_or("");
            let count = pair.get(1).and_then(Value::as_f64).unwrap_or(0.0) as usize;
            Some(chunk.repeat(count))
        } else {
            None
        };
        // an empty Host header is the client's own
        headers.retain(|(k, v)| !(k == "host" && v.is_empty()));
        if !headers.iter().any(|(k, _)| k == "host") {
            headers.insert(
                0,
                (
                    "host".to_owned(),
                    format!("127.0.0.1:{}", jscompat::number_to_string(self.port)),
                ),
            );
        }
        let bytes = body.unwrap_or_default().into_bytes();
        let has_body = step.get("json").is_some()
            || step.get("text").is_some()
            || step.get("repeat").is_some();
        if has_body {
            headers.push(("content-length".to_owned(), bytes.len().to_string()));
        }
        let request = HttpRequest {
            method: step["method"].as_str().unwrap_or("GET").to_owned(),
            url: self.sub(step["path"].as_str().unwrap_or("/")),
            headers,
        };
        self.service.on_connection(SocketId(res.0));
        let commands = self.service.on_request(res, &request, &bytes);
        self.run(commands);

        let frames_wanted = step
            .get("frames")
            .and_then(Value::as_f64)
            .map(|n| n as usize);
        let open_name = step.get("open").and_then(Value::as_str).map(str::to_owned);
        let (status, head, destroyed, ended, text_so_far, resp_headers) = {
            let resp = self.resp(res);
            (
                resp.status,
                resp.head,
                resp.destroyed,
                resp.ended,
                resp.text.clone(),
                resp.headers.clone(),
            )
        };
        if destroyed && !head {
            return vec![("error", text("aborted"))];
        }
        let list = frames_of(&text_so_far);
        let shown: Option<Vec<String>> =
            frames_wanted.map(|n| list.iter().take(n).cloned().collect());
        let mut out: Vec<(&'static str, Value)> = vec![
            ("status", Value::from(status)),
            ("headers", self.headers_of(&resp_headers)),
        ];
        if ended {
            out.push(("body", Value::String(self.norm(&text_so_far))));
        } else if let Some(shown) = &shown {
            let normed: Vec<Value> = shown
                .iter()
                .map(|frame| Value::String(self.norm(frame)))
                .collect();
            out.push(("frames", Value::Array(normed)));
        } else {
            out.push(("partial", Value::String(self.norm(&text_so_far))));
        }
        if !ended {
            out.push(("ended", Value::Bool(false)));
        }
        if let Some(name) = open_name {
            let taken = shown.as_ref().map_or(list.len(), Vec::len);
            self.open.retain(|(n, _, _)| *n != name);
            self.open.push((name, res, taken));
        } else if !ended {
            self.destroy_now(res);
        }
        out
    }

    fn destroy_now(&mut self, res: ResponseId) {
        let mut queue = VecDeque::new();
        self.destroy(res, &mut queue);
        let mut commands = Vec::new();
        while let Some(item) = queue.pop_front() {
            match item {
                Item::ResponseClosed(res) => commands.extend(self.service.on_response_closed(res)),
                Item::SocketClosed(socket) => self.service.on_socket_closed(socket),
                _ => {}
            }
        }
        self.run(commands);
    }

    fn read(&mut self, step: &Value) -> Vec<(&'static str, Value)> {
        let id = step["id"].as_str().unwrap_or("");
        let at = self.open.iter().position(|(n, _, _)| n == id);
        let Some(at) = at else {
            return Vec::new();
        };
        let (_, res, taken) = self.open[at].clone();
        let (text_so_far, ended) = {
            let resp = self.resp(res);
            (resp.text.clone(), resp.ended)
        };
        let list = frames_of(&text_so_far);
        let want = step
            .get("frames")
            .and_then(Value::as_f64)
            .map_or(list.len().saturating_sub(taken), |n| n as usize);
        let shown: Vec<String> = list.iter().skip(taken).take(want).cloned().collect();
        self.open[at].2 = taken + shown.len();
        let normed: Vec<Value> = shown
            .iter()
            .map(|frame| Value::String(self.norm(frame)))
            .collect();
        let mut out = vec![("frames", Value::Array(normed))];
        if ended {
            out.push(("ended", Value::Bool(true)));
        }
        out
    }
}

/// `mcp-server.scenario`
fn scenario(spec: &Value) -> Answer {
    let tool_specs: Vec<Value> = spec
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mode = spec.get("mode").and_then(Value::as_str).unwrap_or("tools");
    let calls: Calls = Rc::new(RefCell::new(Vec::new()));
    let mut options = McpServerServiceOptions {
        port: 0.0,
        tools: None,
        tools_factory: None,
        server_factory: None,
        version: spec
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_owned),
        max_listen_attempts: spec.get("maxListenAttempts").and_then(Value::as_f64),
        listen_retry_delay_ms: spec.get("listenRetryDelayMs").and_then(Value::as_f64),
        token: spec.get("token").and_then(Value::as_str).map(str::to_owned),
    };
    match mode {
        "server" => {
            let server_spec = spec.get("server").cloned().unwrap_or(Value::Null);
            let shared = Rc::clone(&calls);
            options.server_factory = Some(Box::new(move || {
                session_server_of(&server_spec, Rc::clone(&shared))
            }));
        }
        "factory" => {
            options.tools_factory = Some(Box::new(move || tools_of(&tool_specs)));
        }
        _ => options.tools = Some(tools_of(&tool_specs)),
    }
    let service = McpServerService::new(
        options,
        Box::new(FakeHost {
            uuids: Cell::new(0),
        }),
    );
    let mut world = World {
        service,
        ids: Vec::new(),
        logs: Vec::new(),
        responses: Vec::new(),
        timers: Vec::new(),
        clock: 0.0,
        blocked: false,
        bound: Vec::new(),
        port: 0.0,
        started: Vec::new(),
        stopped: Vec::new(),
        open: Vec::new(),
        calls: Rc::clone(&calls),
        aborts: Vec::new(),
        tool_calls: Vec::new(),
        call_lines: Vec::new(),
    };
    if spec.get("start") != Some(&Value::Bool(false)) {
        let (_, commands) = world.service.start(Some(0.0));
        world.run(commands);
        world.port = world.service.get_port();
    }
    let mut results: Vec<Value> = Vec::new();
    let first = std::mem::take(&mut world.logs);
    let mut init = object(vec![("op", text("init"))]);
    if !first.is_empty() {
        init.insert(
            "logs".to_owned(),
            Value::Array(first.into_iter().map(Value::String).collect()),
        );
    }
    results.push(Value::Object(init));

    let steps = spec
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for step in &steps {
        let op = step["op"].as_str().unwrap_or("");
        let mut out = object(vec![("op", text(op))]);
        match op {
            "http" => {
                for (key, value) in world.http(step) {
                    out.insert(key.to_owned(), value);
                }
            }
            "read" => {
                for (key, value) in world.read(step) {
                    out.insert(key.to_owned(), value);
                }
            }
            "close" => {
                let id = step["id"].as_str().unwrap_or("");
                if let Some(at) = world.open.iter().position(|(n, _, _)| n == id) {
                    let (_, res, _) = world.open.remove(at);
                    world.destroy_now(res);
                }
            }
            "tick" => world.tick(step["ms"].as_f64().unwrap_or(0.0)),
            "block" => world.blocked = true,
            "unblock" => world.blocked = false,
            "start" => {
                let port = if step.get("fixed") == Some(&Value::Bool(true)) {
                    FIXED_PORT
                } else {
                    0.0
                };
                let (id, commands) = world.service.start(Some(port));
                world.started.push((id, None));
                world.run(commands);
                if world.service.is_running() {
                    world.port = world.service.get_port();
                }
            }
            "stop" => {
                let (id, commands) = world.service.stop();
                world.stopped.push((id, false));
                world.run(commands);
            }
            "resume" => {
                let n = step["call"].as_f64().unwrap_or(0.0) as usize;
                let (session, ticket) = world.tool_calls[n - 1].clone();
                let answer: Settled = if let Some(message) = step.get("error") {
                    Err(message.as_str().unwrap_or("").to_owned())
                } else {
                    Ok(step.get("result").map(json_value_from_serde))
                };
                let commands = world.service.resume_tool(&session, ticket, answer);
                world.run(commands);
            }
            "settle" => {
                let n = step["call"].as_f64().unwrap_or(0.0) as usize;
                let (session, ticket) = world.calls.borrow()[n - 1].clone();
                let result = if step.get("error").is_some() {
                    Err(HandlerError {
                        code: step.get("code").and_then(Value::as_f64),
                        message: Some(step["error"].as_str().unwrap_or("").to_owned()),
                        data: None,
                    })
                } else {
                    Ok(json_value_from_serde(
                        step.get("result").unwrap_or(&Value::Null),
                    ))
                };
                let commands =
                    world
                        .service
                        .settle(session.as_deref().unwrap_or(""), ticket, result);
                world.run(commands);
            }
            "state" => {
                let port = world.service.get_port();
                out.insert(
                    "running".to_owned(),
                    Value::Bool(world.service.is_running()),
                );
                out.insert(
                    "port".to_owned(),
                    if port != 0.0 && (port == BOUND_PORT || port == FIXED_PORT) {
                        text("$PORT")
                    } else {
                        Value::from(port)
                    },
                );
                let url = world.service.get_url();
                out.insert("url".to_owned(), Value::String(world.norm(&url)));
            }
            other => {
                return Err(CallError::plain(format!("unknown step {other}")));
            }
        }
        if world.service.is_running() {
            world.port = world.service.get_port();
        }
        let mut settled: Vec<(usize, String)> = Vec::new();
        for (i, entry) in world.started.iter_mut().enumerate() {
            if let Some(outcome) = entry.1.take() {
                settled.push((i, outcome));
            }
        }
        for (i, outcome) in settled {
            let shown = world.norm(&outcome);
            out.insert(format!("start{}", i + 1), Value::String(shown));
        }
        let mut reported: Vec<(usize, Value)> = Vec::new();
        for (i, entry) in world.stopped.iter_mut().enumerate() {
            if entry.1 {
                reported.push((i, text("resolved")));
                entry.1 = false;
            }
        }
        for (i, value) in reported {
            out.insert(format!("stop{}", i + 1), value);
        }
        if !world.aborts.is_empty() {
            let lines = std::mem::take(&mut world.aborts);
            out.insert(
                "aborts".to_owned(),
                Value::Array(lines.into_iter().map(Value::String).collect()),
            );
        }
        if !world.call_lines.is_empty() {
            let lines = std::mem::take(&mut world.call_lines);
            out.insert(
                "calls".to_owned(),
                Value::Array(lines.into_iter().map(Value::String).collect()),
            );
        }
        let lines = std::mem::take(&mut world.logs);
        if !lines.is_empty() {
            out.insert(
                "logs".to_owned(),
                Value::Array(lines.into_iter().map(Value::String).collect()),
            );
        }
        results.push(Value::Object(out));
    }
    Ok(Some(Value::Array(results)))
}

pub(super) fn call(name: &str, args: &[Value], _cx: &mut Context) -> Option<Answer> {
    match name {
        "mcp-server.scenario" => Some(match arg(args, 0) {
            Some(spec) => scenario(spec),
            None => Err(CallError::plain("argument 0 is missing")),
        }),
        _ => None,
    }
}
