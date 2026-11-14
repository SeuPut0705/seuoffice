//! The streams of an OLE compound file (.doc, .ppt) as `CFB.read` of cfb
//! 1.2.2 lists them: every entry of type 2, in directory order, with the
//! bytes cfb gives it. A raw reader for the legacy formats, not a text
//! extractor.
//!
//! Where cfb answers, this answers the same, its quirks included: numbers are
//! read as int32 (a missing low byte is NaN, missing high bytes are 0), FAT
//! locations a DIFAT sector lists follow the first gap in the header's list,
//! a chain that cfb's sweep over all sectors starts is cut where that sweep
//! meets a sector twice, and a stream that starts elsewhere is read as far as
//! the FAT goes. Where cfb throws, this returns cfb's message, `TypeError`s
//! included. A zip or MIME container, which cfb reads too, is refused.
//!
//! Where cfb never returns, or reads bytes it has already read, this refuses
//! with a message that starts `compound:`:
//! - a FAT chain cfb follows without a visited set that comes back to a
//!   sector (cfb loops until memory runs out);
//! - a MiniFAT chain that comes back to a mini sector (cfb repeats the bytes
//!   up to the declared size);
//! - a DIFAT chain that comes back to a sector (cfb recurses once per
//!   declared DIFAT sector);
//! - directory links that never settle or parents in a cycle (cfb's
//!   `build_full_paths` grows its queue or a path without end);
//! - streams whose bytes add up to more than the file, which only chains
//!   shared between entries do;
//! - more than `16 * (sectors + 1) + 65536` FAT steps, or more than
//!   `64 * (entries + 1) + min(entries², 2^24)` directory link steps.

use std::collections::{HashMap, HashSet, VecDeque};

use serde::Serialize;

const ENDOFCHAIN: i32 = -2;
const FREESECT: i32 = -1;
const MINI_SECTOR: u64 = 64;
const MINI_CUTOFF: i32 = 4096;
const FAT_STEPS_PER_SECTOR: u64 = 16;
const FAT_STEPS_BASE: u64 = 1 << 16;
const LINK_STEPS_PER_ENTRY: u64 = 64;
const LINK_STEPS_QUADRATIC: u64 = 1 << 24;

const ZIP: &str = "compound: a zip container is not a compound file";
const MIME: &str = "compound: a MIME container is not a compound file";
const SET_NAME: &str = "Cannot set properties of undefined (setting 'name')";
const READ_LINKS: &str = "Cannot read properties of undefined (reading 'L')";
/// Node 22's `Buffer.concat` over a list with a sector past the file.
const NOT_A_BUFFER: &str = "Cannot read properties of undefined (reading 'length')";

/// A number cfb reads as int32; `None` is NaN.
type Int = Option<i32>;
/// A key of cfb's `sector_list`; `None` is `NaN`.
type Key = Option<i64>;

/// One stream entry: its name as cfb decodes it, and its bytes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Stream {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// `CFB.read(bytes).FileIndex` filtered to streams, each as `{ name, bytes }`.
pub fn read_streams(bytes: &[u8]) -> Result<Vec<Stream>, String> {
    let (mut reader, header) = open(bytes)?;
    let (links, streams, _) = reader.read_directory(&header)?;
    check_links(&links)?;
    reader.stream_bytes(streams, bytes.len())
}

/// One entry of `CFB.read(bytes).FileIndex`, with its `FullPaths` string.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    /// cfb's `type`: 1 storage, 2 stream, 5 root, 0 an entry cfb cleared.
    pub kind: Option<u8>,
    /// `FullPaths[i]`: a storage ends with `/`, a stream does not.
    pub full_path: String,
    /// `content`; `None` is `undefined`.
    pub content: Option<Vec<u8>>,
}

/// `CFB.read(bytes)`: every entry of `FileIndex`, in directory order.
pub fn read_index(bytes: &[u8]) -> Result<Vec<IndexEntry>, String> {
    let (mut reader, header) = open(bytes)?;
    let (links, _, contents) = reader.read_directory(&header)?;
    let paths = check_links(&links)?;
    let contents = reader.materialize(contents, bytes.len())?;
    Ok(links
        .into_iter()
        .zip(paths)
        .zip(contents)
        .map(|((link, full_path), content)| IndexEntry {
            kind: link.kind,
            full_path,
            content,
        })
        .collect())
}

/// cfb's `parse` up to `read_directory`.
fn open(bytes: &[u8]) -> Result<(Reader<'_>, Header), String> {
    let mut header = read_header(bytes)?;
    let sectors = Sectors::new(bytes, header.sector_size);
    let mut fat = std::mem::take(&mut header.fat);
    read_difat(&sectors, header.difat_start, header.difat_count, &mut fat)?;
    let reader = Reader::new(sectors, fat, header.dir_start)?;
    let first_fat = match reader.fat.first() {
        Some(Some(location)) => Some(i64::from(*location)),
        _ => None,
    };
    if !reader.exists(Some(i64::from(header.dir_start)))
        || (header.mini_fat_count > 0
            && header.mini_fat_start != ENDOFCHAIN
            && !reader.exists(Some(i64::from(header.mini_fat_start))))
        || !reader.exists(first_fat)
    {
        return Err(SET_NAME.into());
    }
    Ok((reader, header))
}

