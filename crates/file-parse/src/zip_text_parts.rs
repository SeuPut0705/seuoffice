//! Port of packages/file-parse/src/zip-text-parts.ts: a zip copied with only
//! its text parts' content, the compressed bytes of each copied as they are.
//!
//! The TypeScript reads a file by its central directory and never inflates.
//! Here the archive is in memory, and the metered zip gate runs over it first:
//! an archive the gate refuses is refused here with the gate's message, where
//! the TypeScript copies it. After the gate, the copy follows the source's
//! checks, header fields and error messages.

use ooxml_pkg::{DEFAULT_ZIP_LIMITS, assert_zip_inflates_within_limits};

const EOCD_SIG: u32 = 0x0605_4b50;
const CEN_SIG: u32 = 0x0201_4b50;
const LOC_SIG: u32 = 0x0403_4b50;
const EOCD_MIN: u64 = 22;
const EOCD_SEARCH: u64 = EOCD_MIN + 0xffff;
const CEN_FIXED: u64 = 46;
const LOC_FIXED: u64 = 30;
const FLAG_DATA_DESCRIPTOR: u16 = 0x0008;
const FLAG_UTF8: u16 = 0x0800;

const TEXT_PART_EXTS: [&str; 11] = [
    "xml", "rels", "json", "txt", "html", "htm", "xhtml", "xht", "opf", "ncx", "hpf",
];

const ZIP64: &str = "zip: zip64 archives are not supported";
const BROKEN_DIRECTORY: &str = "zip: broken central directory";
const ENTRY_OUT_OF_RANGE: &str = "zip: entry out of range";

/// `isTextPart`: whether a part is read for text; a part with no extension
/// (`mimetype`) is.
pub fn is_text_part(name: &str) -> bool {
    let last = &name[name.rfind('/').map_or(0, |slash| slash + 1)..];
    match last.rfind('.') {
        None | Some(0) => true,
        Some(dot) => TEXT_PART_EXTS.contains(&last[dot + 1..].to_lowercase().as_str()),
    }
}

#[derive(Clone, Copy)]
struct CentralEntry<'a> {
    flags: u16,
    method: u16,
    time: u16,
    date: u16,
    crc: u32,
    comp_size: u32,
    size: u32,
    local_offset: u32,
    name: &'a [u8],
}

struct Written<'a> {
    entry: CentralEntry<'a>,
    flags: u16,
    data: &'a [u8],
    offset: u32,
}

/// `readAt`: the bytes at `position`, all of them or the TypeScript's
/// short-read error.
fn read_at(bytes: &[u8], position: u64, length: u64) -> Result<&[u8], String> {
    position
        .checked_add(length)
        .and_then(|end| bytes.get(usize::try_from(position).ok()?..usize::try_from(end).ok()?))
        .ok_or_else(|| "zip: unexpected end of file".to_owned())
}

/// The `N` bytes at `at`, when the slice holds them.
fn fixed<const N: usize>(bytes: &[u8], at: u64) -> Option<&[u8; N]> {
    let start = usize::try_from(at).ok()?;
    bytes.get(start..start.checked_add(N)?)?.try_into().ok()
}

fn le16<const N: usize>(record: &[u8; N], at: usize) -> u16 {
    u16::from_le_bytes([record[at], record[at + 1]])
}

fn le32<const N: usize>(record: &[u8; N], at: usize) -> u32 {
    u32::from_le_bytes([record[at], record[at + 1], record[at + 2], record[at + 3]])
}

fn find_eocd(tail: &[u8]) -> Option<u64> {
    let last = (tail.len() as u64).checked_sub(EOCD_MIN)?;
    (0..=last)
        .rev()
        .find(|&at| fixed::<4>(tail, at).is_some_and(|sig| le32(sig, 0) == EOCD_SIG))
}

