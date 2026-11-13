//! The executor of main-core's AI runtime: the host of
//! `main_core::packages::ai_provider::task`, which is sans-IO. A ported
//! `async` function runs on a [`Driver`]; where the TypeScript awaits the
//! file system, a child process, a timer, the network or a function the shell
//! passed in, the future queues a command and the driver carries it out.
//!
//! - fs, spawn, stdin, kill: `std`, on `services.workers` (a child's pipes
//!   have threads of their own: a long-lived child would otherwise hold
//!   workers of the pool for good);
//! - timers: a thread of the driver's own;
//! - fetch, body reads, servers: the [`Net`] host (reqwest in the shell, a
//!   fake in the probe, see [`testing`]);
//! - a function the ported code calls back by name: [`Driver::on_call`];
//! - `console.*`: stderr; host values (`process.platform`, `os.tmpdir()`,
//!   `crypto.randomUUID()`...): [`HostInfo`].
//!
//! Every outcome is posted to the core thread (`services.core`) and fed to
//! the runtime there, one event at a time, with a poll and the execution of
//! what it queued between two events, so a child's output reaches the code
//! before its `close`. A command the runtime cancels loses its answer, even
//! one already on its way. The driver is for the core thread only (it holds
//! `Rc`s) and needs a core that really queues: [`Thread::post`] must run the
//! job on the core thread.

mod child;
mod fs;
mod signal;
mod timers;

#[cfg(any(test, feature = "probe"))]
pub mod testing;
#[cfg(test)]
mod tests;

use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use jscompat::{JsonValue, json_value_to_serde};
use main_core::packages::ai_provider::chatgpt_connection::ChatGptConnectionModuleState;
use main_core::packages::ai_provider::chatgpt_responses::ChatGptBridgeDeps;
use main_core::packages::ai_provider::claude_code_cli::ClaudeCodeCliDeps;
use main_core::packages::ai_provider::codex_app_server::CodexAppServerState;
use main_core::packages::ai_provider::fetch::{AiFetchState, KeyedFetchBase};
use main_core::packages::ai_provider::stream::Providers;
use main_core::packages::ai_provider::subscription_locate::SubscriptionLocateState;
use main_core::packages::ai_provider::subscription_process::SharedChildRegistry;
use main_core::packages::ai_provider::subscription_temp_dirs::SubscriptionTempState;
pub use main_core::packages::ai_provider::task::Wait;
use main_core::packages::ai_provider::task::{
    Answer, ChildEvent, Cmd, Event, Fetcher, HostInfo, HttpRequest, Id, JsError, Request, Rt,
    Runtime, Settle,
};
use shell_contract::runtime::{PathName, Services, Thread, Workers};

use self::child::ChildIo;
use self::timers::Timers;

