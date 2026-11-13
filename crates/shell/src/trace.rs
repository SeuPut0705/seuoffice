//! A timestamped trace of the shell's IPC path, for runs nobody watches (the
//! runner's `--measure-dialog`, `SEUOFFICE_SHELL_TRACE=1`). Each line goes to
//! stderr as `[+  123.4ms] tag: text` and into a ring that the measurement
//! writes into its JSON, so a stall shows where it stopped even when the
//! process log is lost. Off, a call costs one atomic load.

use std::collections::{BTreeMap, VecDeque};
use std::fmt::Arguments;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Instant;

/// How many lines the ring keeps
const RING: usize = 600;

/// The tags of the per-message path: the first lines of each tell the story,
/// the rest (thousands in a measurement, which they would slow down) are
/// counted and one in a hundred is shown
const BUSY: [&str; 4] = ["ipc", "outlet", "measure", "sync"];
const BUSY_FULL: u64 = 40;
const BUSY_EVERY: u64 = 100;

static ON: AtomicBool = AtomicBool::new(false);
static START: LazyLock<Instant> = LazyLock::new(Instant::now);
static LINES: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());
static COUNTS: Mutex<BTreeMap<String, u64>> = Mutex::new(BTreeMap::new());

/// Starts the clock and the trace
pub fn enable() {
    LazyLock::force(&START);
    ON.store(true, Ordering::Relaxed);
}

pub fn enabled() -> bool {
    ON.load(Ordering::Relaxed)
}

pub fn line(tag: &str, text: Arguments<'_>) {
    let n = {
        let mut counts = COUNTS.lock().unwrap();
        let n = counts.entry(tag.to_owned()).or_default();
        *n += 1;
        *n
    };
    if BUSY.contains(&tag) && n > BUSY_FULL && n % BUSY_EVERY != 0 {
        return;
    }
    let ms = START.elapsed().as_secs_f64() * 1000.0;
    let line = format!("[+{ms:9.1}ms] {tag}: {text}");
    eprintln!("{line}");
    let mut ring = LINES.lock().unwrap();
    if ring.len() == RING {
        ring.pop_front();
    }
    ring.push_back(line);
}

/// The lines so far, oldest first
pub fn recent() -> Vec<String> {
    LINES.lock().unwrap().iter().cloned().collect()
}

/// How many lines each tag was asked to write, shown or not
pub fn counts() -> BTreeMap<String, u64> {
    COUNTS.lock().unwrap().clone()
}

/// `trace!("ipc", "invoke {channel}")`
macro_rules! trace {
    ($tag:expr, $($arg:tt)*) => {
        if $crate::trace::enabled() {
            $crate::trace::line($tag, format_args!($($arg)*));
        }
    };
}
pub(crate) use trace;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_busy_tag_is_thinned_and_counted_a_quiet_one_is_not() {
        enable();
        for i in 0..250 {
            line("ipc", format_args!("call {i}"));
            line("page", format_args!("load {i}"));
        }
        let counts = counts();
        assert_eq!(counts["ipc"], 250);
        let shown = |tag: &str| {
            recent()
                .iter()
                .filter(|l| l.contains(&format!(" {tag}: ")))
                .count()
        };
        // 40 in full, then the 100th and 200th
        assert_eq!(shown("ipc"), 42);
        assert_eq!(shown("page"), 250.min(RING - 42));
    }
}
