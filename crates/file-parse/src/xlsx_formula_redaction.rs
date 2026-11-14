//! packages/file-parse/src/xlsx-formula-redaction.ts, with `relationshipIdOf`
//! of xlsx-gateway `gateway/xlsx-namespace.ts`: the formula cells of a workbook
//! whose value comes from a withheld cell. The module comment of the
//! TypeScript says what is traced and what is withheld because it cannot be.
//!
//! Offsets are bytes of the text; everything a scan looks for is ASCII, so
//! they compare as the UTF-16 offsets of the original do. The TypeScript reads
//! the parts of a workbook with `await`; here they are read as the closures of
//! [`DerivedInput`] are called, in the same order.

use std::collections::{HashMap, HashSet};

use jscompat::{
    JsMap, JsRegex, Radix, is_js_space, js_regex, number_to_string, parse_int, to_number, trim,
    try_js_regex,
};

use crate::xlsx::{letters_index, offset_formula_refs};
use crate::xlsx_formula_reads::{
    AreaLookup, DERIVED_CHECK_BUDGET, FormulaCell, MAX_COLUMN, MAX_ROW, NameDefinition,
    RangeBounds, ReadsSheet, cell_key, cells_derived_from_withheld,
};
use crate::xlsx_xml_scan::{Markup, attribute_run_end, skipped_at, xml_elements};

/// Sheet XML above this size is not scanned; the sheet is withheld whole instead.
pub const FORMULA_SCAN_MAX_BYTES: f64 = 64.0 * 1024.0 * 1024.0;

const WHOLE_SHEET: RangeBounds = RangeBounds {
    start_row: 0.0,
    end_row: MAX_ROW,
    start_column: 0.0,
    end_column: MAX_COLUMN,
};

/// `attribute(attributes, name)` for a literal name: the pattern compiles once
/// per call site. The value is the one in double quotes, or else the one in
/// single quotes.
macro_rules! xml_attribute {
    ($attributes:expr, $name:literal) => {
        $crate::xlsx_formula_redaction::attribute_in(
            ::jscompat::js_regex!(concat!(
                r"(?:^|\s)",
                $name,
                r#"\s*=\s*(?:"([^"]*)"|'([^']*)')"#
            )),
            $attributes,
        )
    };
}

fn attribute_in<'t>(pattern: &JsRegex, attributes: &'t str) -> Option<&'t str> {
    let found = pattern.exec(attributes)?;
    found.get(1).or_else(|| found.get(2))
}

/// `decodeEntities`: a character reference past U+10FFFF throws a `RangeError`
/// where `String.fromCodePoint` meets it; one to half of a surrogate pair
/// reads as U+FFFD, as a Rust string cannot hold the lone half. Of the names
/// only the five of XML are known, and `constructor`: the table is an object,
/// and `NAMED_ENTITIES['constructor']` is the function it inherits.
fn decode_entities(text: &str) -> Result<String, String> {
    if !text.contains('&') {
        return Ok(text.to_owned());
    }
    let mut failure: Option<String> = None;
    let decoded = js_regex!(r"&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);").replace_all(text, |found| {
        let body = found.get(1).unwrap_or_default();
        let code = if let Some(hex) = body.strip_prefix("#x") {
            parse_int(hex, Radix::Sixteen)
        } else if let Some(decimal) = body.strip_prefix('#') {
            to_number(decimal)
        } else {
            return match body {
                "amp" => "&",
                "lt" => "<",
                "gt" => ">",
                "quot" => "\"",
                "apos" => "'",
                "constructor" => "function Object() { [native code] }",
                _ => found.as_str(),
            }
            .to_owned();
        };
        match u32::try_from(code as u64)
            .ok()
            .filter(|point| *point <= 0x10_FFFF && f64::from(*point) == code)
        {
            Some(point) => char::from_u32(point).unwrap_or('\u{FFFD}').to_string(),
            None => {
                failure.get_or_insert(format!("Invalid code point {}", number_to_string(code)));
                String::new()
            }
        }
    });
    match failure {
        Some(error) => Err(error),
        None => Ok(decoded),
    }
}

