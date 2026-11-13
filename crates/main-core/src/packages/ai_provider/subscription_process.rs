//! `packages/ai-provider/src/subscription/process.ts`: stopping the
//! subscription CLIs and keeping the registry of the children this app
//! started. (`spawnSubscriptionProgram` and `runSubscriptionProgram`, which
//! start a located CLI and collect its output, are not on the MCP modules'
//! path and are not ported here.)
//!
//! ## Driving protocol
//!
//! `killProcessTree` ends a process tree. Its process calls and its timer are
//! behind [`KillHost`]. Two things happen later and are events the caller
//! delivers:
//!
//! - the taskkill child the Windows branch starts emitted `error`
//!   ([`on_killer_error`]): the root is then ended directly;
//! - the grace timer of the POSIX branch fired ([`on_kill_timeout`]): the
//!   group gets `SIGKILL`.
//!
//! The registry ([`SubscriptionChildRegistry`]) is a struct the caller owns,
//! one per app: that one is the TypeScript's `sharedSubscriptionChildRegistry()`
//! (and `trackSubscriptionChild`, `shutdownSubscriptionChildren`,
//! `trackedSubscriptionChildCount` are its methods `track`, `shutdown`,
//! `size`). A child is `track`ed by its pid; the caller delivers the child's
//! `exit` event by calling [`SubscriptionChildRegistry::forget`] with the
//! ticket `track` returned (the same call is the "forget it now" function the
//! TypeScript returns). The record file is written through
//! [`SubscriptionChildHost`], synchronously: where the TypeScript chains the
//! writes on a promise, the host calls here complete one after another, so
//! the record on disk reflects every change when a method returns
//! (`flushed()` has nothing to wait for).

use jscompat::node_path::{host as node_host, win32};
use jscompat::{JsMap, JsObject, JsonValue, json_stringify, number_to_string};

use crate::packages::ai_provider::subscription_locate::EnvGet;

/// `KILL_GRACE_MS`
const KILL_GRACE_MS: f64 = 2_000.0;

/// `NodeJS.Signals` as the TypeScript uses them here
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    Term,
    Kill,
}

impl Signal {
    /// `'SIGTERM'` or `'SIGKILL'`
    pub fn as_str(self) -> &'static str {
        match self {
            Signal::Term => "SIGTERM",
            Signal::Kill => "SIGKILL",
        }
    }
}

/// The options of the process `taskkill` is started with:
/// `{ cwd, stdio: 'ignore', windowsHide: true }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KillerSpawn {
    /// not the folder the app was started in, which may be a document's
    pub cwd: String,
    pub stdio: &'static str,
    pub windows_hide: bool,
}

/// What `killProcessTree` calls of the process.
pub trait KillHost {
    /// `process.platform`
    fn process_platform(&self) -> String;
    /// `process.env[key]`
    fn env_var(&self, key: &str) -> Option<String>;
    /// `kill(pid, signal)`: `process.kill`; a negative `pid` is the group; the
    /// `Err` is what it threw
    fn kill(&mut self, pid: f64, signal: Option<Signal>) -> Result<(), String>;
    /// `spawn(command, args, options)` followed by `killer.once('error', ...)`:
    /// the host calls [`on_killer_error`] with `pid` when the process emits
    /// `error`. The `Err` is what `spawn` threw. Answers the killer's handle.
    fn spawn_killer(
        &mut self,
        pid: f64,
        command: &str,
        args: &[String],
        options: &KillerSpawn,
    ) -> Result<u64, String>;
    /// `killer.unref?.()`; the `Err` is what it threw
    fn unref_killer(&mut self, killer: u64) -> Result<(), String>;
    /// `setTimeout(() => signalGroup('SIGKILL'), ms)`: the host calls
    /// [`on_kill_timeout`] with `pid` when it fires. Answers the timer's handle.
    fn set_kill_timeout(&mut self, ms: f64, pid: f64) -> u64;
    /// `timer.unref?.()`
    fn unref_timer(&mut self, timer: u64);
}

/// `KillTreeOptions`
#[derive(Default)]
pub struct KillTreeOptions<'a> {
    /// POSIX: SIGKILL at once instead of SIGTERM first. Windows always forces.
    pub force: bool,
    pub grace_ms: Option<f64>,
    pub platform: Option<&'a str>,
    /// `NodeJS.ProcessEnv`; `process.env` (through the host) when absent
    pub env: Option<EnvGet<'a>>,
}

/// `validPid(pid)`: a whole number above zero
fn valid_pid(pid: Option<f64>) -> Option<f64> {
    pid.filter(|p| p.is_finite() && p.fract() == 0.0 && *p > 0.0)
}

