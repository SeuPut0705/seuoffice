//! `packages/electron-utils/src/project-folder-bridge.ts`: the project folder
//! bridge a preload exposes, over the part of `ipcRenderer` it uses.
//!
//! A listener is a number the bridge makes (the `wrapped` function of the
//! TypeScript); the adapter keeps the real function under it.

use serde_json::Value;

use crate::packages::project_store::{
    PROJECT_FOLDER_CHANNELS, PROJECT_FOLDER_LISTEN_CHANNEL, ProjectFolderEventMethod,
    ProjectFolderListenMessage,
};

pub use crate::packages::project_store::PROJECT_FOLDER_BRIDGE_KEY;

/// `ProjectFolderBridgeIpc`: `invoke`, `on`, `removeListener` and `send` of
/// `ipcRenderer`.
pub trait ProjectFolderBridgeIpc {
    /// what `invoke` answers (the promise)
    type Reply;
    /// `ipc.invoke(channel)` or `ipc.invoke(channel, args)`
    fn invoke(&mut self, channel: &str, args: Option<&Value>) -> Self::Reply;
    /// `ipc.on(channel, listener)`
    fn on(&mut self, channel: &str, listener: u64);
    /// `ipc.removeListener(channel, listener)`
    fn remove_listener(&mut self, channel: &str, listener: u64);
    /// `ipc.send(PROJECT_FOLDER_LISTEN_CHANNEL, message)`
    fn send(&mut self, channel: &str, message: &ProjectFolderListenMessage);
}

/// One `onXxx(listener)` of the bridge, until its disposer ran.
#[derive(Debug)]
pub struct Subscription {
    method: ProjectFolderEventMethod,
    listener: u64,
    active: bool,
}

/// `projectFolderBridge(ipc)`: how many listeners each event has in this page.
#[derive(Debug, Default)]
pub struct ProjectFolderBridge {
    listeners: [u32; 4],
    next_listener: u64,
}

fn slot(method: ProjectFolderEventMethod) -> usize {
    match method {
        ProjectFolderEventMethod::OnChatMessageAppended => 0,
        ProjectFolderEventMethod::OnOpenChat => 1,
        ProjectFolderEventMethod::OnOpenProjectScreen => 2,
        ProjectFolderEventMethod::OnProjectChanged => 3,
    }
}

impl ProjectFolderBridge {
    pub fn new() -> Self {
        Self::default()
    }

    /// `tell(method, listening)`
    fn tell<I: ProjectFolderBridgeIpc>(
        ipc: &mut I,
        method: ProjectFolderEventMethod,
        listening: bool,
    ) {
        let message = ProjectFolderListenMessage { method, listening };
        ipc.send(PROJECT_FOLDER_LISTEN_CHANNEL, &message);
    }

    /// A request method of the bridge: `requests[name](args)`. `None` where
    /// the bridge has no such method.
    pub fn request<I: ProjectFolderBridgeIpc>(
        &self,
        ipc: &mut I,
        name: &str,
        args: Option<&Value>,
    ) -> Option<I::Reply> {
        let (_, channel) = PROJECT_FOLDER_CHANNELS.iter().find(|(n, _)| *n == name)?;
        Some(match args {
            None => ipc.invoke(channel, None),
            Some(args) => ipc.invoke(channel, Some(args)),
        })
    }

    /// `subscribe(method, listener)`
    pub fn subscribe<I: ProjectFolderBridgeIpc>(
        &mut self,
        ipc: &mut I,
        method: ProjectFolderEventMethod,
    ) -> Subscription {
        let channel = method.channel();
        self.next_listener += 1;
        let listener = self.next_listener;
        ipc.on(channel, listener);
        let count = self.listeners[slot(method)] + 1;
        self.listeners[slot(method)] = count;
        if count == 1 {
            Self::tell(ipc, method, true);
        }
        Subscription {
            method,
            listener,
            active: true,
        }
    }

    /// The disposer `subscribe` returns.
    pub fn unsubscribe<I: ProjectFolderBridgeIpc>(
        &mut self,
        ipc: &mut I,
        subscription: &mut Subscription,
    ) {
        if !subscription.active {
            return;
        }
        subscription.active = false;
        ipc.remove_listener(subscription.method.channel(), subscription.listener);
        let left = self.listeners[slot(subscription.method)].saturating_sub(1);
        self.listeners[slot(subscription.method)] = left;
        if left == 0 {
            Self::tell(ipc, subscription.method, false);
        }
    }
}
