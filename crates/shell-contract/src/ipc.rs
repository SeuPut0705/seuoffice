//! The IPC boundary. A renderer keeps calling `ipcRenderer.invoke/send/on`
//! (its preload is unchanged, bundled over the shell's bridge); the shell
//! turns each call into a [`Message`] for the handler registered under the
//! same channel name, and every message to the renderer (a reply or an event)
//! goes back over one ordered stream per view.

use std::rc::Rc;

use crate::channels::{Batch, Surface};
use crate::error::IpcError;
use crate::ids::{RequestId, ViewId, WindowId};
use crate::runtime::{CancelToken, Services};
use crate::value::IpcValue;

/// How a renderer uses a channel
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ChannelKind {
    /// `ipcRenderer.invoke`: one reply, a value or an [`IpcError`]
    Invoke,
    /// `ipcRenderer.send`: no reply; handled in arrival order per view
    Send,
    /// `ipcRenderer.sendSync`: the renderer blocks until the reply
    SendSync,
    /// `ipcRenderer.on/once`: the main side emits, the renderer listens
    Event,
    /// `ipcRenderer.postMessage` with ports (no renderer uses it today)
    Port,
}

/// Who sent a message: the view, its window, and the preload it loaded
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Sender {
    pub view: ViewId,
    pub window: WindowId,
    pub surface: Surface,
}

/// What a handler gets besides its arguments
#[derive(Clone, Debug)]
pub struct CallContext {
    pub sender: Sender,
    /// set for `invoke`, none for `send` and `sendSync`
    pub request: Option<RequestId>,
    /// fires when the sender's view is destroyed or navigates away, as
    /// `abort-on-destroyed` did; the renderer cannot cancel an invoke
    pub cancel: CancelToken,
}

/// A message from a renderer, after the bridge decoded it
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    pub kind: ChannelKind,
    pub channel: String,
    pub args: Vec<IpcValue>,
}

/// A handler's answer; for `send` an `Err` is logged as Electron logged an
/// uncaught exception in an `ipcMain.on` listener
pub type Reply = Result<IpcValue, IpcError>;

/// Answers one message, once, from any thread. A handler that awaited in
/// TypeScript (a dialog, the network, a child process) keeps the responder,
/// returns, and answers when its work ends. Dropping it unanswered is a bug;
/// the shell then rejects the invoke so the renderer does not hang.
pub struct Responder(Box<dyn FnOnce(Reply) + Send>);

impl Responder {
    pub fn new(answer: impl FnOnce(Reply) + Send + 'static) -> Self {
        Responder(Box::new(answer))
    }

    pub fn reply(self, reply: Reply) {
        (self.0)(reply)
    }
}

/// One channel's handler: `ipcMain.handle` and `ipcMain.on` in one shape.
/// Runs on the core thread, as every `ipcMain` listener ran on Electron's
/// main thread: in arrival order, one at a time, so `main-core`'s state
/// (`Rc`, `RefCell`) needs no lock. Not `Send`: it never leaves that thread.
pub trait Handler {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder);
}

/// Where a main-side event goes
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    /// `webContents.send` and `event.sender.send`
    View(ViewId),
    /// every view of one window
    Window(WindowId),
    /// every view that loaded this preload
    Surface(Surface),
    /// every view, as the broadcast loops over `BrowserWindow.getAllWindows()`
    All,
}

/// Emits main-side events. Callable from any thread; for one view, events
/// and replies arrive in the order they were emitted, so a stream's chunks
/// are delivered before the reply of the invoke that produced them.
pub trait EventSink: Send + Sync {
    fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>);
}

/// Why a registration was refused at start; the shell does not start then
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegisterError {
    /// not in [`crate::CHANNELS`]: regenerate the table or fix the name
    Unknown(&'static str),
    /// two handlers for one channel
    Twice(&'static str),
    /// the channel belongs to another batch: file ownership is per batch
    WrongBatch {
        channel: &'static str,
        owner: Batch,
        by: Batch,
    },
    /// the registration's kind is not how renderers use the channel
    WrongKind {
        channel: &'static str,
        kind: ChannelKind,
    },
}

/// The channel table the shell fills at start on the core thread, one batch
/// after another. After all batches, every spec of kind invoke, send or
/// sendSync must have a handler, and the shell refuses a message from a
/// surface the spec does not list (the capability check Electron did not have).
pub trait Registry {
    fn register(
        &mut self,
        by: Batch,
        channel: &'static str,
        kind: ChannelKind,
        handler: Rc<dyn Handler>,
    ) -> Result<(), RegisterError>;
}

/// A batch's entry point: `crates/shell/src/ipc/<batch>/mod.rs` exports one
pub type RegisterBatch = fn(&mut dyn Registry, &Services) -> Result<(), RegisterError>;
