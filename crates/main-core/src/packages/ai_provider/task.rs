//! The event loop of the ported AI runtime: what a JavaScript `await` on the
//! network, a timer, a child process, the file system or the caller becomes
//! in `main-core`, which does no I/O and owns no thread.
//!
//! ## Model
//!
//! The caller owns one [`Runtime`] (one per app, as the TypeScript module
//! state is one per main process). A ported `async` function runs on it as a
//! task: [`Runtime::start`] takes the future and answers a [`Call`], whose
//! result is there once the function returned. The futures are plain Rust
//! futures over [`Rt`], the handle every ported function takes: where the
//! TypeScript awaits I/O, the port awaits an [`Rt`] operation, which queues a
//! [`Cmd`] and waits for its [`Event`].
//!
//! The host drives it, on one thread:
//!
//! 1. [`Runtime::poll`] runs every task until none can go further and answers
//!    the commands they queued, in the order queued.
//! 2. The host carries each command out (on a worker for the slow ones) and
//!    hands each outcome back with [`Runtime::feed`], one event at a time, in
//!    the order they happened.
//! 3. After feeding, it calls [`Runtime::poll`] again.
//!
//! A command with an `id` is answered by exactly one [`Event::Done`] or
//! [`Event::Failed`] with that id, unless the runtime sent [`Cmd::Cancel`]
//! for it first; an event for an id the runtime no longer waits on is
//! dropped. Ids are unique within a runtime.
//!
//! Timers and abort signals live inside the runtime, as in JavaScript: a
//! timer is [`Cmd::SetTimer`], and the host feeds [`Event::Timer`] when it is
//! due. When a signal aborts (a timer, or the caller: [`Signal::abort`] on
//! the core thread, then [`Runtime::poll`]), every operation started with it
//! fails at once with the signal's reason and the host is told
//! [`Cmd::Cancel`].
//!
//! Event listeners (a child's output, a server's requests, a signal's
//! `abort`) run synchronously inside [`Runtime::feed`] or the call that
//! raised them, as JavaScript runs an emitter's listeners; the futures go on
//! at the next [`Runtime::poll`], as JavaScript runs promise continuations
//! after the listener returned.
//!
//! Thrown values are [`JsError`].

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker};

use jscompat::JsonValue;

use super::jsval::{Obj, js_string};

/// A command, operation, timer, signal, body, child, server or request.
pub type Id = u64;

// ---------------------------------------------------------------------------
// thrown values
// ---------------------------------------------------------------------------

/// A thrown value. An `Error` (of any class) has a `class`; a thrown value
/// that is no `Error` has an empty `class` and is `props["value"]`.
#[derive(Debug, Clone, PartialEq)]
pub struct JsError {
    /// the constructor: `Error`, `TypeError`, `AiRunError`, `DOMException`...
    pub class: String,
    /// `error.name`
    pub name: String,
    /// `error.message`
    pub message: String,
    /// the other own properties (`code`, `cause`, `kind`...), in the order set
    /// boxed: a thrown value travels in every `Result`, so it stays small
    pub props: Box<Obj>,
}

impl JsError {
    /// `new <class>(message)` whose `name` is the class
    pub fn new(class: &str, message: impl Into<String>) -> JsError {
        JsError {
            class: class.to_owned(),
            name: class.to_owned(),
            message: message.into(),
            props: Box::default(),
        }
    }

    /// `new Error(message)`
    pub fn error(message: impl Into<String>) -> JsError {
        JsError::new("Error", message)
    }

    /// `new TypeError(message)`
    pub fn type_error(message: impl Into<String>) -> JsError {
        JsError::new("TypeError", message)
    }

    /// `new DOMException(message, name)`
    pub fn dom(name: &str, message: impl Into<String>) -> JsError {
        JsError {
            name: name.to_owned(),
            ..JsError::new("DOMException", message)
        }
    }

    /// The reason of `controller.abort()` without one.
    pub fn abort() -> JsError {
        JsError::dom("AbortError", "This operation was aborted")
    }

    /// The reason of `AbortSignal.timeout(ms)`.
    pub fn timeout() -> JsError {
        JsError::dom("TimeoutError", "The operation was aborted due to timeout")
    }

    /// `throw value` of a value that is no `Error`
    pub fn value(value: JsonValue) -> JsError {
        let mut props: Box<Obj> = Box::default();
        props.set("value", value);
        JsError {
            class: String::new(),
            name: String::new(),
            message: String::new(),
            props,
        }
    }

    /// The error with `error[key] = value`.
    pub fn with(mut self, key: &str, value: JsonValue) -> JsError {
        self.props.set(key, value);
        self
    }

    /// The error with `error.name = name`.
    pub fn named(mut self, name: &str) -> JsError {
        self.name = name.to_owned();
        self
    }

    /// `err instanceof <class>` for a class without subclasses here
    pub fn is(&self, class: &str) -> bool {
        self.class == class
    }

    /// `err instanceof Error`
    pub fn is_error(&self) -> bool {
        !self.class.is_empty()
    }

    /// An own property; for a thrown value that is no `Error`, the property of
    /// that value.
    pub fn prop(&self, key: &str) -> Option<&JsonValue> {
        if self.is_error() {
            return self.props.get(key);
        }
        match self.props.get("value") {
            Some(JsonValue::Object(o)) => o.get(key),
            _ => None,
        }
    }

    /// `String(err)`
    pub fn to_js_string(&self) -> String {
        if !self.is_error() {
            return self.props.get("value").map(js_string).unwrap_or_default();
        }
        match (self.name.is_empty(), self.message.is_empty()) {
            (_, true) => self.name.clone(),
            (true, false) => self.message.clone(),
            (false, false) => format!("{}: {}", self.name, self.message),
        }
    }

    /// `err instanceof Error ? err.message : String(err)`
    pub fn message_or_string(&self) -> String {
        if self.is_error() {
            self.message.clone()
        } else {
            self.to_js_string()
        }
    }

    /// The value `jsval::error_class` and the classifiers of this package
    /// read: `{"$class", "message", ...props}`, `name` only where it is not
    /// the class; the value itself for a thrown value that is no `Error`.
    pub fn to_json(&self) -> JsonValue {
        if !self.is_error() {
            return self.props.get("value").cloned().unwrap_or(JsonValue::Null);
        }
        let mut out = Obj::new();
        out.set("$class", JsonValue::String(self.class.clone()));
        if self.name != self.class {
            out.set("name", JsonValue::String(self.name.clone()));
        }
        out.set("message", JsonValue::String(self.message.clone()));
        for (key, value) in self.props.entries() {
            out.set(key, value.clone());
        }
        JsonValue::Object(out)
    }
}

// ---------------------------------------------------------------------------
// what goes out, what comes in
// ---------------------------------------------------------------------------

/// Which `fetch` a request goes through.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fetcher {
    /// Node's global `fetch` (undici): hands a 3xx back under `redirect: 'manual'`
    Node,
    /// Electron's `net.fetch` (Chromium's network stack): throws on a redirect
    /// it is told not to follow
    Net,
    /// the page's embed host (seuoffice web, `setAiFetch`)
    Embed,
}

