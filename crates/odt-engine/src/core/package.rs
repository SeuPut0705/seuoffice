//! `core/package.ts`: lenient ODT package reader.
//!
//! Hancom writes `mimetype` after other entries and deflates it, which the
//! ODF packaging rules forbid; this reader accepts any order and either
//! method. It reads the archive itself to keep what a later re-pack needs:
//! each entry's exact uncompressed bytes, its original method and the
//! original physical order. Before anything is inflated the archive passes
//! the same metered zip-bomb gate as the docx engine (`ooxml_pkg`).
//!
//! `OdtEntry.compressed` is the range of the entry's compressed data inside
//! `OdtPackage.original_bytes` (the TypeScript holds a view); read it with
//! `OdtPackage::compressed`.
//!
//! A part's text is decoded as the TypeScript does (`TextDecoder('utf-8', {
//! ignoreBOM: true })`): a byte order mark stays as U+FEFF, so offsets index
//! the same characters a re-encode writes back; an ill-formed sequence
//! becomes U+FFFD.

use std::collections::HashMap;
use std::io::Read;
use std::ops::Range;

use flate2::read::DeflateDecoder;
use jscompat::{js_regex, trim};
use ooxml_pkg::{
    DEFAULT_ZIP_LIMITS, INFLATE_FAILURE, ZipLimits, assert_zip_inflates_within_limits,
};

use super::errors::{OdtError, OdtOpenErrorCode};

/// `ODT_ZIP_LIMITS`: same caps as the docx engine's `DOCX_ZIP_LIMITS` (10,000
/// parts, 512 MiB per part, 1.5 GiB total).
pub const ODT_ZIP_LIMITS: ZipLimits = DEFAULT_ZIP_LIMITS;

/// `ODT_TEXT_MEDIA_TYPE`
pub const ODT_TEXT_MEDIA_TYPE: &str = "application/vnd.oasis.opendocument.text";

/// `OdtEntry`
#[derive(Clone, Debug)]
pub struct OdtEntry {
    /// entry path as stored (UTF-8 decoded)
    pub name: String,
    /// `true` for directory entries (name ends with `/`)
    pub directory: bool,
    /// original compression method: 0 stored, 8 deflated
    pub method: u16,
    /// the entry's original uncompressed bytes
    pub bytes: Vec<u8>,
    /// where the entry's original compressed data sits inside `original_bytes`
    pub compressed: Range<usize>,
    /// CRC-32 from the central directory
    pub crc32: u32,
    /// MS-DOS date (high 16 bits) and time (low 16 bits) as stored
    pub dos_date_time: u32,
    /// offset of the local header (physical order)
    pub offset: u64,
}

/// `OdtPackage`
pub struct OdtPackage {
    /// the archive as received
    pub original_bytes: Vec<u8>,
    /// every entry in original physical order
    pub entries: Vec<OdtEntry>,
    /// trimmed content of the `mimetype` entry, or the manifest root media type if the entry is missing
    pub mimetype: Option<String>,
    /// whether `mimetype` is the first entry (the ODF rule; Hancom breaks it)
    pub mimetype_first: bool,
    /// whether `mimetype` is stored uncompressed (the ODF rule; Hancom breaks it)
    pub mimetype_stored: bool,
    by_name: HashMap<String, usize>,
}

impl OdtPackage {
    /// `get(name)`: the first entry of that name.
    pub fn get(&self, name: &str) -> Option<&OdtEntry> {
        self.by_name.get(name).map(|&at| &self.entries[at])
    }

    /// `text(name)`: the entry decoded as UTF-8 with any byte order mark KEPT
    /// (as U+FEFF), so offsets index the same characters a re-encode writes
    /// back.
    pub fn text(&self, name: &str) -> Option<String> {
        self.get(name)
            .map(|entry| String::from_utf8_lossy(&entry.bytes).into_owned())
    }

    /// The entry's original compressed data (a view of the archive).
    pub fn compressed(&self, entry: &OdtEntry) -> &[u8] {
        &self.original_bytes[entry.compressed.clone()]
    }
}

/// `ReadOdtPackageOptions`
#[derive(Clone, Copy, Debug)]
pub struct ReadOdtPackageOptions {
    /// zip gate limits; default `ODT_ZIP_LIMITS`
    pub limits: ZipLimits,
}

