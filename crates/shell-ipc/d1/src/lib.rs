//! Stage 3 batch D1: Documents 1: slides, sheets, mind maps, diagrams. Registers a handler for every channel whose
//! spec in `shell_contract::CHANNELS` names batch D1; nothing else.

use shell_contract::ipc::{RegisterBatch, RegisterError, Registry};
use shell_contract::runtime::Services;

pub fn register(_registry: &mut dyn Registry, _services: &Services) -> Result<(), RegisterError> {
    Ok(())
}

const _: RegisterBatch = register;

/// Inserts the fakes of this batch's hosts, answering from the case's
/// `hosts.d1` value (Null when absent; tools/ipc-diff/README.md)
#[cfg(feature = "probe")]
pub fn probe_hosts(_hosts: &mut shell_contract::Hosts, _case: &serde_json::Value) {}