struct Header {
    sector_size: usize,
    dir_start: i32,
    mini_fat_start: i32,
    mini_fat_count: i32,
    difat_start: i32,
    difat_count: i32,
    fat: Vec<Int>,
}

/// cfb's `parse` up to its sectors: the header checks in their order, each
/// with cfb's message.
fn read_header(bytes: &[u8]) -> Result<Header, String> {
    if let [first, second, ..] = bytes {
        if *first == 0x50 && *second == 0x4b {
            return Err(ZIP.into());
        }
        if (first | 0x20) == 0x6d && (second | 0x20) == 0x69 {
            return Err(MIME.into());
        }
    }
    let Some(head) = bytes.get(..512) else {
        return Err(format!("CFB file size {} < 512", bytes.len()));
    };
    let u16_at = |at: usize| u16::from_le_bytes([head[at], head[at + 1]]);
    let i32_at =
        |at: usize| i32::from_le_bytes([head[at], head[at + 1], head[at + 2], head[at + 3]]);
    let expect = |field: &str, from: usize, to: usize, want: &str| {
        let saw: String = head[from..to]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if saw == want {
            Ok(())
        } else {
            Err(format!("{field}Expected {want} saw {saw}"))
        }
    };
    expect("Header Signature: ", 0, 8, "d0cf11e0a1b11ae1")?;
    let major = u16_at(26);
    let sector_size = match major {
        3 => 512,
        4 => 4096,
        0 if u16_at(24) == 0 => return Err(ZIP.into()),
        _ => return Err(format!("Major Version: Expected 3 or 4 saw {major}")),
    };
    match u16_at(30) {
        9 if major != 3 => return Err("Sector Shift: Expected 9 saw 9".into()),
        12 if major != 4 => return Err("Sector Shift: Expected 12 saw 12".into()),
        9 | 12 => {}
        shift => return Err(format!("Sector Shift: Expected 9 or 12 saw {shift}")),
    }
    expect("Mini Sector Shift: ", 32, 34, "0600")?;
    expect("Reserved: ", 34, 40, "000000000000")?;
    let directory_sectors = i32_at(40);
    if major == 3 && directory_sectors != 0 {
        return Err(format!(
            "# Directory Sectors: Expected 0 saw {directory_sectors}"
        ));
    }
    expect("Mini Stream Cutoff Size: ", 56, 60, "00100000")?;
    Ok(Header {
        sector_size,
        dir_start: i32_at(48),
        mini_fat_start: i32_at(60),
        mini_fat_count: i32_at(64),
        difat_start: i32_at(68),
        difat_count: i32_at(72),
        fat: (0..109)
            .map(|k| i32_at(76 + 4 * k))
            .take_while(|location| *location >= 0)
            .map(Some)
            .collect(),
    })
}

/// cfb's `sectorify`: the sectors after the header, the last one as long as
/// the file leaves it.
#[derive(Clone, Copy)]
struct Sectors<'a> {
    bytes: &'a [u8],
    size: usize,
    count: usize,
}

impl<'a> Sectors<'a> {
    fn new(bytes: &'a [u8], size: usize) -> Self {
        Self {
            bytes,
            size,
            count: bytes.len().div_ceil(size).saturating_sub(1),
        }
    }

    fn get(&self, index: usize) -> &'a [u8] {
        let start = index.saturating_add(1).saturating_mul(self.size);
        let end = start.saturating_add(self.size).min(self.bytes.len());
        self.bytes.get(start..end).unwrap_or_default()
    }

    /// The sector a number names, when the file has it.
    fn index(&self, value: impl TryInto<usize>) -> Option<usize> {
        value.try_into().ok().filter(|index| *index < self.count)
    }
}

/// cfb's `__readInt32LE`: NaN when the low byte is missing, 0 for each
/// missing higher byte.
fn int32_at(bytes: &[u8], at: u64) -> Int {
    let byte = |k: u64| {
        at.checked_add(k)
            .and_then(|i| usize::try_from(i).ok())
            .and_then(|i| bytes.get(i))
            .copied()
    };
    Some(i32::from_le_bytes([
        byte(0)?,
        byte(1).unwrap_or(0),
        byte(2).unwrap_or(0),
        byte(3).unwrap_or(0),
    ]))
}

fn key(value: Int) -> Key {
    value.map(i64::from)
}

/// cfb's `sleuth_fat`, as a loop that refuses to read a DIFAT sector twice.
fn read_difat(
    sectors: &Sectors<'_>,
    start: i32,
    count: i32,
    fat: &mut Vec<Int>,
) -> Result<(), String> {
    let mut visited = vec![false; sectors.count];
    let (mut at, mut left) = (Some(start), count);
    loop {
        if at == Some(ENDOFCHAIN) {
            return if left == 0 {
                Ok(())
            } else {
                Err("DIFAT chain shorter than expected".into())
            };
        }
        let Some(index) = at
            .filter(|value| *value != FREESECT)
            .and_then(|value| sectors.index(value))
        else {
            return Ok(());
        };
        if std::mem::replace(&mut visited[index], true) {
            return Err(format!(
                "compound: the DIFAT chain comes back to sector {index}"
            ));
        }
        let sector = sectors.get(index);
        for k in 0..(sectors.size / 4 - 1) as u64 {
            let location = int32_at(sector, k * 4);
            if location == Some(ENDOFCHAIN) {
                break;
            }
            fat.push(location);
        }
        if left < 1 {
            return Ok(());
        }
        at = int32_at(sector, (sectors.size - 4) as u64);
        left -= 1;
    }
}

