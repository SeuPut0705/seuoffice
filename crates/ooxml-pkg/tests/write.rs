//! What JSZip 3.10.1 writes. The expected bytes are those of
//! `zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })` under
//! Node 22 with the clock stopped at the instant passed here, for the same
//! `zip.file()` calls.

use std::io::Read;

use flate2::read::DeflateDecoder;
use ooxml_pkg::write::generate;
use ooxml_pkg::{Package, read_entries};

fn bytes(hex: &[&str]) -> Vec<u8> {
    let hex = hex.concat();
    (0..hex.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).expect("hex"))
        .collect()
}

/// `b`, `a/\u{e9}.txt`, `10` and `b` again, all empty, at
/// 2023-11-14T22:13:21.999Z: stored entries, an array-index name first, a
/// folder JSZip adds, and a UTF-8 name with its flag and Unicode Path field.
const STORED: &[&str] = &[
    "504b03040a0000000000aab16e57000000000000000000000000020000003130",
    "504b03040a0000000000aab16e57000000000000000000000000010000006250",
    "4b03040a0000000000aab16e5700000000000000000000000002000000612f50",
    "4b03040a0000080000aab16e5700000000000000000000000008001100612fc3",
    "a92e74787475700d00019ef94609612fc3a92e747874504b010214000a000000",
    "0000aab16e570000000000000000000000000200000000000000000000000000",
    "000000003130504b010214000a0000000000aab16e5700000000000000000000",
    "000001000000000000000000000000002000000062504b010214000a00000000",
    "00aab16e5700000000000000000000000002000000000000000000100000003f",
    "000000612f504b010214000a0000080000aab16e570000000000000000000000",
    "0008001100000000000000000000005f000000612fc3a92e74787475700d0001",
    "9ef94609612fc3a92e747874504b05060000000004000400d600000096000000",
    "0000",
];

#[test]
fn stored_entries_are_byte_for_byte_what_jszip_writes() {
    let mut package = Package::default();
    for name in ["b", "a/\u{e9}.txt", "10", "b"] {
        package.set_file(name.to_owned(), Vec::new());
    }
    assert_eq!(
        generate(&package, 1_700_000_001_999.0).expect("writes"),
        bytes(STORED)
    );
}

/// `w/x.xml` at 1969-12-31T23:59:59Z. Only the deflate stream (and the sizes
/// and offsets after it) may differ: the compressor is not pako.
const DEFLATED: &[&str] = &[
    "504b03040a00000000007dbf9feb00000000000000000000000002000000772f",
    "504b03040a00000008007dbf9febe619bbac100000001800000007000000772f",
    "782e786d6cb349b4cb48cdc9c95740226df413ed00504b010214000a00000000",
    "007dbf9feb000000000000000000000000020000000000000000001000000000",
    "000000772f504b010214000a00000008007dbf9febe619bbac10000000180000",
    "00070000000000000000000000000020000000772f782e786d6c504b05060000",
    "00000200020065000000550000000000",
];

#[test]
fn a_deflated_entry_has_the_header_jszip_writes_before_1980_too() {
    let content = b"<a>hello hello hello</a>";
    let package = Package::from_parts([("w/x.xml", &content[..])]);
    let ours = generate(&package, -1000.0).expect("writes");
    let theirs = bytes(DEFLATED);
    // the stored folder, then the file's local header up to the compressed size
    assert_eq!(ours[..32 + 18], theirs[..32 + 18]);
    // uncompressed size, name length, extra length, name
    assert_eq!(ours[32 + 22..32 + 37], theirs[32 + 22..32 + 37]);
    let entries = read_entries(&ours).expect("a zip");
    assert_eq!(entries.len(), 2);
    assert!(entries[0].is_dir);
    assert_eq!(entries[1].content.as_deref(), Ok(&content[..]));
    let size = u32::from_le_bytes([ours[32 + 18], ours[32 + 19], ours[32 + 20], ours[32 + 21]]);
    let mut inflated = Vec::new();
    DeflateDecoder::new(&ours[32 + 37..32 + 37 + size as usize])
        .read_to_end(&mut inflated)
        .expect("inflates");
    assert_eq!(inflated, content);
}

#[test]
fn an_invalid_date_is_written_as_zero() {
    let package = Package::from_parts([("a", "")]);
    let ours = generate(&package, f64::NAN).expect("writes");
    assert_eq!(ours[10..14], [0, 0, 0, 0]);
}
