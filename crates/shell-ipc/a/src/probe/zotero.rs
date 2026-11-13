//! The probe fakes of the `zotero` port's batch hosts: Zotero itself.
//!
//! `hosts.a.zotero.server` (`case["zotero"]["server"]` here) is a list of connections the case's Zotero
//! accepts on `127.0.0.1:23116`, one after the other; each is a list of steps
//! it plays once a client has connected:
//!
//! - `["recv"]`: reads one frame and logs `["zotero.receive", transactionId, payload]`;
//! - `["send", transactionId, payload]`: writes one frame;
//! - `["sendHex", hex]`: writes the bytes as they are (a frame in pieces, an
//!   oversized header);
//! - `["wait"]`: waits for the client to close the connection and logs
//!   `["zotero.wait", closed]` (false: the wait ran out);
//!
//! When the steps are over the connection is closed (`socket.end()`) and
//! waited for. After the last connection is accepted nothing listens any more
//! (the port refuses, as when Zotero quits). A case without `server` leaves
//! the port closed. The TypeScript side of the group (`groups/a/zotero.ts`)
//! plays the same script with `node:net`.
//!
//! The questions go to the renderer under numbered ids
//! ([`crate::zotero::NumberedRequestIds`]), which the TypeScript side numbers
//! the same way, so a case can answer a question by its id.
//!
//! A deferred `zotero:command` stays open while Zotero asks questions, and
//! the events of a call are the ones that arrived before the probe went on to
//! the next call. So that a question reaches the call it belongs to on both
//! sides, the probe waits after a call for the connection to go quiet: the
//! port's connection runs on threads of its own (not the pool the probe
//! drains), and every connect and every frame the client writes starts a
//! worker of the pool that waits until the connection is over or [`SETTLE`]
//! has passed without a frame, a connect or a write. The group does the same
//! to its settling.