/// The sectors cfb concatenates for one `sector_list` entry, in order. A
/// sector appears once at most, so only the file's last sector can be short.
#[derive(Clone, Default)]
struct Chain {
    nodes: Vec<usize>,
    short: Option<(usize, u64)>,
    len: u64,
}

impl Chain {
    fn new(sectors: &Sectors<'_>, nodes: Vec<usize>) -> Self {
        let size = sectors.size as u64;
        let short = nodes.iter().enumerate().find_map(|(at, &node)| {
            let len = sectors.get(node).len() as u64;
            (len < size).then_some((at, len))
        });
        let len =
            (nodes.len() as u64 * size).saturating_sub(short.map_or(0, |(_, len)| size - len));
        Self { nodes, short, len }
    }

    fn locate(&self, size: u64, offset: u64) -> Option<(usize, usize)> {
        let (position, inner) = match self.short {
            Some((at, len)) if offset >= at as u64 * size => {
                let past = offset - at as u64 * size;
                if past < len {
                    (at as u64, past)
                } else {
                    let rest = past - len;
                    (at as u64 + 1 + rest / size, rest % size)
                }
            }
            _ => (offset / size, offset % size),
        };
        let position = usize::try_from(position)
            .ok()
            .filter(|position| *position < self.nodes.len())?;
        Some((position, usize::try_from(inner).ok()?))
    }

    fn byte(&self, sectors: &Sectors<'_>, offset: u64) -> Option<u8> {
        let (position, inner) = self.locate(sectors.size as u64, offset)?;
        sectors.get(*self.nodes.get(position)?).get(inner).copied()
    }

    fn int32(&self, sectors: &Sectors<'_>, at: u64) -> Int {
        let byte = |k: u64| {
            at.checked_add(k)
                .and_then(|offset| self.byte(sectors, offset))
        };
        Some(i32::from_le_bytes([
            byte(0)?,
            byte(1).unwrap_or(0),
            byte(2).unwrap_or(0),
            byte(3).unwrap_or(0),
        ]))
    }

    /// The bytes from `from` to `to`, as far as the chain has them.
    fn copy_into(&self, sectors: &Sectors<'_>, from: u64, to: u64, out: &mut Vec<u8>) {
        let to = to.min(self.len);
        let mut at = from;
        while at < to {
            let Some((position, inner)) = self.locate(sectors.size as u64, at) else {
                return;
            };
            let Some(piece) = self
                .nodes
                .get(position)
                .and_then(|&node| sectors.get(node).get(inner..))
            else {
                return;
            };
            let take = piece
                .len()
                .min(usize::try_from(to - at).unwrap_or(usize::MAX));
            let Some(piece) = piece.get(..take).filter(|piece| !piece.is_empty()) else {
                return;
            };
            out.extend_from_slice(piece);
            at += piece.len() as u64;
        }
    }
}

/// What a stream entry's `content` is when cfb's `read_directory` is done.
#[derive(Clone, Copy)]
enum Content {
    /// `undefined`, which the reader of a legacy document takes as no bytes.
    Missing,
    Fat {
        key: Key,
        size: u64,
    },
    Mini {
        store: Key,
        table: Option<Key>,
        start: Int,
        size: Int,
    },
}

/// What `read_directory` gives: every entry's links, the stream entries, and
/// the content of every entry.
type Directory = (Vec<Link>, Vec<(String, Content)>, Vec<Content>);

/// The fields of a directory entry cfb's `build_full_paths` reads.
struct Link {
    name: String,
    kind: Option<u8>,
    left: Int,
    right: Int,
    child: Int,
}

struct Reader<'a> {
    sectors: Sectors<'a>,
    fat: Vec<Int>,
    /// The in-file sectors at which cfb's `make_sector_list` started a chain.
    starts: Vec<bool>,
    /// The negative keys `make_sector_list` set, each to an empty chain.
    empty_starts: Option<(i64, i64)>,
    /// The keys `read_directory` added with `get_sector_list`.
    added: HashSet<Key>,
    chains: HashMap<Key, Chain>,
    seen: Vec<u32>,
    walk: u32,
    steps: u64,
}

impl<'a> Reader<'a> {
    /// cfb's `make_sector_list`, keeping only which keys it sets: a sweep from
    /// the directory's sector over every sector, starting a chain at each one
    /// no earlier chain went through. A chain that leaves the file after
    /// starting in it is cfb's `Buffer.concat` error.
    fn new(sectors: Sectors<'a>, fat: Vec<Int>, dir_start: i32) -> Result<Self, String> {
        let count = sectors.count;
        let mut reader = Self {
            sectors,
            fat,
            starts: vec![false; count],
            empty_starts: None,
            added: HashSet::new(),
            chains: HashMap::new(),
            seen: vec![0; count],
            walk: 0,
            steps: (count as u64)
                .saturating_add(1)
                .saturating_mul(FAT_STEPS_PER_SECTOR)
                .saturating_add(FAT_STEPS_BASE),
        };
        let (n, d) = (count as i64, i64::from(dir_start));
        let mut marked = vec![false; count];
        for i in 0..n {
            let k = if i + d >= n { i + d - n } else { i + d };
            // Negative keys start empty chains. Keys past the file come only
            // from a directory past the file, after every key in it.
            let Some(k) = sectors.index(k).filter(|k| !marked[*k]) else {
                continue;
            };
            reader.starts[k] = true;
            let mut j = k;
            loop {
                reader.step()?;
                marked[j] = true;
                let Some(next) = reader.next(j as u64) else {
                    break;
                };
                match sectors.index(next) {
                    None => return Err(NOT_A_BUFFER.into()),
                    // Every chain through a marked sector was followed to its end.
                    Some(next) if marked[next] => break,
                    Some(next) => j = next,
                }
            }
        }
        if d < 0 {
            reader.empty_starts = Some((d, (d + n - 1).min(-1)));
        }
        Ok(reader)
    }

