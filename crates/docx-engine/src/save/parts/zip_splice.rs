//! zip-splice.ts: raw zip splicing for lazy media. Entries are copied between
//! archives as stored bytes, never inflated or re-deflated, so a 1 GB document
//! costs the reads of its XML parts and nothing else.
//!
//! The TypeScript reads archives through a `ByteSource`; a file-backed one
//! (`openZipFile`, a Node file handle) is the host's to open and implements
//! [`ByteSource`] here, so it is not ported. [`BufferSource`] is
//! `bufferSource`. Reads are synchronous.

use std::collections::HashSet;
use std::io::Read;

use flate2::Crc;
use flate2::read::DeflateDecoder;
use jscompat::JsMap;
use ooxml_pkg::{DEFAULT_ZIP_LIMITS, DeclaredPart, ZipLimits, assert_declared_sizes_within_limits};

use crate::lazy_media::{
    LAZY_MEDIA_PLACEHOLDER_BYTES, is_lazy_media_part, lazy_media_hash_of, lazy_media_placeholder,
};

const SIG_LOCAL: u32 = 0x0403_4b50;
const SIG_CENTRAL: u32 = 0x0201_4b50;
const SIG_EOCD: u32 = 0x0605_4b50;
const SIG_ZIP64_LOCATOR: u32 = 0x0706_4b50;
const FLAG_ENCRYPTED: u16 = 0x1;
const FLAG_DATA_DESCRIPTOR: u16 = 0x8;
const FLAG_UTF8: u16 = 0x800;

/// `ZipEntry`: one entry of the central directory.
#[derive(Debug, Clone)]
pub struct ZipEntry {
    pub name: String,
    pub name_bytes: Vec<u8>,
    pub flags: u16,
    pub method: u16,
    pub time: u16,
    pub date: u16,
    pub crc: u32,
    pub csize: u32,
    pub usize: u32,
    pub ver_made: u16,
    pub ver_need: u16,
    pub int_attr: u16,
    pub ext_attr: u32,
    /// first byte of the (compressed) data inside the archive
    pub data_offset: u64,
}

/// `ByteSource`: `size` and `read(offset, length)`. A read past the end
/// answers the bytes there are, as a `subarray` does.
pub trait ByteSource {
    fn size(&self) -> u64;
    fn read(&self, offset: u64, length: u64) -> Result<Vec<u8>, String>;
}

/// `bufferSource`
pub struct BufferSource<'a>(pub &'a [u8]);

impl ByteSource for BufferSource<'_> {
    fn size(&self) -> u64 {
        self.0.len() as u64
    }

    fn read(&self, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        let start = usize::try_from(offset)
            .unwrap_or(usize::MAX)
            .min(self.0.len());
        let end = usize::try_from(offset.saturating_add(length))
            .unwrap_or(usize::MAX)
            .min(self.0.len());
        Ok(self.0[start..end].to_vec())
    }
}

/// `ZipFile`: an archive read through a source, its entries by name.
pub struct ZipFile<S: ByteSource> {
    pub source: S,
    pub entries: JsMap<ZipEntry>,
}

impl<S: ByteSource> ZipFile<S> {
    /// What `openZipFile` does once it has a source: read the entries into a map.
    pub fn open(source: S) -> Result<Self, String> {
        let mut entries = JsMap::new();
        for entry in read_zip_entries(&source, &DEFAULT_ZIP_LIMITS)? {
            entries.set(entry.name.clone(), entry);
        }
        Ok(Self { source, entries })
    }
}

/// What `materializeDocx` asks of the original archive of a hash.
pub trait ZipArchive {
    fn entry(&self, name: &str) -> Option<&ZipEntry>;
    fn read(&self, offset: u64, length: u64) -> Result<Vec<u8>, String>;
}

impl<S: ByteSource> ZipArchive for ZipFile<S> {
    fn entry(&self, name: &str) -> Option<&ZipEntry> {
        self.entries.get(name)
    }

    fn read(&self, offset: u64, length: u64) -> Result<Vec<u8>, String> {
        self.source.read(offset, length)
    }
}

