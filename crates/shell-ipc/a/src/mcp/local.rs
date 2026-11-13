//! A "my PC" MCP server's connection (`local.ts`) on a thread of its own.
//!
//! [`LocalProxy`] is what the hub on the core thread holds. The actor drives
//! main-core's [`LocalMcpAdapter`] over [`LocalWorld`]: the child process of
//! `std::process` (a reader thread per pipe, a writer thread for standard
//! input, a waiter for the exit), timers on the actor's [`TimerQueue`], the
//! runtime kit (which may download a runtime, so it blocks, which is why this
//! is not on the core thread). Everything the connection reports is posted to
//! the core thread in one piece after each step: the hub is never entered
//! from inside the connection.
//!
//! `status()` and `stderrTail()` are read by the hub on the core thread; the
//! actor publishes both after every step it takes, so the hub sees them as of
//! the last step that finished.

use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};

use jscompat::JsonValue;
use main_core::packages::ai_provider::subscription_process::{
    KillHost, KillerSpawn, Signal, on_kill_timeout,
};
use main_core::packages::i18n::PRODUCT_NAME;
use main_core::packages::mcp_sdk::client::OutputCheck;
use main_core::shell::mcp_client::hub::{ConnId, ConnOutcome, LocalConnection, LocalState, OpId};
use main_core::shell::mcp_client::local::{
    CallFailure, CallId, CallKind, CallOutcome, ChildId, LocalMcpAdapter, LocalMcpHost,
    LocalMcpOptions, LocalMcpState, SpawnRequest, conn_outcome,
};
use main_core::shell::mcp_client::local_launch::McpRuntimeKit;
use main_core::shell::mcp_client::runtimes::{McpRuntimeKitOptions, RuntimeKit, mcp_runtimes_root};
use main_core::shell::mcp_client::store::McpServerConfig;

use super::actor::{CoreLink, Step, TimerQueue, run_loop};
use super::kit::KitHost;
use super::net::McpNetHost;

/// Under the app's temp folder: the empty working folders of "my PC" servers (5.3)
pub const LOCAL_WORK_DIR_NAME: &str = "seuoffice-mcp";

pub enum Msg {
    Ensure(OpId),
    List(OpId),
    Call(OpId, String, JsonValue),
    Stop(OpId),
    Retry,
    SetServer(Box<McpServerConfig>),
    Abort(OpId),
    AbortApp,
    Stdout(ChildId, Vec<u8>),
    Stderr(ChildId, Vec<u8>),
    StdoutEnd(ChildId),
    StderrEnd(ChildId),
    Exited(ChildId),
    StdinError(ChildId),
    /// `error` of a child that could not be started, then its `close`
    ChildError(ChildId),
    ChildClose(ChildId),
    Shutdown,
}

#[derive(Clone)]
struct Snapshot {
    state: LocalState,
    stderr: Vec<String>,
}

#[derive(Clone)]
pub struct LocalWorldDeps {
    pub net: McpNetHost,
    pub link: CoreLink,
    /// `app.getPath('temp')`
    pub temp_dir: String,
    /// `app.getPath('userData')`
    pub user_data_dir: String,
    pub client_version: String,
}

/// The hub's view of a local connection
pub struct LocalProxy {
    tx: Sender<Msg>,
    snapshot: Arc<Mutex<Snapshot>>,
}

impl LocalProxy {
    pub fn spawn(conn: ConnId, server: &McpServerConfig, deps: LocalWorldDeps) -> LocalProxy {
        let (tx, rx) = channel();
        let snapshot = Arc::new(Mutex::new(Snapshot {
            state: LocalState::Idle,
            stderr: Vec::new(),
        }));
        let actor = Actor {
            conn,
            server: server.clone(),
            deps,
            tx: tx.clone(),
            snapshot: snapshot.clone(),
        };
        let started = std::thread::Builder::new()
            .name("mcp-local".to_owned())
            .spawn(move || actor.run(rx));
        if let Err(error) = started {
            eprintln!("mcp: no thread for a local connection: {error}");
        }
        LocalProxy { tx, snapshot }
    }

    /// A handle that can tell the connection to try again, for the download
    /// that finishes after the hub asked for it
    pub fn retrier(&self) -> Sender<Msg> {
        self.tx.clone()
    }

    fn send(&self, msg: Msg) {
        let _ = self.tx.send(msg);
    }
}