/// `cellAt`: the zero-based row and column of an address.
fn cell_at(reference: Option<&str>) -> Option<(f64, f64)> {
    let at = js_regex!(r"^([A-Za-z]{1,3})([1-9]\d{0,6})$").exec(trim(reference?))?;
    Some((
        to_number(at.get(2).unwrap_or_default()) - 1.0,
        letters_index(at.get(1).unwrap_or_default()),
    ))
}

/// `rangeAt`
fn range_at(reference: Option<&str>) -> Option<RangeBounds> {
    let reference = reference.unwrap_or_default().replace('$', "");
    let mut parts = reference.split(':');
    let first = parts.next();
    let second = parts.next().or(first);
    let from = cell_at(first);
    let to = cell_at(second);
    let ((from_row, from_column), (to_row, to_column)) = (from?, to?);
    Some(RangeBounds {
        start_row: from_row.min(to_row),
        end_row: from_row.max(to_row),
        start_column: from_column.min(to_column),
        end_column: from_column.max(to_column),
    })
}

fn cell_area((row, column): (f64, f64)) -> RangeBounds {
    RangeBounds {
        start_row: row,
        end_row: row,
        start_column: column,
        end_column: column,
    }
}

/// `SheetFormulas`
#[derive(Debug)]
pub struct SheetFormulas {
    pub formulas: Vec<FormulaCell>,
    pub unknown: Vec<RangeBounds>,
    /// every cell that carries an `<f>`, so the worksheet parser can be checked against the scan
    pub formula_cells: HashSet<u64>,
}

impl SheetFormulas {
    fn none() -> Self {
        Self {
            formulas: Vec::new(),
            unknown: Vec::new(),
            formula_cells: HashSet::new(),
        }
    }

    /// `UNSCANNED`
    fn unscanned() -> Self {
        Self {
            formulas: Vec::new(),
            unknown: vec![WHOLE_SHEET],
            formula_cells: HashSet::new(),
        }
    }
}

/// What the scan stops at inside `<sheetData>` (`SCAN_STOP`): a comment, a
/// CDATA section or a processing instruction, each read whole, and the tags of
/// `sheetData`, `c` and `f`, each with any namespace prefix. Text can hold no
/// `<`, so no other stop can be a false one.
enum Stop<'t> {
    Skipped(Option<&'t str>),
    Tag {
        closing: bool,
        local: &'static str,
        attributes: &'t str,
    },
}

/// `<(\/?)(?:[\w.-]+:)?(sheetData|c|f)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>`
/// from a `<` at `at`: where the tag ends, and what it is.
fn scan_tag_at(xml: &str, at: usize) -> Option<(usize, Stop<'_>)> {
    let closing = xml[at + 1..].starts_with('/');
    let mut name_at = at + 1 + usize::from(closing);
    let prefix = xml[name_at..]
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')))
        .unwrap_or(xml.len() - name_at);
    if prefix > 0 && xml[name_at + prefix..].starts_with(':') {
        name_at += prefix + 1;
    }
    let local = ["sheetData", "c", "f"]
        .into_iter()
        .find(|local| xml[name_at..].starts_with(local))?;
    let after = name_at + local.len();
    if !xml[after..]
        .chars()
        .next()
        .is_some_and(|c| is_js_space(c) || matches!(c, '/' | '>'))
    {
        return None;
    }
    let close = attribute_run_end(xml, after)?;
    Some((
        close + 1,
        Stop::Tag {
            closing,
            local,
            attributes: &xml[after..close],
        },
    ))
}

/// The stops of `SCAN_STOP` in order.
fn scan_stops(xml: &str) -> impl Iterator<Item = (usize, usize, Stop<'_>)> {
    let mut at = 0;
    std::iter::from_fn(move || {
        while let Some(found) = xml[at..].find('<') {
            let start = at + found;
            if let Some(token) = skipped_at(xml, start) {
                at = token.end;
                let Markup::Skipped { cdata } = token.markup else {
                    unreachable!("skipped_at reads no tag");
                };
                return Some((start, token.end, Stop::Skipped(cdata)));
            }
            if let Some((end, stop)) = scan_tag_at(xml, start) {
                at = end;
                return Some((start, end, stop));
            }
            at = start + 1;
        }
        None
    })
}

