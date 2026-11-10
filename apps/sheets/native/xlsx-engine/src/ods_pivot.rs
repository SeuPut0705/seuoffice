//! Pivot tables for the `.ods` export.
//!
//! The cells a pivot table fills are ordinary cells and travel with the sheet.
//! What this adds is the table behind them — where it reads from, which
//! fields sit on rows, columns, pages and in the values, and how they are
//! summarised — so a reader can refresh or rearrange it instead of finding a
//! block of dead numbers.
//!
//! Only a pivot table that reads a range of a sheet in the same workbook is
//! written. One fed by a named range, a table, another file or a data model
//! has no source a reader could follow, and is left to the count of losses.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use roxmltree::{Document, Node};
use zip::ZipArchive;

use crate::odf_formula;
use crate::xlsx_package::escape_xml;
use crate::{DefinedName, PivotTableInfo};

/// The names of a workbook that stand for one range of a sheet — defined
/// names and tables — in lower case, with the sheet and the range. A pivot
/// table fed by such a name reads that range.
pub(crate) type NamedSources = HashMap<String, (String, String)>;

/// One pivot table as a `table:data-pilot-table` element, or `None` when it
/// cannot be said in ODF.
pub(crate) fn pivot_table_xml(
    package: &Path,
    sheet: &str,
    info: &PivotTableInfo,
    sources: &NamedSources,
) -> Option<String> {
    let mut archive = ZipArchive::new(File::open(package).ok()?).ok()?;
    let definition = read_part(&mut archive, &info.path)?;
    let cache = read_part(&mut archive, info.cache_path.as_deref()?)?;
    data_pilot_xml(sheet, &definition, &cache, sources)
}

/// `xl/worksheets/_rels/sheet1.xml.rels` for `xl/worksheets/sheet1.xml`.
fn relationships_path(part: &str) -> String {
    match part.rsplit_once('/') {
        Some((folder, file)) => format!("{folder}/_rels/{file}.rels"),
        None => format!("_rels/{part}.rels"),
    }
}

/// A relationship target as a path in the package.
fn resolve_target(part: &str, target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_owned();
    }
    let mut pieces: Vec<&str> = part.split('/').collect();
    pieces.pop();
    for piece in target.split('/') {
        match piece {
            "" | "." => {}
            ".." => {
                pieces.pop();
            }
            piece => pieces.push(piece),
        }
    }
    pieces.join("/")
}

/// The sheet and range a defined name stands for, when it is exactly one
/// range of one sheet (`'Raw Data'!$A$1:$D$13`).
fn name_target(formula: &str) -> Option<(String, String)> {
    let formula = formula.trim().trim_start_matches('=');
    let (sheet, cells) = formula.rsplit_once('!')?;
    range(cells)?;
    let sheet = match sheet.strip_prefix('\'').and_then(|sheet| sheet.strip_suffix('\'')) {
        Some(quoted) => quoted.replace("''", "'"),
        None => sheet.to_owned(),
    };
    (!sheet.is_empty() && !sheet.contains(['!', '[', ']']))
        .then(|| (sheet, cells.replace('$', "")))
}