/// `WINDOWS_ROOT_PATTERN.test(value)`: a drive path made of plain file names.
/// Anything else is not taken as the Windows directory: a relative value
/// would be completed from the working directory, and the value also goes
/// onto the install command line.
///
/// The pattern is `/^[A-Za-z]:(?:\\[^\\/:*?"<>|%\r\n]+)+\\?$/`; a loop of
/// that kind is not a `JsRegex` (it grows the backtrack stack with the text),
/// so the same language is matched by hand: a drive letter, a colon, then
/// one or more names of at least one character, each after a backslash, with
/// one optional backslash at the end.
fn windows_root_ok(value: &str) -> bool {
    let mut chars = value.chars();
    let (Some(drive), Some(':')) = (chars.next(), chars.next()) else {
        return false;
    };
    if !drive.is_ascii_alphabetic() {
        return false;
    }
    let Some(names) = chars.as_str().strip_prefix('\\') else {
        return false;
    };
    let names = names.strip_suffix('\\').unwrap_or(names);
    names.split('\\').all(|name| {
        !name.is_empty()
            && !name.contains(|c: char| {
                matches!(
                    c,
                    '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '%' | '\r' | '\n'
                )
            })
    })
}

/// `windowsSystemDir(env)`: the Windows system directory
/// (`%SystemRoot%\System32`). It is also the working directory of the system
/// tools the app starts.
pub fn windows_system_dir(env: EnvGet<'_>) -> String {
    let root = [env("SystemRoot"), env("SYSTEMROOT"), env("windir")]
        .into_iter()
        .find(|value| value.as_deref().is_some_and(windows_root_ok))
        .flatten();
    win32::join(&[root.as_deref().unwrap_or("C:\\Windows"), "System32"])
}

/// `windowsSystemTool(env, ...segments)`: Windows system tools are started by
/// full path: PATH is not trusted to find them.
pub fn windows_system_tool(env: EnvGet<'_>, segments: &[&str]) -> String {
    let dir = windows_system_dir(env);
    let mut parts: Vec<&str> = vec![&dir];
    parts.extend_from_slice(segments);
    win32::join(&parts)
}

/// `killSingle(signal)`: the process alone; a process already gone is fine.
fn kill_single(host: &mut dyn KillHost, pid: f64, signal: Option<Signal>) {
    let _ = host.kill(pid, signal);
}

/// `signalGroup(signal)`: the process group, which is the child's own; a
/// child that leads no group is signalled alone.
fn signal_group(host: &mut dyn KillHost, pid: f64, signal: Signal) {
    if host.kill(-pid, Some(signal)).is_err() {
        kill_single(host, pid, Some(signal));
    }
}

/// `killProcessTree(target, options)`: end a process and everything it
/// started. Windows: `taskkill /T /F` on the process tree. Elsewhere: a
/// signal to the process group, which is the child's own because the CLI is
/// started detached; a child that leads no group is signalled alone. Never
/// fails; a process already gone is fine. `pid` is the number, or the `pid`
/// of the object the TypeScript is given (`None`: it has none).
pub fn kill_process_tree(pid: Option<f64>, options: &KillTreeOptions<'_>, host: &mut dyn KillHost) {
    let Some(pid) = valid_pid(pid) else {
        return;
    };
    let platform = match options.platform {
        Some(platform) => platform.to_owned(),
        None => host.process_platform(),
    };
    if platform == "win32" {
        // The root must still be alive for taskkill to walk its children, so it is
        // not ended first; it is ended directly only when taskkill cannot run.
        if start_killer(pid, options, host).is_err() {
            kill_single(host, pid, None);
        }
        return;
    }
    if options.force {
        signal_group(host, pid, Signal::Kill);
        return;
    }
    signal_group(host, pid, Signal::Term);
    let timer = host.set_kill_timeout(options.grace_ms.unwrap_or(KILL_GRACE_MS), pid);
    host.unref_timer(timer);
}

/// the `try` block of the Windows branch
fn start_killer(
    pid: f64,
    options: &KillTreeOptions<'_>,
    host: &mut dyn KillHost,
) -> Result<(), String> {
    let (tool, cwd) = {
        let process_env = |key: &str| host.env_var(key);
        let env: EnvGet<'_> = match options.env {
            Some(env) => env,
            None => &process_env,
        };
        (
            windows_system_tool(env, &["taskkill.exe"]),
            windows_system_dir(env),
        )
    };
    let args = vec![
        "/PID".to_owned(),
        number_to_string(pid),
        "/T".to_owned(),
        "/F".to_owned(),
    ];
    let killer = host.spawn_killer(
        pid,
        &tool,
        &args,
        &KillerSpawn {
            cwd,
            stdio: "ignore",
            windows_hide: true,
        },
    )?;
    host.unref_killer(killer)
}

/// The taskkill child emitted `error` (`killer.once('error', () => killSingle())`).
pub fn on_killer_error(pid: f64, host: &mut dyn KillHost) {
    kill_single(host, pid, None);
}

/// The grace timer fired (`() => signalGroup('SIGKILL')`).
pub fn on_kill_timeout(pid: f64, host: &mut dyn KillHost) {
    signal_group(host, pid, Signal::Kill);
}