/// The network of the runtime: `fetch` and the bodies it streams, and the
/// loopback servers of OAuth redirects. The shell implements it with reqwest
/// (crates/shell/src/host/net.rs), the probe with [`testing::FakeNet`].
///
/// Every method is called on the core thread and returns at once: slow work
/// goes to a thread or an async runtime of the host, and its outcome through
/// the [`Sink`]. The ids are unique across all the runtimes that share one
/// host. A host answers an id at most once and, after [`Net::cancel`] of it,
/// should not answer at all (an answer that comes anyway is dropped).
pub trait Net: Send + Sync {
    /// `fetch(url, init)` through `via`. Answer [`Sink::done`] with
    /// [`Answer::Response`] once the headers are in (`has_body`: the body is
    /// read as `read(_, id)`), or [`Sink::failed`] with what `fetch` rejects with
    /// (`TypeError: fetch failed`...).
    fn fetch(&self, id: Id, via: Fetcher, url: String, request: Request, sink: Sink);
    /// `reader.read()` of the body of a fetch (or of a clone): the next chunk
    /// as [`Answer::Chunk`], [`Answer::End`] once it is over, or the failure
    /// of the stream. A body has one read in flight at a time.
    fn read(&self, id: Id, body: Id, sink: Sink);
    /// `response.clone()`: `to` is a body that starts with the bytes `from`
    /// has not handed out yet; each is read on its own
    fn clone_body(&self, from: Id, to: Id);
    /// Stop the operation `id`, or the whole stream of the fetch `id` (its
    /// body and its clones); an id that is none of these, or one already
    /// stopped (by [`Net::release`]), is ignored
    fn cancel(&self, id: Id);
    /// The program dropped the handle of `body` (a fetch's body or a clone)
    /// before it was handed its end: free what is kept for that branch; with
    /// `stop`, no branch can read the fetch `stop`'s stream any more, so stop
    /// it as [`Net::cancel`] would. Nothing answers it, and nothing the
    /// program sees changes (in JavaScript the body is only garbage). The
    /// default keeps nothing to free.
    fn release(&self, body: Id, stop: Option<Id>) {
        let _ = (body, stop);
    }
    /// `server.listen(port, host)`: answer [`Answer::Listening`] with the
    /// port bound (0 asks for a free one), then pass each request to
    /// [`Sink::request`] with an id of the host's own, which
    /// [`Net::respond`] takes
    fn listen(&self, id: Id, host: String, port: f64, sink: Sink);
    /// `res.writeHead(status, headers).end(body)` for a request of a server
    fn respond(&self, request: Id, status: f64, headers: Vec<(String, String)>, body: Vec<u8>);
    /// `server.close()`
    fn close_server(&self, server: Id);
}

pub type NetHost = Arc<dyn Net>;

/// `Date.now()` of the runtime, when the shell hands one in: the probe pins it
/// so answers that carry the clock (`ai:local-test`) compare; without it the
/// system clock
#[derive(Clone)]
pub struct RuntimeClock(pub Arc<dyn Fn() -> f64 + Send + Sync>);

/// Where a [`Net`] host hands its outcomes: posts to the core thread, from
/// any thread, in the order of the calls of one thread
#[derive(Clone)]
pub struct Sink {
    poster: Poster,
}

impl Sink {
    /// The command `id` (as the host was given it) succeeded
    pub fn done(&self, id: Id, answer: Answer) {
        self.poster.send(Event::Done {
            id: unscoped(id),
            answer,
        });
    }

    /// The command `id` threw or its promise rejected
    pub fn failed(&self, id: Id, error: JsError) {
        self.poster.send(Event::Failed {
            id: unscoped(id),
            error,
        });
    }

    /// A request reached the server `server`
    pub fn request(&self, server: Id, request: HttpRequest) {
        self.poster.send(Event::Request {
            server: unscoped(server),
            request,
        });
    }
}

// The ids of a runtime count from 1; the host is given them with the
// driver's number above bit 40, so that ids of drivers sharing a host differ.
const SCOPE_SHIFT: u32 = 40;
const ID_MASK: u64 = (1 << SCOPE_SHIFT) - 1;
static NEXT_SCOPE: AtomicU64 = AtomicU64::new(1);

fn unscoped(id: Id) -> Id {
    id & ID_MASK
}

thread_local! {
    /// The drivers of this thread, for the jobs posted to it
    static DRIVERS: RefCell<HashMap<u64, Weak<Shared>>> = RefCell::new(HashMap::new());
}

/// Posts jobs to the core thread of one driver, from any thread
#[derive(Clone)]
struct Poster {
    core: Arc<dyn Thread>,
    scope: u64,
}

impl Poster {
    /// Runs `job` on the core thread, unless the driver is gone by then
    fn run(&self, job: impl FnOnce(&Rc<Shared>) + Send + 'static) {
        let scope = self.scope;
        self.core.post(Box::new(move || {
            let shared =
                DRIVERS.with(|drivers| drivers.borrow().get(&scope).and_then(Weak::upgrade));
            if let Some(shared) = shared {
                job(&shared);
            }
        }));
    }

    fn send(&self, event: Event) {
        self.run(move |shared| shared.accept(event));
    }
}

type Finisher = Box<dyn FnMut() -> bool>;
type Start = Box<dyn FnOnce(&mut Runtime) -> Finisher>;
type Handler = Rc<dyn Fn(JsonValue, CallReply)>;

