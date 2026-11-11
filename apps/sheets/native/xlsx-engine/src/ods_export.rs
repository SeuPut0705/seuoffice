//! `.xlsx` → `.ods` export: a whole conversion, not a byte-preserving edit
//! (decision 0119).
//!
//! The workbook is opened through `WorkbookSessions`, so the export reuses the
//! model the editor already parsed — cell values and formulas, styles, merges,
//! column widths and row heights, page setup, visuals, conditional rules and
//! validations — instead of reading the package a second time. The writer is
//! new: values, formulas, merges, sizing, cell formatting, names, links,
//! notes, outlines, filters and print settings go into a fresh ODS package,
//! and everything ODF cannot carry is counted so the app can warn before
//! saving.
//!
//! Memory stays bounded: one sheet is read in `read_range` windows and each
//! row is written out as soon as it is built, so a million-row sheet never
//! exists as one string. The package is written to a sibling temp file and
//! renamed into place, so a failure leaves no partial `.ods` behind.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use uuid::Uuid;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::odf_formula::{self, Names};
use crate::ods_chart::{accent_palette, chart_document};
use crate::ods_drawing::{
    Drawings, EmbeddedObject, Geometry, Picture, default_column_points, width_points,
};
use crate::ods_pivot::{NamedSources, named_sources, pivot_table_xml};
use crate::ods_print::{
    PageStyles, parse_print_extras, print_titles, split_outside_quotes, worksheet_tail,
};
use crate::ods_rules::{
    SparklineExtra, ValidationArea, Validations, conditional_formats_xml, parse_rule_extras,
    parse_sparkline_extras,
};
use crate::ods_styles::{DEFAULT_CELL_STYLE, ResolvedStyle, StyleRegistry, ValueKind};
use crate::xlsx_package::escape_xml;
use crate::{
    CellRange, CellRecord, CellStyle, CellValue, CommentInfo, FilterColumnCriteria, MergedRange,
    RangeResult, RichRun, RowProperty, SheetMetadata, SidecarError, VisualObject,
    WorkbookMetadata, WorkbookSessions,
};

/// Excel's grid limits, the same ones the reader enforces.
const MAX_ROWS: usize = 1_048_576;
const MAX_COLUMNS: usize = 16_384;
/// Cells `read_range` will hand over in one answer.
const READ_WINDOW_CELLS: usize = 100_000;
/// Above this many cells the box is narrowed to the extent that actually holds
/// values. A sheet whose formatting reaches the last row must not make the
/// export read and write a million empty cells.
const MAX_EXPORT_CELLS: usize = 2_000_000;
/// How long the export waits for the sheet index to finish, so the sheet-wide
/// parts (conditional rules, validations, page setup) are the real ones.
const INDEX_WAIT: Duration = Duration::from_secs(60);
/// The pause between two waits. `read_range` itself blocks up to `RANGE_WAIT`
/// for the index, so a short sleep here only makes sure a finished index is not
/// kept re-taking the session lock the moment it releases it.
const INDEX_WAIT_BACKOFF: Duration = Duration::from_millis(50);
/// ODF nests outline groups; Excel stops at eight levels.
const MAX_OUTLINE_LEVEL: u8 = 8;

const MIMETYPE: &str = "application/vnd.oasis.opendocument.spreadsheet";
/// Fit-to-page per axis, first-page headers, tab colours and optional decimals
/// are ODF 1.3 spellings, so that is the version the package declares.
const ODF_VERSION: &str = "1.3";

const NAMESPACES: &str = concat!(
    r#"xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" "#,
    r#"xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" "#,
    r#"xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" "#,
    r#"xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" "#,
    r#"xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" "#,
    r#"xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" "#,
    r#"xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" "#,
    r#"xmlns:of="urn:oasis:names:tc:opendocument:xmlns:of:1.2" "#,
    r#"xmlns:xlink="http://www.w3.org/1999/xlink" "#,
    r#"xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" "#,
    r#"xmlns:dc="http://purl.org/dc/elements/1.1/" "#,
    // Conditional formats have no element in the standard; this is the
    // extension namespace the readers of the format share for them.
    r#"xmlns:calcext="urn:org:documentfoundation:names:experimental:calc:xmlns:calcext:1.0" "#,
    // The stops of a gradient with more than two colours, and the compact
    // layout of a pivot table.
    r#"xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0" "#,
    // The caption a pivot table field was given.
    r#"xmlns:tableooo="http://openoffice.org/2009/table" "#,
);

/// What the export did, in the shape the protocol returns it. `dropped` counts
/// the features the caller has to warn about before saving.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OdsExportResult {
    pub sheets: usize,
    pub cells: usize,
    #[serde(rename = "formulasDropped")]
    pub formulas_dropped: u32,
    pub dropped: DroppedFeatures,
}

/// Features an ODS package written here does not carry (decision 0119).
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedFeatures {
    pub charts: u32,
    pub images: u32,
    pub conditional_formats: u32,
    pub validations: u32,
    pub pivots: u32,
    /// Notes the writer could not place (a note outside the exported box).
    pub comments: u32,
    /// 1 when the workbook carries a VBA project, which stays behind whole.
    pub macros: u32,
    /// Drawn shapes, text boxes and embedded objects.
    pub shapes: u32,
    pub slicers: u32,
    pub sparklines: u32,
}

/// Converts the workbook at `source` into a new ODS package at `target`.
pub fn convert_to_ods(source: &Path, target: &Path) -> Result<OdsExportResult, SidecarError> {
    reject_same_target(source, target)?;
    let macros = has_macros(source);
    let mut sessions = WorkbookSessions::new();
    let metadata = sessions.open(source)?;
    let session_id = metadata.session_id.clone();
    let result = write_document(&mut sessions, &metadata, target, macros);
    // A close failure only means the temporary index directory survived; the
    // converted file is already in place, so it must not turn into an error.
    let _ = sessions.close(&session_id);
    result
}

fn reject_same_target(source: &Path, target: &Path) -> Result<(), SidecarError> {
    if target.as_os_str().is_empty() {
        return Err(SidecarError::InvalidRequest(
            "The ODS target path is empty.".into(),
        ));
    }
    if let (Ok(source), Ok(target)) = (fs::canonicalize(source), fs::canonicalize(target)) {
        if source == target {
            return Err(SidecarError::InvalidRequest(
                "The ODS target must differ from the source workbook.".into(),
            ));
        }
    }
    Ok(())
}

/// The drawings of one sheet as shape elements, keyed by the cell each one
/// starts in. A drawing that is written leaves the count of losses.
fn sheet_frames(
    sessions: &mut WorkbookSessions,
    metadata: &WorkbookMetadata,
    sheet: &SheetMetadata,
    package: Option<&Path>,
    drawings: &mut Drawings,
    counters: &mut Counters,
) -> Result<HashMap<(usize, usize), String>, SidecarError> {
    let mut frames: HashMap<(usize, usize), String> = HashMap::new();
    let visuals: Vec<&VisualObject> = metadata
        .visuals
        .iter()
        .filter(|visual| visual.sheet_id == sheet.id)
        .collect();
    if visuals.is_empty() && sheet.cell_images.is_empty() {
        return Ok(frames);
    }
    // The heights of the rows the drawings span decide their size.
    let first = visuals
        .iter()
        .map(|visual| visual.anchor.from_row)
        .chain(sheet.cell_images.iter().map(|image| image.row))
        .min()
        .unwrap_or(0);
    let last = visuals
        .iter()
        .map(|visual| visual.anchor.to_row.max(visual.anchor.from_row))
        .chain(sheet.cell_images.iter().map(|image| image.row))
        .max()
        .unwrap_or(0);
    let geometry = Geometry::new(
        sheet,
        row_heights(sessions, &metadata.session_id, sheet, first, last)?,
    );
    let palette = accent_palette(metadata.theme_colors.as_deref());
    for visual in visuals {
        let cell = (
            visual.anchor.from_row.min(MAX_ROWS - 1),
            visual.anchor.from_column.min(MAX_COLUMNS - 1),
        );
        let (frame, lost) = match visual.kind.as_str() {
            "image" => (
                drawings.image(sheet, &geometry, visual),
                &mut counters.dropped.images,
            ),
            "shape" => (
                drawings.shape(sheet, &geometry, visual),
                &mut counters.dropped.shapes,
            ),
            "chart" => (
                visual.chart.as_ref().and_then(|chart| {
                    // The model keeps the cell a series is named after only
                    // when the chart saved no copy of the name, and gives a
                    // series without a name the one Excel shows for it. The
                    // cell is what keeps a name live, and a name nobody gave
                    // is not one to write, so both are read from the part.
                    let named = package
                        .zip(visual.chart_path.as_deref())
                        .and_then(|(package, part)| series_names(package, part))
                        .filter(|names| names.len() == chart.series.len())
                        .map(|names| {
                            let mut chart = chart.clone();
                            for (series, name) in chart.series.iter_mut().zip(names) {
                                match name {
                                    SeriesName::Cell(cell) if series.name_ref.is_none() => {
                                        series.name_ref = Some(cell);
                                    }
                                    SeriesName::Absent => series.name.clear(),
                                    _ => {}
                                }
                            }
                            chart
                        });
                    let chart = named.as_ref().unwrap_or(chart);
                    drawings.chart(sheet, &geometry, visual, |width, height| {
                        chart_document(chart, &palette, width, height)
                    })
                }),
                &mut counters.dropped.charts,
            ),
            _ => continue,
        };
        if let Some(frame) = frame {
            frames.entry(cell).or_default().push_str(&frame);
            *lost = lost.saturating_sub(1);
        }
    }
    for image in &sheet.cell_images {
        if let Some(frame) = drawings.cell_image(&geometry, image.row, image.column, &image.media_path)
        {
            frames
                .entry((image.row, image.column))
                .or_default()
                .push_str(&frame);
            counters.dropped.images = counters.dropped.images.saturating_sub(1);
        }
    }
    Ok(frames)
}

/// A chart part is a few kilobytes; one past this is not read for names.
const MAX_CHART_PART_BYTES: u64 = 16 * 1024 * 1024;

/// Where a series of a chart part has its name from.
#[derive(Debug, PartialEq)]
enum SeriesName {
    /// The formula of the cell it is named after.
    Cell(String),
    /// Typed into the chart.
    Typed,
    /// The series has no name.
    Absent,
}

/// How each series of a chart part is named, in the order the series appear.
fn series_names(package: &Path, part: &str) -> Option<Vec<SeriesName>> {
    use std::io::Read;
    let mut archive = ZipArchive::new(File::open(package).ok()?).ok()?;
    let entry = archive.by_name(part.trim_start_matches('/')).ok()?;
    if entry.size() > MAX_CHART_PART_BYTES {
        return None;
    }
    let mut text = String::new();
    entry
        .take(MAX_CHART_PART_BYTES)
        .read_to_string(&mut text)
        .ok()?;
    let document = roxmltree::Document::parse(&text).ok()?;
    let child = |node: roxmltree::Node<'_, '_>, name: &str| {
        node.children()
            .find(|child| child.is_element() && child.tag_name().name() == name)
            .map(|child| child.id())
    };
    Some(
        document
            .descendants()
            .filter(|node| node.is_element() && node.tag_name().name() == "ser")
            .map(|series| {
                let Some(tx) = child(series, "tx").and_then(|id| document.get_node(id)) else {
                    return SeriesName::Absent;
                };
                child(tx, "strRef")
                    .and_then(|id| document.get_node(id))
                    .and_then(|reference| child(reference, "f"))
                    .and_then(|id| document.get_node(id))
                    .and_then(|formula| formula.text())
                    .map(str::trim)
                    .filter(|formula| !formula.is_empty())
                    .map_or(SeriesName::Typed, |formula| {
                        SeriesName::Cell(formula.to_owned())
                    })
            })
            .collect(),
    )
}

/// The rows from `first` to `last` whose height is not the default one: their
/// height in points, zero when hidden.
fn row_heights(
    sessions: &mut WorkbookSessions,
    session_id: &str,
    sheet: &SheetMetadata,
    first: usize,
    last: usize,
) -> Result<HashMap<usize, f64>, SidecarError> {
    let mut heights = HashMap::new();
    if sheet.row_count == 0 || sheet.column_count == 0 {
        return Ok(heights);
    }
    let last = last.min(sheet.row_count - 1);
    let mut start = first;
    while start <= last {
        let end = (start + READ_WINDOW_CELLS - 1).min(last);
        let range = CellRange {
            start_row: start,
            end_row: end,
            start_column: 0,
            end_column: 0,
        };
        for row in sessions.read_range(session_id, &sheet.id, &range)?.rows {
            if row.hidden {
                heights.insert(row.row, 0.0);
            } else if let Some(height) = row.height.filter(|height| *height > 0.0) {
                heights.insert(row.row, height);
            }
        }
        start = end + 1;
    }
    Ok(heights)
}

/// The package and the worksheet part behind a sheet, for the few settings
/// the model does not carry.
fn worksheet_part(
    sessions: &WorkbookSessions,
    session_id: &str,
    index: usize,
) -> Option<(PathBuf, String)> {
    let session = sessions.sessions.get(session_id)?;
    let runtime = session.runtimes.get(index)?;
    Some((session.path.clone(), runtime.worksheet_path.clone()))
}

/// True when the package holds a VBA project. Macros have no ODF counterpart,
/// and a macro-enabled workbook that quietly loses them is the kind of loss
/// the caller has to be able to name.
fn has_macros(source: &Path) -> bool {
    File::open(source)
        .ok()
        .and_then(|file| ZipArchive::new(file).ok())
        .is_some_and(|mut archive| archive.by_name("xl/vbaProject.bin").is_ok())
}

fn write_document(
    sessions: &mut WorkbookSessions,
    metadata: &WorkbookMetadata,
    target: &Path,
    macros: bool,
) -> Result<OdsExportResult, SidecarError> {
    let mut staging = StagingFiles::new(target);
    let base = metadata.styles.first().cloned().unwrap_or_default();
    let mut registry = StyleRegistry::new(base.clone());
    // A font that follows the theme is the Latin face of the theme in the
    // model. The workbook cached the name it was made with for its body font;
    // where it did not, the theme may still name a face for East Asian text.
    let differs = |family: &String| !family.is_empty() && base.font_family.as_ref() != Some(family);
    registry.set_theme_fonts(
        metadata
            .normal_font_name
            .clone()
            .filter(|_| base.font_scheme.as_deref() == Some("minor"))
            .filter(differs),
        metadata
            .theme_fonts
            .as_ref()
            .and_then(|fonts| fonts.minor_ea.clone())
            .filter(differs),
    );
    let mut pages = PageStyles::default();
    let mut table_styles: Vec<String> = Vec::new();
    let mut counters = Counters::new(metadata, macros);
    let (named, names) = exported_names(metadata);
    let mut database_ranges = String::new();
    let mut validations = Validations::default();
    let mut drawings = Drawings::default();
    let mut data_pilots = String::new();
    let package = sessions
        .sessions
        .get(&metadata.session_id)
        .map(|session| session.path.clone());
    // The names a pivot table may read from are looked up once, and only for
    // a workbook that has a pivot table.
    let pivot_sources: NamedSources = match package.as_deref() {
        Some(package) if metadata.sheets.iter().any(|sheet| !sheet.pivot_tables.is_empty()) => {
            let parts: Vec<(String, String)> = metadata
                .sheets
                .iter()
                .enumerate()
                .filter_map(|(index, sheet)| {
                    worksheet_part(sessions, &metadata.session_id, index)
                        .map(|(_, part)| (sheet.name.clone(), part))
                })
                .collect();
            named_sources(package, &parts, &metadata.defined_names)
        }
        _ => NamedSources::new(),
    };

    let body_path = staging.path("body");
    {
        let mut body = BufWriter::new(File::create(&body_path)?);
        for (index, sheet) in metadata.sheets.iter().enumerate() {
            let wide = read_sheet_wide(sessions, &metadata.session_id, sheet)?;
            // What the model does not carry is read from the worksheet part
            // itself, once for the print settings and the rules.
            let tail = worksheet_part(sessions, &metadata.session_id, index)
                .and_then(|(package, part)| worksheet_tail(&package, &part));
            let extras = tail.as_deref().map(parse_print_extras).unwrap_or_default();
            let rule_extras = tail.as_deref().map(parse_rule_extras).unwrap_or_default();
            let sparkline_extras = tail.as_deref().map(parse_sparkline_extras).unwrap_or_default();
            drop(tail);
            let (areas, lost) = validations.register(&sheet.name, &wide.data_validations, &names);
            counters.dropped.validations += lost;
            let (conditional_formats, lost) = conditional_formats_xml(
                &sheet.name,
                &wide.conditional_rules,
                &metadata.dxf_styles,
                &rule_extras,
                &names,
                &mut registry,
            );
            counters.dropped.conditional_formats += lost;
            let frames = sheet_frames(
                sessions,
                metadata,
                sheet,
                package.as_deref(),
                &mut drawings,
                &mut counters,
            )?;
            let (sparklines, written) = sparkline_groups_xml(index, sheet, &sparkline_extras);
            counters.dropped.sparklines = counters.dropped.sparklines.saturating_sub(written);
            for pivot in &sheet.pivot_tables {
                // A pivot table that is written leaves the count of losses.
                if let Some(xml) = package
                    .as_deref()
                    .and_then(|package| {
                        pivot_table_xml(package, &sheet.name, pivot, &pivot_sources)
                    })
                {
                    data_pilots.push_str(&xml);
                    counters.dropped.pivots = counters.dropped.pivots.saturating_sub(1);
                }
            }
            let master = pages.register(wide.page_setup.as_ref(), extras, &mut registry);
            let table_style = format!("ta{}", index + 1);
            table_styles.push(table_style_xml(&table_style, sheet, &master));
            let filter = sheet_filter(index, sheet, &wide);
            database_ranges.push_str(&filter.xml);
            let local_names: String = named
                .iter()
                .filter(|name| name.sheet_index == Some(index))
                .map(|name| name.xml.as_str())
                .collect();
            let context = SheetContext {
                sheet,
                table_style: &table_style,
                styles: &metadata.styles,
                base: &base,
                date1904: metadata.date1904,
                names: &names,
                wide: &wide,
                filtered_rows: filter.filtered_rows,
                local_names: &local_names,
                validations: &areas,
                conditional_formats: &conditional_formats,
                sparklines: &sparklines,
                frames: &frames,
            };
            write_table(
                sessions,
                &metadata.session_id,
                &context,
                &mut body,
                &mut registry,
                &mut counters,
            )?;
        }
        let global_names: String = named
            .iter()
            .filter(|name| name.sheet_index.is_none())
            .map(|name| name.xml.as_str())
            .collect();
        if !global_names.is_empty() {
            write!(
                body,
                "<table:named-expressions>{global_names}</table:named-expressions>"
            )?;
        }
        if !database_ranges.is_empty() {
            write!(
                body,
                "<table:database-ranges>{database_ranges}</table:database-ranges>"
            )?;
        }
        if !data_pilots.is_empty() {
            write!(
                body,
                "<table:data-pilot-tables>{data_pilots}</table:data-pilot-tables>"
            )?;
        }
        body.flush()?;
    }

    let content_path = staging.path("content");
    write_content_xml(
        &content_path,
        &registry,
        &table_styles,
        &validations.xml,
        &drawings.automatic_styles(),
        &body_path,
        metadata,
    )?;
    let styles_path = staging.path("styles");
    fs::write(
        &styles_path,
        styles_xml(&registry, &pages, &drawings.named_styles()),
    )?;
    let meta_path = staging.path("meta");
    fs::write(&meta_path, meta_xml())?;
    let settings_path = staging.path("settings");
    fs::write(&settings_path, settings_xml(metadata))?;

    let archive_path = staging.path("archive");
    write_archive(
        &archive_path,
        &content_path,
        &styles_path,
        &meta_path,
        &settings_path,
        package.as_deref(),
        &drawings.pictures,
        &drawings.objects,
    )?;
    promote(&archive_path, target)?;
    staging.forget(&archive_path);

    counters.sheets = metadata.sheets.len();
    Ok(counters.finish())
}