/// The defined names and tables of the workbook a pivot table may name as
/// its source. `sheets` gives each sheet's name and worksheet part.
pub(crate) fn named_sources(
    package: &Path,
    sheets: &[(String, String)],
    defined: &[DefinedName],
) -> NamedSources {
    let mut sources = NamedSources::new();
    if let Some(mut archive) = File::open(package)
        .ok()
        .and_then(|file| ZipArchive::new(file).ok())
    {
        for (sheet, part) in sheets {
            let Some(relationships) = read_part(&mut archive, &relationships_path(part)) else {
                continue;
            };
            let Ok(relationships) = Document::parse(&relationships) else {
                continue;
            };
            let targets: Vec<String> = relationships
                .root_element()
                .children()
                .filter(|node| {
                    node.is_element()
                        && node
                            .attribute("Type")
                            .is_some_and(|kind| kind.ends_with("/table"))
                })
                .filter_map(|node| node.attribute("Target"))
                .map(|target| resolve_target(part, target))
                .collect();
            for target in targets {
                let Some(table) = read_part(&mut archive, &target) else {
                    continue;
                };
                let Ok(table) = Document::parse(&table) else {
                    continue;
                };
                let root = table.root_element();
                let Some((first, mut last)) = root.attribute("ref").and_then(range) else {
                    continue;
                };
                // A pivot table reads the header and the data of a table,
                // not its totals row.
                let totals: usize = root
                    .attribute("totalsRowCount")
                    .and_then(|count| count.parse().ok())
                    .unwrap_or(0);
                last.1 = last.1.saturating_sub(totals).max(first.1);
                let cells = format!(
                    "{}{}:{}{}",
                    column_name(first.0),
                    first.1 + 1,
                    column_name(last.0),
                    last.1 + 1
                );
                for name in [root.attribute("displayName"), root.attribute("name")]
                    .into_iter()
                    .flatten()
                {
                    sources.insert(name.to_lowercase(), (sheet.clone(), cells.clone()));
                }
            }
        }
    }
    // A name of the whole workbook; one that belongs to a single sheet is
    // not what a pivot cache names.
    for name in defined.iter().filter(|name| name.sheet_index.is_none()) {
        if let Some(target) = name_target(&name.formula) {
            sources.entry(name.name.to_lowercase()).or_insert(target);
        }
    }
    sources
}

fn read_part(archive: &mut ZipArchive<File>, path: &str) -> Option<String> {
    let mut entry = archive.by_name(path.trim_start_matches('/')).ok()?;
    // A pivot definition is small; a cache definition lists every distinct
    // value of every field, so it is bounded rather than trusted.
    const MAX_PART_BYTES: u64 = 64 * 1024 * 1024;
    if entry.size() > MAX_PART_BYTES {
        return None;
    }
    let mut text = String::new();
    entry.read_to_string(&mut text).ok()?;
    Some(text)
}

fn child<'a>(node: Node<'a, 'a>, name: &str) -> Option<Node<'a, 'a>> {
    node.children().find(|child| child.has_tag_name(name))
}

fn children<'a>(node: Node<'a, 'a>, name: &'a str) -> impl Iterator<Item = Node<'a, 'a>> {
    node.children().filter(move |child| child.has_tag_name(name))
}

fn flag(node: Node<'_, '_>, name: &str, default: bool) -> bool {
    node.attribute(name)
        .map_or(default, |value| value == "1" || value == "true")
}

/// `A1` → (column, row), both zero-based.
fn cell(reference: &str) -> Option<(usize, usize)> {
    let reference = reference.trim().replace('$', "");
    let letters = reference
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .count();
    if letters == 0 {
        return None;
    }
    let column = reference[..letters].bytes().fold(0usize, |total, byte| {
        total * 26 + usize::from(byte.to_ascii_uppercase() - b'A') + 1
    });
    let row: usize = reference[letters..].parse().ok()?;
    (row > 0).then(|| (column - 1, row - 1))
}

fn range(reference: &str) -> Option<((usize, usize), (usize, usize))> {
    match reference.split_once(':') {
        Some((first, last)) => Some((cell(first)?, cell(last)?)),
        None => cell(reference).map(|only| (only, only)),
    }
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

fn address(sheet: &str, column: usize, row: usize) -> String {
    format!(
        "{}.{}{}",
        odf_formula::odf_sheet_name(sheet),
        column_name(column),
        row + 1
    )
}

/// How a data field is summarised, in the word ODF uses for it.
fn function(subtotal: Option<&str>) -> &'static str {
    match subtotal.unwrap_or("sum") {
        "count" => "count",
        "average" => "average",
        "max" => "max",
        "min" => "min",
        "product" => "product",
        "countNums" => "countnums",
        "stdDev" => "stdev",
        "stdDevp" => "stdevp",
        "var" => "var",
        "varp" => "varp",
        _ => "sum",
    }
}

