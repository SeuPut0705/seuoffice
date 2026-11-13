//! `apps/shell/src/main/mcp-client/hub-app.ts` and `hub-ipc.ts`: the person's
//! own MCP servers in the running app. The hub is main-core's sans-IO
//! [`McpHub`]; this module is the app around it:
//!
//! - the channels (`mcp-servers:*` for Settings, `mcp-tools:*` for every AI
//!   window) are [`McpHubIpc`]'s handler bodies; a handler that awaits the
//!   hub answers later, when [`Hub::pump`] sees the hub settle its ticket;
//! - the connections are threads ([`actor`]): [`remote`] drives a remote
//!   server over the batch's [`net::McpNet`], [`local`] runs a program of the
//!   person's PC. The core thread never waits on one;
//! - `answerRuntimeDownload` downloads a runtime, which takes minutes, on a
//!   worker; its handler answers when the worker is done ([`Hub::finish_download`]);
//! - the secrets of the store seal with `safeStorage` ([`crate::secrets`]).
//!
//! [`bridges`] is the other port of this area: the docs and sheets editors'
//! MCP bridges.
//!
//! Not wired by this module: the hub's `stopAll()` at quit. The shell tells
//! the connections to end by dropping the port; a program a connection started
//! is ended when its connection's thread ends (the app's own exit ends the
//! threads, not the programs: the shell's quit path should drop the port).

pub mod actor;
pub mod bridges;
mod kit;
mod local;
pub mod net;
mod remote;
#[cfg(test)]
mod testing;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

use jscompat::{JsObject, JsonValue};
use main_core::node_fs::NodeError;
use main_core::packages::i18n::Lang;
use main_core::shell::ai_secrets::SafeStorageLike;
use main_core::shell::mcp_client::hub::{
    ConnId, ConnOutcome, LocalConnection, LocalState, McpHub, McpHubHost, OpId, RemoteConnection,
    SharedStore, Ticket,
};
use main_core::shell::mcp_client::hub_ipc::{
    IpcReply, IpcValue as HubValue, McpHubIpc, McpHubIpcHost,
};
use main_core::shell::mcp_client::local_launch::{
    LaunchServer, McpRuntimeId, McpRuntimeKit, PlanOptions, PlannedLaunch, ResolveOptions,
    RuntimeResolution, planned_launch,
};
use main_core::shell::mcp_client::oauth::{McpOAuthAccess, shared_store_oauth_access};
use main_core::shell::mcp_client::runtimes::{McpRuntimeKitOptions, RuntimeKit, mcp_runtimes_root};
use main_core::shell::mcp_client::secrets::SafeStorageMcpCodec;
use main_core::shell::mcp_client::store::{
    McpOAuthConfig, McpServerConfig, create_mcp_servers_store, mcp_servers_file_path,
};
use main_core::shell::mcp_servers_api::MCP_SERVERS_CHANNELS;
use shell_contract::hosts::{MainWindowHost, OsShellHost};
use shell_contract::ipc::{CallContext, Responder, Target};
use shell_contract::runtime::{PathName, Services};
use shell_contract::{IpcError, IpcValue, ViewId};

pub use bridges::{BridgesPort, McpBridgeControl, McpTabs, McpTabsHost};
pub use net::{McpNet, McpNetHost, McpShell, McpShellHost, NetBody, NetResponse};

use self::actor::CoreLink;
use self::kit::KitHost;
use self::local::{LocalProxy, LocalWorldDeps};
use self::remote::{RemoteProxy, RemoteWorldDeps, open_in_browser};
use crate::ports::McpHub as McpHubPorts;
use crate::shell_ai_prefs::ShellUiHost;
use crate::value::{arg, from_json};

/// `safeStorage` as the store's codec reads it: the host the shell inserts
/// ([`crate::secrets::SafeStorageHost`]) behind the trait, so a probe can put
/// a stand-in in its place
pub type McpSafeStorage = Arc<dyn SafeStorageLike + Send + Sync>;

struct StorageAdapter(McpSafeStorage);

impl SafeStorageLike for StorageAdapter {
    fn is_encryption_available(&self) -> bool {
        self.0.is_encryption_available()
    }

    fn encrypt_string(
        &self,
        plain: &str,
    ) -> Result<Vec<u8>, main_core::packages::ai_provider::settings_secrets::CodecThrow> {
        self.0.encrypt_string(plain)
    }

    fn decrypt_string(
        &self,
        sealed: &[u8],
    ) -> Result<String, main_core::packages::ai_provider::settings_secrets::CodecThrow> {
        self.0.decrypt_string(sealed)
    }

    fn get_selected_storage_backend(&self) -> Option<String> {
        self.0.get_selected_storage_backend()
    }
}

/// `HOME_CHANNELS.openSettings`
const HOME_OPEN_SETTINGS: &str = "home:open-settings";

fn channel_named(table: &[(&'static str, &'static str)], key: &str) -> &'static str {
    table
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, name)| *name)
        .unwrap_or_default()
}

