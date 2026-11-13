//! Stage 3 batch W: windows, tabs and the re-created preloads. Registers a
//! handler for every channel whose spec in `shell_contract::CHANNELS` names
//! batch W; nothing else.

mod convert;
/// `doc-picker:*`: the document picker window
pub mod doc_picker;
/// `files:*`, `win:*` (docs-main), `doc:*` attachments, `shell:*` (sheets-main)
pub mod editor_files;
/// home's files and folders: recents, starred, folder roots and tree, search, open, reveal, move, rename, delete
pub mod home_files;
/// home's settings and app facts: `home:get-*`/`home:set-*`, onboarding, MCP status and logs, help links
pub mod home_settings;
/// `projectFolder:*` and `project:*`
pub mod projects;
/// `quick-look:*`
pub mod quick_look;
/// `tabs:*`, `app:get-split-role`, `app:view-focused`, `app:open-dropped-files`, `home:new-*`
pub mod tabs;

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
    doc_picker::register(registry, services)?;
    editor_files::register(registry, services)?;
    home_files::register(registry, services)?;
    home_settings::register(registry, services)?;
    projects::register(registry, services)?;
    quick_look::register(registry, services)?;
    tabs::register(registry, services)
}

const _: RegisterBatch = register;

/// Inserts the fakes of this batch's hosts, answering from the case's
/// `hosts.w` value (Null when absent; tools/ipc-diff/README.md)
#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    doc_picker::probe_hosts(hosts, case);
    editor_files::probe_hosts(hosts, case);
    home_files::probe_hosts(hosts, case);
    home_settings::probe_hosts(hosts, case);
    projects::probe_hosts(hosts, case);
    quick_look::probe_hosts(hosts, case);
    tabs::probe_hosts(hosts, case);
}
