//! A package written as a zip the way JSZip 3.10.1 writes one with
//! `generateAsync({ type: 'uint8array', compression: 'DEFLATE' })` and the
//! default options: entries in `Object.keys(zip.files)` order, folders stored,
//! files deflated, no data descriptors, DOS as the platform.
//!
//! The deflate stream is zlib-rs, not pako: it inflates to the same bytes, but
//! the compressed bytes, and the sizes and offsets that follow from them, are
//! its own.

use std::io::{self, Write};

use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};
use jscompat::to_int32;

use crate::Package;

const LOCAL_FILE_HEADER: &[u8; 4] = b"PK\x03\x04";
const CENTRAL_FILE_HEADER: &[u8; 4] = b"PK\x01\x02";
const CENTRAL_DIRECTORY_END: &[u8; 4] = b"PK\x05\x06";

const STORE: u16 = 0;
const DEFLATE: u16 = 8;
/// "DOS, version 2.0"
const VERSION_MADE_BY: u16 = 0x0014;
/// JSZip writes 1.0 whatever the method.
const VERSION_NEEDED: u16 = 0x000A;
/// Bit 11, the language encoding flag: the name is UTF-8.
const UTF8_NAME: u16 = 0x0800;
/// The DOS directory attribute.
const DOS_DIRECTORY: u32 = 0x0010;

/// The fields of a JavaScript `Date` read with its `getUTC*` methods.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UtcDate {
    pub year: i64,
    /// 1 to 12, one more than `getUTCMonth()`.
    pub month: i64,
    pub day: i64,
    pub hours: i64,
    pub minutes: i64,
    pub seconds: i64,
    pub milliseconds: i64,
}

impl UtcDate {
    /// The date of a time value (milliseconds since 1970 UTC, as `Date`
    /// holds it after `TimeClip`); `None` for an invalid date.
    pub fn from_time_value(time: f64) -> Option<Self> {
        if !time.is_finite() {
            return None;
        }
        // a time value is an integer within ±8.64e15: exact in i64
        let time = time as i64;
        let days = time.div_euclid(86_400_000);
        let in_day = time.rem_euclid(86_400_000);
        // civil_from_days of Howard Hinnant's date algorithms
        let z = days + 719_468;
        let era = z.div_euclid(146_097);
        let day_of_era = z.rem_euclid(146_097);
        let year_of_era =
            (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
        let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
        let shifted_month = (5 * day_of_year + 2) / 153;
        let day = day_of_year - (153 * shifted_month + 2) / 5 + 1;
        let month = if shifted_month < 10 {
            shifted_month + 3
        } else {
            shifted_month - 9
        };
        let year = year_of_era + era * 400 + i64::from(month <= 2);
        Some(Self {
            year,
            month,
            day,
            hours: in_day / 3_600_000,
            minutes: in_day / 60_000 % 60,
            seconds: in_day / 1000 % 60,
            milliseconds: in_day % 1000,
        })
    }
}

/// The DOS time and date JSZip computes with 32-bit operators and writes as
/// the low 16 bits: years outside 1980..2107 wrap, an invalid date is 0.
fn dos_time_and_date(date: f64) -> (u16, u16) {
    let Some(utc) = UtcDate::from_time_value(date) else {
        // every getUTC* of an invalid date is NaN, and NaN | 0 is 0
        return (0, 0);
    };
    let int = |x: i64| to_int32(x as f64);
    let mut time = int(utc.hours).wrapping_shl(6);
    time |= int(utc.minutes);
    time = time.wrapping_shl(5);
    time |= to_int32(utc.seconds as f64 / 2.0);
    let mut day = int(utc.year - 1980).wrapping_shl(4);
    day |= int(utc.month);
    day = day.wrapping_shl(5);
    day |= int(utc.day);
    (time as u16, day as u16)
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = Crc::new();
    crc.update(bytes);
    crc.sum()
}

fn deflate(bytes: &[u8]) -> io::Result<Vec<u8>> {
    let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes)?;
    encoder.finish()
}

/// `decToHex(x, 2)`: the low 16 bits.
fn put16(out: &mut Vec<u8>, x: u64) {
    out.extend_from_slice(&(x as u16).to_le_bytes());
}

/// `decToHex(x, 4)`: the low 32 bits.
fn put32(out: &mut Vec<u8>, x: u64) {
    out.extend_from_slice(&(x as u32).to_le_bytes());
}

/// Writes every part of `package`, in its order, stamped with its own date
/// (`Part::date`, a time value in milliseconds) or else `date`. JSZip stamps
/// each entry with the date it was given or the clock at the time
/// `zip.file()` added it; here the caller passes the instant.
///
/// A part that cannot be read (its content was damaged when it was loaded)
/// is an error: JSZip would fail on it the same way.
pub fn generate(package: &Package, date: f64) -> io::Result<Vec<u8>> {
    generate_storing(package, date, &|_| false)
}

