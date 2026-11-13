//! Stage 3 batch A: AI, network and secrets. Registers a handler for every channel whose
//! spec in `shell_contract::CHANNELS` names batch A; nothing else.

use shell_contract::ipc::{RegisterBatch, RegisterError, Registry};
use shell_contract::runtime::Services;

pub fn register(_registry: &mut dyn Registry, _services: &Services) -> Result<(), RegisterError> {
    Ok(())
}

const _: RegisterBatch = register;
