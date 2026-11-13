//! The Word editor (`apps/docs/src/main/docs-main.ts` and its document recovery).

use shell_contract::ipc::RegisterError;
use shell_contract::runtime::Services;

use crate::kit::Entry;

pub(crate) fn entries(_services: &Services) -> Result<Vec<Entry>, RegisterError> {
    Ok(Vec::new())
}

/// This app's host fakes, answering from `case` (`hosts.d2.docs`)
#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(_hosts: &mut shell_contract::Hosts, _case: &serde_json::Value) {}
