//! The gate every compound file passes before a legacy reader follows its
//! sector chains: `assertCompoundFile` of `packages/compound-file/src/validate.ts`
//! (with `CompoundFileError`, `isCompoundFileError`, `hasOle2Signature` and the
//! constants of that module), and `DamagedFileError` with
//! `assertSoundCompoundFile` of `packages/file-parse/src/damaged-file.ts`.
//!
//! A number the TypeScript reads is a JavaScript number: 32 bits unsigned from
//! `DataView.getUint32`, so every value here is a `u64` or `i64`, never a
//! `usize` (the wasm target is 32 bit).

use std::fmt;

/// An OLE2/CFB compound document starts with this 8-byte signature.
pub const OLE2_MAGIC: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/// A compound file is at least its 512-byte header.
pub const OLE2_HEADER_BYTES: usize = 512;
/// Directory entries a file may hold.
pub const MAX_DIRECTORY_ENTRIES: u64 = 32768;
/// Storages nested inside one another.
pub const MAX_STORAGE_DEPTH: i64 = 64;

const CHAIN_COPY_FILE_MULTIPLE: u64 = 4;
const CHAIN_COPY_FLOOR_BYTES: u64 = 64 * 1024 * 1024;

const FREE_SECTOR: u64 = 0xffff_ffff;
const END_OF_CHAIN: u64 = 0xffff_fffe;
const NO_ENTRY: u64 = 0xffff_ffff;
const HEADER_FAT_SLOTS: u64 = 109;
const MINI_SECTOR_BYTES: u64 = 64;
const MINI_STREAM_CUTOFF: u64 = 4096;
const ENTRY_BYTES: u64 = 128;
const TYPE_UNUSED: u8 = 0;
const TYPE_STORAGE: u8 = 1;
const TYPE_STREAM: u8 = 2;
const TYPE_ROOT: u8 = 5;

const MAJOR_VERSION: u64 = 26;
const SECTOR_SHIFT: u64 = 30;
const MINI_SECTOR_SHIFT: u64 = 32;
const FAT_SECTOR_COUNT: u64 = 44;
const DIRECTORY_START: u64 = 48;
const MINI_CUTOFF: u64 = 56;
const MINI_FAT_START: u64 = 60;
const MINI_FAT_SECTOR_COUNT: u64 = 64;
const DIFAT_START: u64 = 68;
const DIFAT_SECTOR_COUNT: u64 = 72;
const HEADER_DIFAT: u64 = 76;
const ENTRY_TYPE: u64 = 66;
const ENTRY_LINKS: [u64; 3] = [68, 72, 76];
const ENTRY_CHILD: u64 = 76;
const ENTRY_START: u64 = 116;
const ENTRY_SIZE: u64 = 120;

/// `Ole2FailureCode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ole2FailureCode {
    NotCfb,
    Truncated,
    LimitsExceeded,
    Corrupt,
}

impl Ole2FailureCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotCfb => "not_cfb",
            Self::Truncated => "truncated",
            Self::LimitsExceeded => "limits_exceeded",
            Self::Corrupt => "corrupt",
        }
    }
}

/// `CompoundFileError`: name `CompoundFileError`, message
/// `Not a readable compound file: ${detail}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompoundFileError {
    pub code: Ole2FailureCode,
    pub detail: String,
}

impl CompoundFileError {
    pub fn message(&self) -> String {
        format!("Not a readable compound file: {}", self.detail)
    }
}

impl fmt::Display for CompoundFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message())
    }
}

/// What `assertCompoundFile` throws: its own error, or a `RangeError` of the
/// `DataView` it reads through (which no input reaches: every table sector
/// read is claimed whole inside the file first).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateError {
    Compound(CompoundFileError),
    Range(String),
}

impl GateError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Compound(_) => "CompoundFileError",
            Self::Range(_) => "RangeError",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Compound(error) => error.message(),
            Self::Range(message) => message.clone(),
        }
    }
}

/// `isCompoundFileError`.
pub fn is_compound_file_error(error: &GateError) -> bool {
    matches!(error, GateError::Compound(_))
}

/// `DamagedFileError`: name `DamagedFileError`; `cause` is the gate's finding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DamagedFileError {
    pub message: String,
    pub cause: CompoundFileError,
}

