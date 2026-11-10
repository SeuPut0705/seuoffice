//! Charts for the `.ods` export.
//!
//! An ODF chart is a small document of its own inside the package (`Object
//! 1/content.xml`): a plot area with axes and series that point at cell
//! ranges of the spreadsheet, plus a table holding the values as they were
//! when the file was written. The frame that shows it sits in a cell like any
//! other drawing.
//!
//! The session model already describes a chart the way the editor draws it —
//! plot kinds, series with their ranges and cached values, axes, legend,
//! labels — so this is a translation of that description, not of the chart
//! part. What the model does not keep (3-D depth, trend lines, error bars,
//! manual layout) does not travel.

use crate::odf_formula;
use crate::ods_styles::StyleRegistry;
use crate::visuals::{AxisInfo, ChartMetadata, ChartSeries};
use crate::CellStyle;
use crate::xlsx_package::escape_xml;

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
    // Two things a chart needs have no attribute in the standard: saying that
    // an axis holds text rather than dates, and that a line's points sit
    // between the ticks. These are the extension namespaces readers share.
    r#"xmlns:chartooo="http://openoffice.org/2010/chart" "#,
    r#"xmlns:loext="urn:org:documentfoundation:names:experimental:office:xmlns:loext:1.0" "#,
);

/// The colours Excel gives points that name none when the workbook has no
/// theme to take them from.
const PALETTE: [&str; 6] = [
    "#4472c4", "#ed7d31", "#a5a5a5", "#ffc000", "#5b9bd5", "#70ad47",
];

/// The six accent colours of the workbook's theme, which is where Excel
/// takes the colours of slices and unnamed series from. The theme lists them
/// after its two light and two dark colours.
pub(crate) fn accent_palette(theme_colors: Option<&[String]>) -> Vec<String> {
    let accents: Vec<String> = theme_colors
        .map(|colors| colors.iter().skip(4).take(6).map(|color| hex_color(color)).collect())
        .unwrap_or_default();
    if accents.len() == 6 {
        accents
    } else {
        PALETTE.iter().map(|color| (*color).to_owned()).collect()
    }
}

/// A chart ready for the package.
pub(crate) struct ChartDocument {
    /// The `content.xml` of the embedded chart document.
    pub(crate) content: String,
    /// The spreadsheet ranges the chart reads, space separated.
    pub(crate) ranges: String,
}

/// The ODF class of a plot kind, or `None` for one this writer does not draw.
fn class_of(plot: &str) -> Option<&'static str> {
    Some(match plot {
        "barChart" => "chart:bar",
        "lineChart" => "chart:line",
        "areaChart" => "chart:area",
        "pieChart" => "chart:circle",
        "doughnutChart" => "chart:ring",
        "scatterChart" => "chart:scatter",
        "radarChart" => "chart:radar",
        _ => return None,
    })
}

/// `Sheet1!$B$2:$B$7` as `Sheet1.B2:Sheet1.B7`, the form a chart names a
/// range in. `None` for anything but one cell or one rectangle on one sheet.
pub(crate) fn chart_range(reference: &str) -> Option<String> {
    let translated = odf_formula::odf_range_address(reference.trim())?;
    // `$Sheet.$B$2:.$B$7` → sheet and the two cells.
    let (sheet, cells) = split_sheet(&translated)?;
    let sheet = sheet.strip_prefix('$').unwrap_or(sheet);
    let mut ends = cells.split(":.");
    let first = ends.next()?.replace('$', "");
    let last = ends.next().map(|last| last.replace('$', ""));
    if ends.next().is_some() || first.is_empty() {
        return None;
    }
    Some(match last {
        Some(last) => format!("{sheet}.{first}:{sheet}.{last}"),
        None => format!("{sheet}.{first}:{sheet}.{first}"),
    })
}

/// The number of cells a chart range covers (`Sheet1.B2:Sheet1.B7` → 6).
fn range_size(range: &str) -> Option<usize> {
    let (first, last) = range.split_once(':')?;
    let cell = |end: &str| -> Option<(usize, usize)> {
        let (_, cell) = split_sheet(end)?;
        let letters = cell.chars().take_while(char::is_ascii_alphabetic).count();
        let column = cell[..letters]
            .bytes()
            .fold(0usize, |total, byte| total * 26 + usize::from(byte.to_ascii_uppercase() - b'A') + 1);
        let row: usize = cell[letters..].parse().ok()?;
        (column > 0 && row > 0).then_some((column, row))
    };
    let (first, last) = (cell(first)?, cell(last)?);
    Some((first.0.abs_diff(last.0) + 1) * (first.1.abs_diff(last.1) + 1))
}

