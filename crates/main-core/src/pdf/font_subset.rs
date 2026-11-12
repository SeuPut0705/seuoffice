//! `apps/pdf/src/main/font-subset.ts`: subset a TrueType font to the glyphs a
//! text needs through hb-subset, and rewrite a CID-keyed CFF's charset to the
//! identity mapping.
//!
//! The wasm instance of the TypeScript (`loadHb`, read from
//! `hbSubsetWasmPath()`) is the caller's here: an [`HbSubset`] over the
//! exports the module calls. Its serialising `chain` is the borrow.
//!
//! `identityCffCharset` reads a `Buffer`, and a read past the end throws a
//! Node error with a `code` and a message of its own; [`Thrown`] carries both,
//! worded as `lib/internal/buffer.js` and `lib/internal/errors.js` of Node 22
//! word them.

use jscompat::number_to_string;

/// What the TypeScript throws: an `Error` (no `code`) or a Node error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thrown {
    pub code: Option<&'static str>,
    pub message: String,
}

impl Thrown {
    fn plain(message: impl Into<String>) -> Self {
        Thrown {
            code: None,
            message: message.into(),
        }
    }
}

/// The hb-subset.wasm exports the module calls (numbers are pointers into its
/// linear memory).
pub trait HbSubset {
    /// `new Uint8Array(hb.memory.buffer)`
    fn memory(&self) -> &[u8];
    fn memory_mut(&mut self) -> &mut [u8];
    fn malloc(&mut self, size: u32) -> u32;
    fn free(&mut self, ptr: u32);
    fn hb_blob_create(
        &mut self,
        data: u32,
        len: u32,
        mode: u32,
        user_data: u32,
        destroy: u32,
    ) -> u32;
    fn hb_blob_destroy(&mut self, blob: u32);
    fn hb_blob_get_data(&mut self, blob: u32, len: u32) -> u32;
    fn hb_blob_get_length(&mut self, blob: u32) -> u32;
    fn hb_face_create(&mut self, blob: u32, index: u32) -> u32;
    fn hb_face_destroy(&mut self, face: u32);
    fn hb_face_reference_blob(&mut self, face: u32) -> u32;
    fn hb_set_add(&mut self, set: u32, value: u32);
    fn hb_set_clear(&mut self, set: u32);
    fn hb_set_invert(&mut self, set: u32);
    fn hb_subset_input_create_or_fail(&mut self) -> u32;
    fn hb_subset_input_destroy(&mut self, input: u32);
    fn hb_subset_input_set(&mut self, input: u32, set_type: u32) -> u32;
    fn hb_subset_input_unicode_set(&mut self, input: u32) -> u32;
    fn hb_subset_or_fail(&mut self, face: u32, input: u32) -> u32;
}

const HB_MEMORY_MODE_WRITABLE: u32 = 2;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG: u32 = 6;

/// Subset a TrueType font to the glyphs needed for text (layout features kept).
/// Same hb-subset calls as the subset-font npm package.
pub fn subset_ttf<H: HbSubset + ?Sized>(
    hb: &mut H,
    font: &[u8],
    text: &str,
) -> Result<Vec<u8>, Thrown> {
    let input = hb.hb_subset_input_create_or_fail();
    if input == 0 {
        return Err(Thrown::plain("hb_subset_input_create_or_fail failed"));
    }

    let font_ptr = hb.malloc(font.len() as u32);
    // Views are re-taken after every alloc: malloc may grow (and detach) the memory
    let at = font_ptr as usize;
    if at + font.len() > hb.memory().len() {
        return Err(Thrown::plain("offset is out of bounds"));
    }
    hb.memory_mut()[at..at + font.len()].copy_from_slice(font);
    let blob = hb.hb_blob_create(font_ptr, font.len() as u32, HB_MEMORY_MODE_WRITABLE, 0, 0);
    let face = hb.hb_face_create(blob, 0);
    hb.hb_blob_destroy(blob);

    let mut subset = 0;
    let mut result = 0;
    let out = (|| {
        // Keep all layout features (equivalent of hb-subset --font-features='*')
        let features = hb.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG);
        hb.hb_set_clear(features);
        hb.hb_set_invert(features);

        let unicodes = hb.hb_subset_input_unicode_set(input);
        for ch in text.chars() {
            hb.hb_set_add(unicodes, u32::from(ch));
        }

        subset = hb.hb_subset_or_fail(face, input);
        if subset == 0 {
            return Err(Thrown::plain("hb_subset_or_fail failed (corrupt font?)"));
        }

        result = hb.hb_face_reference_blob(subset);
        let len = hb.hb_blob_get_length(result);
        if len == 0 {
            return Err(Thrown::plain("hb-subset produced an empty font"));
        }
        let data = hb.hb_blob_get_data(result, 0);
        // subarray(data, data + len) clamps to the memory
        let memory = hb.memory();
        let start = (data as usize).min(memory.len());
        let end = (data as usize + len as usize).min(memory.len()).max(start);
        Ok(memory[start..end].to_vec())
    })();
    if result != 0 {
        hb.hb_blob_destroy(result);
    }
    if subset != 0 {
        hb.hb_face_destroy(subset);
    }
    hb.hb_face_destroy(face);
    hb.hb_subset_input_destroy(input);
    hb.free(font_ptr);
    out
}

