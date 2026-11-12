//! The MicroType Express LZ decoder: `vendor/mtx/lzcomp.ts` of
//! `packages/pptx-engine`, itself a port of libeot's `src/lzcomp` (`ahuff.c`,
//! `bitio.c`, `lzcomp.c`, `liblzcomp.c`) by Brennan T. Vincent, after
//! Monotype's MTX reference code. libeot is licensed under the Mozilla Public
//! License 2.0, and so is this file, derived from it: see
//! `LICENSE` of this crate. Decompression side only;
//! the compressor and the size-limited copy window are not ported.

use std::borrow::Cow;
use std::fmt;

use jscompat::to_int32;

/// What the TypeScript throws: its `MtxError`, which sets no `name` and so
/// reads as `Error`, or the `RangeError` and `TypeError` of the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MtxError {
    pub name: &'static str,
    pub message: Cow<'static, str>,
}

impl MtxError {
    /// `new MtxError(message)`
    pub fn new(message: impl Into<Cow<'static, str>>) -> Self {
        Self {
            name: "Error",
            message: message.into(),
        }
    }

    /// An error the host throws, not the decoder.
    pub(crate) const fn host(name: &'static str, message: &'static str) -> Self {
        Self {
            name,
            message: Cow::Borrowed(message),
        }
    }

    /// What `new Uint8Array(n)` throws where the memory is not there.
    pub(crate) const fn allocation_failed() -> Self {
        Self::host("RangeError", "Array buffer allocation failed")
    }
}

impl fmt::Display for MtxError {
    /// `String(error)`: `Error.prototype.toString` leaves out an empty message.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.message.is_empty() {
            f.write_str(self.name)
        } else {
            write!(f, "{}: {}", self.name, self.message)
        }
    }
}

impl std::error::Error for MtxError {}

/// Room for `additional` more bytes, which the host may refuse as it refuses
/// a typed array it cannot allocate. A forged size must not abort the engine.
pub(crate) fn reserve(buf: &mut Vec<u8>, additional: u64) -> Result<(), MtxError> {
    usize::try_from(additional)
        .ok()
        .and_then(|additional| buf.try_reserve(additional).ok())
        .ok_or_else(MtxError::allocation_failed)
}

/// MSB-first bit writer (BITIO in write mode); only the round-trip tests encode.
#[derive(Debug, Default)]
pub struct BitWriter {
    out: Vec<u8>,
    cur: u32,
    count: u32,
}

impl BitWriter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn output_bit(&mut self, bit: bool) {
        self.cur = (self.cur << 1) | u32::from(bit);
        self.count += 1;
        if self.count == 8 {
            // eight bits: below 256, as the Uint8Array of `bytes` keeps it
            self.out.push(self.cur as u8);
            self.cur = 0;
            self.count = 0;
        }
    }

    /// `value >>> i` reads `value` as a uint32 and the count modulo 32.
    pub fn write_value(&mut self, value: f64, number_of_bits: f64) {
        let value = to_int32(value) as u32;
        let mut i = number_of_bits - 1.0;
        while i >= 0.0 {
            self.output_bit((value >> (to_int32(i) as u32 & 31)) & 1 == 1);
            i -= 1.0;
        }
    }

    pub fn bytes(&self) -> Vec<u8> {
        let mut bytes = self.out.clone();
        if self.count != 0 {
            bytes.push((self.cur << (8 - self.count)) as u8);
        }
        bytes
    }
}

/// MSB-first bit reader over a byte buffer (BITIO in read mode).
#[derive(Debug)]
pub struct BitReader<'a> {
    bytes: &'a [u8],
    idx: usize,
    bit_count: u32,
    bit_buffer: u32,
}

impl<'a> BitReader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Self {
            bytes,
            idx: 0,
            bit_count: 0,
            bit_buffer: 0,
        }
    }

    pub fn input_bit(&mut self) -> Result<bool, MtxError> {
        if self.bit_count == 0 {
            let Some(&byte) = self.bytes.get(self.idx) else {
                return Err(MtxError::new("unexpected end of LZ stream"));
            };
            self.idx += 1;
            self.bit_buffer = u32::from(byte);
            self.bit_count = 8;
        }
        self.bit_count -= 1;
        self.bit_buffer <<= 1;
        Ok(self.bit_buffer & 0x100 != 0)
    }

    /// The value is built in 32 bits, as `<<` builds it, and read unsigned.
    pub fn read_value(&mut self, number_of_bits: f64) -> Result<u32, MtxError> {
        let mut value: u32 = 0;
        let mut i = 0.0;
        while i < number_of_bits {
            value = (value << 1) | u32::from(self.input_bit()?);
            i += 1.0;
        }
        Ok(value)
    }
}

