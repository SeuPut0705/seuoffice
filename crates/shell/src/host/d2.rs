//! Batch D2's hosts (the hosts of the engines that are not in Rust yet): not implemented yet. `install` is the one
//! entry point of the file; the batch inserts its hosts here
//! (`hosts.insert::<Arc<dyn ...>>`), and nothing outside this file changes.

use shell_contract::Hosts;

use super::HostContext;

pub fn install(_hosts: &mut Hosts, _cx: &HostContext) {}