// ── The registry of children this app started ──

/// `SUBSCRIPTION_LEFTOVER_FILE_PREFIX`: leftover records are
/// `<prefix><pid of the app process>.json` in the directory the app passes
pub const SUBSCRIPTION_LEFTOVER_FILE_PREFIX: &str = "subscription-children-";

/// `leftoverRecordFile(dir, ownerPid)`: the record file of one app process
/// (`process.pid` by default).
pub fn leftover_record_file(dir: &str, owner_pid: f64) -> String {
    node_host::join(&[
        dir,
        &format!(
            "{SUBSCRIPTION_LEFTOVER_FILE_PREFIX}{}.json",
            number_to_string(owner_pid)
        ),
    ])
}

/// `USER_MCP_CHILD_KIND`: the kind of program a record line stands for, kept in
/// the record's `provider` field: a subscription CLI, or a server the person
/// registered and approved for the app to start (user MCP spec 5.3).
pub const USER_MCP_CHILD_KIND: &str = "user-mcp";

/// `TrackedChildInfo`
#[derive(Debug, Clone, PartialEq)]
pub struct TrackedChildInfo {
    /// `TrackedChildKind`: a subscription provider id, or [`USER_MCP_CHILD_KIND`]
    pub provider: String,
    /// the file that was started, as passed to spawn
    pub command: String,
    /// when it was started (epoch ms); now when absent
    pub started_at: Option<f64>,
}

/// `LeftoverChildRecord`: one line of a leftover record.
#[derive(Debug, Clone, PartialEq)]
pub struct LeftoverChildRecord {
    pub pid: f64,
    pub provider: String,
    pub command: String,
    pub started_at: f64,
}

/// What the registry calls of the machine: the clock, the owner, killing, and
/// the record file.
pub trait SubscriptionChildHost {
    /// `Date.now()`
    fn now_ms(&mut self) -> f64;
    /// `process.pid` and `SUBSCRIPTION_OWNER_STARTED_AT` (when this process
    /// started, by its own clock)
    fn owner(&self) -> (f64, f64);
    /// `deps.killTree(pid)`, `killProcessTree(pid, { force: true })` by
    /// default; the `Err` is what it threw
    fn kill_tree(&mut self, pid: f64) -> Result<(), String>;
    /// `mkdir(dir, { recursive: true })`
    fn mkdir_p(&mut self, dir: &str) -> Result<(), String>;
    /// `writeFile(path, text)`
    fn write_file(&mut self, path: &str, text: &str) -> Result<(), String>;
    /// `rename(from, to)`
    fn rename(&mut self, from: &str, to: &str) -> Result<(), String>;
    /// `rmSync(path, { force: true })`
    fn remove_sync(&mut self, path: &str) -> Result<(), String>;
    /// `rm(path, { force: true })`
    fn remove(&mut self, path: &str) -> Result<(), String>;
}

/// What `track` answers: the child a later [`SubscriptionChildRegistry::forget`]
/// forgets (the TypeScript's `forget` closure). It forgets only the entry it
/// was made for, never a later child with the same pid.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChildTicket {
    pid_serial: (u64, u64),
}

/// `SubscriptionChildRegistry`, as `createSubscriptionChildRegistry()` makes it.
pub struct SubscriptionChildRegistry {
    /// pid (as the TypeScript's `Map` key) to the entry and its serial
    children: JsMap<(LeftoverChildRecord, u64)>,
    record_dir: Option<String>,
    serial: u64,
}

/// `createSubscriptionChildRegistry(deps)`: `deps.killTree` is
/// [`SubscriptionChildHost::kill_tree`].
pub fn create_subscription_child_registry() -> SubscriptionChildRegistry {
    SubscriptionChildRegistry {
        children: JsMap::new(),
        record_dir: None,
        serial: 0,
    }
}

impl SubscriptionChildRegistry {
    /// `persist()`: write the record whole, then swap it in: a crash mid-write
    /// must not leave half a record. A step that fails ends the write
    /// quietly.
    fn persist(&self, host: &mut dyn SubscriptionChildHost) {
        let Some(dir) = self.record_dir.as_deref().filter(|dir| !dir.is_empty()) else {
            return;
        };
        let (owner_pid, owner_started_at) = host.owner();
        let mut owner = JsObject::new();
        owner.set("pid", JsonValue::Number(owner_pid));
        owner.set("startedAt", JsonValue::Number(owner_started_at));
        let children: Vec<JsonValue> = self
            .children
            .values()
            .map(|(entry, _)| {
                let mut child = JsObject::new();
                child.set("pid", JsonValue::Number(entry.pid));
                child.set("provider", JsonValue::String(entry.provider.clone()));
                child.set("command", JsonValue::String(entry.command.clone()));
                child.set("startedAt", JsonValue::Number(entry.started_at));
                JsonValue::Object(child)
            })
            .collect();
        let mut record = JsObject::new();
        record.set("version", JsonValue::Number(1.0));
        record.set("owner", JsonValue::Object(owner));
        record.set("children", JsonValue::Array(children));
        let file = leftover_record_file(dir, owner_pid);
        let _ = (|| -> Result<(), String> {
            host.mkdir_p(dir)?;
            let temp = format!("{file}.tmp");
            host.write_file(&temp, &json_stringify(&JsonValue::Object(record)))?;
            host.rename(&temp, &file)
        })();
    }