    fn step(&mut self) -> Result<(), String> {
        self.steps = self
            .steps
            .checked_sub(1)
            .ok_or("compound: the FAT chains take more steps than the file allows")?;
        Ok(())
    }

    fn new_walk(&mut self) -> Result<u32, String> {
        self.walk = self
            .walk
            .checked_add(1)
            .ok_or("compound: too many FAT chains")?;
        Ok(self.walk)
    }

    /// The FAT entry of `sector`, when cfb follows it: `None` ends the chain.
    fn next(&self, sector: u64) -> Option<u64> {
        let per = (self.sectors.size / 4) as u64;
        let location = self
            .fat
            .get(usize::try_from(sector / per).ok()?)
            .copied()
            .flatten()?;
        let fat_sector = self.sectors.index(location)?;
        u64::try_from(int32_at(self.sectors.get(fat_sector), sector % per * 4)?).ok()
    }

    fn starts_at(&self, key: Key) -> bool {
        match key {
            Some(k) if k >= 0 => self.sectors.index(k).is_some_and(|k| self.starts[k]),
            Some(k) => self
                .empty_starts
                .is_some_and(|(low, high)| (low..=high).contains(&k)),
            None => false,
        }
    }

    /// Whether `sector_list[key]` is set.
    fn exists(&self, key: Key) -> bool {
        self.starts_at(key) || self.added.contains(&key)
    }

    /// A chain `make_sector_list` started: up to the first sector it meets twice.
    fn orbit(&mut self, start: usize) -> Result<Chain, String> {
        let walk = self.new_walk()?;
        let (mut nodes, mut j) = (Vec::new(), start);
        loop {
            self.step()?;
            self.seen[j] = walk;
            nodes.push(j);
            let Some(next) = self.next(j as u64) else {
                break;
            };
            let Some(next) = self.sectors.index(next) else {
                return Err(NOT_A_BUFFER.into());
            };
            if self.seen[next] == walk {
                break;
            }
            j = next;
        }
        Ok(Chain::new(&self.sectors, nodes))
    }

    /// cfb's `get_sector_list`, which has no visited set: a sector met twice
    /// is refused. Starting past the file, cfb keeps the sectors in it;
    /// starting in it, a sector past it is cfb's `Buffer.concat` error.
    fn path(&mut self, start: Int) -> Result<Chain, String> {
        let Some(start) = start.and_then(|start| u64::try_from(start).ok()) else {
            return Ok(Chain::default());
        };
        let walk = self.new_walk()?;
        let (mut nodes, mut far, mut hole) = (Vec::new(), HashSet::new(), false);
        let mut j = start;
        loop {
            self.step()?;
            let fresh = match self.sectors.index(j) {
                Some(index) => {
                    let fresh = self.seen[index] != walk;
                    self.seen[index] = walk;
                    nodes.push(index);
                    fresh
                }
                None => {
                    hole = true;
                    far.insert(j)
                }
            };
            if !fresh {
                return Err(format!(
                    "compound: the FAT chain from sector {start} comes back to sector {j}"
                ));
            }
            match self.next(j) {
                Some(next) => j = next,
                None => break,
            }
        }
        if hole && self.sectors.index(start).is_some() {
            return Err(NOT_A_BUFFER.into());
        }
        Ok(Chain::new(&self.sectors, nodes))
    }

    fn chain(&mut self, key: Key) -> Result<&Chain, String> {
        if !self.chains.contains_key(&key) {
            let chain = if !self.starts_at(key) {
                self.path(key.and_then(|k| i32::try_from(k).ok()))?
            } else if let Some(start) = key.and_then(|k| self.sectors.index(k)) {
                self.orbit(start)?
            } else {
                Chain::default()
            };
            self.chains.insert(key, chain);
        }
        self.chains
            .get(&key)
            .ok_or_else(|| "compound: a chain was not kept".to_owned())
    }

