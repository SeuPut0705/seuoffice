//! `apps/shell/src/main/update-restart.ts`.

/// The module-level `restartRequested` of the TypeScript, held by the caller.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct UpdateRestart {
    restart_requested: bool,
}

impl UpdateRestart {
    /// `let restartRequested = false`
    pub fn new() -> Self {
        Self::default()
    }

    /// `requestUpdateRestart`
    pub fn request_update_restart(&mut self) {
        self.restart_requested = true;
    }

    /// `cancelUpdateRestart`
    pub fn cancel_update_restart(&mut self) {
        self.restart_requested = false;
    }

    /// `updateRestartRequested`
    pub fn update_restart_requested(&self) -> bool {
        self.restart_requested
    }
}

/// `reopenedByInstaller`: the caller hands over `process.argv`.
pub fn reopened_by_installer(argv: &[&str]) -> bool {
    argv.contains(&"--updated")
}
