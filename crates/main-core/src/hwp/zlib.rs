//! `node:zlib` as `apps/hwp/src/main` uses it: `inflateRawSync` with
//! `maxOutputLength`, `deflateRawSync` and `crc32`.
//!
//! The deflate stream is zlib-rs at level 6, Node's default level: it inflates
//! to the same bytes as Node's, but the compressed bytes may differ from
//! Node's zlib.

use flate2::{Compress, Compression, Crc, Decompress, FlushCompress, FlushDecompress, Status};

use super::hwp5_file::Thrown;

/// `inflateRawSync(input, { maxOutputLength })`: throws on data that is not
/// deflate, on a stream that ends early and on output past the limit; bytes
/// after the end of the stream are ignored.
pub fn inflate_raw_sync(input: &[u8], max_output_length: usize) -> Result<Vec<u8>, Thrown> {
    let mut decoder = Decompress::new(false);
    let mut out: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; 64 * 1024];
    loop {
        let read = decoder.total_in();
        let written = decoder.total_out();
        let status = decoder
            .decompress(&input[read as usize..], &mut chunk, FlushDecompress::Finish)
            .map_err(|error| Thrown(error.to_string()))?;
        let produced = (decoder.total_out() - written) as usize;
        out.extend_from_slice(&chunk[..produced]);
        if out.len() > max_output_length {
            return Err(Thrown(format!(
                "Cannot create a Buffer larger than {max_output_length} bytes"
            )));
        }
        match status {
            Status::StreamEnd => return Ok(out),
            Status::Ok | Status::BufError => {
                if produced == 0 && decoder.total_in() == read {
                    return Err(Thrown("unexpected end of file".to_owned()));
                }
            }
        }
    }
}

/// `deflateRawSync(data)`
pub fn deflate_raw_sync(data: &[u8]) -> Result<Vec<u8>, Thrown> {
    let mut encoder = Compress::new(Compression::default(), false);
    let mut out: Vec<u8> = Vec::with_capacity(data.len() / 2 + 64);
    loop {
        let read = encoder.total_in() as usize;
        if out.capacity() == out.len() {
            out.reserve(data.len() / 2 + 64);
        }
        match encoder.compress_vec(&data[read..], &mut out, FlushCompress::Finish) {
            Ok(Status::StreamEnd) => return Ok(out),
            Ok(_) => {}
            Err(error) => return Err(Thrown(error.to_string())),
        }
    }
}

/// `zlib.crc32(data)`
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = Crc::new();
    crc.update(data);
    crc.sum()
}