    /// cfb's `read_directory`: every entry in order, with the sector chain
    /// lookups and walks it makes, in the same order.
    fn read_directory(&mut self, header: &Header) -> Result<Directory, String> {
        let directory = self.chain(Some(i64::from(header.dir_start)))?.clone();
        let (mut links, mut streams, mut every) = (Vec::new(), Vec::new(), Vec::new());
        let mut store: Int = Some(0);
        let mut at = 0;
        while at < directory.len {
            let mut blob = Vec::with_capacity(128);
            directory.copy_into(&self.sectors, at, at + 128, &mut blob);
            at += 128;
            let name_len = match (blob.get(64), blob.get(65)) {
                (Some(&low), Some(&high)) => Some(usize::from(high) << 8 | usize::from(low)),
                _ => None,
            };
            let name = name_len
                .map(|len| utf16(&blob[..len.min(blob.len())]))
                .unwrap_or_default();
            let (mut kind, mut start, mut size) = (
                blob.get(66).copied(),
                int32_at(&blob, 116),
                int32_at(&blob, 120),
            );
            if size.is_some_and(|size| size < 0) && start.is_some_and(|start| start < 0) {
                (kind, start, size) = (Some(0), Some(ENDOFCHAIN), Some(0));
            }
            let content = if kind == Some(5) {
                store = start;
                if header.mini_fat_count > 0
                    && store != Some(ENDOFCHAIN)
                    && !self.exists(key(store))
                {
                    return Err(SET_NAME.into());
                }
                Content::Missing
            } else if let Some(size) = size.filter(|size| *size >= MINI_CUTOFF) {
                if !self.exists(key(start)) {
                    let chain = self.path(start)?;
                    self.chains.insert(key(start), chain);
                    self.added.insert(key(start));
                }
                Content::Fat {
                    key: key(start),
                    size: u64::from(size.unsigned_abs()),
                }
            } else if size.is_some_and(|size| size < 0) {
                Content::Missing
            } else if store != Some(ENDOFCHAIN)
                && start != Some(ENDOFCHAIN)
                && self.exists(key(store))
            {
                let table = Some(i64::from(header.mini_fat_start));
                Content::Mini {
                    store: key(store),
                    table: self.exists(table).then_some(table),
                    start,
                    size,
                }
            } else {
                Content::Missing
            };
            every.push(content);
            if kind == Some(2) {
                streams.push((name.clone(), content));
            }
            links.push(Link {
                name,
                kind,
                left: int32_at(&blob, 68),
                right: int32_at(&blob, 72),
                child: int32_at(&blob, 76),
            });
        }
        Ok((links, streams, every))
    }

    /// cfb's `get_mfat_entry`, refusing a mini sector met twice.
    fn mini(
        &mut self,
        store: Key,
        table: Option<Key>,
        start: Int,
        size: Int,
    ) -> Result<Vec<u8>, String> {
        let (Some(table), Some(size), Some(first)) = (table, size, start) else {
            return Ok(Vec::new());
        };
        if size <= 0 || first < 0 {
            return Ok(Vec::new());
        }
        self.chain(store)?;
        self.chain(table)?;
        let (Some(payload), Some(table)) = (self.chains.get(&store), self.chains.get(&table))
        else {
            return Ok(Vec::new());
        };
        let (mut out, mut visited, mut left, mut at) =
            (Vec::new(), Vec::new(), i64::from(size), first);
        while left > 0 && at >= 0 {
            if visited.contains(&at) {
                return Err(format!(
                    "compound: the MiniFAT chain from mini sector {first} comes back to mini sector {at}"
                ));
            }
            visited.push(at);
            let from = u64::from(at.unsigned_abs()) * MINI_SECTOR;
            payload.copy_into(&self.sectors, from, from + MINI_SECTOR, &mut out);
            left -= MINI_SECTOR as i64;
            match table.int32(&self.sectors, u64::from(at.unsigned_abs()) * 4) {
                Some(next) => at = next,
                None => break,
            }
        }
        out.truncate(usize::try_from(size).unwrap_or(0));
        Ok(out)
    }

    /// The bytes of each stream, in order, refused once they add up to more
    /// than the file.
    fn stream_bytes(
        &mut self,
        streams: Vec<(String, Content)>,
        file_len: usize,
    ) -> Result<Vec<Stream>, String> {
        let (names, contents): (Vec<String>, Vec<Content>) = streams.into_iter().unzip();
        let bytes = self.materialize(contents, file_len)?;
        Ok(names
            .into_iter()
            .zip(bytes)
            .map(|(name, bytes)| Stream {
                name,
                bytes: bytes.unwrap_or_default(),
            })
            .collect())
    }

    /// The bytes of each content, `None` where cfb has none, refused once
    /// they add up to more than the file.
    fn materialize(
        &mut self,
        contents: Vec<Content>,
        file_len: usize,
    ) -> Result<Vec<Option<Vec<u8>>>, String> {
        let limit = file_len as u64;
        let mut total: u64 = 0;
        let mut admit = |len: u64| -> Result<usize, String> {
            total = total
                .checked_add(len)
                .filter(|total| *total <= limit)
                .ok_or("compound: the streams hold more bytes than the file")?;
            usize::try_from(len).map_err(|_| "compound: a stream does not fit in memory".to_owned())
        };
        let mut out = Vec::with_capacity(contents.len());
        for content in contents {
            let bytes = match content {
                Content::Missing => None,
                Content::Fat { key, size } => {
                    let sectors = self.sectors;
                    let chain = self.chain(key)?;
                    let len = size.min(chain.len);
                    let mut bytes = Vec::with_capacity(admit(len)?);
                    chain.copy_into(&sectors, 0, len, &mut bytes);
                    Some(bytes)
                }
                Content::Mini {
                    store,
                    table,
                    start,
                    size,
                } => {
                    let bytes = self.mini(store, table, start, size)?;
                    admit(bytes.len() as u64)?;
                    Some(bytes)
                }
            };
            out.push(bytes);
        }
        Ok(out)
    }
}

