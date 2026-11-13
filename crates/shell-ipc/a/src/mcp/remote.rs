//! A remote MCP server's connection (`remote.ts`) on a thread of its own.
//!
//! [`RemoteProxy`] is what the hub on the core thread holds: every operation
//! is a message to the actor, which drives main-core's
//! [`HubRemote`](main_core::shell::mcp_client::remote::HubRemote) over a
//! blocking host ([`RemoteWorld`]): requests through the batch's
//! [`McpNet`], the loopback server of a sign-in on `std::net`, timers on the
//! actor's own [`TimerQueue`]. What the connection settles (and a changed
//! tool list) is posted back to the core thread.
//!
//! One request of a connection runs at a time (main-core's design: a host
//! call blocks), so an abort or a second call waits in the mailbox while the
//! actor is inside a request; the request's own time limit bounds that wait.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use jscompat::JsonValue;
use main_core::packages::electron_utils::safe_external_url::safe_external_url;
use main_core::packages::i18n::PRODUCT_NAME;
use main_core::packages::mcp_sdk::auth::AuthHost;
use main_core::packages::mcp_sdk::client::OutputCheck;
use main_core::packages::mcp_sdk::client::net::{
    Body, FetchError, FetchHost, FetchInit, FetchResponse,
};
use main_core::shell::mcp_client::address::ResolveFailed;
use main_core::shell::mcp_client::hub::{
    ConnError, ConnId, ConnOutcome, RemoteConnection, RemoteReason, SignInOptions, SignInResult,
};
use main_core::shell::mcp_client::hub_strings::McpSignInPages;
use main_core::shell::mcp_client::limits::MCP_CALL_TIMEOUT_MS;
use main_core::shell::mcp_client::oauth::{McpOAuthAccess, NetHost, SignInHost};
use main_core::shell::mcp_client::oauth_loopback::{LoopbackHost, LoopbackResponse};
use main_core::shell::mcp_client::remote::{
    HubRemote, RemoteHost, RemoteMcpConnectionOptions, RemoteServerSettings,
};
use main_core::shell::mcp_client::store::{McpOAuthConfig, McpServerConfig};
use shell_contract::hosts::OsShellHost;

use super::actor::{CoreLink, Step, TimerQueue, run_loop};
use super::net::{McpNetHost, NetBody};

/// the longest body read whole (a JSON answer); an event stream is not read whole
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// What the core thread tells the actor, and what the actor's helper threads
/// tell it
pub enum Msg {
    List(u64),
    Call(u64, String, JsonValue),
    SignIn(u64, McpSignInPages),
    Revoke(u64),
    Close(u64),
    Abort(u64),
    /// a chunk, the end or a failure of an event stream
    Stream(u64, StreamEvent),
    /// a request reached a sign-in's loopback server
    Loopback(Loopback),
    Shutdown,
}

pub enum StreamEvent {
    Chunk(Vec<u8>),
    End,
    Failed(FetchError),
}

pub struct Loopback {
    port: u16,
    method: String,
    target: String,
    stream: TcpStream,
}

/// The hub's view of a remote connection
pub struct RemoteProxy {
    tx: Sender<Msg>,
    needs_sign_in: Arc<AtomicBool>,
}

impl RemoteProxy {
    /// Starts the actor of the connection `conn` to `server`
    pub fn spawn(
        conn: ConnId,
        server: &McpServerConfig,
        client_version: &str,
        world: RemoteWorldDeps,
    ) -> RemoteProxy {
        let (tx, rx) = channel();
        let needs_sign_in = Arc::new(AtomicBool::new(false));
        let options = RemoteMcpConnectionOptions {
            server: RemoteServerSettings {
                name: server.name.clone(),
                url: server.url.clone(),
                transport: server.transport,
                headers: server.headers.clone(),
            },
            client_name: Some(PRODUCT_NAME.to_owned()),
            client_version: client_version.to_owned(),
            call_timeout_ms: None,
        };
        let actor = Actor {
            conn,
            server_id: server.id.clone(),
            options,
            deps: world,
            tx: tx.clone(),
            needs_sign_in: needs_sign_in.clone(),
        };
        let started = std::thread::Builder::new()
            .name("mcp-remote".to_owned())
            .spawn(move || actor.run(rx));
        if let Err(error) = started {
            eprintln!("mcp: no thread for a remote connection: {error}");
        }
        RemoteProxy { tx, needs_sign_in }
    }

