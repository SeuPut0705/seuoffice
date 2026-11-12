//! `apps/hwp/src/main/hwp5-file.ts`: reading and rewriting HWP 5 files (a
//! compound file whose DocInfo and BodyText streams are deflated lists of
//! tagged records).
//!
//! Where the TypeScript throws (a Node error, a `RangeError` of a buffer read,
//! the container library's `Error`) the Rust returns [`Thrown`]; every caller
//! in the module catches it, so its text is not compared.

use jscompat::{js_regex, slice_utf16};

use super::cfb::{self, CfbError, Container, Entry};
use super::zlib::{deflate_raw_sync, inflate_raw_sync};
use crate::packages::compound_file::{Failure, assert_compound_file, has_ole2_signature};

/// Something the TypeScript throws.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thrown(pub String);

impl From<CfbError> for Thrown {
    fn from(error: CfbError) -> Self {
        Thrown(error.0)
    }
}

pub type Res<T> = Result<T, Thrown>;

/// `SECTION(index)`
pub fn section(index: usize) -> String {
    format!("/BodyText/Section{index}")
}
pub const FILE_HEADER: &str = "/FileHeader";
pub const DOC_INFO: &str = "/DocInfo";
pub const SIGNATURE: &str = "HWP Document File";
/// FileHeader properties: the streams are deflated / encrypted / a distribution copy
pub const COMPRESSED: u32 = 0x1;
pub const ENCRYPTED: u32 = 0x2;
pub const DISTRIBUTION: u32 = 0x4;
pub const PARA_HEADER: u32 = 66;
pub const PARA_TEXT: u32 = 67;
pub const CTRL_HEADER: u32 = 71;
pub const LIST_HEADER: u32 = 72;
/// A document has few sections; this only bounds the walk over a malformed container.
pub const MAX_SECTIONS: usize = 4096;
/// The most a deflated stream may inflate to.
pub const MAX_STREAM_INFLATE_BYTES: usize = 64 * 1024 * 1024;

// ---- Buffer reads and writes that throw past the end ----

fn range_error(what: &str, at: usize) -> Thrown {
    Thrown(format!(
        "The value of \"offset\" is out of range ({what} at {at})"
    ))
}

/// `buffer.readUInt16LE(at)`
pub fn read_u16(data: &[u8], at: usize) -> Res<u16> {
    let end = at.checked_add(2).ok_or_else(|| range_error("u16", at))?;
    let bytes = data.get(at..end).ok_or_else(|| range_error("u16", at))?;
    Ok(u16::from_le_bytes([bytes[0], bytes[1]]))
}

