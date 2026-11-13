//! `apps/shell/src/main/mcp-client/hub-app.ts`: the person's MCP servers in the
//! running app: the hub with Electron behind it (the OS cipher for secrets,
//! `net.fetch` so the system proxy applies, the system browser for sign-in)
//! and its channels. Called once the app is ready; `stopAll` on the hub belongs
//! to quitting.
//!
//! Electron stays behind [`McpAppHost`] (`app`, `shell`, `webContents` and the
//! shell window) and [`FetchHost`] (`net.fetch`); the OS cipher is the
//! [`SafeStorageLike`](crate::shell::ai_secrets::SafeStorageLike) of
//! [`SafeStorageMcpCodec`](super::secrets::SafeStorageMcpCodec). What
//! `startMcpHub` decides is here as functions: the work folder of "my PC"
//! servers, what the runtime kit asks of the store, the sign-in browser, what
//! "open in Settings" does, which window is the settings sender. The
//! connections themselves (`createRemoteMcpConnection`,
//! `createLocalMcpConnection`, the runtime kit) are other modules': the app
//! hands the hub an [`AppHubHost`] over a [`McpConnectionFactory`] made from
//! them. `registerMcpHubIpc` and `void hub.load()` are the caller's wiring of
//! `hub_ipc` and [`McpHub::load`].

use std::rc::Rc;

use jscompat::JsonValue;
use jscompat::node_path::host::join;

use super::hub::{
    ConnId, LocalConnection, McpHubHost, RemoteConnection, SharedStore, redirect_safe_fetch,
};
use super::hub_ipc::McpHubIpcHost;
use super::local_launch::{McpRuntimeId, PlannedLaunch, ResolveOptions, RuntimeResolution};
use super::store::{McpServerConfig, RuntimeAllowance};
use crate::node_fs::NodeError;
use crate::packages::electron_utils::mcp_tools_channels::MCP_TOOLS_CHANNELS;
use crate::packages::electron_utils::safe_external_url::safe_external_url;
use crate::packages::i18n::{Lang, PRODUCT_NAME};
use crate::packages::mcp_sdk::client::net::{FetchError, FetchHost, FetchInit, FetchResponse};
use crate::shell::mcp_servers_api::MCP_SERVERS_CHANNELS;

/// Under the app's temp folder: the empty working folders of "my PC" servers (5.3)
pub const LOCAL_WORK_DIR_NAME: &str = "seuoffice-mcp";

/// `join(app.getPath('temp'), LOCAL_WORK_DIR_NAME)`: the `workRoot` of a local connection
pub fn local_work_root(temp_dir: &str) -> String {
    join(&[temp_dir, LOCAL_WORK_DIR_NAME])
}

/// `{ name: PRODUCT_NAME, version: app.getVersion() }`: what servers are told (5.6)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

pub fn client_info(app_version: &str) -> ClientInfo {
    ClientInfo {
        name: PRODUCT_NAME.to_owned(),
        version: app_version.to_owned(),
    }
}

/// `isRuntimeAllowed(id)` of the runtime kit: whether `runtimes[id].allowed` is set
pub fn is_runtime_allowed(store: &SharedStore<'_>, id: McpRuntimeId) -> bool {
    store
        .borrow()
        .get()
        .runtimes
        .entries()
        .iter()
        .any(|(key, r)| *key == id.as_str() && r.allowed)
}

/// `recordRuntimeAllowed(id)` of the runtime kit: set `runtimes[id].allowed`
pub fn record_runtime_allowed(store: &SharedStore<'_>, id: McpRuntimeId) -> Result<(), NodeError> {
    store
        .borrow_mut()
        .update(&mut |file| {
            let mut runtimes = file.runtimes.clone();
            runtimes.set(id.as_str(), RuntimeAllowance { allowed: true });
            file.runtimes = runtimes;
            None
        })
        .map(|_| ())
}

/// `askDownload: async () => false`: never from an AI window: the question is asked
/// in Settings (spec 5.4), whose answer records the permission before the download starts
pub fn ask_download() -> bool {
    false
}

/// A webContents the app sends to
pub trait McpWindow {
    /// `webContents.id`
    fn id(&self) -> f64;
    fn is_destroyed(&self) -> bool;
    /// `contents.send(channel, ...args)`
    fn send(&self, channel: &str, args: &[JsonValue]);
}

/// What the app asks of Electron
pub trait McpAppHost {
    /// `deps.lang()`
    fn lang(&self) -> Lang;
    /// `shellContents()`: the shell window's web contents when the window is
    /// open and not destroyed
    fn shell_contents(&self) -> Option<&dyn McpWindow>;
    /// `deps.openIntegrations()`: bring the shell window up on Settings → Integrations
    fn open_integrations(&self);
    /// `shell.openExternal(url)`; `Err` where it rejects
    fn shell_open_external(&self, url: &str) -> Result<(), String>;
    /// `webContents.getAllWebContents()`
    fn all_web_contents(&self) -> Vec<&dyn McpWindow>;
    /// `sender.once('destroyed', ...)` where the sender has `once`: the adapter
    /// calls `McpHubIpc::sender_destroyed` when it fires; `false` without `once`
    fn watch_destroyed(&self, sender_id: f64) -> bool;
    /// `Date.now()`
    fn now_ms(&self) -> f64;
}

/// `openExternal` of the hub's deps: the system browser; `false` when it did
/// not open (an address that is not http or https is never opened)
pub fn open_external(app: &dyn McpAppHost, url: &str) -> bool {
    let Some(target) = safe_external_url(Some(url), None) else {
        return false;
    };
    app.shell_open_external(&target).is_ok()
}

