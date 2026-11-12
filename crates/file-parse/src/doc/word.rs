//! `word-ole-extractor.js`, `filters.js` and the `Document` accessors of
//! word-extractor 1.0.4, for the OLE path of `extract`: what `getBody` and
//! `getTextboxes` of `docToText` read.
//!
//! Positions and lengths are JavaScript numbers (`f64`). A piece's text is a
//! JavaScript string, so it is UTF-16 units. A run of text a piece is asked to
//! blank out can be longer than the file; one of more than `MAX_RUN` units is
//! refused with an `Error` that starts `doc:` (V8 refuses past
//! `MAX_STRING_LENGTH` with `RangeError: Invalid string length`).

use super::buffer::Buf;
use super::ole::CompoundDoc;
use crate::compound_gate::Thrown;

pub type Text = Vec<u16>;

/// V8's `String::kMaxLength`.
const MAX_STRING_LENGTH: f64 = 536_870_888.0;
/// The longest run of blanked text held here.
const MAX_RUN: f64 = (1u64 << 26) as f64;

/// `Math.trunc`, NaN as 0 (`ToIntegerOrInfinity`).
fn to_integer(value: f64) -> f64 {
    if value.is_nan() { 0.0 } else { value.trunc() }
}

/// `string.slice(from, to)`.
fn js_slice(text: &[u16], from: f64, to: Option<f64>) -> Text {
    let len = text.len() as f64;
    let resolve = |value: f64| {
        let value = to_integer(value);
        if value < 0.0 {
            (len + value).max(0.0)
        } else {
            value.min(len)
        }
    };
    let from = resolve(from);
    let to = to.map_or(len, resolve);
    if to > from {
        text[from as usize..to as usize].to_vec()
    } else {
        Vec::new()
    }
}

/// `string.substring(start, end)`.
fn js_substring(text: &[u16], start: f64, end: f64) -> Text {
    let len = text.len() as f64;
    let clamp = |value: f64| to_integer(value).clamp(0.0, len);
    let (a, b) = (clamp(start), clamp(end));
    let (from, to) = if a > b { (b, a) } else { (a, b) };
    text[from as usize..to as usize].to_vec()
}

/// `a + ''.padStart(n, ch) + b`, with V8's limit on a string.
fn assemble(prefix: Text, pad: f64, unit: u16, suffix: Text) -> Result<Text, Thrown> {
    let pad = if pad.is_nan() || pad < 0.0 {
        0.0
    } else {
        pad.trunc()
    };
    let total = prefix.len() as f64 + pad + suffix.len() as f64;
    if pad > MAX_STRING_LENGTH || total > MAX_STRING_LENGTH {
        return Err(Thrown::Range("Invalid string length".into()));
    }
    if pad > MAX_RUN || total > MAX_RUN * 2.0 {
        return Err(Thrown::Error("doc: a run of text too long to hold".into()));
    }
    let mut out = prefix;
    out.extend(std::iter::repeat_n(unit, pad as usize));
    out.extend(suffix);
    Ok(out)
}

pub struct Piece {
    start_cp: f64,
    start_file_pos: f64,
    bpc: f64,
    size: f64,
    text: Text,
    length: f64,
    end_cp: f64,
    end_file_pos: f64,
}

/// `getPieceIndexByCP`.
fn piece_index_by_cp(pieces: &[Piece], position: f64) -> Option<usize> {
    pieces.iter().position(|piece| position <= piece.end_cp)
}

/// `getPieceIndexByFilePos`.
fn piece_index_by_file_pos(pieces: &[Piece], position: f64) -> Option<usize> {
    pieces
        .iter()
        .position(|piece| position <= piece.end_file_pos)
}

/// `getTextRangeByCP`.
fn text_range_by_cp(pieces: &[Piece], start: f64, end: f64) -> Text {
    let (Some(start_piece), Some(end_piece)) = (
        piece_index_by_cp(pieces, start),
        piece_index_by_cp(pieces, end),
    ) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    let Some(run) = pieces.get(start_piece..=end_piece) else {
        return result;
    };
    for (offset, piece) in run.iter().enumerate() {
        let i = start_piece + offset;
        let xstart = if i == start_piece {
            start - piece.start_cp
        } else {
            0.0
        };
        let xend = if i == end_piece {
            end - piece.start_cp
        } else {
            piece.end_cp
        };
        result.extend(js_substring(&piece.text, xstart, xend));
    }
    result
}

