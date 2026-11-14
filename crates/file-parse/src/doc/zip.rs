//! yauzl 2.10.0 over `fromBuffer`, as far as `open-office-extractor.js` uses
//! it: the central directory with its checks, `openReadStream`, and what comes
//! out of the stream: the bytes as the parser reads them (stored, or
//! inflated by Node's zlib in 16 KiB calls and checked by
//! `AssertByteCountStream`).
//!
//! Positions and sizes are JavaScript numbers (`f64`): a ZIP64 field is a
//! double. A read goes through `BufferSlicer.read`, which copies with
//! `Buffer.copy`, so a position past the file is the RangeError of `copy`.
//!
//! Not matched: a read at exactly the end of the file gives yauzl a buffer of
//! uninitialised memory (here zeros), and a read past it throws inside a
//! callback of a later turn, which ends the Node process.

use super::buffer::{Buf, copy};
use crate::compound_gate::Thrown;
use flate2::{Decompress, FlushDecompress, Status};

const CP437: &str = "\u{0}\u{263a}\u{263b}\u{2665}\u{2666}\u{2663}\u{2660}\u{2022}\u{25d8}\u{25cb}\u{25d9}\u{2642}\u{2640}\u{266a}\u{266b}\u{263c}\u{25ba}\u{25c4}\u{2195}\u{203c}\u{b6}\u{a7}\u{25ac}\u{21a8}\u{2191}\u{2193}\u{2192}\u{2190}\u{221f}\u{2194}\u{25b2}\u{25bc} !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~\u{2302}\u{c7}\u{fc}\u{e9}\u{e2}\u{e4}\u{e0}\u{e5}\u{e7}\u{ea}\u{eb}\u{e8}\u{ef}\u{ee}\u{ec}\u{c4}\u{c5}\u{c9}\u{e6}\u{c6}\u{f4}\u{f6}\u{f2}\u{fb}\u{f9}\u{ff}\u{d6}\u{dc}\u{a2}\u{a3}\u{a5}\u{20a7}\u{192}\u{e1}\u{ed}\u{f3}\u{fa}\u{f1}\u{d1}\u{aa}\u{ba}\u{bf}\u{2310}\u{ac}\u{bd}\u{bc}\u{a1}\u{ab}\u{bb}\u{2591}\u{2592}\u{2593}\u{2502}\u{2524}\u{2561}\u{2562}\u{2556}\u{2555}\u{2563}\u{2551}\u{2557}\u{255d}\u{255c}\u{255b}\u{2510}\u{2514}\u{2534}\u{252c}\u{251c}\u{2500}\u{253c}\u{255e}\u{255f}\u{255a}\u{2554}\u{2569}\u{2566}\u{2560}\u{2550}\u{256c}\u{2567}\u{2568}\u{2564}\u{2565}\u{2559}\u{2558}\u{2552}\u{2553}\u{256b}\u{256a}\u{2518}\u{250c}\u{2588}\u{2584}\u{258c}\u{2590}\u{2580}\u{3b1}\u{df}\u{393}\u{3c0}\u{3a3}\u{3c3}\u{b5}\u{3c4}\u{3a6}\u{398}\u{3a9}\u{3b4}\u{221e}\u{3c6}\u{3b5}\u{2229}\u{2261}\u{b1}\u{2265}\u{2264}\u{2320}\u{2321}\u{f7}\u{2248}\u{b0}\u{2219}\u{b7}\u{221a}\u{207f}\u{b2}\u{25a0}\u{a0}";

/// The size of the buffer Node's zlib writes into.
const ZLIB_CHUNK: usize = 16384;
/// The longest slice of the file `BufferSlicer` writes at once.
const SLICE_CHUNK: usize = 0x10000;

fn error(message: impl Into<String>) -> Thrown {
    Thrown::Error(message.into())
}

fn number(value: f64) -> String {
    jscompat::number_to_string(value)
}

/// `reader.read` through `readAndAssertNoEof`: `length` bytes at `position`.
fn read_and_assert_no_eof(data: &[u8], length: usize, position: f64) -> Result<Vec<u8>, Thrown> {
    if length == 0 {
        return Ok(Vec::new());
    }
    let mut buffer = vec![0_u8; length];
    let end = position + length as f64;
    let delta = end - data.len() as f64;
    let written = if delta > 0.0 { delta } else { length as f64 };
    copy(data, &mut buffer, 0.0, position, end)?;
    if written < length as f64 {
        return Err(error("unexpected EOF"));
    }
    Ok(buffer)
}

