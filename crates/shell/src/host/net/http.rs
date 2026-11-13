//! The network of the AI runtime (`shell_ipc_a::runtime::Net`) over reqwest
//! and hyper: `fetch` with streamed bodies that `response.clone()` tees, and
//! the loopback servers of OAuth sign-ins.
//!
//! Nothing here knows Tauri: the shell hands in how to start a future on its
//! tokio runtime, so a test drives the same code on a runtime of its own.
//!
//! What each `fetch` answers is the one the TypeScript called:
//! - `Fetcher::Node` is Node's global `fetch` (undici): `redirect: 'manual'`
//!   hands the 3xx back, `'error'` rejects, a transport failure rejects with
//!   `TypeError: fetch failed` whose `cause` carries Node's `code`;
//! - `Fetcher::Net` is Electron's `net.fetch` (Chromium): told not to follow a
//!   redirect it throws `Redirect was cancelled` (`'manual'`) or `Attempted to
//!   redirect, but redirect policy was 'error'`, a transport failure throws
//!   `net::ERR_...` as Chromium names it.
//!
//! Both follow at most 20 redirects and decode gzip, brotli, deflate and zstd
//! bodies. The system proxy is used, as both did, except for a loopback
//! address, which both reached directly. Not like the Electron build: a PAC
//! script is not evaluated (reqwest reads the proxy settings, the Electron
//! build asked Chromium which proxy one AI host takes), and TLS trusts the
//! system's roots for Node's fetch too (Node trusted its own bundled roots).

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use jscompat::{JsObject, JsonValue};
use main_core::packages::ai_provider::task::{
    Answer, Fetcher, FormValue, HttpRequest, Id, JsError, Request, RequestBody, ResponseHead,
};
use shell_ipc_a::runtime::{Net, Sink};
use tokio::sync::oneshot;

/// Starts a future on the host's async runtime
pub type Spawn = Arc<dyn Fn(Pin<Box<dyn Future<Output = ()> + Send>>) + Send + Sync>;

/// undici's and Chromium's limit
const MAX_REDIRECTS: usize = 20;

/// The reqwest clients, one per redirect policy (reqwest sets it per client),
/// each with the system proxy and without: a loopback address never rides
/// the proxy, as the Electron build kept it (main-proxy.ts's NO_PROXY
/// defaults for Node's fetch, Chromium's implicit `<-loopback>` for net.fetch),
/// so a local model server on 127.0.0.1 is reached directly
struct Clients {
    follow: reqwest::Client,
    stop: reqwest::Client,
    direct_follow: reqwest::Client,
    direct_stop: reqwest::Client,
}

impl Clients {
    fn new() -> Clients {
        let build = |policy, proxied: bool| {
            let builder = reqwest::Client::builder().redirect(policy);
            let builder = if proxied { builder } else { builder.no_proxy() };
            builder
                .build()
                .expect("a reqwest client with the platform's TLS")
        };
        let follow = || reqwest::redirect::Policy::limited(MAX_REDIRECTS);
        Clients {
            follow: build(follow(), true),
            stop: build(reqwest::redirect::Policy::none(), true),
            direct_follow: build(follow(), false),
            direct_stop: build(reqwest::redirect::Policy::none(), false),
        }
    }

    fn pick(&self, url: &str, follow: bool) -> &reqwest::Client {
        match (is_loopback(url), follow) {
            (false, true) => &self.follow,
            (false, false) => &self.stop,
            (true, true) => &self.direct_follow,
            (true, false) => &self.direct_stop,
        }
    }
}

/// The shell's one HTTP client for a request to `url`: the system proxy and
/// TLS, a loopback address direct, and up to 20 redirects followed when
/// `follow` (a 3xx handed back otherwise). Every caller in the process shares
/// these clients and their connection pools; a worker without a runtime of its
/// own drives a request with `tauri::async_runtime::block_on`.
pub fn client(url: &str, follow: bool) -> reqwest::Client {
    static CLIENTS: std::sync::OnceLock<Clients> = std::sync::OnceLock::new();
    CLIENTS.get_or_init(Clients::new).pick(url, follow).clone()
}

