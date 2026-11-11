//! Pivot tables of an `.ods` document as pivot table parts.
//!
//! The cells a pivot table filled are ordinary cells and arrive with the
//! sheet. This brings the table behind them: where it reads from, which
//! fields sit on rows, columns, pages and in the values, how they are
//! summarised and which members are unticked — so the workbook holds a pivot
//! table that can be refreshed and rearranged instead of a block of numbers.
//!
//! It is the reverse of `ods_pivot`, widened to what other applications
//! write. The parts hold no records: the cache is marked to be rebuilt from
//! the sheet when the workbook is opened, which is how a writer without a
//! pivot engine hands a pivot table to Excel. A pivot table this cannot say
//! in full — another kind of source, grouping, a filtered source, a header
//! that is no field name — is left out whole; its cells are still there.

use crate::odf_sheet_format::{parse_cell_address, parse_range_address, split_addresses};
use crate::xlsx_package::{PackageExtras, PartRelationship, cell_reference, escape_xml};

/// A document full of pivot tables is still a finite list.
const MAX_PIVOTS: usize = 1_000;
const MAX_FIELDS: usize = 16_384;
/// The members one field may list. Past this the list is not one a person
/// ticked by hand, and the pivot table is left out rather than half read.
const MAX_MEMBERS: usize = 10_000;
/// The longest text Excel keeps in a cache without flagging it.
const LONG_TEXT: usize = 255;

const PIVOT_TABLE_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotTable+xml";
const PIVOT_CACHE_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.pivotCacheDefinition+xml";
const PIVOT_TABLE_RELATIONSHIP: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable";
const PIVOT_CACHE_RELATIONSHIP: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotCacheDefinition";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Orientation {
    Row,
    Column,
    Page,
    Data,
    #[default]
    Hidden,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PivotMember {
    pub(crate) name: String,
    /// False for a member the user unticked.
    pub(crate) display: bool,
    /// False for a member whose details are folded away.
    pub(crate) details: bool,
}

/// One `table:data-pilot-field`.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct PivotField {
    pub(crate) name: String,
    pub(crate) orientation: Orientation,
    pub(crate) function: String,
    /// The place of the values among the row or column fields.
    pub(crate) data_layout: bool,
    pub(crate) display_name: Option<String>,
    pub(crate) selected_page: Option<String>,
    pub(crate) subtotals: Vec<String>,
    pub(crate) members: Vec<PivotMember>,
    pub(crate) show_empty: bool,
    /// `Some(descending)` for a field sorted by its member names.
    pub(crate) sort_by_name: Option<bool>,
    pub(crate) layout: Option<String>,
    pub(crate) blank_lines: bool,
    /// How the value is shown (`row-percentage`, …), when not as it is.
    pub(crate) reference: Option<String>,
}

/// One `table:data-pilot-table`.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct OdfPivot {
    pub(crate) name: String,
    pub(crate) target: String,
    pub(crate) buttons: String,
    pub(crate) grand_total: Option<String>,
    /// The filter button a reader puts above the table; it takes a row.
    pub(crate) filter_button: bool,
    /// The cell range the table reads, when that is its source.
    pub(crate) source: Option<String>,
    /// Something the workbook's pivot table cannot say.
    pub(crate) unsupported: bool,
    pub(crate) fields: Vec<PivotField>,
}

impl Default for OdfPivot {
    fn default() -> Self {
        Self {
            name: String::new(),
            target: String::new(),
            buttons: String::new(),
            grand_total: None,
            // ODF's default: a table that does not say has the button.
            filter_button: true,
            source: None,
            unsupported: false,
            fields: Vec::new(),
        }
    }
}

/// Collects the pivot tables while `content.xml` is streamed. It is handed
/// every element inside `table:data-pilot-tables`, by local name.
#[derive(Default)]
pub(crate) struct PivotReader {
    active: bool,
    pivot: Option<OdfPivot>,
    field: Option<PivotField>,
    in_source: bool,
    pub(crate) pivots: Vec<OdfPivot>,
}

impl PivotReader {
    pub(crate) fn active(&self) -> bool {
        self.active
    }

    pub(crate) fn start(&mut self, name: &[u8], attributes: &[(Vec<u8>, String)], empty: bool) {
        let get = |key: &[u8]| {
            attributes
                .iter()
                .find(|(name, _)| name.as_slice() == key)
                .map(|(_, value)| value.as_str())
        };
        match name {
            b"data-pilot-tables" => self.active = !empty,
            b"data-pilot-table" => {
                let mut pivot = OdfPivot {
                    name: get(b"name").unwrap_or_default().to_owned(),
                    target: get(b"target-range-address").unwrap_or_default().to_owned(),
                    buttons: get(b"buttons").unwrap_or_default().to_owned(),
                    grand_total: get(b"grand-total").map(str::to_owned),
                    ..OdfPivot::default()
                };
                if let Some(value) = get(b"show-filter-button") {
                    pivot.filter_button = value != "false";
                }
                if empty {
                    self.push(pivot);
                } else {
                    self.pivot = Some(pivot);
                }
            }
            b"source-cell-range" => {
                if let Some(pivot) = &mut self.pivot {
                    // A named range is a source the header row cannot be
                    // read from here.
                    if get(b"name").is_some_and(|name| !name.is_empty()) {
                        pivot.unsupported = true;
                    }
                    pivot.source = get(b"cell-range-address").map(str::to_owned);
                }
                self.in_source = !empty;
            }
            // The source is narrowed before the table sees it; a workbook's
            // pivot table has no place for that.
            b"filter" | b"filter-and" | b"filter-or" | b"filter-condition" if self.in_source => {
                self.unsupported();
            }
            b"database-source-sql"
            | b"database-source-table"
            | b"database-source-query"
            | b"source-service"
            | b"data-pilot-groups"
            | b"data-pilot-group" => self.unsupported(),
            b"data-pilot-display-info" => {
                // Showing only the top or bottom members.
                if get(b"enabled") == Some("true") {
                    self.unsupported();
                }
            }
            b"data-pilot-field" => {
                let field = PivotField {
                    name: get(b"source-field-name").unwrap_or_default().to_owned(),
                    orientation: match get(b"orientation") {
                        Some("row") => Orientation::Row,
                        Some("column") => Orientation::Column,
                        Some("page") => Orientation::Page,
                        Some("data") => Orientation::Data,
                        _ => Orientation::Hidden,
                    },
                    function: get(b"function").unwrap_or("auto").to_owned(),
                    data_layout: get(b"is-data-layout-field") == Some("true"),
                    display_name: get(b"display-name")
                        .filter(|name| !name.is_empty())
                        .map(str::to_owned),
                    selected_page: get(b"selected-page")
                        .filter(|page| {
                            !page.is_empty() && get(b"ignore-selected-page") != Some("true")
                        })
                        .map(str::to_owned),
                    ..PivotField::default()
                };
                if empty {
                    self.push_field(field);
                } else {
                    self.field = Some(field);
                }
            }
            b"data-pilot-field-reference" => {
                if let Some(field) = &mut self.field {
                    field.reference = get(b"type")
                        .filter(|kind| *kind != "none")
                        .map(str::to_owned);
                }
            }
            b"data-pilot-level" => {
                if let Some(field) = &mut self.field {
                    field.show_empty = get(b"show-empty") == Some("true");
                }
            }
            b"data-pilot-subtotal" => {
                if let Some(field) = &mut self.field {
                    field
                        .subtotals
                        .push(get(b"function").unwrap_or("auto").to_owned());
                }
            }
            b"data-pilot-member" => {
                let mut overflow = false;
                if let Some(field) = &mut self.field {
                    if field.members.len() < MAX_MEMBERS {
                        field.members.push(PivotMember {
                            name: get(b"name").unwrap_or_default().to_owned(),
                            display: get(b"display") != Some("false"),
                            details: get(b"show-details") != Some("false"),
                        });
                    } else {
                        overflow = true;
                    }
                }
                if overflow {
                    self.unsupported();
                }
            }
            b"data-pilot-sort-info" => {
                if let Some(field) = &mut self.field {
                    if get(b"sort-mode") == Some("name") {
                        field.sort_by_name = Some(get(b"order") == Some("descending"));
                    }
                }
            }
            b"data-pilot-layout-info" => {
                if let Some(field) = &mut self.field {
                    // A reader with a layout the standard has no word for
                    // writes the nearest standard one and its own beside it.
                    let modes = || {
                        attributes
                            .iter()
                            .filter(|(name, _)| name.as_slice() == b"layout-mode")
                            .map(|(_, value)| value.as_str())
                    };
                    field.layout = modes()
                        .find(|mode| *mode == "compact-layout")
                        .or_else(|| modes().next())
                        .map(str::to_owned);
                    field.blank_lines = get(b"add-empty-lines") == Some("true");
                }
            }
            _ => {}
        }
    }