    /// `track(child, info)`: register a started child (`pid` is its `pid`);
    /// the caller forgets it when it exits. `None` is the no-op function the
    /// TypeScript returns for a child without a valid pid.
    pub fn track(
        &mut self,
        pid: Option<f64>,
        info: &TrackedChildInfo,
        host: &mut dyn SubscriptionChildHost,
    ) -> Option<ChildTicket> {
        let pid = valid_pid(pid)?;
        let started_at = match info.started_at {
            Some(at) => at,
            None => host.now_ms(),
        };
        let entry = LeftoverChildRecord {
            pid,
            provider: info.provider.clone(),
            command: info.command.clone(),
            started_at,
        };
        self.serial += 1;
        let serial = self.serial;
        self.children.set(number_to_string(pid), (entry, serial));
        self.persist(host);
        Some(ChildTicket {
            pid_serial: (pid.to_bits(), serial),
        })
    }

    /// `forget()`: the registered child leaves the registry now, unless a
    /// later child took its pid.
    pub fn forget(&mut self, ticket: ChildTicket, host: &mut dyn SubscriptionChildHost) {
        let (bits, serial) = ticket.pid_serial;
        let key = number_to_string(f64::from_bits(bits));
        match self.children.get(&key) {
            Some((_, current)) if *current == serial => {}
            _ => return,
        }
        self.children.delete(&key);
        self.persist(host);
    }

    /// `shutdown()`: end every registered child with its process tree. Safe
    /// in quit and crash handlers and to call more than once.
    pub fn shutdown(&mut self, host: &mut dyn SubscriptionChildHost) {
        let pids: Vec<f64> = self.children.values().map(|(entry, _)| entry.pid).collect();
        self.children.clear();
        for pid in pids {
            // keep ending the others
            let _ = host.kill_tree(pid);
        }
        let Some(dir) = self.record_dir.as_deref().filter(|dir| !dir.is_empty()) else {
            return;
        };
        let (owner_pid, _) = host.owner();
        let file = leftover_record_file(dir, owner_pid);
        // the next start reads it and finds nothing alive
        let _ = host.remove_sync(&file);
        // a write that was already under way must not bring the record back
        let _ = host.remove(&file);
    }

    /// `size`
    pub fn size(&self) -> usize {
        self.children.len()
    }

    /// `recordIn(dir)`: keep a record of the registered children in `dir`
    /// (`None`: stop), for the next start to clean up.
    pub fn record_in(&mut self, dir: Option<&str>, host: &mut dyn SubscriptionChildHost) {
        self.record_dir = dir.map(str::to_owned);
        if dir.is_some_and(|dir| !dir.is_empty()) {
            self.persist(host);
        }
    }
}

// ── Starting a program, and the registry on the runtime ──
//
// The part of `process.ts` the MCP modules did not need: `spawnSubscriptionProgram`,
// `runSubscriptionProgram`, and `sharedSubscriptionChildRegistry()` as the
// registry above wired to [`Rt`]. The TypeScript's `defaultRegistry` is the
// [`SharedChildRegistry`] the caller owns. Its record file is written through
// the runtime's file system, one write after another in the order asked (the
// TypeScript's `writes` promise chain): the three steps of one `persist()`
// (`mkdir`, write, rename) are one link, and a failed step ends that link
// only. `rmSync` of `shutdown()` is queued like the other writes, since the
// runtime has no synchronous file system call; the record is gone once the
// queue is ([`SharedChildRegistry::flushed`]). `process.kill` of a negative
// pid is a command the host carries out, a host that cannot signal a group
// signals the process alone, as `signalGroup` does after its first attempt.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use crate::packages::ai_provider::subscription_env::{
    SubscriptionEnvOptions, subscription_child_env,
};
use crate::packages::ai_provider::subscription_locate::SubscriptionProgram;
use crate::packages::ai_provider::task::{
    Child, ChildEvent, FsOp, Id, JsError, LocalBoxFuture, Rt, Settle, Signal as AbortSignal,
    SpawnRequest, Stdio,
};

/// The record file writes not done yet
#[derive(Default)]
struct WriteQueue {
    /// links: the steps of one `persist()`, or one removal
    chains: VecDeque<Vec<FsOp>>,
    running: bool,
    /// `flushed()` callers
    waiters: Vec<Settle<()>>,
}