impl Drop for LocalProxy {
    fn drop(&mut self) {
        let _ = self.tx.send(Msg::Shutdown);
    }
}

impl LocalConnection for LocalProxy {
    fn status(&self) -> LocalState {
        lock(&self.snapshot).state.clone()
    }

    fn stderr_tail(&self) -> Vec<String> {
        lock(&self.snapshot).stderr.clone()
    }

    fn ensure(&mut self, op: OpId) {
        self.send(Msg::Ensure(op));
    }

    fn list_tools(&mut self, op: OpId) {
        self.send(Msg::List(op));
    }

    fn call_tool(&mut self, op: OpId, name: &str, args: &JsonValue) {
        self.send(Msg::Call(op, name.to_owned(), args.clone()));
    }

    fn stop(&mut self, op: OpId) {
        self.send(Msg::Stop(op));
    }

    fn retry(&mut self) {
        self.send(Msg::Retry);
    }

    fn set_server(&mut self, server: &McpServerConfig) {
        self.send(Msg::SetServer(Box::new(server.clone())));
    }

    fn abort(&mut self, op: OpId) {
        self.send(Msg::Abort(op));
    }

    fn abort_app(&mut self) {
        self.send(Msg::AbortApp);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Actor {
    conn: ConnId,
    server: McpServerConfig,
    deps: LocalWorldDeps,
    tx: Sender<Msg>,
    snapshot: Arc<Mutex<Snapshot>>,
}

/// What the connection reported since the last time it was read
#[derive(Default)]
struct Outbox {
    settled: Vec<(OpId, ConnOutcome)>,
    states: Vec<LocalState>,
    tools_changed: bool,
    /// events of the world that happen right after the step that caused them
    events: VecDeque<Msg>,
}

/// where each child stands: `close` comes after `exit` and the end of both pipes
#[derive(Default)]
struct Life {
    exited: bool,
    stdout_end: bool,
    stderr_end: bool,
    closed: bool,
}

impl Actor {
    fn run(self, rx: Receiver<Msg>) {
        let timers = Rc::new(RefCell::new(TimerQueue::default()));
        let kill_timers: Rc<RefCell<HashMap<u64, f64>>> = Rc::default();
        let outbox: Rc<RefCell<Outbox>> = Rc::default();
        let kit_host = KitHost::worker(self.deps.net.clone(), self.deps.link.clone());
        let kit = RuntimeKit::new(
            McpRuntimeKitOptions {
                runtimes_root: mcp_runtimes_root(&self.deps.user_data_dir),
                ..Default::default()
            },
            &kit_host,
        );
        let world = Rc::new(RefCell::new(LocalWorld {
            kit: &kit,
            net: self.deps.net.clone(),
            temp_dir: self.deps.temp_dir.clone(),
            tx: self.tx.clone(),
            timers: timers.clone(),
            outbox: outbox.clone(),
            children: HashMap::new(),
            killer: Killer {
                timers: timers.clone(),
                kill_timers: kill_timers.clone(),
            },
        }));
        let options = LocalMcpOptions {
            client_name: PRODUCT_NAME.to_owned(),
            client_version: self.deps.client_version.clone(),
            work_root: Some(join_path(&self.deps.temp_dir, LOCAL_WORK_DIR_NAME)),
            ..Default::default()
        };
        let adapter = RefCell::new(LocalMcpAdapter::new(
            self.conn,
            self.server.clone(),
            options,
            world.clone(),
        ));
        let lives: RefCell<HashMap<ChildId, Life>> = RefCell::default();
        let mut killer = Killer {
            timers: timers.clone(),
            kill_timers: kill_timers.clone(),
        };
        let report = |adapter: &mut LocalMcpAdapter<'_>| {
            {
                let mut snapshot = lock(&self.snapshot);
                snapshot.state = adapter.status();
                snapshot.stderr = adapter.stderr_tail();
            }
            let mut out = outbox.borrow_mut();
            let settled = std::mem::take(&mut out.settled);
            let states = std::mem::take(&mut out.states);
            let tools_changed = std::mem::take(&mut out.tools_changed);
            drop(out);
            if settled.is_empty() && states.is_empty() && !tools_changed {
                return;
            }
            let conn = self.conn;
            self.deps
                .link
                .post(move |hub| hub.local_reported(conn, settled, states, tools_changed));
        };
        // delivers one event of the world to the connection
        let handle = |adapter: &mut LocalMcpAdapter<'_>, msg: Msg| -> Step {
            match msg {
                Msg::Ensure(op) => adapter.ensure(op),
                Msg::List(op) => adapter.list_tools(op),
                Msg::Call(op, name, args) => adapter.call_tool(op, &name, &args),
                Msg::Stop(op) => adapter.stop(op),
                Msg::Retry => adapter.retry(),
                Msg::SetServer(server) => adapter.set_server(&server),
                Msg::Abort(op) => adapter.abort(op),
                Msg::AbortApp => adapter.abort_app(),
                Msg::Stdout(child, chunk) => adapter.on_stdout(child, &chunk),
                Msg::Stderr(child, chunk) => adapter.on_stderr(child, &chunk),
                Msg::StdinError(child) => adapter.on_stdin_error(child),
                Msg::ChildError(child) => adapter.on_child_error(child),
                Msg::Exited(child) => {
                    adapter.on_child_exit(child);
                    lives.borrow_mut().entry(child).or_default().exited = true;
                    close_if_over(adapter, &lives, child);
                }
                Msg::StdoutEnd(child) => {
                    lives.borrow_mut().entry(child).or_default().stdout_end = true;
                    close_if_over(adapter, &lives, child);
                }
                Msg::StderrEnd(child) => {
                    lives.borrow_mut().entry(child).or_default().stderr_end = true;
                    close_if_over(adapter, &lives, child);
                }
                Msg::ChildClose(child) => {
                    lives.borrow_mut().entry(child).or_default().closed = true;
                    adapter.on_child_close(child);
                }
                Msg::Shutdown => return Step::Stop,
            }
            Step::Go
        };
        let drain = |adapter: &mut LocalMcpAdapter<'_>| -> Step {
            loop {
                let next = outbox.borrow_mut().events.pop_front();
                let Some(msg) = next else { return Step::Go };
                if let Step::Stop = handle(adapter, msg) {
                    return Step::Stop;
                }
            }
        };
        run_loop(
            &rx,
            &timers,
            |msg| {
                let mut adapter = adapter.borrow_mut();
                if let Step::Stop = handle(&mut adapter, msg) {
                    return Step::Stop;
                }
                let _ = drain(&mut adapter);
                report(&mut adapter);
                Step::Go
            },
            |timer| {
                let mut adapter = adapter.borrow_mut();
                let pid = kill_timers.borrow_mut().remove(&timer);
                match pid {
                    Some(pid) => on_kill_timeout(pid, &mut killer),
                    None => {
                        adapter.on_timeout(timer);
                    }
                }
                let _ = drain(&mut adapter);
                report(&mut adapter);
            },
            || {
                // a start the hub announced waits for what follows it (an abort of the
                // same call): with nothing following, it goes now. Timer 0 is none.
                let mut adapter = adapter.borrow_mut();
                adapter.on_timeout(0);
                let _ = drain(&mut adapter);
                report(&mut adapter);
            },
        );
        // the connection is gone: its program goes with it
        world.borrow_mut().kill_all();
    }
}

