//! `apps/shell/src/main/window-close-guard.ts`: the unsaved-changes guard of
//! the shell window.
//!
//! The TypeScript installs a `close` handler on the window and walks the
//! dirty tabs through async prompts. Here the handler is a state machine the
//! caller drives: [`ShellCloseGuard::on_close`] for the event, then one
//! [`ShellCloseGuard::resume`] for each answer of an `await` it asked for
//! ([`CloseStep`]), and [`ShellCloseGuard::after_close`] once the caller has
//! run `win.close()` as asked.

use std::collections::VecDeque;

/// What the guard asks the manager for: one list of tabs per editor family,
/// in the order the handler reads them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// `dirtySheetsTabs` / `requestSheetsClose`
    Sheets,
    /// `dirtyPdfTabs` / `requestPdfClose`
    Pdf,
    /// `dirtyMarkdownTabs` / `requestMarkdownClose`
    Markdown,
    /// `dirtyHtmlTabs` / `requestHtmlClose`
    Html,
    /// `dirtyMindmapTabs` / `requestMindmapClose`
    Mindmap,
    /// `dirtyOrMemoHwpTabs` / `requestHwpClose`: a clean document with an
    /// open memo editor must be asked too
    Hwp,
    /// `dirtyEpubTabs` / `requestEpubClose`
    Epub,
    /// `dirtyDiagramTabs` / `requestDiagramClose`
    Diagram,
    /// `dirtySlidesTabs` / `requestSlidesClose`
    Slides,
    /// `docsTabs` / `requestDocsClose`: docs dirtiness lives renderer-side,
    /// so every live docs tab is queried with `docsQueryDirty` first
    Docs,
}

/// The order the handler reads the lists and walks them in.
pub const FAMILIES: [Family; 10] = [
    Family::Sheets,
    Family::Pdf,
    Family::Markdown,
    Family::Html,
    Family::Mindmap,
    Family::Hwp,
    Family::Epub,
    Family::Diagram,
    Family::Slides,
    Family::Docs,
];

/// A tab of a list: its id and its `webContents`.
#[derive(Debug, Clone, PartialEq)]
pub struct CloseGuardTab<C> {
    pub id: String,
    pub web_contents: C,
}

/// The window, the tab manager and the options of `installShellCloseGuard`,
/// as the handler uses them. A thrown value is its `String(err)`.
pub trait CloseGuardHost {
    type Contents: Clone;

    /// the manager's list of `family` (see [`Family`])
    fn tabs(&mut self, family: Family) -> Vec<CloseGuardTab<Self::Contents>>;
    /// `manager.activateTab(id)`
    fn activate_tab(&mut self, id: &str) -> Result<(), String>;
    /// `manager.beginExclusivePrompt()`
    fn begin_exclusive_prompt(&mut self);
    /// `manager.endExclusivePrompt()`
    fn end_exclusive_prompt(&mut self);
    /// `resetSheetsShuttingDown()`
    fn reset_sheets_shutting_down(&mut self);
    /// `options.onVetoed?.()`: `None` when there is no hook
    fn on_vetoed(&mut self) -> Option<Result<(), String>>;
    /// `win.isDestroyed()`
    fn is_destroyed(&mut self) -> bool;
    /// `console.error(label, err)`
    fn console_error(&mut self, label: &str, err: &str);
}

/// What the caller does next.
#[derive(Debug, Clone, PartialEq)]
pub enum CloseStep<C> {
    /// nothing is waiting
    Idle,
    /// `await docsQueryDirty(web_contents)`: answer with `resume(Ok(dirty))`
    QueryDocsDirty(C),
    /// `await requestXClose(web_contents, win)` of the family: answer with
    /// `resume(Ok(confirmed))`
    RequestClose(Family, C),
    /// the walk's first `activateTab` threw inside the async function, so the
    /// failure is a rejected promise handled one turn later (after the
    /// `close` event returned): answer with `resume(Err(message))`
    Rejected(String),
    /// call `win.close()` (its `close` event goes to `on_close` and is let
    /// through), then `after_close`
    CloseWindow,
    /// the run ended: the close was denied or failed
    Done,
}

/// What a `close` event leaves the caller to do.
#[derive(Debug, Clone, PartialEq)]
pub struct CloseEvent<C> {
    /// `event.preventDefault()` was called
    pub prevent_default: bool,
    pub step: CloseStep<C>,
}

/// One tab still to ask.
struct Pending<C> {
    family: Family,
    tab: CloseGuardTab<C>,
}

/// What the tab being asked is waiting for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// the answer of `docsQueryDirty`
    Query,
    /// the answer of `requestXClose`
    Close,
}

/// The handler of `installShellCloseGuard`.
pub struct ShellCloseGuard<C> {
    close_confirmed: bool,
    /// a second close event while the save prompts are still open (double
    /// Cmd+Q, an OS retry) must not re-enter the whole prompt chain
    close_prompt_in_flight: bool,
    /// the tabs after the one being asked, in the order they are asked
    queue: VecDeque<Pending<C>>,
    /// the tab being asked, and for what
    asking: Option<(Pending<C>, Phase)>,
}

impl<C: Clone> Default for ShellCloseGuard<C> {
    fn default() -> Self {
        Self::new()
    }
}

impl<C: Clone> ShellCloseGuard<C> {
    pub fn new() -> Self {
        ShellCloseGuard {
            close_confirmed: false,
            close_prompt_in_flight: false,
            queue: VecDeque::new(),
            asking: None,
        }
    }

