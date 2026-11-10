//! Charts of an `.ods` document as DrawingML chart parts.
//!
//! An ODF chart is a small document inside the package: a plot area with axes
//! and series that point at cell ranges, styles for their look, and a table
//! with the values as they were when the file was saved. This reads that
//! document and writes the chart part a workbook keeps: the same plots, the
//! same ranges as formulas, and the saved values as the caches a reader shows
//! before it has calculated anything.
//!
//! It is the reverse of `ods_chart`, widened to what other applications
//! write. A chart with a plot this cannot name (stock, bubble, surface) gives
//! no part, and its frame is left out.

use std::collections::HashMap;

use roxmltree::{Document, Node};

use crate::odf_formula;
use crate::odf_layout::length_points;
use crate::odf_number_format::DataStyles;
use crate::xlsx_package::escape_xml;

const CHART: &str = "urn:oasis:names:tc:opendocument:xmlns:chart:1.0";
const TABLE: &str = "urn:oasis:names:tc:opendocument:xmlns:table:1.0";
const TEXT: &str = "urn:oasis:names:tc:opendocument:xmlns:text:1.0";
const STYLE: &str = "urn:oasis:names:tc:opendocument:xmlns:style:1.0";
const DRAW: &str = "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0";
const FO: &str = "urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0";
const SVG: &str = "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0";
const OFFICE: &str = "urn:oasis:names:tc:opendocument:xmlns:office:1.0";
const LOEXT: &str = "urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0";

/// The saved values of a chart are a convenience; a table past this size is
/// not read into caches.
const MAX_CACHE_ROWS: usize = 100_000;
const MAX_SERIES: usize = 255;
/// Trend lines one series may carry.
const MAX_TRENDS: usize = 8;

const PRIMARY_CATEGORY_AXIS: u32 = 111_111_111;
const PRIMARY_VALUE_AXIS: u32 = 222_222_222;
const SECONDARY_CATEGORY_AXIS: u32 = 333_333_333;
const SECONDARY_VALUE_AXIS: u32 = 444_444_444;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Bar,
    Line,
    Area,
    Pie,
    Ring,
    Scatter,
    Radar,
    FilledRadar,
}

impl Kind {
    fn of(class: &str) -> Option<Self> {
        Some(match class.rsplit(':').next().unwrap_or(class) {
            "bar" => Kind::Bar,
            "line" => Kind::Line,
            "area" => Kind::Area,
            "circle" => Kind::Pie,
            "ring" => Kind::Ring,
            "scatter" => Kind::Scatter,
            "radar" => Kind::Radar,
            "filled-radar" => Kind::FilledRadar,
            _ => return None,
        })
    }

    fn round(self) -> bool {
        matches!(self, Kind::Pie | Kind::Ring)
    }

    fn radar(self) -> bool {
        matches!(self, Kind::Radar | Kind::FilledRadar)
    }

    /// True for the plots that draw a series as a line with markers.
    fn stroked(self) -> bool {
        matches!(self, Kind::Line | Kind::Scatter | Kind::Radar)
    }
}

/// What a chart style says, as far as a chart part can say it too.
#[derive(Clone, Debug, Default)]
struct Style {
    /// `style:chart-properties`, by local attribute name.
    chart: HashMap<String, String>,
    stroke: Option<String>,
    stroke_color: Option<String>,
    /// In points.
    stroke_width: Option<f64>,
    fill: Option<String>,
    fill_color: Option<String>,
    color: Option<String>,
    size: Option<f64>,
    bold: Option<bool>,
    /// The Excel format code of the data style, when the style does not take
    /// its format from the cells.
    format: Option<String>,
}

impl Style {
    fn flag(&self, name: &str) -> bool {
        self.chart.get(name).is_some_and(|value| value == "true")
    }

    fn number(&self, name: &str) -> Option<f64> {
        self.chart
            .get(name)
            .and_then(|value| value.trim().parse::<f64>().ok())
            .filter(|value| value.is_finite())
    }

    fn text(&self, name: &str) -> Option<&str> {
        self.chart.get(name).map(String::as_str)
    }
}

struct Title {
    text: String,
    style: Style,
}

struct Axis {
    dimension: String,
    name: String,
    style: Style,
    title: Option<Title>,
    categories: Option<String>,
    /// The style of each kind of grid line the axis draws.
    major_grid: Option<Style>,
    minor_grid: Option<Style>,
}

struct Series {
    kind: Kind,
    secondary: bool,
    values: Option<String>,
    label_address: Option<String>,
    label_string: Option<String>,
    domains: Vec<String>,
    style: Style,
    /// `(how many points, the fill each of them has)`.
    points: Vec<(usize, Option<String>)>,
    /// The styles of the trend lines drawn through the series.
    trends: Vec<Style>,
}

/// One cell of the chart's own table.
#[derive(Clone, Debug, Default)]
struct Cell {
    number: Option<f64>,
    text: String,
}

/// The values a series had when the document was saved.
#[derive(Default)]
struct Cache {
    name: Option<String>,
    categories: Vec<Cell>,
    values: Vec<Option<f64>>,
    domain: Vec<Option<f64>>,
}

fn attr<'a>(node: Node<'a, '_>, namespace: &str, name: &str) -> Option<&'a str> {
    node.attribute((namespace, name))
}

fn is(node: Node<'_, '_>, namespace: &str, name: &str) -> bool {
    node.is_element()
        && node.tag_name().name() == name
        && node.tag_name().namespace() == Some(namespace)
}

fn child<'a, 'input>(
    node: Node<'a, 'input>,
    namespace: &str,
    name: &str,
) -> Option<Node<'a, 'input>> {
    node.children().find(|child| is(*child, namespace, name))
}

/// `#rrggbb` as `RRGGBB`.
fn color(value: &str) -> Option<String> {
    let hex = value.trim().strip_prefix('#')?;
    (hex.len() == 6 && hex.chars().all(|character| character.is_ascii_hexdigit()))
        .then(|| hex.to_ascii_uppercase())
}

/// The text of the `text:p` elements under a node, one line per paragraph.
fn paragraphs(node: Node<'_, '_>) -> String {
    let mut lines: Vec<String> = Vec::new();
    for paragraph in node.children().filter(|child| is(*child, TEXT, "p")) {
        let line: String = paragraph
            .descendants()
            .filter(|node| node.is_text())
            .filter_map(|node| node.text())
            .collect();
        lines.push(line);
    }
    lines.join(" ").trim().to_owned()
}

fn read_styles(document: &Document<'_>) -> HashMap<String, Style> {
    let mut formats = DataStyles::default();
    let mut styles = HashMap::new();
    let Some(automatic) = document
        .root_element()
        .children()
        .find(|node| is(*node, OFFICE, "automatic-styles"))
    else {
        return styles;
    };
    for node in automatic.children().filter(Node::is_element) {
        formats.read(node);
    }
    for node in automatic.children().filter(|node| is(*node, STYLE, "style")) {
        let Some(name) = attr(node, STYLE, "name") else {
            continue;
        };
        let mut style = Style::default();
        for properties in node.children().filter(Node::is_element) {
            match properties.tag_name().name() {
                "chart-properties" => {
                    for attribute in properties.attributes() {
                        style
                            .chart
                            .insert(attribute.name().to_owned(), attribute.value().to_owned());
                    }
                }
                "graphic-properties" => {
                    style.stroke = attr(properties, DRAW, "stroke").map(str::to_owned);
                    style.stroke_color = attr(properties, SVG, "stroke-color").and_then(color);
                    style.stroke_width =
                        attr(properties, SVG, "stroke-width").and_then(length_points);
                    style.fill = attr(properties, DRAW, "fill").map(str::to_owned);
                    style.fill_color = attr(properties, DRAW, "fill-color").and_then(color);
                }
                "text-properties" => {
                    style.color = attr(properties, FO, "color").and_then(color);
                    style.size = attr(properties, FO, "font-size")
                        .and_then(length_points)
                        .filter(|size| *size > 0.0);
                    style.bold = attr(properties, FO, "font-weight").map(|weight| weight == "bold");
                }
                _ => {}
            }
        }
        // A style that follows its source has no format of its own.
        if style.chart.get("link-data-style-to-source").map(String::as_str) == Some("false") {
            style.format = attr(node, STYLE, "data-style-name")
                .and_then(|name| formats.code(name))
                .map(|(code, _)| code)
                .filter(|code| !code.is_empty() && !code.eq_ignore_ascii_case("general"));
        }
        styles.insert(name.to_owned(), style);
    }
    styles
}

