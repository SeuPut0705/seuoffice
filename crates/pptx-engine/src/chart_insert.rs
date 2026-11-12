//! Chart insertion (packages/pptx-engine/src/chart-insert.ts): writes the chart part
//! (ppt/charts/chartN.xml) + Content_Types Override + slide rels + graphicFrame fragment,
//! going through `append_raw_elements` to reuse the existing chart parsing/rendering.
//!
//! The chartSpace template mirrors docx-engine's buildChartPartXml: the data goes through
//! strCache/numCache caches, and the embedded workbook (chart_workbook.rs) holds the same
//! data for PowerPoint's "Edit Data".
//!
//! `uuid` of `add_chart` is what `crypto.randomUUID()` gives `creationIdXml`.

use jscompat::{
    JsNum, js_regex, math_max, math_min, math_round, number_to_string, slice_utf16, to_number, trim,
};
use serde::Deserialize;

use crate::chart_workbook::{
    CHART_WORKBOOK_REL_TYPE, ChartWorkbookData, ChartWorkbookSeries, XLSX_CONTENT_TYPE,
    chart_workbook_xlsx, col_letter,
};
use crate::deck::{OpenedPptx, append_raw_elements};
use crate::insert::next_c_nv_pr_id;
use crate::media_insert::ensure_default_content_type;
use crate::notes::append_relationship;
use crate::resource_cleanup::remove_relationship_and_collect_owned_target;
use crate::types::EmuRect;
use crate::xml_utils::{
    creation_id_xml, escape_xml_attr, escape_xml_text, has_content_type_override,
    max_relationship_id_number,
};
use crate::zip::{rels_path_for, resolve_target};

/// `NewChartKind`
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NewChartKind {
    #[default]
    Bar,
    BarStacked,
    /// Percent-stacked column (no insert entry point; used to preserve the type subdivision when rebuilding an externally created chart during edits)
    BarPercentStacked,
    Line,
    Area,
    Pie,
    Doughnut,
    Scatter,
    Radar,
    /// Combo chart: first N-1 series as clustered columns, last series as a line (on the right secondary value axis)
    ComboBarLine,
    /// 3-D pie (c:pie3DChart + c:view3D; this app renders the pseudo-3D projection, PowerPoint renders true 3-D)
    #[serde(rename = "pie3D")]
    Pie3D,
    /// 3-D clustered column (c:bar3DChart + c:view3D)
    #[serde(rename = "bar3D")]
    Bar3D,
}

/// One of `series` of `NewChartOptions`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct NewChartSeries {
    pub name: String,
    /// A JSON null is a number that is not finite (NaN), which the caches leave out.
    #[serde(deserialize_with = "values_or_nan")]
    pub values: Vec<f64>,
}

fn values_or_nan<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<f64>, D::Error> {
    let values = Vec::<Option<f64>>::deserialize(d)?;
    Ok(values.into_iter().map(|v| v.unwrap_or(f64::NAN)).collect())
}

/// `NewChartOptions` with the fields of `ChartStyleOptions`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewChartOptions {
    pub kind: NewChartKind,
    #[serde(default)]
    pub title: Option<String>,
    pub categories: Vec<String>,
    pub series: Vec<NewChartSeries>,
    pub offset: EmuRect,
    /// Legend position: b, t, r, l; 'none' = do not write c:legend
    #[serde(default)]
    pub legend_pos: Option<String>,
    /// Data labels (plot-level c:dLbls showVal)
    #[serde(default)]
    pub data_labels: Option<bool>,
    /// Major gridlines on the value axis
    #[serde(default)]
    pub gridlines: Option<bool>,
    #[serde(default)]
    pub cat_axis_title: Option<String>,
    #[serde(default)]
    pub val_axis_title: Option<String>,
    /// Gap between bars (% of bar width, c:gapWidth, PowerPoint default 150)
    #[serde(default)]
    pub gap_width_pct: Option<f64>,
    /// Bar direction: 'col' or 'bar' (horizontal)
    #[serde(default)]
    pub bar_dir: Option<String>,
    /// Per-point fills, [seriesIdx][pointIdx] (sparse; written as c:dPt, wins over the series color)
    #[serde(default)]
    pub point_colors: Option<Vec<Option<Vec<Option<String>>>>>,
    /// Per-series solid colors (#RRGGBB, cycled); line-like series color the stroke, others the fill
    #[serde(default)]
    pub color_scheme: Option<Vec<String>>,
    /// Doughnut hole size (percent, c:holeSize, default 50)
    #[serde(default)]
    pub hole_size_pct: Option<f64>,
}