/// `localhost` (and its subdomains), 127.0.0.0/8 and `[::1]`
fn is_loopback(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']');
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        // the URL parser has already lowercased the name
        Err(_) => host == "localhost" || host.ends_with(".localhost"),
    }
}

/// The stream of one fetch: the chunks not yet handed to every branch
#[derive(Default)]
struct Source {
    response: Option<reqwest::Response>,
    pulling: bool,
    /// chunk `base + i` is `chunks[i]`; dropped once every branch has it
    base: usize,
    chunks: Vec<Bytes>,
    /// `None`: still streaming; `Some(Ok)`: ended; `Some(Err)`: failed
    end: Option<Result<(), JsError>>,
    via: Option<Fetcher>,
    /// reads waiting for the next chunk: (read id, body id, sink)
    waiting: Vec<(Id, Id, Sink)>,
    /// stops the read in flight, so a cancel closes a stalled stream at once
    stop: Option<oneshot::Sender<()>>,
}

struct Body {
    source: Id,
    /// the index of the next chunk this branch hands out
    next: usize,
}

#[derive(Default)]
struct State {
    /// operations in flight, by id: dropping the sender cancels nothing, sending stops it
    ops: HashMap<Id, oneshot::Sender<()>>,
    sources: HashMap<Id, Source>,
    bodies: HashMap<Id, Body>,
    servers: HashMap<Id, oneshot::Sender<()>>,
    /// requests to a server waiting for `respond`
    pending: HashMap<Id, oneshot::Sender<Reply>>,
}

type Reply = (f64, Vec<(String, String)>, Vec<u8>);

/// Request ids of every server of the process: the runtimes sharing this host
/// answer them by these ids
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);

pub struct HttpNet(Arc<Inner>);

struct Inner {
    spawn: Spawn,
    state: Mutex<State>,
}

impl HttpNet {
    pub fn new(spawn: Spawn) -> HttpNet {
        HttpNet(Arc::new(Inner {
            spawn,
            state: Mutex::default(),
        }))
    }
}

impl Inner {
    fn lock(state: &Mutex<State>) -> std::sync::MutexGuard<'_, State> {
        state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs `work` until it ends or `cancel(id)` stops it; a stopped one answers nothing
    fn run_op(self: &Arc<Self>, id: Id, work: impl Future<Output = ()> + Send + 'static) {
        let (stop, stopped) = oneshot::channel();
        Self::lock(&self.state).ops.insert(id, stop);
        let inner = self.clone();
        (self.spawn)(Box::pin(async move {
            let stopped = async {
                if stopped.await.is_err() {
                    std::future::pending::<()>().await;
                }
            };
            tokio::select! {
                () = stopped => {}
                () = work => {}
            }
            Self::lock(&inner.state).ops.remove(&id);
        }));
    }

