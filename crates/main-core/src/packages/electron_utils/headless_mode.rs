//! `packages/electron-utils/src/headless-mode.ts`.
//!
//! Process-wide "no user is watching" flag, set once by the shell's
//! `--headless-export` entry before any editor module boots. The TypeScript
//! keeps it in a module variable; here the owner (the shell) keeps one
//! `HeadlessMode` for the process and every module that checks it borrows it.

use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug, Default)]
pub struct HeadlessMode {
    headless: AtomicBool,
}

impl HeadlessMode {
    pub const fn new() -> Self {
        HeadlessMode {
            headless: AtomicBool::new(false),
        }
    }

    /// `setHeadlessMode(on)`
    pub fn set_headless_mode(&self, on: bool) {
        self.headless.store(on, Ordering::SeqCst);
    }

    /// `isHeadlessMode()`
    pub fn is_headless_mode(&self) -> bool {
        self.headless.load(Ordering::SeqCst)
    }
}