fn read_table(chart: Node<'_, '_>) -> (Vec<Vec<Cell>>, usize) {
    let Some(table) = child(chart, TABLE, "table") else {
        return (Vec::new(), 0);
    };
    let mut rows: Vec<Vec<Cell>> = Vec::new();
    let mut header_rows = 0usize;
    for group in table.children().filter(Node::is_element) {
        let header = match group.tag_name().name() {
            "table-header-rows" => true,
            "table-rows" => false,
            _ => continue,
        };
        for row in group.children().filter(|node| is(*node, TABLE, "table-row")) {
            if rows.len() > MAX_CACHE_ROWS {
                return (Vec::new(), 0);
            }
            let mut cells = Vec::new();
            for cell in row.children().filter(|node| is(*node, TABLE, "table-cell")) {
                let number = match attr(cell, OFFICE, "value-type") {
                    Some("float") | Some("percentage") | Some("currency") => {
                        attr(cell, OFFICE, "value")
                            .and_then(|value| value.trim().parse::<f64>().ok())
                            .filter(|value| value.is_finite())
                    }
                    _ => None,
                };
                cells.push(Cell {
                    number,
                    text: paragraphs(cell),
                });
            }
            if header {
                header_rows += 1;
            }
            rows.push(cells);
        }
    }
    (rows, header_rows)
}

/// A column letter run and a row number, zero-based.
fn cell_position(cell: &str) -> Option<(usize, usize)> {
    let cell: String = cell.chars().filter(|character| *character != '$').collect();
    let letters = cell.chars().take_while(char::is_ascii_alphabetic).count();
    if letters == 0 || letters > 3 {
        return None;
    }
    let column = cell[..letters].bytes().fold(0usize, |total, byte| {
        total * 26 + usize::from(byte.to_ascii_uppercase() - b'A') + 1
    });
    let row: usize = cell[letters..].parse().ok()?;
    (row >= 1).then(|| (row - 1, column - 1))
}

/// Splits `'My sheet'.B2` at the dot that ends the sheet name.
fn split_sheet(address: &str) -> Option<(&str, &str)> {
    let mut quoted = false;
    for (index, character) in address.char_indices() {
        match character {
            '\'' => quoted = !quoted,
            '.' if !quoted => return Some((&address[..index], &address[index + 1..])),
            _ => {}
        }
    }
    None
}

/// Where an address points when it names the chart's own table:
/// `local-table.$B$2:.$B$7` as `(first row, first column, last row, last
/// column)`.
fn local_range(address: &str) -> Option<(usize, usize, usize, usize)> {
    let (first, last) = match address.split_once(':') {
        Some((first, last)) => (first, Some(last)),
        None => (address, None),
    };
    let (sheet, first_cell) = split_sheet(first.trim())?;
    if sheet.trim_start_matches('$') != "local-table" {
        return None;
    }
    let start = cell_position(first_cell)?;
    let end = match last {
        Some(last) => {
            let cell = split_sheet(last.trim()).map_or(last.trim(), |(_, cell)| cell);
            cell_position(cell)?
        }
        None => start,
    };
    Some((start.0.min(end.0), start.1.min(end.1), start.0.max(end.0), start.1.max(end.1)))
}

/// `$B$2:$B$7` from `B2:B7`, the form a chart formula uses. A range of one
/// cell is that cell (`$B$1`), which is how a series name is spelled.
fn absolute(address: &str) -> Option<String> {
    let mut ends: Vec<String> = Vec::new();
    for end in address.split(':') {
        if ends.len() == 2 {
            return None;
        }
        let end: String = end.chars().filter(|character| *character != '$').collect();
        let letters = end.chars().take_while(char::is_ascii_alphabetic).count();
        let (column, row) = end.split_at(letters);
        if column.is_empty() || row.is_empty() || !row.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        ends.push(format!("${}${row}", column.to_ascii_uppercase()));
    }
    if ends.len() == 2 && ends[0] == ends[1] {
        ends.pop();
    }
    Some(ends.join(":"))
}