/// A request body.
#[derive(Debug, Clone, PartialEq)]
pub enum RequestBody {
    Text(String),
    Bytes(Vec<u8>),
    /// `FormData`: the host writes it as `multipart/form-data`
    Form(Vec<FormPart>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct FormPart {
    pub name: String,
    pub value: FormValue,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FormValue {
    Text(String),
    /// `new Blob([bytes], { type })` with the file name `append` gave
    Blob {
        bytes: Vec<u8>,
        mime: String,
        filename: Option<String>,
    },
}

/// The `init` of a `fetch`, as sent. The signal stays in the runtime.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Request {
    /// `None`: not given (`GET`)
    pub method: Option<String>,
    /// in the order the record held them
    pub headers: Vec<(String, String)>,
    pub body: Option<RequestBody>,
    /// `'manual'`, `'follow'`, `'error'`; `None`: not given
    pub redirect: Option<String>,
}

/// A `Response` as it arrives with its headers.
#[derive(Debug, Clone, PartialEq)]
pub struct ResponseHead {
    pub status: f64,
    pub status_text: String,
    /// in the order received; a name may come more than once
    pub headers: Vec<(String, String)>,
    pub url: String,
    pub redirected: bool,
    /// `response.type`: `basic`, `cors`, `opaqueredirect`...
    pub kind: String,
    /// `response.body !== null`; the body's id is the fetch's id
    pub has_body: bool,
}

/// `stdio` of a child, per stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stdio {
    Pipe,
    Ignore,
    Inherit,
}

/// The arguments of `spawn(command, args, options)`.
#[derive(Debug, Clone, PartialEq)]
pub struct SpawnRequest {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// `None`: the app's own environment
    pub env: Option<Vec<(String, String)>>,
    pub stdio: [Stdio; 3],
    pub detached: bool,
    pub windows_hide: bool,
    /// `options.shell` as a path: the command line runs through that program
    /// (`cmd.exe /d /s /c`), as Node does; `None`: no shell
    pub shell: Option<String>,
}

/// A file system call of `node:fs/promises` (or a synchronous one, which the
/// port awaits like the others).
#[derive(Debug, Clone, PartialEq)]
pub enum FsOp {
    /// answers [`FsAnswer::Bytes`]
    ReadFile {
        path: String,
    },
    WriteFile {
        path: String,
        data: Vec<u8>,
        mode: Option<f64>,
        /// `'wx'` and the like; `None`: not given
        flag: Option<String>,
    },
    Mkdir {
        path: String,
        recursive: bool,
        mode: Option<f64>,
    },
    /// answers [`FsAnswer::Path`]
    Mkdtemp {
        prefix: String,
    },
    Rm {
        path: String,
        recursive: bool,
        force: bool,
    },
    /// answers [`FsAnswer::Entries`]; `with_types`: `{ withFileTypes: true }`
    Readdir {
        path: String,
        with_types: bool,
    },
    /// answers [`FsAnswer::Stat`]
    Stat {
        path: String,
    },
    /// answers [`FsAnswer::Stat`]
    Lstat {
        path: String,
    },
    /// answers [`FsAnswer::Path`]
    Realpath {
        path: String,
    },
    /// answers [`FsAnswer::Path`]
    Readlink {
        path: String,
    },
    Rename {
        from: String,
        to: String,
    },
    Chmod {
        path: String,
        mode: f64,
    },
    /// `access(path, mode)`: `mode` is the `constants.X_OK` family (1: execute); answers
    /// [`FsAnswer::Unit`] or fails as Node does
    Access {
        path: String,
        mode: f64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    Other,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FileStat {
    pub kind: FileKind,
    pub size: f64,
    pub mtime_ms: f64,
    pub mode: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DirEntry {
    pub name: String,
    /// `None` without `withFileTypes`
    pub kind: Option<FileKind>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FsAnswer {
    Unit,
    Bytes(Vec<u8>),
    Path(String),
    Entries(Vec<DirEntry>),
    Stat(FileStat),
}

/// What the runtime asks of the host.
#[derive(Debug, Clone, PartialEq)]
pub enum Cmd {
    /// `fetch(url, init)`: answer [`Answer::Response`] once the headers are in
    Fetch {
        id: Id,
        via: Fetcher,
        url: String,
        request: Request,
    },
    /// `reader.read()` of the body of the fetch `body`: answer
    /// [`Answer::Chunk`] or [`Answer::End`]
    Read { id: Id, body: Id },
    /// `response.clone()`: `to` is a new body with the bytes `from` has not
    /// handed out yet; both are read on their own (`Read` with either id)
    CloneBody { from: Id, to: Id },
    /// Stop the operation `id`, or the stream of the fetch `id` (its body and
    /// every clone: sent once no branch reads it any more, or its signal
    /// aborted); nothing answers it, and an answer already on its way is
    /// dropped. A stream a [`Cmd::Release`] already stopped may still get
    /// one (its signal aborts later, as in JavaScript): nothing to do then.
    Cancel { id: Id },
    /// The program dropped its handle to the body `body` (the fetch's or a
    /// clone's) before the host handed it its end, which JavaScript leaves to
    /// the garbage collector, or cancelled it while every other branch was
    /// dropped: free that branch's buffered bytes. `stop`: no branch can read
    /// the stream of that fetch any more and it has not ended; stop it as for
    /// [`Cmd::Cancel`]. Nothing answers it, and an answer already on its way
    /// is dropped.
    Release { body: Id, stop: Option<Id> },
    /// `setTimeout(..., ms)`: feed [`Event::Timer`] when it is due
    SetTimer { id: Id, ms: f64 },
    /// `clearTimeout`: the timer `id` is not fed
    ClearTimer { id: Id },
    /// `spawn(...)`: answer [`Answer::Spawned`], then the child's events
    /// ([`Event::Child`]) under this id
    Spawn { id: Id, spawn: SpawnRequest },
    /// `child.stdin.write(data)`
    Stdin { child: Id, data: Vec<u8> },
    /// `child.stdin.end()`
    EndStdin { child: Id },
    /// `child.kill(signal)`; `None`: `SIGTERM`
    KillChild { child: Id, signal: Option<String> },
    /// a file system call: answer [`Answer::Fs`]
    Fs { id: Id, op: FsOp },
    /// `server.listen(port, host)`: answer [`Answer::Listening`], then the
    /// server's requests ([`Event::Request`]) under this id
    Listen { id: Id, host: String, port: f64 },
    /// `res.writeHead(status, headers).end(body)` for the request `request`
    Respond {
        request: Id,
        status: f64,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
    },
    /// `server.close()`
    CloseServer { server: Id },
    /// a function the caller passed in (`openBrowser`, `onExit`...), by its
    /// name in the ported module: answer [`Answer::Value`], or
    /// [`Answer::Unit`] for `undefined`
    Call {
        id: Id,
        name: String,
        args: JsonValue,
    },
    /// `console.<level>(...args)`
    Log { level: String, args: Vec<JsonValue> },
}

/// The outcome of a command.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    Response(ResponseHead),
    Chunk(Vec<u8>),
    End,
    /// `child.pid`; `None`: the child did not start, its `error` event follows
    Spawned {
        pid: Option<f64>,
    },
    Fs(FsAnswer),
    /// the port the server listens on
    Listening {
        port: f64,
    },
    Value(JsonValue),
    Unit,
}

/// What a child emits.
#[derive(Debug, Clone, PartialEq)]
pub enum ChildEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    /// `'error'`
    Error(JsError),
    /// `'exit'`
    Exit {
        code: Option<f64>,
        signal: Option<String>,
    },
    /// `'close'`: the streams are closed (their `'end'` and `'close'` too)
    Close {
        code: Option<f64>,
        signal: Option<String>,
    },
}

/// A request to a server of [`Cmd::Listen`].
#[derive(Debug, Clone, PartialEq)]
pub struct HttpRequest {
    /// the id [`Cmd::Respond`] answers
    pub id: Id,
    pub method: String,
    /// `req.url`: the path and query
    pub url: String,
    pub headers: Vec<(String, String)>,
}

/// What the host hands back.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Done {
        id: Id,
        answer: Answer,
    },
    /// the command threw or its promise rejected
    Failed {
        id: Id,
        error: JsError,
    },
    Timer {
        id: Id,
    },
    Child {
        child: Id,
        event: ChildEvent,
    },
    Request {
        server: Id,
        request: HttpRequest,
    },
}

/// What a runtime reads of the machine without asking: the values Node reads
/// synchronously.
pub struct HostInfo {
    /// `process.platform`
    pub platform: String,
    /// `process.pid`
    pub pid: f64,
    /// `os.tmpdir()`
    pub tmpdir: String,
    /// `os.homedir()`
    pub homedir: String,
    /// `process.env`
    pub env: Vec<(String, String)>,
    /// `Date.now()`
    pub clock: Box<dyn Fn() -> f64>,
    /// `crypto.randomUUID()`
    pub uuid: Box<dyn FnMut() -> String>,
    /// `crypto.randomBytes(n)`
    pub random: Box<dyn FnMut(usize) -> Vec<u8>>,
    /// `process.kill(pid, signal)`: the one synchronous host call that does
    /// I/O. The shell runs it inline on the core thread, so it must not
    /// block (`kill(2)` does not). A negative pid is a process group, `None`
    /// is `SIGTERM`; the `Err` is what Node throws (`ESRCH`, `EPERM`), which
    /// callers act on at once, as the TypeScript does (a child that leads no
    /// group is then signalled alone)
    pub kill: KillFn,
}

// ---------------------------------------------------------------------------
// the runtime
// ---------------------------------------------------------------------------

/// `process.kill(pid, signal)` on the host, see [`HostInfo::kill`]
pub type KillFn = Box<dyn FnMut(f64, Option<&str>) -> Result<(), JsError>>;
type Listener = Rc<RefCell<dyn FnMut(&ChildEvent)>>;
type AbortListener = (Id, Box<dyn FnOnce(&JsError)>);
type Handler = Rc<RefCell<dyn FnMut(HttpRequest)>>;
type LocalFuture = Pin<Box<dyn Future<Output = ()>>>;

enum Timer {
    Callback(Box<dyn FnOnce()>),
    Sleep(Id),
}

#[derive(Default)]
struct SignalState {
    reason: Option<JsError>,
    listeners: Vec<AbortListener>,
    /// operations and bodies that end with the signal
    bound: Vec<Id>,
}

#[derive(Default)]
struct ChildState {
    /// the spawn's answer reached the code that started it
    ready: bool,
    queued: VecDeque<ChildEvent>,
    listeners: Vec<Listener>,
    stdin_open: bool,
    closed: bool,
}

#[derive(Default)]
struct BodyState {
    done: bool,
    signal: Option<Id>,
    /// the fetch whose stream this body (or a clone of it) reads
    source: Id,
    /// the `Cmd::Read`s in flight (a reader takes several `read()` calls at
    /// once), which a cancel of the body ends
    reads: Vec<Id>,
    /// the stream failed: every later `read()` rejects with this
    failed: Option<JsError>,
    /// the host handed this branch its end or its failure: it freed it
    over: bool,
    /// the program dropped its handle ([`Cmd::Release`])
    released: bool,
}

/// The stream of one fetch, which `response.clone()` tees: it is cancelled
/// when no branch reads it any more, unless it has ended.
#[derive(Default)]
struct SourceState {
    /// branches neither read to their end nor cancelled; a dropped branch
    /// still counts, as an unreachable JavaScript one does until it is
    /// collected, so what the program sees does not depend on drops
    live: usize,
    ended: bool,
    cancelled: bool,
    /// [`Cmd::Release`] stopped it: what JavaScript would still do to it
    /// (an abort's `Cancel`) reaches the host, which ignores it
    stopped: bool,
}

#[derive(Default)]
struct State {
    next: Id,
    cmds: Vec<Cmd>,
    /// pending (`None`) or settled operations
    ops: BTreeMap<Id, Option<Result<Answer, JsError>>>,
    timers: BTreeMap<Id, Timer>,
    signals: BTreeMap<Id, SignalState>,
    children: BTreeMap<Id, ChildState>,
    bodies: BTreeMap<Id, BodyState>,
    sources: BTreeMap<Id, SourceState>,
    servers: BTreeMap<Id, Handler>,
    spawned: Vec<LocalFuture>,
}

struct Inner {
    host: RefCell<HostInfo>,
    st: RefCell<State>,
    /// something settled since the last pass: the tasks may go further
    dirty: Cell<bool>,
    /// bodies whose handle went, released at the next [`Runtime::poll`] (or
    /// [`Rt::take_cmds`]): a handle may go while the state is borrowed (a
    /// cleared timer's callback, a dropped task), so the drop only notes it
    dropped: RefCell<Vec<Id>>,
}

/// The handle a ported function awaits through. Cloning it is cheap.
#[derive(Clone)]
pub struct Rt(Rc<Inner>);

impl Rt {
    fn id(&self) -> Id {
        let mut st = self.0.st.borrow_mut();
        st.next += 1;
        st.next
    }

