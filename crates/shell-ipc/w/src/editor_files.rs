//! Batch W channels: see lib.rs for which.

use shell_contract::ipc::{RegisterError, Registry};
use shell_contract::runtime::Services;

pub fn register(_registry: &mut dyn Registry, _services: &Services) -> Result<(), RegisterError> {
    Ok(())
}

#[cfg(feature = "probe")]
pub fn probe_hosts(_hosts: &mut shell_contract::Hosts, _case: &serde_json::Value) {}
