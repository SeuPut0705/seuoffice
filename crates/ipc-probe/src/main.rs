//! The Rust side of tools/ipc-diff (the stage 3 shell contract, section 8).
//! Reads one request per line on stdin, `{"dir": folder, "case": case}`, and
//! answers each with one line on stdout. Every case gets a fresh world: a
//! real core thread, a fake UI thread, workers it can wait for, the case's
//! views, `app.getPath` under the case's folder, and hosts faked from the
//! case (the shared ones here, each batch's through its `probe_hosts`). All
//! six batches register as they stand; then the case's calls run in order
//! through the shell's own dispatch. The shapes are in
//! tools/ipc-diff/README.md.

mod fakes;

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, LazyLock, Mutex, mpsc};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use shell_contract::editors::Then;
use shell_contract::ids::{RequestId, ViewId, WindowId};
use shell_contract::ipc::{ChannelKind, EventSink, RegisterError, Registry, Reply, Sender, Target};
use shell_contract::provided::Provided;
use shell_contract::runtime::{AppPaths, PathName, Services, Thread, Views, Workers, run_on};
use shell_contract::value::IpcValue;
use shell_contract::{Hosts, PRELOADS, Surface};
use shell_core::core_thread::{CoreThread, ThreadWorkers};
use shell_core::dispatch::{CatchingWorkers, Dispatcher};
use shell_core::outlet::resolve;
use shell_core::table::{StartError, Table};
use shell_core::{BATCHES, wire};

/// The call log a batch's fakes write to: take it from the hosts with
/// `hosts.get::<ProbeLog>()`; one JSON line per call, named after the
/// Electron call it fakes (tools/ipc-diff/README.md)
pub type ProbeLog = Arc<Mutex<Vec<Value>>>;

/// The batch of each entry of [`BATCHES`], as a group names it
const BATCH_NAMES: [&str; 6] = ["U", "A", "M", "W", "D1", "D2"];
const _: () = assert!(BATCHES.len() == BATCH_NAMES.len());

/// How long one call may take before the case fails
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn unhex(text: &str) -> Vec<u8> {
    (0..text.len() / 2)
        .filter_map(|i| u8::from_str_radix(&text[2 * i..2 * i + 2], 16).ok())
        .collect()
}

static SURFACES: LazyLock<HashMap<String, Surface>> = LazyLock::new(|| {
    PRELOADS
        .iter()
        .map(|p| (format!("{:?}", p.surface), p.surface))
        .collect()
});

/// The views of the case, in the order `Views::all` lists them
struct CaseViews(Vec<Sender>);

impl Views for CaseViews {
    fn sender_of(&self, view: ViewId) -> Option<Sender> {
        self.0.iter().find(|s| s.view == view).copied()
    }

    fn all(&self) -> Vec<Sender> {
        self.0.clone()
    }

    fn on_destroyed(&self, _listener: Box<dyn Fn(ViewId) + Send + Sync>) {}
}

/// `app.getPath(name)` is `<folder>/<name>`, as fakes.ts answers it
struct CasePaths(PathBuf);

impl AppPaths for CasePaths {
    fn path(&self, name: PathName) -> PathBuf {
        let name = match name {
            PathName::Home => "home",
            PathName::AppData => "appData",
            PathName::UserData => "userData",
            PathName::Temp => "temp",
            PathName::Exe => "exe",
            PathName::Desktop => "desktop",
            PathName::Documents => "documents",
            PathName::Downloads => "downloads",
            PathName::Logs => "logs",
        };
        self.0.join(name)
    }
}

/// Every event, one entry per view it reaches
struct Recorder {
    views: Arc<CaseViews>,
    events: Events,
}

/// The events of a case so far. While `muted` names a thread, what that
/// thread sends is not kept ([`register_keeping_own`]); other threads' sends
/// (a worker a batch started) are.
#[derive(Default)]
struct Events {
    list: Mutex<Vec<Value>>,
    muted: Mutex<Option<std::thread::ThreadId>>,
}

impl Events {
    fn push(&self, event: Value) {
        if *self.muted.lock().unwrap() != Some(std::thread::current().id()) {
            self.list.lock().unwrap().push(event);
        }
    }

    fn take(&self) -> Vec<Value> {
        std::mem::take(&mut *self.list.lock().unwrap())
    }
}