fn close_if_over(
    adapter: &mut LocalMcpAdapter<'_>,
    lives: &RefCell<HashMap<ChildId, Life>>,
    child: ChildId,
) {
    let over = {
        let mut lives = lives.borrow_mut();
        let life = lives.entry(child).or_default();
        let over = life.exited && life.stdout_end && life.stderr_end && !life.closed;
        if over {
            life.closed = true;
        }
        over
    };
    if over {
        adapter.on_child_close(child);
    }
}

fn join_path(dir: &str, name: &str) -> String {
    std::path::Path::new(dir)
        .join(name)
        .to_string_lossy()
        .into_owned()
}

// ---- the host of the connection ----------------------------------------------

struct Child {
    pid: Option<u32>,
    stdin: Option<Sender<Vec<u8>>>,
    stdin_dead: Arc<AtomicBool>,
}

struct Killer {
    timers: Rc<RefCell<TimerQueue>>,
    /// grace timers: timer number to the pid whose group is then killed
    kill_timers: Rc<RefCell<HashMap<u64, f64>>>,
}

impl Killer {
    fn run(command: &str, args: &[&str]) -> Result<(), String> {
        let status = Command::new(command)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("{command} failed: {status}"))
        }
    }
}

impl KillHost for Killer {
    fn process_platform(&self) -> String {
        crate::secrets::PLATFORM.to_owned()
    }

