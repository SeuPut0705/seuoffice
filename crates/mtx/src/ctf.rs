//! Compact Table Format to sfnt: `vendor/mtx/ctf.ts` of `packages/pptx-engine`,
//! itself a port of libeot's `src/ctf` (`parseCTF.c`, `parseTTF.c`,
//! `SFNTContainer.c`) and `triplet_encodings.c` by Brennan T. Vincent. libeot is
//! licensed under the Mozilla Public License 2.0, and so is this file, derived
//! from it: see `LICENSE` of this crate.
//! Spec: http://www.w3.org/Submission/MTX/

use std::borrow::Cow;
use std::collections::BTreeMap;

use super::lzcomp::{MtxError, reserve};

/// `buf[from..to]`, which the caller has checked.
fn slice(buf: &[u8], from: u64, to: u64) -> &[u8] {
    usize::try_from(from)
        .ok()
        .zip(usize::try_from(to).ok())
        .and_then(|(from, to)| buf.get(from..to))
        .unwrap_or(&[])
}

/// Big-endian reader with libeot's Stream semantics (byte position + bit position).
struct Reader<'a> {
    buf: &'a [u8],
    pos: u64,
    bit_pos: u32,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self {
            buf,
            pos: 0,
            bit_pos: 0,
        }
    }

    fn size(&self) -> u64 {
        self.buf.len() as u64
    }

    fn need(&self, n: u64) -> Result<(), MtxError> {
        if self.bit_pos != 0 {
            return Err(MtxError::new("read off byte boundary"));
        }
        if self.pos + n > self.size() {
            return Err(MtxError::new("CTF stream truncated"));
        }
        Ok(())
    }

    /// The byte at `at`, which `need` has checked.
    fn at(&self, at: u64) -> u8 {
        usize::try_from(at)
            .ok()
            .and_then(|at| self.buf.get(at))
            .copied()
            .unwrap_or(0)
    }

    fn u8(&mut self) -> Result<u8, MtxError> {
        self.need(1)?;
        let v = self.at(self.pos);
        self.pos += 1;
        Ok(v)
    }

    fn peek_u8(&self) -> Result<u8, MtxError> {
        self.need(1)?;
        Ok(self.at(self.pos))
    }

    fn u16(&mut self) -> Result<u16, MtxError> {
        self.need(2)?;
        let v = u16::from_be_bytes([self.at(self.pos), self.at(self.pos + 1)]);
        self.pos += 2;
        Ok(v)
    }

    /// `(u16 << 16) >> 16`
    fn s16(&mut self) -> Result<i16, MtxError> {
        Ok(self.u16()? as i16)
    }

    fn u32(&mut self) -> Result<u32, MtxError> {
        self.need(4)?;
        let v = u32::from_be_bytes([
            self.at(self.pos),
            self.at(self.pos + 1),
            self.at(self.pos + 2),
            self.at(self.pos + 3),
        ]);
        self.pos += 4;
        Ok(v)
    }

    fn seek(&mut self, pos: u64) -> Result<(), MtxError> {
        if self.bit_pos != 0 {
            return Err(MtxError::new("seek off byte boundary"));
        }
        if pos > self.size() {
            return Err(MtxError::new("seek past end"));
        }
        self.pos = pos;
        Ok(())
    }

    fn skip(&mut self, n: u64) -> Result<(), MtxError> {
        self.seek(self.pos + n)
    }

    fn bytes(&mut self, n: u64) -> Result<&'a [u8], MtxError> {
        self.need(n)?;
        let out = slice(self.buf, self.pos, self.pos + n);
        self.pos += n;
        Ok(out)
    }

    fn read_n_bits(&mut self, n: u32) -> Result<u32, MtxError> {
        let mut out: i32 = 0;
        for i in 0..n {
            if self.pos >= self.size() {
                return Err(MtxError::new("bit read past end"));
            }
            let bit = (i32::from(self.at(self.pos)) >> (7 - self.bit_pos)) & 1;
            out |= bit << ((n - i - 1) & 31);
            self.bit_pos += 1;
            if self.bit_pos == 8 {
                self.bit_pos = 0;
                self.pos += 1;
            }
        }
        Ok(out as u32)
    }
}

/// Growable big-endian writer; `pos` may be moved back to patch earlier fields.
///
/// A value is written by its low bytes, as `& 0xff` of the TypeScript keeps them.
struct Writer {
    buf: Vec<u8>,
    pos: u64,
    size: u64,
}

impl Writer {
    fn new(capacity: u64) -> Result<Self, MtxError> {
        let mut buf = Vec::new();
        reserve(&mut buf, capacity.max(16))?;
        Ok(Self {
            buf,
            pos: 0,
            size: 0,
        })
    }

    /// The bytes up to `pos + n` exist, zeroed where nothing was written.
    fn ensure(&mut self, n: u64) -> Result<(), MtxError> {
        let need = self.pos + n;
        let len = self.buf.len() as u64;
        if need > len {
            reserve(&mut self.buf, need - len)?;
            self.buf.resize(need as usize, 0);
        }
        Ok(())
    }