fn central_entries(cd: &[u8], count: u16) -> Result<Vec<CentralEntry<'_>>, String> {
    let cd_length = cd.len() as u64;
    let mut out = Vec::with_capacity(usize::from(count));
    let mut at = 0u64;
    for _ in 0..count {
        let head = fixed::<46>(cd, at)
            .filter(|head| le32(head, 0) == CEN_SIG)
            .ok_or(BROKEN_DIRECTORY)?;
        let name_len = u64::from(le16(head, 28));
        let extra_len = u64::from(le16(head, 30));
        let comment_len = u64::from(le16(head, 32));
        let end = at + CEN_FIXED + name_len + extra_len + comment_len;
        if end > cd_length {
            return Err(BROKEN_DIRECTORY.to_owned());
        }
        let comp_size = le32(head, 20);
        let size = le32(head, 24);
        let local_offset = le32(head, 42);
        if comp_size == u32::MAX || size == u32::MAX || local_offset == u32::MAX {
            return Err(ZIP64.to_owned());
        }
        out.push(CentralEntry {
            flags: le16(head, 8),
            method: le16(head, 10),
            time: le16(head, 12),
            date: le16(head, 14),
            crc: le32(head, 16),
            comp_size,
            size,
            local_offset,
            name: read_at(cd, at + CEN_FIXED, name_len)?,
        });
        at = end;
    }
    Ok(out)
}

/// What `Buffer.writeUInt32LE` throws for a value past 32 bits, as Node words
/// it: digits grouped by `_` past 2^32. The TypeScript error is a
/// `RangeError`.
fn u32_field(value: u64) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| {
        let digits = value.to_string();
        let received = if value > 1 << 32 {
            let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
            for (n, digit) in digits.chars().enumerate() {
                if n > 0 && (digits.len() - n).is_multiple_of(3) {
                    grouped.push('_');
                }
                grouped.push(digit);
            }
            grouped
        } else {
            digits
        };
        format!(
            "The value of \"value\" is out of range. It must be >= 0 and <= 4294967295. Received {received}"
        )
    })
}

