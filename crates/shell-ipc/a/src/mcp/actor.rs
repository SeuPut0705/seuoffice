//! The threads under a connection of the hub.
//!
//! `main_core`'s MCP connections are sans-IO state machines whose hosts make
//! plain calls: `fetch` answers once the headers are in, `resolve_command`
//! may download a runtime, a child's pipes are read by the caller. The core
//! thread never blocks, so every connection lives on a thread of its own (an
//! actor): the core thread talks to it through a mailbox, the actor drives
//! the connection and its blocking host, and what the connection reports
//! reaches the core thread as a posted closure ([`CoreLink`]).
//!
//! [`TimerQueue`] is the one timer table all of them share: the actors' own
//! `setTimeout`s and the bridges' timers on the core side.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, TryRecvError};
use std::time::{Duration, Instant};

use shell_contract::runtime::Thread;

use super::Hub;

/// `setTimeout` / `clearTimeout`: timers by number, due in order
#[derive(Default)]
pub struct TimerQueue {
    next: u64,
    due: BTreeMap<(Instant, u64), ()>,
    at: HashMap<u64, Instant>,
}

impl TimerQueue {
    /// `setTimeout(_, ms)`: the timer's number
    pub fn add(&mut self, ms: f64) -> u64 {
        self.next += 1;
        let id = self.next;
        // a negative or NaN delay is 1 ms in JavaScript; an infinite one never fires
        let ms = if ms.is_nan() || ms < 1.0 { 1.0 } else { ms };
        let at = if ms.is_finite() && ms < 3.0e11 {
            Instant::now() + Duration::from_secs_f64(ms / 1000.0)
        } else {
            Instant::now() + Duration::from_secs(60 * 60 * 24 * 365 * 10)
        };
        self.due.insert((at, id), ());
        self.at.insert(id, at);
        id
    }

    /// `clearTimeout(timer)`
    pub fn cancel(&mut self, id: u64) {
        if let Some(at) = self.at.remove(&id) {
            self.due.remove(&(at, id));
        }
    }

    /// when the next timer is due
    pub fn next_due(&self) -> Option<Instant> {
        self.due.keys().next().map(|(at, _)| *at)
    }

    /// the timers due by `now`, in the order they fire; they are removed
    pub fn pop_due(&mut self, now: Instant) -> Vec<u64> {
        let mut fired = Vec::new();
        while let Some((&(at, id), _)) = self.due.iter().next() {
            if at > now {
                break;
            }
            self.due.remove(&(at, id));
            self.at.remove(&id);
            fired.push(id);
        }
        fired
    }
}

/// What the loop of an actor does with a mailbox entry
pub enum Step {
    Go,
    Stop,
}

/// Runs an actor: timers that are due fire first, then one message is taken;
/// `on_idle` runs when the mailbox is empty and the actor is about to wait.
/// Ends when `on_message` says so or every sender is gone
pub fn run_loop<M>(
    rx: &Receiver<M>,
    timers: &std::cell::RefCell<TimerQueue>,
    mut on_message: impl FnMut(M) -> Step,
    mut on_timer: impl FnMut(u64),
    mut on_idle: impl FnMut(),
) {
    loop {
        let fired = timers.borrow_mut().pop_due(Instant::now());
        for id in fired {
            on_timer(id);
        }
        let message = match rx.try_recv() {
            Ok(message) => message,
            Err(TryRecvError::Disconnected) => return,
            Err(TryRecvError::Empty) => {
                on_idle();
                let wait = timers
                    .borrow()
                    .next_due()
                    .map(|at| at.saturating_duration_since(Instant::now()));
                match wait {
                    Some(wait) => match rx.recv_timeout(wait) {
                        Ok(message) => message,
                        Err(RecvTimeoutError::Timeout) => continue,
                        Err(RecvTimeoutError::Disconnected) => return,
                    },
                    None => match rx.recv() {
                        Ok(message) => message,
                        Err(_) => return,
                    },
                }
            }
        };
        if let Step::Stop = on_message(message) {
            return;
        }
    }
}

/// The way from a thread that is not the core thread to the hub on it
#[derive(Clone)]
pub struct CoreLink {
    pub core: Arc<dyn Thread>,
    pub hub: u64,
}

impl CoreLink {
    /// Runs `job` with the hub on the core thread, later
    pub fn post(&self, job: impl FnOnce(&Hub) + Send + 'static) {
        let id = self.hub;
        self.core.post(Box::new(move || {
            super::with_hub(id, job);
        }));
    }

    /// Runs `job` with the hub on the core thread and waits for its answer.
    /// Only for a thread the core thread never waits on; `None` when the hub
    /// or the core thread is gone.
    pub fn ask<R: Send + 'static>(
        &self,
        job: impl FnOnce(&Hub) -> R + Send + 'static,
    ) -> Option<R> {
        let (tx, rx) = mpsc::sync_channel(1);
        let id = self.hub;
        self.core.post(Box::new(move || {
            if let Some(answer) = super::with_hub(id, job) {
                let _ = tx.send(answer);
            }
        }));
        rx.recv().ok()
    }
}