fn reject(error: NodeError) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: error.message,
    }
}

/// What a hub handler answers: `None` is `undefined`, an `Err` a rejection
fn answer(value: HubValue) -> Result<IpcValue, IpcError> {
    value
        .map(|v| v.map_or(IpcValue::Undefined, |v| from_json(&v)))
        .map_err(reject)
}

/// What the hub and its hosts share: the app's side of `startMcpHub`
struct Env {
    id: u64,
    services: Services,
    net: McpNetHost,
    shell: McpShellHost,
    os_shell: OsShellHost,
    main_window: MainWindowHost,
    ui: ShellUiHost,
    store: SharedStore<'static>,
    /// the local connections, to tell one to try again once its runtime is there
    locals: RefCell<Vec<(ConnId, String, Sender<local::Msg>)>>,
    /// runtime downloads begun, and the last one's number
    begun_downloads: Cell<u64>,
}

impl Env {
    fn link(&self) -> CoreLink {
        CoreLink {
            core: self.services.core.clone(),
            hub: self.id,
        }
    }

    fn user_data(&self) -> String {
        self.services
            .paths
            .path(PathName::UserData)
            .to_string_lossy()
            .into_owned()
    }

    fn temp(&self) -> String {
        self.services
            .paths
            .path(PathName::Temp)
            .to_string_lossy()
            .into_owned()
    }

    fn with_kit<R>(&self, run: impl FnOnce(&RuntimeKit<'_>) -> R) -> R {
        let host = KitHost::core(self.net.clone(), self.store.clone());
        let kit = RuntimeKit::new(
            McpRuntimeKitOptions {
                runtimes_root: mcp_runtimes_root(&self.user_data()),
                ..Default::default()
            },
            &host,
        );
        run(&kit)
    }

    /// `shellContents()`: the shell window's view
    fn shell_view(&self) -> Option<ViewId> {
        self.main_window.view()
    }
}

/// The hub's deps in the running app (`startMcpHub`)
struct HubHost {
    env: Rc<Env>,
}

/// The runtime kit's `resolveCommand` for a download: it never blocks the
/// core thread; the worker does the download, and the handler waiting for it
/// answers when the worker is done
fn begin_download(env: &Env, command: &str) {
    static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());
    let number = env.begun_downloads.get() + 1;
    env.begun_downloads.set(number);
    let net = env.net.clone();
    let link = env.link();
    let root = mcp_runtimes_root(&env.user_data());
    let command = command.to_owned();
    env.services.workers.spawn(Box::new(move || {
        {
            // the kit's queue: one question and one download at a time
            let _turn = ONE_AT_A_TIME.lock().unwrap_or_else(|p| p.into_inner());
            let host = KitHost::worker(net, link.clone());
            let kit = RuntimeKit::new(
                McpRuntimeKitOptions {
                    runtimes_root: root,
                    ..Default::default()
                },
                &host,
            );
            let _ = kit.resolve_command(
                &command,
                &ResolveOptions {
                    offer_download: true,
                },
            );
        }
        link.post(move |hub| hub.finish_download(number));
    }));
}

impl McpHubHost<'static> for HubHost {
    fn remote(
        &self,
        conn: ConnId,
        server: &McpServerConfig,
        _store: &SharedStore<'static>,
    ) -> Box<dyn RemoteConnection<'static> + 'static> {
        let env = &self.env;
        Box::new(RemoteProxy::spawn(
            conn,
            server,
            &env.shell.app_version(),
            RemoteWorldDeps {
                net: env.net.clone(),
                os_shell: env.os_shell.clone(),
                link: env.link(),
            },
        ))
    }

    fn local(&self, conn: ConnId, server: &McpServerConfig) -> Box<dyn LocalConnection + 'static> {
        let env = &self.env;
        let proxy = LocalProxy::spawn(
            conn,
            server,
            LocalWorldDeps {
                net: env.net.clone(),
                link: env.link(),
                temp_dir: env.temp(),
                user_data_dir: env.user_data(),
                client_version: env.shell.app_version(),
            },
        );
        env.locals
            .borrow_mut()
            .push((conn, server.id.clone(), proxy.retrier()));
        Box::new(proxy)
    }

    fn resolve_command(&self, command: &str, options: &ResolveOptions) -> RuntimeResolution {
        let env = &self.env;
        if options.offer_download {
            begin_download(env, command);
        }
        // what a look finds now; a download waits for the worker
        env.with_kit(|kit| {
            kit.resolve_command(
                command,
                &ResolveOptions {
                    offer_download: false,
                },
            )
        })
    }

    fn planned_launch(&self, server: &McpServerConfig) -> PlannedLaunch {
        let launch = LaunchServer {
            command: server.command.clone(),
            args: server.args.clone(),
            env: server.env.clone(),
        };
        self.env.with_kit(|kit| {
            planned_launch(&launch, kit as &dyn McpRuntimeKit, &PlanOptions::default())
        })
    }

    fn lang(&self) -> Lang {
        self.env.shell.lang()
    }

    fn open_external(&self, url: &str) -> bool {
        open_in_browser(&self.env.os_shell, url)
    }

    /// `openSettings(serverId)`: Settings > Integrations, on that server
    fn open_settings(&self, server_id: &str) {
        let env = &self.env;
        if let Some(view) = env.shell_view() {
            env.ui.show_home_tab();
            let mut section = JsObject::new();
            section.set("section", JsonValue::String("integrations".into()));
            env.services.events.emit(
                Target::View(view),
                HOME_OPEN_SETTINGS,
                vec![from_json(&JsonValue::Object(section))],
            );
            env.services.events.emit(
                Target::View(view),
                channel_named(&MCP_SERVERS_CHANNELS, "openServer"),
                vec![IpcValue::String(server_id.to_owned())],
            );
        }
    }

    fn now_ms(&self) -> f64 {
        remote::now_ms()
    }
}