/// The `<f>` being read: its attributes, the text so far and the cell it is in.
struct OpenFormula {
    attributes: String,
    text: String,
    at: (f64, f64),
}

struct Master {
    formula: String,
    row: f64,
    column: f64,
}

struct Follower {
    si: String,
    row: f64,
    column: f64,
}

/// What a formula's end tag settles: the formulas and the unknown areas found so far.
struct Scan {
    result: SheetFormulas,
    masters: JsMap<Master>,
    followers: Vec<Follower>,
}

impl Scan {
    /// `finish`: false when nothing on the sheet can be said to be free of the formula.
    fn finish(&mut self, attributes: &str, body: &str, at: (f64, f64)) -> bool {
        self.result.formula_cells.insert(cell_key(at.0, at.1));
        let kind = xml_attribute!(attributes, "t");
        let text = trim(body).to_owned();
        if kind == Some("dataTable") {
            let Some(table) = range_at(xml_attribute!(attributes, "ref")) else {
                return false;
            };
            self.result.unknown.push(table);
            return true;
        }
        if kind == Some("shared") {
            match xml_attribute!(attributes, "si") {
                None => self.result.unknown.push(cell_area(at)),
                Some(si) if text.is_empty() => self.followers.push(Follower {
                    si: si.to_owned(),
                    row: at.0,
                    column: at.1,
                }),
                Some(si) => {
                    self.masters.set(
                        si,
                        Master {
                            formula: text.clone(),
                            row: at.0,
                            column: at.1,
                        },
                    );
                    self.result.formulas.push(FormulaCell {
                        area: cell_area(at),
                        formula: text,
                    });
                }
            }
            return true;
        }
        if text.is_empty() {
            self.result.unknown.push(cell_area(at));
            return true;
        }
        if kind == Some("array") {
            let Some(filled) = range_at(xml_attribute!(attributes, "ref")) else {
                return false;
            };
            self.result.formulas.push(FormulaCell {
                area: filled,
                formula: text,
            });
            return true;
        }
        self.result.formulas.push(FormulaCell {
            area: cell_area(at),
            formula: text,
        });
        true
    }
}

/// The formulas of one worksheet part, from its raw XML.
pub fn scan_sheet_formulas(xml: &str) -> Result<SheetFormulas, String> {
    let mut scan = Scan {
        result: SheetFormulas::none(),
        masters: JsMap::new(),
        followers: Vec::new(),
    };
    // the address of the cell being read; none when it has none and between cells
    let mut current: Option<(f64, f64)> = None;
    let mut in_data = false;
    let mut formula: Option<OpenFormula> = None;
    let mut saw_data = false;
    let mut last = 0;
    for (start, end, stop) in scan_stops(xml) {
        if let Some(open) = formula.as_mut() {
            open.text += &decode_entities(&xml[last..start])?;
        }
        last = end;
        let Stop::Tag {
            closing,
            local,
            attributes,
        } = stop
        else {
            // CDATA is the formula's text as it is; a comment or an instruction is nothing
            if let (Some(open), Stop::Skipped(Some(cdata))) = (formula.as_mut(), stop) {
                open.text += cdata;
            }
            continue;
        };
        let self_closed = !closing && attributes.ends_with('/');
        if local == "sheetData" {
            if closing {
                in_data = false;
            } else if !self_closed {
                in_data = true;
                saw_data = true;
            }
            continue;
        }
        if !in_data {
            continue;
        }
        if local == "c" {
            // a self-closed cell holds no formula
            current = if closing || self_closed {
                None
            } else {
                cell_at(xml_attribute!(attributes, "r"))
            };
            continue;
        }
        if closing {
            if let Some(open) = formula.take()
                && !scan.finish(&open.attributes, &open.text, open.at)
            {
                return Ok(SheetFormulas::unscanned());
            }
            continue;
        }
        // An `<f>` outside a cell, or in a cell that cannot be placed: nothing on
        // this sheet can be said to be free of it.
        let Some(at) = current else {
            return Ok(SheetFormulas::unscanned());
        };
        if self_closed {
            if !scan.finish(attributes, "", at) {
                return Ok(SheetFormulas::unscanned());
            }
        } else {
            formula = Some(OpenFormula {
                attributes: attributes.to_owned(),
                text: String::new(),
                at,
            });
        }
    }
    // a formula the part ends in the middle of is a formula nothing is known of
    if formula.is_some() {
        return Ok(SheetFormulas::unscanned());
    }
    if !saw_data {
        return Ok(SheetFormulas::none());
    }
    let Scan {
        mut result,
        masters,
        followers,
    } = scan;
    for follower in followers {
        let Some(master) = masters.get(&follower.si) else {
            result
                .unknown
                .push(cell_area((follower.row, follower.column)));
            continue;
        };
        result.formulas.push(FormulaCell {
            area: cell_area((follower.row, follower.column)),
            formula: offset_formula_refs(
                &master.formula,
                follower.row - master.row,
                follower.column - master.column,
            )?,
        });
    }
    Ok(result)
}

