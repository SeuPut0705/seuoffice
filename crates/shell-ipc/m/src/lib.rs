//! Stage 3 batch M: Menus, printing and app-wide settings. Registers a handler for every channel whose
//! spec in `shell_contract::CHANNELS` names batch M; nothing else.
//!
//! The handlers are ported from the Electron main process and call
//! `main-core` where it has the logic; what only a shell can do comes from
//! the hosts in [`hosts`], what the old module variables held is in
//! [`state::MState`].

pub mod hosts;
pub mod state;

mod fonts;
mod handler;
mod print;
mod settings;
mod spell;
mod value;

#[cfg(any(test, feature = "probe"))]
mod probe;
#[cfg(test)]
mod testkit;

use std::rc::Rc;

use shell_contract::IpcValue;
use shell_contract::channels::Batch;
use shell_contract::hosts::{ContentsHost, DialogsHost, MainWindowHost, OsShellHost};
use shell_contract::ipc::{RegisterBatch, RegisterError, Registry, Target};
use shell_contract::runtime::{PathName, Services};

use hosts::{FontQueriesRef, MHostRef, PeersRef};
use state::MStateRef;

pub use spell::{context_menu_command, intercept_context_menu};

/// What every handler of the batch holds
pub(crate) struct Ctx {
    pub services: Services,
    pub host: MHostRef,
    pub peers: PeersRef,
    pub fonts: FontQueriesRef,
    pub state: MStateRef,
    pub contents: ContentsHost,
    pub dialogs: DialogsHost,
    pub os: OsShellHost,
    pub main_window: MainWindowHost,
}

impl Ctx {
    fn new(services: &Services) -> Result<Self, RegisterError> {
        let hosts = &services.hosts;
        Ok(Ctx {
            services: services.clone(),
            host: hosts.need(Batch::M)?,
            peers: hosts.need(Batch::M)?,
            fonts: hosts.need(Batch::M)?,
            state: hosts.need(Batch::M)?,
            contents: hosts.need(Batch::M)?,
            dialogs: hosts.need(Batch::M)?,
            os: hosts.need(Batch::M)?,
            main_window: hosts.need(Batch::M)?,
        })
    }

    /// `app.getPath('userData')`
    pub fn user_data(&self) -> std::path::PathBuf {
        self.services.paths.path(PathName::UserData)
    }

    /// `join(app.getPath('userData'), name)` as a string, as the ports take paths
    pub fn user_data_file(&self, name: &str) -> String {
        self.user_data().join(name).to_string_lossy().into_owned()
    }

    /// `APP_SETTINGS_PATH()`
    pub fn settings_path(&self) -> String {
        self.user_data_file("app-settings.json")
    }

    pub fn emit(&self, target: Target, channel: &'static str, args: Vec<IpcValue>) {
        self.services.events.emit(target, channel, args)
    }
}

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let cx = Rc::new(Ctx::new(services)?);
    settings::register(registry, &cx)?;
    spell::register(registry, &cx)?;
    fonts::register(registry, &cx)?;
    print::register(registry, &cx)?;
    Ok(())
}

const _: RegisterBatch = register;

/// Inserts the fakes of this batch's hosts, answering from the case's
/// `hosts.m` value (Null when absent; tools/ipc-diff/README.md)
#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    probe::insert(hosts, case);
}