// ---- the Buffer of Node 22 ------------------------------------------------

/// `Number.isInteger(input) && Math.abs(input) > 2 ** 32` prints with `_`
/// every three digits (`addNumericalSeparator`); anything else as `inspect`
fn received(input: f64) -> String {
    if input.is_finite() && input.fract() == 0.0 && input.abs() > 4_294_967_296.0 {
        let text = number_to_string(input);
        let (sign, digits) = match text.strip_prefix('-') {
            Some(rest) => ("-", rest),
            None => ("", text.as_str()),
        };
        let mut out = String::new();
        for (i, c) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i) % 3 == 0 {
                out.push('_');
            }
            out.push(c);
        }
        return format!("{sign}{out}");
    }
    if input == 0.0 && input.is_sign_negative() {
        return "-0".to_owned();
    }
    number_to_string(input)
}

/// `ERR_OUT_OF_RANGE`
fn out_of_range(name: &str, range: &str, input: f64) -> Thrown {
    Thrown {
        code: Some("ERR_OUT_OF_RANGE"),
        message: format!(
            "The value of \"{name}\" is out of range. It must be {range}. Received {}",
            received(input)
        ),
    }
}

/// `boundsError(value, length, type)` of `lib/internal/buffer.js`
fn bounds_error(value: f64, length: f64, name: Option<&str>) -> Thrown {
    if value.floor() != value {
        // MathFloor(NaN) !== NaN, and validateNumber(value) holds for a number
        return out_of_range(name.unwrap_or("offset"), "an integer", value);
    }
    if length < 0.0 {
        return Thrown {
            code: Some("ERR_BUFFER_OUT_OF_BOUNDS"),
            message: "Attempt to access memory outside buffer bounds".to_owned(),
        };
    }
    let low = if name.is_some() { 1 } else { 0 };
    out_of_range(
        name.unwrap_or("offset"),
        &format!(">= {low} and <= {}", number_to_string(length)),
        value,
    )
}

/// `buf[index]`: `undefined` (`None`) for a non-integer or out of range index
fn at(b: &[u8], index: f64) -> Option<u8> {
    if index.fract() != 0.0 || index.is_nan() || index < 0.0 {
        return None;
    }
    b.get(index as usize).copied()
}

fn read_be(b: &[u8], offset: f64, size: usize) -> Result<u64, Thrown> {
    let mut value: u64 = 0;
    for k in 0..size {
        match at(b, offset + k as f64) {
            Some(byte) => value = value * 256 + u64::from(byte),
            None => return Err(bounds_error(offset, b.len() as f64 - size as f64, None)),
        }
    }
    Ok(value)
}

fn read_u16(b: &[u8], offset: f64) -> Result<f64, Thrown> {
    read_be(b, offset, 2).map(|v| v as f64)
}

fn read_u32(b: &[u8], offset: f64) -> Result<f64, Thrown> {
    read_be(b, offset, 4).map(|v| v as f64)
}

fn read_i16(b: &[u8], offset: f64) -> Result<f64, Thrown> {
    read_be(b, offset, 2).map(|v| f64::from(v as u16 as i16))
}

fn read_i32(b: &[u8], offset: f64) -> Result<f64, Thrown> {
    read_be(b, offset, 4).map(|v| f64::from(v as u32 as i32))
}

/// `buf.readUIntBE(offset, byteLength)` with `byteLength` as the TypeScript
/// passes it: a byte of the font, `undefined` past its end (`None`)
fn read_uint_be(b: &[u8], offset: f64, byte_length: Option<u8>) -> Result<f64, Thrown> {
    match byte_length {
        Some(n @ 1..=6) => read_be(b, offset, usize::from(n)).map(|v| v as f64),
        Some(n) => Err(bounds_error(f64::from(n), 6.0, Some("byteLength"))),
        None => Err(Thrown {
            code: Some("ERR_INVALID_ARG_TYPE"),
            message: "The \"byteLength\" argument must be of type number. Received undefined"
                .to_owned(),
        }),
    }
}