/// Node's `toString('utf16le')` with cfb's NUL removal; a lone surrogate,
/// which a Rust string cannot hold, becomes U+FFFD.
fn utf16(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    let mut name = String::from_utf16_lossy(&units);
    name.retain(|c| c != '\0');
    name
}

/// A JavaScript value in cfb's `dad` table: `Hash` and `Eq` are those of a
/// property key, `same` is `===`.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Js {
    Undefined,
    NaN,
    Int(i64),
}

const NOSTREAM: Js = Js::Int(-1);

impl From<Int> for Js {
    fn from(value: Int) -> Self {
        value.map_or(Self::NaN, |value| Self::Int(value.into()))
    }
}

impl Js {
    fn index(self, len: usize) -> Option<usize> {
        match self {
            Self::Int(value) => usize::try_from(value).ok().filter(|index| *index < len),
            Self::Undefined | Self::NaN => None,
        }
    }
}

/// `===`, and `==` between numbers and `undefined`.
fn same(a: Js, b: Js) -> bool {
    match (a, b) {
        (Js::Int(a), Js::Int(b)) => a == b,
        (Js::Undefined, Js::Undefined) => true,
        _ => false,
    }
}

/// cfb's `dad` array: its own indexes first, any other key as a property.
struct Parents {
    near: Vec<Js>,
    far: HashMap<Js, Js>,
}

impl Parents {
    fn get(&self, key: Js) -> Js {
        match key.index(self.near.len()) {
            Some(index) => self.near[index],
            None => self.far.get(&key).copied().unwrap_or(Js::Undefined),
        }
    }

    fn set(&mut self, key: Js, value: Js) {
        match key.index(self.near.len()) {
            Some(index) => self.near[index] = value,
            None => {
                self.far.insert(key, value);
            }
        }
    }
}

