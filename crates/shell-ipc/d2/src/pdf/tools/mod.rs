//! The shell's PDF tools: structure jobs and the result store, the tools window, the password dialog, the conversion screen, `pdf:convert-office`.

use shell_contract::ipc::RegisterError;
use shell_contract::runtime::Services;

use super::Grants;
use crate::kit::Entry;

pub(crate) fn entries(_services: &Services, _grants: &Grants) -> Result<Vec<Entry>, RegisterError> {
    Ok(Vec::new())
}

/// The fakes of this part's hosts, answering from `case` (`hosts.d2.pdf`)
#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(_hosts: &mut shell_contract::Hosts, _case: &serde_json::Value) {}