/// `buffer.readUInt32LE(at)`
pub fn read_u32(data: &[u8], at: usize) -> Res<u32> {
    let end = at.checked_add(4).ok_or_else(|| range_error("u32", at))?;
    let bytes = data.get(at..end).ok_or_else(|| range_error("u32", at))?;
    Ok(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

/// `buffer.readInt32LE(at)`
pub fn read_i32(data: &[u8], at: usize) -> Res<i32> {
    read_u32(data, at).map(|value| value as i32)
}

/// `buffer.writeUInt32LE(value, at)` for a value that is a number: throws
/// when it is outside 0..2^32-1 or the four bytes are not all inside; a
/// fraction is cut, NaN writes zeros, as Node's integer writers do.
pub fn write_u32_f64(data: &mut [u8], value: f64, at: usize) -> Res<()> {
    if value > 4_294_967_295.0 || value < 0.0 {
        return Err(Thrown(format!(
            "The value of \"value\" is out of range (>= 0 and <= 4294967295): {value}"
        )));
    }
    let end = at.checked_add(4).ok_or_else(|| range_error("u32", at))?;
    let slot = data
        .get_mut(at..end)
        .ok_or_else(|| range_error("u32", at))?;
    let bits = if value.is_nan() { 0 } else { value as u32 };
    slot.copy_from_slice(&bits.to_le_bytes());
    Ok(())
}

/// `buffer.writeUInt32LE(value, at)`
pub fn write_u32(data: &mut [u8], value: u32, at: usize) -> Res<()> {
    write_u32_f64(data, f64::from(value), at)
}

/// `buffer.writeUInt16LE(value, at)` for a value known to fit
pub fn write_u16(data: &mut [u8], value: u16, at: usize) -> Res<()> {
    let end = at.checked_add(2).ok_or_else(|| range_error("u16", at))?;
    let slot = data
        .get_mut(at..end)
        .ok_or_else(|| range_error("u16", at))?;
    slot.copy_from_slice(&value.to_le_bytes());
    Ok(())
}

// ---- records ----

/// `HwpRecord`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HwpRecord {
    pub tag: u32,
    pub level: u32,
    pub start: usize,
    /// where its payload starts
    pub body: usize,
    pub end: usize,
}

/// The records of a stream, or `None` when the bytes are not a whole list of records.
pub fn records_of(data: &[u8]) -> Option<Vec<HwpRecord>> {
    let mut out = Vec::new();
    let mut at: u64 = 0;
    let length = data.len() as u64;
    while at < length {
        if at + 4 > length {
            return None;
        }
        let start = at;
        let word = read_u32(data, at as usize).ok()?;
        let mut size = u64::from(word >> 20);
        at += 4;
        if size == 0xfff {
            if at + 4 > length {
                return None;
            }
            size = u64::from(read_u32(data, at as usize).ok()?);
            at += 4;
        }
        let body = at;
        at += size;
        if at > length {
            return None;
        }
        out.push(HwpRecord {
            tag: word & 0x3ff,
            level: (word >> 10) & 0x3ff,
            start: start as usize,
            body: body as usize,
            end: at as usize,
        });
    }
    Some(out)
}

// ---- the container ----

/// `OpenedHwp`
#[derive(Debug, Clone)]
pub struct OpenedHwp {
    pub cfb: Container,
    pub compressed: bool,
}

/// `readCompoundFile(bytes)`: the gate, then the container library.
fn read_compound_file(bytes: &[u8]) -> Res<Container> {
    match assert_compound_file(bytes) {
        Ok(()) => {}
        Err(Failure::Refused { detail, .. }) => {
            return Err(Thrown(format!("Not a readable compound file: {detail}")));
        }
        Err(Failure::Range) => {
            return Err(Thrown(
                "Offset is outside the bounds of the DataView".to_owned(),
            ));
        }
    }
    cfb::read(bytes).map_err(|error| {
        Thrown(format!(
            "Not a readable compound file: the OLE2 container cannot be read ({})",
            error.0
        ))
    })
}

/// A plain HWP 5 container, or `None`: not one, or one whose streams are not
/// readable here. A compound file whose sector tables or directory cannot be
/// followed to an end throws.
pub fn open_hwp(file: &[u8]) -> Res<Option<OpenedHwp>> {
    // an HWPX is a zip, which the container library would inflate whole to find no HWP in it
    if !has_ole2_signature(file) {
        return Ok(None);
    }
    let container = read_compound_file(file)?;
    let header =
        cfb::find(&container, FILE_HEADER).and_then(|at| container.file_index[at].content.as_ref());
    let Some(header) = header else {
        return Ok(None);
    };
    if header.len() < 40 {
        return Ok(None);
    }
    if &header[..SIGNATURE.len()] != SIGNATURE.as_bytes() {
        return Ok(None);
    }
    let flags = read_u32(header, 36)?;
    if flags & (ENCRYPTED | DISTRIBUTION) != 0 {
        return Ok(None);
    }
    // a second copy of the body for viewing: which copy the engine reads is not known here
    let view_text = js_regex!(r"/ViewText/", "i");
    if container.full_paths.iter().any(|path| view_text.test(path)) {
        return Ok(None);
    }
    Ok(Some(OpenedHwp {
        cfb: container,
        compressed: flags & COMPRESSED != 0,
    }))
}

/// The bytes of a stream, inflated when the file deflates its streams; `None`
/// when the file has no such stream. Throws when the stream is not deflate
/// data, and likewise when it inflates past [`MAX_STREAM_INFLATE_BYTES`].
pub fn stream_of(opened: &OpenedHwp, path: &str) -> Res<Option<Vec<u8>>> {
    let Some(at) = cfb::find(&opened.cfb, path) else {
        return Ok(None);
    };
    let Some(content) = opened.cfb.file_index[at].content.as_ref() else {
        return Ok(None);
    };
    if opened.compressed {
        Ok(Some(inflate_raw_sync(content, MAX_STREAM_INFLATE_BYTES)?))
    } else {
        Ok(Some(content.clone()))
    }
}

/// `sectionCount(opened)`
pub fn section_count(opened: &OpenedHwp) -> usize {
    let mut count = 0;
    while count < MAX_SECTIONS && cfb::find(&opened.cfb, &section(count)).is_some() {
        count += 1;
    }
    count
}

const SECTOR: usize = 512;
const MINI_SECTOR: usize = 64;
const FAT_PER_SECTOR: usize = SECTOR / 4;
const END_OF_CHAIN: u32 = 0xffff_fffe;
const FREE: u32 = 0xffff_ffff;
/// FAT sectors the header itself lists; more are listed in a chain of sectors of their own
const HEADER_FAT_SLOTS: usize = 109;
/// The library puts a stream of its own, by this name, into every container it writes.
const LIBRARY_MARKER: &str = "\u{1}Sh33tJ5";

/// The container as a file. Two things the library does are undone: it adds a
/// marker stream of its own unless it finds one, and it fills the unused
/// entries of the sector tables with "end of chain" rather than "free".
pub fn write_container(container: &mut Container) -> Res<Vec<u8>> {
    container.file_index.push(Entry::unused(LIBRARY_MARKER));
    let root = container
        .full_paths
        .first()
        .cloned()
        .ok_or_else(|| Thrown("Cannot read properties of undefined".to_owned()))?;
    container.full_paths.push(format!("{root}{LIBRARY_MARKER}"));
    let mut file = cfb::write(container)?;
    let sectors = (file.len().saturating_sub(SECTOR) / SECTOR) as u64;
    let sector_at = |index: u64| -> usize { SECTOR + index as usize * SECTOR };
    let free_from = |file: &mut Vec<u8>, table_sectors: &[u64], used: u64| -> Res<()> {
        for (nth, &sector) in table_sectors.iter().enumerate() {
            for slot in 0..FAT_PER_SECTOR {
                let at = sector_at(sector) + slot * 4;
                if (nth * FAT_PER_SECTOR + slot) as u64 >= used
                    && read_u32(file, at)? == END_OF_CHAIN
                {
                    write_u32(file, FREE, at)?;
                }
            }
        }
        Ok(())
    };
    // the sectors of the FAT: the header lists the first ones, a chain of sectors the rest
    let mut fat_sectors: Vec<u64> = Vec::new();
    for slot in 0..HEADER_FAT_SLOTS {
        let sector = u64::from(read_u32(&file, 76 + slot * 4)?);
        if sector < sectors {
            fat_sectors.push(sector);
        }
    }
    let mut more = u64::from(read_u32(&file, 68)?);
    let mut guard = 0u64;
    while more < sectors && guard < sectors {
        for slot in 0..FAT_PER_SECTOR - 1 {
            let sector = u64::from(read_u32(&file, sector_at(more) + slot * 4)?);
            if sector < sectors {
                fat_sectors.push(sector);
            }
        }
        more = u64::from(read_u32(&file, sector_at(more) + (FAT_PER_SECTOR - 1) * 4)?);
        guard += 1;
    }
    let next = |file: &[u8], sector: u64| -> Res<u64> {
        match fat_sectors.get((sector / FAT_PER_SECTOR as u64) as usize) {
            None => Ok(u64::from(END_OF_CHAIN)),
            Some(&table) => Ok(u64::from(read_u32(
                file,
                sector_at(table) + (sector % FAT_PER_SECTOR as u64) as usize * 4,
            )?)),
        }
    };
    // the mini FAT is a chain in the FAT; the size of the root entry says how much of it is used
    let mut mini_sectors: Vec<u64> = Vec::new();
    let mut mini = u64::from(read_u32(&file, 60)?);
    let mut guard = 0u64;
    while mini < sectors && guard < sectors {
        mini_sectors.push(mini);
        mini = next(&file, mini)?;
        guard += 1;
    }
    let root_entry = u64::from(read_u32(&file, 48)?);
    let root_size = u64::from(read_u32(&file, sector_at(root_entry) + 120)?);
    free_from(
        &mut file,
        &mini_sectors,
        root_size.div_ceil(MINI_SECTOR as u64),
    )?;
    let fat_list = fat_sectors.clone();
    free_from(&mut file, &fat_list, sectors)?;
    Ok(file)
}

/// The storages and streams of a container; its unused directory entries are not among them.
pub fn paths_of(opened: &OpenedHwp) -> Vec<String> {
    opened
        .cfb
        .full_paths
        .iter()
        .enumerate()
        .filter(|(index, _)| opened.cfb.file_index.get(*index).map(|e| e.kind) != Some(0))
        .map(|(_, path)| path.clone())
        .collect()
}

/// The two containers hold the same streams with the same bytes; `changed` ones hold these.
pub fn same_streams(
    before: &OpenedHwp,
    after: &OpenedHwp,
    changed: &[(String, Vec<u8>)],
) -> Res<bool> {
    let paths = paths_of(before);
    let now = paths_of(after);
    if paths.len() != now.len() || !paths.iter().all(|path| now.contains(path)) {
        return Ok(false);
    }
    let root = paths.first().cloned().unwrap_or_default();
    for path in &paths {
        // a storage holds no bytes of its own: that it is still there was checked above
        if path.ends_with('/') {
            continue;
        }
        let name = format!(
            "/{}",
            slice_utf16(path, root.encode_utf16().count() as f64, None)
        );
        let was = cfb::find(&before.cfb, &name);
        let is = cfb::find(&after.cfb, &name);
        let (Some(was), Some(is)) = (was, is) else {
            return Ok(false);
        };
        let (was, is) = (&before.cfb.file_index[was], &after.cfb.file_index[is]);
        if was.kind != is.kind {
            return Ok(false);
        }
        if let Some((_, meant)) = changed.iter().find(|(key, _)| *key == name) {
            match stream_of(after, &name)? {
                Some(back) if back == *meant => {}
                _ => return Ok(false),
            }
        } else if was.content.as_deref().unwrap_or(&[]) != is.content.as_deref().unwrap_or(&[]) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The file with some streams replaced (`changed`: path to uncompressed
/// bytes), written and read back: `None` unless every other stream came back
/// as it was and the changed ones as meant.
pub fn rewrite_streams(
    opened: &mut OpenedHwp,
    changed: &[(String, Vec<u8>)],
) -> Res<Option<Vec<u8>>> {
    for (path, data) in changed {
        let Some(at) = cfb::find(&opened.cfb, path) else {
            return Ok(None);
        };
        let content = if opened.compressed {
            deflate_raw_sync(data)?
        } else {
            data.clone()
        };
        let entry = &mut opened.cfb.file_index[at];
        entry.size = content.len() as i32;
        entry.content = Some(content);
    }
    let written = write_container(&mut opened.cfb)?;
    let check = open_hwp(&written)?;
    match check {
        Some(check) if same_streams(opened, &check, changed)? => Ok(Some(written)),
        _ => Ok(None),
    }
}