/// `readUInt64LE`.
fn read_u64le(buffer: Buf<'_>, offset: f64) -> Result<f64, Thrown> {
    let lower = buffer.read_u32le(offset)?;
    let upper = buffer.read_u32le(offset + 4.0)?;
    Ok(upper * 4_294_967_296.0 + lower)
}

/// `decodeBuffer`.
fn decode_buffer(bytes: &[u8], utf8: bool) -> String {
    if utf8 {
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        let table: Vec<char> = CP437.chars().collect();
        bytes.iter().map(|&byte| table[byte as usize]).collect()
    }
}

/// `buffer-crc32`'s `unsigned`.
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffff_u32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

#[derive(Debug, Clone)]
pub struct Entry {
    pub file_name: String,
    general_purpose_bit_flag: u32,
    compression_method: u32,
    compressed_size: f64,
    uncompressed_size: f64,
    relative_offset_of_local_header: f64,
}

impl Entry {
    fn is_encrypted(&self) -> bool {
        self.general_purpose_bit_flag & 0x1 != 0
    }
}

/// `validateFileName`.
fn validate_file_name(name: &str) -> Option<String> {
    if name.contains('\\') {
        return Some(format!("invalid characters in fileName: {name}"));
    }
    let bytes = name.as_bytes();
    if (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
        || name.starts_with('/')
    {
        return Some(format!("absolute path: {name}"));
    }
    if name.split('/').any(|part| part == "..") {
        return Some(format!("invalid relative path: {name}"));
    }
    None
}

/// An opened zip: its entries in central directory order.
pub struct ZipFile<'a> {
    data: &'a [u8],
    pub entries: Vec<Entry>,
}

/// Where the bytes of an entry come from.
pub enum EntryData<'a> {
    /// An empty stream: the parser sees no data and then the end.
    Empty,
    Stored(&'a [u8]),
    Deflated {
        compressed: &'a [u8],
        uncompressed_size: f64,
    },
}

/// What the parser's `readable` handler gets: the pieces of the stream, then
/// either its end or the error it ended with.
pub struct Delivery {
    pub chunks: Vec<Vec<u8>>,
    pub end: Result<(), Thrown>,
}