impl Default for NewChartOptions {
    fn default() -> Self {
        Self {
            kind: NewChartKind::default(),
            title: None,
            categories: Vec::new(),
            series: Vec::new(),
            offset: EmuRect {
                x: JsNum(0.0),
                y: JsNum(0.0),
                cx: JsNum(0.0),
                cy: JsNum(0.0),
            },
            legend_pos: None,
            data_labels: None,
            gridlines: None,
            cat_axis_title: None,
            val_axis_title: None,
            gap_width_pct: None,
            bar_dir: None,
            point_colors: None,
            color_scheme: None,
            hole_size_pct: None,
        }
    }
}

const CHART_CONTENT_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
const CHART_REL_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart";
const C_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const A_NS: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

fn str_cache_xml(values: &[&str], f: &str) -> String {
    let mut out = format!(
        "<c:strRef><c:f>{}</c:f><c:strCache><c:ptCount val=\"{}\"/>",
        escape_xml_text(f),
        values.len()
    );
    for (i, v) in values.iter().enumerate() {
        if !v.is_empty() {
            out.push_str(&format!(
                "<c:pt idx=\"{i}\"><c:v>{}</c:v></c:pt>",
                escape_xml_text(v)
            ));
        }
    }
    out.push_str("</c:strCache></c:strRef>");
    out
}

fn num_cache_xml(values: &[f64], f: &str) -> String {
    let mut out = format!(
        "<c:numRef><c:f>{}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val=\"{}\"/>",
        escape_xml_text(f),
        values.len()
    );
    for (i, v) in values.iter().enumerate() {
        if v.is_finite() {
            out.push_str(&format!(
                "<c:pt idx=\"{i}\"><c:v>{}</c:v></c:pt>",
                number_to_string(*v)
            ));
        }
    }
    out.push_str("</c:numCache></c:numRef>");
    out
}

/// Data label fragment (dLbls follows ser in the schema; shared by all chart types).
const DLBLS_XML: &str = "<c:dLbls><c:showLegendKey val=\"0\"/><c:showVal val=\"1\"/><c:showCatName val=\"0\"/>\
<c:showSerName val=\"0\"/><c:showPercent val=\"0\"/><c:showBubbleSize val=\"0\"/></c:dLbls>";

/// Axis title fragment (value axis vertical, rot=-5400000).
fn ax_title_xml(text: &str, vertical: bool) -> String {
    format!(
        "<c:title><c:tx><c:rich><a:bodyPr{}/><a:lstStyle/>\
<a:p><a:r><a:t>{}</a:t></a:r></a:p>\
</c:rich></c:tx><c:overlay val=\"0\"/></c:title>",
        if vertical {
            " rot=\"-5400000\" vert=\"horz\""
        } else {
            ""
        },
        escape_xml_text(text)
    )
}

fn scatter_x_values(categories: &[String]) -> Vec<f64> {
    categories
        .iter()
        .enumerate()
        .map(|(i, c)| {
            let v = to_number(c);
            if !trim(c).is_empty() && v.is_finite() {
                v
            } else {
                i as f64 + 1.0
            }
        })
        .collect()
}

/// A truthy string option (`opts.x ? ... : ...`).
fn truthy(text: &Option<String>) -> Option<&str> {
    text.as_deref().filter(|t| !t.is_empty())
}