use std::io::{Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use main_core::docs::zotero_wire::{ZOTERO_INTEGRATION_PORT, encode_zotero_frame};
use serde_json::Value;
use shell_contract::runtime::Workers;

use super::{Log, push};
use crate::zotero::{SocketEvent, SocketSink, TcpConnector, ZoteroConnector, ZoteroSocket};

/// How long a step may wait for the client: a case that stalls ends instead of hanging
const STEP_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a closed connection is waited on for the client to follow
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
/// How often a blocked read looks at the stop flag
const POLL: Duration = Duration::from_millis(50);
/// A server nobody connected to for this long stops (the TypeScript side too)
const IDLE_TIMEOUT: Duration = Duration::from_secs(8);
/// How long the connection must be quiet before a call may end
const SETTLE: Duration = Duration::from_millis(150);
/// The longest one wait for quiet lasts
const SETTLE_LIMIT: Duration = Duration::from_secs(20);

/// The state of the connection the probe waits on after a call
struct Hold {
    /// quiet until: moved on by every connect, frame and write
    until: Mutex<Instant>,
    /// connections that have been started and not ended
    live: AtomicUsize,
}

impl Hold {
    fn new() -> Self {
        Hold {
            until: Mutex::new(Instant::now()),
            live: AtomicUsize::new(0),
        }
    }

    fn bump(&self) {
        *self.until.lock().unwrap_or_else(|p| p.into_inner()) = Instant::now() + SETTLE;
    }

    /// Returns when no connection is live or the live one has been quiet for [`SETTLE`]
    fn wait(&self) {
        let limit = Instant::now() + SETTLE_LIMIT;
        loop {
            let now = Instant::now();
            let until = *self.until.lock().unwrap_or_else(|p| p.into_inner());
            if self.live.load(Ordering::SeqCst) == 0 || now >= until || now >= limit {
                return;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

/// Threads outside the pool the probe drains
struct ThreadWorkers;

impl Workers for ThreadWorkers {
    fn spawn(&self, job: Box<dyn FnOnce() + Send>) {
        std::thread::spawn(job);
    }
}

/// The port's connector, `TcpConnector` on threads of their own, with the
/// pool's workers that hold the probe until the connection is quiet
struct HeldConnector {
    inner: TcpConnector,
    hold: Arc<Hold>,
    pool: Arc<dyn Workers>,
}

/// Starts a pool worker that returns when the connection has been quiet
fn start_hold(hold: &Arc<Hold>, pool: &Arc<dyn Workers>) {
    hold.bump();
    let hold = hold.clone();
    pool.spawn(Box::new(move || hold.wait()));
}

impl ZoteroConnector for HeldConnector {
    fn connect(&self, host: &str, port: u16, sink: SocketSink) {
        self.hold.live.fetch_add(1, Ordering::SeqCst);
        start_hold(&self.hold, &self.pool);
        let state = self.hold.clone();
        let pool = self.pool.clone();
        let sink: SocketSink = Arc::new(move |event| {
            let event = match event {
                SocketEvent::Connected(socket) => SocketEvent::Connected(Arc::new(HeldSocket {
                    inner: socket,
                    hold: state.clone(),
                    pool: pool.clone(),
                })),
                over @ (SocketEvent::ConnectFailed(_) | SocketEvent::Close) => {
                    state.live.fetch_sub(1, Ordering::SeqCst);
                    over
                }
                other => other,
            };
            sink(event)
        });
        self.inner.connect(host, port, sink);
    }
}

/// A socket whose writes hold the probe until the answer to them has come
struct HeldSocket {
    inner: Arc<dyn ZoteroSocket>,
    hold: Arc<Hold>,
    pool: Arc<dyn Workers>,
}

impl ZoteroSocket for HeldSocket {
    fn write(&self, frame: &[u8]) {
        start_hold(&self.hold, &self.pool);
        self.inner.write(frame);
    }

    fn end(&self) {
        self.inner.end();
    }

    fn destroy(&self, error: Option<&str>) {
        self.inner.destroy(error);
    }

    fn destroyed(&self) -> bool {
        self.inner.destroyed()
    }
}

/// The Zotero of the case running now; the next case (or its `insert`) stops it
static CURRENT: Mutex<Option<Server>> = Mutex::new(None);

struct Server {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

impl Server {
    /// Listens now and plays `connections` on a thread of its own
    fn start(connections: Vec<Vec<Value>>, log: Option<Log>, hold: Arc<Hold>) -> Server {
        let address = SocketAddr::from(([127, 0, 0, 1], ZOTERO_INTEGRATION_PORT as u16));
        // the TypeScript side closed its listener when it served its last connection
        let until = Instant::now() + Duration::from_secs(12);
        let listener = loop {
            match TcpListener::bind(address) {
                Ok(listener) => break listener,
                Err(_) if Instant::now() < until => std::thread::sleep(POLL),
                Err(error) => panic!("the case's Zotero cannot listen on {address}: {error}"),
            }
        };
        listener
            .set_nonblocking(true)
            .expect("a listener that does not block");
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || play(listener, connections, log, &hold, &stopped));
        Server { stop, thread }
    }

    fn stop(self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.thread.join();
    }
}

fn play(
    listener: TcpListener,
    connections: Vec<Vec<Value>>,
    log: Option<Log>,
    hold: &Hold,
    stop: &AtomicBool,
) {
    let total = connections.len();
    let started = Instant::now();
    let mut listener = Some(listener);
    if total == 0 {
        return;
    }
    for (index, steps) in connections.iter().enumerate() {
        let stream = loop {
            if stop.load(Ordering::Acquire) || started.elapsed() > IDLE_TIMEOUT {
                return;
            }
            let Some(open) = &listener else { return };
            match open.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(_) => return,
            }
        };
        if index + 1 == total {
            listener = None;
        }
        hold.bump();
        serve(stream, steps, &log, hold, stop);
    }
}

fn serve(
    mut stream: TcpStream,
    steps: &[Value],
    log: &Option<Log>,
    hold: &Hold,
    stop: &AtomicBool,
) {
    // an accepted socket may inherit the listener's non-blocking mode
    if stream.set_nonblocking(false).is_err() || stream.set_read_timeout(Some(POLL)).is_err() {
        return;
    }
    for step in steps {
        match step[0].as_str() {
            Some("recv") => {
                let Some((transaction_id, payload)) = read_frame(&mut stream, hold, stop) else {
                    return;
                };
                push(
                    log,
                    serde_json::json!(["zotero.receive", transaction_id, payload]),
                );
            }
            Some("send") => {
                let frame = encode_zotero_frame(
                    step[1].as_f64().expect("a transaction id"),
                    step[2].as_str().expect("a payload"),
                );
                if stream.write_all(&frame).is_err() {
                    return;
                }
                hold.bump();
            }
            Some("sendHex") => {
                let bytes = unhex(step[1].as_str().expect("hex"));
                if stream.write_all(&bytes).is_err() {
                    return;
                }
                hold.bump();
            }
            Some("wait") => {
                let closed = wait_for_close(&mut stream, stop);
                push(log, serde_json::json!(["zotero.wait", closed]));
                return;
            }
            other => panic!("a step of the case's Zotero that is not known: {other:?}"),
        }
    }
    // `socket.end()`: the client follows with its own close
    let _ = stream.shutdown(Shutdown::Write);
    wait_for_close(&mut stream, stop);
}

/// Reads until the client closes the connection; false when the wait ran out first
fn wait_for_close(stream: &mut TcpStream, stop: &AtomicBool) -> bool {
    let until = Instant::now() + CLOSE_TIMEOUT;
    let mut sink = [0u8; 4096];
    while !stop.load(Ordering::Acquire) && Instant::now() < until {
        match stream.read(&mut sink) {
            Ok(0) => return true,
            Ok(_) => {}
            Err(error) if retry(&error) => {}
            Err(_) => return true,
        }
    }
    false
}

fn retry(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock
            | std::io::ErrorKind::TimedOut
            | std::io::ErrorKind::Interrupted
    )
}

/// `n` bytes, or `None` when the client closed, failed, the case was stopped
/// or the client took longer than [`STEP_TIMEOUT`]
fn read_exact(stream: &mut TcpStream, n: usize, hold: &Hold, stop: &AtomicBool) -> Option<Vec<u8>> {
    let until = Instant::now() + STEP_TIMEOUT;
    let mut bytes = vec![0u8; n];
    let mut got = 0;
    while got < n {
        if stop.load(Ordering::Acquire) || Instant::now() >= until {
            return None;
        }
        match stream.read(&mut bytes[got..]) {
            Ok(0) => return None,
            Ok(read) => {
                got += read;
                hold.bump();
            }
            Err(error) if retry(&error) => {}
            Err(_) => return None,
        }
    }
    Some(bytes)
}

/// One frame: the transaction id and the UTF-8 payload
fn read_frame(stream: &mut TcpStream, hold: &Hold, stop: &AtomicBool) -> Option<(u32, String)> {
    let header = read_exact(stream, 8, hold, stop)?;
    let transaction_id = u32::from_be_bytes(header[0..4].try_into().ok()?);
    let length = u32::from_be_bytes(header[4..8].try_into().ok()?) as usize;
    let body = read_exact(stream, length, hold, stop)?;
    Some((transaction_id, String::from_utf8_lossy(&body).into_owned()))
}

fn unhex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks(2)
        .map(|pair| {
            u8::from_str_radix(std::str::from_utf8(pair).expect("hex"), 16).expect("hex digits")
        })
        .collect()
}

/// Inserts this port's factory and the fakes of its hosts, answering from
/// the case's `hosts.a` value; `log` is the case's host log
pub fn insert(hosts: &mut shell_contract::Hosts, case: &Value, log: Option<Log>) {
    let mut current = CURRENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(previous) = current.take() {
        previous.stop();
    }
    let state = Arc::new(Hold::new());
    hosts.insert(crate::zotero::factory());
    hosts.insert(crate::zotero::NumberedRequestIds);
    let held = state.clone();
    hosts.insert(crate::zotero::ProbeConnector(Arc::new(move |pool| {
        Arc::new(HeldConnector {
            inner: TcpConnector::new(Arc::new(ThreadWorkers)),
            hold: held.clone(),
            pool,
        })
    })));
    if let Some(connections) = case["zotero"]["server"].as_array() {
        let connections = connections
            .iter()
            .map(|steps| steps.as_array().cloned().unwrap_or_default())
            .collect();
        *current = Some(Server::start(connections, log, state));
    }
}
