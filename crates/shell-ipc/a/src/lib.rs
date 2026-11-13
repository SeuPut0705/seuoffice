//! Stage 3 batch A: AI, network and secrets. Registers a handler for every channel whose
//! spec in `shell_contract::CHANNELS` names batch A; nothing else.
//!
//! Each TypeScript main module that answers batch A channels is a port
//! ([`ports`]). The shell inserts a [`Factory`] for every port in its hosts;
//! a shell built without one refuses to start, naming it.

pub mod agent;
pub mod ai_naming;
pub mod app_ai_image;
pub mod drive;
pub mod free_ai;
pub mod generate;
pub mod integrations;
pub mod knowledge_base;
pub mod mcp;
pub mod outbound;
mod port;
pub mod ports;
#[cfg(feature = "probe")]
mod probe;
pub mod runtime;
pub mod secrets;
pub mod shell_ai_prefs;
pub mod slides_ai;
pub mod subscription;
pub mod template_selection;
mod unbuilt;
pub mod user_skills;
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

/// The executor of main-core's AI runtime the shell inserts (`host/net.rs`):
/// the network the driver's fetches and servers go through
pub type NetHost = runtime::NetHost;

pub fn register(registry: &mut dyn Registry, services: &Services) -> Result<(), RegisterError> {
    let provided = registry.provided();
    // one driver of the AI runtime for every port, on the core thread
    if provided.all::<runtime::Driver>().is_empty() {
        let net = services.hosts.need::<NetHost>(Batch::A)?;
        provided.add(std::rc::Rc::new(runtime::Driver::new(services, net)));
    }
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

/// Inserts, for every port the shell has no factory for, one whose channels
/// reject with "not built yet": for a shell started partial only (a normal
/// start must stop on the missing factory), after the real factories, so the
/// batch registers whole and the built ports answer
pub fn insert_unbuilt_ports(hosts: &mut shell_contract::Hosts) {
    macro_rules! insert_each {
        ($($port:ident),*) => {$(
            if hosts.get::<Factory<dyn ports::$port>>().is_none() {
                let source = <dyn ports::$port as Port>::SOURCE;
                hosts.insert(Factory::<dyn ports::$port>::new(move |_, _| {
                    Ok(std::rc::Rc::new(unbuilt::Unbuilt(source)))
                }));
            }
        )*};
    }
    all_ports!(insert_each);
}

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
    let net: NetHost = runtime::testing::FakeNet::new(&case["net"], log.clone());
    hosts.insert(net);
    hosts.insert(shell_ai_prefs::factory());
    hosts.insert(outbound::factory());
    hosts.insert::<outbound::OutboundShellHost>(std::sync::Arc::new(
        probe::FakeOutboundShell::new(case),
    ));
    probe::drive::insert(hosts, case, log.clone());
    probe::integrations::insert(hosts, case, log.clone());
    probe::knowledge_base::insert(hosts, case, log.clone());
    probe::zotero::insert(hosts, case, log.clone());
    probe::agent::insert(hosts, case, log.clone());
    probe::ai_naming::insert(hosts, case, log.clone());
    probe::free_ai::insert(hosts, case, log.clone());
    probe::generate::insert(hosts, case, log.clone());
    probe::mcp::insert(hosts, case, log.clone());
    probe::slides_ai::insert(hosts, case, log.clone());
    probe::user_skills::insert(hosts, case, log.clone());
    probe::app_ai_image::insert(hosts, case, log.clone());
    probe::subscription::insert(hosts, case, log.clone());
    hosts.insert::<shell_ai_prefs::ShellUiHost>(std::sync::Arc::new(probe::FakeShellUi::new(
        case, log,
    )));
}

/// Runs the named trigger of this batch for an event no channel call
/// reaches (tools/ipc-diff `trigger` cases); `false` for a name it does not
/// know: the skills dropped on a window (`a/skills-drop`).
#[cfg(feature = "probe")]
pub fn probe_trigger(
    name: &str,
    _view: shell_contract::ViewId,
    args: &serde_json::Value,
    _services: &Services,
    provided: &std::rc::Rc<shell_contract::Provided>,
    then: shell_contract::editors::Then<shell_contract::IpcValue>,
) -> bool {
    user_skills::probe_trigger(name, args, provided, then)
}