/// Full c:chartSpace part XML. `external_data_r_id` names the chart's relationship to its
/// embedded workbook, which PowerPoint opens for "Edit Data".
pub fn build_chart_space_xml(opts: &NewChartOptions, external_data_r_id: Option<&str>) -> String {
    let rows = opts.categories.len();
    let d_lbls = if opts.data_labels == Some(true) {
        DLBLS_XML
    } else {
        ""
    };
    let grid = if opts.gridlines == Some(true) {
        "<c:majorGridlines/>"
    } else {
        ""
    };
    let cat_title = truthy(&opts.cat_axis_title)
        .map(|t| ax_title_xml(t, false))
        .unwrap_or_default();
    let val_title = truthy(&opts.val_axis_title)
        .map(|t| ax_title_xml(t, true))
        .unwrap_or_default();
    let gap_width = match opts.gap_width_pct {
        Some(g) => format!("<c:gapWidth val=\"{}\"/>", number_to_string(math_round(g))),
        None => String::new(),
    };
    // Empty names stay empty: no <c:tx> for an unnamed series, no <c:cat> when every category name is empty
    let tx_xml = |name: &str, i: usize| -> String {
        if name.is_empty() {
            String::new()
        } else {
            format!(
                "<c:tx>{}</c:tx>",
                str_cache_xml(&[name], &format!("Sheet1!${}$1", col_letter(i as f64)))
            )
        }
    };
    let cat_refs: Vec<&str> = opts.categories.iter().map(String::as_str).collect();
    let cat_xml = if opts.categories.iter().any(|c| !c.is_empty()) {
        format!(
            "<c:cat>{}</c:cat>",
            str_cache_xml(&cat_refs, &format!("Sheet1!$A$2:$A${}", rows + 1))
        )
    } else {
        String::new()
    };
    // Per-point <c:dPt> fills (schema position: after tx/spPr, before dLbls/cat/val)
    let d_pt_xml = |i: usize| -> String {
        let Some(colors) = opts
            .point_colors
            .as_ref()
            .and_then(|p| p.get(i))
            .and_then(|c| c.as_ref())
        else {
            return String::new();
        };
        let mut out = String::new();
        for (pi, c) in colors.iter().enumerate() {
            let Some(c) = c.as_deref().filter(|c| !c.is_empty()) else {
                continue;
            };
            let hex = jscompat::replace_first_string(c, "#", "").to_uppercase();
            out.push_str(&format!(
                "<c:dPt><c:idx val=\"{pi}\"/><c:bubble3D val=\"0\"/>\
<c:spPr><a:solidFill><a:srgbClr val=\"{hex}\"/></a:solidFill></c:spPr></c:dPt>"
            ));
        }
        out
    };
    // Single-series fragment (idx/order use global ordinals so colors stay in order when a combo chart splits into two plots)
    let ser_xml = |ser: &NewChartSeries, i: usize| -> String {
        let col = col_letter(i as f64);
        let sliced = ser.values.get(..rows).unwrap_or(&ser.values);
        format!(
            "<c:ser><c:idx val=\"{i}\"/><c:order val=\"{i}\"/>{}{}{cat_xml}<c:val>{}</c:val></c:ser>",
            tx_xml(&ser.name, i),
            d_pt_xml(i),
            num_cache_xml(sliced, &format!("Sheet1!${col}$2:${col}${}", rows + 1)),
        )
    };
    let sers: String = opts
        .series
        .iter()
        .enumerate()
        .map(|(i, s)| ser_xml(s, i))
        .collect();

    let plot: String = if opts.kind == NewChartKind::ComboBarLine {
        // Combo chart (columns + line): with ≥2 series the last is a line, the rest are
        // clustered columns; a single series degrades to plain columns.
        // Columns use the primary axes (category axis 1111… + left value axis 2222…), the line
        // uses the secondary axes (hidden category axis 3333… + right secondary value axis 4444…),
        // matching how PowerPoint writes "combo chart + secondary axis".
        let line_count = if opts.series.len() >= 2 { 1 } else { 0 };
        let bar_end = opts.series.len() - line_count;
        let bar_sers: String = opts
            .series
            .get(..bar_end)
            .unwrap_or_default()
            .iter()
            .enumerate()
            .map(|(i, s)| ser_xml(s, i))
            .collect();
        let line_sers: String = opts
            .series
            .get(bar_end..)
            .unwrap_or_default()
            .iter()
            .enumerate()
            .map(|(k, s)| ser_xml(s, bar_end + k))
            .collect();
        let mut p = format!(
            "<c:barChart><c:barDir val=\"col\"/><c:grouping val=\"clustered\"/><c:varyColors val=\"0\"/>\
{bar_sers}{d_lbls}{gap_width}<c:axId val=\"111111111\"/><c:axId val=\"222222222\"/></c:barChart>"
        );
        if !line_sers.is_empty() {
            p.push_str(&format!(
                "<c:lineChart><c:grouping val=\"standard\"/><c:varyColors val=\"0\"/>\
{line_sers}{d_lbls}<c:marker val=\"1\"/><c:axId val=\"333333333\"/><c:axId val=\"444444444\"/></c:lineChart>"
            ));
        }
        p.push_str(&format!(
            "<c:catAx><c:axId val=\"111111111\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling>\
<c:delete val=\"0\"/><c:axPos val=\"b\"/>{cat_title}<c:crossAx val=\"222222222\"/></c:catAx>\
<c:valAx><c:axId val=\"222222222\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling>\
<c:delete val=\"0\"/><c:axPos val=\"l\"/>{grid}{val_title}<c:crossAx val=\"111111111\"/></c:valAx>"
        ));
        if !line_sers.is_empty() {
            p.push_str(
                "<c:valAx><c:axId val=\"444444444\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling>\
<c:delete val=\"0\"/><c:axPos val=\"r\"/><c:crossAx val=\"333333333\"/><c:crosses val=\"max\"/></c:valAx>\
<c:catAx><c:axId val=\"333333333\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling>\
<c:delete val=\"1\"/><c:axPos val=\"b\"/><c:crossAx val=\"444444444\"/></c:catAx>",
            );
        }
        p
    } else if opts.kind == NewChartKind::Pie {
        format!(
            "<c:pieChart><c:varyColors val=\"1\"/>{sers}{d_lbls}<c:firstSliceAng val=\"0\"/></c:pieChart>"
        )
    } else if opts.kind == NewChartKind::Pie3D {
        format!("<c:pie3DChart><c:varyColors val=\"1\"/>{sers}{d_lbls}</c:pie3DChart>")
    } else if opts.kind == NewChartKind::Bar3D {
        // bar3D takes three axes (category / value / series); the series axis is required by the schema
        let horizontal = opts.bar_dir.as_deref() == Some("bar");
        format!(
            "<c:bar3DChart><c:barDir val=\"{}\"/><c:grouping val=\"clustered\"/><c:varyColors val=\"0\"/>\
{sers}{d_lbls}{gap_width}<c:shape val=\"box\"/>\
<c:axId val=\"111111111\"/><c:axId val=\"222222222\"/><c:axId val=\"333333333\"/></c:bar3DChart>\
<c:catAx><c:axId val=\"111111111\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling>\
<c:delete val=\"0\"/><c:axPos val=\"{}\"/>{cat_title}<c:crossAx val=\"222222222\"/></c:catAx>\
<c:valAx><c:axId val=\"222222222\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling>\
<c:delete val=\"0\"/><c:axPos val=\"{}\"/>{grid}{val_title}<c:crossAx val=\"111111111\"/></c:valAx>\
<c:serAx><c:axId val=\"333333333\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling>\
<c:delete val=\"0\"/><c:axPos val=\"b\"/><c:crossAx val=\"222222222\"/></c:serAx>",
            if horizontal { "bar" } else { "col" },
            if horizontal { "l" } else { "b" },
            if horizontal { "b" } else { "l" },
        )
    } else if opts.kind == NewChartKind::Doughnut {
        let hole = math_min(
            90.0,
            math_max(1.0, math_round(opts.hole_size_pct.unwrap_or(50.0))),
        );
        format!(
            "<c:doughnutChart><c:varyColors val=\"1\"/>{sers}{d_lbls}\
<c:firstSliceAng val=\"0\"/><c:holeSize val=\"{}\"/></c:doughnutChart>",
            number_to_string(hole)
        )
    } else if opts.kind == NewChartKind::Scatter {
        // Scatter (XY): x values come from categories (numeric strings use their value,
        // otherwise ordinals 1..n), y values from the series values;
        // series data uses c:xVal/c:yVal, with dual value axes (x axis axPos=b, y axis axPos=l)
        let xs = scatter_x_values(&opts.categories);
        let scatter_sers: String = opts
            .series
            .iter()
            .enumerate()
            .map(|(i, ser)| {
                let col = col_letter(i as f64);
                let sliced = ser.values.get(..rows).unwrap_or(&ser.values);
                format!(
                    "<c:ser><c:idx val=\"{i}\"/><c:order val=\"{i}\"/>{}\
<c:xVal>{}</c:xVal><c:yVal>{}</c:yVal><c:smooth val=\"0\"/></c:ser>",
                    tx_xml(&ser.name, i),
                    num_cache_xml(&xs, &format!("Sheet1!$A$2:$A${}", rows + 1)),
                    num_cache_xml(sliced, &format!("Sheet1!${col}$2:${col}${}", rows + 1)),
                )
            })
            .collect();
        format!(
            "<c:scatterChart><c:scatterStyle val=\"lineMarker\"/><c:varyColors val=\"0\"/>\
{scatter_sers}{d_lbls}<c:axId val=\"111111111\"/><c:axId val=\"222222222\"/></c:scatterChart>\
<c:valAx><c:axId val=\"111111111\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling>\
<c:delete val=\"0\"/><c:axPos val=\"b\"/>{cat_title}<c:crossAx val=\"222222222\"/></c:valAx>\
<c:valAx><c:axId val=\"222222222\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling>\
<c:delete val=\"0\"/><c:axPos val=\"l\"/>{grid}{val_title}<c:crossAx val=\"111111111\"/></c:valAx>"
        )
    } else {
        // Horizontal bar chart (barDir=bar): category axis on the left, value axis at the bottom (matches how PowerPoint writes it)
        let is_bar_kind = matches!(
            opts.kind,
            NewChartKind::Bar | NewChartKind::BarStacked | NewChartKind::BarPercentStacked
        );
        let horizontal = is_bar_kind && opts.bar_dir.as_deref() == Some("bar");
        let axes = format!(
            "<c:catAx><c:axId val=\"111111111\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling>\
<c:delete val=\"0\"/><c:axPos val=\"{}\"/>{cat_title}<c:crossAx val=\"222222222\"/></c:catAx>\
<c:valAx><c:axId val=\"222222222\"/><c:scaling><c:orientation val=\"minMax\"/></c:scaling>\
<c:delete val=\"0\"/><c:axPos val=\"{}\"/>{grid}{val_title}<c:crossAx val=\"111111111\"/></c:valAx>",
            if horizontal { "l" } else { "b" },
            if horizontal { "b" } else { "l" },
        );
        let ax_ids = "<c:axId val=\"111111111\"/><c:axId val=\"222222222\"/>";
        let inner = match opts.kind {
            // Radar: categories are vertices (clockwise from 12 o'clock), standard style (unfilled lines)
            NewChartKind::Radar => format!(
                "<c:radarChart><c:radarStyle val=\"standard\"/><c:varyColors val=\"0\"/>{sers}{d_lbls}{ax_ids}</c:radarChart>"
            ),
            NewChartKind::Line => format!(
                "<c:lineChart><c:grouping val=\"standard\"/><c:varyColors val=\"0\"/>{sers}{d_lbls}<c:marker val=\"1\"/>{ax_ids}</c:lineChart>"
            ),
            NewChartKind::Area => format!(
                "<c:areaChart><c:grouping val=\"standard\"/><c:varyColors val=\"0\"/>{sers}{d_lbls}{ax_ids}</c:areaChart>"
            ),
            _ => {
                let grouping = match opts.kind {
                    NewChartKind::BarPercentStacked => "percentStacked",
                    NewChartKind::BarStacked => "stacked",
                    _ => "clustered",
                };
                let overlap = if grouping == "clustered" {
                    ""
                } else {
                    "<c:overlap val=\"100\"/>"
                };
                format!(
                    "<c:barChart><c:barDir val=\"{}\"/><c:grouping val=\"{grouping}\"/><c:varyColors val=\"0\"/>\
{sers}{d_lbls}{gap_width}{overlap}{ax_ids}</c:barChart>",
                    if horizontal { "bar" } else { "col" }
                )
            }
        };
        inner + &axes
    };

    let title = match truthy(&opts.title) {
        Some(t) => format!(
            "<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r>\
<a:t>{}</a:t></a:r></a:p></c:rich></c:tx>\
<c:overlay val=\"0\"/></c:title><c:autoTitleDeleted val=\"0\"/>",
            escape_xml_text(t)
        ),
        None => "<c:autoTitleDeleted val=\"1\"/>".to_owned(),
    };

    // 3-D view settings (schema position: after the title block, before plotArea);
    // rotX/rotY follow PowerPoint's defaults for each type
    let view3d = match opts.kind {
        NewChartKind::Pie3D => {
            "<c:view3D><c:rotX val=\"30\"/><c:rotY val=\"0\"/><c:rAngAx val=\"0\"/><c:perspective val=\"30\"/></c:view3D>"
        }
        NewChartKind::Bar3D => {
            "<c:view3D><c:rotX val=\"15\"/><c:rotY val=\"20\"/><c:rAngAx val=\"1\"/><c:perspective val=\"30\"/></c:view3D>"
        }
        _ => "",
    };

    let legend_pos = opts.legend_pos.as_deref().unwrap_or("b");
    let legend = if legend_pos == "none" {
        String::new()
    } else {
        format!("<c:legend><c:legendPos val=\"{legend_pos}\"/><c:overlay val=\"0\"/></c:legend>")
    };
    let external = match external_data_r_id.filter(|r| !r.is_empty()) {
        Some(r) => {
            format!("<c:externalData r:id=\"{r}\"><c:autoUpdate val=\"0\"/></c:externalData>")
        }
        None => String::new(),
    };
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<c:chartSpace xmlns:c=\"{C_NS}\" xmlns:a=\"{A_NS}\" xmlns:r=\"{R_NS}\">\
<c:chart>{title}{view3d}<c:plotArea><c:layout/>{plot}</c:plotArea>\
{legend}<c:plotVisOnly val=\"1\"/><c:dispBlanksAs val=\"gap\"/></c:chart>{external}</c:chartSpace>"
    );
    inject_series_colors(&xml, opts)
}