impl DamagedFileError {
    pub fn new(document_type: &str, cause: CompoundFileError) -> Self {
        Self {
            message: format!("The file is damaged or is not a valid {document_type} document"),
            cause,
        }
    }

    pub fn name(&self) -> &'static str {
        "DamagedFileError"
    }
}

impl fmt::Display for DamagedFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

/// What `assertSoundCompoundFile` throws: a `DamagedFileError` for the gate's
/// own refusal, anything else as it came.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SoundError {
    Damaged(DamagedFileError),
    Other { name: &'static str, message: String },
}

impl SoundError {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Damaged(error) => error.name(),
            Self::Other { name, .. } => name,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::Damaged(error) => error.message.clone(),
            Self::Other { message, .. } => message.clone(),
        }
    }
}

/// `hasOle2Signature`.
pub fn has_ole2_signature(bytes: &[u8]) -> bool {
    bytes.len() >= OLE2_MAGIC.len() && bytes[..OLE2_MAGIC.len()] == OLE2_MAGIC
}

fn refuse<T>(code: Ole2FailureCode, detail: impl Into<String>) -> Result<T, GateError> {
    Err(GateError::Compound(CompoundFileError {
        code,
        detail: detail.into(),
    }))
}

/// A table value that names a sector: readers take the 32 bits as a signed
/// number and end a chain at the first negative one.
fn names_sector(value: u64) -> bool {
    value < 0x8000_0000
}

fn index_of(value: u64) -> Option<usize> {
    usize::try_from(value).ok()
}

/// A `DataView` over the file, little endian.
struct View<'a> {
    bytes: &'a [u8],
}

impl View<'_> {
    fn u8(&self, at: u64) -> Option<u8> {
        index_of(at).and_then(|at| self.bytes.get(at)).copied()
    }

    fn u16(&self, at: u64) -> Result<u64, GateError> {
        Ok(u64::from(u16::from_le_bytes(self.array(at, "Uint16")?)))
    }

    fn u32(&self, at: u64) -> Result<u64, GateError> {
        Ok(u64::from(u32::from_le_bytes(self.array(at, "Uint32")?)))
    }

    fn i32(&self, at: u64) -> Result<i32, GateError> {
        self.array(at, "Int32").map(i32::from_le_bytes)
    }

    fn array<const N: usize>(&self, at: u64, _kind: &str) -> Result<[u8; N], GateError> {
        index_of(at)
            .and_then(|at| at.checked_add(N).and_then(|end| self.bytes.get(at..end)))
            .and_then(|slice| <[u8; N]>::try_from(slice).ok())
            .ok_or_else(|| GateError::Range("Offset is outside the bounds of the DataView".into()))
    }
}

/// No chain of a table loops, whichever entry it is followed from.
fn assert_no_loop(
    entries: u64,
    next: &dyn Fn(u64) -> Result<u64, GateError>,
    table: &str,
    sector_count: u64,
) -> Result<(), GateError> {
    let mut reached_by = vec![0_u64; index_of(entries).unwrap_or(usize::MAX)];
    for start in 0..entries {
        if reached_by[start as usize] != 0 {
            continue;
        }
        let mut index = start;
        while index < entries {
            if reached_by[index as usize] == start + 1 {
                return refuse(
                    Ole2FailureCode::Corrupt,
                    format!("{table} loops at entry {index}"),
                );
            }
            if reached_by[index as usize] != 0 {
                break;
            }
            let target = next(index)?;
            if names_sector(target) && target >= sector_count {
                return refuse(
                    Ole2FailureCode::Corrupt,
                    format!("{table} entry {index} points past its sector storage at {target}"),
                );
            }
            reached_by[index as usize] = start + 1;
            index = next(index)?;
        }
    }
    Ok(())
}

