//! Stage 3 batch D1: Documents 1: slides, sheets, mind maps, diagrams.
//! Registers a handler for every channel whose spec in
//! `shell_contract::CHANNELS` names batch D1; nothing else.
//!
//! One module per app, each a port of the `ipcMain` handlers of that app's
//! main process. A handler keeps the TypeScript's control flow (argument
//! checks, per-view state, dialogs, files, events) and calls `main-core`
//! where the module is ported; what is not in Rust yet sits behind the app's
//! own host trait, which the shell inserts into `Services.hosts`.

pub mod diagram;
pub mod host;
pub mod mindmap;
pub mod route;
pub mod sheets;
pub mod slides;
#[cfg(any(test, feature = "probe"))]
pub mod testkit;
pub mod value;

use shell_contract::Batch;
use shell_contract::ipc::{RegisterBatch, RegisterError, Registry};
use shell_contract::runtime::Services;

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let apps = [
        diagram::routes(services, &registry.provided())?,
        mindmap::routes(services, &registry.provided())?,
        sheets::routes(services, &registry.provided())?,
        slides::routes(services, &registry.provided())?,
    ];
    for route in apps.into_iter().flatten() {
        registry.register(Batch::D1, route.channel, route.kind, route.handler)?;
    }
    Ok(())
}

const _: RegisterBatch = register;

/// Every app's fake hosts, for a [`testkit::Kit`] that registers the batch
#[cfg(any(test, feature = "probe"))]
pub fn insert_fakes(hosts: &mut shell_contract::Hosts) {
    diagram::insert_fakes(hosts, &serde_json::Value::Null);
    mindmap::insert_fakes(hosts, &serde_json::Value::Null);
    sheets::insert_fakes(hosts, &serde_json::Value::Null);
    slides::insert_fakes(hosts, &serde_json::Value::Null);
}

/// Inserts the fakes of this batch's hosts, answering from the case's
/// `hosts.d1` value (Null when absent; tools/ipc-diff/README.md)
#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    use std::sync::Arc;
    hosts.insert::<host::LocaleHost>(Arc::new(testkit::FixedLocale(
        main_core::packages::i18n::Lang::En,
    )));
    hosts.insert::<Arc<host::Shared>>(Arc::default());
    diagram::insert_fakes(hosts, case);
    mindmap::insert_fakes(hosts, case);
    sheets::insert_fakes(hosts, case);
    slides::insert_fakes(hosts, case);
}

#[cfg(test)]
mod tests {
    use shell_contract::ipc::ChannelKind;
    use shell_contract::{Batch, CHANNELS};

    use crate::testkit::{Kit, registered, temp_dir};

    /// Acceptance 1 of the contract: every invoke, send and sendSync channel
    /// of D1 has a handler, registered under the shell's start rules
    #[test]
    fn every_d1_channel_is_registered() {
        let kit = Kit::new(&temp_dir("all"), crate::insert_fakes);
        let registry = registered(&kit);
        let missing: Vec<&str> = CHANNELS
            .iter()
            .filter(|spec| spec.batch == Batch::D1)
            .filter(|spec| spec.kinds.iter().any(|k| *k != ChannelKind::Event))
            .filter(|spec| !registry.handlers.contains_key(spec.name))
            .map(|spec| spec.name)
            .collect();
        assert!(missing.is_empty(), "unregistered D1 channels: {missing:?}");
    }
}