fn bits_used(mut x: usize) -> u32 {
    let mut n = 0;
    while x > 0 {
        n += 1;
        x >>= 1;
    }
    n
}

const ROOT: i32 = 1;

/// A read of an Int32Array: `undefined` outside it.
fn get(array: &[i32], index: i32) -> Option<i32> {
    usize::try_from(index)
        .ok()
        .and_then(|at| array.get(at))
        .copied()
}

/// A write to an Int32Array: dropped outside it.
fn set(array: &mut [i32], index: i32, value: i32) {
    if let Some(slot) = usize::try_from(index).ok().and_then(|at| array.get_mut(at)) {
        *slot = value;
    }
}

/// Where the TypeScript would follow `undefined` through the tree and never
/// return: a symbol outside the coder's range, or a coder of range 0 or 1.
/// No stream reaches it: `unpack_lz` builds coders of range 8 and 267 to 323.
fn outside_tree() -> MtxError {
    MtxError::new("symbol outside the Huffman tree")
}

/// Adaptive Huffman coder (AHUFF): sibling-property tree, leaves carry symbol codes.
///
/// The TypeScript constructor takes the bit reader; here `read_symbol` does,
/// since the three coders of a stream read from one reader.
#[derive(Debug)]
pub struct AHuff {
    up: Vec<i32>,
    left: Vec<i32>,
    right: Vec<i32>,
    code: Vec<i32>,
    weight: Vec<i32>,
    symbol_index: Vec<i32>,
}

impl AHuff {
    /// Node numbers fit in an i32: a range is at most 65,535.
    pub fn new(range: u16) -> Self {
        let range = usize::from(range);
        let mut bit_count2 = 0;
        if range > 256 && range < 512 {
            bit_count2 = bits_used(range - 256 - 1) + 1;
        }
        let n = 2 * range;
        let mut huff = Self {
            up: vec![0; n],
            left: vec![0; n],
            right: vec![0; n],
            code: vec![0; n],
            weight: vec![0; n],
            symbol_index: vec![0; range],
        };
        for i in 2..n {
            huff.up[i] = (i >> 1) as i32;
            huff.weight[i] = 1;
        }
        for i in 1..range {
            huff.left[i] = (2 * i) as i32;
            huff.right[i] = (2 * i + 1) as i32;
        }
        for i in 0..range {
            huff.code[i] = -1;
            huff.code[range + i] = i as i32;
            huff.left[range + i] = -1;
            huff.right[range + i] = -1;
            huff.symbol_index[i] = (range + i) as i32;
        }
        huff.init_weight(ROOT);
        if bit_count2 != 0 {
            // a range of 257 has no symbol 257: the TypeScript reads past its
            // table there (and a write then never returns); no panic here
            huff.update_weight(huff.symbol_index.get(256).copied().unwrap_or(0));
            huff.update_weight(huff.symbol_index.get(257).copied().unwrap_or(0));
            for _ in 0..12 {
                huff.update_weight(huff.symbol_index[range - 3]);
            }
            for _ in 0..6 {
                huff.update_weight(huff.symbol_index[range - 2]);
            }
        } else {
            for _ in 0..2 {
                for i in 0..range {
                    huff.update_weight(huff.symbol_index[i]);
                }
            }
        }
        huff
    }

    fn init_weight(&mut self, a: i32) -> Option<i32> {
        if get(&self.code, a).is_some_and(|code| code < 0) {
            let left = get(&self.left, a).and_then(|left| self.init_weight(left));
            let right = get(&self.right, a).and_then(|right| self.init_weight(right));
            // undefined + undefined is NaN, which an Int32Array stores as 0
            let sum = match (left, right) {
                (Some(left), Some(right)) => left.wrapping_add(right),
                _ => 0,
            };
            set(&mut self.weight, a, sum);
        }
        get(&self.weight, a)
    }

