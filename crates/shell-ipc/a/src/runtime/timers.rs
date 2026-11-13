//! The timers of one driver: a thread that sleeps until the earliest is due
//! and posts [`Event::Timer`] to the core thread, as `setTimeout` runs its
//! callback on the loop.

use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use main_core::packages::ai_provider::task::{Event, Id};

use super::Poster;

#[derive(Default)]
struct State {
    /// due time and id, earliest first; timers due together keep the order set
    due: Vec<(Instant, Id)>,
    closed: bool,
}

#[derive(Default)]
struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

/// The timer thread of a driver; it ends when this is dropped
pub struct Timers {
    shared: Arc<Shared>,
}

/// `setTimeout`'s delay as Node reads it: a whole number of milliseconds from
/// 1 to 2^31 - 1, anything else (NaN, below 1, above the limit) is 1
fn delay(ms: f64) -> Duration {
    let ms = if (1.0..=2_147_483_647.0).contains(&ms) {
        ms.trunc()
    } else {
        1.0
    };
    Duration::from_millis(ms as u64)
}

impl Timers {
    pub fn start(poster: Poster) -> Timers {
        let shared = Arc::new(Shared::default());
        let thread_shared = shared.clone();
        std::thread::Builder::new()
            .name("ai-runtime-timers".into())
            .spawn(move || run(&thread_shared, &poster))
            .expect("start the timer thread");
        Timers { shared }
    }

    /// `Cmd::SetTimer`
    pub fn set(&self, id: Id, ms: f64) {
        let when = Instant::now() + delay(ms);
        let mut state = self.shared.state.lock().unwrap();
        let at = state.due.partition_point(|(t, _)| *t <= when);
        state.due.insert(at, (when, id));
        drop(state);
        self.shared.changed.notify_one();
    }

    /// `Cmd::ClearTimer`: a timer that already fired was posted, and the
    /// runtime drops its event
    pub fn clear(&self, id: Id) {
        self.shared
            .state
            .lock()
            .unwrap()
            .due
            .retain(|(_, t)| *t != id);
    }
}

impl Drop for Timers {
    fn drop(&mut self) {
        self.shared.state.lock().unwrap().closed = true;
        self.shared.changed.notify_one();
    }
}

fn run(shared: &Shared, poster: &Poster) {
    let mut state = shared.state.lock().unwrap();
    loop {
        if state.closed {
            return;
        }
        let now = Instant::now();
        let n = state.due.partition_point(|(t, _)| *t <= now);
        if n > 0 {
            let fired: Vec<Id> = state.due.drain(..n).map(|(_, id)| id).collect();
            drop(state);
            for id in fired {
                poster.send(Event::Timer { id });
            }
            state = shared.state.lock().unwrap();
            continue;
        }
        let next = state.due.first().map(|(t, _)| *t);
        state = match next {
            Some(t) => {
                shared
                    .changed
                    .wait_timeout(state, t.saturating_duration_since(now))
                    .unwrap()
                    .0
            }
            None => shared.changed.wait(state).unwrap(),
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delay_is_whole_milliseconds_and_one_when_out_of_range() {
        assert_eq!(delay(250.9), Duration::from_millis(250));
        assert_eq!(delay(0.0), Duration::from_millis(1));
        assert_eq!(delay(f64::NAN), Duration::from_millis(1));
        assert_eq!(delay(-5.0), Duration::from_millis(1));
        assert_eq!(delay(3e9), Duration::from_millis(1));
    }
}
