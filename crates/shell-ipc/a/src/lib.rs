//! Stage 3 batch A: AI, network and secrets. Registers a handler for every channel whose
//! spec in `shell_contract::CHANNELS` names batch A; nothing else.
//!
//! Each TypeScript main module that answers batch A channels is a port
//! ([`ports`]). The shell inserts a [`Factory`] for every port in its hosts;
//! a shell built without one refuses to start, naming it.

mod port;
pub mod ports;
#[cfg(feature = "probe")]
mod probe;
pub mod secrets;

use shell_contract::Batch;
use shell_contract::ipc::{RegisterBatch, RegisterError, Registry};
use shell_contract::runtime::Services;

pub use port::{Factory, Port, PortChannel};

/// Calls `$then!` with every port trait of the batch
macro_rules! all_ports {
    ($then:ident) => {
        $then!(
            AgentWindow,
            AiCore,
            AiNaming,
            AppAi,
            AppAiImage,
            Drive,
            FreeAi,
            GenerateWindow,
            Integrations,
            KnowledgeBase,
            McpDocumentBridges,
            McpHub,
            Outbound,
            PdfStructure,
            ShellAiPrefs,
            SlidesAi,
            SlidesAiProposal,
            SlidesTemplateSelection,
            Subscription,
            TemplateTabs,
            UserSkills,
            Zotero
        )
    };
}

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    macro_rules! register_each {
        ($($port:ident),*) => {$(
            let factory = services.hosts.need::<Factory<dyn ports::$port>>(Batch::A)?;
            port::register_port(registry, (factory.0)(services))?;
        )*};
    }
    all_ports!(register_each);
    Ok(())
}

const _: RegisterBatch = register;

/// Every port: the module it stands for and its channels
pub fn port_table() -> Vec<(&'static str, &'static [PortChannel])> {
    macro_rules! table {
        ($($port:ident),*) => {
            vec![$((
                <dyn ports::$port as Port>::SOURCE,
                <dyn ports::$port as Port>::CHANNELS,
            )),*]
        };
    }
    all_ports!(table)
}

/// Inserts the fakes of this batch's hosts, answering from the case's
/// `hosts.a` value (Null when absent; tools/ipc-diff/README.md)
#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    use std::rc::Rc;
    macro_rules! insert_each {
        ($($port:ident),*) => {$(
            let answers = case.clone();
            hosts.insert(Factory::<dyn ports::$port>::new(move |_| {
                Rc::new(probe::Fake::new(&answers))
            }));
        )*};
    }
    all_ports!(insert_each);
}