    /// Reads the next chunk of `source_id` and hands it to every read waiting for it
    fn pull(self: &Arc<Self>, source_id: Id) {
        let mut st = Self::lock(&self.state);
        let Some(source) = st.sources.get_mut(&source_id) else {
            return;
        };
        if source.pulling || source.waiting.is_empty() {
            return;
        }
        let Some(mut response) = source.response.take() else {
            return;
        };
        source.pulling = true;
        let (stop, stopped) = oneshot::channel::<()>();
        source.stop = Some(stop);
        let via = source.via.unwrap_or(Fetcher::Node);
        drop(st);
        let inner = self.clone();
        (self.spawn)(Box::pin(async move {
            let pulled = tokio::select! {
                // cancelled: the response, and its connection, end here
                Ok(()) = stopped => return,
                pulled = response.chunk() => pulled,
            };
            let mut st = Inner::lock(&inner.state);
            let Some(source) = st.sources.get_mut(&source_id) else {
                // cancelled meanwhile: the response goes with this task
                return;
            };
            source.pulling = false;
            source.stop = None;
            match pulled {
                Ok(Some(chunk)) => {
                    source.response = Some(response);
                    source.chunks.push(chunk);
                }
                Ok(None) => source.end = Some(Ok(())),
                Err(error) => source.end = Some(Err(read_failure(via, &error))),
            }
            let waiting = std::mem::take(&mut source.waiting);
            let mut answers = Vec::new();
            for (read, body, sink) in waiting {
                match take_next(&mut st, body) {
                    Some(answer) => answers.push((sink, read, answer)),
                    None => st
                        .sources
                        .get_mut(&source_id)
                        .expect("the source")
                        .waiting
                        .push((read, body, sink)),
                }
            }
            trim(&mut st, source_id);
            drop(st);
            for (sink, read, answer) in answers {
                match answer {
                    Ok(answer) => sink.done(read, answer),
                    Err(error) => sink.failed(read, error),
                }
            }
            inner.pull(source_id);
        }));
    }
}

/// What a read of the branch `body` answers now: its next chunk, the end, the
/// failure, or `None` while the next chunk is still to come. A branch that is
/// handed its end or its failure is over: the runtime reads it no more and
/// sends no cancel for it, so it is dropped here, and its stream with the
/// last branch (a clone not yet read keeps the stream and its chunks).
fn take_next(st: &mut State, body: Id) -> Option<Result<Answer, JsError>> {
    let Some(branch) = st.bodies.get(&body) else {
        return Some(Ok(Answer::End));
    };
    let (source_id, next) = (branch.source, branch.next);
    let Some(source) = st.sources.get(&source_id) else {
        return Some(Ok(Answer::End));
    };
    if next < source.base + source.chunks.len() {
        let chunk = source.chunks[next - source.base].to_vec();
        st.bodies.get_mut(&body).expect("the branch").next += 1;
        return Some(Ok(Answer::Chunk(chunk)));
    }
    let last = match &source.end {
        Some(Ok(())) => Ok(Answer::End),
        Some(Err(error)) => Err(error.clone()),
        None => return None,
    };
    st.bodies.remove(&body);
    if !st.bodies.values().any(|b| b.source == source_id) {
        st.sources.remove(&source_id);
    }
    Some(last)
}

// ---- fetch ----

fn request_builder(url: &str, request: &Request) -> reqwest::RequestBuilder {
    let follow = matches!(request.redirect.as_deref(), None | Some("follow"));
    let client = client(url, follow);
    let method = request.method.as_deref().unwrap_or("GET").to_uppercase();
    let method = reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET);
    let form = matches!(request.body, Some(RequestBody::Form(_)));
    let mut builder = client.request(method, url);
    for (name, value) in &request.headers {
        // FormData sets its own content type, with the boundary
        if form && name.eq_ignore_ascii_case("content-type") {
            continue;
        }
        builder = builder.header(name, value);
    }
    match &request.body {
        None => builder,
        Some(RequestBody::Text(text)) => builder.body(text.clone()),
        Some(RequestBody::Bytes(bytes)) => builder.body(bytes.clone()),
        Some(RequestBody::Form(parts)) => {
            let mut form = reqwest::multipart::Form::new();
            for part in parts {
                form = match &part.value {
                    FormValue::Text(text) => form.text(part.name.clone(), text.clone()),
                    FormValue::Blob {
                        bytes,
                        mime,
                        filename,
                    } => {
                        let mut blob = reqwest::multipart::Part::bytes(bytes.clone());
                        if !mime.is_empty()
                            && let Ok(typed) = blob.mime_str(mime)
                        {
                            blob = typed;
                        } else {
                            blob = reqwest::multipart::Part::bytes(bytes.clone());
                        }
                        // `FormData.append(name, blob)` without a name sends `blob`
                        blob = blob.file_name(filename.clone().unwrap_or_else(|| "blob".into()));
                        form.part(part.name.clone(), blob)
                    }
                };
            }
            builder.multipart(form)
        }
    }
}