    fn env_var(&self, key: &str) -> Option<String> {
        std::env::var(key).ok()
    }

    /// `process.kill(pid, signal)`; a negative `pid` is the group
    fn kill(&mut self, pid: f64, signal: Option<Signal>) -> Result<(), String> {
        let text = format!("{}", pid as i64);
        if cfg!(windows) {
            return Killer::run("taskkill", &["/PID", text.trim_start_matches('-'), "/F"]);
        }
        let name = match signal {
            Some(Signal::Kill) => "KILL",
            Some(Signal::Term) | None => "TERM",
        };
        Killer::run("kill", &["-s", name, "--", &text])
    }

    fn spawn_killer(
        &mut self,
        _pid: f64,
        command: &str,
        args: &[String],
        options: &KillerSpawn,
    ) -> Result<u64, String> {
        let mut killer = Command::new(command);
        killer
            .args(args)
            .current_dir(&options.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        if options.windows_hide {
            use std::os::windows::process::CommandExt;
            killer.creation_flags(0x0800_0000);
        }
        let mut child = killer.spawn().map_err(|e| e.to_string())?;
        let id = u64::from(child.id());
        // reaped on a thread of its own: taskkill walks the tree and may take a while
        let _ = std::thread::Builder::new()
            .name("mcp-killer".to_owned())
            .spawn(move || {
                let _ = child.wait();
            });
        Ok(id)
    }

    fn unref_killer(&mut self, _killer: u64) -> Result<(), String> {
        Ok(())
    }

    fn set_kill_timeout(&mut self, ms: f64, pid: f64) -> u64 {
        let timer = self.timers.borrow_mut().add(ms);
        self.kill_timers.borrow_mut().insert(timer, pid);
        timer
    }

    fn unref_timer(&mut self, _timer: u64) {}
}

struct LocalWorld<'a> {
    kit: &'a RuntimeKit<'a>,
    net: McpNetHost,
    temp_dir: String,
    tx: Sender<Msg>,
    timers: Rc<RefCell<TimerQueue>>,
    outbox: Rc<RefCell<Outbox>>,
    children: HashMap<ChildId, Child>,
    killer: Killer,
}

impl LocalWorld<'_> {
    /// Ends every program this connection started (the actor is going away)
    fn kill_all(&mut self) {
        for child in self.children.values() {
            if let Some(pid) = child.pid {
                let _ = if cfg!(windows) {
                    self.killer.kill(f64::from(pid), None)
                } else {
                    self.killer.kill(-f64::from(pid), Some(Signal::Kill))
                };
            }
        }
        self.children.clear();
    }
}

fn pump<R: Read + Send + 'static>(
    mut pipe: R,
    tx: Sender<Msg>,
    child: ChildId,
    chunk: fn(ChildId, Vec<u8>) -> Msg,
    end: fn(ChildId) -> Msg,
) {
    let _ = std::thread::Builder::new()
        .name("mcp-pipe".to_owned())
        .spawn(move || {
            let mut buffer = vec![0u8; 16 * 1024];
            loop {
                match pipe.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(chunk(child, buffer[..n].to_vec())).is_err() {
                            return;
                        }
                    }
                }
            }
            let _ = tx.send(end(child));
        });
}