/// `fillPieceRange`.
fn fill_piece_range(piece: &mut Piece, start: f64, end: f64, unit: u16) -> Result<(), Thrown> {
    let piece_start = piece.start_cp;
    let piece_end = piece_start + piece.length;
    let (mut start, mut end) = (start, end);
    if start < piece_start {
        start = piece_start;
    }
    if end > piece_end {
        end = piece_end;
    }
    let prefix = if start == piece_start {
        Vec::new()
    } else {
        js_slice(&piece.text, 0.0, Some(start - piece_start))
    };
    let suffix = if end == piece_end {
        Vec::new()
    } else {
        js_slice(&piece.text, end - piece_end, None)
    };
    piece.text = assemble(prefix, end - start, unit, suffix)?;
    Ok(())
}

/// `fillPieceRangeByFilePos`.
fn fill_piece_range_by_file_pos(
    piece: &mut Piece,
    start: f64,
    end: f64,
    unit: u16,
) -> Result<(), Thrown> {
    let piece_start = piece.start_file_pos;
    let piece_end = piece_start + piece.size;
    let (mut start, mut end) = (start, end);
    if start < piece_start {
        start = piece_start;
    }
    if end > piece_end {
        end = piece_end;
    }
    let prefix = if start == piece_start {
        Vec::new()
    } else {
        js_slice(&piece.text, 0.0, Some((start - piece_start) / piece.bpc))
    };
    let suffix = if end == piece_end {
        Vec::new()
    } else {
        js_slice(&piece.text, (end - piece_end) / piece.bpc, None)
    };
    piece.text = assemble(prefix, (end - start) / piece.bpc, unit, suffix)?;
    Ok(())
}

/// `replaceSelectedRange`.
fn replace_selected_range(
    pieces: &mut [Piece],
    start: f64,
    end: f64,
    unit: u16,
) -> Result<(), Thrown> {
    let (Some(start_piece), Some(end_piece)) = (
        piece_index_by_cp(pieces, start),
        piece_index_by_cp(pieces, end),
    ) else {
        return Ok(());
    };
    if let Some(run) = pieces.get_mut(start_piece..=end_piece) {
        for piece in run {
            fill_piece_range(piece, start, end, unit)?;
        }
    }
    Ok(())
}

/// `replaceSelectedRangeByFilePos`.
fn replace_selected_range_by_file_pos(
    pieces: &mut [Piece],
    start: f64,
    end: f64,
    unit: u16,
) -> Result<(), Thrown> {
    let (Some(start_piece), Some(end_piece)) = (
        piece_index_by_file_pos(pieces, start),
        piece_index_by_file_pos(pieces, end),
    ) else {
        return Ok(());
    };
    if let Some(run) = pieces.get_mut(start_piece..=end_piece) {
        for piece in run {
            fill_piece_range_by_file_pos(piece, start, end, unit)?;
        }
    }
    Ok(())
}

type SprmHandler<'a> = dyn FnMut(Buf<'_>, f64, u32, u32) -> Result<(), Thrown> + 'a;

/// `processSprms`: `handler(buffer, offset, sprm, ispmd)`.
fn process_sprms(
    buffer: Buf<'_>,
    offset: f64,
    handler: &mut SprmHandler<'_>,
) -> Result<(), Thrown> {
    let mut offset = offset;
    while offset < buffer.len() - 1.0 {
        let sprm = buffer.read_u16le(offset)? as u32;
        let ispmd = sprm & 0x1f;
        let spra = (sprm >> 13) & 0x07;
        offset += 2.0;
        handler(buffer, offset, sprm, ispmd)?;
        offset += match spra {
            0 | 1 => 1.0,
            2 | 4 | 5 => 2.0,
            3 => 4.0,
            6 => buffer.read_u8(offset)? + 1.0,
            _ => 3.0,
        };
    }
    Ok(())
}

/// The numbers `extractWordDocument` reads from the header.
struct Boundaries {
    ccp_text: f64,
    ccp_ftn: f64,
    ccp_hdd: f64,
    ccp_atn: f64,
    ccp_edn: f64,
    ccp_txbx: f64,
    ccp_hdr_txbx: f64,
}