    fn push(&self, cmd: Cmd) {
        self.0.st.borrow_mut().cmds.push(cmd);
    }

    fn mark(&self) {
        self.0.dirty.set(true);
    }

    // ---- what Node reads synchronously ----

    /// `process.platform`
    pub fn platform(&self) -> String {
        self.0.host.borrow().platform.clone()
    }

    /// `process.pid`
    pub fn pid(&self) -> f64 {
        self.0.host.borrow().pid
    }

    /// `os.tmpdir()`
    pub fn tmpdir(&self) -> String {
        self.0.host.borrow().tmpdir.clone()
    }

    /// `os.homedir()`
    pub fn homedir(&self) -> String {
        self.0.host.borrow().homedir.clone()
    }

    /// `process.env[key]`; on Windows the name is matched without case
    pub fn env(&self, key: &str) -> Option<String> {
        let host = self.0.host.borrow();
        let windows = host.platform == "win32";
        host.env
            .iter()
            .find(|(k, _)| {
                if windows {
                    k.eq_ignore_ascii_case(key)
                } else {
                    k == key
                }
            })
            .map(|(_, v)| v.clone())
    }

    /// `process.env`, whole
    pub fn env_all(&self) -> Vec<(String, String)> {
        self.0.host.borrow().env.clone()
    }

    /// `Date.now()`
    pub fn now(&self) -> f64 {
        (self.0.host.borrow().clock)()
    }

    /// `crypto.randomUUID()`
    pub fn random_uuid(&self) -> String {
        (self.0.host.borrow_mut().uuid)()
    }

    /// `crypto.randomBytes(n)`
    pub fn random_bytes(&self, n: usize) -> Vec<u8> {
        (self.0.host.borrow_mut().random)(n)
    }

    /// The commands queued since the last [`Runtime::poll`], in the order
    /// queued, taken out of the queue. A host that must interleave what it
    /// does for them with what the tasks' callbacks did (a log, a trace)
    /// takes them as the callbacks run; [`Runtime::poll`] answers the rest.
    pub fn take_cmds(&self) -> Vec<Cmd> {
        if self.0.st.try_borrow_mut().is_err() {
            return Vec::new();
        }
        self.release_dropped();
        std::mem::take(&mut self.0.st.borrow_mut().cmds)
    }

    /// `console.<level>(...args)`
    pub fn log(&self, level: &str, args: Vec<JsonValue>) {
        self.push(Cmd::Log {
            level: level.to_owned(),
            args,
        });
    }

    // ---- operations ----

    /// An operation: `cmd` gets its id. With a signal that has aborted, it
    /// fails at once with the reason and nothing is sent.
    fn op(&self, signal: Option<&Signal>, cmd: impl FnOnce(Id) -> Cmd) -> Op {
        let id = self.id();
        if let Some(reason) = signal.and_then(Signal::reason) {
            self.0.st.borrow_mut().ops.insert(id, Some(Err(reason)));
            return Op {
                rt: self.clone(),
                id,
            };
        }
        let mut st = self.0.st.borrow_mut();
        st.ops.insert(id, None);
        if let Some(signal) = signal
            && let Some(s) = st.signals.get_mut(&signal.id)
        {
            s.bound.push(id);
        }
        st.cmds.push(cmd(id));
        Op {
            rt: self.clone(),
            id,
        }
    }

    fn settle(&self, id: Id, outcome: Result<Answer, JsError>) {
        let mut st = self.0.st.borrow_mut();
        if let Some(slot @ None) = st.ops.get_mut(&id) {
            *slot = Some(outcome);
            drop(st);
            self.mark();
        }
    }

    /// `await fetch(url, init)` with `init.signal` = `signal`
    pub async fn fetch(
        &self,
        via: Fetcher,
        url: &str,
        request: Request,
        signal: Option<&Signal>,
    ) -> Result<Response, JsError> {
        let op = self.op(signal, |id| Cmd::Fetch {
            id,
            via,
            url: url.to_owned(),
            request,
        });
        let id = op.id;
        match op.await? {
            Answer::Response(head) => {
                let body = if head.has_body {
                    {
                        let mut st = self.0.st.borrow_mut();
                        st.bodies.insert(
                            id,
                            BodyState {
                                done: false,
                                signal: signal.map(|s| s.id),
                                source: id,
                                ..BodyState::default()
                            },
                        );
                        st.sources.insert(
                            id,
                            SourceState {
                                live: 1,
                                ..SourceState::default()
                            },
                        );
                    }
                    if let Some(signal) = signal
                        && let Some(s) = self.0.st.borrow_mut().signals.get_mut(&signal.id)
                    {
                        s.bound.push(id);
                    }
                    Some(id)
                } else {
                    None
                };
                Ok(Response {
                    rt: self.clone(),
                    head,
                    body,
                    signal: signal.cloned(),
                })
            }
            other => Err(JsError::type_error(format!("fetch answered {other:?}"))),
        }
    }

    /// `await fs.<op>`
    pub async fn fs(&self, op: FsOp) -> Result<FsAnswer, JsError> {
        match self.op(None, |id| Cmd::Fs { id, op }).await? {
            Answer::Fs(answer) => Ok(answer),
            Answer::Unit => Ok(FsAnswer::Unit),
            other => Err(JsError::type_error(format!("fs answered {other:?}"))),
        }
    }

    /// `await fn(...args)` of a function the caller passed in, by its name;
    /// `undefined` reads as `null` (see [`Rt::call_exact`] where the two differ)
    pub async fn call(&self, name: &str, args: JsonValue) -> Result<JsonValue, JsError> {
        Ok(self
            .call_exact(name, args)
            .await?
            .unwrap_or(JsonValue::Null))
    }

    /// `await fn(...args)`: `None` is `undefined` (the host answers
    /// [`Answer::Unit`]), `Some(JsonValue::Null)` is `null`
    /// ([`Answer::Value`] of null).
    pub async fn call_exact(
        &self,
        name: &str,
        args: JsonValue,
    ) -> Result<Option<JsonValue>, JsError> {
        match self
            .op(None, |id| Cmd::Call {
                id,
                name: name.to_owned(),
                args,
            })
            .await?
        {
            Answer::Value(value) => Ok(Some(value)),
            _ => Ok(None),
        }
    }

    /// `await new Promise((r) => setTimeout(r, ms))`
    pub async fn sleep(&self, ms: f64) {
        let id = self.id();
        {
            let mut st = self.0.st.borrow_mut();
            st.ops.insert(id, None);
            st.timers.insert(id, Timer::Sleep(id));
            st.cmds.push(Cmd::SetTimer { id, ms });
        }
        let _ = Op {
            rt: self.clone(),
            id,
        }
        .await;
    }

    /// `setTimeout(callback, ms)`
    pub fn set_timeout(&self, ms: f64, callback: impl FnOnce() + 'static) -> Id {
        let id = self.id();
        let mut st = self.0.st.borrow_mut();
        st.timers.insert(id, Timer::Callback(Box::new(callback)));
        st.cmds.push(Cmd::SetTimer { id, ms });
        id
    }

    /// `clearTimeout(timer)`; a timer that fired or was cleared is nothing
    pub fn clear_timeout(&self, timer: Option<Id>) {
        let Some(id) = timer else { return };
        let mut st = self.0.st.borrow_mut();
        if st.timers.remove(&id).is_some() {
            st.ops.remove(&id);
            st.cmds.push(Cmd::ClearTimer { id });
        }
    }

    // ---- signals ----

    /// `new AbortController()`: its signal, which [`Signal::abort`] aborts
    pub fn controller(&self) -> Signal {
        let id = self.id();
        self.0
            .st
            .borrow_mut()
            .signals
            .insert(id, SignalState::default());
        Signal {
            rt: self.clone(),
            id,
        }
    }

    /// `AbortSignal.any(signals)`
    pub fn any_signal(&self, signals: &[&Signal]) -> Signal {
        let out = self.controller();
        if let Some(reason) = signals.iter().find_map(|s| s.reason()) {
            if let Some(s) = self.0.st.borrow_mut().signals.get_mut(&out.id) {
                s.reason = Some(reason);
            }
            return out;
        }
        for source in signals {
            let target = out.clone();
            source.on_abort(move |reason| target.abort(Some(reason.clone())));
        }
        out
    }