    fn fix(&mut self) {
        if self.pos > self.size {
            self.size = self.pos;
        }
    }

    /// One byte at `pos`, after `ensure`.
    fn put(&mut self, v: u8) {
        if let Some(slot) = usize::try_from(self.pos)
            .ok()
            .and_then(|at| self.buf.get_mut(at))
        {
            *slot = v;
        }
        self.pos += 1;
    }

    fn u8(&mut self, v: i64) -> Result<(), MtxError> {
        self.ensure(1)?;
        self.put((v & 0xff) as u8);
        self.fix();
        Ok(())
    }

    fn u16(&mut self, v: i64) -> Result<(), MtxError> {
        self.ensure(2)?;
        self.put(((v >> 8) & 0xff) as u8);
        self.put((v & 0xff) as u8);
        self.fix();
        Ok(())
    }

    fn s16(&mut self, v: i64) -> Result<(), MtxError> {
        self.u16(v & 0xffff)
    }

    fn u32(&mut self, v: i64) -> Result<(), MtxError> {
        self.ensure(4)?;
        self.put(((v >> 24) & 0xff) as u8);
        self.put(((v >> 16) & 0xff) as u8);
        self.put(((v >> 8) & 0xff) as u8);
        self.put((v & 0xff) as u8);
        self.fix();
        Ok(())
    }

    fn bytes(&mut self, b: &[u8]) -> Result<(), MtxError> {
        self.ensure(b.len() as u64)?;
        for &v in b {
            self.put(v);
        }
        self.fix();
        Ok(())
    }

    /// Reserve n bytes (zeroed) to be patched later.
    fn skip(&mut self, n: u64) -> Result<(), MtxError> {
        self.ensure(n)?;
        self.pos += n;
        self.fix();
        Ok(())
    }

    /// The first `len` bytes written so far.
    fn prefix(&self, len: u64) -> &[u8] {
        slice(&self.buf, 0, len.min(self.size))
    }

    fn result(mut self) -> Vec<u8> {
        self.buf
            .truncate(usize::try_from(self.size).unwrap_or(usize::MAX));
        self.buf
    }
}

/// A table of the directory. `data` borrows stream 0 until a table is rebuilt
/// or patched: the TypeScript copies every table, which changes nothing read.
struct Table<'a> {
    tag: [u8; 4],
    offset: u64,
    length: u64,
    data: Option<Cow<'a, [u8]>>,
}