impl<'a> ZipFile<'a> {
    /// `yauzl.fromBuffer(buffer, { lazyEntries: true })` and every `readEntry`.
    pub fn open(data: &'a [u8]) -> Result<ZipFile<'a>, Thrown> {
        let total_size = data.len();
        let eocdr_without_comment = 22_usize;
        let buffer_size = (eocdr_without_comment + 0xffff).min(total_size);
        let buffer_read_start = (total_size - buffer_size) as f64;
        let buffer = read_and_assert_no_eof(data, buffer_size, buffer_read_start)?;
        let b = Buf::new(&buffer);
        let mut i = buffer_size as i64 - eocdr_without_comment as i64;
        while i >= 0 {
            let at = i as f64;
            i -= 1;
            if b.read_u32le(at)? != f64::from(0x0605_4b50_u32) {
                continue;
            }
            let eocdr = Buf::new(&buffer[at as usize..]);
            let disk_number = eocdr.read_u16le(4.0)?;
            if disk_number != 0.0 {
                return Err(error(format!(
                    "multi-disk zip files are not supported: found disk number: {}",
                    number(disk_number)
                )));
            }
            let mut entry_count = eocdr.read_u16le(10.0)?;
            let mut central_directory_offset = eocdr.read_u32le(16.0)?;
            let comment_length = eocdr.read_u16le(20.0)?;
            let expected = eocdr.len() - eocdr_without_comment as f64;
            if comment_length != expected {
                return Err(error(format!(
                    "invalid comment length. expected: {}. found: {}",
                    number(expected),
                    number(comment_length)
                )));
            }
            if !(entry_count == 65535.0 || central_directory_offset == 4_294_967_295.0) {
                return Self::read_entries(data, central_directory_offset, entry_count);
            }
            // ZIP64
            let locator_offset = buffer_read_start + at - 20.0;
            let locator = read_and_assert_no_eof(data, 20, locator_offset)?;
            let locator = Buf::new(&locator);
            if locator.read_u32le(0.0)? != f64::from(0x0706_4b50_u32) {
                return Err(error(
                    "invalid zip64 end of central directory locator signature",
                ));
            }
            let zip64_eocdr_offset = read_u64le(locator, 8.0)?;
            let record = read_and_assert_no_eof(data, 56, zip64_eocdr_offset)?;
            let record = Buf::new(&record);
            if record.read_u32le(0.0)? != f64::from(0x0606_4b50_u32) {
                return Err(error(
                    "invalid zip64 end of central directory record signature",
                ));
            }
            entry_count = read_u64le(record, 32.0)?;
            central_directory_offset = read_u64le(record, 48.0)?;
            return Self::read_entries(data, central_directory_offset, entry_count);
        }
        Err(error("end of central directory record signature not found"))
    }

    fn read_entries(
        data: &'a [u8],
        central_directory_offset: f64,
        entry_count: f64,
    ) -> Result<ZipFile<'a>, Thrown> {
        let mut cursor = central_directory_offset;
        let mut entries = Vec::new();
        let mut entries_read = 0.0;
        while entry_count != entries_read {
            let header = read_and_assert_no_eof(data, 46, cursor)?;
            let b = Buf::new(&header);
            let signature = b.read_u32le(0.0)?;
            if signature != f64::from(0x0201_4b50_u32) {
                return Err(error(format!(
                    "invalid central directory file header signature: 0x{}",
                    jscompat::to_string_radix16(signature)
                )));
            }
            let flags = b.read_u16le(8.0)? as u32;
            let compression_method = b.read_u16le(10.0)? as u32;
            let mut compressed_size = b.read_u32le(20.0)?;
            let mut uncompressed_size = b.read_u32le(24.0)?;
            let file_name_length = b.read_u16le(28.0)?;
            let extra_field_length = b.read_u16le(30.0)?;
            let file_comment_length = b.read_u16le(32.0)?;
            let mut relative_offset = b.read_u32le(42.0)?;
            if flags & 0x40 != 0 {
                return Err(error("strong encryption is not supported"));
            }
            cursor += 46.0;

            let var_length = (file_name_length + extra_field_length + file_comment_length) as usize;
            let var = read_and_assert_no_eof(data, var_length, cursor)?;
            let is_utf8 = flags & 0x800 != 0;
            let name_bytes = &var[..file_name_length as usize];
            let mut file_name = decode_buffer(name_bytes, is_utf8);

            let file_comment_start = (file_name_length + extra_field_length) as usize;
            let extra = &var[file_name_length as usize..file_comment_start];
            let mut extra_fields: Vec<(u32, Vec<u8>)> = Vec::new();
            let mut at = 0_usize;
            while at + 3 < extra.len() {
                let id = u32::from(u16::from_le_bytes([extra[at], extra[at + 1]]));
                let size = usize::from(u16::from_le_bytes([extra[at + 2], extra[at + 3]]));
                let data_start = at + 4;
                let data_end = data_start + size;
                if data_end > extra.len() {
                    return Err(error("extra field length exceeds extra field buffer size"));
                }
                extra_fields.push((id, extra[data_start..data_end].to_vec()));
                at = data_end;
            }
            cursor += var.len() as f64;
            entries_read += 1.0;

            if uncompressed_size == 4_294_967_295.0
                || compressed_size == 4_294_967_295.0
                || relative_offset == 4_294_967_295.0
            {
                let Some((_, zip64)) = extra_fields.iter().find(|(id, _)| *id == 0x0001) else {
                    return Err(error("expected zip64 extended information extra field"));
                };
                let z = Buf::new(zip64);
                let mut index = 0.0;
                if uncompressed_size == 4_294_967_295.0 {
                    if index + 8.0 > z.len() {
                        return Err(error(
                            "zip64 extended information extra field does not include uncompressed size",
                        ));
                    }
                    uncompressed_size = read_u64le(z, index)?;
                    index += 8.0;
                }
                if compressed_size == 4_294_967_295.0 {
                    if index + 8.0 > z.len() {
                        return Err(error(
                            "zip64 extended information extra field does not include compressed size",
                        ));
                    }
                    compressed_size = read_u64le(z, index)?;
                    index += 8.0;
                }
                if relative_offset == 4_294_967_295.0 {
                    if index + 8.0 > z.len() {
                        return Err(error(
                            "zip64 extended information extra field does not include relative header offset",
                        ));
                    }
                    relative_offset = read_u64le(z, index)?;
                }
            }

            // Info-ZIP Unicode Path Extra Field
            for (id, field) in &extra_fields {
                if *id != 0x7075 {
                    continue;
                }
                if field.len() < 6 || field[0] != 1 {
                    continue;
                }
                let old_crc = u32::from_le_bytes([field[1], field[2], field[3], field[4]]);
                if crc32(name_bytes) != old_crc {
                    continue;
                }
                file_name = decode_buffer(&field[5..], true);
                break;
            }

            let entry = Entry {
                file_name: String::new(),
                general_purpose_bit_flag: flags,
                compression_method,
                compressed_size,
                uncompressed_size,
                relative_offset_of_local_header: relative_offset,
            };
            if compression_method == 0 {
                let mut expected = uncompressed_size;
                if entry.is_encrypted() {
                    expected += 12.0;
                }
                if compressed_size != expected {
                    return Err(error(format!(
                        "compressed/uncompressed size mismatch for stored file: {} != {}",
                        number(compressed_size),
                        number(uncompressed_size)
                    )));
                }
            }
            let file_name = file_name.replace('\\', "/");
            if let Some(message) = validate_file_name(&file_name) {
                return Err(error(message));
            }
            entries.push(Entry { file_name, ..entry });
        }
        Ok(ZipFile { data, entries })
    }