/// The window parts of `registerMcpHubIpc`'s deps
struct IpcHost<'a> {
    env: &'a Env,
}

impl McpHubIpcHost for IpcHost<'_> {
    fn is_settings_sender(&mut self, sender_id: f64) -> bool {
        self.env
            .shell_view()
            .is_some_and(|view| f64::from(view.0) == sender_id)
    }

    /// the views' destruction is listened to for every sender
    fn watch_destroyed(&mut self, _sender_id: f64) -> bool {
        true
    }

    fn broadcast_tools_changed(&mut self) {
        self.env.services.events.emit(
            Target::All,
            channel_named(
                &main_core::packages::electron_utils::mcp_tools_channels::MCP_TOOLS_CHANNELS,
                "changed",
            ),
            Vec::new(),
        );
    }

    fn settings_window_open(&mut self) -> bool {
        self.env.shell_view().is_some()
    }

    fn send_settings_changed(&mut self, view: &JsonValue) {
        if let Some(shell) = self.env.shell_view() {
            self.env.services.events.emit(
                Target::View(shell),
                channel_named(&MCP_SERVERS_CHANNELS, "changed"),
                vec![from_json(view)],
            );
        }
    }
}

/// An `answerRuntimeDownload` waiting for its worker
struct Download {
    number: u64,
    server_id: String,
    reply: Responder,
}

thread_local! {
    static HUBS: RefCell<HashMap<u64, Weak<Hub>>> = RefCell::new(HashMap::new());
}

/// Runs `job` with the hub registered under `id`; the core thread's way to a
/// hub for what a thread posts
pub(crate) fn with_hub<R>(id: u64, job: impl FnOnce(&Hub) -> R) -> Option<R> {
    let found = HUBS.with(|all| all.borrow().get(&id).and_then(Weak::upgrade));
    found.map(|hub| job(&hub))
}

/// The hub, its channels' state and what the connections report; core thread only
pub struct Hub {
    env: Rc<Env>,
    ipc: RefCell<McpHubIpc<'static>>,
    /// the handlers waiting on the hub, by ticket
    pending: RefCell<HashMap<Ticket, Responder>>,
    downloads: RefCell<Vec<Download>>,
}

impl Hub {
    /// Tells the windows of what changed and answers the handlers whose
    /// tickets the hub settled, until nothing is left to tell
    fn pump(&self) {
        loop {
            let settled = self.ipc.borrow_mut().take_settled();
            let changed = self.ipc.borrow_mut().take_changed();
            let quiet = settled.is_empty() && !changed;
            for (ticket, value) in settled {
                let reply = self.pending.borrow_mut().remove(&ticket);
                if let Some(reply) = reply {
                    reply.reply(answer(value));
                }
            }
            if changed {
                let mut host = IpcHost { env: &self.env };
                self.ipc.borrow_mut().on_changed(&mut host);
            }
            if quiet {
                return;
            }
        }
    }

    fn finish(&self, outcome: IpcReply, reply: Responder) {
        match outcome {
            IpcReply::Now(value) => {
                self.pump();
                reply.reply(answer(value));
            }
            IpcReply::Later(ticket) => {
                self.pending.borrow_mut().insert(ticket, reply);
                self.pump();
            }
        }
    }

    /// An operation of a remote connection settled, or its tools changed
    pub(crate) fn connection_reported(
        &self,
        conn: ConnId,
        settled: Vec<(OpId, ConnOutcome)>,
        tools_changed: bool,
    ) {
        {
            let mut ipc = self.ipc.borrow_mut();
            for (op, outcome) in settled {
                ipc.hub.on_settled(op, outcome);
            }
            if tools_changed {
                ipc.hub.on_tools_changed(conn);
            }
        }
        self.pump();
    }

    /// What a local connection did in one step, in the order the hub hears it
    pub(crate) fn local_reported(
        &self,
        conn: ConnId,
        settled: Vec<(OpId, ConnOutcome)>,
        states: Vec<LocalState>,
        tools_changed: bool,
    ) {
        {
            let mut ipc = self.ipc.borrow_mut();
            for state in &states {
                ipc.hub.on_local_state_changed(conn, state);
            }
            for (op, outcome) in settled {
                ipc.hub.on_settled(op, outcome);
            }
            if tools_changed {
                ipc.hub.on_tools_changed(conn);
            }
        }
        self.pump();
    }