impl LocalMcpHost for LocalWorld<'_> {
    fn kit(&self) -> &dyn McpRuntimeKit {
        self.kit
    }

    fn take_lookup_failure(&mut self) -> bool {
        self.kit.take_lookup_failure()
    }

    fn tmp_dir(&mut self) -> String {
        self.temp_dir.clone()
    }

    fn make_work_dir(&mut self, root: &str) -> Result<String, String> {
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
        // `mkdtemp(join(root, 'ieum-mcp-'))`
        for _ in 0..16 {
            let mut bytes = [0u8; 4];
            getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
            let suffix: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let path = join_path(root, &format!("ieum-mcp-{suffix}"));
            match std::fs::create_dir(&path) {
                Ok(()) => return Ok(path),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("no unused folder name".to_owned())
    }

    fn remove_work_dir(&mut self, path: &str) {
        let _ = std::fs::remove_dir_all(path);
    }

    fn spawn(&mut self, child: ChildId, request: &SpawnRequest<'_>) -> Result<(), String> {
        let mut command = Command::new(request.command);
        command
            .args(request.args)
            .current_dir(request.cwd)
            .env_clear()
            .envs(request.env.entries())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(unix)]
        if request.detached {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        if request.windows_hide {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut process = match command.spawn() {
            Ok(process) => process,
            Err(_) => {
                // Node reports a program that cannot start as an `error` of the
                // child, then `close`, not as a throw
                self.children.insert(
                    child,
                    Child {
                        pid: None,
                        stdin: None,
                        stdin_dead: Arc::new(AtomicBool::new(true)),
                    },
                );
                let mut outbox = self.outbox.borrow_mut();
                outbox.events.push_back(Msg::ChildError(child));
                outbox.events.push_back(Msg::ChildClose(child));
                return Ok(());
            }
        };
        let pid = process.id();
        if let Some(stdout) = process.stdout.take() {
            pump(stdout, self.tx.clone(), child, Msg::Stdout, Msg::StdoutEnd);
        }
        if let Some(stderr) = process.stderr.take() {
            pump(stderr, self.tx.clone(), child, Msg::Stderr, Msg::StderrEnd);
        }
        let dead = Arc::new(AtomicBool::new(false));
        let stdin = process.stdin.take().map(|mut pipe| {
            let (tx, rx) = channel::<Vec<u8>>();
            let events = self.tx.clone();
            let flag = dead.clone();
            let _ = std::thread::Builder::new()
                .name("mcp-stdin".to_owned())
                .spawn(move || {
                    while let Ok(data) = rx.recv() {
                        if pipe.write_all(&data).and_then(|()| pipe.flush()).is_err() {
                            flag.store(true, Ordering::SeqCst);
                            let _ = events.send(Msg::StdinError(child));
                            return;
                        }
                    }
                });
            tx
        });
        let events = self.tx.clone();
        let _ = std::thread::Builder::new()
            .name("mcp-wait".to_owned())
            .spawn(move || {
                let _ = process.wait();
                let _ = events.send(Msg::Exited(child));
            });
        self.children.insert(
            child,
            Child {
                pid: Some(pid),
                stdin,
                stdin_dead: dead,
            },
        );
        Ok(())
    }

    fn child_pid(&mut self, child: ChildId) -> Option<f64> {
        self.children.get(&child).and_then(|c| c.pid).map(f64::from)
    }

    fn track_child(&mut self, _child: ChildId, _command: &str) {
        // `startMcpHub` gives the connection no registry, so nothing is tracked
    }

    fn write_stdin(&mut self, child: ChildId, data: &str) {
        if let Some(tx) = self.children.get(&child).and_then(|c| c.stdin.as_ref()) {
            let _ = tx.send(data.as_bytes().to_vec());
        }
    }

    fn stdin_destroyed(&mut self, child: ChildId) -> bool {
        self.children
            .get(&child)
            .is_none_or(|c| c.stdin_dead.load(Ordering::SeqCst))
    }

    fn kill_host(&mut self) -> &mut dyn KillHost {
        &mut self.killer
    }

    fn set_timeout(&mut self, ms: f64) -> u64 {
        self.timers.borrow_mut().add(ms)
    }

    fn set_idle_timeout(&mut self, ms: f64) -> u64 {
        self.timers.borrow_mut().add(ms)
    }

    fn clear_timeout(&mut self, timer: u64) {
        self.timers.borrow_mut().cancel(timer);
    }

    fn state_changed(&mut self, _listener: u64, state: &LocalMcpState) {
        self.outbox.borrow_mut().states.push(state.hub_state());
    }

    fn tools_changed(&mut self, _listener: u64) {
        self.outbox.borrow_mut().tools_changed = true;
    }

    fn settle(&mut self, call: CallId, kind: CallKind, outcome: Result<CallOutcome, CallFailure>) {
        self.outbox
            .borrow_mut()
            .settled
            .push((call, conn_outcome(kind, outcome)));
    }

    fn compile_output_schema(&mut self, schema: &JsonValue) -> Result<u64, String> {
        self.net.compile_output_schema(schema)
    }

    fn validate_output(&mut self, validator: u64, structured_content: &JsonValue) -> OutputCheck {
        self.net.validate_output(validator, structured_content)
    }
}