/// Node's `code` and message of a transport failure, from reqwest's error chain
fn node_cause(error: &reqwest::Error) -> (Option<&'static str>, String) {
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(error);
    let mut text = error.to_string();
    while let Some(current) = source {
        if let Some(io) = current.downcast_ref::<std::io::Error>() {
            use std::io::ErrorKind::*;
            let code = match io.kind() {
                ConnectionRefused => Some("ECONNREFUSED"),
                ConnectionReset => Some("ECONNRESET"),
                ConnectionAborted => Some("ECONNABORTED"),
                TimedOut => Some("ETIMEDOUT"),
                NetworkUnreachable => Some("ENETUNREACH"),
                HostUnreachable => Some("EHOSTUNREACH"),
                BrokenPipe => Some("EPIPE"),
                _ => None,
            };
            if code.is_some() {
                return (code, io.to_string());
            }
        }
        let shown = current.to_string();
        if shown.contains("dns error") || shown.contains("failed to lookup address") {
            return (Some("ENOTFOUND"), shown);
        }
        text = shown;
        source = current.source();
    }
    if error.is_timeout() {
        return (Some("UND_ERR_CONNECT_TIMEOUT"), text);
    }
    (None, text)
}

/// Chromium's name of the same failure
fn chromium_name(code: Option<&str>, error: &reqwest::Error) -> &'static str {
    match code {
        Some("ECONNREFUSED") => "net::ERR_CONNECTION_REFUSED",
        Some("ECONNRESET") => "net::ERR_CONNECTION_RESET",
        Some("ECONNABORTED") => "net::ERR_CONNECTION_ABORTED",
        Some("ETIMEDOUT" | "UND_ERR_CONNECT_TIMEOUT") => "net::ERR_TIMED_OUT",
        Some("ENOTFOUND") => "net::ERR_NAME_NOT_RESOLVED",
        Some("ENETUNREACH" | "EHOSTUNREACH") => "net::ERR_ADDRESS_UNREACHABLE",
        _ if error.is_redirect() => "net::ERR_TOO_MANY_REDIRECTS",
        _ => "net::ERR_FAILED",
    }
}

/// What `fetch` rejects with when the request did not get an answer
fn fetch_failure(via: Fetcher, error: &reqwest::Error) -> JsError {
    let (code, message) = node_cause(error);
    match via {
        Fetcher::Net => JsError::error(chromium_name(code, error)),
        Fetcher::Node | Fetcher::Embed => {
            let mut cause = JsObject::new();
            cause.set("$class", JsonValue::String("Error".into()));
            cause.set("message", JsonValue::String(message));
            if let Some(code) = code {
                cause.set("code", JsonValue::String(code.into()));
            }
            JsError::type_error("fetch failed").with("cause", JsonValue::Object(cause))
        }
    }
}

/// What reading a body rejects with when its stream breaks
fn read_failure(via: Fetcher, error: &reqwest::Error) -> JsError {
    match via {
        Fetcher::Net => JsError::error(chromium_name(node_cause(error).0, error)),
        Fetcher::Node | Fetcher::Embed => JsError::type_error("terminated"),
    }
}

/// A 3xx that the request was told not to follow, as each fetch treats it
fn refused_redirect(via: Fetcher, redirect: Option<&str>) -> Option<JsError> {
    match (via, redirect) {
        (Fetcher::Net, Some("manual")) => Some(JsError::error("Redirect was cancelled")),
        (Fetcher::Net | Fetcher::Node | Fetcher::Embed, Some("error")) => Some(match via {
            Fetcher::Net => {
                JsError::error("Attempted to redirect, but redirect policy was 'error'")
            }
            _ => JsError::type_error("fetch failed")
                .with("cause", JsonValue::String("unexpected redirect".into())),
        }),
        _ => None,
    }
}

