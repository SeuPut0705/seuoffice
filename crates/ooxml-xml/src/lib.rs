//! Text-level XML shared by the document engines.
//!
//! Offsets are UTF-8 byte offsets everywhere in Rust. The TypeScript callers
//! count UTF-16 code units, so [`Utf16Map`] converts at the boundary only.

mod js;
mod tag;
mod utf16;

pub use tag::{Tag, opaque_end, tag_at};
pub use utf16::Utf16Map;
