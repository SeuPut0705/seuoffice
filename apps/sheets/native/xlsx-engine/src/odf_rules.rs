//! Data validations and conditional formats of an imported `.ods` sheet as
//! worksheet XML.
//!
//! ODF writes both as small condition strings — `cell-content-is-between(1;10)`,
//! `formula-is([.A1]>5)` — with their operands in OpenFormula, relative to a
//! base cell the rule names. Excel splits the same thing into a type, an
//! operator and one or two formulas, relative to the top-left cell of the
//! range the rule covers. A rule this cannot spell is left out; the cells keep
//! their values either way.

use std::collections::BTreeMap;

use crate::odf_cell_styles::{XlsxStyles, hex_color};
use crate::odf_formula::{self, Names};
use crate::odf_sheet_format::{
    ConditionalEntry, MAX_COLUMN, MAX_ROW, OdsFormats, OdsSheetFormat, ScalePoint, Validation,
    parse_cell_address, parse_range_address, split_addresses,
};
use crate::xlsx_package::{cell_reference, escape_xml};

/// Areas one rule may list before the rest are left out.
const MAX_AREAS: usize = 256;
const MAX_RULES: usize = 2_000;

fn area_reference(start: (u32, u32), end: (u32, u32)) -> String {
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

/// Splits at `separator` where it stands outside strings, references and
/// parentheses.
fn split_top(text: &str, separator: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut in_string = false;
    let mut in_reference = false;
    let mut current = String::new();
    let mut index = 0;
    let bytes = text.as_bytes();
    while index < text.len() {
        let rest = &text[index..];
        let character = rest.chars().next().unwrap_or(' ');
        if in_string {
            if character == '"' {
                in_string = false;
            }
        } else if in_reference {
            if character == ']' {
                in_reference = false;
            }
        } else {
            match character {
                '"' => in_string = true,
                '[' => in_reference = true,
                '(' => depth += 1,
                ')' => depth = depth.saturating_sub(1),
                _ => {}
            }
            if depth == 0 && rest.starts_with(separator) && bytes[index] != b'"' {
                parts.push(std::mem::take(&mut current));
                index += separator.len();
                continue;
            }
        }
        current.push(character);
        index += character.len_utf8();
    }
    parts.push(current);
    parts
}

/// The two bounds of a `between`. The standard separates them with a
/// semicolon; a widely used writer puts a comma there.
fn bounds_of(arguments: &str) -> Vec<String> {
    let bounds = split_top(arguments, ";");
    if bounds.len() == 2 {
        return bounds;
    }
    split_top(arguments, ",")
}

/// The arguments of `name(…)` when the text is exactly that call.
fn call_arguments<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let rest = text.trim().strip_prefix(name)?.trim_start();
    let inner = rest.strip_prefix('(')?.strip_suffix(')')?;
    Some(inner)
}