    /// `vetoQuit`: the guard has put the app-ending latches back down
    /// (`resetSheetsShuttingDown` resets the shared recovery latch too); the
    /// shell resets its own quit state in `onVetoed`.
    fn veto_quit<H: CloseGuardHost<Contents = C>>(host: &mut H) {
        host.reset_sheets_shutting_down();
        if let Some(Err(err)) = host.on_vetoed() {
            host.console_error("[shell] quit veto hook failed:", &err);
        }
    }

    /// The `finally` of the prompt run.
    fn finally<H: CloseGuardHost<Contents = C>>(&mut self, host: &mut H) {
        host.end_exclusive_prompt();
        self.close_prompt_in_flight = false;
    }

    /// The `close` event of the window.
    pub fn on_close<H: CloseGuardHost<Contents = C>>(&mut self, host: &mut H) -> CloseEvent<C> {
        if self.close_confirmed {
            return CloseEvent {
                prevent_default: false,
                step: CloseStep::Idle,
            };
        }
        let lists: Vec<Vec<CloseGuardTab<C>>> = FAMILIES.iter().map(|f| host.tabs(*f)).collect();
        // Nothing to protect, so let this close event through untouched.
        // Cancelling it and re-issuing win.close() would also cancel an
        // in-flight app.quit().
        if lists.iter().all(Vec::is_empty) {
            return CloseEvent {
                prevent_default: false,
                step: CloseStep::Idle,
            };
        }
        // Only the branch that is about to prompt cancels the close. The
        // debounce below still needs that cancel before it returns, or a
        // second close would land on top of the prompt that is already open.
        if self.close_prompt_in_flight {
            return CloseEvent {
                prevent_default: true,
                step: CloseStep::Idle,
            };
        }
        self.close_prompt_in_flight = true;
        self.queue.clear();
        for (family, list) in FAMILIES.iter().zip(lists) {
            for tab in list {
                self.queue.push_back(Pending {
                    family: *family,
                    tab,
                });
            }
        }
        // activating dirty tabs animates the split layout; the arrangement
        // must come back whether the close is denied or the settle path runs
        host.begin_exclusive_prompt();
        let step = self.advance(host, true);
        CloseEvent {
            prevent_default: true,
            step,
        }
    }

    /// The answer of the `await` the last step asked for: `Ok(value)` is what
    /// the promise resolved with, `Err(thrown)` what it rejected with.
    pub fn resume<H: CloseGuardHost<Contents = C>>(
        &mut self,
        host: &mut H,
        answer: Result<bool, String>,
    ) -> CloseStep<C> {
        let Some((asked, phase)) = self.asking.take() else {
            return CloseStep::Idle;
        };
        let value = match answer {
            Err(err) => return self.fail(host, &err),
            Ok(value) => value,
        };
        match phase {
            Phase::Query => {
                if !value {
                    return self.advance(host, false);
                }
                if let Err(err) = host.activate_tab(&asked.tab.id) {
                    return self.fail(host, &err);
                }
                let step = CloseStep::RequestClose(asked.family, asked.tab.web_contents.clone());
                self.asking = Some((asked, Phase::Close));
                step
            }
            Phase::Close => {
                if !value {
                    // a denied close vetoes any quit that was in flight: the
                    // sheets close guard must prompt again on later closes
                    // instead of silently proceeding
                    self.queue.clear();
                    Self::veto_quit(host);
                    self.finally(host);
                    return CloseStep::Done;
                }
                self.advance(host, false)
            }
        }
    }

    /// After the caller ran `win.close()` for [`CloseStep::CloseWindow`].
    pub fn after_close<H: CloseGuardHost<Contents = C>>(&mut self, host: &mut H) -> CloseStep<C> {
        self.finally(host);
        CloseStep::Done
    }

    /// A throw aborts the close like a denial: the window stays open, so the
    /// quit that may have latched sheets as shutting down is vetoed too.
    fn fail<H: CloseGuardHost<Contents = C>>(&mut self, host: &mut H, err: &str) -> CloseStep<C> {
        self.queue.clear();
        host.console_error("[shell] window close prompt failed:", err);
        Self::veto_quit(host);
        self.finally(host);
        CloseStep::Done
    }

    /// Takes the next tab of the walk and asks for it, or confirms the close
    /// when the walk is over.
    fn advance<H: CloseGuardHost<Contents = C>>(
        &mut self,
        host: &mut H,
        first: bool,
    ) -> CloseStep<C> {
        let Some(next) = self.queue.pop_front() else {
            // nobody denied it
            self.close_confirmed = true;
            if host.is_destroyed() {
                self.finally(host);
                return CloseStep::Done;
            }
            return CloseStep::CloseWindow;
        };
        if next.family == Family::Docs {
            let contents = next.tab.web_contents.clone();
            self.asking = Some((next, Phase::Query));
            return CloseStep::QueryDocsDirty(contents);
        }
        if let Err(err) = host.activate_tab(&next.tab.id) {
            if first {
                // the throw happens before the first `await` of the walk:
                // the walk's promise rejects, and the catch runs a turn later
                self.asking = Some((next, Phase::Close));
                return CloseStep::Rejected(err);
            }
            return self.fail(host, &err);
        }
        let step = CloseStep::RequestClose(next.family, next.tab.web_contents.clone());
        self.asking = Some((next, Phase::Close));
        step
    }
}
