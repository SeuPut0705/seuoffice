//! One imported `.ods` sheet as the pieces of a worksheet part: column and
//! row attributes, the styles of cells that hold nothing, the sheet's window,
//! protection, filter, links, notes, print setup and breaks.
//!
//! `odf_sheet_format` says what the document holds; this module says it in
//! OOXML. Repeats are kept from turning into a grid's worth of elements: a
//! style that runs down the sheet's empty tail becomes a column style, a
//! style that runs across a whole row becomes a row style, and only what is
//! left over is written cell by cell.

use std::collections::{BTreeSet, HashMap};

use crate::odf_cell_styles::{ValueKind, XlsxStyles};
use crate::odf_formula::Names;
use crate::odf_layout::OdsSheetLayout;
use crate::odf_rules;
use crate::odf_sheet_format::{
    DatabaseRange, FilterCondition, MAX_COLUMN, MAX_ROW, OdsFormats, OdsSheetFormat,
    SparklineGroup, parse_cell_address, parse_range_address, split_addresses,
};
use crate::xlsx_package::{PartRelationship, SheetExtras, cell_reference, escape_xml};

/// How many rows one repeated row may stand for before it is read as the
/// sheet's empty tail instead of a set of rows to write.
const MAX_REPEATED_ROWS: u32 = 4_096;
/// Cells that exist only through their style, per sheet. Past this the rest
/// keep their values and lose the look of the empty cells around them.
const MAX_STYLE_ONLY_CELLS: usize = 400_000;
/// Rows that may carry attributes or a style of their own, per sheet.
const MAX_ROW_ENTRIES: usize = 300_000;
/// Cells one merge may spread its frame over.
const MAX_MERGE_CELLS: u64 = 20_000;
/// Rows a "hide everything below" sheet may have above the hidden part.
const MAX_ROWS_ABOVE_HIDDEN_TAIL: u32 = 100_000;
/// Rows a repeated row may stop short of the last one and still be the
/// sheet's tail.
const TAIL_SLACK: u32 = 4;
const MAX_LINKS: usize = 65_000;
const MAX_BREAKS: usize = 1_024;

/// Everything `convert` needs to finish one sheet.
#[derive(Default)]
pub(crate) struct OdfSheetXml {
    /// Styles of cells that hold no value.
    pub(crate) cell_styles: HashMap<(u32, u32), u16>,
    /// Styles of cells that hold a link, which win over the cell's own.
    pub(crate) link_styles: HashMap<(u32, u32), u16>,
    pub(crate) row_styles: HashMap<u32, u16>,
    /// Extra `<row>` attributes: hidden, outline level, collapsed.
    pub(crate) row_attributes: HashMap<u32, String>,
    pub(crate) cols: String,
    pub(crate) sheet_pr: String,
    pub(crate) sheet_views: String,
    /// Attributes to add to `sheetFormatPr`.
    pub(crate) sheet_format: String,
    /// `sheetProtection` and `autoFilter`, which precede the merges.
    pub(crate) before_merges: String,
    /// Everything that follows the merges, in schema order.
    pub(crate) after_merges: String,
    /// The worksheet's extension list, which closes it: the sparklines.
    pub(crate) extensions: String,
    /// `<is>` content of cells whose text has runs of its own formatting, or
    /// spacing the value reader drops.
    pub(crate) rich: HashMap<(u32, u32), String>,
    pub(crate) extras: SheetExtras,
    /// Sheet-scoped `<definedName>` elements.
    pub(crate) defined_names: String,
}

/// `'Sheet name'` with the quotes a formula needs.
fn quoted_sheet(name: &str) -> String {
    format!("'{}'", name.replace('\'', "''"))
}

fn column_letters(column: u32) -> String {
    let reference = cell_reference(0, column);
    reference.trim_end_matches('1').to_owned()
}

fn range_reference(start: (u32, u32), end: (u32, u32)) -> String {
    if start == end {
        cell_reference(start.0, start.1)
    } else {
        format!(
            "{}:{}",
            cell_reference(start.0, start.1),
            cell_reference(end.0, end.1)
        )
    }
}

fn absolute_range(start: (u32, u32), end: (u32, u32)) -> String {
    format!(
        "${}${}:${}${}",
        column_letters(start.1),
        start.0 + 1,
        column_letters(end.1),
        end.0 + 1
    )
}

/// The cell format of each column, from its default cell style or from a
/// style the sheet's empty tail carries down it.
struct ColumnFormats {
    runs: Vec<(u32, u32, u16)>,
}

impl ColumnFormats {
    fn at(&self, column: u32) -> u16 {
        let position = self.runs.partition_point(|run| run.1 < column);
        self.runs
            .get(position)
            .filter(|run| run.0 <= column)
            .map_or(0, |run| run.2)
    }

    /// Lays `xf` over `first..=last` wherever no format is set yet.
    fn fill(&mut self, first: u32, last: u32, xf: u16) {
        if xf == 0 {
            return;
        }
        let mut gaps = Vec::new();
        let mut cursor = first;
        for run in &self.runs {
            if run.1 < first {
                continue;
            }
            if run.0 > last {
                break;
            }
            if run.0 > cursor {
                gaps.push((cursor, run.0 - 1, xf));
            }
            cursor = run.1.saturating_add(1);
        }
        if cursor <= last {
            gaps.push((cursor, last, xf));
        }
        self.runs.extend(gaps);
        self.runs.sort_unstable_by_key(|run| run.0);
    }
}