    /// `openReadStream(entry, callback)`: where the stream's bytes come from.
    pub fn open_read_stream(&self, entry: &Entry) -> Result<EntryData<'a>, Thrown> {
        if entry.is_encrypted() {
            return Err(error("entry is encrypted, and options.decrypt !== false"));
        }
        let header = read_and_assert_no_eof(self.data, 30, entry.relative_offset_of_local_header)?;
        let b = Buf::new(&header);
        let signature = b.read_u32le(0.0)?;
        if signature != f64::from(0x0403_4b50_u32) {
            return Err(error(format!(
                "invalid local file header signature: 0x{}",
                jscompat::to_string_radix16(signature)
            )));
        }
        let file_name_length = b.read_u16le(26.0)?;
        let extra_field_length = b.read_u16le(28.0)?;
        let local_file_header_end =
            entry.relative_offset_of_local_header + 30.0 + file_name_length + extra_field_length;
        let decompress = match entry.compression_method {
            0 => false,
            8 => true,
            other => return Err(error(format!("unsupported compression method: {other}"))),
        };
        let file_data_start = local_file_header_end;
        let file_data_end = file_data_start + entry.compressed_size;
        let file_size = self.data.len() as f64;
        if entry.compressed_size != 0.0 && file_data_end > file_size {
            return Err(error(format!(
                "file data overflows file bounds: {} + {} > {}",
                number(file_data_start),
                number(entry.compressed_size),
                number(file_size)
            )));
        }
        if file_data_start == file_data_end {
            return Ok(if decompress {
                EntryData::Deflated {
                    compressed: &[],
                    uncompressed_size: entry.uncompressed_size,
                }
            } else {
                EntryData::Empty
            });
        }
        let slice = &self.data[file_data_start as usize..file_data_end as usize];
        Ok(if decompress {
            EntryData::Deflated {
                compressed: slice,
                uncompressed_size: entry.uncompressed_size,
            }
        } else {
            EntryData::Stored(slice)
        })
    }
}

impl EntryData<'_> {
    /// What the stream of the entry delivers, in the order it does.
    pub fn deliver(&self) -> Delivery {
        match self {
            EntryData::Empty => Delivery {
                chunks: Vec::new(),
                end: Ok(()),
            },
            EntryData::Stored(bytes) => Delivery {
                chunks: bytes.chunks(SLICE_CHUNK).map(<[u8]>::to_vec).collect(),
                end: Ok(()),
            },
            EntryData::Deflated {
                compressed,
                uncompressed_size,
            } => inflate(compressed, *uncompressed_size),
        }
    }
}

/// `zlib.createInflateRaw()` fed in chunks of the read stream, and the
/// `AssertByteCountStream` after it.
fn inflate(compressed: &[u8], expected: f64) -> Delivery {
    let mut produced: Vec<Vec<u8>> = Vec::new();
    let end = run_inflate(compressed, expected, &mut produced);
    let mut chunks = Vec::new();
    let mut actual = 0.0;
    for chunk in produced {
        actual += chunk.len() as f64;
        if actual > expected {
            return Delivery {
                chunks,
                end: Err(error(format!(
                    "too many bytes in the stream. expected {}. got at least {}",
                    number(expected),
                    number(actual)
                ))),
            };
        }
        chunks.push(chunk);
    }
    let end = end.and_then(|()| {
        if actual < expected {
            Err(error(format!(
                "not enough bytes in the stream. expected {}. got only {}",
                number(expected),
                number(actual)
            )))
        } else {
            Ok(())
        }
    });
    Delivery { chunks, end }
}