/// `binaryToUnicode`: a byte 0x80 to 0x9f the table has no entry for is the
/// text `undefined`.
fn binary_to_unicode(text: &[u16]) -> Text {
    let mut out = Vec::with_capacity(text.len());
    for &unit in text {
        if (0x80..=0x9f).contains(&unit) {
            match binary_table(unit) {
                Some(mapped) => out.push(mapped),
                None => out.extend("undefined".encode_utf16()),
            }
        } else {
            out.push(unit);
        }
    }
    out
}

fn binary_table(unit: u16) -> Option<u16> {
    Some(match unit {
        0x82 => 0x201a,
        0x83 => 0x0192,
        0x84 => 0x201e,
        0x85 => 0x2026,
        0x86 => 0x2020,
        0x87 => 0x2021,
        0x88 => 0x02c6,
        0x89 => 0x2030,
        0x8a => 0x0160,
        0x8b => 0x2039,
        0x8c => 0x0152,
        0x8e => 0x017d,
        0x91 => 0x2018,
        0x92 => 0x2019,
        0x93 => 0x201c,
        0x94 => 0x201d,
        0x95 => 0x2022,
        0x96 => 0x2013,
        0x97 => 0x2014,
        0x98 => 0x02dc,
        0x99 => 0x2122,
        0x9a => 0x0161,
        0x9b => 0x203a,
        0x9c => 0x0153,
        0x9e => 0x017e,
        0x9f => 0x0178,
        _ => return None,
    })
}

/// `filters.clean`.
pub fn clean(text: &[u16]) -> Text {
    let mut current: Text = Vec::with_capacity(text.len());
    for &unit in text {
        match unit {
            0x02 | 0x05 | 0x08 => current.push(0),
            0x07 => current.push(0x09),
            0x0a..=0x0d => current.push(0x0a),
            // the table has no entry for 0x1f
            0x1f => current.extend("undefined".encode_utf16()),
            _ => current.push(unit),
        }
    }
    loop {
        let (next, called) = remove_fields(&current);
        current = next;
        if !called {
            break;
        }
    }
    current.retain(|&unit| unit > 0x07);
    current
}

/// `string.replace(/(?:\x13[^\x13\x14\x15]*\x14?([^\x13\x14\x15]*)\x15)/g, (m, p1) => p1)`.
fn remove_fields(text: &[u16]) -> (Text, bool) {
    let plain = |unit: u16| !matches!(unit, 0x13..=0x15);
    let mut out = Vec::with_capacity(text.len());
    let mut called = false;
    let mut i = 0;
    while i < text.len() {
        if text[i] == 0x13 {
            let mut p = i + 1;
            while p < text.len() && plain(text[p]) {
                p += 1;
            }
            match text.get(p) {
                Some(0x15) => {
                    called = true;
                    i = p + 1;
                    continue;
                }
                Some(0x14) => {
                    let mut q = p + 1;
                    while q < text.len() && plain(text[q]) {
                        q += 1;
                    }
                    if text.get(q) == Some(&0x15) {
                        called = true;
                        out.extend_from_slice(&text[p + 1..q]);
                        i = q + 1;
                        continue;
                    }
                }
                _ => {}
            }
        }
        out.push(text[i]);
        i += 1;
    }
    (out, called)
}

/// `/[^\r\n\u0002-\u0008]/.test(string)`.
fn has_content(text: &[u16]) -> bool {
    text.iter()
        .any(|&unit| !matches!(unit, 0x0d | 0x0a | 0x02..=0x08))
}

