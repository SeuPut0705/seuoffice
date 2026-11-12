//! `apps/pdf/src/main/font-cmap.ts`: a minimal sfnt cmap reader. Can the face
//! map every char of a string? Formats 4 and 12 only.
//!
//! A `Buffer` read past the end throws `ERR_OUT_OF_RANGE`; every read here
//! answers `Err(OutOfRange)` instead, and [`font_covers_text`] turns it into
//! `false` as the TypeScript's `catch` does.

/// `ERR_OUT_OF_RANGE` of `readUInt16BE` and friends
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutOfRange;

type Read<T> = Result<T, OutOfRange>;

fn bytes_at(b: &[u8], offset: i64, len: usize) -> Read<&[u8]> {
    if offset < 0 {
        return Err(OutOfRange);
    }
    let at = offset as u64;
    if at + len as u64 > b.len() as u64 {
        return Err(OutOfRange);
    }
    Ok(&b[at as usize..at as usize + len])
}

/// `readUInt16BE(offset)`
pub(crate) fn u16_at(b: &[u8], offset: i64) -> Read<i64> {
    let s = bytes_at(b, offset, 2)?;
    Ok(i64::from(u16::from_be_bytes([s[0], s[1]])))
}

/// `readInt16BE(offset)`
pub(crate) fn i16_at(b: &[u8], offset: i64) -> Read<i64> {
    let s = bytes_at(b, offset, 2)?;
    Ok(i64::from(i16::from_be_bytes([s[0], s[1]])))
}

/// `readUInt32BE(offset)`
pub(crate) fn u32_at(b: &[u8], offset: i64) -> Read<i64> {
    let s = bytes_at(b, offset, 4)?;
    Ok(i64::from(u32::from_be_bytes([s[0], s[1], s[2], s[3]])))
}

/// `font.toString('latin1', start, end)`: both ends clamp to the buffer
pub(crate) fn latin1(b: &[u8], start: i64, end: i64) -> String {
    let len = b.len() as i64;
    let start = start.clamp(0, len);
    let end = end.clamp(0, len);
    if start >= end {
        return String::new();
    }
    b[start as usize..end as usize]
        .iter()
        .map(|&c| char::from(c))
        .collect()
}

fn table_offset(font: &[u8], tag: &str) -> Read<i64> {
    let num_tables = u16_at(font, 4)?;
    for i in 0..num_tables {
        let rec = 12 + i * 16;
        if latin1(font, rec, rec + 4) == tag {
            return u32_at(font, rec + 8);
        }
    }
    Ok(-1)
}

struct Subtable {
    offset: i64,
    format: i64,
}

fn cmap_subtable(font: &[u8]) -> Read<Option<Subtable>> {
    let cmap = table_offset(font, "cmap")?;
    if cmap < 0 {
        return Ok(None);
    }
    let n = u16_at(font, cmap + 2)?;
    let mut best: Option<Subtable> = None;
    for i in 0..n {
        let rec = cmap + 4 + i * 8;
        let platform = u16_at(font, rec)?;
        let encoding = u16_at(font, rec + 2)?;
        if platform != 0 && !(platform == 3 && (encoding == 1 || encoding == 10)) {
            continue;
        }
        let offset = cmap + u32_at(font, rec + 4)?;
        let format = u16_at(font, offset)?;
        if format == 12 {
            return Ok(Some(Subtable { offset, format }));
        }
        if format == 4 && best.is_none() {
            best = Some(Subtable { offset, format });
        }
    }
    Ok(best)
}

/// Glyph id for a codepoint, 0 = unmapped (.notdef)
fn glyph_id(font: &[u8], sub: &Subtable, cp: i64) -> Read<i64> {
    let o = sub.offset;
    if sub.format == 12 {
        let groups = u32_at(font, o + 12)?;
        for i in 0..groups {
            let g = o + 16 + i * 12;
            if cp < u32_at(font, g)? {
                return Ok(0); // groups are sorted ascending
            }
            if cp <= u32_at(font, g + 4)? {
                return Ok(u32_at(font, g + 8)? + (cp - u32_at(font, g)?));
            }
        }
        return Ok(0);
    }
    if cp > 0xffff {
        return Ok(0);
    }
    let seg_x2 = u16_at(font, o + 6)?;
    let ends = o + 14;
    let starts = ends + seg_x2 + 2;
    let deltas = starts + seg_x2;
    let range_offs = deltas + seg_x2;
    let mut s = 0;
    while s < seg_x2 {
        if cp > u16_at(font, ends + s)? {
            s += 2;
            continue;
        }
        if cp < u16_at(font, starts + s)? {
            return Ok(0);
        }
        let ro = u16_at(font, range_offs + s)?;
        if ro == 0 {
            return Ok((cp + i16_at(font, deltas + s)?) & 0xffff);
        }
        let gi = u16_at(
            font,
            range_offs + s + ro + (cp - u16_at(font, starts + s)?) * 2,
        )?;
        return Ok(if gi == 0 {
            0
        } else {
            (gi + i16_at(font, deltas + s)?) & 0xffff
        });
    }
    Ok(0)
}

fn has_glyph(font: &[u8], sub: &Subtable, cp: i64) -> Read<bool> {
    Ok(glyph_id(font, sub, cp)? != 0)
}

fn covers(font: &[u8], chars: &[char]) -> Read<bool> {
    let Some(sub) = cmap_subtable(font)? else {
        return Ok(false);
    };
    for c in chars {
        if !has_glyph(font, &sub, i64::from(u32::from(*c)))? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// True when the font maps every drawn char of text (unparseable font = false).
/// Only line breaks are excluded: Unicode spaces (NBSP, U+3000, ...) are drawn like any
/// glyph and must be mapped.
pub fn font_covers_text(font: &[u8], text: &str) -> bool {
    let chars: Vec<char> = text.chars().filter(|c| !matches!(c, '\r' | '\n')).collect();
    if chars.is_empty() {
        return true;
    }
    covers(font, &chars).unwrap_or(false)
}