/// Refuse bytes that are not a compound file a reader can follow to its end.
pub fn assert_compound_file(bytes: &[u8]) -> Result<(), GateError> {
    use Ole2FailureCode::{Corrupt, LimitsExceeded, NotCfb, Truncated};

    if bytes.is_empty() {
        return refuse(NotCfb, "the file is empty");
    }
    if !has_ole2_signature(bytes) {
        return refuse(
            NotCfb,
            "the file does not start with the OLE2 compound-document signature",
        );
    }
    if bytes.len() < OLE2_HEADER_BYTES {
        return refuse(
            Truncated,
            format!(
                "the file is {} bytes, shorter than the 512-byte OLE2 header",
                bytes.len()
            ),
        );
    }
    let view = View { bytes };
    let file_len = bytes.len() as u64;
    let u32 = |at: u64| view.u32(at);

    let major = view.u16(MAJOR_VERSION)?;
    let sector_shift = view.u16(SECTOR_SHIFT)?;
    if !((major == 3 && sector_shift == 9) || (major == 4 && sector_shift == 12)) {
        return refuse(
            Corrupt,
            format!(
                "version {major} with sector shift {sector_shift} is neither version 3 with 512-byte sectors nor version 4 with 4096-byte ones"
            ),
        );
    }
    if view.u16(MINI_SECTOR_SHIFT)? != 6 {
        return refuse(Corrupt, "the mini sector size is not 64 bytes");
    }
    if u32(MINI_CUTOFF)? != MINI_STREAM_CUTOFF {
        return refuse(Corrupt, "the mini stream cutoff is not 4096 bytes");
    }
    let sector_bytes: u64 = 1 << sector_shift;
    let sector_count = file_len.div_ceil(sector_bytes) as i64 - 1;
    if sector_count < 1 {
        return refuse(Truncated, "the file holds no sector after its header");
    }
    let sector_count = sector_count as u64;
    let offset_of = |sector: u64| (sector + 1) * sector_bytes;
    let links_per_sector = sector_bytes / 4;

    let claimed = std::cell::RefCell::new(vec![false; sector_count as usize]);
    let claim = |sector: u64, what: &str| -> Result<(), GateError> {
        if sector >= sector_count {
            return refuse(
                Corrupt,
                format!("{what} points at sector {sector}, past the end of the file"),
            );
        }
        let mut claimed = claimed.borrow_mut();
        if claimed[sector as usize] {
            return refuse(
                Corrupt,
                format!("{what} reaches sector {sector}, which it or another chain already uses"),
            );
        }
        claimed[sector as usize] = true;
        Ok(())
    };
    let claim_table = |sector: u64, what: &str| -> Result<(), GateError> {
        claim(sector, what)?;
        if offset_of(sector) + sector_bytes > file_len {
            return refuse(
                Truncated,
                format!("{what} holds sector {sector}, which the end of the file cuts short"),
            );
        }
        Ok(())
    };

    let mut fat_sectors: Vec<u64> = Vec::new();
    let mut list_ended = false;
    let mut fat_slot = |value: u64| -> Result<(), GateError> {
        if value == FREE_SECTOR || value == END_OF_CHAIN {
            list_ended = true;
            return Ok(());
        }
        if list_ended {
            return refuse(Corrupt, "the FAT sector list has a gap");
        }
        claim_table(value, "the FAT sector list")?;
        fat_sectors.push(value);
        Ok(())
    };
    for slot in 0..HEADER_FAT_SLOTS {
        fat_slot(u32(HEADER_DIFAT + slot * 4)?)?;
    }
    let mut difat_sectors: u64 = 0;
    let mut difat = u32(DIFAT_START)?;
    while names_sector(difat) {
        claim_table(difat, "the DIFAT chain")?;
        difat_sectors += 1;
        let base = offset_of(difat);
        for slot in 0..links_per_sector - 1 {
            fat_slot(u32(base + slot * 4)?)?;
        }
        difat = u32(base + sector_bytes - 4)?;
    }
    if difat != END_OF_CHAIN && difat != FREE_SECTOR {
        return refuse(
            Corrupt,
            "the DIFAT chain does not end with an end-of-chain mark",
        );
    }
    if difat_sectors != u32(DIFAT_SECTOR_COUNT)? {
        return refuse(
            Corrupt,
            format!(
                "the header counts {} DIFAT sectors and the chain holds {difat_sectors}",
                u32(DIFAT_SECTOR_COUNT)?
            ),
        );
    }
    if fat_sectors.len() as u64 != u32(FAT_SECTOR_COUNT)? {
        return refuse(
            Corrupt,
            format!(
                "the header counts {} FAT sectors and lists {}",
                u32(FAT_SECTOR_COUNT)?,
                fat_sectors.len()
            ),
        );
    }
    if fat_sectors.is_empty() {
        return refuse(Corrupt, "the file has no FAT");
    }
    let fat_entries = fat_sectors.len() as u64 * links_per_sector;
    let fat = |sector: u64| -> Result<u64, GateError> {
        // `fatSectors[...]!` is undefined only past the table, which no caller reaches
        match fat_sectors.get((sector / links_per_sector) as usize) {
            Some(&table) => u32(offset_of(table) + (sector % links_per_sector) * 4),
            None => Err(GateError::Range(
                "Offset is outside the bounds of the DataView".into(),
            )),
        }
    };

    let chain_of = |start: u64, what: &str, table: bool| -> Result<Vec<u64>, GateError> {
        let mut sectors = Vec::new();
        let mut sector = start;
        while names_sector(sector) {
            if table {
                claim_table(sector, what)?;
            } else {
                claim(sector, what)?;
            }
            if sector >= fat_entries {
                return refuse(
                    Corrupt,
                    format!("{what} reaches sector {sector}, which the FAT does not cover"),
                );
            }
            sectors.push(sector);
            sector = fat(sector)?;
        }
        Ok(sectors)
    };
    assert_no_loop(fat_entries, &fat, "the FAT", sector_count)?;

    let directory_sectors = chain_of(u32(DIRECTORY_START)?, "the directory chain", true)?;
    if directory_sectors.is_empty() {
        return refuse(Corrupt, "the file has no directory");
    }
    let entries_per_sector = sector_bytes / ENTRY_BYTES;
    let entry_count = directory_sectors.len() as u64 * entries_per_sector;
    if entry_count > MAX_DIRECTORY_ENTRIES {
        return refuse(
            LimitsExceeded,
            format!(
                "the directory holds {entry_count} entries, over the limit of {MAX_DIRECTORY_ENTRIES}"
            ),
        );
    }
    let entry_at = |index: u64| -> u64 {
        offset_of(directory_sectors[(index / entries_per_sector) as usize])
            + (index % entries_per_sector) * ENTRY_BYTES
    };
    // version 3 keeps a size in 32 bits and leaves the upper half undefined
    let size_of = |entry: u64| -> Result<f64, GateError> {
        let low = u32(entry + ENTRY_SIZE)? as f64;
        Ok(if major == 4 {
            low + u32(entry + ENTRY_SIZE + 4)? as f64 * 4_294_967_296.0
        } else {
            low
        })
    };

    let mini_fat_sectors = if u32(MINI_FAT_SECTOR_COUNT)? == 0 {
        Vec::new()
    } else {
        chain_of(u32(MINI_FAT_START)?, "the mini FAT chain", true)?
    };
    let mini_fat_entries = mini_fat_sectors.len() as u64 * links_per_sector;
    let mini_fat = |mini: u64| -> Result<u64, GateError> {
        match mini_fat_sectors.get((mini / links_per_sector) as usize) {
            Some(&table) => u32(offset_of(table) + (mini % links_per_sector) * 4),
            None => Err(GateError::Range(
                "Offset is outside the bounds of the DataView".into(),
            )),
        }
    };

    let root = entry_at(0);
    if view.u8(root + ENTRY_TYPE) != Some(TYPE_ROOT) {
        return refuse(Corrupt, "the first directory entry is not the root entry");
    }
    let root_size = size_of(root)?;
    let mini_stream_bytes = if root_size == 0.0 {
        0
    } else {
        chain_of(u32(root + ENTRY_START)?, "the mini stream", false)?.len() as u64 * sector_bytes
    };
    if root_size > mini_stream_bytes as f64 {
        return refuse(
            Corrupt,
            format!(
                "the mini stream declares {} bytes and its chain holds {mini_stream_bytes}",
                jscompat::number_to_string(root_size)
            ),
        );
    }
    let mini_sector_count = mini_stream_bytes / MINI_SECTOR_BYTES;
    assert_no_loop(
        mini_fat_entries,
        &mini_fat,
        "the mini FAT",
        mini_sector_count,
    )?;
    let mut mini_claimed = vec![false; mini_sector_count as usize];

    for index in 1..entry_count {
        let entry = entry_at(index);
        let kind = view.u8(entry + ENTRY_TYPE);
        if kind == Some(TYPE_ROOT) {
            return refuse(
                Corrupt,
                format!("directory entry {index} is a second root entry"),
            );
        }
        if kind != Some(TYPE_UNUSED) && kind != Some(TYPE_STORAGE) && kind != Some(TYPE_STREAM) {
            return refuse(
                Corrupt,
                format!(
                    "directory entry {index} has the unknown type {}",
                    kind.map_or_else(|| "undefined".to_owned(), |kind| kind.to_string())
                ),
            );
        }
        if kind != Some(TYPE_STREAM) {
            continue;
        }
        let size = size_of(entry)?;
        if size == 0.0 {
            continue;
        }
        let what = format!("stream {index}");
        let held: u64 = if size >= MINI_STREAM_CUTOFF as f64 {
            chain_of(u32(entry + ENTRY_START)?, &what, false)?.len() as u64 * sector_bytes
        } else {
            let mut mini_sectors: u64 = 0;
            let mut mini = u32(entry + ENTRY_START)?;
            while names_sector(mini) {
                if mini >= mini_sector_count {
                    return refuse(
                        Corrupt,
                        format!(
                            "{what} points at mini sector {mini}, past the end of the mini stream"
                        ),
                    );
                }
                if mini >= mini_fat_entries {
                    return refuse(
                        Corrupt,
                        format!(
                            "{what} reaches mini sector {mini}, which the mini FAT does not cover"
                        ),
                    );
                }
                if mini_claimed[mini as usize] {
                    return refuse(
                        Corrupt,
                        format!(
                            "{what} reaches mini sector {mini}, which it or another stream already uses"
                        ),
                    );
                }
                mini_claimed[mini as usize] = true;
                mini_sectors += 1;
                mini = mini_fat(mini)?;
            }
            mini_sectors * MINI_SECTOR_BYTES
        };
        if size > held as f64 {
            return refuse(
                Corrupt,
                format!(
                    "{what} declares {} bytes and its chain holds {held}",
                    jscompat::number_to_string(size)
                ),
            );
        }
    }

    // The directory tree.
    let mut depth = vec![-1_i64; entry_count as usize];
    depth[0] = 0;
    let mut pending: Vec<u64> = vec![0];
    while let Some(index) = pending.pop() {
        let entry = entry_at(index);
        for link in ENTRY_LINKS {
            let target = u32(entry + link)?;
            if target == NO_ENTRY {
                continue;
            }
            if index == 0 && link != ENTRY_CHILD {
                return refuse(Corrupt, "the root entry has a sibling");
            }
            if target >= entry_count {
                return refuse(
                    Corrupt,
                    format!(
                        "directory entry {index} links to entry {target}, which does not exist"
                    ),
                );
            }
            if depth[target as usize] != -1 {
                return refuse(
                    Corrupt,
                    format!("the directory reaches entry {target} twice"),
                );
            }
            depth[target as usize] = depth[index as usize] + i64::from(link == ENTRY_CHILD);
            if depth[target as usize] > MAX_STORAGE_DEPTH {
                return refuse(
                    LimitsExceeded,
                    format!(
                        "the directory nests storages deeper than the limit of {MAX_STORAGE_DEPTH}"
                    ),
                );
            }
            pending.push(target);
        }
    }
    for index in 1..entry_count {
        if depth[index as usize] != -1 {
            continue;
        }
        let entry = entry_at(index);
        let unused = view.u8(entry + ENTRY_TYPE) == Some(TYPE_UNUSED);
        for link in ENTRY_LINKS {
            let target = u32(entry + link)?;
            if target == NO_ENTRY || (unused && target == 0) {
                continue;
            }
            return refuse(
                Corrupt,
                format!("directory entry {index} is outside the directory tree and links into it"),
            );
        }
    }

    // What cfb does with the FAT beyond the chains above.
    let budget = CHAIN_COPY_FLOOR_BYTES
        .max(CHAIN_COPY_FILE_MULTIPLE * file_len)
        .div_ceil(sector_bytes);
    let mut walked: u64 = 0;
    let reached = std::cell::RefCell::new(vec![false; sector_count as usize]);
    let mut chain_start = vec![false; sector_count as usize];
    let mut walk_from = |start: u64| -> Result<(), GateError> {
        let mut sector = start;
        while names_sector(sector) {
            walked += 1;
            if walked > budget {
                return refuse(
                    LimitsExceeded,
                    "the sector chains run backwards so often that reading them would copy the file many times over",
                );
            }
            if sector < sector_count {
                reached.borrow_mut()[sector as usize] = true;
            }
            if sector >= fat_entries {
                break;
            }
            sector = fat(sector)?;
        }
        Ok(())
    };
    let directory_start = directory_sectors[0];
    for nth in 0..sector_count {
        let sector = (nth + directory_start) % sector_count;
        if reached.borrow()[sector as usize] {
            continue;
        }
        chain_start[sector as usize] = true;
        walk_from(sector)?;
    }
    for index in 1..entry_count {
        let entry = entry_at(index);
        if i64::from(view.i32(entry + ENTRY_SIZE)?) < MINI_STREAM_CUTOFF as i64 {
            continue;
        }
        let start = u32(entry + ENTRY_START)?;
        if !names_sector(start) {
            continue;
        }
        if start < sector_count {
            if chain_start[start as usize] {
                continue;
            }
            chain_start[start as usize] = true;
        }
        walk_from(start)?;
    }
    Ok(())
}