impl EventSink for Recorder {
    fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
        let mut e = wire::Encoder::default();
        let header = e.values(&args);
        let buffers: Vec<String> = e.buffers.iter().map(|b| hex(b)).collect();
        for view in resolve(self.views.as_ref(), target) {
            self.events.push(json!({
                "view": view.0,
                "channel": channel,
                "args": header,
                "buffers": buffers,
            }));
        }
    }
}

/// Workers the probe can wait for
#[derive(Default)]
struct Tracked {
    active: Mutex<usize>,
    idle: Condvar,
    spawned: AtomicUsize,
}

struct TrackedWorkers(Arc<Tracked>);

impl Workers for TrackedWorkers {
    fn spawn(&self, job: Box<dyn FnOnce() + Send>) {
        let tracked = self.0.clone();
        *tracked.active.lock().unwrap() += 1;
        tracked.spawned.fetch_add(1, Ordering::SeqCst);
        ThreadWorkers.spawn(Box::new(move || {
            // counted down even when the job panics
            struct Done(Arc<Tracked>);
            impl Drop for Done {
                fn drop(&mut self) {
                    *self.0.active.lock().unwrap() -= 1;
                    self.0.idle.notify_all();
                }
            }
            let _done = Done(tracked);
            job();
        }));
    }
}

impl Tracked {
    fn wait_idle(&self, until: Instant) -> bool {
        let mut active = self.active.lock().unwrap();
        while *active > 0 {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            active = self.idle.wait_timeout(active, left).unwrap().0;
        }
        true
    }
}

thread_local! {
    /// The case's dispatch, on its core thread
    static DISPATCHER: RefCell<Option<Dispatcher>> = const { RefCell::new(None) };
    /// What the batches provide each other, for the `trigger` calls
    static PROVIDED: RefCell<Option<Rc<Provided>>> = const { RefCell::new(None) };
}

fn sender_of(view: &Value) -> Result<Sender, String> {
    let surface = view["surface"].as_str().unwrap_or("Shell");
    let surface = *SURFACES
        .get(surface)
        .ok_or_else(|| format!("no such surface: {surface}"))?;
    let id = view["view"].as_u64().ok_or("a view without an id")? as u32;
    let window = view["window"].as_u64().unwrap_or(id as u64) as u32;
    Ok(Sender {
        view: ViewId(id),
        window: WindowId(window),
        surface,
    })
}

fn kind_of(text: &str) -> Result<ChannelKind, String> {
    match text {
        "invoke" => Ok(ChannelKind::Invoke),
        "send" => Ok(ChannelKind::Send),
        "sendSync" => Ok(ChannelKind::SendSync),
        other => Err(format!("no such call kind: {other}")),
    }
}

fn answer(kind: ChannelKind, channel: &str, reply: Option<Reply>) -> Value {
    match (kind, reply) {
        (_, None) => json!({ "timeout": true }),
        (ChannelKind::Send, Some(Ok(_))) => json!({}),
        (ChannelKind::Send, Some(Err(e))) => json!({ "thrown": e.to_string() }),
        (_, Some(Ok(value))) => {
            let (header, buffers) = wire::encode(&value);
            let buffers: Vec<String> = buffers.iter().map(|b| hex(b)).collect();
            json!({ "value": header, "buffers": buffers })
        }
        (_, Some(Err(e))) => json!({ "error": e.remote_message(channel) }),
    }
}

/// A deferred step until an `await` step takes its reply
enum Pending {
    Call(ChannelKind, String, mpsc::Receiver<Reply>),
    Trigger(mpsc::Receiver<Reply>),
}

/// A trigger's outcome: the value, or `String(err)` of its rejection
fn trigger_answer(reply: Option<Reply>) -> Value {
    match reply {
        None => json!({ "timeout": true }),
        Some(Ok(value)) => {
            let (header, buffers) = wire::encode(&value);
            let buffers: Vec<String> = buffers.iter().map(|b| hex(b)).collect();
            json!({ "value": header, "buffers": buffers })
        }
        Some(Err(e)) => json!({ "error": e.to_string() }),
    }
}

