//! `apps/shell/src/main/document-password-prompt.ts`.
//!
//! The TypeScript chains the prompts through promises: each one awaits the
//! promise its predecessor resolves on `close`. Here the module-level `queue`
//! is a [`DocumentPasswordPrompts`] value and the continuation of an `ask`
//! that had to wait is run by the `close` that released it: [`close`] returns
//! the asks it resumed, in the order the promises would continue.
//!
//! [`close`]: DocumentPasswordPrompts::close

/// `DocumentPasswordWindow`
pub trait DocumentPasswordWindow {
    /// the typed password, or `None` when the user cancels
    fn prompt(&mut self, file_name: &str, retry: bool) -> Option<String>;
    fn close(&mut self);
}

/// The prompt `createDocumentPasswordPrompt` returned, by the order it was created in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptId(usize);

/// One call of `ask`, by the order the calls were made in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AskId(usize);

/// An `ask` that waited for its turn and has settled now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumedAsk {
    pub ask: AskId,
    pub answer: Option<String>,
}

/// What `ask` did at once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Asked {
    /// the prompt had its turn: this is what the promise resolves to
    Settled(Option<String>),
    /// the previous prompt is still open: a `close` of it resumes this ask
    Waiting,
}

struct Prompt {
    window: Box<dyn DocumentPasswordWindow>,
    file_name: String,
    /// the prompt whose `release` this one's `turn` is; `None` for the first
    turn: Option<usize>,
    /// `release()` was called: the promise the next prompt awaits is resolved
    released: bool,
    shown: bool,
    closed: bool,
    /// the asks waiting for `turn`, with their `retry`
    waiting: Vec<(AskId, bool)>,
}

/// The module-level `queue` and the prompts chained on it.
#[derive(Default)]
pub struct DocumentPasswordPrompts {
    prompts: Vec<Prompt>,
    asks: usize,
}

impl DocumentPasswordPrompts {
    pub fn new() -> Self {
        Self::default()
    }

    /// `createDocumentPasswordPrompt(window, fileName)`
    pub fn create(&mut self, window: Box<dyn DocumentPasswordWindow>, file_name: &str) -> PromptId {
        let turn = self.prompts.len().checked_sub(1);
        self.prompts.push(Prompt {
            window,
            file_name: file_name.to_string(),
            turn,
            released: false,
            shown: false,
            closed: false,
            waiting: Vec::new(),
        });
        PromptId(self.prompts.len() - 1)
    }

    fn has_turn(&self, id: usize) -> bool {
        match self.prompts[id].turn {
            None => true,
            Some(before) => self.prompts[before].released,
        }
    }

    /// `prompt.ask(retry)`: after `await turn`, `null` for a closed prompt,
    /// else the window's answer
    fn run_ask(&mut self, id: usize, retry: bool) -> Option<String> {
        let prompt = &mut self.prompts[id];
        if prompt.closed {
            return None;
        }
        prompt.shown = true;
        prompt.window.prompt(&prompt.file_name, retry)
    }

    /// `prompt.ask(retry)`
    pub fn ask(&mut self, prompt: PromptId, retry: bool) -> (AskId, Asked) {
        let ask = AskId(self.asks);
        self.asks += 1;
        if self.has_turn(prompt.0) {
            return (ask, Asked::Settled(self.run_ask(prompt.0, retry)));
        }
        self.prompts[prompt.0].waiting.push((ask, retry));
        (ask, Asked::Waiting)
    }

    /// `prompt.close()` (idempotent): the window closes only for a prompt
    /// that showed, then the promise of this prompt resolves and the asks of
    /// the next one that were waiting for it continue.
    pub fn close(&mut self, prompt: PromptId) -> Vec<ResumedAsk> {
        let id = prompt.0;
        if self.prompts[id].closed {
            return Vec::new();
        }
        self.prompts[id].closed = true;
        // a prompt that never showed must not close another caller's window
        if self.prompts[id].shown {
            self.prompts[id].window.close();
        }
        self.prompts[id].released = true;
        let mut resumed = Vec::new();
        for next in 0..self.prompts.len() {
            if self.prompts[next].turn != Some(id) {
                continue;
            }
            for (ask, retry) in std::mem::take(&mut self.prompts[next].waiting) {
                let answer = self.run_ask(next, retry);
                resumed.push(ResumedAsk { ask, answer });
            }
        }
        resumed
    }
}