/// `writeUInt16BE(value, offset)`; the values here fit
fn write_u16(out: &mut [u8], value: f64, offset: f64) -> Result<(), Thrown> {
    let (first, last) = (at(out, offset).is_none(), at(out, offset + 1.0).is_none());
    if first || last {
        return Err(bounds_error(offset, out.len() as f64 - 2.0, None));
    }
    let at0 = offset as usize;
    out[at0..at0 + 2].copy_from_slice(&(value as u16).to_be_bytes());
    Ok(())
}

/// `out[index] = value` on a typed array: a write past the end is ignored
fn set_byte(out: &mut [u8], index: f64, value: u8) {
    if index.fract() == 0.0 && index >= 0.0 && (index as usize) < out.len() {
        out[index as usize] = value;
    }
}

// ---- CFF ---------------------------------------------------------------------

/// Read one CFF INDEX at `p`, returning item [start,end) pairs and the end position
fn read_cff_index(b: &[u8], p: f64) -> Result<(Vec<(f64, f64)>, f64), Thrown> {
    let count = read_u16(b, p)?;
    if count == 0.0 {
        return Ok((Vec::new(), p + 2.0));
    }
    // `b[p + 2]!`: undefined past the end, which makes every offset NaN
    let off_size = at(b, p + 2.0);
    let size_f = off_size.map_or(f64::NAN, f64::from);
    let read_off = |i: f64| read_uint_be(b, p + 3.0 + i * size_f, off_size);
    let data_start = p + 3.0 + (count + 1.0) * size_f - 1.0;
    let mut items = Vec::new();
    let mut i = 0.0;
    while i < count {
        items.push((data_start + read_off(i)?, data_start + read_off(i + 1.0)?));
        i += 1.0;
    }
    Ok((items, data_start + read_off(count)?))
}

/// Operator -> last operands of a CFF DICT: only the operators the caller reads
struct CffDict {
    cid_keyed: bool,
    charset: Option<Vec<f64>>,
    char_strings: Option<Vec<f64>>,
}

fn parse_cff_dict(b: &[u8], start: f64, end: f64) -> Result<CffDict, Thrown> {
    let mut dict = CffDict {
        cid_keyed: false,
        charset: None,
        char_strings: None,
    };
    let mut operands: Vec<f64> = Vec::new();
    let mut i = start;
    while i < end {
        // `b[i]!`: undefined past the end, which no branch below takes except the last
        let b0 = at(b, i).map(i32::from);
        match b0 {
            Some(b0) if b0 <= 21 => {
                let mut op = f64::from(b0);
                if b0 == 12 {
                    i += 1.0;
                    op = 1200.0 + at(b, i).map_or(f64::NAN, f64::from);
                }
                if op == 1230.0 {
                    dict.cid_keyed = true;
                }
                if op == 15.0 {
                    dict.charset = Some(std::mem::take(&mut operands));
                } else if op == 17.0 {
                    dict.char_strings = Some(std::mem::take(&mut operands));
                }
                operands = Vec::new();
                i += 1.0;
            }
            Some(28) => {
                operands.push(read_i16(b, i + 1.0)?);
                i += 3.0;
            }
            Some(29) => {
                operands.push(read_i32(b, i + 1.0)?);
                i += 5.0;
            }
            Some(30) => {
                // real number: nibbles until an 0xf terminator
                i += 1.0;
                while i < end {
                    let byte = at(b, i).unwrap_or(0);
                    if (byte & 0x0f) == 0x0f || (byte >> 4) == 0x0f {
                        break;
                    }
                    i += 1.0;
                }
                i += 1.0;
                operands.push(f64::NAN);
            }
            Some(b0) if (32..=246).contains(&b0) => {
                operands.push(f64::from(b0 - 139));
                i += 1.0;
            }
            Some(b0) if (247..=250).contains(&b0) => {
                let next = at(b, i + 1.0).map_or(f64::NAN, f64::from);
                operands.push(f64::from(b0 - 247) * 256.0 + next + 108.0);
                i += 2.0;
            }
            Some(b0) if (251..=254).contains(&b0) => {
                let next = at(b, i + 1.0).map_or(f64::NAN, f64::from);
                operands.push(-f64::from(b0 - 251) * 256.0 - next - 108.0);
                i += 2.0;
            }
            _ => i += 1.0,
        }
    }
    Ok(dict)
}

