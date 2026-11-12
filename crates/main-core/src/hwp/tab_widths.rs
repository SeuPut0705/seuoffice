//! `apps/hwp/src/main/tab-widths.ts`: the widths the editor measured, written
//! into the tabs the engine wrote without values (decision 0026), in an HWP 5
//! file and in an HWPX file.
//!
//! The measured tabs come from the renderer, so they are JSON of any shape
//! here (`serde_json::Value`), read as the TypeScript reads their properties:
//! a `null` where an object is needed throws, a missing property is
//! `undefined`.

use std::borrow::Cow;
use std::collections::HashMap;

use jscompat::{
    JsMap, number_to_string, replace_first_with, sort_by_number, to_number, try_js_regex,
    value_to_string,
};
use serde::Serialize;
use serde_json::Value;

use super::hwp5_file::{
    CTRL_HEADER, HwpRecord, LIST_HEADER, MAX_STREAM_INFLATE_BYTES, PARA_HEADER, PARA_TEXT, Res,
    Thrown, open_hwp, read_u16, read_u32, records_of, rewrite_streams, section, section_count,
    stream_of, write_u16, write_u32, write_u32_f64,
};
use super::ipc::HwpFormat;
use super::zlib::{crc32, deflate_raw_sync, inflate_raw_sync};

/// A save measures at most this many tabs; a document typed in the editor has far fewer.
pub const MAX_NEW_TABS: usize = 5000;
/// No tab reaches further than a page is wide; this bounds what is written.
const MAX_TAB_WIDTH: f64 = 2_147_483_647.0;
const MAX_TAB_KIND: f64 = 3.0;
const MAX_TAB_FILL: f64 = 255.0;

/// `TabSpot.cells[n]`
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CellSpot {
    pub table: usize,
    pub cell: usize,
    pub para: usize,
}

/// `TabSpot`: the keys in the order the TypeScript writes them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TabSpot {
    pub sec: f64,
    pub para: usize,
    pub cells: Vec<CellSpot>,
    pub tab: usize,
    pub tabs: usize,
}

/// `Omit<TabSpot, 'tab' | 'tabs'>`
#[derive(Debug, Clone)]
struct Place {
    sec: f64,
    para: usize,
    cells: Vec<CellSpot>,
}

/// `TabMeasure`, validated: width in HWPUNIT, kind 0-3, leader 0-255.
#[derive(Debug, Clone, Copy)]
struct Measure {
    width: u32,
    kind: u32,
    fill: u32,
}

fn key_of_spot(spot: &TabSpot) -> String {
    let mut parts = vec![number_to_string(spot.sec), spot.para.to_string()];
    for cell in &spot.cells {
        parts.push(format!("{}.{}.{}", cell.table, cell.cell, cell.para));
    }
    parts.push(spot.tab.to_string());
    parts.join("/")
}

/// `value.name` of a parsed value: `undefined` is `None`, a read on `null` throws.
fn prop<'a>(value: &'a Value, name: &str) -> Res<Option<&'a Value>> {
    match value {
        Value::Null => Err(Thrown(format!(
            "Cannot read properties of null (reading '{name}')"
        ))),
        Value::Object(map) => Ok(map.get(name)),
        _ => Ok(None),
    }
}

/// One element of `[...].join('/')`: `null` and `undefined` read as nothing.
fn joined(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        other => value_to_string(other),
    }
}

/// `keyOf(spot)` of a spot that came from the renderer.
fn key_of_value(spot: &Value) -> Res<String> {
    let mut parts = vec![joined(prop(spot, "sec")?), joined(prop(spot, "para")?)];
    let cells = match prop(spot, "cells")? {
        Some(Value::Array(cells)) => cells,
        _ => return Err(Thrown("spot.cells.map is not a function".to_owned())),
    };
    for cell in cells {
        parts.push(format!(
            "{}.{}.{}",
            value_to_string(prop(cell, "table")?),
            value_to_string(prop(cell, "cell")?),
            value_to_string(prop(cell, "para")?),
        ));
    }
    parts.push(joined(prop(spot, "tab")?));
    Ok(parts.join("/"))
}