    /// `sender.once('destroyed', ...)`
    fn sender_destroyed(&self, view: ViewId) {
        self.ipc.borrow_mut().sender_destroyed(f64::from(view.0));
        self.pump();
    }

    /// `storeOAuthAccess(store, id).read()`
    pub(crate) fn oauth_read(&self, id: &str) -> Option<McpOAuthConfig> {
        shared_store_oauth_access(&self.env.store, id).read()
    }

    /// `storeOAuthAccess(store, id).writeTokens(tokens)`
    pub(crate) fn oauth_write(&self, id: &str, tokens: &str) -> Result<(), String> {
        shared_store_oauth_access(&self.env.store, id).write_tokens(tokens)
    }

    /// `isRuntimeAllowed(id)`
    pub(crate) fn runtime_allowed(&self, id: McpRuntimeId) -> bool {
        main_core::shell::mcp_client::hub_app::is_runtime_allowed(&self.env.store, id)
    }

    /// `recordRuntimeAllowed(id)`
    pub(crate) fn record_runtime_allowed(&self, id: McpRuntimeId) -> Result<(), String> {
        main_core::shell::mcp_client::hub_app::record_runtime_allowed(&self.env.store, id)
            .map_err(|e| e.message)
    }

    /// The worker of download `number` is done: the server's connection tries
    /// again, the windows are told, and the handler that asked answers with
    /// the plan as it stands now
    fn finish_download(&self, number: u64) {
        let waiting = {
            let mut downloads = self.downloads.borrow_mut();
            downloads
                .iter()
                .position(|d| d.number == number)
                .map(|at| downloads.remove(at))
        };
        let Some(waiting) = waiting else { return };
        for (_, server, retry) in self.env.locals.borrow().iter() {
            if *server == waiting.server_id {
                let _ = retry.send(local::Msg::Retry);
            }
        }
        let plan = self.ipc.borrow().hub.planned_launch(&waiting.server_id);
        let mut host = IpcHost { env: &self.env };
        self.ipc.borrow_mut().on_changed(&mut host);
        self.pump();
        waiting.reply.reply(Ok(from_json(&plan)));
    }
}

/// The handlers of `registerMcpHubIpc`
pub struct McpHubPort {
    hub: Rc<Hub>,
}

type Args = Vec<IpcValue>;

impl McpHubPort {
    pub fn new(
        services: &Services,
        net: McpNetHost,
        shell: McpShellHost,
        os_shell: OsShellHost,
        main_window: MainWindowHost,
        ui: ShellUiHost,
        storage: McpSafeStorage,
    ) -> Rc<McpHubPort> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let user_data = services.paths.path(PathName::UserData);
        let codec = SafeStorageMcpCodec {
            storage: Rc::new(StorageAdapter(storage)),
            platform: crate::secrets::PLATFORM.to_owned(),
        };
        let store: SharedStore<'static> = Rc::new(RefCell::new(create_mcp_servers_store(
            &mcp_servers_file_path(&user_data.to_string_lossy()),
            Rc::new(codec),
        )));
        let env = Rc::new(Env {
            id,
            services: services.clone(),
            net,
            shell,
            os_shell,
            main_window,
            ui,
            store: store.clone(),
            locals: RefCell::new(Vec::new()),
            begun_downloads: Cell::new(0),
        });
        let hub = McpHub::new(Rc::new(HubHost { env: env.clone() }), store);
        let hub = Rc::new(Hub {
            env,
            ipc: RefCell::new(McpHubIpc::new(hub)),
            pending: RefCell::new(HashMap::new()),
            downloads: RefCell::new(Vec::new()),
        });
        HUBS.with(|all| all.borrow_mut().insert(id, Rc::downgrade(&hub)));
        services.views.on_destroyed(Box::new(move |view| {
            with_hub(id, |hub| hub.sender_destroyed(view));
        }));
        // `void hub.load()`
        hub.ipc.borrow_mut().hub.load();
        hub.pump();
        Rc::new(McpHubPort { hub })
    }

    /// Runs one handler body of [`McpHubIpc`] and answers with what it returns
    fn run(
        &self,
        reply: Responder,
        body: impl FnOnce(&mut McpHubIpc<'static>, &mut IpcHost<'_>) -> IpcReply,
    ) {
        let outcome = {
            let mut host = IpcHost { env: &self.hub.env };
            let mut ipc = self.hub.ipc.borrow_mut();
            body(&mut ipc, &mut host)
        };
        self.hub.finish(outcome, reply);
    }

    /// A handler that returns a value at once
    fn plain(&self, reply: Responder, body: impl FnOnce(&mut McpHubIpc<'static>) -> JsonValue) {
        let value = body(&mut self.hub.ipc.borrow_mut());
        self.hub.pump();
        reply.reply(Ok(from_json(&value)));
    }
}

