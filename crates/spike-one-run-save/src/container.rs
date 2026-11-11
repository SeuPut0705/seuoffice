//! The zip path both ways share: read the archive, replace one entry, copy
//! every other local record byte for byte.
//!
//! What it refuses rather than rewrites: ZIP64 archives, multi-disk archives,
//! encrypted records, and archives whose central directory offset does not
//! match its position (data prepended after the offsets were written). A
//! prefix before the first record with correct absolute offsets is copied.
//! The replaced entry loses its data descriptor: its sizes go into its local
//! header and flag bit 3 is cleared.

use std::io::{Read, Write};
use std::ops::Range;

use flate2::write::DeflateEncoder;
use flate2::{Compression, Crc};

const LOCAL_SIG: u32 = 0x0403_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
const EOCD_SIG: u32 = 0x0605_4b50;
const ZIP64_LOCATOR_SIG: u32 = 0x0706_4b50;
const DATA_DESCRIPTOR_FLAG: u16 = 1 << 3;

pub struct Record {
    pub name: Vec<u8>,
    /// Central header with its name, extra field and comment.
    central: Range<usize>,
    /// Local header through the data descriptor: up to the next record.
    pub local: Range<usize>,
    data: Range<usize>,
    method: u16,
    pub flags: u16,
}

pub struct Archive<'a> {
    pub bytes: &'a [u8],
    /// In central directory order.
    pub records: Vec<Record>,
    eocd: usize,
}

fn u16_at(bytes: &[u8], at: usize) -> Result<u16, String> {
    bytes
        .get(at..at + 2)
        .map(|b| u16::from_le_bytes([b[0], b[1]]))
        .ok_or_else(|| format!("truncated at {at}"))
}

fn u32_at(bytes: &[u8], at: usize) -> Result<u32, String> {
    bytes
        .get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .ok_or_else(|| format!("truncated at {at}"))
}

fn put_u16(bytes: &mut [u8], at: usize, value: u16) {
    bytes[at..at + 2].copy_from_slice(&value.to_le_bytes());
}

fn put_u32(bytes: &mut [u8], at: usize, value: u32) {
    bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
}

fn offset_u32(value: usize) -> Result<u32, String> {
    u32::try_from(value).map_err(|_| "archive needs ZIP64".to_owned())
}

