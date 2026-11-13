//! `apps/markdown/src/main/wiki-fragment.ts`: where a wiki link pointed,
//! carried from the tab that followed it to the tab that shows the note.
//!
//! The TypeScript keeps one module-level `Map`; here it is a value the caller
//! owns.

use jscompat::JsMap;

/// paths whose fragment is still waiting; a click whose note is never opened must not pile up
pub const MAX_PENDING: usize = 32;

#[derive(Default)]
pub struct WikiFragments {
    pending: JsMap<String>,
}

impl WikiFragments {
    pub fn new() -> Self {
        Self::default()
    }

    /// `rememberWikiFragment(path, fragment)`
    pub fn remember_wiki_fragment(&mut self, path: &str, fragment: &str) {
        if path.is_empty() {
            return;
        }
        // a link with no fragment cancels an earlier one aimed at the same note
        if fragment.is_empty() {
            self.pending.delete(path);
            return;
        }
        while self.pending.len() >= MAX_PENDING {
            let Some(oldest) = self.pending.keys().next().map(str::to_owned) else {
                break;
            };
            self.pending.delete(&oldest);
        }
        self.pending.set(path, fragment.to_owned());
    }

    /// `takeWikiFragment(path)`
    pub fn take_wiki_fragment(&mut self, path: &str) -> String {
        if path.is_empty() {
            return String::new();
        }
        self.pending.delete(path).unwrap_or_default()
    }
}