fn sender(cx: &CallContext) -> f64 {
    f64::from(cx.sender.view.0)
}

impl McpHubPorts for McpHubPort {
    fn mcp_servers_add(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.run(reply, |ipc, host| ipc.servers_add(host, id, a0.as_ref()));
    }

    fn mcp_servers_answer_runtime_download(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0, a1) = (sender(cx), arg(&args, 0), arg(&args, 1));
        let before = self.hub.env.begun_downloads.get();
        let outcome = {
            let mut host = IpcHost { env: &self.hub.env };
            let mut ipc = self.hub.ipc.borrow_mut();
            ipc.servers_answer_runtime_download(&mut host, id, a0.as_ref(), a1.as_ref())
        };
        let begun = self.hub.env.begun_downloads.get();
        if begun != before
            && let Some(JsonValue::String(server_id)) = a0
        {
            // the download runs on a worker: the answer is the plan once it is there
            self.hub.downloads.borrow_mut().push(Download {
                number: begun,
                server_id,
                reply,
            });
            self.hub.pump();
            return;
        }
        self.hub.finish(outcome, reply);
    }

    fn mcp_servers_approve_instructions(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.run(reply, |ipc, host| {
            ipc.servers_approve_instructions(host, id, a0.as_ref())
        });
    }

    fn mcp_servers_approve_launch(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0, a1) = (sender(cx), arg(&args, 0), arg(&args, 1));
        self.run(reply, |ipc, host| {
            ipc.servers_approve_launch(host, id, a0.as_ref(), a1.as_ref())
        });
    }

    fn mcp_servers_approve_tool(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0, a1) = (sender(cx), arg(&args, 0), arg(&args, 1));
        self.run(reply, |ipc, host| {
            ipc.servers_approve_tool(host, id, a0.as_ref(), a1.as_ref())
        });
    }

    fn mcp_servers_cancel_sign_in(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.run(reply, |ipc, host| {
            ipc.servers_cancel_sign_in(host, id, a0.as_ref())
        });
    }

    fn mcp_servers_edit(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0, a1) = (sender(cx), arg(&args, 0), arg(&args, 1));
        self.run(reply, |ipc, host| {
            ipc.servers_edit(host, id, a0.as_ref(), a1.as_ref())
        });
    }

    fn mcp_servers_list(&self, cx: &CallContext, _args: Args, reply: Responder) {
        let id = sender(cx);
        self.run(reply, |ipc, host| ipc.servers_list(host, id));
    }

    fn mcp_servers_mark_tools_seen(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.run(reply, |ipc, host| {
            ipc.servers_mark_tools_seen(host, id, a0.as_ref())
        });
    }

    fn mcp_servers_parse_paste(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.run(reply, |ipc, host| {
            ipc.servers_parse_paste(host, id, a0.as_ref())
        });
    }

    fn mcp_servers_planned_launch(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.run(reply, |ipc, host| {
            ipc.servers_planned_launch(host, id, a0.as_ref())
        });
    }

    fn mcp_servers_remove(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.run(reply, |ipc, host| ipc.servers_remove(host, id, a0.as_ref()));
    }

    fn mcp_servers_retry(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.run(reply, |ipc, host| ipc.servers_retry(host, id, a0.as_ref()));
    }

    fn mcp_servers_set_enabled(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0, a1) = (sender(cx), arg(&args, 0), arg(&args, 1));
        self.run(reply, |ipc, host| {
            ipc.servers_set_enabled(host, id, a0.as_ref(), a1.as_ref())
        });
    }

    fn mcp_servers_set_keep_results_inside(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0, a1) = (sender(cx), arg(&args, 0), arg(&args, 1));
        self.run(reply, |ipc, host| {
            ipc.servers_set_keep_results_inside(host, id, a0.as_ref(), a1.as_ref())
        });
    }

    fn mcp_servers_set_tool_permission(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0, a1, a2) = (sender(cx), arg(&args, 0), arg(&args, 1), arg(&args, 2));
        self.run(reply, |ipc, host| {
            ipc.servers_set_tool_permission(host, id, a0.as_ref(), a1.as_ref(), a2.as_ref())
        });
    }

    fn mcp_servers_sign_in(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.run(reply, |ipc, host| {
            ipc.servers_sign_in(host, id, a0.as_ref())
        });
    }

    fn mcp_servers_test(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.run(reply, |ipc, host| ipc.servers_test(host, id, a0.as_ref()));
    }

    fn mcp_tools_call(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.run(reply, |ipc, host| ipc.tools_call(host, id, a0.as_ref()));
    }

    fn mcp_tools_cancel(&self, cx: &CallContext, args: Args, reply: Responder) {
        let (id, a0) = (sender(cx), arg(&args, 0));
        self.hub.ipc.borrow_mut().tools_cancel(id, a0.as_ref());
        self.hub.pump();
        reply.reply(Ok(IpcValue::Undefined));
    }

    fn mcp_tools_list(&self, _cx: &CallContext, _args: Args, reply: Responder) {
        self.plain(reply, |ipc| ipc.tools_list());
    }

    fn mcp_tools_open_settings(&self, _cx: &CallContext, args: Args, reply: Responder) {
        let a0 = arg(&args, 0);
        self.plain(reply, |ipc| ipc.tools_open_settings(a0.as_ref()));
    }

    fn mcp_tools_retry(&self, _cx: &CallContext, args: Args, reply: Responder) {
        let a0 = arg(&args, 0);
        self.plain(reply, |ipc| ipc.tools_retry(a0.as_ref()));
    }
}