// [byteCount, xBits, yBits, deltaX, deltaY, xSign, ySign] per MTX §TripletEncoding
const TRIPLET: [[i32; 7]; 128] = [
    [2, 0, 8, 0, 0, 0, -1],
    [2, 0, 8, 0, 0, 0, 1],
    [2, 0, 8, 0, 256, 0, -1],
    [2, 0, 8, 0, 256, 0, 1],
    [2, 0, 8, 0, 512, 0, -1],
    [2, 0, 8, 0, 512, 0, 1],
    [2, 0, 8, 0, 768, 0, -1],
    [2, 0, 8, 0, 768, 0, 1],
    [2, 0, 8, 0, 1024, 0, -1],
    [2, 0, 8, 0, 1024, 0, 1],
    [2, 8, 0, 0, 0, -1, 0],
    [2, 8, 0, 0, 0, 1, 0],
    [2, 8, 0, 256, 0, -1, 0],
    [2, 8, 0, 256, 0, 1, 0],
    [2, 8, 0, 512, 0, -1, 0],
    [2, 8, 0, 512, 0, 1, 0],
    [2, 8, 0, 768, 0, -1, 0],
    [2, 8, 0, 768, 0, 1, 0],
    [2, 8, 0, 1024, 0, -1, 0],
    [2, 8, 0, 1024, 0, 1, 0],
    [2, 4, 4, 1, 1, -1, -1],
    [2, 4, 4, 1, 1, 1, -1],
    [2, 4, 4, 1, 1, -1, 1],
    [2, 4, 4, 1, 1, 1, 1],
    [2, 4, 4, 1, 17, -1, -1],
    [2, 4, 4, 1, 17, 1, -1],
    [2, 4, 4, 1, 17, -1, 1],
    [2, 4, 4, 1, 17, 1, 1],
    [2, 4, 4, 1, 33, -1, -1],
    [2, 4, 4, 1, 33, 1, -1],
    [2, 4, 4, 1, 33, -1, 1],
    [2, 4, 4, 1, 33, 1, 1],
    [2, 4, 4, 1, 49, -1, -1],
    [2, 4, 4, 1, 49, 1, -1],
    [2, 4, 4, 1, 49, -1, 1],
    [2, 4, 4, 1, 49, 1, 1],
    [2, 4, 4, 17, 1, -1, -1],
    [2, 4, 4, 17, 1, 1, -1],
    [2, 4, 4, 17, 1, -1, 1],
    [2, 4, 4, 17, 1, 1, 1],
    [2, 4, 4, 17, 17, -1, -1],
    [2, 4, 4, 17, 17, 1, -1],
    [2, 4, 4, 17, 17, -1, 1],
    [2, 4, 4, 17, 17, 1, 1],
    [2, 4, 4, 17, 33, -1, -1],
    [2, 4, 4, 17, 33, 1, -1],
    [2, 4, 4, 17, 33, -1, 1],
    [2, 4, 4, 17, 33, 1, 1],
    [2, 4, 4, 17, 49, -1, -1],
    [2, 4, 4, 17, 49, 1, -1],
    [2, 4, 4, 17, 49, -1, 1],
    [2, 4, 4, 17, 49, 1, 1],
    [2, 4, 4, 33, 1, -1, -1],
    [2, 4, 4, 33, 1, 1, -1],
    [2, 4, 4, 33, 1, -1, 1],
    [2, 4, 4, 33, 1, 1, 1],
    [2, 4, 4, 33, 17, -1, -1],
    [2, 4, 4, 33, 17, 1, -1],
    [2, 4, 4, 33, 17, -1, 1],
    [2, 4, 4, 33, 17, 1, 1],
    [2, 4, 4, 33, 33, -1, -1],
    [2, 4, 4, 33, 33, 1, -1],
    [2, 4, 4, 33, 33, -1, 1],
    [2, 4, 4, 33, 33, 1, 1],
    [2, 4, 4, 33, 49, -1, -1],
    [2, 4, 4, 33, 49, 1, -1],
    [2, 4, 4, 33, 49, -1, 1],
    [2, 4, 4, 33, 49, 1, 1],
    [2, 4, 4, 49, 1, -1, -1],
    [2, 4, 4, 49, 1, 1, -1],
    [2, 4, 4, 49, 1, -1, 1],
    [2, 4, 4, 49, 1, 1, 1],
    [2, 4, 4, 49, 17, -1, -1],
    [2, 4, 4, 49, 17, 1, -1],
    [2, 4, 4, 49, 17, -1, 1],
    [2, 4, 4, 49, 17, 1, 1],
    [2, 4, 4, 49, 33, -1, -1],
    [2, 4, 4, 49, 33, 1, -1],
    [2, 4, 4, 49, 33, -1, 1],
    [2, 4, 4, 49, 33, 1, 1],
    [2, 4, 4, 49, 49, -1, -1],
    [2, 4, 4, 49, 49, 1, -1],
    [2, 4, 4, 49, 49, -1, 1],
    [2, 4, 4, 49, 49, 1, 1],
    [3, 8, 8, 1, 1, -1, -1],
    [3, 8, 8, 1, 1, 1, -1],
    [3, 8, 8, 1, 1, -1, 1],
    [3, 8, 8, 1, 1, 1, 1],
    [3, 8, 8, 1, 257, -1, -1],
    [3, 8, 8, 1, 257, 1, -1],
    [3, 8, 8, 1, 257, -1, 1],
    [3, 8, 8, 1, 257, 1, 1],
    [3, 8, 8, 1, 513, -1, -1],
    [3, 8, 8, 1, 513, 1, -1],
    [3, 8, 8, 1, 513, -1, 1],
    [3, 8, 8, 1, 513, 1, 1],
    [3, 8, 8, 257, 1, -1, -1],
    [3, 8, 8, 257, 1, 1, -1],
    [3, 8, 8, 257, 1, -1, 1],
    [3, 8, 8, 257, 1, 1, 1],
    [3, 8, 8, 257, 257, -1, -1],
    [3, 8, 8, 257, 257, 1, -1],
    [3, 8, 8, 257, 257, -1, 1],
    [3, 8, 8, 257, 257, 1, 1],
    [3, 8, 8, 257, 513, -1, -1],
    [3, 8, 8, 257, 513, 1, -1],
    [3, 8, 8, 257, 513, -1, 1],
    [3, 8, 8, 257, 513, 1, 1],
    [3, 8, 8, 513, 1, -1, -1],
    [3, 8, 8, 513, 1, 1, -1],
    [3, 8, 8, 513, 1, -1, 1],
    [3, 8, 8, 513, 1, 1, 1],
    [3, 8, 8, 513, 257, -1, -1],
    [3, 8, 8, 513, 257, 1, -1],
    [3, 8, 8, 513, 257, -1, 1],
    [3, 8, 8, 513, 257, 1, 1],
    [3, 8, 8, 513, 513, -1, -1],
    [3, 8, 8, 513, 513, 1, -1],
    [3, 8, 8, 513, 513, -1, 1],
    [3, 8, 8, 513, 513, 1, 1],
    [4, 12, 12, 0, 0, -1, -1],
    [4, 12, 12, 0, 0, 1, -1],
    [4, 12, 12, 0, 0, -1, 1],
    [4, 12, 12, 0, 0, 1, 1],
    [5, 16, 16, 0, 0, -1, -1],
    [5, 16, 16, 0, 0, 1, -1],
    [5, 16, 16, 0, 0, -1, 1],
    [5, 16, 16, 0, 0, 1, 1],
];

