//! Help > Check for Updates and the About box's check, offered to the menus
//! (M) as `shell_contract::app_actions::UpdateCheck`. The updater itself
//! (`main_core::shell::updater::Updater`) is driven by the shell's update
//! host, which implements [`UpdaterControl`].

use std::rc::Rc;
use std::sync::Arc;

use shell_contract::app_actions::UpdateCheck;

/// U's updater host. Called on the core thread.
pub trait UpdaterControl: Send + Sync {
    /// Batch U has registered: the update window takes calls, so the host
    /// starts the updater (`initAutoUpdater` at app ready)
    fn started(&self);
    /// an updater runs: a packaged build on a platform that updates itself
    fn available(&self) -> bool;
    /// `Updater::check_for_updates_now`; the host runs the step it returns
    /// (`UpdaterStep::StartCheck`) on a worker and resumes on the core thread
    fn check_now(&self);
}

pub type UpdaterControlHost = Arc<dyn UpdaterControl>;

struct Check(UpdaterControlHost);

impl UpdateCheck for Check {
    fn available(&self) -> bool {
        self.0.available()
    }

    fn check_now(&self) {
        self.0.check_now()
    }
}

pub(crate) fn provide(provided: &shell_contract::Provided, control: UpdaterControlHost) {
    provided.add::<dyn UpdateCheck>(Rc::new(Check(control)));
}
