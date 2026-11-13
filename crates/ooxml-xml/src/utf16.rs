const STRIDE: usize = 256;

/// Converts byte offsets of one text into the string indices JavaScript uses.
pub struct Utf16Map<'a> {
    text: &'a str,
    index: Utf16Index,
}

/// The checkpoints of a `Utf16Map` without the text, for a holder that owns
/// the text beside it. Each conversion takes the text it was built from.
pub struct Utf16Index {
    /// `checkpoints[k]` counts the UTF-16 units of the characters that start
    /// before byte `k * STRIDE`; the last entry is the whole text.
    checkpoints: Vec<u32>,
}

/// UTF-16 units of the character whose first byte is `byte` (0 for a continuation byte).
fn units_started_by(byte: u8) -> u32 {
    match byte {
        0x80..=0xBF => 0,
        0xF0..=0xFF => 2,
        _ => 1,
    }
}

fn units_in(bytes: &[u8]) -> u32 {
    bytes.iter().map(|&byte| units_started_by(byte)).sum()
}

impl Utf16Index {
    pub fn new(text: &str) -> Self {
        let text = text.as_bytes();
        let mut checkpoints = Vec::with_capacity(text.len() / STRIDE + 2);
        let mut units = 0;
        for chunk in text.chunks(STRIDE) {
            checkpoints.push(units);
            units += units_in(chunk);
        }
        checkpoints.push(units);
        Self { checkpoints }
    }

    /// The UTF-16 offset of `byte` in `text`, the text the index was built
    /// from; `byte` must be a character boundary of it.
    pub fn to_utf16(&self, text: &str, byte: usize) -> u32 {
        let text = text.as_bytes();
        debug_assert!(byte == text.len() || units_started_by(text[byte]) != 0);
        let block = byte / STRIDE;
        self.checkpoints[block] + units_in(&text[block * STRIDE..byte])
    }

    /// The byte offset of the UTF-16 offset `unit` in `text`, the text the
    /// index was built from. A unit past the end is the end; a unit between
    /// the two halves of a pair is the end of that character, as a match of
    /// `JsRegex` that would end inside a pair ends after it.
    pub fn to_byte(&self, text: &str, unit: u32) -> usize {
        let bytes = text.as_bytes();
        let last = self.checkpoints.len() - 1;
        if unit >= self.checkpoints[last] {
            return bytes.len();
        }
        // the last block that starts at or before `unit`
        let block = self.checkpoints[..last].partition_point(|&start| start <= unit) - 1;
        let mut at = block * STRIDE;
        let mut units = self.checkpoints[block];
        while at < bytes.len() {
            let width = units_started_by(bytes[at]);
            if width != 0 {
                if units >= unit {
                    return at;
                }
                units += width;
            }
            at += 1;
        }
        bytes.len()
    }

    /// UTF-16 units of the whole text.
    pub fn len_utf16(&self) -> u32 {
        self.checkpoints[self.checkpoints.len() - 1]
    }
}

impl<'a> Utf16Map<'a> {
    pub fn new(text: &'a str) -> Self {
        Self {
            text,
            index: Utf16Index::new(text),
        }
    }

    /// The UTF-16 offset of `byte`, which must be a character boundary of the text
    /// (every offset the engine produces is one).
    pub fn to_utf16(&self, byte: usize) -> u32 {
        self.index.to_utf16(self.text, byte)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offsets_by_definition(text: &str) -> Vec<(usize, u32)> {
        let mut units = 0u32;
        let mut pairs: Vec<(usize, u32)> = text
            .char_indices()
            .map(|(byte, ch)| {
                let pair = (byte, units);
                units += ch.len_utf16() as u32;
                pair
            })
            .collect();
        pairs.push((text.len(), units));
        pairs
    }

    #[test]
    fn ascii_offsets_are_unchanged() {
        let map = Utf16Map::new("<w:p>plain</w:p>");
        assert_eq!(map.to_utf16(0), 0);
        assert_eq!(map.to_utf16(16), 16);
    }

    #[test]
    fn a_surrogate_pair_counts_two_units_and_four_bytes() {
        let text = "a\u{1F600}b\u{D55C}c";
        let map = Utf16Map::new(text);
        assert_eq!(map.to_utf16(1), 1);
        assert_eq!(map.to_utf16(5), 3);
        assert_eq!(map.to_utf16(6), 4);
        assert_eq!(map.to_utf16(9), 5);
        assert_eq!(map.to_utf16(text.len()), 6);
    }

    #[test]
    fn every_boundary_matches_the_definition_across_checkpoints() {
        let one_of_each_utf8_length = "x\u{00E9}\u{D55C}\u{1F600}";
        for padding in 0..one_of_each_utf8_length.len() {
            let text = "p".repeat(padding) + &one_of_each_utf8_length.repeat(200);
            let map = Utf16Map::new(&text);
            for (byte, units) in offsets_by_definition(&text) {
                assert_eq!(map.to_utf16(byte), units, "padding {padding}, byte {byte}");
            }
        }
    }

    #[test]
    fn to_byte_inverts_every_boundary_and_rounds_a_split_pair_up() {
        let one_of_each_utf8_length = "x\u{00E9}\u{D55C}\u{1F600}";
        for padding in 0..one_of_each_utf8_length.len() {
            let text = "p".repeat(padding) + &one_of_each_utf8_length.repeat(200);
            let index = Utf16Index::new(&text);
            for (byte, units) in offsets_by_definition(&text) {
                assert_eq!(
                    index.to_byte(&text, units),
                    byte,
                    "padding {padding}, unit {units}"
                );
            }
            assert_eq!(
                index.len_utf16(),
                offsets_by_definition(&text).last().unwrap().1
            );
            assert_eq!(index.to_byte(&text, u32::MAX), text.len());
        }
        let text = "a\u{1F600}b";
        assert_eq!(Utf16Index::new(text).to_byte(text, 2), 5);
    }

    #[test]
    fn the_end_of_a_text_that_fills_whole_strides() {
        let text = "\u{00E9}".repeat(STRIDE);
        assert_eq!(text.len(), 2 * STRIDE);
        assert_eq!(Utf16Map::new(&text).to_utf16(text.len()), STRIDE as u32);
    }

    #[test]
    fn empty_text() {
        assert_eq!(Utf16Map::new("").to_utf16(0), 0);
    }
}
