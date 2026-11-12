//! `apps/sheets/src/main/close-guard.ts`.

/// What `closeGuardDecision` answers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseGuardDecision {
    /// lets the window go without writing anything
    Proceed,
    /// asks the user Save / Don't Save / Cancel
    Prompt,
}

impl CloseGuardDecision {
    pub fn as_str(self) -> &'static str {
        match self {
            CloseGuardDecision::Proceed => "proceed",
            CloseGuardDecision::Prompt => "prompt",
        }
    }
}

/// `closeGuardDecision(state)`. `pending_edits` is a number the renderer
/// reported (NaN stays a prompt: `NaN <= 0` is false).
pub fn close_guard_decision(
    pending_edits: f64,
    destroyed: bool,
    shutting_down: bool,
) -> CloseGuardDecision {
    if pending_edits <= 0.0 {
        return CloseGuardDecision::Proceed;
    }
    if destroyed {
        return CloseGuardDecision::Proceed;
    }
    if shutting_down {
        return CloseGuardDecision::Proceed;
    }
    CloseGuardDecision::Prompt
}

/// `ShutdownLatch`: tracks an in-flight quit for the close guard.
#[derive(Debug, Default)]
pub struct ShutdownLatch {
    shutting_down: bool,
}

impl ShutdownLatch {
    pub fn new() -> Self {
        Self::default()
    }

    /// before-quit / SIGTERM / SIGINT seen
    pub fn mark(&mut self) {
        self.shutting_down = true;
    }

    /// the quit was vetoed (window close prevented and not proceeding)
    pub fn reset(&mut self) {
        self.shutting_down = false;
    }

    /// `get active()`
    pub fn active(&self) -> bool {
        self.shutting_down
    }
}