/// `Number.isInteger(value)` of a property
fn integer_prop(tab: &Value, name: &str) -> Res<Option<f64>> {
    Ok(match prop(tab, name)? {
        Some(Value::Number(number)) => number.as_f64().filter(|x| x.is_finite() && x.floor() == *x),
        _ => None,
    })
}

fn valid_measure(tab: &Value) -> Res<Option<Measure>> {
    let (Some(width), Some(kind), Some(fill)) = (
        integer_prop(tab, "width")?,
        integer_prop(tab, "type")?,
        integer_prop(tab, "fill")?,
    ) else {
        return Ok(None);
    };
    if width > 0.0
        && width <= MAX_TAB_WIDTH
        && (0.0..=MAX_TAB_KIND).contains(&kind)
        && (0.0..=MAX_TAB_FILL).contains(&fill)
    {
        Ok(Some(Measure {
            width: width as u32,
            kind: kind as u32,
            fill: fill as u32,
        }))
    } else {
        Ok(None)
    }
}

// ---- HWP 5 ----

/// A table's control: its id, four characters, read as a little-endian number.
const TABLE_CONTROL: u32 = 0x7462_6c20; // 'tbl '
const TAB: u16 = 9;
/// Characters of the paragraph text that take eight code units (a control and its data).
const LONG_CHARS: [u16; 21] = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
];

struct TextTab {
    at: usize,
    empty: bool,
}

/// Where the code units after a tab character start in a paragraph text, for
/// each tab, and whether the engine wrote it without values: width zero, and
/// no kind or the left kind.
fn tabs_in_text(data: &[u8], text: &HwpRecord) -> Res<Vec<TextTab>> {
    let mut tabs = Vec::new();
    let mut at = text.body;
    while at + 1 < text.end {
        let unit = read_u16(data, at)?;
        if unit < 32 && LONG_CHARS.contains(&unit) {
            if at + 16 > text.end {
                break;
            }
            if unit == TAB {
                let ext = at + 2;
                let kind = read_u16(data, ext + 4)?;
                let empty = read_u32(data, ext)? == 0
                    && (kind == 0 || kind == 0x0100)
                    && read_u16(data, ext + 6)? == 0
                    && read_u16(data, ext + 8)? == 0
                    && read_u16(data, ext + 10)? == 0;
                tabs.push(TextTab { at: ext, empty });
            }
            at += 16;
        } else {
            at += 2;
        }
    }
    Ok(tabs)
}

struct FoundTab {
    spot: TabSpot,
    /// where its values go in the section stream
    at: usize,
}

/// The tabs without values in the paragraphs of one list (a section body or a cell).
fn walk_hwp_list(
    data: &[u8],
    records: &[HwpRecord],
    from: usize,
    to: usize,
    level: u32,
    spot_of: &dyn Fn(usize) -> Place,
    out: &mut Vec<FoundTab>,
) -> Res<()> {
    let mut k: i64 = -1;
    let mut i = from;
    while i < to {
        let record = records[i];
        if record.tag != PARA_HEADER || record.level != level {
            i += 1;
            continue;
        }
        k += 1;
        let mut end = i + 1;
        while end < to && records[end].level > level {
            end += 1;
        }
        let place = spot_of(k as usize);
        let mut tables = 0;
        for j in i + 1..end {
            let child = records[j];
            if child.level != level + 1 {
                continue;
            }
            if child.tag == PARA_TEXT {
                let tabs = tabs_in_text(data, &child)?;
                let count = tabs.len();
                for (nth, tab) in tabs.iter().enumerate() {
                    if tab.empty {
                        out.push(FoundTab {
                            spot: TabSpot {
                                sec: place.sec,
                                para: place.para,
                                cells: place.cells.clone(),
                                tab: nth,
                                tabs: count,
                            },
                            at: tab.at,
                        });
                    }
                }
            } else if child.tag == CTRL_HEADER
                && child.end - child.body >= 4
                && read_u32(data, child.body)? == TABLE_CONTROL
            {
                let table = tables;
                tables += 1;
                let mut table_end = j + 1;
                while table_end < end && records[table_end].level > level + 1 {
                    table_end += 1;
                }
                // each cell: a list header, then its paragraphs, all one level below the control
                let mut cell: i64 = -1;
                let mut m = j + 1;
                while m < table_end {
                    let head = records[m];
                    if head.level != level + 2 || head.tag != LIST_HEADER {
                        m += 1;
                        continue;
                    }
                    cell += 1;
                    let mut cell_end = m + 1;
                    while cell_end < table_end
                        && !(records[cell_end].level == level + 2
                            && records[cell_end].tag == LIST_HEADER)
                    {
                        cell_end += 1;
                    }
                    let this_cell = cell as usize;
                    let outer = place.clone();
                    walk_hwp_list(
                        data,
                        records,
                        m + 1,
                        cell_end,
                        level + 2,
                        &move |p| {
                            let mut cells = outer.cells.clone();
                            cells.push(CellSpot {
                                table,
                                cell: this_cell,
                                para: p,
                            });
                            Place {
                                sec: outer.sec,
                                para: outer.para,
                                cells,
                            }
                        },
                        out,
                    )?;
                    m = cell_end;
                }
            }
        }
        i = end;
    }
    Ok(())
}