/// Per-series `<c:spPr>` solid colors, inserted at the CT_*Ser schema position
/// (after c:tx, before c:dPt/c:cat). The last series of a combo chart is the
/// line: its color goes on an `<a:ln>` stroke (lines use stroke, bars/pies fill).
fn inject_series_colors(xml: &str, opts: &NewChartOptions) -> String {
    let scheme = match &opts.color_scheme {
        Some(s) if !s.is_empty() => s,
        _ => return xml.to_owned(),
    };
    let line_family = matches!(
        opts.kind,
        NewChartKind::Line | NewChartKind::Scatter | NewChartKind::Radar
    );
    let combo_line_idx = if opts.kind == NewChartKind::ComboBarLine && opts.series.len() >= 2 {
        (opts.series.len() - 1) as f64
    } else {
        -1.0
    };
    let mut out = String::with_capacity(xml.len());
    let mut last = 0;
    for head in js_regex!(
        r#"<c:ser><c:idx val="(\d+)"\/><c:order val="\d+"\/>(?:<c:tx>.*?<\/c:tx>)?"#,
        "s"
    )
    .find_iter(xml)
    {
        out.push_str(xml.get(last..head.start()).unwrap_or_default());
        last = head.end();
        let i = to_number(head.get(1).unwrap_or_default());
        let at = (i % scheme.len() as f64) as usize;
        let color = scheme
            .get(at)
            .map(|c| slice_utf16(&jscompat::replace_first_string(c, "#", ""), 0.0, Some(6.0)))
            .unwrap_or_default()
            .to_uppercase();
        let fill = format!("<a:solidFill><a:srgbClr val=\"{color}\"/></a:solidFill>");
        let sp_pr = if line_family || i == combo_line_idx {
            format!("<c:spPr><a:ln w=\"28575\">{fill}</a:ln></c:spPr>")
        } else {
            format!("<c:spPr>{fill}</c:spPr>")
        };
        out.push_str(head.as_str());
        out.push_str(&sp_pr);
    }
    out.push_str(xml.get(last..).unwrap_or_default());
    out
}

