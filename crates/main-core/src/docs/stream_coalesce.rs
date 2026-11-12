//! `apps/docs/src/main/stream-coalesce.ts`: text and reasoning deltas of an AI
//! stream, gathered for a short window and sent as one chunk.
//!
//! A chunk is the object the TypeScript passes (`requestId`, `type`, `text`
//! and whatever else it carries). The `setTimeout` of the gather window is the
//! caller's: [`ChunkCoalescer::due_ms`] is when it fires, and [`ChunkCoalescer::fire`]
//! is its callback.

use jscompat::{JsObject, JsonValue};

/// gather window; two frames at 60 Hz
pub const STREAM_COALESCE_MS: f64 = 32.0;

pub type Chunk = JsObject<JsonValue>;

/// `createChunkCoalescer(send, windowMs)`
pub struct ChunkCoalescer<F: FnMut(Chunk)> {
    send: F,
    window_ms: f64,
    pending: Option<Chunk>,
    /// when the timer of the pending chunk fires; `None` = no timer
    due_ms: Option<f64>,
}

pub fn create_chunk_coalescer<F: FnMut(Chunk)>(
    send: F,
    window_ms: Option<f64>,
) -> ChunkCoalescer<F> {
    ChunkCoalescer {
        send,
        window_ms: window_ms.unwrap_or(STREAM_COALESCE_MS),
        pending: None,
        due_ms: None,
    }
}

/// `chunk.type` when it is one of `MERGED_TYPES`
fn merged_type(chunk: &Chunk) -> Option<&str> {
    match chunk.get("type") {
        Some(JsonValue::String(kind)) if kind == "delta" || kind == "reasoning" => Some(kind),
        _ => None,
    }
}

fn text_of(chunk: &Chunk) -> Option<&str> {
    match chunk.get("text") {
        Some(JsonValue::String(text)) => Some(text),
        _ => None,
    }
}

impl<F: FnMut(Chunk)> ChunkCoalescer<F> {
    /// When the gather timer fires, if one is set.
    pub fn due_ms(&self) -> Option<f64> {
        self.due_ms
    }

    /// Send what is gathered now (end of the stream; the timer's callback).
    pub fn flush(&mut self) {
        self.due_ms = None;
        if let Some(out) = self.pending.take() {
            (self.send)(out);
        }
    }

    /// The timer's callback.
    pub fn fire(&mut self) {
        self.flush();
    }

    /// Pass a chunk on: deltas are gathered, anything else goes out after
    /// them. `now_ms` is the clock a timer set here starts at.
    pub fn push(&mut self, chunk: Chunk, now_ms: f64) {
        if merged_type(&chunk).is_none() || text_of(&chunk).is_none() {
            self.flush();
            (self.send)(chunk);
            return;
        }
        if let Some(pending) = &mut self.pending
            && merged_type(pending) == merged_type(&chunk)
        {
            // `{ ...pending, text: `${pending.text ?? ''}${chunk.text}` }`
            let joined = format!(
                "{}{}",
                text_of(pending).unwrap_or(""),
                text_of(&chunk).unwrap_or("")
            );
            pending.set("text", JsonValue::String(joined));
            return;
        }
        self.flush();
        self.pending = Some(chunk);
        self.due_ms = Some(now_ms + self.window_ms);
    }
}