/// What the cell loop asks about one sheet.
#[derive(Debug)]
pub struct DerivedSheet {
    /// the sheet has at least one such cell
    pub any: bool,
    withheld: AreaLookup,
    formula_cells: HashSet<u64>,
}

impl DerivedSheet {
    /// the cell shows a value derived from a withheld cell, or one that cannot be traced
    pub fn withheld(&self, row: f64, column: f64) -> bool {
        self.withheld.contains(row, column)
    }

    /// the scan saw the formula of this cell
    pub fn known_formula(&self, row: f64, column: f64) -> bool {
        self.formula_cells.contains(&cell_key(row, column))
    }
}

/// The cells one PivotTable fills on a sheet. They are plain cells holding the
/// labels and totals of the pivot's source, so they are traced like a formula
/// that reads the source; `formula` is `None` when the source cannot be told,
/// and the cells are then withheld untraced.
#[derive(Debug)]
pub struct PivotOutput {
    pub area: RangeBounds,
    pub formula: Option<String>,
}

/// Where a pivot's output is and what it was computed from, read off its
/// `pivotTableDefinition` part (`pivot` is its text and whether the part was
/// larger than what was read) and off the start of its cache definition.
/// Either is `None` when that part is missing.
///
/// The source is followed when it is a range of a sheet of this workbook, or a
/// name (a defined name is resolved by the trace; a table name is not one, and
/// is withheld there). Anything else cannot be told: another workbook
/// (`r:id`), a connection, consolidated ranges, a cache that is not there or
/// does not open with its source. A pivot that does not say where its output
/// is withholds its whole sheet.
pub fn pivot_output_of(
    pivot: Option<(&str, bool)>,
    cache_xml: Option<&str>,
) -> Result<PivotOutput, String> {
    let pivot_xml = pivot.map_or("", |(text, _)| text);
    let locations = xml_elements(pivot_xml, "location");
    let location = locations.first();
    let output = range_at(location.and_then(|location| location.attribute("ref")));
    let (Some(location), Some(output)) = (location, output) else {
        return Ok(PivotOutput {
            area: WHOLE_SHEET,
            formula: None,
        });
    };
    let up_to_output_end = RangeBounds {
        start_row: 0.0,
        start_column: 0.0,
        end_column: WHOLE_SHEET.end_column,
        ..output
    };
    // The filters are listed after the fields and their items, megabytes into a
    // large pivot. In a part that was not read to its end they may be in the
    // rest, so their number is not known, and neither is whether the layout
    // holds them all.
    if pivot.is_some_and(|(_, truncated)| truncated) {
        return Ok(PivotOutput {
            area: up_to_output_end,
            formula: pivot_source_formula(cache_xml)?,
        });
    }
    // Report filters sit above the output: per row of them a label and the chosen item for
    // each filter, a blank column between two filters, then a blank row. The location says
    // how many rows and how many side by side. Nothing declared and no filters: there are
    // none. A layout that is not two counts, or does not hold every filter, leaves their
    // extent unknown, and it is not guessed: every row from the top of the sheet down to the
    // end of the output is the pivot's, in every column.
    let filters = xml_elements(pivot_xml, "pageField").len() as f64;
    let count = |value: Option<&str>| -> f64 {
        let value = to_number(value.unwrap_or_default());
        if value.is_finite() && value.trunc() == value && value > 0.0 {
            value
        } else {
            0.0
        }
    };
    let page_rows = count(location.attribute("rowPageCount"));
    let page_columns = count(location.attribute("colPageCount"));
    let area = if filters == 0.0 && page_rows == 0.0 && page_columns == 0.0 {
        output
    } else if page_rows == 0.0 || page_columns == 0.0 || page_rows * page_columns < filters {
        up_to_output_end
    } else {
        RangeBounds {
            start_row: (output.start_row - page_rows - 1.0).max(0.0),
            end_column: WHOLE_SHEET.end_column.min(
                output
                    .end_column
                    .max(output.start_column + page_columns * 3.0 - 2.0),
            ),
            ..output
        }
    };
    Ok(PivotOutput {
        area,
        formula: pivot_source_formula(cache_xml)?,
    })
}

