//! `packages/electron-utils/src/ai-run-guard.ts`: one check the shell puts in
//! front of every editor's AI run (decision 0085). The editors' main code asks
//! it once a request's provider is known; the shell answers with a refusal to
//! show, or `None` to let the run go. With no check set (an editor running on
//! its own) every run goes.
//!
//! The TypeScript keeps the check in a module variable; here it is a value
//! the caller holds.

/// `AiRunGuardInput`
#[derive(Debug, Clone, PartialEq)]
pub struct AiRunGuardInput {
    /// the webContents that sent the request
    pub sender_id: f64,
    /// the provider the run would use
    pub provider: String,
    /// its model, `""` when the provider's default
    pub model: String,
}

/// `AiRunGuard`: the refusal for a run, or `None` when it may go.
pub type AiRunGuard = Box<dyn Fn(&AiRunGuardInput) -> Option<String>>;

/// The module variable of the TypeScript.
#[derive(Default)]
pub struct AiRunGuardSlot {
    guard: Option<AiRunGuard>,
}

impl AiRunGuardSlot {
    pub fn new() -> Self {
        Self::default()
    }

    /// `setAiRunGuard(next)`
    pub fn set_ai_run_guard(&mut self, next: Option<AiRunGuard>) {
        self.guard = next;
    }

    /// `aiRunRefusal(input)`: the refusal for this run, or `None` when it may
    /// go.
    pub fn ai_run_refusal(&self, input: &AiRunGuardInput) -> Option<String> {
        self.guard.as_ref().and_then(|guard| guard(input))
    }
}
