//! Port of the reading half of JSZip 3.10.1 (lib/zipEntries.js, lib/zipEntry.js,
//! lib/reader/DataReader.js, lib/load.js), which is how the TypeScript engine
//! opens a package. A container the engine opens must open here with the same
//! entries, and one JSZip refuses must be refused with the same message, so
//! the reader keeps JSZip's order of reads and its integer arithmetic.

use std::collections::HashSet;

use flate2::{Decompress, FlushDecompress, Status};

use crate::decode_text;

const LOCAL_FILE_HEADER: [u8; 4] = *b"PK\x03\x04";
const CENTRAL_FILE_HEADER: [u8; 4] = *b"PK\x01\x02";
const CENTRAL_DIRECTORY_END: [u8; 4] = *b"PK\x05\x06";
const ZIP64_CENTRAL_DIRECTORY_LOCATOR: [u8; 4] = *b"PK\x06\x07";
const ZIP64_CENTRAL_DIRECTORY_END: [u8; 4] = *b"PK\x06\x06";

const MAX_VALUE_16BITS: i64 = 65535;
/// JSZip reads four 0xFF bytes as -1: its shift is a 32-bit signed one.
const MAX_VALUE_32BITS: i64 = -1;

const MADE_BY_UNIX: i64 = 0x03;

/// The TypeError JSZip 3.10.1 ends a load with when an entry is a folder by
/// its Unix mode alone: V8's wording, since the engine reports it as it is.
const UNIX_DIR_WITHOUT_SLASH: &str = "Cannot set properties of null (setting 'unsafeOriginalName')";

/// The one refusal that is not JSZip's: there it is an endless loop.
pub const ZIP64_EXTENSIBLE_DATA_LOOPS: &str =
    "Corrupted zip: the ZIP64 extensible data does not end";

/// `DataReader` over bytes. Indexes are JavaScript numbers there and go
/// negative on a hostile file, so they are signed here.
struct Reader<'a> {
    data: &'a [u8],
    index: i64,
    /// Offset of the archive inside the data, where bytes were prepended.
    zero: i64,
}

impl<'a> Reader<'a> {
    fn new(data: &'a [u8]) -> Self {
        Self {
            data,
            index: 0,
            zero: 0,
        }
    }

    fn check_index(&self, new_index: i64) -> Result<(), String> {
        if (self.data.len() as i64) < self.zero + new_index || new_index < 0 {
            return Err(format!(
                "End of data reached (data length = {}, asked index = {new_index}). Corrupted zip ?",
                self.data.len()
            ));
        }
        Ok(())
    }

    fn set_index(&mut self, new_index: i64) -> Result<(), String> {
        self.check_index(new_index)?;
        self.index = new_index;
        Ok(())
    }

    fn skip(&mut self, count: i64) -> Result<(), String> {
        self.set_index(self.index + count)
    }

    /// `readInt`: `result = (result << 8) + byte`, where `<<` wraps to 32 bits
    /// and `+` does not.
    fn read_int(&mut self, size: i64) -> Result<i64, String> {
        self.check_index(self.index + size)?;
        let start = (self.zero + self.index) as usize;
        let result = self.data[start..start + size as usize]
            .iter()
            .rev()
            .fold(0i64, |result, byte| {
                i64::from((result as i32).wrapping_shl(8)) + i64::from(*byte)
            });
        self.index += size;
        Ok(result)
    }

    /// `readData`. A negative size passes the check when the index stays in
    /// range: it reads nothing and moves the index back.
    fn read_data(&mut self, size: i64) -> Result<&'a [u8], String> {
        self.check_index(self.index + size)?;
        let start = (self.zero + self.index) as usize;
        let data = if size > 0 {
            &self.data[start..start + size as usize]
        } else {
            &[]
        };
        self.index += size;
        Ok(data)
    }

    fn last_index_of_signature(&self, signature: [u8; 4]) -> Option<i64> {
        self.data
            .windows(4)
            .rposition(|window| window == signature)
            .map(|at| at as i64 - self.zero)
    }

    fn read_and_check_signature(&mut self, signature: [u8; 4]) -> Result<bool, String> {
        Ok(self.read_data(4)? == signature)
    }

    fn check_signature(&mut self, expected: [u8; 4]) -> Result<(), String> {
        if self.read_and_check_signature(expected)? {
            return Ok(());
        }
        self.index -= 4;
        let found = self.read_data(4)?;
        Err(format!(
            "Corrupted zip or bug: unexpected signature ({}, expected {})",
            pretty(found),
            pretty(&expected)
        ))
    }

    fn is_signature(&mut self, asked_index: i64, expected: [u8; 4]) -> Result<bool, String> {
        let current = self.index;
        self.set_index(asked_index)?;
        let result = self.read_data(4)? == expected;
        self.set_index(current)?;
        Ok(result)
    }
}