/// How many points a series has: its cached values, or — for a chart saved
/// without a cache — the size of the range it reads.
fn point_count(series: &ChartSeries) -> usize {
    let cached = series.values.len().max(series.categories.len());
    if cached > 0 {
        return cached;
    }
    series
        .values_ref
        .as_deref()
        .and_then(chart_range)
        .and_then(|range| range_size(&range))
        .unwrap_or(0)
}

/// Splits `'My Sheet'.$A$1:.$B$2` at the dot that ends the sheet name.
fn split_sheet(address: &str) -> Option<(&str, &str)> {
    let bytes = address.as_bytes();
    let mut index = 0;
    let mut quoted = false;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' => quoted = !quoted,
            b'.' if !quoted => return Some((&address[..index], &address[index + 1..])),
            _ => {}
        }
        index += 1;
    }
    None
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

fn hex_color(value: &str) -> String {
    let value = value.trim();
    let hex = value.strip_prefix('#').unwrap_or(value);
    let hex = if hex.len() == 8 { &hex[2..] } else { hex };
    format!("#{}", hex.to_ascii_lowercase())
}

fn number(value: f64) -> String {
    if value.is_finite() {
        format!("{value}")
    } else {
        "0".to_owned()
    }
}

/// XML cannot carry control characters.
fn printable(text: &str) -> String {
    text.chars()
        .map(|character| if character == '\n' || character == '\r' { ' ' } else { character })
        .filter(|character| *character == '\t' || (*character as u32) >= 0x20)
        .collect()
}

/// Chart styles collected while the document is written.
struct Styles {
    bodies: Vec<String>,
    /// Number formats of the axes and labels, as data styles.
    formats: StyleRegistry,
    /// The colour of text that names none: dark on a light chart, light on a
    /// dark one. A reader's own default is black, which a dark chart hides.
    ink: &'static str,
}

impl Styles {
    fn new(chart: &ChartMetadata) -> Self {
        let dark = chart
            .chart_area_fill
            .as_deref()
            .and_then(luminance)
            .is_some_and(|luminance| luminance < 0.4);
        Self {
            bodies: Vec::new(),
            formats: StyleRegistry::new(CellStyle::default()),
            ink: if dark { "#d9d9d9" } else { "#595959" },
        }
    }

    fn add(&mut self, chart: &str, graphic: &str, text: &str) -> String {
        self.push(chart, graphic, text, "")
    }

