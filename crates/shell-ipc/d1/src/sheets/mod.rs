//! The `sheets` channels of batch D1.

use shell_contract::ipc::RegisterError;
use shell_contract::runtime::Services;

use crate::route::Route;

pub fn routes(_services: &Services) -> Result<Vec<Route>, RegisterError> {
    Ok(Vec::new())
}

/// This app's fake hosts for [`crate::testkit::Kit`]
#[cfg(any(test, feature = "probe"))]
pub fn insert_fakes(_hosts: &mut shell_contract::Hosts) {}