/// Starts the task that carries the queued writes out, unless it runs.
fn drain_writes(rt: &Rt, queue: &Rc<RefCell<WriteQueue>>) {
    {
        let mut pending = queue.borrow_mut();
        if pending.running || pending.chains.is_empty() {
            return;
        }
        pending.running = true;
    }
    let rt_task = rt.clone();
    let queue_task = queue.clone();
    rt.spawn_local(async move {
        loop {
            let chain = queue_task.borrow_mut().chains.pop_front();
            let Some(chain) = chain else {
                break;
            };
            for op in chain {
                // a step that fails ends the write quietly
                if rt_task.fs(op).await.is_err() {
                    break;
                }
            }
        }
        let waiters = {
            let mut pending = queue_task.borrow_mut();
            pending.running = false;
            std::mem::take(&mut pending.waiters)
        };
        for waiter in waiters {
            waiter.settle(());
        }
    });
}

/// What the registry calls of the machine, on the runtime
struct RtChildHost<'a> {
    rt: &'a Rt,
    owner_started_at: f64,
    queue: &'a RefCell<WriteQueue>,
}

impl RtChildHost<'_> {
    fn new_chain(&self, op: FsOp) {
        self.queue.borrow_mut().chains.push_back(vec![op]);
    }

    fn continue_chain(&self, op: FsOp) {
        let mut queue = self.queue.borrow_mut();
        match queue.chains.back_mut() {
            Some(chain) => chain.push(op),
            None => queue.chains.push_back(vec![op]),
        }
    }
}

impl SubscriptionChildHost for RtChildHost<'_> {
    fn now_ms(&mut self) -> f64 {
        self.rt.now()
    }

    fn owner(&self) -> (f64, f64) {
        (self.rt.pid(), self.owner_started_at)
    }

    fn kill_tree(&mut self, pid: f64) -> Result<(), String> {
        kill_process_tree_rt(self.rt, Some(pid), true);
        Ok(())
    }

    fn mkdir_p(&mut self, dir: &str) -> Result<(), String> {
        self.new_chain(FsOp::Mkdir {
            path: dir.to_owned(),
            recursive: true,
            mode: None,
        });
        Ok(())
    }

    fn write_file(&mut self, path: &str, text: &str) -> Result<(), String> {
        self.continue_chain(FsOp::WriteFile {
            path: path.to_owned(),
            data: text.as_bytes().to_vec(),
            mode: None,
            flag: None,
        });
        Ok(())
    }

    fn rename(&mut self, from: &str, to: &str) -> Result<(), String> {
        self.continue_chain(FsOp::Rename {
            from: from.to_owned(),
            to: to.to_owned(),
        });
        Ok(())
    }

    fn remove_sync(&mut self, path: &str) -> Result<(), String> {
        self.remove(path)
    }

    fn remove(&mut self, path: &str) -> Result<(), String> {
        self.new_chain(FsOp::Rm {
            path: path.to_owned(),
            recursive: false,
            force: true,
        });
        Ok(())
    }
}

struct SharedInner {
    registry: RefCell<SubscriptionChildRegistry>,
    queue: Rc<RefCell<WriteQueue>>,
    owner_started_at: f64,
}

/// `sharedSubscriptionChildRegistry()`: the registry of the app, which the
/// caller owns (one per app; cloning it is cheap and shares it).
#[derive(Clone)]
pub struct SharedChildRegistry {
    inner: Rc<SharedInner>,
}

impl SharedChildRegistry {
    /// `owner_started_at` is `SUBSCRIPTION_OWNER_STARTED_AT`: when this
    /// process started, by its own clock (`Math.round(Date.now() -
    /// process.uptime() * 1000)`); it identifies the process as the owner of
    /// a record.
    pub fn new(owner_started_at: f64) -> Self {
        SharedChildRegistry {
            inner: Rc::new(SharedInner {
                registry: RefCell::new(create_subscription_child_registry()),
                queue: Rc::new(RefCell::new(WriteQueue::default())),
                owner_started_at,
            }),
        }
    }

    /// `SUBSCRIPTION_OWNER_STARTED_AT`
    pub fn owner_started_at(&self) -> f64 {
        self.inner.owner_started_at
    }