    /// A style whose numbers follow `format` instead of the cells they come
    /// from.
    fn add_formatted(
        &mut self,
        chart: &str,
        graphic: &str,
        text: &str,
        format: Option<&str>,
    ) -> String {
        let data = format
            .filter(|format| !format.eq_ignore_ascii_case("general"))
            .and_then(|format| self.formats.number_format_style(format));
        let linked = if data.is_some() { "false" } else { "true" };
        let chart = format!(r#"{chart} chart:link-data-style-to-source="{linked}""#);
        let data = data
            .map(|name| format!(r#" style:data-style-name="{name}""#))
            .unwrap_or_default();
        self.push(&chart, graphic, text, &data)
    }

    fn text(&self, size: Option<f64>, bold: bool, color: Option<&str>) -> String {
        text_properties(size, bold, Some(color.unwrap_or(self.ink)))
    }

    fn push(&mut self, chart: &str, graphic: &str, text: &str, data: &str) -> String {
        let name = format!("ch{}", self.bodies.len() + 1);
        let mut body = String::new();
        if !chart.is_empty() {
            body.push_str(&format!("<style:chart-properties{chart}/>"));
        }
        if !graphic.is_empty() {
            body.push_str(&format!("<style:graphic-properties{graphic}/>"));
        }
        if !text.is_empty() {
            body.push_str(&format!("<style:text-properties{text}/>"));
        }
        self.bodies.push(format!(
            r#"<style:style style:name="{name}" style:family="chart"{data}>{body}</style:style>"#
        ));
        name
    }
}

/// The ODF name of a DrawingML trend line kind.
fn regression_type(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "linear" => "linear",
        "exp" => "exponential",
        "log" => "logarithmic",
        "power" => "power",
        "poly" => "polynomial",
        "movingAvg" => "moving-average",
        _ => return None,
    })
}

/// The relative luminance of `#RRGGBB`, 0 for black and 1 for white.
fn luminance(color: &str) -> Option<f64> {
    let hex = hex_color(color);
    let hex = hex.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let channel =
        |index: usize| u8::from_str_radix(&hex[index..index + 2], 16).ok().map(f64::from);
    Some((0.2126 * channel(0)? + 0.7152 * channel(2)? + 0.0722 * channel(4)?) / 255.0)
}

fn text_properties(size: Option<f64>, bold: bool, color: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(color) = color {
        out.push_str(&format!(r#" fo:color="{}""#, escape_xml(&hex_color(color))));
    }
    if let Some(size) = size.filter(|size| *size > 0.0) {
        out.push_str(&format!(
            r#" fo:font-size="{size}pt" style:font-size-asian="{size}pt" style:font-size-complex="{size}pt""#
        ));
    }
    if bold {
        out.push_str(
            r#" fo:font-weight="bold" style:font-weight-asian="bold" style:font-weight-complex="bold""#,
        );
    }
    out
}

fn title_xml(element: &str, text: &str, style: &str) -> String {
    format!(
        r#"<{element} chart:style-name="{style}"><text:p>{}</text:p></{element}>"#,
        escape_xml(&printable(text))
    )
}

/// One axis element: its style, title, categories and grid.
#[allow(clippy::too_many_arguments)]
fn axis_xml(
    styles: &mut Styles,
    dimension: &str,
    name: &str,
    info: Option<&AxisInfo>,
    title: Option<&str>,
    extra: &str,
    element: &str,
    categories: Option<&str>,
    grid: bool,
    title_rotation: u32,
    format: Option<&str>,
) -> String {
    let mut chart = String::from(r#" chart:display-label="true" chart:logarithmic="false""#);
    if let Some(info) = info {
        if let Some(minimum) = info.min {
            chart.push_str(&format!(r#" chart:minimum="{}""#, number(minimum)));
        }
        if let Some(maximum) = info.max {
            chart.push_str(&format!(r#" chart:maximum="{}""#, number(maximum)));
        }
        if let Some(unit) = info.major_unit.filter(|unit| *unit > 0.0) {
            chart.push_str(&format!(r#" chart:interval-major="{}""#, number(unit)));
        }
        if info.reversed {
            chart.push_str(r#" chart:reverse-direction="true""#);
        }
        if info.hidden {
            chart.push_str(r#" chart:visible="false""#);
        }
    }
    chart.push_str(extra);
    let label_text = styles.text(
        info.and_then(|info| info.label_size).or(Some(10.0)),
        false,
        info.and_then(|info| info.label_color.as_deref()),
    );
    let style = styles.add_formatted(
        &chart,
        r##" draw:stroke="solid" svg:stroke-color="#878787""##,
        &label_text,
        format.or(info.and_then(|info| info.num_fmt.as_deref())),
    );
    let mut body = String::new();
    if let Some(title) = title.filter(|title| !title.is_empty()) {
        let title_text = styles.text(
            info.and_then(|info| info.title_size).or(Some(10.0)),
            false,
            info.and_then(|info| info.title_color.as_deref()),
        );
        let title_style = styles.add(
            &format!(r#" chart:auto-position="true" style:rotation-angle="{title_rotation}""#),
            "",
            &title_text,
        );
        body.push_str(&title_xml("chart:title", title, &title_style));
    }
    if let Some(categories) = categories {
        body.push_str(&format!(
            r#"<chart:categories table:cell-range-address="{}"/>"#,
            escape_xml(categories)
        ));
    }
    if grid {
        let grid_style = styles.add("", r##" draw:stroke="solid" svg:stroke-color="#d9d9d9""##, "");
        body.push_str(&format!(
            r#"<chart:grid chart:style-name="{grid_style}" chart:class="major"/>"#
        ));
    }
    format!(
        r#"<chart:axis chart:dimension="{dimension}" chart:name="{name}" chart:style-name="{style}"{element}>{body}</chart:axis>"#
    )
}

fn label_properties(mode: Option<&str>) -> &'static str {
    match mode {
        Some("value") => r#" chart:data-label-number="value""#,
        Some("percent") => r#" chart:data-label-number="percentage""#,
        Some("category-percent") => {
            r#" chart:data-label-number="percentage" chart:data-label-text="true""#
        }
        Some("category-value-percent") => {
            r#" chart:data-label-number="value-and-percentage" chart:data-label-text="true""#
        }
        _ => "",
    }
}

/// Builds the chart document. `sheet` is the sheet the chart sits on; the
/// size is the frame's, in centimetres.
pub(crate) fn chart_document(
    chart: &ChartMetadata,
    palette: &[String],
    width: f64,
    height: f64,
) -> Option<ChartDocument> {
    let primary = chart.chart_types.first()?.as_str();
    let class = class_of(primary)?;
    if chart.series.is_empty() {
        return None;
    }
    let series_class = |series: &ChartSeries| {
        series
            .plot
            .as_deref()
            .and_then(class_of)
            .unwrap_or(class)
    };
    // One plot area holds one family of plots: a ring or a pie cannot share
    // it with bars.
    let round = matches!(class, "chart:circle" | "chart:ring");
    if chart.series.iter().any(|series| {
        let other = series_class(series);
        other != class && (round || matches!(other, "chart:circle" | "chart:ring" | "chart:scatter" | "chart:radar"))
    }) {
        return None;
    }
    let scatter = class == "chart:scatter";
    let horizontal = class == "chart:bar" && chart.bar_direction.as_deref() == Some("bar");
    let points = chart.series.iter().map(point_count).max().unwrap_or(0);
    // A chart reads either the sheet or its own table, never both: a reader
    // that finds one address in the local table takes the whole chart from
    // there. So the sheet is used only when every series names a range.
    let bound = chart
        .series
        .iter()
        .all(|series| series.values_ref.as_deref().and_then(chart_range).is_some());
    let sheet_range = |reference: Option<&str>| -> Option<String> {
        reference.filter(|_| bound).and_then(chart_range)
    };

    let mut styles = Styles::new(chart);
    let mut ranges: Vec<String> = Vec::new();
    let mut note = |range: &Option<String>| {
        if let Some(range) = range {
            if !ranges.contains(range) {
                ranges.push(range.clone());
            }
        }
    };

    // ---- the chart itself, its title and legend
    // Excel frames a chart with a thin grey line unless told otherwise.
    let area_style = styles.add(
        "",
        &format!(
            r##" draw:stroke="solid" svg:stroke-width="0.026cm" svg:stroke-color="#d9d9d9" draw:fill="solid" draw:fill-color="{}""##,
            escape_xml(&hex_color(chart.chart_area_fill.as_deref().unwrap_or("#ffffff")))
        ),
        "",
    );
    let mut body = String::new();
    if !chart.title.is_empty() {
        let title_text = styles.text(
            chart
                .title_style
                .as_ref()
                .and_then(|style| style.size)
                .or(Some(14.0)),
            chart
                .title_style
                .as_ref()
                .and_then(|style| style.bold)
                .unwrap_or(false),
            chart.title_style.as_ref().and_then(|style| style.color.as_deref()),
        );
        let title_style = styles.add(r#" chart:auto-position="true""#, "", &title_text);
        body.push_str(&title_xml("chart:title", &chart.title, &title_style));
    }
    let legend = match chart.legend.as_str() {
        "none" => None,
        "left" => Some("start"),
        "top" => Some("top"),
        "bottom" => Some("bottom"),
        _ => Some("end"),
    };
    if let Some(position) = legend {
        let legend_text = styles.text(Some(10.0), false, None);
        let legend_style = styles.add(
            r#" chart:auto-position="true""#,
            r#" draw:stroke="none" draw:fill="none""#,
            &legend_text,
        );
        body.push_str(&format!(
            r#"<chart:legend chart:legend-position="{position}" style:legend-expansion="high" chart:style-name="{legend_style}"/>"#
        ));
    }

    // ---- the plot area
    let mut plot = String::new();
    if horizontal {
        plot.push_str(r#" chart:vertical="true""#);
    }
    match chart.grouping.as_deref() {
        Some("stacked") => plot.push_str(r#" chart:stacked="true""#),
        Some("percentStacked") => plot.push_str(r#" chart:percentage="true""#),
        _ => {}
    }
    plot.push_str(match chart.disp_blanks_as.as_deref() {
        Some("gap") => r#" chart:treat-empty-cells="leave-gap""#,
        Some("span") => r#" chart:treat-empty-cells="ignore""#,
        _ => r#" chart:treat-empty-cells="use-zero""#,
    });
    plot.push_str(r#" chart:include-hidden-cells="false" chart:auto-position="true" chart:auto-size="true""#);
    let plot_style = styles.add(&plot, "", "");

    // The model names the axes by the side they sit on. Horizontal bars put
    // the categories on the left and the values at the bottom.
    let (category_axis, value_axis) = if horizontal {
        (chart.y_axis.as_ref(), chart.x_axis.as_ref())
    } else {
        (chart.x_axis.as_ref(), chart.y_axis.as_ref())
    };
    // The side an axis sits on tells a scatter chart's two value axes apart.
    // Elsewhere the titles and the value axis are known by kind, which holds
    // even for a writer that puts both axes on the same side.
    let titles = chart.axis_titles.as_ref();
    let by_kind = |kind: Option<&str>, side: Option<&AxisInfo>| -> Option<String> {
        let side = side.and_then(|axis| axis.title.clone());
        if scatter {
            side.or_else(|| kind.map(str::to_owned))
        } else {
            kind.map(str::to_owned).or(side)
        }
    };
    let category_title = by_kind(
        titles.and_then(|titles| titles.category.as_deref()),
        category_axis,
    );
    let value_title = by_kind(titles.and_then(|titles| titles.value.as_deref()), value_axis);
    let categories_range = sheet_range(
        chart
            .series
            .iter()
            .find_map(|series| series.categories_ref.as_deref()),
    );
    let categories_address = if scatter {
        None
    } else if bound {
        categories_range.clone()
    } else {
        Some(format!("local-table.$A$2:.$A${}", points + 1))
    };
    if !scatter {
        note(&categories_range);
    }
    let stacked = matches!(chart.grouping.as_deref(), Some("stacked") | Some("percentStacked"));
    let mut value_extra = String::new();
    if class == "chart:bar" {
        if let Some(gap) = chart.gap_width_pct {
            value_extra.push_str(&format!(r#" chart:gap-width="{gap}""#));
        }
        if stacked {
            value_extra.push_str(r#" chart:overlap="100""#);
        }
    }
    if round {
        // Excel draws the slices clockwise from the top.
        value_extra.push_str(r#" chart:reverse-direction="true""#);
    }
    // An axis sits where the other one starts. Reversing the categories
    // moves that start to the far side, and Excel files often pin the value
    // axis back where it was; the side the model recorded says which.
    if !round && !scatter {
        let reversed = category_axis.is_some_and(|axis| axis.reversed);
        let near = if horizontal { "b" } else { "l" };
        let far = if horizontal { "t" } else { "r" };
        let natural = if reversed { far } else { near };
        let wanted = value_axis.and_then(|axis| axis.position.as_deref());
        if wanted.is_some_and(|side| (side == near || side == far) && side != natural) {
            value_extra.push_str(r#" chart:axis-position="end""#);
        }
    }
    let value_grid = !round
        && if scatter {
            value_axis.is_some_and(|axis| axis.major_gridlines)
        } else {
            chart
                .gridlines
                .or(value_axis.map(|axis| axis.major_gridlines))
                .unwrap_or(false)
        };
    if !scatter {
        // The bounds the model keeps for the value axis by kind.
        if let Some(bounds) = &chart.value_axis {
            if let Some(minimum) = bounds.min {
                if value_axis.is_none_or(|axis| axis.min.is_none()) {
                    value_extra.push_str(&format!(r#" chart:minimum="{}""#, number(minimum)));
                }
            }
            if let Some(maximum) = bounds.max {
                if value_axis.is_none_or(|axis| axis.max.is_none()) {
                    value_extra.push_str(&format!(r#" chart:maximum="{}""#, number(maximum)));
                }
            }
        }
    }
    // A category axis holds text; said outright, a reader does not guess
    // dates from the labels. A line chart's points sit between the ticks, as
    // Excel draws them unless told otherwise.
    let category_element = if scatter { "" } else { r#" chartooo:axis-type="text""# };
    let category_extra = match class {
        "chart:line" => r#" loext:major-origin="0.5""#,
        // Excel walks a radar's categories clockwise.
        "chart:radar" if !category_axis.is_some_and(|axis| axis.reversed) => {
            r#" chart:reverse-direction="true""#
        }
        _ => "",
    };
    let mut axes = String::new();
    axes.push_str(&axis_xml(
        &mut styles,
        "x",
        "primary-x",
        category_axis,
        category_title.as_deref(),
        category_extra,
        category_element,
        categories_address.as_deref(),
        !round && scatter && category_axis.is_some_and(|axis| axis.major_gridlines),
        0,
        chart.category_axis_format.as_deref().filter(|_| !scatter),
    ));
    axes.push_str(&axis_xml(
        &mut styles,
        "y",
        "primary-y",
        value_axis,
        value_title.as_deref(),
        &value_extra,
        "",
        None,
        value_grid,
        90,
        None,
    ));
    // A combination chart may scale its second plot on its own axis.
    let secondary = chart.secondary_y_axis.as_ref().filter(|_| !round);
    if let Some(axis) = secondary {
        axes.push_str(&axis_xml(
            &mut styles,
            "y",
            "secondary-y",
            Some(axis),
            axis.title.as_deref(),
            "",
            "",
            None,
            false,
            90,
            None,
        ));
    }

    // ---- the series
    let line_markers = chart.line_markers.unwrap_or(true);
    let mut series_xml = String::new();
    for (index, series) in chart.series.iter().enumerate() {
        let kind = series_class(series);
        let color = series
            .color
            .as_deref()
            .map(hex_color)
            .unwrap_or_else(|| palette[index % palette.len()].clone());
        let stroked = matches!(kind, "chart:line" | "chart:scatter" | "chart:radar");
        let mut properties = String::new();
        if stroked {
            // A scatter series shows its markers unless it turns them off;
            // a line chart also has a switch for the whole plot.
            let hidden = series.marker.as_deref() == Some("none");
            let markers = kind == "chart:scatter" || line_markers;
            properties.push_str(if markers && !hidden {
                r#" chart:symbol-type="automatic""#
            } else {
                r#" chart:symbol-type="none""#
            });
            if series.smooth == Some(true) {
                properties.push_str(r#" chart:interpolation="cubic-spline""#);
            }
        }
        properties.push_str(label_properties(
            series.data_labels.as_deref().or(chart.data_labels.as_deref()),
        ));
        let graphic = if stroked {
            let line = series
                .line_color
                .as_deref()
                .filter(|line| *line != "none")
                .map(hex_color)
                .unwrap_or_else(|| color.clone());
            // Excel draws the line unless the series says it has none; the
            // chart-wide scatter style does not decide it.
            let drawn = series.line_color.as_deref() != Some("none");
            // The model keeps the width in pixels; Excel's own default line
            // is 2.25 pt.
            let width = series
                .line_width
                .filter(|width| *width > 0.0)
                .map_or(2.25, |pixels| pixels * 0.75)
                / 72.0
                * 2.54;
            format!(
                r#" draw:stroke="{}" svg:stroke-width="{width:.3}cm" svg:stroke-color="{}" draw:fill-color="{}""#,
                if drawn { "solid" } else { "none" },
                escape_xml(&line),
                escape_xml(&color)
            )
        } else {
            format!(
                r#" draw:stroke="none" draw:fill="solid" draw:fill-color="{}""#,
                escape_xml(&color)
            )
        };
        let label_text = styles.text(
            chart
                .data_label_style
                .as_ref()
                .and_then(|style| style.size)
                .or(Some(10.0)),
            false,
            chart
                .data_label_style
                .as_ref()
                .and_then(|style| style.color.as_deref()),
        );
        let style = styles.add_formatted(
            &properties,
            &graphic,
            &label_text,
            chart
                .data_label_format
                .as_deref()
                .or(series.number_format.as_deref()),
        );

        let column = column_name(index + 1);
        let values_range = sheet_range(series.values_ref.as_deref());
        let label_range = sheet_range(series.name_ref.as_deref());
        note(&values_range);
        note(&label_range);
        let mut attributes = format!(
            r#" chart:style-name="{style}" chart:values-cell-range-address="{}""#,
            escape_xml(&values_range.unwrap_or_else(|| {
                format!("local-table.${column}$2:.${column}${}", points + 1)
            }))
        );
        match label_range {
            Some(range) => attributes.push_str(&format!(
                r#" chart:label-cell-address="{}""#,
                escape_xml(&range)
            )),
            // A series nobody named gets the name a reader makes up for it.
            None if bound && series.name.is_empty() => {}
            // A name typed into the chart rather than read from a cell.
            None if bound => attributes.push_str(&format!(
                r#" loext:label-string="{}""#,
                escape_xml(&format!("\"{}\"", printable(&series.name).replace('"', "\"\"")))
            )),
            None => attributes.push_str(&format!(
                r#" chart:label-cell-address="local-table.${column}$1""#
            )),
        }
        // The series of a ring are circles; the ring is the chart's class.
        attributes.push_str(&format!(
            r#" chart:class="{}""#,
            if kind == "chart:ring" { "chart:circle" } else { kind }
        ));
        if secondary.is_some() && kind != class {
            attributes.push_str(r#" chart:attached-axis="secondary-y""#);
        }
        let mut inner = String::new();
        if scatter {
            // A scatter series reads its X values from a domain.
            let domain = sheet_range(series.categories_ref.as_deref());
            note(&domain);
            let domain = match domain {
                Some(domain) => Some(domain),
                None if bound => None,
                None => Some(format!("local-table.$A$2:.$A${}", points + 1)),
            };
            if let Some(domain) = domain {
                inner.push_str(&format!(
                    r#"<chart:domain table:cell-range-address="{}"/>"#,
                    escape_xml(&domain)
                ));
            }
        }
        // A trend line follows the domain. The model knows its kind; the
        // order of a polynomial and the period of a moving average are the
        // ones a new trend line gets.
        if let Some(kind) = series.trendline.as_deref().and_then(regression_type) {
            let extra = match kind {
                "polynomial" => r#" chart:regression-max-degree="2""#,
                "moving-average" => r#" chart:regression-period="2""#,
                _ => "",
            };
            let trend = styles.add(
                &format!(r#" chart:regression-type="{kind}"{extra}"#),
                &format!(
                    r#" draw:stroke="solid" svg:stroke-width="0.035cm" svg:stroke-color="{}""#,
                    escape_xml(&color)
                ),
                "",
            );
            inner.push_str(&format!(
                r#"<chart:regression-curve chart:style-name="{trend}"/>"#
            ));
        }
        let count = point_count(series).max(1);
        if round || series.point_colors.is_some() {
            // Slices, and points that override their series, are coloured
            // one by one.
            for point in 0..count {
                let own = series.point_colors.as_ref().and_then(|colors| {
                    colors
                        .iter()
                        .find(|entry| entry.index as usize == point)
                        .map(|entry| hex_color(&entry.color))
                });
                let fill = match (own, round) {
                    (Some(own), _) => own,
                    (None, true) => palette[point % palette.len()].clone(),
                    (None, false) => color.clone(),
                };
                let point_style = styles.add(
                    "",
                    &format!(r#" draw:fill="solid" draw:fill-color="{}""#, escape_xml(&fill)),
                    "",
                );
                inner.push_str(&format!(r#"<chart:data-point chart:style-name="{point_style}"/>"#));
            }
        } else {
            inner.push_str(&format!(r#"<chart:data-point chart:repeated="{count}"/>"#));
        }
        series_xml.push_str(&format!("<chart:series{attributes}>{inner}</chart:series>"));
    }

    let wall_style = styles.add(
        "",
        &match chart.plot_area_fill.as_deref() {
            Some(fill) => format!(
                r#" draw:stroke="none" draw:fill="solid" draw:fill-color="{}""#,
                escape_xml(&hex_color(fill))
            ),
            None => r#" draw:stroke="none" draw:fill="none""#.to_owned(),
        },
        "",
    );
    body.push_str(&format!(
        r#"<chart:plot-area chart:style-name="{plot_style}" chart:data-source-has-labels="both">{axes}{series_xml}<chart:wall chart:style-name="{wall_style}"/></chart:plot-area>"#
    ));
    body.push_str(&local_table(chart, points, scatter));

    let content = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><office:document-content {NAMESPACES}office:version="1.3"><office:automatic-styles>{}{}</office:automatic-styles><office:body><office:chart><chart:chart svg:width="{width:.3}cm" svg:height="{height:.3}cm" xlink:href=".." xlink:type="simple" chart:class="{class}" chart:style-name="{area_style}">{body}</chart:chart></office:chart></office:body></office:document-content>"#,
        styles.formats.data_styles(),
        styles.bodies.concat(),
    );
    Some(ChartDocument {
        content,
        ranges: ranges.join(" "),
    })
}

/// The values as they were when the workbook was saved: a reader that cannot
/// reach the cells still has a chart to draw, and a series without a range
/// reads this table.
fn local_table(chart: &ChartMetadata, points: usize, scatter: bool) -> String {
    let mut out = format!(
        r#"<table:table table:name="local-table"><table:table-header-columns><table:table-column/></table:table-header-columns><table:table-columns><table:table-column table:number-columns-repeated="{}"/></table:table-columns><table:table-header-rows><table:table-row><table:table-cell><text:p/></table:table-cell>"#,
        chart.series.len().max(1)
    );
    for series in &chart.series {
        out.push_str(&format!(
            r#"<table:table-cell office:value-type="string"><text:p>{}</text:p></table:table-cell>"#,
            escape_xml(&printable(&series.name))
        ));
    }
    out.push_str("</table:table-row></table:table-header-rows><table:table-rows>");
    let labels = chart
        .series
        .iter()
        .map(|series| &series.categories)
        .find(|categories| !categories.is_empty());
    for point in 0..points.max(1) {
        out.push_str("<table:table-row>");
        let label = labels.and_then(|labels| labels.get(point));
        match label {
            // A scatter chart's first column is the X values, as numbers.
            Some(label) if scatter && label.trim().parse::<f64>().is_ok() => out.push_str(&format!(
                r#"<table:table-cell office:value-type="float" office:value="{}"><text:p>{}</text:p></table:table-cell>"#,
                escape_xml(label.trim()),
                escape_xml(label.trim())
            )),
            Some(label) => out.push_str(&format!(
                r#"<table:table-cell office:value-type="string"><text:p>{}</text:p></table:table-cell>"#,
                escape_xml(&printable(label))
            )),
            None => out.push_str(&format!(
                r#"<table:table-cell office:value-type="float" office:value="{0}"><text:p>{0}</text:p></table:table-cell>"#,
                point + 1
            )),
        }
        for series in &chart.series {
            let blank = series
                .blanks
                .as_ref()
                .is_some_and(|blanks| blanks.contains(&point));
            match series.values.get(point).filter(|_| !blank) {
                Some(value) => out.push_str(&format!(
                    r#"<table:table-cell office:value-type="float" office:value="{0}"><text:p>{0}</text:p></table:table-cell>"#,
                    number(*value)
                )),
                // No cached value: an empty cell, which a reader that goes
                // to the sheet for the values never looks at.
                None => out.push_str("<table:table-cell><text:p/></table:table-cell>"),
            }
        }
        out.push_str("</table:table-row>");
    }
    out.push_str("</table:table-rows></table:table>");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_ranges_the_way_a_chart_does() {
        assert_eq!(
            chart_range("Sales!$B$2:$B$7").as_deref(),
            Some("Sales.B2:Sales.B7")
        );
        assert_eq!(
            chart_range("'My Sheet'!$A$1").as_deref(),
            Some("'My Sheet'.A1:'My Sheet'.A1")
        );
        assert_eq!(chart_range("(Sales!$A$1,Sales!$C$1)"), None);
        assert_eq!(chart_range("Table1[col]"), None);
        assert_eq!(class_of("barChart"), Some("chart:bar"));
        assert_eq!(class_of("stockChart"), None);
        assert_eq!(
            split_sheet("'a.b'.$A$1:.$B$2"),
            Some(("'a.b'", "$A$1:.$B$2"))
        );
    }

    #[test]
    fn counts_the_points_of_a_series_saved_without_a_cache() {
        assert_eq!(range_size("Sales.B2:Sales.B7"), Some(6));
        assert_eq!(range_size("'My Sheet'.A1:'My Sheet'.C1"), Some(3));
        assert_eq!(range_size("Sales.B2:Sales.C3"), Some(4));
        assert_eq!(range_size("Sales.B2"), None);
    }
}