/// `WordOleExtractor.extract` as far as `getBody` and `getTextboxes` read it:
/// the body and the text boxes, with the `Document` accessors' options
/// `filterUnicode: false`, `includeHeadersAndFooters: false`.
pub fn extract(document: &CompoundDoc<'_>) -> Result<(Text, Text), Thrown> {
    let stream = document.stream("WordDocument")?;
    let buffer = Buf::new(&stream);
    let magic = buffer.read_u16le(0.0)?;
    if magic != f64::from(0xa5ec_u16) {
        return Err(Thrown::Error(format!(
            "This does not seem to be a Word document: Invalid magic number: {}",
            jscompat::to_string_radix16(magic)
        )));
    }
    let flags = buffer.read_u16le(f64::from(0xA))? as u32;
    let stream_name = if flags & 0x0200 != 0 {
        "1Table"
    } else {
        "0Table"
    };
    let table_stream = document.stream(stream_name)?;
    let table = Buf::new(&table_stream);

    let _fc_min = buffer.read_u32le(f64::from(0x0018))?;
    let boundaries = Boundaries {
        ccp_text: buffer.read_u32le(f64::from(0x004c))?,
        ccp_ftn: buffer.read_u32le(f64::from(0x0050))?,
        ccp_hdd: buffer.read_u32le(f64::from(0x0054))?,
        ccp_atn: buffer.read_u32le(f64::from(0x005c))?,
        ccp_edn: buffer.read_u32le(f64::from(0x0060))?,
        ccp_txbx: buffer.read_u32le(f64::from(0x0064))?,
        ccp_hdr_txbx: buffer.read_u32le(f64::from(0x0068))?,
    };

    write_bookmarks(buffer, table)?;
    let mut pieces = write_pieces(buffer, table)?;
    write_character_properties(buffer, table, &mut pieces)?;
    write_paragraph_properties(buffer, table, &mut pieces)?;
    normalize_headers(buffer, table, &boundaries, &mut pieces)?;
    Ok(build_document(&pieces, &boundaries))
}

/// `buildDocument`: the body and the text boxes.
fn build_document(pieces: &[Piece], boundaries: &Boundaries) -> (Text, Text) {
    let mut start = 0.0;
    let body = clean(&text_range_by_cp(
        pieces,
        start,
        start + boundaries.ccp_text,
    ));
    start += boundaries.ccp_text;
    let mut textboxes = Vec::new();
    if boundaries.ccp_ftn != 0.0 {
        start += boundaries.ccp_ftn;
    }
    if boundaries.ccp_hdd != 0.0 {
        start += boundaries.ccp_hdd;
    }
    if boundaries.ccp_atn != 0.0 {
        start += boundaries.ccp_atn;
    }
    if boundaries.ccp_edn != 0.0 {
        start += boundaries.ccp_edn;
    }
    if boundaries.ccp_txbx != 0.0 {
        textboxes = clean(&text_range_by_cp(
            pieces,
            start,
            start + boundaries.ccp_txbx - 1.0,
        ));
    }
    let _ = boundaries.ccp_hdr_txbx;
    (body, textboxes)
}

/// `writeBookmarks`: its only effects are the errors it can throw.
fn write_bookmarks(buffer: Buf<'_>, table: Buf<'_>) -> Result<(), Thrown> {
    let fc_sttbf_bkmk = buffer.read_u32le(f64::from(0x0142))?;
    let lcb_sttbf_bkmk = buffer.read_u32le(f64::from(0x0146))?;
    let fc_plcf_bkf = buffer.read_u32le(f64::from(0x014a))?;
    let lcb_plcf_bkf = buffer.read_u32le(f64::from(0x014e))?;
    let fc_plcf_bkl = buffer.read_u32le(f64::from(0x0152))?;
    let lcb_plcf_bkl = buffer.read_u32le(f64::from(0x0156))?;
    if lcb_sttbf_bkmk == 0.0 {
        return Ok(());
    }
    let sttbf_bkmk = table.slice(fc_sttbf_bkmk, fc_sttbf_bkmk + lcb_sttbf_bkmk);
    let plcf_bkf = table.slice(fc_plcf_bkf, fc_plcf_bkf + lcb_plcf_bkf);
    let plcf_bkl = table.slice(fc_plcf_bkl, fc_plcf_bkl + lcb_plcf_bkl);
    let fc_extend = sttbf_bkmk.read_u16le(0.0)?;
    sttbf_bkmk.read_u16le(2.0)?;
    sttbf_bkmk.read_u16le(4.0)?;
    if fc_extend != 65535.0 {
        return Err(Thrown::Error(
            "Internal error: unexpected single-byte bookmark data".into(),
        ));
    }
    let mut offset = 6.0;
    while offset < lcb_sttbf_bkmk {
        let length = sttbf_bkmk.read_u16le(offset)? * 2.0;
        let _segment = sttbf_bkmk.slice(offset + 2.0, offset + 2.0 + length);
        plcf_bkf.read_u32le(0.0)?;
        plcf_bkl.read_u32le(0.0)?;
        offset = offset + length + 2.0;
    }
    Ok(())
}

/// Units of piece text held beyond four times the stream.
const PIECE_TEXT_BASE: f64 = (1u64 << 26) as f64;

