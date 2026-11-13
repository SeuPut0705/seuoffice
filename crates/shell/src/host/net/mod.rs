//! Batch A's hosts (host/net): the network of the AI runtime ([`http::HttpNet`]:
//! reqwest for `fetch`, hyper for the loopback servers of sign-ins, on
//! Tauri's tokio runtime) and the ports of A's channels. A port whose module
//! is not built has no factory, so the shell refuses to start
//! (`MissingHost`), unless it is started partial (`SEUOFFICE_SHELL_PARTIAL=1`):
//! then such a port answers "not built yet" and the built ones work.

use std::sync::Arc;

use shell_contract::Hosts;

use super::HostContext;

pub mod http;

pub fn install(hosts: &mut Hosts, _cx: &HostContext) {
    let spawn: http::Spawn = Arc::new(|future| {
        tauri::async_runtime::spawn(future);
    });
    let net: shell_ipc_a::NetHost = Arc::new(http::HttpNet::new(spawn));
    hosts.insert(net);
    hosts.insert(shell_ipc_a::template_selection::factory());
    hosts.insert(shell_ipc_a::zotero::factory());
    if std::env::var(crate::PARTIAL_ENV).is_ok_and(|v| v == "1") {
        shell_ipc_a::insert_unbuilt_ports(hosts);
    }
}