    fn send(&self, msg: Msg) {
        let _ = self.tx.send(msg);
    }
}

impl Drop for RemoteProxy {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Shutdown);
    }
}

impl RemoteConnection<'static> for RemoteProxy {
    fn list_tools(&mut self, op: u64) {
        self.send(Msg::List(op));
    }

    fn call_tool(&mut self, op: u64, name: &str, args: &JsonValue) {
        self.send(Msg::Call(op, name.to_owned(), args.clone()));
    }

    fn needs_sign_in(&self) -> bool {
        self.needs_sign_in.load(Ordering::SeqCst)
    }

    fn sign_in(&mut self, op: u64, options: SignInOptions<'static>) {
        // the browser is opened by the actor itself (the shared OS shell host),
        // as `deps.openExternal` does
        self.send(Msg::SignIn(op, options.pages));
    }

    fn revoke(&mut self, op: u64) {
        self.send(Msg::Revoke(op));
    }

    fn close(&mut self, op: u64) {
        self.send(Msg::Close(op));
    }

    fn abort(&mut self, op: u64) {
        self.send(Msg::Abort(op));
    }
}

/// What the actor's world needs from the shell
#[derive(Clone)]
pub struct RemoteWorldDeps {
    pub net: McpNetHost,
    pub os_shell: OsShellHost,
    pub link: CoreLink,
}

struct Actor {
    conn: ConnId,
    server_id: String,
    options: RemoteMcpConnectionOptions,
    deps: RemoteWorldDeps,
    tx: Sender<Msg>,
    needs_sign_in: Arc<AtomicBool>,
}

/// `deps.openExternal(url)`: the system browser; `false` when it did not open
pub fn open_in_browser(os_shell: &OsShellHost, url: &str) -> bool {
    let Some(target) = safe_external_url(Some(url), None) else {
        return false;
    };
    os_shell.open_external(&target).is_ok()
}

impl Actor {
    fn run(self, rx: Receiver<Msg>) {
        let timers = Rc::new(RefCell::new(TimerQueue::default()));
        let requests: Rc<RefCell<HashMap<u16, TcpStream>>> = Rc::default();
        let world = RemoteWorld {
            deps: self.deps.clone(),
            server_id: self.server_id.clone(),
            tx: self.tx.clone(),
            timers: timers.clone(),
            requests: requests.clone(),
            listeners: HashMap::new(),
            streams: HashMap::new(),
            next_stream: 0,
        };
        let remote = match HubRemote::new(self.options.clone(), Box::new(world)) {
            Ok(remote) => remote,
            Err(_) => return self.run_broken(rx),
        };
        let mut conn = remote.clone();
        let open_url = {
            let os_shell = self.deps.os_shell.clone();
            Rc::new(move |url: &str| open_in_browser(&os_shell, url))
        };
        let after = |remote: &HubRemote<'_>| {
            self.needs_sign_in
                .store(RemoteConnection::needs_sign_in(remote), Ordering::SeqCst);
            let settled = remote.take_settled();
            let changed = remote.take_tools_changed();
            deliver(&self.deps.link, self.conn, settled, changed);
        };
        run_loop(
            &rx,
            &timers,
            |msg| {
                match msg {
                    Msg::List(op) => conn.list_tools(op),
                    Msg::Call(op, name, args) => conn.call_tool(op, &name, &args),
                    Msg::SignIn(op, pages) => conn.sign_in(
                        op,
                        SignInOptions {
                            open_external: open_url.clone(),
                            pages,
                        },
                    ),
                    Msg::Revoke(op) => conn.revoke(op),
                    Msg::Close(op) => conn.close(op),
                    Msg::Abort(op) => conn.abort(op),
                    Msg::Stream(stream, event) => match event {
                        StreamEvent::Chunk(bytes) => remote.on_stream_chunk(stream, &bytes),
                        StreamEvent::End => remote.on_stream_end(stream),
                        StreamEvent::Failed(error) => remote.on_stream_error(stream, &error),
                    },
                    Msg::Loopback(request) => {
                        let Loopback {
                            port,
                            method,
                            target,
                            stream,
                        } = request;
                        requests.borrow_mut().insert(port, stream);
                        let routed = remote.on_loopback_request(port, &method, &target);
                        // a request no sign-in wants is answered "not found"
                        if !routed && let Some(mut stream) = requests.borrow_mut().remove(&port) {
                            write_response(
                                &mut stream,
                                &LoopbackResponse {
                                    status: 404,
                                    headers: Vec::new(),
                                    body: None,
                                },
                            );
                        }
                    }
                    Msg::Shutdown => return Step::Stop,
                }
                after(&remote);
                Step::Go
            },
            |timer| {
                remote.on_timeout(timer);
                after(&remote);
            },
            || {},
        );
    }

    /// A connection that could not be made (an address that is no URL): every
    /// operation fails the way an unreachable server does
    fn run_broken(self, rx: Receiver<Msg>) {
        while let Ok(msg) = rx.recv() {
            let outcome = match msg {
                Msg::List(op) => (
                    op,
                    ConnOutcome::Listed(Err(ConnError::Remote(RemoteReason::Unreachable))),
                ),
                Msg::Call(op, ..) => (
                    op,
                    ConnOutcome::RemoteCalled(Err(ConnError::Remote(RemoteReason::Unreachable))),
                ),
                Msg::SignIn(op, _) => (
                    op,
                    ConnOutcome::SignedIn(SignInResult::Failed("network".to_owned())),
                ),
                Msg::Revoke(op) => (op, ConnOutcome::Revoked),
                Msg::Close(op) => (op, ConnOutcome::Closed),
                Msg::Shutdown => return,
                _ => continue,
            };
            deliver(&self.deps.link, self.conn, vec![outcome], false);
        }
    }
}