/// The host the shell inserts for the hub port. The secrets seal with
/// `safeStorage` ([`crate::secrets::SafeStorageHost`]), unless the shell
/// inserted a [`McpSafeStorage`] of its own (the probe's stand-in)
pub fn hub_factory() -> crate::Factory<dyn McpHubPorts> {
    crate::Factory::new(|services, _| {
        let hosts = &services.hosts;
        let batch = shell_contract::Batch::A;
        let storage: McpSafeStorage = match hosts.get::<McpSafeStorage>() {
            Some(storage) => storage.clone(),
            None => hosts.need::<crate::secrets::SafeStorageHost>(batch)?,
        };
        let port = McpHubPort::new(
            services,
            hosts.need::<McpNetHost>(batch)?,
            hosts.need::<McpShellHost>(batch)?,
            hosts.need::<OsShellHost>(batch)?,
            hosts.need::<MainWindowHost>(batch)?,
            hosts.need::<ShellUiHost>(batch)?,
            storage,
        );
        let port: Rc<dyn McpHubPorts> = port;
        Ok(port)
    })
}

/// The host the shell inserts for the docs and sheets bridges
pub fn bridges_factory() -> crate::Factory<dyn crate::ports::McpDocumentBridges> {
    bridges::factory()
}

#[cfg(test)]
mod tests {
    use shell_contract::ipc::Sender;
    use shell_contract::{Surface, WindowId};

    use super::testing::{
        Os, Rig, ServerNet, Shell, Storage, Ui, Window, call_cx, hub_hosts, obj, s,
    };
    use super::*;

    struct Setup {
        rig: Rig,
        port: Rc<McpHubPort>,
        net: Arc<ServerNet>,
        ui: Arc<Ui>,
    }

    /// view 1 is the shell window, view 2 an editor
    fn setup() -> Setup {
        let net = ServerNet::new(&[("echo", "Echo it back")]);
        let rig = Rig::new(&[1, 2]);
        let os = Arc::new(Os::default());
        let ui = Arc::new(Ui::default());
        let port = McpHubPort::new(
            &rig.services,
            net.clone(),
            Arc::new(Shell),
            os,
            Arc::new(Window(Some(ViewId(1)))),
            ui.clone(),
            Arc::new(Storage),
        );
        Setup { rig, port, net, ui }
    }

    fn cx(view: u32) -> CallContext {
        call_cx(Sender {
            view: ViewId(view),
            window: WindowId(1),
            surface: if view == 1 {
                Surface::Shell
            } else {
                Surface::Docs
            },
        })
    }

    type Slot = Arc<Mutex<Option<shell_contract::ipc::Reply>>>;

    fn ask(
        setup: &Setup,
        view: u32,
        call: impl FnOnce(&McpHubPort, &CallContext, Responder),
    ) -> Slot {
        let (reply, slot) = setup.rig.responder();
        call(&setup.port, &cx(view), reply);
        slot
    }

    /// calls and pumps until the answer is there
    fn answer(
        setup: &Setup,
        view: u32,
        call: impl FnOnce(&McpHubPort, &CallContext, Responder),
    ) -> Result<IpcValue, IpcError> {
        let slot = ask(setup, view, call);
        assert!(
            setup
                .rig
                .pump_until(10_000, || slot.lock().unwrap().is_some()),
            "no answer"
        );
        slot.lock().unwrap().take().unwrap()
    }

