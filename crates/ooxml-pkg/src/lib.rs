//! The OOXML package: the entries of the zip container and their text.

use std::borrow::Cow;
use std::io::{Cursor, Read};

use flate2::read::DeflateDecoder;
use zip::result::ZipError;
use zip::{CompressionMethod, ZipArchive};

mod gate;
pub mod jszip;
mod load;
mod normalize;
mod package;
pub mod write;

pub use gate::{
    DEFAULT_ZIP_LIMITS, DeclaredPart, INFLATE_FAILURE, INFLATE_TRAILING, ZipLimits,
    assert_declared_sizes_within_limits, assert_zip_inflates_within_limits,
};
pub use load::{load_docx_package, load_package};
pub use normalize::{
    dedupe_style_refs, has_duplicate_style_refs, has_universal_measures, needs_ooxml_normalization,
    normalize_ooxml_xml,
};
pub use package::{Package, Part, ReadError};

/// Per-entry cap, the `maxPartBytes` of the TypeScript zip gate.
pub const MAX_ENTRY_BYTES: u64 = 512 * 1024 * 1024;

/// One entry of the central directory, in directory order.
pub struct Entry {
    /// The file name bytes as stored, before any decoding.
    pub raw_name: Vec<u8>,
    pub is_dir: bool,
    /// The inflated content, or why it could not be read.
    pub content: Result<Vec<u8>, String>,
}

/// Reads every entry of a zip container.
///
/// An entry is accepted the way JSZip accepts it: the data must inflate to
/// exactly the declared size, and the stored CRC-32 is not checked. A document
/// whose checksum went stale opens in the TypeScript engine, so it opens here.
pub fn read_entries(bytes: &[u8]) -> Result<Vec<Entry>, ZipError> {
    let mut archive = ZipArchive::new(Cursor::new(bytes))?;
    let mut entries = Vec::with_capacity(archive.len());
    for index in 0..archive.len() {
        // the raw reader hands out the stored bytes and skips the checksum
        let mut file = archive.by_index_raw(index)?;
        let declared_size = file.size();
        let content = match file.compression() {
            CompressionMethod::Stored => read_capped(&mut file),
            CompressionMethod::Deflated => read_capped(DeflateDecoder::new(&mut file)),
            other => Err(format!("compression method {other} is not supported")),
        }
        .and_then(|content| {
            if content.len() as u64 == declared_size {
                Ok(content)
            } else {
                Err("uncompressed data size mismatch".to_owned())
            }
        });
        entries.push(Entry {
            raw_name: file.name_raw().to_vec(),
            is_dir: file.is_dir(),
            content,
        });
    }
    Ok(entries)
}

fn read_capped(reader: impl Read) -> Result<Vec<u8>, String> {
    let mut content = Vec::new();
    match reader.take(MAX_ENTRY_BYTES + 1).read_to_end(&mut content) {
        Ok(_) if content.len() as u64 > MAX_ENTRY_BYTES => {
            Err("entry exceeds the size limit".to_owned())
        }
        Ok(_) => Ok(content),
        Err(error) => Err(error.to_string()),
    }
}