fn deliver(link: &CoreLink, conn: ConnId, settled: Vec<(u64, ConnOutcome)>, changed: bool) {
    if settled.is_empty() && !changed {
        return;
    }
    link.post(move |hub| hub.connection_reported(conn, settled, changed));
}

// ---- the blocking host of the connection -------------------------------------

struct Listener {
    stop: Arc<AtomicBool>,
}

struct RemoteWorld {
    deps: RemoteWorldDeps,
    server_id: String,
    tx: Sender<Msg>,
    timers: Rc<RefCell<TimerQueue>>,
    /// the request of each loopback server being answered
    requests: Rc<RefCell<HashMap<u16, TcpStream>>>,
    listeners: HashMap<u16, Listener>,
    /// event streams under way: set to stop reading one
    streams: HashMap<u64, Arc<AtomicBool>>,
    next_stream: u64,
}

impl RemoteWorld {
    fn start_stream(&mut self, mut body: Box<dyn NetBody>) -> u64 {
        self.next_stream += 1;
        let id = self.next_stream;
        let cancelled = Arc::new(AtomicBool::new(false));
        self.streams.insert(id, cancelled.clone());
        let tx = self.tx.clone();
        let spawned = std::thread::Builder::new()
            .name("mcp-stream".to_owned())
            .spawn(move || {
                loop {
                    let event = match body.next_chunk() {
                        Ok(Some(chunk)) => StreamEvent::Chunk(chunk),
                        Ok(None) => StreamEvent::End,
                        Err(error) => StreamEvent::Failed(error),
                    };
                    let over = !matches!(event, StreamEvent::Chunk(_));
                    if cancelled.load(Ordering::SeqCst) || tx.send(Msg::Stream(id, event)).is_err()
                    {
                        return;
                    }
                    if over {
                        return;
                    }
                }
            });
        if spawned.is_err() {
            let _ = self.tx.send(Msg::Stream(
                id,
                StreamEvent::Failed(FetchError::type_error("no thread to read the stream")),
            ));
        }
        id
    }
}

fn is_event_stream(response: &super::net::NetResponse) -> bool {
    (200..300).contains(&response.status)
        && response.headers.get("content-type").is_some_and(|value| {
            value
                .trim_start()
                .to_ascii_lowercase()
                .starts_with("text/event-stream")
        })
}

