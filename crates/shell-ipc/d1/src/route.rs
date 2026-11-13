//! The batch's routing table: one [`Route`] per channel it answers. Each app
//! module returns its routes and [`crate::register`] hands them to the
//! shell's registry, so a channel's kind and handler sit on one line.

use std::rc::Rc;

use shell_contract::ipc::{CallContext, ChannelKind, Handler, Reply, Responder};
use shell_contract::{IpcError, IpcValue};

use crate::value::Args;

pub struct Route {
    pub channel: &'static str,
    pub kind: ChannelKind,
    pub handler: Rc<dyn Handler>,
}

/// answers before `call` returns
struct Now<F>(F);

impl<F: Fn(&CallContext, Args) -> Reply> Handler for Now<F> {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        reply.reply((self.0)(cx, Args::new(args)))
    }
}

/// keeps the responder and answers when its work ends
struct Later<F>(F);

impl<F: Fn(&CallContext, Args, Responder)> Handler for Later<F> {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        (self.0)(cx, Args::new(args), reply)
    }
}

/// `ipcMain.handle(channel, fn)` whose answer is ready when `handle` returns
pub fn invoke(
    channel: &'static str,
    handle: impl Fn(&CallContext, Args) -> Reply + 'static,
) -> Route {
    Route {
        channel,
        kind: ChannelKind::Invoke,
        handler: Rc::new(Now(handle)),
    }
}

/// `ipcMain.handle(channel, async fn)` that answers later, from a worker:
/// `handle` keeps the responder
pub fn invoke_later(
    channel: &'static str,
    handle: impl Fn(&CallContext, Args, Responder) + 'static,
) -> Route {
    Route {
        channel,
        kind: ChannelKind::Invoke,
        handler: Rc::new(Later(handle)),
    }
}

/// `ipcMain.on(channel, fn)`: the renderer waits for nothing; an `Err` is
/// logged by the shell as Electron logged a listener's uncaught exception
pub fn send(
    channel: &'static str,
    handle: impl Fn(&CallContext, Args) -> Result<(), IpcError> + 'static,
) -> Route {
    Route {
        channel,
        kind: ChannelKind::Send,
        handler: Rc::new(Now(move |cx: &CallContext, args| {
            handle(cx, args).map(|()| IpcValue::Undefined)
        })),
    }
}