    /// `a` and `b` are nodes of the tree: `b` lies between the root and `a`.
    fn swap_nodes(&mut self, a: i32, b: i32) {
        let upa = get(&self.up, a).unwrap_or(0);
        let upb = get(&self.up, b).unwrap_or(0);
        let tl = get(&self.left, a).unwrap_or(0);
        let tr = get(&self.right, a).unwrap_or(0);
        let tc = get(&self.code, a).unwrap_or(0);
        let tw = get(&self.weight, a).unwrap_or(0);
        let bl = get(&self.left, b).unwrap_or(0);
        let br = get(&self.right, b).unwrap_or(0);
        let bc = get(&self.code, b).unwrap_or(0);
        let bw = get(&self.weight, b).unwrap_or(0);
        set(&mut self.left, a, bl);
        set(&mut self.right, a, br);
        set(&mut self.code, a, bc);
        set(&mut self.weight, a, bw);
        set(&mut self.left, b, tl);
        set(&mut self.right, b, tr);
        set(&mut self.code, b, tc);
        set(&mut self.weight, b, tw);
        set(&mut self.up, a, upa);
        set(&mut self.up, b, upb);
        for x in [a, b] {
            let c = get(&self.code, x);
            if c.is_some_and(|c| c < 0) {
                set(&mut self.up, get(&self.left, x).unwrap_or(-1), x);
                set(&mut self.up, get(&self.right, x).unwrap_or(-1), x);
            } else if let Some(c) = c {
                set(&mut self.symbol_index, c, x);
            }
        }
    }

    fn update_weight(&mut self, mut a: i32) {
        while a != ROOT {
            // only nodes of the tree come here; outside it the TypeScript loops forever
            let Some(weight_a) = get(&self.weight, a) else {
                return;
            };
            let mut b = a - 1;
            // keep the sibling property: jump over the block of equal weights
            if get(&self.weight, b) == Some(weight_a) {
                loop {
                    b -= 1;
                    if get(&self.weight, b) != Some(weight_a) {
                        break;
                    }
                }
                b += 1;
                if b > ROOT {
                    self.swap_nodes(a, b);
                    a = b;
                }
            }
            set(&mut self.weight, a, weight_a.wrapping_add(1));
            let Some(up) = get(&self.up, a) else {
                return;
            };
            a = up;
        }
        if let Some(root) = get(&self.weight, ROOT) {
            set(&mut self.weight, ROOT, root.wrapping_add(1));
        }
    }

    /// Encoder mirror of `read_symbol` (MTX_AHUFF_WriteSymbol); used by the round-trip tests.
    pub fn write_symbol(&mut self, out: &mut BitWriter, symbol: usize) -> Result<(), MtxError> {
        let Some(&leaf) = self.symbol_index.get(symbol) else {
            return Err(outside_tree());
        };
        let mut path = Vec::new();
        let mut a = leaf;
        while a != ROOT {
            let Some(up) = get(&self.up, a) else {
                return Err(outside_tree());
            };
            path.push(get(&self.right, up) == Some(a));
            a = up;
        }
        for &bit in path.iter().rev() {
            out.output_bit(bit);
        }
        self.update_weight(leaf);
        Ok(())
    }

    /// `bits` is the reader the TypeScript constructor took; `None` is its `null`.
    pub fn read_symbol(&mut self, bits: Option<&mut BitReader<'_>>) -> Result<i32, MtxError> {
        let Some(bits) = bits else {
            return Err(MtxError::host(
                "TypeError",
                "Cannot read properties of null (reading 'inputBit')",
            ));
        };
        let mut a = ROOT;
        loop {
            let next = if bits.input_bit()? {
                get(&self.right, a)
            } else {
                get(&self.left, a)
            };
            let Some(next) = next else {
                return Err(outside_tree());
            };
            a = next;
            match get(&self.code, a) {
                Some(symbol) if symbol >= 0 => {
                    self.update_weight(a);
                    return Ok(symbol);
                }
                Some(_) => {}
                None => return Err(outside_tree()),
            }
        }
    }
}

#[derive(Clone, Copy)]
enum RunState {
    Initial,
    Normal,
    SeenEscape,
    NeedByte,
}

/// Run-length layer decoder (RUNLENGTHCOMP::SaveBytes state machine).
struct RunLengthSink {
    state: RunState,
    escape: u8,
    count: u8,
}

impl RunLengthSink {
    fn new() -> Self {
        Self {
            state: RunState::Initial,
            escape: 0,
            count: 0,
        }
    }

