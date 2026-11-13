//! Fakes for the tests of the MCP port: the core thread is the test's own
//! thread (jobs posted to it run while the test [pumps](Rig::pump_until), so
//! what an actor posts back is seen where the port lives), views a test
//! destroys on demand, an MCP server behind [`McpNet`], and the hosts of the
//! shell entry.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::ThreadId;
use std::time::{Duration, Instant};

use jscompat::JsonValue;
use main_core::packages::ai_provider::settings_secrets::CodecThrow;
use main_core::packages::i18n::Lang;
use main_core::packages::mcp_sdk::client::OutputCheck;
use main_core::packages::mcp_sdk::client::net::{FetchError, FetchInit, Headers};
use main_core::shell::ai_secrets::SafeStorageLike;
use shell_contract::hosts::{Hosts, MainWindow, MainWindowHost, OsShell, OsShellHost};
use shell_contract::ipc::{CallContext, EventSink, Reply, Responder, Sender, Target};
use shell_contract::runtime::{AppPaths, CancelToken, PathName, Services, Thread, Views, Workers};
use shell_contract::{IpcValue, Surface, ViewId, WindowId};

use super::net::{McpNet, McpShell, NetBody, NetResponse};
use super::{McpNetHost, McpSafeStorage, McpShellHost};
use crate::shell_ai_prefs::{ShellUi, ShellUiHost};

type Job = Box<dyn FnOnce() + Send>;

/// The test's thread as the core thread: jobs wait in a queue until it pumps
pub struct TestCore {
    queue: Arc<(Mutex<VecDeque<Job>>, Condvar)>,
    thread: ThreadId,
}

impl Thread for TestCore {
    fn post(&self, job: Job) {
        let (queue, wake) = &*self.queue;
        queue.lock().unwrap().push_back(job);
        wake.notify_all();
    }

    fn is_current(&self) -> bool {
        std::thread::current().id() == self.thread
    }
}

impl TestCore {
    /// Runs queued jobs until `until` holds; false when `ms` passed first
    pub fn pump_until(&self, ms: u64, mut until: impl FnMut() -> bool) -> bool {
        let end = Instant::now() + Duration::from_millis(ms);
        let (queue, wake) = &*self.queue;
        loop {
            loop {
                let job = queue.lock().unwrap().pop_front();
                match job {
                    Some(job) => job(),
                    None => break,
                }
            }
            if until() {
                return true;
            }
            let now = Instant::now();
            if now >= end {
                return false;
            }
            let guard = queue.lock().unwrap();
            if guard.is_empty() {
                let _ = wake
                    .wait_timeout(guard, (end - now).min(Duration::from_millis(20)))
                    .unwrap();
            }
        }
    }
}

struct Spawn;

impl Workers for Spawn {
    fn spawn(&self, job: Job) {
        std::thread::spawn(job);
    }
}