fn pivot_source_formula(cache_xml: Option<&str>) -> Result<Option<String>, String> {
    let cache_xml = cache_xml.unwrap_or_default();
    let cache_sources = xml_elements(cache_xml, "cacheSource");
    let source_elements = xml_elements(cache_xml, "worksheetSource");
    let (Some(cache_source), Some(source_element)) =
        (cache_sources.first(), source_elements.first())
    else {
        return Ok(None);
    };
    if cache_source.attribute("type") != Some("worksheet") {
        return Ok(None);
    }
    // A relationship on the source: the range is in another workbook. Told the
    // way the workbook gateway tells it for the editor, so the two agree.
    let tag = &cache_xml[source_element.start..source_element.open_end];
    if relationship_id_of(tag, &cache_xml[..source_element.start])
        .map_err(|limit| limit.to_string())?
        .is_some()
    {
        return Ok(None);
    }
    let reference = source_element.attribute("ref");
    let sheet = source_element.attribute("sheet");
    let name = source_element.attribute("name");
    if let (Some(reference), Some(sheet)) = (reference, sheet) {
        if range_at(Some(reference)).is_none() {
            return Ok(None);
        }
        return Ok(Some(format!(
            "='{}'!{}",
            sheet.replace('\'', "''"),
            reference.replace('$', "")
        )));
    }
    if reference.is_none() && sheet.is_none() {
        return Ok(name.map(|name| format!("={name}")));
    }
    Ok(None)
}

/// Read on demand: the sheet's XML up to the scan limit and whether it was cut there.
pub type SheetXmlRead<'a> = Box<dyn FnOnce() -> Result<Option<(String, bool)>, String> + 'a>;
/// Read on demand: the PivotTables that put their output on a sheet.
pub type PivotsRead<'a> = Box<dyn FnOnce() -> Result<Vec<PivotOutput>, String> + 'a>;

/// A sheet as `readDerivedCells` is given it.
pub struct DerivedInput<'a> {
    pub name: String,
    /// the sheet's XML up to the scan limit and whether it was cut there, or `None` when the part is missing
    pub xml: Option<SheetXmlRead<'a>>,
    pub marks: Vec<RangeBounds>,
    /// the PivotTables that put their output on this sheet
    pub pivots: Option<PivotsRead<'a>>,
}