/// Rewrite a CID-keyed CFF's charset to the identity mapping, in a copy of the font.
///
/// PDFium authors text by GID (Identity-H with CID=GID), but a CID-keyed CFF subset keeps
/// the ORIGINAL CIDs in its charset: conforming viewers resolve CID to glyph through the
/// charset, find nothing at CID=GID, and render blanks. An identity charset (glyph i is
/// CID i) makes both interpretations agree. Fails when the font is not rewritable.
/// Non-CID CFFs and glyf-flavored fonts pass through.
pub fn identity_cff_charset(font: &[u8]) -> Result<Vec<u8>, Thrown> {
    if font.len() < 12 || read_u32(font, 0.0)? != f64::from(0x4f54_544fu32) {
        return Ok(font.to_vec()); // not OTTO
    }
    let num_tables = read_u16(font, 4.0)?;
    let mut cff_off = -1.0;
    let mut t = 0.0;
    while t < num_tables {
        let rec = 12.0 + 16.0 * t;
        let tag: String = (0..4)
            .filter_map(|k| at(font, rec + f64::from(k)))
            .map(char::from)
            .collect();
        if tag == "CFF " {
            cff_off = read_u32(font, rec + 8.0)?;
            break;
        }
        t += 1.0;
    }
    if cff_off < 0.0 {
        return Ok(font.to_vec());
    }
    let hdr_size = at(font, cff_off + 2.0).map_or(f64::NAN, f64::from);
    let (_, name_end) = read_cff_index(font, cff_off + hdr_size)?;
    let (top_items, _) = read_cff_index(font, name_end)?;
    let Some(&(top_start, top_end)) = top_items.first() else {
        return Err(Thrown::plain("CFF top DICT missing"));
    };
    let ops = parse_cff_dict(font, top_start, top_end)?;
    if !ops.cid_keyed {
        return Ok(font.to_vec()); // not CID-keyed: GID addressing already works
    }
    let charset_off = ops.charset.as_ref().and_then(|v| v.first()).copied();
    let char_strings_off = ops.char_strings.as_ref().and_then(|v| v.first()).copied();
    let (Some(charset_off), Some(char_strings_off)) = (charset_off, char_strings_off) else {
        return Err(Thrown::plain("CID-keyed CFF without a custom charset"));
    };
    if charset_off <= 2.0 {
        return Err(Thrown::plain("CID-keyed CFF without a custom charset"));
    }
    let n_glyphs = read_u16(font, cff_off + char_strings_off)?;
    let cs = cff_off + charset_off;
    // The identity range must fit inside the old charset (in-place rewrite): size it first
    let fmt = at(font, cs);

    let old_size: f64 = match fmt {
        Some(0) => 1.0 + 2.0 * (n_glyphs - 1.0),
        Some(f @ (1 | 2)) => {
            let step = if f == 1 { 3.0 } else { 4.0 }; // Range1: u16 first + u8 nLeft; Range2: u16 first + u16 nLeft
            let mut covered = 1.0;
            let mut p = cs + 1.0;
            while covered < n_glyphs {
                let n_left = if f == 1 {
                    at(font, p + 2.0).map_or(f64::NAN, f64::from)
                } else {
                    read_u16(font, p + 2.0)?
                };
                covered += n_left + 1.0;
                p += step;
            }
            p - cs
        }
        other => {
            return Err(Thrown::plain(format!(
                "unknown CFF charset format {}",
                other.map_or_else(|| "undefined".to_owned(), |f| f.to_string())
            )));
        }
    };
    let mut out = font.to_vec();
    if n_glyphs >= 2.0 && old_size >= 5.0 {
        set_byte(&mut out, cs, 2); // one range: glyphs 1..nGlyphs-1 become CIDs 1..nGlyphs-1
        write_u16(&mut out, 1.0, cs + 1.0)?;
        write_u16(&mut out, n_glyphs - 2.0, cs + 3.0)?;
    } else if n_glyphs >= 2.0 && old_size == 4.0 && n_glyphs - 2.0 <= 255.0 {
        set_byte(&mut out, cs, 1);
        write_u16(&mut out, 1.0, cs + 1.0)?;
        set_byte(&mut out, cs + 3.0, (n_glyphs - 2.0) as u8);
    } else if n_glyphs != 1.0 {
        return Err(Thrown::plain(
            "CFF charset too small for an in-place identity rewrite",
        ));
    }
    Ok(out)
}