fn hwp_tabs(file: &[u8]) -> Res<Option<Vec<Vec<FoundTab>>>> {
    let Some(opened) = open_hwp(file)? else {
        return Ok(None);
    };
    let mut sections = Vec::new();
    let count = section_count(&opened);
    for sec in 0..count {
        let data = stream_of(&opened, &section(sec))?;
        let records = data.as_deref().and_then(records_of);
        let (Some(data), Some(records)) = (data, records) else {
            return Ok(None);
        };
        let mut found = Vec::new();
        walk_hwp_list(
            &data,
            &records,
            0,
            records.len(),
            0,
            &|k| Place {
                sec: sec as f64,
                para: k,
                cells: Vec::new(),
            },
            &mut found,
        )?;
        sections.push(found);
    }
    Ok(Some(sections))
}

/// What writing the measured tabs into a file came to.
enum Rewrite {
    /// `null`: the file cannot be rewritten as meant
    Failed,
    /// the file itself: nothing was due
    Unchanged,
    Bytes(Vec<u8>),
}

impl Rewrite {
    fn of(bytes: Option<Vec<u8>>) -> Self {
        bytes.map_or(Rewrite::Failed, Rewrite::Bytes)
    }
}

fn write_hwp_tabs(file: &[u8], measured: &HashMap<String, Measure>) -> Res<Rewrite> {
    let opened = open_hwp(file)?;
    let sections = hwp_tabs(file)?;
    let (Some(mut opened), Some(sections)) = (opened, sections) else {
        return Ok(Rewrite::Failed);
    };
    let mut changed: Vec<(String, Vec<u8>)> = Vec::new();
    for (sec, found) in sections.iter().enumerate() {
        let due: Vec<&FoundTab> = found
            .iter()
            .filter(|tab| measured.contains_key(&key_of_spot(&tab.spot)))
            .collect();
        if due.is_empty() {
            continue;
        }
        let Some(mut data) = stream_of(&opened, &section(sec))? else {
            return Err(Thrown("Buffer.from(null)".to_owned()));
        };
        for tab in due {
            let value = measured[&key_of_spot(&tab.spot)];
            write_u32(&mut data, value.width, tab.at)?;
            // the kind one above how tab stops number it, in the high byte; the leader in the low one
            write_u16(
                &mut data,
                (((value.kind + 1) << 8) | value.fill) as u16,
                tab.at + 4,
            )?;
        }
        changed.push((section(sec), data));
    }
    if changed.is_empty() {
        return Ok(Rewrite::Unchanged);
    }
    Ok(Rewrite::of(rewrite_streams(&mut opened, &changed)?))
}

// ---- HWPX ----

struct ZipEntry {
    name: String,
    /// the central directory record
    central: Vec<u8>,
    /// where its local header starts, and where the next entry's does
    start: usize,
    end: usize,
    method: u16,
    compressed_size: usize,
    data_start: usize,
    /// its place in the central directory
    order: usize,
}