impl FetchHost for RemoteWorld {
    fn fetch(&mut self, url: &str, init: &FetchInit) -> Result<FetchResponse, FetchError> {
        // a request that never answers ends when a call would
        self.fetch_limited(url, init, Some(MCP_CALL_TIMEOUT_MS))
    }

    fn read_body(&mut self, _stream: u64) -> Result<Vec<u8>, FetchError> {
        // only event streams are streams here; every other body is read whole
        Err(FetchError::type_error("the body is read as it arrives"))
    }

    fn cancel_body(&mut self, stream: u64) {
        if let Some(cancelled) = self.streams.remove(&stream) {
            cancelled.store(true, Ordering::SeqCst);
        }
    }

    fn abort_body(&mut self, stream: u64) {
        self.cancel_body(stream);
    }
}

impl AuthHost for RemoteWorld {
    fn random_bytes(&mut self, len: usize) -> Vec<u8> {
        let mut bytes = vec![0u8; len];
        let _ = getrandom::fill(&mut bytes);
        bytes
    }
}

impl NetHost for RemoteWorld {
    fn fetch_limited(
        &mut self,
        url: &str,
        init: &FetchInit,
        limit_ms: Option<f64>,
    ) -> Result<FetchResponse, FetchError> {
        let mut response = self.deps.net.fetch(url, init, limit_ms)?;
        let body = if is_event_stream(&response) {
            match response.body.take() {
                Some(body) => Body::Stream(self.start_stream(body)),
                None => Body::None,
            }
        } else {
            match response.body.take() {
                None => Body::None,
                Some(mut body) => {
                    let mut bytes = Vec::new();
                    while let Some(chunk) = body.next_chunk()? {
                        if bytes.len() + chunk.len() > MAX_BODY_BYTES {
                            return Err(FetchError::type_error("the response body is too large"));
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    Body::Bytes(bytes)
                }
            }
        };
        Ok(FetchResponse {
            status: response.status,
            status_text: response.status_text,
            headers: response.headers,
            url: response.url,
            redirected: response.redirected,
            opaque_redirect: response.opaque_redirect,
            body,
        })
    }

    fn resolve_host(&mut self, host: &str) -> Result<Vec<String>, ResolveFailed> {
        let bare = host.trim_start_matches('[').trim_end_matches(']');
        if let Ok(ip) = bare.parse::<IpAddr>() {
            return Ok(vec![ip.to_string()]);
        }
        (bare, 0)
            .to_socket_addrs()
            .map(|addresses| addresses.map(|a| a.ip().to_string()).collect())
            .map_err(|error| ResolveFailed(error.to_string()))
    }

    fn now(&mut self) -> f64 {
        now_ms()
    }
}

pub fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn status_text(status: u16) -> &'static str {
    match status {
        200 => "OK",
        302 => "Found",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    }
}

/// `res.writeHead(status, headers)` and `res.end(body)`
fn write_response(stream: &mut TcpStream, response: &LoopbackResponse) {
    let body = response.body.as_deref().unwrap_or("");
    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        response.status,
        status_text(response.status)
    );
    let mut has_length = false;
    for (name, value) in &response.headers {
        has_length |= name.eq_ignore_ascii_case("content-length");
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if !has_length {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    head.push_str("Connection: close\r\n\r\n");
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(body.as_bytes());
    let _ = stream.flush();
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

/// The request line of what a browser sent to the loopback server
fn read_request(stream: &mut TcpStream) -> Option<(String, String)> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut head = Vec::new();
    let mut buffer = [0u8; 1024];
    while head.len() < 16 * 1024 && !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => head.extend_from_slice(&buffer[..n]),
        }
    }
    let text = String::from_utf8_lossy(&head);
    let mut parts = text.lines().next()?.split_whitespace();
    let method = parts.next()?.to_owned();
    let target = parts.next()?.to_owned();
    Some((method, target))
}