    fn field(value: &IpcValue, name: &str) -> Option<IpcValue> {
        match value {
            IpcValue::Object(entries) => entries
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone()),
            _ => None,
        }
    }

    fn add_remote(setup: &Setup, name: &str) -> String {
        let input = obj(&[
            ("name", s(name)),
            ("kind", s("remote")),
            ("url", s("https://example.test/mcp")),
        ]);
        let added = answer(setup, 1, |p, cx, re| p.mcp_servers_add(cx, vec![input], re)).unwrap();
        assert_eq!(field(&added, "ok"), Some(IpcValue::Bool(true)), "{added:?}");
        let Some(IpcValue::String(id)) = field(&added, "id") else {
            panic!("an id")
        };
        id
    }

    #[test]
    fn settings_channels_answer_the_shell_window_only() {
        let t = setup();
        assert_eq!(
            answer(&t, 2, |p, cx, re| p.mcp_servers_list(cx, vec![], re)),
            Ok(IpcValue::Null)
        );
        let refused = answer(&t, 2, |p, cx, re| {
            p.mcp_servers_add(cx, vec![obj(&[("name", s("x"))])], re)
        })
        .unwrap();
        assert_eq!(field(&refused, "problem"), Some(s("invalid")));
        assert_eq!(field(&refused, "detail"), Some(s("sender")));
        let listed = answer(&t, 1, |p, cx, re| p.mcp_servers_list(cx, vec![], re)).unwrap();
        assert_ne!(listed, IpcValue::Null);
        // a request that is not what Settings sends is malformed, not a crash
        let bad = answer(&t, 1, |p, cx, re| {
            p.mcp_servers_remove(cx, vec![IpcValue::Number(3.0)], re)
        })
        .unwrap();
        assert_eq!(field(&bad, "problem"), Some(s("invalid")));
    }

    #[test]
    fn adding_a_server_writes_the_file_and_tells_the_windows() {
        let t = setup();
        t.rig.events();
        let id = add_remote(&t, "docs");
        let file = t.rig.dir.join("userData").join("mcp-servers.json");
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(saved["servers"][0]["id"], id.as_str());
        let events = t.rig.events();
        let channels: Vec<(Target, &str)> = events.iter().map(|(t, c, _)| (*t, *c)).collect();
        assert!(
            channels.contains(&(Target::All, "mcp-tools:changed")),
            "{channels:?}"
        );
        assert!(
            channels.contains(&(Target::View(ViewId(1)), "mcp-servers:changed")),
            "{channels:?}"
        );
        // the editors see the server, not yet checked and without tools
        let listed = answer(&t, 2, |p, cx, re| p.mcp_tools_list(cx, vec![], re)).unwrap();
        let IpcValue::Array(servers) = listed else {
            panic!("a list")
        };
        assert_eq!(servers.len(), 1);
        assert_eq!(field(&servers[0], "status"), Some(s("unchecked")));
        assert_eq!(field(&servers[0], "tools"), Some(IpcValue::Array(vec![])));
    }

    #[test]
    fn testing_a_remote_server_answers_when_its_connection_has_listed_the_tools() {
        let t = setup();
        let id = add_remote(&t, "docs");
        let slot = ask(&t, 1, |p, cx, re| p.mcp_servers_test(cx, vec![s(&id)], re));
        // the connection is another thread: the core thread did not wait for it
        assert!(slot.lock().unwrap().is_none());
        assert!(t.rig.pump_until(10_000, || slot.lock().unwrap().is_some()));
        let tested = slot.lock().unwrap().take().unwrap().unwrap();
        assert_eq!(
            field(&tested, "ok"),
            Some(IpcValue::Bool(true)),
            "{tested:?}"
        );
        assert_eq!(field(&tested, "toolCount"), Some(IpcValue::Number(1.0)));
        let seen = t.net.seen.lock().unwrap().clone();
        assert!(
            seen.contains(&"initialize".to_owned()) && seen.contains(&"tools/list".to_owned()),
            "{seen:?}"
        );
    }

    #[test]
    fn an_editor_calls_a_tool_the_person_allowed_and_a_cancelled_call_ends() {
        let t = setup();
        let id = add_remote(&t, "docs");
        let tested = answer(&t, 1, |p, cx, re| p.mcp_servers_test(cx, vec![s(&id)], re)).unwrap();
        assert_eq!(field(&tested, "ok"), Some(IpcValue::Bool(true)));
        let allowed = answer(&t, 1, |p, cx, re| {
            p.mcp_servers_set_tool_permission(cx, vec![s(&id), s("echo"), s("always")], re)
        })
        .unwrap();
        assert_eq!(
            field(&allowed, "ok"),
            Some(IpcValue::Bool(true)),
            "{allowed:?}"
        );
        let listed = answer(&t, 2, |p, cx, re| p.mcp_tools_list(cx, vec![], re)).unwrap();
        let IpcValue::Array(tools) = listed else {
            panic!("a list")
        };
        assert_eq!(tools.len(), 1, "{tools:?}");
        let request = |call: &str| {
            obj(&[
                ("server", s("docs")),
                ("tool", s("echo")),
                ("callId", s(call)),
                ("input", obj(&[])),
            ])
        };
        let called = answer(&t, 2, |p, cx, re| {
            p.mcp_tools_call(cx, vec![request("c1")], re)
        })
        .unwrap();
        assert_eq!(
            field(&called, "ok"),
            Some(IpcValue::Bool(true)),
            "{called:?}"
        );
        assert_eq!(field(&called, "output"), Some(s("called echo")));
        // a malformed request is refused at once
        let malformed =
            answer(&t, 2, |p, cx, re| p.mcp_tools_call(cx, vec![s("nope")], re)).unwrap();
        assert_eq!(field(&malformed, "ok"), Some(IpcValue::Bool(false)));
        // cancelling a call nobody made is harmless
        assert_eq!(
            answer(&t, 2, |p, cx, re| p.mcp_tools_cancel(cx, vec![s("c9")], re)),
            Ok(IpcValue::Undefined)
        );
    }

    #[test]
    fn opening_a_server_in_settings_brings_the_shell_window_up_and_names_the_server() {
        let t = setup();
        let _ = add_remote(&t, "docs");
        t.rig.events();
        let opened = answer(&t, 2, |p, cx, re| {
            p.mcp_tools_open_settings(cx, vec![s("docs")], re)
        });
        assert_eq!(
            opened.map(|v| field(&v, "ok")),
            Ok(Some(IpcValue::Bool(true)))
        );
        let unknown = answer(&t, 2, |p, cx, re| {
            p.mcp_tools_open_settings(cx, vec![s("nothing")], re)
        });
        assert_eq!(
            unknown.map(|v| field(&v, "ok")),
            Ok(Some(IpcValue::Bool(false)))
        );
        assert_eq!(*t.ui.0.lock().unwrap(), 1);
        let events = t.rig.events();
        let named: Vec<&str> = events.iter().map(|(_, c, _)| *c).collect();
        assert!(named.contains(&"home:open-settings"), "{named:?}");
        assert!(named.contains(&"mcp-servers:open-server"), "{named:?}");
    }

    /// a stdio MCP server in `sh`: it answers initialize, tools/list and tools/call
    #[cfg(unix)]
    const SERVER_SCRIPT: &str = r#"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"sh","version":"1"}}}\n' "$id";;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"hello","description":"Say hello","inputSchema":{"type":"object","properties":{}}}]}}\n' "$id";;
    *'"method":"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"hello from sh"}]}}\n' "$id";;
  esac
