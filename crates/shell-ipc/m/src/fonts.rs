//! stub
use std::rc::Rc;

use shell_contract::ipc::{RegisterError, Registry};

use crate::Ctx;

pub(crate) fn register(_registry: &mut dyn Registry, _cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    Ok(())
}