/// Moves every relative reference of an OpenFormula expression by the given
/// rows and columns. `None` when a reference would leave the grid.
fn shift_references(expression: &str, rows: i64, columns: i64) -> Option<String> {
    if rows == 0 && columns == 0 {
        return Some(expression.to_owned());
    }
    let characters: Vec<char> = expression.chars().collect();
    let mut out = String::with_capacity(expression.len());
    let mut index = 0;
    let mut in_string = false;
    while index < characters.len() {
        let character = characters[index];
        if in_string {
            in_string = character != '"';
            out.push(character);
            index += 1;
            continue;
        }
        if character == '"' {
            in_string = true;
            out.push(character);
            index += 1;
            continue;
        }
        if character != '[' {
            out.push(character);
            index += 1;
            continue;
        }
        // Inside a reference: a cell address follows every `.` that is not
        // part of a quoted sheet name.
        out.push('[');
        index += 1;
        let mut quoted = false;
        while index < characters.len() && (quoted || characters[index] != ']') {
            let inner = characters[index];
            if inner == '\'' {
                quoted = !quoted;
                out.push(inner);
                index += 1;
                continue;
            }
            if inner != '.' || quoted {
                out.push(inner);
                index += 1;
                continue;
            }
            out.push('.');
            index += 1;
            let mut cursor = index;
            let column_fixed = characters.get(cursor) == Some(&'$');
            if column_fixed {
                cursor += 1;
            }
            let letters_from = cursor;
            while characters.get(cursor).is_some_and(char::is_ascii_alphabetic) {
                cursor += 1;
            }
            let letters: String = characters[letters_from..cursor].iter().collect();
            let row_fixed = characters.get(cursor) == Some(&'$');
            if row_fixed {
                cursor += 1;
            }
            let digits_from = cursor;
            while characters.get(cursor).is_some_and(char::is_ascii_digit) {
                cursor += 1;
            }
            let digits: String = characters[digits_from..cursor].iter().collect();
            if letters.is_empty() || digits.is_empty() || letters.len() > 3 {
                // Not a cell address this reads; copied as written.
                continue;
            }
            let mut column = 0i64;
            for letter in letters.chars() {
                column = column * 26 + i64::from(letter.to_ascii_uppercase() as u8 - b'A' + 1);
            }
            let mut row: i64 = digits.parse().ok()?;
            if !column_fixed {
                column += columns;
            }
            if !row_fixed {
                row += rows;
            }
            if column < 1 || column > i64::from(MAX_COLUMN) || row < 1 || row > i64::from(MAX_ROW) {
                return None;
            }
            let reference = cell_reference(0, (column - 1) as u32);
            let letters = reference.trim_end_matches('1');
            if column_fixed {
                out.push('$');
            }
            out.push_str(letters);
            if row_fixed {
                out.push('$');
            }
            out.push_str(&row.to_string());
            index = cursor;
        }
    }
    Some(out)
}

/// Translates an operand written relative to `base` so it reads the same
/// from `anchor`.
struct Operands<'a> {
    names: &'a Names,
    rows: i64,
    columns: i64,
}

impl<'a> Operands<'a> {
    fn new(names: &'a Names, base: &str, anchor: (u32, u32)) -> Self {
        let base = parse_cell_address(base).map(|(_, cell)| cell).unwrap_or(anchor);
        Self {
            names,
            rows: i64::from(anchor.0) - i64::from(base.0),
            columns: i64::from(anchor.1) - i64::from(base.1),
        }
    }

    fn formula(&self, expression: &str) -> Option<String> {
        let shifted = shift_references(expression.trim(), self.rows, self.columns)?;
        odf_formula::translate_expression(&shifted, self.names)
    }
}

/// `>=5`, `!=[.A1]` and friends as an OOXML operator and its operand.
fn comparison(text: &str) -> Option<(&'static str, &str)> {
    let text = text.trim_start();
    for (prefix, operator) in [
        (">=", "greaterThanOrEqual"),
        ("<=", "lessThanOrEqual"),
        ("!=", "notEqual"),
        ("<>", "notEqual"),
        (">", "greaterThan"),
        ("<", "lessThan"),
        ("=", "equal"),
    ] {
        if let Some(rest) = text.strip_prefix(prefix) {
            return Some((operator, rest));
        }
    }
    None
}

struct Rule {
    kind: Option<&'static str>,
    operator: Option<&'static str>,
    formula1: Option<String>,
    formula2: Option<String>,
}