/// `assertSoundCompoundFile`: the gate, its own refusal as a `DamagedFileError`.
pub fn assert_sound_compound_file(bytes: &[u8], document_type: &str) -> Result<(), SoundError> {
    match assert_compound_file(bytes) {
        Ok(()) => Ok(()),
        Err(GateError::Compound(cause)) => Err(SoundError::Damaged(DamagedFileError::new(
            document_type,
            cause,
        ))),
        Err(other) => Err(SoundError::Other {
            name: other.name(),
            message: other.message(),
        }),
    }
}

/// An error as the gate compares it: its name and its message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsError {
    pub name: String,
    pub message: String,
}

impl JsError {
    pub fn new(name: &str, message: impl Into<String>) -> Self {
        Self {
            name: name.to_owned(),
            message: message.into(),
        }
    }

    /// What `CFB.read` threw, as `compound.rs` words it.
    pub fn of_cfb(message: String) -> Self {
        let name = if message.starts_with("Cannot read properties of ")
            || message.starts_with("Cannot set properties of ")
        {
            "TypeError"
        } else {
            "Error"
        };
        Self::new(name, message)
    }
}

impl From<SoundError> for JsError {
    fn from(error: SoundError) -> Self {
        Self::new(error.name(), error.message())
    }
}

/// What the JavaScript throws, by the kind that names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Thrown {
    /// `TypeError`.
    Type(String),
    /// `RangeError`.
    Range(String),
    /// A thrown string: `typeof` is the name.
    Text(String),
    /// Anything else, `Error`.
    Error(String),
}