/// `(v << 16) >> 16`
fn i16_of(v: i32) -> i32 {
    (v << 16) >> 16
}

fn read_255_ushort(r: &mut Reader<'_>) -> Result<i64, MtxError> {
    let code = r.u8()?;
    Ok(match code {
        253 => i64::from(r.u16()?),
        255 => 253 + i64::from(r.u8()?),
        254 => 506 + i64::from(r.u8()?),
        _ => i64::from(code),
    })
}

fn read_255_short(r: &mut Reader<'_>) -> Result<i32, MtxError> {
    let mut code = r.u8()?;
    if code == 253 {
        return Ok(i32::from(r.s16()?));
    }
    let mut sign = 1;
    if code == 250 {
        sign = -1;
        code = r.u8()?;
    }
    let out = match code {
        255 => 250 + i32::from(r.u8()?),
        254 => 500 + i32::from(r.u8()?),
        _ => i32::from(code),
    };
    Ok(out * sign)
}

const NPUSHB: i64 = 0x40;
const NPUSHW: i64 = 0x41;
const PUSHB: i64 = 0xb0;
const PUSHW: i64 = 0xb8;

/// The values pushed so far, and how many of the last are of the kind of `last_is_byte`.
struct PushRuns {
    data: Vec<i32>,
    last_is_byte: bool,
    run_count: usize,
}

impl PushRuns {
    fn dump(&self, out: &mut Writer) -> Result<(), MtxError> {
        if self.run_count == 0 {
            return Ok(());
        }
        if self.run_count < 8 {
            let opcode = if self.last_is_byte { PUSHB } else { PUSHW };
            out.u8(opcode | (self.run_count as i64 - 1))?;
        } else {
            out.u8(if self.last_is_byte { NPUSHB } else { NPUSHW })?;
            out.u8(self.run_count as i64)?;
        }
        let run = self.data.len().saturating_sub(self.run_count);
        for &value in &self.data[run..] {
            if self.last_is_byte {
                out.u8(i64::from(value))?;
            } else {
                out.s16(i64::from(value))?;
            }
        }
        Ok(())
    }

    fn put(&mut self, out: &mut Writer, value: i32) -> Result<(), MtxError> {
        let is_byte = (0..256).contains(&value);
        if is_byte != self.last_is_byte || self.run_count == 255 {
            self.dump(out)?;
            self.last_is_byte = is_byte;
            self.run_count = 0;
        }
        self.data.push(value);
        self.run_count += 1;
        Ok(())
    }
}

/// Push-instruction stream (§HopCodes): values become PUSHB/PUSHW/NPUSHB/NPUSHW runs.
fn decode_push_instructions(
    s_in: &mut Reader<'_>,
    out: &mut Writer,
    push_count: i64,
) -> Result<(), MtxError> {
    let mut runs = PushRuns {
        data: Vec::new(),
        last_is_byte: true,
        run_count: 0,
    };
    let mut remaining = push_count;
    while remaining > 0 {
        let code = s_in.peek_u8()?;
        if code == 0xfb {
            // A B 0xFB C -> A B A C A
            if remaining < 3 || runs.data.len() < 2 {
                return Err(MtxError::new("corrupt hop code"));
            }
            remaining -= 3;
            let prev = runs.data[runs.data.len() - 2];
            s_in.u8()?;
            runs.put(out, prev)?;
            let c = read_255_short(s_in)?;
            runs.put(out, c)?;
            runs.put(out, prev)?;
        } else if code == 0xfc {
            // A B 0xFC C D -> A B A C A D A
            if remaining < 5 || runs.data.len() < 2 {
                return Err(MtxError::new("corrupt hop code"));
            }
            remaining -= 5;
            let prev = runs.data[runs.data.len() - 2];
            s_in.u8()?;
            runs.put(out, prev)?;
            let c = read_255_short(s_in)?;
            runs.put(out, c)?;
            runs.put(out, prev)?;
            let d = read_255_short(s_in)?;
            runs.put(out, d)?;
            runs.put(out, prev)?;
        } else {
            let value = read_255_short(s_in)?;
            runs.put(out, value)?;
            remaining -= 1;
        }
    }
    runs.dump(out)
}

fn make_flags(x: i32, y: i32, on_curve: bool, first: bool) -> i64 {
    let mut f = if on_curve { 0x01 } else { 0 };
    if !first && x == 0 {
        f |= 0x10;
    } else if x > -256 && x < 0 {
        f |= 0x02;
    } else if (0..256).contains(&x) {
        f |= 0x02 | 0x10;
    }
    if !first && y == 0 {
        f |= 0x20;
    } else if y > -256 && y < 0 {
        f |= 0x04;
    } else if (0..256).contains(&y) {
        f |= 0x04 | 0x20;
    }
    f
}