/// A `table:condition` as a validation rule.
fn validation_rule(condition: &str, operands: &Operands<'_>) -> Option<Rule> {
    let body = match condition.split_once(':') {
        // The namespace in front (`of:`), when the text before the colon is
        // one and not part of the expression.
        Some((prefix, rest)) if prefix.chars().all(|character| character.is_ascii_alphanumeric()) => rest,
        _ => condition,
    };
    let body = body.trim();
    if body.is_empty() {
        return Some(Rule {
            kind: None,
            operator: None,
            formula1: None,
            formula2: None,
        });
    }
    let parts = split_top(body, " and ");
    let first = parts[0].trim();
    let second = parts.get(1).map(|part| part.trim());

    if let Some(arguments) = call_arguments(first, "cell-content-is-in-list") {
        let items = split_top(arguments, ";");
        let formula = if items.len() == 1 && !items[0].trim().starts_with('"') {
            operands.formula(&items[0])?
        } else {
            let mut values = Vec::new();
            for item in &items {
                let item = item.trim();
                let value = match item.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')) {
                    Some(text) => text.replace("\"\"", "\""),
                    None => item.to_owned(),
                };
                // Excel's inline list is comma-separated; an entry with a
                // comma in it has no place there.
                if value.contains(',') {
                    return None;
                }
                values.push(value.replace('"', "\"\""));
            }
            format!("\"{}\"", values.join(","))
        };
        return Some(Rule {
            kind: Some("list"),
            operator: None,
            formula1: Some(formula),
            formula2: None,
        });
    }
    if let Some(expression) = call_arguments(first, "is-true-formula") {
        return Some(Rule {
            kind: Some("custom"),
            operator: None,
            formula1: Some(operands.formula(expression)?),
            formula2: None,
        });
    }
    let (kind, range, limits): (&'static str, Option<&str>, (&str, &str)) = match first {
        "cell-content-is-whole-number()" => ("whole", second, ("-2147483648", "2147483647")),
        "cell-content-is-decimal-number()" => ("decimal", second, ("-1E+307", "1E+307")),
        "cell-content-is-date()" => ("date", second, ("1", "2958465")),
        "cell-content-is-time()" => ("time", second, ("0", "0.999988426")),
        _ if first.starts_with("cell-content-text-length") => ("textLength", Some(first), ("0", "32767")),
        _ => return None,
    };
    let Some(range) = range else {
        // The type alone: any value of that kind.
        return Some(Rule {
            kind: Some(kind),
            operator: None,
            formula1: Some(limits.0.to_owned()),
            formula2: Some(limits.1.to_owned()),
        });
    };
    let between = |name: &str| -> Option<Option<(String, String)>> {
        match call_arguments(range, name) {
            Some(arguments) => {
                let bounds = bounds_of(arguments);
                if bounds.len() != 2 {
                    return Some(None);
                }
                Some(
                    operands
                        .formula(&bounds[0])
                        .zip(operands.formula(&bounds[1])),
                )
            }
            None => None,
        }
    };
    for (name, operator) in [
        ("cell-content-is-between", None),
        ("cell-content-is-not-between", Some("notBetween")),
        ("cell-content-text-length-is-between", None),
        ("cell-content-text-length-is-not-between", Some("notBetween")),
    ] {
        if let Some(bounds) = between(name) {
            let (low, high) = bounds?;
            return Some(Rule {
                kind: Some(kind),
                operator,
                formula1: Some(low),
                formula2: Some(high),
            });
        }
    }
    let rest = range
        .strip_prefix("cell-content()")
        .or_else(|| range.strip_prefix("cell-content-text-length()"))?;
    let (operator, operand) = comparison(rest)?;
    Some(Rule {
        kind: Some(kind),
        operator: Some(operator),
        formula1: Some(operands.formula(operand)?),
        formula2: None,
    })
}