/// The `content.xml` header, automatic styles, and the body streamed out of
/// the table-writing pass.
fn write_content_xml(
    path: &Path,
    registry: &StyleRegistry,
    table_styles: &[String],
    validations: &str,
    graphic_styles: &str,
    body_path: &Path,
    metadata: &WorkbookMetadata,
) -> Result<(), SidecarError> {
    let file = File::create(path)?;
    let mut out = BufWriter::new(file);
    let mut header = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><office:document-content {NAMESPACES}office:version="{ODF_VERSION}">"#
    );
    header.push_str("<office:font-face-decls>");
    header.push_str(&registry.font_face_decls());
    header.push_str("</office:font-face-decls><office:automatic-styles>");
    header.push_str(&registry.automatic_styles());
    for style in table_styles {
        header.push_str(style);
    }
    header.push_str(graphic_styles);
    header.push_str("</office:automatic-styles><office:body><office:spreadsheet>");
    // Excel compares text without case and reads `*` and `?` in a criterion as
    // wildcards. ODF's defaults are the opposite on both counts, so a document
    // that leaves them unsaid recalculates `="a"="A"` and `COUNTIF(A:A,"a*")`
    // to different answers.
    header.push_str(
        r#"<table:calculation-settings table:case-sensitive="false" table:automatic-find-labels="false" table:use-regular-expressions="false" table:use-wildcards="true""#,
    );
    if metadata.date1904 {
        // The null date tells a reader how to read every numeric date it will
        // meet; without it the 1904 workbook's serials would land four years
        // and a day off.
        header.push_str(r#"><table:null-date table:date-value="1904-01-01"/></table:calculation-settings>"#);
    } else {
        header.push_str("/>");
    }
    if !validations.is_empty() {
        header.push_str(&format!(
            "<table:content-validations>{validations}</table:content-validations>"
        ));
    }
    out.write_all(header.as_bytes())?;
    let mut body = File::open(body_path)?;
    io::copy(&mut body, &mut out)?;
    out.write_all(b"</office:spreadsheet></office:body></office:document-content>")?;
    out.flush()?;
    Ok(())
}

/// The sparklines of a sheet as the extension element the readers of the
/// format share for them, and how many cells it covers. The model carries the
/// kind, the series colour and where each one reads from; the options that
/// are switched on, the line's weight and the other colours come from the
/// worksheet part (`extras`, one per group, used only when they pair up with
/// the model's groups). A sparkline whose range cannot be named is left out.
fn sparkline_groups_xml(
    sheet_index: usize,
    sheet: &SheetMetadata,
    extras: &[SparklineExtra],
) -> (String, u32) {
    let mut groups = String::new();
    let mut written = 0;
    let paired = extras.len() == sheet.sparklines.len();
    for (group_index, group) in sheet.sparklines.iter().enumerate() {
        let extra = extras.get(group_index).filter(|_| paired);
        let mut cells = String::new();
        let mut count = 0;
        for cell in &group.cells {
            let host = cell.cell.replace('$', "");
            let source = cell.source_ref.trim();
            let range = crate::ods_chart::chart_range(source).or_else(|| {
                // A range on the sparkline's own sheet may come without it.
                let quoted = format!("'{}'!{source}", sheet.name.replace('\'', "''"));
                crate::ods_chart::chart_range(&quoted)
            });
            let Some(range) = range.filter(|_| !host.is_empty()) else {
                continue;
            };
            cells.push_str(&format!(
                r#"<calcext:sparkline calcext:cell-address="{}.{}" calcext:data-range="{}"/>"#,
                escape_xml(&odf_formula::odf_sheet_name(&sheet.name)),
                escape_xml(&host),
                escape_xml(&range)
            ));
            count += 1;
        }
        if count == 0 {
            continue;
        }
        let kind = match group.kind.as_str() {
            "column" => "column",
            "stacked" => "stacked",
            _ => "line",
        };
        let hex = |color: &str| {
            let color = color.trim().trim_start_matches('#');
            let color = if color.len() == 8 { &color[2..] } else { color };
            format!("#{}", color.to_ascii_lowercase())
        };
        let empty_cells = match extra.and_then(|extra| extra.empty_cells.as_deref()) {
            Some("zero") => "zero",
            Some("span") => "span",
            _ => "gap",
        };
        let mut attributes = format!(
            r#" calcext:id="{{00000000-0000-0000-{:04x}-{:012x}}}" calcext:type="{kind}" calcext:line-width="{}pt" calcext:display-empty-cells-as="{empty_cells}""#,
            sheet_index & 0xffff,
            group_index,
            extra.and_then(|extra| extra.line_weight).unwrap_or(0.75),
        );
        match extra {
            Some(extra) => {
                for flag in &extra.flags {
                    attributes.push_str(&format!(r#" calcext:{flag}="true""#));
                }
            }
            // Without the part to ask, a colour for negative points is the
            // only sign that they are picked out.
            None if group.negative_color.is_some() => {
                attributes.push_str(r#" calcext:negative="true""#);
            }
            None => {}
        }
        attributes.push_str(r#" calcext:min-axis-type="individual" calcext:max-axis-type="individual""#);
        // The series colour and the colour of negative points come resolved
        // from the model; Excel's own stand in where neither says.
        let stated = |slot: &str| {
            extra.and_then(|extra| {
                extra
                    .colors
                    .iter()
                    .find(|(name, _)| *name == slot)
                    .map(|(_, color)| color.as_str())
            })
        };
        attributes.push_str(&format!(
            r#" calcext:color-series="{}" calcext:color-negative="{}""#,
            escape_xml(&hex(group.color.as_deref().or(stated("color-series")).unwrap_or("#376092"))),
            escape_xml(&hex(
                group
                    .negative_color
                    .as_deref()
                    .or(stated("color-negative"))
                    .unwrap_or("#d00000")
            )),
        ));
        // Every colour is written, as a reader of the format writes them:
        // one left out would come back as whatever the next writer assumes.
        for (slot, default) in [
            ("color-axis", "#000000"),
            ("color-markers", "#d00000"),
            ("color-first", "#d00000"),
            ("color-last", "#d00000"),
            ("color-high", "#d00000"),
            ("color-low", "#d00000"),
        ] {
            attributes.push_str(&format!(
                r#" calcext:{slot}="{}""#,
                escape_xml(&hex(stated(slot).unwrap_or(default)))
            ));
        }
        groups.push_str(&format!(
            "<calcext:sparkline-group{attributes}><calcext:sparklines>{cells}</calcext:sparklines></calcext:sparkline-group>"
        ));
        written += count;
    }
    if groups.is_empty() {
        return (String::new(), 0);
    }
    (
        format!("<calcext:sparkline-groups>{groups}</calcext:sparkline-groups>"),
        written,
    )
}

fn styles_xml(registry: &StyleRegistry, pages: &PageStyles, drawing_styles: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><office:document-styles {NAMESPACES}office:version="{ODF_VERSION}"><office:font-face-decls>{}</office:font-face-decls><office:styles>{}{drawing_styles}{}</office:styles><office:automatic-styles>{}{}</office:automatic-styles><office:master-styles>{}</office:master-styles></office:document-styles>"#,
        registry.font_face_decls(),
        registry.default_cell_style(),
        registry.conditional_styles(),
        pages.layouts,
        pages.text_styles,
        pages.masters,
    )
}

fn meta_xml() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" office:version="{ODF_VERSION}"><office:meta><meta:generator>GenOffice</meta:generator></office:meta></office:document-meta>"#
    )
}

fn config_item(name: &str, kind: &str, value: impl std::fmt::Display) -> String {
    format!(
        r#"<config:config-item config:name="{name}" config:type="{kind}">{value}</config:config-item>"#
    )
}

/// `settings.xml` carries what ODF keeps outside the document body: the sheet
/// the reader should show first, and each sheet's frozen rows and columns,
/// grid and zoom.
fn settings_xml(metadata: &WorkbookMetadata) -> String {
    let mut tables = String::new();
    for sheet in &metadata.sheets {
        let mut items = String::new();
        let (columns, rows) = sheet
            .freeze
            .map(|freeze| (freeze.frozen_columns, freeze.frozen_rows))
            .unwrap_or((0, 0));
        if columns > 0 || rows > 0 {
            // Split mode 2 is "frozen". The pane positions say where each
            // pane starts scrolling: without them the lower right pane would
            // begin at A1 again and show the frozen cells twice.
            items.push_str(&config_item("HorizontalSplitMode", "short", if columns > 0 { 2 } else { 0 }));
            items.push_str(&config_item("VerticalSplitMode", "short", if rows > 0 { 2 } else { 0 }));
            items.push_str(&config_item("HorizontalSplitPosition", "int", columns));
            items.push_str(&config_item("VerticalSplitPosition", "int", rows));
            let active = match (columns > 0, rows > 0) {
                (true, true) => 3,
                (true, false) => 1,
                _ => 2,
            };
            items.push_str(&config_item("ActiveSplitRange", "short", active));
            items.push_str(&config_item("PositionLeft", "int", 0));
            items.push_str(&config_item("PositionRight", "int", columns));
            items.push_str(&config_item("PositionTop", "int", 0));
            items.push_str(&config_item("PositionBottom", "int", rows));
        }
        if let Some(zoom) = sheet.zoom_scale {
            items.push_str(&config_item("ZoomType", "short", 0));
            items.push_str(&config_item("ZoomValue", "int", zoom));
        }
        if !sheet.show_grid_lines {
            items.push_str(&config_item("ShowGrid", "boolean", "false"));
        }
        if items.is_empty() {
            continue;
        }
        tables.push_str(&format!(
            r#"<config:config-item-map-entry config:name="{}">{items}</config:config-item-map-entry>"#,
            escape_xml(&sheet.name),
        ));
    }
    let table_map = if tables.is_empty() {
        String::new()
    } else {
        format!(
            r#"<config:config-item-map-named config:name="Tables">{tables}</config:config-item-map-named>"#
        )
    };
    let active = escape_xml(&active_sheet_name(metadata));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><office:document-settings xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" office:version="{ODF_VERSION}"><office:settings><config:config-item-set config:name="ooo:view-settings"><config:config-item-map-indexed config:name="Views"><config:config-item-map-entry>{}{table_map}{}</config:config-item-map-entry></config:config-item-map-indexed></config:config-item-set></office:settings></office:document-settings>"#,
        config_item("ViewId", "string", "view1"),
        config_item("ActiveTable", "string", &active),
    )
}

/// The tab the workbook was on, unless that sheet is hidden — hiding is not a
/// reason for a reader to open on an invisible sheet.
fn active_sheet_name(metadata: &WorkbookMetadata) -> String {
    let active = metadata.sheets.get(metadata.active_tab);
    active
        .filter(|sheet| !sheet.hidden)
        .or_else(|| metadata.sheets.iter().find(|sheet| !sheet.hidden))
        .or_else(|| metadata.sheets.first())
        .map(|sheet| sheet.name.clone())
        .unwrap_or_default()
}

fn write_archive(
    path: &Path,
    content_path: &Path,
    styles_path: &Path,
    meta_path: &Path,
    settings_path: &Path,
    package: Option<&Path>,
    pictures: &[Picture],
    objects: &[EmbeddedObject],
) -> Result<(), SidecarError> {
    let file = File::create(path)?;
    let mut writer = ZipWriter::new(file);
    // The mimetype entry must come first and be stored, not deflated: that is
    // how a reader recognizes the package before unpacking it.
    writer.start_file(
        "mimetype",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )?;
    writer.write_all(MIMETYPE.as_bytes())?;
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    writer.start_file("META-INF/manifest.xml", options)?;
    writer.write_all(manifest_xml(pictures, objects).as_bytes())?;
    for (name, source) in [
        ("content.xml", content_path),
        ("styles.xml", styles_path),
        ("meta.xml", meta_path),
        ("settings.xml", settings_path),
    ] {
        writer.start_file(name, options)?;
        let mut part = File::open(source)?;
        io::copy(&mut part, &mut writer)?;
    }
    for object in objects {
        writer.start_file(format!("{}/content.xml", object.directory), options)?;
        writer.write_all(object.content.as_bytes())?;
    }
    if !pictures.is_empty() {
        // The pictures are copied out of the workbook as they are; the frames
        // that point at them are already written, so a picture that cannot
        // be read fails the export rather than leaving a broken link.
        let source = package.ok_or_else(|| {
            SidecarError::InvalidRequest("The workbook behind the export is gone.".into())
        })?;
        let mut archive = ZipArchive::new(File::open(source)?)?;
        for picture in pictures {
            let mut entry = archive.by_name(&picture.source)?;
            writer.start_file(picture.name.as_str(), options)?;
            io::copy(&mut entry, &mut writer)?;
        }
    }
    let finished = writer.finish()?;
    crate::archive::sync_best_effort(&finished)?;
    Ok(())
}

fn manifest_xml(pictures: &[Picture], objects: &[EmbeddedObject]) -> String {
    let mut pictures: String = pictures
        .iter()
        .map(|picture| {
            format!(
                r#"<manifest:file-entry manifest:full-path="{}" manifest:media-type="{}"/>"#,
                escape_xml(&picture.name),
                escape_xml(&picture.media_type)
            )
        })
        .collect();
    for object in objects {
        let directory = escape_xml(&object.directory);
        pictures.push_str(&format!(
            r#"<manifest:file-entry manifest:full-path="{directory}/" manifest:media-type="application/vnd.oasis.opendocument.chart"/><manifest:file-entry manifest:full-path="{directory}/content.xml" manifest:media-type="text/xml"/>"#
        ));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="{ODF_VERSION}"><manifest:file-entry manifest:full-path="/" manifest:version="{ODF_VERSION}" manifest:media-type="{MIMETYPE}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/><manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="text/xml"/>{pictures}</manifest:manifest>"#
    )
}

