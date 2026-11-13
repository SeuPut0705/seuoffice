//! The HTML editor (`apps/html/src/main/html-main.ts`, `seed-main.ts`, `generate-handoff-ipc.ts`).

use std::rc::Rc;

use shell_contract::Provided;
use shell_contract::ipc::RegisterError;
use shell_contract::runtime::Services;

use crate::kit::Entry;

pub(crate) fn entries(
    _services: &Services,
    _provided: &Rc<Provided>,
) -> Result<Vec<Entry>, RegisterError> {
    Ok(Vec::new())
}

/// This app's host fakes, answering from `case` (`hosts.d2.html`)
#[cfg(any(test, feature = "probe"))]
pub(crate) fn fakes(_hosts: &mut shell_contract::Hosts, _case: &serde_json::Value) {}