fn u16_at(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

/// `readZipEntries`
pub fn read_zip_entries(src: &dyn ByteSource, limits: &ZipLimits) -> Result<Vec<ZipEntry>, String> {
    let size = src.size();
    let tail_len = size.min(22 + 0xffff);
    let tail = src.read(size - tail_len, tail_len)?;
    let mut eocd: Option<usize> = None;
    if tail.len() >= 22 {
        for i in (0..=tail.len() - 22).rev() {
            if u32_at(&tail, i) == SIG_EOCD {
                eocd = Some(i);
                break;
            }
        }
    }
    let Some(eocd) = eocd else {
        return Err("zip: end of central directory not found".to_owned());
    };
    if eocd >= 20 && u32_at(&tail, eocd - 20) == SIG_ZIP64_LOCATOR {
        return Err("zip: zip64 archives are not supported".to_owned());
    }
    let count = u16_at(&tail, eocd + 10);
    let cd_size = u64::from(u32_at(&tail, eocd + 12));
    let cd_offset = u64::from(u32_at(&tail, eocd + 16));
    if count == 0xffff || cd_size == 0xffff_ffff || cd_offset == 0xffff_ffff {
        return Err("zip: zip64 archives are not supported".to_owned());
    }
    if cd_offset > size || cd_size > size || cd_offset + cd_size > size {
        return Err("zip: corrupt central directory".to_owned());
    }
    let cd = src.read(cd_offset, cd_size)?;
    if (cd.len() as u64) < cd_size {
        return Err("zip: corrupt central directory".to_owned());
    }
    let mut entries: Vec<ZipEntry> = Vec::new();
    let mut pos = 0usize;
    for _ in 0..count {
        if pos + 46 > cd.len() || u32_at(&cd, pos) != SIG_CENTRAL {
            return Err("zip: corrupt central directory".to_owned());
        }
        let flags = u16_at(&cd, pos + 8);
        if flags & FLAG_ENCRYPTED != 0 {
            return Err("zip: encrypted entries are not supported".to_owned());
        }
        let name_len = usize::from(u16_at(&cd, pos + 28));
        let extra_len = usize::from(u16_at(&cd, pos + 30));
        let comment_len = usize::from(u16_at(&cd, pos + 32));
        let name_end = (pos + 46 + name_len).min(cd.len());
        let name_bytes = cd[(pos + 46).min(name_end)..name_end].to_vec();
        let csize = u32_at(&cd, pos + 20);
        let usize_ = u32_at(&cd, pos + 24);
        let local_offset = u32_at(&cd, pos + 42);
        if csize == 0xffff_ffff || usize_ == 0xffff_ffff || local_offset == 0xffff_ffff {
            return Err("zip: zip64 archives are not supported".to_owned());
        }
        let name = if flags & FLAG_UTF8 != 0 {
            String::from_utf8_lossy(&name_bytes).into_owned()
        } else {
            name_bytes.iter().map(|byte| char::from(*byte)).collect()
        };
        entries.push(ZipEntry {
            name,
            name_bytes,
            flags,
            method: u16_at(&cd, pos + 10),
            time: u16_at(&cd, pos + 12),
            date: u16_at(&cd, pos + 14),
            crc: u32_at(&cd, pos + 16),
            csize,
            usize: usize_,
            ver_made: u16_at(&cd, pos + 4),
            ver_need: u16_at(&cd, pos + 6),
            int_attr: u16_at(&cd, pos + 36),
            ext_attr: u32_at(&cd, pos + 38),
            data_offset: u64::from(local_offset),
        });
        pos += 46 + name_len + extra_len + comment_len;
    }
    // The bounded-archive gate the normal parse path applies, run before a
    // single entry is read; directories carry no payload, so they are not counted.
    let declared: Vec<DeclaredPart<'_>> = entries
        .iter()
        .filter(|entry| !entry.name.ends_with('/'))
        .map(|entry| DeclaredPart {
            name: &entry.name,
            usize: f64::from(entry.usize),
        })
        .collect();
    assert_declared_sizes_within_limits(&declared, limits)?;
    // the local header's name/extra lengths may differ from the central copy
    for entry in &mut entries {
        let local = src.read(entry.data_offset, 30)?;
        if local.len() < 30 || u32_at(&local, 0) != SIG_LOCAL {
            return Err(format!("zip: corrupt local header for {}", entry.name));
        }
        entry.data_offset += 30 + u64::from(u16_at(&local, 26)) + u64::from(u16_at(&local, 28));
        // csize is the archive's own word about itself: a declared length past
        // the end must never reach the readers
        if entry.data_offset > size || u64::from(entry.csize) > size - entry.data_offset {
            return Err(format!(
                "zip: entry {} declares {} bytes at {}, outside the {}-byte archive",
                entry.name, entry.csize, entry.data_offset, size
            ));
        }
    }
    Ok(entries)
}

/// `OutEntry`: the metadata of an entry (its `data_offset` is not written) and its stored bytes.
pub struct OutEntry {
    pub meta: ZipEntry,
    pub data: Vec<u8>,
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = Crc::new();
    crc.update(bytes);
    crc.sum()
}

/// `writeZip`: a plain (non-zip64) archive: data descriptors are folded into
/// the headers and extra fields dropped, so every entry is self-describing.
pub fn write_zip(entries: &[OutEntry]) -> Result<Vec<u8>, String> {
    if entries.len() >= 0xffff {
        return Err("zip: too many entries for a plain archive".to_owned());
    }
    let mut chunks: Vec<u8> = Vec::new();
    let mut centrals: Vec<u8> = Vec::new();
    let mut offset: u64 = 0;
    for OutEntry { meta, data } in entries {
        let flags = meta.flags & !FLAG_DATA_DESCRIPTOR;
        let name_len = meta.name_bytes.len() as u16;
        chunks.extend_from_slice(&SIG_LOCAL.to_le_bytes());
        chunks.extend_from_slice(&meta.ver_need.to_le_bytes());
        chunks.extend_from_slice(&flags.to_le_bytes());
        chunks.extend_from_slice(&meta.method.to_le_bytes());
        chunks.extend_from_slice(&meta.time.to_le_bytes());
        chunks.extend_from_slice(&meta.date.to_le_bytes());
        chunks.extend_from_slice(&meta.crc.to_le_bytes());
        chunks.extend_from_slice(&meta.csize.to_le_bytes());
        chunks.extend_from_slice(&meta.usize.to_le_bytes());
        chunks.extend_from_slice(&name_len.to_le_bytes());
        chunks.extend_from_slice(&0u16.to_le_bytes());
        chunks.extend_from_slice(&meta.name_bytes);
        chunks.extend_from_slice(data);
        centrals.extend_from_slice(&SIG_CENTRAL.to_le_bytes());
        centrals.extend_from_slice(&meta.ver_made.to_le_bytes());
        centrals.extend_from_slice(&meta.ver_need.to_le_bytes());
        centrals.extend_from_slice(&flags.to_le_bytes());
        centrals.extend_from_slice(&meta.method.to_le_bytes());
        centrals.extend_from_slice(&meta.time.to_le_bytes());
        centrals.extend_from_slice(&meta.date.to_le_bytes());
        centrals.extend_from_slice(&meta.crc.to_le_bytes());
        centrals.extend_from_slice(&meta.csize.to_le_bytes());
        centrals.extend_from_slice(&meta.usize.to_le_bytes());
        centrals.extend_from_slice(&name_len.to_le_bytes());
        centrals.extend_from_slice(&0u16.to_le_bytes());
        centrals.extend_from_slice(&0u16.to_le_bytes());
        centrals.extend_from_slice(&0u16.to_le_bytes());
        centrals.extend_from_slice(&meta.int_attr.to_le_bytes());
        centrals.extend_from_slice(&meta.ext_attr.to_le_bytes());
        let local_at = u32::try_from(offset)
            .map_err(|_| "zip: archive too large for a plain archive".to_owned())?;
        centrals.extend_from_slice(&local_at.to_le_bytes());
        centrals.extend_from_slice(&meta.name_bytes);
        offset += 30 + meta.name_bytes.len() as u64 + data.len() as u64;
    }
    let cd_size = centrals.len() as u64;
    if offset + cd_size > 0xffff_ffff {
        return Err("zip: archive too large for a plain archive".to_owned());
    }
    let mut out = chunks;
    out.extend_from_slice(&centrals);
    out.extend_from_slice(&SIG_EOCD.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(cd_size as u32).to_le_bytes());
    out.extend_from_slice(&(offset as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

/// `SlimDocx`
pub struct SlimDocx {
    pub bytes: Vec<u8>,
    /// stripped part paths
    pub lazy_parts: Vec<String>,
}

/// `slimDocx`: a copy of the archive with its lazy-media parts replaced by
/// placeholders naming `hash`; None when less than `min_bytes` of media would
/// be stripped. The caller keeps ownership of the source.
pub fn slim_docx<S: ByteSource>(
    zip: &ZipFile<S>,
    hash: &str,
    min_bytes: f64,
) -> Result<Option<SlimDocx>, String> {
    let is_lazy = |entry: &ZipEntry| is_lazy_media_part(&entry.name) && entry.usize > 0;
    let lazy: Vec<&ZipEntry> = zip
        .entries
        .iter()
        .map(|(_, entry)| entry)
        .filter(|e| is_lazy(e))
        .collect();
    let total: f64 = lazy.iter().map(|entry| f64::from(entry.usize)).sum();
    if total < min_bytes {
        return Ok(None);
    }
    let placeholder = lazy_media_placeholder(hash)?;
    let placeholder_crc = crc32(&placeholder);
    let mut out: Vec<OutEntry> = Vec::new();
    for (_, entry) in zip.entries.iter() {
        if is_lazy(entry) {
            let mut meta = entry.clone();
            meta.method = 0;
            meta.crc = placeholder_crc;
            meta.csize = placeholder.len() as u32;
            meta.usize = placeholder.len() as u32;
            out.push(OutEntry {
                meta,
                data: placeholder.clone(),
            });
        } else {
            out.push(OutEntry {
                meta: entry.clone(),
                data: zip.source.read(entry.data_offset, u64::from(entry.csize))?,
            });
        }
    }
    Ok(Some(SlimDocx {
        bytes: write_zip(&out)?,
        lazy_parts: lazy.iter().map(|entry| entry.name.clone()).collect(),
    }))
}

/// `inflated`
fn inflated(entry: &ZipEntry, raw: &[u8]) -> Result<Vec<u8>, String> {
    match entry.method {
        0 => Ok(raw.to_vec()),
        8 => {
            let mut out = Vec::new();
            DeflateDecoder::new(raw)
                .read_to_end(&mut out)
                .map_err(|error| error.to_string())?;
            Ok(out)
        }
        method => Err(format!(
            "zip: unsupported compression method {method} for {}",
            entry.name
        )),
    }
}

/// `placeholderHash`: the placeholder hash when the entry is one, else None.
fn placeholder_hash(entry: &ZipEntry, raw: &[u8]) -> Result<Option<String>, String> {
    if entry.usize as usize != LAZY_MEDIA_PLACEHOLDER_BYTES {
        return Ok(None);
    }
    let bytes = inflated(entry, raw)?;
    Ok(lazy_media_hash_of(&bytes).map(str::to_owned))
}

/// `lazyMediaHashesIn`: the hashes named by the placeholders in a saved
/// archive (empty when none), in order of first appearance.
pub fn lazy_media_hashes_in(bytes: &[u8]) -> Result<Vec<String>, String> {
    let src = BufferSource(bytes);
    let mut hashes: Vec<String> = Vec::new();
    for entry in read_zip_entries(&src, &DEFAULT_ZIP_LIMITS)? {
        let raw = src.read(entry.data_offset, u64::from(entry.csize))?;
        if let Some(hash) = placeholder_hash(&entry, &raw)?
            && !hashes.contains(&hash)
        {
            hashes.push(hash);
        }
    }
    Ok(hashes)
}

/// The result of opening the original archive of a hash.
type SourceOpen = Result<Option<Box<dyn ZipArchive>>, String>;

/// `materializeDocx`: the saved archive with every placeholder swapped back
/// for the original part bytes; the input is returned as it is when it holds
/// no placeholders. `source_for` opens the original archive of a hash (a fresh
/// one per hash; it is dropped when the call ends, the `close` of the TypeScript).
pub fn materialize_docx(
    bytes: &[u8],
    source_for: &mut dyn FnMut(&str) -> SourceOpen,
) -> Result<Vec<u8>, String> {
    let src = BufferSource(bytes);
    let entries = read_zip_entries(&src, &DEFAULT_ZIP_LIMITS)?;
    let mut out: Vec<OutEntry> = Vec::new();
    let mut swapped = false;
    let mut cache: Vec<(String, Option<Box<dyn ZipArchive>>)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for entry in &entries {
        let raw = src.read(entry.data_offset, u64::from(entry.csize))?;
        let Some(hash) = placeholder_hash(entry, &raw)? else {
            out.push(OutEntry {
                meta: entry.clone(),
                data: raw,
            });
            continue;
        };
        if seen.insert(hash.clone()) {
            let source = source_for(&hash)?;
            cache.push((hash.clone(), source));
        }
        let source = cache
            .iter()
            .find(|(cached, _)| *cached == hash)
            .and_then(|(_, source)| source.as_deref());
        let original = source.and_then(|source| source.entry(&entry.name));
        let (Some(source), Some(original)) = (source, original) else {
            return Err(format!("lazy media source unavailable for {}", entry.name));
        };
        let mut meta = original.clone();
        meta.name_bytes = entry.name_bytes.clone();
        out.push(OutEntry {
            meta,
            data: source.read(original.data_offset, u64::from(original.csize))?,
        });
        swapped = true;
    }
    if swapped {
        write_zip(&out)
    } else {
        Ok(bytes.to_vec())
    }
}