impl From<Thrown> for JsError {
    fn from(error: Thrown) -> Self {
        Self {
            name: error.name().to_owned(),
            message: error.message().to_owned(),
        }
    }
}

impl Thrown {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Type(_) => "TypeError",
            Self::Range(_) => "RangeError",
            Self::Text(_) => "string",
            Self::Error(_) => "Error",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Type(message)
            | Self::Range(message)
            | Self::Text(message)
            | Self::Error(message) => message,
        }
    }
}

/// `text.replace(/\r\n?/g, '\n').trim()` on UTF-16 units.
pub fn normalize_text(text: &[u16]) -> Vec<u16> {
    let mut out: Vec<u16> = Vec::with_capacity(text.len());
    let mut at = 0;
    while at < text.len() {
        if text[at] == 0x0d {
            out.push(0x0a);
            if text.get(at + 1) == Some(&0x0a) {
                at += 1;
            }
        } else {
            out.push(text[at]);
        }
        at += 1;
    }
    trim_units(&out).to_vec()
}

/// `String.prototype.trim` on UTF-16 units.
pub fn trim_units(text: &[u16]) -> &[u16] {
    let is_space = |unit: &u16| char::from_u32(u32::from(*unit)).is_some_and(jscompat::is_js_space);
    let start = text.iter().position(|unit| !is_space(unit));
    match start {
        None => &[],
        Some(start) => {
            let end = text
                .iter()
                .rposition(|unit| !is_space(unit))
                .unwrap_or(start);
            &text[start..=end]
        }
    }
}