/// `setTimeout` for code on the core thread: one thread keeps the timers and
/// runs each job when it is due (a job posts to the core thread itself)
pub struct Clock {
    shared: Arc<ClockShared>,
}

type Job = Box<dyn FnOnce() + Send>;

struct ClockState {
    queue: TimerQueue,
    jobs: HashMap<u64, Job>,
    closed: bool,
    started: bool,
}

struct ClockShared {
    state: std::sync::Mutex<ClockState>,
    wake: std::sync::Condvar,
}

impl Clock {
    pub fn new() -> Clock {
        Clock {
            shared: Arc::new(ClockShared {
                state: std::sync::Mutex::new(ClockState {
                    queue: TimerQueue::default(),
                    jobs: HashMap::new(),
                    closed: false,
                    started: false,
                }),
                wake: std::sync::Condvar::new(),
            }),
        }
    }

    /// `setTimeout(job, ms)`: the timer's number, which `job` is given too
    pub fn set(&self, ms: f64, job: impl FnOnce(u64) + Send + 'static) -> u64 {
        let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        let id = state.queue.add(ms);
        state.jobs.insert(id, Box::new(move || job(id)));
        if !state.started {
            state.started = true;
            let shared = self.shared.clone();
            let spawned = std::thread::Builder::new()
                .name("mcp-clock".to_owned())
                .spawn(move || Clock::run(&shared));
            if spawned.is_err() {
                state.started = false;
            }
        }
        self.shared.wake.notify_all();
        id
    }

    /// `clearTimeout(id)`
    pub fn clear(&self, id: u64) {
        let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        state.queue.cancel(id);
        state.jobs.remove(&id);
    }

    fn run(shared: &ClockShared) {
        let mut state = shared.state.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            if state.closed {
                return;
            }
            let due = state.queue.pop_due(Instant::now());
            if !due.is_empty() {
                let jobs: Vec<Job> = due.iter().filter_map(|id| state.jobs.remove(id)).collect();
                drop(state);
                for job in jobs {
                    job();
                }
                state = shared.state.lock().unwrap_or_else(|p| p.into_inner());
                continue;
            }
            state = match state.queue.next_due() {
                Some(at) => {
                    let wait = at.saturating_duration_since(Instant::now());
                    shared
                        .wake
                        .wait_timeout(state, wait)
                        .unwrap_or_else(|p| p.into_inner())
                        .0
                }
                None => shared.wake.wait(state).unwrap_or_else(|p| p.into_inner()),
            };
        }
    }
}

impl Default for Clock {
    fn default() -> Self {
        Clock::new()
    }
}

impl Drop for Clock {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().unwrap_or_else(|p| p.into_inner());
        state.closed = true;
        self.shared.wake.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timers_fire_in_due_order_and_a_cancelled_one_never_does() {
        let mut queue = TimerQueue::default();
        let late = queue.add(40.0);
        let early = queue.add(5.0);
        let gone = queue.add(5.0);
        queue.cancel(gone);
        assert_eq!(queue.pop_due(Instant::now()), Vec::<u64>::new());
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(queue.pop_due(Instant::now()), vec![early, late]);
        assert_eq!(queue.next_due(), None);
    }

    #[test]
    fn the_loop_fires_timers_between_messages_and_stops_on_request() {
        let (tx, rx) = mpsc::channel::<&'static str>();
        let timers = std::cell::RefCell::new(TimerQueue::default());
        let first = timers.borrow_mut().add(10.0);
        let seen = std::cell::RefCell::new(Vec::new());
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            tx.send("stop").unwrap();
        });
        run_loop(
            &rx,
            &timers,
            |message| {
                seen.borrow_mut().push(format!("message {message}"));
                Step::Stop
            },
            |id| seen.borrow_mut().push(format!("timer {}", id == first)),
            || {},
        );
        assert_eq!(*seen.borrow(), vec!["timer true", "message stop"]);
    }

    #[test]
    fn the_clock_runs_a_job_when_it_is_due_and_never_one_that_was_cleared() {
        let clock = Clock::new();
        let (tx, rx) = mpsc::channel();
        let sent = tx.clone();
        let first = clock.set(10.0, move |id| sent.send(("first", id)).unwrap());
        let sent = tx.clone();
        let gone = clock.set(10.0, move |id| sent.send(("gone", id)).unwrap());
        clock.clear(gone);
        let sent = tx;
        let last = clock.set(60.0, move |id| sent.send(("last", id)).unwrap());
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            ("first", first)
        );
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            ("last", last)
        );
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
    }
}
