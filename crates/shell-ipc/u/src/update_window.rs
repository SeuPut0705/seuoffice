//! `apps/shell/src/main/update-window.ts`: the update window's lifecycle, the
//! state it shows, and its channels. The updater (`main_core::shell::updater`,
//! driven by the shell's update host) shows, patches and closes the window
//! through [`UpdateWindow`]; the window and the shell window's Settings ask
//! and act through the `update:*` channels.
//!
//! As in the TypeScript, `update:get-state` and `update:open-for-update`
//! answer from the start (Settings asks on mount, before any update is
//! known), while the dialog's own four channels answer only once the window
//! was shown: before that Electron had no handler for them.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use main_core::shell::updater::{UpdateAction, UpdatePhase, UpdateStatePatch, UpdateUiState};
use shell_contract::ipc::{
    CallContext, ChannelKind, EventSink, RegisterError, Registry, Responder, Target,
};
use shell_contract::{Batch, IpcError, IpcValue, MainWindowHost, WindowId};

use crate::handler;
use crate::value::to_ipc;

pub const GET_STATE: &str = "update:get-state";
pub const OPEN_FOR_UPDATE: &str = "update:open-for-update";
pub const DOWNLOAD: &str = "update:download";
pub const INSTALL: &str = "update:install";
pub const LATER: &str = "update:later";
pub const OPEN_DOWNLOAD: &str = "update:open-download";
/// to the update window: the state it shows
pub const CHANGED: &str = "update:changed";
/// to the shell window: the same state, for Settings
pub const STATE_CHANGED: &str = "update:state-changed";

const WIDTH: u32 = 400;
const HEIGHT: u32 = 430;
/// the same card with the release-notes box and its label and footer
const HEIGHT_WITH_NOTES: u32 = 620;

/// The update window as the shell creates it: a frameless, transparent,
/// fixed-size card (not minimizable, maximizable or full-screen) loading
/// `update.html` with the `ShellUpdate` preload
#[derive(Clone, Debug, PartialEq)]
pub struct UpdateWindowSpec {
    pub width: u32,
    pub height: u32,
    /// the shell window, when there is one
    pub parent: Option<WindowId>,
    pub title: String,
}

/// U's window host, implemented by the shell's update host. Called on the
/// core thread; the shell does the window work on the UI thread.
pub trait UpdateWindows: Send + Sync {
    /// Creates the window and shows it once it is ready to show, without
    /// taking the focus when `inactive`. When it closes, by any means, the
    /// shell calls [`UpdateWindow::closed`] on the core thread.
    fn create(&self, spec: &UpdateWindowSpec, inactive: bool) -> WindowId;
    /// `showInactive()`, or `show()` and `focus()`
    fn show(&self, window: WindowId, inactive: bool);
    fn close(&self, window: WindowId);
}

pub type UpdateWindowsHost = Arc<dyn UpdateWindows>;

/// The window's callbacks: the updater's `on_action`
pub type Actions = Rc<dyn Fn(UpdateAction)>;

#[derive(Default)]
struct State {
    window: Option<WindowId>,
    /// the freshest state, none before the first update was ever seen
    current: Option<UpdateUiState>,
    actions: Option<Actions>,
    /// the dialog's own channels have handlers (the window was shown once)
    dialog_ipc: bool,
    /// the close in progress is ours (install, quit), not the user's
    closing_programmatically: bool,
}

pub struct UpdateWindow {
    events: Arc<dyn EventSink>,
    windows: UpdateWindowsHost,
    main_window: MainWindowHost,
    state: RefCell<State>,
}

thread_local! {
    static CURRENT: RefCell<Option<Rc<UpdateWindow>>> = const { RefCell::new(None) };
}

/// The update window of this core thread, once the batch is registered: the
/// shell's updater host reaches it here
pub fn current() -> Option<Rc<UpdateWindow>> {
    CURRENT.with(|current| current.borrow().clone())
}

impl UpdateWindow {
    pub fn new(
        events: Arc<dyn EventSink>,
        windows: UpdateWindowsHost,
        main_window: MainWindowHost,
    ) -> Self {
        UpdateWindow {
            events,
            windows,
            main_window,
            state: RefCell::new(State::default()),
        }
    }

    /// `currentUpdateUiState()`
    pub fn current_state(&self) -> Option<UpdateUiState> {
        self.state.borrow().current.clone()
    }

    /// `isUpdateWindowOpen()`
    pub fn is_open(&self) -> bool {
        self.state.borrow().window.is_some()
    }

    /// `showUpdateWindow(shellWindow, state, actions, { inactive })`
    pub fn show(&self, state: UpdateUiState, actions: Actions, inactive: bool) {
        let window = {
            let mut s = self.state.borrow_mut();
            s.current = Some(state.clone());
            s.actions = Some(actions);
            s.dialog_ipc = true;
            s.window
        };
        self.broadcast_state();
        if let Some(window) = window {
            self.events
                .emit(Target::Window(window), CHANGED, vec![to_ipc(&state)]);
            self.windows.show(window, inactive);
            return;
        }
        let has_notes = state
            .release_notes
            .as_ref()
            .is_some_and(|notes| !notes.sections.is_empty());
        let spec = UpdateWindowSpec {
            width: WIDTH,
            height: if has_notes { HEIGHT_WITH_NOTES } else { HEIGHT },
            parent: self.main_window.window(),
            title: state.strings.title.clone(),
        };
        let window = self.windows.create(&spec, inactive);
        self.state.borrow_mut().window = Some(window);
    }

