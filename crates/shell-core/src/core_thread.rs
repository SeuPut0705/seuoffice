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
                // a job that panics (a worker's result coming back, a timer)
                // answers the replies it held and does not end the thread
                for job in rx {
                    crate::dispatch::catching(job);
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

    /// A job that panics (a worker's result coming back, a timer) must not end
    /// the core thread: the reply it held is answered with the panic's text and
    /// the next job still runs.
    #[test]
    fn a_panicking_job_answers_its_reply_and_the_thread_goes_on() {
        use std::cell::RefCell;
        use std::rc::Rc;
        use std::sync::mpsc;
        use std::time::Duration;

        use shell_contract::ids::{ViewId, WindowId};
        use shell_contract::ipc::{CallContext, ChannelKind, Handler, Registry, Responder, Sender};
        use shell_contract::value::IpcValue;
        use shell_contract::{Batch, CHANNELS};

        use crate::dispatch::Dispatcher;
        use crate::table::Table;

        thread_local! {
            static KEPT: RefCell<Option<Responder>> = const { RefCell::new(None) };
        }
        struct Keep;
        impl Handler for Keep {
            fn call(&self, _: &CallContext, _: Vec<IpcValue>, reply: Responder) {
                KEPT.with(|k| *k.borrow_mut() = Some(reply));
            }
        }

        let core = CoreThread::spawn("core-panic-test");
        let (replies, answered) = mpsc::channel();
        core.post(Box::new(move || {
            let spec = CHANNELS
                .iter()
                .find(|s| s.batch == Batch::W && s.kinds == [ChannelKind::Invoke])
                .unwrap();
            let mut table = Table::default();
            table
                .register(Batch::W, spec.name, ChannelKind::Invoke, Rc::new(Keep))
                .unwrap();
            let sender = Sender {
                view: ViewId(1),
                window: WindowId(1),
                surface: spec.surfaces[0],
            };
            Dispatcher::new(table).dispatch(
                sender,
                ChannelKind::Invoke,
                None,
                spec.name,
                vec![],
                Box::new(move |r| replies.send(r).unwrap()),
            );
        }));
        // the worker's result comes back and its continuation panics
        core.post(Box::new(|| {
            let _reply = KEPT.with(|k| k.borrow_mut().take());
            panic!("late boom")
        }));
        let (ran, after) = mpsc::channel();
        core.post(Box::new(move || ran.send(()).unwrap()));

        let reply = answered.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(reply.unwrap_err().to_string(), "Error: late boom");
        after
            .recv_timeout(Duration::from_secs(5))
            .expect("the core thread ended with the panic");
        core.stop();
    }
}