fn decode_simple_glyph(
    num_contours: i32,
    streams: &mut [Reader<'_>; 3],
    out: &mut Writer,
    bbox: Option<[i32; 4]>,
) -> Result<(), MtxError> {
    if num_contours == 0 {
        return Ok(());
    }
    let [s_in, push_in, code_in] = streams;
    out.s16(i64::from(num_contours))?;
    let bbox_at = out.pos;
    if let Some(bbox) = bbox {
        for v in bbox {
            out.s16(i64::from(v))?;
        }
    } else {
        out.skip(8)?;
    }
    let mut total_points: i64 = 0;
    for i in 0..num_contours {
        if i == 0 {
            total_points = 1;
        }
        total_points += read_255_ushort(s_in)?;
        out.s16(total_points - 1)?;
    }
    // The TypeScript sizes its point arrays first; growing them as the stream
    // is read keeps a forged count from allocating more than the stream holds.
    let mut flags = Vec::new();
    for _ in 0..total_points {
        if flags.len() == flags.capacity() {
            let more = flags.len() as u64 / 2 + 16;
            reserve(&mut flags, more)?;
        }
        flags.push(s_in.u8()?);
    }
    let mut min_x = 32767;
    let mut min_y = 32767;
    let mut max_x = -32768;
    let mut max_y = -32768;
    let mut cur_x = 0;
    let mut cur_y = 0;
    // one coordinate pair a flag: four bytes each for every byte the stream held
    let mut xs: Vec<i32> = Vec::new();
    let mut ys: Vec<i32> = Vec::new();
    if xs.try_reserve(flags.len()).is_err() || ys.try_reserve(flags.len()).is_err() {
        return Err(MtxError::allocation_failed());
    }
    for &flag in &flags {
        let enc = TRIPLET[usize::from(flag & 0x7f)];
        let more = enc[0] - 1;
        let mut coords = Reader::new(s_in.bytes(more as u64)?);
        let dx = coords.read_n_bits(enc[1] as u32)? as i32;
        let dy = coords.read_n_bits(enc[2] as u32)? as i32;
        if coords.pos != coords.size() || coords.bit_pos != 0 {
            return Err(MtxError::new("triplet width mismatch"));
        }
        let x = i16_of(enc[5] * (dx + enc[3]));
        let y = i16_of(enc[6] * (dy + enc[4]));
        xs.push(x);
        ys.push(y);
        cur_x = i16_of(cur_x + x);
        cur_y = i16_of(cur_y + y);
        if cur_x < min_x {
            min_x = cur_x;
        }
        if cur_x > max_x {
            max_x = cur_x;
        }
        if cur_y < min_y {
            min_y = cur_y;
        }
        if cur_y > max_y {
            max_y = cur_y;
        }
    }
    let code_size_at = out.pos;
    out.skip(2)?;
    let push_count = read_255_ushort(s_in)?;
    decode_push_instructions(push_in, out, push_count)?;
    let code_size = read_255_ushort(s_in)?;
    out.bytes(code_in.bytes(code_size as u64)?)?;
    let unpacked_code_size = out.pos - (code_size_at + 2);
    for (i, ((&flag, &x), &y)) in flags.iter().zip(&xs).zip(&ys).enumerate() {
        out.u8(make_flags(x, y, flag & 0x80 == 0, i == 0))?;
    }
    for arr in [&xs, &ys] {
        for (i, &v) in arr.iter().enumerate() {
            let mut v = v;
            if i == 0 || v != 0 {
                if v > -256 && v < 0 {
                    v = -v;
                }
                if (0..256).contains(&v) {
                    out.u8(i64::from(v))?;
                } else {
                    out.s16(i64::from(v))?;
                }
            }
        }
    }
    let end = out.pos;
    out.pos = code_size_at;
    out.u16(unpacked_code_size as i64)?;
    if bbox.is_none() {
        out.pos = bbox_at;
        out.s16(i64::from(min_x))?;
        out.s16(i64::from(min_y))?;
        out.s16(i64::from(max_x))?;
        out.s16(i64::from(max_y))?;
    }
    out.pos = end;
    Ok(())
}

fn decode_composite_glyph(streams: &mut [Reader<'_>; 3], out: &mut Writer) -> Result<(), MtxError> {
    const ARGS_WORDS: u16 = 0x1;
    const HAVE_SCALE: u16 = 0x8;
    const MORE_COMPONENTS: u16 = 0x20;
    const HAVE_XY_SCALE: u16 = 0x40;
    const HAVE_2_BY_2: u16 = 0x80;
    const HAVE_INSTR: u16 = 0x100;
    let [s_in, push_in, code_in] = streams;
    out.s16(-1)?;
    for _ in 0..4 {
        let v = s_in.s16()?;
        out.s16(i64::from(v))?;
    }
    let mut flags;
    loop {
        flags = s_in.u16()?;
        out.u16(i64::from(flags))?;
        out.bytes(s_in.bytes(2)?)?; // glyph index
        out.bytes(s_in.bytes(if flags & ARGS_WORDS != 0 { 4 } else { 2 })?)?;
        let transform = if flags & HAVE_2_BY_2 != 0 {
            8
        } else if flags & HAVE_XY_SCALE != 0 {
            4
        } else if flags & HAVE_SCALE != 0 {
            2
        } else {
            0
        };
        if transform != 0 {
            out.bytes(s_in.bytes(transform)?)?;
        }
        if flags & MORE_COMPONENTS == 0 {
            break;
        }
    }
    if flags & HAVE_INSTR != 0 {
        let num_instr_at = out.pos;
        out.skip(2)?;
        let push_count = read_255_ushort(s_in)?;
        decode_push_instructions(push_in, out, push_count)?;
        let code_size = read_255_ushort(s_in)?;
        out.bytes(code_in.bytes(code_size as u64)?)?;
        let num_instr = out.pos - (num_instr_at + 2);
        let end = out.pos;
        out.pos = num_instr_at;
        out.u16(num_instr as i64)?;
        out.pos = end;
    }
    Ok(())
}

fn decode_glyph(streams: &mut [Reader<'_>; 3], out: &mut Writer) -> Result<(), MtxError> {
    let mut num_contours = i32::from(streams[0].s16()?);
    if num_contours < 0 {
        return decode_composite_glyph(streams, out);
    }
    let mut bbox = None;
    if num_contours == 0x7fff {
        num_contours = i32::from(streams[0].s16()?);
        bbox = Some([
            i32::from(streams[0].s16()?),
            i32::from(streams[0].s16()?),
            i32::from(streams[0].s16()?),
            i32::from(streams[0].s16()?),
        ]);
    }
    decode_simple_glyph(num_contours, streams, out, bbox)
}

fn unpack_cvt(tbl: &mut Table<'_>, s_in: &mut Reader<'_>) -> Result<(), MtxError> {
    s_in.seek(tbl.offset)?;
    let n = s_in.u16()?;
    let mut out = Writer::new(u64::from(n) * 2)?;
    let mut last = 0;
    for _ in 0..n {
        let code = i32::from(s_in.u8()?);
        let val = if code >= 248 {
            238 * (code - 247) + i32::from(s_in.u8()?)
        } else if code >= 239 {
            -(238 * (code - 239) + i32::from(s_in.u8()?))
        } else if code == 238 {
            i32::from(s_in.s16()?)
        } else {
            code
        };
        last = i16_of(last + val);
        out.s16(i64::from(last))?;
    }
    tbl.data = Some(Cow::Owned(out.result()));
    Ok(())
}

/// The rebuilt glyf and loca, and the indexToLocFormat they were written in.
fn populate_glyf_and_loca(
    glyf_offset: u64,
    index_to_loc_format: i32,
    num_glyphs: u16,
    streams: &mut [Reader<'_>; 3],
) -> Result<(Vec<u8>, Vec<u8>, i32), MtxError> {
    streams[0].seek(glyf_offset)?;
    streams[1].seek(0)?;
    streams[2].seek(0)?;
    let mut out = Writer::new(u64::max(1024, u64::from(num_glyphs) * 64))?;
    let mut offsets = vec![0];
    for _ in 0..num_glyphs {
        decode_glyph(streams, &mut out)?;
        if out.pos % 2 != 0 {
            out.u8(0)?;
        }
        offsets.push(out.pos);
    }
    // The rebuilt glyf writes one flag byte per point (no REPEAT runs), so it can outgrow the
    // 128 KB a short loca addresses even when the source used format 0: promote to long
    let short_loca = index_to_loc_format == 0 && out.pos <= 0x1fffe;
    let mut loca_out = Writer::new((if short_loca { 2 } else { 4 }) * offsets.len() as u64)?;
    for &o in &offsets {
        if short_loca {
            loca_out.u16((o / 2) as i64)?;
        } else {
            loca_out.u32(o as i64)?;
        }
    }
    Ok((
        out.result(),
        loca_out.result(),
        if short_loca { 0 } else { 1 },
    ))
}

/// Big-endian u32 words, the last padded with zeros.
fn checksum(data: &[u8]) -> u32 {
    let mut sum: u32 = 0;
    for chunk in data.chunks(4) {
        let byte = |k: usize| u32::from(chunk.get(k).copied().unwrap_or(0));
        let word = (byte(0) << 24) | (byte(1) << 16) | (byte(2) << 8) | byte(3);
        sum = sum.wrapping_add(word);
    }
    sum
}

fn dump_container(unsorted: Vec<Table<'_>>) -> Result<Vec<u8>, MtxError> {
    // the directory must be in ascending tag order (a synthesized loca would otherwise land last);
    // a tag is four Latin-1 characters, so code units order as bytes do, and the sort is stable
    let mut tables = unsorted;
    tables.sort_by_key(|table| table.tag);
    let n = tables.len() as i64;
    let mut search_range: i64 = 1;
    let mut entry_selector: i64 = 0;
    while search_range * 2 <= n {
        search_range *= 2;
        entry_selector += 1;
    }
    search_range *= 16;
    let data_len: u64 = tables
        .iter()
        .map(|t| t.data.as_deref().map_or(0, <[u8]>::len) as u64 + 3)
        .sum();
    let mut out = Writer::new(12 + 16 * n as u64 + data_len)?;
    out.u32(0x0001_0000)?;
    out.u16(n)?;
    out.u16(search_range)?;
    out.u16(entry_selector)?;
    out.u16(n * 16 - search_range)?;
    let dir_at = out.pos;
    out.skip(16 * n as u64)?;
    let mut total: u32 = 0;
    let mut head_offset = None;
    let mut placed = Vec::with_capacity(tables.len());
    for t in &tables {
        let data = t.data.as_deref().unwrap_or(&[]);
        let offset = out.pos;
        if &t.tag == b"head" {
            head_offset = Some(offset);
        }
        out.bytes(data)?;
        while out.pos % 4 != 0 {
            out.u8(0)?;
        }
        let s = checksum(data);
        placed.push((s, offset, data.len() as u64));
        total = total.wrapping_add(s);
    }
    let end = out.pos;
    out.pos = dir_at;
    for (t, &(sum, offset, length)) in tables.iter().zip(&placed) {
        for &c in &t.tag {
            out.u8(i64::from(c))?;
        }
        out.u32(i64::from(sum))?;
        out.u32(offset as i64)?;
        out.u32(length as i64)?;
    }
    total = total.wrapping_add(checksum(out.prefix(dir_at + 16 * n as u64)));
    let Some(head_offset) = head_offset else {
        return Err(MtxError::new("no head table"));
    };
    out.pos = head_offset + 8;
    out.u32(i64::from(0xb1b0_afba_u32.wrapping_sub(total)))?;
    out.pos = end;
    Ok(out.result())
}

/// A record of the cmap directory kept by `sanitize_cmap`.
struct Kept {
    pid: u16,
    eid: u16,
    off: u64,
    len: u64,
    lang_at: Option<u64>,
}

/// cmap repairs for what Chromium's font sanitizer rejects (fontTools/opentype.js shrug):
/// PowerPoint's embedder leaves a format-14 record whose length runs far past the table, and
/// Windows-platform format-4/12 subtables carrying a non-zero language. Records that do not
/// fit are dropped, the language field is zeroed; a clean table is returned as is.
pub fn sanitize_cmap(data: &[u8]) -> Result<Cow<'_, [u8]>, MtxError> {
    if data.len() < 4 {
        return Ok(Cow::Borrowed(data));
    }
    let length = data.len() as u64;
    let mut r = Reader::new(data);
    r.u16()?;
    let num_tables = r.u16()?;
    if length < 4 + 8 * u64::from(num_tables) {
        return Ok(Cow::Borrowed(data));
    }
    let mut keep = Vec::new();
    let mut dirty = false;
    // a byte past the end is `undefined`, which `<<` and `|` read as 0
    let at = |o: u64| -> u32 {
        usize::try_from(o)
            .ok()
            .and_then(|o| data.get(o))
            .map_or(0, |&b| u32::from(b))
    };
    let u32_at = |o: u64| (at(o) << 24) | (at(o + 1) << 16) | (at(o + 2) << 8) | at(o + 3);
    for _ in 0..num_tables {
        let pid = r.u16()?;
        let eid = r.u16()?;
        let off = u64::from(r.u32()?);
        if off + 4 > length {
            dirty = true;
            continue;
        }
        let fmt = (at(off) << 8) | at(off + 1);
        // formats 8/10/12/13: reserved u16 then u32 length; format 14: u32 length right after the format
        let long = matches!(fmt, 8 | 10 | 12 | 13 | 14);
        if long && off + 8 > length {
            dirty = true;
            continue;
        }
        let len = u64::from(if long {
            u32_at(off + if fmt == 14 { 2 } else { 4 })
        } else {
            (at(off + 2) << 8) | at(off + 3)
        });
        if len < 4 || off + len > length {
            dirty = true;
            continue;
        }
        // language: u16 at +4 (format 4), u32 at +8 (format 12); must be 0 on platform 3
        let mut lang_at = None;
        if pid == 3 && fmt == 4 && ((at(off + 4) << 8) | at(off + 5)) != 0 {
            lang_at = Some(off + 4);
        }
        if pid == 3 && fmt == 12 && u32_at(off + 8) != 0 {
            lang_at = Some(off + 8);
        }
        if lang_at.is_some() {
            dirty = true;
        }
        keep.push(Kept {
            pid,
            eid,
            off,
            len,
            lang_at,
        });
    }
    if !dirty {
        return Ok(Cow::Borrowed(data));
    }
    let mut out = Writer::new(length)?;
    out.u16(0)?;
    out.u16(keep.len() as i64)?;
    // a Map read with has/get/set only: no order to keep
    let mut placed = BTreeMap::new();
    let mut cursor = 4 + 8 * keep.len() as u64;
    for k in &keep {
        placed.entry(k.off).or_insert_with(|| {
            let dst = cursor;
            cursor += k.len;
            dst
        });
    }
    let dst_of = |k: &Kept| placed.get(&k.off).copied().unwrap_or(0);
    for k in &keep {
        out.u16(i64::from(k.pid))?;
        out.u16(i64::from(k.eid))?;
        out.u32(dst_of(k) as i64)?;
    }
    for k in &keep {
        let dst = dst_of(k);
        out.pos = dst;
        out.bytes(slice(data, k.off, k.off + k.len))?;
        if let Some(lang_at) = k.lang_at {
            out.pos = dst + (lang_at - k.off);
            if lang_at == k.off + 4 {
                out.u16(0)?;
            } else {
                out.u32(0)?;
            }
        }
    }
    out.pos = out.size;
    Ok(Cow::Owned(out.result()))
}

/// What `new DataView(data).getUint16(at)` reads, and throws past the end.
fn data_view_u16(table: &Table<'_>, at: usize) -> Result<u16, MtxError> {
    table
        .data
        .as_deref()
        .and_then(|data| data.get(at..at + 2))
        .map(|b| u16::from_be_bytes([b[0], b[1]]))
        .ok_or_else(|| MtxError::host("RangeError", "Offset is outside the bounds of the DataView"))
}

/// Rebuild an sfnt from the three inflated CTF streams (parseCTF + dumpContainer).
pub fn ctf_to_sfnt(streams: [&[u8]; 3]) -> Result<Vec<u8>, MtxError> {
    let mut rs = streams.map(Reader::new);
    let s0 = &mut rs[0];
    s0.u32()?; // scaler type
    let num_tables = s0.u16()?;
    s0.u16()?;
    s0.u16()?;
    s0.u16()?;
    let mut tables = Vec::new();
    for _ in 0..num_tables {
        let tag = [s0.u8()?, s0.u8()?, s0.u8()?, s0.u8()?];
        if &tag == b"hdmx" || &tag == b"VDMX" {
            // device metrics are not reconstructed (libeot parity); rasterizers ignore them
            s0.skip(12)?;
            continue;
        }
        s0.skip(4)?; // checksum
        let offset = u64::from(s0.u32()?);
        let length = u64::from(s0.u32()?);
        tables.push(Table {
            tag,
            offset,
            length,
            data: None,
        });
    }
    let mut glyf = None;
    let mut loca = None;
    let mut maxp = None;
    let mut head = None;
    for (index, t) in tables.iter_mut().enumerate() {
        if &t.tag == b"loca" {
            loca = Some(index);
        } else if &t.tag == b"glyf" {
            glyf = Some(index);
        } else if &t.tag == b"cvt " {
            unpack_cvt(t, &mut rs[0])?;
        } else {
            rs[0].seek(t.offset)?;
            let bytes = rs[0].bytes(t.length)?;
            let mut data = if &t.tag == b"cmap" {
                sanitize_cmap(bytes)?
            } else {
                Cow::Borrowed(bytes)
            };
            if &t.tag == b"maxp" {
                maxp = Some(index);
            }
            if &t.tag == b"head" {
                head = Some(index);
                if data.len() < 52 {
                    return Err(MtxError::new("malformed head table"));
                }
                data.to_mut()[8..12].fill(0); // checksumAdjustment is recomputed on dump
            }
            t.data = Some(data);
        }
    }
    let (Some(head), Some(maxp)) = (head, maxp) else {
        return Err(MtxError::new("CTF lacks head/maxp"));
    };
    if glyf.is_some() && loca.is_none() {
        loca = Some(tables.len());
        tables.push(Table {
            tag: *b"loca",
            offset: 0,
            length: 0,
            data: None,
        });
    }
    if let (Some(glyf), Some(loca)) = (glyf, loca) {
        let index_to_loc_format = i32::from(data_view_u16(&tables[head], 50)? as i16);
        let num_glyphs = data_view_u16(&tables[maxp], 4)?;
        let (glyf_data, loca_data, written) = populate_glyf_and_loca(
            tables[glyf].offset,
            index_to_loc_format,
            num_glyphs,
            &mut rs,
        )?;
        tables[glyf].data = Some(Cow::Owned(glyf_data));
        tables[loca].data = Some(Cow::Owned(loca_data));
        if written != index_to_loc_format
            && let Some(data) = tables[head].data.as_mut()
        {
            data.to_mut()[50..52].copy_from_slice(&(written as i16).to_be_bytes());
        }
    }
    for t in &mut tables {
        t.data.get_or_insert(Cow::Borrowed(&[]));
    }
    dump_container(tables)
}
