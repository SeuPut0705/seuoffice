//! The Hangul editor (`apps/hwp/src/main/hwp-main.ts`, `recovery.ts`, `attachments-ipc.ts`, `ai-image.ts`).

use shell_contract::ipc::RegisterError;
use shell_contract::runtime::Services;

use crate::kit::Entry;

pub(crate) fn entries(_services: &Services) -> Result<Vec<Entry>, RegisterError> {
    Ok(Vec::new())
}

/// This app's host fakes, answering from `case` (`hosts.d2.hwp`)
#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(_hosts: &mut shell_contract::Hosts, _case: &serde_json::Value) {}
