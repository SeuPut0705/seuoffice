//! Batch M's hosts (host/menu.rs, the app menu, the context menus and the shortcuts, and the theme): not implemented yet. `install` is the one
//! entry point of the file; the batch inserts its hosts here
//! (`hosts.insert::<Arc<dyn ...>>`), and nothing outside this file changes.

use shell_contract::Hosts;

use super::HostContext;

pub fn install(_hosts: &mut Hosts, _cx: &HostContext) {}
