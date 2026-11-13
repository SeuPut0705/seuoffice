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
            let mut over = Vec::new();
            for (read, body, sink) in waiting {
                match take_next(&mut st, body) {
                    Some(answer) => {
                        if !matches!(answer, Ok(Answer::Chunk(_))) {
                            over.push(body);
                        }
                        answers.push((sink, read, answer));
                    }
                    None => st
                        .sources
                        .get_mut(&source_id)
                        .expect("the source")
                        .waiting
                        .push((read, body, sink)),
                }
            }
            // after the whole batch: every read waiting on a branch is handed
            // its end or its failure before the branch goes
            for body in over {
                reclaim(&mut st, body);
            }
            trim(&mut st, source_id);
            // posted under the lock: a read taken after these cannot be
            // answered before them (posting only queues for the core thread)
            for (sink, read, answer) in answers {
                match answer {
                    Ok(answer) => sink.done(read, answer),
                    Err(error) => sink.failed(read, error),
                }
            }
            drop(st);
            inner.pull(source_id);
        }));
    }
}

/// What a read of the branch `body` answers now: its next chunk, the end, the
/// failure, or `None` while the next chunk is still to come
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
    match &source.end {
        Some(Ok(())) => Some(Ok(Answer::End)),
        Some(Err(error)) => Some(Err(error.clone())),
        None => None,
    }
}