    fn save(&mut self, out: &mut ByteSink, value: u8) -> Result<(), MtxError> {
        match self.state {
            RunState::Normal => {
                if value == self.escape {
                    self.state = RunState::SeenEscape;
                } else {
                    out.push(value)?;
                }
            }
            RunState::SeenEscape => {
                self.count = value;
                if value == 0 {
                    out.push(self.escape)?;
                    self.state = RunState::Normal;
                } else {
                    self.state = RunState::NeedByte;
                }
            }
            RunState::NeedByte => {
                for _ in 0..self.count {
                    out.push(value)?;
                }
                self.state = RunState::Normal;
            }
            RunState::Initial => {
                self.escape = value;
                self.state = RunState::Normal;
            }
        }
        Ok(())
    }
}

/// The output, grown as the TypeScript grows its Uint8Array.
struct ByteSink {
    buf: Vec<u8>,
}

impl ByteSink {
    fn new(capacity: u64) -> Result<Self, MtxError> {
        let mut buf = Vec::new();
        reserve(&mut buf, capacity.max(16))?;
        Ok(Self { buf })
    }

    fn push(&mut self, v: u8) -> Result<(), MtxError> {
        if self.buf.len() >= self.buf.capacity() {
            let more = self.buf.len() as u64 / 2 + 16;
            reserve(&mut self.buf, more)?;
        }
        self.buf.push(v);
        Ok(())
    }
}

const PRELOAD_SIZE: usize = 2 * 32 * 96 + 4 * 256;
const LEN_WIDTH: u32 = 3;
const DIST_WIDTH: u32 = 3;
const BIT_RANGE: u32 = LEN_WIDTH - 1;
const LEN_MIN: i64 = 2;
const DIST_MIN: i64 = 1;
const MAX_2BYTE_DIST: i64 = 512;

fn emit(rl: &mut Option<RunLengthSink>, sink: &mut ByteSink, v: u8) -> Result<(), MtxError> {
    match rl {
        Some(rl) => rl.save(sink, v),
        None => sink.push(v),
    }
}

/// The value is built in 32 bits as `<<` builds it, so a long run of length
/// symbols wraps, and a negative length copies nothing.
fn decode_length(
    symbol: i64,
    len_coder: &mut AHuff,
    bits: &mut BitReader<'_>,
) -> Result<(i64, i64), MtxError> {
    let mask: i32 = 1 << BIT_RANGE;
    let mut value: i32 = 0;
    let b = symbol - 256;
    let ranges = b.div_euclid(1 << LEN_WIDTH) + 1;
    let mut b = b.rem_euclid(1 << LEN_WIDTH) as i32;
    loop {
        let done = b & mask == 0;
        b &= !mask;
        value = (value << BIT_RANGE) | b;
        if done {
            break;
        }
        b = len_coder.read_symbol(Some(&mut *bits))?;
    }
    Ok((i64::from(value) + LEN_MIN, ranges))
}

fn decode_distance(
    ranges: i64,
    dist_coder: &mut AHuff,
    bits: &mut BitReader<'_>,
) -> Result<i64, MtxError> {
    let mut value: i32 = 0;
    let mut r = ranges;
    while r > 0 {
        value = (value << DIST_WIDTH) | dist_coder.read_symbol(Some(&mut *bits))?;
        r -= 1;
    }
    Ok(i64::from(value) + DIST_MIN)
}

