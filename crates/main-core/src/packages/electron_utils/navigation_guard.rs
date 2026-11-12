//! `packages/electron-utils/src/navigation-guard.ts`.
//!
//! The Electron objects are traits with exactly the methods the TypeScript
//! calls: the app (`on`, and the flag the guard leaves on it), a
//! `webContents` (`on('will-navigate')`, `getURL`, `setWindowOpenHandler`) and
//! the `will-navigate` event (`url`, `preventDefault`).

/// The `will-navigate` event.
pub trait WillNavigateEvent {
    fn url(&self) -> String;
    fn prevent_default(&mut self);
}

/// What a window-open handler answers: `{ action: 'deny' }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowOpenAction {
    Deny,
}

/// `(event) => ...` of `contents.on('will-navigate', ...)`; the second
/// argument is `contents.getURL`, called when the event fires.
pub type WillNavigateListener = Box<dyn Fn(&mut dyn WillNavigateEvent, &dyn Fn() -> String)>;

/// `() => ({ action: 'deny' })` of `contents.setWindowOpenHandler`.
pub type WindowOpenHandler = Box<dyn Fn() -> WindowOpenAction>;

/// The part of a `webContents` the guard uses.
pub trait GuardedContents {
    /// `contents.on('will-navigate', listener)`
    fn on_will_navigate(&mut self, listener: WillNavigateListener);
    /// `contents.setWindowOpenHandler(handler)`
    fn set_window_open_handler(&mut self, handler: WindowOpenHandler);
}

/// `(_event, contents) => ...` of `app.on('web-contents-created', ...)`.
pub type ContentsCreatedListener = Box<dyn Fn(&mut dyn GuardedContents)>;

/// The part of the `App` the guard uses.
pub trait GuardedApp {
    /// the flag the guard leaves on the app (a symbol property in the TypeScript)
    fn guard_installed(&self) -> bool;
    fn set_guard_installed(&mut self);
    /// `app.on('web-contents-created', listener)`
    fn on_web_contents_created(&mut self, listener: ContentsCreatedListener);
}

pub fn install_navigation_guard(app: &mut dyn GuardedApp) {
    if app.guard_installed() {
        return;
    }
    app.set_guard_installed();
    app.on_web_contents_created(Box::new(|contents| {
        contents.on_will_navigate(Box::new(|event, get_url| {
            if event.url() != get_url() {
                event.prevent_default();
            }
        }));
        contents.set_window_open_handler(Box::new(|| WindowOpenAction::Deny));
    }));
}