const LOCAL_SIGNATURE: u32 = 0x0403_4b50;
const CENTRAL_SIGNATURE: u32 = 0x0201_4b50;
const END_SIGNATURE: u32 = 0x0605_4b50;
const END_SIZE: usize = 22;
const MAX_COMMENT: usize = 0xffff;
const STORED: u16 = 0;
const DEFLATED: u16 = 8;
/// general purpose flags: sizes follow the data; encrypted
const DATA_DESCRIPTOR: u16 = 0x8;
const ENCRYPTED_ENTRY: u16 = 0x1;

/// The entries of a zip in the order of the file, or `None` for one this does not handle.
fn zip_entries(zip: &[u8]) -> Res<Option<(Vec<ZipEntry>, usize)>> {
    let mut end_at: Option<usize> = None;
    let top = zip.len() as i64 - END_SIZE as i64;
    let low = (zip.len() as i64 - END_SIZE as i64 - MAX_COMMENT as i64).max(0);
    let mut at = top;
    while at >= low {
        if read_u32(zip, at as usize)? == END_SIGNATURE {
            end_at = Some(at as usize);
            break;
        }
        at -= 1;
    }
    let Some(end_at) = end_at else {
        return Ok(None);
    };
    let count = usize::from(read_u16(zip, end_at + 10)?);
    let central_size = read_u32(zip, end_at + 12)? as usize;
    let central_start = read_u32(zip, end_at + 16)? as usize;
    // zip64 and archives split over disks are not written by the engine
    if count == 0xffff || central_start == 0xffff_ffff || read_u16(zip, end_at + 4)? != 0 {
        return Ok(None);
    }
    if central_start + central_size > end_at {
        return Ok(None);
    }
    let mut entries: Vec<ZipEntry> = Vec::new();
    let mut at = central_start;
    for n in 0..count {
        if at + 46 > end_at || read_u32(zip, at)? != CENTRAL_SIGNATURE {
            return Ok(None);
        }
        let flags = read_u16(zip, at + 8)?;
        let method = read_u16(zip, at + 10)?;
        let compressed_size = read_u32(zip, at + 20)? as usize;
        let name_length = usize::from(read_u16(zip, at + 28)?);
        let length = 46
            + name_length
            + usize::from(read_u16(zip, at + 30)?)
            + usize::from(read_u16(zip, at + 32)?);
        let start = read_u32(zip, at + 42)? as usize;
        if flags & ENCRYPTED_ENTRY != 0 {
            return Ok(None);
        }
        if start + 30 > central_start || read_u32(zip, start)? != LOCAL_SIGNATURE {
            return Ok(None);
        }
        let data_start = start
            + 30
            + usize::from(read_u16(zip, start + 26)?)
            + usize::from(read_u16(zip, start + 28)?);
        let name_end = (at + 46 + name_length).min(zip.len());
        entries.push(ZipEntry {
            name: String::from_utf8_lossy(&zip[(at + 46).min(name_end)..name_end]).into_owned(),
            central: zip[at..(at + length).min(zip.len())].to_vec(),
            start,
            end: 0,
            method,
            compressed_size,
            data_start,
            order: n,
        });
        at += length;
    }
    let mut ordered = entries;
    sort_by_number(&mut ordered, |a, b| a.start as f64 - b.start as f64);
    for index in 0..ordered.len() {
        ordered[index].end = ordered
            .get(index + 1)
            .map_or(central_start, |next| next.start);
    }
    if ordered
        .iter()
        .any(|entry| entry.data_start + entry.compressed_size > entry.end)
    {
        return Ok(None);
    }
    Ok(Some((ordered, central_start)))
}

/// The bytes of an entry, or `None` for a compression this does not handle.
/// Throws when the entry is not deflate data, and likewise when it inflates
/// past the ceiling an HWP 5 stream has.
fn entry_data(zip: &[u8], entry: &ZipEntry) -> Res<Option<Vec<u8>>> {
    let from = entry.data_start.min(zip.len());
    let to = (entry.data_start + entry.compressed_size).min(zip.len());
    let raw = &zip[from..to];
    if entry.method == STORED {
        return Ok(Some(raw.to_vec()));
    }
    if entry.method == DEFLATED {
        return Ok(Some(inflate_raw_sync(raw, MAX_STREAM_INFLATE_BYTES)?));
    }
    Ok(None)
}

