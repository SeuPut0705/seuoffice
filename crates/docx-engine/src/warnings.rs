//! The `console.warn` sites of the TypeScript engine. The engine has no
//! console: a site records its message here, and the host that called the
//! engine takes the messages when the call returns and replays them.

use std::cell::RefCell;

thread_local! {
    static WARNINGS: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

/// Records one warning: the arguments of a `console.warn` joined by a space.
pub fn warn(message: impl Into<String>) {
    WARNINGS.with(|warnings| warnings.borrow_mut().push(message.into()));
}

/// The warnings recorded since the last call, in order.
pub fn take() -> Vec<String> {
    WARNINGS.with(|warnings| std::mem::take(&mut *warnings.borrow_mut()))
}