/// Registers `batches` in order on the calling thread and keeps, of what
/// they send while they register, only what the batch `own` sends. The
/// TypeScript side loads only the module of the group's batch and keeps what
/// it sends while loading; what another batch sends while it registers (A's
/// hub load tells every window) belongs to no call. Only the registering
/// thread's own sends are dropped: a worker that sends meanwhile (one the
/// group's batch started) is kept. Without `own`, everything is kept.
fn register_keeping_own<F>(
    table: &mut Table,
    batches: impl IntoIterator<Item = (&'static str, F)>,
    own: Option<&str>,
    events: &Events,
) -> Result<(), RegisterError>
where
    F: FnOnce(&mut Table) -> Result<(), RegisterError>,
{
    for (name, register) in batches {
        let other = own.is_some_and(|own| own != name);
        if other {
            *events.muted.lock().unwrap() = Some(std::thread::current().id());
        }
        let registered = register(table);
        *events.muted.lock().unwrap() = None;
        registered?;
    }
    Ok(())
}

fn run_case(dir: &str, case: &Value) -> Result<Value, String> {
    let views = match case["views"].as_array() {
        Some(views) => views.iter().map(sender_of).collect::<Result<Vec<_>, _>>()?,
        None => vec![sender_of(&json!({ "view": 1, "window": 1 }))?],
    };
    let core = CoreThread::spawn("core");
    let ui = CoreThread::spawn("ui");
    let tracked = Arc::new(Tracked::default());
    let case_views = Arc::new(CaseViews(views.clone()));
    let recorder = Arc::new(Recorder {
        views: case_views.clone(),
        events: Events::default(),
    });
    let log: ProbeLog = Arc::default();
    let mut hosts = Hosts::default();
    hosts.insert(log.clone());
    let given = &case["hosts"];
    fakes::insert_shared(&mut hosts, &given["shared"], &views, &log);
    shell_ipc_u::probe_hosts(&mut hosts, &given["u"]);
    shell_ipc_a::probe_hosts(&mut hosts, &given["a"]);
    shell_ipc_m::probe_hosts(&mut hosts, &given["m"]);
    shell_ipc_w::probe_hosts(&mut hosts, &given["w"]);
    shell_ipc_d1::probe_hosts(&mut hosts, &given["d1"]);
    shell_ipc_d2::probe_hosts(&mut hosts, &given["d2"]);
    let services = Services {
        ui: ui.clone(),
        core: core.clone(),
        workers: Arc::new(CatchingWorkers(Arc::new(TrackedWorkers(tracked.clone())))),
        events: recorder.clone(),
        views: case_views,
        paths: Arc::new(CasePaths(PathBuf::from(dir))),
        hosts: Arc::new(hosts),
    };

    let trigger_services = services.clone();
    let own = case["batch"].as_str().map(str::to_owned);
    let registering = recorder.clone();
    let registered = run_on(core.as_ref(), move || {
        let mut table = Table::default();
        let services = &services;
        let batches = BATCH_NAMES
            .iter()
            .zip(BATCHES)
            .map(|(name, register)| (*name, move |table: &mut Table| register(table, services)));
        if let Err(e) =
            register_keeping_own(&mut table, batches, own.as_deref(), &registering.events)
        {
            return Some(format!("{:?}", StartError::Register(e)));
        }
        PROVIDED.with(|p| *p.borrow_mut() = Some(table.provided()));
        DISPATCHER.with(|d| *d.borrow_mut() = Some(Dispatcher::new(table)));
        None
    });
    if let Some(error) = registered {
        core.stop();
        ui.stop();
        return Ok(json!({ "register": error }));
    }

    let mut calls = Vec::new();
    // deferred invokes by the index of their call, until an `await` step takes them
    let mut deferred: HashMap<u64, Pending> = HashMap::new();
    for (i, call) in case["calls"].as_array().into_iter().flatten().enumerate() {
        if let Some(at) = call["await"].as_u64() {
            let answer = match deferred.remove(&at) {
                Some(Pending::Call(kind, channel, rx)) => {
                    answer(kind, &channel, rx.recv_timeout(CALL_TIMEOUT).ok())
                }
                Some(Pending::Trigger(rx)) => trigger_answer(rx.recv_timeout(CALL_TIMEOUT).ok()),
                None => json!({ "thrown": format!("no deferred call {at}") }),
            };
            let drained = drain(&core, &ui, &tracked);
            let mut out = json!({
                "answer": answer,
                "events": recorder.events.take(),
            });
            if !drained {
                out["undrained"] = json!(true);
            }
            calls.push(out);
            continue;
        }
        let channel = call["channel"].as_str().ok_or("a call without a channel")?;
        let view = call["view"].as_u64().unwrap_or(views[0].view.0 as u64) as u32;
        let sender = *views
            .iter()
            .find(|s| s.view.0 == view)
            .ok_or_else(|| format!("call {i}: no view {view}"))?;
        if call["kind"].as_str() == Some("trigger") {
            let services = trigger_services.clone();
            let name = call["name"].as_str().unwrap_or("").to_string();
            let unknown = format!("unknown trigger {name}");
            let args = call["args"].clone();
            let (tx, rx) = mpsc::channel::<Reply>();
            let known = run_on(core.as_ref(), move || {
                // answered on the core thread or later, after a timer, a
                // worker or a dialog: the reply goes through the channel
                let then: Then<IpcValue> = Box::new(move |r| {
                    let _ = tx.send(r);
                });
                PROVIDED.with(|p| {
                    let p = p.borrow();
                    let provided = p.as_ref().expect("the case's provided");
                    // one arm per batch crate that exports `probe_trigger`,
                    // matched on the name's prefix; the batch adds its own
                    match name.split_once('/').map(|(batch, _)| batch) {
                        Some("d1") => shell_ipc_d1::probe_trigger(
                            &name,
                            ViewId(view),
                            &args,
                            &services,
                            provided,
                            then,
                        ),
                        Some("a") => shell_ipc_a::probe_trigger(
                            &name,
                            ViewId(view),
                            &args,
                            &services,
                            provided,
                            then,
                        ),
                        Some("m") => shell_ipc_m::probe_trigger(
                            &name,
                            ViewId(view),
                            &args,
                            &services,
                            provided,
                            then,
                        ),
                        Some("w") => shell_ipc_w::projects::probe_trigger(
                            &name,
                            ViewId(view),
                            &args,
                            &services,
                            provided,
                            then,
                        ),
                        _ => false,
                    }
                })
            });
            let answer = if !known {
                json!({ "thrown": unknown })
            } else if call["defer"].as_bool() == Some(true) {
                deferred.insert(i as u64, Pending::Trigger(rx));
                json!({ "deferred": true })
            } else {
                trigger_answer(rx.recv_timeout(CALL_TIMEOUT).ok())
            };
            let drained = drain(&core, &ui, &tracked);
            let mut out = json!({
                "answer": answer,
                "events": recorder.events.take(),
            });
            if !drained {
                out["undrained"] = json!(true);
            }
            calls.push(out);
            continue;
        }
        let kind = kind_of(call["kind"].as_str().unwrap_or("invoke"))?;
        let buffers: Vec<Vec<u8>> = call["buffers"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|b| unhex(b.as_str().unwrap_or("")))
            .collect();
        let args =
            wire::decode_list(&call["args"], &buffers).map_err(|e| format!("call {i}: {e}"))?;
        let (tx, rx) = mpsc::channel();
        let name = channel.to_string();
        let request = (kind == ChannelKind::Invoke).then_some(RequestId(i as u64 + 1));
        core.post(Box::new(move || {
            DISPATCHER.with(|d| {
                let d = d.borrow();
                let d = d.as_ref().expect("the case's dispatcher");
                d.dispatch(
                    sender,
                    kind,
                    request,
                    &name,
                    args,
                    Box::new(move |r| {
                        let _ = tx.send(r);
                    }),
                );
            })
        }));
        let answer = if call["defer"].as_bool() == Some(true) {
            deferred.insert(i as u64, Pending::Call(kind, channel.to_string(), rx));
            json!({ "deferred": true })
        } else {
            answer(kind, channel, rx.recv_timeout(CALL_TIMEOUT).ok())
        };
        let drained = drain(&core, &ui, &tracked);
        let mut out = json!({
            "answer": answer,
            "events": recorder.events.take(),
        });
        if !drained {
            out["undrained"] = json!(true);
        }
        calls.push(out);
    }
    run_on(core.as_ref(), || {
        DISPATCHER.with(|d| drop(d.borrow_mut().take()));
        PROVIDED.with(|p| drop(p.borrow_mut().take()));
    });
    core.stop();
    ui.stop();
    let log = std::mem::take(&mut *log.lock().unwrap());
    Ok(json!({ "calls": calls, "log": log }))
}

/// Waits until the workers are idle and the core and UI queues hold nothing
/// they posted; false when that did not happen in time
fn drain(core: &CoreThread, ui: &CoreThread, tracked: &Tracked) -> bool {
    let until = Instant::now() + CALL_TIMEOUT;
    loop {
        if !tracked.wait_idle(until) {
            return false;
        }
        let spawned = tracked.spawned.load(Ordering::SeqCst);
        run_on(ui, || ());
        run_on(core, || ());
        if *tracked.active.lock().unwrap() == 0 && tracked.spawned.load(Ordering::SeqCst) == spawned
        {
            return true;
        }
    }
}

// The probe runs on the developers' machines and the runners: batch A's
// safeStorage must never reach the person's login keychain or DPAPI key here
// (`feature = "probe"` compiles its OS key store out)
const _: () = assert!(!shell_ipc_a::secrets::OS_KEY_STORE);

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.expect("reading stdin");
        if line.trim().is_empty() {
            continue;
        }
        let out = match serde_json::from_str::<Value>(&line) {
            Ok(request) => {
                let dir = request["dir"].as_str().unwrap_or(".").to_string();
                run_case(&dir, &request["case"]).unwrap_or_else(|e| json!({ "bad": e }))
            }
            Err(e) => json!({ "bad": e.to_string() }),
        };
        writeln!(stdout, "{out}").expect("writing stdout");
        stdout.flush().expect("writing stdout");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sent(channel: &str) -> Value {
        json!({ "view": 1, "channel": channel })
    }

    fn channels(events: &Events) -> Vec<String> {
        events
            .list
            .lock()
            .unwrap()
            .iter()
            .map(|e| e["channel"].as_str().unwrap().to_owned())
            .collect()
    }

    /// A batch whose registration sends `channels`
    fn sending<'a>(
        events: &'a Events,
        channels: &'a [&'a str],
    ) -> impl FnOnce(&mut Table) -> Result<(), RegisterError> + 'a {
        move |_| {
            for channel in channels {
                events.push(sent(channel));
            }
            Ok(())
        }
    }

    #[test]
    fn only_the_groups_own_batch_keeps_what_it_sends_while_registering() {
        let events = Events::default();
        let batches = [
            ("A", sending(&events, &["mcp-tools:changed"])),
            // W's quick-look sends M's channel: the sender's batch counts, not the channel's
            (
                "W",
                sending(
                    &events,
                    &["quick-look:will-show", "quick-look:theme-changed"],
                ),
            ),
            ("M", sending(&events, &["home:open-settings"])),
        ];
        register_keeping_own(&mut Table::default(), batches, Some("W"), &events).unwrap();
        assert_eq!(
            channels(&events),
            ["quick-look:will-show", "quick-look:theme-changed"]
        );
        // what another batch sends once every batch registered is a call's
        events.push(sent("mcp-tools:changed"));
        assert_eq!(channels(&events).last().unwrap(), "mcp-tools:changed");
    }

    #[test]
    fn without_a_batch_everything_is_kept() {
        let events = Events::default();
        let batches = [
            ("A", sending(&events, &["mcp-tools:changed"])),
            ("W", sending(&events, &["quick-look:will-show"])),
        ];
        register_keeping_own(&mut Table::default(), batches, None, &events).unwrap();
        assert_eq!(
            channels(&events),
            ["mcp-tools:changed", "quick-look:will-show"]
        );
    }

    type Register<'a> = dyn FnOnce(&mut Table) -> Result<(), RegisterError> + 'a;

    #[test]
    fn a_worker_sending_while_another_batch_registers_is_kept() {
        let events = Events::default();
        // A's drive port started a worker at A's registration; it reports
        // while M registers, and M's own registration send is still dropped
        let batches: [(&str, Box<Register<'_>>); 2] = [
            ("A", Box::new(|_| Ok(()))),
            (
                "M",
                Box::new(|_| {
                    events.push(sent("home:open-settings"));
                    std::thread::scope(|s| {
                        s.spawn(|| events.push(sent("drive:state-changed")));
                    });
                    Ok(())
                }),
            ),
        ];
        register_keeping_own(&mut Table::default(), batches, Some("A"), &events).unwrap();
        assert_eq!(channels(&events), ["drive:state-changed"]);
    }
}
