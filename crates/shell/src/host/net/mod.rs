//! Batch A's hosts (host/net.rs): the ports of A's channels that need nothing
//! from another batch (the slides template memory, the Zotero integration
//! over its local socket). A port whose module is not built has no factory,
//! so the shell refuses to start (`MissingHost`), unless it is started
//! partial (`SEUOFFICE_SHELL_PARTIAL=1`): then such a port answers "not built
//! yet" and the built ones work. The network client for `safe_remote_url`
//! comes with the first port that fetches (the AI's read-url, image and web
//! search channels).

use shell_contract::Hosts;

use super::HostContext;

pub fn install(hosts: &mut Hosts, _cx: &HostContext) {
    hosts.insert(shell_ipc_a::template_selection::factory());
    hosts.insert(shell_ipc_a::zotero::factory());
    if std::env::var(crate::PARTIAL_ENV).is_ok_and(|v| v == "1") {
        shell_ipc_a::insert_unbuilt_ports(hosts);
    }
}
