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
        .find(|value| value.as_deref().is_some_and(windows_root_ok));
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