struct Shared {
    scope: u64,
    poster: Poster,
    workers: Arc<dyn Workers>,
    net: NetHost,
    runtime: RefCell<Runtime>,
    rt: Rt,
    /// events to feed, in order
    inbox: RefCell<VecDeque<Event>>,
    /// futures [`Driver::run`] queued, to start before the next poll
    starts: RefCell<Vec<Start>>,
    /// one per started future: true once it returned and its `then` ran
    finishers: RefCell<Vec<Finisher>>,
    handlers: RefCell<HashMap<String, Handler>>,
    /// commands that wait for an answer; one that is cancelled leaves, and an
    /// answer for an id that is not here is dropped
    inflight: RefCell<HashSet<Id>>,
    /// the part of `inflight` the driver carries out itself (not the [`Net`])
    local: RefCell<HashSet<Id>>,
    children: RefCell<HashMap<Id, Arc<ChildIo>>>,
    timers: RefCell<Option<Timers>>,
    pumping: Cell<bool>,
    /// something was queued while pumping
    again: Cell<bool>,
    providers: RefCell<Option<Providers>>,
    /// `Date.now()` when the driver was made, as the process start
    started_at: f64,
}

impl Drop for Shared {
    fn drop(&mut self) {
        let _ = DRIVERS.try_with(|drivers| drivers.borrow_mut().remove(&self.scope));
    }
}

/// Restores `pumping` when the pump ends, a panic of a callback included
struct Pumping<'a>(&'a Cell<bool>);

impl Drop for Pumping<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

impl Shared {
    fn scoped(&self, id: Id) -> Id {
        (self.scope << SCOPE_SHIFT) | id
    }

    fn sink(&self) -> Sink {
        Sink {
            poster: self.poster.clone(),
        }
    }

    /// A child's handle, known to the core before its spawn is answered
    fn adopt(&self, id: Id, io: Arc<ChildIo>) {
        self.children.borrow_mut().insert(id, io);
    }

    /// Takes an event from a thread or a reply: queued, fed in turn
    fn accept(self: &Rc<Self>, event: Event) {
        match &event {
            Event::Done { id, .. } | Event::Failed { id, .. } => {
                // cancelled commands (and ids nobody waits for) get nothing
                if !self.inflight.borrow_mut().remove(id) {
                    return;
                }
                self.local.borrow_mut().remove(id);
            }
            Event::Child {
                child,
                event: ChildEvent::Close { .. },
            } => {
                self.children.borrow_mut().remove(child);
            }
            _ => {}
        }
        self.inbox.borrow_mut().push_back(event);
        self.pump();
    }

    /// Runs what can run: starts, polls, carries commands out, feeds events
    /// one by one. Called from inside itself (a callback of ported code, a
    /// reply given in a handler), it only notes that there is more.
    fn pump(self: &Rc<Self>) {
        if self.pumping.replace(true) {
            self.again.set(true);
            return;
        }
        let _pumping = Pumping(&self.pumping);
        loop {
            self.step();
            let next = self.inbox.borrow_mut().pop_front();
            if let Some(event) = next {
                self.runtime.borrow_mut().feed(event);
                continue;
            }
            if self.again.replace(false) {
                continue;
            }
            return;
        }
    }

    /// Start queued futures, poll, execute the commands in the order queued,
    /// run the `then` of the futures that returned; again while any did
    fn step(self: &Rc<Self>) {
        loop {
            let starts = std::mem::take(&mut *self.starts.borrow_mut());
            if !starts.is_empty() {
                let mut runtime = self.runtime.borrow_mut();
                for start in starts {
                    let finisher = start(&mut runtime);
                    self.finishers.borrow_mut().push(finisher);
                }
            }
            let cmds = self.runtime.borrow_mut().poll();
            let queued = !cmds.is_empty();
            for cmd in cmds {
                self.execute(cmd);
            }
            let finished = self.finish();
            if !queued && !finished && self.starts.borrow().is_empty() {
                return;
            }
        }
    }