done
"#;

    #[cfg(unix)]
    #[test]
    fn a_program_of_the_persons_pc_is_started_after_approval_and_answers_tool_calls() {
        let t = setup();
        let script = t.rig.dir.join("server.sh");
        std::fs::write(&script, SERVER_SCRIPT).unwrap();
        let input = obj(&[
            ("name", s("shell")),
            ("kind", s("local")),
            ("command", s("/bin/sh")),
            ("args", IpcValue::Array(vec![s(&script.to_string_lossy())])),
        ]);
        let added = answer(&t, 1, |p, cx, re| p.mcp_servers_add(cx, vec![input], re)).unwrap();
        assert_eq!(field(&added, "ok"), Some(IpcValue::Bool(true)), "{added:?}");
        let Some(IpcValue::String(id)) = field(&added, "id") else {
            panic!("an id")
        };
        // the program does not start before the person approved this very launch
        let refused = answer(&t, 1, |p, cx, re| p.mcp_servers_test(cx, vec![s(&id)], re)).unwrap();
        assert_eq!(
            field(&refused, "problem"),
            Some(s("launch-not-approved")),
            "{refused:?}"
        );
        let plan = answer(&t, 1, |p, cx, re| {
            p.mcp_servers_planned_launch(cx, vec![s(&id)], re)
        })
        .unwrap();
        let launch = field(&plan, "launch").unwrap_or(IpcValue::Null);
        let Some(IpcValue::String(fingerprint)) = field(&launch, "fingerprint") else {
            panic!("a plan with a fingerprint: {plan:?}")
        };
        let approved = answer(&t, 1, |p, cx, re| {
            p.mcp_servers_approve_launch(cx, vec![s(&id), s(&fingerprint)], re)
        })
        .unwrap();
        assert_eq!(
            field(&approved, "ok"),
            Some(IpcValue::Bool(true)),
            "{approved:?}"
        );
        let tested = answer(&t, 1, |p, cx, re| p.mcp_servers_test(cx, vec![s(&id)], re)).unwrap();
        assert_eq!(
            field(&tested, "ok"),
            Some(IpcValue::Bool(true)),
            "{tested:?}"
        );
        assert_eq!(field(&tested, "toolCount"), Some(IpcValue::Number(1.0)));
        let _ = answer(&t, 1, |p, cx, re| {
            p.mcp_servers_set_tool_permission(cx, vec![s(&id), s("hello"), s("always")], re)
        })
        .unwrap();
        let request = obj(&[
            ("server", s("shell")),
            ("tool", s("hello")),
            ("callId", s("c1")),
            ("input", obj(&[])),
        ]);
        let called = answer(&t, 2, |p, cx, re| p.mcp_tools_call(cx, vec![request], re)).unwrap();
        assert_eq!(
            field(&called, "output"),
            Some(s("hello from sh")),
            "{called:?}"
        );
    }

    #[test]
    fn the_hub_factory_asks_for_every_host_it_needs() {
        let rig = Rig::new(&[1]);
        let factory = hub_factory();
        let built = (factory.0)(
            &rig.services,
            &Rc::new(shell_contract::provided::Provided::default()),
        );
        assert!(built.is_err());
        let (install, _, _) = hub_hosts(ServerNet::new(&[]), Some(1));
        let rig = Rig::with_hosts(&[1], install);
        let built = (factory.0)(
            &rig.services,
            &Rc::new(shell_contract::provided::Provided::default()),
        );
        assert!(built.is_ok());
    }
}
