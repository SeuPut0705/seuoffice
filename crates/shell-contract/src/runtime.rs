//! Threads, three kinds:
//!
//! - the UI thread runs the Tauri/CEF event loop and alone touches windows,
//!   menus and dialogs;
//! - the core thread runs every handler, in arrival order, as Electron's main
//!   thread ran every `ipcMain` listener; `main-core`'s state lives there;
//! - workers run what TypeScript awaited (the network, child processes, big
//!   file work on owned data) and post the result back to the core thread.
//!
//! When `main-core` calls back into the UI (a message box through its
//! `MessageBox` trait, a dialog through `Dialog`), the adapter runs that on
//! the UI thread and blocks the caller until it is done ([`run_on`]). Nothing
//! blocks on the UI thread itself.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;

use crate::ids::ViewId;
use crate::ipc::{EventSink, Sender};

/// A thread's queue: the UI thread or the core thread
pub trait Thread: Send + Sync {
    fn post(&self, job: Box<dyn FnOnce() + Send>);
    fn is_current(&self) -> bool;
}

/// The worker pool
pub trait Workers: Send + Sync {
    fn spawn(&self, job: Box<dyn FnOnce() + Send>);
}

/// Runs `job` on `thread` and waits for its result. Panics when called on
/// that thread itself: the wait could never end.
pub fn run_on<R: Send + 'static>(
    thread: &dyn Thread,
    job: impl FnOnce() -> R + Send + 'static,
) -> R {
    assert!(!thread.is_current(), "run_on its own thread would deadlock");
    let (tx, rx) = mpsc::sync_channel(1);
    thread.post(Box::new(move || {
        let _ = tx.send(job());
    }));
    rx.recv().expect("the thread dropped a job")
}

/// Set once, read from any thread
#[derive(Clone, Debug, Default)]
pub struct CancelToken(Arc<AtomicBool>);

impl CancelToken {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// The views the shell has, and their end
pub trait Views: Send + Sync {
    fn sender_of(&self, view: ViewId) -> Option<Sender>;
    fn all(&self) -> Vec<Sender>;
    /// `listener` runs on the core thread after a view is destroyed, once the
    /// shell has cancelled the view's pending calls
    fn on_destroyed(&self, listener: Box<dyn Fn(ViewId) + Send + Sync>);
}

/// Electron's `app.getPath` names the handlers use. Paths stay where the
/// Electron build kept them (decisions 0013, 0019): the shell reads the same
/// userData folder.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PathName {
    Home,
    AppData,
    UserData,
    Temp,
    Exe,
    Desktop,
    Documents,
    Downloads,
    Logs,
}

pub trait AppPaths: Send + Sync {
    fn path(&self, name: PathName) -> PathBuf;
}

/// What every batch's handlers may use. Batch-specific hosts (menus,
/// dialogs, the updater) are the `main-core` traits, implemented by the
/// batch that owns the area.
#[derive(Clone)]
pub struct Services {
    pub ui: Arc<dyn Thread>,
    pub core: Arc<dyn Thread>,
    pub workers: Arc<dyn Workers>,
    pub events: Arc<dyn EventSink>,
    pub views: Arc<dyn Views>,
    pub paths: Arc<dyn AppPaths>,
}