    /// `AbortSignal.timeout(ms)`
    pub fn timeout_signal(&self, ms: f64) -> Signal {
        let out = self.controller();
        let target = out.clone();
        self.set_timeout(ms, move || target.abort(Some(JsError::timeout())));
        out
    }

    fn abort_signal(&self, id: Id, reason: Option<JsError>) {
        let (reason, listeners, bound) = {
            let mut st = self.0.st.borrow_mut();
            let Some(s) = st.signals.get_mut(&id) else {
                return;
            };
            if s.reason.is_some() {
                return;
            }
            let reason = reason.unwrap_or_else(JsError::abort);
            s.reason = Some(reason.clone());
            let listeners = std::mem::take(&mut s.listeners);
            let bound = std::mem::take(&mut s.bound);
            (reason, listeners, bound)
        };
        {
            let mut st = self.0.st.borrow_mut();
            for op in bound {
                if let Some(slot @ None) = st.ops.get_mut(&op) {
                    *slot = Some(Err(reason.clone()));
                    st.cmds.push(Cmd::Cancel { id: op });
                } else if let Some(body) = st.bodies.get_mut(&op)
                    && !body.done
                {
                    // the signal errors the stream itself, whatever its branches
                    body.done = true;
                    let source = body.source;
                    if let Some(src) = st.sources.get_mut(&source) {
                        src.live = src.live.saturating_sub(1);
                        if !src.ended && !src.cancelled {
                            src.cancelled = true;
                            st.cmds.push(Cmd::Cancel { id: source });
                        }
                    }
                }
            }
        }
        self.mark();
        for (_, listener) in listeners {
            listener(&reason);
        }
    }

    // ---- bodies ----

    async fn read_body(&self, body: Id) -> Result<Option<Vec<u8>>, JsError> {
        let signal = {
            let st = self.0.st.borrow();
            match st.bodies.get(&body) {
                None => return Ok(None),
                Some(b) => {
                    if let Some(reason) = b
                        .signal
                        .and_then(|s| st.signals.get(&s))
                        .and_then(|s| s.reason.clone())
                    {
                        return Err(reason);
                    }
                    if let Some(error) = &b.failed {
                        return Err(error.clone());
                    }
                    if b.done {
                        return Ok(None);
                    }
                    b.signal
                }
            }
        };
        let signal = signal.map(|id| Signal {
            rt: self.clone(),
            id,
        });
        let op = self.op(signal.as_ref(), |id| Cmd::Read { id, body });
        let id = op.id;
        if let Some(b) = self.0.st.borrow_mut().bodies.get_mut(&body) {
            b.reads.push(id);
        }
        let outcome = op.await;
        let others = {
            let mut st = self.0.st.borrow_mut();
            let Some(b) = st.bodies.get_mut(&body) else {
                return Ok(None);
            };
            match b.reads.iter().position(|r| *r == id) {
                Some(at) => {
                    b.reads.remove(at);
                }
                // another settled it: `reader.cancel()` ends it as
                // `{ done: true }` (the stream is not over for the body's
                // other branches), the stream's end or failure as the read
                // that met it
                None => {
                    return match &b.failed {
                        Some(error) => Err(error.clone()),
                        None => Ok(None),
                    };
                }
            }
            // the stream closed or failed: it settles every other pending
            // read alike, and a failure every later one
            match &outcome {
                Ok(Answer::Chunk(_)) => Vec::new(),
                Ok(_) => std::mem::take(&mut b.reads),
                Err(error) => {
                    b.failed = Some(error.clone());
                    std::mem::take(&mut b.reads)
                }
            }
        };
        for other in others {
            let alike = match &outcome {
                Err(error) => Err(error.clone()),
                Ok(_) => Ok(Answer::End),
            };
            self.settle(other, alike);
        }
        match outcome {
            Ok(Answer::Chunk(bytes)) => Ok(Some(bytes)),
            Ok(_) => {
                self.body_over(body);
                Ok(None)
            }
            Err(e) => {
                self.body_over(body);
                Err(e)
            }
        }
    }

    /// A branch read its stream to the end (or the stream failed): the
    /// stream is over for every branch.
    fn body_over(&self, body: Id) {
        let mut st = self.0.st.borrow_mut();
        let Some(b) = st.bodies.get_mut(&body) else {
            return;
        };
        let was_done = std::mem::replace(&mut b.done, true);
        b.over = true;
        let source = b.source;
        if let Some(src) = st.sources.get_mut(&source) {
            src.ended = true;
            if !was_done {
                src.live = src.live.saturating_sub(1);
            }
        }
    }

    fn cancel_body(&self, body: Id) {
        let mut st = self.0.st.borrow_mut();
        let Some(b) = st.bodies.get_mut(&body) else {
            return;
        };
        if b.done {
            return;
        }
        b.done = true;
        let reads = std::mem::take(&mut b.reads);
        let source = b.source;
        // a branch the program dropped still counts for `live` (JavaScript's
        // garbage) but reads nothing: with none other left to read, the host
        // stops the stream through a release, no `Cancel` the program would see
        let reading = st
            .bodies
            .values()
            .any(|b| b.source == source && !b.released && !b.done);
        if let Some(src) = st.sources.get_mut(&source) {
            src.live = src.live.saturating_sub(1);
            if src.live == 0 && !src.ended && !src.cancelled {
                src.cancelled = true;
                st.cmds.push(Cmd::Cancel { id: source });
            } else if !reading && !src.ended && !src.cancelled && !src.stopped {
                src.stopped = true;
                st.cmds.push(Cmd::Release {
                    body,
                    stop: Some(source),
                });
            }
        }
        drop(st);
        for read in reads {
            self.settle(read, Ok(Answer::End));
        }
    }

    /// Release the bodies whose handle went since the last call.
    fn release_dropped(&self) {
        let dropped = std::mem::take(&mut *self.0.dropped.borrow_mut());
        for body in dropped {
            self.release_body(body);
        }
    }

    /// The handle to `body` went (JavaScript's garbage collector frees it
    /// unseen). A branch the host still keeps is released, and the stream
    /// stops once no branch can read it. The program's view (`live`, an
    /// abort's `Cancel`) does not change, as JavaScript's does not at a drop.
    fn release_body(&self, body: Id) {
        let mut st = self.0.st.borrow_mut();
        let Some(b) = st.bodies.get_mut(&body) else {
            return;
        };
        b.released = true;
        let (over, source) = (b.over, b.source);
        let reading = st
            .bodies
            .values()
            .any(|b| b.source == source && !b.released && !b.done);
        let Some(src) = st.sources.get_mut(&source) else {
            return;
        };
        if over || src.cancelled || src.stopped {
            return;
        }
        let stop = (!src.ended && !reading).then_some(source);
        src.stopped = stop.is_some();
        st.cmds.push(Cmd::Release { body, stop });
    }

    fn clone_body(&self, body: Id) -> Id {
        let to = self.id();
        let mut st = self.0.st.borrow_mut();
        let (done, signal, source) = st
            .bodies
            .get(&body)
            .map_or((true, None, body), |b| (b.done, b.signal, b.source));
        st.bodies.insert(
            to,
            BodyState {
                done,
                signal,
                source,
                ..BodyState::default()
            },
        );
        if !done && let Some(src) = st.sources.get_mut(&source) {
            src.live += 1;
        }
        if let Some(s) = signal.and_then(|s| st.signals.get_mut(&s)) {
            s.bound.push(to);
        }
        st.cmds.push(Cmd::CloneBody { from: body, to });
        to
    }

    // ---- children ----

    /// `spawn(command, args, options)`. Node answers the child at once and
    /// reports a failure to start as its `error` event; here the start is
    /// awaited, and [`Child::pid`] is `None` for a child that did not start.
    /// An `Err` is what `spawn` threw.
    pub async fn spawn(&self, spawn: SpawnRequest) -> Result<Child, JsError> {
        let stdin = spawn.stdio[0] == Stdio::Pipe;
        let op = self.op(None, |id| Cmd::Spawn { id, spawn });
        let id = op.id;
        self.0.st.borrow_mut().children.insert(
            id,
            ChildState {
                stdin_open: stdin,
                ..ChildState::default()
            },
        );
        let answer = op.await;
        let pid = match answer {
            Ok(Answer::Spawned { pid }) => pid,
            Ok(_) => None,
            Err(e) => {
                self.0.st.borrow_mut().children.remove(&id);
                return Err(e);
            }
        };
        if let Some(c) = self.0.st.borrow_mut().children.get_mut(&id) {
            c.ready = true;
        }
        self.mark();
        Ok(Child {
            rt: self.clone(),
            id,
            pid,
        })
    }

    /// `process.kill(pid, signal)`: `Err` is what it threw
    pub fn kill_pid(&self, pid: f64, signal: Option<&str>) -> Result<(), JsError> {
        (self.0.host.borrow_mut().kill)(pid, signal)
    }