    pub(crate) fn end(&mut self, name: &[u8]) {
        match name {
            b"data-pilot-tables" => self.active = false,
            b"data-pilot-table" => {
                if let Some(pivot) = self.pivot.take() {
                    self.push(pivot);
                }
                self.field = None;
                self.in_source = false;
            }
            b"source-cell-range" => self.in_source = false,
            b"data-pilot-field" => {
                if let Some(field) = self.field.take() {
                    self.push_field(field);
                }
            }
            _ => {}
        }
    }

    fn unsupported(&mut self) {
        if let Some(pivot) = &mut self.pivot {
            pivot.unsupported = true;
        }
    }

    fn push_field(&mut self, field: PivotField) {
        if let Some(pivot) = &mut self.pivot {
            if pivot.fields.len() < MAX_FIELDS {
                pivot.fields.push(field);
            } else {
                pivot.unsupported = true;
            }
        }
    }

    fn push(&mut self, pivot: OdfPivot) {
        if self.pivots.len() < MAX_PIVOTS {
            self.pivots.push(pivot);
        }
    }
}

/// What one cell of a source range holds, as far as a pivot cares.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum SourceCell<'a> {
    Empty,
    Text(&'a str),
    Number(f64),
    Other,
}

type Corner = (u32, u32);

/// What the cells under a header hold, for the columns whose members the
/// document names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ColumnKind {
    /// Not looked at: no pivot table names a member of it.
    Unread,
    Text,
    Number,
    /// Both, or dates, booleans and errors.
    Mixed,
}

/// A pivot table with its addresses resolved against the workbook's sheets,
/// waiting for the header row of its source.
struct Plan {
    pivot: OdfPivot,
    source_sheet: usize,
    source: (Corner, Corner),
    target_sheet: usize,
    target: (Corner, Corner),
    /// The header of each source column and what the column holds — read
    /// when the source sheet goes by.
    columns: Option<Vec<(Option<String>, ColumnKind)>>,
}

/// The pivot tables of a document on their way into the workbook.
#[derive(Default)]
pub(crate) struct Pivots {
    plans: Vec<Plan>,
}

fn sheet_index(sheets: &[String], name: Option<&str>) -> Option<usize> {
    let name = name?;
    sheets.iter().position(|sheet| sheet == name)
}

impl Pivots {
    /// Keeps the pivot tables that read a cell range of this workbook and
    /// write to one of its sheets.
    pub(crate) fn new(pivots: Vec<OdfPivot>, sheets: &[String]) -> Self {
        let plans = pivots
            .into_iter()
            .filter(|pivot| !pivot.unsupported)
            .filter_map(|pivot| {
                let (source_name, source_first, source_last) =
                    parse_range_address(pivot.source.as_deref()?)?;
                let (target_name, target_first, target_last) = parse_range_address(&pivot.target)?;
                let source_sheet = sheet_index(sheets, source_name.as_deref())?;
                let target_sheet = sheet_index(sheets, target_name.as_deref())?;
                // A header row and at least one row under it.
                (source_last.0 > source_first.0).then_some(Plan {
                    pivot,
                    source_sheet,
                    source: (source_first, source_last),
                    target_sheet,
                    target: (target_first, target_last),
                    columns: None,
                })
            })
            .collect();
        Self { plans }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.plans.is_empty()
    }

    /// Reads what the pivot tables need from one sheet while its cells are
    /// at hand: the header row of every source range on it, and what the
    /// columns whose members the document names hold.
    pub(crate) fn observe<'a>(
        &mut self,
        sheet: usize,
        cell: impl Fn(u32, u32) -> SourceCell<'a>,
    ) {
        for plan in self.plans.iter_mut().filter(|plan| plan.source_sheet == sheet) {
            let ((top, left), (bottom, right)) = plan.source;
            let mut columns = Vec::new();
            for column in left..=right {
                let header = match cell(top, column) {
                    SourceCell::Text(text) if !text.is_empty() => Some(text.to_owned()),
                    // A number in the header row is named the way it is
                    // written when it is a whole one; a date or a fraction
                    // is shown through a format this cannot repeat.
                    SourceCell::Number(number)
                        if number.fract() == 0.0 && number.abs() < 1e15 =>
                    {
                        Some(format!("{number:.0}"))
                    }
                    _ => None,
                };
                let wanted = header.as_deref().is_some_and(|header| {
                    plan.pivot.fields.iter().any(|field| {
                        field.name == header
                            && !field.members.is_empty()
                            && !matches!(field.orientation, Orientation::Data | Orientation::Hidden)
                    })
                });
                let mut kind = ColumnKind::Unread;
                if wanted {
                    let (mut text, mut number, mut other) = (false, false, false);
                    for row in top + 1..=bottom {
                        match cell(row, column) {
                            SourceCell::Text(_) => text = true,
                            SourceCell::Number(_) => number = true,
                            SourceCell::Other => other = true,
                            SourceCell::Empty => {}
                        }
                        if other || (text && number) {
                            break;
                        }
                    }
                    kind = match (text, number, other) {
                        (_, false, false) => ColumnKind::Text,
                        (false, true, false) => ColumnKind::Number,
                        _ => ColumnKind::Mixed,
                    };
                }
                columns.push((header, kind));
            }
            plan.columns = Some(columns);
        }
    }

    /// Adds the parts of every pivot table that can be said in full to the
    /// package: the table beside its sheet, the cache beside the workbook.
    pub(crate) fn write(self, sheets: &[String], extras: &mut PackageExtras) {
        let mut number = 0u32;
        let mut names: Vec<(usize, String)> = Vec::new();
        for plan in self.plans {
            let Some(columns) = plan.columns.as_ref() else {
                continue;
            };
            // Excel tells the pivot tables of a sheet apart by name.
            let mut name = if plan.pivot.name.trim().is_empty() {
                "PivotTable".to_owned()
            } else {
                plan.pivot.name.clone()
            };
            let taken = |candidate: &str, names: &[(usize, String)]| {
                names.iter().any(|(sheet, name)| {
                    *sheet == plan.target_sheet && name.eq_ignore_ascii_case(candidate)
                })
            };
            if taken(&name, &names) {
                let base = name.clone();
                let mut suffix = 2;
                while taken(&format!("{base} {suffix}"), &names) {
                    suffix += 1;
                }
                name = format!("{base} {suffix}");
            }
            let Some(source_sheet) = sheets.get(plan.source_sheet) else {
                continue;
            };
            let Some((cache, table)) = parts(&plan, columns, &name, source_sheet, number + 1)
            else {
                continue;
            };
            number += 1;
            names.push((plan.target_sheet, name));
            while extras.sheets.len() <= plan.target_sheet {
                extras.sheets.push(Default::default());
            }
            let sheet = &mut extras.sheets[plan.target_sheet];
            sheet.relationships.push(PartRelationship {
                id: format!("rIdPivot{number}"),
                kind: PIVOT_TABLE_RELATIONSHIP,
                target: format!("../pivotTables/pivotTable{number}.xml"),
                external: false,
            });
            sheet.parts.push((
                format!("xl/pivotTables/pivotTable{number}.xml"),
                Some(PIVOT_TABLE_TYPE),
                table.into_bytes(),
            ));
            sheet.parts.push((
                format!("xl/pivotTables/_rels/pivotTable{number}.xml.rels"),
                None,
                format!(
                    r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="{PIVOT_CACHE_RELATIONSHIP}" Target="../pivotCache/pivotCacheDefinition{number}.xml"/></Relationships>"#
                )
                .into_bytes(),
            ));
            sheet.parts.push((
                format!("xl/pivotCache/pivotCacheDefinition{number}.xml"),
                Some(PIVOT_CACHE_TYPE),
                cache.into_bytes(),
            ));
            extras.pivot_caches.push((
                number,
                format!("pivotCache/pivotCacheDefinition{number}.xml"),
            ));
        }
    }
}

