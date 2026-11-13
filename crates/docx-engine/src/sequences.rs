//! The counters the TypeScript keeps as module state (`hfTextBoxSeq` of
//! parse.ts, the standalone bookmark counter of generate.ts), counted over
//! every call of the process. A call that owes the host a conversion is
//! called again with the answer and its first pass is discarded: that pass
//! must not have counted, or the ids of the answer differ from the
//! TypeScript's, which parses once. The binding saves them before a call
//! and puts them back when the call answers what it owes instead.

use std::sync::atomic::Ordering;

use crate::generate::paragraph::STANDALONE_BOOKMARK_SEQ;
use crate::parse::drawings::hf_textbox::HF_TEXT_BOX_SEQ;

/// The counters at one moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sequences {
    text_boxes: u64,
    bookmarks: u64,
}

/// The counters now.
pub fn save() -> Sequences {
    Sequences {
        text_boxes: HF_TEXT_BOX_SEQ.load(Ordering::Relaxed),
        bookmarks: STANDALONE_BOOKMARK_SEQ.load(Ordering::Relaxed),
    }
}

/// Puts the counters back to what `save` read.
pub fn restore(saved: Sequences) {
    HF_TEXT_BOX_SEQ.store(saved.text_boxes, Ordering::Relaxed);
    STANDALONE_BOOKMARK_SEQ.store(saved.bookmarks, Ordering::Relaxed);
}