/// `writePieces`.
fn write_pieces(buffer: Buf<'_>, table: Buf<'_>) -> Result<Vec<Piece>, Thrown> {
    let mut pos = buffer.read_u32le(f64::from(0x01a2))?;
    loop {
        let flag = table.read_u8(pos)?;
        if flag != 1.0 {
            break;
        }
        pos += 1.0;
        let skip = table.read_u16le(pos)?;
        pos = pos + 2.0 + skip;
    }
    let flag = table.read_u8(pos)?;
    pos += 1.0;
    if flag != 2.0 {
        return Err(Thrown::Error("Internal error: ccorrupted Word file".into()));
    }
    let piece_table_size = table.read_u32le(pos)?;
    pos += 4.0;
    let pieces_count = (piece_table_size - 4.0) / 12.0;

    let mut start_cp = 0.0;
    let mut pieces = Vec::new();
    // pieces may overlap, so the text they hold can far exceed the stream
    let budget = PIECE_TEXT_BASE + 4.0 * buffer.len();
    let mut held = 0.0;
    let end = pieces_count - 1.0;
    let mut x = 0.0;
    while x <= end {
        let offset = pos + ((pieces_count + 1.0) * 4.0) + (x * 8.0) + 2.0;
        let mut start_file_pos = table.read_u32le(offset)?;
        let unicode;
        if (start_file_pos as u32 as i32) & 0x4000_0000 == 0 {
            unicode = true;
        } else {
            unicode = false;
            start_file_pos = f64::from((start_file_pos as u32 as i32) & !0x4000_0000);
            start_file_pos = (start_file_pos / 2.0).floor();
        }
        let l_start = table.read_u32le(pos + (x * 4.0))?;
        let l_end = table.read_u32le(pos + ((x + 1.0) * 4.0))?;
        let bpc = if unicode { 2.0 } else { 1.0 };
        let size = bpc * (l_end - l_start);
        let text_buffer = buffer.slice(start_file_pos, start_file_pos + size);
        let text = if unicode {
            text_buffer.to_ucs2()
        } else {
            binary_to_unicode(&text_buffer.to_latin1())
        };
        let length = text.len() as f64;
        held += length;
        if held > budget {
            return Err(Thrown::Error("doc: pieces of text too long to hold".into()));
        }
        let end_cp = start_cp + length;
        pieces.push(Piece {
            start_cp,
            start_file_pos,
            bpc,
            size,
            text,
            length,
            end_cp,
            end_file_pos: start_file_pos + size,
        });
        start_cp = end_cp;
        x += 1.0;
    }
    Ok(pieces)
}

/// `normalizeHeaders`.
fn normalize_headers(
    buffer: Buf<'_>,
    table: Buf<'_>,
    boundaries: &Boundaries,
    pieces: &mut [Piece],
) -> Result<(), Thrown> {
    let fc_plcfhdd = buffer.read_u32le(f64::from(0x00f2))?;
    let lcb_plcfhdd = buffer.read_u32le(f64::from(0x00f6))?;
    if lcb_plcfhdd < 8.0 {
        return Ok(());
    }
    let offset = boundaries.ccp_text + boundaries.ccp_ftn;
    let ccp_hdd = boundaries.ccp_hdd;
    let plc_hdd = table.slice(fc_plcfhdd, fc_plcfhdd + lcb_plcfhdd);
    let count = lcb_plcfhdd / 4.0;
    let mut start = offset + plc_hdd.read_u32le(0.0)?;
    let mut i = 1.0;
    while i < count {
        let mut end = offset + plc_hdd.read_u32le(i * 4.0)?;
        if end > offset + ccp_hdd {
            end = offset + ccp_hdd;
        }
        let string = text_range_by_cp(pieces, start, end);
        if !has_content(&string) {
            replace_selected_range(pieces, start, end, 0)?;
        } else {
            replace_selected_range(pieces, end - 1.0, end, 0)?;
        }
        start = end;
        i += 1.0;
    }
    Ok(())
}