/// `utils.pretty`: every byte as `\xNN`.
fn pretty(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("\\x{byte:02X}")).collect()
}

/// The CRC-32 of JSZip's crc32.js, as the signed number it returns.
fn crc32(bytes: &[u8]) -> i64 {
    if bytes.is_empty() {
        return 0;
    }
    let mut crc = !0u32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                0xEDB8_8320 ^ (crc >> 1)
            } else {
                crc >> 1
            };
        }
    }
    i64::from(!crc as i32)
}

#[derive(Clone, Copy, PartialEq)]
enum Compression {
    Store,
    Deflate,
}

/// One extra field. A later field of the same id replaces an earlier one.
struct ExtraField<'a> {
    id: i64,
    length: i64,
    value: &'a [u8],
}

#[derive(Default)]
struct ZipEntry<'a> {
    version_made_by: i64,
    bit_flag: i64,
    compression_method: &'a [u8],
    /// the DOS time (low half) and date (high half) of the central directory
    dos_date_time: i64,
    compressed_size: i64,
    uncompressed_size: i64,
    extra_fields_length: i64,
    file_comment_length: i64,
    external_file_attributes: i64,
    local_header_offset: i64,
    extra_fields: Vec<ExtraField<'a>>,
    file_comment: &'a [u8],
    file_name: &'a [u8],
    compressed_content: &'a [u8],
}