/// The word a data field's function has in a workbook; `None` for one a
/// workbook does not have. A sum is the default and is not written.
fn data_function(function: &str) -> Option<Option<&'static str>> {
    Some(match function {
        "sum" | "auto" => None,
        "count" => Some("count"),
        "average" => Some("average"),
        "max" => Some("max"),
        "min" => Some("min"),
        "product" => Some("product"),
        "countnums" => Some("countNums"),
        "stdev" => Some("stdDev"),
        "stdevp" => Some("stdDevp"),
        "var" => Some("var"),
        "varp" => Some("varp"),
        _ => return None,
    })
}

/// What Excel calls a data field summarised by `function` before the user
/// renames it.
pub(crate) fn data_caption(function: &str, field: &str) -> String {
    let word = match function {
        "count" | "countnums" => "Count",
        "average" => "Average",
        "max" => "Max",
        "min" => "Min",
        "product" => "Product",
        "stdev" => "StdDev",
        "stdevp" => "StdDevp",
        "var" => "Var",
        "varp" => "Varp",
        _ => "Sum",
    };
    format!("{word} of {field}")
}

/// A subtotal function as the attribute that switches it on and the kind of
/// the item that stands for it. `None` for one a workbook does not have.
fn subtotal(function: &str) -> Option<(Option<&'static str>, &'static str)> {
    Some(match function {
        "auto" => (None, "default"),
        "sum" => (Some("sumSubtotal"), "sum"),
        "count" => (Some("countASubtotal"), "countA"),
        "average" => (Some("avgSubtotal"), "avg"),
        "max" => (Some("maxSubtotal"), "max"),
        "min" => (Some("minSubtotal"), "min"),
        "product" => (Some("productSubtotal"), "product"),
        "countnums" => (Some("countSubtotal"), "count"),
        "stdev" => (Some("stdDevSubtotal"), "stdDev"),
        "stdevp" => (Some("stdDevPSubtotal"), "stdDevP"),
        "var" => (Some("varSubtotal"), "var"),
        "varp" => (Some("varPSubtotal"), "varP"),
        _ => return None,
    })
}

/// How a value is shown instead of as it is; `None` for a way that needs a
/// base member this does not carry.
fn show_data_as(reference: &str) -> Option<&'static str> {
    Some(match reference {
        "row-percentage" => "percentOfRow",
        "column-percentage" => "percentOfCol",
        "total-percentage" => "percentOfTotal",
        "index" => "index",
        _ => return None,
    })
}

