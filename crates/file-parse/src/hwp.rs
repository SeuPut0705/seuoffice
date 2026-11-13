//! packages/file-parse/src/hwp.ts.
//!
//! The TypeScript loads `@rhwp/core`, the WebAssembly build of the rhwp
//! engine, and calls its JavaScript API. Those calls are the `#[wasm_bindgen]`
//! methods of `rhwp::wasm_api::HwpDocument`, each a thin wrapper over a Rust
//! function of the same crate, so this module calls those functions (or the
//! wrapper, where it holds no `JsValue`) on the same source: tag v0.9.0 and the
//! patches of `vendor/rhwp-core/patches`, which `tools/build-rhwp-core.mjs
//! --source-only` prepares. `JsValue` cannot be built on `wasm32-wasip1`
//! (wasm-bindgen stubs it out to a panic there), so a wrapper that returns one
//! is never called: its `_native` function is, and its error is the
//! `HwpError` text the wrapper would have thrown.
//!
//! `rhwpWasmPath`, `SEUOFFICE_RHWP_WASM`, the Resources/wasm lookup and
//! `loadEngine` have no counterpart here: the engine is linked, not loaded.
//! `getTableDimensions` and `getCellInfo` are `pub(crate)` in rhwp; they are
//! ported over `DocumentCore::document()` as they stand there.
//!
//! Text the engine's plain-text export gives is walked as UTF-16 code units
//! from `decodeEntities` on: `String.fromCodePoint` can make half a surrogate
//! pair, and JavaScript keeps it. An answer that holds one cannot be a Rust
//! string and is refused, as `docx.rs` refuses it.

use std::collections::HashMap;

use jscompat::{Radix, is_js_space, js_regex, number_to_string, parse_int, to_number, trim};
use ooxml_pkg::{DEFAULT_ZIP_LIMITS, assert_zip_inflates_within_limits};
use rhwp::HwpError;
use rhwp::model::control::Control;
use rhwp::model::table::Table;
use rhwp::wasm_api::HwpDocument;
use serde_json::Value;

use crate::compound_gate::assert_sound_compound_file;

type Units = Vec<u16>;

fn units(text: &str) -> Units {
    text.encode_utf16().collect()
}

/// A table cell holding more paragraphs than this is page layout, not a data cell.
const MAX_ROW_CELL_PARAGRAPHS: usize = 3;

/// The engine throws plain strings, in Korean; callers get an Error they can show.
fn engine_error(message: &str) -> String {
    if message.contains("암호") || js_regex!(r"password", "i").test(message) {
        return "The document is password-protected and cannot be read without its password"
            .to_owned();
    }
    if message.contains("UNSUPPORTED_FILE_FORMAT") || message.contains("지원하지 않는 포맷")
    {
        return "Not a readable HWP or HWPX document".to_owned();
    }
    format!("Could not read the HWP document: {message}")
}

fn is_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_js_space)
}

fn trim_units(text: &[u16]) -> &[u16] {
    let start = text.iter().position(|&unit| !is_space(unit));
    let Some(start) = start else { return &[] };
    let end = text
        .iter()
        .rposition(|&unit| !is_space(unit))
        .map_or(0, |at| at + 1);
    &text[start..end]
}

/// `text.replace(/\s+/g, ' ').trim()`
fn normalize(text: &[u16]) -> Units {
    let mut collapsed = Units::with_capacity(text.len());
    let mut in_space = false;
    for &unit in text {
        if is_space(unit) {
            if !in_space {
                collapsed.push(u16::from(b' '));
            }
            in_space = true;
        } else {
            collapsed.push(unit);
            in_space = false;
        }
    }
    trim_units(&collapsed).to_vec()
}

/// `text.split(/\r?\n/)`
fn split_lines(text: &[u16]) -> Vec<&[u16]> {
    let mut pieces = Vec::new();
    let mut from = 0;
    for (at, &unit) in text.iter().enumerate() {
        if unit != u16::from(b'\n') {
            continue;
        }
        let end = if at > from && text[at - 1] == u16::from(b'\r') {
            at - 1
        } else {
            at
        };
        pieces.push(&text[from..end]);
        from = at + 1;
    }
    pieces.push(&text[from..]);
    pieces
}

