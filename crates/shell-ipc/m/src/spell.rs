//! stub
use std::rc::Rc;

use main_core::packages::electron_utils::context_menu::{ContextMenuParams, MenuCommand};
use shell_contract::ViewId;
use shell_contract::ipc::{RegisterError, Registry};
use shell_contract::runtime::Services;

use crate::Ctx;

pub(crate) fn register(_registry: &mut dyn Registry, _cx: &Rc<Ctx>) -> Result<(), RegisterError> {
    Ok(())
}

pub fn intercept_context_menu(_services: &Services, _view: ViewId, _params: &ContextMenuParams) -> bool {
    false
}

pub fn context_menu_command(_services: &Services, _view: ViewId, command: MenuCommand) -> Option<MenuCommand> {
    Some(command)
}
