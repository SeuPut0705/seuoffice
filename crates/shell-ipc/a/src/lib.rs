//! Stage 3 batch A: AI, network and secrets. Registers a handler for every channel whose
//! spec in `shell_contract::CHANNELS` names batch A; nothing else.
//!
//! Each TypeScript main module that answers batch A channels is a port
//! ([`ports`]). The shell inserts a [`Factory`] for every port in its hosts;
//! a shell built without one refuses to start, naming it.

pub mod integrations;
pub mod knowledge_base;
pub mod outbound;
mod port;
pub mod ports;
#[cfg(feature = "probe")]
mod probe;
pub mod secrets;
pub mod shell_ai_prefs;
pub mod template_selection;
mod value;
pub mod zotero;

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
    let provided = registry.provided();
    macro_rules! register_each {
        ($($port:ident),*) => {$(
            let factory = services.hosts.need::<Factory<dyn ports::$port>>(Batch::A)?;
            port::register_port(registry, (factory.0)(services, &provided)?)?;
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

/// Inserts a fake for every port, answering each channel from `answers`
/// (`probe::Fake`): what a port not yet ported stands on in the probe
#[cfg(feature = "probe")]
pub fn fake_ports(hosts: &mut shell_contract::Hosts, answers: &serde_json::Value) {
    use std::rc::Rc;
    macro_rules! insert_each {
        ($($port:ident),*) => {$(
            let given = answers.clone();
            hosts.insert(Factory::<dyn ports::$port>::new(move |_, _| {
                Ok(Rc::new(probe::Fake::new(&given)))
            }));
        )*};
    }
    all_ports!(insert_each);
}

/// Inserts the fakes of this batch's hosts, answering from the case's
/// `hosts.a` value (Null when absent; tools/ipc-diff/README.md): the ported
/// modules over fakes of their batch-only hosts, the others as
/// [`fake_ports`] answering from `hosts.a.fake`
#[cfg(feature = "probe")]
pub fn probe_hosts(hosts: &mut shell_contract::Hosts, case: &serde_json::Value) {
    fake_ports(hosts, &case["fake"]);
    let log = hosts.get::<probe::Log>().cloned();
    hosts.insert(shell_ai_prefs::factory());
    hosts.insert::<shell_ai_prefs::ShellUiHost>(std::sync::Arc::new(probe::FakeShellUi::new(
        case, log,
    )));
}
