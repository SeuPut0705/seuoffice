//! `apps/docs/src/main/ai-keepalive.ts`: wire-activity keepalive for a
//! request that may wait a long time for its first token. A local AI server
//! loads the model on the first request, and the renderer treats a silent
//! stream as a dead one; a ping every five seconds lets it tell "the model is
//! still loading" from "the connection died".
//!
//! The TypeScript hands `send` to `setInterval`. Here the caller owns the
//! timer ([`Interval`]) and calls `send` on each of its ticks; this module
//! says when the timer starts and when it is cleared.

/// how often a waiting local request tells the renderer it is still alive
pub const AI_KEEPALIVE_INTERVAL_MS: f64 = 5_000.0;

/// `setInterval` and `clearInterval`, the two calls the TypeScript makes.
pub trait Interval {
    /// `setInterval(send, intervalMs)`: the handle of the timer
    fn set_interval(&mut self, interval_ms: f64) -> u64;
    /// `clearInterval(handle)`
    fn clear_interval(&mut self, handle: u64);
}

/// The stop function `startAiKeepalive` returns.
#[derive(Debug)]
pub struct AiKeepalive {
    handle: u64,
    stopped: bool,
}

/// `startAiKeepalive(send, intervalMs)`: `send` once per interval until
/// stopped. The first ping arrives after one full interval, not immediately.
/// `interval_ms` is `None` for the default.
pub fn start_ai_keepalive(timer: &mut dyn Interval, interval_ms: Option<f64>) -> AiKeepalive {
    let handle = timer.set_interval(interval_ms.unwrap_or(AI_KEEPALIVE_INTERVAL_MS));
    AiKeepalive {
        handle,
        stopped: false,
    }
}

impl AiKeepalive {
    /// The returned stop function. Stopping twice is safe.
    pub fn stop(&mut self, timer: &mut dyn Interval) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        timer.clear_interval(self.handle);
    }
}

/// What `startFirstChunkKeepalive` returns: `{ firstChunk, stop }`.
#[derive(Debug)]
pub struct FirstChunkKeepalive {
    keepalive: AiKeepalive,
    done: bool,
}

/// `startFirstChunkKeepalive(send, intervalMs)`: a keepalive that lasts until
/// the first answer chunk, not merely until the response headers.
pub fn start_first_chunk_keepalive(
    timer: &mut dyn Interval,
    interval_ms: Option<f64>,
) -> FirstChunkKeepalive {
    FirstChunkKeepalive {
        keepalive: start_ai_keepalive(timer, interval_ms),
        done: false,
    }
}

impl FirstChunkKeepalive {
    /// `firstChunk()`
    pub fn first_chunk(&mut self, timer: &mut dyn Interval) {
        if self.done {
            return;
        }
        self.done = true;
        self.keepalive.stop(timer);
    }

    /// `stop()`
    pub fn stop(&mut self, timer: &mut dyn Interval) {
        self.keepalive.stop(timer);
    }
}