/// Fetch: a null body for HEAD and the null-body statuses
fn has_body(method: &str, status: u16) -> bool {
    !(method.eq_ignore_ascii_case("HEAD")
        || method.eq_ignore_ascii_case("CONNECT")
        || matches!(status, 101 | 103 | 204 | 205 | 304))
}

impl Net for HttpNet {
    fn fetch(&self, id: Id, via: Fetcher, url: String, request: Request, sink: Sink) {
        if via == Fetcher::Embed {
            // the page's embed host exists only in the web build
            sink.failed(id, JsError::type_error("fetch failed"));
            return;
        }
        let builder = request_builder(&url, &request);
        let method = request.method.clone().unwrap_or_else(|| "GET".into());
        let redirect = request.redirect.clone();
        let inner = self.0.clone();
        self.0.run_op(id, async move {
            let response = match builder.send().await {
                Ok(response) => response,
                Err(error) => return sink.failed(id, fetch_failure(via, &error)),
            };
            let status = response.status();
            if status.is_redirection()
                && let Some(refused) = refused_redirect(via, redirect.as_deref())
            {
                return sink.failed(id, refused);
            }
            let head = ResponseHead {
                status: f64::from(status.as_u16()),
                status_text: status.canonical_reason().unwrap_or("").to_owned(),
                headers: response
                    .headers()
                    .iter()
                    .map(|(name, value)| {
                        (
                            name.as_str().to_owned(),
                            String::from_utf8_lossy(value.as_bytes()).into_owned(),
                        )
                    })
                    .collect(),
                url: response.url().to_string(),
                redirected: response.url().as_str() != url,
                kind: "basic".into(),
                has_body: has_body(&method, status.as_u16()),
            };
            if head.has_body {
                let mut st = Inner::lock(&inner.state);
                st.sources.insert(
                    id,
                    Source {
                        response: Some(response),
                        via: Some(via),
                        ..Source::default()
                    },
                );
                st.bodies.insert(
                    id,
                    Body {
                        source: id,
                        next: 0,
                    },
                );
            }
            sink.done(id, Answer::Response(head));
        });
    }

    fn read(&self, id: Id, body: Id, sink: Sink) {
        let mut st = Inner::lock(&self.0.state);
        match take_next(&mut st, body) {
            Some(answer) => {
                let source = st.bodies.get(&body).map(|b| b.source);
                if let Some(source) = source {
                    trim(&mut st, source);
                }
                drop(st);
                match answer {
                    Ok(answer) => sink.done(id, answer),
                    Err(error) => sink.failed(id, error),
                }
            }
            None => {
                let source = st
                    .bodies
                    .get(&body)
                    .expect("a branch with no answer yet")
                    .source;
                st.sources
                    .get_mut(&source)
                    .expect("its source")
                    .waiting
                    .push((id, body, sink));
                drop(st);
                self.0.pull(source);
            }
        }
    }

    fn clone_body(&self, from: Id, to: Id) {
        let mut st = Inner::lock(&self.0.state);
        if let Some(branch) = st.bodies.get(&from) {
            let clone = Body {
                source: branch.source,
                next: branch.next,
            };
            st.bodies.insert(to, clone);
        }
    }

    fn cancel(&self, id: Id) {
        let mut st = Inner::lock(&self.0.state);
        if let Some(stop) = st.ops.remove(&id) {
            let _ = stop.send(());
        }
        let source = st.bodies.get(&id).map(|b| b.source).unwrap_or(id);
        if let Some(mut gone) = st.sources.remove(&source) {
            if let Some(stop) = gone.stop.take() {
                let _ = stop.send(());
            }
            st.bodies.retain(|_, branch| branch.source != source);
        }
    }