/// A branch handed its end or its failure is over: the runtime reads it no
/// more and sends no cancel for it, so it goes, and its stream with the last
/// branch (a clone not yet read keeps the stream and its chunks). Called once
/// every read waiting on it has its answer.
fn reclaim(st: &mut State, body: Id) {
    let Some(branch) = st.bodies.remove(&body) else {
        return;
    };
    if !st.bodies.values().any(|b| b.source == branch.source) {
        st.sources.remove(&branch.source);
    }
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
                if matches!(answer, Ok(Answer::Chunk(_))) {
                    let source = st.bodies.get(&body).map(|b| b.source);
                    if let Some(source) = source {
                        trim(&mut st, source);
                    }
                } else {
                    reclaim(&mut st, body);
                }
                // under the lock, as `pull` answers: in the order taken
                match answer {
                    Ok(answer) => sink.done(id, answer),
                    Err(error) => sink.failed(id, error),
                }
                drop(st);
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
        stop_source(&mut st, source);
    }

    fn release(&self, body: Id, stop: Option<Id>) {
        let mut st = Inner::lock(&self.0.state);
        let source = st.bodies.remove(&body).map(|b| b.source);
        if let Some(source) = stop {
            stop_source(&mut st, source);
        } else if let Some(source) = source {
            if st.bodies.values().any(|b| b.source == source) {
                // the chunks only this branch had still to read go with it
                trim(&mut st, source);
            } else {
                // the last branch of a stream that ended (the runtime stops
                // one that has not): nothing reads it any more
                stop_source(&mut st, source);
            }
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

/// The stream of the fetch `source` stops: its response (and connection) is
/// dropped, a pull in flight ends, and every branch goes with it
fn stop_source(st: &mut State, source: Id) {
    if let Some(mut gone) = st.sources.remove(&source) {
        if let Some(stop) = gone.stop.take() {
            let _ = stop.send(());
        }
        st.bodies.retain(|_, branch| branch.source != source);
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
    /// A raw HTTP/1.1 server answering every request with a chunked body
    fn server() -> String {
        serve(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nconnection: close\r\n\
              transfer-encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
            Duration::ZERO,
        )
    }

    /// A raw HTTP/1.1 server writing `answer` to every request, then closing
    /// the connection after `linger` (or when the client goes)
    fn serve(answer: &'static [u8], linger: Duration) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        std::thread::spawn(move || {
            // each connection on its own thread: one that lingers holds up no other
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                std::thread::spawn(move || {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") && stream.read(&mut byte).unwrap_or(0) == 1 {
                        head.push(byte[0]);
                    }
                    let _ = stream.write_all(answer);
                    std::thread::sleep(linger);
                });
            }
        });
        address
    }

    fn held(net: &HttpNet) -> (usize, usize, usize) {
        let st = Inner::lock(&net.0.state);
        (st.sources.len(), st.bodies.len(), st.ops.len())
    }

    /// The host on a tokio runtime of its own and one AI runtime driver on a
    /// core thread, as the shell builds them
    struct World {
        net: Arc<HttpNet>,
        core: Arc<dyn Thread>,
        services: Services,
        stop: Option<tokio::sync::oneshot::Sender<()>>,
        runner: Option<std::thread::JoinHandle<()>>,
    }

    impl World {
        fn new() -> World {
            World::build(None)
        }

        /// The host on a runtime of two threads, its posts to the core
        /// thread through `gate`
        fn gated(gate: Arc<Gate>) -> World {
            World::build(Some(gate))
        }

        fn build(gate: Option<Arc<Gate>>) -> World {
            let tokio_rt = if gate.is_some() {
                tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .unwrap()
            } else {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
            };
            let handle = tokio_rt.handle().clone();
            let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
            let runner = std::thread::spawn(move || {
                tokio_rt.block_on(async {
                    let _ = stopped.await;
                })
            });
            let spawn: Spawn = Arc::new(move |future| {
                handle.spawn(future);
            });
            let core_thread: Arc<dyn Thread> = match gate {
                Some(gate) => Arc::new(Gated {
                    core: CoreThread::spawn("http-test-core"),
                    gate,
                }),
                None => CoreThread::spawn("http-test-core") as Arc<dyn Thread>,
            };
            let views = Arc::new(ViewTable::new(
                Arc::new(TauriOutlet::default()),
                core_thread.clone(),
            ));
            World {
                net: Arc::new(HttpNet::new(spawn)),
                services: Services {
                    ui: CoreThread::spawn("http-test-ui"),
                    core: core_thread.clone(),
                    workers: Arc::new(ThreadWorkers) as Arc<dyn Workers>,
                    events: Arc::new(NoEvents),
                    views: views as Arc<dyn Views>,
                    paths: Arc::new(ShellPaths::new()),
                    hosts: Arc::new(Hosts::default()),
                },
                core: core_thread,
                stop: Some(stop),
                runner: Some(runner),
            }
        }

        /// Runs `program` on the runtime of a new driver; what it comes to
        fn run<T: Send + 'static, F: Future<Output = T> + 'static>(
            &self,
            program: impl FnOnce(main_core::packages::ai_provider::task::Rt) -> F + Send + 'static,
        ) -> T {
            let (tx, rx) = mpsc::channel::<T>();
            let host: shell_ipc_a::NetHost = self.net.clone();
            let services = self.services.clone();
            run_on(self.core.as_ref(), move || {
                let driver = Driver::new(&services, host);
                driver.run(program(driver.rt()), move |out| {
                    let _ = tx.send(out);
                });
                // the driver lives on for the rest of the test process
                std::mem::forget(driver);
            });
            rx.recv_timeout(Duration::from_secs(20))
                .expect("the program ended")
        }

        /// What the host holds once its answers settled
        fn held_after_settling(&self, expected: (usize, usize, usize)) -> (usize, usize, usize) {
            let end = std::time::Instant::now() + Duration::from_secs(5);
            while held(&self.net) != expected && std::time::Instant::now() < end {
                std::thread::sleep(Duration::from_millis(10));
            }
            held(&self.net)
        }
    }

    impl Drop for World {
        fn drop(&mut self) {
            let _ = self.stop.take().map(|stop| stop.send(()));
            let _ = self.runner.take().map(std::thread::JoinHandle::join);
        }
    }

    /// Bodies read to their end, a clone read after its original, and a
    /// clone read first: none of it stays with the host afterwards
    #[test]
    fn a_body_read_to_its_end_leaves_nothing_behind() {
        let w = World::new();
        let url = server();
        let texts = w.run(move |rt| async move {
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
        });
        assert_eq!(texts, vec!["hello world"; 7]);
        assert_eq!(
            w.held_after_settling((0, 0, 0)),
            (0, 0, 0),
            "(sources, bodies, ops) the host still holds"
        );
    }

    /// The original read to its end and its clone left unread: the stream
    /// ended, so the clone's release comes without `stop`, and the host lets
    /// go of the stream with that last branch
    #[test]
    fn the_unread_clone_of_an_ended_stream_is_freed_when_released() {
        let w = World::new();
        let url = server();
        let text = w.run(move |rt| async move {
            let response = rt
                .fetch(Fetcher::Node, &url, Request::default(), None)
                .await
                .unwrap();
            let clone = response.clone_response();
            let text = response.text().await.unwrap();
            drop(clone);
            // the runtime sends the clone's `Release` at its next poll
            rt.sleep(1.0).await;
            text
        });
        assert_eq!(text, "hello world");
        assert_eq!(
            w.held_after_settling((0, 0, 0)),
            (0, 0, 0),
            "(sources, bodies, ops) the host still holds"
        );
    }

    /// what a `reader.read()` came to, its failure as its message
    type ReadOutcome = Result<Option<Vec<u8>>, String>;

    /// A stream cut short while two reads of one body wait: both reject with
    /// its failure, the second too, though the first already ended the branch
    #[test]
    fn every_read_waiting_on_a_failed_stream_rejects() {
        let w = World::new();
        let url = serve(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nconnection: close\r\n\
              transfer-encoding: chunked\r\n\r\n5\r\nhello\r\n",
            Duration::from_millis(300),
        );
        let (first, waits) = w.run(move |rt| async move {
            let response = std::rc::Rc::new(
                rt.fetch(Fetcher::Node, &url, Request::default(), None)
                    .await
                    .unwrap(),
            );
            let first = response.read().await.map_err(|e| e.message);
            let other: std::rc::Rc<std::cell::RefCell<Option<ReadOutcome>>> =
                std::rc::Rc::default();
            let (reader, slot) = (response.clone(), other.clone());
            rt.spawn_local(async move {
                let read = reader.read().await.map_err(|e| e.message);
                *slot.borrow_mut() = Some(read);
            });
            let mine = response.read().await.map_err(|e| e.message);
            while other.borrow().is_none() {
                rt.sleep(5.0).await;
            }
            let theirs = other.take().unwrap();
            (first, vec![mine, theirs])
        });
        assert_eq!(first, Ok(Some(b"hello".to_vec())));
        for read in waits {
            assert!(
                read.is_err(),
                "a read waiting on the failed stream ended: {read:?}"
            );
        }
        assert_eq!(w.held_after_settling((0, 0, 0)), (0, 0, 0));
    }

    /// Holds the first post the host makes once armed (from a thread of its
    /// runtime: not the core thread, not the AI runtime's timers) until it
    /// is opened: the moment between a read's answer being decided and its
    /// reaching the core thread
    #[derive(Default)]
    struct Gate {
        armed: std::sync::atomic::AtomicBool,
        held: std::sync::atomic::AtomicBool,
        /// answers the host posted while the held one waited
        overtaking: std::sync::atomic::AtomicUsize,
        open: (Mutex<bool>, std::sync::Condvar),
    }

    impl Gate {
        fn hold_here(&self) {
            let by_host = std::thread::current()
                .name()
                .is_none_or(|name| name != "http-test-core" && name != "ai-runtime-timers");
            if !by_host || !self.armed.load(Ordering::SeqCst) {
                return;
            }
            if self.held.swap(true, Ordering::SeqCst) {
                if !*self.open.0.lock().unwrap() {
                    self.overtaking.fetch_add(1, Ordering::SeqCst);
                }
                return;
            }
            // the runtime's other tasks (the connection's among them) go on
            // while this thread waits
            tokio::task::block_in_place(|| {
                let (open, opened) = &self.open;
                let guard = open.lock().unwrap();
                let _unused = opened
                    .wait_timeout_while(guard, Duration::from_secs(5), |open| !*open)
                    .unwrap();
            });
        }

        fn open(&self) {
            *self.open.0.lock().unwrap() = true;
            self.open.1.notify_all();
        }
    }

    struct Gated {
        core: Arc<CoreThread>,
        gate: Arc<Gate>,
    }

    impl Thread for Gated {
        fn post(&self, job: Box<dyn FnOnce() + Send>) {
            self.gate.hold_here();
            self.core.post(job);
        }

        fn is_current(&self) -> bool {
            self.core.is_current()
        }
    }

    /// A read's chunk held on its way to the core thread while a later read
    /// of the same body is made: no later answer may be posted before it
    /// (a runtime that ends a body's pending reads with the first End it is
    /// handed would end the earlier read without its chunk)
    #[test]
    fn a_later_read_is_not_answered_before_an_earlier_one() {
        let gate = Arc::new(Gate::default());
        let w = World::gated(gate.clone());
        let url = serve_slowly();
        let armed = gate.clone();
        let opener = gate.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            opener.open();
        });
        let order = w.run(move |rt| async move {
            let response = std::rc::Rc::new(
                rt.fetch(Fetcher::Node, &url, Request::default(), None)
                    .await
                    .unwrap(),
            );
            armed.armed.store(true, Ordering::SeqCst);
            let order: std::rc::Rc<std::cell::RefCell<Vec<(u8, ReadOutcome)>>> =
                std::rc::Rc::default();
            let read = |n: u8| {
                let (response, order) = (response.clone(), order.clone());
                async move {
                    let got = response.read().await.map_err(|e| e.message);
                    order.borrow_mut().push((n, got));
                }
            };
            rt.spawn_local(read(1));
            rt.spawn_local(read(2));
            // the first chunk is in and held at the gate by now
            rt.sleep(150.0).await;
            rt.spawn_local(read(3));
            while order.borrow().len() < 3 {
                rt.sleep(10.0).await;
            }
            order.take()
        });
        assert!(gate.held.load(Ordering::SeqCst), "the gate held no answer");
        assert_eq!(
            gate.overtaking.load(Ordering::SeqCst),
            0,
            "answers posted while an earlier one was on its way"
        );
        assert_eq!(
            order.first(),
            Some(&(1, Ok(Some(b"hello".to_vec())))),
            "the reads ended in this order: {order:?}"
        );
    }

    /// A chunked body: one chunk at once, its end 300 ms later
    fn serve_slowly() -> String {
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
                      transfer-encoding: chunked\r\n\r\n5\r\nhello\r\n",
                );
                std::thread::sleep(Duration::from_millis(300));
                let _ = stream.write_all(b"0\r\n\r\n");
            }
        });
        address
    }

    /// Responses the program lets go of unread: the fetch's alone, and a
    /// clone dropped before its original; the host stops each stream (no
    /// cancel: in JavaScript a dropped body is only garbage) and keeps nothing
    #[test]
    fn a_response_dropped_unread_is_stopped_and_freed() {
        let w = World::new();
        // a body that never ends: only a stop frees it
        let url = serve(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nconnection: close\r\n\
              transfer-encoding: chunked\r\n\r\n5\r\nhello\r\n",
            Duration::from_secs(30),
        );
        let statuses = w.run(move |rt| async move {
            let mut statuses = Vec::new();
            let response = rt
                .fetch(Fetcher::Node, &url, Request::default(), None)
                .await
                .unwrap();
            statuses.push(response.status());
            drop(response);
            let response = rt
                .fetch(Fetcher::Node, &url, Request::default(), None)
                .await
                .unwrap();
            let clone = response.clone_response();
            statuses.push(clone.status());
            drop(clone);
            drop(response);
            rt.sleep(1.0).await;
            statuses
        });
        assert_eq!(statuses, vec![200.0, 200.0]);
        assert_eq!(
            w.held_after_settling((0, 0, 0)),
            (0, 0, 0),
            "(sources, bodies, ops) the host still holds"
        );
    }
}
