//! Port of packages/zip-gate/src/index.ts: the metered-inflation zip bomb
//! gate. The messages are the ones the TypeScript gate throws.

use flate2::{Decompress, FlushDecompress, Status};
use jscompat::number_to_string;

/// What the gates enforce.
#[derive(Debug, Clone, Copy)]
pub struct ZipLimits {
    pub max_parts: usize,
    pub max_part_bytes: f64,
    pub max_total_bytes: f64,
}

/// Part-count, per-part and total caps shared by the docx and pptx engines.
pub const DEFAULT_ZIP_LIMITS: ZipLimits = ZipLimits {
    max_parts: 10_000,
    max_part_bytes: 512.0 * 1024.0 * 1024.0,
    max_total_bytes: 1.5 * 1024.0 * 1024.0 * 1024.0,
};

/// What the declared-size pass needs to know about one part. The size is a
/// JavaScript number there: JSZip reads a size past 2^31 as negative.
pub struct DeclaredPart<'a> {
    pub name: &'a str,
    pub usize: f64,
}

/// The part-count, per-part and total declared-size gate. Advisory only: it
/// costs nothing when the archive tells the truth and holds nothing when it
/// lies. `assert_zip_inflates_within_limits` is the gate that holds.
pub fn assert_declared_sizes_within_limits(
    parts: &[DeclaredPart<'_>],
    limits: &ZipLimits,
) -> Result<(), String> {
    if parts.len() > limits.max_parts {
        return Err(too_many_parts(parts.len(), limits));
    }
    let mut total = 0.0;
    for part in parts {
        if part.usize > limits.max_part_bytes {
            return Err(part_too_large(part.name, part.usize, limits));
        }
        if part.usize > 0.0 {
            total += part.usize;
        }
    }
    if total > limits.max_total_bytes {
        return Err(total_too_large(total, limits));
    }
    Ok(())
}

fn too_many_parts(count: usize, limits: &ZipLimits) -> String {
    format!(
        "zip rejected: {count} parts exceeds the {} limit",
        limits.max_parts
    )
}

fn part_too_large(name: &str, declared: f64, limits: &ZipLimits) -> String {
    format!(
        "zip rejected: part {name} declares {} uncompressed bytes (limit {})",
        number_to_string(declared),
        number_to_string(limits.max_part_bytes)
    )
}

fn total_too_large(total: f64, limits: &ZipLimits) -> String {
    format!(
        "zip rejected: total uncompressed size {} exceeds the {} limit",
        number_to_string(total),
        number_to_string(limits.max_total_bytes)
    )
}

/// Everything the metered gate needs to know about one part. Offsets and
/// sizes are u64: sums of 32-bit fields must not wrap on a 32-bit target.
struct ScannedPart {
    /// Latin-1, so a name that is not UTF-8 still names the rejection.
    name: String,
    method: u64,
    csize: u64,
    declared: u64,
    /// First byte of the (compressed) data inside the archive.
    data_start: u64,
}

const EOCD_SIG: u64 = 0x0605_4b50;
const CENTRAL_SIG: u64 = 0x0201_4b50;
const LOCAL_SIG: u64 = 0x0403_4b50;
const ZIP64_LOCATOR_SIG: u64 = 0x0706_4b50;
const FLAG_ENCRYPTED: u64 = 0x1;

const NOT_FOUND: &str = "zip: end of central directory not found";
const ZIP64: &str = "zip: zip64 archives are not supported";
const CORRUPT_DIRECTORY: &str = "zip: corrupt central directory";

/// The gate that holds against a forged central directory: inflating one byte
/// past what a part claims catches a liar at `declared + 1` bytes, and an
/// oversized declaration is rejected before anything is inflated.
pub fn assert_zip_inflates_within_limits(bytes: &[u8], limits: &ZipLimits) -> Result<(), String> {
    let parts = scan_parts(bytes)?;
    if parts.len() > limits.max_parts {
        return Err(too_many_parts(parts.len(), limits));
    }
    let mut total = 0.0;
    for part in &parts {
        if part.declared as f64 > limits.max_part_bytes {
            return Err(part_too_large(&part.name, part.declared as f64, limits));
        }
        total += verified_size(bytes, part)? as f64;
        if total > limits.max_total_bytes {
            return Err(total_too_large(total, limits));
        }
    }
    Ok(())
}

/// Little-endian read of two or four bytes the caller has bounds-checked.
fn at(bytes: &[u8], index: u64, width: usize) -> u64 {
    let index = index as usize;
    bytes[index..index + width]
        .iter()
        .rev()
        .fold(0, |value, byte| value << 8 | u64::from(*byte))
}

/// Reads the central directory. Only the fields the gate uses are read, and
/// every offset is bounds-checked against the file before it is touched.
fn scan_parts(bytes: &[u8]) -> Result<Vec<ScannedPart>, String> {
    let length = bytes.len() as u64;
    let Some(end) = length.checked_sub(22) else {
        return Err(NOT_FOUND.to_owned());
    };
    let eocd = (end.saturating_sub(0xffff)..=end)
        .rev()
        .find(|&index| at(bytes, index, 4) == EOCD_SIG)
        .ok_or(NOT_FOUND)?;
    if eocd >= 20 && at(bytes, eocd - 20, 4) == ZIP64_LOCATOR_SIG {
        return Err(ZIP64.to_owned());
    }
    let count = at(bytes, eocd + 10, 2);
    let cd_size = at(bytes, eocd + 12, 4);
    let cd_offset = at(bytes, eocd + 16, 4);
    // JSZip reads an archive as ZIP64 when any of six fields of the end record
    // is all ones: both disk numbers and both record counts, besides the
    // directory size and offset. All six are refused, not only the three this
    // scan goes on to use: JSZip's ZIP64 reader does not return from crafted
    // extensible data.
    if at(bytes, eocd + 4, 2) == 0xffff
        || at(bytes, eocd + 6, 2) == 0xffff
        || at(bytes, eocd + 8, 2) == 0xffff
        || count == 0xffff
        || cd_size == 0xffff_ffff
        || cd_offset == 0xffff_ffff
    {
        return Err(ZIP64.to_owned());
    }
    if cd_offset > length || cd_size > length - cd_offset {
        return Err(CORRUPT_DIRECTORY.to_owned());
    }
    let cd_end = cd_offset + cd_size;
    let mut parts = Vec::new();
    let mut pos = cd_offset;
    for _ in 0..count {
        if pos + 46 > cd_end || at(bytes, pos, 4) != CENTRAL_SIG {
            return Err(CORRUPT_DIRECTORY.to_owned());
        }
        let flags = at(bytes, pos + 8, 2);
        if flags & FLAG_ENCRYPTED != 0 {
            return Err("zip: encrypted entries are not supported".to_owned());
        }
        let name_len = at(bytes, pos + 28, 2);
        let extra_len = at(bytes, pos + 30, 2);
        let comment_len = at(bytes, pos + 32, 2);
        let name_start = pos + 46;
        if name_start + name_len > cd_end {
            return Err(CORRUPT_DIRECTORY.to_owned());
        }
        parts.push(ScannedPart {
            name: bytes[name_start as usize..(name_start + name_len) as usize]
                .iter()
                .map(|byte| char::from(*byte))
                .collect(),
            method: at(bytes, pos + 10, 2),
            csize: at(bytes, pos + 20, 4),
            declared: at(bytes, pos + 24, 4),
            data_start: at(bytes, pos + 42, 4),
        });
        pos = name_start + name_len + extra_len + comment_len;
    }
    // the local header's own lengths win: they may differ from the central copy
    for part in &mut parts {
        if part.data_start + 30 > length || at(bytes, part.data_start, 4) != LOCAL_SIG {
            return Err(format!("zip: corrupt local header for {}", part.name));
        }
        let start = part.data_start
            + 30
            + at(bytes, part.data_start + 26, 2)
            + at(bytes, part.data_start + 28, 2);
        if start > length || part.csize > length - start {
            return Err(format!(
                "zip: entry {} declares {} bytes at {start}, outside the {length}-byte archive",
                part.name, part.csize
            ));
        }
        part.data_start = start;
    }
    // directories carry no payload and JSZip's own gate does not count them
    parts.retain(|part| !part.name.ends_with('/'));
    Ok(parts)
}

/// The part's real length, refusing to inflate past what it declared.
fn verified_size(bytes: &[u8], part: &ScannedPart) -> Result<u64, String> {
    let raw = &bytes[part.data_start as usize..(part.data_start + part.csize) as usize];
    if part.method == 0 {
        if part.csize > part.declared {
            return Err(under_declared(part));
        }
        return Ok(part.csize);
    }
    if part.method != 8 {
        return Err(format!(
            "zip: unsupported compression method {} for {}",
            part.method, part.name
        ));
    }
    inflate_raw_bounded(raw, part)
}

/// What the TypeScript gate appends after "cannot be inflated: ". There it is
/// the host's own text (Node 22 gives the bare name `TypeError`).
pub const INFLATE_FAILURE: &str = "the deflate data is damaged or cut short";

/// What Rust appends for bytes after the end of a deflate stream. Chromium
/// says "Junk found after end of compressed data."; Node 22 reads past them.
pub const INFLATE_TRAILING: &str = "bytes follow the end of the deflate data";

/// Inflates and stops at the claim, so the payload is never held.
///
/// The TypeScript gate reads a `DecompressionStream`: input goes in 64 KiB
/// slices, output comes out as the inflater fills a 16 KiB buffer, and a
/// failing call delivers nothing. A part that both lies about its size and is
/// damaged is refused for whichever shows first in those steps, so the steps
/// are the same here.
///
/// Data after the end of the deflate stream is refused, as the Compression
/// Streams standard has it and as the product's hosts do (Chromium); the
/// gate's own host, Node 22, ignores it, which is a listed divergence. What
/// the stream held is counted against the claim first.
fn inflate_raw_bounded(raw: &[u8], part: &ScannedPart) -> Result<u64, String> {
    const INPUT_SLICE: usize = 64 * 1024;
    const OUTPUT_BUFFER: usize = 16 * 1024;
    let refused = |why: &str| format!("zip rejected: part {} cannot be inflated: {why}", part.name);
    let damaged = || refused(INFLATE_FAILURE);
    let mut inflater = Decompress::new(false);
    let mut buffer = vec![0u8; OUTPUT_BUFFER];
    let mut buffered = 0;
    let mut seen = 0u64;
    for slice in raw.chunks(INPUT_SLICE) {
        let mut input = slice;
        loop {
            let (in_before, out_before) = (inflater.total_in(), inflater.total_out());
            let status = inflater
                .decompress(input, &mut buffer[buffered..], FlushDecompress::None)
                .map_err(|_| damaged())?;
            let consumed = (inflater.total_in() - in_before) as usize;
            let produced = (inflater.total_out() - out_before) as usize;
            input = &input[consumed..];
            seen += produced as u64;
            if seen > part.declared {
                return Err(under_declared(part));
            }
            buffered += produced;
            let buffer_was_filled = buffered == OUTPUT_BUFFER;
            if buffer_was_filled {
                buffered = 0;
            }
            if status == Status::StreamEnd {
                if inflater.total_in() < raw.len() as u64 {
                    return Err(refused(INFLATE_TRAILING));
                }
                return Ok(seen);
            }
            if !buffer_was_filled && (input.is_empty() || consumed + produced == 0) {
                break;
            }
        }
    }
    // the input ran out before the deflate stream ended
    Err(damaged())
}

/// Claims less than the bytes deliver: that gap is exactly where bombs live.
fn under_declared(part: &ScannedPart) -> String {
    format!(
        "zip rejected: part {} declares {} uncompressed bytes but inflates past that",
        part.name, part.declared
    )
}