/// XML cannot carry control characters.
fn printable(text: &str) -> String {
    text.chars()
        .filter(|character| *character == '\t' || (*character as u32) >= 0x20)
        .collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Layout {
    Compact,
    Outline { subtotals_on_top: bool },
    Tabular,
}

/// The cache definition and the pivot table definition of one pivot table,
/// or `None` when it cannot be said in full.
fn parts(
    plan: &Plan,
    columns: &[(Option<String>, ColumnKind)],
    name: &str,
    source_sheet: &str,
    cache_id: u32,
) -> Option<(String, String)> {
    let pivot = &plan.pivot;

    // ---- the fields of the source: one per column, named by its header
    let headers: Vec<&str> = columns
        .iter()
        .map(|(header, _)| header.as_deref())
        .collect::<Option<_>>()?;
    // Excel takes field names without regard to case.
    for (index, header) in headers.iter().enumerate() {
        if headers[..index]
            .iter()
            .any(|earlier| earlier.to_lowercase() == header.to_lowercase())
        {
            return None;
        }
    }
    let index_of = |name: &str| headers.iter().position(|header| *header == name);

    // ---- where each field sits
    let mut axis: Vec<Option<&PivotField>> = vec![None; headers.len()];
    let mut rows: Vec<i64> = Vec::new();
    let mut cols: Vec<i64> = Vec::new();
    let mut pages: Vec<usize> = Vec::new();
    let mut data: Vec<(usize, &PivotField)> = Vec::new();
    for field in &pivot.fields {
        if field.data_layout {
            match field.orientation {
                Orientation::Row => rows.push(-2),
                Orientation::Column => cols.push(-2),
                _ => {}
            }
            continue;
        }
        if field.orientation == Orientation::Hidden {
            continue;
        }
        let index = index_of(&field.name)?;
        if field.orientation == Orientation::Data {
            data.push((index, field));
            continue;
        }
        // A field sits on one axis, once.
        if axis[index].is_some() {
            return None;
        }
        axis[index] = Some(field);
        match field.orientation {
            Orientation::Row => rows.push(index as i64),
            Orientation::Column => cols.push(index as i64),
            _ => pages.push(index),
        }
    }
    if rows.is_empty() && cols.is_empty() && data.is_empty() {
        return None;
    }
    // Several values need a place among the rows or the columns; one value
    // has none. A document that names several and no place has them down
    // the rows, after the row fields.
    if data.len() > 1 {
        if !rows.contains(&-2) && !cols.contains(&-2) {
            rows.push(-2);
        }
    } else {
        rows.retain(|index| *index != -2);
        cols.retain(|index| *index != -2);
    }
    let data_on_rows = rows.contains(&-2);
    let row_fields = rows.iter().filter(|index| **index >= 0).count();
    let column_fields = cols.iter().filter(|index| **index >= 0).count();

    // ---- how the row fields are laid out. A document that does not say has
    // ODF's default: every row field in a column of its own.
    let layout = axis
        .iter()
        .flatten()
        .find_map(|field| field.layout.as_deref())
        .map_or(Layout::Tabular, |mode| match mode {
            "compact-layout" => Layout::Compact,
            "outline-subtotals-top" => Layout::Outline {
                subtotals_on_top: true,
            },
            "outline-subtotals-bottom" => Layout::Outline {
                subtotals_on_top: false,
            },
            _ => Layout::Tabular,
        });

    // ---- where the table is written
    let ((top, left), (bottom, right)) = plan.target;
    // Page fields sit above the table, one per row, with a blank row between
    // them and it; a reader's filter button takes one more row above those.
    let above = if pivot.filter_button || !pages.is_empty() {
        pages.len() as u32 + 1 + u32::from(pivot.filter_button)
    } else {
        0
    };
    let first_row = top.checked_add(above)?;
    if first_row > bottom {
        return None;
    }
    // The buttons say where the headers end and the values begin: the first
    // row field's button is in the table's first column on the last header
    // row, and the column fields' buttons are in its first row from the
    // first value column on.
    let buttons: Vec<Corner> = split_addresses(&pivot.buttons)
        .into_iter()
        .filter_map(|address| parse_cell_address(address).map(|(_, cell)| cell))
        .filter(|(row, column)| {
            (first_row..=bottom).contains(row) && (left..=right).contains(column)
        })
        .collect();
    let default_data_row = 1 + cols.len() as u32;
    let first_data_row = buttons
        .iter()
        .filter(|(_, column)| row_fields > 0 && *column == left)
        .map(|(row, _)| row - first_row + 1)
        .min()
        .unwrap_or(default_data_row)
        .min(bottom - first_row + 1);
    let default_data_column = match layout {
        Layout::Compact => 1,
        _ => rows.len().max(1) as u32,
    };
    let first_data_column = buttons
        .iter()
        .filter(|(row, column)| column_fields > 0 && *row == first_row && *column > left)
        .map(|(_, column)| column - left)
        .min()
        .unwrap_or(default_data_column)
        .clamp(1, (right - left).max(1));
    let first_header_row = u32::from(first_data_row >= 2 || !(column_fields == 0 && cols.len() == 1));

    // ---- the cache: the fields, and the members the document names
    let mut carried_members = vec![false; headers.len()];
    let mut cache_fields = String::new();
    let mut pivot_fields = String::new();
    for (index, header) in headers.iter().enumerate() {
        let field = axis[index];
        // Members are carried where the cache can name them the way the
        // column holds them: as text in a column of text, as numbers in a
        // column of numbers whose members are written as plain numbers. A
        // member named through a format (a date, `1,234.50`) has no such
        // name; if one of those is unticked the table cannot be said.
        let listed: &[PivotMember] = field.map_or(&[], |field| &field.members);
        let values: Option<Vec<Option<f64>>> = listed
            .iter()
            .map(|member| {
                if member.name.is_empty() {
                    return Some(None);
                }
                let plain = member
                    .name
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'E' | b'e'));
                member
                    .name
                    .parse::<f64>()
                    .ok()
                    .filter(|value| plain && value.is_finite())
                    .map(Some)
            })
            .collect();
        let numbers = match (columns[index].1, values) {
            (ColumnKind::Number, Some(values)) => Some(values),
            _ => None,
        };
        let members: &[PivotMember] = match columns[index].1 {
            ColumnKind::Text => listed,
            ColumnKind::Number if numbers.is_some() => listed,
            _ if listed.iter().any(|member| !member.display) => return None,
            _ => &[],
        };
        let mut shared = String::new();
        let blank = members.iter().any(|member| member.name.is_empty());
        let shared_items = if members.is_empty() {
            "<sharedItems/>".to_owned()
        } else if let Some(values) = &numbers {
            for value in values {
                match value {
                    Some(value) => shared.push_str(&format!(r#"<n v="{value}"/>"#)),
                    None => shared.push_str("<m/>"),
                }
            }
            let known: Vec<f64> = values.iter().flatten().copied().collect();
            let range = if known.is_empty() {
                String::new()
            } else {
                format!(
                    r#"{} minValue="{}" maxValue="{}""#,
                    if known.iter().all(|value| value.fract() == 0.0) {
                        r#" containsInteger="1""#
                    } else {
                        ""
                    },
                    known.iter().copied().fold(f64::INFINITY, f64::min),
                    known.iter().copied().fold(f64::NEG_INFINITY, f64::max),
                )
            };
            format!(
                r#"<sharedItems containsSemiMixedTypes="0" containsString="0"{} containsNumber="1"{range} count="{}">{shared}</sharedItems>"#,
                if blank { r#" containsBlank="1""# } else { "" },
                members.len()
            )
        } else {
            let long = members
                .iter()
                .any(|member| member.name.chars().count() > LONG_TEXT);
            for member in members {
                if member.name.is_empty() {
                    shared.push_str("<m/>");
                } else {
                    shared.push_str(&format!(
                        r#"<s v="{}"/>"#,
                        escape_xml(&printable(&member.name))
                    ));
                }
            }
            format!(
                r#"<sharedItems{}{} count="{}">{shared}</sharedItems>"#,
                if blank { r#" containsBlank="1""# } else { "" },
                if long { r#" longText="1""# } else { "" },
                members.len()
            )
        };
        let carried = !members.is_empty();
        cache_fields.push_str(&format!(
            r#"<cacheField name="{}" numFmtId="0">{shared_items}</cacheField>"#,
            escape_xml(&printable(header))
        ));

        let mut attributes = String::new();
        let mut items = String::new();
        if let Some(field) = field {
            if let Some(caption) = field.display_name.as_deref() {
                attributes.push_str(&format!(
                    r#" name="{}""#,
                    escape_xml(&printable(caption))
                ));
            }
            attributes.push_str(match field.orientation {
                Orientation::Row => r#" axis="axisRow""#,
                Orientation::Column => r#" axis="axisCol""#,
                _ => r#" axis="axisPage""#,
            });
        }
        if data.iter().any(|(data_index, _)| *data_index == index) {
            attributes.push_str(r#" dataField="1""#);
        }
        match layout {
            Layout::Compact => {}
            Layout::Outline { subtotals_on_top } => {
                attributes.push_str(r#" compact="0""#);
                if !subtotals_on_top {
                    attributes.push_str(r#" subtotalTop="0""#);
                }
            }
            Layout::Tabular => attributes.push_str(r#" compact="0" outline="0""#),
        }
        attributes.push_str(if field.is_some_and(|field| field.show_empty) {
            r#" showAll="1""#
        } else {
            r#" showAll="0""#
        });
        if let Some(field) = field {
            if field.blank_lines {
                attributes.push_str(r#" insertBlankRow="1""#);
            }
            match field.sort_by_name {
                Some(true) => attributes.push_str(r#" sortType="descending""#),
                Some(false) => attributes.push_str(r#" sortType="ascending""#),
                None => {}
            }
            // The member a page field shows is looked up further down, in
            // the list the cache carries.
            if carried {
                carried_members[index] = true;
            }
            if field.orientation == Orientation::Page
                && members.iter().any(|member| !member.display)
            {
                attributes.push_str(r#" multipleItemSelectionAllowed="1""#);
            }
            let mut count = 0;
            for (position, member) in members.iter().enumerate() {
                items.push_str(&format!(
                    r#"<item{}{} x="{position}"/>"#,
                    if member.display { "" } else { r#" h="1""# },
                    if member.details { "" } else { r#" sd="0""# },
                ));
                count += 1;
            }
            let mut automatic = false;
            for function in &field.subtotals {
                let (attribute, kind) = subtotal(function)?;
                match attribute {
                    Some(attribute) => attributes.push_str(&format!(r#" {attribute}="1""#)),
                    None => automatic = true,
                }
                items.push_str(&format!(r#"<item t="{kind}"/>"#));
                count += 1;
            }
            if !automatic {
                attributes.push_str(r#" defaultSubtotal="0""#);
            }
            // A field on an axis has a list of items; one that names none
            // gets the single placeholder Excel replaces when it rebuilds
            // the cache.
            if count == 0 {
                items.push_str(r#"<item t="default"/>"#);
                count = 1;
            }
            items = format!(r#"<items count="{count}">{items}</items>"#);
        }
        if items.is_empty() {
            pivot_fields.push_str(&format!("<pivotField{attributes}/>"));
        } else {
            pivot_fields.push_str(&format!("<pivotField{attributes}>{items}</pivotField>"));
        }
    }

    let ((source_top, source_left), (source_bottom, source_right)) = plan.source;
    let cache = format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            "\n",
            r#"<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" saveData="0" refreshOnLoad="1" createdVersion="3" refreshedVersion="3" minRefreshableVersion="3">"#,
            r#"<cacheSource type="worksheet"><worksheetSource ref="{}:{}" sheet="{}"/></cacheSource>"#,
            r#"<cacheFields count="{}">{}</cacheFields></pivotCacheDefinition>"#,
        ),
        cell_reference(source_top, source_left),
        cell_reference(source_bottom, source_right),
        escape_xml(&printable(source_sheet)),
        headers.len(),
        cache_fields,
    );

    // ---- the table
    let axis_fields = |element: &str, fields: &[i64]| -> String {
        if fields.is_empty() {
            return String::new();
        }
        let entries: String = fields
            .iter()
            .map(|index| format!(r#"<field x="{index}"/>"#))
            .collect();
        format!(r#"<{element} count="{}">{entries}</{element}>"#, fields.len())
    };
    // The rows and columns the table had when it was last laid out. Excel
    // lays it out again from the rebuilt cache; these stand in until then.
    let row_items = format!(
        r#"<rowItems count="1"><i>{}</i></rowItems>"#,
        "<x/>".repeat(rows.len())
    );
    let col_items = r#"<colItems count="1"><i/></colItems>"#;
    let page_fields = if pages.is_empty() {
        String::new()
    } else {
        let mut entries = String::new();
        for index in &pages {
            let field = axis[*index]?;
            // The one member a page field shows, when the document names one
            // this carried into the cache.
            let item = field
                .selected_page
                .as_deref()
                .filter(|_| carried_members[*index])
                .and_then(|page| field.members.iter().position(|member| member.name == page))
                .map(|position| format!(r#" item="{position}""#))
                .unwrap_or_default();
            entries.push_str(&format!(r#"<pageField fld="{index}"{item} hier="-1"/>"#));
        }
        format!(r#"<pageFields count="{}">{entries}</pageFields>"#, pages.len())
    };
    let mut data_fields = String::new();
    let mut captions: Vec<String> = Vec::new();
    for (index, field) in &data {
        let function = data_function(&field.function)?;
        let mut caption = field
            .display_name
            .clone()
            .unwrap_or_else(|| data_caption(&field.function, headers[*index]));
        // A data field's name is its own: not a source field's, not another
        // data field's.
        let clashes = |caption: &str, captions: &[String]| {
            let lower = caption.to_lowercase();
            captions.iter().any(|other| other.to_lowercase() == lower)
                || headers.iter().any(|header| header.to_lowercase() == lower)
        };
        if clashes(&caption, &captions) {
            let base = caption.clone();
            let mut suffix = 2;
            while clashes(&format!("{base} {suffix}"), &captions) {
                suffix += 1;
            }
            caption = format!("{base} {suffix}");
        }
        let shown = match field.reference.as_deref() {
            Some(reference) => format!(r#" showDataAs="{}""#, show_data_as(reference)?),
            None => String::new(),
        };
        data_fields.push_str(&format!(
            r#"<dataField name="{}" fld="{index}"{}{shown} baseField="0" baseItem="0"/>"#,
            escape_xml(&printable(&caption)),
            function
                .map(|function| format!(r#" subtotal="{function}""#))
                .unwrap_or_default(),
        ));
        captions.push(caption);
    }
    let data_fields = if data.is_empty() {
        String::new()
    } else {
        format!(r#"<dataFields count="{}">{data_fields}</dataFields>"#, data.len())
    };

    // ODF names the grand totals by what they total, as `ods_pivot` writes
    // them: "row" keeps Excel's totals for rows.
    let (row_totals, column_totals) = match pivot.grand_total.as_deref() {
        Some("row") => (true, false),
        Some("column") => (false, true),
        Some("none") => (false, false),
        _ => (true, true),
    };
    let mut attributes = String::new();
    if data_on_rows {
        attributes.push_str(r#" dataOnRows="1""#);
    }
    if !row_totals {
        attributes.push_str(r#" rowGrandTotals="0""#);
    }
    if !column_totals {
        attributes.push_str(r#" colGrandTotals="0""#);
    }
    match layout {
        Layout::Compact => {}
        Layout::Outline { .. } => attributes.push_str(r#" compact="0" compactData="0""#),
        Layout::Tabular => attributes.push_str(r#" compact="0" compactData="0" outline="0" outlineData="0""#),
    }
    let page_counts = if pages.is_empty() {
        String::new()
    } else {
        format!(r#" rowPageCount="{}" colPageCount="1""#, pages.len())
    };
    let table = format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            "\n",
            r#"<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="{}" cacheId="{}" applyNumberFormats="0" applyBorderFormats="0" applyFontFormats="0" applyPatternFormats="0" applyAlignmentFormats="0" applyWidthHeightFormats="1" dataCaption="Values" updatedVersion="3" minRefreshableVersion="3" useAutoFormatting="1" itemPrintTitles="1" createdVersion="3" indent="0"{}>"#,
            r#"<location ref="{}:{}" firstHeaderRow="{}" firstDataRow="{}" firstDataCol="{}"{}/>"#,
            r#"<pivotFields count="{}">{}</pivotFields>{}{}{}{}{}{}"#,
            // No style is named: the cells already carry the look the document
            // gave them, and a named style would draw its bands over it.
            r#"<pivotTableStyleInfo showRowHeaders="1" showColHeaders="1" showRowStripes="0" showColStripes="0" showLastColumn="1"/>"#,
            r#"</pivotTableDefinition>"#,
        ),
        escape_xml(&printable(name)),
        cache_id,
        attributes,
        cell_reference(first_row, left),
        cell_reference(bottom, right),
        first_header_row,
        first_data_row,
        first_data_column,
        page_counts,
        headers.len(),
        pivot_fields,
        axis_fields("rowFields", &rows),
        row_items,
        axis_fields("colFields", &cols),
        col_items,
        page_fields,
        data_fields,
    );
    Some((cache, table))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(elements: &[(&str, &[(&str, &str)], bool)]) -> Vec<OdfPivot> {
        let mut reader = PivotReader::default();
        // Each entry is an element start (`true` for an empty element); a
        // name starting with `/` is an end.
        for (name, attributes, empty) in elements {
            if let Some(name) = name.strip_prefix('/') {
                reader.end(name.as_bytes());
                continue;
            }
            let attributes: Vec<(Vec<u8>, String)> = attributes
                .iter()
                .map(|(key, value)| (key.as_bytes().to_vec(), (*value).to_owned()))
                .collect();
            reader.start(name.as_bytes(), &attributes, *empty);
        }
        reader.pivots
    }

    fn field(name: &str, orientation: Orientation) -> PivotField {
        PivotField {
            name: name.into(),
            orientation,
            function: "auto".into(),
            ..PivotField::default()
        }
    }

    fn sales() -> OdfPivot {
        OdfPivot {
            name: "Sales & plan".into(),
            target: "Pivot.A4:Pivot.D11".into(),
            buttons: "Pivot.A7 Pivot.B6 Pivot.A4".into(),
            filter_button: false,
            source: Some("'Raw Data'.A1:'Raw Data'.D13".into()),
            fields: vec![
                PivotField {
                    subtotals: vec!["auto".into()],
                    members: vec![PivotMember {
                        name: "West".into(),
                        display: false,
                        details: true,
                    }],
                    layout: Some("compact-layout".into()),
                    ..field("Region", Orientation::Row)
                },
                field("Product", Orientation::Column),
                field("Month", Orientation::Page),
                PivotField {
                    function: "sum".into(),
                    ..field("Amount", Orientation::Data)
                },
            ],
            ..OdfPivot::default()
        }
    }

    const SHEETS: [&str; 2] = ["Raw Data", "Pivot"];

    /// The source sheet of the samples: four text headers, three text
    /// columns and a number column.
    fn source(row: u32, column: u32) -> SourceCell<'static> {
        const HEADERS: [&str; 4] = ["Region", "Product", "Month", "Amount"];
        match (row, column) {
            (0, column) if column < 4 => SourceCell::Text(HEADERS[column as usize]),
            (row, 3) if row <= 12 => SourceCell::Number(f64::from(row)),
            (row, column) if row <= 12 && column < 3 => SourceCell::Text("x"),
            _ => SourceCell::Empty,
        }
    }

    fn written(pivots: Vec<OdfPivot>) -> PackageExtras {
        let sheets: Vec<String> = SHEETS.iter().map(|name| (*name).to_owned()).collect();
        let mut pivots = Pivots::new(pivots, &sheets);
        pivots.observe(0, source);
        let mut extras = PackageExtras::default();
        pivots.write(&sheets, &mut extras);
        extras
    }

    fn part<'a>(extras: &'a PackageExtras, name: &str) -> &'a str {
        extras
            .sheets
            .iter()
            .flat_map(|sheet| &sheet.parts)
            .find(|(part, _, _)| part == name)
            .map(|(_, _, bytes)| std::str::from_utf8(bytes).unwrap())
            .unwrap_or_else(|| panic!("no part {name}"))
    }

    #[test]
    fn reads_a_pivot_table_with_its_fields_and_members() {
        let pivots = read(&[
            ("data-pilot-tables", &[], false),
            (
                "data-pilot-table",
                &[
                    ("name", "Sales"),
                    ("target-range-address", "Pivot.A4:Pivot.E14"),
                    ("buttons", "Pivot.A4 Pivot.A5"),
                    ("grand-total", "row"),
                ],
                false,
            ),
            (
                "source-cell-range",
                &[("cell-range-address", "Data.A1:Data.E13")],
                true,
            ),
            (
                "data-pilot-field",
                &[
                    ("source-field-name", "Region"),
                    ("orientation", "row"),
                    ("function", "auto"),
                ],
                false,
            ),
            ("data-pilot-level", &[("show-empty", "true")], false),
            ("data-pilot-subtotal", &[("function", "auto")], true),
            (
                "data-pilot-member",
                &[("name", "West"), ("display", "false"), ("show-details", "true")],
                true,
            ),
            (
                "data-pilot-sort-info",
                &[("sort-mode", "name"), ("order", "descending")],
                true,
            ),
            (
                "data-pilot-layout-info",
                &[
                    ("layout-mode", "tabular-layout"),
                    ("layout-mode", "compact-layout"),
                    ("add-empty-lines", "true"),
                ],
                true,
            ),
            ("/data-pilot-level", &[], false),
            ("/data-pilot-field", &[], false),
            (
                "data-pilot-field",
                &[
                    ("source-field-name", "Month"),
                    ("orientation", "page"),
                    ("selected-page", "Feb"),
                    ("ignore-selected-page", "true"),
                ],
                true,
            ),
            (
                "data-pilot-field",
                &[
                    ("source-field-name", "Amount"),
                    ("display-name", "Total"),
                    ("orientation", "data"),
                    ("function", "average"),
                ],
                true,
            ),
            ("/data-pilot-table", &[], false),
            ("/data-pilot-tables", &[], false),
        ]);
        assert_eq!(pivots.len(), 1);
        let pivot = &pivots[0];
        assert_eq!(pivot.name, "Sales");
        assert_eq!(pivot.source.as_deref(), Some("Data.A1:Data.E13"));
        assert_eq!(pivot.grand_total.as_deref(), Some("row"));
        // A table that does not say has the filter button.
        assert!(pivot.filter_button);
        assert!(!pivot.unsupported);
        assert_eq!(pivot.fields.len(), 3);
        let region = &pivot.fields[0];
        assert_eq!(region.orientation, Orientation::Row);
        assert!(region.show_empty);
        assert_eq!(region.subtotals, ["auto"]);
        assert_eq!(
            region.members,
            [PivotMember {
                name: "West".into(),
                display: false,
                details: true
            }]
        );
        assert_eq!(region.sort_by_name, Some(true));
        // The reader's own word for the layout wins over the standard one
        // written beside it.
        assert_eq!(region.layout.as_deref(), Some("compact-layout"));
        assert!(region.blank_lines);
        // A page the reader was told to ignore is not a selection.
        assert_eq!(pivot.fields[1].selected_page, None);
        assert_eq!(pivot.fields[2].display_name.as_deref(), Some("Total"));
        assert_eq!(pivot.fields[2].function, "average");
    }

    #[test]
    fn marks_what_a_workbook_cannot_say() {
        let table = |inner: &[(&'static str, &'static [(&'static str, &'static str)], bool)]| {
            let mut elements: Vec<(&str, &[(&str, &str)], bool)> = vec![
                ("data-pilot-tables", &[], false),
                ("data-pilot-table", &[("name", "P")], false),
            ];
            elements.extend_from_slice(inner);
            elements.push(("/data-pilot-table", &[], false));
            read(&elements).remove(0)
        };
        // Read from a database.
        assert!(table(&[("database-source-table", &[], true)]).unsupported);
        // A source narrowed by a filter.
        assert!(
            table(&[
                ("source-cell-range", &[("cell-range-address", "D.A1:D.B9")], false),
                ("filter", &[], false),
                ("/filter", &[], false),
                ("/source-cell-range", &[], false),
            ])
            .unsupported
        );
        // A named range.
        assert!(table(&[("source-cell-range", &[("name", "Sales")], true)]).unsupported);
        // Grouped members, and showing only the top ones.
        assert!(
            table(&[
                ("data-pilot-field", &[("source-field-name", "Date")], false),
                ("data-pilot-groups", &[], true),
                ("/data-pilot-field", &[], false),
            ])
            .unsupported
        );
        assert!(
            table(&[
                ("data-pilot-field", &[("source-field-name", "Date")], false),
                ("data-pilot-display-info", &[("enabled", "true")], true),
                ("/data-pilot-field", &[], false),
            ])
            .unsupported
        );
        assert!(!table(&[("source-cell-range", &[("cell-range-address", "D.A1:D.B9")], true)]).unsupported);
    }

    #[test]
    fn writes_the_cache_the_table_and_their_relationships() {
        let extras = written(vec![sales()]);
        // The table goes beside the sheet it is written on, the cache beside
        // the workbook.
        assert!(extras.sheets[0].relationships.is_empty());
        let relationship = &extras.sheets[1].relationships[0];
        assert_eq!(relationship.id, "rIdPivot1");
        assert_eq!(relationship.target, "../pivotTables/pivotTable1.xml");
        assert_eq!(
            extras.pivot_caches,
            [(1, "pivotCache/pivotCacheDefinition1.xml".to_owned())]
        );
        assert!(
            part(&extras, "xl/pivotTables/_rels/pivotTable1.xml.rels")
                .contains(r#"Target="../pivotCache/pivotCacheDefinition1.xml""#)
        );
        let cache = part(&extras, "xl/pivotCache/pivotCacheDefinition1.xml");
        assert!(
            cache.contains(concat!(
                r#" saveData="0" refreshOnLoad="1" createdVersion="3" refreshedVersion="3" minRefreshableVersion="3">"#,
                r#"<cacheSource type="worksheet"><worksheetSource ref="A1:D13" sheet="Raw Data"/></cacheSource>"#,
                r#"<cacheFields count="4">"#,
                r#"<cacheField name="Region" numFmtId="0"><sharedItems count="1"><s v="West"/></sharedItems></cacheField>"#,
                r#"<cacheField name="Product" numFmtId="0"><sharedItems/></cacheField>"#,
                r#"<cacheField name="Month" numFmtId="0"><sharedItems/></cacheField>"#,
                r#"<cacheField name="Amount" numFmtId="0"><sharedItems/></cacheField>"#,
                r#"</cacheFields></pivotCacheDefinition>"#,
            )),
            "{cache}"
        );
        let table = part(&extras, "xl/pivotTables/pivotTable1.xml");
        assert!(table.contains(r#" name="Sales &amp; plan" cacheId="1" "#), "{table}");
        // The page field and the blank row under it are above the table; the
        // buttons say the values start in the second row and second column.
        assert!(
            table.contains(concat!(
                r#"<location ref="A6:D11" firstHeaderRow="1" firstDataRow="2" firstDataCol="1" rowPageCount="1" colPageCount="1"/>"#,
                r#"<pivotFields count="4">"#,
                r#"<pivotField axis="axisRow" showAll="0"><items count="2"><item h="1" x="0"/><item t="default"/></items></pivotField>"#,
                r#"<pivotField axis="axisCol" showAll="0" defaultSubtotal="0"><items count="1"><item t="default"/></items></pivotField>"#,
                r#"<pivotField axis="axisPage" showAll="0" defaultSubtotal="0"><items count="1"><item t="default"/></items></pivotField>"#,
                r#"<pivotField dataField="1" showAll="0"/>"#,
                r#"</pivotFields>"#,
                r#"<rowFields count="1"><field x="0"/></rowFields><rowItems count="1"><i><x/></i></rowItems>"#,
                r#"<colFields count="1"><field x="1"/></colFields><colItems count="1"><i/></colItems>"#,
                r#"<pageFields count="1"><pageField fld="2" hier="-1"/></pageFields>"#,
                r#"<dataFields count="1"><dataField name="Sum of Amount" fld="3" baseField="0" baseItem="0"/></dataFields>"#,
                r#"<pivotTableStyleInfo "#,
            )),
            "{table}"
        );
    }

    #[test]
    fn several_values_get_a_place_and_layouts_and_totals_are_kept() {
        let mut pivot = sales();
        pivot.name = "Counts".into();
        pivot.target = "Pivot.A21:Pivot.C30".into();
        pivot.buttons = "Pivot.A21 Pivot.A23 Pivot.B23".into();
        pivot.filter_button = true;
        pivot.grand_total = Some("row".into());
        pivot.fields = vec![
            PivotField {
                layout: Some("tabular-layout".into()),
                sort_by_name: Some(false),
                subtotals: vec!["sum".into(), "count".into()],
                ..field("Product", Orientation::Row)
            },
            field("Region", Orientation::Row),
            PivotField {
                function: "count".into(),
                ..field("Amount", Orientation::Data)
            },
            PivotField {
                function: "average".into(),
                display_name: Some("Amount".into()),
                reference: Some("row-percentage".into()),
                ..field("Amount", Orientation::Data)
            },
        ];
        let extras = written(vec![pivot]);
        let table = part(&extras, "xl/pivotTables/pivotTable1.xml");
        // The filter button and the blank row under it are above the table.
        assert!(
            table.contains(r#"<location ref="A23:C30" firstHeaderRow="1" firstDataRow="1" firstDataCol="2"/>"#),
            "{table}"
        );
        assert!(
            table.contains(r#" dataOnRows="1" colGrandTotals="0" compact="0" compactData="0" outline="0" outlineData="0">"#),
            "{table}"
        );
        assert!(
            table.contains(concat!(
                r#"<pivotField axis="axisRow" compact="0" outline="0" showAll="0" sortType="ascending" sumSubtotal="1" countASubtotal="1" defaultSubtotal="0">"#,
                r#"<items count="2"><item t="sum"/><item t="countA"/></items></pivotField>"#,
            )),
            "{table}"
        );
        // Values without a stated place run down the rows after the fields.
        assert!(
            table.contains(r#"<rowFields count="3"><field x="1"/><field x="0"/><field x="-2"/></rowFields><rowItems count="1"><i><x/><x/><x/></i></rowItems><colItems count="1"><i/></colItems>"#),
            "{table}"
        );
        // A caption that is a field's name, or another value's, is told apart.
        assert!(
            table.contains(concat!(
                r#"<dataFields count="2"><dataField name="Count of Amount" fld="3" subtotal="count" baseField="0" baseItem="0"/>"#,
                r#"<dataField name="Amount 2" fld="3" subtotal="average" showDataAs="percentOfRow" baseField="0" baseItem="0"/></dataFields>"#,
            )),
            "{table}"
        );
    }

    #[test]
    fn a_pivot_table_that_cannot_be_said_in_full_is_left_out() {
        let none = |pivot: OdfPivot| {
            let extras = written(vec![pivot]);
            extras.pivot_caches.is_empty()
                && extras.sheets.iter().all(|sheet| sheet.parts.is_empty())
        };
        assert!(!none(sales()));
        // A field the source has no column for.
        let mut pivot = sales();
        pivot.fields[1].name = "Colour".into();
        assert!(none(pivot));
        // One field on two axes.
        let mut pivot = sales();
        pivot.fields[1].name = "Region".into();
        assert!(none(pivot));
        // A function, a subtotal or a way of showing a workbook has no word for.
        let mut pivot = sales();
        pivot.fields[3].function = "median".into();
        assert!(none(pivot));
        let mut pivot = sales();
        pivot.fields[0].subtotals = vec!["median".into()];
        assert!(none(pivot));
        let mut pivot = sales();
        pivot.fields[3].reference = Some("member-difference".into());
        assert!(none(pivot));
        // A source on a sheet the workbook does not have, a source of one
        // row, a target that leaves no room under the page fields.
        let mut pivot = sales();
        pivot.source = Some("Other.A1:Other.D13".into());
        assert!(none(pivot));
        let mut pivot = sales();
        pivot.source = Some("'Raw Data'.A1:'Raw Data'.D1".into());
        assert!(none(pivot));
        let mut pivot = sales();
        pivot.target = "Pivot.A4:Pivot.D5".into();
        assert!(none(pivot));
        // A header that is empty, or the same as another one.
        let mut pivot = sales();
        pivot.source = Some("'Raw Data'.A1:'Raw Data'.E13".into());
        assert!(none(pivot));
        let sheets: Vec<String> = SHEETS.iter().map(|name| (*name).to_owned()).collect();
        let mut pivots = Pivots::new(vec![sales()], &sheets);
        pivots.observe(0, |row, column| match (row, column) {
            (0, 1) => SourceCell::Text("region"),
            _ => source(row, column),
        });
        let mut extras = PackageExtras::default();
        pivots.write(&sheets, &mut extras);
        assert!(extras.pivot_caches.is_empty());
        // Marked while reading.
        let mut pivot = sales();
        pivot.unsupported = true;
        assert!(none(pivot));
    }

    /// The sample with the number column across the columns and the given
    /// members named for it.
    fn number_columns(members: &[(&str, bool)]) -> OdfPivot {
        let mut pivot = sales();
        pivot.fields[3] = PivotField {
            function: "count".into(),
            ..field("Product", Orientation::Data)
        };
        pivot.fields[1] = PivotField {
            members: members
                .iter()
                .map(|(name, display)| PivotMember {
                    name: (*name).into(),
                    display: *display,
                    details: true,
                })
                .collect(),
            ..field("Amount", Orientation::Column)
        };
        pivot
    }

    #[test]
    fn members_of_a_number_column_are_numbers() {
        let extras = written(vec![number_columns(&[("3", false), ("4.5", true)])]);
        let cache = part(&extras, "xl/pivotCache/pivotCacheDefinition1.xml");
        assert!(
            cache.contains(r#"<cacheField name="Amount" numFmtId="0"><sharedItems containsSemiMixedTypes="0" containsString="0" containsNumber="1" minValue="3" maxValue="4.5" count="2"><n v="3"/><n v="4.5"/></sharedItems></cacheField>"#),
            "{cache}"
        );
        let table = part(&extras, "xl/pivotTables/pivotTable1.xml");
        assert!(
            table.contains(r#"<pivotField axis="axisCol" showAll="0" defaultSubtotal="0"><items count="2"><item h="1" x="0"/><item x="1"/></items></pivotField>"#),
            "{table}"
        );
        // Whole numbers say so.
        let extras = written(vec![number_columns(&[("3", false)])]);
        let cache = part(&extras, "xl/pivotCache/pivotCacheDefinition1.xml");
        assert!(
            cache.contains(r#"containsNumber="1" containsInteger="1" minValue="3" maxValue="3" count="1"><n v="3"/></sharedItems>"#),
            "{cache}"
        );
    }

    #[test]
    fn a_member_the_cache_cannot_name_is_dropped_or_takes_the_table_with_it() {
        // Named through a format and only listed: the list goes, the table
        // stays.
        let extras = written(vec![number_columns(&[("1,234.50", true)])]);
        let cache = part(&extras, "xl/pivotCache/pivotCacheDefinition1.xml");
        assert!(
            cache.contains(r#"<cacheField name="Amount" numFmtId="0"><sharedItems/></cacheField>"#),
            "{cache}"
        );
        let table = part(&extras, "xl/pivotTables/pivotTable1.xml");
        assert!(
            table.contains(r#"<pivotField axis="axisCol" showAll="0" defaultSubtotal="0"><items count="1"><item t="default"/></items></pivotField>"#),
            "{table}"
        );
        // Unticked: showing it again would change the numbers, so the table
        // is left to its cells.
        let extras = written(vec![number_columns(&[("1,234.50", false)])]);
        assert!(extras.pivot_caches.is_empty());
        // The same for a column that holds text and numbers.
        let sheets: Vec<String> = SHEETS.iter().map(|name| (*name).to_owned()).collect();
        let mut pivots = Pivots::new(vec![sales()], &sheets);
        pivots.observe(0, |row, column| match (row, column) {
            (5, 0) => SourceCell::Number(7.0),
            _ => source(row, column),
        });
        let mut extras = PackageExtras::default();
        pivots.write(&sheets, &mut extras);
        assert!(extras.pivot_caches.is_empty());
    }

    #[test]
    fn a_table_that_names_no_layout_has_a_column_for_every_row_field() {
        let mut pivot = sales();
        pivot.buttons = String::new();
        pivot.fields[0].layout = None;
        pivot.fields[1].orientation = Orientation::Row;
        let extras = written(vec![pivot]);
        let table = part(&extras, "xl/pivotTables/pivotTable1.xml");
        assert!(table.contains(r#" indent="0" compact="0" compactData="0" outline="0" outlineData="0">"#), "{table}");
        // Two row fields: the values start in the third column.
        assert!(
            table.contains(r#"<location ref="A6:D11" firstHeaderRow="1" firstDataRow="1" firstDataCol="2" rowPageCount="1" colPageCount="1"/>"#),
            "{table}"
        );
        assert!(
            table.contains(r#"<pivotField axis="axisRow" compact="0" outline="0" showAll="0" defaultSubtotal="0"><items count="1"><item t="default"/></items></pivotField>"#),
            "{table}"
        );
        assert!(table.contains(r#"<pivotField dataField="1" compact="0" outline="0" showAll="0"/>"#), "{table}");
    }

    #[test]
    fn two_tables_of_one_sheet_get_names_of_their_own() {
        let mut second = sales();
        second.target = "Pivot.A20:Pivot.D30".into();
        second.buttons = String::new();
        let extras = written(vec![sales(), second]);
        assert_eq!(extras.pivot_caches.len(), 2);
        let table = part(&extras, "xl/pivotTables/pivotTable2.xml");
        assert!(table.contains(r#" name="Sales &amp; plan 2" cacheId="2" "#), "{table}");
        // Without buttons the headers are counted: one column field, and one
        // row label column in the compact layout.
        assert!(
            table.contains(r#"<location ref="A22:D30" firstHeaderRow="1" firstDataRow="2" firstDataCol="1" rowPageCount="1" colPageCount="1"/>"#),
            "{table}"
        );
    }
}