/// Builds the worksheet pieces of sheet `index`. `used` is the last row and
/// column that hold a value, which bounds how far a style that runs to the
/// edge of the grid is written out.
/// `#rrggbb` as the `FFRRGGBB` a sparkline colour is written with.
fn sparkline_color(value: Option<&str>, default: &str) -> String {
    let hex = value
        .map(|value| value.trim().trim_start_matches('#'))
        .filter(|hex| hex.len() == 6 && hex.chars().all(|character| character.is_ascii_hexdigit()))
        .unwrap_or(default);
    format!("FF{}", hex.to_ascii_uppercase())
}

/// The sparklines of a sheet as the worksheet extension Excel keeps them in.
/// The element and the order of its parts are the ones Excel writes; a
/// sparkline whose cell or range cannot be named is left out, and so is a
/// group left without any.
fn sparklines_xml(groups: &[SparklineGroup]) -> String {
    let mut out = String::new();
    for group in groups {
        let get = |name: &str| {
            group
                .attributes
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };
        let flag = |name: &str| get(name) == Some("true");
        let mut cells = String::new();
        for (cell, range) in &group.cells {
            let Some((_, (row, column))) = parse_cell_address(cell) else {
                continue;
            };
            let Some(formula) = crate::odf_formula::excel_range(range) else {
                continue;
            };
            cells.push_str(&format!(
                "<x14:sparkline><xm:f>{}</xm:f><xm:sqref>{}</xm:sqref></x14:sparkline>",
                escape_xml(&formula),
                cell_reference(row, column)
            ));
        }
        if cells.is_empty() {
            continue;
        }
        let mut attributes = String::new();
        // A line is what a group is when it says nothing.
        match get("type") {
            Some("column") => attributes.push_str(r#" type="column""#),
            Some("stacked") => attributes.push_str(r#" type="stacked""#),
            _ => {}
        }
        if let Some(points) = get("line-width")
            .and_then(crate::odf_layout::length_points)
            .filter(|points| *points > 0.0 && (points - 0.75).abs() > 0.01)
        {
            attributes.push_str(&format!(r#" lineWeight="{points}""#));
        }
        attributes.push_str(match get("display-empty-cells-as") {
            Some("zero") => r#" displayEmptyCellsAs="zero""#,
            Some("span") => r#" displayEmptyCellsAs="span""#,
            _ => r#" displayEmptyCellsAs="gap""#,
        });
        for (name, attribute) in [
            ("markers", "markers"),
            ("high", "high"),
            ("low", "low"),
            ("first", "first"),
            ("last", "last"),
            ("negative", "negative"),
            ("display-x-axis", "displayXAxis"),
            ("display-hidden", "displayHidden"),
            ("right-to-left", "rightToLeft"),
        ] {
            if flag(name) {
                attributes.push_str(&format!(r#" {attribute}="1""#));
            }
        }
        // Every colour is stated; the ones the document leaves out are the
        // ones Excel gives a new sparkline.
        let colors: String = [
            ("colorSeries", "color-series", "376092"),
            ("colorNegative", "color-negative", "D00000"),
            ("colorAxis", "color-axis", "000000"),
            ("colorMarkers", "color-markers", "D00000"),
            ("colorFirst", "color-first", "D00000"),
            ("colorLast", "color-last", "D00000"),
            ("colorHigh", "color-high", "D00000"),
            ("colorLow", "color-low", "D00000"),
        ]
        .iter()
        .map(|(element, name, default)| {
            format!(r#"<x14:{element} rgb="{}"/>"#, sparkline_color(get(name), default))
        })
        .collect();
        out.push_str(&format!(
            "<x14:sparklineGroup{attributes}>{colors}<x14:sparklines>{cells}</x14:sparklines></x14:sparklineGroup>"
        ));
    }
    if out.is_empty() {
        return out;
    }
    format!(
        r#"<extLst><ext xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" uri="{{05C60535-1F16-4fd2-B633-F4F36F0B64E0}}"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">{out}</x14:sparklineGroups></ext></extLst>"#
    )
}

pub(crate) fn build(
    index: usize,
    formats: &OdsFormats,
    layout: Option<&OdsSheetLayout>,
    xlsx: &mut XlsxStyles,
    used: Option<(u32, u32)>,
    names: &Names,
) -> OdfSheetXml {
    let mut out = OdfSheetXml::default();
    let Some(sheet) = formats.sheets.get(index) else {
        return out;
    };
    let book = &formats.book;
    let style_xf = |xlsx: &mut XlsxStyles, id: Option<u32>| -> u16 {
        xlsx.cell(book, id.and_then(|id| formats.name(id)), ValueKind::Plain)
    };

    let mut columns = ColumnFormats {
        runs: sheet
            .columns
            .iter()
            .filter_map(|run| {
                let xf = style_xf(xlsx, Some(run.default_cell?));
                (xf != 0).then_some((run.first, run.last, xf))
            })
            .collect(),
    };
    // A style the empty tail of the sheet repeats down to the last row is the
    // column's own look. Some writers end the sheet with one more row after
    // the repeated one, so the run may stop a line or two short of the edge.
    let reaches_end = |last: u32| last + TAIL_SLACK >= MAX_ROW - 1;
    for run in &sheet.rows {
        if reaches_end(run.last) && run.last - run.first >= MAX_REPEATED_ROWS {
            for cell in &run.cells {
                let xf = style_xf(xlsx, Some(cell.style));
                columns.fill(cell.first, cell.last, xf);
            }
        }
    }

    let used_columns = used.map_or(0, |used| used.1);
    let mut zero_height = false;
    let mut max_row_level = 0u8;
    for run in &sheet.rows {
        let tall = run.last - run.first >= MAX_REPEATED_ROWS;
        max_row_level = max_row_level.max(run.level);
        if tall {
            if run.hidden && reaches_end(run.last) && run.first <= MAX_ROWS_ABOVE_HIDDEN_TAIL {
                // "Hide everything below": the rows above are written out
                // and the sheet's default row is the hidden one.
                zero_height = true;
                for row in 0..run.first {
                    out.row_attributes.entry(row).or_default();
                }
            }
            continue;
        }
        let row_xf = run.default_cell.map(|id| style_xf(xlsx, Some(id)));
        let mut attributes = String::new();
        if run.hidden {
            attributes.push_str(r#" hidden="1""#);
        }
        if run.level > 0 {
            attributes.push_str(&format!(r#" outlineLevel="{}""#, run.level));
        }
        // A run that covers the whole row is the row's own style.
        let whole_row = run
            .cells
            .iter()
            .find(|cell| cell.first == 0 && cell.last >= MAX_COLUMN - 1)
            .map(|cell| style_xf(xlsx, Some(cell.style)));
        let row_xf = row_xf.or(whole_row);
        for row in run.first..=run.last {
            if let Some(xf) = row_xf.filter(|xf| *xf != 0) {
                if out.row_styles.len() < MAX_ROW_ENTRIES {
                    out.row_styles.insert(row, xf);
                }
            }
            if !attributes.is_empty() && out.row_attributes.len() < MAX_ROW_ENTRIES {
                out.row_attributes.insert(row, attributes.clone());
            }
        }
        for cell in &run.cells {
            if whole_row.is_some() && cell.first == 0 && cell.last >= MAX_COLUMN - 1 {
                continue;
            }
            let xf = style_xf(xlsx, Some(cell.style));
            // A run to the edge of the grid is written as far as the sheet
            // has values; past that there is nothing for it to frame.
            let last = if cell.last >= MAX_COLUMN - 1 {
                if cell.first > used_columns {
                    continue;
                }
                used_columns
            } else {
                cell.last
            };
            for column in cell.first..=last {
                let inherited = row_xf.unwrap_or_else(|| columns.at(column));
                if xf == inherited {
                    continue;
                }
                for row in run.first..=run.last {
                    if out.cell_styles.len() >= MAX_STYLE_ONLY_CELLS {
                        break;
                    }
                    out.cell_styles.insert((row, column), xf);
                }
            }
        }
    }
    // A merged cell's frame and fill, said once on its first cell, go onto
    // the cells the merge covers, each with the edges of its position.
    for (start, end) in layout.map_or(&[][..], |layout| layout.merges.as_slice()) {
        let Some(name) = sheet
            .own_cell_style(start.0, start.1)
            .and_then(|id| formats.name(id))
        else {
            continue;
        };
        let cells = u64::from(end.0 - start.0 + 1) * u64::from(end.1 - start.1 + 1);
        if cells > MAX_MERGE_CELLS {
            continue;
        }
        for row in start.0..=end.0 {
            for column in start.1..=end.1 {
                if (row, column) == *start || sheet.own_cell_style(row, column).is_some() {
                    continue;
                }
                let keep = [row == start.0, row == end.0, column == start.1, column == end.1];
                match xlsx.covered_cell(book, name, keep) {
                    Some(xf) if out.cell_styles.len() < MAX_STYLE_ONLY_CELLS => {
                        out.cell_styles.insert((row, column), xf);
                    }
                    _ => {}
                }
            }
        }
    }
    for row in &sheet.collapsed_rows {
        if *row < MAX_ROW {
            out.row_attributes
                .entry(*row)
                .or_default()
                .push_str(r#" collapsed="1""#);
        }
    }

    // The width the document gives the columns out to the edge of the grid
    // is the sheet's default width, not a size set on sixteen thousand
    // columns.
    let default_width = layout.and_then(|layout| {
        layout
            .columns
            .iter()
            .max_by_key(|(_, last, _)| *last)
            .filter(|(first, last, _)| *last >= 1023 && last - first >= 255)
            .map(|(_, _, width)| *width)
    });
    if let Some(width) = default_width {
        out.sheet_format
            .push_str(&format!(r#" defaultColWidth="{width:.2}""#));
    }
    out.cols = cols_xml(sheet, layout, &columns, default_width);
    let max_column_level = sheet.columns.iter().map(|run| run.level).max().unwrap_or(0);
    if max_row_level > 0 {
        out.sheet_format
            .push_str(&format!(r#" outlineLevelRow="{max_row_level}""#));
    }
    if max_column_level > 0 {
        out.sheet_format
            .push_str(&format!(r#" outlineLevelCol="{max_column_level}""#));
    }
    if zero_height {
        out.sheet_format.push_str(r#" zeroHeight="1""#);
    }

    let table_style = sheet.style.as_deref().and_then(|name| book.tables.get(name));
    let page = formats
        .pages
        .page_xml(table_style.and_then(|style| style.master_page.as_deref()));

    // sheetPr: tab colour, then the fit-to-page flag.
    let mut sheet_pr = String::new();
    if let Some(color) = table_style.and_then(|style| style.tab_color.as_deref()) {
        sheet_pr.push_str(&format!(r#"<tabColor rgb="FF{color}"/>"#));
    }
    if page.as_ref().is_some_and(|page| page.fit_to_page) {
        sheet_pr.push_str(r#"<pageSetUpPr fitToPage="1"/>"#);
    }
    if !sheet_pr.is_empty() {
        out.sheet_pr = format!("<sheetPr>{sheet_pr}</sheetPr>");
    }

    out.sheet_views = sheet_views_xml(
        sheet,
        formats,
        table_style.is_some_and(|style| style.right_to_left),
    );

    if sheet.protected {
        out.before_merges
            .push_str(r#"<sheetProtection sheet="1" objects="1" scenarios="1"/>"#);
    }
    let filter = formats
        .ranges
        .iter()
        .filter(|range| range.buttons || range.has_filter)
        .filter_map(|range| {
            let (name, start, end) = parse_range_address(&range.target)?;
            (name.as_deref() == Some(sheet.name.as_str())).then_some((range, start, end))
        })
        // The sheet's own filter comes first when a named range has buttons
        // as well; a worksheet holds one.
        .min_by_key(|(range, _, _)| !range.name.starts_with("__Anonymous_Sheet_DB__"));
    if let Some((range, start, end)) = filter {
        out.before_merges.push_str(&auto_filter_xml(range, start, end));
        out.defined_names.push_str(&format!(
            r#"<definedName name="_xlnm._FilterDatabase" localSheetId="{index}" hidden="1">{}!{}</definedName>"#,
            escape_xml(&quoted_sheet(&sheet.name)),
            absolute_range(start, end),
        ));
    }

    out.extensions = sparklines_xml(&sheet.sparklines);
    out.after_merges
        .push_str(&odf_rules::conditional_formatting_xml(sheet, formats, xlsx, names));
    out.after_merges
        .push_str(&odf_rules::data_validations_xml(sheet, formats, names));

    // Links: the relationship carries an outside target, the element an
    // inside one.
    let mut links = String::new();
    let mut targets: HashMap<&str, String> = HashMap::new();
    for ((row, column), href) in sheet.links.iter().take(MAX_LINKS) {
        let reference = cell_reference(*row, *column);
        let style = sheet.cell_style(*row, *column).and_then(|id| formats.name(id));
        if let Some(xf) = xlsx.linked_cell(book, style) {
            out.link_styles.insert((*row, *column), xf);
        }
        if let Some(location) = href.strip_prefix('#') {
            links.push_str(&format!(
                r#"<hyperlink ref="{reference}" location="{}"/>"#,
                escape_xml(&internal_location(location)),
            ));
            continue;
        }
        let next = format!("rIdL{}", targets.len() + 1);
        let id = targets.entry(href.as_str()).or_insert_with(|| {
            out.extras.relationships.push(PartRelationship {
                id: next.clone(),
                kind: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
                target: href.clone(),
                external: true,
            });
            next
        });
        links.push_str(&format!(r#"<hyperlink ref="{reference}" r:id="{id}"/>"#));
    }
    if !links.is_empty() {
        out.after_merges
            .push_str(&format!("<hyperlinks>{links}</hyperlinks>"));
    }

    if let Some(page) = &page {
        out.after_merges.push_str(&page.tail);
    }
    out.after_merges.push_str(&breaks_xml(sheet, formats));

    // Print area and repeated rows and columns are names scoped to the sheet.
    let sheet_name = quoted_sheet(&sheet.name);
    if let Some(ranges) = &sheet.print_ranges {
        let areas: Vec<String> = split_addresses(ranges)
            .into_iter()
            .filter_map(parse_range_address)
            .map(|(_, start, end)| format!("{sheet_name}!{}", absolute_range(start, end)))
            .collect();
        if !areas.is_empty() {
            out.defined_names.push_str(&format!(
                r#"<definedName name="_xlnm.Print_Area" localSheetId="{index}">{}</definedName>"#,
                escape_xml(&areas.join(",")),
            ));
        }
    }
    let mut titles = Vec::new();
    if let Some((first, last)) = sheet.header_columns {
        titles.push(format!(
            "{sheet_name}!${}:${}",
            column_letters(first),
            column_letters(last)
        ));
    }
    if let Some((first, last)) = sheet.header_rows {
        titles.push(format!("{sheet_name}!${}:${}", first + 1, last + 1));
    }
    if !titles.is_empty() {
        out.defined_names.push_str(&format!(
            r#"<definedName name="_xlnm.Print_Titles" localSheetId="{index}">{}</definedName>"#,
            escape_xml(&titles.join(",")),
        ));
    }

    if !sheet.notes.is_empty() {
        let number = index + 1;
        out.extras.parts.push((
            format!("xl/comments{number}.xml"),
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"),
            comments_xml(sheet).into_bytes(),
        ));
        out.extras.parts.push((
            format!("xl/drawings/vmlDrawing{number}.vml"),
            None,
            notes_vml(sheet).into_bytes(),
        ));
        out.extras.relationships.push(PartRelationship {
            id: "rIdC1".to_owned(),
            kind: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments",
            target: format!("../comments{number}.xml"),
            external: false,
        });
        out.extras.relationships.push(PartRelationship {
            id: "rIdV1".to_owned(),
            kind: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/vmlDrawing",
            target: format!("../drawings/vmlDrawing{number}.vml"),
            external: false,
        });
        out.extras.legacy_drawing = Some("rIdV1".to_owned());
    }

    for (position, runs) in &sheet.rich {
        let mut xml = String::new();
        if runs.iter().all(|(style, _)| style.is_none()) {
            // Text kept only for its spaces, tabs or line breaks.
            let text: String = runs.iter().map(|(_, text)| text.as_str()).collect();
            out.rich.insert(
                *position,
                format!(r#"<t xml:space="preserve">{}</t>"#, escape_xml(&text)),
            );
            continue;
        }
        for (style, text) in runs {
            let properties = style
                .and_then(|id| formats.name(id))
                .and_then(|name| book.text.get(name))
                .map(|font| font.xml(true))
                .unwrap_or_default();
            let properties = if properties.is_empty() {
                String::new()
            } else {
                format!("<rPr>{properties}</rPr>")
            };
            xml.push_str(&format!(
                r#"<r>{properties}<t xml:space="preserve">{}</t></r>"#,
                escape_xml(text)
            ));
        }
        out.rich.insert(*position, xml);
    }
    out
}

/// `Sheet1.A1` (the part of an in-document link after `#`) as Excel's
/// `Sheet1!A1`. A target this cannot read is passed on as written.
fn internal_location(location: &str) -> String {
    let convert = |(sheet, cell): (Option<String>, (u32, u32))| {
        let reference = cell_reference(cell.0, cell.1);
        match sheet {
            Some(sheet) => format!("{}!{reference}", quoted_sheet(&sheet)),
            None => reference,
        }
    };
    match parse_range_address(location) {
        Some((sheet, start, end)) if start != end => {
            let reference = range_reference(start, end);
            match sheet {
                Some(sheet) => format!("{}!{reference}", quoted_sheet(&sheet)),
                None => reference,
            }
        }
        _ => parse_cell_address(location)
            .map(convert)
            .unwrap_or_else(|| location.to_owned()),
    }
}

/// `<cols>`: widths from the layout, and style, visibility and outline from
/// the format, cut wherever any of them changes.
fn cols_xml(
    sheet: &OdsSheetFormat,
    layout: Option<&OdsSheetLayout>,
    formats: &ColumnFormats,
    default_width: Option<f64>,
) -> String {
    let mut cuts: BTreeSet<u32> = BTreeSet::new();
    let mut cut = |first: u32, last: u32| {
        cuts.insert(first);
        cuts.insert(last.saturating_add(1).min(MAX_COLUMN));
    };
    let widths: &[(u32, u32, f64)] = layout.map_or(&[], |layout| layout.columns.as_slice());
    for (first, last, _) in widths {
        cut(*first, *last);
    }
    for run in &sheet.columns {
        cut(run.first, run.last);
    }
    for run in &formats.runs {
        cut(run.0, run.1);
    }
    for column in &sheet.collapsed_columns {
        if *column < MAX_COLUMN {
            cut(*column, *column);
        }
    }
    let width_at = |column: u32| {
        widths
            .iter()
            .find(|(first, last, _)| (*first..=*last).contains(&column))
            .map(|(_, _, width)| *width)
    };
    let mut entries: Vec<(u32, u32, String)> = Vec::new();
    let cuts: Vec<u32> = cuts.into_iter().collect();
    for pair in cuts.windows(2) {
        let (first, last) = (pair[0], pair[1] - 1);
        if first >= MAX_COLUMN {
            break;
        }
        let mut attributes = String::new();
        let width = width_at(first)
            .filter(|width| default_width.is_none_or(|default| (width - default).abs() > 0.005));
        let run = sheet.column(first);
        let xf = formats.at(first);
        let hidden = run.is_some_and(|run| run.hidden);
        let level = run.map_or(0, |run| run.level);
        let collapsed = sheet.collapsed_columns.contains(&first);
        if width.is_none() && xf == 0 && !hidden && level == 0 && !collapsed {
            continue;
        }
        match width {
            Some(width) => attributes.push_str(&format!(r#" width="{width:.2}" customWidth="1""#)),
            // The element needs a width: the sheet's default one, or the
            // one Excel gives a column nobody has sized.
            None => attributes.push_str(&format!(
                r#" width="{:.2}""#,
                default_width.unwrap_or(8.43)
            )),
        }
        if xf != 0 {
            attributes.push_str(&format!(r#" style="{xf}""#));
        }
        if hidden {
            attributes.push_str(r#" hidden="1""#);
        }
        if level > 0 {
            attributes.push_str(&format!(r#" outlineLevel="{level}""#));
        }
        if collapsed {
            attributes.push_str(r#" collapsed="1""#);
        }
        match entries.last_mut() {
            Some(previous) if previous.2 == attributes && previous.1 + 1 == first => {
                previous.1 = last;
            }
            _ => entries.push((first, last, attributes)),
        }
    }
    if entries.is_empty() {
        return String::new();
    }
    let body: String = entries
        .iter()
        .map(|(first, last, attributes)| {
            format!(r#"<col min="{}" max="{}"{attributes}/>"#, first + 1, last + 1)
        })
        .collect();
    format!("<cols>{body}</cols>")
}

/// `<sheetViews>` from what `settings.xml` remembers, or nothing when the
/// window is the default one.
fn sheet_views_xml(sheet: &OdsSheetFormat, formats: &OdsFormats, right_to_left: bool) -> String {
    let views = &formats.views;
    let view = views.sheets.get(&sheet.name);
    let mut attributes = String::new();
    let grid = view.and_then(|view| view.grid).or(views.grid);
    if grid == Some(false) {
        attributes.push_str(r#" showGridLines="0""#);
    }
    if views.headers == Some(false) {
        attributes.push_str(r#" showRowColHeaders="0""#);
    }
    if right_to_left {
        attributes.push_str(r#" rightToLeft="1""#);
    }
    if views.active.as_deref() == Some(sheet.name.as_str()) {
        attributes.push_str(r#" tabSelected="1""#);
    }
    if let Some(zoom) = view.and_then(|view| view.zoom).filter(|zoom| *zoom != 100) {
        attributes.push_str(&format!(r#" zoomScale="{zoom}""#));
    }
    let mut pane = String::new();
    if let Some(view) = view {
        let columns = view.frozen_columns.saturating_sub(view.left).min(MAX_COLUMN - 1);
        let rows = view.frozen_rows.saturating_sub(view.top).min(MAX_ROW - 1);
        if columns > 0 || rows > 0 {
            if view.left > 0 || view.top > 0 {
                attributes.push_str(&format!(
                    r#" topLeftCell="{}""#,
                    cell_reference(view.top.min(MAX_ROW - 1), view.left.min(MAX_COLUMN - 1))
                ));
            }
            // The scrollable pane starts no earlier than the frozen edge.
            let first_column = if columns > 0 {
                view.scrolled_column
                    .unwrap_or(0)
                    .max(view.frozen_columns)
                    .min(MAX_COLUMN - 1)
            } else {
                view.left
            };
            let first_row = if rows > 0 {
                view.scrolled_row
                    .unwrap_or(0)
                    .max(view.frozen_rows)
                    .min(MAX_ROW - 1)
            } else {
                view.top
            };
            let active = match (columns > 0, rows > 0) {
                (true, true) => "bottomRight",
                (true, false) => "topRight",
                _ => "bottomLeft",
            };
            let mut split = String::new();
            if columns > 0 {
                split.push_str(&format!(r#" xSplit="{columns}""#));
            }
            if rows > 0 {
                split.push_str(&format!(r#" ySplit="{rows}""#));
            }
            pane = format!(
                r#"<pane{split} topLeftCell="{}" activePane="{active}" state="frozen"/><selection pane="{active}"/>"#,
                cell_reference(first_row, first_column)
            );
        }
    }
    if attributes.is_empty() && pane.is_empty() {
        return String::new();
    }
    format!(r#"<sheetViews><sheetView{attributes} workbookViewId="0">{pane}</sheetView></sheetViews>"#)
}

/// The filter of a sheet with the criteria Excel has a spelling for. A
/// column whose criteria have none keeps its button and loses the criteria;
/// the rows the filter hid stay hidden either way.
fn auto_filter_xml(range: &DatabaseRange, start: (u32, u32), end: (u32, u32)) -> String {
    let reference = range_reference(start, end);
    let mut fields: Vec<u32> = range.conditions.iter().map(|condition| condition.field).collect();
    fields.sort_unstable();
    fields.dedup();
    let mut columns = String::new();
    for field in fields {
        let conditions: Vec<&FilterCondition> = range
            .conditions
            .iter()
            .filter(|condition| condition.field == field)
            .collect();
        if let Some(criteria) = filter_column_xml(&conditions) {
            columns.push_str(&format!(r#"<filterColumn colId="{field}">{criteria}</filterColumn>"#));
        }
    }
    if columns.is_empty() {
        format!(r#"<autoFilter ref="{reference}"/>"#)
    } else {
        format!(r#"<autoFilter ref="{reference}">{columns}</autoFilter>"#)
    }
}

fn filter_column_xml(conditions: &[&FilterCondition]) -> Option<String> {
    let first = conditions.first()?;
    if conditions.len() == 1 {
        let condition = first;
        match condition.operator.as_str() {
            "=" if !condition.items.is_empty() => {
                let blank = condition.items.iter().any(String::is_empty);
                let items: String = condition
                    .items
                    .iter()
                    .filter(|item| !item.is_empty())
                    .map(|item| format!(r#"<filter val="{}"/>"#, escape_xml(item)))
                    .collect();
                let blank = if blank { r#" blank="1""# } else { "" };
                return Some(format!("<filters{blank}>{items}</filters>"));
            }
            "empty" => return Some(r#"<filters blank="1"/>"#.to_owned()),
            "top values" | "bottom values" | "top percent" | "bottom percent" => {
                let top = condition.operator.starts_with("top");
                let percent = condition.operator.ends_with("percent");
                let value = condition.value.trim().parse::<f64>().ok()?;
                return Some(format!(
                    r#"<top10{}{} val="{value}"/>"#,
                    if top { "" } else { r#" top="0""# },
                    if percent { r#" percent="1""# } else { "" },
                ));
            }
            _ => {}
        }
    }
    if conditions.len() > 2 {
        return None;
    }
    let mut customs = String::new();
    for condition in conditions {
        let escaped = |value: &str| value.replace('~', "~~").replace('*', "~*").replace('?', "~?");
        let (operator, value) = match condition.operator.as_str() {
            "=" => (None, condition.value.clone()),
            "!=" => (Some("notEqual"), condition.value.clone()),
            ">" => (Some("greaterThan"), condition.value.clone()),
            ">=" => (Some("greaterThanOrEqual"), condition.value.clone()),
            "<" => (Some("lessThan"), condition.value.clone()),
            "<=" => (Some("lessThanOrEqual"), condition.value.clone()),
            "!empty" => (Some("notEqual"), " ".to_owned()),
            "begins" => (None, format!("{}*", escaped(&condition.value))),
            "ends" => (None, format!("*{}", escaped(&condition.value))),
            "contains" => (None, format!("*{}*", escaped(&condition.value))),
            "!begins" => (Some("notEqual"), format!("{}*", escaped(&condition.value))),
            "!ends" => (Some("notEqual"), format!("*{}", escaped(&condition.value))),
            "!contains" => (Some("notEqual"), format!("*{}*", escaped(&condition.value))),
            _ => return None,
        };
        let operator = operator
            .map(|operator| format!(r#" operator="{operator}""#))
            .unwrap_or_default();
        customs.push_str(&format!(
            r#"<customFilter{operator} val="{}"/>"#,
            escape_xml(&value)
        ));
    }
    // Two conditions in the same `filter-or` are alternatives; anything else
    // must hold together.
    let alternatives = conditions.len() == 2
        && conditions[0].or_group.is_some()
        && conditions[0].or_group == conditions[1].or_group;
    let and = if conditions.len() == 2 && !alternatives {
        r#" and="1""#
    } else {
        ""
    };
    Some(format!("<customFilters{and}>{customs}</customFilters>"))
}

/// Manual page breaks: a row or column whose style starts a new page breaks
/// after the line before it.
fn breaks_xml(sheet: &OdsSheetFormat, formats: &OdsFormats) -> String {
    let breaks = |name: Option<u32>, table: &HashMap<String, bool>| {
        name.and_then(|id| formats.name(id))
            .is_some_and(|name| table.contains_key(name))
    };
    let mut rows: Vec<u32> = Vec::new();
    for run in &sheet.rows {
        if breaks(run.style, &formats.book.row_breaks) {
            for row in run.first..=run.last {
                if row > 0 && rows.len() < MAX_BREAKS {
                    rows.push(row);
                }
            }
        }
    }
    let mut columns: Vec<u32> = Vec::new();
    for run in &sheet.columns {
        if breaks(run.style, &formats.book.column_breaks) {
            for column in run.first..=run.last {
                if column > 0 && columns.len() < MAX_BREAKS {
                    columns.push(column);
                }
            }
        }
    }
    let mut out = String::new();
    if !rows.is_empty() {
        let items: String = rows
            .iter()
            .map(|row| format!(r#"<brk id="{row}" max="16383" man="1"/>"#))
            .collect();
        out.push_str(&format!(
            r#"<rowBreaks count="{0}" manualBreakCount="{0}">{items}</rowBreaks>"#,
            rows.len()
        ));
    }
    if !columns.is_empty() {
        let items: String = columns
            .iter()
            .map(|column| format!(r#"<brk id="{column}" max="1048575" man="1"/>"#))
            .collect();
        out.push_str(&format!(
            r#"<colBreaks count="{0}" manualBreakCount="{0}">{items}</colBreaks>"#,
            columns.len()
        ));
    }
    out
}

fn comments_xml(sheet: &OdsSheetFormat) -> String {
    let mut authors: Vec<&str> = Vec::new();
    let mut list = String::new();
    for note in &sheet.notes {
        let author = note.author.as_str();
        let author_id = match authors.iter().position(|known| *known == author) {
            Some(position) => position,
            None => {
                authors.push(author);
                authors.len() - 1
            }
        };
        list.push_str(&format!(
            r#"<comment ref="{}" authorId="{author_id}"><text><r><t xml:space="preserve">{}</t></r></text></comment>"#,
            cell_reference(note.row, note.column),
            escape_xml(&note.text),
        ));
    }
    let authors: String = authors
        .iter()
        .map(|author| format!("<author>{}</author>", escape_xml(author)))
        .collect();
    format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors>{authors}</authors><commentList>{list}</commentList></comments>"#
    )
}

/// The legacy drawing Excel needs to show a note's box: one hidden shape per
/// note, anchored beside its cell.
fn notes_vml(sheet: &OdsSheetFormat) -> String {
    let mut shapes = String::new();
    for (index, note) in sheet.notes.iter().enumerate() {
        let (row, column) = (note.row, note.column);
        shapes.push_str(&format!(
            r##"<v:shape id="_x0000_s{}" type="#_x0000_t202" style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:108pt;height:59.25pt;z-index:{};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>{}, 15, {}, 2, {}, 31, {}, 1</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>{row}</x:Row><x:Column>{column}</x:Column></x:ClientData></v:shape>"##,
            1025 + index,
            index + 1,
            column + 1,
            row,
            column + 3,
            row + 4,
        ));
    }
    format!(
        r##"<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>{shapes}</xml>"##
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::odf_sheet_format::FilterCondition;

    fn condition(field: u32, operator: &str, value: &str) -> FilterCondition {
        FilterCondition {
            field,
            operator: operator.to_owned(),
            value: value.to_owned(),
            ..FilterCondition::default()
        }
    }

    #[test]
    fn filter_criteria_take_the_spelling_excel_has() {
        let mut list = condition(0, "=", "x");
        list.items = vec!["x".to_owned(), String::new()];
        let mut low = condition(2, ">=", "5");
        let mut high = condition(2, "<", "9");
        let range = DatabaseRange {
            conditions: vec![list, low.clone(), high.clone(), condition(3, "contains", "a*b"), condition(4, "match", "x")],
            ..DatabaseRange::default()
        };
        let xml = auto_filter_xml(&range, (0, 0), (9, 4));
        assert_eq!(
            xml,
            concat!(
                r#"<autoFilter ref="A1:E10">"#,
                r#"<filterColumn colId="0"><filters blank="1"><filter val="x"/></filters></filterColumn>"#,
                r#"<filterColumn colId="2"><customFilters and="1"><customFilter operator="greaterThanOrEqual" val="5"/><customFilter operator="lessThan" val="9"/></customFilters></filterColumn>"#,
                r#"<filterColumn colId="3"><customFilters><customFilter val="*a~*b*"/></customFilters></filterColumn>"#,
                r#"</autoFilter>"#,
            )
        );
        low.or_group = Some(1);
        high.or_group = Some(1);
        let xml = filter_column_xml(&[&low, &high]).unwrap();
        assert!(xml.starts_with("<customFilters><customFilter"), "{xml}");
    }

    #[test]
    fn in_document_links_become_excel_locations() {
        assert_eq!(internal_location("Sheet1.B3"), "'Sheet1'!B3");
        assert_eq!(internal_location("'My sheet'.A1:'My sheet'.C2"), "'My sheet'!A1:C2");
        assert_eq!(internal_location("Name"), "Name");
        assert_eq!(split_addresses("S.A1:S.B2 'a b'.C1:'a b'.D2"), vec!["S.A1:S.B2", "'a b'.C1:'a b'.D2"]);
    }

    #[test]
    fn sparklines_become_the_worksheet_extension() {
        let group = |attributes: &[(&str, &str)], cells: &[(&str, &str)]| SparklineGroup {
            attributes: attributes
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
            cells: cells
                .iter()
                .map(|(cell, range)| ((*cell).to_owned(), (*range).to_owned()))
                .collect(),
        };
        let xml = sparklines_xml(&[
            group(
                &[
                    ("type", "column"),
                    ("line-width", "2.25pt"),
                    ("negative", "true"),
                    ("markers", "false"),
                    ("color-series", "#c00000"),
                    ("color-negative", "#00b050"),
                ],
                &[("Data.E1", "Data.B1:Data.D1"), ("nowhere", "Data.B2:Data.D2")],
            ),
            // A group none of whose sparklines can be placed is left out.
            group(&[("type", "line")], &[("Data.E9", "")]),
        ]);
        assert_eq!(
            xml,
            concat!(
                r#"<extLst><ext xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}"><x14:sparklineGroups xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">"#,
                r#"<x14:sparklineGroup type="column" lineWeight="2.25" displayEmptyCellsAs="gap" negative="1">"#,
                r#"<x14:colorSeries rgb="FFC00000"/><x14:colorNegative rgb="FF00B050"/><x14:colorAxis rgb="FF000000"/><x14:colorMarkers rgb="FFD00000"/><x14:colorFirst rgb="FFD00000"/><x14:colorLast rgb="FFD00000"/><x14:colorHigh rgb="FFD00000"/><x14:colorLow rgb="FFD00000"/>"#,
                r#"<x14:sparklines><x14:sparkline><xm:f>Data!B1:D1</xm:f><xm:sqref>E1</xm:sqref></x14:sparkline></x14:sparklines></x14:sparklineGroup>"#,
                r#"</x14:sparklineGroups></ext></extLst>"#,
            )
        );
        assert_eq!(sparklines_xml(&[]), "");
    }
}