    /// `pushUpdateState(patch)`: `{ ...currentState, ...patch }`
    pub fn push(&self, patch: &UpdateStatePatch) {
        let (state, window) = {
            let mut s = self.state.borrow_mut();
            let Some(current) = s.current.as_mut() else {
                return;
            };
            current.phase = patch.phase;
            if let Some(percent) = patch.percent {
                current.percent = percent;
            }
            if let Some(visible) = patch.visible_install {
                current.visible_install = visible;
            }
            (current.clone(), s.window)
        };
        if let Some(window) = window {
            self.events
                .emit(Target::Window(window), CHANGED, vec![to_ipc(&state)]);
        }
        self.broadcast_state();
    }

    /// `closeUpdateWindow()`: install or quit closes it, which is not a "later"
    pub fn close(&self) {
        let window = {
            let mut s = self.state.borrow_mut();
            let window = s.window.take();
            if window.is_some() {
                s.closing_programmatically = true;
            }
            window
        };
        if let Some(window) = window {
            self.windows.close(window);
        }
    }

    /// The window's `closed` event. A close the user made (Alt+F4, the OS)
    /// counts as "later". Only that window's own close forgets it: unlike the
    /// TypeScript, a late `closed` of a window already replaced by a new one
    /// leaves the new one alone.
    pub fn closed(&self, window: WindowId) {
        let later = {
            let mut s = self.state.borrow_mut();
            if s.window == Some(window) {
                s.window = None;
            }
            let programmatic = std::mem::take(&mut s.closing_programmatically);
            if programmatic {
                None
            } else {
                s.actions.clone()
            }
        };
        if let Some(actions) = later {
            actions(UpdateAction::Later);
        }
    }

    fn broadcast_state(&self) {
        let Some(view) = self.main_window.view() else {
            return;
        };
        let state = self
            .state
            .borrow()
            .current
            .as_ref()
            .map_or(IpcValue::Null, to_ipc);
        self.events
            .emit(Target::View(view), STATE_CHANGED, vec![state]);
    }

    /// Settings → About "update to vX": show the dialog again (it may have
    /// been minimized) and, when nothing has started yet, start the download.
    /// False while no update is known.
    fn open_for_update(&self) -> bool {
        let (current, window) = {
            let s = self.state.borrow();
            (s.current.clone(), s.window)
        };
        let Some(current) = current else {
            return false;
        };
        if let Some(window) = window {
            self.windows.show(window, false);
        } else if self.main_window.window().is_some() {
            let actions = self
                .state
                .borrow()
                .actions
                .clone()
                .unwrap_or_else(|| Rc::new(|_| {}));
            self.show(current.clone(), actions, false);
        }
        if matches!(
            current.phase,
            UpdatePhase::Available | UpdatePhase::Error | UpdatePhase::InstallFailed
        ) {
            self.act(UpdateAction::Download);
        }
        true
    }

    fn act(&self, action: UpdateAction) {
        let actions = self.state.borrow().actions.clone();
        if let Some(actions) = actions {
            actions(action);
        }
    }

    /// One of the dialog's channels: no handler until the window was shown
    fn dialog(&self, channel: &str, action: UpdateAction, reply: Responder) {
        if !self.state.borrow().dialog_ipc {
            reply.reply(Err(IpcError::no_handler(channel)));
            return;
        }
        self.act(action);
        reply.reply(Ok(IpcValue::Undefined));
    }
}

pub(crate) fn register(
    registry: &mut dyn Registry,
    window: UpdateWindow,
) -> Result<(), RegisterError> {
    let window = Rc::new(window);
    CURRENT.with(|current| *current.borrow_mut() = Some(window.clone()));

    let w = window.clone();
    registry.register(
        Batch::U,
        GET_STATE,
        ChannelKind::Invoke,
        handler(move |_: &CallContext, _, reply: Responder| {
            let state = w.current_state();
            reply.reply(Ok(state.as_ref().map_or(IpcValue::Null, to_ipc)));
        }),
    )?;
    let w = window.clone();
    registry.register(
        Batch::U,
        OPEN_FOR_UPDATE,
        ChannelKind::Invoke,
        handler(move |_: &CallContext, _, reply: Responder| {
            reply.reply(Ok(IpcValue::Bool(w.open_for_update())));
        }),
    )?;
    for (channel, action) in [
        (DOWNLOAD, UpdateAction::Download),
        (INSTALL, UpdateAction::Install),
        (LATER, UpdateAction::Later),
        (OPEN_DOWNLOAD, UpdateAction::OpenDownload),
    ] {
        let w = window.clone();
        registry.register(
            Batch::U,
            channel,
            ChannelKind::Invoke,
            handler(move |_: &CallContext, _, reply: Responder| w.dialog(channel, action, reply)),
        )?;
    }
    Ok(())
}