    /// Runs the `then` of every future that returned, outside every borrow
    /// (it may start more futures or reply)
    fn finish(&self) -> bool {
        let list = std::mem::take(&mut *self.finishers.borrow_mut());
        let mut any = false;
        let mut running = Vec::with_capacity(list.len());
        for mut finisher in list {
            if finisher() {
                any = true;
            } else {
                running.push(finisher);
            }
        }
        self.finishers.borrow_mut().extend(running);
        any
    }

    fn wait_for(&self, id: Id, local: bool) {
        self.inflight.borrow_mut().insert(id);
        if local {
            self.local.borrow_mut().insert(id);
        }
    }

    fn execute(self: &Rc<Self>, cmd: Cmd) {
        match cmd {
            Cmd::Fetch {
                id,
                via,
                url,
                request,
            } => {
                self.wait_for(id, false);
                self.net
                    .fetch(self.scoped(id), via, url, request, self.sink());
            }
            Cmd::Read { id, body } => {
                self.wait_for(id, false);
                self.net
                    .read(self.scoped(id), self.scoped(body), self.sink());
            }
            Cmd::CloneBody { from, to } => self.net.clone_body(self.scoped(from), self.scoped(to)),
            Cmd::Cancel { id } => {
                self.inflight.borrow_mut().remove(&id);
                if !self.local.borrow_mut().remove(&id) {
                    self.net.cancel(self.scoped(id));
                }
            }
            Cmd::SetTimer { id, ms } => self
                .timers
                .borrow_mut()
                .get_or_insert_with(|| Timers::start(self.poster.clone()))
                .set(id, ms),
            Cmd::ClearTimer { id } => {
                if let Some(timers) = &*self.timers.borrow() {
                    timers.clear(id);
                }
            }
            Cmd::Spawn { id, spawn } => {
                self.wait_for(id, true);
                let poster = self.poster.clone();
                self.workers
                    .spawn(Box::new(move || child::start(id, spawn, poster)));
            }
            Cmd::Stdin { child, data } => {
                if let Some(io) = self.children.borrow().get(&child) {
                    io.write(data);
                }
            }
            Cmd::EndStdin { child } => {
                if let Some(io) = self.children.borrow().get(&child) {
                    io.end_stdin();
                }
            }
            Cmd::KillChild { child, signal } => {
                if let Some(io) = self.children.borrow().get(&child) {
                    io.kill(signal.as_deref());
                }
            }
            Cmd::Fs { id, op } => {
                self.wait_for(id, true);
                let poster = self.poster.clone();
                self.workers.spawn(Box::new(move || {
                    poster.send(match fs::run(&op) {
                        Ok(answer) => Event::Done {
                            id,
                            answer: Answer::Fs(answer),
                        },
                        Err(error) => Event::Failed { id, error },
                    });
                }));
            }
            Cmd::Listen { id, host, port } => {
                self.wait_for(id, false);
                self.net.listen(self.scoped(id), host, port, self.sink());
            }
            Cmd::Respond {
                request,
                status,
                headers,
                body,
            } => self.net.respond(request, status, headers, body),
            Cmd::CloseServer { server } => self.net.close_server(self.scoped(server)),
            Cmd::Call { id, name, args } => self.call(id, &name, args),
            Cmd::Log { level, args } => {
                let line: Vec<String> = args.iter().map(console_text).collect();
                eprintln!("[{level}] {}", line.join(" "));
            }
        }
    }

    fn call(self: &Rc<Self>, id: Id, name: &str, args: JsonValue) {
        self.wait_for(id, true);
        let handler = self.handlers.borrow().get(name).cloned();
        match handler {
            Some(handler) => handler(
                args,
                CallReply {
                    shared: Rc::downgrade(self),
                    id,
                },
            ),
            None => self.accept(Event::Failed {
                id,
                error: JsError::type_error(format!("{name} is not a function")),
            }),
        }
    }
}

/// `console.log` of one argument: a string as it is, the rest as JSON
fn console_text(value: &JsonValue) -> String {
    match value {
        JsonValue::String(text) => text.clone(),
        other => json_value_to_serde(other).to_string(),
    }
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
}

fn random_bytes(n: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; n];
    getrandom::fill(&mut bytes).expect("the platform random source");
    bytes
}