/// Writes the chart's embedded workbook from the data in `opts` and returns the relationship
/// id c:externalData names. The workbook the chart part already points at is overwritten in
/// place; another data source (a linked file, an OLE object) is dropped, since the chart is
/// rebuilt from this data.
pub fn write_chart_workbook(
    opened: &mut OpenedPptx,
    chart_path: &str,
    opts: &NewChartOptions,
) -> Result<String, String> {
    let data = ChartWorkbookData {
        categories: opts.categories.clone(),
        series: opts
            .series
            .iter()
            .map(|s| ChartWorkbookSeries {
                name: s.name.clone(),
                values: s.values.iter().map(|v| Some(JsNum(*v))).collect(),
            })
            .collect(),
        x_values: (opts.kind == NewChartKind::Scatter).then(|| {
            scatter_x_values(&opts.categories)
                .into_iter()
                .map(JsNum)
                .collect()
        }),
    };
    let bytes = chart_workbook_xlsx(&data)?;
    let current = opened
        .archive
        .read_text(chart_path)
        .map(|c| c.into_owned())
        .unwrap_or_default();
    let linked_id = js_regex!(r#"<c:externalData\b[^>]*\br:id="([^"]+)""#)
        .exec(&current)
        .and_then(|m| m.get(1).map(str::to_owned));
    let archive = &mut opened.archive;
    let linked = match &linked_id {
        Some(id) => archive.read_rels(chart_path)?.get(id).cloned(),
        None => None,
    };
    if let Some(linked) = linked
        && linked.r#type == CHART_WORKBOOK_REL_TYPE
        && linked.target_mode.as_deref() != Some("External")
    {
        archive
            .entries_mut()
            .set(resolve_target(chart_path, &linked.target), bytes);
        return Ok(linked.id);
    }
    if let Some(id) = &linked_id {
        remove_relationship_and_collect_owned_target(archive, chart_path, id)?;
    }

    let mut n = 1.0_f64;
    while archive.has(&format!(
        "ppt/embeddings/Microsoft_Excel_Worksheet{}.xlsx",
        number_to_string(n)
    )) {
        n += 1.0;
    }
    let n_text = number_to_string(n);
    archive.entries_mut().set(
        format!("ppt/embeddings/Microsoft_Excel_Worksheet{n_text}.xlsx"),
        bytes,
    );
    ensure_default_content_type(opened, "xlsx", XLSX_CONTENT_TYPE)?;
    Ok(append_relationship(
        &mut opened.archive,
        chart_path,
        CHART_WORKBOOK_REL_TYPE,
        &format!("../embeddings/Microsoft_Excel_Worksheet{n_text}.xlsx"),
    ))
}

/// `text.replace(needle, () => replacement)`: the first occurrence, written as given.
fn replace_first_literal(text: &str, needle: &str, replacement: &str) -> String {
    match text.find(needle) {
        Some(at) => format!("{}{replacement}{}", &text[..at], &text[at + needle.len()..]),
        None => text.to_owned(),
    }
}

/// Insert a chart: part surgery + graphicFrame fragment append + reparse.
/// The new element's id (all ids on the slide refreshed; the slide is
/// `opened.deck.slides[slide_index]`); `None` is TS null.
pub fn add_chart(
    opened: &mut OpenedPptx,
    slide_index: usize,
    opts: &NewChartOptions,
    uuid: &str,
) -> Result<Option<String>, String> {
    let Some(slide_path) = opened
        .deck
        .slides
        .get(slide_index)
        .map(|s| (*s.path).clone().unwrap_or_default())
    else {
        return Ok(None);
    };
    if opts.categories.is_empty() || opts.series.is_empty() {
        return Ok(None);
    }

    // 1) chart part: number = current max + 1
    let mut max_num = 0.0_f64;
    for path in opened.archive.entries().keys() {
        if let Some(m) = js_regex!(r"^ppt\/charts\/chart(\d+)\.xml$").exec(path) {
            max_num = math_max(max_num, to_number(m.get(1).unwrap_or_default()));
        }
    }
    let num_text = number_to_string(max_num + 1.0);
    let chart_path = format!("ppt/charts/chart{num_text}.xml");
    let workbook_r_id = write_chart_workbook(opened, &chart_path, opts)?;
    opened.archive.entries_mut().set(
        chart_path.clone(),
        build_chart_space_xml(opts, Some(&workbook_r_id)).into_bytes(),
    );

    // 2) [Content_Types].xml Override
    let ct_path = "[Content_Types].xml";
    let ct = opened
        .archive
        .read_text(ct_path)
        .filter(|c| !c.is_empty())
        .map(|c| c.into_owned());
    if let Some(ct) = ct
        && !has_content_type_override(&ct, &chart_path)
    {
        let over =
            format!("<Override PartName=\"/{chart_path}\" ContentType=\"{CHART_CONTENT_TYPE}\"/>");
        let next = replace_first_literal(&ct, "</Types>", &format!("{over}</Types>"));
        opened.archive.entries_mut().set(ct_path, next.into_bytes());
    }

    // 3) slide rels
    let rels_path = rels_path_for(&slide_path);
    let rels = opened
        .archive
        .read_text(&rels_path)
        .map(|r| r.into_owned())
        .unwrap_or_else(|| {
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"></Relationships>".to_owned()
        });
    let max_rid = max_relationship_id_number(&rels);
    let rid = format!("rId{}", number_to_string(max_rid + 1.0));
    let rel_xml = format!(
        "<Relationship Id=\"{rid}\" Type=\"{CHART_REL_TYPE}\" Target=\"../charts/chart{num_text}.xml\"/>"
    );
    let next = replace_first_literal(
        &rels,
        "</Relationships>",
        &format!("{rel_xml}</Relationships>"),
    );
    opened
        .archive
        .entries_mut()
        .set(rels_path, next.into_bytes());

    // 4) graphicFrame fragment + append reparse
    let id = {
        let Some(slide) = opened.deck.slides.get(slide_index) else {
            return Ok(None);
        };
        next_c_nv_pr_id(slide)
    };
    let id_text = number_to_string(id);
    let o = opts.offset;
    let name = match truthy(&opts.title) {
        Some(t) => format!("Chart {id_text} - {t}"),
        None => format!("Chart {id_text}"),
    };
    // descr="aislides-chart" marks charts created by this app (like the ink marker); recognized as editable charts on reopen
    let frame_xml = format!(
        "<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id=\"{id_text}\" name=\"{}\" descr=\"aislides-chart\">{}</p:cNvPr>\
<p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>\
<p:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></p:xfrm>\
<a:graphic><a:graphicData uri=\"{C_NS}\">\
<c:chart xmlns:c=\"{C_NS}\" xmlns:r=\"{R_NS}\" r:id=\"{rid}\"/>\
</a:graphicData></a:graphic></p:graphicFrame>",
        escape_xml_attr(&name),
        creation_id_xml(uuid),
        number_to_string(o.x.0),
        number_to_string(o.y.0),
        number_to_string(o.cx.0),
        number_to_string(o.cy.0),
    );

    let ids = append_raw_elements(opened, slide_index, &[frame_xml])?;
    Ok(ids.map(|ids| ids.last().cloned().unwrap_or_default()))
}
