//! Stage 3 batch U: updates, install, crash and recovery. Registers a handler
//! for every channel whose spec in `shell_contract::CHANNELS` names batch U;
//! nothing else. The updater, the installer settings, single instance, file
//! association, opening from the command line and the crash watch are host
//! work in `crates/shell` and have no channels.

use std::rc::Rc;

use shell_contract::ipc::{
    CallContext, Handler, RegisterBatch, RegisterError, Registry, Responder,
};
use shell_contract::runtime::Services;
use shell_contract::{Batch, IpcValue, MainWindowHost};

pub mod launch_list;
#[cfg(feature = "probe")]
mod probe;
pub mod update_window;
mod value;

pub use update_window::{UpdateWindowSpec, UpdateWindows, UpdateWindowsHost};

struct FnHandler<F>(F);

impl<F: Fn(&CallContext, Vec<IpcValue>, Responder)> Handler for FnHandler<F> {
    fn call(&self, cx: &CallContext, args: Vec<IpcValue>, reply: Responder) {
        (self.0)(cx, args, reply)
    }
}

fn handler(f: impl Fn(&CallContext, Vec<IpcValue>, Responder) + 'static) -> Rc<dyn Handler> {
    Rc::new(FnHandler(f))
}

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let main_window: MainWindowHost = services.hosts.need(Batch::U)?;
    let windows: UpdateWindowsHost = services.hosts.need(Batch::U)?;
    let window =
        update_window::UpdateWindow::new(services.events.clone(), windows, main_window.clone());
    update_window::register(registry, window)?;
    launch_list::register(registry, launch_list::LaunchList::new(main_window))?;
    #[cfg(feature = "probe")]
    probe::seed(&services.hosts);
    Ok(())
}

const _: RegisterBatch = register;

/// Inserts the fakes of this batch's hosts, answering from the case's
/// `hosts.u` value (Null when absent; tools/ipc-diff/README.md)
#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    probe::hosts(hosts, case)
}

#[cfg(test)]
mod tests;
