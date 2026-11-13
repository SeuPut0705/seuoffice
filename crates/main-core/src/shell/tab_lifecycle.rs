//! `apps/shell/src/main/tab-lifecycle.ts`.
//!
//! `closeTab` is a promise in the TypeScript that may wait for a renderer's
//! answer (an unsaved-changes prompt); here closing in order is a run the
//! caller drives: [`CloseInOrder::start`] and [`CloseInOrder::resume`] say
//! which tab to close next, and the caller resumes once that close settled.

/// `MAX_RECENTLY_CLOSED`
pub const MAX_RECENTLY_CLOSED: f64 = 20.0;

/// `TabCloseTarget`
#[derive(Debug, Clone, PartialEq)]
pub struct TabCloseTarget {
    pub id: String,
    pub kind: Option<String>,
    /// `closable?: boolean`
    pub closable: Option<bool>,
}

/// The tab list of `TabCloseManager`; its `closeTab` is the caller's, asked
/// for by [`CloseInOrderStep::CloseTab`].
pub trait TabCloseManager {
    fn list(&mut self) -> Vec<TabCloseTarget>;
}

/// What the run of `closeTabsInOrder` asks the caller to do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseInOrderStep {
    /// `await tabs.closeTab(id)`: then call [`CloseInOrder::resume`]
    CloseTab(String),
    /// the run ended
    Done,
}

/// `closeTabsInOrder(tabs, ids)`: closes tabs one after another. Skips tabs
/// that no longer exist, are marked unclosable, or are `home`. When a tab is
/// still in the list after its close settled (a cancelled close
/// confirmation) the run stops and leaves all remaining tabs open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseInOrder {
    ids: Vec<String>,
    /// the index of the next id to look at
    next: usize,
    /// the id whose close the caller carries out
    closing: Option<String>,
}

impl CloseInOrder {
    pub fn start(tabs: &mut dyn TabCloseManager, ids: &[String]) -> (Self, CloseInOrderStep) {
        let mut run = CloseInOrder {
            ids: ids.to_vec(),
            next: 0,
            closing: None,
        };
        let step = run.advance(tabs);
        (run, step)
    }

    /// The close asked for settled (closed, or cancelled): continue.
    pub fn resume(&mut self, tabs: &mut dyn TabCloseManager) -> CloseInOrderStep {
        let Some(id) = self.closing.take() else {
            return CloseInOrderStep::Done;
        };
        if tabs.list().iter().any(|tab| tab.id == id) {
            self.next = self.ids.len();
            return CloseInOrderStep::Done;
        }
        self.advance(tabs)
    }

    fn advance(&mut self, tabs: &mut dyn TabCloseManager) -> CloseInOrderStep {
        while self.next < self.ids.len() {
            let id = self.ids[self.next].clone();
            self.next += 1;
            let list = tabs.list();
            let Some(target) = list.iter().find(|tab| tab.id == id) else {
                continue;
            };
            if target.id == "home" || target.closable == Some(false) {
                continue;
            }
            self.closing = Some(id.clone());
            return CloseInOrderStep::CloseTab(id);
        }
        CloseInOrderStep::Done
    }
}

/// `ClosedTabEntry`
#[derive(Debug, Clone, PartialEq)]
pub struct ClosedTabEntry {
    pub kind: String,
    pub file_path: String,
}

/// `createRecentlyClosedTracker`: recently closed document files with a
/// bounded history stack.
#[derive(Debug, Clone)]
pub struct RecentlyClosedTracker {
    stack: Vec<ClosedTabEntry>,
    max_entries: f64,
}

/// `createRecentlyClosedTracker(maxEntries)`; the default is
/// [`MAX_RECENTLY_CLOSED`].
pub fn create_recently_closed_tracker(max_entries: f64) -> RecentlyClosedTracker {
    RecentlyClosedTracker {
        stack: Vec::new(),
        max_entries,
    }
}

impl RecentlyClosedTracker {
    /// `push`: filters out untitled documents, `home` and `help`; a repeated
    /// path moves to the top of the stack.
    pub fn push(&mut self, kind: Option<&str>, file_path: Option<&str>) {
        let Some(file_path) = file_path.filter(|path| !path.is_empty()) else {
            return;
        };
        if kind == Some("home") || kind == Some("help") {
            return;
        }
        if let Some(at) = self.stack.iter().position(|e| e.file_path == file_path) {
            self.stack.remove(at);
        }
        self.stack.push(ClosedTabEntry {
            kind: kind.unwrap_or("docs").to_owned(),
            file_path: file_path.to_owned(),
        });
        if self.stack.len() as f64 > self.max_entries {
            self.stack.remove(0);
        }
    }

    /// `reopenNext`: skips files that no longer exist on disk.
    pub fn reopen_next(
        &mut self,
        open_document: &mut dyn FnMut(&str) -> bool,
        mut file_exists: Option<&mut dyn FnMut(&str) -> bool>,
    ) -> bool {
        while let Some(closed) = self.stack.pop() {
            if let Some(exists) = file_exists.as_mut()
                && !exists(&closed.file_path)
            {
                continue;
            }
            if open_document(&closed.file_path) {
                return true;
            }
        }
        false
    }

    /// `getEntries`
    pub fn get_entries(&self) -> &[ClosedTabEntry] {
        &self.stack
    }

    /// `clear`
    pub fn clear(&mut self) {
        self.stack.clear();
    }
}
