//! What an `.ods` package says about how its sheets look and are organised,
//! beyond the values calamine reads and the sizing `odf_layout` reads: the
//! style every cell points at, hidden and grouped rows and columns, links,
//! notes, text runs, filters, validations, conditional formats, the print
//! setup and the view the document was saved in.
//!
//! `content.xml` is streamed, like `odf_layout` does, and cells are kept as
//! runs — a row repeated a million times with one styled cell is one entry.
//! The styles at its head, `styles.xml` and `settings.xml` are small and are
//! read as trees. All of it is best-effort: a part this reader cannot follow
//! leaves the sheet with its values, the way it converted before.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use roxmltree::{Document, Node};
use zip::ZipArchive;

use crate::SidecarError;
use crate::odf_cell_styles::StyleBook;
use crate::odf_number_format::attribute;
use crate::odf_page::PageBook;
use crate::odf_pivots::{OdfPivot, PivotReader};
use crate::xml_util::{decode_cdata, decode_text, general_ref_text, read_zip_string, zip_entry};

pub(crate) const MAX_ROW: u32 = 1_048_576;
pub(crate) const MAX_COLUMN: u32 = 16_384;
/// The styles at the head of `content.xml` are read into memory; a document
/// whose head is larger than this keeps its values and loses the formatting.
const MAX_STYLE_BYTES: u64 = 64 * 1024 * 1024;
/// Outline levels Excel has.
const MAX_OUTLINE_LEVEL: u8 = 7;

/// A run of columns that share what the document says about them.
#[derive(Clone, Debug, Default)]
pub(crate) struct ColumnRun {
    pub(crate) first: u32,
    pub(crate) last: u32,
    /// The column style, when it starts a new page.
    pub(crate) style: Option<u32>,
    pub(crate) default_cell: Option<u32>,
    pub(crate) hidden: bool,
    pub(crate) level: u8,
}

/// A run of adjacent cells with one style.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CellRun {
    pub(crate) first: u32,
    pub(crate) last: u32,
    pub(crate) style: u32,
}