impl<'a> ZipEntry<'a> {
    fn extra_field(&self, id: i64) -> Option<&ExtraField<'a>> {
        self.extra_fields.iter().rev().find(|field| field.id == id)
    }

    fn read_central_part(reader: &mut Reader<'a>, zip64: bool) -> Result<Self, String> {
        let _ = zip64;
        let mut entry = Self {
            version_made_by: reader.read_int(2)?,
            ..Self::default()
        };
        reader.skip(2)?;
        entry.bit_flag = reader.read_int(2)?;
        entry.compression_method = reader.read_data(2)?;
        entry.dos_date_time = reader.read_int(4)?;
        // the checksum, which loadAsync does not verify
        reader.read_int(4)?;
        entry.compressed_size = reader.read_int(4)?;
        entry.uncompressed_size = reader.read_int(4)?;
        let file_name_length = reader.read_int(2)?;
        entry.extra_fields_length = reader.read_int(2)?;
        entry.file_comment_length = reader.read_int(2)?;
        // disk number start and internal attributes
        reader.read_int(2)?;
        reader.read_int(2)?;
        entry.external_file_attributes = reader.read_int(4)?;
        entry.local_header_offset = reader.read_int(4)?;

        if entry.bit_flag & 0x0001 == 0x0001 {
            return Err("Encrypted zip are not supported".to_owned());
        }

        // the name is taken from the local header, not from here
        reader.skip(file_name_length)?;
        entry.read_extra_fields(reader)?;
        entry.parse_zip64_extra_field()?;
        entry.file_comment = reader.read_data(entry.file_comment_length)?;
        Ok(entry)
    }

    fn read_extra_fields(&mut self, reader: &mut Reader<'a>) -> Result<(), String> {
        let end = reader.index + self.extra_fields_length;
        while reader.index + 4 < end {
            let id = reader.read_int(2)?;
            let length = reader.read_int(2)?;
            let value = reader.read_data(length)?;
            self.extra_fields.push(ExtraField { id, length, value });
        }
        reader.set_index(end)
    }

    fn parse_zip64_extra_field(&mut self) -> Result<(), String> {
        let Some(field) = self.extra_field(0x0001) else {
            return Ok(());
        };
        let mut extra_reader = Reader::new(field.value);
        if self.uncompressed_size == MAX_VALUE_32BITS {
            self.uncompressed_size = extra_reader.read_int(8)?;
        }
        if self.compressed_size == MAX_VALUE_32BITS {
            self.compressed_size = extra_reader.read_int(8)?;
        }
        if self.local_header_offset == MAX_VALUE_32BITS {
            self.local_header_offset = extra_reader.read_int(8)?;
        }
        Ok(())
    }

    fn read_local_part(&mut self, reader: &mut Reader<'a>) -> Result<Compression, String> {
        reader.skip(22)?;
        let file_name_length = reader.read_int(2)?;
        // the local extra field length may differ from the central one
        let local_extra_fields_length = reader.read_int(2)?;
        self.file_name = reader.read_data(file_name_length)?;
        reader.skip(local_extra_fields_length)?;

        if self.compressed_size == -1 || self.uncompressed_size == -1 {
            return Err(
                "Bug or corrupted zip : didn't get enough information from the central directory \
                 (compressedSize === -1 || uncompressedSize === -1)"
                    .to_owned(),
            );
        }

        let compression = match self.compression_method {
            b"\x00\x00" => Compression::Store,
            b"\x08\x00" => Compression::Deflate,
            other => {
                return Err(format!(
                    "Corrupted zip : compression {} unknown (inner file : {})",
                    pretty(other),
                    self.file_name
                        .iter()
                        .map(|byte| char::from(*byte))
                        .collect::<String>()
                ));
            }
        };
        self.compressed_content = reader.read_data(self.compressed_size)?;
        Ok(compression)
    }

    /// `handleUTF8`: the name as a string. The comment is decoded there too,
    /// and its Unicode extra field can end the load with an error.
    fn file_name_str(&self) -> Result<String, String> {
        if self.bit_flag & 0x0800 == 0x0800 {
            return Ok(decode_text(self.file_name).into_owned());
        }
        let unicode_path = self.unicode_extra_field(0x7075, self.file_name)?;
        self.unicode_extra_field(0x6375, self.file_comment)?;
        Ok(unicode_path.unwrap_or_else(|| decode_text(self.file_name).into_owned()))
    }

    /// `findExtraFieldUnicodePath` and `findExtraFieldUnicodeComment`: the
    /// Info-ZIP field counts when its checksum matches the header bytes.
    fn unicode_extra_field(&self, id: i64, header_bytes: &[u8]) -> Result<Option<String>, String> {
        let Some(field) = self.extra_field(id) else {
            return Ok(None);
        };
        let mut extra_reader = Reader::new(field.value);
        if extra_reader.read_int(1)? != 1 {
            return Ok(None);
        }
        if crc32(header_bytes) != extra_reader.read_int(4)? {
            return Ok(None);
        }
        Ok(Some(
            decode_text(extra_reader.read_data(field.length - 5)?).into_owned(),
        ))
    }

    /// `processAttributes`: a folder by its DOS attribute or by its name.
    fn is_dir(&self, file_name_str: &str) -> bool {
        self.external_file_attributes & 0x0010 != 0 || file_name_str.ends_with('/')
    }

    /// What `fileAdd` makes a folder of besides: an entry written on Unix
    /// whose mode says directory.
    fn has_unix_dir_mode(&self) -> bool {
        self.version_made_by >> 8 == MADE_BY_UNIX
            && (self.external_file_attributes >> 16) & 0x4000 != 0
    }
}

/// `utils.resolve`: the name with `.` and `..` segments resolved, which is
/// what keeps an entry from naming a path outside the package.
fn resolve(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    let mut result: Vec<&str> = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        // the first and the last part may be empty: leading and trailing slashes
        if *part == "." || (part.is_empty() && index != 0 && index != parts.len() - 1) {
            continue;
        } else if *part == ".." {
            result.pop();
        } else {
            result.push(part);
        }
    }
    result.join("/")
}

/// One entry as `loadAsync` adds it to the zip object.
pub struct LoadedEntry {
    pub name: String,
    pub is_dir: bool,
    /// What the central directory declares, as JSZip keeps it. `None` where
    /// JSZip stores an empty string in place of the data (folders and entries
    /// that declare no bytes).
    pub uncompressed_size: Option<f64>,
    /// The content, or what reading it throws.
    pub content: Result<Vec<u8>, String>,
    /// `entry.date` as a time value: JSZip reads the DOS time and date as UTC.
    pub date: f64,
}