/// `writeParagraphProperties`.
fn write_paragraph_properties(
    buffer: Buf<'_>,
    table: Buf<'_>,
    pieces: &mut [Piece],
) -> Result<(), Thrown> {
    let fc = buffer.read_u32le(f64::from(0x0102))?;
    let lcb = buffer.read_u32le(f64::from(0x0106))?;
    let count = (lcb - 4.0) / 8.0;
    let data_offset = (count + 1.0) * 4.0;
    let plc = table.slice(fc, fc + lcb);
    let mut i = 0.0;
    while i < count {
        plc.read_u32le(i * 4.0)?;
        let block = plc.read_u32le(data_offset + i * 4.0)?;
        let fkp = buffer.slice(block * 512.0, (block + 1.0) * 512.0);
        let crun = fkp.read_u8(511.0)?;
        let mut j = 0.0;
        while j < crun {
            let rgfc = fkp.read_u32le(j * 4.0)?;
            let rgfc_next = fkp.read_u32le((j + 1.0) * 4.0)?;
            let cb_location = (crun + 1.0) * 4.0 + j * 13.0;
            let cb_index = fkp.read_u8(cb_location)? * 2.0;
            let cb = fkp.read_u8(cb_index)?;
            let grpprl = if cb != 0.0 {
                fkp.slice(cb_index + 1.0, cb_index + 1.0 + (2.0 * cb) - 1.0)
            } else {
                let cb2 = fkp.read_u8(cb_index + 1.0)?;
                fkp.slice(cb_index + 2.0, cb_index + 2.0 + (2.0 * cb2))
            };
            grpprl.read_u16le(0.0)?;
            process_sprms(grpprl, 2.0, &mut |_, _, sprm, _| {
                if sprm == 0x2417 {
                    replace_selected_range_by_file_pos(pieces, rgfc, rgfc_next, 0x0a)?;
                }
                Ok(())
            })?;
            j += 1.0;
        }
        i += 1.0;
    }
    Ok(())
}

/// `writeCharacterProperties`.
fn write_character_properties(
    buffer: Buf<'_>,
    table: Buf<'_>,
    pieces: &mut [Piece],
) -> Result<(), Thrown> {
    let fc = buffer.read_u32le(f64::from(0x00fa))?;
    let lcb = buffer.read_u32le(f64::from(0x00fe))?;
    let count = (lcb - 4.0) / 8.0;
    let data_offset = (count + 1.0) * 4.0;
    let plc = table.slice(fc, fc + lcb);
    let mut last_deletion_end: Option<f64> = None;
    let mut i = 0.0;
    while i < count {
        plc.read_u32le(i * 4.0)?;
        let block = plc.read_u32le(data_offset + i * 4.0)?;
        let fkp = buffer.slice(block * 512.0, (block + 1.0) * 512.0);
        let crun = fkp.read_u8(511.0)?;
        let mut j = 0.0;
        while j < crun {
            let rgfc = fkp.read_u32le(j * 4.0)?;
            let rgfc_next = fkp.read_u32le((j + 1.0) * 4.0)?;
            let rgb = fkp.read_u8((crun + 1.0) * 4.0 + j)?;
            if rgb == 0.0 {
                j += 1.0;
                continue;
            }
            let chpx_offset = rgb * 2.0;
            let cb = fkp.read_u8(chpx_offset)?;
            let grpprl = fkp.slice(chpx_offset + 1.0, chpx_offset + 1.0 + cb);
            process_sprms(grpprl, 0.0, &mut |buffer, offset, _, ispmd| {
                if ispmd == 0 {
                    if buffer.at(offset).map_or(0, |byte| byte & 1) != 1 {
                        return Ok(());
                    }
                    if last_deletion_end == Some(rgfc) {
                        let start = last_deletion_end.unwrap_or(rgfc);
                        replace_selected_range_by_file_pos(pieces, start, rgfc_next, 0)?;
                    } else {
                        replace_selected_range_by_file_pos(pieces, rgfc, rgfc_next, 0)?;
                    }
                    last_deletion_end = Some(rgfc_next);
                }
                Ok(())
            })?;
            j += 1.0;
        }
        i += 1.0;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlapping_pieces_are_refused_not_allocated() {
        let pieces: usize = 1000;
        let mut table = vec![2_u8];
        table.extend(((4 + 12 * pieces) as u32).to_le_bytes());
        for i in 0..=pieces {
            let cp: u32 = if i % 2 == 0 { 0 } else { u32::MAX };
            table.extend(cp.to_le_bytes());
        }
        for _ in 0..pieces {
            table.extend([0_u8; 8]);
        }
        let buffer = vec![0_u8; 1 << 20];
        let got = write_pieces(Buf::new(&buffer), Buf::new(&table));
        assert!(matches!(got, Err(Thrown::Error(m)) if m.starts_with("doc:")));
    }
}