fn clip(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

/// `<dataValidations>` for the cells that point at a validation.
pub(crate) fn data_validations_xml(
    sheet: &OdsSheetFormat,
    formats: &OdsFormats,
    names: &Names,
) -> String {
    let mut areas: BTreeMap<u32, Vec<((u32, u32), (u32, u32))>> = BTreeMap::new();
    for run in &sheet.validations {
        areas.entry(run.name).or_default().push((
            (run.first_row, run.first_column),
            (run.last_row, run.last_column),
        ));
    }
    let mut rules = String::new();
    let mut count = 0usize;
    for (name, mut areas) in areas {
        let Some(validation): Option<&Validation> =
            formats.name(name).and_then(|name| formats.validations.get(name))
        else {
            continue;
        };
        areas.sort_unstable();
        areas.truncate(MAX_AREAS);
        let Some(anchor) = areas.first().map(|area| area.0) else {
            continue;
        };
        let operands = Operands::new(names, &validation.base, anchor);
        let Some(rule) = validation_rule(&validation.condition, &operands) else {
            continue;
        };
        let mut attributes = String::new();
        if let Some(kind) = rule.kind {
            attributes.push_str(&format!(r#" type="{kind}""#));
        }
        if validation.show_error {
            match validation.error_kind.as_str() {
                "warning" => attributes.push_str(r#" errorStyle="warning""#),
                "information" => attributes.push_str(r#" errorStyle="information""#),
                _ => {}
            }
        }
        if let Some(operator) = rule.operator {
            attributes.push_str(&format!(r#" operator="{operator}""#));
        }
        if validation.allow_empty {
            attributes.push_str(r#" allowBlank="1""#);
        }
        // Excel's flag is the inverse of its name: set, it hides the list.
        if rule.kind == Some("list") && !validation.show_list {
            attributes.push_str(r#" showDropDown="1""#);
        }
        let has_help = validation.show_help
            && (validation.help_title.is_some() || !validation.help_text.is_empty());
        if has_help {
            attributes.push_str(r#" showInputMessage="1""#);
        }
        if validation.show_error {
            attributes.push_str(r#" showErrorMessage="1""#);
        }
        if rule.kind.is_none() && !has_help {
            continue;
        }
        if validation.show_error {
            if let Some(title) = validation.error_title.as_deref().filter(|title| !title.is_empty()) {
                attributes.push_str(&format!(r#" errorTitle="{}""#, escape_xml(&clip(title, 32))));
            }
            if !validation.error_text.is_empty() {
                attributes.push_str(&format!(
                    r#" error="{}""#,
                    escape_attribute(&clip(&validation.error_text, 255))
                ));
            }
        }
        if has_help {
            if let Some(title) = validation.help_title.as_deref().filter(|title| !title.is_empty()) {
                attributes.push_str(&format!(r#" promptTitle="{}""#, escape_xml(&clip(title, 32))));
            }
            if !validation.help_text.is_empty() {
                attributes.push_str(&format!(
                    r#" prompt="{}""#,
                    escape_attribute(&clip(&validation.help_text, 255))
                ));
            }
        }
        let sqref: Vec<String> = areas
            .iter()
            .map(|(start, end)| area_reference(*start, *end))
            .collect();
        let mut body = String::new();
        if let Some(formula) = &rule.formula1 {
            body.push_str(&format!("<formula1>{}</formula1>", escape_xml(formula)));
        }
        if let Some(formula) = &rule.formula2 {
            body.push_str(&format!("<formula2>{}</formula2>", escape_xml(formula)));
        }
        rules.push_str(&format!(
            r#"<dataValidation{attributes} sqref="{}">{body}</dataValidation>"#,
            sqref.join(" ")
        ));
        count += 1;
        if count >= MAX_RULES {
            break;
        }
    }
    if count == 0 {
        return String::new();
    }
    format!(r#"<dataValidations count="{count}">{rules}</dataValidations>"#)
}

/// Attribute text with its line breaks kept: a raw newline in an attribute
/// is read back as a space.
fn escape_attribute(text: &str) -> String {
    escape_xml(text).replace('\n', "&#10;")
}

/// The body of a `cfRule` and its attributes, for one `calcext:condition`.
fn condition_rule(value: &str, operands: &Operands<'_>, anchor: (u32, u32)) -> Option<(String, String)> {
    let value = value.trim();
    let anchor_reference = cell_reference(anchor.0, anchor.1);
    let formula = |text: &str| format!("<formula>{}</formula>", escape_xml(text));
    let quoted = |arguments: &str| -> Option<String> {
        let text = arguments.trim();
        let inner = text.strip_prefix('"')?.strip_suffix('"')?;
        Some(inner.replace("\"\"", "\""))
    };
    let literal = |text: &str| format!("\"{}\"", text.replace('"', "\"\""));

    if let Some(expression) = call_arguments(value, "formula-is") {
        return Some((
            r#" type="expression""#.to_owned(),
            formula(&operands.formula(expression)?),
        ));
    }
    for (name, operator) in [("between", "between"), ("not-between", "notBetween")] {
        if let Some(arguments) = call_arguments(value, name) {
            let bounds = bounds_of(arguments);
            if bounds.len() != 2 {
                return None;
            }
            return Some((
                format!(r#" type="cellIs" operator="{operator}""#),
                format!(
                    "{}{}",
                    formula(&operands.formula(&bounds[0])?),
                    formula(&operands.formula(&bounds[1])?)
                ),
            ));
        }
    }
    for (name, bottom, percent) in [
        ("top-elements", false, false),
        ("bottom-elements", true, false),
        ("top-percent", false, true),
        ("bottom-percent", true, true),
    ] {
        if let Some(arguments) = call_arguments(value, name) {
            let rank: u32 = arguments.trim().parse().ok()?;
            let mut attributes = r#" type="top10""#.to_owned();
            if percent {
                attributes.push_str(r#" percent="1""#);
            }
            if bottom {
                attributes.push_str(r#" bottom="1""#);
            }
            attributes.push_str(&format!(r#" rank="{rank}""#));
            return Some((attributes, String::new()));
        }
    }
    for (name, kind, operator) in [
        ("begins-with", "beginsWith", "beginsWith"),
        ("ends-with", "endsWith", "endsWith"),
        ("contains-text", "containsText", "containsText"),
        ("not-contains-text", "notContainsText", "notContains"),
    ] {
        if let Some(arguments) = call_arguments(value, name) {
            let text = quoted(arguments)?;
            let needle = literal(&text);
            let test = match kind {
                "beginsWith" => format!("LEFT({anchor_reference},LEN({needle}))={needle}"),
                "endsWith" => format!("RIGHT({anchor_reference},LEN({needle}))={needle}"),
                "containsText" => format!("NOT(ISERROR(SEARCH({needle},{anchor_reference})))"),
                _ => format!("ISERROR(SEARCH({needle},{anchor_reference}))"),
            };
            return Some((
                format!(
                    r#" type="{kind}" operator="{operator}" text="{}""#,
                    escape_xml(&text)
                ),
                formula(&test),
            ));
        }
    }
    let simple = match value {
        "duplicate" => Some((r#" type="duplicateValues""#.to_owned(), String::new())),
        "unique" => Some((r#" type="uniqueValues""#.to_owned(), String::new())),
        "above-average" => Some((r#" type="aboveAverage""#.to_owned(), String::new())),
        "below-average" => Some((
            r#" type="aboveAverage" aboveAverage="0""#.to_owned(),
            String::new(),
        )),
        "above-equal-average" => Some((
            r#" type="aboveAverage" equalAverage="1""#.to_owned(),
            String::new(),
        )),
        "below-equal-average" => Some((
            r#" type="aboveAverage" aboveAverage="0" equalAverage="1""#.to_owned(),
            String::new(),
        )),
        "is-error" => Some((
            r#" type="containsErrors""#.to_owned(),
            formula(&format!("ISERROR({anchor_reference})")),
        )),
        "is-no-error" => Some((
            r#" type="notContainsErrors""#.to_owned(),
            formula(&format!("NOT(ISERROR({anchor_reference}))")),
        )),
        _ => None,
    };
    if simple.is_some() {
        return simple;
    }
    let (operator, operand) = comparison(value)?;
    Some((
        format!(r#" type="cellIs" operator="{operator}""#),
        formula(&operands.formula(operand)?),
    ))
}

/// `<cfvo>` for a colour-scale or data-bar point.
fn scale_point_xml(point: &ScalePoint, operands: &Operands<'_>) -> Option<String> {
    let value = |text: &str| -> Option<String> {
        let formula = operands.formula(text)?;
        Some(format!(r#" val="{}""#, escape_xml(&formula)))
    };
    Some(match point.kind.as_str() {
        "minimum" | "auto-minimum" => r#"<cfvo type="min"/>"#.to_owned(),
        "maximum" | "auto-maximum" => r#"<cfvo type="max"/>"#.to_owned(),
        "percent" => format!(r#"<cfvo type="percent"{}/>"#, value(&point.value)?),
        "percentile" => format!(r#"<cfvo type="percentile"{}/>"#, value(&point.value)?),
        "number" => format!(r#"<cfvo type="num"{}/>"#, value(&point.value)?),
        "formula" => format!(r#"<cfvo type="formula"{}/>"#, value(&point.value)?),
        _ => return None,
    })
}

/// `<conditionalFormatting>` elements for the sheet's conditional formats.
pub(crate) fn conditional_formatting_xml(
    sheet: &OdsSheetFormat,
    formats: &OdsFormats,
    xlsx: &mut XlsxStyles,
    names: &Names,
) -> String {
    let mut out = String::new();
    let mut priority = 0usize;
    for format in &sheet.conditional {
        let mut areas: Vec<((u32, u32), (u32, u32))> = split_addresses(&format.target)
            .into_iter()
            .filter_map(parse_range_address)
            .map(|(_, start, end)| (start, end))
            .collect();
        areas.truncate(MAX_AREAS);
        let Some(anchor) = areas.first().map(|area| area.0) else {
            continue;
        };
        let mut rules = String::new();
        for entry in &format.entries {
            if priority >= MAX_RULES {
                break;
            }
            match entry {
                ConditionalEntry::Condition { value, style, base } => {
                    let operands = Operands::new(names, base, anchor);
                    let Some((attributes, body)) = condition_rule(value, &operands, anchor) else {
                        continue;
                    };
                    let dxf = xlsx
                        .dxf(&formats.book, style)
                        .map(|id| format!(r#" dxfId="{id}""#))
                        .unwrap_or_default();
                    priority += 1;
                    rules.push_str(&format!(
                        r#"<cfRule{attributes}{dxf} priority="{priority}">{body}</cfRule>"#
                    ));
                }
                ConditionalEntry::ColorScale(points) => {
                    let operands = Operands::new(names, "", anchor);
                    let values: Option<Vec<String>> = points
                        .iter()
                        .map(|point| scale_point_xml(point, &operands))
                        .collect();
                    let colors: Option<Vec<String>> = points
                        .iter()
                        .map(|point| point.color.as_deref().and_then(hex_color))
                        .collect();
                    let (Some(values), Some(colors)) = (values, colors) else {
                        continue;
                    };
                    if !(2..=3).contains(&values.len()) {
                        continue;
                    }
                    priority += 1;
                    rules.push_str(&format!(
                        r#"<cfRule type="colorScale" priority="{priority}"><colorScale>{}{}</colorScale></cfRule>"#,
                        values.concat(),
                        colors
                            .iter()
                            .map(|color| format!(r#"<color rgb="FF{color}"/>"#))
                            .collect::<String>(),
                    ));
                }
                ConditionalEntry::DataBar { points, color } => {
                    let operands = Operands::new(names, "", anchor);
                    let values: Option<Vec<String>> = points
                        .iter()
                        .map(|point| scale_point_xml(point, &operands))
                        .collect();
                    let Some(values) = values.filter(|values| values.len() == 2) else {
                        continue;
                    };
                    let color = color
                        .as_deref()
                        .and_then(hex_color)
                        .unwrap_or_else(|| "638EC6".to_owned());
                    priority += 1;
                    rules.push_str(&format!(
                        r#"<cfRule type="dataBar" priority="{priority}"><dataBar>{}<color rgb="FF{color}"/></dataBar></cfRule>"#,
                        values.concat(),
                    ));
                }
            }
        }
        if rules.is_empty() {
            continue;
        }
        let sqref: Vec<String> = areas
            .iter()
            .map(|(start, end)| area_reference(*start, *end))
            .collect();
        out.push_str(&format!(
            r#"<conditionalFormatting sqref="{}">{rules}</conditionalFormatting>"#,
            sqref.join(" ")
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operands(names: &Names) -> Operands<'_> {
        Operands {
            names,
            rows: 0,
            columns: 0,
        }
    }

    #[test]
    fn relative_references_move_and_absolute_ones_stay() {
        assert_eq!(
            shift_references("[.A1]+[.$B$2]+[$'My.Sheet'.C$3:.$D4]&\"[.A1]\"", 2, 1).as_deref(),
            Some("[.B3]+[.$B$2]+[$'My.Sheet'.D$3:.$D6]&\"[.A1]\"")
        );
        assert_eq!(shift_references("[.A1]", -1, 0), None, "off the grid");
        assert_eq!(shift_references("1+2", 5, 5).as_deref(), Some("1+2"));
    }

    #[test]
    fn validation_conditions_become_types_operators_and_formulas() {
        let names = Names::default();
        let operands = operands(&names);
        let rule = |condition: &str| validation_rule(condition, &operands).unwrap();
        let list = rule(r#"of:cell-content-is-in-list("a";"b ""x""";"c")"#);
        assert_eq!(list.kind, Some("list"));
        assert_eq!(list.formula1.as_deref(), Some(r#""a,b ""x"",c""#));
        let range = rule("of:cell-content-is-in-list([$Data.$A$1:.$A$5])");
        assert_eq!(range.formula1.as_deref(), Some("Data!$A$1:$A$5"));
        let comma = rule("of:cell-content-is-decimal-number() and cell-content-is-between(2000,2100)");
        assert_eq!((comma.formula1.as_deref(), comma.formula2.as_deref()), (Some("2000"), Some("2100")));
        let whole = rule("of:cell-content-is-whole-number() and cell-content-is-between(1;10)");
        assert_eq!((whole.kind, whole.operator), (Some("whole"), None));
        assert_eq!((whole.formula1.as_deref(), whole.formula2.as_deref()), (Some("1"), Some("10")));
        let decimal = rule("of:cell-content-is-decimal-number() and cell-content()>=[.B1]");
        assert_eq!(decimal.operator, Some("greaterThanOrEqual"));
        assert_eq!(decimal.formula1.as_deref(), Some("B1"));
        let length = rule("of:cell-content-text-length()<=10");
        assert_eq!((length.kind, length.operator), (Some("textLength"), Some("lessThanOrEqual")));
        let custom = rule("of:is-true-formula(LEN([.A1])>2)");
        assert_eq!(custom.kind, Some("custom"));
        assert_eq!(custom.formula1.as_deref(), Some("LEN(A1)>2"));
        assert!(validation_rule(r#"of:cell-content-is-in-list("a,b";"c")"#, &operands).is_none());
        assert!(validation_rule("of:something-else()", &operands).is_none());
    }

    #[test]
    fn conditional_values_become_rules() {
        let names = Names::default();
        let operands = operands(&names);
        let rule = |value: &str| condition_rule(value, &operands, (1, 1)).unwrap();
        assert_eq!(
            rule(">5"),
            (r#" type="cellIs" operator="greaterThan""#.to_owned(), "<formula>5</formula>".to_owned())
        );
        assert_eq!(
            rule("between(1;[.C2])").1,
            "<formula>1</formula><formula>C2</formula>"
        );
        assert_eq!(rule("formula-is(MOD(ROW();2)=0)").0, r#" type="expression""#);
        assert_eq!(rule("top-percent(10)").0, r#" type="top10" percent="1" rank="10""#);
        assert_eq!(rule("below-equal-average").0, r#" type="aboveAverage" aboveAverage="0" equalAverage="1""#);
        let contains = rule(r#"contains-text("ab")"#);
        assert_eq!(contains.0, r#" type="containsText" operator="containsText" text="ab""#);
        assert_eq!(contains.1, "<formula>NOT(ISERROR(SEARCH(&quot;ab&quot;,B2)))</formula>");
        assert_eq!(rule("duplicate").0, r#" type="duplicateValues""#);
        assert!(condition_rule("date-is(today)", &operands, (0, 0)).is_none());
    }
}