/// `openSettings(serverId)` of the hub's deps
pub fn open_settings(app: &dyn McpAppHost, server_id: &str) {
    app.open_integrations();
    if let Some(contents) = app.shell_contents() {
        let channel = MCP_SERVERS_CHANNELS
            .iter()
            .find(|(key, _)| *key == "openServer")
            .map(|(_, name)| *name)
            .unwrap_or_default();
        contents.send(channel, &[JsonValue::String(server_id.to_owned())]);
    }
}

/// `isSettingsSender(sender)`: the sender is the shell window's web contents
pub fn is_settings_sender(app: &dyn McpAppHost, sender_id: f64) -> bool {
    app.shell_contents().is_some_and(|c| c.id() == sender_id)
}

/// What `registerMcpHubIpc({ hub, ipcMain, isSettingsSender, allWindows,
/// settingsWindow })` gets from the app, over the Electron objects
pub struct AppIpcHost<'a> {
    pub app: &'a dyn McpAppHost,
}

fn channel_named(table: &[(&'static str, &'static str)], key: &str) -> &'static str {
    table
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, name)| *name)
        .unwrap_or_default()
}

impl McpHubIpcHost for AppIpcHost<'_> {
    fn is_settings_sender(&mut self, sender_id: f64) -> bool {
        is_settings_sender(self.app, sender_id)
    }

    fn watch_destroyed(&mut self, sender_id: f64) -> bool {
        self.app.watch_destroyed(sender_id)
    }

    /// `allWindows: () => webContents.getAllWebContents()`
    fn broadcast_tools_changed(&mut self) {
        let channel = channel_named(&MCP_TOOLS_CHANNELS, "changed");
        for win in self.app.all_web_contents() {
            if !win.is_destroyed() {
                win.send(channel, &[]);
            }
        }
    }

    /// `settingsWindow: shellContents`
    fn settings_window_open(&mut self) -> bool {
        self.app.shell_contents().is_some()
    }

    fn send_settings_changed(&mut self, view: &JsonValue) {
        if let Some(shell) = self.app.shell_contents()
            && !shell.is_destroyed()
        {
            shell.send(
                channel_named(&MCP_SERVERS_CHANNELS, "changed"),
                std::slice::from_ref(view),
            );
        }
    }
}

/// `fetch = redirectSafeFetch((url, init) => net.fetch(url, init))`: `net.fetch`
/// behind the redirect guard. Only `fetch` is guarded; the body calls go to `net`.
pub struct RedirectSafeHost<'a> {
    pub net: &'a mut dyn FetchHost,
}

impl FetchHost for RedirectSafeHost<'_> {
    fn fetch(&mut self, url: &str, init: &FetchInit) -> Result<FetchResponse, FetchError> {
        redirect_safe_fetch(&mut *self.net, url, init)
    }

    fn read_body(&mut self, stream: u64) -> Result<Vec<u8>, FetchError> {
        self.net.read_body(stream)
    }

    fn cancel_body(&mut self, stream: u64) {
        self.net.cancel_body(stream)
    }

    fn abort_body(&mut self, stream: u64) {
        self.net.abort_body(stream)
    }
}

/// The connections `startMcpHub` builds: `createRemoteMcpConnection` and
/// `createLocalMcpConnection` with `clientInfo`, `fetch` (the redirect-safe one),
/// `workRoot` (see [`local_work_root`]) and the kit, and the kit's two calls the
/// hub's deps name
pub trait McpConnectionFactory<'h> {
    fn remote(
        &self,
        conn: ConnId,
        server: &McpServerConfig,
        store: &SharedStore<'h>,
    ) -> Box<dyn RemoteConnection<'h> + 'h>;
    fn local(&self, conn: ConnId, server: &McpServerConfig) -> Box<dyn LocalConnection + 'h>;
    /// `kit.resolveCommand`
    fn resolve_command(&self, command: &str, options: &ResolveOptions) -> RuntimeResolution;
    /// `plannedLaunch(server, kit)`
    fn planned_launch(&self, server: &McpServerConfig) -> PlannedLaunch;
}

/// The hub's deps in the running app
pub struct AppHubHost<'h> {
    pub app: Rc<dyn McpAppHost + 'h>,
    pub connections: Box<dyn McpConnectionFactory<'h> + 'h>,
}

impl<'h> McpHubHost<'h> for AppHubHost<'h> {
    fn remote(
        &self,
        conn: ConnId,
        server: &McpServerConfig,
        store: &SharedStore<'h>,
    ) -> Box<dyn RemoteConnection<'h> + 'h> {
        self.connections.remote(conn, server, store)
    }

    fn local(&self, conn: ConnId, server: &McpServerConfig) -> Box<dyn LocalConnection + 'h> {
        self.connections.local(conn, server)
    }

    fn resolve_command(&self, command: &str, options: &ResolveOptions) -> RuntimeResolution {
        self.connections.resolve_command(command, options)
    }

    fn planned_launch(&self, server: &McpServerConfig) -> PlannedLaunch {
        self.connections.planned_launch(server)
    }

    fn lang(&self) -> Lang {
        self.app.lang()
    }

    fn open_external(&self, url: &str) -> bool {
        open_external(&*self.app, url)
    }

    fn open_settings(&self, server_id: &str) {
        open_settings(&*self.app, server_id);
    }

    fn now_ms(&self) -> f64 {
        self.app.now_ms()
    }
}
