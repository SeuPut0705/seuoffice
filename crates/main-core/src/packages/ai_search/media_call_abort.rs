//! `packages/ai-search/src/media-call-abort.ts`: cancellation of the
//! generate_image / analyze_media calls a window started.
//!
//! The TypeScript keeps `inFlightMediaCalls` at module level, a set of
//! `AbortController`s per window, and gives `run` a signal. Here the caller
//! owns a [`MediaCalls`]: [`MediaCalls::begin`] is the start of
//! `withMediaCallSignal`, [`MediaCalls::end`] its `finally`; the window's
//! `destroyed` event is [`MediaCalls::destroyed`]. A call's signal is
//! [`MediaCalls::aborted`].

/// the handle of one call in flight (its `AbortController`)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MediaCallId(u64);

#[derive(Debug)]
struct Call {
    id: MediaCallId,
    aborted: bool,
}

/// `const inFlightMediaCalls = new Map<number, Set<AbortController>>()`
#[derive(Debug, Default)]
pub struct MediaCalls {
    next: u64,
    /// per window id, in the order the windows first started a call
    in_flight: Vec<(f64, Vec<Call>)>,
}

impl MediaCalls {
    pub fn new() -> Self {
        Self::default()
    }

    /// `withMediaCallSignal(sender, run)` up to the call of `run`: the call is
    /// remembered under its window; its signal is aborted at once for a
    /// window that is already destroyed (`destroyed`), else the host calls
    /// [`MediaCalls::destroyed`] when the window goes away.
    pub fn begin(&mut self, sender_id: f64, destroyed: bool) -> MediaCallId {
        let id = MediaCallId(self.next);
        self.next += 1;
        let at = match self
            .in_flight
            .iter()
            .position(|(sender, _)| *sender == sender_id)
        {
            Some(at) => at,
            None => {
                self.in_flight.push((sender_id, Vec::new()));
                self.in_flight.len() - 1
            }
        };
        self.in_flight[at].1.push(Call {
            id,
            aborted: destroyed,
        });
        id
    }

    /// `onDestroyed`: the window of this call went away
    pub fn destroyed(&mut self, call: MediaCallId) {
        for (_, calls) in &mut self.in_flight {
            for entry in calls.iter_mut().filter(|c| c.id == call) {
                entry.aborted = true;
            }
        }
    }

    /// `controller.signal.aborted`; a call that already ended is not aborted
    pub fn aborted(&self, call: MediaCallId) -> bool {
        self.in_flight
            .iter()
            .flat_map(|(_, calls)| calls.iter())
            .any(|c| c.id == call && c.aborted)
    }

    /// the `finally` of `withMediaCallSignal`: the call is forgotten as soon
    /// as it settles, and a window with no call left is forgotten too
    pub fn end(&mut self, sender_id: f64, call: MediaCallId) {
        let Some(at) = self
            .in_flight
            .iter()
            .position(|(sender, _)| *sender == sender_id)
        else {
            return;
        };
        self.in_flight[at].1.retain(|c| c.id != call);
        if self.in_flight[at].1.is_empty() {
            self.in_flight.remove(at);
        }
    }

    /// `abortMediaCalls(senderId)`: the user stopped the AI run of this
    /// window: ends its media calls; the calls aborted, in the order they
    /// started.
    pub fn abort_media_calls(&mut self, sender_id: f64) -> Vec<MediaCallId> {
        let mut aborted = Vec::new();
        if let Some((_, calls)) = self.in_flight.iter_mut().find(|(s, _)| *s == sender_id) {
            for call in calls {
                call.aborted = true;
                aborted.push(call.id);
            }
        }
        aborted
    }

    /// how many calls this window has in flight
    pub fn in_flight(&self, sender_id: f64) -> usize {
        self.in_flight
            .iter()
            .find(|(s, _)| *s == sender_id)
            .map_or(0, |(_, calls)| calls.len())
    }
}