/// The lines of the engine's plain-text export a piece of output stands for.
fn covers_of(text: &[u16]) -> Vec<Units> {
    split_lines(text)
        .into_iter()
        .map(normalize)
        .filter(|line| !line.is_empty())
        .collect()
}

/// One line of output, and the plain-text lines it accounts for.
struct Entry {
    text: Units,
    covers: Vec<Units>,
}

fn line_entry(text: Units) -> Entry {
    let covers = covers_of(&text);
    Entry { text, covers }
}

struct TableCell {
    row: u16,
    col: u16,
    paragraphs: Vec<Units>,
}

struct Dimensions {
    row_count: u16,
    col_count: u16,
    cell_count: usize,
}

/// The table that is control `ctrl` of a body paragraph, as `getTableDimensions`
/// and `getCellInfo` find it.
fn table_of(doc: &HwpDocument, sec: usize, para: usize, ctrl: usize) -> Result<&Table, HwpError> {
    let paragraph = doc
        .document()
        .sections
        .get(sec)
        .ok_or_else(|| HwpError::RenderError(format!("구역 인덱스 {sec} 범위 초과")))?
        .paragraphs
        .get(para)
        .ok_or_else(|| HwpError::RenderError(format!("문단 인덱스 {para} 범위 초과")))?;
    match paragraph.controls.get(ctrl) {
        Some(Control::Table(table)) => Ok(table.as_ref()),
        _ => Err(HwpError::RenderError(
            "지정된 컨트롤이 표가 아닙니다".to_owned(),
        )),
    }
}

/// `getCellInfo`: where the cell sits, as the `{ row, col }` of its JSON.
fn cell_info(
    doc: &HwpDocument,
    sec: usize,
    para: usize,
    ctrl: usize,
    cell: usize,
) -> Result<(u16, u16), HwpError> {
    let table = table_of(doc, sec, para, ctrl)?;
    let cell_at = table.cells.get(cell).ok_or_else(|| {
        HwpError::RenderError(format!(
            "셀 인덱스 {cell} 범위 초과 (총 {}개)",
            table.cells.len()
        ))
    })?;
    Ok((cell_at.row, cell_at.col))
}

/// The table that is control `ctrl` of a body paragraph, or `None` when that control
/// is something else (a picture, a text box, a section definition).
///
/// A table with two or more columns of short cells comes out as rows, cells joined
/// by " | " like the Word reader does it. A table that lays out a page (one
/// column, or cells that hold running text) comes out as its paragraphs in order.
fn table_entries(
    doc: &HwpDocument,
    sec: usize,
    para: usize,
    ctrl: usize,
) -> Result<Option<Vec<Entry>>, String> {
    let dims = match table_of(doc, sec, para, ctrl) {
        Ok(table) => Dimensions {
            row_count: table.row_count,
            col_count: table.col_count,
            cell_count: table.cells.len(),
        },
        Err(_) => return Ok(None),
    };
    let thrown = |error: HwpError| error.to_string();
    let mut cells: Vec<TableCell> = Vec::new();
    for cell in 0..dims.cell_count {
        let (row, col) = cell_info(doc, sec, para, ctrl, cell).map_err(thrown)?;
        let mut paragraphs: Vec<Units> = Vec::new();
        let count = doc
            .get_cell_paragraph_count_native(sec, para, ctrl, cell)
            .map_err(thrown)?;
        for k in 0..count {
            let length = doc
                .get_cell_paragraph_length_native(sec, para, ctrl, cell, k)
                .map_err(thrown)?;
            if length > 0 {
                let text = doc
                    .get_text_in_cell_native(sec, para, ctrl, cell, k, 0, length)
                    .map_err(thrown)?;
                paragraphs.push(units(&text));
            }
        }
        cells.push(TableCell {
            row,
            col,
            paragraphs,
        });
    }
    let as_rows = dims.col_count >= 2
        && cells
            .iter()
            .all(|cell| cell.paragraphs.len() <= MAX_ROW_CELL_PARAGRAPHS);
    if !as_rows {
        return Ok(Some(
            cells
                .into_iter()
                .flat_map(|cell| cell.paragraphs)
                .map(line_entry)
                .collect(),
        ));
    }

    // a merged cell sits at its first row and column; the places it spans stay empty,
    // so the columns still line up, but a row does not end in a run of empty places
    struct Row {
        cells: Vec<Units>,
        covers: Vec<Units>,
    }
    let mut rows: Vec<Row> = (0..dims.row_count)
        .map(|_| Row {
            cells: vec![Units::new(); usize::from(dims.col_count)],
            covers: Vec::new(),
        })
        .collect();
    for cell in &cells {
        let Some(row) = rows.get_mut(usize::from(cell.row)) else {
            continue;
        };
        if cell.col >= dims.col_count {
            continue;
        }
        let words: Vec<Units> = cell
            .paragraphs
            .iter()
            .map(|paragraph| normalize(paragraph))
            .filter(|paragraph| !paragraph.is_empty())
            .collect();
        row.cells[usize::from(cell.col)] = join(&words, &[u16::from(b' ')]);
        row.covers.extend(
            cell.paragraphs
                .iter()
                .flat_map(|paragraph| covers_of(paragraph)),
        );
    }
    Ok(Some(
        rows.into_iter()
            .filter(|row| !row.covers.is_empty())
            .map(|row| Entry {
                text: row_text(&row.cells),
                covers: row.covers,
            })
            .collect(),
    ))
}