    fn with_host<R>(
        &self,
        rt: &Rt,
        run: impl FnOnce(&mut SubscriptionChildRegistry, &mut RtChildHost<'_>) -> R,
    ) -> R {
        let mut host = RtChildHost {
            rt,
            owner_started_at: self.inner.owner_started_at,
            queue: &self.inner.queue,
        };
        let answer = run(&mut self.inner.registry.borrow_mut(), &mut host);
        drain_writes(rt, &self.inner.queue);
        answer
    }

    /// `track(child, info)` for a child whose pid is `pid`: the ticket
    /// [`SharedChildRegistry::forget`] takes; `None` for a child without a valid pid
    pub fn track(&self, rt: &Rt, pid: Option<f64>, info: &TrackedChildInfo) -> Option<ChildTicket> {
        self.with_host(rt, |registry, host| registry.track(pid, info, host))
    }

    /// `forget()` of the function `track` returns
    pub fn forget(&self, rt: &Rt, ticket: ChildTicket) {
        self.with_host(rt, |registry, host| registry.forget(ticket, host));
    }

    /// `shutdown()`: end every registered child with its process tree
    pub fn shutdown(&self, rt: &Rt) {
        self.with_host(rt, |registry, host| registry.shutdown(host));
    }

    /// `size`
    pub fn size(&self) -> usize {
        self.inner.registry.borrow().size()
    }

    /// `recordIn(dir)`: keep a record of the registered children in `dir`
    /// (`None`: stop), for the next start to clean up
    pub fn record_in(&self, rt: &Rt, dir: Option<&str>) {
        self.with_host(rt, |registry, host| registry.record_in(dir, host));
    }

    /// `flushed()`: answers once the record on disk reflects every change so far
    pub async fn flushed(&self, rt: &Rt) {
        let waiter = {
            let mut queue = self.inner.queue.borrow_mut();
            if !queue.running && queue.chains.is_empty() {
                return;
            }
            let (settle, wait) = rt.deferred::<()>();
            queue.waiters.push(settle);
            wait
        };
        waiter.await;
    }
}

/// `trackSubscriptionChild(child, info)`: register a child that was not
/// started through [`spawn_subscription_program`], so that
/// [`shutdown_subscription_children`] ends it too; it is forgotten when it
/// exits. The ticket is what the function the TypeScript returns forgets it with.
pub fn track_subscription_child(
    rt: &Rt,
    shared: &SharedChildRegistry,
    child: &Child,
    info: &TrackedChildInfo,
) -> Option<ChildTicket> {
    let ticket = shared.track(rt, child.pid(), info)?;
    let rt_exit = rt.clone();
    let shared_exit = shared.clone();
    child.on(move |event| {
        if matches!(event, ChildEvent::Exit { .. }) {
            shared_exit.forget(&rt_exit, ticket);
        }
    });
    Some(ticket)
}

/// `shutdownSubscriptionChildren()`: end every subscription CLI this app
/// started, with its descendants. Safe to call more than once.
pub fn shutdown_subscription_children(rt: &Rt, shared: &SharedChildRegistry) {
    shared.shutdown(rt);
}

/// `trackedSubscriptionChildCount()`
pub fn tracked_subscription_child_count(shared: &SharedChildRegistry) -> usize {
    shared.size()
}

/// `SubscriptionSpawnOptions.registry`: where the child is registered
#[derive(Clone, Default)]
pub enum RegistryChoice {
    /// absent: the shared registry
    #[default]
    Shared,
    /// `null`: none
    None,
    /// a registry of its own
    Custom(SharedChildRegistry),
}

/// `registry?.track(child, info)`, with the shared registry for
/// [`RegistryChoice::Shared`]
pub fn track_child(
    rt: &Rt,
    shared: &SharedChildRegistry,
    registry: &RegistryChoice,
    child: &Child,
    info: &TrackedChildInfo,
) {
    match registry {
        RegistryChoice::Shared => {
            track_subscription_child(rt, shared, child, info);
        }
        RegistryChoice::None => {}
        RegistryChoice::Custom(custom) => {
            track_subscription_child(rt, custom, child, info);
        }
    }
}

/// `killProcessTree(pid, { force })` on the runtime: the Windows branch
/// starts `taskkill` as a child of its own (its start is left to run beside
/// the caller, as the TypeScript does not wait for it), the POSIX branch
/// signals the group and arms the grace timer.
pub fn kill_process_tree_rt(rt: &Rt, pid: Option<f64>, force: bool) {
    kill_process_tree(
        pid,
        &KillTreeOptions {
            force,
            ..KillTreeOptions::default()
        },
        &mut RtKillHost { rt: rt.clone() },
    );
}

/// What `killProcessTree` calls of the process, on the runtime
struct RtKillHost {
    rt: Rt,
}

impl KillHost for RtKillHost {
    fn process_platform(&self) -> String {
        self.rt.platform()
    }

    fn env_var(&self, key: &str) -> Option<String> {
        self.rt.env(key)
    }

    fn kill(&mut self, pid: f64, signal: Option<Signal>) -> Result<(), String> {
        self.rt
            .kill_pid(pid, signal.map(Signal::as_str))
            .map_err(|e| e.message_or_string())
    }

