//! `packages/electron-utils/src/split-pane-bridge.ts`: the split-pane bridge
//! every editor preload exposes, over the part of `ipcRenderer` it uses.

use serde_json::Value;

/// `SPLIT_PANE_CHANNELS`, as (key, channel) in the order the object has them.
pub const SPLIT_PANE_CHANNELS: [(&str, &str); 4] = [
    ("getRole", "app:get-split-role"),
    ("roleChanged", "app:split-role-changed"),
    ("requestFocus", "tabs:focus-pane"),
    ("reportFocus", "app:view-focused"),
];

const GET_ROLE: &str = "app:get-split-role";
const ROLE_CHANGED: &str = "app:split-role-changed";
const REQUEST_FOCUS: &str = "tabs:focus-pane";
const REPORT_FOCUS: &str = "app:view-focused";

/// `SPLIT_PANE_BRIDGE_KEY`
pub const SPLIT_PANE_BRIDGE_KEY: &str = "aiOfficeSplit";

/// A rejected `ipcRenderer.invoke` promise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IpcRejected;

/// The part of `IpcRenderer` the bridge uses. A listener is a number the
/// bridge makes.
pub trait SplitPaneIpc {
    /// `ipcRenderer.invoke(channel)`: `Err` is a rejected promise, `Ok(None)`
    /// an answer of `undefined`
    fn invoke(&mut self, channel: &str) -> Result<Option<Value>, IpcRejected>;
    /// `ipcRenderer.on(channel, listener)`
    fn on(&mut self, channel: &str, listener: u64);
    /// `ipcRenderer.removeListener(channel, listener)`
    fn remove_listener(&mut self, channel: &str, listener: u64);
    /// `ipcRenderer.send(channel)`
    fn send(&mut self, channel: &str);
}

/// `splitPaneBridge(ipcRenderer)`
#[derive(Debug, Default)]
pub struct SplitPaneBridge {
    next_listener: u64,
}

impl SplitPaneBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// `getRole()`: what the shell answered, `null` when it answered nothing
    /// or the call failed.
    pub fn get_role<I: SplitPaneIpc>(&self, ipc: &mut I) -> Value {
        match ipc.invoke(GET_ROLE) {
            Ok(Some(role)) => role,
            Ok(None) | Err(IpcRejected) => Value::Null,
        }
    }

    /// `onRoleChanged(handler)`: the listener it registers.
    pub fn on_role_changed<I: SplitPaneIpc>(&mut self, ipc: &mut I) -> u64 {
        self.next_listener += 1;
        ipc.on(ROLE_CHANGED, self.next_listener);
        self.next_listener
    }

    /// The unsubscribe function `onRoleChanged` returns.
    pub fn remove_role_listener<I: SplitPaneIpc>(&self, ipc: &mut I, listener: u64) {
        ipc.remove_listener(ROLE_CHANGED, listener);
    }

    /// `requestFocus()`
    pub fn request_focus<I: SplitPaneIpc>(&self, ipc: &mut I) {
        ipc.send(REQUEST_FOCUS);
    }

    /// `reportFocus()`
    pub fn report_focus<I: SplitPaneIpc>(&self, ipc: &mut I) {
        ipc.send(REPORT_FOCUS);
    }
}
