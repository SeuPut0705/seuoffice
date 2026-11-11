//! The .xlsx package every legacy-format import writes into. Each dialect reads
//! its own container — an OLE2 workbook, an ODF zip, an XML spreadsheet — but
//! they all emit the same OOXML parts, so the writer, the relationship set, and
//! the reference and date helpers live here instead of being restated per
//! dialect. What a dialect owns is only its own cell content.

use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use crate::SidecarError;

/// One entry of the workbook's sheet list, in document order.
pub(crate) struct SheetSpec {
    pub(crate) name: String,
    /// OOXML `state` attribute: `None` is the visible default, and the source
    /// dialect's hidden/very-hidden states arrive already translated.
    pub(crate) state: Option<&'static str>,
}

/// The drawing of one sheet: its parts go beside the sheet's own, numbered by
/// sheet (`drawing3.xml` belongs to `sheet3.xml`). `media` names are unique
/// across the whole package.
pub(crate) struct SheetArt {
    pub(crate) xml: String,
    /// The drawing's relationship part: one image reference per `rId`.
    pub(crate) rels: String,
    /// (part name, bytes) — `xl/media/image1.png` and friends.
    pub(crate) media: Vec<(String, Vec<u8>)>,
    /// `(part name, content type, bytes)` of the parts the drawing points at
    /// besides its media: charts and their relationship parts.
    pub(crate) parts: Vec<(String, Option<&'static str>, Vec<u8>)>,
    /// `(part name, entry name)`: media streamed out of the source package
    /// (`PackageExtras::source`) instead of being held in memory.
    pub(crate) copied: Vec<(String, String)>,
}

/// One relationship of a sheet beyond its drawing: a link target, the notes
/// part, the legacy drawing behind the notes.
pub(crate) struct PartRelationship {
    pub(crate) id: String,
    pub(crate) kind: &'static str,
    pub(crate) target: String,
    /// True for a target outside the package (a URL).
    pub(crate) external: bool,
}

/// What a sheet brings besides its own part and its drawing.
#[derive(Default)]
pub(crate) struct SheetExtras {
    pub(crate) relationships: Vec<PartRelationship>,
    /// `(part name, content type, bytes)`. A part without a content type of
    /// its own relies on the default for its extension.
    pub(crate) parts: Vec<(String, Option<&'static str>, Vec<u8>)>,
    /// The relationship id of the legacy drawing, when the sheet has notes.
    pub(crate) legacy_drawing: Option<String>,
}

/// What a dialect adds to the package beyond sheets, drawings and styles.
#[derive(Default)]
pub(crate) struct PackageExtras {
    /// `<bookViews>…</bookViews>`, or nothing.
    pub(crate) book_views: String,
    /// Runs alongside the sheets; a missing entry is an empty one.
    pub(crate) sheets: Vec<SheetExtras>,
    /// The zip package `SheetArt::copied` entries are read from.
    pub(crate) source: Option<PathBuf>,
    /// `(cache id, part name under xl/)` of each pivot cache definition. The
    /// parts themselves travel with the sheet their pivot table is on.
    pub(crate) pivot_caches: Vec<(u32, String)>,
}

/// Writes the whole package. `sheet_xmls` runs in the same order as `sheets`:
/// entry *n* becomes `xl/worksheets/sheet{n}.xml`. `art` runs alongside it —
/// one optional drawing per sheet.
pub(crate) fn write_package(
    target: &Path,
    sheets: &[SheetSpec],
    defined_names: &str,
    sheet_xmls: &[String],
    art: &[Option<SheetArt>],
    styles_xml: &str,
) -> Result<(), SidecarError> {
    write_package_with(
        target,
        sheets,
        defined_names,
        sheet_xmls,
        art,
        styles_xml,
        &PackageExtras::default(),
    )
}

/// `write_package` with the parts only some dialects have.
pub(crate) fn write_package_with(
    target: &Path,
    sheets: &[SheetSpec],
    defined_names: &str,
    sheet_xmls: &[String],
    art: &[Option<SheetArt>],
    styles_xml: &str,
    extras: &PackageExtras,
) -> Result<(), SidecarError> {
    let file = File::create(target)?;
    let mut writer = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    fn add(
        writer: &mut ZipWriter<File>,
        name: &str,
        content: &str,
        options: SimpleFileOptions,
    ) -> Result<(), SidecarError> {
        writer.start_file(name, options)?;
        writer.write_all(content.as_bytes())?;
        Ok(())
    }
    fn add_binary(
        writer: &mut ZipWriter<File>,
        name: &str,
        content: &[u8],
        options: SimpleFileOptions,
    ) -> Result<(), SidecarError> {
        writer.start_file(name, options)?;
        writer.write_all(content)?;
        Ok(())
    }

    add(
        &mut writer,
        "[Content_Types].xml",
        &content_types_xml(sheets.len(), art, extras),
        options,
    )?;
    add(&mut writer, "_rels/.rels", ROOT_RELS, options)?;
    add(
        &mut writer,
        "xl/workbook.xml",
        &workbook_xml(sheets, defined_names, &extras.book_views, &extras.pivot_caches),
        options,
    )?;
    add(
        &mut writer,
        "xl/_rels/workbook.xml.rels",
        &workbook_rels_xml(sheets.len(), &extras.pivot_caches),
        options,
    )?;
    add(&mut writer, "xl/styles.xml", styles_xml, options)?;
    for (index, xml) in sheet_xmls.iter().enumerate() {
        add(
            &mut writer,
            &format!("xl/worksheets/sheet{}.xml", index + 1),
            xml,
            options,
        )?;
        let sheet_art = art.get(index).and_then(Option::as_ref);
        let sheet_extras = extras.sheets.get(index);
        if sheet_art.is_some()
            || sheet_extras.is_some_and(|extras| !extras.relationships.is_empty())
        {
            let n = index + 1;
            add(
                &mut writer,
                &format!("xl/worksheets/_rels/sheet{n}.xml.rels"),
                &worksheet_rels_xml(n, sheet_art.is_some(), sheet_extras),
                options,
            )?;
        }
        if let Some(sheet_extras) = sheet_extras {
            for (name, _, bytes) in &sheet_extras.parts {
                add_binary(&mut writer, name, bytes, options)?;
            }
        }
        if let Some(art) = sheet_art {
            let n = index + 1;
            add(
                &mut writer,
                &format!("xl/drawings/drawing{n}.xml"),
                &art.xml,
                options,
            )?;
            add(
                &mut writer,
                &format!("xl/drawings/_rels/drawing{n}.xml.rels"),
                &art.rels,
                options,
            )?;
        }
    }
    for entry in art.iter().flatten() {
        for (name, bytes) in &entry.media {
            add_binary(&mut writer, name, bytes, options)?;
        }
        for (name, _, bytes) in &entry.parts {
            add_binary(&mut writer, name, bytes, options)?;
        }
    }
    if art.iter().flatten().any(|entry| !entry.copied.is_empty()) {
        // One entry at a time goes from the source to the target, so a
        // document full of photographs costs no more memory than one.
        let source = extras.source.as_deref().ok_or_else(|| {
            SidecarError::Workbook("The drawing media has no source package.".into())
        })?;
        let mut archive = zip::ZipArchive::new(File::open(source)?)?;
        for (name, entry_name) in art.iter().flatten().flat_map(|entry| &entry.copied) {
            let mut entry = archive.by_name(entry_name)?;
            let declared = entry.size();
            writer.start_file(name.as_str(), options)?;
            crate::xml_util::copy_entry_bounded(
                &mut entry,
                declared,
                crate::archive::MAX_EXTRACTED_ENTRY_BYTES,
                &mut writer,
            )?;
        }
    }
    crate::archive::sync_best_effort(&writer.finish()?)?;
    Ok(())
}

/// The `<worksheet>` wrapper: a dimension, then the parts the schema fixes in
/// this order — `<sheetFormatPr>`, `cols`, the data, and the dialect's trailing
/// parts (merges, the drawing reference). `sheet_format` arrives already
/// serialized and is empty when the sheet keeps Excel's default row height.
/// The `r` namespace is declared even when unused so callers can append
/// `<drawing r:id>` freely.
pub(crate) fn worksheet_document(
    dimension: &str,
    sheet_format: &str,
    columns: &str,
    sheet_data: &str,
    tail: &str,
) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="{dimension}"/>{sheet_format}{columns}<sheetData>{sheet_data}</sheetData>{tail}</worksheet>"#,
    )
}