/// `parts.join(separator)`
fn join(parts: &[Units], separator: &[u16]) -> Units {
    let mut out = Units::new();
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            out.extend_from_slice(separator);
        }
        out.extend_from_slice(part);
    }
    out
}

fn row_text(cells: &[Units]) -> Units {
    let mut end = cells.len();
    while end > 1 && cells[end - 1].is_empty() {
        end -= 1;
    }
    join(&cells[..end], &units(" | "))
}

/// `String(value)` of what `JSON.parse` can hold.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// The engine's memo list, its dates in the user's zone: the engine writes a
/// memo date as local time with a literal Z, and a WASI build has no zone of
/// its own, so the host's clock gives the offset (`fileparse.localOffsetSeconds`).
/// Where no host answers, the engine keeps `chrono::Local`.
fn memo_list_json(doc: &HwpDocument) -> String {
    let _ = rhwp::model::memo_time::set_local_offset(host_offset);
    doc.get_memo_list_json()
}

/// The user's offset east of UTC, in seconds, at a Unix time, as the host's
/// `Date` gives it; `None` without a host or with an answer that is no offset.
fn host_offset(unix_seconds: i64) -> Option<i32> {
    let ms = unix_seconds as f64 * 1000.0;
    let seconds = seu_host::call(
        "fileparse.localOffsetSeconds",
        &serde_json::json!({ "ms": ms }),
    )
    .ok()?
    .as_f64()?;
    (seconds.fract() == 0.0 && seconds.abs() < 86_400.0).then_some(seconds as i32)
}

/// The document's memos as a `### Comments` block, in the document order the engine
/// already sorts them in. A document without memos gets no block, so its text is
/// exactly what it was before memos were read. Memos that cannot be listed are left out
/// rather than failing the read of a body that could be read.
fn comment_lines(doc: &HwpDocument) -> Result<Vec<String>, String> {
    let Ok(listed) = serde_json::from_str::<Value>(&memo_list_json(&doc)) else {
        return Ok(Vec::new());
    };
    let memos = match listed {
        Value::Array(memos) => memos,
        _ => Vec::new(),
    };
    memo_block(&memos)
}