impl Default for ReadOdtPackageOptions {
    fn default() -> Self {
        Self {
            limits: ODT_ZIP_LIMITS,
        }
    }
}

/// `readOdtPackage`: reads the archive after the zip gate. `zip-rejected`
/// (gate) or `corrupt` (not a readable zip) on failure. Does not check the
/// media type or encryption; `open_odt` does.
pub fn read_odt_package(
    bytes: &[u8],
    options: &ReadOdtPackageOptions,
) -> Result<OdtPackage, OdtError> {
    if let Err(message) = assert_zip_inflates_within_limits(bytes, &options.limits) {
        let code = if message.starts_with("zip rejected:") {
            OdtOpenErrorCode::ZipRejected
        } else {
            OdtOpenErrorCode::Corrupt
        };
        return Err(OdtError::open(code, message));
    }
    let records = read_central_directory(bytes)
        .map_err(|message| OdtError::open(OdtOpenErrorCode::Corrupt, message))?;
    let mut entries: Vec<OdtEntry> = Vec::with_capacity(records.len());
    for record in records {
        let data = if record.directory {
            Vec::new()
        } else {
            inflate_entry(&record, bytes).map_err(|message| {
                OdtError::open(
                    OdtOpenErrorCode::Corrupt,
                    format!("odt: entry {} cannot be read: {message}", record.name),
                )
            })?
        };
        entries.push(OdtEntry {
            name: record.name,
            directory: record.directory,
            method: record.method,
            bytes: data,
            compressed: record.compressed,
            crc32: record.crc32,
            dos_date_time: record.dos_date_time,
            offset: record.offset,
        });
    }
    Ok(create_package(bytes.to_vec(), entries))
}

/// `createPackage`
fn create_package(original_bytes: Vec<u8>, entries: Vec<OdtEntry>) -> OdtPackage {
    let mut by_name: HashMap<String, usize> = HashMap::new();
    for (at, entry) in entries.iter().enumerate() {
        by_name.entry(entry.name.clone()).or_insert(at);
    }
    let text = |name: &str| -> Option<String> {
        by_name
            .get(name)
            .map(|&at| String::from_utf8_lossy(&entries[at].bytes).into_owned())
    };
    let mimetype_at = by_name.get("mimetype").copied();
    let mut mimetype: Option<String> = mimetype_at
        .and_then(|_| text("mimetype"))
        .map(|t| trim(&t).to_owned());
    if mimetype.is_none() {
        mimetype = manifest_root_media_type(text("META-INF/manifest.xml").as_deref());
    }
    let first_file = entries.iter().find(|e| !e.directory);
    let mimetype_first = first_file.is_some_and(|e| e.name == "mimetype");
    let mimetype_stored = mimetype_at.is_some_and(|at| entries[at].method == 0);
    OdtPackage {
        original_bytes,
        entries,
        mimetype,
        mimetype_first,
        mimetype_stored,
        by_name,
    }
}