/// Inflate one LZCOMP block (MTX_LZCOMP_UnPackMemory).
pub fn unpack_lz(data: &[u8], version: f64) -> Result<Vec<u8>, MtxError> {
    let mut bits = BitReader::new(data);
    let using_run_length = if version == 1.0 {
        false
    } else {
        bits.input_bit()?
    };
    let mut dist_coder = AHuff::new(1 << DIST_WIDTH);
    let mut len_coder = AHuff::new(1 << LEN_WIDTH);
    let out_len = bits.read_value(24.0)?;

    // SetDistRange
    let mut num_dist_ranges: i64 = 1;
    let mut dist_max = DIST_MIN + (1 << (i64::from(DIST_WIDTH) * num_dist_ranges)) - 1;
    while dist_max < i64::from(out_len) {
        num_dist_ranges += 1;
        dist_max = DIST_MIN + (1 << (i64::from(DIST_WIDTH) * num_dist_ranges)) - 1;
    }
    let dup2 = 256 + (1 << LEN_WIDTH) * num_dist_ranges;
    let dup4 = dup2 + 1;
    let dup6 = dup4 + 1;
    let num_syms = dup6 + 1;
    // 24 bits of length need at most 8 ranges: 323 symbols
    let mut sym_coder = AHuff::new(u16::try_from(num_syms).unwrap_or(u16::MAX));

    // InitializeModel: the history window starts with a fixed preload
    let window_len = PRELOAD_SIZE + out_len as usize;
    let mut window = Vec::new();
    reserve(&mut window, window_len as u64)?;
    window.resize(window_len, 0);
    let mut i = 0;
    for k in 0..32u8 {
        for j in 0..96u8 {
            window[i] = k;
            window[i + 1] = j;
            i += 2;
        }
    }
    let mut j: u32 = 0;
    while i < PRELOAD_SIZE && j < 256 {
        for _ in 0..4 {
            window[i] = j as u8;
            i += 1;
        }
        j += 1;
    }

    let mut sink = ByteSink::new(u64::from(out_len))?;
    let mut rl = using_run_length.then(RunLengthSink::new);

    // a DUP reads behind `pos`, a copy behind what it writes: always inside the window
    let read = |window: &[u8], at: i64| -> u8 {
        usize::try_from(at)
            .ok()
            .and_then(|at| window.get(at))
            .copied()
            .unwrap_or(0)
    };
    // a copy may run past outLen, and the Uint8Array drops what it writes there
    let write = |window: &mut [u8], at: i64, v: u8| {
        if let Some(slot) = usize::try_from(at).ok().and_then(|at| window.get_mut(at)) {
            *slot = v;
        }
    };

    let base = PRELOAD_SIZE as i64;
    let out_len = i64::from(out_len);
    let mut pos: i64 = 0;
    while pos < out_len {
        let symbol = i64::from(sym_coder.read_symbol(Some(&mut bits))?);
        let value = if symbol < 256 {
            symbol as u8
        } else if symbol == dup2 {
            read(&window, base + pos - 2)
        } else if symbol == dup4 {
            read(&window, base + pos - 4)
        } else if symbol == dup6 {
            read(&window, base + pos - 6)
        } else {
            let (len0, ranges) = decode_length(symbol, &mut len_coder, &mut bits)?;
            let distance = decode_distance(ranges, &mut dist_coder, &mut bits)?;
            let length = if distance >= MAX_2BYTE_DIST {
                len0 + 1
            } else {
                len0
            };
            let start = pos - distance - length + 1;
            if base + start < 0 {
                return Err(MtxError::new("LZ copy before window start"));
            }
            for j in 0..length {
                let v = read(&window, base + start + j);
                write(&mut window, base + pos, v);
                pos += 1;
                emit(&mut rl, &mut sink, v)?;
            }
            continue;
        };
        write(&mut window, base + pos, value);
        pos += 1;
        emit(&mut rl, &mut sink, value)?;
    }
    Ok(sink.buf)
}

/// `buf` holds at least `o + 3` bytes.
fn be24(b: &[u8], o: usize) -> i64 {
    (i64::from(b[o]) << 16) | (i64::from(b[o + 1]) << 8) | i64::from(b[o + 2])
}

/// Split an MTX payload into its three inflated CTF streams (unpackMtx).
pub fn unpack_mtx(buf: &[u8]) -> Result<[Vec<u8>; 3], MtxError> {
    if buf.len() < 10 {
        return Err(MtxError::new("MTX header truncated"));
    }
    let version = f64::from(buf[0]);
    let offsets = [10, be24(buf, 4), be24(buf, 7)];
    let length = buf.len() as i64;
    let sizes = [
        offsets[1] - offsets[0],
        offsets[2] - offsets[1],
        length - offsets[2],
    ];
    let block = |k: usize| -> Result<Vec<u8>, MtxError> {
        if sizes[k] < 0 || offsets[k] + sizes[k] > length {
            return Err(MtxError::new("MTX block bounds"));
        }
        let from = usize::try_from(offsets[k]).unwrap_or(usize::MAX);
        let to = usize::try_from(offsets[k] + sizes[k]).unwrap_or(usize::MAX);
        let data = buf
            .get(from..to)
            .ok_or_else(|| MtxError::new("MTX block bounds"))?;
        unpack_lz(data, version)
    };
    Ok([block(0)?, block(1)?, block(2)?])
}