/// The text a reader shows for one shared item, when it is one the two
/// formats name alike.
fn item_name(item: Node<'_, '_>) -> Option<String> {
    match item.tag_name().name() {
        "s" => item.attribute("v").map(str::to_owned),
        // A plain number is called by its digits. One that needs an exponent
        // or a format to be read is not a name a reader will recognise.
        "n" => item
            .attribute("v")
            .map(str::trim)
            .filter(|value| {
                !value.is_empty()
                    && value.parse::<f64>().is_ok_and(f64::is_finite)
                    && value
                        .chars()
                        .all(|character| character.is_ascii_digit() || matches!(character, '-' | '.'))
            })
            .map(str::to_owned),
        _ => None,
    }
}

/// The caption a field was given, as the attribute readers share for it.
fn display_name(caption: Option<&str>) -> String {
    match caption.map(str::trim).filter(|caption| !caption.is_empty()) {
        Some(caption) => format!(r#" tableooo:display-name="{}""#, escape_xml(caption)),
        None => String::new(),
    }
}

/// How a row or column field lays out its items. The compact form has no
/// word in the standard: it is written as the tabular one with the form
/// itself beside it, which is how the readers that know it say it.
fn layout_info(field: Node<'_, '_>) -> String {
    let mode = match (flag(field, "outline", true), flag(field, "compact", true)) {
        (true, true) => r#"tabular-layout" loext:layout-mode="compact-layout"#,
        (true, false) if flag(field, "subtotalTop", true) => "outline-subtotals-top",
        (true, false) => "outline-subtotals-bottom",
        (false, _) => "tabular-layout",
    };
    let blank_lines = flag(field, "insertBlankRow", false);
    // The tabular form without blank lines is what a field has when nothing
    // is said.
    if mode == "tabular-layout" && !blank_lines {
        return String::new();
    }
    format!(
        r#"<table:data-pilot-layout-info table:add-empty-lines="{blank_lines}" table:layout-mode="{mode}"/>"#
    )
}

fn data_pilot_xml(
    sheet: &str,
    definition: &str,
    cache: &str,
    sources: &NamedSources,
) -> Option<String> {
    let definition = Document::parse(definition).ok()?;
    let cache = Document::parse(cache).ok()?;
    let table = definition.root_element();
    let cache_root = cache.root_element();

    // ---- where the table reads from
    let source = child(cache_root, "cacheSource")?;
    if source.attribute("type").unwrap_or("worksheet") != "worksheet" {
        return None;
    }
    let worksheet = child(source, "worksheetSource")?;
    // A relationship id means another file, which is not a range of this
    // workbook a reader could be given. A name is a defined name or a table,
    // and is followed to the range it stands for.
    if worksheet
        .attributes()
        .any(|attribute| attribute.name() == "id")
    {
        return None;
    }
    let (source_sheet, reference) = match (
        worksheet.attribute("sheet"),
        worksheet.attribute("ref"),
        worksheet.attribute("name"),
    ) {
        (Some(sheet), Some(reference), _) => (sheet, reference),
        (_, _, Some(name)) => {
            let (sheet, reference) = sources.get(&name.to_lowercase())?;
            (sheet.as_str(), reference.as_str())
        }
        _ => return None,
    };
    let (source_first, source_last) = range(reference)?;
    let names: Vec<&str> = children(child(cache_root, "cacheFields")?, "cacheField")
        .map(|field| field.attribute("name").unwrap_or(""))
        .collect();
    let shared: Vec<Vec<Option<String>>> = children(child(cache_root, "cacheFields")?, "cacheField")
        .map(|field| {
            child(field, "sharedItems")
                .map(|items| {
                    items
                        .children()
                        .filter(Node::is_element)
                        .map(item_name)
                        .collect()
                })
                .unwrap_or_default()
        })
        .collect();

    // ---- where it writes to
    let location = child(table, "location")?;
    let (first, last) = range(location.attribute("ref")?)?;
    // Page fields sit above the table, one per row, with a blank row between
    // them and it; the output range starts with them.
    let pages: usize = location
        .attribute("rowPageCount")
        .and_then(|count| count.parse().ok())
        .unwrap_or(0);
    let top = first.1.saturating_sub(if pages > 0 { pages + 1 } else { 0 });
    let first_data_row: usize = location
        .attribute("firstDataRow")
        .and_then(|count| count.parse().ok())
        .unwrap_or(1);
    let first_data_column: usize = location
        .attribute("firstDataCol")
        .and_then(|count| count.parse().ok())
        .unwrap_or(1);

    let pivot_fields: Vec<Node<'_, '_>> = child(table, "pivotFields")
        .map(|fields| children(fields, "pivotField").collect())
        .unwrap_or_default();
    let name_of = |index: i64| -> Option<&str> {
        usize::try_from(index)
            .ok()
            .and_then(|index| names.get(index).copied())
            .filter(|name| !name.is_empty())
    };
    let axis_fields = |list: &str| -> Vec<i64> {
        child(table, list)
            .map(|fields| {
                children(fields, "field")
                    .filter_map(|field| field.attribute("x")?.parse::<i64>().ok())
                    .collect()
            })
            .unwrap_or_default()
    };

    let mut fields = String::new();
    let mut buttons: Vec<String> = Vec::new();
    // One field element, with the subtotals and hidden members the pivot
    // field carries.
    let push_field = |fields: &mut String, index: i64, orientation: &str| -> Option<()> {
        if index == -2 {
            // The place of the values among the row or column fields.
            fields.push_str(&format!(
                r#"<table:data-pilot-field table:source-field-name="" table:is-data-layout-field="true" table:orientation="{orientation}" table:used-hierarchy="-1" table:function="auto"/>"#
            ));
            return Some(());
        }
        let name = name_of(index)?;
        let field = usize::try_from(index)
            .ok()
            .and_then(|index| pivot_fields.get(index).copied());
        let mut level = String::new();
        if let Some(field) = field {
            if orientation != "page" && flag(field, "defaultSubtotal", true) {
                level.push_str(
                    r#"<table:data-pilot-subtotals><table:data-pilot-subtotal table:function="auto"/></table:data-pilot-subtotals>"#,
                );
            }
            // Items the user unticked. They are only written when every one
            // of them has a name the reader will know it by.
            let hidden: Vec<Node<'_, '_>> = child(field, "items")
                .map(|items| {
                    children(items, "item")
                        .filter(|item| flag(*item, "h", false))
                        .collect()
                })
                .unwrap_or_default();
            let hidden_names: Option<Vec<String>> = hidden
                .iter()
                .map(|item| {
                    let shared_index: usize = item.attribute("x")?.parse().ok()?;
                    shared
                        .get(usize::try_from(index).ok()?)?
                        .get(shared_index)?
                        .clone()
                })
                .collect();
            if let Some(hidden_names) = hidden_names.filter(|names| !names.is_empty()) {
                level.push_str("<table:data-pilot-members>");
                for member in hidden_names {
                    level.push_str(&format!(
                        r#"<table:data-pilot-member table:name="{}" table:display="false"/>"#,
                        escape_xml(&member)
                    ));
                }
                level.push_str("</table:data-pilot-members>");
            }
            if orientation != "page" {
                level.push_str(&layout_info(field));
            }
        }
        let level = if level.is_empty() {
            "<table:data-pilot-level/>".to_owned()
        } else {
            format!("<table:data-pilot-level>{level}</table:data-pilot-level>")
        };
        fields.push_str(&format!(
            r#"<table:data-pilot-field table:source-field-name="{}"{} table:orientation="{orientation}" table:used-hierarchy="-1" table:function="auto">{level}</table:data-pilot-field>"#,
            escape_xml(name),
            display_name(field.and_then(|field| field.attribute("name"))),
        ));
        Some(())
    };

    let row_fields = axis_fields("rowFields");
    let column_fields = axis_fields("colFields");
    for (position, index) in row_fields.iter().enumerate() {
        push_field(&mut fields, *index, "row")?;
        if *index >= 0 {
            buttons.push(address(
                sheet,
                first.0 + position,
                first.1 + first_data_row.saturating_sub(1),
            ));
        }
    }
    for (position, index) in column_fields.iter().enumerate() {
        push_field(&mut fields, *index, "column")?;
        if *index >= 0 {
            buttons.push(address(sheet, first.0 + first_data_column + position, first.1));
        }
    }
    if let Some(page_fields) = child(table, "pageFields") {
        for (position, page) in children(page_fields, "pageField").enumerate() {
            let index: i64 = page.attribute("fld")?.parse().ok()?;
            push_field(&mut fields, index, "page")?;
            buttons.push(address(sheet, first.0, top + position));
        }
    }
    // Several values have a place among the row or the column fields. A
    // writer that leaves it out means the side the table says its values run
    // along; the place is written so that a reader does not have to guess.
    let values = child(table, "dataFields")
        .map(|list| children(list, "dataField").count())
        .unwrap_or(0);
    if values > 1 && !row_fields.contains(&-2) && !column_fields.contains(&-2) {
        let side = if flag(table, "dataOnRows", false) { "row" } else { "column" };
        push_field(&mut fields, -2, side)?;
    }
    let mut data_fields = 0;
    if let Some(list) = child(table, "dataFields") {
        for data in children(list, "dataField") {
            let index: i64 = data.attribute("fld")?.parse().ok()?;
            let name = name_of(index)?;
            let function = function(data.attribute("subtotal"));
            // The caption a value gets by itself is not one somebody gave
            // it; writing it would turn it into one.
            let caption = data
                .attribute("name")
                .filter(|caption| *caption != crate::odf_pivots::data_caption(function, name));
            fields.push_str(&format!(
                r#"<table:data-pilot-field table:source-field-name="{}"{} table:orientation="data" table:used-hierarchy="-1" table:function="{function}"><table:data-pilot-level/></table:data-pilot-field>"#,
                escape_xml(name),
                display_name(caption),
            ));
            data_fields += 1;
        }
    }
    if data_fields == 0 && row_fields.is_empty() && column_fields.is_empty() {
        return None;
    }

    // Excel's "grand totals for rows" is the total column; ODF names the
    // totals by what they total.
    let row_totals = flag(table, "rowGrandTotals", true);
    let column_totals = flag(table, "colGrandTotals", true);
    let grand_total = match (row_totals, column_totals) {
        (true, true) => "",
        (true, false) => r#" table:grand-total="row""#,
        (false, true) => r#" table:grand-total="column""#,
        (false, false) => r#" table:grand-total="none""#,
    };
    let name = table.attribute("name").filter(|name| !name.is_empty())?;
    let buttons = if buttons.is_empty() {
        String::new()
    } else {
        format!(r#" table:buttons="{}""#, escape_xml(&buttons.join(" ")))
    };
    Some(format!(
        r#"<table:data-pilot-table table:name="{}" table:application-data="" table:target-range-address="{}:{}"{buttons}{grand_total} table:show-filter-button="false"><table:source-cell-range table:cell-range-address="{}:{}"/>{fields}</table:data-pilot-table>"#,
        escape_xml(name),
        escape_xml(&address(sheet, first.0, top)),
        escape_xml(&address(sheet, last.0, last.1)),
        escape_xml(&address(source_sheet, source_first.0, source_first.1)),
        escape_xml(&address(source_sheet, source_last.0, source_last.1)),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const CACHE: &str = concat!(
        r#"<pivotCacheDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">"#,
        r#"<cacheSource type="worksheet"><worksheetSource ref="A1:D13" sheet="Raw Data"/></cacheSource>"#,
        r#"<cacheFields count="4">"#,
        r#"<cacheField name="Region"><sharedItems><s v="East"/><s v="North"/><s v="West"/></sharedItems></cacheField>"#,
        r#"<cacheField name="Product"><sharedItems><s v="Apple"/><s v="Pear"/></sharedItems></cacheField>"#,
        r#"<cacheField name="Month"><sharedItems><s v="Feb"/><s v="Jan"/></sharedItems></cacheField>"#,
        r#"<cacheField name="Amount"><sharedItems containsNumber="1"><n v="1"/><n v="2"/></sharedItems></cacheField>"#,
        r#"</cacheFields></pivotCacheDefinition>"#,
    );

    fn definition(body: &str, attributes: &str) -> String {
        format!(
            r#"<pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="Sales &amp; plan"{attributes}>{body}</pivotTableDefinition>"#
        )
    }

    #[test]
    fn writes_the_source_the_fields_and_how_they_are_summarised() {
        let body = concat!(
            r#"<location ref="A6:D11" firstHeaderRow="1" firstDataRow="2" firstDataCol="1" rowPageCount="1" colPageCount="1"/>"#,
            r#"<pivotFields count="4">"#,
            r#"<pivotField axis="axisRow"><items count="4"><item x="0"/><item h="1" x="2"/><item x="1"/><item t="default"/></items></pivotField>"#,
            r#"<pivotField axis="axisCol" defaultSubtotal="0"/><pivotField axis="axisPage" defaultSubtotal="0"/><pivotField dataField="1"/>"#,
            r#"</pivotFields>"#,
            r#"<rowFields count="1"><field x="0"/></rowFields><colFields count="2"><field x="1"/><field x="-2"/></colFields>"#,
            r#"<pageFields count="1"><pageField fld="2" hier="-1"/></pageFields>"#,
            r#"<dataFields count="2"><dataField name="Sum of Amount" fld="3"/><dataField name="Average" fld="3" subtotal="average"/></dataFields>"#,
        );
        let xml = data_pilot_xml(
            "Pivot",
            &definition(body, r#" colGrandTotals="0""#),
            CACHE,
            &NamedSources::new(),
        )
        .unwrap();
        assert_eq!(
            xml,
            concat!(
                r#"<table:data-pilot-table table:name="Sales &amp; plan" table:application-data="" table:target-range-address="Pivot.A4:Pivot.D11" table:buttons="Pivot.A7 Pivot.B6 Pivot.A4" table:grand-total="row" table:show-filter-button="false">"#,
                r#"<table:source-cell-range table:cell-range-address="'Raw Data'.A1:'Raw Data'.D13"/>"#,
                r#"<table:data-pilot-field table:source-field-name="Region" table:orientation="row" table:used-hierarchy="-1" table:function="auto"><table:data-pilot-level><table:data-pilot-subtotals><table:data-pilot-subtotal table:function="auto"/></table:data-pilot-subtotals><table:data-pilot-members><table:data-pilot-member table:name="West" table:display="false"/></table:data-pilot-members><table:data-pilot-layout-info table:add-empty-lines="false" table:layout-mode="tabular-layout" loext:layout-mode="compact-layout"/></table:data-pilot-level></table:data-pilot-field>"#,
                r#"<table:data-pilot-field table:source-field-name="Product" table:orientation="column" table:used-hierarchy="-1" table:function="auto"><table:data-pilot-level><table:data-pilot-layout-info table:add-empty-lines="false" table:layout-mode="tabular-layout" loext:layout-mode="compact-layout"/></table:data-pilot-level></table:data-pilot-field>"#,
                r#"<table:data-pilot-field table:source-field-name="" table:is-data-layout-field="true" table:orientation="column" table:used-hierarchy="-1" table:function="auto"/>"#,
                r#"<table:data-pilot-field table:source-field-name="Month" table:orientation="page" table:used-hierarchy="-1" table:function="auto"><table:data-pilot-level/></table:data-pilot-field>"#,
                r#"<table:data-pilot-field table:source-field-name="Amount" table:orientation="data" table:used-hierarchy="-1" table:function="sum"><table:data-pilot-level/></table:data-pilot-field>"#,
                r#"<table:data-pilot-field table:source-field-name="Amount" tableooo:display-name="Average" table:orientation="data" table:used-hierarchy="-1" table:function="average"><table:data-pilot-level/></table:data-pilot-field>"#,
                r#"</table:data-pilot-table>"#,
            )
        );
    }

    #[test]
    fn leaves_a_pivot_without_a_range_to_follow() {
        let body = concat!(
            r#"<location ref="A3:B5" firstHeaderRow="1" firstDataRow="1" firstDataCol="1"/>"#,
            r#"<pivotFields count="4"><pivotField axis="axisRow"/><pivotField/><pivotField/><pivotField dataField="1"/></pivotFields>"#,
            r#"<rowFields count="1"><field x="0"/></rowFields><dataFields count="1"><dataField fld="3"/></dataFields>"#,
        );
        let table = definition(body, "");
        let none = NamedSources::new();
        assert!(data_pilot_xml("Pivot", &table, CACHE, &none).is_some());
        // Fed by a name the workbook does not explain.
        let named = CACHE.replace(r#"ref="A1:D13" sheet="Raw Data""#, r#"name="Table1""#);
        assert_eq!(data_pilot_xml("Pivot", &table, &named, &none), None);
        // Fed by a table or a defined name: the range it stands for.
        let mut sources = NamedSources::new();
        sources.insert("table1".into(), ("Raw Data".into(), "A1:D13".into()));
        let followed = data_pilot_xml("Pivot", &table, &named, &sources).unwrap();
        assert!(
            followed.contains(
                r#"<table:source-cell-range table:cell-range-address="'Raw Data'.A1:'Raw Data'.D13"/>"#
            ),
            "{followed}"
        );
        // Fed by another file.
        let external = CACHE.replace(r#"<worksheetSource ref"#, r#"<worksheetSource r:id="rId1" ref"#);
        assert_eq!(data_pilot_xml("Pivot", &table, &external, &none), None);
        // Fed by something that is not a sheet at all.
        let model = CACHE.replace(r#"type="worksheet""#, r#"type="external""#);
        assert_eq!(data_pilot_xml("Pivot", &table, &model, &none), None);
        assert_eq!(
            name_target("='Raw ''Data'!$A$1:$D$13"),
            Some(("Raw 'Data".into(), "A1:D13".into()))
        );
        assert_eq!(name_target("Data!$A$1:$B$2,Data!$D$1"), None);
        assert_eq!(name_target("OFFSET(Data!$A$1,0,0)"), None);
        assert_eq!(
            resolve_target("xl/worksheets/sheet1.xml", "../tables/table1.xml"),
            "xl/tables/table1.xml"
        );
        assert_eq!(
            relationships_path("xl/worksheets/sheet1.xml"),
            "xl/worksheets/_rels/sheet1.xml.rels"
        );
        // A hidden member that is a plain number is named by its digits.
        let number = Document::parse(r#"<n v="12.5"/>"#).unwrap();
        assert_eq!(item_name(number.root_element()).as_deref(), Some("12.5"));
        let exponent = Document::parse(r#"<n v="1E+20"/>"#).unwrap();
        assert_eq!(item_name(exponent.root_element()), None);
        // The form of a field's items, and the two forms an outline has.
        let field = |attributes: &str| format!("<pivotField{attributes}/>");
        let layout = |attributes: &str| {
            let text = field(attributes);
            layout_info(Document::parse(&text).unwrap().root_element())
        };
        assert!(layout("").contains(r#"table:layout-mode="tabular-layout" loext:layout-mode="compact-layout""#));
        assert!(layout(r#" compact="0""#).contains(r#"table:layout-mode="outline-subtotals-top""#));
        assert!(layout(r#" compact="0" subtotalTop="0""#).contains(r#"table:layout-mode="outline-subtotals-bottom""#));
        assert!(
            layout(r#" compact="0" outline="0" insertBlankRow="1""#)
                .contains(r#"table:add-empty-lines="true" table:layout-mode="tabular-layout"/>"#)
        );
        assert_eq!(layout(r#" compact="0" outline="0""#), "");
        assert_eq!(function(Some("countNums")), "countnums");
        assert_eq!(function(None), "sum");
        assert_eq!(range("$B$2:$D$9"), Some(((1, 1), (3, 8))));
    }
}