#[derive(Default)]
pub struct Events(pub Mutex<Vec<(Target, &'static str, Vec<IpcValue>)>>);

impl EventSink for Events {
    fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
        self.0.lock().unwrap().push((target, channel, args));
    }
}

type Listener = Box<dyn Fn(ViewId) + Send + Sync>;

#[derive(Default)]
struct TestViews {
    alive: Mutex<Vec<u32>>,
    listeners: Mutex<Vec<Listener>>,
}

impl Views for TestViews {
    fn sender_of(&self, view: ViewId) -> Option<Sender> {
        self.alive
            .lock()
            .unwrap()
            .contains(&view.0)
            .then_some(Sender {
                view,
                window: WindowId(1),
                surface: Surface::Docs,
            })
    }

    fn all(&self) -> Vec<Sender> {
        self.alive
            .lock()
            .unwrap()
            .iter()
            .map(|v| Sender {
                view: ViewId(*v),
                window: WindowId(1),
                surface: Surface::Docs,
            })
            .collect()
    }

    fn on_destroyed(&self, listener: Listener) {
        self.listeners.lock().unwrap().push(listener);
    }
}

struct Dir(PathBuf);

impl AppPaths for Dir {
    fn path(&self, name: PathName) -> PathBuf {
        match name {
            PathName::Temp => self.0.join("temp"),
            PathName::UserData => self.0.join("userData"),
            _ => self.0.clone(),
        }
    }
}

pub struct Rig {
    pub services: Services,
    pub core: Arc<TestCore>,
    pub dir: PathBuf,
    events: Arc<Events>,
    views: Arc<TestViews>,
}

static RIGS: AtomicU64 = AtomicU64::new(0);

impl Rig {
    pub fn new(views: &[u32]) -> Rig {
        Rig::with_hosts(views, |_| {})
    }

    pub fn with_hosts(views: &[u32], hosts: impl FnOnce(&mut Hosts)) -> Rig {
        let n = RIGS.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("shell-a-mcp-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("userData")).unwrap();
        std::fs::create_dir_all(dir.join("temp")).unwrap();
        let core = Arc::new(TestCore {
            queue: Arc::default(),
            thread: std::thread::current().id(),
        });
        let events = Arc::new(Events::default());
        let test_views = Arc::new(TestViews::default());
        *test_views.alive.lock().unwrap() = views.to_vec();
        let mut table = Hosts::default();
        hosts(&mut table);
        let services = Services {
            ui: core.clone(),
            core: core.clone(),
            workers: Arc::new(Spawn),
            events: events.clone(),
            views: test_views.clone(),
            paths: Arc::new(Dir(dir.clone())),
            hosts: Arc::new(table),
        };
        Rig {
            services,
            core,
            dir,
            events,
            views: test_views,
        }
    }

    /// The events emitted since the last call
    pub fn events(&self) -> Vec<(Target, &'static str, Vec<IpcValue>)> {
        std::mem::take(&mut *self.events.0.lock().unwrap())
    }

    pub fn responder(&self) -> (Responder, Arc<Mutex<Option<Reply>>>) {
        let slot = Arc::new(Mutex::new(None));
        let out = slot.clone();
        (
            Responder::new(move |r| *out.lock().unwrap() = Some(r)),
            slot,
        )
    }

    /// A view goes away: the listeners the ports gave `Views::on_destroyed` run
    pub fn destroy_view(&self, view: u32) {
        self.views.alive.lock().unwrap().retain(|v| *v != view);
        let listeners = self.views.listeners.lock().unwrap();
        for listener in listeners.iter() {
            listener(ViewId(view));
        }
    }

    pub fn pump_until(&self, ms: u64, until: impl FnMut() -> bool) -> bool {
        self.core.pump_until(ms, until)
    }
}

pub fn call_cx(sender: Sender) -> CallContext {
    CallContext {
        sender,
        request: None,
        cancel: CancelToken::default(),
    }
}

pub fn obj(entries: &[(&str, IpcValue)]) -> IpcValue {
    IpcValue::Object(
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
    )
}

pub fn s(text: &str) -> IpcValue {
    IpcValue::String(text.to_owned())
}

// ---- the shell entry's hosts ------------------------------------------------

pub struct Shell;

impl McpShell for Shell {
    fn lang(&self) -> Lang {
        Lang::En
    }

    fn app_version(&self) -> String {
        "9.9.9".to_owned()
    }
}

pub struct Window(pub Option<ViewId>);

impl MainWindow for Window {
    fn view(&self) -> Option<ViewId> {
        self.0
    }

    fn window(&self) -> Option<WindowId> {
        self.0.map(|_| WindowId(1))
    }
}

#[derive(Default)]
pub struct Os(pub Mutex<Vec<String>>);

impl OsShell for Os {
    fn open_external(&self, url: &str) -> Result<(), String> {
        self.0.lock().unwrap().push(url.to_owned());
        Ok(())
    }
    fn open_path(&self, _: &std::path::Path) -> String {
        String::new()
    }
    fn show_item_in_folder(&self, _: &std::path::Path) {}
    fn trash_item(&self, _: &std::path::Path) -> Result<(), String> {
        Ok(())
    }
}

#[derive(Default)]
pub struct Ui(pub Mutex<u32>);

impl ShellUi for Ui {
    fn document_locale(&self) -> String {
        "en".to_owned()
    }
    fn show_home_tab(&self) {
        *self.0.lock().unwrap() += 1;
    }
}

/// `safeStorage` with a reversible byte transform
pub struct Storage;

impl SafeStorageLike for Storage {
    fn is_encryption_available(&self) -> bool {
        true
    }
    fn encrypt_string(&self, plain: &str) -> Result<Vec<u8>, CodecThrow> {
        Ok(plain.bytes().map(|b| b ^ 0x5a).collect())
    }
    fn decrypt_string(&self, sealed: &[u8]) -> Result<String, CodecThrow> {
        Ok(
            String::from_utf8_lossy(&sealed.iter().map(|b| b ^ 0x5a).collect::<Vec<_>>())
                .into_owned(),
        )
    }
    fn get_selected_storage_backend(&self) -> Option<String> {
        Some("gnome_libsecret".to_owned())
    }
}

// ---- an MCP server behind the network ------------------------------------------

struct Once(Option<Vec<u8>>);

impl NetBody for Once {
    fn next_chunk(&mut self) -> Result<Option<Vec<u8>>, FetchError> {
        Ok(self.0.take())
    }
}

/// A streamable HTTP MCP server with the given tools (name, description); it
/// remembers the methods it was asked
pub struct ServerNet {
    pub tools: Vec<(String, String)>,
    pub seen: Mutex<Vec<String>>,
}

impl ServerNet {
    pub fn new(tools: &[(&str, &str)]) -> Arc<ServerNet> {
        Arc::new(ServerNet {
            tools: tools
                .iter()
                .map(|(n, d)| (n.to_string(), d.to_string()))
                .collect(),
            seen: Mutex::default(),
        })
    }

    fn json(status: u16, headers: &[(&str, &str)], body: serde_json::Value) -> NetResponse {
        let mut h = Headers::new();
        h.set("content-type", "application/json");
        for (k, v) in headers {
            h.set(k, v);
        }
        NetResponse {
            status,
            status_text: String::new(),
            headers: h,
            url: String::new(),
            redirected: false,
            opaque_redirect: false,
            body: Some(Box::new(Once(Some(serde_json::to_vec(&body).unwrap())))),
        }
    }

    fn empty(status: u16) -> NetResponse {
        NetResponse {
            status,
            status_text: String::new(),
            headers: Headers::new(),
            url: String::new(),
            redirected: false,
            opaque_redirect: false,
            body: None,
        }
    }
}

impl McpNet for ServerNet {
    fn fetch(
        &self,
        _url: &str,
        init: &FetchInit,
        _limit: Option<f64>,
    ) -> Result<NetResponse, FetchError> {
        match init.method.as_deref().unwrap_or("GET") {
            "POST" => {
                let body: serde_json::Value =
                    serde_json::from_str(init.body.as_deref().unwrap_or("{}")).unwrap();
                let method = body["method"].as_str().unwrap_or("").to_owned();
                self.seen.lock().unwrap().push(method.clone());
                let id = body["id"].clone();
                let result = match method.as_str() {
                    "initialize" => serde_json::json!({
                        "protocolVersion": body["params"]["protocolVersion"],
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "fake", "version": "1"},
                        "instructions": "Use the fake tools."
                    }),
                    "tools/list" => serde_json::json!({
                        "tools": self.tools.iter().map(|(n, d)| serde_json::json!({
                            "name": n,
                            "description": d,
                            "inputSchema": {"type": "object", "properties": {}}
                        })).collect::<Vec<_>>()
                    }),
                    "tools/call" => serde_json::json!({
                        "content": [{"type": "text", "text": format!("called {}", body["params"]["name"].as_str().unwrap_or(""))}]
                    }),
                    _ => return Ok(ServerNet::empty(202)),
                };
                let session = [("mcp-session-id", "session-1")];
                Ok(ServerNet::json(
                    200,
                    if method == "initialize" {
                        &session
                    } else {
                        &[]
                    },
                    serde_json::json!({"jsonrpc": "2.0", "id": id, "result": result}),
                ))
            }
            "DELETE" => Ok(ServerNet::empty(200)),
            _ => Ok(ServerNet::empty(405)),
        }
    }

    fn compile_output_schema(&self, _schema: &JsonValue) -> Result<u64, String> {
        Ok(1)
    }

    fn validate_output(&self, _validator: u64, _value: &JsonValue) -> OutputCheck {
        OutputCheck::Valid
    }
}

/// Every host the hub port needs, on a rig: the shell window is `shell`
pub fn hub_hosts(
    net: Arc<dyn McpNet>,
    shell: Option<u32>,
) -> (impl FnOnce(&mut Hosts), Arc<Os>, Arc<Ui>) {
    let os = Arc::new(Os::default());
    let ui = Arc::new(Ui::default());
    let (os_out, ui_out) = (os.clone(), ui.clone());
    let install = move |hosts: &mut Hosts| {
        hosts.insert::<McpNetHost>(net);
        hosts.insert::<McpShellHost>(Arc::new(Shell));
        hosts.insert::<OsShellHost>(os);
        hosts.insert::<MainWindowHost>(Arc::new(Window(shell.map(ViewId))));
        hosts.insert::<ShellUiHost>(ui);
        hosts.insert::<McpSafeStorage>(Arc::new(Storage));
    };
    (install, os_out, ui_out)
}
