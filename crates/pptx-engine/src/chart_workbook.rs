//! The workbook embedded beside a chart part, which PowerPoint and Word open
//! for "Edit Data" (packages/pptx-engine/src/chart-workbook.ts): one Sheet1
//! with the categories in column A and one column per series from B, the
//! cells the chart's c:f references point at.
//!
//! ```text
//!   A1        | B1 (ser 0 name) | C1 (ser 1 name) ...
//!   A2 (cat0) | B2 (val 0,0)    | C2 (val 1,0)   ...
//! ```

use jscompat::{JsNum, JsObject, number_to_string, string_from_char_code};
use serde::Deserialize;

use crate::crc32::crc32;
use crate::xml_utils::escape_xml_text;

pub const CHART_WORKBOOK_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package";
pub const XLSX_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/// Series data columns start at B (column A holds the categories):
/// 0 → B … 24 → Z, 25 → AA, 26 → AB, … (plain charCode arithmetic breaks past Z).
pub fn col_letter(i: f64) -> String {
    // 1-based column number: A = 1, B = 2
    let mut n = i + 2.0;
    let mut label = String::new();
    while n > 0.0 {
        let rem = (n - 1.0) % 26.0;
        label.insert(0, string_from_char_code(65.0 + rem));
        n = ((n - 1.0) / 26.0).floor();
    }
    label
}

/// `ChartWorkbookData`.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartWorkbookData {
    pub categories: Vec<String>,
    pub series: Vec<ChartWorkbookSeries>,
    #[serde(default)]
    /// column A as numbers instead of category names: a scatter chart's x values
    pub x_values: Option<Vec<JsNum>>,
}

/// One entry of `ChartWorkbookData.series`.
#[derive(Debug, Clone, PartialEq, Default, Deserialize)]
pub struct ChartWorkbookSeries {
    pub name: String,
    /// `None` for `null` and `undefined`.
    pub values: Vec<Option<JsNum>>,
}

const XML_DECL: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

/// `si`: the index of `s` among the shared strings, added at the end when new.
fn si<'a>(strings: &mut Vec<&'a str>, s: &'a str) -> usize {
    if let Some(idx) = strings.iter().position(|string| *string == s) {
        return idx;
    }
    strings.push(s);
    strings.len() - 1
}

/// The workbook's parts, by path inside the xlsx package.
pub fn chart_workbook_parts(data: &ChartWorkbookData) -> JsObject<String> {
    let mut strings: Vec<&str> = Vec::new();

    let mut header_cells = vec![format!(
        "<c r=\"A1\" t=\"s\"><v>{}</v></c>",
        si(&mut strings, "")
    )];
    for (j, ser) in data.series.iter().enumerate() {
        header_cells.push(format!(
            "<c r=\"{}1\" t=\"s\"><v>{}</v></c>",
            col_letter(j as f64),
            si(&mut strings, &ser.name)
        ));
    }
    let mut data_rows = Vec::with_capacity(data.categories.len());
    for (i, category) in data.categories.iter().enumerate() {
        let row_num = i + 2;
        let x = data.x_values.as_ref().and_then(|x_values| x_values.get(i));
        let mut cells = vec![match x {
            Some(x) => format!("<c r=\"A{row_num}\"><v>{}</v></c>", number_to_string(x.0)),
            None => format!(
                "<c r=\"A{row_num}\" t=\"s\"><v>{}</v></c>",
                si(&mut strings, category)
            ),
        }];
        for (j, ser) in data.series.iter().enumerate() {
            // `val != null && Number.isFinite(val)`
            if let Some(JsNum(val)) = ser.values.get(i).copied().flatten()
                && val.is_finite()
            {
                cells.push(format!(
                    "<c r=\"{}{row_num}\"><v>{}</v></c>",
                    col_letter(j as f64),
                    number_to_string(val)
                ));
            }
        }
        data_rows.push(format!("<row r=\"{row_num}\">{}</row>", cells.concat()));
    }

    let mut parts = JsObject::new();
    parts.set(
        "[Content_Types].xml",
        [
            XML_DECL,
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
            "<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
            "<Default Extension=\"xml\" ContentType=\"application/xml\"/>",
            "<Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>",
            "<Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>",
            "<Override PartName=\"/xl/sharedStrings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml\"/>",
            "</Types>",
        ]
        .concat(),
    );
    parts.set(
        "_rels/.rels",
        [
            XML_DECL,
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
            "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>",
            "</Relationships>",
        ]
        .concat(),
    );
    parts.set(
        "xl/workbook.xml",
        [
            XML_DECL,
            "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" ",
            "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
            "<sheets><sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets>",
            "</workbook>",
        ]
        .concat(),
    );
    parts.set(
        "xl/_rels/workbook.xml.rels",
        [
            XML_DECL,
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
            "<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>",
            "<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings\" Target=\"sharedStrings.xml\"/>",
            "</Relationships>",
        ]
        .concat(),
    );
    parts.set(
        "xl/worksheets/sheet1.xml",
        format!(
            "{XML_DECL}<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetData><row r=\"1\">{}</row>{}</sheetData></worksheet>",
            header_cells.concat(),
            data_rows.concat()
        ),
    );
    let count = strings.len();
    let items: String = strings
        .iter()
        .map(|s| {
            format!(
                "<si><t xml:space=\"preserve\">{}</t></si>",
                escape_xml_text(s)
            )
        })
        .collect();
    parts.set(
        "xl/sharedStrings.xml",
        format!(
            "{XML_DECL}<sst xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" count=\"{count}\" uniqueCount=\"{count}\">{items}</sst>"
        ),
    );
    parts
}