    fn listen(&self, id: Id, host: String, port: f64, sink: Sink) {
        let (stop, stopped) = oneshot::channel::<()>();
        Inner::lock(&self.0.state).servers.insert(id, stop);
        let inner = self.0.clone();
        (self.0.spawn)(Box::pin(async move {
            let address = format!("{host}:{}", port as u16);
            let listener = match tokio::net::TcpListener::bind(&address).await {
                Ok(listener) => listener,
                Err(error) => {
                    let code = match error.kind() {
                        std::io::ErrorKind::AddrInUse => "EADDRINUSE",
                        std::io::ErrorKind::PermissionDenied => "EACCES",
                        _ => "EADDRNOTAVAIL",
                    };
                    return sink.failed(
                        id,
                        JsError::error(format!("listen {code}: {error} {address}"))
                            .with("code", JsonValue::String(code.into())),
                    );
                }
            };
            let bound = listener.local_addr().map_or(0, |a| a.port());
            sink.done(
                id,
                Answer::Listening {
                    port: f64::from(bound),
                },
            );
            let mut stopped = stopped;
            loop {
                let accepted = tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => accepted,
                };
                let Ok((stream, _)) = accepted else { continue };
                let inner = inner.clone();
                let sink = sink.clone();
                tokio::spawn(async move {
                    let service =
                        service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                            let inner = inner.clone();
                            let sink = sink.clone();
                            async move {
                                let request_id = NEXT_REQUEST.fetch_add(1, Ordering::Relaxed);
                                let (reply, replied) = oneshot::channel();
                                Inner::lock(&inner.state).pending.insert(request_id, reply);
                                let seen = HttpRequest {
                                    id: request_id,
                                    method: request.method().as_str().to_owned(),
                                    url: request
                                        .uri()
                                        .path_and_query()
                                        .map_or("/".into(), |p| p.as_str().to_owned()),
                                    headers: request
                                        .headers()
                                        .iter()
                                        .map(|(n, v)| {
                                            (
                                                n.as_str().to_owned(),
                                                String::from_utf8_lossy(v.as_bytes()).into_owned(),
                                            )
                                        })
                                        .collect(),
                                };
                                // the body of a sign-in redirect is not read
                                let _ = request.into_body().collect().await;
                                sink.request(id, seen);
                                let (status, headers, body) =
                                    replied.await.unwrap_or((500.0, Vec::new(), Vec::new()));
                                let mut response = hyper::Response::builder().status(status as u16);
                                for (name, value) in headers {
                                    response = response.header(name, value);
                                }
                                Ok::<_, std::convert::Infallible>(
                                    response.body(Full::new(Bytes::from(body))).unwrap_or_else(
                                        |_| hyper::Response::new(Full::new(Bytes::new())),
                                    ),
                                )
                            }
                        });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        }));
    }

    fn respond(&self, request: Id, status: f64, headers: Vec<(String, String)>, body: Vec<u8>) {
        if let Some(reply) = Inner::lock(&self.0.state).pending.remove(&request) {
            let _ = reply.send((status, headers, body));
        }
    }

    fn close_server(&self, server: Id) {
        if let Some(stop) = Inner::lock(&self.0.state).servers.remove(&server) {
            let _ = stop.send(());
        }
    }
}