    fn spawn_killer(
        &mut self,
        pid: f64,
        command: &str,
        args: &[String],
        options: &KillerSpawn,
    ) -> Result<u64, String> {
        let request = SpawnRequest {
            command: command.to_owned(),
            args: args.to_vec(),
            cwd: Some(options.cwd.clone()),
            env: None,
            stdio: [Stdio::Ignore; 3],
            detached: false,
            windows_hide: options.windows_hide,
            shell: None,
        };
        let rt = self.rt.clone();
        let mut start: LocalBoxFuture<()> = Box::pin(async move {
            match rt.spawn(request).await {
                Ok(killer) => {
                    let rt_error = rt.clone();
                    killer.on(move |event| {
                        if matches!(event, ChildEvent::Error(_)) {
                            on_killer_error(
                                pid,
                                &mut RtKillHost {
                                    rt: rt_error.clone(),
                                },
                            );
                        }
                    });
                }
                // spawn threw
                Err(_) => on_killer_error(pid, &mut RtKillHost { rt: rt.clone() }),
            }
        });
        // `spawn(...)` of the TypeScript starts the process now: the command is queued by the
        // first poll, and the rest (the listener) waits for the answer
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        if start.as_mut().poll(&mut cx).is_pending() {
            self.rt.spawn_local(start);
        }
        Ok(0)
    }

    fn unref_killer(&mut self, _killer: u64) -> Result<(), String> {
        Ok(())
    }

    fn set_kill_timeout(&mut self, ms: f64, pid: f64) -> u64 {
        let rt = self.rt.clone();
        self.rt.set_timeout(ms, move || {
            on_kill_timeout(pid, &mut RtKillHost { rt });
        })
    }

    fn unref_timer(&mut self, _timer: u64) {}
}

/// `SubscriptionSpawnOptions`
#[derive(Clone, Default)]
pub struct SubscriptionSpawnOptions {
    pub cwd: Option<String>,
    /// default: three pipes
    pub stdio: Option<[Stdio; 3]>,
    /// environment to sanitise; the app's own when absent
    pub base_env: Option<Vec<(String, String)>>,
    /// variables for this run, applied after the sanitising
    pub env: Vec<(String, String)>,
    pub platform: Option<String>,
    /// where the child is registered
    pub registry: RegistryChoice,
}

/// `spawnSubscriptionProgram(program, args, options)`: start a located CLI:
/// its resolved file, an argument list, the sanitised environment, no shell.
/// The child is registered for shutdown, and on POSIX leads its own process
/// group so the whole group can be ended. An `Err` is what `spawn` threw.
pub async fn spawn_subscription_program(
    rt: &Rt,
    shared: &SharedChildRegistry,
    program: &SubscriptionProgram,
    args: &[String],
    options: &SubscriptionSpawnOptions,
) -> Result<Child, JsError> {
    let platform = options.platform.clone().unwrap_or_else(|| rt.platform());
    // `{ ...program.env, ...options.env }`
    let mut extra: JsObject<String> = JsObject::new();
    for (name, value) in program.env.iter().chain(options.env.iter()) {
        extra.set(name.clone(), value.clone());
    }
    let env = subscription_child_env(
        rt,
        &SubscriptionEnvOptions {
            base: options.base_env.clone(),
            platform: Some(platform.clone()),
            command: Some(program.command.clone()),
            extra: extra
                .entries()
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value.clone()))
                .collect(),
        },
    );
    let mut spawn_args = program.prefix_args.clone();
    spawn_args.extend(args.iter().cloned());
    let child = rt
        .spawn(SpawnRequest {
            command: program.command.clone(),
            args: spawn_args,
            cwd: options.cwd.clone(),
            env: Some(env),
            stdio: options.stdio.unwrap_or([Stdio::Pipe; 3]),
            // POSIX: a process group of its own, so the group can be signalled. Windows ends trees by
            // pid, and a detached child there would only lose its console.
            detached: platform != "win32",
            windows_hide: true,
            shell: None,
        })
        .await?;
    track_child(
        rt,
        shared,
        &options.registry,
        &child,
        &TrackedChildInfo {
            provider: program.provider.clone(),
            command: program.command.clone(),
            started_at: None,
        },
    );
    Ok(child)
}

/// `SubscriptionCommandResult`
#[derive(Debug, Clone, PartialEq)]
pub struct SubscriptionCommandResult {
    /// `None` when the program was ended by a signal
    pub code: Option<f64>,
    pub stdout: String,
    pub stderr: String,
}

/// `SubscriptionRunOptions`
#[derive(Clone)]
pub struct SubscriptionRunOptions {
    /// the caller gave up: the program is ended and the run rejects
    pub signal: AbortSignal,
    pub timeout_ms: f64,
    pub base_env: Option<Vec<(String, String)>>,
    pub cwd: Option<String>,
}

/// `SubscriptionRunner`: runs one CLI command to its end;
/// [`run_subscription_program`] is the real one
pub type SubscriptionRunner = Rc<
    dyn Fn(
        Rt,
        SubscriptionProgram,
        Vec<String>,
        SubscriptionRunOptions,
    ) -> LocalBoxFuture<Result<SubscriptionCommandResult, JsError>>,
>;

/// `MAX_COMMAND_OUTPUT_BYTES`
const MAX_COMMAND_OUTPUT_BYTES: usize = 256 * 1024;

/// `abortError()`
fn abort_error() -> JsError {
    JsError::error("The command was cancelled").named("AbortError")
}

