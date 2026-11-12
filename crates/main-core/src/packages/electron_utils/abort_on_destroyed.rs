//! `packages/electron-utils/src/abort-on-destroyed.ts`: aborts a request when
//! the renderer that started it goes away or reloads.
//!
//! A listener is a number (`GONE_LISTENER`, `NAVIGATION_LISTENER`); the
//! adapter keeps the real function under it, and calls [`on_gone`] and
//! [`on_navigation`] when its event fires.

use jscompat::JsonValue;

/// the `onGone` listener of `once('destroyed', ...)`
pub const GONE_LISTENER: u64 = 1;
/// the `onNavigation` listener of `on('did-start-navigation', ...)`
pub const NAVIGATION_LISTENER: u64 = 2;

/// `DestroyableSender` (and the navigation half reached through a cast).
pub trait DestroyableSender {
    /// `sender.isDestroyed()`
    fn is_destroyed(&mut self) -> bool;
    /// `sender.once('destroyed', listener)`
    fn once_destroyed(&mut self, listener: u64);
    /// `sender.removeListener('destroyed', listener)`
    fn remove_destroyed_listener(&mut self, listener: u64);
    /// `navigation.on('did-start-navigation', listener)`: `false` when the
    /// sender has no `on` function or it threw
    fn on_navigation(&mut self, listener: u64) -> bool;
    /// `navigation.removeListener?.('did-start-navigation', listener)`; a
    /// sender without the function, or one that throws, does nothing
    fn remove_navigation_listener(&mut self, listener: u64);
}

/// `isDocumentNavigation(args)`: both Electron signatures of
/// `did-start-navigation`; a main-frame document load means reload.
pub fn is_document_navigation(args: &[JsonValue]) -> bool {
    // `details && typeof details === 'object'`: an array is an object too
    match args.get(1) {
        Some(details @ (JsonValue::Object(_) | JsonValue::Array(_))) => {
            let is_main_frame = details.get("isMainFrame");
            let is_same_document = details.get("isSameDocument");
            is_main_frame.as_deref() != Some(&JsonValue::Bool(false))
                && is_same_document.as_deref() != Some(&JsonValue::Bool(true))
        }
        // older Electron: (event, url, isInPlace, isMainFrame, ...)
        _ => {
            let in_place = args.get(2) == Some(&JsonValue::Bool(true));
            let main_frame = args.get(3) != Some(&JsonValue::Bool(false));
            main_frame && !in_place
        }
    }
}

/// `onGone`: the sender was destroyed.
pub fn on_gone(abort: &mut dyn FnMut()) {
    abort();
}

/// `onNavigation(...args)`
pub fn on_navigation(args: &[JsonValue], abort: &mut dyn FnMut()) {
    if is_document_navigation(args) {
        abort();
    }
}

/// The disposer `abortOnDestroyed` returns.
#[derive(Debug)]
pub struct Disposer {
    /// `None` when the sender was already destroyed: the disposer does nothing
    watching_navigation: Option<bool>,
}

impl Disposer {
    /// Calls the disposer.
    pub fn dispose<S: DestroyableSender>(&self, sender: &mut S) {
        let Some(watching_navigation) = self.watching_navigation else {
            return;
        };
        sender.remove_destroyed_listener(GONE_LISTENER);
        if watching_navigation {
            sender.remove_navigation_listener(NAVIGATION_LISTENER);
        }
    }
}

/// `abortOnDestroyed(sender, controller)`: `abort` is `controller.abort()`.
pub fn abort_on_destroyed<S: DestroyableSender>(
    sender: &mut S,
    abort: &mut dyn FnMut(),
) -> Disposer {
    if sender.is_destroyed() {
        abort();
        return Disposer {
            watching_navigation: None,
        };
    }
    sender.once_destroyed(GONE_LISTENER);
    let watching_navigation = sender.on_navigation(NAVIGATION_LISTENER);
    Disposer {
        watching_navigation: Some(watching_navigation),
    }
}
