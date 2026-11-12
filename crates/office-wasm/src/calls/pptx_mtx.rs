//! vendor/mtx of the slides engine (lzcomp.ts, ctf.ts and index.ts), called as
//! `<module>.<TypeScript name>`. Bytes cross as lists of numbers. A class is
//! driven by the script of operations in `args.ops`, and the call returns
//! what it produced, with the text of what it threw, as the TypeScript
//! drivers in tools/pptx-diff/calls-mtx.ts do.

use mtx::ctf::{ctf_to_sfnt, sanitize_cmap};
use mtx::lzcomp::{AHuff, BitReader, BitWriter, MtxError, unpack_lz, unpack_mtx};
use mtx::mtx_to_sfnt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Returned, arg, required, value};

/// `{ "bit": true }`, `{ "value": [value, numberOfBits] }`, `"bytes"`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum WriterOp {
    Bit(bool),
    Value(f64, f64),
    Bytes,
}

/// `"bit"`, `{ "value": numberOfBits }`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum ReaderOp {
    Bit,
    Value(f64),
}

/// `{ "write": symbol }`, `"read"`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum HuffOp {
    Write(usize),
    Read,
}

#[derive(Serialize)]
struct WireError<'a> {
    name: &'a str,
    message: &'a str,
    string: String,
}

#[derive(Serialize)]
struct Read {
    values: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct Coded {
    symbols: Vec<i32>,
    bytes: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn bytes(args: &Value) -> Result<Vec<u8>, String> {
    required(args, "bytes")
}

fn thrown(error: MtxError) -> String {
    error.to_string()
}

pub fn dispatch(function: &str, text: &str, args: &Value) -> Returned {
    match function {
        "lzcomp.MtxError" => {
            let error = MtxError::new(text.to_owned());
            value(WireError {
                name: error.name,
                message: &error.message,
                string: error.to_string(),
            })
        }
        "lzcomp.BitWriter" => {
            let ops: Vec<WriterOp> = required(args, "ops")?;
            let mut writer = BitWriter::new();
            let mut snapshots = Vec::new();
            for op in ops {
                match op {
                    WriterOp::Bit(bit) => writer.output_bit(bit),
                    WriterOp::Value(value, number_of_bits) => {
                        writer.write_value(value, number_of_bits);
                    }
                    WriterOp::Bytes => snapshots.push(writer.bytes()),
                }
            }
            snapshots.push(writer.bytes());
            value(snapshots)
        }
        "lzcomp.BitReader" => {
            let bytes = bytes(args)?;
            let ops: Vec<ReaderOp> = required(args, "ops")?;
            let mut reader = BitReader::new(&bytes);
            let mut values = Vec::new();
            let mut error = None;
            for op in ops {
                let read = match op {
                    ReaderOp::Bit => reader.input_bit().map(Value::from),
                    ReaderOp::Value(number_of_bits) => {
                        reader.read_value(number_of_bits).map(Value::from)
                    }
                };
                match read {
                    Ok(read) => values.push(read),
                    Err(thrown) => {
                        error = Some(thrown.to_string());
                        break;
                    }
                }
            }
            value(Read { values, error })
        }
        "lzcomp.AHuff" => {
            let range: u16 = required(args, "range")?;
            let bytes: Option<Vec<u8>> = arg(args, "bytes")?;
            let ops: Vec<HuffOp> = required(args, "ops")?;
            let mut reader = bytes.as_deref().map(BitReader::new);
            let mut huff = AHuff::new(range);
            let mut writer = BitWriter::new();
            let mut symbols = Vec::new();
            let mut error = None;
            for op in ops {
                let done = match op {
                    HuffOp::Write(symbol) => huff.write_symbol(&mut writer, symbol),
                    HuffOp::Read => huff.read_symbol(reader.as_mut()).map(|symbol| {
                        symbols.push(symbol);
                    }),
                };
                if let Err(thrown) = done {
                    error = Some(thrown.to_string());
                    break;
                }
            }
            value(Coded {
                symbols,
                bytes: writer.bytes(),
                error,
            })
        }
        "lzcomp.unpackLz" => {
            let version: f64 = required(args, "version")?;
            value(unpack_lz(&bytes(args)?, version).map_err(thrown)?)
        }
        "lzcomp.unpackMtx" => value(unpack_mtx(&bytes(args)?).map_err(thrown)?),
        "ctf.sanitizeCmap" => value(sanitize_cmap(&bytes(args)?).map_err(thrown)?),
        "ctf.ctfToSfnt" => {
            let [s0, s1, s2]: [Vec<u8>; 3] = required(args, "streams")?;
            value(ctf_to_sfnt([&s0, &s1, &s2]).map_err(thrown)?)
        }
        "index.mtxToSfnt" => value(mtx_to_sfnt(&bytes(args)?)),
        _ => Err(format!("unknown function {function}")),
    }
}