fn memo_block(memos: &[Value]) -> Result<Vec<String>, String> {
    if memos.is_empty() {
        return Ok(Vec::new());
    }
    let mut lines = vec!["### Comments".to_owned()];
    for memo in memos {
        if memo.is_null() {
            return Err("Cannot read properties of null (reading 'author')".to_owned());
        }
        let field = |key: &str| memo.get(key).filter(|value| !value.is_null());
        let author = match field("author") {
            None => "",
            Some(Value::String(author)) => trim(author),
            Some(_) => return Err("memo.author?.trim is not a function".to_owned()),
        };
        let author = if author.is_empty() { "unknown" } else { author };
        let page = match field("page") {
            Some(Value::Number(page)) => match page.as_f64() {
                Some(page) if page > 0.0 => format!(" (p.{})", number_to_string(page)),
                _ => String::new(),
            },
            _ => String::new(),
        };
        let text = field("text").map(js_string).unwrap_or_default();
        let text = text.replace("\r\n", "\n");
        let mut pieces = text.split('\n');
        let first = pieces.next().unwrap_or("");
        let mut rest: Vec<&str> = pieces.collect();
        // a memo saved with a closing newline should not leave a blank line after the block
        while rest.last() == Some(&"") {
            rest.pop();
        }
        let tail = if first.is_empty() {
            String::new()
        } else {
            format!(" {first}")
        };
        lines.push(format!("- {author}{page}:{tail}"));
        for line in rest {
            lines.push(if line.is_empty() {
                String::new()
            } else {
                format!("  {line}")
            });
        }
    }
    Ok(lines)
}

/// The body of the document, paragraph by paragraph, each followed by the tables it holds.
fn body_entries(doc: &HwpDocument) -> Result<Vec<Entry>, String> {
    let thrown = |error: HwpError| error.to_string();
    let mut entries: Vec<Entry> = Vec::new();
    let sections = doc.get_section_count() as usize;
    for sec in 0..sections {
        let paragraphs = doc.get_paragraph_count_native(sec).map_err(thrown)?;
        for para in 0..paragraphs {
            let length = doc.get_paragraph_length_native(sec, para).map_err(thrown)?;
            if length > 0 {
                let text = doc
                    .get_text_range_native(sec, para, 0, length)
                    .map_err(thrown)?;
                entries.push(line_entry(units(&text)));
            }
            let positions = doc.get_control_text_positions(sec as u32, para as u32);
            let controls = serde_json::from_str::<Vec<Value>>(&positions)
                .map_err(|error| error.to_string())?
                .len();
            for ctrl in 0..controls {
                if let Some(table) = table_entries(doc, sec, para, ctrl)? {
                    entries.extend(table);
                }
            }
        }
    }
    Ok(entries)
}

/// `String.fromCodePoint(code)`, which throws a RangeError for what is no code point.
fn from_code_point(code: f64, out: &mut Units) -> Result<(), String> {
    if !(0.0..=1_114_111.0).contains(&code) || code.fract() != 0.0 {
        return Err(format!("Invalid code point {}", number_to_string(code)));
    }
    let code = code as u32;
    match char::from_u32(code) {
        Some(c) => out.extend(c.encode_utf16(&mut [0; 2]).iter()),
        // a surrogate code point is one lone code unit in JavaScript
        None => out.push(code as u16),
    }
    Ok(())
}

/// The engine's plain-text export writes some characters as numeric references.
fn decode_entities(text: &str) -> Result<Units, String> {
    let mut out = Units::with_capacity(text.len());
    let mut copied = 0;
    for m in js_regex!(r"&#(\d+);|&#x([0-9a-fA-F]+);").find_iter(text) {
        out.extend(text[copied..m.start()].encode_utf16());
        copied = m.end();
        let code = match m.get(1) {
            Some(dec) => to_number(dec),
            None => parse_int(m.get(2).unwrap_or(""), Radix::Sixteen),
        };
        from_code_point(code, &mut out)?;
    }
    out.extend(text[copied..].encode_utf16());
    Ok(out)
}