impl<'a> Archive<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, String> {
        let lowest = bytes.len().saturating_sub(22 + 0xFFFF);
        let eocd = (lowest..=bytes.len().saturating_sub(22))
            .rev()
            .find(|&at| u32_at(bytes, at) == Ok(EOCD_SIG))
            .ok_or("no end of central directory")?;
        if eocd >= 20 && u32_at(bytes, eocd - 20)? == ZIP64_LOCATOR_SIG {
            return Err("ZIP64 archive".to_owned());
        }
        if u16_at(bytes, eocd + 4)? != 0 || u16_at(bytes, eocd + 6)? != 0 {
            return Err("multi-disk archive".to_owned());
        }
        let count = u16_at(bytes, eocd + 10)?;
        let cd_size = u32_at(bytes, eocd + 12)? as usize;
        let cd_start = u32_at(bytes, eocd + 16)? as usize;
        if count == 0xFFFF || cd_start == 0xFFFF_FFFF {
            return Err("ZIP64 archive".to_owned());
        }
        if cd_start + cd_size != eocd {
            return Err("central directory offset does not match its position".to_owned());
        }
        let mut records = Vec::with_capacity(usize::from(count));
        let mut at = cd_start;
        for _ in 0..count {
            if u32_at(bytes, at)? != CENTRAL_SIG {
                return Err(format!("no central header at {at}"));
            }
            let flags = u16_at(bytes, at + 8)?;
            let method = u16_at(bytes, at + 10)?;
            let compressed = u32_at(bytes, at + 20)?;
            let name_len = usize::from(u16_at(bytes, at + 28)?);
            let extra_len = usize::from(u16_at(bytes, at + 30)?);
            let comment_len = usize::from(u16_at(bytes, at + 32)?);
            let local_at = u32_at(bytes, at + 42)?;
            if compressed == 0xFFFF_FFFF || local_at == 0xFFFF_FFFF {
                return Err("ZIP64 record".to_owned());
            }
            if flags & 1 != 0 {
                return Err("encrypted record".to_owned());
            }
            let local_at = local_at as usize;
            if u32_at(bytes, local_at)? != LOCAL_SIG {
                return Err(format!("no local header at {local_at}"));
            }
            let data_start = local_at
                + 30
                + usize::from(u16_at(bytes, local_at + 26)?)
                + usize::from(u16_at(bytes, local_at + 28)?);
            let end = at + 46 + name_len + extra_len + comment_len;
            records.push(Record {
                name: bytes
                    .get(at + 46..at + 46 + name_len)
                    .ok_or("truncated name")?
                    .to_vec(),
                central: at..end,
                local: local_at..0,
                data: data_start..data_start + compressed as usize,
                method,
                flags,
            });
            at = end;
        }
        let mut order: Vec<usize> = (0..records.len()).collect();
        order.sort_by_key(|&i| records[i].local.start);
        for (position, &i) in order.iter().enumerate() {
            let next = order
                .get(position + 1)
                .map_or(cd_start, |&n| records[n].local.start);
            if records[i].data.end > next {
                return Err("overlapping records".to_owned());
            }
            records[i].local.end = next;
        }
        Ok(Self {
            bytes,
            records,
            eocd,
        })
    }

    pub fn find(&self, name: &str) -> Option<usize> {
        self.records.iter().position(|r| r.name == name.as_bytes())
    }

    pub fn local_record(&self, index: usize) -> &'a [u8] {
        &self.bytes[self.records[index].local.clone()]
    }

    pub fn inflate(&self, index: usize) -> Result<Vec<u8>, String> {
        let record = &self.records[index];
        let data = self
            .bytes
            .get(record.data.clone())
            .ok_or("truncated data")?;
        match record.method {
            0 => Ok(data.to_vec()),
            8 => {
                let mut out = Vec::new();
                flate2::read::DeflateDecoder::new(data)
                    .read_to_end(&mut out)
                    .map_err(|e| e.to_string())?;
                Ok(out)
            }
            other => Err(format!("compression method {other}")),
        }
    }

    /// The archive with entry `index` holding `content`, every other local
    /// record copied, and the central directory patched only in offsets and
    /// in the replaced entry's sizes, checksum, method and flags.
    pub fn replace(&self, index: usize, content: &[u8]) -> Result<Vec<u8>, String> {
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(content).map_err(|e| e.to_string())?;
        let deflated = encoder.finish().map_err(|e| e.to_string())?;
        let mut crc = Crc::new();
        crc.update(content);
        let patch_entry = |header: &mut [u8], base: usize| -> Result<(), String> {
            let flags = u16::from_le_bytes([header[base + 6], header[base + 7]]);
            put_u16(header, base + 6, flags & !DATA_DESCRIPTOR_FLAG);
            put_u16(header, base + 8, 8);
            put_u32(header, base + 14, crc.sum());
            put_u32(header, base + 18, offset_u32(deflated.len())?);
            put_u32(header, base + 22, offset_u32(content.len())?);
            Ok(())
        };

        let mut order: Vec<usize> = (0..self.records.len()).collect();
        order.sort_by_key(|&i| self.records[i].local.start);
        let first = order
            .first()
            .map_or(self.eocd, |&i| self.records[i].local.start);
        let mut out = self.bytes[..first].to_vec();
        let mut offsets = vec![0u32; self.records.len()];
        for &i in &order {
            let record = &self.records[i];
            offsets[i] = offset_u32(out.len())?;
            if i == index {
                let mut header = self.bytes[record.local.start..record.data.start].to_vec();
                patch_entry(&mut header, 0)?;
                out.extend_from_slice(&header);
                out.extend_from_slice(&deflated);
            } else {
                out.extend_from_slice(&self.bytes[record.local.clone()]);
            }
        }
        let cd_start = out.len();
        for (i, record) in self.records.iter().enumerate() {
            let mut header = self.bytes[record.central.clone()].to_vec();
            put_u32(&mut header, 42, offsets[i]);
            if i == index {
                // central and local headers differ by two leading fields
                patch_entry(&mut header, 2)?;
            }
            out.extend_from_slice(&header);
        }
        let cd_size = out.len() - cd_start;
        let mut eocd = self.bytes[self.eocd..].to_vec();
        put_u32(&mut eocd, 12, offset_u32(cd_size)?);
        put_u32(&mut eocd, 16, offset_u32(cd_start)?);
        out.extend_from_slice(&eocd);
        Ok(out)
    }
}

/// A docx opened for the experiment: the archive and its main part as text.
pub struct Docx<'a> {
    pub archive: Archive<'a>,
    pub main: usize,
    pub xml: String,
}

pub const MAIN_PART: &str = "word/document.xml";

impl<'a> Docx<'a> {
    pub fn open(bytes: &'a [u8]) -> Result<Self, String> {
        let archive = Archive::parse(bytes)?;
        let main = archive.find(MAIN_PART).ok_or("no word/document.xml")?;
        let xml = String::from_utf8(archive.inflate(main)?)
            .map_err(|_| "word/document.xml is not UTF-8".to_owned())?;
        Ok(Self { archive, main, xml })
    }

    pub fn save(&self, xml: &str) -> Result<Vec<u8>, String> {
        self.archive.replace(self.main, xml.as_bytes())
    }
}