/// [`generate`], with the files `stored(name)` names written with method 0
/// (STORE) instead of deflated: `zip.file(name, data, { compression: 'STORE' })`.
pub fn generate_storing(
    package: &Package,
    date: f64,
    stored: &dyn Fn(&str) -> bool,
) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut directory = Vec::new();
    for part in package.parts() {
        let (dos_time, dos_date) = dos_time_and_date(part.date.unwrap_or(date));
        // JSZip writes a folder with no content
        let data = if part.is_dir {
            &[][..]
        } else {
            part.bytes().map_err(io::Error::other)?
        };
        let name = part.name.as_bytes();
        // JSZip stores folders and empty files, and deflates the rest but
        // what the caller asks to store
        let (method, stored) = if part.is_dir || data.is_empty() {
            (STORE, Vec::new())
        } else if stored(part.name.as_str()) {
            (STORE, data.to_vec())
        } else {
            (DEFLATE, deflate(data)?)
        };
        // `utf8encode(name).length !== name.length`: only a name with a
        // character past ASCII is longer in UTF-8 than in UTF-16
        let utf8_name = !part.name.is_ascii();
        let mut extra = Vec::new();
        if utf8_name {
            // the Info-ZIP Unicode Path extra field
            extra.extend_from_slice(b"up");
            put16(&mut extra, 1 + 4 + name.len() as u64);
            extra.push(1);
            put32(&mut extra, u64::from(crc32(name)));
            extra.extend_from_slice(name);
        }

        let mut header = Vec::new();
        put16(&mut header, u64::from(VERSION_NEEDED));
        put16(
            &mut header,
            u64::from(if utf8_name { UTF8_NAME } else { 0 }),
        );
        put16(&mut header, u64::from(method));
        put16(&mut header, u64::from(dos_time));
        put16(&mut header, u64::from(dos_date));
        put32(&mut header, u64::from(crc32(data)));
        put32(&mut header, stored.len() as u64);
        put32(&mut header, data.len() as u64);
        put16(&mut header, name.len() as u64);
        put16(&mut header, extra.len() as u64);

        let offset = out.len() as u64;
        out.extend_from_slice(LOCAL_FILE_HEADER);
        out.extend_from_slice(&header);
        out.extend_from_slice(name);
        out.extend_from_slice(&extra);
        out.extend_from_slice(&stored);

        directory.extend_from_slice(CENTRAL_FILE_HEADER);
        put16(&mut directory, u64::from(VERSION_MADE_BY));
        directory.extend_from_slice(&header);
        // comment length, disk number start, internal attributes
        put16(&mut directory, 0);
        put16(&mut directory, 0);
        put16(&mut directory, 0);
        put32(
            &mut directory,
            u64::from(if part.is_dir { DOS_DIRECTORY } else { 0 }),
        );
        put32(&mut directory, offset);
        directory.extend_from_slice(name);
        directory.extend_from_slice(&extra);
    }

    let entries = package.parts().len() as u64;
    let directory_offset = out.len() as u64;
    let directory_length = directory.len() as u64;
    out.extend_from_slice(&directory);
    out.extend_from_slice(CENTRAL_DIRECTORY_END);
    // this disk, the disk of the central directory
    put16(&mut out, 0);
    put16(&mut out, 0);
    put16(&mut out, entries);
    put16(&mut out, entries);
    put32(&mut out, directory_length);
    put32(&mut out, directory_offset);
    // no comment
    put16(&mut out, 0);
    Ok(out)
}

/// `Date.UTC(year, month, day, hours, minutes, seconds)` for a year of 100
/// or more: a field out of range carries into the next one.
pub fn utc_time_value(
    year: i64,
    month: i64,
    day: i64,
    hours: i64,
    minutes: i64,
    seconds: i64,
) -> f64 {
    let years = year + month.div_euclid(12);
    let month_of_year = month.rem_euclid(12) + 1;
    // days_from_civil of Howard Hinnant's date algorithms
    let y = years - i64::from(month_of_year <= 2);
    let era = y.div_euclid(400);
    let year_of_era = y.rem_euclid(400);
    let shifted_month = (month_of_year + 9) % 12;
    let day_of_year = (153 * shifted_month + 2) / 5;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let first = era * 146_097 + day_of_era - 719_468;
    let days = first + day - 1;
    (days * 86_400_000 + hours * 3_600_000 + minutes * 60_000 + seconds * 1000) as f64
}

/// What one entry of [`generate_records`] holds.
pub enum RecordData<'a> {
    /// The content, stored or deflated; an empty content is always stored.
    Content { bytes: &'a [u8], deflate: bool },
    /// The compressed data of a loaded entry, which JSZip copies through when
    /// the compression method stays the same.
    Copied(&'a crate::jszip::CompressedData),
}

/// One entry as `out.file(name, data, { date, comment, dosPermissions, ... })`
/// adds it to a zip.
pub struct Record<'a> {
    pub name: &'a str,
    /// `file.comment || ""`
    pub comment: &'a str,
    pub dir: bool,
    /// A `Date` as its time value.
    pub date: f64,
    pub dos_permissions: Option<i64>,
    pub data: RecordData<'a>,
}

