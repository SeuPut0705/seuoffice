//! The compound-file reader of word-extractor (`ole-compound-doc.js`,
//! `ole-header.js`, `ole-allocation-table.js`, `ole-directory-tree.js`,
//! `ole-storage.js`, `ole-storage-stream.js`) over a `BufferReader`. It is
//! not cfb: a file reaches it only through `assertCompoundFile`.

use super::buffer::{Buf, copy};
use crate::compound_gate::Thrown;

const ENTRY_TYPE_STORAGE: f64 = 1.0;
const ENTRY_TYPE_STREAM: f64 = 2.0;
const ENTRY_TYPE_ROOT: f64 = 5.0;
const LEAF: f64 = -1.0;
/// Steps of a chain no reader of this size can take.
const CHAIN_LIMIT: usize = 1 << 28;

/// `BufferReader.read(target, offset, length, position)`.
fn read_into(
    source: &[u8],
    target: &mut [u8],
    offset: f64,
    length: f64,
    position: f64,
) -> Result<(), Thrown> {
    copy(source, target, offset, position, position + length)?;
    Ok(())
}

struct Header {
    sec_size: f64,
    short_sec_size: f64,
    sat_size: f64,
    dir_sec_id: f64,
    short_stream_max: f64,
    ssat_sec_id: f64,
    ssat_size: f64,
    msat_sec_id: f64,
    msat_size: f64,
    partial_msat: Vec<f64>,
}

/// JavaScript's `1 << n`.
fn shift_one(count: f64) -> f64 {
    f64::from(1_i32.wrapping_shl((count as i64 & 31) as u32))
}

impl Header {
    /// `Header.load`: `None` when the signature is not there.
    fn load(buffer: &[u8]) -> Result<Option<Header>, Thrown> {
        const SIGNATURE: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        if buffer[..8] != SIGNATURE {
            return Ok(None);
        }
        let b = Buf::new(buffer);
        let mut partial_msat = Vec::with_capacity(109);
        for i in 0..109 {
            partial_msat.push(b.read_i32le(76.0 + f64::from(i) * 4.0)?);
        }
        Ok(Some(Header {
            sec_size: shift_one(b.read_i16le(30.0)?),
            short_sec_size: shift_one(b.read_i16le(32.0)?),
            sat_size: b.read_i32le(44.0)?,
            dir_sec_id: b.read_i32le(48.0)?,
            short_stream_max: b.read_i32le(56.0)?,
            ssat_sec_id: b.read_i32le(60.0)?,
            ssat_size: b.read_i32le(64.0)?,
            msat_sec_id: b.read_i32le(68.0)?,
            msat_size: b.read_i32le(72.0)?,
            partial_msat,
        }))
    }
}

/// `AllocationTable`: `table[i]` for an index `i` is `None` when `undefined`.
struct AllocationTable {
    table: Vec<i32>,
}

impl AllocationTable {
    /// `getSecIdChain`.
    fn sec_id_chain(&self, start: f64) -> Result<Vec<f64>, Thrown> {
        let mut sec_id = start;
        let mut ids = Vec::new();
        while sec_id > -1.0 {
            if ids.len() > CHAIN_LIMIT {
                return Err(Thrown::Error("doc: a sector chain that never ends".into()));
            }
            ids.push(sec_id);
            let prior = sec_id;
            let next = if sec_id.fract() == 0.0 && sec_id >= 0.0 {
                self.table
                    .get(sec_id as usize)
                    .map(|&value| f64::from(value))
            } else {
                None
            };
            match next {
                Some(value) => sec_id = value,
                None => break,
            }
            if sec_id == prior {
                break;
            }
        }
        Ok(ids)
    }
}

/// A directory entry.
pub struct Entry {
    name: Vec<u16>,
    kind: f64,
    left: f64,
    right: f64,
    storage_dir_id: f64,
    sec_id: f64,
    size: f64,
}

pub struct CompoundDoc<'a> {
    source: &'a [u8],
    header: Header,
    sat: AllocationTable,
    ssat: AllocationTable,
    entries: Vec<Entry>,
    root: usize,
    short_stream_sec_ids: Vec<f64>,
    /// The `streams` of the root storage: name to entry index, the last one set.
    streams: Vec<(Vec<u16>, usize)>,
}