/// Replaces `target` with the finished archive. Windows will not rename onto
/// an existing file, so an existing target is removed first — the new file is
/// complete by then, which is what keeps a failed export from leaving a
/// half-written document behind.
fn promote(staged: &Path, target: &Path) -> Result<(), SidecarError> {
    match fs::rename(staged, target) {
        Ok(()) => Ok(()),
        Err(_) if target.exists() => {
            fs::remove_file(target)?;
            fs::rename(staged, target)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

/// Temp files beside the target, reclaimed however the export ends.
struct StagingFiles {
    directory: PathBuf,
    stem: String,
    id: String,
    paths: Vec<PathBuf>,
}

impl StagingFiles {
    fn new(target: &Path) -> Self {
        let directory = target.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
        let stem = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("export.ods")
            .to_owned();
        Self {
            directory,
            stem,
            id: Uuid::new_v4().to_string(),
            paths: Vec::new(),
        }
    }

    fn path(&mut self, kind: &str) -> PathBuf {
        let path = self
            .directory
            .join(format!(".{}.{}.{kind}.tmp", self.stem, self.id));
        self.paths.push(path.clone());
        path
    }

    fn forget(&mut self, path: &Path) {
        self.paths.retain(|candidate| candidate != path);
    }
}

impl Drop for StagingFiles {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = fs::remove_file(path);
        }
    }
}

/// What the export saw and did not carry. The drawing kinds come from the
/// workbook's visuals, the rest from each sheet's metadata and range results.
#[derive(Default)]
struct Counters {
    sheets: usize,
    cells: usize,
    formulas_dropped: u32,
    dropped: DroppedFeatures,
}

impl Counters {
    fn new(metadata: &WorkbookMetadata, macros: bool) -> Self {
        let mut dropped = DroppedFeatures {
            macros: u32::from(macros),
            ..DroppedFeatures::default()
        };
        for visual in &metadata.visuals {
            match visual.kind.as_str() {
                "chart" => dropped.charts += 1,
                "image" => dropped.images += 1,
                "slicer" => dropped.slicers += 1,
                "shape" | "ole" => dropped.shapes += 1,
                _ => {}
            }
        }
        for sheet in &metadata.sheets {
            dropped.images += sheet.cell_images.len() as u32;
            dropped.pivots += sheet.pivot_tables.len() as u32;
            // Every note counts as lost until the writer places it.
            dropped.comments += sheet.comments.len() as u32;
            dropped.sparklines += sheet
                .sparklines
                .iter()
                .map(|group| group.cells.len() as u32)
                .sum::<u32>();
        }
        Self {
            sheets: 0,
            cells: 0,
            formulas_dropped: 0,
            dropped,
        }
    }

    fn finish(self) -> OdsExportResult {
        OdsExportResult {
            sheets: self.sheets,
            cells: self.cells,
            formulas_dropped: self.formulas_dropped,
            dropped: self.dropped,
        }
    }
}

/// A sheet-wide read, once the index behind it has finished. The rules,
/// validations and page setup are only complete at that point; an export that
/// read them early would silently drop them.
fn read_sheet_wide(
    sessions: &mut WorkbookSessions,
    session_id: &str,
    sheet: &SheetMetadata,
) -> Result<RangeResult, SidecarError> {
    let probe = CellRange {
        start_row: 0,
        end_row: 0,
        start_column: 0,
        end_column: 0,
    };
    let deadline = Instant::now() + INDEX_WAIT;
    loop {
        let result = sessions.read_range(session_id, &sheet.id, &probe)?;
        if result.indexing_complete || Instant::now() >= deadline {
            return Ok(result);
        }
        std::thread::sleep(INDEX_WAIT_BACKOFF);
    }
}

// ---------------------------------------------------------------------------
// Names, filters and addresses
// ---------------------------------------------------------------------------

/// A defined name the export writes, already as its ODF element.
struct ExportedName {
    sheet_index: Option<usize>,
    xml: String,
}

/// The workbook's defined names as ODF named ranges and expressions, plus the
/// set a cell formula may mention. A name whose definition cannot be written
/// is left out of both, so a formula that uses it keeps its value only.
fn exported_names(metadata: &WorkbookMetadata) -> (Vec<ExportedName>, Names) {
    let base_sheet = |index: Option<usize>| {
        index
            .and_then(|index| metadata.sheets.get(index))
            .or_else(|| metadata.sheets.first())
            .map(|sheet| format!("${}.$A$1", odf_formula::odf_sheet_name(&sheet.name)))
            .unwrap_or_default()
    };
    let candidates: Vec<_> = metadata
        .defined_names
        .iter()
        .filter(|name| is_portable_name(&name.name))
        .collect();
    let mut names = Names::default();
    let mut written: Vec<Option<ExportedName>> = candidates.iter().map(|_| None).collect();
    // Ranges first: they depend on nothing. Expressions may mention other
    // names, so they are retried until a pass adds none.
    for (slot, name) in written.iter_mut().zip(&candidates) {
        if let Some(address) = odf_formula::odf_range_address(&name.formula) {
            *slot = Some(ExportedName {
                sheet_index: name.sheet_index,
                xml: format!(
                    r#"<table:named-range table:name="{}" table:base-cell-address="{}" table:cell-range-address="{}"/>"#,
                    escape_xml(&name.name),
                    escape_xml(&base_sheet(name.sheet_index)),
                    escape_xml(&address),
                ),
            });
            names.insert(&name.name);
        }
    }
    loop {
        let mut added = false;
        for (slot, name) in written.iter_mut().zip(&candidates) {
            if slot.is_some() {
                continue;
            }
            let Some(expression) = odf_formula::odf_named_expression(&name.formula, &names) else {
                continue;
            };
            *slot = Some(ExportedName {
                sheet_index: name.sheet_index,
                xml: format!(
                    r#"<table:named-expression table:name="{}" table:base-cell-address="{}" table:expression="{}"/>"#,
                    escape_xml(&name.name),
                    escape_xml(&base_sheet(name.sheet_index)),
                    escape_xml(&expression),
                ),
            });
            names.insert(&name.name);
            added = true;
        }
        if !added {
            break;
        }
    }
    (written.into_iter().flatten().collect(), names)
}

/// A name both formats accept as written: letters, digits and underscores,
/// not starting with a digit. Excel's built-ins (`_xlnm.Print_Area`) and names
/// with a dot or a backslash stay behind — the print ranges travel as table
/// attributes instead.
fn is_portable_name(name: &str) -> bool {
    let mut characters = name.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (first.is_alphabetic() || first == '_')
        && !name.starts_with("_xl")
        && characters.all(|character| character.is_alphanumeric() || character == '_')
        // `A1` or `R1C1` would read as a cell, not a name.
        && odf_formula::odf_named_expression(name, &Names::default()).is_none()
}

/// `$Sheet.$A$1:.$B$8` for a range on a sheet.
fn absolute_range(sheet_name: &str, range: &MergedRange) -> String {
    format!(
        "${}.${}${}:.${}${}",
        odf_formula::odf_sheet_name(sheet_name),
        column_name(range.start_column),
        range.start_row + 1,
        column_name(range.end_column),
        range.end_row + 1,
    )
}

fn column_name(index: usize) -> String {
    let mut name = String::new();
    let mut number = index + 1;
    while number > 0 {
        let remainder = (number - 1) % 26;
        name.insert(0, (b'A' + remainder as u8) as char);
        number = (number - 1) / 26;
    }
    name
}

/// `A1:B2` or `A1` as a 0-based range.
fn parse_range(reference: &str) -> Option<MergedRange> {
    let reference = reference.replace('$', "");
    let (first, second) = match reference.split_once(':') {
        Some((first, second)) => (first, second),
        None => (reference.as_str(), reference.as_str()),
    };
    let (start_row, start_column) = parse_cell(first)?;
    let (end_row, end_column) = parse_cell(second)?;
    (end_row >= start_row && end_column >= start_column).then_some(MergedRange {
        start_row,
        start_column,
        end_row,
        end_column,
    })
}

fn parse_cell(reference: &str) -> Option<(usize, usize)> {
    let letters = reference
        .find(|character: char| !character.is_ascii_alphabetic())
        .unwrap_or(reference.len());
    let (column, row) = reference.split_at(letters);
    if column.is_empty() || column.len() > 3 || row.is_empty() {
        return None;
    }
    let column = column.chars().fold(0usize, |total, character| {
        total * 26 + (character.to_ascii_uppercase() as usize - 'A' as usize + 1)
    });
    let row: usize = row.parse().ok()?;
    (row >= 1 && row <= MAX_ROWS && column <= MAX_COLUMNS).then(|| (row - 1, column - 1))
}

/// A sheet's filter and tables as ODF database ranges.
struct SheetFilter {
    xml: String,
    /// Rows of the auto-filter range, when its criteria were written: a row
    /// hidden inside them is hidden *by the filter*, which ODF says apart from
    /// a row hidden by hand.
    filtered_rows: Option<(usize, usize)>,
}

fn sheet_filter(index: usize, sheet: &SheetMetadata, wide: &RangeResult) -> SheetFilter {
    let mut xml = String::new();
    let mut filtered_rows = None;
    if let Some(range) = &wide.auto_filter {
        let criteria = filter_xml(&wide.auto_filter_columns);
        filtered_rows = criteria
            .is_some()
            .then_some((range.start_row, range.end_row));
        // A sheet's own filter is an anonymous range; this is the name
        // readers look it up under.
        xml.push_str(&format!(
            r#"<table:database-range table:name="__Anonymous_Sheet_DB__{index}" table:target-range-address="{}" table:display-filter-buttons="true">{}</table:database-range>"#,
            escape_xml(&absolute_range(&sheet.name, range)),
            criteria.unwrap_or_default(),
        ));
    }
    let mut seen: HashSet<String> = HashSet::new();
    for table in &sheet.tables {
        let Some(name) = table.name.as_deref().filter(|name| is_portable_name(name)) else {
            continue;
        };
        if !seen.insert(name.to_uppercase()) {
            continue;
        }
        let header = table.header_row_count > 0;
        xml.push_str(&format!(
            r#"<table:database-range table:name="{}" table:target-range-address="{}" table:contains-header="{header}" table:display-filter-buttons="{header}"/>"#,
            escape_xml(name),
            escape_xml(&absolute_range(&sheet.name, &table.range)),
        ));
    }
    SheetFilter { xml, filtered_rows }
}

/// The live criteria of an auto-filter as `table:filter`. `None` when there
/// are none, or when one of them has no ODF spelling — then the range and its
/// buttons still travel and the rows stay hidden as plain hidden rows.
fn filter_xml(columns: &[FilterColumnCriteria]) -> Option<String> {
    if columns.is_empty() {
        return None;
    }
    let mut conditions = String::new();
    for column in columns {
        let field = column.col_id;
        if let Some(values) = &column.values {
            let mut items: Vec<&str> = values.iter().map(String::as_str).collect();
            if column.blank {
                items.push("");
            }
            let first = items.first()?;
            conditions.push_str(&format!(
                r#"<table:filter-condition table:field-number="{field}" table:operator="=" table:value="{}">"#,
                escape_xml(first)
            ));
            for item in &items {
                conditions.push_str(&format!(
                    r#"<table:filter-set-item table:value="{}"/>"#,
                    escape_xml(item)
                ));
            }
            conditions.push_str("</table:filter-condition>");
        } else if let Some(customs) = &column.customs {
            let mut parts = Vec::new();
            for item in &customs.filters {
                let operator = match item.operator.as_deref() {
                    None | Some("equal") => "=",
                    Some("notEqual") => "!=",
                    Some("greaterThan") => ">",
                    Some("greaterThanOrEqual") => ">=",
                    Some("lessThan") => "<",
                    Some("lessThanOrEqual") => "<=",
                    Some(_) => return None,
                };
                // Excel's `*` and `?` criteria would need a different
                // operator per pattern shape; none is guessed here.
                if item.val.contains('*') || item.val.contains('?') {
                    return None;
                }
                let numeric = item.val.trim().parse::<f64>().is_ok();
                parts.push(format!(
                    r#"<table:filter-condition table:field-number="{field}" table:operator="{}" table:value="{}"{}/>"#,
                    escape_xml(operator),
                    escape_xml(&item.val),
                    if numeric { r#" table:data-type="number""# } else { "" },
                ));
            }
            match parts.len() {
                0 => return None,
                1 => conditions.push_str(&parts[0]),
                _ if customs.and => conditions.push_str(&parts.concat()),
                _ => conditions.push_str(&format!(
                    "<table:filter-or>{}</table:filter-or>",
                    parts.concat()
                )),
            }
        } else if column.blank {
            conditions.push_str(&format!(
                r#"<table:filter-condition table:field-number="{field}" table:operator="empty" table:value=""/>"#
            ));
        } else {
            return None;
        }
    }
    Some(format!(
        "<table:filter><table:filter-and>{conditions}</table:filter-and></table:filter>"
    ))
}

/// The print area of a sheet (`Data!$A$1:$G$25`, or several joined by commas)
/// as the space-separated list `table:print-ranges` takes.
fn print_ranges(formula: Option<&str>) -> Option<String> {
    let formula = formula?;
    let mut ranges = Vec::new();
    for part in split_outside_quotes(formula, ',') {
        ranges.push(odf_formula::odf_range_address(part)?);
    }
    (!ranges.is_empty()).then(|| ranges.join(" "))
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/// The rows and columns the export walks: the sheet's used box, narrowed to
/// the value extent when the box is large enough that its empty formatting
/// would dominate the output.
fn export_box(sheet: &SheetMetadata) -> (usize, usize) {
    let mut rows = sheet.row_count.clamp(1, MAX_ROWS);
    let mut columns = sheet.column_count.clamp(1, MAX_COLUMNS);
    if rows.saturating_mul(columns) > MAX_EXPORT_CELLS {
        rows = sheet.value_row_count.unwrap_or(rows).clamp(1, rows);
        columns = sheet.value_column_count.unwrap_or(columns).clamp(1, columns);
    }
    (rows, columns)
}

/// The number of `<table:table-column>` entries: the box, widened to whatever
/// a sized column reaches so a width set past the data still travels.
fn axis_columns(sheet: &SheetMetadata, columns: usize) -> usize {
    let widest = sheet
        .column_widths
        .iter()
        .map(|span| span.end_column.saturating_add(1))
        .max()
        .unwrap_or(0);
    columns.max(widest).min(MAX_COLUMNS)
}

/// Everything about one sheet the row writer needs besides the cells.
struct SheetContext<'a> {
    sheet: &'a SheetMetadata,
    table_style: &'a str,
    styles: &'a [CellStyle],
    base: &'a CellStyle,
    date1904: bool,
    names: &'a Names,
    wide: &'a RangeResult,
    filtered_rows: Option<(usize, usize)>,
    local_names: &'a str,
    /// The ranges a validation covers, sorted by first row.
    validations: &'a [ValidationArea],
    /// The sheet's `calcext:sparkline-groups` element, ready to write.
    sparklines: &'a str,
    /// The sheet's `calcext:conditional-formats` element, ready to write.
    conditional_formats: &'a str,
    /// The drawings that start in a cell, as ready shape elements.
    frames: &'a HashMap<(usize, usize), String>,
}

/// One column of the axis, as far as its `table:table-column` is concerned.
#[derive(Clone, PartialEq)]
struct ColumnAxis {
    width: Option<f64>,
    hidden: bool,
    default_style: Option<String>,
    level: u8,
    break_before: bool,
    title: bool,
}

/// Outline groups and print-title wrappers around rows or columns. ODF nests
/// a group element per outline level and wraps repeated titles in a header
/// element; the header may not straddle a group boundary, so it is closed
/// before the depth changes and reopened after.
struct Nesting {
    group: &'static str,
    header: &'static str,
    depth: u8,
    in_header: bool,
}

impl Nesting {
    fn rows() -> Self {
        Self {
            group: "table:table-row-group",
            header: "table:table-header-rows",
            depth: 0,
            in_header: false,
        }
    }

    fn columns() -> Self {
        Self {
            group: "table:table-column-group",
            header: "table:table-header-columns",
            depth: 0,
            in_header: false,
        }
    }

    fn matches(&self, level: u8, header: bool) -> bool {
        self.depth == level && self.in_header == header
    }

    /// The tags that take the nesting to a member at `level` that is (or is
    /// not) a print title. `collapsed` marks a group that opens hidden.
    fn enter(&mut self, level: u8, header: bool, collapsed: bool) -> String {
        let mut out = String::new();
        if self.in_header && (!header || level != self.depth) {
            out.push_str(&format!("</{}>", self.header));
            self.in_header = false;
        }
        while self.depth > level {
            out.push_str(&format!("</{}>", self.group));
            self.depth -= 1;
        }
        while self.depth < level {
            out.push_str(&format!(
                "<{}{}>",
                self.group,
                if collapsed { r#" table:display="false""# } else { "" }
            ));
            self.depth += 1;
        }
        if header && !self.in_header {
            out.push_str(&format!("<{}>", self.header));
            self.in_header = true;
        }
        out
    }

    fn close(&mut self) -> String {
        self.enter(0, false, false)
    }
}

fn write_table(
    sessions: &mut WorkbookSessions,
    session_id: &str,
    context: &SheetContext<'_>,
    out: &mut impl Write,
    registry: &mut StyleRegistry,
    counters: &mut Counters,
) -> Result<(), SidecarError> {
    let sheet = context.sheet;
    let (rows, columns) = export_box(sheet);
    let axis = axis_columns(sheet, columns);
    let (title_rows, title_columns) = print_titles(sheet.print_titles.as_deref());

    let mut head = format!(
        r#"<table:table table:name="{}" table:style-name="{}""#,
        escape_xml(&sheet.name),
        context.table_style,
    );
    if context
        .wide
        .sheet_protection
        .as_ref()
        .is_some_and(|protection| protection.protected)
    {
        // The password hash does not travel (the two formats hash
        // differently); the sheet stays protected without one.
        head.push_str(r#" table:protected="true""#);
    }
    if let Some(ranges) = print_ranges(sheet.print_area.as_deref()) {
        head.push_str(&format!(r#" table:print-ranges="{}""#, escape_xml(&ranges)));
    }
    head.push('>');
    out.write_all(head.as_bytes())?;

    // Column axis: one entry per run of identical columns, inside the group
    // and title wrappers the sheet asks for.
    let default_width = default_column_points(sheet);
    let column_breaks: HashSet<usize> = context.wide.col_breaks.iter().copied().collect();
    let mut column_axis = vec![
        ColumnAxis {
            width: None,
            hidden: false,
            default_style: None,
            level: 0,
            break_before: false,
            title: false,
        };
        axis
    ];
    let mut column_styles: Vec<Option<usize>> = vec![None; axis];
    let mut default_names: HashMap<usize, Option<String>> = HashMap::new();
    for span in &sheet.column_widths {
        let start = span.start_column.min(axis);
        let end = span.end_column.saturating_add(1).min(axis);
        let default_style = span.style_index.and_then(|index| {
            default_names
                .entry(index)
                .or_insert_with(|| {
                    registry
                        .resolve_cell(context.styles.get(index).unwrap_or(context.base))
                        .name
                })
                .clone()
        });
        for column in start..end {
            column_axis[column].width = span.width.filter(|width| *width > 0.0);
            column_axis[column].hidden = span.hidden;
            column_axis[column].default_style = default_style.clone();
            column_axis[column].level = span.outline_level.unwrap_or(0).min(MAX_OUTLINE_LEVEL);
            column_styles[column] = span.style_index;
        }
    }
    for (column, entry) in column_axis.iter_mut().enumerate() {
        entry.break_before = column_breaks.contains(&column);
        entry.title = title_columns.is_some_and(|(first, last)| column >= first && column <= last);
    }
    let mut nesting = Nesting::columns();
    let mut column = 0;
    while column < axis {
        let entry = &column_axis[column];
        let mut run = 1;
        while column + run < axis && column_axis[column + run] == *entry {
            run += 1;
        }
        if !nesting.matches(entry.level, entry.title) {
            out.write_all(nesting.enter(entry.level, entry.title, entry.hidden).as_bytes())?;
        }
        let mut attributes = String::new();
        // A column without a width still says one: left unsaid, a reader
        // uses its own default, which is a third wider than Excel's.
        let width = entry.width.map_or(default_width, width_points);
        if let Some(name) = registry.column(Some(width), entry.break_before) {
            attributes.push_str(&format!(r#" table:style-name="{name}""#));
        }
        if let Some(name) = &entry.default_style {
            attributes.push_str(&format!(r#" table:default-cell-style-name="{name}""#));
        }
        if entry.hidden {
            attributes.push_str(r#" table:visibility="collapse""#);
        }
        if run > 1 {
            attributes.push_str(&format!(r#" table:number-columns-repeated="{run}""#));
        }
        out.write_all(format!("<table:table-column{attributes}/>").as_bytes())?;
        column += run;
    }
    out.write_all(nesting.close().as_bytes())?;
    if axis < MAX_COLUMNS {
        // The columns past the last one described keep the default width too.
        if let Some(name) = registry.column(Some(default_width), false) {
            out.write_all(
                format!(
                    r#"<table:table-column table:style-name="{name}" table:number-columns-repeated="{}"/>"#,
                    MAX_COLUMNS - axis
                )
                .as_bytes(),
            )?;
        }
    }
    // A reader only applies a column's default cell style to rows the table
    // does not spell out, so every row that is written names the style on its
    // empty cells too.
    let column_defaults: Vec<Option<String>> = column_axis
        .iter()
        .map(|entry| entry.default_style.clone())
        .collect();
    let styled_columns = column_defaults
        .iter()
        .rposition(Option::is_some)
        .map(|last| last + 1)
        .unwrap_or(0);
    let plain_row = empty_row_cells(&[], &column_defaults, styled_columns);
    // The validations that cover the current row, as column spans. They only
    // change where a range starts or ends, so the cells of an otherwise empty
    // row are built once per band and reused.
    let areas = context.validations;
    let mut area_cursor = 0;
    let mut area_active: Vec<&ValidationArea> = Vec::new();
    let mut spans: Vec<ValidationSpan<'_>> = Vec::new();
    let mut band_row = plain_row.clone();

    let comments: HashMap<(usize, usize), &CommentInfo> = sheet
        .comments
        .iter()
        .map(|comment| ((comment.row, comment.column), comment))
        .collect();
    let row_breaks: HashSet<usize> = context.wide.row_breaks.iter().copied().collect();
    let mut merges = MergeIndex::default();
    let mut sink = RowSink {
        out,
        pending: 0,
        pending_cells: String::new(),
        wrote_row: false,
        rows: 0,
        fill_to_end: styled_columns > 0,
        plain_row: plain_row.clone(),
    };
    let mut nesting = Nesting::rows();
    let mut row_styles: HashMap<usize, Option<usize>> = HashMap::new();
    let mut resolved: HashMap<usize, ResolvedStyle> = HashMap::new();
    let window_rows = (READ_WINDOW_CELLS / columns.max(1)).clamp(1, 4096);

    // A note or a drawing sits in a cell, and that cell may lie below or to
    // the right of the box. The rows down to the last of them are walked too;
    // nothing is read for them.
    let total_rows = comments
        .keys()
        .chain(context.frames.keys())
        .map(|(row, _)| row + 1)
        .max()
        .unwrap_or(0)
        .max(rows)
        .min(MAX_ROWS);
    let mut start = 0;
    while start < total_rows {
        let end = (start + window_rows - 1).min(total_rows - 1);
        let (mut window_cells, window_row_properties, window_links, window_merges) = if start < rows
        {
            let range = CellRange {
                start_row: start,
                end_row: end.min(rows - 1),
                start_column: 0,
                end_column: columns - 1,
            };
            let window = sessions.read_range(session_id, &sheet.id, &range)?;
            (window.cells, window.rows, window.hyperlinks, window.merges)
        } else {
            (Vec::new(), Vec::new(), Vec::new(), Vec::new())
        };
        for merge in &window_merges {
            merges.add(*merge);
        }
        merges.sort();
        // A note or a drawing on a cell with no record still needs a cell to
        // sit in.
        let mut placed: Vec<(usize, usize)> = comments
            .keys()
            .chain(context.frames.keys())
            .filter(|(row, column)| (start..=end).contains(row) && *column < MAX_COLUMNS)
            .copied()
            .collect();
        if !placed.is_empty() {
            placed.sort_unstable();
            placed.dedup();
            let recorded: HashSet<(usize, usize)> = window_cells
                .iter()
                .map(|cell| (cell.row, cell.column))
                .collect();
            for (row, column) in placed {
                if !recorded.contains(&(row, column)) {
                    window_cells.push(CellRecord {
                        row,
                        column,
                        value: None,
                        formula: None,
                        array_ref: None,
                        style_index: None,
                        rich: None,
                    });
                }
            }
        }
        let links: HashMap<(usize, usize), &str> = window_links
            .iter()
            .map(|link| ((link.row, link.column), link.target.as_str()))
            .collect();
        let mut by_row: HashMap<usize, Vec<&CellRecord>> = HashMap::new();
        for cell in &window_cells {
            by_row.entry(cell.row).or_default().push(cell);
        }
        for cells in by_row.values_mut() {
            cells.sort_by_key(|cell| cell.column);
        }
        row_styles.clear();
        let mut row_properties: HashMap<usize, &RowProperty> = HashMap::new();
        for row in &window_row_properties {
            row_styles.insert(row.row, row.style_index);
            row_properties.insert(row.row, row);
        }
        let mut cursor = merges.partition_before(start);
        let mut active: Vec<&MergedRange> = merges.active_from(start, cursor);
        for row in start..=end {
            while cursor < merges.len() && merges.merges[cursor].start_row <= row {
                active.push(&merges.merges[cursor]);
                cursor += 1;
            }
            active.retain(|merge| merge.end_row >= row);
            let mut band_changed = false;
            while area_cursor < areas.len() && areas[area_cursor].range.start_row <= row {
                area_active.push(&areas[area_cursor]);
                area_cursor += 1;
                band_changed = true;
            }
            let covering = area_active.len();
            area_active.retain(|area| area.range.end_row >= row);
            if band_changed || area_active.len() != covering {
                spans = validation_spans(&area_active);
                band_row = empty_row_cells(&spans, &column_defaults, styled_columns);
            }
            let properties = row_properties.get(&row).copied();
            let level = properties
                .and_then(|properties| properties.outline_level)
                .unwrap_or(0)
                .min(MAX_OUTLINE_LEVEL);
            let title = title_rows.is_some_and(|(first, last)| row >= first && row <= last);
            if !nesting.matches(level, title) {
                let collapsed = properties.is_some_and(|properties| properties.hidden);
                sink.raw(&nesting.enter(level, title, collapsed))?;
            }
            let row_context = RowContext {
                row,
                properties,
                row_style: row_styles.get(&row).copied().flatten(),
                break_before: row_breaks.contains(&row),
                filtered: context
                    .filtered_rows
                    .is_some_and(|(first, last)| row > first && row <= last),
                column_styles: &column_styles,
                column_defaults: &column_defaults,
                styled_columns,
                columns,
                links: &links,
                comments: &comments,
                validations: &spans,
                empty_row: &band_row,
                window: &by_row,
            };
            write_row(
                &mut sink,
                context,
                &row_context,
                by_row.get(&row).map(Vec::as_slice).unwrap_or(&[]),
                &active,
                registry,
                &mut resolved,
                counters,
            )?;
        }
        start = end + 1;
    }
    let closing = nesting.close();
    if !closing.is_empty() {
        sink.raw(&closing)?;
    }
    // A validation that reaches past the last row of the box still has cells
    // to mark. The rows below are empty, so each band between two range
    // boundaries is one repeated row.
    let mut row = total_rows;
    while row < MAX_ROWS {
        while area_cursor < areas.len() && areas[area_cursor].range.start_row <= row {
            area_active.push(&areas[area_cursor]);
            area_cursor += 1;
        }
        area_active.retain(|area| area.range.end_row >= row);
        let next_start = areas.get(area_cursor).map(|area| area.range.start_row);
        let next_end = area_active.iter().map(|area| area.range.end_row + 1).min();
        let Some(next) = [next_start, next_end].into_iter().flatten().min() else {
            break;
        };
        let next = next.min(MAX_ROWS);
        if next <= row {
            break;
        }
        let cells = empty_row_cells(&validation_spans(&area_active), &column_defaults, styled_columns);
        sink.empty_rows(next - row, &cells)?;
        row = next;
    }
    sink.finish()?;
    if !context.local_names.is_empty() {
        write!(
            out,
            "<table:named-expressions>{}</table:named-expressions>",
            context.local_names
        )?;
    }
    out.write_all(context.sparklines.as_bytes())?;
    out.write_all(context.conditional_formats.as_bytes())?;
    out.write_all(b"</table:table>")?;
    Ok(())
}

/// The merges read so far, in sheet order. A window only reports the merges it
/// intersects, so the list grows as the sheet is walked; the sorted prefix is
/// what lets the row loop keep a small active set.
#[derive(Default)]
struct MergeIndex {
    merges: Vec<MergedRange>,
    seen: HashSet<(usize, usize, usize, usize)>,
}

impl MergeIndex {
    fn add(&mut self, merge: MergedRange) {
        let key = (
            merge.start_row,
            merge.start_column,
            merge.end_row,
            merge.end_column,
        );
        if self.seen.insert(key) {
            self.merges.push(merge);
        }
    }

    fn sort(&mut self) {
        self.merges
            .sort_by_key(|merge| (merge.start_row, merge.start_column));
    }

    fn partition_before(&self, row: usize) -> usize {
        self.merges.partition_point(|merge| merge.start_row <= row)
    }

    fn active_from(&self, row: usize, cursor: usize) -> Vec<&MergedRange> {
        self.merges[..cursor]
            .iter()
            .filter(|merge| merge.end_row >= row)
            .collect()
    }

    fn len(&self) -> usize {
        self.merges.len()
    }
}

/// Rows written in order, with a run of empty rows collapsed into one repeated
/// row element. Trailing empty rows are dropped: nothing needs them.
struct RowSink<'a, W: Write> {
    out: &'a mut W,
    pending: usize,
    wrote_row: bool,
    /// Rows written so far, repeats counted.
    rows: usize,
    /// The cells the pending empty rows share.
    pending_cells: String,
    /// A column's default cell style runs to the last row of the sheet, and a
    /// reader only paints it on rows the table spells out — so the tail of
    /// the sheet is written as one repeated row instead of being dropped.
    fill_to_end: bool,
    /// The cells of a row that holds nothing of its own and sits under no
    /// validation: one empty cell, or the styled empties of the columns that
    /// carry a default cell style.
    plain_row: String,
}

impl<W: Write> RowSink<'_, W> {
    /// `count` rows that hold nothing but `cells`. Neighbours with the same
    /// cells collapse into one repeated row.
    fn empty_rows(&mut self, count: usize, cells: &str) -> io::Result<()> {
        if self.pending > 0 && self.pending_cells != cells {
            self.flush()?;
        }
        if self.pending == 0 {
            self.pending_cells.clear();
            self.pending_cells.push_str(cells);
        }
        self.pending += count;
        Ok(())
    }

    fn push(&mut self, attributes: &str, cells: &str) -> io::Result<()> {
        self.flush()?;
        write!(
            self.out,
            "<table:table-row{attributes}>{cells}</table:table-row>"
        )?;
        self.wrote_row = true;
        self.rows += 1;
        Ok(())
    }

    /// Group and title tags between rows. The empty rows waiting in front of
    /// them belong on their side of the tag, so they are written first.
    fn raw(&mut self, tags: &str) -> io::Result<()> {
        if tags.is_empty() {
            return Ok(());
        }
        self.flush()?;
        self.out.write_all(tags.as_bytes())
    }

    fn flush(&mut self) -> io::Result<()> {
        if self.pending == 0 {
            return Ok(());
        }
        let repeat = if self.pending > 1 {
            format!(r#" table:number-rows-repeated="{}""#, self.pending)
        } else {
            String::new()
        };
        write!(
            self.out,
            "<table:table-row{repeat}>{}</table:table-row>",
            self.pending_cells
        )?;
        self.rows += self.pending;
        self.pending = 0;
        self.wrote_row = true;
        Ok(())
    }

    fn finish(&mut self) -> io::Result<()> {
        // Pending rows that mark a validation are content; plain ones at the
        // end of the sheet are not.
        if self.pending > 0 && self.pending_cells != self.plain_row {
            self.flush()?;
        }
        if self.fill_to_end && self.rows < MAX_ROWS {
            let plain = self.plain_row.clone();
            self.pending = 0;
            self.empty_rows(MAX_ROWS - self.rows, &plain)?;
            return self.flush();
        }
        if !self.wrote_row {
            self.out
                .write_all(b"<table:table-row><table:table-cell/></table:table-row>")?;
        }
        self.pending = 0;
        Ok(())
    }
}

/// One row's surroundings: its properties, the styles it inherits, and the
/// links and notes of the window it sits in.
struct RowContext<'a> {
    row: usize,
    properties: Option<&'a RowProperty>,
    row_style: Option<usize>,
    break_before: bool,
    filtered: bool,
    column_styles: &'a [Option<usize>],
    /// The default cell style each column carries, by name.
    column_defaults: &'a [Option<String>],
    /// One past the last column that carries a default cell style.
    styled_columns: usize,
    columns: usize,
    links: &'a HashMap<(usize, usize), &'a str>,
    comments: &'a HashMap<(usize, usize), &'a CommentInfo>,
    /// The validations covering this row, as column spans in column order.
    validations: &'a [ValidationSpan<'a>],
    /// The cells of this row if it holds nothing of its own.
    empty_row: &'a str,
    /// The records of the window being written, by row and sorted by column.
    window: &'a HashMap<usize, Vec<&'a CellRecord>>,
}

impl RowContext<'_> {
    /// The style index of a cell elsewhere in the window, when it has one.
    fn style_index_at(&self, row: usize, column: usize) -> Option<usize> {
        let cells = self.window.get(&row)?;
        let index = cells.binary_search_by_key(&column, |cell| cell.column).ok()?;
        cells[index].style_index.filter(|index| *index != 0)
    }
}

/// The style of a merged cell. Excel keeps the right and bottom edges of a
/// merged area on its last column and last row; ODF draws the whole area with
/// the first cell's style, so those edges move there. The last row is only
/// looked at when it lies in the window being written.
fn merged_style(
    record: Option<&CellRecord>,
    merge: &MergedRange,
    row_context: &RowContext<'_>,
    context: &SheetContext<'_>,
    registry: &mut StyleRegistry,
    own: ResolvedStyle,
) -> ResolvedStyle {
    let style_at = |row: usize, column: usize| {
        row_context
            .style_index_at(row, column)
            .and_then(|index| context.styles.get(index))
    };
    let right = style_at(merge.start_row, merge.end_column).and_then(|style| style.border_right.clone());
    let bottom = style_at(merge.end_row, merge.start_column).and_then(|style| style.border_bottom.clone());
    if right.is_none() && bottom.is_none() {
        return own;
    }
    let index = record
        .and_then(|record| record.style_index)
        .filter(|index| *index != 0)
        .or(row_context.row_style)
        .or_else(|| {
            row_context
                .column_styles
                .get(merge.start_column)
                .copied()
                .flatten()
        })
        .unwrap_or(0);
    let mut style = context.styles.get(index).cloned().unwrap_or_else(|| context.base.clone());
    let mut changed = false;
    if style.border_right.is_none() && right.is_some() {
        style.border_right = right;
        changed = true;
    }
    if style.border_bottom.is_none() && bottom.is_some() {
        style.border_bottom = bottom;
        changed = true;
    }
    if !changed {
        return own;
    }
    registry.resolve_cell(&style)
}

/// First column, last column and the validation's name.
type ValidationSpan<'a> = (usize, usize, &'a str);

/// The column spans of the validations covering a row. Where two overlap the
/// one that starts first keeps the cells, so a cell names one validation.
fn validation_spans<'a>(active: &[&'a ValidationArea]) -> Vec<ValidationSpan<'a>> {
    let mut spans: Vec<ValidationSpan<'a>> = active
        .iter()
        .map(|area| {
            (
                area.range.start_column,
                area.range.end_column.min(MAX_COLUMNS - 1),
                area.name.as_str(),
            )
        })
        .collect();
    spans.sort_by_key(|span| span.0);
    let mut kept: Vec<ValidationSpan<'a>> = Vec::new();
    for span in spans {
        if kept.last().is_none_or(|last| span.0 > last.1) {
            kept.push(span);
        }
    }
    kept
}

fn validation_at<'a>(spans: &[ValidationSpan<'a>], column: usize) -> Option<&'a str> {
    spans
        .iter()
        .find(|span| span.0 <= column && column <= span.1)
        .map(|span| span.2)
}

/// The cells of a row that holds nothing of its own: the styled empties of
/// the default-styled columns and the marks of the validations covering it.
fn empty_row_cells(
    spans: &[ValidationSpan<'_>],
    column_defaults: &[Option<String>],
    styled_columns: usize,
) -> String {
    let last = spans
        .last()
        .map(|span| span.1 + 1)
        .unwrap_or(0)
        .max(styled_columns);
    if last == 0 {
        return "<table:table-cell/>".to_owned();
    }
    empty_cells(0, last - 1, None, column_defaults, spans)
}

#[allow(clippy::too_many_arguments)]
fn write_row<W: Write>(
    sink: &mut RowSink<'_, W>,
    context: &SheetContext<'_>,
    row_context: &RowContext<'_>,
    cells: &[&CellRecord],
    active: &[&MergedRange],
    registry: &mut StyleRegistry,
    resolved: &mut HashMap<usize, ResolvedStyle>,
    counters: &mut Counters,
) -> Result<(), SidecarError> {
    let row = row_context.row;
    let mut last = cells.last().map(|cell| cell.column);
    for merge in active {
        last = Some(last.map_or(merge.end_column, |last| last.max(merge.end_column)));
    }
    // A row with its own default style paints every cell of the row, so its
    // empty cells have to be there to carry it.
    let row_style_name = row_context.row_style.and_then(|index| {
        style_at(index, context, registry, resolved).name
    });
    if row_style_name.is_some() {
        last = Some(last.map_or(row_context.columns - 1, |last| {
            last.max(row_context.columns - 1)
        }));
    }
    let attributes = row_attributes(row_context, registry);
    let Some(last) = last else {
        if attributes.is_empty() {
            sink.empty_rows(1, row_context.empty_row)?;
        } else {
            sink.push(&attributes, row_context.empty_row)?;
        }
        return Ok(());
    };
    // The styled empties of the default-styled columns and the cells under a
    // validation reach past the last record of the row.
    let mut last = if row_context.styled_columns > 0 {
        last.max(row_context.styled_columns - 1)
    } else {
        last
    };
    if let Some(span) = row_context.validations.last() {
        last = last.max(span.1);
    }

    let mut xml = String::with_capacity((last + 1) * 48);
    let mut column = 0;
    let mut cell_index = 0;
    while column <= last {
        // A record can only be emitted at its own column; anything left
        // behind sits inside a merged range and has no place in ODF.
        while cell_index < cells.len() && cells[cell_index].column < column {
            cell_index += 1;
        }
        let anchor = active
            .iter()
            .find(|merge| merge.start_row == row && merge.start_column == column)
            .copied();
        if anchor.is_none() {
            if let Some(merge) = active
                .iter()
                .find(|merge| merge.start_column <= column && merge.end_column >= column)
            {
                // A covered cell may still hold a value: some writers put the
                // merged text in every cell of the range, and Excel keeps
                // what it finds there for the formulas that point at it. The
                // cell stays covered and keeps its content.
                let carries = |cell: &CellRecord| {
                    holds_content(cell) || context.frames.contains_key(&(row, cell.column))
                };
                if let Some(record) = cells
                    .get(cell_index)
                    .filter(|cell| cell.column == column)
                    .filter(|cell| carries(cell))
                    .copied()
                {
                    cell_index += 1;
                    let style =
                        resolve_style(Some(record), row_context, column, context, registry, resolved);
                    push_cell(
                        &mut xml,
                        "table:covered-table-cell",
                        Some(record),
                        style.name.as_deref(),
                        style.kind,
                        None,
                        None,
                        context,
                        row_context,
                        column,
                        registry,
                        counters,
                    );
                    column += 1;
                    continue;
                }
                // Otherwise ODF only wants the covered cells present, and a
                // repeat count keeps a wide merged banner to one element.
                let mut run = 1;
                while column + run <= last
                    && merge.end_column >= column + run
                    && !(merge.start_row == row && merge.start_column == column + run)
                    && !cells[cell_index.min(cells.len())..]
                        .iter()
                        .take_while(|cell| cell.column <= column + run)
                        .any(|cell| cell.column == column + run && carries(cell))
                {
                    run += 1;
                }
                if run > 1 {
                    xml.push_str(&format!(
                        r#"<table:covered-table-cell table:number-columns-repeated="{run}"/>"#
                    ));
                } else {
                    xml.push_str("<table:covered-table-cell/>");
                }
                column += run;
                continue;
            }
        }
        let record = cells
            .get(cell_index)
            .filter(|cell| cell.column == column)
            .copied();
        if record.is_some() || anchor.is_some() {
            if record.is_some() {
                cell_index += 1;
            }
            let style = resolve_style(record, row_context, column, context, registry, resolved);
            let style = match anchor {
                Some(merge) => merged_style(record, merge, row_context, context, registry, style),
                None => style,
            };
            let style_name = style.name.clone().or_else(|| {
                // A plain cell in a column that has a default cell style
                // would pick that style up unless it names the plain one.
                row_context
                    .column_defaults
                    .get(column)
                    .is_some_and(Option::is_some)
                    .then(|| DEFAULT_CELL_STYLE.to_owned())
            });
            push_cell(
                &mut xml,
                "table:table-cell",
                record,
                style_name.as_deref(),
                style.kind,
                anchor,
                validation_at(row_context.validations, column),
                context,
                row_context,
                column,
                registry,
                counters,
            );
            column += 1;
            continue;
        }
        // The empty run ends before the next record or merge. Nothing covers
        // this column, so both lie strictly to its right.
        let next_record = cells.get(cell_index).map(|cell| cell.column);
        let next_merge = active
            .iter()
            .filter(|merge| merge.start_column > column)
            .map(|merge| merge.start_column)
            .min();
        let end = [next_record, next_merge]
            .into_iter()
            .flatten()
            .min()
            .map_or(last, |next| (next - 1).min(last));
        xml.push_str(&empty_cells(
            column,
            end,
            row_style_name.as_deref(),
            row_context.column_defaults,
            row_context.validations,
        ));
        column = end + 1;
    }
    if let Some(name) = row_style_name.as_deref().filter(|_| last + 1 < MAX_COLUMNS) {
        // The row's own style runs to the last column of the sheet.
        xml.push_str(&format!(
            r#"<table:table-cell table:style-name="{name}" table:number-columns-repeated="{}"/>"#,
            MAX_COLUMNS - (last + 1)
        ));
    }
    sink.push(&attributes, &xml)?;
    Ok(())
}

/// Empty cells for the columns `first..=last`, in runs of one style under
/// one validation. A row's own default style wins over a column's, as it does
/// in the workbook.
fn empty_cells(
    first: usize,
    last: usize,
    row_style: Option<&str>,
    column_defaults: &[Option<String>],
    validations: &[ValidationSpan<'_>],
) -> String {
    let style_of = |column: usize| {
        row_style.or_else(|| column_defaults.get(column).and_then(|name| name.as_deref()))
    };
    let mut out = String::new();
    let mut column = first;
    while column <= last {
        let style = style_of(column);
        // Past the last column that names a default style nothing changes, so
        // the run is not walked column by column to the end of the sheet.
        let style_end = if row_style.is_some() || column >= column_defaults.len() {
            last
        } else {
            let limit = last.min(column_defaults.len() - 1);
            let mut same = column;
            while same < limit && style_of(same + 1) == style {
                same += 1;
            }
            if same == column_defaults.len() - 1 && style.is_none() {
                last
            } else {
                same
            }
        };
        let validation = validations
            .iter()
            .find(|span| span.0 <= column && column <= span.1);
        let end = match validation {
            Some(span) => style_end.min(span.1),
            None => validations
                .iter()
                .find(|span| span.0 > column)
                .map_or(style_end, |next| style_end.min(next.0 - 1)),
        };
        let run = end - column + 1;
        out.push_str("<table:table-cell");
        if let Some(name) = style {
            out.push_str(&format!(r#" table:style-name="{name}""#));
        }
        if let Some(span) = validation {
            out.push_str(&format!(r#" table:content-validation-name="{}""#, span.2));
        }
        if run > 1 {
            out.push_str(&format!(r#" table:number-columns-repeated="{run}""#));
        }
        out.push_str("/>");
        column = end + 1;
    }
    out
}

fn holds_content(record: &CellRecord) -> bool {
    record.value.is_some() || record.formula.is_some()
}

fn row_attributes(row_context: &RowContext<'_>, registry: &mut StyleRegistry) -> String {
    let properties = row_context.properties;
    let mut attributes = String::new();
    let height = properties
        .and_then(|properties| properties.height)
        .filter(|height| *height > 0.0);
    let fixed = properties.is_some_and(|properties| properties.custom_height);
    if let Some(name) = registry.row(height, fixed, row_context.break_before) {
        attributes.push_str(&format!(r#" table:style-name="{name}""#));
    }
    if properties.is_some_and(|properties| properties.hidden) {
        attributes.push_str(if row_context.filtered {
            r#" table:visibility="filter""#
        } else {
            r#" table:visibility="collapse""#
        });
    }
    attributes
}

fn style_at(
    index: usize,
    context: &SheetContext<'_>,
    registry: &mut StyleRegistry,
    cache: &mut HashMap<usize, ResolvedStyle>,
) -> ResolvedStyle {
    if let Some(style) = cache.get(&index) {
        return style.clone();
    }
    // An xf index past the table keeps the default look rather than dropping
    // the cell.
    let style = registry.resolve_cell(context.styles.get(index).unwrap_or(context.base));
    cache.insert(index, style.clone());
    style
}

fn resolve_style(
    record: Option<&CellRecord>,
    row_context: &RowContext<'_>,
    column: usize,
    context: &SheetContext<'_>,
    registry: &mut StyleRegistry,
    cache: &mut HashMap<usize, ResolvedStyle>,
) -> ResolvedStyle {
    let own = record.and_then(|record| record.style_index).unwrap_or(0);
    let index = if own != 0 {
        own
    } else {
        row_context
            .row_style
            .or_else(|| row_context.column_styles.get(column).copied().flatten())
            .unwrap_or(0)
    };
    style_at(index, context, registry, cache)
}

/// One `table:table-cell` (or its merge anchor) with the value, formula,
/// style, note and link the record carries.
#[allow(clippy::too_many_arguments)]
fn push_cell(
    out: &mut String,
    element: &str,
    record: Option<&CellRecord>,
    style_name: Option<&str>,
    kind: ValueKind,
    merge: Option<&MergedRange>,
    validation: Option<&str>,
    context: &SheetContext<'_>,
    row_context: &RowContext<'_>,
    column: usize,
    registry: &mut StyleRegistry,
    counters: &mut Counters,
) {
    let mut attributes = String::new();
    if let Some(name) = style_name {
        attributes.push_str(&format!(r#" table:style-name="{name}""#));
    }
    if let Some(name) = validation {
        attributes.push_str(&format!(r#" table:content-validation-name="{name}""#));
    }
    if let Some(merge) = merge {
        let columns = merge.end_column - merge.start_column + 1;
        let rows = merge.end_row - merge.start_row + 1;
        if columns > 1 {
            attributes.push_str(&format!(r#" table:number-columns-spanned="{columns}""#));
        }
        if rows > 1 {
            attributes.push_str(&format!(r#" table:number-rows-spanned="{rows}""#));
        }
    }
    let formula = record.and_then(|record| record.formula.as_deref());
    let translated =
        formula.and_then(|formula| odf_formula::to_odf_with(formula, context.names));
    if formula.is_some() && translated.is_none() {
        counters.formulas_dropped += 1;
    }
    if let Some(translated) = &translated {
        // A CSE/array formula fills a whole range from its master cell. ODF
        // says so with the matrix span on that cell; the other cells of the
        // range keep their values and the reader fills them from the master.
        if let Some(range) = record
            .and_then(|record| record.array_ref.as_deref())
            .and_then(parse_range)
        {
            attributes.push_str(&format!(
                r#" table:number-matrix-columns-spanned="{}" table:number-matrix-rows-spanned="{}""#,
                range.end_column - range.start_column + 1,
                range.end_row - range.start_row + 1,
            ));
        }
        attributes.push_str(&format!(
            r#" table:formula="{}""#,
            escape_xml(translated)
        ));
    }
    let key = (row_context.row, column);
    let link = row_context.links.get(&key).and_then(|target| {
        if target.starts_with('#') {
            odf_formula::odf_internal_link(target, &context.sheet.name)
        } else {
            Some((*target).to_owned())
        }
    });
    let mut body = match record.and_then(|record| record.value.as_ref()) {
        // A text cell holding nothing is an empty cell, unless a formula
        // produced the nothing.
        Some(CellValue::String(text)) if text.is_empty() && formula.is_none() => String::new(),
        // A date the workbook stores as ISO text (`t="d"`) is the value ODF
        // stores dates as; written as a string it would stop being a date.
        Some(CellValue::String(text)) if kind == ValueKind::Date && is_iso_date(text) => {
            attributes.push_str(&format!(
                r#" office:value-type="date" office:date-value="{}""#,
                escape_xml(text)
            ));
            format!("<text:p>{}</text:p>", escape_xml(&text.replace('T', " ")))
        }
        Some(CellValue::String(text)) => {
            attributes.push_str(r#" office:value-type="string""#);
            let runs = record
                .and_then(|record| record.rich.as_deref())
                .filter(|runs| runs.iter().map(|run| run.text.as_str()).collect::<String>() == *text);
            text_paragraphs(text, runs, link.as_deref(), registry)
        }
        Some(CellValue::Boolean(flag)) => {
            attributes.push_str(&format!(
                r#" office:value-type="boolean" office:boolean-value="{}""#,
                if *flag { "true" } else { "false" }
            ));
            format!("<text:p>{}</text:p>", if *flag { "TRUE" } else { "FALSE" })
        }
        Some(CellValue::Number(number)) => {
            let number = *number;
            match kind {
                ValueKind::Date => match serial_parts(number, context.date1904) {
                    Some((year, month, day, seconds)) => {
                        attributes.push_str(&format!(
                            r#" office:value-type="date" office:date-value="{}""#,
                            date_value(year, month, day, seconds)
                        ));
                        format!("<text:p>{}</text:p>", date_text(year, month, day, seconds))
                    }
                    // A serial with no real date (Excel's phantom 1900 leap
                    // day) keeps its number: a wrong date would be worse.
                    None => number_parts(number, &mut attributes),
                },
                // A duration cannot be negative; a negative time keeps its
                // number rather than turning into zero.
                ValueKind::Time if number.is_finite() && number >= 0.0 => {
                    attributes.push_str(&format!(
                        r#" office:value-type="time" office:time-value="{}""#,
                        duration_value(number)
                    ));
                    format!("<text:p>{}</text:p>", duration_text(number))
                }
                ValueKind::Time | ValueKind::Number => number_parts(number, &mut attributes),
            }
        }
        None => String::new(),
    };
    // A link on a number, date or logical cell wraps the text the cell
    // shows; a text cell already carries its link in its paragraphs.
    if let (Some(link), false) = (
        &link,
        matches!(
            record.and_then(|record| record.value.as_ref()),
            Some(CellValue::String(_)) | None
        ),
    ) {
        if let Some(inner) = body
            .strip_prefix("<text:p>")
            .and_then(|rest| rest.strip_suffix("</text:p>"))
            .filter(|inner| !inner.contains("<text:p>"))
        {
            body = format!(
                r#"<text:p><text:a xlink:type="simple" xlink:href="{}">{inner}</text:a></text:p>"#,
                escape_xml(link)
            );
        }
    }
    if let Some(comment) = row_context.comments.get(&key) {
        // The note goes ahead of the cell's own paragraphs.
        body.insert_str(0, &annotation_xml(comment));
        counters.dropped.comments = counters.dropped.comments.saturating_sub(1);
    }
    if let Some(frames) = context.frames.get(&key) {
        body.push_str(frames);
    }
    if body.is_empty() {
        out.push_str(&format!("<{element}{attributes}/>"));
    } else {
        out.push_str(&format!("<{element}{attributes}>{body}</{element}>"));
    }
    // An empty text cell was written as an empty cell, so it is not counted
    // among the cells that hold something.
    counters.cells += usize::from(record.is_some_and(|record| {
        record.formula.is_some()
            || record
                .value
                .as_ref()
                .is_some_and(|value| !matches!(value, CellValue::String(text) if text.is_empty()))
    }));
}

/// A note as `office:annotation`: its author and its text, one paragraph per
/// line.
fn annotation_xml(comment: &CommentInfo) -> String {
    let mut out = String::from("<office:annotation>");
    if !comment.author.is_empty() {
        out.push_str(&format!(
            "<dc:creator>{}</dc:creator>",
            escape_xml(&comment.author)
        ));
    }
    for line in comment.text.split('\n') {
        out.push_str("<text:p>");
        push_text(&mut out, line);
        out.push_str("</text:p>");
    }
    out.push_str("</office:annotation>");
    out
}

/// `2010-01-11` or `2010-01-11T09:30:00`, digits where digits belong. A zone
/// suffix is not accepted: a spreadsheet date has none.
fn is_iso_date(text: &str) -> bool {
    let bytes = text.as_bytes();
    let digits = |range: std::ops::Range<usize>| {
        bytes
            .get(range)
            .is_some_and(|part| part.iter().all(u8::is_ascii_digit))
    };
    if !(digits(0..4) && bytes.get(4) == Some(&b'-') && digits(5..7) && bytes.get(7) == Some(&b'-') && digits(8..10))
    {
        return false;
    }
    match bytes.len() {
        10 => true,
        length if length >= 19 => {
            bytes[10] == b'T'
                && digits(11..13)
                && bytes[13] == b':'
                && digits(14..16)
                && bytes[16] == b':'
                && digits(17..19)
                && bytes[19..]
                    .iter()
                    .enumerate()
                    .all(|(index, byte)| if index == 0 { *byte == b'.' } else { byte.is_ascii_digit() })
        }
        _ => false,
    }
}

fn number_parts(number: f64, attributes: &mut String) -> String {
    attributes.push_str(&format!(
        r#" office:value-type="float" office:value="{}""#,
        number_text(number)
    ));
    format!("<text:p>{}</text:p>", number_text(number))
}

/// A number as the text an ODF attribute and a cell paragraph carry.
fn number_text(number: f64) -> String {
    if !number.is_finite() {
        return "0".to_owned();
    }
    if number == 0.0 {
        return "0".to_owned();
    }
    format!("{number}")
}

/// The serial's civil date and seconds of that day. `None` when the serial is
/// not a date a reader can show (below the grid, or Excel's 1900-02-29).
fn serial_parts(serial: f64, date1904: bool) -> Option<(i64, u32, u32, f64)> {
    if !serial.is_finite() || serial < 0.0 {
        return None;
    }
    let adjusted = if date1904 { serial + 1462.0 } else { serial };
    // Serial 60 is the day Excel shows as 1900-02-29; no calendar has it.
    if (60.0..61.0).contains(&adjusted) || adjusted < 1.0 {
        return None;
    }
    let mut days = adjusted.floor();
    if adjusted < 60.0 {
        // Excel counts from 1900-01-01 as serial 1, but its phantom leap day
        // shifts every later date by one; the 1899-12-30 epoch absorbs that
        // only from March 1900 on.
        days += 1.0;
    }
    if days > 2_958_465.0 {
        return None;
    }
    let (year, month, day) = civil_from_days(days as i64 - 25_569);
    let mut seconds = (adjusted.fract() * 86_400.0 * 1000.0).round() / 1000.0;
    if seconds >= 86_400.0 {
        seconds = 0.0;
    }
    Some((year, month, day, seconds))
}

/// Days since 1970-01-01 → the civil date (Howard Hinnant's algorithm).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 { shifted } else { shifted - 146_096 } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_position = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_position + 2) / 5 + 1) as u32;
    let month = if month_position < 10 {
        month_position + 3
    } else {
        month_position - 9
    } as u32;
    (year + i64::from(month <= 2), month, day)
}

fn date_value(year: i64, month: u32, day: u32, seconds: f64) -> String {
    let date = format!("{year:04}-{month:02}-{day:02}");
    if seconds <= 0.0 {
        return date;
    }
    format!("{date}T{}", clock(seconds))
}

fn date_text(year: i64, month: u32, day: u32, seconds: f64) -> String {
    let date = format!("{year:04}-{month:02}-{day:02}");
    if seconds <= 0.0 {
        return date;
    }
    format!("{date} {}", clock(seconds))
}

fn clock(seconds: f64) -> String {
    let whole = seconds.floor() as u64;
    let (hours, minutes, secs) = (whole / 3600, (whole / 60) % 60, whole % 60);
    let millis = ((seconds - whole as f64) * 1000.0).round() as u64;
    if millis > 0 && millis < 1000 {
        format!("{hours:02}:{minutes:02}:{secs:02}.{millis:03}")
            .trim_end_matches('0')
            .to_owned()
    } else {
        format!("{hours:02}:{minutes:02}:{secs:02}")
    }
}

/// A fraction of a day as an ISO 8601 duration (`PT13H30M00S`).
fn duration_value(serial: f64) -> String {
    let total = if serial.is_finite() && serial > 0.0 {
        serial * 86_400.0
    } else {
        0.0
    };
    let whole = total.round() as u64;
    let (hours, minutes, seconds) = (whole / 3600, (whole / 60) % 60, whole % 60);
    format!("PT{hours}H{minutes}M{seconds}S")
}

fn duration_text(serial: f64) -> String {
    let total = if serial.is_finite() && serial > 0.0 {
        serial * 86_400.0
    } else {
        0.0
    };
    let whole = total.round() as u64;
    format!(
        "{:02}:{:02}:{:02}",
        whole / 3600,
        (whole / 60) % 60,
        whole % 60
    )
}

/// A cell's text as ODF paragraphs: one per line, with tabs and space runs the
/// format would otherwise collapse. `runs` carry the formatting of text that
/// is not all one look, and `link` wraps every paragraph in a hyperlink.
fn text_paragraphs(
    text: &str,
    runs: Option<&[RichRun]>,
    link: Option<&str>,
    registry: &mut StyleRegistry,
) -> String {
    let pieces: Vec<(Option<String>, &str)> = match runs {
        Some(runs) => runs
            .iter()
            .map(|run| (registry.text_run(run), run.text.as_str()))
            .collect(),
        None => vec![(None, text)],
    };
    let open = match link {
        Some(link) => format!(
            r#"<text:p><text:a xlink:type="simple" xlink:href="{}">"#,
            escape_xml(link)
        ),
        None => "<text:p>".to_owned(),
    };
    let close = if link.is_some() { "</text:a></text:p>" } else { "</text:p>" };
    let mut out = open.clone();
    for (style, piece) in &pieces {
        for (index, line) in piece.split('\n').enumerate() {
            if index > 0 {
                out.push_str(close);
                out.push_str(&open);
            }
            if line.is_empty() {
                continue;
            }
            match style {
                Some(name) => {
                    out.push_str(&format!(r#"<text:span text:style-name="{name}">"#));
                    push_text(&mut out, line);
                    out.push_str("</text:span>");
                }
                None => push_text(&mut out, line),
            }
        }
    }
    out.push_str(close);
    out
}

fn push_text(out: &mut String, line: &str) {
    let characters: Vec<char> = line.chars().collect();
    let mut index = 0;
    while index < characters.len() {
        let character = characters[index];
        if character == ' ' {
            let start = index;
            while index < characters.len() && characters[index] == ' ' {
                index += 1;
            }
            let count = index - start;
            if start == 0 || count > 1 || index == characters.len() {
                out.push_str(&format!(r#"<text:s text:c="{count}"/>"#));
            } else {
                out.push(' ');
            }
            continue;
        }
        index += 1;
        match character {
            '\t' => out.push_str("<text:tab/>"),
            '\r' => {}
            character if (character as u32) < 0x20 => {}
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            character => out.push(character),
        }
    }
}

fn table_style_xml(name: &str, sheet: &SheetMetadata, master: &str) -> String {
    let mut properties = format!(
        r#" table:display="{}""#,
        if sheet.hidden { "false" } else { "true" }
    );
    if sheet.right_to_left {
        properties.push_str(r#" style:writing-mode="rl-tb""#);
    }
    if let Some(color) = sheet.tab_color.as_ref().filter(|color| !color.is_empty()) {
        properties.push_str(&format!(r#" table:tab-color="{}""#, escape_xml(color)));
    }
    format!(
        r#"<style:style style:name="{name}" style:family="table" style:master-page-name="{master}"><style:table-properties{properties}/></style:style>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use calamine::Reader;
    use std::io::Read;
    use tempfile::tempdir;
    use zip::ZipArchive;

    fn write_workbook(path: &Path, entries: &[(&str, String)]) {
        let file = File::create(path).unwrap();
        let mut writer = ZipWriter::new(file);
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, content) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(content.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    fn read_entry(path: &Path, name: &str) -> String {
        let mut archive = ZipArchive::new(File::open(path).unwrap()).unwrap();
        let mut entry = archive.by_name(name).unwrap();
        let mut content = String::new();
        entry.read_to_string(&mut content).unwrap();
        content
    }

    const STYLES: &str = concat!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
        r#"<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">"#,
        r#"<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><color rgb="FFFF0000"/><name val="Arial"/></font></fonts>"#,
        r#"<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>"#,
        r#"<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border></borders>"#,
        r#"<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>"#,
        r#"<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>"#,
        r#"</styleSheet>"#,
    );

    const SHEET: &str = concat!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
        r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:F4"/>"#,
        r#"<sheetFormatPr defaultRowHeight="15"/>"#,
        r#"<cols><col min="1" max="1" width="20.5" customWidth="1"/><col min="5" max="5" width="12" customWidth="1" hidden="1"/></cols>"#,
        r#"<sheetData>"#,
        r#"<row r="1"><c r="A1" t="inlineStr"><is><t>Hello &amp; &lt;World&gt;</t></is></c><c r="B1" s="1"><v>42</v></c><c r="C1" s="5"><v>3.14159</v></c><c r="D1" s="4"><v>46086</v></c><c r="E1" s="6"><v>0.25</v></c><c r="F1" s="3"/></row>"#,
        r#"<row r="2" ht="30" customHeight="1"><c r="A2" t="b"><v>1</v></c><c r="B2"><f>B1*2</f><v>84</v></c><c r="C2"><f>SUM(B1:B2)</f><v>126</v></c><c r="D2"><f>MyRange</f><v>7</v></c><c r="E2" t="e"><v>#DIV/0!</v></c></row>"#,
        r#"<row r="3"><c r="A3" t="inlineStr"><is><t>merged</t></is></c></row><row r="4"><c r="A4" s="2" t="inlineStr"><is><t>filled</t></is></c></row>"#,
        r#"</sheetData><mergeCells count="1"><mergeCell ref="A3:B3"/></mergeCells></worksheet>"#,
    );

    const HIDDEN_SHEET: &str = concat!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
        r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/>"#,
        r#"<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hidden sheet</t></is></c></row></sheetData></worksheet>"#,
    );

    fn workbook_entries(sheet: &str, hidden: &str) -> Vec<(&'static str, String)> {
        vec![
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>"#.to_owned(),
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#.to_owned(),
            ),
            ("xl/styles.xml", STYLES.to_owned()),
            ("xl/worksheets/sheet1.xml", sheet.to_owned()),
            ("xl/worksheets/sheet2.xml", hidden.to_owned()),
        ]
    }

    /// A cell's value as text, so the assertions do not need `PartialEq` on
    /// the protocol enum.
    fn read_cell_value(range: &RangeResult, row: usize, column: usize) -> Option<String> {
        range
            .cells
            .iter()
            .find(|cell| cell.row == row && cell.column == column)
            .and_then(|cell| match &cell.value {
                Some(CellValue::String(text)) => Some(format!("s:{text}")),
                Some(CellValue::Number(number)) => Some(format!("n:{number}")),
                Some(CellValue::Boolean(flag)) => Some(format!("b:{flag}")),
                None => None,
            })
    }

    #[test]
    fn writes_values_formulas_dates_merges_sizes_and_styles() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("book.xlsx");
        write_workbook(&source, &workbook_entries(SHEET, HIDDEN_SHEET));
        let target = dir.path().join("book.ods");
        let result = convert_to_ods(&source, &target).unwrap();
        assert_eq!(result.sheets, 2);
        assert_eq!(result.formulas_dropped, 1, "MyRange cannot be written");

        // The mimetype has to be the first, stored entry of the package, with
        // its sizes patched in place (a data descriptor there confuses some
        // readers).
        let bytes = std::fs::read(&target).unwrap();
        assert_eq!(&bytes[0..4], b"PK\x03\x04");
        assert_eq!(&bytes[30..38], b"mimetype");
        assert_eq!(u16::from_le_bytes([bytes[8], bytes[9]]), 0, "stored");
        assert_eq!(
            u16::from_le_bytes([bytes[6], bytes[7]]) & 0x0008,
            0,
            "the local header carries its sizes"
        );
        let mut archive = ZipArchive::new(File::open(&target).unwrap()).unwrap();
        let first = archive.by_index(0).unwrap();
        assert_eq!(first.name().unwrap(), "mimetype");
        assert_eq!(first.compression(), CompressionMethod::Stored);
        drop(first);

        // Every part is well-formed XML a reader can trust.
        for name in [
            "content.xml",
            "styles.xml",
            "meta.xml",
            "settings.xml",
            "META-INF/manifest.xml",
        ] {
            let xml = read_entry(&target, name);
            roxmltree::Document::parse(&xml)
                .unwrap_or_else(|error| panic!("{name} is not well-formed: {error}"));
        }

        let content = read_entry(&target, "content.xml");
        assert!(
            content.contains(r#"table:formula="of:=[.B1]*2""#),
            "{content}"
        );
        assert!(
            content.contains(r#"table:formula="of:=SUM([.B1:.B2])""#),
            "{content}"
        );
        assert!(!content.contains("MyRange"), "a refused formula must not appear");
        assert!(
            content.contains(r#"office:value-type="string""#),
            "{content}"
        );
        assert!(content.contains(r#"office:date-value="2026-03-05""#), "{content}");
        assert!(content.contains(r#"office:boolean-value="true""#), "{content}");
        assert!(
            content.contains(r#"table:number-columns-spanned="2""#),
            "{content}"
        );
        assert!(content.contains("<table:covered-table-cell/>"), "{content}");
        assert!(content.contains(r#"table:display="false""#), "{content}");
        assert!(content.contains("style:column-width="), "{content}");
        assert!(content.contains(r#"style:row-height="30.00pt""#), "{content}");
        assert!(content.contains(r#"office:value-type="float" office:value="3.14159""#), "{content}");
        assert!(content.contains("style:data-style-name="), "{content}");
        assert!(content.contains("table:visibility=\"collapse\""), "{content}");

        let styles = read_entry(&target, "styles.xml");
        let automatic = read_entry(&target, "content.xml");
        let all = format!("{styles}{automatic}");
        assert!(all.contains(r#"fo:font-weight="bold""#), "{all}");
        assert!(all.contains(r##"fo:color="#FF0000""##), "{all}");
        assert!(all.contains(r##"fo:background-color="#FFFF00""##), "{all}");
        assert!(
            all.contains(r#"fo:border-bottom="0.75pt solid #000000""#),
            "{all}"
        );
        assert!(all.contains("number:percentage-style") || all.contains("number:number-style"), "{all}");

        // The package opens as an ordinary ODS for calamine too.
        let reopened = calamine::open_workbook_auto(&target).unwrap();
        assert_eq!(
            reopened.sheet_names(),
            vec!["Data".to_owned(), "Hidden".to_owned()]
        );

        // And comes back through the import with its values, formulas,
        // merges and sizes intact.
        let layouts = crate::odf_layout::read_layouts(&target).unwrap();
        assert_eq!(
            layouts[0].merges,
            vec![((2, 0), (2, 1))],
            "the writer's merge is readable"
        );
        let round = dir.path().join("round.xlsx");
        crate::convert::convert_to_xlsx(&target, &round).unwrap();
        let round_sheet = read_entry(&round, "xl/worksheets/sheet1.xml");
        assert!(
            round_sheet.contains("<mergeCells"),
            "the import writes the merge: {round_sheet}"
        );
        let mut sessions = WorkbookSessions::new();
        let metadata = sessions.open(&round).unwrap();
        assert_eq!(metadata.sheets[0].column_widths[0].width, Some(20.5));

        let mut range = sessions
            .read_range(
                &metadata.session_id,
                &metadata.sheets[0].id,
                &CellRange {
                    start_row: 0,
                    end_row: 3,
                    start_column: 0,
                    end_column: 4,
                },
            )
            .unwrap();
        // Merges are published with the finished index, so the cells are read
        // again once it has completed.
        for _ in 0..100 {
            if range.indexing_complete {
                break;
            }
            range = sessions
                .read_range(
                    &metadata.session_id,
                    &metadata.sheets[0].id,
                    &CellRange {
                        start_row: 0,
                        end_row: 3,
                        start_column: 0,
                        end_column: 4,
                    },
                )
                .unwrap();
        }
        assert!(range.indexing_complete);
        assert_eq!(
            read_cell_value(&range, 0, 0),
            Some("s:Hello & <World>".to_owned())
        );
        assert_eq!(read_cell_value(&range, 0, 1), Some("n:42".to_owned()));
        assert_eq!(
            read_cell_value(&range, 0, 2),
            Some("n:3.14159".to_owned())
        );
        assert_eq!(
            read_cell_value(&range, 0, 3),
            Some("n:46086".to_owned())
        );
        assert_eq!(read_cell_value(&range, 0, 4), Some("n:0.25".to_owned()));
        assert_eq!(read_cell_value(&range, 1, 0), Some("b:true".to_owned()));
        assert_eq!(read_cell_value(&range, 1, 1), Some("n:84".to_owned()));
        assert_eq!(read_cell_value(&range, 1, 2), Some("n:126".to_owned()));
        assert_eq!(read_cell_value(&range, 1, 3), Some("n:7".to_owned()));
        assert_eq!(
            read_cell_value(&range, 1, 4),
            Some("s:#DIV/0!".to_owned())
        );
        assert_eq!(
            range.merges.len(),
            1,
            "the merged banner survives the round trip: {:?}",
            range.merges
        );
        assert_eq!(
            (range.merges[0].start_row, range.merges[0].start_column),
            (2, 0)
        );
        assert_eq!(
            (range.merges[0].end_row, range.merges[0].end_column),
            (2, 1)
        );
        let height = range
            .rows
            .iter()
            .find(|row| row.row == 1)
            .and_then(|row| row.height);
        assert!(
            height.is_some_and(|height| (height - 30.0).abs() < 0.1),
            "{height:?}"
        );

        let formulas = sessions
            .read_formula_cells(&metadata.session_id, &metadata.sheets[0].id)
            .unwrap();
        let texts: Vec<&str> = formulas
            .cells
            .iter()
            .filter_map(|cell| cell.formula.as_deref())
            .collect();
        assert!(texts.contains(&"=B1*2"), "{texts:?}");
        assert!(texts.contains(&"=SUM(B1:B2)"), "{texts:?}");
        assert!(
            !texts.iter().any(|text| text.contains("MyRange")),
            "{texts:?}"
        );

        // The formulas that came back out of the package are real Excel
        // syntax: the formula engine accepts them and computes the same
        // answers. (The converted file itself is not imported here —
        // IronCalc's xlsx reader requires parts the minimal import writer
        // does not emit.)
        let mut model = ironcalc::base::Model::new_empty("check", "en", "UTC", "en").unwrap();
        model.set_user_input(0, 1, 2, "42".to_owned()).unwrap();
        for (row, column, formula) in [(2, 2, "=B1*2"), (2, 3, "=SUM(B1:B2)")] {
            model
                .set_user_input(0, row, column, formula.to_owned())
                .unwrap();
        }
        model.evaluate();
        let computed = |row: i32, column: i32| match model.get_cell_value_by_index(0, row, column) {
            Ok(ironcalc::base::cell::CellValue::Number(value)) => Some(value),
            _ => None,
        };
        assert_eq!(computed(2, 2), Some(84.0), "B2 = B1*2");
        assert_eq!(computed(2, 3), Some(126.0), "C2 = SUM(B1:B2)");
    }

    /// A chart, a picture, a note, a conditional format, a validation and a
    /// pivot leave the package, and each is counted so the app can say so.
    #[test]
    fn counts_the_features_that_do_not_travel() {
        let drawing = concat!(
            r#"<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">"#,
            r#"<xdr:twoCellAnchor><xdr:from><xdr:col>2</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>6</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>"#,
            r#"<xdr:twoCellAnchor><xdr:from><xdr:col>7</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Picture 1"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="100000" cy="100000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>"#,
            r#"</xdr:wsDr>"#,
        );
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:B3"/>"#,
            r#"<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row><row r="2"><c r="A2"><v>3</v></c><c r="B2"><v>4</v></c></row><row r="3"><c r="A3"><v>5</v></c><c r="B3"><v>6</v></c></row></sheetData>"#,
            r#"<conditionalFormatting sqref="B1:B3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>3</formula></cfRule></conditionalFormatting>"#,
            r#"<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="C1:C3"><formula1>"one,two"</formula1></dataValidation></dataValidations>"#,
            r#"<drawing r:id="rId2"/></worksheet>"#,
        );
        let entries = vec![
            (
                "xl/workbook.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>"#.to_owned(),
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_owned(),
            ),
            ("xl/worksheets/sheet1.xml", sheet.to_owned()),
            (
                "xl/worksheets/_rels/sheet1.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/></Relationships>"#.to_owned(),
            ),
            ("xl/drawings/drawing1.xml", drawing.to_owned()),
            (
                "xl/drawings/_rels/drawing1.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>"#.to_owned(),
            ),
            (
                "xl/charts/chart1.xml",
                r#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>8</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>"#.to_owned(),
            ),
            ("xl/media/image1.png", String::from_utf8_lossy(&[0x89u8, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]).into_owned()),
            (
                "xl/comments1.xml",
                r#"<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Me</author></authors><commentList><comment ref="A1" authorId="0"><text><r><t>Note</t></r></text></comment></commentList></comments>"#.to_owned(),
            ),
            (
                "xl/pivotTables/pivotTable1.xml",
                r#"<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="PivotTable1"><location ref="H1:J5" firstDataRow="1" firstDataCol="1"/></pivotTableDefinition>"#.to_owned(),
            ),
        ];
        let dir = tempdir().unwrap();
        let source = dir.path().join("features.xlsx");
        write_workbook(&source, &entries);
        let target = dir.path().join("features.ods");
        let result = convert_to_ods(&source, &target).unwrap();
        // The chart travels as an embedded chart document. Its series names
        // no cell range, so it reads the values the workbook cached.
        assert_eq!(result.dropped.charts, 0);
        let chart = read_entry(&target, "Object 1/content.xml");
        roxmltree::Document::parse(&chart).unwrap_or_else(|error| panic!("{error}: {chart}"));
        assert!(chart.contains(r#"chart:class="chart:bar""#), "{chart}");
        assert!(
            chart.contains(r#"chart:values-cell-range-address="local-table.$B$2:.$B$2" chart:label-cell-address="local-table.$B$1" chart:class="chart:bar""#),
            "{chart}"
        );
        assert!(
            chart.contains(r#"<table:table-cell office:value-type="float" office:value="8"><text:p>8</text:p></table:table-cell>"#),
            "{chart}"
        );
        assert!(
            read_entry(&target, "META-INF/manifest.xml").contains(
                r#"<manifest:file-entry manifest:full-path="Object 1/" manifest:media-type="application/vnd.oasis.opendocument.chart"/><manifest:file-entry manifest:full-path="Object 1/content.xml" manifest:media-type="text/xml"/>"#
            )
        );
        assert!(
            read_entry(&target, "content.xml").contains(r#"<draw:object xlink:href="./Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>"#)
        );
        // The picture travels: its bytes are in the package and a frame in
        // its start cell points at them.
        assert_eq!(result.dropped.images, 0);
        let picture = {
            let mut archive = ZipArchive::new(File::open(&target).unwrap()).unwrap();
            let mut bytes = Vec::new();
            archive
                .by_name("Pictures/image1.png")
                .unwrap()
                .read_to_end(&mut bytes)
                .unwrap();
            bytes
        };
        assert!(picture.ends_with(&[b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]), "{picture:?}");
        assert!(
            read_entry(&target, "META-INF/manifest.xml").contains(
                r#"<manifest:file-entry manifest:full-path="Pictures/image1.png" manifest:media-type="image/png"/>"#
            )
        );
        // The note travels now, so it is no longer among the losses.
        assert_eq!(result.dropped.comments, 0);
        assert_eq!(result.dropped.macros, 0);
        // The rule names a differential style the workbook does not have, so
        // there is nothing for it to paint; the validation travels.
        assert_eq!(result.dropped.conditional_formats, 1);
        assert_eq!(result.dropped.validations, 0);
        assert_eq!(result.dropped.pivots, 1);

        // The sheet with a chart still carries its values.
        let content = read_entry(&target, "content.xml");
        assert!(content.contains(r#"office:value="5""#), "{content}");
        assert!(
            content.contains(
                "<office:annotation><dc:creator>Me</dc:creator><text:p>Note</text:p></office:annotation>"
            ),
            "{content}"
        );
    }

    /// A long empty stretch is one repeated row element, and the sheet is read
    /// in more than one window without losing either end.
    #[test]
    fn collapses_long_empty_stretches_into_repeated_rows() {
        let mut sheet = String::from(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A5000"/><sheetData>"#,
        );
        for row in 1..=5000 {
            match row {
                1 => sheet.push_str(r#"<row r="1"><c r="A1"><v>11</v></c></row>"#),
                5000 => sheet.push_str(r#"<row r="5000"><c r="A5000"><v>22</v></c></row>"#),
                _ => {}
            }
        }
        sheet.push_str("</sheetData></worksheet>");

        let dir = tempdir().unwrap();
        let source = dir.path().join("long.xlsx");
        write_workbook(
            &source,
            &[
                (
                    "xl/workbook.xml",
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Long" sheetId="1" r:id="rId1"/></sheets></workbook>"#.to_owned(),
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_owned(),
                ),
                ("xl/worksheets/sheet1.xml", sheet),
            ],
        );
        let target = dir.path().join("long.ods");
        let result = convert_to_ods(&source, &target).unwrap();
        assert_eq!(result.cells, 2, "only the two values count");
        let content = read_entry(&target, "content.xml");
        assert!(content.contains(r#"table:number-rows-repeated="4998""#), "{content}");
        assert!(content.contains(r#"office:value="11""#), "{content}");
        assert!(content.contains(r#"office:value="22""#), "{content}");
    }

    /// A legacy CSE/array formula is not written as an ordinary formula: its
    /// master cell carries the span of the range it fills, and the other
    /// cells of that range keep their values.
    #[test]
    fn writes_array_formulas_with_the_range_they_fill() {
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:A2"/><sheetData>"#,
            // A1 is the CSE master spanning A1:A2; A2 keeps only its cached
            // value, as Excel writes followers.
            r#"<row r="1"><c r="A1"><f t="array" ref="A1:A2">TRANSPOSE(B1:C1)</f><v>7</v></c></row>"#,
            r#"<row r="2"><c r="A2"><v>8</v></c></row>"#,
            r#"</sheetData></worksheet>"#,
        );
        let dir = tempdir().unwrap();
        let source = dir.path().join("array.xlsx");
        write_workbook(
            &source,
            &[
                (
                    "xl/workbook.xml",
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Array" sheetId="1" r:id="rId1"/></sheets></workbook>"#.to_owned(),
                ),
                (
                    "xl/_rels/workbook.xml.rels",
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>"#.to_owned(),
                ),
                ("xl/worksheets/sheet1.xml", sheet.to_owned()),
            ],
        );
        let target = dir.path().join("array.ods");
        let result = convert_to_ods(&source, &target).unwrap();
        assert_eq!(result.formulas_dropped, 0);

        let content = read_entry(&target, "content.xml");
        assert!(
            content.contains(
                r#"table:number-matrix-columns-spanned="1" table:number-matrix-rows-spanned="2" table:formula="of:=TRANSPOSE([.B1:.C1])" office:value-type="float" office:value="7""#
            ),
            "{content}"
        );
        assert_eq!(content.matches("table:formula").count(), 1, "{content}");

        // And it comes back as the array formula it was.
        let round = dir.path().join("round.xlsx");
        crate::convert::convert_to_xlsx(&target, &round).unwrap();
        let sheet = read_entry(&round, "xl/worksheets/sheet1.xml");
        assert!(
            sheet.contains(r#"<f t="array" ref="A1:A2">TRANSPOSE(B1:C1)</f>"#),
            "{sheet}"
        );
        assert!(content.contains(r#"office:value="7""#), "{content}");
        assert!(content.contains(r#"office:value="8""#), "{content}");
    }

    #[test]
    fn refuses_a_target_that_is_the_source_and_leaves_no_partial_file() {
        let dir = tempdir().unwrap();
        let source = dir.path().join("book.xlsx");
        write_workbook(&source, &workbook_entries(SHEET, HIDDEN_SHEET));
        let error = convert_to_ods(&source, &source).unwrap_err();
        assert!(error.to_string().contains("must differ"), "{error}");

        let target = dir.path().join("missing").join("out.ods");
        assert!(convert_to_ods(&source, &target).is_err());
        assert!(!target.exists(), "a failed export must leave no file");
    }

    fn single_sheet_entries(
        workbook_extra: &str,
        sheet: &str,
        extra: Vec<(&'static str, String)>,
    ) -> Vec<(&'static str, String)> {
        let mut entries = vec![
            (
                "xl/workbook.xml",
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets>{workbook_extra}</workbook>"#
                ),
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#.to_owned(),
            ),
            ("xl/styles.xml", STYLES.to_owned()),
            ("xl/worksheets/sheet1.xml", sheet.to_owned()),
        ];
        entries.extend(extra);
        entries
    }

    fn export(entries: &[(&str, String)]) -> (OdsExportResult, String, String, String, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let source = dir.path().join("book.xlsx");
        write_workbook(&source, entries);
        let target = dir.path().join("book.ods");
        let result = convert_to_ods(&source, &target).unwrap();
        for name in ["content.xml", "styles.xml", "settings.xml"] {
            let xml = read_entry(&target, name);
            roxmltree::Document::parse(&xml)
                .unwrap_or_else(|error| panic!("{name} is not well-formed: {error}\n{xml}"));
        }
        (
            result,
            read_entry(&target, "content.xml"),
            read_entry(&target, "styles.xml"),
            read_entry(&target, "settings.xml"),
            dir,
        )
    }

    /// Excel and ODF disagree on what a formula means unless the document
    /// says which rules it was written under.
    #[test]
    fn says_how_the_formulas_were_meant_to_calculate() {
        let sheet = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1"/><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>"#;
        let (_, content, _, _, _dir) = export(&single_sheet_entries("", sheet, vec![]));
        assert!(
            content.contains(
                r#"<table:calculation-settings table:case-sensitive="false" table:automatic-find-labels="false" table:use-regular-expressions="false" table:use-wildcards="true"/>"#
            ),
            "{content}"
        );
        let (_, dated, _, _, _dir) = export(&single_sheet_entries(
            r#"<workbookPr date1904="1"/>"#,
            sheet,
            vec![],
        ));
        assert!(
            dated.contains(r#"<table:null-date table:date-value="1904-01-01"/></table:calculation-settings>"#),
            "{dated}"
        );
    }

    #[test]
    fn carries_names_links_notes_and_the_functions_excel_added_later() {
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:D3"/><sheetData>"#,
            r#"<row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>Total*Rate</f><v>0.5</v></c><c r="C1"><f>Local+Gone</f><v>1</v></c><c r="D1"><f>_xlfn.IFS(A1&gt;1,A2)</f><v>3</v></c></row>"#,
            r#"<row r="2"><c r="A2"><v>3</v></c><c r="B2" t="inlineStr"><is><t>site</t></is></c><c r="C2" t="inlineStr"><is><t>jump</t></is></c><c r="D2"><f>CEILING(A1,2)+FDIST(A1,2,3)</f><v>2</v></c></row>"#,
            r#"<row r="3"><c r="A3" t="inlineStr"><is><r><t xml:space="preserve">plain </t></r><r><rPr><b/><color rgb="FFFF0000"/></rPr><t>loud</t></r></is></c></row>"#,
            r#"</sheetData><hyperlinks><hyperlink ref="B2" r:id="rId1"/><hyperlink ref="C2" location="'Data'!A3"/></hyperlinks></worksheet>"#,
        );
        let names = concat!(
            r#"<definedNames>"#,
            r#"<definedName name="Total">Data!$A$1:$A$2</definedName>"#,
            r#"<definedName name="Rate">0.1</definedName>"#,
            r#"<definedName name="Scaled">SUM(Total)*Rate</definedName>"#,
            r#"<definedName name="Local" localSheetId="0">Data!$A$1</definedName>"#,
            r#"<definedName name="Broken">[1]Other!$A$1</definedName>"#,
            r#"<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$C$2</definedName>"#,
            r#"<definedName name="_xlnm.Print_Titles" localSheetId="0">Data!$1:$1,Data!$A:$A</definedName>"#,
            r#"</definedNames>"#,
        );
        let extra = vec![
            (
                "xl/worksheets/_rels/sheet1.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="../comments1.xml"/></Relationships>"#.to_owned(),
            ),
            (
                "xl/comments1.xml",
                r#"<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>Kim</author></authors><commentList><comment ref="D3" authorId="0"><text><r><t>first
second</t></r></text></comment></commentList></comments>"#.to_owned(),
            ),
        ];
        let (result, content, _, _, _dir) = export(&single_sheet_entries(names, sheet, extra));
        // `Gone` is not a name the workbook defines.
        assert_eq!(result.formulas_dropped, 1);
        assert_eq!(result.dropped.comments, 0);

        assert!(
            content.contains(r#"table:formula="of:=Total*Rate""#),
            "{content}"
        );
        assert!(
            content.contains(r#"table:formula="of:=COM.MICROSOFT.IFS([.A1]&gt;1;[.A2])""#),
            "{content}"
        );
        // Two functions whose plain names mean something else in ODF.
        assert!(
            content.contains(
                r#"table:formula="of:=COM.MICROSOFT.CEILING([.A1];2)+LEGACY.FDIST([.A1];2;3)""#
            ),
            "{content}"
        );
        assert!(
            content.contains(
                r#"<table:named-expressions><table:named-range table:name="Total" table:base-cell-address="$Data.$A$1" table:cell-range-address="$Data.$A$1:.$A$2"/><table:named-expression table:name="Rate" table:base-cell-address="$Data.$A$1" table:expression="0.1"/><table:named-expression table:name="Scaled" table:base-cell-address="$Data.$A$1" table:expression="SUM(Total)*Rate"/></table:named-expressions>"#
            ),
            "{content}"
        );
        // The sheet's own name sits inside its table.
        assert!(
            content.contains(
                r#"<table:named-expressions><table:named-range table:name="Local" table:base-cell-address="$Data.$A$1" table:cell-range-address="$Data.$A$1"/></table:named-expressions></table:table>"#
            ),
            "{content}"
        );
        assert!(!content.contains("Broken"), "{content}");
        assert!(!content.contains("_xlnm"), "{content}");
        // The print area and the repeated titles are table markup, not names.
        assert!(
            content.contains(r#"table:print-ranges="$Data.$A$1:.$C$2""#),
            "{content}"
        );
        assert!(
            content.contains(r#"<table:table-header-columns><table:table-column table:style-name="co1"/></table:table-header-columns>"#),
            "{content}"
        );
        assert!(
            content.contains("<table:table-header-rows><table:table-row>"),
            "{content}"
        );
        assert!(
            content.contains(
                r#"<text:p><text:a xlink:type="simple" xlink:href="https://example.com/a?b=1&amp;c=2">site</text:a></text:p>"#
            ),
            "{content}"
        );
        assert!(
            content.contains(r##"<text:a xlink:type="simple" xlink:href="#Data.A3">jump</text:a>"##),
            "{content}"
        );
        assert!(
            content.contains(
                "<office:annotation><dc:creator>Kim</dc:creator><text:p>first</text:p><text:p>second</text:p></office:annotation>"
            ),
            "{content}"
        );
        assert!(
            content.contains(r#"<text:p>plain<text:s text:c="1"/><text:span text:style-name="T"#),
            "{content}"
        );
        assert!(content.contains(">loud</text:span></text:p>"), "{content}");
    }

    #[test]
    fn carries_outlines_filters_tables_breaks_and_protection() {
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetPr><tabColor rgb="FF00FF00"/></sheetPr><dimension ref="A1:D6"/>"#,
            r#"<sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="150"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>"#,
            r#"<cols><col min="2" max="3" width="9" outlineLevel="1"/></cols>"#,
            r#"<sheetData>"#,
            r#"<row r="1"><c r="A1" t="inlineStr"><is><t>k</t></is></c><c r="B1" t="inlineStr"><is><t>v</t></is></c></row>"#,
            r#"<row r="2" outlineLevel="1"><c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2"><v>1</v></c></row>"#,
            r#"<row r="3" outlineLevel="2" hidden="1"><c r="A3" t="inlineStr"><is><t>b</t></is></c><c r="B3"><v>2</v></c></row>"#,
            r#"<row r="4" outlineLevel="1"><c r="A4" t="inlineStr"><is><t>a</t></is></c><c r="B4"><v>3</v></c></row>"#,
            r#"<row r="5"><c r="A5" t="inlineStr"><is><t>a</t></is></c><c r="B5"><v>4</v></c></row>"#,
            r#"</sheetData><sheetProtection sheet="1" objects="1" scenarios="1"/>"#,
            r#"<autoFilter ref="A1:B5"><filterColumn colId="0"><filters><filter val="a"/></filters></filterColumn><filterColumn colId="1"><customFilters and="1"><customFilter operator="greaterThanOrEqual" val="1"/><customFilter operator="lessThan" val="9"/></customFilters></filterColumn></autoFilter>"#,
            r#"<rowBreaks count="1" manualBreakCount="1"><brk id="4" max="16383" man="1"/></rowBreaks>"#,
            r#"<colBreaks count="1" manualBreakCount="1"><brk id="3" max="1048575" man="1"/></colBreaks>"#,
            r#"<tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>"#,
        );
        let extra = vec![
            (
                "xl/worksheets/_rels/sheet1.xml.rels",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>"#.to_owned(),
            ),
            (
                "xl/tables/table1.xml",
                r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Sales" displayName="Sales" ref="A1:B5" totalsRowShown="0"><autoFilter ref="A1:B5"/><tableColumns count="2"><tableColumn id="1" name="k"/><tableColumn id="2" name="v"/></tableColumns></table>"#.to_owned(),
            ),
            (
                "xl/vbaProject.bin",
                "not really a project".to_owned(),
            ),
        ];
        let (result, content, _, settings, _dir) = export(&single_sheet_entries("", sheet, extra));
        assert_eq!(result.dropped.macros, 1, "the VBA project stays behind");

        // Row groups nest by level, and the group whose first row is hidden
        // opens collapsed.
        assert!(
            content.contains(
                r#"<table:table-row-group><table:table-row><table:table-cell office:value-type="string"><text:p>a</text:p></table:table-cell>"#
            ),
            "{content}"
        );
        assert!(
            content.contains(r#"<table:table-row-group table:display="false"><table:table-row table:visibility="filter">"#),
            "{content}"
        );
        assert_eq!(content.matches("</table:table-row-group>").count(), 2, "{content}");
        assert!(
            content.contains(r#"<table:table-column-group><table:table-column table:style-name="co"#),
            "{content}"
        );
        // The filter keeps its range, its buttons and its criteria.
        assert!(
            content.contains(
                r#"<table:database-range table:name="__Anonymous_Sheet_DB__0" table:target-range-address="$Data.$A$1:.$B$5" table:display-filter-buttons="true"><table:filter><table:filter-and><table:filter-condition table:field-number="0" table:operator="=" table:value="a"><table:filter-set-item table:value="a"/></table:filter-condition><table:filter-condition table:field-number="1" table:operator="&gt;=" table:value="1" table:data-type="number"/><table:filter-condition table:field-number="1" table:operator="&lt;" table:value="9" table:data-type="number"/></table:filter-and></table:filter></table:database-range>"#
            ),
            "{content}"
        );
        assert!(
            content.contains(
                r#"<table:database-range table:name="Sales" table:target-range-address="$Data.$A$1:.$B$5" table:contains-header="true" table:display-filter-buttons="true"/>"#
            ),
            "{content}"
        );
        assert!(content.contains(r#"table:protected="true""#), "{content}");
        assert!(content.contains(r##"table:tab-color="#00FF00""##), "{content}");
        assert!(content.contains(r#"fo:break-before="page""#), "{content}");

        // Frozen panes say where each pane starts, and the sheet keeps its
        // zoom and hidden grid.
        for item in [
            r#"config:name="HorizontalSplitMode" config:type="short">2<"#,
            r#"config:name="HorizontalSplitPosition" config:type="int">1<"#,
            r#"config:name="PositionRight" config:type="int">1<"#,
            r#"config:name="PositionBottom" config:type="int">1<"#,
            r#"config:name="ActiveSplitRange" config:type="short">3<"#,
            r#"config:name="ZoomValue" config:type="int">150<"#,
            r#"config:name="ShowGrid" config:type="boolean">false<"#,
        ] {
            assert!(settings.contains(item), "{item}: {settings}");
        }

        // The grouped rows are still rows to the reader that comes back.
        let reopened: calamine::Sheets<_> = calamine::open_workbook_auto(_dir.path().join("book.ods")).unwrap();
        drop(reopened);
        let round = _dir.path().join("round.xlsx");
        let converted = crate::convert::convert_to_xlsx(&_dir.path().join("book.ods"), &round).unwrap();
        assert_eq!(converted.cells, 10, "every cell survives the groups");
    }

    #[test]
    fn default_styled_columns_and_rows_paint_their_empty_cells() {
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C3"/>"#,
            r#"<cols><col min="3" max="3" width="9" style="2"/></cols>"#,
            r#"<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="C1" t="inlineStr"><is><t>plain</t></is></c></row>"#,
            r#"<row r="3" s="2" customFormat="1"><c r="A3" s="2"><v>3</v></c></row></sheetData></worksheet>"#,
        );
        let (_, content, styles, _, _dir) = export(&single_sheet_entries("", sheet, vec![]));
        // The column names its default cell style …
        assert!(
            content.contains(r#"table:default-cell-style-name="ce"#),
            "{content}"
        );
        // … a cell in it with no style of its own takes the column's …
        assert!(
            content.contains(r#"<table:table-cell table:style-name="ce1" office:value-type="string"><text:p>plain</text:p>"#),
            "{content}"
        );
        // … and the plain style has a name a cell can point at instead.
        assert!(
            styles.contains(r#"<style:style style:name="Default" style:family="table-cell"/>"#),
            "{styles}"
        );
        // … the empty row between carries the style on the column's cell …
        assert!(
            content.contains(r#"<table:table-row><table:table-cell table:number-columns-repeated="2"/><table:table-cell table:style-name="ce"#),
            "{content}"
        );
        // … the styled row runs to the last column …
        assert!(
            content.contains(r#"table:number-columns-repeated="16381"/></table:table-row>"#),
            "{content}"
        );
        // … and the column's style runs to the last row.
        assert!(
            content.contains(r#"<table:table-row table:number-rows-repeated="1048573">"#),
            "{content}"
        );
    }

    #[test]
    fn a_negative_time_keeps_its_number() {
        let styles = STYLES.replace(
            r#"<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>"#,
            r#"<xf numFmtId="20" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>"#,
        );
        let sheet = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B1"/><sheetData><row r="1"><c r="A1" s="6"><v>-0.25</v></c><c r="B1" s="6"><v>0.25</v></c></row></sheetData></worksheet>"#;
        let mut entries = single_sheet_entries("", sheet, vec![]);
        entries[2].1 = styles;
        let (_, content, _, _, _dir) = export(&entries);
        assert!(
            content.contains(r#"office:value-type="float" office:value="-0.25""#),
            "{content}"
        );
        assert!(
            content.contains(r#"office:value-type="time" office:time-value="PT6H0M0S""#),
            "{content}"
        );
    }

    #[test]
    fn covered_cells_keep_their_values_and_iso_dates_stay_dates() {
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D2"/><sheetData>"#,
            // A writer that put the merged text in every cell of the range.
            r#"<row r="1"><c r="A1" t="inlineStr"><is><t>title</t></is></c><c r="B1" t="inlineStr"><is><t>title</t></is></c><c r="C1" s="1"/><c r="D1"><v>7</v></c></row>"#,
            // An ISO date cell, and a text cell that holds nothing.
            r#"<row r="2"><c r="A2" s="4" t="d"><v>2010-01-11</v></c><c r="B2" t="inlineStr"><is><t></t></is></c><c r="C2"><f>B1&amp;"!"</f><v>title!</v></c></row>"#,
            r#"</sheetData><mergeCells count="1"><mergeCell ref="A1:C1"/></mergeCells></worksheet>"#,
        );
        let (result, content, _, _, dir) = export(&single_sheet_entries("", sheet, vec![]));
        assert_eq!(result.cells, 5, "the empty text cell is not a value");
        assert!(
            content.contains(
                r#"<table:table-cell table:number-columns-spanned="3" office:value-type="string"><text:p>title</text:p></table:table-cell><table:covered-table-cell office:value-type="string"><text:p>title</text:p></table:covered-table-cell><table:covered-table-cell/>"#
            ),
            "{content}"
        );
        assert!(
            content.contains(r#"office:value-type="date" office:date-value="2010-01-11""#),
            "{content}"
        );
        assert!(
            content.contains(r#"<text:p>2010-01-11</text:p></table:table-cell><table:table-cell/><table:table-cell table:formula="#),
            "{content}"
        );
        // The covered value is still there for the formula that reads it.
        let round = dir.path().join("round.xlsx");
        crate::convert::convert_to_xlsx(&dir.path().join("book.ods"), &round).unwrap();
        let sheet = read_entry(&round, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains(r#"<c r="B1" t="inlineStr">"#), "{sheet}");
        assert!(sheet.contains(r#"<c r="A2" s="1"><v>40189</v></c>"#), "{sheet}");

        assert!(is_iso_date("2010-01-11T09:30:00"));
        assert!(is_iso_date("2010-01-11T09:30:00.250"));
        assert!(!is_iso_date("2010-01-11T09:30:00Z"));
        assert!(!is_iso_date("2010-1-11"));
        assert!(!is_iso_date("not a date"));
    }

    #[test]
    fn carries_validations_and_conditional_formats() {
        let styles = STYLES.replace(
            "</styleSheet>",
            r#"<dxfs count="1"><dxf><font><b/><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs></styleSheet>"#,
        );
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:B3"/><sheetData>"#,
            r#"<row r="1"><c r="A1"><v>1</v></c></row>"#,
            r#"<row r="2"><c r="A2"><v>2</v></c><c r="B2" t="inlineStr"><is><t>one</t></is></c></row>"#,
            r#"<row r="3"><c r="A3"><v>3</v></c></row>"#,
            r#"</sheetData>"#,
            r#"<conditionalFormatting sqref="A1:A3"><cfRule type="cellIs" dxfId="0" priority="2" operator="greaterThan"><formula>1</formula></cfRule><cfRule type="aboveAverage" dxfId="0" priority="1" aboveAverage="0"/></conditionalFormatting>"#,
            r#"<dataValidations count="2">"#,
            r#"<dataValidation type="list" allowBlank="1" showErrorMessage="1" errorTitle="Pick" error="one of the list" sqref="B2:B1048576"><formula1>"one,two"</formula1></dataValidation>"#,
            r#"<dataValidation type="whole" operator="between" sqref="D1 F1:G1"><formula1>1</formula1><formula2>$A$3</formula2></dataValidation>"#,
            r#"</dataValidations></worksheet>"#,
        );
        let mut entries = single_sheet_entries("", sheet, vec![]);
        for entry in &mut entries {
            if entry.0 == "xl/styles.xml" {
                entry.1 = styles.clone();
            }
        }
        let (result, content, styles, _, _dir) = export(&entries);
        assert_eq!(result.dropped.validations, 0);
        assert_eq!(result.dropped.conditional_formats, 0);
        assert!(
            content.contains(concat!(
                r#"<table:content-validations>"#,
                r#"<table:content-validation table:name="val1" table:condition="of:cell-content-is-in-list(&quot;one&quot;;&quot;two&quot;)" table:allow-empty-cell="true" table:display-list="unsorted" table:base-cell-address="Data.B2">"#,
                r#"<table:error-message table:message-type="stop" table:title="Pick" table:display="true"><text:p>one of the list</text:p></table:error-message></table:content-validation>"#,
                r#"<table:content-validation table:name="val2" table:condition="of:cell-content-is-whole-number() and cell-content-is-between(1,[.$A$3])" table:allow-empty-cell="false" table:base-cell-address="Data.D1"/>"#,
                r#"</table:content-validations><table:table "#,
            )),
            "{content}"
        );
        // Row 1: the value, then the empty cells the second validation covers.
        assert!(
            content.contains(concat!(
                r#"<text:p>1</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/>"#,
                r#"<table:table-cell table:content-validation-name="val2"/><table:table-cell/>"#,
                r#"<table:table-cell table:content-validation-name="val2" table:number-columns-repeated="2"/></table:table-row>"#,
            )),
            "{content}"
        );
        // Row 2: a cell with a value names its validation too.
        assert!(
            content.contains(r#"<table:table-cell table:content-validation-name="val1" office:value-type="string"><text:p>one</text:p>"#),
            "{content}"
        );
        // Row 3 and everything below it: the list reaches the last row.
        assert!(
            content.contains(concat!(
                r#"<text:p>3</text:p></table:table-cell><table:table-cell table:content-validation-name="val1"/></table:table-row>"#,
                r#"<table:table-row table:number-rows-repeated="1048573"><table:table-cell/><table:table-cell table:content-validation-name="val1"/></table:table-row>"#,
            )),
            "{content}"
        );
        assert!(
            content.contains(concat!(
                r#"<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="Data.A1:Data.A3">"#,
                r#"<calcext:condition calcext:apply-style-name="ConditionalStyle_1" calcext:value="below-average" calcext:base-cell-address="Data.A1"/>"#,
                r#"<calcext:condition calcext:apply-style-name="ConditionalStyle_1" calcext:value="&gt;1" calcext:base-cell-address="Data.A1"/>"#,
                r#"</calcext:conditional-format></calcext:conditional-formats></table:table>"#,
            )),
            "{content}"
        );
        assert!(
            styles.contains(r#"<style:style style:name="ConditionalStyle_1" style:family="table-cell" style:parent-style-name="Default">"#),
            "{styles}"
        );
    }

    #[test]
    fn carries_pictures_and_shapes_in_their_start_cells() {
        let marker = |tag: &str, column: usize, row: usize, column_offset: i64, row_offset: i64| {
            format!(
                "<xdr:{tag}><xdr:col>{column}</xdr:col><xdr:colOff>{column_offset}</xdr:colOff><xdr:row>{row}</xdr:row><xdr:rowOff>{row_offset}</xdr:rowOff></xdr:{tag}>"
            )
        };
        let drawing = format!(
            concat!(
                r#"<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">"#,
                // A text box that starts on a cell with a value.
                r#"<xdr:twoCellAnchor>{}{}<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="Box &amp; 1"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFF00"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></xdr:spPr><xdr:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr b="1"/><a:t>Hello</a:t></a:r></a:p></xdr:txBody></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>"#,
                // A picture below and right of everything the sheet holds.
                r#"<xdr:twoCellAnchor>{}{}<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="3" name="Picture 2" descr="a pattern"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>"#,
                // A line running up to the right.
                r#"<xdr:twoCellAnchor>{}{}<xdr:cxnSp><xdr:nvCxnSpPr><xdr:cNvPr id="4" name="Line 3"/><xdr:cNvCxnSpPr/></xdr:nvCxnSpPr><xdr:spPr><a:xfrm flipV="1"/><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="00B050"/></a:solidFill></a:ln></xdr:spPr></xdr:cxnSp><xdr:clientData/></xdr:twoCellAnchor>"#,
                r#"</xdr:wsDr>"#,
            ),
            marker("from", 0, 0, 0, 0),
            marker("to", 2, 2, 0, 0),
            marker("from", 5, 9, 95_250, 0),
            marker("to", 7, 12, 0, 0),
            marker("from", 0, 9, 0, 0),
            marker("to", 1, 10, 0, 0),
        );
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:A2"/><sheetData>"#,
            r#"<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>"#,
            r#"</sheetData><drawing r:id="rId1"/></worksheet>"#,
        );
        let entries = single_sheet_entries(
            "",
            sheet,
            vec![
                (
                    "xl/worksheets/_rels/sheet1.xml.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>"#.to_owned(),
                ),
                ("xl/drawings/drawing1.xml", drawing),
                (
                    "xl/drawings/_rels/drawing1.xml.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>"#.to_owned(),
                ),
                ("xl/media/image1.png", "not really a png".to_owned()),
            ],
        );
        let (result, content, _, _, dir) = export(&entries);
        assert_eq!(result.dropped.images, 0);
        assert_eq!(result.dropped.shapes, 0);
        // The box sits in A1 beside the value, with its end cell named. Two
        // default columns are 96 pt and two default rows 30 pt.
        assert!(
            content.contains(concat!(
                r#"<text:p>1</text:p><draw:custom-shape draw:style-name="gr3" table:end-cell-address="Data.C3" table:end-x="0.000cm" table:end-y="0.000cm" draw:z-index="0" draw:name="Box &amp; 1" svg:width="3.387cm" svg:height="1.058cm" svg:x="0.000cm" svg:y="0.000cm">"#,
                r#"<text:p text:style-name="gp1"><text:span text:style-name="gt2">Hello</text:span></text:p>"#,
                r#"<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="rectangle" draw:enhanced-path="M 0 0 L 21600 0 21600 21600 0 21600 Z N"/></draw:custom-shape></table:table-cell>"#,
            )),
            "{content}"
        );
        // Rows 3 to 9 hold nothing; row 10 is written for the line in A10 and
        // the picture in F10, four empty columns apart.
        assert!(
            content.contains(concat!(
                r#"<table:table-row table:number-rows-repeated="7"><table:table-cell/></table:table-row>"#,
                r#"<table:table-row><table:table-cell><draw:line draw:style-name="gr"#,
            )),
            "{content}"
        );
        assert!(
            content.contains(r#" draw:name="Line 3" svg:x1="0.000cm" svg:y1="0.529cm" svg:x2="1.693cm" svg:y2="0.000cm"/></table:table-cell><table:table-cell table:number-columns-repeated="4"/><table:table-cell><draw:frame "#),
            "{content}"
        );
        assert!(
            content.contains(concat!(
                r#" table:end-cell-address="Data.H13" table:end-x="0.000cm" table:end-y="0.000cm" draw:z-index="1" draw:name="Picture 2" svg:width="3.122cm" svg:height="1.587cm" svg:x="0.265cm" svg:y="0.000cm">"#,
                r#"<draw:image xlink:href="Pictures/image1.png" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad" draw:mime-type="image/png"/><svg:desc>a pattern</svg:desc></draw:frame>"#,
            )),
            "{content}"
        );
        assert!(
            content.contains(r##"<style:style style:name="gr3" style:family="graphic"><style:graphic-properties draw:stroke="solid" svg:stroke-width="1pt" svg:stroke-color="#000000" draw:fill="solid" draw:fill-color="#ffff00" draw:textarea-vertical-align="middle""##),
            "{content}"
        );
        assert_eq!(
            read_entry(&dir.path().join("book.ods"), "Pictures/image1.png"),
            "not really a png"
        );
        // Our own importer still reads the values around the drawings.
        let round = dir.path().join("round.xlsx");
        crate::convert::convert_to_xlsx(&dir.path().join("book.ods"), &round).unwrap();
        assert!(read_entry(&round, "xl/worksheets/sheet1.xml").contains(r#"<c r="A2"><v>2</v></c>"#));
    }

    #[test]
    fn carries_sparklines_dashes_and_trend_lines() {
        let chart = concat!(
            r#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:lineChart><c:grouping val="standard"/>"#,
            r#"<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>typed</c:v></c:tx><c:spPr><a:ln><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></a:ln></c:spPr>"#,
            r#"<c:trendline><c:trendlineType val="movingAvg"/><c:period val="2"/></c:trendline>"#,
            r#"<c:cat><c:strRef><c:f>Data!$A$1:$A$2</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Data!$B$1:$B$2</c:f></c:numRef></c:val></c:ser>"#,
            // A series nobody named.
            r#"<c:ser><c:idx val="1"/><c:order val="1"/><c:cat><c:strRef><c:f>Data!$A$1:$A$2</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Data!$C$1:$C$2</c:f></c:numRef></c:val></c:ser>"#,
            r#"<c:axId val="1"/><c:axId val="2"/></c:lineChart>"#,
            r#"<c:catAx><c:axId val="1"/><c:scaling/><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>"#,
            r#"<c:valAx><c:axId val="2"/><c:scaling/><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>"#,
            r#"</c:plotArea></c:chart></c:chartSpace>"#,
        );
        let drawing = concat!(
            r#"<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">"#,
            r#"<xdr:twoCellAnchor><xdr:from><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>"#,
            r#"<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="Dashed"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln w="25400"><a:solidFill><a:srgbClr val="C00000"/></a:solidFill><a:prstDash val="lgDashDotDot"/></a:ln></xdr:spPr></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>"#,
            r#"<xdr:twoCellAnchor><xdr:from><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>4</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>12</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>16</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>"#,
            r#"<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>"#,
            r#"</xdr:wsDr>"#,
        );
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:D2"/><sheetData>"#,
            r#"<row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="B1"><v>3</v></c><c r="C1"><v>-4</v></c><c r="D1"><v>5</v></c></row>"#,
            r#"<row r="2"><c r="A2" t="inlineStr"><is><t>b</t></is></c><c r="B2"><v>6</v></c><c r="C2"><v>7</v></c><c r="D2"><v>8</v></c></row>"#,
            r#"</sheetData><drawing r:id="rId1"/>"#,
            r#"<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">"#,
            r#"<x14:sparklineGroup type="column" negative="1"><x14:colorSeries rgb="FFC00000"/><x14:colorNegative rgb="FF00B050"/><x14:sparklines><x14:sparkline><xm:f>Data!B1:D1</xm:f><xm:sqref>E1</xm:sqref></x14:sparkline><x14:sparkline><xm:f>Data!B2:D2</xm:f><xm:sqref>E2</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup>"#,
            r#"</x14:sparklineGroups></ext></extLst></worksheet>"#,
        );
        let entries = single_sheet_entries(
            "",
            sheet,
            vec![
                (
                    "xl/worksheets/_rels/sheet1.xml.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>"#.to_owned(),
                ),
                ("xl/drawings/drawing1.xml", drawing.to_owned()),
                (
                    "xl/drawings/_rels/drawing1.xml.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>"#.to_owned(),
                ),
                ("xl/charts/chart1.xml", chart.to_owned()),
            ],
        );
        let (result, content, styles, _, dir) = export(&entries);
        assert_eq!(result.dropped.sparklines, 0);
        assert_eq!(result.dropped.shapes, 0);
        assert_eq!(result.dropped.charts, 0);
        // The sparklines close the sheet, one group with its two cells.
        assert!(
            content.contains(concat!(
                r##"<calcext:sparkline-groups><calcext:sparkline-group calcext:id="{00000000-0000-0000-0000-000000000000}" calcext:type="column" calcext:line-width="0.75pt" calcext:display-empty-cells-as="gap" calcext:negative="true" calcext:min-axis-type="individual" calcext:max-axis-type="individual" calcext:color-series="#c00000" calcext:color-negative="#00b050" calcext:color-axis="#000000" calcext:color-markers="#d00000" calcext:color-first="#d00000" calcext:color-last="#d00000" calcext:color-high="#d00000" calcext:color-low="#d00000">"##,
                r#"<calcext:sparklines><calcext:sparkline calcext:cell-address="Data.E1" calcext:data-range="Data.B1:Data.D1"/><calcext:sparkline calcext:cell-address="Data.E2" calcext:data-range="Data.B2:Data.D2"/></calcext:sparklines>"#,
                r#"</calcext:sparkline-group></calcext:sparkline-groups></table:table>"#,
            )),
            "{content}"
        );
        // The outline names its dash, and the dash is declared once among the
        // document's styles: one long stroke and two dots.
        assert!(
            content.contains(r##" draw:stroke="dash" draw:stroke-dash="lgDashDotDot" svg:stroke-width="2pt" svg:stroke-color="#c00000""##),
            "{content}"
        );
        assert!(
            styles.contains(r#"<draw:stroke-dash draw:name="lgDashDotDot" draw:style="rect" draw:dots1="1" draw:dots1-length="800%" draw:dots2="2" draw:dots2-length="100%" draw:distance="300%"/>"#),
            "{styles}"
        );
        // The trend line sits in its series, before the points, and a name
        // typed into the chart stays a string.
        let chart = read_entry(&dir.path().join("book.ods"), "Object 1/content.xml");
        assert!(
            chart.contains(r#"<style:chart-properties chart:regression-type="moving-average" chart:regression-period="2"/>"#),
            "{chart}"
        );
        assert!(
            chart.contains(r#" loext:label-string="&quot;typed&quot;" chart:class="chart:line"><chart:regression-curve chart:style-name="ch"#),
            "{chart}"
        );
        // The second series has no name, and is not given the one a
        // spreadsheet shows for it.
        assert!(
            chart.contains(r#" chart:values-cell-range-address="Data.C1:Data.C2" chart:class="chart:line">"#),
            "{chart}"
        );
        assert!(!chart.contains("Series2"), "{chart}");
    }

    #[test]
    fn a_turned_shape_keeps_its_angle_and_an_unknown_preset_its_name() {
        // A cloud turned 30 degrees over E2:F5: two default columns are 96 pt
        // wide and four default rows 60 pt high.
        let drawing = concat!(
            r#"<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">"#,
            r#"<xdr:twoCellAnchor><xdr:from><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>"#,
            r#"<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="Cloud 1"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm rot="1800000"><a:off x="2438400" y="190500"/><a:ext cx="1219200" cy="762000"/></a:xfrm><a:prstGeom prst="cloud"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="DDEBF7"/></a:solidFill></xdr:spPr></xdr:sp><xdr:clientData/></xdr:twoCellAnchor>"#,
            r#"</xdr:wsDr>"#,
        );
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1"/><sheetData>"#,
            r#"<row r="1"><c r="A1"><v>1</v></c></row>"#,
            r#"</sheetData><drawing r:id="rId1"/></worksheet>"#,
        );
        let entries = single_sheet_entries(
            "",
            sheet,
            vec![
                (
                    "xl/worksheets/_rels/sheet1.xml.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>"#.to_owned(),
                ),
                ("xl/drawings/drawing1.xml", drawing.to_owned()),
            ],
        );
        let (result, content, _, _, dir) = export(&entries);
        assert_eq!(result.dropped.shapes, 0);
        // The frame keeps its own size and is turned around its corner, then
        // moved so its centre stays where the anchor had it. No end cell: a
        // reader would stretch the turned frame to it.
        assert!(
            content.contains(
                r#" draw:z-index="0" draw:name="Cloud 1" svg:width="3.387cm" svg:height="2.117cm" draw:transform="rotate (-0.5235987756) translate (0.756cm -0.705cm)">"#
            ),
            "{content}"
        );
        assert!(!content.contains("table:end-cell-address"), "{content}");
        // The outline is the bounding rectangle, under the preset's name.
        assert!(
            content.contains(
                r#"<draw:enhanced-geometry svg:viewBox="0 0 21600 21600" draw:type="ooxml-cloud" draw:enhanced-path="M 0 0 L 21600 0 21600 21600 0 21600 Z N"/>"#
            ),
            "{content}"
        );
        // Read back, it is a cloud turned 30 degrees again.
        let round = dir.path().join("round.xlsx");
        crate::convert::convert_to_xlsx(&dir.path().join("book.ods"), &round).unwrap();
        let back = read_entry(&round, "xl/drawings/drawing1.xml");
        assert!(back.contains(r#"<a:xfrm rot="1800000">"#), "{back}");
        assert!(back.contains(r#"<a:prstGeom prst="cloud">"#), "{back}");
    }

    #[test]
    fn carries_a_chart_with_its_ranges_titles_and_legend() {
        let chart = concat!(
            r#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>"#,
            r#"<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Sales &amp; plan</a:t></a:r></a:p></c:rich></c:tx></c:title>"#,
            r#"<c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="stacked"/>"#,
            r#"<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Data!$B$1</c:f><c:strCache><c:pt idx="0"><c:v>east</c:v></c:pt></c:strCache></c:strRef></c:tx>"#,
            r#"<c:spPr><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></c:spPr>"#,
            r#"<c:cat><c:strRef><c:f>Data!$A$2:$A$3</c:f><c:strCache><c:pt idx="0"><c:v>a</c:v></c:pt><c:pt idx="1"><c:v>b</c:v></c:pt></c:strCache></c:strRef></c:cat>"#,
            r#"<c:val><c:numRef><c:f>Data!$B$2:$B$3</c:f><c:numCache><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>4</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>"#,
            r#"<c:gapWidth val="80"/><c:axId val="1"/><c:axId val="2"/></c:barChart>"#,
            r#"<c:catAx><c:axId val="1"/><c:scaling/><c:delete val="0"/><c:axPos val="b"/><c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>Region</a:t></a:r></a:p></c:rich></c:tx></c:title><c:crossAx val="2"/></c:catAx>"#,
            r#"<c:valAx><c:axId val="2"/><c:scaling><c:max val="10"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="0.0" sourceLinked="0"/><c:crossAx val="1"/></c:valAx>"#,
            r#"</c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>"#,
        );
        let drawing = concat!(
            r#"<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">"#,
            r#"<xdr:twoCellAnchor><xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>9</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>12</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>"#,
            r#"<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>"#,
        );
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:B3"/><sheetData>"#,
            r#"<row r="1"><c r="B1" t="inlineStr"><is><t>east</t></is></c></row>"#,
            r#"<row r="2"><c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2"><v>3</v></c></row>"#,
            r#"<row r="3"><c r="A3" t="inlineStr"><is><t>b</t></is></c><c r="B3"><v>4</v></c></row>"#,
            r#"</sheetData><drawing r:id="rId1"/></worksheet>"#,
        );
        let entries = single_sheet_entries(
            "",
            sheet,
            vec![
                (
                    "xl/worksheets/_rels/sheet1.xml.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>"#.to_owned(),
                ),
                ("xl/drawings/drawing1.xml", drawing.to_owned()),
                (
                    "xl/drawings/_rels/drawing1.xml.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>"#.to_owned(),
                ),
                ("xl/charts/chart1.xml", chart.to_owned()),
            ],
        );
        let (result, content, _, _, dir) = export(&entries);
        assert_eq!(result.dropped.charts, 0);
        // The frame starts in D1, past the columns the sheet holds, and tells
        // a reader which ranges to watch.
        assert!(
            content.contains(concat!(
                r#"<text:p>east</text:p></table:table-cell><table:table-cell/><table:table-cell><draw:frame draw:style-name="gr1" table:end-cell-address="Data.J13" table:end-x="0.000cm" table:end-y="0.000cm" draw:z-index="0" draw:name="Chart 1" svg:width="10.160cm" svg:height="6.350cm" svg:x="0.000cm" svg:y="0.000cm">"#,
                r#"<draw:object draw:notify-on-update-of-ranges="Data.A2:Data.A3 Data.B2:Data.B3 Data.B1:Data.B1" xlink:href="./Object 1" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>"#,
            )),
            "{content}"
        );
        let chart = read_entry(&dir.path().join("book.ods"), "Object 1/content.xml");
        roxmltree::Document::parse(&chart).unwrap_or_else(|error| panic!("{error}: {chart}"));
        assert!(
            chart.contains(r#"<chart:chart svg:width="10.160cm" svg:height="6.350cm" xlink:href=".." xlink:type="simple" chart:class="chart:bar""#),
            "{chart}"
        );
        assert!(chart.contains("<text:p>Sales &amp; plan</text:p>"), "{chart}");
        assert!(chart.contains(r#"<chart:legend chart:legend-position="bottom""#), "{chart}");
        assert!(chart.contains(r#"chart:stacked="true""#), "{chart}");
        assert!(
            chart.contains(r#"<text:p>Region</text:p></chart:title><chart:categories table:cell-range-address="Data.A2:Data.A3"/>"#),
            "{chart}"
        );
        // The value axis keeps its bounds, its own number format and its grid.
        assert!(
            chart.contains(r#"chart:minimum="0" chart:maximum="10" chart:gap-width="80" chart:overlap="100" chart:link-data-style-to-source="false""#),
            "{chart}"
        );
        assert!(chart.contains(r#"chart:class="major"/>"#), "{chart}");
        // The series is named after B1. The chart saved a copy of the name,
        // and the cell is still what the series points at.
        assert!(
            chart.contains(r#"chart:values-cell-range-address="Data.B2:Data.B3" chart:label-cell-address="Data.B1:Data.B1" chart:class="chart:bar"><chart:data-point chart:repeated="2"/>"#),
            "{chart}"
        );
        assert!(chart.contains(r##"draw:fill="solid" draw:fill-color="#4472c4""##), "{chart}");
        // The values as they were, for a reader that cannot reach the cells.
        assert!(
            chart.contains(r#"<table:table-cell office:value-type="string"><text:p>a</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell>"#),
            "{chart}"
        );
    }

    #[test]
    fn carries_a_pivot_table_that_reads_a_sheet_range() {
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:E4"/><sheetData>"#,
            r#"<row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Amount</t></is></c><c r="D1" t="inlineStr"><is><t>Region</t></is></c><c r="E1" t="inlineStr"><is><t>Sum</t></is></c></row>"#,
            r#"<row r="2"><c r="A2" t="inlineStr"><is><t>East</t></is></c><c r="B2"><v>3</v></c><c r="D2" t="inlineStr"><is><t>East</t></is></c><c r="E2"><v>3</v></c></row>"#,
            r#"<row r="3"><c r="A3" t="inlineStr"><is><t>West</t></is></c><c r="B3"><v>4</v></c><c r="D3" t="inlineStr"><is><t>West</t></is></c><c r="E3"><v>4</v></c></row>"#,
            r#"<row r="4"><c r="D4" t="inlineStr"><is><t>Total</t></is></c><c r="E4"><v>7</v></c></row>"#,
            r#"</sheetData></worksheet>"#,
        );
        let entries = single_sheet_entries(
            "",
            sheet,
            vec![
                (
                    "xl/worksheets/_rels/sheet1.xml.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/></Relationships>"#.to_owned(),
                ),
                (
                    "xl/pivotTables/pivotTable1.xml",
                    concat!(
                        r#"<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="By region" cacheId="1">"#,
                        r#"<location ref="D1:E4" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>"#,
                        r#"<pivotFields count="2"><pivotField axis="axisRow" defaultSubtotal="0"/><pivotField dataField="1"/></pivotFields>"#,
                        r#"<rowFields count="1"><field x="0"/></rowFields><dataFields count="1"><dataField name="Sum" fld="1"/></dataFields>"#,
                        r#"</pivotTableDefinition>"#,
                    )
                    .to_owned(),
                ),
                (
                    "xl/pivotTables/_rels/pivotTable1.xml.rels",
                    r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition" Target="../pivotCache/pivotCacheDefinition1.xml"/></Relationships>"#.to_owned(),
                ),
                (
                    "xl/pivotCache/pivotCacheDefinition1.xml",
                    concat!(
                        r#"<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cacheSource type="worksheet"><worksheetSource ref="A1:B3" sheet="Data"/></cacheSource>"#,
                        r#"<cacheFields count="2"><cacheField name="Region"><sharedItems><s v="East"/><s v="West"/></sharedItems></cacheField><cacheField name="Amount"><sharedItems containsNumber="1"/></cacheField></cacheFields></pivotCacheDefinition>"#,
                    )
                    .to_owned(),
                ),
            ],
        );
        let (result, content, _, _, _dir) = export(&entries);
        assert_eq!(result.dropped.pivots, 0);
        // The cells it fills are ordinary cells; the table behind them comes
        // after the sheets.
        assert!(content.contains(r#"office:value="7""#), "{content}");
        assert!(
            content.contains(concat!(
                r#"</table:table><table:data-pilot-tables>"#,
                r#"<table:data-pilot-table table:name="By region" table:application-data="" table:target-range-address="Data.D1:Data.E4" table:buttons="Data.D1" table:show-filter-button="false">"#,
                r#"<table:source-cell-range table:cell-range-address="Data.A1:Data.B3"/>"#,
                // A field that says nothing about its form has the compact
                // one, and the value keeps the caption it was given.
                r#"<table:data-pilot-field table:source-field-name="Region" table:orientation="row" table:used-hierarchy="-1" table:function="auto"><table:data-pilot-level><table:data-pilot-layout-info table:add-empty-lines="false" table:layout-mode="tabular-layout" loext:layout-mode="compact-layout"/></table:data-pilot-level></table:data-pilot-field>"#,
                r#"<table:data-pilot-field table:source-field-name="Amount" tableooo:display-name="Sum" table:orientation="data" table:used-hierarchy="-1" table:function="sum"><table:data-pilot-level/></table:data-pilot-field>"#,
                r#"</table:data-pilot-table></table:data-pilot-tables>"#,
            )),
            "{content}"
        );
    }

    #[test]
    fn a_merged_area_keeps_its_far_borders_and_a_number_keeps_its_link() {
        let styles = STYLES
            .replace(
                r#"<borders count="2">"#,
                r#"<borders count="4">"#,
            )
            .replace(
                "</borders>",
                r#"<border><left/><right style="thick"><color rgb="FFFF0000"/></right><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="medium"><color rgb="FF0000FF"/></bottom><diagonal/></border></borders>"#,
            )
            .replace(
                r#"<cellXfs count="7">"#,
                r#"<cellXfs count="9">"#,
            )
            .replace(
                "</cellXfs>",
                r#"<xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="3" xfId="0" applyBorder="1"/></cellXfs>"#,
            );
        let sheet = concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            r#"<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:D3"/><sheetData>"#,
            // A1:C2 is merged; the right edge sits on C1 and the bottom edge
            // on A2, as Excel writes them.
            r#"<row r="1"><c r="A1" t="inlineStr"><is><t>box</t></is></c><c r="B1"/><c r="C1" s="7"/><c r="D1"><v>42</v></c></row>"#,
            r#"<row r="2"><c r="A2" s="8"/><c r="B2" s="8"/><c r="C2" s="7"/></row>"#,
            r#"</sheetData><mergeCells count="1"><mergeCell ref="A1:C2"/></mergeCells>"#,
            r#"<hyperlinks><hyperlink ref="D1" r:id="rId1"/></hyperlinks></worksheet>"#,
        );
        let mut entries = single_sheet_entries(
            "",
            sheet,
            vec![(
                "xl/worksheets/_rels/sheet1.xml.rels",
                r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/n" TargetMode="External"/></Relationships>"#.to_owned(),
            )],
        );
        for entry in &mut entries {
            if entry.0 == "xl/styles.xml" {
                entry.1 = styles.clone();
            }
        }
        let (_, content, _, _, _dir) = export(&entries);
        // The first cell of the merged area carries both far edges.
        let anchor = content
            .split(r#"<table:table-cell table:style-name=""#)
            .nth(1)
            .and_then(|rest| rest.split('"').next())
            .unwrap_or_else(|| panic!("{content}"))
            .to_owned();
        assert!(
            content.contains(&format!(
                r#"<table:table-cell table:style-name="{anchor}" table:number-columns-spanned="3" table:number-rows-spanned="2" office:value-type="string"><text:p>box</text:p>"#
            )),
            "{content}"
        );
        let style = content
            .split(&format!(r#"<style:style style:name="{anchor}""#))
            .nth(1)
            .and_then(|rest| rest.split("</style:style>").next())
            .unwrap_or_else(|| panic!("{content}"));
        assert!(style.contains("fo:border-right=") && style.contains("#FF0000"), "{style}");
        assert!(style.contains("fo:border-bottom=") && style.contains("#0000FF"), "{style}");
        // The number shows as a link and is still a number.
        assert!(
            content.contains(r#"office:value-type="float" office:value="42"><text:p><text:a xlink:type="simple" xlink:href="https://example.com/n">42</text:a></text:p></table:table-cell>"#),
            "{content}"
        );
    }
}
