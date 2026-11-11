//! Data validations and conditional formats for the `.ods` export.
//!
//! Both are rules over ranges with a formula language of their own. A
//! validation is declared once at the top of the spreadsheet and named by
//! every cell it covers — empty ones included, since the cells a validation
//! guards are mostly the ones still waiting for input. A conditional format
//! sits at the end of its table and names a cell style kept in `styles.xml`.
//!
//! A rule that cannot be said in ODF is left out and counted, so the caller
//! can warn about it.

use std::collections::HashMap;

use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};

use crate::odf_formula::{self, Names};
use crate::ods_styles::StyleRegistry;
use crate::xlsx_package::escape_xml;
use crate::{CellStyle, Cfvo, ConditionalRule, DataValidationRule, MergedRange};

/// One range a validation covers, with the name its cells point at.
#[derive(Clone, Debug)]
pub(crate) struct ValidationArea {
    pub(crate) range: MergedRange,
    pub(crate) name: String,
}

/// The `table:content-validations` of the whole document, collected sheet by
/// sheet while the tables are written.
#[derive(Default)]
pub(crate) struct Validations {
    pub(crate) xml: String,
    counter: usize,
}

impl Validations {
    /// Declares a sheet's validations. Answers the areas the row writer has
    /// to mark, sorted by first row, and how many rules had to stay behind.
    pub(crate) fn register(
        &mut self,
        sheet: &str,
        rules: &[DataValidationRule],
        names: &Names,
    ) -> (Vec<ValidationArea>, u32) {
        let mut areas = Vec::new();
        let mut dropped = 0;
        for rule in rules {
            let Some(first) = rule.ranges.first() else {
                continue;
            };
            let Ok(condition) = validation_condition(rule, names) else {
                dropped += 1;
                continue;
            };
            self.counter += 1;
            let name = format!("val{}", self.counter);
            let mut attributes = format!(r#" table:name="{name}""#);
            if let Some(condition) = &condition {
                attributes.push_str(&format!(r#" table:condition="{}""#, escape_xml(condition)));
            }
            attributes.push_str(&format!(
                r#" table:allow-empty-cell="{}""#,
                rule.allow_blank
            ));
            if rule.rule_type == "list" {
                attributes.push_str(if rule.suppress_dropdown {
                    r#" table:display-list="no""#
                } else {
                    r#" table:display-list="unsorted""#
                });
            }
            // Relative references in the condition are read from the first
            // cell of the first range, as Excel reads them.
            attributes.push_str(&format!(
                r#" table:base-cell-address="{}""#,
                escape_xml(&cell_address(sheet, first.start_row, first.start_column))
            ));
            let mut body = String::new();
            if rule.show_input_message && (rule.prompt.is_some() || rule.prompt_title.is_some()) {
                body.push_str(&message_xml(
                    "table:help-message",
                    "",
                    rule.prompt_title.as_deref(),
                    rule.prompt.as_deref(),
                ));
            }
            if rule.show_error_message {
                let kind = match rule.error_style.as_deref() {
                    Some("warning") => "warning",
                    Some("information") => "information",
                    _ => "stop",
                };
                body.push_str(&message_xml(
                    "table:error-message",
                    &format!(r#" table:message-type="{kind}""#),
                    rule.error_title.as_deref(),
                    rule.error.as_deref(),
                ));
            }
            if body.is_empty() {
                self.xml
                    .push_str(&format!("<table:content-validation{attributes}/>"));
            } else {
                self.xml.push_str(&format!(
                    "<table:content-validation{attributes}>{body}</table:content-validation>"
                ));
            }
            for range in &rule.ranges {
                areas.push(ValidationArea {
                    range: *range,
                    name: name.clone(),
                });
            }
        }
        areas.sort_by_key(|area| (area.range.start_row, area.range.start_column));
        (areas, dropped)
    }
}

fn message_xml(element: &str, kind: &str, title: Option<&str>, text: Option<&str>) -> String {
    let mut attributes = kind.to_owned();
    if let Some(title) = title.filter(|title| !title.is_empty()) {
        attributes.push_str(&format!(r#" table:title="{}""#, escape_xml(title)));
    }
    attributes.push_str(r#" table:display="true""#);
    let paragraphs: String = text
        .unwrap_or("")
        .split('\n')
        .map(|line| format!("<text:p>{}</text:p>", escape_xml(&printable(line))))
        .collect();
    format!("<{element}{attributes}>{paragraphs}</{element}>")
}

/// XML cannot carry control characters; a message loses them.
fn printable(text: &str) -> String {
    text.chars()
        .filter(|character| *character == '\t' || (*character as u32) >= 0x20)
        .collect()
}

/// `Sheet1.B2`, the address a base cell and a target range are written in.
fn cell_address(sheet: &str, row: usize, column: usize) -> String {
    format!(
        "{}.{}{}",
        odf_formula::odf_sheet_name(sheet),
        column_name(column),
        row + 1
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

/// One operand of a rule as an OpenFormula expression.
fn operand(raw: &str, names: &Names) -> Result<String, ()> {
    let raw = raw.trim();
    let raw = raw.strip_prefix('=').unwrap_or(raw);
    if raw.is_empty() {
        return Err(());
    }
    odf_formula::odf_named_expression(raw, names).ok_or(())
}

/// The comparison a rule makes, in the two spellings ODF has for it: a
/// subject compared with an operator, or a between function.
fn comparison(
    operator: Option<&str>,
    formulas: &[String],
    names: &Names,
    subject: &str,
    between: &str,
) -> Result<String, ()> {
    let first = operand(formulas.first().map(String::as_str).unwrap_or(""), names)?;
    let second = || operand(formulas.get(1).map(String::as_str).unwrap_or(""), names);
    Ok(match operator.unwrap_or("between") {
        "between" => format!("{between}({first},{})", second()?),
        "notBetween" => format!(
            "{}({first},{})",
            between.replacen("between", "not-between", 1),
            second()?
        ),
        "equal" => format!("{subject}={first}"),
        "notEqual" => format!("{subject}!={first}"),
        "greaterThan" => format!("{subject}>{first}"),
        "lessThan" => format!("{subject}<{first}"),
        "greaterThanOrEqual" => format!("{subject}>={first}"),
        "lessThanOrEqual" => format!("{subject}<={first}"),
        _ => return Err(()),
    })
}

/// The `table:condition` of a validation. `Ok(None)` is a rule without a
/// condition (only its messages); `Err` is one ODF cannot say.
fn validation_condition(rule: &DataValidationRule, names: &Names) -> Result<Option<String>, ()> {
    let compare = |subject: &str, between: &str| {
        comparison(rule.operator.as_deref(), &rule.formulas, names, subject, between)
    };
    let typed = |kind: &str| -> Result<String, ()> {
        Ok(format!(
            "cell-content-is-{kind}() and {}",
            compare("cell-content()", "cell-content-is-between")?
        ))
    };
    let body = match rule.rule_type.as_str() {
        "" | "none" => return Ok(None),
        "list" => format!(
            "cell-content-is-in-list({})",
            list_source(rule.formulas.first().map(String::as_str).unwrap_or(""), names)?
        ),
        "whole" => typed("whole-number")?,
        "decimal" => typed("decimal-number")?,
        "date" => typed("date")?,
        "time" => typed("time")?,
        "textLength" => compare(
            "cell-content-text-length()",
            "cell-content-text-length-is-between",
        )?,
        "custom" => format!(
            "is-true-formula({})",
            operand(rule.formulas.first().map(String::as_str).unwrap_or(""), names)?
        ),
        _ => return Err(()),
    };
    Ok(Some(format!("of:{body}")))
}

/// The entries of a list validation: Excel's one quoted, comma-separated
/// string becomes one string per entry; anything else is a range or a name.
fn list_source(raw: &str, names: &Names) -> Result<String, ()> {
    let trimmed = raw.trim();
    let trimmed = trimmed.strip_prefix('=').unwrap_or(trimmed);
    let literal = trimmed
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        // A quote inside means this is an expression that merely starts and
        // ends with strings, unless every quote is doubled.
        .filter(|inner| !inner.replace("\"\"", "").contains('"'));
    match literal {
        Some(inner) => Ok(inner
            .replace("\"\"", "\"")
            .split(',')
            .map(|item| format!("\"{}\"", item.trim().replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(";")),
        None => operand(trimmed, names),
    }
}

/// What the session model does not keep of a conditional rule, read from the
/// worksheet part by the rule's priority (unique within a sheet).
#[derive(Default)]
pub(crate) struct RuleExtras {
    averages: HashMap<i64, Average>,
    periods: HashMap<i64, String>,
}

#[derive(Clone, Copy)]
struct Average {
    above: bool,
    equal: bool,
    deviations: bool,
}

/// Reads the rule extras from the part of a worksheet that follows its data.
/// What a sparkline group says beyond what the model carries: the options
/// that are switched on (by their ODF attribute name), how empty cells are
/// drawn, the line's weight in points and the colours given as RGB (by the
/// ODF attribute that takes each).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct SparklineExtra {
    pub(crate) flags: Vec<&'static str>,
    pub(crate) empty_cells: Option<String>,
    pub(crate) line_weight: Option<f64>,
    pub(crate) colors: Vec<(&'static str, String)>,
}

/// The sparkline groups of a worksheet tail, in the order they appear.
pub(crate) fn parse_sparkline_extras(tail: &[u8]) -> Vec<SparklineExtra> {
    const FLAGS: [(&[u8], &str); 9] = [
        (b"markers", "markers"),
        (b"high", "high"),
        (b"low", "low"),
        (b"first", "first"),
        (b"last", "last"),
        (b"negative", "negative"),
        (b"displayXAxis", "display-x-axis"),
        (b"displayHidden", "display-hidden"),
        (b"rightToLeft", "right-to-left"),
    ];
    const COLORS: [(&[u8], &str); 8] = [
        (b"colorSeries", "color-series"),
        (b"colorNegative", "color-negative"),
        (b"colorAxis", "color-axis"),
        (b"colorMarkers", "color-markers"),
        (b"colorFirst", "color-first"),
        (b"colorLast", "color-last"),
        (b"colorHigh", "color-high"),
        (b"colorLow", "color-low"),
    ];
    let mut groups: Vec<SparklineExtra> = Vec::new();
    // Nothing to look for in a sheet without a sparkline.
    if !tail.windows(14).any(|window| window == b"sparklineGroup") {
        return groups;
    }
    let mut reader = Reader::from_reader(tail);
    reader.config_mut().check_end_names = false;
    reader.config_mut().allow_unmatched_ends = true;
    let mut buffer = Vec::new();
    let mut open = false;
    loop {
        let event = match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(event) => event,
        };
        match &event {
            Event::Start(element) | Event::Empty(element) => {
                let name = element.local_name();
                let name = name.as_ref();
                if name == b"sparklineGroup" {
                    let on = |key: &[u8]| {
                        attribute(element, key).is_some_and(|value| value == "1" || value == "true")
                    };
                    groups.push(SparklineExtra {
                        flags: FLAGS
                            .iter()
                            .filter(|(key, _)| on(key))
                            .map(|(_, flag)| *flag)
                            .collect(),
                        empty_cells: attribute(element, b"displayEmptyCellsAs"),
                        line_weight: attribute(element, b"lineWeight")
                            .and_then(|value| value.parse::<f64>().ok())
                            .filter(|value| value.is_finite() && *value > 0.0),
                        colors: Vec::new(),
                    });
                    open = matches!(event, Event::Start(_));
                } else if open {
                    if let Some((_, slot)) = COLORS.iter().find(|(key, _)| *key == name) {
                        // A colour of the theme is the model's to resolve;
                        // only one given outright is taken here.
                        let rgb = attribute(element, b"rgb").filter(|rgb| {
                            matches!(rgb.len(), 6 | 8)
                                && rgb.chars().all(|character| character.is_ascii_hexdigit())
                        });
                        if let (Some(rgb), Some(group)) = (rgb, groups.last_mut()) {
                            let hex = &rgb[rgb.len() - 6..];
                            group.colors.push((slot, format!("#{}", hex.to_ascii_lowercase())));
                        }
                    }
                }
            }
            Event::End(element) if element.local_name().as_ref() == b"sparklineGroup" => {
                open = false;
            }
            _ => {}
        }
        buffer.clear();
    }
    groups
}

pub(crate) fn parse_rule_extras(tail: &[u8]) -> RuleExtras {
    let mut extras = RuleExtras::default();
    let mut reader = Reader::from_reader(tail);
    reader.config_mut().check_end_names = false;
    reader.config_mut().allow_unmatched_ends = true;
    let mut buffer = Vec::new();
    loop {
        let event = match reader.read_event_into(&mut buffer) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(event) => event,
        };
        if let Event::Start(element) | Event::Empty(element) = &event {
            if element.local_name().as_ref() == b"cfRule" {
                if let Some(priority) =
                    attribute(element, b"priority").and_then(|value| value.parse::<i64>().ok())
                {
                    match attribute(element, b"type").as_deref() {
                        Some("aboveAverage") => {
                            let flag = |name: &[u8], default: bool| {
                                attribute(element, name)
                                    .map_or(default, |value| value == "1" || value == "true")
                            };
                            extras.averages.insert(
                                priority,
                                Average {
                                    above: flag(b"aboveAverage", true),
                                    equal: flag(b"equalAverage", false),
                                    deviations: attribute(element, b"stdDev")
                                        .is_some_and(|value| value != "0"),
                                },
                            );
                        }
                        Some("timePeriod") => {
                            if let Some(period) = attribute(element, b"timePeriod") {
                                extras.periods.insert(priority, period);
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        buffer.clear();
    }
    extras
}

fn attribute(element: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    element
        .attributes()
        .flatten()
        .find(|attribute| attribute.key.local_name().as_ref() == name)
        .map(|attribute| String::from_utf8_lossy(&attribute.value).into_owned())
}

/// The icon sets both formats name the same way.
const ICON_SETS: &[&str] = &[
    "3Arrows",
    "3ArrowsGray",
    "3Flags",
    "3TrafficLights1",
    "3TrafficLights2",
    "3Signs",
    "3Symbols",
    "3Symbols2",
    "3Stars",
    "3Triangles",
    "4Arrows",
    "4ArrowsGray",
    "4RedToBlack",
    "4Rating",
    "4TrafficLights",
    "5Arrows",
    "5ArrowsGray",
    "5Rating",
    "5Quarters",
    "5Boxes",
];

/// The `calcext:conditional-formats` element of one sheet, and how many rules
/// stayed behind. Rules are written in priority order; neighbours over the
/// same ranges share one format, as the element expects.
pub(crate) fn conditional_formats_xml(
    sheet: &str,
    rules: &[ConditionalRule],
    dxfs: &[CellStyle],
    extras: &RuleExtras,
    names: &Names,
    registry: &mut StyleRegistry,
) -> (String, u32) {
    let mut ordered: Vec<&ConditionalRule> = rules.iter().collect();
    ordered.sort_by_key(|rule| rule.priority);
    let mut out = String::new();
    let mut dropped = 0;
    let mut open: Option<String> = None;
    for rule in ordered {
        let Some(first) = rule.ranges.first() else {
            continue;
        };
        let base = cell_address(sheet, first.start_row, first.start_column);
        let Some(entry) = rule_entry(rule, dxfs, extras, names, registry, &base) else {
            dropped += 1;
            continue;
        };
        let target = rule
            .ranges
            .iter()
            .map(|range| {
                format!(
                    "{}:{}",
                    cell_address(sheet, range.start_row, range.start_column),
                    cell_address(sheet, range.end_row, range.end_column)
                )
            })
            .collect::<Vec<_>>()
            .join(" ");
        if open.as_deref() != Some(target.as_str()) {
            if open.is_some() {
                out.push_str("</calcext:conditional-format>");
            }
            out.push_str(&format!(
                r#"<calcext:conditional-format calcext:target-range-address="{}">"#,
                escape_xml(&target)
            ));
            open = Some(target);
        }
        out.push_str(&entry);
    }
    if open.is_some() {
        out.push_str("</calcext:conditional-format>");
    }
    if out.is_empty() {
        return (out, dropped);
    }
    (
        format!("<calcext:conditional-formats>{out}</calcext:conditional-formats>"),
        dropped,
    )
}

/// One rule as the entry of a conditional format, or `None` when ODF has no
/// way to say it.
fn rule_entry(
    rule: &ConditionalRule,
    dxfs: &[CellStyle],
    extras: &RuleExtras,
    names: &Names,
    registry: &mut StyleRegistry,
    base: &str,
) -> Option<String> {
    match rule.rule_type.as_str() {
        "colorScale" => return color_scale(rule, names),
        "dataBar" => return data_bar(rule, names),
        "iconSet" => return icon_set(rule, names),
        _ => {}
    }
    // Every other rule paints a differential style; without one it changes
    // nothing a reader could show.
    let dxf = dxfs.get(rule.dxf_index?)?;
    let formula = |index: usize| {
        rule.formulas
            .get(index)
            .and_then(|raw| operand(raw, names).ok())
    };
    let text = |function: &str| {
        rule.text
            .as_deref()
            .map(|text| format!("{function}(\"{}\")", text.replace('"', "\"\"")))
    };
    // Excel stores a formula beside the rules it has a name for, so the
    // formula is the fallback when the name has no ODF counterpart.
    let by_formula = || formula(0).map(|formula| format!("formula-is({formula})"));
    let value = match rule.rule_type.as_str() {
        "cellIs" => comparison(rule.operator.as_deref(), &rule.formulas, names, "", "between").ok()?,
        "expression" => by_formula()?,
        "top10" => {
            let rank = rule.rank.unwrap_or(10);
            match (rule.bottom, rule.percent) {
                (false, false) => format!("top-elements({rank})"),
                (false, true) => format!("top-percent({rank})"),
                (true, false) => format!("bottom-elements({rank})"),
                (true, true) => format!("bottom-percent({rank})"),
            }
        }
        "aboveAverage" => {
            let average = extras.averages.get(&rule.priority).copied().unwrap_or(Average {
                above: true,
                equal: false,
                deviations: false,
            });
            if average.deviations {
                return None;
            }
            match (average.above, average.equal) {
                (true, false) => "above-average",
                (true, true) => "above-equal-average",
                (false, false) => "below-average",
                (false, true) => "below-equal-average",
            }
            .to_owned()
        }
        "duplicateValues" => "duplicate".to_owned(),
        "uniqueValues" => "unique".to_owned(),
        "containsText" => text("contains-text").or_else(by_formula)?,
        "notContainsText" => text("not-contains-text").or_else(by_formula)?,
        "beginsWith" => text("begins-with").or_else(by_formula)?,
        "endsWith" => text("ends-with").or_else(by_formula)?,
        "containsErrors" => "is-error".to_owned(),
        "notContainsErrors" => "is-no-error".to_owned(),
        "timePeriod" => {
            let period = extras.periods.get(&rule.priority).and_then(|period| {
                Some(match period.as_str() {
                    "today" => "today",
                    "yesterday" => "yesterday",
                    "tomorrow" => "tomorrow",
                    "last7Days" => "last-7-days",
                    "thisWeek" => "this-week",
                    "lastWeek" => "last-week",
                    "nextWeek" => "next-week",
                    "thisMonth" => "this-month",
                    "lastMonth" => "last-month",
                    "nextMonth" => "next-month",
                    _ => return None,
                })
            });
            match period {
                Some(period) => {
                    let style = registry.conditional_style(dxf);
                    return Some(format!(
                        r#"<calcext:date-is calcext:style="{style}" calcext:date="{period}"/>"#
                    ));
                }
                None => by_formula()?,
            }
        }
        // Blanks and whatever else Excel names: the stored formula says it.
        _ => by_formula()?,
    };
    let style = registry.conditional_style(dxf);
    Some(format!(
        r#"<calcext:condition calcext:apply-style-name="{style}" calcext:value="{}" calcext:base-cell-address="{}"/>"#,
        escape_xml(&value),
        escape_xml(base)
    ))
}

/// A threshold of a colour scale, data bar or icon set: its ODF type and
/// value. `None` when the value is a formula that does not translate.
fn threshold(cfvo: &Cfvo, names: &Names) -> Option<(&'static str, String)> {
    let kind = match cfvo.kind.as_str() {
        "min" => "minimum",
        "max" => "maximum",
        "autoMin" => "auto-minimum",
        "autoMax" => "auto-maximum",
        "num" => "number",
        "percent" => "percent",
        "percentile" => "percentile",
        "formula" => "formula",
        _ => return None,
    };
    let value = match cfvo.value.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        None => "0".to_owned(),
        Some(value) if value.parse::<f64>().is_ok() => value.to_owned(),
        Some(value) => operand(value, names).ok()?,
    };
    Some((kind, value))
}

fn entries(element: &str, rule: &ConditionalRule, names: &Names, colors: bool) -> Option<String> {
    let mut out = String::new();
    for (index, cfvo) in rule.cfvos.iter().enumerate() {
        let (kind, value) = threshold(cfvo, names)?;
        out.push_str(&format!(
            r#"<{element} calcext:value="{}" calcext:type="{kind}""#,
            escape_xml(&value)
        ));
        if colors {
            out.push_str(&format!(
                r#" calcext:color="{}""#,
                escape_xml(&color(rule.colors.get(index)?))
            ));
        }
        out.push_str("/>");
    }
    Some(out)
}

/// `#RRGGBB` in lower case, the form the element takes.
fn color(value: &str) -> String {
    let value = value.trim();
    let hex = value.strip_prefix('#').unwrap_or(value);
    // An ARGB colour keeps its last six digits.
    let hex = if hex.len() == 8 { &hex[2..] } else { hex };
    format!("#{}", hex.to_ascii_lowercase())
}

fn color_scale(rule: &ConditionalRule, names: &Names) -> Option<String> {
    if !(2..=3).contains(&rule.cfvos.len()) {
        return None;
    }
    Some(format!(
        "<calcext:color-scale>{}</calcext:color-scale>",
        entries("calcext:color-scale-entry", rule, names, true)?
    ))
}

fn data_bar(rule: &ConditionalRule, names: &Names) -> Option<String> {
    if rule.cfvos.len() != 2 {
        return None;
    }
    let mut attributes = String::new();
    if let Some(length) = rule.min_length {
        attributes.push_str(&format!(r#" calcext:min-length="{length}""#));
    }
    if let Some(length) = rule.max_length {
        attributes.push_str(&format!(r#" calcext:max-length="{length}""#));
    }
    let positive = color(rule.colors.first()?);
    // A bar without the 2010 extension is the 2007 kind: no axis, and a
    // negative value is a short bar in the same colour. A reader that is not
    // told draws an axis and its own negative colour.
    let plain = rule.negative_same_as_positive.is_none() && rule.negative_color.is_none();
    let negative = match (&rule.negative_color, rule.negative_same_as_positive) {
        (_, Some(true)) => Some(positive.clone()),
        (Some(negative), _) => Some(color(negative)),
        _ => plain.then(|| positive.clone()),
    };
    if let Some(negative) = negative {
        attributes.push_str(&format!(r#" calcext:negative-color="{}""#, escape_xml(&negative)));
    }
    match rule.axis_position.as_deref() {
        Some("middle") => attributes.push_str(r#" calcext:axis-position="middle""#),
        Some("none") => attributes.push_str(r#" calcext:axis-position="none""#),
        _ if plain => attributes.push_str(r#" calcext:axis-position="none""#),
        _ => {}
    }
    attributes.push_str(&format!(r#" calcext:positive-color="{}""#, escape_xml(&positive)));
    if let Some(axis) = &rule.axis_color {
        attributes.push_str(&format!(r#" calcext:axis-color="{}""#, escape_xml(&color(axis))));
    }
    if rule.gradient == Some(false) {
        attributes.push_str(r#" calcext:gradient="false""#);
    }
    if !rule.show_value {
        attributes.push_str(r#" calcext:show-value="false""#);
    }
    Some(format!(
        "<calcext:data-bar{attributes}>{}</calcext:data-bar>",
        entries("calcext:formatting-entry", rule, names, false)?
    ))
}

fn icon_set(rule: &ConditionalRule, names: &Names) -> Option<String> {
    let name = rule.icon_set_name.as_deref().unwrap_or("3TrafficLights1");
    // A reversed set would paint the opposite meaning, and there is no way to
    // ask a reader to reverse it.
    if rule.icon_reverse || !ICON_SETS.contains(&name) {
        return None;
    }
    let mut attributes = format!(r#" calcext:icon-set-type="{name}""#);
    if !rule.show_value {
        attributes.push_str(r#" calcext:show-value="false""#);
    }
    Some(format!(
        "<calcext:icon-set{attributes}>{}</calcext:icon-set>",
        entries("calcext:formatting-entry", rule, names, false)?
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(start_row: usize, start_column: usize, end_row: usize, end_column: usize) -> MergedRange {
        MergedRange {
            start_row,
            start_column,
            end_row,
            end_column,
        }
    }

    fn validation(rule_type: &str, operator: Option<&str>, formulas: &[&str]) -> DataValidationRule {
        DataValidationRule {
            ranges: vec![range(1, 1, 9, 1)],
            rule_type: rule_type.to_owned(),
            operator: operator.map(str::to_owned),
            formulas: formulas.iter().map(|formula| (*formula).to_owned()).collect(),
            allow_blank: true,
            suppress_dropdown: false,
            show_input_message: false,
            show_error_message: false,
            error_style: None,
            error_title: None,
            error: None,
            prompt_title: None,
            prompt: None,
        }
    }

    fn condition(rule_type: &str, operator: Option<&str>, formulas: &[&str]) -> Option<String> {
        validation_condition(&validation(rule_type, operator, formulas), &Names::default())
            .ok()
            .flatten()
    }

    #[test]
    fn says_each_validation_type_the_way_a_reader_expects() {
        assert_eq!(
            condition("list", None, &["\"사과,배, 감\""]).as_deref(),
            Some(r#"of:cell-content-is-in-list("사과";"배";"감")"#)
        );
        assert_eq!(
            condition("list", None, &["$H$1:$H$3"]).as_deref(),
            Some("of:cell-content-is-in-list([.$H$1:.$H$3])")
        );
        assert_eq!(
            condition("whole", Some("between"), &["1", "10"]).as_deref(),
            Some("of:cell-content-is-whole-number() and cell-content-is-between(1,10)")
        );
        assert_eq!(
            condition("decimal", Some("greaterThanOrEqual"), &["0"]).as_deref(),
            Some("of:cell-content-is-decimal-number() and cell-content()>=0")
        );
        assert_eq!(
            condition("time", Some("notBetween"), &["0.25", "0.5"]).as_deref(),
            Some("of:cell-content-is-time() and cell-content-is-not-between(0.25,0.5)")
        );
        assert_eq!(
            condition("textLength", Some("lessThanOrEqual"), &["5"]).as_deref(),
            Some("of:cell-content-text-length()<=5")
        );
        assert_eq!(
            condition("textLength", Some("notBetween"), &["2", "4"]).as_deref(),
            Some("of:cell-content-text-length-is-not-between(2,4)")
        );
        assert_eq!(
            condition("custom", None, &["ISNUMBER(I2)"]).as_deref(),
            Some("of:is-true-formula(ISNUMBER([.I2]))")
        );
        // An operator defaults to between, and a missing bound is not a rule.
        assert_eq!(
            condition("whole", None, &["1", "2"]).as_deref(),
            Some("of:cell-content-is-whole-number() and cell-content-is-between(1,2)")
        );
        assert!(validation_condition(&validation("whole", None, &["1"]), &Names::default()).is_err());
        assert!(validation_condition(&validation("fancy", None, &["1"]), &Names::default()).is_err());
        assert_eq!(
            validation_condition(&validation("none", None, &[]), &Names::default()),
            Ok(None)
        );
    }

    #[test]
    fn declares_a_validation_once_and_marks_every_range() {
        let mut rule = validation("whole", Some("between"), &["1", "10"]);
        rule.ranges.push(range(0, 5, 0, 6));
        rule.show_error_message = true;
        rule.error_style = Some("warning".into());
        rule.error_title = Some("범위 밖".into());
        rule.error = Some("1에서\n10 사이".into());
        rule.show_input_message = true;
        rule.prompt = Some("숫자".into());
        let mut list = validation("list", None, &["\"a,b\""]);
        list.suppress_dropdown = true;
        list.allow_blank = false;
        let broken = validation("custom", None, &["Table1[col]"]);
        let mut validations = Validations::default();
        let (areas, dropped) =
            validations.register("My Sheet", &[rule, list, broken], &Names::default());
        assert_eq!(dropped, 1, "a structured reference is not a condition");
        assert_eq!(
            areas
                .iter()
                .map(|area| (area.range.start_row, area.name.as_str()))
                .collect::<Vec<_>>(),
            [(0, "val1"), (1, "val1"), (1, "val2")]
        );
        assert_eq!(
            validations.xml,
            concat!(
                r#"<table:content-validation table:name="val1" table:condition="of:cell-content-is-whole-number() and cell-content-is-between(1,10)" table:allow-empty-cell="true" table:base-cell-address="'My Sheet'.B2">"#,
                r#"<table:help-message table:display="true"><text:p>숫자</text:p></table:help-message>"#,
                r#"<table:error-message table:message-type="warning" table:title="범위 밖" table:display="true"><text:p>1에서</text:p><text:p>10 사이</text:p></table:error-message>"#,
                r#"</table:content-validation>"#,
                r#"<table:content-validation table:name="val2" table:condition="of:cell-content-is-in-list(&quot;a&quot;;&quot;b&quot;)" table:allow-empty-cell="false" table:display-list="no" table:base-cell-address="'My Sheet'.B2"/>"#,
            )
        );
    }

    fn rule(rule_type: &str, priority: i64) -> ConditionalRule {
        ConditionalRule {
            ranges: vec![range(0, 0, 19, 0)],
            rule_type: rule_type.to_owned(),
            operator: None,
            formulas: Vec::new(),
            text: None,
            dxf_index: Some(0),
            priority,
            stop_if_true: false,
            rank: None,
            percent: false,
            bottom: false,
            cfvos: Vec::new(),
            colors: Vec::new(),
            icon_set_name: None,
            icon_reverse: false,
            show_value: true,
            negative_color: None,
            negative_same_as_positive: None,
            gradient: None,
            axis_position: None,
            axis_color: None,
            min_length: None,
            max_length: None,
        }
    }

    fn cfvo(kind: &str, value: Option<&str>) -> Cfvo {
        Cfvo {
            kind: kind.to_owned(),
            value: value.map(str::to_owned),
            gte: None,
        }
    }

    fn formats(rules: &[ConditionalRule], tail: &str) -> (String, u32, String) {
        let mut registry = StyleRegistry::new(CellStyle::default());
        let dxf = CellStyle {
            fill_color: Some("#FFC7CE".into()),
            bold: true,
            ..CellStyle::default()
        };
        let extras = parse_rule_extras(tail.as_bytes());
        let (xml, dropped) = conditional_formats_xml(
            "Rules",
            rules,
            &[dxf],
            &extras,
            &Names::default(),
            &mut registry,
        );
        (xml, dropped, registry.conditional_styles())
    }

    #[test]
    fn writes_style_rules_in_priority_order_and_shares_a_format_per_range() {
        let mut greater = rule("cellIs", 2);
        greater.operator = Some("greaterThan".into());
        greater.formulas = vec!["10".into()];
        let mut between = rule("cellIs", 1);
        between.operator = Some("notBetween".into());
        between.formulas = vec!["3".into(), "$A$1+1".into()];
        let mut expression = rule("expression", 3);
        expression.ranges = vec![range(0, 1, 19, 1), range(0, 3, 4, 3)];
        expression.formulas = vec!["MOD(B1,2)=0".into()];
        let mut top = rule("top10", 4);
        top.rank = Some(3);
        top.bottom = true;
        top.percent = true;
        let mut text = rule("containsText", 5);
        text.text = Some("a\"b".into());
        let below = rule("aboveAverage", 6);
        let period = rule("timePeriod", 7);
        let blanks = {
            let mut blanks = rule("containsBlanks", 8);
            blanks.formulas = vec!["LEN(TRIM(A1))=0".into()];
            blanks
        };
        let tail = r#"<conditionalFormatting sqref="A1:A20"><cfRule type="aboveAverage" dxfId="0" priority="6" aboveAverage="0" equalAverage="1"/><cfRule type="timePeriod" dxfId="0" priority="7" timePeriod="last7Days"/></conditionalFormatting>"#;
        let (xml, dropped, styles) = formats(
            &[greater, between, expression, top, text, below, period, blanks],
            tail,
        );
        assert_eq!(dropped, 0);
        assert_eq!(
            xml,
            concat!(
                r#"<calcext:conditional-formats>"#,
                r#"<calcext:conditional-format calcext:target-range-address="Rules.A1:Rules.A20">"#,
                r#"<calcext:condition calcext:apply-style-name="ConditionalStyle_1" calcext:value="not-between(3,[.$A$1]+1)" calcext:base-cell-address="Rules.A1"/>"#,
                r#"<calcext:condition calcext:apply-style-name="ConditionalStyle_1" calcext:value="&gt;10" calcext:base-cell-address="Rules.A1"/>"#,
                r#"</calcext:conditional-format>"#,
                r#"<calcext:conditional-format calcext:target-range-address="Rules.B1:Rules.B20 Rules.D1:Rules.D5">"#,
                r#"<calcext:condition calcext:apply-style-name="ConditionalStyle_1" calcext:value="formula-is(MOD([.B1];2)=0)" calcext:base-cell-address="Rules.B1"/>"#,
                r#"</calcext:conditional-format>"#,
                r#"<calcext:conditional-format calcext:target-range-address="Rules.A1:Rules.A20">"#,
                r#"<calcext:condition calcext:apply-style-name="ConditionalStyle_1" calcext:value="bottom-percent(3)" calcext:base-cell-address="Rules.A1"/>"#,
                r#"<calcext:condition calcext:apply-style-name="ConditionalStyle_1" calcext:value="contains-text(&quot;a&quot;&quot;b&quot;)" calcext:base-cell-address="Rules.A1"/>"#,
                r#"<calcext:condition calcext:apply-style-name="ConditionalStyle_1" calcext:value="below-equal-average" calcext:base-cell-address="Rules.A1"/>"#,
                r#"<calcext:date-is calcext:style="ConditionalStyle_1" calcext:date="last-7-days"/>"#,
                r#"<calcext:condition calcext:apply-style-name="ConditionalStyle_1" calcext:value="formula-is(LEN(TRIM([.A1]))=0)" calcext:base-cell-address="Rules.A1"/>"#,
                r#"</calcext:conditional-format>"#,
                r#"</calcext:conditional-formats>"#,
            )
        );
        assert!(
            styles.contains(r#"<style:style style:name="ConditionalStyle_1" style:family="table-cell" style:parent-style-name="Default">"#),
            "{styles}"
        );
        assert!(styles.contains(r##"fo:background-color="#FFC7CE""##), "{styles}");
        assert!(styles.contains(r#"fo:font-weight="bold""#), "{styles}");
    }

    #[test]
    fn writes_scales_bars_and_icons_and_counts_what_it_cannot_say() {
        let mut scale = rule("colorScale", 1);
        scale.dxf_index = None;
        scale.cfvos = vec![cfvo("min", None), cfvo("percentile", Some("50")), cfvo("formula", Some("$A$1"))];
        scale.colors = vec!["#F8696B".into(), "FFFFEB84".into(), "#63BE7B".into()];
        let mut bar = rule("dataBar", 2);
        bar.dxf_index = None;
        bar.cfvos = vec![cfvo("autoMin", None), cfvo("max", None)];
        bar.colors = vec!["#638EC6".into()];
        bar.min_length = Some(0);
        bar.max_length = Some(100);
        bar.negative_color = Some("#FF0000".into());
        bar.axis_position = Some("middle".into());
        bar.gradient = Some(false);
        bar.show_value = false;
        let mut icons = rule("iconSet", 3);
        icons.dxf_index = None;
        icons.icon_set_name = Some("3Arrows".into());
        icons.cfvos = vec![cfvo("percent", Some("0")), cfvo("percent", Some("33")), cfvo("num", Some("67"))];
        let mut reversed = rule("iconSet", 4);
        reversed.icon_set_name = Some("3Arrows".into());
        reversed.icon_reverse = true;
        reversed.cfvos = vec![cfvo("percent", Some("0"))];
        let unstyled = {
            let mut unstyled = rule("cellIs", 5);
            unstyled.dxf_index = None;
            unstyled.operator = Some("equal".into());
            unstyled.formulas = vec!["1".into()];
            unstyled
        };
        let deviations = rule("aboveAverage", 6);
        let tail = r#"<cfRule type="aboveAverage" priority="6" stdDev="2"/>"#;
        let mut plain_bar = rule("dataBar", 7);
        plain_bar.dxf_index = None;
        plain_bar.ranges = vec![range(0, 2, 9, 2)];
        plain_bar.cfvos = vec![cfvo("min", None), cfvo("max", None)];
        plain_bar.colors = vec!["#638EC6".into()];
        plain_bar.min_length = Some(10);
        plain_bar.max_length = Some(90);
        let (xml, dropped, _) =
            formats(&[scale, bar, icons, reversed, unstyled, deviations, plain_bar], tail);
        assert_eq!(dropped, 3, "a reversed icon set, a rule with no style, a deviation band");
        assert!(
            xml.contains(r##"<calcext:data-bar calcext:min-length="10" calcext:max-length="90" calcext:negative-color="#638ec6" calcext:axis-position="none" calcext:positive-color="#638ec6">"##),
            "a 2007 bar has no axis: {xml}"
        );
        assert!(xml.contains(concat!(
            r##"<calcext:color-scale><calcext:color-scale-entry calcext:value="0" calcext:type="minimum" calcext:color="#f8696b"/>"##,
            r##"<calcext:color-scale-entry calcext:value="50" calcext:type="percentile" calcext:color="#ffeb84"/>"##,
            r##"<calcext:color-scale-entry calcext:value="[.$A$1]" calcext:type="formula" calcext:color="#63be7b"/></calcext:color-scale>"##,
        )), "{xml}");
        assert!(xml.contains(concat!(
            r##"<calcext:data-bar calcext:min-length="0" calcext:max-length="100" calcext:negative-color="#ff0000" calcext:axis-position="middle" calcext:positive-color="#638ec6" calcext:gradient="false" calcext:show-value="false">"##,
            r#"<calcext:formatting-entry calcext:value="0" calcext:type="auto-minimum"/><calcext:formatting-entry calcext:value="0" calcext:type="maximum"/></calcext:data-bar>"#,
        )), "{xml}");
        assert!(xml.contains(concat!(
            r#"<calcext:icon-set calcext:icon-set-type="3Arrows"><calcext:formatting-entry calcext:value="0" calcext:type="percent"/>"#,
            r#"<calcext:formatting-entry calcext:value="33" calcext:type="percent"/><calcext:formatting-entry calcext:value="67" calcext:type="number"/></calcext:icon-set>"#,
        )), "{xml}");
    }
}