/// `crypto.randomUUID()`
fn random_uuid() -> String {
    let mut b = random_bytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// The reply a ported function waits for, given to a handler of
/// [`Driver::on_call`]. Reply once, now or later, on the core thread; a reply
/// after the runtime cancelled the call, or after the driver is gone, is
/// dropped. A reply never given leaves the call pending.
pub struct CallReply {
    shared: Weak<Shared>,
    id: Id,
}

impl CallReply {
    /// The function returned `value`
    pub fn value(self, value: JsonValue) {
        self.send(Ok(Answer::Value(value)));
    }

    /// The function returned `undefined`
    pub fn unit(self) {
        self.send(Ok(Answer::Unit));
    }

    /// The function threw (or its promise rejected)
    pub fn fail(self, error: JsError) {
        self.send(Err(error));
    }

    fn send(self, outcome: Result<Answer, JsError>) {
        let Some(shared) = self.shared.upgrade() else {
            return;
        };
        let id = self.id;
        shared.accept(match outcome {
            Ok(answer) => Event::Done { id, answer },
            Err(error) => Event::Failed { id, error },
        });
    }
}

/// The settling half of [`Driver::deferred`]
pub struct Resolver<T> {
    settle: Settle<T>,
    shared: Weak<Shared>,
}

impl<T> Clone for Resolver<T> {
    fn clone(&self) -> Self {
        Resolver {
            settle: self.settle.clone(),
            shared: self.shared.clone(),
        }
    }
}

impl<T> Resolver<T> {
    /// Settles the promise (a second time keeps the first value) and lets the
    /// futures that wait for it go on. Core thread only.
    pub fn resolve(&self, value: T) {
        self.settle.settle(value);
        if let Some(shared) = self.shared.upgrade() {
            shared.pump();
        }
    }
}

/// One per core thread (or per area that wants its own state); cheap to
/// clone. Not `Send`.
#[derive(Clone)]
pub struct Driver {
    shared: Rc<Shared>,
}

impl Driver {
    /// Built once in a port factory, on the core thread, from the shell's
    /// services and the batch's [`NetHost`]
    pub fn new(services: &Services, net: NetHost) -> Driver {
        let clock = services.hosts.get::<RuntimeClock>().cloned();
        Driver::with_clock(
            services.core.clone(),
            services.workers.clone(),
            &services.paths.path(PathName::Temp),
            &services.paths.path(PathName::Home),
            net,
            clock,
        )
    }

    #[cfg(test)]
    fn from_parts(
        core: Arc<dyn Thread>,
        workers: Arc<dyn Workers>,
        tmpdir: &Path,
        homedir: &Path,
        net: NetHost,
    ) -> Driver {
        Driver::with_clock(core, workers, tmpdir, homedir, net, None)
    }

    fn with_clock(
        core: Arc<dyn Thread>,
        workers: Arc<dyn Workers>,
        tmpdir: &Path,
        homedir: &Path,
        net: NetHost,
        clock: Option<RuntimeClock>,
    ) -> Driver {
        let scope = NEXT_SCOPE.fetch_add(1, Ordering::Relaxed);
        assert!(scope < 1 << (64 - SCOPE_SHIFT), "more drivers than ids");
        let clock: Box<dyn Fn() -> f64> = match clock {
            Some(RuntimeClock(clock)) => Box::new(move || clock()),
            None => Box::new(now_ms),
        };
        let started_at = clock();
        let runtime = Runtime::new(HostInfo {
            platform: crate::secrets::PLATFORM.to_owned(),
            pid: f64::from(std::process::id()),
            tmpdir: text(tmpdir),
            homedir: text(homedir),
            env: std::env::vars_os()
                .map(|(k, v)| {
                    (
                        k.to_string_lossy().into_owned(),
                        v.to_string_lossy().into_owned(),
                    )
                })
                .collect(),
            clock,
            uuid: Box::new(random_uuid),
            random: Box::new(random_bytes),
            kill: Box::new(signal::kill),
        });
        let rt = runtime.rt().clone();
        let shared = Rc::new(Shared {
            scope,
            poster: Poster { core, scope },
            workers,
            net,
            runtime: RefCell::new(runtime),
            rt,
            inbox: RefCell::default(),
            starts: RefCell::default(),
            finishers: RefCell::default(),
            handlers: RefCell::default(),
            inflight: RefCell::default(),
            local: RefCell::default(),
            children: RefCell::default(),
            timers: RefCell::default(),
            pumping: Cell::new(false),
            again: Cell::new(false),
            providers: RefCell::default(),
            started_at,
        });
        DRIVERS.with(|drivers| drivers.borrow_mut().insert(scope, Rc::downgrade(&shared)));
        Driver { shared }
    }

    /// The handle ported functions take
    pub fn rt(&self) -> Rt {
        self.shared.rt.clone()
    }

    /// Starts `future` (it does nothing until polled; the driver polls at
    /// once) and calls `then` with its output, once, on the core thread when
    /// it returns. `then` may start other futures and reply to calls.
    pub fn run<T: 'static>(
        &self,
        future: impl Future<Output = T> + 'static,
        then: impl FnOnce(T) + 'static,
    ) {
        self.shared
            .starts
            .borrow_mut()
            .push(Box::new(move |runtime| {
                let call = runtime.start(future);
                let mut then = Some(then);
                Box::new(move || match call.take() {
                    Some(value) => {
                        if let Some(then) = then.take() {
                            then(value);
                        }
                        true
                    }
                    None => false,
                })
            }));
        self.shared.pump();
    }

    /// A function the ported code calls back by name (`Cmd::Call`):
    /// `openBrowser`, `onExit`... It answers through the [`CallReply`]. A
    /// call to a name nobody registered fails with a `TypeError`. Take care
    /// that the closure does not keep a `Driver` clone: the driver would
    /// keep the closure.
    pub fn on_call(&self, name: &str, f: impl Fn(JsonValue, CallReply) + 'static) {
        self.shared
            .handlers
            .borrow_mut()
            .insert(name.to_owned(), Rc::new(f));
    }

    /// `new Promise(...)`: its settling half and its awaited half, which a
    /// future that runs on this driver may await. [`Resolver::resolve`]
    /// (core thread) lets it go on; a plain channel would not wake it.
    pub fn deferred<T: Clone + 'static>(&self) -> (Resolver<T>, Wait<T>) {
        let (settle, wait) = self.shared.rt.deferred();
        (
            Resolver {
                settle,
                shared: Rc::downgrade(&self.shared),
            },
            wait,
        )
    }

    /// The module states of the AI providers (the fetch retries, the
    /// OpenAI-compatible, gateway and output-cap tables, the Codex pool, the
    /// Claude CLI and ChatGPT bridges) of this driver: made at the first call
    /// as `setUp()` of the provider specs makes them, with the real retry
    /// delays, and the same ones from then on. `chatgpt.connection` is left
    /// to the process's own; a caller that has one sets it on its copy.
    pub fn providers(&self) -> Providers {
        self.shared
            .providers
            .borrow_mut()
            .get_or_insert_with(|| providers(self.shared.started_at))
            .clone()
    }
}

fn providers(started_at: f64) -> Providers {
    let fx = Rc::new(RefCell::new(AiFetchState::default()));
    let shared = SharedChildRegistry::new(started_at);
    let temp_dirs = Rc::new(RefCell::new(SubscriptionTempState::default()));
    let locate = Rc::new(RefCell::new(SubscriptionLocateState::new(shared.clone())));
    Providers {
        fx: fx.clone(),
        openai: Rc::default(),
        gateway: Rc::default(),
        caps: Rc::default(),
        codex: Rc::new(RefCell::new(CodexAppServerState::new(
            shared.clone(),
            locate.clone(),
            temp_dirs.clone(),
        ))),
        claude: ClaudeCodeCliDeps::new(shared, temp_dirs, locate),
        chatgpt: ChatGptBridgeDeps {
            fx,
            fetch: KeyedFetchBase::Ai,
            connection: None,
            module: Rc::new(RefCell::new(ChatGptConnectionModuleState::default())),
        },
    }
}