/// `DataReader.readDate`: `new Date(Date.UTC(...))` of the DOS fields, each
/// field normalized the way `Date.UTC` carries it (month 13, day 0).
fn dos_time_value(dos: i64) -> f64 {
    let year = ((dos >> 25) & 0x7f) + 1980;
    let month = ((dos >> 21) & 0x0f) - 1;
    let day = (dos >> 16) & 0x1f;
    let (hours, minutes, seconds) = ((dos >> 11) & 0x1f, (dos >> 5) & 0x3f, (dos & 0x1f) << 1);
    // days_from_civil of Howard Hinnant's date algorithms, for the first of the month
    let (y, m) = (year + month.div_euclid(12), month.rem_euclid(12) + 1);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let year_of_era = y - era * 400;
    let day_of_year = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let days = era * 146_097 + day_of_era - 719_468 + day - 1;
    (days * 86_400_000 + hours * 3_600_000 + minutes * 60_000 + seconds * 1000) as f64
}

/// `JSZip.loadAsync(bytes)`: the entries in central directory order.
pub fn load(data: &[u8]) -> Result<Vec<LoadedEntry>, String> {
    let mut reader = Reader::new(data);
    let (central_dir_records, central_dir_offset, zip64) = read_end_of_central(&mut reader)?;

    reader.set_index(central_dir_offset)?;
    let mut files = Vec::new();
    while reader.read_and_check_signature(CENTRAL_FILE_HEADER)? {
        files.push(ZipEntry::read_central_part(&mut reader, zip64)?);
    }
    if central_dir_records != files.len() as i64 && central_dir_records != 0 && files.is_empty() {
        return Err(format!(
            "Corrupted zip or bug: expected {central_dir_records} records in central dir, got 0"
        ));
    }

    // every local header is read before the first entry is added
    let mut read = Vec::with_capacity(files.len());
    for mut file in files {
        reader.set_index(file.local_header_offset)?;
        reader.check_signature(LOCAL_FILE_HEADER)?;
        let compression = file.read_local_part(&mut reader)?;
        let file_name_str = file.file_name_str()?;
        read.push((file, compression, file_name_str));
    }

    let mut loaded = Vec::with_capacity(read.len());
    for (file, compression, file_name_str) in read {
        let is_dir = file.is_dir(&file_name_str);
        if !is_dir && file.has_unix_dir_mode() {
            // JSZip adds the entry as a folder, then looks it up as a file to
            // note its original name, and the lookup answers null
            return Err(UNIX_DIR_WITHOUT_SLASH.to_owned());
        }
        let mut name = resolve(&file_name_str);
        if is_dir && !name.ends_with('/') {
            name.push('/');
        }
        let stored_empty = is_dir || file.uncompressed_size == 0;
        loaded.push(LoadedEntry {
            name,
            is_dir,
            uncompressed_size: (!stored_empty).then_some(file.uncompressed_size as f64),
            date: dos_time_value(file.dos_date_time),
            content: if stored_empty {
                Ok(Vec::new())
            } else {
                content_of(compression, file.compressed_content, file.uncompressed_size)
            },
        });
    }
    Ok(loaded)
}

