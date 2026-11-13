//! Stage 3 batch A: AI, network and secrets. Registers a handler for every channel whose
//! spec in `shell_contract::CHANNELS` names batch A; nothing else.

use shell_contract::ipc::{RegisterBatch, RegisterError, Registry};
use shell_contract::runtime::Services;

pub fn register(_registry: &mut dyn Registry, _services: &Services) -> Result<(), RegisterError> {
    Ok(())
}

const _: RegisterBatch = register;

/// Inserts the fakes of this batch's hosts, answering from the case's
/// `hosts.a` value (Null when absent; tools/ipc-diff/README.md)
#[cfg(feature = "probe")]
pub fn probe_hosts(_hosts: &mut shell_contract::Hosts, _case: &serde_json::Value) {}