impl LoopbackHost for RemoteWorld {
    fn listen(&mut self) -> Result<u16, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let tx = self.tx.clone();
        std::thread::Builder::new()
            .name("mcp-loopback".to_owned())
            .spawn(move || {
                while !flag.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut stream, _)) => {
                            let _ = stream.set_nonblocking(false);
                            if let Some((method, target)) = read_request(&mut stream) {
                                let request = Loopback {
                                    port,
                                    method,
                                    target,
                                    stream,
                                };
                                if tx.send(Msg::Loopback(request)).is_err() {
                                    return;
                                }
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(20));
                        }
                        Err(_) => return,
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        self.listeners.insert(port, Listener { stop });
        Ok(port)
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        self.timers.borrow_mut().add(ms)
    }

    fn clear_timeout(&mut self, timer: u64) {
        self.timers.borrow_mut().cancel(timer);
    }

    fn respond(&mut self, port: u16, response: &LoopbackResponse) {
        if let Some(mut stream) = self.requests.borrow_mut().remove(&port) {
            write_response(&mut stream, response);
        }
    }

    fn close_server(&mut self, port: u16) {
        if let Some(listener) = self.listeners.remove(&port) {
            listener.stop.store(true, Ordering::SeqCst);
        }
    }

    fn close_idle_connections(&mut self, _port: u16) {}

    fn close_all_connections(&mut self, port: u16) {
        if let Some(stream) = self.requests.borrow_mut().remove(&port) {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
}

impl SignInHost for RemoteWorld {}

impl McpOAuthAccess for RemoteWorld {
    fn read(&mut self) -> Option<McpOAuthConfig> {
        let id = self.server_id.clone();
        self.deps.link.ask(move |hub| hub.oauth_read(&id)).flatten()
    }

    fn write_tokens(&mut self, tokens: &str) -> Result<(), String> {
        let id = self.server_id.clone();
        let tokens = tokens.to_owned();
        self.deps
            .link
            .ask(move |hub| hub.oauth_write(&id, &tokens))
            .unwrap_or_else(|| Err("the app is closing".to_owned()))
    }
}

impl RemoteHost for RemoteWorld {
    fn compile_output_schema(&mut self, schema: &JsonValue) -> Result<u64, String> {
        self.deps.net.compile_output_schema(schema)
    }

    fn validate_output(&mut self, validator: u64, structured_content: &JsonValue) -> OutputCheck {
        self.deps.net.validate_output(validator, structured_content)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;
    use std::sync::mpsc::RecvTimeoutError;

    use main_core::packages::mcp_sdk::client::net::Headers;

    use super::super::net::{McpNet, NetResponse};
    use super::super::testing::{Os, Rig};
    use super::*;

    struct Chunks(std::vec::IntoIter<Vec<u8>>);

    impl NetBody for Chunks {
        fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, FetchError> {
            Ok(self.0.next())
        }
    }

    /// answers every request with a body in chunks and the content type it is given
    struct Canned {
        content_type: &'static str,
        chunks: Vec<Vec<u8>>,
        seen: Mutex<Vec<Option<f64>>>,
    }

    impl McpNet for Canned {
        fn fetch(
            &self,
            _url: &str,
            _init: &FetchInit,
            limit_ms: Option<f64>,
        ) -> Result<super::super::net::NetResponse, FetchError> {
            self.seen.lock().unwrap().push(limit_ms);
            let mut headers = Headers::new();
            headers.set("content-type", self.content_type);
            Ok(NetResponse {
                status: 200,
                status_text: String::new(),
                headers,
                url: String::new(),
                redirected: false,
                opaque_redirect: false,
                body: Some(Box::new(Chunks(self.chunks.clone().into_iter()))),
            })
        }

        fn compile_output_schema(&self, _: &JsonValue) -> Result<u64, String> {
            Ok(1)
        }

        fn validate_output(&self, _: u64, _: &JsonValue) -> OutputCheck {
            OutputCheck::Valid
        }
    }

    fn world(net: Arc<dyn McpNet>) -> (RemoteWorld, Receiver<Msg>, Rig) {
        let rig = Rig::new(&[1]);
        let (tx, rx) = channel();
        let deps = RemoteWorldDeps {
            net,
            os_shell: Arc::new(Os::default()),
            link: CoreLink {
                core: rig.services.core.clone(),
                hub: 0,
            },
        };
        let world = RemoteWorld {
            deps,
            server_id: "s".to_owned(),
            tx,
            timers: Rc::default(),
            requests: Rc::default(),
            listeners: HashMap::new(),
            streams: HashMap::new(),
            next_stream: 0,
        };
        (world, rx, rig)
    }

    #[test]
    fn a_json_body_is_read_whole_and_an_event_stream_is_fed_chunk_by_chunk() {
        let json = Arc::new(Canned {
            content_type: "application/json",
            chunks: vec![b"{\"a\":".to_vec(), b"1}".to_vec()],
            seen: Mutex::default(),
        });
        let (mut w, _rx, _rig) = world(json.clone());
        let got = FetchHost::fetch(&mut w, "https://x.test/", &FetchInit::default()).unwrap();
        assert_eq!(got.body, Body::Bytes(b"{\"a\":1}".to_vec()));
        // a request is bounded by the time a call may take
        assert_eq!(*json.seen.lock().unwrap(), vec![Some(MCP_CALL_TIMEOUT_MS)]);

        let events = Arc::new(Canned {
            content_type: "text/event-stream; charset=utf-8",
            chunks: vec![b"data: 1\n\n".to_vec(), b"data: 2\n\n".to_vec()],
            seen: Mutex::default(),
        });
        let (mut w, rx, _rig) = world(events);
        let got = FetchHost::fetch(&mut w, "https://x.test/", &FetchInit::default()).unwrap();
        let Body::Stream(id) = got.body else {
            panic!("a stream")
        };
        let mut seen = Vec::new();
        loop {
            match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Msg::Stream(stream, StreamEvent::Chunk(bytes))) => {
                    assert_eq!(stream, id);
                    seen.push(bytes);
                }
                Ok(Msg::Stream(_, StreamEvent::End)) => break,
                Ok(_) => panic!("an event of the stream"),
                Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => panic!("no end"),
            }
        }
        assert_eq!(seen, vec![b"data: 1\n\n".to_vec(), b"data: 2\n\n".to_vec()]);
    }

    #[test]
    fn the_loopback_server_hands_a_request_to_the_actor_and_answers_it() {
        let net = Arc::new(Canned {
            content_type: "application/json",
            chunks: vec![],
            seen: Mutex::default(),
        });
        let (mut w, rx, _rig) = world(net);
        let port = LoopbackHost::listen(&mut w).unwrap();
        let mut browser = TcpStream::connect(("127.0.0.1", port)).unwrap();
        browser
            .write_all(b"GET /callback?code=abc&state=xyz HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();
        let Ok(Msg::Loopback(request)) = rx.recv_timeout(Duration::from_secs(5)) else {
            panic!("a request")
        };
        assert_eq!(
            (
                request.method.as_str(),
                request.target.as_str(),
                request.port
            ),
            ("GET", "/callback?code=abc&state=xyz", port)
        );
        w.requests.borrow_mut().insert(port, request.stream);
        LoopbackHost::respond(
            &mut w,
            port,
            &LoopbackResponse {
                status: 200,
                headers: vec![("Content-Type".to_owned(), "text/html".to_owned())],
                body: Some("done".to_owned()),
            },
        );
        let mut answer = String::new();
        browser.read_to_string(&mut answer).unwrap();
        assert!(answer.starts_with("HTTP/1.1 200 OK\r\n"), "{answer}");
        assert!(answer.contains("Content-Length: 4\r\n"), "{answer}");
        assert!(answer.ends_with("\r\n\r\ndone"), "{answer}");
        LoopbackHost::close_server(&mut w, port);
    }

    #[test]
    fn a_name_that_is_an_address_resolves_to_itself() {
        let net = Arc::new(Canned {
            content_type: "application/json",
            chunks: vec![],
            seen: Mutex::default(),
        });
        let (mut w, _rx, _rig) = world(net);
        assert_eq!(
            NetHost::resolve_host(&mut w, "[::1]"),
            Ok(vec!["::1".to_owned()])
        );
        assert_eq!(
            NetHost::resolve_host(&mut w, "127.0.0.1"),
            Ok(vec!["127.0.0.1".to_owned()])
        );
    }
}