    fn deliver(&self, child: Id, event: ChildEvent) {
        let listeners: Vec<Listener> = {
            let mut st = self.0.st.borrow_mut();
            let Some(c) = st.children.get_mut(&child) else {
                return;
            };
            if !c.ready {
                c.queued.push_back(event);
                return;
            }
            if matches!(event, ChildEvent::Close { .. }) {
                c.closed = true;
                c.stdin_open = false;
            }
            c.listeners.clone()
        };
        for listener in &listeners {
            (*listener.borrow_mut())(&event);
        }
        if matches!(event, ChildEvent::Close { .. }) {
            self.0.st.borrow_mut().children.remove(&child);
        }
        self.mark();
    }

    /// The events that arrived before the spawn's answer reached its code.
    fn deliver_queued(&self) -> bool {
        let ready: Vec<(Id, ChildEvent)> = {
            let mut st = self.0.st.borrow_mut();
            let mut out = Vec::new();
            for (id, c) in st.children.iter_mut() {
                if c.ready {
                    while let Some(e) = c.queued.pop_front() {
                        out.push((*id, e));
                    }
                }
            }
            out
        };
        let any = !ready.is_empty();
        for (id, event) in ready {
            self.deliver(id, event);
        }
        any
    }

    // ---- servers ----

    /// `server.listen(port, host)` of an `http.createServer(handler)`:
    /// answers the server and the port it listens on
    pub async fn listen(
        &self,
        host: &str,
        port: f64,
        handler: impl FnMut(HttpRequest) + 'static,
    ) -> Result<(Server, f64), JsError> {
        let op = self.op(None, |id| Cmd::Listen {
            id,
            host: host.to_owned(),
            port,
        });
        let id = op.id;
        self.0
            .st
            .borrow_mut()
            .servers
            .insert(id, Rc::new(RefCell::new(handler)));
        match op.await {
            Ok(Answer::Listening { port }) => Ok((
                Server {
                    rt: self.clone(),
                    id,
                },
                port,
            )),
            Ok(_) => Ok((
                Server {
                    rt: self.clone(),
                    id,
                },
                0.0,
            )),
            Err(e) => {
                self.0.st.borrow_mut().servers.remove(&id);
                Err(e)
            }
        }
    }

    /// `res.writeHead(status, headers); res.end(body)`
    pub fn respond(&self, request: Id, status: f64, headers: Vec<(String, String)>, body: &[u8]) {
        self.push(Cmd::Respond {
            request,
            status,
            headers,
            body: body.to_vec(),
        });
    }

    // ---- promises ----

    /// `new Promise((resolve) => ...)`: the settling half and the awaited half.
    /// The awaited half can be awaited any number of times (a cached promise).
    pub fn deferred<T: Clone + 'static>(&self) -> (Settle<T>, Wait<T>) {
        let cell = Rc::new(RefCell::new(None));
        (
            Settle {
                rt: self.clone(),
                cell: cell.clone(),
            },
            Wait { cell },
        )
    }

    /// A promise left to run on its own (`void promise`, a `.then` chain):
    /// it runs beside the tasks until it ends.
    pub fn spawn_local(&self, future: impl Future<Output = ()> + 'static) {
        self.0.st.borrow_mut().spawned.push(Box::pin(future));
        self.mark();
    }

    /// `const p = fn()`: the promise of a future, started now, awaited later
    /// (any number of times).
    pub fn share<T: Clone + 'static>(&self, future: impl Future<Output = T> + 'static) -> Wait<T> {
        let (settle, wait) = self.deferred();
        self.spawn_local(async move { settle.settle(future.await) });
        wait
    }
}

/// An operation in flight; its output is the host's answer.
pub struct Op {
    rt: Rt,
    id: Id,
}

impl Future for Op {
    type Output = Result<Answer, JsError>;

    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut st = self.rt.0.st.borrow_mut();
        match st.ops.get_mut(&self.id) {
            Some(slot) => match slot.take() {
                Some(outcome) => {
                    st.ops.remove(&self.id);
                    Poll::Ready(outcome)
                }
                None => Poll::Pending,
            },
            None => Poll::Ready(Err(JsError::error("the operation was dropped"))),
        }
    }
}

impl Drop for Op {
    fn drop(&mut self) {
        if let Ok(mut st) = self.rt.0.st.try_borrow_mut()
            && matches!(st.ops.get(&self.id), Some(Some(_)))
        {
            st.ops.remove(&self.id);
        }
    }
}

/// An `AbortSignal`.
#[derive(Clone)]
pub struct Signal {
    rt: Rt,
    id: Id,
}

impl Signal {
    pub fn id(&self) -> Id {
        self.id
    }

    /// `signal.aborted`
    pub fn aborted(&self) -> bool {
        self.reason().is_some()
    }

    /// `signal.reason` once aborted
    pub fn reason(&self) -> Option<JsError> {
        self.rt
            .0
            .st
            .borrow()
            .signals
            .get(&self.id)
            .and_then(|s| s.reason.clone())
    }

    /// `controller.abort(reason)`; aborting again is nothing
    pub fn abort(&self, reason: Option<JsError>) {
        self.rt.abort_signal(self.id, reason);
    }

    /// `signal.addEventListener('abort', listener, { once: true })`: answers
    /// the id [`Signal::off`] takes
    pub fn on_abort(&self, listener: impl FnOnce(&JsError) + 'static) -> Id {
        let id = self.rt.id();
        if let Some(s) = self.rt.0.st.borrow_mut().signals.get_mut(&self.id)
            && s.reason.is_none()
        {
            s.listeners.push((id, Box::new(listener)));
        }
        id
    }

    /// `signal.removeEventListener('abort', listener)`
    pub fn off(&self, listener: Id) {
        if let Some(s) = self.rt.0.st.borrow_mut().signals.get_mut(&self.id) {
            s.listeners.retain(|(id, _)| *id != listener);
        }
    }
}

/// A `Response`.
pub struct Response {
    rt: Rt,
    pub head: ResponseHead,
    body: Option<Id>,
    signal: Option<Signal>,
}

impl Drop for Response {
    fn drop(&mut self) {
        if let Some(body) = self.body {
            self.rt.0.dropped.borrow_mut().push(body);
        }
    }
}

impl Response {
    pub fn status(&self) -> f64 {
        self.head.status
    }

    /// `response.ok`
    pub fn ok(&self) -> bool {
        (200.0..=299.0).contains(&self.head.status)
    }

    /// `response.headers.get(name)`: the values under the name, any case,
    /// joined with `", "`
    pub fn header(&self, name: &str) -> Option<String> {
        let values: Vec<&str> = self
            .head
            .headers
            .iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
            .collect();
        if values.is_empty() {
            None
        } else {
            Some(values.join(", "))
        }
    }

    /// `response.body !== null`
    pub fn has_body(&self) -> bool {
        self.body.is_some()
    }

    /// `response.type`
    pub fn kind(&self) -> &str {
        &self.head.kind
    }

    /// `reader.read()`: the next chunk, `None` when done
    pub async fn read(&self) -> Result<Option<Vec<u8>>, JsError> {
        match self.body {
            Some(body) => self.rt.read_body(body).await,
            None => Ok(None),
        }
    }

    /// `response.body?.cancel()`, `reader.cancel()`
    pub fn cancel(&self) {
        if let Some(body) = self.body {
            self.rt.cancel_body(body);
        }
    }

    /// `response.clone()`
    pub fn clone_response(&self) -> Response {
        Response {
            rt: self.rt.clone(),
            head: self.head.clone(),
            body: self.body.map(|b| self.rt.clone_body(b)),
            signal: self.signal.clone(),
        }
    }

    /// `await response.arrayBuffer()`
    pub async fn bytes(&self) -> Result<Vec<u8>, JsError> {
        let mut out = Vec::new();
        while let Some(chunk) = self.read().await? {
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    }

    /// `await response.text()`
    pub async fn text(&self) -> Result<String, JsError> {
        let bytes = self.bytes().await?;
        Ok(jscompat::text_decoder_decode(&bytes).into_owned())
    }
}

/// A child process.
#[derive(Clone)]
pub struct Child {
    rt: Rt,
    id: Id,
    pid: Option<f64>,
}

impl Child {
    pub fn id(&self) -> Id {
        self.id
    }

    /// `child.pid`
    pub fn pid(&self) -> Option<f64> {
        self.pid
    }

    /// `child.on(...)`, `child.stdout.on(...)`, `child.stderr.on(...)`: the
    /// listener sees every event of the child, in order
    pub fn on(&self, listener: impl FnMut(&ChildEvent) + 'static) {
        if let Some(c) = self.rt.0.st.borrow_mut().children.get_mut(&self.id) {
            c.listeners.push(Rc::new(RefCell::new(listener)));
        }
    }

    /// `child.stdin.writable`
    pub fn stdin_writable(&self) -> bool {
        self.rt
            .0
            .st
            .borrow()
            .children
            .get(&self.id)
            .is_some_and(|c| c.stdin_open)
    }

    /// `child.stdin.write(data)`
    pub fn write(&self, data: &[u8]) {
        self.rt.push(Cmd::Stdin {
            child: self.id,
            data: data.to_vec(),
        });
    }

    /// `child.stdin.end()`
    pub fn end_stdin(&self) {
        let mut st = self.rt.0.st.borrow_mut();
        if let Some(c) = st.children.get_mut(&self.id) {
            c.stdin_open = false;
        }
        st.cmds.push(Cmd::EndStdin { child: self.id });
    }

    /// `child.kill(signal)`
    pub fn kill(&self, signal: Option<&str>) {
        self.rt.push(Cmd::KillChild {
            child: self.id,
            signal: signal.map(str::to_owned),
        });
    }