/// `readEndOfCentral`: the record count, the directory offset and whether the
/// archive is zip64. It also settles the reader's zero.
fn read_end_of_central(reader: &mut Reader<'_>) -> Result<(i64, i64, bool), String> {
    let Some(end_of_central_dir_offset) = reader.last_index_of_signature(CENTRAL_DIRECTORY_END)
    else {
        // a truncated zip or complete garbage: a local header at the start hints
        return Err(if reader.is_signature(0, LOCAL_FILE_HEADER)? {
            "Corrupted zip: can't find end of central directory".to_owned()
        } else {
            "Can't find end of central directory : is this a zip file ? \
             If it is, see https://stuk.github.io/jszip/documentation/howto/read_zip.html"
                .to_owned()
        });
    };
    reader.set_index(end_of_central_dir_offset)?;
    reader.check_signature(CENTRAL_DIRECTORY_END)?;
    let disk_number = reader.read_int(2)?;
    let disk_with_central_dir_start = reader.read_int(2)?;
    let central_dir_records_on_this_disk = reader.read_int(2)?;
    let mut central_dir_records = reader.read_int(2)?;
    let mut central_dir_size = reader.read_int(4)?;
    let mut central_dir_offset = reader.read_int(4)?;
    let zip_comment_length = reader.read_int(2)?;
    reader.read_data(zip_comment_length)?;

    let zip64 = disk_number == MAX_VALUE_16BITS
        || disk_with_central_dir_start == MAX_VALUE_16BITS
        || central_dir_records_on_this_disk == MAX_VALUE_16BITS
        || central_dir_records == MAX_VALUE_16BITS
        || central_dir_size == MAX_VALUE_32BITS
        || central_dir_offset == MAX_VALUE_32BITS;
    let mut zip64_end_of_central_size = 0;
    if zip64 {
        let Some(locator) = reader.last_index_of_signature(ZIP64_CENTRAL_DIRECTORY_LOCATOR) else {
            return Err(
                "Corrupted zip: can't find the ZIP64 end of central directory locator".to_owned(),
            );
        };
        reader.set_index(locator)?;
        reader.check_signature(ZIP64_CENTRAL_DIRECTORY_LOCATOR)?;
        // the disk with the zip64 directory
        reader.read_int(4)?;
        let mut relative_offset_end_of_zip64_central_dir = reader.read_int(8)?;
        let disks_count = reader.read_int(4)?;
        if disks_count > 1 {
            return Err("Multi-volumes zip are not supported".to_owned());
        }

        if !reader.is_signature(
            relative_offset_end_of_zip64_central_dir,
            ZIP64_CENTRAL_DIRECTORY_END,
        )? {
            relative_offset_end_of_zip64_central_dir = reader
                .last_index_of_signature(ZIP64_CENTRAL_DIRECTORY_END)
                .ok_or("Corrupted zip: can't find the ZIP64 end of central directory")?;
        }
        reader.set_index(relative_offset_end_of_zip64_central_dir)?;
        reader.check_signature(ZIP64_CENTRAL_DIRECTORY_END)?;
        zip64_end_of_central_size = reader.read_int(8)?;
        reader.skip(4)?;
        // the disk numbers and the records on this disk
        reader.read_int(4)?;
        reader.read_int(4)?;
        reader.read_int(8)?;
        central_dir_records = reader.read_int(8)?;
        central_dir_size = reader.read_int(8)?;
        central_dir_offset = reader.read_int(8)?;
        // the extensible data: JSZip's loop never advances its counter, so it
        // reads fields until a read runs past the data and fails. A negative
        // field length moves the reader back, and what a field does depends
        // on where it starts alone: a start seen before means JSZip reads the
        // same fields for ever. That is refused here; every other path ends
        // in JSZip's own error.
        if zip64_end_of_central_size - 44 > 0 {
            let mut field_starts = HashSet::new();
            while field_starts.insert(reader.index) {
                reader.read_int(2)?;
                let extra_field_length = reader.read_int(4)?;
                reader.read_data(extra_field_length)?;
            }
            return Err(ZIP64_EXTENSIBLE_DATA_LOOPS.to_owned());
        }
    }

    let mut expected_end_of_central_dir_offset = central_dir_offset + central_dir_size;
    if zip64 {
        // the locator, and the record without its leading 12 bytes
        expected_end_of_central_dir_offset += 20 + 12 + zip64_end_of_central_size;
    }
    let extra_bytes = end_of_central_dir_offset - expected_end_of_central_dir_offset;
    if extra_bytes > 0 {
        // JSZip keeps the offsets when a central header sits at the end of
        // central directory offset, which holds the other signature
        if !reader.is_signature(end_of_central_dir_offset, CENTRAL_FILE_HEADER)? {
            // data was prepended: move the zero of the reader
            reader.zero = extra_bytes;
        }
    } else if extra_bytes < 0 {
        return Err(format!(
            "Corrupted zip: missing {} bytes.",
            extra_bytes.abs()
        ));
    }
    Ok((central_dir_records, central_dir_offset, zip64))
}

/// What reading the entry gives: `CompressedObject.getContentWorker`. The
/// only check is the length; JSZip does not look at the inflater's status.
fn content_of(
    compression: Compression,
    compressed: &[u8],
    uncompressed_size: i64,
) -> Result<Vec<u8>, String> {
    let content = match compression {
        Compression::Store => compressed.to_vec(),
        Compression::Deflate => inflate_as_pako(compressed, uncompressed_size),
    };
    if content.len() as i64 == uncompressed_size {
        Ok(content)
    } else {
        Err("Bug : uncompressed data size mismatch".to_owned())
    }
}