const RANGE_ERROR: &str = "RangeError: Offset is outside the bounds of the DataView";

/// `out.set(bytes, offset)`: a write past the end is a RangeError.
fn put(out: &mut [u8], offset: u64, bytes: &[u8]) -> Result<(), String> {
    let slot = usize::try_from(offset)
        .ok()
        .and_then(|start| out.get_mut(start..start.checked_add(bytes.len())?))
        .ok_or_else(|| RANGE_ERROR.to_owned())?;
    slot.copy_from_slice(bytes);
    Ok(())
}

/// `view.setUint16(offset, value, true)`: the value is taken modulo 2^16.
fn set_uint16(out: &mut [u8], offset: u64, value: u64) -> Result<(), String> {
    put(out, offset, &((value & 0xffff) as u16).to_le_bytes())
}

/// `view.setUint32(offset, value, true)`: the value is taken modulo 2^32.
fn set_uint32(out: &mut [u8], offset: u64, value: u64) -> Result<(), String> {
    put(out, offset, &((value & 0xffff_ffff) as u32).to_le_bytes())
}

/// A zip of `files`, stored without compression: the chart engines insert
/// charts synchronously, and a chart's workbook is a few hundred bytes.
pub fn stored_zip(files: &JsObject<String>) -> Result<Vec<u8>, String> {
    let entries: Vec<(&[u8], &[u8], u32)> = files
        .entries()
        .into_iter()
        .map(|(path, text)| (path.as_bytes(), text.as_bytes(), crc32(text.as_bytes())))
        .collect();
    let local_size = entries.iter().fold(0u64, |n, (name, data, _)| {
        n + 30 + name.len() as u64 + data.len() as u64
    });
    let central_size = entries
        .iter()
        .fold(0u64, |n, (name, _, _)| n + 46 + name.len() as u64);
    let length = usize::try_from(local_size + central_size + 22)
        .map_err(|_| "RangeError: Invalid typed array length".to_owned())?;
    let mut out = vec![0u8; length];
    let mut local = 0u64;
    let mut central = local_size;
    for &(name, data, crc) in &entries {
        let (name_length, data_length) = (name.len() as u64, data.len() as u64);
        set_uint32(&mut out, local, 0x0403_4b50)?;
        set_uint16(&mut out, local + 4, 10)?;
        set_uint16(&mut out, local + 6, 0x0800)?;
        // 1980-01-01, the DOS epoch
        set_uint16(&mut out, local + 12, 0x21)?;
        set_uint32(&mut out, local + 14, u64::from(crc))?;
        set_uint32(&mut out, local + 18, data_length)?;
        set_uint32(&mut out, local + 22, data_length)?;
        set_uint16(&mut out, local + 26, name_length)?;
        put(&mut out, local + 30, name)?;
        put(&mut out, local + 30 + name_length, data)?;

        set_uint32(&mut out, central, 0x0201_4b50)?;
        set_uint16(&mut out, central + 4, 20)?;
        set_uint16(&mut out, central + 6, 10)?;
        set_uint16(&mut out, central + 8, 0x0800)?;
        set_uint16(&mut out, central + 14, 0x21)?;
        set_uint32(&mut out, central + 16, u64::from(crc))?;
        set_uint32(&mut out, central + 20, data_length)?;
        set_uint32(&mut out, central + 24, data_length)?;
        set_uint16(&mut out, central + 28, name_length)?;
        set_uint32(&mut out, central + 42, local)?;
        put(&mut out, central + 46, name)?;

        local += 30 + name_length + data_length;
        central += 46 + name_length;
    }
    let count = entries.len() as u64;
    set_uint32(&mut out, central, 0x0605_4b50)?;
    set_uint16(&mut out, central + 8, count)?;
    set_uint16(&mut out, central + 10, count)?;
    set_uint32(&mut out, central + 12, central_size)?;
    set_uint32(&mut out, central + 16, local_size)?;
    Ok(out)
}

pub fn chart_workbook_xlsx(data: &ChartWorkbookData) -> Result<Vec<u8>, String> {
    stored_zip(&chart_workbook_parts(data))
}
