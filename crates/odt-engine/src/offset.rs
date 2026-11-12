//! Offsets as the TypeScript stores them. Inside the engine an offset into a
//! string is a UTF-8 byte offset, as everywhere in the engines; an offset that
//! the bridge map, an `ext` record or any other JSON value holds is a count of
//! UTF-16 code units, because the TypeScript wrote it and reads it back. `U16`
//! is that second kind, so the compiler refuses to mix the two: a byte offset
//! becomes a `U16` through the string it indexes, and back.

use ooxml_xml::Utf16Index;
use serde::{Deserialize, Serialize};

/// A string index as JavaScript counts it: UTF-16 code units.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct U16(pub u32);

/// `text.length`.
pub fn u16_len(text: &str) -> U16 {
    U16(text.encode_utf16().count() as u32)
}

/// The UTF-16 offset of byte `byte` of a short text (a paragraph text, a
/// name). A part string uses its `Utf16Index` instead: this walks from the
/// start.
pub fn to_u16(text: &str, byte: usize) -> U16 {
    u16_len(&text[..byte])
}

/// The byte offset of the UTF-16 offset `at` of a short text. Past the end is
/// the end; between the halves of a pair is the end of that character.
pub fn to_byte(text: &str, at: U16) -> usize {
    let mut units = 0u32;
    for (byte, ch) in text.char_indices() {
        if units >= at.0 {
            return byte;
        }
        units += ch.len_utf16() as u32;
    }
    text.len()
}

/// A part string with its index, for the conversions of a large text.
pub struct IndexedText {
    pub text: String,
    index: Utf16Index,
}

impl IndexedText {
    pub fn new(text: String) -> Self {
        let index = Utf16Index::new(&text);
        Self { text, index }
    }

    pub fn to_u16(&self, byte: usize) -> U16 {
        U16(self.index.to_utf16(&self.text, byte))
    }

    pub fn to_byte(&self, at: U16) -> usize {
        self.index.to_byte(&self.text, at.0)
    }

    pub fn len_u16(&self) -> U16 {
        U16(self.index.len_utf16())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_and_indexed_conversions_agree() {
        let text = "a\u{D55C}\u{1F600}b".repeat(100);
        let indexed = IndexedText::new(text.clone());
        for (byte, _) in text.char_indices().chain([(text.len(), ' ')]) {
            let at = to_u16(&text, byte);
            assert_eq!(indexed.to_u16(byte), at);
            assert_eq!(to_byte(&text, at), byte);
            assert_eq!(indexed.to_byte(at), byte);
        }
        assert_eq!(indexed.len_u16(), u16_len(&text));
        assert_eq!(to_byte("a\u{1F600}b", U16(2)), 5);
    }
}