/// Put back what the walk over paragraphs and tables did not reach. The engine's
/// own plain-text export holds every piece of text in reading order (text boxes,
/// tables inside table cells, notes) but no table structure. Each of its lines is
/// looked up among the lines the structured output accounts for; a line found
/// nowhere goes in after the last line that was, so nothing is lost and little
/// moves. One pass, whatever the size: documents with tens of thousands of table
/// cells exist.
fn with_missing_text(entries: &[Entry], flat: &str) -> Result<Vec<Units>, String> {
    // where each accounted-for line is: its entries in order, one per occurrence
    let mut places: HashMap<&[u16], Vec<usize>> = HashMap::new();
    for (index, entry) in entries.iter().enumerate() {
        for line in &entry.covers {
            places.entry(line.as_slice()).or_default().push(index);
        }
    }
    // occurrences of a line already matched
    let mut taken: HashMap<Units, usize> = HashMap::new();
    // lines put back, by the entry they follow (-1: in front of everything)
    let mut extras: HashMap<i64, Vec<Units>> = HashMap::new();
    let mut pointer: i64 = -1;
    let decoded = decode_entities(flat)?;
    for raw in split_lines(&decoded) {
        let line = normalize(raw);
        if line.is_empty() {
            continue;
        }
        let list = places.get(line.as_slice());
        let used = taken.get(&line).copied().unwrap_or(0);
        if let Some(list) = list
            && used < list.len()
        {
            taken.insert(line, used + 1);
            pointer = pointer.max(list[used] as i64);
            continue;
        }
        // the cells of a table inside a table cell arrive on one line, tab-separated
        let text = if raw.contains(&u16::from(b'\t')) {
            let cells: Vec<Units> = raw
                .split(|&unit| unit == u16::from(b'\t'))
                .map(normalize)
                .collect();
            row_text(&cells)
        } else {
            trim_units(raw).to_vec()
        };
        extras.entry(pointer).or_default().push(text);
    }
    let mut out: Vec<Units> = extras.remove(&-1).unwrap_or_default();
    for (index, entry) in entries.iter().enumerate() {
        out.push(entry.text.clone());
        if let Some(more) = extras.remove(&(index as i64)) {
            out.extend(more);
        }
    }
    Ok(out)
}

/// One memo as the engine lists it: where its anchor sits in the body, and the note itself.
/// (`HwpMemo` of the TypeScript: the JSON the engine wrote, kept as it is.)
pub type HwpMemo = Value;

/// The gates a container passes before the engine gets its bytes. The engine reads what it
/// finds: an HWPX is a zip it inflates itself, a Hangul 5 file a compound file whose sector
/// chains it follows. A compound file the gate refuses is reported as a damaged document.
fn assert_container_within_limits(bytes: &[u8]) -> Result<(), String> {
    if bytes.starts_with(&[0x50, 0x4b]) {
        assert_zip_inflates_within_limits(bytes, &DEFAULT_ZIP_LIMITS)?;
    }
    if bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0]) {
        assert_sound_compound_file(bytes, "HWP").map_err(|error| error.message())?;
    }
    Ok(())
}

/// The memos of an HWP / HWPX document, as the engine holds them. Records in the bytes
/// the engine does not model are not listed; a caller checking a save counts those
/// separately from the raw file.
pub fn hwp_memos_of(bytes: &[u8]) -> Result<Vec<HwpMemo>, String> {
    assert_container_within_limits(bytes)?;
    let doc = HwpDocument::from_bytes(bytes).map_err(|error| engine_error(&error.to_string()))?;
    match serde_json::from_str::<Value>(&memo_list_json(&doc)) {
        Ok(Value::Array(memos)) => Ok(memos),
        Ok(_) => Ok(Vec::new()),
        Err(error) => Err(engine_error(&error.to_string())),
    }
}

