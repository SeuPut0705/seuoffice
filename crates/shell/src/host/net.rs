//! Batch A's hosts (host/net.rs): the ports of A's channels that need nothing
//! from another batch (the slides template memory, the Zotero integration
//! over its local socket), and for every other port of A, one that answers
//! "not built yet" until its module and hosts land, so the batch registers
//! whole. The network client for `safe_remote_url` comes with the first
//! port that fetches (the AI's read-url, image and web search channels).

use shell_contract::Hosts;

use super::HostContext;

pub fn install(hosts: &mut Hosts, _cx: &HostContext) {
    hosts.insert(shell_ipc_a::template_selection::factory());
    hosts.insert(shell_ipc_a::zotero::factory());
    shell_ipc_a::insert_unbuilt_ports(hosts);
}