impl<'a> CompoundDoc<'a> {
    /// `OleCompoundDoc.read()`.
    pub fn read(source: &'a [u8]) -> Result<CompoundDoc<'a>, Thrown> {
        // _readHeader
        let mut buffer = [0_u8; 512];
        read_into(source, &mut buffer, 0.0, 512.0, 0.0)?;
        let Some(header) = Header::load(&buffer)? else {
            return Err(Thrown::Error("Not a valid compound document".into()));
        };
        let mut doc = CompoundDoc {
            source,
            header,
            sat: AllocationTable { table: Vec::new() },
            ssat: AllocationTable { table: Vec::new() },
            entries: Vec::new(),
            root: 0,
            short_stream_sec_ids: Vec::new(),
            streams: Vec::new(),
        };
        let msat = doc.read_msat()?;
        doc.sat = doc.load_table(&msat)?;
        // _readSSAT
        let ids = doc.sat.sec_id_chain(doc.header.ssat_sec_id)?;
        if ids.len() as f64 != doc.header.ssat_size {
            return Err(Thrown::Error(
                "Invalid Short Sector Allocation Table".into(),
            ));
        }
        doc.ssat = doc.load_table(&ids)?;
        // _readDirectoryTree
        let dir_ids = doc.sat.sec_id_chain(doc.header.dir_sec_id)?;
        doc.load_directory(&dir_ids)?;
        let root = &doc.entries[doc.root];
        doc.short_stream_sec_ids = doc.sat.sec_id_chain(root.sec_id)?;
        Ok(doc)
    }

    /// `_readMSAT`: `undefined` slots are `None`.
    fn read_msat(&self) -> Result<Vec<f64>, Thrown> {
        let header = &self.header;
        let size = header.sat_size;
        let mut msat: Vec<Option<f64>> = header.partial_msat.iter().map(|&v| Some(v)).collect();
        // `this._MSAT.length = header.SATSize`
        if size < 0.0 || size.fract() != 0.0 || size > 4_294_967_295.0 {
            return Err(Thrown::Range("Invalid array length".into()));
        }
        msat.resize(size as usize, None);
        if size > 109.0 && header.msat_size != 0.0 {
            let mut current = 109.0;
            let mut sec_id = header.msat_sec_id;
            let mut i = 0.0;
            while i < header.msat_size {
                let sector = self.read_sectors(&[sec_id])?;
                let b = Buf::new(&sector);
                let mut s = 0.0;
                while s < header.sec_size - 4.0 {
                    if current >= size {
                        break;
                    }
                    let value = b.read_i32le(s)?;
                    if (current as usize) < msat.len() {
                        msat[current as usize] = Some(value);
                    }
                    current += 1.0;
                    s += 4.0;
                }
                sec_id = b.read_i32le(header.sec_size - 4.0)?;
                i += 1.0;
            }
        }
        // a hole reads as `undefined` in the sector list: NaN
        Ok(msat
            .into_iter()
            .map(|slot| slot.unwrap_or(f64::NAN))
            .collect())
    }

    /// `_readSectors`.
    fn read_sectors(&self, ids: &[f64]) -> Result<Vec<u8>, Thrown> {
        let sec = self.header.sec_size;
        let mut buffer = vec![0_u8; (ids.len() as f64 * sec) as usize];
        for (i, &id) in ids.iter().enumerate() {
            let offset = i as f64 * sec;
            let position = (id + 1.0) * sec;
            read_into(self.source, &mut buffer, offset, sec, position)?;
        }
        Ok(buffer)
    }

    fn load_table(&self, ids: &[f64]) -> Result<AllocationTable, Thrown> {
        let buffer = self.read_sectors(ids)?;
        let b = Buf::new(&buffer);
        let count = buffer.len() / 4;
        let mut table = Vec::with_capacity(count);
        for i in 0..count {
            table.push(b.read_i32le(i as f64 * 4.0)? as i32);
        }
        Ok(AllocationTable { table })
    }

    /// `DirectoryTree.load`.
    fn load_directory(&mut self, ids: &[f64]) -> Result<(), Thrown> {
        let buffer = self.read_sectors(ids)?;
        let b = Buf::new(&buffer);
        let count = buffer.len() / 128;
        let mut entries = Vec::with_capacity(count);
        for i in 0..count {
            let offset = (i * 128) as f64;
            let name_length = (b.read_i16le(64.0 + offset)? - 1.0).max(0.0);
            entries.push(Entry {
                name: b.to_ucs2_range(offset, name_length + offset),
                kind: b.read_i8(66.0 + offset)?,
                left: b.read_i32le(68.0 + offset)?,
                right: b.read_i32le(72.0 + offset)?,
                storage_dir_id: b.read_i32le(76.0 + offset)?,
                sec_id: b.read_i32le(116.0 + offset)?,
                size: b.read_i32le(120.0 + offset)?,
            });
        }
        self.entries = entries;
        // `this._entries.find(...)`: the first root, `undefined` without one
        let Some(root) = self.entries.iter().position(|e| e.kind == ENTRY_TYPE_ROOT) else {
            return Err(Thrown::Type(
                "Cannot read properties of undefined (reading 'storageDirId')".into(),
            ));
        };
        self.root = root;
        self.build_hierarchy(root, true)
    }

    /// `_getChildIds`.
    fn child_ids(&self, storage: usize) -> Result<Vec<usize>, Thrown> {
        let mut ids = Vec::new();
        let at = |id: f64| -> Result<usize, Thrown> {
            if id.fract() == 0.0 && id >= 0.0 && (id as usize) < self.entries.len() {
                Ok(id as usize)
            } else {
                Err(Thrown::Type(
                    "Cannot read properties of undefined (reading 'left')".into(),
                ))
            }
        };
        // `visit` recurses once per sibling: a tree the gate has checked
        let mut pending: Vec<(usize, u8)> = Vec::new();
        let first = self.entries[storage].storage_dir_id;
        if first > -1.0 {
            ids.push(at(first)?);
            pending.push((at(first)?, 0));
        }
        // an explicit stack in the order the recursion visits
        while let Some((entry, stage)) = pending.pop() {
            let e = &self.entries[entry];
            match stage {
                0 => {
                    pending.push((entry, 1));
                    if e.left != LEAF {
                        let child = at(e.left)?;
                        ids.push(child);
                        pending.push((child, 0));
                    }
                }
                _ => {
                    if e.right != LEAF {
                        let child = at(e.right)?;
                        ids.push(child);
                        pending.push((child, 0));
                    }
                }
            }
            if ids.len() > self.entries.len() * 2 + 2 {
                return Err(Thrown::Range("Maximum call stack size exceeded".into()));
            }
        }
        Ok(ids)
    }

    /// `_buildHierarchy`; only the streams of the root are kept.
    fn build_hierarchy(&mut self, storage: usize, is_root: bool) -> Result<(), Thrown> {
        let child_ids = self.child_ids(storage)?;
        let mut storages: Vec<(Vec<u16>, usize)> = Vec::new();
        let mut streams: Vec<(Vec<u16>, usize)> = Vec::new();
        let mut storage_at: std::collections::HashMap<Vec<u16>, usize> =
            std::collections::HashMap::new();
        let mut stream_at: std::collections::HashMap<Vec<u16>, usize> =
            std::collections::HashMap::new();
        let mut proto_storage = false;
        let proto: Vec<u16> = "__proto__".encode_utf16().collect();
        for child_id in child_ids {
            let child = &self.entries[child_id];
            let name = child.name.clone();
            if child.kind == ENTRY_TYPE_STORAGE {
                if name == proto {
                    proto_storage = true;
                } else if let Some(&slot) = storage_at.get(&name) {
                    storages[slot].1 = child_id;
                } else {
                    storage_at.insert(name.clone(), storages.len());
                    storages.push((name.clone(), child_id));
                }
            }
            if child.kind == ENTRY_TYPE_STREAM && name != proto {
                if let Some(&slot) = stream_at.get(&name) {
                    streams[slot].1 = child_id;
                } else {
                    stream_at.insert(name.clone(), streams.len());
                    streams.push((name, child_id));
                }
            }
        }
        if is_root {
            self.streams = streams;
        }
        for (_, child) in storages {
            self.build_hierarchy(child, false)?;
        }
        if proto_storage {
            // the entry set as prototype makes `for...in` visit its `name` first,
            // a string, which a class method may not give a property
            return Err(Thrown::Type(
                "Cannot create property 'storages' on string '__proto__'".into(),
            ));
        }
        Ok(())
    }

    /// `_readSector`, `_readShortSector`.
    fn read_sector(&self, short: bool, id: f64) -> Result<Vec<u8>, Thrown> {
        if !short {
            return self.read_sectors(&[id]);
        }
        let short_size = self.header.short_sec_size;
        let sec_size = self.header.sec_size;
        let mut buffer = vec![0_u8; short_size as usize];
        let stream_offset = id * short_size;
        let index = (stream_offset / sec_size).floor();
        let sec_offset = stream_offset % sec_size;
        let sec_id = if index.fract() == 0.0 && index >= 0.0 {
            self.short_stream_sec_ids.get(index as usize).copied()
        } else {
            None
        };
        let position = match sec_id {
            Some(sec_id) => (sec_id + 1.0) * sec_size + sec_offset,
            None => f64::NAN,
        };
        read_into(self.source, &mut buffer, 0.0, short_size, position)?;
        Ok(buffer)
    }

    /// The bytes of the stream called `name`: what `streamBuffer` of word-extractor
    /// resolves to. A name without an entry is an empty stream.
    pub fn stream(&self, name: &str) -> Result<Vec<u8>, Thrown> {
        let wanted: Vec<u16> = name.encode_utf16().collect();
        let Some(&(_, entry)) = self.streams.iter().find(|(n, _)| *n == wanted) else {
            return Ok(Vec::new());
        };
        let entry = &self.entries[entry];
        let mut bytes = entry.size;
        let short = bytes < self.header.short_stream_max;
        let table = if short { &self.ssat } else { &self.sat };
        let ids = table.sec_id_chain(entry.sec_id)?;
        let mut out: Vec<u8> = Vec::new();
        for id in ids {
            let sector = self.read_sector(short, id)?;
            let mut buffer = Buf::new(&sector);
            if bytes - buffer.len() < 0.0 {
                buffer = buffer.slice(0.0, bytes);
            }
            bytes -= buffer.len();
            out.extend_from_slice(buffer.data);
        }
        Ok(out)
    }
}