/// The zip with some entries' content replaced; every other entry's bytes are copied as they were.
fn rewrite_zip(zip: &[u8], entries: &[ZipEntry], changed: &JsMap<Vec<u8>>) -> Res<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<Vec<u8>> = Vec::new();
    let mut offset: usize = 0;
    for entry in entries {
        let content = changed.get(&entry.name);
        let mut record = entry.central.clone();
        write_u32_f64(&mut record, offset as f64, 42)?;
        match content {
            None => {
                let piece = &zip[entry.start.min(zip.len())..entry.end.min(zip.len())];
                out.extend_from_slice(piece);
                offset += piece.len();
            }
            Some(content) => {
                let data = if entry.method == STORED {
                    content.clone()
                } else {
                    deflate_raw_sync(content)?
                };
                let crc = crc32(content);
                let name_and_extra = &zip[entry.start + 30..entry.data_start];
                let mut local = zip[entry.start..entry.start + 30].to_vec();
                // the sizes go in the header now, so no descriptor follows the data
                let flags = read_u16(&local, 6)? & !DATA_DESCRIPTOR;
                write_u16(&mut local, flags, 6)?;
                write_u32(&mut local, crc, 14)?;
                write_u32_f64(&mut local, data.len() as f64, 18)?;
                write_u32_f64(&mut local, content.len() as f64, 22)?;
                let central_flags = read_u16(&record, 8)? & !DATA_DESCRIPTOR;
                write_u16(&mut record, central_flags, 8)?;
                write_u32(&mut record, crc, 16)?;
                write_u32_f64(&mut record, data.len() as f64, 20)?;
                write_u32_f64(&mut record, content.len() as f64, 24)?;
                offset += local.len() + name_and_extra.len() + data.len();
                out.extend_from_slice(&local);
                out.extend_from_slice(name_and_extra);
                out.extend_from_slice(&data);
            }
        }
        central.push(record);
    }
    // the central directory in its own order, as it was
    let mut by_order: Vec<(usize, Vec<u8>)> = entries
        .iter()
        .zip(central)
        .map(|(entry, record)| (entry.order, record))
        .collect();
    sort_by_number(&mut by_order, |a, b| a.0 as f64 - b.0 as f64);
    let directory: Vec<u8> = by_order
        .into_iter()
        .flat_map(|(_, record)| record)
        .collect();
    let mut end = vec![0u8; END_SIZE];
    write_u32(&mut end, END_SIGNATURE, 0)?;
    write_u16(&mut end, entries.len() as u16, 8)?;
    write_u16(&mut end, entries.len() as u16, 10)?;
    write_u32_f64(&mut end, directory.len() as f64, 12)?;
    write_u32_f64(&mut end, offset as f64, 16)?;
    out.extend_from_slice(&directory);
    out.extend_from_slice(&end);
    Ok(out)
}

struct XmlTab {
    spot: Place,
    tab: usize,
    /// the tab element in the section text
    start: usize,
    end: usize,
    /// where its paragraph's tab count is kept until the paragraph closes
    counter: usize,
}

struct Frame {
    name: String,
    /// for a paragraph: where it is, or `None` when it is not one looked at
    place: Option<Place>,
    counter: Option<usize>,
    tables: usize,
    /// for a table: its place among its paragraph's tables, and its cells so far
    table: Option<usize>,
    cells: usize,
    /// for a cell: which one, and its paragraphs so far
    cell: Option<usize>,
    paras: usize,
}

impl Frame {
    fn new(name: &str) -> Self {
        Frame {
            name: name.to_owned(),
            place: None,
            counter: None,
            tables: 0,
            table: None,
            cells: 0,
            cell: None,
            paras: 0,
        }
    }
}

struct XmlSection {
    name: String,
    sec: f64,
    xml: String,
    tabs: Vec<XmlTab>,
    /// the tab count of each paragraph, by `XmlTab::counter`
    counters: Vec<usize>,
}

fn nearest(stack: &[Frame], name: &str) -> Option<usize> {
    (0..stack.len()).rev().find(|&i| stack[i].name == name)
}

