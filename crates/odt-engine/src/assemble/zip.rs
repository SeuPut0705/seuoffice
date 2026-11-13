//! `assemble/zip.ts`: a small zip writer for ODF packages.
//!
//! ODF packaging rules: the `mimetype` entry comes first, STORED (no
//! compression, no extra field), so a reader can sniff the media type at a
//! fixed offset. Entries the save did not touch are written from their
//! original compressed data (same method, same CRC), so their uncompressed
//! bytes cannot change; new and changed entries are deflated (raw deflate,
//! `flate2` at the default level, the `CompressionStream('deflate-raw')` of
//! the host; the compressed bytes may differ from the host's).
//!
//! The clock: `new Date()` of the TypeScript is the argument `now: HostNow`.

use std::borrow::Cow;
use std::io::Write;

use flate2::Compression;
use flate2::write::DeflateEncoder;
use ooxml_pkg::write::UtcDate;

use crate::core::{HostNow, OdtEntry, OdtError, OdtPackage};

/// `ZipEntryInput`: one entry to write.
pub enum ZipEntryInput<'a> {
    /// `{ kind: 'original', entry }`: an entry of the received package,
    /// copied as stored (`method` kept)
    Original {
        pkg: &'a OdtPackage,
        entry: &'a OdtEntry,
    },
    /// `{ kind: 'data', name, data, store?, dosDateTime? }`: new or changed content
    Data {
        name: String,
        data: Cow<'a, [u8]>,
        /// `store?`: absent is `false`
        store: bool,
        dos_date_time: Option<u32>,
    },
}

/// `CRC_TABLE`
const CRC_TABLE: [u32; 256] = {
    let mut table = [0u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 != 0 {
                0xedb8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        table[n] = c;
        n += 1;
    }
    table
};

/// `crc32`
pub fn crc32(bytes: &[u8]) -> u32 {
    let mut c = 0xffff_ffffu32;
    for &b in bytes {
        c = CRC_TABLE[((c ^ u32::from(b)) & 0xff) as usize] ^ (c >> 8);
    }
    c ^ 0xffff_ffff
}

/// `deflateRaw`
fn deflate_raw(bytes: &[u8]) -> Result<Vec<u8>, OdtError> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(bytes)
        .map_err(|e| OdtError::thrown(e.to_string()))?;
    encoder
        .finish()
        .map_err(|e| OdtError::thrown(e.to_string()))
}

/// `dosDateTime`: MS-DOS date (high 16 bits) and time (low 16 bits) of the
/// host's local time at `now` (the local fields are the UTC fields of
/// `ms - offset_minutes * 60000`).
pub fn dos_date_time(now: HostNow) -> u32 {
    let local = now.ms - now.offset_minutes * 60_000.0;
    // an invalid date reads NaN fields, and every `<<` and `|` of those is 0
    let Some(date) = UtcDate::from_time_value(local) else {
        return 0;
    };
    let year = date.year.max(1980);
    let d = (((year - 1980) as i32) << 9) | ((date.month as i32) << 5) | date.day as i32;
    let t =
        ((date.hours as i32) << 11) | ((date.minutes as i32) << 5) | ((date.seconds as i32) >> 1);
    ((d << 16) | t) as u32
}

struct Prepared<'a> {
    name: Vec<u8>,
    utf8: bool,
    method: u16,
    crc: u32,
    data: Cow<'a, [u8]>,
    size: usize,
    dos_date_time: u32,
    directory: bool,
}

/// `nonAscii`: a name needs the UTF-8 flag.
fn non_ascii(name: &str) -> bool {
    !name.is_ascii()
}

/// `prepare`
fn prepare<'b>(input: &'b ZipEntryInput<'_>, now: u32) -> Result<Prepared<'b>, OdtError> {
    match input {
        ZipEntryInput::Original { pkg, entry } => Ok(Prepared {
            name: entry.name.as_bytes().to_vec(),
            utf8: non_ascii(&entry.name),
            method: entry.method,
            crc: entry.crc32,
            data: Cow::Borrowed(pkg.compressed(entry)),
            size: entry.bytes.len(),
            dos_date_time: entry.dos_date_time,
            directory: entry.directory,
        }),
        ZipEntryInput::Data {
            name,
            data,
            store,
            dos_date_time,
        } => {
            let directory = name.ends_with('/');
            let store = *store || directory || data.is_empty();
            Ok(Prepared {
                name: name.as_bytes().to_vec(),
                utf8: non_ascii(name),
                method: if store { 0 } else { 8 },
                crc: crc32(data),
                data: if store {
                    Cow::Borrowed(&**data)
                } else {
                    Cow::Owned(deflate_raw(data)?)
                },
                size: data.len(),
                dos_date_time: dos_date_time.unwrap_or(now),
                directory,
            })
        }
    }
}

struct Writer {
    out: Vec<u8>,
}

impl Writer {
    /// `u16(v)`: `v & 0xffff`, little endian.
    fn u16(&mut self, v: usize) {
        self.out
            .extend_from_slice(&((v & 0xffff) as u16).to_le_bytes());
    }

    /// `u32(v)`: `v >>> 0`, little endian.
    fn u32(&mut self, v: usize) {
        self.out
            .extend_from_slice(&((v & 0xffff_ffff) as u32).to_le_bytes());
    }
}

/// `writeZip`: writes a zip archive of the entries, in the given order.
pub fn write_zip(inputs: &[ZipEntryInput<'_>], now: HostNow) -> Result<Vec<u8>, OdtError> {
    let now = dos_date_time(now);
    let mut entries: Vec<Prepared<'_>> = Vec::with_capacity(inputs.len());
    for input in inputs {
        entries.push(prepare(input, now)?);
    }
    let mut size = 22;
    for e in &entries {
        size += 30 + e.name.len() + e.data.len() + 46 + e.name.len();
    }
    let mut w = Writer {
        out: Vec::with_capacity(size),
    };
    let mut offsets: Vec<usize> = Vec::with_capacity(entries.len());
    for e in &entries {
        offsets.push(w.out.len());
        w.u32(0x0403_4b50);
        w.u16(20);
        w.u16(if e.utf8 { 0x0800 } else { 0 });
        w.u16(usize::from(e.method));
        w.u16((e.dos_date_time & 0xffff) as usize);
        w.u16((e.dos_date_time >> 16) as usize);
        w.u32(e.crc as usize);
        w.u32(e.data.len());
        w.u32(e.size);
        w.u16(e.name.len());
        w.u16(0);
        w.out.extend_from_slice(&e.name);
        w.out.extend_from_slice(&e.data);
    }
    let cd_start = w.out.len();
    for (i, e) in entries.iter().enumerate() {
        w.u32(0x0201_4b50);
        w.u16(20);
        w.u16(20);
        w.u16(if e.utf8 { 0x0800 } else { 0 });
        w.u16(usize::from(e.method));
        w.u16((e.dos_date_time & 0xffff) as usize);
        w.u16((e.dos_date_time >> 16) as usize);
        w.u32(e.crc as usize);
        w.u32(e.data.len());
        w.u32(e.size);
        w.u16(e.name.len());
        w.u16(0);
        w.u16(0);
        w.u16(0);
        w.u16(0);
        w.u32(if e.directory { 0x10 } else { 0 });
        w.u32(offsets[i]);
        w.out.extend_from_slice(&e.name);
    }
    let cd_size = w.out.len() - cd_start;
    w.u32(0x0605_4b50);
    w.u16(0);
    w.u16(0);
    w.u16(entries.len());
    w.u16(entries.len());
    w.u32(cd_size);
    w.u32(cd_start);
    w.u16(0);
    Ok(w.out)
}