    /// The `'close'` event came.
    pub fn closed(&self) -> bool {
        !self.rt.0.st.borrow().children.contains_key(&self.id)
    }
}

/// An HTTP server of [`Rt::listen`].
pub struct Server {
    rt: Rt,
    id: Id,
}

impl Server {
    pub fn id(&self) -> Id {
        self.id
    }

    /// `server.close()`
    pub fn close(&self) {
        if self.rt.0.st.borrow_mut().servers.remove(&self.id).is_some() {
            self.rt.push(Cmd::CloseServer { server: self.id });
        }
    }
}

/// The `resolve` of a promise; settling twice keeps the first value.
pub struct Settle<T> {
    rt: Rt,
    cell: Rc<RefCell<Option<T>>>,
}

impl<T> Clone for Settle<T> {
    fn clone(&self) -> Self {
        Settle {
            rt: self.rt.clone(),
            cell: self.cell.clone(),
        }
    }
}

impl<T> Settle<T> {
    pub fn settle(&self, value: T) {
        let mut cell = self.cell.borrow_mut();
        if cell.is_none() {
            *cell = Some(value);
            drop(cell);
            self.rt.mark();
        }
    }

    pub fn settled(&self) -> bool {
        self.cell.borrow().is_some()
    }
}

/// The awaited side of a promise.
pub struct Wait<T> {
    cell: Rc<RefCell<Option<T>>>,
}

impl<T> Clone for Wait<T> {
    fn clone(&self) -> Self {
        Wait {
            cell: self.cell.clone(),
        }
    }
}

impl<T: Clone> Wait<T> {
    /// The value once settled.
    pub fn peek(&self) -> Option<T> {
        self.cell.borrow().clone()
    }
}

impl<T: Clone> Future for Wait<T> {
    type Output = T;

    fn poll(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<T> {
        match self.cell.borrow().as_ref() {
            Some(value) => Poll::Ready(value.clone()),
            None => Poll::Pending,
        }
    }
}

/// A future a combinator takes.
pub type LocalBoxFuture<T> = Pin<Box<dyn Future<Output = T>>>;

/// What `Promise.all` and `Promise.race` hold: each input runs as a task of
/// its own from the call on, as a JavaScript promise does, so an input the
/// combinator stops waiting for (the losers of a race, the rest after a
/// rejection) still runs to its end, cleanup included. The values land here
/// with the order the inputs settled in.
struct Settled<T> {
    values: Vec<Option<T>>,
    order: Vec<usize>,
}

impl Rt {
    fn settle_each<T: 'static>(&self, futures: Vec<LocalBoxFuture<T>>) -> Rc<RefCell<Settled<T>>> {
        let shared = Rc::new(RefCell::new(Settled {
            values: futures.iter().map(|_| None).collect(),
            order: Vec::new(),
        }));
        for (i, future) in futures.into_iter().enumerate() {
            let into = shared.clone();
            let rt = self.clone();
            self.spawn_local(async move {
                let value = future.await;
                {
                    let mut into = into.borrow_mut();
                    into.values[i] = Some(value);
                    into.order.push(i);
                }
                // the combinator awaiting it may have been polled already
                rt.mark();
            });
        }
        shared
    }

    /// `Promise.all(futures)` of futures that do not fail.
    pub async fn join_all<T: 'static>(&self, futures: Vec<LocalBoxFuture<T>>) -> Vec<T> {
        let settled = self.settle_each(futures);
        std::future::poll_fn(move |_| {
            let mut s = settled.borrow_mut();
            if s.order.len() < s.values.len() {
                return Poll::Pending;
            }
            Poll::Ready(s.values.iter_mut().filter_map(Option::take).collect())
        })
        .await
    }

    /// `Promise.all(futures)`: the first failure, in the order the inputs
    /// settled, rejects it; the others run on unread.
    pub async fn try_join_all<T: 'static, E: 'static>(
        &self,
        futures: Vec<LocalBoxFuture<Result<T, E>>>,
    ) -> Result<Vec<T>, E> {
        let settled = self.settle_each(futures);
        let mut seen = 0;
        std::future::poll_fn(move |_| {
            let mut s = settled.borrow_mut();
            while seen < s.order.len() {
                let i = s.order[seen];
                seen += 1;
                if matches!(s.values[i], Some(Err(_)))
                    && let Some(Err(e)) = s.values[i].take()
                {
                    return Poll::Ready(Err(e));
                }
            }
            if seen < s.values.len() {
                return Poll::Pending;
            }
            Poll::Ready(Ok(s
                .values
                .iter_mut()
                .filter_map(|v| match v.take() {
                    Some(Ok(v)) => Some(v),
                    _ => None,
                })
                .collect()))
        })
        .await
    }

    /// `Promise.race(futures)`: the first to settle, by its index; the
    /// others run on.
    pub async fn race<T: 'static>(&self, futures: Vec<LocalBoxFuture<T>>) -> (usize, T) {
        let settled = self.settle_each(futures);
        std::future::poll_fn(move |_| {
            let mut s = settled.borrow_mut();
            match s.order.first().copied() {
                Some(i) => match s.values[i].take() {
                    Some(v) => Poll::Ready((i, v)),
                    None => Poll::Pending,
                },
                None => Poll::Pending,
            }
        })
        .await
    }
}

/// `new StringDecoder('utf8')` of `node:string_decoder`: UTF-8 across
/// chunks, a sequence cut between chunks finished by the next one, each
/// ill-formed sequence U+FFFD. Unlike `TextDecoder` it keeps a byte order
/// mark at the start.
pub struct StringDecoder {
    decoder: encoding_rs::Decoder,
}

impl Default for StringDecoder {
    fn default() -> Self {
        StringDecoder::new()
    }
}

impl StringDecoder {
    pub fn new() -> StringDecoder {
        StringDecoder {
            decoder: encoding_rs::UTF_8.new_decoder_without_bom_handling(),
        }
    }

    /// `decoder.write(chunk)`
    pub fn write(&mut self, bytes: &[u8]) -> String {
        self.decode(bytes, false)
    }

    /// `decoder.end()`: what was held back, as U+FFFD
    pub fn end(&mut self) -> String {
        self.decode(&[], true)
    }

    fn decode(&mut self, bytes: &[u8], last: bool) -> String {
        let mut out = String::with_capacity(bytes.len() + 8);
        let mut input = bytes;
        loop {
            let (result, read, _) = self.decoder.decode_to_string(input, &mut out, last);
            input = &input[read..];
            match result {
                encoding_rs::CoderResult::InputEmpty => break,
                encoding_rs::CoderResult::OutputFull => out.reserve(input.len() * 3 + 16),
            }
        }
        out
    }
}

/// The result of a started task.
pub struct Call<T> {
    cell: Rc<RefCell<Option<T>>>,
}

impl<T> Call<T> {
    /// The function returned.
    pub fn is_done(&self) -> bool {
        self.cell.borrow().is_some()
    }

    /// What it returned, once.
    pub fn take(&self) -> Option<T> {
        self.cell.borrow_mut().take()
    }
}

/// The loop the caller owns.
pub struct Runtime {
    rt: Rt,
    tasks: Vec<LocalFuture>,
}

impl Runtime {
    pub fn new(host: HostInfo) -> Runtime {
        Runtime {
            rt: Rt(Rc::new(Inner {
                host: RefCell::new(host),
                st: RefCell::new(State::default()),
                dirty: Cell::new(false),
                dropped: RefCell::new(Vec::new()),
            })),
            tasks: Vec::new(),
        }
    }

    /// The handle the ported functions take.
    pub fn rt(&self) -> &Rt {
        &self.rt
    }

    /// Run `future` as a task: it goes as far as it can at the next
    /// [`Runtime::poll`].
    pub fn start<T: 'static>(&mut self, future: impl Future<Output = T> + 'static) -> Call<T> {
        let cell = Rc::new(RefCell::new(None));
        let out = cell.clone();
        self.tasks.push(Box::pin(async move {
            let value = future.await;
            *out.borrow_mut() = Some(value);
        }));
        Call { cell }
    }

    /// No task is running.
    pub fn idle(&self) -> bool {
        self.tasks.is_empty() && self.rt.0.st.borrow().spawned.is_empty()
    }

    /// Run every task as far as it goes; the commands they queued.
    pub fn poll(&mut self) -> Vec<Cmd> {
        let mut cx = Context::from_waker(Waker::noop());
        loop {
            let spawned = std::mem::take(&mut self.rt.0.st.borrow_mut().spawned);
            self.tasks.extend(spawned);
            self.rt.0.dirty.set(false);
            let mut i = 0;
            let mut finished = false;
            while i < self.tasks.len() {
                if self.tasks[i].as_mut().poll(&mut cx).is_ready() {
                    drop(self.tasks.remove(i));
                    // a task that ended may have settled what another awaits
                    finished = true;
                } else {
                    i += 1;
                }
            }
            let delivered = self.rt.deliver_queued();
            let more = !self.rt.0.st.borrow().spawned.is_empty();
            if !self.rt.0.dirty.get() && !delivered && !more && !finished {
                break;
            }
        }
        self.rt.release_dropped();
        std::mem::take(&mut self.rt.0.st.borrow_mut().cmds)
    }

    /// Hand back the outcome of a command, or an event of a child or server.
    pub fn feed(&mut self, event: Event) {
        let rt = self.rt.clone();
        match event {
            Event::Done { id, answer } => rt.settle(id, Ok(answer)),
            Event::Failed { id, error } => rt.settle(id, Err(error)),
            Event::Timer { id } => {
                let timer = rt.0.st.borrow_mut().timers.remove(&id);
                match timer {
                    Some(Timer::Callback(callback)) => {
                        callback();
                        rt.mark();
                    }
                    Some(Timer::Sleep(op)) => rt.settle(op, Ok(Answer::Unit)),
                    None => {}
                }
            }
            Event::Child { child, event } => rt.deliver(child, event),
            Event::Request { server, request } => {
                let handler = rt.0.st.borrow().servers.get(&server).cloned();
                if let Some(handler) = handler {
                    (*handler.borrow_mut())(request);
                    rt.mark();
                }
            }
        }
    }
}

