//! Batch U's hosts (host/crash.rs, the crash watch): not implemented yet. `install` is the one
//! entry point of the file; the batch inserts its hosts here
//! (`hosts.insert::<Arc<dyn ...>>`), and nothing outside this file changes.

use shell_contract::Hosts;
use shell_contract::ids::ViewId;

use super::HostContext;

pub fn install(_hosts: &mut Hosts, _cx: &HostContext) {}

/// A view's main frame lost its renderer (Electron's `render-process-gone`);
/// called on the UI thread for every view. U fills it.
pub fn renderer_terminated(_view: ViewId) {}
