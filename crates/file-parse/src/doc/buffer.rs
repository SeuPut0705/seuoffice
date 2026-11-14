//! The parts of Node 22's `Buffer` the readers of word-extractor use, with
//! the errors Node throws. A position or length is a JavaScript number
//! (`f64`): fractional, NaN, negative or past the end after a bad field.

use crate::compound_gate::Thrown;

/// `2 ** 32`.
const TWO_32: f64 = 4_294_967_296.0;
const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// Node's `addNumericalSeparator`.
fn add_numerical_separator(text: &str) -> String {
    let units: Vec<char> = text.chars().collect();
    let start = usize::from(units.first() == Some(&'-'));
    let mut at = units.len();
    let mut tail = String::new();
    while at >= start + 4 {
        let piece: String = units[at - 3..at].iter().collect();
        tail = format!("_{piece}{tail}");
        at -= 3;
    }
    let head: String = units[..at].iter().collect();
    format!("{head}{tail}")
}

/// The `Received` part of `ERR_OUT_OF_RANGE`.
fn received(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() > TWO_32 {
        return add_numerical_separator(&jscompat::number_to_string(value));
    }
    if value == 0.0 && value.is_sign_negative() {
        return "-0".to_owned();
    }
    jscompat::number_to_string(value)
}

fn out_of_range(name: &str, range: &str, value: f64) -> Thrown {
    Thrown::Range(format!(
        "The value of \"{name}\" is out of range. It must be {range}. Received {}",
        received(value)
    ))
}

/// Node's `boundsError(offset, length)`.
fn bounds_error(value: f64, length: f64) -> Thrown {
    if value.floor() != value {
        return out_of_range("offset", "an integer", value);
    }
    if length < 0.0 {
        return Thrown::Range("Attempt to access memory outside buffer bounds".into());
    }
    out_of_range(
        "offset",
        &format!(">= 0 and <= {}", jscompat::number_to_string(length)),
        value,
    )
}

/// A `Buffer` (read only).
#[derive(Clone, Copy)]
pub struct Buf<'a> {
    pub data: &'a [u8],
}

impl<'a> Buf<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data }
    }

    pub fn len(&self) -> f64 {
        self.data.len() as f64
    }

    /// `this[at]`: `None` is `undefined`.
    pub fn at(&self, at: f64) -> Option<u8> {
        if at.fract() != 0.0 || at < 0.0 || at >= self.len() {
            return None;
        }
        self.data.get(at as usize).copied()
    }

    pub fn read_u8(&self, offset: f64) -> Result<f64, Thrown> {
        match self.at(offset) {
            Some(value) => Ok(f64::from(value)),
            None => Err(bounds_error(offset, self.len() - 1.0)),
        }
    }

    pub fn read_i8(&self, offset: f64) -> Result<f64, Thrown> {
        self.read_u8(offset)
            .map(|value| f64::from(value as u8 as i8))
    }

    fn pair(&self, offset: f64, count: f64) -> Result<(), Thrown> {
        if self.at(offset).is_none() || self.at(offset + count - 1.0).is_none() {
            return Err(bounds_error(offset, self.len() - count));
        }
        Ok(())
    }

    pub fn read_u16le(&self, offset: f64) -> Result<f64, Thrown> {
        self.pair(offset, 2.0)?;
        let at = offset as usize;
        Ok(f64::from(u16::from_le_bytes([
            self.data[at],
            self.data[at + 1],
        ])))
    }

    pub fn read_i16le(&self, offset: f64) -> Result<f64, Thrown> {
        self.read_u16le(offset)
            .map(|value| f64::from(value as u16 as i16))
    }

    pub fn read_u16be(&self, offset: f64) -> Result<f64, Thrown> {
        self.pair(offset, 2.0)?;
        let at = offset as usize;
        Ok(f64::from(u16::from_be_bytes([
            self.data[at],
            self.data[at + 1],
        ])))
    }

    pub fn read_u32le(&self, offset: f64) -> Result<f64, Thrown> {
        self.pair(offset, 4.0)?;
        let at = offset as usize;
        Ok(f64::from(u32::from_le_bytes([
            self.data[at],
            self.data[at + 1],
            self.data[at + 2],
            self.data[at + 3],
        ])))
    }

    pub fn read_i32le(&self, offset: f64) -> Result<f64, Thrown> {
        self.read_u32le(offset)
            .map(|value| f64::from(value as u32 as i32))
    }

    /// `slice(start, end)`.
    pub fn slice(&self, start: f64, end: f64) -> Buf<'a> {
        let len = self.len();
        let (start, end) = (adjust_offset(start, len), adjust_offset(end, len));
        if end > start {
            Buf::new(&self.data[start as usize..end as usize])
        } else {
            Buf::new(&[])
        }
    }

    /// `toString('ucs2')`: a trailing odd byte is dropped.
    pub fn to_ucs2(self) -> Vec<u16> {
        self.data
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
            .collect()
    }

    /// `toString('binary')`.
    pub fn to_latin1(self) -> Vec<u16> {
        self.data.iter().map(|&byte| u16::from(byte)).collect()
    }

    /// `toString('utf16le', start, end)` with its clamping.
    pub fn to_ucs2_range(self, start: f64, end: f64) -> Vec<u16> {
        let len = self.len();
        let start = if start.is_nan() || start < 0.0 {
            0.0
        } else {
            start.min(len)
        };
        let end = if end.is_nan() { 0.0 } else { end.min(len) };
        if end <= start {
            return Vec::new();
        }
        Buf::new(&self.data[start as usize..end as usize]).to_ucs2()
    }
}

/// Node's `adjustOffset`.
pub fn adjust_offset(offset: f64, length: f64) -> f64 {
    let offset = offset.trunc();
    if offset == 0.0 || offset.is_nan() {
        0.0
    } else if offset < 0.0 {
        (offset + length).max(0.0)
    } else if offset < length {
        offset
    } else {
        length
    }
}

/// Node's `toInteger(n, 0)` of `buffer.js`.
fn to_integer(value: f64) -> f64 {
    if !value.is_nan() && (-MAX_SAFE..=MAX_SAFE).contains(&value) {
        value.floor()
    } else {
        0.0
    }
}

/// `source.copy(target, target_start, source_start, source_end)`: bytes copied.
pub fn copy(
    source: &[u8],
    target: &mut [u8],
    target_start: f64,
    source_start: f64,
    source_end: f64,
) -> Result<usize, Thrown> {
    let integer = |value: f64| {
        if value.is_finite() && value.fract() == 0.0 {
            value
        } else {
            to_integer(value)
        }
    };
    let target_start = integer(target_start);
    if target_start < 0.0 {
        return Err(out_of_range("targetStart", ">= 0", target_start));
    }
    let source_len = source.len() as f64;
    let source_start = integer(source_start);
    if source_start < 0.0 || source_start > source_len {
        return Err(out_of_range(
            "sourceStart",
            &format!(">= 0 && <= {}", jscompat::number_to_string(source_len)),
            source_start,
        ));
    }
    let source_end = integer(source_end);
    if source_end < 0.0 {
        return Err(out_of_range("sourceEnd", ">= 0", source_end));
    }
    let target_len = target.len() as f64;
    if target_start >= target_len || source_start >= source_end {
        return Ok(0);
    }
    let mut count = source_end - source_start;
    if count > target_len - target_start {
        count = target_len - target_start;
    }
    count = count.min(source_len - source_start);
    if count <= 0.0 {
        return Ok(0);
    }
    let (from, to, count) = (source_start as usize, target_start as usize, count as usize);
    target[to..to + count].copy_from_slice(&source[from..from + count]);
    Ok(count)
}
