//! Batch U's hosts (host/os.rs, the file associations, the single instance and the command line): not implemented yet. `install` is the one
//! entry point of the file; the batch inserts its hosts here
//! (`hosts.insert::<Arc<dyn ...>>`), and nothing outside this file changes.

use shell_contract::Hosts;

use super::HostContext;

pub fn install(_hosts: &mut Hosts, _cx: &HostContext) {}