/// The bytes of an `.hwp` / `.hwpx` file, checked as parseFileToText checks them before the
/// engine gets them: the content must be what the name says (an HWPX is a zip; an HWP is
/// Hangul 5, Hangul 3, or an HWPX under the old name), a zip must pass the zip gate and a
/// Hangul 5 file the compound-file gate.
/// For a caller that opens the document with the engine itself, such as the HWP editor
/// reading the formatting of an attached document. Errs when a check fails.
pub fn checked_hwp_bytes<'a>(bytes: &'a [u8], ext: &str) -> Result<&'a [u8], String> {
    let zip = bytes.starts_with(&[0x50, 0x4b]);
    let ole = bytes.starts_with(&[0xd0, 0xcf, 0x11, 0xe0]);
    let hwp3 = bytes.starts_with(b"HWP Document File");
    let fits = match ext {
        "hwpx" => zip,
        "hwp" => zip || ole || hwp3,
        _ => false,
    };
    if !fits {
        return Err(format!(
            "Content mismatch: the .{ext} file is not a Hangul document"
        ));
    }
    assert_container_within_limits(bytes)?;
    Ok(bytes)
}

/// The text of an HWP / HWPX document: paragraphs as lines, data tables as " | " rows.
pub fn hwp_to_text(bytes: &[u8]) -> Result<String, String> {
    assert_container_within_limits(bytes)?;
    let doc = HwpDocument::from_bytes(bytes).map_err(|error| engine_error(&error.to_string()))?;
    let read = || -> Result<Units, String> {
        let flat = serde_json::from_str::<String>(&doc.get_text_file_text())
            .map_err(|error| error.to_string())?;
        let mut lines = with_missing_text(&body_entries(&doc)?, &flat)?;
        lines.extend(comment_lines(&doc)?.iter().map(|line| units(line)));
        Ok(join(&lines, &[u16::from(b'\n')]))
    };
    let joined = read().map_err(|message| engine_error(&message))?;
    String::from_utf16(&joined).map_err(|_| {
        "hwp: the TypeScript answer holds a lone surrogate, which a Rust string cannot".to_owned()
    })
}

/// Expected answers are those of `hwp.ts` under Node 22, run with its functions exported.
#[cfg(test)]
mod tests {
    use super::*;

    fn entry(text: &str) -> Entry {
        line_entry(units(text))
    }

    fn strings(lines: Vec<Units>) -> Vec<String> {
        lines
            .iter()
            .map(|line| String::from_utf16(line).expect("no lone surrogate"))
            .collect()
    }

    #[test]
    fn normalize_collapses_what_regex_s_matches() {
        let one = |text: &str| String::from_utf16(&normalize(&units(text))).unwrap();
        assert_eq!(one("  a \t\u{a0}b\u{3000} c\u{feff} "), "a b c");
        assert_eq!(one(""), "");
        assert_eq!(one("\u{85}x\u{85}"), "\u{85}x\u{85}");
        assert_eq!(one("a\u{2028}b"), "a b");
    }

    #[test]
    fn entities_decode_to_code_units() {
        let text = "a&#9702;b&#x41;&#X41;&#65;&#x;&#;&#0;&#xD83D;&#xDE00;c";
        assert_eq!(
            decode_entities(text).unwrap(),
            units("a◦bA&#X41;A&#x;&#;\u{0}😀c")
        );
        assert_eq!(decode_entities("&#x0041;&#00065;").unwrap(), units("AA"));
        assert_eq!(decode_entities("&#55357;").unwrap(), vec![0xd83d]);
        assert_eq!(
            decode_entities("x&#xDE00;&#xD83D;y").unwrap(),
            vec![u16::from(b'x'), 0xde00, 0xd83d, u16::from(b'y')]
        );
    }

    #[test]
    fn entities_that_name_no_code_point_throw() {
        let message = |text: &str| decode_entities(text).unwrap_err();
        assert_eq!(message("&#1114112;"), "Invalid code point 1114112");
        assert_eq!(message("&#x110000;"), "Invalid code point 1114112");
        assert_eq!(
            message("&#99999999999999999999;"),
            "Invalid code point 100000000000000000000"
        );
        assert_eq!(
            message("&#xFFFFFFFFFFFFFFFFFFFFFFFF;"),
            "Invalid code point 7.922816251426434e+28"
        );
    }