/// What a run has collected, and the two things that end it
#[derive(Default)]
struct RunState {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    size: usize,
    settled: bool,
    timer: Option<Id>,
    abort_listener: Option<Id>,
}

/// `runSubscriptionProgram(program, args, options)`: run a short CLI command
/// (version, login status) and collect its output. stdin is closed from the
/// start, because both CLIs wait on an open stdin. The working directory is
/// the temp dir, so no project-level configuration of some other directory
/// applies.
pub async fn run_subscription_program(
    rt: &Rt,
    shared: &SharedChildRegistry,
    program: &SubscriptionProgram,
    args: &[String],
    options: &SubscriptionRunOptions,
) -> Result<SubscriptionCommandResult, JsError> {
    if options.signal.aborted() {
        return Err(abort_error());
    }
    let mut spawning: LocalBoxFuture<Result<Child, JsError>> = {
        let (rt, shared, program, args) =
            (rt.clone(), shared.clone(), program.clone(), args.to_vec());
        let spawn_options = SubscriptionSpawnOptions {
            cwd: Some(options.cwd.clone().unwrap_or_else(|| rt.tmpdir())),
            stdio: Some([Stdio::Ignore, Stdio::Pipe, Stdio::Pipe]),
            base_env: options.base_env.clone(),
            ..SubscriptionSpawnOptions::default()
        };
        Box::pin(async move {
            spawn_subscription_program(&rt, &shared, &program, &args, &spawn_options).await
        })
    };
    // `spawn(...)` of Node starts the process at the call, and the timer and the listeners
    // come right after it, before anything else runs: the first poll queues the start
    let first = spawning
        .as_mut()
        .poll(&mut std::task::Context::from_waker(std::task::Waker::noop()));
    let (settle, wait) = rt.deferred::<Result<SubscriptionCommandResult, JsError>>();
    let state = Rc::new(RefCell::new(RunState::default()));
    // the child's pid, once the start is answered
    let pid_cell: Rc<std::cell::Cell<Option<f64>>> = Rc::new(std::cell::Cell::new(None));
    // `finish(error, code)`
    let finish: Rc<dyn Fn(Option<JsError>, Option<f64>)> = {
        let rt = rt.clone();
        let state = state.clone();
        let signal = options.signal.clone();
        let pid_cell = pid_cell.clone();
        Rc::new(move |error: Option<JsError>, code: Option<f64>| {
            {
                let mut run = state.borrow_mut();
                if run.settled {
                    return;
                }
                run.settled = true;
            }
            let (timer, listener) = {
                let run = state.borrow();
                (run.timer, run.abort_listener)
            };
            rt.clear_timeout(timer);
            if let Some(listener) = listener {
                signal.off(listener);
            }
            match error {
                Some(error) => {
                    kill_process_tree_rt(&rt, pid_cell.get(), true);
                    settle.settle(Err(error));
                }
                None => {
                    let run = state.borrow();
                    settle.settle(Ok(SubscriptionCommandResult {
                        code,
                        stdout: String::from_utf8_lossy(&run.stdout).into_owned(),
                        stderr: String::from_utf8_lossy(&run.stderr).into_owned(),
                    }));
                }
            }
        })
    };
    let on_timeout = finish.clone();
    let timeout_ms = options.timeout_ms;
    let timer = rt.set_timeout(timeout_ms, move || {
        on_timeout(
            Some(JsError::error(format!(
                "The command did not finish within {} ms",
                number_to_string(timeout_ms)
            ))),
            None,
        );
    });
    state.borrow_mut().timer = Some(timer);
    let on_abort = finish.clone();
    let listener = options
        .signal
        .on_abort(move |_| on_abort(Some(abort_error()), None));
    state.borrow_mut().abort_listener = Some(listener);
    let child = match first {
        std::task::Poll::Ready(started) => started,
        std::task::Poll::Pending => spawning.await,
    };
    let child = match child {
        Ok(child) => child,
        Err(error) => {
            // a `spawn` that throws rejects the run: the timer and the listener end with it
            finish(Some(error), None);
            return wait.await;
        }
    };
    pid_cell.set(child.pid());
    let on_event = finish;
    let collected = state;
    child.on(move |event| match event {
        ChildEvent::Stdout(chunk) | ChildEvent::Stderr(chunk) => {
            let mut run = collected.borrow_mut();
            if run.size >= MAX_COMMAND_OUTPUT_BYTES {
                return;
            }
            run.size += chunk.len();
            if matches!(event, ChildEvent::Stdout(_)) {
                run.stdout.extend_from_slice(chunk);
            } else {
                run.stderr.extend_from_slice(chunk);
            }
        }
        ChildEvent::Error(error) => on_event(Some(error.clone()), None),
        ChildEvent::Close { code, .. } => on_event(None, *code),
        ChildEvent::Exit { .. } => {}
    });
    wait.await
}