fn local_header(out: &mut Vec<u8>, entry: &CentralEntry<'_>, flags: u16) {
    out.extend_from_slice(&LOC_SIG.to_le_bytes());
    out.extend_from_slice(&20u16.to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    out.extend_from_slice(&entry.method.to_le_bytes());
    out.extend_from_slice(&entry.time.to_le_bytes());
    out.extend_from_slice(&entry.date.to_le_bytes());
    out.extend_from_slice(&entry.crc.to_le_bytes());
    out.extend_from_slice(&entry.comp_size.to_le_bytes());
    out.extend_from_slice(&entry.size.to_le_bytes());
    out.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
}

fn central_header(out: &mut Vec<u8>, entry: &CentralEntry<'_>, flags: u16, offset: u32) {
    out.extend_from_slice(&CEN_SIG.to_le_bytes());
    out.extend_from_slice(&20u16.to_le_bytes());
    out.extend_from_slice(&20u16.to_le_bytes());
    out.extend_from_slice(&flags.to_le_bytes());
    out.extend_from_slice(&entry.method.to_le_bytes());
    out.extend_from_slice(&entry.time.to_le_bytes());
    out.extend_from_slice(&entry.date.to_le_bytes());
    out.extend_from_slice(&entry.crc.to_le_bytes());
    out.extend_from_slice(&entry.comp_size.to_le_bytes());
    out.extend_from_slice(&entry.size.to_le_bytes());
    out.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
    // extra and comment lengths, disk, internal and external attributes
    out.extend_from_slice(&[0; 12]);
    out.extend_from_slice(&offset.to_le_bytes());
}

/// `readZipTextParts` behind the zip gate: the zip with only its text parts'
/// content. Every part keeps its name; a part that is not text
/// (`is_text_part`) becomes an empty stored part. `Err` is the message of
/// the zip gate, or of what the TypeScript throws for a zip the gate passes.
pub fn read_zip_text_parts(bytes: &[u8]) -> Result<Vec<u8>, String> {
    // first of all: it also refuses what the TypeScript calls too short to be a zip
    assert_zip_inflates_within_limits(bytes, &DEFAULT_ZIP_LIMITS)?;
    let file_size = bytes.len() as u64;
    let tail_length = file_size.min(EOCD_SEARCH);
    let tail = read_at(bytes, file_size - tail_length, tail_length)?;
    let end = find_eocd(tail)
        .and_then(|eocd| fixed::<22>(tail, eocd))
        .ok_or("zip: end of central directory not found")?;
    let count = le16(end, 10);
    let cd_size = le32(end, 12);
    let cd_offset = le32(end, 16);
    if count == 0xffff || cd_size == u32::MAX || cd_offset == u32::MAX {
        return Err(ZIP64.to_owned());
    }
    if u64::from(cd_offset) + u64::from(cd_size) > file_size {
        return Err("zip: central directory out of range".to_owned());
    }
    let entries = central_entries(read_at(bytes, cd_offset.into(), cd_size.into())?, count)?;

    let mut written = Vec::with_capacity(entries.len());
    let mut offset = 0u64;
    let mut central_length = 0u64;
    for entry in entries {
        let keep = is_text_part(&String::from_utf8_lossy(entry.name));
        // the data descriptor bit is dropped: sizes and crc are written up front
        let flags = if keep {
            entry.flags & !FLAG_DATA_DESCRIPTOR
        } else {
            entry.flags & FLAG_UTF8
        };
        let (entry, data) = if keep {
            let local_offset = u64::from(entry.local_offset);
            if local_offset + LOC_FIXED > file_size {
                return Err(ENTRY_OUT_OF_RANGE.to_owned());
            }
            let head = fixed::<30>(bytes, local_offset).ok_or("zip: unexpected end of file")?;
            if le32(head, 0) != LOC_SIG {
                return Err("zip: broken local header".to_owned());
            }
            let start =
                local_offset + LOC_FIXED + u64::from(le16(head, 26)) + u64::from(le16(head, 28));
            let comp_size = u64::from(entry.comp_size);
            if start + comp_size > file_size {
                return Err(ENTRY_OUT_OF_RANGE.to_owned());
            }
            (entry, read_at(bytes, start, comp_size)?)
        } else {
            let blank = CentralEntry {
                method: 0,
                crc: 0,
                comp_size: 0,
                size: 0,
                ..entry
            };
            (blank, &[][..])
        };
        let name_len = entry.name.len() as u64;
        let data_len = data.len() as u64;
        written.push(Written {
            entry,
            flags,
            data,
            offset: u32_field(offset)?,
        });
        offset += LOC_FIXED + name_len + data_len;
        central_length += CEN_FIXED + name_len;
    }
    let central_length32 = u32_field(central_length)?;
    let offset32 = u32_field(offset)?;
    let total = usize::try_from(offset + central_length + EOCD_MIN)
        .map_err(|_| "zip: the copy does not fit in memory".to_owned())?;
    let mut out = Vec::new();
    out.try_reserve_exact(total)
        .map_err(|_| "zip: the copy does not fit in memory".to_owned())?;
    for part in &written {
        local_header(&mut out, &part.entry, part.flags);
        out.extend_from_slice(part.entry.name);
        out.extend_from_slice(part.data);
    }
    for part in &written {
        central_header(&mut out, &part.entry, part.flags, part.offset);
        out.extend_from_slice(part.entry.name);
    }
    let parts = (written.len() as u16).to_le_bytes();
    out.extend_from_slice(&EOCD_SIG.to_le_bytes());
    out.extend_from_slice(&[0; 4]);
    out.extend_from_slice(&parts);
    out.extend_from_slice(&parts);
    out.extend_from_slice(&central_length32.to_le_bytes());
    out.extend_from_slice(&offset32.to_le_bytes());
    out.extend_from_slice(&[0; 2]);
    Ok(out)
}