    #[test]
    fn row_text_drops_the_trailing_empty_places() {
        let cells = |items: &[&str]| items.iter().map(|item| units(item)).collect::<Vec<_>>();
        let text = |items: &[&str]| String::from_utf16(&row_text(&cells(items))).unwrap();
        assert_eq!(text(&["a", "", "c", "", ""]), "a |  | c");
        assert_eq!(text(&["", ""]), "");
        assert_eq!(text(&[""]), "");
    }

    #[test]
    fn missing_text_goes_in_after_the_last_line_found() {
        let missing =
            |entries: &[Entry], flat: &str| strings(with_missing_text(entries, flat).unwrap());
        let entries = [entry("가 나\n다"), entry("라"), entry("가 나"), entry("")];
        assert_eq!(
            missing(
                &entries,
                "가 나\r\n다\n라\nZ\n가 나\n\n  tab\tcell  \tx\t\ny\n"
            ),
            ["가 나\n다", "라", "Z", "가 나", "tab | cell | x", "y", ""]
        );
        assert_eq!(missing(&[], "only\nextra\r\n"), ["only", "extra"]);
        assert_eq!(
            missing(&[entry("a"), entry("b")], "x\na\ny\nb\nz\na\n"),
            ["x", "a", "y", "b", "z", "a"]
        );
        assert_eq!(missing(&[entry("a")], "\ta\t\t"), ["a"]);
        assert_eq!(
            missing(&[entry("a"), entry("a")], "a\na\na\n&#9702;\n"),
            ["a", "a", "a", "◦"]
        );
    }

    fn block(memos: &str) -> Result<Vec<String>, String> {
        let Value::Array(memos) = serde_json::from_str(memos).unwrap() else {
            panic!("not an array")
        };
        memo_block(&memos)
    }

    #[test]
    fn memos_become_a_comments_block() {
        assert_eq!(block("[]").unwrap(), Vec::<String>::new());
        assert_eq!(
            block(
                r#"[{"author":" A ","text":"x\r\ny\n\nz\n\n","page":3},{"author":"","text":"","page":0},
                {"text":"\n\nq"},{"author":"  ","text":"q","page":2.5},{"author":"b","text":5,"page":"2"},
                {"author":"c","text":["a",null,1],"page":-1},{"author":"d","text":{"a":1},"page":1e21},
                {"author":"e","text":true,"page":null}]"#
            )
            .unwrap(),
            [
                "### Comments",
                "- A (p.3): x",
                "  y",
                "",
                "  z",
                "- unknown:",
                "- unknown:",
                "",
                "  q",
                "- unknown (p.2.5): q",
                "- b: 5",
                "- c: a,,1",
                "- d (p.1e+21): [object Object]",
                "- e: true",
            ]
        );
        assert_eq!(
            block(r#"[{"author":"\ufeff\u00a0","text":" \n x"}]"#).unwrap(),
            ["### Comments", "- unknown:  ", "   x"]
        );
        assert_eq!(
            block(r#"[1,"x",[]]"#).unwrap(),
            ["### Comments", "- unknown:", "- unknown:", "- unknown:"]
        );
    }

    #[test]
    fn a_memo_that_cannot_be_read_throws() {
        assert_eq!(
            block("[null]").unwrap_err(),
            "Cannot read properties of null (reading 'author')"
        );
        assert_eq!(
            block(r#"[{"author":7}]"#).unwrap_err(),
            "memo.author?.trim is not a function"
        );
    }

    #[test]
    fn engine_errors_are_worded_for_the_reader() {
        assert_eq!(
            engine_error("문서에 암호가 걸려 있습니다"),
            "The document is password-protected and cannot be read without its password"
        );
        assert_eq!(
            engine_error("Wrong PASSWORD"),
            "The document is password-protected and cannot be read without its password"
        );
        assert_eq!(
            engine_error("UNSUPPORTED_FILE_FORMAT"),
            "Not a readable HWP or HWPX document"
        );
        assert_eq!(
            engine_error("x 지원하지 않는 포맷 y"),
            "Not a readable HWP or HWPX document"
        );
        assert_eq!(
            engine_error("boom"),
            "Could not read the HWP document: boom"
        );
    }
}