/// Drops the chunks every branch of `source` has handed out
fn trim(st: &mut State, source: Id) {
    let slowest = st
        .bodies
        .values()
        .filter(|b| b.source == source)
        .map(|b| b.next)
        .min();
    let Some(source) = st.sources.get_mut(&source) else {
        return;
    };
    let Some(slowest) = slowest else {
        return;
    };
    let gone = slowest.saturating_sub(source.base).min(source.chunks.len());
    source.chunks.drain(..gone);
    source.base += gone;
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;

    use main_core::packages::ai_provider::task::{Fetcher, Request};
    use shell_contract::Hosts;
    use shell_contract::ipc::{EventSink, Target};
    use shell_contract::runtime::{Services, Thread, Views, Workers, run_on};
    use shell_contract::value::IpcValue;
    use shell_core::core_thread::{CoreThread, ThreadWorkers};
    use shell_ipc_a::runtime::Driver;

    use super::*;
    use crate::ipc::outlet::TauriOutlet;
    use crate::paths::ShellPaths;
    use crate::views::ViewTable;

    struct NoEvents;

    impl EventSink for NoEvents {
        fn emit(&self, _: Target, _: &'static str, _: Vec<IpcValue>) {}
    }

    /// A raw HTTP/1.1 server answering every request with a chunked body
    fn server() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                    head.push(byte[0]);
                }
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nconnection: close\r\n\
                      transfer-encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
                );
            }
        });
        address
    }

    fn held(net: &HttpNet) -> (usize, usize, usize) {
        let st = Inner::lock(&net.0.state);
        (st.sources.len(), st.bodies.len(), st.ops.len())
    }

    /// Bodies read to their end, a clone read after its original, and a
    /// clone read first: none of it stays with the host afterwards
    #[test]
    fn a_body_read_to_its_end_leaves_nothing_behind() {
        let tokio_rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let handle = tokio_rt.handle().clone();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let runner = std::thread::spawn(move || {
            tokio_rt.block_on(async {
                let _ = stop_rx.await;
            })
        });
        let spawn: Spawn = Arc::new(move |future| {
            handle.spawn(future);
        });
        let net = Arc::new(HttpNet::new(spawn));
        let core = CoreThread::spawn("http-test-core");
        let core_thread: Arc<dyn Thread> = core.clone();
        let views = Arc::new(ViewTable::new(
            Arc::new(TauriOutlet::default()),
            core_thread.clone(),
        ));
        let services = Services {
            ui: CoreThread::spawn("http-test-ui"),
            core: core_thread,
            workers: Arc::new(ThreadWorkers) as Arc<dyn Workers>,
            events: Arc::new(NoEvents),
            views: views as Arc<dyn Views>,
            paths: Arc::new(ShellPaths::new()),
            hosts: Arc::new(Hosts::default()),
        };
        let url = server();
        let (tx, rx) = mpsc::channel::<Vec<String>>();
        let host: shell_ipc_a::NetHost = net.clone();
        run_on(core.as_ref(), move || {
            let driver = Driver::new(&services, host);
            let rt = driver.rt();
            driver.run(
                async move {
                    let mut texts = Vec::new();
                    for _ in 0..3 {
                        let response = rt
                            .fetch(Fetcher::Node, &url, Request::default(), None)
                            .await
                            .unwrap();
                        texts.push(response.text().await.unwrap());
                    }
                    let response = rt
                        .fetch(Fetcher::Node, &url, Request::default(), None)
                        .await
                        .unwrap();
                    let clone = response.clone_response();
                    texts.push(response.text().await.unwrap());
                    texts.push(clone.text().await.unwrap());
                    let response = rt
                        .fetch(Fetcher::Node, &url, Request::default(), None)
                        .await
                        .unwrap();
                    let clone = response.clone_response();
                    texts.push(clone.text().await.unwrap());
                    texts.push(response.text().await.unwrap());
                    texts
                },
                move |texts| {
                    let _ = tx.send(texts);
                },
            );
            // the driver lives on for the rest of the test process
            std::mem::forget(driver);
        });
        let texts = rx
            .recv_timeout(Duration::from_secs(20))
            .expect("the reads ended");
        assert_eq!(texts, vec!["hello world"; 7]);
        let end = std::time::Instant::now() + Duration::from_secs(5);
        while held(&net) != (0, 0, 0) && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(
            held(&net),
            (0, 0, 0),
            "(sources, bodies, ops) the host still holds"
        );
        let _ = stop_tx.send(());
        let _ = runner.join();
    }
}