/// Scan every sheet and trace the marks through the formulas. Returns one entry
/// per sheet, in the order given. Call it only for a workbook that has marks.
pub fn read_derived_cells(
    sheets: Vec<DerivedInput<'_>>,
    names: &[NameDefinition],
) -> Result<Vec<DerivedSheet>, String> {
    let mut formula_cells_of: Vec<HashSet<u64>> = Vec::new();
    let mut reads_sheets: Vec<ReadsSheet> = Vec::new();
    for sheet in sheets {
        let raw = match sheet.xml {
            Some(xml) => xml()?,
            None => None,
        };
        let found = match raw {
            None => SheetFormulas::none(),
            Some((_, true)) => SheetFormulas::unscanned(),
            Some((text, false)) => scan_sheet_formulas(&text)?,
        };
        let pivots = match sheet.pivots {
            Some(pivots) => pivots()?,
            None => Vec::new(),
        };
        let SheetFormulas {
            mut formulas,
            mut unknown,
            formula_cells,
        } = found;
        for pivot in pivots {
            match pivot.formula {
                None => unknown.push(pivot.area),
                Some(formula) => formulas.push(FormulaCell {
                    area: pivot.area,
                    formula,
                }),
            }
        }
        reads_sheets.push(ReadsSheet {
            name: sheet.name,
            marks: sheet.marks,
            unknown,
            formulas,
        });
        formula_cells_of.push(formula_cells);
    }
    let traced = cells_derived_from_withheld(&reads_sheets, names, DERIVED_CHECK_BUDGET)
        .map_err(|limit| limit.to_string())?;
    Ok(formula_cells_of
        .into_iter()
        .zip(traced.by_sheet)
        .map(|(formula_cells, areas)| DerivedSheet {
            any: !areas.is_empty(),
            withheld: AreaLookup::new(&areas),
            formula_cells,
        })
        .collect())
}

/// `relationshipIdOf`: the relationship id an element carries (`r:id`), or
/// `None` when it has none. `preceding_xml` is the part up to the element: the
/// start tags of its ancestors, where the prefix is declared.
///
/// The attribute is read by its qualified name, whatever the quotes and the
/// space around `=`, and one attribute at a time, so text inside another
/// attribute's value is not taken for it. The prefix is the one the part binds
/// to the relationships namespace: `r` by convention, but any name is legal,
/// and `xr:id` (a revision id) is not a relationship. A prefix bound to that
/// namespace anywhere in scope counts, and so does an `r` nobody declares:
/// what cannot be told is read as a relationship, because the callers treat
/// one as "this is not data of this workbook".
pub fn relationship_id_of(
    start_tag: &str,
    preceding_xml: &str,
) -> Result<Option<String>, jscompat::RegexLimit> {
    // The relationships namespace of the transitional format and of the strict one.
    const RELATIONSHIP_NAMESPACES: [&str; 2] = [
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
        "http://purl.oclc.org/ooxml/officeDocument/relationships",
    ];
    // Root start tag; the quote alternation keeps '>' inside attribute values
    // (legal in XML) from ending the match early.
    let tag =
        match try_js_regex!(r#"<(?![?!])(?:[^>"']|"[^"]*"|'[^']*')*?\/?>"#).try_exec(start_tag)? {
            Some(found) => found.as_str(),
            None => start_tag,
        };
    let mut bound: HashMap<String, bool> = HashMap::new();
    let declarations = format!("{preceding_xml} {tag}");
    for declaration in js_regex!(r#"(?:^|\s)xmlns:([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#)
        .find_iter(&declarations)
    {
        let prefix = declaration.get(1).unwrap_or_default();
        let namespace = declaration
            .get(2)
            .or_else(|| declaration.get(3))
            .unwrap_or_default();
        let to_relationships = RELATIONSHIP_NAMESPACES.contains(&namespace);
        let before = bound.get(prefix) == Some(&true);
        bound.insert(prefix.to_owned(), to_relationships || before);
    }
    for attribute in js_regex!(r#"([^\s=<>/"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).find_iter(tag) {
        let name = attribute.get(1).unwrap_or_default();
        let Some(prefix) = name.strip_suffix(":id") else {
            continue;
        };
        if bound.get(prefix).copied().unwrap_or(prefix == "r") {
            return Ok(Some(
                attribute
                    .get(2)
                    .or_else(|| attribute.get(3))
                    .unwrap_or_default()
                    .to_owned(),
            ));
        }
    }
    Ok(None)
}