/// The calls Node's zlib makes, each with the output space left in its
/// 16 KiB buffer; what a call produces is pushed, and a call that fails
/// pushes nothing. It stops once the output passes `limit`, as the byte count
/// stream after it fails on the first chunk that does.
fn run_inflate(compressed: &[u8], limit: f64, pushed: &mut Vec<Vec<u8>>) -> Result<(), Thrown> {
    let mut total = 0.0_f64;
    let mut decoder = Decompress::new(false);
    let mut offset = 0_usize;
    let mut ended = false;
    let mut call = |decoder: &mut Decompress,
                    input: &[u8],
                    flush: FlushDecompress,
                    offset: &mut usize,
                    total: &mut f64|
     -> Result<(usize, usize, Status, usize), Thrown> {
        let space = ZLIB_CHUNK - *offset;
        let mut buffer = vec![0_u8; space];
        let (before_in, before_out) = (decoder.total_in(), decoder.total_out());
        let status = decoder
            .decompress(input, &mut buffer, flush)
            .map_err(|failure| error(zlib_message(compressed, failure.message())))?;
        let consumed = (decoder.total_in() - before_in) as usize;
        let made = (decoder.total_out() - before_out) as usize;
        if made > 0 {
            buffer.truncate(made);
            pushed.push(buffer);
            *total += made as f64;
            *offset += made;
            if *offset >= ZLIB_CHUNK {
                *offset = 0;
            }
        }
        Ok((consumed, made, status, space - made))
    };
    for chunk in compressed.chunks(SLICE_CHUNK) {
        if ended {
            break;
        }
        let mut input = chunk;
        loop {
            let (consumed, _, status, space_after) = call(
                &mut decoder,
                input,
                FlushDecompress::None,
                &mut offset,
                &mut total,
            )?;
            if total > limit {
                return Ok(());
            }
            input = &input[consumed..];
            if space_after == 0 {
                continue;
            }
            // the library wants no more input: the stream ends here
            if !input.is_empty() {
                ended = true;
            }
            let _ = status;
            break;
        }
    }
    if ended {
        return Ok(());
    }
    // the flush: no input, and the end of the stream asked for
    loop {
        let (_, _, status, space_after) = call(
            &mut decoder,
            &[],
            FlushDecompress::Finish,
            &mut offset,
            &mut total,
        )?;
        if total > limit {
            return Ok(());
        }
        if space_after == 0 {
            continue;
        }
        if status != Status::StreamEnd {
            return Err(error("unexpected end of file"));
        }
        return Ok(());
    }
}

/// The message zlib gives for the failed stream. zlib-rs replaces the message
/// of an error found by its fast path with `repeated call with bad state`; fed
/// byte by byte it stays on the slow path, which keeps the message.
fn zlib_message(compressed: &[u8], message: Option<&str>) -> String {
    const REPEATED: &str = "repeated call with bad state";
    if message != Some(REPEATED) {
        return message.unwrap_or("Zlib error").to_owned();
    }
    let mut decoder = Decompress::new(false);
    let mut out = vec![0_u8; ZLIB_CHUNK];
    for byte in compressed {
        let mut input = std::slice::from_ref(byte);
        loop {
            let before = decoder.total_in();
            match decoder.decompress(input, &mut out, FlushDecompress::None) {
                Err(failure) => return failure.message().unwrap_or(REPEATED).to_owned(),
                Ok(Status::StreamEnd) => return REPEATED.to_owned(),
                Ok(_) => {}
            }
            input = &input[(decoder.total_in() - before) as usize..];
            if input.is_empty() {
                break;
            }
        }
    }
    REPEATED.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{Compress, Compression, FlushCompress};

    #[test]
    fn a_stream_past_its_declared_size_stops_at_the_first_chunk_over() {
        let plain = vec![0_u8; 50_000_000];
        let mut packed = Vec::with_capacity(1 << 20);
        let mut compress = Compress::new(Compression::best(), false);
        compress
            .compress_vec(&plain, &mut packed, FlushCompress::Finish)
            .unwrap();
        let mut pushed = Vec::new();
        let _ = run_inflate(&packed, 1.0, &mut pushed);
        let produced: usize = pushed.iter().map(Vec::len).sum();
        assert!(
            produced <= 1 << 15,
            "inflated {produced} bytes past a declared size of 1"
        );
        let delivery = inflate(&packed, 1.0);
        assert!(delivery.chunks.is_empty());
        let message = match delivery.end {
            Err(thrown) => format!("{thrown:?}"),
            Ok(()) => panic!("a stream past its size was read"),
        };
        assert!(
            message.contains("too many bytes in the stream. expected 1. got at least "),
            "{message}"
        );
    }
}
