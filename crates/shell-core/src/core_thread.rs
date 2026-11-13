//! The core thread (the stage 3 shell contract, section 3): one OS thread
//! that runs every posted job in order. Handlers and `main-core`'s state live
//! there, as every `ipcMain` listener ran on Electron's main thread.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle, ThreadId};

use shell_contract::runtime::{Thread, Workers};

type Job = Box<dyn FnOnce() + Send>;

/// A thread with a job queue. Dropping the last handle ends the thread once
/// its queue is empty.
pub struct CoreThread {
    queue: Mutex<Option<mpsc::Sender<Job>>>,
    id: ThreadId,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl CoreThread {
    pub fn spawn(name: &str) -> Arc<Self> {
        let (tx, rx) = mpsc::channel::<Job>();
        let join = thread::Builder::new()
            .name(name.into())
            .spawn(move || {
                for job in rx {
                    job();
                }
            })
            .expect("spawning the core thread");
        Arc::new(CoreThread {
            queue: Mutex::new(Some(tx)),
            id: join.thread().id(),
            join: Mutex::new(Some(join)),
        })
    }

    /// Stops taking jobs and waits for the queued ones
    pub fn stop(&self) {
        drop(self.queue.lock().unwrap().take());
        if let Some(join) = self.join.lock().unwrap().take()
            && join.thread().id() != thread::current().id()
        {
            let _ = join.join();
        }
    }
}

impl Thread for CoreThread {
    fn post(&self, job: Job) {
        if let Some(queue) = self.queue.lock().unwrap().as_ref() {
            let _ = queue.send(job);
        }
    }

    fn is_current(&self) -> bool {
        thread::current().id() == self.id
    }
}

/// Workers as plain threads, one per job: the jobs are few and long (the
/// network, a child process, a big file)
pub struct ThreadWorkers;

impl Workers for ThreadWorkers {
    fn spawn(&self, job: Job) {
        thread::Builder::new()
            .name("shell-worker".into())
            .spawn(job)
            .expect("spawning a worker");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use shell_contract::runtime::run_on;

    #[test]
    fn runs_in_order_and_knows_itself() {
        let core = CoreThread::spawn("core-test");
        assert!(!core.is_current());
        let seen = Arc::new(Mutex::new(Vec::new()));
        for i in 0..100 {
            let seen = seen.clone();
            core.post(Box::new(move || seen.lock().unwrap().push(i)));
        }
        let probe = core.clone();
        assert!(run_on(core.as_ref(), move || probe.is_current()));
        assert_eq!(*seen.lock().unwrap(), (0..100).collect::<Vec<_>>());
        core.stop();
    }
}