/// The zip JSZip 3.10.1 writes from these entries with `generateAsync({
/// type: 'uint8array', compression: 'DEFLATE' })` and the default options
/// (platform DOS, no data descriptors, no zip comment); see [`generate`] for
/// the deflate stream.
pub fn generate_records(records: &[Record<'_>]) -> io::Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut directory = Vec::new();
    for record in records {
        let name = record.name.as_bytes();
        let comment = record.comment.as_bytes();
        let (dos_time, dos_date) = dos_time_and_date(record.date);
        let deflated;
        let (method, crc, compressed_size, uncompressed_size, stored): (u16, u64, u64, u64, &[u8]) =
            match &record.data {
                RecordData::Copied(data) if !record.dir => (
                    if data.stored { STORE } else { DEFLATE },
                    data.crc32 as u64,
                    data.compressed_size as u64,
                    data.uncompressed_size as u64,
                    &data.bytes,
                ),
                RecordData::Content {
                    bytes,
                    deflate: wanted,
                } => {
                    let bytes: &[u8] = if record.dir { &[] } else { bytes };
                    if bytes.is_empty() || !wanted {
                        let length = bytes.len() as u64;
                        (STORE, u64::from(crc32(bytes)), length, length, bytes)
                    } else {
                        deflated = deflate(bytes)?;
                        (
                            DEFLATE,
                            u64::from(crc32(bytes)),
                            deflated.len() as u64,
                            bytes.len() as u64,
                            &deflated,
                        )
                    }
                }
                RecordData::Copied(_) => (STORE, 0, 0, 0, &[]),
            };
        let utf8_name = !record.name.is_ascii();
        let utf8_comment = !record.comment.is_ascii();
        let mut extra = Vec::new();
        for (id, bytes, used) in [(b"up", name, utf8_name), (b"uc", comment, utf8_comment)] {
            if used {
                extra.extend_from_slice(id);
                put16(&mut extra, 1 + 4 + bytes.len() as u64);
                extra.push(1);
                put32(&mut extra, u64::from(crc32(bytes)));
                extra.extend_from_slice(bytes);
            }
        }

        let mut header = Vec::new();
        put16(&mut header, u64::from(VERSION_NEEDED));
        put16(
            &mut header,
            u64::from(if utf8_name || utf8_comment {
                UTF8_NAME
            } else {
                0
            }),
        );
        put16(&mut header, u64::from(method));
        put16(&mut header, u64::from(dos_time));
        put16(&mut header, u64::from(dos_date));
        put32(&mut header, crc);
        put32(&mut header, compressed_size);
        put32(&mut header, uncompressed_size);
        put16(&mut header, name.len() as u64);
        put16(&mut header, extra.len() as u64);

        let offset = out.len() as u64;
        out.extend_from_slice(LOCAL_FILE_HEADER);
        out.extend_from_slice(&header);
        out.extend_from_slice(name);
        out.extend_from_slice(&extra);
        out.extend_from_slice(stored);

        directory.extend_from_slice(CENTRAL_FILE_HEADER);
        put16(&mut directory, u64::from(VERSION_MADE_BY));
        directory.extend_from_slice(&header);
        put16(&mut directory, comment.len() as u64);
        // disk number start, internal attributes
        put16(&mut directory, 0);
        put16(&mut directory, 0);
        let dos = (record.dos_permissions.unwrap_or(0) & 0x3F) as u64;
        put32(
            &mut directory,
            u64::from(if record.dir { DOS_DIRECTORY } else { 0 }) | dos,
        );
        put32(&mut directory, offset);
        directory.extend_from_slice(name);
        directory.extend_from_slice(&extra);
        directory.extend_from_slice(comment);
    }

    let entries = records.len() as u64;
    let directory_offset = out.len() as u64;
    let directory_length = directory.len() as u64;
    out.extend_from_slice(&directory);
    out.extend_from_slice(CENTRAL_DIRECTORY_END);
    put16(&mut out, 0);
    put16(&mut out, 0);
    put16(&mut out, entries);
    put16(&mut out, entries);
    put32(&mut out, directory_length);
    put32(&mut out, directory_offset);
    put16(&mut out, 0);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_fields_follow_the_proleptic_gregorian_calendar() {
        let at = |time| UtcDate::from_time_value(time).map(|d| (d.year, d.month, d.day));
        assert_eq!(at(0.0), Some((1970, 1, 1)));
        assert_eq!(at(-1.0), Some((1969, 12, 31)));
        assert_eq!(at(951_782_400_000.0), Some((2000, 2, 29)));
        assert_eq!(at(8.64e15), Some((275_760, 9, 13)));
        assert_eq!(at(-8.64e15), Some((-271_821, 4, 20)));
        assert_eq!(at(f64::NAN), None);
    }
}