/// The tabs without values of one section part: `width="0"` (the engine's way
/// of writing a tab with none) in body paragraphs and the cells of tables in
/// them.
fn xml_tabs(xml: &str, sec: f64) -> Res<(Vec<XmlTab>, Vec<usize>)> {
    let tag = try_js_regex!(
        r#"<(\/?)([A-Za-z_][\w.-]*:)?([A-Za-z_][\w.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>"#,
        "g"
    );
    let width_attr = jscompat::js_regex!(r#"\swidth="([^"]*)""#);
    let mut stack: Vec<Frame> = Vec::new();
    let mut out: Vec<XmlTab> = Vec::new();
    let mut counters: Vec<usize> = Vec::new();
    let mut body_paras = 0usize;
    for found in tag.try_find_iter(xml) {
        let found = found.map_err(|limit| Thrown(limit.to_string()))?;
        let whole = found.as_str();
        let closing = found.get(1).unwrap_or("");
        let name = found.get(3).unwrap_or("");
        let attrs = found.get(4).unwrap_or("");
        let self_closing = found.get(5).unwrap_or("");
        if whole.starts_with("<?") || whole.starts_with("<!") {
            continue;
        }
        if !closing.is_empty() {
            // close up to the matching element
            for i in (0..stack.len()).rev() {
                if stack[i].name == name {
                    stack.truncate(i);
                    break;
                }
            }
            continue;
        }
        let mut frame = Frame::new(name);
        if name == "p" {
            let parent_name = stack.last().map(|frame| frame.name.as_str());
            let grand_name = stack.len().checked_sub(2).map(|at| stack[at].name.as_str());
            if parent_name == Some("sec") {
                frame.place = Some(Place {
                    sec,
                    para: body_paras,
                    cells: Vec::new(),
                });
                body_paras += 1;
            } else if parent_name == Some("subList") && grand_name == Some("tc") {
                let cell_at = stack.len() - 2;
                let table_at = nearest(&stack, "tbl");
                // the paragraph the table sits in: the nearest one below the table
                let mut outer: Option<usize> = None;
                let mut i: i64 = match table_at {
                    Some(table) => table as i64 - 1,
                    None => -1,
                };
                while i >= 0 {
                    if stack[i as usize].name == "p" {
                        outer = Some(i as usize);
                        break;
                    }
                    i -= 1;
                }
                let k = stack[cell_at].paras;
                stack[cell_at].paras = k + 1;
                frame.place = match (
                    outer.and_then(|at| stack[at].place.as_ref()),
                    table_at.and_then(|at| stack[at].table),
                    stack[cell_at].cell,
                ) {
                    (Some(outer_place), Some(table), Some(cell)) => {
                        let mut cells = outer_place.cells.clone();
                        cells.push(CellSpot {
                            table,
                            cell,
                            para: k,
                        });
                        Some(Place {
                            sec,
                            para: outer_place.para,
                            cells,
                        })
                    }
                    _ => None,
                };
            } else {
                frame.place = None;
            }
            counters.push(0);
            frame.counter = Some(counters.len() - 1);
            frame.tables = 0;
        } else if name == "tbl" {
            if let Some(para) = nearest(&stack, "p") {
                let number = stack[para].tables;
                frame.table = Some(number);
                stack[para].tables = number + 1;
            }
            frame.cells = 0;
        } else if name == "tc" {
            if let Some(table) = nearest(&stack, "tbl") {
                let number = stack[table].cells;
                frame.cell = Some(number);
                stack[table].cells = number + 1;
            }
        } else if name == "tab"
            && let Some(para) = nearest(&stack, "p")
            && let Some(counter) = stack[para].counter
        {
            let nth = counters[counter];
            counters[counter] += 1;
            let zero_width = width_attr
                .exec(attrs)
                .is_some_and(|m| m.get(1) == Some("0"));
            if let Some(place) = &stack[para].place
                && zero_width
            {
                out.push(XmlTab {
                    spot: place.clone(),
                    tab: nth,
                    start: found.start(),
                    end: found.start() + whole.len(),
                    counter,
                });
            }
        }
        if self_closing.is_empty() {
            stack.push(frame);
        }
    }
    Ok((out, counters))
}

const SECTION_PART_PREFIX: &str = "Contents/section";
const SECTION_PART_SUFFIX: &str = ".xml";

/// `/^Contents\/section(\d+)\.xml$/.exec(name)?.[1]`
fn section_number(name: &str) -> Option<&str> {
    let digits = name
        .strip_prefix(SECTION_PART_PREFIX)?
        .strip_suffix(SECTION_PART_SUFFIX)?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then_some(digits)
}

struct HwpxRead {
    entries: Vec<ZipEntry>,
    sections: Vec<XmlSection>,
}

fn hwpx_sections(zip: &[u8]) -> Res<Option<HwpxRead>> {
    let Some((entries, _)) = zip_entries(zip)? else {
        return Ok(None);
    };
    let mut sections = Vec::new();
    for entry in &entries {
        let Some(digits) = section_number(&entry.name) else {
            continue;
        };
        let Some(data) = entry_data(zip, entry)? else {
            return Ok(None);
        };
        let xml = String::from_utf8_lossy(&data).into_owned();
        let sec = to_number(digits);
        let (tabs, counters) = xml_tabs(&xml, sec)?;
        sections.push(XmlSection {
            name: entry.name.clone(),
            sec,
            xml,
            tabs,
            counters,
        });
    }
    Ok(Some(HwpxRead { entries, sections }))
}

fn xml_spot(section: &XmlSection, tab: &XmlTab) -> TabSpot {
    TabSpot {
        sec: tab.spot.sec,
        para: tab.spot.para,
        cells: tab.spot.cells.clone(),
        tab: tab.tab,
        tabs: section.counters[tab.counter],
    }
}

fn write_hwpx_tabs(file: &[u8], measured: &HashMap<String, Measure>) -> Res<Rewrite> {
    let Some(read) = hwpx_sections(file)? else {
        return Ok(Rewrite::Failed);
    };
    let width = jscompat::js_regex!(r#"\swidth="[^"]*""#);
    let leader = jscompat::js_regex!(r#"\sleader="[^"]*""#);
    let kind = jscompat::js_regex!(r#"\stype="[^"]*""#);
    let mut changed: JsMap<Vec<u8>> = JsMap::new();
    for section in &read.sections {
        let mut xml = String::new();
        let mut at = 0usize;
        let mut any = false;
        for tab in &section.tabs {
            let Some(value) = measured.get(&key_of_spot(&xml_spot(section, tab))) else {
                continue;
            };
            let element = &section.xml[tab.start..tab.end];
            let element =
                replace_first_with(width, element, |_| format!(" width=\"{}\"", value.width));
            let element =
                replace_first_with(leader, &element, |_| format!(" leader=\"{}\"", value.fill));
            let element =
                replace_first_with(kind, &element, |_| format!(" type=\"{}\"", value.kind + 1));
            xml.push_str(&section.xml[at..tab.start]);
            xml.push_str(&element);
            at = tab.end;
            any = true;
        }
        if any {
            xml.push_str(&section.xml[at..]);
            changed.set(section.name.clone(), xml.into_bytes());
        }
    }
    if changed.is_empty() {
        return Ok(Rewrite::Unchanged);
    }
    let written = rewrite_zip(file, &read.entries, &changed)?;
    // read back: every other entry as it was, the changed ones as meant
    let Some((check, _)) = zip_entries(&written)? else {
        return Ok(Rewrite::Failed);
    };
    if check.len() != read.entries.len() {
        return Ok(Rewrite::Failed);
    }
    for (index, entry) in check.iter().enumerate() {
        let was = &read.entries[index];
        if entry.name != was.name {
            return Ok(Rewrite::Failed);
        }
        let now = entry_data(&written, entry)?;
        let before = match changed.get(&entry.name) {
            Some(meant) => Some(meant.clone()),
            None => entry_data(file, was)?,
        };
        match (now, before) {
            (Some(now), Some(before)) if now == before => {}
            _ => return Ok(Rewrite::Failed),
        }
    }
    Ok(Rewrite::Bytes(written))
}

// ---- both ----

/// How many memo anchors a HWPX file's section XML holds, or `None` when the
/// zip or a section cannot be read. This is the raw count: the engine may not
/// model every one.
pub fn hwpx_memo_count_of(file: &[u8]) -> Option<usize> {
    fn count(file: &[u8]) -> Res<Option<usize>> {
        let memo_field = jscompat::js_regex!(r#"<[^>]*\btype\s*=\s*["']MEMO["'][^>]*>"#);
        let Some(read) = hwpx_sections(file)? else {
            return Ok(None);
        };
        let mut total = 0;
        for section in &read.sections {
            total += memo_field.find_iter(&section.xml).count();
        }
        Ok(Some(total))
    }
    count(file).unwrap_or(None)
}

fn new_tabs_inner(file: &[u8], format: HwpFormat) -> Res<Vec<TabSpot>> {
    if format == HwpFormat::Hwp {
        let mut spots: Vec<TabSpot> = hwp_tabs(file)?
            .unwrap_or_default()
            .into_iter()
            .flatten()
            .map(|tab| tab.spot)
            .collect();
        spots.truncate(MAX_NEW_TABS);
        return Ok(spots);
    }
    let Some(mut read) = hwpx_sections(file)? else {
        return Ok(Vec::new());
    };
    sort_by_number(&mut read.sections, |a, b| a.sec - b.sec);
    let mut spots: Vec<TabSpot> = read
        .sections
        .iter()
        .flat_map(|section| section.tabs.iter().map(|tab| xml_spot(section, tab)))
        .collect();
    spots.truncate(MAX_NEW_TABS);
    Ok(spots)
}

/// The tabs the engine wrote without values, in the order of the file; at most
/// [`MAX_NEW_TABS`]. Empty for a file without any, or one that cannot be read
/// here. Never throws.
pub fn new_tabs_of(file: &[u8], format: HwpFormat) -> Vec<TabSpot> {
    new_tabs_inner(file, format).unwrap_or_default()
}

/// `{ bytes, written }`
pub struct TabsWritten<'a> {
    pub bytes: Cow<'a, [u8]>,
    pub written: usize,
}

fn write_inner<'a>(file: &'a [u8], format: HwpFormat, measured: &[Value]) -> Res<TabsWritten<'a>> {
    let untouched = || TabsWritten {
        bytes: Cow::Borrowed(file),
        written: 0,
    };
    if measured.is_empty() {
        return Ok(untouched());
    }
    let spots: HashMap<String, TabSpot> = new_tabs_of(file, format)
        .into_iter()
        .map(|spot| (key_of_spot(&spot), spot))
        .collect();
    let mut wanted: HashMap<String, Measure> = HashMap::new();
    for tab in measured.iter().take(MAX_NEW_TABS) {
        let spot = spots.get(&key_of_value(tab)?);
        // the paragraph's tab count is part of the place: one that does not match is not written
        let Some(spot) = spot else {
            continue;
        };
        let tabs_match = matches!(
            prop(tab, "tabs")?,
            Some(Value::Number(number)) if number.as_f64() == Some(spot.tabs as f64)
        );
        if !tabs_match {
            continue;
        }
        if let Some(measure) = valid_measure(tab)? {
            wanted.insert(key_of_value(tab)?, measure);
        }
    }
    if wanted.is_empty() {
        return Ok(untouched());
    }
    let bytes = if format == HwpFormat::Hwp {
        write_hwp_tabs(file, &wanted)?
    } else {
        write_hwpx_tabs(file, &wanted)?
    };
    Ok(match bytes {
        Rewrite::Bytes(bytes) => TabsWritten {
            bytes: Cow::Owned(bytes),
            written: wanted.len(),
        },
        Rewrite::Failed | Rewrite::Unchanged => untouched(),
    })
}

/// The file with the measured values written into the tabs that have none.
/// Only such tabs are written, each one found again by its place in the file;
/// a measure for a place that holds no such tab is dropped. The file comes
/// back as it was when nothing can be written, and when the result cannot be
/// read back as meant. Never throws: a save does not fail on this.
pub fn write_tab_widths<'a>(
    file: &'a [u8],
    format: HwpFormat,
    measured: &[Value],
) -> TabsWritten<'a> {
    write_inner(file, format, measured).unwrap_or(TabsWritten {
        bytes: Cow::Borrowed(file),
        written: 0,
    })
}
