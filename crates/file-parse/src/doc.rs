//! `docToText` of `packages/file-parse/src/doc.ts` over word-extractor 1.0.4
//! (`node_modules/word-extractor/lib/`): `extract(Buffer)`, then `getBody` and
//! `getTextboxes` with `filterUnicode: false` and
//! `includeHeadersAndFooters: false`.
//!
//! `extract` reads the first 512 bytes and dispatches: a compound file goes to
//! the reader of word-extractor (`ole.rs`, `word.rs`; it is not cfb), a zip to
//! `open-office-extractor.js` (`zip.rs` is yauzl, `open_office.rs` the
//! extractor over saxes). A compound file passes the gate of
//! `assertSoundCompoundFile` first, as `doc.ts` does.
//!
//! Where a lone surrogate would be written into the result, it comes out as
//! U+FFFD: a Rust `String` cannot hold one.

mod buffer;
mod ole;
mod open_office;
mod word;
mod zip;

use crate::compound_gate::{
    JsError, Thrown, assert_sound_compound_file, normalize_text, trim_units,
};
use buffer::{Buf, copy};

/// `new WordExtractor().extract(buffer)`: the body and the text boxes.
fn extract(bytes: &[u8]) -> Result<(Vec<u16>, Vec<u16>), Thrown> {
    let mut head = [0_u8; 512];
    copy(bytes, &mut head, 0.0, 0.0, 512.0)?;
    let head = Buf::new(&head);
    if head.read_u16be(0.0)? == f64::from(0xd0cf_u16) {
        let document = ole::CompoundDoc::read(bytes)?;
        return word::extract(&document);
    }
    if head.read_u16be(0.0)? == f64::from(0x504b_u16) {
        let next = head.read_u16be(2.0)?;
        if next == f64::from(0x0304_u16)
            || next == f64::from(0x0506_u16)
            || next == f64::from(0x0708_u16)
        {
            return open_office::extract(bytes);
        }
    }
    Err(Thrown::Error("Unable to read this type of file".into()))
}

/// `docToText`.
pub fn doc_to_text(bytes: &[u8]) -> Result<String, JsError> {
    if bytes.first() == Some(&0xd0) && bytes.get(1) == Some(&0xcf) {
        assert_sound_compound_file(bytes, "Word 97-2003")?;
    }
    let (body, textboxes) = extract(bytes)?;
    let mut joined: Vec<u16> = Vec::new();
    let mut first = true;
    for part in [&body, &textboxes] {
        if trim_units(part).is_empty() {
            continue;
        }
        if !first {
            joined.push(0x0a);
        }
        first = false;
        joined.extend_from_slice(part);
    }
    Ok(String::from_utf16_lossy(&normalize_text(&joined)))
}
