//! `packages/compound-file/src/validate.ts` (the gate every compound file
//! passes) and the part of `packages/electron-utils/src/office-encryption.ts`
//! that asks it: `isCfbHeader`, `isDamagedCompoundFile`.
//!
//! A `DataView` read past the end throws a `RangeError` in the TypeScript;
//! here it is [`Failure::Range`]. `isDamagedCompoundFile` catches both kinds.

/// An OLE2/CFB compound document starts with this 8-byte signature.
pub const OLE2_MAGIC: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/// A compound file is at least its 512-byte header.
pub const OLE2_HEADER_BYTES: usize = 512;
pub const MAX_DIRECTORY_ENTRIES: u64 = 32768;
pub const MAX_STORAGE_DEPTH: i32 = 64;

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

/// `Ole2FailureCode`
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ole2FailureCode {
    NotCfb,
    Truncated,
    LimitsExceeded,
    Corrupt,
}

/// Why `assertCompoundFile` threw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// a `CompoundFileError`
    Refused {
        code: Ole2FailureCode,
        detail: String,
    },
    /// the `RangeError` of a `DataView` read past the end
    Range,
}

type Check<T> = Result<T, Failure>;

/// Claims a table sector through the given plain claim step.
type ClaimTableFn<'a> =
    dyn FnMut(&mut dyn FnMut(u64, &str) -> Check<()>, u64, &str) -> Check<()> + 'a;

fn refuse<T>(code: Ole2FailureCode, detail: impl Into<String>) -> Check<T> {
    Err(Failure::Refused {
        code,
        detail: detail.into(),
    })
}

/// `hasOle2Signature(bytes)`
pub fn has_ole2_signature(bytes: &[u8]) -> bool {
    bytes.len() >= OLE2_MAGIC.len() && bytes[..8] == OLE2_MAGIC
}

/// `isCfbHeader(bytes)` of office-encryption.ts and cfb-sniff.ts
pub fn is_cfb_header(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[..8] == OLE2_MAGIC
}

/// `namesSector(value)`: a table value that names a sector
fn names_sector(value: u64) -> bool {
    value < 0x8000_0000
}

struct View<'a>(&'a [u8]);

impl View<'_> {
    fn bytes<const N: usize>(&self, at: u64) -> Check<[u8; N]> {
        let end = at.checked_add(N as u64).ok_or(Failure::Range)?;
        if end > self.0.len() as u64 {
            return Err(Failure::Range);
        }
        let mut out = [0u8; N];
        out.copy_from_slice(&self.0[at as usize..end as usize]);
        Ok(out)
    }
    fn u16(&self, at: u64) -> Check<u64> {
        Ok(u64::from(u16::from_le_bytes(self.bytes(at)?)))
    }
    fn u32(&self, at: u64) -> Check<u64> {
        Ok(u64::from(u32::from_le_bytes(self.bytes(at)?)))
    }
    fn i32(&self, at: u64) -> Check<i64> {
        Ok(i64::from(i32::from_le_bytes(self.bytes(at)?)))
    }
}

