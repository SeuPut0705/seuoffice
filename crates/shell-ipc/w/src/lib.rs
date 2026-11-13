//! Stage 3 batch W: windows, tabs and the re-created preloads. Registers a
//! handler for every channel whose spec in `shell_contract::CHANNELS` names
//! batch W; nothing else.

mod convert;
pub mod quick_look;

use std::rc::Rc;

use shell_contract::error::IpcError;
use shell_contract::ipc::{
    CallContext, ChannelKind, Handler, RegisterBatch, RegisterError, Registry, Responder,
};
use shell_contract::runtime::Services;
use shell_contract::{Batch, IpcValue};

/// A handler that answers before it returns, as an `ipcMain` listener with
/// no `await`
struct Sync<F>(F);

impl<F> Handler for Sync<F>
where
    F: Fn(&CallContext, Vec<IpcValue>) -> Result<IpcValue, IpcError>,
{
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        reply.reply((self.0)(cx, args))
    }
}

fn handle(
    registry: &mut dyn Registry,
    channel: &'static str,
    kind: ChannelKind,
    f: impl Fn(&CallContext, Vec<IpcValue>) -> Result<IpcValue, IpcError> + 'static,
) -> Result<(), RegisterError> {
    registry.register(Batch::W, channel, kind, Rc::new(Sync(f)))
}

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    quick_look::register(registry, services)
}

const _: RegisterBatch = register;

/// Inserts the fakes of this batch's hosts, answering from the case's
/// `hosts.w` value (Null when absent; tools/ipc-diff/README.md)
#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, _case: &serde_json::Value) {
    let runtime: quick_look::QuickLookHost = std::sync::Arc::new(quick_look::probe::NoRuntime);
    hosts.insert(runtime);
}