/// A chart address (`Sheet.B2:Sheet.B7`, several of them separated by
/// spaces) as the formula a chart part holds (`Sheet!$B$2:$B$7`). `None` for
/// an address in the chart's own table or one this cannot read.
fn formula(address: &str) -> Option<String> {
    let mut ranges: Vec<String> = Vec::new();
    let mut quoted = false;
    let mut start = 0;
    let mut pieces: Vec<&str> = Vec::new();
    for (index, character) in address.char_indices() {
        match character {
            '\'' => quoted = !quoted,
            ' ' if !quoted => {
                pieces.push(&address[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    pieces.push(&address[start..]);
    for piece in pieces.into_iter().filter(|piece| !piece.is_empty()) {
        if local_range(piece).is_some() {
            return None;
        }
        let translated = odf_formula::excel_range(piece)?;
        // The sheet stays as it is spelled; the cells become absolute.
        let split = translated.rfind('!')?;
        let (sheet, cells) = translated.split_at(split + 1);
        ranges.push(format!("{sheet}{}", absolute(cells)?));
    }
    match ranges.len() {
        0 => None,
        1 => ranges.pop(),
        _ => Some(format!("({})", ranges.join(","))),
    }
}

/// XML cannot carry control characters.
fn printable(text: &str) -> String {
    text.chars()
        .map(|character| if character == '\n' || character == '\r' { ' ' } else { character })
        .filter(|character| *character == '\t' || (*character as u32) >= 0x20)
        .collect()
}

fn number(value: f64) -> String {
    format!("{value}")
}

fn solid_fill(color: &str) -> String {
    format!(r#"<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>"#)
}

/// `a:defRPr`/`a:rPr` attributes and fill for a text style.
fn run_properties(element: &str, style: &Style, default_size: Option<f64>) -> String {
    let mut attributes = String::new();
    if let Some(size) = style.size.or(default_size) {
        attributes.push_str(&format!(r#" sz="{}""#, (size * 100.0).round() as i64));
    }
    if let Some(bold) = style.bold {
        attributes.push_str(if bold { r#" b="1""# } else { r#" b="0""# });
    }
    match &style.color {
        Some(color) => format!("<{element}{attributes}>{}</{element}>", solid_fill(color)),
        None => format!("<{element}{attributes}/>"),
    }
}

/// `c:txPr` for the text of an axis, a legend or labels; nothing when the
/// style says nothing about the text.
fn text_properties(style: &Style) -> String {
    if style.size.is_none() && style.color.is_none() && style.bold.is_none() {
        return String::new();
    }
    format!(
        r#"<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>{}</a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>"#,
        run_properties("a:defRPr", style, None)
    )
}

/// `c:spPr` of a line: an axis or its grid. Said outright, because a reader
/// takes the colour of a line left to it from a theme, and the workbook an
/// import writes has none.
fn outline_properties(style: &Style, default_color: &str) -> String {
    if style.stroke.as_deref() == Some("none") {
        return "<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>".to_owned();
    }
    let width = line_width(style.stroke_width);
    format!(
        "<c:spPr><a:ln{}>{}</a:ln></c:spPr>",
        if width.is_empty() { r#" w="9525""# } else { &width },
        solid_fill(style.stroke_color.as_deref().unwrap_or(default_color))
    )
}

fn title_xml(title: &Title) -> String {
    // A title is bold in some readers unless it says it is not.
    let style = Style {
        bold: Some(title.style.bold.unwrap_or(false)),
        ..title.style.clone()
    };
    let title = Title {
        text: title.text.clone(),
        style,
    };
    let title = &title;
    let properties = run_properties("a:defRPr", &title.style, None);
    format!(
        r#"<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr>{properties}</a:pPr><a:r>{}<a:t>{}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>{properties}</a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr></c:title>"#,
        run_properties("a:rPr", &title.style, None),
        escape_xml(&printable(&title.text)),
    )
}

/// `c:spPr` of an area: its fill and its outline. `framed` is true for an
/// area Excel outlines unless told not to (the chart and its plot area), so
/// "no outline" has to be said; a bar or a slice has none to begin with.
fn area_properties(style: &Style, framed: bool) -> String {
    let mut out = String::new();
    match style.fill.as_deref() {
        Some("none") => out.push_str("<a:noFill/>"),
        _ => {
            if let Some(fill) = style.fill_color.as_deref() {
                out.push_str(&solid_fill(fill));
            }
        }
    }
    match (style.stroke.as_deref(), &style.stroke_color) {
        (Some("none"), _) if framed => out.push_str("<a:ln><a:noFill/></a:ln>"),
        (Some("none"), _) => {}
        (Some(_), Some(color)) => out.push_str(&format!(
            "<a:ln{}>{}</a:ln>",
            line_width(style.stroke_width),
            solid_fill(color)
        )),
        _ => {}
    }
    if out.is_empty() {
        String::new()
    } else {
        format!("<c:spPr>{out}</c:spPr>")
    }
}

fn line_width(points: Option<f64>) -> String {
    match points.filter(|points| *points > 0.0) {
        Some(points) => {
            // A width that went through centimetres comes back a hair off
            // the quarter point it was.
            let quarter = (points * 4.0).round() / 4.0;
            let points = if quarter > 0.0 && (points - quarter).abs() < 0.02 {
                quarter
            } else {
                points
            };
            format!(r#" w="{}""#, (points * 12_700.0).round() as i64)
        }
        None => String::new(),
    }
}

/// `c:spPr` of a series drawn as a line. `named` also states the series
/// colour as a fill, which draws nothing on a line but tells a reader that
/// colours markers and legend keys from the series which colour that is.
fn stroke_properties(style: &Style, named: bool) -> String {
    let colour = style.fill_color.as_deref().or(style.stroke_color.as_deref());
    let fill = colour.filter(|_| named).map(solid_fill).unwrap_or_default();
    if style.stroke.as_deref() == Some("none") {
        return format!(r#"<c:spPr>{fill}<a:ln w="19050"><a:noFill/></a:ln></c:spPr>"#);
    }
    match style.stroke_color.as_deref().or(style.fill_color.as_deref()) {
        Some(color) => format!(
            r#"<c:spPr>{fill}<a:ln{} cap="rnd">{}<a:round/></a:ln></c:spPr>"#,
            line_width(style.stroke_width),
            solid_fill(color)
        ),
        None => String::new(),
    }
}

/// `c:trendline` for a trend line of a kind a chart part has a word for;
/// nothing for any other.
fn trendline_xml(style: &Style) -> String {
    let (kind, extra) = match style.text("regression-type") {
        Some("linear") => ("linear", String::new()),
        Some("logarithmic") => ("log", String::new()),
        Some("exponential") => ("exp", String::new()),
        Some("power") => ("power", String::new()),
        // A chart part takes a polynomial of the second to the sixth order,
        // and a moving average over at least two points.
        Some("polynomial") => (
            "poly",
            format!(
                r#"<c:order val="{}"/>"#,
                style.number("regression-max-degree").unwrap_or(2.0).clamp(2.0, 6.0) as u8
            ),
        ),
        Some("moving-average") => (
            "movingAvg",
            format!(
                r#"<c:period val="{}"/>"#,
                style.number("regression-period").unwrap_or(2.0).clamp(2.0, 255.0) as u32
            ),
        ),
        _ => return String::new(),
    };
    let look = match style.stroke_color.as_deref() {
        Some(color) if style.stroke.as_deref() != Some("none") => format!(
            "<c:spPr><a:ln{}>{}</a:ln></c:spPr>",
            line_width(style.stroke_width),
            solid_fill(color)
        ),
        _ => String::new(),
    };
    format!(
        r#"<c:trendline>{look}<c:trendlineType val="{kind}"/>{extra}<c:dispRSqr val="0"/><c:dispEq val="0"/></c:trendline>"#
    )
}

/// `c:marker` of a series drawn as a line.
fn marker_xml(style: &Style, plot: &Style) -> String {
    let symbol = style.text("symbol-type").or(plot.text("symbol-type"));
    match symbol {
        Some("none") => r#"<c:marker><c:symbol val="none"/></c:marker>"#.to_owned(),
        Some(_) => {
            let shape = match style.text("symbol-name") {
                Some("square") => "square",
                Some("diamond") => "diamond",
                Some("arrow-up") | Some("arrow-down") | Some("arrow-left") | Some("arrow-right") => {
                    "triangle"
                }
                Some("x") => "x",
                Some("plus") => "plus",
                Some("star") | Some("asterisk") => "star",
                Some("horizontal-bar") | Some("vertical-bar") => "dash",
                _ => "circle",
            };
            // A marker left to the reader takes the series' automatic
            // colour, not the colour its line was given.
            let look = match style.fill_color.as_deref().or(style.stroke_color.as_deref()) {
                Some(color) => format!(
                    r#"<c:spPr>{0}<a:ln w="9525">{0}</a:ln></c:spPr>"#,
                    solid_fill(color)
                ),
                None => String::new(),
            };
            format!(r#"<c:marker><c:symbol val="{shape}"/><c:size val="5"/>{look}</c:marker>"#)
        }
        None => String::new(),
    }
}

fn labels_xml(style: &Style) -> String {
    let number = style.text("data-label-number").unwrap_or("none");
    let text = style.flag("data-label-text");
    let value = matches!(number, "value" | "value-and-percentage");
    let percent = matches!(number, "percentage" | "value-and-percentage");
    if !value && !percent && !text {
        return String::new();
    }
    let format = style
        .format
        .as_deref()
        .map(|code| format!(r#"<c:numFmt formatCode="{}" sourceLinked="0"/>"#, escape_xml(code)))
        .unwrap_or_default();
    let flag = |on: bool| if on { "1" } else { "0" };
    format!(
        r#"<c:dLbls>{format}{}<c:showLegendKey val="0"/><c:showVal val="{}"/><c:showCatName val="{}"/><c:showSerName val="0"/><c:showPercent val="{}"/><c:showBubbleSize val="0"/></c:dLbls>"#,
        text_properties(style),
        flag(value),
        flag(text),
        flag(percent),
    )
}

/// A reference to numbers, with the saved values as its cache; the values
/// alone when there is no range to refer to.
fn numbers_xml(formula: Option<&str>, values: &[Option<f64>], format: Option<&str>) -> String {
    let has_values = values.iter().any(Option::is_some);
    let points = || -> String {
        let mut out = format!(
            r#"<c:formatCode>{}</c:formatCode><c:ptCount val="{}"/>"#,
            escape_xml(format.unwrap_or("General")),
            values.len()
        );
        for (index, value) in values.iter().enumerate() {
            if let Some(value) = value {
                out.push_str(&format!(
                    r#"<c:pt idx="{index}"><c:v>{}</c:v></c:pt>"#,
                    number(*value)
                ));
            }
        }
        out
    };
    match formula {
        Some(formula) => format!(
            "<c:numRef><c:f>{}</c:f>{}</c:numRef>",
            escape_xml(formula),
            if has_values {
                format!("<c:numCache>{}</c:numCache>", points())
            } else {
                String::new()
            }
        ),
        None => format!("<c:numLit>{}</c:numLit>", points()),
    }
}

fn strings_xml(formula: Option<&str>, labels: &[String]) -> String {
    let points = || -> String {
        let mut out = format!(r#"<c:ptCount val="{}"/>"#, labels.len());
        for (index, label) in labels.iter().enumerate() {
            out.push_str(&format!(
                r#"<c:pt idx="{index}"><c:v>{}</c:v></c:pt>"#,
                escape_xml(&printable(label))
            ));
        }
        out
    };
    match formula {
        Some(formula) => format!(
            "<c:strRef><c:f>{}</c:f>{}</c:strRef>",
            escape_xml(formula),
            if labels.is_empty() {
                String::new()
            } else {
                format!("<c:strCache>{}</c:strCache>", points())
            }
        ),
        None => format!("<c:strLit>{}</c:strLit>", points()),
    }
}

/// The category labels of a series: numbers when every saved label is one.
fn categories_xml(formula: Option<&str>, cells: &[Cell]) -> String {
    if !cells.is_empty() && cells.iter().all(|cell| cell.number.is_some()) {
        let values: Vec<Option<f64>> = cells.iter().map(|cell| cell.number).collect();
        return numbers_xml(formula, &values, None);
    }
    let labels: Vec<String> = cells.iter().map(|cell| cell.text.clone()).collect();
    strings_xml(formula, &labels)
}

/// `"name"` of a `loext:label-string`, without the quotes.
fn label_string(text: &str) -> String {
    let text = text.trim();
    match text.strip_prefix('"').and_then(|rest| rest.strip_suffix('"')) {
        Some(inner) => inner.replace("\"\"", "\""),
        None => text.to_owned(),
    }
}

/// Reads the saved values of each series out of the chart's own table.
fn caches(series: &[Series], table: &[Vec<Cell>], header_rows: usize, scatter: bool) -> Vec<Cache> {
    let body = table.get(header_rows..).unwrap_or(&[]);
    let header = table.first().filter(|_| header_rows > 0);
    let width = table.iter().map(Vec::len).max().unwrap_or(0);
    let column = |index: usize| -> Vec<Cell> {
        body.iter()
            .map(|row| row.get(index).cloned().unwrap_or_default())
            .collect()
    };
    let numbers = |index: usize| -> Vec<Option<f64>> {
        column(index).into_iter().map(|cell| cell.number).collect()
    };
    let name = |index: usize| -> Option<String> {
        header
            .and_then(|row| row.get(index))
            .map(|cell| cell.text.clone())
            .filter(|text| !text.is_empty())
    };
    // An address in the table says outright which cells it means.
    let direct = |address: Option<&str>| -> Option<Vec<Cell>> {
        let (first_row, first_column, last_row, last_column) = local_range(address?)?;
        let mut cells = Vec::new();
        for row in first_row..=last_row.min(first_row + MAX_CACHE_ROWS) {
            for column in first_column..=last_column.min(first_column + 255) {
                cells.push(
                    table
                        .get(row)
                        .and_then(|row| row.get(column))
                        .cloned()
                        .unwrap_or_default(),
                );
            }
        }
        Some(cells)
    };
    // Otherwise the table lists the data in the order the series use it.
    // One writer gives every series a column after the shared first one;
    // another puts each X column in front of the Y column that reads it.
    let simple = width == series.len() + 1;
    let mut cursor = 1usize;
    let mut walked: Vec<(Option<usize>, usize)> = Vec::new();
    for entry in series {
        let domain = (!entry.domains.is_empty()).then(|| {
            let index = cursor;
            cursor += entry.domains.len();
            index
        });
        walked.push((domain, cursor));
        cursor += 1;
    }
    let sequential = cursor == width;
    let mut shared_domain: Option<Vec<Option<f64>>> = None;
    series
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let mut cache = Cache::default();
            if let Some(cells) = direct(entry.values.as_deref()) {
                cache.values = cells.into_iter().map(|cell| cell.number).collect();
                cache.name = direct(entry.label_address.as_deref())
                    .and_then(|cells| cells.into_iter().next())
                    .map(|cell| cell.text)
                    .filter(|text| !text.is_empty());
                cache.categories = column(0);
                if let Some(cells) = entry.domains.first().and_then(|domain| direct(Some(domain))) {
                    cache.domain = cells.into_iter().map(|cell| cell.number).collect();
                } else if scatter {
                    cache.domain = numbers(0);
                }
                return cache;
            }
            let (domain_column, value_column) = if sequential {
                walked[index]
            } else if simple {
                (scatter.then_some(0), index + 1)
            } else {
                return cache;
            };
            cache.values = numbers(value_column);
            cache.name = name(value_column);
            cache.categories = column(0);
            if scatter {
                match domain_column {
                    Some(column) => {
                        cache.domain = numbers(column);
                        shared_domain = Some(cache.domain.clone());
                    }
                    // A series without an X range of its own shares the
                    // first one.
                    None => cache.domain = shared_domain.clone().unwrap_or_default(),
                }
            }
            cache
        })
        .collect()
}

/// The parts of a chart shared by the plots it is made of.
struct Chart {
    kind: Kind,
    plot: Style,
    axes: Vec<Axis>,
    series: Vec<Series>,
    caches: Vec<Cache>,
}

impl Chart {
    fn axis(&self, dimension: &str, secondary: bool) -> Option<&Axis> {
        self.axes.iter().find(|axis| {
            axis.dimension == dimension && axis.name.starts_with("secondary") == secondary
        })
    }

    fn horizontal(&self) -> bool {
        self.kind == Kind::Bar && self.plot.flag("vertical")
    }

    /// The category range of the chart: said once, on the category axis.
    fn categories(&self) -> Option<&str> {
        self.axes
            .iter()
            .find_map(|axis| axis.categories.as_deref())
    }

    fn series_xml(&self, index: usize) -> String {
        let series = &self.series[index];
        let cache = &self.caches[index];
        let kind = series.kind;
        let mut out = format!(r#"<c:ser><c:idx val="{index}"/><c:order val="{index}"/>"#);

        // ---- the name
        let label = series.label_address.as_deref().and_then(formula);
        // A name typed into the chart, or one kept in the chart's own table.
        // The heading a table gives a series that names no cell is the
        // writer's placeholder, not a name.
        let literal = series.label_string.as_deref().map(label_string).or_else(|| {
            cache
                .name
                .clone()
                .filter(|_| series.label_address.as_deref().is_some_and(|label| local_range(label).is_some()))
        });
        match (label, literal) {
            (Some(label), _) => out.push_str(&format!(
                "<c:tx>{}</c:tx>",
                strings_xml(Some(&label), cache.name.as_slice())
            )),
            (None, Some(name)) => out.push_str(&format!(
                "<c:tx><c:v>{}</c:v></c:tx>",
                escape_xml(&printable(&name))
            )),
            (None, None) => {}
        }

        // ---- the look
        let stroked = kind.stroked();
        if stroked {
            out.push_str(&stroke_properties(
                &series.style,
                matches!(kind, Kind::Line | Kind::Scatter),
            ));
        } else if !kind.round() {
            // A pie or a ring is coloured slice by slice; a colour on the
            // series would paint them all alike.
            out.push_str(&area_properties(&series.style, false));
        }
        if kind == Kind::Bar {
            out.push_str(r#"<c:invertIfNegative val="0"/>"#);
        }
        if stroked {
            out.push_str(&marker_xml(&series.style, &self.plot));
        }
        let mut point = 0usize;
        for (count, fill) in &series.points {
            if let Some(fill) = fill {
                for offset in 0..*count {
                    if point + offset > 4_000 {
                        break;
                    }
                    out.push_str(&format!(
                        r#"<c:dPt><c:idx val="{}"/>{}<c:bubble3D val="0"/><c:spPr>{}</c:spPr></c:dPt>"#,
                        point + offset,
                        if kind == Kind::Bar {
                            r#"<c:invertIfNegative val="0"/>"#
                        } else {
                            ""
                        },
                        solid_fill(fill)
                    ));
                }
            }
            point += count;
        }
        out.push_str(&labels_xml(&series.style));
        // Slices and radar lines have no trend to draw.
        if !kind.round() && !kind.radar() {
            for trend in &series.trends {
                out.push_str(&trendline_xml(trend));
            }
        }

        // ---- the data
        let values = series.values.as_deref().and_then(formula);
        let format = series.style.format.as_deref();
        if kind == Kind::Scatter {
            let domain = series
                .domains
                .first()
                .map(String::as_str)
                .or_else(|| {
                    self.series
                        .iter()
                        .find_map(|other| other.domains.first().map(String::as_str))
                })
                .and_then(formula);
            if domain.is_some() || cache.domain.iter().any(Option::is_some) {
                out.push_str(&format!(
                    "<c:xVal>{}</c:xVal>",
                    numbers_xml(domain.as_deref(), &cache.domain, None)
                ));
            }
            out.push_str(&format!(
                "<c:yVal>{}</c:yVal>",
                numbers_xml(values.as_deref(), &cache.values, format)
            ));
        } else {
            let categories = self.categories().and_then(formula);
            if categories.is_some() || !cache.categories.is_empty() {
                out.push_str(&format!(
                    "<c:cat>{}</c:cat>",
                    categories_xml(categories.as_deref(), &cache.categories)
                ));
            }
            out.push_str(&format!(
                "<c:val>{}</c:val>",
                numbers_xml(values.as_deref(), &cache.values, format)
            ));
        }
        if matches!(kind, Kind::Line | Kind::Scatter) {
            let smooth = series
                .style
                .text("interpolation")
                .or(self.plot.text("interpolation"))
                .is_some_and(|interpolation| interpolation != "none");
            out.push_str(if smooth {
                r#"<c:smooth val="1"/>"#
            } else {
                r#"<c:smooth val="0"/>"#
            });
        }
        out.push_str("</c:ser>");
        out
    }

    /// One plot element: the series of one kind on one pair of axes.
    fn plot_xml(&self, kind: Kind, secondary: bool, members: &[usize]) -> String {
        let series: String = members.iter().map(|index| self.series_xml(*index)).collect();
        let (category_axis, value_axis) = if secondary {
            (SECONDARY_CATEGORY_AXIS, SECONDARY_VALUE_AXIS)
        } else {
            (PRIMARY_CATEGORY_AXIS, PRIMARY_VALUE_AXIS)
        };
        let axes = format!(r#"<c:axId val="{category_axis}"/><c:axId val="{value_axis}"/>"#);
        // Stacking belongs to the plot the chart is named after; a line laid
        // over stacked bars is not stacked with them.
        let own = kind == self.kind || (kind.radar() && self.kind.radar());
        let grouping = |plain: &'static str| -> &'static str {
            if own && self.plot.flag("percentage") {
                "percentStacked"
            } else if own && self.plot.flag("stacked") {
                "stacked"
            } else {
                plain
            }
        };
        let value_style = self.axis("y", secondary).map(|axis| &axis.style);
        match kind {
            Kind::Bar => {
                let grouping = grouping("clustered");
                let gap = value_style
                    .and_then(|style| style.number("gap-width"))
                    .map_or(150, |gap| gap.round().clamp(0.0, 500.0) as i64);
                let overlap = value_style
                    .and_then(|style| style.number("overlap"))
                    .map(|overlap| overlap.round().clamp(-100.0, 100.0) as i64)
                    .or((grouping != "clustered").then_some(100))
                    .filter(|overlap| *overlap != 0);
                format!(
                    r#"<c:barChart><c:barDir val="{}"/><c:grouping val="{grouping}"/><c:varyColors val="0"/>{series}<c:gapWidth val="{gap}"/>{}{axes}</c:barChart>"#,
                    if self.horizontal() { "bar" } else { "col" },
                    overlap
                        .map(|overlap| format!(r#"<c:overlap val="{overlap}"/>"#))
                        .unwrap_or_default(),
                )
            }
            Kind::Line => format!(
                r#"<c:lineChart><c:grouping val="{}"/><c:varyColors val="0"/>{series}<c:marker val="1"/>{axes}</c:lineChart>"#,
                grouping("standard"),
            ),
            Kind::Area => format!(
                r#"<c:areaChart><c:grouping val="{}"/><c:varyColors val="0"/>{series}{axes}</c:areaChart>"#,
                grouping("standard"),
            ),
            Kind::Pie => format!(
                r#"<c:pieChart><c:varyColors val="1"/>{series}<c:firstSliceAng val="{}"/></c:pieChart>"#,
                self.first_slice(),
            ),
            Kind::Ring => format!(
                r#"<c:doughnutChart><c:varyColors val="1"/>{series}<c:firstSliceAng val="{}"/><c:holeSize val="50"/></c:doughnutChart>"#,
                self.first_slice(),
            ),
            Kind::Scatter => format!(
                r#"<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>{series}{axes}</c:scatterChart>"#,
            ),
            Kind::Radar | Kind::FilledRadar => {
                let style = if kind == Kind::FilledRadar {
                    "filled"
                } else if members.iter().any(|index| {
                    let style = &self.series[*index].style;
                    style
                        .text("symbol-type")
                        .or(self.plot.text("symbol-type"))
                        .is_some_and(|symbol| symbol != "none")
                }) {
                    "marker"
                } else {
                    "standard"
                };
                format!(
                    r#"<c:radarChart><c:radarStyle val="{style}"/><c:varyColors val="0"/>{series}{axes}</c:radarChart>"#,
                )
            }
        }
    }

    /// Where the first slice starts, clockwise from the top. ODF counts the
    /// angle counter-clockwise from three o'clock and starts at the top
    /// unless told otherwise.
    fn first_slice(&self) -> i64 {
        let offset = self.plot.number("angle-offset").unwrap_or(90.0);
        (90.0 - offset).rem_euclid(360.0).round() as i64
    }

    /// The axis elements of one pair of axes.
    fn axes_xml(&self, secondary: bool, scatter: bool, radar: bool, area: bool) -> String {
        let (category_id, value_id) = if secondary {
            (SECONDARY_CATEGORY_AXIS, SECONDARY_VALUE_AXIS)
        } else {
            (PRIMARY_CATEGORY_AXIS, PRIMARY_VALUE_AXIS)
        };
        let category = self.axis("x", secondary).or(self.axis("x", false));
        let value = self.axis("y", secondary);
        let horizontal = self.horizontal();
        let reversed = |axis: Option<&Axis>| axis.is_some_and(|axis| axis.style.flag("reverse-direction"));
        // A radar's categories run the other way round in ODF, so the two
        // directions swap.
        let category_reversed = reversed(category) != radar;
        let (near, far) = if horizontal { ("b", "t") } else { ("l", "r") };
        let (category_side, category_far) = if horizontal { ("l", "r") } else { ("b", "t") };
        // The value axis sits where the category axis starts, unless it is
        // pinned to the other end.
        let pinned = value.is_some_and(|axis| axis.style.text("axis-position") == Some("end"));
        let value_side = if secondary || (category_reversed != pinned) {
            far
        } else {
            near
        };
        let category_side = if reversed(value) { category_far } else { category_side };

        let scaling = |axis: Option<&Axis>, reversed: bool| -> String {
            let mut out = String::from("<c:scaling>");
            if axis.is_some_and(|axis| axis.style.flag("logarithmic")) {
                out.push_str(r#"<c:logBase val="10"/>"#);
            }
            out.push_str(if reversed {
                r#"<c:orientation val="maxMin"/>"#
            } else {
                r#"<c:orientation val="minMax"/>"#
            });
            if let Some(maximum) = axis.and_then(|axis| axis.style.number("maximum")) {
                out.push_str(&format!(r#"<c:max val="{}"/>"#, number(maximum)));
            }
            if let Some(minimum) = axis.and_then(|axis| axis.style.number("minimum")) {
                out.push_str(&format!(r#"<c:min val="{}"/>"#, number(minimum)));
            }
            out.push_str("</c:scaling>");
            out
        };
        // What every kind of axis says after its scaling, up to the axis it
        // crosses.
        let common = |axis: Option<&Axis>, side: &str, deleted: bool| -> String {
            let mut out = String::new();
            let hidden = deleted || axis.is_some_and(|axis| axis.style.text("visible") == Some("false"));
            out.push_str(&format!(
                r#"<c:delete val="{}"/><c:axPos val="{side}"/>"#,
                if hidden { "1" } else { "0" }
            ));
            if let Some(grid) = axis.and_then(|axis| axis.major_grid.as_ref()) {
                out.push_str(&format!(
                    "<c:majorGridlines>{}</c:majorGridlines>",
                    outline_properties(grid, "D9D9D9")
                ));
            }
            if let Some(grid) = axis.and_then(|axis| axis.minor_grid.as_ref()) {
                out.push_str(&format!(
                    "<c:minorGridlines>{}</c:minorGridlines>",
                    outline_properties(grid, "F2F2F2")
                ));
            }
            if let Some(title) = axis.and_then(|axis| axis.title.as_ref()) {
                out.push_str(&title_xml(title));
            }
            match axis.and_then(|axis| axis.style.format.as_deref()) {
                Some(code) => out.push_str(&format!(
                    r#"<c:numFmt formatCode="{}" sourceLinked="0"/>"#,
                    escape_xml(code)
                )),
                None => out.push_str(r#"<c:numFmt formatCode="General" sourceLinked="1"/>"#),
            }
            let labels = axis.is_none_or(|axis| axis.style.text("display-label") != Some("false"));
            out.push_str(&format!(
                r#"<c:majorTickMark val="out"/><c:minorTickMark val="none"/><c:tickLblPos val="{}"/>"#,
                if labels { "nextTo" } else { "none" }
            ));
            match axis {
                Some(axis) => {
                    out.push_str(&outline_properties(&axis.style, "878787"));
                    out.push_str(&text_properties(&axis.style));
                }
                None => out.push_str(&outline_properties(&Style::default(), "878787")),
            }
            out
        };
        let value_crosses = if secondary || pinned {
            "max"
        } else {
            match value.and_then(|axis| axis.style.text("axis-position")) {
                Some("start") => "min",
                _ => "autoZero",
            }
        };
        let major_unit = value
            .and_then(|axis| axis.style.number("interval-major"))
            .filter(|unit| *unit > 0.0)
            .map(|unit| format!(r#"<c:majorUnit val="{}"/>"#, number(unit)))
            .unwrap_or_default();
        let mut out = String::new();
        if scatter {
            let x_unit = category
                .and_then(|axis| axis.style.number("interval-major"))
                .filter(|unit| *unit > 0.0)
                .map(|unit| format!(r#"<c:majorUnit val="{}"/>"#, number(unit)))
                .unwrap_or_default();
            out.push_str(&format!(
                r#"<c:valAx><c:axId val="{category_id}"/>{}{}<c:crossAx val="{value_id}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/>{x_unit}</c:valAx>"#,
                scaling(category, reversed(category)),
                common(category, category_side, false),
            ));
        } else {
            // The category axis of the second pair only carries the scale.
            out.push_str(&format!(
                r#"<c:catAx><c:axId val="{category_id}"/>{}{}<c:crossAx val="{value_id}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>"#,
                scaling(category, category_reversed),
                common(category, category_side, secondary),
            ));
        }
        out.push_str(&format!(
            r#"<c:valAx><c:axId val="{value_id}"/>{}{}<c:crossAx val="{category_id}"/><c:crosses val="{value_crosses}"/><c:crossBetween val="{}"/>{major_unit}</c:valAx>"#,
            scaling(value, reversed(value)),
            common(value, value_side, false),
            if scatter || area { "midCat" } else { "between" },
        ));
        out
    }
}

/// The chart part for an ODF chart document, or `None` when the document
/// holds no chart this writer can draw.
pub(crate) fn chart_part(content: &str) -> Option<String> {
    let document = Document::parse(content).ok()?;
    let chart_node = document
        .descendants()
        .find(|node| is(*node, CHART, "chart"))?;
    let kind = Kind::of(attr(chart_node, CHART, "class")?)?;
    let styles = read_styles(&document);
    let style_of = |node: Node<'_, '_>| -> Style {
        attr(node, CHART, "style-name")
            .and_then(|name| styles.get(name))
            .cloned()
            .unwrap_or_default()
    };
    let title_of = |node: Node<'_, '_>| -> Option<Title> {
        let title = child(node, CHART, "title")?;
        let text = paragraphs(title);
        let mut style = style_of(title);
        // Some writers keep the look of a title on the run of text inside
        // it; the run's word wins over the title's.
        let run = title
            .descendants()
            .filter(|node| is(*node, TEXT, "span"))
            .find_map(|span| attr(span, TEXT, "style-name"))
            .and_then(|name| styles.get(name));
        if let Some(run) = run {
            style.color = run.color.clone().or(style.color);
            style.size = run.size.or(style.size);
            style.bold = run.bold.or(style.bold);
        }
        (!text.is_empty()).then_some(Title { text, style })
    };
    let plot_area = child(chart_node, CHART, "plot-area")?;
    let plot = style_of(plot_area);

    let mut axes = Vec::new();
    let mut series = Vec::new();
    let mut wall: Option<Style> = None;
    for node in plot_area.children().filter(Node::is_element) {
        if is(node, CHART, "axis") {
            let grid = |class: &str| {
                node.children()
                    .find(|grid| {
                        is(*grid, CHART, "grid")
                            && attr(*grid, CHART, "class").unwrap_or("major") == class
                    })
                    .map(style_of)
            };
            axes.push(Axis {
                dimension: attr(node, CHART, "dimension").unwrap_or("x").to_owned(),
                name: attr(node, CHART, "name").unwrap_or("").to_owned(),
                style: style_of(node),
                title: title_of(node),
                categories: child(node, CHART, "categories")
                    .and_then(|categories| attr(categories, TABLE, "cell-range-address"))
                    .map(str::to_owned),
                major_grid: grid("major"),
                minor_grid: grid("minor"),
            });
        } else if is(node, CHART, "series") {
            if series.len() >= MAX_SERIES {
                continue;
            }
            // The series of a ring are circles; the ring is the chart.
            let own = attr(node, CHART, "class").map_or(Some(kind), Kind::of)?;
            let own = if kind == Kind::Ring && own == Kind::Pie { Kind::Ring } else { own };
            let mut points = Vec::new();
            let mut domains = Vec::new();
            let mut trends = Vec::new();
            for part in node.children().filter(Node::is_element) {
                if is(part, CHART, "regression-curve") {
                    if trends.len() < MAX_TRENDS {
                        trends.push(style_of(part));
                    }
                } else if is(part, CHART, "data-point") {
                    let count = attr(part, CHART, "repeated")
                        .and_then(|count| count.parse::<usize>().ok())
                        .unwrap_or(1)
                        .clamp(1, 1_000_000);
                    let fill = attr(part, CHART, "style-name")
                        .and_then(|name| styles.get(name))
                        .filter(|style| style.fill.as_deref() != Some("none"))
                        .and_then(|style| style.fill_color.clone());
                    points.push((count, fill));
                } else if is(part, CHART, "domain") {
                    if let Some(range) = attr(part, TABLE, "cell-range-address") {
                        domains.push(range.to_owned());
                    }
                }
            }
            series.push(Series {
                kind: own,
                secondary: attr(node, CHART, "attached-axis")
                    .is_some_and(|axis| axis.starts_with("secondary")),
                values: attr(node, CHART, "values-cell-range-address").map(str::to_owned),
                label_address: attr(node, CHART, "label-cell-address").map(str::to_owned),
                label_string: attr(node, LOEXT, "label-string").map(str::to_owned),
                domains,
                style: style_of(node),
                points,
                trends,
            });
        } else if is(node, CHART, "wall") {
            wall = Some(style_of(node));
        }
    }
    if series.is_empty() {
        return None;
    }
    // One plot area holds one family: slices do not share it with bars, and
    // a scatter plot has no categories to share.
    let family = |kind: Kind| match kind {
        Kind::Pie | Kind::Ring => 0,
        Kind::Scatter => 1,
        Kind::Radar | Kind::FilledRadar => 2,
        Kind::Bar | Kind::Line | Kind::Area => 3,
    };
    if series.iter().any(|entry| family(entry.kind) != family(kind)) {
        return None;
    }
    let scatter = kind == Kind::Scatter;
    let (table, header_rows) = read_table(chart_node);
    let mut caches = caches(&series, &table, header_rows, scatter);
    // A table saved without values holds placeholders in their place: the
    // points counted 1, 2, 3 where the labels would be. Such a column is not
    // a cache of the cells the chart reads.
    let any_values = caches
        .iter()
        .any(|cache| cache.values.iter().any(Option::is_some));
    let bound = axes
        .iter()
        .find_map(|axis: &Axis| axis.categories.as_deref())
        .and_then(formula)
        .is_some();
    for cache in &mut caches {
        let counted = !cache.categories.is_empty()
            && cache
                .categories
                .iter()
                .enumerate()
                .all(|(index, cell)| cell.number == Some((index + 1) as f64));
        if !any_values || (bound && counted) {
            cache.categories.clear();
        }
        if !any_values {
            cache.domain.clear();
        }
    }
    let chart = Chart {
        kind,
        plot,
        axes,
        series,
        caches,
    };

    // ---- the plots, one per kind and pair of axes, in document order
    let mut groups: Vec<(Kind, bool, Vec<usize>)> = Vec::new();
    for (index, entry) in chart.series.iter().enumerate() {
        let secondary = entry.secondary && !kind.round();
        match groups
            .iter_mut()
            .find(|(group, axis, _)| *group == entry.kind && *axis == secondary)
        {
            Some((_, _, members)) => members.push(index),
            None => groups.push((entry.kind, secondary, vec![index])),
        }
    }
    let mut plots = String::new();
    for (group, secondary, members) in &groups {
        plots.push_str(&chart.plot_xml(*group, *secondary, members));
    }
    let mut axes_xml = String::new();
    if !kind.round() {
        let area = groups.iter().all(|(group, _, _)| *group == Kind::Area);
        axes_xml.push_str(&chart.axes_xml(false, scatter, kind.radar(), area));
        if groups.iter().any(|(_, secondary, _)| *secondary) {
            // Every plot needs the axes it names, the first pair included.
            if groups.iter().all(|(_, secondary, _)| *secondary) {
                return None;
            }
            axes_xml.push_str(&chart.axes_xml(true, scatter, kind.radar(), false));
        }
    }
    let plot_look = wall
        .as_ref()
        .map(|wall| area_properties(wall, true))
        .unwrap_or_default();

    let title = title_of(chart_node);
    let legend = child(chart_node, CHART, "legend").map(|legend| {
        let position = match attr(legend, CHART, "legend-position") {
            Some("start") => "l",
            Some("top") => "t",
            Some("bottom") => "b",
            Some("top-end") => "tr",
            _ => "r",
        };
        format!(
            r#"<c:legend><c:legendPos val="{position}"/><c:overlay val="0"/>{}</c:legend>"#,
            text_properties(&style_of(legend))
        )
    });
    let blanks = match chart.plot.text("treat-empty-cells") {
        Some("use-zero") => "zero",
        Some("ignore") => "span",
        _ => "gap",
    };
    let area_look = area_properties(&style_of(chart_node), true);
    Some(format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            "\n",
            r#"<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">"#,
            r#"<c:roundedCorners val="0"/><c:chart>{title}<c:autoTitleDeleted val="{deleted}"/>"#,
            r#"<c:plotArea><c:layout/>{plots}{axes}{plot_look}</c:plotArea>{legend}"#,
            r#"<c:plotVisOnly val="1"/><c:dispBlanksAs val="{blanks}"/></c:chart>{area_look}</c:chartSpace>"#,
        ),
        title = title.as_ref().map(title_xml).unwrap_or_default(),
        deleted = if title.is_some() { "0" } else { "1" },
        plots = plots,
        axes = axes_xml,
        plot_look = plot_look,
        legend = legend.unwrap_or_default(),
        blanks = blanks,
        area_look = area_look,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NAMESPACES: &str = concat!(
        r#"xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" "#,
        r#"xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" "#,
        r#"xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" "#,
        r#"xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" "#,
        r#"xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" "#,
        r#"xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" "#,
        r#"xmlns:xlink="http://www.w3.org/1999/xlink" "#,
        r#"xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" "#,
        r#"xmlns:chart="urn:oasis:names:tc:opendocument:xmlns:chart:1.0" "#,
        r#"xmlns:number="urn:oasis:names:tc:opendocument:xmlns:datastyle:1.0" "#,
        r#"xmlns:chartooo="http://openoffice.org/2010/chart" "#,
        r#"xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0""#,
    );

    fn document(styles: &str, class: &str, body: &str, table: &str) -> String {
        format!(
            r#"<office:document-content {NAMESPACES}><office:automatic-styles>{styles}</office:automatic-styles><office:body><office:chart><chart:chart chart:class="{class}" chart:style-name="area">{body}{table}</chart:chart></office:chart></office:body></office:document-content>"#
        )
    }

    fn table(header: &[&str], rows: &[(&str, &[&str])]) -> String {
        let mut out = String::from(
            r#"<table:table table:name="local-table"><table:table-header-rows><table:table-row><table:table-cell><text:p/></table:table-cell>"#,
        );
        for name in header {
            out.push_str(&format!(
                r#"<table:table-cell office:value-type="string"><text:p>{name}</text:p></table:table-cell>"#
            ));
        }
        out.push_str("</table:table-row></table:table-header-rows><table:table-rows>");
        for (label, values) in rows {
            out.push_str(&format!(
                r#"<table:table-row><table:table-cell office:value-type="string"><text:p>{label}</text:p></table:table-cell>"#
            ));
            for value in *values {
                if value.is_empty() {
                    out.push_str("<table:table-cell><text:p/></table:table-cell>");
                } else {
                    out.push_str(&format!(
                        r#"<table:table-cell office:value-type="float" office:value="{value}"><text:p>{value}</text:p></table:table-cell>"#
                    ));
                }
            }
            out.push_str("</table:table-row>");
        }
        out.push_str("</table:table-rows></table:table>");
        out
    }

    fn assert_in_order(xml: &str, parts: &[&str]) {
        let mut from = 0;
        for part in parts {
            match xml[from..].find(part) {
                Some(found) => from += found + part.len(),
                None => panic!("`{part}` is missing or out of order in {xml}"),
            }
        }
    }

    #[test]
    fn translates_chart_addresses() {
        assert_eq!(formula("Sales.B2:Sales.B7").as_deref(), Some("Sales!$B$2:$B$7"));
        assert_eq!(formula("$Sales.$B$2:.$B$7").as_deref(), Some("Sales!$B$2:$B$7"));
        assert_eq!(
            formula("'My Sheet'.A1:'My Sheet'.A1").as_deref(),
            Some("'My Sheet'!$A$1")
        );
        assert_eq!(formula("Sales.C1").as_deref(), Some("Sales!$C$1"));
        assert_eq!(
            formula("Sales.A2:Sales.A3 Sales.A7:Sales.A9").as_deref(),
            Some("(Sales!$A$2:$A$3,Sales!$A$7:$A$9)")
        );
        assert_eq!(formula("local-table.$B$2:.$B$7"), None);
        assert_eq!(formula(""), None);
        assert_eq!(local_range("local-table.$B$2:.$B$7"), Some((1, 1, 6, 1)));
        assert_eq!(local_range("local-table.$C$1"), Some((0, 2, 0, 2)));
        assert_eq!(local_range("Sales.B2:Sales.B7"), None);
        assert_eq!(label_string("\"a \"\"b\"\"\""), "a \"b\"");
    }

    #[test]
    fn writes_stacked_bars_with_ranges_caches_and_axes() {
        let styles = concat!(
            r##"<number:number-style style:name="N1"><number:number number:decimal-places="1" number:min-decimal-places="1" number:min-integer-digits="1"/></number:number-style>"##,
            r##"<style:style style:name="area" style:family="chart"><style:graphic-properties draw:stroke="solid" svg:stroke-color="#d9d9d9" draw:fill="solid" draw:fill-color="#ffffff"/></style:style>"##,
            r##"<style:style style:name="title" style:family="chart"><style:text-properties fo:color="#595959" fo:font-size="13pt"/></style:style>"##,
            r##"<style:style style:name="T1" style:family="text"><style:text-properties fo:font-size="14pt" fo:font-weight="bold"/></style:style>"##,
            r##"<style:style style:name="plot" style:family="chart"><style:chart-properties chart:vertical="true" chart:stacked="true" chart:treat-empty-cells="use-zero"/></style:style>"##,
            r##"<style:style style:name="x" style:family="chart"><style:chart-properties chart:reverse-direction="true"/><style:text-properties fo:font-size="10pt"/></style:style>"##,
            r##"<style:style style:name="y" style:family="chart" style:data-style-name="N1"><style:chart-properties chart:minimum="0" chart:maximum="120" chart:interval-major="20" chart:gap-width="80" chart:overlap="100" chart:axis-position="end" chart:link-data-style-to-source="false"/></style:style>"##,
            r##"<style:style style:name="s1" style:family="chart"><style:chart-properties chart:data-label-number="value" chart:link-data-style-to-source="true"/><style:graphic-properties draw:stroke="none" draw:fill="solid" draw:fill-color="#4472c4"/></style:style>"##,
            r##"<style:style style:name="s2" style:family="chart"><style:graphic-properties draw:stroke="none" draw:fill="solid" draw:fill-color="#ed7d31"/></style:style>"##,
            r##"<style:style style:name="p" style:family="chart"><style:graphic-properties draw:fill="solid" draw:fill-color="#ff0000"/></style:style>"##,
            r##"<style:style style:name="wall" style:family="chart"><style:graphic-properties draw:stroke="none" draw:fill="none"/></style:style>"##,
        );
        let body = concat!(
            r#"<chart:title chart:style-name="title"><text:p><text:span text:style-name="T1">분기 &amp; 합계</text:span></text:p></chart:title>"#,
            r#"<chart:legend chart:legend-position="bottom"/>"#,
            r#"<chart:plot-area chart:style-name="plot">"#,
            r#"<chart:axis chart:dimension="x" chart:name="primary-x" chart:style-name="x"><chart:title><text:p>항목</text:p></chart:title><chart:categories table:cell-range-address="'My Data'.A2:'My Data'.A4"/></chart:axis>"#,
            r#"<chart:axis chart:dimension="y" chart:name="primary-y" chart:style-name="y"><chart:grid chart:class="major"/></chart:axis>"#,
            r#"<chart:series chart:style-name="s1" chart:values-cell-range-address="'My Data'.B2:'My Data'.B4" chart:label-cell-address="'My Data'.B1:'My Data'.B1" chart:class="chart:bar"><chart:data-point/><chart:data-point chart:style-name="p"/><chart:data-point/></chart:series>"#,
            r#"<chart:series chart:style-name="s2" chart:values-cell-range-address="'My Data'.C2:'My Data'.C4" loext:label-string="&quot;west&quot;" chart:class="chart:bar"><chart:data-point chart:repeated="3"/></chart:series>"#,
            r#"<chart:wall chart:style-name="wall"/></chart:plot-area>"#,
        );
        let xml = chart_part(&document(
            styles,
            "chart:bar",
            body,
            &table(&["east", "west"], &[("a", &["1", "4.5"]), ("b", &["", "5"]), ("c", &["3", "6"])]),
        ))
        .unwrap();
        assert!(Document::parse(&xml).is_ok(), "{xml}");
        assert_in_order(
            &xml,
            &[
                "<c:chart><c:title><c:tx><c:rich>",
                r#"<a:defRPr sz="1400" b="1"><a:solidFill><a:srgbClr val="595959"/></a:solidFill></a:defRPr>"#,
                "<a:t>분기 &amp; 합계</a:t>",
                r#"<c:autoTitleDeleted val="0"/>"#,
                r#"<c:plotArea><c:layout/><c:barChart><c:barDir val="bar"/><c:grouping val="stacked"/><c:varyColors val="0"/>"#,
                r#"<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>'My Data'!$B$1</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>east</c:v></c:pt></c:strCache></c:strRef></c:tx>"#,
                r#"<c:spPr><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></c:spPr><c:invertIfNegative val="0"/>"#,
                r#"<c:dPt><c:idx val="1"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr></c:dPt>"#,
                r#"<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/>"#,
                r#"<c:cat><c:strRef><c:f>'My Data'!$A$2:$A$4</c:f><c:strCache><c:ptCount val="3"/><c:pt idx="0"><c:v>a</c:v></c:pt>"#,
                // The empty cell is a point the cache does not list.
                r#"<c:val><c:numRef><c:f>'My Data'!$B$2:$B$4</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="2"><c:v>3</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>"#,
                r#"<c:ser><c:idx val="1"/><c:order val="1"/><c:tx><c:v>west</c:v></c:tx>"#,
                r#"<c:pt idx="0"><c:v>4.5</c:v></c:pt>"#,
                r#"<c:gapWidth val="80"/><c:overlap val="100"/><c:axId val="111111111"/><c:axId val="222222222"/></c:barChart>"#,
                r#"<c:catAx><c:axId val="111111111"/><c:scaling><c:orientation val="maxMin"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:title>"#,
                r#"<c:numFmt formatCode="General" sourceLinked="1"/>"#,
                r#"<c:crossAx val="222222222"/>"#,
                // Reversed categories put the value axis on the far side;
                // pinning it to the end brings it back.
                r#"<c:valAx><c:axId val="222222222"/><c:scaling><c:orientation val="minMax"/><c:max val="120"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="0.0" sourceLinked="0"/>"#,
                r#"<c:crossAx val="111111111"/><c:crosses val="max"/><c:crossBetween val="between"/><c:majorUnit val="20"/></c:valAx>"#,
                r#"<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>"#,
                r#"<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="zero"/></c:chart>"#,
                r#"<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:chartSpace>"#,
            ],
        );
    }

    #[test]
    fn writes_a_line_over_bars_on_a_second_axis() {
        let styles = concat!(
            r##"<style:style style:name="l" style:family="chart"><style:chart-properties chart:symbol-type="automatic" chart:interpolation="cubic-spline"/><style:graphic-properties draw:stroke="solid" svg:stroke-width="0.079cm" svg:stroke-color="#ed7d31" draw:fill-color="#ed7d31"/></style:style>"##,
        );
        let body = concat!(
            r#"<chart:plot-area>"#,
            r#"<chart:axis chart:dimension="x" chart:name="primary-x"><chart:categories table:cell-range-address="Data.A2:Data.A3"/></chart:axis>"#,
            r#"<chart:axis chart:dimension="y" chart:name="primary-y"/>"#,
            r#"<chart:axis chart:dimension="y" chart:name="secondary-y"><chart:title><text:p>rate</text:p></chart:title></chart:axis>"#,
            r#"<chart:series chart:values-cell-range-address="Data.B2:Data.B3" chart:label-cell-address="Data.B1" chart:class="chart:bar"/>"#,
            r#"<chart:series chart:style-name="l" chart:values-cell-range-address="Data.C2:Data.C3" chart:label-cell-address="Data.C1" chart:class="chart:line" chart:attached-axis="secondary-y"/>"#,
            r#"</chart:plot-area>"#,
        );
        // No table: references only.
        let xml = chart_part(&document(styles, "chart:bar", body, "")).unwrap();
        assert!(Document::parse(&xml).is_ok(), "{xml}");
        assert_in_order(
            &xml,
            &[
                r#"<c:autoTitleDeleted val="1"/>"#,
                r#"<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/>"#,
                r#"<c:tx><c:strRef><c:f>Data!$B$1</c:f></c:strRef></c:tx><c:invertIfNegative val="0"/><c:cat><c:strRef><c:f>Data!$A$2:$A$3</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Data!$B$2:$B$3</c:f></c:numRef></c:val></c:ser>"#,
                r#"<c:gapWidth val="150"/><c:axId val="111111111"/><c:axId val="222222222"/></c:barChart>"#,
                r#"<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/><c:ser><c:idx val="1"/><c:order val="1"/>"#,
                r#"<c:spPr><a:solidFill><a:srgbClr val="ED7D31"/></a:solidFill><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="ED7D31"/></a:solidFill><a:round/></a:ln></c:spPr>"#,
                r#"<c:marker><c:symbol val="circle"/><c:size val="5"/>"#,
                r#"<c:smooth val="1"/></c:ser><c:marker val="1"/><c:axId val="333333333"/><c:axId val="444444444"/></c:lineChart>"#,
                r#"<c:catAx><c:axId val="111111111"/>"#,
                r#"<c:valAx><c:axId val="222222222"/>"#,
                r#"<c:axPos val="l"/>"#,
                r#"<c:catAx><c:axId val="333333333"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/>"#,
                r#"<c:valAx><c:axId val="444444444"/>"#,
                r#"<c:axPos val="r"/><c:title>"#,
                r#"<c:crossAx val="333333333"/><c:crosses val="max"/>"#,
            ],
        );
        assert!(!xml.contains("<c:legend>"));
    }

    #[test]
    fn writes_slices_scatter_points_and_a_chart_without_ranges() {
        // A ring: its series are circles, its slices coloured one by one.
        let styles = concat!(
            r##"<style:style style:name="p1" style:family="chart"><style:graphic-properties draw:fill="solid" draw:fill-color="#111111"/></style:style>"##,
            r##"<style:style style:name="p2" style:family="chart"><style:graphic-properties draw:fill="solid" draw:fill-color="#222222"/></style:style>"##,
            r##"<style:style style:name="s" style:family="chart"><style:chart-properties chart:data-label-number="percentage" chart:data-label-text="true"/><style:graphic-properties draw:fill-color="#999999"/></style:style>"##,
        );
        let body = concat!(
            r#"<chart:plot-area><chart:axis chart:dimension="x" chart:name="primary-x"><chart:categories table:cell-range-address="local-table.$A$2:.$A$3"/></chart:axis><chart:axis chart:dimension="y" chart:name="primary-y"/>"#,
            r#"<chart:series chart:style-name="s" chart:values-cell-range-address="local-table.$B$2:.$B$3" chart:label-cell-address="local-table.$B$1" chart:class="chart:circle"><chart:data-point chart:style-name="p1"/><chart:data-point chart:style-name="p2"/></chart:series>"#,
            r#"</chart:plot-area>"#,
        );
        let xml = chart_part(&document(
            styles,
            "chart:ring",
            body,
            &table(&["share"], &[("a", &["30"]), ("b", &["70"])]),
        ))
        .unwrap();
        assert!(Document::parse(&xml).is_ok(), "{xml}");
        assert_in_order(
            &xml,
            &[
                r#"<c:doughnutChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>share</c:v></c:tx>"#,
                r#"<c:dPt><c:idx val="0"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="111111"/></a:solidFill></c:spPr></c:dPt>"#,
                r#"<c:dPt><c:idx val="1"/>"#,
                r#"<c:showVal val="0"/><c:showCatName val="1"/><c:showSerName val="0"/><c:showPercent val="1"/>"#,
                r#"<c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>a</c:v></c:pt><c:pt idx="1"><c:v>b</c:v></c:pt></c:strLit></c:cat>"#,
                r#"<c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>30</c:v></c:pt><c:pt idx="1"><c:v>70</c:v></c:pt></c:numLit></c:val></c:ser>"#,
                r#"<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart></c:plotArea>"#,
            ],
        );
        assert!(!xml.contains("<c:catAx>") && !xml.contains("<c:valAx>"), "{xml}");

        // A scatter chart as another application writes it: the X column
        // sits in front of the Y column in the table.
        let body = concat!(
            r#"<chart:plot-area><chart:axis chart:dimension="x" chart:name="primary-x"/><chart:axis chart:dimension="y" chart:name="primary-y"><chart:grid chart:class="major"/></chart:axis>"#,
            r#"<chart:series chart:values-cell-range-address="Data.D2:Data.D3" loext:label-string="&quot;sq&quot;" chart:class="chart:scatter"><chart:domain table:cell-range-address="Data.B2:Data.B3"/><chart:data-point chart:repeated="2"/></chart:series>"#,
            r#"</chart:plot-area>"#,
        );
        let xml = chart_part(&document(
            "",
            "chart:scatter",
            body,
            &table(&["x", "sq"], &[("1", &["2", "4"]), ("2", &["3", "9"])]),
        ))
        .unwrap();
        assert!(Document::parse(&xml).is_ok(), "{xml}");
        assert_in_order(
            &xml,
            &[
                r#"<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>sq</c:v></c:tx>"#,
                r#"<c:xVal><c:numRef><c:f>Data!$B$2:$B$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>2</c:v></c:pt><c:pt idx="1"><c:v>3</c:v></c:pt></c:numCache></c:numRef></c:xVal>"#,
                r#"<c:yVal><c:numRef><c:f>Data!$D$2:$D$3</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>4</c:v></c:pt><c:pt idx="1"><c:v>9</c:v></c:pt></c:numCache></c:numRef></c:yVal><c:smooth val="0"/></c:ser>"#,
                r#"<c:valAx><c:axId val="111111111"/>"#,
                r#"<c:axPos val="b"/>"#,
                r#"<c:crossBetween val="midCat"/></c:valAx><c:valAx><c:axId val="222222222"/>"#,
                r#"<c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>"#,
            ],
        );
    }

    #[test]
    fn leaves_out_a_chart_it_cannot_draw() {
        let body = r#"<chart:plot-area><chart:series chart:values-cell-range-address="Data.B2:Data.B3"/></chart:plot-area>"#;
        assert!(chart_part(&document("", "chart:stock", body, "")).is_none());
        assert!(chart_part(&document("", "chart:bar", "<chart:plot-area/>", "")).is_none());
        // Slices and bars do not share a plot area.
        let mixed = r#"<chart:plot-area><chart:series chart:values-cell-range-address="Data.B2:Data.B3" chart:class="chart:circle"/></chart:plot-area>"#;
        assert!(chart_part(&document("", "chart:bar", mixed, "")).is_none());
        assert!(chart_part("<not-a-chart/>").is_none());
        assert!(chart_part("not xml").is_none());
    }

    #[test]
    fn a_trend_line_keeps_its_kind_and_its_order_or_period() {
        let style = |pairs: &[(&str, &str)]| Style {
            chart: pairs
                .iter()
                .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
                .collect(),
            stroke_color: Some("4472C4".into()),
            stroke_width: Some(1.0),
            ..Style::default()
        };
        assert_eq!(
            trendline_xml(&style(&[("regression-type", "linear")])),
            r#"<c:trendline><c:spPr><a:ln w="12700"><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></a:ln></c:spPr><c:trendlineType val="linear"/><c:dispRSqr val="0"/><c:dispEq val="0"/></c:trendline>"#
        );
        assert!(
            trendline_xml(&style(&[("regression-type", "polynomial"), ("regression-max-degree", "9")]))
                .contains(r#"<c:trendlineType val="poly"/><c:order val="6"/>"#)
        );
        assert!(
            trendline_xml(&style(&[("regression-type", "moving-average"), ("regression-period", "3")]))
                .contains(r#"<c:trendlineType val="movingAvg"/><c:period val="3"/>"#)
        );
        assert!(trendline_xml(&style(&[("regression-type", "logarithmic")])).contains(r#"val="log""#));
        // No kind, or one a chart part has no word for: no trend line.
        assert_eq!(trendline_xml(&style(&[("regression-type", "none")])), "");
        assert_eq!(trendline_xml(&style(&[])), "");
    }
}