/// `assertNoLoop(entries, next, table, sectorCount)`
fn assert_no_loop(
    entries: u64,
    next: &dyn Fn(u64) -> Check<u64>,
    table: &str,
    sector_count: u64,
) -> Check<()> {
    // 0, or one more than the entry the walk that first reached this one started from
    let mut reached_by = vec![0u32; entries as usize];
    for start in 0..entries {
        if reached_by[start as usize] != 0 {
            continue;
        }
        let mut index = start;
        while index < entries {
            if u64::from(reached_by[index as usize]) == start + 1 {
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
            reached_by[index as usize] = (start + 1) as u32;
            index = next(index)?;
        }
    }
    Ok(())
}

/// `assertCompoundFile(bytes)`
pub fn assert_compound_file(bytes: &[u8]) -> Check<()> {
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
    let len = bytes.len() as u64;
    let view = View(bytes);
    let u32_at = |at: u64| view.u32(at);

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
    if u32_at(MINI_CUTOFF)? != MINI_STREAM_CUTOFF {
        return refuse(Corrupt, "the mini stream cutoff is not 4096 bytes");
    }
    let sector_bytes: u64 = 1 << sector_shift;
    // sector n starts (n + 1) sectors into the file; the last one may be cut short
    let sector_count = len.div_ceil(sector_bytes) - 1;
    if sector_count < 1 {
        return refuse(Truncated, "the file holds no sector after its header");
    }
    let offset_of = |sector: u64| (sector + 1) * sector_bytes;
    let links_per_sector = sector_bytes / 4;

    let mut claimed = vec![false; sector_count as usize];
    let mut claim = |sector: u64, what: &str| -> Check<()> {
        if sector >= sector_count {
            return refuse(
                Corrupt,
                format!("{what} points at sector {sector}, past the end of the file"),
            );
        }
        if claimed[sector as usize] {
            return refuse(
                Corrupt,
                format!("{what} reaches sector {sector}, which it or another chain already uses"),
            );
        }
        claimed[sector as usize] = true;
        Ok(())
    };
    // a sector of a table is read whole, so the end of the file may not cut it
    let mut claim_table =
        |claim: &mut dyn FnMut(u64, &str) -> Check<()>, sector: u64, what: &str| -> Check<()> {
            claim(sector, what)?;
            if offset_of(sector) + sector_bytes > len {
                return refuse(
                    Truncated,
                    format!("{what} holds sector {sector}, which the end of the file cuts short"),
                );
            }
            Ok(())
        };

    // The FAT sector list
    let mut fat_sectors: Vec<u64> = Vec::new();
    let mut list_ended = false;
    let mut fat_slot = |claim: &mut dyn FnMut(u64, &str) -> Check<()>,
                        claim_table: &mut ClaimTableFn<'_>,
                        value: u64|
     -> Check<()> {
        if value == FREE_SECTOR || value == END_OF_CHAIN {
            list_ended = true;
            return Ok(());
        }
        if list_ended {
            return refuse(Corrupt, "the FAT sector list has a gap");
        }
        claim_table(claim, value, "the FAT sector list")?;
        fat_sectors.push(value);
        Ok(())
    };
    for slot in 0..HEADER_FAT_SLOTS {
        let value = u32_at(HEADER_DIFAT + slot * 4)?;
        fat_slot(&mut claim, &mut claim_table, value)?;
    }
    let mut difat_sectors: u64 = 0;
    let mut difat = u32_at(DIFAT_START)?;
    while names_sector(difat) {
        claim_table(&mut claim, difat, "the DIFAT chain")?;
        difat_sectors += 1;
        let base = offset_of(difat);
        for slot in 0..links_per_sector - 1 {
            let value = u32_at(base + slot * 4)?;
            fat_slot(&mut claim, &mut claim_table, value)?;
        }
        difat = u32_at(base + sector_bytes - 4)?;
    }
    if difat != END_OF_CHAIN && difat != FREE_SECTOR {
        return refuse(
            Corrupt,
            "the DIFAT chain does not end with an end-of-chain mark",
        );
    }
    if difat_sectors != u32_at(DIFAT_SECTOR_COUNT)? {
        return refuse(
            Corrupt,
            format!(
                "the header counts {} DIFAT sectors and the chain holds {difat_sectors}",
                u32_at(DIFAT_SECTOR_COUNT)?
            ),
        );
    }
    if fat_sectors.len() as u64 != u32_at(FAT_SECTOR_COUNT)? {
        return refuse(
            Corrupt,
            format!(
                "the header counts {} FAT sectors and lists {}",
                u32_at(FAT_SECTOR_COUNT)?,
                fat_sectors.len()
            ),
        );
    }
    if fat_sectors.is_empty() {
        return refuse(Corrupt, "the file has no FAT");
    }
    let fat_entries = fat_sectors.len() as u64 * links_per_sector;
    let fat = |sector: u64| -> Check<u64> {
        u32_at(
            offset_of(fat_sectors[(sector / links_per_sector) as usize])
                + (sector % links_per_sector) * 4,
        )
    };

    // The sectors of a chain in the FAT, each claimed for it.
    let chain_of = |claim: &mut dyn FnMut(u64, &str) -> Check<()>,
                    claim_table: &mut ClaimTableFn<'_>,
                    start: u64,
                    what: &str,
                    table: bool|
     -> Check<Vec<u64>> {
        let mut sectors = Vec::new();
        let mut sector = start;
        while names_sector(sector) {
            if table {
                claim_table(claim, sector, what)?;
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

    let directory_sectors = chain_of(
        &mut claim,
        &mut claim_table,
        u32_at(DIRECTORY_START)?,
        "the directory chain",
        true,
    )?;
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
    let size_of = |entry: u64| -> Check<f64> {
        let low = u32_at(entry + ENTRY_SIZE)? as f64;
        Ok(if major == 4 {
            low + u32_at(entry + ENTRY_SIZE + 4)? as f64 * 4_294_967_296.0
        } else {
            low
        })
    };

    // A table or stream of nothing names no chain
    let mini_fat_sectors = if u32_at(MINI_FAT_SECTOR_COUNT)? == 0 {
        Vec::new()
    } else {
        chain_of(
            &mut claim,
            &mut claim_table,
            u32_at(MINI_FAT_START)?,
            "the mini FAT chain",
            true,
        )?
    };
    let mini_fat_entries = mini_fat_sectors.len() as u64 * links_per_sector;
    let mini_fat = |mini: u64| -> Check<u64> {
        u32_at(
            offset_of(mini_fat_sectors[(mini / links_per_sector) as usize])
                + (mini % links_per_sector) * 4,
        )
    };

    let root = entry_at(0);
    if view.0[(root + ENTRY_TYPE) as usize] != TYPE_ROOT {
        return refuse(Corrupt, "the first directory entry is not the root entry");
    }
    // the root entry names the mini stream, the chain small streams are cut from
    let root_size = size_of(root)?;
    let mini_stream_bytes = if root_size == 0.0 {
        0
    } else {
        chain_of(
            &mut claim,
            &mut claim_table,
            u32_at(root + ENTRY_START)?,
            "the mini stream",
            false,
        )?
        .len() as u64
            * sector_bytes
    };
    if root_size > mini_stream_bytes as f64 {
        return refuse(
            Corrupt,
            format!(
                "the mini stream declares {root_size} bytes and its chain holds {mini_stream_bytes}"
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
        let kind = view.0[(entry + ENTRY_TYPE) as usize];
        if kind == TYPE_ROOT {
            return refuse(
                Corrupt,
                format!("directory entry {index} is a second root entry"),
            );
        }
        if kind != TYPE_UNUSED && kind != TYPE_STORAGE && kind != TYPE_STREAM {
            return refuse(
                Corrupt,
                format!("directory entry {index} has the unknown type {kind}"),
            );
        }
        if kind != TYPE_STREAM {
            continue;
        }
        let size = size_of(entry)?;
        if size == 0.0 {
            continue;
        }
        let what = format!("stream {index}");

        let held: u64 = if size >= MINI_STREAM_CUTOFF as f64 {
            chain_of(
                &mut claim,
                &mut claim_table,
                u32_at(entry + ENTRY_START)?,
                &what,
                false,
            )?
            .len() as u64
                * sector_bytes
        } else {
            let mut mini_sectors: u64 = 0;
            let mut mini = u32_at(entry + ENTRY_START)?;
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
                format!("{what} declares {size} bytes and its chain holds {held}"),
            );
        }
    }

    // The directory tree.
    let mut depth = vec![-1i32; entry_count as usize];
    depth[0] = 0;
    let mut pending: Vec<u64> = vec![0];
    while let Some(index) = pending.pop() {
        let entry = entry_at(index);
        for link in ENTRY_LINKS {
            let target = u32_at(entry + link)?;
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
            depth[target as usize] = depth[index as usize] + i32::from(link == ENTRY_CHILD);
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
        // some writers leave an unused entry filled with zeros, which reads as three links to entry 0
        let unused = view.0[(entry + ENTRY_TYPE) as usize] == TYPE_UNUSED;
        for link in ENTRY_LINKS {
            let target = u32_at(entry + link)?;
            if target == NO_ENTRY || (unused && target == 0) {
                continue;
            }
            return refuse(
                Corrupt,
                format!("directory entry {index} is outside the directory tree and links into it"),
            );
        }
    }

    // What cfb does with the FAT beyond the chains above
    let budget =
        (CHAIN_COPY_FLOOR_BYTES.max(CHAIN_COPY_FILE_MULTIPLE * len)).div_ceil(sector_bytes);
    let mut walked: u64 = 0;
    let mut reached = vec![false; sector_count as usize];
    let mut chain_start = vec![false; sector_count as usize];
    let walk_from = |start: u64, walked: &mut u64, reached: &mut [bool]| -> Check<()> {
        let mut sector = start;
        while names_sector(sector) {
            *walked += 1;
            if *walked > budget {
                return refuse(
                    LimitsExceeded,
                    "the sector chains run backwards so often that reading them would copy the file many times over",
                );
            }
            if sector < sector_count {
                reached[sector as usize] = true;
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
        if reached[sector as usize] {
            continue;
        }
        chain_start[sector as usize] = true;
        walk_from(sector, &mut walked, &mut reached)?;
    }
    for index in 1..entry_count {
        let entry = entry_at(index);
        if view.i32(entry + ENTRY_SIZE)? < MINI_STREAM_CUTOFF as i64 {
            continue;
        }
        let start = u32_at(entry + ENTRY_START)?;
        if !names_sector(start) {
            continue;
        }
        if start < sector_count {
            if chain_start[start as usize] {
                continue;
            }
            chain_start[start as usize] = true;
        }
        walk_from(start, &mut walked, &mut reached)?;
    }
    Ok(())
}

/// `isDamagedCompoundFile(bytes)`: starts like a compound file and the gate
/// refuses its container
pub fn is_damaged_compound_file(bytes: &[u8]) -> bool {
    if !is_cfb_header(bytes) {
        return false;
    }
    assert_compound_file(bytes).is_err()
}