/// The text of an entry as the TypeScript engine reads it in Node
/// (`JSZip.file(name).async('string')`): UTF-8, each ill-formed sequence
/// replaced by U+FFFD the way the WHATWG decoder does, and a leading byte order
/// mark kept as U+FEFF.
pub fn decode_text(bytes: &[u8]) -> Cow<'_, str> {
    String::from_utf8_lossy(bytes)
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    use super::*;

    const STORED_TEXT: &[u8] = b"stored content, long enough to be found";

    fn container() -> Vec<u8> {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        writer.start_file("word/document.xml", deflated).unwrap();
        writer.write_all(&b"<w:document/>".repeat(1000)).unwrap();
        writer.add_directory("word/media/", stored).unwrap();
        writer.start_file("nXme.xml", stored).unwrap();
        writer.write_all(STORED_TEXT).unwrap();
        writer.start_file("empty.xml", deflated).unwrap();
        writer.finish().unwrap().into_inner()
    }

    fn replace(bytes: &mut [u8], from: &[u8], to: &[u8]) -> usize {
        let positions: Vec<usize> = bytes
            .windows(from.len())
            .enumerate()
            .filter(|(_, w)| *w == from)
            .map(|(at, _)| at)
            .collect();
        for at in &positions {
            bytes[*at..*at + to.len()].copy_from_slice(to);
        }
        positions.len()
    }

    #[test]
    fn entries_come_in_directory_order_with_their_content() {
        let entries = read_entries(&container()).unwrap();
        let names: Vec<&[u8]> = entries.iter().map(|entry| &*entry.raw_name).collect();
        assert_eq!(
            names,
            [
                &b"word/document.xml"[..],
                b"word/media/",
                b"nXme.xml",
                b"empty.xml"
            ]
        );
        assert_eq!(
            entries.iter().map(|entry| entry.is_dir).collect::<Vec<_>>(),
            [false, true, false, false]
        );
        assert_eq!(
            entries[0].content.as_deref(),
            Ok(&*b"<w:document/>".repeat(1000))
        );
        assert_eq!(entries[2].content.as_deref(), Ok(STORED_TEXT));
        assert_eq!(entries[3].content.as_deref(), Ok(&b""[..]));
    }

    #[test]
    fn a_name_is_handed_out_as_stored_bytes() {
        let mut bytes = container();
        let local_header_and_central_directory = 2;
        assert_eq!(
            replace(&mut bytes, b"nXme.xml", b"n\xE9me.xml"),
            local_header_and_central_directory
        );
        let entries = read_entries(&bytes).unwrap();
        assert_eq!(entries[2].raw_name, b"n\xE9me.xml");
        assert_eq!(entries[2].content.as_deref(), Ok(STORED_TEXT));
    }

    #[test]
    fn a_stale_checksum_does_not_hide_the_content() {
        let mut bytes = container();
        assert_eq!(replace(&mut bytes, b"stored content", b"STORED CONTENT"), 1);
        let entries = read_entries(&bytes).unwrap();
        assert!(
            entries[2]
                .content
                .as_deref()
                .unwrap()
                .starts_with(b"STORED CONTENT")
        );
    }

    #[test]
    fn damaged_deflate_data_fails_that_entry_only() {
        let mut bytes = container();
        // "word/document.xml" is 17 bytes; the deflate stream starts after the 30-byte header
        bytes[30 + 17] = 0x07;
        let entries = read_entries(&bytes).unwrap();
        assert!(entries[0].content.is_err());
        assert_eq!(entries[2].content.as_deref(), Ok(STORED_TEXT));
    }

    #[test]
    fn a_byte_order_mark_stays_in_the_text() {
        assert_eq!(decode_text(b"\xEF\xBB\xBF<a/>"), "\u{FEFF}<a/>");
    }

    #[test]
    fn a_truncated_sequence_is_one_replacement_character() {
        assert_eq!(decode_text(b"a\xE2\x82b"), "a\u{FFFD}b");
        assert_eq!(decode_text(b"ok\xF0\x9F\x98"), "ok\u{FFFD}");
    }

    #[test]
    fn stray_continuations_overlong_forms_and_surrogates_are_replaced_byte_by_byte() {
        assert_eq!(decode_text(b"\x80\x80"), "\u{FFFD}\u{FFFD}");
        assert_eq!(decode_text(b"\xC0\xAF"), "\u{FFFD}\u{FFFD}");
        assert_eq!(decode_text(b"\xED\xA0\x80"), "\u{FFFD}\u{FFFD}\u{FFFD}");
    }

    #[test]
    fn bytes_that_are_not_a_zip_are_refused() {
        assert!(read_entries(b"not a zip").is_err());
        assert!(read_entries(b"").is_err());
    }
}