pub(crate) fn cell_reference(row: u32, column: u32) -> String {
    let mut letters = String::new();
    let mut remaining = column + 1;
    while remaining > 0 {
        remaining -= 1;
        letters.insert(0, char::from(b'A' + (remaining % 26) as u8));
        remaining /= 26;
    }
    format!("{letters}{}", row + 1)
}

/// The locked spelling, for a reference the source marked absolute. R1C1's
pub(crate) fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Excel serial for an ISO date (`2026-03-05`, optionally followed by `T10:20:30`
/// and a fraction). `None` keeps the cell a string instead of guessing —
/// including below 1900-03-01, where Excel's phantom 1900 leap day makes a
/// computed serial one too low.
pub(crate) fn iso_serial(text: &str) -> Option<f64> {
    let (date, time) = match text.split_once('T') {
        Some((date, time)) => (date, Some(time)),
        None => (text, None),
    };
    let mut fields = date.split('-');
    let year: i64 = fields.next()?.parse().ok()?;
    let month: i64 = fields.next()?.parse().ok()?;
    let day: i64 = fields.next()?.parse().ok()?;
    if fields.next().is_some()
        || !(1900..=9999).contains(&year)
        || !(1..=12).contains(&month)
        || day < 1
        || day > i64::from(days_in_month(year, month))
    {
        return None;
    }
    // Serial 1 is 1900-01-01 for Excel's own arithmetic, but the 1900-02-29 it
    // never had puts every later date one above the plain day count, which the
    // 1899-12-30 epoch absorbs.
    let mut serial = (days_from_civil(year, month, day) - days_from_civil(1899, 12, 30)) as f64;
    if let Some(time) = time {
        let mut parts = time.split(':');
        let hours: f64 = unsigned_number(parts.next()?)?;
        let minutes: f64 = unsigned_number(parts.next()?)?;
        let seconds_text = parts.next()?;
        if parts.next().is_some() {
            return None;
        }
        let (whole, fraction) = match seconds_text.split_once('.') {
            Some((whole, fraction)) => (
                unsigned_number(whole)?,
                unsigned_number(fraction)? / 10f64.powi(fraction.chars().count() as i32),
            ),
            None => (unsigned_number(seconds_text)?, 0.0),
        };
        if hours > 23.0 || minutes > 59.0 || whole > 60.0 {
            return None;
        }
        serial += (hours * 3600.0 + minutes * 60.0 + whole + fraction) / 86_400.0;
    }
    if serial < 61.0 || serial > 2_958_465.0 {
        return None;
    }
    Some(serial)
}

/// Digits only, no sign and no exponent: `"05"` parses to 5 while `"+5"`,
/// `"1e3"` and `"30Z"` are refused.
fn unsigned_number(text: &str) -> Option<f64> {
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn days_in_month(year: i64, month: i64) -> u32 {
    const LENGTHS: [u32; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let leap = month == 2 && (year % 4 == 0 && (year % 100 != 0 || year % 400 == 0));
    if leap {
        29
    } else {
        LENGTHS[(month - 1) as usize]
    }
}

/// Days from the civil calendar epoch 1970-01-01 (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = if shifted >= 0 { shifted } else { shifted - 399 } / 400;
    let year_of_era = shifted - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn content_types_xml(
    sheet_count: usize,
    art: &[Option<SheetArt>],
    extras: &PackageExtras,
) -> String {
    let overrides: String = (1..=sheet_count)
        .map(|index| format!(
            r#"<Override PartName="/xl/worksheets/sheet{index}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>"#,
        ))
        .collect();
    let drawings: String = art
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| entry.as_ref().map(|_| index + 1))
        .map(|n| format!(
            r#"<Override PartName="/xl/drawings/drawing{n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>"#,
        ))
        .collect();
    let mut extensions = String::new();
    let mut parts = String::new();
    for (name, content_type, _) in extras.sheets.iter().flat_map(|sheet| &sheet.parts) {
        match content_type {
            Some(content_type) => parts.push_str(&format!(
                r#"<Override PartName="/{name}" ContentType="{content_type}"/>"#
            )),
            None if name.ends_with(".vml") && !extensions.contains("vml") => extensions.push_str(
                r#"<Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/>"#,
            ),
            None => {}
        }
    }
    // One default per media extension in use, in a fixed order.
    for (extension, content_type) in MEDIA_TYPES {
        let suffix = format!(".{extension}");
        let used = art.iter().flatten().any(|entry| {
            entry
                .media
                .iter()
                .map(|(name, _)| name)
                .chain(entry.copied.iter().map(|(name, _)| name))
                .any(|name| name.ends_with(&suffix))
        });
        if used {
            extensions.push_str(&format!(
                r#"<Default Extension="{extension}" ContentType="{content_type}"/>"#
            ));
        }
    }
    for (name, content_type, _) in art.iter().flatten().flat_map(|entry| &entry.parts) {
        if let Some(content_type) = content_type {
            parts.push_str(&format!(
                r#"<Override PartName="/{name}" ContentType="{content_type}"/>"#
            ));
        }
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>{extensions}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>{overrides}{drawings}{parts}</Types>"#,
    )
}

/// The media a drawing may embed, by the extension its part is written
/// under: the picture formats Excel draws.
pub(crate) const MEDIA_TYPES: [(&str, &str); 9] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("bmp", "image/bmp"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("emf", "image/x-emf"),
    ("wmf", "image/x-wmf"),
];

/// A sheet with a drawing keeps it at `rId1`; whatever else the dialect
/// brings follows under the ids it chose.
fn worksheet_rels_xml(n: usize, drawing: bool, extras: Option<&SheetExtras>) -> String {
    let mut relationships = String::new();
    if drawing {
        relationships.push_str(&format!(
            r#"<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing{n}.xml"/>"#
        ));
    }
    for relationship in extras.iter().flat_map(|extras| &extras.relationships) {
        relationships.push_str(&format!(
            r#"<Relationship Id="{}" Type="{}" Target="{}"{}/>"#,
            escape_xml(&relationship.id),
            relationship.kind,
            escape_xml(&relationship.target),
            if relationship.external {
                r#" TargetMode="External""#
            } else {
                ""
            },
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{relationships}</Relationships>"#,
    )
}

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"#;

/// The relationship id of the workbook's *n*th pivot cache: the sheets and
/// the styles come first.
fn pivot_cache_relationship(sheet_count: usize, position: usize) -> String {
    format!("rId{}", sheet_count + 2 + position)
}

/// `defined_names` arrives already spelled as `<definedName>` elements, and
/// goes in after `<sheets>` where the schema wants it; the pivot caches close
/// the workbook.
fn workbook_xml(
    sheets: &[SheetSpec],
    defined_names: &str,
    book_views: &str,
    pivot_caches: &[(u32, String)],
) -> String {
    let entries: String = sheets
        .iter()
        .enumerate()
        .map(|(index, sheet)| {
            let state = sheet
                .state
                .map(|value| format!(r#" state="{value}""#))
                .unwrap_or_default();
            format!(
                r#"<sheet name="{}" sheetId="{}" r:id="rId{}"{state}/>"#,
                escape_xml(&sheet.name),
                index + 1,
                index + 1,
            )
        })
        .collect();
    let names = if defined_names.is_empty() {
        String::new()
    } else {
        format!("<definedNames>{defined_names}</definedNames>")
    };
    let caches = if pivot_caches.is_empty() {
        String::new()
    } else {
        let entries: String = pivot_caches
            .iter()
            .enumerate()
            .map(|(position, (id, _))| {
                format!(
                    r#"<pivotCache cacheId="{id}" r:id="{}"/>"#,
                    pivot_cache_relationship(sheets.len(), position)
                )
            })
            .collect();
        format!("<pivotCaches>{entries}</pivotCaches>")
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">{book_views}<sheets>{entries}</sheets>{names}{caches}</workbook>"#,
    )
}

fn workbook_rels_xml(sheet_count: usize, pivot_caches: &[(u32, String)]) -> String {
    let mut relationships: String = (1..=sheet_count)
        .map(|index| format!(
            r#"<Relationship Id="rId{index}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{index}.xml"/>"#,
        ))
        .collect();
    relationships.push_str(&format!(
        r#"<Relationship Id="rId{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>"#,
        sheet_count + 1,
    ));
    for (position, (_, target)) in pivot_caches.iter().enumerate() {
        relationships.push_str(&format!(
            r#"<Relationship Id="{}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="{}"/>"#,
            pivot_cache_relationship(sheet_count, position),
            escape_xml(target),
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{relationships}</Relationships>"#,
    )
}

/// xf 1 = short date (numFmt 14), xf 2 = date+time (numFmt 22).
pub(crate) const STYLES_XML: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>"#;