/// The bytes pako hands to JSZip for a raw deflate stream. Output leaves in
/// 64 KiB chunks and the last, partial chunk leaves when the stream ends: a
/// stream that is damaged or cut short loses the chunk it was filling. Bytes
/// after the end of the stream are ignored.
fn inflate_as_pako(compressed: &[u8], uncompressed_size: i64) -> Vec<u8> {
    const CHUNK: usize = 65536;
    // past this the length cannot match any more
    let give_up = usize::try_from(uncompressed_size).unwrap_or(0) + CHUNK;
    let mut inflater = Decompress::new(false);
    let mut out = Vec::new();
    let mut emitted = 0;
    let mut input = compressed;
    let mut chunk = vec![0u8; CHUNK];
    loop {
        let filled = out.len() - emitted;
        let (in_before, out_before) = (inflater.total_in(), inflater.total_out());
        let status = inflater.decompress(input, &mut chunk[filled..], FlushDecompress::None);
        let consumed = (inflater.total_in() - in_before) as usize;
        let produced = (inflater.total_out() - out_before) as usize;
        input = &input[consumed..];
        if status.is_ok() {
            out.extend_from_slice(&chunk[filled..filled + produced]);
            if out.len() - emitted == CHUNK {
                emitted = out.len();
            }
        }
        match status {
            Ok(Status::StreamEnd) => return out,
            Ok(_) if consumed + produced > 0 && out.len() <= give_up => {}
            _ => {
                out.truncate(emitted);
                return out;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::thread;
    use std::time::Duration;

    use super::*;

    /// An archive without entries that JSZip reads as ZIP64, with `extensible`
    /// as the extensible data of its ZIP64 end record.
    fn zip64_with_extensible_data(extensible: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        // the ZIP64 end record at offset 0: its size, then 44 bytes of
        // versions, disks, counts, and the size and offset of no directory
        bytes.extend_from_slice(&ZIP64_CENTRAL_DIRECTORY_END);
        bytes.extend_from_slice(&(44 + extensible.len() as u64).to_le_bytes());
        bytes.extend_from_slice(&[0; 44]);
        bytes.extend_from_slice(extensible);
        // its locator: disk 0, the record at offset 0, one disk
        bytes.extend_from_slice(&ZIP64_CENTRAL_DIRECTORY_LOCATOR);
        bytes.extend_from_slice(&[0; 12]);
        bytes.extend_from_slice(&1u32.to_le_bytes());
        // the end record: a disk number of 0xffff is what says ZIP64
        bytes.extend_from_slice(&CENTRAL_DIRECTORY_END);
        bytes.extend_from_slice(&[0xff, 0xff]);
        bytes.extend_from_slice(&[0; 16]);
        bytes
    }

    /// `load` on another thread: a reader that never returns must fail the
    /// test, not hang the run.
    fn load_in_time(bytes: Vec<u8>) -> Result<usize, String> {
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let _ = sender.send(load(&bytes).map(|entries| entries.len()));
        });
        receiver
            .recv_timeout(Duration::from_secs(5))
            .expect("the reader returns")
    }

    #[test]
    fn extensible_data_that_leads_back_to_itself_is_refused() {
        // a field of length -6 ends where it began
        let one_field = [1, 0, 0xfa, 0xff, 0xff, 0xff];
        // a field of length 0, then one of length -12 that ends at the first
        let two_fields = [1, 0, 0, 0, 0, 0, 2, 0, 0xf4, 0xff, 0xff, 0xff];
        // three fields: the last one goes back to the second
        let back_to_the_second = [
            1, 0, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 9, 3, 0, 0xf3, 0xff, 0xff, 0xff,
        ];
        for extensible in [&one_field[..], &two_fields, &back_to_the_second] {
            assert_eq!(
                load_in_time(zip64_with_extensible_data(extensible)),
                Err(ZIP64_EXTENSIBLE_DATA_LOOPS.to_owned()),
                "{extensible:?}"
            );
        }
    }

    #[test]
    fn extensible_data_that_runs_off_the_end_fails_as_in_jszip() {
        // JSZip never leaves its loop: after this field it reads the locator
        // as the next one, and that read runs past the data
        let error = load_in_time(zip64_with_extensible_data(&[1, 0, 2, 0, 0, 0, 7, 7]))
            .expect_err("JSZip throws");
        assert!(error.starts_with("End of data reached"), "{error}");
    }

    #[test]
    fn a_zip64_record_without_extensible_data_opens() {
        assert_eq!(load_in_time(zip64_with_extensible_data(&[])), Ok(0));
    }
}