/// A run of rows that are the same element repeated.
#[derive(Clone, Debug, Default)]
pub(crate) struct RowRun {
    pub(crate) first: u32,
    pub(crate) last: u32,
    /// The row style, when it starts a new page.
    pub(crate) style: Option<u32>,
    pub(crate) default_cell: Option<u32>,
    pub(crate) hidden: bool,
    pub(crate) level: u8,
    pub(crate) cells: Vec<CellRun>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct Note {
    pub(crate) row: u32,
    pub(crate) column: u32,
    pub(crate) author: String,
    pub(crate) text: String,
}

/// One piece of a cell's text and the character style it points at.
pub(crate) type TextRun = (Option<u32>, String);

/// `table:filter-condition`.
#[derive(Clone, Debug, Default)]
pub(crate) struct FilterCondition {
    pub(crate) field: u32,
    pub(crate) operator: String,
    pub(crate) value: String,
    pub(crate) numeric: bool,
    /// `table:filter-set-item` values: the entries ticked in the list.
    pub(crate) items: Vec<String>,
    /// The `table:filter-or` the condition sits in, if any: conditions that
    /// share one are alternatives.
    pub(crate) or_group: Option<u32>,
}

/// `table:database-range`: a range with filter buttons, a filter, or both.
#[derive(Clone, Debug, Default)]
pub(crate) struct DatabaseRange {
    pub(crate) name: String,
    pub(crate) target: String,
    pub(crate) buttons: bool,
    pub(crate) conditions: Vec<FilterCondition>,
    pub(crate) has_filter: bool,
}

/// `table:content-validation`.
#[derive(Clone, Debug, Default)]
pub(crate) struct Validation {
    pub(crate) condition: String,
    pub(crate) base: String,
    pub(crate) allow_empty: bool,
    pub(crate) show_list: bool,
    pub(crate) help_title: Option<String>,
    pub(crate) help_text: String,
    pub(crate) show_help: bool,
    pub(crate) error_title: Option<String>,
    pub(crate) error_text: String,
    pub(crate) show_error: bool,
    pub(crate) error_kind: String,
}

/// One entry of a `calcext:conditional-format`.
#[derive(Clone, Debug)]
pub(crate) enum ConditionalEntry {
    Condition {
        value: String,
        style: String,
        base: String,
    },
    ColorScale(Vec<ScalePoint>),
    DataBar {
        points: Vec<ScalePoint>,
        color: Option<String>,
    },
}

/// `calcext:color-scale-entry` / `calcext:formatting-entry`.
#[derive(Clone, Debug, Default)]
pub(crate) struct ScalePoint {
    pub(crate) kind: String,
    pub(crate) value: String,
    pub(crate) color: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct ConditionalFormat {
    pub(crate) target: String,
    pub(crate) entries: Vec<ConditionalEntry>,
}

/// A rectangle of cells that share one validation.
#[derive(Clone, Debug)]
pub(crate) struct ValidationRun {
    pub(crate) first_row: u32,
    pub(crate) last_row: u32,
    pub(crate) first_column: u32,
    pub(crate) last_column: u32,
    pub(crate) name: u32,
}

/// One sheet, in 0-based grid coordinates.
#[derive(Debug, Default)]
pub(crate) struct OdsSheetFormat {
    pub(crate) name: String,
    pub(crate) style: Option<String>,
    pub(crate) protected: bool,
    pub(crate) print_ranges: Option<String>,
    pub(crate) columns: Vec<ColumnRun>,
    /// Only rows that say something: a style, a hidden flag, a group, a
    /// styled cell.
    pub(crate) rows: Vec<RowRun>,
    pub(crate) header_rows: Option<(u32, u32)>,
    pub(crate) header_columns: Option<(u32, u32)>,
    /// Rows and columns that close a collapsed group: the line right after
    /// its last member.
    pub(crate) collapsed_rows: Vec<u32>,
    pub(crate) collapsed_columns: Vec<u32>,
    pub(crate) links: Vec<((u32, u32), String)>,
    pub(crate) notes: Vec<Note>,
    /// The text of cells the value reader does not read whole: text with
    /// runs of its own formatting, and text that holds repeated spaces, tabs
    /// or line breaks, which ODF writes as elements.
    pub(crate) rich: Vec<((u32, u32), Vec<TextRun>)>,
    pub(crate) conditional: Vec<ConditionalFormat>,
    pub(crate) validations: Vec<ValidationRun>,
    pub(crate) sparklines: Vec<SparklineGroup>,
}

/// One `calcext:sparkline-group`: what it says about itself, by local
/// attribute name, and the cell and the range of each sparkline as the
/// document writes them.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct SparklineGroup {
    pub(crate) attributes: Vec<(String, String)>,
    pub(crate) cells: Vec<(String, String)>,
}

/// The sparkline groups one sheet may hold, and the cells of one group.
const MAX_SPARKLINE_GROUPS: usize = 1_000;
const MAX_SPARKLINE_CELLS: usize = 100_000;

/// What `settings.xml` remembers about one sheet's window.
#[derive(Clone, Debug, Default)]
pub(crate) struct SheetView {
    pub(crate) frozen_columns: u32,
    pub(crate) frozen_rows: u32,
    /// First column and row the window shows.
    pub(crate) left: u32,
    pub(crate) top: u32,
    /// First scrollable column and row behind the frozen ones.
    pub(crate) scrolled_column: Option<u32>,
    pub(crate) scrolled_row: Option<u32>,
    pub(crate) zoom: Option<u32>,
    pub(crate) grid: Option<bool>,
    pub(crate) cursor: Option<(u32, u32)>,
}

#[derive(Debug, Default)]
pub(crate) struct ViewSettings {
    pub(crate) sheets: HashMap<String, SheetView>,
    pub(crate) active: Option<String>,
    pub(crate) grid: Option<bool>,
    pub(crate) headers: Option<bool>,
}

/// Everything read from the package.
#[derive(Default)]
pub(crate) struct OdsFormats {
    pub(crate) book: StyleBook,
    pub(crate) pages: PageBook,
    pub(crate) sheets: Vec<OdsSheetFormat>,
    pub(crate) ranges: Vec<DatabaseRange>,
    pub(crate) validations: HashMap<String, Validation>,
    /// The pivot tables, as the document describes them.
    pub(crate) pivots: Vec<OdfPivot>,
    pub(crate) views: ViewSettings,
    /// Style and validation names the runs refer to by index.
    pub(crate) names: Vec<String>,
}

impl OdsFormats {
    pub(crate) fn name(&self, id: u32) -> Option<&str> {
        self.names.get(id as usize).map(String::as_str)
    }
}

/// Reads the formatting of every sheet from an ODS package.
pub(crate) fn read_formats(source: &Path) -> Result<OdsFormats, SidecarError> {
    let mut archive = ZipArchive::new(File::open(source)?)?;
    let mut formats = OdsFormats::default();

    // The named styles and the page setup live in `styles.xml`.
    if let Ok(xml) = read_zip_string(&mut archive, "styles.xml") {
        if let Ok(document) = Document::parse(&xml) {
            let root = document.root_element();
            formats.book.read_fonts(root);
            for scope in root.children().filter(Node::is_element) {
                match scope.tag_name().name() {
                    "styles" => formats.book.read_styles(scope),
                    "automatic-styles" => {
                        formats.pages.read_automatic(scope, &formats.book);
                        formats.book.read_data_styles(scope);
                    }
                    "master-styles" => formats.pages.read_masters(scope),
                    _ => {}
                }
            }
        }
    }
    // The automatic styles sit at the head of `content.xml`, ahead of the
    // body; only that head is read as a tree.
    if let Some(head) = content_head(&mut archive)? {
        if let Ok(document) = Document::parse(&head) {
            let root = document.root_element();
            formats.book.read_fonts(root);
            for scope in root.children().filter(Node::is_element) {
                if scope.tag_name().name() == "automatic-styles" {
                    formats.book.read_styles(scope);
                }
            }
        }
    }
    formats.book.seal();

    if let Ok(xml) = read_zip_string(&mut archive, "settings.xml") {
        if let Ok(document) = Document::parse(&xml) {
            formats.views = read_settings(document.root_element());
        }
    }

    let entry = zip_entry(&mut archive, "content.xml")?;
    let mut reader = Reader::from_reader(BufReader::new(entry));
    let mut parser = ContentParser {
        // A row or column style matters here only when it starts a page;
        // every row of a document names one for its height, and keeping
        // those would keep every row.
        row_breaks: formats.book.row_breaks.keys().cloned().collect(),
        column_breaks: formats.book.column_breaks.keys().cloned().collect(),
        ..ContentParser::default()
    };
    parser.run(&mut reader)?;
    formats.sheets = parser.sheets;
    formats.ranges = parser.ranges;
    formats.validations = parser.validations;
    formats.pivots = parser.pivots.pivots;
    formats.names = parser.names.list;
    Ok(formats)
}

/// `content.xml` from its start through the end of the automatic styles, with
/// the root element closed so it parses on its own.
fn content_head(archive: &mut ZipArchive<File>) -> Result<Option<String>, SidecarError> {
    let (end, root) = {
        let entry = zip_entry(archive, "content.xml")?;
        let mut reader = Reader::from_reader(BufReader::new(entry));
        let mut buf = Vec::new();
        let mut root: Option<String> = None;
        let mut end = None;
        loop {
            let event = reader.read_event_into(&mut buf)?;
            match event {
                Event::Eof => break,
                Event::Start(element) => {
                    if root.is_none() {
                        root = Some(String::from_utf8_lossy(element.name().as_ref()).into_owned());
                    } else if element.local_name().as_ref() == b"body" {
                        // No automatic styles before the body: nothing to read.
                        break;
                    }
                }
                Event::End(element) if element.local_name().as_ref() == b"automatic-styles" => {
                    end = Some(reader.buffer_position());
                    break;
                }
                _ => {}
            }
            buf.clear();
        }
        (end, root)
    };
    let (Some(end), Some(root)) = (end, root) else {
        return Ok(None);
    };
    if end > MAX_STYLE_BYTES {
        return Ok(None);
    }
    let entry = zip_entry(archive, "content.xml")?;
    let mut head = Vec::with_capacity(end as usize + 64);
    entry.take(end).read_to_end(&mut head)?;
    let mut head = match String::from_utf8(head) {
        Ok(head) => head,
        Err(_) => return Ok(None),
    };
    head.push_str(&format!("</{root}>"));
    Ok(Some(head))
}

fn read_settings(root: Node<'_, '_>) -> ViewSettings {
    let mut views = ViewSettings::default();
    let item = |node: Node<'_, '_>| -> Option<(String, String)> {
        Some((
            attribute(node, "name")?.to_owned(),
            node.text().unwrap_or("").trim().to_owned(),
        ))
    };
    for node in root.descendants().filter(Node::is_element) {
        match node.tag_name().name() {
            "config-item-map-named" if attribute(node, "name") == Some("Tables") => {
                for entry in node.children().filter(Node::is_element) {
                    let Some(name) = attribute(entry, "name") else {
                        continue;
                    };
                    let mut values: HashMap<String, String> = HashMap::new();
                    for child in entry.children().filter(Node::is_element) {
                        if let Some((key, value)) = item(child) {
                            values.insert(key, value);
                        }
                    }
                    let number = |key: &str| values.get(key).and_then(|value| value.parse::<u32>().ok());
                    let mut view = SheetView::default();
                    // Mode 2 is a frozen split; 1 is a movable one in pixels,
                    // which has no cell position to carry.
                    if number("HorizontalSplitMode") == Some(2) {
                        view.frozen_columns = number("HorizontalSplitPosition").unwrap_or(0);
                        view.scrolled_column = number("PositionRight");
                    }
                    if number("VerticalSplitMode") == Some(2) {
                        view.frozen_rows = number("VerticalSplitPosition").unwrap_or(0);
                        view.scrolled_row = number("PositionBottom");
                    }
                    view.left = number("PositionLeft").unwrap_or(0);
                    view.top = number("PositionTop").unwrap_or(0);
                    view.zoom = number("ZoomValue").filter(|zoom| (10..=400).contains(zoom));
                    view.grid = values.get("ShowGrid").map(|value| value == "true");
                    if let (Some(column), Some(row)) = (number("CursorPositionX"), number("CursorPositionY")) {
                        view.cursor = Some((row, column));
                    }
                    views.sheets.insert(name.to_owned(), view);
                }
            }
            "config-item" => {
                if let Some((key, value)) = item(node) {
                    match key.as_str() {
                        "ActiveTable" => views.active = Some(value),
                        "ShowGrid" if views.grid.is_none() => {
                            // The first one in document order is the view's
                            // own, ahead of any per-sheet entry.
                            if !node
                                .ancestors()
                                .any(|ancestor| attribute(ancestor, "name") == Some("Tables"))
                            {
                                views.grid = Some(value == "true");
                            }
                        }
                        "HasColumnRowHeaders" => views.headers = Some(value == "true"),
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }
    views
}

/// Style names as small integers, so a cell run is twelve bytes.
#[derive(Default)]
struct Names {
    list: Vec<String>,
    index: HashMap<String, u32>,
}

impl Names {
    fn id(&mut self, name: String) -> u32 {
        if let Some(id) = self.index.get(&name) {
            return *id;
        }
        let id = self.list.len() as u32;
        self.index.insert(name.clone(), id);
        self.list.push(name);
        id
    }
}

/// The cell being read.
#[derive(Default)]
struct CellState {
    row: u32,
    column: u32,
    repeats: u32,
    /// True when the cell's text is its value: a string cell without a
    /// formula.
    text_value: bool,
    runs: Vec<TextRun>,
    styled: bool,
    /// True once the text held a space, tab or line-break element.
    spaced: bool,
    paragraphs: u32,
    link: Option<String>,
}

#[derive(Default)]
struct NoteState {
    author: String,
    text: String,
    paragraphs: u32,
    in_creator: bool,
    in_date: bool,
}

/// Which message of a validation the text belongs to.
#[derive(Clone, Copy, PartialEq)]
enum Message {
    Help,
    Error,
}

#[derive(Default)]
struct ContentParser {
    sheets: Vec<OdsSheetFormat>,
    ranges: Vec<DatabaseRange>,
    validations: HashMap<String, Validation>,
    names: Names,
    row_breaks: HashSet<String>,
    column_breaks: HashSet<String>,

    sheet: Option<OdsSheetFormat>,
    next_column: u32,
    next_row: u32,
    row: Option<RowRun>,
    column: u32,
    row_groups: Vec<(u32, bool)>,
    column_groups: Vec<(u32, bool)>,
    header_rows_from: Option<u32>,
    header_columns_from: Option<u32>,
    cell: Option<CellState>,
    note: Option<NoteState>,
    spans: Vec<Option<u32>>,
    in_paragraph: bool,
    /// Depth inside markup this reader does not look into (shapes, change
    /// tracking, linked tables).
    skip: usize,
    range: Option<DatabaseRange>,
    or_depth: u32,
    or_groups: u32,
    validation: Option<(String, Validation)>,
    message: Option<Message>,
    conditional: Option<ConditionalFormat>,
    sparkline: Option<SparklineGroup>,
    scale: Option<(bool, Vec<ScalePoint>, Option<String>)>,
    /// Validation runs still growing downwards, one per column span.
    open_validations: Vec<ValidationRun>,
    /// The pivot tables; it takes over inside `table:data-pilot-tables`.
    pivots: PivotReader,
}

fn attributes<R: BufRead>(
    reader: &Reader<R>,
    element: &BytesStart<'_>,
    mut visit: impl FnMut(&[u8], String),
) -> Result<(), SidecarError> {
    for attribute in element.attributes().with_checks(false) {
        let attribute = attribute.map_err(|error| SidecarError::Workbook(error.to_string()))?;
        let value = attribute
            .decode_and_unescape_value(reader.decoder())?
            .into_owned();
        visit(attribute.key.local_name().as_ref(), value);
    }
    Ok(())
}

fn parse_count(value: &str) -> u32 {
    value.trim().parse::<u32>().unwrap_or(1).max(1)
}

impl ContentParser {
    fn run<R: BufRead>(&mut self, reader: &mut Reader<R>) -> Result<(), SidecarError> {
        let mut buf = Vec::new();
        loop {
            let event = reader.read_event_into(&mut buf)?;
            match event {
                Event::Eof => break,
                Event::Start(element) => {
                    if self.skip > 0 {
                        self.skip += 1;
                    } else if self.skips(&element) {
                        self.skip = 1;
                    } else {
                        self.start(reader, &element, false)?;
                    }
                }
                Event::Empty(element) => {
                    if self.skip == 0 && !self.skips(&element) {
                        self.start(reader, &element, true)?;
                    }
                }
                Event::End(element) => {
                    if self.skip > 0 {
                        self.skip -= 1;
                    } else {
                        self.end(element.local_name().as_ref());
                    }
                }
                Event::Text(text) if self.skip == 0 && self.wants_text() => {
                    let text = decode_text(&text)?;
                    self.text(&text);
                }
                Event::CData(text) if self.skip == 0 && self.wants_text() => {
                    let text = decode_cdata(&text)?;
                    self.text(&text);
                }
                Event::GeneralRef(reference) if self.skip == 0 && self.wants_text() => {
                    let text = general_ref_text(&reference)?;
                    self.text(&text);
                }
                _ => {}
            }
            buf.clear();
        }
        self.finish_sheet();
        Ok(())
    }

    /// Markup whose tables, paragraphs and cells are not the sheet's own.
    fn skips(&self, element: &BytesStart<'_>) -> bool {
        let name = element.name();
        let name = name.as_ref();
        name.starts_with(b"draw:")
            || matches!(
                element.local_name().as_ref(),
                b"shapes" | b"forms" | b"tracked-changes" | b"dde-links"
            )
            // A table inside a cell is a nested table, not a sheet.
            || (self.cell.is_some() && element.local_name().as_ref() == b"table")
    }

    fn wants_text(&self) -> bool {
        self.in_paragraph
            || self
                .note
                .as_ref()
                .is_some_and(|note| note.in_creator)
    }

    fn start<R: BufRead>(
        &mut self,
        reader: &Reader<R>,
        element: &BytesStart<'_>,
        empty: bool,
    ) -> Result<(), SidecarError> {
        // The pivot tables follow the sheets and share element names with
        // the filters of a database range; their reader takes them whole.
        if self.pivots.active() || element.local_name().as_ref() == b"data-pilot-tables" {
            let mut list: Vec<(Vec<u8>, String)> = Vec::new();
            attributes(reader, element, |key, value| list.push((key.to_vec(), value)))?;
            self.pivots.start(element.local_name().as_ref(), &list, empty);
            return Ok(());
        }
        match element.local_name().as_ref() {
            b"table" => {
                self.finish_sheet();
                let mut sheet = OdsSheetFormat::default();
                attributes(reader, element, |key, value| match key {
                    b"name" => sheet.name = value,
                    b"style-name" => sheet.style = Some(value),
                    b"protected" => sheet.protected = value == "true",
                    b"print-ranges" => sheet.print_ranges = Some(value),
                    _ => {}
                })?;
                self.sheet = Some(sheet);
                self.next_column = 0;
                self.next_row = 0;
                self.row_groups.clear();
                self.column_groups.clear();
                self.open_validations.clear();
            }
            b"table-column-group" if !empty => {
                let mut shown = true;
                attributes(reader, element, |key, value| {
                    if key == b"display" {
                        shown = value != "false";
                    }
                })?;
                self.column_groups.push((self.next_column, shown));
            }
            b"table-row-group" if !empty => {
                let mut shown = true;
                attributes(reader, element, |key, value| {
                    if key == b"display" {
                        shown = value != "false";
                    }
                })?;
                self.row_groups.push((self.next_row, shown));
            }
            b"table-header-rows" if !empty => self.header_rows_from = Some(self.next_row),
            b"table-header-columns" if !empty => self.header_columns_from = Some(self.next_column),
            b"table-column" => self.column_element(reader, element)?,
            b"table-row" => {
                self.row_element(reader, element)?;
                if empty {
                    self.finish_row();
                }
            }
            b"table-cell" | b"covered-table-cell" => {
                self.cell_element(reader, element)?;
                if empty {
                    self.finish_cell();
                }
            }
            b"annotation" if self.cell.is_some() && !empty => {
                self.note = Some(NoteState::default());
                self.in_paragraph = false;
            }
            b"creator" if !empty => {
                if let Some(note) = &mut self.note {
                    note.in_creator = true;
                }
            }
            b"date" if !empty => {
                if let Some(note) = &mut self.note {
                    note.in_date = true;
                }
            }
            b"p" => self.paragraph(empty),
            b"span" if !empty => {
                let mut style = None;
                attributes(reader, element, |key, value| {
                    if key == b"style-name" {
                        style = Some(value);
                    }
                })?;
                let id = style.map(|name| self.names.id(name));
                if id.is_some() && self.note.is_none() {
                    if let Some(cell) = &mut self.cell {
                        cell.styled = true;
                    }
                }
                self.spans.push(id);
            }
            b"a" => {
                if self.note.is_none() {
                    let mut href = None;
                    attributes(reader, element, |key, value| {
                        if key == b"href" {
                            href = Some(value);
                        }
                    })?;
                    if let (Some(cell), Some(href)) = (&mut self.cell, href) {
                        if cell.link.is_none() && !href.is_empty() {
                            cell.link = Some(href);
                        }
                    }
                }
            }
            b"s" if self.in_paragraph => {
                let mut spaces = 1;
                attributes(reader, element, |key, value| {
                    if key == b"c" {
                        spaces = parse_count(&value).min(10_000);
                    }
                })?;
                self.mark_spaced();
                self.text(&" ".repeat(spaces as usize));
            }
            b"tab" if self.in_paragraph => {
                self.mark_spaced();
                self.text("\t");
            }
            b"line-break" if self.in_paragraph => {
                self.mark_spaced();
                self.text("\n");
            }
            b"database-range" => {
                let mut range = DatabaseRange::default();
                attributes(reader, element, |key, value| match key {
                    b"name" => range.name = value,
                    b"target-range-address" => range.target = value,
                    b"display-filter-buttons" => range.buttons = value == "true",
                    _ => {}
                })?;
                if empty {
                    self.ranges.push(range);
                } else {
                    self.range = Some(range);
                }
            }
            b"filter" => {
                if let Some(range) = &mut self.range {
                    range.has_filter = true;
                }
            }
            b"filter-or" if !empty => {
                self.or_depth += 1;
                self.or_groups += 1;
            }
            b"filter-condition" => {
                let mut condition = FilterCondition::default();
                attributes(reader, element, |key, value| match key {
                    b"field-number" => condition.field = value.trim().parse().unwrap_or(0),
                    b"operator" => condition.operator = value,
                    b"value" => condition.value = value,
                    b"data-type" => condition.numeric = value == "number",
                    _ => {}
                })?;
                if self.or_depth > 0 {
                    condition.or_group = Some(self.or_groups);
                }
                if let Some(range) = &mut self.range {
                    range.conditions.push(condition);
                }
            }
            b"filter-set-item" => {
                let mut item = None;
                attributes(reader, element, |key, value| {
                    if key == b"value" {
                        item = Some(value);
                    }
                })?;
                if let (Some(range), Some(item)) = (&mut self.range, item) {
                    if let Some(condition) = range.conditions.last_mut() {
                        condition.items.push(item);
                    }
                }
            }
            b"content-validation" => {
                let mut name = String::new();
                let mut validation = Validation {
                    allow_empty: true,
                    show_list: true,
                    ..Validation::default()
                };
                attributes(reader, element, |key, value| match key {
                    b"name" => name = value,
                    b"condition" => validation.condition = value,
                    b"base-cell-address" => validation.base = value,
                    b"allow-empty-cell" => validation.allow_empty = value != "false",
                    b"display-list" => validation.show_list = value != "no" && value != "none",
                    _ => {}
                })?;
                if empty {
                    self.validations.insert(name, validation);
                } else {
                    self.validation = Some((name, validation));
                }
            }
            b"help-message" => {
                if let Some((_, validation)) = &mut self.validation {
                    validation.show_help = true;
                    let mut title = None;
                    let mut shown = true;
                    attributes(reader, element, |key, value| match key {
                        b"title" => title = Some(value),
                        b"display" => shown = value != "false",
                        _ => {}
                    })?;
                    validation.help_title = title;
                    validation.show_help = shown;
                    if !empty {
                        self.message = Some(Message::Help);
                    }
                }
            }
            b"error-message" => {
                if let Some((_, validation)) = &mut self.validation {
                    let mut title = None;
                    let mut shown = true;
                    let mut kind = String::new();
                    attributes(reader, element, |key, value| match key {
                        b"title" => title = Some(value),
                        b"display" => shown = value != "false",
                        b"message-type" => kind = value,
                        _ => {}
                    })?;
                    validation.error_title = title;
                    validation.show_error = shown;
                    validation.error_kind = kind;
                    if !empty {
                        self.message = Some(Message::Error);
                    }
                }
            }
            b"sparkline-group" if !empty => {
                let mut group = SparklineGroup::default();
                attributes(reader, element, |key, value| {
                    if group.attributes.len() < 64 {
                        group
                            .attributes
                            .push((String::from_utf8_lossy(key).into_owned(), value));
                    }
                })?;
                self.sparkline = Some(group);
            }
            b"sparkline" => {
                if let Some(group) = &mut self.sparkline {
                    let (mut cell, mut range) = (String::new(), String::new());
                    attributes(reader, element, |key, value| match key {
                        b"cell-address" => cell = value,
                        b"data-range" => range = value,
                        _ => {}
                    })?;
                    if !cell.is_empty() && !range.is_empty() && group.cells.len() < MAX_SPARKLINE_CELLS
                    {
                        group.cells.push((cell, range));
                    }
                }
            }
            b"conditional-format" if !empty => {
                let mut target = String::new();
                attributes(reader, element, |key, value| {
                    if key == b"target-range-address" {
                        target = value;
                    }
                })?;
                self.conditional = Some(ConditionalFormat {
                    target,
                    entries: Vec::new(),
                });
            }
            b"condition" => {
                if let Some(format) = &mut self.conditional {
                    let mut value_text = String::new();
                    let mut style = String::new();
                    let mut base = String::new();
                    attributes(reader, element, |key, value| match key {
                        b"value" => value_text = value,
                        b"apply-style-name" => style = value,
                        b"base-cell-address" => base = value,
                        _ => {}
                    })?;
                    format.entries.push(ConditionalEntry::Condition {
                        value: value_text,
                        style,
                        base,
                    });
                }
            }
            b"color-scale" if self.conditional.is_some() && !empty => {
                self.scale = Some((false, Vec::new(), None));
            }
            b"data-bar" if self.conditional.is_some() && !empty => {
                let mut color = None;
                attributes(reader, element, |key, value| {
                    if key == b"positive-color" {
                        color = Some(value);
                    }
                })?;
                self.scale = Some((true, Vec::new(), color));
            }
            b"color-scale-entry" | b"formatting-entry" => {
                if let Some((_, points, _)) = &mut self.scale {
                    let mut point = ScalePoint::default();
                    attributes(reader, element, |key, value| match key {
                        b"type" => point.kind = value,
                        b"value" => point.value = value,
                        b"color" => point.color = Some(value),
                        _ => {}
                    })?;
                    points.push(point);
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn end(&mut self, name: &[u8]) {
        if self.pivots.active() {
            self.pivots.end(name);
            return;
        }
        match name {
            b"table" => self.finish_sheet(),
            b"table-column-group" => {
                if let Some((first, shown)) = self.column_groups.pop() {
                    if !shown && self.next_column > first {
                        if let Some(sheet) = &mut self.sheet {
                            sheet.collapsed_columns.push(self.next_column);
                        }
                    }
                }
            }
            b"table-row-group" => {
                if let Some((first, shown)) = self.row_groups.pop() {
                    if !shown && self.next_row > first {
                        if let Some(sheet) = &mut self.sheet {
                            sheet.collapsed_rows.push(self.next_row);
                        }
                    }
                }
            }
            b"table-header-rows" => {
                if let (Some(first), Some(sheet)) = (self.header_rows_from.take(), &mut self.sheet) {
                    if self.next_row > first {
                        sheet.header_rows = Some((first, self.next_row - 1));
                    }
                }
            }
            b"table-header-columns" => {
                if let (Some(first), Some(sheet)) =
                    (self.header_columns_from.take(), &mut self.sheet)
                {
                    if self.next_column > first {
                        sheet.header_columns = Some((first, self.next_column - 1));
                    }
                }
            }
            b"table-row" => self.finish_row(),
            b"table-cell" | b"covered-table-cell" => self.finish_cell(),
            b"annotation" => {
                if let (Some(note), Some(cell), Some(sheet)) =
                    (self.note.take(), &self.cell, &mut self.sheet)
                {
                    sheet.notes.push(Note {
                        row: cell.row,
                        column: cell.column,
                        author: note.author.trim().to_owned(),
                        text: note.text,
                    });
                }
                self.in_paragraph = false;
            }
            b"creator" => {
                if let Some(note) = &mut self.note {
                    note.in_creator = false;
                }
            }
            b"date" => {
                if let Some(note) = &mut self.note {
                    note.in_date = false;
                }
            }
            b"p" => self.in_paragraph = false,
            b"span" => {
                self.spans.pop();
            }
            b"filter-or" => self.or_depth = self.or_depth.saturating_sub(1),
            b"database-range" => {
                if let Some(range) = self.range.take() {
                    self.ranges.push(range);
                }
                self.or_depth = 0;
            }
            b"content-validation" => {
                if let Some((name, validation)) = self.validation.take() {
                    self.validations.insert(name, validation);
                }
                self.message = None;
            }
            b"help-message" | b"error-message" => self.message = None,
            b"sparkline-group" => {
                if let (Some(group), Some(sheet)) = (self.sparkline.take(), &mut self.sheet) {
                    if !group.cells.is_empty() && sheet.sparklines.len() < MAX_SPARKLINE_GROUPS {
                        sheet.sparklines.push(group);
                    }
                }
            }
            b"conditional-format" => {
                if let (Some(format), Some(sheet)) = (self.conditional.take(), &mut self.sheet) {
                    if !format.entries.is_empty() {
                        sheet.conditional.push(format);
                    }
                }
            }
            b"color-scale" | b"data-bar" => {
                if let (Some((bar, points, color)), Some(format)) =
                    (self.scale.take(), &mut self.conditional)
                {
                    format.entries.push(if bar {
                        ConditionalEntry::DataBar { points, color }
                    } else {
                        ConditionalEntry::ColorScale(points)
                    });
                }
            }
            _ => {}
        }
    }

    fn mark_spaced(&mut self) {
        if self.note.is_none() && self.message.is_none() {
            if let Some(cell) = &mut self.cell {
                cell.spaced = true;
            }
        }
    }

    fn paragraph(&mut self, empty: bool) {
        if let Some(note) = &mut self.note {
            if note.paragraphs > 0 {
                note.text.push('\n');
            }
            note.paragraphs += 1;
            self.in_paragraph = !empty;
            return;
        }
        if let Some(message) = self.message {
            if let Some((_, validation)) = &mut self.validation {
                let text = match message {
                    Message::Help => &mut validation.help_text,
                    Message::Error => &mut validation.error_text,
                };
                if !text.is_empty() {
                    text.push('\n');
                }
            }
            self.in_paragraph = !empty;
            return;
        }
        if let Some(cell) = &mut self.cell {
            if cell.text_value {
                if cell.paragraphs > 0 {
                    match cell.runs.last_mut() {
                        Some((None, run)) => run.push('\n'),
                        _ => cell.runs.push((None, "\n".to_owned())),
                    }
                }
                cell.paragraphs += 1;
            }
            self.in_paragraph = !empty;
        }
    }

    fn text(&mut self, text: &str) {
        if let Some(note) = &mut self.note {
            if note.in_creator {
                note.author.push_str(text);
            } else if !note.in_date && self.in_paragraph {
                note.text.push_str(text);
            }
            return;
        }
        if !self.in_paragraph {
            return;
        }
        if let Some(message) = self.message {
            if let Some((_, validation)) = &mut self.validation {
                match message {
                    Message::Help => validation.help_text.push_str(text),
                    Message::Error => validation.error_text.push_str(text),
                }
            }
            return;
        }
        if let Some(cell) = &mut self.cell {
            if !cell.text_value {
                return;
            }
            let style = self.spans.iter().rev().find_map(|style| *style);
            match cell.runs.last_mut() {
                Some((last, run)) if *last == style => run.push_str(text),
                _ => cell.runs.push((style, text.to_owned())),
            }
        }
    }

    fn column_element<R: BufRead>(
        &mut self,
        reader: &Reader<R>,
        element: &BytesStart<'_>,
    ) -> Result<(), SidecarError> {
        let mut repeats = 1;
        let mut style = None;
        let mut default_cell = None;
        let mut hidden = false;
        attributes(reader, element, |key, value| match key {
            b"number-columns-repeated" => repeats = parse_count(&value),
            b"style-name" => style = Some(value),
            b"default-cell-style-name" => default_cell = Some(value),
            b"visibility" => hidden = value != "visible",
            _ => {}
        })?;
        let first = self.next_column;
        self.next_column = first.saturating_add(repeats).min(MAX_COLUMN);
        if first >= MAX_COLUMN {
            return Ok(());
        }
        let run = ColumnRun {
            first,
            last: self.next_column - 1,
            style: style
                .filter(|name| self.column_breaks.contains(name))
                .map(|name| self.names.id(name)),
            default_cell: default_cell.map(|name| self.names.id(name)),
            hidden,
            level: (self.column_groups.len() as u8).min(MAX_OUTLINE_LEVEL),
        };
        if let Some(sheet) = &mut self.sheet {
            sheet.columns.push(run);
        }
        Ok(())
    }

    fn row_element<R: BufRead>(
        &mut self,
        reader: &Reader<R>,
        element: &BytesStart<'_>,
    ) -> Result<(), SidecarError> {
        let mut repeats = 1;
        let mut style = None;
        let mut default_cell = None;
        let mut hidden = false;
        attributes(reader, element, |key, value| match key {
            b"number-rows-repeated" => repeats = parse_count(&value),
            b"style-name" => style = Some(value),
            b"default-cell-style-name" => default_cell = Some(value),
            b"visibility" => hidden = value != "visible",
            _ => {}
        })?;
        let first = self.next_row;
        self.next_row = first.saturating_add(repeats).min(MAX_ROW);
        self.column = 0;
        self.row = Some(RowRun {
            first,
            last: self.next_row.saturating_sub(1).max(first),
            style: style
                .filter(|name| self.row_breaks.contains(name))
                .map(|name| self.names.id(name)),
            default_cell: default_cell.map(|name| self.names.id(name)),
            hidden,
            level: (self.row_groups.len() as u8).min(MAX_OUTLINE_LEVEL),
            cells: Vec::new(),
        });
        Ok(())
    }

    fn cell_element<R: BufRead>(
        &mut self,
        reader: &Reader<R>,
        element: &BytesStart<'_>,
    ) -> Result<(), SidecarError> {
        let mut repeats = 1;
        let mut style = None;
        let mut validation = None;
        let mut value_type: Option<String> = None;
        let mut formula = false;
        let mut string_value = false;
        attributes(reader, element, |key, value| match key {
            b"number-columns-repeated" => repeats = parse_count(&value),
            b"style-name" => style = Some(value),
            b"content-validation-name" => validation = Some(value),
            b"value-type" => value_type = Some(value),
            b"formula" => formula = true,
            // The attribute, when present, is the value; the paragraphs
            // are only how it is shown.
            b"string-value" => string_value = true,
            _ => {}
        })?;
        let first = self.column;
        self.column = first.saturating_add(repeats).min(MAX_COLUMN);
        let row = self.row.as_ref().map_or(0, |row| row.first);
        self.cell = Some(CellState {
            row,
            column: first,
            repeats,
            text_value: !formula
                && !string_value
                && value_type.as_deref().is_none_or(|kind| kind == "string"),
            ..CellState::default()
        });
        if first >= MAX_COLUMN {
            return Ok(());
        }
        let last = self.column - 1;
        if let Some(name) = style {
            let style = self.names.id(name);
            if let Some(row) = &mut self.row {
                match row.cells.last_mut() {
                    Some(previous) if previous.style == style && previous.last + 1 == first => {
                        previous.last = last;
                    }
                    _ => row.cells.push(CellRun { first, last, style }),
                }
            }
        }
        if let Some(name) = validation {
            let name = self.names.id(name);
            let (first_row, last_row) = self
                .row
                .as_ref()
                .map_or((row, row), |row| (row.first, row.last));
            // A run in the row above with the same columns and rule grows
            // down instead of starting a new rectangle.
            match self.open_validations.iter_mut().find(|run| {
                run.name == name
                    && run.first_column == first
                    && run.last_column == last
                    && run.last_row + 1 == first_row
            }) {
                Some(run) => run.last_row = last_row,
                None => self.open_validations.push(ValidationRun {
                    first_row,
                    last_row,
                    first_column: first,
                    last_column: last,
                    name,
                }),
            }
        }
        Ok(())
    }

    fn finish_cell(&mut self) {
        let Some(cell) = self.cell.take() else {
            return;
        };
        self.in_paragraph = false;
        self.spans.clear();
        self.note = None;
        let Some(sheet) = &mut self.sheet else {
            return;
        };
        if cell.column >= MAX_COLUMN || cell.row >= MAX_ROW {
            return;
        }
        if let Some(link) = cell.link {
            sheet.links.push(((cell.row, cell.column), link));
        }
        if (cell.styled || cell.spaced) && cell.text_value && cell.repeats == 1 {
            let runs: Vec<TextRun> = cell
                .runs
                .into_iter()
                .filter(|(_, text)| !text.is_empty())
                .collect();
            if cell.spaced || runs.iter().any(|(style, _)| style.is_some()) {
                sheet.rich.push(((cell.row, cell.column), runs));
            }
        }
    }

    fn finish_row(&mut self) {
        let Some(row) = self.row.take() else {
            return;
        };
        // Validation runs the row did not extend are complete.
        let (still_open, closed): (Vec<_>, Vec<_>) = self
            .open_validations
            .drain(..)
            .partition(|run| run.last_row >= row.first);
        self.open_validations = still_open;
        let Some(sheet) = &mut self.sheet else {
            return;
        };
        sheet.validations.extend(closed);
        if row.first >= MAX_ROW {
            return;
        }
        let says_something = !row.cells.is_empty()
            || row.style.is_some()
            || row.default_cell.is_some()
            || row.hidden
            || row.level > 0;
        if says_something {
            sheet.rows.push(row);
        }
    }

    fn finish_sheet(&mut self) {
        self.finish_cell();
        self.finish_row();
        if let Some(mut sheet) = self.sheet.take() {
            sheet.validations.append(&mut self.open_validations);
            self.sheets.push(sheet);
        }
        self.next_column = 0;
        self.next_row = 0;
    }
}

impl OdsSheetFormat {
    /// The row run a row falls in, if the document said anything about it.
    pub(crate) fn row(&self, row: u32) -> Option<&RowRun> {
        let position = self.rows.partition_point(|run| run.last < row);
        self.rows.get(position).filter(|run| run.first <= row)
    }

    /// The column run a column falls in.
    pub(crate) fn column(&self, column: u32) -> Option<&ColumnRun> {
        let position = self.columns.partition_point(|run| run.last < column);
        self.columns.get(position).filter(|run| run.first <= column)
    }

    /// The style a cell names itself, leaving out what it would inherit.
    pub(crate) fn own_cell_style(&self, row: u32, column: u32) -> Option<u32> {
        let run = self.row(row)?;
        let position = run.cells.partition_point(|cell| cell.last < column);
        run.cells
            .get(position)
            .filter(|cell| cell.first <= column)
            .map(|cell| cell.style)
    }

    /// The style a cell shows: its own, else the row's default, else the
    /// column's.
    pub(crate) fn cell_style(&self, row: u32, column: u32) -> Option<u32> {
        let run = self.row(row);
        if let Some(run) = run {
            let position = run.cells.partition_point(|cell| cell.last < column);
            if let Some(cell) = run.cells.get(position).filter(|cell| cell.first <= column) {
                return Some(cell.style);
            }
            if run.default_cell.is_some() {
                return run.default_cell;
            }
        }
        self.column(column).and_then(|run| run.default_cell)
    }
}

/// `Sheet1.A1:Sheet1.D10` (or `$Sheet1.$A$1:.$D$10`, `'My sheet'.B2`) as the
/// sheet name and the 0-based corners.
pub(crate) fn parse_range_address(address: &str) -> Option<(Option<String>, (u32, u32), (u32, u32))> {
    let address = address.trim();
    let (first, second) = match split_outside_quotes(address, ':') {
        Some((first, second)) => (first, Some(second)),
        None => (address, None),
    };
    let (sheet, start) = parse_cell_address(first)?;
    let end = match second {
        Some(second) => parse_cell_address(second)?.1,
        None => start,
    };
    Some((
        sheet,
        (start.0.min(end.0), start.1.min(end.1)),
        (start.0.max(end.0), start.1.max(end.1)),
    ))
}

/// Space-separated addresses, with spaces inside quoted sheet names kept.
pub(crate) fn split_addresses(text: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    for (index, character) in text.char_indices() {
        if character == '\'' {
            quoted = !quoted;
        } else if character == ' ' && !quoted {
            if index > start {
                parts.push(&text[start..index]);
            }
            start = index + 1;
        }
    }
    if start < text.len() {
        parts.push(&text[start..]);
    }
    parts
}

fn split_outside_quotes(text: &str, separator: char) -> Option<(&str, &str)> {
    let mut quoted = false;
    for (index, character) in text.char_indices() {
        if character == '\'' {
            quoted = !quoted;
        } else if character == separator && !quoted {
            return Some((&text[..index], &text[index + separator.len_utf8()..]));
        }
    }
    None
}

/// `$Sheet1.$A$1` or `.B2` as `(sheet, (row, column))`.
pub(crate) fn parse_cell_address(text: &str) -> Option<(Option<String>, (u32, u32))> {
    let text = text.trim();
    let mut quoted = false;
    let mut dot = None;
    for (index, character) in text.char_indices() {
        if character == '\'' {
            quoted = !quoted;
        } else if character == '.' && !quoted {
            dot = Some(index);
        }
    }
    let (sheet, cell) = match dot {
        Some(index) => (&text[..index], &text[index + 1..]),
        None => ("", text),
    };
    let sheet = sheet.trim_start_matches('$');
    let sheet = if sheet.is_empty() {
        None
    } else if sheet.starts_with('\'') && sheet.ends_with('\'') && sheet.len() >= 2 {
        Some(sheet[1..sheet.len() - 1].replace("''", "'"))
    } else {
        Some(sheet.to_owned())
    };
    let cell = cell.replace('$', "");
    let letters: String = cell.chars().take_while(char::is_ascii_alphabetic).collect();
    let digits = &cell[letters.len()..];
    if letters.is_empty() || letters.len() > 3 || digits.is_empty() {
        return None;
    }
    let mut column = 0u32;
    for letter in letters.chars() {
        column = column * 26 + (letter.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
    }
    let row: u32 = digits.parse().ok()?;
    if row == 0 || row > MAX_ROW || column > MAX_COLUMN {
        return None;
    }
    Some((sheet, (row - 1, column - 1)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(body: &str) -> ContentParser {
        let xml = format!(
            r#"<office:document-content xmlns:office="o" xmlns:table="t" xmlns:text="x" xmlns:xlink="l" xmlns:dc="d" xmlns:draw="w" xmlns:calcext="c"><office:body><office:spreadsheet>{body}</office:spreadsheet></office:body></office:document-content>"#
        );
        let mut reader = Reader::from_str(&xml);
        let mut parser = ContentParser::default();
        parser.run(&mut reader).unwrap();
        parser
    }

    #[test]
    fn cells_are_kept_as_runs_and_rows_as_repeats() {
        let parser = parse(concat!(
            r#"<table:table table:name="S" table:style-name="ta1" table:protected="true" table:print-ranges="S.A1:S.C9">"#,
            r#"<table:table-column table:style-name="co1" table:default-cell-style-name="ce9" table:number-columns-repeated="2"/>"#,
            r#"<table:table-column-group table:display="false"><table:table-column table:visibility="collapse"/></table:table-column-group>"#,
            r#"<table:table-column table:number-columns-repeated="16381" table:default-cell-style-name="Default"/>"#,
            r#"<table:table-header-rows><table:table-row table:style-name="ro1"><table:table-cell table:style-name="ce1"/><table:table-cell table:style-name="ce1"/><table:table-cell/><table:table-cell table:style-name="ce2" table:number-columns-repeated="3"/></table:table-row></table:table-header-rows>"#,
            r#"<table:table-row><table:table-cell/></table:table-row>"#,
            r#"<table:table-row-group><table:table-row table:visibility="filter" table:number-rows-repeated="3"><table:table-cell table:style-name="Default"/></table:table-row></table:table-row-group>"#,
            r#"<table:table-row table:number-rows-repeated="1048571"><table:table-cell table:number-columns-repeated="2"/><table:table-cell table:style-name="ce3"/></table:table-row>"#,
            r#"</table:table>"#,
        ));
        let sheet = &parser.sheets[0];
        let name = |id: u32| parser.names.list[id as usize].as_str();
        assert_eq!(sheet.name, "S");
        assert!(sheet.protected);
        assert_eq!(sheet.print_ranges.as_deref(), Some("S.A1:S.C9"));
        assert_eq!(sheet.columns.len(), 3);
        assert_eq!(sheet.columns[0].default_cell.map(name), Some("ce9"));
        assert_eq!(sheet.columns[0].style, None, "a style that breaks no page is not kept");
        assert!(sheet.columns[1].hidden);
        assert_eq!(sheet.columns[1].level, 1);
        assert_eq!(sheet.columns[2].last, MAX_COLUMN - 1);
        assert_eq!(sheet.collapsed_columns, vec![3]);
        assert_eq!(sheet.header_rows, Some((0, 0)));
        // the unstyled row in between says nothing and is not kept
        assert_eq!(sheet.rows.len(), 3);
        assert_eq!(sheet.columns[2].default_cell.map(name), Some("Default"));
        assert_eq!(
            sheet.rows[0].cells,
            vec![
                CellRun { first: 0, last: 1, style: parser.names.index["ce1"] },
                CellRun { first: 3, last: 5, style: parser.names.index["ce2"] },
            ]
        );
        assert_eq!((sheet.rows[1].first, sheet.rows[1].last), (2, 4));
        assert!(sheet.rows[1].hidden);
        assert_eq!(sheet.rows[1].level, 1);
        assert_eq!((sheet.rows[2].first, sheet.rows[2].last), (5, MAX_ROW - 1));
        assert_eq!(sheet.cell_style(0, 4).map(name), Some("ce2"));
        assert_eq!(sheet.cell_style(0, 2), None, "the third column has no default");
        assert_eq!(sheet.cell_style(3, 0).map(name), Some("Default"), "said out loud");
        assert_eq!(sheet.cell_style(1, 0).map(name), Some("ce9"), "the column default");
        assert_eq!(sheet.cell_style(900_000, 2).map(name), Some("ce3"));
    }

    #[test]
    fn links_notes_and_text_runs_are_read_from_the_cell() {
        let parser = parse(concat!(
            r#"<table:table table:name="S"><table:table-row>"#,
            r#"<table:table-cell office:value-type="string"><office:annotation><dc:creator>Kim</dc:creator><dc:date>2026-01-01T00:00:00</dc:date><text:p>first</text:p><text:p>second &amp; third</text:p></office:annotation><text:p><text:a xlink:href="https://example.com/">site</text:a></text:p></table:table-cell>"#,
            r#"<table:table-cell office:value-type="string"><text:p>plain <text:span text:style-name="T1">bold</text:span><text:s text:c="2"/>end</text:p><text:p>next</text:p><draw:frame><text:p>not cell text</text:p></draw:frame></table:table-cell>"#,
            r#"<table:table-cell office:value-type="float" office:value="1"><text:p><text:span text:style-name="T1">1</text:span></text:p></table:table-cell>"#,
            r#"</table:table-row></table:table>"#,
        ));
        let sheet = &parser.sheets[0];
        assert_eq!(sheet.links, vec![((0, 0), "https://example.com/".to_owned())]);
        assert_eq!(sheet.notes.len(), 1);
        assert_eq!(sheet.notes[0].author, "Kim");
        assert_eq!(sheet.notes[0].text, "first\nsecond & third");
        assert_eq!(sheet.rich.len(), 1, "a number's span is not rich text");
        let runs = &sheet.rich[0].1;
        // the cell with the link has neither runs nor spacing elements, so
        // its text is left to the value reader
        let texts: Vec<&str> = runs.iter().map(|(_, text)| text.as_str()).collect();
        assert_eq!(texts, vec!["plain ", "bold", "  end\nnext"]);
        assert!(runs[1].0.is_some());
    }

    #[test]
    fn filters_validations_and_conditions_are_collected() {
        let parser = parse(concat!(
            r#"<table:content-validations><table:content-validation table:name="val1" table:condition="of:cell-content-is-in-list(&quot;a&quot;;&quot;b&quot;)" table:allow-empty-cell="false" table:base-cell-address="S.A1"><table:help-message table:title="Pick" table:display="true"><text:p>one of</text:p><text:p>these</text:p></table:help-message><table:error-message table:message-type="warning" table:display="true"><text:p>no</text:p></table:error-message></table:content-validation></table:content-validations>"#,
            r#"<table:table table:name="S">"#,
            r#"<table:table-row table:number-rows-repeated="2"><table:table-cell table:content-validation-name="val1"/></table:table-row>"#,
            r#"<table:table-row><table:table-cell table:content-validation-name="val1"/></table:table-row>"#,
            r##"<calcext:conditional-formats><calcext:conditional-format calcext:target-range-address="S.A1:S.A9"><calcext:condition calcext:apply-style-name="Good" calcext:value="&gt;5" calcext:base-cell-address="S.A1"/><calcext:color-scale><calcext:color-scale-entry calcext:value="0" calcext:type="minimum" calcext:color="#ff0000"/><calcext:color-scale-entry calcext:value="0" calcext:type="maximum" calcext:color="#00ff00"/></calcext:color-scale></calcext:conditional-format></calcext:conditional-formats>"##,
            r#"</table:table>"#,
            r#"<table:database-ranges><table:database-range table:name="__Anonymous_Sheet_DB__0" table:target-range-address="S.A1:S.C9" table:display-filter-buttons="true"><table:filter><table:filter-or><table:filter-condition table:field-number="1" table:operator="=" table:value="x"><table:filter-set-item table:value="x"/><table:filter-set-item table:value="y"/></table:filter-condition></table:filter-or></table:filter></table:database-range></table:database-ranges>"#,
        ));
        let validation = &parser.validations["val1"];
        assert!(!validation.allow_empty);
        assert_eq!(validation.help_title.as_deref(), Some("Pick"));
        assert_eq!(validation.help_text, "one of\nthese");
        assert_eq!(validation.error_text, "no");
        assert_eq!(validation.error_kind, "warning");
        let sheet = &parser.sheets[0];
        assert_eq!(sheet.validations.len(), 1, "three rows, one rectangle");
        assert_eq!((sheet.validations[0].first_row, sheet.validations[0].last_row), (0, 2));
        assert_eq!(sheet.conditional.len(), 1);
        assert_eq!(sheet.conditional[0].entries.len(), 2);
        let range = &parser.ranges[0];
        assert!(range.buttons && range.has_filter);
        assert!(range.conditions[0].or_group.is_some());
        assert_eq!(range.conditions[0].items, vec!["x", "y"]);
    }

    #[test]
    fn range_addresses_are_read_with_and_without_sheet_names() {
        assert_eq!(
            parse_range_address("Sheet1.A1:Sheet1.D10"),
            Some((Some("Sheet1".to_owned()), (0, 0), (9, 3)))
        );
        assert_eq!(
            parse_range_address("$'My sheet.x'.$B$2:.$C$3"),
            Some((Some("My sheet.x".to_owned()), (1, 1), (2, 2)))
        );
        assert_eq!(parse_range_address(".C5"), Some((None, (4, 2), (4, 2))));
        assert_eq!(parse_range_address("nothing"), None);
    }
}
