//! `apps/docs/src/main/byte-handoff.ts`: document bytes cross to the renderer
//! over the media protocol instead of an IPC reply. A one-shot token URL
//! hands the buffer to a single fetch.
//!
//! The module state (`pending`, `pendingBytes`) is a [`ByteHandoffs`] value.
//! The TypeScript gives each handoff a `setTimeout` of `HANDOFF_TTL_MS`; here
//! the caller owns the clock: a handoff carries the time it was made, and
//! [`ByteHandoffs::expire`] is what the timers' callbacks do when they fire.
//! `crypto.randomUUID()` is the `token` parameter.

use super::lazy_media_inline::LAZY_MEDIA_SCHEME;

const HANDOFF_HOST: &str = "handoff";
/// an unclaimed handoff (renderer gone before its fetch) is dropped after this
pub const HANDOFF_TTL_MS: f64 = 60_000.0;
/// a burst past this many unclaimed handoffs drops the oldest one
pub const MAX_PENDING_HANDOFFS: usize = 8;
/// a burst past this many buffered bytes drops the oldest handoffs
pub const MAX_PENDING_HANDOFF_BYTES: u64 = 1024 * 1024 * 1024;

/// `bytes.length`
pub trait ByteLength {
    fn byte_length(&self) -> u64;
}

impl ByteLength for Vec<u8> {
    fn byte_length(&self) -> u64 {
        self.len() as u64
    }
}

struct Entry<B> {
    token: String,
    bytes: B,
    /// the id of this entry's timer (`entry.timer`)
    timer: u64,
}

struct Timer {
    id: u64,
    token: String,
    due_ms: f64,
}

/// The `pending` map (insertion-ordered), `pendingBytes`, and the timers of
/// the entries.
pub struct ByteHandoffs<B> {
    pending: Vec<Entry<B>>,
    pending_bytes: u64,
    timers: Vec<Timer>,
    next_timer: u64,
}

impl<B> Default for ByteHandoffs<B> {
    fn default() -> Self {
        ByteHandoffs {
            pending: Vec::new(),
            pending_bytes: 0,
            timers: Vec::new(),
            next_timer: 0,
        }
    }
}

impl<B: ByteLength> ByteHandoffs<B> {
    pub fn new() -> Self {
        Self::default()
    }

    /// release one handoff's timer, entry and bytes; the timer must go with the entry
    fn drop_pending(&mut self, token: &str) {
        let Some(at) = self.pending.iter().position(|entry| entry.token == token) else {
            return;
        };
        let entry = self.pending.remove(at);
        self.timers.retain(|timer| timer.id != entry.timer);
        self.pending_bytes -= entry.bytes.byte_length();
    }

    /// oldest-first eviction until `bytes` fits under both caps
    fn evict_for(&mut self, length: u64) {
        while self.pending.len() + 1 > MAX_PENDING_HANDOFFS
            || self.pending_bytes + length > MAX_PENDING_HANDOFF_BYTES
        {
            let Some(oldest) = self.pending.first() else {
                return;
            };
            let token = oldest.token.clone();
            self.drop_pending(&token);
        }
    }

    /// `handOffBytes(bytes)`: the URL the renderer fetches once. `now_ms` is
    /// the clock the timer starts at.
    pub fn hand_off_bytes(&mut self, bytes: B, token: String, now_ms: f64) -> String {
        self.evict_for(bytes.byte_length());
        let timer = self.next_timer;
        self.next_timer += 1;
        self.timers.push(Timer {
            id: timer,
            token: token.clone(),
            due_ms: now_ms + HANDOFF_TTL_MS,
        });
        self.pending_bytes += bytes.byte_length();
        let url = format!("{LAZY_MEDIA_SCHEME}://{HANDOFF_HOST}/{token}");
        // `pending.set(token, ...)` keeps the place of a token set before
        match self.pending.iter_mut().find(|entry| entry.token == token) {
            Some(entry) => {
                entry.bytes = bytes;
                entry.timer = timer;
            }
            None => self.pending.push(Entry {
                token,
                bytes,
                timer,
            }),
        }
        url
    }

    /// The bytes behind a handoff URL, released on first take; `None` for any
    /// other URL.
    pub fn take_handoff(&mut self, url: &str) -> Option<B> {
        let prefix = format!("{LAZY_MEDIA_SCHEME}://{HANDOFF_HOST}/");
        let token = url.strip_prefix(prefix.as_str())?;
        let at = self.pending.iter().position(|entry| entry.token == token)?;
        let entry = self.pending.remove(at);
        self.timers.retain(|timer| timer.id != entry.timer);
        self.pending_bytes -= entry.bytes.byte_length();
        Some(entry.bytes)
    }

    /// `pendingHandoffCount()`
    pub fn pending_handoff_count(&self) -> usize {
        self.pending.len()
    }

    /// The timers that are due at `now_ms` fire, the earliest first (a tie in
    /// the order they were set): each drops the handoff of its token.
    pub fn expire(&mut self, now_ms: f64) {
        loop {
            let due = self
                .timers
                .iter()
                .enumerate()
                .filter(|(_, timer)| timer.due_ms <= now_ms)
                .min_by(|(_, a), (_, b)| a.due_ms.total_cmp(&b.due_ms).then(a.id.cmp(&b.id)))
                .map(|(at, _)| at);
            let Some(at) = due else {
                return;
            };
            let timer = self.timers.remove(at);
            self.drop_pending(&timer.token);
        }
    }
}