/// The listeners, timers and handlers the runtime keeps capture [`Rt`]
/// clones (a composite signal's listener holds its target, a watchdog's
/// timer its signal), so the state refers to itself. Dropping the runtime
/// drops all of it: the tasks first, then what they left registered, taken
/// out of the state before it is dropped so that no destructor finds the
/// state borrowed.
impl Drop for Runtime {
    fn drop(&mut self) {
        self.tasks.clear();
        let state = std::mem::take(&mut *self.rt.0.st.borrow_mut());
        drop(state);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host() -> HostInfo {
        HostInfo {
            platform: "linux".into(),
            pid: 1.0,
            tmpdir: "/tmp".into(),
            homedir: "/home".into(),
            env: Vec::new(),
            clock: Box::new(|| 0.0),
            uuid: Box::new(String::new),
            random: Box::new(|n| vec![0; n]),
            kill: Box::new(|_, _| Ok(())),
        }
    }

    #[test]
    fn a_dropped_runtime_releases_its_state_with_timers_and_signals_left() {
        let mut runtime = Runtime::new(host());
        let rt = runtime.rt().clone();
        let weak = Rc::downgrade(&rt.0);
        let parent = rt.controller();
        let timeout = rt.timeout_signal(1000.0);
        let both = rt.any_signal(&[&parent, &timeout]);
        let held = both.clone();
        let call = runtime.start(async move {
            let target = held.clone();
            held.on_abort(move |_| target.abort(None));
            std::future::pending::<()>().await;
        });
        assert!(!runtime.poll().is_empty());
        drop((rt, parent, timeout, both, call));
        drop(runtime);
        assert!(weak.upgrade().is_none());
    }

    fn head() -> ResponseHead {
        ResponseHead {
            status: 200.0,
            status_text: String::new(),
            headers: Vec::new(),
            url: String::new(),
            redirected: false,
            kind: "basic".into(),
            has_body: true,
        }
    }

    /// The id of the only `Cmd::Read` in `cmds`.
    fn read_of(cmds: &[Cmd]) -> Id {
        let reads: Vec<Id> = cmds
            .iter()
            .filter_map(|c| match c {
                Cmd::Read { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(reads.len(), 1, "{cmds:?}");
        reads[0]
    }

    #[test]
    fn cancelling_a_body_ends_the_read_waiting_on_it() {
        let mut runtime = Runtime::new(host());
        let rt = runtime.rt().clone();
        let held: Rc<RefCell<Option<Rc<Response>>>> = Rc::default();
        let slot = held.clone();
        let call = runtime.start(async move {
            let response = Rc::new(
                rt.fetch(
                    Fetcher::Node,
                    "https://x.example/",
                    Request::default(),
                    None,
                )
                .await
                .unwrap(),
            );
            *slot.borrow_mut() = Some(response.clone());
            let first = response.read().await;
            let second = response.read().await;
            (first, second)
        });
        let cmds = runtime.poll();
        let Some(Cmd::Fetch { id: fetch, .. }) = cmds.first().cloned() else {
            panic!("{cmds:?}");
        };
        runtime.feed(Event::Done {
            id: fetch,
            answer: Answer::Response(head()),
        });
        let read = read_of(&runtime.poll());
        runtime.feed(Event::Done {
            id: read,
            answer: Answer::Chunk(b"one".to_vec()),
        });
        read_of(&runtime.poll());
        // the stream stalls; `reader.cancel()` while the second read waits
        held.borrow().as_ref().unwrap().cancel();
        let cmds = runtime.poll();
        assert_eq!(cmds, vec![Cmd::Cancel { id: fetch }]);
        let (first, second) = call.take().expect("the second read ended");
        assert_eq!(first.unwrap(), Some(b"one".to_vec()));
        assert_eq!(second.unwrap(), None);
    }

    #[test]
    fn cancelling_a_body_ends_every_read_waiting_on_it() {
        let mut runtime = Runtime::new(host());
        let rt = runtime.rt().clone();
        let fetched = runtime.start(async move {
            Rc::new(
                rt.fetch(
                    Fetcher::Node,
                    "https://x.example/",
                    Request::default(),
                    None,
                )
                .await
                .unwrap(),
            )
        });
        let cmds = runtime.poll();
        let Some(Cmd::Fetch { id: fetch, .. }) = cmds.first().cloned() else {
            panic!("{cmds:?}");
        };
        runtime.feed(Event::Done {
            id: fetch,
            answer: Answer::Response(head()),
        });
        assert!(runtime.poll().is_empty());
        let response = fetched.take().expect("the fetch answered");
        // three `read()` calls in flight at once, as a reader allows
        let reads: Vec<_> = (0..3)
            .map(|_| {
                let response = response.clone();
                runtime.start(async move { response.read().await })
            })
            .collect();
        let ids: Vec<Id> = runtime
            .poll()
            .iter()
            .filter_map(|c| match c {
                Cmd::Read { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(ids.len(), 3);
        // the first is answered; the two others still wait
        runtime.feed(Event::Done {
            id: ids[0],
            answer: Answer::Chunk(b"one".to_vec()),
        });
        assert!(runtime.poll().is_empty());
        assert_eq!(reads[0].take().unwrap().unwrap(), Some(b"one".to_vec()));
        response.cancel();
        assert_eq!(runtime.poll(), vec![Cmd::Cancel { id: fetch }]);
        for read in &reads[1..] {
            assert_eq!(read.take().expect("the read ended").unwrap(), None);
        }
    }

    #[test]
    fn a_branch_cancelled_mid_read_leaves_its_clone_to_cancel_the_stream() {
        let mut runtime = Runtime::new(host());
        let rt = runtime.rt().clone();
        let held: Rc<RefCell<Option<(Rc<Response>, Rc<Response>)>>> = Rc::default();
        let slot = held.clone();
        let call = runtime.start(async move {
            let response = rt
                .fetch(
                    Fetcher::Node,
                    "https://x.example/",
                    Request::default(),
                    None,
                )
                .await
                .unwrap();
            let copy = Rc::new(response.clone_response());
            let response = Rc::new(response);
            *slot.borrow_mut() = Some((response.clone(), copy));
            response.read().await
        });
        let cmds = runtime.poll();
        let Some(Cmd::Fetch { id: fetch, .. }) = cmds.first().cloned() else {
            panic!("{cmds:?}");
        };
        runtime.feed(Event::Done {
            id: fetch,
            answer: Answer::Response(head()),
        });
        read_of(&runtime.poll());
        let (response, copy) = held.borrow().clone().unwrap();
        response.cancel();
        // the clone still reads the stream: it is not cancelled yet
        assert!(runtime.poll().is_empty());
        assert_eq!(call.take().expect("the read ended").unwrap(), None);
        copy.cancel();
        assert_eq!(runtime.poll(), vec![Cmd::Cancel { id: fetch }]);
    }

    /// A fetched response, its headers answered; the fetch id.
    fn fetched(runtime: &mut Runtime) -> (Response, Id) {
        let rt = runtime.rt().clone();
        let call = runtime.start(async move {
            rt.fetch(
                Fetcher::Node,
                "https://x.example/",
                Request::default(),
                None,
            )
            .await
            .unwrap()
        });
        let cmds = runtime.poll();
        let Some(Cmd::Fetch { id: fetch, .. }) = cmds.first().cloned() else {
            panic!("{cmds:?}");
        };
        runtime.feed(Event::Done {
            id: fetch,
            answer: Answer::Response(head()),
        });
        assert!(runtime.poll().is_empty());
        (call.take().expect("the fetch answered"), fetch)
    }

    #[test]
    fn a_response_dropped_unread_lets_the_host_stop_its_stream() {
        let mut runtime = Runtime::new(host());
        let (response, fetch) = fetched(&mut runtime);
        drop(response);
        assert_eq!(
            runtime.poll(),
            vec![Cmd::Release {
                body: fetch,
                stop: Some(fetch)
            }]
        );
    }

    #[test]
    fn a_clone_dropped_unread_is_freed_while_the_other_branch_reads_on() {
        let mut runtime = Runtime::new(host());
        let (response, fetch) = fetched(&mut runtime);
        let copy = response.clone_response();
        let cmds = runtime.poll();
        let Some(Cmd::CloneBody { to, .. }) = cmds.first().cloned() else {
            panic!("{cmds:?}");
        };
        drop(copy);
        assert_eq!(
            runtime.poll(),
            vec![Cmd::Release {
                body: to,
                stop: None
            }]
        );
        // the last branch goes too: now the stream stops
        drop(response);
        assert_eq!(
            runtime.poll(),
            vec![Cmd::Release {
                body: fetch,
                stop: Some(fetch)
            }]
        );
    }

    #[test]
    fn a_response_read_to_its_end_or_cancelled_is_not_released_again() {
        let mut runtime = Runtime::new(host());
        let (response, fetch) = fetched(&mut runtime);
        response.cancel();
        assert_eq!(runtime.poll(), vec![Cmd::Cancel { id: fetch }]);
        drop(response);
        assert!(runtime.poll().is_empty());

        let (response, _) = fetched(&mut runtime);
        let response = Rc::new(response);
        let reader = response.clone();
        let read = runtime.start(async move { reader.read().await });
        let id = read_of(&runtime.poll());
        runtime.feed(Event::Done {
            id,
            answer: Answer::End,
        });
        assert!(runtime.poll().is_empty());
        assert_eq!(read.take().unwrap().unwrap(), None);
        drop(response);
        assert!(runtime.poll().is_empty());
    }

    #[test]
    fn a_drop_does_not_change_what_an_abort_sends_later() {
        let mut runtime = Runtime::new(host());
        let rt = runtime.rt().clone();
        let signal = rt.controller();
        let given = signal.clone();
        let call = runtime.start(async move {
            rt.fetch(
                Fetcher::Node,
                "https://x.example/",
                Request::default(),
                Some(&given),
            )
            .await
            .unwrap()
        });
        let cmds = runtime.poll();
        let Some(Cmd::Fetch { id: fetch, .. }) = cmds.first().cloned() else {
            panic!("{cmds:?}");
        };
        runtime.feed(Event::Done {
            id: fetch,
            answer: Answer::Response(head()),
        });
        assert!(runtime.poll().is_empty());
        drop(call.take().expect("the fetch answered"));
        assert_eq!(
            runtime.poll(),
            vec![Cmd::Release {
                body: fetch,
                stop: Some(fetch)
            }]
        );
        // JavaScript's body is still there to error: the abort cancels it, as before
        signal.abort(None);
        assert_eq!(runtime.poll(), vec![Cmd::Cancel { id: fetch }]);
    }

    #[test]
    fn a_response_held_by_a_cleared_timer_is_released() {
        let mut runtime = Runtime::new(host());
        let (response, fetch) = fetched(&mut runtime);
        let rt = runtime.rt().clone();
        // the timer's callback owns the last handle; clearing it drops the callback
        let timer = rt.set_timeout(1000.0, move || drop(response));
        let set = runtime.poll();
        assert_eq!(
            set,
            vec![Cmd::SetTimer {
                id: timer,
                ms: 1000.0
            }]
        );
        rt.clear_timeout(Some(timer));
        assert_eq!(
            runtime.poll(),
            vec![
                Cmd::ClearTimer { id: timer },
                Cmd::Release {
                    body: fetch,
                    stop: Some(fetch)
                }
            ]
        );
    }

    #[test]
    fn cancelling_the_last_held_branch_after_a_drop_stops_the_stream() {
        let mut runtime = Runtime::new(host());
        let (response, fetch) = fetched(&mut runtime);
        let copy = response.clone_response();
        let cmds = runtime.poll();
        let Some(Cmd::CloneBody { to, .. }) = cmds.first().cloned() else {
            panic!("{cmds:?}");
        };
        drop(response);
        assert_eq!(
            runtime.poll(),
            vec![Cmd::Release {
                body: fetch,
                stop: None
            }]
        );
        // the clone, still held, is cancelled: no branch can read the stream any more.
        // JavaScript's dropped branch is only garbage, so no `Cancel`: the host is told
        // by a release that stops the stream
        copy.cancel();
        assert_eq!(
            runtime.poll(),
            vec![Cmd::Release {
                body: to,
                stop: Some(fetch)
            }]
        );
        drop(copy);
        assert!(runtime.poll().is_empty());
    }

    /// Two `read()` calls in flight on one fetched response: the response,
    /// the two calls, the ids of their `Cmd::Read`s.
    fn two_reads(
        runtime: &mut Runtime,
    ) -> (
        Rc<Response>,
        Vec<Call<Result<Option<Vec<u8>>, JsError>>>,
        Vec<Id>,
    ) {
        let (response, _) = fetched(runtime);
        let response = Rc::new(response);
        let reads: Vec<_> = (0..2)
            .map(|_| {
                let response = response.clone();
                runtime.start(async move { response.read().await })
            })
            .collect();
        let ids: Vec<Id> = runtime
            .poll()
            .iter()
            .filter_map(|c| match c {
                Cmd::Read { id, .. } => Some(*id),
                _ => None,
            })
            .collect();
        assert_eq!(ids.len(), 2);
        (response, reads, ids)
    }

    #[test]
    fn the_end_of_a_stream_ends_every_read_waiting_on_it() {
        let mut runtime = Runtime::new(host());
        let (_response, reads, ids) = two_reads(&mut runtime);
        // the host answers the first read only: the stream closed
        runtime.feed(Event::Done {
            id: ids[0],
            answer: Answer::End,
        });
        assert!(runtime.poll().is_empty());
        for read in &reads {
            assert_eq!(read.take().expect("the read ended").unwrap(), None);
        }
    }

    #[test]
    fn a_failed_stream_fails_every_read_waiting_on_it_and_every_later_one() {
        let mut runtime = Runtime::new(host());
        let (response, reads, ids) = two_reads(&mut runtime);
        runtime.feed(Event::Failed {
            id: ids[0],
            error: JsError::type_error("terminated"),
        });
        assert!(runtime.poll().is_empty());
        for read in &reads {
            let error = read.take().expect("the read ended").unwrap_err();
            assert_eq!(error.message, "terminated");
        }
        // a read after the failure asks the host nothing and fails the same way
        let later = runtime.start(async move { response.read().await });
        assert!(runtime.poll().is_empty());
        let error = later.take().expect("the read ended").unwrap_err();
        assert_eq!(error.message, "terminated");
    }

    /// A response fetched with a signal: the response, the fetch id, the
    /// signal.
    fn fetched_with_signal(runtime: &mut Runtime) -> (Rc<Response>, Id, Signal) {
        let rt = runtime.rt().clone();
        let signal = rt.controller();
        let given = signal.clone();
        let call = runtime.start(async move {
            rt.fetch(
                Fetcher::Node,
                "https://x.example/",
                Request::default(),
                Some(&given),
            )
            .await
            .unwrap()
        });
        let cmds = runtime.poll();
        let Some(Cmd::Fetch { id: fetch, .. }) = cmds.first().cloned() else {
            panic!("{cmds:?}");
        };
        runtime.feed(Event::Done {
            id: fetch,
            answer: Answer::Response(head()),
        });
        assert!(runtime.poll().is_empty());
        (
            Rc::new(call.take().expect("the fetch answered")),
            fetch,
            signal,
        )
    }

    /// One `read()` of `response`, answered `answer` by the host.
    fn read_answered(
        runtime: &mut Runtime,
        response: &Rc<Response>,
        answer: Result<Answer, JsError>,
    ) -> Result<Option<Vec<u8>>, JsError> {
        let reader = response.clone();
        let read = runtime.start(async move { reader.read().await });
        let id = read_of(&runtime.poll());
        runtime.feed(match answer {
            Ok(answer) => Event::Done { id, answer },
            Err(error) => Event::Failed { id, error },
        });
        assert!(runtime.poll().is_empty());
        read.take().expect("the read ended")
    }

    /// A `read()` of `response` the runtime answers without the host.
    fn read_now(
        runtime: &mut Runtime,
        response: &Rc<Response>,
    ) -> Result<Option<Vec<u8>>, JsError> {
        let reader = response.clone();
        let read = runtime.start(async move { reader.read().await });
        assert!(runtime.poll().is_empty());
        read.take().expect("the read ended")
    }

    #[test]
    fn a_later_abort_does_not_change_how_a_stream_ended() {
        let mut runtime = Runtime::new(host());
        // failed, then aborted: reads keep the stream's failure
        let (response, _, signal) = fetched_with_signal(&mut runtime);
        let failed = read_answered(
            &mut runtime,
            &response,
            Err(JsError::type_error("terminated")),
        );
        assert_eq!(failed.unwrap_err().message, "terminated");
        signal.abort(None);
        assert!(runtime.poll().is_empty());
        assert_eq!(
            read_now(&mut runtime, &response).unwrap_err().message,
            "terminated"
        );

        // closed, then aborted: reads stay done
        let (response, _, signal) = fetched_with_signal(&mut runtime);
        assert_eq!(
            read_answered(&mut runtime, &response, Ok(Answer::End)).unwrap(),
            None
        );
        signal.abort(None);
        assert!(runtime.poll().is_empty());
        assert_eq!(read_now(&mut runtime, &response).unwrap(), None);

        // cancelled, then aborted: reads stay done
        let (response, fetch, signal) = fetched_with_signal(&mut runtime);
        response.cancel();
        assert_eq!(runtime.poll(), vec![Cmd::Cancel { id: fetch }]);
        signal.abort(None);
        assert!(runtime.poll().is_empty());
        assert_eq!(read_now(&mut runtime, &response).unwrap(), None);

        // aborted while open: the abort errors the stream
        let (response, fetch, signal) = fetched_with_signal(&mut runtime);
        signal.abort(None);
        assert_eq!(runtime.poll(), vec![Cmd::Cancel { id: fetch }]);
        assert_eq!(
            read_now(&mut runtime, &response).unwrap_err().name,
            "AbortError"
        );
    }
}
