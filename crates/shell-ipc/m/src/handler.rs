//! Registering closures as handlers. A channel's kind decides the shape:
//! an invoke answers a [`Reply`], a send answers nothing, a sendSync answers
//! the value the renderer's `event.returnValue` held.

use std::rc::Rc;

use shell_contract::channels::Batch;
use shell_contract::ipc::{
    CallContext, ChannelKind, Handler, RegisterError, Registry, Reply, Responder,
};
use shell_contract::{IpcError, IpcValue};

struct FnHandler<F>(F);

impl<F: Fn(&CallContext, Vec<IpcValue>, Responder)> Handler for FnHandler<F> {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        (self.0)(cx, args, reply)
    }
}

fn register(
    registry: &mut dyn Registry,
    channel: &'static str,
    kind: ChannelKind,
    handler: impl Fn(&CallContext, Vec<IpcValue>, Responder) + 'static,
) -> Result<(), RegisterError> {
    registry.register(Batch::M, channel, kind, Rc::new(FnHandler(handler)))
}

/// `ipcMain.handle` whose body returns before awaiting anything
pub fn invoke(
    registry: &mut dyn Registry,
    channel: &'static str,
    handler: impl Fn(&CallContext, Vec<IpcValue>) -> Reply + 'static,
) -> Result<(), RegisterError> {
    register(registry, channel, ChannelKind::Invoke, move |cx, args, reply| {
        reply.reply(handler(cx, args))
    })
}

/// `ipcMain.handle` whose body awaits: it keeps the responder and answers
/// later, usually from a worker
pub fn invoke_later(
    registry: &mut dyn Registry,
    channel: &'static str,
    handler: impl Fn(&CallContext, Vec<IpcValue>, Responder) + 'static,
) -> Result<(), RegisterError> {
    register(registry, channel, ChannelKind::Invoke, handler)
}

/// `ipcMain.on` for `ipcRenderer.send`
pub fn send(
    registry: &mut dyn Registry,
    channel: &'static str,
    handler: impl Fn(&CallContext, Vec<IpcValue>) + 'static,
) -> Result<(), RegisterError> {
    register(registry, channel, ChannelKind::Send, move |cx, args, reply| {
        handler(cx, args);
        reply.reply(Ok(IpcValue::Undefined))
    })
}

/// `ipcMain.on` for `ipcRenderer.sendSync`: the answer is `event.returnValue`
pub fn send_sync(
    registry: &mut dyn Registry,
    channel: &'static str,
    handler: impl Fn(&CallContext, Vec<IpcValue>) -> IpcValue + 'static,
) -> Result<(), RegisterError> {
    register(registry, channel, ChannelKind::SendSync, move |cx, args, reply| {
        reply.reply(Ok(handler(cx, args)))
    })
}

/// `throw new Error(message)`
pub fn error(message: impl Into<String>) -> IpcError {
    IpcError {
        name: Some("Error".into()),
        message: message.into(),
    }
}