/// The control flow of cfb's `build_full_paths`, which throws or never
/// returns on some links, and the `FullPaths` it builds.
fn check_links(links: &[Link]) -> Result<Vec<String>, String> {
    let mut paths: Vec<String> = links.iter().map(|link| link.name.clone()).collect();
    let count = links.len() as u64;
    let mut steps = count
        .saturating_add(1)
        .saturating_mul(LINK_STEPS_PER_ENTRY)
        .saturating_add(count.saturating_mul(count).min(LINK_STEPS_QUADRATIC));
    let mut step = || -> Result<(), String> {
        steps = steps
            .checked_sub(1)
            .ok_or("compound: the directory links never settle")?;
        Ok(())
    };
    let own = || (0..links.len() as i64).map(Js::Int);
    let mut dad = Parents {
        near: own().collect(),
        far: HashMap::new(),
    };
    let mut queue: VecDeque<Js> = own().collect();
    let mut queued: HashMap<i64, u32> = (0..links.len() as i64).map(|index| (index, 1)).collect();
    let (mut last_left, mut last_right) = (Js::Int(0), Js::Int(0));
    while let Some(&i) = queue.front() {
        step()?;
        let Some(link) = i.index(links.len()).and_then(|index| links.get(index)) else {
            return Err(READ_LINKS.into());
        };
        let (left, right, child) = (
            Js::from(link.left),
            Js::from(link.right),
            Js::from(link.child),
        );
        (last_left, last_right) = (left, right);
        if same(dad.get(i), i) {
            if !same(left, NOSTREAM) && !same(dad.get(left), left) {
                dad.set(i, dad.get(left));
            }
            if !same(right, NOSTREAM) && !same(dad.get(right), right) {
                dad.set(i, dad.get(right));
            }
        }
        if !same(child, NOSTREAM) {
            dad.set(child, i);
        }
        for side in [left, right] {
            if !same(side, NOSTREAM) && !same(i, dad.get(i)) {
                dad.set(side, dad.get(i));
                // `q.lastIndexOf(side) < j`: not in the queue from here on.
                let waiting = match side {
                    Js::Int(value) => queued.get(&value).is_some_and(|times| *times > 0),
                    Js::Undefined | Js::NaN => false,
                };
                if !waiting {
                    queue.push_back(side);
                    if let Js::Int(value) = side {
                        *queued.entry(value).or_insert(0) += 1;
                    }
                }
            }
        }
        if let Js::Int(value) = i
            && let Some(times) = queued.get_mut(&value)
        {
            *times = times.saturating_sub(1);
        }
        queue.pop_front();
    }
    for index in 1..links.len() as i64 {
        let i = Js::Int(index);
        if same(dad.get(i), i) {
            if !same(last_right, NOSTREAM) && !same(dad.get(last_right), last_right) {
                dad.set(i, dad.get(last_right));
            } else if !same(last_left, NOSTREAM) && !same(dad.get(last_left), last_left) {
                dad.set(i, dad.get(last_left));
            }
        }
    }
    for (index, link) in links.iter().enumerate().skip(1) {
        if link.kind == Some(0) {
            continue;
        }
        let i = Js::Int(index as i64);
        if !same(i, dad.get(i)) {
            let (mut visited, mut j) = (HashSet::from([i]), i);
            loop {
                step()?;
                j = dad.get(j);
                if !visited.insert(j) {
                    return Err("compound: the directory parents form a cycle".into());
                }
                let parent = j
                    .index(paths.len())
                    .map_or("undefined", |at| paths[at].as_str())
                    .to_owned();
                paths[index] = format!("{parent}/{}", paths[index]);
                if same(j, Js::Int(0)) || same(NOSTREAM, dad.get(j)) || same(j, dad.get(j)) {
                    break;
                }
            }
        }
        dad.set(i, NOSTREAM);
    }
    if let Some(root) = paths.first_mut() {
        root.push('/');
    }
    for (index, link) in links.iter().enumerate().skip(1) {
        if link.kind != Some(2) {
            paths[index].push('/');
        }
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    //! Each refusal on a file built byte for byte as `hostileInputs` in
    //! tools/fileparse-diff/compound-cases.ts builds it, next to the same
    //! layout without its cycle. The answers on readable layouts follow from
    //! reading cfb.js; no TypeScript run gave them.

    use super::*;

    const FATSECT: i32 = -3;
    const DIFSECT: i32 = -4;
    const SIGNATURE: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

    fn fill(length: usize, seed: usize) -> Vec<u8> {
        (0..length)
            .map(|i| ((seed + i * 31) & 0xff) as u8)
            .collect()
    }

    fn int32s(values: &[i32], length: usize) -> Vec<u8> {
        (0..length / 4)
            .flat_map(|k| values.get(k).copied().unwrap_or(FREESECT).to_le_bytes())
            .collect()
    }

    struct Entry {
        name: &'static str,
        kind: u8,
        left: i32,
        right: i32,
        child: i32,
        start: i32,
        size: i32,
    }

    fn entry(name: &'static str, kind: u8, start: i32, size: i32) -> Entry {
        Entry {
            name,
            kind,
            left: -1,
            right: -1,
            child: -1,
            start,
            size,
        }
    }

    fn directory(entries: &[Entry]) -> Vec<u8> {
        let mut out = vec![0; 512];
        for slot in 0..4 {
            let at = slot * 128;
            let links = match entries.get(slot) {
                Some(entry) => {
                    let units: Vec<u16> = entry.name.encode_utf16().collect();
                    for (k, unit) in units.iter().enumerate() {
                        out[at + 2 * k..at + 2 * k + 2].copy_from_slice(&unit.to_le_bytes());
                    }
                    out[at + 64..at + 66]
                        .copy_from_slice(&((units.len() as u16 + 1) * 2).to_le_bytes());
                    out[at + 66] = entry.kind;
                    out[at + 67] = 1;
                    out[at + 116..at + 120].copy_from_slice(&entry.start.to_le_bytes());
                    out[at + 120..at + 124].copy_from_slice(&entry.size.to_le_bytes());
                    [entry.left, entry.right, entry.child]
                }
                None => [-1; 3],
            };
            out[at + 68..at + 80].copy_from_slice(&int32s(&links, 12));
        }
        out
    }

    fn compound(
        dir_start: i32,
        mini_fat: [i32; 2],
        difat: [i32; 2],
        header_fat: &[i32],
        sectors: &[Vec<u8>],
    ) -> Vec<u8> {
        let mut out = vec![0; 512];
        let fields: [(usize, Vec<u8>); 14] = [
            (0, SIGNATURE.to_vec()),
            (24, 0x3e_u16.to_le_bytes().to_vec()),
            (26, 3_u16.to_le_bytes().to_vec()),
            (28, 0xfffe_u16.to_le_bytes().to_vec()),
            (30, 9_u16.to_le_bytes().to_vec()),
            (32, 6_u16.to_le_bytes().to_vec()),
            (44, (header_fat.len() as i32).to_le_bytes().to_vec()),
            (48, dir_start.to_le_bytes().to_vec()),
            (56, 4096_i32.to_le_bytes().to_vec()),
            (60, mini_fat[0].to_le_bytes().to_vec()),
            (64, mini_fat[1].to_le_bytes().to_vec()),
            (68, difat[0].to_le_bytes().to_vec()),
            (72, difat[1].to_le_bytes().to_vec()),
            (76, int32s(header_fat, 436)),
        ];
        for (at, value) in fields {
            out[at..at + value.len()].copy_from_slice(&value);
        }
        for sector in sectors {
            let mut sector = sector.clone();
            sector.resize(512, 0);
            out.extend(sector);
        }
        out
    }

    const NONE: [i32; 2] = [ENDOFCHAIN, 0];

    fn root(child: i32, start: i32, size: i32) -> Entry {
        Entry {
            child,
            ..entry("Root Entry", 5, start, size)
        }
    }

    /// Sectors 2 and 3 hold one 4096-byte stream starting at `start`; the
    /// FAT sends 2 to 3 and 3 to `after_3`.
    fn two_sector_chain(after_3: i32, start: i32) -> Vec<u8> {
        compound(
            1,
            NONE,
            NONE,
            &[0],
            &[
                int32s(&[FATSECT, ENDOFCHAIN, 3, after_3], 512),
                directory(&[root(1, ENDOFCHAIN, 0), entry("Cycle", 2, start, 4096)]),
                fill(512, 2),
                fill(512, 3),
            ],
        )
    }

    /// A 200-byte stream in mini sectors from 0, with `table` as the MiniFAT.
    fn mini_chain(table: &[i32]) -> Vec<u8> {
        compound(
            1,
            [2, 1],
            NONE,
            &[0],
            &[
                int32s(&[FATSECT, ENDOFCHAIN, ENDOFCHAIN, ENDOFCHAIN], 512),
                directory(&[root(1, 3, 512), entry("Loop", 2, 0, 200)]),
                int32s(table, 512),
                fill(512, 4),
            ],
        )
    }

    /// DIFAT sectors from sector 2 on, each naming the next one in `nexts`.
    fn difat_chain(nexts: &[i32], count: i32) -> Vec<u8> {
        let mut fat = vec![FATSECT, ENDOFCHAIN];
        fat.extend(nexts.iter().map(|_| DIFSECT));
        let mut sectors = vec![int32s(&fat, 512), directory(&[root(-1, ENDOFCHAIN, 0)])];
        for &next in nexts {
            let mut entries = vec![ENDOFCHAIN];
            entries.resize(127, FREESECT);
            entries.push(next);
            sectors.push(int32s(&entries, 512));
        }
        compound(1, NONE, [2, count], &[0], &sectors)
    }

    fn links(entries: &[Entry]) -> Vec<u8> {
        compound(
            1,
            NONE,
            NONE,
            &[0],
            &[int32s(&[FATSECT, ENDOFCHAIN], 512), directory(entries)],
        )
    }

    fn refusal(file: &[u8]) -> String {
        match read_streams(file) {
            Ok(streams) => panic!("read {} streams", streams.len()),
            Err(error) => error,
        }
    }

    #[test]
    fn a_fat_cycle_cfb_follows_without_end_is_refused() {
        let file = two_sector_chain(2, 3);
        assert_eq!(file.len(), 2560);
        assert_eq!(
            refusal(&file),
            "compound: the FAT chain from sector 3 comes back to sector 3"
        );
    }

    #[test]
    fn a_fat_cycle_from_where_the_sector_sweep_starts_is_cut_at_the_repeat() {
        let bytes = [fill(512, 2), fill(512, 3)].concat();
        assert_eq!(
            read_streams(&two_sector_chain(2, 2)),
            Ok(vec![Stream {
                name: "Cycle".into(),
                bytes
            }])
        );
    }

    #[test]
    fn the_same_chain_without_a_cycle_reads_to_its_end() {
        let bytes = fill(512, 3);
        assert_eq!(
            read_streams(&two_sector_chain(ENDOFCHAIN, 3)),
            Ok(vec![Stream {
                name: "Cycle".into(),
                bytes
            }])
        );
    }

    #[test]
    fn a_minifat_cycle_is_refused() {
        assert_eq!(
            refusal(&mini_chain(&[1, 0])),
            "compound: the MiniFAT chain from mini sector 0 comes back to mini sector 0"
        );
    }

    #[test]
    fn a_minifat_chain_without_a_cycle_reads_what_it_holds() {
        let bytes = fill(512, 4)[..128].to_vec();
        assert_eq!(
            read_streams(&mini_chain(&[1, ENDOFCHAIN])),
            Ok(vec![Stream {
                name: "Loop".into(),
                bytes
            }])
        );
    }

    #[test]
    fn a_difat_sector_naming_itself_is_refused_whatever_the_count() {
        assert_eq!(
            refusal(&difat_chain(&[2], i32::MAX)),
            "compound: the DIFAT chain comes back to sector 2"
        );
    }

    #[test]
    fn two_difat_sectors_naming_each_other_are_refused() {
        assert_eq!(
            refusal(&difat_chain(&[3, 2], 3)),
            "compound: the DIFAT chain comes back to sector 2"
        );
    }

    #[test]
    fn a_difat_chain_that_ends_is_read() {
        assert_eq!(read_streams(&difat_chain(&[ENDOFCHAIN], 1)), Ok(Vec::new()));
    }

    #[test]
    fn streams_sharing_one_chain_past_the_file_size_are_refused() {
        let fat = [FATSECT, ENDOFCHAIN, 3, 4, 5, 6, 7, 8, 9, ENDOFCHAIN];
        let mut sectors = vec![
            int32s(&fat, 512),
            directory(&[
                root(1, ENDOFCHAIN, 0),
                Entry {
                    right: 2,
                    ..entry("A", 2, 2, 4096)
                },
                Entry {
                    right: 3,
                    ..entry("B", 2, 2, 4096)
                },
                entry("C", 2, 2, 4096),
            ]),
        ];
        sectors.extend((0..8).map(|k| fill(512, 2 + k)));
        assert_eq!(
            refusal(&compound(1, NONE, NONE, &[0], &sectors)),
            "compound: the streams hold more bytes than the file"
        );
    }

    #[test]
    fn sibling_links_in_a_cycle_are_refused() {
        let file = links(&[
            root(1, ENDOFCHAIN, 0),
            Entry {
                left: 2,
                ..entry("A", 1, 0, 0)
            },
            Entry {
                left: 1,
                ..entry("B", 1, 0, 0)
            },
        ]);
        assert_eq!(refusal(&file), "compound: the directory links never settle");
    }

    #[test]
    fn parent_links_in_a_cycle_are_refused() {
        let file = links(&[
            root(-1, ENDOFCHAIN, 0),
            Entry {
                child: 2,
                ..entry("A", 1, 0, 0)
            },
            Entry {
                child: 1,
                ..entry("B", 1, 0, 0)
            },
        ]);
        assert_eq!(
            refusal(&file),
            "compound: the directory parents form a cycle"
        );
    }
}