/// `manifestRootMediaType`: the media type of the manifest's `/` entry; used
/// only when `mimetype` is missing.
fn manifest_root_media_type(manifest: Option<&str>) -> Option<String> {
    let manifest = manifest.filter(|m| !m.is_empty())?;
    for found in js_regex!(r"<[\w.-]*:?file-entry\b[^>]*>").find_iter(manifest) {
        let tag = found.as_str();
        let path = js_regex!(r#"full-path\s*=\s*["']([^"']*)["']"#)
            .exec(tag)
            .and_then(|m| m.get(1));
        if path != Some("/") {
            continue;
        }
        return js_regex!(r#"media-type\s*=\s*["']([^"']*)["']"#)
            .exec(tag)
            .and_then(|m| m.get(1))
            .map(|t| trim(t).to_owned());
    }
    None
}

/// `CentralRecord`
struct CentralRecord {
    name: String,
    directory: bool,
    method: u16,
    crc32: u32,
    dos_date_time: u32,
    offset: u64,
    compressed: Range<usize>,
}

const EOCD_SIG: u32 = 0x0605_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const LOCAL_SIG: u32 = 0x0403_4b50;

fn u16_at(bytes: &[u8], i: u64) -> u64 {
    let i = i as usize;
    u64::from(bytes[i]) | u64::from(bytes[i + 1]) << 8
}

fn u32_at(bytes: &[u8], i: u64) -> u64 {
    u16_at(bytes, i) | u16_at(bytes, i + 2) << 16
}

/// `readCentralDirectory`: central directory entries, sorted by local-header
/// offset (physical order). The gate has already rejected zip64, encrypted
/// entries and out-of-bounds offsets; the bounds are re-checked here anyway
/// since this runs on its own.
fn read_central_directory(bytes: &[u8]) -> Result<Vec<CentralRecord>, String> {
    let length = bytes.len() as u64;
    let Some(last) = length.checked_sub(22) else {
        return Err("zip: end of central directory not found".to_owned());
    };
    let mut eocd: Option<u64> = None;
    let mut i = last as i64;
    let floor = last.saturating_sub(0xffff) as i64;
    while i >= floor {
        if u32_at(bytes, i as u64) == u64::from(EOCD_SIG) {
            eocd = Some(i as u64);
            break;
        }
        i -= 1;
    }
    let Some(eocd) = eocd else {
        return Err("zip: end of central directory not found".to_owned());
    };
    let count = u16_at(bytes, eocd + 10);
    let cd_size = u32_at(bytes, eocd + 12);
    let cd_offset = u32_at(bytes, eocd + 16);
    if cd_offset + cd_size > length {
        return Err("zip: corrupt central directory".to_owned());
    }
    let mut records: Vec<CentralRecord> = Vec::new();
    let mut pos = cd_offset;
    for _ in 0..count {
        if pos + 46 > cd_offset + cd_size || u32_at(bytes, pos) != u64::from(CENTRAL_SIG) {
            return Err("zip: corrupt central directory".to_owned());
        }
        let method = u16_at(bytes, pos + 10) as u16;
        let dos_date_time = (u16_at(bytes, pos + 14) << 16 | u16_at(bytes, pos + 12)) as u32;
        let crc32 = u32_at(bytes, pos + 16) as u32;
        let csize = u32_at(bytes, pos + 20);
        let name_len = u16_at(bytes, pos + 28);
        let extra_len = u16_at(bytes, pos + 30);
        let comment_len = u16_at(bytes, pos + 32);
        let offset = u32_at(bytes, pos + 42);
        // names without the UTF-8 flag are decoded as UTF-8 too, as JSZip does
        let raw_name = &bytes[(pos + 46) as usize..((pos + 46 + name_len).min(length)) as usize];
        let decoded = String::from_utf8_lossy(raw_name);
        // `new TextDecoder('utf-8')` drops one leading byte order mark
        let name = decoded
            .strip_prefix('\u{FEFF}')
            .unwrap_or(&decoded)
            .to_owned();
        if offset + 30 > length || u32_at(bytes, offset) != u64::from(LOCAL_SIG) {
            return Err(format!("zip: corrupt local header for {name}"));
        }
        let data_start = offset + 30 + u16_at(bytes, offset + 26) + u16_at(bytes, offset + 28);
        if data_start + csize > length {
            return Err(format!(
                "zip: entry {name} extends past the end of the archive"
            ));
        }
        records.push(CentralRecord {
            directory: name.ends_with('/'),
            name,
            method,
            crc32,
            dos_date_time,
            offset,
            compressed: data_start as usize..(data_start + csize) as usize,
        });
        pos += 46 + name_len + extra_len + comment_len;
    }
    records.sort_by_key(|r| r.offset);
    Ok(records)
}

/// `inflateEntry`
fn inflate_entry(record: &CentralRecord, bytes: &[u8]) -> Result<Vec<u8>, String> {
    let compressed = &bytes[record.compressed.clone()];
    if record.method == 0 {
        return Ok(compressed.to_vec());
    }
    if record.method != 8 {
        return Err(format!("unsupported compression method {}", record.method));
    }
    let mut out = Vec::new();
    DeflateDecoder::new(compressed)
        .read_to_end(&mut out)
        .map_err(|_| INFLATE_FAILURE.to_owned())?;
    Ok(out)
}
